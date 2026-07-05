// test/lrs-analytics.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 분석·예측 P0 하네스 — 위험점수·추세·도달예측·선수갭·권한·멤버십 집계.
//   기획서: 작업지시서/LRS_분석예측_강화_기획서.md §B-1~B-5 · §C-5
//
// 박제 불변식·회귀:
//   [REG]  OLS slope/intercept/R² 정확도 + 엣지(점0·점1·분산0·완전적합)
//   [RISK] 0~100 범위 / insufficient 비가산(P5) / 감정없음 재정규화 / 등급경계 / 근거생성
//   [TREND] 주<3 결측 · 관측주차<3 미산출 · slope 부호 · R² ∈ [0,1]
//   [PROJ] slope<=0 → reachable=false · 밴드 동반 · 단일확정선 금지
//   [PERM] 학생→ews 403 · 본인 trend 200/타인 403 · 교사 소유반만 · trend 응답 위험필드 없음
//   [MEMB] /stats/custom 멤버십 집계 — self-learn class_id NULL 도 소속 학생이면 포착
//
// DB 격리: 실 DB → 임시 복사본. initSchema + rebuildAllAggregates(insufficient 분리).
// 계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4. class 1 = teacher1 소유.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();
require('../db/lrs-aggregate').rebuildAllAggregates();

const { ols, predict } = require('../lib/analytics/regression');
const analytics = require('../db/lrs-analytics');
const mastery = require('../db/lrs-mastery');
const db = openTestDb();

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const CLASS = 1;

// ════════════════════════════════════════════════════════════════════════════
// [REG] 순수 OLS 유틸 — 결정론 정확도 + 엣지
// ════════════════════════════════════════════════════════════════════════════
test('REG-1: 완전 직선 y=2x+1 → slope=2, intercept=1, r2=1', () => {
  const m = ols([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
  assert.ok(Math.abs(m.slope - 2) < 1e-9, `slope=${m.slope}`);
  assert.ok(Math.abs(m.intercept - 1) < 1e-9, `intercept=${m.intercept}`);
  assert.ok(Math.abs(m.r2 - 1) < 1e-9, `r2=${m.r2}`);
  assert.equal(m.n, 4);
});

test('REG-2: 하락 추세 음수 slope', () => {
  const m = ols([[0, 90], [1, 80], [2, 70], [3, 60]]);
  assert.ok(m.slope < 0, `하락이면 slope<0 (got ${m.slope})`);
  assert.ok(Math.abs(m.slope + 10) < 1e-9, `slope=${m.slope} ~ -10`);
});

test('REG-3: 엣지 — 점0개/점1개/분산0(모든 x동일)/모든 y동일', () => {
  assert.deepEqual(ols([]), { slope: 0, intercept: 0, r2: 0, n: 0 });
  const one = ols([{ x: 5, y: 42 }]);
  assert.equal(one.slope, 0); assert.equal(one.intercept, 42); assert.equal(one.n, 1);
  // 모든 x 동일 → 기울기 정의불가 → slope 0
  const flatX = ols([[2, 10], [2, 20], [2, 30]]);
  assert.equal(flatX.slope, 0, 'x분산0 → slope 0');
  // 모든 y 동일 → 변동 없음 → r2=1, slope 0
  const flatY = ols([[0, 5], [1, 5], [2, 5]]);
  assert.equal(flatY.slope, 0); assert.equal(flatY.r2, 1);
});

test('REG-4: r2 항상 [0,1], NaN/음수 금지', () => {
  const noisy = ols([[0, 10], [1, 50], [2, 12], [3, 48], [4, 11]]);
  assert.ok(noisy.r2 >= 0 && noisy.r2 <= 1, `r2=${noisy.r2}`);
  assert.ok(Number.isFinite(noisy.r2));
});

test('REG-5: predict 외삽', () => {
  const m = ols([[0, 0], [1, 10], [2, 20]]);
  assert.ok(Math.abs(predict(m, 5) - 50) < 1e-9, `predict(5)=${predict(m, 5)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// [TREND] 추세 — 주<3 결측, 관측주차<3 미산출, slope/r2 정합
// ════════════════════════════════════════════════════════════════════════════
test('TREND-1: 관측주차<3 이면 status=insufficient(미산출)', () => {
  // student2 는 데이터가 적어 관측주차가 보통 3 미만 → insufficient
  const t = analytics.computeTrend({ userId: STUDENT2 });
  if (t.status === 'insufficient') {
    assert.equal(t.direction, 'insufficient');
    assert.equal(t.slope, null, '미산출이면 slope null');
    assert.ok(t.observedWeeks < 3, `observedWeeks=${t.observedWeeks} 는 3 미만이어야`);
  } else {
    // 데이터가 충분하면 ok — 그 경우 observedWeeks>=3
    assert.ok(t.observedWeeks >= 3);
  }
});

test('TREND-2: status=ok 면 slope/r2 유효, r2 ∈ [0,1], direction 4종', () => {
  const valid = new Set(['up', 'flat', 'down']);
  for (const sid of [STUDENT1, STUDENT2, 5, 10, 11]) {
    const t = analytics.computeTrend({ userId: sid });
    if (t.status !== 'ok') continue;
    assert.ok(Number.isFinite(t.slope), `student ${sid} slope 유한`);
    assert.ok(t.r2 >= 0 && t.r2 <= 1, `student ${sid} r2=${t.r2}`);
    assert.ok(valid.has(t.direction), `student ${sid} direction=${t.direction}`);
    assert.ok(t.observedWeeks >= 3, `ok 면 관측주차>=3`);
    // 직접 series 로 slope 부호 검증
    assert.ok((t.slope >= 2) === (t.direction === 'up') || t.direction !== 'up');
  }
});

// [P1 추이 과다 게이트 fix — 계약 변경] sparse 주(시도 1~2건)도 이제 관측 포인트로 포함한다.
//   과거엔 주<3 을 결측 처리해 관측주가 과소 산출됐다(uid3 는 25주 1점만 남아 추세선이 영영 안 뜸).
//   이제 완전 결측(0건)만 제외하고, series 는 실측 주를 그대로 채운다. attempts>=1 이면 series 에 존재.
test('TREND-3: sparse 주(시도>=1)도 series 관측 포인트로 포함 (과다 게이트 제거)', () => {
  const t = analytics.computeTrend({ classId: CLASS });
  for (const w of t.series) {
    assert.ok(w.attempts >= 1, `주 ${w.week} attempts=${w.attempts} 는 1 이상이어야(0건만 제외)`);
    assert.ok(w.rate >= 0 && w.rate <= 100, `주 ${w.week} rate=${w.rate} 는 0~100`);
  }
});

// [P1 추이 회귀박제] uid3 는 실제 정오답 3주(2026-23·24·25)가 있으므로 series 는 최소 2점(가능하면 3점),
//   canDrawLine=true 여야 한다. 과거 결함: achievement_code IS NOT NULL 조건 + 주<3 게이트로 1점만 나와
//   꺾은선이 영영 안 그려졌다. (성취기준 태그 없는 정오답 로그가 있는 학생의 전체 추세가 사라지던 문제.)
test('TREND-3b: uid3 전체 추세 series 는 >=2점(실측 3점) & canDrawLine=true', () => {
  const t = analytics.computeTrend({ userId: 3 });
  assert.ok(t.series.length >= 2,
    `uid3 series 길이=${t.series.length} — 최소 2점이어야(과다 게이트 회귀). 실측 3주.`);
  assert.equal(t.canDrawLine, true, 'series>=2 면 canDrawLine=true (꺾은선 가능 신호)');
  // 관측 3주면 status='ok' 로 slope/예측까지 산출돼야(≥3주 게이트 통과).
  if (t.series.length >= 3) {
    assert.equal(t.status, 'ok', '관측 3주면 status=ok');
    assert.ok(Number.isFinite(t.slope), 'ok 면 slope 유한');
  }
});

// [P0 약점 은폐 fix — 회귀박제] success_count=0 & avg_score=null 인 미도달 성취기준이
//   mastery weaknesses/standards 에서 통째로 누락되지 않아야 한다.
//   reachRate(success,attempts,avg) 가 success/attempt 로 rate=0 을 산출(avg_score null 폴백) →
//   status=not_reached 로 약점에 반드시 포함. (avg_score 만 보면 null 이라 빠지던 결함.)
//   과거 증상: 도달 5개(초록)만 보이고 미도달 5개가 화면에서 사라짐.
test('MASTERY-WEAK-1: 미도달(success=0·avg=null)도 약점에 rate 0~100 으로 포함 (은폐 방지)', () => {
  const m = mastery.getStudentMastery(STUDENT1);
  // 미도달 성취기준은 standards 와 weaknesses 양쪽에 rate(0~100)로 존재해야.
  const nrStandards = (m.standards || []).filter(s => s.status === 'not_reached');
  assert.ok(nrStandards.length >= 1,
    `미도달 성취기준이 standards 에 최소 1건 있어야(은폐 회귀) — 실제=${nrStandards.length}`);
  for (const s of nrStandards) {
    assert.ok(s.rate != null && s.rate >= 0 && s.rate <= 100,
      `미도달 rate 는 0~100 이어야(null 금지) — code=${s.code}, rate=${s.rate}`);
  }
  // weaknesses 에도 미도달이 실려야(강·약 diverge 에서 약점 축이 비지 않게).
  const nrWeak = (m.weaknesses || []).filter(w => w.status === 'not_reached');
  assert.ok(nrWeak.length >= 1,
    `weaknesses 에 미도달이 최소 1건 있어야 — 실제=${nrWeak.length}`);
  for (const w of nrWeak) {
    assert.ok(w.rate != null && w.rate >= 0 && w.rate <= 100,
      `약점 미도달 rate 0~100 — code=${w.code}, rate=${w.rate}`);
  }
  // counts.notReached 도 0 이 아니어야(도넛/집계에서 미도달이 살아있어야).
  assert.ok(m.counts.notReached >= 1, `counts.notReached=${m.counts.notReached} — 미도달 집계 은폐`);
});

test('TREND-4: 반 추세도 동일 함수(classId) — 멤버십 집계', () => {
  const t = analytics.computeTrend({ classId: CLASS });
  assert.ok(t.status === 'ok' || t.status === 'insufficient');
  assert.ok(Number.isInteger(t.observedWeeks));
});

// ════════════════════════════════════════════════════════════════════════════
// [PROJ] 도달 예측 — slope<=0 도달불가, 밴드 동반, 단일확정선 금지
// ════════════════════════════════════════════════════════════════════════════
test('PROJ-1: slope<=0 이면 reachable=false (도달 어려움)', () => {
  const fakeTrend = { status: 'ok', currentRate: 40, slope: -3, confidence: 'medium' };
  const p = analytics.projectReach(fakeTrend, { target: 80 });
  assert.equal(p.reachable, false);
  assert.equal(p.weeksToReach, null);
  assert.match(p.message, /도달이 어려워요|가까워져요/);
});

test('PROJ-2: slope>0 도달가능 — weeksToReach 양수 + 불확실성 밴드 동반', () => {
  const fakeTrend = { status: 'ok', currentRate: 60, slope: 4, confidence: 'high' };
  const p = analytics.projectReach(fakeTrend, { target: 80 });
  assert.equal(p.reachable, true);
  assert.ok(p.weeksToReach > 0 && p.weeksToReach <= 20, `weeks=${p.weeksToReach}`);
  assert.ok(p.band && p.band.lo != null && p.band.hi != null, '밴드(lo/hi) 동반 — 단일확정선 금지');
  assert.ok(p.band.hi > p.band.lo, '밴드 폭>0');
});

test('PROJ-3: 데이터 부족(trend insufficient) → status=insufficient 친절 메시지', () => {
  const p = analytics.projectReach({ status: 'insufficient' }, { target: 80 });
  assert.equal(p.status, 'insufficient');
  assert.equal(p.reachable, null);
  // 문구 정직성(감사 §7): "덜 풀어서"가 아니라 "관측 주차(시간) 부족"임을 알리는 어휘.
  //   → "더 풀면" 금지, "주(週)/시간/기록" 어휘 사용.
  assert.doesNotMatch(p.message, /더 풀면/, 'insufficient 는 양(量) 문제가 아니므로 "더 풀면" 금지');
  assert.match(p.message, /주|시간|기록/, '시간(주차) 어휘로 안내해야');
});

test('PROJ-4: 이미 도달(r0>=target) → reachable=true, weeks=0', () => {
  const p = analytics.projectReach({ status: 'ok', currentRate: 85, slope: 1, confidence: 'high' }, { target: 80 });
  assert.equal(p.reachable, true);
  assert.equal(p.weeksToReach, 0);
});

// ── [PROJ-INS] 도달 예측 "분석 멘트"(insights) — 전체 LRS 공통 lrs-insight 소비.
//   문안은 BE 소유(FE 하드코딩 금지). level 3종(good/warn/info)·1~2개·비어있지 않음·단정 금지.
const VALID_INS_LEVELS = new Set(['good', 'warn', 'info']);
function assertInsShape(ins) {
  assert.ok(Array.isArray(ins), 'insights 는 배열');
  assert.ok(ins.length >= 1 && ins.length <= 2, `insights 1~2개 (실제 ${ins.length})`);
  for (const it of ins) {
    assert.ok(VALID_INS_LEVELS.has(it.level), `level 3종 중 하나 (${it.level})`);
    assert.ok(typeof it.text === 'string' && it.text.trim().length > 0, '문안 비어있지 않음');
  }
}

test('PROJ-INS-1: 자료부족 → info 1개, "부족·주" 안내', () => {
  const trend = { status: 'insufficient', observedWeeks: 1 };
  const proj = analytics.projectReach(trend, { target: 80 });
  const ins = analytics.projectionInsights(trend, proj, 80);
  assertInsShape(ins);
  assert.equal(ins[0].level, 'info');
  assert.match(ins[0].text, /부족|주/);
});

test('PROJ-INS-2: 이미 목표 도달 → good "이미"', () => {
  const trend = { status: 'ok', currentRate: 85, slope: 1, confidence: 'high' };
  const proj = analytics.projectReach(trend, { target: 80 });
  const ins = analytics.projectionInsights(trend, proj, 80);
  assertInsShape(ins);
  assert.equal(ins[0].level, 'good');
  assert.match(ins[0].text, /이미/);
});

test('PROJ-INS-3: 상승세 없음(slope<=0) → warn "오르지 않"·보충 유도', () => {
  const trend = { status: 'ok', currentRate: 40, slope: -3, confidence: 'medium' };
  const proj = analytics.projectReach(trend, { target: 80 });
  const ins = analytics.projectionInsights(trend, proj, 80);
  assertInsShape(ins);
  assert.equal(ins[0].level, 'warn');
  assert.match(ins[0].text, /오르지 않|보충/);
});

test('PROJ-INS-4: 곧 도달(≤6주) → good, 주(週) 언급', () => {
  const trend = { status: 'ok', currentRate: 70, slope: 4, confidence: 'high' }; // ceil((80-70)/4)=3주
  const proj = analytics.projectReach(trend, { target: 80 });
  const ins = analytics.projectionInsights(trend, proj, 80);
  assertInsShape(ins);
  assert.equal(ins[0].level, 'good');
  assert.match(ins[0].text, /주/);
});

test('PROJ-INS-5: 도달 오래(>6주)+저신뢰 → info + 보조멘트(정확히 2개)', () => {
  const trend = { status: 'ok', currentRate: 40, slope: 3, confidence: 'low', observedWeeks: 3 }; // ceil(40/3)=14주
  const proj = analytics.projectReach(trend, { target: 80 });
  const ins = analytics.projectionInsights(trend, proj, 80);
  assert.equal(ins.length, 2, '저신뢰면 보조멘트 포함 2개');
  assertInsShape(ins);
  assert.equal(ins[0].level, 'info');
});

// ════════════════════════════════════════════════════════════════════════════
// [RISK] 위험점수 — 0~100, insufficient 비가산, 감정없음 재정규화, 등급경계, 근거
// ════════════════════════════════════════════════════════════════════════════
test('RISK-1: 모든 학생 위험점수 ∈ [0,100] 정수, 등급 일관', () => {
  const r = analytics.getClassRiskList(CLASS);
  assert.ok(Array.isArray(r.list) && r.list.length > 0, '위험 리스트 비어있지 않음');
  for (const s of r.list) {
    assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100, `${s.userId} score=${s.score}`);
    const g = s.score >= 70 ? 'high' : s.score >= 40 ? 'medium' : 'low';
    assert.equal(s.grade, g, `${s.userId} 등급 경계: score ${s.score} → ${g} (got ${s.grade})`);
  }
});

test('RISK-2: 등급 경계값 — riskGrade(69)=medium, (70)=high, (39)=low, (40)=medium', () => {
  assert.equal(analytics.riskGrade(69), 'medium');
  assert.equal(analytics.riskGrade(70), 'high');
  assert.equal(analytics.riskGrade(39), 'low');
  assert.equal(analytics.riskGrade(40), 'medium');
});

test('RISK-3: insufficient(평가부족) 는 s_mastery 에 비가산(P5) — 평가부족만 있는 학생 위험 낮음', () => {
  const r = analytics.getClassRiskList(CLASS);
  for (const s of r.list) {
    // evaluated=0 (전부 평가부족) 이면 s_mastery=0 이어야(평가부족을 미도달로 오인 금지)
    if (s.evaluated === 0) {
      assert.equal(s.signals.s_mastery, 0, `${s.userId} evaluated=0 인데 s_mastery>0 — 평가부족 오가산`);
    }
  }
  // 단위 검증: 미도달 비율은 evaluated 분모(insufficient 제외) — 코드 정합은 _masteryCounts 가 보장.
  // 합성 케이스: evaluated 0 → 위험 기여 0
});

test('RISK-4: 감정 데이터 없으면 w_emotion 재정규화 — s_emotion=null 이고 점수에 감정 미반영', () => {
  const r = analytics.getClassRiskList(CLASS);
  // 감정 기록 없는 학생: s_emotion=null. 그 학생 점수는 mastery/decline/engage 만으로 산출돼야.
  const noEmo = r.list.filter(s => s.signals.s_emotion == null);
  for (const s of noEmo) {
    // 재정규화 검증: 세 신호가 모두 0 이면 점수도 0 (감정 0 을 부정으로 오인하면 점수가 0 이 아닐 것)
    if (s.signals.s_mastery === 0 && s.signals.s_decline === 0 && s.signals.s_engage === 0) {
      assert.equal(s.score, 0, `${s.userId} 감정없음+세신호0 인데 score=${s.score} — 감정0 오인(재정규화 실패)`);
    }
  }
});

test('RISK-5: 근거 배열 생성 — 위험 기여 신호가 있으면 reasons 에 텍스트 동반', () => {
  const r = analytics.getClassRiskList(CLASS);
  for (const s of r.list) {
    assert.ok(Array.isArray(s.reasons), `${s.userId} reasons 배열`);
    for (const rs of s.reasons) {
      assert.ok(rs.type && typeof rs.text === 'string' && rs.text.length > 0, `근거에 type+text`);
    }
    // 위험점수>0 이면 적어도 1개 기여 근거(또는 평가부족 단서)
    if (s.score > 0) assert.ok(s.reasons.length > 0, `${s.userId} score>0 인데 근거 없음`);
  }
});

test('RISK-6: 신뢰도 — evaluated<3 이면 confidence=low(소표본 단서, P2)', () => {
  const r = analytics.getClassRiskList(CLASS);
  for (const s of r.list) {
    if (s.evaluated < 3) assert.equal(s.confidence, 'low', `${s.userId} evaluated<3 → low`);
  }
});

test('RISK-7: summary 합 = list 길이, 위험순 정렬(내림차순)', () => {
  const r = analytics.getClassRiskList(CLASS);
  assert.equal(r.summary.high + r.summary.medium + r.summary.low, r.list.length);
  for (let i = 1; i < r.list.length; i++) {
    assert.ok(r.list[i - 1].score >= r.list[i].score, `정렬 위반: ${r.list[i-1].score} < ${r.list[i].score}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// [PREREQ] 선수개념 갭 — 브리지 보수적, 미도달 선수만 막힘
// ════════════════════════════════════════════════════════════════════════════
test('PREREQ-1: getPrereqGap 구조 — edgesLoaded/bridged/gaps, blockedStudents 는 반 멤버만', () => {
  const g = analytics.getPrereqGap(CLASS);
  assert.ok(Number.isInteger(g.edgesLoaded));
  assert.ok(Number.isInteger(g.bridged));
  assert.ok(g.bridged <= g.edgesLoaded, '브리지된 엣지는 전체 이하(보수적)');
  // 브리지 회귀 박제: learning_map_nodes.node_id→achievement_code 브리지가 동작해야(엣지가 있으면 bridged>0).
  //   (옛 결함: std_id_map 만 사용 → 엣지 노드ID(D접미) 와 0 overlap → bridged=0 → 갭 전파 무력화)
  if (g.edgesLoaded > 0) assert.ok(g.bridged > 0, `엣지 ${g.edgesLoaded}개인데 bridged=0 — 노드↔code 브리지 미동작(회귀)`);
  const memberIds = new Set(analytics.classStudentIds(CLASS));
  for (const gap of g.gaps) {
    assert.ok(typeof gap.targetCode === 'string');
    for (const b of gap.blockedStudents) {
      assert.ok(memberIds.has(b.userId), `막힌 학생 ${b.userId} 가 반 멤버 아님(격리 위반)`);
      assert.ok(Array.isArray(b.missingPrereqs) && b.missingPrereqs.length > 0, '막힘이면 미도달 선수>0');
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// [WEAK] 취약 추세 랭킹
// ════════════════════════════════════════════════════════════════════════════
test('WEAK-1: getWeakTrend — 도달률 오름차 정렬, reachedRate ∈ [0,100]', () => {
  const ids = analytics.classStudentIds(CLASS);
  const rk = analytics.getWeakTrend({ userIds: ids, limit: 15 });
  for (const w of rk) {
    assert.ok(w.reachedRate >= 0 && w.reachedRate <= 100, `${w.code} reachedRate=${w.reachedRate}`);
  }
  for (let i = 1; i < rk.length; i++) {
    assert.ok(rk[i - 1].reachedRate <= rk[i].reachedRate, '도달률 오름차(취약 우선)');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// [MIRROR] A6 마음-공부 거울 — 정서 3그룹 × 성취/활동량 (학생 · 자기이해)
//   불변식: (a) groups 항상 3개(positive/neutral/negative 순) / (b) n<5 → avgScore·avgActs
//   모두 null / (c) avgScore ∈ [0,100] 또는 null / (d) 응답에 위험점수(score/grade/risk)
//   필드 부재(P6) / (e) coaching 문자열 존재.
//   시드: 합성 학생 id=99101 에 attendance(감정)+lrs_user_daily 를 INSERT.
// ════════════════════════════════════════════════════════════════════════════
const MIRROR_UID = 99101;
{
  // 합성 유저(관계 무결성용 — attendance.user_id FK). users: password/display_name NOT NULL.
  db.prepare(`INSERT OR IGNORE INTO users (id, username, password, display_name, role)
              VALUES (?, ?, ?, ?, 'student')`)
    .run(MIRROR_UID, `mirror_${MIRROR_UID}`, 'x', '거울테스트');

  // 최근 N일 내 날짜 문자열(오늘 - offset).
  const isoBack = (n) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  // attendance 감정 + 같은 날 lrs_user_daily 시드. class_id 는 임의(1).
  //   좋았던 날(긍정) 6일: 점수 80±, 활동 5   → n>=5 (수치 노출)
  //   힘든 날(부정)   6일: 점수 70±, 활동 3   → n>=5 (수치 노출)
  //   보통인 날(중립) 2일: 점수 75,  활동 4   → n<5  (마스킹)
  const seed = [];
  for (let i = 0; i < 6; i++) seed.push({ off: i + 1,  emo: 'happy',    score: 80, acts: 5 });   // positive
  for (let i = 0; i < 6; i++) seed.push({ off: i + 10, emo: 'sad',      score: 70, acts: 3 });   // negative
  for (let i = 0; i < 2; i++) seed.push({ off: i + 20, emo: 'neutral',  score: 75, acts: 4 });   // neutral (소표본)
  const insAtt = db.prepare(`INSERT OR IGNORE INTO attendance (class_id, user_id, attendance_date, status, emotion)
                             VALUES (1, ?, ?, 'present', ?)`);
  const insDaily = db.prepare(`INSERT OR IGNORE INTO lrs_user_daily (user_id, stat_date, activity_count, duration_sec, avg_score)
                               VALUES (?, ?, ?, ?, ?)`);
  for (const s of seed) {
    const date = isoBack(s.off);
    try { insAtt.run(MIRROR_UID, date, s.emo); } catch (_) {}
    try { insDaily.run(MIRROR_UID, date, s.acts, s.acts * 300, s.score); } catch (_) {}
  }
}

test('MIRROR-1: groups 항상 3개 · 순서 positive/neutral/negative', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  assert.equal(m.groups.length, 3, 'groups 3개');
  assert.deepEqual(m.groups.map(g => g.key), ['positive', 'neutral', 'negative'], '고정 순서');
  for (const g of m.groups) {
    assert.ok(typeof g.label === 'string' && g.label.length > 0, 'label 유지');
    assert.ok(typeof g.emoji === 'string' && g.emoji.length > 0, 'emoji 유지');
    assert.ok(Number.isInteger(g.n) && g.n >= 0, `n 정수 (${g.n})`);
  }
});

test('MIRROR-2: 각 그룹 n<5 → avgScore·avgActs 모두 null(소표본 마스킹)', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  for (const g of m.groups) {
    if (g.n < 5) {
      assert.equal(g.avgScore, null, `${g.key} n=${g.n}<5 인데 avgScore 마스킹 안됨`);
      assert.equal(g.avgActs, null, `${g.key} n=${g.n}<5 인데 avgActs 마스킹 안됨`);
    }
  }
  // 시드상 neutral 은 n=2(<5) → 마스킹, positive/negative 는 n>=5 → 수치 노출 기대
  const neu = m.groups.find(g => g.key === 'neutral');
  assert.ok(neu.n < 5 && neu.avgScore === null, 'neutral 소표본 마스킹 확인');
});

test('MIRROR-3: avgScore 는 null 또는 0~100', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  for (const g of m.groups) {
    if (g.avgScore != null) {
      assert.ok(g.avgScore >= 0 && g.avgScore <= 100, `${g.key} avgScore=${g.avgScore} 범위밖`);
    }
    if (g.avgActs != null) {
      assert.ok(g.avgActs >= 0, `${g.key} avgActs=${g.avgActs} 음수`);
    }
  }
});

test('MIRROR-4: ★윤리(P6) — 함수 결과에 위험점수(score/grade/risk) 필드 부재', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  const json = JSON.stringify(m);
  assert.ok(!/"risk"/.test(json), 'risk 키 없음');
  assert.ok(!/"score"/.test(json), 'score(위험점수) 키 없음');
  assert.ok(!/"grade"/.test(json), 'grade(위험등급) 키 없음');
  assert.ok(!/위험/.test(json), '"위험" 어휘 없음');
});

test('MIRROR-5: coaching 문자열 존재 · note 고정 · totalDays 정수', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  assert.ok(typeof m.coaching === 'string' && m.coaching.length > 0, 'coaching 문자열');
  assert.equal(m.note, '감정 기록이 있는 날만 비교했어요. 이건 경향일 뿐, 정답은 아니에요.');
  assert.ok(Number.isInteger(m.totalDays) && m.totalDays >= 0, `totalDays=${m.totalDays}`);
  // 시드 14일(감정 있는 날) 전부 최근 60일 내 → totalDays=14 기대
  assert.equal(m.totalDays, 14, '감정기록일수 = 시드 14일');
});

// ════════════════════════════════════════════════════════════════════════════
// [SHALLOW] B4 겉핥기 감지 — 콘텐츠별 median × 0.4 플래그 (교사 · 활용의 질)
//   불변식(스펙 §5-1): (a) ratio 는 0 이상 · (b) flag=true ⇔ ratio<0.4 & correct=true
//   (c) classId 격리(다른 반 학생 미포함) · (d) 표본<10 콘텐츠 개별 비노출(maskedContentCount)
//   (e) topStudents flagCount desc · severity 규칙(>=3 high / 1~2 medium).
//   시드: 합성 반(SH_CLASS)에 학생 2명 × 콘텐츠 1개(target content 90001)에 로그 12건
//         (median 안정 표본>=10). 1명은 빠르게(속도이상) 정답, 1명은 정상.
// ════════════════════════════════════════════════════════════════════════════
const SH_CLASS = 99201, SH_S1 = 99211, SH_S2 = 99212, SH_OTHER = 99213, SH_CONTENT = 90001;
{
  const insUser = db.prepare(`INSERT OR IGNORE INTO users (id, username, password, display_name, role)
                              VALUES (?, ?, 'x', ?, 'student')`);
  insUser.run(SH_S1, `sh1_${SH_S1}`, '겉핥기1');
  insUser.run(SH_S2, `sh2_${SH_S2}`, '겉핥기2');
  insUser.run(SH_OTHER, `shO_${SH_OTHER}`, '타반학생');
  // classes: code·name·owner_id 는 NOT NULL — 반드시 채운다(FK 부모).
  db.prepare(`INSERT OR IGNORE INTO classes (id, code, name, owner_id, status)
              VALUES (?, ?, '겉핥기반', ?, 'active')`)
    .run(SH_CLASS, `SHCLS${SH_CLASS}`, TEACHER);
  const insMem = db.prepare(`INSERT OR IGNORE INTO class_members (class_id, user_id, role, status)
                             VALUES (?, ?, 'member', 'active')`);
  insMem.run(SH_CLASS, SH_S1); insMem.run(SH_CLASS, SH_S2);
  // 교사 멤버(담임) — canViewClass 통과용
  db.prepare(`INSERT OR IGNORE INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`).run(SH_CLASS, TEACHER);
  // SH_OTHER 는 다른 반(멤버십 없음) → classId 격리 확인용
  const isoBackSh = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const insLog = db.prepare(`INSERT INTO learning_logs
    (user_id, activity_type, verb, target_type, target_id, duration_sec, result_success, created_at)
    VALUES (?, 'content', 'experienced', 'content', ?, ?, ?, ?)`);
  // 콘텐츠 90001 로그 12건: 정상 소요 60초 위주(median≈60). S1 은 10초(속도이상, 정답).
  //   S2 정상 55초 정답. 나머지는 median 안정용(정답=null 도 섞어 median 만 기여).
  for (let i = 0; i < 10; i++) insLog.run(SH_S2, SH_CONTENT, 60, (i % 2), isoBackSh(i + 1));
  insLog.run(SH_S1, SH_CONTENT, 10, 1, isoBackSh(2));   // 10 < 60*0.4=24 & 정답 → flag
  insLog.run(SH_S2, SH_CONTENT, 55, 1, isoBackSh(3));   // 55 > 24 → flag 아님
  // SH_OTHER(타반) — 같은 콘텐츠에 빠른 정답이지만 SH_CLASS 조회엔 안 나와야(격리)
  insLog.run(SH_OTHER, SH_CONTENT, 8, 1, isoBackSh(2));
  // 표본<10 콘텐츠(90002) — S1 3건 → 개별 비노출(maskedContentCount)
  for (let i = 0; i < 3; i++) insLog.run(SH_S1, 90002, 5, 1, isoBackSh(i + 1));

  // ── B4 확장(정오×속도): problem_attempts(채점형) 로 오답+시간 point 시드.
  //   그룹 임계=5(채점형). content 90003(achievement_code 有) 에 6건 → 노출.
  //   median≈50초 기준: 오답×느림(120), 오답×보통(50), 오답×빠름(10), 정답×보통(50) 등 6셀 커버.
  const SH_GCONTENT = 90003;
  db.prepare(`INSERT OR IGNORE INTO contents (id, title, content_type, achievement_code, status, creator_id)
              VALUES (?, '분수 나눗셈 문항 세트', 'quiz', '[6수01-05]', 'approved', ?)`)
    .run(SH_GCONTENT, TEACHER);
  const insPa = db.prepare(`INSERT INTO problem_attempts
    (user_id, content_id, node_id, is_correct, time_taken, source_type, submitted_at)
    VALUES (?, ?, NULL, ?, ?, 'content', ?)`);
  // 6건(표본>=5) — median(정렬 [10,40,50,50,60,120]) = 50.
  //   ratio: 10/50=0.2(fast) · 40/50=0.8(normal) · 50/50=1.0(normal) · 60/50=1.2(normal) · 120/50=2.4(slow)
  insPa.run(SH_S1, SH_GCONTENT, 0, 120, isoBackSh(2)); // 오답×느림 (ratio 2.4)
  insPa.run(SH_S1, SH_GCONTENT, 0, 50, isoBackSh(2));  // 오답×보통 (ratio 1.0)
  insPa.run(SH_S2, SH_GCONTENT, 0, 10, isoBackSh(3));  // 오답×빠름 (ratio 0.2)
  insPa.run(SH_S2, SH_GCONTENT, 1, 50, isoBackSh(3));  // 정답×보통 (ratio 1.0)
  insPa.run(SH_S1, SH_GCONTENT, 1, 40, isoBackSh(4));  // 정답×보통 (ratio 0.8)
  insPa.run(SH_S2, SH_GCONTENT, 1, 60, isoBackSh(4));  // 정답×보통 (ratio 1.2)
  // 타반 격리 확인용 — SH_OTHER 오답이지만 SH_CLASS 조회엔 안 나와야
  insPa.run(SH_OTHER, SH_GCONTENT, 0, 200, isoBackSh(2));
  // 시간 없는(time_taken NULL) 채점 로그 — 매트릭스 제외(시간 있는 것만)
  db.prepare(`INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, time_taken, source_type, submitted_at)
              VALUES (?, ?, NULL, 0, NULL, 'content', ?)`).run(SH_S1, SH_GCONTENT, isoBackSh(2));
}

test('SHALLOW-1: ratio>=0 · flag=true ⇔ ratio<0.4 & correct=true (불변식 a·b)', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  assert.ok(Array.isArray(r.points), 'points 배열');
  for (const p of r.points) {
    assert.ok(p.ratio >= 0, `ratio 음수 (${p.ratio})`);
    if (p.flag) {
      assert.ok(p.ratio < 0.4 && p.correct === true, `flag=true 인데 ratio=${p.ratio} correct=${p.correct}`);
    }
  }
});

test('SHALLOW-2: classId 격리 — 타반 학생(SH_OTHER) 미포함 (불변식 c)', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  assert.ok(!r.points.some(p => p.userId === SH_OTHER), '타반 학생이 결과에 섞임(격리 실패)');
  assert.ok(r.points.every(p => p.userId === SH_S1 || p.userId === SH_S2), '반 멤버만');
});

test('SHALLOW-3: 표본<10 콘텐츠 개별 비노출 → maskedContentCount (불변식 d)', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  assert.ok(r.maskedContentCount >= 1, `표본<10 콘텐츠(90002)가 masked 되어야 (${r.maskedContentCount})`);
  // 표본 적은 콘텐츠(90002)의 로그는 points 에 없어야
  assert.ok(!r.points.some(p => p.content === 'content 90002'), '표본<10 콘텐츠 로그가 points 에 노출됨');
});

test('SHALLOW-4: topStudents flagCount desc · severity 규칙 (불변식 e)', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  for (let i = 1; i < r.topStudents.length; i++) {
    assert.ok(r.topStudents[i - 1].flagCount >= r.topStudents[i].flagCount, 'flagCount 내림차순 아님');
  }
  for (const t of r.topStudents) {
    const exp = t.flagCount >= 3 ? 'high' : 'medium';
    assert.equal(t.severity, exp, `severity 규칙 위반 flagCount=${t.flagCount}`);
  }
  // 시드상 S1 이 속도이상 1건(정답 10초) → topStudents 에 존재
  assert.ok(r.topStudents.some(t => t.userId === SH_S1), 'S1 속도이상 감지 실패');
});

test('SHALLOW-5: 빈/희소 안전 — 로그 없는 반도 크래시 없이 빈 계약 반환', () => {
  const r = analytics.getShallowLearning(99999, { days: 30 });
  assert.equal(r.points.length, 0);
  assert.equal(r.topStudents.length, 0);
  assert.equal(r.medianThreshold, analytics.SPEED_FAST); // 0.5 로 갱신(속도버킷 임계)
  assert.ok(typeof r.disclaimer === 'string');
  // 빈 계약도 신규 필드 계약 유지(FE 안전).
  assert.deepEqual(r.matrix, { correct: { fast: 0, normal: 0, slow: 0 }, wrong: { fast: 0, normal: 0, slow: 0 } });
  assert.equal(r.hasWrongData, false);
  assert.deepEqual(r.wrongUnits, []);
  assert.ok(r.insights.length >= 1 && r.insights.length <= 2, 'insights 1~2개');
});

// ── B4 확장(정오×속도 매트릭스) 불변식 (기획서 §6) ─────────────────────────────
test('SHALLOW-6: matrix 6칸 합 == 매트릭스 대상 points 수 (불변식 §6-1)', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  const m = r.matrix;
  const sum = m.correct.fast + m.correct.normal + m.correct.slow
            + m.wrong.fast + m.wrong.normal + m.wrong.slow;
  assert.equal(sum, r.points.length, `matrix 합(${sum}) != points(${r.points.length})`);
});

test('SHALLOW-7: 모든 point 에 speed(fast/normal/slow) + correct(bool)', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  const S = new Set(['fast', 'normal', 'slow']);
  assert.ok(r.points.length > 0, '시드상 point 존재해야');
  for (const p of r.points) {
    assert.ok(S.has(p.speed), `speed=${p.speed} 미정의`);
    assert.equal(typeof p.correct, 'boolean', 'correct 는 boolean');
    // 매트릭스 배치와 speed 일치
    assert.equal(_speedBucketRef(p.ratio), p.speed, `ratio=${p.ratio} → speed 불일치(${p.speed})`);
  }
});

// 경계 정확 분류: ratio=0.5(→normal, fast 아님), 1.5(→normal, slow 아님), 그 바깥.
function _speedBucketRef(ratio) {
  if (ratio < 0.5) return 'fast';
  if (ratio > 1.5) return 'slow';
  return 'normal';
}
test('SHALLOW-8: 속도버킷 경계값(0.5·1.5) 정확 분류 (불변식 §6)', () => {
  assert.equal(analytics.speedBucket(0.49), 'fast');
  assert.equal(analytics.speedBucket(0.5), 'normal');  // 경계 = 보통(빠름 아님)
  assert.equal(analytics.speedBucket(1.5), 'normal');  // 경계 = 보통(느림 아님)
  assert.equal(analytics.speedBucket(1.51), 'slow');
  assert.equal(analytics.speedBucket(0), 'fast');
  assert.equal(analytics.speedBucket(3), 'slow');
});

test('SHALLOW-9: hasWrongData=true(시드 오답 有) & wrong 매트릭스 채워짐', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  assert.equal(r.hasWrongData, true, '시드에 problem_attempts 오답 있으므로 true');
  const wrongSum = r.matrix.wrong.fast + r.matrix.wrong.normal + r.matrix.wrong.slow;
  assert.ok(wrongSum >= 3, `오답 셀 합이 3 이상이어야 (${wrongSum})`);
  // problem_attempts(90003, median 50) 배치: 오답×느림 1(120·ratio2.4) · 오답×빠름 1(10·ratio0.2)
  //   · 오답×보통 1(50·ratio1.0). learning_logs(90001, median 60)의 (i%2)=0 시청로그 5건은
  //   60초(ratio1.0)라 wrong.normal 에 추가된다(시청 로그도 정오 소스 — 정직).
  //   → 느림/빠름 셀은 graded 단독이라 값이 안정적.
  assert.equal(r.matrix.wrong.slow, 1, '오답×느림 1명(graded 120초 단독)');
  assert.equal(r.matrix.wrong.fast, 1, '오답×빠름 1명(graded 10초 단독)');
  assert.ok(r.matrix.wrong.normal >= 1, `오답×보통 1명 이상 (${r.matrix.wrong.normal})`);
});

test('SHALLOW-10: hasWrongData=false 이면 wrong 매트릭스 전부 0 (불변식 §3-3)', () => {
  // 시청 로그(정답만)만 있는 반 = class 1 실 DB(오답+시간 채점 로그 희박) 또는 빈 반.
  const empty = analytics.getShallowLearning(99999, { days: 30 });
  assert.equal(empty.hasWrongData, false);
  assert.equal(empty.matrix.wrong.fast + empty.matrix.wrong.normal + empty.matrix.wrong.slow, 0);
  // 일반 규칙: 어느 반이든 hasWrongData=false ⇒ wrong.* 합 0.
  for (const cid of [SH_CLASS, CLASS, 99999]) {
    const r = analytics.getShallowLearning(cid, { days: 60 });
    if (r.hasWrongData === false) {
      const ws = r.matrix.wrong.fast + r.matrix.wrong.normal + r.matrix.wrong.slow;
      assert.equal(ws, 0, `class ${cid}: hasWrongData=false 인데 wrong 합=${ws}`);
    }
  }
});

test('SHALLOW-11: wrongUnits count desc 정렬 · 합 <= 오답 총수 · 코드/라벨 有', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  for (let i = 1; i < r.wrongUnits.length; i++) {
    assert.ok(r.wrongUnits[i - 1].count >= r.wrongUnits[i].count, 'wrongUnits count 내림차순 아님');
  }
  const wrongTotal = r.matrix.wrong.fast + r.matrix.wrong.normal + r.matrix.wrong.slow;
  const unitSum = r.wrongUnits.reduce((a, u) => a + u.count, 0);
  assert.ok(unitSum <= wrongTotal, `wrongUnits 합(${unitSum}) > 오답총수(${wrongTotal})`);
  for (const u of r.wrongUnits) {
    assert.ok(typeof u.code === 'string' && u.code.length, 'wrongUnit.code 문자열');
    assert.ok(typeof u.label === 'string' && u.label.length, 'wrongUnit.label 문자열');
    assert.ok(u.count >= 1, 'count>=1');
  }
  // 시드: 오답 3건 모두 [6수01-05] → wrongUnits[0].count=3.
  assert.ok(r.wrongUnits.length >= 1, '오답 단원 최소 1개');
  assert.equal(r.wrongUnits[0].count, 3, '몰린 단원 오답 3건');
});

test('SHALLOW-12: insights 1~2개 · 각 level 4종 중 하나 · text 문자열 (불변식 §6)', () => {
  const L = new Set(['danger', 'warn', 'info', 'good']);
  for (const cid of [SH_CLASS, CLASS, 99999]) {
    const r = analytics.getShallowLearning(cid, { days: 60 });
    assert.ok(r.insights.length >= 1 && r.insights.length <= 2, `class ${cid} insights=${r.insights.length}`);
    for (const it of r.insights) {
      assert.ok(L.has(it.level), `level=${it.level} 미정의`);
      assert.ok(typeof it.text === 'string' && it.text.length > 5, 'text 문자열');
      assert.ok(typeof it.icon === 'string' && it.icon.length, 'icon 있음');
    }
  }
  // 시드: 오답×느림 1명 → 최우선 danger insight 존재.
  const rSh = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  assert.equal(rSh.insights[0].level, 'danger', '오답×느림 있으면 첫 insight=danger');
});

test('SHALLOW-13: classId 격리 — 타반 오답(SH_OTHER) 매트릭스/wrongUnits 미반영', () => {
  const r = analytics.getShallowLearning(SH_CLASS, { days: 60 });
  // SH_OTHER 오답(200초, ratio 큼)이 포함됐다면 오답×느림이 2가 됨 → 1 이어야 격리 정상.
  assert.equal(r.matrix.wrong.slow, 1, '타반 오답이 매트릭스에 섞임(격리 실패)');
  assert.ok(!r.points.some(p => p.userId === SH_OTHER), '타반 학생 point 노출');
});

// ════════════════════════════════════════════════════════════════════════════
// [EMOENG] B6 정서-참여 교차 — getClassRiskList 신호 2축 → 4사분면 (교사)
//   불변식(스펙 §5-1): (a) x·y ∈ [0,100] · (b) quadrant ∈ {red,care,motive,stable}
//   (c) summary 합 == points.length · (d) 감정없음(hasEmotion=false) 은 red/care 제외
//   (e) score/grade/reasons 필드 부재(사분면 목적 최소필드).
//   실 DB class 1(멤버 있음) 로 검증.
// ════════════════════════════════════════════════════════════════════════════
test('EMOENG-1: x·y ∈ [0,100] · quadrant 4종만 (불변식 a·b)', () => {
  const r = analytics.getEmotionEngage(CLASS, { weeks: 2 });
  const Q = new Set(['red', 'care', 'motive', 'stable']);
  for (const p of r.points) {
    assert.ok(p.x >= 0 && p.x <= 100, `x=${p.x} 범위밖`);
    assert.ok(p.y >= 0 && p.y <= 100, `y=${p.y} 범위밖`);
    assert.ok(Q.has(p.quadrant), `quadrant=${p.quadrant} 미정의`);
  }
});

test('EMOENG-2: summary 합 == points.length (불변식 c)', () => {
  const r = analytics.getEmotionEngage(CLASS, { weeks: 2 });
  const sum = r.summary.red + r.summary.care + r.summary.motive + r.summary.stable;
  assert.equal(sum, r.points.length, 'summary 사분면 합이 points 수와 불일치');
});

test('EMOENG-3: 감정 기록 없는 학생은 red/care 사분면 제외 (불변식 d)', () => {
  const r = analytics.getEmotionEngage(CLASS, { weeks: 2 });
  for (const p of r.points) {
    if (p.hasEmotion === false) {
      assert.ok(p.quadrant !== 'red' && p.quadrant !== 'care',
        `감정없음 학생이 정서기반 사분면(${p.quadrant})에 배치됨`);
      assert.equal(p.y, 50, '감정없음 → y=50(중립) 이어야');
    }
  }
});

test('EMOENG-4: score/grade/reasons 필드 부재 (불변식 e, 사분면 최소필드)', () => {
  const r = analytics.getEmotionEngage(CLASS, { weeks: 2 });
  for (const p of r.points) {
    assert.equal(p.score, undefined, 'point 에 score 노출');
    assert.equal(p.grade, undefined, 'point 에 grade 노출');
    assert.equal(p.reasons, undefined, 'point 에 reasons 노출');
  }
});

test('EMOENG-5: 빈 반 안전 — 멤버 없는 반도 빈 계약 반환', () => {
  const r = analytics.getEmotionEngage(99999, { weeks: 2 });
  assert.equal(r.points.length, 0);
  assert.deepEqual(r.summary, { red: 0, care: 0, motive: 0, stable: 0 });
  assert.ok(typeof r.disclaimer === 'string');
});

// ════════════════════════════════════════════════════════════════════════════
// [NEXTSTEP] A4 다음 한 걸음 — 선수 미도달 열쇠노드 (학생 · 코칭)
//   불변식(스펙 §5-1): (a) keyNodes 우선순위 unlocksCount desc · (b) 평가부족(insufficient)
//   선수는 keyNodes(빨강) 아님 — keyNode.status 는 항상 not_reached · (c)/(d) N/A(학생 1인칭)
//   (e) 위험점수(score/grade/riskScore/reasons) 필드 부재(P6).
//   실 DB student1(uid=3, 미도달 성취 有) 로 검증.
// ════════════════════════════════════════════════════════════════════════════
test('NEXTSTEP-1: keyNodes 우선순위 unlocksCount desc (불변식 a)', () => {
  const r = analytics.getNextStep(STUDENT1, { limit: 3 });
  assert.ok(Array.isArray(r.keyNodes), 'keyNodes 배열');
  for (let i = 1; i < r.keyNodes.length; i++) {
    assert.ok(r.keyNodes[i - 1].unlocksCount >= r.keyNodes[i].unlocksCount, 'unlocksCount 내림차순 아님');
  }
  // unlocks 각 항목은 아직 안 열린 후속(not_reached/insufficient)만
  for (const k of r.keyNodes) {
    assert.ok(k.unlocksCount === k.unlocks.length, 'unlocksCount 와 unlocks 길이 불일치');
    for (const u of k.unlocks) {
      assert.ok(['not_reached', 'insufficient'].includes(u.status), `unlock status=${u.status} 부적절`);
      assert.notEqual(u.code, k.code, '자기 자신을 unlock(자기루프) 노출');
    }
  }
});

test('NEXTSTEP-2: 평가부족 선수는 keyNode 아님 — keyNode.status 항상 not_reached (불변식 b)', () => {
  const r = analytics.getNextStep(STUDENT1, { limit: 5 });
  for (const k of r.keyNodes) {
    assert.equal(k.status, 'not_reached', `열쇠노드 status=${k.status} (평가부족/도달이 빨강 열쇠로 오분류)`);
  }
});

test('NEXTSTEP-3: readyToChallenge 는 선수 전부 도달한 미도달 후속만', () => {
  const r = analytics.getNextStep(STUDENT1, { limit: 3 });
  for (const rc of r.readyToChallenge) {
    assert.equal(rc.status, 'not_reached', '도전 대상은 본인 미도달 후속');
    assert.equal(rc.prereqReached, true, 'prereqReached=true 여야');
    assert.ok(Array.isArray(rc.recommendations), 'recommendations 배열');
  }
});

test('NEXTSTEP-4: ★윤리(P6) — 응답에 위험점수(score/grade/riskScore/reasons) 필드 부재 (불변식 e)', () => {
  const r = analytics.getNextStep(STUDENT1, { limit: 3 });
  const json = JSON.stringify(r);
  assert.ok(!/"riskScore"/.test(json), 'riskScore 키 없음');
  assert.ok(!/"grade"/.test(json), 'grade(위험등급) 키 없음');
  assert.ok(!/"reasons"/.test(json), 'reasons(위험근거) 키 없음');
  assert.ok(!/위험/.test(json), '"위험" 어휘 없음');
  // status/label 은 학습 상태이므로 허용. "score" 는 위험점수 맥락에서 금지지만
  // 응답에 성취'점수' 필드를 두지 않으므로 score 키 자체가 없어야.
  assert.ok(!/"score"/.test(json), 'score(점수) 키 없음');
});

test('NEXTSTEP-5: 막힘 없는 학생 안전 — 빈 계약(keyNodes/readyToChallenge 빈) 반환', () => {
  // 성취 기록 자체가 없는 합성 학생 → 미도달 선수 없음 → 빈 결과, note 유지.
  const r = analytics.getNextStep(MIRROR_UID, { limit: 3 });
  assert.ok(Array.isArray(r.keyNodes) && Array.isArray(r.readyToChallenge));
  assert.equal(typeof r.note, 'string');
});

// ════════════════════════════════════════════════════════════════════════════
// [PERM] 권한·윤리 (HTTP 레벨)
// ════════════════════════════════════════════════════════════════════════════
const express = require('express');
const session = require('express-session');
let server, baseUrl;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/lrs', require('../routes/lrs'));
  return app;
}
function req(path, userId) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/lrs' + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: userId ? { 'x-test-user': String(userId) } : {} },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject); r.end();
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

function classNotMemberedByTeacher() {
  return db.prepare(`
    SELECT c.id FROM classes c
    WHERE c.status='active'
      AND c.id NOT IN (
        SELECT cm.class_id FROM class_members cm
        WHERE cm.user_id=? AND cm.status='active' AND cm.role IN ('owner','teacher','co_teacher')
      )
    ORDER BY c.id LIMIT 1
  `).get(TEACHER);
}

test('PERM-1: ews — 학생은 403(낙인 방지 P6), 소유 교사·관리자 200', async () => {
  const stu = await req(`/ews/class/${CLASS}`, STUDENT1);
  assert.equal(stu.status, 403, '학생의 ews 접근은 403 (위험군 비노출)');
  const tch = await req(`/ews/class/${CLASS}`, TEACHER);
  assert.equal(tch.status, 200, '소유 교사 200');
  assert.equal(tch.json.success, true);
  assert.ok(tch.json.risk && Array.isArray(tch.json.risk.list), 'risk.list 배열');
  assert.ok(tch.json.classTrend && tch.json.projection, '추세·외삽 포함');
  const adm = await req(`/ews/class/${CLASS}`, ADMIN);
  assert.equal(adm.status, 200, '관리자 200');
});

test('PERM-2: ews — 비멤버 교사는 남의 반 403', async () => {
  const foreign = classNotMemberedByTeacher();
  assert.ok(foreign, '비멤버 active 클래스 필요');
  const r = await req(`/ews/class/${foreign.id}`, TEACHER);
  assert.equal(r.status, 403, `비멤버 교사 ews 는 403 (현재 ${r.status})`);
});

test('PERM-3: trend/student — 본인 200, 타 학생 403, 교사/관리자 200', async () => {
  const own = await req(`/trend/student/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200, '본인 추이 200');
  assert.equal(own.json.success, true);
  const other = await req(`/trend/student/${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '타 학생 추이 403');
  const byT = await req(`/trend/student/${STUDENT1}`, TEACHER);
  assert.equal(byT.status, 200, '교사 200');
});

test('PERM-4: ★윤리 — 학생 trend 응답에 위험점수/위험등급 등 어떤 위험 필드도 없음(P6)', async () => {
  const own = await req(`/trend/student/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200);
  const json = JSON.stringify(own.json);
  // 위험 관련 키/한글 어휘가 응답에 절대 없어야
  assert.ok(!/"risk"/.test(json), 'risk 키 없음');
  assert.ok(!/"score"/.test(json), 'score(위험점수) 키 없음');
  assert.ok(!/"grade"/.test(json) || /gradeKo/.test(json) === false, 'grade(위험등급) 키 없음');
  assert.ok(!/위험/.test(json), '"위험" 어휘 없음');
  // 추세·도달예상은 있어야(긍정 프레임)
  assert.ok(own.json.trend && own.json.projection, 'trend·projection 은 포함');
});

test('PERM-4b: emotion-mirror — 본인 200, 타 학생 403, 교사 200, 응답에 위험필드 없음(P6)', async () => {
  const own = await req(`/emotion-mirror/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200, '본인 마음-공부 거울 200');
  assert.equal(own.json.success, true);
  assert.ok(Array.isArray(own.json.groups) && own.json.groups.length === 3, 'groups 3개');
  assert.ok(typeof own.json.coaching === 'string', 'coaching 문자열');
  const j = JSON.stringify(own.json);
  assert.ok(!/"risk"|"score"|"grade"|위험/.test(j), '학생 응답에 위험 필드/어휘 없음(P6)');

  const other = await req(`/emotion-mirror/${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '타 학생 거울 403');

  const byT = await req(`/emotion-mirror/${STUDENT1}`, TEACHER);
  assert.equal(byT.status, 200, '교사 200');
});

test('PERM-5: trend/class — 소유 교사 200, 비멤버 교사 403', async () => {
  const ok = await req(`/trend/class/${CLASS}`, TEACHER);
  assert.equal(ok.status, 200);
  const foreign = classNotMemberedByTeacher();
  const no = await req(`/trend/class/${foreign.id}`, TEACHER);
  assert.equal(no.status, 403, '비멤버 교사 trend/class 403');
});

test('PERM-6: weak-trend — 교사 scope=class 200, 학생 비교사 → scope=all 거부(403)', async () => {
  const tch = await req(`/weak-trend?scope=class`, TEACHER);
  assert.equal(tch.status, 200, '교사 class 200');
  assert.ok(Array.isArray(tch.json.ranking), 'ranking 배열');
  const adm = await req(`/weak-trend?scope=all`, ADMIN);
  assert.equal(adm.status, 200, '관리자 all 200');
  // 학생이 class scope 요청 → 권한 미달 403
  const stu = await req(`/weak-trend?scope=class`, STUDENT1);
  assert.equal(stu.status, 403, '학생 weak-trend(class) 403');
});

test('PERM-7: shallow/class — 소유 교사 200, 비멤버 교사 403, 학생 403', async () => {
  const ok = await req(`/shallow/class/${CLASS}`, TEACHER);
  assert.equal(ok.status, 200, '소유 교사 200');
  assert.equal(ok.json.success, true);
  assert.ok(Array.isArray(ok.json.points), 'points 배열');
  assert.equal(ok.json.medianThreshold, 0.5, 'medianThreshold=SPEED_FAST(0.5)');
  // 신규 계약 필드 라우트 통과 확인(FE 소비 계약).
  assert.ok(ok.json.matrix && ok.json.matrix.correct && ok.json.matrix.wrong, 'matrix 6칸');
  assert.equal(typeof ok.json.hasWrongData, 'boolean', 'hasWrongData bool');
  assert.ok(Array.isArray(ok.json.wrongUnits), 'wrongUnits 배열');
  assert.ok(Array.isArray(ok.json.insights) && ok.json.insights.length >= 1, 'insights 1+');
  const foreign = classNotMemberedByTeacher();
  const no = await req(`/shallow/class/${foreign.id}`, TEACHER);
  assert.equal(no.status, 403, '비멤버 교사 403');
  const stu = await req(`/shallow/class/${CLASS}`, STUDENT1);
  assert.equal(stu.status, 403, '학생 403');
});

test('PERM-8: emotion-engage/class — 소유 교사 200(실명+audit), 비멤버 403, 학생 403', async () => {
  // audit 적재 전 governance 로그 수(담임 실명 열람 후 +1 기대)
  const before = db.prepare(
    "SELECT COUNT(*) c FROM learning_logs WHERE activity_type='governance' AND object_id='emotion-engage' AND user_id=?"
  ).get(TEACHER).c;

  const ok = await req(`/emotion-engage/class/${CLASS}`, TEACHER);
  assert.equal(ok.status, 200, '소유 교사 200');
  assert.equal(ok.json.success, true);
  assert.equal(ok.json.masked, false, '담임 → 실명(masked=false)');
  const sum = ok.json.summary.red + ok.json.summary.care + ok.json.summary.motive + ok.json.summary.stable;
  assert.equal(sum, ok.json.points.length, 'summary 합 == points 수');

  // 담임 실명 열람 → governance audit 1건 적재(points>0 일 때)
  if (ok.json.points.length > 0) {
    const after = db.prepare(
      "SELECT COUNT(*) c FROM learning_logs WHERE activity_type='governance' AND object_id='emotion-engage' AND user_id=?"
    ).get(TEACHER).c;
    assert.ok(after > before, `실명 열람 audit 미적재 (before=${before}, after=${after})`);
  }

  const foreign = classNotMemberedByTeacher();
  const no = await req(`/emotion-engage/class/${foreign.id}`, TEACHER);
  assert.equal(no.status, 403, '비멤버 교사 403');
  const stu = await req(`/emotion-engage/class/${CLASS}`, STUDENT1);
  assert.equal(stu.status, 403, '학생 403');
});

test('PERM-9: next-step — 본인 200, 타 학생 403, 교사 200, 응답에 위험필드 없음(P6)', async () => {
  const own = await req(`/next-step/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200, '본인 200');
  assert.equal(own.json.success, true);
  assert.ok(Array.isArray(own.json.keyNodes) && Array.isArray(own.json.readyToChallenge), 'keyNodes/readyToChallenge 배열');
  const j = JSON.stringify(own.json);
  assert.ok(!/"riskScore"|"grade"|"reasons"|위험/.test(j), '학생 응답에 위험 필드/어휘 없음(P6)');

  const other = await req(`/next-step/${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '타 학생 403');
  const byT = await req(`/next-step/${STUDENT1}`, TEACHER);
  assert.equal(byT.status, 200, '교사 200');
});

// ════════════════════════════════════════════════════════════════════════════
// [MEMB] /stats/custom 멤버십 집계 — self-learn class_id NULL 도 소속 학생이면 포착
// ════════════════════════════════════════════════════════════════════════════
test('MEMB-1: /stats/custom?scope=class — 교사가 우리 반 학생 self-learn 집계 포착(class_id NULL 해소)', async () => {
  // 실측: class 1 멤버 학생의 self-learn 로그 수(멤버십 기준 기대치)
  const memberIds = analytics.classStudentIds(CLASS);
  const ph = memberIds.map(() => '?').join(',');
  const expected = db.prepare(
    `SELECT COUNT(*) c FROM learning_logs WHERE source_service='self-learn' AND user_id IN (${ph})`
  ).all ? db.prepare(`SELECT COUNT(*) c FROM learning_logs WHERE source_service='self-learn' AND user_id IN (${ph})`).get(...memberIds).c : 0;

  const res = await req(`/stats/custom?scope=class`, TEACHER);
  assert.equal(res.status, 200);
  // 멤버십 기반이면 class_id NULL self-learn 도 포착 → 멤버에 self-learn 로그가 있으면 recommendedCount>0
  if (expected > 0) {
    assert.ok(res.json.summary.recommendedCount > 0,
      `멤버십 집계인데 recommendedCount=0 (기대 ${expected}) — class_id NULL 누락(§C-5 미적용)`);
  }
  // 멤버십 합과 일치(소유 반이 class 1 뿐이 아닐 수 있으므로 >= 비교 대신 동치는 owner 반 합 기준)
});

test('MEMB-2: /stats/custom 회귀 — scope=mine 은 본인만, scope=all 은 admin 전체', async () => {
  const mine = await req(`/stats/custom?scope=mine`, STUDENT1);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.scope, 'mine');
  const all = await req(`/stats/custom?scope=all`, ADMIN);
  assert.equal(all.status, 200);
  assert.equal(all.json.scope, 'all');
  // mine 의 recommendedCount 는 본인 self-learn 수와 일치
  const ownCount = db.prepare(
    "SELECT COUNT(*) c FROM learning_logs WHERE source_service='self-learn' AND user_id=?"
  ).get(STUDENT1).c;
  assert.equal(mine.json.summary.recommendedCount, ownCount, 'mine 집계 정합');
});
