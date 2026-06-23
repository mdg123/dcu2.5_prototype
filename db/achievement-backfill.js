// db/achievement-backfill.js
// ─────────────────────────────────────────────────────────────────────────────
// 성취기준(achievement_code) 매핑 커버리지 백필 — 멱등·부팅 자동 적용.
//
//   배경(PM 감사):
//     · contents 10,101개 중 achievement_code 없음 3,940개(39%).
//       그중 3,690개(94%)는 node_contents(content_id↔node_id) 매핑이 있어
//       learning_map_nodes.achievement_code(괄호형 [4수01-05]) 로 backfill 가능.
//     · 나머지 ~250개는 단원 연결 자체 없음(일반 video/image/link/quiz) → null 유지(억지 생성 금지).
//
//   왜 contents.achievement_code 를 채우는가:
//     routes/content.js 의 content_view 로깅이 contents.achievement_code 를 읽어
//     learning_logs 에 싣는다. 미충진이면 학생이 콘텐츠를 학습해도 성취 히트맵에 반영 안 됨.
//
//   설계 원칙:
//     · 표준체계 일관 — self-learn-extended.resolveAchievementForAttempt 의 해석 규칙을 재사용.
//       (node → learning_map_nodes.achievement_code → node_contents 경유)
//     · 멱등 — achievement_code IS NULL/'' 인 행만 채운다. 이미 채워진 건 건드리지 않음(WHERE 절).
//       재실행 비용 0에 가깝게(채울 행 없으면 0건 UPDATE).
//     · 억지 생성 금지 — 매핑 없으면 그대로 NULL.
//     · 무손상 — achievement_code/subject 채움만. 어떤 raw 데이터도 파괴/덮어쓰기 없음.
//
//   대표 노드 선택 규칙(콘텐츠가 여러 코드 노드에 매핑된 경우, 결정론적 1개):
//     1) node_contents.content_role = 'lecture' 우선(강의=주 교수 노드) > 'practice'
//     2) 같은 role 내 node_contents.sort_order 오름차순(가장 앞 차시)
//     3) node_contents.id 오름차순(안정 tie-break)
//   → 항상 같은 코드를 고른다(멱등·재현).
// ─────────────────────────────────────────────────────────────────────────────

// 대표 노드의 achievement_code(괄호형) 를 고르는 상관 서브쿼리.
//   contents 한 행당 위 규칙으로 정렬해 첫 코드 1개.
const REP_CODE_SUBQUERY = `(
  SELECT lmn.achievement_code
  FROM node_contents nc
  JOIN learning_map_nodes lmn ON nc.node_id = lmn.node_id
  WHERE nc.content_id = contents.id
    AND lmn.achievement_code IS NOT NULL AND TRIM(lmn.achievement_code) <> ''
  ORDER BY
    CASE WHEN nc.content_role = 'lecture' THEN 0 ELSE 1 END,
    nc.sort_order,
    nc.id
  LIMIT 1
)`;

/**
 * contents.achievement_code 백필 (멱등).
 *   achievement_code IS NULL/'' 인 콘텐츠 중 node_contents→learning_map_nodes 로
 *   대표 코드가 해석되는 것만 채운다. subject 가 비어있으면 코드의 교과 라벨로 보강.
 * @returns {{contents:number, subject:number}} 채운 건수
 */
function backfillContentAchievements(db) {
  // contents 테이블에 achievement_code 컬럼이 없으면(초기 마이그레이션 전) skip.
  const cCols = db.prepare('PRAGMA table_info(contents)').all().map(c => c.name);
  if (!cCols.includes('achievement_code')) return { contents: 0, subject: 0 };

  // 1) achievement_code 백필 — 대표 코드 서브쿼리 결과가 NOT NULL 인 행만.
  const codeRes = db.prepare(`
    UPDATE contents
    SET achievement_code = ${REP_CODE_SUBQUERY}
    WHERE (achievement_code IS NULL OR TRIM(achievement_code) = '')
      AND ${REP_CODE_SUBQUERY} IS NOT NULL
  `).run();

  // 2) subject(교과 라벨) 보강 — 방금/기존에 코드는 있는데 subject 가 비어있는 행만.
  //    코드 → curriculum_std_id_map.subject_code → 한글 라벨. 매핑 없으면 그대로 NULL.
  let subjectChanges = 0;
  if (cCols.includes('subject')) {
    let resolveCode;
    try { ({ resolveCode } = require('./lrs-mastery')); } catch (_) { resolveCode = null; }
    if (resolveCode) {
      const blanks = db.prepare(`
        SELECT id, achievement_code FROM contents
        WHERE achievement_code IS NOT NULL AND TRIM(achievement_code) <> ''
          AND (subject IS NULL OR TRIM(subject) = '')
      `).all();
      const upd = db.prepare('UPDATE contents SET subject = ? WHERE id = ? AND (subject IS NULL OR TRIM(subject) = \'\')');
      for (const r of blanks) {
        let label = null;
        try {
          const ctx = resolveCode(r.achievement_code);
          label = ctx && ctx.subject_label ? ctx.subject_label : null;
        } catch (_) { /* graceful */ }
        if (label) { upd.run(label, r.id); subjectChanges++; }
      }
    }
  }

  return { contents: codeRes.changes, subject: subjectChanges };
}

/**
 * 평가(exams)·과제(homework) achievement_code 백필 (멱등, 소량).
 *   exam_content_nodes / homework_content_nodes 는 std_id 매핑이다.
 *   std_id → curriculum_std_id_map.standard_code(괄호형 코드) 로 해석.
 *   대표 std_id: created_at 오름차순, std_id 오름차순(결정론).
 *   매핑 없으면 NULL 유지.
 * @returns {{exams:number, homework:number}} 채운 건수
 */
function backfillEvalAchievements(db) {
  const out = { exams: 0, homework: 0 };

  const stdToCode = `
    SELECT m.standard_code
    FROM {LINK} ln
    JOIN curriculum_std_id_map m ON ln.std_id = m.std_id
    WHERE ln.{ID_COL} = {TBL}.{PK}
      AND m.standard_code IS NOT NULL AND TRIM(m.standard_code) <> ''
    ORDER BY ln.created_at, ln.std_id
    LIMIT 1
  `;

  // exams
  try {
    const exCols = db.prepare('PRAGMA table_info(exams)').all().map(c => c.name);
    const linkExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exam_content_nodes'").get();
    if (exCols.includes('achievement_code') && linkExists) {
      const sub = stdToCode
        .replace(/\{LINK\}/g, 'exam_content_nodes')
        .replace(/\{ID_COL\}/g, 'exam_id')
        .replace(/\{TBL\}/g, 'exams')
        .replace(/\{PK\}/g, 'id');
      const res = db.prepare(`
        UPDATE exams
        SET achievement_code = (${sub})
        WHERE (achievement_code IS NULL OR TRIM(achievement_code) = '')
          AND (${sub}) IS NOT NULL
      `).run();
      out.exams = res.changes;
    }
  } catch (e) { console.error('[DB] 평가 성취코드 백필 실패:', e.message); }

  // homework
  try {
    const hwCols = db.prepare('PRAGMA table_info(homework)').all().map(c => c.name);
    const linkExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='homework_content_nodes'").get();
    if (hwCols.includes('achievement_code') && linkExists) {
      const sub = stdToCode
        .replace(/\{LINK\}/g, 'homework_content_nodes')
        .replace(/\{ID_COL\}/g, 'homework_id')
        .replace(/\{TBL\}/g, 'homework')
        .replace(/\{PK\}/g, 'id');
      const res = db.prepare(`
        UPDATE homework
        SET achievement_code = (${sub})
        WHERE (achievement_code IS NULL OR TRIM(achievement_code) = '')
          AND (${sub}) IS NOT NULL
      `).run();
      out.homework = res.changes;
    }
  } catch (e) { console.error('[DB] 과제 성취코드 백필 실패:', e.message); }

  return out;
}

/**
 * 과거 로그 보강 (멱등) — content 연계 학습 로그의 achievement_code 가 NULL 인데
 *   해당 contents.achievement_code 가 (1)에서 채워진 경우 로그에도 전파.
 *   bounded: target_type='content' & content_view/content_complete & achievement_code NULL 만.
 *   subject_code 도 코드의 교과코드로 함께 보강(NULL 인 것만).
 *   매핑 없는 콘텐츠 연계 로그는 그대로 NULL(억지 생성 금지).
 * @returns {{logs:number}} 보강한 로그 건수
 */
function backfillContentViewLogs(db) {
  const llCols = db.prepare('PRAGMA table_info(learning_logs)').all().map(c => c.name);
  if (!llCols.includes('achievement_code')) return { logs: 0 };
  const hasSubject = llCols.includes('subject_code');

  // 1) achievement_code 전파 — content 연계 학습로그(코드 NULL) ← contents.achievement_code(NOT NULL)
  //    target_id 는 문자열로 저장되므로 CAST 매칭.
  const codeRes = db.prepare(`
    UPDATE learning_logs
    SET achievement_code = (
      SELECT c.achievement_code FROM contents c
      WHERE CAST(c.id AS TEXT) = CAST(learning_logs.target_id AS TEXT)
        AND c.achievement_code IS NOT NULL AND TRIM(c.achievement_code) <> ''
    )
    WHERE target_type = 'content'
      AND activity_type IN ('content_view', 'content_complete')
      AND (achievement_code IS NULL OR TRIM(achievement_code) = '')
      AND EXISTS (
        SELECT 1 FROM contents c
        WHERE CAST(c.id AS TEXT) = CAST(learning_logs.target_id AS TEXT)
          AND c.achievement_code IS NOT NULL AND TRIM(c.achievement_code) <> ''
      )
  `).run();

  // 2) subject_code 보강 — 방금 코드가 채워진 content 로그 중 subject_code NULL.
  //    코드 → 교과코드(curriculum_std_id_map.subject_code). 매핑 없으면 그대로 NULL.
  if (hasSubject) {
    let resolveCode;
    try { ({ resolveCode } = require('./lrs-mastery')); } catch (_) { resolveCode = null; }
    if (resolveCode) {
      const rows = db.prepare(`
        SELECT id, achievement_code FROM learning_logs
        WHERE target_type = 'content'
          AND activity_type IN ('content_view', 'content_complete')
          AND achievement_code IS NOT NULL AND TRIM(achievement_code) <> ''
          AND (subject_code IS NULL OR TRIM(subject_code) = '')
      `).all();
      const upd = db.prepare('UPDATE learning_logs SET subject_code = ? WHERE id = ?');
      for (const r of rows) {
        let sc = null;
        try { const ctx = resolveCode(r.achievement_code); sc = ctx && ctx.subject_code ? ctx.subject_code : null; } catch (_) {}
        if (sc) upd.run(sc, r.id);
      }
    }
  }

  return { logs: codeRes.changes };
}

/**
 * 부팅 훅: 콘텐츠/평가/과제 achievement_code 백필 + (변동 있을 때만) 과거 로그 보강 + 재집계.
 *   schema.initSchema() 말미에서 호출. 모두 멱등 — 채울 게 없으면 거의 무비용.
 *   과거 로그 보강 + rebuild 는 "콘텐츠 백필로 새로 채워진 게 있을 때 또는 보강할 로그가 남아있을 때"만 수행.
 * @returns 백필 요약
 */
function runAchievementBackfill(db) {
  const summary = { contents: 0, subject: 0, exams: 0, homework: 0, logs: 0, rebuilt: false };
  try {
    const c = backfillContentAchievements(db);
    summary.contents = c.contents; summary.subject = c.subject;
    if (c.contents > 0) {
      console.log(`[DB] 콘텐츠 성취코드 백필 완료 — ${c.contents}건 (node_contents→성취기준 전파)` +
        (c.subject > 0 ? ` / 교과 라벨 ${c.subject}건 보강` : ''));
    }
  } catch (e) { console.error('[DB] 콘텐츠 성취코드 백필 실패:', e.message); }

  try {
    const ev = backfillEvalAchievements(db);
    summary.exams = ev.exams; summary.homework = ev.homework;
    if (ev.exams > 0 || ev.homework > 0) {
      console.log(`[DB] 평가/과제 성취코드 백필 — 평가 ${ev.exams}건 / 과제 ${ev.homework}건`);
    }
  } catch (e) { console.error('[DB] 평가/과제 성취코드 백필 실패:', e.message); }

  // 과거 로그 보강은 항상 멱등 호출(보강할 NULL 로그가 남아있으면만 실제 UPDATE).
  try {
    const lg = backfillContentViewLogs(db);
    summary.logs = lg.logs;
    if (lg.logs > 0) {
      console.log(`[DB] 과거 콘텐츠 학습로그 성취코드 보강 — ${lg.logs}건 (히트맵 즉시 반영용)`);
      // 보강된 로그를 성취 집계에 반영(1회). 캐시 무효화는 rebuild 내부가 처리.
      try {
        const { rebuildAllAggregates } = require('./lrs-aggregate');
        rebuildAllAggregates();
        summary.rebuilt = true;
        console.log('[DB] 과거 로그 보강 반영 — LRS 집계 재빌드 완료');
      } catch (e) { console.error('[DB] 로그 보강 후 재집계 실패:', e.message); }
    }
  } catch (e) { console.error('[DB] 과거 콘텐츠 학습로그 보강 실패:', e.message); }

  return summary;
}

module.exports = {
  REP_CODE_SUBQUERY,
  backfillContentAchievements,
  backfillEvalAchievements,
  backfillContentViewLogs,
  runAchievementBackfill,
};
