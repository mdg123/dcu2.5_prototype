#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 의미적 중복 정답 수리 — "값은 같은데 글자만 다른" 보기 교체 (2026-08-21, 배치 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * ■ 무엇이 문제였나
 *   계산 문항에서 **약분 전 중간값**과 **약분 후 최종값**이 둘 다 보기에 들어 있었다.
 *     예) q3877 "2/3 × 3/4 = ?" 보기 ["6/12","1/2","6/7","5/7"] answer=1
 *         → 6/12 는 수학적으로 1/2 과 같은 값이다. 그 칸을 고른 학생은 **옳게 풀고도 오답**이 된다.
 *   q214(1/2 = 2/4) · q11666(0.6÷3 = 0.8÷4) 와 같은 부류이며, 글자 비교로는 잡히지 않는다.
 *
 * ■ 원칙 (앞선 라운드와 동일한 안전선)
 *   A. **정답 칸은 절대 건드리지 않는다.** answer 값도, 정답 보기 텍스트도 그대로 둔다.
 *      정답이 이동하면 기존 제출 기록의 정오답이 뒤집힌다.
 *      → UPDATE 는 `options` 한 컬럼만 쓰고, 바꾸는 것은 **정답과 값이 같은 오답 칸**뿐이다.
 *   B. **지문은 손대지 않는다.** "기약분수로" 를 지문에 끼워 넣어 해결하는 방식은
 *      문항의 학습 목표를 바꾸는 것이라 범위를 넘는다. 보기 교체로만 해결한다.
 *   C. 교체 값은 그 문항의 **오개념**에 대응하고, 가능하면 같은 문항군이 이미 쓰는
 *      오답 보기 어휘(분모끼리 더함 · 곱셈을 덧셈으로 · 분자·분모 뒤집기)를 따른다.
 *   D. 판단이 안 서면 **건드리지 않는다**. 배치 1 에서 제외한 18건은 아래 DEFERRED 참조.
 *
 * ■ 손대지 않는 것 (이 스크립트의 대상이 아니다)
 *   · 단위 상이 6건 — `700kg ≠ 700g`. 감사 파서의 오탐이며 결함이 아니다.
 *   · 형식 요구 52건 — "**기약분수**로 나타내면?" 처럼 지문이 형식을 지정하면
 *     약분 전 값은 **정당한 오답 보기**다. 대분수 계산에서 분수부가 가분수인 형태도 같다.
 *
 * ■ 가드
 *   · 교체 칸 index ≠ 정답 index · 정답 보기 텍스트 불변
 *   · 교체 후 보기 **글자 전부 상이** · **수치 전부 상이**
 *     (수치 가드는 2026-08-21 q3381 에서 "2과 9/6 = 3.5 = 정답" 을 실제로 잡아낸 그 가드다)
 *   · 새 값이 **해설에 등장하지 않는다**(DB 단계) — 등장하면 학생이 그 보기를 정답으로 읽는다
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용법
 *   node scripts/fix-equivalent-options-20260821.js              # DRY-RUN
 *   node scripts/fix-equivalent-options-20260821.js --apply
 *   node scripts/fix-equivalent-options-20260821.js --db <사본> --apply
 *   node scripts/fix-equivalent-options-20260821.js --selftest    # 계획 검증(DB 무접촉)
 *
 *   --apply 직후 반드시: npm test
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DQUOTE = String.fromCharCode(34);
// SQL 이스케이프는 split/join 으로 한다. 정규식 리터럴 안의 따옴표는 REG-HF8 의
// 괄호 깊이 스캐너를 어긋나게 한다(2026-08-21 실측).
const SQUOTE = String.fromCharCode(39);
const sq = (s) => String(s).split(SQUOTE).join(SQUOTE + SQUOTE);

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const APPLY = process.argv.includes('--apply');
const DB_PATH = path.resolve(ROOT, argVal('--db', path.join('data', 'dacheum.db')));
const IS_CANON = path.resolve(DB_PATH) === path.resolve(ROOT, 'data', 'dacheum.db');
const OUT_DIR = path.resolve(ROOT, argVal('--out', IS_CANON
  ? path.join('보고서', '증적', '의미적중복_20260821')
  : path.join(path.dirname(DB_PATH), '증적_의미적중복_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 계획 ────────────────────────────────────────────────────────────────────
// S(ids, answer, options, [[교체칸, 새값], ...], why)
//   ids 가 여럿인 것은 **같은 문항의 복제본**이다(보기·정답이 동일). 같은 교체값을 쓴다.
const SPECS = [];
const S = (ids, answer, options, swaps, why) => SPECS.push({ ids, answer, options, swaps, why });

// ── ① 조사 표기만 다른 중복 ──────────────────────────────────────────────────
S([3371, 4883], '2', ['3과 1/8 m', '4과 1/8 m', '4와 1/8 m', '3과 9/8 m'],
  [[1, '3과 9/16 m']],
  '보기[1]"4과 1/8 m"는 정답 "4와 1/8 m"와 **조사(과/와)만 다른 같은 값** — 학생이 구별할 수 없다. '
  + '분모끼리 더한 오답(3/8+6/8→9/16)으로 교체. 조사는 앞 수의 받침을 따라 3과·4와가 맞다. '
  + '보기[3]"3과 9/8 m"는 분수부가 가분수인 **형식 오답**이라 정당하므로 그대로 둔다.');

// ── ② 대분수·소수 표기 중복 ─────────────────────────────────────────────────
S([3696, 5208], '2', ['2와 1/4', '2과 2/4', '2과 1/2', '3과 1/2'],
  [[1, '2과 3/4']],
  '2과 2/4 = 2과 1/2(정답)로 값이 같다. 분수부를 빼지 않고 큰 쪽을 그대로 쓴 오답(3/4)으로 교체');
S([3900, 5356], '1', ['4과 1/4', '5', '6', '4와 4/4'],
  [[3, '4']],
  '4와 4/4 = 5(정답)로 값이 같다. 분수 부분을 곱하지 않고 자연수만 곱한 오답(4×1=4)으로 교체');
S([8076], '2', ['5.7', '0.3', '4.3', '4.7', '4.30'],
  [[4, '3.3']],
  '4.30 = 4.3(정답)로 값이 같다(뒤 0 만 다름). 일의 자리에서 과도하게 받아내림한 오답으로 교체');
S([10506], '0', ['2와 1/2', '2와 1/4', '2와 3/4', '2와 2/4'],
  [[3, '3과 1/2']],
  '2와 2/4 = 2와 1/2(정답)로 값이 같다. 자연수는 빼지 않고 분수만 뺀 오답으로 교체');
S([10515], '1', ['3과 8/16', '4와 1/6', '3과 1/6', '4와 2/12'],
  [[3, '3과 8/12']],
  '4와 2/12 = 4와 1/6(정답)로 값이 같다. 통분 없이 분자끼리 더한 오답(3+5=8)으로 교체');

// ── ③ 결과가 정수인 분수 계산 — 약분 전 형태가 중복 ─────────────────────────
S([2382], '0', ['1', '6/12', '6/6', '5/6', '7/6'],
  [[2, '4/6']], '6/6 = 1(정답). 더하기를 빼기로 착각한 오답(5-1=4)으로 교체');
S([2457], '3', ['4/3', '3/3', '2/3', '1', '3/6'],
  [[1, '1/3']], '3/3 = 1(정답). 분자를 뺀 오답(2-1=1)으로 교체');
S([2458], '3', ['2/2', '2/4', '3/2', '1', '1/2'],
  [[0, '1/4']], '2/2 = 1(정답). 분모끼리 곱하고 분자는 그대로 둔 오답으로 교체');
S([3854, 5310], '3', ['3/7', '3/49', '21/7', '3'],
  [[2, '10/7']], '21/7 = 3(정답). 곱셈을 덧셈으로 착각한 오답(3+7=10)으로 교체');
S([3860, 5316], '3', ['8', '1/2', '4/2', '2'],
  [[2, '5/2']], '4/2 = 2(정답). 곱셈을 덧셈으로 착각한 오답(4+1=5)으로 교체');
S([3861, 5317], '0', ['4', '12/3', '2', '12'],
  [[1, '8/3']], '12/3 = 4(정답). 곱셈을 덧셈으로 착각한 오답(6+2=8)으로 교체');
S([3896, 5352], '0', ['6', '24/4', '2', '3'],
  [[1, '11/4']], '24/4 = 6(정답). 곱셈을 덧셈으로 착각한 오답(8+3=11)으로 교체');
S([3897, 5353], '2', ['3', '18/3', '6', '18'],
  [[1, '11/3']], '18/3 = 6(정답). 곱셈을 덧셈으로 착각한 오답(9+2=11)으로 교체');
S([3898, 5354], '3', ['10', '30/5', '3', '6'],
  [[1, '17/5']], '30/5 = 6(정답). 곱셈을 덧셈으로 착각한 오답(15+2=17)으로 교체');
S([5716], '0', ['1', '7/5', '6/5', '5/5', '1/5'],
  [[3, '2/5']], '5/5 = 1(정답). 실수부 계산을 잘못한 오답으로 교체');

// ── ④ 분수 곱셈 — 약분 전 중간값이 중복 ─────────────────────────────────────
S([72], '1', ['6/12', '1/2', '5/7', '2/4'],
  [[0, '6/7'], [3, '5/12']],
  '6/12·2/4 가 모두 1/2(정답)과 값이 같다. 분모끼리 더한 오답(6/7)과 분자합/분모곱 오답(5/12)으로 교체');
S([216], '1', ['2/8', '1/4', '3/8', '2/16'],
  [[0, '8/8']], '2/8 = 1/4(정답). 뺄셈을 덧셈으로 착각한 오답(5+3=8)으로 교체');
S([3872, 5328], '2', ['2/7', '3/12', '2/12', '1/6'],
  [[3, '3/7']], '1/6 = 2/12(정답). 분자합/분모합 오답(2+1=3, 3+4=7)으로 교체');
S([3875, 5331], '3', ['4/7', '3/12', '3/7', '1/4'],
  [[1, '4/12']], '3/12 = 1/4(정답). 분자를 잘못 고른 오답으로 교체');
S([3877, 5333], '1', ['6/12', '1/2', '6/7', '5/7'],
  [[0, '5/12']], '6/12 = 1/2(정답). 분자합/분모곱 오답(2+3=5, 3×4=12)으로 교체');
S([3878, 5334], '2', ['7/14', '12/45', '4/15', '3/9'],
  [[1, '12/14']], '12/45 = 4/15(정답). 분모끼리 더한 오답(5+9=14)으로 교체');
S([3879, 5335], '0', ['3/10', '5/9', '6/20', '2/5'],
  [[2, '6/9']], '6/20 = 3/10(정답). 분모끼리 더한 오답(4+5=9)으로 교체');
S([3881, 5337], '1', ['24/60', '2/5', '9/60', '6/12'],
  [[0, '24/12']], '24/60 = 2/5(정답). 분모끼리 더한 오답(3+4+5=12)으로 교체');
S([3883, 5339], '3', ['2/6', '20/60', '4/60', '1/3'],
  [[0, '2/60'], [1, '20/13']],
  '2/6·20/60 이 모두 1/3(정답)과 값이 같다. 분자 계산 오류(2/60)와 분모끼리 더한 오답(2+5+6=13)으로 교체');
S([3888, 5344], '2', ['12/32', '12/8', '3/2', '3/8'],
  [[1, '7/8']], '12/8 = 3/2(정답). 곱셈을 덧셈으로 착각한 오답(3+4=7)으로 교체');
S([3889, 5345], '3', ['5/3', '15/6', '15/18', '5/2'],
  [[1, '8/6']], '15/6 = 5/2(정답). 곱셈을 덧셈으로 착각한 오답(5+3=8)으로 교체');
S([3890, 5346], '0', ['8/3', '24/9', '4/3', '8/9'],
  [[1, '10/9']], '24/9 = 8/3(정답). 곱셈을 덧셈으로 착각한 오답(4+6=10)으로 교체');
S([3905, 5361], '0', ['5/8', '15/24', '8/10', '3/8'],
  [[1, '15/10']], '15/24 = 5/8(정답). 분모끼리 더한 오답(6+4=10)으로 교체');
S([3906, 5362], '1', ['4/8', '1/2', '28/56', '3/8'],
  [[0, '4/15'], [2, '28/15']],
  '4/8·28/56 이 모두 1/2(정답)과 값이 같다. 둘 다 분모끼리 더한 오답(8+7=15)으로 교체');
S([3907, 5363], '3', ['3/6 m²', '15/24 m²', '8/10 m²', '5/8 m²'],
  [[1, '15/10 m²']], '15/24 m² = 5/8 m²(정답). 분모끼리 더한 오답(6+4=10)으로 교체');
S([10209], '1', ['1/4', '6/24', '1/2', '3/8'],
  [[0, '6/9']], '1/4 = 6/24(정답). 분모끼리 더한 오답(2+3+4=9)으로 교체');
S([10211], '2', ['36/180', '1/4', '1/5', '12/45'],
  [[0, '36/20']], '36/180 = 1/5(정답). 분모 계산을 잘못한 오답으로 교체');

// ── ⑤ 분수 표현·나눗셈 — 약분 전 형태가 중복 ────────────────────────────────
S([20, 25, 30, 35, 40], '0', ['1/2', '1/5', '5/10', '1/3'],
  [[2, '5/100']], '5/10 = 1/2(정답). 소수점 자리를 잘못 읽은 오답으로 교체');
S([10524], '1', ['1/4', '1/2', '3/4', '4/8'],
  [[3, '8/4']], '4/8 = 1/2(정답). 분자·분모를 뒤집은 오답으로 교체');
S([10525], '3', ['3/9', '1/3', '3/12', '1/4'],
  [[2, '12/3']], '3/12 = 1/4(정답). 분자·분모를 뒤집은 오답으로 교체');
S([10546], '3', ['8/8', '2/12', '1/4', '1/6'],
  [[1, '14/12']], '2/12 = 1/6(정답). 뺄셈을 덧셈으로 착각한 오답(11+3=14)으로 교체');
S([10552], '1', ['1/5', '1/3', '5/15', '2/5'],
  [[2, '15/5']], '5/15 = 1/3(정답). 분자·분모를 뒤집은 오답으로 교체');
S([10553], '3', ['4/6', '1/2', '3/6', '2/3'],
  [[0, '6/4']], '4/6 = 2/3(정답). 분자·분모를 뒤집은 오답으로 교체');
S([12236], '3', ['6/24 m', '3/8 m', '2/3 m', '2/8 m'],
  [[0, '18/8 m']], '6/24 m = 2/8 m(정답). 나눗셈을 곱셈으로 착각한 오답(6×3=18)으로 교체');

// SPECS → 문항 단위 계획
const PLAN = [];
for (const s of SPECS) {
  for (const id of s.ids) {
    PLAN.push({ id, answer: s.answer, options: s.options, swaps: s.swaps, why: s.why });
  }
}

// ── 배치 1 에서 **의도적으로 제외** — 다음 사이클 인계 ────────────────────────
// 공통 사유: 이 문항들의 해설이 "①은 …, ②는 …" 로 **오답 보기의 이유를 하나씩 열거**한다.
//   즉 약분 전 형태를 작성자가 **의도한 오답 보기**로 명시했을 가능성이 있고,
//   보기를 바꾸면 해설의 번호 참조가 어긋난다(해설까지 고쳐야 하는데 그건 별개 판단이다).
//   전체 해설을 읽고 "그 쌍둥이 칸을 실제로 지목하는가" 를 문항별로 확인한 뒤 처리해야 한다.
const DEFERRED = [
  6340, 6355, 6375, 7406, 8683, 8685, 8708, 8710, 8719,
  8725, 8916, 8940, 8941, 8949, 8950, 8951, 8954, 12417,
];

/**
 * 보기 텍스트를 수치로 읽는다(못 읽으면 null).
 * 🔴 글자만 비교하면 q214 부류를 또 만든다 — 2026-08-21 실측: q3381 교체 후보 "2과 9/6"(=3.5)이
 *   정답 "3과 3/6"(=3.5)과 값이 같았다. 글자는 달라 중복 검사를 통과했을 것이다.
 * 목록형("5, 8, 11, 14")·수식("(x-2)²+…")은 판정하지 않는다.
 */
function parseNumericish(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  if (t.includes(',')) return null;
  let m = t.match(/^(-?\d+)[과와](\d+)\/(\d+)/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(-?\d+)\/(\d+)/); if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(-?\d+(?:\.\d+)?)/); if (m) return Number(m[1]);
  return null;
}
const numEq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
const after = (p) => { const a = p.options.slice(); for (const [i, v] of p.swaps) a[i] = v; return a; };

/** "N과 a/b" 형태로 읽는다(아니면 null). */
function asMixed(s) {
  const m = String(s == null ? '' : s).replace(/\s+/g, '').match(/^(-?\d+)[과와](\d+)\/(\d+)/);
  return m ? { w: Number(m[1]), n: Number(m[2]), d: Number(m[3]) } : null;
}
/**
 * "값은 같지만 **형식이 틀려서** 정당한 오답" 인가.
 *
 * 대분수의 분수 부분은 **진분수**여야 한다(정의). 그래서 `3과 9/8` 은 `4와 1/8` 과 값이 같아도
 * 대분수로서는 틀린 표기이고, 대분수 덧셈 차시의 **정당한 오답 보기**다.
 * (같은 이유로 전수 감사에서 이 부류 52건을 "형식 요구로 정당" 으로 분류해 손대지 않았다.)
 *
 * ⚠ 이 예외는 **이미 있던 보기**를 판정할 때만 쓴다. 내가 새로 넣는 값에는 적용하지 않는다 —
 *   새 값은 예외 없이 "정답과 수치가 다를 것" 을 요구한다.
 */
function isLegitFormTwin(ansText, optText) {
  const a = asMixed(ansText), o = asMixed(optText);
  return !!(a && o && a.n < a.d && o.n >= o.d);
}

// ── 계획 자체 검증 (DB 무접촉) ──────────────────────────────────────────────
function selftestPlan() {
  const problems = [];
  const seen = new Set();
  for (const p of PLAN) {
    const tag = `q${p.id}`;
    if (seen.has(p.id)) problems.push(`${tag}: 중복 항목`);
    seen.add(p.id);
    if (!p.why) problems.push(`${tag}: 교체 근거(why)가 없다`);

    const n = Number(p.answer);
    if (!Number.isInteger(n) || n < 0 || n >= p.options.length) {
      problems.push(`${tag}: answer=${p.answer} 가 범위 밖 (보기수 ${p.options.length})`); continue;
    }
    if (!p.swaps.length) problems.push(`${tag}: 교체 항목이 없다`);

    const av = parseNumericish(p.options[n]);
    for (const [i, v] of p.swaps) {
      // A. 정답 칸 보호
      if (i === n) problems.push(`${tag}: 교체 대상이 **정답 칸**(index ${n})이다 — 정답은 건드리지 않는다`);
      if (!(i >= 0 && i < p.options.length)) problems.push(`${tag}: 교체 index ${i} 범위 밖`);
      // 교체 대상이 실제로 정답과 **값이 같은** 칸인지 (이 스크립트의 존재 이유)
      if (!numEq(av, parseNumericish(p.options[i]))) {
        problems.push(`${tag}: 보기[${i}]"${p.options[i]}" 는 정답 "${p.options[n]}" 와 값이 다르다 — 교체 대상이 아니다`);
      }
    }
    const A = after(p);
    if (A.length !== p.options.length) problems.push(`${tag}: 보기 개수가 달라진다`);
    if (String(A[n]).trim() !== String(p.options[n]).trim()) problems.push(`${tag}: 정답 보기 텍스트가 바뀐다 — 금지`);

    // B. 교체 후 글자 전부 상이
    const norm = A.map((s) => String(s).trim());
    if (new Set(norm).size !== norm.length) problems.push(`${tag}: 교체 후 글자가 같은 보기가 남는다 → ${JSON.stringify(A)}`);
    // C. 교체 후 **수치**도 전부 상이 (정답과 같은 값이 하나도 남지 않아야 한다)
    A.forEach((o, i) => {
      if (i === n) return;
      if (numEq(parseNumericish(o), av) && !isLegitFormTwin(p.options[n], o)) {
        problems.push(`${tag}: 교체 후에도 보기[${i}]"${o}" 가 정답과 **값이 같다**(${av})`);
      }
    });
  }
  for (const d of DEFERRED) if (seen.has(d)) problems.push(`q${d}: 인계 목록에 있는 문항이 변경 계획에 들어 있다`);
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  console.log(problems.length
    ? `[selftest] FAIL (${problems.length})\n - ${problems.join('\n - ')}`
    : `[selftest] PASS — 계획 ${PLAN.length}건(고유 ${SPECS.length}종), 인계 ${DEFERRED.length}건`);
  process.exit(problems.length ? 1 : 0);
}
const planProblems = selftestPlan();
if (planProblems.length) {
  console.error(`[중단] 계획 자체가 잘못됐습니다:\n - ${planProblems.join('\n - ')}`);
  process.exit(1);
}

// ── DB 조회 & expect 가드 ───────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(DB_PATH, { readonly: !APPLY });

/** 새 보기 값이 해설에 등장하는가(공백 제거·소문자, 2글자 이상만). */
function namedByExplanation(text, explanation) {
  const e = String(explanation == null ? '' : explanation).replace(/\s+/g, '').toLowerCase();
  const t = String(text).replace(/\s+/g, '').toLowerCase();
  return t.length >= 2 && e.includes(t);
}

const todo = [];
const already = [];
const blockers = [];
for (const p of PLAN) {
  const r = db.prepare(
    'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
  ).get(p.id);
  if (!r) { blockers.push(`q${p.id}: DB 에 없다`); continue; }

  const expectOptions = JSON.stringify(p.options);
  const toOptions = JSON.stringify(after(p));

  if (String(r.options) === toOptions && String(r.answer) === p.answer) { already.push(p.id); continue; }
  if (String(r.answer) !== p.answer) {
    blockers.push(`q${p.id}: answer 가 계획과 다르다 (기대 '${p.answer}' / 현재 '${r.answer}')`); continue;
  }
  if (String(r.options) !== expectOptions) {
    blockers.push(`q${p.id}: 보기가 계획과 다르다\n      기대: ${expectOptions}\n      현재: ${r.options}`); continue;
  }
  const bad = p.swaps.filter(([, v]) => namedByExplanation(v, r.explanation));
  if (bad.length) {
    blockers.push(`q${p.id}: 새 값 ${bad.map(([, v]) => `"${v}"`).join(', ')} 가 해설에 등장한다 — 학생이 정답으로 읽는다\n      해설: ${r.explanation}`);
    continue;
  }
  todo.push({ ...p, content_id: r.content_id, question_text: r.question_text,
    expectOptions, toOptions, explanation: r.explanation });
}

console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건(고유 ${SPECS.length}종) → 변경 ${todo.length} · 이미 반영 ${already.length} · 차단 ${blockers.length}`);
console.log(`인계(배치 2 대기): ${DEFERRED.length}건 — ${DEFERRED.join(', ')}`);

if (blockers.length) {
  console.error(`\n🔴 expect 가드 위반 — **한 행도 쓰지 않고 중단합니다**:\n - ${blockers.join('\n - ')}`);
  db.close();
  process.exit(2);
}

// ── 증적: 쓰기 **전에** ─────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
function csvCell(s) {
  return DQUOTE + String(s == null ? '' : s).split(DQUOTE).join(DQUOTE + DQUOTE) + DQUOTE;
}
/** 기존 산출물을 축소된 내용으로 덮지 않는다(2026-08-07 rollback 소실 사고). */
function writePreserving(target, content, countRows) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return;
    const bak = path.join(path.dirname(target), path.basename(target).replace(
      /(\.[^.]+)$/, `.${new Date(fs.statSync(target).mtime).toISOString().replace(/[:.]/g, '-')}.bak$1`));
    fs.copyFileSync(target, bak);
    if (countRows(content) < countRows(prev)) {
      const preview = target.replace(/(\.[^.]+)$/, '.preview$1');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(`[보존] 기존 ${path.basename(target)}(${countRows(prev)}행)이 새 산출물(${countRows(content)}행)보다 많아 덮어쓰지 않았습니다.`);
      console.warn(`        기존 유지: ${target}\n        새 산출물: ${preview}`);
      return;
    }
    console.warn(`[보존] 기존 ${path.basename(target)} 을 ${path.basename(bak)} 로 백업하고 갱신합니다.`);
  }
  fs.writeFileSync(target, content, 'utf8');
}
/** 사람이 덧붙인 blockquote(>) 주석이 있으면 원본을 지킨다. 이 생성기는 `>` 줄을 만들지 않는다. */
function writePreservingAnnotations(target, content) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return;
    if (prev.split(/\r?\n/).some((l) => /^\s*>/.test(l))) {
      const preview = target.replace(/(\.[^.]+)$/, '.preview$1');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(`[보존] ${path.basename(target)} 에 손글씨 주석(> …)이 있어 덮어쓰지 않았습니다. 새 산출물: ${preview}`);
      return;
    }
  }
  fs.writeFileSync(target, content, 'utf8');
}

const stampIso = new Date().toISOString();
const rollbackPath = path.join(OUT_DIR, 'rollback.sql');
writePreserving(rollbackPath, [
  '-- 의미적 중복 정답 수리(2026-08-21 배치1) 롤백 — options 만 되돌린다(answer 는 애초에 안 바꿨다)',
  `-- 생성: ${stampIso}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${todo.length}건`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...todo.map((t) => `UPDATE content_questions SET options='${sq(t.expectOptions)}' WHERE id=${t.id};`),
  'COMMIT;',
  '',
].join('\n'), (s) => (s.match(/WHERE id=/g) || []).length);

const changesPath = path.join(OUT_DIR, 'changes.csv');
writePreserving(changesPath, [
  ['qid', 'content_id', 'question_text', 'answer_index', 'answer_text', 'replaced_index',
   'before_option', 'after_option', 'before_options', 'after_options', 'why'].map(csvCell).join(','),
  ...todo.flatMap((t) => t.swaps.map(([i, v]) => [
    t.id, t.content_id, t.question_text, t.answer, t.options[Number(t.answer)], i,
    t.options[i], v, t.expectOptions, t.toOptions, t.why,
  ].map(csvCell).join(','))),
  '',
].join('\n'), (s) => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = ['# 의미적 중복 정답 수리 — 배치 1 (2026-08-21)', '',
  `- 생성: ${stampIso}`, `- 대상 DB: \`${DB_PATH}\``, `- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`,
  `- 변경 ${todo.length}건 · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건 · 인계 ${DEFERRED.length}건`,
  '', '**정답 칸(answer 값·정답 보기 텍스트)은 한 건도 바뀌지 않았습니다** — `options` 의 "정답과 값이 같은 오답 칸" 만 교체했습니다.', '',
  '## 1. 교체 내역', '',
  '| qid | content | 문항 | 정답 idx | 정답 보기 | 교체 idx | before | after |', '|---|---|---|---|---|---|---|---|'];
for (const t of todo) {
  for (const [i, v] of t.swaps) {
    md.push(`| ${t.id} | ${t.content_id} | ${String(t.question_text).replace(/\|/g, '\\|').slice(0, 38)} | ${t.answer} | \`${t.options[Number(t.answer)]}\` | ${i} | \`${t.options[i]}\` | \`${v}\` |`);
  }
}
md.push('', '## 2. 교체 근거(문항군별)', '', '| qid | 근거 |', '|---|---|');
for (const s of SPECS) md.push(`| ${s.ids.join(', ')} | ${s.why} |`);
md.push('', '## 3. 배치 2 인계 — 손대지 않음', '',
  '해설이 "①은 …, ②는 …" 로 오답 보기의 이유를 열거하는 문항들입니다. 약분 전 형태를 작성자가',
  '**의도한 오답 보기**로 명시했을 수 있고, 보기를 바꾸면 해설의 번호 참조가 어긋납니다.',
  '전체 해설을 읽고 문항별로 판단한 뒤 처리해야 합니다.', '',
  '```', DEFERRED.join(', '), '```', '',
  `- 롤백: \`${path.relative(ROOT, rollbackPath)}\``, `- 변경 목록: \`${path.relative(ROOT, changesPath)}\``, '');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));
console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) {
    for (const [i, v] of t.swaps) {
      console.log(`  q${t.id}(c${t.content_id}) 정답idx=${t.answer}("${t.options[Number(t.answer)]}") · 교체idx=${i}: "${t.options[i]}" → "${v}"`);
    }
  }
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
// options 한 컬럼만 쓴다. answer 는 WHERE 절 확인용으로만 쓰고 갱신하지 않는다.
const applyAll = db.transaction((items) => {
  const stmt = db.prepare('UPDATE content_questions SET options = ? WHERE id = ? AND options = ? AND answer = ?');
  for (const t of items) {
    const info = stmt.run(t.toOptions, t.id, t.expectOptions, t.answer);
    if (info.changes !== 1) throw new Error(`q${t.id}: UPDATE 가 ${info.changes}행에 적용됨(1이어야 함) — expect 불일치. 전체 롤백합니다.`);
  }
});
try { applyAll(todo); }
catch (e) { console.error(`\n🔴 적용 중단 — 전체 롤백됨: ${e.message}`); db.close(); process.exit(3); }

// 사후 검증
const bad = [];
for (const t of todo) {
  const r = db.prepare('SELECT options, answer, explanation FROM content_questions WHERE id = ?').get(t.id);
  const n = Number(t.answer);
  if (String(r.answer) !== t.answer) bad.push(`q${t.id}: answer 가 바뀌었다 (${r.answer}) — 절대 일어나선 안 되는 일`);
  const O = JSON.parse(r.options);
  if (String(O[n]).trim() !== String(t.options[n]).trim()) bad.push(`q${t.id}: 정답 보기 텍스트가 바뀌었다 (${O[n]})`);
  const norm = O.map((s) => String(s).trim());
  if (new Set(norm).size !== norm.length) bad.push(`q${t.id}: 적용 후에도 글자 중복이 있다 → ${r.options}`);
  const av = parseNumericish(O[n]);
  O.forEach((o, i) => { if (i !== n && numEq(parseNumericish(o), av) && !isLegitFormTwin(O[n], o)) bad.push(`q${t.id}: 적용 후에도 보기[${i}]"${o}" 가 정답과 값이 같다`); });
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건(정답 칸 무변동). 롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
