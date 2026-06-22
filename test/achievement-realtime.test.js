// test/achievement-realtime.test.js
// ─────────────────────────────────────────────────────────────────────────────
// REWORK-1 회귀/불변식 하네스 (격리 DB) — realtime achievement upsert 경로.
//
//   REWORK-1 — realtime upsert(db/learning-log-helper.js) 가 단일 분류기를 안 탐:
//     결함 B 는 rebuild 경로(db/lrs-aggregate.js)만 단일 분류기로 통일했고,
//     realtime achievement upsert 는 레거시 computeAchievementLevel 그대로였다.
//     게다가 결함 A fix 가 자기주도 풀이에 achievement_code 를 주입하면서
//     이전엔 NULL 이라 건너뛰던 `if(achievementCode)` realtime 블록에 새로 진입 →
//     att<3 분기로 last_level='미도달'·level=NULL 기록(레거시 라벨).
//     단일 분류기상 정답은 '평가부족'(insufficient). → 교사 /warnings 가
//     last_level IN('하','미도달') 로 매칭해 정답만 푼 학생을 결손목록에 오탐 등재.
//     fix: realtime upsert 를 mastery 단일 분류기(classifyStatus/reachRate/STATUS_KO)
//          로 교체. success/attempt 우선, att<3→insufficient/평가부족, 영문 level 동시 기록.
//
//   DB 격리: 실 DB → 임시 복사본. initSchema()로 마이그레이션. rebuild 없이 realtime 만.
//   주의: learning_logs.user_id 는 users(id) FK 가 있으므로 합성 user 금지 → 실 student 사용.
//         (user, code) 행을 서브테스트마다 격리 삭제해 깨끗한 누적에서 검증.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                          // ★ db require 전에 DB_PATH 주입
require('../db/schema').initSchema();   // 격리 DB에도 std_id·level 컬럼 마이그레이션

const selfLearn = require('../db/self-learn-extended');
const { classifyStatus, reachRate, STATUS_KO } = require('../db/lrs-mastery');
const db = openTestDb();

function pickMappedNode() {
  return db.prepare(
    "SELECT node_id, achievement_code FROM learning_map_nodes WHERE achievement_code IS NOT NULL AND achievement_code <> '' LIMIT 1"
  ).get();
}
function pickNoMapContent() {
  return db.prepare(`
    SELECT id FROM contents
    WHERE (achievement_code IS NULL OR achievement_code = '')
      AND id NOT IN (
        SELECT content_id FROM node_contents
        WHERE node_id IN (SELECT node_id FROM learning_map_nodes WHERE achievement_code IS NOT NULL AND achievement_code <> '')
      )
    LIMIT 1
  `).get();
}
// 실 student 계정 N명 (학생 부족 시 가용 인원만)
function pickStudents(n) {
  return db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT ?").all(n).map(r => r.id);
}
// (user, code) 누적 격리: 그 학생의 해당 코드 집계행 + 관련 problem_attempt 로그 제거
function resetStat(userId, code) {
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?').run(userId, code);
}

// ──────────────────────────────────────────────────────────────────────────
// RT-1: self-learn 정답 2회 풀이(realtime, rebuild 없음) → att=2,success=2,avg=null
//       → 단일 분류기상 평가부족. last_level='평가부족' & level='insufficient' 기록.
//       (fix 전: last_level='미도달' & level=NULL → RED)
// ──────────────────────────────────────────────────────────────────────────
test('RT-1: realtime 정답 2회(att<3) → last_level=평가부족 & level=insufficient (레거시 미도달/NULL 아님)', () => {
  const mapped = pickMappedNode();
  const noMap = pickNoMapContent();
  assert.ok(mapped && noMap, '픽스처(매핑 node + 코드없는 content) 필요');
  const code = mapped.achievement_code;
  const [u] = pickStudents(1);
  assert.ok(u, 'student 계정 필요');
  resetStat(u, code);

  // 정답 2회 (realtime upsert 만 — rebuild 호출 안 함)
  selfLearn.recordProblemAttempt(u, noMap.id, { isCorrect: true, nodeId: mapped.node_id });
  selfLearn.recordProblemAttempt(u, noMap.id, { isCorrect: true, nodeId: mapped.node_id });

  const stat = db.prepare(
    'SELECT attempt_count, success_count, avg_score, level, last_level FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(u, code);

  assert.ok(stat, 'realtime upsert 가 집계행을 만들어야 함');
  assert.equal(stat.attempt_count, 2, 'attempt 누적 2 (개수 회귀 금지)');
  assert.equal(stat.success_count, 2, 'success 누적 2 (개수 회귀 금지)');
  // 핵심 단언: att<3 → 평가부족/insufficient (레거시 미도달/NULL 금지)
  assert.equal(stat.level, 'insufficient', `level=insufficient 여야 (fix 전엔 NULL — got ${stat.level})`);
  assert.equal(stat.last_level, '평가부족', `last_level=평가부족 여야 (fix 전엔 '미도달' — got ${stat.last_level})`);

  resetStat(u, code);
});

// ──────────────────────────────────────────────────────────────────────────
// RT-2: realtime 정답 3회(att=3,success=3,avg=null) → success/attempt 우선 rate=100
//       → 도달/reached. (avg 기반 상/중/하 폐기 검증 — avg null 이어도 success 로 판정)
// ──────────────────────────────────────────────────────────────────────────
test('RT-2: realtime 정답 3회(att>=3, avg null) → level=reached & last_level=도달 (success/attempt 우선)', () => {
  const mapped = pickMappedNode();
  const noMap = pickNoMapContent();
  const code = mapped.achievement_code;
  const [u] = pickStudents(1);
  resetStat(u, code);

  for (let i = 0; i < 3; i++) selfLearn.recordProblemAttempt(u, noMap.id, { isCorrect: true, nodeId: mapped.node_id });

  const stat = db.prepare(
    'SELECT attempt_count, success_count, avg_score, level, last_level FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(u, code);
  assert.equal(stat.attempt_count, 3);
  assert.equal(stat.success_count, 3);
  // success/attempt=100% & att>=3 → reached. (avg_score null 이어도 폴백 무시)
  const expected = classifyStatus(stat.attempt_count, reachRate(stat.success_count, stat.attempt_count, stat.avg_score));
  assert.equal(expected, 'reached', '분류기상 3/3 → reached');
  assert.equal(stat.level, 'reached', `level=reached (got ${stat.level})`);
  assert.equal(stat.last_level, '도달', `last_level=도달 (got ${stat.last_level})`);

  resetStat(u, code);
});

// ──────────────────────────────────────────────────────────────────────────
// RT-3: realtime 오답 3회(att=3,success=0,avg=null) → rate=0 → 미도달/not_reached
// ──────────────────────────────────────────────────────────────────────────
test('RT-3: realtime 오답 3회(att>=3) → level=not_reached & last_level=미도달', () => {
  const mapped = pickMappedNode();
  const noMap = pickNoMapContent();
  const code = mapped.achievement_code;
  const [u] = pickStudents(1);
  resetStat(u, code);

  for (let i = 0; i < 3; i++) selfLearn.recordProblemAttempt(u, noMap.id, { isCorrect: false, nodeId: mapped.node_id });

  const stat = db.prepare(
    'SELECT attempt_count, success_count, avg_score, level, last_level FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(u, code);
  assert.equal(stat.attempt_count, 3);
  assert.equal(stat.success_count, 0);
  assert.equal(stat.level, 'not_reached', `level=not_reached (got ${stat.level})`);
  assert.equal(stat.last_level, '미도달', `last_level=미도달 (got ${stat.last_level})`);

  resetStat(u, code);
});

// ──────────────────────────────────────────────────────────────────────────
// RT-4: 불변식 — realtime 1건만 흘린 직후(rebuild 없이) lrs_achievement_stats 전 행이
//       level===classifyStatus & last_level===STATUS_KO (위반 0).
//       realtime 과 rebuild 가 동일 결과를 산출해야 함(플리커 0).
//       (베타 DB 의 레거시 행은 rebuild 로 미리 통일 — realtime 한 행만 새로 검증)
// ──────────────────────────────────────────────────────────────────────────
test('RT-4: realtime 1건 후 전 행 level===classifyStatus & last_level===STATUS_KO 위반 0', () => {
  const { rebuildAllAggregates } = require('../db/lrs-aggregate');
  rebuildAllAggregates(); // 베타 레거시 행을 단일 분류기로 통일(기존 행 노이즈 제거)

  const mapped = pickMappedNode();
  const noMap = pickNoMapContent();
  const code = mapped.achievement_code;
  const [u] = pickStudents(1);
  resetStat(u, code);
  selfLearn.recordProblemAttempt(u, noMap.id, { isCorrect: true, nodeId: mapped.node_id });

  const rows = db.prepare(
    'SELECT id, attempt_count, success_count, avg_score, level, last_level FROM lrs_achievement_stats'
  ).all();
  assert.ok(rows.length > 0);

  let levelMismatch = 0, koMismatch = 0;
  for (const r of rows) {
    const rate = reachRate(r.success_count, r.attempt_count, r.avg_score);
    const status = classifyStatus(r.attempt_count, rate);
    if (r.level !== status) levelMismatch++;
    if (r.last_level !== STATUS_KO[status]) koMismatch++;
  }
  assert.equal(levelMismatch, 0, `stored level !== classifyStatus 위반 ${levelMismatch}행 (realtime 미통일 시 RED)`);
  assert.equal(koMismatch, 0, `stored last_level !== STATUS_KO 위반 ${koMismatch}행`);

  resetStat(u, code);
});

// ──────────────────────────────────────────────────────────────────────────
// RT-5: 교사 /warnings 결손 매칭 — 정답만 푼 att<3 학생은 미등재(평가부족 분류).
//       오답 3회(att>=3, not_reached) 학생만 결손 목록에 등재.
//       (/warnings 의 결손 쿼리 WHERE 절을 직접 재현)
// ──────────────────────────────────────────────────────────────────────────
test('RT-5: 정답만 푼 att<3 학생 → /warnings 결손 미등재 (오탐 해소), 오답 att>=3 학생만 등재', () => {
  const mapped = pickMappedNode();
  const noMap = pickNoMapContent();
  const code = mapped.achievement_code;
  const studs = pickStudents(2);
  assert.ok(studs.length >= 2, '서로 다른 student 2명 필요');
  const [okUser, badUser] = studs;   // okUser: 정답 2회→평가부족, badUser: 오답 3회→미도달
  resetStat(okUser, code);
  resetStat(badUser, code);

  selfLearn.recordProblemAttempt(okUser, noMap.id, { isCorrect: true, nodeId: mapped.node_id });
  selfLearn.recordProblemAttempt(okUser, noMap.id, { isCorrect: true, nodeId: mapped.node_id });
  for (let i = 0; i < 3; i++) selfLearn.recordProblemAttempt(badUser, noMap.id, { isCorrect: false, nodeId: mapped.node_id });

  // /warnings 결손 쿼리 WHERE 절 재현 (routes/lrs.js L1295)
  const weak = db.prepare(`
    SELECT user_id FROM lrs_achievement_stats
    WHERE user_id IN (?, ?) AND achievement_code = ?
      AND (last_level IN ('하', '미도달') OR level = 'not_reached')
  `).all(okUser, badUser, code).map(r => r.user_id);

  assert.ok(!weak.includes(okUser), '정답만 푼 att<3 학생(평가부족)은 결손 목록에 없어야 (오탐 해소)');
  assert.ok(weak.includes(badUser), '오답 3회(미도달) 학생은 결손 목록에 있어야');

  resetStat(okUser, code);
  resetStat(badUser, code);
});
