// test/asset-access-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 보안 — 2026-08-05] 콘텐츠 상세 / 업로드 파일 / 갤러리 쓰기 3개 게이트.
//
// ■ P0-2 콘텐츠 상세 API 무검사 (실서버 실측)
//   student1 로그인 후
//     GET /api/contents/3797 → 200 | status=draft    is_public=0 creator=2
//     GET /api/contents/3801 → 200 | status=approved is_public=0 creator=2
//     GET /api/contents/3129 → 200 | status=rejected is_public=1 creator=1
//   목록 API 에만 `is_public=1 AND status='approved'` 가 있어 "목록에서 가리기"만 됐고
//   직접 접근은 무방비였다. 문항 콘텐츠면 questions[].answer·explanation 까지 나갔다.
//
// ■ P0-2 업로드 파일 무인증 서빙
//   express.static(public) 하나로 public/uploads/** 전체가 비로그인 공개였다.
//   ⚠ 통째 차단은 금지 — 비로그인 포털의 명예의 전당(승인 작품 이미지)·인기 콘텐츠
//     썸네일이 /uploads 를 쓴다. **공개 자원 200 유지**를 함께 단언해 과차단을 막는다.
//
// ■ P0-3 미승인 갤러리 작품에 댓글·좋아요 주입
//   읽기(GET /gallery/:id)는 막혀 있었는데 쓰기(comments·like)에만 상태 검사가 없어
//   student2 가 pending 작품에 댓글 201 / 좋아요 200 을 넣을 수 있었다.
//   승인되는 순간 그 댓글·좋아요가 공개된다.
//
// 불변식(INV-SEC-AS0 ~ AS9)
//   AS0. 픽스처 전제 성립
//   AS1. 비공개 콘텐츠 상세 → 비소유 학생 403, 응답에 file_path/description/questions 부재
//   AS2. 공개 승인본 → 200 유지(과차단 없음) / 작성자·admin → 자기 비공개본 200 유지
//   AS3. 수업에 연결된 비공개 콘텐츠 → 그 클래스 학생 200 (이용 근거 — 과차단 방지)
//   AS4. 업로드 파일: 비공개 자원의 파일 → 비로그인 401 / 무관 학생 403 / 소유자·admin 200
//   AS5. 업로드 파일: 공개 자원의 파일 → **비로그인 200 유지**(과차단 방지)
//   AS6. 업로드 파일: 미참조 파일 → 비로그인 401 / 로그인 200 (과차단 방지 한계선)
//   AS7. server.js 가 uploadsGuard 를 express.static "앞"에 마운트
//   AS8. pending 작품 쓰기 → 404 이고 gallery_comments·gallery_likes 행이 실제로 안 생김
//   AS9. approved 작품 쓰기 → 201/200 유지(과차단 없음)
//
// 검증 방식: growth-permission-guard.test.js 와 동일한 node:http + x-test-user 패턴
//   (실제 라우터·실제 미들웨어 mount → 게이트 코드가 그대로 실행된다).
// DB 격리: 실 DB → 임시 복사본. 업로드 파일도 임시 디렉터리에만 만든다(정본 무오염).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입
const express = require('express');
const session = require('express-session');
const db = openTestDb();

let server, baseUrl, uploadDir;

function uidOf(username) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r.id;
}

const ADMIN = uidOf('admin');
const T1 = uidOf('teacher1');
const S1 = uidOf('student1');
const S2 = uidOf('student2');

// ── 픽스처 파일 경로 (임시 uploads 디렉터리에만 실제로 만든다) ────────────────
const F_PRIVATE = '/uploads/documents/_guard_private.pdf';   // 비공개(draft) 콘텐츠 첨부
const F_PUBLIC  = '/uploads/documents/_guard_public.pdf';    // 공개 승인본 첨부
const F_GAL_PUB = '/uploads/gallery/_guard_approved.jpg';    // 승인 작품 이미지
const F_GAL_PEN = '/uploads/gallery/_guard_pending.jpg';     // 미승인 작품 이미지
const F_ORPHAN  = '/uploads/images/_guard_orphan.png';       // 아무 자원도 참조 안 함

// ── 픽스처 시드 (복사본에만) ─────────────────────────────────────────────────
function insertContent({ creator, status, isPublic, type, filePath, title }) {
  const info = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, file_path, is_public, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(creator, title, '내부 검토용 설명(비공개)', type, filePath || null, isPublic, status);
  return info.lastInsertRowid;
}
function insertQuestion(contentId) {
  db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
    VALUES (?, 1, '2+3 은?', 'multiple_choice', ?, '1', '2와 3을 더하면 5', 10)
  `).run(contentId, JSON.stringify(['4', '5', '6', '7']));
}

const C_DRAFT   = insertContent({ creator: T1, status: 'draft',    isPublic: 0, type: 'quiz',     filePath: F_PRIVATE, title: '_가드_초안문항' });
const C_PENDING = insertContent({ creator: T1, status: 'pending',  isPublic: 1, type: 'quiz',     filePath: null,      title: '_가드_승인대기문항' });
const C_REJECT  = insertContent({ creator: T1, status: 'rejected', isPublic: 1, type: 'document', filePath: null,      title: '_가드_반려자료' });
const C_PUBLIC  = insertContent({ creator: T1, status: 'approved', isPublic: 1, type: 'document', filePath: F_PUBLIC,  title: '_가드_공개승인본' });
insertQuestion(C_DRAFT);
insertQuestion(C_PENDING);

// 수업에 연결된 비공개 콘텐츠 — student1 이 멤버인 클래스의 수업에 붙인다(이용 근거 대조군).
const LESSON_OF_S1 = db.prepare(`
  SELECT l.id AS id FROM lessons l
  JOIN class_members m ON m.class_id = l.class_id AND m.user_id = ? AND m.status = 'active'
  LIMIT 1
`).get(S1);
let C_LESSON = null;
if (LESSON_OF_S1) {
  C_LESSON = insertContent({ creator: T1, status: 'draft', isPublic: 0, type: 'video', filePath: null, title: '_가드_수업연결자료' });
  db.prepare('INSERT INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?, ?, 0)').run(LESSON_OF_S1.id, C_LESSON);
}

// 갤러리 픽스처
function insertGallery({ student, status, imageUrl, title }) {
  const info = db.prepare(`
    INSERT INTO student_gallery (student_id, title, description, image_url, category, approval_status, created_at)
    VALUES (?, ?, '테스트 작품', ?, 'art', ?, datetime('now'))
  `).run(student, title, imageUrl, status);
  return info.lastInsertRowid;
}
const G_PENDING  = insertGallery({ student: S1, status: 'pending',  imageUrl: F_GAL_PEN, title: '_가드_미승인작품' });
const G_APPROVED = insertGallery({ student: S1, status: 'approved', imageUrl: F_GAL_PUB, title: '_가드_승인작품' });

// ── 앱 구성 (server.js 와 동일한 순서: 가드 → static) ────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  // uploads 가드는 세션을 읽어야 하므로 req.user 를 채워 주는 optionalAuth 를 먼저 태운다.
  const { optionalAuth } = require('../middleware/auth');
  const { uploadsGuard } = require('../lib/uploads-access');
  app.use('/uploads', optionalAuth, uploadsGuard);
  app.use('/uploads', express.static(uploadDir));
  app.use('/api/contents', require('../routes/content'));
  app.use('/api/growth', require('../routes/growth'));
  return app;
}

function call(method, p, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(baseUrl + p, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (p, u) => call('GET', p, u);
const post = (p, u, b) => call('POST', p, u, b);

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dacheum_uploads_guard_'));
  for (const rel of [F_PRIVATE, F_PUBLIC, F_GAL_PUB, F_GAL_PEN, F_ORPHAN]) {
    const abs = path.join(uploadDir, rel.replace(/^\/uploads\//, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'guard-fixture');
  }
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
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch (_) {}
});

// ──────────────────────────────────────────────────────────────────────────
// AS0: 픽스처 전제
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS0: 픽스처 전제 — 비공개/공개 콘텐츠·작품이 의도대로 시드됐다', () => {
  const d = db.prepare('SELECT is_public, status, creator_id FROM contents WHERE id = ?').get(C_DRAFT);
  assert.equal(d.status, 'draft');
  assert.equal(d.is_public, 0);
  assert.equal(d.creator_id, T1);
  const p = db.prepare('SELECT is_public, status FROM contents WHERE id = ?').get(C_PUBLIC);
  assert.equal(p.is_public, 1);
  assert.equal(p.status, 'approved');
  assert.ok(db.prepare('SELECT 1 FROM content_questions WHERE content_id = ?').get(C_DRAFT), '초안 콘텐츠에 문항이 있어야(정답 노출 검증 대상)');
  assert.equal(db.prepare('SELECT approval_status s FROM student_gallery WHERE id = ?').get(G_PENDING).s, 'pending');
  assert.notEqual(S1, S2, 'student1 과 student2 는 다른 계정이어야 대조 성립');
});

// ──────────────────────────────────────────────────────────────────────────
// AS1: 비공개 콘텐츠 상세 → 비소유 학생 403 + 민감 필드 부재
// ──────────────────────────────────────────────────────────────────────────
for (const [label, cid] of [['draft(비공개)', () => C_DRAFT], ['pending(승인대기)', () => C_PENDING], ['rejected(반려)', () => C_REJECT]]) {
  test(`INV-SEC-AS1: ${label} 콘텐츠 상세 → 비소유 학생 403`, async () => {
    const r = await get(`/api/contents/${cid()}`, S1);
    assert.equal(r.status, 403, `${label} 이 학생에게 200 이면 안 된다 (실제 ${r.status})`);
    const j = JSON.parse(r.body);
    assert.equal(j.success, false);
    assert.ok(j.message && /권한|없습니다/.test(j.message), '한국어 차단 메시지');
    // 응답 본문에 민감 필드가 한 조각도 실려선 안 된다
    for (const key of ['file_path', 'description', 'questions', 'answer', 'explanation']) {
      assert.ok(!(key in (j.content || {})), `403 응답에 ${key} 가 있으면 안 된다`);
      assert.ok(!r.body.includes(`"${key}"`), `403 응답 원문에 "${key}" 키가 있으면 안 된다`);
    }
  });
}

test('INV-SEC-AS1b: 비로그인은 비공개 콘텐츠 상세에 접근 불가(401)', async () => {
  const r = await get(`/api/contents/${C_DRAFT}`, null);
  assert.equal(r.status, 401);
});

// ──────────────────────────────────────────────────────────────────────────
// AS2: 과차단 없음 — 공개 승인본 / 작성자 / admin
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS2: 공개 승인본은 학생에게 200 유지 (과차단 없음)', async () => {
  const r = await get(`/api/contents/${C_PUBLIC}`, S1);
  assert.equal(r.status, 200, '공개 승인본까지 막으면 콘텐츠 서비스가 죽는다');
  const j = JSON.parse(r.body);
  assert.equal(j.content.id, C_PUBLIC);
});

test('INV-SEC-AS2b: 작성자 본인·admin 은 자기 비공개본 200 유지', async () => {
  const owner = await get(`/api/contents/${C_DRAFT}`, T1);
  assert.equal(owner.status, 200, '작성자가 자기 초안을 못 보면 안 된다');
  assert.ok(JSON.parse(owner.body).content.questions, '작성자에겐 문항이 그대로 보여야');
  const adm = await get(`/api/contents/${C_PENDING}`, ADMIN);
  assert.equal(adm.status, 200, 'admin 은 승인 심사를 위해 열람해야 한다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS3: 이용 근거 — 수업에 연결된 비공개 콘텐츠는 그 클래스 학생에게 열려야 한다
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS3: 수업에 연결된 비공개 콘텐츠 → 그 클래스 학생 200 (과차단 방지)', async (t) => {
  if (!C_LESSON) return t.skip('student1 이 멤버인 클래스에 수업이 없어 대조 불가');
  const r = await get(`/api/contents/${C_LESSON}`, S1);
  assert.equal(r.status, 200, '수업에 편성된 자료를 학생이 못 열면 수업이 깨진다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS4: 업로드 파일 — 비공개 자원의 파일
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS4: 비공개 콘텐츠 첨부 → 비로그인 401 / 무관 학생 403 / 작성자·admin 200', async () => {
  const anon = await get(F_PRIVATE, null);
  assert.equal(anon.status, 401, '비로그인 다운로드가 열려 있으면 안 된다');
  const stranger = await get(F_PRIVATE, S1);
  assert.equal(stranger.status, 403, '무관 사용자에게 열려 있으면 안 된다');
  const owner = await get(F_PRIVATE, T1);
  assert.equal(owner.status, 200, '작성자는 자기 파일을 받아야 한다');
  const adm = await get(F_PRIVATE, ADMIN);
  assert.equal(adm.status, 200);
});

test('INV-SEC-AS4b: 미승인 작품 이미지 → 비로그인 401 / 타 학생 403 / 작성자·교사 200', async () => {
  assert.equal((await get(F_GAL_PEN, null)).status, 401);
  assert.equal((await get(F_GAL_PEN, S2)).status, 403);
  assert.equal((await get(F_GAL_PEN, S1)).status, 200, '작성자 본인은 자기 작품을 봐야 한다');
  assert.equal((await get(F_GAL_PEN, T1)).status, 200, '승인 심사 교사는 봐야 한다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS5: 과차단 방지 — 공개 자원의 파일은 비로그인에게도 200
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS5: 공개 승인본 첨부·승인 작품 이미지 → 비로그인 200 유지', async () => {
  const c = await get(F_PUBLIC, null);
  assert.equal(c.status, 200, '공개 콘텐츠 자산까지 막으면 비로그인 포털이 깨진다');
  const g = await get(F_GAL_PUB, null);
  assert.equal(g.status, 200, '명예의 전당(승인 작품) 이미지는 비로그인에게 보여야 한다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS6: 미참조 파일 — 무인증만 차단, 로그인 사용자는 허용(과차단 한계선)
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS6: 미참조 업로드 파일 → 비로그인 401 / 로그인 200', async () => {
  assert.equal((await get(F_ORPHAN, null)).status, 401);
  assert.equal((await get(F_ORPHAN, S2)).status, 200, '경로만으로 소유자를 모르는 파일까지 막으면 게시글 본문 이미지가 깨진다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS7: server.js 마운트 순서 — 가드가 static 보다 먼저여야 실제로 동작한다
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS7: server.js 가 uploadsGuard 를 express.static 앞에 마운트', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const guardAt = src.indexOf('uploadsGuard');
  const staticAt = src.indexOf("express.static(path.join(__dirname, 'public'))");
  assert.ok(guardAt > -1, 'server.js 가 uploadsGuard 를 마운트해야 한다');
  assert.ok(staticAt > -1, 'public 정적 서빙 라인을 찾지 못했다(테스트 전제 붕괴)');
  assert.ok(guardAt < staticAt, '가드가 static 뒤에 있으면 파일이 먼저 나가서 무의미하다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS8: 미승인 작품 쓰기 차단 — 응답 코드 + **DB 행 미생성**
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS8: pending 작품에 타 학생 댓글 → 404 이고 gallery_comments 행 없음', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM gallery_comments WHERE gallery_id = ?').get(G_PENDING).n;
  const r = await post(`/api/growth/gallery/${G_PENDING}/comments`, S2, { content: '몰래 댓글' });
  assert.equal(r.status, 404, `pending 작품에 댓글이 달리면 안 된다 (실제 ${r.status})`);
  const after = db.prepare('SELECT COUNT(*) n FROM gallery_comments WHERE gallery_id = ?').get(G_PENDING).n;
  assert.equal(after, before, '차단했는데 댓글 행이 생기면 게이트가 무의미하다');
});

test('INV-SEC-AS8b: pending 작품에 타 학생 좋아요 → 404 이고 gallery_likes·like_count 불변', async () => {
  const beforeLikes = db.prepare('SELECT COUNT(*) n FROM gallery_likes WHERE gallery_id = ?').get(G_PENDING).n;
  const beforeCount = db.prepare('SELECT like_count n FROM student_gallery WHERE id = ?').get(G_PENDING).n;
  const r = await post(`/api/growth/gallery/${G_PENDING}/like`, S2);
  assert.equal(r.status, 404, `pending 작품에 좋아요가 들어가면 안 된다 (실제 ${r.status})`);
  const afterLikes = db.prepare('SELECT COUNT(*) n FROM gallery_likes WHERE gallery_id = ?').get(G_PENDING).n;
  const afterCount = db.prepare('SELECT like_count n FROM student_gallery WHERE id = ?').get(G_PENDING).n;
  assert.equal(afterLikes, beforeLikes, 'gallery_likes 행이 생기면 안 된다');
  assert.equal(afterCount, beforeCount, 'like_count 가 올라가면 안 된다');
});

test('INV-SEC-AS8c: pending 작품 댓글 목록·조회수도 타 학생에게 404', async () => {
  assert.equal((await get(`/api/growth/gallery/${G_PENDING}/comments`, S2)).status, 404);
  assert.equal((await post(`/api/growth/gallery/${G_PENDING}/view`, S2)).status, 404);
});

// ──────────────────────────────────────────────────────────────────────────
// AS9: 과차단 없음 — 승인 작품에는 정상 쓰기
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS9: approved 작품 댓글·좋아요는 정상 동작 유지', async () => {
  const c = await post(`/api/growth/gallery/${G_APPROVED}/comments`, S2, { content: '멋져요' });
  assert.equal(c.status, 201, '승인 작품까지 막으면 갤러리가 죽는다');
  const l = await post(`/api/growth/gallery/${G_APPROVED}/like`, S2);
  assert.equal(l.status, 200);
  assert.equal(JSON.parse(l.body).liked, true);
});

test('INV-SEC-AS9b: 작성자 본인은 자기 pending 작품에 계속 접근 가능', async () => {
  assert.equal((await get(`/api/growth/gallery/${G_PENDING}`, S1)).status, 200);
  assert.equal((await get(`/api/growth/gallery/${G_PENDING}/comments`, S1)).status, 200);
});

// ──────────────────────────────────────────────────────────────────────────
// AS13: 한글 파일명(퍼센트 인코딩) — 디코딩을 빠뜨리면 DB 경로와 안 맞아
//   공개 자산이 통째로 401 이 된다(과차단). 경로 탈출(..)도 함께 막는다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS13: 한글 파일명 자산 — 공개는 익명 200, 비공개는 익명 401 (인코딩 무관)', async () => {
  const relPub = '/uploads/images/공개_그림.png';
  const relPriv = '/uploads/images/비공개_그림.png';
  for (const rel of [relPub, relPriv]) {
    const abs = path.join(uploadDir, rel.replace(/^\/uploads\//, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'ko');
  }
  insertContent({ creator: T1, status: 'approved', isPublic: 1, type: 'image', filePath: relPub, title: '_가드_한글공개' });
  insertContent({ creator: T1, status: 'draft', isPublic: 0, type: 'image', filePath: relPriv, title: '_가드_한글비공개' });

  assert.equal((await get(encodeURI(relPub), null)).status, 200, '한글 파일명 공개 자산이 막히면 과차단');
  assert.equal((await get(encodeURI(relPriv), null)).status, 401);
  assert.equal((await get(encodeURI(relPriv), T1)).status, 200);
});

test('INV-SEC-AS13b: 경로 탈출(..) 요청은 400/403/404 — 200 금지', async () => {
  const r = await get('/uploads/..%2F..%2Fserver.js', null);
  assert.notEqual(r.status, 200, 'uploads 밖 파일이 나가면 안 된다');
});

// ──────────────────────────────────────────────────────────────────────────
// AS12: 과제 제출물 첨부 — 제출 학생 / 담당 교사 / (상호공개 과제면) 같은 반 학생.
//   제출물은 어떤 경우에도 공개 자원이 아니다(무인증 다운로드 금지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS12: 과제 제출물 첨부 → 비로그인 401 / 남 403 / 본인·담당교사 200, 상호공개 과제는 반 친구 200', async () => {
  const cls = db.prepare(`
    SELECT c.id FROM classes c
    JOIN class_members a ON a.class_id = c.id AND a.user_id = ? AND a.status='active'
    JOIN class_members b ON b.class_id = c.id AND b.user_id = ? AND b.status='active'
    WHERE c.owner_id = ? LIMIT 1
  `).get(S1, S2, T1);
  if (!cls) return;   // 픽스처가 없으면 대조 불가 — 조용히 통과(전제 없음)

  const mk = (rel, isPublicSubs) => {
    const abs = path.join(uploadDir, rel.replace(/^\/uploads\//, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'hw');
    const hw = db.prepare(`
      INSERT INTO homework (class_id, teacher_id, title, status, public_submissions, created_at)
      VALUES (?, ?, '_가드_과제', 'published', ?, datetime('now'))
    `).run(cls.id, T1, isPublicSubs);
    db.prepare(`
      INSERT INTO homework_submissions (homework_id, student_id, content, file_path, status, submitted_at)
      VALUES (?, ?, '제출', ?, 'submitted', datetime('now'))
    `).run(hw.lastInsertRowid, S1, rel);
    return rel;
  };

  const privateHw = mk('/uploads/documents/_guard_hw_private.pdf', 0);
  assert.equal((await get(privateHw, null)).status, 401, '제출물이 무인증 공개면 안 된다');
  assert.equal((await get(privateHw, S2)).status, 403, '비공개 과제의 남의 제출물은 못 봐야 한다');
  assert.equal((await get(privateHw, S1)).status, 200, '제출 학생 본인은 봐야 한다');
  assert.equal((await get(privateHw, T1)).status, 200, '담당 교사는 채점을 위해 봐야 한다');

  const sharedHw = mk('/uploads/documents/_guard_hw_shared.pdf', 1);
  assert.equal((await get(sharedHw, null)).status, 401);
  assert.equal((await get(sharedHw, S2)).status, 200, '상호공개(public_submissions) 과제는 반 친구도 봐야 한다 — 과차단 방지');
});

// ──────────────────────────────────────────────────────────────────────────
// AS10 (W1-T3-13): contents.status 기본값이 안전한 쪽('draft')이어야 한다.
//   기본값이 'approved' 면 status 를 안 주고 부르는 시드·마이그레이션이 검토 없이 공개된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS10: status 미지정 콘텐츠 생성 → 기본값 draft (즉시 공개 금지)', () => {
  const contentDb = require('../db/content');
  const c = contentDb.createContent(T1, { title: '_가드_기본값확인' });
  assert.equal(c.status, 'draft', 'status 미지정 콘텐츠가 approved 로 들어가면 무검수 공개가 된다');
  assert.equal(c.is_public, 0);
});

test('INV-SEC-AS10b: 신규 스키마의 contents.status DEFAULT 가 draft', () => {
  // ⚠ 한계: SQLite 는 ALTER 로 컬럼 DEFAULT 를 못 바꾼다. **이미 존재하는 DB**(로컬 정본·GCP)의
  //   contents.status DEFAULT 는 여전히 'approved' 이며, 바꾸려면 10,000행 테이블 재생성
  //   마이그레이션이 필요하다(FK off + DROP/RENAME — 별건으로 백업 후 진행할 사안).
  //   지금은 ① 신규 DB 는 draft 로 생성되고 ② 앱 경로(db/content.js)가 항상 draft 로 떨어지게 해
  //   "무검수 즉시 공개" 진입로를 막았다. 이 단언은 스키마 원본이 되돌아가는 회귀를 잡는다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.js'), 'utf8');
  // (?<![a-z_]) — posts.approval_status 의 DEFAULT 'approved' 는 별개 정책이라 건드리지 않는다.
  assert.ok(!/(?<![a-z_])status TEXT DEFAULT 'approved'/.test(src),
    "db/schema.js 에 contents status DEFAULT 'approved' 가 되살아나면 안 된다");
  assert.ok(/status TEXT DEFAULT 'draft'/.test(src), "contents status DEFAULT 는 'draft' 여야 한다");
});

// ──────────────────────────────────────────────────────────────────────────
// AS11 (W1-T3-11): 콘텐츠 삭제 시 업로드 파일 회수.
//   행만 지우고 파일을 남기면 "삭제된 자료가 영구 다운로드" 된다.
//   ⚠ 다른 행이 아직 참조하는 공유 파일은 지우면 안 된다(공유 썸네일 파괴 방지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-AS11: 삭제된 콘텐츠의 파일은 디스크에서 회수되고, 공유 파일은 남는다', () => {
  const prev = process.env.UPLOADS_ROOT;
  process.env.UPLOADS_ROOT = uploadDir;   // 정본 public/uploads 무오염
  try {
    const { removeOrphanUploads } = require('../lib/uploads-access');
    const soloRel = '/uploads/documents/_guard_solo.pdf';
    const soloAbs = path.join(uploadDir, 'documents', '_guard_solo.pdf');
    fs.writeFileSync(soloAbs, 'x');
    const solo = insertContent({ creator: T1, status: 'draft', isPublic: 0, type: 'document', filePath: soloRel, title: '_가드_단독참조' });

    // 아직 참조가 살아 있으면 지우면 안 된다
    assert.deepEqual(removeOrphanUploads([soloRel]), [], '참조가 남아 있는데 지우면 안 된다');
    assert.ok(fs.existsSync(soloAbs));

    // 행을 지운 뒤에는 회수돼야 한다
    db.prepare('DELETE FROM contents WHERE id = ?').run(solo);
    assert.deepEqual(removeOrphanUploads([soloRel]), [soloRel]);
    assert.ok(!fs.existsSync(soloAbs), '삭제된 콘텐츠의 파일이 디스크에 남으면 계속 다운로드된다');

    // 공유 파일(공개 승인본이 아직 참조)은 그대로
    const pubAbs = path.join(uploadDir, 'documents', '_guard_public.pdf');
    assert.deepEqual(removeOrphanUploads([F_PUBLIC]), []);
    assert.ok(fs.existsSync(pubAbs), '아직 참조되는 파일을 지우면 정상 화면이 깨진다');
  } finally {
    if (prev === undefined) delete process.env.UPLOADS_ROOT; else process.env.UPLOADS_ROOT = prev;
  }
});
