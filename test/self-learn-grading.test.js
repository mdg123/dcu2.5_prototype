// test/self-learn-grading.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0-5] AI 맞춤학습(학습맵) 문제 풀이 채점이 1칸 밀려 **오답을 정답으로 DB에 적재**하던 결함.
//
// 결함(2026-08-05 실측, 격리 서버 3241 / student1 세션):
//   차시 E2MATA01B01C01D01 · 콘텐츠 403 · 문항 375
//     question_text : "다음 그림이 나타내는 수는 얼마입니까?  🍎🍎🍎🍎🍎🍎"
//     options       : ["8","7","3","2","6"]   answer : "4"   (= 0-based index 4 → "6")
//   learning-map.html submitSolve 가 `(idx + 1).toString() === answer` 로 **1-based** 판정 →
//   보기 ④ "2" 를 고르면 화면에 "✅ 정답입니다! … 따라서 정답은 6입니다."(자기모순) 가 뜨고
//   POST /api/self-learn/problem-attempt 가 {correct:true} 로 응답, problem_attempts.is_correct=1 로 적재됐다.
//   (FE 가 questionId 를 안 보내 서버 재채점이 발동하지 않고 클라 판정을 그대로 신뢰했기 때문)
//
// 정본 규약: content_questions.answer 는 **0-based 보기 index**.
//   근거 — 전체 11,886 문항 중 answer='0' 이 2,275건(19%). 1-based 라면 성립할 수 없는 값이다.
//   같은 규약을 db/self-learn-extended.js judgeQuestionAnswer 와 public/content/content-player.html 이 쓴다.
//
// 불변식:
//   INV-SLG1  answer='0' 문항 전수 — 첫 보기가 정답 (0-based 규약의 직접 실증)
//   INV-SLG2  객관식 전수 — 정답 보기는 정확히 1개, 표시 정답=채점 정답, 한 칸 앞 보기는 항상 오답
//   INV-SLG3  recordProblemAttempt(questionId 有) — 0-based 정답 index 만 is_correct=1
//   INV-SLG4  recordProblemAttempt(questionId 無, 단일문항 콘텐츠) — 서버가 재채점해 클라 isCorrect 를 신뢰하지 않음
//   INV-SLG5  FE 소스 계약 — submitSolve 가 questionId 를 전송하고, 1-based 판정식·가짜 보기가 남아 있지 않음
// DB 격리: 실 DB → 임시 복사본(무오염).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const sl = require('../db/self-learn-extended');
const db = openTestDb();

const J = sl.judgeQuestionAnswer;

function parseOpts(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith('[')) return null;
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : null; } catch { return null; }
}
const norm = (v) => String(v == null ? '' : v).replace(/[①②③④⑤]/g, '').replace(/\s+/g, '').trim().toLowerCase();

// ── INV-SLG1: answer='0' 문항 전수 — 0-based 규약의 직접 실증 ────────────────
//   1-based 라면 존재할 수 없는 값이므로, 이 부류가 전부 opts[0] 정답이어야 규약이 성립한다.
test("INV-SLG1 answer='0' 문항 전수 — 첫 보기가 정답 (0-based 규약 실증)", () => {
  const rows = db.prepare(`
    SELECT id, answer, options FROM content_questions
    WHERE options LIKE '[%' AND TRIM(answer) = '0'
  `).all();

  let checked = 0;
  const fail = [];
  for (const q of rows) {
    const opts = parseOpts(q.options);
    if (!opts || opts.length < 2) continue;
    checked++;
    if (J(q, opts[0], 0) !== true) fail.push(q.id);
  }
  assert.ok(checked > 1000,
    `answer='0' 객관식이 충분히 존재해야 한다 (실측 ${checked}건). ` +
    `0 이면 규약이 1-based 로 재해석될 여지가 생긴다.`);
  assert.deepEqual(fail.slice(0, 10), [], `첫 보기가 정답으로 판정되지 않은 문항: ${fail.length}건`);
});

// ── INV-SLG2: 객관식 전수 — "한 칸 밀림"은 언제나 오답 ───────────────────────
//   정답 index 는 채점 정본(_resolveCorrectIndex, resolveCorrectAnswerText)이 산출한 값을 쓴다.
//   (일부 문항은 보기 텍스트에 ①②③ 가 내용으로 박혀 있어 raw answer 만으로는 단정할 수 없다.
//    그 해석은 정본 헬퍼의 책임이고, 여기서 검증하는 것은 "정본이 자기일관인가" 다.)
test('INV-SLG2 객관식 전수 — 정본이 지목한 정답은 정답, 한 칸 앞 보기는 오답', () => {
  const rows = db.prepare(`
    SELECT id, answer, options FROM content_questions
    WHERE options LIKE '[%' AND TRIM(COALESCE(answer,'')) <> ''
  `).all();

  let checked = 0;
  const multiTrue = [], failDisplay = [], failShift = [];
  for (const q of rows) {
    const opts = parseOpts(q.options);
    if (!opts || opts.length < 2) continue;

    // 정답으로 인정되는 보기 index 집합 — 반드시 정확히 1개여야 한다.
    const trueIdx = opts.map((_, i) => i).filter(i => J(q, opts[i], i) === true);
    if (trueIdx.length === 0) continue;        // 정본이 보기 위치를 특정 못한 문항 — 대상 외
    checked++;
    if (trueIdx.length > 1) { multiTrue.push(q.id); continue; }

    const k = trueIdx[0];
    // 화면 표시 정답(resolveCorrectAnswerText) 과 채점 정답이 같은 보기를 가리켜야 한다.
    if (String(sl.resolveCorrectAnswerText(q)) !== String(opts[k])) failDisplay.push(q.id);
    // 한 칸 밀린 보기는 언제나 오답 (보기 텍스트가 중복인 경우는 제외 — 텍스트 경로로 정답 가능)
    if (k - 1 >= 0 && norm(opts[k - 1]) !== norm(opts[k])) {
      if (J(q, opts[k - 1], k - 1) !== false) failShift.push(q.id);
    }
  }

  assert.ok(checked > 5000, `검사 대상 객관식이 충분해야 한다 (실측 ${checked}건)`);
  assert.deepEqual(multiTrue.slice(0, 10), [],
    `정답으로 인정되는 보기가 2개 이상인 문항: ${multiTrue.length}건`);
  assert.deepEqual(failDisplay.slice(0, 10), [],
    `표시 정답(resolveCorrectAnswerText)과 채점(judgeQuestionAnswer)이 어긋난 문항: ${failDisplay.length}건 — ` +
    `화면은 "정답은 6" 인데 채점은 다른 보기를 정답 처리하는 자기모순의 원인이다`);
  assert.deepEqual(failShift.slice(0, 10), [],
    `한 칸 밀린 index 가 정답으로 오판된 문항: ${failShift.length}건`);
});

// ── 픽스처: P0-5 재현 문항(단일 문항 콘텐츠) ─────────────────────────────────
function pickSingleQuestionContent() {
  // 실 DB 픽스처 우선(문항 375 / 콘텐츠 403), 없으면 조건에 맞는 아무 문항
  const preferred = db.prepare(`
    SELECT q.id, q.content_id, q.answer, q.options
    FROM content_questions q
    WHERE q.content_id = (SELECT content_id FROM content_questions WHERE id = 375)
  `).all();
  if (preferred.length === 1) return preferred[0];
  return db.prepare(`
    SELECT q.id, q.content_id, q.answer, q.options
    FROM content_questions q
    JOIN (SELECT content_id FROM content_questions GROUP BY content_id HAVING COUNT(*) = 1) s
      ON s.content_id = q.content_id
    JOIN contents c ON c.id = q.content_id
    WHERE q.options LIKE '[%' AND CAST(q.answer AS INTEGER) >= 1 AND TRIM(q.answer) GLOB '[0-9]*'
    LIMIT 1
  `).get();
}

const UID = db.prepare("SELECT id FROM users WHERE username = 'student1'").get().id;

test('INV-SLG3 recordProblemAttempt(questionId 有) — 0-based 정답만 is_correct=1', () => {
  const q = pickSingleQuestionContent();
  assert.ok(q, '단일 문항 객관식 콘텐츠 픽스처가 있어야 한다');
  const opts = parseOpts(q.options);
  const k = Number(String(q.answer).trim());
  assert.ok(k >= 1 && k < opts.length, `픽스처 answer 가 1 이상이어야 밀림을 검증할 수 있다 (answer=${q.answer})`);

  const ok = sl.recordProblemAttempt(UID, q.content_id, {
    isCorrect: false, selectedAnswer: String(opts[k]), answerIndex: k, questionId: q.id, timeTaken: 3
  });
  assert.equal(ok.correct, true, '0-based 정답 index 는 정답');
  assert.equal(db.prepare('SELECT is_correct FROM problem_attempts WHERE id = ?').get(ok.attemptId).is_correct, 1);

  const shifted = sl.recordProblemAttempt(UID, q.content_id, {
    isCorrect: true, selectedAnswer: String(opts[k - 1]), answerIndex: k - 1, questionId: q.id, timeTaken: 3
  });
  assert.equal(shifted.correct, false,
    `한 칸 밀린 보기(${opts[k - 1]})는 오답이어야 한다 — 클라가 isCorrect:true 를 보내도 서버 판정이 이긴다`);
  assert.equal(db.prepare('SELECT is_correct FROM problem_attempts WHERE id = ?').get(shifted.attemptId).is_correct, 0,
    'DB 에도 오답으로 적재되어야 한다');
});

test('INV-SLG4 recordProblemAttempt(questionId 無·단일문항) — 클라 isCorrect 를 신뢰하지 않고 서버가 재채점', () => {
  const q = pickSingleQuestionContent();
  const opts = parseOpts(q.options);
  const k = Number(String(q.answer).trim());

  // 수정 전 FE(learning-map submitSolve)가 보내던 그대로: questionId 없음 + 1-based 로 "정답"이라 주장
  const r = sl.recordProblemAttempt(UID, q.content_id, {
    isCorrect: true, selectedAnswer: String(opts[k - 1]), answerIndex: k - 1, timeTaken: 3
  });
  assert.equal(r.correct, false, 'questionId 가 없어도 단일 문항 콘텐츠면 서버가 재채점해 오답으로 판정해야 한다');
  assert.equal(db.prepare('SELECT is_correct FROM problem_attempts WHERE id = ?').get(r.attemptId).is_correct, 0);
  assert.equal(r.correctAnswer, String(opts[k]), '노출용 정답 텍스트도 0-based 기준이어야 한다');
});

// ── INV-SLG4: FE 소스 계약 ───────────────────────────────────────────────────
//   결함이 인라인 <script> 안에 있어 함수 단위로 import 할 수 없다. 재발 통로(1-based 판정식·
//   questionId 미전송·가짜 보기 생성)를 소스에서 직접 금지해 회귀를 박제한다.
test('INV-SLG5 learning-map.html — questionId 전송 / 1-based 판정식·가짜 보기 부재', () => {
  const p = path.join(__dirname, '..', 'public', 'self-learn', 'learning-map.html');
  const src = fs.readFileSync(p, 'utf8');

  const submitIdx = src.indexOf('async function submitSolve()');
  assert.ok(submitIdx > 0, 'submitSolve 함수가 있어야 한다');
  const submitBody = src.slice(submitIdx, submitIdx + 4000);

  assert.ok(/problem-attempt/.test(submitBody), 'submitSolve 가 /problem-attempt 를 호출해야 한다');
  assert.ok(/questionId\s*:/.test(submitBody),
    'submitSolve 는 questionId 를 보내 서버 재채점을 발동시켜야 한다 (미전송 시 클라 판정이 그대로 DB 에 적재됨 = P0-5)');

  // [R2 보완] 변수명만 바꿔도 통과하던 문자열 락을 일반화한다.
  //   "선택 index 에 +1 한 값을 무언가와 비교" 하는 **모든 형태**를 submitSolve 안에서 금지한다.
  //   예) (idx+1)===answer · (i + 1).toString() === p.answer · (sel+1) == correctNo
  //   ※ 검사 범위를 submitSolve 본문으로 한정한다 — 파일 전체로 넓히면 진단(submitDiagAnswer)처럼
  //     서버 판정을 최종 채택해 DB 영향이 없는 별개 경로까지 걸려 이 불변식의 뜻이 흐려진다.
  //     (그 경로의 잔여 1-based 라인은 별건으로 보고했다.)
  const noComments = submitBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ONE_BASED_CMP = /\(?\s*\w+\s*\+\s*1\s*\)?(\s*\.\s*toString\(\s*\))?\s*[=!]==/g;
  const offenders = [...noComments.matchAll(ONE_BASED_CMP)].map(m => m[0].trim().slice(0, 60));
  assert.deepEqual(offenders, [],
    'submitSolve 안에 선택 index 에 +1 해서 비교하는 1-based 판정이 남아 있으면 안 된다 (변수명 변경으로 우회 불가)');

  // 서버 판정을 최종으로 채택하는 구조인지 (클라 판정만으로 끝내면 안 된다)
  assert.ok(/data\s*&&\s*typeof\s+data\.correct\s*===\s*'boolean'/.test(submitBody),
    'submitSolve 는 서버 응답의 correct 를 최종 판정으로 채택해야 한다');
  assert.ok(/isCorrect\s*=\s*data\.correct/.test(submitBody),
    '서버 판정이 클라 판정을 덮어써야 한다');
  assert.ok(!/\['보기1',\s*'보기2'/.test(src),
    "문항이 없을 때 가짜 보기(['보기1'…])를 만들어 채점하면 안 된다");

  // 0-based 규약 헬퍼가 실제로 존재해야 한다
  assert.ok(/function resolveCorrectIndex\(/.test(src), '0-based 정답 index 산출 헬퍼가 있어야 한다');
});
