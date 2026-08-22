// test/content-access-self-grant.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P1-A 후속 — 2026-08-21] **학생이 스스로 "이용 근거"를 만들어 콘텐츠 게이트를 여는**
// 자기부여(self-grant) 우회 박제.
//
// ■ 배경 — 앞 라운드가 세운 벽, 그 옆에 남아 있던 두 개의 문
//   감리 5·6차가 제출 계열(problem-attempt·contents/:id/grade 등)에 canViewContent 게이트를
//   세웠다(test/self-learn-attempt-guard.test.js). 그런데 **게이트의 통과 조건 자체를
//   학생이 만들어 낼 수 있었다.**
//
//   lib/auth/can-view-content.js 의 이용 근거(usage grant) 5종 중 두 개는
//   **학생이 직접 쓸 수 있는 테이블**이다:
//       · content_collections  (보관함)   ← POST /api/contents/collection/:contentId
//       · problem_set_items    (문제집)   ← POST /api/self-learn/problem-sets/:id/items
//                                          POST /api/self-learn/problem-sets/default/add
//   이 쓰기 라우트에 열람 판정이 없어서 다음 순환이 성립했다 (격리 서버 3487 · student1 실측):
//       POST /api/contents/collection/193                 → 200   (근거 생성)
//       GET  /api/contents/193                            → 403 이던 것이 200
//       POST /api/self-learn/problem-attempt {193,217}     → correctAnswer:"56" · explanation
//   c193 은 teacher1 소유 · is_public=0 — 학생에게 열람 권한이 **없는** 콘텐츠다.
//
//   ■ 세 번째 문 — 더 나빴다: 정답지 통째 복사
//       POST /api/exam/import-from-content {contentId:193, classId:1}  → 200
//       GET  /api/exam/my
//         → answers:[{"question":"7 × 8 = ?","answer":"1","explanation":"7 × 8 = 56 입니다."}, …]
//     이 라우트는 requireAuth 뿐이라 **학생도** 호출할 수 있었고, db/cbt-extended.js
//     importFromContent 가 content_questions 를 answer·explanation 까지 exams.answers 로
//     복사하며 owner_id 를 호출자 자신으로 박는다. 그 뒤 stripExamAnswers 는 "작성자 본인이면
//     공개" 이므로 정답이 **정상적으로** 회신된다. 문항 단위도 아니고 **한 번에 전 문항**이다.
//     덤으로 classId 검증도 없어 남의 클래스에 평가를 심을 수 있었다.
//
// ■ 정책 (판정 사본 금지 — 이 프로젝트의 반복 결함)
//     콘텐츠 접근 : lib/auth/can-view-content.js  canViewContent
//                   (routes/content.js guardContent · routes/self-learn.js guardAttemptContent 가 호출)
//     평가 생성   : routes/exam.js requireClassMember + "개설자 또는 admin"
//                   (= 같은 행위인 POST /api/exam/:classId 와 **동일 규칙**)
//   근거를 만드는 쓰기도 **같은 문**을 통과해야 한다. 새 규칙을 옆에 적지 않는다.
//
// ⚠ 과잉 차단이 유일한 위험이다 — INV-SG3/SG5 가 그 감시자다.
//   실측(정본 스냅샷 사본): 공개 승인본 담기·수업 연결 비공개본 담기·오답노트 재풀이·
//   교사 자기 콘텐츠 가져오기·관리자 가져오기 전부 200 유지.
//
// 불변식
//   INV-SG1  열람 403 인 콘텐츠는 **보관함·문제집에 담을 수 없다**(근거 생성 차단)
//   INV-SG2  차단된 담기는 DB 에 근거 행을 남기지 않는다 (그래서 게이트가 열리지 않는다)
//   INV-SG3  정상 콘텐츠 담기는 그대로 200 (과잉 차단 방지)
//   INV-SG4  학생은 import-from-content 로 정답지를 복사할 수 없고, 교사도 열람 403 인
//            콘텐츠는 가져오지 못하며, 남의 클래스에 평가를 심지 못한다
//   INV-SG5  교사(개설자)·관리자의 정상 가져오기는 200 이고 정답이 정상 회신된다
//   INV-SG6  소스 락 — 세 라우트가 판정 SSOT 를 **호출**한다(사본 금지)
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
const AD = uidOf('admin');

// ── 정답류 키 탐지 (문자열 JSON 컬럼 안까지 재귀 — exams.answers 가 그 형태다) ────
const ANSWER_KEYS = new Set([
  'answer', 'correct_answer', 'correctAnswer',
  'answer_index', 'answerIndex', 'correct_index', 'correctIndex',
  'explanation',
]);
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
        hits.push(`${np}=${JSON.stringify(v).slice(0, 40)}`);
      }
      findAnswerLeaks(v, np, hits, depth + 1);
    }
  }
  return hits;
}

// ── 픽스처 (복사본에만) ──────────────────────────────────────────────────────
const SUF = '_SG_' + process.pid;
const OPTS = JSON.stringify(['54', '56', '58', '64']);

function makeQuizContent(title, { isPublic, status, creator }) {
  const cid = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
    VALUES (?, ?, '자기부여 우회 회귀 픽스처', 'quiz', ?, ?, datetime('now'))
  `).run(creator, title + SUF, isPublic, status).lastInsertRowid;
  const qid = db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
    VALUES (?, 1, '7 × 8 = ?', 'multiple_choice', ?, '1', '7 × 8 = 56 입니다.', 10)
  `).run(cid, OPTS).lastInsertRowid;
  return { cid, qid };
}

// (1) 학생이 정상적으로 담고 풀 수 있는 콘텐츠 — 공개 승인본
const OPEN = makeQuizContent('_자기부여_공개문항', { isPublic: 1, status: 'approved', creator: T1 });
// (2) 학생 열람 403 — 비공개(정본 193·194 와 같은 형태)
const PRIVATE = makeQuizContent('_자기부여_비공개문항', { isPublic: 0, status: 'draft', creator: T1 });
// (3) 학생 열람 403 — 반려본
const REJECTED = makeQuizContent('_자기부여_반려문항', { isPublic: 1, status: 'rejected', creator: T1 });

// (4) 클래스 2종 — 교사 소유(학생은 멤버) / 제3자 소유
function makeClass(name, ownerId, members) {
  const cid = db.prepare(`
    INSERT INTO classes (code, name, owner_id, status) VALUES (?, ?, ?, 'active')
  `).run('SG' + process.pid + '_' + name, name + SUF, ownerId).lastInsertRowid;
  const ins = db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, 'active')");
  for (const [uid, role] of members) ins.run(cid, uid, role);
  return cid;
}
const CLS_T1 = makeClass('교사반', T1, [[T1, 'owner'], [S1, 'member']]);
const CLS_OTHER = makeClass('제3자반', AD, [[AD, 'owner'], [T1, 'member']]);

// (5) 학생 소유 문제집 — 담기 대상
const PSET_S1 = db.prepare("INSERT INTO problem_sets (user_id, title) VALUES (?, ?)").run(S1, '자기부여 회귀 문제집' + SUF).lastInsertRowid;

// (6) 수업 연결로 **정당한** 이용 근거가 있는 비공개 콘텐츠 (과잉 차단 감시용)
const GRANTED = makeQuizContent('_자기부여_수업연결비공개', { isPublic: 0, status: 'approved', creator: T1 });
const LESSON_ID = db.prepare(`
  INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, ?, 'published')
`).run(CLS_T1, T1, '자기부여 회귀 수업' + SUF).lastInsertRowid;
db.prepare('INSERT INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?, ?, 0)').run(LESSON_ID, GRANTED.cid);

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
  app.use('/api/exam', require('../routes/exam'));
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

/** 이용 근거를 만드는 쓰기 3종 — 하나만 막으면 나머지가 우회로가 된다. */
function grantWrites(fx) {
  return [
    { label: '보관함 담기',        method: 'POST', p: `/api/contents/collection/${fx.cid}`, body: {} },
    { label: '문제집 자동담기',    method: 'POST', p: '/api/self-learn/problem-sets/default/add', body: { contentId: fx.cid } },
    { label: '문제집 담기(경로)',  method: 'POST', p: `/api/self-learn/problem-sets/${PSET_S1}/items`, body: { contentId: fx.cid } },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// INV-SG1 — 열람 403 인 콘텐츠는 근거 자체를 만들 수 없다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SG1: 학생은 열람 권한 없는 콘텐츠를 보관함·문제집에 담을 수 없다', async () => {
  for (const [name, fx] of [['비공개', PRIVATE], ['반려', REJECTED]]) {
    for (const t of grantWrites(fx)) {
      const r = await call(t.method, t.p, S1, t.body);
      assert.equal(r.status, 403,
        `${name} 콘텐츠(${fx.cid}) — ${t.label}(${t.p}) 은 학생에게 403 이어야 한다. 실제 ${r.status}: ${r.raw.slice(0, 200)}`);
      const leaks = findAnswerLeaks(r.json);
      assert.deepEqual(leaks, [], `${name} — ${t.label} 정답 누출: ${leaks.join(' | ')}`);
    }
  }
});

test('INV-SG2: 차단된 담기는 근거 행을 남기지 않고, 게이트도 열리지 않는다', async () => {
  // 담기를 세 경로 모두 시도한 **뒤에** 확인한다 (INV-SG1 이 이미 시도했다)
  const col = db.prepare('SELECT COUNT(*) n FROM content_collections WHERE user_id = ? AND content_id IN (?, ?)')
    .get(S1, PRIVATE.cid, REJECTED.cid).n;
  assert.equal(col, 0, '차단된 콘텐츠가 보관함 행으로 남으면 다음 요청에서 게이트가 열린다');

  const psi = db.prepare(`
    SELECT COUNT(*) n FROM problem_set_items pi
    JOIN problem_sets ps ON ps.id = pi.problem_set_id
    WHERE ps.user_id = ? AND pi.content_id IN (?, ?)
  `).get(S1, PRIVATE.cid, REJECTED.cid).n;
  assert.equal(psi, 0, '차단된 콘텐츠가 문제집 항목으로 남으면 다음 요청에서 게이트가 열린다');

  // 근거가 없으니 제출 계열도 여전히 닫혀 있어야 한다 (우회 순환의 두 번째 고리)
  const detail = await call('GET', `/api/contents/${PRIVATE.cid}`, S1);
  assert.equal(detail.status, 403, `담기 시도 후에도 상세는 403 이어야 한다: ${detail.raw.slice(0, 160)}`);
  const attempt = await call('POST', '/api/self-learn/problem-attempt', S1, {
    contentId: PRIVATE.cid, questionId: PRIVATE.qid, isCorrect: false, selectedAnswer: 'zzz',
  });
  assert.equal(attempt.status, 403, `담기 시도 후에도 제출은 403 이어야 한다: ${attempt.raw.slice(0, 160)}`);
  const leaks = findAnswerLeaks(attempt.json);
  assert.deepEqual(leaks, [], `자기부여 우회 정답 누출: ${leaks.join(' | ')}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SG3 — 과잉 차단 방지: 정상 콘텐츠는 그대로 담긴다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SG3: 공개 승인본·이용근거 보유 비공개본은 여전히 담긴다', async () => {
  for (const [name, fx] of [['공개 승인본', OPEN], ['수업 연결 비공개본', GRANTED]]) {
    for (const t of grantWrites(fx)) {
      const r = await call(t.method, t.p, S1, t.body);
      assert.equal(r.status, 200,
        `${name}(${fx.cid}) — ${t.label} 까지 막으면 학습이 멈춘다. 실제 ${r.status}: ${r.raw.slice(0, 200)}`);
    }
  }
  // 실제로 근거 행이 생겼는지도 확인한다(게이트가 기록까지 삼키지 않는다)
  const n = db.prepare('SELECT COUNT(*) n FROM content_collections WHERE user_id = ? AND content_id IN (?, ?)')
    .get(S1, OPEN.cid, GRANTED.cid).n;
  assert.equal(n, 2, `정상 콘텐츠 보관함 행이 실제로 적재돼야 한다 (실제 ${n}건)`);
});

test('INV-SG3b: 작성자 교사는 자기 비공개 콘텐츠를 담을 수 있다 (과잉 차단 방지)', async () => {
  const r = await call('POST', `/api/contents/collection/${PRIVATE.cid}`, T1, {});
  assert.equal(r.status, 200, `작성자에게까지 막으면 자기 자료 관리가 불가능하다: ${r.raw.slice(0, 200)}`);
  const r2 = await call('POST', '/api/self-learn/problem-sets/default/add', T1, { contentId: PRIVATE.cid });
  assert.equal(r2.status, 200, `작성자 문제집 담기까지 막으면 회귀다: ${r2.raw.slice(0, 200)}`);
});

test('INV-SG3c: 존재하지 않는 콘텐츠 담기는 404/403 으로 끝나고 500 이 아니다', async () => {
  const a = await call('POST', '/api/contents/collection/99999999', S1, {});
  assert.equal(a.status, 404, `없는 콘텐츠 보관함 담기는 404 여야 한다: ${a.raw.slice(0, 160)}`);
  const b = await call('POST', '/api/self-learn/problem-sets/default/add', S1, { contentId: 99999999 });
  assert.equal(b.status, 403, `없는 콘텐츠 문제집 담기는 403 이어야 한다: ${b.raw.slice(0, 160)}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SG4 — 평가 가져오기: 정답지 통째 복사 통로
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SG4: 학생은 import-from-content 로 정답지를 복사할 수 없다', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM exams WHERE owner_id = ? AND source_content_id = ?')
    .get(S1, PRIVATE.cid).n;

  const r = await call('POST', '/api/exam/import-from-content', S1, {
    contentId: PRIVATE.cid, classId: CLS_T1, title: '수확시도' + SUF,
  });
  assert.equal(r.status, 403, `학생 평가 생성은 403 이어야 한다. 실제 ${r.status}: ${r.raw.slice(0, 200)}`);
  const leaks = findAnswerLeaks(r.json);
  assert.deepEqual(leaks, [], `가져오기 응답 정답 누출: ${leaks.join(' | ')}`);

  const after = db.prepare('SELECT COUNT(*) n FROM exams WHERE owner_id = ? AND source_content_id = ?')
    .get(S1, PRIVATE.cid).n;
  assert.equal(after, before, '차단된 가져오기가 exams 행(=정답 사본)을 만들면 안 된다');

  // 공개 승인본이어도 학생은 평가를 만들 수 없다 (권한 규칙 자체가 개설자·admin)
  const pub = await call('POST', '/api/exam/import-from-content', S1, {
    contentId: OPEN.cid, classId: CLS_T1, title: '수확시도2' + SUF,
  });
  assert.equal(pub.status, 403, `학생은 공개본으로도 평가를 생성할 수 없다: ${pub.raw.slice(0, 200)}`);
});

test('INV-SG4b: 교사도 열람 403 인 콘텐츠는 가져오지 못하고, 남의 클래스에 심지 못한다', async () => {
  // 다른 사람(admin) 소유 비공개 콘텐츠 — teacher1 열람 403
  const foreign = makeQuizContent('_자기부여_타인비공개', { isPublic: 0, status: 'draft', creator: AD });
  const a = await call('POST', '/api/exam/import-from-content', T1, {
    contentId: foreign.cid, classId: CLS_T1, title: '타인콘텐츠' + SUF,
  });
  assert.equal(a.status, 403, `열람 403 인 콘텐츠 가져오기는 403 이어야 한다: ${a.raw.slice(0, 200)}`);
  assert.deepEqual(findAnswerLeaks(a.json), [], '가져오기 거부 응답에 정답이 실리면 안 된다');

  // 남의 클래스(admin 소유)에 평가 심기 — teacher1 은 멤버지만 개설자가 아니다
  const b = await call('POST', '/api/exam/import-from-content', T1, {
    contentId: OPEN.cid, classId: CLS_OTHER, title: '남의클래스' + SUF,
  });
  assert.equal(b.status, 403, `개설자가 아닌 클래스에 평가를 심을 수 없어야 한다: ${b.raw.slice(0, 200)}`);

  const planted = db.prepare('SELECT COUNT(*) n FROM exams WHERE class_id = ? AND owner_id = ?').get(CLS_OTHER, T1).n;
  assert.equal(planted, 0, '남의 클래스에 평가 행이 생기면 안 된다');

  db.prepare('DELETE FROM content_questions WHERE content_id = ?').run(foreign.cid);
  db.prepare('DELETE FROM contents WHERE id = ?').run(foreign.cid);
});

test('INV-SG5: 개설자 교사·관리자의 정상 가져오기는 그대로 200 (과잉 차단 방지)', async () => {
  const t = await call('POST', '/api/exam/import-from-content', T1, {
    contentId: PRIVATE.cid, classId: CLS_T1, title: '정상가져오기_교사' + SUF,
  });
  assert.equal(t.status, 200, `개설자가 자기 콘텐츠를 가져오지 못하면 평가 출제가 막힌다: ${t.raw.slice(0, 200)}`);
  assert.ok(t.json.examId, '평가가 실제로 생성돼야 한다');

  const a = await call('POST', '/api/exam/import-from-content', AD, {
    contentId: PRIVATE.cid, classId: CLS_T1, title: '정상가져오기_관리자' + SUF,
  });
  assert.equal(a.status, 200, `관리자 가져오기까지 막으면 과잉 차단이다: ${a.raw.slice(0, 200)}`);

  // 가져온 평가에는 정답이 담겨 있어야 한다(교사용 원본) — 기능 자체가 죽지 않았는지 확인
  const row = db.prepare('SELECT answers FROM exams WHERE id = ?').get(t.json.examId);
  assert.ok(row && findAnswerLeaks(JSON.parse(row.answers)).length > 0,
    '가져오기 결과에 정답이 없으면 평가 기능이 깨진 것이다');
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SG6 — 소스 락: 근거를 만드는 쓰기가 판정 SSOT 를 호출한다 (사본 금지)
// ══════════════════════════════════════════════════════════════════════════════
/** 주석 줄만 비운다(블록 정규식으로 통째 지우면 스캐너가 눈이 먼다 — INV-SA4 와 같은 이유). */
function codeLines(src) {
  return src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
}
/** `router.<method>('<path>'` 부터 다음 `\n});` 까지 = 한 핸들러 본문. */
function handlerBody(code, needle) {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `라우트를 찾지 못했다: ${needle} — 경로가 바뀌었으면 이 테스트도 함께 고칠 것`);
  const end = code.indexOf('\n});', i);
  return code.slice(i, end === -1 ? i + 2000 : end);
}

test('INV-SG6: 보관함·문제집·평가가져오기가 콘텐츠 열람 판정을 재사용한다', () => {
  const contentSrc = codeLines(fs.readFileSync(path.join(ROOT, 'routes/content.js'), 'utf8'));
  const selfSrc = codeLines(fs.readFileSync(path.join(ROOT, 'routes/self-learn.js'), 'utf8'));
  const examSrc = codeLines(fs.readFileSync(path.join(ROOT, 'routes/exam.js'), 'utf8'));

  assert.match(handlerBody(contentSrc, "router.post('/collection/:contentId'"), /guardContent\(req, res, /,
    '보관함 담기는 guardContent 를 (대상 id 를 넘겨) 호출해야 한다');

  assert.match(handlerBody(selfSrc, "router.post('/problem-sets/default/add'"), /guardAttemptContent\(req, res, /,
    '문제집 자동담기는 콘텐츠 게이트를 호출해야 한다');
  assert.match(handlerBody(selfSrc, "router.post('/problem-sets/:id/items'"), /guardAttemptContent\(req, res, /,
    '문제집 담기(경로)는 콘텐츠 게이트를 호출해야 한다');

  const importBody = handlerBody(examSrc, "router.post('/import-from-content'");
  assert.match(importBody, /canViewContent\(req\.user, /,
    '평가 가져오기는 canViewContent 로 콘텐츠 열람을 확인해야 한다');
  assert.match(importBody, /req\.myRole !== 'owner'/,
    '평가 가져오기는 POST /:classId 와 같은 개설자 규칙을 적용해야 한다');
  assert.match(examSrc, /router\.post\('\/import-from-content', requireAuth, requireClassMember/,
    '평가 가져오기는 requireClassMember 를 거쳐야 한다(클래스 판정 사본 금지)');
  assert.match(examSrc, /require\(['"]\.\.\/lib\/auth\/can-view-content['"]\)/,
    'routes/exam.js 는 열람 판정 SSOT 를 require 해야 한다 — 손 판정 금지');
});

test('INV-SG6b: 스캐너가 실제로 게이트 제거를 잡는다 (역주입 자가검증)', () => {
  // handlerBody 가 "핸들러 안"만 보는지 — 게이트를 지운 사본에서 매치되면 안 된다
  const withGate = "router.post('/collection/:contentId', requireAuth, (req, res) => {\n" +
                   "  if (!guardContent(req, res, req.params.contentId)) return;\n  ok();\n});";
  const withoutGate = "router.post('/collection/:contentId', requireAuth, (req, res) => {\n  ok();\n});";
  assert.match(handlerBody(withGate, "router.post('/collection/:contentId'"), /guardContent\(req, res, /,
    '게이트가 있는 코드를 못 잡으면 스캐너가 무의미하다');
  assert.doesNotMatch(handlerBody(withoutGate, "router.post('/collection/:contentId'"), /guardContent\(req, res, /,
    '게이트를 지운 코드를 통과시키면 소스 락이 잠들어 있는 것이다');
  // 다른 핸들러의 게이트를 빌려오지 않는지(경계 확인)
  const neighbor = "router.post('/collection/:contentId', requireAuth, (req, res) => {\n  ok();\n});\n" +
                   "router.post('/other', requireAuth, (req, res) => {\n  if (!guardContent(req, res, 1)) return;\n});";
  assert.doesNotMatch(handlerBody(neighbor, "router.post('/collection/:contentId'"), /guardContent\(req, res, /,
    '이웃 핸들러의 게이트를 자기 것으로 세면 안 된다');
});

// ── 픽스처 정리 (임시 복사본이라 필수는 아니지만 명시적으로) ─────────────────
after(() => {
  try {
    const ids = [OPEN.cid, PRIVATE.cid, REJECTED.cid, GRANTED.cid];
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM exams WHERE source_content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM content_collections WHERE content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM problem_set_items WHERE content_id IN (${ph})`).run(...ids);
    db.prepare('DELETE FROM problem_sets WHERE id = ?').run(PSET_S1);
    db.prepare('DELETE FROM lesson_contents WHERE lesson_id = ?').run(LESSON_ID);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(LESSON_ID);
    db.prepare(`DELETE FROM problem_attempts WHERE content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM content_questions WHERE content_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM contents WHERE id IN (${ph})`).run(...ids);
    db.prepare('DELETE FROM class_members WHERE class_id IN (?, ?)').run(CLS_T1, CLS_OTHER);
    db.prepare('DELETE FROM classes WHERE id IN (?, ?)').run(CLS_T1, CLS_OTHER);
  } catch (_) { /* 임시 DB 라 실패해도 무해 */ }
});
