// db/lrs-analytics.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 분석·예측 P0 — 온더플라이(신규 테이블 0). 기존 데이터만으로 정당한 신호.
//   기획서: 작업지시서/LRS_분석예측_강화_기획서.md
//     §B-1 위험점수 · §B-2 추세(OLS) · §B-3 도달예측 · §B-4 선수개념 갭 · §B-5 신뢰규약
//
// 설계 원칙(반드시):
//   P1 가짜 ML 금지 — 추세 기울기·간이 OLS·임계 위험점수·갭 전파만. 근거 항상 노출.
//   P2 소표본 정직성 — 관측주차<3 미산출, evaluated<3 신뢰 낮음, R²<0.3 변동 큼.
//   P4 단일 분류기 — 모든 도달 판정은 lrs-mastery.classifyStatus(4상태)만.
//   P5 평가부족 ≠ 미도달 — insufficient 는 위험 가산 금지(s_mastery 분모·분자 제외).
//   P6 낙인 방지 — 위험점수는 교사/관리자 전용(라우트에서 게이트). 본 모듈은 산출만.
//   C-5 멤버십 집계 — 반 단위는 class_members.user_id 조인 기준.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./index');
const { ols } = require('../lib/analytics/regression');
const {
  classifyStatus, reachRate, STATUS, resolveCode, recommendForCode,
} = require('./lrs-mastery');

// ── 신뢰도 라벨 공통(§B-5) ───────────────────────────────────────────────────
const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
const CONFIDENCE_KO = { high: '높음', medium: '보통', low: '낮음' };

// 추세 산출 최소 관측주차(§B-2). 주별 최소 시도(노이즈 배제).
const MIN_WEEKS = 3;       // 관측주차 < 3 → 추세 미산출
const MIN_WEEK_ATTEMPTS = 3; // 한 주 시도 < 3 → 그 주 결측
const DEFAULT_WEEKS = 8;   // 기본 관측 창(최근 N주)

// 감정 부정 어휘(§B-1 s_emotion). attendance.emotion 텍스트 기준.
//   (실 DB 의 emotion_score 는 대부분 NULL → 어휘 분류가 1차, score 는 있을 때만 폴백)
const NEGATIVE_EMOTIONS = new Set(['angry', 'anxious', 'sad', 'frustrated', 'tired', 'bad']);

// 위험 가중치(§B-1, 합=1). 감정 신호 없으면 w_emotion=0 후 나머지 비례 재정규화.
const RISK_WEIGHTS = { mastery: 0.40, decline: 0.30, engage: 0.20, emotion: 0.10 };

// 위험 등급 경계(§B-1): 높음 ≥70 · 보통 40~69 · 낮음 <40
const RISK_GRADE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
const RISK_GRADE_KO = { high: '높음', medium: '보통', low: '낮음' };
function riskGrade(score) {
  if (score >= 70) return RISK_GRADE.HIGH;
  if (score >= 40) return RISK_GRADE.MEDIUM;
  return RISK_GRADE.LOW;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

// 성취기준 코드 정규화 — 괄호 유/무 혼재('[2수01-01]' vs '9수01-01') 비교용.
//   lrs-mastery.resolveCode 의 정규화 규칙(괄호 부착)과 동일. 비교는 항상 정규형으로.
function normCode(code) {
  const t = String(code || '').trim();
  if (!t) return '';
  if (t.startsWith('[') && t.endsWith(']')) return t;
  return `[${t}]`;
}

// ── 교과 코드 별칭 정규화(정합 결함 fix) ─────────────────────────────────────
//   learning_logs.subject_code 에 정본(-e, 예 'math-e')과 레거시 대문자(예 'MAT','SCI')가
//   같은 교과인데 중복 존재한다. 셀렉터·필터에서 레거시를 정본으로 접어 병합한다.
//   canonicalSubject('MAT')='math-e', canonicalSubject('math-e')='math-e'(불변).
//   ★ 정본 -e 코드는 그대로. 대문자 레거시만 정본으로 매핑. 미지 코드는 원형 유지(정직성).
const SUBJECT_ALIAS = {
  KOR: 'korean-e', MAT: 'math-e', MATH: 'math-e', ENG: 'english-e',
  SCI: 'science-e', SOC: 'social-e', MUS: 'music-e', MOR: 'moral-e', ART: 'art-e',
};
function canonicalSubject(code) {
  if (code == null) return code;
  return SUBJECT_ALIAS[String(code).toUpperCase()] || code;
}
// canonical → 그 canonical 로 매핑되는 모든 원본 코드(자신 + 별칭들). 필터 IN 확장용.
//   예: subjectAliases('math-e') = ['math-e','MAT','MATH']. 미지 코드는 [자기 자신].
function subjectAliases(canonical) {
  const set = new Set([canonical]);
  for (const [alias, canon] of Object.entries(SUBJECT_ALIAS)) {
    if (canon === canonical) set.add(alias);
  }
  return Array.from(set);
}

// ── 멤버십 조인: 반의 student 멤버 id (C-5 표준) ──────────────────────────────
function classStudentIds(classId) {
  try {
    return db.prepare(`
      SELECT cm.user_id AS id
      FROM class_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = ? AND u.role = 'student'
    `).all(classId).map(r => r.id);
  } catch (_) { return []; }
}

function classStudents(classId) {
  try {
    return db.prepare(`
      SELECT cm.user_id AS id, COALESCE(u.display_name, u.username) AS name
      FROM class_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = ? AND u.role = 'student'
    `).all(classId).map(r => ({ id: r.id, name: r.name || `학생${r.id}` }));
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// §B-2. 주차별 정답률 시계열을 learning_logs 에서 재구성(스냅샷 불요).
//   주차 = strftime('%Y-%W') (ISO 유사 주). 한 주 시도<3 은 결측(노이즈 배제).
//   반환 weeks: [{ week, attempts, success, rate }] (rate 0~100, 시도순)
//   withContributors(P1-3 학급 비교, 스펙 §4-2): true 면 주별 기여 인원수
//     COUNT(DISTINCT user_id) AS contributors 1컬럼을 추가로 산출한다(익명 인원수만 —
//     개별 학생 값·명단 없음). false(기본)면 기존 반환 형태 완전 불변(회귀 0).
// ─────────────────────────────────────────────────────────────────────────────
function _weeklyRateSeries({ userIds, code, subject, weeksLimit, withContributors = false }) {
  if (!userIds || !userIds.length) return [];
  const ph = userIds.map(() => '?').join(',');
  // [P1 추이 과다 게이트 fix] achievement_code IS NOT NULL 은 '특정 성취기준(code)' 추세일 때만 요구한다.
  //   전체(overall) 추세는 성취기준 태그가 없는 정오답 로그도 포함해야 한다.
  //   (실측: uid3 는 23·24주 정오답 로그에 achievement_code 가 없어 이 조건 때문에 25주 1점만 남아
  //    추세선이 영영 안 떴다.) code 필터가 있을 때만 achievement_code 조건을 건다.
  //
  //   [교과별 분리] subject(learning_logs.subject_code) 필터를 code 필터와 동일 패턴으로 추가한다.
  //   subject 없으면(=전체 교과) SQL 완전 불변 → 기존 전체 추세 동작 100% 유지(회귀 0).
  //   ★ 지표의 정체는 그대로 "주간 정답률"(SUM(result_success=1)/COUNT(*)) — 성취기준 도달 비율 아님.
  //     교과별로 쪼개면 subject_code 있는 로그만 잡히므로(전체는 NULL 포함) 관측 주차가 줄어들 수 있다
  //     (일부 교과는 관측 주차<3 → status='insufficient' 가 정상 — 억지로 채우지 않음).
  let sql = `
    SELECT strftime('%Y-%W', created_at) AS week,
           COUNT(*) AS attempts,
           SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) AS success${withContributors ? `,
           COUNT(DISTINCT user_id) AS contributors` : ''}
    FROM learning_logs
    WHERE user_id IN (${ph})
      AND result_success IS NOT NULL`;
  const params = [...userIds];
  if (code) { sql += ' AND achievement_code = ?'; params.push(code); }
  if (subject) {
    // [교과 별칭 병합] subject 는 canonical(정본) 코드. 그 canonical 로 접히는 레거시 별칭까지
    //   subject_code IN (...) 로 함께 잡아 병합된 데이터 전체를 추세에 반영한다.
    //   (예: 'math-e' 선택 → IN ('math-e','MAT','MATH').) 미지 코드는 [자기 자신] → 단일 필터.
    const aliases = subjectAliases(canonicalSubject(subject));
    const sph = aliases.map(() => '?').join(',');
    sql += ` AND subject_code IN (${sph})`;
    params.push(...aliases);
  }
  sql += ' GROUP BY week ORDER BY week ASC';

  let rows;
  try { rows = db.prepare(sql).all(...params); } catch (_) { return []; }

  // 한 주 최소 시도 게이트 완화(P1): 기존 3건 필터는 sparse 주(1~2건)를 결측 처리해
  //   관측 주가 과소 산출됐다. 이제 SPARSE 주도 관측 포인트로 포함한다(시각화 목적).
  //   ★ slope/예측(projection)의 신뢰성은 computeTrend 가 관측주<3 시 status='insufficient' 로
  //     별도 게이트하므로, 여기서는 포인트를 살려 series 를 실측대로 채운다.
  //   여전히 완전 결측(0건)만 제외.
  let weeks = rows
    .filter(r => (Number(r.attempts) || 0) >= 1)
    .map(r => {
      const a = Number(r.attempts) || 0;
      const s = Number(r.success) || 0;
      const row = { week: r.week, attempts: a, success: s, rate: a > 0 ? (s / a) * 100 : null };
      if (withContributors) row.contributors = Number(r.contributors) || 0;
      return row;
    })
    .filter(w => w.rate != null);

  // 최근 N주만(시간순 정렬 유지)
  const lim = weeksLimit || DEFAULT_WEEKS;
  if (weeks.length > lim) weeks = weeks.slice(weeks.length - lim);
  return weeks;
}

// 추세 신뢰도(관측주차 + R²) → 라벨
function _trendConfidence(nW, r2) {
  if (nW < MIN_WEEKS) return CONFIDENCE.LOW;
  if (nW >= 6 && r2 >= 0.3) return CONFIDENCE.HIGH;
  return CONFIDENCE.MEDIUM;
}

// slope → 방향 분류(§B-2): ≥+2 상승 / -2<x<+2 정체 / ≤-2 하락
function _classifyTrend(slope) {
  if (slope >= 2) return 'up';
  if (slope <= -2) return 'down';
  return 'flat';
}
const TREND_KO = { up: '상승', flat: '정체', down: '하락', insufficient: '데이터 부족' };

// ─────────────────────────────────────────────────────────────────────────────
// §B-2. 추세 산출 — 학생/반/성취기준 공통.
//   computeTrend({ userId | classId | userIds, code?, weeks? }) →
//     { status: 'ok'|'insufficient', slope, r2, direction, directionKo,
//       confidence, confidenceKo, observedWeeks, currentRate, series[] }
//   관측주차 < 3 → status='insufficient'(미산출). slope/r2 는 참고용으로만.
// ─────────────────────────────────────────────────────────────────────────────
function computeTrend({ userId, classId, userIds, code = null, weeks = DEFAULT_WEEKS, subject = null } = {}) {
  let ids = userIds;
  if (!ids) {
    if (userId != null) ids = [userId];
    else if (classId != null) ids = classStudentIds(classId);
    else ids = [];
  }
  // subject(=learning_logs.subject_code) 전달. null/생략 시 교과 필터 없음(전체 추세, 회귀 0).
  const series = _weeklyRateSeries({ userIds: ids, code, subject, weeksLimit: weeks });
  const nW = series.length;
  const currentRate = nW > 0 ? round1(series[nW - 1].rate) : null;

  if (nW < MIN_WEEKS) {
    return {
      status: 'insufficient',
      reason: '관측 주차 부족(최소 3주)',
      slope: null, r2: null,
      direction: 'insufficient', directionKo: TREND_KO.insufficient,
      confidence: CONFIDENCE.LOW, confidenceKo: CONFIDENCE_KO.low,
      observedWeeks: nW, currentRate,
      // 선(line)은 관측 2점이면 그릴 수 있다(P1). 예측·기울기만 3주 게이트.
      //   status='insufficient' 여도 series 를 실측대로 채워 FE 가 canDrawLine 로 꺾은선을 그리게 한다.
      canDrawLine: nW >= 2,
      series: series.map((w, i) => ({ week: w.week, x: i, rate: round1(w.rate), attempts: w.attempts })),
    };
  }

  // x = 주 인덱스(0..n-1), y = 정답률
  const pts = series.map((w, i) => ({ x: i, y: w.rate }));
  const model = ols(pts);
  const slope = round1(model.slope);          // %p / 주
  const r2 = Math.round(model.r2 * 100) / 100;
  const direction = _classifyTrend(model.slope);
  const conf = _trendConfidence(nW, model.r2);

  return {
    status: 'ok',
    slope, r2,
    direction, directionKo: TREND_KO[direction],
    confidence: conf, confidenceKo: CONFIDENCE_KO[conf],
    observedWeeks: nW,
    currentRate,
    lowVariance: model.r2 < 0.3,   // R²<0.3 → "변동 큼" 단서(§B-5)
    canDrawLine: nW >= 2,          // 관측 2점 이상이면 꺾은선 가능(항상 참, ok 는 nW>=3).
    series: series.map((w, i) => ({ week: w.week, x: i, rate: round1(w.rate), attempts: w.attempts })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 교과별 도달 예상 셀렉터 — 이 반 학생들의 learning_logs 에서 관측된 교과 목록.
//   classSubjects(classId) → [{ code, label, count }] (count desc)
//     · learning_logs.subject_code NOT NULL & result_success NOT NULL 인 로그만(정답률 산출 대상).
//     · ★ 교과 별칭 병합(정합 결함 fix): distinct subject_code 를 canonical(정본 -e)로 접어
//       GROUP BY 병합 → 카운트 합산. 결과에 레거시 코드 단독 엔트리 0(예 'MAT'/'SCI' 소멸).
//       수학=math-e+MAT+MATH, 과학=science-e+SCI … 처럼 하나로.
//     · label 은 canonical 의 subjects.name(예 math-e→"수학"). 조인 실패 시 canonical code 폴백.
//     · '전체 교과'({code:'all'})는 여기서 넣지 않는다 — 라우트가 맨 앞에 prepend.
//   ★ 정직성: 교과별로 쪼개면 subject_code 태그된 로그만 잡히므로 count 가 적은 교과는
//     주차<3 → status='insufficient' 가 정상. 억지로 채우지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
function classSubjects(classId) {
  const ids = classStudentIds(classId);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  let rows;
  try {
    rows = db.prepare(`
      SELECT ll.subject_code AS code, COUNT(*) AS count
      FROM learning_logs ll
      WHERE ll.user_id IN (${ph})
        AND ll.subject_code IS NOT NULL
        AND ll.result_success IS NOT NULL
      GROUP BY ll.subject_code
    `).all(...ids);
  } catch (_) { return []; }

  // canonical 로 접어 카운트 합산(레거시→정본 병합).
  const merged = new Map(); // canonicalCode -> count
  for (const r of rows) {
    const canon = canonicalSubject(r.code);
    merged.set(canon, (merged.get(canon) || 0) + (Number(r.count) || 0));
  }

  // canonical → 한글 라벨(subjects.name). 조인 실패(미지 코드)면 canonical code 폴백.
  const out = [];
  for (const [canon, count] of merged.entries()) {
    let label = null;
    try {
      const srow = db.prepare('SELECT name FROM subjects WHERE code = ?').get(canon);
      if (srow && srow.name && String(srow.name).trim() !== '') label = String(srow.name);
    } catch (_) { /* subjects 없으면 폴백 */ }
    out.push({ code: canon, label: label || canon, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §B-3. 도달 예측 — 현재 도달률 + 기울기 외삽 + 불확실성 밴드.
//   projectReach(trend, { target=80 }) →
//     { reachable, weeksToReach, projectedRate, band:{lo,hi}, message, confidence }
//   slope<=0 → reachable=false("현 추세로 도달 어려움"). 단일 확정선 금지(밴드 동반).
// ─────────────────────────────────────────────────────────────────────────────
function projectReach(trend, { target = 80 } = {}) {
  if (!trend || trend.status !== 'ok' || trend.currentRate == null) {
    // 문구 정직성(감사 §3·§7): insufficient 는 "덜 풀어서"가 아니라 "관측 주차(시간)가 3주 미만"이라
    //   추세선을 아직 못 그리는 상태다. currentRate 는 이미 있는데 "더 풀면"이라 하면 오해를 준다.
    //   → 시간(주차) 어휘로 교정. 현재 도달률이 있으면 그 값을 함께 안내.
    const nW = trend && trend.observedWeeks != null ? trend.observedWeeks : 0;
    const rateHint = (trend && trend.currentRate != null)
      ? ` 지금 도달률은 약 ${Math.round(trend.currentRate)}%예요.` : '';
    return {
      status: 'insufficient',
      reachable: null, weeksToReach: null,
      observedWeeks: nW,
      message: `아직 3주치 학습 기록이 안 모여서 추세선을 그릴 수 없어요(현재 ${nW}주).${rateHint} 시간이 지나면 표시돼요.`,
      confidence: CONFIDENCE.LOW, confidenceKo: CONFIDENCE_KO.low,
    };
  }
  const r0 = trend.currentRate;
  const slope = trend.slope || 0;
  const conf = trend.confidence;

  // 이미 목표 도달
  if (r0 >= target) {
    return {
      status: 'ok', reachable: true, weeksToReach: 0,
      projectedRate: r0, target,
      band: null,
      message: `이미 ${target}% 도달 수준이에요. 이대로 꾸준히!`,
      confidence: conf, confidenceKo: CONFIDENCE_KO[conf],
    };
  }

  if (slope <= 0) {
    return {
      status: 'ok', reachable: false, weeksToReach: null,
      projectedRate: r0, target, slope,
      band: null,
      message: '현재 추세로는 목표 도달이 어려워요 — 보충 학습을 권장해요.',
      confidence: conf, confidenceKo: CONFIDENCE_KO[conf],
    };
  }

  const rawWeeks = (target - r0) / slope;
  const weeksToReach = Math.ceil(rawWeeks);
  // 불확실성 밴드(§B-3): ±max(8%p, |slope|×2). 예상선 위아래 점선 밴드.
  const bandWidth = Math.max(8, Math.abs(slope) * 2);
  // 합리성 게이트: 20주 초과면 "현재 속도로는 시간이 걸림"
  const reachable = weeksToReach <= 20;
  const projectedRate = round1(Math.min(100, r0 + slope * Math.min(weeksToReach, 20)));

  return {
    status: 'ok',
    reachable,
    weeksToReach: reachable ? weeksToReach : null,
    projectedRate,
    target, slope,
    band: { lo: round1(Math.max(0, projectedRate - bandWidth)), hi: round1(Math.min(100, projectedRate + bandWidth)) },
    message: reachable
      ? `이 속도면 약 ${weeksToReach}주 후 ${target}% 도달이 예상돼요${conf === CONFIDENCE.LOW ? ' (표본이 적어 대략적 추정)' : ''}.`
      : '조금 더 꾸준히 풀면 목표에 가까워져요.',
    confidence: conf, confidenceKo: CONFIDENCE_KO[conf],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §B-3b. 도달 예측 "분석 멘트"(insights[]) — projectReach 결과를 규칙 기반 문안으로.
//   전체 LRS 공통 lrs-insight 컴포넌트가 소비(FE 문안 하드코딩 금지 — 문안은 BE 소유).
//   관점: "이 반 전체 학생 평균 성취 도달률"이 목표(target%)에 언제 닿을지.
//   톤: 단정 금지·행동 유도(초등 담임 이해). 최대 2개(정보 과부하 차단).
//   → [{ level:'good|warn|info', icon, text }]
function projectionInsights(trend, projection, target = 80, subjectLabel = null) {
  const out = [];
  const p = projection || {};
  const t = trend || {};
  const r0 = (t.currentRate != null) ? Math.round(t.currentRate) : null;
  // 교과 스코프 접두어(선택). '전체 교과'/미지정이면 접두어 없음(기존 문안 그대로).
  //   ★ 문안 하드코딩·단정 금지 원칙 유지 — 자연스러운 라벨만 덧댄다("이 교과는 …").
  const isSubjectScope = subjectLabel != null
    && String(subjectLabel).trim() !== '' && String(subjectLabel).trim() !== '전체 교과';
  const subj = isSubjectScope ? `${String(subjectLabel).trim()} 정답률` : '반 평균 도달률';
  const subjShort = isSubjectScope ? `${String(subjectLabel).trim()}은(는)` : '반 평균이';

  // (1) 자료 부족 — 추세선을 아직 못 그림(관측 주차 < 3)
  if (!t || t.status !== 'ok' || p.status === 'insufficient') {
    const nW = (t && t.observedWeeks != null) ? t.observedWeeks : 0;
    const scopeHint = isSubjectScope ? `이 교과는 아직 학습 기록이 적어요. ` : '';
    out.push({ level: 'info', icon: '🔵',
      text: `${scopeHint}아직 추세를 그릴 자료가 부족해요(현재 ${nW}주). 학습이 3주 이상 쌓이면 목표 도달 예측이 표시돼요.` });
    return out;
  }
  // (2) 이미 목표 도달 수준
  if (p.weeksToReach === 0 || (r0 != null && r0 >= target)) {
    out.push({ level: 'good', icon: '🟢',
      text: `이미 ${subjShort} 목표 ${target}% 수준이에요. 지금 흐름을 유지하면 좋아요.` });
    return out;
  }
  // (3) 상승세 없음 — 현 추세로는 도달 어려움
  if (!p.reachable || p.slope == null || p.slope <= 0) {
    out.push({ level: 'warn', icon: '🟠',
      text: `최근 ${subj}이 오르지 않고 있어요${r0 != null ? `(현재 약 ${r0}%)` : ''}. 반이 어려워하는 성취기준을 함께 보충하면 흐름을 되돌릴 수 있어요.` });
    return out;
  }
  // (4) 도달 가능 — 남은 주(週)에 따라 톤 분기
  const wk = p.weeksToReach;
  if (wk <= 6) {
    out.push({ level: 'good', icon: '🟢',
      text: `지금 상승 속도면 약 ${wk}주 후 목표 ${target}%에 닿을 전망이에요. 이대로 꾸준히 가면 좋아요.` });
  } else {
    out.push({ level: 'info', icon: '🔵',
      text: `목표 ${target}%까지는 약 ${wk}주가 걸릴 전망이에요. 상승세는 있으니 꾸준함이 관건이에요.` });
  }
  // (5) 저신뢰(관측 짧음) 보조 멘트
  if (t.confidence === CONFIDENCE.LOW) {
    out.push({ level: 'info', icon: '🔵',
      text: `관측 기간이 짧아(${t.observedWeeks || 0}주) 예측 폭이 넓어요. 참고용으로만 봐 주세요.` });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §B-1. 위험점수(0~100) — 4신호 가중합. 학생별 근거·신뢰 동반.
//   getClassRiskList(classId, students?) →
//     { classId, list:[{ userId, name, score, grade, gradeKo, signals{}, reasons[],
//                          confidence, confidenceKo, observedWeeks, evaluated }], summary{} }
//   insufficient 비가산(P5). 감정 없으면 w_emotion 재정규화. evaluated<3 신뢰 낮음.
// ─────────────────────────────────────────────────────────────────────────────

// 학생별 성취 도달 분포(insufficient 분리) — lrs_achievement_stats 기준(단일 분류기).
function _masteryCounts(userIds) {
  const byUser = new Map();
  if (!userIds.length) return byUser;
  const ph = userIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT user_id, attempt_count AS attempts, success_count AS correct, avg_score
    FROM lrs_achievement_stats WHERE user_id IN (${ph})
  `).all(...userIds);
  for (const r of rows) {
    const attempts = Number(r.attempts) || 0;
    const correct = Number(r.correct) || 0;
    const rate = reachRate(correct, attempts, r.avg_score);
    const status = classifyStatus(attempts, rate);
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { reached: 0, partial: 0, notReached: 0, insufficient: 0, evaluated: 0 });
    const c = byUser.get(r.user_id);
    if (status === STATUS.REACHED) { c.reached++; c.evaluated++; }
    else if (status === STATUS.PARTIAL) { c.partial++; c.evaluated++; }
    else if (status === STATUS.NOT_REACHED) { c.notReached++; c.evaluated++; }
    else c.insufficient++;
  }
  return byUser;
}

// 학생별 최근 활동 공백일 + 최근 4주 활동량 기울기 (lrs_user_daily).
function _engagement(userIds) {
  const byUser = new Map();
  if (!userIds.length) return byUser;
  const ph = userIds.map(() => '?').join(',');
  // 마지막 활동일 + 최근 일별 활동(주차 집계용)
  const lastRows = db.prepare(`
    SELECT user_id, MAX(stat_date) AS last_date
    FROM lrs_user_daily WHERE user_id IN (${ph}) GROUP BY user_id
  `).all(...userIds);
  const lastMap = new Map(lastRows.map(r => [r.user_id, r.last_date]));

  // 최근 4주(28일) 주차별 활동건수 — 활동량 기울기
  const wkRows = db.prepare(`
    SELECT user_id, strftime('%Y-%W', stat_date) AS week, SUM(activity_count) AS cnt
    FROM lrs_user_daily
    WHERE user_id IN (${ph}) AND stat_date >= date('now','-28 days')
    GROUP BY user_id, week ORDER BY user_id, week ASC
  `).all(...userIds);
  const wkByUser = new Map();
  for (const r of wkRows) {
    if (!wkByUser.has(r.user_id)) wkByUser.set(r.user_id, []);
    wkByUser.get(r.user_id).push(Number(r.cnt) || 0);
  }

  for (const uid of userIds) {
    const last = lastMap.get(uid) || null;
    let gapDays = null;
    if (last) {
      const d = db.prepare("SELECT CAST((julianday('now') - julianday(?)) AS INTEGER) AS g").get(last).g;
      gapDays = Math.max(0, Number(d) || 0);
    } else {
      gapDays = null; // 활동 기록 자체가 없음 → 별도 처리(데이터 없음)
    }
    const wk = wkByUser.get(uid) || [];
    let wkSlope = 0;
    if (wk.length >= 2) {
      const m = ols(wk.map((y, i) => ({ x: i, y })));
      wkSlope = m.slope;
    }
    byUser.set(uid, { gapDays, lastDate: last, weeklySlope: wkSlope });
  }
  return byUser;
}

// 학생별 최근 N회 감정 부정 비율 (attendance). 없으면 null(가중 재정규화 트리거).
function _emotionNeg(userIds, recent = 10) {
  const byUser = new Map();
  if (!userIds.length) return byUser;
  for (const uid of userIds) {
    let rows;
    try {
      rows = db.prepare(`
        SELECT emotion, emotion_score FROM attendance
        WHERE user_id = ? AND (emotion IS NOT NULL OR emotion_score IS NOT NULL)
        ORDER BY attendance_date DESC LIMIT ?
      `).all(uid, recent);
    } catch (_) { rows = []; }
    if (!rows.length) { byUser.set(uid, { neg: null, count: 0 }); continue; }
    let negSum = 0, n = 0;
    for (const r of rows) {
      n++;
      if (r.emotion_score != null && Number.isFinite(Number(r.emotion_score))) {
        // score 1~3 가정: (3 - score)/3 → 부정도 0~1 (낮을수록 부정)
        const sc = Math.max(1, Math.min(3, Number(r.emotion_score)));
        negSum += (3 - sc) / 2; // 1→1, 2→0.5, 3→0
      } else if (r.emotion) {
        negSum += NEGATIVE_EMOTIONS.has(String(r.emotion).toLowerCase()) ? 1 : 0;
      }
    }
    byUser.set(uid, { neg: n > 0 ? negSum / n : null, count: n });
  }
  return byUser;
}

function getClassRiskList(classId, studentsArg) {
  const students = (studentsArg && studentsArg.length) ? studentsArg : classStudents(classId);
  const ids = students.map(s => s.id);
  const nameById = new Map(students.map(s => [s.id, s.name]));

  if (!ids.length) {
    return { classId: Number(classId), list: [], summary: { high: 0, medium: 0, low: 0, total: 0 } };
  }

  const mc = _masteryCounts(ids);
  const eng = _engagement(ids);
  const emo = _emotionNeg(ids);

  const list = [];
  for (const uid of ids) {
    const m = mc.get(uid) || { reached: 0, partial: 0, notReached: 0, insufficient: 0, evaluated: 0 };
    const e = eng.get(uid) || { gapDays: null, lastDate: null, weeklySlope: 0 };
    const em = emo.get(uid) || { neg: null, count: 0 };

    // 학생별 성취 추세(최근 N주) — s_decline 용
    const trend = computeTrend({ userId: uid });
    const slopeRate = trend.status === 'ok' ? trend.slope : null;

    // ── s_mastery: 평가된 것 중 미도달 비율 (insufficient 제외 — P5)
    const s_mastery = m.evaluated > 0 ? clamp01(m.notReached / m.evaluated) : 0;

    // ── s_decline: 주당 -20%p 하락이면 1.0 (slope 음수일 때만 가산)
    const s_decline = (slopeRate != null && slopeRate < 0) ? clamp01(-slopeRate / 20) : 0;

    // ── s_engage: 최근 공백일(7일부터 가산, 21일+=1.0) + 활동량 기울기 음수면 +0.2
    let s_engage = 0;
    if (e.gapDays != null) {
      s_engage = clamp01((e.gapDays - 7) / 14);
      if (e.weeklySlope < 0) s_engage = clamp01(s_engage + 0.2);
    }

    // ── s_emotion: 부정 비율 (없으면 null → 가중 재정규화)
    const hasEmotion = em.neg != null;
    const s_emotion = hasEmotion ? clamp01(em.neg) : 0;

    // 가중치 재정규화(감정 없으면 w_emotion=0 후 나머지 비례)
    let w = { ...RISK_WEIGHTS };
    if (!hasEmotion) {
      const remain = w.mastery + w.decline + w.engage;
      w = {
        mastery: w.mastery / remain,
        decline: w.decline / remain,
        engage: w.engage / remain,
        emotion: 0,
      };
    }

    const raw = w.mastery * s_mastery + w.decline * s_decline + w.engage * s_engage + w.emotion * s_emotion;
    const score = Math.round(clamp01(raw) * 100);
    const grade = riskGrade(score);

    // ── 근거 배열(§B-1 근거 노출) — 기여 큰 신호 위주
    const reasons = [];
    if (s_mastery > 0 && m.evaluated > 0) {
      reasons.push({ type: 'mastery', weight: w.mastery * s_mastery, text: `미도달 ${m.notReached}/${m.evaluated}개` });
    }
    if (s_decline > 0 && slopeRate != null) {
      reasons.push({ type: 'decline', weight: w.decline * s_decline, text: `최근 ${trend.observedWeeks}주 정답률 ${slopeRate}%p/주` });
    }
    if (s_engage > 0 && e.gapDays != null) {
      reasons.push({ type: 'engage', weight: w.engage * s_engage, text: `${e.gapDays}일 무활동` });
    }
    if (hasEmotion && s_emotion > 0) {
      reasons.push({ type: 'emotion', weight: w.emotion * s_emotion, text: `최근 감정 부정 비율 ${Math.round(s_emotion * 100)}%` });
    }
    reasons.sort((a, b) => b.weight - a.weight);

    // insufficient 압도 단서(평가부족이 많고 평가된 게 거의 없음)
    const totalStd = m.reached + m.partial + m.notReached + m.insufficient;
    if (m.evaluated < 3 && m.insufficient > 0) {
      reasons.push({ type: 'insufficient', weight: 0, text: `아직 충분히 풀지 않음(평가부족 ${m.insufficient}/${totalStd})` });
    }

    // 신뢰도: 평가된 성취기준 3개 미만이면 낮음(§B-5). 추세 신뢰 합산.
    let confidence;
    if (m.evaluated < 3) confidence = CONFIDENCE.LOW;
    else if (m.evaluated >= 8 && trend.confidence !== CONFIDENCE.LOW) confidence = CONFIDENCE.HIGH;
    else confidence = CONFIDENCE.MEDIUM;

    list.push({
      userId: uid,
      name: nameById.get(uid) || `학생${uid}`,
      score, grade, gradeKo: RISK_GRADE_KO[grade],
      signals: {
        s_mastery: round1(s_mastery * 100) / 100 != null ? Math.round(s_mastery * 1000) / 1000 : 0,
        s_decline: Math.round(s_decline * 1000) / 1000,
        s_engage: Math.round(s_engage * 1000) / 1000,
        s_emotion: hasEmotion ? Math.round(s_emotion * 1000) / 1000 : null,
      },
      reasons: reasons.slice(0, 3),
      confidence, confidenceKo: CONFIDENCE_KO[confidence],
      observedWeeks: trend.observedWeeks,
      evaluated: m.evaluated,
      trendDirection: trend.status === 'ok' ? trend.direction : 'insufficient',
      trendSlope: slopeRate,
    });
  }

  // 위험순 정렬(점수 내림차순, 동점이면 미도달 많은 순)
  list.sort((a, b) => (b.score - a.score) || (b.evaluated - a.evaluated));

  const summary = { high: 0, medium: 0, low: 0, total: list.length };
  for (const r of list) summary[r.grade]++;

  return { classId: Number(classId), list, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// §B-4. 선수개념 갭 — learning_map_edges(prerequisite) + 노드↔code 브리지.
//   브리지: edge node_id (E2MATA01B01C01D01 = std_id 류) → curriculum_std_id_map.std_id
//           → standard_code(achievement_code). 매핑 불가 노드는 보수적으로 제외(P4).
//   getPrereqGap(classId, { targetCodes? }) →
//     { classId, edgesLoaded, bridged, gaps:[{ targetCode, targetLabel,
//          blockedStudents:[{userId,name, missingPrereqs:[code...]}] }] }
//   대상 단원(targetCodes) 미지정 시: 반 학생의 미도달 선수를 가진 후속 코드 전체.
// ─────────────────────────────────────────────────────────────────────────────
let _bridgeCache = null; // 노드ID -> achievement_code
function _buildBridge() {
  const m = new Map();
  // 1차: learning_map_nodes.node_id → achievement_code (직접 귀속, 실 데이터 1차 출처).
  //   엣지 노드ID(E2MATA01B01C01D01, D접미 포함)는 이 테이블에서 [2수01-01] 등 코드로 매핑됨.
  try {
    for (const r of db.prepare(
      'SELECT node_id, achievement_code FROM learning_map_nodes WHERE achievement_code IS NOT NULL'
    ).all()) {
      if (r.node_id && r.achievement_code && !m.has(r.node_id)) m.set(r.node_id, r.achievement_code);
    }
  } catch (_) { /* 테이블 없으면 std_id 폴백 */ }
  // 2차 폴백: curriculum_std_id_map.std_id → standard_code (노드ID가 std_id 형식인 경우).
  try {
    for (const r of db.prepare('SELECT standard_code, std_id FROM curriculum_std_id_map WHERE std_id IS NOT NULL').all()) {
      if (r.std_id && r.standard_code && !m.has(r.std_id)) m.set(r.std_id, r.standard_code);
    }
  } catch (_) { /* 둘 다 없으면 빈 브리지(보수적 — 억지 매핑 금지) */ }
  return m;
}
function _bridge() { if (!_bridgeCache) _bridgeCache = _buildBridge(); return _bridgeCache; }
function invalidateBridge() { _bridgeCache = null; }

// node_id → achievement_code(정규형). 매핑 불가 → null(보수적 제외, 억지 매핑 금지).
function _nodeToCode(nodeId) {
  const b = _bridge();
  if (b.has(nodeId)) return normCode(b.get(nodeId));
  return null;
}

function getPrereqGap(classId, { targetCodes = null } = {}) {
  const students = classStudents(classId);
  const ids = students.map(s => s.id);
  const nameById = new Map(students.map(s => [s.id, s.name]));

  // 1) prerequisite 엣지 로드 + 노드↔code 브리지
  let edges;
  try { edges = db.prepare("SELECT from_node_id, to_node_id FROM learning_map_edges WHERE edge_type='prerequisite'").all(); }
  catch (_) { edges = []; }
  const edgesLoaded = edges.length;

  // to_code → [from_code...] (후속 → 직접 선수들). 깊이 1단계 우선(§B-4).
  const prereqOf = new Map();
  let bridged = 0;
  for (const e of edges) {
    const fromCode = _nodeToCode(e.from_node_id);
    const toCode = _nodeToCode(e.to_node_id);
    if (!fromCode || !toCode) continue; // 브리지 실패 → 제외(보수적)
    bridged++;
    if (!prereqOf.has(toCode)) prereqOf.set(toCode, new Set());
    prereqOf.get(toCode).add(fromCode);
  }

  if (!ids.length || prereqOf.size === 0) {
    return { classId: Number(classId), edgesLoaded, bridged, gaps: [] };
  }

  // 2) 학생별 미도달(not_reached) 성취기준 집합 (insufficient 는 "막힘" 아님 — 선수 미확인)
  const ph = ids.map(() => '?').join(',');
  const masteryRows = db.prepare(`
    SELECT user_id, achievement_code AS code, attempt_count AS attempts, success_count AS correct, avg_score
    FROM lrs_achievement_stats WHERE user_id IN (${ph}) AND achievement_code IS NOT NULL
  `).all(...ids);
  const notReachedByUser = new Map(); // user -> Set(code)
  for (const r of masteryRows) {
    const rate = reachRate(Number(r.correct) || 0, Number(r.attempts) || 0, r.avg_score);
    const status = classifyStatus(Number(r.attempts) || 0, rate);
    if (status === STATUS.NOT_REACHED) {
      if (!notReachedByUser.has(r.user_id)) notReachedByUser.set(r.user_id, new Set());
      notReachedByUser.get(r.user_id).add(normCode(r.code)); // 정규형으로 저장(브리지 코드와 동일 비교)
    }
  }

  // 3) 대상 후속 코드 집합 결정
  let targets;
  if (targetCodes && targetCodes.length) {
    targets = targetCodes.filter(c => prereqOf.has(c));
  } else {
    targets = Array.from(prereqOf.keys());
  }

  // 4) 각 후속 코드 Y 에 대해: 선수 X 가 미도달인 학생을 "막힐 위험"으로 표시
  const gaps = [];
  for (const toCode of targets) {
    const prereqs = prereqOf.get(toCode);
    if (!prereqs) continue;
    const blocked = [];
    for (const uid of ids) {
      const nr = notReachedByUser.get(uid);
      if (!nr) continue;
      const missing = [];
      for (const pc of prereqs) if (nr.has(pc)) missing.push(pc);
      if (missing.length) {
        blocked.push({
          userId: uid, name: nameById.get(uid) || `학생${uid}`,
          missingPrereqs: missing.map(c => ({ code: c, label: resolveCode(c).label })),
        });
      }
    }
    if (blocked.length) {
      gaps.push({
        targetCode: toCode,
        targetLabel: resolveCode(toCode).label,
        prereqCount: prereqs.size,
        blockedCount: blocked.length,
        blockedStudents: blocked,
      });
    }
  }
  // 막힌 학생 많은 순
  gaps.sort((a, b) => b.blockedCount - a.blockedCount);

  return { classId: Number(classId), edgesLoaded, bridged, gaps };
}

// ─────────────────────────────────────────────────────────────────────────────
// A-WEAK 보조: 취약 성취기준 추세 랭킹 (관리자 scope=all / 교사 scope=class).
//   getWeakTrend({ userIds, weeks, limit }) →
//     [{ code, label, subject, reachedRate, evaluated, slope, direction, confidence }]
//   도달률 낮고 하락 중인 성취기준 우선. n<10(평가 학생수) 은 라우트에서 마스킹.
// ─────────────────────────────────────────────────────────────────────────────
function getWeakTrend({ userIds, weeks = DEFAULT_WEEKS, limit = 15 } = {}) {
  if (!userIds || !userIds.length) return [];
  const ph = userIds.map(() => '?').join(',');
  // 성취기준별 현재 도달 분포(단일 분류기)
  const rows = db.prepare(`
    SELECT achievement_code AS code, user_id,
           attempt_count AS attempts, success_count AS correct, avg_score
    FROM lrs_achievement_stats
    WHERE user_id IN (${ph}) AND achievement_code IS NOT NULL
  `).all(...userIds);

  const agg = new Map(); // code -> {reached, evaluated, evaluatedUsers:Set}
  for (const r of rows) {
    const rate = reachRate(Number(r.correct) || 0, Number(r.attempts) || 0, r.avg_score);
    const status = classifyStatus(Number(r.attempts) || 0, rate);
    if (!agg.has(r.code)) agg.set(r.code, { reached: 0, evaluated: 0, users: new Set() });
    const a = agg.get(r.code);
    if (status !== STATUS.INSUFFICIENT) {
      a.evaluated++;
      a.users.add(r.user_id);
      if (status === STATUS.REACHED) a.reached++;
    }
  }

  const out = [];
  for (const [code, a] of agg.entries()) {
    if (a.evaluated === 0) continue;
    const reachedRate = round1((a.reached / a.evaluated) * 100);
    // 성취기준 추세(반/전체 집단의 주차별 정답률)
    const trend = computeTrend({ userIds, code, weeks });
    const ctx = resolveCode(code);
    out.push({
      code, label: ctx.label, subject: ctx.subject_label || null,
      reachedRate, evaluated: a.evaluated, evaluatedStudents: a.users.size,
      slope: trend.status === 'ok' ? trend.slope : null,
      direction: trend.status === 'ok' ? trend.direction : 'insufficient',
      directionKo: trend.status === 'ok' ? TREND_KO[trend.direction] : TREND_KO.insufficient,
      confidence: trend.confidence, confidenceKo: trend.confidenceKo,
      observedWeeks: trend.observedWeeks,
    });
  }

  // 취약 우선: (도달률 낮음) → (하락 추세) 가중. 도달률 오름차, 동률이면 slope 오름차.
  out.sort((x, y) => {
    if (x.reachedRate !== y.reachedRate) return x.reachedRate - y.reachedRate;
    const xs = x.slope == null ? 0 : x.slope;
    const ys = y.slope == null ? 0 : y.slope;
    return xs - ys;
  });

  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// A6 "마음-공부 거울" (학생 · 정서×성취/활동량) — 온더플라이(신규 테이블 0).
//   스펙: 작업지시서/LRS_P0_시각데이터스펙_v1.md §카드1(③④⑤⑧)
//   attendance(감정 있는 날) LEFT JOIN lrs_user_daily(같은 날짜) → 3그룹 평균 비교.
//     그룹 라벨: emotion_score 있으면 >=2.5 긍정 / 1.5~2.5 중립 / <1.5 부정 (1~3 스케일)
//               없으면 emotion 텍스트: NEGATIVE_EMOTIONS.has → 부정 / neutral류 → 중립 / 그 외 → 긍정
//   ★ 학생용 — 위험점수·EWS 필드 절대 미포함(P6 낙인 방지, 자기이해 프레임).
//   ★ 소표본 마스킹 — 그룹 n<5 면 avgScore/avgActs 를 null 로 마스킹(groups 는 항상 3개).
//   getEmotionMirror(userId, { days=60 }) →
//     { groups:[positive,neutral,negative], coaching, note, totalDays }
// ─────────────────────────────────────────────────────────────────────────────
const EMOTION_GROUP_META = {
  positive: { key: 'positive', label: '긍정 감정', emoji: '😀' },
  neutral:  { key: 'neutral',  label: '중립',      emoji: '😐' },
  negative: { key: 'negative', label: '부정 감정', emoji: '😢' },
};
// 중립 어휘(스펙 §카드1-③ "neutral/ok/soso/보통"류). 그 외 비부정은 긍정으로 분류.
const NEUTRAL_EMOTIONS = new Set(['neutral', 'ok', 'soso', 'so-so', 'normal', '보통']);
const A6_MIN_GROUP_N = 5; // 그룹 n<5 → 수치 마스킹(null)

// 감정 라벨링: emotion_score(1~3) 우선, 없으면 emotion 텍스트.
function _emotionGroupKey(emotion, emotionScore) {
  if (emotionScore != null && Number.isFinite(Number(emotionScore))) {
    const sc = Number(emotionScore);
    if (sc >= 2.5) return 'positive';
    if (sc >= 1.5) return 'neutral';
    return 'negative';
  }
  const t = String(emotion || '').trim().toLowerCase();
  if (!t) return null; // 감정 정보 없음(레코드 자체가 감정없음이면 SQL 에서 제외됨)
  if (NEGATIVE_EMOTIONS.has(t)) return 'negative';
  if (NEUTRAL_EMOTIONS.has(t)) return 'neutral';
  return 'positive';
}

function getEmotionMirror(userId, { days = 60 } = {}) {
  const d = Math.max(1, Math.min(180, Number(days) || 60));
  const emptyGroups = () =>
    ['positive', 'neutral', 'negative'].map(k => ({
      ...EMOTION_GROUP_META[k], n: 0, avgScore: null, avgActs: null,
    }));

  let rows;
  try {
    rows = db.prepare(`
      SELECT a.attendance_date AS d,
             a.emotion         AS emotion,
             a.emotion_score   AS escore,
             ud.avg_score      AS avg_score,
             ud.activity_count AS acts
      FROM attendance a
      LEFT JOIN lrs_user_daily ud
             ON ud.user_id = a.user_id AND ud.stat_date = a.attendance_date
      WHERE a.user_id = ?
        AND (a.emotion IS NOT NULL OR a.emotion_score IS NOT NULL)
        AND a.attendance_date >= date('now', ?)
      ORDER BY a.attendance_date ASC
    `).all(userId, `-${d} days`);
  } catch (_) { rows = []; }

  // 날짜 중복 방어: 같은 날 감정 기록이 여러 건이면 하루 1건으로(최신 우선 — ORDER ASC 라 마지막이 최신).
  const byDate = new Map();
  for (const r of rows) byDate.set(r.d, r);

  // 그룹 누적
  const acc = {
    positive: { n: 0, scoreSum: 0, scoreN: 0, actSum: 0, actN: 0 },
    neutral:  { n: 0, scoreSum: 0, scoreN: 0, actSum: 0, actN: 0 },
    negative: { n: 0, scoreSum: 0, scoreN: 0, actSum: 0, actN: 0 },
  };
  let totalDays = 0;
  for (const r of byDate.values()) {
    const key = _emotionGroupKey(r.emotion, r.escore);
    if (!key) continue;
    totalDays++;
    const a = acc[key];
    a.n++;
    // avg_score 없는 날은 점수 평균 분모에서 제외(평가부족 계승 §카드1-⑤).
    if (r.avg_score != null && Number.isFinite(Number(r.avg_score))) {
      a.scoreSum += Number(r.avg_score); a.scoreN++;
    }
    // activity_count: LEFT JOIN 이라 null 가능 → 0 으로 간주(활동 없음).
    const actVal = (r.acts != null && Number.isFinite(Number(r.acts))) ? Number(r.acts) : 0;
    a.actSum += actVal; a.actN++;
  }

  const groups = ['positive', 'neutral', 'negative'].map(k => {
    const a = acc[k];
    const masked = a.n < A6_MIN_GROUP_N; // 소표본 → 수치 마스킹
    return {
      ...EMOTION_GROUP_META[k],
      n: a.n,
      avgScore: (masked || a.scoreN === 0) ? null : round1(a.scoreSum / a.scoreN),
      avgActs:  (masked || a.actN === 0)   ? null : round1(a.actSum / a.actN),
    };
  });

  return {
    groups,
    totalDays,
    coaching: _emotionCoaching(groups),
    note: '감정 기록이 있는 날만 비교했어요. 이건 경향일 뿐, 정답은 아니에요.',
  };
}

// 코칭 문구 규칙(§카드1-⑧, 비낙인·관찰형). 마스킹으로 수치가 없으면 안전 폴백.
function _emotionCoaching(groups) {
  const pos = groups.find(g => g.key === 'positive');
  const neg = groups.find(g => g.key === 'negative');
  const posScore = pos ? pos.avgScore : null;
  const negScore = neg ? neg.avgScore : null;
  const negActs = neg ? neg.avgActs : null;

  // 규칙1: 힘든 날 점수가 좋았던 날의 -5 이상 → 회복탄력 칭찬.
  if (posScore != null && negScore != null && negScore >= posScore - 5) {
    return '힘든 날에도 꾸준히 공부한 날이 있었어요. 잘하고 있어요.';
  }
  // 규칙2: 힘든 날에도 활동이 있었으면 → 꾸준함 칭찬.
  if (negActs != null && negActs > 0) {
    return '힘든 날에도 꾸준히 공부한 날이 있었어요. 잘하고 있어요.';
  }
  // 규칙3: 좋았던 날 점수가 가장 높으면 → 컨디션 인식.
  if (posScore != null && negScore != null && posScore > negScore) {
    return '기분 좋은 날 집중이 잘 되는 경향이 보여요.';
  }
  // 규칙4: 3그룹 모두 안정적(점수 편차 작음) → 리듬 칭찬.
  const scores = groups.map(g => g.avgScore).filter(v => v != null);
  if (scores.length >= 2) {
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread <= 5) return '요즘 마음도 공부도 안정적이에요. 이 리듬 좋아요.';
  }
  // 폴백(수치 부족/소표본): 항상 1개는 내려간다.
  return '이건 경향일 뿐이에요 — 어떤 날이든 네 노력은 소중해요.';
}

// ─────────────────────────────────────────────────────────────────────────────
// B4 "풀이 속도-정확도 점검"(구 겉핥기 감지 · 교사) — 온더플라이(신규 테이블 0).
//   스펙: 보고서/LRS_학습질_정오속도_분석_재설계_기획서_v1.md (§0·§2·§4·§6)
//
//   개념: 정답/오답 × 빠름/보통/느림(속도) 2×3 매트릭스로 "학습의 질"을 점검.
//     - 반 학생들의 같은 콘텐츠/문항 median(소요시간) 기준으로 각 풀이의 ratio(=dur/med) 산출.
//     - ratio<0.5 빠름 / 0.5~1.5 보통 / >1.5 느림 (3버킷).
//
//   ★ 데이터원 확장(정오축을 실제로 채우는 핵심):
//     (A) learning_logs: 콘텐츠 시청·채점형 로그(result_success 0/1, duration_sec>0).
//         현실상 오답이 거의 없음(대부분 정답 시청 로그).
//     (B) problem_attempts: 문항 채점 로그(is_correct 0/1, time_taken>0). 오답+시간 유.
//     두 소스를 콘텐츠 그룹으로 union → 정답/오답 point 를 모두 포함.
//   ★ 소요시간(duration/time_taken)이 있는 채점 로그만 매트릭스 대상(시간 없는 건 제외).
//   ★ 표본<임계 콘텐츠 그룹은 median 불안정 → 개별 비노출(maskedContentCount).
//     - 시청 로그(learning_logs): 임계 10 (기존 유지, 대량이라 안정).
//     - 채점 로그(problem_attempts): 임계 5 (응시 인원이 반 인원 수준으로 적어 완화 — §6-1).
//
//   getShallowLearning(classId, { days=30 }) →
//     { classId, days, studentCount,
//       points[]( +correct +speed ), topStudents[], maskedContentCount,
//       medianThreshold, disclaimer,
//       matrix{correct:{fast,normal,slow}, wrong:{fast,normal,slow}},
//       wrongUnits[]{code,label,count}, hasWrongData, insights[]{level,icon,text} }
// ─────────────────────────────────────────────────────────────────────────────
const SHALLOW_MIN_CONTENT_SAMPLE = 10; // 시청 로그 그룹 로그수<10 → median 불안정(비노출)
const SHALLOW_MIN_GRADED_SAMPLE = 5;   // 채점 로그 그룹 로그수<5 → 비노출(응시 인원 적음, §6-1)
const SHALLOW_RATIO = 0.4;             // (하위호환) duration < median*0.4 → 기존 "속도이상" 플래그
const SPEED_FAST = 0.5;                // ratio < 0.5 → 빠름 (§2-1)
const SPEED_SLOW = 1.5;                // ratio > 1.5 → 느림 (그 사이 = 보통)

// ratio → 속도 버킷. 경계: ratio<0.5 fast / 0.5~1.5 normal / >1.5 slow.
function _speedBucket(ratio) {
  if (ratio < SPEED_FAST) return 'fast';
  if (ratio > SPEED_SLOW) return 'slow';
  return 'normal';
}

// 배열 중앙값(정렬 후). 이상치 방어(평균 아님). 빈 배열 → null.
function _median(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 콘텐츠 라벨: contents.title 우선(target_id 매칭), 없으면 성취기준 라벨/코드 폴백.
function _contentLabel(targetType, targetId, achievementCode, titleCache) {
  const key = `${targetType}:${targetId}`;
  if (titleCache.has(key)) return titleCache.get(key);
  let label = null;
  if (targetType === 'content' && targetId != null) {
    try {
      const row = db.prepare('SELECT title FROM contents WHERE id = ?').get(Number(targetId));
      if (row && row.title) label = row.title;
    } catch (_) { /* contents 없으면 폴백 */ }
  }
  if (!label && achievementCode) {
    try { label = resolveCode(achievementCode).label; } catch (_) { label = null; }
  }
  if (!label) label = `${targetType} ${targetId}`;
  titleCache.set(key, label);
  return label;
}

// 빈 매트릭스(카운트 0). correct/wrong × fast/normal/slow.
function _emptyMatrix() {
  return {
    correct: { fast: 0, normal: 0, slow: 0 },
    wrong: { fast: 0, normal: 0, slow: 0 },
  };
}

// §4-1 규칙표 → insights[]. point 배열(정오·speed·achievementCode 포함)로 학급 수준 자동 해석.
//   우선순위 1~5, 상위 2개만(폴백 good 1개 항상 보장). 각 {level,icon,text}.
//   단정 금지 톤 — "찍었을 가능성/확인 권유"(낙인 X).
function _buildShallowInsights(matrix, wrongUnits, studentCount) {
  const out = [];
  const m = matrix;
  const wrongTotal = m.wrong.fast + m.wrong.normal + m.wrong.slow;

  // 1) 오답 × 느림 ≥ 1 → 위험(개념 결손 의심)
  if (m.wrong.slow >= 1) {
    out.push({
      level: 'danger', icon: '🔴',
      text: `오래 고민하고도 틀린 학생이 ${m.wrong.slow}명 있어요. 개념 결손이 의심돼요 — 개별 지도를 우선해 주세요.`,
    });
  }
  // 2) 오답 총합 ≥ 3 또는 특정 단원 오답 ≥ 2 → 주의(단원 몰림)
  const topUnit = wrongUnits && wrongUnits.length ? wrongUnits[0] : null;
  if (wrongTotal >= 3 || (topUnit && topUnit.count >= 2)) {
    const unitLabel = topUnit ? topUnit.label : '일부 단원';
    out.push({
      level: 'danger', icon: '🔴',
      text: `오답이 특정 단원(${unitLabel})에 몰려 있어요. 그 단원 보충을 배정해 보세요.`,
    });
  }
  // 3) 정답 × 빠름 ≥ max(3, 반인원 20%) → 점검(찍기 가능성)
  const fastThreshold = Math.max(3, Math.ceil((Number(studentCount) || 0) * 0.2));
  if (m.correct.fast >= fastThreshold) {
    out.push({
      level: 'warn', icon: '🟠',
      text: `정답을 아주 빨리 처리한 학생이 ${m.correct.fast}명이에요. 찍었을 가능성이 있어, 개념을 한 번 확인해 보면 좋아요.`,
    });
  }
  // 4) 정답 × 느림 ≥ 3 → 참고(유창성)
  if (m.correct.slow >= 3) {
    out.push({
      level: 'info', icon: '🔵',
      text: `맞히긴 했지만 시간이 오래 걸린 학생이 ${m.correct.slow}명이에요. 반복 연습으로 유창성을 키워 주세요.`,
    });
  }

  // 최대 2개만(위험도 순으로 이미 push). 폴백: 하나도 없으면 긍정 1개.
  const top = out.slice(0, 2);
  if (!top.length) {
    top.push({
      level: 'good', icon: '🟢',
      text: '대부분 정상 속도로 정답을 맞히고 있어요. 지금 리듬이 좋아요 👍',
    });
  }
  return top;
}

function getShallowLearning(classId, { days = 30 } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const ids = classStudentIds(classId);
  const empty = {
    classId: Number(classId), days: d, studentCount: ids.length,
    points: [], topStudents: [], maskedContentCount: 0,
    medianThreshold: SPEED_FAST,
    disclaimer: '빠르게 맞힌 게 꼭 부정은 아니에요. 이미 잘 아는 내용일 수도 있어요.',
    matrix: _emptyMatrix(),
    wrongUnits: [],
    hasWrongData: false,
    insights: _buildShallowInsights(_emptyMatrix(), [], ids.length),
  };
  if (!ids.length) return empty;

  const ph = ids.map(() => '?').join(',');
  const nameById = new Map(classStudents(classId).map(s => [s.id, s.name]));
  const titleCache = new Map();

  // ── 공통 union 행 셰이프: { userId, key, source, durationSec, correct, achievementCode }
  //    key = 콘텐츠 그룹 식별자(그룹핑·median 기준). source = 'view'|'graded'(임계 분기).
  const unionRows = [];

  // (A) learning_logs — 콘텐츠 시청·채점형(소요시간 有). result_success=1 정답 / =0 오답.
  //     result_success NULL 은 median 안정용으로만 쓰이므로 point 대상에서 제외(정오 미상).
  try {
    const rows = db.prepare(`
      SELECT ll.user_id, ll.target_type, ll.target_id, ll.duration_sec,
             ll.result_success, ll.achievement_code
      FROM learning_logs ll
      WHERE ll.user_id IN (${ph})
        AND ll.duration_sec IS NOT NULL AND ll.duration_sec > 0
        AND ll.target_type IS NOT NULL AND ll.target_id IS NOT NULL
        AND ll.created_at >= date('now', ?)
    `).all(...ids, `-${d} days`);
    for (const r of rows) {
      unionRows.push({
        userId: r.user_id,
        key: `view:${r.target_type}:${r.target_id}`,
        source: 'view',
        durationSec: Number(r.duration_sec),
        // 정오는 result_success 가 0/1 로 실측된 경우만(NULL 은 median 만 기여).
        correct: r.result_success === 1 ? true : (r.result_success === 0 ? false : null),
        achievementCode: r.achievement_code || null,
        tType: r.target_type, tId: r.target_id,
      });
    }
  } catch (_) { /* learning_logs 없으면 스킵 */ }

  // (B) problem_attempts — 문항 채점 로그(is_correct 0/1, time_taken>0). 오답+시간 유.
  //     achievement_code 는 contents.achievement_code(content_id 조인)에서 취득.
  try {
    const rows = db.prepare(`
      SELECT pa.user_id, pa.content_id, pa.node_id, pa.is_correct, pa.time_taken,
             c.achievement_code AS c_code, c.title AS c_title
      FROM problem_attempts pa
      LEFT JOIN contents c ON c.id = pa.content_id
      WHERE pa.user_id IN (${ph})
        AND pa.time_taken IS NOT NULL AND pa.time_taken > 0
        AND pa.submitted_at >= date('now', ?)
    `).all(...ids, `-${d} days`);
    for (const r of rows) {
      // 그룹 키: content_id 우선, 없으면 node_id. (같은 문항/콘텐츠끼리 median 비교)
      const gid = (r.content_id != null && r.content_id !== 0)
        ? `c${r.content_id}` : (r.node_id ? `n${r.node_id}` : 'unknown');
      const key = `graded:${gid}`;
      // 라벨/코드: contents 제목·achievement_code 우선. titleCache 에 미리 채워 _contentLabel 재사용.
      if (r.c_title && !titleCache.has(key)) titleCache.set(key, r.c_title);
      unionRows.push({
        userId: r.user_id,
        key,
        source: 'graded',
        durationSec: Number(r.time_taken),
        correct: r.is_correct === 1,
        achievementCode: r.c_code || null,
        gid,
      });
    }
  } catch (_) { /* problem_attempts 없으면 스킵 */ }

  if (!unionRows.length) return empty;

  // ── 콘텐츠 그룹핑 → duration 배열 + rows.
  const groups = new Map(); // key -> { durations:[], rows:[], achievementCode, source }
  for (const r of unionRows) {
    if (!groups.has(r.key)) {
      groups.set(r.key, { durations: [], rows: [], achievementCode: r.achievementCode || null, source: r.source });
    }
    const g = groups.get(r.key);
    g.durations.push(r.durationSec);
    g.rows.push(r);
    if (!g.achievementCode && r.achievementCode) g.achievementCode = r.achievementCode;
  }

  // ── 그룹별 median → 표본<임계(소스별)면 비노출. point 산출.
  const points = [];
  let maskedContentCount = 0;
  const flagCountByUser = new Map(); // userId -> 기존 "속도이상"(정답×아주빠름) flagCount(하위호환)

  for (const [key, g] of groups.entries()) {
    const minSample = g.source === 'graded' ? SHALLOW_MIN_GRADED_SAMPLE : SHALLOW_MIN_CONTENT_SAMPLE;
    if (g.durations.length < minSample) { maskedContentCount++; continue; }
    const med = _median(g.durations);
    if (med == null || med <= 0) { maskedContentCount++; continue; }

    // 콘텐츠 라벨: view 는 target_type/id, graded 는 titleCache(제목) → achievement 폴백.
    let label;
    const first = g.rows[0];
    if (g.source === 'view') {
      label = _contentLabel(first.tType, first.tId, g.achievementCode, titleCache);
    } else {
      label = titleCache.get(key)
        || (g.achievementCode ? (() => { try { return resolveCode(g.achievementCode).label; } catch (_) { return null; } })() : null)
        || `문항 ${first.gid || ''}`.trim();
    }

    for (const r of g.rows) {
      if (r.correct == null) continue; // 정오 미상(view NULL) → 매트릭스 대상 제외(median 만 기여).
      const dur = r.durationSec;
      const ratio = Math.round((dur / med) * 100) / 100;
      const correct = r.correct === true;
      const speed = _speedBucket(ratio);
      const flag = correct && dur < med * SHALLOW_RATIO; // 하위호환 플래그
      if (flag) flagCountByUser.set(r.userId, (flagCountByUser.get(r.userId) || 0) + 1);
      points.push({
        userId: r.userId,
        name: nameById.get(r.userId) || `학생${r.userId}`,
        content: label,
        durationSec: dur,
        median: Math.round(med),
        ratio,
        correct,
        speed,
        flag,
        achievementCode: g.achievementCode || null,
      });
    }
  }

  // ── matrix: point 를 correct×speed 로 카운트(6칸). 합 == points.length(불변식).
  const matrix = _emptyMatrix();
  for (const p of points) {
    matrix[p.correct ? 'correct' : 'wrong'][p.speed]++;
  }
  const hasWrongData = points.some(p => !p.correct);

  // ── wrongUnits: 오답 point 를 achievement_code 로 묶어 count desc(상위 5). 코드 없으면 제외.
  const wrongByCode = new Map(); // normCode -> { code, label, count }
  for (const p of points) {
    if (p.correct) continue;
    const code = p.achievementCode;
    if (!code) continue;
    const nc = normCode(code);
    if (!wrongByCode.has(nc)) {
      let label = nc;
      try { label = resolveCode(code).label || nc; } catch (_) { label = nc; }
      wrongByCode.set(nc, { code: nc, label, count: 0 });
    }
    wrongByCode.get(nc).count++;
  }
  const wrongUnits = Array.from(wrongByCode.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ── insights: §4-1 규칙 서버 평가(최대 2·최소 1).
  const insights = _buildShallowInsights(matrix, wrongUnits, ids.length);

  // ── topStudents(하위호환): 정답×아주빠름 flagCount desc. severity: >=3 high / 1~2 medium.
  const topStudents = Array.from(flagCountByUser.entries())
    .map(([userId, flagCount]) => ({
      userId,
      name: nameById.get(userId) || `학생${userId}`,
      flagCount,
      severity: flagCount >= 3 ? 'high' : 'medium',
    }))
    .sort((a, b) => b.flagCount - a.flagCount);

  // points 정렬: 오답 우선(주의 노출) → 그다음 flag → ratio asc(빠른 순).
  points.sort((a, b) =>
    (Number(!a.correct) - Number(!b.correct) === 0
      ? ((b.flag - a.flag) || (a.ratio - b.ratio))
      : (Number(!b.correct) - Number(!a.correct))));

  return {
    classId: Number(classId), days: d, studentCount: ids.length,
    points, topStudents, maskedContentCount,
    medianThreshold: SPEED_FAST,
    disclaimer: '빠르게 맞힌 게 꼭 부정은 아니에요. 이미 잘 아는 내용일 수도 있어요.',
    matrix,
    wrongUnits,
    hasWrongData,
    insights,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B6 "정서-참여 교차" (교사 · 반 2×2 매트릭스) — 온더플라이(신규 테이블 0).
//   스펙: 작업지시서/LRS_P0_시각데이터스펙_v1.md §카드2(③④)
//   getClassRiskList 가 이미 낸 signals.s_emotion(부정비율 0~1, 없으면 null)·
//   signals.s_engage(참여 하락 0~1) 를 2축 좌표로 재노출만 한다(신규 산식 최소).
//   ★ score/grade/reasons 필드는 제거(이 카드 목적은 사분면). 실명 마스킹은 라우트가 처리.
//   축 매핑(스펙 §카드2-③):
//     y(정서) = round((1 - s_emotion)*100)  // 0=부정↑(위), 100=긍정(아래). null → y=50(중립)
//     x(참여) = round((1 - s_engage)*100)    // 0=참여↓(좌), 100=참여유지(우)
//     yNeg = s_emotion>=0.5 ; xLow = s_engage>=0.5
//       yNeg & xLow → red(적신호) / yNeg & !xLow → care(정서케어)
//       !yNeg & xLow → motive(학습동기) / else → stable(안정)
//     감정없음(hasEmotion=false) 은 사분면 판정에서 중립 → stable 로 두되 quadrant 별도 표기 안 함.
//   getEmotionEngage(classId, { weeks=2 }) →
//     { classId, weeks, studentCount, points[], summary{red,care,motive,stable}, disclaimer }
// ─────────────────────────────────────────────────────────────────────────────
function getEmotionEngage(classId, { weeks = 2 } = {}) {
  const w = Math.max(1, Math.min(12, Number(weeks) || 2));
  const students = classStudents(classId);
  const empty = {
    classId: Number(classId), weeks: w, studentCount: students.length,
    points: [], summary: { red: 0, care: 0, motive: 0, stable: 0 },
    disclaimer: '규칙 기반 신호예요. 학생과의 대화로 꼭 확인하세요.',
  };
  if (!students.length) return empty;

  const risk = getClassRiskList(classId, students);
  const points = [];
  const summary = { red: 0, care: 0, motive: 0, stable: 0 };

  for (const r of risk.list) {
    const sEmotion = r.signals ? r.signals.s_emotion : null;
    const sEngage = (r.signals && r.signals.s_engage != null) ? r.signals.s_engage : 0;
    const hasEmotion = sEmotion != null;

    // 좌표(0~100). 감정없음 → y=50(중립).
    const y = hasEmotion ? Math.round((1 - sEmotion) * 100) : 50;
    const x = Math.round((1 - sEngage) * 100);

    const xLow = sEngage >= 0.5;         // 참여 하락 우세
    let quadrant;
    if (hasEmotion) {
      const yNeg = sEmotion >= 0.5;      // 부정 우세
      if (yNeg && xLow) quadrant = 'red';
      else if (yNeg && !xLow) quadrant = 'care';
      else if (!yNeg && xLow) quadrant = 'motive';
      else quadrant = 'stable';
    } else {
      // 감정 기록 없는 학생은 적신호/케어 사분면에서 제외(스펙 §카드2-⑤).
      //   참여만 낮으면 학습동기, 아니면 안정. 회색 중립 점으로 표기.
      quadrant = xLow ? 'motive' : 'stable';
    }
    summary[quadrant]++;

    // 노트(교사 개입 힌트) — 실명·수치 최소.
    let engageNote = '정상';
    if (sEngage >= 0.7) engageNote = '활동 급감';
    else if (sEngage >= 0.4) engageNote = '활동 감소';
    const emotionNote = hasEmotion ? `부정 ${Math.round(sEmotion * 100)}%` : '감정 기록 없음';

    points.push({
      userId: r.userId,
      name: r.name,
      x, y, quadrant, hasEmotion,
      engageNote, emotionNote,
    });
  }

  return {
    classId: Number(classId), weeks: w, studentCount: students.length,
    points, summary,
    disclaimer: '규칙 기반 신호예요. 학생과의 대화로 꼭 확인하세요.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B6-상세 "정서-참여 교차" 점(학생) 클릭 → 상세 근거 팝업 (교사).
//   기획서: 보고서/LRS_정서참여_점클릭_상세팝업_기획서_v1.md §3
//   getEmotionEngageStudent(userId, classId, { weeks=2 }) →
//     { userId, name, classId, weeks, quadrant, hasEmotion,
//       signals{ emotionNegPct, emotionDays, negCount, gapDays, engageTrend, engageCount, engageNote },
//       engagements[](최근 weeks주 learning_logs 정본 7종, created_at desc, ≤20),
//       emotions[](최근 weeks주 attendance 감정, date desc, ≤14) }
//
//   ★ 정합 원칙(기획서 §3-4·§5): quadrant/hasEmotion/emotionNegPct/gapDays/engageTrend/engageNote 는
//      getEmotionEngage(=getClassRiskList) 가 낸 그 학생 point·signals 를 100% 재사용(재산식 금지).
//      engagements(원시 learning_logs)·emotions(원시 attendance) 는 목록 표시용 — gapDays/negPct 산출에
//      쓰인 집계(lrs_user_daily)와 다른 테이블이라 engageCount 와 집계 카운트가 일치하지 않을 수 있음(정직 노출).
//   ★ 감정 원천은 attendance 단일(emotion_checkins/마음채움 미통합 — grep 0건). source='attendance' 고정.
//
//   ★ 라우트 책임(재확인): 권한(canViewClass)·반 소속 교차검증·실명 audit·마스킹은 routes/lrs.js 소유.
//      이 엔진은 순수 데이터 산출만 담당(name 은 원시 실명 반환 — 마스킹은 라우트가 덮어씀).
// ─────────────────────────────────────────────────────────────────────────────

// learning_logs.activity_type → 정본 학습활동 7종 라벨(사용자 확정 정의). 매핑에 없는 값은 제외.
//   (수업꾸러미 이수·평가·과제·콘텐츠 문항풀이·오늘의 학습·AI 노드·오답노트만 학습활동)
//   ★ content_view(단순 조회)·content_complete(시청 완료)·게시글·출석·설문·포트폴리오·거버넌스는 제외.
const ENGAGE_ACTIVITY_MAP = {
  // 수업꾸러미 이수
  lesson_view:          { type: 'lesson',         typeKo: '수업꾸러미' },
  lesson_progress:      { type: 'lesson',         typeKo: '수업꾸러미' },
  lesson_complete:      { type: 'lesson',         typeKo: '수업꾸러미' },
  // 평가(클래스/CBT)
  exam_complete:        { type: 'exam',           typeKo: '평가' },
  // 과제
  homework_submit:      { type: 'homework',       typeKo: '과제' },
  homework_graded:      { type: 'homework',       typeKo: '과제' },
  // 콘텐츠 문항 풀이(단순 조회·시청은 제외 — 문항 풀이만)
  content_solve:        { type: 'content',        typeKo: '콘텐츠 문항' },
  problem_attempt:      { type: 'content',        typeKo: '콘텐츠 문항' },
  problem_set_complete: { type: 'content',        typeKo: '콘텐츠 문항' },
  // 오늘의 학습
  daily_complete:       { type: 'today_learning', typeKo: '오늘의 학습' },
  // AI 노드(AI 맞춤학습·진단)
  self_learn:           { type: 'ai_node',        typeKo: 'AI 학습' },
  diagnosis_complete:   { type: 'ai_node',        typeKo: 'AI 학습' },
  // 오답노트
  wrong_note_retry:     { type: 'wrong_note',     typeKo: '오답노트' },
};

// 감정 텍스트 → 이모지/한글 감정명(정본 맵, emotion-checkin.html:334 SSOT 계승).
const ENG_EMOTION_EMOJI = {
  happy: '🤩', excited: '🤩', great: '🤩', good: '😊', calm: '😐',
  tired: '😕', sad: '😢', angry: '😡', anxious: '😰', frustrated: '😤',
  neutral: '😐', soso: '😐', bad: '😢',
};
const ENG_EMOTION_LABEL = {
  happy: '행복한', excited: '신나는', great: '아주좋은', good: '좋은', calm: '평온한',
  tired: '피곤한', sad: '슬픈', angry: '화난', anxious: '불안한', frustrated: '답답한',
  neutral: '보통', soso: '보통', bad: '나쁜',
};
// emotion_score(1~3)만 있고 텍스트 없을 때 이모지 폴백.
function _emojiFromScore(sc) {
  const n = Number(sc);
  if (!Number.isFinite(n)) return '😐';
  if (n >= 2.5) return '😊';
  if (n >= 1.5) return '😐';
  return '😢';
}

function getEmotionEngageStudent(userId, classId, { weeks = 2 } = {}) {
  const w = Math.max(1, Math.min(12, Number(weeks) || 2));
  const uid = Number(userId);
  const students = classStudents(classId);
  const stu = students.find(s => s.id === uid);
  const name = stu ? stu.name : `학생${uid}`;

  // ── 1) 사분면·핵심 signals: getEmotionEngage(=getClassRiskList) 의 그 학생 point 를 재사용(정합 100%).
  const engage = getEmotionEngage(classId, { weeks: w });
  const point = engage.points.find(p => p.userId === uid) || null;
  const quadrant = point ? point.quadrant : 'stable';
  const hasEmotion = point ? point.hasEmotion : false;
  const engageNote = point ? point.engageNote : '정상';

  // ── 2) 부정비율/감정근거 카운트: _emotionNeg(카드 s_emotion 원천, attendance 최근 10건) 재사용.
  //   ★ 정합 주의(REWORK-2): emotionNegPct 는 s_emotion(=attendance 최근 N=10건, 2주보다 긴 창)이다.
  //     카드 quadrant 근거라 detail↔card 정합상 이 값은 절대 바꾸지 않는다.
  //     대신 이 값의 "실제 표본 창"을 정확히 라벨(emotionBasisKo)로 실어, "최근 2주" 문구를 옆에 두지 않는다.
  //     "N일 중 부정 M회" 같은 2주 집계 서브라인은 이 값과 다른 창이므로 나란히 두지 않는다(§왜 정서 근거).
  const emo = _emotionNeg([uid]).get(uid) || { neg: null, count: 0 };
  const emotionNegPct = (emo.neg != null) ? Math.round(clamp01(emo.neg) * 100) : null;
  const emotionSampleN = emo.count || 0;                // s_emotion 산출에 실제 쓰인 attendance 표본 수(≤10)
  const emotionBasisKo = emotionNegPct != null
    ? `최근 감정 기록 ${emotionSampleN}건 기준`         // ★ "최근 2주"가 아니라 실제 표본 창을 명시(모순 제거)
    : null;

  // ── 3) 참여 공백/추세: _engagement(카드 s_engage 원천, lrs_user_daily) 재사용.
  const eng = _engagement([uid]).get(uid) || { gapDays: null, lastDate: null, weeklySlope: 0 };
  const gapDays = eng.gapDays; // null = 활동기록 자체 없음
  let engageTrend;
  if (gapDays == null) engageTrend = 'nodata';       // lrs_user_daily 활동기록 없음
  else if (eng.weeklySlope < 0) engageTrend = 'down';
  else if (eng.weeklySlope > 0) engageTrend = 'up';
  else engageTrend = 'flat';

  // ── 4) 참여 활동 내역(engagements): learning_logs 원시 이벤트(정본 7종만), 최근 weeks주, created_at desc.
  //   ★ demo_* 합성 시드 제외(REWORK-1): source_service NOT LIKE 'demo%' — by-service·gapDays 와 동일 정책.
  //     (demo_b4 등 데모 시드는 실활동이 아니라 gapDays(집계, 실활동만)와 모순됨. 목록에서도 제거해야 정합.)
  const sinceExpr = `-${w * 7} days`;
  let engRows = [];
  try {
    engRows = db.prepare(`
      SELECT ll.activity_type, ll.target_type, ll.target_id, ll.created_at,
             ll.subject_code, ll.achievement_code, c.title AS content_title
      FROM learning_logs ll
      LEFT JOIN contents c ON c.id = ll.target_id AND ll.target_type = 'content'
      WHERE ll.user_id = ?
        AND ll.created_at >= date('now', ?)
        AND (ll.source_service IS NULL OR ll.source_service NOT LIKE 'demo%')
        AND ll.activity_type IN (${Object.keys(ENGAGE_ACTIVITY_MAP).map(() => '?').join(',')})
      ORDER BY ll.created_at DESC
    `).all(uid, sinceExpr, ...Object.keys(ENGAGE_ACTIVITY_MAP));
  } catch (_) { engRows = []; }

  const ENG_MAX = 20;
  const engagements = [];
  for (const r of engRows) {
    const map = ENGAGE_ACTIVITY_MAP[r.activity_type];
    if (!map) continue; // 정본 7종 외 방어(IN 절로 이미 걸러짐)
    // 대상 라벨: 콘텐츠 제목 우선 → 성취기준 라벨 폴백 → null(라벨 없으면 typeKo 만 표기).
    let label = r.content_title || null;
    if (!label && r.achievement_code) {
      try { label = resolveCode(r.achievement_code).label || null; } catch (_) { label = null; }
    }
    engagements.push({
      date: String(r.created_at || '').slice(0, 10),
      type: map.type,
      typeKo: map.typeKo,
      label: label || null,
    });
  }
  const engageCount = engagements.length;               // 원시 learning_logs 정본 카운트(집계와 다를 수 있음)
  const engagementsCapped = engagements.slice(0, ENG_MAX);

  // ── 5) 감정 체크 내역(emotions): attendance 원시(감정 있는 날), 최근 weeks주, date desc, 하루 1건 축약.
  const EMO_MAX = 14;
  let emoRows = [];
  try {
    emoRows = db.prepare(`
      SELECT attendance_date AS d, emotion, emotion_score AS escore,
             comment, emotion_reason, emotion_reason_type
      FROM attendance
      WHERE user_id = ?
        AND (emotion IS NOT NULL OR emotion_score IS NOT NULL)
        AND attendance_date >= date('now', ?)
      ORDER BY attendance_date DESC
    `).all(uid, sinceExpr);
  } catch (_) { emoRows = []; }

  // 하루 중복 방어(getEmotionMirror 계승): 같은 날 다건이면 하루 1건(최신 우선 — DESC 라 첫 행이 최신).
  const emoByDate = new Map();
  for (const r of emoRows) { if (!emoByDate.has(r.d)) emoByDate.set(r.d, r); }

  const emotions = [];
  let negCount = 0;
  let recentPosCount = 0, recentNegCount = 0;           // 최근 2주 창의 극성 집계(recentEmotionHint 용)
  for (const r of emoByDate.values()) {
    const key = _emotionGroupKey(r.emotion, r.escore); // positive|neutral|negative|null
    if (key === 'negative') { negCount++; recentNegCount++; }
    else if (key === 'positive') recentPosCount++;
    const etxt = String(r.emotion || '').trim().toLowerCase();
    const emoji = ENG_EMOTION_EMOJI[etxt] || (etxt ? '😐' : _emojiFromScore(r.escore));
    const emotionKo = ENG_EMOTION_LABEL[etxt] || (r.emotion ? String(r.emotion) : '기록');
    // 이유: emotion_reason(감정출석부 이유) 우선, 없으면 comment(한마디).
    const reason = (r.emotion_reason && String(r.emotion_reason).trim())
      || (r.comment && String(r.comment).trim()) || null;
    emotions.push({
      date: String(r.d || '').slice(0, 10),
      emotion: r.emotion || null,
      emoji,
      emotionKo,
      reason: reason || null,
      source: 'attendance',      // ★ 감정 원천 단일(마음채움 미통합) — 확장 대비 필드만 유지.
      sourceKo: '감정출석부',
      group: key || 'neutral',
    });
  }
  const emotionDays = emotions.length;                  // 하루 축약 후 최근 2주 감정 기록 일수(=emotions 창)
  const emotionsCapped = emotions.slice(0, EMO_MAX);

  // ── 최근 추세 힌트(REWORK-2, 선택): s_emotion 창(과거 포함)과 최근 2주 극성이 다르면 그 사실을 드러낸다.
  //   교사가 "과거엔 부정 많았지만 최근엔 개선(또는 악화)"을 읽게. 단정 금지(관찰형 톤).
  //   판정: emotionNegPct(s_emotion)가 부정 우세(≥50)인데 최근 2주는 긍정 우세 → "최근에는 긍정 신호".
  //         반대로 s_emotion 은 낮은데(긍정) 최근 2주 부정 우세 → "최근에는 부정 신호가 보여요".
  //   최근 2주 감정 기록이 없거나(중립만) 애매하면 null(억지로 만들지 않음).
  let recentEmotionHint = null;
  if (hasEmotion && emotionNegPct != null && emotionDays > 0) {
    const recentPositive = recentPosCount > recentNegCount;
    const recentNegative = recentNegCount > recentPosCount;
    if (emotionNegPct >= 50 && recentPositive) {
      recentEmotionHint = '최근에는 긍정 신호가 보여요';
    } else if (emotionNegPct < 50 && recentNegative) {
      recentEmotionHint = '최근에는 부정 신호가 보여요';
    }
  }

  return {
    userId: uid,
    name,
    classId: Number(classId),
    weeks: w,
    quadrant,
    hasEmotion,
    signals: {
      emotionNegPct,                                    // hasEmotion=false 면 null(부정 0% 오해 방지) — s_emotion(최근 N건)
      emotionSampleN,                                   // ★ emotionNegPct 의 실제 표본 수(attendance 최근 ≤10건)
      emotionBasisKo,                                   // ★ "최근 감정 기록 N건 기준" — negPct 옆 라벨(‘최근 2주’ 아님)
      recentEmotionHint,                                // ★ 최근 2주 극성이 s_emotion 과 다르면 관찰 힌트(없으면 null)
      emotionDays,                                      // 최근 2주 감정 기록 일수(=emotions 목록 창) — 목록 섹션 헤더용
      negCount,                                         // 최근 2주 부정 건수(emotions 목록 창) — negPct 근거 아님(창 다름)
      gapDays,                                          // 활동기록 없으면 null (집계 lrs_user_daily 기준)
      engageTrend,                                      // down|flat|up|nodata
      engageCount,                                      // 최근 2주 원시 learning_logs 정본 카운트(demo 제외)
      engageNote,                                       // 카드 툴팁 동일 어휘(정상/활동 감소/활동 급감)
    },
    engagements: engagementsCapped,
    emotions: emotionsCapped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 "다음 한 걸음" (학생 · 선수→후속 학습 경로) — 온더플라이(신규 테이블 0).
//   스펙: 작업지시서/LRS_P0_시각데이터스펙_v1.md §카드4(③④⑤)
//   getPrereqGap 의 1인칭 변형. 브리지(prereqOf: 후속→[선수들])는 동일 _buildBridge/_nodeToCode.
//   ★ 학생용 — 위험점수/EWS 필드 절대 미포함(P6). 코칭 프레임만.
//   산식(스펙 §카드4-③):
//     1) 본인 성취 status(lrs_achievement_stats → classifyStatus): reached/not_reached/insufficient.
//     2) 열쇠 노드 X 후보 = 본인이 not_reached 인 선수개념(insufficient 는 "막힘" 아님).
//        각 X 의 unlocksCount = X 를 선수로 갖는 후속 Y 중 본인이 not_reached/insufficient 인 개수.
//     3) 우선순위 = unlocksCount desc → 상위 limit(기본 3)개.  (평가부족 선수는 열쇠 아님)
//     4) readyToChallenge = 선수 전부 reached 인데 본인이 not_reached 인 후속 Y.
//     5) 각 열쇠/도전에 recommendForCode(code,3) + 미니 사슬(선수→현재→후속) 부착.
//   getNextStep(userId, { limit=3 }) →
//     { userId, keyNodes[], readyToChallenge[], note }
// ─────────────────────────────────────────────────────────────────────────────
function getNextStep(userId, { limit = 3 } = {}) {
  const lim = Math.max(1, Math.min(10, Number(limit) || 3));
  const uid = Number(userId);
  const note = '학습 지도를 따라가면 막힌 곳을 넘을 수 있어요.';
  const empty = { userId: uid, keyNodes: [], readyToChallenge: [], note };

  // 1) 본인 성취 status 맵(code(정규형) → status).
  let statRows;
  try {
    statRows = db.prepare(`
      SELECT achievement_code AS code, attempt_count AS attempts,
             success_count AS correct, avg_score
      FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code IS NOT NULL
    `).all(uid);
  } catch (_) { statRows = []; }
  const statusByCode = new Map(); // normCode -> status
  for (const r of statRows) {
    const rate = reachRate(Number(r.correct) || 0, Number(r.attempts) || 0, r.avg_score);
    const status = classifyStatus(Number(r.attempts) || 0, rate);
    statusByCode.set(normCode(r.code), status);
  }
  const statusOf = (code) => statusByCode.get(normCode(code)) || STATUS.INSUFFICIENT;

  // 2) prerequisite 엣지 브리지: prereqOf(후속→[선수]) + prereqReverse(선수→[후속]).
  let edges;
  try { edges = db.prepare("SELECT from_node_id, to_node_id FROM learning_map_edges WHERE edge_type='prerequisite'").all(); }
  catch (_) { edges = []; }
  const prereqOf = new Map();     // toCode -> Set(fromCode)  (후속 → 직접 선수들)
  const unlockedBy = new Map();   // fromCode -> Set(toCode)  (선수 → 그것을 필요로 하는 후속들)
  for (const e of edges) {
    const fromCode = _nodeToCode(e.from_node_id);
    const toCode = _nodeToCode(e.to_node_id);
    if (!fromCode || !toCode) continue; // 브리지 실패 → 제외(보수적, getPrereqGap 규칙 계승)
    if (fromCode === toCode) continue;  // 자기 자신을 선수로 갖는 자기루프 제외(억지 매핑 방지)
    if (!prereqOf.has(toCode)) prereqOf.set(toCode, new Set());
    prereqOf.get(toCode).add(fromCode);
    if (!unlockedBy.has(fromCode)) unlockedBy.set(fromCode, new Set());
    unlockedBy.get(fromCode).add(toCode);
  }
  if (!prereqOf.size) return empty;

  // 미니 사슬(선수→현재→후속) 조립 헬퍼. 각 노드 3~5개.
  const buildChain = (code) => {
    const chain = [];
    // 선수 1개(있으면) — 현재 코드의 직접 선수 중 하나.
    const prereqs = prereqOf.get(normCode(code));
    if (prereqs) {
      for (const pc of prereqs) {
        chain.push({ code: pc, label: resolveCode(pc).label, status: statusOf(pc), current: false });
        break; // 대표 선수 1개(사슬 과밀 방지)
      }
    }
    // 현재 노드
    chain.push({ code: normCode(code), label: resolveCode(code).label, status: statusOf(code), current: true });
    // 후속 노드(들) — 최대 2개.
    const succs = unlockedBy.get(normCode(code));
    if (succs) {
      let cnt = 0;
      for (const sc of succs) {
        chain.push({ code: sc, label: resolveCode(sc).label, status: statusOf(sc), current: false });
        if (++cnt >= 2) break;
      }
    }
    return chain;
  };

  // 3) 열쇠 노드 후보 = 본인이 not_reached 인 선수개념(X). unlocksCount 계산.
  const keyNodes = [];
  for (const [fromCode, succSet] of unlockedBy.entries()) {
    if (statusOf(fromCode) !== STATUS.NOT_REACHED) continue; // 미도달 선수만 열쇠(평가부족 제외)
    // X 를 선수로 갖는 후속 Y 중 본인이 not_reached/insufficient 인 것 = 아직 안 열린 후속.
    const unlocks = [];
    for (const toCode of succSet) {
      const st = statusOf(toCode);
      if (st === STATUS.NOT_REACHED || st === STATUS.INSUFFICIENT) {
        unlocks.push({ code: toCode, label: resolveCode(toCode).label, status: st });
      }
    }
    if (!unlocks.length) continue; // 여는 게 없으면 열쇠 아님
    keyNodes.push({
      code: normCode(fromCode),
      label: resolveCode(fromCode).label,
      status: STATUS.NOT_REACHED,
      unlocksCount: unlocks.length,
      unlocks,
      chain: buildChain(fromCode),
      recommendations: recommendForCode(fromCode, 3),
      cta: unlocks.length === 1 ? '이걸 풀면 뒤의 학습이 열려요' : `이걸 풀면 뒤의 ${unlocks.length}개가 열려요`,
    });
  }
  // 우선순위: unlocksCount desc(하나 풀면 여러 개 열림) → 상위 limit.
  keyNodes.sort((a, b) => b.unlocksCount - a.unlocksCount);
  const topKeyNodes = keyNodes.slice(0, lim);

  // 4) readyToChallenge = 본인이 not_reached 인 후속 Y 인데 선수 X 전부 reached.
  const readyToChallenge = [];
  for (const [toCode, prereqSet] of prereqOf.entries()) {
    if (statusOf(toCode) !== STATUS.NOT_REACHED) continue; // 도전 대상 = 본인 미도달 후속
    if (!prereqSet.size) continue;
    let allReached = true;
    for (const pc of prereqSet) {
      if (statusOf(pc) !== STATUS.REACHED) { allReached = false; break; }
    }
    if (!allReached) continue;
    readyToChallenge.push({
      code: normCode(toCode),
      label: resolveCode(toCode).label,
      status: STATUS.NOT_REACHED,
      prereqReached: true,
      recommendations: recommendForCode(toCode, 3),
      message: '선수 학습을 마쳤어요 — 지금 도전해 볼까요?',
    });
  }
  readyToChallenge.sort((a, b) => a.code.localeCompare(b.code));

  return {
    userId: uid,
    keyNodes: topKeyNodes,
    readyToChallenge: readyToChallenge.slice(0, lim),
    note,
  };
}

module.exports = {
  CONFIDENCE, CONFIDENCE_KO, RISK_GRADE, RISK_GRADE_KO, RISK_WEIGHTS,
  MIN_WEEKS, MIN_WEEK_ATTEMPTS, DEFAULT_WEEKS, NEGATIVE_EMOTIONS,
  classStudentIds, classStudents, classSubjects,
  canonicalSubject, SUBJECT_ALIAS, // 교과 별칭 정규화(레거시→정본 병합)
  weeklyRateSeries: _weeklyRateSeries, // P1-3 classTrend(routes/lrs.js)용 — withContributors 옵션 지원
  computeTrend, projectReach, projectionInsights, getClassRiskList, getPrereqGap, getWeakTrend,
  getEmotionMirror, getShallowLearning, getEmotionEngage, getEmotionEngageStudent, getNextStep,
  riskGrade, invalidateBridge,
  // B4 풀이 속도-정확도 점검 — 속도버킷 상수·헬퍼(하네스 경계 테스트용)
  SPEED_FAST, SPEED_SLOW, SHALLOW_MIN_GRADED_SAMPLE, SHALLOW_MIN_CONTENT_SAMPLE,
  speedBucket: _speedBucket,
};
