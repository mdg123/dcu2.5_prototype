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

// 점수(정답률) 개념이 있는 학습활동 유형 화이트리스트.
//   포함 근거: '학습활동 정본 7종' 중 채점 결과가 있는 것.
//   제외: lesson_progress(진도율) · content_view/post_create/attendance_checkin/survey_respond
//         /homework_graded 등 점수 개념이 없거나 7종 밖인 유형.
const SCORED_TYPES = [
  'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'wrong_note_retry', 'node_complete',
];

const SCORED_TYPES_SQL_LIST = SCORED_TYPES.map(t => `'${t}'`).join(',');

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

module.exports = {
  SCORED_TYPES, SCORED_TYPES_SQL_LIST,
  normScoreExpr, scoredWhere, normScore,
};
