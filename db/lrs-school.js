// db/lrs-school.js
// ─────────────────────────────────────────────────────────────────────────────
// 학교 경영 대시보드(교장·교감) — 학교 스코프 롤업 레이어 (P0-2~8).
//
//   기획서: 작업지시서/학교관리자_대시보드_기획서.md
//   설계 원칙(반드시·계승):
//     - 신규 집계 0 지향: 기존 lrs-mastery·lrs-analytics 함수에 "학교 학생 ID 배열"만 주입.
//       (단원/학년 롤업·정서·운영처럼 학교 단위 단순 GROUP BY 만 본 모듈에서 직접 SQL.)
//     - 단일 분류기(P4): 모든 도달 판정은 lrs-mastery.classifyStatus(4상태)만.
//     - 평가부족≠미도달(P5): insufficient 는 도달률 분모/위험에서 제외(회색).
//     - 정직한 불확실성: 소표본은 n 경고 동반(라우트에서 표기).
//     - 규칙기반 인사이트(가짜 AI 금지): 임계 규칙 + 근거 문장 + 신뢰도/표본 꼬리표.
//
//   본 모듈은 "산출"만 한다. 권한·실명/마스킹 결정·HTTP 는 routes/school.js.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./index');
const mastery = require('./lrs-mastery');
const analytics = require('./lrs-analytics');
// 감정 분류 SSOT — 정본사전 §2-B(텍스트 어휘 우선, emotion_score 임계 비교 금지).
const { isNegativeEmotion } = require('../lib/lrs/emotion-scale');
// 학생 모집단 SSOT — 반 학생 명단·수는 db/class.js 한 벌만 쓴다.
const classDb = require('./class');
const { classifyStatus, reachRate, STATUS, resolveCode, subjectLabel } = mastery;

const MIN_CROSS_N = 10; // 교과×학급 교차드릴 개별 노출 금지 임계(기획서 §3-2) — 미만은 카운트만.

// ── 작은 유틸 ────────────────────────────────────────────────────────────────
function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function pctOf(part, whole) { return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0; }
function _ph(arr) { return arr.map(() => '?').join(','); }

const SUBJECT_ORDER = ['korean', 'math', 'english', 'science', 'social']; // 히트맵 열 정렬 우선

// 교과코드 정규화(시드 접미 -e/-m/-h, KOR/MAT 대문자 → 표준 base). 히트맵 그룹 키.
function subjectBase(code) {
  if (!code) return 'unknown';
  const s = String(code).split('-')[0];
  const MAP = {
    KOR: 'korean', MAT: 'math', ENG: 'english', SCI: 'science', SOC: 'social',
    ART: 'art', MUS: 'music', MOR: 'moral', PE: 'pe', PRA: 'practical',
  };
  return MAP[s] || s;
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-2 헤드라인 KPI 묶음 — 한눈요약(⓪). 학교 학생/교직원 ID 배열 주입.
//   { studentCount, teacherCount, parentCount, avgReachedRate, supportNeeded,
//     positiveEmotionPct, todayLearning{...}, activeClassRate, gradeBars[] }
// ─────────────────────────────────────────────────────────────────────────────
function getOverviewKpis(scope) {
  const studentIds = scope.studentIds || [];
  const schoolName = scope.schoolName;

  // 가입 현황(role별·학년별) — school_name 정확 일치
  const enrollment = getEnrollment(scope);

  // 학교 평균 성취 도달률 = 평가된(att>=3) 성취기준 중 도달 비율(단일 분류기).
  const ach = _schoolAchievementRollup(studentIds);

  // 지원필요(위험) 학생 수 — analytics 위험점수를 학교 학생 합집합으로.
  const risk = studentIds.length ? analytics.getClassRiskList(null, scope.students) : { summary: { high: 0, medium: 0, low: 0, total: 0 } };

  // 오늘의 학습(이수율·참여·정답률)
  const daily = getTodayLearning(scope);

  // 활성 클래스율(최근 14일 활동) — 학교 소유 클래스 기준
  const cls = _activeClassRate(schoolName);

  // 정서 긍정 비율(표본 작음 — n 동반)
  const emo = _emotionSummary(studentIds);

  return {
    studentCount: enrollment.byRole.student || 0,
    teacherCount: enrollment.byRole.teacher || 0,
    parentCount: enrollment.byRole.parent || 0,
    principalCount: enrollment.byRole.principal || 0,
    avgReachedRate: ach.reachedRate,            // % (평가된 성취기준 중 도달)
    evaluatedStandards: ach.evaluated,
    supportNeeded: risk.summary.high || 0,      // 위험 '높음' 학생 수
    riskSummary: risk.summary,
    todayLearning: daily,
    activeClassRate: cls.activeRate,            // %
    activeClasses: cls.active, totalClasses: cls.total,
    emotion: emo,                               // { positivePct, sampleN }
    gradeBars: enrollment.byGrade,              // [{grade, count}]
  };
}

// 학교 학생 성취 롤업(평가된 성취기준 도달률·4상태 분포). 단일 분류기.
function _schoolAchievementRollup(studentIds, { subjectBaseFilter = null } = {}) {
  const out = { reached: 0, partial: 0, notReached: 0, insufficient: 0, evaluated: 0, total: 0, reachedRate: null };
  if (!studentIds.length) return out;
  const rows = db.prepare(`
    SELECT achievement_code AS code, subject_code,
           attempt_count AS attempts, success_count AS correct, avg_score
    FROM lrs_achievement_stats
    WHERE user_id IN (${_ph(studentIds)})
  `).all(...studentIds);
  for (const r of rows) {
    if (subjectBaseFilter) {
      const ctx = resolveCode(r.code);
      const sb = subjectBase(ctx.subject_code || r.subject_code);
      if (sb !== subjectBaseFilter) continue;
    }
    const rate = reachRate(r.correct, r.attempts, r.avg_score);
    const status = classifyStatus(r.attempts, rate);
    out.total++;
    if (status === STATUS.REACHED) { out.reached++; out.evaluated++; }
    else if (status === STATUS.PARTIAL) { out.partial++; out.evaluated++; }
    else if (status === STATUS.NOT_REACHED) { out.notReached++; out.evaluated++; }
    else out.insufficient++;
  }
  out.reachedRate = out.evaluated > 0 ? round1((out.reached / out.evaluated) * 100) : null;
  return out;
}

// 활성 클래스율 — 학교 소유 클래스 중 최근 14일 learning_logs 활동이 있는 비율.
function _activeClassRate(schoolName) {
  if (!schoolName) return { active: 0, total: 0, activeRate: 0 };
  let classIds = [];
  try {
    classIds = db.prepare(`
      SELECT id FROM classes WHERE school_name = ? AND (status IS NULL OR status = 'active')
    `).all(schoolName).map(r => r.id);
  } catch (_) { classIds = []; }
  const total = classIds.length;
  if (!total) return { active: 0, total: 0, activeRate: 0 };
  const ph = _ph(classIds);
  let active = 0;
  try {
    active = db.prepare(`
      SELECT COUNT(DISTINCT class_id) c FROM learning_logs
      WHERE class_id IN (${ph}) AND DATE(created_at) >= DATE('now','localtime','-13 days')
    `).get(...classIds).c || 0;
  } catch (_) { active = 0; }
  return { active, total, activeRate: pctOf(active, total) };
}

// 정서 긍정 비율(attendance.emotion) — 표본 작음. 부정 어휘 외 긍정 간주.
function _emotionSummary(studentIds) {
  if (!studentIds.length) return { positivePct: null, sampleN: 0 };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT emotion, emotion_score FROM attendance
      WHERE user_id IN (${_ph(studentIds)})
        AND (emotion IS NOT NULL OR emotion_score IS NOT NULL)
        AND attendance_date >= DATE('now','localtime','-30 days')
    `).all(...studentIds);
  } catch (_) { rows = []; }
  if (!rows.length) return { positivePct: null, sampleN: 0 };
  // ★ 텍스트 우선 분류(정본사전 §2-B). 과거의 `emotion_score <= 1.5 → 부정` 단일 임계는
  //   0~1 스케일로 저장된 행(seed-balance, 0.1~0.95)을 전부 '부정'으로 뒤집어
  //   학교 대시보드 '긍정 감정 비율'을 0% 로 만들었다. 감정 없는 행은 분모에서 제외.
  let pos = 0, n = 0;
  for (const r of rows) {
    const neg = isNegativeEmotion(r.emotion, r.emotion_score);
    if (neg == null) continue;
    n++;
    if (!neg) pos++;
  }
  if (!n) return { positivePct: null, sampleN: 0 };
  return { positivePct: pctOf(pos, n), sampleN: n };
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-3a 가입자 현황 — role별 + 학년별(학생).
// ─────────────────────────────────────────────────────────────────────────────
function getEnrollment(scope) {
  const schoolName = scope.schoolName;
  const byRole = {};
  const byGrade = [];
  if (schoolName) {
    for (const r of db.prepare(`
      SELECT role, COUNT(*) c FROM users
      WHERE school_name = ? AND (status IS NULL OR status='active')
      GROUP BY role
    `).all(schoolName)) byRole[r.role] = r.c;
    for (const r of db.prepare(`
      SELECT grade, COUNT(*) c FROM users
      WHERE school_name = ? AND role='student' AND grade IS NOT NULL
        AND (status IS NULL OR status='active')
      GROUP BY grade ORDER BY grade
    `).all(schoolName)) byGrade.push({ grade: r.grade, count: r.c });
  } else if (scope.isAdmin) {
    // admin 전체: 전국 role/학년 분포
    for (const r of db.prepare(`SELECT role, COUNT(*) c FROM users GROUP BY role`).all()) byRole[r.role] = r.c;
    for (const r of db.prepare(`
      SELECT grade, COUNT(*) c FROM users WHERE role='student' AND grade IS NOT NULL GROUP BY grade ORDER BY grade
    `).all()) byGrade.push({ grade: r.grade, count: r.c });
  }
  return { byRole, byGrade };
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-3b 접속(활동 기준) — 일자별 이용자수(역할별) + DAU/WAU/MAU + 시간대 히트맵.
//   "접속" = 활동 발생(lrs_user_daily / learning_logs). 라벨에 (활동 기준) 병기는 FE.
// ─────────────────────────────────────────────────────────────────────────────
function getAccess(scope, { days = 30 } = {}) {
  const ids = scope.allIds || [];
  if (!ids.length && !scope.isAdmin) {
    return { daily: [], dau: 0, wau: 0, mau: 0, hourly: [], note: '데이터 없음' };
  }
  // 학교 스코프: ID IN (...). admin 전체: 필터 없음.
  const scoped = (col) => scope.schoolName ? ` AND ${col} IN (${_ph(ids)})` : '';
  const scopedParams = scope.schoolName ? ids : [];
  const fromDay = `-${days - 1} days`;

  // 일자별 역할별 distinct 이용자수 (lrs_user_daily × users.role)
  let daily = [];
  try {
    daily = db.prepare(`
      SELECT d.stat_date AS date, u.role AS role, COUNT(DISTINCT d.user_id) AS users
      FROM lrs_user_daily d JOIN users u ON u.id = d.user_id
      WHERE d.stat_date >= DATE('now','localtime', ?) ${scoped('d.user_id')}
      GROUP BY d.stat_date, u.role ORDER BY d.stat_date ASC
    `).all(fromDay, ...scopedParams);
  } catch (_) { daily = []; }

  const dau = _distinctActive(scope, ids, '-0 days');
  const wau = _distinctActive(scope, ids, '-6 days');
  const mau = _distinctActive(scope, ids, '-29 days');

  // 시간대(요일×시간) 히트맵 — learning_logs.created_at
  let hourly = [];
  try {
    hourly = db.prepare(`
      SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dow,
             CAST(strftime('%H', created_at) AS INTEGER) AS hour,
             COUNT(*) AS cnt
      FROM learning_logs
      WHERE DATE(created_at) >= DATE('now','localtime', ?) ${scope.schoolName ? ` AND user_id IN (${_ph(ids)})` : ''}
      GROUP BY dow, hour
    `).all(fromDay, ...(scope.schoolName ? ids : []));
  } catch (_) { hourly = []; }

  return { daily, dau, wau, mau, hourly, days };
}

function _distinctActive(scope, ids, fromExpr) {
  try {
    if (scope.schoolName) {
      if (!ids.length) return 0;
      return db.prepare(`
        SELECT COUNT(DISTINCT user_id) c FROM lrs_user_daily
        WHERE stat_date >= DATE('now','localtime', ?) AND user_id IN (${_ph(ids)})
      `).get(fromExpr, ...ids).c || 0;
    }
    return db.prepare(`
      SELECT COUNT(DISTINCT user_id) c FROM lrs_user_daily
      WHERE stat_date >= DATE('now','localtime', ?)
    `).get(fromExpr).c || 0;
  } catch (_) { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-4 페이지(서비스)별 접속 — 내부 7서비스(즉시) + 외부 4서비스(external 플래그).
// ─────────────────────────────────────────────────────────────────────────────
const INTERNAL_SERVICES = ['content', 'self-learn', 'class', 'cbt', 'growth', 'portal', 'survey'];
const EXTERNAL_SERVICES = [
  { key: 'basic-literacy', label: '기초학력' },
  { key: 'change', label: '체인지' },
  { key: 'afterschool-care', label: '방과후돌봄' },
  { key: 'chaeum-plus', label: '채움더하기' },
];
const SERVICE_LABEL = {
  content: '채움콘텐츠', 'self-learn': '스스로채움', class: '채움클래스',
  cbt: '채움성장(CBT)', growth: '성장기록', portal: '포털', survey: '설문',
};

function getPages(scope, { days = 30 } = {}) {
  const ids = scope.allIds || [];
  const scoped = scope.schoolName ? ` AND user_id IN (${_ph(ids)})` : '';
  const params = scope.schoolName ? ids : [];
  const fromDay = `-${days - 1} days`;
  let rows = [];
  if (scope.schoolName ? ids.length : true) {
    try {
      rows = db.prepare(`
        SELECT source_service AS svc, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users
        FROM learning_logs
        WHERE source_service IS NOT NULL
          AND DATE(created_at) >= DATE('now','localtime', ?) ${scoped}
        GROUP BY source_service ORDER BY count DESC
      `).all(fromDay, ...params);
    } catch (_) { rows = []; }
  }
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  const internal = rows.map(r => ({
    service: r.svc, label: SERVICE_LABEL[r.svc] || r.svc,
    count: r.count, users: r.users, share: pctOf(r.count, total), external: false,
  }));
  // 외부 4서비스: 데이터 없음 — external 플래그 카드만(연계 예정).
  const external = EXTERNAL_SERVICES.map(e => ({
    service: e.key, label: e.label, count: null, users: null, share: null, external: true,
  }));
  return { internal, external, totalInternal: total === 1 && !rows.length ? 0 : total, days };
}

// ─────────────────────────────────────────────────────────────────────────────
// 오늘의 학습 — 참여/이수/정답률 (학교 학생 daily_learning_progress).
//   배정 진행행 기준 이수율 = completed / 전체행. 참여 = distinct 학생.
// ─────────────────────────────────────────────────────────────────────────────
function getTodayLearning(scope) {
  const ids = scope.studentIds || [];
  if (!ids.length) {
    return { assignedRows: 0, completed: 0, completionRate: 0, participants: 0, participationRate: 0, avgScore: null };
  }
  let row = { assignedRows: 0, completed: 0, participants: 0, avgScore: null };
  try {
    row = db.prepare(`
      SELECT COUNT(*) AS assignedRows,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
             COUNT(DISTINCT user_id) AS participants,
             AVG(CASE WHEN status='completed' THEN score END) AS avgScore
      FROM daily_learning_progress
      WHERE user_id IN (${_ph(ids)})
    `).get(...ids);
  } catch (_) { /* 테이블 부재 */ }
  const assignedRows = row.assignedRows || 0;
  const completed = row.completed || 0;
  const participants = row.participants || 0;
  return {
    assignedRows, completed,
    completionRate: pctOf(completed, assignedRows),
    participants,
    participationRate: pctOf(participants, ids.length),
    studentCount: ids.length,
    avgScore: row.avgScore == null ? null : round1(Number(row.avgScore) > 1 ? Number(row.avgScore) : Number(row.avgScore) * 100),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 학력·성취 — 학년×교과 도달률 히트맵 + 취약Top10 + 추세 + 학급격차 + 미도달자수.
//   getWeakTrend/computeTrend 재사용(userIds=학교 학생). 히트맵은 학년×교과 단순 롤업.
// ─────────────────────────────────────────────────────────────────────────────
function getAchievement(scope) {
  const students = scope.students || [];
  const ids = scope.studentIds || [];
  const gradeById = new Map(students.map(s => [s.id, s.grade]));

  // 학년×교과 도달률 히트맵 — 학생 성취 행을 학년·교과base 로 롤업(평가된 것만 분모).
  const cell = new Map(); // `${grade}|${sb}` -> {reached, evaluated, notReached}
  const overall = { reached: 0, partial: 0, notReached: 0, insufficient: 0, evaluated: 0, total: 0 };
  if (ids.length) {
    const rows = db.prepare(`
      SELECT user_id, achievement_code AS code, subject_code,
             attempt_count AS attempts, success_count AS correct, avg_score
      FROM lrs_achievement_stats WHERE user_id IN (${_ph(ids)})
    `).all(...ids);
    for (const r of rows) {
      const ctx = resolveCode(r.code);
      const sb = subjectBase(ctx.subject_code || r.subject_code);
      const grade = gradeById.get(r.user_id);
      const rate = reachRate(r.correct, r.attempts, r.avg_score);
      const status = classifyStatus(r.attempts, rate);
      overall.total++;
      if (status === STATUS.REACHED) { overall.reached++; overall.evaluated++; }
      else if (status === STATUS.PARTIAL) { overall.partial++; overall.evaluated++; }
      else if (status === STATUS.NOT_REACHED) { overall.notReached++; overall.evaluated++; }
      else overall.insufficient++;

      if (grade == null) continue;
      const key = `${grade}|${sb}`;
      if (!cell.has(key)) cell.set(key, { grade, subjectBase: sb, reached: 0, evaluated: 0, notReached: 0 });
      const c = cell.get(key);
      if (status !== STATUS.INSUFFICIENT) {
        c.evaluated++;
        if (status === STATUS.REACHED) c.reached++;
        if (status === STATUS.NOT_REACHED) c.notReached++;
      }
    }
  }
  const grades = [...new Set([...cell.values()].map(c => c.grade))].sort((a, b) => a - b);
  const subjects = [...new Set([...cell.values()].map(c => c.subjectBase))]
    .sort((a, b) => (SUBJECT_ORDER.indexOf(a) + 1 || 99) - (SUBJECT_ORDER.indexOf(b) + 1 || 99));
  const heatmap = [];
  for (const [, c] of cell) {
    heatmap.push({
      grade: c.grade, subjectBase: c.subjectBase, subject: subjectLabel(c.subjectBase),
      evaluated: c.evaluated, reached: c.reached, notReached: c.notReached,
      reachedRate: c.evaluated > 0 ? round1((c.reached / c.evaluated) * 100) : null,
      // n<10 교차드릴: 개별 비노출 정책 — masked 플래그(라우트가 카운트만 노출하도록).
      crossMasked: c.evaluated < MIN_CROSS_N,
    });
  }
  heatmap.sort((a, b) => a.grade - b.grade || (SUBJECT_ORDER.indexOf(a.subjectBase) - SUBJECT_ORDER.indexOf(b.subjectBase)));

  // 취약 성취기준 Top10 (학교 전체) — analytics 재사용.
  const weakTop = ids.length ? analytics.getWeakTrend({ userIds: ids, limit: 10 }) : [];

  // 학교 전체 성취 추세
  const trend = ids.length ? analytics.computeTrend({ userIds: ids }) : { status: 'insufficient', observedWeeks: 0 };

  // 학급 간 격차 — 학교 소유 클래스별 도달률 분산(최고-최저).
  const classGap = _classGap(scope);

  // 미도달자수(학년별) — 학생 단위로 "미도달 성취기준 1개 이상" 학생 수.
  const notReachedByGrade = _notReachedStudentsByGrade(scope, gradeById);

  // 오늘의 학습 참여/이수/정답률(③에도 포함 — 기획서)
  const todayLearning = getTodayLearning(scope);

  return {
    overall: {
      ...overall,
      reachedRate: overall.evaluated > 0 ? round1((overall.reached / overall.evaluated) * 100) : null,
    },
    grades, subjects, heatmap,
    weakTop, trend, classGap, notReachedByGrade,
    todayLearning,
    minCrossN: MIN_CROSS_N,
  };
}

// 학급 간 격차 — 학교 소유 클래스 각각의 도달률(멤버 학생 성취 롤업) min/max/스프레드.
function _classGap(scope) {
  if (!scope.schoolName) return { classes: [], maxRate: null, minRate: null, spread: null };
  let classIds = [];
  try {
    classIds = db.prepare(`SELECT id, name FROM classes WHERE school_name = ? AND (status IS NULL OR status='active')`).all(scope.schoolName);
  } catch (_) { classIds = []; }
  const out = [];
  for (const c of classIds) {
    // [P1-C] 학급 간 격차의 반 모집단 — SSOT 경유(옛 손 SQL 은 개설자·탈퇴자·삭제 계정 통과).
    let memberIds = [];
    try {
      memberIds = classDb.getClassStudentIds(c.id);
    } catch (_) { memberIds = []; }
    if (!memberIds.length) continue;
    const roll = _schoolAchievementRollup(memberIds);
    if (roll.reachedRate != null) {
      out.push({ classId: c.id, name: c.name, reachedRate: roll.reachedRate, evaluated: roll.evaluated, studentCount: memberIds.length });
    }
  }
  out.sort((a, b) => b.reachedRate - a.reachedRate);
  const rates = out.map(o => o.reachedRate);
  const maxRate = rates.length ? Math.max(...rates) : null;
  const minRate = rates.length ? Math.min(...rates) : null;
  return { classes: out, maxRate, minRate, spread: (maxRate != null && minRate != null) ? round1(maxRate - minRate) : null };
}

// 학년별 미도달자수 — 미도달 성취기준 1개 이상 보유한 학생 수.
function _notReachedStudentsByGrade(scope, gradeById) {
  const ids = scope.studentIds || [];
  const out = new Map(); // grade -> Set(userId)
  if (!ids.length) return [];
  const rows = db.prepare(`
    SELECT user_id, achievement_code AS code, attempt_count AS attempts, success_count AS correct, avg_score
    FROM lrs_achievement_stats WHERE user_id IN (${_ph(ids)})
  `).all(...ids);
  for (const r of rows) {
    const rate = reachRate(r.correct, r.attempts, r.avg_score);
    if (classifyStatus(r.attempts, rate) !== STATUS.NOT_REACHED) continue;
    const g = gradeById.get(r.user_id);
    if (g == null) continue;
    if (!out.has(g)) out.set(g, new Set());
    out.get(g).add(r.user_id);
  }
  return [...out.entries()].map(([grade, set]) => ({ grade, students: set.size })).sort((a, b) => a.grade - b.grade);
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-6 사회·정서 — 위험군(학년별) + 미도달/위기 명단(실명은 라우트가 결정) + 정서·출결.
//   list 는 항상 userId·name·grade 동반(라우트가 실명/마스킹 적용).
// ─────────────────────────────────────────────────────────────────────────────
function getSafety(scope) {
  const students = scope.students || [];
  const gradeById = new Map(students.map(s => [s.id, s.grade]));
  const risk = students.length ? analytics.getClassRiskList(null, students) : { list: [], summary: { high: 0, medium: 0, low: 0, total: 0 } };

  // 위험군 학년별 분포(high/medium)
  const byGrade = new Map();
  for (const r of risk.list) {
    const g = gradeById.get(r.userId);
    if (g == null) continue;
    if (!byGrade.has(g)) byGrade.set(g, { grade: g, high: 0, medium: 0, low: 0 });
    byGrade.get(g)[r.grade] = (byGrade.get(g)[r.grade] || 0) + 1;
  }
  const riskByGrade = [...byGrade.values()].sort((a, b) => a.grade - b.grade);

  // 위기 명단(위험 높음/보통 우선) — grade 부착. 실명/마스킹은 라우트.
  const watchlist = risk.list
    .filter(r => r.grade === 'high' || r.grade === 'medium')
    .map(r => ({ userId: r.userId, name: r.name, grade: gradeById.get(r.userId) ?? null,
                 score: r.score, riskGrade: r.grade, riskGradeKo: r.gradeKo,
                 reasons: r.reasons, confidence: r.confidence, confidenceKo: r.confidenceKo }));

  // 정서 추이(주별 부정 비율) + 출석률 — 표본 작음.
  const emotionTrend = _emotionWeeklyTrend(scope.studentIds);
  const attendance = _attendanceRate(scope.studentIds);

  // 정서 요약(최근 30일 긍정/부정 비율) — ⓪요약과 동일 산식 재사용. 긍정 균형 표시용.
  const emo = _emotionSummary(scope.studentIds);
  const emotion = {
    positivePct: emo.positivePct,
    negativePct: (emo.sampleN > 0 && emo.positivePct != null) ? 100 - emo.positivePct : null,
    sampleN: emo.sampleN,
  };

  // 연속 무활동 학생 수(7일+ 공백) — lrs_user_daily.
  const inactive = _inactiveCount(scope.studentIds, 7);

  return {
    riskSummary: risk.summary, riskByGrade, watchlist,
    emotion, emotionTrend, attendance, inactive,
  };
}

function _emotionWeeklyTrend(ids) {
  if (!ids || !ids.length) return { weeks: [], sampleN: 0 };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT strftime('%Y-%W', attendance_date) AS week, emotion, emotion_score
      FROM attendance
      WHERE user_id IN (${_ph(ids)}) AND (emotion IS NOT NULL OR emotion_score IS NOT NULL)
        AND attendance_date >= DATE('now','localtime','-56 days')
    `).all(...ids);
  } catch (_) { rows = []; }
  // ★ 텍스트 우선 분류(정본사전 §2-B) — _emotionSummary 와 동일 사유. 감정 없는 행은 분모 제외.
  const byWeek = new Map();
  for (const r of rows) {
    const isNeg = isNegativeEmotion(r.emotion, r.emotion_score);
    if (isNeg == null) continue;
    if (!byWeek.has(r.week)) byWeek.set(r.week, { week: r.week, neg: 0, total: 0 });
    const w = byWeek.get(r.week); w.total++;
    if (isNeg) w.neg++;
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.week < b.week ? -1 : 1)
    .map(w => ({ week: w.week, negativePct: pctOf(w.neg, w.total), sampleN: w.total }));
  return { weeks, sampleN: rows.length };
}

function _attendanceRate(ids) {
  if (!ids || !ids.length) return { presentRate: null, sampleN: 0 };
  let row = { present: 0, total: 0 };
  try {
    row = db.prepare(`
      SELECT SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present, COUNT(*) AS total
      FROM attendance WHERE user_id IN (${_ph(ids)})
    `).get(...ids);
  } catch (_) {}
  return { presentRate: row.total ? pctOf(row.present || 0, row.total) : null, sampleN: row.total || 0 };
}

function _inactiveCount(ids, gapDays) {
  if (!ids || !ids.length) return { count: 0, gapDays };
  let count = 0;
  try {
    // 마지막 활동일이 gapDays 이전이거나, 활동 기록이 아예 없는 학생.
    const active = db.prepare(`
      SELECT user_id, MAX(stat_date) last FROM lrs_user_daily
      WHERE user_id IN (${_ph(ids)}) GROUP BY user_id
    `).all(...ids);
    const lastMap = new Map(active.map(r => [r.user_id, r.last]));
    for (const uid of ids) {
      const last = lastMap.get(uid);
      if (!last) { count++; continue; }
      const g = db.prepare("SELECT CAST(julianday('now','localtime') - julianday(?) AS INTEGER) g").get(last).g;
      if ((Number(g) || 0) >= gapDays) count++;
    }
  } catch (_) { count = 0; }
  return { count, gapDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-7 교직원·수업 운영 — 교사별 활동량 + 활성/휴면 클래스 + 자체제작/공유 비중.
// ─────────────────────────────────────────────────────────────────────────────
function getStaffOps(scope) {
  const schoolName = scope.schoolName;
  if (!schoolName) {
    return { teachers: [], classHealth: { active: 0, dormant: 0, total: 0 }, contentMix: { own: 0, shared: 0 } };
  }
  // 학교 교사 목록
  let teachers = [];
  try {
    teachers = db.prepare(`
      SELECT id, COALESCE(display_name, username) AS name FROM users
      WHERE school_name = ? AND role='teacher' AND (status IS NULL OR status='active')
    `).all(schoolName);
  } catch (_) { teachers = []; }
  const tIds = teachers.map(t => t.id);

  // 교사별 수업/과제/평가/콘텐츠 건수
  const lessonCnt = _countBy(tIds, 'lessons', 'teacher_id');
  const hwCnt = _countBy(tIds, 'homework', 'teacher_id');
  const examCnt = _countBy(tIds, 'exams', 'owner_id');
  const contentCnt = _countBy(tIds, 'contents', 'creator_id');

  const teacherRows = teachers.map(t => ({
    teacherId: t.id, name: t.name,
    lessons: lessonCnt.get(t.id) || 0,
    homework: hwCnt.get(t.id) || 0,
    exams: examCnt.get(t.id) || 0,
    contents: contentCnt.get(t.id) || 0,
    total: (lessonCnt.get(t.id) || 0) + (hwCnt.get(t.id) || 0) + (examCnt.get(t.id) || 0) + (contentCnt.get(t.id) || 0),
  })).sort((a, b) => b.total - a.total);

  // 활성/휴면 클래스
  const cls = _activeClassRate(schoolName);
  const classHealth = { active: cls.active, dormant: cls.total - cls.active, total: cls.total };

  // 자체제작 vs 공유 비중(학교 교사 creator 콘텐츠)
  let own = 0, shared = 0;
  if (tIds.length) {
    try {
      const cm = db.prepare(`
        SELECT
          SUM(CASE WHEN official_tag IS NULL OR official_tag='' THEN 1 ELSE 0 END) AS own,
          SUM(CASE WHEN official_tag IS NOT NULL AND official_tag<>'' THEN 1 ELSE 0 END) AS shared
        FROM contents WHERE creator_id IN (${_ph(tIds)})
      `).get(...tIds);
      own = cm.own || 0; shared = cm.shared || 0;
    } catch (_) {}
  }

  return { teachers: teacherRows, classHealth, contentMix: { own, shared, total: own + shared } };
}

function _countBy(ids, table, col) {
  const m = new Map();
  if (!ids.length) return m;
  try {
    for (const r of db.prepare(`
      SELECT ${col} AS owner, COUNT(*) c FROM ${table} WHERE ${col} IN (${_ph(ids)}) GROUP BY ${col}
    `).all(...ids)) m.set(r.owner, r.c);
  } catch (_) {}
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// 규칙기반 자동 인사이트(가짜 AI 금지) — 임계 룰 + 근거 문장 + 신뢰도/표본 꼬리표.
//   입력: overview KPI + achievement(히트맵·취약·추세) + safety + 보충(옵션).
//   반환: [{ id, severity, text, evidence, confidence, sample, tab }]
// ─────────────────────────────────────────────────────────────────────────────
function buildInsights({ overview, achievement, safety }) {
  const out = [];
  const schoolAvg = achievement && achievement.overall ? achievement.overall.reachedRate : null;

  // 룰1: 학교 평균 대비 -10%p 이상 낮은 (학년,교과)
  if (schoolAvg != null && achievement && achievement.heatmap) {
    const lows = achievement.heatmap
      .filter(c => c.reachedRate != null && !c.crossMasked && (schoolAvg - c.reachedRate) >= 10)
      .sort((a, b) => (a.reachedRate - b.reachedRate));
    for (const c of lows.slice(0, 2)) {
      out.push({
        id: `low-${c.grade}-${c.subjectBase}`, severity: 'warn', tab: 'academics',
        text: `${c.grade}학년 ${c.subject} 도달률 ${c.reachedRate}% — 학교 평균(${schoolAvg}%)보다 ${round1(schoolAvg - c.reachedRate)}%p 낮습니다. 점검 권장.`,
        evidence: { grade: c.grade, subject: c.subject, reachedRate: c.reachedRate, schoolAvg, evaluated: c.evaluated },
        confidence: c.evaluated >= MIN_CROSS_N ? 'medium' : 'low',
        sample: c.evaluated,
      });
    }
  }

  // 룰2: 학교 전체 추세 하락(direction='down' & 신뢰 낮음 아님)
  const tr = achievement && achievement.trend;
  if (tr && tr.status === 'ok' && tr.direction === 'down' && tr.confidence !== 'low') {
    out.push({
      id: 'trend-down', severity: 'warn', tab: 'academics',
      text: `학교 전체 성취 추세가 최근 ${tr.observedWeeks}주 하락 중입니다(${tr.slope}%p/주). 원인 점검 권장.`,
      evidence: { slope: tr.slope, observedWeeks: tr.observedWeeks, currentRate: tr.currentRate },
      confidence: tr.confidence, sample: tr.observedWeeks,
    });
  }

  // 룰3: 학년 위험군 비율 20% 초과
  if (safety && safety.riskByGrade && overview && overview.gradeBars) {
    const gradeTotal = new Map(overview.gradeBars.map(g => [g.grade, g.count]));
    for (const rg of safety.riskByGrade) {
      const total = gradeTotal.get(rg.grade) || 0;
      if (total <= 0) continue;
      const ratio = pctOf(rg.high || 0, total);
      if (ratio > 20) {
        out.push({
          id: `risk-${rg.grade}`, severity: 'warn', tab: 'safety',
          text: `${rg.grade}학년 지원필요(위험 높음) 학생 비율이 높습니다(${ratio}%, ${rg.high}/${total}명). 정서·출석 점검 권장.`,
          evidence: { grade: rg.grade, high: rg.high, total, ratio },
          confidence: total >= MIN_CROSS_N ? 'medium' : 'low', sample: total,
        });
      }
    }
  }

  // 룰4: 학급 간 격차 큼(스프레드 >= 30%p)
  const gap = achievement && achievement.classGap;
  if (gap && gap.spread != null && gap.spread >= 30 && gap.classes.length >= 2) {
    out.push({
      id: 'class-gap', severity: 'caution', tab: 'academics',
      text: `학급 간 도달률 격차가 큽니다(최고 ${gap.maxRate}% ─ 최저 ${gap.minRate}%, 격차 ${gap.spread}%p). 하위 학급 지원 검토.`,
      evidence: { maxRate: gap.maxRate, minRate: gap.minRate, spread: gap.spread },
      confidence: 'medium', sample: gap.classes.length,
    });
  }

  // 룰5: 오늘의 학습 참여율 저조(<40%)
  const dl = overview && overview.todayLearning;
  if (dl && dl.studentCount > 0 && dl.participationRate < 40) {
    out.push({
      id: 'daily-low', severity: 'caution', tab: 'services',
      text: `오늘의 학습 참여율이 낮습니다(${dl.participationRate}%, ${dl.participants}/${dl.studentCount}명). 담임 독려 권장.`,
      evidence: { participants: dl.participants, studentCount: dl.studentCount, rate: dl.participationRate },
      confidence: 'high', sample: dl.studentCount,
    });
  }

  // 표본 작은 학교 전반 경고(없으면 추가)
  if (!out.length) {
    out.push({
      id: 'ok', severity: 'ok', tab: 'overview',
      text: '현재 임계 규칙에 걸리는 시급한 이슈가 없습니다. 세부 탭에서 추세를 계속 확인하세요.',
      evidence: {}, confidence: 'medium', sample: overview ? overview.studentCount : 0,
    });
  }
  // 소표본 꼬리표
  for (const o of out) {
    if (o.sample != null && o.sample < MIN_CROSS_N) o.text += ' (표본이 적어 참고용)';
  }
  return out;
}

module.exports = {
  MIN_CROSS_N, INTERNAL_SERVICES, EXTERNAL_SERVICES, SERVICE_LABEL,
  subjectBase,
  getOverviewKpis, getEnrollment, getAccess, getPages, getTodayLearning,
  getAchievement, getSafety, getStaffOps, buildInsights,
  _schoolAchievementRollup, // 테스트용 export
};
