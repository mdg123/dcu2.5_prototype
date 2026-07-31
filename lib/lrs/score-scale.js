// lib/lrs/score-scale.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 시스템성] 점수 스케일·모집단 정규화 단일 출처(SSOT).
//
// 배경(실측 결함 이력):
//   learning_logs.result_score 는 유형별로 0~1 과 0~100 이 혼재 저장된다.
//   (실측: exam_complete 0.4~1, content_solve 100, self_learn 은 같은 유형 안에서도 0.61~100.)
//   정규화 없이 AVG(result_score) 를 내보내면 "학급 평균 성취 8.5점"(실제 ≈78) 같은 붕괴가 난다.
//
//   ★ 스케일 정규화만으로는 부족하다 — '모집단'도 함께 걸러야 한다.
//     lesson_progress 의 result_score 는 '진도율(0.5~1.0)'이지 정답률이 아니다.
//     ×100 만 하면 진도 50% 가 '성취 50점'으로 둔갑한다(사용자 실측 결함).
//     → 반드시 scoredWhere() 화이트리스트와 '함께' 써야 한다. 둘 중 하나만 쓰면 여전히 거짓이다.
//
// 왜 이 파일이 따로 있는가:
//   동일 정의가 routes/lrs.js 안에만 있어(모듈 export 없음) db/ 계층에서 재사용할 수 없었고,
//   그 결과 db/lrs-analytics.js 의 getEmotionMirror 가 정규화를 누락해
//   "슬픈 날 100점 / 보통인 날 1점" 이라는 거짓 비교를 학생에게 보여줬다(A6 카드).
//   → 이후 모든 '평균 점수' 산출 사이트는 이 모듈만 참조한다. 인라인 재정의 금지.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// [C1] '학습활동 정본 7종' — 사용자 확정 정의. **활동 "수"(건수) 집계 전용.**
//   이 목록은 "무엇을 학습으로 셀 것인가"의 답이지, "무엇이 채점됐는가"의 답이 아니다.
//   조회(content_view)·게시글·출석·설문은 학습활동이 아니므로 제외한다.
//   ⚠ SCORED_TYPES 와 혼동 금지 — 아래 주석 참조.
// ─────────────────────────────────────────────────────────────────────────────
// ★ routes/lrs.js 의 LRS_LEARN_ACTIVITY_TYPES 와 **반드시 동일**해야 한다(현재 그 목록의 사본).
//   7개 개념 / 8개 activity_type — '오늘의 학습'이 self_learn·daily_complete 두 유형을 쓴다.
const LEARNING_ACTIVITY_TYPES = [
  'lesson_progress',                // 1) 수업꾸러미 이수  ← 채점형에는 없다(진도율이므로)
  'exam_complete',                  // 2) 평가 응시
  'homework_submit',                // 3) 과제 제출
  'content_solve',                  // 4) 콘텐츠 문항 바로 풀이
  'self_learn', 'daily_complete',   // 5) 오늘의 학습
  'node_complete',                  // 6) AI 맞춤학습 차시 노드 이수
  'wrong_note_retry',               // 7) 오답노트 문항 풀이
];

// ─────────────────────────────────────────────────────────────────────────────
// [A5/A4] 채점형 모집단 화이트리스트 — **점수·정답률 산출 전용.**
//
//   ★ C1(활동 수) 과 의도적으로 다르다. 두 목록은 서로 다른 질문에 답한다:
//       C1              = "학습 활동으로 셀 것인가"      (건수의 모집단)
//       SCORED_TYPES    = "정답/점수 판정이 있는가"      (점수·정답률의 모집단)
//     한 목록으로 겸용하면 반드시 한쪽이 틀린다. 겸용 금지.
//
//   포함 근거(2026-07-31 data/dacheum.db 실측):
//     · content_complete (7,371건) — result_score 100%(22~100) · result_success 100%(5,636/1,735).
//       '콘텐츠 문항풀이'는 확정된 학습활동 정본 7종에 이미 포함된 개념이라, 채점 모집단에서
//       빼면 정의와 모순된다. (사용자 확정)
//     · problem_attempt (2,947건) — result_success **100% 보유**(2,224 정답/723 오답),
//       result_score 98.9%(0.47~100), verb=attempted/passed, target_type='problem'(문항 단위),
//       parent_statement_id **전건 NULL** → 부모 로그와의 이중계수 없음.
//       채점 신호 보유율이 전 유형 중 가장 높은데도 제외돼 있었다(= content_view 36,410건
//       무채점을 시도로 세면서 진짜 채점 1,763건을 버리던 정반대 방향의 오류).
//
//   제외 근거:
//     · lesson_progress — result_score 가 '진도율(0.5~1.0)'. ×100 하면 진도 50% 가 '성취 50점'.
//     · content_view/lesson_view/attendance_checkin/post_*/survey_respond — 점수·정답 신호 전무.
//     · homework_graded(8건) — 교사의 채점 '행위' 로그이지 학생 성취가 아니다.
//     · diagnosis_complete(3) · problem_set_complete(2) — 표본 극소.
// ─────────────────────────────────────────────────────────────────────────────
const SCORED_TYPES = [
  'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'wrong_note_retry', 'node_complete',
  'content_complete', 'problem_attempt',
];

const SCORED_TYPES_SQL_LIST = SCORED_TYPES.map(t => `'${t}'`).join(',');
const LEARNING_ACTIVITY_TYPES_SQL_LIST = LEARNING_ACTIVITY_TYPES.map(t => `'${t}'`).join(',');

/**
 * 행 단위 result_score 를 0~100 로 정규화하는 SQL 조각.
 * @param {string} [alias] 테이블 별칭('ll' 등). 없으면 컬럼명만.
 */
function normScoreExpr(alias) {
  const col = alias ? `${alias}.result_score` : 'result_score';
  return `(CASE WHEN ${col} <= 1 THEN ${col}*100 ELSE ${col} END)`;
}

/**
 * 점수(정답률) 개념이 있는 유형만 남기는 SQL 조각 — 진도형(lesson_progress) 자동 제외.
 * @param {string} [alias] 테이블 별칭.
 */
function scoredWhere(alias) {
  const col = alias ? `${alias}.activity_type` : 'activity_type';
  return `${col} IN (${SCORED_TYPES_SQL_LIST})`;
}

/**
 * [A5] 평균 점수의 정본 모집단 SQL 조각 — 채점형 유형 **이면서** 점수가 실제로 기록된 행만.
 *
 *   scoredWhere 만 쓰면 result_score IS NULL 행이 그룹에 남아, 집계 테이블에
 *   "행은 있는데 avg 는 NULL" 인 그룹과 "0 으로 채워진" 그룹이 뒤섞이는 원인이 된다.
 *   AVG 는 NULL 을 건너뛰므로 이 조각과 함께 쓰면 **분모 = 실제 채점 건수**가 보장된다.
 */
function scoredScoreWhere(alias) {
  const col = alias ? `${alias}.result_score` : 'result_score';
  return `${scoredWhere(alias)} AND ${col} IS NOT NULL`;
}

/**
 * [A5] 집계 테이블 avg_score 컬럼에 그대로 넣을 수 있는 정본 SQL 식.
 *   = 채점형 + 점수기록 행만 골라 행 단위 0~100 정규화한 평균. 해당 행이 없으면 NULL.
 *   ★ 절대 0 으로 폴백하지 않는다(§4-2: "성취 0점"이라는 거짓 금지).
 */
function avgScoreExpr(alias) {
  return `AVG(CASE WHEN ${scoredScoreWhere(alias)} THEN ${normScoreExpr(alias)} END)`;
}

/**
 * JS 스칼라 정규화 — 이미 조회된 값을 0~100 으로 통일할 때.
 * SQL 조각(normScoreExpr)과 반드시 같은 규칙이어야 한다.
 * @returns {number|null} 0~100 클램프. 숫자 아니면 null.
 */
function normScore(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const s = Number(value);
  const r = s <= 1 ? s * 100 : s;
  return Math.max(0, Math.min(100, r));
}

/** 채점형 유형인가(JS판) — SQL scoredWhere 와 반드시 같은 집합. */
function isScoredType(activityType) {
  return SCORED_TYPES.includes(String(activityType || ''));
}

module.exports = {
  SCORED_TYPES, SCORED_TYPES_SQL_LIST,
  LEARNING_ACTIVITY_TYPES, LEARNING_ACTIVITY_TYPES_SQL_LIST,
  normScoreExpr, scoredWhere, scoredScoreWhere, avgScoreExpr, normScore, isScoredType,
};
