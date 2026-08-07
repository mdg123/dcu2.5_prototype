// test/content-answer-exposure.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 보안 — 2026-08-07 감리 3차] 문항 **정답·해설이 학생 응답에 실려 나가던** 경로 전수 박제.
//
// ■ 실측 누출 (격리 서버 3420, student1 세션, 수정 전)
//     GET /api/lesson/2/29                → contents[1].questions[0].answer="1" + explanation
//     GET /api/lesson/2/79                → contents[0].questions[0].answer="2" + explanation
//     GET /api/contents/5, /3451          → content.questions[n].answer + explanation
//     GET /api/exam/2/:examId             → exam.answers(원본 JSON 컬럼)에 정답 전문
//                                           (questions[] 는 손으로 가렸는데 원본 컬럼은 안 가림)
//     GET /api/exam/my                    → 미응시 평가 96건분 정답+해설
//     GET /api/exam/:c/:e/export-results  → 학생이 200 (정답지 + 반 전원 답안)
//     GET /api/self-learn/map/nodes/:id   → problems[].answer + explanation
//     GET /api/self-learn/daily/:it/result→ 미이수인데 정답지 폴백 반환
//   화면에는 안 그려도 네트워크 탭/콘솔 한 줄이면 정답이 보였다.
//
// ■ 정책 (lib/strip-answers.js 가 유일한 판정 실체)
//     공개: admin / teacher / principal · 작성자 본인 · **제출 완료한 학생**
//     차단: 그 외(= 풀기 전 학생)
//   ⚠ "학생에겐 항상 숨김" 으로 뭉개면 **제출 후 해설(학습 기능)이 망가진다** → AE3 이 감시.
//   ⚠ 교사에게까지 숨기면 문항 편집·미리보기가 망가진다(과잉 차단) → AE2 가 감시.
//
// 불변식
//   INV-AE1  학생(풀기 전) 세션의 문항 제공 API 응답에 정답류 키가 **없다** (경로별 전수)
//   INV-AE2  교사·관리자 세션에는 **있다** (과잉 차단 방지 — 양성 대조군)
//   INV-AE3  제출 후 해설 경로는 **유지**된다 (서버 채점 응답 · 제출 완료 평가 상세)
//   INV-AE4  정답을 벗기는 판정이 **한 벌만** 존재한다 (lib/strip-answers.js 밖 사본 금지)
//
// 검증 방식: asset-access-guard.test.js 와 동일한 node:http + x-test-user 패턴
//   (실제 라우터·실제 미들웨어 mount → 게이트 코드가 그대로 실행된다)
// DB 격리: 실 DB → 임시 복사본. 픽스처도 복사본에만 넣는다(정본 무오염).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입
const express = require('express');
const session = require('express-session');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');
let server, baseUrl;

function uidOf(username) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r.id;
}
const ADMIN = uidOf('admin');
const T1 = uidOf('teacher1');
const S1 = uidOf('student1');

// ── 정답류 키 ────────────────────────────────────────────────────────────────
//   lib/strip-answers.js 의 ANSWER_FIELDS 와 같은 목록을 쓰되, 테스트는 **독립적으로**
//   재선언한다(구현이 목록을 지우면 테스트도 같이 눈이 머는 것을 막는다).
const ANSWER_KEYS = new Set([
  'answer', 'correct_answer', 'correctAnswer',
  'answer_index', 'answerIndex', 'correct_index', 'correctIndex',
  'explanation',
]);

/**
 * 응답 전체를 재귀 순회해 정답류 키가 "값 있게" 있는 경로를 모은다.
 * 문자열 컬럼(exams.answers 처럼 JSON 이 문자열로 담긴 것)도 파싱해 들어간다 —
 * 실제 누출이 정확히 그 형태였다(questions 는 가렸는데 answers 원문은 안 가림).
 */
function findAnswerLeaks(node, p = '', hits = [], depth = 0) {
  if (node == null || depth > 14) return hits;
  if (typeof node === 'string') {
    const t = node.trim();
    if ((t.startsWith('[') || t.startsWith('{')) && t.length < 200000) {
      try { findAnswerLeaks(JSON.parse(t), p + '(json)', hits, depth + 1); } catch (_) { /* JSON 아님 */ }
    }
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => findAnswerLeaks(v, `${p}[${i}]`, hits, depth + 1));
    return hits;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const np = p ? `${p}.${k}` : k;
      if (ANSWER_KEYS.has(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object') {
        hits.push(`${np}=${JSON.stringify(v).slice(0, 50)}`);
      }
      findAnswerLeaks(v, np, hits, depth + 1);
    }
  }
  return hits;
}

// ── 픽스처 (복사본에만) ──────────────────────────────────────────────────────
const SUF = '_AE_' + process.pid;

// student1 이 멤버인 클래스 + 그 클래스 개설자(owner)
const MEMBERSHIP = db.prepare(`
  SELECT cm.class_id AS classId,
         (SELECT user_id FROM class_members o WHERE o.class_id = cm.class_id AND o.role = 'owner' LIMIT 1) AS ownerId
  FROM class_members cm
  WHERE cm.user_id = ? AND cm.status = 'active' AND cm.role = 'member'
  LIMIT 1
`).get(S1);
assert.ok(MEMBERSHIP && MEMBERSHIP.classId, '픽스처 전제: student1 이 멤버인 클래스가 있어야 한다');
const CLASS_ID = MEMBERSHIP.classId;

// (1) 문항 콘텐츠 — 공개 승인본(학생 열람 가능)
const C_QUIZ = db.prepare(`
  INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
  VALUES (?, ?, '정답 비노출 회귀 픽스처', 'quiz', 1, 'approved', datetime('now'))
`).run(T1, '_정답노출_문항' + SUF).lastInsertRowid;

const Q_CHOICE = db.prepare(`
  INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
  VALUES (?, 1, '2 + 3 은?', 'multiple_choice', ?, '1', '2와 3을 더하면 5입니다.', 10)
`).run(C_QUIZ, JSON.stringify(['4', '5', '6', '7'])).lastInsertRowid;

const Q_SHORT = db.prepare(`
  INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
  VALUES (?, 2, '대한민국의 수도는?', 'short_answer', NULL, '서울', '대한민국의 수도는 서울입니다.', 10)
`).run(C_QUIZ).lastInsertRowid;

// (1-b) 채점 API 전용 문항 콘텐츠 — 객관식·주관식·서술형 3종
//   C_QUIZ 에 문항을 더하면 INV-AE1b(문항 2개 유지)가 깨지므로 **별도 콘텐츠**로 둔다.
const C_GRADE = db.prepare(`
  INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
  VALUES (?, ?, '채점 API 정답노출 회귀 픽스처', 'quiz', 1, 'approved', datetime('now'))
`).run(T1, '_채점정답노출_문항' + SUF).lastInsertRowid;

const G_CHOICE = db.prepare(`
  INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
  VALUES (?, 1, '3 + 4 는?', 'multiple_choice', ?, '2', '3과 4를 더하면 7입니다.', 10)
`).run(C_GRADE, JSON.stringify(['5', '6', '7', '8'])).lastInsertRowid;

const G_SHORT = db.prepare(`
  INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
  VALUES (?, 2, '일본의 수도는?', 'short_answer', NULL, '도쿄', '일본의 수도는 도쿄입니다.', 10)
`).run(C_GRADE).lastInsertRowid;

const G_ESSAY = db.prepare(`
  INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
  VALUES (?, 3, '봄에 대해 서술하시오.', 'essay', NULL, '봄은 따뜻하다', '따뜻함·새싹을 서술하면 정답 처리합니다.', 10)
`).run(C_GRADE).lastInsertRowid;

// (2) 수업 + 콘텐츠 연결
const LESSON_ID = db.prepare(`
  INSERT INTO lessons (class_id, teacher_id, title, description, created_at)
  VALUES (?, ?, ?, '정답 비노출 회귀 픽스처', datetime('now'))
`).run(CLASS_ID, MEMBERSHIP.ownerId || T1, '_정답노출_수업' + SUF).lastInsertRowid;
db.prepare('INSERT INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?, ?, 0)').run(LESSON_ID, C_QUIZ);

// (3) 평가 2개 — 미제출용 / 제출완료용
const EXAM_ANSWERS = JSON.stringify([
  { number: 1, text: '1/4 + 2/4 = ?', type: 'choice', options: ['1/4', '2/4', '3/4', '4/4'], answer: '3/4', explanation: '분자끼리 더한다', points: 50 },
  { number: 2, text: '수도는?', type: 'short', answer: '서울', explanation: '서울이다', points: 50 },
]);
function insertExam(title) {
  const id = `_ae_${process.pid}_${title}`;
  db.prepare(`
    INSERT INTO exams (id, class_id, title, description, answers, question_count, status, start_mode, owner_id, created_at)
    VALUES (?, ?, ?, '', ?, 2, 'active', 'direct', ?, datetime('now'))
  `).run(id, CLASS_ID, '_정답노출_평가' + title + SUF, EXAM_ANSWERS, T1);
  return id;
}
const EXAM_OPEN = insertExam('open');       // student1 미제출
const EXAM_DONE = insertExam('done');       // student1 제출 완료
db.prepare(`
  INSERT INTO exam_students (exam_id, user_id, status, answers, score, submitted_at, joined_at)
  VALUES (?, ?, 'submitted', ?, 50, datetime('now'), datetime('now'))
`).run(EXAM_DONE, S1, JSON.stringify(['3/4', '부산']));

// (4) 학습맵 노드 + 문항 연결
const NODE_ID = 'AE_NODE_' + process.pid;
db.prepare(`
  INSERT INTO learning_map_nodes (node_id, subject, grade_level, grade, unit_name, lesson_name, node_level)
  VALUES (?, '수학', '초', 4, '정답노출 픽스처 단원', '정답노출 픽스처 차시', 3)
`).run(NODE_ID);
db.prepare('INSERT INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, 0)')
  .run(NODE_ID, C_QUIZ, 'problem');

// (5) 오늘의 학습 — 미이수 항목
const DL_SET = db.prepare(`
  INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, is_active)
  VALUES (?, ?, ?, date('now'), 1)
`).run(CLASS_ID, T1, '_정답노출_오늘의학습' + SUF).lastInsertRowid;
const DL_ITEM = db.prepare(`
  INSERT INTO daily_learning_items (set_id, source_type, content_id, item_title, sort_order)
  VALUES (?, 'content', ?, ?, 0)
`).run(DL_SET, C_QUIZ, '_정답노출_항목' + SUF).lastInsertRowid;

// ── 앱 구성 ──────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/contents', require('../routes/content'));
  app.use('/api/lesson', require('../routes/lesson'));
  app.use('/api/exam', require('../routes/exam'));
  app.use('/api/self-learn', require('../routes/self-learn'));
  return app;
}

function call(method, p, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(baseUrl + p, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) { /* 비 JSON */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = buildApp().listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

// ── 문항 제공 경로 정의 (학생이 "풀기 전" 받는 응답) ─────────────────────────
function studentPaths() {
  return [
    { label: '콘텐츠 상세',          p: `/api/contents/${C_QUIZ}` },
    { label: '수업꾸러미 상세',      p: `/api/lesson/${CLASS_ID}/${LESSON_ID}` },
    { label: '평가 상세(미제출)',    p: `/api/exam/${CLASS_ID}/${EXAM_OPEN}` },
    { label: '내 평가 목록',         p: '/api/exam/my' },
    { label: 'AI학습맵 노드 상세',   p: `/api/self-learn/map/nodes/${NODE_ID}` },
    { label: '오늘의학습 결과(미이수)', p: `/api/self-learn/daily/${DL_ITEM}/result` },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// INV-AE1 — 학생(풀기 전) 응답에 정답류 키가 없다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-AE1: 학생 세션의 문항 제공 API 응답에 정답·해설이 없다 (전수)', async () => {
  for (const t of studentPaths()) {
    const r = await call('GET', t.p, S1);
    assert.equal(r.status, 200, `${t.label}(${t.p}) 는 학생에게 200 이어야 한다 — 과차단 금지`);
    // /api/exam/my 는 학생이 이미 제출한 평가도 함께 담는다(제출 후 공개는 정상).
    // 여기서는 **미제출** 픽스처 평가만 골라 검사한다.
    let target = r.json;
    if (t.p === '/api/exam/my') {
      target = (r.json.exams || []).filter(e => e.id === EXAM_OPEN);
      assert.equal(target.length, 1, '미제출 픽스처 평가가 내 평가 목록에 있어야 한다');
    }
    const leaks = findAnswerLeaks(target);
    assert.deepEqual(leaks, [], `${t.label} 정답 누출: ${leaks.join(' | ')}`);
  }
});

test('INV-AE1b: 정답만 벗기고 문항 자체는 남는다 (과잉 차단·게이트 파괴 방지)', async () => {
  // 수업꾸러미 FE 는 questions 배열 **길이**로 "문항 플레이어를 띄울지" 를 판정한다.
  // 정답을 벗긴다고 questions 를 통째로 지우면 학생이 문제를 풀 수 없게 된다.
  const r = await call('GET', `/api/lesson/${CLASS_ID}/${LESSON_ID}`, S1);
  const c = (r.json.contents || []).find(x => x.id === C_QUIZ);
  assert.ok(c, '수업에 연결된 문항 콘텐츠가 응답에 있어야 한다');
  assert.equal(c.questions.length, 2, '문항 개수는 그대로 유지되어야 한다');
  assert.ok(c.questions[0].question_text, '문제 지문은 남아 있어야 한다');
  assert.deepEqual(c.questions[0].options, ['4', '5', '6', '7'], '보기는 남아 있어야 한다');

  const cd = await call('GET', `/api/contents/${C_QUIZ}`, S1);
  assert.equal(cd.json.content.questions.length, 2, '콘텐츠 상세 문항 개수 유지');
  assert.ok(cd.json.content.questions[0].id, '채점 키(question id)는 남아야 한다');
});

test('INV-AE1c: 평가 결과 내보내기는 학생에게 403 (정답지 + 반 전원 답안)', async () => {
  const r = await call('GET', `/api/exam/${CLASS_ID}/${EXAM_OPEN}/export-results`, S1);
  assert.equal(r.status, 403, '학생은 결과 내보내기를 받을 수 없어야 한다');
  const t = await call('GET', `/api/exam/${CLASS_ID}/${EXAM_OPEN}/export-results`, T1);
  assert.equal(t.status, 200, '교사(개설자)는 그대로 200 — 과차단 금지');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-AE2 — 교사·관리자에게는 정답이 그대로 (과잉 차단 방지 양성 대조군)
// ══════════════════════════════════════════════════════════════════════════════
test('INV-AE2: 교사·관리자 세션에는 정답·해설이 그대로 내려온다', async () => {
  for (const who of [{ id: T1, name: 'teacher1' }, { id: ADMIN, name: 'admin' }]) {
    const c = await call('GET', `/api/contents/${C_QUIZ}`, who.id);
    assert.equal(c.status, 200);
    assert.equal(c.json.content.questions[0].answer, '1', `${who.name}: 콘텐츠 상세 정답이 보여야 한다`);
    assert.ok(c.json.content.questions[0].explanation, `${who.name}: 콘텐츠 상세 해설이 보여야 한다`);

    const l = await call('GET', `/api/lesson/${CLASS_ID}/${LESSON_ID}`, who.id);
    const lc = (l.json.contents || []).find(x => x.id === C_QUIZ);
    assert.equal(lc.questions[0].answer, '1', `${who.name}: 수업꾸러미 문항 정답이 보여야 한다`);

    const e = await call('GET', `/api/exam/${CLASS_ID}/${EXAM_OPEN}`, who.id);
    assert.equal(e.json.exam.questions[0].answer, '3/4', `${who.name}: 평가 문항 정답이 보여야 한다`);
    assert.ok(String(e.json.exam.answers).includes('"answer"'), `${who.name}: 평가 원본 answers 도 그대로여야 한다`);

    const n = await call('GET', `/api/self-learn/map/nodes/${NODE_ID}`, who.id);
    const prob = (n.json.problems || [])[0];
    assert.ok(prob, `${who.name}: 학습맵 노드에 문항이 있어야 한다`);
    assert.equal(prob.answer, '1', `${who.name}: 학습맵 문항 정답이 보여야 한다`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-AE3 — 제출 후 해설 표시는 유지된다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-AE3a: 서버 채점(POST /contents/:id/grade)이 정답·해설을 돌려준다', async () => {
  // 1번 정답('1' = 두 번째 보기), 2번 오답
  const r = await call('POST', `/api/contents/${C_QUIZ}/grade`, S1, {
    answers: [
      { questionId: Q_CHOICE, value: 1 },
      { questionId: Q_SHORT, value: '부산' },
    ],
  });
  assert.equal(r.status, 200, '학생도 자기 풀이는 채점받을 수 있어야 한다');
  const byId = new Map(r.json.results.map(x => [x.questionId, x]));
  assert.equal(byId.get(Q_CHOICE).correct, true, '객관식 정답 판정');
  assert.equal(byId.get(Q_SHORT).correct, false, '주관식 오답 판정');
  // ★ 제출 후에는 정답·해설이 와야 한다 — 이게 없으면 학습 기능(해설)이 망가진 것이다.
  assert.equal(byId.get(Q_CHOICE).answer, '1', '채점 결과에 정답이 포함되어야 한다');
  assert.ok(byId.get(Q_CHOICE).explanation, '채점 결과에 해설이 포함되어야 한다');
  assert.equal(r.json.scorePercent, 50, '점수 계산(10/20 = 50%)');
});

// ── INV-AE3a 의 사각 (2026-08-07 감리 4차) ───────────────────────────────────
//   AE3a 는 "정답을 제출했을 때" 만 봤다. **빈 답안을 안 봤다.**
//   그래서 아래 구멍이 10/10 통과 상태로 살아 있었다:
//     POST /api/contents/196/grade  {"answers":[]}  → 200 + 정답·해설 전문
//   미응답·서술형에도 정답을 붙여 돌려주었기 때문이다. attempt 는 안 남아 흔적조차 없다.
//   → 채점이 **끝난 문항만** 공개된다는 것을 문항 단위로 박제한다.

/** 정답·해설 키를 실제로 들고 있는 결과만 고른다. */
function withKeys(results) {
  return (results || []).filter(r => r.answer !== undefined || r.explanation !== undefined);
}

test('INV-AE3e: 빈 답안 채점은 정답·해설을 한 건도 돌려주지 않는다 (정답지 수집 차단)', async () => {
  for (const body of [{ answers: [] }, {}, { answers: [{ questionId: G_CHOICE, value: '' }, { questionId: G_SHORT, value: null }] }]) {
    const r = await call('POST', `/api/contents/${C_GRADE}/grade`, S1, body);
    assert.equal(r.status, 200, '빈 답안도 채점 자체는 200 (과차단 금지)');
    assert.equal(r.json.results.length, 3, '문항 수는 그대로 내려온다');
    const leaks = findAnswerLeaks(r.json);
    assert.deepEqual(leaks, [],
      `빈 답안(${JSON.stringify(body)}) 채점 응답에 정답 누출: ${leaks.join(' | ')}`);
    assert.deepEqual(withKeys(r.json.results).map(x => x.questionId), [],
      '미응답 문항에는 answer·explanation 키 자체가 없어야 한다');
  }
});

test('INV-AE3f: 부분 제출은 **답한 문항만** 정답·해설을 준다 (전부 공개 금지)', async () => {
  // 3문항 중 1번만 답한다 → 1번만 공개, 2·3번은 비공개.
  const r = await call('POST', `/api/contents/${C_GRADE}/grade`, S1, {
    answers: [{ questionId: G_CHOICE, value: 2 }],
  });
  assert.equal(r.status, 200);
  const byId = new Map(r.json.results.map(x => [x.questionId, x]));

  // 답한 문항 — 채점 결과와 해설이 보인다(학습 기능이 살아 있어야 한다)
  assert.equal(byId.get(G_CHOICE).correct, true, '답한 문항은 정상 채점된다');
  assert.equal(byId.get(G_CHOICE).answer, '2', '답한 문항에는 정답이 온다');
  assert.ok(byId.get(G_CHOICE).explanation, '답한 문항에는 해설이 온다');

  // 답하지 않은 문항 — 정답·해설 키가 없다
  for (const qid of [G_SHORT, G_ESSAY]) {
    const x = byId.get(qid);
    assert.equal(x.correct, null, '미응답/보류는 판정 없음');
    assert.equal('answer' in x, false, `미응답 문항 ${qid} 에 정답이 붙으면 안 된다`);
    assert.equal('explanation' in x, false, `미응답 문항 ${qid} 에 해설이 붙으면 안 된다`);
  }
  assert.deepEqual(withKeys(r.json.results).map(x => x.questionId), [G_CHOICE],
    '정답·해설이 붙은 문항은 실제로 채점된 1건뿐이어야 한다');
});

test('INV-AE3g: 서술형(자동채점 보류)에는 답을 써도 모범답안·해설이 가지 않는다', async () => {
  const r = await call('POST', `/api/contents/${C_GRADE}/grade`, S1, {
    answers: [
      { questionId: G_CHOICE, value: 2 },
      { questionId: G_SHORT, value: '도쿄' },
      { questionId: G_ESSAY, value: '봄은 따뜻하고 새싹이 돋습니다.' },
    ],
  });
  const byId = new Map(r.json.results.map(x => [x.questionId, x]));
  assert.equal(byId.get(G_ESSAY).correct, null, '서술형은 자동채점 보류');
  assert.equal('answer' in byId.get(G_ESSAY), false, '서술형 모범답안은 채점 보류 상태에서 공개하지 않는다');
  assert.equal('explanation' in byId.get(G_ESSAY), false, '서술형 해설도 공개하지 않는다');
  // 자동채점된 두 문항은 정상 공개 — 과잉 차단 방지
  assert.equal(byId.get(G_CHOICE).answer, '2');
  assert.equal(byId.get(G_SHORT).answer, '도쿄');
  assert.ok(byId.get(G_SHORT).explanation);
});

test('INV-AE3h: 교사·관리자는 빈 답안 채점에서도 정답·해설을 본다 (과잉 차단 방지 대조군)', async () => {
  for (const who of [{ id: T1, name: 'teacher1' }, { id: ADMIN, name: 'admin' }]) {
    const r = await call('POST', `/api/contents/${C_GRADE}/grade`, who.id, { answers: [] });
    assert.equal(r.status, 200);
    const byId = new Map(r.json.results.map(x => [x.questionId, x]));
    assert.equal(byId.get(G_CHOICE).answer, '2', `${who.name}: 문항 검수를 위해 정답이 보여야 한다`);
    assert.ok(byId.get(G_ESSAY).explanation, `${who.name}: 서술형 채점 기준도 보여야 한다`);
  }
});

test('INV-AE3b: 서버 채점은 관대한 주관식 비교(공백·대소문자 무시)를 유지한다', async () => {
  const r = await call('POST', `/api/contents/${C_QUIZ}/grade`, S1, {
    answers: [{ questionId: Q_SHORT, value: ' 서 울 ' }],
  });
  const s = r.json.results.find(x => x.questionId === Q_SHORT);
  assert.equal(s.correct, true, '공백을 무시한 주관식 정답 판정이 유지되어야 한다');
});

test('INV-AE3c: 제출 완료한 평가는 정답·해설이 다시 보인다 (복습)', async () => {
  const r = await call('GET', `/api/exam/${CLASS_ID}/${EXAM_DONE}`, S1);
  assert.equal(r.status, 200);
  assert.equal(r.json.exam.questions[0].answer, '3/4', '제출 후에는 정답이 공개되어야 한다');
  assert.ok(r.json.exam.questions[0].explanation, '제출 후에는 해설이 공개되어야 한다');
});

test('INV-AE3d: 이수한 오늘의 학습 결과에는 정답지가 유지된다', async () => {
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, completed_at, correct_count, total_questions)
    VALUES (?, ?, ?, 'completed', datetime('now'), 1, 2)
    ON CONFLICT(user_id, item_id) DO UPDATE SET status='completed', completed_at=datetime('now')
  `).run(S1, DL_ITEM, DL_SET);
  const r = await call('GET', `/api/self-learn/daily/${DL_ITEM}/result`, S1);
  assert.equal(r.status, 200);
  const q = (r.json.questions || []).find(x => x.id === Q_CHOICE);
  assert.ok(q, '이수 후 결과에 문항이 있어야 한다');
  assert.equal(q.answer, '1', '이수 후에는 정답이 보여야 한다');
  assert.ok(q.explanation, '이수 후에는 해설이 보여야 한다');
  // 원상복구 — 다른 테스트(미이수 케이스)에 영향 주지 않도록
  db.prepare('DELETE FROM daily_learning_progress WHERE user_id = ? AND item_id = ?').run(S1, DL_ITEM);
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-AE4 — 소스 락: 정답을 벗기는 판정이 한 벌만 존재한다
// ══════════════════════════════════════════════════════════════════════════════
//   이 프로젝트의 반복 결함이 "정본 옆에 판정 사본" 이다. 실제로 routes/exam.js 가
//   `{...q, answer: undefined}` 를 손으로 두 군데 적어 두었고, 한 곳은 explanation 을
//   빼먹고 두 곳 모두 원본 answers 컬럼을 놓쳤다. 사본을 만들면 반드시 어긋난다.
const SSOT_REL = 'lib/strip-answers.js';
const SCAN_DIRS = ['routes', 'db', 'lib'];

/** 주석을 제거한다 — 설명 주석에 적힌 옛 코드 예시는 판정 사본이 아니다. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 파일 소스에서 "손으로 적은 정답 제거 판정" 을 찾는다. */
function scanHandWrittenStrip(source, rel) {
  const code = stripComments(source);
  const hits = [];
  const F = 'answer|explanation|correct_answer|correctAnswer|answer_index|answerIndex|correct_index|correctIndex';
  // (a) `{ ...q, answer: undefined }` 형태
  const reUndef = new RegExp(`\\b(${F})\\s*:\\s*undefined`, 'g');
  // (b) `delete x.answer` / `delete x.y.explanation`
  const reDelDot = new RegExp(`\\bdelete\\s+[\\w$]+(?:\\.[\\w$]+)*\\.(${F})\\b`, 'g');
  // (c) `delete x['answer']`
  const reDelIdx = new RegExp(`\\bdelete\\s+[\\w$]+(?:\\.[\\w$]+)*\\s*\\[\\s*['"\`](${F})['"\`]\\s*\\]`, 'g');
  for (const [re, why] of [[reUndef, 'answer: undefined 형태'], [reDelDot, 'delete x.answer 형태'], [reDelIdx, "delete x['answer'] 형태"]]) {
    let m;
    while ((m = re.exec(code))) {
      const line = code.slice(0, m.index).split('\n').length;
      hits.push(`${rel}:${line} — ${why} (${m[0].trim()})`);
    }
  }
  // (d) 정답류 키 목록을 통째로 재선언 (예: const KEYS = ['answer', ..., 'explanation'])
  const reList = /\[[^\]\n]*['"`]answer['"`][^\]\n]*['"`]explanation['"`][^\]\n]*\]|\[[^\]\n]*['"`]explanation['"`][^\]\n]*['"`]answer['"`][^\]\n]*\]/g;
  let lm;
  while ((lm = reList.exec(code))) {
    const line = code.slice(0, lm.index).split('\n').length;
    hits.push(`${rel}:${line} — 정답류 키 목록 사본 (${lm[0].slice(0, 60)})`);
  }
  return hits;
}

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('INV-AE4: 정답 제거 판정이 lib/strip-answers.js 한 벌만 존재한다 (사본 금지)', () => {
  const ssot = path.join(ROOT, SSOT_REL);
  assert.ok(fs.existsSync(ssot), `${SSOT_REL} 이 실체로 존재해야 한다`);

  const violations = [];
  for (const d of SCAN_DIRS) {
    for (const f of walkJs(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (rel === SSOT_REL) continue;
      violations.push(...scanHandWrittenStrip(fs.readFileSync(f, 'utf8'), rel));
    }
  }
  assert.deepEqual(violations, [],
    `정답 제거 판정 사본 발견 — lib/strip-answers.js 를 호출하도록 고칠 것:\n  ${violations.join('\n  ')}`);
});

test('INV-AE4b: 스캐너가 실제로 사본을 잡는다 (역주입 자가검증)', () => {
  // 스캐너가 아무것도 못 잡는 "눈먼 락" 이 되는 것을 막는다.
  const cases = [
    'const safe = questions.map(q => ({ ...q, answer: undefined }));',
    'delete out.explanation;',
    "delete payload['answer'];",
    "const KEYS = ['answer', 'correct_answer', 'explanation'];",
  ];
  for (const c of cases) {
    assert.ok(scanHandWrittenStrip(c, 'x.js').length > 0, `스캐너가 못 잡음: ${c}`);
  }
  // 주석/정상 코드는 잡지 않는다(오탐 방지)
  assert.deepEqual(scanHandWrittenStrip('// 예전엔 { ...q, answer: undefined } 였다', 'x.js'), [],
    '주석 안의 옛 코드 예시는 위반이 아니다');
  assert.deepEqual(scanHandWrittenStrip("const q = db.prepare('SELECT answer, explanation FROM content_questions').get(id);", 'x.js'), [],
    '서버 내부 채점용 SELECT 는 위반이 아니다');
});

// ── 픽스처 정리 (임시 복사본이라 필수는 아니지만 명시적으로) ─────────────────
after(() => {
  try {
    db.prepare('DELETE FROM node_contents WHERE node_id = ?').run(NODE_ID);
    db.prepare('DELETE FROM learning_map_nodes WHERE node_id = ?').run(NODE_ID);
    db.prepare('DELETE FROM daily_learning_items WHERE set_id = ?').run(DL_SET);
    db.prepare('DELETE FROM daily_learning_sets WHERE id = ?').run(DL_SET);
    db.prepare('DELETE FROM exam_students WHERE exam_id IN (?, ?)').run(EXAM_OPEN, EXAM_DONE);
    db.prepare('DELETE FROM exams WHERE id IN (?, ?)').run(EXAM_OPEN, EXAM_DONE);
    db.prepare('DELETE FROM lesson_contents WHERE lesson_id = ?').run(LESSON_ID);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(LESSON_ID);
    db.prepare('DELETE FROM content_questions WHERE content_id IN (?, ?)').run(C_QUIZ, C_GRADE);
    db.prepare('DELETE FROM contents WHERE id IN (?, ?)').run(C_QUIZ, C_GRADE);
  } catch (_) { /* 임시 DB 라 실패해도 무해 */ }
});
