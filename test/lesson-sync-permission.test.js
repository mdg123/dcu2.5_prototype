// test/lesson-sync-permission.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [수업꾸러미 동기화 — 제어 권한 재검증] socket/index.js 의 canControlLesson 단위 검증.
//   기획서 §5: 동기화 제어 권한 = class_members(active) role ∈ {owner, co_teacher}
//             + lesson.class_id === classId 교차검증, 또는 users.role === 'admin'.
//   학생(member)·비멤버는 제어 불가. 타 클래스 lessonId 끼워넣기 차단.
//
//   소켓 실시간 자체(emit/broadcast/throttle)는 테스터 단계 E2E 로 검증.
//   BE 는 권한 분기 "함수 단위"까지 박제한다.
//
// DB 격리: 실 DB → 임시 복사본(_setup). db 모듈 require "전에" DB_PATH 주입.
//   실측 시드(data/dacheum.db): class 1 = owner user2, member user3, lesson id3(class 1).
//                               admin = user1. co_teacher 는 실 DB 에 없으므로 테스트에서 시드.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb(); // ★ socket/index.js 가 db 모듈을 require 하기 전에 DB_PATH 주입

const initSocket = require('../socket/index.js');
const canControlLesson = initSocket.canControlLesson;

// 실측 고정값 (data/dacheum.db)
const OWNER = 2;     // class 1 owner
const MEMBER = 3;    // class 1 member (학생)
const ADMIN = 1;     // 전역 admin
const CLASS = 1;
const LESSON = 3;    // class 1 소속 lesson

let tdb;
let coTeacherId = null;
let otherClassId = null;
let otherLessonId = null;

before(() => {
  tdb = openTestDb();

  // 격리된 복사본 한정: class_members.role CHECK 를 co_teacher 허용으로 완화.
  //   (라이브 스키마는 CHECK(role IN ('owner','member')) 이지만, db/class-mileage.js 는
  //    co_teacher 를 교사 동급으로 처리한다 — canControlLesson 의 co_teacher 분기 검증을
  //    위해 throwaway 테스트 DB 에서만 제약을 넓힌다. 실 DB 무오염.)
  tdb.pragma('foreign_keys = OFF');
  tdb.exec(`
    CREATE TABLE class_members_t (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'student',
      status TEXT DEFAULT 'active',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_visited_at DATETIME,
      UNIQUE(class_id, user_id),
      CHECK(role IN ('owner', 'member', 'co_teacher')),
      CHECK(status IN ('active', 'invited', 'left', 'removed'))
    );
    INSERT INTO class_members_t SELECT id, class_id, user_id, role, status, joined_at, last_visited_at FROM class_members;
    DROP TABLE class_members;
    ALTER TABLE class_members_t RENAME TO class_members;
  `);
  tdb.pragma('foreign_keys = ON');

  // co_teacher 시드: class 1 에 새 사용자(co_teacher 역할) 추가
  const ins = tdb.prepare(
    "INSERT INTO users (username, password, role, display_name) VALUES (?, ?, 'teacher', ?)"
  ).run('coteacher_test_' + Date.now(), 'x', '공동교사테스트');
  coTeacherId = Number(ins.lastInsertRowid);
  tdb.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'co_teacher', 'active')"
  ).run(CLASS, coTeacherId);

  // 타 클래스 + 그 클래스 소속 lesson 시드 (교차검증 차단 테스트용)
  const c = tdb.prepare(
    "INSERT INTO classes (name, code, owner_id) VALUES (?, ?, ?)"
  ).run('동기화테스트반', 'SYNCTEST' + (Date.now() % 100000), OWNER);
  otherClassId = Number(c.lastInsertRowid);
  const l = tdb.prepare(
    "INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, ?, 'published')"
  ).run(otherClassId, OWNER, '타클래스 수업');
  otherLessonId = Number(l.lastInsertRowid);
});

after(() => {
  try { tdb && tdb.open && tdb.close(); } catch (_) {}
});

test('owner(개설자)는 자기 클래스 수업 동기화 제어 가능', () => {
  assert.equal(canControlLesson(OWNER, CLASS, LESSON), true);
});

test('co_teacher(공동교사)는 동기화 제어 가능', () => {
  assert.equal(canControlLesson(coTeacherId, CLASS, LESSON), true);
});

test('admin(관리자)은 운영 목적으로 동기화 제어 가능(교차검증 통과 시)', () => {
  assert.equal(canControlLesson(ADMIN, CLASS, LESSON), true);
});

test('member(학생)는 동기화 제어 불가', () => {
  assert.equal(canControlLesson(MEMBER, CLASS, LESSON), false);
});

test('비멤버(클래스에 없는 사용자)는 동기화 제어 불가', () => {
  // 999999 = 존재하지 않는 사용자 → 멤버십·admin 모두 미통과
  assert.equal(canControlLesson(999999, CLASS, LESSON), false);
});

test('lesson↔class 교차검증: owner 라도 타 클래스 lessonId 끼워넣기 차단', () => {
  // owner 가 CLASS(1) 멤버지만, otherLessonId 는 다른 클래스 소속 → false
  assert.equal(canControlLesson(OWNER, CLASS, otherLessonId), false);
});

test('lesson↔class 교차검증: admin 도 lesson.class_id≠classId 면 차단', () => {
  assert.equal(canControlLesson(ADMIN, CLASS, otherLessonId), false);
});

test('존재하지 않는 lessonId 는 차단', () => {
  assert.equal(canControlLesson(OWNER, CLASS, 99999999), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// [H-1 회귀 박제 / M-1] lesson:sync:start 브로드캐스트 payload 계약 검증.
//   감리가 잡은 H-1: 서버가 룸 전체로 lesson:sync:state 를 broadcast 할 때 controllerId 를
//   안 실어서, 교사 본인이 자기 echo 를 받으면 FE 가 youAreController 를 false 로 덮어
//   토글이 "이어받기(주황)"로 오표기 + selectContent move-hook 사망 + 끄기 불가.
//   계약: start 브로드캐스트 payload.controllerId === 제어 교사(userId) 이어야 한다.
//
//   소켓 서버를 실제로 띄우지 않고, initSocket 에 fake io/socket 을 주입해 핸들러가
//   만들어내는 broadcast payload "구조"를 캡처·검증한다(가벼운 계약 테스트).
// ─────────────────────────────────────────────────────────────────────────────
test('H-1 회귀: lesson:sync:start 브로드캐스트 payload 에 controllerId 가 controller userId 와 일치', () => {
  const emitted = []; // {room, event, payload}

  // fake io: io.on('connection', fn) 캡처 + io.to(room).emit(event,payload) 기록
  let connectionHandler = null;
  const fakeIo = {
    on(ev, fn) { if (ev === 'connection') connectionHandler = fn; },
    to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; }
  };

  // initSocket 은 io.on('connection') 등록 + 1시간 sweep setInterval 설치.
  initSocket(fakeIo);
  assert.ok(typeof connectionHandler === 'function', 'connection 핸들러가 등록되어야 함');

  // fake socket: OWNER 세션. 핸들러 등록 캡처 + join/emit no-op.
  const handlers = {};
  const fakeSocket = {
    request: { session: { userId: OWNER } },
    id: 'sock-owner-1',
    join() {},
    leave() {},
    emit() {},
    on(ev, fn) { handlers[ev] = fn; }
  };

  // connection 진입 → lesson:* 핸들러들이 handlers 에 등록됨
  connectionHandler(fakeSocket);
  assert.ok(typeof handlers['lesson:sync:start'] === 'function', 'lesson:sync:start 핸들러 등록 확인');

  // OWNER 가 동기화 시작 → 룸 브로드캐스트 캡처
  handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });

  const states = emitted.filter(e => e.event === 'lesson:sync:state' && e.room === `lesson:${LESSON}`);
  assert.ok(states.length >= 1, 'start 시 lesson:sync:state 룸 브로드캐스트가 1회 이상 있어야 함');
  const payload = states[states.length - 1].payload;

  assert.equal(payload.on, true, 'start 브로드캐스트는 on:true');
  assert.ok('controllerId' in payload, 'H-1: 브로드캐스트 payload 에 controllerId 키가 반드시 존재해야 함');
  assert.equal(payload.controllerId, OWNER, 'H-1: controllerId 는 제어 교사(userId)와 일치해야 함');
});
