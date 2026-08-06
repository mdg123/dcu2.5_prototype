// test/class-student-population.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P1-B] 클래스 "학생 모집단" SSOT 회귀 박제 — W1-T1-3/4/5/9.
//
// 결함(수정 전, 라이브 class 1 실측 2026-08-06):
//   ① 홈 탭 활동 도넛  /api/lesson/1/completion-rate
//        routes/lesson.js:75  getClassMembers().filter(m=>m.role==='member')
//        → 10명 (학부모 parent1 · 교직원 staff1 · 삭제계정 student7 전원 포함)
//   ② 수업 탭 평균 이수율 = 수업별 (이수인원 / 8) 평균 — 분모는 순수학생 8
//   ③ 정답(살아있는 학생) = 7   ← student7(한서윤) users.status='deleted'
//      즉 한 페이지 안에서 분모가 10 / 8 / 7 세 벌.
//
//   ④ "이수 인원" 라벨↔산식 불일치:
//        db/lesson.js getLessonBoardList 주석 = "모든 콘텐츠를 완료한 학생"
//        SQL = COUNT(DISTINCT cp.user_id) WHERE completed=1  → 1개만 해도 이수.
//        같은 파일 getLessonsByClassWithProgress 는 HAVING >= totalContents (정답).
//        → 교사 화면 "8명 중 N명 이수" vs 학생별 표 is_complete 가 정면 모순.
//
//   ⑤ 삭제 계정이 명단에 실명 노출 (getClassMembers · 이수 현황 명단).
//
// 정본: db/class.js 의 SSOT 한 벌만 존재.
//   studentPopulationSql() / getClassStudents() / getClassStudentIds()
//   / getClassStudentCount() / isClassStudent()
//   = cm.role='member' AND cm.status='active' AND u.role='student'
//     AND 계정 미삭제(users.status<>'deleted' AND deleted_at IS NULL)
//
// 역주입 증명: studentPopulationSql 에서 계정삭제 조건을 빼면 INV-P2/P5 가,
//             getLessonBoardList 를 옛 COUNT(DISTINCT) 로 되돌리면 INV-P4 가 붉어진다.
//
// DB 격리: 실 DB → 임시 사본(_setup). 전용 시드로 결정적. 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema();
const classDb = require('../db/class');
const lessonDb = require('../db/lesson');
const homeworkDb = require('../db/homework');
const db = openTestDb();

let _seq = 0;
const uniq = () => `${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function insUser(role, name, extra = {}) {
  const id = Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, ?)"
  ).run(`pop_${role}_${uniq()}`, name, role).lastInsertRowid);
  if (extra.deleted) {
    db.prepare("UPDATE users SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }
  return id;
}

// 라이브 class 1 구성 재현:
//   owner(teacher) 1 + 살아있는 학생 3 + 학부모 1 + 교직원 1 + 삭제계정 학생 1 + 탈퇴(removed) 학생 1
//   → class_members active 행 = 7, u.role='student' = 5, 살아있는 학생 = 3(정답)
function seedClass() {
  const owner   = insUser('teacher', '김선생');
  const s1      = insUser('student', '이학생');
  const s2      = insUser('student', '박학생');
  const s3      = insUser('student', '최학생');
  const parent  = insUser('parent',  '이학부모');            // 혼입① 학부모
  const staff   = insUser('staff',   '정교직원');            // 혼입② 교직원
  const gone    = insUser('student', '한서윤', { deleted: true }); // 혼입③ 삭제 계정
  const removed = insUser('student', '강다은');              // 혼입④ 탈퇴(cm.status='removed')

  const classId = Number(db.prepare(
    "INSERT INTO classes (name, owner_id, code) VALUES ('모집단반', ?, ?)"
  ).run(owner, `PP_${uniq()}`.toUpperCase().slice(0, 16)).lastInsertRowid);

  const addM = db.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, ?)"
  );
  addM.run(classId, owner,   'owner',  'active');
  for (const s of [s1, s2, s3]) addM.run(classId, s, 'member', 'active');
  addM.run(classId, parent,  'member', 'active');
  addM.run(classId, staff,   'member', 'active');
  addM.run(classId, gone,    'member', 'active');   // 계정만 삭제, 멤버 행은 active
  addM.run(classId, removed, 'member', 'removed');

  // 콘텐츠 2개짜리 수업 1개 — "부분 이수"를 만들 수 있게.
  const lessonId = Number(db.prepare(
    "INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, '모집단수업', 'published')"
  ).run(classId, owner).lastInsertRowid);
  const cids = [1, 2].map(i => Number(db.prepare(
    "INSERT INTO contents (creator_id, title, content_type) VALUES (?, ?, 'document')"
  ).run(owner, `모집단콘텐츠${i}_${uniq()}`).lastInsertRowid));
  cids.forEach((cid, i) => db.prepare(
    'INSERT INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?, ?, ?)'
  ).run(lessonId, cid, i));

  // s1 = 2개 중 1개만 완료(부분) / s2 = 2개 모두 완료(이수) / s3 = 0개
  const prog = db.prepare(
    'INSERT INTO content_progress (user_id, content_id, lesson_id, completed, completed_at) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)'
  );
  prog.run(s1, cids[0], lessonId);
  prog.run(s2, cids[0], lessonId);
  prog.run(s2, cids[1], lessonId);
  // 혼입 인물도 완료 기록을 남긴다 → 모집단 필터가 없으면 이수 인원이 부풀어 오른다.
  prog.run(parent,  cids[0], lessonId);
  prog.run(parent,  cids[1], lessonId);
  prog.run(gone,    cids[0], lessonId);
  prog.run(gone,    cids[1], lessonId);
  prog.run(removed, cids[0], lessonId);
  prog.run(removed, cids[1], lessonId);

  const hwId = Number(db.prepare(
    "INSERT INTO homework (class_id, teacher_id, title, status) VALUES (?, ?, '모집단과제', 'published')"
  ).run(classId, owner).lastInsertRowid);

  return { classId, owner, s1, s2, s3, parent, staff, gone, removed, lessonId, hwId };
}

const F = seedClass();
const EXPECTED = 3;   // 살아있는 순수 학생: s1, s2, s3

// ─────────────────────────────────────────────────────────────────────────────
// INV-P1. SSOT 자체가 존재하고, 셋(수·명단·id) 이 서로 일치한다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P1 db/class.js 가 학생 모집단 SSOT 를 노출하고 수·명단·id 가 일치한다', () => {
  for (const fn of ['getClassStudents', 'getClassStudentIds', 'getClassStudentCount', 'isClassStudent', 'studentPopulationSql']) {
    assert.equal(typeof classDb[fn], 'function', `db/class.js 는 ${fn} 를 SSOT 로 노출해야 한다`);
  }
  const rows = classDb.getClassStudents(F.classId);
  const ids  = classDb.getClassStudentIds(F.classId);
  const cnt  = classDb.getClassStudentCount(F.classId);
  assert.equal(cnt, EXPECTED, `살아있는 순수 학생은 ${EXPECTED}명이어야 한다 (학부모·교직원·삭제계정·탈퇴자 제외)`);
  assert.equal(rows.length, cnt, 'getClassStudents().length === getClassStudentCount()');
  assert.equal(ids.length, cnt, 'getClassStudentIds().length === getClassStudentCount()');
  assert.deepEqual([...ids].sort((a, b) => a - b), [F.s1, F.s2, F.s3].sort((a, b) => a - b));
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P2. 혼입 4종(학부모·교직원·삭제계정·탈퇴자)이 모집단·명단 어디에도 없다.
//   ★ 역주입: studentPopulationSql 에서 계정삭제 조건을 빼면 여기서 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P2 학부모·교직원·삭제계정·탈퇴자가 모집단과 이수 명단에 없다', () => {
  const ids = new Set(classDb.getClassStudentIds(F.classId));
  for (const [label, uid] of [['학부모', F.parent], ['교직원', F.staff], ['삭제계정', F.gone], ['탈퇴자', F.removed], ['개설자', F.owner]]) {
    assert.ok(!ids.has(uid), `${label}(uid=${uid}) 은 학생 모집단에 있으면 안 된다`);
  }
  const roster = lessonDb.getLessonStudentProgress(F.lessonId, F.classId);
  const rosterIds = new Set(roster.map(r => r.user_id));
  for (const [label, uid] of [['학부모', F.parent], ['교직원', F.staff], ['삭제계정', F.gone], ['탈퇴자', F.removed]]) {
    assert.ok(!rosterIds.has(uid), `${label}(uid=${uid}) 이 교사 이수 현황 명단에 실명 노출되면 안 된다`);
  }
  // 멤버 목록(교사 관리 화면 · FE classMembers 원천)에서도 삭제 계정은 사라져야 한다.
  const memberIds = new Set(classDb.getClassMembers(F.classId).map(m => m.user_id));
  assert.ok(!memberIds.has(F.gone), '삭제 계정은 클래스 멤버 목록에 노출되면 안 된다');
  // 과잉 필터 금지 — 개설자·학부모·교직원은 "멤버 목록"에는 그대로 남아야 한다.
  for (const [label, uid] of [['개설자', F.owner], ['학부모', F.parent], ['교직원', F.staff]]) {
    assert.ok(memberIds.has(uid), `${label} 은 멤버 목록에서 사라지면 안 된다(과잉 필터)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P3. 분모 전수 일치 — 한 페이지 안에서 3벌이던 값이 전부 SSOT 와 같다.
//   (a) 홈 탭 활동 도넛      lessonDb.getClassAverageCompletionRate 의 분모
//   (b) 수업 게시판          getLessonBoardList().member_count
//   (c) 수업 목록            getLessonsByClassWithProgress().member_count
//   (d) 과제 제출률          getSubmissionStats().total_students
//   (e) 이수 현황 명단 길이  getLessonStudentProgress().length
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P3 이수율·제출률·명단의 분모가 전부 SSOT 와 같은 한 값이다', () => {
  const ssot = classDb.getClassStudentCount(F.classId);
  const board = lessonDb.getLessonBoardList(F.classId, { status: 'all' });
  const list  = lessonDb.getLessonsByClassWithProgress(F.classId, F.s1, { status: 'published' });
  const stats = homeworkDb.getSubmissionStats(F.hwId, F.classId);
  const roster = lessonDb.getLessonStudentProgress(F.lessonId, F.classId);

  // 나의 클래스 목록 카드의 "N명" · 제출률 분모(public/class/index.html 은 cls.student_count 를 쓴다)
  const myClass = classDb.getUserClasses(F.owner).find(c => c.id === F.classId);

  const seen = {
    SSOT: ssot,
    'getUserClasses.student_count': myClass && myClass.student_count,
    'getLessonBoardList.member_count': board.lessons[0].member_count,
    'getLessonsByClassWithProgress.member_count': list.lessons[0].member_count,
    'getSubmissionStats.total_students': stats.total_students,
    'getLessonStudentProgress.length': roster.length,
  };
  const uniqVals = [...new Set(Object.values(seen))];
  assert.equal(uniqVals.length, 1, `분모가 갈렸다: ${JSON.stringify(seen)}`);
  assert.equal(ssot, EXPECTED, `분모는 ${EXPECTED} 이어야 한다`);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P4. "이수 인원" 라벨 = "모든 콘텐츠를 완료한 학생" 산식.
//   ★ 역주입: getLessonBoardList 를 COUNT(DISTINCT cp.user_id ... completed=1) 로
//     되돌리면 3(s1 부분 + s2) 이 되어 붉어진다. 정답은 1(s2 만 전량 완료).
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P4 이수 인원 = 모든 콘텐츠를 완료한 학생 수 (학생별 표 is_complete 와 일치)', () => {
  const board = lessonDb.getLessonBoardList(F.classId, { status: 'all' });
  const row = board.lessons.find(l => l.id === F.lessonId);
  assert.ok(row, '시드 수업이 게시판 목록에 있어야 한다');

  const roster = lessonDb.getLessonStudentProgress(F.lessonId, F.classId);
  const trulyComplete = roster.filter(r => r.is_complete).length;

  assert.equal(trulyComplete, 1, '전량 완료 학생은 s2 1명뿐이어야 한다(전제 확인)');
  assert.equal(
    row.completed_students, trulyComplete,
    `"이수 인원"(${row.completed_students})이 학생별 표의 is_complete 인원(${trulyComplete})과 달라 ` +
    `같은 교사 화면 두 곳이 모순된다 — 1개만 완료해도 이수로 세는 옛 산식.`
  );
  // 목록 API(getLessonsByClassWithProgress)의 completed_students 와도 같은 값.
  const list = lessonDb.getLessonsByClassWithProgress(F.classId, F.s1, { status: 'published' });
  const lrow = list.lessons.find(l => l.id === F.lessonId);
  assert.equal(lrow.completed_students, trulyComplete, '수업 목록 API 의 이수 인원도 같은 산식이어야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P5. 클래스 평균 이수율(홈 탭 도넛) = 살아있는 학생만의 평균.
//   결함 시절: getClassMembers().filter(role==='member') → 학부모·교직원·삭제계정 포함.
//   시드 기준 정답: s1 1/2=50 · s2 2/2=100 · s3 0 → round((50+100+0)/3) = 50
//   혼입 시(학부모 100 · 삭제계정 100 · 6명 분모): round(350/6)=58 → 붉어짐.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P5 클래스 평균 이수율의 모집단이 살아있는 학생뿐이다', () => {
  assert.equal(
    typeof lessonDb.getClassAverageCompletionRate, 'function',
    'db/lesson.js 는 교사용 평균 이수율을 함수로 노출해야 한다(라우트에 손계산 사본 금지)'
  );
  const rate = lessonDb.getClassAverageCompletionRate(F.classId);
  const each = [F.s1, F.s2, F.s3].map(u => lessonDb.getClassCompletionStats(F.classId, u));
  const expected = Math.round(each.reduce((a, b) => a + b, 0) / each.length);
  assert.equal(rate, expected, `평균 이수율은 학생 ${each.join('/')} 의 평균 ${expected}% 여야 한다`);
  assert.equal(rate, 50, '시드 기준 정답은 50% (혼입 시 58%)');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P6. 모집단 정의가 SSOT 밖에 손으로 적혀 있지 않다.
//
// ── 술어를 뒤집은 이유 (2026-08-06 감리 B-4) ────────────────────────────────
//   초판 스캔은 `u.role='student'` 가 **적혀 있는** 줄만 잡았다. 즉 "거의 맞는"
//   사본만 걸리고, 학생 조건을 **아예 안 쓴 더 나쁜 변종**
//     `WHERE class_id=? AND status='active' AND role='member'`  (학부모·교직원 통과)
//   은 애초에 탐지 대상이 아니었다. 그 결과 725건 전건 초록인데 라이브에는
//   결함 2건이 살아 있었다:
//     · db/lesson.js  getClassSelfCheckAggregate  → total_members 10 (정본 7),
//       명단에 이학부모·정교직원·한서윤(삭제 계정) 노출
//     · routes/class.js /owner-summary            → missing 137 중 60건이 유령(43.8%)
//   초록불이 "결함 없음"이 아니라 "내가 보는 모양의 결함만 없음"이었던 사례다.
//
//   → 이제 **`role = 'member'` 리터럴** 을 기준으로 잡는다. 이 리터럴이 SSOT 밖
//     SQL 에 있을 정당한 이유는 없다(멤버십 판정은 studentPopulationSql 또는
//     getClassStudents/Count 경유). 신구 변종을 모두 덮는다.
//     · `cm.role = 'member'` / `role='member'` / `cm2.role = 'member'` 전부 매칭
//     · JS 비교(`m.role === 'member'`)는 `===` 라 매칭되지 않는다(FE 는 별도 R1 이 담당)
//     · db/class.js 는 정의가 사는 곳이므로 제외(addMember 기본값 포함)
//   ※ 하위호환: 옛 술어(u.role='student' 손 SQL)도 계속 함께 잡는다.
// ─────────────────────────────────────────────────────────────────────────────
const POPULATION_SCAN_TARGETS = [
  'db/lesson.js', 'db/homework.js',
  'routes/lesson.js', 'routes/class.js', 'routes/growth.js',
];

/** 파일에서 "손으로 적은 모집단 판정" 줄을 찾아 돌려준다(주석 줄 제외). */
function scanHandWrittenPopulation(absPath, rel) {
  const fs = require('fs');
  const hits = [];
  fs.readFileSync(absPath, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) return;
    if (/\brole\s*=\s*'member'/.test(line)            // ← 새 술어(핵심): 멤버십 손 판정
     || /\bu\.role\s*=\s*'student'/.test(line)        // ← 구 술어(하위호환)
     || /\bcu\.role\s*=\s*'student'/.test(line)) {
      hits.push(`${rel}:${i + 1}  ${t}`);
    }
  });
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// INV-P8. 셀프체크 미응답 명단이 두 API 에서 같은 사람들이다.  [감리 B-1]
//   결함: getClassSelfCheckAggregate 만 손 SQL 로 남아
//     aggregate(10명: 학부모·교직원·삭제계정 포함) vs self-check(7명) 로 갈렸다.
//   ★ 역주입: db/lesson.js 의 getClassStudents(classId) 를 옛 손 SQL 로 되돌리면 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P8 셀프체크 집계의 미응답 명단 == getClassNonRespondents 명단', () => {
  const agg = lessonDb.getClassSelfCheckAggregate(F.classId);
  const row = agg.lessons.find(l => l.lesson_id === F.lessonId);
  assert.ok(row, '시드 수업이 셀프체크 집계에 있어야 한다');

  // 분모부터 SSOT 와 같아야 한다
  assert.equal(row.total_members, classDb.getClassStudentCount(F.classId),
    `셀프체크 집계 분모(${row.total_members})가 학생 모집단(${classDb.getClassStudentCount(F.classId)})과 다르다`);

  // 아무도 응답하지 않은 상태 → 미응답 명단 = 전체 학생 명단
  const aggNames = row.rosters.understanding.none.map(x => x.display_name).sort();
  const nonResp = lessonDb.getClassNonRespondents(F.classId, F.lessonId).map(x => x.display_name).sort();
  assert.deepEqual(aggNames, nonResp,
    `같은 수업의 미응답 명단이 화면마다 다르다:\n  aggregate=${JSON.stringify(aggNames)}\n  self-check=${JSON.stringify(nonResp)}`);

  // 유령 4종이 교사 화면 명단에 실명으로 남으면 안 된다
  for (const [label, name] of [['학부모', '이학부모'], ['교직원', '정교직원'], ['삭제계정', '한서윤'], ['탈퇴자', '강다은']]) {
    assert.ok(!aggNames.includes(name), `${label}(${name})이 셀프체크 미응답 명단에 노출되면 안 된다`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P9. 제출률의 분자 ⊆ 분모.  [감리 B-3]
//   결함: getSubmissionStats 가 분모만 SSOT, 분자는 필터 0개 →
//     "명단 밖 제출"(전학·역할 변경) 1건이면 제출 2/7 인데 표는 2+6=8 로 어긋나고
//     극단적으로 100% 초과도 가능했다.
//   ★ 역주입: submitted_count 에서 studentPopulationSql 을 빼면 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P9 제출률 분자가 분모(학생 모집단) 안에 있다 — 명단 밖 제출 무시', () => {
  const denom = classDb.getClassStudentCount(F.classId);

  // 학생 모집단 안 1명 제출
  db.prepare(`INSERT INTO homework_submissions (homework_id, student_id, content, submitted_at, is_draft)
              VALUES (?, ?, '정상 제출', CURRENT_TIMESTAMP, 0)`).run(F.hwId, F.s1);
  // 명단 밖(다른 클래스 학생) 1명 제출 — 분자에 들어오면 안 된다
  const outsider = insUser('student', '전학생');
  db.prepare(`INSERT INTO homework_submissions (homework_id, student_id, content, submitted_at, is_draft)
              VALUES (?, ?, '명단 밖 제출', CURRENT_TIMESTAMP, 0)`).run(F.hwId, outsider);
  // 학부모가 낸 제출도 분자에 들어오면 안 된다
  db.prepare(`INSERT INTO homework_submissions (homework_id, student_id, content, submitted_at, is_draft)
              VALUES (?, ?, '학부모 제출', CURRENT_TIMESTAMP, 0)`).run(F.hwId, F.parent);

  const st = homeworkDb.getSubmissionStats(F.hwId, F.classId);
  assert.equal(st.total_students, denom, '분모는 학생 모집단이어야 한다');
  assert.equal(st.submitted_count, 1,
    `분자에 명단 밖·학부모 제출이 섞였다 (submitted_count=${st.submitted_count}, 정답 1)`);
  assert.ok(st.submitted_count <= st.total_students,
    `분자(${st.submitted_count}) ⊄ 분모(${st.total_students}) — 100% 초과가 가능한 상태`);
  assert.ok(st.percent <= 100, `제출률이 100% 를 넘었다: ${st.percent}%`);

  // FE 폴백 경로(submitted_count ?? submission_count)도 같은 모집단이어야 한다
  const list = homeworkDb.getHomeworkByClass(F.classId, { status: 'all' });
  const hwRow = (list.homework || list.homeworks || []).find(h => h.id === F.hwId);
  if (hwRow) {
    assert.equal(hwRow.submitted_count, hwRow.submission_count,
      `폴백 경로 submission_count(${hwRow.submission_count})가 submitted_count(${hwRow.submitted_count})와 다르면 ` +
      `FE 폴백이 일어나는 순간 분자만 바뀐다`);
  }
});

test('INV-P6 학생 모집단 판정이 db/class.js SSOT 밖에 손으로 적혀 있지 않다', () => {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const offenders = [];
  for (const rel of POPULATION_SCAN_TARGETS) {
    offenders.push(...scanHandWrittenPopulation(path.join(ROOT, rel), rel));
  }
  assert.deepEqual(offenders, [],
    '모집단 판정이 SSOT 밖에 손으로 적혀 있다 — classDb.studentPopulationSql() / getClassStudents() 를 경유할 것:\n'
    + offenders.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-P7. 감정 모니터(교사용)의 분모·명단도 같은 모집단이다.  [팀A 보고 / P1-B 추가]
//   결함(수정 전): routes/growth.js
//     · 분모  = COUNT(*) FROM class_members WHERE role='member'
//               → 학부모·교직원·삭제계정 포함. 실측 class 1 "전체 학생 10명"(정답 7).
//     · 명단  = JOIN class_members cm ... cm.status='active'  (cm.role 검사 없음)
//               → 감정 타임라인에 **교사(김선생)** 가 섞여 나왔다.
//   ★ 역주입: 두 곳 중 하나라도 되돌리면 여기가 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-P7 감정 모니터의 분모·감정 명단이 학생 모집단 SSOT 를 경유한다', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'growth.js'), 'utf8');
  const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l.trim())).join('\n');

  assert.ok(
    !/FROM class_members WHERE class_id = \? AND role = 'member'/.test(code),
    '감정 모니터 분모가 role=\'member\' 손 SQL 로 남아 있다(학부모·교직원·삭제계정 혼입)'
  );
  assert.ok(
    /getClassStudentCount\(classId\)/.test(code),
    '감정 모니터 분모는 classDb.getClassStudentCount() 를 경유해야 한다'
  );
  // 감정 기록 JOIN 이 cm.status 만 보던 자리(= 교사 혼입)가 SSOT 로 바뀌었는지
  assert.ok(
    !/JOIN class_members cm ON cm\.user_id = ec\.user_id AND cm\.status = 'active'/.test(code),
    '감정 기록 JOIN 이 cm.status 만 확인해 교사(개설자)까지 타임라인에 넣고 있다'
  );
  const spCount = (code.match(/studentPopulationSql\('cm', 'u'\)/g) || []).length;
  assert.ok(spCount >= 2,
    `감정 기록 조회 2곳(기간 목록·추이 목록)이 모두 SSOT 를 경유해야 한다 (현재 ${spCount}곳)`);
});
