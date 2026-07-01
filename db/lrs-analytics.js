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
// ─────────────────────────────────────────────────────────────────────────────
function _weeklyRateSeries({ userIds, code, weeksLimit }) {
  if (!userIds || !userIds.length) return [];
  const ph = userIds.map(() => '?').join(',');
  let sql = `
    SELECT strftime('%Y-%W', created_at) AS week,
           COUNT(*) AS attempts,
           SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) AS success
    FROM learning_logs
    WHERE user_id IN (${ph})
      AND achievement_code IS NOT NULL
      AND result_success IS NOT NULL`;
  const params = [...userIds];
  if (code) { sql += ' AND achievement_code = ?'; params.push(code); }
  sql += ' GROUP BY week ORDER BY week ASC';

  let rows;
  try { rows = db.prepare(sql).all(...params); } catch (_) { return []; }

  // 한 주 시도<3 결측 처리 → 유효 주만 남긴다.
  let weeks = rows
    .filter(r => (Number(r.attempts) || 0) >= MIN_WEEK_ATTEMPTS)
    .map(r => {
      const a = Number(r.attempts) || 0;
      const s = Number(r.success) || 0;
      return { week: r.week, attempts: a, success: s, rate: a > 0 ? (s / a) * 100 : null };
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
function computeTrend({ userId, classId, userIds, code = null, weeks = DEFAULT_WEEKS } = {}) {
  let ids = userIds;
  if (!ids) {
    if (userId != null) ids = [userId];
    else if (classId != null) ids = classStudentIds(classId);
    else ids = [];
  }
  const series = _weeklyRateSeries({ userIds: ids, code, weeksLimit: weeks });
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
    series: series.map((w, i) => ({ week: w.week, x: i, rate: round1(w.rate), attempts: w.attempts })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §B-3. 도달 예측 — 현재 도달률 + 기울기 외삽 + 불확실성 밴드.
//   projectReach(trend, { target=80 }) →
//     { reachable, weeksToReach, projectedRate, band:{lo,hi}, message, confidence }
//   slope<=0 → reachable=false("현 추세로 도달 어려움"). 단일 확정선 금지(밴드 동반).
// ─────────────────────────────────────────────────────────────────────────────
function projectReach(trend, { target = 80 } = {}) {
  if (!trend || trend.status !== 'ok' || trend.currentRate == null) {
    return {
      status: 'insufficient',
      reachable: null, weeksToReach: null,
      message: '아직 추세를 볼 데이터가 부족해요. 더 풀면 표시됩니다.',
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

module.exports = {
  CONFIDENCE, CONFIDENCE_KO, RISK_GRADE, RISK_GRADE_KO, RISK_WEIGHTS,
  MIN_WEEKS, MIN_WEEK_ATTEMPTS, DEFAULT_WEEKS, NEGATIVE_EMOTIONS,
  classStudentIds, classStudents,
  computeTrend, projectReach, getClassRiskList, getPrereqGap, getWeakTrend,
  getEmotionMirror,
  riskGrade, invalidateBridge,
};
