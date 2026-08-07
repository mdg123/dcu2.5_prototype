// test/self-learn-attempt-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 보안 — 2026-08-07 감리 5차] **자기주도학습 제출 경로가 콘텐츠 권한 검사를 건너뛰던**
// 우회로 전수 박제.
//
// ■ 배경 — 앞 라운드가 닫은 문 옆에 남아 있던 통로
//   감리 3·4차가 `GET /api/contents/:id` · `POST /api/contents/:id/grade` 등
//   "콘텐츠 경로"의 정답 누출을 전부 닫았다(test/content-answer-exposure.test.js).
//   그런데 형제 엔드포인트인 자기주도학습 제출 경로는 게이트가 통째로 없었다.
//
// ■ 실측 누출 (격리 서버 3480 · student1 세션 · 수정 전)
//     POST /api/self-learn/problem-attempt      {contentId:193, questionId:217}
//       → 200 { correctAnswer:"56", explanation:"7 × 8 = 56 입니다." }
//     POST /api/self-learn/problem-attempt      {contentId:34(draft)}
//       → 200 { correctAnswer:"10720", explanation:"7258+3462=10720" }
//     POST /api/self-learn/contents/193/attempt → 200 (같은 누출, 별칭 경로)
//     POST /api/contents/193/attempts           → 200 (열람 403 인 콘텐츠에 기록 생성)
//   ※ 193·194 는 비공개(is_public=0), 34 는 초안(draft). 셋 다 teacher1 소유.
//     같은 학생이 `POST /api/contents/193/grade` 에서는 403 이었다 — 즉 **판정이 있는 문과
//     판정이 없는 문이 나란히 있었다.**
//
//   그리고 게이트를 라우터에 달아도 남는 두 번째 우회로:
//     POST /api/self-learn/problem-attempt {contentId:5(열람가능), questionId:217(193의 문항)}
//       → 200 { correctAnswer:"56", … }
//     게이트가 보는 키(contentId)와 정답을 꺼내는 키(questionId)가 갈라져 있었다.
//     → recordProblemAttempt 의 문항 조회를 `AND content_id = ?` 로 스코프한다.
//
//   세 번째(다른 부류 — GET, 중첩):
//     GET /api/self-learn/map/nodes/:id?withFallbackProblems=1
//       → problems[].questions[].answer / explanation
//     stripAnswers 는 **배열 원소의 최상위 키만** 지웠고 폴백 문항은 한 겹 안쪽에 있었다.
//     → lib/strip-answers.js 의 _scrubQuestion 이 중첩 questions 까지 재귀한다.
//
// ■ 정책 (판정 사본 금지 — 이 프로젝트의 반복 결함)
//     콘텐츠 접근  : lib/auth/can-view-content.js  canViewContent  (routes/content.js guardContent 와 동일)
//     정답 공개여부: lib/strip-answers.js           canRevealAnswers/stripAnswers
//   제출 계열은 위 두 실체를 **호출만** 한다.
//
// ⚠ 과잉 차단이 유일한 위험이다 — 학생이 계속 공부할 수 있어야 한다.
//   INV-SA2/SA3 이 그 감시자다. 정본 스냅샷 실측으로도 확인했다:
//     학습맵 노출대상 표본 500/500 통과 · 오늘의학습 항목×멤버 30/30 통과.
//
// 불변식
//   INV-SA1  비공개·초안·타인 소유 콘텐츠로는 제출이 **차단**되고 정답·해설이 안 나간다
//   INV-SA2  정상 접근 가능한 콘텐츠는 **여전히** 풀고 채점받고 해설을 본다 (과잉 차단 방지)
//   INV-SA3  오답노트 자동 수집이 유지된다
//   INV-SA4  제출 계열이 콘텐츠 접근 판정을 **재사용**한다 (사본 금지 소스 락)
//   INV-SA5  ①에서 찾은 나머지 우회로(questionId 교차주입 · 폴백 중첩문항)도 차단된다
//
// 검증 방식: content-answer-exposure.test.js 와 동일한 node:http + x-test-user 패턴
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
const T1 = uidOf('teacher1');
const S1 = uidOf('student1');

// ── 정답류 키 탐지 ───────────────────────────────────────────────────────────
//   lib/strip-answers.js 의 ANSWER_FIELDS 와 같은 목록을 **독립 재선언**한다
//   (구현이 목록을 지우면 테스트도 같이 눈이 머는 것을 막는다).
const ANSWER_KEYS = new Set([
  'answer', 'correct_answer', 'correctAnswer',
  'answer_index', 'answerIndex', 'correct_index', 'correctIndex',
  'explanation',
]);

/** 응답 전체를 재귀 순회해 정답류 키가 "값 있게" 있는 경로를 모은다(문자열 JSON 포함). */
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
const SUF = '_SA_' + process.pid;
const OPTS = JSON.stringify(['54', '56', '58', '64']);

/** 문항 1개짜리 콘텐츠를 만든다. @returns {{cid:number, qid:number}} */
function makeQuizContent(title, { isPublic, status, creator }) {
  const cid = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
    VALUES (?, ?, '자기주도 제출 게이트 회귀 픽스처', 'quiz', ?, ?, datetime('now'))
  `).run(creator, title + SUF, isPublic, status).lastInsertRowid;
  const qid = db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
    VALUES (?, 1, '7 × 8 = ?', 'multiple_choice', ?, '1', '7 × 8 = 56 입니다.', 10)
  `).run(cid, OPTS).lastInsertRowid;
  return { cid, qid };
}

// (1) 학생이 정상적으로 풀 수 있는 콘텐츠 — 공개 승인본
const OPEN = makeQuizContent('_제출게이트_공개문항', { isPublic: 1, status: 'approved', creator: T1 });
// (2) 비공개(정본의 193·194 와 같은 형태) — teacher1 소유, 학생 열람 403
const PRIVATE = makeQuizContent('_제출게이트_비공개문항', { isPublic: 0, status: 'approved', creator: T1 });
// (3) 초안(정본의 34 와 같은 형태)
const DRAFT = makeQuizContent('_제출게이트_초안문항', { isPublic: 0, status: 'draft', creator: T1 });
// (4) 반려본 — 목록에서 빠지고 상세도 403 인 부류
const REJECTED = makeQuizContent('_제출게이트_반려문항', { isPublic: 1, status: 'rejected', creator: T1 });

// (5) 폴백 문항 검사용 노드 2종.
//   NODE_EMPTY 는 node_contents 매핑이 **없어야** withFallbackProblems=1 이 폴백 경로를 탄다.
//   폴백 1(closure 자손 노드 매핑)이 **결정적으로** 걸리도록 자손 노드에 콘텐츠를 매단다.
//   공개본 1 + 비공개본 1 을 함께 매달아 "폴백이 공개 승인본만 고르는가"를 확정적으로 본다.
//   (전체 풀 랜덤 폴백 4 에 기대면 비공개가 9,591 중 18건이라 우연히 통과하는 눈먼 테스트가 된다)
const NODE_EMPTY = 'SA_NODE_' + process.pid;
const NODE_CHILD = 'SA_CHILD_' + process.pid;
const insNode = db.prepare(`
  INSERT INTO learning_map_nodes (node_id, parent_node_id, subject, grade_level, grade, unit_name, lesson_name, node_level)
  VALUES (?, ?, '수학', '초', 4, '제출게이트 픽스처 단원', ?, ?)
`);
insNode.run(NODE_EMPTY, null, '제출게이트 빈 차시', 2);
insNode.run(NODE_CHILD, NODE_EMPTY, '제출게이트 자손 차시', 3);
db.prepare('INSERT INTO curriculum_node_descendants (ancestor_id, descendant_id, depth_diff) VALUES (?, ?, 1)')
  .run(NODE_EMPTY, NODE_CHILD);
const insNC = db.prepare('INSERT INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)');
insNC.run(NODE_CHILD, OPEN.cid, 'problem', 0);
insNC.run(NODE_CHILD, PRIVATE.cid, 'problem', 1);   // ← 폴백이 이걸 집어오면 안 된다

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
  app.use('/api/self-learn', require('../routes/self-learn'));
  return app;
}

function call(method, p, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body !== undefined) {
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

/** 제출 계열 경로 3종 — 하나만 막으면 나머지가 우회로가 된다. */
function submitPaths(fx) {
  return [
    { label: 'self-learn 문제시도(별칭)', method: 'POST', p: '/api/self-learn/problem-attempt', body: { contentId: fx.cid, questionId: fx.qid, answerIndex: 0 } },
    { label: 'self-learn 문제시도(경로)', method: 'POST', p: `/api/self-learn/contents/${fx.cid}/attempt`, body: { questionId: fx.qid, answer: 0 } },
    { label: '콘텐츠 풀이기록', method: 'POST', p: `/api/contents/${fx.cid}/attempts`, body: { total_questions: 1, correct_count: 1, score_percent: 100 } },
    { label: '콘텐츠 서버채점', method: 'POST', p: `/api/contents/${fx.cid}/grade`, body: { answers: [{ questionId: fx.qid, value: '1' }] } },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// INV-SA1 — 비공개·초안·반려 콘텐츠로는 제출이 차단되고 정답이 안 나간다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SA1: 학생은 비공개·초안·반려 콘텐츠로 제출할 수 없고 정답·해설도 못 받는다', async () => {
  for (const [name, fx] of [['비공개', PRIVATE], ['초안', DRAFT], ['반려', REJECTED]]) {
    for (const t of submitPaths(fx)) {
      const r = await call(t.method, t.p, S1, t.body);
      assert.equal(r.status, 403,
        `${name} 콘텐츠(${fx.cid}) — ${t.label}(${t.p}) 은 학생에게 403 이어야 한다. 실제 ${r.status}: ${r.raw.slice(0, 200)}`);
      const leaks = findAnswerLeaks(r.json);
      assert.deepEqual(leaks, [], `${name} — ${t.label} 정답 누출: ${leaks.join(' | ')}`);
    }
  }
});

test('INV-SA1b: 차단된 제출은 DB 에 시도 기록도 남기지 않는다', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM problem_attempts WHERE user_id = ? AND content_id = ?').get(S1, PRIVATE.cid).n;
  await call('POST', '/api/self-learn/problem-attempt', S1, { contentId: PRIVATE.cid, questionId: PRIVATE.qid, answerIndex: 0 });
  const after = db.prepare('SELECT COUNT(*) n FROM problem_attempts WHERE user_id = ? AND content_id = ?').get(S1, PRIVATE.cid).n;
  assert.equal(after, before, '차단된 콘텐츠에 시도 기록이 생기면 안 된다');
});

test('INV-SA1c: 작성자 교사는 자기 비공개 콘텐츠로 그대로 제출할 수 있다 (과잉 차단 방지)', async () => {
  const r = await call('POST', '/api/self-learn/problem-attempt', T1, { contentId: PRIVATE.cid, questionId: PRIVATE.qid, answerIndex: 1 });
  assert.equal(r.status, 200, `작성자에게까지 막으면 문항 검수가 불가능하다: ${r.raw.slice(0, 200)}`);
  assert.equal(r.json.correct, true, '작성자 채점도 정상 동작해야 한다');
  assert.ok(r.json.explanation, '작성자에게는 해설이 보여야 한다');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SA2 — 과잉 차단 방지: 학생은 정상 콘텐츠를 여전히 풀고 해설을 본다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SA2: 학생이 접근 가능한 콘텐츠는 풀고 채점받고 해설까지 그대로 본다', async () => {
  // 오답 제출 — 서버가 오답 판정 + 정답/해설 회신(제출을 마쳤으므로 공개가 정책이다)
  const wrong = await call('POST', '/api/self-learn/problem-attempt', S1, {
    contentId: OPEN.cid, questionId: OPEN.qid, answerIndex: 3,
  });
  assert.equal(wrong.status, 200, `정상 콘텐츠 제출이 막히면 학습이 멈춘다: ${wrong.raw.slice(0, 200)}`);
  assert.equal(wrong.json.correct, false, '틀린 보기는 오답으로 판정되어야 한다');
  assert.equal(wrong.json.correctAnswer, '56', '제출 후 정답 텍스트가 보여야 한다');
  assert.equal(wrong.json.explanation, '7 × 8 = 56 입니다.', '제출 후 해설이 보여야 한다');

  // 정답 제출
  const right = await call('POST', '/api/self-learn/problem-attempt', S1, {
    contentId: OPEN.cid, questionId: OPEN.qid, answerIndex: 1,
  });
  assert.equal(right.status, 200);
  assert.equal(right.json.correct, true, '정답 보기는 정답으로 판정되어야 한다');
  assert.ok(right.json.explanation, '정답이어도 해설은 보여야 한다');

  // 별칭 경로(/contents/:id/attempt)도 동일하게 살아 있어야 한다
  const alias = await call('POST', `/api/self-learn/contents/${OPEN.cid}/attempt`, S1, {
    questionId: OPEN.qid, answer: '56',
  });
  assert.equal(alias.status, 200, '별칭 경로까지 막으면 회귀다');
  assert.equal(alias.json.correct, true);

  // 콘텐츠 풀이기록·서버채점도 그대로
  const rec = await call('POST', `/api/contents/${OPEN.cid}/attempts`, S1, { total_questions: 1, correct_count: 1, score_percent: 100 });
  assert.equal(rec.status, 200, '풀이 기록 저장이 막히면 통계가 끊긴다');
  const grade = await call('POST', `/api/contents/${OPEN.cid}/grade`, S1, { answers: [{ questionId: OPEN.qid, value: '1' }] });
  assert.equal(grade.status, 200);
  assert.equal(grade.json.results[0].correct, true);
  assert.ok(grade.json.results[0].explanation, '채점한 문항의 해설은 그대로 보여야 한다');
});

test('INV-SA2b: 시도 기록이 실제로 적재된다 (게이트가 기록까지 삼키지 않는다)', () => {
  const n = db.prepare('SELECT COUNT(*) n FROM problem_attempts WHERE user_id = ? AND content_id = ?').get(S1, OPEN.cid).n;
  assert.ok(n >= 3, `정상 콘텐츠 시도 기록이 남아야 한다 (실제 ${n}건)`);
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SA3 — 오답노트 자동 수집 유지
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SA3: 정상 콘텐츠 오답은 오답노트에 자동 수집된다', async () => {
  const note = db.prepare('SELECT id, question_text, correct_answer, attempt_count FROM wrong_answers WHERE student_id = ? AND content_id = ?').get(S1, OPEN.cid);
  assert.ok(note, 'INV-SA2 의 오답 제출이 오답노트를 만들었어야 한다');
  assert.match(String(note.question_text), /7 × 8/, '원본 문항 지문이 보존되어야 한다');
  assert.ok(note.correct_answer != null && note.correct_answer !== '', '오답노트에는 정답이 담긴다(복습 목적)');

  // 차단된 콘텐츠는 오답노트도 만들지 않는다
  const bad = db.prepare('SELECT COUNT(*) n FROM wrong_answers WHERE student_id = ? AND content_id IN (?, ?, ?)')
    .get(S1, PRIVATE.cid, DRAFT.cid, REJECTED.cid).n;
  assert.equal(bad, 0, '차단된 콘텐츠가 오답노트를 통해 정답을 흘리면 안 된다');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SA4 — 소스 락: 제출 계열이 콘텐츠 접근 판정을 재사용한다 (사본 금지)
// ══════════════════════════════════════════════════════════════════════════════
const ACCESS_SSOT = 'lib/auth/can-view-content.js';
/** 제출 계열이 있는 파일 — 여기서 콘텐츠 접근 판정을 **손으로** 다시 적으면 안 된다. */
const SUBMIT_ROUTES = ['routes/self-learn.js', 'routes/content.js'];

/**
 * 주석 줄을 걸러낸다 — 설명 주석에 적힌 SQL 예시는 판정 사본이 아니다.
 *
 * ⚠ 블록 주석 정규식(`/\*[\s\S]*?\*\/`)으로 통째 제거하지 않는다.
 *   routes/self-learn.js 에 그 정규식을 적용하면 코드 본문 수천 줄이 함께 사라져
 *   **스캐너가 눈이 먼다**(실측: 폴백 필터 줄이 통째로 증발). 소스 락이 조용히
 *   무력화되는 것이 이 프로젝트의 반복 사고이므로 줄 단위로만 거른다
 *   (test/_source-lock.js 의 방식과 같다).
 */
function codeLines(src) {
  return src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  });
}

/** 원본 줄번호를 유지한 채 주석 줄만 비운다(위반 위치를 정확히 보고하기 위함). */
function blankComments(src) {
  return src.split(/\r?\n/).map((l) => {
    const t = l.trim();
    return (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) ? '' : l;
  });
}

/**
 * "콘텐츠 열람 권한을 손으로 판정하는 코드" 스캐너.
 *   · `status === 'approved'` / `status == "approved"`  (JS 손 판정)
 *   · `is_public` 과 `status` 를 한 줄에서 함께 보는 SQL 조건
 *  면제: `access-ok` 토큰(사유 병기). 목록 검색 SQL 처럼 정당한 필터가 있을 수 있다.
 */
function scanHandWrittenAccess(source, rel) {
  const hits = [];
  blankComments(source).forEach((line, i) => {
    if (/access-ok/.test(line)) return;
    if (/status\s*===?\s*['"`]approved['"`]/.test(line)) {
      hits.push(`${rel}:${i + 1} — status==='approved' 손 판정 (${line.trim().slice(0, 80)})`);
      return;
    }
    if (/is_public\s*=\s*1/.test(line) && /status\s*=\s*'approved'/.test(line)) {
      hits.push(`${rel}:${i + 1} — is_public+status 열람 판정 사본 (${line.trim().slice(0, 80)})`);
    }
  });
  return hits;
}

test('INV-SA4: 제출 계열이 canViewContent 를 재사용한다 (열람 판정 사본 금지)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, ACCESS_SSOT)), `${ACCESS_SSOT} 이 실체로 존재해야 한다`);

  const violations = [];
  for (const rel of SUBMIT_ROUTES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /require\(['"]\.\.\/lib\/auth\/can-view-content['"]\)/,
      `${rel} 은 열람 판정 SSOT(${ACCESS_SSOT})를 require 해야 한다 — 손 판정 금지`);
    violations.push(...scanHandWrittenAccess(src, rel));
  }
  assert.deepEqual(violations, [],
    `콘텐츠 열람 판정 사본 발견 — canViewContent 를 호출하도록 고칠 것:\n  ${violations.join('\n  ')}`);
});

test('INV-SA4b: 제출 핸들러가 실제로 게이트를 통과시킨다 (호출 누락 감시)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/self-learn.js'), 'utf8');
  const code = codeLines(src).join('\n');
  const guardCalls = (code.match(/guardAttemptContent\s*\(/g) || []).length;
  // 정의 1 + problem-attempt 1 + contents/:id/attempt 1
  assert.ok(guardCalls >= 3,
    `problem-attempt · contents/:id/attempt 두 경로 모두 콘텐츠 게이트를 호출해야 한다 (발견 ${guardCalls}회)`);
  const qGuardCalls = (code.match(/guardQuestionBelongsToContent\s*\(/g) || []).length;
  assert.ok(qGuardCalls >= 3,
    `두 경로 모두 questionId 교차 주입 검사를 호출해야 한다 (발견 ${qGuardCalls}회)`);
  // 폴백 문항 필터도 SSOT 를 쓴다
  assert.match(code, /fallback\.filter\(p => canViewContent\(/,
    '학습맵 폴백 문항은 canViewContent 로 걸러야 한다');

  const contentSrc = codeLines(fs.readFileSync(path.join(ROOT, 'routes/content.js'), 'utf8')).join('\n');
  const attemptsBlock = contentSrc.slice(contentSrc.indexOf("router.post('/:id/attempts'"));
  assert.match(attemptsBlock.slice(0, 600), /guardContent\(req, res\)/,
    'POST /api/contents/:id/attempts 도 guardContent 를 거쳐야 한다');
});

test('INV-SA4c: 스캐너가 실제로 사본을 잡는다 (역주입 자가검증)', () => {
  const cases = [
    "if (c.status === 'approved' && c.is_public) return true;",
    "const rows = db.prepare(`SELECT * FROM contents WHERE is_public = 1 AND status = 'approved'`).all();",
  ];
  for (const c of cases) {
    assert.ok(scanHandWrittenAccess(c, 'x.js').length > 0, `스캐너가 못 잡음: ${c}`);
  }
  assert.deepEqual(scanHandWrittenAccess("// 예전엔 status === 'approved' 를 손으로 봤다", 'x.js'), [],
    '주석 안의 옛 코드 예시는 위반이 아니다');
  assert.deepEqual(scanHandWrittenAccess("const s = row.status; // access-ok: 표시용 라벨", 'x.js'), [],
    '면제 토큰이 있는 줄은 위반이 아니다');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SA5 — 나머지 우회로
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SA5a: questionId 교차 주입 — 열람 가능한 콘텐츠에 남의 문항 id 를 얹으면 거부된다', async () => {
  for (const [label, p, body] of [
    ['별칭 경로', '/api/self-learn/problem-attempt', { contentId: OPEN.cid, questionId: PRIVATE.qid, answerIndex: 0 }],
    ['경로 파라미터', `/api/self-learn/contents/${OPEN.cid}/attempt`, { questionId: PRIVATE.qid, answer: 0 }],
  ]) {
    const r = await call('POST', p, S1, body);
    assert.equal(r.status, 400, `${label}: 다른 콘텐츠의 문항 id 는 거부돼야 한다 (실제 ${r.status}: ${r.raw.slice(0, 160)})`);
    const leaks = findAnswerLeaks(r.json);
    assert.deepEqual(leaks, [], `${label}: 교차 주입 응답 정답 누출: ${leaks.join(' | ')}`);
  }
  // (오답노트 경유 우회는 지문이 구별되는 전용 픽스처로 INV-SA5a2 가 검사한다)
});

test('INV-SA5a1: 같은 콘텐츠의 문항 id 는 그대로 통과한다 (과잉 차단 방지)', async () => {
  const r = await call('POST', '/api/self-learn/problem-attempt', S1, {
    contentId: OPEN.cid, questionId: OPEN.qid, answerIndex: 1,
  });
  assert.equal(r.status, 200, '정상 조합까지 막으면 학습이 멈춘다');
  assert.equal(r.json.correct, true);
});

test('INV-SA5a1b: 존재하지 않는 questionId 는 기존처럼 흡수된다 (호환 유지)', async () => {
  const r = await call('POST', '/api/self-learn/problem-attempt', S1, {
    contentId: OPEN.cid, questionId: 999999999, answerIndex: 1,
  });
  assert.equal(r.status, 200, '없는 문항 id 로 400 을 내면 구 클라이언트가 깨진다');
});

test('INV-SA5a2: 교차 주입 questionId 는 오답노트에도 남의 문항으로 적재되지 않는다', async () => {
  // 서로 다른 지문을 쓰는 전용 픽스처로 확인한다(위 픽스처는 지문이 같아 구별 불가).
  const other = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
    VALUES (?, ?, '교차주입 확인용', 'quiz', 0, 'approved', datetime('now'))
  `).run(T1, '_제출게이트_교차주입원본' + SUF).lastInsertRowid;
  const otherQ = db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
    VALUES (?, 1, '교차주입_전용_지문_ZZQ', 'multiple_choice', ?, '1', '교차주입_전용_해설_ZZQ', 10)
  `).run(other, OPTS).lastInsertRowid;

  const r = await call('POST', '/api/self-learn/problem-attempt', S1, {
    contentId: OPEN.cid, questionId: otherQ, answerIndex: 3,
  });
  assert.equal(r.status, 400, '교차 주입은 거부돼야 한다');
  const leaks = findAnswerLeaks(r.json);
  assert.deepEqual(leaks, [], `교차 주입 응답 정답 누출: ${leaks.join(' | ')}`);

  const polluted = db.prepare(
    "SELECT COUNT(*) n FROM wrong_answers WHERE student_id = ? AND (question_text LIKE '%ZZQ%' OR explanation LIKE '%ZZQ%')"
  ).get(S1).n;
  assert.equal(polluted, 0, '교차 주입된 문항이 오답노트로 흘러들면 안 된다');

  db.prepare('DELETE FROM content_questions WHERE content_id = ?').run(other);
  db.prepare('DELETE FROM contents WHERE id = ?').run(other);
});

test('INV-SA5b: 학습맵 폴백 문항의 **중첩** 정답(problems[].questions[])도 벗겨진다', async () => {
  const r = await call('GET', `/api/self-learn/map/nodes/${NODE_EMPTY}?withFallbackProblems=1`, S1);
  assert.equal(r.status, 200);
  const problems = r.json.problems || [];
  assert.ok(problems.length > 0, `폴백 문항이 실제로 채워져야 검사가 의미 있다 (실제 ${problems.length}개)`);
  assert.ok((problems[0].questions || []).length > 0, '문항 자체는 남아야 한다 — 지우면 학생이 못 푼다');
  assert.ok(problems[0].questions[0].question_text, '지문은 남아야 한다');
  const leaks = findAnswerLeaks(problems);
  assert.deepEqual(leaks, [], `폴백 문항 정답 누출: ${leaks.slice(0, 6).join(' | ')}`);
});

test('INV-SA5b2: 교사에게는 폴백 문항 정답이 그대로 (과잉 차단 방지 양성 대조군)', async () => {
  const r = await call('GET', `/api/self-learn/map/nodes/${NODE_EMPTY}?withFallbackProblems=1`, T1);
  assert.equal(r.status, 200);
  const leaks = findAnswerLeaks(r.json.problems || []);
  assert.ok(leaks.length > 0, '교사에게까지 가리면 문항 검수가 불가능하다(과잉 차단)');
});

test('INV-SA5c: 폴백 문항 풀은 공개 승인본만 고른다 (형제 차시에 비공개본을 심어 확인)', async () => {
  const r = await call('GET', `/api/self-learn/map/nodes/${NODE_EMPTY}?withFallbackProblems=1`, S1);
  const ids = (r.json.problems || []).map(p => p.content_id ?? p.id).filter(Boolean);
  assert.ok(ids.includes(OPEN.cid), `공개 승인본은 폴백에 포함돼야 한다 (과잉 차단 방지). 실제: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes(PRIVATE.cid), `비공개본이 폴백으로 노출됨: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes(DRAFT.cid) && !ids.includes(REJECTED.cid), '초안·반려본도 폴백에 없어야 한다');
});

test('INV-SA5d: SSOT(stripAnswers)가 중첩 questions 를 재귀적으로 벗긴다', () => {
  const { stripAnswers } = require('../lib/strip-answers');
  const src = [{
    id: 1, title: '폴백 문항', answer: 'top',
    questions: [{ id: 9, question_text: '지문', answer: '2', explanation: '해설', options: ['a', 'b'] }],
  }];
  const out = stripAnswers(src, { id: S1, role: 'student' });
  assert.equal(out[0].answer, undefined, '최상위 정답 제거');
  assert.equal(out[0].questions[0].answer, undefined, '중첩 정답 제거');
  assert.equal(out[0].questions[0].explanation, undefined, '중첩 해설 제거');
  assert.deepEqual(out[0].questions[0].options, ['a', 'b'], '보기는 남아야 한다');
  assert.equal(src[0].questions[0].answer, '2', '원본은 불변이어야 한다(서버 내부 채점 보호)');

  const asTeacher = stripAnswers(src, { id: T1, role: 'teacher' });
  assert.equal(asTeacher[0].questions[0].answer, '2', '교사에게는 그대로');
});

// ── 픽스처 정리 (임시 복사본이라 필수는 아니지만 명시적으로) ─────────────────
after(() => {
  try {
    const ids = [OPEN.cid, PRIVATE.cid, DRAFT.cid, REJECTED.cid];
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM wrong_answers WHERE content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM problem_attempts WHERE content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM content_questions WHERE content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM contents WHERE id IN (${ph})`).run(...ids);
    db.prepare('DELETE FROM node_contents WHERE node_id IN (?, ?)').run(NODE_CHILD, NODE_EMPTY);
    db.prepare('DELETE FROM curriculum_node_descendants WHERE ancestor_id = ?').run(NODE_EMPTY);
    db.prepare('DELETE FROM learning_map_nodes WHERE node_id IN (?, ?)').run(NODE_CHILD, NODE_EMPTY);
  } catch (_) { /* 임시 DB 라 실패해도 무해 */ }
});
