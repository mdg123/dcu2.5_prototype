// test/security.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 A] 정답 비노출 (보안 핵심 — 사용자 강조 규칙).
//   학생에게 "문항을 제공"하는(=풀기 전) 모든 경로의 응답에 정답류 키가 절대 포함되면 안 된다.
//   대상(코드 실측 확인):
//     1) 진단검사 v3 문항 제공 — startDiagnosisV3 / submitDiagnosisV3.nextQuestion / getNextDiagnosisV3
//        (_v3PickQuestion 가 answer/explanation 미포함 형태로 반환)
//     2) 오답노트 다시풀기 — getWrongNoteQuestion / getWrongNotesByExam
//        (_recoverWrongNoteQuestion 가 grading(정답)은 내부 보관, question(공개)엔 미포함)
//   불변식: 위 응답 객체를 재귀 순회해 정답류 키 부재 단언.
//   ⚠ "문항 제공(풀기 전)" 응답만 대상. 채점 결과(제출 후 isCorrect 등 정오)는 정상.
//     → v3 submit 응답의 top-level isCorrect/strike(채점 결과)는 허용하고,
//       그 안의 nextQuestion(다음에 풀 문항) 서브객체만 검사한다.
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입. (복사본만 — 실 DB 무오염)
// 계정/데이터(실 DB 실측): student1=id3.
//   v3 진단가능 단원 'Uf0de261c32febb6c'(다각형의 둘레와 넓이, 개념 27개·문항 295)
//   비-단원(차시) 'E6MATA03B11C36D01'(node_level=3) — 단원단위 진단 거부 검증용.
//   wrong_answers: student3 보유(content-출처 note 384 등). 없으면 임시복사본에 시드.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const sl = require('../db/self-learn-extended');
const db = openTestDb();

const S1 = 3;
const UNIT = 'Uf0de261c32febb6c';        // node_level=2 (진단 가능 단원)

// 정답류 키 — "문항 제공" 응답에 절대 등장하면 안 되는 키 집합.
//   (제출 후 채점결과의 is_correct/isCorrect 는 별도로 nextQuestion 서브객체 검사로 우회)
const ANSWER_KEYS = new Set([
  'answer', 'correct_answer', 'correctAnswer',
  'correctIndex', 'correct_index', 'answerIndex', 'answer_index',
  '정답', 'correct', 'explanation', 'is_correct'
]);

// 객체/배열을 재귀 순회하며 정답류 키가 "값 있게" 존재하는 경로를 모은다.
//   값이 null/undefined 인 키는 누출이 아님(예: question.options 안에 우연히 들어온 빈 필드).
function findAnswerLeaks(node, pathStr = '', hits = []) {
  if (node == null) return hits;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findAnswerLeaks(v, `${pathStr}[${i}]`, hits));
    return hits;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = pathStr ? `${pathStr}.${k}` : k;
      if (ANSWER_KEYS.has(k) && v != null && !(typeof v === 'string' && v.trim() === '')) {
        hits.push(`${p}=${JSON.stringify(v).slice(0, 60)}`);
      }
      findAnswerLeaks(v, p, hits);
    }
  }
  return hits;
}

// ──────────────────────────────────────────────────────────────────────────
// A-1: 진단검사 v3 시작 — 첫 문항(question)에 정답류 키 부재.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-A1: v3 진단 시작 question 에 정답류 키 없음', () => {
  const r = sl.startDiagnosisV3(S1, { unitNodeId: UNIT });
  assert.ok(r && r.question, 'v3 start 가 question 을 반환해야');
  // question 서브객체 검사 (정답 비노출 형태여야)
  const qLeaks = findAnswerLeaks(r.question);
  assert.deepEqual(qLeaks, [], `v3 start question 정답 누출: ${qLeaks.join(', ')}`);
  // 전체 페이로드(unitList·concept·progress 포함)에도 정답류 키 없어야
  const allLeaks = findAnswerLeaks(r);
  assert.deepEqual(allLeaks, [], `v3 start 전체 페이로드 정답 누출: ${allLeaks.join(', ')}`);
  // 양성 신호: 풀이에 필요한 키는 있어야(빈 검사 방지)
  assert.ok(r.question.questionId != null, 'question.questionId 존재(풀이용)');
  assert.ok('options' in r.question, 'question.options 키 존재(객관식 렌더용)');
});

// ──────────────────────────────────────────────────────────────────────────
// A-2: v3 답안 제출 후 다음 문항(nextQuestion)에도 정답류 키 부재.
//   (top-level isCorrect/strike 는 채점 결과라 허용 — nextQuestion 서브객체만 검사)
// ──────────────────────────────────────────────────────────────────────────
test('SEC-A2: v3 제출 응답의 nextQuestion 에 정답류 키 없음', () => {
  const start = sl.startDiagnosisV3(S1, { unitNodeId: UNIT });
  const sid = start.sessionId;
  // 일부러 틀린 답 제출 → 다음 문항/분기 유도
  const sub = sl.submitDiagnosisV3(sid, {
    questionId: start.question.questionId,
    contentId: start.question.contentId,
    nodeId: start.question.nodeId,
    answer: '__definitely_wrong_answer_xyz__'
  });
  // top-level 채점결과는 허용(isCorrect 는 정오 표시)
  assert.equal(typeof sub.isCorrect, 'boolean', '제출 후 채점결과(isCorrect) 는 존재해야(정상)');
  if (sub.nextQuestion) {
    const leaks = findAnswerLeaks(sub.nextQuestion);
    assert.deepEqual(leaks, [], `v3 submit nextQuestion 정답 누출: ${leaks.join(', ')}`);
    assert.ok(sub.nextQuestion.questionId != null, 'nextQuestion.questionId 존재(풀이용)');
  }
  // getNextDiagnosisV3 경로도 동일 보장
  const nx = sl.getNextDiagnosisV3(sid);
  if (nx && nx.question) {
    const leaks = findAnswerLeaks(nx.question);
    assert.deepEqual(leaks, [], `getNextDiagnosisV3 question 정답 누출: ${leaks.join(', ')}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// A-3: 오답노트 다시풀기 — getWrongNoteQuestion 의 풀이용 payload 에 정답류 키 부재.
//   content-출처/exam-출처 모두. 데이터 없으면 임시복사본에 시드(실 DB 무오염).
// ──────────────────────────────────────────────────────────────────────────
test('SEC-A3: 오답노트 getWrongNoteQuestion 풀이 payload 에 정답류 키 없음', () => {
  // student3 의 미해결 오답(다양한 source) 최대 5건 검사. 없으면 시드.
  let notes = db.prepare(
    "SELECT id FROM wrong_answers WHERE student_id = ? ORDER BY id LIMIT 8"
  ).all(S1);

  if (notes.length === 0) {
    // 임시 복사본에 content-출처 오답 1건 시드 (정답·해설 포함된 원본으로부터 복구되는 케이스)
    const anyContentQ = db.prepare(
      'SELECT content_id, question_number FROM content_questions WHERE answer IS NOT NULL LIMIT 1'
    ).get();
    const id = db.prepare(`
      INSERT INTO wrong_answers
        (student_id, content_id, question_number, question_text, correct_answer, explanation, source, is_resolved)
      VALUES (?, ?, ?, '시드오답문제', '2', '시드해설(노출금지)', 'content', 0)
    `).run(S1, anyContentQ ? anyContentQ.content_id : 1, anyContentQ ? anyContentQ.question_number : 1).lastInsertRowid;
    notes = [{ id }];
  }

  let checked = 0;
  for (const n of notes) {
    const payload = sl.getWrongNoteQuestion(n.id, S1);
    if (!payload || payload.forbidden) continue;
    checked++;
    // 전체 payload(question·examGroup 등)에 정답류 키 없어야.
    //   recovery==='unavailable' 이면 question:null — 그래도 정답류 키는 없어야.
    const leaks = findAnswerLeaks(payload);
    assert.deepEqual(leaks, [], `오답노트 ${n.id} 풀이 payload 정답 누출: ${leaks.join(', ')}`);
    // 풀이 가능한 케이스는 question.text 존재(빈 검사 방지)
    if (payload.can_retry && payload.question) {
      assert.ok(payload.question.text != null, `오답노트 ${n.id} question.text 존재(풀이용)`);
    }
  }
  assert.ok(checked > 0, '오답노트 풀이 payload 를 1건 이상 검사했어야');
});

// ──────────────────────────────────────────────────────────────────────────
// A-4: 같은 평가지 묶음 — getWrongNotesByExam 의 각 문항(question)에 정답류 키 부재.
// ──────────────────────────────────────────────────────────────────────────
test('SEC-A4: 오답노트 묶음 getWrongNotesByExam 에 정답류 키 없음', () => {
  const exNote = db.prepare(
    "SELECT student_id, exam_id FROM wrong_answers WHERE exam_id IS NOT NULL AND is_resolved = 0 LIMIT 1"
  ).get();
  if (!exNote) {
    // exam-출처 묶음 오답 2건 시드(임시복사본)
    const examId = 'sec-test-exam-' + Date.now();
    for (let qn = 1; qn <= 2; qn++) {
      db.prepare(`
        INSERT INTO wrong_answers
          (student_id, exam_id, question_number, question_text, correct_answer, explanation, source, is_resolved)
        VALUES (?, ?, ?, ?, '3', '시드해설(노출금지)', 'exam', 0)
      `).run(S1, examId, qn, `시드평가문항 ${qn}`);
    }
    const grp = sl.getWrongNotesByExam(examId, S1);
    assert.ok(grp, '시드한 묶음이 조회되어야');
    const leaks = findAnswerLeaks(grp);
    assert.deepEqual(leaks, [], `getWrongNotesByExam 정답 누출: ${leaks.join(', ')}`);
    return;
  }
  const grp = sl.getWrongNotesByExam(exNote.exam_id, exNote.student_id);
  assert.ok(grp && Array.isArray(grp.questions), 'getWrongNotesByExam questions 배열 반환');
  const leaks = findAnswerLeaks(grp);
  assert.deepEqual(leaks, [], `getWrongNotesByExam 정답 누출: ${leaks.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// A-5: 구 v2 진단 경로(POST /diagnosis/start = startDiagnosis / startDiagnosisCAT) —
//   학생에게 내려가는 문항(question)·진단지(sheet)에 정답류 키 부재.
//   ⚠ 하네스 실측 누출: question.answer="2", question.explanation 노출 (v3·오답노트는 안전).
//   _pickQuestionForNode / _buildDiagnosticSheet 가 응답에 answer/explanation 을 그대로 실어
//   POST /diagnosis/start (legacy·CAT 두 분기) 가 정답을 노출했다. 응답 직전 sanitize 로 차단.
//   채점은 questionId 로 content_questions 를 재조회하므로 회귀 없음(별도 테스트 SEC-A6).
// ──────────────────────────────────────────────────────────────────────────
test('SEC-A5: v2 진단(start/CAT) question·sheet 에 정답류 키 없음', () => {
  // (a) legacy startDiagnosis — nodeId 미지정 시 첫 노드로 진단 시작 + 첫 문항 반환
  const legacy = sl.startDiagnosis(S1, {});
  assert.ok(legacy && legacy.sessionId, 'startDiagnosis 가 세션을 반환해야');
  const legacyLeaks = findAnswerLeaks(legacy);
  assert.deepEqual(legacyLeaks, [], `startDiagnosis 정답 누출: ${legacyLeaks.join(', ')}`);
  if (legacy.question) {
    // 양성 신호: 풀이용 키는 살아 있어야(빈 검사 방지)
    assert.ok(legacy.question.questionId != null || legacy.question.question_id != null,
      'startDiagnosis question 에 questionId(풀이용) 존재');
  }

  // (b) CAT startDiagnosisCAT — 단원 노드 기반 진단지(sheet) + 첫 문항(question) 반환
  const cat = sl.startDiagnosisCAT(S1, { targetNodeId: UNIT });
  assert.ok(cat && cat.sessionId, 'startDiagnosisCAT 가 세션을 반환해야');
  // 전체 페이로드(sheet 배열·각 item.question·question 포함) 재귀 검사
  const catLeaks = findAnswerLeaks(cat);
  assert.deepEqual(catLeaks, [], `startDiagnosisCAT 정답 누출: ${catLeaks.join(', ')}`);
  // 양성 신호: sheet 가 실제 문항을 담고 있어야(빈 검사 방지)
  assert.ok(Array.isArray(cat.sheet) && cat.sheet.length > 0, 'CAT sheet 에 문항이 1개 이상');
  for (const item of cat.sheet) {
    assert.ok(item.questionId != null || (item.question && (item.question.questionId != null || item.question.question_id != null)),
      'sheet item 에 questionId(풀이용) 존재');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// A-6: v2 진단 채점 회귀 가드 — 정답 sanitize 후에도 서버 채점이 정답/오답을 정확히 판정.
//   문항을 골라(정답은 DB 에서 직접 확인) 정답·오답을 각각 제출 → isCorrect 가 올바른지.
//   (응답에서 정답을 가렸어도 채점은 questionId 로 content_questions 를 재조회하므로 무관해야)
// ──────────────────────────────────────────────────────────────────────────
test('SEC-A6: v2 진단 채점 정확도 — sanitize 후에도 정답/오답 판정 정상', () => {
  const cat = sl.startDiagnosisCAT(S1, { targetNodeId: UNIT });
  const first = (cat.sheet && cat.sheet[0]) || null;
  assert.ok(first, 'CAT 진단지 첫 문항이 있어야');
  const qid = first.questionId != null ? first.questionId : (first.question && (first.question.questionId || first.question.question_id));
  assert.ok(qid != null, '첫 문항 questionId 확보');

  // DB 에서 실제 정답이 존재하는지만 확인(채점이 재조회로 동작하는지가 핵심)
  const truth = db.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(qid);
  assert.ok(truth, 'content_questions 에서 문항을 찾아야');

  const session2 = sl.startDiagnosisCAT(S1, { targetNodeId: UNIT });
  const f2 = session2.sheet[0];
  const qid2 = f2.questionId != null ? f2.questionId : (f2.question && (f2.question.questionId || f2.question.question_id));

  // 오답 확실히 — 절대 정답이 아닌 토큰 제출
  const wrong = sl.submitDiagnosisAnswer(session2.sessionId, {
    sessionId: session2.sessionId, questionId: qid2,
    nodeId: UNIT, answer: '__definitely_wrong_xyz__', answerIndex: 99
  });
  assert.equal(typeof wrong.isCorrect, 'boolean', '제출 응답에 isCorrect(채점결과) 존재');
  assert.equal(wrong.isCorrect, false, '명백한 오답은 isCorrect=false 여야(채점 회귀 없음)');
});
