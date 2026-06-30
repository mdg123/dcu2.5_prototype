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

// ─────────────────────────────────────────────────────────────────────────────
// [판서 동기화 계약] lesson:sync:draw / draw-clear / join snapshot 의 권한·payload 계약.
//   판서동기화 기획서 §3·§4·§8: 단방향(교사→서버→학생), draw/clear 는 canControlLesson +
//   controllerId 본인 + contentIndex 일치 3중 재검증. 학생/비controller emit 은 브로드캐스트 0.
//   좌표는 0~1 정규화 그대로 중계(서버는 클램프만, 변형 없음).
//
//   소켓 서버를 띄우지 않고 fake io/socket 주입으로 핸들러 산출 payload "구조"만 검증(H-1 패턴).
//   - io.to(room).emit  → 룸 브로드캐스트 (학생에게 보이는 채널)
//   - socket.emit       → 그 소켓에만 (join snapshot / lesson:error)
// ─────────────────────────────────────────────────────────────────────────────

// 공용 하네스: fake io + 임의 userId 소켓 연결 → 핸들러 맵 + 캡처 버퍼 반환.
function setupSyncHarness() {
  const roomEmits = [];   // {room, event, payload}  (io.to(room).emit)
  let connectionHandler = null;
  const fakeIo = {
    on(ev, fn) { if (ev === 'connection') connectionHandler = fn; },
    to(room) { return { emit(event, payload) { roomEmits.push({ room, event, payload }); } }; }
  };
  initSocket(fakeIo);

  // 주어진 userId 로 소켓 연결 → 핸들러 등록 + 그 소켓의 직접 emit 캡처.
  function connect(uid, sockId) {
    const handlers = {};
    const socketEmits = [];  // {event, payload}  (socket.emit — 그 소켓에만)
    const fakeSocket = {
      request: { session: { userId: uid } },
      id: sockId,
      join() {}, leave() {},
      emit(event, payload) { socketEmits.push({ event, payload }); },
      on(ev, fn) { handlers[ev] = fn; }
    };
    connectionHandler(fakeSocket);
    return { handlers, socketEmits };
  }
  return { roomEmits, connect };
}

test('판서: 학생(member)의 lesson:sync:draw 는 룸 브로드캐스트되지 않음(권한 차단)', () => {
  const h = setupSyncHarness();

  // 교사가 먼저 동기화 ON (contentIndex 0)
  const owner = h.connect(OWNER, 'sock-owner');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  owner.handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });

  // 학생이 draw 위조 emit
  const member = h.connect(MEMBER, 'sock-member');
  member.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  member.handlers['lesson:sync:draw']({
    classId: CLASS, lessonId: LESSON, contentIndex: 0,
    tool: 'pen', color: '#ff0000', nsize: 0.01,
    segments: [{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }]
  });

  // lesson:sync:annotation 룸 브로드캐스트가 학생 draw 로 인해 발생하면 안 됨
  const annots = h.roomEmits.filter(e => e.event === 'lesson:sync:annotation' && e.room === `lesson:${LESSON}`);
  assert.equal(annots.length, 0, '학생 draw 는 절대 브로드캐스트되지 않아야 함');
  // 본인에겐 lesson:error 통지(선택) — 차단 피드백
  const errs = member.socketEmits.filter(e => e.event === 'lesson:error');
  assert.ok(errs.length >= 1, '학생 draw 위조 시 본인에게 lesson:error 1회 통지');
});

test('판서: 교사 draw 브로드캐스트 payload 에 contentIndex + 정규화 segments(op:segments) 포함', () => {
  const h = setupSyncHarness();
  const owner = h.connect(OWNER, 'sock-owner-2');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  owner.handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });

  owner.handlers['lesson:sync:draw']({
    classId: CLASS, lessonId: LESSON, contentIndex: 0,
    tool: 'highlight', color: '#ffff00', nsize: 0.02,
    // 범위 밖 좌표(1.5, -0.3)는 서버가 0~1 로 클램프해야 함
    segments: [{ x0: 0.1, y0: 0.2, x1: 1.5, y1: -0.3 }]
  });

  const annots = h.roomEmits.filter(e => e.event === 'lesson:sync:annotation' && e.room === `lesson:${LESSON}`);
  assert.ok(annots.length >= 1, '교사 draw 는 룸 브로드캐스트 1회 이상');
  const p = annots[annots.length - 1].payload;
  assert.equal(p.op, 'segments', 'op 은 segments');
  assert.equal(p.contentIndex, 0, 'payload 에 contentIndex 포함');
  assert.equal(p.tool, 'highlight', 'tool 중계');
  assert.ok(Array.isArray(p.segments) && p.segments.length === 1, 'segments 배열 중계');
  const s = p.segments[0];
  // 0~1 클램프 검증: 1.5→1, -0.3→0, 정상값은 그대로
  assert.equal(s.x0, 0.1); assert.equal(s.y0, 0.2);
  assert.equal(s.x1, 1, 'x1=1.5 는 1 로 클램프');
  assert.equal(s.y1, 0, 'y1=-0.3 은 0 으로 클램프');
  assert.ok(s.x0 >= 0 && s.x0 <= 1 && s.x1 >= 0 && s.x1 <= 1, '모든 좌표 0~1 범위');
});

test('판서: contentIndex 불일치 draw 는 무시(전환 race 가드)', () => {
  const h = setupSyncHarness();
  const owner = h.connect(OWNER, 'sock-owner-3');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  owner.handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });  // currentIndex=0

  // 직전 콘텐츠(index 5)용 stroke 가 늦게 도착 → currentIndex(0)와 불일치 → 무시
  owner.handlers['lesson:sync:draw']({
    classId: CLASS, lessonId: LESSON, contentIndex: 5,
    tool: 'pen', color: '#fff', nsize: 0.01,
    segments: [{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }]
  });

  const annots = h.roomEmits.filter(e => e.event === 'lesson:sync:annotation' && e.room === `lesson:${LESSON}`);
  assert.equal(annots.length, 0, 'contentIndex 불일치 draw 는 브로드캐스트 0');
});

test('판서: 권한 없는(학생) draw-clear 는 무시(브로드캐스트 0)', () => {
  const h = setupSyncHarness();
  const owner = h.connect(OWNER, 'sock-owner-4');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  owner.handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });

  const member = h.connect(MEMBER, 'sock-member-4');
  member.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  member.handlers['lesson:sync:draw-clear']({ classId: CLASS, lessonId: LESSON, contentIndex: 0 });

  const clears = h.roomEmits.filter(e =>
    e.event === 'lesson:sync:annotation' && e.payload && e.payload.op === 'clear' && e.room === `lesson:${LESSON}`);
  assert.equal(clears.length, 0, '학생 draw-clear 는 절대 브로드캐스트되지 않아야 함');
});

test('판서: 교사 draw-clear 는 op:clear + contentIndex 브로드캐스트', () => {
  const h = setupSyncHarness();
  const owner = h.connect(OWNER, 'sock-owner-5');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  owner.handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });
  owner.handlers['lesson:sync:draw-clear']({ classId: CLASS, lessonId: LESSON, contentIndex: 0 });

  const clears = h.roomEmits.filter(e =>
    e.event === 'lesson:sync:annotation' && e.payload && e.payload.op === 'clear' && e.room === `lesson:${LESSON}`);
  assert.ok(clears.length >= 1, '교사 draw-clear 는 op:clear 브로드캐스트');
  assert.equal(clears[clears.length - 1].payload.contentIndex, 0, 'clear payload 에 contentIndex 포함');
});

test('판서: 늦은 입장 학생에게 op:snapshot(누적 strokes) 그 소켓에만 push', () => {
  const h = setupSyncHarness();
  // 교사 ON + index0 에 판서 1회 누적
  const owner = h.connect(OWNER, 'sock-owner-6');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  owner.handlers['lesson:sync:start']({ classId: CLASS, lessonId: LESSON, index: 0 });
  owner.handlers['lesson:sync:draw']({
    classId: CLASS, lessonId: LESSON, contentIndex: 0,
    tool: 'pen', color: '#ffffff', nsize: 0.01,
    segments: [{ x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }]
  });

  // 늦게 입장한 학생 — join 직후 그 소켓에만 snapshot 이 와야 함
  const late = h.connect(MEMBER, 'sock-late-member');
  late.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });

  const snaps = late.socketEmits.filter(e =>
    e.event === 'lesson:sync:annotation' && e.payload && e.payload.op === 'snapshot');
  assert.ok(snaps.length >= 1, '늦은 입장 학생에게 snapshot 1회 push');
  const sp = snaps[snaps.length - 1].payload;
  assert.equal(sp.contentIndex, 0, 'snapshot contentIndex=현재 인덱스');
  assert.ok(Array.isArray(sp.strokes) && sp.strokes.length === 1, 'snapshot strokes 누적 포함');
  const st = sp.strokes[0];
  assert.equal(st.tool, 'pen');
  assert.ok(Array.isArray(st.segments) && st.segments.length === 1, 'stroke segments 정규화 좌표 포함');
  // snapshot 은 그 소켓 전용 — 룸 전체 브로드캐스트로 새지 않아야 함(late.socketEmits 에만)
  const lateRoomSnaps = h.roomEmits.filter(e =>
    e.event === 'lesson:sync:annotation' && e.payload && e.payload.op === 'snapshot');
  assert.equal(lateRoomSnaps.length, 0, 'join snapshot 은 룸 브로드캐스트가 아니라 그 소켓에만');
});

// ─────────────────────────────────────────────────────────────────────────────
// [버그A 회귀 박제] lesson:sync:contents-changed — 콘텐츠 추가/삭제 신호의 권한·브로드캐스트 계약.
//   교사가 라이브 플레이어에서 콘텐츠를 추가/삭제하면 같은 lesson 룸 전체에 단순 신호를 보내
//   학생이 콘텐츠 목록만 소프트 리로드하게 한다. 좌표·인덱스 없는 신호({}).
//   - 교사(canControlLesson 통과): 룸 브로드캐스트 1회.
//   - 학생(member)·비권한: 브로드캐스트 0 + 본인에게 lesson:error 1회.
//   진짜 교차 클라이언트 와이어(2 socket.io-client)는 scratchpad/lesson-sync-itest.js 가 6/6 PASS 로 입증.
//   여기서는 핸들러 산출 payload "구조"를 fake io/socket 으로 박제(회귀 영구 고정).
// ─────────────────────────────────────────────────────────────────────────────
test('버그A: 교사 lesson:sync:contents-changed 는 룸에 빈 신호 1회 브로드캐스트', () => {
  const h = setupSyncHarness();
  const owner = h.connect(OWNER, 'sock-owner-cc');
  owner.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  assert.ok(typeof owner.handlers['lesson:sync:contents-changed'] === 'function',
    'lesson:sync:contents-changed 핸들러 등록 확인');

  owner.handlers['lesson:sync:contents-changed']({ classId: CLASS, lessonId: LESSON });

  const ccs = h.roomEmits.filter(e =>
    e.event === 'lesson:sync:contents-changed' && e.room === `lesson:${LESSON}`);
  assert.equal(ccs.length, 1, '교사 contents-changed 는 룸 브로드캐스트 정확히 1회');
  // 좌표·인덱스 없는 단순 신호 — payload 는 빈 객체
  assert.deepEqual(ccs[0].payload, {}, 'contents-changed payload 는 좌표 없는 빈 신호 {}');
});

test('버그A 권한: 학생(member)의 contents-changed 는 브로드캐스트 0 + 본인 lesson:error', () => {
  const h = setupSyncHarness();
  const member = h.connect(MEMBER, 'sock-member-cc');
  member.handlers['lesson:join']({ classId: CLASS, lessonId: LESSON });
  member.handlers['lesson:sync:contents-changed']({ classId: CLASS, lessonId: LESSON });

  const ccs = h.roomEmits.filter(e =>
    e.event === 'lesson:sync:contents-changed' && e.room === `lesson:${LESSON}`);
  assert.equal(ccs.length, 0, '학생 contents-changed 는 절대 브로드캐스트되지 않아야 함');
  const errs = member.socketEmits.filter(e => e.event === 'lesson:error');
  assert.ok(errs.length >= 1, '학생 위조 contents-changed 시 본인에게 lesson:error 1회 통지');
});

test('버그A 교차검증: owner 라도 타 클래스 lessonId 의 contents-changed 는 차단', () => {
  const h = setupSyncHarness();
  const owner = h.connect(OWNER, 'sock-owner-cc2');
  // 타 클래스 소속 lesson 으로 끼워넣기 시도 → canControlLesson 교차검증에서 차단
  owner.handlers['lesson:sync:contents-changed']({ classId: CLASS, lessonId: otherLessonId });

  const ccs = h.roomEmits.filter(e =>
    e.event === 'lesson:sync:contents-changed' && e.room === `lesson:${otherLessonId}`);
  assert.equal(ccs.length, 0, '타 클래스 lessonId contents-changed 는 브로드캐스트 0');
});
