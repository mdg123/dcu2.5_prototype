// test/exam-period-gate.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 감사 확정 [H] "평가 기간 게이트 전면 부재" 서버측 게이트 회귀 박제.
//
// 결함: routes/exam.js 의 POST /:classId/:examId/start 가 status∈{active,waiting}
//       만 확인하고 start_date/end_date 비교가 전혀 없어, 시작일이 미래인 평가·
//       마감(end_date) 지난 평가를 학생이 그대로 응시할 수 있었음.
//
// fix : start 라우트에서 학생(member/participant) 경로에 한해
//        - start_date 있고 오늘(KST) < start_date  → 403 "아직 시작 전"
//        - end_date   있고 오늘(KST) > end_date    → 403 "마감된 평가"
//        - 상시운영(둘 다 null)·기간 내(오늘 포함)  → 정상 200 (회귀 금지)
//       교사(owner)·admin 은 검수 응시 목적으로 게이트 예외.
//
// 날짜 비교 근거: exams.start_date/end_date 는 DATE 컬럼(schema.js). 코드베이스
//   공통 KST 규칙(homework.js·growth.js 의 date('now','+9 hours'))과 일관되게
//   KST(UTC+9) 로컬 날짜를 기준일로 비교. 값은 'YYYY-MM-DD'(또는 시각 포함)의
//   앞 10자(날짜부)만 사용.
//
// 라우트 테스트는 permission.test.js / survey-security.test.js 의
//   node:http + x-test-user 세션주입 패턴을 그대로 따른다.
// 계정(실 DB 실측): admin=1, teacher1=2(class1 owner), student1=3(class1 member).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ db 모듈 require 전에 DB_PATH 주입(복사본)

const express = require('express');
const session = require('express-session');

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3;
const CLASS = 1;

let server, baseUrl, db;
// 테스트에서 생성한 평가 id 들(복사본 안에서만 생성 — 실 DB 무오염)
let futureId, expiredId, activeInPeriodId, alwaysOnId, endsTodayId, startsTodayId;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/exam', require('../routes/exam'));
  return app;
}

// node:http 요청 헬퍼(JSON). asUser=null 이면 미인증.
function req(method, path, asUser, bodyObj) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const r = http.request(baseUrl + path, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// KST(UTC+9) 기준 오늘/오프셋 날짜 'YYYY-MM-DD' — 라우트의 kstTodayStr 와 동일 규칙.
function kstDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// active 평가 1건 생성(문항 1개 포함, start/end 지정). id 반환.
function makeExam(title, startDate, endDate) {
  const id = crypto.randomUUID();
  const answers = JSON.stringify([
    { question: title, options: ['①', '②', '③', '④'], answer: 0, type: 'multiple' },
  ]);
  db.prepare(`
    INSERT INTO exams (id, class_id, title, description, answers, question_count,
                       status, start_mode, owner_id, time_limit, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 'direct', ?, ?, ?, ?)
  `).run(id, CLASS, title, '', answers, 1, TEACHER, null, startDate, endDate);
  return id;
}

before(async () => {
  db = openTestDb();

  const tomorrow  = kstDateStr(+1);
  const yesterday = kstDateStr(-1);
  const today     = kstDateStr(0);
  const nextWeek  = kstDateStr(+7);
  const lastWeek  = kstDateStr(-7);

  // (a) 시작일 미래 → 학생 거부
  futureId        = makeExam('GATE future',   tomorrow, nextWeek);
  // (b) 마감 지남 → 학생 거부
  expiredId       = makeExam('GATE expired',  lastWeek, yesterday);
  // (c1) 기간 내(오늘 포함) → 정상
  activeInPeriodId = makeExam('GATE inperiod', lastWeek, nextWeek);
  // (c2) 상시운영(둘 다 null) → 정상 (회귀 금지)
  alwaysOnId      = makeExam('GATE alwayson', null, null);
  // (경계) 오늘이 마감일 → 통과(포함)
  endsTodayId     = makeExam('GATE endstoday', lastWeek, today);
  // (경계) 오늘이 시작일 → 통과(포함)
  startsTodayId   = makeExam('GATE startstoday', today, nextWeek);

  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// 응시 시작이 정상 참여됐는지(응시 기록 생성) 확인용
function startedCount(examId) {
  return db.prepare('SELECT COUNT(*) c FROM exam_students WHERE exam_id=?').get(examId).c;
}

// ──────────────────────────────────────────────────────────────────────────
// (a) start_date = 내일 → 학생 start 거부(403), 응시 기록 미생성
// ──────────────────────────────────────────────────────────────────────────
test('EXAM-GATE(a): 시작일 미래(내일) 평가 → 학생 start 거부(403)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${futureId}/start`, STUDENT1, {});
  assert.equal(r.status, 403, `시작 전은 403 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, false, 'success:false');
  assert.match(String(r.json && r.json.message), /시작/, '메시지에 "시작 전" 취지');
  assert.equal(startedCount(futureId), 0, '거부 시 응시 기록 미생성');
});

// ──────────────────────────────────────────────────────────────────────────
// (b) end_date = 어제 → 학생 start 거부(403), 응시 기록 미생성
// ──────────────────────────────────────────────────────────────────────────
test('EXAM-GATE(b): 마감 지난(어제) 평가 → 학생 start 거부(403)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${expiredId}/start`, STUDENT1, {});
  assert.equal(r.status, 403, `마감은 403 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, false, 'success:false');
  assert.match(String(r.json && r.json.message), /마감/, '메시지에 "마감" 취지');
  assert.equal(startedCount(expiredId), 0, '거부 시 응시 기록 미생성');
});

// ──────────────────────────────────────────────────────────────────────────
// (c) 기간 내(오늘 포함)·상시운영 → 정상 start(200), 응시 기록 생성 (회귀 금지)
// ──────────────────────────────────────────────────────────────────────────
test('EXAM-GATE(c1): 기간 내 평가 → 학생 start 정상(200)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${activeInPeriodId}/start`, STUDENT1, {});
  assert.equal(r.status, 200, `기간 내는 200 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
  assert.equal(startedCount(activeInPeriodId), 1, '정상 응시 기록 생성');
});

test('EXAM-GATE(c2): 상시운영(start/end=null) 평가 → 학생 start 정상(200)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${alwaysOnId}/start`, STUDENT1, {});
  assert.equal(r.status, 200, `상시운영은 200 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
  assert.equal(startedCount(alwaysOnId), 1, '정상 응시 기록 생성');
});

test('EXAM-GATE(c3): 오늘=마감일(경계 포함) 평가 → 학생 start 정상(200)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${endsTodayId}/start`, STUDENT1, {});
  assert.equal(r.status, 200, `오늘이 마감일이면 통과(200) 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
});

test('EXAM-GATE(c4): 오늘=시작일(경계 포함) 평가 → 학생 start 정상(200)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${startsTodayId}/start`, STUDENT1, {});
  assert.equal(r.status, 200, `오늘이 시작일이면 통과(200) 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
});

// ──────────────────────────────────────────────────────────────────────────
// 교사(owner)·admin 검수 예외 — 시작 전 평가라도 게이트에 막히지 않음.
// ──────────────────────────────────────────────────────────────────────────
test('EXAM-GATE(teacher): 시작 전 평가라도 교사(owner)는 검수 start 허용(200)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${futureId}/start`, TEACHER, {});
  assert.equal(r.status, 200, `교사 검수는 기간 게이트 예외(200) 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
});

test('EXAM-GATE(admin): 마감 지난 평가라도 admin 은 게이트 예외(200)', async () => {
  const r = await req('POST', `/api/exam/${CLASS}/${expiredId}/start`, ADMIN, {});
  assert.equal(r.status, 200, `admin 은 기간 게이트 예외(200) 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
});
