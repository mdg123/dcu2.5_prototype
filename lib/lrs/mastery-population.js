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

// ─────────────────────────────────────────────────────────────────────────────
// [A4/B-1] 모집단 술어의 2단 분리 — "셀이 존재하는가" ≠ "판정 분모에 드는가"
//
// ── 무엇이 문제였나 (2026-08-04 실측) ────────────────────────────────────────
// W2-a 가 유령 행(조회 36,410건이 '시도'로 계수되던 것)을 제거할 때, 술어 하나가
// **두 가지 다른 질문**에 동시에 답하고 있었다:
//     ① 이 (학생 × 성취기준) 칸이 화면에 존재하는가
//     ② 이 행을 도달 판정의 분모(attempt)에 넣는가
// ③ result_success IS NOT NULL 은 ②의 옳은 답이지만 ①에는 과했다. 그 결과
// **정오 판정이 없는 채점형 학습(오늘의 학습 daily_complete)만 한 성취기준은
// 칸 자체가 지워졌다** — 학생이 실제로 푼 단원이 성취 화면에서 존재하지 않게 됐다.
//   실측: student1 19개 코드 중 7개 소멸(전부 daily_complete). 전 사이트 소멸 9셀.
//
// ── 분리 원칙 ───────────────────────────────────────────────────────────────
//   observed(관측) = achievement_code 있음 ∧ 채점형 유형
//                    → 칸이 화면에 "존재"하는 조건. 판정 자료가 없으면 attempt_count=0 →
//                      classifyStatus 가 자동으로 insufficient(평가 부족·회색)로 분류한다.
//                      **새 상태를 만들지 않는다**(att<3 의 부분집합).
//   attempt(시도)  = observed ∧ result_success IS NOT NULL
//                    → A1~A3 도달률의 분모. ★ 정의 한 글자도 바뀌지 않았다.
//
//   원칙: 학생이 채점형 학습을 1건이라도 한 성취기준은 화면에서 사라지지 않는다.
//         사라져야 하는 것은 조회(content_view)·진도(lesson_progress)·게시글·출석뿐이다.
//         → 그 배제는 scoredWhere 화이트리스트가 계속 담당한다(observed 에 포함돼 있다).
//
// ── 도달률이 변하지 않음이 왜 보장되는가 ────────────────────────────────────
//   집계식(masteryAggSelect)의 attempt_count·success_count·avg_score·last_attempt_at 는
//   전부 `result_success IS NOT NULL` 로 자기 자신을 다시 좁힌다. 그러므로 관측 전용 행이
//   그룹에 새로 들어와도 **기존 칸의 저장값은 한 컬럼도 달라지지 않는다**(순수 행 추가).
//   새 칸은 attempt_count=0 → 평가부족 → 도달률 분모에서 원래 제외되는 상태다.
//   (하네스 INV-A4-4 가 이를 전수 대조로 박제한다)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 성취 '관측(observed)' 의 정본 술어 — **칸이 화면에 존재하는가**.
 *   ① achievement_code IS NOT NULL  — 어느 성취기준에 대한 학습인지 특정 가능
 *   ② 채점형 유형(scoredWhere)      — 진도율(lesson_progress)·조회(content_view) 배제
 *
 * ②를 절대 완화하지 말 것. 완화하는 순간 비학습형만 있는 22,735(7종 기준)~17,355(9종 기준)
 * 셀이 회색으로 쏟아져 도넛이 회색 덩어리가 된다(하네스 INV-A4-6 이 차단).
 */
function observedWhere(alias) {
  return `${col(alias, 'achievement_code')} IS NOT NULL`
    + ` AND ${scoredWhere(alias)}`;
}

/**
 * 성취 '시도(attempt)' 의 정본 술어 — **도달 판정의 분모**.
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
 *
 * ★ 집합 정의 불변 — ①② 를 observedWhere 로 인수분해했을 뿐 뜻은 그대로다.
 */
function masteryAttemptWhere(alias) {
  return `${observedWhere(alias)}`
    + ` AND ${col(alias, 'result_success')} IS NOT NULL`;
}

/**
 * observedWhere 의 JS 쌍둥이. 실시간 경로가 "이 로그가 성취 칸을 만드는가"를 선판정한다.
 * ★ 반드시 observedWhere 와 같은 집합이어야 한다(하네스가 전수 대조로 박제).
 */
function isMasteryObserved({ activityType, achievementCode } = {}) {
  if (achievementCode == null || achievementCode === '') return false;
  return isScoredType(activityType);
}

/**
 * masteryAttemptWhere 의 JS 쌍둥이 — 판정 분모 여부.
 * ★ 반드시 masteryAttemptWhere 와 같은 집합이어야 한다(하네스가 전수 대조로 박제).
 */
function isMasteryAttempt({ activityType, achievementCode, resultSuccess } = {}) {
  if (!isMasteryObserved({ activityType, achievementCode })) return false;
  return resultSuccess != null;
}

/**
 * 집계 컬럼식 — 재집계·실시간이 **글자 그대로 공유**한다.
 * 그룹의 모집단은 observedWhere(관측)이고, 아래 컬럼들은 그 안에서 다시 시도(attempt)로 좁힌다.
 *   attempt_count : 시도 수 (= 정오 판정이 있는 행 수).  관측만 있으면 0.
 *   success_count : 정답 인정 수
 *   avg_score     : 점수가 기록된 **시도**만의 0~100 정규화 평균 (없으면 NULL — 0 폴백 금지)
 *   subject_code  : 시도 행 우선, 없으면 관측 행에서 폴백(칸이 교과 없이 뜨지 않게)
 *   last_attempt_at : **마지막 시도** 시각. 관측만 있는 칸은 NULL(시도가 없으므로 — 거짓 표기 금지)
 *
 * ★ 컬럼 순서는 db/lrs-aggregate.js 의 `INSERT ... SELECT` 위치 대응과 묶여 있다. 변경 금지.
 */
function masteryAggSelect(alias) {
  const judged = `${col(alias, 'result_success')} IS NOT NULL`;
  return [
    `SUM(CASE WHEN ${judged} THEN 1 ELSE 0 END) AS attempt_count`,
    `SUM(CASE WHEN ${col(alias, 'result_success')} = 1 THEN 1 ELSE 0 END) AS success_count`,
    `AVG(CASE WHEN ${judged} AND ${col(alias, 'result_score')} IS NOT NULL`
      + ` THEN ${normScoreExpr(alias)} END) AS avg_score`,
    `COALESCE(MAX(CASE WHEN ${judged} THEN ${col(alias, 'subject_code')} END),`
      + ` MAX(${col(alias, 'subject_code')})) AS subject_code`,
    `MAX(CASE WHEN ${judged} THEN ${col(alias, 'created_at')} END) AS last_attempt_at`,
  ].join(',\n           ');
}

/** 단일 (user, code) 재계산 쿼리 — 실시간 경로 전용. 재집계와 동일한 술어·집계식.
 *  observed_count 는 집계 테이블 컬럼이 아니라 **호출자의 "그룹이 비었는가" 판정용**이다
 *  (0행이면 SUM 은 NULL 을 돌려주므로 attempt_count 만으로는 구분되지 않는다). */
function masteryRecomputeSql() {
  return `
    SELECT ${masteryAggSelect('')},
           COUNT(*) AS observed_count
    FROM learning_logs
    WHERE ${observedWhere('')}
      AND user_id = ? AND achievement_code = ?
  `;
}

module.exports = {
  observedWhere, isMasteryObserved,
  masteryAttemptWhere, isMasteryAttempt, masteryAggSelect, masteryRecomputeSql,
};
