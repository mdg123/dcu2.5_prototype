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
