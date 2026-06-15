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
  const { openTestDb } = require('./_setup');
  const db = openTestDb();
  // class A 의 실제 멤버 명부 (member 역할 학생)
  const realMembers = new Set(db.prepare(`
    SELECT u.id FROM class_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.class_id = ? AND cm.role = 'member' AND u.role = 'student'
  `).all(CLASS).map(r => r.id));
  db.close();

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
// INV6: 날짜 귀속 정합 — getClassDailyLearning 의 participated 셀 날짜는 그 학생의 실제
//   활동일(DATE(completed_at))과 일치. ← 타임존 off-by-one / off-by-month 부류 차단.
//   매트릭스 셀별 (날짜) 과 DB 의 실제 완료일 집합이 일치하는지 교차 검증.
// ──────────────────────────────────────────────────────────────────────────
test('INV6: 매트릭스 participated 날짜 = 실제 DATE(completed_at)', () => {
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
    const memberSetIds = (cd.sets || [])
      .map(st => st.id);
    if (memberSetIds.length === 0) continue;
    const ph = memberSetIds.map(() => '?').join(',');

    // DB 실제 완료일 (기간 내, 이 학생, 매칭 세트 항목)
    const realDates = new Set(db.prepare(`
      SELECT DISTINCT DATE(p.completed_at) AS d
      FROM daily_learning_progress p
      JOIN daily_learning_items i ON i.id = p.item_id
      WHERE p.user_id = ? AND p.status = 'completed'
        AND i.set_id IN (${ph})
        AND DATE(p.completed_at) BETWEEN ? AND ?
    `).all(s.id, ...memberSetIds, start, end).map(r => r.d));

    // 매트릭스 participated 날짜는 모두 실제 완료일 집합의 부분집합이어야 (off-by-one/month 면 어긋남)
    for (const d of matrixDates) {
      assert.ok(
        realDates.has(d),
        `학생 ${s.id}: 매트릭스 participated 날짜 ${d} 가 실제 DATE(completed_at) 집합에 없음(날짜 귀속 오류)`
      );
    }
  }
  db.close();
});
