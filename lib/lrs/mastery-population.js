// lib/lrs/mastery-population.js
// ─────────────────────────────────────────────────────────────────────────────
// [W2-a] 성취(mastery) 집계의 **모집단·산식 단일 출처(SSOT)**.
//
// ── 왜 이 파일이 필요한가 ────────────────────────────────────────────────────
// lrs_achievement_stats 를 채우는 경로가 둘인데, 서로 다른 판정을 내리고 있었다:
//
//   ① 실시간  db/learning-log-helper.js  — 로그 1건마다 증분 UPSERT.
//        평가신호(score 또는 success) 있는 건만 반영하는 필터가 **있었다**.
//   ② 재집계  db/lrs-aggregate.js        — learning_logs 전수 GROUP BY.
//        그 필터가 **없었다**. WHERE 는 achievement_code IS NOT NULL 뿐.
//
//   실측(2026-07-31, data/dacheum.db): 저장된 49,336행 중 **18,347행(37.2%)** 이
//   채점 신호가 하나도 없는 행(대부분 content_view 36,410건)으로 만들어진 유령 행이고,
//   재집계를 한 번 돌릴 때마다 **2,344행의 status 가 뒤집혔다.**
//   즉 "언제 재집계했는가"가 학생의 도달/미도달을 바꾸고 있었다.
//
// ── 정본은 ②(재집계) 다 ─────────────────────────────────────────────────────
// 근거: 재집계는 learning_logs 전수로부터 **재현 가능한 집합 정의**다.
//       실시간은 그 정의를 증분으로 흉내내는 구현일 뿐이다.
//       정의(집합)와 구현(증분)이 다투면 언제나 정의가 이긴다.
//
// ── 두 경로가 다시 갈라지지 않게 만드는 방법 ────────────────────────────────
// "같은 규칙을 양쪽에 각각 구현하고 동기화한다"는 실패한다(위가 그 실패다).
// 그래서 이 파일은 **SQL 문자열 자체를 공유**한다.
//   · 재집계: WHERE <predicate>            GROUP BY user_id, achievement_code
//   · 실시간: WHERE <predicate> AND user_id=? AND achievement_code=?
// 술어도 집계식도 한 벌뿐이고, 두 경로의 차이는 **키 범위뿐**이다.
// 실시간이 증분 계산을 버리고 원천에서 재계산하므로 산술적 드리프트가 존재할 수 없다.
// (비용 실측 ~1.3ms/건. 로그 쓰기 1건은 이미 8개 UPSERT 를 트랜잭션으로 돈다.)
// ─────────────────────────────────────────────────────────────────────────────
const { scoredWhere, normScoreExpr, isScoredType } = require('./score-scale');

const col = (alias, name) => (alias ? `${alias}.${name}` : name);

/**
 * 성취 '시도(attempt)' 의 정본 술어.
 *
 * 세 조건을 **모두** 만족해야 1시도다:
 *   ① achievement_code IS NOT NULL  — 어느 성취기준에 대한 시도인지 특정 가능
 *   ② 채점형 유형(scoredWhere)      — 진도율(lesson_progress)·조회(content_view) 배제
 *   ③ result_success IS NOT NULL    — 정오 판정이 실제로 존재
 *
 * ③ 이 핵심이다. attempt_count 는 success_count 의 **분모**이므로,
 * 정오 판정이 없는 행을 분모에만 넣으면 분자에는 절대 못 들어가 정답률이 구조적으로 낮아진다.
 * (지표 정본사전 §2-A-4 결함 2 — "동일 방향의 하향 편의 중복")
 * 이 술어 하에서는 분모와 분자가 **정의상 같은 행 집합**을 본다.
 */
function masteryAttemptWhere(alias) {
  return `${col(alias, 'achievement_code')} IS NOT NULL`
    + ` AND ${scoredWhere(alias)}`
    + ` AND ${col(alias, 'result_success')} IS NOT NULL`;
}

/**
 * 위 술어의 JS 쌍둥이. 실시간 경로가 "재계산할 가치가 있는 로그인가"를 싸게 선판정할 때 쓴다.
 * ★ 반드시 masteryAttemptWhere 와 같은 집합이어야 한다(하네스가 전수 대조로 박제).
 */
function isMasteryAttempt({ activityType, achievementCode, resultSuccess } = {}) {
  if (achievementCode == null || achievementCode === '') return false;
  if (!isScoredType(activityType)) return false;
  return resultSuccess != null;
}

/**
 * 집계 컬럼식 — 재집계·실시간이 **글자 그대로 공유**한다.
 *   attempt_count : 시도 수 (= 술어를 통과한 행 수)
 *   success_count : 정답 인정 수
 *   avg_score     : 점수가 기록된 시도만의 0~100 정규화 평균 (없으면 NULL — 0 폴백 금지)
 *   subject_code / last_attempt_at : 대표값
 */
function masteryAggSelect(alias) {
  return [
    `COUNT(*) AS attempt_count`,
    `SUM(CASE WHEN ${col(alias, 'result_success')} = 1 THEN 1 ELSE 0 END) AS success_count`,
    `AVG(CASE WHEN ${col(alias, 'result_score')} IS NOT NULL`
      + ` THEN ${normScoreExpr(alias)} END) AS avg_score`,
    `MAX(${col(alias, 'subject_code')}) AS subject_code`,
    `MAX(${col(alias, 'created_at')}) AS last_attempt_at`,
  ].join(',\n           ');
}

/** 단일 (user, code) 재계산 쿼리 — 실시간 경로 전용. 재집계와 동일한 술어·집계식. */
function masteryRecomputeSql() {
  return `
    SELECT ${masteryAggSelect('')}
    FROM learning_logs
    WHERE ${masteryAttemptWhere('')}
      AND user_id = ? AND achievement_code = ?
  `;
}

module.exports = {
  masteryAttemptWhere, isMasteryAttempt, masteryAggSelect, masteryRecomputeSql,
};
