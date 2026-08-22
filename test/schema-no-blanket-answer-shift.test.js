// test/schema-no-blanket-answer-shift.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 스키마 초기화가 **정답키를 일괄 이동시키지 않는다** (2026-08-21 지뢰 제거 박제)
//
// ■ 무엇이 있었나
//   `db/schema.js` 의 `answer_0based` 마이그레이션은 서버가 뜰 때마다 `_migrations` 에
//   플래그가 없으면 아래를 **조건 없이** 실행했다:
//     UPDATE content_questions SET answer = CAST(CAST(answer AS INTEGER) - 1 AS TEXT)
//      WHERE typeof(answer)='text' AND CAST(answer AS INTEGER) >= 1 AND answer NOT LIKE '%.%'
//   `exams.answers` JSON 안의 answer 도 같은 방식으로 -1 했다.
//
// ■ 왜 지뢰였나
//   이 SQL 은 "1-based 로 저장된 값" 과 "0-based 인데 값이 1 이상인 값" 을 **구분하지 못한다**.
//   정본은 0-based 이므로(answer='0' 이 2,337건 — 1-based 로는 불가능한 값) 이 UPDATE 가
//   도는 순간 **맞는 정답키가 전부 한 칸씩 틀어진다**. 단답형 숫자 정답("27")까지 "26" 이 된다.
//   막아 주던 것은 `_migrations` 행 하나뿐이었는데, 그 행은 **새 DB 에 없다**:
//     · `backups/gcp-content-sync.sql` 같은 동기화 SQL 에 `_migrations` 는 0건이다.
//       빈 DB 에 그 SQL 을 붓고 서버를 올리는 GCP 재구축 절차가 그대로 사고 경로다.
//     · 구버전 DB 복원 · 로컬 재구축도 같다.
//   2026-08-21 정본 사본으로 재현: 플래그 없는 DB 로 한 번 부팅 → **9,544 문항 일괄 차감**.
//
// ■ 핵심 단언
//   "플래그가 없는 DB 에 스키마를 다시 세워도 answer 가 한 건도 바뀌지 않는다."
//   빈 DB 는 바꿀 행이 없어 **버그가 있어도 통과**한다 → 그래서 픽스처에 마이그레이션이
//   실제로 집어갔을 행(answer >= 1 · 단답형 숫자 · exams JSON)을 **심어 두고** 검사한다.
//   그 감지력은 아래 역주입에서 역사적 SQL 을 직접 돌려 실증한다.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SCHEMA_REL = 'db/schema.js';

// ── 픽스처 ───────────────────────────────────────────────────────────────────
// 마이그레이션이 **실제로 집어갔을** 값들만 고른다.
//   · answer='0'      → 유일하게 안 집어가던 값(대조군). 1-based 로는 존재할 수 없는 값이기도 하다.
//   · answer='1'~'3'  → 전부 -1 대상이었다.
//   · answer='27'     → 단답형 숫자 정답. typeof='text' 라 함께 -1 됐다(실측 q6: 27→26).
//   · answer='0.0'    → NOT LIKE '%.%' 로 빠지던 값(정합 작업으로 정본에는 이제 없다)
const FIXTURE_QUESTIONS = [
  { qn: 1, type: 'multiple_choice', options: ['가', '나', '다', '라'], answer: '0' },
  { qn: 2, type: 'multiple_choice', options: ['가', '나', '다', '라'], answer: '1' },
  { qn: 3, type: 'multiple_choice', options: ['가', '나', '다', '라'], answer: '2' },
  { qn: 4, type: 'multiple_choice', options: ['가', '나', '다', '라'], answer: '3' },
  { qn: 5, type: 'short_answer', options: [], answer: '27' },
];
const FIXTURE_EXAM_ANSWERS = [
  { number: 1, text: '보기 중 고르시오', type: 'choice', options: ['가', '나', '다'], answer: 2, points: 50 },
  { number: 2, text: '단답', type: 'short', answer: '서울', points: 50 },
];

/** 별도 프로세스에서 스키마를 세운다 — db/index 가 require 시점에 DB_PATH 를 1회만 읽기 때문. */
function initSchemaIn(dbPath) {
  execFileSync(
    process.execPath,
    ['-e', "require('./db/schema').initSchema();"],
    { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath }, stdio: 'pipe', timeout: 120000 }
  );
}

/** answer 관련 값 전체를 찍는다. */
function snapshot(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  try {
    return {
      questions: d.prepare('SELECT id, answer FROM content_questions ORDER BY id').all()
        .map((r) => `q${r.id}=${JSON.stringify(r.answer)}`),
      exams: d.prepare('SELECT id, answers FROM exams ORDER BY id').all()
        .map((r) => `e${r.id}=${r.answers}`),
    };
  } finally { d.close(); }
}

/** INV-SM1 판정 — 스냅샷 두 장의 차이 목록(테스트와 역주입이 같은 구현을 쓴다). */
function diffSnapshots(before, after) {
  const out = [];
  for (const key of ['questions', 'exams']) {
    const b = before[key], a = after[key];
    const n = Math.max(b.length, a.length);
    for (let i = 0; i < n; i++) {
      if (b[i] !== a[i]) out.push(`${key}[${i}]: ${b[i]} → ${a[i]}`);
    }
  }
  return out;
}

function makeFixtureDb() {
  const p = path.join(os.tmpdir(), `sm_blanket_${process.pid}_${Date.now()}.db`);
  initSchemaIn(p);                                      // ① 빈 DB 에 스키마 생성

  const d = new Database(p);                            // ② 마이그레이션이 집어갈 데이터를 심는다
  try {
    // id 를 고정하지 않는다 — 스키마 초기화가 기본 계정(admin 등)을 시드해 1번이 이미 찼을 수 있다.
    const uid = d.prepare(
      `INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', '교사', 'teacher')`
    ).run('sm_t_' + process.pid).lastInsertRowid;
    const cid = d.prepare(
      `INSERT INTO contents (creator_id, title, content_type, is_public, status)
       VALUES (?, '_지뢰_픽스처', 'quiz', 1, 'approved')`
    ).run(uid).lastInsertRowid;
    const insQ = d.prepare(`INSERT INTO content_questions
      (content_id, question_number, question_text, question_type, options, answer, explanation, points)
      VALUES (?, ?, ?, ?, ?, ?, '', 10)`);
    for (const q of FIXTURE_QUESTIONS) {
      insQ.run(cid, q.qn, `픽스처 문항 ${q.qn}`, q.type, JSON.stringify(q.options), q.answer);
    }
    const clsId = d.prepare(
      `INSERT INTO classes (code, name, owner_id) VALUES (?, '_지뢰_클래스', ?)`
    ).run('SM' + String(process.pid).slice(-4), uid).lastInsertRowid;
    d.prepare(`INSERT INTO exams (id, class_id, title, description, answers, question_count, status, owner_id)
               VALUES (?, ?, '_지뢰_평가', '', ?, 2, 'active', ?)`)
      .run('sm_exam_' + process.pid, clsId, JSON.stringify(FIXTURE_EXAM_ANSWERS), uid);

    // ③ 플래그를 지운다 — "복원·재구축된 DB" 상태를 그대로 만든다.
    //    (지금은 해당 마이그레이션 자체가 없지만, 이름만 바꿔 되살아나는 것도 잡아야 하므로
    //     `_migrations` 를 통째로 비워 **어떤 마이그레이션도 미적용인 DB** 로 만든다)
    d.prepare('DELETE FROM _migrations').run();
  } finally { d.close(); }
  return p;
}

function dropDb(p) {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    try { fs.existsSync(p + ext) && fs.unlinkSync(p + ext); } catch (_) { /* EBUSY 무시 */ }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// INV-SM1 — 플래그 없는 DB 를 다시 부팅해도 정답키가 변하지 않는다
// ══════════════════════════════════════════════════════════════════════════════
test('INV-SM1: 마이그레이션 플래그가 없는 DB 에 스키마를 다시 세워도 answer 가 한 건도 안 바뀐다', () => {
  const p = makeFixtureDb();
  try {
    const before = snapshot(p);

    // 픽스처가 "집어갈 것이 있는" 상태인지 먼저 못 박는다 — 없으면 이 테스트는 잠든다.
    assert.equal(before.questions.length, FIXTURE_QUESTIONS.length, '픽스처 문항이 전부 들어가야 한다');
    const shiftable = before.questions.filter((s) => {
      const m = s.match(/="(\d+)"$/);
      return m && Number(m[1]) >= 1;
    });
    assert.ok(
      shiftable.length >= 4,
      `일괄 차감의 사정권(answer >= 1)에 드는 픽스처가 4건 이상이어야 한다 — 현재 ${shiftable.length}건. ` +
      '사정권 밖 데이터만 심으면 이 테스트는 감지력 0 이다.'
    );
    // 스키마 초기화가 데모 평가를 시드하므로 개수는 고정하지 않고 **내 픽스처의 존재**를 못 박는다.
    assert.ok(
      before.exams.some((s) => s.includes('sm_exam_' + process.pid)),
      `exams 픽스처가 들어가야 한다 — 현재: ${before.exams.join(' | ')}`
    );

    initSchemaIn(p);                                    // ← 사고 시나리오: 플래그 없는 DB 재부팅

    assert.deepStrictEqual(
      diffSnapshots(before, snapshot(p)), [],
      '스키마 초기화가 정답키를 이동시켰습니다.\n' +
      '조건 없는 일괄 연산(answer -= 1 류)이 db/schema.js 에 다시 들어왔는지 확인하십시오.\n' +
      '2026-08-21 실측: 플래그 없는 정본 사본을 한 번 부팅해 9,544 문항이 차감됐습니다.'
    );
  } finally { dropDb(p); }
});

test('INV-SM1 역주입: 문제의 일괄 차감 SQL 을 직접 돌리면 반드시 붉어진다', () => {
  // 픽스처와 비교 함수에 **실제 감지력이 있는지** 실증한다.
  // ("안 붉어졌다" 는 감지력 0 과 구별되지 않으므로, 붉어지는 것을 눈으로 확인한다)
  const p = makeFixtureDb();
  try {
    const before = snapshot(p);
    assert.deepStrictEqual(diffSnapshots(before, snapshot(p)), [], '같은 스냅샷끼리는 차이가 없어야 한다');

    const d = new Database(p);
    try {
      // 2026-04-09 ~ 2026-08-21 사이 db/schema.js 에 실제로 있던 SQL 그대로
      d.exec(
        "UPDATE content_questions SET answer = CAST(CAST(answer AS INTEGER) - 1 AS TEXT) " +
        "WHERE answer IS NOT NULL AND answer != '' AND typeof(answer) = 'text' " +
        "AND CAST(answer AS INTEGER) >= 1 AND answer NOT LIKE '%.%'"
      );
      // exams.answers JSON 쪽도 같은 형태였다
      for (const ex of d.prepare('SELECT id, answers FROM exams WHERE answers IS NOT NULL').all()) {
        const qs = JSON.parse(ex.answers);
        let changed = false;
        for (const q of qs) {
          const num = Number(q.answer);
          if (q.options && q.options.length > 0 && Number.isInteger(num) && num >= 1) { q.answer = num - 1; changed = true; }
        }
        if (changed) d.prepare('UPDATE exams SET answers = ? WHERE id = ?').run(JSON.stringify(qs), ex.id);
      }
    } finally { d.close(); }

    const hits = diffSnapshots(before, snapshot(p));
    assert.ok(
      hits.length >= 5,
      `일괄 차감을 직접 돌렸는데 감지된 변경이 ${hits.length}건뿐이다 — 픽스처나 비교 함수가 죽어 있다.\n` +
      hits.join('\n')
    );
    // 대조군 — answer='0' 은 원래 사정권 밖이라 그대로여야 한다(비교 함수가 아무거나 붉히는 게 아님)
    assert.ok(
      !hits.some((h) => /=\s*"0"\s*→/.test(h)),
      `answer='0' 은 일괄 차감 사정권 밖인데 변경으로 잡혔다 — 비교가 과민하다:\n${hits.join('\n')}`
    );
    // 단답형 숫자 정답까지 망가지는 것이 이 지뢰의 진짜 무서움 — 그것도 잡히는지 본다
    assert.ok(
      hits.some((h) => h.includes('"27"') && h.includes('"26"')),
      `단답형 숫자 정답("27"→"26") 손상이 감지되지 않았다:\n${hits.join('\n')}`
    );
    assert.ok(
      hits.some((h) => h.startsWith('exams[')),
      `exams.answers JSON 손상이 감지되지 않았다:\n${hits.join('\n')}`
    );
  } finally { dropDb(p); }
});

// ══════════════════════════════════════════════════════════════════════════════
// INV-SM2 — db/schema.js 에 정답 일괄 이동 코드가 **없다** [소스 락]
//   행동 테스트(INV-SM1)는 "이름을 바꿔 되살아난" 변종도 잡지만, 실행 조건이 달라지면
//   놓칠 수 있다. 소스에서도 못 박는다.
// ══════════════════════════════════════════════════════════════════════════════
/** 주석(//, /* *\/)을 제거해 **실행되는 코드만** 남긴다 — 문서용 설명문에 걸리면 안 된다. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

/** INV-SM2 판정 — 정답을 통째로 ±1 하는 실행 코드를 찾는다. */
function findBlanketAnswerShift(source, rel) {
  const code = stripComments(source);
  const problems = [];
  // (a) SQL 일괄 연산: UPDATE ... SET answer = ... answer ... ± 1
  const sqlRe = /UPDATE\s+content_questions\s+SET\s+answer\s*=[^;'"]*answer[^;'"]*[-+]\s*1/gi;
  for (const m of code.match(sqlRe) || []) {
    problems.push(`${rel}: content_questions.answer 를 일괄 ±1 하는 SQL 이 있습니다 → ${m.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  // (b) exams.answers JSON 루프: q.answer = num - 1 형태
  const jsRe = /\.answer\s*=\s*\w+\s*[-+]\s*1\s*;/g;
  for (const m of code.match(jsRe) || []) {
    problems.push(`${rel}: JSON 정답을 ±1 하는 코드가 있습니다 → ${m.trim()}`);
  }
  return problems;
}

test('INV-SM2: db/schema.js 에 정답 일괄 ±1 코드가 없다 [소스 락]', () => {
  const abs = path.join(ROOT, SCHEMA_REL);
  assert.ok(fs.existsSync(abs), `파일이 없습니다: ${SCHEMA_REL}`);
  assert.deepStrictEqual(
    findBlanketAnswerShift(fs.readFileSync(abs, 'utf8'), SCHEMA_REL), [],
    '부팅 경로에 조건 없는 정답 이동이 다시 들어왔습니다.\n' +
    '1-based 데이터를 만나면 scripts/fix-answer-key-integrity-20260821.js 처럼\n' +
    '문항별 expect 가드 + 해설 대조 + 롤백 선기록 + DRY-RUN 을 갖춘 일회성 스크립트로 처리하십시오.'
  );
});

test('INV-SM2 역주입: 일괄 차감 코드를 되살리면 반드시 걸린다', () => {
  const good = fs.readFileSync(path.join(ROOT, SCHEMA_REL), 'utf8');
  assert.deepStrictEqual(findBlanketAnswerShift(good, SCHEMA_REL), [], '정본 소스는 통과해야 한다');

  // (a) SQL 형태 되살리기 — 실행되는 줄로 심는다
  const badSql = good.replace(
    'function initSchema() {',
    'function initSchema() {\n  db.exec("UPDATE content_questions SET answer = CAST(CAST(answer AS INTEGER) - 1 AS TEXT) WHERE CAST(answer AS INTEGER) >= 1");'
  );
  assert.notStrictEqual(badSql, good, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(findBlanketAnswerShift(badSql, SCHEMA_REL).length > 0, 'SQL 일괄 차감을 심었는데 스캐너가 통과시켰다');

  // (b) JSON 루프 형태 되살리기
  const badJs = good.replace(
    'function initSchema() {',
    'function initSchema() {\n  for (const q of qs) { q.answer = num - 1; }'
  );
  assert.notStrictEqual(badJs, good, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(findBlanketAnswerShift(badJs, SCHEMA_REL).length > 0, 'JSON ±1 을 심었는데 스캐너가 통과시켰다');

  // (c) 과민 검사 — 주석 안의 설명문(제거 기록)은 걸리면 안 된다
  const commentedOnly = '// UPDATE content_questions SET answer = CAST(CAST(answer AS INTEGER) - 1 AS TEXT)\n'
    + '/* q.answer = num - 1; */\nfunction initSchema() {}\n';
  assert.deepStrictEqual(
    findBlanketAnswerShift(commentedOnly, 'fake.js'), [],
    '주석 안의 설명문을 실행 코드로 오판했다 — 제거 기록을 문서로 남길 수 없게 된다'
  );
});
