// lib/ids.js
// ─────────────────────────────────────────────────────────────────────────────
// 정수 식별자 정규화 **단일 정본(SSOT)**.
//
// 🔴 유래 — "게이트와 실행기가 같은 문자열을 다르게 읽는" P0 (2026-08-07 감리 6차 실측)
//
//     POST /api/self-learn/problem-attempt {"contentId":5,"questionId":"2.17e2"}
//       → 200 { "correctAnswer":"56", "explanation":"7 × 8 = 56 입니다." }
//
//   게이트(routes/self-learn.js)는 `parseInt("2.17e2",10)` → **2** 로 읽어
//   "공개 콘텐츠 5의 2번 문항"이라 판단하고 통과시켰다.
//   채점기(db/self-learn-extended.js)는 같은 문자열을 SQLite 바인드로 넘겼고,
//   SQLite 는 `WHERE id = '2.17e2'` 를 **217** 로 코어션해 비공개 193의 217번 문항을 꺼냈다.
//
//   실측 파싱 표 (parseInt vs SQLite 코어션):
//     "2.17e2"   → 2 / 217   🔴      "2.17E2"  → 2 / 217   🔴
//     "+2.17e2"  → 2 / 217   🔴      "2.17e+2" → 2 / 217   🔴
//     " 2.17e2 " → 2 / 217   🔴      ".217e3"  → NaN / 217 🔴
//     "217" · "217.0" · "0217" → 217 / 217  (일치)
//
// ■ 정책 — **엄격한 정수 문자열만 통과**
//   parseInt 의 "앞부분만 읽고 나머지는 버린다"는 관대함이 갈림의 근원이다.
//   여기서는 갈릴 여지 자체를 없앤다: 통과한 값은 **항상 Number** 이고,
//   호출부는 그 Number 만 게이트·쿼리 양쪽에 쓴다(같은 값을 두 번 해석하지 않는다).
//
//   허용:  양의 안전 정수(number) · /^\d+$/ 를 만족하는 문자열(양끝 공백 허용)
//   거부:  "2.17e2" · "217.0" · "5abc" · "-3" · "0" · "" · null · boolean · object
//
//   ※ " 217 " 는 parseInt·SQLite 가 **둘 다 217** 로 읽어 갈림이 없다 → 허용(과잉 차단 방지).
//   ※ "217.0" 도 둘 다 217 이지만 정상 클라이언트가 만들지 않는 형태라 거부한다.
//      JSON 숫자 217.0 은 JS 파서가 정수 217 로 만들므로 이 규칙에 걸리지 않는다.
//
// ⚠ 다음 사람에게: 이 판정을 호출부에 **다시 적지 마십시오**. 정본 옆에 판정 사본을
//   두는 것이 이 프로젝트의 반복 결함이고, 이 P0 자체가 그 결과다.
// ─────────────────────────────────────────────────────────────────────────────

/** 엄격한 10진 정수 문자열(부호·소수점·지수 표기 전부 불가) */
const STRICT_INT = /^\d+$/;

/**
 * 정수 식별자를 정규화한다.
 * @param {*} v 원본 값(문자열·숫자 무엇이든)
 * @returns {number|null} 정규화된 양의 정수, 규격 밖이면 null
 */
function normalizeId(v) {
  if (typeof v === 'number') {
    return (Number.isSafeInteger(v) && v > 0) ? v : null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!STRICT_INT.test(t)) return null;
    const n = Number(t);
    return (Number.isSafeInteger(n) && n > 0) ? n : null;
  }
  // boolean · object · array · bigint · null · undefined — 식별자가 아니다.
  return null;
}

/**
 * "값이 아예 안 왔다" 와 "왔는데 규격 밖이다" 를 구분한다.
 * 선택 식별자(questionId 처럼 미전송이 정상인 키) 처리에 쓴다.
 * @returns {'absent'|'invalid'|'ok'}
 */
function classifyId(v) {
  if (v === undefined || v === null || v === '') return 'absent';
  return normalizeId(v) === null ? 'invalid' : 'ok';
}

/** normalizeId 가 값을 돌려주는가 (가독용 술어) */
function isId(v) { return normalizeId(v) !== null; }

module.exports = { normalizeId, classifyId, isId, STRICT_INT };
