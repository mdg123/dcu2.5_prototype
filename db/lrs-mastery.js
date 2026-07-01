// db/lrs-mastery.js
// ─────────────────────────────────────────────────────────────────────────────
// 성취수준(성취기준 도달도) 중심 LRS — P0 데이터 레이어.
//
//   기획서: 작업지시서/LRS_성취수준_인사이트_재설계_기획서.md
//   - P0-1: achievement_code → std_id · 성취기준 서술 · 교과 라벨 resolver (캐시)
//   - P0-2: 학생/클래스 mastery 산출(강약·추천·매트릭스)
//   - P0-6: C-2 임계 — "평가부족(insufficient)" 상태 분리
//
//   설계 원칙: 새 수집 0건. 이미 쌓인 lrs_achievement_stats(achievement_code) 를
//   curriculum_std_id_map / curriculum_standards / curriculum_standard_levels 로
//   "표준체계"에 묶어 라벨·서술·교과를 붙인다. (브리지가 재설계의 핵심)
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./index');

// ── 상태(status) 상수 ─────────────────────────────────────────────────────────
// 한글(레거시 last_level 호환) ↔ 영문 status 코드를 모두 노출한다.
const STATUS = {
  REACHED: 'reached',       // 도달   (상/A)   rate>=80 & att>=3
  PARTIAL: 'partial',       // 부분도달(중/B~C) rate>=50 & att>=3
  NOT_REACHED: 'not_reached', // 미도달 (하/D~E) rate<50  & att>=3
  INSUFFICIENT: 'insufficient', // 평가부족(회색)  att<3   ← "안 해본 것"≠"못한 것"
};
// 레거시 한글 last_level → 영문 status (att>=3 인 도달/부분/미도달만; insufficient 는 att 기준 재판정)
const KO_TO_STATUS = { '상': STATUS.REACHED, '중': STATUS.PARTIAL, '하': STATUS.NOT_REACHED, '미도달': STATUS.NOT_REACHED };
const STATUS_KO = {
  [STATUS.REACHED]: '도달',
  [STATUS.PARTIAL]: '부분도달',
  [STATUS.NOT_REACHED]: '미도달',
  [STATUS.INSUFFICIENT]: '평가부족',
};

const MIN_ATTEMPTS = 3; // C-2: 판정에 필요한 최소 시도 수

// ─────────────────────────────────────────────────────────────────────────────
// P0-6 / C-2: 단일 진실원천(SSOT) 상태 분류기.
//   attempts < 3                  → insufficient (평가부족)
//   rate >= 80 & attempts >= 3    → reached (도달)
//   rate >= 50 & attempts >= 3    → partial (부분도달)
//   rate <  50 & attempts >= 3    → not_reached (미도달)
//   rate(null, 분모 0) 는 insufficient 로 본다(데이터 없음).
// rate 는 0~100 스케일 정수/실수.
// ─────────────────────────────────────────────────────────────────────────────
function classifyStatus(attempts, rate) {
  const a = Number(attempts) || 0;
  if (a < MIN_ATTEMPTS) return STATUS.INSUFFICIENT;
  if (rate == null || !Number.isFinite(Number(rate))) return STATUS.INSUFFICIENT;
  const r = Number(rate);
  if (r >= 80) return STATUS.REACHED;
  if (r >= 50) return STATUS.PARTIAL;
  return STATUS.NOT_REACHED;
}

// avg_score(0~1 또는 0~100 혼재 방어) → 0~100 rate. 시도 0 또는 점수 없으면 null.
function scoreToRate(avgScore) {
  if (avgScore == null || !Number.isFinite(Number(avgScore))) return null;
  const s = Number(avgScore);
  const r = s > 1 ? s : s * 100;          // 0-1 스케일이면 100 곱
  return Math.max(0, Math.min(100, r));
}

// success/attempt 기반 정답률(우선) — 없으면 avg_score 폴백.
function reachRate(success, attempts, avgScore) {
  const a = Number(attempts) || 0;
  const c = Number(success);
  if (a > 0 && Number.isFinite(c)) return Math.max(0, Math.min(100, (c / a) * 100));
  return scoreToRate(avgScore);
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-1: achievement_code → { std_id, std_ids, label(서술), area, subject_code,
//                            subject_label, grade_group } resolver.
//   - curriculum_standards(code) 의 content 를 1차 라벨(서술)로,
//   - curriculum_std_id_map 으로 std_id·교과 보강,
//   - 둘 다 없으면 코드 자체를 라벨로 폴백(무손상).
//   캐시: 첫 호출 시 매핑 3종을 1회 통째 로드(맵). 결정론·고속.
// ─────────────────────────────────────────────────────────────────────────────
const SUBJECT_LABELS = {
  'KOR': '국어', 'MAT': '수학', 'ENG': '영어', 'SCI': '과학', 'SOC': '사회',
  'ART': '예술', 'PE': '체육', 'MUS': '음악', 'MOR': '도덕', 'PRA': '실과',
  'korean': '국어', 'math': '수학', 'english': '영어', 'science': '과학',
  'social': '사회', 'art': '예술/미술', 'music': '음악', 'moral': '도덕',
  'pe': '체육', 'practical': '실과',
};
function subjectLabel(code) {
  if (!code) return '';
  // korean-e / math-m 등 접미 제거 후 매핑
  const base = String(code).split('-')[0];
  return SUBJECT_LABELS[base] || SUBJECT_LABELS[code] || String(code);
}

let _cache = null; // { code -> {std_id, std_ids, label, area, subject_code, subject_label, grade_group} }

function normalizeCode(code) {
  const t = String(code || '').trim();
  if (!t) return '';
  if (t.startsWith('[') && t.endsWith(']')) return t;
  return `[${t}]`;
}

function buildCache() {
  const map = new Map();
  // 1) curriculum_standards: 서술(content)·영역(area)·교과 — 라벨의 1차 출처
  try {
    for (const r of db.prepare(
      'SELECT code, content, area, subject_code, grade_group FROM curriculum_standards'
    ).all()) {
      if (!r.code) continue;
      map.set(r.code, {
        code: r.code,
        std_id: null,
        std_ids: [],
        label: r.content || r.code,
        area: r.area || null,
        subject_code: r.subject_code || null,
        subject_label: subjectLabel(r.subject_code),
        grade_group: r.grade_group != null ? Number(r.grade_group) : null,
      });
    }
  } catch (_) { /* 테이블 없으면 무시 */ }
  // 2) curriculum_std_id_map: std_id·교과 보강 (라벨 없는 code 도 여기서 생성)
  try {
    for (const r of db.prepare(
      'SELECT standard_code, std_id, subject_code, grade_group FROM curriculum_std_id_map'
    ).all()) {
      if (!r.standard_code) continue;
      let e = map.get(r.standard_code);
      if (!e) {
        e = {
          code: r.standard_code, std_id: null, std_ids: [], label: r.standard_code,
          area: null, subject_code: r.subject_code || null,
          subject_label: subjectLabel(r.subject_code),
          grade_group: r.grade_group != null ? Number(r.grade_group) : null,
        };
        map.set(r.standard_code, e);
      }
      if (r.std_id && !e.std_ids.includes(r.std_id)) e.std_ids.push(r.std_id);
      if (!e.std_id && r.std_id) e.std_id = r.std_id;
      if (!e.subject_code && r.subject_code) {
        e.subject_code = r.subject_code; e.subject_label = subjectLabel(r.subject_code);
      }
      if (e.grade_group == null && r.grade_group != null) e.grade_group = Number(r.grade_group);
    }
  } catch (_) { /* 무시 */ }
  return map;
}

/** code → 표준체계 컨텍스트. 매핑 없으면 코드 자체를 라벨로 폴백(무손상). */
function resolveCode(code) {
  if (!_cache) _cache = buildCache();
  const norm = normalizeCode(code);
  // 괄호 유/무 양쪽 시도 (데이터에 '9수01-01' 같은 무괄호도 존재)
  let e = _cache.get(norm) || _cache.get(String(code || '').trim());
  if (e) return e;
  // 미매핑 legacy: 코드 자체 라벨 폴백
  return {
    code: norm || String(code || ''),
    std_id: null, std_ids: [],
    label: norm || String(code || ''),
    area: null, subject_code: null, subject_label: '', grade_group: null,
  };
}

/** 여러 code 를 한 번에 resolve (FE 편의·N+1 회피). */
function resolveCodes(codes) {
  const out = {};
  for (const c of codes) out[c] = resolveCode(c);
  return out;
}

/** 캐시 무효화(재빌드 후 호출). */
function invalidateCache() { _cache = null; }

// ─────────────────────────────────────────────────────────────────────────────
// 추천 콘텐츠: 약점 성취기준 code → 공개/승인 콘텐츠 (achievement_code 매칭).
//   괄호 유/무, contents.status='approved' 우선. 최대 limit 개.
// ─────────────────────────────────────────────────────────────────────────────
const _recStmt = db.prepare(`
  SELECT id, title, content_type, achievement_code, thumbnail_url
  FROM contents
  WHERE achievement_code IN (?, ?) AND status = 'approved'
  ORDER BY (view_count IS NULL), view_count DESC
  LIMIT ?
`);
function recommendForCode(code, limit = 3) {
  try {
    const norm = normalizeCode(code);
    const raw = String(code || '').trim();
    return _recStmt.all(norm, raw, limit).map(r => ({
      id: r.id, title: r.title, type: r.content_type,
      achievement_code: r.achievement_code, thumbnail_url: r.thumbnail_url || null,
    }));
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-2a: 학생 성취기준별 도달 mastery.
//   getStudentMastery(userId) →
//     { userId, standards[], distribution(4상태), bySubject[](레이더), strengths[], weaknesses[] }
//   각 standard: { code, std_id, label, area, subject, subject_code, attempts, correct,
//                  rate, status, statusKo, recommendations[] }
// ─────────────────────────────────────────────────────────────────────────────
const _stuStmt = db.prepare(`
  SELECT achievement_code AS code, subject_code, attempt_count AS attempts,
         success_count AS correct, avg_score, last_level, last_attempt_at AS lastAt
  FROM lrs_achievement_stats
  WHERE user_id = ?
  ORDER BY attempt_count DESC
`);

// 기간 스코프 재계산용: learning_logs 에서 (기간 내) 성취기준별 시도/정답/평균 집계.
//   평가신호(result_score 또는 result_success 비-NULL) 있는 로그만 시도로 셈(도달률 역효과 방지 —
//   log-helper 의 실시간 집계 규칙과 동일). cumulative 테이블(lrs_achievement_stats)과 컬럼 계약 일치.
const _stuRangeStmt = db.prepare(`
  SELECT achievement_code AS code, MAX(subject_code) AS subject_code,
         COUNT(*) AS attempts,
         SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) AS correct,
         AVG(result_score) AS avg_score,
         MAX(created_at) AS lastAt
  FROM learning_logs
  WHERE user_id = ? AND achievement_code IS NOT NULL AND achievement_code <> ''
    AND (result_score IS NOT NULL OR result_success IS NOT NULL)
    AND DATE(created_at) >= ? AND DATE(created_at) <= ?
  GROUP BY achievement_code
  ORDER BY attempts DESC
`);

function getStudentMastery(userId, opts = {}) {
  const subjectFilter = opts.subjectCode || null;
  // 기간 스코프(감사 §2): fromDate~toDate 가 주어지면 그 기간 learning_logs 로 재계산(누적 대신).
  //   미지정이면 기존대로 lrs_achievement_stats 누적(전기간) 사용.
  const scoped = opts.fromDate && opts.toDate;
  const rows = scoped
    ? _stuRangeStmt.all(userId, opts.fromDate, opts.toDate)
    : _stuStmt.all(userId);
  const standards = [];
  const distribution = {
    [STATUS.REACHED]: 0, [STATUS.PARTIAL]: 0, [STATUS.NOT_REACHED]: 0, [STATUS.INSUFFICIENT]: 0, total: 0,
  };
  const subjAgg = new Map(); // subject_code -> {attempts, correct, reached, evaluated}

  for (const r of rows) {
    const ctx = resolveCode(r.code);
    const subject_code = ctx.subject_code || r.subject_code || null;
    if (subjectFilter && subject_code !== subjectFilter) continue;

    const attempts = Number(r.attempts) || 0;
    const correct = Number(r.correct) || 0;
    const rate = reachRate(correct, attempts, r.avg_score);
    const status = classifyStatus(attempts, rate);

    distribution[status]++;
    distribution.total++;

    // 교과 요약(레이더): 평가된 성취기준(att>=3)만 도달률 분모로
    const key = subject_code || 'unknown';
    if (!subjAgg.has(key)) subjAgg.set(key, { attempts: 0, correct: 0, reached: 0, evaluated: 0, count: 0 });
    const sa = subjAgg.get(key);
    sa.attempts += attempts; sa.correct += correct; sa.count++;
    if (status !== STATUS.INSUFFICIENT) {
      sa.evaluated++;
      if (status === STATUS.REACHED) sa.reached++;
    }

    standards.push({
      code: ctx.code, std_id: ctx.std_id, std_ids: ctx.std_ids,
      label: ctx.label, area: ctx.area,
      subject_code, subject: ctx.subject_label || subjectLabel(subject_code),
      attempts, correct,
      rate: rate == null ? null : Math.round(rate * 10) / 10,
      status, statusKo: STATUS_KO[status],
      lastAt: r.lastAt || null,
      recommendations: [], // 약점만 채움(아래)
    });
  }

  // 교과별 요약(레이더용): 평가된 성취기준 기준 도달률 + 평균 정답률
  const bySubject = Array.from(subjAgg.entries()).map(([sc, v]) => ({
    subject_code: sc === 'unknown' ? null : sc,
    subject: subjectLabel(sc === 'unknown' ? '' : sc) || '기타',
    standardCount: v.count,
    evaluatedCount: v.evaluated,
    reachedCount: v.reached,
    reachedRate: v.evaluated > 0 ? Math.round((v.reached / v.evaluated) * 1000) / 10 : null,
    avgRate: v.attempts > 0 ? Math.round((v.correct / v.attempts) * 1000) / 10 : null,
  })).sort((a, b) => (b.standardCount - a.standardCount));

  // 강점/약점: 평가된(att>=3) 것만 대상. 강점=rate 내림차, 약점=rate 오름차(미도달·부분 우선)
  const evaluated = standards.filter(s => s.status !== STATUS.INSUFFICIENT && s.rate != null);
  const strengths = evaluated
    .filter(s => s.status === STATUS.REACHED || s.rate >= 70)
    .sort((a, b) => b.rate - a.rate).slice(0, 5)
    .map(s => ({ code: s.code, label: s.label, subject: s.subject, rate: s.rate, status: s.status }));
  const weakOrdered = evaluated
    .filter(s => s.status === STATUS.NOT_REACHED || s.status === STATUS.PARTIAL)
    .sort((a, b) => a.rate - b.rate).slice(0, 5);
  const weaknesses = weakOrdered.map(s => {
    const recs = recommendForCode(s.code, 3);
    // standards 원본에도 추천 부착(FE 가 카드에서 바로 사용)
    const ref = standards.find(x => x.code === s.code);
    if (ref) ref.recommendations = recs;
    return {
      code: s.code, std_id: s.std_id, label: s.label, area: s.area,
      subject: s.subject, subject_code: s.subject_code,
      rate: s.rate, status: s.status, statusKo: s.statusKo,
      attempts: s.attempts, correct: s.correct,
      recommendations: recs,
    };
  });

  return {
    userId: Number(userId),
    // 집계 기준: scoped=true 면 기간 스코프(기간칩 반영), false 면 전기간 누적.
    scoped: !!scoped,
    period: scoped ? { fromDate: opts.fromDate, toDate: opts.toDate } : null,
    counts: {
      total: distribution.total,
      reached: distribution[STATUS.REACHED],
      partial: distribution[STATUS.PARTIAL],
      notReached: distribution[STATUS.NOT_REACHED],
      insufficient: distribution[STATUS.INSUFFICIENT],
    },
    distribution, // 도넛용 (4상태 + total)
    bySubject,    // 레이더용
    strengths,
    weaknesses,
    standards,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-2b: 클래스 성취기준×학생 매트릭스.
//   getClassMastery(classId, studentIds) →
//     { classId, students[], standards[](행 + 학급 도달률·미도달명단),
//       matrix{code:{userId:{status,rate}}}, distribution(클래스4상태), weakTop[] }
//   - students: 열 헤더(본인 식별 최소: id, name)
//   - standards 행: 학급 도달률 = 평가된 학생 중 도달 비율
// ─────────────────────────────────────────────────────────────────────────────
function getClassMastery(classId, students, opts = {}) {
  const subjectFilter = opts.subjectCode || null;
  const studentIds = students.map(s => s.id);
  if (!studentIds.length) {
    return { classId: Number(classId), students: [], standards: [], matrix: {}, distribution: { reached: 0, partial: 0, not_reached: 0, insufficient: 0, total: 0 }, weakTop: [] };
  }
  const placeholders = studentIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT user_id, achievement_code AS code, subject_code,
           attempt_count AS attempts, success_count AS correct, avg_score
    FROM lrs_achievement_stats
    WHERE user_id IN (${placeholders})
  `).all(...studentIds);

  const matrix = {};           // code -> { userId -> {status, rate} }
  const stdAgg = new Map();    // code -> {reached, partial, notReached, insufficient, evaluated, attemptsSum, correctSum, notReachedUsers[], ctx}
  const classDist = { [STATUS.REACHED]: 0, [STATUS.PARTIAL]: 0, [STATUS.NOT_REACHED]: 0, [STATUS.INSUFFICIENT]: 0, total: 0 };
  const nameById = new Map(students.map(s => [s.id, s.name]));

  for (const r of rows) {
    const ctx = resolveCode(r.code);
    const subject_code = ctx.subject_code || r.subject_code || null;
    if (subjectFilter && subject_code !== subjectFilter) continue;

    const attempts = Number(r.attempts) || 0;
    const correct = Number(r.correct) || 0;
    const rate = reachRate(correct, attempts, r.avg_score);
    const status = classifyStatus(attempts, rate);

    if (!matrix[ctx.code]) matrix[ctx.code] = {};
    matrix[ctx.code][r.user_id] = { status, rate: rate == null ? null : Math.round(rate * 10) / 10 };

    if (!stdAgg.has(ctx.code)) {
      stdAgg.set(ctx.code, {
        ctx, reached: 0, partial: 0, notReached: 0, insufficient: 0,
        evaluated: 0, attemptsSum: 0, correctSum: 0, notReachedUsers: [],
      });
    }
    const a = stdAgg.get(ctx.code);
    a.attemptsSum += attempts; a.correctSum += correct;
    if (status === STATUS.REACHED) { a.reached++; a.evaluated++; }
    else if (status === STATUS.PARTIAL) { a.partial++; a.evaluated++; }
    else if (status === STATUS.NOT_REACHED) {
      a.notReached++; a.evaluated++;
      a.notReachedUsers.push({ id: r.user_id, name: nameById.get(r.user_id) || `학생${r.user_id}` });
    } else { a.insufficient++; }

    classDist[status]++; classDist.total++;
  }

  // 성취기준 행 조립
  const standards = Array.from(stdAgg.entries()).map(([code, a]) => {
    const reachedRate = a.evaluated > 0 ? Math.round((a.reached / a.evaluated) * 1000) / 10 : null;
    const avgRate = a.attemptsSum > 0 ? Math.round((a.correctSum / a.attemptsSum) * 1000) / 10 : null;
    return {
      code: a.ctx.code, std_id: a.ctx.std_id, label: a.ctx.label, area: a.ctx.area,
      subject_code: a.ctx.subject_code, subject: a.ctx.subject_label,
      reached: a.reached, partial: a.partial, notReached: a.notReached, insufficient: a.insufficient,
      evaluated: a.evaluated, studentCount: a.reached + a.partial + a.notReached + a.insufficient,
      reachedRate, avgRate,
      notReachedStudents: a.notReachedUsers,
    };
  });
  // 정렬: 평가된 성취기준 중 도달률 낮은 순(취약 우선), 미평가는 뒤로
  standards.sort((x, y) => {
    const xr = x.reachedRate == null ? Infinity : x.reachedRate;
    const yr = y.reachedRate == null ? Infinity : y.reachedRate;
    return xr - yr;
  });

  // 약점 Top: 평가된 학생이 있는 성취기준 중 도달률 낮은 순
  const weakTop = standards
    .filter(s => s.evaluated > 0 && s.reachedRate != null && s.reachedRate < 80)
    .slice(0, 10)
    .map(s => ({
      code: s.code, std_id: s.std_id, label: s.label, subject: s.subject,
      reachedRate: s.reachedRate, notReached: s.notReached, evaluated: s.evaluated,
      notReachedStudents: s.notReachedStudents,
      recommendations: recommendForCode(s.code, 3),
    }));

  return {
    classId: Number(classId),
    students: students.map(s => ({ id: s.id, name: s.name })),
    standards,
    matrix,
    distribution: {
      reached: classDist[STATUS.REACHED],
      partial: classDist[STATUS.PARTIAL],
      not_reached: classDist[STATUS.NOT_REACHED],
      insufficient: classDist[STATUS.INSUFFICIENT],
      total: classDist.total,
    },
    weakTop,
  };
}

module.exports = {
  STATUS, STATUS_KO, KO_TO_STATUS, MIN_ATTEMPTS,
  classifyStatus, scoreToRate, reachRate,
  resolveCode, resolveCodes, invalidateCache, recommendForCode, subjectLabel,
  getStudentMastery, getClassMastery,
};
