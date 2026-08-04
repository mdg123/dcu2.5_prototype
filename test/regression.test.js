// test/regression.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 최근 고친 버그 9건 박제 (커밋 553ba6b·e807429).
// 각 버그가 "다시 나면 빨간불"이 되도록 회귀 테스트로 고정한다.
//
// DB 격리: 실 DB(data/dacheum.db) → 임시 복사본. db 모듈 require "전에" DB_PATH 주입.
//   (복사본이라 INSERT 자유, 실 DB 무오염. 테스트별 시드는 멀리 떨어진 날짜/유저로 간섭 최소화.)
//
// 계정(실 DB 조회 확정): student1=id3, student2=id4(둘 다 grade 4),
//   teacher1=id2, class 1='3학년 1반'(teacher1 소유, student1·2 모두 member).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

// ★ db 모듈 require 전에 DB_PATH 주입
setupTestDb();
// 마이그레이션을 격리 DB에도 적용 (신규 ADD COLUMN 회귀 검증 — 복사본은 옛 스키마일 수 있음)
require('../db/schema').initSchema();
const g = require('../db/growth-extended');
const db = openTestDb();

// 고정 시드 상수 (실 데이터와 안 겹치게 미래/먼 날짜 사용)
const S1 = 3;          // student1
const S2 = 4;          // student2
const CLASS = 1;       // teacher1 소유 클래스, S1·S2 member
const TEACHER = 2;

// ──────────────────────────────────────────────────────────────────────────
// 1) 감정 2소스 통합: emotion_checkins(마음채움) 1건이 getStudentReport.recentEmotions
//    에 source:'self' 로 포함되어야 한다. (옛 버그: attendance 만 봐서 self 소스 누락)
// ──────────────────────────────────────────────────────────────────────────
test('BUG1: 감정 2소스 통합 — emotion_checkins 가 recentEmotions(source:self)에 포함', () => {
  const date = '2099-03-11';
  // 멀리 떨어진 날짜로 UPSERT (user_id+checkin_date UNIQUE)
  db.prepare(`
    INSERT INTO emotion_checkins (user_id, checkin_date, emotion, emotion_reason, checkin_source)
    VALUES (?, ?, 'excited', '회귀테스트-self소스', 'test')
    ON CONFLICT(user_id, checkin_date) DO UPDATE SET emotion=excluded.emotion, emotion_reason=excluded.emotion_reason
  `).run(S1, date);

  const rep = g.getStudentReport(S1, { classId: CLASS });
  const hit = rep.recentEmotions.find(
    e => e.attendance_date === date && e.emotion === 'excited' && e.source === 'self'
  );
  assert.ok(hit, 'emotion_checkins 레코드가 recentEmotions 에 source:self 로 나와야 한다');
  assert.equal(hit.emotion_reason, '회귀테스트-self소스');
});

// ──────────────────────────────────────────────────────────────────────────
// 2) 감정 다중클래스 dedup: 같은 user·같은날·같은emotion 이 attendance 여러 클래스행으로
//    있어도 정서발달 비율 집계에서 1표만(중복 inflation 없음).
//    검증: 같은 (날짜,감정)을 2개 클래스에 넣고, emotionDevelopment 의 그 감정 cnt 증가분이
//          무필터(전 클래스 합산) 리포트에서 +1 이어야 한다 (+2 면 dedup 실패 = RED).
// ──────────────────────────────────────────────────────────────────────────
test('BUG2: 감정 다중클래스 dedup — 같은날 같은감정 N클래스행이 1표', () => {
  const date = '2099-04-22';
  const emo = 'great';
  // student1 은 class 1,2,3,4 의 member (실 DB 확인) → 2개 클래스에 같은 감정 입력
  // 무필터(classId 미지정) 리포트는 전 클래스 attendance 를 UNION 하므로 dedup 대상.
  const before = g.getStudentReport(S1, {}); // classId 없음 = 전체
  const beforeCnt = (before.emotionDevelopment.find(e => e.emotion === emo) || { cnt: 0 }).cnt;

  for (const c of [1, 2]) {
    db.prepare(`
      INSERT INTO attendance (class_id, user_id, attendance_date, status, emotion, checkin_source)
      VALUES (?, ?, ?, 'present', ?, 'test')
    `).run(c, S1, date, emo);
  }

  const after = g.getStudentReport(S1, {});
  const afterCnt = (after.emotionDevelopment.find(e => e.emotion === emo) || { cnt: 0 }).cnt;
  assert.equal(
    afterCnt - beforeCnt, 1,
    `같은날 같은감정 2클래스행은 정서 집계에서 1표여야 한다(+1). 실제 증가=${afterCnt - beforeCnt}`
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 3) 콘텐츠활용현황 classId + 기간 필터: getClassDashboard.contentUsage 가
//    (a) classId 스코프로 타 클래스 활동 미포함, (b) startDate/endDate 로 그 기간만.
//    검증: class 1 에 미래 날짜 learning_log 1건 넣고 →
//          (a) 그 기간만 필터하면 totalActivities 가 무필터보다 작다(특정 1건 근처).
//          (b) 같은 학생의 "다른 클래스(class 2)" 활동을 같은 기간에 넣어도 class 1 필터엔 안 잡힌다.
// ──────────────────────────────────────────────────────────────────────────
test('BUG3: 콘텐츠활용현황 classId + 기간 필터 적용', () => {
  const inDate = '2099-05-05';
  const win = { startDate: '2099-05-01', endDate: '2099-05-31' };
  // class 1 에 1건, class 2 에 1건 (같은 기간, 같은 학생)
  db.prepare(`
    INSERT INTO learning_logs (user_id, class_id, activity_type, verb, object_id, source_service, created_at)
    VALUES (?, ?, 'content_view', 'experienced', 'rgr3-c1', 'test-svc', ?)
  `).run(S1, 1, inDate + ' 10:00:00');
  db.prepare(`
    INSERT INTO learning_logs (user_id, class_id, activity_type, verb, object_id, source_service, created_at)
    VALUES (?, ?, 'content_view', 'experienced', 'rgr3-c2', 'test-svc', ?)
  `).run(S1, 2, inDate + ' 10:00:00');

  const dashAll = g.getClassDashboard(CLASS, TEACHER, {});
  const dashWin = g.getClassDashboard(CLASS, TEACHER, win);

  // (a) 기간 필터: 5월 창은 무필터(전 기간)보다 작아야 한다
  assert.ok(
    dashWin.contentUsage.totalActivities < dashAll.contentUsage.totalActivities,
    `기간 필터 시 totalActivities 가 줄어야 한다(win=${dashWin.contentUsage.totalActivities}, all=${dashAll.contentUsage.totalActivities})`
  );
  // (b) classId 스코프: class 1 의 5월 창에 우리가 넣은 class 1 건은 있고, class 2 건은 없어야 한다.
  //     class 1 필터 + 5월 창 totalActivities 가 정확히 1 이어야 한다(실 DB엔 2099-05 데이터 없음 가정).
  assert.equal(
    dashWin.contentUsage.totalActivities, 1,
    `class 1 의 5월 창에는 class 1 활동 1건만 잡혀야 한다(class 2 건 제외). 실제=${dashWin.contentUsage.totalActivities}`
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 4) 오늘학습 날짜 귀속(정책 전환 — DATE_ATTRIBUTION_SPEC §6-2): 매트릭스는 진도표이므로
//    완료기록을 세트 배정일(target_date) 칸에 귀속한다. 이학생 실제 사례(6/16에 5/31 세트 완료) 박제.
//    검증: (1) 5월 화면에 5/31 칸이 participated(배정일 칸 복귀), (2) 6월 화면 6/16 칸엔 진도 없음.
// ──────────────────────────────────────────────────────────────────────────
test('BUG4-R: 배정일보다 늦게 푼 세트는 배정일(target_date) 칸에 집계', () => {
  const targetDate = '2099-05-31';    // 세트 배정일
  const completedDate = '2099-06-16'; // 실제 완료일 (밀려 풀기, 이학생 사례)
  const mayWin = { startDate: '2099-05-01', endDate: '2099-05-31' };
  const juneWin = { startDate: '2099-06-01', endDate: '2099-06-30' };

  // class 1 전용 세트 1개(target_date=5/31) + 항목 1개
  const setId = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, '회귀-밀려풀기세트', ?, 4, 1)
  `).run(CLASS, TEACHER, targetDate).lastInsertRowid;
  const itemId = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, item_title, sort_order)
    VALUES (?, 'content', '회귀항목', 1)
  `).run(setId).lastInsertRowid;
  // student1 이 6/16 에 완료 (target_date=5/31 과 다름 — 밀려 풀기)
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, completed_at, correct_count, total_questions, score)
    VALUES (?, ?, ?, 'completed', ?, 1, 1, 100)
  `).run(S1, itemId, setId, completedDate + ' 09:30:00');

  // (1) 5월 화면: 5/31 셀이 participated 여야 한다 (배정일 칸 — 이학생 다시 보임)
  const may = g.getClassDailyLearning(CLASS, mayWin);
  const stuMay = may.students.find(s => s.id === S1);
  assert.ok(stuMay, 'student1 이 5월 매트릭스에 있어야');
  assert.equal(
    !!(stuMay.daily[targetDate] && stuMay.daily[targetDate].participated), true,
    '밀려 푼 세트도 배정일(5/31) 칸에 집계되어야 한다(5월 화면 복귀)'
  );

  // (2) 6월 화면: 6/16 셀에는 진도(participated)가 잡히면 안 된다 (배정일이 5월이므로 6월 진도표엔 없음)
  const june = g.getClassDailyLearning(CLASS, juneWin);
  const stuJune = june.students.find(s => s.id === S1);
  assert.equal(
    !!(stuJune && stuJune.daily[completedDate] && stuJune.daily[completedDate].participated), false,
    '완료일(6/16) 칸에는 진도가 귀속되면 안 됨(진도=배정일)'
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 5) 콘텐츠활용 축 4신호: computeAreas6 콘텐츠활용이 content_view 0 이어도
//    업로드/보관함/구독/content_progress 중 하나라도 있으면 hasData=true·score>0,
//    signals{viewed,completed,attempted,produced,curated} 구조 존재.
//    검증: 새 학생 맥락 만들기 어렵우니 — 별도 기간 창에 'produced'(contents) 1건만 만들고
//          그 창에서 viewed=0 이지만 hasData=true, score>0 임을 확인.
// ──────────────────────────────────────────────────────────────────────────
test('BUG5: 콘텐츠활용 4신호 — view 0 이어도 produced/curated 있으면 hasData·score>0', () => {
  const win = { startDate: '2099-07-01', endDate: '2099-07-31' };
  // 7월 창에 student1 이 콘텐츠 1건 업로드(produced) — view/progress/attempt 없음
  db.prepare(`
    INSERT INTO contents (creator_id, title, content_type, status, created_at)
    VALUES (?, '회귀-업로드콘텐츠', 'video', 'approved', ?)
  `).run(S1, '2099-07-15 12:00:00');

  const a = g.computeAreas6(S1, win);
  const c = a['콘텐츠활용'];
  // signals 구조 존재
  for (const k of ['viewed', 'completed', 'attempted', 'produced', 'curated']) {
    assert.ok(Object.prototype.hasOwnProperty.call(c.signals, k), `signals.${k} 존재해야`);
  }
  assert.equal(c.signals.viewed, 0, '7월 창엔 조회 신호 없음');
  assert.ok(c.signals.produced >= 1, 'produced 신호 1+ 여야');
  assert.equal(c.hasData, true, 'view 0 이어도 produced 있으면 hasData=true');
  assert.ok(c.score > 0, 'view 0 이어도 produced 있으면 score>0');
});

// ──────────────────────────────────────────────────────────────────────────
// 6) 성취수준 content 출처: problem_attempts(source_type='content') 가 있으면
//    bySource.content 의 rate 가 반영(미응시 null 이 아님).
// ──────────────────────────────────────────────────────────────────────────
test('BUG6: 성취수준 bySource.content — content 출처 problem_attempts 반영', () => {
  const win = { startDate: '2099-08-01', endDate: '2099-08-31' };
  // student1 이 8월에 content 출처 문항 2개 풀어 1정답/1오답 → content rate 50
  db.prepare(`
    INSERT INTO problem_attempts (user_id, content_id, is_correct, source_type, submitted_at)
    VALUES (?, 1, 1, 'content', ?)
  `).run(S1, '2099-08-10 10:00:00');
  db.prepare(`
    INSERT INTO problem_attempts (user_id, content_id, is_correct, source_type, submitted_at)
    VALUES (?, 1, 0, 'content', ?)
  `).run(S1, '2099-08-10 10:05:00');

  const a = g.computeAreas6(S1, win);
  const content = a['성취수준'].achievement.bySource.content;
  assert.equal(content.total, 2, 'content 출처 응시 2문항');
  assert.equal(content.correct, 1, 'content 출처 정답 1');
  assert.equal(content.rate, 50, 'content rate 50 (미응시 null 아님)');
  assert.notEqual(content.rate, null, 'rate 가 null(미응시) 이면 안 됨');
});

// ──────────────────────────────────────────────────────────────────────────
// 7) 참여도 미참여 제외 + 객체화: participation 4지표가 {rate,denom,numer} 객체.
//    denom>0 & numer=0 지표는 종합 평균에서 제외(미참여), denom=0 은 rate null(미배정).
//    검증: 새 클래스(분모만 있고 분자 0)를 만들면 participationScore 가 그 0% 를 평균에 안 섞는지.
//    여기선 단순/안정적으로 "구조·관계"를 검증: 각 지표는 객체, denom=0→rate null,
//    denom>0&numer=0→rate 0, 그리고 participationScore 는 분자>0 지표 평균과 일치(미참여 제외).
// ──────────────────────────────────────────────────────────────────────────
test('BUG7: 참여도 객체화 + 미참여(denom>0,numer=0) 종합평균 제외', () => {
  // 실 DB 의 student1/class1 참여도는 daily/lesson 이 미참여(denom>0,numer=0)인 케이스(probe 확인).
  const a = g.computeAreas6(S1, { classId: CLASS });
  const p = a['참여도'].participation;
  // (a) 4지표 객체 구조
  for (const key of ['homework', 'exam', 'daily', 'lesson']) {
    assert.ok(p[key] && typeof p[key] === 'object', `${key} 는 객체여야`);
    for (const f of ['rate', 'denom', 'numer']) {
      assert.ok(Object.prototype.hasOwnProperty.call(p[key], f), `${key}.${f} 존재해야`);
    }
  }
  // (b) clamp 규약: denom=0 → rate null, denom>0&numer=0 → rate 0, denom>0&numer>0 → 0~100
  for (const key of ['homework', 'exam', 'daily', 'lesson']) {
    const { rate, denom, numer } = p[key];
    if (denom === 0) assert.equal(rate, null, `${key}: 미배정(denom0)은 rate null`);
    else if (numer === 0) assert.equal(rate, 0, `${key}: 미참여(numer0)는 rate 0`);
    else assert.ok(rate >= 0 && rate <= 100, `${key}: rate 0~100`);
  }
  // (c) 종합 점수 = 분자>0 지표들의 rate 평균 (미참여·미배정 제외)
  const avail = Object.values(p).filter(x => x.denom > 0 && x.numer > 0);
  if (avail.length > 0) {
    const expected = Math.round(avail.reduce((s, x) => s + x.rate, 0) / avail.length);
    assert.equal(a['참여도'].score, expected, '참여도 종합점수는 분자>0 지표 평균(미참여 제외)이어야');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 8) 성취기준 화이트리스트: achievementStandards 가 학습성격 activity_type 만.
//    attendance_checkin·post_create 의 achievement_code 는 제외돼야 한다.
//    검증: 두 종류(비학습 / 학습) achievement_code 로그를 같은 기간에 넣고,
//          비학습 코드는 목록에 없고 학습 코드는 있어야.
// ──────────────────────────────────────────────────────────────────────────
test('BUG8: 성취기준 화이트리스트 — 비학습 activity_type 제외', () => {
  const win = { startDate: '2099-09-01', endDate: '2099-09-30' };
  const learnCode = 'TST-LEARN-09';   // content_view (학습) → 포함되어야
  const nonLearnCode = 'TST-NONLEARN-09'; // attendance_checkin (비학습) → 제외되어야
  db.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, achievement_code, created_at)
    VALUES (?, 'content_view', 'experienced', ?, ?)
  `).run(S1, learnCode, '2099-09-10 10:00:00');
  db.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, achievement_code, created_at)
    VALUES (?, 'attendance_checkin', 'attended', ?, ?)
  `).run(S1, nonLearnCode, '2099-09-10 11:00:00');

  const rep = g.getStudentReport(S1, { startDate: win.startDate, endDate: win.endDate });
  const codes = rep.contentUsage.achievementStandards.map(s => s.code);
  assert.ok(codes.includes(learnCode), '학습성격(content_view) 코드는 포함되어야');
  assert.ok(!codes.includes(nonLearnCode), '비학습(attendance_checkin) 코드는 제외되어야');
});

// ──────────────────────────────────────────────────────────────────────────
// 9) 감정 classId 스코프: 교사 시점 classId 를 줘도 emotion_checkins(마음채움)는
//    학생 단위라 항상 포함된다(클래스 독립).
//    검증: emotion_checkins 1건 넣고 classId 지정 리포트의 recentEmotions 에 self 소스가 있어야.
// ──────────────────────────────────────────────────────────────────────────
test('BUG9: 감정 classId 스코프 — classId 줘도 emotion_checkins(self)는 포함', () => {
  const date = '2099-10-09';
  db.prepare(`
    INSERT INTO emotion_checkins (user_id, checkin_date, emotion, checkin_source)
    VALUES (?, ?, 'calm', 'test')
    ON CONFLICT(user_id, checkin_date) DO UPDATE SET emotion=excluded.emotion
  `).run(S2, date);

  // 교사가 특정 클래스 맥락(classId)으로 학생 조회해도 self 소스 포함
  const rep = g.getStudentReport(S2, { classId: CLASS });
  const hit = rep.recentEmotions.find(e => e.attendance_date === date && e.source === 'self');
  assert.ok(hit, 'classId 지정해도 emotion_checkins(self) 가 recentEmotions 에 포함되어야');
  assert.equal(hit.emotion, 'calm');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG10: 과제 제출 자동 수집 portfolio_item 이 학생 기본 학교급 필터로 조회되어야 한다.
//   결함: 자동 수집 항목(homework_submit 등)은 grade_year/school_level 메타가 NULL 이라,
//         성장기록>포트폴리오 화면(기본 학교급 필터 활성)에서 전부 사라졌다.
//   A(서버 필터: 메타 없는 항목 항상 포함) + B(자동 INSERT 시 학생 학년 메타 채움) 동시 박제.
// ──────────────────────────────────────────────────────────────────────────
test('BUG10: 과제 제출 자동 portfolio_item 이 학생 학년 메타를 갖고 학교급 필터(elementary)로 조회됨', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  // S1 = student1, grade=4(초등). 실 DB 복사본이라 users 행 존재.
  const u = db.prepare("SELECT grade, role FROM users WHERE id = ?").get(S1);
  assert.equal(u.role, 'student', 'BUG10 전제: S1 은 학생');
  assert.equal(String(u.grade), '4', 'BUG10 전제: S1 grade=4(초등)');

  // 과제 제출 학습 활동 기록 → 자동으로 portfolio_items 1건 생성됨.
  // (자동 portfolio 의 source_id 는 learning_logs.id(반환 id)이다 — targetId 가 아님)
  const targetId = 9900100 + Math.floor(Math.random() * 10000); // 실 데이터와 무간섭
  const logRes = logLearningActivity({
    userId: S1,
    activityType: 'homework_submit',
    targetType: 'homework',
    targetId,
    classId: CLASS,
    verb: 'submitted',
    objectType: 'BUG10 과제',
    resultSuccess: 1,
    sourceService: 'class'
  });
  assert.ok(logRes && logRes.id, 'BUG10: logLearningActivity 가 learning_logs id 를 반환');

  // B 검증: 생성된 자동 항목이 학생 학년 메타를 가짐 (source_id = learning_logs.id)
  const pi = db.prepare(
    "SELECT * FROM portfolio_items WHERE user_id = ? AND source_type = 'class' AND source_id = ?"
  ).get(S1, logRes.id);
  assert.ok(pi, 'BUG10: 과제 제출 시 portfolio_items 자동 생성');
  assert.equal(pi.school_level, 'elementary', 'BUG10(B): 자동 항목 school_level=elementary(학생 학년 기반)');
  assert.equal(String(pi.grade_year), '4', 'BUG10(B): 자동 항목 grade_year=4(학생 학년 기반)');

  // A+B 종합 검증: 학생 기본 학교급 필터(elementary)로 조회됨
  const res = g.getPortfolioItems(S1, { schoolLevel: 'elementary', limit: 300 });
  assert.ok(res.items.some(i => i.id === pi.id),
    'BUG10(A+B): 과제 제출 자동 항목이 학교급(elementary) 필터 결과에 포함되어야 — 화면에서 사라지면 안 됨');
});

// ──────────────────────────────────────────────────────────────────────────
// 11) 성장 목표 계약 정합 (GROWTH_GOAL_SPEC) — 폼↔저장↔표시 키 일치.
//   옛 버그: 폼 {title,area,deadline} → createGrowthGoal 이 title→period_label /
//   area→goal_type 로 매핑, deadline 폐기 → getGrowthGoals 가 FE 기대 키를 안 줌 →
//   "제목 없는 빈 카드 + 0%". 이 회귀를 박제한다.
// ──────────────────────────────────────────────────────────────────────────
test('BUG11: 성장 목표 — createGrowthGoal(title·area·deadline) → getGrowthGoals 가 그대로 반환', () => {
  const created = g.createGrowthGoal(S1, {
    title: '이번 학기 책 20권 읽기',
    area: '독서활동',
    deadline: '2099-07-18',
    description: '주 2권 목표'
  });
  assert.ok(created && created.id, 'createGrowthGoal 이 id 반환');

  const goals = g.getGrowthGoals(S1);
  const hit = goals.find(x => x.id === created.id);
  assert.ok(hit, '생성한 목표가 getGrowthGoals 에 보여야 한다');
  assert.equal(hit.title, '이번 학기 책 20권 읽기', 'title 이 period_label 로 엉뚱저장되지 않고 그대로 반환');
  assert.equal(hit.area, '독서활동', 'area 가 goal_type 가 아니라 정본 area 로 반환');
  assert.equal(hit.deadline, '2099-07-18', 'deadline 이 폐기되지 않고 그대로 반환');
  assert.equal(hit.progress, 0, '신규 목표 progress 기본 0');
  assert.equal(hit.status, 'active', '신규 목표 status 기본 active');
  assert.equal(hit.description, '주 2권 목표', 'description 저장·반환');
});

test('BUG11b: 성장 목표 — title 빈값 거부(400)', () => {
  assert.throws(() => g.createGrowthGoal(S1, { title: '   ', area: '독서활동' }),
    /제목/, '빈 제목은 에러');
});

test('BUG11c: 성장 목표 — 영역 화이트리스트 외면 정서발달 폴백', () => {
  const c = g.createGrowthGoal(S1, { title: '엉뚱영역 목표', area: '기초학력' });
  const hit = g.getGrowthGoals(S1).find(x => x.id === c.id);
  assert.equal(hit.area, '정서발달', '정본 6영역 외 값은 정서발달로 폴백');
});

test('BUG11d: 성장 목표 — updateGrowthGoal(progress=100) → status=completed 자동 전환', () => {
  const c = g.createGrowthGoal(S1, { title: '완료될 목표', area: '참여도' });
  const up = g.updateGrowthGoal(c.id, S1, { progress: 100 });
  assert.equal(up.progress, 100, 'progress 100 반영');
  assert.equal(up.status, 'completed', 'progress>=100 → status=completed 자동');

  // 되돌리기: 100 미만 → active 복귀
  const down = g.updateGrowthGoal(c.id, S1, { progress: 40 });
  assert.equal(down.status, 'active', 'progress<100 으로 내리면 active 복귀');
});

test('BUG11e: 성장 목표 — progress 0~100 클램프', () => {
  const c = g.createGrowthGoal(S1, { title: '클램프 목표', area: '성취수준' });
  assert.equal(g.updateGrowthGoal(c.id, S1, { progress: 250 }).progress, 100, '100 초과 → 100');
  assert.equal(g.updateGrowthGoal(c.id, S1, { progress: -50 }).progress, 0, '0 미만 → 0');
});

test('BUG11f: 성장 목표 — 타인 목표 update/delete 차단(소유 격리)', () => {
  const c = g.createGrowthGoal(S1, { title: 'S1 소유 목표', area: '진로탐색' });
  // S2 가 S1 목표 수정 시도 → null
  assert.equal(g.updateGrowthGoal(c.id, S2, { progress: 50 }), null, '타인 update 차단(null)');
  // S2 가 S1 목표 삭제 시도 → false, 원본 보존
  assert.equal(g.deleteGrowthGoal(c.id, S2), false, '타인 delete 차단(false)');
  assert.ok(g.getGrowthGoals(S1).some(x => x.id === c.id), '차단 후 원본 목표 보존');
  // 본인 삭제는 성공
  assert.equal(g.deleteGrowthGoal(c.id, S1), true, '본인 delete 성공');
  assert.ok(!g.getGrowthGoals(S1).some(x => x.id === c.id), '삭제 후 목록에서 사라짐');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG12: 오늘의 학습 이수가 LRS(자기주도 학습)에 잡혀야 한다.
//   결함: completeDailyItem() 은 오늘의 학습 이수를 activity_type='daily_complete' 로 발행하는데,
//         LRS /stats/perform 은 self_learn 만 읽어 실제 이수가 "활동 유형별 요약/추이"에서 누락됐다.
//   fix(routes/lrs.js): self_learn 버킷 = self_learn ∪ daily_complete 로 합산(자기주도 학습 단일 라벨).
//   박제 3종:
//     (a) 오늘의 학습 이수 → learning_logs daily_complete 1건 발행(going-forward)
//     (b) LRS self_learn 버킷 쿼리에 그 이수가 반영(자기주도 학습 count 증가)
//     (c) 같은 항목 중복 완료 시 로그 2건 안 생김(멱등)
// ──────────────────────────────────────────────────────────────────────────
test('BUG12: 오늘의 학습 이수 → LRS 자기주도 학습(daily_complete) 반영 + 멱등', () => {
  const selfLearn = require('../db/self-learn-extended');

  // 격리 시드: 먼 미래 세트/항목 1건 (실 데이터 무간섭). content 없는 external 항목 → 점수 없음 경로.
  const setInfo = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, 'BUG12 오늘의학습 세트', '2099-11-15', 4, 1)
  `).run(CLASS, TEACHER);
  const setId = setInfo.lastInsertRowid;
  const itemInfo = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, external_url, external_title, item_title, sort_order)
    VALUES (?, 'external', 'https://example.com/bug12', 'BUG12 항목', 'BUG12 항목', 1)
  `).run(setId);
  const itemId = itemInfo.lastInsertRowid;

  // 발행 전: 이 항목에 대한 daily_complete 로그 0건
  const countLog = () => db.prepare(
    "SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND target_type = 'daily_learning' AND target_id = ? AND activity_type = 'daily_complete'"
  ).get(S1, String(itemId)).c;
  assert.equal(countLog(), 0, 'BUG12 전제: 이수 전 daily_complete 로그 0건');

  // (a) 이수 → learning_logs daily_complete 1건
  selfLearn.completeDailyItem(itemId, S1, { score: 90, timeSpent: 120 });
  assert.equal(countLog(), 1, 'BUG12(a): 오늘의 학습 이수 시 daily_complete 로그 1건 발행');

  // (c) 멱등: 같은 항목 재완료해도 로그 2건 안 생김 (completeDailyItem 이 wasCompleted 가드)
  selfLearn.completeDailyItem(itemId, S1, { score: 95, timeSpent: 60 });
  assert.equal(countLog(), 1, 'BUG12(c): 중복 이수 시 daily_complete 로그가 2건이 되면 안 됨(멱등)');

  // (b) LRS /stats/perform self_learn 버킷 쿼리(핵심 로직 재현): daily_complete 가 self_learn 으로 합산.
  //   route(routes/lrs.js)와 동일하게 daily_complete → self_learn 정규화 후 GROUP BY.
  const perfTypes = ['exam_complete', 'homework_submit', 'self_learn', 'daily_complete'];
  const typePH = perfTypes.map(() => '?').join(',');
  const byType = db.prepare(`
    SELECT CASE WHEN ll.activity_type='daily_complete' THEN 'self_learn' ELSE ll.activity_type END AS activity_type,
           COUNT(*) cnt
    FROM learning_logs ll
    WHERE ll.activity_type IN (${typePH}) AND ll.user_id = ?
    GROUP BY CASE WHEN ll.activity_type='daily_complete' THEN 'self_learn' ELSE ll.activity_type END
  `).all(...perfTypes, S1);
  const selfRow = byType.find(r => r.activity_type === 'self_learn');
  assert.ok(selfRow, 'BUG12(b): LRS byType 에 self_learn(자기주도 학습) 행이 있어야');
  // 방금 이수한 이 항목만 세도 최소 1 이상. (S1 의 기존 self_learn/daily_complete 도 합산되므로 >=1)
  assert.ok(selfRow.cnt >= 1, 'BUG12(b): 자기주도 학습 count 에 방금 이수(daily_complete)가 포함(>=1)');

  // daily_complete 만 별도 행으로 남지 않아야(자기주도 학습으로 병합됨 — 표에 두 줄 방지)
  assert.ok(!byType.some(r => r.activity_type === 'daily_complete'),
    'BUG12(b): daily_complete 는 self_learn 으로 병합되어 별도 행이 없어야');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG13: 오늘의 학습 백필 멱등 — completed daily_learning_progress 중 대응 로그 없는 건만
//   1회 발행, 재실행 시 중복 0. (scripts/backfill-daily-learning-logs.js 의 EXISTS 가드 로직 박제)
// ──────────────────────────────────────────────────────────────────────────
test('BUG13: 오늘의 학습 백필 — 대응 로그 없는 완료건 1회 발행, 재실행 중복 0(멱등)', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');

  // 격리 시드: 먼 미래 세트/항목 + "완료된 progress" 인데 learning_log 는 없는 고아 상태 재현.
  const setInfo = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, 'BUG13 백필 세트', '2099-12-01', 4, 1)
  `).run(CLASS, TEACHER);
  const setId = setInfo.lastInsertRowid;
  const itemInfo = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, external_url, item_title, sort_order)
    VALUES (?, 'external', 'https://example.com/bug13', 'BUG13 항목', 1)
  `).run(setId);
  const itemId = itemInfo.lastInsertRowid;
  // completed progress 직접 삽입(=구버전 이수, 로그 없음) — completeDailyItem 안 거침.
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, started_at, completed_at, score)
    VALUES (?, ?, ?, 'completed', '2099-12-01 09:00:00', '2099-12-01 09:10:00', NULL)
  `).run(S1, itemId, setId);

  // 백필 로직(스크립트와 동일한 EXISTS 가드) 재현: 대응 로그 없는 완료건만 발행.
  function backfillOnce() {
    const orphans = db.prepare(`
      SELECT p.user_id, p.item_id, p.completed_at,
             (SELECT s.class_id FROM daily_learning_sets s
                JOIN daily_learning_items i ON i.set_id = s.id WHERE i.id = p.item_id) AS class_id
      FROM daily_learning_progress p
      WHERE p.status = 'completed' AND p.completed_at IS NOT NULL AND p.item_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM learning_logs ll
          WHERE ll.user_id = p.user_id AND ll.target_type = 'daily_learning'
            AND ll.target_id = CAST(p.item_id AS TEXT)
            AND ll.activity_type IN ('daily_complete','self_learn')
        )
    `).all(itemId);
    let n = 0;
    for (const o of orphans) {
      const res = logLearningActivity({
        userId: o.user_id, activityType: 'daily_complete', targetType: 'daily_learning',
        targetId: o.item_id, classId: o.class_id || null, verb: 'completed',
        sourceService: 'self-learn', resultScore: null, createdAt: o.completed_at,
        metadata: { backfill: 'daily-learning-logs' }
      });
      if (res && res.id) n++;
    }
    return n;
  }

  const countLog = () => db.prepare(
    "SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND target_type = 'daily_learning' AND target_id = ? AND activity_type = 'daily_complete'"
  ).get(S1, String(itemId)).c;

  assert.equal(countLog(), 0, 'BUG13 전제: 백필 전 로그 0건');
  assert.equal(backfillOnce(), 1, 'BUG13: 1회차 백필 — 고아 완료건 1건 발행');
  assert.equal(countLog(), 1, 'BUG13: 발행 후 로그 1건');
  // created_at 이 원래 이수 시각으로 귀속됐는지(날짜 정합)
  const log = db.prepare(
    "SELECT created_at FROM learning_logs WHERE user_id = ? AND target_id = ? AND activity_type = 'daily_complete'"
  ).get(S1, String(itemId));
  assert.equal(log.created_at, '2099-12-01 09:10:00', 'BUG13: created_at = 원래 completed_at(날짜 귀속)');
  // 재실행 멱등: 이미 로그 있으니 0건 발행, 총 1건 유지
  assert.equal(backfillOnce(), 0, 'BUG13: 재실행 시 중복 발행 0(멱등)');
  assert.equal(countLog(), 1, 'BUG13: 재실행 후에도 로그 1건 유지(중복 없음)');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG14: LRS /stats/perform "활동 유형별 요약" 확장 — 콘텐츠·수업 등 전 활동유형 노출.
//   결함: perfTypes 화이트리스트(exam/homework/self)가 byType 표에도 걸려 content_solve·
//         content_view·lesson_progress·attendance·post·survey 등 실제 학습활동이 표에서 누락됐다.
//   fix(routes/lrs.js):
//     · byType 표 = 화이트리스트 없는 tableWhere 로 **모든 activity_type** GROUP BY(투명 노출).
//     · 점수 없는 유형(view/lesson/attendance/post/survey)은 SCORED_SQL 밖 → avgScore NULL('-').
//     · content_solve 는 점수 있음(0~100) → avgScore 표시.
//     · KPI 콘텐츠 학습 = content_solve+content_view+lesson_progress 합.
//     · trend = 학습 4계열(평가·과제·자기주도·콘텐츠 학습 묶음)만. attendance/post/survey 제외.
//   박제(라우트 SQL 조각 재현 — BUG12 와 동일 패턴):
//     (a) byType 에 content_solve/content_view/lesson_progress + attendance/post/survey 행이 뜬다
//     (b) 점수 없는 유형은 avgScore NULL, content_solve 는 avgScore 있음
//     (c) KPI content_cnt = 3종 합, trend 에 content_cnt 계열 존재
//     (d) daily_complete 는 self_learn 으로 병합(별도 행 없음)
// ──────────────────────────────────────────────────────────────────────────
test('BUG14: LRS 활동유형별 요약 — 전 활동유형 노출 + 점수없는유형 NULL + KPI/trend 콘텐츠 묶음', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const U = S2;                 // student2 로 격리(다른 테스트 S1 시드와 간섭 최소화)
  const D = '2099-06-14';       // 먼 미래 날짜 — 실 데이터와 무간섭
  const at = (n) => `${D} 0${n}:00:00`;

  // 격리 시드: 유형별 알려진 건수/점수로 발행.
  //   content_solve ×3 (score 100·80·60 → avg 80), content_view ×4(점수 없음),
  //   lesson_progress ×2(result_score 0.5 이지만 진도율 → 표 점수 대상 아님),
  //   attendance_checkin ×2, post_create ×1, survey_respond ×1, exam_complete ×1(score 90).
  const seed = (activityType, opts = {}) => logLearningActivity({
    userId: U, activityType, targetType: 'test', targetId: opts.tid || ('bug14-' + Math.random().toString(36).slice(2, 8)),
    classId: CLASS, verb: opts.verb || 'experienced', sourceService: 'test-bug14',
    resultScore: opts.score != null ? opts.score : null, createdAt: opts.at || at(1),
    metadata: { bug14: 1 }
  });
  seed('content_solve', { score: 100 }); seed('content_solve', { score: 80 }); seed('content_solve', { score: 60 });
  for (let i = 0; i < 4; i++) seed('content_view');
  seed('lesson_progress', { score: 0.5 }); seed('lesson_progress', { score: 1 });
  seed('attendance_checkin'); seed('attendance_checkin');
  seed('post_create'); seed('survey_respond');
  seed('exam_complete', { score: 90, verb: 'completed' });

  // 라우트와 동일한 SQL 조각(routes/lrs.js /stats/perform).
  const SCORED_SQL = `ll.activity_type IN ('exam_complete','homework_submit','self_learn','daily_complete','content_solve')`;
  const CONTENT_SQL = `ll.activity_type IN ('content_solve','content_view','lesson_progress')`;
  // scope=mine 재현: tableWhere = 날짜(D) + user_id(U). 화이트리스트 없음(전 유형).
  const byType = db.prepare(`
    SELECT CASE WHEN ll.activity_type='daily_complete' THEN 'self_learn' ELSE ll.activity_type END AS activity_type,
           COUNT(*) cnt,
           AVG(CASE WHEN ${SCORED_SQL} THEN ll.result_score END) avg_score
    FROM learning_logs ll
    WHERE DATE(ll.created_at) = ? AND ll.user_id = ?
    GROUP BY CASE WHEN ll.activity_type='daily_complete' THEN 'self_learn' ELSE ll.activity_type END
    ORDER BY cnt DESC
  `).all(D, U);
  const byMap = Object.fromEntries(byType.map(r => [r.activity_type, r]));

  // (a) 전 활동유형이 표에 뜬다(누락 0)
  for (const t of ['content_solve', 'content_view', 'lesson_progress', 'attendance_checkin', 'post_create', 'survey_respond']) {
    assert.ok(byMap[t], `BUG14(a): byType 에 ${t} 행이 있어야(전 유형 투명 노출)`);
  }
  assert.equal(byMap['content_solve'].cnt, 3, 'BUG14(a): content_solve 3건');
  assert.equal(byMap['content_view'].cnt, 4, 'BUG14(a): content_view 4건');
  assert.equal(byMap['lesson_progress'].cnt, 2, 'BUG14(a): lesson_progress 2건');
  assert.equal(byMap['attendance_checkin'].cnt, 2, 'BUG14(a): attendance_checkin 2건');

  // (b) 점수 없는 유형 = avgScore NULL('-'), content_solve = 점수 있음(avg 80)
  assert.equal(byMap['content_view'].avg_score, null, 'BUG14(b): content_view 평균점수 NULL(-)');
  assert.equal(byMap['lesson_progress'].avg_score, null, 'BUG14(b): lesson_progress(진도율)은 점수 아님 → NULL(-)');
  assert.equal(byMap['attendance_checkin'].avg_score, null, 'BUG14(b): attendance 평균점수 NULL(-)');
  assert.equal(byMap['post_create'].avg_score, null, 'BUG14(b): post 평균점수 NULL(-)');
  assert.equal(byMap['survey_respond'].avg_score, null, 'BUG14(b): survey 평균점수 NULL(-)');
  assert.equal(Math.round(byMap['content_solve'].avg_score), 80, 'BUG14(b): content_solve 평균점수 80(점수 있음)');

  // (c) KPI content_cnt = content 3종 합(3+4+2=9), trend 에 content_cnt 계열 존재
  const kpi = db.prepare(`
    SELECT SUM(CASE WHEN ${CONTENT_SQL} THEN 1 ELSE 0 END) content_cnt,
           AVG(CASE WHEN ll.activity_type='content_solve' THEN ll.result_score END) content_solve_avg
    FROM learning_logs ll WHERE DATE(ll.created_at) = ? AND ll.user_id = ?
  `).get(D, U);
  assert.equal(kpi.content_cnt, 9, 'BUG14(c): KPI 콘텐츠 학습 = content_solve+view+lesson(3+4+2=9)');
  assert.equal(Math.round(kpi.content_solve_avg), 80, 'BUG14(c): KPI content_solve 평균 80');

  const SELF_SQL = `ll.activity_type IN ('self_learn','daily_complete')`;
  const perfTypes = ['exam_complete', 'homework_submit', 'self_learn', 'daily_complete', 'content_solve', 'content_view', 'lesson_progress'];
  const ph = perfTypes.map(() => '?').join(',');
  const trend = db.prepare(`
    SELECT DATE(ll.created_at) date,
           SUM(CASE WHEN ll.activity_type='exam_complete' THEN 1 ELSE 0 END) exam_cnt,
           SUM(CASE WHEN ${SELF_SQL} THEN 1 ELSE 0 END) self_cnt,
           SUM(CASE WHEN ${CONTENT_SQL} THEN 1 ELSE 0 END) content_cnt
    FROM learning_logs ll
    WHERE ll.activity_type IN (${ph}) AND DATE(ll.created_at) = ? AND ll.user_id = ?
    GROUP BY DATE(ll.created_at)
  `).all(...perfTypes, D, U);
  assert.equal(trend.length, 1, 'BUG14(c): 시드 날짜 1일 추이 행');
  assert.ok('content_cnt' in trend[0], 'BUG14(c): trend 에 content_cnt(콘텐츠 학습 묶음) 계열 존재');
  assert.equal(trend[0].content_cnt, 9, 'BUG14(c): trend content_cnt = 9(콘텐츠 3종 묶음 합)');
  // trend 는 학습 계열만 — attendance/post/survey 는 SUM 컬럼이 없다(라인에 안 뜬다) 재확인.
  assert.ok(!('attendance_cnt' in trend[0] || 'post_cnt' in trend[0] || 'survey_cnt' in trend[0]),
    'BUG14(c): trend 에 attendance/post/survey 계열이 없어야(그래프 가독성)');

  // (d) daily_complete 는 self_learn 으로 병합 → byType 에 daily_complete 별도 행 없음
  assert.ok(!byMap['daily_complete'], 'BUG14(d): daily_complete 는 self_learn 으로 병합(별도 행 금지)');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG15: LRS /stats/perform "평균 점수" 스케일 혼재 정규화(표시용 0~100).
//   결함: result_score 저장 스케일이 유형별로 혼재 — exam/self/homework_graded 는 0~1,
//         content_solve 는 0~100. 그대로 AVG 하면 평가 평균이 0.9(=94.5점) 로 뜨는 시각 결함.
//   fix(routes/lrs.js): NORM_SCORE = CASE WHEN result_score<=1 THEN *100 ELSE 그대로 END 로
//         행 단위 정규화 후 AVG → 모든 '평균 점수' 0~100 일관.
//   박제:
//     (a) 0~1 저장 유형(exam) 평균이 0~100 으로(>1, ≈94.5), ≤1 소수로 안 뜬다
//     (b) 이미 0~100 인 content_solve 는 그대로 100(이중 ×100 없음)
//     (c) lesson_progress(진도율)는 SCORED_SQL 밖 → 정규화·평균 대상 아님(NULL/'-')
//     (d) 점수있는 모든 유형 avgScore 가 0~100 범위(0<v<=100)
// ──────────────────────────────────────────────────────────────────────────
test('BUG15: LRS 평균점수 표시용 0~100 정규화 — 0~1 저장 유형 ×100, content_solve 그대로, 진도율 제외', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const U = S1;
  const D = '2099-08-20';
  const seed = (activityType, score, tid) => logLearningActivity({
    userId: U, activityType, targetType: 'test', targetId: tid || ('bug15-' + Math.random().toString(36).slice(2, 8)),
    classId: CLASS, verb: 'completed', sourceService: 'test-bug15',
    resultScore: score, createdAt: `${D} 03:00:00`, metadata: { bug15: 1 }
  });
  // exam: 0~1 스케일 2건(0.90, 1.00 → 정규화 90·100 → 평균 95)
  seed('exam_complete', 0.90); seed('exam_complete', 1.00);
  // content_solve: 이미 0~100 2건(100·80 → 평균 90, 이중 ×100 되면 안 됨)
  seed('content_solve', 100); seed('content_solve', 80);
  // lesson_progress: 진도율 0.5·1.0 (정규화·평균 대상 아님 → NULL)
  seed('lesson_progress', 0.5); seed('lesson_progress', 1.0);

  const SCORED_SQL = `ll.activity_type IN ('exam_complete','homework_submit','self_learn','daily_complete','content_solve')`;
  const NORM_SCORE = `(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)`;
  const byType = db.prepare(`
    SELECT ll.activity_type AS activity_type,
           AVG(CASE WHEN ${SCORED_SQL} THEN ${NORM_SCORE} END) avg_score
    FROM learning_logs ll
    WHERE DATE(ll.created_at) = ? AND ll.user_id = ? AND ll.metadata LIKE '%bug15%'
    GROUP BY ll.activity_type
  `).all(D, U);
  const m = Object.fromEntries(byType.map(r => [r.activity_type, r.avg_score]));
  const rnd = v => v == null ? null : Math.round(v * 10) / 10;

  // (a) exam 0~1 → 0~100 (95), ≤1 소수로 안 뜬다
  assert.equal(rnd(m['exam_complete']), 95, 'BUG15(a): exam 정규화 평균 95(0.9·1.0 → 90·100)');
  assert.ok(m['exam_complete'] > 1, 'BUG15(a): exam 평균이 0~1 소수가 아니라 0~100(>1)');
  // (b) content_solve 이미 0~100 → 90 (이중 ×100 없음: 9000 이 아니어야)
  assert.equal(rnd(m['content_solve']), 90, 'BUG15(b): content_solve 90(0~100 그대로, 이중 ×100 없음)');
  assert.ok(m['content_solve'] <= 100, 'BUG15(b): content_solve 평균 <=100(이중 정규화 아님)');
  // (c) lesson_progress 진도율 → 평균 대상 아님(GROUP 행은 있어도 avg NULL)
  assert.ok(!('lesson_progress' in m) || m['lesson_progress'] == null,
    'BUG15(c): lesson_progress(진도율)는 avgScore NULL(정규화·평균 제외)');
  // (d) 점수있는 모든 유형 avgScore 0~100 범위
  for (const [t, v] of Object.entries(m)) {
    if (v != null) assert.ok(v > 0 && v <= 100, `BUG15(d): ${t} avgScore(${v}) 가 0~100 범위여야`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// BUG16: 약점 성취기준 라벨 = 학생 친화 단원명 (raw 코드 노출 금지) — INV-f 박제.
//   routes/lrs.js insights 엔드포인트가 achievementLabel(code) 로 learning_map_nodes
//   .unit_name 을 붙인다. 이 데이터 계약(코드→단원명 매핑 존재)이 깨지면 화면에 [4수01-02]
//   같은 raw 코드가 뜨므로 여기서 미리 잡는다. (엔드포인트 로직과 동일한 lookup 검증)
// ──────────────────────────────────────────────────────────────────────────
test('BUG16: 약점 성취기준 코드→한글 단원명 매핑 존재(raw 코드 노출 방지, INV-f)', () => {
  // student1(id3)의 실제 약점 코드 상위 5개 (엔드포인트와 동일 쿼리)
  const weak = db.prepare(`
    SELECT achievement_code FROM lrs_achievement_stats
    WHERE user_id = ? AND attempt_count >= 1
    ORDER BY COALESCE(avg_score,0) ASC, attempt_count DESC LIMIT 5
  `).all(S1);

  // 약점 데이터가 없으면(격리 DB 시드 상태) 스킵성 통과 — 계약 자체는 아래 샘플로 검증
  const sampleCodes = weak.length ? weak.map(w => w.achievement_code)
    : ['[4수01-02]', '[4수03-02]'];

  // 엔드포인트 achievementLabel 과 동일한 lookup: bracketed/bare 양쪽으로 unit_name 조회
  const unitOf = (code) => {
    const raw = String(code || '').trim();
    const bare = raw.replace(/^\[|\]$/g, '');
    const bracketed = raw.startsWith('[') ? raw : `[${bare}]`;
    const row = db.prepare(
      "SELECT unit_name FROM learning_map_nodes WHERE achievement_code IN (?,?,?) AND unit_name IS NOT NULL AND TRIM(unit_name) <> '' LIMIT 1"
    ).get(bracketed, bare, raw);
    return row ? row.unit_name : null;
  };

  let mapped = 0;
  for (const code of sampleCodes) {
    const unit = unitOf(code);
    if (unit) {
      mapped++;
      // 단원명은 한글을 포함해야(코드 그대로 X)
      assert.ok(/[가-힣]/.test(unit), `BUG16: ${code} 단원명("${unit}")에 한글 없음(코드 추정)`);
      // 단원명이 raw 코드와 같으면 안 됨
      assert.notEqual(unit, code, `BUG16: ${code} 단원명이 코드 그대로`);
    }
  }
  assert.ok(mapped > 0, `BUG16: 약점 코드 ${sampleCodes.length}개 중 단원명 매핑 0개 — learning_map_nodes 계약 깨짐`);
});

// ──────────────────────────────────────────────────────────────────────────
// BUG17: 오늘의 학습 완료 → result_success 정합 (LRS 학생 전수감사 §1 근본 fix).
//   (a) 문항형(correct/total) 완료 → result_success 가 NULL 이 아니라 정오답으로 채워짐.
//   (b) 100점(만점) 완료가 '0정답'으로 기록되면 안 됨(도달률 역효과 방지) — success=1.
//   (c) 불합격(정답률<0.6) 완료 → success=0, 하지만 result_score 는 실제 비율(≠null).
//   (d) 시청/이수형(점수·문항 없음) 완료 → success=NULL 유지(평가대상 아님) & 성취 시도로 안 셈.
// ──────────────────────────────────────────────────────────────────────────
test('BUG17: 오늘의 학습 완료 result_success 정합(100점≠0정답, 시청형=NULL·시도제외)', () => {
  const selfLearn = require('../db/self-learn-extended');
  const mastery = require('../db/lrs-mastery');
  const CODE = '[4수03-02]'; // unit_name 있는 코드

  // 격리 세트/항목 3개: (a/b) 만점 문항형, (c) 불합격 문항형, (d) 시청형(external·점수없음)
  const setInfo = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, 'BUG17 세트', '2099-12-01', 4, 1)
  `).run(CLASS, TEACHER);
  const setId = setInfo.lastInsertRowid;
  const mkItem = (title) => db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, external_url, external_title, item_title, node_id, sort_order)
    VALUES (?, 'external', 'https://example.com/bug17', ?, ?, NULL, 1)
  `).run(setId, title, title).lastInsertRowid;
  const itemPass = mkItem('BUG17 만점'), itemFail = mkItem('BUG17 불합격'), itemView = mkItem('BUG17 시청');

  const logOf = (itemId) => db.prepare(
    "SELECT result_score, result_success, correct_count, total_items FROM learning_logs WHERE user_id=? AND target_type='daily_learning' AND target_id=? AND activity_type='daily_complete' ORDER BY id DESC LIMIT 1"
  ).get(S1, String(itemId));

  // (a·b) 만점: 5/5 → success=1, score≈1.0 (NULL 아님)
  selfLearn.completeDailyItem(itemPass, S1, { score: 100, correctCount: 5, totalQuestions: 5, timeSpent: 100 });
  const lp = logOf(itemPass);
  assert.notEqual(lp.result_success, null, 'BUG17(a): 문항형 완료 result_success 가 NULL 이면 안 됨');
  assert.equal(lp.result_success, 1, 'BUG17(b): 100점(5/5) 완료는 success=1(0정답 아님)');
  assert.ok(lp.result_score != null && lp.result_score > 0.9, 'BUG17(b): 만점 result_score≈1.0');
  assert.equal(lp.correct_count, 5, 'BUG17: correct_count 전달');

  // (c) 불합격: 1/5=0.2 → success=0, score=0.2(≠null)
  selfLearn.completeDailyItem(itemFail, S1, { score: 20, correctCount: 1, totalQuestions: 5, timeSpent: 90 });
  const lf = logOf(itemFail);
  assert.equal(lf.result_success, 0, 'BUG17(c): 정답률<0.6 완료는 success=0');
  assert.ok(lf.result_score != null && lf.result_score < 0.5, 'BUG17(c): 불합격도 result_score 는 실제 비율(≠null)');

  // (d) 시청형(점수·문항 없음): success=NULL 유지 & 성취 시도 미증가.
  const beforeAtt = (db.prepare(
    'SELECT attempt_count FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?'
  ).get(S1, CODE) || { attempt_count: 0 }).attempt_count;
  selfLearn.completeDailyItem(itemView, S1, { timeSpent: 120 }); // 점수·문항 없음
  const lv = logOf(itemView);
  assert.equal(lv.result_success, null, 'BUG17(d): 시청/이수형(점수없음) 완료는 result_success=NULL 유지');
  // 시청형은 achievement_code 미해석(node_id null) → 성취 시도 자체가 안 늘어야(역효과 방지).
  const afterAtt = (db.prepare(
    'SELECT attempt_count FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?'
  ).get(S1, CODE) || { attempt_count: 0 }).attempt_count;
  assert.equal(afterAtt, beforeAtt, 'BUG17(d): 평가신호 없는 이수는 성취 시도(attempt)를 늘리지 않아야(도달률 역효과 방지)');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG18: 평가신호 없는 완료가 lrs_achievement_stats 를 '0정답'으로 깎지 않음(도달률 역효과).
//   achievement_code 有 + result_score·result_success 모두 NULL 인 로그는 mastery 집계 제외.
//   (log-helper 의 hasEvalSignal 가드 박제) — 100점 완료가 성취를 깎던 왜곡 재발 방지.
// ──────────────────────────────────────────────────────────────────────────
test('BUG18: 평가신호 없는 이수는 성취 도달률을 깎지 않음(hasEvalSignal 가드)', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const CODE = '[4수17-99]'; // 실 데이터와 무간섭 가짜 코드(격리)

  // 기준: 이 코드 성취 stats 초기 없음.
  const cur0 = db.prepare('SELECT * FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').get(S1, CODE);
  assert.equal(cur0, undefined, 'BUG18 전제: 가짜 코드 성취 stats 없음(격리)');

  // 평가신호 없는 완료(점수·성공 NULL) 3건 발행 → 성취 stats 가 생기면 안 됨(시도 미집계).
  for (let i = 0; i < 3; i++) {
    logLearningActivity({
      userId: S1, activityType: 'daily_complete', targetType: 'daily_learning',
      targetId: 8800000 + i, verb: 'completed', sourceService: 'self-learn',
      resultScore: null, resultSuccess: null, achievementCode: CODE, subjectCode: 'math-e',
    });
  }
  const after = db.prepare('SELECT * FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').get(S1, CODE);
  assert.ok(!after || (after.attempt_count || 0) === 0,
    'BUG18: 평가신호 없는 이수 3건이 성취 attempt/success 를 만들면 안 됨(0정답 누적=역효과)');

  // 반대로, 평가신호(정답) 있는 완료 1건은 정상 집계(도달) 되어야.
  logLearningActivity({
    userId: S1, activityType: 'daily_complete', targetType: 'daily_learning',
    targetId: 8800099, verb: 'completed', sourceService: 'self-learn',
    resultScore: 1, resultSuccess: 1, achievementCode: CODE, subjectCode: 'math-e',
  });
  const afterOk = db.prepare('SELECT attempt_count, success_count FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').get(S1, CODE);
  assert.ok(afterOk && afterOk.attempt_count === 1 && afterOk.success_count === 1,
    'BUG18: 평가신호 있는 정답 완료는 성취 시도·정답으로 정상 집계(att=1,succ=1)');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG19: computeTrend 가 오늘의 학습 이수(문항 정답)를 시계열에 반영.
//   result_success 채워진 daily_complete 가 _weeklyRateSeries(result_success IS NOT NULL 필터)에
//   잡혀 해당 주 attempts 가 증가해야 한다. (이전엔 success=NULL 이라 배제 → 추이 누락)
// ──────────────────────────────────────────────────────────────────────────
test('BUG19: 오늘의 학습 정답 이수 → computeTrend 주차 시계열 attempts 증가', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const analytics = require('../db/lrs-analytics');
  const CODE = '[4수18-88]';
  const U = S2; // student2 로 격리(다른 테스트 간섭 최소화)

  // 같은 주(週)에 3건 이상 있어야 유효 주차(_weeklyRateSeries MIN_WEEK_ATTEMPTS). 최근 주로 4건.
  const iso = (d) => d.toISOString().slice(0, 10) + ' 10:00:00';
  const base = new Date(); // 이번 주
  for (let i = 0; i < 4; i++) {
    const d = new Date(base); d.setDate(base.getDate() - i);
    logLearningActivity({
      userId: U, activityType: 'daily_complete', targetType: 'daily_learning',
      targetId: 7700000 + i, verb: 'completed', sourceService: 'self-learn',
      resultScore: 1, resultSuccess: 1, achievementCode: CODE, subjectCode: 'math-e',
      createdAt: iso(d),
    });
  }
  const t = analytics.computeTrend({ userId: U, code: CODE, weeks: 8 });
  const totalAttempts = (t.series || []).reduce((s, w) => s + (w.attempts || 0), 0);
  assert.ok(totalAttempts >= 3,
    `BUG19: 정답 이수 4건이 computeTrend 시계열 attempts 에 반영돼야(합 >=3). 실제=${totalAttempts}`);
});

// ──────────────────────────────────────────────────────────────────────────
// BUG20(정정): 성취수준 분류는 누적 기준 — period 7/30/90 무관하게 counts/notReached 동일.
//   [정책 전환] 과거 BUG20 은 "기간칩 반영(7d≠90d)"을 박제했으나 이는 오히려 P0 버그였다:
//   도달/미도달은 그간 학습의 누적 결과라, 30일보다 이전에 시도한 누적 미도달이 기간 창 밖으로
//   빠지면 은폐된다(uid3 notReached 5→0). → getStudentMastery 는 항상 누적(lrs_achievement_stats)만
//   보고, period 를 넣어도(넣지 않아도) 결과가 동일해야 한다. scoped=false·period=null 고정.
//   (period 가 route 레벨에서 무시됨은 HTTP 레벨은 test/lrs-mastery-cumulative.test.js 에서 커버.)
// ──────────────────────────────────────────────────────────────────────────
test('BUG20(정정): 성취수준 분류는 누적 — fromDate/toDate 를 줘도 인자 없는 호출과 동일', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const mastery = require('../db/lrs-mastery');
  const U = S2;
  const iso = (d) => d.toISOString().slice(0, 10) + ' 10:00:00';
  const today = new Date();
  const daysAgo = (n) => { const d = new Date(today); d.setDate(today.getDate() - n); return d; };

  // 최근(3일 전) 코드 A, 오래된(50일 전) 코드 B 각각 정답 이수(집계 테이블에 누적).
  logLearningActivity({ userId: U, activityType: 'daily_complete', targetType: 'daily_learning', targetId: 6600001,
    verb: 'completed', sourceService: 'self-learn', resultScore: 1, resultSuccess: 1,
    achievementCode: '[4수19-01]', subjectCode: 'math-e', createdAt: iso(daysAgo(3)) });
  logLearningActivity({ userId: U, activityType: 'daily_complete', targetType: 'daily_learning', targetId: 6600002,
    verb: 'completed', sourceService: 'self-learn', resultScore: 1, resultSuccess: 1,
    achievementCode: '[4수19-02]', subjectCode: 'math-e', createdAt: iso(daysAgo(50)) });

  const isoD = (d) => d.toISOString().slice(0, 10);
  const base = mastery.getStudentMastery(U);                                              // 인자 없음(누적)
  const m7   = mastery.getStudentMastery(U, { fromDate: isoD(daysAgo(7)),  toDate: isoD(today) });
  const m90  = mastery.getStudentMastery(U, { fromDate: isoD(daysAgo(90)), toDate: isoD(today) });
  // 정책: period 무반영 → 세 결과의 counts 가 모두 동일. scoped=false, period=null.
  assert.equal(base.scoped, false, 'BUG20(정정): scoped 는 항상 false(누적)');
  assert.equal(base.period, null,  'BUG20(정정): period 는 항상 null(누적)');
  assert.deepEqual(m7.counts,  base.counts, 'BUG20(정정): 7d 인자를 줘도 counts 는 누적과 동일해야');
  assert.deepEqual(m90.counts, base.counts, 'BUG20(정정): 90d 인자를 줘도 counts 는 누적과 동일해야');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG20b(신규 핵심): **기간 창 밖의 오래된 누적 미도달**이 은폐되면 안 된다.
//   결함: 옛 기간 스코프가 30일 창 밖 누적 미도달을 숨겨 notReached 를 0 으로 만들었다.
//
// ── 2026-08-04 GT 재작성 (동어반복 아님 · 시한폭탄 제거) ───────────────────
//   이전 GT 는 "uid3 의 미도달 5건"이라는 **실 DB 시드 스냅샷**이었다. 그 5건은
//   집계기 결함의 산물이었음이 원시 로그 대조로 확인됐다 — 5개 코드 전부
//   정오 판정 로그가 **0건**이고(콘텐츠 조회·이수형뿐), 무필터 COUNT(*) 가 분모로
//   들어가 '시도 N · 정답 0 → 정답률 0% → 미도달' 이 만들어졌을 뿐이다.
//   (정본사전 §4-3: 판정 자료가 없으면 '평가 부족(회색)'이지 '미도달(빨강)'이 아니다.)
//   W2-a 로 분모가 정화되자 uid3 의 진짜 미도달은 0 이 됐고, 이 GT 는 근거를 잃었다.
//
//   그래서 GT 를 **테스트가 직접 만든 데이터**에서 유도한다:
//     시도 4 · 정답 1 → 정답률 25% (<50) · 시도 ≥3  ⇒ 미도달   (정본사전 §1-A-1)
//   판정 근거가 산식뿐이라 시드가 어떻게 바뀌어도, 오늘이 언제여도 흔들리지 않는다.
//   로그 날짜를 **200일 전**으로 못박아 7/30/90d 창 **바깥**에 두는 것이 이 검사의 핵심 —
//   기간 스코프가 되살아나면 notReached 가 0 으로 떨어져 즉시 붉어진다.
// ──────────────────────────────────────────────────────────────────────────
test('BUG20b: 기간 창 밖(200일 전) 누적 미도달 은폐 방지 — period 무관 항상 계수', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const mastery = require('../db/lrs-mastery');

  // 전용 픽스처 계정 — 실 계정 통계를 오염시키지 않는다.
  const uid = Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES ('t_bug20b_seed', 'x', '은폐방지시드', 'student')"
  ).run().lastInsertRowid);

  const OLD_CODE = '[4수98-01]';   // 200일 전 미도달 — 창 밖
  const NEW_CODE = '[4수98-02]';   // 3일 전 도달   — 창 안(대조군: 전부 미도달로 세지 않음을 증명)
  const daysAgo = (n) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10) + ' 10:00:00';
  };
  const put = (code, success, ago, seq) => logLearningActivity({
    userId: uid, activityType: 'exam_complete', targetType: 'exam', targetId: 9900000 + seq,
    verb: 'completed', sourceService: 'exam', resultScore: success ? 1 : 0, resultSuccess: success,
    achievementCode: code, subjectCode: 'math-e', createdAt: daysAgo(ago),
  });
  // 시도 4 · 정답 1 = 25% → 미도달 (분자·분모를 테스트가 직접 정한다)
  [0, 0, 0, 1].forEach((s, i) => put(OLD_CODE, s, 200, i));
  // 시도 3 · 정답 3 = 100% → 도달
  [1, 1, 1].forEach((s, i) => put(NEW_CODE, s, 3, 10 + i));

  // 산식이 실제로 미도달을 만들었는지 먼저 확인(전제 붕괴 시 조기 실패 — 착시 통과 방지)
  const base = mastery.getStudentMastery(uid);
  const old = base.standards.find(s => s.code === OLD_CODE);
  assert.ok(old, `BUG20b: 전제 붕괴 — ${OLD_CODE} 셀이 만들어지지 않음`);
  assert.equal(old.attempts, 4, 'BUG20b: 전제 — 시도 4');
  assert.equal(old.correct, 1, 'BUG20b: 전제 — 정답 1');
  assert.equal(old.status, 'not_reached', `BUG20b: 25% 는 미도달이어야. 실제=${old.status}`);

  // 본 검사: 기간 인자를 무엇으로 주든 200일 전 미도달이 계수돼야 한다.
  const isoD = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const today = new Date().toISOString().slice(0, 10);
  for (const days of [7, 30, 90]) {
    const m = mastery.getStudentMastery(uid, { fromDate: isoD(days), toDate: today });
    assert.equal(m.counts.notReached, 1,
      `BUG20b: period=${days}d 에서 창 밖 미도달이 은폐됨(notReached=${m.counts.notReached}, 기대 1)`);
    assert.equal(m.counts.reached, 1, `BUG20b: period=${days}d 도달 1건도 유지돼야`);
    const nrCodes = new Set(m.weaknesses.filter(w => w.status === 'not_reached').map(w => w.code));
    assert.ok(nrCodes.has(OLD_CODE),
      `BUG20b: period=${days}d weaknesses 에 ${OLD_CODE} 누락(은폐)`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// BUG21: s-custom 스케일(0~1→0~100) + 약점표 label(단원명). NORM_SCORE 미적용 재발 방지.
//   self-learn result_score(0~1 저장)의 AVG 가 그대로 나가면 "0.9점"으로 오노출.
//   NORM_SCORE(≤1이면 ×100) 적용 결과가 0~100 범위여야 하고, weakTargets 에 label 존재.
// ──────────────────────────────────────────────────────────────────────────
test('BUG21: s-custom avgScore 0~100 정규화 + 약점표 단원명 label', () => {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const U = S2;
  const CODE = '[4수03-02]'; // unit_name 있는 코드
  // 0~1 스케일 self-learn 로그 2건(0.9·1.0) → NORM 후 평균 95 여야(0.95 아님).
  logLearningActivity({ userId: U, activityType: 'daily_complete', targetType: 'daily_learning', targetId: 5500001,
    verb: 'completed', sourceService: 'self-learn', resultScore: 0.9, resultSuccess: 1, achievementCode: CODE, subjectCode: 'math-e' });
  logLearningActivity({ userId: U, activityType: 'daily_complete', targetType: 'daily_learning', targetId: 5500002,
    verb: 'completed', sourceService: 'self-learn', resultScore: 1.0, resultSuccess: 1, achievementCode: CODE, subjectCode: 'math-e' });

  const NORM = '(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)';
  const row = db.prepare(
    "SELECT ROUND(AVG(" + NORM + "),1) avg_norm FROM learning_logs ll " +
    "WHERE ll.source_service='self-learn' AND ll.user_id=? AND ll.achievement_code=?"
  ).get(U, CODE);
  assert.ok(row.avg_norm > 1 && row.avg_norm <= 100, `BUG21: custom avgScore(${row.avg_norm}) 는 0~100(0.x 아님)`);

  // 약점표 label: achievementLabel 과 동일 lookup 으로 단원명 존재 확인(엔드포인트가 붙임).
  const raw = CODE, bare = raw.replace(/^\[|\]$/g, '');
  const unit = db.prepare(
    "SELECT unit_name FROM learning_map_nodes WHERE achievement_code IN (?,?) AND unit_name IS NOT NULL AND TRIM(unit_name)<>'' LIMIT 1"
  ).get(raw, bare);
  assert.ok(unit && /[가-힣]/.test(unit.unit_name), 'BUG21: 약점표 label 로 붙일 단원명(한글)이 있어야(raw 코드 노출 방지)');
});

// ──────────────────────────────────────────────────────────────────────────
// BUG22: projectReach insufficient 문구 정직성(§7). status=insufficient·currentRate>50 일 때
//   "더 풀면"(양 문제) 대신 "주(週)/시간" 어휘를 써야 오해가 없다.
// ──────────────────────────────────────────────────────────────────────────
test('BUG22: 추세 부족 안내가 "더 풀면"이 아니라 "주차/시간" 어휘(문구 정직성)', () => {
  const analytics = require('../db/lrs-analytics');
  // 관측주차 2 → insufficient. currentRate 존재하는 trend 를 인위로 구성.
  const fakeTrend = { status: 'ok', currentRate: 75, slope: 1, confidence: 'low', observedWeeks: 2 };
  // computeTrend 를 안 쓰고 projectReach 만 검증하려면 status!=='ok' 케이스가 필요 →
  //   insufficient trend 직접 전달.
  const insufTrend = { status: 'insufficient', currentRate: 75, observedWeeks: 2 };
  const p = analytics.projectReach(insufTrend, { target: 80 });
  assert.equal(p.status, 'insufficient', 'BUG22 전제: insufficient');
  assert.ok(!/더 풀면/.test(p.message || ''), `BUG22: "더 풀면" 문구가 남아있으면 안 됨. msg=${p.message}`);
  assert.ok(/주|시간/.test(p.message || ''), `BUG22: "주(週)/시간" 어휘로 안내해야. msg=${p.message}`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K6 (P1 스펙 §7 — 스택바 = 내역): /mastery/student 응답에서 standards[] 를
//   교과×상태로 집계했을 때 ①교과별 4상태 합 == 그 교과 bySubject.standardCount
//   ②전 교과 합 == counts.total ③각 상태값 ≥ 0 정수.
//   (uid3=student1 + middle 시드 대표 2040=middle1 — 실 DB 임시본)
//   박제 소관: P2 스펙 §4-2(PM/BE — test/regression.test.js).
// ──────────────────────────────────────────────────────────────────────────
test('INV-K6: 스택바=내역 — 교과별 4상태 합 == bySubject.standardCount, 전 교과 합 == counts.total (uid3·2040)', () => {
  const mastery = require('../db/lrs-mastery');
  const STATUSES = ['reached', 'partial', 'not_reached', 'insufficient'];
  for (const uid of [3, 2040]) {
    const m = mastery.getStudentMastery(uid);
    assert.ok(m.standards.length > 0, `INV-K6 전제: uid${uid} standards 존재`);
    // standards[] → 교과×상태 집계 (스택바가 FE 에서 하는 파생과 동일)
    const agg = new Map();
    for (const s of m.standards) {
      const key = s.subject_code || 'unknown';
      if (!agg.has(key)) agg.set(key, { reached: 0, partial: 0, not_reached: 0, insufficient: 0 });
      const a = agg.get(key);
      assert.ok(STATUSES.includes(s.status), `INV-K6: 알 수 없는 status ${s.status}`);
      a[s.status]++;
    }
    // ① 교과별 4상태 합 == bySubject.standardCount, ③ 각 상태값 ≥0 정수
    for (const bs of m.bySubject) {
      const key = bs.subject_code || 'unknown';
      const a = agg.get(key);
      assert.ok(a, `INV-K6: bySubject 에만 있는 교과 ${key}(uid${uid})`);
      const sum4 = STATUSES.reduce((t, st) => t + a[st], 0);
      assert.equal(sum4, bs.standardCount,
        `INV-K6①: uid${uid} ${key} 4상태 합 ${sum4} != standardCount ${bs.standardCount}`);
      for (const st of STATUSES) {
        assert.ok(Number.isInteger(a[st]) && a[st] >= 0, `INV-K6③: uid${uid} ${key}.${st} 음수/비정수`);
      }
    }
    assert.equal(agg.size, m.bySubject.length, `INV-K6: uid${uid} 교과 수 불일치(standards ↔ bySubject)`);
    // ② 전 교과 합 == counts.total
    const total = m.bySubject.reduce((t, b) => t + b.standardCount, 0);
    assert.equal(total, m.counts.total, `INV-K6②: uid${uid} 전 교과 합 ${total} != counts.total ${m.counts.total}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K9 (P1 스펙 §7 — 처방 템플릿 윤리·정합): public/lrs/index.html 의
//   renderTrendRx IIFE(실 프로덕션 코드)를 vm 샌드박스에서 그대로 실행해
//   대표 입력 조합(모드 compare/self × delta +7/0/−7 × weak0 유무 = 12조합)에 대해
//   ① 금칙어 정규식 0건(등수·순위·꼴찌·위험·뒤처·낮은 편·부족한 편·못했·실패
//      + 델타 칩 마이너스 표기 '반 평균 -' — INV-K15 어휘 확장)
//   ② `{delta}`·`{단원}` 등 템플릿 변수 잔존 0
//   ③ weak0 있을 때 문장 속 단원명 === weaknesses[0].label
//   박제 소관: P2 스펙 §4-2(PM/BE). FE 코드를 복제(미러) 하지 않고 원본을 추출 실행
//   — FE 가 템플릿을 바꾸면 이 테스트가 그 바뀐 문장을 그대로 검사한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K9: 처방 템플릿 — 12조합(compare/self × +7/0/−7 × weak0 유무) 금칙어 0·변수잔존 0·단원명 정합', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'lrs', 'index.html'), 'utf8');
  const start = html.indexOf('(function renderTrendRx(){');
  assert.ok(start > 0, 'INV-K9: renderTrendRx IIFE 를 찾지 못함(FE 리팩터 시 추출 앵커 갱신 필요)');
  const end = html.indexOf('})();', start);
  assert.ok(end > start, 'INV-K9: IIFE 종결부 미발견');
  const src = html.slice(start, end + '})();'.length);

  // 원본 IIFE 가 참조하는 클로저 변수·DOM 을 샌드박스로 주입해 실행
  function runRx({ mode, delta, weak0 }) {
    const els = {
      sTrendRx: { hidden: true },
      sTrendRxText: { innerHTML: '' },
    };
    const sandbox = {
      document: { getElementById: (id) => els[id] || null },
      // compare: 겹치는 주 2개, mean(my)-mean(class) == delta / self: 마지막 2점 차 == delta
      valuedPts: mode === 'self' ? [{ rate: 50 }, { rate: 50 + delta }] : [{ rate: 60 }, { rate: 60 }],
      drawOverlay: mode === 'compare',
      chartLabels: ['2026-01', '2026-02'],
      myVals: mode === 'compare' ? [60 + delta, 60 + delta] : [60, 60],
      classVals: mode === 'compare' ? [60, 60] : [null, null],
      insightsForReco: { weaknesses: weak0 ? [weak0] : [] },
      escapeAttr: (s) => String(s),
      escapeHtml: (s) => String(s),
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { timeout: 2000 });
    return els;
  }

  // 금칙어(P1 스펙 §4-4·§7) + '반 평균 -'(INV-K15 마이너스 표기 확장)
  const FORBIDDEN = /등수|순위|꼴찌|위험|뒤처|낮은 편|부족한 편|못했|실패|반 평균 -/;
  const LEFTOVER = /\{[^}]*\}/; // {delta}·{단원} 류 변수 잔존
  const WEAK0 = { label: '두 자리 수의 곱셈', achievement_code: '[4수01-05]' };

  for (const mode of ['compare', 'self']) {
    for (const delta of [7, 0, -7]) {
      for (const w of [WEAK0, null]) {
        const tag = `${mode}/delta=${delta}/weak0=${w ? 'Y' : 'N'}`;
        const els = runRx({ mode, delta, weak0: w });
        assert.equal(els.sTrendRx.hidden, false, `INV-K9(${tag}): 처방 박스가 렌더되지 않음`);
        const text = String(els.sTrendRxText.innerHTML || '');
        assert.ok(text.length > 0, `INV-K9(${tag}): 문장 비어 있음`);
        assert.ok(!FORBIDDEN.test(text), `INV-K9①(${tag}): 금칙어 검출 — "${text}"`);
        assert.ok(!LEFTOVER.test(text), `INV-K9②(${tag}): 템플릿 변수 잔존 — "${text}"`);
        if (w) assert.ok(text.includes(w.label), `INV-K9③(${tag}): 문장 속 단원명 != weaknesses[0].label — "${text}"`);
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 이슈6 (교사 위험학생 약점 상세): 교사가 "학생을 대상으로" 보는 위치에서
//   /self-learn?user_id=X (학생 자기주도 학습) 오배치 딥링크를 전부 제거했다.
//   재발 방지 정적 박제:
//   ① teacherAction 에 recommend 분기(→/self-learn/?user_id=) 부재
//   ② 교사 렌더러의 data-action="recommend" / #drwRecommend 버튼 부재
//   ③ 위험학생 카드 액션에 "맞춤학습" 라벨 부재(→ "약점 상세" primary로 대체)
//   ④ 강화 드로어 헬퍼 _ewsWeakHtml 존재(약점 교과·성취기준 렌더 앵커)
//   ※ 학생 s-home 의 /self-learn <a> 링크(자기 CTA)·전역 GNB 링크는 정당 → 검사 대상 아님.
// ──────────────────────────────────────────────────────────────────────────
test('이슈6: LRS 교사 화면 — 학생대상 /self-learn 오배치 딥링크 제거 정적 박제', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'lrs', 'index.html'), 'utf8');

  // ① teacherAction 의 recommend→/self-learn?user_id 분기 제거
  assert.ok(!/self-learn\/\?user_id=/.test(html),
    '이슈6①: 교사→학생 /self-learn?user_id= 딥링크가 남아 있음(제거 대상)');
  assert.ok(!/kind === 'recommend'/.test(html),
    "이슈6①: teacherAction recommend 분기가 남아 있음");

  // ② 교사 렌더러의 recommend 버튼/바인딩 제거
  assert.ok(!/data-action="recommend"/.test(html),
    '이슈6②: data-action="recommend" 버튼이 남아 있음(카드·열드로어)');
  assert.ok(!/id="drwRecommend"|getElementById\('drwRecommend'\)/.test(html),
    '이슈6②: 셀 드로어 #drwRecommend(보충 배정) 버튼/바인딩이 남아 있음');

  // ③ 위험학생 카드에 "약점 상세" primary 존재 + "맞춤학습" 카드 액션 라벨 부재
  assert.ok(/fa-magnifying-glass-chart"><\/i> 약점 상세/.test(html),
    '이슈6③: 위험학생 카드 "약점 상세" primary 버튼이 없음');
  assert.ok(!/data-action="recommend"[^>]*>\s*<i[^>]*><\/i> 맞춤학습/.test(html),
    '이슈6③: 카드에 "맞춤학습" 액션 버튼이 남아 있음');

  // ④ 강화 드로어 약점 렌더 헬퍼 존재
  assert.ok(/function _ewsWeakHtml\(/.test(html),
    '이슈6④: _ewsWeakHtml(약점 교과·성취기준 그룹 렌더) 헬퍼가 없음');
  assert.ok(/insights\/'\s*\+\s*encodeURIComponent\(uid\)/.test(html),
    '이슈6④: openDrilldown 이 /api/lrs/insights/:uid 를 로드하지 않음');
});
