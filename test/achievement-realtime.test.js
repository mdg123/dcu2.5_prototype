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
// (user, code) 누적 격리: 그 학생의 해당 코드 집계행 + 관련 로그를 함께 제거.
//
// ★ [W2-a] 로그 삭제가 **필수**가 됐다.
//   과거 realtime 은 집계행을 증분(attempt+1)으로 쌓았으므로, 집계행만 지우면 0부터 다시 셌다.
//   이제 realtime 은 재집계와 동일하게 **learning_logs 에서 재계산**한다
//   (그래야 두 경로가 갈라지지 않는다). 즉 집계값은 로그의 순수 함수이므로
//   집계행만 지워도 다음 기록 때 과거 로그가 되살아난다 — 그게 정상 동작이다.
//   따라서 이 헬퍼는 원래 주석이 명시했던 대로 로그까지 지워야 진짜 격리가 된다.
function resetStat(userId, code) {
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?').run(userId, code);
  db.prepare('DELETE FROM learning_logs WHERE user_id = ? AND achievement_code = ?').run(userId, code);
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

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-11  [감리 R3] 채점된 과제는 성취 집계에 **반드시** 기여한다.
//
//   구조적 결함이었다: 성취 1시도의 정본 술어는 ①achievement_code ②채점형 유형 ③result_success
//   셋을 모두 요구하는데, 과제가 남기는 두 로그가 각각 한 조건씩 놓쳤다.
//     · homework_submit — ①② 만족, 채점 전이라 ③ NULL
//     · homework_graded — ③ 보유, 그러나 SCORED_TYPES 에서 제외(②)
//   ⇒ 어느 쪽도 시도로 세어지지 않아 **채점해도 성취가 0** 이었다.
//   fix: 채점 시 학생의 제출 로그에 판정을 채운다(routes/homework.js applyGradeToSubmitLog).
//
//   ★ [재감리 2026-07-31] 이 검사는 반드시 **채점 라우트를 실제로 태워야** 한다.
//     이전 판은 헬퍼(applyGradeToSubmitLog)를 직접 호출해, 정작 R3 의 핵심인 "라우트가 그 헬퍼를
//     부르는 배선 1줄"이 무방비였다. 그 상태로 주석만 "호출을 지우면 빨간불"이라 단언한 것은
//     R3 에서 고친 것과 같은 종류의 허위 주석이었다. → HTTP 통합 검사로 바꾼다.
//   역주입 확인(2026-07-31): routes/homework.js 의 applyGradeToSubmitLog 호출 1줄을 제거하면
//     '채점 후 1건' 이 0건이 되어 실제로 빨간불이 뜨는 것을 실행으로 확인했다.
// ──────────────────────────────────────────────────────────────────────────
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const { masteryAttemptWhere } = require('../lib/lrs/mastery-population');

// 채점 라우트를 실제로 태우는 최소 HTTP 하네스(lrs-*.test.js 와 동일 패턴).
function startHomeworkServer() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-inv-w2b-11', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/homework', require('../routes/homework'));
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}
function post(port, path, userId, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const r = http.request({ port, path, method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      'x-test-user': String(userId) } },
      (res) => { let b = ''; res.on('data', c => b += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j }); }); });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.write(data); r.end();
  });
}

test('INV-W2B-11: /grade/ 라우트 통합 — 제출은 성취 시도 0 · 채점되면 성취 시도 1(판정·점수 반영)', async () => {
  // owner 교사 + member 학생이 같이 있는 실제 클래스(라우트가 requireClassMember·owner 를 본다)
  const cls = db.prepare(`
    SELECT cm.class_id AS classId, cm.user_id AS ownerId FROM class_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.role = 'owner' AND u.role = 'teacher' LIMIT 1`).get();
  assert.ok(cls, '전제: owner 교사가 있는 클래스 필요');
  const stu = db.prepare(`
    SELECT cm.user_id AS id FROM class_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.class_id = ? AND u.role = 'student' LIMIT 1`).get(cls.classId);
  assert.ok(stu, '전제: 해당 클래스에 학생 멤버 필요');

  const code = '[4수01-09]';
  // achievement_code 가 붙은 과제를 실제 테이블에 만든다(라우트가 hw 에서 코드를 읽는다).
  const hwId = db.prepare(`
    INSERT INTO homework (class_id, teacher_id, title, content, achievement_code, subject_code, max_score, due_date)
    VALUES (?,?,?,?,?,?,100,DATE('now','+7 day'))`)
    .run(cls.classId, cls.ownerId, 'INV-W2B-11 과제', '본문', code, 'math-e').lastInsertRowid;

  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').run(stu.id, code);

  const isAttempt = () => db.prepare(
    `SELECT COUNT(*) n FROM learning_logs WHERE ${masteryAttemptWhere('')} AND user_id=? AND achievement_code=? AND target_id=?`
  ).get(stu.id, code, String(hwId)).n;

  const { srv, port } = await startHomeworkServer();
  try {
    // 1) 학생 제출 — 채점 전이므로 판정 없음(result_success NULL) → 시도 아님
    const sub = await post(port, `/api/homework/${cls.classId}/${hwId}/submit`, stu.id, { content: '제출 내용' });
    assert.equal(sub.status, 200, `제출 200 (got ${sub.status})`);
    assert.equal(isAttempt(), 0, '제출만으로는 성취 시도가 아니다(판정 없음)');

    // 2) 교사 채점 — **라우트가** 제출 로그에 판정을 확정해야 한다(배선 포함 검증)
    const subRow = db.prepare('SELECT id FROM homework_submissions WHERE homework_id=? AND student_id=?').get(hwId, stu.id);
    assert.ok(subRow, '제출 행이 있어야 한다');
    const gr = await post(port, `/api/homework/${cls.classId}/${hwId}/grade/${subRow.id}`, cls.ownerId, { score: 85, feedback: '잘했어요' });
    assert.equal(gr.status, 200, `채점 200 (got ${gr.status})`);

    assert.equal(isAttempt(), 1,
      '채점된 과제가 성취 시도로 안 세어진다 — /grade/ 라우트가 applyGradeToSubmitLog 를 호출하는 배선이 끊겼다');

    const row = db.prepare('SELECT attempt_count, success_count, avg_score FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').get(stu.id, code);
    assert.ok(row, '채점 후 lrs_achievement_stats 행이 있어야 한다');
    assert.equal(row.attempt_count, 1, '시도 1');
    assert.equal(row.success_count, 1, '85점 → 합격 1');
    assert.equal(row.avg_score, 85, '점수는 0~100 정규화(0.85 → 85)로 저장돼야 한다');
  } finally {
    await new Promise(res => srv.close(res));
    db.prepare(`DELETE FROM learning_logs WHERE user_id=? AND target_id=?`).run(stu.id, String(hwId));
    db.prepare('DELETE FROM homework_submissions WHERE homework_id=?').run(hwId);
    db.prepare('DELETE FROM homework WHERE id=?').run(hwId);
    db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').run(stu.id, code);
  }
});
