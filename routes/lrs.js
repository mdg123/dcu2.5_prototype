const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/index');
const lrsDb = require('../db/lrs');
const classDb = require('../db/class');
const mastery = require('../db/lrs-mastery');
const analytics = require('../db/lrs-analytics');
const supplement = require('../db/lrs-supplement');
const { rebuildAllAggregates } = require('../db/lrs-aggregate');
const { logLearningActivity } = require('../db/learning-log-helper');
const { LRS_CONFIG } = require('../lib/lrs-config');

/**
 * CSV 셀 injection 방어 — 값이 수식/명령 프리픽스(=, +, -, @, TAB, CR)로 시작하면
 * 작은따옴표를 앞에 붙여 Excel/Sheets가 수식으로 해석하지 못하게 한다.
 * 콤마/따옴표/개행은 기존대로 RFC 4180 quoting 적용.
 */
function csvEscapeCell(v) {
  if (v == null) return '';
  let s = String(v);
  // CSV injection 방어 (OWASP): 첫 글자가 =, +, -, @, 탭, CR 이면 ' 로 prefix
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// /log 화이트리스트: student 역할은 서버 산출/민감 필드 주입 금지
const LOG_STUDENT_FIELDS = new Set([
  'activity_type','verb','target_type','target_id','object_type','object_id',
  'class_id','source_service','subject_code','grade_group','session_id',
  'device_type','platform','duration_sec','duration','result_duration',
  'metadata','activity_id'
]);

// REWORK-2: 학부모 리포트 점수 마스킹 라벨도 STATUS_KO 어휘로 통일(도달/부분도달/미도달).
//   기존 상/중/하 어휘는 다른 경로(도달/부분도달)와 같은 level 필드에서 이원화되어
//   API 계약 일관성을 깼다. 단일 분류기와 동일 임계(80/50)·동일 어휘로 산출한다.
//   (점수 원값은 비노출 — 비율→레이블만 반환. 데이터 없으면 null.)
function maskDigestScore(val) {
  if (val == null) return null;
  const ratio = (typeof val === 'number' && val > 1) ? val / 100 : val;
  if (ratio >= 0.80) return '도달';
  if (ratio >= 0.50) return '부분도달';
  return '미도달';
}

// ─────────────────────────────────────────────────────────
// 서비스/교과 코드 → 한글 표시명 매핑 (UI 범례용)
// 알려지지 않은 코드는 원본 코드를 그대로 label로 사용 (폴백)
// ─────────────────────────────────────────────────────────
const SERVICE_LABELS = {
  'class': '채움클래스',
  'content': '채움콘텐츠',
  'exam': '채움평가',
  'self-learn': '스스로채움',
  'growth': '성장기록',
  'cbt': '채움성장',
  'lrs': '학습분석',
  'homework': '과제',
  'attendance': '출결',
  'board': '알림장',
  'survey': '설문',
  'lesson': '수업',
  'portal': '포털',
  'external': '외부연계'
};
const SUBJECT_LABELS = {
  'KOR': '국어', 'MAT': '수학', 'ENG': '영어',
  'SCI': '과학', 'SOC': '사회', 'ART': '예술',
  'PE': '체육', 'MUS': '음악', 'MOR': '도덕', 'PRA': '실과',
  // 시드 데이터 교과코드(소문자 -e/-m/-h 접미) 매핑
  'korean': '국어', 'math': '수학', 'english': '영어',
  'science': '과학', 'social': '사회', 'art': '예술/미술',
  'music': '음악', 'moral': '도덕', 'pe': '체육', 'practical': '실과'
};
function serviceLabel(code) {
  if (code == null) return '';
  return SERVICE_LABELS[code] || String(code);
}
function subjectLabel(code, fallback) {
  if (code == null) return fallback || '';
  if (SUBJECT_LABELS[code]) return SUBJECT_LABELS[code];
  // 시드 교과코드: 'math-e' / 'korean-m' → 접미사 제거 후 매핑
  const base = String(code).replace(/-[emh]$/i, '');
  if (SUBJECT_LABELS[base]) return SUBJECT_LABELS[base];
  return fallback || String(code);
}

// ─────────────────────────────────────────────────────────
// 공용 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * 기간 파라미터 통일: period=7d|30d|90d|custom + from/to.
 * 반환: { fromDate, toDate, label }
 *
 * [P2 오프바이원 — 의도적 미적용] start=today-n 이라 period=7d 가 양끝 포함 8일 창을 만든다
 *   (정확히는 today-(n-1) 이 7일). 전수감사에서 지적됐으나, 이 함수는 LRS 의 거의 모든 기간 엔드포인트가
 *   공유하는 단일 출처라 하루 시프트가 daily-snapshot 의 spanDays·직전동기간 창까지 파급된다.
 *   P0(점수 정규화)·P1(약점/교과/기간) 우선 원칙에 따라 이번 배치에서는 손대지 않았다.
 *   (수정 시 start.setDate(getDate()-(n-1)) 로 바꾸고 daily-snapshot spanDays/prev 창 재검증 필요.)
 */
function resolvePeriod(req) {
  const { period, from, to, days } = req.query;
  const today = new Date();
  const toIso = (d) => d.toISOString().slice(0, 10);

  if (period && period !== 'custom') {
    const n = parseInt(String(period).replace('d', ''), 10);
    if (!isNaN(n)) {
      const start = new Date(today);
      start.setDate(start.getDate() - n);
      return { fromDate: toIso(start), toDate: toIso(today), label: `${n}d` };
    }
  }
  if (from || to) {
    // from > to 검증: 두 값 모두 주어졌고 역전된 경우 invalid 마킹
    if (from && to && String(from) > String(to)) {
      return { fromDate: from, toDate: to, label: 'custom', invalid: true, reason: 'from > to' };
    }
    return { fromDate: from || null, toDate: to || null, label: 'custom' };
  }
  // 레거시 days 파라미터 지원
  if (days) {
    const n = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    const start = new Date(today);
    start.setDate(start.getDate() - n);
    return { fromDate: toIso(start), toDate: toIso(today), label: `${n}d` };
  }
  // 기본 30일
  const start = new Date(today);
  start.setDate(start.getDate() - 30);
  return { fromDate: toIso(start), toDate: toIso(today), label: '30d' };
}

function dateRangeWhere(req, col = 'created_at', alias = '') {
  const c = alias ? `${alias}.${col}` : col;
  const period = resolvePeriod(req);
  const { fromDate, toDate, invalid, reason } = period;
  let where = ''; const params = [];
  if (fromDate) { where += ` AND DATE(${c}) >= ?`; params.push(fromDate); }
  if (toDate)   { where += ` AND DATE(${c}) <= ?`; params.push(toDate); }
  return { where, params, hasRange: !!(fromDate || toDate), fromDate, toDate, invalid: !!invalid, reason };
}

/** 공통 400 응답: resolvePeriod 가 invalid=true 를 반환했을 때. */
function sendInvalidPeriod(res, reason) {
  return res.status(400).json({ success: false, message: `잘못된 기간 파라미터: ${reason || 'from > to'}` });
}

/** 역할 가드: 본인이거나 teacher/admin만 허용 */
function canViewUser(req, targetUserId) {
  if (!req.user) return false;
  if (req.user.id === targetUserId) return true;
  return req.user.role === 'teacher' || req.user.role === 'admin';
}

// ── 학급(peer) 집합 공용 헬퍼 — P1-3 스펙 §4-2 ────────────────────────────
// 표본 가드: 반 학생 수가 이 미만이면 익명 집계여도 비교 비노출(개인정보/신뢰도).
//   peer-compare 와 /trend/student(withClass=1) classTrend 가 공유하는 단일 정책값.
const MIN_PEERS = 5;

/**
 * peer 집합 산출 — 대상 학생이 소속된 반들(student 멤버십)의 student 멤버 합집합.
 * 본인 포함(peer-compare 기존 정책과 동일 — 스펙 §4-2 문서화).
 * peer-compare 핸들러의 인라인 로직을 추출한 공용 헬퍼(산식 2벌 금지 —
 * "학급"의 정의가 두 화면에서 갈리면 안 됨).
 * @param {number} userId 대상 학생 id
 * @returns {{ classIds:number[], peerIds:number[] }} 반 없음이면 둘 다 빈 배열
 */
function _peerIdsOf(userId) {
  const classRows = db.prepare(`
    SELECT cm.class_id FROM class_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.user_id = ? AND u.role = 'student'
  `).all(userId);
  const classIds = [...new Set(classRows.map(r => r.class_id))];
  if (!classIds.length) return { classIds: [], peerIds: [] };
  const ph = classIds.map(() => '?').join(',');
  const peerIds = db.prepare(`
    SELECT DISTINCT cm.user_id AS id FROM class_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.class_id IN (${ph}) AND u.role = 'student'
  `).all(...classIds).map(r => r.id);
  return { classIds, peerIds };
}

// ─────────────────────────────────────────────────────────
// 점수 정규화 공통 정의 (단일 출처)
//   /insights 의 "평균 성취(periodScoreAvg)" 모집단.
//   과거 /insights 는 lrs_user_daily.avg_score(0~1·0~100 혼재 저장)를 그대로 AVG 해
//   perform 표(평가 94.5·자기주도 92·콘텐츠 100)와 값이 어긋났다(사용자 실측 결함).
//   → learning_logs 원천에서 채점된(SCORED) 유형만, NORM_SCORE(≤1이면 ×100)로 0~100 정규화해 평균.
//
//   ★ 모집단 = "학습활동 7종" 중 '점수(정답률)' 개념이 있는 것만.
//     포함: exam_complete·homework_submit·content_solve·self_learn·daily_complete·wrong_note_retry
//           (+ node_complete: AI 차시 이수, 향후 점수 있으면 자동 포함. 현재 0건)
//     제외: lesson_progress — result_score 가 '진도율(0.5~1)'이라 정답률이 아님(DB 실측 확인).
//           그대로 넣으면 진도 50% 가 '성취 50점'으로 오염된다 → 반드시 제외.
//     제외: content_view·post_create·attendance_checkin·survey_respond·homework_graded 등 7종 밖.
//   (DB 실측: wrong_note_retry avg 68·min 24 = 실제 정답률 → 포함. lesson_progress avg 0.54 = 진도율 → 제외.)
// ─────────────────────────────────────────────────────────
const LRS_SCORED_TYPES = [
  'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'wrong_note_retry', 'node_complete'
];
const LRS_SCORED_SQL = `ll.activity_type IN ('exam_complete','homework_submit','content_solve','self_learn','daily_complete','wrong_note_retry','node_complete')`;
//   행 단위 0~1 값이면 ×100 → 모든 평균을 0~100 스케일로 통일 (perform L2019 와 동일 식).
const LRS_NORM_SCORE = `(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)`;

// ─────────────────────────────────────────────────────────
// [P0 시스템성] 점수 스케일 정규화 공통 헬퍼 (단일 출처)
//   DB 저장 스케일 혼재: 시험 등 일부 유형은 result_score 를 0~1 로, 콘텐츠 등은 0~100 로 저장한다.
//   (실측: self_learn 은 같은 유형 안에서도 0.61~100 이 섞임.) 정규화 없이 AVG(result_score) 를
//   그대로 내보내면 "학급 평균 성취 8.5점"(실제 ≈78) 같은 붕괴가 난다.
//   → 모든 '평균 점수' 반환 사이트는 반드시 아래 두 조각을 통과시켜 0~100 스케일로 통일한다.
//
//   ★ 진도형 제외 필수: lesson_progress 는 result_score 가 '진도율(0.5~1.0)'이라 정답률이 아니다.
//     (0.54 가 54점으로 오염되면 안 됨.) 점수 평균 모집단에서 항상 제외한다.
//
//   임의 별칭(alias) 지원: perform 은 'll', by-service/daily 도 'll', by-achievement 는 별칭 없음.
//     - normScoreExpr(alias): (CASE WHEN <col> <= 1 THEN <col>*100 ELSE <col> END)  — 행 단위 0~100 정규화
//     - scoredWhere(alias):   진도형(lesson_progress)·점수없음 유형을 제외하는 화이트리스트 조각
//   각 사이트에서 AVG(result_score) → AVG(normScoreExpr(alias)), 그리고 WHERE 에 scoredWhere(alias) 를 AND 로 건다.
// ─────────────────────────────────────────────────────────
const LRS_SCORED_TYPES_SQL_LIST = "'exam_complete','homework_submit','content_solve','self_learn','daily_complete','wrong_note_retry','node_complete'";
/** 행 단위 result_score 를 0~100 로 정규화하는 SQL 조각. alias 없으면 컬럼만. */
function normScoreExpr(alias) {
  const col = alias ? `${alias}.result_score` : 'result_score';
  return `(CASE WHEN ${col} <= 1 THEN ${col}*100 ELSE ${col} END)`;
}
/** 점수(정답률) 개념이 있는 유형만 남기는 SQL 조각 — 진도형(lesson_progress) 등 자동 제외. */
function scoredWhere(alias) {
  const col = alias ? `${alias}.activity_type` : 'activity_type';
  return `${col} IN (${LRS_SCORED_TYPES_SQL_LIST})`;
}

/**
 * 선택 기간(pFrom~pTo) 내, 특정 학생의 채점된 학습로그 평균 성취(0~100 정규화).
 *   - /stats/perform summary avg 와 동일 로직(같은 SCORED_SQL·NORM_SCORE·기간 필터) 재사용.
 *   - 점수 없는 유형(lesson_progress·content_view·감정출석·게시글·설문 등)은 result_score 유무와
 *     무관하게 SCORED_SQL 밖이므로 자동 제외.
 *   - 데이터(채점된 로그) 0건이면 null 반환(0 아님 — "성취 없음"과 "0점"을 혼동하지 않게).
 * @returns {number|null} 0~100 (소수1자리 반올림) 또는 null
 */
function computeNormScoreAvg(userId, pFrom, pTo) {
  const row = db.prepare(`
    SELECT AVG(${LRS_NORM_SCORE}) AS avg_score
    FROM learning_logs ll
    WHERE ll.user_id = ?
      AND ${LRS_SCORED_SQL}
      AND ll.result_score IS NOT NULL
      ${pFrom ? 'AND DATE(ll.created_at) >= ?' : ''}
      ${pTo ? 'AND DATE(ll.created_at) <= ?' : ''}
  `).get(userId, ...(pFrom ? [pFrom] : []), ...(pTo ? [pTo] : []));
  if (!row || row.avg_score == null) return null;
  return Math.round(row.avg_score * 10) / 10;
}

// ─────────────────────────────────────────────────────────
// "학습활동" 정본 화이트리스트 (사용자 확정 7종 — 능동 이수·응시·제출·풀이).
//   PM 확정 정의 + learning_logs 실 activity_type 검증(코드/DB 대조) 결과 매핑:
//     1) 수업꾸러미(수업) 이수      → 'lesson_progress'   (routes/lesson.js:188, verb=completed 시 이수.
//                                       'lesson_view'(verb=accessed, 7440건)는 '조회'라 제외)
//     2) 평가 응시                  → 'exam_complete'
//     3) 과제 제출                  → 'homework_submit'
//     4) 콘텐츠 문항 바로 풀이       → 'content_solve'
//     5) 스스로채움 오늘의학습       → 'self_learn' ∪ 'daily_complete'
//     6) AI 맞춤학습 차시 노드 이수  → 'node_complete'    (db/self-learn-extended.js:2383·2491,
//                                       source=self-learn, verb=completed. 신규 이벤트 — 과거 데이터엔 0건)
//     7) 오답노트 문항 풀이         → 'wrong_note_retry'
//   제외(학습활동 아님): content_view(단순 조회/시청), post_create, attendance_checkin,
//     survey_respond, homework_graded(교사 채점 이벤트), lesson_view(조회),
//     content_complete·problem_attempt·problem_set_complete·diagnosis_complete(7종 밖).
//   → todayActs 는 전 유형 총건수(참고), todayLearnActs 는 이 7종만.
// ─────────────────────────────────────────────────────────
const LRS_LEARN_ACTIVITY_TYPES = [
  'lesson_progress',                    // 1) 수업꾸러미 이수
  'exam_complete',                      // 2) 평가 응시
  'homework_submit',                    // 3) 과제 제출
  'content_solve',                      // 4) 콘텐츠 문항 바로 풀이
  'self_learn', 'daily_complete',       // 5) 오늘의 학습
  'node_complete',                      // 6) AI 맞춤학습 차시 노드 이수
  'wrong_note_retry'                    // 7) 오답노트 문항 풀이
];

/** 서버 로컬 날짜 기준 오늘/어제 ISO(YYYY-MM-DD). */
function localDateIso(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  // 로컬 타임존 기준 날짜(주의: toISOString은 UTC라 자정 근처 오차 → 로컬 파트로 조립)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 특정 날짜(dateIso) 하루 동안 학생의 활동 건수.
 *   - period 파라미터와 무관 — 항상 그 하루만 센다(FE rangeQS 우회 불필요).
 *   - total       : 전 유형(참고용)
 *   - learn       : 학습활동 7종(LRS_LEARN_ACTIVITY_TYPES)만 — 정본 '학습' 카운트.
 *   - contentView : content_view(콘텐츠 조회/시청) — 학습활동 합계에서 분리한 별도 지표.
 * @returns {{ total:number, learn:number, contentView:number }}
 */
function countActivitiesOnDate(userId, dateIso) {
  const learnPH = LRS_LEARN_ACTIVITY_TYPES.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN activity_type IN (${learnPH}) THEN 1 ELSE 0 END) AS learn,
      SUM(CASE WHEN activity_type = 'content_view' THEN 1 ELSE 0 END) AS content_view
    FROM learning_logs
    WHERE user_id = ? AND DATE(created_at) = ?
  `).get(...LRS_LEARN_ACTIVITY_TYPES, userId, dateIso);
  return { total: row.total || 0, learn: row.learn || 0, contentView: row.content_view || 0 };
}

/**
 * scope 파라미터 해석 헬퍼 (역할 스위처 대응).
 *  - scope=mine  : user_id = 본인
 *  - scope=class : 교사 소유 반 집합(owner_id=본인)의 class_id IN (...)
 *  - scope=all   : admin 전용 (전체)
 * 미전달 시 기존 동작: admin → all, teacher → class, 그 외 → mine.
 * 권한 미달 시 mine 으로 다운그레이드.
 * colAlias: 'll' 처럼 별칭을 쓰면 user_id / class_id 앞에 붙여 반환.
 */
function resolveScopeFilter(req, colAlias) {
  const prefix = colAlias ? `${colAlias}.` : '';
  const requested = String(req.query.scope || '').toLowerCase();
  const role = req.user && req.user.role;
  let scope = requested;
  if (scope === 'all' && role !== 'admin') scope = 'mine';
  if (scope === 'class' && role !== 'teacher' && role !== 'admin') scope = 'mine';
  if (!scope) {
    scope = role === 'admin' ? 'all' : (role === 'teacher' ? 'class' : 'mine');
  }

  if (scope === 'all') {
    return { where: '', params: [], scope, downgraded: requested && requested !== scope };
  }
  if (scope === 'mine') {
    return {
      where: ` AND ${prefix}user_id = ?`,
      params: [req.user.id],
      scope,
      downgraded: requested && requested !== scope
    };
  }
  // class
  let classIds = [];
  try {
    classIds = db.prepare('SELECT id FROM classes WHERE owner_id = ?').all(req.user.id).map(r => r.id);
  } catch (_) { classIds = []; }
  if (!classIds.length) {
    // 폴백: 소유한 반이 없으면 mine 으로 다운그레이드
    return {
      where: ` AND ${prefix}user_id = ?`,
      params: [req.user.id],
      scope: 'mine',
      downgraded: true
    };
  }
  const placeholders = classIds.map(() => '?').join(',');
  return {
    where: ` AND ${prefix}class_id IN (${placeholders})`,
    params: classIds,
    scope,
    downgraded: requested && requested !== scope
  };
}

/**
 * §C-5 멤버십 기반 scope 필터.
 *   resolveScopeFilter 는 class scope 를 `class_id IN (...)` 로 거른다. 하지만
 *   self-learn(99.4%)·content(99.6%) 로그는 class_id 가 NULL → 교사 class scope 가 0건.
 *   이 헬퍼는 class scope 를 **class_members.user_id 멤버십 조인**(소유 반 학생 합집합)으로
 *   바꿔 "교사가 우리 반 학생의 AI맞춤학습 등 자기주도 활동을 보게" 한다.
 *   - scope=mine  : user_id = 본인
 *   - scope=class : user_id IN (교사 소유 반들의 student 멤버) — class_id NULL 도 포착
 *   - scope=all   : admin 전용 (필터 없음)
 *   미전달/권한미달 시 resolveScopeFilter 와 동일 규칙으로 다운그레이드.
 */
function resolveMembershipScopeFilter(req, colAlias) {
  const prefix = colAlias ? `${colAlias}.` : '';
  const requested = String(req.query.scope || '').toLowerCase();
  const role = req.user && req.user.role;
  let scope = requested;
  if (scope === 'all' && role !== 'admin') scope = 'mine';
  if (scope === 'class' && role !== 'teacher' && role !== 'admin') scope = 'mine';
  if (!scope) scope = role === 'admin' ? 'all' : (role === 'teacher' ? 'class' : 'mine');

  if (scope === 'all') {
    return { where: '', params: [], scope, downgraded: requested && requested !== scope };
  }
  if (scope === 'mine') {
    return { where: ` AND ${prefix}user_id = ?`, params: [req.user.id], scope, downgraded: requested && requested !== scope };
  }
  // class → 소유 반 student 멤버 합집합 (멤버십 조인)
  let memberIds = [];
  try {
    const classIds = db.prepare('SELECT id FROM classes WHERE owner_id = ?').all(req.user.id).map(r => r.id);
    if (classIds.length) {
      const ph = classIds.map(() => '?').join(',');
      memberIds = db.prepare(`
        SELECT DISTINCT cm.user_id AS id
        FROM class_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.class_id IN (${ph}) AND u.role = 'student'
      `).all(...classIds).map(r => r.id);
    }
  } catch (_) { memberIds = []; }
  if (!memberIds.length) {
    // 소유 반·멤버 없으면 mine 으로 다운그레이드
    return { where: ` AND ${prefix}user_id = ?`, params: [req.user.id], scope: 'mine', downgraded: true };
  }
  const ph2 = memberIds.map(() => '?').join(',');
  return { where: ` AND ${prefix}user_id IN (${ph2})`, params: memberIds, scope, downgraded: requested && requested !== scope };
}

/**
 * 클래스 매트릭스/경고/통계 열람 권한: 관리자 또는 "해당 클래스" 교사-티어 멤버만.
 *   - admin: 전체 허용
 *   - 멤버 role 이 owner/teacher/co_teacher(개설자·공동담임) → 허용
 *   - 학생 멤버(member/student): 차단 (타 학생 성취 노출 방지 — 본인 mastery 는 별도 엔드포인트)
 *   - 비멤버 교사: 차단 (★P0 결함 fix: 이전 폴백 `return role==='teacher'` 가 모든 교사에게
 *     모든 반 통과를 허용 → 반 경계를 넘어 개인 성취 데이터 노출. 폴백 제거.)
 *   co_teacher 티어 정의는 마일리지 랭킹 제외(class-mileage.js, lrs.js mileage)와 동일하게 통일.
 */
const CLASS_TEACHER_ROLES = new Set(['owner', 'teacher', 'co_teacher']);
function canViewClass(req, classId) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  try {
    const role = classDb.getMemberRole(classId, req.user.id);
    if (CLASS_TEACHER_ROLES.has(role)) return true;
  } catch (_) {}
  return false;
}

// ─────────────────────────────────────────────────────────
// 개인정보 마스킹 정책 (2026-06 전환 — 단일 진실원천)
//   isClassManager: 그 반의 담임/담당(owner·teacher·co_teacher 멤버)인가.
//     ★ admin 이라도 "그 반의 교사-티어 멤버가 아니면" manager 가 아니다(거시뷰=익명).
//   shouldMaskNames: 학생 식별(이름)을 가려야 하는가.
//     = (학생수 < minSampleN) AND (담임/담당이 아님)
//     → 담임/담당(manager): 항상 실명(n 무관). 자기 반 위험 학생을 식별해 지도해야 하므로.
//     → 관리자(비소유)·기타: n<10 이면 익명(개인정보 보호 유지).
//   maskNameLabel: 마스킹 시 일관된 익명 라벨("학생 A","학생 B"...). 인덱스 기반.
// ─────────────────────────────────────────────────────────
const MIN_SAMPLE_N = LRS_CONFIG.minSampleN;

function isClassManager(req, classId) {
  if (!req.user) return false;
  try {
    const role = classDb.getMemberRole(classId, req.user.id);
    return CLASS_TEACHER_ROLES.has(role);
  } catch (_) {
    return false;
  }
}

/** 이름 마스킹 여부 판정 — 거시뷰(비담임)에서만 n<10 익명화. */
function shouldMaskNames(req, classId, studentCount) {
  if (studentCount >= MIN_SAMPLE_N) return false;     // 표본 충분 → 식별 가능
  if (isClassManager(req, classId)) return false;     // 담임/담당 → 항상 실명
  return true;                                        // 비담임 + 소표본 → 익명
}

/** 익명 라벨 ("학생 A" …) — 인덱스 기반, 26 순환. */
function maskNameLabel(i) {
  return `학생 ${String.fromCharCode(65 + (i % 26))}`;
}

// ─────────────────────────────────────────────────────────
// 기존 18개 엔드포인트
// ─────────────────────────────────────────────────────────

// POST /api/lrs/log
router.post('/log', requireAuth, (req, res) => {
  try {
    if (!req.body.activity_type || !req.body.verb) {
      return res.status(400).json({ success: false, message: 'activity_type과 verb는 필수입니다.' });
    }
    // M-6: student는 서버 산출/민감 필드 주입 금지. admin/teacher만 전체 필드 허용.
    let body = req.body;
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      body = {};
      for (const [k, v] of Object.entries(req.body)) {
        if (LOG_STUDENT_FIELDS.has(k)) body[k] = v;
      }
    }
    const log = lrsDb.logActivity(req.user.id, body);
    res.status(201).json({ success: true, log });
  } catch (err) {
    console.error('[LRS] log error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/logs
router.get('/logs', requireAuth, (req, res) => {
  try {
    const result = lrsDb.getUserLogs(req.user.id, {
      classId: req.query.classId ? parseInt(req.query.classId) : null,
      activityType: req.query.activityType,
      page: parseInt(req.query.page) || 1,
      limit: req.query.limit ? parseInt(req.query.limit) : 20,
      startDate: req.query.startDate || req.query.from,
      endDate: req.query.endDate || req.query.to
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/dashboard (B1 수정: db는 이제 최상단 require)
router.get('/dashboard', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const isAdmin = req.user.role === 'admin';
    // scope 파라미터 수신: 명시되면 scope 필터로 분기.
    const hasScope = typeof req.query.scope === 'string' && req.query.scope.length > 0;
    if (r.hasRange || hasScope) {
      const sf = resolveScopeFilter(req);
      // 범위 미지정 + scope만 지정된 경우를 위해 기본 30일은 dateRangeWhere에서 이미 처리됨
      const where = 'WHERE 1=1' + r.where + sf.where;
      const params = [...r.params, ...sf.params];
      const totalActivities = db.prepare(`SELECT COUNT(*) cnt FROM learning_logs ${where}`).get(...params).cnt;
      const byType = db.prepare(`SELECT activity_type, COUNT(*) cnt FROM learning_logs ${where} GROUP BY activity_type ORDER BY cnt DESC`).all(...params);
      const byVerb = db.prepare(`SELECT verb, COUNT(*) cnt FROM learning_logs ${where} GROUP BY verb ORDER BY cnt DESC LIMIT 10`).all(...params);
      const uniqueUsers = db.prepare(`SELECT COUNT(DISTINCT user_id) cnt FROM learning_logs ${where}`).get(...params).cnt;
      const totalDurationSec = db.prepare(`SELECT COALESCE(SUM(COALESCE(duration_sec, result_duration, 0)),0) s FROM learning_logs ${where}`).get(...params).s;
      const todayActivities = db.prepare(`SELECT COUNT(*) cnt FROM learning_logs ${where} AND date(created_at) = date('now','localtime')`).get(...params).cnt;
      const dailyActivity = db.prepare(`SELECT date(created_at) date, COUNT(*) count, COUNT(DISTINCT user_id) users FROM learning_logs ${where} GROUP BY date(created_at) ORDER BY date`).all(...params);
      return res.json({ success: true, scope: sf.scope, stats: {
        totalActivities,
        totalDurationMinutes: Math.round(totalDurationSec/60),
        todayActivities,
        uniqueUsers,
        byType: byType.map(r=>({ activity_type:r.activity_type, count:r.cnt })),
        byVerb: byVerb.map(r=>({ verb:r.verb, count:r.cnt })),
        dailyActivity
      }});
    }
    const stats = isAdmin ? lrsDb.getDashboardStats(null) : lrsDb.getDashboardStats(req.user.id);
    res.json({ success: true, scope: isAdmin ? 'all' : 'mine', stats });
  } catch (err) {
    console.error('[LRS] dashboard error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/class/:classId
router.get('/class/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const stats = lrsDb.getClassLrsStats(classId, {
      startDate: req.query.startDate,
      endDate: req.query.endDate
    });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/student/:studentId
router.get('/student/:studentId', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    if (!canViewUser(req, studentId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const stats = lrsDb.getDashboardStats(studentId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/content/:contentId
router.get('/content/:contentId', requireAuth, (req, res) => {
  try {
    // C-3: student는 콘텐츠 집계 조회 차단 (학교/클래스 전체 집계 노출 방지)
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const contentId = parseInt(req.params.contentId);
    const targetType = req.query.target_type || 'content';
    const summary = db.prepare(
      "SELECT * FROM lrs_content_summary WHERE target_type = ? AND target_id = ?"
    ).get(targetType, contentId);
    const viewCount = summary?.view_count || 0;
    const uniqueUsers = summary?.unique_users || 0;
    const completeCount = summary?.complete_count || 0;
    const recentViewers = db.prepare(`
      SELECT DISTINCT ll.user_id, u.display_name, MAX(ll.created_at) as last_viewed
      FROM learning_logs ll JOIN users u ON ll.user_id = u.id
      WHERE ll.target_type = ? AND ll.target_id = ?
      GROUP BY ll.user_id ORDER BY last_viewed DESC LIMIT 10
    `).all(targetType, String(contentId));
    res.json({ success: true, contentId, viewCount, uniqueUsers, completeCount, recentViewers });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/statements
router.get('/statements', requireAuth, (req, res) => {
  try {
    const { service, verb, page = 1, limit = 20 } = req.query;
    // 두 쿼리 분리: 합계는 ll 별칭 없이, 상세는 별칭 포함
    const rPlain = dateRangeWhere(req, 'created_at');
    if (rPlain.invalid) return sendInvalidPeriod(res, rPlain.reason);
    const rAliased = dateRangeWhere(req, 'created_at', 'll');
    const plainParams = [...rPlain.params];
    const aliasedParams = [...rAliased.params];
    let wherePlain = 'WHERE 1=1' + rPlain.where;
    let whereAliased = 'WHERE 1=1' + rAliased.where;
    // C-3: student는 본인 데이터만 조회
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      wherePlain += ' AND user_id = ?'; plainParams.push(req.user.id);
      whereAliased += ' AND ll.user_id = ?'; aliasedParams.push(req.user.id);
    }
    if (service) {
      wherePlain += ' AND source_service = ?'; plainParams.push(service);
      whereAliased += ' AND ll.source_service = ?'; aliasedParams.push(service);
    }
    if (verb) {
      wherePlain += ' AND verb = ?'; plainParams.push(verb);
      whereAliased += ' AND ll.verb = ?'; aliasedParams.push(verb);
    }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM learning_logs ${wherePlain}`).get(...plainParams).cnt;
    const statements = db.prepare(`
      SELECT ll.*, u.display_name FROM learning_logs ll
      JOIN users u ON ll.user_id = u.id
      ${whereAliased} ORDER BY ll.created_at DESC LIMIT ? OFFSET ?
    `).all(...aliasedParams, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    res.json({ success: true, statements, total, totalPages: Math.ceil(total / parseInt(limit)) || 1 });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/statements/:id
router.get('/statements/:id', requireAuth, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(parseInt(req.params.id));
    if (!stmt) return res.status(404).json({ success: false, message: 'Statement를 찾을 수 없습니다.' });
    // C-2: statement의 user_id에 대한 조회 권한 확인
    if (!canViewUser(req, stmt.user_id)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    if (stmt.statement_json) { try { stmt.statement_json = JSON.parse(stmt.statement_json); } catch (_) {} }
    if (stmt.metadata) { try { stmt.metadata = JSON.parse(stmt.metadata); } catch (_) {} }
    res.json({ success: true, statement: stmt });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-service
router.get('/stats/by-service', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const role = req.query.role;
    const sf = resolveScopeFilter(req, 'll');
    let join = '';
    // demo_* 합성 시드 제외(P2 관리자·교사 결함): 실서비스 랭킹에 demo_b4 등 데모 시드가 노출되면 안 됨.
    //   realOnly 와 무관하게 '항상' 제외한다(데모는 실서비스가 아님).
    let where = `WHERE ll.source_service IS NOT NULL AND ll.source_service NOT LIKE 'demo%' ${r.where}${sf.where}`;
    const params = [...r.params, ...sf.params];
    if (role) {
      join = 'JOIN users u ON ll.user_id = u.id';
      where += ' AND u.role = ?'; params.push(role);
    }
    const rawStats = db.prepare(`
      SELECT ll.source_service,
        COUNT(*) as count,
        AVG(CASE WHEN ${scoredWhere('ll')} THEN ${normScoreExpr('ll')} END) as avg_score,
        COUNT(DISTINCT ll.user_id) as unique_users,
        COALESCE(SUM(COALESCE(ll.duration_sec, CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as total_duration_sec
      FROM learning_logs ll ${join}
      ${where}
      GROUP BY ll.source_service ORDER BY count DESC
    `).all(...params);
    // 하위 호환: source_service 유지 + service/service_label 병기.
    //   avg_score: 채점형만·0~100 정규화(진도형 제외) 후 소수1자리 (P0 정규화 일괄 적용).
    const stats = rawStats.map(row => ({
      ...row,
      avg_score: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null,
      service: row.source_service,
      service_label: serviceLabel(row.source_service)
    }));
    res.json({ success: true, scope: sf.scope, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-achievement
router.get('/stats/by-achievement', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req);
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const { user_id, subject_code } = req.query;
    let where = 'WHERE achievement_code IS NOT NULL' + r.where;
    const params = [...r.params];
    let appliedScope = null;
    if (user_id) {
      const uid = parseInt(user_id);
      if (!canViewUser(req, uid)) {
        return res.status(403).json({ success: false, message: '권한이 없습니다.' });
      }
      where += ' AND user_id = ?'; params.push(uid);
      appliedScope = req.user.id === uid ? 'mine' : 'user';
    } else {
      const sf = resolveScopeFilter(req);
      where += sf.where;
      params.push(...sf.params);
      appliedScope = sf.scope;
    }
    if (subject_code) { where += ' AND subject_code = ?'; params.push(subject_code); }
    const rawStats = db.prepare(`
      SELECT achievement_code, subject_code, COUNT(*) as count,
        AVG(CASE WHEN ${scoredWhere('')} THEN ${normScoreExpr('')} END) as avg_score,
        SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) as success_count
      FROM learning_logs
      ${where}
      GROUP BY achievement_code ORDER BY count DESC
    `).all(...params).map(row => ({
      ...row,
      // 채점형만·0~100 정규화(진도형 제외) 후 소수1자리 (P0 정규화 일괄 적용).
      avg_score: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null
    }));
    // achievement_label JOIN: learning_map_nodes 에서 lesson_name/achievement_text 를 가져와 폴백
    let labelMap = {};
    try {
      const codes = rawStats.map(s => s.achievement_code).filter(Boolean);
      if (codes.length) {
        const placeholders = codes.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT achievement_code,
            COALESCE(MAX(lesson_name), MAX(achievement_text)) as label
          FROM learning_map_nodes
          WHERE achievement_code IN (${placeholders})
          GROUP BY achievement_code
        `).all(...codes);
        for (const row of rows) {
          if (row.achievement_code && row.label) labelMap[row.achievement_code] = row.label;
        }
      }
    } catch (_) { /* learning_map_nodes 없거나 에러 → code 그대로 폴백 */ }
    const stats = rawStats.map(row => ({
      ...row,
      achievement_label: labelMap[row.achievement_code] || row.achievement_code || ''
    }));
    res.json({ success: true, scope: appliedScope, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/dataset-coverage
router.get('/dataset-coverage', requireAuth, (req, res) => {
  try {
    // C-3: admin/teacher 전용 (전체 계정/데이터셋 집계 노출 방지)
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const userCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN role IN ('student','teacher') THEN 1 ELSE 0 END) as totalLearners,
        SUM(CASE WHEN role='student' THEN 1 ELSE 0 END) as totalStudents,
        SUM(CASE WHEN role='teacher' THEN 1 ELSE 0 END) as totalTeachers,
        COUNT(*) as totalAccounts
      FROM users
    `).get();
    const r = dateRangeWhere(req);
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const types = db.prepare(`SELECT activity_type, COUNT(*) as count FROM learning_logs WHERE 1=1 ${r.where} GROUP BY activity_type`).all(...r.params);
    const verbs = db.prepare(`SELECT verb, COUNT(*) as count FROM learning_logs WHERE 1=1 ${r.where} GROUP BY verb`).all(...r.params);
    const services = db.prepare(`SELECT source_service, COUNT(*) as count FROM learning_logs WHERE source_service IS NOT NULL AND source_service NOT LIKE 'demo%' ${r.where} GROUP BY source_service`).all(...r.params);
    const totalStatements = types.reduce((s, t) => s + t.count, 0);
    res.json({ success: true, totalStatements, byType: types, byVerb: verbs, byService: services, ...userCounts });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/xapi/statements
router.post('/xapi/statements', requireAuth, (req, res) => {
  try {
    // M-11: logLearningActivity로 dual-write (집계 테이블/세션 반영)
    const { verb, object, result, context } = req.body || {};
    const verbId = (verb && typeof verb === 'object') ? (verb.id || 'completed') : (verb || 'completed');
    const verbShort = String(verbId).split('/').pop();
    const objectType = object?.objectType || 'Activity';
    const objectId = object?.id || '';

    const ret = logLearningActivity({
      userId: req.user.id,
      activityType: 'external',
      targetType: objectType,
      targetId: objectId,
      verb: verbShort,
      objectType,
      objectId,
      resultScore: result?.score?.scaled ?? result?.score?.raw ?? null,
      resultSuccess: result?.success !== undefined ? (result.success ? 1 : 0) : null,
      resultDuration: result?.duration || null,
      sourceService: 'external',
      sessionId: context?.registration || null,
      metadata: req.body
    });
    res.json({ success: true, id: ret && ret.id });
  } catch (err) {
    console.error('[LRS] /xapi/statements error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/export — CSV/Excel/JSON 포맷 선택
router.get('/export', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const { format = 'csv', service } = req.query;
    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    let sql = `SELECT id, user_id, activity_type, target_type, target_id, class_id, verb, source_service, result_score, result_success, duration_sec, result_duration, achievement_code, subject_code, session_id, created_at FROM learning_logs WHERE 1=1` + r.where;
    const params = [...r.params];
    if (service) { sql += ` AND source_service = ?`; params.push(service); }
    sql += ` ORDER BY created_at DESC LIMIT ${LRS_CONFIG.csvExportLimit}`;

    const rows = db.prepare(sql).all(...params);

    const cols = ['id','user_id','activity_type','target_type','target_id','class_id','verb','source_service','result_score','result_success','duration_sec','result_duration','achievement_code','subject_code','session_id','created_at'];

    if (format === 'csv' || format === 'excel' || format === 'xlsx') {
      // SEP=, 지시자 + UTF-8 BOM을 추가하면 Excel 한글 정상 표시
      // csvEscapeCell 은 CSV injection 방어까지 포함 (=, +, -, @, TAB, CR prefix → ')
      const header = cols.join(',') + '\n';
      const csv = header + rows.map(r => cols.map(c => csvEscapeCell(r[c])).join(',')).join('\n');
      const filename = (format === 'excel' || format === 'xlsx') ? 'lrs_export.csv' : 'lrs_export.csv';
      const prefix = (format === 'excel' || format === 'xlsx') ? 'sep=,\n' : '';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      return res.send('\uFEFF' + prefix + csv);
    }

    if (format === 'jsonld' || format === 'xapi') {
      // xAPI Statement 배열 형태
      const stmts = db.prepare(`
        SELECT statement_json FROM learning_logs WHERE 1=1 ${r.where}
        ${service ? ' AND source_service = ?' : ''}
        ORDER BY created_at DESC LIMIT 10000
      `).all(...params);
      const items = stmts.map(s => { try { return JSON.parse(s.statement_json || '{}'); } catch { return null; } }).filter(Boolean);
      return res.json({ success: true, statements: items, total: items.length });
    }

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[LRS] export error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/daily — B2 수정: duration_sec 우선, result_duration fallback
router.get('/stats/daily', requireAuth, (req, res) => {
  try {
    const { activity_type, class_id, role, subject } = req.query;
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const sf = resolveScopeFilter(req, 'll');
    let where = 'WHERE 1=1' + r.where + sf.where;
    const params = [...r.params, ...sf.params];
    if (activity_type) { where += ' AND ll.activity_type = ?'; params.push(activity_type); }
    if (class_id) { where += ' AND ll.class_id = ?'; params.push(parseInt(class_id)); }
    if (subject) { where += ' AND ll.subject_code = ?'; params.push(subject); }

    let join = '';
    if (role) {
      join = 'JOIN users u ON ll.user_id = u.id';
      where += ' AND u.role = ?'; params.push(role);
    }

    // 점수 정규화(P0 시스템성): avg_score 는 채점형만·0~100 정규화(진도형 제외). 교사 홈 '학급 평균 성취'가
    //   이 값을 count 가중평균하므로, 비정규화 AVG(result_score) 를 쓰면 8.5점(실제 ≈78) 붕괴가 난다.
    //   scored_count 도 함께 반환 → FE 가 정규화 평균을 낼 때 채점 건수 기준 가중평균을 하도록.
    const data = db.prepare(`
      SELECT DATE(ll.created_at) as stat_date,
        COUNT(*) as count,
        COUNT(DISTINCT ll.user_id) as users,
        AVG(CASE WHEN ${scoredWhere('ll')} THEN ${normScoreExpr('ll')} END) as avg_score,
        SUM(CASE WHEN ${scoredWhere('ll')} AND ll.result_score IS NOT NULL THEN 1 ELSE 0 END) as scored_count,
        COALESCE(SUM(COALESCE(ll.duration_sec, CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as total_duration_sec
      FROM learning_logs ll ${join}
      ${where}
      GROUP BY DATE(ll.created_at) ORDER BY stat_date ASC
    `).all(...params).map(row => ({
      ...row,
      avg_score: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null
    }));

    // P0-4 (KERIS 로드맵 §3 P0-4 ②): s-trend "내가 주로 공부하는 시간" 습관 카드용
    //   기간(period) 기반 시간대별 활동 집계 — daily-snapshot byHour(오늘 고정·전 유형)의
    //   기간 확장판. 학습활동 7종 화이트리스트(LRS_LEARN_ACTIVITY_TYPES) 기준.
    //   동일 where(기간칩·scope·class_id·subject 필터)를 그대로 공유 → 기간칩과 연동 보장.
    //   시간대는 daily-snapshot 과 동일하게 localtime 기준(학생 체감 시각). 24칸 항상 반환.
    //   교사·관리자 일일현황(/stats/daily-snapshot)은 불변 — 본 필드는 추가 노출일 뿐.
    const learnPH = LRS_LEARN_ACTIVITY_TYPES.map(() => '?').join(',');
    const byHourRows = db.prepare(`
      SELECT CAST(strftime('%H', ll.created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS cnt
      FROM learning_logs ll ${join}
      ${where} AND ll.activity_type IN (${learnPH})
      GROUP BY hour
    `).all(...params, ...LRS_LEARN_ACTIVITY_TYPES);
    const hourMap = new Map(byHourRows.map(x => [x.hour, x.cnt]));
    const byHour = [];
    for (let h = 0; h < 24; h++) byHour.push({ hour: h, count: hourMap.get(h) || 0 });

    res.json({
      success: true, scope: sf.scope, data,
      byHour,
      byHourBasis: '학습활동 7종(기간 내)',
      period: r.fromDate && r.toDate ? { from: r.fromDate, to: r.toDate } : null
    });
  } catch (err) {
    console.error('[LRS] /stats/daily error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-subject
// ★ 이 엔드포인트는 "교과별 활동 현황"(운영 총량 리포트)이므로 항상 전체 기간 누적으로 집계한다.
//   형제 탭 "성취 도달 현황"이 누적이라, 기간 창(기본 최근 30일)으로 필터하면 이 탭만 텅 빈
//   것처럼 보이는 신뢰 훼손 버그가 있었다(teacher1 자료는 대부분 30일 창 밖). period 파라미터는
//   무시(유일 소비자는 FE VIEWS['t-subject']). scope 필터(class/mine)는 그대로 유지한다.
//   또한 subject_code 가 NULL 인 자료도 "(교과 미지정)" 한 행으로 집계(LEFT JOIN)해 교사가
//   분류 안 된 자료까지 인지하도록 한다. — 기획서 이슈3 ①안.
router.get('/stats/by-subject', requireAuth, (req, res) => {
  try {
    // scope: lessons/homework/exams 는 user_id 없음. mine=본인 소유(teacher_id/owner_id),
    //        class=교사 소유 반의 class_id IN (...).  학생이 mine 요청 시 자신이 속한 class 의 자료 노출은 피하고 빈 결과 폴백.
    const sfRaw = resolveScopeFilter(req);
    const role = req.user.role;
    const buildScope = (alias, ownerCol) => {
      if (sfRaw.scope === 'all') return { w: '', p: [] };
      if (sfRaw.scope === 'class') {
        // class_id IN (교사 소유 반). sfRaw.params 에 이미 class id 목록 보유.
        const placeholders = sfRaw.params.map(() => '?').join(',');
        return { w: ` AND ${alias}.class_id IN (${placeholders})`, p: [...sfRaw.params] };
      }
      // mine: 교사/관리자면 본인 소유, 그 외(학생)면 빈 결과
      if (role === 'teacher' || role === 'admin') {
        return { w: ` AND ${alias}.${ownerCol} = ?`, p: [req.user.id] };
      }
      return { w: ' AND 1=0', p: [] };
    };
    // ★ 날짜 필터 없음(누적). LEFT JOIN 으로 subject_code NULL·미매칭 코드도 포함.
    //   GROUP BY 는 COALESCE(subject_code,'__none__') 기준 → NULL 자료를 한 행으로 묶는다.
    //   scope 는 WHERE 로 시작(0-조건 대비 '1=1' 선행)해 sl.w 의 선행 ' AND ' 를 안전하게 이어 붙인다.
    const sl = buildScope('l', 'teacher_id');
    const lessonStats = db.prepare(`
      SELECT l.subject_code, s.name as subject_name, COUNT(*) as lesson_count
      FROM lessons l LEFT JOIN subjects s ON l.subject_code = s.code
      WHERE 1=1${sl.w}
      GROUP BY COALESCE(l.subject_code, '__none__') ORDER BY lesson_count DESC
    `).all(...sl.p);
    const sh = buildScope('h', 'teacher_id');
    const homeworkStats = db.prepare(`
      SELECT h.subject_code, s.name as subject_name, COUNT(*) as hw_count
      FROM homework h LEFT JOIN subjects s ON h.subject_code = s.code
      WHERE 1=1${sh.w}
      GROUP BY COALESCE(h.subject_code, '__none__') ORDER BY hw_count DESC
    `).all(...sh.p);
    const se = buildScope('e', 'owner_id');
    const examStats = db.prepare(`
      SELECT e.subject_code, s.name as subject_name, COUNT(*) as exam_count
      FROM exams e LEFT JOIN subjects s ON e.subject_code = s.code
      WHERE 1=1${se.w}
      GROUP BY COALESCE(e.subject_code, '__none__') ORDER BY exam_count DESC
    `).all(...se.p);
    // 일관된 키 병기: subject_code 유지 + subject_label 추가 (한글명 / subject_name 폴백)
    //   subject_code 가 NULL 이거나 라벨이 빈값이면 "(교과 미지정)" → FE 무변경으로 표시.
    const enrich = (rows, countKey) => rows.map(r => {
      let label = subjectLabel(r.subject_code, r.subject_name);
      if (!label || String(label).trim() === '') label = '(교과 미지정)';
      return { ...r, subject_label: label, count: r[countKey] };
    });
    res.json({
      success: true,
      scope: sfRaw.scope,
      lessonStats: enrich(lessonStats, 'lesson_count'),
      homeworkStats: enrich(homeworkStats, 'hw_count'),
      examStats: enrich(examStats, 'exam_count')
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-class
router.get('/stats/by-class', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    // teacher: 기본 class scope(자기반만). admin: 기본 all. scope 파라미터로 덮어쓰기 가능.
    const sf = resolveScopeFilter(req, 'll');
    const rawStats = db.prepare(`
      SELECT ll.class_id, c.name as class_name, ll.activity_type,
        COUNT(*) as total_count, COUNT(DISTINCT ll.user_id) as unique_users,
        AVG(CASE WHEN ${scoredWhere('ll')} THEN ${normScoreExpr('ll')} END) as avg_score
      FROM learning_logs ll JOIN classes c ON ll.class_id = c.id
      WHERE ll.class_id IS NOT NULL ${r.where}${sf.where}
      GROUP BY ll.class_id, ll.activity_type
      ORDER BY total_count DESC LIMIT 50
    `).all(...r.params, ...sf.params);
    // 하위 호환: total_count 유지 + count / unique_students 병기.
    //   avg_score: 채점형만·0~100 정규화(진도형 제외) 후 소수1자리 (P0 정규화 일괄 적용).
    const stats = rawStats.map(row => ({
      ...row,
      avg_score: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null,
      count: row.total_count,
      unique_students: row.unique_users
    }));
    res.json({ success: true, scope: sf.scope, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/user-summary
router.get('/stats/user-summary', requireAuth, (req, res) => {
  try {
    const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const r = dateRangeWhere(req);
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const summary = db.prepare(`
      SELECT activity_type, COUNT(*) as total_count,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as total_duration_sec,
        AVG(CASE WHEN ${scoredWhere('')} THEN ${normScoreExpr('')} END) as avg_score,
        MAX(created_at) as last_activity_at
      FROM learning_logs WHERE user_id = ? ${r.where}
      GROUP BY activity_type ORDER BY total_count DESC
    `).all(userId, ...r.params).map(row => ({
      ...row,
      // 채점형만·0~100 정규화(진도형 등은 NULL) 후 소수1자리 (P0 정규화 일괄 적용).
      avg_score: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null
    }));
    const total = summary.reduce((s, x) => s + x.total_count, 0);
    res.json({ success: true, userId, total, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/rebuild-aggregates
router.post('/rebuild-aggregates', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 사용할 수 있습니다.' });
    }
    const result = rebuildAllAggregates();
    res.json({ success: true, message: '집계 테이블 재빌드 완료', data: result });
  } catch (err) {
    console.error('[LRS] rebuild-aggregates error:', err);
    res.status(500).json({ success: false, message: '재빌드 중 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 신규 엔드포인트 8개 (Phase 2)
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// 성취기준 코드 → 학생 친화 짧은 이름(단원명) 라벨 헬퍼
//   우선순위: learning_map_nodes.unit_name(가장 짧고 익숙) →
//             resolveCode(code).label(성취기준 서술, 길면 FE가 축약) → 코드 폴백.
//   반환: { label(짧은 이름), fullLabel(서술 전체·툴팁용), subjectLabel, code }
//   코드→단원명 캐시(1회 로드). raw 코드([N수..])가 화면에 그대로 노출되지 않게 함.
// ─────────────────────────────────────────────────────────
let _unitNameCache = null;
function _buildUnitNameCache() {
  const map = new Map();
  try {
    const rows = db.prepare(
      "SELECT achievement_code, unit_name FROM learning_map_nodes WHERE achievement_code IS NOT NULL AND unit_name IS NOT NULL AND TRIM(unit_name) <> ''"
    ).all();
    for (const r of rows) {
      const key = String(r.achievement_code).trim();
      if (!map.has(key)) map.set(key, r.unit_name); // 첫 단원명 채택(결정론)
    }
  } catch (_) { /* 테이블 없으면 무시 */ }
  return map;
}
function achievementLabel(code) {
  if (!_unitNameCache) _unitNameCache = _buildUnitNameCache();
  const raw = String(code || '').trim();
  const bare = raw.replace(/^\[|\]$/g, '');
  const bracketed = raw.startsWith('[') ? raw : `[${bare}]`;
  const unit = _unitNameCache.get(bracketed) || _unitNameCache.get(bare) || _unitNameCache.get(raw);
  let full = '', subj = '';
  try { const ctx = mastery.resolveCode(code); full = (ctx && ctx.label) || ''; subj = (ctx && ctx.subject_label) || ''; } catch (_) {}
  // 짧은 이름: 단원명 우선, 없으면 성취기준 서술, 그래도 없으면 코드
  const short = unit || (full && full !== bracketed && full !== bare ? full : '') || bracketed;
  return {
    code: bracketed,
    label: short,                       // 화면 표기용 짧은 이름
    fullLabel: full || short,           // 툴팁/보조용 서술
    subjectLabel: subj || '',
  };
}

// ─────────────────────────────────────────────────────────
// P0-2 추천 SSOT 헬퍼 (KERIS 로드맵 §3 P0-2 (b) — 우선순위·이유·예상 소요시간)
//   BE 한 곳에서 산정한 동일 필드를 s-home 리스트·s-achieve A4 카드가 나눠 표시한다.
//   FE 자체 재산정 금지(수용 기준 3) — reasonText·estMinutes·priority 는 여기가 정본.
// ─────────────────────────────────────────────────────────

/**
 * 이유 한줄 reasonText — 기획서 확정 템플릿 5종(상태×채점 분기), 임의 변형 금지.
 *   시급(채점)      : 정답률 {avg}%예요 — 여기부터 다시 잡아봐요
 *   시급(미채점)    : 가장 많이 연습한 단원이에요({att}회) — 채점되는 문제로 실력을 확인해봐요
 *   권장(부분도달)  : 정답률 {avg}% — 조금만 더 하면 도달해요
 *   권장(평가부족)  : 아직 {att}번밖에 안 풀었어요 — 3번 이상 풀면 도달 판정을 받을 수 있어요
 *   선택(강점 심화) : 정답률 {avg}%로 잘하고 있어요 — 한 단계 더 깊게 배워볼까요?
 *   → 실측 결함 해소: 정답률 100%·평가부족([4영01-08]) 행도 "아직 {att}번밖에…" 로 이유가 자명해진다.
 *     (기획서 결정: 100% 행을 약점에서 제거하는 게 아니라 이유 문구로 해소 — §3 P0-2 ②·수용기준 2)
 * @param {string} status  mastery.STATUS 값 (not_reached|partial|insufficient) 또는 'strength'
 * @param {boolean} hasScore 채점 데이터 존재 여부
 * @param {number|null} avg 표시용 정답률(0~100 정규화). 미채점이면 null 허용.
 * @param {number} att 시도 횟수
 */
function recoReasonText(status, hasScore, avg, att) {
  const a = avg != null ? Math.round(avg) : null;
  if (status === 'strength') {
    return `정답률 ${a}%로 잘하고 있어요 — 한 단계 더 깊게 배워볼까요?`;
  }
  if (status === mastery.STATUS.PARTIAL) {
    return `정답률 ${a}% — 조금만 더 하면 도달해요`;
  }
  if (status === mastery.STATUS.INSUFFICIENT) {
    return `아직 ${att}번밖에 안 풀었어요 — 3번 이상 풀면 도달 판정을 받을 수 있어요`;
  }
  // not_reached (시급 계열)
  if (hasScore && a != null) {
    return `정답률 ${a}%예요 — 여기부터 다시 잡아봐요`;
  }
  return `가장 많이 연습한 단원이에요(${att}회) — 채점되는 문제로 실력을 확인해봐요`;
}

/**
 * 예상 소요시간 estMinutes — 기획서 산식(실데이터 근거 확정):
 *   연결 콘텐츠(최대 3개)별 분 = estimated_minutes(>0) 그대로,
 *                              결측 시 MAX(2, content_questions 수 × 2)  — 문항당 2분
 *   estMinutes = CLAMP(Σ, 5, 60) 항상 5~60 정수. 연결 콘텐츠 0개면 10(기본 학습 단위).
 *   0·null 금지(하네스 불변식 INV-K3).
 * @param {number[]} contentIds 그 성취기준의 recommendedContentIds
 * @returns {number} 5~60 정수
 */
function computeEstMinutes(contentIds) {
  if (!Array.isArray(contentIds) || contentIds.length === 0) return 10;
  let sum = 0;
  for (const id of contentIds) {
    try {
      const row = db.prepare(`
        SELECT estimated_minutes,
               (SELECT COUNT(*) FROM content_questions cq WHERE cq.content_id = contents.id) AS qcnt
        FROM contents WHERE id = ?
      `).get(id);
      if (!row) continue;
      const est = (row.estimated_minutes != null && row.estimated_minutes > 0)
        ? Number(row.estimated_minutes)
        : Math.max(2, (row.qcnt || 0) * 2);
      sum += est;
    } catch (_) { /* 콘텐츠 조회 실패는 합산 제외 */ }
  }
  if (sum <= 0) return 10;
  return Math.max(5, Math.min(60, Math.round(sum)));
}

// 1. GET /api/lrs/insights/:userId — 개인 인사이트
router.get('/insights/:userId', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // 기간 반영(LRS 학생 전수감사 §2): 기간칩(period/days/from~to)을 실제 집계에 반영.
    //   이전엔 주간=-7일·교과비중=-30일 하드코딩이라 7d/30d/90d 응답이 완전 동일했다.
    //   period 를 fromDate~toDate 로 해석해 학습시간(dur)·평균성취·교과비중을 그 기간으로 산출한다.
    const period = resolvePeriod(req);
    if (period.invalid) return sendInvalidPeriod(res, period.reason);
    const pFrom = period.fromDate, pTo = period.toDate;

    // streak: 연속 학습 일수
    const dailyRows = db.prepare(`
      SELECT stat_date FROM lrs_user_daily
      WHERE user_id = ? ORDER BY stat_date DESC LIMIT 60
    `).all(userId);
    let streakDays = 0;
    {
      const today = new Date();
      const iso = (d) => d.toISOString().slice(0, 10);
      let cursor = new Date(today);
      const set = new Set(dailyRows.map(r => r.stat_date));
      // 오늘 미학습이면 어제부터 셈
      if (!set.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
      while (set.has(iso(cursor))) {
        streakDays++;
        cursor.setDate(cursor.getDate() - 1);
      }
    }

    // 기간 통계(구 "주간") — 선택 기간(pFrom~pTo)의 학습시간·평균성취.
    const periodStat = db.prepare(`
      SELECT COALESCE(SUM(duration_sec),0) as dur, AVG(avg_score) as avg_score
      FROM lrs_user_daily
      WHERE user_id = ?
        ${pFrom ? 'AND stat_date >= ?' : ''}
        ${pTo ? 'AND stat_date <= ?' : ''}
    `).get(userId, ...(pFrom ? [pFrom] : []), ...(pTo ? [pTo] : []));

    // 약점 TOP5 — 정렬 기준 명확화:
    //   (1) 채점된 것(avg_score IS NOT NULL) 을 먼저, 그중 정답률 낮은 순.
    //   (2) 미채점(avg_score IS NULL)은 그 뒤에, 연습량(시도) 많은 순.
    //   과거엔 COALESCE(avg_score,0) 로 null 을 0점 취급 → avg_score 전무한 학생은
    //   사실상 '시도 많은 순'인데 FE가 그걸 구분할 신호가 없었다(사용자 실측 결함).
    //   → hasScore/avg_score(0~100)/criterion 을 함께 반환해 FE가 정답률 유무를 표시하게 한다.
    const WEAKNESS_CRITERION = '미도달·부분도달·평가부족 중 정답률 낮은 순 · 미채점은 연습량 순 (도달 제외)';
    // 약점 후보: attempt_count>=1 전체를 뽑아 단일 분류기(reachRate→classifyStatus)로 상태를 부여하고,
    //   '도달(reached)' 은 약점에서 제외한다(P1 학생 결함: 시드에서 도달·avg95 성취기준이 약점 TOP5 에 혼입).
    //   후보 = 미도달·부분도달·평가부족. SQL 정렬 순서(채점 우선 → 정답률↓ → 연습량↑)는 그대로 유지하되,
    //   충분한 후보 확보를 위해 넉넉히 조회 후 도달 제외하고 상위 5개를 취한다.
    const weaknessPool = db.prepare(`
      SELECT achievement_code, subject_code, attempt_count, success_count, avg_score, last_level
      FROM lrs_achievement_stats
      WHERE user_id = ? AND attempt_count >= 1
      ORDER BY
        CASE WHEN avg_score IS NULL THEN 1 ELSE 0 END ASC,  -- 채점된 것 우선
        avg_score ASC,                                       -- 정답률 낮은 순 (null 은 위 CASE로 후순위)
        attempt_count DESC                                   -- 동점/미채점은 연습량 많은 순
    `).all(userId);
    const weaknesses = weaknessPool.filter(w => {
      // 단일 분류기(SSOT): success/attempt 우선 reachRate → classifyStatus. 도달만 걸러낸다.
      const rate = mastery.reachRate(w.success_count, w.attempt_count, w.avg_score);
      const status = mastery.classifyStatus(w.attempt_count, rate);
      w.status = status;                            // FE 참고용 상태 코드 부착
      w.statusLabel = mastery.STATUS_KO ? mastery.STATUS_KO[status] : undefined;
      w.reachRateVal = rate;                        // P0-2: 미채점 partial 이유 문구용(분류기와 동일 rate)
      return status !== mastery.STATUS.REACHED;     // 도달 제외
    }).slice(0, 5);

    // avg_score 0~100 정규화 헬퍼 (lrs_achievement_stats.avg_score = AVG(result_score), 스케일 혼재).
    //   행 값이 null 이면 null 유지(미채점), 1 이하면 ×100(0~1 저장분), 그 외 그대로(이미 0~100).
    const normStat = (v) => (v == null ? null : Math.round((v <= 1 ? v * 100 : v) * 10) / 10);

    // 추천 콘텐츠 (약점 성취기준에 매핑된 콘텐츠) + 학생 친화 이름(단원명) 라벨 부착
    const recommendedContentIds = [];
    for (const w of weaknesses) {
      const nm = achievementLabel(w.achievement_code);
      w.label = nm.label;                 // 화면 표기용 짧은 이름(단원명 우선)
      w.fullLabel = nm.fullLabel;         // 툴팁/보조 서술
      w.subject_label = w.subject_label || nm.subjectLabel;
      // FE가 정답률 유무를 표시할 수 있도록 채점 신호 부착.
      w.hasScore = w.avg_score != null;   // 채점 데이터 존재 여부
      w.avg_score = normStat(w.avg_score); // 0~100 정규화 또는 null
      try {
        const cs = db.prepare(`
          SELECT id FROM contents WHERE achievement_code = ? ORDER BY id DESC LIMIT 3
        `).all(w.achievement_code);
        w.recommendedContentIds = cs.map(c => c.id);
        cs.forEach(c => recommendedContentIds.push(c.id));
      } catch (_) { w.recommendedContentIds = []; }
    }

    // 강점 TOP5
    const strengths = db.prepare(`
      SELECT achievement_code, subject_code, attempt_count, avg_score, last_level
      FROM lrs_achievement_stats
      WHERE user_id = ? AND attempt_count >= 3
      ORDER BY COALESCE(avg_score, 0) DESC
      LIMIT 5
    `).all(userId);
    for (const s of strengths) {
      const nm = achievementLabel(s.achievement_code);
      s.label = nm.label; s.fullLabel = nm.fullLabel;
      s.subject_label = s.subject_label || nm.subjectLabel;
      s.hasScore = s.avg_score != null;
      s.avg_score = normStat(s.avg_score); // 약점과 동일 스케일(0~100)로 통일
    }

    // ── P0-2 추천 SSOT (KERIS 로드맵 §3 P0-2 (b)) ─────────────────────────
    // weaknesses[] 각 행에 priority(선정 키 또는 null)·reasonText·estMinutes 부착 +
    // 최상위 recommendations[](최대 3건: ①시급 ②권장 ③선택) 신설.
    // 우선순위 선정 규칙(위에서 순차 확정, 각 1건):
    //   ① 시급(urgent)      : not_reached & 채점 → avg_score 오름차순 1건.
    //                          없으면 not_reached 미채점 중 attempt_count 최다 1건.
    //   ② 권장(recommended) : ① 제외 후 partial 우선 → insufficient(채점 우선) →
    //                          미채점 not_reached 잔여 중 attempt 최다.
    //   ③ 선택(optional)    : strengths(att>=3) 중 avg_score 최고 1건 — 강점 심화.
    //                          (채점 데이터 있는 강점만 — 이유 문구 {avg} 필요.)
    // 후보 부족 시 있는 것만 반환, 전부 없으면 recommendations:[].
    for (const w of weaknesses) {
      // 이유 문구 {avg}: 채점이면 정규화 avg_score, 미채점 partial 은 분류기와 동일 rate 폴백.
      const dispAvg = w.hasScore ? w.avg_score : (w.reachRateVal != null ? Math.round(w.reachRateVal) : null);
      w.reasonText = recoReasonText(w.status, w.hasScore, dispAvg, w.attempt_count);
      w.estMinutes = computeEstMinutes(w.recommendedContentIds);
      w.priority = null; // 아래 선정 후 부여
    }
    let recoUrgent = null, recoRecommended = null;
    {
      const nrScored = weaknesses
        .filter(w => w.status === mastery.STATUS.NOT_REACHED && w.hasScore)
        .sort((a, b) => a.avg_score - b.avg_score);
      recoUrgent = nrScored[0] || weaknesses
        .filter(w => w.status === mastery.STATUS.NOT_REACHED && !w.hasScore)
        .sort((a, b) => b.attempt_count - a.attempt_count)[0] || null;
      const rest = weaknesses.filter(w => w !== recoUrgent);
      recoRecommended = rest.find(w => w.status === mastery.STATUS.PARTIAL)
        || rest.find(w => w.status === mastery.STATUS.INSUFFICIENT && w.hasScore)
        || rest.find(w => w.status === mastery.STATUS.INSUFFICIENT)
        || rest.filter(w => w.status === mastery.STATUS.NOT_REACHED && !w.hasScore)
             .sort((a, b) => b.attempt_count - a.attempt_count)[0]
        || null;
    }
    if (recoUrgent) recoUrgent.priority = 'urgent';
    if (recoRecommended) recoRecommended.priority = 'recommended';
    // ③ 선택 = 강점 심화 (strengths 는 avg desc 정렬 — 채점된 첫 행. ①②와 코드 중복 방지 가드)
    const usedCodes = new Set([recoUrgent, recoRecommended].filter(Boolean).map(w => w.achievement_code));
    const recoOptional = strengths.find(s => s.hasScore && !usedCodes.has(s.achievement_code)) || null;
    if (recoOptional) {
      // 강점 행에도 연결 콘텐츠·소요시간·이유 부착(추천 카드 CTA 목적지 = recommendedContentIds[0]).
      try {
        const cs = db.prepare(`SELECT id FROM contents WHERE achievement_code = ? ORDER BY id DESC LIMIT 3`)
          .all(recoOptional.achievement_code);
        recoOptional.recommendedContentIds = cs.map(c => c.id);
      } catch (_) { recoOptional.recommendedContentIds = []; }
      recoOptional.reasonText = recoReasonText('strength', true, recoOptional.avg_score, recoOptional.attempt_count);
      recoOptional.estMinutes = computeEstMinutes(recoOptional.recommendedContentIds);
      recoOptional.priority = 'optional';
    }
    const mkReco = (row, priority) => ({
      priority,
      achievement_code: row.achievement_code,
      label: row.label,
      fullLabel: row.fullLabel,
      subject_code: row.subject_code || null,
      subject_label: row.subject_label || '',
      status: row.status || null,
      statusLabel: row.statusLabel || null,
      hasScore: !!row.hasScore,
      avg_score: row.avg_score != null ? row.avg_score : null,
      attempt_count: row.attempt_count || 0,
      reasonText: row.reasonText,
      estMinutes: row.estMinutes,
      recommendedContentIds: row.recommendedContentIds || []
    });
    const recommendations = [];
    if (recoUrgent) recommendations.push(mkReco(recoUrgent, 'urgent'));
    if (recoRecommended) recommendations.push(mkReco(recoRecommended, 'recommended'));
    if (recoOptional) {
      // 강점 행 status 는 분류기 기준(참고용 — 대개 reached).
      if (!recoOptional.status) {
        const r0 = mastery.reachRate(undefined, recoOptional.attempt_count, recoOptional.avg_score);
        recoOptional.status = mastery.classifyStatus(recoOptional.attempt_count, r0);
        recoOptional.statusLabel = mastery.STATUS_KO ? mastery.STATUS_KO[recoOptional.status] : undefined;
      }
      recommendations.push(mkReco(recoOptional, 'optional'));
    }

    // 교과별 비중 (선택 기간 pFrom~pTo)
    //   교과 정규화(P1 학생 결함): subject_code 에 MAT/math-e/수학, KOR/korean-e/국어 등이 혼재해
    //   한 교과가 2~3행으로 분할됐다(mastery.bySubject 정규화 뷰와 불일치). raw 코드로 GROUP BY 한 뒤
    //   mastery.subjectLabel() 로 정규 교과명(canonical)을 키로 JS 에서 합산해 교과당 1행으로 만든다.
    //   duration 결측이 많으므로 건수(count) 비중도 병기한다.
    const subjectRaw = db.prepare(`
      SELECT subject_code,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) as duration_sec,
        COUNT(*) as count
      FROM learning_logs
      WHERE user_id = ? AND subject_code IS NOT NULL
        ${pFrom ? 'AND DATE(created_at) >= ?' : ''}
        ${pTo ? 'AND DATE(created_at) <= ?' : ''}
      GROUP BY subject_code
    `).all(userId, ...(pFrom ? [pFrom] : []), ...(pTo ? [pTo] : []));
    const subjMerge = new Map(); // canonical label → { subject_label, duration_sec, count, codes:[] }
    for (const r of subjectRaw) {
      const label = mastery.subjectLabel(r.subject_code) || String(r.subject_code);
      const cur = subjMerge.get(label) || { subject_label: label, duration_sec: 0, count: 0, codes: [] };
      cur.duration_sec += r.duration_sec || 0;
      cur.count += r.count || 0;
      cur.codes.push(r.subject_code);
      subjMerge.set(label, cur);
    }
    const subjTotalCnt = [...subjMerge.values()].reduce((s, v) => s + v.count, 0) || 1;
    const subjTotalDur = [...subjMerge.values()].reduce((s, v) => s + v.duration_sec, 0) || 1;
    const subjectBalance = [...subjMerge.values()]
      .map(v => ({
        subject_code: v.codes[0],       // 대표 코드(하위호환). subject_label 이 정본.
        subject_codes: v.codes,          // 합쳐진 원본 코드 목록(투명성)
        subject_label: v.subject_label,
        duration_sec: v.duration_sec,
        count: v.count,
        // duration 결측 대비 두 비중 병기(합계 100 기준 %). FE 는 상황에 맞게 택1.
        durationShare: Math.round((v.duration_sec / subjTotalDur) * 1000) / 10,
        countShare: Math.round((v.count / subjTotalCnt) * 1000) / 10
      }))
      .sort((a, b) => (b.duration_sec - a.duration_sec) || (b.count - a.count));

    // ── 정합성 fix (사용자 실측 결함) ─────────────────────────────
    // (1) periodScoreAvg: /stats/perform 과 동일 로직으로 0~100 정규화 평균 재산출.
    //     lrs_user_daily.avg_score(스케일 혼재) 대신 learning_logs 원천에서 채점된 유형만.
    const periodScoreAvg = computeNormScoreAvg(userId, pFrom, pTo);
    const scoreBasis = '채점된 문항·평가의 평균 정답률';

    // (2) completedAssignments: 선택 기간 내 실제 과제 제출/이수 건수.
    //     소스 = homework_submissions (권위 원천). draft 제외, 제출/재제출/채점 상태만.
    //     (learning_logs 의 homework_submit 로그는 발행 누락·중복 가능 → 실 제출 테이블이 정확.)
    let completedAssignments = 0;
    try {
      const hsCols = db.prepare("PRAGMA table_info(homework_submissions)").all().map(c => c.name);
      const draftClause = hsCols.includes('is_draft') ? 'AND COALESCE(is_draft,0) = 0' : '';
      const row = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM homework_submissions
        WHERE student_id = ?
          AND status IN ('submitted','graded','resubmitted','returned')
          ${draftClause}
          ${pFrom ? 'AND DATE(submitted_at) >= ?' : ''}
          ${pTo ? 'AND DATE(submitted_at) <= ?' : ''}
      `).get(userId, ...(pFrom ? [pFrom] : []), ...(pTo ? [pTo] : []));
      completedAssignments = row ? (row.cnt || 0) : 0;
    } catch (_) { completedAssignments = 0; }

    // (3) 오늘/어제 활동 건수 — period 파라미터와 무관하게 서버 로컬 '하루'만 집계.
    //     FE renderDodMini 가 rangeQS(자동 period=30 부착) 우회 없이 진짜 '오늘'을 쓰게 한다.
    const todayIso = localDateIso(0);
    const yesterdayIso = localDateIso(-1);
    const todayCount = countActivitiesOnDate(userId, todayIso);
    const yesterdayCount = countActivitiesOnDate(userId, yesterdayIso);

    res.json({
      success: true,
      userId,
      asOf: new Date().toISOString(),
      // FE 공유 계약: period.{fromDate,toDate,label} 를 함께 반환(어떤 기간이 반영됐는지 표기용).
      period: { fromDate: pFrom, toDate: pTo, label: period.label },
      snapshot: {
        streakDays,
        // 선택 기간의 학습시간/평균성취. (라벨은 FE 가 기간에 맞춰 표기)
        weeklyDurationMin: Math.round((periodStat.dur || 0) / 60),
        periodDurationMin: Math.round((periodStat.dur || 0) / 60),
        weeklyTarget: LRS_CONFIG.weeklyTargetMin,
        // 평균 성취 — /stats/perform 과 동일한 0~100 정규화 값(스케일 혼재 평균 폐기).
        //   periodScoreAvg 가 정본. weeklyScoreAvg 는 하위호환 별칭(동일 값).
        periodScoreAvg,
        weeklyScoreAvg: periodScoreAvg,   // 하위호환: 동일 정규화 값으로 맞춤
        scoreBasis,                        // 지표 정의 문구
        // 실제 과제 제출/이수 건수(선택 기간). 총 활동수(totalActivities)와 혼동 금지.
        completedAssignments,
        // 오늘/어제 활동 건수 (period 불변 — 항상 하루).
        //   todayActs 는 전 유형 총건수(참고). '학습활동' 정본 카운트는 todayLearnActs(7종).
        //   content_view(조회/시청)는 학습활동 합계에서 분리 → todayContentViews 로 별도 노출.
        todayActs: todayCount.total,
        todayLearnActs: todayCount.learn,
        todayContentViews: todayCount.contentView,
        yesterdayActs: yesterdayCount.total,
        yesterdayLearnActs: yesterdayCount.learn,
        yesterdayContentViews: yesterdayCount.contentView,
        // engagementIndex 0~100 정규화(0~1 노출 위험 제거, 감사 §4).
        engagementIndex: Math.round((streakDays >= 7 ? 0.9 : (streakDays / 7)) * 100)
      },
      strengths,
      weaknesses,
      // P0-2 추천 SSOT — ①시급 ②권장 ③선택 최대 3건. s-home 리스트·s-achieve A4 가 공유.
      recommendations,
      // 약점 정렬 기준 문구 (FE가 표에 근거 표기). 채점된 것 우선(정답률↓) → 미채점(연습량↑).
      weaknessCriterion: WEAKNESS_CRITERION,
      criterion: WEAKNESS_CRITERION,     // 지시서 계약 별칭
      subjectBalance,
      recommendedContentIds: [...new Set(recommendedContentIds)].slice(0, 10)
    });
  } catch (err) {
    console.error('[LRS] /insights error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-1. GET /api/lrs/retry-growth/:uid — 문항 재풀이 전·후 비교 ("오답을 다시 풀었더니")
//   기획서: 작업지시서/LRS_개선로드맵_KERIS벤치마킹.md §3 P0-1 (a)(b)
//   산식 정본 = learning_logs(activity_type='wrong_note_retry')의 result_success 만 사용.
//     · result_score 의존 금지(시드 전용 — 실사용 경로 retryWrongNote() 는 null 기록).
//     · result_success IS NULL 행(점수만 있는 행)은 N·M·attempts 모두 미포함(INV-K1).
//   N(questions)  = 기간 내 재도전한 DISTINCT 문항(target_id) 수
//   M(succeeded)  = 그중 result_success=1 이 1회 이상인 DISTINCT 문항 수
//   retryRate     = N>0 ? ROUND(100·M/N) : null   ← N=0 이면 null(0 으로 찍지 말 것 — 빈상태)
//   attempts      = 시도 단위 보조(부제용)
//   wrongTotal / wrongResolved = wrong_answers 본인 행 COUNT·SUM(is_resolved) — 오답노트
//     현황 문구용 보조(기간 무관), 테이블 없거나 0행이면 0.
//   전(처음) = 0% 고정은 FE 표기 규약(오답노트 문항은 정의상 첫 시도 전부 오답) — BE 필드 없음.
//   권한: 본인 또는 교사/관리자(canViewUser 재사용). 기간: 기존 5엔드포인트와 동일 파서.
//   드릴다운: /perform/detail?activityType=wrong_note_retry (문항 단위 — count==N 계약).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/retry-growth/:uid', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.uid, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 사용자 ID 입니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const period = resolvePeriod(req);
    if (period.invalid) return sendInvalidPeriod(res, period.reason);
    const pFrom = period.fromDate, pTo = period.toDate;

    const agg = db.prepare(`
      SELECT COUNT(DISTINCT ll.target_id) AS n,
             COUNT(DISTINCT CASE WHEN ll.result_success = 1 THEN ll.target_id END) AS m,
             COUNT(*) AS attempts
      FROM learning_logs ll
      WHERE ll.user_id = ?
        AND ll.activity_type = 'wrong_note_retry'
        AND ll.result_success IS NOT NULL
        ${pFrom ? 'AND DATE(ll.created_at) >= ?' : ''}
        ${pTo ? 'AND DATE(ll.created_at) <= ?' : ''}
    `).get(userId, ...(pFrom ? [pFrom] : []), ...(pTo ? [pTo] : []));

    const questions = agg && agg.n ? agg.n : 0;
    const succeeded = agg && agg.m ? agg.m : 0;
    const attempts = agg && agg.attempts ? agg.attempts : 0;
    const retryRate = questions > 0 ? Math.round((100 * succeeded) / questions) : null;

    // 보조: 오답노트 현황(기간 무관 — "내 오답노트: 전체 N문항 중 M문항 해결" 문구용)
    let wrongTotal = 0, wrongResolved = 0;
    try {
      const w = db.prepare(
        'SELECT COUNT(*) AS c, COALESCE(SUM(is_resolved), 0) AS r FROM wrong_answers WHERE student_id = ?'
      ).get(userId);
      wrongTotal = (w && w.c) || 0;
      wrongResolved = (w && w.r) || 0;
    } catch (_) { /* 테이블 없으면 0 유지 */ }

    res.json({
      success: true,
      userId,
      period: { fromDate: pFrom, toDate: pTo, label: period.label },
      questions,
      succeeded,
      attempts,
      retryRate,
      wrongTotal,
      wrongResolved
    });
  } catch (err) {
    console.error('[LRS] /retry-growth error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 2. GET /api/lrs/live-feed?limit=20
router.get('/live-feed', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    let where = 'WHERE 1=1';
    const params = [];
    // 권한: 일반 학생은 본인 클래스 소속 활동만
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      where += ' AND ll.user_id = ?';
      params.push(req.user.id);
    }
    if (classId) {
      where += ' AND ll.class_id = ?';
      params.push(classId);
    }
    const events = db.prepare(`
      SELECT ll.id, ll.created_at as ts, ll.user_id, u.display_name,
        ll.activity_type, ll.verb, ll.result_score, ll.subject_code,
        ll.achievement_code, ll.class_id, ll.source_service
      FROM learning_logs ll
      LEFT JOIN users u ON u.id = ll.user_id
      ${where}
      ORDER BY ll.created_at DESC LIMIT ?
    `).all(...params, limit);
    res.json({ success: true, events });
  } catch (err) {
    console.error('[LRS] /live-feed error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 3. GET /api/lrs/achievement-progress?userId=|classId=
router.get('/achievement-progress', requireAuth, (req, res) => {
  try {
    const userId = req.query.userId ? parseInt(req.query.userId) : null;
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    const subjectCode = req.query.subjectCode || null;

    if (userId && !canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    if (classId && !canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    let standards;
    if (userId) {
      let where = 'WHERE user_id = ?';
      const params = [userId];
      if (subjectCode) { where += ' AND subject_code = ?'; params.push(subjectCode); }
      standards = db.prepare(`
        SELECT achievement_code as code, subject_code, attempt_count as attempts,
          success_count as success, avg_score, last_level as level, last_attempt_at as lastAt
        FROM lrs_achievement_stats
        ${where}
        ORDER BY attempt_count DESC
      `).all(...params);
    } else if (classId) {
      let where = 'WHERE ll.class_id = ? AND ll.achievement_code IS NOT NULL';
      const params = [classId];
      if (subjectCode) { where += ' AND ll.subject_code = ?'; params.push(subjectCode); }
      // REWORK-2: classId 경로도 단일 분류기/어휘로 통일.
      //   기존 SQL CASE 가 상/중/하(레거시 어휘)를 산출해 userId 경로(STATUS_KO: 도달/부분도달)
      //   와 같은 level 필드가 호출 파라미터에 따라 다른 어휘를 내보내던 계약 불일치를 해소한다.
      //   → 집계만 SQL 로 뽑고, success/attempt 우선 reachRate→classifyStatus→STATUS_KO 를 JS 에서 부여.
      const rawRows = db.prepare(`
        SELECT ll.achievement_code as code, ll.subject_code,
          COUNT(*) as attempts,
          SUM(CASE WHEN ll.result_success = 1 THEN 1 ELSE 0 END) as success,
          AVG(ll.result_score) as avg_score,
          MAX(ll.created_at) as lastAt
        FROM learning_logs ll
        ${where}
        GROUP BY ll.achievement_code
        ORDER BY attempts DESC
      `).all(...params);
      standards = rawRows.map(r => {
        const rate = mastery.reachRate(r.success, r.attempts, r.avg_score);
        const status = mastery.classifyStatus(r.attempts, rate);
        return { ...r, level: mastery.STATUS_KO[status] };  // STATUS_KO 어휘로 통일
      });
    } else {
      // 기본: 요청 사용자 본인
      standards = db.prepare(`
        SELECT achievement_code as code, subject_code, attempt_count as attempts,
          success_count as success, avg_score, last_level as level, last_attempt_at as lastAt
        FROM lrs_achievement_stats
        WHERE user_id = ?
        ORDER BY attempt_count DESC
      `).all(req.user.id);
    }

    // P0-6 / REWORK-2: 평가부족(insufficient) 분리 + 단일 어휘 통일.
    //   결함 B·REWORK-1·REWORK-2 fix 이후 userId·classId·rebuild 모든 경로의 level 은
    //   단일 분류기 STATUS_KO 값(도달/부분도달/미도달/평가부족)으로 일원화된다.
    //   레거시 상/중/하 키는 아직 재집계되지 않은 raw last_level 방어용 별칭으로만 남긴다.
    const summary = { total: standards.length, high: 0, mid: 0, low: 0, notYet: 0, insufficient: 0 };
    const LEVEL_BUCKET = {
      '도달': 'high', '상': 'high',
      '부분도달': 'mid', '중': 'mid',
      '미도달': 'notYet', '하': 'low',
      '평가부족': 'insufficient'
    };
    standards.forEach(s => { const b = LEVEL_BUCKET[s.level]; if (b) summary[b]++; });
    // level 키 래핑 (notYet=미도달, insufficient=평가부족)
    const distribution = {
      high: summary.high, mid: summary.mid, low: summary.low,
      notYet: summary.notYet, insufficient: summary.insufficient, total: summary.total
    };

    res.json({ success: true, standards, distribution });
  } catch (err) {
    console.error('[LRS] /achievement-progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 성취수준(성취기준 도달도) Mastery API — P0-2
//   기획서: LRS_성취수준_인사이트_재설계_기획서.md §D P0-2 / §C-2 임계
//   상태 4종: reached(도달) / partial(부분도달) / not_reached(미도달) / insufficient(평가부족)
//   ※ 정답/정오 raw 비노출 — 성취 "집계"만(attempts·correct·rate·status).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/lrs/mastery/student/:id?subjectCode=math-e
//   학생 성취기준별 도달 + 강약 분류 + 미도달→추천 콘텐츠 + 교과요약(레이더) + 4상태 분포(도넛)
//   권한: 본인 / 교사·관리자.
router.get('/mastery/student/:id', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 사용자 ID 입니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const subjectCode = req.query.subjectCode || null;
    // [정정] 성취수준 분류는 누적 기준 — period(7/30/90d) 무반영. 도달/미도달은 그간 학습의
    //   누적 결과이므로 기간칩에 따라 은폐/변동되면 안 된다(uid3 누적 미도달 5건이 30일 창 밖으로
    //   빠져 0으로 은폐되던 P0 버그 fix). period 파라미터가 와도 getStudentMastery 에 넘기지 않는다.
    //   (invalid from>to 만 안전하게 400 처리 — 분류엔 미반영이지만 잘못된 입력은 거른다.)
    if (req.query.from || req.query.to) {
      const period = resolvePeriod(req);
      if (period.invalid) return sendInvalidPeriod(res, period.reason);
    }
    const data = mastery.getStudentMastery(userId, { subjectCode });
    // 코드→이름 통일(P0-4·감사 §5): standards/강약 라벨을 단원명(achievementLabel)로 일원화.
    //   getStudentMastery 는 resolveCode(=성취기준 서술 전문)을 label 로 주는데, 강약 다이버징 축·
    //   레이더가 이를 그대로 쓰면 raw 코드/문장 전문이 노출된다. 단원명으로 덮고 서술은 fullLabel 로.
    const relabelM = (node) => {
      if (!node || !node.code) return node;
      const nm = achievementLabel(node.code);
      node.fullLabel = node.fullLabel || node.label || nm.fullLabel;
      node.label = nm.label;
      return node;
    };
    (data.standards || []).forEach(relabelM);
    (data.strengths || []).forEach(relabelM);
    (data.weaknesses || []).forEach(relabelM);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[LRS] /mastery/student error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/mastery/class/:id?subjectCode=math-e
//   성취기준×학생 매트릭스 + 성취기준별 학급 도달률·미도달 명단 + 4상태 분포 + 약점 Top10.
//   권한: 클래스 소유 교사 / 관리자. (학생은 본인 반이어도 매트릭스 차단 — 타 학생 성취 노출 방지)
//   개인정보 게이트: 평가된 표본 n<10 이면 학생 식별을 마스킹(_minSampleGuard 정책 유지).
router.get('/mastery/class/:id', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.id, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const subjectCode = req.query.subjectCode || null;

    // 클래스의 학생 멤버만 (교사·학부모 제외)
    const members = classDb.getClassMembers(classId).filter(m => m.user_role === 'student');
    const students = members.map(m => ({ id: m.user_id, name: m.display_name || m.username || `학생${m.user_id}` }));

    const data = mastery.getClassMastery(classId, students, { subjectCode });

    // 개인정보 게이트(정책 2026-06): 담임/담당은 실명, 비담임 거시뷰는 n<10 → 익명.
    const MIN_N = MIN_SAMPLE_N;
    const masked = shouldMaskNames(req, classId, students.length);
    if (masked) {
      data.students = data.students.map((s, i) => ({ id: s.id, name: maskNameLabel(i) }));
      const nm = new Map(data.students.map(s => [s.id, s.name]));
      data.standards = data.standards.map(s => ({
        ...s,
        notReachedStudents: (s.notReachedStudents || []).map(u => ({ id: u.id, name: nm.get(u.id) || '학생' })),
      }));
      data.weakTop = data.weakTop.map(w => ({
        ...w,
        notReachedStudents: (w.notReachedStudents || []).map(u => ({ id: u.id, name: nm.get(u.id) || '학생' })),
      }));
    }

    res.json({ success: true, masked, minSample: MIN_N, ...data });
  } catch (err) {
    console.error('[LRS] /mastery/class error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-1(A): GET /api/lrs/mastery/detail?user_id=&achievement_code= — 셀 드릴 "시도 내역"
//   기획서: 작업지시서/LRS_P2_교사히트맵_타임라인메타_스펙.md §2-4 (인벤토리 TW2 계약)
//
//   응답: { success, userId, code, label, subject, status, rate, attempts, count, items[] }
//     - label·subject: resolveCode 보강(서술 전문 + 교과 라벨), 매핑 없으면 코드 폴백(무손상)
//     - status·rate: 셀과 동일 분류기(classifyStatus·reachRate — SSOT) + 매트릭스와 동일 반올림(0.1)
//     - attempts: lrs_achievement_stats.attempt_count (셀 툴팁과 동일 값)
//     - count: learning_logs 행수(user_id×achievement_code 전체 — LIMIT 무관 전체 건수)
//     - items: 최신순 최대 50행 { date, activityType, typeLabel, success, scoreNorm }
//
//   ★ 표시값=내역 정합 계약: count == attempt_count == 로그 행수.
//     (스펙 §1-4 실측: uid3 상위 8개 코드 전부 정확 일치 8=8·6=6·5=5.
//      attempt_count 정본 산식 = rebuild 경로(db/lrs-aggregate.js §7):
//      COUNT(*) FROM learning_logs WHERE achievement_code IS NOT NULL GROUP BY user_id, code
//      → 본 라우트도 동일 WHERE(user_id×achievement_code, 유형 필터 없음)를 재사용한다.)
//     불일치 시 응답은 로그 기준(count=행수)으로 내리되 서버 콘솔 경고 1줄(정합 감시).
//
//   기간 파라미터 없음 — mastery 는 누적이 정책(P1 스펙 §3-3 계승). period 류가 와도 무시.
//   권한: canViewUser 재사용(본인·교사·관리자). 학생이 타 학생 user_id 요청 → 403 (INV-K12).
// ─────────────────────────────────────────────────────────────────────────────
const MASTERY_DETAIL_LIMIT = 50;

/** 시도 내역 유형 라벨 — PERFORM 계열 한국어 라벨 재사용(스펙 §2-4).
 *  exam 은 스펙 명시 어휘 '평가'(드로어 421px 1줄 축약형 — §2-4 와이어프레임 정본). */
function masteryDetailTypeLabel(activityType, sourceService) {
  switch (activityType) {
    case 'exam_complete': return '평가';
    case 'homework_submit': return '과제';
    case 'content_solve': return '콘텐츠 문항풀이';
    case 'content_view': return '콘텐츠 학습';
    case 'content_complete': return '콘텐츠 학습 완료';
    case 'lesson_progress': return '수업 진행';
    case 'lesson_view': return '수업 조회';
    case 'wrong_note_retry': return '오답노트 재도전';
    case 'problem_attempt': return '문항 풀이';
    case 'node_complete': return 'AI 학습맵';
    case 'self_learn':
    case 'daily_complete': {
      // perform/detail 의 self 계열 라벨 분기와 동일(source_service 로 출처 구분)
      const src = String(sourceService || '');
      return src.includes('wrong') ? '오답노트' : (src.includes('ai') || src.includes('map') ? 'AI맞춤' : '오늘의 학습');
    }
    default: return '학습 활동';
  }
}

router.get('/mastery/detail', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10);
    const rawCode = String(req.query.achievement_code || '').trim();
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 user_id 파라미터입니다.' });
    }
    if (!rawCode) {
      return res.status(400).json({ success: false, message: 'achievement_code 파라미터가 필요합니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // 괄호 유/무 양쪽 방어(데이터에 '9수01-01' 무괄호 형도 존재 — resolveCode 와 동일 관용)
    const ctx = mastery.resolveCode(rawCode);
    const codeForms = [...new Set([ctx.code, rawCode, rawCode.replace(/^\[|\]$/g, '')].filter(Boolean))];
    const ph = codeForms.map(() => '?').join(',');

    // ① stats — 셀 툴팁과 동일 원천(attempt_count). 괄호 이형이 별행이면 합산(로그 WHERE 와 대칭).
    const statRows = db.prepare(`
      SELECT attempt_count AS a, success_count AS s, avg_score AS v, subject_code
      FROM lrs_achievement_stats
      WHERE user_id = ? AND achievement_code IN (${ph})
    `).all(userId, ...codeForms);
    let attempts = 0, success = 0, wSum = 0, wCnt = 0, statSubject = null;
    for (const r of statRows) {
      attempts += r.a || 0; success += r.s || 0;
      if (r.v != null && (r.a || 0) > 0) { wSum += r.v * r.a; wCnt += r.a; }
      if (!statSubject && r.subject_code) statSubject = r.subject_code;
    }
    const avgScore = wCnt > 0 ? wSum / wCnt : null;
    const rateRaw = mastery.reachRate(success, attempts, avgScore);
    const rate = rateRaw == null ? null : Math.round(rateRaw * 10) / 10; // 매트릭스 셀과 동일 반올림
    const status = mastery.classifyStatus(attempts, rate);

    // ② count — 로그 행수(전체, LIMIT 무관). attempt_count 정본 산식과 동일 WHERE.
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS c FROM learning_logs
      WHERE user_id = ? AND achievement_code IN (${ph})
    `).get(userId, ...codeForms);
    const count = totalRow.c || 0;
    if (statRows.length > 0 && count !== attempts) {
      // 정합 감시(계약: 불일치 시 응답은 로그 기준) — 증분 upsert(hasEvalSignal 필터)와
      // rebuild(무필터) 경로 간 드리프트 신호. rebuildAllAggregates 재실행으로 수렴됨.
      console.warn(`[LRS] mastery/detail 정합 경고: uid=${userId} code=${ctx.code} 로그행수 ${count} != attempt_count ${attempts}`);
    }

    // ③ items — 시도 내역(누적·최신순·최대 50행). 기간 필터 없음(mastery 누적 정책).
    const NORM = `(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)`;
    const rows = db.prepare(`
      SELECT ll.activity_type, ll.created_at, ll.result_success, ll.source_service,
             ${NORM} AS norm_score
      FROM learning_logs ll
      WHERE ll.user_id = ? AND ll.achievement_code IN (${ph})
      ORDER BY ll.created_at DESC
      LIMIT ?
    `).all(userId, ...codeForms, MASTERY_DETAIL_LIMIT);
    const items = rows.map(r => ({
      date: r.created_at,
      activityType: r.activity_type,
      typeLabel: masteryDetailTypeLabel(r.activity_type, r.source_service),
      success: r.result_success == null ? null : (Number(r.result_success) ? 1 : 0),
      scoreNorm: r.norm_score == null ? null : Math.round(Number(r.norm_score) * 10) / 10, // 참고용 — 정본은 success
    }));

    const out = {
      success: true,
      userId,
      code: ctx.code,
      label: ctx.label,
      subject: ctx.subject_label || subjectLabel(statSubject, ''),
      status, rate, attempts, count,
      items,
    };
    if (count > MASTERY_DETAIL_LIMIT) out.note = `최근 ${MASTERY_DETAIL_LIMIT}회만 표시합니다.`;
    res.json(out);
  } catch (err) {
    console.error('[LRS] /mastery/detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 분석·예측 P0 (온더플라이) — 기획서: LRS_분석예측_강화_기획서.md
//   §B-1 위험점수 · §B-2 추세 · §B-3 도달예측 · §B-4 선수갭
//   윤리(P6): 위험점수는 교사/관리자 전용(ews). 학생 trend 응답에 위험 필드 비포함.
// ─────────────────────────────────────────────────────────

// GET /api/lrs/ews/class/:id — 교사(소유)/관리자 전용 조기경보(위험군+추세+반 도달외삽+선수갭)
//   학생 접근 차단(403). n<10(반 학생수) 이면 학생 식별 마스킹(기존 패턴).
router.get('/ews/class/:id', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.id, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    // P6 낙인 방지: 교사(소유)/관리자만. 학생은 본인 반이어도 위험군 비노출(403).
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    const students = analytics.classStudents(classId);
    const target = req.query.target ? Math.max(1, Math.min(100, parseInt(req.query.target, 10) || 80)) : 80;

    // 위험군 리스트(B-1)
    const risk = analytics.getClassRiskList(classId, students);
    // 반 도달 추세 + 외삽(B-2 → B-3) — 반 전체 멤버십 집계
    const classTrend = analytics.computeTrend({ classId });
    const projection = analytics.projectReach(classTrend, { target });
    // 선수개념 갭(B-4)
    const prereqGap = analytics.getPrereqGap(classId);

    // 개인정보 게이트(정책 2026-06): 담임/담당은 실명, 비담임 거시뷰는 n<10 → 익명(이름만, id 유지).
    const MIN_N = MIN_SAMPLE_N;
    const masked = shouldMaskNames(req, classId, students.length);
    let riskList = risk.list;
    let gaps = prereqGap.gaps;
    if (masked) {
      const labelById = new Map();
      students.forEach((s, i) => labelById.set(s.id, maskNameLabel(i)));
      riskList = riskList.map(r => ({ ...r, name: labelById.get(r.userId) || '학생' }));
      gaps = gaps.map(g => ({
        ...g,
        blockedStudents: (g.blockedStudents || []).map(b => ({ ...b, name: labelById.get(b.userId) || '학생' })),
      }));
    }

    res.json({
      success: true, classId, masked, minSample: MIN_N,
      studentCount: students.length,
      risk: { list: riskList, summary: risk.summary },
      classTrend,
      projection,
      prereqGap: { edgesLoaded: prereqGap.edgesLoaded, bridged: prereqGap.bridged, gaps },
      target,
      disclaimer: '이 신호는 규칙 기반 조기경보이며 실제와 다를 수 있어요. 소표본일수록 참고용으로 보세요.',
    });
  } catch (err) {
    console.error('[LRS] /ews/class error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ── P1-3: classTrend(학급 주별 평균 정답률) 조립 — 스펙 §4-2 계약 그대로 ──
//   익명 집계만: 개별 학생 값·명단·id 절대 미포함(집계값과 인원수만 — 역추적 불가).
//   가드(이중):
//     ① 반 없음 → { status:'no_class' }
//     ② 전체 peer < MIN_PEERS(5) → { status:'insufficient', peerCount, minPeers } (series 미포함)
//     ③ 주별 contributors < MIN_PEERS(5) 또는 attempts < MIN_WEEK_ATTEMPTS(3) → 그 주 반환하지 않음(결측)
//     ④ 유효 주 0개(전 주 가드 미달) → status:'insufficient' + series:[] (FE 오버레이 생략)
//   주 키 = strftime('%Y-%W') — 내(trend.series) 주 키와 동일 형식(FE 주 단위 align 전제).
function _buildClassTrend(userId, weeks) {
  const { classIds, peerIds } = _peerIdsOf(userId);
  if (!classIds.length) return { status: 'no_class' };
  if (peerIds.length < MIN_PEERS) {
    return { status: 'insufficient', peerCount: peerIds.length, minPeers: MIN_PEERS };
  }
  const raw = analytics.weeklyRateSeries({ userIds: peerIds, weeksLimit: weeks, withContributors: true });
  const series = raw
    .filter(w => (w.contributors || 0) >= MIN_PEERS && (w.attempts || 0) >= analytics.MIN_WEEK_ATTEMPTS)
    .map(w => ({
      week: w.week,                                   // '%Y-%W' — 내 series 와 동일 키 형식
      rate: Math.round(w.rate * 10) / 10,             // 0~100, 소수 1자리(내 series round1 과 동일)
      attempts: w.attempts,
      contributors: w.contributors,                   // 익명 인원수만(식별 정보 없음)
    }));
  if (!series.length) {
    return { status: 'insufficient', peerCount: peerIds.length, minPeers: MIN_PEERS, currentRate: null, series: [] };
  }
  return {
    status: 'ok',
    peerCount: peerIds.length, minPeers: MIN_PEERS,
    currentRate: series[series.length - 1].rate,      // 유효 마지막 주 rate
    series,
  };
}

// GET /api/lrs/trend/student/:id — 본인/교사/관리자. 성취 추이 + 도달예상.
//   윤리(P6): 위험점수·위험등급 필드 절대 미포함(학생 낙인 방지).
//   P1-3(스펙 §4-2): ?withClass=1 옵트인 시에만 classTrend 를 "추가"한다.
//     미지정 시 응답 완전 불변(필드 추가 0 — 기존 소비처 회귀 0). 초등 FE 는 이 파라미터를
//     아예 보내지 않으므로(네트워크 레벨 윤리 가드) 응답에 반 비교 데이터 자체가 존재하지 않는다.
router.get('/trend/student/:id', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 사용자 ID 입니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const target = req.query.target ? Math.max(1, Math.min(100, parseInt(req.query.target, 10) || 80)) : 80;

    // 기간 반영(감사 §2): 이전엔 computeTrend 가 기본 8주창 고정이라 7d/90d 응답이 동일했다.
    //   기간칩(period/days/from~to)을 주(week) 수로 환산해 관측 창을 조정한다.
    //   단 추세는 최소 3주 필요 — 기간이 3주 미만이면 관측 창을 3주로 보장(insufficient 문구로 안내됨).
    const period = resolvePeriod(req);
    if (period.invalid) return sendInvalidPeriod(res, period.reason);
    let weeks = analytics.DEFAULT_WEEKS;
    if (period.fromDate && period.toDate) {
      const spanDays = Math.max(1, Math.round((new Date(period.toDate) - new Date(period.fromDate)) / 86400000));
      weeks = Math.max(analytics.MIN_WEEKS, Math.ceil(spanDays / 7));
    }

    const trend = analytics.computeTrend({ userId, weeks });
    const projection = analytics.projectReach(trend, { target });

    // ★ 응답에 위험점수/위험등급 등 어떤 위험 필드도 포함하지 않는다(P6).
    const payload = {
      success: true, userId, target,
      period: { fromDate: period.fromDate, toDate: period.toDate, label: period.label, weeks },
      trend, projection,
      disclaimer: '이 추정은 규칙 기반이라 실제와 다를 수 있어요. 더 풀수록 정확해져요!',
    };
    // P1-3 옵트인 확장 — withClass=1 일 때만 classTrend 추가(미지정 시 위 payload 그대로 = 불변).
    if (String(req.query.withClass || '') === '1') {
      payload.classTrend = _buildClassTrend(userId, weeks);
    }
    res.json(payload);
  } catch (err) {
    console.error('[LRS] /trend/student error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/emotion-mirror/:userId — A6 "마음-공부 거울"(학생 · 정서×성취/활동량).
//   본인/교사/관리자(canViewUser). ★ 위험점수·EWS 필드 절대 미포함(P6 낙인 방지).
//   ?days=60(기본, 1~180 클램프). 감정 있는 날 × lrs_user_daily 3그룹 평균 비교.
router.get('/emotion-mirror/:userId', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 사용자 ID 입니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    // 기간 반영(감사 §2·§3 s-trend): 이전엔 ?days= 만 받고 ?period= 를 무시해 기간칩 무반응이었다.
    //   period(7d/30d/90d/custom) → days 로 환산해 반영. days 명시가 있으면 그것을 우선.
    let days;
    if (req.query.days) {
      days = Math.max(1, Math.min(180, parseInt(req.query.days, 10) || 60));
    } else if (req.query.period || req.query.from || req.query.to) {
      const period = resolvePeriod(req);
      if (period.invalid) return sendInvalidPeriod(res, period.reason);
      if (period.fromDate && period.toDate) {
        const span = Math.round((new Date(period.toDate) - new Date(period.fromDate)) / 86400000) + 1;
        days = Math.max(1, Math.min(180, span));
      } else {
        days = 60;
      }
    } else {
      days = 60;
    }

    const { groups, totalDays, coaching, note } = analytics.getEmotionMirror(userId, { days });

    res.json({ success: true, userId, days, groups, totalDays, coaching, note });
  } catch (err) {
    console.error('[LRS] /emotion-mirror error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/peer-compare/:userId — s-compare "또래 비교"(학생 · 반 평균 대비 본인 위치).
//   死스텁 탈피(감사 §3 s-compare · CP1): 완전 익명 집계만 반환(다른 학생 식별 절대 없음).
//   본인/교사/관리자(canViewUser). 표본이 적으면 값 대신 정직한 status='insufficient' 를 반환.
//   지표: 성취 도달률(reached/evaluated, %) + 학습 활동량(learning_logs 건수) 두 축.
//     · 본인 값 vs 반 평균/중앙값 + 백분위(상위 몇 %). 개별 학생 명단·점수 미포함.
router.get('/peer-compare/:userId', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 사용자 ID 입니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    // 대상 학생의 반들 → 반 멤버(학생) 합집합. 여러 반이면 학생이 속한 모든 반의 동료를 후보로.
    //   P1-3(스펙 §4-2): 인라인이던 산출 로직을 _peerIdsOf 공용 헬퍼로 추출 —
    //   /trend/student(withClass=1) classTrend 와 "학급" 정의·MIN_PEERS 정책을 공유한다.
    const { classIds, peerIds } = _peerIdsOf(userId);
    if (!classIds.length) {
      return res.json({ success: true, userId, status: 'no_class',
        message: '아직 소속된 클래스가 없어 비교할 친구들이 없어요.' });
    }

    if (peerIds.length < MIN_PEERS) {
      return res.json({ success: true, userId, status: 'insufficient', peerCount: peerIds.length, minPeers: MIN_PEERS,
        message: `비교하려면 같은 반 친구가 최소 ${MIN_PEERS}명은 있어야 해요(지금 ${peerIds.length}명). 표본이 적으면 정확하지 않아 숨겨요.` });
    }

    // 학생별 지표 계산 — 익명(값 배열만). 도달률 = 평가된(att>=3) 성취기준 중 도달 비율.
    const { classifyStatus, reachRate, STATUS } = require('../db/lrs-mastery');
    const statsByUser = db.prepare(`
      SELECT user_id, achievement_code, attempt_count AS attempts, success_count AS correct, avg_score
      FROM lrs_achievement_stats WHERE user_id IN (${peerIds.map(()=>'?').join(',')})
    `).all(...peerIds);
    const actByUser = new Map(db.prepare(`
      SELECT user_id, COUNT(*) c FROM learning_logs
      WHERE user_id IN (${peerIds.map(()=>'?').join(',')}) GROUP BY user_id
    `).all(...peerIds).map(r => [r.user_id, r.c]));

    const perUser = new Map(peerIds.map(id => [id, { evaluated: 0, reached: 0 }]));
    for (const s of statsByUser) {
      const rate = reachRate(s.correct, s.attempts, s.avg_score);
      const status = classifyStatus(s.attempts, rate);
      if (status === STATUS.INSUFFICIENT) continue; // 평가부족은 분모 제외
      const u = perUser.get(s.user_id); if (!u) continue;
      u.evaluated++;
      if (status === STATUS.REACHED) u.reached++;
    }
    // 도달률(%) 배열 — 평가된 성취기준이 하나라도 있는 학생만.
    const reachSamples = []; // { id, reachPct }
    for (const id of peerIds) {
      const u = perUser.get(id);
      if (u.evaluated > 0) reachSamples.push({ id, reachPct: Math.round((u.reached / u.evaluated) * 1000) / 10 });
    }
    const actSamples = peerIds.map(id => ({ id, acts: actByUser.get(id) || 0 }));

    const avg = (arr, key) => arr.length ? Math.round(arr.reduce((s, x) => s + x[key], 0) / arr.length * 10) / 10 : null;
    const median = (arr, key) => {
      if (!arr.length) return null;
      const v = arr.map(x => x[key]).sort((a, b) => a - b);
      const m = Math.floor(v.length / 2);
      return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
    };
    // 백분위(상위 %) = 나보다 낮은 학생 비율. 값 없으면 null.
    const percentileOf = (arr, key, id) => {
      const me = arr.find(x => x.id === id); if (!me) return null;
      const below = arr.filter(x => x[key] < me[key]).length;
      return Math.round((below / arr.length) * 100);
    };

    const myReach = reachSamples.find(x => x.id === userId);
    const myAct = actSamples.find(x => x.id === userId);

    const buildAxis = (samples, key, myRow, unit) => {
      if (!samples.length || !myRow) {
        return { status: 'insufficient', mine: myRow ? myRow[key] : null, unit,
          message: '아직 이 지표를 비교할 기록이 부족해요.' };
      }
      const pct = percentileOf(samples, key, myRow.id);
      return {
        status: 'ok', unit,
        mine: myRow[key],
        classAvg: avg(samples, key),
        classMedian: median(samples, key),
        percentile: pct,                                   // 상위 (100-pct)% 수준
        aboveAverage: myRow[key] >= avg(samples, key),
        sampleSize: samples.length,
      };
    };

    res.json({
      success: true, userId, status: 'ok',
      peerCount: peerIds.length, minPeers: MIN_PEERS,
      anonymous: true,
      reach: buildAxis(reachSamples, 'reachPct', myReach, '%'),   // 성취 도달률
      activity: buildAxis(actSamples, 'acts', myAct, '건'),        // 학습 활동량
      disclaimer: '반 친구들과 익명으로 비교한 값이에요. 개별 친구가 누구인지는 알 수 없고, 기록이 적으면 정확하지 않을 수 있어요.',
    });
  } catch (err) {
    console.error('[LRS] /peer-compare error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 담임 실명 열람 audit — learning_logs 1건(거버넌스 추적). best-effort(실패 무시).
//   routes/school.js:42 auditNameAccess 의 lrs 복제판. B6 담임 실명 사분면 열람 시 1건 적재.
function auditNameAccessLrs(req, kind, classId, count) {
  try {
    logLearningActivity({
      userId: req.user.id,
      activityType: 'governance',
      verb: 'viewed',
      targetType: 'lrs-roster',
      targetId: String(classId),
      objectType: 'roster',
      objectId: kind,
      sourceService: 'lrs',
      metadata: { kind, count, classId, role: req.user.role },
    });
  } catch (_) { /* audit 실패는 응답을 막지 않는다 */ }
}

// GET /api/lrs/shallow/class/:id — B4 "풀이 속도-정확도 점검"(교사 · 정오×속도 매트릭스).
//   담임/담당(canViewClass) → 403. ?days=30(기본, 1~365 클램프).
//   데이터원: learning_logs(시청·채점) + problem_attempts(문항 채점, 오답+시간) union.
//   응답(analytics.getShallowLearning): points[](+correct+speed) · matrix(정오×fast/normal/slow)
//     · wrongUnits[](오답 몰린 단원 desc) · hasWrongData · insights[](§4 규칙 BE계산)
//     · topStudents · maskedContentCount · medianThreshold(=SPEED_FAST 0.5) · disclaimer.
router.get('/shallow/class/:id', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.id, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const days = req.query.days
      ? Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30))
      : 30;

    const result = analytics.getShallowLearning(classId, { days });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[LRS] /shallow/class error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/emotion-engage/class/:id — B6 "정서-참여 교차"(교사 · 반 2×2 매트릭스).
//   담임/담당(canViewClass) → 403. ?weeks=2(기본, 1~12 클램프).
//   getClassRiskList 신호 2축 → 4사분면 좌표. 담임=실명+audit / 비담임 소표본=익명.
router.get('/emotion-engage/class/:id', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.id, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const weeks = req.query.weeks
      ? Math.max(1, Math.min(12, parseInt(req.query.weeks, 10) || 2))
      : 2;

    const result = analytics.getEmotionEngage(classId, { weeks });
    const studentCount = result.studentCount;
    const masked = shouldMaskNames(req, classId, studentCount);

    let points = result.points;
    if (masked) {
      // 비담임 소표본 → 실명 대신 익명 라벨(개인정보 보호). audit 미적재(실명 아님).
      points = result.points.map((p, i) => ({ ...p, name: maskNameLabel(i) }));
    } else if (points.length) {
      // 담임/담당 실명 노출 → 거버넌스 audit 1건.
      auditNameAccessLrs(req, 'emotion-engage', classId, points.length);
    }

    res.json({
      success: true,
      classId: result.classId,
      weeks: result.weeks,
      masked,
      minSample: MIN_SAMPLE_N,
      studentCount,
      points,
      summary: result.summary,
      disclaimer: result.disclaimer,
    });
  } catch (err) {
    console.error('[LRS] /emotion-engage/class error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/next-step/:userId — A4 "다음 한 걸음"(학생 · 선수→후속 학습 경로).
//   본인/교사/관리자(canViewUser) → 403. ?limit=3(열쇠 노드 수, 1~10).
//   ★ 위험점수/EWS 필드 절대 미포함(P6). 코칭 프레임만.
router.get('/next-step/:userId', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: '잘못된 사용자 ID 입니다.' });
    }
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const limit = req.query.limit
      ? Math.max(1, Math.min(10, parseInt(req.query.limit, 10) || 3))
      : 3;

    const result = analytics.getNextStep(userId, { limit });
    // 코드→이름 통일(P0-4·감사 §5): getNextStep 의 label 은 resolveCode(=성취기준 서술 전문)이라
    //   다른 카드(약점=단원명)와 라벨이 어긋난다. achievementLabel(단원명 우선)로 label 을 덮어써
    //   전 뷰 라벨 정책을 일원화한다. 서술 전문은 fullLabel(툴팁용)로 보존.
    const relabel = (node) => {
      if (!node || !node.code) return node;
      const nm = achievementLabel(node.code);
      node.fullLabel = node.fullLabel || node.label || nm.fullLabel;
      node.label = nm.label;
      return node;
    };
    (result.keyNodes || []).forEach(k => {
      relabel(k);
      (k.unlocks || []).forEach(relabel);
      (k.chain || []).forEach(relabel);
    });
    (result.readyToChallenge || []).forEach(relabel);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[LRS] /next-step error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/trend/class/:id — 교사(소유)/관리자. 반 성취 추세 + 도달 외삽.
router.get('/trend/class/:id', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.id, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const target = req.query.target ? Math.max(1, Math.min(100, parseInt(req.query.target, 10) || 80)) : 80;
    const students = analytics.classStudents(classId);

    const trend = analytics.computeTrend({ classId });
    const projection = analytics.projectReach(trend, { target });

    res.json({
      success: true, classId, target, studentCount: students.length,
      trend, projection,
      disclaimer: '이 추정은 규칙 기반 조기경보이며 실제와 다를 수 있어요.',
    });
  } catch (err) {
    console.error('[LRS] /trend/class error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/weak-trend — 관리자(scope=all)/교사(scope=class). 취약 성취기준 추세 랭킹.
//   scope=class: 교사 소유 반 멤버 전체. scope=all: admin 전용 전체 학생.
//   평가 학생수 n<10 인 성취기준은 식별 무관(코드 단위 집계)이지만, 전체 표본<10 이면 마스킹 플래그.
router.get('/weak-trend', requireAuth, (req, res) => {
  try {
    const role = req.user && req.user.role;
    let requested = String(req.query.scope || '').toLowerCase();
    let scope = requested;
    if (scope === 'all' && role !== 'admin') scope = 'class';
    if (!scope) scope = role === 'admin' ? 'all' : 'class';
    if (scope === 'class' && role !== 'teacher' && role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    const limit = req.query.limit ? Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 15)) : 15;
    let userIds = [];
    if (scope === 'all') {
      userIds = db.prepare("SELECT id FROM users WHERE role='student'").all().map(r => r.id);
    } else {
      // class: 교사 소유 반들의 student 멤버 합집합
      const classIds = db.prepare('SELECT id FROM classes WHERE owner_id = ?').all(req.user.id).map(r => r.id);
      if (classIds.length) {
        const ph = classIds.map(() => '?').join(',');
        userIds = db.prepare(`
          SELECT DISTINCT cm.user_id AS id
          FROM class_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.class_id IN (${ph}) AND u.role = 'student'
        `).all(...classIds).map(r => r.id);
      }
    }

    // 정책 2026-06: scope=class 는 교사가 "자기 반(담당) 학생"을 보는 관점 → 실명(masked=false).
    //   scope=all 은 관리자 거시뷰 → 표본 n<10 이면 익명 게이트 유지(개인정보 보호).
    //   (※ getWeakTrend 자체는 성취기준 코드 단위 집계로 개별 학생명 미포함 — masked 는 FE 참고 배너용 플래그.)
    const MIN_N = MIN_SAMPLE_N;
    const masked = scope === 'class' ? false : (userIds.length < MIN_N);
    const ranking = analytics.getWeakTrend({ userIds, limit });

    res.json({
      success: true, scope, studentCount: userIds.length, masked, minSample: MIN_N,
      ranking,
      disclaimer: '취약·하락 추세는 규칙 기반 신호입니다. 표본이 적은 단위는 참고용으로 보세요.',
    });
  } catch (err) {
    console.error('[LRS] /weak-trend error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 4. GET /api/lrs/parent/:childId/digest?period=7d
router.get('/parent/:childId/digest', requireAuth, (req, res) => {
  try {
    const childId = parseInt(req.params.childId);
    // 학부모 관계 검증: users 테이블에 parent_of 관계가 있으면 사용. 기본적으로는 admin/teacher/본인 허용.
    let allowed = canViewUser(req, childId);
    if (!allowed && req.user.role === 'parent') {
      try {
        const rel = db.prepare("SELECT 1 FROM users WHERE id = ? AND parent_id = ?").get(childId, req.user.id);
        if (rel) allowed = true;
      } catch (_) {}
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);

    // 총 학습량
    const totals = db.prepare(`
      SELECT COUNT(*) as activities,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) as durSec,
        AVG(result_score) as avg_score,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM learning_logs WHERE user_id = ? ${r.where}
    `).get(childId, ...r.params);

    // 교과별
    const bySubject = db.prepare(`
      SELECT subject_code,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) as dur,
        COUNT(*) as count, AVG(result_score) as avg_score
      FROM learning_logs WHERE user_id = ? AND subject_code IS NOT NULL ${r.where}
      GROUP BY subject_code ORDER BY dur DESC
    `).all(childId, ...r.params);

    // 활동 유형별
    const byType = db.prepare(`
      SELECT activity_type, COUNT(*) as count
      FROM learning_logs WHERE user_id = ? ${r.where}
      GROUP BY activity_type ORDER BY count DESC
    `).all(childId, ...r.params);

    // 약점 TOP3
    const weaknesses = db.prepare(`
      SELECT achievement_code, attempt_count, avg_score, last_level
      FROM lrs_achievement_stats
      WHERE user_id = ? AND attempt_count >= 1
      ORDER BY COALESCE(avg_score,0) ASC LIMIT 3
    `).all(childId);

    // P1-S-01: parent role은 점수 원값 마스킹 → 성취수준 레이블
    const isParent = req.user.role === 'parent';
    const maskedBySubject = isParent
      ? bySubject.map(s => ({ ...s, avg_score: undefined, level: maskDigestScore(s.avg_score) }))
      : bySubject;
    const maskedWeak = isParent
      ? weaknesses.map(w => ({ ...w, avg_score: undefined, level: w.last_level || maskDigestScore(w.avg_score) }))
      : weaknesses;

    res.json({
      success: true,
      childId,
      period: { from: r.fromDate, to: r.toDate },
      totals: {
        activities: totals.activities,
        durationMin: Math.round((totals.durSec || 0) / 60),
        avgScore: isParent ? undefined : totals.avg_score,
        level: isParent ? maskDigestScore(totals.avg_score) : undefined,
        activeDays: totals.active_days
      },
      bySubject: maskedBySubject, byType, weaknesses: maskedWeak
    });
  } catch (err) {
    console.error('[LRS] /parent/digest error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 5. POST /api/lrs/session/start
router.post('/session/start', requireAuth, (req, res) => {
  try {
    // session_id 는 VARCHAR(40) 수용. hex 32자(16 bytes)로 충분.
    const sessionId = crypto.randomBytes(LRS_CONFIG.sessionIdBytes).toString('hex');
    const { classId, deviceType, platform } = req.body || {};
    db.prepare(`
      INSERT INTO lrs_session_stats (session_id, user_id, class_id, started_at, activity_count, device_type)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0, ?)
    `).run(sessionId, req.user.id, classId || null, deviceType || null);
    res.json({ success: true, session_id: sessionId, sessionId });
  } catch (err) {
    console.error('[LRS] /session/start error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 6. POST /api/lrs/session/end
router.post('/session/end', requireAuth, (req, res) => {
  try {
    const { sessionId, session_id } = req.body || {};
    const sid = sessionId || session_id;
    if (!sid) return res.status(400).json({ success: false, message: 'sessionId가 필요합니다.' });
    const row = db.prepare('SELECT * FROM lrs_session_stats WHERE session_id = ?').get(sid);
    if (!row) return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    if (row.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    // 세션 동안 쌓인 로그에서 duration 합산
    const agg = db.prepare(`
      SELECT COUNT(*) as cnt,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as dur,
        GROUP_CONCAT(DISTINCT source_service) as services
      FROM learning_logs WHERE session_id = ?
    `).get(sid);
    // P1-F-04: duration 합계가 0이면 session 테이블 started_at ~ now 차이로 fallback
    let durSec = agg.dur || 0;
    if (!durSec) {
      try {
        const diff = db.prepare(`
          SELECT CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) as sec
          FROM lrs_session_stats WHERE session_id = ?
        `).get(sid);
        if (diff && diff.sec > 0 && diff.sec < 86400 * 2) durSec = diff.sec;
      } catch (_) {}
    }
    db.prepare(`
      UPDATE lrs_session_stats
      SET ended_at = CURRENT_TIMESTAMP,
          duration_sec = ?,
          activity_count = ?,
          services_touched = ?
      WHERE session_id = ?
    `).run(durSec, agg.cnt || 0, agg.services || null, sid);
    res.json({ success: true, sessionId: sid, durationSec: durSec, activityCount: agg.cnt || 0 });
  } catch (err) {
    console.error('[LRS] /session/end error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 7. GET /api/lrs/warnings/:classId
router.get('/warnings/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // M-3: 단일 JOIN 쿼리로 멤버 + 마지막 활동일 조회 (기존 N+1 제거)
    const memberRows = db.prepare(`
      SELECT u.id as user_id, u.display_name,
        (SELECT MAX(DATE(ll.created_at)) FROM learning_logs ll WHERE ll.user_id = u.id) as last_date
      FROM class_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = ? AND (cm.role = 'student' OR u.role = 'student')
    `).all(classId);

    const inactive = [];
    const noData = [];   // P0-F-02: 로그 0건 학생 별도 라벨
    for (const m of memberRows) {
      if (!m.last_date) {
        noData.push({ userId: m.user_id, displayName: m.display_name, status: 'no_data' });
        continue;
      }
      const diff = db.prepare("SELECT CAST((julianday('now') - julianday(?)) AS INTEGER) as days").get(m.last_date).days;
      if (diff >= 3) {
        inactive.push({ userId: m.user_id, displayName: m.display_name, lastDate: m.last_date, daysInactive: diff });
      }
    }

    // 연속 오답 일괄 조회 — 최근 10건 이내 선두 연속 0 개수 집계
    const wrongRows = db.prepare(`
      SELECT user_id, result_success, created_at,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
      FROM learning_logs
      WHERE class_id = ? AND result_success IS NOT NULL
        AND user_id IN (SELECT cm.user_id FROM class_members cm JOIN users u ON u.id = cm.user_id WHERE cm.class_id = ? AND u.role = 'student')
    `).all(classId, classId);
    const streakByUser = new Map();
    // 사용자별 첫 10건까지만 고려, 선두 연속 0 카운트
    const buckets = new Map();
    for (const row of wrongRows) {
      if (row.rn > 10) continue;
      if (!buckets.has(row.user_id)) buckets.set(row.user_id, []);
      buckets.get(row.user_id).push(row);
    }
    for (const [uid, rows] of buckets.entries()) {
      rows.sort((a,b) => a.rn - b.rn);
      let s = 0;
      for (const r of rows) {
        if (r.result_success === 0) s++;
        else break;
      }
      if (s >= 3) streakByUser.set(uid, s);
    }
    const consecutiveWrong = [];
    for (const m of memberRows) {
      const s = streakByUser.get(m.user_id);
      if (s) consecutiveWrong.push({ userId: m.user_id, displayName: m.display_name, wrongStreak: s });
    }

    // 결손 성취기준 — 클래스 멤버 전체 한 번에
    const weakRows = db.prepare(`
      SELECT las.user_id, u.display_name, las.achievement_code, las.avg_score, las.last_level, las.attempt_count
      FROM lrs_achievement_stats las
      JOIN users u ON u.id = las.user_id
      WHERE las.user_id IN (SELECT cm.user_id FROM class_members cm JOIN users u2 ON u2.id = cm.user_id WHERE cm.class_id = ? AND u2.role = 'student')
        AND (las.last_level IN ('하', '미도달') OR las.level = 'not_reached')
      ORDER BY las.user_id, COALESCE(las.avg_score, 0) ASC
    `).all(classId);
    const weakMap = new Map();
    for (const w of weakRows) {
      if (!weakMap.has(w.user_id)) weakMap.set(w.user_id, { userId: w.user_id, displayName: w.display_name, items: [] });
      const rec = weakMap.get(w.user_id);
      if (rec.items.length < 5) rec.items.push({
        achievement_code: w.achievement_code, avg_score: w.avg_score, last_level: w.last_level, attempt_count: w.attempt_count
      });
    }
    const weakAchievements = Array.from(weakMap.values());

    // 개인정보 게이트(정책 2026-06): 담임/담당은 실명, 비담임(관리자 비소유 등) 거시뷰는 n<10 → 익명.
    //   warnings 는 위험 학생을 displayName 으로 직접 노출 → 비담임 소표본 열람 시 식별 마스킹 필요.
    const studentCount = memberRows.filter(m => true).length; // 학생 멤버 수(쿼리에서 이미 student 한정)
    const masked = shouldMaskNames(req, classId, studentCount);
    let outInactive = inactive, outNoData = noData, outWrong = consecutiveWrong, outWeak = weakAchievements;
    if (masked) {
      const labelById = new Map();
      memberRows.forEach((m, i) => labelById.set(m.user_id, maskNameLabel(i)));
      const relabel = (u) => ({ ...u, displayName: labelById.get(u.userId) || '학생' });
      outInactive = inactive.map(relabel);
      outNoData = noData.map(relabel);
      outWrong = consecutiveWrong.map(relabel);
      outWeak = weakAchievements.map(relabel);
    }

    res.json({
      success: true, classId, masked, minSample: MIN_SAMPLE_N,
      inactive: outInactive, noData: outNoData, consecutiveWrong: outWrong, weakAchievements: outWeak,
      summary: {
        inactiveCount: outInactive.length,
        noDataCount: outNoData.length,
        consecutiveWrongCount: outWrong.length,
        weakCount: outWeak.length
      }
    });
  } catch (err) {
    console.error('[LRS] /warnings error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 8. /api/lrs/export — 위에서 이미 format=csv|excel|xlsx|jsonld|xapi|json 지원

// ─────────────────────────────────────────────────────────
// Phase B 신규 엔드포인트: perform / custom / teacher-index / daily-snapshot
// ─────────────────────────────────────────────────────────

/** 테이블 존재 확인 헬퍼 */
function _tableExists(name){
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    return !!row;
  } catch (_) { return false; }
}

// (1) GET /api/lrs/stats/perform
router.get('/stats/perform', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const sf = resolveScopeFilter(req, 'll');
    // '자기주도 학습' 버킷 = self_learn(시드/구 경로) ∪ daily_complete(오늘의 학습 실 경로).
    //   completeDailyItem()(db/self-learn-extended.js)는 오늘의 학습 이수를 activity_type='daily_complete'
    //   로 발행하지만, LRS 활동유형 요약/추이는 self_learn 만 읽어 실제 이수가 표에서 누락됐다.
    //   두 타입은 서로 다른 row(각 이수 1건 → 1 row)라 함께 세도 이중 카운트 없음.
    //   집계·라벨·추이는 daily_complete 를 self_learn 으로 정규화해 '자기주도 학습' 단일 행으로 합친다.
    const SELF_LEARN_TYPES = ['self_learn', 'daily_complete'];
    // 학습 수행에 포함할 콘텐츠·수업 성격 활동:
    //   content_solve(콘텐츠 문항풀이, 점수 있음), content_view(콘텐츠 학습, 점수 없음),
    //   lesson_progress(수업 진행, result_score 는 진도율 0~1 이라 '점수'가 아님 → 표에서 점수 없음 처리).
    //   추이(trend)는 이 3종을 '콘텐츠 학습' 1계열로 묶어 계열 폭주를 막는다.
    const CONTENT_TYPES = ['content_solve', 'content_view', 'lesson_progress'];
    // 제외: attendance_checkin(감정출석)·post_create(게시글)·survey_respond(설문) — 학습 수행 아님.
    const perfTypes = ['exam_complete', 'homework_submit', ...SELF_LEARN_TYPES, ...CONTENT_TYPES];
    const typePH = perfTypes.map(()=>'?').join(',');
    const baseWhere = `WHERE ll.activity_type IN (${typePH}) ${r.where} ${sf.where}`;
    const baseParams = [...perfTypes, ...r.params, ...sf.params];
    // self_learn 버킷 판정 SQL 조각 (재사용). daily_complete 도 자기주도 학습으로 합산.
    const SELF_SQL = `ll.activity_type IN ('self_learn','daily_complete')`;
    // 콘텐츠 학습 버킷 판정 SQL 조각 (추이 묶음 계열 + summary KPI 재사용).
    const CONTENT_SQL = `ll.activity_type IN ('content_solve','content_view','lesson_progress')`;
    // '점수' 개념이 있는 유형만 평균점수 집계 대상. content_view/lesson_progress 는 제외(진도율·조회는 점수 아님).
    //   → byType 평균점수 컬럼에서 이 두 유형은 '-'(NULL) 로 표시된다.
    const SCORED_SQL = `ll.activity_type IN ('exam_complete','homework_submit','self_learn','daily_complete','content_solve')`;
    // ── 표시용 0~100 정규화 (표시 계층 band-aid) ──────────────────────────────
    //   DB 저장 스케일 혼재: exam/self/homework_graded 등은 result_score 0~1, content_solve 는 0~100.
    //   그대로 AVG 하면 평가 평균이 0.9(=94.5%)로 오해되게 뜬다(사용자 지적 결함).
    //   행 단위로 0~1 값이면 ×100 해서 모든 '평균 점수'를 0~100 로 통일한다.
    //   (저장 스케일 통일 마이그레이션은 별건 — 여기선 표시만 교정.)
    //   ※ lesson_progress 는 진도율이라 애초에 SCORED_SQL 밖 → 정규화 대상 아님(계속 NULL/'-').
    const NORM_SCORE = `(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)`;

    // summary
    const sumRow = db.prepare(`
      SELECT
        SUM(CASE WHEN ll.activity_type='exam_complete' THEN 1 ELSE 0 END) exam_cnt,
        AVG(CASE WHEN ll.activity_type='exam_complete' THEN ${NORM_SCORE} END) exam_avg,
        SUM(CASE WHEN ll.activity_type='exam_complete' AND ll.result_success=1 THEN 1 ELSE 0 END) exam_ok,
        SUM(CASE WHEN ll.activity_type='homework_submit' THEN 1 ELSE 0 END) hw_cnt,
        SUM(CASE WHEN ll.activity_type='homework_submit' AND ll.result_success=1 THEN 1 ELSE 0 END) hw_ok,
        SUM(CASE WHEN ${SELF_SQL} THEN 1 ELSE 0 END) self_cnt,
        AVG(CASE WHEN ${SELF_SQL} THEN ${NORM_SCORE} END) self_avg,
        SUM(CASE WHEN ${CONTENT_SQL} THEN 1 ELSE 0 END) content_cnt,
        AVG(CASE WHEN ll.activity_type='content_solve' THEN ${NORM_SCORE} END) content_solve_avg,
        COUNT(*) total_acts
      FROM learning_logs ll
      ${baseWhere}
    `).get(...baseParams);

    const summary = {
      examCount: sumRow.exam_cnt || 0,
      examAvgScore: sumRow.exam_avg != null ? Math.round(sumRow.exam_avg*10)/10 : null,
      examCompletionRate: sumRow.exam_cnt ? Math.round((sumRow.exam_ok||0)*1000/sumRow.exam_cnt)/10 : null,
      homeworkCount: sumRow.hw_cnt || 0,
      homeworkSubmitRate: sumRow.hw_cnt ? Math.round((sumRow.hw_ok||0)*1000/sumRow.hw_cnt)/10 : null,
      selfLearnCount: sumRow.self_cnt || 0,
      selfLearnAvgScore: sumRow.self_avg != null ? Math.round(sumRow.self_avg*10)/10 : null,
      // 콘텐츠 학습(콘텐츠 문항풀이·콘텐츠 학습·수업 진행) 통합 건수. 평균점수는 점수 있는 content_solve 만.
      contentCount: sumRow.content_cnt || 0,
      contentSolveAvgScore: sumRow.content_solve_avg != null ? Math.round(sumRow.content_solve_avg*10)/10 : null,
      totalActs: sumRow.total_acts || 0
    };

    // byType — "활동 유형별 요약" 표는 **모든 activity_type 을 투명하게** 노출한다.
    //   (학습 수행 화이트리스트 baseWhere 를 쓰지 않고, 날짜·스코프만 건 tableWhere 로 전 유형 GROUP BY.)
    //   summary/byStudent/trend 는 학습 위주(perfTypes 화이트리스트) 유지 — 표만 전 유형.
    //   daily_complete 는 self_learn 으로 정규화해 '자기주도 학습' 한 행으로 계속 병합(표에 두 줄 방지).
    //   점수: SCORED_SQL(평가·과제·자기주도·콘텐츠 문항풀이)만 평균 — 그 외(조회·수업진행·감정출석·게시글·설문)는 NULL → '-'.
    const tableWhere = `WHERE 1=1 ${r.where} ${sf.where}`;
    const tableParams = [...r.params, ...sf.params];
    const typeLabels = {
      exam_complete:'평가 완료', homework_submit:'과제 제출', self_learn:'자기주도 학습',
      content_solve:'콘텐츠 문항풀이', content_view:'콘텐츠 학습', lesson_progress:'수업 진행',
      attendance_checkin:'감정 출석', post_create:'게시글 작성', survey_respond:'설문 응답',
      // 그 밖의 알려진 학습 활동 유형(라벨만 부여, 그래도 미지 유형은 raw 폴백).
      problem_attempt:'문항 풀이 시도', wrong_note_retry:'오답노트 재도전',
      homework_graded:'과제 채점 완료', survey_create:'설문 생성', post_comment:'댓글 작성'
    };
    const byType = db.prepare(`
      SELECT CASE WHEN ll.activity_type='daily_complete' THEN 'self_learn' ELSE ll.activity_type END AS activity_type,
             COUNT(*) cnt,
             AVG(CASE WHEN ${SCORED_SQL} THEN ${NORM_SCORE} END) avg_score,
             AVG(COALESCE(ll.duration_sec, CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)) avg_dur_sec
      FROM learning_logs ll
      ${tableWhere}
      GROUP BY CASE WHEN ll.activity_type='daily_complete' THEN 'self_learn' ELSE ll.activity_type END
      ORDER BY cnt DESC
    `).all(...tableParams).map(row => ({
      activity_type: row.activity_type,
      // 미지 유형도 코드가 죽지 않게 raw activity_type 폴백.
      label: typeLabels[row.activity_type] || row.activity_type,
      count: row.cnt || 0,
      avgScore: row.avg_score != null ? Math.round(row.avg_score*10)/10 : null,
      avgDurationMin: row.avg_dur_sec ? Math.round(row.avg_dur_sec/60*10)/10 : 0
    }));

    // byStudent (mine이 아닐 때만)
    let byStudent = [];
    if (sf.scope !== 'mine') {
      // 학생 랭킹: 모집단을 role='student'로 고정 (비학생 체험 기록 격리).
      byStudent = db.prepare(`
        SELECT ll.user_id,
               COALESCE(u.display_name, u.username) name,
               SUM(CASE WHEN ll.activity_type='exam_complete' THEN 1 ELSE 0 END) exam_cnt,
               SUM(CASE WHEN ll.activity_type='homework_submit' THEN 1 ELSE 0 END) homework_cnt,
               SUM(CASE WHEN ${SELF_SQL} THEN 1 ELSE 0 END) self_cnt,
               COUNT(*) total_cnt,
               AVG(CASE WHEN ${SCORED_SQL} THEN ${NORM_SCORE} END) avg_score
        FROM learning_logs ll
        JOIN users u ON u.id = ll.user_id
        ${baseWhere} AND u.role = 'student'
        GROUP BY ll.user_id
        ORDER BY total_cnt DESC
        LIMIT 100
      `).all(...baseParams).map(r => ({
        user_id: r.user_id,
        name: r.name || ('#'+r.user_id),
        exam_cnt: r.exam_cnt || 0,
        homework_cnt: r.homework_cnt || 0,
        self_cnt: r.self_cnt || 0,
        total_cnt: r.total_cnt || 0,
        avg_score: r.avg_score != null ? Math.round(r.avg_score*10)/10 : null
      }));
    }

    // trend — 그래프 가독성 위해 학습 4계열만: 평가·과제·자기주도·콘텐츠 학습(content 3종 묶음).
    //   content_solve+content_view+lesson_progress 를 content_cnt 한 계열로 SUM(계열 폭주 방지).
    //   attendance/post/survey 는 추이에 넣지 않는다(표에만 노출).
    const trend = db.prepare(`
      SELECT DATE(ll.created_at) date,
             SUM(CASE WHEN ll.activity_type='exam_complete' THEN 1 ELSE 0 END) exam_cnt,
             SUM(CASE WHEN ll.activity_type='homework_submit' THEN 1 ELSE 0 END) homework_cnt,
             SUM(CASE WHEN ${SELF_SQL} THEN 1 ELSE 0 END) self_cnt,
             SUM(CASE WHEN ${CONTENT_SQL} THEN 1 ELSE 0 END) content_cnt
      FROM learning_logs ll
      ${baseWhere}
      GROUP BY DATE(ll.created_at)
      ORDER BY date
    `).all(...baseParams);

    res.json({ success:true, scope: sf.scope, summary, byType, byStudent, trend });
  } catch (err) {
    console.error('[LRS] /stats/perform error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (1b) GET /api/lrs/perform/detail — KPI 카드 드릴다운 내역
//   기획서: 작업지시서/LRS_활동유형별수행_카드드릴다운_스펙.md
//   ?bucket=<exam|homework|self|content|all>  (필수)
//   &segment=<view|lesson|solve>              (선택 — bucket=content 세그먼트 필터)
//   &days|&period|&from&to                     (카드와 동일 기간 — dateRangeWhere 재사용)
//   &userId=<n>                                (교사/관리자가 특정 학생 조회. 미지정=본인)
//
//   ★카운트 일치 계약(불변식): count 는 JOIN 없이 learning_logs 원천 COUNT(*).
//     동일 dateRangeWhere(created_at,'ll') + 명시적 ll.user_id 필터로 /stats/perform 학생 뷰
//     (scope=mine=본인 user_id)의 카드 숫자와 정확히 일치. 제목 조인 실패해도 count 불변.
//     → count == items.length(200 상한 내) == 카드 숫자.
//
//   [P2-2 확장 — 작업지시서/LRS_P2_교사히트맵_타임라인메타_스펙.md §3-3]
//     &limit=<n>        items 상한(1~200 클램프, 기본 200=현행). count 는 현행 그대로 전체 건수
//                       (limit 지정 시 count ≠ items.length 허용 — 타임라인 "최근 8건" 스냅 케이스 한정).
//     progressPct(상시) lesson_progress 항목: result_score(=진도율 0~1, L202 주석 정본) → 0~100 정수.
//                       result_score null 이면 필드 생략. (NORM 경유 — 0~100 저장 이형도 안전)
//     hwStatus(상시)    homework_submit 항목: result_score 유무 → 'graded'(채점완료)/'submitted'(제출완료).
//     &withClassAvg=1   옵트인: exam_complete 항목에 한해 같은 target_id 의 exam_complete 로그
//                       전체(응시자 본인 포함·기간 무관)에서 AVG(NORM_SCORE) 0.1 반올림 classAvg +
//                       COUNT(DISTINCT user_id) takers. ★takers < MIN_PEERS(5) 면 두 필드 모두 생략.
//                       GROUP BY target_id 단일 쿼리(항목당 반복 쿼리 금지). 개별 학생 값·명단 미포함.
//                       미지정 시 classAvg·takers 키 자체 부재(현행 응답 불변 — INV-K13④).
//                       학령 가드는 FE 네트워크 레벨(초등은 요청 자체를 안 보냄 — 스펙 §3-3).
//     &learnOnly=1      [감리 R-1] 옵트인: 유형을 "학습활동" 정본 7종(LRS_LEARN_ACTIVITY_TYPES,
//                       L281 — 능동 이수·응시·제출·풀이)과의 교집합으로 좁힌다. content_view 등
//                       조회성 제외 — "최근 학습 활동" 타임라인 카드용(조회 로그가 200 cap 을
//                       점유해 실제 학습 행이 밀리는 것 방지). count·segments·subtotals 도 필터 후
//                       기준으로 일관(표시값=내역 계약 유지 — 합=count 불변식 보존).
//                       값이 정확히 '1' 일 때만 활성 — 미지정/그 외 값은 응답 완전 불변.
// ─────────────────────────────────────────────────────────────────────────────
const PERFORM_DETAIL_ITEM_CAP = 200;
// bucket → activity_type 화이트리스트 (전부 learning_logs 단일 원천).
const PERFORM_BUCKET_TYPES = {
  exam:     ['exam_complete'],
  homework: ['homework_submit'],
  self:     ['self_learn', 'daily_complete'],
  content:  ['content_view', 'lesson_progress', 'content_solve'],
  all:      ['exam_complete', 'homework_submit', 'self_learn', 'daily_complete',
             'content_view', 'lesson_progress', 'content_solve'],
};
const PERFORM_BUCKET_TITLE = {
  exam: '완료 평가', homework: '제출 과제', self: '자기주도 학습',
  content: '콘텐츠 활동', all: '학습 활동',
};
// content 세그먼트 → activity_type
const PERFORM_SEGMENT_TYPE = { view: 'content_view', lesson: 'lesson_progress', solve: 'content_solve' };
const PERFORM_SEGMENT_LABEL = { view: '콘텐츠 학습', lesson: '수업 진행', solve: '문항풀이' };
// 점수(정답률) 개념이 있는 유형만 NORM_SCORE 정규화, 그 외(조회·진도율)는 null.
const PERFORM_SCORED_TYPES = new Set([
  'exam_complete', 'homework_submit', 'self_learn', 'daily_complete', 'content_solve',
]);

router.get('/perform/detail', requireAuth, (req, res) => {
  try {
    // P0-1 드릴 (KERIS 로드맵 §3 P0-1 (b)·(d) + 인벤토리 스펙 SP7 파라미터 확장):
    //   ?activityType=wrong_note_retry — 재풀이 카드 "다시 푼 문항" 문항 단위 내역.
    //   신규 detail 라우트 금지 계약에 따라 본 라우트의 파라미터로 흡수한다.
    //   (그 외 activityType 값은 아직 미지원 — SP7 전 유형 일반화는 P1 범위.)
    const activityType = String(req.query.activityType || '').trim();
    const bucket = String(req.query.bucket || '').toLowerCase();
    if (activityType && activityType !== 'wrong_note_retry') {
      return res.status(400).json({ success: false, message: '지원하지 않는 activityType 파라미터입니다.' });
    }
    if (!activityType && !PERFORM_BUCKET_TYPES[bucket]) {
      return res.status(400).json({ success: false, message: '잘못된 bucket 파라미터입니다.' });
    }
    // 조회 대상 학생: userId 미지정이면 본인. 학생은 본인만(canViewUser 403).
    const userId = parseInt(req.query.userId, 10) || req.user.id;
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    // 기간 필터: /stats/perform 과 100% 동일 코드(dateRangeWhere) 재사용 → 카운트 일치 보증.
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    // P2-2: items 상한(1~200 클램프, 기본 200=현행 CAP → 미지정 시 응답 불변).
    const limitRaw = parseInt(req.query.limit, 10);
    const itemLimit = Number.isInteger(limitRaw)
      ? Math.max(1, Math.min(PERFORM_DETAIL_ITEM_CAP, limitRaw))
      : PERFORM_DETAIL_ITEM_CAP;
    // P2-2: 반평균 옵트인(중·고 전용 — FE 가 학령 가드. 초등은 이 파라미터를 보내지 않음).
    const withClassAvg = String(req.query.withClassAvg || '') === '1';
    // [감리 R-1] 학습활동 정본 7종 옵트인 — '1' 일 때만 활성(그 외 값·미지정 = 완전 불변).
    const learnOnly = String(req.query.learnOnly || '') === '1';
    const LEARN_SET = learnOnly ? new Set(LRS_LEARN_ACTIVITY_TYPES) : null;
    /** learnOnly 활성 시 유형 목록을 7종 교집합으로 좁힌다(비활성 시 원본 그대로). */
    const applyLearnOnly = (typeList) => (LEARN_SET ? typeList.filter(t => LEARN_SET.has(t)) : typeList);

    // ── activityType=wrong_note_retry 분기 — 문항 단위(로그 단위 아님) ──────────
    //   count = 기간 내 DISTINCT target_id 수 == /retry-growth questions(N) == items.length
    //   (카드=내역 계약, 기획서 §3 P0-1 (d) "count == N == items.length").
    //   문항 식별: 오답 id(wrongId)·question_text 앞 40자·성공여부·일시.
    //   성공여부 = 기간 내 result_success=1 이 1회 이상(재풀이 M 산식과 동일 기준).
    //   result_score 참조 없음(산식 정본 = result_success). "틀림" 어휘 금지 → 맞힘/아직.
    if (activityType === 'wrong_note_retry') {
      const countRow = db.prepare(`
        SELECT COUNT(DISTINCT ll.target_id) AS c
        FROM learning_logs ll
        WHERE ll.user_id = ? AND ll.activity_type = 'wrong_note_retry'
          AND ll.result_success IS NOT NULL ${r.where}
      `).get(userId, ...r.params);
      const count = countRow.c || 0;
      const rows = db.prepare(`
        SELECT ll.target_id,
               MAX(CASE WHEN ll.result_success = 1 THEN 1 ELSE 0 END) AS succeeded,
               MAX(ll.created_at) AS last_at,
               COUNT(*) AS attempts,
               w.id AS wrong_id, w.question_text, w.subject
        FROM learning_logs ll
        LEFT JOIN wrong_answers w ON w.id = CAST(ll.target_id AS INTEGER)
        WHERE ll.user_id = ? AND ll.activity_type = 'wrong_note_retry'
          AND ll.result_success IS NOT NULL ${r.where}
        GROUP BY ll.target_id
        ORDER BY last_at DESC
        LIMIT ?
      `).all(userId, ...r.params, PERFORM_DETAIL_ITEM_CAP);
      const items = rows.map(row => {
        const ok = !!row.succeeded;
        const qText = String(row.question_text || '').replace(/\s+/g, ' ').trim();
        return {
          wrongId: row.wrong_id != null ? row.wrong_id : row.target_id, // 오답 id (조인 실패 시 target_id 폴백)
          title: qText ? qText.slice(0, 40) : '오답 문항',
          date: row.last_at,
          score: null,                          // result_score 의존 금지 — 항상 null
          success: ok,                          // 다시 맞혔는가 (M 산식과 동일 기준)
          attempts: row.attempts || 1,
          sub: (row.attempts || 1) > 1 ? `재도전 ${row.attempts}회` : '',
          typeLabel: '오답노트 재도전',
          subject: row.subject || null,
          badge: ok ? { text: '맞힘', tone: 'success' } : { text: '아직', tone: 'neutral' },
        };
      });
      const out = {
        success: true,
        activityType: 'wrong_note_retry',
        bucket: null,
        title: '다시 푼 문항',
        period: r.fromDate && r.toDate ? `${r.fromDate} ~ ${r.toDate}` : null,
        count,
        items,
      };
      if (count > PERFORM_DETAIL_ITEM_CAP) {
        out.note = `최근 ${PERFORM_DETAIL_ITEM_CAP}건만 표시합니다.`;
      }
      return res.json(out);
    }

    // segment 필터(content 전용). 유효하지 않으면 무시(전체 45).
    let types = PERFORM_BUCKET_TYPES[bucket];
    let segmentKey = null;
    if (bucket === 'content') {
      const seg = String(req.query.segment || '').toLowerCase();
      if (PERFORM_SEGMENT_TYPE[seg]) { types = [PERFORM_SEGMENT_TYPE[seg]]; segmentKey = seg; }
    }
    // [감리 R-1] learnOnly=1 → 7종 교집합(조회성 content_view 등 제거). 미지정 시 무변화.
    types = applyLearnOnly(types);
    // 교집합이 공집합(예: bucket=content&segment=view&learnOnly=1)이면 SQL IN () 없이 빈 응답.
    if (types.length === 0) {
      return res.json({
        success: true, bucket, title: PERFORM_BUCKET_TITLE[bucket],
        period: r.fromDate && r.toDate ? `${r.fromDate} ~ ${r.toDate}` : null,
        count: 0, items: [],
      });
    }
    const typePH = types.map(() => '?').join(',');
    // ★ count: JOIN 없이 learning_logs 원천 COUNT — 카드와 구조적으로 동일.
    //   learnOnly 활성 시엔 필터 후 유형 기준(표시값=내역 — items 와 같은 WHERE).
    const countRow = db.prepare(`
      SELECT COUNT(*) c
      FROM learning_logs ll
      WHERE ll.user_id = ? AND ll.activity_type IN (${typePH}) ${r.where}
    `).get(userId, ...types, ...r.params);
    const count = countRow.c || 0;

    // bucket=content 세그먼트 소계 (segment 미지정일 때만 소계 제공, 합=count)
    //   learnOnly 시 7종 밖 세그먼트(view)는 목록에서 제외 — 합=count 불변식 유지.
    let segments;
    if (bucket === 'content' && !segmentKey) {
      segments = ['view', 'lesson', 'solve']
        .filter(k => !LEARN_SET || LEARN_SET.has(PERFORM_SEGMENT_TYPE[k]))
        .map(k => {
          const t = PERFORM_SEGMENT_TYPE[k];
          const cr = db.prepare(`
            SELECT COUNT(*) c FROM learning_logs ll
            WHERE ll.user_id = ? AND ll.activity_type = ? ${r.where}
          `).get(userId, t, ...r.params);
          return { key: k, label: PERFORM_SEGMENT_LABEL[k], count: cr.c || 0 };
        });
    }
    // bucket=all 버킷 소계 (exam/homework/self/content, 합=count=totalActs)
    //   learnOnly 시 각 버킷 유형도 7종 교집합으로 계산(content=lesson+solve) — 합=count 유지.
    let subtotals;
    if (bucket === 'all') {
      subtotals = ['exam', 'homework', 'self', 'content'].map(b => {
        const bt = applyLearnOnly(PERFORM_BUCKET_TYPES[b]);
        if (bt.length === 0) return { bucket: b, label: PERFORM_BUCKET_TITLE[b], count: 0 };
        const ph = bt.map(() => '?').join(',');
        const cr = db.prepare(`
          SELECT COUNT(*) c FROM learning_logs ll
          WHERE ll.user_id = ? AND ll.activity_type IN (${ph}) ${r.where}
        `).get(userId, ...bt, ...r.params);
        return { bucket: b, label: PERFORM_BUCKET_TITLE[b], count: cr.c || 0 };
      });
    }

    // items: LEFT JOIN 으로 제목만 보강(조인 실패해도 count 불변). 최신순, 최대 200.
    //   각 대상 테이블을 개별 LEFT JOIN(문자열 target_id → 정수 id 는 CAST, exams.id 는 uuid 문자열).
    const NORM = `(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)`;
    const rows = db.prepare(`
      SELECT ll.activity_type, ll.target_type, ll.target_id, ll.created_at,
             ll.result_score, ll.result_success, ll.correct_count, ll.total_items,
             ll.source_service,
             e.title  AS exam_title,
             h.title  AS hw_title,
             di.item_title AS self_title,
             c.title  AS content_title,
             l.title  AS lesson_title,
             ${NORM}  AS norm_score
      FROM learning_logs ll
      LEFT JOIN exams e   ON ll.activity_type='exam_complete'    AND e.id = ll.target_id
      LEFT JOIN homework h ON ll.activity_type='homework_submit' AND h.id = CAST(ll.target_id AS INTEGER)
      LEFT JOIN daily_learning_items di ON ll.activity_type IN ('self_learn','daily_complete') AND di.id = CAST(ll.target_id AS INTEGER)
      LEFT JOIN contents c ON ll.activity_type IN ('content_view','content_solve') AND c.id = CAST(ll.target_id AS INTEGER)
      LEFT JOIN lessons  l ON ll.activity_type='lesson_progress' AND l.id = CAST(ll.target_id AS INTEGER)
      WHERE ll.user_id = ? AND ll.activity_type IN (${typePH}) ${r.where}
      ORDER BY ll.created_at DESC
      LIMIT ?
    `).all(userId, ...types, ...r.params, itemLimit);

    const items = rows.map(row => {
      const at = row.activity_type;
      // 제목(폴백 라벨)
      let title, typeLabel, badge, seg;
      if (at === 'exam_complete') {
        title = row.exam_title || '평가';
        typeLabel = '채움클래스 평가';
        badge = { text: '채움클래스', tone: 'success' };
      } else if (at === 'homework_submit') {
        title = row.hw_title || '과제';
        typeLabel = '과제';
        badge = { text: '과제', tone: 'info' };
      } else if (at === 'self_learn' || at === 'daily_complete') {
        title = row.self_title || '오늘의 학습';
        // 출처(오늘의학습/AI맞춤/오답노트) — source_service 로 대략 구분. 애매하면 '자기주도'.
        const src = String(row.source_service || '');
        typeLabel = src.includes('wrong') ? '오답노트' : (src.includes('ai') || src.includes('map') ? 'AI맞춤' : '오늘의 학습');
        badge = { text: '자기주도', tone: 'info' };
      } else if (at === 'content_view') {
        title = row.content_title || '콘텐츠';
        typeLabel = '콘텐츠 학습'; seg = 'view';
        badge = { text: '콘텐츠 학습', tone: 'neutral' };
      } else if (at === 'lesson_progress') {
        title = row.lesson_title || '콘텐츠';
        typeLabel = '수업 진행'; seg = 'lesson';
        badge = { text: '수업 진행', tone: 'info' };
      } else if (at === 'content_solve') {
        title = row.content_title || '콘텐츠';
        typeLabel = '콘텐츠 문항풀이'; seg = 'solve';
        badge = { text: '문항풀이', tone: 'success' };
      } else {
        title = '학습 활동'; typeLabel = '학습'; badge = { text: '학습', tone: 'neutral' };
      }
      // 점수: 점수 개념 있는 유형만 0~100 정규화, 조회·진도율은 null.
      const score = (PERFORM_SCORED_TYPES.has(at) && row.norm_score != null)
        ? Math.round(Number(row.norm_score) * 10) / 10
        : null;
      // sub(부가): exam 은 정답 c/t 있으면.
      let sub = '';
      if (at === 'exam_complete' && row.total_items != null && row.correct_count != null) {
        sub = `정답 ${row.correct_count}/${row.total_items}`;
      }
      const item = { title, date: row.created_at, score, sub, typeLabel, badge };
      if (seg) item.segment = seg;
      // P2-2 상시 메타(스펙 §3-3): 진도율·과제 상태 — 타임라인/드릴 모달 공용(같은 엔드포인트=같은 값).
      if (at === 'lesson_progress' && row.result_score != null && row.norm_score != null) {
        // result_score 가 곧 진도율(0~1, L202 주석 정본) → ×100 정수. NORM 경유로 0~100 저장 이형도 안전.
        item.progressPct = Math.max(0, Math.min(100, Math.round(Number(row.norm_score))));
      }
      if (at === 'homework_submit') {
        item.hwStatus = row.result_score != null ? 'graded' : 'submitted';
      }
      return item;
    });

    // P2-2 옵트인(스펙 §3-3): 평가 반평균 — 같은 target_id 의 exam_complete 로그 전체(본인 포함·
    //   기간 무관 — peer-compare 정책과 동일)에서 AVG(NORM)·응시자 수. GROUP BY 단일 쿼리.
    //   ★ 표본 가드: takers < MIN_PEERS(5) → 두 필드 모두 생략. 개별 학생 값·명단·id 미포함(익명 집계).
    if (withClassAvg) {
      const tidByKey = new Map(); // String(tid) → 원본 값(타입 보존 바인딩 — TEXT/INTEGER 혼재 방어)
      rows.forEach(row => {
        if (row.activity_type === 'exam_complete' && row.target_id != null) {
          tidByKey.set(String(row.target_id), row.target_id);
        }
      });
      if (tidByKey.size > 0) {
        const tids = [...tidByKey.values()];
        const tph = tids.map(() => '?').join(',');
        const stats = db.prepare(`
          SELECT ll.target_id AS tid,
                 AVG(${NORM}) AS avg_norm,
                 COUNT(DISTINCT ll.user_id) AS takers
          FROM learning_logs ll
          WHERE ll.activity_type = 'exam_complete' AND ll.target_id IN (${tph})
          GROUP BY ll.target_id
        `).all(...tids);
        const byTid = new Map(stats.map(s => [String(s.tid), s]));
        rows.forEach((row, i) => {
          if (row.activity_type !== 'exam_complete' || row.target_id == null) return;
          const s = byTid.get(String(row.target_id));
          if (!s || s.avg_norm == null || (s.takers || 0) < MIN_PEERS) return; // 표본 가드
          items[i].classAvg = Math.round(s.avg_norm * 10) / 10;
          items[i].takers = s.takers;
        });
      }
    }

    const out = {
      success: true,
      bucket,
      title: PERFORM_BUCKET_TITLE[bucket],
      period: r.fromDate && r.toDate ? `${r.fromDate} ~ ${r.toDate}` : null,
      count,
      items,
    };
    if (segments) out.segments = segments;
    if (subtotals) out.subtotals = subtotals;
    if (count > itemLimit) {
      // limit 미지정 시 itemLimit == CAP(200) → 현행 문구·발생 조건 그대로(응답 불변).
      out.note = `최근 ${itemLimit}건만 표시합니다.`;
    }
    res.json(out);
  } catch (err) {
    console.error('[LRS] /perform/detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// (2) GET /api/lrs/stats/custom
router.get('/stats/custom', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    // §C-5 fix: self-learn 로그는 class_id 99.4% NULL → class_id 기반 scope 는 교사 0건.
    //   멤버십(소속 학생 user_id IN) 기반으로 교체해 교사가 우리 반 학생 AI맞춤학습을 보게 함.
    const sf = resolveMembershipScopeFilter(req, 'll');
    const baseWhere = `WHERE ll.source_service='self-learn' ${r.where} ${sf.where}`;
    const baseParams = [...r.params, ...sf.params];

    // 스케일 정규화(감사 §4·P0-5): self-learn 로그는 result_score 를 0~1 로 저장(0.75~1.0).
    //   AVG(result_score) 를 그대로 내보내면 "평균 0.9점"으로 오노출된다. perform 선례대로
    //   NORM_SCORE(≤1 이면 ×100)로 0~100 정규화한다.
    const NORM_SCORE = `(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)`;
    const sumRow = db.prepare(`
      SELECT COUNT(*) recommended,
             SUM(CASE WHEN ll.result_success=1 THEN 1 ELSE 0 END) completed,
             AVG(${NORM_SCORE}) avg_score,
             COUNT(DISTINCT ll.user_id) uniq_learners
      FROM learning_logs ll
      ${baseWhere}
    `).get(...baseParams);

    const summary = {
      recommendedCount: sumRow.recommended || 0,
      completedCount: sumRow.completed || 0,
      completionRate: sumRow.recommended ? Math.round((sumRow.completed||0)*1000/sumRow.recommended)/10 : null,
      avgScore: sumRow.avg_score != null ? Math.round(sumRow.avg_score*10)/10 : null,
      uniqueLearners: sumRow.uniq_learners || 0
    };

    const byDay = db.prepare(`
      SELECT DATE(ll.created_at) date,
             COUNT(*) recommended,
             SUM(CASE WHEN ll.result_success=1 THEN 1 ELSE 0 END) completed
      FROM learning_logs ll
      ${baseWhere}
      GROUP BY DATE(ll.created_at)
      ORDER BY date
    `).all(...baseParams);

    const weakTargets = db.prepare(`
      SELECT ll.achievement_code,
             COUNT(*) attempts,
             AVG(${NORM_SCORE}) avg_score,
             MAX(ll.created_at) last_at
      FROM learning_logs ll
      ${baseWhere} AND ll.achievement_code IS NOT NULL AND ll.achievement_code != ''
      GROUP BY ll.achievement_code
      HAVING attempts >= 1
      ORDER BY avg_score ASC NULLS LAST
      LIMIT 10
    `).all(...baseParams).map(w => {
      // 코드→이름 통일(P0-4): 약점표에 단원명 label 부착(raw 코드 단독 노출 방지). FE 는 label||code 표기.
      const nm = achievementLabel(w.achievement_code);
      return {
        achievement_code: w.achievement_code,
        label: nm.label,            // 화면 표기용 짧은 이름(단원명 우선)
        fullLabel: nm.fullLabel,    // 툴팁/보조 서술
        subject_label: nm.subjectLabel,
        attempts: w.attempts,
        avg_score: w.avg_score != null ? Math.round(w.avg_score*10)/10 : null,
        last_at: w.last_at
      };
    });

    res.json({ success:true, scope: sf.scope, period: { fromDate: r.fromDate, toDate: r.toDate }, summary, byDay, weakTargets });
  } catch (err) {
    console.error('[LRS] /stats/custom error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

/* ── teacher-index 헬퍼 (교사 본인 활동 4소스 공통 산식) ──────────────────
 * 4소스 = 콘텐츠(contents.creator_id) · 수업(lessons.teacher_id) ·
 *         평가(exams.owner_id) · 피드백(homework_feedback.author_id).
 * 모두 created_at 기준 '해당 기간 신규' 카운트. 산식을 한 곳에 모아
 *   메인 KPI / prev(직전기간) / trend(버킷)이 동일 정의를 공유하게 한다.
 */
function _teacherMetricsInRange(tid, fromIso, toIso) {
  // fromIso/toIso 는 'YYYY-MM-DD'(포함). null 이면 무제한.
  const cond = (col) => {
    let w = ''; const p = [];
    if (fromIso) { w += ` AND DATE(${col}) >= ?`; p.push(fromIso); }
    if (toIso)   { w += ` AND DATE(${col}) <= ?`; p.push(toIso); }
    return { w, p };
  };
  const cnt = (sql, id, col) => {
    const { w, p } = cond(col);
    try { return db.prepare(sql + w).get(id, ...p).c || 0; } catch (_) { return 0; }
  };
  const out = { contents_authored: 0, lessons_held: 0, exams_opened: 0, feedback_count: 0 };
  if (_tableExists('contents'))
    out.contents_authored = cnt('SELECT COUNT(*) c FROM contents WHERE creator_id = ?', tid, 'created_at');
  if (_tableExists('lessons'))
    out.lessons_held = cnt('SELECT COUNT(*) c FROM lessons WHERE teacher_id = ?', tid, 'created_at');
  if (_tableExists('exams'))
    out.exams_opened = cnt('SELECT COUNT(*) c FROM exams WHERE owner_id = ?', tid, 'created_at');
  if (_tableExists('homework_feedback'))
    out.feedback_count = cnt('SELECT COUNT(*) c FROM homework_feedback WHERE author_id = ?', tid, 'created_at');
  return out;
}

/* 버킷 경계 산출: 기간 길이에 맞춰 일별(≤14일)·주별(≤90일)·월별(>90) 창을 만든다.
 *   각 원소 { from, to, label(한국어 날짜범위) }. from/to 는 포함 경계(YYYY-MM-DD). */
function _makeBuckets(fromIso, toIso) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const start = new Date(fromIso + 'T00:00:00Z');
  const end = new Date(toIso + 'T00:00:00Z');
  const spanDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const md = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const buckets = [];
  if (spanDays <= 14) {
    // 일별
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = iso(d);
      buckets.push({ from: day, to: day, label: md(d) });
    }
  } else if (spanDays <= 90) {
    // 주별(7일 창)
    for (let s = new Date(start); s <= end; s.setUTCDate(s.getUTCDate() + 7)) {
      const e = new Date(s); e.setUTCDate(e.getUTCDate() + 6);
      if (e > end) e.setTime(end.getTime());
      buckets.push({ from: iso(s), to: iso(e), label: `${md(s)}~${md(e)}` });
    }
  } else {
    // 월별(달력 월 경계)
    let s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    if (s < start) s = new Date(start);
    let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cur <= end) {
      const mEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)); // 해당 월 말일
      const bFrom = cur < start ? new Date(start) : new Date(cur);
      const bTo = mEnd > end ? new Date(end) : new Date(mEnd);
      buckets.push({ from: iso(bFrom), to: iso(bTo), label: `${cur.getUTCFullYear()}.${cur.getUTCMonth() + 1}` });
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  }
  return buckets;
}

/* 교사 본인의 최근 활동 4소스 UNION → created_at desc N건. 기간 필터 적용.
 *   각 원소 { type, title, class_name, date }. type ∈ content|lesson|exam|feedback. */
function _teacherRecentActivity(tid, fromIso, toIso, limit = 10) {
  const rangeCond = (col) => {
    let w = ''; const p = [];
    if (fromIso) { w += ` AND DATE(${col}) >= ?`; p.push(fromIso); }
    if (toIso)   { w += ` AND DATE(${col}) <= ?`; p.push(toIso); }
    return { w, p };
  };
  const rows = [];
  const pushAll = (sql, id, col, mapper) => {
    const { w, p } = rangeCond(col);
    try { db.prepare(sql + w + ` ORDER BY DATE(${col}) DESC LIMIT ?`).all(id, ...p, limit).forEach(r => rows.push(mapper(r))); }
    catch (_) {}
  };
  if (_tableExists('contents'))
    pushAll(
      'SELECT title, created_at FROM contents WHERE creator_id = ?', tid, 'created_at',
      (r) => ({ type: 'content', title: r.title || '(제목 없음)', class_name: null, date: String(r.created_at || '').slice(0, 10) })
    );
  if (_tableExists('lessons'))
    pushAll(
      `SELECT l.title, l.created_at, c.name class_name
         FROM lessons l LEFT JOIN classes c ON c.id = l.class_id
        WHERE l.teacher_id = ?`, tid, 'l.created_at',
      (r) => ({ type: 'lesson', title: r.title || '(제목 없음)', class_name: r.class_name || null, date: String(r.created_at || '').slice(0, 10) })
    );
  if (_tableExists('exams'))
    pushAll(
      `SELECT e.title, e.created_at, c.name class_name
         FROM exams e LEFT JOIN classes c ON c.id = e.class_id
        WHERE e.owner_id = ?`, tid, 'e.created_at',
      (r) => ({ type: 'exam', title: r.title || '(제목 없음)', class_name: r.class_name || null, date: String(r.created_at || '').slice(0, 10) })
    );
  if (_tableExists('homework_feedback'))
    pushAll(
      `SELECT hf.created_at, h.title htitle, c.name class_name
         FROM homework_feedback hf
         LEFT JOIN homework_submissions hs ON hs.id = hf.submission_id
         LEFT JOIN homework h ON h.id = hs.homework_id
         LEFT JOIN classes c ON c.id = h.class_id
        WHERE hf.author_id = ?`, tid, 'hf.created_at',
      (r) => ({ type: 'feedback', title: (r.htitle ? `${r.htitle} 과제 피드백` : '과제 피드백'), class_name: r.class_name || null, date: String(r.created_at || '').slice(0, 10) })
    );
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows.slice(0, limit);
}

// (3) GET /api/lrs/stats/teacher-index
router.get('/stats/teacher-index', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const role = req.user && req.user.role;
    const requestedScope = String(req.query.scope || '').toLowerCase();
    // scope 결정
    let scope = requestedScope;
    if (scope === 'all' && role !== 'admin') scope = 'mine';
    if (!scope) scope = (role === 'admin') ? 'all' : 'mine';

    let teacherIds = [];
    if (scope === 'all') {
      teacherIds = db.prepare("SELECT id FROM users WHERE role='teacher'").all().map(u => u.id);
    } else if (scope === 'class') {
      // class scope: 본인만 (교사 본인)
      teacherIds = [req.user.id];
    } else {
      if (role === 'teacher') teacherIds = [req.user.id];
      else teacherIds = [];
    }

    const hasContents = _tableExists('contents');
    const hasHomeworkFeedback = _tableExists('homework_feedback');
    const hasExams = _tableExists('exams');

    // 기간 반영(P1 교사 결함): 이전엔 contents/exams/feedback 카운트에 기간 필터가 없어 7d 와 90d 응답이
    //   완전 동일했다(기간 무반응). created_at 이 있는 '해당 기간에 만든/작성한' 지표는 기간 date-range 를 적용한다.
    //   기간 필터용 조각(별칭 없이 created_at 컬럼 직접). r.params 를 그대로 재사용.
    const periodWhere = r.where;               // ' AND DATE(created_at) >= ? AND DATE(created_at) <= ?' 또는 ''
    const periodParams = r.params;
    const teachers = teacherIds.map(tid => {
      const u = db.prepare('SELECT id, COALESCE(display_name, username) name FROM users WHERE id = ?').get(tid) || { id: tid, name: '#'+tid };
      // class_count 는 본질적으로 누적(반은 특정 기간에 '개설'되는 지표로 다루지 않음) → 기간 불변, 라벨로 명시.
      let classCount = 0;
      try { classCount = db.prepare('SELECT COUNT(*) c FROM classes WHERE owner_id = ?').get(tid).c; } catch (_){}
      // 아래 3종은 created_at 기준 '기간 내 신규 작성' 건수 → 기간 date-range 적용(기간 반응성 확보).
      let contentsAuthored = 0;
      if (hasContents) {
        try { contentsAuthored = db.prepare(`SELECT COUNT(*) c FROM contents WHERE creator_id = ? ${periodWhere}`).get(tid, ...periodParams).c; } catch (_){}
      }
      // [버그 fix] 교사가 개설(소유)한 수업 건수. 이전엔 learning_logs.activity_type='lesson_view'
      //   AND user_id=tid 를 셌으나, 교사는 자기 수업을 lesson_view 로그로 남기지 않아 항상 0 이었다.
      //   → lessons.teacher_id 소유 기준(기간은 lessons.created_at)으로 교체. (기획서 §3-1)
      let lessonsHeld = 0;
      try {
        lessonsHeld = db.prepare(`SELECT COUNT(*) c FROM lessons WHERE teacher_id = ? ${periodWhere}`).get(tid, ...periodParams).c;
      } catch (_){}
      let examsOpened = 0;
      if (hasExams) {
        try { examsOpened = db.prepare(`SELECT COUNT(*) c FROM exams WHERE owner_id = ? ${periodWhere}`).get(tid, ...periodParams).c; } catch (_){}
      }
      let feedbackCount = 0;
      if (hasHomeworkFeedback) {
        try { feedbackCount = db.prepare(`SELECT COUNT(*) c FROM homework_feedback WHERE author_id = ? ${periodWhere}`).get(tid, ...periodParams).c; } catch (_){}
      }
      // 가중합 지수: c*2 + l + e*2 + f, 최대값으로 정규화 (100점 만점)
      const raw = contentsAuthored*2 + lessonsHeld + examsOpened*2 + feedbackCount;
      return {
        user_id: u.id, name: u.name || ('#'+u.id),
        class_count: classCount,       // 누적(기간 불변)
        contents_authored: contentsAuthored,  // 기간 내 신규
        lessons_held: lessonsHeld,             // 기간 내
        exams_opened: examsOpened,             // 기간 내 신규
        feedback_count: feedbackCount,         // 기간 내
        _raw: raw,
        utilization_score: 0
      };
    });

    // 정규화
    const maxRaw = teachers.reduce((m,t)=> t._raw>m?t._raw:m, 0);
    teachers.forEach(t => {
      t.utilization_score = maxRaw>0 ? Math.round((t._raw/maxRaw)*100) : 0;
      delete t._raw;
    });
    teachers.sort((a,b)=> b.utilization_score - a.utilization_score);

    let myIndex = null;
    if (role === 'teacher') {
      myIndex = teachers.find(t => t.user_id === req.user.id) || null;
      if (!myIndex) {
        // 본인 데이터 개별 계산
        const u = db.prepare('SELECT id, COALESCE(display_name, username) name FROM users WHERE id = ?').get(req.user.id);
        myIndex = { user_id: req.user.id, name: u ? u.name : '나', class_count: 0,
          contents_authored: 0, lessons_held: 0, exams_opened: 0, feedback_count: 0, utilization_score: 0 };
      }
    }

    // ── 교사 스코프 신규 필드: prev(직전기간 델타) · trend(버킷 추이) · recent(최근활동) ──
    //    관리자 scope='all' 경로에는 붙이지 않는다(교사 본인 뷰 전용).
    let prev = null, trend = null, recent = null;
    if (scope !== 'all' && teacherIds.length === 1) {
      const tid = teacherIds[0];
      const fromIso = r.fromDate, toIso = r.toDate;
      // (a) prev — 현재 기간과 동일 폭의 직전 구간 [from-span, from-1].
      //     기간칩이 없어(무제한) fromIso 가 null 이면 prev 는 의미 없음 → null 유지.
      if (fromIso && toIso) {
        const dFrom = new Date(fromIso + 'T00:00:00Z');
        const dTo = new Date(toIso + 'T00:00:00Z');
        const spanDays = Math.max(1, Math.round((dTo - dFrom) / 86400000) + 1);
        const prevTo = new Date(dFrom); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
        const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (spanDays - 1));
        const iso = (d) => d.toISOString().slice(0, 10);
        prev = _teacherMetricsInRange(tid, iso(prevFrom), iso(prevTo));
      } else {
        // 무제한(기간칩 없음)이면 '직전 동일기간' 개념이 없음 → 0 채움(FE 는 flat 화살표).
        prev = { contents_authored: 0, lessons_held: 0, exams_opened: 0, feedback_count: 0 };
      }
      // (b) trend — 기간을 버킷으로 쪼개 버킷별 4지표. 무제한(기간칩 없음)이면 빈 배열.
      if (fromIso && toIso) {
        trend = _makeBuckets(fromIso, toIso).map(b => {
          const m = _teacherMetricsInRange(tid, b.from, b.to);
          return {
            label: b.label, from: b.from, to: b.to,
            contents: m.contents_authored, lessons: m.lessons_held,
            exams: m.exams_opened, feedback: m.feedback_count
          };
        });
      } else {
        trend = [];
      }
      // (c) recent — 4소스 UNION, 기간 필터, 최근 10건.
      recent = _teacherRecentActivity(tid, fromIso, toIso, 10);
    }

    res.json({
      success: true,
      scope,
      // 어떤 지표가 기간에 반응하고 어떤 게 누적인지 FE 가 라벨링할 수 있게 명시.
      period: { fromDate: r.fromDate, toDate: r.toDate },
      metricScopes: {
        contents_authored: 'period', lessons_held: 'period',
        exams_opened: 'period', feedback_count: 'period',
        class_count: 'cumulative'   // 누적 — 기간 무관
      },
      teachers,
      myIndex,
      // 교사 스코프 신규 계약(FE t-teacher-idx 소비). 관리자 scope='all' 시 null.
      prev,     // { contents_authored, lessons_held, exams_opened, feedback_count } — KPI 델타 화살표용
      trend,    // [ { label, from, to, contents, lessons, exams, feedback } ] — 라인차트용
      recent    // [ { type, title, class_name, date } ] created_at desc 최대 10건 — 최근활동 표
    });
  } catch (err) {
    console.error('[LRS] /stats/teacher-index error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// (4) GET /api/lrs/stats/daily-snapshot
router.get('/stats/daily-snapshot', requireAuth, (req, res) => {
  try {
    const sf = resolveScopeFilter(req, 'll');

    // 기간 반영(감사 §3 s-daily, P0): 이전엔 DATE('now')/DATE('now','-1 day') 하드코딩이라
    //   기간칩 7d/30d/90d 응답이 완전 동일했다. 이제 선택 기간 범위(from~to)로 요약하고,
    //   직전 동일 길이 구간과 비교한다. 기간칩이 없으면 오늘/어제(기존 동작) 유지.
    // 날짜 범위(from~to, 포함) 스냅샷.
    function snapshotRange(fromIso, toIso) {
      const where = `WHERE DATE(ll.created_at) >= ? AND DATE(ll.created_at) <= ? ${sf.where}`;
      const params = [fromIso, toIso, ...sf.params];
      const sumRow = db.prepare(`
        SELECT COUNT(*) total_acts,
               COUNT(DISTINCT ll.user_id) uniq_users,
               COALESCE(SUM(COALESCE(ll.duration_sec, CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) dur_sec
        FROM learning_logs ll ${where}
      `).get(...params);
      const byServiceRows = db.prepare(`
        SELECT ll.source_service, COUNT(*) cnt
        FROM learning_logs ll ${where}
        GROUP BY ll.source_service
        ORDER BY cnt DESC
      `).all(...params);
      const byHourRows = db.prepare(`
        SELECT CAST(strftime('%H', ll.created_at, 'localtime') AS INTEGER) hour, COUNT(*) cnt
        FROM learning_logs ll ${where}
        GROUP BY hour
      `).all(...params);
      const hourMap = new Map(byHourRows.map(r => [r.hour, r.cnt]));
      const byHour = [];
      for (let h=0; h<24; h++) byHour.push({ hour: h, count: hourMap.get(h) || 0 });
      return {
        from: fromIso, to: toIso, date: toIso,
        totalActs: sumRow.total_acts || 0,
        uniqueUsers: sumRow.uniq_users || 0,
        durationMin: Math.round((sumRow.dur_sec||0)/60),
        byService: byServiceRows.map(row => ({
          source_service: row.source_service,
          count: row.cnt,
          label: serviceLabel(row.source_service)
        })),
        byHour
      };
    }
    const snapshot = (dateIso) => snapshotRange(dateIso, dateIso); // 단일 날짜 편의

    const hasPeriodParam = !!(req.query.period || req.query.days || req.query.from || req.query.to);
    let current, previous, periodMeta;
    if (hasPeriodParam) {
      const period = resolvePeriod(req);
      if (period.invalid) return sendInvalidPeriod(res, period.reason);
      const from = period.fromDate, to = period.toDate;
      const spanDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
      // 직전 동일 길이 구간: [from - spanDays, from - 1]
      const prevTo = new Date(from); prevTo.setDate(prevTo.getDate() - 1);
      const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
      const iso = (d) => d.toISOString().slice(0, 10);
      current = snapshotRange(from, to);
      previous = snapshotRange(iso(prevFrom), iso(prevTo));
      periodMeta = { fromDate: from, toDate: to, label: period.label, spanDays };
    } else {
      // 기간칩 없음 → 오늘/어제(기존 동작).
      const nowRow = db.prepare("SELECT DATE('now','localtime') today, DATE('now','-1 day','localtime') yesterday").get();
      current = snapshot(nowRow.today);
      previous = snapshot(nowRow.yesterday);
      periodMeta = { fromDate: nowRow.today, toDate: nowRow.today, label: 'today', spanDays: 1 };
    }
    const delta = {
      totalActs: current.totalActs - previous.totalActs,
      uniqueUsers: current.uniqueUsers - previous.uniqueUsers,
      durationMin: current.durationMin - previous.durationMin
    };

    // 하위호환: today/yesterday 키 유지(FE 가 아직 참조). current/previous 는 기간 인지 신규 키.
    res.json({
      success:true, scope: sf.scope,
      periodAware: hasPeriodParam, period: periodMeta,
      today: current, yesterday: previous,
      current, previous, delta
    });
  } catch (err) {
    console.error('[LRS] /stats/daily-snapshot error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

/* =====================================================================
 * Admin aggregate endpoints (C안 IA Phase 2)
 * - 개인 식별 금지, 집계/분포만 반환
 * - 데이터 부족 시 빈 배열/0 반환 (UI 측 n<10 guard가 마스킹)
 * ===================================================================== */

function _adminOnly(req, res){
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ success:false, message:'관리자 권한이 필요합니다.' });
    return false;
  }
  return true;
}

// (A) GET /api/lrs/stats/teacher-index-dist — 교사 실행지수 분포
router.get('/stats/teacher-index-dist', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const level = String(req.query.level || '').trim();
    const region = String(req.query.region || '').trim();

    let where = "role='teacher'";
    const params = [];
    if (region) { where += ' AND school_name LIKE ?'; params.push('%'+region+'%'); }
    // level 필터: school_name suffix 기반 휴리스틱 (초/중/고)
    if (level === '초등') { where += " AND school_name LIKE '%초등%'"; }
    else if (level === '중학') { where += " AND school_name LIKE '%중학%'"; }
    else if (level === '고등') { where += " AND school_name LIKE '%고등%'"; }

    const teacherIds = db.prepare(`SELECT id, school_name FROM users WHERE ${where}`).all(...params);
    const hasContents = _tableExists('contents');
    const hasExams = _tableExists('exams');
    const hasHomeworkFeedback = _tableExists('homework_feedback');

    const scores = [];
    const byLevel = {};
    teacherIds.forEach(u => {
      let raw = 0;
      try { raw += (db.prepare('SELECT COUNT(*) c FROM classes WHERE owner_id=?').get(u.id).c||0)*1; } catch(_){}
      if (hasContents) { try { raw += (db.prepare('SELECT COUNT(*) c FROM contents WHERE creator_id=?').get(u.id).c||0)*2; } catch(_){} }
      try { raw += (db.prepare(`SELECT COUNT(*) c FROM learning_logs WHERE user_id=? ${r.where}`).get(u.id, ...r.params).c||0); } catch(_){}
      if (hasExams) { try { raw += (db.prepare('SELECT COUNT(*) c FROM exams WHERE owner_id=?').get(u.id).c||0)*2; } catch(_){} }
      if (hasHomeworkFeedback) { try { raw += (db.prepare('SELECT COUNT(*) c FROM homework_feedback WHERE author_id=?').get(u.id).c||0); } catch(_){} }
      const score = Math.min(100, raw);
      scores.push(score);
      const sn = u.school_name || '';
      const lv = sn.includes('초등') ? '초등' : sn.includes('중학') ? '중학' : sn.includes('고등') ? '고등' : '미분류';
      (byLevel[lv] = byLevel[lv] || []).push(score);
    });
    Object.values(byLevel).forEach(arr => arr.sort((a,b)=>a-b));
    res.json({ success:true, n: scores.length, scores, byLevel });
  } catch (err) {
    console.error('[LRS] /stats/teacher-index-dist error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// (B) GET /api/lrs/stats/school-warnings — 학교 단위 경고 집계
router.get('/stats/school-warnings', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    // 학교별 학생 집계 + 학습로그 부족(=경고) 산정
    const schools = db.prepare(`
      SELECT school_name,
             COUNT(*) students
      FROM users
      WHERE role='student' AND school_name IS NOT NULL AND school_name <> ''
      GROUP BY school_name
    `).all();

    const rows = schools.map((s,i) => {
      let activeUsers = 0;
      try {
        activeUsers = db.prepare(`
          SELECT COUNT(DISTINCT ll.user_id) c
          FROM learning_logs ll JOIN users u ON u.id=ll.user_id
          WHERE u.school_name=? ${r.where}
        `).get(s.school_name, ...r.params).c || 0;
      } catch(_){}
      const inactive = Math.max(0, s.students - activeUsers);
      const riskRate = s.students>0 ? inactive / s.students : 0;
      return {
        schoolId: 'sch-'+i,
        schoolName: s.school_name,
        level: (s.school_name||'').includes('초등')?'초등':(s.school_name||'').includes('중학')?'중학':(s.school_name||'').includes('고등')?'고등':'미분류',
        region: (s.school_name||'').split(' ')[0] || '미분류',
        students: s.students,
        warnCount: inactive,
        riskRate: Math.round(riskRate*1000)/1000,
        trend: 0
      };
    });
    res.json({ success:true, schools: rows });
  } catch (err) {
    console.error('[LRS] /stats/school-warnings error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// (C) GET /api/lrs/stats/region-drilldown — 지역/학교급/학년 드릴다운
router.get('/stats/region-drilldown', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const level = String(req.query.level || 'region').trim(); // region | eduoffice | school | grade
    const parentId = String(req.query.parent || '').trim();

    let groupCol = null;
    let filterSql = "u.role='student' AND u.school_name IS NOT NULL AND u.school_name <> ''";
    const params = [];
    if (level === 'region') {
      groupCol = "SUBSTR(u.school_name,1,INSTR(u.school_name||' ',' ')-1)";
    } else if (level === 'eduoffice' || level === 'school') {
      groupCol = 'u.school_name';
      if (parentId) { filterSql += ' AND u.school_name LIKE ?'; params.push('%'+parentId+'%'); }
    } else if (level === 'grade') {
      groupCol = 'u.grade';
      if (parentId) { filterSql += ' AND u.school_name = ?'; params.push(parentId); }
    } else {
      return res.json({ success:true, level, children: [] });
    }

    const rows = db.prepare(`
      SELECT ${groupCol} id, COUNT(*) n
      FROM users u
      WHERE ${filterSql}
      GROUP BY ${groupCol}
    `).all(...params);

    const children = rows.map(row => {
      let active = 0;
      try {
        active = db.prepare(`
          SELECT COUNT(DISTINCT ll.user_id) c
          FROM learning_logs ll JOIN users u ON u.id=ll.user_id
          WHERE ${filterSql.replace(/\?/g, '?')} AND ${groupCol}=? ${r.where}
        `).get(...params, row.id, ...r.params).c || 0;
      } catch(_){}
      const inactive = Math.max(0, row.n - active);
      return {
        id: String(row.id||''),
        label: String(row.id||'미분류'),
        level: level==='region'?'eduoffice':level==='eduoffice'?'school':level==='school'?'grade':'grade',
        n: row.n,
        avgScore: 0,
        riskRate: row.n>0 ? Math.round((inactive/row.n)*1000)/1000 : 0
      };
    });
    res.json({ success:true, level, children });
  } catch (err) {
    console.error('[LRS] /stats/region-drilldown error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// (D) GET /api/lrs/stats/period-compare — 기간 비교
router.get('/stats/period-compare', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    // 기준 기간 vs 비교 기간
    const daysParam = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)));
    const level = String(req.query.level || '').trim();
    const region = String(req.query.region || '').trim();

    const today = db.prepare("SELECT DATE('now','localtime') d").get().d;
    const curStart = db.prepare("SELECT DATE(?, ?) d").get(today, `-${daysParam-1} days`).d;
    const prevEnd = db.prepare("SELECT DATE(?, '-1 days') d").get(curStart).d;
    const prevStart = db.prepare("SELECT DATE(?, ?) d").get(prevEnd, `-${daysParam-1} days`).d;

    function buildWhere(start, end){
      let where = "DATE(ll.created_at)>=? AND DATE(ll.created_at)<=? AND u.role='student'";
      const params = [start, end];
      if (region) { where += ' AND u.school_name LIKE ?'; params.push('%'+region+'%'); }
      if (level === '초등') where += " AND u.school_name LIKE '%초등%'";
      else if (level === '중학') where += " AND u.school_name LIKE '%중학%'";
      else if (level === '고등') where += " AND u.school_name LIKE '%고등%'";
      return { where, params };
    }
    function metricsFor(start, end){
      try {
        const w = buildWhere(start, end);
        const rows = db.prepare(`
          SELECT u.school_name label,
                 COUNT(DISTINCT ll.user_id) activeUsers,
                 COUNT(*) acts
          FROM learning_logs ll JOIN users u ON u.id=ll.user_id
          WHERE ${w.where}
          GROUP BY u.school_name
          LIMIT 50
        `).all(...w.params);
        return rows.map(r => ({ label: r.label||'미분류', activeUsers: r.activeUsers||0, acts: r.acts||0 }));
      } catch(_) { return []; }
    }

    const current = metricsFor(curStart, today);
    const previous = metricsFor(prevStart, prevEnd);

    // 두 기간 레이블 합집합으로 페어 구성
    const labels = Array.from(new Set([...current.map(x=>x.label), ...previous.map(x=>x.label)]));
    const byLabel = (arr, l) => arr.find(x=>x.label===l) || { activeUsers:0, acts:0 };
    const pairs = labels.map(l => ({
      label: l,
      current: byLabel(current, l),
      previous: byLabel(previous, l)
    }));

    res.json({
      success:true,
      days: daysParam,
      period: { current: { from:curStart, to:today }, previous: { from:prevStart, to:prevEnd } },
      pairs
    });
  } catch (err) {
    console.error('[LRS] /stats/period-compare error:', err);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// xAPI 표준체계 분석 엔드포인트 (Phase E)
//   Phase B에서 수집한 xapi_statement_spool + lrs_std_node_stats 기반.
//   scope 파라미터: 'me' (학생 본인), 'class:<id>' (교사), 'school' (admin)
// ═══════════════════════════════════════════════════════════════════

/** scope 파라미터 → user_id IN (...) 조건 구성 */
function _xapiScopeUserIds(req, scope) {
  if (scope === 'me' || !scope) return [req.user.id];
  if (scope === 'school' && req.user.role === 'admin') return null; // null = 전체
  if (scope.startsWith('class:')) {
    const classId = parseInt(scope.slice(6));
    if (!classId) return [req.user.id];
    try {
      // 학생 모집단만 (비학생 체험 기록 격리)
      const members = db.prepare(
        "SELECT cm.user_id FROM class_members cm JOIN users u ON u.id = cm.user_id WHERE cm.class_id = ? AND u.role = 'student'"
      ).all(classId).map(r => r.user_id);
      // 교사면 자기 학급 허용, 학생이면 본인만
      const role = classDb.getMemberRole(classId, req.user.id);
      if (role === 'owner' || req.user.role === 'admin') return members;
      return [req.user.id];
    } catch { return [req.user.id]; }
  }
  return [req.user.id];
}

function _xapiUserFilter(userIds) {
  if (userIds === null) return { clause: '', params: [] };
  if (!userIds.length) return { clause: ' AND 1=0', params: [] };
  return { clause: ` AND user_id IN (${userIds.map(() => '?').join(',')})`, params: userIds };
}

// GET /api/lrs/xapi/overview — 수집 현황 (영역별 건수)
router.get('/xapi/overview', requireAuth, (req, res) => {
  try {
    const userIds = _xapiScopeUserIds(req, req.query.scope);
    const f = _xapiUserFilter(userIds);
    const byArea = db.prepare(`
      SELECT area, COUNT(*) as cnt
      FROM xapi_statement_spool
      WHERE 1=1 ${f.clause}
      GROUP BY area
      ORDER BY cnt DESC
    `).all(...f.params);
    const recent24h = db.prepare(`
      SELECT COUNT(*) as cnt FROM xapi_statement_spool
      WHERE event_timestamp >= datetime('now','-1 day') ${f.clause}
    `).get(...f.params).cnt;
    const recent7d = db.prepare(`
      SELECT COUNT(*) as cnt FROM xapi_statement_spool
      WHERE event_timestamp >= datetime('now','-7 day') ${f.clause}
    `).get(...f.params).cnt;
    const total = byArea.reduce((s, r) => s + r.cnt, 0);
    const sent = db.prepare(`
      SELECT COUNT(*) as cnt FROM xapi_statement_spool
      WHERE sent_at IS NOT NULL ${f.clause}
    `).get(...f.params).cnt;
    res.json({
      success: true,
      total, sent, unsent: total - sent,
      recent24h, recent7d,
      byArea,
    });
  } catch (err) {
    console.error('[LRS] /xapi/overview error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/lrs/xapi/std-heatmap — 표준체계 노드별 학습량 히트맵
//   쿼리: scope, subject_code, grade_group, depth (0~3)
router.get('/xapi/std-heatmap', requireAuth, (req, res) => {
  try {
    const userIds = _xapiScopeUserIds(req, req.query.scope);
    const f = _xapiUserFilter(userIds);
    const subject = req.query.subject_code || null;
    const grade = req.query.grade_group ? parseInt(req.query.grade_group) : null;
    const depth = req.query.depth != null ? parseInt(req.query.depth) : null;

    const where = [`s.user_id IS NOT NULL`];
    const params = [];
    if (depth != null) { where.push('s.depth = ?'); params.push(depth); }
    if (subject) { where.push('n.subject_code = ?'); params.push(subject); }
    if (grade != null) { where.push('n.grade_group = ?'); params.push(grade); }
    if (userIds) {
      where.push(`s.user_id IN (${userIds.map(() => '?').join(',')})`);
      params.push(...userIds);
    }
    const rows = db.prepare(`
      SELECT s.node_id,
             COALESCE(n.label, s.node_id) as label,
             n.subject_code, n.grade_group, s.depth,
             SUM(s.attempts) as attempts,
             SUM(s.correct) as correct,
             COUNT(DISTINCT s.user_id) as learners
      FROM lrs_std_node_stats s
      LEFT JOIN curriculum_content_nodes n ON s.node_id = n.id
      WHERE ${where.join(' AND ')}
      GROUP BY s.node_id
      ORDER BY attempts DESC
      LIMIT 200
    `).all(...params);
    res.json({ success: true, nodes: rows });
  } catch (err) {
    console.error('[LRS] /xapi/std-heatmap error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/lrs/xapi/achievement-distribution — 성취수준 분포
router.get('/xapi/achievement-distribution', requireAuth, (req, res) => {
  try {
    const userIds = _xapiScopeUserIds(req, req.query.scope);
    const f = _xapiUserFilter(userIds);
    const subject = req.query.subject_code || null;
    const extra = subject ? ' AND subject_code = ?' : '';
    const params = [...f.params];
    if (subject) params.push(subject);
    const rows = db.prepare(`
      SELECT achievement_level as level, COUNT(*) as cnt
      FROM xapi_statement_spool
      WHERE achievement_level IS NOT NULL ${f.clause} ${extra}
      GROUP BY achievement_level
      ORDER BY level
    `).all(...params);
    // 영역(과목)별 분포도 함께
    const bySubject = db.prepare(`
      SELECT subject_code, achievement_level as level, COUNT(*) as cnt
      FROM xapi_statement_spool
      WHERE achievement_level IS NOT NULL AND subject_code IS NOT NULL ${f.clause}
      GROUP BY subject_code, achievement_level
      ORDER BY subject_code, level
    `).all(...f.params);
    res.json({ success: true, distribution: rows, bySubject });
  } catch (err) {
    console.error('[LRS] /xapi/achievement-distribution error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/lrs/xapi/area-breakdown — 영역별 일별 추이
router.get('/xapi/area-breakdown', requireAuth, (req, res) => {
  try {
    const userIds = _xapiScopeUserIds(req, req.query.scope);
    const f = _xapiUserFilter(userIds);
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const rows = db.prepare(`
      SELECT date(event_timestamp) as d, area, COUNT(*) as cnt
      FROM xapi_statement_spool
      WHERE event_timestamp >= datetime('now', ?) ${f.clause}
      GROUP BY d, area
      ORDER BY d ASC, area
    `).all(`-${days} day`, ...f.params);
    res.json({ success: true, days, rows });
  } catch (err) {
    console.error('[LRS] /xapi/area-breakdown error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/lrs/xapi/recent-events — 최근 이벤트 (live feed)
router.get('/xapi/recent-events', requireAuth, (req, res) => {
  try {
    const userIds = _xapiScopeUserIds(req, req.query.scope);
    const f = _xapiUserFilter(userIds);
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);
    const rows = db.prepare(`
      SELECT s.id, s.area, s.verb, s.primary_std_id, s.subject_code,
             s.object_type, s.object_id, s.success, s.achievement_level,
             s.event_timestamp, s.user_id, u.display_name
      FROM xapi_statement_spool s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE 1=1 ${f.clause}
      ORDER BY s.event_timestamp DESC
      LIMIT ?
    `).all(...f.params, limit);
    res.json({ success: true, events: rows });
  } catch (err) {
    console.error('[LRS] /xapi/recent-events error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// LRS 관리자 거시분석 — S2/S3 집계 API (기획서 LRS_관리자_거시분석_기획서.md)
//   admin 전용. 개인 식별정보·정답 비노출. is_seed 포함이 기본,
//   ?realOnly=1 토글 시 실데이터(is_seed=0)만 집계.
//   학교급 정규화 값: elementary/middle/high.
// ═══════════════════════════════════════════════════════════════════

const _LEVEL_LABELS = { elementary: '초등학교', middle: '중학교', high: '고등학교' };
function levelLabel(code) { return _LEVEL_LABELS[code] || (code || '미분류'); }

/** ?realOnly=1 이면 is_seed=0 만. 기본(미전달/0)은 전체(시드+실). */
function seedFilter(req, alias) {
  const p = alias ? `${alias}.` : '';
  const realOnly = String(req.query.realOnly || '') === '1';
  return { where: realOnly ? ` AND ${p}is_seed = 0` : '', realOnly };
}

/** period=7d|30d|90d (기본 30) → 일수 정수 반환. 거시 KPI 전용 단순 파서. */
function macroDays(req, def = 30) {
  const raw = String(req.query.period || `${def}d`).replace('d', '');
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return def;
  return Math.min(n, 365);
}

/** 정수 배열에서 percentile 경계값(선형보간) 산출. p: 0~1. */
function _pctile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// ─────────────────────────────────────────────────────────
// S2-① GET /api/lrs/stats/admin-kpi — 한눈 현황 KPI 8종
//   params: period=7d|30d|90d (DAU/WAU/오늘활동은 절대 기준일), realOnly
// ─────────────────────────────────────────────────────────
router.get('/stats/admin-kpi', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const days = macroDays(req, 30);
    const sfU = seedFilter(req, 'u');
    const sfL = seedFilter(req, 'll');

    // 가입자 (학생 한정 학교 수 — 거시 단위 기준)
    const schoolCnt = db.prepare(`
      SELECT COUNT(DISTINCT school_name) c FROM users u
      WHERE role='student' AND school_name IS NOT NULL AND school_name <> '' ${sfU.where}
    `).get().c || 0;
    const teacherCnt = db.prepare(`SELECT COUNT(*) c FROM users u WHERE role='teacher' ${sfU.where}`).get().c || 0;
    const studentCnt = db.prepare(`SELECT COUNT(*) c FROM users u WHERE role='student' ${sfU.where}`).get().c || 0;

    // 누적 총 학습시간(시간) — duration_sec 우선, 없으면 PTxxxS 파싱
    const totalSec = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(ll.duration_sec,
        CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) s
      FROM learning_logs ll WHERE 1=1 ${sfL.where}
    `).get().s || 0;
    const totalLearnHours = Math.round(totalSec / 3600);

    // 오늘 활동량 / DAU
    const todayRow = db.prepare(`
      SELECT COUNT(*) acts, COUNT(DISTINCT ll.user_id) dau
      FROM learning_logs ll
      WHERE DATE(ll.created_at) = DATE('now','localtime') ${sfL.where}
    `).get();
    const todayActs = todayRow.acts || 0;
    const dau = todayRow.dau || 0;

    // WAU (최근 7일 고유 사용자)
    const wau = db.prepare(`
      SELECT COUNT(DISTINCT ll.user_id) c
      FROM learning_logs ll
      WHERE DATE(ll.created_at) >= DATE('now','localtime','-6 days') ${sfL.where}
    `).get().c || 0;

    // 활성률 = WAU / 가입 학생 수
    const activeRate = studentCnt > 0 ? Math.round((wau / studentCnt) * 1000) / 10 : 0;

    // period 기간 활동량 (참고 KPI)
    const periodActs = db.prepare(`
      SELECT COUNT(*) c FROM learning_logs ll
      WHERE DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where}
    `).get(`-${days - 1} days`).c || 0;

    // 학교급 미니카드 (학생 수 + 활동량)
    const byLevelRows = db.prepare(`
      SELECT u.school_level lvl, COUNT(*) students
      FROM users u
      WHERE u.role='student' AND u.school_level IS NOT NULL ${sfU.where}
      GROUP BY u.school_level
    `).all();
    const actByLevel = db.prepare(`
      SELECT u.school_level lvl, COUNT(*) acts
      FROM learning_logs ll JOIN users u ON u.id = ll.user_id
      WHERE u.role='student' AND u.school_level IS NOT NULL
        AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where}
      GROUP BY u.school_level
    `).all(`-${days - 1} days`);
    const actMap = new Map(actByLevel.map(r => [r.lvl, r.acts]));
    const byLevel = ['elementary', 'middle', 'high'].map(lv => {
      const row = byLevelRows.find(r => r.lvl === lv) || { students: 0 };
      return { level: lv, label: levelLabel(lv), students: row.students || 0, acts: actMap.get(lv) || 0 };
    });

    // 주간 활동 추이 (최근 8주, ISO 주 시작 월요일 근사 — 7일 버킷)
    const weekly = db.prepare(`
      SELECT CAST((JULIANDAY('now','localtime') - JULIANDAY(ll.created_at)) / 7 AS INTEGER) wk,
             COUNT(*) cnt
      FROM learning_logs ll
      WHERE DATE(ll.created_at) >= DATE('now','localtime','-55 days') ${sfL.where}
      GROUP BY wk ORDER BY wk DESC
    `).all();
    const wkMap = new Map(weekly.map(r => [r.wk, r.cnt]));
    const weeklyTrend = [];
    for (let w = 7; w >= 0; w--) weeklyTrend.push({ weeksAgo: w, count: wkMap.get(w) || 0 });

    res.json({
      success: true,
      period: `${days}d`,
      realOnly: sfL.realOnly,
      kpi: {
        schools: schoolCnt,
        teachers: teacherCnt,
        students: studentCnt,
        dau,
        wau,
        totalLearnHours,
        todayActs,
        activeRate, // %
        periodActs
      },
      byLevel,
      weeklyTrend
    });
  } catch (err) {
    console.error('[LRS] /stats/admin-kpi error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// S2-② GET /api/lrs/stats/service-ops — 서비스 운영 진단
//   서비스별 사용률·비중·추세Δ(직전 동기간 대비)·고유사용자·재방문율 + 미사용 진단
//   params: period=30d(기본·추세 비교 기간), realOnly
// ─────────────────────────────────────────────────────────
router.get('/stats/service-ops', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const days = macroDays(req, 30);
    const sf = seedFilter(req, 'll');
    const curFrom = `-${days - 1} days`;
    const prevFrom = `-${2 * days - 1} days`;
    const prevTo = `-${days} days`;

    // 현재 기간 서비스별 집계
    const cur = db.prepare(`
      SELECT ll.source_service svc,
             COUNT(*) cnt,
             COUNT(DISTINCT ll.user_id) uniq_users,
             COALESCE(SUM(COALESCE(ll.duration_sec,
               CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) dur_sec
      FROM learning_logs ll
      WHERE ll.source_service IS NOT NULL AND ll.source_service NOT LIKE 'demo%'
        AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sf.where}
      GROUP BY ll.source_service
    `).all(curFrom);

    // 직전 동기간 건수 (추세 비교)
    const prev = db.prepare(`
      SELECT ll.source_service svc, COUNT(*) cnt
      FROM learning_logs ll
      WHERE ll.source_service IS NOT NULL AND ll.source_service NOT LIKE 'demo%'
        AND DATE(ll.created_at) >= DATE('now','localtime', ?)
        AND DATE(ll.created_at) <= DATE('now','localtime', ?) ${sf.where}
      GROUP BY ll.source_service
    `).all(prevFrom, prevTo);
    const prevMap = new Map(prev.map(r => [r.svc, r.cnt]));

    // 현재 기간 재방문(2일 이상 활동) 고유 사용자 — 서비스별
    const revisit = db.prepare(`
      SELECT svc, COUNT(*) revisit_users FROM (
        SELECT ll.source_service svc, ll.user_id
        FROM learning_logs ll
        WHERE ll.source_service IS NOT NULL AND ll.source_service NOT LIKE 'demo%'
          AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sf.where}
        GROUP BY ll.source_service, ll.user_id
        HAVING COUNT(DISTINCT DATE(ll.created_at)) >= 2
      ) GROUP BY svc
    `).all(curFrom);
    const revisitMap = new Map(revisit.map(r => [r.svc, r.revisit_users]));

    const totalCnt = cur.reduce((s, r) => s + r.cnt, 0) || 1;

    let services = cur.map(r => {
      const share = Math.round((r.cnt / totalCnt) * 1000) / 10; // %
      const prevCnt = prevMap.get(r.svc) || 0;
      const trendDelta = prevCnt > 0
        ? Math.round(((r.cnt - prevCnt) / prevCnt) * 1000) / 10
        : (r.cnt > 0 ? 100 : 0); // 직전 0이면 신규 → +100% 표기
      const revisitUsers = revisitMap.get(r.svc) || 0;
      const revisitRate = r.uniq_users > 0
        ? Math.round((revisitUsers / r.uniq_users) * 1000) / 10 : 0;
      const avgMinPerUser = r.uniq_users > 0
        ? Math.round((r.dur_sec / r.uniq_users) / 60 * 10) / 10 : 0;

      // 룰베이스 진단 상태 (기획서 4-1). 원자료로 status/severity/reason 제공.
      let status = '정상', severity = 'ok';
      if (share < 2) { status = '거의 미사용'; severity = 'critical'; }
      else if (share < 5 && trendDelta <= 0) { status = '저활용·정체'; severity = 'warn'; }
      else if (share < 5 && trendDelta > 0) { status = '저활용·성장중'; severity = 'caution'; }
      else if (trendDelta < -20) { status = '사용 급감'; severity = 'warn'; }

      return {
        service: r.svc,
        service_label: serviceLabel(r.svc),
        count: r.cnt,
        share,
        prevCount: prevCnt,
        trendDelta, // %
        uniqueUsers: r.uniq_users,
        revisitUsers,
        revisitRate, // %
        avgMinPerUser,
        status,
        severity,
        underused: severity !== 'ok' && severity !== 'caution' ? true
                   : (severity === 'caution') // 저활용군 전체를 진단 목록 후보로
      };
    });
    services.sort((a, b) => b.count - a.count);

    // 미사용 진단 목록 (저활용·성장중 포함 — 점유율 임계 미달군)
    const underusedList = services.filter(s => s.severity !== 'ok');

    res.json({
      success: true,
      period: `${days}d`,
      realOnly: sf.realOnly,
      totalCount: totalCnt,
      operatingServices: services.length,
      topService: services[0] ? services[0].service : null,
      bottomService: services.length ? services[services.length - 1].service : null,
      underusedCount: underusedList.length,
      services,
      underused: underusedList
    });
  } catch (err) {
    console.error('[LRS] /stats/service-ops error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// S3-③ GET /api/lrs/stats/macro-drill — 거시 드릴다운(통합)
//   level=region|school_level|school|grade|subject
//   상위 필터: region, school_level, school, grade (체인)
//   각 단위: 학생수·활동량·평균학습시간(분)·평균성취. n<10 마스킹 게이트.
//   params: period, realOnly
// ─────────────────────────────────────────────────────────
router.get('/stats/macro-drill', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const days = macroDays(req, 90);
    const level = String(req.query.level || 'region').trim();
    const sfU = seedFilter(req, 'u');
    const sfL = seedFilter(req, 'll');

    // 상위 필터 (체인)
    const region = req.query.region ? String(req.query.region).trim() : null;
    const schoolLevel = req.query.school_level ? String(req.query.school_level).trim() : null;
    const school = req.query.school ? String(req.query.school).trim() : null;
    const grade = req.query.grade != null && req.query.grade !== '' ? parseInt(req.query.grade, 10) : null;

    const GROUP = {
      region: { col: 'u.region', next: 'school_level' },
      school_level: { col: 'u.school_level', next: 'school' },
      school: { col: 'u.school_name', next: 'grade' },
      grade: { col: 'u.grade', next: 'subject' },
      subject: { col: 'll.subject_code', next: null }
    };
    if (!GROUP[level]) {
      return res.status(400).json({ success: false, message: '잘못된 level 파라미터입니다.' });
    }
    const gcol = GROUP[level].col;

    // 공통 학생 필터 (subject 제외 — subject는 로그 기준 집계)
    const studWhere = [];
    const studParams = [];
    studWhere.push("u.role='student'");
    if (region) { studWhere.push('u.region = ?'); studParams.push(region); }
    if (schoolLevel) { studWhere.push('u.school_level = ?'); studParams.push(schoolLevel); }
    if (school) { studWhere.push('u.school_name = ?'); studParams.push(school); }
    if (grade != null && !isNaN(grade)) { studWhere.push('u.grade = ?'); studParams.push(grade); }
    if (sfU.where) studWhere.push(sfU.where.replace(/^ AND /, ''));
    const studWhereSql = studWhere.join(' AND ');
    const dateFrom = `-${days - 1} days`;

    let rows;
    if (level === 'subject') {
      // 교과 단위: 로그 기준(subject_code) 집계. 분모 학생수는 해당 상위 필터 학생 집합.
      rows = db.prepare(`
        SELECT ll.subject_code id,
               COUNT(*) acts,
               COUNT(DISTINCT ll.user_id) students,
               COALESCE(SUM(COALESCE(ll.duration_sec,
                 CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER),0)),0) dur_sec,
               AVG(CASE WHEN ${scoredWhere('ll')} THEN ${normScoreExpr('ll')} END) avg_score
        FROM learning_logs ll JOIN users u ON u.id = ll.user_id
        WHERE ${studWhereSql} AND ll.subject_code IS NOT NULL
          AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where}
        GROUP BY ll.subject_code
        ORDER BY acts DESC
      `).all(...studParams, dateFrom);
    } else {
      // 단위(지역/학교급/학교/학년): 학생 집합 분리 집계 후 로그 LEFT 매칭
      const studAgg = db.prepare(`
        SELECT ${gcol} id, COUNT(*) students
        FROM users u
        WHERE ${studWhereSql} AND ${gcol} IS NOT NULL AND ${gcol} <> ''
        GROUP BY ${gcol}
      `).all(...studParams);
      const logAgg = db.prepare(`
        SELECT ${gcol} id,
               COUNT(*) acts,
               COALESCE(SUM(COALESCE(ll.duration_sec,
                 CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER),0)),0) dur_sec,
               AVG(CASE WHEN ${scoredWhere('ll')} THEN ${normScoreExpr('ll')} END) avg_score
        FROM learning_logs ll JOIN users u ON u.id = ll.user_id
        WHERE ${studWhereSql} AND ${gcol} IS NOT NULL AND ${gcol} <> ''
          AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where}
        GROUP BY ${gcol}
      `).all(...studParams, dateFrom);
      const logMap = new Map(logAgg.map(r => [String(r.id), r]));
      rows = studAgg.map(s => {
        const l = logMap.get(String(s.id)) || { acts: 0, dur_sec: 0, avg_score: null };
        return { id: s.id, students: s.students, acts: l.acts, dur_sec: l.dur_sec, avg_score: l.avg_score };
      });
    }

    const MIN_N = 10; // 개인정보 보호 게이트
    const children = rows.map(r => {
      const students = r.students || 0;
      const masked = students < MIN_N;
      const labelFn = level === 'school_level' ? levelLabel
        : level === 'subject' ? (c) => subjectLabel(c)
        : level === 'grade' ? (c) => `${c}학년`
        : (c) => String(c);
      return {
        id: String(r.id == null ? '' : r.id),
        label: labelFn(r.id),
        level,
        nextLevel: GROUP[level].next,
        students,
        masked,
        acts: masked ? null : (r.acts || 0),
        avgActsPerStudent: masked ? null : (students > 0 ? Math.round((r.acts / students) * 10) / 10 : 0),
        avgLearnMin: masked ? null : (students > 0 ? Math.round((r.dur_sec / students) / 60) : 0),
        avgScore: masked || r.avg_score == null ? null : Math.round(r.avg_score * 10) / 10
      };
    });
    // 활동량 내림차순 정렬(마스킹은 뒤로)
    children.sort((a, b) => {
      if (a.masked !== b.masked) return a.masked ? 1 : -1;
      return (b.acts || 0) - (a.acts || 0);
    });

    res.json({
      success: true,
      level,
      nextLevel: GROUP[level].next,
      period: `${days}d`,
      realOnly: sfL.realOnly,
      filters: { region, school_level: schoolLevel, school, grade },
      minSample: MIN_N,
      children
    });
  } catch (err) {
    console.error('[LRS] /stats/macro-drill error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// S3-④ GET /api/lrs/stats/cross-activity-achievement — 활동×성취 교차
//   활동량 3분위(상/중/하) × 평균성취 매트릭스 + 익명 산점 + 콘텐츠/스스로채움 상하위 집단 비교
//   params: period, realOnly
// ─────────────────────────────────────────────────────────
router.get('/stats/cross-activity-achievement', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const days = macroDays(req, 90);
    const sfL = seedFilter(req, 'll');
    const sfU = seedFilter(req, 'u');
    const dateFrom = `-${days - 1} days`;

    // 학생 단위: 총 활동량, 평균성취, 콘텐츠/자기주도 활용 빈도.
    //   avg_score(산점도 Y축=성취): 채점형만·0~100 정규화(진도형 제외). 미정규화면 0~1 점이 Y축에 혼입돼
    //   산점도 하단에 0.x 점이 찍힌다(P0 정규화 일괄 적용).
    const perUser = db.prepare(`
      SELECT u.id uid,
             COUNT(*) acts,
             AVG(CASE WHEN ${scoredWhere('ll')} THEN ${normScoreExpr('ll')} END) avg_score,
             SUM(CASE WHEN ll.source_service='content' THEN 1 ELSE 0 END) content_acts,
             SUM(CASE WHEN ll.source_service='self-learn' THEN 1 ELSE 0 END) self_acts,
             SUM(CASE WHEN ${scoredWhere('ll')} AND ll.result_score IS NOT NULL THEN 1 ELSE 0 END) scored_cnt
      FROM users u JOIN learning_logs ll ON ll.user_id = u.id
      WHERE u.role='student'
        AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where} ${sfU.where}
      GROUP BY u.id
    `).all(dateFrom);

    const n = perUser.length;
    // 활동량 3분위 경계 (33/66 percentile)
    const actsSorted = perUser.map(r => r.acts).sort((a, b) => a - b);
    const b33 = _pctile(actsSorted, 1 / 3);
    const b66 = _pctile(actsSorted, 2 / 3);
    const tierOf = (a) => (a <= b33 ? '하' : a <= b66 ? '중' : '상');

    // 산점 데이터 (익명 좌표: 활동량 × 평균성취) — 식별정보 제외
    const scatter = perUser
      .filter(r => r.avg_score != null)
      .map(r => ({ x: r.acts, y: Math.round(r.avg_score * 10) / 10, tier: tierOf(r.acts) }));

    // 활동량 구간별 성취 매트릭스
    const tierAgg = { 상: [], 중: [], 하: [] };
    perUser.forEach(r => { if (r.avg_score != null) tierAgg[tierOf(r.acts)].push(r.avg_score); });
    const matrix = ['상', '중', '하'].map(t => {
      const arr = tierAgg[t];
      const avg = arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
      return { tier: t, n: arr.length, avgScore: avg == null ? null : Math.round(avg * 10) / 10 };
    });

    // 상/하위 집단 성취 비교 (활용 빈도 33/66 percentile 기준 상위33% vs 하위33%)
    function groupCompare(key) {
      const valsSorted = perUser.map(r => r[key]).sort((a, b) => a - b);
      const lo = _pctile(valsSorted, 1 / 3);
      const hi = _pctile(valsSorted, 2 / 3);
      const hiArr = [], loArr = [];
      perUser.forEach(r => {
        if (r.avg_score == null) return;
        if (r[key] >= hi) hiArr.push(r.avg_score);
        else if (r[key] <= lo) loArr.push(r.avg_score);
      });
      const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
      const sHi = mean(hiArr), sLo = mean(loArr);
      const gap = (sHi != null && sLo != null) ? Math.round((sHi - sLo) * 10) / 10 : null;
      return {
        high: { n: hiArr.length, avgScore: sHi == null ? null : Math.round(sHi * 10) / 10 },
        low: { n: loArr.length, avgScore: sLo == null ? null : Math.round(sLo * 10) / 10 },
        gapPP: gap // %p
      };
    }

    res.json({
      success: true,
      period: `${days}d`,
      realOnly: sfL.realOnly,
      sampleN: n,
      smallSample: n < 30, // 표본 부족 단서
      tertileBounds: { p33: Math.round(b33 * 10) / 10, p66: Math.round(b66 * 10) / 10 },
      matrix,
      scatter,
      contentCompare: groupCompare('content_acts'),
      selfLearnCompare: groupCompare('self_acts')
    });
  } catch (err) {
    console.error('[LRS] /stats/cross-activity-achievement error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// S3-⑤ GET /api/lrs/stats/time-by-unit — 학습시간 분석
//   unit=school_level|grade|region (단위별 1인당 평균 학습시간) + 요일×시간 히트맵
//   params: period, realOnly
// ─────────────────────────────────────────────────────────
router.get('/stats/time-by-unit', requireAuth, (req, res) => {
  try {
    if (!_adminOnly(req, res)) return;
    const days = macroDays(req, 90);
    const unit = String(req.query.unit || 'school_level').trim();
    const sfL = seedFilter(req, 'll');
    const sfU = seedFilter(req, 'u');
    const dateFrom = `-${days - 1} days`;

    const UNIT = {
      school_level: { col: 'u.school_level', label: levelLabel },
      grade: { col: 'u.grade', label: (c) => `${c}학년` },
      region: { col: 'u.region', label: (c) => String(c) }
    };
    if (!UNIT[unit]) return res.status(400).json({ success: false, message: '잘못된 unit 파라미터입니다.' });
    const ucol = UNIT[unit].col;

    // 단위별 1인당 평균 학습시간(분) = 총 duration / 활동 학생 수
    const rows = db.prepare(`
      SELECT ${ucol} id,
             COUNT(DISTINCT ll.user_id) students,
             COALESCE(SUM(COALESCE(ll.duration_sec,
               CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER),0)),0) dur_sec
      FROM learning_logs ll JOIN users u ON u.id = ll.user_id
      WHERE u.role='student' AND ${ucol} IS NOT NULL AND ${ucol} <> ''
        AND DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where} ${sfU.where}
      GROUP BY ${ucol}
    `).all(dateFrom);
    const byUnit = rows.map(r => ({
      id: String(r.id),
      label: UNIT[unit].label(r.id),
      students: r.students || 0,
      avgLearnMin: r.students > 0 ? Math.round((r.dur_sec / r.students) / 60 * 10) / 10 : 0,
      totalLearnHours: Math.round(r.dur_sec / 3600 * 10) / 10
    })).sort((a, b) => b.avgLearnMin - a.avgLearnMin);

    // 요일×시간 히트맵 (dow 0=일~6=토, hour 0~23) — 활동 건수 기준
    const hm = db.prepare(`
      SELECT CAST(strftime('%w', ll.created_at, 'localtime') AS INTEGER) dow,
             CAST(strftime('%H', ll.created_at, 'localtime') AS INTEGER) hour,
             COUNT(*) cnt
      FROM learning_logs ll
      WHERE DATE(ll.created_at) >= DATE('now','localtime', ?) ${sfL.where}
      GROUP BY dow, hour
    `).all(dateFrom);
    // 7x24 매트릭스 + 피크 산출
    const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let peak = { dow: 0, hour: 0, count: -1 };
    hm.forEach(r => {
      if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) {
        heatmap[r.dow][r.hour] = r.cnt;
        if (r.cnt > peak.count) peak = { dow: r.dow, hour: r.hour, count: r.cnt };
      }
    });
    // 평일/주말 비교
    let weekdaySum = 0, weekendSum = 0;
    for (let d = 0; d < 7; d++) {
      const s = heatmap[d].reduce((a, b) => a + b, 0);
      if (d === 0 || d === 6) weekendSum += s; else weekdaySum += s;
    }
    const DOW = ['일', '월', '화', '수', '목', '금', '토'];

    res.json({
      success: true,
      unit,
      period: `${days}d`,
      realOnly: sfL.realOnly,
      byUnit,
      heatmap,
      peak: { ...peak, dowLabel: DOW[peak.dow], label: `${DOW[peak.dow]} ${peak.hour}시` },
      weekdayVsWeekend: { weekday: weekdaySum, weekend: weekendSum }
    });
  } catch (err) {
    console.error('[LRS] /stats/time-by-unit error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// P1-3 — 교사 보충 일괄배정(처방 실행). 기획서: LRS_P1_심화_기획서.md §4
//   권한: 배정/취소/현황 = 담당 교사(isClassManager: owner·teacher·co_teacher)·관리자만.
//         학생: 본인 보충 목록/완료만. 멱등(UNIQUE) · 취소 soft · P6 학생 위험 비노출.
// ─────────────────────────────────────────────────────────

// POST /api/lrs/supplement/assign — 교사 일괄배정(멱등).
//   body 형식 2종 지원:
//   (A) { classId, items:[{userId, achievementCode, contentId?}], source? }
//   (B) { classId, achievementCode, contentIds:[], studentIds:[], source? }
//       → 미도달/부분도달 학생 × 추천 콘텐츠 조합(contentIds 없으면 코드만 처방).
//   resp: { success, assigned, skipped, ids:[], skippedDetail:[] }
router.post('/supplement/assign', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.body.classId, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    // 권한: 담당 교사/관리자만. 비담당·학생 403.
    if (!isClassManager(req, classId) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    const source = req.body.source || 'ews';
    let items = [];
    if (Array.isArray(req.body.items)) {
      // (A) 명시 items
      items = req.body.items;
    } else if (req.body.achievementCode && Array.isArray(req.body.studentIds)) {
      // (B) 약점 코드 × 학생 × 콘텐츠 조합
      const code = String(req.body.achievementCode);
      const studentIds = req.body.studentIds.map(Number).filter(Number.isInteger);
      const contentIds = Array.isArray(req.body.contentIds)
        ? req.body.contentIds.map(Number).filter(Number.isInteger)
        : [];
      for (const uid of studentIds) {
        if (contentIds.length) {
          for (const cid of contentIds) items.push({ userId: uid, achievementCode: code, contentId: cid });
        } else {
          items.push({ userId: uid, achievementCode: code, contentId: null }); // 코드만 처방
        }
      }
    }
    if (!items.length) {
      return res.status(400).json({ success: false, message: '배정할 항목이 없습니다.' });
    }
    // 멤버십 검증: 배정 대상은 해당 반 student 멤버여야(타 반 학생 배정 차단).
    const memberSet = new Set(analytics.classStudentIds(classId));
    const filtered = items.filter(it => memberSet.has(Number(it.userId)));
    if (!filtered.length) {
      return res.status(400).json({ success: false, message: '배정 대상이 이 반의 학생이 아닙니다.' });
    }

    const result = supplement.assignSupplements(classId, req.user.id, filtered, { source });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    console.error('[LRS] /supplement/assign error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/supplement/recommend?classId&code — 약점 코드 → 추천 콘텐츠 + 배정후보 학생.
router.get('/supplement/recommend', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.query.classId, 10);
    const code = req.query.code;
    if (!Number.isInteger(classId) || !code) {
      return res.status(400).json({ success: false, message: 'classId 와 code 가 필요합니다.' });
    }
    if (!isClassManager(req, classId) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const members = classDb.getClassMembers(classId).filter(m => m.user_role === 'student');
    const students = members.map(m => ({ id: m.user_id, name: m.display_name || m.username || `학생${m.user_id}` }));
    const data = supplement.recommendCandidates(classId, code, students);
    res.json({ success: true, classId, ...data });
  } catch (err) {
    console.error('[LRS] /supplement/recommend error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/supplement/class/:classId — 교사: 반 배정 현황(학생 실명 — 담임 정책).
router.get('/supplement/class/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId, 10);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID 입니다.' });
    }
    if (!isClassManager(req, classId) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const includeCancelled = String(req.query.includeCancelled || 'true') !== 'false';
    const list = supplement.getClassSupplements(classId, { includeCancelled });
    res.json({ success: true, classId, count: list.length, list });
  } catch (err) {
    console.error('[LRS] /supplement/class error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/supplement/my — 학생 본인 보충 목록(P6: 위험 필드 미포함).
router.get('/supplement/my', requireAuth, (req, res) => {
  try {
    const list = supplement.getMySupplements(req.user.id, { includeDone: true });
    res.json({ success: true, userId: req.user.id, count: list.length, list });
  } catch (err) {
    console.error('[LRS] /supplement/my error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/supplement/:id/cancel — 교사(소유 배정 반의 담당) 취소(soft).
router.post('/supplement/:id/cancel', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = supplement.getSupplementById(id);
    if (!row) return res.status(404).json({ success: false, message: '보충 배정을 찾을 수 없습니다.' });
    if (!isClassManager(req, row.class_id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const ok = supplement.cancelSupplement(id);
    res.json({ success: true, cancelled: ok, id });
  } catch (err) {
    console.error('[LRS] /supplement/cancel error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/supplement/:id/done — 학생 본인 완료(또는 담당 교사/관리자 완료 연동).
router.post('/supplement/:id/done', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = supplement.getSupplementById(id);
    if (!row) return res.status(404).json({ success: false, message: '보충 배정을 찾을 수 없습니다.' });
    const isOwnerStudent = row.user_id === req.user.id;
    const isManager = isClassManager(req, row.class_id) || req.user.role === 'admin';
    if (!isOwnerStudent && !isManager) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const ok = supplement.markDone(id);
    res.json({ success: true, done: ok, id });
  } catch (err) {
    console.error('[LRS] /supplement/done error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
