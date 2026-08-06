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
// ── 면제 마커 `pop-ok:` (2026-08-06 P1-C) ──────────────────────────────────
//   술어를 `role='member'` 리터럴로 뒤집자, **같은 모양이지만 모집단이 다른** 정당한
//   SQL 까지 걸리기 시작했다. 대표적으로
//     `class_id IN (SELECT cm.class_id FROM class_members cm WHERE cm.user_id=? AND cm.role='member')`
//   는 사람 집합이 아니라 **클래스 집합**이고, role='member' 는 "본인이 개설한 클래스
//   제외"를 뜻한다(학생 개설 클래스 id 999 실존). 여기에 studentPopulationSql 을
//   끼우면 고치는 게 아니라 망가뜨린다.
//   → 파일 단위 제외(그 파일의 새 손 SQL 까지 눈감게 된다)가 아니라, **줄 단위 면제**로
//     사유를 코드 옆에 남긴다. 면제가 늘어나는 걸 감리가 그대로 검토할 수 있어야 하므로
//     사유는 반드시 구체적으로 쓴다("의도적" 같은 건 다음 사람에게 정보가 0이다).
const POP_OK = /\/\*\s*pop-ok:\s*\S/;
const POP_OK_MIN_REASON = 20;   // 사유 최소 길이(무의미한 마커 방지)

const POPULATION_SCAN_TARGETS = [
  'db/lesson.js', 'db/homework.js',
  'routes/lesson.js', 'routes/class.js', 'routes/growth.js',
  // ↓ P1-C(성장기록·자기주도·기타) 정리분
  'db/growth.js',
  'db/growth-extended.js',
  'db/self-learn-extended.js',
  'db/exam.js',
  'db/portal-extended.js',
  'db/survey.js',
  'routes/learning.js',
];

/** 파일에서 "손으로 적은 모집단 판정" 줄을 찾아 돌려준다(주석 줄·pop-ok 면제 제외). */
function scanHandWrittenPopulation(absPath, rel) {
  const fs = require('fs');
  const hits = [];
  fs.readFileSync(absPath, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) return;
    if (POP_OK.test(line)) return;                    // ← 사유가 적힌 의도적 면제
    if (/\brole\s*=\s*'member'/.test(line)            // ← 새 술어(핵심): 멤버십 손 판정
     || /\bu\.role\s*=\s*'student'/.test(line)        // ← 구 술어(하위호환)
     || /\bcu\.role\s*=\s*'student'/.test(line)) {
      hits.push(`${rel}:${i + 1}  ${t}`);
    }
  });
  return hits;
}

/** 면제 마커가 "사유 없는 백지수표"로 번지지 않게 감시한다. */
function scanPopOkMarkers(absPath, rel) {
  const fs = require('fs');
  const out = [];
  fs.readFileSync(absPath, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/\/\*\s*pop-ok:([\s\S]*?)\*\//);
    if (m) out.push({ where: `${rel}:${i + 1}`, reason: m[1].trim() });
  });
  return out;
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
// INV-P6b. 면제 마커(pop-ok)에는 **읽고 판단할 수 있는 사유**가 붙어 있다.
//   면제가 "붉은불 끄는 주문"으로 전락하면 INV-P6 는 있으나 마나다.
//
// ── [R-2 / 2026-08-06 감리] 순회 대상은 **두 티어의 합집합**이다 ──────────────
//   결함: 이 검사가 POPULATION_SCAN_TARGETS(엄격 티어)만 돌아서,
//   INV-L3(창 기반 티어)가 담당하는 LRS 파일의 pop-ok 는 **사유 검증도 상한 집계도
//   받지 못했다**(실측: routes/lrs.js:3884 가 무검사 통과, 집계 총수도 10 으로 과소).
//   면제 장치는 "어느 검사가 잡았느냐"와 무관하게 **한 곳에서 전수 관리**되어야 한다.
//   → 새 티어를 추가하면 아래 POP_OK_SCAN_TARGETS 에 반드시 합칠 것.
//   ※ 팀M 소유의 scanPopOkMarkers·scanHandWrittenPopulation 본체는 건드리지 않았다
//     (순회 대상만 통합).
// ─────────────────────────────────────────────────────────────────────────────
/** pop-ok 면제 전수 관리 대상 = 엄격 티어(INV-P6) ∪ 창 기반 티어(INV-L3). */
function popOkScanTargets() {
  return [...new Set([...POPULATION_SCAN_TARGETS, ...POPULATION_SCAN_CLASSJOIN_TARGETS])];
}

// 면제 총수 상한. 실측(2026-08-06) 11건 = 엄격 티어 10 + LRS 1 에 **딱 맞춰** 둔다.
//   여유를 크게 두면 면제가 조용히 불어나도 아무도 모른다 — 늘릴 땐 이 수를 함께 올리고
//   무엇이 왜 늘었는지 근거를 남길 것(그 강제가 이 상수의 존재 이유다).
const POP_OK_MAX = 11;

test('INV-P6b 모집단 면제 마커(pop-ok)에 구체적 사유가 적혀 있다', () => {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const bad = [];
  const all = [];
  for (const rel of popOkScanTargets()) {
    for (const m of scanPopOkMarkers(path.join(ROOT, rel), rel)) {
      all.push(m);
      if (m.reason.length < POP_OK_MIN_REASON || /^(의도적|ok|intentional)\.?$/i.test(m.reason)) {
        bad.push(`${m.where}  사유="${m.reason}"`);
      }
    }
  }
  assert.deepEqual(bad, [],
    `pop-ok 면제 사유가 비었거나 너무 짧다(${POP_OK_MIN_REASON}자 이상, 무엇이 모집단인지 쓸 것):\n` + bad.join('\n'));
  // 면제가 조용히 불어나면 감리가 알아채야 한다. 늘릴 땐 이 상한도 함께 올리고 근거를 남길 것.
  assert.ok(all.length <= POP_OK_MAX,
    `모집단 면제 마커가 ${all.length}개까지 늘었다(상한 ${POP_OK_MAX}) — 진짜 다른 모집단인지 전건 재검토가 필요하다:\n`
    + all.map(m => `${m.where}  ${m.reason.slice(0, 60)}`).join('\n'));
  // 순회 누락 방지 — 두 티어가 모두 실제로 돌았는지 자체 점검(LRS 가 빠졌던 것이 R-2 결함).
  assert.ok(popOkScanTargets().length === new Set([...POPULATION_SCAN_TARGETS, ...POPULATION_SCAN_CLASSJOIN_TARGETS]).size
    && POPULATION_SCAN_CLASSJOIN_TARGETS.every(f => popOkScanTargets().includes(f)),
    'pop-ok 순회 대상에 창 기반 티어(LRS) 파일이 빠졌다 — 그 파일의 면제가 무검사로 통과한다');
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

// ═════════════════════════════════════════════════════════════════════════════
// [P1-C · LRS 계열] 손 SQL 모집단 사본 — routes/lrs.js · db/lrs*.js  (2026-08-06)
//
// 배경: INV-P6 의 술어를 `role='member'` 로 뒤집자 범위 밖 잔존 63건이 드러났고
//       그중 LRS 계열이 43건이었다. 43건을 한 건씩 열어 분류한 결과:
//         (A) 클래스 학생 모집단이 맞음         19건 → SSOT 로 교체
//         (B) 다른 모집단이 의도(거시·타 원장)  23건 → **건드리면 안 됨**
//         (C) 죽은 disjunct                      1건 → 제거 (routes/lrs.js:4133)
//         (D) 로그 소유자 필터                   1건 → 계정삭제 필터만 추가
//
//   ★ (B) 23건이 이 작업의 핵심이다. LRS 는 클래스가 아닌 집계(학교·지역·전체)가
//     섞여 있어 기계적 일괄 치환을 하면 도달률·활성률이 조용히 움직인다.
//     예) routes/lrs.js 의 대시보드·equity·산점도는 충북 전체 학생 거시 지표다.
//         여기에 클래스 로스터를 끼우면 관리자 화면이 통째로 무의미해진다.
//
// 실측 유령(정본 DB 사본, 2026-08-06):
//   ① 삭제 계정 student7(한서윤) — users.status='deleted', 로그 56건
//        → /warnings/1 위험학생 명단에 **실명 노출**, class 1 학생수 8(정답 7)
//   ② 탈퇴 멤버 student5(강다은) — cm.status='removed', 로그 92건
//        → class 2 학생수 6(정답 5)
//   ③ 학생 개설자 student1 — cm.role='owner' 인데 u.role='student'
//        → class 999 학생수 1(정답 0). 개설자는 member 가 아니다.
//   ※ 학부모·교직원은 LRS 에서는 이미 u.role='student' 가 막고 있었다(팀A 범위와 다른 점).
//
// 움직인 지표(실측 전→후): B1 과제 제출률 23.6%→25.4%(분모 127→118·분자 30 불변),
//   /classes 학생수 8→7·6→5·1→0, getClassLrsStats.memberCount 8→7.
//   A1 도달률 계열은 lrs_achievement_stats(학생×성취기준) 기반이라 불변.
// ═════════════════════════════════════════════════════════════════════════════

// ── LRS 전용 시드: "학생이 개설한 반" + 유령들의 학습 로그 ────────────────────
//   기존 F 시드(교사 개설)로는 ③ 학생 개설자를 재현할 수 없어 반을 하나 더 만든다.
function seedLrsClass() {
  const studentOwner = insUser('student', '개설학생');                     // ③ 학생 개설자
  const alive1 = insUser('student', '엘반학생일');
  const alive2 = insUser('student', '엘반학생이');
  const goneL = insUser('student', '엘반삭제', { deleted: true });         // ① 삭제 계정
  const removedL = insUser('student', '엘반탈퇴');                         // ② 탈퇴 멤버
  const parentL = insUser('parent', '엘반학부모');

  const classId = Number(db.prepare(
    "INSERT INTO classes (name, owner_id, code, status) VALUES ('엘알에스반', ?, ?, 'active')"
  ).run(studentOwner, `LR_${uniq()}`.toUpperCase().slice(0, 16)).lastInsertRowid);

  const addM = db.prepare(
    'INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, ?)'
  );
  addM.run(classId, studentOwner, 'owner', 'active');   // 학생이지만 개설자 → 모집단 밖
  addM.run(classId, alive1, 'member', 'active');
  addM.run(classId, alive2, 'member', 'active');
  addM.run(classId, goneL, 'member', 'active');         // 계정만 삭제, 멤버 행은 active
  addM.run(classId, removedL, 'member', 'removed');     // 탈퇴
  addM.run(classId, parentL, 'member', 'active');

  // 학습 로그 — 유령도 활동 기록을 남긴다. 필터가 없으면 명단·집계에 그대로 올라온다.
  const log = db.prepare(`
    INSERT INTO learning_logs (user_id, class_id, activity_type, verb, result_score, result_success, duration_sec)
    VALUES (?, ?, 'exam_complete', 'completed', 80, 1, 600)
  `);
  for (const uid of [studentOwner, alive1, alive2, goneL, removedL, parentL]) log.run(uid, classId);

  return { classId, studentOwner, alive1, alive2, goneL, removedL, parentL };
}

const L = seedLrsClass();
const L_EXPECTED = 2;   // 살아있는 순수 학생 멤버: alive1, alive2

// ─────────────────────────────────────────────────────────────────────────────
// INV-L1. db/lrs-analytics.js 의 반 학생 헬퍼가 SSOT 와 같은 사람들을 돌려준다.
//   결함(수정 전): classStudentIds/classStudents = `cm.class_id=? AND u.role='student'`
//     → cm.role·cm.status·계정삭제를 전부 무시. 학생 개설자·탈퇴자·삭제 계정이 통과.
//   ★ 역주입: 두 함수를 옛 손 SQL 로 되돌리면 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-L1 lrs-analytics 반 학생 헬퍼가 유령 3종(삭제·탈퇴·학생개설자)을 제외한다', () => {
  const lrsA = require('../db/lrs-analytics');
  const ssot = classDb.getClassStudentIds(L.classId);
  assert.equal(ssot.length, L_EXPECTED, `전제: 살아있는 학생 멤버는 ${L_EXPECTED}명`);

  const ids = lrsA.classStudentIds(L.classId);
  assert.deepEqual([...ids].sort((a, b) => a - b), [...ssot].sort((a, b) => a - b),
    `classStudentIds 가 SSOT 와 다른 집합을 돌려준다 (현재 ${ids.length}명 / 정본 ${ssot.length}명)`);

  const names = lrsA.classStudents(L.classId).map(r => r.name);
  for (const [label, name] of [['삭제계정', '엘반삭제'], ['탈퇴자', '엘반탈퇴'],
                               ['학생개설자', '개설학생'], ['학부모', '엘반학부모']]) {
    assert.ok(!names.includes(name),
      `${label}(${name})이 LRS 학생 명단에 실명으로 노출된다: ${JSON.stringify(names)}`);
  }
  assert.equal(names.length, ssot.length, 'classStudents 길이도 SSOT 와 같아야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-L2. 클래스 학습분석(getClassLrsStats)의 분모와 명단.
//   (a) summary.memberCount = SSOT — 결함 시절 cm.role 미검사로 학생 개설자가 포함됐다.
//       memberCount 는 lessonCompletionRate·homeworkSubmitRate·examSubmitRate 의
//       분모(횟수 × 인원)이기도 해서, 틀리면 비율 3종이 함께 틀린다.
//   (b) byStudent 명단에 삭제 계정 실명 없음 — (D) 최소 조치(liveUserSql).
//       ※ byStudent 는 learning_logs.class_id 기준(로그 소유자)이라 재적 로스터가
//         아니다. 로스터로 바꾸면 "표의 의미"가 바뀌므로 계정삭제 필터만 건다.
//
// ── [R-1 / 2026-08-06 감리] 고지 단언을 뺀 이유 ────────────────────────────────
//   여기에 `assert.ok(st.byStudentScope)` 가 있었다. 그런데 그 필드를 렌더하는 FE 가
//   하나도 없었다 — 즉 **아무도 못 보는 문자열이 응답에 있다는 이유로 초록불**이었다.
//   이번 작업 전체가 잡으려던 결함("고쳤다고 적혀 있는데 사용자에게 도달하지 않은 것")과
//   같은 부류라, 필드·주석·단언을 함께 걷어냈다.
//   → 고지의 정본은 **화면**이다. byStudent 를 렌더하는 화면이 생기는 순간 그 화면에
//     고지를 넣고, 그때 비로소 그 화면을 겨냥한 스모크 단언을 붙이는 것이 옳다.
//     (지금 존재하지 않는 화면을 BE 필드로 대신 지킬 수는 없다.)
// ─────────────────────────────────────────────────────────────────────────────
test('INV-L2 getClassLrsStats 분모=SSOT, 학생별 표에 삭제 계정 실명이 없다', () => {
  const lrsDb = require('../db/lrs');
  const st = lrsDb.getClassLrsStats(L.classId);
  const ssot = classDb.getClassStudentCount(L.classId);

  assert.equal(st.summary.memberCount, ssot,
    `클래스 학습분석 분모가 SSOT(${ssot})와 다르다 — 이수율·제출률·응시율 3종의 분모가 함께 틀어진다`);

  const names = (st.byStudent || []).map(r => r.display_name);
  assert.ok(!names.includes('엘반삭제'),
    `삭제 계정이 학생별 활동 표에 실명 노출된다: ${JSON.stringify(names)}`);
  assert.ok(!names.includes('엘반학부모'), '학부모가 학생별 표에 있으면 안 된다');

  // 모집단 2벌이 실재한다는 사실 자체는 박제해 둔다 — 장래에 byStudent 를 화면에 그릴 때
  // "재적 수와 다를 수 있다"는 고지가 필요하다는 근거. (고지 유무는 화면이 생긴 뒤 그 화면에서 검사)
  const removedLogged = st.byStudent.some(r => r.display_name === '엘반탈퇴');
  assert.ok(removedLogged,
    '전제 확인: 탈퇴자가 로그를 남겨 byStudent(활동자) ⊅ memberCount(재적) 관계가 성립해야 한다');
  assert.notEqual(st.byStudent.length, ssot,
    'byStudent(활동자)와 memberCount(재적)는 서로 다른 모집단이다 — 같아졌다면 정의가 바뀐 것이니 재검토');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-L3. 소스 락 — LRS 계열 "반을 세는 손 SQL" 금지 (새 티어).
//
//   기존 INV-P6 은 리터럴이 있으면 무조건 위반으로 잡는다. LRS 에는 정당한
//   `u.role='student'`(전체·지역·학교급 거시 집계) 가 23곳 있어 그 규칙을 그대로
//   쓰면 오탐 23건이 난다. 그래서 **문장 창(±12줄)에 class_members 가 있을 때만**
//   위반으로 잡는다 = "반을 세면서 손으로 적은 SQL" 만 정확히 겨냥.
//     · `role='member'` 리터럴  → 창과 무관하게 무조건 위반
//     · `role='student'` 리터럴 → 창 안에 class_members 가 있을 때만 위반
//     · `pop-ok: <사유>`        → 면제(팀M 이 INV-P6 에 도입하는 마커와 같은 토큰)
//
//   ★ 수정 전 실측(2026-08-06): 이 스캔은 (A) 19건을 전건 포착 — 누락 0 ·
//     오탐 1(scope='all' 분기가 바로 아래 class_members 창에 걸림) → pop-ok 로 해소.
//   ★ 역주입: 교체한 곳 아무데나 옛 손 SQL 을 되돌리면 여기가 붉어진다.
//
// ── [N-1 / 2026-08-06 감리 2차] 별칭 의존을 제거했다 ─────────────────────────
//   결함: 학생 조건 술어가 `\b(u|cu)\.role='student'` 로 **별칭을 열거**하고 있었다.
//   그래서 routes/lrs.js:4194 의 `... JOIN users u2 ... AND u2.role = 'student'` 가
//   조용히 통과했고, /warnings/:classId 는 한 응답 안에서 inactive(SSOT) 와
//   weakAchievements(손 SQL) 의 모집단이 갈린 채로 초록불을 받았다.
//   별칭은 작성자가 마음대로 붙이는 이름이라(u2·x·stu·s…) 열거는 원리적으로 샌다.
//   → 이제 **별칭 이름과 무관하게** `<임의별칭>.role='student'` 및 별칭 없는
//     `role='student'` 를 모두 잡는다. `user_role='student'` 같은 다른 컬럼은
//     lookbehind 로 배제하고, JS 비교(`m.role === 'student'`)는 `===` 라 여전히 안 잡힌다.
//   ※ 팀M 소유의 scanHandWrittenPopulation·scanPopOkMarkers·INV-P6/P6b·POP_OK_MAX 는
//     손대지 않았다(이 함수 안의 술어만 일반화).
// ─────────────────────────────────────────────────────────────────────────────
//   구현은 test/_source-lock.js 한 곳에만 둔다 — INV-W2(test/lrs-warnings-population.test.js)가
//   "이 락이 별칭 무관하게 잡는가"를 같은 코드로 검증해야 하기 때문이다.
//   구현이 두 벌이면 "락은 초록인데 실제로는 안 잡히는" 상태가 다시 생긴다(= u2 사고의 구조).
const {
  POPULATION_SCAN_CLASSJOIN_TARGETS,
  scanClassScopedPopulation,
} = require('./_source-lock');

test('INV-L3 LRS 계열이 반을 세면서 모집단을 손으로 적지 않는다', () => {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const offenders = [];
  for (const rel of POPULATION_SCAN_CLASSJOIN_TARGETS) {
    offenders.push(...scanClassScopedPopulation(path.join(ROOT, rel), rel));
  }
  assert.deepEqual(offenders, [],
    'LRS 가 반 학생 모집단을 SSOT 밖에 손으로 적었다 — classDb.studentPopulationSql() 또는\n'
    + 'classDb.getClassStudentIds() 를 경유하고, 클래스 로스터가 아니면 pop-ok 사유를 병기할 것:\n'
    + offenders.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-L4. (B) 23건 보호 — 거시 집계는 클래스 로스터로 바뀌지 않았다.
//   이 작업의 최대 위험은 "고치다가 관리자 지표를 클래스 모집단으로 좁히는 것"이다.
//   거시 쿼리 근처에 class_members / studentPopulationSql 이 침투하면 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-L4 관리자 거시 집계가 클래스 모집단으로 좁혀지지 않았다', () => {
  const fs = require('fs');
  const path = require('path');
  const lines = fs.readFileSync(path.join(__dirname, '..', 'routes', 'lrs.js'), 'utf8').split(/\r?\n/);

  // 거시 지표의 표지 — 전 사용자 학생 모집단으로 남아 있어야 하는 대표 지점.
  const MACRO_MARKERS = [
    'u.school_level IS NOT NULL',   // 학교급 미니카드(관리자 대시보드)
    'u.school_name IS NOT NULL',    // 지역 드릴다운
  ];
  for (const marker of MACRO_MARKERS) {
    const idx = lines.findIndex(l => l.includes(marker));
    assert.ok(idx >= 0, `거시 집계 표지(${marker})가 사라졌다 — 관리자 지표가 통째로 바뀐 것 아닌가`);
    const win = lines.slice(Math.max(0, idx - 10), idx + 10).join('\n');
    assert.ok(!/class_members|studentPopulationSql/.test(win),
      `거시 집계(${marker})에 클래스 모집단이 침투했다 — 전체·지역 지표가 반 단위로 좁혀진다`);
  }
});
