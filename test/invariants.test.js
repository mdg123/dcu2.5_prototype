// test/invariants.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 부류 불변식 6종 — 개별 버그가 아니라 "버그 부류"를 광범위 차단하는 규칙.
// 여러 계정(student1·2)·여러 기간으로 반복 검증한다.
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require 전에 DB_PATH 주입. (읽기만 — 시드 불필요)
//   ⚠️ 결정론: 특정 수치 하드코딩 대신 "구조·범위·관계" 단언 위주 → 시드가 바뀌어도 안 깨진다.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./_setup');

setupTestDb();
const g = require('../db/growth-extended');

const S1 = 3, S2 = 4, CLASS = 1, TEACHER = 2;

// 여러 기간 매트릭스 (전기간 + 두 개의 명시 기간)
const RANGES = [
  { label: '전기간', opts: {} },
  { label: '2026-06', opts: { startDate: '2026-06-01', endDate: '2026-06-30' } },
  { label: '2026상반기', opts: { startDate: '2026-01-01', endDate: '2026-06-30' } }
];
const STUDENTS = [S1, S2];

// 비율/점수 의미를 가진 키 패턴 (0~100 이어야 함). count/denom/numer/total 등은 제외.
const PCT_KEY = /(rate|score|percent|ratio|accuracy|completion)/i;
// 0~100 강제 대상에서 빼야 하는 키 (rate/score 를 포함하지만 0~100 아닌 식별자·메타)
const PCT_EXCLUDE = /(id$|_id$|maxstreak|streak|count|holders|weightedcount)/i;

function walkNumbers(node, cb, pathStr = '') {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkNumbers(v, cb, `${pathStr}[${i}]`));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = pathStr ? `${pathStr}.${k}` : k;
      if (typeof v === 'number') cb(k, v, p);
      else walkNumbers(v, cb, p);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// INV1: 모든 비율/점수 필드 ∈ [0,100] (NaN·Infinity·>100·<0 이면 실패)
//   ← avg_score 8000% 부류 차단.
// ──────────────────────────────────────────────────────────────────────────
test('INV1: 모든 rate/score/percent/ratio/accuracy/completion 필드는 0~100', () => {
  const checkPayload = (payload, ctx) => {
    walkNumbers(payload, (key, val, path) => {
      if (!PCT_KEY.test(key)) return;
      if (PCT_EXCLUDE.test(key)) return;
      assert.ok(Number.isFinite(val), `${ctx} ${path}=${val} 는 유한수여야(NaN/Infinity 금지)`);
      assert.ok(val >= 0 && val <= 100, `${ctx} ${path}=${val} 는 0~100 범위여야`);
    });
  };
  for (const sid of STUDENTS) {
    for (const r of RANGES) {
      checkPayload(g.getStudentReport(sid, r.opts), `getStudentReport(${sid},${r.label})`);
    }
  }
  for (const r of RANGES) {
    checkPayload(g.getClassDashboard(CLASS, TEACHER, r.opts), `getClassDashboard(${CLASS},${r.label})`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV2: 응답 구조/타입 계약 — getStudentReport 필수키 존재 + participation 4지표가
//       {rate,denom,numer} 객체. ← [object Object] 부류 차단.
// ──────────────────────────────────────────────────────────────────────────
test('INV2: getStudentReport 구조 계약 (6축 areas·participation 객체·overallScore)', () => {
  const AREA_NAMES = ['정서발달', '참여도', '성취수준', '진로탐색', '독서활동', '콘텐츠활용'];
  for (const sid of STUDENTS) {
    for (const r of RANGES) {
      const rep = g.getStudentReport(sid, r.opts);
      const ctx = `(${sid},${r.label})`;
      // 필수 최상위 키
      for (const k of ['areas', 'overallScore', 'recentEmotions']) {
        assert.ok(Object.prototype.hasOwnProperty.call(rep, k), `${ctx} 필수키 ${k} 없음`);
      }
      assert.equal(typeof rep.overallScore, 'number', `${ctx} overallScore 숫자`);
      assert.ok(Array.isArray(rep.recentEmotions), `${ctx} recentEmotions 배열`);
      // 6축 존재 + 각 축 {score,hasData}
      for (const name of AREA_NAMES) {
        const a = rep.areas[name];
        assert.ok(a && typeof a === 'object', `${ctx} areas.${name} 객체 없음`);
        assert.equal(typeof a.score, 'number', `${ctx} areas.${name}.score 숫자`);
        assert.equal(typeof a.hasData, 'boolean', `${ctx} areas.${name}.hasData 불리언`);
      }
      // 참여도 4지표 = {rate,denom,numer} 객체 (문자열/[object Object] 금지)
      const p = rep.areas['참여도'].participation;
      assert.ok(p && typeof p === 'object', `${ctx} participation 객체`);
      for (const key of ['homework', 'exam', 'daily', 'lesson']) {
        const m = p[key];
        assert.ok(m && typeof m === 'object', `${ctx} participation.${key} 객체`);
        assert.ok(m.rate === null || typeof m.rate === 'number', `${ctx} participation.${key}.rate number|null`);
        assert.equal(typeof m.denom, 'number', `${ctx} participation.${key}.denom 숫자`);
        assert.equal(typeof m.numer, 'number', `${ctx} participation.${key}.numer 숫자`);
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV3: classId 격리 — getClassDashboard(classId=A) 의 멤버는 모두 A 클래스 소속.
//   ← 스코프 누락 부류 차단. (콘텐츠활용현황은 class_id 스코프이므로 멤버 외 user 유입 불가
//      — 멤버 집합이 곧 격리 단위이므로 멤버 명부의 A 소속을 검증한다.)
// ──────────────────────────────────────────────────────────────────────────
test('INV3: getClassDashboard 멤버는 모두 해당 classId 소속', () => {
  // 기대값도 학생 모집단 SSOT 를 경유한다.
  //   [P1-C] 2026-08-06 — 여기에 `cm.role='member' AND u.role='student'` 손 SQL 을 적어 뒀던
  //   탓에, 이 테스트의 "정답"이 곧 검사 대상의 **결함과 같은 술어**였다(class 1 = 8명).
  //   cm.status·계정삭제를 안 보므로 탈퇴자·삭제 계정을 정답으로 인정하고 있었던 셈이고,
  //   getClassDashboard 를 SSOT(7명)로 고치자 되레 이 테스트가 붉어졌다.
  //   기대값을 손으로 적으면 결함을 박제하게 된다 → SSOT 경유.
  const realMembers = new Set(require('../db/class').getClassStudentIds(CLASS));

  for (const r of RANGES) {
    const dash = g.getClassDashboard(CLASS, TEACHER, r.opts);
    for (const s of dash.students) {
      assert.ok(
        realMembers.has(s.id),
        `(${r.label}) 대시보드 학생 ${s.id} 가 class ${CLASS} 멤버가 아님(스코프 누락)`
      );
    }
    // 멤버 수 일치 (타 클래스 학생 유입 금지)
    assert.equal(dash.students.length, realMembers.size, `(${r.label}) 멤버 수 일치`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV4: 카드 = 내역 일치 — 참여도/콘텐츠 카드 카운트 === getReportDetail 해당 type 내역 길이.
//   ← 카드 ≠ 내역 부류 차단. 막대(learningCapacity[].cnt) ↔ 모달(detail count·items.length).
// ──────────────────────────────────────────────────────────────────────────
test('INV4: 참여도 막대 카운트 === getReportDetail count === items.length', () => {
  // FE ACT_TO_DETAIL_TYPE 의 드릴 가능한 대표 activity_type → detail type 매핑
  const BAR_TO_DETAIL = {
    post_create: 'post',
    attendance_checkin: 'attendance',
    survey_respond: 'survey',
    homework_submit: 'homework',
    exam_complete: 'exam',
    lesson_complete: 'lesson',
    content_view: 'content_viewed',
    diagnosis_complete: 'ai_learning',
    daily_complete: 'today_learning',
    portfolio_add: 'content_portfolio'
  };
  for (const sid of STUDENTS) {
    for (const r of RANGES) {
      const rep = g.getStudentReport(sid, { classId: CLASS, ...r.opts });
      const bars = {};
      (rep.learningCapacity || []).forEach(b => { bars[b.activity_type] = b.cnt; });
      for (const [at, detailType] of Object.entries(BAR_TO_DETAIL)) {
        if (!(at in bars)) continue; // 그 활동유형 막대가 없으면 스킵
        const detail = g.getReportDetail(sid, detailType, { classId: CLASS, ...r.opts });
        const ctx = `(${sid},${r.label},${at}→${detailType})`;
        // (a) 카드 막대 카운트 === detail.count (단일 소스화)
        assert.equal(bars[at], detail.count, `${ctx} 막대 cnt(${bars[at]}) === detail.count(${detail.count})`);
        // (b) detail.count === items.length (LIMIT 200 미만일 때; 그 이상은 상한이라 ≤)
        if (detail.count <= 200) {
          assert.equal(detail.items.length, detail.count, `${ctx} items.length(${detail.items.length}) === count(${detail.count})`);
        } else {
          assert.equal(detail.items.length, 200, `${ctx} 상한 200`);
        }
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV5: 요약 ↔ 매트릭스 일관성 — getClassDashboard.dailyLearning 와
//   getClassDailyLearning(같은 기간)이 모순 없음.
//   규칙: 요약이 "참여 신호(완료율>0 또는 참여인원>0)"를 보이면 매트릭스에도 participated 셀이 존재.
//   ← "75점인데 0명" 부류 차단.
// ──────────────────────────────────────────────────────────────────────────
test('INV5: dailyLearning 요약 ↔ getClassDailyLearning 매트릭스 모순 없음', () => {
  for (const r of RANGES) {
    const dash = g.getClassDashboard(CLASS, TEACHER, r.opts);
    const dl = dash.dailyLearning;
    // 대시보드가 위임하는 동일 기간으로 매트릭스 재산출
    const matrixOpts = (r.opts.startDate && r.opts.endDate)
      ? { startDate: r.opts.startDate, endDate: r.opts.endDate }
      : { period: 'monthly' };
    const cd = g.getClassDailyLearning(CLASS, matrixOpts);
    const anyParticipatedCell = (cd.students || []).some(
      s => s.daily && Object.values(s.daily).some(c => c && c.participated)
    );
    const ctx = `(${r.label})`;
    // 요약 참여 신호가 있으면 매트릭스에 participated 셀이 있어야 (요약>0 인데 매트릭스 0 = 모순)
    const summarySignals = (dl.avgCompletionRate > 0) || (dl.participantCount > 0) || (dl.dailyAvgParticipants > 0);
    if (summarySignals) {
      assert.ok(anyParticipatedCell, `${ctx} 요약은 참여 신호 있는데 매트릭스엔 participated 셀 0 (모순)`);
    }
    // 역도 부분 검증: 정답률 요약이 있으면(avgAccuracy>0) 점수 있는 셀이 매트릭스에 존재
    if (dl.avgAccuracy != null && dl.avgAccuracy > 0) {
      const anyScoreCell = (cd.students || []).some(
        s => s.daily && Object.values(s.daily).some(c => c && c.score != null)
      );
      assert.ok(anyScoreCell, `${ctx} 요약 정답률>0 인데 매트릭스 점수 셀 0 (모순)`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV6: 날짜 귀속 정책 (DAILY_LEARNING_DATE_ATTRIBUTION_SPEC §6-1) — 매트릭스는 진도표이므로
//   participated 셀의 날짜 = 그 학생이 완료한 세트의 target_date(완료일 completed_at 무관).
//   즉 학생이 어느 셀(날짜 d)에 participated면, d 는 그 학생이 1건 이상 완료한 세트의 target_date 집합에 속해야 한다.
//   (완료일 completed_at 은 검증식에 일절 등장하지 않음 = 진도=배정일 정책 박제. 밀려 풀기는 정상 동작.)
// ──────────────────────────────────────────────────────────────────────────
test('INV6: 매트릭스 participated 셀의 날짜 = 세트 target_date (완료일 무관)', () => {
  const { openTestDb } = require('./_setup');
  const db = openTestDb();
  // 데이터가 확실히 있는 기간으로 검증 (현재 월)
  const cd = g.getClassDailyLearning(CLASS, { period: 'monthly' });
  const start = cd.startDate, end = cd.endDate;

  for (const s of cd.students) {
    // 매트릭스가 주장하는 이 학생의 participated 날짜 집합 (기간 내)
    const matrixDates = new Set(
      Object.entries(s.daily || {})
        .filter(([, c]) => c && c.participated)
        .map(([d]) => d)
    );
    if (matrixDates.size === 0) continue; // 참여 없는 학생은 스킵

    // 매트릭스가 이 학생에게 부여한 후보 세트들(이 학생 학년·클래스 매칭) 의 id 집합
    const memberSetIds = (cd.sets || []).map(st => st.id);
    if (memberSetIds.length === 0) continue;
    const ph = memberSetIds.map(() => '?').join(',');

    // 이 학생이 1건 이상 완료한 세트의 target_date 집합 (기간은 target_date 기준 — 완료일 미사용)
    const targetDateSet = new Set(db.prepare(`
      SELECT DISTINCT s.target_date AS d
      FROM daily_learning_progress p
      JOIN daily_learning_items i ON i.id = p.item_id
      JOIN daily_learning_sets s ON s.id = i.set_id
      WHERE p.user_id = ? AND p.status = 'completed'
        AND i.set_id IN (${ph})
        AND s.target_date IS NOT NULL
        AND s.target_date BETWEEN ? AND ?
    `).all(s.id, ...memberSetIds, start, end).map(r => r.d));

    // 매트릭스 participated 날짜는 모두 "완료 세트의 target_date" 집합에 속해야 (배정일 칸 귀속)
    for (const d of matrixDates) {
      assert.ok(
        targetDateSet.has(d),
        `학생 ${s.id}: 매트릭스 participated 날짜 ${d} 가 완료 세트의 target_date 집합에 없음(진도≠배정일 = 정책 위반)`
      );
    }
  }
  db.close();
});

// ──────────────────────────────────────────────────────────────────────────
// INV7: 스트릭(연속 학습일)은 활동일(DATE(completed_at)) distinct 기준 (SPEC §6-3).
//   진도(매트릭스 셀=target_date)와 습관(스트릭=완료일)을 분리. 밀려 몰아 풀면(배정일 여러 날을
//   하루에 완료) 스트릭이 배정일 연속으로 늘면 안 됨(실제 학습일이 하루뿐이면 스트릭 기여 1).
//   격리 DB fixture 로 5/30·5/31 배정 세트 2개를 6/16 하루에 완료한 케이스를 직접 삽입해 검증.
// ──────────────────────────────────────────────────────────────────────────
test('INV7: 매트릭스 summaryMaxStreak 는 활동일(DATE(completed_at)) 연속 기준 (진도≠습관)', () => {
  const { openTestDb } = require('./_setup');
  const db = openTestDb();
  // 미래 기간(실 데이터와 무간섭) — 5/30·5/31 배정 세트를 6/16 하루에 몰아 완료.
  const d1 = '2097-05-30', d2 = '2097-05-31';
  const completedDay = '2097-06-16 09:00:00';
  const win = { startDate: '2097-05-01', endDate: '2097-05-31' };

  const mkSet = (td) => db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, 'INV7-몰아풀기세트', ?, 4, 1)
  `).run(CLASS, TEACHER, td).lastInsertRowid;
  const mkItem = (sid) => db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, item_title, sort_order)
    VALUES (?, 'content', 'INV7항목', 1)
  `).run(sid).lastInsertRowid;
  for (const td of [d1, d2]) {
    const sid = mkSet(td);
    const iid = mkItem(sid);
    db.prepare(`
      INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, completed_at, correct_count, total_questions, score)
      VALUES (?, ?, ?, 'completed', ?, 1, 1, 100)
    `).run(S1, iid, sid, completedDay);
  }

  const cd = g.getClassDailyLearning(CLASS, win);
  const stu = cd.students.find(s => s.id === S1);
  assert.ok(stu, 'INV7: student1 매트릭스 존재');
  // 진도(매트릭스): 5/30·5/31 둘 다 participated (배정일 칸 귀속)
  assert.equal(!!(stu.daily[d1] && stu.daily[d1].participated), true, 'INV7: 5/30 칸 진도 participated');
  assert.equal(!!(stu.daily[d2] && stu.daily[d2].participated), true, 'INV7: 5/31 칸 진도 participated');
  // 습관(스트릭): 실제 학습일이 6/16 하루뿐 → 5월 기간의 활동일 0 → summaryMaxStreak 가 배정일 연속(2)로 둔갑하면 안 됨.
  // 이 학생만의 활동일 distinct 연속 길이와 일치해야 한다.
  const days = db.prepare(`
    SELECT DISTINCT DATE(p.completed_at) AS day
    FROM daily_learning_progress p
    JOIN daily_learning_items i ON i.id = p.item_id
    JOIN daily_learning_sets s ON s.id = i.set_id
    WHERE p.user_id = ? AND p.status = 'completed'
      AND (s.class_id = ? OR (s.class_id IS NULL AND s.target_grade = 4))
      AND s.target_date BETWEEN ? AND ?
      AND DATE(p.completed_at) BETWEEN ? AND ?
    ORDER BY day ASC
  `).all(S1, CLASS, win.startDate, win.endDate, win.startDate, win.endDate).map(r => r.day);
  // 5월 기간 한정: target_date∈5월 세트의 완료를 5월 활동일로 보면 6/16 은 5월 밖 → days 비어야 함.
  assert.equal(days.length, 0, 'INV7: 5월 배정 세트를 6/16에 완료 → 5월 활동일 0 (습관은 5월에 없음)');
  // 따라서 이 fixture 가 만든 학생의 5월 스트릭 기여는 0 이어야(배정일 연속 2로 둔갑 금지).
  // summaryMaxStreak 는 클래스 전체 max 이므로 이 학생만의 best 를 직접 검증할 수 없다 → studentData 미노출.
  // 대신: 매트릭스 participated 셀이 2개(연속)인데도, 스트릭이 셀에서 파생되지 않음을 보증하기 위해
  // "스트릭이 활동일 0 학생에 대해 2를 주지 않는다"를 클래스 max 로 상한 검증한다.
  // (이 격리 DB엔 5월 활동일을 가진 다른 학생이 없으므로 summaryMaxStreak 는 0 이어야 한다.)
  assert.equal(cd.summary.maxStreak, 0,
    'INV7: 5월 화면 스트릭은 활동일(6/16=5월밖) 기준 0 — 배정일 연속(2)로 둔갑 금지');
});

// ──────────────────────────────────────────────────────────────────────────
// INV8: computeAreas6 비전파 (SPEC §6-4) — 매트릭스가 target_date 로 바뀌어도 6축 daily 산식은 그대로.
//   daily 분모=target_date(그 기간 배정 세트 수)·분자=completed_at(그 기간 실제 완료). 밀려 풀기 시
//   5월 배정 0 / 6월에 5월세트 완료 케이스에서 6월 기간 computeAreas6: daily.denom==0 → rate=null(clamp).
//   격리 DB fixture: 5월 배정 세트를 6/16에 완료 → 6월 화면 daily denom 0 검증.
// ──────────────────────────────────────────────────────────────────────────
test('INV8: 6축 daily 분모는 target_date·분자는 completed_at (매트릭스 정책 비전파)', () => {
  const { openTestDb } = require('./_setup');
  const db = openTestDb();
  // 5월 배정 세트(class1 전용)를 6/16에 student2 가 완료. 6월엔 배정 세트 0건이 되도록 별도 학생/기간 사용.
  const td = '2098-05-31';                 // 5월 배정
  const completedDay = '2098-06-16 09:00:00'; // 6월 완료
  const juneWin = { classId: CLASS, startDate: '2098-06-01', endDate: '2098-06-30' };

  const sid = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active)
    VALUES (?, ?, 'INV8-비전파세트', ?, 4, 1)
  `).run(CLASS, TEACHER, td).lastInsertRowid;
  const iid = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, item_title, sort_order)
    VALUES (?, 'content', 'INV8항목', 1)
  `).run(sid).lastInsertRowid;
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, completed_at, correct_count, total_questions, score)
    VALUES (?, ?, ?, 'completed', ?, 1, 1, 100)
  `).run(S2, iid, sid, completedDay);

  const a = g.computeAreas6(S2, juneWin);
  const daily = a['참여도'].participation.daily;
  // 6월 화면: 6월 배정 세트 0 → daily.denom == 0, clamp 에 의해 rate == null (점수 왜곡 없음)
  assert.equal(daily.denom, 0, 'INV8: 6월 기간 배정(target_date) 세트 0 → daily.denom=0');
  assert.equal(daily.rate, null, 'INV8: denom 0 → rate null (매트릭스 정책 비전파, clamp 흡수)');
  db.close();
});

// ──────────────────────────────────────────────────────────────────────────
// INV9: 포트폴리오 학교급 필터는 메타(school_level/grade_year) 없는 자동 수집 항목을 가리지 않는다.
//   과제 제출·문항풀이 등 자동 생성 portfolio_items 는 학교급 메타가 둘 다 NULL 일 수 있고,
//   학생 포트폴리오 화면은 기본 학교급 필터가 활성이므로, 이 절이 없으면 자동 항목이 전부 사라진다.
//   부류 차단: "학교급 필터 적용 시 메타 없는 항목이 조회 결과에서 사라지면 실패."
//   동시에 학교급 격리(다른 학교급 명시 항목은 섞이지 않음)도 함께 단언한다.
//   격리 DB fixture: 메타 null·초등명시·중등명시 3건을 삽입하고 elementary/middle 필터로 교차 검증.
// ──────────────────────────────────────────────────────────────────────────
test('INV9: 학교급 필터는 메타없는 자동 portfolio_items 를 가리지 않고 학교급 격리는 유지', () => {
  const { openTestDb } = require('./_setup');
  const db = openTestDb();
  // 실 데이터와 무간섭한 가짜 학생(미래/고유 id). users 행을 만들어 격리.
  const stuId = 990001;
  db.prepare("INSERT OR REPLACE INTO users (id, username, password, display_name, role, grade) VALUES (?, ?, '0000', 'INV9학생', 'student', 4)")
    .run(stuId, 'inv9_stu_' + stuId);

  const mkPI = (name, schoolLevel, gradeYear) => db.prepare(`
    INSERT INTO portfolio_items (user_id, source_type, activity_name, activity_date, result_type, activity_type, school_level, grade_year)
    VALUES (?, 'class', ?, '2099-06-17', 'completed', 'homework_submit', ?, ?)
  `).run(stuId, name, schoolLevel, gradeYear).lastInsertRowid;

  const idNull = mkPI('INV9 메타없는 자동항목(과제제출)', null, null);  // 자동 수집 — 메타 둘 다 null
  const idElem = mkPI('INV9 초등 명시항목', 'elementary', '4');
  const idMid  = mkPI('INV9 중등 명시항목', 'middle', '8');

  // elementary 필터: 메타없는 항목 + 초등 명시 포함, 중등 제외
  const elem = g.getPortfolioItems(stuId, { schoolLevel: 'elementary', limit: 100 });
  const elemIds = elem.items.map(i => i.id);
  assert.ok(elemIds.includes(idNull),
    'INV9: 메타(school_level/grade_year) 없는 자동 항목은 학교급 필터(elementary)에서 사라지면 안 됨');
  assert.ok(elemIds.includes(idElem), 'INV9: 초등 명시 항목은 elementary 필터에 포함');
  assert.ok(!elemIds.includes(idMid), 'INV9: 중등 명시 항목은 elementary 필터에서 제외(학교급 격리)');

  // middle 필터: 메타없는 항목 + 중등 명시 포함, 초등 제외
  const mid = g.getPortfolioItems(stuId, { schoolLevel: 'middle', limit: 100 });
  const midIds = mid.items.map(i => i.id);
  assert.ok(midIds.includes(idNull), 'INV9: 메타 없는 자동 항목은 middle 필터에서도 사라지면 안 됨');
  assert.ok(midIds.includes(idMid), 'INV9: 중등 명시 항목은 middle 필터에 포함');
  assert.ok(!midIds.includes(idElem), 'INV9: 초등 명시 항목은 middle 필터에서 제외(학교급 격리)');

  db.close();
});
