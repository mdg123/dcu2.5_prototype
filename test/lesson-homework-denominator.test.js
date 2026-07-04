// test/lesson-homework-denominator.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 감사 확정 [H] 회귀 박제 — "수업 학생수 분모가 화면마다 5/6/7/8 제각각 +
//   이수 명단에 탈퇴자·학부모 혼입".
//
// 결함(수정 전, 라이브 class 2 실측):
//   getLessonBoardList.member_count            = 8  (COUNT(*) — 필터 전무: owner·parent·removed 전원)
//   getLessonStudentProgress 명단              = 7  (WHERE cm.role='member'만 — status·u.role 없음)
//   getLessonsByClassWithProgress.member_count = 6  (member+active, u.role 미확인 → parent 혼입)
//   getHomeworkByClass.member_count            = 6  (member+active, u.role 미확인 → parent 혼입)
//   getSubmissionStats.total_students          = 5  (유일하게 올바름: 순수 학생)
//
// 정본 기준(사용자 관점 "학생 수" = 순수 학생만):
//   분모 = cm.status='active' AND cm.role='member' AND u.role='student'
//          (owner·co_teacher·parent·removed 제외).
//
// fix 후 불변식:
//   (a) 네 함수의 학생 분모가 전부 동일값(= 순수 학생 수).
//   (b) 이수 명단에 role!='student' 또는 status!='active' 인물 부재
//       (탈퇴자·학부모 미출현).
//
// DB 격리: 실 DB → 임시 복사본(_setup). db 모듈 require "전에" DB_PATH 주입.
//   전용 시드(격리 class + 문제 구성 멤버)로 결정적. 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema(); // 격리 DB 스키마 보강
const lesson = require('../db/lesson');
const homework = require('../db/homework');
const db = openTestDb();

let _seq = 0;
const uniq = () => `${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function insUser(role, name) {
  return Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, ?)"
  ).run(`denom_${role}_${uniq()}`, name, role).lastInsertRowid);
}

// class 2 실측 구성 재현:
//   owner(teacher) 1 + 순수 학생(member/active/student) 5
//   + 학부모(member/active/parent) 1 + 탈퇴자(member/removed/student) 1  → 총 8행
function seedClass() {
  const owner   = insUser('teacher', '김선생');
  const s1 = insUser('student', '이학생');
  const s2 = insUser('student', '박학생');
  const s3 = insUser('student', '최학생');
  const s4 = insUser('student', '윤서준');
  const s5 = insUser('student', '임지호');
  const parent  = insUser('parent',  '이학부모');   // 혼입 대상 1 (학부모)
  const removed = insUser('student', '강다은');      // 혼입 대상 2 (탈퇴 학생)

  const classId = Number(db.prepare(
    "INSERT INTO classes (name, owner_id, code) VALUES ('분모회귀반', ?, ?)"
  ).run(owner, `DN_${uniq()}`.toUpperCase()).lastInsertRowid);

  const addM = db.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, ?)"
  );
  addM.run(classId, owner,   'owner',  'active');
  for (const s of [s1, s2, s3, s4, s5]) addM.run(classId, s, 'member', 'active');
  addM.run(classId, parent,  'member', 'active');   // 학부모지만 active member 행
  addM.run(classId, removed, 'member', 'removed');  // 학생이지만 removed(탈퇴)

  // 수업 1개 + 과제 1개 (분모/명단 함수가 대상 행을 반환하도록)
  const lessonId = Number(db.prepare(
    "INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, '분모수업', 'published')"
  ).run(classId, owner).lastInsertRowid);
  const hwId = Number(db.prepare(
    "INSERT INTO homework (class_id, teacher_id, title, status) VALUES (?, ?, '분모과제', 'published')"
  ).run(classId, owner).lastInsertRowid);

  return { classId, owner, students: [s1, s2, s3, s4, s5], parent, removed, lessonId, hwId };
}

const EXPECTED_PURE_STUDENTS = 5;

test('[분모통일] 네 함수의 학생 분모가 모두 동일값(순수 학생 수)이다', () => {
  const { classId, lessonId, hwId } = seedClass();

  const board = lesson.getLessonBoardList(classId, {});
  const boardMember = board.lessons[0].member_count;

  const wp = lesson.getLessonsByClassWithProgress(classId, 0, {});
  const wpMember = wp.lessons[0].member_count;

  const roster = lesson.getLessonStudentProgress(lessonId, classId);
  const rosterSize = roster.length;

  const hw = homework.getHomeworkByClass(classId, {});
  const hwMember = hw.homework[0].member_count;

  const stats = homework.getSubmissionStats(hwId, classId);
  const statsTotal = stats.total_students;

  // (a) 전부 동일값
  const all = [boardMember, wpMember, rosterSize, hwMember, statsTotal];
  assert.deepEqual(
    new Set(all).size, 1,
    `분모 불일치: board=${boardMember} withProgress=${wpMember} roster=${rosterSize} hw=${hwMember} stats=${statsTotal}`
  );
  // 순수 학생 수(5)와 일치
  assert.equal(boardMember, EXPECTED_PURE_STUDENTS, `분모가 순수 학생 수(${EXPECTED_PURE_STUDENTS})가 아님: ${boardMember}`);
});

test('[명단정합] 이수 명단에 탈퇴자·학부모가 없다 (role=student & status=active 만)', () => {
  const { classId, lessonId } = seedClass();

  const roster = lesson.getLessonStudentProgress(lessonId, classId);
  const names = roster.map(r => r.display_name);

  assert.equal(roster.length, EXPECTED_PURE_STUDENTS);
  assert.ok(!names.includes('이학부모'), `학부모(이학부모)가 이수 명단에 혼입됨: ${JSON.stringify(names)}`);
  assert.ok(!names.includes('강다은'),   `탈퇴자(강다은)가 이수 명단에 혼입됨: ${JSON.stringify(names)}`);

  // 명단 전원이 실제 순수 학생인지 DB로 역검증 (role!='student' 또는 status!='active' 부재)
  const userIds = roster.map(r => r.user_id);
  if (userIds.length) {
    const ph = userIds.map(() => '?').join(',');
    const bad = db.prepare(`
      SELECT COUNT(*) AS c
        FROM class_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.class_id = ? AND cm.user_id IN (${ph})
         AND (u.role != 'student' OR cm.status != 'active' OR cm.role != 'member')
    `).get(classId, ...userIds).c;
    assert.equal(bad, 0, '명단에 role!=student/status!=active/role!=member 인물 존재');
  }
});

test('[격리성] parent·removed 를 뺀 owner·co 없이 순수 학생만 카운트한다', () => {
  const { classId } = seedClass();
  // 원천 데이터: 총 8행(owner1 + student5 + parent1 + removed1)인데 분모는 5여야 함
  const total = db.prepare('SELECT COUNT(*) c FROM class_members WHERE class_id=?').get(classId).c;
  assert.equal(total, 8, `시드 구성 오류(총 멤버행): ${total}`);

  const board = lesson.getLessonBoardList(classId, {});
  assert.equal(board.lessons[0].member_count, EXPECTED_PURE_STUDENTS);
});
