// test/class-population-copies.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P1-C] 학생 모집단 SSOT 밖에 남아 있던 **손 SQL 사본** 회귀 박제.
//
// 7028533(P1-B)이 db/class.js 에 SSOT 를 세우고 INV-P6 소스 락의 술어를
// `role='member'` 리터럴 기준으로 뒤집자, 범위 밖에 잔존 사본 63건이 드러났다.
// 그중 성장기록·자기주도·평가·설문·포털 몫이 이 파일의 대상이다.
//
// ── 잡는 결함 (수정 전 실측, data/dacheum.db 2026-08-06 · 클래스 1) ──────────
//   A1 db/growth.js:115            getClassGrowthOverview      명단 8 (정본 7)
//   A2 db/growth-extended.js:661   getClassDashboard           명단 8 (정본 7)
//   A3 db/growth-extended.js:1789  getClassDailyLearning       명단 8 (정본 7)
//   A4 db/exam.js:163/169/175      평가 응시율 분모·분자       member_count 10 (정본 7)
//   A5 db/survey.js:69/74          설문 응답률 분모·분자       member_count 10 (정본 7)
//   A6 db/portal-extended.js:374   포털 교사 "미제출 N명"      분모 10 + 분자가 제출 "행 수"
//   A7 db/self-learn-extended.js:3151  오답노트 교사 대시보드(클래스 폴백) 명단 10
//   A8 routes/learning.js:222      getClassMembers().filter(m=>m.role==='student')
//                                  → cm.role 은 owner/member 뿐이라 **항상 빈 배열**(죽은 분모)
//   B* 삭제 계정 실명 노출 — self-learn-extended.js:3015/3024/3082 · portal-extended.js:54
//      실측: 삭제 계정 student7(한서윤, learning_logs 56건)이
//            /api/self-learn/ranking Top20 의 **9위**로 실제 노출되고 있었다.
//
// ── 건드리지 않기로 한 것 (분류 B — 이 테스트가 보호한다) ────────────────────
//   growth-extended.js 974/1270/2440/2524 는 "학생이 소속된 **클래스 집합**" 스코프다.
//   user_id=? 로 사람이 이미 1명 확정돼 있고 role='member' 는 "본인 개설 클래스 제외"를
//   뜻한다(학생 개설 클래스 id 999 실존). 여기에 studentPopulationSql 을 끼우면
//   고치는 게 아니라 망가뜨린다. → INV-P6 면제 마커 `pop-ok:` 로 사유와 함께 남긴다.
//
// 역주입 증명: 각 테스트 헤더의 "★ 역주입" 주석 참조.
// DB 격리: 실 DB → 임시 사본(_setup). 전용 시드로 결정적. 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema();
const classDb    = require('../db/class');
const growthDb   = require('../db/growth');
const growthExt  = require('../db/growth-extended');
const examDb     = require('../db/exam');
const surveyDb   = require('../db/survey');
const portalDb   = require('../db/portal-extended');
const selfLearn  = require('../db/self-learn-extended');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');
let _seq = 0;
const uniq = () => `${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function insUser(role, name, extra = {}) {
  const id = Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, ?)"
  ).run(`cpc_${role}_${uniq()}`, name, role).lastInsertRowid);
  if (extra.grade != null) db.prepare('UPDATE users SET grade = ? WHERE id = ?').run(extra.grade, id);
  if (extra.deleted) {
    db.prepare("UPDATE users SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }
  return id;
}

// ─── 시드: class-student-population.test.js 와 같은 혼입 4종 구성 ────────────
//   owner(teacher) + 살아있는 학생 3 + 학부모 + 교직원 + 삭제계정 학생 + 탈퇴 학생
//   → cm.role='member' AND status='active' = 6 · u.role='student' 포함 = 4 · 정본 = 3
const GRADE = 97;                     // 실 DB 와 겹치지 않는 전용 학년(랭킹 코호트 격리용)
const F = (() => {
  const owner   = insUser('teacher', '사본김선생');
  const s1      = insUser('student', '사본이학생', { grade: GRADE });
  const s2      = insUser('student', '사본박학생', { grade: GRADE });
  const s3      = insUser('student', '사본최학생', { grade: GRADE });
  const parent  = insUser('parent',  '사본이학부모');
  const staff   = insUser('staff',   '사본정교직원');
  const gone    = insUser('student', '사본한서윤', { grade: GRADE, deleted: true });
  const removed = insUser('student', '사본강다은', { grade: GRADE });

  const classId = Number(db.prepare(
    "INSERT INTO classes (name, owner_id, code) VALUES ('사본정리반', ?, ?)"
  ).run(owner, `CP_${uniq()}`.toUpperCase().slice(0, 16)).lastInsertRowid);

  const addM = db.prepare(
    'INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, ?)'
  );
  addM.run(classId, owner,   'owner',  'active');
  for (const s of [s1, s2, s3]) addM.run(classId, s, 'member', 'active');
  addM.run(classId, parent,  'member', 'active');
  addM.run(classId, staff,   'member', 'active');
  addM.run(classId, gone,    'member', 'active');    // 계정만 삭제, 멤버 행은 active
  addM.run(classId, removed, 'member', 'removed');

  // ── 평가 1개: s1 · 학부모 · 삭제계정 · 탈퇴자가 제출 ────────────────────
  const examId = `cpc_${uniq()}`;
  db.prepare(`INSERT INTO exams (id, class_id, title, answers, question_count, status, owner_id)
              VALUES (?, ?, '사본평가', '[]', 5, 'active', ?)`).run(examId, classId, owner);
  const addES = db.prepare(`INSERT INTO exam_students (exam_id, user_id, status, submitted_at)
                            VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP)`);
  for (const u of [s1, parent, gone, removed]) addES.run(examId, u);

  // ── 설문 1개: s1 · 학부모 · 삭제계정 · 탈퇴자가 응답 ─────────────────────
  const surveyId = Number(db.prepare(`INSERT INTO surveys (class_id, author_id, title, questions, status)
              VALUES (?, ?, '사본설문', '[]', 'active')`).run(classId, owner).lastInsertRowid);
  const addSR = db.prepare('INSERT INTO survey_responses (survey_id, user_id, answers) VALUES (?, ?, ?)');
  for (const u of [s1, parent, gone, removed]) addSR.run(surveyId, u, '{}');

  // ── 과제 1개(오늘 마감): s1 이 2건(초안 1 + 정식 1) · 학부모 1건 제출 ────
  //    분자를 "제출 행 수"로 세면 3, "제출 학생 인원"으로 세면 1.
  const hwId = Number(db.prepare(`INSERT INTO homework (class_id, teacher_id, title, status, due_date)
              VALUES (?, ?, '사본과제', 'published', DATE('now'))`).run(classId, owner).lastInsertRowid);
  const addHS = db.prepare(`INSERT INTO homework_submissions (homework_id, student_id, content, submitted_at, is_draft)
                            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)`);
  addHS.run(hwId, s1, '정식 제출', 0);
  addHS.run(hwId, parent, '학부모 제출', 0);
  addHS.run(hwId, gone, '삭제계정 제출', 0);

  // ── 오답노트: 혼입 인물도 보유(명단이 새면 화면에 실명이 뜬다) ──────────
  const addWA = db.prepare(`INSERT INTO wrong_answers (student_id, question_text, subject) VALUES (?, '사본문항', '수학')`);
  for (const u of [s1, s2, parent, staff, gone, removed]) addWA.run(u);

  return { classId, owner, s1, s2, s3, parent, staff, gone, removed, examId, surveyId, hwId };
})();

const EXPECTED = 3;                                  // 살아있는 순수 학생 s1·s2·s3
const SSOT_IDS = () => new Set(classDb.getClassStudentIds(F.classId));
const GHOSTS = [['학부모', 'parent'], ['교직원', 'staff'], ['삭제계정', 'gone'], ['탈퇴자', 'removed'], ['개설자', 'owner']];

/** 명단 배열에서 id 를 뽑는다(함수마다 키가 달라 방어적으로). */
const idsOf = (rows) => new Set((rows || []).map(r => Number(r.user_id ?? r.id ?? r.studentId)));

function assertRosterIsSsot(rows, label) {
  const got = idsOf(rows);
  assert.equal(got.size, EXPECTED,
    `${label} 명단이 ${got.size}명 — 정본 ${EXPECTED}명과 다르다 (학부모·교직원·삭제계정·탈퇴자 혼입)`);
  assert.deepEqual([...got].sort((a, b) => a - b), [...SSOT_IDS()].sort((a, b) => a - b),
    `${label} 명단이 학생 모집단 SSOT 와 다르다`);
  for (const [name, key] of GHOSTS) {
    assert.ok(!got.has(F[key]), `${label} 명단에 ${name}(uid=${F[key]})이 실명으로 노출된다`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q1. 성장기록 교사 현황(getClassGrowthOverview)의 명단 = SSOT.   [A1]
//   ★ 역주입: db/growth.js 를 `cm.role='member' AND u.role='student'` 로 되돌리면
//     삭제계정·탈퇴자가 들어와 5명이 되어 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q1 성장 현황(getClassGrowthOverview) 명단이 학생 모집단 SSOT 다', () => {
  assertRosterIsSsot(growthDb.getClassGrowthOverview(F.classId), '성장 현황');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q2. 성장 대시보드 6대 영역(getClassDashboard)의 명단 = SSOT.   [A2]
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q2 성장 대시보드(getClassDashboard) 명단이 학생 모집단 SSOT 다', () => {
  const r = growthExt.getClassDashboard(F.classId, F.owner, { period: 'monthly' });
  assertRosterIsSsot(r.students, '성장 대시보드');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q3. 오늘의 학습 클래스 상세(getClassDailyLearning)의 명단 = SSOT.   [A3]
//   결함이 특히 나빴던 곳: cm.role·cm.status 를 **둘 다** 안 봐서
//   탈퇴자는 물론 학생이 개설한 클래스의 owner 까지 학생으로 셌다(class 999 실존).
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q3 오늘의 학습 클래스 상세 명단이 학생 모집단 SSOT 다', () => {
  const r = growthExt.getClassDailyLearning(F.classId, { period: 'monthly' });
  assertRosterIsSsot(r.students, '오늘의 학습');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q4. 평가 응시율의 분모·분자가 같은 모집단.   [A4]
//   시드: 제출 4명(s1·학부모·삭제계정·탈퇴자) → 정답은 s1 1명뿐.
//   ★ 역주입: cm.role='member' AND cm.status='active' 로 되돌리면
//     member_count 6 · participated 3 이 되어 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q4 평가 member_count·participated·submitted 가 학생 모집단 안에 있다', () => {
  const r = examDb.getExamsByClass(F.classId, { limit: 50 });
  const row = r.exams.find(e => e.id === F.examId);
  assert.ok(row, '시드 평가가 목록에 있어야 한다');
  assert.equal(row.member_count, EXPECTED,
    `평가 분모(${row.member_count})가 학생 모집단(${EXPECTED})과 다르다 — 학부모·교직원이 응시 대상으로 잡힌다`);
  assert.equal(row.participated_count, 1,
    `응시 인원(${row.participated_count})에 학부모·삭제계정·탈퇴자가 섞였다 (정답 1)`);
  assert.equal(row.submitted_count, 1,
    `제출 인원(${row.submitted_count})에 학부모·삭제계정·탈퇴자가 섞였다 (정답 1)`);
  assert.ok(row.participated_count <= row.member_count, '분자 ⊄ 분모 — 응시율 100% 초과가 가능한 상태');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q5. 설문 응답률의 분모·분자가 같은 모집단.   [A5]
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q5 설문 member_count·respondent_count 가 학생 모집단 안에 있다', () => {
  const r = surveyDb.getSurveysByClass(F.classId, { limit: 50 });
  const row = r.surveys.find(s => s.id === F.surveyId);
  assert.ok(row, '시드 설문이 목록에 있어야 한다');
  assert.equal(row.member_count, EXPECTED,
    `설문 분모(${row.member_count})가 학생 모집단(${EXPECTED})과 다르다`);
  assert.equal(row.respondent_count, 1,
    `응답 인원(${row.respondent_count})에 학부모·삭제계정·탈퇴자가 섞였다 (정답 1)`);
  assert.ok(row.respondent_count <= row.member_count, '분자 ⊄ 분모 — 응답률 100% 초과가 가능한 상태');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q6. 포털 교사 카드 "미제출 N명" = 학생 모집단 − 제출한 **학생 인원**.  [A6]
//   결함(수정 전): 분모 = active 멤버 전원(6) · 분자 = homework_submissions **행 수**(3,
//   학부모·삭제계정 제출 포함) → 6−3 = 3. 정답은 3−1 = 2.
//   방금 배포한 7028533 감리 B-3(분자 ⊄ 분모)와 같은 형태다.
//   ★ 역주입: 분모를 role='member' 손 SQL 로, 분자를 COUNT(*) 로 되돌리면 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q6 포털 교사 "미제출" 이 학생 모집단 − 제출 학생 인원 이다', () => {
  const s = portalDb.getMyDashboardSummary(F.owner);
  assert.equal(s.role, 'teacher', '시드 개설자는 교사여야 한다(전제 확인)');
  assert.equal(s.missingSubs, EXPECTED - 1,
    `미제출 인원(${s.missingSubs})이 정답 ${EXPECTED - 1} 과 다르다 — ` +
    '분모에 학부모·교직원·삭제계정이 섞였거나, 분자를 "제출 학생 인원"이 아니라 "제출 행 수"로 세고 있다');
  assert.ok(s.missingSubs >= 0 && s.missingSubs <= EXPECTED,
    `미제출 인원이 0..${EXPECTED} 범위를 벗어났다 (${s.missingSubs})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q7. 오답노트 교사 대시보드(클래스 폴백)의 명단 = SSOT.   [A7]
//   학적(school+grade+class) 정보가 없는 교사는 채움클래스 폴백을 타는데,
//   그 SQL 이 `cm.role='member'` 하나뿐이라 학부모·교직원·삭제계정·탈퇴자가 전부 들어왔다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q7 오답노트 교사 대시보드(클래스 폴백) 명단이 학생 모집단 SSOT 다', () => {
  const teacher = db.prepare('SELECT school_name, grade, class_number FROM users WHERE id = ?').get(F.owner);
  assert.ok(!(teacher.school_name && teacher.grade && teacher.class_number),
    '시드 교사는 학적 정보가 없어야 클래스 폴백 분기를 탄다(전제 확인)');
  const r = selfLearn.getTeacherWrongNoteDashboard(F.classId, F.owner);
  assertRosterIsSsot(r.students, '오답노트 교사 대시보드');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q8. 삭제 계정 실명이 랭킹·명예의 전당·코호트에 뜨지 않는다.   [B*]
//   모집단은 그대로(학년/전체 학생) 두고 살아있는 계정 조건만 더한다.
//   실측(수정 전): 삭제 계정 student7(한서윤)이 /api/self-learn/ranking 9위.
//   ★ 역주입: liveUserSql 을 빼면 시드 삭제계정이 points 9,999,999 로 1위에 올라 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q8 삭제 계정이 학습 랭킹·명예의 전당·랭킹 코호트에 나타나지 않는다', () => {
  // 삭제 계정을 확실히 1위로 만든다(플랫폼 전체 랭킹이라 시드가 눈에 띄어야 한다).
  db.prepare("INSERT INTO user_points (user_id, points, source) VALUES (?, 9999999, 'test')").run(F.gone);
  const maxLogs = db.prepare(`
    SELECT COALESCE(MAX(c), 0) m FROM (
      SELECT COUNT(*) c FROM learning_logs ll JOIN users u ON u.id = ll.user_id
       WHERE u.role = 'student' GROUP BY u.id)
  `).get().m;
  const addLog = db.prepare("INSERT INTO learning_logs (user_id, activity_type, verb) VALUES (?, 'content_view', 'experienced')");
  for (let i = 0; i < maxLogs + 3; i++) addLog.run(F.gone);

  const rank = selfLearn.getRanking({ limit: 30 });
  assert.ok(!rank.some(r => Number(r.id) === F.gone),
    `삭제 계정(${F.gone})이 학습 랭킹에 실명으로 노출된다 — 1위: ${rank[0] && rank[0].display_name}`);

  const hof = portalDb.getHallOfFame(null, 'all');
  assert.ok(!(hof.topLearners || []).some(u => Number(u.id) === F.gone),
    '삭제 계정이 명예의 전당 최다학습 학습자에 노출된다');

  // 학년 코호트(total_users) 에서도 빠져야 한다 — 시드 학년 GRADE 의 살아있는 학생은 4명(s1·s2·s3·removed).
  const dash = selfLearn.getLearningDashboard(F.s1);
  assert.equal(dash.total_users, 4,
    `랭킹 코호트 인원(${dash.total_users})에 삭제 계정이 포함됐다 (시드 학년 ${GRADE} 살아있는 학생 4명)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q9. routes/learning.js 완료 현황이 죽은 분모를 쓰지 않는다.   [A8]
//   결함: getClassMembers() 는 cm.role(owner|member) 을 m.role 로 준다.
//     `.filter(m => m.role === 'student')` → **항상 빈 배열** → total 0 · rate 0 고정.
//   ★ 역주입: 그 filter 를 되돌리면 여기가 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q9 학습 완료 현황 라우트가 죽은 분모(m.role===\'student\') 를 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'learning.js'), 'utf8');
  const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l.trim())).join('\n');
  assert.ok(!/getClassMembers\([^)]*\)\s*\.filter\(\s*m\s*=>\s*m\.role\s*===\s*'student'\s*\)/.test(code),
    "getClassMembers().filter(m => m.role === 'student') 는 cm.role 값이 owner|member 뿐이라 항상 빈 배열이다(죽은 분모)");
  assert.ok(/classDb\.getClassStudents\(/.test(code),
    '완료 현황 명단은 classDb.getClassStudents() 를 경유해야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-Q10. FE 가 학생 수를 손으로 세지 않는다 — 서버가 준 값을 쓴다.
//   · lesson-board.html  getStudentTotal() 이 `m.role === 'member'` 로 세어
//     라벨("학생 수(개설자 제외)")과 달리 학부모·교직원을 포함했다(class 1: 10, 정본 7).
//   · find.html          같은 부류(술어가 class-home.html 과 갈림).
//   · class-home.html    submission_count 의 의미가 7028533 에서 "제출 행 수"→"제출 학생
//     인원" 으로 바뀌었는데 단위는 "건" 그대로였다 → "명".
// ─────────────────────────────────────────────────────────────────────────────
test('INV-Q10 수업 게시판·클래스 찾기 FE 가 학생 수를 손으로 세지 않는다', () => {
  // 결함을 설명하는 주석까지 걸리면 "고칠수록 붉어지는" 테스트가 된다 → 주석 줄 제거 후 검사.
  const codeOnly = (s) => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
  const lb = codeOnly(fs.readFileSync(path.join(ROOT, 'public', 'class', 'lesson-board.html'), 'utf8'));
  assert.ok(!/\.filter\(\s*m\s*=>\s*m\.role\s*===\s*'member'\s*\)\s*\.length/.test(lb),
    "lesson-board.html 이 학생 수를 `filter(m => m.role === 'member').length` 로 손계산한다 — " +
    '학부모·교직원 포함. BE 의 member_count(=getClassStudentCount SSOT)를 쓸 것');
  assert.ok(/member_count/.test(lb), 'lesson-board.html 은 BE 가 준 member_count 를 사용해야 한다');

  const fd = codeOnly(fs.readFileSync(path.join(ROOT, 'public', 'class', 'find.html'), 'utf8'));
  assert.ok(!/\.filter\(\s*m\s*=>\s*m\.role\s*===\s*'member'\s*\)\s*;/.test(fd),
    "find.html 의 멤버 미리보기 술어가 class-home.html 과 갈렸다 (user_role === 'student' 누락)");

  const ch = codeOnly(fs.readFileSync(path.join(ROOT, 'public', 'class', 'class-home.html'), 'utf8'));
  assert.ok(!/제출 \$\{h\.submission_count[^}]*\}건/.test(ch),
    'class-home.html 이 제출 "인원" 값을 "건" 으로 표기한다 — 7028533 에서 의미가 바뀌었다(감리 권고: "명")');
  assert.ok(/제출 \$\{h\.submission_count[^}]*\}명/.test(ch),
    'class-home.html 의 제출 표기는 "명" 이어야 한다');
});
