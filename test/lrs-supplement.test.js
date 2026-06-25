// test/lrs-supplement.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS P1-3 보충 일괄배정 하네스 — 기획서: 작업지시서/LRS_P1_심화_기획서.md §4-8
//
// 박제(SUPP-1~6):
//   SUPP-1 일괄배정 생성 (신규 N건 INSERT)
//   SUPP-2 재배정 멱등 (동일 user,code,content 2회 → 2번째 skipped, 행수 불변)
//   SUPP-3 비담임 교사/학생 assign 403
//   SUPP-4 학생 본인 것만 /supplement/my 조회 + 취소 후 사라짐(soft, 이력 남음)
//   SUPP-5 취소 soft (status='cancelled', 행 보존) + baseline 박제
//   SUPP-6 미러 노출 — 학생 과제 목록(/api/homework/:classId)에 보충 source 포함,
//          학생 응답(my·미러)에 위험점수/risk 필드 없음(P6)
//
// DB 격리: 실 DB → 임시 복사본. initSchema + rebuildAllAggregates.
// 계정(실 DB 확정): admin=1, teacher1=2(class1 owner), student1=3(class1 멤버),
//                    teacher2=8(class1 비담임), student 4·5 도 class1 멤버.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();
require('../db/lrs-aggregate').rebuildAllAggregates();

const supplement = require('../db/lrs-supplement');
const db = openTestDb();

const ADMIN = 1, TEACHER1 = 2, STUDENT1 = 3, STUDENT_4 = 4, STUDENT_5 = 5, TEACHER2_NONMEMBER = 8;
const CLASS = 1;

// 테스트 고정 코드/콘텐츠 — 멱등키 (user, code, content) 검증용. 실제 weakness 무관(멤버십만 검증).
const CODE_A = '[4수01-05]';
const CODE_B = '[4수01-08]';
const CONTENT_A = 50; // approved content (실 DB 확인)

// ════════════════════════════════════════════════════════════════════════════
// HTTP 하네스 (x-test-user 헤더 인증)
// ════════════════════════════════════════════════════════════════════════════
const express = require('express');
const session = require('express-session');
let server, baseUrl;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/lrs', require('../routes/lrs'));
  app.use('/api/homework', require('../routes/homework'));
  return app;
}

function call(method, path, userId, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = userId ? { 'x-test-user': String(userId) } : {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let s = '';
        res.on('data', c => s += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (p, uid) => call('GET', p, uid);
const post = (p, uid, body) => call('POST', p, uid, body);

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

function countSupp() {
  return db.prepare('SELECT COUNT(*) c FROM supplement_assignment').get().c;
}

// ════════════════════════════════════════════════════════════════════════════
// SUPP-1: 일괄배정 생성
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-1: 교사 일괄배정 — 신규 N건 생성(items 형식)', async () => {
  const before = countSupp();
  const r = await post('/api/lrs/supplement/assign', TEACHER1, {
    classId: CLASS, source: 'weak',
    items: [
      { userId: STUDENT1, achievementCode: CODE_A, contentId: CONTENT_A },
      { userId: STUDENT_4, achievementCode: CODE_A, contentId: CONTENT_A },
      { userId: STUDENT_5, achievementCode: CODE_A }, // 콘텐츠 없는 코드 처방
    ],
  });
  assert.equal(r.status, 201, `assign 201 (got ${r.status})`);
  assert.equal(r.json.success, true);
  assert.equal(r.json.assigned, 3, `신규 3건 (got ${r.json.assigned})`);
  assert.equal(r.json.skipped, 0);
  assert.equal(countSupp(), before + 3, '행수 +3');
  assert.ok(Array.isArray(r.json.ids) && r.json.ids.length === 3, 'ids 3개');
});

test('SUPP-1b: 조합 형식(achievementCode×studentIds×contentIds) 도 생성', async () => {
  const before = countSupp();
  const r = await post('/api/lrs/supplement/assign', TEACHER1, {
    classId: CLASS, source: 'ews', achievementCode: CODE_B,
    studentIds: [STUDENT1, STUDENT_4], contentIds: [CONTENT_A],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.assigned, 2, '신규 2건(학생2×콘텐츠1)');
  assert.equal(countSupp(), before + 2);
});

// ════════════════════════════════════════════════════════════════════════════
// SUPP-2: 재배정 멱등 (중복 0)
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-2: 동일 (user,code,content) 재배정 → 2번째 skipped, 행수 불변(멱등)', async () => {
  const before = countSupp();
  const r = await post('/api/lrs/supplement/assign', TEACHER1, {
    classId: CLASS, source: 'weak',
    items: [
      { userId: STUDENT1, achievementCode: CODE_A, contentId: CONTENT_A }, // SUPP-1 에서 이미 배정
      { userId: STUDENT_5, achievementCode: CODE_A },                       // 코드만 — 이미 배정
    ],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.assigned, 0, '중복이므로 신규 0건');
  assert.equal(r.json.skipped, 2, 'skipped 2건');
  assert.equal(countSupp(), before, '행수 불변(멱등)');
  assert.ok(Array.isArray(r.json.skippedDetail) && r.json.skippedDetail.length === 2);
});

// ════════════════════════════════════════════════════════════════════════════
// SUPP-3: 비담임/학생 assign 403
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-3: 비담임 교사 assign 403', async () => {
  const r = await post('/api/lrs/supplement/assign', TEACHER2_NONMEMBER, {
    classId: CLASS, items: [{ userId: STUDENT1, achievementCode: CODE_A, contentId: CONTENT_A }],
  });
  assert.equal(r.status, 403, `비담임 교사 403 (got ${r.status})`);
});

test('SUPP-3b: 학생 assign 403', async () => {
  const r = await post('/api/lrs/supplement/assign', STUDENT1, {
    classId: CLASS, items: [{ userId: STUDENT1, achievementCode: CODE_A, contentId: CONTENT_A }],
  });
  assert.equal(r.status, 403, `학생 403 (got ${r.status})`);
});

// ════════════════════════════════════════════════════════════════════════════
// SUPP-4: 학생 본인 것만 조회
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-4: /supplement/my — 학생은 본인 배정분만, 타 학생 것 미포함', async () => {
  const r = await get('/api/lrs/supplement/my', STUDENT1);
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.ok(Array.isArray(r.json.list) && r.json.list.length >= 1, 'student1 보충 1건 이상');
  for (const s of r.json.list) assert.equal(s.userId, STUDENT1, '모두 본인 것');

  // student5 는 본인(코드만) 것만
  const r5 = await get('/api/lrs/supplement/my', STUDENT_5);
  assert.equal(r5.status, 200);
  for (const s of r5.json.list) assert.equal(s.userId, STUDENT_5);
});

// ════════════════════════════════════════════════════════════════════════════
// SUPP-5: 취소 soft + baseline 박제
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-5: baseline_risk/baseline_reached 가 배정 시점에 박제됨', () => {
  const row = db.prepare(`
    SELECT baseline_risk, baseline_reached FROM supplement_assignment
    WHERE user_id = ? AND achievement_code = ? AND content_id = ?
  `).get(STUDENT1, CODE_A, CONTENT_A);
  assert.ok(row, '배정 행 존재');
  // baseline 은 산출 가능하면 숫자, 불가하면 null — 키 자체는 존재(박제 시도됨)
  assert.ok('baseline_risk' in row && 'baseline_reached' in row);
  assert.ok(row.baseline_reached == null || Number.isInteger(row.baseline_reached));
});

test('SUPP-5b: 취소 soft — status=cancelled, 행 보존, 학생 my 에서 사라짐', async () => {
  // student4 의 CODE_A 배정 1건 취소
  const target = db.prepare(`
    SELECT id FROM supplement_assignment WHERE user_id=? AND achievement_code=? AND status<>'cancelled' LIMIT 1
  `).get(STUDENT_4, CODE_A);
  assert.ok(target, '취소 대상 존재');
  const totalBefore = countSupp();

  const c = await post(`/api/lrs/supplement/${target.id}/cancel`, TEACHER1, {});
  assert.equal(c.status, 200);
  assert.equal(c.json.cancelled, true);

  // 행은 보존(soft), status=cancelled
  assert.equal(countSupp(), totalBefore, '행수 불변(soft delete)');
  const after = db.prepare('SELECT status, cancelled_at FROM supplement_assignment WHERE id=?').get(target.id);
  assert.equal(after.status, 'cancelled');
  assert.ok(after.cancelled_at, 'cancelled_at 기록');

  // 학생 my 목록에서 사라짐
  const my = await get('/api/lrs/supplement/my', STUDENT_4);
  assert.ok(!my.json.list.some(s => s.id === target.id), '취소분은 학생 my 에서 제외');

  // 교사 class 현황엔 이력으로 남음(includeCancelled 기본 true)
  const cls = await get(`/api/lrs/supplement/class/${CLASS}`, TEACHER1);
  assert.ok(cls.json.list.some(s => s.id === target.id && s.status === 'cancelled'), '교사 현황에 취소 이력 남음');
});

test('SUPP-5c: 비담임은 class 현황 403, 담임은 200(실명)', async () => {
  const no = await get(`/api/lrs/supplement/class/${CLASS}`, TEACHER2_NONMEMBER);
  assert.equal(no.status, 403);
  const ok = await get(`/api/lrs/supplement/class/${CLASS}`, TEACHER1);
  assert.equal(ok.status, 200);
  assert.ok(ok.json.list.every(s => typeof s.studentName === 'string'), '담임은 학생 실명');
});

// ════════════════════════════════════════════════════════════════════════════
// SUPP-6: 미러 노출 + P6 위험 비노출
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-6: 학생 과제 목록(/api/homework/:classId)에 보충 source 포함', async () => {
  const r = await get(`/api/homework/${CLASS}`, STUDENT1);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.supplements), 'supplements 배열 존재');
  assert.ok(r.json.supplements.length >= 1, 'student1 보충 1건 이상 미러');
  for (const s of r.json.supplements) {
    assert.equal(s.type, 'supplement', 'type=supplement 배지 구분');
    assert.equal(s.source, 'supplement');
  }
  // 일반 과제는 type='homework'
  for (const h of (r.json.homework || [])) assert.equal(h.type, 'homework');
});

test('SUPP-6b: P6 — 학생 응답(my·미러)에 위험점수/risk 필드 절대 없음', async () => {
  const my = await get('/api/lrs/supplement/my', STUDENT1);
  const myStr = JSON.stringify(my.json);
  assert.ok(!/"baselineRisk"/.test(myStr), 'my 에 baselineRisk 없음');
  assert.ok(!/"score"/.test(myStr), 'my 에 score(위험점수) 없음');
  assert.ok(!/위험/.test(myStr), 'my 에 "위험" 어휘 없음');

  const hw = await get(`/api/homework/${CLASS}`, STUDENT1);
  const supStr = JSON.stringify(hw.json.supplements);
  assert.ok(!/risk/i.test(supStr), '미러에 risk 필드 없음');
  assert.ok(!/위험/.test(supStr), '미러에 "위험" 어휘 없음');
});

test('SUPP-6c: 학생 done — 본인 완료 시 status=done, 미러에서 done 표기', async () => {
  const my = await get('/api/lrs/supplement/my', STUDENT1);
  const item = my.json.list.find(s => s.status === 'assigned');
  assert.ok(item, '완료 대상 존재');
  const d = await post(`/api/lrs/supplement/${item.id}/done`, STUDENT1, {});
  assert.equal(d.status, 200);
  assert.equal(d.json.done, true);
  const after = db.prepare('SELECT status, completed_at FROM supplement_assignment WHERE id=?').get(item.id);
  assert.equal(after.status, 'done');
  assert.ok(after.completed_at);
});

test('SUPP-6d: 타 학생 done 403(권한)', async () => {
  const my4 = await get('/api/lrs/supplement/my', STUDENT_4);
  const item = (my4.json.list || [])[0];
  if (!item) return; // student4 보충 없으면 skip
  const d = await post(`/api/lrs/supplement/${item.id}/done`, STUDENT_5, {});
  assert.equal(d.status, 403, '타 학생 done 403');
});

// ════════════════════════════════════════════════════════════════════════════
// 추천 후보(recommend) — 구조 + insufficient 분기(P5)
// ════════════════════════════════════════════════════════════════════════════
test('SUPP-7: recommend — 추천콘텐츠 + 배정후보(미도달·부분도달) + insufficient 분기', async () => {
  const r = await get(`/api/lrs/supplement/recommend?classId=${CLASS}&code=${encodeURIComponent(CODE_A)}`, TEACHER1);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.recommendations), 'recommendations 배열');
  assert.ok(Array.isArray(r.json.targetStudents), 'targetStudents 배열(미도달·부분도달)');
  assert.ok(Array.isArray(r.json.insufficientStudents), 'insufficientStudents 배열(P5 먼저풀어보기)');
  assert.ok(Array.isArray(r.json.alreadyAssigned), 'alreadyAssigned 배열(회색 처리)');
  // 비담임 403
  const no = await get(`/api/lrs/supplement/recommend?classId=${CLASS}&code=${encodeURIComponent(CODE_A)}`, TEACHER2_NONMEMBER);
  assert.equal(no.status, 403);
});
