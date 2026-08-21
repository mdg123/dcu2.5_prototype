// test/board-gallery-link.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 채움클래스 갤러리 게시판 → 나도예술가 연동 회귀 박제 (기획서 §5, INV-BG1~6).
//
// 발단(사용자 지적 2026-08-20):
//   "왜 채움클래스에서 게시판 갤러리로 이미지를 올렸는데 나도예술가에는 빈 이미지로만 나오는지"
//
// 확정 사양:
//   게시판 생성 → [나도예술가 연결] 설정(게시판 단위)
//                        ↓ (켜져 있으면)
//   학생이 게시물 업로드 → 개설자 승인 → 나도예술가에 표시 (이미지·동영상·음원 전부)
//
// 고친 두 가지:
//   ① 연동 여부가 "글 단위 체크박스 || category==='gallery'" 라 **끄는 방법이 없었다**
//        → class_boards.share_to_gallery 가 유일한 기준
//   ② 연동이 post.image_url(파일 선택분) **하나만** 봤다. 목록 썸네일은
//      `image_url || 본문 첫 <img>` 로 둘 다 보므로 본문에 넣은 글은
//      **게시판에서는 정상, 나도예술가에서는 placeholder** 가 됐다
//        → image_url + 본문 img/video/audio/source/iframe 을 전부 gallery_attachments 로
//
// 건드리지 않은 것: 승인 주체(개설자) — routes/board.js:312 는 정상 동작이라 그대로.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 시드는 복사본에만 INSERT. 실 DB 무오염.
// 계정(실 DB 실측): admin=1, teacher1=2(class1 owner), student1=3, student2=4.
// HTTP 검증은 board-notice-guards.test.js 의 node:http + x-test-user 패턴 그대로.
//
// ⚠ 단언을 조건문 안에 가두지 않는다. 픽스처가 조건을 안 타서 단언이 한 번도 실행되지
//    않는 함정을 막기 위해, 각 테스트는 "픽스처 전제" 단언을 먼저 최상위에서 실행한다.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터/db 모듈 require 이전에 DB_PATH 주입
require('../db/schema').initSchema();   // 격리 DB 에도 class_boards.share_to_gallery 마이그레이션 적용

const express = require('express');
const session = require('express-session');
const boardDb = require('../db/board');
const boardGallery = require('../db/board-gallery');
const { extractPostMedia, shouldLinkPostToGallery } = require('../lib/board-gallery-link');

const TEACHER = 2, STUDENT1 = 3;
const CLASS = 1;
const TAG = `BGL-${process.pid}-${Date.now()}`;

let server, baseUrl, db;
let BOARD_ON, BOARD_OFF;

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

function request(method, path, asUser, payload) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const data = payload != null ? JSON.stringify(payload) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    // agent:false — 전역 agent 의 keep-alive 소켓을 쓰지 않는다.
    //   INV-BG11/11b 가 execFileSync 로 수 초간 이벤트루프를 붙잡는 동안 유휴 소켓이 만료돼,
    //   그 다음 요청이 죽은 소켓을 재사용하며 ECONNRESET 으로 터졌다(2026-08-21 실측).
    const req = http.request(baseUrl + path, { method, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 학생이 글을 쓰고 post id 를 돌려준다. */
async function writePost(boardId, fields) {
  const r = await request('POST', `/api/board/${CLASS}`, STUDENT1, { board_id: boardId, ...fields });
  assert.equal(r.status, 201, `게시글 작성 201 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  return r.json.post.id;
}

async function approvePost(postId) {
  const r = await request('POST', `/api/board/${CLASS}/${postId}/approve`, TEACHER, {});
  assert.equal(r.status, 200, `개설자 승인 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  return r.json.post;
}

function galleryRowOf(postId) {
  return db.prepare('SELECT * FROM student_gallery WHERE source_post_id = ?').get(postId) || null;
}
function attachmentsOf(galleryId) {
  return db.prepare(
    'SELECT type, url, mime, sort_order FROM gallery_attachments WHERE gallery_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(galleryId);
}

before(async () => {
  db = openTestDb();
  // 게시판 2종을 API 로 만든다 — 라우트+db/board.js 의 share_to_gallery 저장 경로까지 함께 검증.
  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const on = await request('POST', `/api/board/${CLASS}/boards`, TEACHER, {
    name: `${TAG}-연동ON`, board_type: 'gallery', share_to_gallery: 1, requires_approval: 1,
  });
  const off = await request('POST', `/api/board/${CLASS}/boards`, TEACHER, {
    name: `${TAG}-연동OFF`, board_type: 'gallery', share_to_gallery: 0, requires_approval: 1,
  });
  assert.equal(on.status, 201, '연동ON 게시판 생성');
  assert.equal(off.status, 201, '연동OFF 게시판 생성');
  BOARD_ON = on.json.board.id;
  BOARD_OFF = off.json.board.id;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { db && db.close(); } catch (_) {}
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG0: 게시판 단위 설정이 실제로 저장·구분된다(전제).
//   이 전제가 깨지면 아래 BG1/BG2 는 같은 걸 두 번 보는 셈이 되어 무의미해진다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG0: class_boards.share_to_gallery 가 켜짐/꺼짐으로 각각 저장된다', () => {
  const on = boardDb.getBoardById(BOARD_ON);
  const off = boardDb.getBoardById(BOARD_OFF);
  assert.ok(on, '연동ON 게시판 조회');
  assert.ok(off, '연동OFF 게시판 조회');
  assert.equal(on.share_to_gallery, 1, '연동ON 게시판은 share_to_gallery=1 로 저장되어야');
  assert.equal(off.share_to_gallery, 0, '연동OFF 게시판은 share_to_gallery=0 으로 저장되어야 (끌 수 있어야 한다)');
  assert.equal(shouldLinkPostToGallery(on), true, '판정 함수도 ON 을 켜짐으로 봐야');
  assert.equal(shouldLinkPostToGallery(off), false, '판정 함수도 OFF 를 꺼짐으로 봐야');
  // board_id 없는 레거시 글(board=null)은 따를 설정이 없으므로 연동하지 않는다(확정 방침)
  assert.equal(shouldLinkPostToGallery(null), false, 'board_id 없는 레거시 글은 연동 대상이 아니어야');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG1: 게시판 설정이 꺼져 있으면 갤러리 글을 써도 student_gallery 행이 생기지 않는다.
//   ← 이전 구현은 category==='gallery' 면 무조건 연동해 끄는 방법이 아예 없었다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG1: 연동 OFF 게시판 — 갤러리 글을 써도 student_gallery 행이 생기지 않는다', async () => {
  const postId = await writePost(BOARD_OFF, {
    title: `${TAG}-off`,
    content: `<p>끄기 검증</p><img src="/uploads/board/${TAG}-off.png">`,
    image_url: `/uploads/board/${TAG}-off-file.jpg`,
  });
  // 픽스처 전제: 이 글은 실제로 미디어를 갖고 있다(= 설정만 아니면 연동됐을 글)
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');
  assert.equal(post.category, 'gallery', '갤러리 게시판 글이므로 category=gallery 여야 (전제)');
  assert.ok(extractPostMedia(post).length > 0, '연동됐다면 넘겼을 미디어가 실제로 있어야 (전제)');

  assert.equal(galleryRowOf(postId), null, '연동 OFF 게시판 글은 나도예술가에 행이 생기면 안 된다');

  // 승인해도 생기면 안 된다
  await approvePost(postId);
  assert.equal(galleryRowOf(postId), null, '승인 후에도 연동 OFF 게시판 글은 행이 생기면 안 된다');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG2: 켜져 있으면 승인 시 행이 생기고 approval_status='approved'.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG2: 연동 ON 게시판 — 작성 시 pending, 개설자 승인 시 approved', async () => {
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-on`,
    content: '<p>승인 흐름 검증</p>',
    image_url: `/uploads/board/${TAG}-on.png`,
  });
  const before = galleryRowOf(postId);
  assert.ok(before, '연동 ON 게시판 글은 작성 즉시 나도예술가 행이 생겨야');
  assert.equal(before.approval_status, 'pending', '승인 전에는 pending 이어야 (나도예술가 승인 원칙)');
  assert.equal(before.source, 'board', 'source=board 로 표기되어야');
  assert.equal(before.student_id, STUDENT1, '작품 소유자는 글 작성자여야');

  await approvePost(postId);

  const after = galleryRowOf(postId);
  assert.ok(after, '승인 후에도 행이 있어야');
  assert.equal(after.approval_status, 'approved', '개설자 승인 시 approved 로 전환되어야');
  assert.equal(after.approved_by, TEACHER, '승인자가 기록되어야');
  assert.ok(after.approved_at, '승인 시각이 기록되어야');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG3: ★ 사용자 지적의 직접 재현.
//   본문 에디터(Quill)에 넣은 이미지가 연동된다 — placeholder 가 아니라 실제 URL.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG3: 본문 에디터에 넣은 이미지가 연동된다 (placeholder 아님)', async () => {
  const IMG = `/uploads/board/${TAG}-inline.png`;
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-inline`,
    content: `<p>본문에 직접 넣은 그림</p><img src="${IMG}"><p>끝</p>`,
    // ★ image_url 을 보내지 않는다 — 이것이 "본문 에디터로만 넣은" 경우다
  });

  // 픽스처 전제: image_url 이 정말로 비어 있어야 이 테스트가 의미를 갖는다
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');
  assert.ok(!post.image_url, '이 케이스의 전제 — post.image_url 은 비어 있어야 (본문에만 넣음)');
  assert.match(String(post.content), /<img[^>]+src=/i, '이 케이스의 전제 — 본문에 <img> 가 있어야');

  const row = galleryRowOf(postId);
  assert.ok(row, '본문 이미지만 있는 글도 나도예술가 행이 생겨야');
  assert.notEqual(row.image_url, '/images/placeholder.png', '존재하지 않는 placeholder 로 대체되면 안 된다(= 빈 이미지 증상)');
  assert.equal(row.image_url, IMG, '대표 이미지는 본문에서 뽑은 실제 이미지 URL 이어야');

  const atts = attachmentsOf(row.id);
  assert.equal(atts.length, 1, '본문 이미지 1개가 gallery_attachments 에 들어가야');
  assert.equal(atts[0].type, 'image', '첨부 타입은 image');
  assert.equal(atts[0].url, IMG, '첨부 URL 은 본문 이미지 URL');
  assert.equal(atts[0].mime, 'image/png', 'mime 이 확장자에서 추정되어야');
  // 미디어가 있는 작품은 "작품 본문" 블록을 채우지 않는다 — 채우면 상세에서 소개문과 똑같이 두 번 보인다
  assert.equal(row.body_text, null, '미디어가 있는 작품은 body_text 를 비워 상세 중복 표시를 막아야');
  assert.match(String(row.description || ''), /본문에 직접 넣은 그림/, '소개문(description)에는 본문 텍스트가 들어가야');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG4: 동영상·음원이 type·mime 과 함께 gallery_attachments 에 들어간다.
//   "이미지 및 동영상, 음원 등" — 사용자 확정 사양.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG4: 동영상·음원·YouTube 가 type·mime 과 함께 연동된다', async () => {
  const VID = `/uploads/board/${TAG}-clip.mp4`;
  const AUD = `/uploads/board/${TAG}-song.mp3`;
  const YT = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-media`,
    content:
      `<p>영상</p><video controls><source src="${VID}" type="video/mp4"></video>` +
      `<p>음원</p><audio controls src="${AUD}"></audio>` +
      `<iframe class="ql-video" src="${YT}"></iframe>`,
  });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');
  assert.match(String(post.content), /<video[\s\S]*<audio[\s\S]*<iframe/i, '전제 — 본문에 video·audio·iframe 이 모두 있어야');

  const row = galleryRowOf(postId);
  assert.ok(row, '동영상·음원 글도 나도예술가 행이 생겨야');

  const atts = attachmentsOf(row.id);
  const byType = atts.reduce((m, a) => { (m[a.type] = m[a.type] || []).push(a); return m; }, {});
  assert.equal(atts.length, 3, `영상·음원·YouTube 3건이 모두 들어가야 (실제=${JSON.stringify(atts)})`);
  assert.equal((byType.video || []).length, 1, '동영상 1건');
  assert.equal((byType.audio || []).length, 1, '음원 1건');
  assert.equal((byType.youtube || []).length, 1, 'YouTube 1건');
  assert.equal(byType.video[0].url, VID, '동영상 URL 일치');
  assert.equal(byType.video[0].mime, 'video/mp4', '동영상 mime');
  assert.equal(byType.audio[0].url, AUD, '음원 URL 일치');
  assert.equal(byType.audio[0].mime, 'audio/mpeg', '음원 mime');
  assert.equal(byType.youtube[0].url, YT, 'YouTube URL 일치');
  // 이미지가 하나도 없는 미디어 글 — 대표 이미지는 placeholder 로 채우지 않는다
  assert.notEqual(row.image_url, '/images/placeholder.png', '이미지가 없어도 존재하지 않는 placeholder 를 넣으면 안 된다');
  assert.equal(row.type, 'mixed', '영상+음원+YouTube 혼합이므로 대표 타입은 mixed');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG5: 대표 image_url == 첫 image attachment (gallery.html:2546 규약).
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG5: 대표 image_url 은 첫 번째 image 첨부와 같다', async () => {
  const FILE_IMG = `/uploads/board/${TAG}-cover.jpg`;
  const BODY_IMG1 = `/uploads/board/${TAG}-b1.png`;
  const BODY_IMG2 = `/uploads/board/${TAG}-b2.png`;
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-cover`,
    image_url: FILE_IMG,
    content: `<p>여러 장</p><img src="${BODY_IMG1}"><img src="${BODY_IMG2}">`,
  });

  const row = galleryRowOf(postId);
  assert.ok(row, '행이 생겨야');
  const atts = attachmentsOf(row.id);
  const images = atts.filter(a => a.type === 'image');
  assert.ok(images.length >= 2, `전제 — image 첨부가 2건 이상이어야 (실제=${images.length})`);
  assert.equal(atts.length, 3, '파일 선택 1 + 본문 2 = 3건이 모두 들어가야');
  assert.equal(row.image_url, images[0].url, '대표 image_url 은 첫 image 첨부여야');
  assert.equal(row.image_url, FILE_IMG, '파일 선택분이 sort_order 0 이므로 대표가 되어야');
  assert.deepEqual(atts.map(a => a.sort_order), [0, 1, 2], 'sort_order 가 0부터 연속이어야');
  assert.equal(row.type, 'image', '전부 이미지이므로 대표 타입은 image');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG6 (과잉 차단 방지): 파일 선택으로 올리던 기존 방식이 여전히 동작한다.
//   본문 에디터 지원을 넣다가 잘 되던 경로를 깨뜨리면 안 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG6: 파일 선택(image_url) 업로드 방식이 여전히 동작한다 — 회귀 없음', async () => {
  const IMG = `/uploads/board/${TAG}-fileonly.jpeg`;
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-fileonly`,
    image_url: IMG,
    content: '<p>본문에는 이미지가 없다</p>',
  });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');
  assert.equal(post.image_url, IMG, '전제 — 파일 선택 업로드 URL 이 posts.image_url 에 있어야');
  assert.doesNotMatch(String(post.content || ''), /<img/i, '전제 — 본문에는 <img> 가 없어야');

  const row = galleryRowOf(postId);
  assert.ok(row, '파일 선택 업로드 글도 나도예술가 행이 생겨야');
  assert.equal(row.image_url, IMG, '대표 이미지는 파일 선택 업로드 URL');
  const atts = attachmentsOf(row.id);
  assert.equal(atts.length, 1, '첨부 1건');
  assert.equal(atts[0].type, 'image', '첨부 타입 image');
  assert.equal(atts[0].url, IMG, '첨부 URL 일치');

  await approvePost(postId);
  assert.equal(galleryRowOf(postId).approval_status, 'approved', '승인 후 approved');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG7: 미디어가 하나도 없는 글 — placeholder 빈 카드를 만들지 않는다.
//   글만 있으면 "글 작품(writing)" 으로, 글도 미디어도 없으면 연동 자체를 건너뛴다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG7: 미디어 없는 글 — placeholder 카드 대신 글 작품(writing) 으로 연동', async () => {
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-textonly`,
    content: '<p>봄이 오면 나는 창밖을 본다.</p><p>초록이 번진다.</p>',
  });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');
  assert.equal(extractPostMedia(post).length, 0, '전제 — 미디어가 0건이어야');

  const row = galleryRowOf(postId);
  assert.ok(row, '글만 있는 작품도 연동되어야');
  assert.equal(row.type, 'writing', '미디어 없이 글만 있으면 대표 타입은 writing');
  assert.notEqual(row.image_url, '/images/placeholder.png', '없는 placeholder 파일을 넣으면 안 된다(빈 이미지 증상)');
  assert.equal(row.image_url, '', '이미지가 없으면 빈 문자열 — gallery.html 이 이모지 카드로 렌더한다');
  assert.match(String(row.body_text || ''), /봄이 오면/, '본문 텍스트가 작품 본문으로 옮겨져야');
  assert.equal(attachmentsOf(row.id).length, 0, '미디어가 없으므로 첨부는 0건');
  // 감리 R2 — description 과 body_text 가 같은 글이면 상세 모달에 본문이 두 번 보인다.
  assert.equal(row.description, null, '글 작품은 소개문(description)을 비워 본문 중복 노출을 막아야');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG7c: description(소개문) 과 body_text("작품 본문") 는 **상호배타**다.
//   둘 다 같은 문자열로 채우면 나도예술가 상세 모달이 같은 글을 두 번 보여준다.
//   (2026-08-20 감리 R2 실측: type='writing' 작품에서 본문 2회 노출)
//   ⚠ notEqual 만으로는 "둘 다 null" 을 못 걸러 무의미해질 수 있으므로
//     "정확히 하나만 채워져 있다"를 단언한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG7c: 글 작품·미디어 작품 모두 description/body_text 가 동시에 채워지지 않는다', async () => {
  const TEXT = '두 번 보이면 안 되는 본문';

  // ① 글만 있는 작품 → body_text 에만
  const pWriting = await writePost(BOARD_ON, {
    title: `${TAG}-excl-writing`, content: `<p>${TEXT}</p>`,
  });
  const wRow = galleryRowOf(pWriting);
  assert.ok(wRow, '글 작품 행이 생겨야 (전제)');
  assert.equal(wRow.type, 'writing', '전제 — 글 작품이어야');
  assert.match(String(wRow.body_text || ''), /두 번 보이면/, '글 작품은 작품 본문에 글이 담겨야');
  assert.equal(wRow.description, null, '글 작품의 소개문은 비어야 (본문과 중복 금지)');
  assert.notEqual(wRow.description, wRow.body_text, '소개문과 본문이 같은 문자열이면 안 된다');

  // ② 미디어 + 글이 있는 작품 → description 에만
  const pMedia = await writePost(BOARD_ON, {
    title: `${TAG}-excl-media`, content: `<p>${TEXT}</p>`,
    image_url: `/uploads/board/${TAG}-excl.png`,
  });
  const mRow = galleryRowOf(pMedia);
  assert.ok(mRow, '미디어 작품 행이 생겨야 (전제)');
  assert.equal(attachmentsOf(mRow.id).length, 1, '전제 — 첨부가 1건이어야');
  assert.match(String(mRow.description || ''), /두 번 보이면/, '미디어 작품은 글이 소개문으로 담겨야');
  assert.equal(mRow.body_text, null, '미디어 작품의 작품 본문은 비어야 (소개문과 중복 금지)');

  // 둘 다 "정확히 하나만 채워짐"
  for (const [label, row] of [['글 작품', wRow], ['미디어 작품', mRow]]) {
    const filled = [row.description, row.body_text].filter(v => v != null && String(v).trim() !== '').length;
    assert.equal(filled, 1, `${label}: description/body_text 중 정확히 하나만 채워져야 (실제 ${filled}개)`);
  }
});

test('INV-BG7b: 미디어도 글도 없는 글 — 연동 자체를 건너뛴다', async () => {
  const postId = await writePost(BOARD_ON, { title: `${TAG}-empty`, content: '<p><br></p>' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');
  assert.equal(extractPostMedia(post).length, 0, '전제 — 미디어 0건');
  assert.equal(boardGallery.describePostAsArtwork(post).linkable, false, '전제 — 올릴 내용이 없다고 판정되어야');
  assert.equal(galleryRowOf(postId), null, '올릴 내용이 없으면 나도예술가 행을 만들지 않는다');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG8: 게시판 설정을 끄면 그 이후 글이 실제로 연동되지 않는다(수정 경로).
//   설정 저장만 되고 판정에 반영되지 않으면 "끌 수 있다"가 거짓말이 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG8: 게시판 수정으로 연동을 끄면 이후 글이 연동되지 않는다', async () => {
  const boardRes = await request('POST', `/api/board/${CLASS}/boards`, TEACHER, {
    name: `${TAG}-토글`, board_type: 'gallery', share_to_gallery: 1,
  });
  assert.equal(boardRes.status, 201, '토글용 게시판 생성');
  const bid = boardRes.json.board.id;
  assert.equal(boardDb.getBoardById(bid).share_to_gallery, 1, '전제 — 처음엔 켜져 있어야');

  const p1 = await writePost(bid, { title: `${TAG}-t1`, image_url: `/uploads/board/${TAG}-t1.png` });
  assert.ok(galleryRowOf(p1), '켜져 있을 때 쓴 글은 연동되어야');

  const upd = await request('PUT', `/api/board/${CLASS}/boards/${bid}`, TEACHER, { share_to_gallery: 0 });
  assert.equal(upd.status, 200, '게시판 수정 200');
  assert.equal(boardDb.getBoardById(bid).share_to_gallery, 0, '수정 후 꺼져 있어야');

  const p2 = await writePost(bid, { title: `${TAG}-t2`, image_url: `/uploads/board/${TAG}-t2.png` });
  assert.equal(galleryRowOf(p2), null, '끈 뒤에 쓴 글은 연동되면 안 된다');
  assert.ok(galleryRowOf(p1), '이미 만들어진 작품은 그대로 남아야(소급 삭제 금지)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG9: 연동 ON 게시판은 승인 필요가 강제된다.
//   승인이 나도예술가 게시의 게이트라는 확정 사양 — 승인 단계가 없으면
//   미검토 작품이 그대로 공개되어 나도예술가 승인 원칙과 충돌한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG9: 연동 ON 이면 requires_approval 이 강제된다', async () => {
  const r = await request('POST', `/api/board/${CLASS}/boards`, TEACHER, {
    name: `${TAG}-승인강제`, board_type: 'gallery', share_to_gallery: 1, requires_approval: 0,
  });
  assert.equal(r.status, 201, '게시판 생성 201');
  const b = boardDb.getBoardById(r.json.board.id);
  assert.equal(b.share_to_gallery, 1, '연동 ON');
  assert.equal(b.requires_approval, 1, '연동 ON 이면 requires_approval=0 을 보내도 1 로 강제되어야');

  const postId = await writePost(b.id, { title: `${TAG}-강제`, image_url: `/uploads/board/${TAG}-f.png` });
  const post = db.prepare('SELECT approval_status FROM posts WHERE id = ?').get(postId);
  assert.equal(post.approval_status, 'pending', '연동 게시판 글은 승인 대기로 생성되어야');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BG10: 승인 시 누락 보정 — 첨부가 비어 있던 행은 승인 시점에 채워진다.
//   레거시(placeholder 로 만들어진) 행이 승인을 거치면 되살아나야 한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-BG10: 첨부가 빈 기존 행은 승인 시 본문 미디어로 채워진다', async () => {
  const IMG = `/uploads/board/${TAG}-legacy.png`;
  const postId = await writePost(BOARD_ON, {
    title: `${TAG}-legacy`,
    content: `<p>레거시</p><img src="${IMG}">`,
  });
  const row = galleryRowOf(postId);
  assert.ok(row, '행이 생겨야');

  // 레거시 상태 재현 — 첨부를 비우고 대표 이미지를 placeholder 로 되돌린다
  db.prepare('DELETE FROM gallery_attachments WHERE gallery_id = ?').run(row.id);
  db.prepare("UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = ?").run(row.id);
  assert.equal(attachmentsOf(row.id).length, 0, '전제 — 첨부가 비워졌어야');
  assert.equal(galleryRowOf(postId).image_url, '/images/placeholder.png', '전제 — placeholder 로 되돌아갔어야');

  await approvePost(postId);

  const after = galleryRowOf(postId);
  assert.equal(after.approval_status, 'approved', '승인 처리');
  assert.equal(after.image_url, IMG, '승인 시 대표 이미지가 본문 미디어로 되살아나야');
  const atts = attachmentsOf(row.id);
  assert.equal(atts.length, 1, '승인 시 첨부가 채워져야');
  assert.equal(atts[0].url, IMG, '채워진 첨부 URL 일치');
});

// ══════════════════════════════════════════════════════════════════════════
// INV-BG11 — 마이그레이션(class_boards.share_to_gallery) 회귀 박제.
//
//   이번 배포의 **최고위험 항목**이다. 되돌리기 어려운 스키마 변경인데
//   2026-08-20 감리 시점까지 test/ 에 단언이 하나도 없었다(지적 R3).
//   감리가 손으로 확인한 것(컬럼 생성·기존 갤러리 12건 백필·일반 게시판 비오염·2차 기동 멱등)을
//   그대로 하네스에 박제한다.
//
//   방식: 컬럼이 **없던 시절의 DB** 를 사본으로 재현(ALTER TABLE DROP COLUMN +
//        _migrations 행 삭제) → 별도 프로세스로 initSchema() 를 돌린다.
//        db/index.js 가 require 시점에 DB_PATH 를 1회만 읽으므로, 같은 프로세스에서는
//        다른 DB 를 대상으로 initSchema() 를 돌릴 수 없다 → 자식 프로세스가 유일한 방법.
// ══════════════════════════════════════════════════════════════════════════
const ROOT = nodePath.join(__dirname, '..');
const MIG_NAME = 'class_boards_share_to_gallery_backfill_2026_08_20';

/** 격리 DB 를 다시 한 벌 복사하고, share_to_gallery 마이그레이션 "이전" 상태로 되돌린다. */
function makePreMigrationDb() {
  const dest = nodePath.join(os.tmpdir(), `dacheum_mig_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
  const src = new Database(nodePath.resolve(process.env.DB_PATH), { readonly: true });
  src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  src.close();
  const d = new Database(dest);
  d.exec('ALTER TABLE class_boards DROP COLUMN share_to_gallery');
  d.prepare('DELETE FROM _migrations WHERE name = ?').run(MIG_NAME);
  // ★ 백필 감지력 확보용 시드 — **승인 필요가 꺼진 갤러리 게시판**.
  //   실 DB 에는 이 조합이 0건이라, 시드 없이는 "requires_approval 도 함께 세운다" 단언이
  //   항상 참이 되어(전부 이미 1) 산식을 지우든 말든 안 붉어진다(= 민감도 0).
  //   2026-08-20 역주입에서 M4 가 실제로 감지되지 않아 이 시드를 추가했다.
  const cls = d.prepare('SELECT id FROM classes ORDER BY id LIMIT 1').get();
  const seeded = d.prepare(`
    INSERT INTO class_boards (class_id, name, board_type, requires_approval, sort_order)
    VALUES (?, 'INV-BG11 승인꺼짐 갤러리', 'gallery', 0, 99)
  `).run(cls.id).lastInsertRowid;
  d.close();
  return { path: dest, seededBoardId: Number(seeded) };
}

/** 자식 프로세스에서 그 DB 를 대상으로 initSchema() 1회 실행. stdout+stderr 를 돌려준다. */
function runInitSchemaOn(dbPath) {
  return execFileSync(
    process.execPath,
    ['-e', "require('./db/schema').initSchema();"],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function boardShareSnapshot(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const cols = d.prepare('PRAGMA table_info(class_boards)').all().map(c => c.name);
  // 마이그레이션 "이전" 사본에는 컬럼이 없다 — 그 상태에서도 스냅샷을 찍을 수 있어야 한다.
  const shareExpr = cols.includes('share_to_gallery') ? 'COALESCE(share_to_gallery, -1)' : '-1';
  const rows = d.prepare(`
    SELECT id, board_type, ${shareExpr} AS share, COALESCE(requires_approval, -1) AS ra
      FROM class_boards ORDER BY id
  `).all();
  const migs = d.prepare('SELECT COUNT(*) AS c FROM _migrations WHERE name = ?').get(MIG_NAME).c;
  d.close();
  return { cols, rows, migs };
}

test('INV-BG11: 마이그레이션 — 컬럼 생성 + 기존 갤러리 게시판 백필 + 일반 게시판 비오염', () => {
  const { path: p, seededBoardId } = makePreMigrationDb();
  try {
    // 전제: 정말로 "컬럼 없던 시절" 인가 (이 전제가 깨지면 아래 단언이 전부 공회전한다)
    const before = boardShareSnapshot(p);
    const seedBefore = before.rows.find(r => r.id === seededBoardId);
    assert.ok(seedBefore, '전제 — 승인꺼짐 갤러리 시드가 있어야');
    assert.equal(seedBefore.ra, 0, '전제 — 시드는 requires_approval=0 이어야 (백필 감지력의 근거)');
    assert.equal(before.cols.includes('share_to_gallery'), false, '전제 — 사본에 share_to_gallery 컬럼이 없어야');
    assert.equal(before.migs, 0, '전제 — 백필 마이그레이션 이력이 없어야');
    const galleryIds = before.rows.filter(r => r.board_type === 'gallery').map(r => r.id);
    const generalIds = before.rows.filter(r => r.board_type === 'general').map(r => r.id);
    assert.ok(galleryIds.length > 0, `전제 — 백필 대상 갤러리 게시판이 있어야 (실제 ${galleryIds.length}개)`);
    assert.ok(generalIds.length > 0, `전제 — 오염 여부를 볼 일반 게시판이 있어야 (실제 ${generalIds.length}개)`);

    const log = runInitSchemaOn(p);

    // ① 컬럼이 생긴다
    const after = boardShareSnapshot(p);
    assert.equal(after.cols.includes('share_to_gallery'), true, 'initSchema 후 share_to_gallery 컬럼이 있어야');

    // ② 기존 board_type='gallery' 는 전부 1 로 백필된다 (지금까지 되던 연동이 끊기면 안 된다)
    const byId = new Map(after.rows.map(r => [r.id, r]));
    for (const id of galleryIds) {
      assert.equal(byId.get(id).share, 1, `갤러리 게시판 id=${id} 는 share_to_gallery=1 로 백필되어야`);
      // share=1 ⇒ requires_approval=1 불변식(db/board.js 가 생성·수정 때 강제하는 것과 동일)
      assert.equal(byId.get(id).ra, 1, `갤러리 게시판 id=${id} 는 승인 필요도 함께 세워져야 (유령 작품 방지)`);
    }
    // 승인꺼짐 시드가 실제로 1 로 올라갔는가 — 이 한 건이 백필 산식의 감지기다.
    //   (안 세우면: 글은 즉시 approved 인데 작품은 pending → 영원히 안 보이는 유령 작품)
    assert.equal(byId.get(seededBoardId).ra, 1,
      '승인 필요가 꺼져 있던 갤러리 게시판이 백필에서 requires_approval=1 로 올라가지 않았다');
    assert.equal(byId.get(seededBoardId).share, 1, '승인꺼짐 시드도 share_to_gallery=1 이어야');

    // ③ 일반 게시판은 0 그대로 — 백필이 번지면 안 된다
    for (const id of generalIds) {
      assert.equal(byId.get(id).share, 0, `일반 게시판 id=${id} 는 share_to_gallery=0 이어야 (백필 오염 금지)`);
    }

    // ④ 백필 건수 로그가 실제 대상 수와 일치
    assert.match(log, new RegExp(`백필: ${galleryIds.length}건`),
      `백필 로그가 대상 ${galleryIds.length}건과 일치해야 (실제 로그: ${log.trim().slice(0, 200)})`);
    assert.equal(after.migs, 1, '_migrations 에 백필 이력이 1행 남아야');
  } finally {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + ext); } catch (_) {} }
  }
});

test('INV-BG11b: 마이그레이션 멱등 — 두 번 기동해도 백필이 다시 돌지 않는다', () => {
  const { path: p } = makePreMigrationDb();
  try {
    const log1 = runInitSchemaOn(p);
    assert.match(log1, /백필: \d+건/, '전제 — 1차 기동에서는 백필이 실제로 돌아야');
    const s1 = boardShareSnapshot(p);
    assert.equal(s1.migs, 1, '전제 — 1차 후 _migrations 1행');

    // 사람이 나중에 끈 설정을 2차 기동이 되살리면 안 된다 → 갤러리 1건을 0 으로 되돌려 둔다
    const galleryId = s1.rows.filter(r => r.board_type === 'gallery').map(r => r.id)[0];
    assert.ok(galleryId != null, '전제 — 갤러리 게시판이 있어야');
    {
      const d = new Database(p);
      d.prepare('UPDATE class_boards SET share_to_gallery = 0 WHERE id = ?').run(galleryId);
      d.close();
    }

    const log2 = runInitSchemaOn(p);
    assert.equal(/백필: \d+건/.test(log2), false,
      `2차 기동에서는 백필 로그가 없어야 (_migrations 가드). 실제: ${log2.trim().slice(0, 200)}`);

    const s2 = boardShareSnapshot(p);
    assert.equal(s2.migs, 1, '_migrations 행은 여전히 1개여야 (중복 삽입 금지)');
    const after = new Map(s2.rows.map(r => [r.id, r]));
    assert.equal(after.get(galleryId).share, 0,
      '2차 기동이 사람이 끈 설정(share_to_gallery=0)을 되살리면 안 된다');
  } finally {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + ext); } catch (_) {} }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// INV-BG12 — 미디어 종류 판정 SSOT(public/js/media-kind.js).
//
//   2026-08-20 감리 R1: image_url 에 mp4·mp3 가 들어갈 수 있게 넓혀 놓고
//   그것을 <img> 로 그리는 4곳(목록·카드·상세·승인대기) 중 2곳만 고쳤다 →
//   게시글 상세에 16×16 깨진 이미지가 노출.
//   판정을 화면마다 베끼면 또 갈라지므로 **파일 한 벌**로 못 박는다.
//   FE 도 이 파일을 <script> 로 직접 읽으므로, BE 에서 이 단언이 통과하면
//   네 화면이 같은 판정을 쓴다는 뜻이다.
// ══════════════════════════════════════════════════════════════════════════
test('INV-BG12: 미디어 판정은 public/js/media-kind.js 한 곳에서만 나온다', () => {
  const M = require('../public/js/media-kind');
  const lib = require('../lib/board-gallery-link');

  // ① BE(lib) 가 SSOT 를 그대로 쓴다 — 사본을 두면 이 동일성이 깨진다
  assert.equal(lib.MediaKind, M, 'lib/board-gallery-link.js 는 media-kind.js 를 그대로 재노출해야');
  assert.equal(lib.classifyUrl, M.mediaKindOf, '타입 판정 함수가 SSOT 와 동일 참조여야');

  // ② 종류 판정
  assert.equal(M.mediaKindOf('/uploads/board/a.png'), 'image', 'png=이미지');
  assert.equal(M.mediaKindOf('/uploads/board/a.MP4'), 'video', 'mp4=동영상(대소문자 무관)');
  assert.equal(M.mediaKindOf('/uploads/board/a.mp3'), 'audio', 'mp3=음원');
  assert.equal(M.mediaKindOf('/uploads/board/a.wav?v=2'), 'audio', '쿼리스트링이 붙어도 음원');
  assert.equal(M.mediaKindOf('https://youtu.be/abc123'), 'youtube', '유튜브 링크');
  assert.equal(M.mediaKindOf('/api/file/9', 'image'), 'image', '확장자 없으면 태그 힌트를 따른다');
  assert.equal(M.mediaKindOf(''), null, '빈 값은 판정 없음');

  // ③ 비이미지를 <img> 로 그리지 못하게 — 상세·목록·카드·승인대기가 전부 이 함수로 거른다
  assert.equal(M.asImageUrl('/uploads/board/a.png'), '/uploads/board/a.png', '이미지는 통과');
  assert.equal(M.asImageUrl('/uploads/videos/clip-test.mp4'), null,
    '동영상을 <img src> 로 쓰면 16×16 깨진 이미지가 된다 — 반드시 null');
  assert.equal(M.asImageUrl('/uploads/audio/song.mp3'), null, '음원도 <img> 대상이 아니다');

  // ④ 비이미지는 종류 아이콘·라벨이 나온다 (교사가 승인 대기에서 종류를 구분해야 한다)
  assert.equal(M.nonImageKindMeta('/uploads/board/a.png'), null, '이미지는 아이콘 폴백 대상이 아니다');
  assert.deepEqual(M.nonImageKindMeta('/u/a.mp4'), { icon: 'fa-video', label: '동영상', emoji: '🎬' }, '동영상 라벨');
  assert.deepEqual(M.nonImageKindMeta('/u/a.mp3'), { icon: 'fa-music', label: '음원', emoji: '🎵' }, '음원 라벨');

  // ⑤ 존재하지 않는 자리표시자 = "미디어 없음" (사용자가 지목한 '빈 이미지')
  for (const ph of ['/images/placeholder.png', '/images/placeholder-art.png', '/uploads/placeholder.jpg']) {
    assert.equal(M.isPlaceholderUrl(ph), true, `${ph} 는 자리표시자로 인식되어야`);
    assert.equal(M.mediaKindOf(ph), null, `${ph} 는 미디어 없음으로 판정되어야`);
    assert.equal(M.asImageUrl(ph), null, `${ph} 를 <img> 로 그리면 404 깨진 이미지가 된다`);
  }
  assert.equal(M.asImageUrl('/uploads/images/my-placeholder.png'), '/uploads/images/my-placeholder.png',
    '이름에 placeholder 가 들어간 실제 업로드 파일까지 지우면 안 된다');
});

test('INV-BG12b: class-home.html 4개 렌더 지점이 SSOT 만 쓴다 (판정 사본 금지)', () => {
  const html = fs.readFileSync(nodePath.join(ROOT, 'public', 'class', 'class-home.html'), 'utf8');

  // 전제 — SSOT 스크립트를 실제로 싣고 있어야 window.DacheumMedia 가 존재한다
  assert.match(html, /<script src="\/js\/media-kind\.js"><\/script>/,
    'class-home.html 이 /js/media-kind.js 를 로드해야');

  // 판정 사본 금지 — 확장자 목록을 화면 코드에 다시 적으면 이번 결함이 그대로 재발한다
  const copies = html.match(/\((?:png\|jpe\?g|mp4\|webm|mp3\|wav)[^)]*\)/gi) || [];
  assert.deepEqual(copies, [],
    `class-home.html 에 미디어 확장자 판정 사본이 있으면 안 된다 (발견: ${copies.join(' , ')})`);

  // 네 렌더 지점이 전부 SSOT 파생 헬퍼를 쓴다
  assert.match(html, /function asImageThumb\(url\) \{ return window\.DacheumMedia\.asImageUrl\(url\); \}/,
    'asImageThumb 는 SSOT 위임이어야');
  assert.match(html, /function mediaKindIcon\(url\) \{ return window\.DacheumMedia\.nonImageKindMeta\(url\); \}/,
    'mediaKindIcon 은 SSOT 위임이어야');
  assert.match(html, /const mediaHtml = postMediaHtml\(p\.image_url\);/,
    '게시글 상세(openPost)가 종류별 렌더(postMediaHtml)를 써야 — 예전엔 무조건 <img> 였다');
  assert.match(html, /\$\{mediaThumbHtml\(p\.image_url, 48, p\.content\)\}/,
    '승인 대기 목록이 종류 아이콘 폴백(mediaThumbHtml)을 써야');

  // 상세가 다시 무조건 <img> 로 돌아가지 않았는지 — 그 코드가 정확히 이번 결함이었다
  assert.equal(/postDetailImage'\);\s*\n\s*if \(p\.image_url\) \{\s*\n\s*imgEl\.querySelector\('img'\)\.src/.test(html), false,
    'openPost 가 image_url 을 무조건 <img src> 로 넣던 코드로 되돌아가면 안 된다');
});

// ══════════════════════════════════════════════════════════════════════════
// INV-BG13~15 — 본문 붙여넣기 이미지(data:base64)를 **저장 시점에 파일로** 바꾼다.
//
// 발단(사용자 실측 2026-08-21 · GCP 정본 student_gallery 41~48 / posts 98~105):
//   교사가 갤러리 게시판에 작품 8건을 올려 승인까지 했는데
//     · 채움클래스 갤러리 → 이미지가 보인다(본문 첫 <img> 를 그리므로 base64 도 렌더)
//     · 나도예술가        → 팔레트 이모지(빈 이미지)
//   이미지가 파일이 아니라 본문에 data:image/png;base64,… 로 박혀 있었기 때문이다
//   (Quill 에디터 붙여넣기). base64 를 그대로 두면
//     ⓐ gallery_attachments.url 은 1000자로 잘려 **깨진 URL** 이 되고
//     ⓑ posts.content 가 비대해지고 ⓒ 목록 API 가 무거워진다.
//   → 근본 처방은 **데이터가 들어오는 문 앞에서 파일로 바꾸는 것**이다.
//
// ⚠ 단언을 조건문 안에 가두지 않는다. 각 테스트는 "픽스처 전제"를 최상위에서 먼저 단언한다.
// ══════════════════════════════════════════════════════════════════════════
const uploadRules = require('../lib/upload-rules');
const inlineMedia = require('../lib/inline-data-media');

// 16×16 투명 PNG (실제 디코딩 가능한 바이트 — 가짜 문자열이면 파일 검증이 무의미해진다)
const PNG_B64 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff610000001f' +
  '49444154388dedcd310100200c00b0f4bf9c0e0c1e2c0000000000000000f80d0a0f0a0100' +
  '016b7a2f0000000049454e44ae426082', 'hex').toString('base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

/** 변환으로 생긴 업로드 파일 — 테스트가 끝나면 지운다(정본 uploads 오염 방지). */
const CREATED_FILES = [];
function absOfUploadUrl(url) {
  return nodePath.join(ROOT, 'public', String(url).replace(/^\//, ''));
}
after(() => {
  for (const u of CREATED_FILES) { try { fs.unlinkSync(absOfUploadUrl(u)); } catch (_) {} }
});

test('INV-BG13: 본문에 data: 이미지만 있는 글을 저장하면 파일로 변환되고 content 에 data: 가 남지 않는다', async () => {
  // 픽스처 전제 — 우리가 보내는 본문에는 실제로 data: 이미지가 들어 있다
  const content = `<p>붙여넣기 그림</p><img src="${PNG_DATA_URL}"><p>끝</p>`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true,
    '전제 — 보내는 본문에 data: 미디어가 있어야 (없으면 이 테스트는 아무것도 검사하지 않는다)');

  const postId = await writePost(BOARD_ON, { title: `${TAG}-b64`, content });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(post, '게시글이 생성되어야');

  // ① content 에 data: 가 남으면 안 된다 — 이것이 결함의 뿌리
  assert.equal(String(post.content).includes('data:image'), false,
    `저장된 본문에 base64 가 남아 있다 (DB 비대·연동 불가). 실제=${String(post.content).slice(0, 120)}`);
  assert.equal(inlineMedia.hasInlineDataMedia(post.content), false, '저장된 본문에 data: 미디어가 남으면 안 된다');

  // ② 파일 경로로 바뀌었고 그 파일이 **실제로 존재**해야 한다 (경로만 바꾸고 안 쓰면 404 가 된다)
  const m = String(post.content).match(/<img[^>]+src="([^"]+)"/i);
  assert.ok(m, `본문에 파일 경로 <img> 가 있어야. 실제=${String(post.content).slice(0, 200)}`);
  const url = m[1];
  CREATED_FILES.push(url);
  assert.match(url, /^\/uploads\//, `변환된 이미지는 업로드 경로여야 (실제=${url})`);
  assert.equal(fs.existsSync(absOfUploadUrl(url)), true, `변환된 파일이 실제로 저장되어야: ${url}`);
  assert.ok(fs.statSync(absOfUploadUrl(url)).size > 0, '저장된 파일이 비어 있으면 안 된다');

  // ③ 대표 이미지(image_url)가 비어 있었으므로 변환된 첫 이미지로 채워져야 한다
  assert.equal(post.image_url, url, '대표 이미지가 변환된 첫 이미지로 채워져야 (나도예술가 표지가 여기서 나온다)');
});

test('INV-BG14: 그 글이 연동되면 나도예술가 image_url 이 자리표시자가 아니다', async () => {
  const content = `<p>표지 검증</p><img src="${PNG_DATA_URL}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 보내는 본문에 data: 이미지가 있어야');

  const postId = await writePost(BOARD_ON, { title: `${TAG}-b64-gallery`, content });
  await approvePost(postId);

  const row = galleryRowOf(postId);
  assert.ok(row, '연동 ON 게시판 글은 나도예술가 행이 있어야 (전제)');
  assert.equal(row.approval_status, 'approved', '승인 후 approved 여야 (전제)');

  // ★ 사용자가 본 증상의 직접 재현 — 자리표시자면 팔레트 이모지(빈 이미지)가 뜬다
  const M = require('../public/js/media-kind');
  assert.equal(M.isPlaceholderUrl(row.image_url), false,
    `나도예술가 표지가 자리표시자면 빈 이미지가 된다 (실제=${row.image_url})`);
  assert.equal(String(row.image_url).startsWith('data:'), false,
    `표지에 base64 를 넣으면 1000자에서 잘려 깨진 이미지가 된다 (실제=${String(row.image_url).slice(0, 60)})`);
  assert.match(String(row.image_url), /^\/uploads\//, '표지는 실제 업로드 파일 경로여야');
  CREATED_FILES.push(row.image_url);
  assert.equal(fs.existsSync(absOfUploadUrl(row.image_url)), true,
    `표지 파일이 서버에 실제로 있어야 (없으면 404 = 빈 이미지): ${row.image_url}`);

  // 첨부도 잘리지 않은 실제 URL 이어야 한다
  const atts = attachmentsOf(row.id);
  assert.equal(atts.length, 1, `첨부 1건이 들어가야 (실제=${JSON.stringify(atts)})`);
  assert.equal(atts[0].type, 'image', '첨부 타입은 image');
  assert.equal(atts[0].url, row.image_url, '첨부 URL 과 표지가 같은 파일이어야');
  assert.ok(atts[0].url.length < 1000, '첨부 URL 이 1000자 절단선에 걸리면 안 된다(= base64 를 넣지 않았다는 뜻)');
});

test('INV-BG15: 용량·형식 제한이 data: 경로에서도 적용된다 (검사 우회 금지)', async () => {
  // ① 기본 상한이 **업로드 규칙의 그 상한**이어야 한다 — 별도 상한을 새로 적으면 규칙이 두 벌이 된다
  const noop = inlineMedia.materializeDataUrls('<p>없음</p>');
  assert.equal(noop.changed, false, '전제 — data: 가 없으면 변환하지 않는다');
  assert.equal(uploadRules.MAX_FILE_SIZE, 50 * 1024 * 1024, '업로드 상한은 50MB');
  assert.equal(uploadRules.ALLOWED_EXT_RE.test('.svg'), false, 'svg 는 업로드 허용 목록 밖이어야 (XSS 벡터)');
  assert.equal(uploadRules.ALLOWED_EXT_RE.test('.png'), true, 'png 는 허용');

  // ② 형식 위반: svg 를 data: 로 밀어 넣으면 400 — 파일도 안 생기고 글도 안 만들어져야
  const before = db.prepare('SELECT COUNT(*) c FROM posts WHERE class_id = ?').get(CLASS).c;
  const svgUrl = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  const bad = await request('POST', `/api/board/${CLASS}`, STUDENT1, {
    board_id: BOARD_ON, title: `${TAG}-svg`, content: `<p>x</p><img src="${svgUrl}">`,
  });
  assert.equal(bad.status, 400, `허용 목록 밖 형식은 400 이어야 (실제=${bad.status} ${bad.body.slice(0, 200)})`);
  assert.equal(bad.json && bad.json.message, uploadRules.MSG_BAD_TYPE, '업로드 API 와 같은 한국어 메시지여야');
  const afterCnt = db.prepare('SELECT COUNT(*) c FROM posts WHERE class_id = ?').get(CLASS).c;
  assert.equal(afterCnt, before, '형식 위반 글은 저장되면 안 된다 (data: 가 검사를 건너뛰는 뒷문이 되면 안 된다)');

  // ③ 용량 위반: 상한을 낮춰 주입하면 TOO_LARGE 로 막히고 파일이 생기지 않아야
  const bigBuf = Buffer.alloc(4096, 7);
  const bigUrl = 'data:image/png;base64,' + bigBuf.toString('base64');
  const dirBefore = fs.readdirSync(nodePath.join(uploadRules.UPLOAD_ROOT, 'images')).length;
  assert.throws(
    () => inlineMedia.materializeDataUrls(`<img src="${bigUrl}">`, { maxBytes: 1024 }),
    (e) => e.code === 'TOO_LARGE' && e.message === uploadRules.MSG_TOO_LARGE,
    '상한을 넘는 data: 는 TOO_LARGE 로 막혀야'
  );
  const dirAfter = fs.readdirSync(nodePath.join(uploadRules.UPLOAD_ROOT, 'images')).length;
  assert.equal(dirAfter, dirBefore, '용량 위반은 파일이 생기면 안 된다');

  // ④ 개수 상한도 있어야 한다 — 붙여넣기 무한 첨부로 디스크를 채우지 못하게
  const many = new Array(inlineMedia.MAX_DATA_FILES + 1).fill(`<img src="${PNG_DATA_URL}">`).join('');
  assert.throws(
    () => inlineMedia.materializeDataUrls(many, { maxFiles: 2 }),
    (e) => e.code === 'TOO_MANY',
    '개수 상한을 넘으면 TOO_MANY 로 막혀야'
  );
});
