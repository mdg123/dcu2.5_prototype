#!/usr/bin/env node
// scripts/repair-daily-complete-success.js
// ─────────────────────────────────────────────────────────────────────────────
// [LRS 학생 전수감사 §1 복구] 이미 쌓인 daily_complete 로그의 result_success=NULL 손상 교정.
//
// 배경(근본원인):
//   completeDailyItem()(db/self-learn-extended.js)가 예전에 resultSuccess 를 전달하지 않아
//   learning_logs.daily_complete 가 전부 result_success=NULL 로 적재됐다. 이 NULL 이:
//     ① computeTrend(result_success IS NOT NULL 필터)에서 오늘의 학습 이수를 배제
//     ② lrs_achievement_stats 에 '1시도 0정답'으로 누적돼 도달률을 역효과로 깎음
//     ③ 성장목표·포트폴리오 게이트(if resultSuccess) 미통과
//   런타임 코드는 이미 수정됨(정답/점수→result_success 산출). 본 스크립트는 "이미 손상된" 과거 로그를
//   원 완료 데이터(daily_learning_progress)로 재산출해 교정한다.
//
// 재산출 규칙(런타임과 동일):
//   PASS_THRESHOLD = 0.6
//   · 문항형(correct_count·total_questions 有, total>0):
//       ratio = correct/total → success = ratio>=0.6 ? 1 : 0, score(scaled)=clamp(ratio,0,1)
//   · 점수형(score 有, 문항수 없음):
//       scaled = score>1 ? score/100 : score → success = scaled>=0.6 ? 1:0, score(scaled)=clamp
//   · 시청/이수형(score·문항 모두 없음):
//       success=null 유지(평가대상 아님). score 도 null 유지.
//       → 이런 건은 mastery 재집계에서 시도로 세지 않음(log-helper 와 동일: 평가신호 없으면 제외).
//
// 멱등성(재실행 안전):
//   · 교정 대상 = result_success IS NULL 인 daily_complete 로그.
//     이미 교정된(success 채워진) 건은 대상에서 제외 → 재실행 시 추가 변경 0.
//   · 원본값을 _daily_success_repair_backup 에 저장(중복 저장 방지: log_id UNIQUE).
//   · lrs_achievement_stats 는 영향받은 (user_id, achievement_code) 를 learning_logs 로부터
//     전량 재계산(REBUILD)하므로 몇 번 돌려도 동일 결과로 수렴.
//
// 사용법:
//   node scripts/repair-daily-complete-success.js --dry-run   # 미리보기(변경 안 함)
//   node scripts/repair-daily-complete-success.js             # 실행(교정 + 성취stats 재빌드)
//   node scripts/repair-daily-complete-success.js --revert    # 백업 기준 원복(success→NULL 등)
//
// GCP 실행법(PM):
//   로컬에서 파일을 base64 로 인코딩해 전송 후 서버에서 디코드:
//     로컬:  base64 -w0 scripts/repair-daily-complete-success.js  (Windows: certutil -encode)
//     서버:  cd /home/ubuntu/dacheum && sudo -iu ubuntu bash -c '
//              node scripts/repair-daily-complete-success.js --dry-run   # 먼저 확인
//              node scripts/repair-daily-complete-success.js             # 적용
//            '
//   (앱 유저=ubuntu, DB_PATH 는 프로세스 env 를 그대로 존중 — db 싱글톤 사용)
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const db = require(path.join(__dirname, '..', 'db')); // 싱글톤 (DB_PATH 존중)
const mastery = require(path.join(__dirname, '..', 'db', 'lrs-mastery'));

const DRY_RUN = process.argv.includes('--dry-run');
const REVERT = process.argv.includes('--revert');
const PASS_THRESHOLD = 0.6;

function log(...a) { console.log('[repair-daily-success]', ...a); }

// ── 백업 테이블 보장 ──
db.prepare(`
  CREATE TABLE IF NOT EXISTS _daily_success_repair_backup (
    log_id INTEGER PRIMARY KEY,
    old_result_success INTEGER,
    old_result_score REAL,
    old_correct_count INTEGER,
    old_total_items INTEGER,
    repaired_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// ── 영향받은 성취기준 (user_id, achievement_code) 를 learning_logs 로부터 전량 재계산 ──
//   평가신호(result_score 또는 result_success 비-NULL) 있는 로그만 시도로 집계 → 도달률 역효과 제거.
function rebuildAchievementStats(pairs) {
  let rebuilt = 0;
  const selAgg = db.prepare(`
    SELECT COUNT(*) attempts,
           SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) success,
           AVG(result_score) avg_score,
           MAX(created_at) last_at,
           MAX(subject_code) subject_code
    FROM learning_logs
    WHERE user_id = ? AND achievement_code = ?
      AND (result_score IS NOT NULL OR result_success IS NOT NULL)
  `);
  const upd = db.prepare(`
    UPDATE lrs_achievement_stats
       SET attempt_count = ?, success_count = ?, avg_score = ?,
           last_level = ?, level = ?, last_attempt_at = COALESCE(?, last_attempt_at),
           subject_code = COALESCE(?, subject_code), updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND achievement_code = ?
  `);
  const ins = db.prepare(`
    INSERT INTO lrs_achievement_stats
      (user_id, achievement_code, subject_code, attempt_count, success_count, avg_score,
       last_level, level, last_attempt_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  for (const { user_id, achievement_code } of pairs) {
    const a = selAgg.get(user_id, achievement_code);
    const attempts = a.attempts || 0;
    const success = a.success || 0;
    const avg = a.avg_score != null ? a.avg_score : null;
    const rate = mastery.reachRate(success, attempts, avg);
    const status = mastery.classifyStatus(attempts, rate);  // 영문 level
    const ko = mastery.STATUS_KO[status];                    // 한글 last_level
    const exists = db.prepare(
      'SELECT 1 FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
    ).get(user_id, achievement_code);
    if (exists) {
      upd.run(attempts, success, avg, ko, status, a.last_at, a.subject_code, user_id, achievement_code);
    } else if (attempts > 0) {
      ins.run(user_id, achievement_code, a.subject_code, attempts, success, avg, ko, status, a.last_at);
    }
    rebuilt++;
  }
  return rebuilt;
}

// ── REVERT: 백업 기준 원복 ──
if (REVERT) {
  const backups = db.prepare('SELECT * FROM _daily_success_repair_backup').all();
  if (!backups.length) { log('되돌릴 백업이 없습니다.'); process.exit(0); }
  log(`원복 대상 ${backups.length}건.`);
  if (DRY_RUN) { log('[dry-run] 실제 원복 안 함.'); process.exit(0); }
  const affectedPairs = new Set();
  const revert = db.transaction(() => {
    for (const b of backups) {
      const row = db.prepare('SELECT user_id, achievement_code FROM learning_logs WHERE id = ?').get(b.log_id);
      db.prepare(`
        UPDATE learning_logs
           SET result_success = ?, result_score = ?, correct_count = ?, total_items = ?
         WHERE id = ?
      `).run(b.old_result_success, b.old_result_score, b.old_correct_count, b.old_total_items, b.log_id);
      if (row && row.achievement_code) affectedPairs.add(`${row.user_id}::${row.achievement_code}`);
    }
    const pairs = [...affectedPairs].map(k => { const [u, c] = k.split('::'); return { user_id: Number(u), achievement_code: c }; });
    const n = rebuildAchievementStats(pairs);
    db.prepare('DELETE FROM _daily_success_repair_backup').run();
    log(`원복 완료: 로그 ${backups.length}건 · 성취stats 재빌드 ${n}건 · 백업 삭제.`);
  });
  revert();
  process.exit(0);
}

// ── 교정 대상 조회: result_success IS NULL 인 daily_complete + 원 완료 데이터 조인 ──
//   learning_logs.target_id(문자열)=daily_learning_progress.item_id, user_id 일치.
const targets = db.prepare(`
  SELECT ll.id AS log_id, ll.user_id, ll.achievement_code,
         ll.result_success AS old_success, ll.result_score AS old_score,
         ll.correct_count AS old_cc, ll.total_items AS old_ti,
         p.score AS p_score, p.correct_count AS p_cc, p.total_questions AS p_tq
    FROM learning_logs ll
    LEFT JOIN daily_learning_progress p
           ON p.user_id = ll.user_id AND CAST(p.item_id AS TEXT) = ll.target_id
   WHERE ll.activity_type = 'daily_complete'
     AND ll.result_success IS NULL
`).all();

log(`교정 대상 daily_complete(result_success NULL) ${targets.length}건.`);

// 재산출
function derive(t) {
  const hasQ = (t.p_cc != null && t.p_tq != null && Number(t.p_tq) > 0);
  if (hasQ) {
    const ratio = Number(t.p_cc) / Number(t.p_tq);
    return { success: ratio >= PASS_THRESHOLD ? 1 : 0, score: Math.max(0, Math.min(1, ratio)), cc: Number(t.p_cc), ti: Number(t.p_tq) };
  }
  if (t.p_score != null) {
    const scaled = Number(t.p_score) > 1 ? Number(t.p_score) / 100 : Number(t.p_score);
    const s = Math.max(0, Math.min(1, scaled));
    return { success: s >= PASS_THRESHOLD ? 1 : 0, score: s, cc: null, ti: null };
  }
  // 원 완료 데이터가 없거나(구로그) 점수·문항 둘 다 없음 → 시청/이수형: success/score 미상 유지.
  //   단, 로그에 이미 result_score 가 있으면(예전 safeScore/100) 그걸로 success 재산출.
  if (t.old_score != null) {
    const s = Math.max(0, Math.min(1, Number(t.old_score) > 1 ? Number(t.old_score) / 100 : Number(t.old_score)));
    return { success: s >= PASS_THRESHOLD ? 1 : 0, score: s, cc: t.old_cc ?? null, ti: t.old_ti ?? null };
  }
  return { success: null, score: null, cc: null, ti: null }; // 순수 이수 — 변경 없음
}

let willChange = 0, scored = 0, viewOnly = 0;
const plan = [];
for (const t of targets) {
  const d = derive(t);
  if (d.success == null && d.score == null) { viewOnly++; continue; } // 변경 없음(순수 이수)
  willChange++;
  if (d.success != null) scored++;
  plan.push({ t, d });
}

log(`재산출 결과: 교정예정 ${willChange}건(평가형 ${scored}) · 미변경(시청/이수형) ${viewOnly}건.`);
if (plan.length) {
  const sample = plan.slice(0, 8).map(({ t, d }) =>
    `#${t.log_id} u${t.user_id} ${t.achievement_code || '-'} → success=${d.success} score=${d.score != null ? d.score.toFixed(2) : 'null'} (${d.cc ?? '-'}/${d.ti ?? '-'})`);
  log('예시:\n  ' + sample.join('\n  '));
}

if (DRY_RUN) { log('[dry-run] 실제 변경 안 함. --revert 없이 재실행하면 적용됩니다.'); process.exit(0); }
if (!plan.length) { log('교정할 손상 로그가 없습니다(멱등).'); process.exit(0); }

const affectedPairs = new Set();
const apply = db.transaction(() => {
  const insBackup = db.prepare(`
    INSERT OR IGNORE INTO _daily_success_repair_backup
      (log_id, old_result_success, old_result_score, old_correct_count, old_total_items)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updLog = db.prepare(`
    UPDATE learning_logs
       SET result_success = ?, result_score = ?, correct_count = ?, total_items = ?
     WHERE id = ?
  `);
  for (const { t, d } of plan) {
    insBackup.run(t.log_id, t.old_success, t.old_score, t.old_cc, t.old_ti);
    updLog.run(d.success, d.score, d.cc, d.ti, t.log_id);
    if (t.achievement_code) affectedPairs.add(`${t.user_id}::${t.achievement_code}`);
  }
  const pairs = [...affectedPairs].map(k => { const [u, c] = k.split('::'); return { user_id: Number(u), achievement_code: c }; });
  const n = rebuildAchievementStats(pairs);
  log(`적용 완료: 로그 교정 ${plan.length}건 · 성취stats 재빌드 ${n}건(user×code).`);
});
apply();
log('완료. 되돌리려면: node scripts/repair-daily-complete-success.js --revert');
