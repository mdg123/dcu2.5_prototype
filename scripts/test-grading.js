require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// Unit test for judgeQuestionAnswer / recordProblemAttempt — 진단 v3 채점 인덱스 정합(2026-06-08)
//
// 새 규약(통일): 객관식은 선택 보기 텍스트(answer) + 0-based answerIndex 를 함께 전송.
//   서버는 정답의 0-based index 를 robust 산출(원숫자 prefix·0/1-based 혼재 흡수) 후
//   (a) submittedIndex==correctIndex  또는  (b) 선택 텍스트==정답 텍스트  로 판정.
//   0/1-based 맨숫자 동시 인정(과거 버그)은 제거. answerIndex 없는 맨숫자는 0-based로 단정.
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const sl = require('../db/self-learn-extended');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

let pass = 0, fail = 0;
function assert(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, '— got', JSON.stringify(got), 'want', JSON.stringify(want)); }
}
const J = sl.judgeQuestionAnswer;

// ───────────────────────────────────────────────────────────────
console.log('\n[0] 핵심 재현 — Q7951 (answer="2" 0-based, opts=[5/8,6/8,7/8,8/8,12/16] → 정답 "7/8")');
const q7951 = db.prepare("SELECT id, answer, options FROM content_questions WHERE id = 7951").get();
const o7951 = JSON.parse(q7951.options);
console.log('  opts:', o7951, 'answer:', q7951.answer, '→ 정답:', o7951[Number(q7951.answer)]);
// 학생이 2번째 보기(0-based idx1="6/8", 오답)를 고름 → answerIndex:1 + text "6/8"
assert('오답: 2번째 보기(idx1 "6/8") → false', J(q7951, o7951[1], 1), false);
// 학생이 3번째 보기(0-based idx2="7/8", 정답)를 고름 → answerIndex:2 + text "7/8"
assert('정답: 3번째 보기(idx2 "7/8") → true', J(q7951, o7951[2], 2), true);
// 과거 버그 재현: 맨숫자 "2"(answerIndex 없음) → 0-based idx2 정답으로 단정 (1-based 우연일치 아님)
assert('맨숫자 "2"(answerIndex없음)=0-based idx2 → true', J(q7951, '2'), true);
assert('맨숫자 "1"(answerIndex없음)=0-based idx1 오답 → false', J(q7951, '1'), false);

// ───────────────────────────────────────────────────────────────
console.log('\n[1] 0-based DB 문항 — 보기 위치별 정/오 (answerIndex 사용)');
// answer="0" 문항: 1번째 보기가 정답
const qz = db.prepare("SELECT id, content_id, options, answer FROM content_questions WHERE answer='0' AND options IS NOT NULL AND options LIKE '[%' LIMIT 1").get();
const oz = JSON.parse(qz.options);
console.log('  Q' + qz.id, 'answer=0 opts=', oz, '정답=', oz[0]);
assert('1번째 보기(idx0) 정답 → true', J(qz, oz[0], 0), true);
assert('2번째 보기(idx1) 오답 → false', J(qz, oz[1], 1), false);
assert('마지막 보기 오답 → false', J(qz, oz[oz.length-1], oz.length-1), false);
assert('정답 텍스트 직접 입력 → true', J(qz, oz[0]), true);

// ───────────────────────────────────────────────────────────────
console.log('\n[2] 1-based DB 문항 — answer가 0-based 범위를 벗어나는 케이스 (Q228 answer="4")');
const q228 = db.prepare("SELECT id, answer, options FROM content_questions WHERE id=228").get();
if (q228) {
  const o228 = JSON.parse(q228.options);
  console.log('  Q228 answer=4 opts=', o228, '→ 정답(1-based pos4)=', o228[3]);
  assert('마지막 보기(idx3 "④√2") 정답 → true', J(q228, o228[3], 3), true);
  assert('1번째 보기(idx0) 오답 → false', J(q228, o228[0], 0), false);
  assert('중간 보기(idx2) 오답 → false', J(q228, o228[2], 2), false);
} else { console.log('  (Q228 없음, skip)'); }

// ───────────────────────────────────────────────────────────────
console.log('\n[3] 원숫자 prefix 문항 — Q7 (answer="3", opts=[①24,②25,③27,④29])');
const q7 = db.prepare("SELECT id, answer, options FROM content_questions WHERE id=7").get();
if (q7) {
  const o7 = JSON.parse(q7.options);
  const corr = sl.resolveCorrectAnswerText({ answer: q7.answer, options: q7.options });
  console.log('  resolveCorrectAnswerText →', corr);
  const ci = o7.indexOf(corr);
  assert('정답 보기 index 일치 → true', J(q7, corr, ci), true);
  // 정답이 아닌 다른 보기들은 오답
  for (let i = 0; i < o7.length; i++) {
    if (i === ci) continue;
    if (J(q7, o7[i], i)) { console.log('    (오판: idx' + i + ' "' + o7[i] + '"를 정답처리)'); }
  }
  const wrongIdx = o7.findIndex((_, i) => i !== ci);
  assert('다른 보기(idx' + wrongIdx + ') 오답 → false', J(q7, o7[wrongIdx], wrongIdx), false);
} else { console.log('  (Q7 없음, skip)'); }

// ───────────────────────────────────────────────────────────────
console.log('\n[4] 단답형 텍스트 정답 정규화 (options 없음)');
const qText = { answer: '서울', options: null };
assert('정확 일치 → true', J(qText, '서울'), true);
assert('공백 허용 → true', J(qText, '서울 '), true);
assert('오답 → false', J(qText, '부산'), false);
const qFrac = { answer: '3/4', options: null };
assert('분수 동치 "0.75" → true', J(qFrac, '0.75'), true);
assert('분수 정확 "3/4" → true', J(qFrac, '3/4'), true);
assert('분수 오답 "1/4" → false', J(qFrac, '1/4'), false);

// ───────────────────────────────────────────────────────────────
console.log('\n[5] recordProblemAttempt E2E — 서버 재판정 (answerIndex 규약)');
const userId = 3;
const before = db.prepare('SELECT COUNT(*) c FROM problem_attempts WHERE user_id=?').get(userId);
const r1 = sl.recordProblemAttempt(userId, qz.content_id, {
  isCorrect: false, selectedAnswer: oz[0], answerIndex: 0, questionId: qz.id, timeTaken: 5, nodeId: null
});
assert('정답 보기 → 서버 correct=true', r1.correct, true);
assert('correctAnswer는 텍스트', r1.correctAnswer, oz[0]);
const r2 = sl.recordProblemAttempt(userId, qz.content_id, {
  isCorrect: true, selectedAnswer: oz[1], answerIndex: 1, questionId: qz.id, timeTaken: 5
});
assert('오답 보기 → 서버 correct=false(클라 거짓 무시)', r2.correct, false);
const r3 = sl.recordProblemAttempt(userId, qz.content_id, {
  isCorrect: true, selectedAnswer: '999', answerIndex: 999, questionId: qz.id, timeTaken: 5
});
assert('범위밖 → false', r3.correct, false);
db.prepare('DELETE FROM problem_attempts WHERE user_id=? AND id > ?').run(userId, before.c);

console.log('\n=================================');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
