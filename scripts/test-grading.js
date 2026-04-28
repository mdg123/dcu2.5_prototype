// Unit test for the judgeQuestionAnswer / recordProblemAttempt fix (C-2)
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const sl = require('../db/self-learn-extended');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

let pass = 0, fail = 0;
function assert(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, '— got', got, 'want', want); }
}

// Smoke test: pick a question with options + 0-based answer
const q1 = db.prepare("SELECT id, content_id, options, answer FROM content_questions WHERE answer = '0' AND options IS NOT NULL LIMIT 1").get();
console.log('Test question:', q1);
const opts1 = JSON.parse(q1.options);
const correctText = opts1[Number(q1.answer)];

console.log('\n[1] judgeQuestionAnswer covers 0-based / 1-based / text');
const qObj = { answer: q1.answer, options: q1.options };
assert('0-based index match', sl.judgeQuestionAnswer(qObj, '0'), true);
assert('1-based index match', sl.judgeQuestionAnswer(qObj, '1'), true);
assert('option text match', sl.judgeQuestionAnswer(qObj, correctText), true);
assert('wrong index', sl.judgeQuestionAnswer(qObj, '2'), false);
assert('empty', sl.judgeQuestionAnswer(qObj, ''), false);

// Question with answer="3" (0-based → opts[3])
const q2 = db.prepare("SELECT id, options, answer FROM content_questions WHERE answer = '3' AND options IS NOT NULL LIMIT 1").get();
const opts2 = JSON.parse(q2.options);
const qObj2 = { answer: q2.answer, options: q2.options };
console.log('\n[2] answer="3" question opts:', opts2, 'correct text:', opts2[3]);
assert('0-based "3"', sl.judgeQuestionAnswer(qObj2, '3'), true);
assert('1-based "4"', sl.judgeQuestionAnswer(qObj2, '4'), true);
assert('option text', sl.judgeQuestionAnswer(qObj2, opts2[3]), true);
assert('1-based "1" wrong', sl.judgeQuestionAnswer(qObj2, '1'), false);

// Test text answers
console.log('\n[3] Text-form answer ("서울")');
const qText = { answer: '서울', options: '["서울","부산","대구","인천"]' };
assert('exact text', sl.judgeQuestionAnswer(qText, '서울'), true);
assert('whitespace tolerant', sl.judgeQuestionAnswer(qText, '서울 '), true);

console.log('\n[4] resolveCorrectAnswerText');
assert('0-based → option text', sl.resolveCorrectAnswerText(qObj2), opts2[3]);
assert('text answer passthrough', sl.resolveCorrectAnswerText(qText), '서울');

// E2E test on recordProblemAttempt — pick a real question, submit 1-based index, expect is_correct=1
console.log('\n[5] recordProblemAttempt E2E (no DB writes verification by re-read)');
const userId = 3; // student1
const beforeRow = db.prepare('SELECT COUNT(*) c FROM problem_attempts WHERE user_id = ?').get(userId);
const result = sl.recordProblemAttempt(userId, q1.content_id, {
  isCorrect: false,                  // client says false
  selectedAnswer: '1',                // 1-based index pointing at opts[0] = correct
  questionId: q1.id,
  timeTaken: 5,
  nodeId: null
});
console.log('  result:', { correct: result.correct, correctAnswer: result.correctAnswer, expl: !!result.explanation });
assert('server overrides client false → true (1-based)', result.correct, true);
assert('correctAnswer is text not index', result.correctAnswer, opts1[Number(q1.answer)]);

// Also verify with option text input
const result2 = sl.recordProblemAttempt(userId, q1.content_id, {
  isCorrect: false,
  selectedAnswer: correctText,
  questionId: q1.id,
  timeTaken: 5
});
assert('server accepts option text as correct', result2.correct, true);

// Wrong answer
const result3 = sl.recordProblemAttempt(userId, q1.content_id, {
  isCorrect: true,                   // client says true (lying)
  selectedAnswer: '999',
  questionId: q1.id,
  timeTaken: 5
});
assert('server rejects bogus answer despite client isCorrect=true', result3.correct, false);

// Cleanup test rows
db.prepare('DELETE FROM problem_attempts WHERE user_id = ? AND id > ?').run(userId, beforeRow.c);

console.log('\n=================================');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
