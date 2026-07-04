// test/survey-denominator-pure-students.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 회귀 박제: 설문(및 수업·과제·평가) 응답률 "분모"는 순수 학생 수여야 한다.
//   — 개설자(owner/teacher)·공동교사(co_teacher)·학부모(user_role='parent')는 제외.
//
// 배경(감리 라이브 실측, REWORK):
//   public/class/class-home.html 의 getClassStudentCount() 가
//     classMembers.filter(m => m.role === 'member').length
//   로 계산 → 학부모(이학부모, user_role='parent')를 포함해 class 2 분모가 6.
//   순수 학생 4명 응답 시 화면이 67%(4/6)로 표시됨(올바른 값 80%(4/5)).
//   BE(lesson·homework·exam)는 이미 순수학생(5)로 통일 → 설문만 분모 제각각 재발.
//
// 수정:
//   getClassStudentCount() 필터에 `&& m.user_role === 'student'` 추가.
//     classMembers.filter(m => m.role === 'member' && m.user_role === 'student').length
//
// 이 테스트가 박는 3가지 불변식:
//   INV-DENOM-1  데이터 계약: class 2 활성 멤버 중 role='member' 는 학부모 1명을 포함한다
//                (즉 "role='member' 카운트 ≠ 순수 학생 수" 상황이 실제로 존재).
//   INV-DENOM-2  올바른 필터(member & student)는 학부모를 제외한 순수 학생 수를 돌려준다.
//                버그 필터(member only)는 그보다 크다(분모 과대 → 응답률 과소).
//   INV-DENOM-3  소스 락: class-home.html 의 getClassStudentCount() 는 학생 한정 필터를
//                사용하고, 학부모 포함 버그 필터로 되돌아가지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb(); // db 모듈 require 전에 DB_PATH 주입 (실 DB 무오염)
const classDb = require('../db/class');

const CLASS_ID = 2; // 즐거운 수학교실 — 학부모(이학부모) 멤버가 존재하는 시드

// FE(getClassStudentCount 1순위 경로)와 동일한 필터를 그대로 복제한다.
// classMembers = getClassMembers(classId) 가 FE로 내려가는 배열과 동일 계약.
function feStudentCount_correct(members) {
  return members.filter(m => m.role === 'member' && m.user_role === 'student').length;
}
function feStudentCount_buggy(members) {
  return members.filter(m => m.role === 'member').length; // 학부모 포함(과거 버그)
}

test('INV-DENOM-1: class 2 활성 멤버에 role=member 이지만 user_role=parent 인 학부모가 존재한다', () => {
  const members = classDb.getClassMembers(CLASS_ID);
  // getClassMembers 는 status='active' 만, u.role AS user_role 필드 포함 계약.
  assert.ok(Array.isArray(members) && members.length > 0, 'getClassMembers 는 멤버 배열을 반환해야 한다');
  members.forEach(m => {
    assert.ok('user_role' in m, `멤버 객체에 user_role 필드가 있어야 한다 (FE 필터 계약): ${JSON.stringify(m)}`);
  });
  const parents = members.filter(m => m.role === 'member' && m.user_role === 'parent');
  assert.ok(parents.length >= 1, 'class 2 에는 role=member 인 학부모가 최소 1명 있어야 이 회귀 시나리오가 성립한다');
});

test('INV-DENOM-2: 순수 학생 필터(member & student) = 5, 버그 필터(member only)는 그보다 크다', () => {
  const members = classDb.getClassMembers(CLASS_ID);
  const correct = feStudentCount_correct(members);
  const buggy = feStudentCount_buggy(members);

  // 시드 계약: class 2 순수 학생 5명(이학생·박학생·최학생·윤서준·임지호), 강다은은 removed.
  assert.strictEqual(correct, 5, `순수 학생 분모는 5여야 한다 (실제 ${correct}). members=${JSON.stringify(members.map(m=>({r:m.role,ur:m.user_role,n:m.display_name})))}`);
  assert.ok(buggy > correct, `버그 필터(${buggy})는 학부모 포함으로 순수 학생(${correct})보다 커야 한다(분모 과대 재발 감지)`);
  assert.strictEqual(buggy, 6, `버그 필터는 학부모 포함 6이어야 한다 (실제 ${buggy})`);

  // 응답률 계약: 순수 학생 4명 응답 시 올바른 값은 80%(4/5), 버그 시 67%(4/6).
  const respondents = 4;
  assert.strictEqual(Math.round(respondents / correct * 100), 80, '4명 응답 / 5명 = 80%');
  assert.strictEqual(Math.round(respondents / buggy * 100), 67, '(버그) 4명 응답 / 6명 = 67% — 이 값이 화면에 나오면 회귀');
});

test('INV-DENOM-3: 소스 락 — class-home.html getClassStudentCount 는 학생 한정 필터를 사용한다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'class', 'class-home.html'), 'utf8');

  // 올바른 필터가 반드시 존재
  assert.ok(
    html.includes("m.role === 'member' && m.user_role === 'student'"),
    "getClassStudentCount 는 순수 학생 필터(m.role === 'member' && m.user_role === 'student')를 써야 한다"
  );

  // 버그 필터(학부모 포함)가 부활하지 않았는지 — getClassStudentCount 함수 본문 범위에서 확인.
  const fnStart = html.indexOf('function getClassStudentCount');
  assert.ok(fnStart !== -1, 'getClassStudentCount 함수가 존재해야 한다');
  const fnBody = html.slice(fnStart, fnStart + 900);
  // 함수 본문 안에서 "role === 'member'" 뒤에 곧바로 ").length" 로 끝나는(=user_role 조건 없는) 필터 금지.
  assert.ok(
    !/filter\(m\s*=>\s*m\.role\s*===\s*'member'\s*\)\.length/.test(fnBody),
    "getClassStudentCount 본문에 학부모 포함 버그 필터(filter(m => m.role === 'member').length)가 있으면 안 된다"
  );
});
