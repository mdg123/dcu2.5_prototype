// lib/grade-answer.js
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 문항 채점 판정 SSOT (기획서 §1-2-d BE-2)
//
// ■ 왜 이 파일이 생겼나
//   판정 로직(`_normalizeQType` · `_normalizeShort` · `String(given) === String(q.answer)`)이
//   `routes/content.js` 의 `/grade` 핸들러 **안에만** 인라인으로 있었다. 응답 현황 모니터가
//   같은 판정을 다시 해야 하는데, 거기서 복사하면 **정본 옆에 판정 사본**이 생긴다 —
//   이 프로젝트에서 가장 자주 재발한 결함이다(라벨↔집계 불일치·스케일 혼재의 뿌리).
//   그래서 판정을 여기 한 벌만 두고 `/grade` 와 모니터가 **같은 함수**를 호출한다.
//   `test/lesson-response-monitor.test.js` INV-M-SSOT 가 두 경로의 결과 일치를 매번 확인한다.
//
// ■ 🔴 채점 계약 (2026-08 정답키 정합 작업에서 확정 — 바꾸지 말 것)
//   · `content_questions.answer` 는 **0-based 인덱스 문자열**이다(객관식). `'0'` 이 2,337건 —
//     1-based 로는 존재할 수 없는 값이라 이 계약이 정본임을 데이터가 증명한다.
//   · 객관식 판정은 `String(given) === String(q.answer)` — **보정(±1) 없이** 그대로 비교한다.
//     여기에 "1-based 일 수도 있으니 한 칸 밀어보자" 류의 관용을 넣는 순간
//     9,544 문항이 통째로 틀어졌던 2026-08-21 지뢰가 되살아난다.
//     (test/schema-no-blanket-answer-shift.test.js · test/content-answer-index.test.js)
//   · 단답형은 공백 제거 + 소문자화 후 비교(관대한 비교). 정답이 빈 문자열이면 항상 오답.
//   · 서술형(essay)은 자동채점 보류 → `null`.
//   · 미응답(`null`·`''`)은 채점하지 않는다 → `null`.
//
// ■ 순서 의존 제거 (기획서 BE-3)
//   제출 답안은 두 형태가 공존한다:
//     · 순서 배열            `[3, 0, 1, 1]`                  ← 레거시(하위호환 필수)
//     · 문항 id 배열  `[{questionId:4244, value:3}, ...]`     ← 신규
//   `buildAnswerLookup()` 이 둘 다 받아 **문항 기준**으로 값을 돌려준다. 문항이 추가·삭제되면
//   순서 배열은 통째로 밀리지만 id 배열은 안 밀린다 — 그래서 신규 경로를 병행 저장한다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/** 단답형 관대 비교용 정규화: 공백 제거 + 소문자화. */
function normalizeShort(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
}

/** 문항 유형 정규화 → 'choice' | 'short' | 'essay' (알 수 없으면 'choice'). */
function normalizeQType(t) {
  const s = String(t || '').toLowerCase();
  if (s === 'multiple_choice' || s === 'multiple' || s === 'mc' || s === 'choice') return 'choice';
  if (s === 'short_answer' || s === 'short-answer' || s === 'fill' || s === 'short') return 'short';
  if (s === 'essay' || s === 'long' || s === 'written' || s === 'long_answer') return 'essay';
  return 'choice';
}

/** 응답이 "비어 있는가"(미응답). */
function isBlank(given) {
  return given === null || given === undefined || given === '';
}

/**
 * 정·오답 판정.
 * @param {{question_type?:string, answer?:*}} q  문항 행(content_questions)
 * @param {*} given  학생의 원시 응답값
 * @returns {true|false|null}  true=정답 / false=오답 / null=채점 불가(미응답·서술형)
 */
function judge(q, given) {
  if (isBlank(given)) return null;
  const t = normalizeQType(q && q.question_type);
  if (t === 'essay') return null;
  if (t === 'choice') return String(given) === String(q && q.answer);
  return normalizeShort(q && q.answer) !== '' && normalizeShort(q && q.answer) === normalizeShort(given);
}

/**
 * 셀 상태 분류 (기획서 §5-5 · §8-1 `cells[].state`).
 * @returns {'correct'|'wrong'|'pending'|'unanswered'}
 */
function classify(q, given) {
  if (isBlank(given)) return 'unanswered';
  if (normalizeQType(q && q.question_type) === 'essay') return 'pending';
  return judge(q, given) === true ? 'correct' : 'wrong';
}

/**
 * 제출 답안 배열 → "문항으로 값 찾기" 함수.
 *   · `[{questionId, value}]` 이면 questionId 매칭 (문항 추가/삭제에 안전)
 *   · `[v0, v1, ...]` 이면 순서 매칭 (레거시 하위호환)
 *   · 두 형태가 섞여 있어도 각 항목별로 알아서 갈린다.
 * @param {*} answers  파싱된 배열(문자열 JSON 아님)
 * @returns {(question:{id?:number}, index:number) => *}  없으면 undefined
 */
function buildAnswerLookup(answers) {
  const byId = new Map();
  const byIndex = new Map();
  const list = Array.isArray(answers) ? answers : [];
  list.forEach((a, i) => {
    if (a && typeof a === 'object' && !Array.isArray(a) && a.questionId != null) {
      byId.set(Number(a.questionId), a.value);
    } else {
      byIndex.set(i, (a && typeof a === 'object' && !Array.isArray(a)) ? a.value : a);
    }
  });
  return function pick(question, index) {
    const qid = (question && question.id != null) ? Number(question.id) : null;
    if (qid !== null && byId.has(qid)) return byId.get(qid);
    if (byIndex.has(index)) return byIndex.get(index);
    return undefined;
  };
}

/** JSON 문자열이든 배열이든 배열로 만든다(파싱 실패 시 null). */
function parseAnswers(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : null;
    } catch (_) { return null; }
  }
  return null;
}

module.exports = { normalizeShort, normalizeQType, isBlank, judge, classify, buildAnswerLookup, parseAnswers };
