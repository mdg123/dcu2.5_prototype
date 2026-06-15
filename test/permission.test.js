// test/permission.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 C] 권한 분기 (API 레벨).
//   학생이 교사/관리자 전용 API 에 접근하면 차단(401/403)되고, 교사·관리자는 정상(200) 이어야 한다.
//   라우트 미들웨어(requireAuth + requireRole)가 보호하므로 정적 분석이 아닌 "실제 HTTP 호출"로 검증.
//
// [구현 방식 — supertest 없이 node:http]
//   의존성 추가 금지(better-sqlite3·express만 devDep). 따라서:
//     - 실제 라우터(routes/*) 와 실제 미들웨어(middleware/auth) 를 mount 한 "경량 app" 을 구성하고
//     - http.createServer(app) 로 임시 포트(포트 0=OS 자동) 기동 → node:http 로 직접 요청.
//   세션은 SQLite 세션스토어 대신 express-session 기본 MemoryStore 사용
//   (data/sessions.db 오염 방지). 로그인 비밀번호 의존을 피하기 위해
//   "테스트 전용 세션 주입 미들웨어"로 x-test-user 헤더의 user_id 를 req.session.userId 에 심는다.
//   → 이렇게 해도 requireAuth(세션→DB findUserById→req.user) + requireRole(역할검사) 의
//     "권한 게이트" 자체는 실제 코드 그대로 실행된다(우리가 우회하는 건 비밀번호 입력뿐).
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입. (복사본만 — 실 DB 무오염)
// 계정(실 DB 실측): admin=id1, teacher1=id2, student1=id3.
//   class 1 = teacher1 소유, student1 member.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터/미들웨어가 db 모듈을 require 하기 전에 DB_PATH 주입

const express = require('express');
const session = require('express-session');

const ADMIN = 1, TEACHER = 2, STUDENT = 3;
const CLASS = 1;

let server, baseUrl;

// 경량 app 구성: 실제 라우터 + 실제 미들웨어 + 테스트 세션 주입.
function buildApp() {
  const app = express();
  app.use(express.json());
  // express-session (MemoryStore — sessions.db 미생성)
  app.use(session({
    secret: 'test-secret', resave: false, saveUninitialized: false
  }));
  // ── 테스트 전용 세션 주입: x-test-user 헤더가 있으면 그 user_id 로 세션 설정.
  //    (실제 로그인 라우트가 하는 일 = req.session.userId 세팅. 비번 검증만 생략.)
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  // 실제 라우터 mount (요청 경로와 동일하게)
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/growth', require('../routes/growth'));
  app.use('/api/lrs', require('../routes/lrs'));
  return app;
}

before(async () => {
  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// node:http GET — asUser=null 이면 미인증(헤더 없음).
function get(path, asUser) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const req = http.request(baseUrl + path, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 대표 보호 엔드포인트 — { path, label, who:'admin'|'teacher' }
//   who='admin'  : admin 만 200, teacher·student·미인증 차단(401/403)
//   who='teacher': teacher·admin 200, student·미인증 차단(401/403)
// (2026-06-15 fix) /api/admin/classes 의 쿼리 컬럼 버그(c.created_by → owner_id)를 수정하여
//   이제 admin 으로 200 정상 응답한다. 권한게이트 + 정상응답 모두 아래 ADMIN_ENDPOINTS 로 검증.
const ADMIN_ENDPOINTS = [
  { path: '/api/admin/stats', label: '관리자 통계' },
  { path: '/api/admin/users', label: '관리자 사용자목록' },
  { path: '/api/admin/contents', label: '관리자 콘텐츠목록' },
  { path: '/api/admin/classes', label: '관리자 클래스목록' }
];
const TEACHER_ENDPOINTS = [
  { path: `/api/growth/report/class/${CLASS}`, label: '클래스 성장 대시보드' },
  { path: `/api/growth/report/class/${CLASS}/daily-learning`, label: '클래스 오늘의학습 매트릭스' }
];

// ──────────────────────────────────────────────────────────────────────────
// C-1: 관리자 전용 API — 학생/교사/미인증은 차단(401/403), admin 만 200.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-C1: 관리자 전용 API — 비-admin 차단(401/403), admin 통과', async () => {
  for (const ep of ADMIN_ENDPOINTS) {
    // 학생 → 차단
    const s = await get(ep.path, STUDENT);
    assert.ok([401, 403].includes(s.status), `[${ep.label}] 학생 접근은 401/403 이어야 (실제=${s.status})`);
    // 교사 → 차단 (admin 전용이므로 교사도 막혀야)
    const t = await get(ep.path, TEACHER);
    assert.ok([401, 403].includes(t.status), `[${ep.label}] 교사 접근은 401/403 이어야 (실제=${t.status})`);
    // 미인증 → 차단
    const a = await get(ep.path, null);
    assert.ok([401, 403].includes(a.status), `[${ep.label}] 미인증 접근은 401/403 이어야 (실제=${a.status})`);
    // admin → 통과(200)
    const ok = await get(ep.path, ADMIN);
    assert.equal(ok.status, 200, `[${ep.label}] admin 접근은 200 이어야 (실제=${ok.status})`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// C-2: 교사 전용 API — 학생/미인증 차단, 교사·관리자 통과.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-C2: 교사 전용 API — 학생/미인증 차단, 교사·관리자 통과', async () => {
  for (const ep of TEACHER_ENDPOINTS) {
    const s = await get(ep.path, STUDENT);
    assert.ok([401, 403].includes(s.status), `[${ep.label}] 학생 접근은 401/403 이어야 (실제=${s.status})`);
    const a = await get(ep.path, null);
    assert.ok([401, 403].includes(a.status), `[${ep.label}] 미인증 접근은 401/403 이어야 (실제=${a.status})`);
    const t = await get(ep.path, TEACHER);
    assert.equal(t.status, 200, `[${ep.label}] 교사 접근은 200 이어야 (실제=${t.status})`);
    const adm = await get(ep.path, ADMIN);
    assert.equal(adm.status, 200, `[${ep.label}] 관리자 접근은 200 이어야 (실제=${adm.status})`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// C-3: 차단 응답 본문 계약 — success:false (한국어 메시지). 정보 노출 없이 거부.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-C3: 차단 응답은 success:false JSON 계약', async () => {
  const r = await get('/api/admin/users', STUDENT);
  assert.ok([401, 403].includes(r.status), `학생 차단 status (실제=${r.status})`);
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (_) {}
  assert.ok(parsed && parsed.success === false, '차단 응답은 { success:false } JSON 이어야');
  assert.equal(typeof parsed.message, 'string', '차단 응답에 한국어 message');
});

// ──────────────────────────────────────────────────────────────────────────
// C-4: /api/admin/classes — admin 으로 200 + 결과 구조 계약.
//   ⚠ 회귀 박제: 핸들러 쿼리가 없는 컬럼(c.created_by)을 참조하면 admin 으로도 500 이었다.
//   실제 컬럼은 classes.owner_id → JOIN users u ON c.owner_id = u.id 로 정정.
//   기대: { success:true, classes:[...], total:Number, totalPages:Number },
//        각 클래스 항목에 id·name·creator_name·member_count 포함.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-C4: /api/admin/classes — admin 200 + 구조 계약(배열·필드)', async () => {
  const r = await get('/api/admin/classes', ADMIN);
  assert.equal(r.status, 200, `admin /api/admin/classes 는 200 이어야 (실제=${r.status})`);
  const p = JSON.parse(r.body);
  assert.equal(p.success, true, 'success:true');
  assert.ok(Array.isArray(p.classes), 'classes 는 배열');
  assert.equal(typeof p.total, 'number', 'total 은 숫자');
  assert.equal(typeof p.totalPages, 'number', 'totalPages 는 숫자');
  // 시드 DB 에 클래스(class 1=teacher1 소유)가 있으므로 1건 이상 + 조인 필드 계약 검증
  assert.ok(p.classes.length > 0, '시드 DB 에 클래스가 1건 이상이어야');
  const c = p.classes[0];
  assert.ok(c.id != null, '클래스 항목에 id');
  assert.ok('name' in c, '클래스 항목에 name');
  assert.ok('creator_name' in c, '클래스 항목에 creator_name(owner_id 조인)');
  assert.equal(typeof c.member_count, 'number', '클래스 항목에 member_count(숫자)');
});
