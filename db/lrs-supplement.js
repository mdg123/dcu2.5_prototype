// db/lrs-supplement.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS P1-3 — 교사 보충 일괄배정(처방 실행). 기획서: 작업지시서/LRS_P1_심화_기획서.md §4
//
//   본질: EWS/약점이 "보기만" → "행동(개입)" 으로. per-student 처방 SSOT 신규 테이블.
//   학생 노출은 기존 "과제 목록" 채널에 미러링(routes/homework.js 가 본 모듈을 합류).
//
//   설계 원칙(P0 계승):
//     - 멱등/중복방지: UNIQUE(user_id, achievement_code, content_id) + INSERT OR IGNORE.
//       content_id NULL 은 SQLite UNIQUE 에서 다중행 허용 함정 → 센티넬 0 으로 정규화.
//     - 단일 분류기: 추천·약점 판정은 lrs-mastery.classifyStatus/recommendForCode 만.
//     - P5 평가부족≠미도달: 약점 후보는 미도달/부분도달 우선. insufficient 는 "먼저 풀어보기".
//     - P6 낙인 방지: 학생 응답에 위험점수·risk 필드 절대 미포함(라우트에서 보장).
//     - 취소=soft(status='cancelled'), 이력 영구 보존.
//     - raw(learning_logs) 불변. 신규 테이블만 가산.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./index');
const mastery = require('./lrs-mastery');

// content_id NULL 정규화 센티넬 — "콘텐츠 없는 코드 처방". UNIQUE 다중 NULL 함정 회피.
const NO_CONTENT = 0;

const SOURCES = new Set(['ews', 'weak', 'prereq', 'manual']);
const STATUSES = new Set(['assigned', 'in_progress', 'done', 'cancelled']);

let _tableReady = false;

/** 테이블·인덱스 멱등 생성. require 시 1회 + initSchema 안전망에서 재호출 가능. */
function ensureTable() {
  if (_tableReady) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS supplement_assignment (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id         INTEGER NOT NULL,
        teacher_id       INTEGER NOT NULL,           -- 배정한 담당 교사(실명 정책)
        user_id          INTEGER NOT NULL,           -- 배정 대상 학생(per-student)
        achievement_code TEXT,                       -- 약점 성취기준(처방 근거)
        content_id       INTEGER NOT NULL DEFAULT 0, -- 추천 콘텐츠(0=콘텐츠 없는 코드 처방 센티넬)
        source           TEXT DEFAULT 'ews',         -- 'ews'|'weak'|'prereq'|'manual'
        status           TEXT DEFAULT 'assigned',    -- 'assigned'|'in_progress'|'done'|'cancelled'
        baseline_risk    INTEGER,                    -- 배정 시점 위험점수(개입 전후 비교)
        baseline_reached INTEGER,                    -- 배정 시점 도달 성취기준 수
        homework_id      INTEGER,                    -- 미러링된 과제 id(있으면)
        assigned_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at     DATETIME,
        cancelled_at     DATETIME,
        UNIQUE(user_id, achievement_code, content_id) -- ★ 멱등·중복방지 키
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_supp_class ON supplement_assignment(class_id, status);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_supp_user ON supplement_assignment(user_id, status);");
    _tableReady = true;
  } catch (e) {
    console.error('[다채움] supplement_assignment 테이블 생성 실패:', e && e.message);
  }
}
ensureTable();

// ── 배정 시점 baseline(위험점수·도달 수) 묶음 조회 — N명 1회 ─────────────────
//   순환참조 회피: lrs-analytics 는 함수 내부에서 lazy require.
function _baselinesFor(classId, userIds) {
  const out = new Map(); // userId -> { risk, reached }
  if (!userIds.length) return out;
  // 위험점수(반 단위 1회 산출 후 매핑) — P6 내부 산출, 학생 응답엔 미포함.
  try {
    const analytics = require('./lrs-analytics');
    const risk = analytics.getClassRiskList(classId);
    for (const r of (risk.list || [])) out.set(r.userId, { risk: r.score, reached: null });
  } catch (_) { /* 위험 산출 불가 → null baseline */ }
  // 도달 성취기준 수(단일 분류기)
  try {
    const ph = userIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT user_id, attempt_count AS attempts, success_count AS correct, avg_score
      FROM lrs_achievement_stats WHERE user_id IN (${ph})
    `).all(...userIds);
    const reachedByUser = new Map();
    for (const r of rows) {
      const rate = mastery.reachRate(r.correct, r.attempts, r.avg_score);
      if (mastery.classifyStatus(r.attempts, rate) === mastery.STATUS.REACHED) {
        reachedByUser.set(r.user_id, (reachedByUser.get(r.user_id) || 0) + 1);
      }
    }
    for (const uid of userIds) {
      const e = out.get(uid) || { risk: null, reached: null };
      e.reached = reachedByUser.get(uid) || 0;
      out.set(uid, e);
    }
  } catch (_) { /* 무시 */ }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 일괄 배정(멱등). items: [{ userId, achievementCode, contentId? }]
//   INSERT OR IGNORE → 신규 N건·중복 M건. content_id NULL→0 정규화.
//   반환: { assigned, skipped, ids:[신규 id...], skippedDetail:[{userId,achievementCode,contentId}] }
// ─────────────────────────────────────────────────────────────────────────────
function assignSupplements(classId, teacherId, items, { source = 'ews' } = {}) {
  ensureTable();
  const cid = Number(classId);
  const tid = Number(teacherId);
  const src = SOURCES.has(source) ? source : 'manual';
  const clean = (Array.isArray(items) ? items : [])
    .map(it => ({
      userId: Number(it.userId),
      achievementCode: it.achievementCode == null ? null : String(it.achievementCode),
      contentId: (it.contentId == null || it.contentId === '') ? NO_CONTENT : Number(it.contentId),
    }))
    .filter(it => Number.isInteger(it.userId) && it.userId > 0);

  if (!clean.length) return { assigned: 0, skipped: 0, ids: [], skippedDetail: [] };

  // baseline 묶음 조회(배정 대상 학생 distinct)
  const targetIds = [...new Set(clean.map(it => it.userId))];
  const baselines = _baselinesFor(cid, targetIds);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO supplement_assignment
      (class_id, teacher_id, user_id, achievement_code, content_id, source, status, baseline_risk, baseline_reached)
    VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, ?)
  `);

  const result = { assigned: 0, skipped: 0, ids: [], skippedDetail: [] };
  const tx = db.transaction(() => {
    for (const it of clean) {
      const bl = baselines.get(it.userId) || { risk: null, reached: null };
      const info = ins.run(cid, tid, it.userId, it.achievementCode, it.contentId, src,
        bl.risk == null ? null : Math.round(bl.risk),
        bl.reached == null ? null : bl.reached);
      if (info.changes > 0) {
        result.assigned++;
        result.ids.push(info.lastInsertRowid);
      } else {
        result.skipped++;
        result.skippedDetail.push({
          userId: it.userId, achievementCode: it.achievementCode,
          contentId: it.contentId === NO_CONTENT ? null : it.contentId,
        });
      }
    }
  });
  tx();
  return result;
}

// 행 → FE 친화 객체(콘텐츠/성취기준 라벨 부착). P6: 위험점수 필드 절대 미포함.
function _decorate(row, { includeBaseline = false } = {}) {
  if (!row) return null;
  const ctx = row.achievement_code ? mastery.resolveCode(row.achievement_code) : null;
  const o = {
    id: row.id,
    classId: row.class_id,
    userId: row.user_id,
    teacherId: row.teacher_id,
    achievementCode: row.achievement_code || null,
    achievementLabel: ctx ? ctx.label : null,
    subject: ctx ? (ctx.subject_label || null) : null,
    contentId: (row.content_id && row.content_id !== NO_CONTENT) ? row.content_id : null,
    contentTitle: row.content_title || null,
    contentType: row.content_type || null,
    source: row.source,
    status: row.status,
    homeworkId: row.homework_id || null,
    assignedAt: row.assigned_at || null,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
  };
  // baseline_risk/baseline_reached 는 교사뷰(개입 전후 비교)에서만 — 학생뷰엔 미포함(P6).
  if (includeBaseline) {
    o.baselineRisk = row.baseline_risk == null ? null : row.baseline_risk;
    o.baselineReached = row.baseline_reached == null ? null : row.baseline_reached;
  }
  return o;
}

const _SELECT_BASE = `
  SELECT sa.*, c.title AS content_title, c.content_type AS content_type,
         u.display_name AS student_name, u.username AS student_username
  FROM supplement_assignment sa
  LEFT JOIN contents c ON c.id = sa.content_id AND sa.content_id <> 0
  LEFT JOIN users u ON u.id = sa.user_id
`;

// 교사: 반 배정 현황(학생·성취기준·콘텐츠·status). cancelled 포함(이력) — 옵션으로 제외 가능.
function getClassSupplements(classId, { includeCancelled = true } = {}) {
  ensureTable();
  let where = 'WHERE sa.class_id = ?';
  if (!includeCancelled) where += " AND sa.status <> 'cancelled'";
  const rows = db.prepare(`${_SELECT_BASE} ${where} ORDER BY sa.assigned_at DESC, sa.id DESC`).all(Number(classId));
  return rows.map(r => {
    const o = _decorate(r, { includeBaseline: true });
    o.studentName = r.student_name || r.student_username || `학생${r.user_id}`;
    return o;
  });
}

// 학생 본인 보충 목록(취소분 제외). P6: baseline/위험 미포함.
function getMySupplements(userId, { includeDone = true } = {}) {
  ensureTable();
  let where = "WHERE sa.user_id = ? AND sa.status <> 'cancelled'";
  if (!includeDone) where += " AND sa.status <> 'done'";
  const rows = db.prepare(`${_SELECT_BASE} ${where} ORDER BY sa.assigned_at DESC, sa.id DESC`).all(Number(userId));
  return rows.map(r => _decorate(r, { includeBaseline: false }));
}

function getSupplementById(id) {
  ensureTable();
  const row = db.prepare(`${_SELECT_BASE} WHERE sa.id = ?`).get(Number(id));
  return row || null;
}

// 취소(soft) — 교사. status='cancelled' + cancelled_at. 이미 취소면 무변.
function cancelSupplement(id) {
  ensureTable();
  const info = db.prepare(`
    UPDATE supplement_assignment
       SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status <> 'cancelled'
  `).run(Number(id));
  return info.changes > 0;
}

// 완료 — 학생 본인 또는 완료 연동. cancelled 는 완료 불가.
function markDone(id) {
  ensureTable();
  const info = db.prepare(`
    UPDATE supplement_assignment
       SET status = 'done', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status NOT IN ('done', 'cancelled')
  `).run(Number(id));
  return info.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 추천 후보 산출(교사 배정 모달 자동채움): 약점 코드 → 추천 콘텐츠 + 미도달/부분도달 학생.
//   recommendCandidates(classId, code, students) →
//     { code, label, subject, recommendations:[{id,title,...}],
//       targetStudents:[{id,name,status,statusKo,rate}],          // 미도달·부분도달(보충)
//       insufficientStudents:[{id,name,...}],                      // 평가부족(먼저 풀어보기) P5
//       alreadyAssigned:[{userId,contentId}] }                     // 회색 처리용
// ─────────────────────────────────────────────────────────────────────────────
function recommendCandidates(classId, code, students) {
  ensureTable();
  const ctx = mastery.resolveCode(code);
  const norm = ctx.code;
  const raw = String(code || '').trim();
  const ids = students.map(s => s.id);
  const nameById = new Map(students.map(s => [s.id, s.name]));

  const recommendations = mastery.recommendForCode(code, 5);

  const targetStudents = [];
  const insufficientStudents = [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    // 괄호 유/무 양쪽 매칭(데이터 혼재)
    const rows = db.prepare(`
      SELECT user_id, attempt_count AS attempts, success_count AS correct, avg_score
      FROM lrs_achievement_stats
      WHERE user_id IN (${ph}) AND achievement_code IN (?, ?)
    `).all(...ids, norm, raw);
    for (const r of rows) {
      const rate = mastery.reachRate(r.correct, r.attempts, r.avg_score);
      const status = mastery.classifyStatus(r.attempts, rate);
      const entry = {
        id: r.user_id, name: nameById.get(r.user_id) || `학생${r.user_id}`,
        status, statusKo: mastery.STATUS_KO[status],
        rate: rate == null ? null : Math.round(rate * 10) / 10,
      };
      if (status === mastery.STATUS.NOT_REACHED || status === mastery.STATUS.PARTIAL) {
        targetStudents.push(entry);          // 보충 대상(미도달·부분도달 우선)
      } else if (status === mastery.STATUS.INSUFFICIENT) {
        insufficientStudents.push(entry);    // P5: "먼저 풀어보기" 분기
      }
    }
    // 미도달 먼저(낮은 rate 우선)
    targetStudents.sort((a, b) => (a.rate ?? 999) - (b.rate ?? 999));
  }

  // 이미 배정된 (학생, 콘텐츠) 조합 — 모달 회색 처리용(cancelled 제외)
  const alreadyAssigned = ids.length ? db.prepare(`
    SELECT user_id AS userId, content_id AS contentId
    FROM supplement_assignment
    WHERE class_id = ? AND achievement_code = ? AND status <> 'cancelled'
      AND user_id IN (${ids.map(() => '?').join(',')})
  `).all(Number(classId), norm, ...ids).map(r => ({
    userId: r.userId, contentId: r.contentId === NO_CONTENT ? null : r.contentId,
  })) : [];

  return {
    code: norm, label: ctx.label, subject: ctx.subject_label || null,
    recommendations,
    targetStudents,
    insufficientStudents,
    alreadyAssigned,
  };
}

// ── 과제 목록 미러용: 학생의 보충 배정분(cancelled 제외)을 "보충" 출처로 반환 ──────
//   routes/homework.js 가 호출해 과제 목록에 합쳐 노출. 위조 homework 행 생성 안 함.
//   classId 지정 시 해당 반만. type='supplement' 구분 필드 포함(FE 배지용).
function getStudentSupplementsForList(userId, classId = null) {
  ensureTable();
  let where = "WHERE sa.user_id = ? AND sa.status <> 'cancelled'";
  const params = [Number(userId)];
  if (classId != null) { where += ' AND sa.class_id = ?'; params.push(Number(classId)); }
  const rows = db.prepare(`${_SELECT_BASE} ${where} ORDER BY sa.assigned_at DESC, sa.id DESC`).all(...params);
  return rows.map(r => {
    const ctx = r.achievement_code ? mastery.resolveCode(r.achievement_code) : null;
    return {
      type: 'supplement',                 // ★ FE 배지 구분 필드
      source: 'supplement',
      supplement_id: r.id,
      class_id: r.class_id,
      achievement_code: r.achievement_code || null,
      achievement_label: ctx ? ctx.label : null,
      subject: ctx ? (ctx.subject_label || null) : null,
      content_id: (r.content_id && r.content_id !== NO_CONTENT) ? r.content_id : null,
      title: r.content_title || (ctx ? `${ctx.label} 보충 학습` : '보충 학습'),
      content_type: r.content_type || null,
      status: r.status,                   // assigned|in_progress|done
      assigned_at: r.assigned_at || null,
      completed_at: r.completed_at || null,
    };
  });
}

module.exports = {
  NO_CONTENT, SOURCES, STATUSES,
  ensureTable,
  assignSupplements,
  getClassSupplements,
  getMySupplements,
  getSupplementById,
  cancelSupplement,
  markDone,
  recommendCandidates,
  getStudentSupplementsForList,
};
