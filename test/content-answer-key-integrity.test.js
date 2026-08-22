// test/content-answer-key-integrity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// content_questions.answer **정답키 자체**의 정합 박제 (2026-08-21).
//
// 형제 파일 test/content-answer-index.test.js 는 "0-based 규약"(±1 보정 회귀)을 지킨다.
// 이 파일은 그 규약을 지켰는데도 **학생이 정답을 맞힐 수 없는** 두 부류를 지킨다.
//
//  ① 표기 결함 — `answer='0.0'` (11건, 2026-08-21 정정)
//     better-sqlite3 는 JS number 를 REAL 로 바인딩하고 answer 컬럼은 TEXT affinity 라
//     REAL 0 이 `'0.0'` 으로 굳는다(실측: 0→'0.0', 1→'1.0').
//     채점기는 `String(given) === String(q.answer)` 문자열 비교 → `'0' !== '0.0'` →
//     **첫 보기가 정답인 문항이 100% 오답 처리**된다. 숫자값(Number)만 보는 검사는
//     0 === 0 이라 이 결함을 통과시킨다 → 그래서 **문자열 표기**를 본다.
//     (형제 파일의 INV-AI2 도 Number 로만 봐서 11건을 몇 달간 못 잡았다)
//
//  ② 정답키 손상 — `answer >= 보기수` (34건, 2026-08-21 정정)
//     "1-based 저장"이 아니라 **애초에 틀린 키**다. -1 하면 엉뚱한 보기가 정답이 된다.
//     해설 문구를 보기와 대조해 문항별로 산출했다(보고서/증적/정답키정합_20260821/).
//
// ⚠ `answer='0'`(2,326건)은 **정상**이다 — 0-based 첫 보기. 손대지 않는다.
//   REG-AK3 가 "고치다가 정상 문항까지 건드리지 않았는지"를 표본으로 감시한다.
//
// 검증 방식: 실제 라우터를 mount 해 **진짜 POST /api/contents/:id/grade** 를 부른다.
//   DB 값만 보는 검사는 "채점기가 그 값을 어떻게 읽는지"를 못 본다(①이 정확히 그 사각).
// DB 격리: 실 DB → 임시 복사본(정본 무오염).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                      // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');

function uidOf(username) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r.id;
}
const ADMIN = uidOf('admin');       // guardContent 를 항상 통과 — 검사 대상은 정답키지 권한이 아니다
const T1 = uidOf('teacher1');

// ── 서버 ─────────────────────────────────────────────────────────────────────
let server, baseUrl;
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/contents', require('../routes/content'));
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

// ── 공통 로더 ────────────────────────────────────────────────────────────────
function choiceRows(handle = db) {
  return handle.prepare(
    `SELECT id, content_id, options, answer
       FROM content_questions
      WHERE question_type IN ('choice','multiple_choice')`
  ).all().map((r) => {
    let opts = null;
    try { const j = JSON.parse(r.options); if (Array.isArray(j)) opts = j; } catch (_) {}
    return { ...r, opts };
  }).filter((r) => r.opts && r.opts.length >= 2);
}

/** 실제 채점 경로로 한 문항을 풀어 본다. `given` 은 학생이 고른 0-based 인덱스. */
async function gradeOne(contentId, questionId, given) {
  const res = await call('POST', `/api/contents/${contentId}/grade`, ADMIN, {
    answers: [{ questionId, value: String(given) }],
  });
  assert.equal(res.status, 200, `채점 요청이 200 이어야 한다 (content ${contentId}) — ${res.raw.slice(0, 200)}`);
  const hit = (res.json.results || []).find((r) => Number(r.questionId) === Number(questionId));
  assert.ok(hit, `채점 결과에 q${questionId} 가 있어야 한다`);
  return hit;
}

// ══════════════════════════════════════════════════════════════════════════════
// INV-AK1 — 객관식 answer 는 **정규 정수 문자열**이다
//   숫자값이 아니라 표기를 본다. '0.0' · ' 2 ' · '02' · '+1' 을 전부 잡는다.
// ══════════════════════════════════════════════════════════════════════════════
/** INV-AK1 판정 — 위반 목록(테스트와 역주입이 같은 구현을 쓴다). */
function findNonCanonicalAnswers(rows) {
  const out = [];
  for (const r of rows) {
    const raw = r.answer;
    if (raw === null || raw === '') continue;              // 미기입은 별건(서술형 등)
    const s = String(raw);
    const n = Number(s.trim());
    if (!Number.isInteger(n)) continue;                    // 텍스트 정답(단답형 혼입)은 대상 아님
    if (String(n) !== s) {
      out.push(`q${r.id}(content ${r.content_id}) answer=${JSON.stringify(s)} — 정규 표기는 ${JSON.stringify(String(n))}`);
    }
  }
  return out;
}

test('INV-AK1: 객관식 answer 는 정규 정수 문자열이다 (0.0 같은 실수 표기 금지)', () => {
  assert.deepStrictEqual(
    findNonCanonicalAnswers(choiceRows()), [],
    '채점기는 String 비교입니다. 표기가 어긋난 문항은 학생이 정답을 골라도 **영구 오답**이 됩니다.\n' +
    '원인 대부분은 JS number 를 그대로 바인딩한 것입니다(REAL → TEXT affinity → "0.0").'
  );
});

test('INV-AK1 역주입: 실수 표기를 심으면 반드시 걸린다', () => {
  const rows = choiceRows();
  assert.deepStrictEqual(findNonCanonicalAnswers(rows), [], '정본 데이터는 통과해야 한다');
  const victim = rows[0];
  assert.ok(victim, '역주입 대상 문항이 있어야 한다');

  for (const bad of ['0.0', '1.0', ' 2 ', '02']) {
    const injected = rows.map((r) => (r.id === victim.id ? { ...r, answer: bad } : r));
    const hits = findNonCanonicalAnswers(injected);
    assert.ok(
      hits.some((h) => h.startsWith(`q${victim.id}(`)),
      `answer=${JSON.stringify(bad)} 를 심었는데 INV-AK1 이 통과시켰다 — 불변식이 죽어 있다`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK2 — 2026-08-21 정정한 문항이 **실제 채점 경로에서 정답 판정**된다
//   (qid, 정답 0-based index, 보기 텍스트) — 해설 대조로 확정한 값을 그대로 박제한다.
//   근거: 보고서/증적/정답키정합_20260821/changes.csv
// ══════════════════════════════════════════════════════════════════════════════
const FIXED = [
  // ① '0.0' → '0' (숫자값 불변, 표기만 정규화)
  { qid: 42, idx: 0, opt: '안', note: '해설 "안은 아니의 줄임말" — 시드 원본도 ans:0' },
  { qid: 43, idx: 0, opt: 'ㄱ', note: '해설 "…ㄱ으로 소리 납니다"' },
  { qid: 161, idx: 0, opt: '안', note: '평가지로 복사된 같은 문항' },
  { qid: 176, idx: 0, opt: '안', note: '평가지 복사본' },
  { qid: 177, idx: 0, opt: 'ㄱ', note: '평가지 복사본' },
  { qid: 182, idx: 0, opt: '안', note: '평가지 복사본' },
  { qid: 183, idx: 0, opt: 'ㄱ', note: '평가지 복사본' },
  { qid: 190, idx: 0, opt: '안', note: '평가지 복사본' },
  { qid: 191, idx: 0, opt: 'ㄱ', note: '평가지 복사본' },
  { qid: 206, idx: 0, opt: 'ㄱ', note: '평가지 복사본' },
  { qid: 209, idx: 0, opt: '안', note: '평가지 복사본' },
  // ② 정답키 손상 정정
  { qid: 86, idx: 2, opt: '60cm³', note: '해설 3×4×5=60cm³' },
  { qid: 213, idx: 1, opt: '5/6', note: '해설 3/6+2/6=5/6 · 형제 q210 도 index 1' },
  { qid: 239, idx: 2, opt: '③3', note: '√9=3, 해설 3²=9' },
  { qid: 240, idx: 1, opt: '②4', note: '√16=4, 해설 4²=16' },
  // ③ 중복 정답 문항 수리 — 보기 "1/2"(2/4 와 같은 값)를 오답 보기 "4/4" 로 교체하고
  //    정답을 2/4(index 1)로 확정했다. 보고서/증적/문항중복정답_q214_20260821/
  { qid: 214, idx: 1, opt: '2/4', note: '초3 동분모 뺄셈 (3-1)/4 = 2/4 (약분은 5학년)' },
  // 템플릿 30건 — 해설 "4번이 정답" = 1-based 4 = 보기[3]="올바른 적용"
  ...[276, 279, 282, 285, 288, 291, 294, 297, 300, 303,
      306, 309, 312, 315, 318, 321, 324, 327, 330, 333,
      336, 339, 342, 345, 348, 351, 354, 357, 360, 363]
    .map((qid) => ({ qid, idx: 3, opt: '올바른 적용', note: '해설 "…4번이 정답입니다"' })),
];

test('REG-AK2: 2026-08-21 정정 문항 45건이 실제 채점 경로에서 정답 처리된다', async () => {
  const failures = [];
  for (const f of FIXED) {
    const row = db.prepare(
      'SELECT id, content_id, options, answer FROM content_questions WHERE id = ?'
    ).get(f.qid);
    // ↓ 단언을 조건문 안에 두지 않는다. 행이 사라졌으면 그것도 회귀다.
    assert.ok(row, `q${f.qid} 가 DB 에 있어야 한다 (정정 대상이 사라졌다)`);

    const opts = JSON.parse(row.options);
    if (opts[f.idx] !== f.opt) {
      failures.push(`q${f.qid}: 보기[${f.idx}] 가 "${opts[f.idx]}" — 기대 "${f.opt}" (문항이 교체됐다)`);
    }
    if (String(row.answer) !== String(f.idx)) {
      failures.push(`q${f.qid}: answer='${row.answer}' — 기대 '${f.idx}' (${f.note})`);
    }
    // 실제 채점기로 풀어 본다 — DB 값이 맞아도 채점기가 못 읽으면 학생은 여전히 오답이다.
    const graded = await gradeOne(row.content_id, row.id, f.idx);
    if (graded.correct !== true) {
      failures.push(`q${f.qid}: 정답 보기(index ${f.idx} = "${f.opt}")를 골랐는데 correct=${graded.correct}`);
    }
    // 대조군 — 틀린 보기는 반드시 오답이어야 한다(전부 정답 처리되는 반대 사고 방지)
    const wrongIdx = f.idx === 0 ? 1 : 0;
    const gradedWrong = await gradeOne(row.content_id, row.id, wrongIdx);
    if (gradedWrong.correct !== false) {
      failures.push(`q${f.qid}: 오답 보기(index ${wrongIdx})가 correct=${gradedWrong.correct} — 아무거나 정답 처리된다`);
    }
  }
  assert.deepStrictEqual(failures, [], '정정한 정답키가 채점기에서 살아나지 않았습니다:\n' + failures.join('\n'));
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK3 — 과잉수정 방지: 손대지 않은 `answer='0'` 문항이 여전히 정상 채점된다
//   answer='0' 은 2,326건(전체의 20%)으로 **정상**(0-based 첫 보기)이다.
//   여기를 잘못 건드리면 사이트 전체 채점이 무너진다 → 표본을 고정해 감시한다.
// ══════════════════════════════════════════════════════════════════════════════
test("REG-AK3: 손대지 않은 answer='0' 표본이 여전히 '0' 이고 정답 처리된다", async () => {
  // 결정적 표본 — id 오름차순 25건(정정 대상 11건은 제외해 "안 건드린 것"만 본다)
  const excluded = new Set(FIXED.map((f) => f.qid));
  const sample = db.prepare(
    `SELECT id, content_id, options, answer
       FROM content_questions
      WHERE question_type IN ('choice','multiple_choice') AND answer = '0'
      ORDER BY id LIMIT 40`
  ).all().filter((r) => !excluded.has(r.id)).slice(0, 25);

  // 단언을 조건문 안에 가두지 않는다 — 표본이 비면 "감지력 0" 이므로 그 자체가 실패다.
  assert.equal(sample.length, 25, "answer='0' 표본 25건을 확보해야 한다 (표본이 비면 이 테스트는 잠든다)");

  const failures = [];
  for (const r of sample) {
    if (String(r.answer) !== '0') failures.push(`q${r.id}: answer='${r.answer}' — 정상 문항이 변형됐다`);
    const graded = await gradeOne(r.content_id, r.id, 0);
    if (graded.correct !== true) {
      failures.push(`q${r.id}(content ${r.content_id}): 첫 보기(index 0)를 골랐는데 correct=${graded.correct}`);
    }
  }
  assert.deepStrictEqual(failures, [], "정상이던 answer='0' 문항이 깨졌습니다(과잉수정):\n" + failures.join('\n'));
});

test("REG-AK3 역주입: answer='0' 을 '0.0' 으로 되돌리면 채점이 실제로 깨진다", async () => {
  // 채점기가 정말로 문자열 비교인지(= INV-AK1 이 지키는 것이 실재하는 결함인지) 실증한다.
  // 정본은 물론 테스트 사본의 원형도 건드리지 않도록, 픽스처를 새로 만들어 쓴다.
  const cid = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, is_public, status, created_at)
    VALUES (?, ?, '정답키 표기 역주입 픽스처', 'quiz', 1, 'approved', datetime('now'))
  `).run(T1, '_정답키표기_역주입_' + process.pid).lastInsertRowid;
  const qid = db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points)
    VALUES (?, 1, '첫 보기가 정답인 문항', 'multiple_choice', ?, '0', '첫 번째가 정답입니다.', 10)
  `).run(cid, JSON.stringify(['가', '나', '다', '라'])).lastInsertRowid;

  // (a) 정규 표기 '0' — 정답 처리된다
  assert.equal((await gradeOne(cid, qid, 0)).correct, true, "answer='0' 일 때는 정답이어야 한다");
  assert.deepStrictEqual(
    findNonCanonicalAnswers(choiceRows()).filter((h) => h.startsWith(`q${qid}(`)), [],
    "'0' 은 정규 표기이므로 INV-AK1 에 걸리지 않아야 한다"
  );

  // (b) '0.0' 으로 되돌림 — 채점이 깨지고 INV-AK1 이 붉어진다
  db.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run('0.0', qid);
  assert.equal(
    (await gradeOne(cid, qid, 0)).correct, false,
    "answer='0.0' 인데 정답 처리됐다 — 채점기가 문자열 비교가 아니게 바뀌었다면 INV-AK1 의 전제가 무너진 것이다"
  );
  assert.ok(
    findNonCanonicalAnswers(choiceRows()).some((h) => h.startsWith(`q${qid}(`)),
    "'0.0' 을 심었는데 INV-AK1 이 통과시켰다 — 불변식이 죽어 있다"
  );

  // (c) 원복
  db.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run('0', qid);
  assert.equal((await gradeOne(cid, qid, 0)).correct, true, '원복 후에는 다시 정답이어야 한다');
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK4 — 생성 경로가 숫자 answer 를 **정규 문자열**로 저장한다
//   `'0.0'` 11건이 이 경로(JS number 바인딩)에서 태어났다. 소스 락이 아니라
//   실제 라우트를 호출해 저장값을 읽는다.
// ══════════════════════════════════════════════════════════════════════════════
test('REG-AK4: 문항 생성 API 에 숫자 answer(0)를 보내도 DB 에는 "0" 으로 저장된다', async () => {
  const res = await call('POST', '/api/contents', T1, {
    title: '_정답키_숫자바인딩_' + process.pid,
    description: '숫자 answer 바인딩 회귀',
    content_type: 'quiz',
    is_public: false,
    questions: [
      { question_text: '첫 보기가 정답', question_type: 'multiple_choice', options: ['가', '나'], answer: 0, explanation: '' },
      { question_text: '둘째 보기가 정답', question_type: 'multiple_choice', options: ['가', '나'], answer: 1, explanation: '' },
      { question_text: '숫자 미지정(기본값)', question_type: 'multiple_choice', options: ['가', '나'], explanation: '' },
      { question_text: '단답형', question_type: 'short_answer', options: [], answer: '서울', explanation: '' },
    ],
  });
  assert.equal(res.status, 201, `콘텐츠 생성이 201 이어야 한다 — ${res.raw.slice(0, 200)}`);
  const newId = res.json.content.id;

  const saved = db.prepare(
    'SELECT id, question_number, answer FROM content_questions WHERE content_id = ? ORDER BY question_number'
  ).all(newId);
  assert.equal(saved.length, 4, '문항 4건이 저장돼야 한다');
  assert.equal(saved[0].answer, '0', 'answer:0(숫자) 이 "0.0" 으로 굳으면 첫 보기가 정답인 문항이 영구 오답이 된다');
  assert.equal(saved[1].answer, '1', 'answer:1(숫자) 도 정규 문자열이어야 한다');
  assert.equal(saved[2].answer, '0', '기본값 0 도 정규 문자열이어야 한다');
  assert.equal(saved[3].answer, '서울', '문자열 정답은 그대로 보존돼야 한다');

  // 저장값이 채점기를 실제로 통과하는지까지 본다
  assert.equal((await gradeOne(newId, saved[0].id, 0)).correct, true, '방금 만든 문항이 정답 처리돼야 한다');
  assert.equal((await gradeOne(newId, saved[0].id, 1)).correct, false, '오답 보기는 오답이어야 한다');
});

test('REG-AK4 역주입: 숫자를 그대로 바인딩하면 "0.0" 이 되는 것이 실재한다', () => {
  // 이 회귀의 물리적 근거(better-sqlite3 REAL 바인딩 × TEXT affinity)를 직접 실증한다.
  // 라이브러리가 언젠가 정수 바인딩으로 바뀌면 이 테스트가 알려 준다(가드 불필요 신호).
  const tmp = path.join(os.tmpdir(), `ak4_bind_${process.pid}_${Date.now()}.db`);
  const h = new Database(tmp);
  try {
    h.exec('CREATE TABLE t(answer TEXT)');
    const ins = h.prepare('INSERT INTO t(answer) VALUES(?)');
    ins.run(0);                                     // JS number — 가드가 없을 때의 코드 경로
    ins.run(String(0));                             // 가드가 있을 때의 코드 경로
    const got = h.prepare('SELECT rowid, answer FROM t ORDER BY rowid').all().map((r) => r.answer);
    assert.equal(got[1], '0', '문자열로 바인딩하면 "0" 이어야 한다');
    assert.equal(
      got[0], '0.0',
      'JS number 0 이 "0.0" 으로 저장되지 않았다 — better-sqlite3 바인딩 동작이 바뀌었다.\n' +
      'routes/content.js 의 String() 가드가 여전히 필요한지 재확인하고 이 테스트를 갱신하라.'
    );
  } finally {
    try { h.close(); } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.existsSync(tmp + ext) && fs.unlinkSync(tmp + ext); } catch (_) {} }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK6 — 중복 보기 수리 25건: **정답 칸이 움직이지 않았다**
//   2026-08-21, 정답과 글자가 같은 오답 보기를 교체했다(보고서/증적/중복보기_20260821/).
//   이 수리의 유일한 위험은 "고치다가 정답이 옮겨가는 것" 이다 — 그러면 과거 제출의
//   정오답이 뒤집힌다. 그래서 **정답 index 와 정답 보기 텍스트**를 둘 다 못 박고,
//   실제 채점 경로로 정답/오답 판정까지 확인한다.
//   (qid, 정답 index, 정답 보기 텍스트, 교체한 칸 index, 교체 후 그 칸의 값)
// ══════════════════════════════════════════════════════════════════════════════
const DUP_FIXED = [
  [2512, 1, '18cm²', 3, '36cm²'],
  [2520, 0, '16cm²', 3, '14cm²'],
  [3331, 2, '24cm²', 3, '96cm²'],
  [4851, 2, '24cm²', 3, '96cm²'],
  [3559, 0, '81cm²', 2, '9cm²'],
  [5071, 0, '81cm²', 2, '9cm²'],
  [3370, 0, '4과 1/6', 1, '3과 7/12'],
  [4882, 0, '4과 1/6', 1, '3과 7/12'],
  [3381, 1, '3과 3/6', 3, '3과 4/6'],
  [4893, 1, '3과 3/6', 3, '3과 4/6'],
  [3385, 2, '2와 3/6', 3, '1과 3/6'],
  [4897, 2, '2와 3/6', 3, '1과 3/6'],
  [3395, 2, '4과 1/8 kg', 1, '3과 9/16 kg'],
  [4907, 2, '4과 1/8 kg', 1, '3과 9/16 kg'],
  [9152, 1, '423', 3, '523'],
  [9153, 0, '375', 3, '475'],
  [9154, 0, '486', 3, '586'],
  [9159, 0, '689', 3, '789'],
  [10803, 1, '180°', 3, '360°'],
  [11645, 3, '2초', 1, '4초'],
  [11651, 3, '18', 2, '36'],
  [11658, 3, '0.8', 2, '80'],
  [11670, 2, '35', 1, '12'],
  [11675, 1, '5, 8, 11, 14', 2, '6, 7, 8, 9'],
  [12294, 2, '(x-2)²+(y+1)²=9', 1, '(x-2)²+(y+1)²=3'],
];

test('REG-AK6: 중복 보기 수리 25건 — 정답 index·정답 보기가 그대로이고 교체 칸은 오답이다', async () => {
  const failures = [];
  for (const [qid, ansIdx, ansText, dupIdx, newText] of DUP_FIXED) {
    const row = db.prepare('SELECT id, content_id, options, answer FROM content_questions WHERE id = ?').get(qid);
    assert.ok(row, `q${qid} 가 DB 에 있어야 한다`);
    const opts = JSON.parse(row.options);

    // ① 정답이 움직이지 않았다 (이 수리에서 가장 중요한 단언)
    if (String(row.answer) !== String(ansIdx)) failures.push(`q${qid}: answer='${row.answer}' — 기대 '${ansIdx}' (정답이 이동했다)`);
    if (opts[ansIdx] !== ansText) failures.push(`q${qid}: 정답 보기[${ansIdx}]="${opts[ansIdx]}" — 기대 "${ansText}" (정답 텍스트가 바뀌었다)`);
    // ② 교체한 칸이 새 값으로 바뀌었다
    if (opts[dupIdx] !== newText) failures.push(`q${qid}: 보기[${dupIdx}]="${opts[dupIdx]}" — 기대 "${newText}"`);
    // ③ 중복이 남지 않았다
    const trimmed = opts.map((s) => String(s).trim());
    if (new Set(trimmed).size !== trimmed.length) failures.push(`q${qid}: 아직 글자가 같은 보기가 있다 → ${row.options}`);

    // ④ 실제 채점 — 정답 칸은 정답, 교체한 칸은 오답
    const ok = await gradeOne(row.content_id, row.id, ansIdx);
    if (ok.correct !== true) failures.push(`q${qid}: 정답 index ${ansIdx} 를 골랐는데 correct=${ok.correct}`);
    const ng = await gradeOne(row.content_id, row.id, dupIdx);
    if (ng.correct !== false) failures.push(`q${qid}: 교체한 오답 칸 ${dupIdx} 가 correct=${ng.correct} — 여전히 정답으로 처리된다`);
  }
  assert.deepStrictEqual(failures, [], '중복 보기 수리가 정답을 건드렸거나 중복이 남았습니다:\n' + failures.join('\n'));
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK7 — 의미적 중복 정답 수리 66건(배치 1): **정답 칸이 움직이지 않았다**
//   2026-08-21, "약분 전 = 약분 후" 처럼 정답과 **값이 같은** 오답 보기를 교체했다
//   (보고서/증적/의미적중복_20260821/). 글자 비교로는 잡히지 않는 부류다.
//   이 수리의 유일한 위험도 REG-AK6 과 같다 — 고치다 정답이 옮겨가면 과거 제출의
//   정오답이 뒤집힌다. 정답 index·정답 보기 텍스트를 못 박고, 값 동일 보기가 남지
//   않았는지까지 본다.
// ══════════════════════════════════════════════════════════════════════════════
/** 보기 텍스트를 수치로 읽는다(못 읽으면 null). 스크립트와 같은 규칙을 테스트가 독립 구현한다. */
function numOf(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  if (t.includes(',')) return null;
  let m = t.match(/^(-?\d+)[과와](\d+)\/(\d+)/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(-?\d+)\/(\d+)/); if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(-?\d+(?:\.\d+)?)/); if (m) return Number(m[1]);
  return null;
}
/** 대분수의 분수부는 진분수여야 한다 — `3과 9/8` 은 값이 같아도 **형식이 틀린** 정당한 오답 보기다. */
function legitFormTwin(ansText, optText) {
  const M = (s) => { const m = String(s).replace(/\s+/g, '').match(/^(-?\d+)[과와](\d+)\/(\d+)/); return m ? { n: +m[2], d: +m[3] } : null; };
  const a = M(ansText), o = M(optText);
  return !!(a && o && a.n < a.d && o.n >= o.d);
}

// [정답 index, 정답 보기 텍스트, qid...] — 같은 줄의 qid 들은 동일 문항의 복제본이다.
const EQUIV_FIXED = [
  [2, '4와 1/8 m', 3371, 4883], [2, '2과 1/2', 3696, 5208], [1, '5', 3900, 5356],
  [2, '4.3', 8076], [0, '2와 1/2', 10506], [1, '4와 1/6', 10515],
  [0, '1', 2382], [3, '1', 2457], [3, '1', 2458], [0, '1', 5716],
  [3, '3', 3854, 5310], [3, '2', 3860, 5316], [0, '4', 3861, 5317],
  [0, '6', 3896, 5352], [2, '6', 3897, 5353], [3, '6', 3898, 5354],
  [1, '1/2', 72], [1, '1/4', 216], [2, '2/12', 3872, 5328], [3, '1/4', 3875, 5331],
  [1, '1/2', 3877, 5333], [2, '4/15', 3878, 5334], [0, '3/10', 3879, 5335],
  [1, '2/5', 3881, 5337], [3, '1/3', 3883, 5339], [2, '3/2', 3888, 5344],
  [3, '5/2', 3889, 5345], [0, '8/3', 3890, 5346], [0, '5/8', 3905, 5361],
  [1, '1/2', 3906, 5362], [3, '5/8 m²', 3907, 5363], [1, '6/24', 10209], [2, '1/5', 10211],
  [0, '1/2', 20, 25, 30, 35, 40], [1, '1/2', 10524], [3, '1/4', 10525],
  [3, '1/6', 10546], [1, '1/3', 10552], [3, '2/3', 10553], [3, '2/8 m', 12236],
];

test('REG-AK7: 의미적 중복 수리 66건 — 정답 칸 불변 · 값이 같은 보기 0 · 채점 정상', async () => {
  const failures = [];
  let checked = 0;
  for (const [ansIdx, ansText, ...qids] of EQUIV_FIXED) {
    for (const qid of qids) {
      checked++;
      const row = db.prepare('SELECT id, content_id, options, answer FROM content_questions WHERE id = ?').get(qid);
      assert.ok(row, `q${qid} 가 DB 에 있어야 한다`);
      const opts = JSON.parse(row.options);

      // ① 정답이 움직이지 않았다 (이 수리에서 가장 중요한 단언)
      if (String(row.answer) !== String(ansIdx)) failures.push(`q${qid}: answer='${row.answer}' — 기대 '${ansIdx}' (정답이 이동했다)`);
      if (opts[ansIdx] !== ansText) failures.push(`q${qid}: 정답 보기[${ansIdx}]="${opts[ansIdx]}" — 기대 "${ansText}"`);
      // ② 정답과 **값이 같은** 보기가 남지 않았다 (형식 오답인 가분수형 대분수는 예외)
      const av = numOf(opts[ansIdx]);
      opts.forEach((o, i) => {
        if (i === ansIdx) return;
        const v = numOf(o);
        if (av != null && v != null && Math.abs(v - av) < 1e-9 && !legitFormTwin(opts[ansIdx], o)) {
          failures.push(`q${qid}: 보기[${i}]="${o}" 가 정답 "${ansText}" 와 값이 같다(${av}) — 옳게 푼 학생이 오답 처리된다`);
        }
      });
      // ③ 글자 중복 0
      const trimmed = opts.map((s) => String(s).trim());
      if (new Set(trimmed).size !== trimmed.length) failures.push(`q${qid}: 글자가 같은 보기가 있다 → ${row.options}`);
      // ④ 실제 채점 — 정답 칸은 정답, 다른 칸은 오답
      const ok = await gradeOne(row.content_id, row.id, ansIdx);
      if (ok.correct !== true) failures.push(`q${qid}: 정답 index ${ansIdx} 를 골랐는데 correct=${ok.correct}`);
      const other = ansIdx === 0 ? 1 : 0;
      const ng = await gradeOne(row.content_id, row.id, other);
      if (ng.correct !== false) failures.push(`q${qid}: 오답 index ${other} 가 correct=${ng.correct}`);
    }
  }
  assert.equal(checked, 66, `대상 66건을 전부 검사해야 한다 — 실제 ${checked}건 (표가 줄면 이 테스트가 잠든다)`);
  assert.deepStrictEqual(failures, [], '의미적 중복 수리가 정답을 건드렸거나 값이 같은 보기가 남았습니다:\n' + failures.join('\n'));
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK8 — 의미적 중복 정답 수리 41건(배치 2 34건 + 배치 3 7건)
//   2026-08-21, 배치 1 이 인계한 36건 중 34건을 처리했다
//   (보고서/증적/의미적중복_배치2_20260821/). 배치 1 과 처리 방식이 다르다:
//
//   · FORMAT 33건 — **지문에 형식 요구를 덧붙였다**. 보기는 한 글자도 바꾸지 않았다
//       (해설의 번호 참조 ①②… 가 어긋나면 안 되기 때문).
//       근거: 해설이 이미 약분(또는 대분수 변환)을 요구하고 있었다 —
//             q6340 해설 "①-6/12는 약분하지 않았을 뿐 … 정답은 기약분수 -1/2이다."
//       즉 학습 목표에 그 형식이 이미 있었고 지문에만 빠져 있던 **지문↔해설 불일치**였다.
//       ⚠ 그래서 이 33건은 "정답과 값이 같은 보기 0" 이 **성립하지 않는다** — 쌍둥이는
//         그대로 남아 있고, 대신 **형식이 틀려서** 오답이 된다. 여기서 박제하는 불변식은
//         "정답과 값이 같으면서 **형식도 만족하는** 보기가 정답 칸 하나뿐" 이다.
//         지문에서 형식 요구가 사라지면 다시 정답이 둘이 되므로, 지문 문구도 함께 못 박는다.
//   · SWAP 1건(q7406) — 정답 칸이 "5/10"(약분 전), 쌍둥이가 "1/2"(기약)이라 지문으로는
//       풀 수 없었다(형식 요구가 DB 정답을 죽인다). 배치 1 방식대로 쌍둥이 칸을 교체했다.
//
//   위험은 앞 배치들과 같다 — 고치다 정답이 옮겨가면 과거 제출의 정오답이 뒤집힌다.
// ══════════════════════════════════════════════════════════════════════════════
const B2_KEYWORD = { irreducible: '기약분수', mixed: '대분수' };
const b2Strip = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
// 🔴 2026-08-21: 여기도 원래 **고정 단위 목록**이었다. `L`·`장` 이 빠져 있어서, 그 단위를 쓰는
//   문항에 대해서는 아래 "값이 같은 보기" 단언이 **조용히 통과**했다(파서가 null 을 돌려주니
//   쌍둥이가 0건으로 보인다 = 잠든 단언). INV-AI6 과 같은 일반화 규칙으로 맞춘다.
//   (테스트는 스크립트와 독립 구현한다 — 같은 버그를 공유하지 않기 위해서다)
const B2_UNIT_TAIL_REJECT = /[\d/.,:=~×÷+\-*^()[\]{}<>]/;
const B2_NUM_TOKEN = /^([-+]?\d+(?:[과와]\d+\/\d+|\/\d+|\.\d+)?)(.*)$/;
/** `{body, unit}` 또는 null(= 수치+단위 형태가 아니므로 값 비교 대상 아님). */
function b2SplitUnit(s) {
  const m = b2Strip(s).match(B2_NUM_TOKEN);
  if (!m) return null;
  if (B2_UNIT_TAIL_REJECT.test(m[2])) return null;      // 수식·목록·비·범위
  return { body: m[1], unit: m[2] };
}
const b2Unit = (s) => { const p = b2SplitUnit(s); return p ? p.unit : null; };
/** 문자열이 **수치 토큰(+임의 단위)** 일 때만 값으로 읽는다(INV-AI6 과 같은 규칙). */
function b2Value(s) {
  const p = b2SplitUnit(s);
  if (!p) return null;
  let m = p.body.match(/^([-+]?\d+)[과와](\d+)\/(\d+)$/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = p.body.match(/^([-+]?\d+)\/(\d+)$/); if (m) return Number(m[1]) / Number(m[2]);
  m = p.body.match(/^([-+]?\d+(?:\.\d+)?)$/); if (m) return Number(m[1]);
  return null;
}
function b2Frac(s) { const p = b2SplitUnit(s); if (!p) return null; const m = p.body.match(/^([-+]?\d+)\/(\d+)$/); return m ? [Number(m[1]), Number(m[2])] : null; }
function b2Mixed(s) {
  const p = b2SplitUnit(s); if (!p) return null;
  const m = p.body.match(/^([-+]?\d+)[과와](\d+)\/(\d+)$/);
  return m ? { w: Number(m[1]), n: Number(m[2]), d: Number(m[3]) } : null;
}
const b2Gcd = (a, b) => (b ? b2Gcd(b, a % b) : a);
/** 보기가 요구 형식을 만족하는가. 기약분수 / 분수부가 진분수인 대분수. */
function b2Satisfies(kind, text) {
  if (kind === 'irreducible') { const f = b2Frac(text); return !!f && b2Gcd(Math.abs(f[0]), f[1]) === 1; }
  const m = b2Mixed(text); return !!m && m.n < m.d;
}
/** 정답과 값이 같은 다른 보기의 index (단위가 다르면 다른 양이므로 제외). */
function b2Twins(opts, ansIdx) {
  const av = b2Value(opts[ansIdx]);
  if (av === null) return [];
  const unit = b2Unit(opts[ansIdx]);
  return opts.map((o, i) => {
    if (i === ansIdx) return -1;
    if (b2Unit(o) !== unit) return -1;
    const v = b2Value(o);
    return (v !== null && Math.abs(v - av) < 1e-9) ? i : -1;
  }).filter((i) => i >= 0);
}
/**
 * FORMAT 수리의 판정기 — 테스트와 역주입이 **같은 구현**을 쓴다.
 * 하나라도 걸리면 "학생이 수학적으로 옳은 칸을 골라도 오답" 상태가 되살아난 것이다.
 */
function b2FormatDefects(kind, qtext, opts, ansIdx, explanation, evidence) {
  const out = [];
  if (!String(qtext).includes(B2_KEYWORD[kind])) {
    out.push(`지문에 형식 요구("${B2_KEYWORD[kind]}")가 없다 — 쌍둥이 보기가 다시 정당한 정답이 된다`);
  }
  if (!b2Satisfies(kind, opts[ansIdx])) {
    out.push(`정답 보기 "${opts[ansIdx]}" 가 형식 요구를 만족하지 않는다 — 형식 요구가 정답을 죽인다`);
  }
  for (const i of b2Twins(opts, ansIdx)) {
    if (b2Satisfies(kind, opts[i])) {
      out.push(`보기[${i}]="${opts[i]}" 가 정답과 값도 같고 형식도 만족한다 — 정답이 둘이다`);
    }
  }
  if (!b2Strip(explanation).includes(b2Strip(evidence))) {
    out.push(`해설에 형식 요구의 근거 문구("${evidence}")가 없다 — 지문이 해설과 모순될 수 있다`);
  }
  return out;
}

// [kind, qid, 정답 index, 정답 보기 텍스트, 쌍둥이 index 목록, 해설 근거 문구]
const B2_FORMAT_FIXED = [
  ['irreducible', 6340, 1, '-1/2', [0], '약분하지않았을뿐같은값이므로정답은기약분수'],
  ['irreducible', 6355, 2, '3/10', [1], '약분하지않은중간값'],
  ['irreducible', 6375, 3, '-3/2', [4], '약분하지않은중간값'],
  ['irreducible', 8683, 2, '2/7', [3], '분모를3배로잘못곱한'],
  ['irreducible', 8685, 4, '3/11', [2], '분모에3을곱한경우'],
  ['irreducible', 8708, 1, '1/6', [2], '5/30은분모에5를곱한오답'],
  ['irreducible', 8710, 0, '1/4', [1], '3/12는약분전값으로기약분수는1/4'],
  ['irreducible', 8719, 3, '3/7', [1], '15/35는약분전오답'],
  ['irreducible', 8725, 0, '1/3 kg', [1], '7/21=1/3이므로약분전표현'],
  ['irreducible', 8916, 1, '1/6', [3], '④는약분전값'],
  ['irreducible', 8940, 3, '3/2', [1], '④는약분전값'],
  ['irreducible', 8941, 4, '10/21', [3], '④는약분전값'],
  ['irreducible', 8949, 4, '1/2', [0], '28/56=1/2이다'],
  ['irreducible', 8950, 0, '1/6', [3], '④⑤는계산오류'],
  ['irreducible', 8951, 1, '3/4', [3], '④는약분전값'],
  ['mixed', 3390, 0, '1과 2/10', [2], '12/10=1과2/10입니다'],
  ['mixed', 4902, 0, '1과 2/10', [2], '12/10=1과2/10입니다'],
  ['mixed', 3708, 1, '1과 7/20', [0], '27/20=1과7/20입니다'],
  ['mixed', 5220, 1, '1과 7/20', [0], '27/20=1과7/20입니다'],
  ['mixed', 3709, 3, '1과 1/2', [2], '15/10=1과1/2입니다'],
  ['mixed', 5221, 3, '1과 1/2', [2], '15/10=1과1/2입니다'],
  ['mixed', 3710, 0, '1과 1/2', [2], '9/6=1과1/2입니다'],
  ['mixed', 5222, 0, '1과 1/2', [2], '9/6=1과1/2입니다'],
  ['mixed', 3862, 1, '3과 3/4', [0], '15/4=3과3/4입니다'],
  ['mixed', 5318, 1, '3과 3/4', [0], '15/4=3과3/4입니다'],
  ['mixed', 3909, 1, '3과 1/2', [0], '35/10=7/2=3과1/2입니다'],
  ['mixed', 5365, 1, '3과 1/2', [0], '35/10=7/2=3과1/2입니다'],
  ['mixed', 7965, 4, '1과 4/7', [1], '11/7을대분수로고치지않고두면최종답이아니다'],
  ['mixed', 7966, 4, '4와 5/8', [0], '37/8을대분수로고치면4와5/8이다'],
  ['mixed', 7994, 3, '1과 2/5', [4], '가분수를대분수로고치지않고7/5로두면완전한답이아니다'],
  ['mixed', 7995, 2, '3과 1/6', [4], '19/6=3과1/6이다'],
  ['mixed', 8920, 2, '10과 1/2', [1, 3], '④는대분수로고치지않은가분수'],
  ['mixed', 10500, 0, '1과 5/12', [3], '17/12=1과5/12입니다'],
];
// [qid, 정답 index, 정답 보기 텍스트, 교체한 칸 index, 교체 후 그 칸의 값]
const B2_SWAP_FIXED = [
  [7406, 2, '5/10', 0, '2/5'],
  // ── 배치 3 (2026-08-21) — 단위 파서 일반화로 드러난 6건 ──────────────────
  //   INV-AI6 의 고정 단위 목록에 `L`·`장` 이 없어 몇 달간 탐지를 빠져나갔던 것들이다.
  //   전부 보기 교체로 처리했다(지문 형식 요구는 근거가 없었다 — 상세는 배치 3 스크립트 주석):
  //     · q3391/q4903 정답이 `1 L`(자연수)이라 형식 요구로는 정답이 죽는다
  //     · q3855/q5311 형제 q3853 의 정답이 `8/5`(가분수 그대로) — "대분수로" 는 형제 증거와 모순
  //     · q10511/q12242 해설이 쌍둥이를 오답으로 지목하지 않고 형제 증거도 없다
  [3391, 1, '1 L', 0, '2/8 L'],
  [4903, 1, '1 L', 0, '2/8 L'],
  [3855, 0, '3과 1/3 L', 1, '10/15 L'],
  [5311, 0, '3과 1/3 L', 1, '10/15 L'],
  [10511, 3, '1/2 장', 2, '5/15 장'],
  [12242, 3, '1/6 L', 0, '25/6 L'],
];

// ── 배치 3 ANSWER — 유일하게 **정답 칸을 옮긴** 건 ────────────────────────
//   q12417: 지문("…기약분수로 나타내면?")·해설("기약분수는 3/11이다")이 모두 `3/11` 을 요구하는데
//   answer 가 약분 전 `27/99`(index 2)를 가리켰다. **정답키 자체가 틀린** 경우라 보기 교체로는
//   풀 수 없다. content 10593 의 제출 기록이 0 건임을 스크립트 가드로 확인한 뒤 index 1 로 옮겼다.
//   해설의 보기 번호(①→③)도 실제 보기에 맞춰 바로잡았다.
//   ⚠ 여기서 못 박는 것은 "정답이 3/11 로 가 있고, 약분 전 27/99 는 오답" 이다.
//     되돌아가면 옳게 푼 학생이 다시 오답 처리된다.
const B3_ANSWER_FIXED = {
  qid: 12417,
  ansIdx: 1,
  ansText: '3/11',
  staleIdx: 2,                       // 옛 정답(약분 전) — 이제 오답이어야 한다
  staleText: '27/99',
  options: ['27/100', '3/11', '27/99', '27/90'],
  explanation: '99x=27 → x=27/99=3/11. 기약분수는 3/11이다. (보기③은 3/11과 같지만 약분 전)',
  refMark: '보기③',                  // 해설이 가리키는 보기 번호 → options[2]
  refIdx: 2,
};

test('REG-AK8: 배치 2·3 수리 41건 — 정답 칸 불변 · 형식 요구 유효 · 채점 양방향 정상', async () => {
  const failures = [];
  let checked = 0;

  // ── FORMAT 33건 — 지문에 형식 요구가 들어갔고, 그것이 실제로 쌍둥이를 배제한다 ──
  for (const [kind, qid, ansIdx, ansText, twinIdxs, evidence] of B2_FORMAT_FIXED) {
    checked++;
    const row = db.prepare(
      'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
    ).get(qid);
    // ↓ 단언을 조건문 안에 두지 않는다. 행이 사라졌으면 그것도 회귀다.
    assert.ok(row, `q${qid} 가 DB 에 있어야 한다 (수리 대상이 사라졌다)`);
    const opts = JSON.parse(row.options);

    // ① 정답이 움직이지 않았다 (이 수리에서 가장 중요한 단언)
    if (String(row.answer) !== String(ansIdx)) failures.push(`q${qid}: answer='${row.answer}' — 기대 '${ansIdx}' (정답이 이동했다)`);
    if (opts[ansIdx] !== ansText) failures.push(`q${qid}: 정답 보기[${ansIdx}]="${opts[ansIdx]}" — 기대 "${ansText}"`);
    // ② 쌍둥이 칸이 **그대로** 남아 있다 — FORMAT 수리는 보기를 건드리지 않는다
    //    (건드렸다면 해설의 번호 참조가 어긋났다는 뜻이다)
    const twins = b2Twins(opts, ansIdx);
    if (JSON.stringify(twins) !== JSON.stringify(twinIdxs)) {
      failures.push(`q${qid}: 정답과 값이 같은 보기가 [${twins}] — 기대 [${twinIdxs}] (보기가 바뀌었다)`);
    }
    // ③ 지문 형식 요구 + 해설 정합 + "형식까지 만족하는 동치 보기 0"
    for (const d of b2FormatDefects(kind, row.question_text, opts, ansIdx, row.explanation, evidence)) {
      failures.push(`q${qid}: ${d}`);
    }
    // ④ 글자 중복 0
    const trimmed = opts.map((s) => String(s).trim());
    if (new Set(trimmed).size !== trimmed.length) failures.push(`q${qid}: 글자가 같은 보기가 있다 → ${row.options}`);
    // ⑤ 실제 채점 — 정답 칸은 true, 쌍둥이 칸은 false (양방향)
    const ok = await gradeOne(row.content_id, row.id, ansIdx);
    if (ok.correct !== true) failures.push(`q${qid}: 정답 index ${ansIdx} 를 골랐는데 correct=${ok.correct}`);
    for (const ti of twinIdxs) {
      const ng = await gradeOne(row.content_id, row.id, ti);
      if (ng.correct !== false) failures.push(`q${qid}: 쌍둥이 index ${ti} 가 correct=${ng.correct}`);
    }
  }

  // ── SWAP 1건 — 배치 1 과 같은 형태: 값이 같은 보기가 **하나도** 남지 않는다 ──
  for (const [qid, ansIdx, ansText, swapIdx, newText] of B2_SWAP_FIXED) {
    checked++;
    const row = db.prepare(
      'SELECT id, content_id, question_text, options, answer FROM content_questions WHERE id = ?'
    ).get(qid);
    assert.ok(row, `q${qid} 가 DB 에 있어야 한다 (수리 대상이 사라졌다)`);
    const opts = JSON.parse(row.options);

    if (String(row.answer) !== String(ansIdx)) failures.push(`q${qid}: answer='${row.answer}' — 기대 '${ansIdx}' (정답이 이동했다)`);
    if (opts[ansIdx] !== ansText) failures.push(`q${qid}: 정답 보기[${ansIdx}]="${opts[ansIdx]}" — 기대 "${ansText}"`);
    if (opts[swapIdx] !== newText) failures.push(`q${qid}: 보기[${swapIdx}]="${opts[swapIdx]}" — 기대 "${newText}"`);
    const twins = b2Twins(opts, ansIdx);
    // ⚠ 잠든 단언 방지 — 아래 "값이 같은 보기 0" 은 파서가 정답 보기를 **값으로 읽을 때만**
    //   의미가 있다. 파서가 좁아져 null 을 돌려주면 쌍둥이가 0건으로 보여 조용히 통과한다.
    //   실제로 2026-08-21 이전 고정 단위 목록에서는 `1 L`·`1/2 장` 이 전부 null 이었다.
    if (b2Value(opts[ansIdx]) === null) {
      failures.push(`q${qid}: 정답 보기 "${opts[ansIdx]}" 를 파서가 값으로 읽지 못한다 — 아래 "값이 같은 보기 0" 단언이 잠든다(파서가 좁아졌다)`);
    }
    if (twins.length) failures.push(`q${qid}: 정답과 값이 같은 보기 [${twins}] 가 남아 있다 → ${row.options}`);
    const trimmed = opts.map((s) => String(s).trim());
    if (new Set(trimmed).size !== trimmed.length) failures.push(`q${qid}: 글자가 같은 보기가 있다 → ${row.options}`);

    const ok = await gradeOne(row.content_id, row.id, ansIdx);
    if (ok.correct !== true) failures.push(`q${qid}: 정답 index ${ansIdx} 를 골랐는데 correct=${ok.correct}`);
    const ng = await gradeOne(row.content_id, row.id, swapIdx);
    if (ng.correct !== false) failures.push(`q${qid}: 교체한 오답 칸 ${swapIdx} 가 correct=${ng.correct}`);
  }

  // ── 배치 3 ANSWER 1건 — 정답이 옳은 칸(3/11)으로 옮겨져 있고 옛 정답은 오답이다 ──
  {
    checked++;
    const F = B3_ANSWER_FIXED;
    const row = db.prepare(
      'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
    ).get(F.qid);
    assert.ok(row, `q${F.qid} 가 DB 에 있어야 한다 (수리 대상이 사라졌다)`);
    const opts = JSON.parse(row.options);

    // ① 정답키가 옳은 칸에 있다 (되돌아가면 옳게 푼 학생이 다시 오답 처리된다)
    if (String(row.answer) !== String(F.ansIdx)) failures.push(`q${F.qid}: answer='${row.answer}' — 기대 '${F.ansIdx}' (정답키가 약분 전으로 되돌아갔다)`);
    if (JSON.stringify(opts) !== JSON.stringify(F.options)) failures.push(`q${F.qid}: 보기가 바뀌었다 → ${row.options} (ANSWER 건은 보기를 건드리지 않는다)`);
    if (opts[F.ansIdx] !== F.ansText) failures.push(`q${F.qid}: 정답 보기[${F.ansIdx}]="${opts[F.ansIdx]}" — 기대 "${F.ansText}"`);
    if (opts[F.staleIdx] !== F.staleText) failures.push(`q${F.qid}: 옛 정답 칸[${F.staleIdx}]="${opts[F.staleIdx]}" — 기대 "${F.staleText}"`);
    // ② 지문의 형식 요구가 살아 있고, 그것이 실제로 약분 전 칸을 배제한다
    if (!String(row.question_text).includes('기약분수')) failures.push(`q${F.qid}: 지문에서 "기약분수" 요구가 사라졌다 → ${row.question_text}`);
    if (!b2Satisfies('irreducible', opts[F.ansIdx])) failures.push(`q${F.qid}: 정답 "${opts[F.ansIdx]}" 가 기약분수가 아니다`);
    if (b2Satisfies('irreducible', opts[F.staleIdx])) failures.push(`q${F.qid}: 옛 정답 "${opts[F.staleIdx]}" 가 기약분수로 판정된다 — 배제 근거가 사라졌다`);
    if (!b2Twins(opts, F.ansIdx).includes(F.staleIdx)) failures.push(`q${F.qid}: 보기[${F.staleIdx}] 가 정답과 값이 같다고 판정되지 않는다 — 파서가 좁아졌다`);
    // ③ 해설이 새 정답을 지목하고, 보기 번호 참조가 실제 보기와 맞는다
    if (String(row.explanation) !== F.explanation) failures.push(`q${F.qid}: 해설이 기대와 다르다 → ${row.explanation}`);
    if (!b2Strip(row.explanation).includes(b2Strip(F.refMark))) failures.push(`q${F.qid}: 해설에 보기 번호 참조("${F.refMark}")가 없다`);
    if ('①②③④⑤'.indexOf(F.refMark.slice(-1)) !== F.refIdx) failures.push(`q${F.qid}: 해설의 보기 번호가 보기[${F.refIdx}] 를 가리키지 않는다`);
    // ④ 실제 채점 — 새 정답은 true, 옛 정답(약분 전)은 false (양방향)
    const ok = await gradeOne(row.content_id, row.id, F.ansIdx);
    if (ok.correct !== true) failures.push(`q${F.qid}: 정답 index ${F.ansIdx}("${F.ansText}")를 골랐는데 correct=${ok.correct}`);
    const ng = await gradeOne(row.content_id, row.id, F.staleIdx);
    if (ng.correct !== false) failures.push(`q${F.qid}: 옛 정답 index ${F.staleIdx}("${F.staleText}")가 correct=${ng.correct}`);
  }

  assert.equal(checked, 41, `대상 41건을 전부 검사해야 한다 — 실제 ${checked}건 (표가 줄면 이 테스트가 잠든다)`);
  assert.deepStrictEqual(failures, [], '배치 2·3 수리가 정답을 건드렸거나 형식 요구가 무력화됐습니다:\n' + failures.join('\n'));
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK9 — 정답 이동 스크립트는 **제출 기록 확인 가드**를 갖는다 [소스 락]
//   🔴 정답 index 를 옮기면 과거 제출의 정오답이 **소급해서 뒤집힌다**. q12417 을 옮길 수 있었던
//     유일한 이유는 그 콘텐츠의 제출 기록이 0 건이었기 때문이다(뒤집힐 것이 없었다).
//   ⚠ 위험은 "다음 사람이 저번에도 옮겼으니까 로 답습하는 것" 이다. 그래서 그 확인을 사람의
//     기억이 아니라 **스크립트 가드**에 박아 두고, 가드가 사라지면 여기가 붉어지게 한다.
//
//   🔴 2026-08-21: 이 락이 **한 스크립트만** 잠그고 있었다. 정답을 옮기는 스크립트가 새로
//     생기면 락 밖에서 자라난다 — 실제로 해설↔정답키 배치(186건)가 새 파일로 왔다.
//     → 목록으로 바꾸고 **전 파일에 같은 가드**를 요구한다. 새 이동 스크립트를 만들면
//       여기에 반드시 추가할 것. (추가를 잊으면 그 스크립트는 무방비로 남는다)
// ══════════════════════════════════════════════════════════════════════════════
const ANSWER_MOVE_SCRIPTS = [
  'scripts/fix-equivalent-options-20260821-b3.js',             // q12417 (배치 3, 1건)
  'scripts/fix-explanation-answer-mismatch-20260821.js',       // 해설↔정답키 불일치 배치 1 (186건)
  'scripts/fix-explanation-answer-mismatch-20260821-b2.js',    // 해설↔정답키 불일치 배치 2 (68건)
];
const SUBMISSION_TABLES = ['content_attempts', 'problem_attempts', 'diagnosis_answers', 'wrong_answers'];

function scanAnswerMoveGuard(source, label) {
  const problems = [];
  if (!/function\s+countSubmissions\s*\(/.test(source)) {
    problems.push(`${label}: 제출 기록 집계 함수(countSubmissions)를 찾지 못했습니다`);
  }
  for (const t of SUBMISSION_TABLES) {
    if (!new RegExp(`FROM\\s+${t}\\b`).test(source)) {
      problems.push(`${label}: 제출 기록 집계에서 ${t} 가 빠졌습니다 — 가드가 조용히 약해집니다`);
    }
  }
  // 0 이 아닐 때 **실제로 차단**하는가 (세지기만 하고 통과시키면 가드가 아니다)
  if (!/nonZero\s*=\s*subs\.filter/.test(source)) {
    problems.push(`${label}: 0 이 아닌 집계를 걸러내는 분기를 찾지 못했습니다`);
  }
  if (!/if\s*\(nonZero\.length\)\s*\{[\s\S]{0,600}?blockers\.push/.test(source)) {
    problems.push(`${label}: 제출 기록이 있을 때 차단(blockers)하는 분기를 찾지 못했습니다`);
  }
  return problems;
}

test('REG-AK9: 정답 이동 스크립트가 제출 기록 확인 가드를 갖는다 [소스 락]', () => {
  // ⚠ 단언을 루프 안에만 두면 목록이 비었을 때 조용히 통과한다.
  assert.ok(ANSWER_MOVE_SCRIPTS.length >= 3, '정답 이동 스크립트 목록이 줄었다 — 락이 좁아졌다');
  const problems = [];
  for (const rel of ANSWER_MOVE_SCRIPTS) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `스크립트가 없습니다: ${rel}`);
    problems.push(...scanAnswerMoveGuard(fs.readFileSync(abs, 'utf8'), rel));
  }
  assert.deepStrictEqual(
    problems, [],
    '제출 기록 확인 없이 정답을 옮기면 과거 제출의 정오답이 소급해서 뒤집힙니다.'
  );
});

test('REG-AK9 역주입: 가드를 벗기거나 집계 테이블을 빼면 반드시 걸린다', () => {
  assert.ok(ANSWER_MOVE_SCRIPTS.length >= 3, '정답 이동 스크립트 목록이 줄었다');
  // 🔴 역주입은 **모든** 이동 스크립트에 대해 돌린다. 한 파일만 확인하면 나머지는 무방비다.
  for (const rel of ANSWER_MOVE_SCRIPTS) {
    const good = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.deepStrictEqual(scanAnswerMoveGuard(good, rel), [], `정본 소스는 통과해야 한다: ${rel}`);

    // (a) 차단 분기를 무력화
    const bad1 = good.replace(/if\s*\(nonZero\.length\)/, 'if (false)');
    assert.notStrictEqual(bad1, good, `역주입 치환이 적용되지 않았다(패턴 불일치): ${rel}`);
    assert.ok(scanAnswerMoveGuard(bad1, rel).length > 0, `차단 분기를 없앴는데 스캐너가 통과시켰다 — 락이 죽어 있다: ${rel}`);

    // (b) 집계 테이블을 하나씩 빼면 각각 잡혀야 한다 (하나라도 조용히 통과하면 그 테이블은 무방비다)
    const survivors = [];
    for (const t of SUBMISSION_TABLES) {
      const bad = good.replace(new RegExp(`FROM\\s+${t}\\b`, 'g'), 'FROM zzz_removed');
      assert.notStrictEqual(bad, good, `역주입 치환이 적용되지 않았다(${t}): ${rel}`);
      if (!scanAnswerMoveGuard(bad, rel).some((p) => p.includes(t))) survivors.push(t);
    }
    assert.deepStrictEqual(survivors, [], `집계에서 빼도 스캐너가 통과시킨 테이블이 있다(${rel}): ` + survivors.join(', '));

    // (c) 집계 함수 자체를 제거
    const bad3 = good.replace(/function\s+countSubmissions\s*\(/, 'function zzzRemoved(');
    assert.notStrictEqual(bad3, good, `역주입 치환이 적용되지 않았다(countSubmissions): ${rel}`);
    assert.ok(scanAnswerMoveGuard(bad3, rel).length > 0, `집계 함수를 지웠는데 스캐너가 통과시켰다: ${rel}`);
  }
});

test('REG-AK8 역주입: 지문 형식 요구·해설 근거·형식 만족 쌍둥이를 건드리면 반드시 걸린다', () => {
  // 정본은 통과해야 한다 — 아래 역주입이 "원래부터 붉었다" 로 착시되지 않게 먼저 못 박는다.
  const clean = [];
  for (const [kind, qid, ansIdx, , , evidence] of B2_FORMAT_FIXED) {
    const row = db.prepare('SELECT question_text, options, explanation FROM content_questions WHERE id = ?').get(qid);
    assert.ok(row, `q${qid} 가 DB 에 있어야 한다`);
    const d = b2FormatDefects(kind, row.question_text, JSON.parse(row.options), ansIdx, row.explanation, evidence);
    if (d.length) clean.push(`q${qid}: ${d.join(' / ')}`);
  }
  assert.deepStrictEqual(clean, [], '정본 데이터는 통과해야 한다');

  // (a) 지문에서 형식 요구를 떼면 — 33건 **전부** 붉어져야 한다.
  //     하나라도 조용히 통과하면 그 문항은 형식 요구에 기대지 않는 셈이라 판정 자체가 거짓이다.
  const survivors = [];
  for (const [kind, qid, ansIdx, , , evidence] of B2_FORMAT_FIXED) {
    const row = db.prepare('SELECT question_text, options, explanation FROM content_questions WHERE id = ?').get(qid);
    const stripped = String(row.question_text).split(B2_KEYWORD[kind]).join('분수');   // 키워드만 제거
    assert.notStrictEqual(stripped, row.question_text, `q${qid}: 역주입 치환이 적용되지 않았다(키워드 불일치)`);
    const d = b2FormatDefects(kind, stripped, JSON.parse(row.options), ansIdx, row.explanation, evidence);
    if (!d.length) survivors.push(`q${qid}(${kind})`);
  }
  assert.deepStrictEqual(survivors, [], '지문에서 형식 요구를 뗐는데도 통과한 문항이 있다 — 판정기가 죽어 있다:\n' + survivors.join(', '));

  // (b) 쌍둥이 칸을 **형식까지 만족하는 동치 표기**로 바꿔 심는다 → "정답이 둘" 이 잡혀야 한다.
  //     대분수 요구 문항에서 가장 현실적인 사고다(예: "10과 1/2" 옆에 "10과 2/4").
  const mixedFx = B2_FORMAT_FIXED.filter((f) => f[0] === 'mixed');
  assert.ok(mixedFx.length > 0, '역주입 대상(대분수 요구 문항)이 있어야 한다');
  const [, mQid, mAns, , mTwins, mEvi] = mixedFx[0];
  const mRow = db.prepare('SELECT question_text, options, explanation FROM content_questions WHERE id = ?').get(mQid);
  const mOpts = JSON.parse(mRow.options);
  const mm = b2Mixed(mOpts[mAns]);
  assert.ok(mm, `q${mQid} 정답 "${mOpts[mAns]}" 를 대분수로 읽지 못했다`);
  const injected = mOpts.slice();
  injected[mTwins[0]] = `${mm.w}과 ${mm.n * 2}/${mm.d * 2}`;                   // 값·형식 모두 정답과 동등
  assert.notStrictEqual(injected[mTwins[0]], mOpts[mAns], '역주입 값이 정답과 글자까지 같아졌다');
  assert.ok(b2Satisfies('mixed', injected[mTwins[0]]), '역주입 값이 대분수 형식을 만족해야 의미가 있다');
  const dInj = b2FormatDefects('mixed', mRow.question_text, injected, mAns, mRow.explanation, mEvi);
  assert.ok(
    dInj.some((x) => x.includes('정답이 둘이다')),
    `q${mQid} 에 "${injected[mTwins[0]]}"(= 정답 "${mOpts[mAns]}")를 심었는데 판정기가 통과시켰다 — 불변식이 죽어 있다`
  );

  // (c) 해설에서 근거 문구를 지우면 걸린다 — 지문의 형식 요구가 해설과 어긋나는 상태다.
  const [eKind, eQid, eAns, , , eEvi] = B2_FORMAT_FIXED[0];
  const eRow = db.prepare('SELECT question_text, options, explanation FROM content_questions WHERE id = ?').get(eQid);
  const brokenExpl = String(eRow.explanation).split(/\s+/).join('').split(b2Strip(eEvi)).join('');
  assert.notStrictEqual(brokenExpl, b2Strip(eRow.explanation), '역주입 치환이 적용되지 않았다(근거 문구 불일치)');
  assert.ok(
    b2FormatDefects(eKind, eRow.question_text, JSON.parse(eRow.options), eAns, brokenExpl, eEvi).length > 0,
    `q${eQid} 해설에서 근거 문구를 지웠는데 판정기가 통과시켰다 — 불변식이 죽어 있다`
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK10 — 해설↔정답키 불일치 수리 254건(배치1 186 + 배치2 68) (2026-08-21)
//   증적: 보고서/증적/해설정답불일치_20260821/ · 스크립트:
//         scripts/fix-explanation-answer-mismatch-20260821.js
//
//   앞선 배치(REG-AK6~AK8)가 지킨 것은 "고치다가 **정답이 옮겨가지 않았는지**" 였다.
//   이 배치는 반대다 — **정답키 자체가 틀려서 일부러 옮긴** 것들이다.
//   지문과 해설이 한목소리로 A 칸을 정답이라 말하는데 answer 는 B 칸을 가리키고 있었다:
//     q10698 해설 "99x=27, x=27/99=3/11" ↔ answer=3 "99x=270, x=30/11"
//     q11113 "3km600m + 1km500m" 해설 "합계 5km 100m" ↔ answer=3 "5km 600m"
//     q10609 "전체집합에서 A 를 제거한 나머지" 해설 "여집합" ↔ answer=0 "교집합"
//   보기가 쉼표·수식·서술이 섞여 있어 **INV-AI6 의 수치 파서로는 영원히 안 잡힌다**
//   (PARSER_CONTRACT 가 '99x=27, x=3/11' 을 null 로 못 박고 있다 — 그것이 옳다).
//
//   ⚠ 여기서 못 박는 것은 "정답이 해설이 지목하는 칸에 가 있고, 옛 칸은 오답" 이다.
//     되돌아가면 **옳게 푼 학생이 다시 오답 처리**된다.
//   ⚠ 이 수리가 가능했던 유일한 근거는 대상 186건의 콘텐츠에 **제출 기록이 0 건**이었다는 것이다
//     (6 경로 × 186건 조회). 그 가드는 REG-AK9 가 스크립트 소스에서 잠근다.
//   · options 는 한 글자도 바꾸지 않았다 → 보기 전문을 그대로 박아 대조한다.
//   · 해설은 보기 번호 참조가 어긋난 2건(q7253 "정답은 5번"→"3번", q7254 "정답은 1번"→"3번")만
//     **번호를** 바로잡았다(q12417 선례). 해설 전문을 박아 문장이 손대지지 않았음을 함께 지킨다.
// ══════════════════════════════════════════════════════════════════════════════

// ── 해설 지목 판정 (스크립트와 **독립 구현** — 같은 버그를 공유하지 않기 위해서다) ──
const ak10Strip = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
const ak10Digit = (c) => c >= '0' && c <= '9';
const ak10Alpha = (c) => /[A-Za-z]/.test(c);
/**
 * 경계 인식 포함 판정. 단순 includes 는 `bigg` 를 `bigger` 안에서, `300` 을 `3000` 안에서
 * 잡아 오탐을 만든다(2026-08-21 조사 실측).
 * 🔴 한글에는 경계를 걸지 않는다 — 조사·어미가 붙어 이어지는 언어라 경계를 걸면 참인 지목까지
 *   떨어진다(해설 "…이므로몫은3,나머지는2이다" 안의 보기 "몫은 3").
 */
function ak10Contains(hay, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const p = hay.indexOf(needle, from);
    if (p < 0) return false;
    const before = p > 0 ? hay[p - 1] : '';
    const after = p + needle.length < hay.length ? hay[p + needle.length] : '';
    const s0 = needle[0], s1 = needle[needle.length - 1];
    let ok = true;
    // '.' 은 **소수점일 때만** 경계다. 문장 끝 마침표까지 막으면 참인 지목이 떨어진다
    //   (해설 "…n≥4이다.4봉지이상" 의 보기 "4봉지" — q12345 실측).
    const prev2 = p > 1 ? hay[p - 2] : '';
    if (ak10Digit(s0) && (ak10Digit(before) || (before === '.' && ak10Digit(prev2)) || before === '/')) ok = false;
    if (ak10Alpha(s0) && ak10Alpha(before)) ok = false;
    if (ak10Digit(s1) && (ak10Digit(after) || after === '/')) ok = false;
    if (ak10Alpha(s1) && (ak10Alpha(after) || ak10Digit(after))) ok = false;
    if (ok) return true;
    from = p + 1;
  }
}
const ak10Rhs = (a) => { const i = a.lastIndexOf('='); return i >= 0 ? a.slice(i + 1) : a; };
/** 해설이 이 보기를 결론으로 지목하는가. 'whole' | 'atoms'(쉼표 복합 보기) | null. */
function ak10NamedBy(optText, explanation) {
  const e = ak10Strip(explanation), t = ak10Strip(optText);
  if (ak10Contains(e, t)) return 'whole';
  const atoms = t.split(',').filter((a) => a.length >= 2);
  if (atoms.length >= 2 && atoms.every((a) => ak10Contains(e, a) || ak10Contains(e, ak10Rhs(a)))) return 'atoms';
  return null;
}

// [qid, 새 정답 index, 옛 정답 index, 보기 전문, 해설 전문]
const AK10_FIXED = [
  { qid: 84, ansIdx: 1, staleIdx: 2,
    options: ["0.8","8","80","0.08"],
    explanation: "6.4 ÷ 0.8 = 64 ÷ 8 = 8" },
  { qid: 133, ansIdx: 1, staleIdx: 3,
    options: ["1 m/s","10 m/s","100 m/s","1000 m/s"],
    explanation: "속력 = 거리 ÷ 시간 = 100m ÷ 10초 = 10 m/s" },
  { qid: 165, ansIdx: 1, staleIdx: 2,
    options: ["613","623","523","633"],
    explanation: "345 + 278: 일의 자리 5+8=13(올림1), 십의 자리 4+7+1=12(올림1), 백의 자리 3+2+1=6 → 623" },
  { qid: 166, ansIdx: 0, staleIdx: 1,
    options: ["335","345","325","435"],
    explanation: "502 - 167: 받아내림을 하면 335가 됩니다." },
  { qid: 169, ansIdx: 2, staleIdx: 3,
    options: ["30","300","3000","30000"],
    explanation: "1 km = 1000 m이므로 3 km = 3000 m입니다." },
  { qid: 170, ansIdx: 1, staleIdx: 2,
    options: ["613","623","523","633"],
    explanation: "345 + 278: 일의 자리 5+8=13(올림1), 십의 자리 4+7+1=12(올림1), 백의 자리 3+2+1=6 → 623" },
  { qid: 171, ansIdx: 1, staleIdx: 2,
    options: ["3.3","4.3","4.13","3.13"],
    explanation: "2.5 + 1.8 = 4.3입니다." },
  { qid: 187, ansIdx: 1, staleIdx: 2,
    options: ["613","623","523","633"],
    explanation: "345 + 278: 일의 자리 5+8=13(올림1), 십의 자리 4+7+1=12(올림1), 백의 자리 3+2+1=6 → 623" },
  { qid: 195, ansIdx: 1, staleIdx: 2,
    options: ["613","623","523","633"],
    explanation: "345 + 278: 일의 자리 5+8=13(올림1), 십의 자리 4+7+1=12(올림1), 백의 자리 3+2+1=6 → 623" },
  { qid: 201, ansIdx: 1, staleIdx: 2,
    options: ["613","623","523","633"],
    explanation: "345 + 278: 일의 자리 5+8=13(올림1), 십의 자리 4+7+1=12(올림1), 백의 자리 3+2+1=6 → 623" },
  { qid: 202, ansIdx: 0, staleIdx: 1,
    options: ["335","345","325","435"],
    explanation: "502 - 167: 받아내림을 하면 335가 됩니다." },
  { qid: 223, ansIdx: 2, staleIdx: 3,
    options: ["5자리","6자리","7자리","8자리"],
    explanation: "100만 = 1,000,000 (7자리)." },
  { qid: 3217, ansIdx: 2, staleIdx: 1,
    options: ["6726","6416","6816","6916"],
    explanation: "213×32 = 213×30 + 213×2 = 6390 + 426 = 6816입니다. 정답은 6816이나 선택지 수정이 필요합니다. 가장 가까운 6816은 세 번째입니다." },
  { qid: 3306, ansIdx: 2, staleIdx: 0,
    options: ["2.5cm","2cm","5cm","10cm"],
    explanation: "평행선 사이 어느 곳의 수직 거리도 5cm이므로, 가운데 수직선은 5cm입니다." },
  { qid: 3410, ansIdx: 0, staleIdx: 2,
    options: ["1과 4/9","2와 5/9","1과 5/9","2와 4/9"],
    explanation: "받아내림: (3과 11/9) - (2과 7/9) = 1과 4/9입니다." },
  { qid: 3571, ansIdx: 2, staleIdx: 1,
    options: ["10cm","14cm","12cm","11cm"],
    explanation: "84÷7=12cm입니다." },
  { qid: 3651, ansIdx: 2, staleIdx: 3,
    options: ["4/9 < 5/12 < 0.45","0.45 < 5/12 < 4/9","5/12 < 4/9 < 0.45","5/12 < 0.45 < 4/9"],
    explanation: "5/12≈0.417, 0.45=0.45, 4/9≈0.444이므로 5/12 < 4/9 < 0.45입니다." },
  { qid: 4737, ansIdx: 2, staleIdx: 1,
    options: ["6726","6416","6816","6916"],
    explanation: "213×32 = 213×30 + 213×2 = 6390 + 426 = 6816입니다. 정답은 6816이나 선택지 수정이 필요합니다. 가장 가까운 6816은 세 번째입니다." },
  { qid: 4826, ansIdx: 2, staleIdx: 0,
    options: ["2.5cm","2cm","5cm","10cm"],
    explanation: "평행선 사이 어느 곳의 수직 거리도 5cm이므로, 가운데 수직선은 5cm입니다." },
  { qid: 4922, ansIdx: 0, staleIdx: 2,
    options: ["1과 4/9","2와 5/9","1과 5/9","2와 4/9"],
    explanation: "받아내림: (3과 11/9) - (2과 7/9) = 1과 4/9입니다." },
  { qid: 5083, ansIdx: 2, staleIdx: 1,
    options: ["10cm","14cm","12cm","11cm"],
    explanation: "84÷7=12cm입니다." },
  { qid: 5163, ansIdx: 2, staleIdx: 3,
    options: ["4/9 < 5/12 < 0.45","0.45 < 5/12 < 4/9","5/12 < 4/9 < 0.45","5/12 < 0.45 < 4/9"],
    explanation: "5/12≈0.417, 0.45=0.45, 4/9≈0.444이므로 5/12 < 4/9 < 0.45입니다." },
  { qid: 7253, ansIdx: 2, staleIdx: 4,
    options: ["파란 것이 빨간 것보다 3개 더 많습니다","빨간 것이 파란 것보다 2개 더 많습니다","파란 것이 빨간 것보다 2개 더 많습니다","빨간 것과 파란 것의 수가 같습니다","파란 것이 가장 적습니다"],
    explanation: "정답은 3번이다. 파란 것 5개, 빨간 것 3개이므로 파란 것이 5-3=2개 더 많다. 따라서 '파란 것이 빨간 것보다 2개 더 많습니다'가 옳다. ①은 차이를 3개로 잘못 계산했고, ②는 빨간 것과 파란 것을 바꾸어 말했으며, ④⑤는 사실과 다르다." },
  { qid: 7254, ansIdx: 2, staleIdx: 0,
    options: ["사과가 가장 적습니다","귤이 가장 적습니다","바나나가 가장 적습니다","사과와 귤이 가장 적습니다","귤과 바나나가 가장 적습니다"],
    explanation: "정답은 3번이다. 사과 6개, 귤 4개, 바나나 2개 중 가장 적은 것은 바나나 2개이다. 따라서 '바나나가 가장 적습니다'가 옳은 표현이다. ①사과는 가장 많은 것이고, ②귤은 두 번째이다. 분류 결과를 수로 비교한 뒤 정확히 말해야 한다." },
  { qid: 8249, ansIdx: 1, staleIdx: 0,
    options: ["학생의 키와 교실의 넓이","자동차의 수와 바퀴의 수","날씨와 교과서 권수","요일과 학생 이름","색연필 색깔과 연필 길이"],
    explanation: "정답은 '자동차의 수와 바퀴의 수'이다. 자동차 1대에 바퀴가 4개이므로 자동차 수가 늘어날수록 바퀴 수도 정확히 4배씩 늘어난다. 나머지 선택지는 한 양이 변해도 다른 양이 일정하게 따라 변하지 않으므로 대응 관계가 아니다." },
  { qid: 8254, ansIdx: 1, staleIdx: 3,
    options: ["날수+23=시간","날수×24=시간","날수×12=시간","날수+48=시간","날수×48=시간"],
    explanation: "정답은 '날수×24=시간'이다. 1일=24시간이므로 날수에 24를 곱하면 시간이 된다. '날수×12'는 절반 단위인 12시간을 잘못 적용한 경우, '날수+23'은 덧셈 관계로 잘못 이해한 경우이다." },
  { qid: 8258, ansIdx: 2, staleIdx: 1,
    options: ["전체 돌 수=한 변의 돌 수+4","전체 돌 수=한 변의 돌 수×4","전체 돌 수=한 변의 돌 수×한 변의 돌 수","전체 돌 수=한 변의 돌 수+한 변의 돌 수","전체 돌 수=한 변의 돌 수×2+4"],
    explanation: "정답은 '전체 돌 수=한 변의 돌 수×한 변의 돌 수'이다. 한 변에 돌이 n개이면 정사각형 모양의 전체 돌 수는 n×n이다. 예를 들어 한 변이 3개이면 3×3=9개이다. '×4'는 테두리만 센 오류이며, '+4'는 규칙을 덧셈으로 잘못 파악한 경우이다." },
  { qid: 8264, ansIdx: 2, staleIdx: 1,
    options: ["□+4=△","□×2=△","□×3=△","△÷□=4","□+△=8"],
    explanation: "정답은 '□×3=△'이다. 2×3=6, 4×3=12, 6×3=18, 8×3=24로 □에 3을 곱하면 △가 된다. '□×2'는 비율을 절반으로 잘못 파악한 경우, '□+4'는 곱셈 관계를 덧셈으로 잘못 이해한 경우이다." },
  { qid: 8273, ansIdx: 1, staleIdx: 4,
    options: ["두 양의 합을 나타낸다","두 양의 관계를 간결하게 표현한다","두 양의 크기를 비교한다","두 양의 순서를 정한다","두 양의 차이를 나타낸다"],
    explanation: "정답은 '두 양의 관계를 간결하게 표현한다'이다. □, △ 같은 기호를 사용하면 변하는 두 양 사이의 대응 규칙을 하나의 식으로 간결하게 나타낼 수 있다. 이를 통해 특정 값을 대입하여 다른 값을 구할 수 있다." },
  { qid: 8274, ansIdx: 1, staleIdx: 0,
    options: ["□+500=△","□×500=△","□×200=△","△+□=500","□×1000=△"],
    explanation: "정답은 '□×500=△'이다. 사과 1개에 500원이므로 사과 수(□)에 500을 곱하면 가격(△)이 된다. '□+500'은 곱셈 관계를 덧셈으로 잘못 표현한 경우, '□×1000'은 단가를 두 배로 잘못 적용한 경우이다." },
  { qid: 9614, ansIdx: 0, staleIdx: 2,
    options: ["2.3×1.4","1.5×2.0","1.8×1.6","2.1×1.3"],
    explanation: "2.3×1.4=3.22, 1.5×2.0=3.0, 1.8×1.6=2.88, 2.1×1.3=2.73이므로 가장 큰 것은 1.8×1.6=2.88입니다. 아, 재계산: 2.3×1.4=3.22가 가장 큽니다." },
  { qid: 9821, ansIdx: 2, staleIdx: 0,
    options: ["직선 AB","반직선 AB","선분 AB","곡선 AB"],
    explanation: "두 점 A, B를 잇는 선분은 \"선분 AB\"라고 나타냅니다." },
  { qid: 9856, ansIdx: 1, staleIdx: 3,
    options: ["a/b ÷ c/d = b/a × d/c","a/b ÷ c/d = a/b × d/c","a/b ÷ c/d = b/a × c/d","a/b ÷ c/d = a/b × c/d"],
    explanation: "분수를 분수로 나눌 때는 나누는 분수의 역수를 곱합니다. a/b ÷ c/d = a/b × d/c" },
  { qid: 9862, ansIdx: 1, staleIdx: 3,
    options: ["4 × 2/3 = 8/3","4 × 3/2 = 6","4 ÷ 3/2 = 8/3","4 + 2/3 = 4와 2/3"],
    explanation: "(자연수)÷(분수)는 나누는 분수의 역수를 곱합니다. 4 ÷ 2/3 = 4 × 3/2 = 6" },
  { qid: 10022, ansIdx: 2, staleIdx: 0,
    options: ["Q⊂P","P=Q","P⊂Q","P∩Q=∅"],
    explanation: "p→q가 참이려면 P⊂Q이어야 한다. 즉, p가 참인 모든 경우에 q도 참이므로 P⊂Q가 충분조건의 조건이다." },
  { qid: 10063, ansIdx: 2, staleIdx: 1,
    options: ["y = 2x + 3","y = -3x + 2","y = 2x - 3","y = -2x + 3"],
    explanation: "기울기가 2이면 x의 계수가 2, y절편이 -3이면 상수항이 -3이므로 y = 2x - 3이다." },
  { qid: 10066, ansIdx: 0, staleIdx: 3,
    options: ["y = -2x + 4","y = x + 4","y = -x + 4","y = 2x + 4"],
    explanation: "기울기 = (0-4)/(2-0) = -2이고 y절편이 4이므로 y = -2x + 4이다." },
  { qid: 10074, ansIdx: 0, staleIdx: 1,
    options: ["y = -3x + 2","y = -3x + 1","y = -3x - 4","y = 3x - 4"],
    explanation: "y=-3x+b에 (2,-4)를 대입하면 -4=-6+b, b=2이므로 y=-3x+2이다." },
  { qid: 10075, ansIdx: 1, staleIdx: 0,
    options: ["y = x + 3","y = 2x + 1","y = 2x - 1","y = 3x - 2"],
    explanation: "기울기=(7-3)/(3-1)=2. y=2x+b에 (1,3)을 대입하면 b=1. y=2x+1이다." },
  { qid: 10087, ansIdx: 3, staleIdx: 1,
    options: ["(a+m, b-n)","(a-m, b-n)","(a-m, b+n)","(a+m, b+n)"],
    explanation: "평행이동: x방향으로 m, y방향으로 n이면 좌표는 (a+m, b+n)이다." },
  { qid: 10090, ansIdx: 2, staleIdx: 1,
    options: ["(-3, 5)","(3, -5)","(-3, -5)","(5, 3)"],
    explanation: "원점 대칭이동: (a, b) → (-a, -b)이므로 (3, 5) → (-3, -5)이다." },
  { qid: 10094, ansIdx: 1, staleIdx: 0,
    options: ["(3, 4)","(-3, -4)","(-3, 4)","(4, -3)"],
    explanation: "y축 대칭은 x좌표의 부호만 반전: (3, -4) → (-3, -4)이다." },
  { qid: 10096, ansIdx: 1, staleIdx: 3,
    options: ["(5, -2)","(2, 5)","(-2, -5)","(-5, 2)"],
    explanation: "y=x 대칭: (a, b) → (b, a). (5, 2) → (2, 5)이다." },
  { qid: 10098, ansIdx: 1, staleIdx: 3,
    options: ["B'(−3, 2)","C'(2, 6)","모두 같다","A'(−1, 4)"],
    explanation: "y축 대칭: x부호 반전. A'(-1,4), B'(-3,2), C'(2,6). x좌표 최대는 C'의 2이다." },
  { qid: 10100, ansIdx: 3, staleIdx: 0,
    options: ["5/3","4/4","3/2","2/5"],
    explanation: "진분수는 분자 < 분모인 분수이므로 2/5가 진분수이다." },
  { qid: 10111, ansIdx: 2, staleIdx: 3,
    options: ["x > 2","x² - 3x + 2 > 0","x + 1 > x - 1","(x-1)(x-2) > 0"],
    explanation: "x+1 > x-1은 1 > -1로 정리되어 모든 실수 x에 대해 항상 성립하는 절대부등식이다." },
  { qid: 10171, ansIdx: 1, staleIdx: 3,
    options: ["75","105","150","90"],
    explanation: "원에 내접하는 사각형의 대각의 합은 180°이므로 ∠C=180°-75°=105°." },
  { qid: 10174, ansIdx: 2, staleIdx: 0,
    options: ["25°","100°","50°","130°"],
    explanation: "접선과 현이 이루는 각(접선각)은 그 호에 대한 원주각과 크기가 같으므로 50°." },
  { qid: 10175, ansIdx: 2, staleIdx: 0,
    options: ["35°","140°","70°","110°"],
    explanation: "접선과 현이 이루는 각 = 그 현에 대한 원주각이므로 ∠ACB=70°." },
  { qid: 10176, ansIdx: 3, staleIdx: 1,
    options: ["130°","32.5°","90°","65°"],
    explanation: "접선과 현이 이루는 각 = 그 호에 대한 원주각 = 65°." },
  { qid: 10186, ansIdx: 1, staleIdx: 3,
    options: ["90°","180°","270°","360°"],
    explanation: "원에 내접하는 사각형의 대각의 합은 180°." },
  { qid: 10197, ansIdx: 1, staleIdx: 3,
    options: ["5바구니","6바구니","4바구니","7바구니"],
    explanation: "4×(1과1/2) = 4×3/2 = 12/2 = 6바구니." },
  { qid: 10198, ansIdx: 1, staleIdx: 0,
    options: ["6리터","7리터","8리터","9리터"],
    explanation: "3×(2과1/3) = 3×7/3 = 7리터." },
  { qid: 10199, ansIdx: 3, staleIdx: 0,
    options: ["15m","18m","16m","18과 3/4m"],
    explanation: "5×(3과3/4) = 5×15/4 = 75/4 = 18과3/4m." },
  { qid: 10373, ansIdx: 0, staleIdx: 3,
    options: ["665","670","630","656"],
    explanation: "7×95=665이므로 □=665이다." },
  { qid: 10561, ansIdx: 1, staleIdx: 0,
    options: ["{1, 2, 3, 4}","{x | x는 5보다 작은 자연수}","{x | x < 5}","{x ∈ 자연수 | x ≤ 5}"],
    explanation: "조건제시법은 원소의 공통 조건을 기술하는 방식으로 {x | x는 5보다 작은 자연수}가 정확히 조건을 담은 조건제시법이다." },
  { qid: 10576, ansIdx: 0, staleIdx: 2,
    options: ["P, R, Q","P, Q, R","R, P, Q","Q, R, P"],
    explanation: "n(P) = 5(1,2,3,4,5), Q = {1,2}이므로 n(Q) = 2, R = {1,2,4}이므로 n(R) = 3이다. 많은 순서: P(5) > R(3) > Q(2)이므로 P, R, Q이다." },
  { qid: 10590, ansIdx: 2, staleIdx: 0,
    options: ["{c}","{a, b, d, e}","{a, b, c, d, e}","{a, b, c, c, d, e}"],
    explanation: "합집합 A∪B는 A 또는 B에 속하는 원소 전체의 집합이다. 중복 없이 나열하면 {a, b, c, d, e}이다." },
  { qid: 10591, ansIdx: 1, staleIdx: 0,
    options: ["{1, 2, 4}","{2, 3, 4, 5}","{3, 4, 5}","{2, 4, 5}"],
    explanation: "A∩B = {3,5}이므로 3, 5는 B에 속한다. A∪B = {1,2,3,4,5}이고 A에 없는 2, 4도 B에 속해야 한다. 따라서 B = {2, 3, 4, 5}이다." },
  { qid: 10600, ansIdx: 1, staleIdx: 3,
    options: ["A∩B = B∩A","(A∩B)∩C = A∩(B∩C)","A∩(B∪C) = (A∩B)∪(A∩C)","A∪∅ = A"],
    explanation: "결합법칙은 괄호의 묶음 방식을 바꾸어도 결과가 같다는 법칙으로 (A∩B)∩C = A∩(B∩C)가 해당한다." },
  { qid: 10601, ansIdx: 2, staleIdx: 3,
    options: ["A∩(B∪C) = (A∩B)∪(A∩C)","A∪(B∩C) = (A∪B)∩(A∪C)","A∩(B∩C) = (A∩B)∩(A∩C)","①과 ②는 모두 올바른 분배법칙이다."],
    explanation: "①, ②는 올바른 분배법칙이다. ③ A∩(B∩C) = (A∩B)∩(A∩C)는 분배법칙이 아니라 결합법칙의 잘못된 변형이다." },
  { qid: 10603, ansIdx: 3, staleIdx: 1,
    options: ["A∪B = B∪A","A∩B = B∩A","A∩(B∪C) = (B∪C)∩A","A∪(B∩C) = (B∩C)∩A"],
    explanation: "①, ②, ③은 교환법칙이 성립한다. ④는 A∪(B∩C) = (B∩C)∩A가 되어 ∪과 ∩이 다르므로 성립하지 않는다." },
  { qid: 10605, ansIdx: 2, staleIdx: 1,
    options: ["n(A∩B) = 3","n(B) = 8","n(A∪B) = 15","n(A) = 10"],
    explanation: "n(A∪B) = 10 + 8 - 3 = 15이므로 가장 큰 값은 n(A∪B) = 15이다." },
  { qid: 10609, ansIdx: 2, staleIdx: 0,
    options: ["교집합","합집합","여집합","부분집합"],
    explanation: "여집합 A^c는 전체집합 U에서 A에 속하는 원소를 제거한 집합, 즉 U에 속하지만 A에는 속하지 않는 원소들의 집합이다." },
  { qid: 10610, ansIdx: 1, staleIdx: 3,
    options: ["A^c = {x | x ∉ U}","A^c = {x ∈ U | x ∉ A}","A^c = {x | x ∈ A}","A^c = U∩A"],
    explanation: "여집합은 전체집합 U의 원소 중 A에 속하지 않는 원소들의 집합이므로 A^c = {x ∈ U | x ∉ A}이다." },
  { qid: 10690, ansIdx: 3, staleIdx: 1,
    options: ["1/4","3/20","7/25","5/6"],
    explanation: "6=2×3이므로 5/6은 분모에 소인수 3 포함 → 유한소수 불가." },
  { qid: 10697, ansIdx: 2, staleIdx: 1,
    options: ["3/10","1/4","1/3","3/100"],
    explanation: "9x=3이므로 x=3/9=1/3이다." },
  { qid: 10698, ansIdx: 0, staleIdx: 3,
    options: ["99x=27, x=3/11","99x=27, x=27/100","99x=2.7, x=3/11","99x=270, x=30/11"],
    explanation: "100x=27.2727…, x=0.2727…이므로 99x=27, x=27/99=3/11." },
  { qid: 10707, ansIdx: 3, staleIdx: 1,
    options: ["3.14159265…(원주율 π)","1.41421356…(√2)","2.71828182…(자연로그 e)","0.272727…"],
    explanation: "0.272727…=3/11이므로 유리수. 나머지는 무리수." },
  { qid: 10716, ansIdx: 3, staleIdx: 1,
    options: ["0으로 나타낸다","Ω으로 나타낸다","{ }이 아니라 반드시 ∅로만 써야 한다","∅ 또는 { }로 나타낸다"],
    explanation: "공집합은 원소가 없는 집합으로 ∅ 또는 { }로 나타낸다." },
  { qid: 10718, ansIdx: 1, staleIdx: 0,
    options: ["{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10}","{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}","{1, 2, 3, …}","{x | x ≤ 10}"],
    explanation: "10 이하의 자연수는 1부터 10까지이므로 {1,2,3,4,5,6,7,8,9,10}이다." },
  { qid: 10740, ansIdx: 0, staleIdx: 3,
    options: ["{7,9}","{3,5}","{1,3,5}","{7,8,9}"],
    explanation: "A-B는 A에 속하고 B에 속하지 않는 원소이므로 {7,9}이다." },
  { qid: 10743, ansIdx: 0, staleIdx: 3,
    options: ["{4,5}","{1,2,3}","{1,2,3,4,5}","∅"],
    explanation: "A^c는 전체집합에서 A에 속하지 않는 원소들의 집합이므로 {4,5}이다." },
  { qid: 10744, ansIdx: 0, staleIdx: 2,
    options: ["B^c","B","A^c","A"],
    explanation: "A-B = A에 속하고 B에 속하지 않는 원소 = A∩B^c이다." },
  { qid: 10745, ansIdx: 0, staleIdx: 2,
    options: ["A","U","∅","A^c"],
    explanation: "여집합의 여집합은 원래 집합이므로 (A^c)^c = A이다." },
  { qid: 10763, ansIdx: 0, staleIdx: 3,
    options: ["3L 300mL","3L 700mL","3L 100mL","4L 300mL"],
    explanation: "5L-2L=3L, 700mL-400mL=300mL이므로 3L 300mL이다." },
  { qid: 10765, ansIdx: 0, staleIdx: 3,
    options: ["y-2=3(x-1)","y+2=3(x+1)","y=3x+2","y-1=3(x-2)"],
    explanation: "점-기울기 형식: y-y1=m(x-x1)에서 y-2=3(x-1)이다." },
  { qid: 10771, ansIdx: 0, staleIdx: 3,
    options: ["|pa+qb+r| / √(p²+q²)","|pa+qb+r| / (p+q)","(pa+qb+r) / √(p²+q²)","|pa-qb+r| / √(p²+q²)"],
    explanation: "점과 직선 사이의 거리 = |pa+qb+r| / √(p²+q²)이다." },
  { qid: 10788, ansIdx: 0, staleIdx: 2,
    options: ["720°","360°","540°","900°"],
    explanation: "n각형 내각의 합 = (n-2)×180°. 육각형: (6-2)×180° = 720°이다." },
  { qid: 10801, ansIdx: 0, staleIdx: 2,
    options: ["10cm","8cm","9cm","12cm"],
    explanation: "3:5=6:x이므로 x=10cm입니다." },
  { qid: 10802, ansIdx: 1, staleIdx: 0,
    options: ["10cm","12cm","9cm","6cm"],
    explanation: "2:3=8:x이므로 x=12cm입니다." },
  { qid: 10804, ansIdx: 2, staleIdx: 0,
    options: ["10cm","9cm","12cm","15cm"],
    explanation: "4:6=x:18이므로 x=12cm입니다." },
  { qid: 10810, ansIdx: 3, staleIdx: 2,
    options: ["2:3","3:2","6:9","4:9"],
    explanation: "넓이의 비는 닮음비의 제곱이므로 2²:3²=4:9입니다." },
  { qid: 10811, ansIdx: 1, staleIdx: 3,
    options: ["12cm²","16cm²","18cm²","20cm²"],
    explanation: "넓이비는 3²:4²=9:16이므로 9:16=9:x에서 x=16cm²입니다." },
  { qid: 10813, ansIdx: 3, staleIdx: 1,
    options: ["2:3","4:9","6:27","8:27"],
    explanation: "부피의 비는 닮음비의 세제곱이므로 2³:3³=8:27입니다." },
  { qid: 10827, ansIdx: 3, staleIdx: 0,
    options: ["1:2","2:3","3:4","3:5"],
    explanation: "AD:AB=6:10=3:5이므로 닮음비는 3:5입니다." },
  { qid: 10895, ansIdx: 2, staleIdx: 0,
    options: ["1:1","1:2","2:1","3:1"],
    explanation: "삼각형의 무게중심은 꼭짓점에서 중선을 2:1로 나누는 점이다." },
  { qid: 10897, ansIdx: 2, staleIdx: 0,
    options: ["12cm","18cm","24cm","36cm"],
    explanation: "무게중심에서 꼭짓점까지의 거리는 각 중선의 2/3이므로 합은 36×(2/3)=24cm이다." },
  { qid: 10899, ansIdx: 2, staleIdx: 1,
    options: ["10cm","12cm","15cm","20cm"],
    explanation: "BG=2/3×BM이므로 BM=10÷(2/3)=15cm이다." },
  { qid: 10907, ansIdx: 1, staleIdx: 3,
    options: ["(밑넓이) × (높이)","(밑넓이) × 2 + (옆넓이)","(옆넓이) × 2 + (높이)","(밑넓이) + (옆넓이)"],
    explanation: "기둥의 겉넓이 = (밑넓이) × 2 + (옆넓이)이다." },
  { qid: 10915, ansIdx: 0, staleIdx: 3,
    options: ["몫은 3, 나머지는 2이다","몫은 2, 나머지는 7이다","몫은 5, 나머지는 0이다","몫은 4, 나머지는 1이다"],
    explanation: "17÷5=3...2이므로 몫은 3, 나머지는 2이다." },
  { qid: 10922, ansIdx: 2, staleIdx: 0,
    options: ["500g","750g","1000g","1500g"],
    explanation: "500 × 2 = 1000g이다." },
  { qid: 10929, ansIdx: 2, staleIdx: 0,
    options: ["1200g","1400g","1600g","1800g"],
    explanation: "500×2+200×3=1000+600=1600g이다." },
  { qid: 10930, ansIdx: 2, staleIdx: 1,
    options: ["700g","750g","800g","850g"],
    explanation: "□+150=950, □=800g이다." },
  { qid: 10938, ansIdx: 2, staleIdx: 1,
    options: ["1kg=100g이다","2000g=1kg이다","3kg=3000g이다","500g=1kg이다"],
    explanation: "1kg=1000g이므로 3kg=3000g이다." },
  { qid: 10939, ansIdx: 2, staleIdx: 0,
    options: ["204g","240g","2400g","24000g"],
    explanation: "2kg 400g = 2000+400 = 2400g이다." },
  { qid: 10940, ansIdx: 1, staleIdx: 3,
    options: ["5kg 30g","5kg 300g","53kg 0g","5kg 3g"],
    explanation: "5300g = 5000+300 = 5kg 300g이다." },
  { qid: 10944, ansIdx: 1, staleIdx: 0,
    options: ["400kg","500kg","600kg","700kg"],
    explanation: "10×50=500kg이고 1t=1000kg이므로 1000-500=500kg이다." },
  { qid: 11096, ansIdx: 3, staleIdx: 2,
    options: ["10m","100m","10000m","1000m"],
    explanation: "1km=1000m입니다." },
  { qid: 11097, ansIdx: 2, staleIdx: 1,
    options: ["2050m","25000m","2500m","2050m"],
    explanation: "2km=2000m, 2000+500=2500m" },
  { qid: 11101, ansIdx: 0, staleIdx: 2,
    options: ["1km 600m","16km 0m","1km 400m","4km 0m"],
    explanation: "400×4=1600m=1km 600m" },
  { qid: 11108, ansIdx: 1, staleIdx: 0,
    options: ["52cm 0mm","5cm 2mm","50cm 2mm","5cm 20mm"],
    explanation: "52÷10=5나머지2, 즉 5cm 2mm" },
  { qid: 11111, ansIdx: 3, staleIdx: 2,
    options: ["430m","43000m","4030m","4300m"],
    explanation: "4km=4000m, 4000+300=4300m" },
  { qid: 11112, ansIdx: 2, staleIdx: 0,
    options: ["75km 0m","7km 50m","7km 500m","750km 0m"],
    explanation: "7500÷1000=7나머지500, 즉 7km 500m" },
  { qid: 11113, ansIdx: 1, staleIdx: 3,
    options: ["4km 100m","5km 100m","4km 500m","5km 600m"],
    explanation: "3km+1km=4km, 600m+500m=1100m=1km100m. 합계 5km 100m" },
  { qid: 11114, ansIdx: 1, staleIdx: 0,
    options: ["3km 200m","4km 200m","3km 800m","4km 800m"],
    explanation: "2km800m+1km400m=3km1200m=4km200m" },
  { qid: 11118, ansIdx: 1, staleIdx: 0,
    options: ["202","212","203","222"],
    explanation: "3×4=12(일의 자리 2, 올림 1), 5×4=20+1=21 → 212" },
  { qid: 11119, ansIdx: 3, staleIdx: 2,
    options: ["482","442","423","432"],
    explanation: "2×6=12(일의 자리 2, 올림 1), 7×6=42+1=43 → 432" },
  { qid: 11123, ansIdx: 1, staleIdx: 0,
    options: ["242개","252개","245개","262개"],
    explanation: "36×7: 6×7=42(올림4), 3×7=21+4=25 → 252개" },
  { qid: 11153, ansIdx: 1, staleIdx: 0,
    options: ["307mm","37mm","370mm","3070mm"],
    explanation: "3cm=30mm, 30+7=37mm" },
  { qid: 11154, ansIdx: 0, staleIdx: 3,
    options: ["1km 600m","16km 0m","1km 400m","4km 0m"],
    explanation: "400×4=1600m=1km 600m" },
  { qid: 11156, ansIdx: 2, staleIdx: 1,
    options: ["5cm=50mm — 틀렸다","5cm=5mm — 맞다","5cm=50mm — 맞다","50mm=500cm — 맞다"],
    explanation: "5cm=50mm이므로 \"5cm=50mm — 맞다\"입니다." },
  { qid: 11165, ansIdx: 2, staleIdx: 0,
    options: ["380원","395원","390원","400원"],
    explanation: "78×5=390원" },
  { qid: 11166, ansIdx: 1, staleIdx: 3,
    options: ["242개","252개","245개","262개"],
    explanation: "36×7: 6×7=42(올림4), 3×7=21+4=25 → 252개" },
  { qid: 11169, ansIdx: 1, staleIdx: 0,
    options: ["71×2","62×2","53×3","44×3"],
    explanation: "53×3=159, 62×2=124, 71×2=142, 44×3=132. 가장 작은 것은 62×2=124입니다. 잘못된 선지 확인: 62×2=124가 가장 작습니다." },
  { qid: 11186, ansIdx: 1, staleIdx: 3,
    options: ["9.42cm","18.84cm","15.7cm","12.56cm"],
    explanation: "옆면 가로는 밑면 원의 둘레와 같으므로 2×3×3.14=18.84cm이다." },
  { qid: 11187, ansIdx: 1, staleIdx: 0,
    options: ["4cm","8cm","12cm","16cm"],
    explanation: "지름은 반지름의 2배이므로 4×2=8cm이다." },
  { qid: 11189, ansIdx: 2, staleIdx: 0,
    options: ["6cm","4cm","8cm","5cm"],
    explanation: "반지름² = 모선²-높이² = 100-36 = 64, 반지름=8cm이다." },
  { qid: 11192, ansIdx: 1, staleIdx: 3,
    options: ["3cm","4cm","5cm","6cm"],
    explanation: "높이² = 모선²-반지름² = 25-9=16, 높이=4cm이다." },
  { qid: 11204, ansIdx: 1, staleIdx: 0,
    options: ["329.7cm²","659.4cm²","439.6cm²","219.8cm²"],
    explanation: "옆면 넓이 = 둘레 × 높이 = 2×7×3.14×15 = 659.4cm²이다." },
  { qid: 11225, ansIdx: 1, staleIdx: 3,
    options: ["10cm","5cm","20cm","25cm"],
    explanation: "반지름은 지름의 절반이므로 10÷2=5cm이다." },
  { qid: 11229, ansIdx: 2, staleIdx: 1,
    options: ["8cm","10cm","12cm","6cm"],
    explanation: "반지름² = 13²-5² = 169-25 = 144, 반지름=12cm이다." },
  { qid: 11239, ansIdx: 1, staleIdx: 0,
    options: ["5 cm","10 cm","20 cm","40 cm"],
    explanation: "반지름은 지름의 절반이므로 20÷2=10 cm입니다." },
  { qid: 11248, ansIdx: 0, staleIdx: 1,
    options: ["원 2개, 직사각형 1개","삼각형 2개, 직사각형 1개","원 1개, 직사각형 2개","원 2개, 직사각형 2개"],
    explanation: "원기둥의 전개도는 원 2개(위·아래 밑면)와 직사각형 1개(옆면)로 이루어집니다." },
  { qid: 11255, ansIdx: 1, staleIdx: 0,
    options: ["6.28 cm","12.56 cm","10 cm","4 cm"],
    explanation: "가로 = 밑면 원둘레 = 2×2×3.14 = 12.56 cm" },
  { qid: 11256, ansIdx: 1, staleIdx: 3,
    options: ["21 cm²","131.88 cm²","42 cm²","65.94 cm²"],
    explanation: "옆면 가로=2×3×3.14=18.84cm, 세로=7cm. 넓이=18.84×7=131.88 cm²" },
  { qid: 11258, ansIdx: 2, staleIdx: 1,
    options: ["15.7 cm","10 cm","31.4 cm","78.5 cm"],
    explanation: "가로 = 밑면 원둘레 = 2×5×3.14 = 31.4 cm" },
  { qid: 11262, ansIdx: 1, staleIdx: 0,
    options: ["45°","60°","90°","120°"],
    explanation: "정삼각형의 세 각의 합은 180°이고, 모두 같으므로 각 하나는 60°입니다." },
  { qid: 11264, ansIdx: 2, staleIdx: 1,
    options: ["80°","60°","90°","120°"],
    explanation: "삼각형의 세 각의 합은 180°이므로 180-30-60=90°입니다. 이 삼각형은 직각삼각형입니다." },
  { qid: 11273, ansIdx: 3, staleIdx: 1,
    options: ["160 m","120 m","200 m","240 m"],
    explanation: "직사각형 둘레 = (80+40)×2 = 120×2 = 240m" },
  { qid: 11274, ansIdx: 2, staleIdx: 1,
    options: ["100 cm²","46 cm²","120 cm²","23 cm²"],
    explanation: "직사각형 넓이 = 가로×세로 = 15×8 = 120 cm²" },
  { qid: 11313, ansIdx: 1, staleIdx: 0,
    options: ["5L-3L-2L","2L-3L-5L","3L-2L-5L","5L-2L-3L"],
    explanation: "2L<3L<5L이므로 2L-3L-5L 순입니다." },
  { qid: 11316, ansIdx: 2, staleIdx: 1,
    options: ["10mL","100mL","1000mL","10000mL"],
    explanation: "1L=1000mL입니다." },
  { qid: 11321, ansIdx: 1, staleIdx: 3,
    options: ["3L 20mL","3L 200mL","32L","320L"],
    explanation: "3200mL=3000mL+200mL=3L 200mL입니다." },
  { qid: 11328, ansIdx: 1, staleIdx: 0,
    options: ["x=1 또는 x=6","x=2 또는 x=3","x=-2 또는 x=-3","x=1 또는 x=5"],
    explanation: "(x-2)(x-3)=0이므로 x=2 또는 x=3입니다." },
  { qid: 11329, ansIdx: 1, staleIdx: 0,
    options: ["x=2 또는 x=3","x=-3 또는 x=2","x=3 또는 x=-2","x=-2 또는 x=-3"],
    explanation: "(x+3)(x-2)=0이므로 x=-3 또는 x=2입니다." },
  { qid: 11335, ansIdx: 2, staleIdx: 0,
    options: ["x=5만","x=-5만","x=5 또는 x=-5","x=25 또는 x=-25"],
    explanation: "x²=25에서 x=±5이므로 x=5 또는 x=-5입니다." },
  { qid: 11401, ansIdx: 1, staleIdx: 0,
    options: ["8x + 6y","8x - 2y","8x - 6y","6x - 2y"],
    explanation: "x항: 3x+5x=8x, y항: 2y-4y=-2y. 결과: 8x-2y." },
  { qid: 11413, ansIdx: 0, staleIdx: 3,
    options: ["4x + 7y","3x + 7y","4x + 3y","2x + 7y"],
    explanation: "(3x+2y)+(x+5y)=4x+7y." },
  { qid: 11414, ansIdx: 1, staleIdx: 2,
    options: ["7a + 4b","3a + 4b","7a + 2b","3a + 2b"],
    explanation: "(5a+3b)-(2a-b)=5a+3b-2a+b=3a+4b." },
  { qid: 11429, ansIdx: 0, staleIdx: 3,
    options: ["(나)-(다)-(가)","(가)-(나)-(다)","(다)-(나)-(가)","(나)-(가)-(다)"],
    explanation: "(가)=-9, (나)=4, (다)=-5. 상수항 크기 순: (나)>(다)>(가). 따라서 (나)-(다)-(가)." },
  { qid: 11431, ansIdx: 1, staleIdx: 3,
    options: ["단항식을 다항식의 첫 번째 항에만 곱한다","단항식을 다항식의 각 항에 모두 곱한다","다항식의 모든 항을 먼저 더한 뒤 단항식을 곱한다","단항식의 계수만 각 항에 곱하고 문자는 무시한다"],
    explanation: "분배 법칙: a(b+c)=ab+ac. 단항식을 다항식의 각 항에 모두 곱한다." },
  { qid: 11512, ansIdx: 2, staleIdx: 1,
    options: ["60쪽","48쪽","96쪽","24쪽"],
    explanation: "(15+9)×4=24×4=96쪽." },
  { qid: 11537, ansIdx: 1, staleIdx: 3,
    options: ["20°","30°","60°","10°"],
    explanation: "120° - 90° = 30°. 직각(90°)보다 30° 더 크다." },
  { qid: 11539, ansIdx: 3, staleIdx: 1,
    options: ["45°","60°","30°","90°"],
    explanation: "직각은 90°이고, 삼각자에는 반드시 직각(90°)이 포함되어 있다." },
  { qid: 11544, ansIdx: 2, staleIdx: 0,
    options: ["45°","60°","90°","120°"],
    explanation: "직사각형의 네 꼭짓점은 모두 직각(90°)이다." },
  { qid: 11550, ansIdx: 2, staleIdx: 0,
    options: ["x = 5","x < 5","x > 5","x ≥ 5"],
    explanation: "\"x는 5보다 크다\"는 x > 5로 나타낸다." },
  { qid: 11553, ansIdx: 1, staleIdx: 3,
    options: ["x = 5","x = 2","x = 6","x = 4"],
    explanation: "x-2<1 → x<3. 보기 중 x=2만 2<3을 만족한다." },
  { qid: 11566, ansIdx: 0, staleIdx: 3,
    options: ["2x - 1 > 0","x² + 1 < 0","3x + 2y ≥ 5","2 < 5"],
    explanation: "2x - 1 > 0은 미지수가 x 하나이고 최고 차수가 1인 일차부등식이다." },
  { qid: 11569, ansIdx: 0, staleIdx: 3,
    options: ["(가)와 (라)","(나)와 (다)","(가)만","(나)와 (라)"],
    explanation: "일차부등식은 최고 차수가 1인 부등식이므로 (가)와 (라)가 해당한다." },
  { qid: 11571, ansIdx: 0, staleIdx: 1,
    options: ["2x + 3 > 0","x - 2 > 0","3x + 5 < 0","-2x - 1 < 0"],
    explanation: "x=-1을 대입: 2×(-1)+3=1 > 0 성립. 따라서 2x+3 > 0의 해이다." },
  { qid: 11577, ansIdx: 0, staleIdx: 2,
    options: ["x = 3","x = -3","x = 6","x = -6"],
    explanation: "-2x ≥ -6, x ≤ 3. 경계값은 x = 3 (닫힌 점)." },
  { qid: 11580, ansIdx: 0, staleIdx: 1,
    options: ["x ≤ 2","x ≤ -2","x ≥ 2","x ≤ 4"],
    explanation: "괄호를 전개하면 2x+6 ≤ 10, 2x ≤ 4, x ≤ 2." },
  { qid: 11599, ansIdx: 0, staleIdx: 2,
    options: ["r = √(A/π)","r = A/π","r = √A/π","r = π/√A"],
    explanation: "πr² = A에서 r² = A/π, r > 0이므로 r = √(A/π)." },
  { qid: 11609, ansIdx: 0, staleIdx: 1,
    options: ["빨간색","파란색","노란색","녹색"],
    explanation: "3개 반복: 1번째=빨강, 2번째=파랑, 3번째=노랑. 10=3×3+1이므로 10번째=빨간색." },
  { qid: 11631, ansIdx: 3, staleIdx: 2,
    options: ["2/5","1/5","4/5","3/5"],
    explanation: "P(눈 안 옴) = 1 - P(눈 옴) = 1 - 2/5 = 3/5." },
  { qid: 11633, ansIdx: 1, staleIdx: 0,
    options: ["3/32","5/8","7/8","3/8"],
    explanation: "배반사건이므로 P(A∩B)=0. P(A∪B) = 3/8 + 2/8 = 5/8." },
  { qid: 11634, ansIdx: 0, staleIdx: 3,
    options: ["㉠ > ㉡ > ㉢","㉢ > ㉡ > ㉠","㉡ > ㉠ > ㉢","㉠ = ㉡ > ㉢"],
    explanation: "P(㉠)=1/2, P(㉡)=1/4, P(㉢)=1/36. 따라서 ㉠ > ㉡ > ㉢." },
  { qid: 11635, ansIdx: 1, staleIdx: 3,
    options: ["P(A∩B) > P(A) > P(B)","P(A) > P(B) > P(A∩B)","P(B) > P(A) > P(A∩B)","P(A) = P(B) > P(A∩B)"],
    explanation: "P(A∩B)=1/6, P(A)=1/2, P(B)=1/3이므로 P(A) > P(B) > P(A∩B)." },
  { qid: 11824, ansIdx: 0, staleIdx: 1,
    options: ["(나) (가) (다)","(가) (나) (다)","(다) (가) (나)","(나) (다) (가)"],
    explanation: "(가)=(x-2)², (나)=(x+1)², (다)=(x-3)². a값(결과 괄호 안의 상수 절댓값)은 가=2, 나=1, 다=3이므로 작은 순서: (나)(가)(다). 정답은 ①이다." },
  { qid: 11923, ansIdx: 2, staleIdx: 0,
    options: ["720°","900°","1080°","1260°"],
    explanation: "n각형의 내각의 합=(n-2)×180°. 팔각형: (8-2)×180°=6×180°=1080°." },
  { qid: 11944, ansIdx: 0, staleIdx: 2,
    options: ["(0, 0)","(2, 3)","(-2, -3)","(4, -6)"],
    explanation: "중점의 x좌표=(2+(-2))/2=0, y좌표=(-3+3)/2=0. 따라서 중점은 (0,0)이다." },
  { qid: 11950, ansIdx: 2, staleIdx: 0,
    options: ["y=3x","y=x+5","y=12/x","y=x²"],
    explanation: "y=a/x 꼴이 반비례이다. y=12/x가 반비례 관계이다." },
  { qid: 11957, ansIdx: 1, staleIdx: 0,
    options: ["2와 4","3과 4","2와 6","4와 4"],
    explanation: "7=3+4이므로 3과 4로 가를 수 있다." },
  { qid: 12057, ansIdx: 3, staleIdx: 2,
    options: ["10%","15%","25%","20%"],
    explanation: "8/40 = 1/5 = 0.2, 0.2×100 = 20%입니다." },
  { qid: 12062, ansIdx: 0, staleIdx: 3,
    options: ["840","804","408","480"],
    explanation: "팔백(800) + 사십(40) = 840입니다." },
  { qid: 12065, ansIdx: 2, staleIdx: 0,
    options: ["7cm","10.5cm","14cm","21cm"],
    explanation: "구의 지름 = 반지름 × 2 = 7 × 2 = 14cm입니다." },
  { qid: 12069, ansIdx: 2, staleIdx: 0,
    options: ["원 2개, 삼각형 1개","원 1개, 직사각형 1개","원 2개, 직사각형 1개","정사각형 2개, 직사각형 1개"],
    explanation: "원기둥의 전개도는 밑면인 원 2개와 옆면인 직사각형 1개로 이루어집니다." },
  { qid: 12076, ansIdx: 1, staleIdx: 3,
    options: ["9.42 cm","18.84 cm","6.28 cm","12.56 cm"],
    explanation: "가로 = 2 × 3.14 × 3 = 18.84cm입니다." },
  { qid: 12121, ansIdx: 3, staleIdx: 1,
    options: ["SSS 닮음, 2:3","SAS 닮음, 2:3","AA 닮음, 3:2","SAS 닮음, 3:2"],
    explanation: "AB:DE=6:4=3:2, BC:EF=9:6=3:2이고 끼인각 ∠B=∠E이므로 SAS 닮음, 닮음비 3:2." },
  { qid: 12162, ansIdx: 2, staleIdx: 1,
    options: ["(-3, 5)","(5, 3)","(5, -3)","(-5, 3)"],
    explanation: "x=5인 수직선과 y=-3인 수평선은 점 (5, -3)에서 만납니다." },
  { qid: 12163, ansIdx: 0, staleIdx: 3,
    options: ["y=-7","y=2","x=-7","x=2"],
    explanation: "x축에 평행한 직선은 y=q 꼴이고, 점 (2,-7)을 지나므로 y=-7입니다." },
  { qid: 12170, ansIdx: 1, staleIdx: 3,
    options: ["4+x²+5x-2x³","4+5x+x²-2x³","x²+5x-2x³+4","-2x³+x²+5x+4"],
    explanation: "오름차순은 차수가 낮은 항부터 나열합니다: 4+5x+x²-2x³." },
  { qid: 12174, ansIdx: 1, staleIdx: 2,
    options: ["a-b","a+b","ab","a×b"],
    explanation: "(x+a)(x+b)=x²+(a+b)x+ab이므로 □는 a+b입니다." },
  { qid: 12175, ansIdx: 1, staleIdx: 0,
    options: ["-6","-12","6","12"],
    explanation: "(3x-2)²=9x²-12x+4이므로 x의 계수는 -12입니다." },
  { qid: 12187, ansIdx: 2, staleIdx: 3,
    options: ["2000","20","200","2"],
    explanation: "8264에서 2는 백의 자리에 있으므로 200을 나타냅니다." },
  { qid: 12198, ansIdx: 2, staleIdx: 0,
    options: ["나 색종이가 가 색종이보다 넓다","가 색종이가 나 색종이보다 좁다","가 색종이가 나 색종이보다 넓다","두 색종이의 넓이가 같다"],
    explanation: "가가 나보다 넓으므로 \"가 색종이가 나 색종이보다 넓다\"가 올바른 표현입니다." },
  { qid: 12301, ansIdx: 2, staleIdx: 3,
    options: ["A^c","A","∅","U"],
    explanation: "A와 그 여집합 A^c의 교집합은 공집합 ∅이다." },
  { qid: 12305, ansIdx: 1, staleIdx: 0,
    options: ["y = x + 1","y = 2x","y = 3x - 1","y = 2x + 1"],
    explanation: "기울기 m=(6-2)/(3-1)=2이고, y-2=2(x-1) 즉 y=2x이다." },
  { qid: 12308, ansIdx: 2, staleIdx: 0,
    options: ["m₁ = m₂","m₁ + m₂ = 0","m₁ × m₂ = -1","m₁ - m₂ = 1"],
    explanation: "두 직선이 수직이면 기울기의 곱 m₁×m₂=-1이다." },
  { qid: 12320, ansIdx: 1, staleIdx: 3,
    options: ["면 8개, 모서리 12개, 꼭짓점 6개","면 6개, 모서리 12개, 꼭짓점 8개","면 6개, 모서리 8개, 꼭짓점 6개","면 4개, 모서리 8개, 꼭짓점 4개"],
    explanation: "정육면체는 면 6개, 모서리 12개, 꼭짓점 8개를 가진다." },
  { qid: 12326, ansIdx: 0, staleIdx: 3,
    options: ["a^m × a^n = a^(m+n)","a^m × a^n = a^(m×n)","a^m × a^n = a^(m÷n)","a^m × a^n = a^(m-n)"],
    explanation: "지수법칙에 의해 a^m × a^n = a^(m+n)이다." },
  { qid: 12327, ansIdx: 1, staleIdx: 0,
    options: ["a^7","a^12","a^34","a^1"],
    explanation: "(a^m)^n = a^(m×n)이므로 (a^3)^4 = a^(3×4) = a^12이다." },
  { qid: 12329, ansIdx: 0, staleIdx: 2,
    options: ["8x^3","6x^3","2x^3","4x^3"],
    explanation: "(ab)^m = a^m × b^m이므로 (2x)^3 = 2^3 × x^3 = 8x^3이다." },
  { qid: 12333, ansIdx: 2, staleIdx: 3,
    options: ["2x - 3","3x - 3","4x - 3","4x + 7"],
    explanation: "동류항끼리 더하면 (3x+x)+(2-5)=4x-3이다." },
  { qid: 12348, ansIdx: 0, staleIdx: 2,
    options: ["x > 9","x < 9","x > 8","x ≥ 9"],
    explanation: "3x - 7 > 20 → 3x > 27 → x > 9이다." },
  // ── 배치 2 (68건) — 조사기를 복합 보기 원자 판정까지 넓혀 새로 드러난 것들 ──
  //   대부분 해설이 정답을 평문으로 한 번만 적는 개념·용어 문항이라 결론부 마커가 없었다.
  { qid: 9842, ansIdx: 1, staleIdx: 0,
    options: ["변 AB","변 EF","변 FD","변 DE"],
    explanation: "B→E, C→F이므로 변 BC에 대응하는 변은 변 EF입니다." },
  { qid: 9844, ansIdx: 2, staleIdx: 1,
    options: ["점대칭도형","합동도형","선대칭도형","비대칭도형"],
    explanation: "한 직선을 따라 접었을 때 완전히 겹쳐지는 도형을 선대칭도형이라고 합니다." },
  { qid: 10025, ansIdx: 1, staleIdx: 0,
    options: ["충분조건","필요조건","필요충분조건","어떤 조건도 아님"],
    explanation: "p→q가 참일 때 q는 p의 필요조건이다. P={2}⊂Q={-2,2}이므로 p→q(참), q→p(거짓). 따라서 q는 p의 필요조건이다." },
  { qid: 10032, ansIdx: 2, staleIdx: 0,
    options: ["p는 q의 충분조건이지만 필요조건은 아님","p는 q의 필요조건이지만 충분조건은 아님","p는 q의 필요충분조건","p와 q는 아무 관계 없음"],
    explanation: "x²-5x+6=0 ↔ (x-2)(x-3)=0 ↔ x=2 또는 x=3이다. 따라서 P=Q이고 p↔q가 성립하므로 p는 q의 필요충분조건이다." },
  { qid: 10169, ansIdx: 1, staleIdx: 3,
    options: ["1:1","1:2","2:1","1:4"],
    explanation: "원주각의 크기가 2배이면 호의 길이도 2배이므로 비는 1:2." },
  { qid: 10679, ansIdx: 1, staleIdx: 0,
    options: ["무한소수","유한소수","순환소수","자연수"],
    explanation: "소수점 아래가 유한 개인 소수를 유한소수라 한다." },
  { qid: 10687, ansIdx: 3, staleIdx: 2,
    options: ["0.27","0.32","0.45","0.36"],
    explanation: "9÷25=0.36. 분모 25=5²이므로 유한소수." },
  { qid: 10689, ansIdx: 1, staleIdx: 3,
    options: ["0.25","0.275","0.3","0.375"],
    explanation: "11÷40=0.275. 분모 40=2³×5이므로 유한소수." },
  { qid: 10712, ansIdx: 3, staleIdx: 2,
    options: ["63개","81개","54개","72개"],
    explanation: "9×8=72이므로 72개이다." },
  { qid: 10780, ansIdx: 0, staleIdx: 3,
    options: ["꼬인 위치","수직","나란한","교차"],
    explanation: "공간에서는 두 직선이 같은 평면에 없어서 만나지도 않고 평행하지도 않은 꼬인 위치 관계가 추가된다." },
  { qid: 10783, ansIdx: 0, staleIdx: 2,
    options: ["서로 같다","합이 180°이다","차이가 90°이다","서로 다르다"],
    explanation: "두 평행선에서 한 직선이 교차할 때 동위각의 크기는 서로 같다." },
  { qid: 10787, ansIdx: 0, staleIdx: 3,
    options: ["합과 같다","차와 같다","합의 절반이다","두 배이다"],
    explanation: "삼각형의 한 외각의 크기는 그 외각과 이웃하지 않는 두 내각의 합과 같다." },
  { qid: 10818, ansIdx: 3, staleIdx: 1,
    options: ["SSS 닮음","SAS 닮음","ASA 닮음","AA 닮음"],
    explanation: "두 각이 각각 같으면 AA 닮음 조건에 의해 두 삼각형은 닮음입니다." },
  { qid: 10819, ansIdx: 0, staleIdx: 2,
    options: ["SAS 닮음","SSS 닮음","AA 닮음","AAS 닮음"],
    explanation: "두 변의 비가 같고 끼인각이 같으면 SAS 닮음 조건이 성립합니다." },
  { qid: 10823, ansIdx: 3, staleIdx: 1,
    options: ["AA 닮음","SAS 닮음","닮음이 아니다","SSS 닮음"],
    explanation: "세 쌍의 대응변의 비가 모두 같으므로 SSS 닮음입니다." },
  { qid: 10904, ansIdx: 2, staleIdx: 0,
    options: ["구","원뿔","원기둥","삼각기둥"],
    explanation: "직사각형을 한 변을 축으로 회전시키면 원기둥이 만들어진다." },
  { qid: 10913, ansIdx: 1, staleIdx: 0,
    options: ["몫","나머지","피제수","제수"],
    explanation: "나눗셈에서 나누고 남은 수를 나머지라고 한다." },
  { qid: 11093, ansIdx: 2, staleIdx: 0,
    options: ["자료의 변화 방향","자료의 색깔","종류별 수","자료를 그린 그림"],
    explanation: "표를 이용하면 종류별 수를 쉽게 알 수 있습니다." },
  { qid: 11184, ansIdx: 2, staleIdx: 1,
    options: ["삼각기둥","원뿔","원기둥","구"],
    explanation: "두 원 밑면과 굽은 옆면으로 이루어진 기둥 모양은 원기둥이다." },
  { qid: 11193, ansIdx: 1, staleIdx: 3,
    options: ["지름","반지름","높이","모선"],
    explanation: "구의 중심에서 표면까지의 거리를 반지름이라고 한다." },
  { qid: 11200, ansIdx: 3, staleIdx: 2,
    options: ["원","삼각형","사다리꼴","직사각형"],
    explanation: "원기둥의 옆면을 펼치면 직사각형 모양이 된다." },
  { qid: 11205, ansIdx: 2, staleIdx: 0,
    options: ["원뿔이 만들어진다","구가 만들어진다","원기둥이 만들어진다","각기둥이 만들어진다"],
    explanation: "직사각형을 한 변을 축으로 돌리면 원기둥이 만들어진다." },
  { qid: 11211, ansIdx: 1, staleIdx: 0,
    options: ["가, 나","나, 가","가=나 (같다)","알 수 없다"],
    explanation: "나(5cm) < 가(8cm)이므로 높이가 낮은 것부터 나, 가 순이다." },
  { qid: 11214, ansIdx: 1, staleIdx: 0,
    options: ["나, 다, 가","가, 다, 나","다, 나, 가","나, 가, 다"],
    explanation: "12>9>7이므로 가, 다, 나 순이다." },
  { qid: 11216, ansIdx: 1, staleIdx: 3,
    options: ["가, 나","나, 가","가=나","알 수 없다"],
    explanation: "가: 2×28.26+75.36=131.88, 나: 2×12.56+75.36=100.48. 나<가 이므로 나, 가 순이다." },
  { qid: 11219, ansIdx: 2, staleIdx: 1,
    options: ["삼각형 모양이다","두 개의 원이다","원 모양 하나이다","직사각형 모양이다"],
    explanation: "원뿔의 밑면은 원 모양 하나이다." },
  { qid: 11224, ansIdx: 3, staleIdx: 2,
    options: ["직사각형","원","삼각형","부채꼴"],
    explanation: "원뿔의 옆면을 펼치면 부채꼴 모양이 된다." },
  { qid: 11226, ansIdx: 2, staleIdx: 0,
    options: ["모두 다르다","어떤 것은 같고 어떤 것은 다르다","모두 같다","알 수 없다"],
    explanation: "원뿔에서 모선의 길이는 모두 같다." },
  { qid: 11251, ansIdx: 2, staleIdx: 1,
    options: ["밑면 원의 지름","원기둥의 높이","밑면 원의 둘레","밑면 원의 반지름"],
    explanation: "전개도에서 옆면 직사각형의 가로 길이는 밑면 원의 둘레와 같습니다." },
  { qid: 11260, ansIdx: 2, staleIdx: 0,
    options: ["직각삼각형","이등변삼각형","정삼각형","예각삼각형"],
    explanation: "세 변의 길이와 세 각의 크기가 모두 같은 삼각형은 정삼각형입니다." },
  { qid: 11267, ansIdx: 2, staleIdx: 1,
    options: ["둔각삼각형","예각삼각형","직각삼각형","이등변삼각형"],
    explanation: "90°인 각이 있으므로 직각삼각형입니다." },
  { qid: 11312, ansIdx: 1, staleIdx: 0,
    options: ["가-나-다-라","다-가-라-나","나-라-가-다","라-다-가-나"],
    explanation: "5L>3L>2L>1L이므로 다-가-라-나 순서입니다." },
  { qid: 11402, ansIdx: 0, staleIdx: 2,
    options: ["5a - 4b + 8","9a - 2b + 2","5a - 2b + 8","5a - 4b + 2"],
    explanation: "뺄셈 부호 분배: 7a-3b+5-2a-b+3. a항: 5a, b항: -4b, 상수: 8. 결과: 5a-4b+8." },
  { qid: 11403, ansIdx: 0, staleIdx: 1,
    options: ["3x² + 3x + 2","3x² + 5x + 2","3x² + 3x - 2","2x² + 3x + 2"],
    explanation: "x²항: 3x², x항: -x+4x=3x, 상수: 3-1=2. 결과: 3x²+3x+2." },
  { qid: 11404, ansIdx: 1, staleIdx: 3,
    options: ["9m - 11n - 3","3m + 3n - 3","3m - 11n + 7","3m + 3n + 7"],
    explanation: "6m-4n+2-3m+7n-5. m항: 3m, n항: 3n, 상수: -3. 결과: 3m+3n-3." },
  { qid: 11405, ansIdx: 1, staleIdx: 2,
    options: ["5x - y + 5","5x + y - 3","5x + y + 5","3x + y - 3"],
    explanation: "x항: 5x, y항: -2y+3y=y, 상수: 1-4=-3. 결과: 5x+y-3." },
  { qid: 11406, ansIdx: 0, staleIdx: 1,
    options: ["3p² - 4p + 8","13p² - 2p - 4","3p² - 4p - 4","3p² + 4p + 8"],
    explanation: "8p²-3p+2-5p²-p+6. p²항: 3p², p항: -4p, 상수: 8. 결과: 3p²-4p+8." },
  { qid: 11409, ansIdx: 0, staleIdx: 3,
    options: ["7x² - 2x - 1","7x² - 2x + 1","3x² - 2x - 1","7x² + 2x - 1"],
    explanation: "A = (5x²+x-2)+(2x²-3x+1) = 7x²-2x-1." },
  { qid: 11411, ansIdx: 1, staleIdx: 0,
    options: ["4x² + 6x - 6","2x² + 6x - 6","2x² - 2x + 4","2x² + 6x + 4"],
    explanation: "A-B=(3x²+2x-1)-(x²-4x+5)=2x²+6x-6." },
  { qid: 11415, ansIdx: 0, staleIdx: 1,
    options: ["5m + n + 4","5m - n + 4","3m + n + 6","5m + n + 6"],
    explanation: "(4m-2n+5)+(m+3n-1)=5m+n+4." },
  { qid: 11416, ansIdx: 2, staleIdx: 1,
    options: ["2x² + x + 700","4x² + x + 300","2x² + 3x + 300","2x² + x + 300"],
    explanation: "(3x²+2x+500)-(x²-x+200)=2x²+3x+300." },
  { qid: 11418, ansIdx: 0, staleIdx: 3,
    options: ["3a² + 2a + 5","a² + 4a + 5","3a² + 4a + 5","3a² + 2a - 5"],
    explanation: "(2a²+3a-10)+(a²-a+15)=3a²+2a+5." },
  { qid: 11422, ansIdx: 0, staleIdx: 1,
    options: ["3x² - 2x + 1","3x² - 4x + 1","3x² - 2x + 3","7x² - 4x + 3"],
    explanation: "5x²-2x²=3x², -3x-(-x)=-2x, 2-1=1. 결과: 3x²-2x+1." },
  { qid: 11437, ansIdx: 0, staleIdx: 2,
    options: ["2x + 3","3x + 3","2x - 3","3x - 3"],
    explanation: "6x²÷3x=2x, 9x÷3x=3. 결과: 2x+3." },
  { qid: 11442, ansIdx: 1, staleIdx: 2,
    options: ["4x² + 3x - 2","4x² - 3x + 2","4x - 3x + 2","4x² - 3x - 2"],
    explanation: "16x⁴÷4x²=4x², 12x³÷4x²=3x, 8x²÷4x²=2. 결과: 4x²-3x+2." },
  { qid: 11520, ansIdx: 0, staleIdx: 3,
    options: ["2√5","√5","4","2"],
    explanation: "2/√5 × (√5/√5) = 2√5/5. □=2√5." },
  { qid: 11536, ansIdx: 1, staleIdx: 3,
    options: ["각도기의 왼쪽 끝","각도기의 중심(중앙 표시)","각도기의 눈금 90 위치","각도기의 오른쪽 끝"],
    explanation: "각도기로 각을 잴 때 꼭짓점을 각도기의 중심(중앙 표시)에 맞춘다." },
  { qid: 11551, ansIdx: 2, staleIdx: 1,
    options: ["x + 3 = 10","x + 3 < 10","x + 3 ≤ 10","x + 3 > 10"],
    explanation: "\"이하\"는 ≤ 기호를 사용. x + 3 ≤ 10." },
  { qid: 11561, ansIdx: 2, staleIdx: 1,
    options: ["x > 8","x < 12","x > 12","x < 8"],
    explanation: "x/3 > 4에서 양변에 3을 곱하면 x > 12." },
  { qid: 11562, ansIdx: 0, staleIdx: 2,
    options: ["7봉지","6봉지","5봉지","8봉지"],
    explanation: "1200n ≤ 8400이므로 n ≤ 7. 따라서 최대 7봉지 살 수 있다." },
  { qid: 11565, ansIdx: 0, staleIdx: 2,
    options: ["x > 5","x < -5","x < 5","x > -5"],
    explanation: "-2x < -10에서 양변을 -2로 나누면 부등호 방향이 바뀌어 x > 5." },
  { qid: 11581, ansIdx: 0, staleIdx: 3,
    options: ["x > 5","x < 5","x > -5","x < -5"],
    explanation: "양변에 10을 곱하면 3x - 5 > 10, 3x > 15, x > 5." },
  { qid: 11584, ansIdx: 0, staleIdx: 2,
    options: ["x > 5","x < 5","x > 7","x < 7"],
    explanation: "3x - 4 > 11, 3x > 15, x > 5." },
  { qid: 11586, ansIdx: 0, staleIdx: 3,
    options: ["x ≤ 4","x ≥ 4","x ≤ -4","x ≥ -4"],
    explanation: "5x - 2x ≤ 9 + 3, 3x ≤ 12, x ≤ 4." },
  { qid: 11598, ansIdx: 0, staleIdx: 3,
    options: ["x ≥ 3","x > 3","x ≤ 3","x < 3"],
    explanation: "√ 안의 값이 0 이상이어야 하므로 2x - 6 ≥ 0, x ≥ 3." },
  { qid: 11610, ansIdx: 0, staleIdx: 3,
    options: ["각 층의 개수는 층 번호의 제곱이다","각 층의 개수는 층 번호의 2배이다","각 층의 개수는 항상 같다","각 층마다 1개씩 늘어난다"],
    explanation: "1=1², 4=2², 9=3²이므로 각 층의 개수는 층 번호의 제곱이다." },
  { qid: 11621, ansIdx: 2, staleIdx: 0,
    options: ["직사각형","정사각형","마름모","등변사다리꼴"],
    explanation: "마름모는 네 변의 길이가 모두 같고 두 쌍의 대변이 평행한 사각형이다." },
  { qid: 11920, ansIdx: 1, staleIdx: 3,
    options: ["n(n+1)/2","n(n-3)/2","(n-1)(n-2)/2","n(n-1)/2"],
    explanation: "n각형의 대각선 개수 = n(n-3)/2. 각 꼭짓점에서 이웃하지 않는 (n-3)개의 꼭짓점에 대각선을 그을 수 있고, 중복을 방지해 2로 나눈다." },
  { qid: 11924, ansIdx: 2, staleIdx: 1,
    options: ["다각형의 변의 수가 많아질수록 외각의 합도 커진다","삼각형의 외각의 합은 540°이다","모든 다각형의 외각의 크기의 합은 360°이다","정다각형에서만 외각의 합이 360°이다"],
    explanation: "다각형의 종류나 변의 수에 관계없이 모든 다각형의 외각의 크기의 합은 360°이다." },
  { qid: 12070, ansIdx: 1, staleIdx: 0,
    options: ["삼각형","직사각형","원","마름모"],
    explanation: "원기둥을 펼치면 옆면은 직사각형이 됩니다." },
  { qid: 12145, ansIdx: 3, staleIdx: 1,
    options: ["8개","6개","10개","12개"],
    explanation: "직육면체의 모서리는 12개이므로 색 테이프는 12개 필요합니다." },
  { qid: 12152, ansIdx: 1, staleIdx: 2,
    options: ["가 < 나","가 > 나","가 = 나","비교할 수 없다"],
    explanation: "가=32÷4=8 cm, 나=20÷4=5 cm이므로 가>나입니다." },
  { qid: 12188, ansIdx: 1, staleIdx: 3,
    options: ["칠삼공오","칠천삼백오","칠백삼십오","칠천삼십오"],
    explanation: "7305는 칠천삼백오(7000+300+5)로 읽습니다." },
  { qid: 12314, ansIdx: 2, staleIdx: 0,
    options: ["4송이","6송이","5송이","3송이"],
    explanation: "2+3=5이므로 5송이이다." },
  { qid: 12321, ansIdx: 3, staleIdx: 0,
    options: ["네 변의 길이가 모두 같은 사각형이다.","네 각이 모두 직각인 사각형이다.","두 쌍의 대변이 각각 평행한 사각형이다.","적어도 한 쌍의 대변이 평행한 사각형이다."],
    explanation: "사다리꼴은 적어도 한 쌍의 대변이 평행한 사각형이다." },
  { qid: 12325, ansIdx: 2, staleIdx: 1,
    options: ["기준 수를 포함하여 그보다 큰 수","기준 수를 포함하여 그보다 작은 수","기준 수를 포함하지 않고 그보다 작은 수","기준 수를 포함하지 않고 그보다 큰 수"],
    explanation: "\"미만\"은 기준 수를 포함하지 않고 그보다 작은 수를 나타낸다." },
  { qid: 12345, ansIdx: 0, staleIdx: 2,
    options: ["4봉지","5봉지","3봉지","6봉지"],
    explanation: "6n≥24, 양변을 양수 6으로 나누면 n≥4이다. 4봉지 이상." },
  { qid: 12392, ansIdx: 1, staleIdx: 3,
    options: ["x+y=0","x+y=±3","x+y=±√3","-3 < x+y < 3"],
    explanation: "(x+y)²=x²+2xy+y²=5+4=9. 따라서 x+y=±3. 작은 것부터: -3, 3." },
];

test('REG-AK10: 해설↔정답키 불일치 수리 254건 — 정답이 해설이 지목하는 칸에 있고 옛 칸은 오답', async () => {
  // ⚠ 단언을 루프 안에만 두면 표가 비었을 때 **조용히 통과**한다. 먼저 못 박는다.
  assert.ok(AK10_FIXED.length > 0, '수리 표가 비어 있다 — 이 테스트가 잠들었다');
  assert.equal(AK10_FIXED.length, 254, `대상 254건이 표에 있어야 한다 — 실제 ${AK10_FIXED.length}건`);

  const failures = [];
  let checked = 0;
  let namedWhole = 0, namedAtoms = 0;

  for (const F of AK10_FIXED) {
    checked++;
    const row = db.prepare(
      'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
    ).get(F.qid);
    // ↓ 조건문 안에 가두지 않는다. 행이 사라졌으면 그것도 회귀다.
    assert.ok(row, `q${F.qid} 가 DB 에 있어야 한다 (수리 대상이 사라졌다)`);
    const opts = JSON.parse(row.options);

    // ① 정답키가 옳은 칸에 있다 (되돌아가면 옳게 푼 학생이 다시 오답 처리된다)
    if (String(row.answer) !== String(F.ansIdx)) {
      failures.push(`q${F.qid}: answer='${row.answer}' — 기대 '${F.ansIdx}' (정답키가 옛 칸으로 되돌아갔다)`);
    }
    // ② 보기는 한 글자도 바뀌지 않았다 — 이 배치는 options 를 건드리지 않는다
    if (JSON.stringify(opts) !== JSON.stringify(F.options)) {
      failures.push(`q${F.qid}: 보기가 바뀌었다 → ${row.options}`);
    }
    // ③ 해설도 그대로다 (번호 정정 2건은 정정 후 문장으로 박혀 있다)
    if (String(row.explanation) !== F.explanation) {
      failures.push(`q${F.qid}: 해설이 기대와 다르다 → ${JSON.stringify(row.explanation)}`);
    }
    // ④ 해설이 **새 정답을** 지목한다 — 이동 방향이 옳다는 독립 근거
    const how = ak10NamedBy(F.options[F.ansIdx], F.explanation);
    if (!how) {
      failures.push(`q${F.qid}: 해설이 새 정답 "${F.options[F.ansIdx]}" 를 지목하지 않는다 — 이동 근거가 사라졌다`);
    } else if (how === 'whole') namedWhole++; else namedAtoms++;
    // ⑤ 새 정답과 글자가 같은 보기가 없다(INV-AI5 와 같은 범위)
    const dup = opts.map((o, i) => (i !== F.ansIdx && String(o).trim() === String(opts[F.ansIdx]).trim() ? i : -1)).filter((i) => i >= 0);
    if (dup.length) failures.push(`q${F.qid}: 새 정답과 글자가 같은 보기 [${dup}] → ${row.options}`);
    // ⑥ 실제 채점 — 새 정답은 true, 옛 정답 칸은 false (양방향)
    const ok = await gradeOne(row.content_id, row.id, F.ansIdx);
    if (ok.correct !== true) failures.push(`q${F.qid}: 새 정답 index ${F.ansIdx}("${F.options[F.ansIdx]}")를 골랐는데 correct=${ok.correct}`);
    const ng = await gradeOne(row.content_id, row.id, F.staleIdx);
    if (ng.correct !== false) failures.push(`q${F.qid}: 옛 정답 index ${F.staleIdx}("${F.options[F.staleIdx]}")가 correct=${ng.correct}`);
  }

  assert.equal(checked, 254, `대상 254건을 전부 검사해야 한다 — 실제 ${checked}건 (표가 줄면 이 테스트가 잠든다)`);
  // 복합 보기(쉼표) 경로가 살아 있는지 — 이 경로가 죽으면 q10698 부류가 다시 숨는다
  assert.ok(namedAtoms >= 4, `복합 보기 원자 판정으로 지목된 건이 ${namedAtoms}건뿐이다 — 매처의 그 경로가 좁아졌다`);
  assert.deepStrictEqual(failures, [], '해설↔정답키 수리가 되돌아갔거나 채점이 어긋났습니다:\n' + failures.join('\n'));
});

test('REG-AK10 역주입: 정답을 옛 칸으로 되돌리거나 해설 지목을 끊으면 반드시 걸린다', () => {
  // 정본이 통과하는 것을 먼저 못 박는다 — 역주입이 "원래부터 붉었다" 로 착시되지 않게.
  assert.ok(AK10_FIXED.length > 0, '수리 표가 비어 있다');
  const clean = [];
  for (const F of AK10_FIXED) {
    if (!ak10NamedBy(F.options[F.ansIdx], F.explanation)) clean.push(`q${F.qid}`);
  }
  assert.deepStrictEqual(clean, [], '정본 계획은 전건 통과해야 한다: ' + clean.join(', '));

  // (a) 해설에서 정답 문구를 지우면 지목이 끊겨야 한다
  const survivors = [];
  for (const F of AK10_FIXED) {
    const t = ak10Strip(F.options[F.ansIdx]);
    // 해설에서 정답 보기의 글자를 전부 걷어낸 문장 — 이래도 지목되면 판정기가 헐겁다
    let broken = ak10Strip(F.explanation).split(t).join('◇');
    for (const a of t.split(',')) { if (a.length >= 2) broken = broken.split(a).join('◇').split(ak10Rhs(a)).join('◇'); }
    assert.notStrictEqual(broken, ak10Strip(F.explanation), `q${F.qid}: 역주입 치환이 적용되지 않았다(패턴 불일치)`);
    if (ak10NamedBy(F.options[F.ansIdx], broken)) survivors.push(`q${F.qid}`);
  }
  assert.deepStrictEqual(survivors, [], '정답 문구를 지웠는데도 지목으로 판정된 문항: ' + survivors.join(', '));

  // (b) 경계 인식이 살아 있는가 — 부분 문자열 일치를 지목으로 오인하면 오탐이 쏟아진다
  assert.equal(ak10NamedBy('bigg', 'bigger의 원급은 big이다'), null, '`bigg` 가 `bigger` 안에서 걸리면 안 된다');
  assert.equal(ak10NamedBy('300', '3 km = 3000 m입니다'), null, '`300` 이 `3000` 안에서 걸리면 안 된다');
  assert.equal(ak10NamedBy('3000', '3 km = 3000 m입니다'), 'whole', '단위가 뒤에 붙은 수치는 지목으로 읽어야 한다');
  assert.equal(ak10NamedBy('99x=27, x=3/11', '99x=27, x=27/99=3/11.'), 'atoms', '복합 보기는 원자 단위로 지목을 읽어야 한다(q10698 부류)');
  assert.equal(ak10NamedBy('몫은 3, 나머지는 2이다', '17÷5=3...2이므로 몫은 3, 나머지는 2이다.'), 'whole', '한글에 경계를 걸면 참인 지목이 떨어진다');
  assert.equal(ak10NamedBy('4봉지', '6n ≥ 24, 양변을 양수 6으로 나누면 n ≥ 4이다. 4봉지 이상.'), 'whole', '문장 끝 마침표를 소수점으로 오인하면 안 된다');
  assert.equal(ak10NamedBy('45', '반올림하면 3.45가 된다'), null, '소수점 뒤 숫자는 별도 토큰이 아니다');
});

// ══════════════════════════════════════════════════════════════════════════════
// REG-AK5 — 증적 리포트 보존 가드 [소스 락]  (감리 P1-B)
//   🔴 2026-08-07 사고: 적용 후 스크립트를 한 번 더 돌리자 rollback.sql 이 0행짜리로 덮여
//     되돌릴 수단이 사라졌다. report.md 도 같은 형태였다(손으로 붙인 정정 공지가 날아갈 뻔).
//   → 산출물 write 는 반드시 보존 가드를 거쳐야 한다.
// ══════════════════════════════════════════════════════════════════════════════
const GUARDED_SCRIPTS = [
  'scripts/fix-answer-index-base.js',
  'scripts/fix-answer-key-integrity-20260821.js',
  'scripts/fix-explanation-answer-mismatch-20260821.js',      // 해설↔정답키 불일치 배치 1 (2026-08-21)
  'scripts/fix-explanation-answer-mismatch-20260821-b2.js',   // 해설↔정답키 불일치 배치 2 (2026-08-21)
];

/**
 * report.md 산출물이 보존 가드를 거치는가.
 * 경로를 변수로 받는 형태(`const reportPath = path.join(OUT_DIR,'report.md')`)까지 따라간다 —
 * 리터럴만 보면 변수를 쓰는 스크립트에서 조용히 통과해 버린다.
 */
function isReportGuarded(source) {
  if (/writePreservingAnnotations\s*\(\s*[^)]*['"]report\.md['"]/.test(source)) return true;
  const m = source.match(/(?:const|let|var)\s+(\w+)\s*=\s*path\.join\([^)]*['"]report\.md['"]\s*\)/);
  if (m && new RegExp(`writePreservingAnnotations\\s*\\(\\s*${m[1]}\\b`).test(source)) return true;
  return false;
}

/** 산출물(report.md/rollback.sql/changes.csv)이 보존 가드 없이 직접 쓰이는 곳을 찾는다. */
function findUnguardedArtifactWrites(source, rel) {
  const problems = [];
  const artifacts = ['report.md', 'rollback.sql', 'changes.csv'];
  for (const line of source.split(/\r?\n/)) {
    if (!/fs\.writeFileSync\s*\(/.test(line)) continue;
    if (/\.preview\b/.test(line)) continue;                 // preview 산출물은 보존 대상이 아니다
    for (const a of artifacts) {
      if (line.includes(a)) problems.push(`${rel}: 보존 가드 없이 ${a} 를 직접 씁니다 → ${line.trim()}`);
    }
  }
  // 가드가 실제로 정의·사용되는지
  if (!/function writePreservingAnnotations\s*\(/.test(source)) {
    problems.push(`${rel}: writePreservingAnnotations 정의를 찾지 못했습니다`);
  }
  if (!isReportGuarded(source)) {
    problems.push(`${rel}: report.md 가 writePreservingAnnotations 를 거치지 않습니다`);
  }
  // 손으로 덧붙인 blockquote 를 판별하는 규칙이 살아 있는지
  if (!/\^\\s\*>/.test(source)) {
    problems.push(`${rel}: 손글씨 주석(> …) 판별 규칙을 찾지 못했습니다`);
  }
  return problems;
}

test('REG-AK5: 증적 리포트가 보존 가드를 거쳐 쓰인다 [소스 락]', () => {
  const problems = [];
  for (const rel of GUARDED_SCRIPTS) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `스크립트가 없습니다: ${rel}`);
    problems.push(...findUnguardedArtifactWrites(fs.readFileSync(abs, 'utf8'), rel));
  }
  assert.deepStrictEqual(
    problems, [],
    '보존 가드 없이 증적을 덮으면 되돌릴 수단과 감리 정정문이 사라집니다(2026-08-07 실제 사고).'
  );
});

test('REG-AK5 역주입: 가드를 벗긴 소스는 반드시 걸린다', () => {
  const rel = 'scripts/fix-answer-key-integrity-20260821.js';
  const good = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.deepStrictEqual(findUnguardedArtifactWrites(good, rel), [], '정본 소스는 통과해야 한다');

  // (a) report.md 를 가드 없이 직접 쓰도록 되돌림
  const bad1 = good.replace(
    /writePreservingAnnotations\(path\.join\(OUT_DIR, 'report\.md'\), md\.join\('\\n'\)\);/,
    "fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md.join('\\n'), 'utf8');"
  );
  assert.notStrictEqual(bad1, good, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(findUnguardedArtifactWrites(bad1, rel).length > 0, '가드를 벗겼는데 스캐너가 통과시켰다');

  // (b) 가드 함수 정의 자체를 없앰
  const bad2 = good.replace('function writePreservingAnnotations (', 'x')
    .replace('function writePreservingAnnotations(', 'function _disabledGuard(');
  assert.notStrictEqual(bad2, good, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(findUnguardedArtifactWrites(bad2, rel).length > 0, '가드 정의를 없앴는데 스캐너가 통과시켰다');
});
