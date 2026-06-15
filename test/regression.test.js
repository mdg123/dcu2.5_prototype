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
// 4) 오늘학습 날짜 귀속: getClassDailyLearning 에서 완료기록이 set.target_date 가 아니라
//    실제 DATE(completed_at) 셀에 귀속되어야 한다.
//    검증: target_date 와 다른 날짜에 완료한 기록을 만들고, completed_at 일자 셀이 participated 여야.
// ──────────────────────────────────────────────────────────────────────────
test('BUG4: 오늘학습 완료기록은 DATE(completed_at) 셀에 귀속', () => {
  const targetDate = '2099-06-10';   // 세트 배정일
  const completedDate = '2099-06-12'; // 실제 완료일 (다름)
  const win = { startDate: '2099-06-01', endDate: '2099-06-30' };

  // class 1 전용 세트 1개 + 항목 1개
  const setId = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, '회귀-날짜귀속세트', ?, 4, 1)
  `).run(CLASS, TEACHER, targetDate).lastInsertRowid;
  const itemId = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, item_title, sort_order)
    VALUES (?, 'content', '회귀항목', 1)
  `).run(setId).lastInsertRowid;
  // student1 이 6/12 에 완료 (target_date=6/10 과 다름)
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, completed_at, correct_count, total_questions, score)
    VALUES (?, ?, ?, 'completed', ?, 1, 1, 100)
  `).run(S1, itemId, setId, completedDate + ' 09:30:00');

  const cd = g.getClassDailyLearning(CLASS, win);
  const stu = cd.students.find(s => s.id === S1);
  assert.ok(stu, 'student1 이 매트릭스에 있어야');
  assert.equal(
    stu.daily[completedDate] && stu.daily[completedDate].participated, true,
    'completed_at(6/12) 셀이 participated 여야 한다'
  );
  assert.equal(
    !!(stu.daily[targetDate] && stu.daily[targetDate].participated), false,
    'target_date(6/10) 셀에는 완료가 귀속되면 안 된다(off-by-month 버그 방어)'
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
