// test/gallery.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 B] 나도예술가 승인 (사용자 메모리 원칙: project_artist_approval_principle.md).
//   학생 작품은 pending → 교사/관리자 승인 후에만 갤러리 탭에 노출된다.
//   ★ 본인도 "갤러리 탭"에서는 pending 미노출 — 오직 "내 작품 탭(mine)"에서만 보인다.
//   회귀 시나리오(임시복사본에 INSERT):
//     1) pending 작품 1건 생성 →
//        (a) 일반 갤러리 목록(showMine=false) — 작성자 본인 시점이라도 미포함
//        (b) "내 작품" 목록(showMine=true, studentId=본인) — 포함
//        (c) 교사 includeAll 목록 — 포함
//     2) approveGalleryItem 으로 approved 처리 →
//        (a') 일반 갤러리 목록 — 이제 포함
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입. (복사본만 — 실 DB 무오염)
// 계정(실 DB 실측): student1=id3, teacher1=id2, admin=id1.
//   gallery DB 함수는 db/growth.js (routes/growth.js 가 growthDb = require('../db/growth') 로 사용).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const gallery = require('../db/growth');
const db = openTestDb();

const S1 = 3;        // student1 (작성자)
const TEACHER = 2;   // teacher1 (승인자)

// 멀리 떨어진 고유 제목으로 시드 — 실 데이터와 충돌 방지·정확 식별.
const TITLE = '회귀-승인원칙-' + process.pid + '-' + Date.now();

function listIncludes(opts, gid) {
  const r = gallery.getGalleryItems(opts);
  return r.items.some(it => it.id === gid);
}

// ──────────────────────────────────────────────────────────────────────────
// B-1: pending 작품은 일반 갤러리 탭에 미노출(본인 시점 포함), 내 작품 탭엔 노출.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-B1: pending 작품 — 일반 갤러리 미노출(본인 포함) / 내 작품 탭 노출', () => {
  // pending 작품 1건 생성 (createGalleryItem 기본 approval_status='pending')
  const info = gallery.createGalleryItem(S1, { title: TITLE, category: 'art', description: '회귀테스트' });
  const gid = info.lastInsertRowid || info.id || info;
  assert.ok(gid, '작품 생성 rowid');
  // 상태 확인: pending 이어야 (승인 원칙 — 생성 즉시 비공개)
  const row = db.prepare('SELECT approval_status FROM student_gallery WHERE id = ?').get(gid);
  assert.equal(row.approval_status, 'pending', '학생 작품은 생성 시 pending 이어야');

  // (a) 일반 갤러리 탭 — 작성자 본인이 보더라도(viewerId=본인) showMine=false 면 미노출
  assert.equal(
    listIncludes({ viewerId: S1, showMine: false, limit: 500 }, gid),
    false,
    'pending 작품은 일반 갤러리 탭(본인 시점)에 노출되면 안 된다(승인 원칙)'
  );
  // (a') 제3자(다른 학생) 시점에서도 당연히 미노출
  assert.equal(
    listIncludes({ viewerId: 4, showMine: false, limit: 500 }, gid),
    false,
    'pending 작품은 제3자 갤러리 탭에 노출되면 안 된다'
  );

  // (b) 내 작품 탭 — showMine=true + studentId=본인 → pending 도 노출
  assert.equal(
    listIncludes({ viewerId: S1, studentId: S1, showMine: true, limit: 500 }, gid),
    true,
    'pending 작품은 "내 작품" 탭(showMine)에는 노출되어야'
  );

  // (c) 교사 includeAll(관리 화면) — pending 노출(승인 대기 확인용)
  assert.equal(
    listIncludes({ viewerId: TEACHER, includeAll: true, limit: 500 }, gid),
    true,
    'pending 작품은 교사 includeAll 목록에 노출되어야(승인 대기 확인)'
  );
});

// ──────────────────────────────────────────────────────────────────────────
// B-2: 승인(approved) 후 일반 갤러리 탭에 노출.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-B2: 승인 후 — 일반 갤러리 탭에 노출 전환', () => {
  // 새 pending 작품 → 미노출 확인 → 승인 → 노출 확인 (한 테스트 안에서 전이 검증)
  const info = gallery.createGalleryItem(S1, { title: TITLE + '-approve', category: 'art' });
  const gid = info.lastInsertRowid || info.id || info;

  // 승인 전: 일반 갤러리 미포함
  assert.equal(
    listIncludes({ viewerId: 4, showMine: false, limit: 500 }, gid),
    false,
    '승인 전 일반 갤러리 미노출'
  );

  // 승인 처리
  gallery.approveGalleryItem(gid, TEACHER);
  const row = db.prepare('SELECT approval_status, approved_by FROM student_gallery WHERE id = ?').get(gid);
  assert.equal(row.approval_status, 'approved', '승인 후 status=approved');
  assert.equal(row.approved_by, TEACHER, '승인자 기록');

  // 승인 후: 일반 갤러리(제3자 시점)에 포함
  assert.equal(
    listIncludes({ viewerId: 4, showMine: false, limit: 500 }, gid),
    true,
    '승인 후 일반 갤러리 탭에 노출되어야'
  );
});

// ──────────────────────────────────────────────────────────────────────────
// B-3: rejected 작품은 일반 갤러리에 영구 미노출(내 작품 탭에선 본인이 확인 가능).
// ──────────────────────────────────────────────────────────────────────────
test('SEC-B3: rejected 작품 — 일반 갤러리 미노출 / 내 작품 탭 노출', () => {
  const info = gallery.createGalleryItem(S1, { title: TITLE + '-reject', category: 'art' });
  const gid = info.lastInsertRowid || info.id || info;
  gallery.rejectGalleryItem(gid, '회귀-반려사유');
  const row = db.prepare('SELECT approval_status FROM student_gallery WHERE id = ?').get(gid);
  assert.equal(row.approval_status, 'rejected', 'reject 후 status=rejected');

  // 일반 갤러리 미노출 (본인 포함)
  assert.equal(
    listIncludes({ viewerId: S1, showMine: false, limit: 500 }, gid),
    false,
    'rejected 작품은 일반 갤러리 탭(본인 포함)에 노출되면 안 된다'
  );
  // 내 작품 탭엔 노출(상태 무관 본인 작품 전체)
  assert.equal(
    listIncludes({ viewerId: S1, studentId: S1, showMine: true, limit: 500 }, gid),
    true,
    'rejected 작품도 "내 작품" 탭에는 본인이 확인 가능해야'
  );
});

// ──────────────────────────────────────────────────────────────────────────
// B-4: 인기 작품(getPopularGalleryItems) 도 approved 만 — pending/rejected 누출 금지.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-B4: 인기 작품 목록도 approved 만 노출', () => {
  const info = gallery.createGalleryItem(S1, { title: TITLE + '-popular', category: 'art' });
  const gid = info.lastInsertRowid || info.id || info;
  // 좋아요/조회 충분히 부여해도 pending 이면 인기 목록 누출 금지
  db.prepare('UPDATE student_gallery SET like_count = 9999, view_count = 9999 WHERE id = ?').run(gid);

  const popular = gallery.getPopularGalleryItems({ period: 'all', limit: 50, viewerId: 4 });
  const ids = popular.map(p => p.id);
  assert.equal(ids.includes(gid), false, 'pending 작품은 좋아요가 많아도 인기 목록에 누출되면 안 된다');
});
