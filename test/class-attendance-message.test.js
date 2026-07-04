// test/class-attendance-message.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 감사 확정 2건 회귀 박제.
//
// [FIX-1][H] 자동 출석 전무 — db/attendance.js 에 ensureTodayAttendance 미정의.
//   routes/exam·lesson·homework·survey·board 가 require 해 호출하는데 정의·export 가
//   없어 try/catch 로 조용히 실패 → 학습 활동 시 "오늘 출석 자동 기록" 0건.
//   수정: ensureTodayAttendance(classId,userId,source) 정의 + export.
//     오늘 출석행 없으면 present 1행 생성(멱등), 있으면 무변경(수동/감정 데이터 보존).
//
// [FIX-2][H] 쪽지 1:1 상대 이름이 본인으로 오표시 — getRoomMembers 반환 키가 'id' 라
//   FE(class-home.html)가 m.user_id 로 파트너 판별 시 undefined → 항상 첫 멤버 반환.
//   수정(additive): SELECT 에 u.id AS user_id 추가(기존 u.id 유지).
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입.
//   테스트는 자체 시드(전용 class/user/room)로 하여 실 데이터 상태(오늘 출석 유무)에
//   의존하지 않는다 → 어떤 환경에서도 결정적.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema(); // 격리 DB 스키마 보강
const attendance = require('../db/attendance');
const message = require('../db/message');
const db = openTestDb();

const today = new Date().toISOString().slice(0, 10); // ensureTodayAttendance 와 동일 규칙

// ── 전용 시드: 격리 class + 두 학생 + 멤버십 ──────────────────────────────
function seedClassWithMembers() {
  const owner = db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, 'teacher')"
  ).run(`att_owner_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, '출석교사').lastInsertRowid;
  const stuA = db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, 'student')"
  ).run(`att_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, '홍길동').lastInsertRowid;
  const stuB = db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, 'student')"
  ).run(`att_b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, '김철수').lastInsertRowid;

  const classId = db.prepare(
    "INSERT INTO classes (name, owner_id, code) VALUES ('출석회귀반', ?, ?)"
  ).run(owner, `AT${Math.random().toString(36).slice(2, 8).toUpperCase()}`).lastInsertRowid;

  const addMember = db.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, 'active')"
  );
  addMember.run(classId, owner, 'owner');
  addMember.run(classId, stuA, 'member');
  addMember.run(classId, stuB, 'member');
  return { classId, owner, stuA, stuB };
}

function attendanceRows(classId, userId) {
  return db.prepare(
    'SELECT * FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?'
  ).all(classId, userId, today);
}

// ──────────────────────────────────────────────────────────────────────────
// FIX-1(a): export 존재 — 라우트가 require 하는 심볼이 실제로 있어야 함
// ──────────────────────────────────────────────────────────────────────────
test('ATT-EXPORT: ensureTodayAttendance 가 db/attendance 에서 export 된다', () => {
  assert.equal(typeof attendance.ensureTodayAttendance, 'function',
    'ensureTodayAttendance 함수가 export 되어야 (RED: 미정의면 undefined → 라우트 require 시 조용히 실패)');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-1(b): 첫 호출 → 오늘 present 1행 생성 (source 는 checkin_source 에 기록)
// ──────────────────────────────────────────────────────────────────────────
test('ATT-CREATE: 첫 호출 시 오늘 출석 present 1행 생성 + checkin_source 기록', () => {
  const { classId, stuA } = seedClassWithMembers();
  assert.equal(attendanceRows(classId, stuA).length, 0, '사전: 오늘 출석행 0');

  const r = attendance.ensureTodayAttendance(classId, stuA, 'lesson_view');
  assert.ok(r && r.success, '첫 호출 성공 반환');

  const rows = attendanceRows(classId, stuA);
  assert.equal(rows.length, 1, '오늘 출석행 1개 생성 (RED: 미정의면 0)');
  assert.equal(rows[0].status, 'present', 'status=present');
  assert.equal(rows[0].attendance_date, today, '오늘 날짜 귀속');
  assert.equal(rows[0].checkin_source, 'lesson_view', 'source 가 checkin_source 에 기록');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-1(c): 멱등 — 재호출해도 행 증가 없음
// ──────────────────────────────────────────────────────────────────────────
test('ATT-IDEMPOTENT: 재호출 시 행 증가 없음(멱등)', () => {
  const { classId, stuA } = seedClassWithMembers();

  attendance.ensureTodayAttendance(classId, stuA, 'lesson_view');
  attendance.ensureTodayAttendance(classId, stuA, 'homework_submit');
  attendance.ensureTodayAttendance(classId, stuA, 'exam_take');

  assert.equal(attendanceRows(classId, stuA).length, 1, '여러 번 호출해도 오늘 출석행은 1개(멱등)');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-1(d): 기존 수동 checkin/감정 데이터 보존 — 덮어쓰지 않음
// ──────────────────────────────────────────────────────────────────────────
test('ATT-PRESERVE: 이미 수동 출석(감정 포함)이 있으면 덮어쓰지 않음', () => {
  const { classId, stuB } = seedClassWithMembers();

  // 학생이 감정과 함께 수동 출석한 상태를 재현
  attendance.checkIn(classId, stuB, '오늘 기분 좋아요', 'happy', '날씨가 맑아서', 'manual');
  const before = attendanceRows(classId, stuB)[0];
  assert.ok(before, '수동 출석행 존재');
  assert.equal(before.emotion, 'happy', '감정 기록됨');
  assert.equal(before.checkin_source, 'manual', 'source=manual');

  // 이후 학습 활동으로 자동 출석 호출 → 무변경이어야
  const r = attendance.ensureTodayAttendance(classId, stuB, 'survey_respond');
  assert.ok(r && r.already, '이미 출석 → already 반환');

  const after = attendanceRows(classId, stuB);
  assert.equal(after.length, 1, '행 수 유지(1개)');
  assert.equal(after[0].emotion, 'happy', '감정 데이터 보존');
  assert.equal(after[0].comment, '오늘 기분 좋아요', '코멘트 보존');
  assert.equal(after[0].checkin_source, 'manual',
    'checkin_source 가 manual 로 유지(자동값으로 덮어쓰지 않음)');
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-2(a): getRoomMembers 반환에 user_id 키 존재 + 값 = u.id
// ──────────────────────────────────────────────────────────────────────────
test('MSG-USERID: getRoomMembers 가 user_id 키를 반환하고 값이 u.id 와 동일', () => {
  const { stuA, stuB } = seedClassWithMembers();

  const room = message.createRoom(null, 'direct', null, [stuA, stuB]);
  const members = message.getRoomMembers(room.id);

  assert.equal(members.length, 2, '방 멤버 2명');
  for (const m of members) {
    assert.ok('user_id' in m, "각 멤버에 user_id 키 존재 (RED: 'id' 만 있으면 FE m.user_id=undefined)");
    assert.equal(m.user_id, m.id, 'user_id 값이 u.id 와 동일');
    assert.ok('id' in m, '기존 id 키도 유지(다른 소비자 비파괴)');
    assert.ok('display_name' in m, 'display_name 유지');
  }

  // FE 파트너 판별 재현: 본인(stuA)이 아닌 멤버 = 상대(stuB), 본인으로 오표시되지 않아야
  const partner = members.find(m => m.user_id !== stuA);
  assert.ok(partner, '본인이 아닌 파트너를 찾을 수 있어야');
  assert.equal(partner.user_id, stuB, '파트너가 상대(stuB)여야 — 본인으로 오표시되면 실패');
  assert.equal(partner.display_name, '김철수', '상대 이름이 상대 것이어야(본인 이름 아님)');
});
