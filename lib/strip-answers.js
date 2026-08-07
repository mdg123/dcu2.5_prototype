// lib/strip-answers.js
// ─────────────────────────────────────────────────────────────────────────────
// 문항 정답·해설 비노출 판정의 **단일 실체(SSOT)**.
//
// 왜 이 파일이 존재하는가 (2026-08-07 감리 3차):
//   `getLessonContents` / `GET /api/contents/:id` 가 content_questions 를 SELECT * 로
//   내려보내 **학생 세션 응답에 answer·explanation 이 그대로 실렸다**. 화면에서는 안 보여도
//   네트워크 탭에서 `contents[0].questions[0].answer` 한 줄이면 정답이 보인다.
//   같은 시기에 routes/exam.js 는 이미 손으로 `{...q, answer: undefined}` 를 두 군데에
//   적어 두고 있었는데, 한 곳은 explanation 을 빼먹었고 두 곳 모두 **exam.answers(원본
//   JSON 컬럼)** 는 손대지 않아 정답 전문이 그대로 나갔다.
//   → 판정을 여러 곳에 손으로 다시 적으면 반드시 어긋난다("정본 옆에 판정 사본").
//     이 파일이 유일한 실체이고 모든 호출부는 여기를 호출만 한다.
//     (test/content-answer-exposure.test.js INV-AE4 소스 락이 사본을 금지한다)
//
// 정책 (역할 × 시점 2축):
//   ┌ 공개 ─ admin / teacher / principal        : 문항 편집·미리보기·채점이 정당한 직무
//   ├ 공개 ─ 콘텐츠·평가 작성자 본인(ownerId)     : 자기 자료
//   ├ 공개 ─ 제출 완료(submitted=true)           : 풀이가 끝났으면 해설을 봐야 학습이 된다
//   └ 차단 ─ 그 외(=풀기 전 학생)                : answer·explanation 제거
//
//   ⚠ "학생에겐 항상 숨김" 으로 뭉개면 **학습 기능이 망가진다**. 제출 후 해설은 정상이다.
//     제출 후 경로는 opts.submitted=true 로 명시하거나, 애초에 채점 응답(서버가 채점해
//     돌려주는 결과)으로 전달한다 — 후자가 content-player 채점 경로다.
//
// ⚠ DB·서버 내부 채점은 이 파일과 무관하다. 서버는 정답을 계속 쓴다.
//   여기서 벗기는 것은 **응답 직전의 사본**뿐이다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 문항 객체에서 제거해야 하는 "정답류" 필드.
 * 저장 스키마·외부 임포트 alias 를 모두 포함한다(routes/exam.js B04 정규화와 같은 목록).
 */
const ANSWER_FIELDS = Object.freeze([
  'answer',
  'correct_answer', 'correctAnswer',
  'answer_index', 'answerIndex',
  'correct_index', 'correctIndex',
  'explanation',
]);

/** 정답을 공개해도 되는 역할. */
const PRIVILEGED_ROLES = Object.freeze(['admin', 'teacher', 'principal']);

/**
 * 단일 판정 — 이 열람자에게 정답·해설을 공개해도 되는가?
 *
 * @param {{id?:number, role?:string}|null|undefined} viewer  req.user
 * @param {{ownerId?:number|string|null, submitted?:boolean}} [opts]
 *   - ownerId  : 자료 작성자 id (일치하면 공개)
 *   - submitted: 해당 열람자가 이미 제출을 마쳤는가 (true 면 공개 — 해설 표시)
 * @returns {boolean}
 */
function canRevealAnswers(viewer, opts = {}) {
  if (!viewer) return false;
  if (viewer.role && PRIVILEGED_ROLES.includes(viewer.role)) return true;
  if (opts.ownerId != null && viewer.id != null && Number(opts.ownerId) === Number(viewer.id)) return true;
  if (opts.submitted === true) return true;
  return false;
}

/** 문항 1개에서 정답류 필드를 제거한 **사본**을 만든다(원본 불변 — 내부 채점 보호). */
function _scrubQuestion(q) {
  if (!q || typeof q !== 'object') return q;
  const out = Array.isArray(q) ? q.slice() : { ...q };
  for (const f of ANSWER_FIELDS) delete out[f];
  return out;
}

/**
 * 문항 배열에서 정답류 필드를 벗긴다. 공개 대상이면 원본을 그대로 돌려준다.
 *
 * @param {Array<object>|null|undefined} questions
 * @param {{id?:number, role?:string}|null} viewer
 * @param {{ownerId?:number|string|null, submitted?:boolean}} [opts]
 * @returns {Array<object>|null|undefined} 원본 또는 정답 제거 사본
 */
function stripAnswers(questions, viewer, opts = {}) {
  if (!Array.isArray(questions)) return questions;
  if (canRevealAnswers(viewer, opts)) return questions;
  return questions.map(_scrubQuestion);
}

/**
 * 문항 배열이 JSON **문자열**로 담긴 컬럼(exams.answers 등)을 벗긴다.
 * 파싱 실패 시 통째로 null 을 돌려준다(정답이 담긴 원문을 그대로 흘려보내지 않는다).
 *
 * @returns {string|null} 정답 제거된 JSON 문자열, 또는 null
 */
function stripAnswersJson(rawJson, viewer, opts = {}) {
  if (rawJson == null) return rawJson;
  if (canRevealAnswers(viewer, opts)) return rawJson;
  let arr;
  try { arr = JSON.parse(rawJson); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return JSON.stringify(arr.map(_scrubQuestion));
}

/**
 * 콘텐츠 객체(`{..., questions:[...]}`)의 정답을 벗긴 **얕은 사본**을 만든다.
 * 콘텐츠 상세·수업꾸러미 콘텐츠 목록이 쓴다.
 */
function stripContentAnswers(content, viewer, opts = {}) {
  if (!content || typeof content !== 'object') return content;
  if (canRevealAnswers(viewer, { ownerId: content.creator_id, ...opts })) return content;
  if (!Array.isArray(content.questions)) return content;
  return { ...content, questions: stripAnswers(content.questions, viewer, opts) };
}

/**
 * 평가(exam) 객체의 정답을 벗긴 **얕은 사본**을 만든다.
 *   - `questions` (getExamById 가 파싱해 붙인 배열)
 *   - `answers`   (exams 테이블 원본 JSON 컬럼 — questions 만 가리고 이걸 놔두면 무의미)
 *   - `explanations` (해설 원본 컬럼)
 *
 * ⚠ 과거 결함: routes/exam.js 가 questions 만 손으로 가리고 answers 원문을 그대로 실어
 *   학생 세션에서 `exam.answers` 한 줄로 정답 전문이 보였다(2026-08-07 실측).
 */
function stripExamAnswers(exam, viewer, opts = {}) {
  if (!exam || typeof exam !== 'object') return exam;
  const o = { ownerId: exam.owner_id, ...opts };
  if (canRevealAnswers(viewer, o)) return exam;
  const out = { ...exam };
  if (Array.isArray(out.questions)) out.questions = stripAnswers(out.questions, viewer, o);
  if ('answers' in out) out.answers = stripAnswersJson(out.answers, viewer, o);
  if ('explanations' in out) out.explanations = null;
  return out;
}

module.exports = {
  ANSWER_FIELDS,
  PRIVILEGED_ROLES,
  canRevealAnswers,
  stripAnswers,
  stripAnswersJson,
  stripContentAnswers,
  stripExamAnswers,
};
