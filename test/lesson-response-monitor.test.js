// test/lesson-response-monitor.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 수업꾸러미 "응답 현황" 모니터 — 불변식 박제 (기획서 §12-F INV-M1~M7 + SSOT + 룸 격리)
//
// ■ 이 표에는 **다른 학생의 실명과 문항별 정오답**이 들어 있다.
//   그것이 학생에게 새는 것이 이 기능 최대 위험이다. INV-M6(REST) 와 INV-M-ROOM(소켓)이
//   그 두 출구를 각각 지킨다. 특히 소켓은 기존 `lesson:${lid}` 룸에 **학생이 들어 있어서**,
//   거기로 한 줄만 잘못 emit 해도 학생 브라우저에 전부 도착한다.
//
// ■ 픽스처는 전부 **격리 복사본**에 직접 심는다(정본 무오염 + 정본 데이터 표류와 무관하게 결정적).
//   실 DB 의 lesson 79 같은 것에 기대면 그 수업이 편집되는 순간 테스트가 잠들거나 깨진다.
//
// ■ ⚠ 단언을 조건문 안에 가두지 않는다.
//   이 프로젝트에서 5회 이상 재발했다 — 픽스처가 조건을 못 만족해 단언이 몇 달간 한 번도
//   실행되지 않았다. 모든 루프 앞에 `assert.ok(목록.length > 0)` 를 먼저 둔다.
//
// ■ ⚠ "안 붉어졌다" 를 안전 근거로 쓰지 않는다(감지력 0 과 구별되지 않는다).
//   INV-M5 / M7 / SSOT / ROOM 은 각각 **역주입**(조건을 실제로 심어 붉어지는 것 확인)을 함께 둔다.
//
// 불변식
//   INV-M1  students.length === classDb.getClassStudentCount(classId)   (분모 SSOT)
//   INV-M2  모든 accuracy 0~100 · accuracy_base >= 0
//   INV-M3  accuracy_base === correct + wrong                            (라벨↔집계 일치)
//   INV-M4  모든 students[].cells.length === questions.length            (희소 배열 금지)
//   INV-M5  summary.class_accuracy = 전체 correct/(correct+wrong)        (학생별 평균이 아님)
//   INV-M6  타 클래스 lessonId → 404 · 학생 세션 → 403 · 타 교사 → 403 · admin → 200
//   INV-M7  lesson_id IS NULL 기록이 include_outside=0 응답에 미혼입
//   INV-M-SSOT  /grade 와 모니터가 **같은 판정**을 낸다 (lib/grade-answer.js 한 벌)
//   INV-M-ROOM  🔴 lesson:monitor:* 가 학생 소켓에 **한 건도** 도착하지 않는다
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터·db 모듈 require 전에 DB_PATH 주입
// 복사본에 스키마를 세운다 — 서버가 부팅 때 하는 것과 **같은 함수**(멱등).
//   content_attempts 의 lesson_id·class_id·answers_detail 은 마이그레이션으로 붙으므로,
//   여기서 initSchema 를 부르지 않으면 정본 DB 에 아직 컬럼이 없는 시점에 테스트가 못 돈다.
//   테스트가 ALTER 를 따로 적으면 마이그레이션 사본이 되므로 SSOT 를 그대로 호출한다.
require('../db/schema').initSchema();
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const db = openTestDb();
const classDb = require('../db/class');
const { buildResponseMonitor } = require('../db/lesson-monitor');

const SUF = '_RM_' + process.pid;
let server, baseUrl, io, sessionMiddleware;

// ── 계정 ─────────────────────────────────────────────────────────────────────
function uidOf(username) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r.id;
}
const T1 = uidOf('teacher1');
const AD = uidOf('admin');

function mkUser(name, role) {
  return db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, ?)"
  ).run(name + SUF, name, role).lastInsertRowid;
}
const S_A = mkUser('가학생', 'student');
const S_B = mkUser('나학생', 'student');
const S_C = mkUser('다학생', 'student');
const T_OTHER = mkUser('남선생', 'teacher');   // 클래스 멤버인 **다른** 교사 → 403 이어야 한다

// ── 콘텐츠 ───────────────────────────────────────────────────────────────────
function mkContent(title, type) {
  return db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
    VALUES (?, ?, '응답현황 회귀 픽스처', ?, 0, 'approved', datetime('now'))
  `).run(T1, title + SUF, type).lastInsertRowid;
}
function mkQuestion(cid, n, text, type, options, answer, points) {
  return db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
    VALUES (?, ?, ?, ?, ?, ?, '해설', ?)
  `).run(cid, n, text, type, JSON.stringify(options), answer, points).lastInsertRowid;
}

// 아이템 0 — 객관식 2 + 서술형 1  (cols 1,2,3)
const C_QUIZ1 = mkContent('직각 찾기', 'quiz');
const Q1 = mkQuestion(C_QUIZ1, 1, '직사각형에서 직각은 몇 개인가요?', 'multiple_choice', ['3개', '1개', '4개', '2개'], '2', 1);
const Q2 = mkQuestion(C_QUIZ1, 2, '삼각형의 변은 몇 개인가요?', 'multiple_choice', ['2개', '3개', '4개'], '1', 1);
const Q3 = mkQuestion(C_QUIZ1, 3, '직각을 설명해 보세요.', 'essay', [], '', 5);
// 아이템 1 — 영상 (열 없음)
const C_VIDEO = mkContent('직각 영상', 'video');
// 아이템 2 — 레거시 quiz (문항 0건) → no_record_items
const C_LEGACY = mkContent('옛날 퀴즈', 'quiz');
// 아이템 3 — 객관식 1 + 단답 1 (cols 4,5)
const C_QUIZ2 = mkContent('받아쓰기', 'quiz');
const Q4 = mkQuestion(C_QUIZ2, 1, '가장 큰 수는?', 'multiple_choice', ['1', '2', '3'], '2', 1);
const Q5 = mkQuestion(C_QUIZ2, 2, '7 × 8 = ?', 'short_answer', [], '56', 1);

// ── 클래스·수업 ──────────────────────────────────────────────────────────────
function mkClass(name, ownerId, members) {
  const cid = db.prepare(
    "INSERT INTO classes (code, name, owner_id, status) VALUES (?, ?, ?, 'active')"
  ).run('RM' + process.pid + '_' + name, name + SUF, ownerId).lastInsertRowid;
  const ins = db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, 'active')");
  for (const [uid, role] of members) ins.run(cid, uid, role);
  return cid;
}
// 학생 3명 + 개설자 + 다른 교사(멤버). getClassStudents 는 학생 3명만 뽑아야 한다.
const CLS = mkClass('응답현황반', T1, [[T1, 'owner'], [S_A, 'member'], [S_B, 'member'], [S_C, 'member'], [T_OTHER, 'member']]);
const CLS_OTHER = mkClass('남의반', AD, [[AD, 'owner']]);

function mkLesson(classId, teacherId, title) {
  return db.prepare(
    "INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, ?, 'published')"
  ).run(classId, teacherId, title + SUF).lastInsertRowid;
}
const LSN = mkLesson(CLS, T1, '응답현황 수업');
const LSN_OTHER = mkLesson(CLS_OTHER, AD, '남의 수업');

const linkStmt = db.prepare('INSERT INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?, ?, ?)');
[C_QUIZ1, C_VIDEO, C_LEGACY, C_QUIZ2].forEach((cid, i) => linkStmt.run(LSN, cid, i));

// ── 응답 (content_attempts) ──────────────────────────────────────────────────
function mkAttempt({ contentId, userId, lessonId, detail, ordered, at }) {
  return db.prepare(`
    INSERT INTO content_attempts (content_id, user_id, total_questions, correct_count, score_percent, answers, answers_detail, lesson_id, class_id, attempted_at)
    VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
  `).run(
    contentId, userId,
    ordered ? JSON.stringify(ordered) : null,
    detail ? JSON.stringify(detail) : null,
    lessonId, lessonId ? CLS : null,
    at || '2026-08-21 01:00:00'
  ).lastInsertRowid;
}

// 가학생 — 수업 중 제출. Q1 정답('2') · Q2 오답('0') · Q3 서술형(작성 → 채점 대기)
mkAttempt({ contentId: C_QUIZ1, userId: S_A, lessonId: LSN,
  detail: [{ questionId: Q1, value: '2' }, { questionId: Q2, value: '0' }, { questionId: Q3, value: '직각은 90도' }] });
// 가학생 — 아이템 3 도 제출. Q4 정답('2') · Q5 미응답(null)
mkAttempt({ contentId: C_QUIZ2, userId: S_A, lessonId: LSN,
  detail: [{ questionId: Q4, value: '2' }, { questionId: Q5, value: null }] });

// 나학생 — 🔴 **수업 밖**(lesson_id NULL) 기록만 있다. include_outside=0 에 섞이면 INV-M7 붕괴.
mkAttempt({ contentId: C_QUIZ1, userId: S_B, lessonId: null,
  detail: [{ questionId: Q1, value: '2' }, { questionId: Q2, value: '1' }, { questionId: Q3, value: '설명' }] });

// 다학생 — 수업 중 제출인데 **레거시 순서 배열**(answers_detail 없음). 하위호환 확인용.
//   순서: [Q1, Q2, Q3] → Q1 오답('0') · Q2 정답('1') · Q3 미응답(null)
mkAttempt({ contentId: C_QUIZ1, userId: S_C, lessonId: LSN, ordered: ['0', '1', null] });

// ── 앱 ───────────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  sessionMiddleware = session({ secret: 'rm-test-secret', resave: false, saveUninitialized: false });
  app.use(sessionMiddleware);
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/lesson', require('../routes/lesson'));
  app.use('/api/contents', require('../routes/content'));
  return app;
}

function call(method, p, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(baseUrl + p, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const MON = (cid, lid, inc) => `/api/lesson/${cid}/${lid}/response-monitor?include_outside=${inc ? 1 : 0}`;

before(async () => {
  server = http.createServer(buildApp());
  io = new Server(server);
  io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
  require('../socket')(io);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  try { io && io.close(); } catch (_) {}
  await new Promise((r) => (server ? server.close(r) : r()));
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M1 — 명단 분모 SSOT
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M1: students.length === getClassStudentCount(classId) — 개설자·타 교사는 명단에서 빠진다', async () => {
  const r = await call('GET', MON(CLS, LSN, 0), T1);
  assert.equal(r.status, 200, `교사(개설자)는 200 이어야 한다: ${r.raw.slice(0, 200)}`);
  const snap = r.json;
  const ssot = classDb.getClassStudentCount(CLS);
  assert.equal(ssot, 3, '픽스처 전제: 이 클래스의 학생 모집단은 3명(개설자·타 교사 제외)');
  assert.equal(snap.students.length, ssot,
    `분모가 갈렸다. 명단은 classDb.getClassStudents() 한 곳에서만 나와야 한다.`);
  assert.equal(snap.summary.student_total, ssot);
  // 교사 계정이 학생 행에 섞이지 않았는지 직접 확인 (개수만 맞고 구성이 틀린 경우 차단)
  const ids = snap.students.map((s) => s.user_id).sort();
  assert.deepStrictEqual(ids, [S_A, S_B, S_C].sort(), '학생 행은 학생 모집단과 정확히 같아야 한다');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M2 · M3 · M4 — 수치 범위 / 라벨↔집계 / 희소 배열 금지
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M2/M3/M4: accuracy 범위 · accuracy_base=correct+wrong · cells 전량 채움', async () => {
  const r = await call('GET', MON(CLS, LSN, 0), T1);
  const snap = r.json;

  // 🔴 루프 앞 가드 — 픽스처가 비면 아래 단언이 한 번도 실행되지 않는다
  assert.ok(snap.questions.length > 0, `검사할 문항이 있어야 한다 (현재 ${snap.questions.length})`);
  assert.equal(snap.questions.length, 5, '픽스처 전제: 열은 5개(객관식3·서술1·단답1, 영상·레거시는 열 없음)');
  assert.ok(snap.students.length > 0, '검사할 학생이 있어야 한다');

  for (const q of snap.questions) {
    assert.ok(q.accuracy >= 0 && q.accuracy <= 100, `INV-M2 위반 col=${q.col} accuracy=${q.accuracy}`);
    assert.ok(q.accuracy_base >= 0, `INV-M2 위반 col=${q.col} base=${q.accuracy_base}`);
    assert.equal(q.accuracy_base, q.correct + q.wrong,
      `INV-M3 위반 col=${q.col}: base=${q.accuracy_base} ≠ correct(${q.correct})+wrong(${q.wrong})`);
    // 표기와 산식이 어긋나지 않는지(화면이 correct/base 를 그대로 병기한다)
    const expect = q.accuracy_base > 0 ? Math.round((q.correct / q.accuracy_base) * 100) : 0;
    assert.equal(q.accuracy, expect, `col=${q.col} 정답률이 correct/base 와 다르다`);
  }
  for (const st of snap.students) {
    assert.equal(st.cells.length, snap.questions.length,
      `INV-M4 위반 ${st.display_name}: cells ${st.cells.length} ≠ questions ${snap.questions.length}`);
    // 열 번호까지 1:1 대응해야 FE 가 인덱스 계산을 하지 않는다
    assert.deepStrictEqual(st.cells.map((c) => c.col), snap.questions.map((q) => q.col));
    assert.equal(st.graded_count, st.correct_count + st.wrong_count, `학생 점수 분모도 correct+wrong 이어야 한다`);
  }
});

test('INV-M4 역주입: 응답이 하나도 없는 학생도 cells 가 문항 수만큼 채워진다(state=none)', async () => {
  const r = await call('GET', MON(CLS, LSN, 0), T1);
  const snap = r.json;
  const nb = snap.students.find((s) => s.user_id === S_B);   // 수업 밖 기록만 있는 학생
  assert.ok(nb, '나학생 행이 있어야 한다');
  assert.equal(nb.cells.length, snap.questions.length, '미제출 학생도 희소 배열이면 안 된다');
  assert.ok(nb.cells.every((c) => c.state === 'none'),
    `미제출 학생 셀은 전부 'none' 이어야 한다: ${JSON.stringify(nb.cells.map((c) => c.state))}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M5 — 반 평균은 "전체 정답/(정답+오답)" 이지 학생별 %의 평균이 아니다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M5: class_accuracy = 전체 correct/(correct+wrong) — 학생별 평균과 구별된다', async () => {
  const r = await call('GET', MON(CLS, LSN, 0), T1);
  const snap = r.json;

  let c = 0, w = 0;
  assert.ok(snap.students.length > 0, '학생이 있어야 한다');
  for (const st of snap.students) {
    for (const cell of st.cells) {
      if (cell.state === 'correct') c += 1;
      else if (cell.state === 'wrong') w += 1;
    }
  }
  const overall = (c + w) > 0 ? Math.round((c / (c + w)) * 100) : 0;
  assert.equal(snap.summary.class_accuracy_base, c + w, 'class_accuracy_base 는 전체 채점 문항 수');
  assert.equal(snap.summary.class_accuracy, overall, 'INV-M5 위반: 전체 합산 산식과 다르다');

  // 🔴 역주입 — 두 산식이 이 픽스처에서 **실제로 다른 값**임을 못 박는다.
  //    같은 값이면 "학생별 평균으로 바꿔도 안 붉어지는" 감지력 0 상태다.
  const submitters = snap.students.filter((s) => s.graded_count > 0);
  assert.ok(submitters.length >= 2, '제출자가 2명 이상이어야 두 산식이 갈릴 수 있다');
  const meanOfStudents = Math.round(
    submitters.reduce((a, s) => a + s.score_percent, 0) / submitters.length
  );
  assert.notEqual(overall, meanOfStudents,
    `픽스처가 두 산식을 구별하지 못한다(둘 다 ${overall}%). ` +
    '이 상태면 class_accuracy 를 학생별 평균으로 바꿔도 테스트가 통과한다 — 픽스처를 고칠 것.');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M6 — 권한. 🔴 학생에게는 어떤 경로로도 노출 금지
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M6: 학생 403 · 타 교사 403 · 타 클래스 lessonId 404 · 개설자/admin 200', async () => {
  const cases = [
    ['학생(가)', S_A, MON(CLS, LSN, 0), 403],
    ['학생(나)', S_B, MON(CLS, LSN, 0), 403],
    ['클래스 멤버인 다른 교사', T_OTHER, MON(CLS, LSN, 0), 403],
    ['비멤버(비로그인 아님)', AD, MON(CLS, LSN, 0), 200],     // admin 은 허용
    ['개설자', T1, MON(CLS, LSN, 0), 200],
    ['타 클래스 lessonId 끼워넣기', T1, MON(CLS, LSN_OTHER, 0), 404],
  ];
  assert.ok(cases.length > 0);
  for (const [label, uid, path, expect] of cases) {
    const r = await call('GET', path, uid);
    assert.equal(r.status, expect, `${label}: ${expect} 이어야 하는데 ${r.status} (${r.raw.slice(0, 160)})`);
  }
  // 403 응답에 학생 실명·정오답이 한 조각도 섞이지 않아야 한다
  const denied = await call('GET', MON(CLS, LSN, 0), S_A);
  assert.equal(denied.json.students, undefined, '거부 응답에 students 가 있으면 안 된다');
  assert.ok(!denied.raw.includes('가학생'), '거부 응답에 학생 실명이 새면 안 된다');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M7 — 수업 밖(lesson_id IS NULL) 기록 미혼입
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M7: lesson_id IS NULL 기록이 include_outside=0 에 섞이지 않는다 (토글하면 나타난다)', async () => {
  const off = (await call('GET', MON(CLS, LSN, 0), T1)).json;
  const on = (await call('GET', MON(CLS, LSN, 1), T1)).json;

  const nbOff = off.students.find((s) => s.user_id === S_B);
  const nbOn = on.students.find((s) => s.user_id === S_B);
  assert.ok(nbOff && nbOn, '나학생 행이 양쪽에 있어야 한다');

  assert.equal(nbOff.submitted_items, 0,
    '🔴 INV-M7 위반: 수업 밖(lesson_id NULL) 기록이 기본 응답에 섞였다. ' +
    '이러면 3주 전 개인 풀이가 오늘 수업 표에 찍힌다.');
  assert.equal(nbOff.graded_count, 0);

  // 🔴 역주입 — 토글을 켜면 **실제로 나타나야** 한다. 안 나타나면 필터가 아니라 데이터가 없는 것이고
  //    그건 INV-M7 이 항상 통과하는(감지력 0) 상태다.
  assert.ok(nbOn.submitted_items > 0,
    'include_outside=1 인데도 수업 밖 기록이 안 보인다 — 픽스처나 쿼리가 죽어 있다(감지력 0).');
  assert.ok(nbOn.graded_count > 0, 'include_outside=1 이면 채점된 셀이 생겨야 한다');
  assert.notEqual(off.summary.class_accuracy_base, on.summary.class_accuracy_base,
    '토글로 집계가 바뀌지 않으면 include_outside 가 실제로 아무 일도 안 하고 있는 것이다');
});

// ══════════════════════════════════════════════════════════════════════════════
// 레거시 순서 배열 하위호환 (BE-3)
// ══════════════════════════════════════════════════════════════════════════════
test('BE-3: answers_detail 이 없는 레거시 순서 배열도 그대로 읽힌다', async () => {
  const snap = (await call('GET', MON(CLS, LSN, 0), T1)).json;
  const st = snap.students.find((s) => s.user_id === S_C);
  assert.ok(st, '다학생 행이 있어야 한다');
  const byCol = new Map(st.cells.map((c) => [c.col, c]));
  const q1 = snap.questions.find((q) => q.question_id === Q1);
  const q2 = snap.questions.find((q) => q.question_id === Q2);
  const q3 = snap.questions.find((q) => q.question_id === Q3);
  assert.ok(q1 && q2 && q3, '픽스처 문항이 열로 잡혀야 한다');
  assert.equal(byCol.get(q1.col).state, 'wrong', '순서 배열 0번 값(0) → Q1 오답');
  assert.equal(byCol.get(q2.col).state, 'correct', '순서 배열 1번 값(1) → Q2 정답');
  assert.equal(byCol.get(q3.col).state, 'unanswered', '순서 배열 2번 값(null) → Q3 미응답');
});

test('구조 계약: 비문항 아이템은 열을 만들지 않고, 레거시 무기록 아이템은 사유가 밝혀진다', async () => {
  const snap = (await call('GET', MON(CLS, LSN, 0), T1)).json;
  assert.equal(snap.items.length, 4, '아이템 4개(퀴즈·영상·레거시퀴즈·퀴즈)');
  const video = snap.items[1];
  assert.equal(video.gradable, false, '영상은 열을 만들지 않는다');
  assert.deepStrictEqual(video.cols, []);
  assert.deepStrictEqual(snap.summary.no_record_items, [2],
    '문항 0건인 레거시 quiz 아이템은 no_record_items 로 사유가 밝혀져야 한다(FE 가 주황 띠로 안내)');
  // FE 계약 5 — 서술형 정답 라벨은 null
  const essay = snap.questions.find((q) => q.question_id === Q3);
  assert.equal(essay.question_type, 'essay');
  assert.equal(essay.answer_label, null, '서술형 answer_label 은 null 이어야 한다(FE 계약)');
  assert.deepStrictEqual(essay.distribution, [], '서술형은 보기 분포가 없다(FE 가 텍스트 목록으로 분기)');
  // 서술형은 채점 대기 → 정답률 분모에 들어가지 않는다
  assert.equal(essay.accuracy_base, 0, '서술형은 correct/wrong 이 0 이라 분모도 0');
  assert.ok(essay.pending >= 1, '서술형에 작성한 학생은 채점 대기로 잡혀야 한다');
});

test('빈 상태: 문항 0개 수업도 500 이 아니라 200 + 빈 배열', async () => {
  const emptyLesson = mkLesson(CLS, T1, '빈 수업');
  const r = await call('GET', MON(CLS, emptyLesson, 0), T1);
  assert.equal(r.status, 200, `빈 수업도 200 이어야 한다: ${r.raw.slice(0, 200)}`);
  assert.deepStrictEqual(r.json.questions, []);
  assert.deepStrictEqual(r.json.items, []);
  assert.equal(r.json.students.length, classDb.getClassStudentCount(CLS), '문항이 없어도 명단은 나온다');
  assert.equal(r.json.summary.class_accuracy_base, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M-SSOT — /grade 와 모니터가 같은 판정을 낸다 (판정 사본 금지)
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M-SSOT: /grade 결과와 모니터 셀 상태가 문항 단위로 일치한다', async () => {
  const answers = [
    { questionId: Q1, value: '2' },   // 정답
    { questionId: Q2, value: '0' },   // 오답
    { questionId: Q3, value: '직각은 90도' },   // 서술형 → 채점 보류
  ];
  const gr = await call('POST', `/api/contents/${C_QUIZ1}/grade`, S_A, { answers });
  assert.equal(gr.status, 200, `채점이 200 이어야 한다: ${gr.raw.slice(0, 200)}`);
  const verdict = new Map(gr.json.results.map((r) => [Number(r.questionId), r.correct]));

  const snap = (await call('GET', MON(CLS, LSN, 0), T1)).json;
  const st = snap.students.find((s) => s.user_id === S_A);
  const byQid = new Map();
  for (const q of snap.questions) {
    const cell = st.cells.find((c) => c.col === q.col);
    byQid.set(q.question_id, cell.state);
  }

  const pairs = [Q1, Q2, Q3].map((qid) => [qid, verdict.get(qid), byQid.get(qid)]);
  assert.ok(pairs.length > 0, '비교할 문항이 있어야 한다');
  const STATE_OF = { true: 'correct', false: 'wrong', null: 'pending' };
  for (const [qid, graded, monitorState] of pairs) {
    assert.equal(monitorState, STATE_OF[String(graded)],
      `q${qid}: /grade 는 correct=${graded} 인데 모니터는 '${monitorState}' — 판정이 두 벌이다`);
  }
});

test('INV-M-SSOT 역주입: 정답키를 바꾸면 두 경로가 **함께** 뒤집힌다(같은 키를 읽는다는 증거)', async () => {
  const restore = db.prepare('SELECT answer FROM content_questions WHERE id = ?').get(Q1).answer;
  assert.equal(restore, '2', '픽스처 전제: Q1 정답은 0-based 인덱스 "2"');
  try {
    // Q1 정답을 '0' 으로 바꾼다 → 같은 응답('2')이 이제 오답이어야 한다.
    db.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run('0', Q1);

    const gr = await call('POST', `/api/contents/${C_QUIZ1}/grade`, S_A,
      { answers: [{ questionId: Q1, value: '2' }] });
    const flippedGrade = gr.json.results.find((r) => Number(r.questionId) === Q1).correct;
    const snap = (await call('GET', MON(CLS, LSN, 0), T1)).json;
    const q = snap.questions.find((x) => x.question_id === Q1);
    const st = snap.students.find((s) => s.user_id === S_A);
    const flippedMonitor = st.cells.find((c) => c.col === q.col).state;

    assert.equal(flippedGrade, false, '정답키를 바꿨는데 /grade 판정이 안 바뀌었다 — 감지력 0');
    assert.equal(flippedMonitor, 'wrong', '정답키를 바꿨는데 모니터 판정이 안 바뀌었다 — 판정 사본이 남아 있다');
  } finally {
    db.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run(restore, Q1);
  }
});

test('채점 계약: 객관식은 0-based 인덱스를 보정 없이 비교한다', () => {
  const { judge } = require('../lib/grade-answer');
  const q = { question_type: 'multiple_choice', answer: '0' };
  assert.equal(judge(q, '0'), true, "answer='0' 은 1-based 로는 불가능한 값 — 그대로 비교해야 한다");
  assert.equal(judge(q, 0), true, '숫자 0 도 문자열 비교로 통과');
  assert.equal(judge(q, '1'), false, '한 칸 밀어주는 보정이 있으면 여기가 붉어진다');
  assert.equal(judge({ question_type: 'essay', answer: 'x' }, '답'), null, '서술형은 자동채점 보류');
  assert.equal(judge(q, null), null, '미응답은 채점하지 않는다');
  assert.equal(judge({ question_type: 'short_answer', answer: '56' }, ' 5 6 '), true, '단답은 공백 무시');
  assert.equal(judge({ question_type: 'short_answer', answer: '' }, ''), null, '정답도 응답도 비면 미응답');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-M-ROOM — 🔴 소켓 룸 격리 (이 작업 최대 위험)
// ══════════════════════════════════════════════════════════════════════════════
test('INV-M-ROOM: lesson:monitor:* 가 학생 소켓에 한 건도 도착하지 않는다', async (t) => {
  // 세션에 userId 를 심기 위해 세션 미들웨어를 가로챈다 —
  //   connect 시 소켓 handshake 헤더의 x-test-user 를 읽어 session.userId 로 넣는다.
  io.use((socket, next) => {
    const uid = socket.handshake.query && socket.handshake.query.testUser;
    if (uid) socket.request.session.userId = parseInt(uid, 10);
    next();
  });

  function conn(uid) {
    return new Promise((resolve, reject) => {
      const s = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, query: { testUser: String(uid) } });
      const to = setTimeout(() => reject(new Error(`소켓 연결 실패 uid=${uid}`)), 5000);
      s.on('connect', () => { clearTimeout(to); resolve(s); });
      s.on('connect_error', (e) => { clearTimeout(to); reject(e); });
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const teacher = await conn(T1);
  const student = await conn(S_A);
  try {
    // 학생이 받은 **모든** 이벤트를 기록한다(필터 없이 — 무엇이 새는지 눈으로 본다)
    const studentEvents = [];
    student.onAny((name, payload) => studentEvents.push({ name, payload }));
    const teacherEvents = [];
    teacher.onAny((name, payload) => teacherEvents.push({ name, payload }));

    teacher.emit('lesson:join', { classId: CLS, lessonId: LSN });
    student.emit('lesson:join', { classId: CLS, lessonId: LSN });
    await wait(300);
    teacher.emit('lesson:monitor:join', { classId: CLS, lessonId: LSN });
    await wait(400);

    // ① 교사는 스냅샷을 받는다 (기능이 실제로 살아 있다는 확인 — 없으면 아래가 무의미)
    const snapEv = teacherEvents.find((e) => e.name === 'lesson:monitor:snapshot');
    assert.ok(snapEv, `교사가 lesson:monitor:snapshot 을 받아야 한다. 받은 것: ${teacherEvents.map((e) => e.name).join(',')}`);
    assert.ok(snapEv.payload.students.length === 3, '스냅샷에 학생 3명이 들어 있어야 한다');

    // ② 학생이 monitor 룸에 직접 들어가려 해도 막힌다
    studentEvents.length = 0;
    student.emit('lesson:monitor:join', { classId: CLS, lessonId: LSN });
    await wait(400);
    assert.ok(
      !studentEvents.some((e) => e.name === 'lesson:monitor:snapshot'),
      `🔴 학생이 monitor:join 으로 스냅샷을 받았다: ${JSON.stringify(studentEvents).slice(0, 300)}`
    );
    assert.ok(studentEvents.some((e) => e.name === 'lesson:error'), '학생에게는 권한 오류가 통지돼야 한다');

    // ③ 실제 트래픽을 흘린다 — 학생이 위치를 보고하면 교사에게만 가야 한다
    studentEvents.length = 0;
    teacherEvents.length = 0;
    student.emit('lesson:progress', { classId: CLS, lessonId: LSN, index: 0, kind: 'quiz' });
    await wait(400);

    assert.ok(teacherEvents.some((e) => e.name === 'lesson:monitor:position'),
      `교사가 위치 이벤트를 받아야 한다. 받은 것: ${teacherEvents.map((e) => e.name).join(',')}`);
    const leaked = studentEvents.filter((e) => String(e.name).startsWith('lesson:monitor'));
    assert.deepStrictEqual(leaked, [],
      `🔴 학생 소켓에 모니터 이벤트가 도착했다(다른 학생 실명·정오답 유출): ${JSON.stringify(leaked).slice(0, 400)}`);

    // ④ 🔴 역주입 — 기록기에 감지력이 있는지 실증한다.
    //    "학생 룸으로 잘못 emit 하는" 사고를 그대로 재현해 학생이 **정말로 받는지** 확인한다.
    //    이게 안 잡히면 위 ③ 의 통과는 감지력 0 과 구별되지 않는다.
    studentEvents.length = 0;
    io.to(`lesson:${LSN}`).emit('lesson:monitor:position', { userId: 999, index: 0, __injected: true });
    await wait(400);
    const caught = studentEvents.filter((e) => e.name === 'lesson:monitor:position');
    assert.equal(caught.length, 1,
      '역주입한 유출을 기록기가 못 잡았다 — 이 테스트는 감지력 0 이다(학생이 lesson 룸에 없거나 onAny 가 죽었다).');
    assert.equal(caught[0].payload.__injected, true);
  } finally {
    teacher.close();
    student.close();
    await wait(150);
  }
});
