// test/contest-submit.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 회귀] 콘테스트 응모 '갤러리 공개' 정합 (REWORK M-2 — 거짓 약속 제거).
//   응모 모달의 '갤러리에도 공개' 체크박스를 FE 가 body.publish_to_gallery 로 보내지만,
//   기존 submitGalleryEvent 는 이 값을 무시하고 콘테스트 자체 플래그만 썼다 → 학생이
//   켜든 끄든 결과 동일(거짓 약속). 이제 student_gallery 복제 공개 조건은
//     event.publish_to_gallery(콘테스트 허용)  AND  body.publish_to_gallery(학생 선택)
//   로 결정된다(콘테스트가 비공개=0 이면 학생이 켜도 공개 안 함).
//
//   회귀 박제:
//     (1) 콘테스트 publish=1 + body publish=1 → student_gallery pending 1건 생성
//     (2) 콘테스트 publish=1 + body publish=0 → student_gallery 미생성(학생 선택 존중)
//     (3) 콘테스트 publish=0 + body publish=1 → student_gallery 미생성(콘테스트 정책 우선)
//     (4) 콘테스트 publish=1 + body 미지정(undefined) → 레거시 기본 공개(1건 생성)
//   어느 경우든 gallery_event_submissions 에는 응모 1건이 정상 기록된다.
//   + 생성된 student_gallery 는 반드시 approval_status='pending'(승인 원칙 유지).
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입(실 DB 무오염).
// 계정(실 DB 실측): student1=id3, teacher1=id2.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const growth = require('../db/growth');
const db = openTestDb();

const STUDENT = 3;   // student1 (응모자)
const HOST = 2;      // teacher1 (콘테스트 개설자)

// 응모 가능 기간(오늘 포함, 미래 종료)인 콘테스트를 시드한다.
// end_date 는 production 형식인 date-only, 충분히 미래로 둬 마감 검증 통과.
function seedContest(publishToGallery) {
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const info = db.prepare(`
    INSERT INTO gallery_events (title, description, category, start_date, end_date, host_user_id, event_type, publish_to_gallery)
    VALUES (?, ?, 'art', '2020-01-01', '2099-12-31', ?, 'apply', ?)
  `).run(`회귀-콘테스트-${tag}`, '회귀테스트', HOST, publishToGallery);
  return info.lastInsertRowid;
}

function countSubmissions(eventId) {
  return db.prepare('SELECT COUNT(*) AS c FROM gallery_event_submissions WHERE event_id = ?').get(eventId).c;
}
function galleryRowsFor(eventId, userId) {
  // 이 응모로 생성된 student_gallery 행(source='event:<id>' 로 식별)
  return db.prepare(
    "SELECT id, approval_status, source FROM student_gallery WHERE student_id = ? AND source = ?"
  ).all(userId, `event:${eventId}`);
}

// ──────────────────────────────────────────────────────────────────────────
// (1) 콘테스트 publish=1 + body publish=1 → student_gallery pending 1건 생성
// ──────────────────────────────────────────────────────────────────────────
test('SUBMIT-1: 콘테스트 허용(1) + 학생 선택(1) → student_gallery pending 1건 + 응모 1건', () => {
  const eid = seedContest(1);
  const r = growth.submitGalleryEvent(eid, STUDENT, {
    title: '응모작 A', description: '설명', image_url: null, publish_to_gallery: 1
  });
  assert.ok(r.galleryItemId, '갤러리 아이템이 생성되어야(공개 조건 충족)');
  const grows = galleryRowsFor(eid, STUDENT);
  assert.equal(grows.length, 1, 'student_gallery 1건 생성');
  assert.equal(grows[0].approval_status, 'pending', '승인 원칙: pending 으로 생성');
  assert.equal(countSubmissions(eid), 1, '응모(gallery_event_submissions) 1건 기록');
});

// ──────────────────────────────────────────────────────────────────────────
// (2) 콘테스트 publish=1 + body publish=0 → student_gallery 미생성(학생 선택 존중)
// ──────────────────────────────────────────────────────────────────────────
test('SUBMIT-2: 콘테스트 허용(1) + 학생 미선택(0) → student_gallery 미생성, 응모만 1건', () => {
  const eid = seedContest(1);
  const r = growth.submitGalleryEvent(eid, STUDENT, {
    title: '응모작 B', description: null, image_url: null, publish_to_gallery: 0
  });
  assert.equal(r.galleryItemId, null, '학생이 끄면 갤러리 미발행');
  assert.equal(galleryRowsFor(eid, STUDENT).length, 0, 'student_gallery 미생성');
  assert.equal(countSubmissions(eid), 1, '응모는 정상 1건 기록');
});

// ──────────────────────────────────────────────────────────────────────────
// (3) 콘테스트 publish=0 + body publish=1 → student_gallery 미생성(콘테스트 정책 우선)
// ──────────────────────────────────────────────────────────────────────────
test('SUBMIT-3: 콘테스트 비공개(0) + 학생 선택(1) → 콘테스트 정책 우선, student_gallery 미생성', () => {
  const eid = seedContest(0);
  const r = growth.submitGalleryEvent(eid, STUDENT, {
    title: '응모작 C', description: null, image_url: null, publish_to_gallery: 1
  });
  assert.equal(r.galleryItemId, null, '콘테스트가 비공개면 학생이 켜도 미발행');
  assert.equal(galleryRowsFor(eid, STUDENT).length, 0, 'student_gallery 미생성');
  assert.equal(countSubmissions(eid), 1, '응모는 정상 1건 기록');
});

// ──────────────────────────────────────────────────────────────────────────
// (4) 콘테스트 publish=1 + body 미지정(undefined) → 레거시 기본 공개(1건 생성)
//     (구버전 호출 호환: body 에 publish_to_gallery 가 없으면 "선택함"으로 간주)
// ──────────────────────────────────────────────────────────────────────────
test('SUBMIT-4: 콘테스트 허용(1) + body 미지정 → 레거시 기본 공개(student_gallery 1건)', () => {
  const eid = seedContest(1);
  const r = growth.submitGalleryEvent(eid, STUDENT, {
    title: '응모작 D', description: null, image_url: null // publish_to_gallery 미전달
  });
  assert.ok(r.galleryItemId, '미지정 시 레거시 기본 공개');
  const grows = galleryRowsFor(eid, STUDENT);
  assert.equal(grows.length, 1, 'student_gallery 1건 생성');
  assert.equal(grows[0].approval_status, 'pending', '승인 원칙: pending');
  assert.equal(countSubmissions(eid), 1, '응모 1건 기록');
});

// ──────────────────────────────────────────────────────────────────────────
// (5) is_published_to_gallery 플래그 정합: 발행한 경우 1, 미발행이면 0.
// ──────────────────────────────────────────────────────────────────────────
test('SUBMIT-5: submissions.is_published_to_gallery 플래그가 실제 발행 여부와 일치', () => {
  const eidOn = seedContest(1);
  growth.submitGalleryEvent(eidOn, STUDENT, { title: '플래그 On', publish_to_gallery: 1 });
  const onRow = db.prepare('SELECT is_published_to_gallery FROM gallery_event_submissions WHERE event_id = ?').get(eidOn);
  assert.equal(onRow.is_published_to_gallery, 1, '발행 시 플래그 1');

  const eidOff = seedContest(0);
  growth.submitGalleryEvent(eidOff, STUDENT, { title: '플래그 Off', publish_to_gallery: 1 });
  const offRow = db.prepare('SELECT is_published_to_gallery FROM gallery_event_submissions WHERE event_id = ?').get(eidOff);
  assert.equal(offRow.is_published_to_gallery, 0, '콘테스트 비공개면 플래그 0');
});
