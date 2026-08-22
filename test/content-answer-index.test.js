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
    out.push({ id: r.id, content_id: r.content_id, len: opts.length, n, opts });
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
// 🔴 예외 목록 없음 — **범위 밖 0건**이 불변식이다.
//   2026-08-07 시점에는 손상 35건을 `KNOWN_OUT_OF_RANGE` 로 동결해 "신규만" 감시했는데,
//   그 동안 이 불변식은 **기존 35건에 대해 잠들어 있었다**. 동결 목록은 결함을 관리 대상이
//   아니라 배경으로 만든다. 2026-08-21 에 전건을 해소하고 목록 자체를 없앴다.
//     · 34건 — 해설 대조로 문항별 정답 index 재작성(보고서/증적/정답키정합_20260821/,
//       채점 실증은 test/content-answer-key-integrity.test.js REG-AK2)
//     · q214 — 보기에 정답이 둘(1/2 = 2/4)이라 정답키로는 해소 불가했다.
//       1/2 을 오답 보기 4/4 로 교체해 **문항 자체를 수리**했다
//       (보고서/증적/문항중복정답_q214_20260821/).
//   다시 범위 밖이 생기면 **동결하지 말고 고칠 것.**
/** INV-AI2 판정 — 0-based 범위를 벗어난 문항 목록(테스트와 역주입이 같은 구현을 쓴다). */
function findOutOfRange(rows) {
  return rows
    .filter(r => !(r.n >= 0 && r.n <= r.len - 1))
    .map(r => `q${r.id}(content ${r.content_id}) answer=${r.n} 보기수=${r.len}`);
}

test('INV-AI2: 객관식 answer 는 0-based 범위(0 ~ 보기수-1) 안이다 — 범위 밖 0건', () => {
  assert.deepStrictEqual(
    findOutOfRange(loadChoiceRows()),
    [],
    '0-based 범위를 벗어난 문항이 있습니다. 이 문항은 **어떤 보기를 골라도 오답**입니다.\n' +
    '예외 목록에 넣지 말고 고치십시오 — 해설을 보기와 대조해 올바른 index 를 산출하면 됩니다.'
  );
});

// ── INV-AI5 ─────────────────────────────────────────────────────────────
// 정답 보기와 **글자가 똑같은 다른 보기**가 있으면 안 된다.
//   q214 가 이 부류였다(1/2 과 2/4 — 값이 같은 두 보기). 학생이 정답과 똑같이 생긴 칸을
//   골라도 오답 처리되므로, 정답키를 어떻게 잡아도 억울한 학생이 생긴다.
//
// ⚠ 여기서 잡는 것은 **문자열이 완전히 같은** 경우다. q214 처럼 "값은 같은데 표기가 다른"
//   경우(1/2 vs 2/4)는 사람이 봐야 한다 — 그래서 이 불변식은 그 부류의 하위집합만 막는다.
const DUP_ANSWER_OPTION_BACKLOG = new Set([
  // 2026-08-21 발견 26건 중 **25건은 해소**했다(중복된 오답 칸만 교체 — 정답 칸 무변동).
  //   보고서/증적/중복보기_20260821/ · 채점 실증은
  //   test/content-answer-key-integrity.test.js REG-AK6
  //
  // 🟠 남은 1건 — q11666(content 9842) "계산 결과가 작은 것부터 나열한 것은?"
  //   보기 ["0.6÷3, 0.8÷4, 0.9÷3"(중복), 정답(동일 문자열),
  //         "0.9÷3, 0.8÷4, 0.6÷3", "0.8÷4, 0.6÷3, 0.9÷3"]
  //   0.6÷3 과 0.8÷4 가 **둘 다 0.2 로 동점**이라 index 3 도 오름차순으로 옳다.
  //   글자 중복 칸만 바꿔도 **정답이 두 개인 상태가 남는다**(q214 와 같은 의미적 중복).
  //   해소하려면 나눗셈 수치를 바꿔 동점을 없애야 하고, 그러면 정답 보기 문구까지 바뀌어
  //   "정답 칸 불변" 원칙에 어긋난다.
  //   🔑 **선행 조건: 문항 전면 재작성**(동점이 나지 않는 세 나눗셈으로 수치를 다시 고르고
  //     네 보기의 순열을 새로 짠다) + 그 콘텐츠의 **제출 기록이 0 건**인지 확인.
  //     기록이 있으면 문항을 새로 만들어 교체하고 옛 문항은 보존해야 한다.
  //   ⚠ 이 목록은 **줄어들기만** 해야 하며 최종 목표는 비우는 것이다. 늘면 실패한다.
  //     (아래 역주입이 "목록에 있는데 실제로는 이미 고쳐진 항목"도 잡아 준다)
  11666,
]);

/**
 * INV-AI5 판정 — 정답 칸과 글자가 같은 다른 보기를 가진 문항.
 * ⚠ 정규화는 **양끝 공백만** 제거한다. 내부 공백까지 지우면
 *   "띄어쓰기가 바른 것은?"(보기가 공백으로만 구별되는 문항, q48·q163)이 통째로 오탐된다.
 */
function findDuplicateAnswerOption(rows, backlog = DUP_ANSWER_OPTION_BACKLOG) {
  const out = [];
  for (const r of rows) {
    if (!(r.n >= 0 && r.n <= r.len - 1)) continue;          // 범위 밖은 INV-AI2 담당
    const norm = r.opts.map(s => String(s).trim());
    const twins = norm.map((s, i) => (i !== r.n && s === norm[r.n] ? i : -1)).filter(i => i >= 0);
    if (twins.length && !backlog.has(r.id)) {
      out.push(`q${r.id}(content ${r.content_id}) 정답 index ${r.n} 과 글자가 같은 보기 [${twins}] — ${JSON.stringify(r.opts)}`);
    }
  }
  return out;
}

test('INV-AI5: 정답 보기와 글자가 같은 다른 보기가 없다 — 신규 0건', () => {
  assert.deepStrictEqual(
    findDuplicateAnswerOption(loadChoiceRows()), [],
    '정답과 똑같이 생긴 오답 보기가 있는 문항이 새로 생겼습니다.\n' +
    '학생이 정답과 동일한 글자를 골라도 오답 처리됩니다 — 중복 보기를 다른 값으로 바꾸십시오.'
  );
});

test('INV-AI5 역주입: 중복 보기를 심으면 반드시 걸린다 (백로그도 실제로 잡히는지 확인)', () => {
  const rows = loadChoiceRows();
  assert.deepStrictEqual(findDuplicateAnswerOption(rows), [], '정본 데이터는 통과해야 한다');

  // (a) 정상 문항에 중복을 심는다
  const victim = rows.find(r => r.n >= 0 && r.n < r.len - 1 && !DUP_ANSWER_OPTION_BACKLOG.has(r.id));
  assert.ok(victim, '역주입 대상 문항을 찾지 못했다');
  const twinIdx = victim.n === 0 ? 1 : 0;
  const injectedOpts = victim.opts.slice();
  injectedOpts[twinIdx] = victim.opts[victim.n];
  const injected = rows.map(r => (r.id === victim.id ? { ...r, opts: injectedOpts } : r));
  assert.ok(
    findDuplicateAnswerOption(injected).some(h => h.startsWith(`q${victim.id}(`)),
    `중복 보기를 심었는데 INV-AI5 가 통과시켰다 — 불변식이 죽어 있다`
  );

  // (b) 백로그가 **실재하는 결함**인지 — 예외를 걷어내면 반드시 붉어져야 한다.
  //     (이미 고쳐진 것을 목록에만 남겨 두면 이 단언이 알려 준다)
  const withoutBacklog = findDuplicateAnswerOption(rows, new Set());
  assert.equal(
    withoutBacklog.length, DUP_ANSWER_OPTION_BACKLOG.size,
    `백로그 ${DUP_ANSWER_OPTION_BACKLOG.size}건 중 실제로 남아 있는 것은 ${withoutBacklog.length}건입니다.\n` +
    '해소된 항목은 DUP_ANSWER_OPTION_BACKLOG 에서 지우십시오(목록은 줄어들기만 해야 합니다).\n' +
    withoutBacklog.join('\n')
  );
});

// ── INV-AI6 ─────────────────────────────────────────────────────────────
// 정답 보기와 **값이 같은**(글자는 다른) 보기가 없어야 한다.
//   INV-AI5 가 잡는 "글자 중복" 의 상위 부류다. q214(1/2 = 2/4)·q11666(0.6÷3 = 0.8÷4)·
//   q3877(6/12 = 1/2) 이 전부 이 부류였고, 학생이 **수학적으로 옳은 칸을 골라도 오답**이 된다.
//
// 판정에서 제외하는 것(결함이 아님):
//   · 단위가 다른 보기 — `700kg ≠ 700g`. 값만 같을 뿐 다른 양이다.
//   · 대분수의 분수부가 가분수인 형태(`3과 9/8` vs `4와 1/8`) — 대분수의 정의상 틀린 표기이므로
//     **정당한 오답 보기**다.
//   · 지문이 형식을 지정한 경우("**기약분수**로 나타내면?" 에 약분 전 값, "대분수로" 에 가분수)
// ── 단위 분리 ────────────────────────────────────────────────────────────
// 🔴 2026-08-21: 여기는 원래 **고정 단위 목록**(`['cm²','cm','kg','g','초',…]`)이었다.
//   그 목록에 `L`·`장` 이 없어서 같은 부류의 결함 6건이 **몇 달간 탐지를 빠져나갔다**
//   (q3391 `1 L` ↔ `8/8 L` · q3855 `3과 1/3 L` ↔ `10/3 L` · q10511 `1/2 장` ↔ `5/10 장` ·
//    q12242 `1/6 L` ↔ `5/30 L` 및 복제본). 단위를 하나씩 추가하는 구조는 **다음 단위에서 또
//   빠진다** — 목록을 늘리는 것으로는 같은 사고가 반복된다.
//   → **수치 토큰을 앵커로 잡고, 그 뒤에 오는 임의의 문자열을 단위로 본다**.
//     단위 자리에 숫자·연산자·구분자가 남으면 "수치+단위" 가 아니므로(수식·목록·비·범위)
//     값 비교 대상에서 제외한다 — 이것이 오탐을 막는 실제 장치다.
//   실측(2026-08-21): 객관식 11,878건 전수 스캔 → 적출 8건, **오탐 0건**.
//     (일반화 전 목록 방식이 놓치던 6건 + 백로그 2건이 정확히 그 8건이다)
const UNIT_TAIL_REJECT = /[\d/.,:=~×÷+\-*^()[\]{}<>]/;
const NUM_TOKEN = /^([-+]?\d+(?:[과와]\d+\/\d+|\/\d+|\.\d+)?)(.*)$/;
/** `{body, unit}` 또는 null(= 수치+단위 형태가 아니므로 값 비교 대상 아님). */
function splitUnit(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  const m = t.match(NUM_TOKEN);
  if (!m) return null;                                  // 수치로 시작하지 않는다
  if (UNIT_TAIL_REJECT.test(m[2])) return null;         // `2 × 17` · `3:5` · `5, 8, 11` · 수식
  return { body: m[1], unit: m[2] };
}
/** 단위(비교용). null 이면 값 비교 대상이 아니다. `700kg` 과 `700g` 은 서로 다른 양이다. */
const unitOf = (s) => { const p = splitUnit(s); return p ? p.unit : null; };
/** 문자열이 **수치 토큰(+임의 단위)** 일 때만 값으로 읽는다. `2 × 17`·`3:5` 는 null. */
function semanticValue(s) {
  const p = splitUnit(s);
  if (!p) return null;
  let m = p.body.match(/^([-+]?\d+)[과와](\d+)\/(\d+)$/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = p.body.match(/^([-+]?\d+)\/(\d+)$/); if (m) return Number(m[1]) / Number(m[2]);
  m = p.body.match(/^([-+]?\d+(?:\.\d+)?)$/); if (m) return Number(m[1]);
  return null;
}
const asMixed = (s) => { const p = splitUnit(s); if (!p) return null; const m = p.body.match(/^([-+]?\d+)[과와](\d+)\/(\d+)$/); return m ? { n: +m[2], d: +m[3] } : null; };
const asFrac = (s) => { const p = splitUnit(s); if (!p) return null; const m = p.body.match(/^([-+]?\d+)\/(\d+)$/); return m ? [+m[1], +m[2]] : null; };
const gcdOf = (a, b) => (b ? gcdOf(b, a % b) : a);

// 파서 계약을 표로 못 박는다 — 일반화를 다시 좁히면(또는 오탐 쪽으로 넓히면) 여기가 먼저 붉어진다.
// [입력, 기대 값(null = 비교 대상 아님), 기대 단위]
const PARSER_CONTRACT = [
  // 수치 + 단위 — 단위가 무엇이든 읽어야 한다(고정 목록이 아니다)
  ['-1/2', -0.5, ''], ['1과 2/10', 1.2, ''], ['3.5', 3.5, ''], ['+3/2', 1.5, ''],
  ['1 L', 1, 'L'], ['8/8 L', 1, 'L'], ['3과 1/3 L', 10 / 3, 'L'], ['1/2 장', 0.5, '장'],
  ['36cm²', 36, 'cm²'], ['180°', 180, '°'], ['4초', 4, '초'], ['2와1/21 kg', 2 + 1 / 21, 'kg'],
  ['2배', 2, '배'],
  // 단위가 다르면 다른 양이다 — 값이 같아도 짝으로 묶이면 안 된다
  ['700kg', 700, 'kg'], ['700g', 700, 'g'],
  // 수식·목록·비·번호 — 값 비교 대상이 아니다(여기가 오탐 방지선)
  ['2 × 17', null, null], ['3:5', null, null], ['5, 8, 11, 14', null, null],
  ['(x-2)²+(y+1)²=9', null, null], ['0.6÷3, 0.8÷4, 0.9÷3', null, null],
  ['①-5', null, null], ['99x=27, x=3/11', null, null], ['올바른 적용', null, null],
];

test('INV-AI6 파서 계약: 수치+임의 단위는 읽고, 수식·목록·비는 읽지 않는다', () => {
  const bad = [];
  for (const [input, val, unit] of PARSER_CONTRACT) {
    const gotVal = semanticValue(input);
    const gotUnit = unitOf(input);
    const valOk = val === null ? gotVal === null : (gotVal !== null && Math.abs(gotVal - val) < 1e-9);
    if (!valOk) bad.push(`${JSON.stringify(input)}: 값 ${gotVal} — 기대 ${val}`);
    if (gotUnit !== unit) bad.push(`${JSON.stringify(input)}: 단위 ${JSON.stringify(gotUnit)} — 기대 ${JSON.stringify(unit)}`);
  }
  assert.deepStrictEqual(
    bad, [],
    '단위 파서가 계약에서 벗어났습니다. 좁아지면 결함이 다시 숨고(2026-08-21 L·장 6건),\n' +
    '넓어지면 수식·목록이 오탐으로 쏟아집니다:\n' + bad.join('\n')
  );
  // 단위가 다른 같은 수는 **반드시** 다른 양으로 갈려야 한다(700kg ≠ 700g).
  assert.equal(semanticValue('700kg'), semanticValue('700g'), '전제: 두 값의 수치는 같다');
  assert.notStrictEqual(unitOf('700kg'), unitOf('700g'), '단위가 같다고 판정되면 700kg 과 700g 이 중복으로 잡힌다');
});

// 🟠 2026-08-21 남은 백로그 **1건**. **줄어들기만** 해야 하며 목표는 비우는 것이다.
//   · 배치 1(66건) — 보고서/증적/의미적중복_20260821/ · 채점 실증 REG-AK7
//   · 배치 2(34건) — 보고서/증적/의미적중복_배치2_20260821/ · 채점 실증 REG-AK8
//     33건은 **지문에 형식 요구를 덧붙여**(해설이 이미 약분·대분수 변환을 요구하고 있었다 —
//     지문↔해설 불일치였다), 1건(q7406)은 쌍둥이 보기를 교체해서.
//   · 배치 3(7건) — 보고서/증적/의미적중복_배치3_20260821/ · 채점 실증 REG-AK8
//     위 단위 파서를 일반화하며 드러난 6건(보기 교체) + q12417(정답키 이동).
const SEMANTIC_DUP_BACKLOG = new Set([
  // 🟠 q8954(content 7130) "11/4 ÷ 3/8" 보기 ["22/3"(정답), "33/32", "11/12", "7와 1/3", "5와 1/2"]
  //   쌍둥이 "7와 1/3" 은 정답 22/3 의 **대분수 표기**다. 둘 다 기약이라 "기약분수로" 로는
  //   구별되지 않고, "가분수로" 를 요구하는 것은 초등 6학년 나눗셈 차시의 통상 요구와 반대라
  //   학습 목표를 바꾼다. 보기 교체도 막혀 있다 — 이 문항은 해설의 ③④⑤ 번호가 **현재 정확히
  //   맞아** 있어 보기를 바꾸면 참조가 어긋난다.
  //   결정적으로 해설이 자기모순이다 — 본문은 "88/12 = 22/3 = 7과 1/3이다" 로 두 표기를
  //   **동치로 승인**하면서 "④는 약분 오류" 로 같은 칸을 오답 취급한다.
  //   🔑 **선행 조건: 해설 재작성** — 작성자가 어느 표기를 최종 답으로 보는지 확정돼야
  //     지문 형식 요구든 보기 교체든 근거가 생긴다. 그 전에는 무엇을 고쳐도 추측이다.
  8954,
]);

/** INV-AI6 판정 — 정답과 값이 같은 보기를 가진 문항(백로그 제외). */
function findSemanticDuplicates(rows, backlog = SEMANTIC_DUP_BACKLOG, texts = null) {
  const out = [];
  for (const r of rows) {
    if (!(r.n >= 0 && r.n <= r.len - 1)) continue;              // 범위 밖은 INV-AI2 담당
    const ansText = r.opts[r.n];
    const av = semanticValue(ansText);
    if (av === null) continue;
    const unit = unitOf(ansText);
    const tw = r.opts.map((o, i) => {
      if (i === r.n) return -1;
      if (unitOf(o) !== unit) return -1;                        // 단위가 다르면 다른 양
      const v = semanticValue(o);
      if (v === null || Math.abs(v - av) >= 1e-9) return -1;
      const a = asMixed(ansText), b = asMixed(o);
      if (a && b && a.n < a.d && b.n >= b.d) return -1;         // 가분수형 대분수 = 형식 오답
      return i;
    }).filter((i) => i >= 0);
    if (!tw.length) continue;

    // 지문이 형식을 지정하면 형식이 어긋난 동치는 정당한 오답 보기다
    const q = String((texts && texts.get(r.id)) || '');
    const af = asFrac(ansText);
    const ansIrreducible = af ? gcdOf(Math.abs(af[0]), af[1]) === 1 : true;
    if (/기약분수/.test(q) && ansIrreducible && tw.every((i) => { const p = asFrac(r.opts[i]); return p ? gcdOf(Math.abs(p[0]), p[1]) !== 1 : false; })) continue;
    if (/대분수/.test(q) && asMixed(ansText) && tw.every((i) => !asMixed(r.opts[i]))) continue;

    if (backlog.has(r.id)) continue;
    out.push(`q${r.id}(content ${r.content_id}) 정답 "${ansText}" 와 값이 같은 보기 ${JSON.stringify(tw.map((i) => r.opts[i]))}`);
  }
  return out;
}

/** 지문 조회 — 형식 요구 판별에 쓴다. */
function questionTexts() {
  return new Map(db.prepare(
    "SELECT id, question_text FROM content_questions WHERE question_type IN ('choice','multiple_choice')"
  ).all().map(r => [r.id, r.question_text]));
}

test('INV-AI6: 정답과 값이 같은 보기가 없다 — 백로그 외 신규 0건', () => {
  assert.deepStrictEqual(
    findSemanticDuplicates(loadChoiceRows(), SEMANTIC_DUP_BACKLOG, questionTexts()), [],
    '정답과 **값이 같은** 오답 보기가 있는 문항이 새로 생겼습니다.\n' +
    '학생이 수학적으로 옳은 칸을 골라도 오답 처리됩니다 — 그 보기를 다른 값으로 바꾸십시오.'
  );
});

test('INV-AI6 역주입: 값이 같은 보기를 심으면 걸린다 (백로그도 실제로 남아 있는지 확인)', () => {
  const rows = loadChoiceRows();
  const texts = questionTexts();
  assert.deepStrictEqual(findSemanticDuplicates(rows, SEMANTIC_DUP_BACKLOG, texts), [], '정본 데이터는 통과해야 한다');

  // (a) 정상 문항에 "값은 같고 글자는 다른" 보기를 심는다 — 글자 중복(INV-AI5)이 아닌 형태로.
  const victim = rows.find(r => {
    if (!(r.n >= 0 && r.n < r.len)) return false;
    if (SEMANTIC_DUP_BACKLOG.has(r.id)) return false;
    const f = asFrac(r.opts[r.n]);
    return !!f && f[0] !== 0 && r.opts.some((o, i) => i !== r.n);
  });
  assert.ok(victim, '역주입 대상(정답이 분수인 문항)을 찾지 못했다');
  const [p, q] = asFrac(victim.opts[victim.n]);
  const twinIdx = victim.n === 0 ? 1 : 0;
  const injectedOpts = victim.opts.slice();
  injectedOpts[twinIdx] = `${p * 2}/${q * 2}`;                   // 값은 같고 글자는 다른 형태
  assert.notStrictEqual(injectedOpts[twinIdx], victim.opts[victim.n], '역주입 값이 정답과 글자까지 같아졌다');
  const injected = rows.map(r => (r.id === victim.id ? { ...r, opts: injectedOpts } : r));
  assert.ok(
    findSemanticDuplicates(injected, SEMANTIC_DUP_BACKLOG, texts).some(h => h.startsWith(`q${victim.id}(`)),
    `q${victim.id} 에 ${p * 2}/${q * 2}(= 정답 ${p}/${q})를 심었는데 INV-AI6 가 통과시켰다 — 불변식이 죽어 있다`
  );

  // (b) 백로그가 **실재하는 결함**인지 — 예외를 걷어내면 정확히 그만큼 붉어져야 한다.
  const withoutBacklog = findSemanticDuplicates(rows, new Set(), texts);
  assert.equal(
    withoutBacklog.length, SEMANTIC_DUP_BACKLOG.size,
    `백로그 ${SEMANTIC_DUP_BACKLOG.size}건 중 실제로 남아 있는 것은 ${withoutBacklog.length}건입니다.\n` +
    '해소된 항목은 SEMANTIC_DUP_BACKLOG 에서 지우십시오(목록은 줄어들기만 해야 합니다).\n' +
    withoutBacklog.join('\n')
  );
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


    // ── 불변식 **본체**를 그대로 돌려 실제로 붉어지는지 확인한다 ──
    const injRows = loadChoiceRows(inj);

    const ai1 = findMixedBaseContents(injRows);
    assert.ok(
      ai1.some(v => v.startsWith(`content ${target.content_id}:`)),
      `INV-AI1 이 심어 둔 위반(content ${target.content_id})을 잡지 못했다 — 불변식이 죽어 있다`
    );

    const ai2 = findOutOfRange(injRows);
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
      findOutOfRange(restored).filter(v => v.startsWith(`q${qs[1].id}(`)), [],
      '원복 후에도 INV-AI2 위반이 남아 있다'
    );
  } finally {
    try { inj.close(); } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.existsSync(injPath + ext) && fs.unlinkSync(injPath + ext); } catch (_) {} }
  }
});
