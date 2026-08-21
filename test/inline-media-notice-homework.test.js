// test/inline-media-notice-homework.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 알림장 · 과제 제출 본문의 붙여넣기 이미지(data:base64) 저장 관문 회귀 박제
// (INV-IM1~9). 게시판(test/board-gallery-link.test.js INV-BG13~15)과 **같은 처방**을
// 나머지 두 Quill 화면에 적용한 것을 박제한다.
//
// 발단
//   Quill 에디터에 이미지를 **붙여넣으면** 본문에 data:image/png;base64,… 가 통째로 박힌다.
//   프로젝트에 Quill 은 셋뿐이다(실측): 게시판 글(class-home.html) · 알림장(notice-board.html) ·
//   과제 제출(homework-view.html). 게시판만 고치면 나머지 둘이 같은 결함을 계속 만든다.
//   그대로 저장하면 ⓐ content 가 비대해지고 ⓑ 목록 API 가 그 본문을 통째로 실어 나르고
//   ⓒ 업로드 검사(허용 확장자·50MB)를 **한 번도 받지 않은** 바이트가 DB 에 들어온다.
//
// 이 화면들이 게시판보다 조심스러운 이유 — 그래서 무엇을 박제하는가
//   · 과제 제출은 **학생 제출물**이다. 변환이 제출 내용을 바꾸면 안 되고(INV-IM6),
//     이미 붙어 있는 **채점·피드백·제출시각**을 건드리면 안 된다(INV-IM7).
//   · 알림장은 **학부모까지 보는 화면**이다. 변환 뒤에도 읽기 경로가 그대로
//     <img src="/uploads/…"> 를 돌려줘야 한다(INV-IM2 가 읽기 API 응답으로 확인).
//
// ⚠ 단언을 조건문 안에 가두지 않는다. 각 테스트는 "픽스처 전제"를 최상위에서 먼저 단언한다
//    (픽스처가 조건을 안 타서 단언이 한 번도 실행되지 않는 함정 방지).
//
// DB 격리: 실 DB → 임시 복사본(_setup). 실 DB 무오염.
// 계정(실 DB 실측): teacher1=2(class1 owner), student1=3.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const nodePath = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터/db 모듈 require 이전에 DB_PATH 주입
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');
const homeworkDb = require('../db/homework');
const uploadRules = require('../lib/upload-rules');
const inlineMedia = require('../lib/inline-data-media');

const ROOT = nodePath.join(__dirname, '..');
const TEACHER = 2, STUDENT = 3;
const CLASS = 1;
const TAG = `IM-${process.pid}-${Date.now()}`;

let server, baseUrl, db;

// 16×16 투명 PNG (실제 디코딩 가능한 바이트 — 가짜 문자열이면 파일 검증이 무의미해진다)
const PNG_B64 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff610000001f' +
  '49444154388dedcd310100200c00b0f4bf9c0e0c1e2c0000000000000000f80d0a0f0a0100' +
  '016b7a2f0000000049454e44ae426082', 'hex').toString('base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

// ── 2000자를 넘는 **진짜 PNG** (INV-IM13 전용) ───────────────────────────────
// 위 16×16 PNG 는 data URL 이 163자뿐이라 "2000자 검사보다 관문이 먼저인가" 를 검사할 수 없다
// (첫 시도에서 픽스처 전제 단언이 이 사실을 잡아냈다). 노이즈 이미지는 압축이 안 되므로
// 48×48 RGBA 난수 픽셀이면 base64 가 넉넉히 2000자를 넘는다.
// ★ 가짜 바이트가 아니라 실제로 디코딩되는 PNG 를 만든다 — 파일 검증이 무의미해지면 안 된다.
function makeRealPng(size) {
  const zlib = require('node:zlib');
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8bit RGBA
  // 결정적 의사난수 픽셀 — 매 실행 같은 바이트(테스트 재현성), 압축은 거의 안 됨
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0, seed = 12345;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                                   // 필터 타입 None
    for (let x = 0; x < size * 4; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[p++] = (seed >>> 16) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const BIG_PNG = makeRealPng(48);
const BIG_PNG_DATA_URL = `data:image/png;base64,${BIG_PNG.toString('base64')}`;

/** 변환으로 생긴 업로드 파일 — 테스트가 끝나면 지운다(정본 uploads 오염 방지). */
const CREATED_FILES = [];
function absOfUploadUrl(url) {
  return nodePath.join(ROOT, 'public', String(url).replace(/^\//, ''));
}
/** 본문에서 <img src> 를 전부 뽑는다. */
function imgSrcs(html) {
  return [...String(html || '').matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m => m[1]);
}
/** 변환 결과 URL 하나를 "규칙대로 저장된 실제 파일"인지까지 검사한다. */
function assertMaterialized(url, what) {
  assert.match(url, /^\/uploads\//, `${what}: 변환 결과는 업로드 경로여야 (실제=${String(url).slice(0, 80)})`);
  CREATED_FILES.push(url);
  const abs = absOfUploadUrl(url);
  assert.equal(fs.existsSync(abs), true, `${what}: 변환된 파일이 실제로 저장되어야 (없으면 404 = 빈 이미지): ${url}`);
  assert.ok(fs.statSync(abs).size > 0, `${what}: 저장된 파일이 비어 있으면 안 된다`);
  assert.equal(uploadRules.isAllowedFileName(url), true, `${what}: 저장된 파일은 업로드 허용 확장자여야 (${url})`);
}

function buildApp() {
  const app = express();
  // 50MB 초과 주입(INV-IM8)을 라우터까지 보내려면 body 상한이 그보다 커야 한다.
  app.use(express.json({ limit: '80mb' }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/notice', require('../routes/notice'));
  app.use('/api/homework', require('../routes/homework'));
  return app;
}

function request(method, path, asUser, payload) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const data = payload != null ? JSON.stringify(payload) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    // agent:false — keep-alive 유휴 소켓 재사용으로 인한 ECONNRESET 회피(게시판 테스트와 동일 관례)
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

/** 교사가 알림장을 쓰고 id 를 돌려준다. */
async function writeNotice(fields) {
  const r = await request('POST', `/api/notice/${CLASS}`, TEACHER, fields);
  assert.equal(r.status, 201, `알림장 작성 201 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  return r.json.notice.id;
}
function noticeRow(id) {
  return db.prepare('SELECT * FROM notices WHERE id = ?').get(id) || null;
}

/** 댓글을 달고 응답을 그대로 돌려준다(실패 상태코드도 검사해야 하므로 단언하지 않는다). */
function postComment(noticeId, asUser, body) {
  return request('POST', `/api/notice/${CLASS}/${noticeId}/comments`, asUser, body);
}
function commentRow(id) {
  return db.prepare('SELECT * FROM notice_comments WHERE id = ?').get(id) || null;
}

/** 마감이 한참 남은 과제를 새로 만든다. */
function makeHomework(title) {
  return homeworkDb.createHomework(CLASS, TEACHER, {
    title, description: 'data: 변환 관문 회귀 박제용',
    due_date: '2099-12-31 23:59', max_score: 100, status: 'published',
  });
}
function submissionRow(homeworkId, studentId = STUDENT) {
  return db.prepare(
    'SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ?'
  ).get(homeworkId, studentId) || null;
}

before(async () => {
  db = openTestDb();
  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  for (const u of CREATED_FILES) { try { fs.unlinkSync(absOfUploadUrl(u)); } catch (_) {} }
  try { server && server.close(); } catch (_) {}
  try { db && db.close(); } catch (_) {}
});

// ══════════════════════════════════════════════════════════════════════════
// 알림장
// ══════════════════════════════════════════════════════════════════════════

test('INV-IM1: 알림장 작성 — 본문 data: 이미지가 파일로 바뀌고 content 에 data: 가 남지 않는다', async () => {
  const content = `<p>내일 준비물</p><img src="${PNG_DATA_URL}"><p>확인 부탁드립니다.</p>`;
  // 픽스처 전제 — 우리가 보내는 본문에는 실제로 data: 미디어가 들어 있다
  assert.equal(inlineMedia.hasInlineDataMedia(content), true,
    '전제 — 보내는 본문에 data: 미디어가 있어야 (없으면 이 테스트는 아무것도 검사하지 않는다)');

  const id = await writeNotice({ title: `${TAG}-작성`, content });
  const row = noticeRow(id);
  assert.ok(row, '알림장이 생성되어야');

  // ① content 에 data: 가 남으면 안 된다 — 이것이 결함의 뿌리
  assert.equal(String(row.content).includes('data:image'), false,
    `저장된 본문에 base64 가 남아 있다 (DB 비대·검사 우회). 실제=${String(row.content).slice(0, 120)}`);
  assert.equal(inlineMedia.hasInlineDataMedia(row.content), false, '저장된 본문에 data: 미디어가 남으면 안 된다');

  // ② 파일 경로로 바뀌었고 그 파일이 **실제로 존재**해야 한다
  const srcs = imgSrcs(row.content);
  assert.equal(srcs.length, 1, `본문에 <img> 1개가 남아야 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '알림장 작성');

  // ③ 무손실 — 이미지 말고는 아무것도 바뀌지 않아야 한다
  assert.equal(String(row.content).includes('내일 준비물'), true, '본문 글자가 보존되어야');
  assert.equal(String(row.content).includes('확인 부탁드립니다.'), true, '본문 뒷부분도 보존되어야');
  assert.equal(String(row.content), content.replace(PNG_DATA_URL, srcs[0]),
    'src 문자열 외에 본문이 달라지면 안 된다(무손실 치환)');
});

test('INV-IM2: 알림장 읽기 경로(학생·학부모가 보는 화면)가 변환 후에도 그림을 돌려준다', async () => {
  const content = `<p>가정통신문</p><img src="${PNG_DATA_URL}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 보내는 본문에 data: 이미지가 있어야');
  const id = await writeNotice({ title: `${TAG}-읽기`, content });

  // 알림장 상세 API — notice-board.html 이 이 응답의 content 를 그대로 innerHTML 로 그린다.
  const r = await request('GET', `/api/notice/${CLASS}/${id}`, STUDENT);
  assert.equal(r.status, 200, `학생 상세 조회 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  assert.ok(r.json && r.json.notice, '상세 응답에 notice 가 있어야 (전제)');

  const srcs = imgSrcs(r.json.notice.content);
  assert.equal(srcs.length, 1, `읽기 응답에 <img> 1개가 있어야 — 그림이 사라지면 화면이 깨진다 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '알림장 읽기');
  assert.equal(inlineMedia.hasInlineDataMedia(r.json.notice.content), false, '읽기 응답에도 data: 가 남으면 안 된다');

  // 목록 API 도 같은 본문을 싣는다 — 여기 base64 가 남으면 목록이 통째로 무거워진다
  const list = await request('GET', `/api/notice/${CLASS}?page=1`, STUDENT);
  assert.equal(list.status, 200, `목록 200 이어야 (실제=${list.status})`);
  const found = (list.json.notices || []).find(n => n.id === id);
  assert.ok(found, '방금 쓴 알림장이 목록에 있어야 (전제)');
  assert.equal(inlineMedia.hasInlineDataMedia(found.content), false, '목록 응답 본문에도 data: 가 남으면 안 된다');
});

test('INV-IM3: 알림장 수정 경로도 같은 관문을 지난다 (작성만 막으면 수정으로 다시 들어온다)', async () => {
  const id = await writeNotice({ title: `${TAG}-수정전`, content: '<p>처음 본문</p>' });
  const before = noticeRow(id);
  assert.equal(inlineMedia.hasInlineDataMedia(before.content), false, '전제 — 수정 전 본문에는 data: 가 없다');

  const patched = `<p>고친 본문</p><img src="${PNG_DATA_URL}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(patched), true, '전제 — 수정으로 보내는 본문에 data: 이미지가 있어야');

  const r = await request('PUT', `/api/notice/${CLASS}/${id}`, TEACHER, { content: patched });
  assert.equal(r.status, 200, `수정 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);

  const row = noticeRow(id);
  assert.equal(inlineMedia.hasInlineDataMedia(row.content), false, '수정 저장본에 data: 가 남으면 안 된다');
  const srcs = imgSrcs(row.content);
  assert.equal(srcs.length, 1, `수정 저장본에 <img> 1개가 있어야 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '알림장 수정');
  assert.equal(String(row.content).includes('고친 본문'), true, '수정한 글자가 보존되어야');
});

// ══════════════════════════════════════════════════════════════════════════
// 과제 제출 — 학생 제출물이라 "바뀌지 않는 것"까지 함께 박제한다
// ══════════════════════════════════════════════════════════════════════════

test('INV-IM4: 과제 제출 — 본문 data: 이미지가 파일로 바뀌고 content 에 data: 가 남지 않는다', async () => {
  const hw = makeHomework(`${TAG}-제출`);
  const content = `<p>제 풀이입니다</p><img src="${PNG_DATA_URL}"><p>끝</p>`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 보내는 제출 본문에 data: 이미지가 있어야');

  const r = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, { content });
  assert.equal(r.status, 200, `제출 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);

  const sub = submissionRow(hw.id);
  assert.ok(sub, '제출 행이 생성되어야');
  assert.equal(sub.is_draft, 0, '정식 제출이어야 (전제)');

  assert.equal(String(sub.content).includes('data:image'), false,
    `제출 본문에 base64 가 남아 있다. 실제=${String(sub.content).slice(0, 120)}`);
  assert.equal(inlineMedia.hasInlineDataMedia(sub.content), false, '제출 본문에 data: 미디어가 남으면 안 된다');

  const srcs = imgSrcs(sub.content);
  assert.equal(srcs.length, 1, `제출 본문에 <img> 1개가 남아야 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '과제 제출');

  // ★ 제출 내용이 바뀌면 안 된다 — src 외 무손실
  assert.equal(String(sub.content), content.replace(PNG_DATA_URL, srcs[0]),
    'src 문자열 외에 학생 제출 내용이 달라지면 안 된다(무손실 치환)');
});

test('INV-IM5: 교사 채점 화면(제출물 조회 API)이 변환 후에도 그림을 돌려준다', async () => {
  const hw = makeHomework(`${TAG}-채점화면`);
  const content = `<p>사진 첨부합니다</p><img src="${PNG_DATA_URL}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 보내는 제출 본문에 data: 이미지가 있어야');
  const s = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, { content });
  assert.equal(s.status, 200, `제출 200 이어야 (실제=${s.status} ${s.body.slice(0, 200)})`);

  // 교사가 과제 상세를 열면 submissions 가 실려 온다 — homework-view.html 이 이걸 그린다
  const r = await request('GET', `/api/homework/${CLASS}/${hw.id}`, TEACHER);
  assert.equal(r.status, 200, `교사 상세 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  const subs = (r.json.homework && r.json.homework.submissions) || r.json.submissions || [];
  assert.equal(subs.length, 1, `교사 화면에 제출 1건이 보여야 (실제=${subs.length})`);

  const srcs = imgSrcs(subs[0].content);
  assert.equal(srcs.length, 1, `교사 채점 화면 응답에 <img> 1개가 있어야 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '교사 채점 화면');
  assert.equal(inlineMedia.hasInlineDataMedia(subs[0].content), false, '교사 화면 응답에도 data: 가 남으면 안 된다');
});

test('INV-IM6: 과잉 차단 금지 — 일반 텍스트·기존 업로드 파일 첨부는 그대로 저장된다', async () => {
  // ① 알림장 — 순수 텍스트
  const plain = '<p>준비물: 색연필, 가위</p>';
  assert.equal(inlineMedia.hasInlineDataMedia(plain), false, '전제 — 이 본문에는 data: 가 없다');
  const nid = await writeNotice({ title: `${TAG}-평문`, content: plain });
  assert.equal(noticeRow(nid).content, plain, '평문 알림장은 한 글자도 바뀌면 안 된다');

  // ② 알림장 — 이미 업로드된 파일 경로 <img> (변환 대상이 아니다)
  const fileHtml = '<p>사진</p><img src="/uploads/images/already-1234.png">';
  assert.equal(inlineMedia.hasInlineDataMedia(fileHtml), false, '전제 — 파일 경로 본문에는 data: 가 없다');
  const nid2 = await writeNotice({ title: `${TAG}-파일경로`, content: fileHtml, attachments: [{ url: '/uploads/documents/a.pdf', name: 'a.pdf' }] });
  const row2 = noticeRow(nid2);
  assert.equal(row2.content, fileHtml, '기존 파일 경로 본문은 그대로 저장되어야');
  assert.equal(String(row2.attachments).includes('/uploads/documents/a.pdf'), true, '첨부도 그대로 저장되어야');

  // ③ 과제 제출 — 평문 + 첨부
  const hw = makeHomework(`${TAG}-평문제출`);
  const text = '<p>손으로 풀어서 사진 대신 글로 씁니다.</p>';
  const r = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, {
    content: text, attachments: [{ type: 'file', url: '/uploads/documents/b.pdf', name: 'b.pdf' }],
  });
  assert.equal(r.status, 200, `평문 제출 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  const sub = submissionRow(hw.id);
  assert.equal(sub.content, text, '평문 제출은 한 글자도 바뀌면 안 된다');
  assert.equal(String(sub.attachments).includes('/uploads/documents/b.pdf'), true, '제출 첨부도 그대로 저장되어야');

  // ④ content 가 아예 없는 제출(파일만)도 계속 동작해야 한다
  const hw2 = makeHomework(`${TAG}-파일만제출`);
  const r2 = await request('POST', `/api/homework/${CLASS}/${hw2.id}/submit`, STUDENT, {
    file_url: '/uploads/documents/c.pdf', file_name: 'c.pdf',
  });
  assert.equal(r2.status, 200, `파일만 제출도 200 이어야 (실제=${r2.status} ${r2.body.slice(0, 200)})`);
  const sub2 = submissionRow(hw2.id);
  assert.equal(sub2.content, null, 'content 없는 제출은 NULL 그대로여야');
  assert.equal(sub2.file_path, '/uploads/documents/c.pdf', '파일 경로가 저장되어야');
});

test('INV-IM7: 채점·피드백·제출시각 보존 — 변환이 붙은 재제출이 채점 결과를 지우지 않는다', async () => {
  const hw = makeHomework(`${TAG}-채점보존`);
  const first = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, { content: '<p>1차 답안</p>' });
  assert.equal(first.status, 200, `1차 제출 200 이어야 (실제=${first.status})`);

  const sub0 = submissionRow(hw.id);
  assert.ok(sub0, '1차 제출 행이 있어야 (전제)');
  homeworkDb.gradeSubmission(sub0.id, 90, '잘했어요');

  const graded = submissionRow(hw.id);
  assert.equal(graded.score, 90, '전제 — 채점 점수가 붙어 있다');
  assert.equal(graded.feedback, '잘했어요', '전제 — 피드백이 붙어 있다');
  assert.ok(graded.graded_at, '전제 — 채점 시각이 붙어 있다');
  const gradedAt0 = graded.graded_at;
  const submittedAt0 = graded.submitted_at;

  // ★ 채점이 끝난 뒤, 학생이 이미지를 붙여넣어 재제출한다 (변환이 도는 상황)
  const content = `<p>2차 답안</p><img src="${PNG_DATA_URL}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 재제출 본문에 data: 이미지가 있어야');
  const again = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, { content });
  assert.equal(again.status, 200, `재제출 200 이어야 (실제=${again.status} ${again.body.slice(0, 200)})`);

  const after2 = submissionRow(hw.id);
  assert.equal(after2.id, sub0.id, '재제출은 같은 행을 갱신해야 (행이 새로 생기면 채점이 갈라진다)');
  // 변환은 되었고
  assert.equal(inlineMedia.hasInlineDataMedia(after2.content), false, '재제출 본문도 변환되어야');
  assertMaterialized(imgSrcs(after2.content)[0], '재제출');
  // 채점 결과는 그대로여야 한다 — 이 관문이 건드릴 수 있는 영역이 아니다
  assert.equal(after2.score, 90, '재제출 후에도 점수가 보존되어야');
  assert.equal(after2.feedback, '잘했어요', '재제출 후에도 피드백이 보존되어야');
  assert.equal(after2.graded_at, gradedAt0, '재제출이 채점 시각을 바꾸면 안 된다');
  assert.equal(after2.is_draft, 0, '재제출 행이 임시저장으로 강등되면 안 된다');
  // 제출 시각은 재제출이 갱신하는 값(기존 사양) — 관문이 아니라 submitHomework 가 정한다
  assert.ok(after2.submitted_at, '재제출 시각이 기록되어야');
  assert.notEqual(submittedAt0, undefined, '전제 — 1차 제출 시각이 존재했다');
});

// ══════════════════════════════════════════════════════════════════════════
// 뒷문 차단 — 용량·형식 제한이 두 경로에서도 그대로 적용된다
// ══════════════════════════════════════════════════════════════════════════

test('INV-IM8: 용량 상한이 알림장·과제 제출 경로에서도 적용된다 (검사 우회 금지)', async () => {
  // 전제 — 업로드 규칙의 상한이 50MB 한 벌이다(여기에 별도 상한을 새로 적으면 규칙이 두 벌이 된다)
  assert.equal(uploadRules.MAX_FILE_SIZE, 50 * 1024 * 1024, '업로드 상한은 50MB');
  const huge = `data:image/png;base64,${Buffer.alloc(uploadRules.MAX_FILE_SIZE + 1024, 0x41).toString('base64')}`;
  const content = `<p>큰 그림</p><img src="${huge}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 보내는 본문에 data: 이미지가 있어야');

  const n = await request('POST', `/api/notice/${CLASS}`, TEACHER, { title: `${TAG}-초과`, content });
  assert.equal(n.status, 400, `알림장: 50MB 초과는 400 이어야 (실제=${n.status} ${n.body.slice(0, 160)})`);
  assert.equal(n.json.message, uploadRules.MSG_TOO_LARGE, '업로드 API 와 같은 한국어 메시지여야');
  const leftN = db.prepare('SELECT COUNT(*) c FROM notices WHERE title = ?').get(`${TAG}-초과`).c;
  assert.equal(leftN, 0, '거부된 알림장은 저장되면 안 된다(반쯤 저장 금지)');

  const hw = makeHomework(`${TAG}-초과제출`);
  const h = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, { content });
  assert.equal(h.status, 400, `과제 제출: 50MB 초과는 400 이어야 (실제=${h.status} ${h.body.slice(0, 160)})`);
  assert.equal(h.json.message, uploadRules.MSG_TOO_LARGE, '업로드 API 와 같은 한국어 메시지여야');
  assert.equal(submissionRow(hw.id), null, '거부된 제출은 저장되면 안 된다(학생이 냈다고 착각하면 안 된다)');
});

test('INV-IM9: 허용 목록 밖 형식(svg 등)이 알림장·과제 제출 경로에서도 막힌다', async () => {
  // 전제 — svg 는 업로드 허용 목록 밖이다(XSS 벡터)
  assert.equal(uploadRules.ALLOWED_EXT_RE.test('.svg'), false, 'svg 는 업로드 허용 목록 밖이어야');
  assert.equal(uploadRules.ALLOWED_EXT_RE.test('.png'), true, 'png 는 허용');
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const content = `<p>도형</p><img src="${svg}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(content), true, '전제 — 보내는 본문에 data: 이미지가 있어야');

  const n = await request('POST', `/api/notice/${CLASS}`, TEACHER, { title: `${TAG}-svg`, content });
  assert.equal(n.status, 400, `알림장: svg 는 400 이어야 (실제=${n.status} ${n.body.slice(0, 160)})`);
  assert.equal(n.json.message, uploadRules.MSG_BAD_TYPE, '업로드 API 와 같은 한국어 메시지여야');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notices WHERE title = ?').get(`${TAG}-svg`).c, 0,
    '거부된 알림장은 저장되면 안 된다');

  const hw = makeHomework(`${TAG}-svg제출`);
  const h = await request('POST', `/api/homework/${CLASS}/${hw.id}/submit`, STUDENT, { content });
  assert.equal(h.status, 400, `과제 제출: svg 는 400 이어야 (실제=${h.status} ${h.body.slice(0, 160)})`);
  assert.equal(h.json.message, uploadRules.MSG_BAD_TYPE, '업로드 API 와 같은 한국어 메시지여야');
  assert.equal(submissionRow(hw.id), null, '거부된 제출은 저장되면 안 된다');
});

// ══════════════════════════════════════════════════════════════════════════
// 알림장 댓글 — 같은 부류의 뒷문을 한 칸 옆에 열어두지 않는다
//
// notice-board.html:1241 의 댓글 Quill 에도 이미지 툴바(handlers.image)가 달려 있다.
// 정본 DB 잔여가 0건이라도 경로가 열려 있으면 다시 쌓인다 — 관문은 본문과 같은 것을 쓴다.
//
// ★ 순서 함정(INV-IM13): POST 라우트에는 2000자 검사가 있다. base64 는 작은 이미지 한 장도
//   문자열을 수천 자로 부풀리므로 **변환 전에 길이를 재면** 사진 한 장 붙인 댓글이
//   "2000자 이내로" 라는 엉뚱한 이유로 거부된다. 관문이 길이 검사보다 앞에 있어야 한다.
// ══════════════════════════════════════════════════════════════════════════

test('INV-IM11: 알림장 댓글 작성 — data: 이미지가 파일로 바뀌고 본문에 data: 가 남지 않는다', async () => {
  const nid = await writeNotice({ title: `${TAG}-댓글모체`, content: '<p>댓글 달아 주세요</p>' });
  const content = `<p>사진으로 답합니다</p><img src="${PNG_DATA_URL}">`;
  // 픽스처 전제 — 보내는 댓글에 실제로 data: 미디어가 있다
  assert.equal(inlineMedia.hasInlineDataMedia(content), true,
    '전제 — 보내는 댓글에 data: 미디어가 있어야 (없으면 이 테스트는 아무것도 검사하지 않는다)');

  const r = await postComment(nid, TEACHER, { content });
  assert.equal(r.status, 201, `댓글 작성 201 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);
  const row = commentRow(r.json.comment.id);
  assert.ok(row, '댓글 행이 생성되어야');

  assert.equal(String(row.content).includes('data:image'), false,
    `저장된 댓글에 base64 가 남아 있다. 실제=${String(row.content).slice(0, 120)}`);
  assert.equal(inlineMedia.hasInlineDataMedia(row.content), false, '저장된 댓글에 data: 미디어가 남으면 안 된다');

  const srcs = imgSrcs(row.content);
  assert.equal(srcs.length, 1, `댓글에 <img> 1개가 남아야 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '댓글 작성');
  assert.equal(String(row.content), content.replace(PNG_DATA_URL, srcs[0]),
    'src 문자열 외에 댓글 내용이 달라지면 안 된다(무손실 치환)');

  // 읽기 경로(학생·학부모가 보는 댓글 목록)도 파일 경로를 돌려줘야 한다
  const list = await request('GET', `/api/notice/${CLASS}/${nid}/comments`, STUDENT);
  assert.equal(list.status, 200, `댓글 목록 200 이어야 (실제=${list.status})`);
  const found = (list.json.comments || []).find(c => c.id === row.id);
  assert.ok(found, '방금 단 댓글이 목록에 있어야 (전제)');
  assert.equal(inlineMedia.hasInlineDataMedia(found.content), false, '댓글 목록 응답에도 data: 가 남으면 안 된다');
  assert.equal(imgSrcs(found.content).length, 1, '댓글 목록 응답에 <img> 가 살아 있어야 (사라지면 화면이 깨진다)');
});

test('INV-IM12: 알림장 댓글 수정 경로도 같은 관문을 지난다', async () => {
  const nid = await writeNotice({ title: `${TAG}-댓글수정모체`, content: '<p>본문</p>' });
  const made = await postComment(nid, TEACHER, { content: '<p>처음 댓글</p>' });
  assert.equal(made.status, 201, `댓글 작성 201 이어야 (실제=${made.status})`);
  const cid = made.json.comment.id;
  assert.equal(inlineMedia.hasInlineDataMedia(commentRow(cid).content), false, '전제 — 수정 전에는 data: 가 없다');

  const patched = `<p>고친 댓글</p><img src="${PNG_DATA_URL}">`;
  assert.equal(inlineMedia.hasInlineDataMedia(patched), true, '전제 — 수정으로 보내는 댓글에 data: 이미지가 있어야');

  const r = await request('PUT', `/api/notice/${CLASS}/${nid}/comments/${cid}`, TEACHER, { content: patched });
  assert.equal(r.status, 200, `댓글 수정 200 이어야 (실제=${r.status} ${r.body.slice(0, 200)})`);

  const row = commentRow(cid);
  assert.equal(inlineMedia.hasInlineDataMedia(row.content), false, '수정 저장본에 data: 가 남으면 안 된다');
  const srcs = imgSrcs(row.content);
  assert.equal(srcs.length, 1, `수정 저장본에 <img> 1개가 있어야 (실제=${JSON.stringify(srcs)})`);
  assertMaterialized(srcs[0], '댓글 수정');
  assert.equal(String(row.content).includes('고친 댓글'), true, '수정한 글자가 보존되어야');
});

test('INV-IM13: 2000자 제한이 붙여넣은 이미지를 오인해 막지 않는다 (관문이 길이검사보다 먼저)', async () => {
  const nid = await writeNotice({ title: `${TAG}-길이검사`, content: '<p>본문</p>' });

  // ① 사람이 쓴 글자는 짧지만 base64 때문에 문자열이 2000자를 훌쩍 넘는 댓글
  const content = `<p>사진</p><img src="${BIG_PNG_DATA_URL}">`;
  assert.ok(content.length > 2000,
    `전제 — 이 댓글 문자열은 2000자를 넘어야 순서 회귀를 검사할 수 있다 (실제=${content.length}자)`);
  assert.ok(inlineMedia.hasInlineDataMedia(content), '전제 — data: 이미지가 있어야');
  // 사람이 쓴 글자 자체는 2000자 한참 아래 — 길이 제한에 걸릴 이유가 없는 댓글이다
  assert.ok(content.replace(/<img[^>]*>/g, '').length < 100,
    '전제 — 이미지를 뺀 글자 수는 2000자에 한참 못 미친다(= 막힐 이유가 없다)');

  const r = await postComment(nid, TEACHER, { content });
  assert.equal(r.status, 201,
    `사진 한 장 붙인 짧은 댓글이 길이 제한에 걸리면 안 된다 (실제=${r.status} ${r.body.slice(0, 160)})`);
  const row = commentRow(r.json.comment.id);
  assert.ok(row.content.length <= 2000, `변환 후에는 2000자 이하여야 (실제=${row.content.length}자)`);
  assert.equal(inlineMedia.hasInlineDataMedia(row.content), false, '변환되어 저장되어야');
  assertMaterialized(imgSrcs(row.content)[0], '길이검사 통과 댓글');

  // ② 과잉 완화 금지 — **사람이 쓴 글자**가 2000자를 넘으면 여전히 400 이어야 한다
  const longText = `<p>${'가'.repeat(2100)}</p>`;
  assert.equal(inlineMedia.hasInlineDataMedia(longText), false, '전제 — 이 댓글에는 data: 가 없다');
  const r2 = await postComment(nid, TEACHER, { content: longText });
  assert.equal(r2.status, 400, `진짜로 긴 텍스트 댓글은 여전히 400 이어야 (실제=${r2.status})`);
  assert.equal(r2.json.message, '댓글은 2000자 이내로 작성해 주세요.', '길이 제한 메시지가 그대로여야');
});

test('INV-IM14: 과잉 차단 금지 — 평문 댓글·대댓글·기존 파일 경로 댓글이 그대로 저장된다', async () => {
  const nid = await writeNotice({ title: `${TAG}-댓글과잉`, content: '<p>본문</p>' });

  // ① 평문 댓글
  const plain = '<p>감사합니다. 확인했습니다.</p>';
  assert.equal(inlineMedia.hasInlineDataMedia(plain), false, '전제 — 이 댓글에는 data: 가 없다');
  const c1 = await postComment(nid, TEACHER, { content: plain });
  assert.equal(c1.status, 201, `평문 댓글 201 이어야 (실제=${c1.status} ${c1.body.slice(0, 160)})`);
  assert.equal(commentRow(c1.json.comment.id).content, plain, '평문 댓글은 한 글자도 바뀌면 안 된다');

  // ② 대댓글(parent_id) — 관문이 부모 연결을 깨뜨리면 안 된다
  const reply = '<p>네, 준비하겠습니다.</p>';
  const c2 = await postComment(nid, STUDENT, { content: reply, parent_id: c1.json.comment.id });
  assert.equal(c2.status, 201, `대댓글 201 이어야 (실제=${c2.status} ${c2.body.slice(0, 160)})`);
  const r2 = commentRow(c2.json.comment.id);
  assert.equal(r2.content, reply, '대댓글 평문도 그대로여야');
  assert.equal(r2.parent_id, c1.json.comment.id, '대댓글의 부모 연결이 유지되어야');

  // ③ 이미 업로드된 파일 경로가 든 댓글 — 변환 대상이 아니다
  const fileHtml = '<p>지난번 사진</p><img src="/uploads/images/already-9876.png">';
  assert.equal(inlineMedia.hasInlineDataMedia(fileHtml), false, '전제 — 파일 경로 댓글에는 data: 가 없다');
  const c3 = await postComment(nid, TEACHER, { content: fileHtml });
  assert.equal(c3.status, 201, `파일 경로 댓글 201 이어야 (실제=${c3.status})`);
  assert.equal(commentRow(c3.json.comment.id).content, fileHtml, '기존 파일 경로 댓글은 그대로 저장되어야');
});

test('INV-IM15: 용량·형식 제한이 댓글 경로에서도 적용된다 (검사 우회 금지)', async () => {
  const nid = await writeNotice({ title: `${TAG}-댓글제한`, content: '<p>본문</p>' });
  const before = db.prepare('SELECT COUNT(*) c FROM notice_comments WHERE notice_id = ?').get(nid).c;
  assert.equal(before, 0, '전제 — 아직 댓글이 없다');

  // ① 형식 — svg 는 업로드 허용 목록 밖(XSS 벡터)
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const bad = await postComment(nid, TEACHER, { content: `<p>도형</p><img src="${svg}">` });
  assert.equal(bad.status, 400, `댓글: svg 는 400 이어야 (실제=${bad.status} ${bad.body.slice(0, 160)})`);
  assert.equal(bad.json.message, uploadRules.MSG_BAD_TYPE, '업로드 API 와 같은 한국어 메시지여야');

  // ② 용량 — 50MB 초과
  const huge = `data:image/png;base64,${Buffer.alloc(uploadRules.MAX_FILE_SIZE + 1024, 0x41).toString('base64')}`;
  const big = await postComment(nid, TEACHER, { content: `<p>큰 그림</p><img src="${huge}">` });
  assert.equal(big.status, 400, `댓글: 50MB 초과는 400 이어야 (실제=${big.status} ${big.body.slice(0, 160)})`);
  assert.equal(big.json.message, uploadRules.MSG_TOO_LARGE, '업로드 API 와 같은 한국어 메시지여야');

  // ③ 거부된 댓글은 한 건도 저장되면 안 된다(반쯤 저장 금지)
  const after = db.prepare('SELECT COUNT(*) c FROM notice_comments WHERE notice_id = ?').get(nid).c;
  assert.equal(after, 0, `거부된 댓글이 저장되면 안 된다 (실제 ${after}건 저장됨)`);
});

test('INV-IM10: Quill 이 있는 세 화면이 모두 같은 관문(lib/inline-data-media)을 쓴다', () => {
  // 화면마다 규칙을 따로 적기 시작하면 그 순간 검사가 여러 벌이 되고 뒷문이 생긴다.
  // "본문 저장 라우터가 관문을 require 하는가"를 소스에서 직접 확인한다.
  const files = {
    '게시판(routes/board.js)': 'routes/board.js',
    '알림장(routes/notice.js)': 'routes/notice.js',
    '과제 제출(routes/homework.js)': 'routes/homework.js',
  };
  for (const [what, rel] of Object.entries(files)) {
    const src = fs.readFileSync(nodePath.join(ROOT, rel), 'utf8');
    assert.match(src, /require\(['"]\.\.\/lib\/inline-data-media['"]\)/,
      `${what}: 본문 저장 라우터는 lib/inline-data-media 관문을 써야 한다`);
    assert.match(src, /normalizeInlineMedia\(/,
      `${what}: normalizeInlineMedia 관문을 실제로 호출해야 한다`);
  }
  // 알림장은 본문 2경로(작성·수정) + 댓글 2경로(작성·수정) = 4개 저장 지점이 모두 관문을 지나야 한다.
  //   댓글 Quill 에도 이미지 툴바가 달려 있어, 본문만 막으면 같은 뒷문이 한 칸 옆에 남는다.
  const noticeSrc = fs.readFileSync(nodePath.join(ROOT, 'routes/notice.js'), 'utf8');
  const calls = (noticeSrc.match(/normalizeInlineMedia\(\w/g) || []).length;
  assert.ok(calls >= 4,
    `알림장은 본문 작성·수정 + 댓글 작성·수정 4곳이 관문을 지나야 한다 (실제 호출 ${calls}곳)`);

  // 관문은 upload-rules(SSOT)를 그대로 쓴다 — 자기만의 허용 목록·상한을 적으면 안 된다
  const gate = fs.readFileSync(nodePath.join(ROOT, 'lib/inline-data-media.js'), 'utf8');
  assert.match(gate, /require\(['"]\.\/upload-rules['"]\)/, '관문은 upload-rules(SSOT)를 써야 한다');
  assert.equal(/MAX_FILE_SIZE\s*=\s*\d/.test(gate), false,
    '관문이 자기만의 용량 상한을 새로 정의하면 규칙이 두 벌이 된다');
});
