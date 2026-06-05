/**
 * 일회성 정리 스크립트 — student1(user_id=3) 진단 시뮬 오염 데이터 정리
 *
 * 배경:
 *   AI 맞춤학습 진단 개발·감리 과정에서 student1 계정으로 372개의 진단 세션을
 *   시뮬레이션하면서, (구) 진단 코드가 진단 정답률만으로 user_node_status.status를
 *   'completed'/'in_progress'로 잘못 갱신 → 실제 학습 없이 학습맵 노드가 완료/진행중 표시.
 *
 * 정책 (사용자 확정):
 *   1. 진단은 노드 학습 status를 절대 바꾸지 않는다 (코드는 이미 수정됨).
 *   2. 노드 status는 오직 실제 학습으로만 산출.
 *   3. student1 오염 데이터 정리하되 실제 학습 기록은 보존.
 *
 * 처리:
 *   A. user_node_status (user_id=3) 전체 삭제 후, 실제 학습 기록(problem_attempts /
 *      user_content_progress)으로부터 status를 재산출(in_progress / video_watched /
 *      completed). 진단 시뮬로 박힌 completed/in_progress/diagnosed는 모두 제거되고,
 *      실제 학습한 노드만 올바른 status로 복원된다.
 *   B. diagnosis_sessions (user_id=3) 전체 삭제 — 372개 모두 개발·감리 시뮬 세션.
 *      diagnosis_answers는 FK ON DELETE CASCADE로 함께 삭제됨.
 *   C. 실제 학습 기록(problem_attempts / user_content_progress / daily_learning_progress
 *      / wrong_note 등)은 전혀 건드리지 않는다.
 *
 * 안전:
 *   - user_id = 3 (이학생/student1) 에만 작용. id 999(학생개설테스트반) 등 타 데이터 미접근.
 *   - 단일 트랜잭션. 정리 전/후 행수를 모두 출력(백업 로그).
 *   - idempotent: 재실행해도 안전(이미 정리된 상태면 동일 결과로 수렴).
 *   - 서버가 DB를 잠그고 있으면 실패할 수 있음 → 서버 정지 후 실행 권고(또는 WAL 공유).
 *
 * 실행:
 *   node scripts/cleanup-student1-diagnosis-pollution.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const TARGET_USER_ID = 3; // student1 (이학생)
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON'); // diagnosis_answers ON DELETE CASCADE 적용

console.log('=== student1 진단 오염 데이터 정리 시작 ===');
console.log('DB:', DB_PATH);
console.log('대상 user_id:', TARGET_USER_ID);

function countUNS() {
  return db.prepare('SELECT COUNT(*) c FROM user_node_status WHERE user_id = ?').get(TARGET_USER_ID).c;
}
function countSessions() {
  return db.prepare('SELECT COUNT(*) c FROM diagnosis_sessions WHERE user_id = ?').get(TARGET_USER_ID).c;
}
function countAnswers() {
  return db.prepare(`
    SELECT COUNT(*) c FROM diagnosis_answers da
    JOIN diagnosis_sessions ds ON da.session_id = ds.id
    WHERE ds.user_id = ?
  `).get(TARGET_USER_ID).c;
}

// ── 정리 전 백업 로그 ─────────────────────────────────────────
const before = {
  user_node_status: countUNS(),
  diagnosis_sessions: countSessions(),
  diagnosis_answers: countAnswers(),
  // 보존되어야 하는 실제 학습 기록 (정리 후 동일해야 함)
  problem_attempts: db.prepare('SELECT COUNT(*) c FROM problem_attempts WHERE user_id = ?').get(TARGET_USER_ID).c,
  user_content_progress: db.prepare('SELECT COUNT(*) c FROM user_content_progress WHERE user_id = ?').get(TARGET_USER_ID).c,
  daily_learning_progress: db.prepare('SELECT COUNT(*) c FROM daily_learning_progress WHERE user_id = ?').get(TARGET_USER_ID).c,
};
console.log('\n[정리 전 행수]');
console.log(JSON.stringify(before, null, 2));

// ── 정리 + 실제학습 기반 재산출 (단일 트랜잭션) ───────────────
const tx = db.transaction(() => {
  // A-1. user_node_status 전체 삭제 (모두 진단/스테일 — completed_at 0건 확인됨)
  db.prepare('DELETE FROM user_node_status WHERE user_id = ?').run(TARGET_USER_ID);

  // A-2. 실제 학습(문제풀이)으로부터 노드별 correct_rate + in_progress 복원
  //      (submitProblemAttempt의 노드 status 갱신 로직과 동일)
  const paNodes = db.prepare(`
    SELECT pa.node_id,
           COUNT(*) AS t,
           SUM(pa.is_correct) AS c
    FROM problem_attempts pa
    WHERE pa.user_id = ? AND pa.node_id IS NOT NULL AND pa.node_id <> ''
      AND EXISTS (SELECT 1 FROM learning_map_nodes l WHERE l.node_id = pa.node_id)
    GROUP BY pa.node_id
  `).all(TARGET_USER_ID);
  for (const n of paNodes) {
    const rate = n.t > 0 ? (n.c / n.t) : 0;
    db.prepare(`
      INSERT INTO user_node_status (user_id, node_id, status, correct_rate, last_accessed_at)
      VALUES (?, ?, 'in_progress', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, node_id) DO UPDATE SET
        correct_rate = excluded.correct_rate,
        last_accessed_at = CURRENT_TIMESTAMP
    `).run(TARGET_USER_ID, n.node_id, rate);
  }

  // A-3. 실제 학습(영상 시청 watch_ratio >= 0.8)으로부터 video_watched 복원
  //      (recordVideoProgress의 노드 status 갱신 로직과 동일, terminal 보존)
  const vidNodes = db.prepare(`
    SELECT ucp.node_id, MAX(ucp.watch_ratio) AS wr
    FROM user_content_progress ucp
    WHERE ucp.user_id = ? AND ucp.node_id IS NOT NULL AND ucp.node_id <> ''
      AND EXISTS (SELECT 1 FROM learning_map_nodes l WHERE l.node_id = ucp.node_id)
    GROUP BY ucp.node_id
  `).all(TARGET_USER_ID);
  for (const n of vidNodes) {
    if ((n.wr || 0) < 0.8) continue;
    db.prepare(`
      INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at)
      VALUES (?, ?, 'video_watched', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, node_id) DO UPDATE SET
        status = CASE WHEN user_node_status.status IN ('completed','mastered')
                      THEN user_node_status.status ELSE 'video_watched' END,
        last_accessed_at = CURRENT_TIMESTAMP
    `).run(TARGET_USER_ID, n.node_id);
  }

  // B. diagnosis_sessions 전체 삭제 (diagnosis_answers는 CASCADE)
  db.prepare('DELETE FROM diagnosis_sessions WHERE user_id = ?').run(TARGET_USER_ID);
});
tx();

// ── A-4. 실제 학습 완료 자동 격상 (evaluateNodeCompletion) ─────
//   영상 80%+ AND 문제 정답률 60%+ 충족 노드는 'completed'로 격상.
//   모듈의 권위 로직을 그대로 사용(별도 WAL 공유 인스턴스).
let promoted = 0;
try {
  const selfLearn = require('../db/self-learn-extended');
  const touched = db.prepare(
    'SELECT node_id FROM user_node_status WHERE user_id = ?'
  ).all(TARGET_USER_ID);
  for (const r of touched) {
    try {
      if (selfLearn.evaluateNodeCompletion(TARGET_USER_ID, r.node_id)) promoted++;
    } catch (_) { /* 개별 노드 격상 실패 무시 */ }
  }
} catch (e) {
  console.warn('  [경고] evaluateNodeCompletion 격상 단계 스킵:', e.message);
}

// ── 정리 후 검증 로그 ─────────────────────────────────────────
const after = {
  user_node_status: countUNS(),
  diagnosis_sessions: countSessions(),
  diagnosis_answers: countAnswers(),
  problem_attempts: db.prepare('SELECT COUNT(*) c FROM problem_attempts WHERE user_id = ?').get(TARGET_USER_ID).c,
  user_content_progress: db.prepare('SELECT COUNT(*) c FROM user_content_progress WHERE user_id = ?').get(TARGET_USER_ID).c,
  daily_learning_progress: db.prepare('SELECT COUNT(*) c FROM daily_learning_progress WHERE user_id = ?').get(TARGET_USER_ID).c,
};
console.log('\n[정리 후 행수]');
console.log(JSON.stringify(after, null, 2));

const dist = db.prepare(
  'SELECT status, COUNT(*) c FROM user_node_status WHERE user_id = ? GROUP BY status'
).all(TARGET_USER_ID);
console.log('\n[정리 후 user_node_status status 분포]');
console.log(JSON.stringify(dist, null, 2));
console.log(`\n실제학습 자동 completed 격상: ${promoted}건`);

// ── 보존 검증 (실제 학습 기록 불변 확인) ──────────────────────
const preserved =
  before.problem_attempts === after.problem_attempts &&
  before.user_content_progress === after.user_content_progress &&
  before.daily_learning_progress === after.daily_learning_progress;
console.log('\n[보존 검증] 실제 학습 기록 불변:', preserved ? 'OK' : '!! 변경됨 — 점검 필요');

db.close();
console.log('\n=== 정리 완료 ===');
