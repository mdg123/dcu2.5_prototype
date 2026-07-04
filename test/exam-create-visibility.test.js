// test/exam-create-visibility.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 버그 박제: "평가 등록했는데 학생(일반멤버)에게 안 보임".
//   원인 — 평가 생성 시 status='draft'(준비중)로 만들어져 학생 화면에서 숨겨짐.
//     · 직접 만들기(FE): payload가 status:'draft'만 보내고 start_mode 미전송 →
//       라우트의 자동 활성화 조건(start_mode==='direct')이 거짓이라 draft로 남음.
//     · 콘텐츠 가져오기(db/cbt-extended importFromContent): status='draft' 하드코딩.
//   "평가 등록" = 학생 즉시 게시(active)가 의도이며, 초안 저장 UI는 존재하지 않는다.
//
//   INV-EXAM-1: 라우트 POST /api/exam/:classId (start_mode:'direct') → 생성 status='active'
//   INV-EXAM-2: importFromContent(...) → 생성 status='active'
//   INV-EXAM-3: FE(class-home.html) 직접 만들기 payload는 start_mode 를 보내고 status:'draft' 를 보내지 않는다
//
// DB 격리: 실 DB → 임시 복사본. 계정(실 DB 실측): teacher1=id2(class 1 소유), student1=id3(member).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();  // ★ 라우터가 db 모듈 require 하기 전에 DB_PATH 주입
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');
const db = openTestDb();

const TEACHER = 2;   // class 1 소유
const CLASS = 1;

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
  app.use('/api/exam', require('../routes/exam'));
  return app;
}

function req(method, urlPath, { user, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + urlPath);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { 'x-test-user': String(user) } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
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

after(() => { if (server) server.close(); });

// ── INV-EXAM-1: 직접 만들기 등록(start_mode:'direct') → status='active' ─────────
test("INV-EXAM-1: POST /api/exam/:classId (start_mode:'direct') → status='active' (학생 노출)", async () => {
  const res = await req('POST', `/api/exam/${CLASS}`, {
    user: TEACHER,
    body: {
      title: '회귀_직접등록_가시성_2099',
      description: '',
      start_mode: 'direct',            // ← 고친 FE payload와 동일
      time_limit: null,
      start_date: '2099-01-01', end_date: '2099-01-08',
      questions: [
        { type: 'multiple', question: '1+1=?', options: ['1', '2', '3', '4'], answer: 1, explanation: '' },
      ],
    },
  });
  assert.ok(res.status === 200 || res.status === 201, `생성 2xx 이어야 함 (got ${res.status})`);
  assert.ok(res.body && res.body.success, '성공 응답이어야 함');
  const examId = res.body.exam ? res.body.exam.id : (res.body.id || (res.body.exam_id));
  assert.ok(examId, '생성된 exam id 반환');
  const row = db.prepare('SELECT status FROM exams WHERE id = ?').get(examId);
  assert.equal(row.status, 'active', 'draft/waiting 아닌 active 로 생성되어야 학생에게 보인다');
});

// ── INV-EXAM-2: 콘텐츠 가져오기(importFromContent) → status='active' ─────────────
test("INV-EXAM-2: importFromContent → status='active' (import 경로도 학생 노출)", () => {
  const cbtExt = require('../db/cbt-extended');
  // 기존 시드 quiz 콘텐츠를 대상으로 import (contents CHECK 회피 — 실 데이터 경로와 동일)
  const src = db.prepare("SELECT id FROM contents WHERE content_type = 'quiz' ORDER BY id LIMIT 1").get();
  assert.ok(src && src.id, '테스트용 quiz 콘텐츠가 시드에 존재해야 함');
  const result = cbtExt.importFromContent(src.id, CLASS, TEACHER, { title: '회귀_임포트등록_가시성_2099' });
  assert.ok(result && result.examId, 'import 결과 examId 반환');
  const row = db.prepare('SELECT status FROM exams WHERE id = ?').get(result.examId);
  assert.equal(row.status, 'active', 'import 평가도 active 로 생성되어야 학생에게 보인다');
});

// ── INV-EXAM-3: FE 직접 만들기 payload 정적 가드 (start_mode 전송·status:'draft' 미전송) ──
test("INV-EXAM-3: class-home.html 직접 만들기 payload는 start_mode 전송 + status:'draft' 미전송", () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'class', 'class-home.html'), 'utf8');
  // POST /api/exam/${classId} 직접 만들기 fetch 블록 근처
  const idx = html.indexOf('직접 만들기: POST /api/exam');
  assert.ok(idx > 0, '직접 만들기 등록 코드 블록이 존재해야 함');
  const block = html.slice(idx, idx + 800);
  assert.match(block, /start_mode:\s*'direct'/, "직접 만들기 payload는 start_mode:'direct' 를 보내야 학생에게 게시됨");
  assert.doesNotMatch(block, /status:\s*'draft'/, "직접 만들기 payload에 status:'draft' 가 남아 있으면 학생에게 숨겨짐(버그 재발)");
});
