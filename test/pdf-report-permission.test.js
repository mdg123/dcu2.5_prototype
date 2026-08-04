// test/pdf-report-permission.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [결함 #7] 교사가 같은 반 학생 PDF 생성 — 권한 모순 fix
//   근본원인: POST /api/growth/portfolios/report 의 권한이 "본인 || admin" 뿐 →
//     같은 데이터를 화면조회하는 GET /report/student/:id, .../detail 은 같은 반 교사 허용인데
//     PDF 생성만 막혀 있었다(모순). 담임은 화면으로 보던 리포트를 PDF 로 못 뽑음.
//   수정: PDF 생성 권한을 화면조회와 동일 기준(canAccessStudentReport)으로 통일.
//     = 본인 / admin / 같은 반 담당(owner) 교사 허용. 타 반·무관 교사·타 학생은 403 유지.
//
// 검증 전략(경량 HTTP 앱 — permission.test.js 패턴 재사용):
//   실제 라우터 routes/growth + 실제 미들웨어를 mount, x-test-user 헤더로 세션 주입.
//   권한 "게이트"만 검증하므로:
//     - 차단 케이스: status === 403 (권한 거부 단정)
//     - 허용 케이스: status !== 403 (게이트 통과. 이후 PDF 생성 자체는 데이터/필수필터에 따라
//       200/400/404/500 일 수 있으나 "권한 403" 만 아니면 게이트 통과로 본다.)
//
// DB 격리: 실 DB → 임시 복사본. 계정(실 DB 실측):
//   admin=1, teacher1=2(class1 owner), student1=3(class1 member),
//   student3=5(class1 member), seed_t001=2618(어떤 반도 owner 아님=무관 교사).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터/미들웨어가 db 모듈 require 전에 DB_PATH 주입

const express = require('express');
const session = require('express-session');

const ADMIN = 1, TEACHER1 = 2, STUDENT1 = 3, STUDENT3 = 5, UNREL_TEACHER = 2618;

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
  app.use('/api/growth', require('../routes/growth'));
  return app;
}

before(async () => {
  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

// PDF 생성 POST. asUser=null 이면 미인증.
//   body 는 권한 게이트를 통과시키기 위한 최소 형태(필수 필터 포함) — 데이터 없으면 404 가능,
//   그러나 권한 게이트(403)와는 무관.
function postReport(studentId, asUser) {
  const payload = JSON.stringify({
    studentId,
    period: { from: '2026-01-01', to: '2026-12-31' },
    schoolLevel: 'elementary'
  });
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const req = http.request(baseUrl + '/api/growth/portfolios/report', { method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// (a) 같은 반 teacher1 → student1 PDF 생성: 권한 통과(403 아님)  ← RED: 현재 403
// ──────────────────────────────────────────────────────────────────────────
test('PDF-PERM-a: 같은 반 teacher1 → student1 PDF 생성 권한 통과(403 아님)', async () => {
  const r = await postReport(STUDENT1, TEACHER1);
  assert.notEqual(r.status, 403, `같은 반 담임은 PDF 생성 권한이 있어야(403 아님). 실제=${r.status} body=${r.body.slice(0,200)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// (b) 무관 교사(어떤 반도 student1 담임 아님) → 403 유지
// ──────────────────────────────────────────────────────────────────────────
test('PDF-PERM-b: 무관 교사 → student1 PDF 생성 403', async () => {
  const r = await postReport(STUDENT1, UNREL_TEACHER);
  assert.equal(r.status, 403, `무관 교사는 403 이어야. 실제=${r.status}`);
});

// ──────────────────────────────────────────────────────────────────────────
// (c) 학생 본인(student1) → 본인 PDF: 권한 통과(403 아님)
// ──────────────────────────────────────────────────────────────────────────
test('PDF-PERM-c: 학생 본인 → 본인 PDF 생성 권한 통과(403 아님)', async () => {
  const r = await postReport(STUDENT1, STUDENT1);
  assert.notEqual(r.status, 403, `본인은 권한 통과해야(403 아님). 실제=${r.status} body=${r.body.slice(0,200)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// (d) 타 학생(student3) → student1 PDF: 403 (학생은 본인만)
// ──────────────────────────────────────────────────────────────────────────
test('PDF-PERM-d: 타 학생 → 다른 학생 PDF 생성 403', async () => {
  const r = await postReport(STUDENT1, STUDENT3);
  assert.equal(r.status, 403, `타 학생은 403 이어야. 실제=${r.status}`);
});

// ──────────────────────────────────────────────────────────────────────────
// (e) admin → 임의 학생 PDF: 권한 통과(403 아님) — 회귀
// ──────────────────────────────────────────────────────────────────────────
test('PDF-PERM-e: admin → 임의 학생 PDF 생성 권한 통과(403 아님)', async () => {
  const r = await postReport(STUDENT1, ADMIN);
  assert.notEqual(r.status, 403, `admin 은 권한 통과해야(403 아님). 실제=${r.status} body=${r.body.slice(0,200)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// (f) [W4] 디스크 격리 — DB 는 임시 사본을 쓰면서 PDF 만 정본 디스크에 썼다.
//   실측(2026-08-04): uploads/portfolio-reports 에 1103 개 중 1095 개가 정본 DB 미참조 고아.
//   전부 user_id=3(=STUDENT1, 이 파일이 쓰는 계정)이고, 인접 생성 간격의 66%가 1초 미만,
//   "5분 공백" 기준 226 세션 중 149 세션이 정확히 3 개 = 이 파일의 허용 케이스(a·c·e) 3 건과 일치.
//   즉 테스트가 매 실행마다 정본 디스크에 3 개씩 쌓고 있었다.
//   → setupTestDb() 가 PORTFOLIO_REPORT_DIR 를 임시 경로로 주입하고, 생성 경로가 그것을 따른다.
//   "쓰지 않는다"가 아니라 "임시로 쓴다"를 검증한다(생성 기능이 죽으면 그것도 붉어지도록).
// ──────────────────────────────────────────────────────────────────────────
test('PDF-PERM-f: 테스트가 만든 PDF 는 정본 uploads/ 를 오염시키지 않고 임시 경로에 쌓인다', async () => {
  const realDir = path.join(process.cwd(), 'uploads', 'portfolio-reports');
  const countIn = (d) => (d && fs.existsSync(d) ? fs.readdirSync(d).length : 0);

  const isoDir = process.env.PORTFOLIO_REPORT_DIR;
  assert.ok(isoDir, 'setupTestDb() 가 PORTFOLIO_REPORT_DIR(임시 경로)를 주입해야 한다');
  assert.notEqual(path.resolve(isoDir), path.resolve(realDir), '격리 경로가 정본 경로와 같다');

  const realBefore = countIn(realDir);
  const isoBefore = countIn(isoDir);

  const r = await postReport(STUDENT1, STUDENT1);
  assert.notEqual(r.status, 403, `전제: 본인 PDF 생성은 권한 통과 (실제=${r.status})`);
  assert.equal(r.status, 201, `전제: PDF 가 실제로 생성돼야 한다 (실제=${r.status} ${r.body.slice(0, 200)})`);

  assert.equal(countIn(realDir), realBefore,
    `테스트가 정본 uploads/portfolio-reports 에 파일을 ${countIn(realDir) - realBefore} 개 남겼다(디스크 오염)`);
  assert.ok(countIn(isoDir) > isoBefore,
    '임시 경로에 PDF 가 생성되지 않았다(경로만 바꾸고 생성이 죽었을 수 있다)');
});
