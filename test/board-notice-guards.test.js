// test/board-notice-guards.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 감사 확정 3건 회귀 박제.
//   FIX-1 [보안]: 게시판 상세(GET /:classId/:postId)에 승인 가드 부재로 미승인/반려 글이
//                 타 학생에게 상세 노출되던 문제 → 교사(owner)·admin·작성자 본인만 열람, 그 외 404.
//   FIX-2 [정합]: db/board.createComment 가 parent_id 를 무검증 INSERT → 다른 게시글 댓글을
//                 parent 로 넘기면 교차 중첩. 부모 댓글의 post_id 일치 검증(불일치 시 top-level 강등).
//   FIX-3 [정합]: db/notice.getReadAndUnreadMembers 가 개설자(작성자) 포함 전원을 분모로 삼아
//                 작성자가 자기 알림장을 안 열면 "미확인"에 잡혀 도달율 왜곡 → 작성자 분모 제외.
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입(_setup). 시드는 복사본에만 INSERT.
// 계정(실 DB 실측): admin=id1, teacher1=id2(class1 owner), student1=id3, student2=id4 (둘 다 class1 member).
// HTTP 검증은 permission.test.js 의 node:http + x-test-user(테스트 세션 주입) 패턴을 그대로 사용.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터/미들웨어/ db 모듈 require 이전에 DB_PATH 주입

const express = require('express');
const session = require('express-session');
const boardDb = require('../db/board');
const noticeDb = require('../db/notice');

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const CLASS = 1;

let server, baseUrl;
let PENDING_POST_ID, APPROVED_POST_ID, REJECTED_POST_ID;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/board', require('../routes/board'));
  return app;
}

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

before(async () => {
  // 시드: class1 에 student1 작성 게시글 3종(pending/approved/rejected)
  const d = openTestDb();
  const ins = d.prepare(
    "INSERT INTO posts (class_id, author_id, title, content, category, approval_status) VALUES (?, ?, ?, ?, 'gallery', ?)"
  );
  PENDING_POST_ID  = ins.run(CLASS, STUDENT1, '미승인 작품', '내용', 'pending').lastInsertRowid;
  APPROVED_POST_ID = ins.run(CLASS, STUDENT1, '승인 작품',   '내용', 'approved').lastInsertRowid;
  REJECTED_POST_ID = ins.run(CLASS, STUDENT1, '반려 작품',   '내용', 'rejected').lastInsertRowid;
  d.close();

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
// FIX-1: 게시판 상세 승인 가드
// ──────────────────────────────────────────────────────────────────────────
test('BOARD-GUARD-1: 비작성자 학생은 pending 게시글 상세 열람 불가(404)', async () => {
  const r = await get(`/api/board/${CLASS}/${PENDING_POST_ID}`, STUDENT2);
  assert.equal(r.status, 404, `타 학생의 pending 상세 접근은 404 이어야 (실제=${r.status})`);
  const p = JSON.parse(r.body);
  assert.equal(p.success, false, '차단 응답은 success:false');
});

test('BOARD-GUARD-1b: 비작성자 학생은 rejected 게시글 상세 열람 불가(404)', async () => {
  const r = await get(`/api/board/${CLASS}/${REJECTED_POST_ID}`, STUDENT2);
  assert.equal(r.status, 404, `타 학생의 rejected 상세 접근은 404 이어야 (실제=${r.status})`);
});

test('BOARD-GUARD-1c: 작성자 본인은 자신의 pending 게시글 상세 열람 가능(200)', async () => {
  const r = await get(`/api/board/${CLASS}/${PENDING_POST_ID}`, STUDENT1);
  assert.equal(r.status, 200, `작성자 본인은 pending 상세 200 이어야 (실제=${r.status})`);
  const p = JSON.parse(r.body);
  assert.equal(p.success, true);
  assert.equal(p.post.id, PENDING_POST_ID);
});

test('BOARD-GUARD-1d: 교사(개설자)는 pending 게시글 상세 열람 가능(200)', async () => {
  const r = await get(`/api/board/${CLASS}/${PENDING_POST_ID}`, TEACHER);
  assert.equal(r.status, 200, `개설자는 pending 상세 200 이어야 (실제=${r.status})`);
});

test('BOARD-GUARD-1e: admin 은 pending 게시글 상세 열람 가능(200)', async () => {
  const r = await get(`/api/board/${CLASS}/${PENDING_POST_ID}`, ADMIN);
  assert.equal(r.status, 200, `admin 은 pending 상세 200 이어야 (실제=${r.status})`);
});

test('BOARD-GUARD-1f: 비작성자 학생도 approved 게시글 상세는 정상 열람(200) — 회귀 없음', async () => {
  const r = await get(`/api/board/${CLASS}/${APPROVED_POST_ID}`, STUDENT2);
  assert.equal(r.status, 200, `approved 게시글은 타 학생도 200 이어야 (실제=${r.status})`);
  const p = JSON.parse(r.body);
  assert.equal(p.post.id, APPROVED_POST_ID);
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-2: 대댓글 교차 격리 (db 레벨)
// ──────────────────────────────────────────────────────────────────────────
test('BOARD-GUARD-2: 다른 게시글의 댓글을 parent_id 로 넘기면 무시(top-level 강등)', () => {
  // 게시글 A(approved)·B(pending) 각각에 top-level 댓글을 만든 뒤,
  // B 게시글에 A 댓글 id 를 parent 로 대댓글 시도 → parent_id 는 null 이어야(교차 차단).
  const rootA = boardDb.createComment(APPROVED_POST_ID, STUDENT1, 'A 루트댓글', null);
  const crossReply = boardDb.createComment(PENDING_POST_ID, STUDENT2, 'B에서 A부모로 대댓글', rootA.id);
  assert.equal(crossReply.post_id, PENDING_POST_ID, '댓글은 요청한 게시글에 귀속');
  assert.equal(crossReply.parent_id, null, '교차 parent_id 는 무시되어 null(top-level) 이어야');
});

test('BOARD-GUARD-2b: 같은 게시글의 부모 댓글이면 parent_id 정상 유지 — 회귀 없음', () => {
  const root = boardDb.createComment(APPROVED_POST_ID, STUDENT1, '루트', null);
  const reply = boardDb.createComment(APPROVED_POST_ID, STUDENT2, '대댓글', root.id);
  assert.equal(reply.parent_id, root.id, '동일 게시글 내 대댓글은 parent_id 유지');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-3: 알림장 읽음율 분모에서 작성자 제외 (db 레벨)
// ──────────────────────────────────────────────────────────────────────────
test('NOTICE-GUARD-3: getReadAndUnreadMembers 분모에서 작성자(개설자) 제외', () => {
  // teacher1(개설자, id2)이 class1 에 알림장 작성. 아무도 읽지 않은 상태에서
  // read/unread 어느 목록에도 작성자(id2)가 나타나면 안 된다(도달율 왜곡 방지).
  const notice = noticeDb.createNotice(CLASS, TEACHER, { title: '분모 제외 검증 알림장', content: '내용' });
  const { read_members, unread_members } = noticeDb.getReadAndUnreadMembers(notice.id, CLASS);
  const allIds = [...read_members, ...unread_members].map(m => m.user_id);
  assert.ok(!allIds.includes(TEACHER), `작성자(id=${TEACHER})는 읽음/미읽음 분모에서 제외되어야`);
  // 대조: 일반 멤버(student1)는 미확인 분모에 포함되어야(읽지 않았으므로)
  assert.ok(unread_members.some(m => m.user_id === STUDENT1), '일반 미확인 멤버는 분모에 포함');
});

test('NOTICE-GUARD-3b: 작성자가 읽어도 read_members 에 작성자 미포함 — 분모 일관', () => {
  const notice = noticeDb.createNotice(CLASS, TEACHER, { title: '작성자 읽음 케이스', content: '내용' });
  noticeDb.markRead(notice.id, TEACHER); // 작성자 스스로 읽음 처리
  const { read_members, unread_members } = noticeDb.getReadAndUnreadMembers(notice.id, CLASS);
  const allIds = [...read_members, ...unread_members].map(m => m.user_id);
  assert.ok(!allIds.includes(TEACHER), '작성자는 읽었더라도 분모(read/unread)에서 제외');
});
