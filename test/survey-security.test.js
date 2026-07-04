// test/survey-security.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 설문 BE 감사 확정 3건 회귀 박제 (실 DB → 임시 복사본 격리, 무오염).
//
//  FIX-1 [H] 응답 게이트: draft/closed/기간종료 설문은 submit 거부(403), active·기간내는 성공(200).
//  FIX-2 [H] 익명 신원 노출: is_anonymous=1 설문의 getResponses/라우트 응답에
//            display_name·username·user_id 부재. 비익명은 존재.
//  FIX-3 [M] 목록 문항 수: getSurveysByClass 반환에 question_count 존재·정확(손상 JSON → 0).
//
// 라우트 테스트는 permission.test.js 의 node:http + x-test-user 세션주입 패턴을 그대로 따른다.
// 계정(실 DB 실측): admin=1, teacher1=2(class1 owner), student1=3(class1 member), student2=4.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ db 모듈 require 전에 DB_PATH 주입(복사본)

const express = require('express');
const session = require('express-session');
const surveyDb = require('../db/survey');

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const CLASS = 1;

let server, baseUrl, db;
// 테스트에서 생성한 설문 id 들(시드 오염 없이 복사본 안에서만 생성)
let activeId, draftId, closedId, expiredId, anonActiveId;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/surveys', require('../routes/survey'));
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

before(async () => {
  db = openTestDb();
  const q = JSON.stringify([
    { id: 1, type: 'choice', text: '문항1', options: ['a', 'b'] },
    { id: 2, type: 'text', text: '문항2' },
  ]);
  const ins = db.prepare(
    `INSERT INTO surveys (class_id, author_id, title, questions, status, end_date, is_anonymous)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // 미래 종료일(기간 내) / 과거 종료일(기간 종료)
  const future = '2999-12-31 23:59:59';
  const past = '2000-01-01 00:00:00';
  activeId     = ins.run(CLASS, TEACHER, 'SEC active',   q, 'active',   future, 0).lastInsertRowid;
  draftId      = ins.run(CLASS, TEACHER, 'SEC draft',    q, 'draft',    future, 0).lastInsertRowid;
  closedId     = ins.run(CLASS, TEACHER, 'SEC closed',   q, 'closed',   future, 0).lastInsertRowid;
  expiredId    = ins.run(CLASS, TEACHER, 'SEC expired',  q, 'active',   past,   0).lastInsertRowid;
  anonActiveId = ins.run(CLASS, TEACHER, 'SEC anon',     q, 'active',   future, 1).lastInsertRowid;

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

// ──────────────────────────────────────────────────────────────────────────
// FIX-1: 응답 게이트 — draft/closed/기간종료 거부, active·기간내 성공.
// ──────────────────────────────────────────────────────────────────────────
test('SURVEY-FIX1: draft 설문 submit 은 거부(403)', async () => {
  const r = await req('POST', `/api/surveys/${CLASS}/${draftId}/submit`, STUDENT1, { answers: [1, 2] });
  assert.equal(r.status, 403, `draft 는 403 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, false, 'success:false');
  // DB 에 응답이 기록되지 않아야
  const cnt = db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id=?').get(draftId).c;
  assert.equal(cnt, 0, 'draft 거부 시 응답 미기록');
});

test('SURVEY-FIX1: closed 설문 submit 은 거부(403)', async () => {
  const r = await req('POST', `/api/surveys/${CLASS}/${closedId}/submit`, STUDENT1, { answers: [1, 2] });
  assert.equal(r.status, 403, `closed 는 403 이어야 (실제=${r.status})`);
  const cnt = db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id=?').get(closedId).c;
  assert.equal(cnt, 0, 'closed 거부 시 응답 미기록');
});

test('SURVEY-FIX1: end_date 경과 설문 submit 은 거부(403)', async () => {
  const r = await req('POST', `/api/surveys/${CLASS}/${expiredId}/submit`, STUDENT1, { answers: [1, 2] });
  assert.equal(r.status, 403, `기간종료는 403 이어야 (실제=${r.status})`);
  const cnt = db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id=?').get(expiredId).c;
  assert.equal(cnt, 0, '기간종료 거부 시 응답 미기록');
});

test('SURVEY-FIX1: active·기간내 설문 submit 은 성공(200) 후 기록', async () => {
  const r = await req('POST', `/api/surveys/${CLASS}/${activeId}/submit`, STUDENT1, { answers: [1, 2] });
  assert.equal(r.status, 200, `active 는 200 이어야 (실제=${r.status})`);
  assert.equal(r.json && r.json.success, true, 'success:true');
  const cnt = db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id=? AND user_id=?')
    .get(activeId, STUDENT1).c;
  assert.equal(cnt, 1, 'active 응답 기록됨');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-2: 익명 신원 노출 — is_anonymous=1 응답에 신원필드 부재, 비익명은 존재.
// ──────────────────────────────────────────────────────────────────────────
test('SURVEY-FIX2: getResponses(anon) 는 신원필드(display_name/username/user_id) 제거', async () => {
  // 익명 설문에 응답 1건 심기(직접 INSERT — 게이트 무관하게 데이터만 확보)
  db.prepare('INSERT OR IGNORE INTO survey_responses (survey_id, user_id, answers) VALUES (?, ?, ?)')
    .run(anonActiveId, STUDENT2, JSON.stringify([1, 2]));

  const anon = surveyDb.getResponses(anonActiveId, true);
  assert.ok(anon.length >= 1, '익명 응답 1건 이상');
  for (const r of anon) {
    assert.equal('display_name' in r, false, '익명: display_name 부재');
    assert.equal('username' in r, false, '익명: username 부재');
    assert.equal('user_id' in r, false, '익명: user_id 부재');
    assert.ok('answers' in r, '익명: 응답 내용은 유지');
  }
  // 비익명(기본 false)은 신원 필드 존재
  const named = surveyDb.getResponses(activeId, false);
  assert.ok(named.length >= 1, '비익명 응답 1건 이상');
  assert.ok('display_name' in named[0] && 'username' in named[0] && 'user_id' in named[0],
    '비익명: 신원필드 존재');
});

test('SURVEY-FIX2: 라우트 GET 상세 — owner 익명설문 responses 에 신원필드 부재', async () => {
  const r = await req('GET', `/api/surveys/${CLASS}/${anonActiveId}`, TEACHER, null);
  assert.equal(r.status, 200, `owner 상세조회 200 (실제=${r.status})`);
  assert.ok(Array.isArray(r.json.responses), 'responses 배열');
  assert.ok(r.json.responses.length >= 1, '응답 1건 이상');
  for (const resp of r.json.responses) {
    assert.equal('display_name' in resp, false, '라우트 익명: display_name 부재');
    assert.equal('username' in resp, false, '라우트 익명: username 부재');
    assert.equal('user_id' in resp, false, '라우트 익명: user_id 부재');
  }
  // 페이로드 문자열에도 응답자 아이디/이름이 새어나오지 않아야(방어적 이중검증)
  assert.equal(/student2|박학생/.test(r.body), false, '익명 페이로드에 응답자 신원 문자열 없음');
});

test('SURVEY-FIX2: 라우트 GET 상세 — 비익명설문 responses 에 신원필드 존재', async () => {
  const r = await req('GET', `/api/surveys/${CLASS}/${activeId}`, TEACHER, null);
  assert.equal(r.status, 200, `owner 상세조회 200 (실제=${r.status})`);
  assert.ok(r.json.responses.length >= 1, '응답 1건 이상');
  const resp = r.json.responses[0];
  assert.ok('display_name' in resp, '비익명 라우트: display_name 존재');
  assert.ok('username' in resp, '비익명 라우트: username 존재');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-3: 목록 문항 수 — getSurveysByClass 반환에 question_count 존재·정확.
// ──────────────────────────────────────────────────────────────────────────
test('SURVEY-FIX3: getSurveysByClass 각 항목에 question_count(숫자) 존재', () => {
  const { surveys } = surveyDb.getSurveysByClass(CLASS, { limit: 100, userId: STUDENT1 });
  assert.ok(surveys.length >= 1, '설문 1건 이상');
  for (const s of surveys) {
    assert.equal(typeof s.question_count, 'number', `[${s.title}] question_count 는 숫자`);
    assert.ok(s.question_count >= 0, 'question_count >= 0');
    assert.equal('questions' in s, false, '목록 페이로드에 원본 questions 블롭 미포함');
  }
  // 우리가 심은 2문항 설문은 정확히 2
  const mine = surveys.find(s => s.id === activeId);
  assert.ok(mine, 'active 설문 목록 포함');
  assert.equal(mine.question_count, 2, '2문항 설문은 question_count=2');
});

test('SURVEY-FIX3: 손상(이중 인코딩) questions → question_count 0 (예외 없이 방어)', () => {
  // 감사가 발견한 손상 형태: JSON 문자열이 한 번 더 인코딩되어 저장된 케이스.
  const corruptId = db.prepare(
    `INSERT INTO surveys (class_id, author_id, title, questions, status)
     VALUES (?, ?, ?, ?, 'active')`
  ).run(CLASS, TEACHER, 'SEC corrupt', JSON.stringify(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]))).lastInsertRowid;

  const { surveys } = surveyDb.getSurveysByClass(CLASS, { limit: 100 });
  const c = surveys.find(s => s.id === corruptId);
  assert.ok(c, '손상 설문 목록 포함');
  // 이중 인코딩은 unwrap 시도 → 배열(3) 복원, 완전 손상이면 0. 둘 다 예외 없이 숫자여야 하고 이상치(236 등) 금지.
  assert.equal(typeof c.question_count, 'number', 'question_count 숫자');
  assert.ok(c.question_count === 3 || c.question_count === 0,
    `손상 JSON 은 3(unwrap 복원) 또는 0(방어) — 이상치 금지 (실제=${c.question_count})`);
});
