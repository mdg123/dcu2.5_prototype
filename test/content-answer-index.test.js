// test/content-answer-index.test.js
// ─────────────────────────────────────────────────────────────────────────────
// content_questions.answer 의 **인덱스 기준(0-based)** 정합 불변식.
//
// 정본 규약: answer 는 options 배열의 **0-based index** 다.
//   · public/content/content-player.html   → `String(선택idx) === String(q.answer)`,
//                                             정답 표시도 `q.options[q.answer]`
//   · db/self-learn-extended.js _resolveCorrectIndex() → 0-based 범위 안이면 그대로 0-based
// 1-based 로 저장된 행은 **학생이 맞게 골라도 오답 처리**된다. 그래서 아래를 박제한다.
//
// (2026-08-07 정답인덱스 정합 작업 — 보고서/증적/정답인덱스_정합_20260807/)
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setupTestDb } = require('./_setup');

setupTestDb();
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH, { readonly: true });

const ROOT = path.join(__dirname, '..');

// ── 공통 로더 ────────────────────────────────────────────────────────────
/** 객관식 문항 중 options 배열(≥2) + answer 정수인 것만. */
function loadChoiceRows(handle = db) {
  const rows = handle
    .prepare(
      `SELECT id, content_id, options, answer
         FROM content_questions
        WHERE question_type IN ('choice','multiple_choice')`
    )
    .all();
  const out = [];
  for (const r of rows) {
    let opts = null;
    try { const j = JSON.parse(r.options); if (Array.isArray(j)) opts = j; } catch (_) {}
    if (!opts || opts.length < 2) continue;
    const n = Number(String(r.answer).trim());
    if (!Number.isInteger(n)) continue;
    out.push({ id: r.id, content_id: r.content_id, len: opts.length, n });
  }
  return out;
}

// ── INV-AI1 ─────────────────────────────────────────────────────────────
// 한 콘텐츠 안에서 answer===0(1-based 로는 불가능)과 answer===options.length
// (0-based 로는 불가능)이 **동시에** 나타나면, 그 콘텐츠는 두 기준이 섞인 것이다.
// 어느 쪽으로 고쳐도 일부 문항이 깨지므로 자동 변환이 불가능한 상태 = 즉시 사람 판단 대상.
/** INV-AI1 판정 — 위반 목록을 돌려준다(테스트와 역주입이 같은 구현을 쓴다). */
function findMixedBaseContents(rows) {
  const byContent = new Map();
  for (const r of rows) {
    if (!byContent.has(r.content_id)) byContent.set(r.content_id, { zero: [], full: [] });
    const b = byContent.get(r.content_id);
    if (r.n === 0) b.zero.push(r.id);
    if (r.n === r.len) b.full.push(r.id);
  }
  const violations = [];
  for (const [cid, b] of byContent) {
    if (b.zero.length && b.full.length) {
      violations.push(`content ${cid}: answer=0 인 문항 [${b.zero}] 과 answer=보기수 인 문항 [${b.full}] 이 공존`);
    }
  }
  return violations;
}

test('INV-AI1: 한 콘텐츠가 answer===0 과 answer===options.length 를 동시에 갖지 않는다', () => {
  const violations = findMixedBaseContents(loadChoiceRows());
  assert.deepStrictEqual(
    violations, [],
    `0-based/1-based 가 한 콘텐츠 안에 섞였습니다(자동 변환 불가 — 문항별 정답키 재작성 필요):\n` +
    violations.join('\n')
  );
});

// ── INV-AI2 ─────────────────────────────────────────────────────────────
// 모든 객관식 answer 는 0-based 유효 범위 [0, len-1] 안에 있어야 한다.
//
// ⚠ 현재 DB 에는 이 범위를 벗어난 **정답키 손상** 행이 남아 있다.
//   전수 육안 확인 결과 이들은 "1-based 저장"이 아니라 **애초에 틀린 정답키**다
//   (예: c102 보기 ["12cm³","20cm³","60cm³","35cm³"] answer=4, 해설은 "60cm³"
//        → -1 해도 "35cm³" 로 여전히 오답. 올바른 값은 2).
//   그래서 일괄 -1 로 고칠 수 없고, 문항별 재작성이 필요하다.
//   여기서는 **알려진 목록을 동결**해 "새로운 손상이 늘어나지 않는지"를 감시한다.
//   손상을 하나 고칠 때마다 이 목록에서 지우면 된다(줄어드는 것은 통과, 느는 것은 실패).
//   (2026-08-07 적용으로 q69·c85 와 q228·c196 은 해소돼 목록에서 제거했다 — 진짜 1-based 였다)
const KNOWN_OUT_OF_RANGE = new Set([
  86, 213, 214, 239, 240,                    // c102·187·205 — 초기 시드 정답키 손상
  276, 279, 282, 285, 288, 291, 294, 297,    // c238~383 "예시 문제 2" 동일 템플릿 30건.
  300, 303, 306, 309, 312, 315, 318, 321,    //   보기[3]="올바른 적용" 인데 answer=5,
  324, 327, 330, 333, 336, 339, 342, 345,    //   해설은 "4번이 정답" → 올바른 값은 3.
  348, 351, 354, 357, 360, 363,              //   -1(=4)은 "해당 없음" 이라 오히려 악화된다.
]);

/** INV-AI2 판정 — 동결 목록에 없는 **신규** 범위밖 문항 목록. */
function findUnknownOutOfRange(rows) {
  return rows
    .filter(r => !(r.n >= 0 && r.n <= r.len - 1))
    .filter(r => !KNOWN_OUT_OF_RANGE.has(r.id))
    .map(r => `q${r.id}(content ${r.content_id}) answer=${r.n} 보기수=${r.len}`);
}

test('INV-AI2: 객관식 answer 는 0-based 범위(0 ~ 보기수-1) 안이다 — 알려진 손상 외 신규 0건', () => {
  const rows = loadChoiceRows();
  const outOfRange = rows.filter(r => !(r.n >= 0 && r.n <= r.len - 1));

  assert.deepStrictEqual(
    findUnknownOutOfRange(rows),
    [],
    '0-based 범위를 벗어난 **신규** 문항이 생겼습니다. 1-based 로 저장됐다면 학생이 맞게 골라도 오답 처리됩니다.'
  );

  // 동결 목록이 실제보다 커지면(=고쳐졌는데 목록을 안 지웠으면) 알려준다 — 실패는 아님.
  const stillBroken = new Set(outOfRange.map(r => r.id));
  const fixed = [...KNOWN_OUT_OF_RANGE].filter(id => !stillBroken.has(id));
  if (fixed.length) {
    console.log(`[INV-AI2] 손상이 해소된 문항 ${fixed.length}건 — KNOWN_OUT_OF_RANGE 에서 제거하세요: ${fixed.join(',')}`);
  }
});

// ── INV-AI3 ─────────────────────────────────────────────────────────────
// 채점기 계약 소스 락 — "선택한 보기의 **0-based index** 와 answer 를 보정 없이 비교한다".
//
// 2026-08-07 채점 주체가 클라이언트 → **서버**로 옮겨졌다(정답 사전 노출 차단).
//   · content-player.html : selectChoice(idx, j) → answers[idx] = j (0-based) 를 그대로 전송,
//                           채점 후 정답 표시는 q.options[q.answer] (0-based 인덱싱)
//   · routes/content.js   : POST /:id/grade 에서 String(given) === String(q.answer)
// 어느 쪽이든 ±1 보정이 끼면 DB 정본(0-based)과 어긋나 전 문항이 오답 처리된다.
const PLAYER_REL = 'public/content/content-player.html';
const SERVER_REL = 'routes/content.js';

/** answer 에 ±1 보정을 건 흔적(1-based 회귀)을 찾는다. */
function findOffsetRegressions(source, rel) {
  const problems = [];
  // 보기 인덱싱에 ±1  — 표시용 "N번"(Number(q.answer)+1) 은 인덱싱이 아니므로 걸리지 않는다.
  if (/(?:options|opts)\s*\[\s*(?:Number\(\s*)?[\w.]*answer[^\]]*[+-]\s*1[^\]]*\]/i.test(source)) {
    problems.push(`${rel}: 보기 인덱싱에 answer±1 보정이 있습니다 — 1-based 회귀`);
  }
  // 채점 비교에 ±1
  if (/===\s*String\(\s*(?:Number\(\s*)?[\w.]*answer\s*\)?\s*[+-]\s*1/i.test(source)) {
    problems.push(`${rel}: 채점 비교에 answer±1 보정이 있습니다 — 1-based 회귀`);
  }
  return problems;
}

/** 서버 채점기가 0-based 직접 비교를 유지하는가. */
function hasServerZeroBasedCompare(source) {
  // String(<제출값>) === String(<문항>.answer) — 변수명은 바뀔 수 있으므로 형태만 본다.
  return /String\(\s*\w+\s*\)\s*===\s*String\(\s*\w+\.answer\s*\)/.test(source);
}

/** 플레이어가 0-based 인덱싱으로 정답 보기를 조회하는가. */
function hasPlayerZeroBasedIndexing(source) {
  return /\w+\.options\[\s*\w+\.answer\s*\]/.test(source);
}

function scanZeroBasedContract(playerSrc, serverSrc) {
  const problems = [];
  if (!hasPlayerZeroBasedIndexing(playerSrc)) {
    problems.push(`${PLAYER_REL}: 정답 보기 조회의 0-based 인덱싱(q.options[q.answer])을 찾지 못했습니다`);
  }
  if (!hasServerZeroBasedCompare(serverSrc)) {
    problems.push(`${SERVER_REL}: 서버 채점의 0-based 직접 비교(String(given) === String(q.answer))를 찾지 못했습니다`);
  }
  problems.push(...findOffsetRegressions(playerSrc, PLAYER_REL));
  problems.push(...findOffsetRegressions(serverSrc, SERVER_REL));
  return problems;
}

function readSrc(rel) {
  const abs = path.join(ROOT, rel);
  assert.ok(fs.existsSync(abs), `파일이 없습니다: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
}

test('INV-AI3: 채점 경로가 0-based 로 판정한다 [소스 락]', () => {
  assert.deepStrictEqual(
    scanZeroBasedContract(readSrc(PLAYER_REL), readSrc(SERVER_REL)), [],
    'DB 정본은 0-based 입니다. 채점기가 1-based 로 바뀌면 전 문항이 오답 처리됩니다.'
  );
});

// ── 역주입 (스캐너 자체가 살아 있는지) ──────────────────────────────────
// 소스 락은 "정규식이 안 맞아도 조용히 통과"하는 실패 모드가 있다.
// 위반 소스를 **메모리에서** 만들어 실제로 붉어지는지 확인한다(정본 파일은 건드리지 않는다).
test('INV-AI3 역주입: 1-based 로 되돌린 소스는 반드시 걸린다', () => {
  const player = readSrc(PLAYER_REL);
  const server = readSrc(SERVER_REL);
  assert.deepStrictEqual(scanZeroBasedContract(player, server), [], '정본 소스는 통과해야 한다');

  // (a) 서버 채점 비교를 1-based 로 되돌림
  const badServer = server.replace(
    /String\((\w+)\) === String\((\w+)\.answer\)/,
    'String($1) === String(Number($2.answer) - 1)'
  );
  assert.notStrictEqual(badServer, server, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(
    scanZeroBasedContract(player, badServer).length > 0,
    '서버 채점을 1-based 로 되돌렸는데 스캐너가 통과시켰다 — 락이 죽어 있다'
  );

  // (b) 플레이어의 정답 보기 인덱싱을 1-based 로 되돌림
  const badPlayer = player.replace(/(\w+)\.options\[(\w+)\.answer\]/g, '$1.options[$2.answer - 1]');
  assert.notStrictEqual(badPlayer, player, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(
    scanZeroBasedContract(badPlayer, server).length > 0,
    '1-based 인덱싱으로 되돌렸는데 스캐너가 통과시켰다 — 락이 죽어 있다'
  );
});

// ── REG-AI4: 변환 스크립트 멱등성 ───────────────────────────────────────
// 🔴 2026-08-07 사고 박제: `--apply` 를 두 번 실행하자 `MANUAL_INCLUDE` 3건(q69·q227·q228)이
//   **-1 을 두 번** 맞았다. q227 은 answer=0 까지 내려가 오답 보기 "①-5" 가 정답이 될 뻔했다.
//   자동 판정분은 변환 후 해설 신호가 '0based' 로 뒤집혀 재선정되지 않아 멱등이었지만,
//   수동 편입분은 증거 검사를 우회하므로 **별도 가드가 없으면 누적된다**.
//   → 수동 편입 항목은 반드시 `expect`(변환 전 answer)를 들고 있어야 하고,
//     스크립트는 현재값이 expect 와 다르면 건너뛰어야 한다.
const FIXER_REL = 'scripts/fix-answer-index-base.js';

function scanManualIncludeIdempotency(source) {
  const problems = [];
  const m = source.match(/const MANUAL_INCLUDE = new Map\(\[([\s\S]*?)\n\]\);/);
  if (!m) {
    problems.push(`${FIXER_REL}: MANUAL_INCLUDE 정의를 찾지 못했습니다`);
    return problems;
  }
  const body = m[1];
  // 각 항목이 { expect: <숫자> } 를 갖는지 — id 개수와 expect 개수가 같아야 한다.
  const entries = body.match(/\[\s*\d+\s*,/g) || [];
  const expects = body.match(/expect\s*:\s*\d+/g) || [];
  if (entries.length === 0) return problems;                 // 편입 항목이 없으면 검사 대상 없음
  if (expects.length !== entries.length) {
    problems.push(
      `${FIXER_REL}: MANUAL_INCLUDE 항목 ${entries.length}개 중 expect 를 가진 것은 ${expects.length}개 — ` +
      'expect 없는 항목은 재실행마다 -1 이 누적됩니다'
    );
  }
  // 가드가 실제로 코드에 존재하는지 (expect 와 현재값 비교 후 건너뛰기)
  if (!/q\.n\s*!==\s*mi\.expect/.test(source)) {
    problems.push(`${FIXER_REL}: 현재 answer 와 expect 를 비교해 건너뛰는 멱등 가드를 찾지 못했습니다`);
  }
  return problems;
}

test('REG-AI4: 변환 스크립트의 수동 편입은 멱등 가드를 갖는다 [소스 락]', () => {
  const abs = path.join(ROOT, FIXER_REL);
  assert.ok(fs.existsSync(abs), `스크립트가 없습니다: ${FIXER_REL}`);
  assert.deepStrictEqual(
    scanManualIncludeIdempotency(fs.readFileSync(abs, 'utf8')), [],
    '수동 편입 항목에 멱등 가드가 없으면 --apply 재실행 시 정답이 누적 차감됩니다(2026-08-07 실제 사고).'
  );
});

test('REG-AI4 역주입: expect 를 지우거나 가드를 없애면 걸린다', () => {
  const good = fs.readFileSync(path.join(ROOT, FIXER_REL), 'utf8');
  assert.deepStrictEqual(scanManualIncludeIdempotency(good), [], '정본 소스는 통과해야 한다');

  // (a) expect 필드 제거
  const bad1 = good.replace(/expect:\s*\d+,\s*/, '');
  assert.notStrictEqual(bad1, good, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(scanManualIncludeIdempotency(bad1).length > 0, 'expect 를 지웠는데 스캐너가 통과시켰다');

  // (b) 가드 조건 제거
  const bad2 = good.replace(/q\.n\s*!==\s*mi\.expect/, 'false');
  assert.notStrictEqual(bad2, good, '역주입 치환이 적용되지 않았다(패턴 불일치)');
  assert.ok(scanManualIncludeIdempotency(bad2).length > 0, '가드를 없앴는데 스캐너가 통과시켰다');
});

// ── INV-AI1/AI2 역주입 (사본에서만) ─────────────────────────────────────
// 불변식 자체가 실제로 위반을 잡는지, **테스트용 임시 사본**에 위반 행을 심어 확인한다.
// (setupTestDb 가 만든 사본을 다시 복제 — 정본은 물론 사본 원형도 건드리지 않는다)
test('INV-AI1/AI2 역주입: 위반 데이터를 심으면 불변식이 붉어진다', () => {
  const os = require('os');
  const injPath = path.join(os.tmpdir(), `dacheum_inv_ai_${process.pid}_${Date.now()}.db`);
  db.prepare('VACUUM INTO ?').run(injPath);
  const inj = new Database(injPath);
  try {
    // 위반을 심을 콘텐츠: 보기 4개짜리 문항을 2개 이상 가진 정상 콘텐츠 하나
    const target = inj.prepare(
      `SELECT content_id FROM content_questions
        WHERE question_type IN ('choice','multiple_choice') AND json_valid(options)
          AND json_array_length(options) = 4
        GROUP BY content_id HAVING COUNT(*) >= 2 LIMIT 1`
    ).get();
    assert.ok(target, '역주입 대상 콘텐츠를 찾지 못했다');
    const qs = inj.prepare(
      `SELECT id FROM content_questions WHERE content_id = ?
         AND question_type IN ('choice','multiple_choice') ORDER BY id LIMIT 2`
    ).all(target.content_id);

    // answer=0 (0-based 증거) 와 answer=4(=보기수, 1-based 증거) 를 한 콘텐츠에 공존시킴
    inj.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run('0', qs[0].id);
    inj.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run('4', qs[1].id);

    assert.ok(!KNOWN_OUT_OF_RANGE.has(qs[1].id), '역주입 대상이 동결 목록과 겹쳤다 — 다른 콘텐츠로 바꿔야 한다');

    // ── 불변식 **본체**를 그대로 돌려 실제로 붉어지는지 확인한다 ──
    const injRows = loadChoiceRows(inj);

    const ai1 = findMixedBaseContents(injRows);
    assert.ok(
      ai1.some(v => v.startsWith(`content ${target.content_id}:`)),
      `INV-AI1 이 심어 둔 위반(content ${target.content_id})을 잡지 못했다 — 불변식이 죽어 있다`
    );

    const ai2 = findUnknownOutOfRange(injRows);
    assert.ok(
      ai2.some(v => v.startsWith(`q${qs[1].id}(`)),
      `INV-AI2 가 심어 둔 범위밖 문항(q${qs[1].id})을 잡지 못했다 — 불변식이 죽어 있다`
    );

    // ── 정확한 역-Edit 으로 원복하고, 불변식이 다시 초록인지 확인 ──
    const orig = db.prepare('SELECT answer FROM content_questions WHERE id = ?');
    inj.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run(orig.get(qs[0].id).answer, qs[0].id);
    inj.prepare('UPDATE content_questions SET answer = ? WHERE id = ?').run(orig.get(qs[1].id).answer, qs[1].id);

    const restored = loadChoiceRows(inj);
    assert.deepStrictEqual(
      findMixedBaseContents(restored).filter(v => v.startsWith(`content ${target.content_id}:`)), [],
      '원복 후에도 INV-AI1 위반이 남아 있다'
    );
    assert.deepStrictEqual(
      findUnknownOutOfRange(restored).filter(v => v.startsWith(`q${qs[1].id}(`)), [],
      '원복 후에도 INV-AI2 위반이 남아 있다'
    );
  } finally {
    try { inj.close(); } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.existsSync(injPath + ext) && fs.unlinkSync(injPath + ext); } catch (_) {} }
  }
});
