// test/daily-complete-upsert.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [결함 #2] 오늘의 학습 이수 미저장 (REAL·최우선)
//   근본원인: completeDailyItem 이 bare UPDATE(진행행 없으면 0행 갱신)인데도
//     포인트 지급·learning_logs·xAPI 실행하고 200 반환.
//     → /start 없이(또는 start 가 조용히 실패) complete 하면
//        포인트는 지급되는데 daily_learning_progress 행은 없음 = 스트릭·통계 오염.
//   수정: complete 를 UPSERT 로. 진행행 없으면 생성 후 completed 처리.
//         포인트·로그·xAPI 는 "미완료→완료 전이" 시에만 1회(멱등).
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입.
//   (복사본이라 INSERT 자유, 실 DB 무오염.)
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                       // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema(); // 격리 DB 스키마 보강
const sl = require('../db/self-learn-extended');
const db = openTestDb();

const S1 = 3; // student1 (실 DB 확정)
const TEACHER = 2;

// 테스트용 daily_learning_set + item 시드 (먼 미래 날짜 — 실 데이터 무간섭).
//   quiz 형(채점형) 콘텐츠가 아니어도 score 기록 경로는 normalizeProgressScore 가 처리.
//   여기서는 content_id 없는 순수 항목으로 시드(가장 단순 경로) — score 도 정상 기록되어야 함.
function seedDailyItem(title) {
  const setIns = db.prepare(`
    INSERT INTO daily_learning_sets (teacher_id, title, target_date, is_active)
    VALUES (?, ?, ?, 1)
  `).run(TEACHER, '이수저장 회귀세트', '2099-12-01');
  const setId = setIns.lastInsertRowid;
  const itemIns = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, item_title, sort_order)
    VALUES (?, 'internal', ?, 0)
  `).run(setId, title);
  return { setId, itemId: itemIns.lastInsertRowid };
}

function progressRows(userId, itemId) {
  return db.prepare(
    'SELECT * FROM daily_learning_progress WHERE user_id=? AND item_id=?'
  ).all(userId, itemId);
}
function pointRows(userId, itemId) {
  return db.prepare(
    "SELECT * FROM user_points WHERE user_id=? AND source='daily_learning' AND source_id=?"
  ).all(userId, itemId);
}

// ──────────────────────────────────────────────────────────────────────────
// (a) start 없이 complete → completed 행 생성 + 포인트 1회 지급 (점수 기록 정상)
// ──────────────────────────────────────────────────────────────────────────
test('DAILY-UPSERT-a: start 없이 complete → completed 행 생성 + 포인트 1회', () => {
  const { itemId } = seedDailyItem('start없이완료');

  // 사전: 진행행/포인트 0
  assert.equal(progressRows(S1, itemId).length, 0, '사전 진행행 0이어야');
  assert.equal(pointRows(S1, itemId).length, 0, '사전 포인트행 0이어야');

  const r = sl.completeDailyItem(itemId, S1, { score: 80, timeSpent: 42 });
  assert.ok(r && r.success, 'complete 성공 반환');

  const prog = progressRows(S1, itemId);
  assert.equal(prog.length, 1, 'completed 진행행이 1개 생성되어야 (RED: bare UPDATE 면 0)');
  assert.equal(prog[0].status, 'completed', 'status=completed');
  assert.ok(prog[0].completed_at, 'completed_at 기록');
  assert.equal(prog[0].score, 80, '점수 정상 기록');
  assert.equal(prog[0].time_spent_seconds, 42, '시간 정상 기록');

  assert.equal(pointRows(S1, itemId).length, 1, '포인트 1회 지급');
});

// ──────────────────────────────────────────────────────────────────────────
// (b) 같은 item 재complete → 행 1개·포인트 중복 없음 (멱등)
// ──────────────────────────────────────────────────────────────────────────
test('DAILY-UPSERT-b: 재complete 멱등 — 행 1개·포인트 중복 없음', () => {
  const { itemId } = seedDailyItem('재완료멱등');

  sl.completeDailyItem(itemId, S1, { score: 70, timeSpent: 10 });
  const r2 = sl.completeDailyItem(itemId, S1, { score: 90, timeSpent: 99 });
  assert.ok(r2 && r2.alreadyCompleted, '두 번째 complete 는 alreadyCompleted');

  assert.equal(progressRows(S1, itemId).length, 1, '진행행은 여전히 1개(중복 없음)');
  assert.equal(pointRows(S1, itemId).length, 1, '포인트 중복 지급 안 됨(멱등)');
});

// ──────────────────────────────────────────────────────────────────────────
// (c) 정상 start → complete 회귀 (기존 흐름 유지)
// ──────────────────────────────────────────────────────────────────────────
test('DAILY-UPSERT-c: 정상 start→complete 회귀 — 행 1개·포인트 1회·completed', () => {
  const { itemId } = seedDailyItem('정상흐름');

  const rs = sl.startDailyItem(itemId, S1);
  assert.ok(rs && rs.success, 'start 성공');
  // start 직후엔 in_progress, 포인트 0
  const after = progressRows(S1, itemId);
  assert.equal(after.length, 1, 'start 로 진행행 1개');
  assert.equal(after[0].status, 'in_progress', 'start 후 in_progress');
  assert.equal(pointRows(S1, itemId).length, 0, 'start 만으로 포인트 0');

  const rc = sl.completeDailyItem(itemId, S1, { score: 100, timeSpent: 30 });
  assert.ok(rc && rc.success, 'complete 성공');

  const fin = progressRows(S1, itemId);
  assert.equal(fin.length, 1, '진행행 1개 유지');
  assert.equal(fin[0].status, 'completed', 'completed 전이');
  assert.equal(fin[0].score, 100, '점수 기록');
  assert.equal(pointRows(S1, itemId).length, 1, '완료 시 포인트 1회');
});
