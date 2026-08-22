#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 의미적 중복 정답 수리 — 배치 3 (2026-08-21)
 * 배치 1(fix-equivalent-options-20260821.js)·배치 2(-b2.js)의 **규약과 가드를 그대로 승계**한다.
 * 앞 배치들은 이미 정본에 적용돼 계획·롤백·증적이 동결됐으므로 새 배치는 별도 파일로 둔다
 * (적용 완료된 배치의 rollback.sql 을 재생성으로 축소시키지 않기 위해서다 — 2026-08-07 소실 사고).
 * ─────────────────────────────────────────────────────────────────────────────
 * ■ 무엇을 처리하나
 *   (가) 탐지기 공백에 가려져 있던 6건
 *        INV-AI6 의 단위 목록(SEMANTIC_UNITS)이 **고정 배열**이라 `L`·`장` 이 빠져 있었고,
 *        그 단위를 쓰는 문항 6건이 몇 달간 탐지를 빠져나갔다. 이번에 파서를 일반화하면서
 *        드러났고, **같은 작업 안에서** 처리한다(붉은 상태로 머무는 구간을 만들지 않는다).
 *
 *   (나) q12417 — 정답키 이동 🔴 **이 배치에서만 허용된 예외**
 *        지문 "…이 순환소수를 **기약분수**로 나타내면?" · 해설 "…x=27/99=3/11. 기약분수는 3/11이다."
 *        인데 answer 가 약분 전 `27/99` 를 가리켰다. **지문과 해설이 모두 요구하는 `3/11` 을 고른
 *        학생이 오답 처리**된다. 보기 교체로는 풀 수 없다(정답 칸 자체가 틀렸다).
 *
 * ■ 원칙
 *   A. 정답 칸(answer)은 원칙적으로 **불변**이다. 정답이 이동하면 **기존 제출 기록의 정오답이
 *      뒤집힌다**. SWAP 건은 `options` 한 컬럼만 쓰고 answer 는 WHERE 절 확인용으로만 쓴다.
 *   B. 🔴 **ANSWER 건(정답 이동)은 제출 기록이 0 건일 때만 허용한다.**
 *      뒤집힐 기록이 하나도 없으면 위 위험이 성립하지 않는다. 이 확인은 사람의 기억이 아니라
 *      **스크립트 가드**로 강제한다(아래 countSubmissions). 0 이 아니면 한 행도 쓰지 않고 멈춘다.
 *      → 다음 사람이 "저번에도 옮겼으니까" 로 답습하는 것을 막는 것이 이 가드의 목적이다.
 *   C. 판단이 안 서면 건드리지 않는다.
 *
 * ■ 왜 6건 전부 SWAP 인가 (배치 2 의 FORMAT 을 쓰지 않은 이유)
 *   배치 2 는 "해설이 그 쌍둥이 칸을 오답으로 지목한다" 가 확인된 건에만 지문 형식 요구를 붙였다.
 *   이번 6건은 그 조건을 만족하지 않는다:
 *     · q3391/q4903 — 정답이 `1 L`(자연수)이라 "대분수로"·"기약분수로" 어느 쪽도 정답을 살리지
 *       못한다(형식 가드가 실제로 막는다). 배치 1 의 q2382(`6/6`=1) 와 같은 형태 → 보기 교체.
 *     · q3855/q5311 — **형제 문항 q3853 의 정답이 `8/5`(가분수 그대로)** 다. 이 콘텐츠는 가분수를
 *       오답 형식으로 취급하지 않으므로 "대분수로" 요구는 형제 증거와 모순된다. 같은 콘텐츠의
 *       q3854 도 배치 1 에서 보기 교체로 처리됐다 → 같은 방식으로 맞춘다.
 *     · q10511/q12242 — 해설이 쌍둥이를 오답으로 **지목하지 않는다**(중간값으로 쓸 뿐이고,
 *       오답 이유 열거도 없다). 단일 문항 콘텐츠라 형제 증거도 없다.
 *   → 학습 목표에 대해 **아무 주장도 하지 않는** 보기 교체가 이 6건에서는 더 안전하다.
 *
 * ■ 가드
 *   [SWAP]   배치 1·2 와 동일 — 교체 칸 ≠ 정답 칸 · 교체 대상이 실제로 정답과 값이 같은 칸 ·
 *            교체 후 **글자 전부 상이 + 수치 전부 상이** · 새 값이 해설에 등장하지 않음
 *   [ANSWER] · 🔴 제출 기록 0 건 (content_attempts · problem_attempts · diagnosis_answers ·
 *              wrong_answers · answers JSON 안의 questionId 까지)
 *            · 새 정답 index 가 범위 안 · 새 정답 보기 텍스트가 계획과 일치
 *            · 지문의 형식 요구를 새 정답이 **만족**하고 옛 정답은 **위반**한다
 *              (= 정답키가 틀렸었다는 것을 기계가 재확인한다)
 *            · 해설이 새 정답을 지목한다
 *            · 해설의 보기 번호 참조가 실제 보기와 맞는다(어긋나면 번호만 바로잡는다)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용법
 *   node scripts/fix-equivalent-options-20260821-b3.js              # DRY-RUN
 *   node scripts/fix-equivalent-options-20260821-b3.js --apply
 *   node scripts/fix-equivalent-options-20260821-b3.js --db <사본> --apply
 *   node scripts/fix-equivalent-options-20260821-b3.js --selftest   # 계획 검증(DB 무접촉)
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
  ? path.join('보고서', '증적', '의미적중복_배치3_20260821')
  : path.join(path.dirname(DB_PATH), '증적_의미적중복b3_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 계획: SWAP ──────────────────────────────────────────────────────────────
// S(ids, answer, options, [[교체칸, 새값], ...], why)
const SWAPS = [];
const S = (ids, answer, options, swaps, why) => SWAPS.push({ ids, answer, options, swaps, why });

S([3391, 4903], '1', ['8/8 L', '1 L', '1과 1/8 L', '8/16 L'],
  [[0, '2/8 L']],
  '보기[0]"8/8 L" 는 정답 "1 L" 와 값이 같다. 정답이 자연수라 형식 요구(대분수·기약분수)로는 '
  + '풀 수 없어 보기를 교체한다 — 배치 1 의 q2382("6/6" = 정답 1)와 같은 형태다. '
  + '새 값 2/8 L 는 더하기를 빼기로 착각한 오답(5-3=2)으로, 배치 1 이 q2382·q216 에 쓴 어휘와 같다.');

S([3855, 5311], '0', ['3과 1/3 L', '10/3 L', '2과 2/3 L', '3과 2/3 L'],
  [[1, '10/15 L']],
  '보기[1]"10/3 L" 는 정답 "3과 1/3 L" 와 값이 같다. 형제 문항 **q3853 의 정답이 "8/5"(가분수 그대로)** '
  + '라 이 콘텐츠는 가분수를 오답 형식으로 보지 않는다 — "대분수로" 요구는 형제 증거와 모순되므로 쓰지 않는다. '
  + '같은 콘텐츠의 q3854 도 배치 1 에서 보기 교체로 처리됐다. 새 값 10/15 L 는 분자·분모 모두에 5를 곱한 오류로, '
  + '형제 q3853 의 오답 보기 "8/20"(2/5×4 를 분자·분모 모두 곱함) 및 q3852 가 열거한 오개념과 같은 계열이다.');

S([10511], '3', ['3/10 장', '3/15 장', '5/10 장', '1/2 장'],
  [[2, '5/15 장']],
  '보기[2]"5/10 장" 는 정답 "1/2 장" 의 약분 전 형태다. 해설이 "…=5/10=1/2 장입니다" 로 중간값으로 쓸 뿐 '
  + '오답으로 **지목하지 않고**, 단일 문항 콘텐츠라 형제 증거도 없어 형식 요구의 근거가 약하다 → 보기 교체. '
  + '새 값 5/15 장 은 분자는 통분해 더했으나(4+1=5) 분모는 두 분모를 더한(5+10=15) 오류로, '
  + '기존 보기 "3/15 장"(분자·분모 각각 더함)과 같은 분모합 계열이다.');

S([12242], '3', ['5/30 L', '5/5 L', '1/5 L', '1/6 L'],
  [[0, '25/6 L']],
  '보기[0]"5/30 L" 는 정답 "1/6 L" 의 약분 전 형태다. 해설이 "…=5/30=1/6이다" 로 중간값으로 쓸 뿐 '
  + '오답으로 지목하지 않고 형제 증거도 없어 형식 요구의 근거가 약하다 → 보기 교체. '
  + '새 값 25/6 L 는 역수를 취하지 않고 그대로 곱한 오류(5/6 × 5)로, 이 차시 계열(c7092~c7127)의 해설이 '
  + '"역수 없이 곱한 오류" 로 반복해 열거하는 대표 오개념이다.');

// ── 계획: ANSWER (정답 이동) — 🔴 제출 기록 0 건일 때만 ──────────────────────
// A(id, fromAnswer, toAnswer, options, questionText, fromExplanation, toExplanation, why)
const ANSWERS = [{
  id: 12417,
  from: '2', to: '1',
  options: ['27/100', '3/11', '27/99', '27/90'],
  questionText: '지환이는 0.272727…을 분수로 나타내려 한다. x=0.2727…로 놓을 때, 100x-x=27이다. 이 순환소수를 기약분수로 나타내면?',
  // 해설의 보기 번호가 어긋나 있다 — "보기①" 은 실제로는 보기[0]"27/100"(=0.27) 이라
  // "3/11과 같지만 약분 전" 이라는 서술과 맞지 않는다. 약분 전 형태는 보기[2]"27/99" = ③번이다.
  // 🔴 **번호만** 바로잡는다. 나머지 문장은 한 글자도 건드리지 않는다.
  fromExplanation: '99x=27 → x=27/99=3/11. 기약분수는 3/11이다. (보기①은 3/11과 같지만 약분 전)',
  toExplanation: '99x=27 → x=27/99=3/11. 기약분수는 3/11이다. (보기③은 3/11과 같지만 약분 전)',
  requiredFormat: 'irreducible',           // 지문이 "기약분수로" 를 요구한다
  why: '지문("…기약분수로 나타내면?")과 해설("기약분수는 3/11이다")이 **모두 3/11 을 요구**하는데 '
     + 'answer 가 약분 전 27/99(index 2)를 가리켰다. 옳게 푼 학생이 오답 처리된다. '
     + '보기 교체로는 풀 수 없다 — 정답 칸 자체가 틀렸기 때문이다. '
     + 'content 10593 의 제출 기록이 **0 건**임을 확인해(뒤집힐 정오답이 없다) 정답을 index 1 로 옮긴다. '
     + '해설의 보기 번호(① → ③)도 실제 보기에 맞춰 바로잡는다.',
}];

// ── 판정 불가로 **일부러 제외** — INV-AI6 백로그에 사유와 함께 남는다 ─────────
const HOLD = [{
  id: 8954, content_id: 7130,
  why: '보기 ["22/3"(정답), "33/32", "11/12", "7와 1/3", "5와 1/2"] answer=0. '
     + '쌍둥이 "7와 1/3" 은 정답 22/3 의 **대분수 표기**이고 둘 다 기약이라 기약분수 요구로는 구별되지 않는다. '
     + '"가분수로" 요구는 초등 6학년 나눗셈 차시의 통상 요구와 반대라 학습 목표를 바꾼다. '
     + '보기를 교체하려 해도 이 문항은 해설의 ③④⑤ 번호가 **현재 정확히 맞아** 있어 교체하면 참조가 어긋난다. '
     + '결정적으로 해설이 자기모순이다 — 본문은 "88/12 = 22/3 = 7과 1/3이다" 로 두 표기를 **동치로 승인**하면서 '
     + '"④는 약분 오류" 로 같은 칸을 오답 취급한다. '
     + '🔑 선행 조건: **해설 재작성**(어느 표기를 최종 답으로 볼지 작성자 의도를 확정)이 먼저다. '
     + '그 뒤에야 지문 형식 요구든 보기 교체든 근거가 생긴다.',
}];

// SWAPS·ANSWERS → 문항 단위 계획
const PLAN = [];
for (const s of SWAPS) for (const id of s.ids) {
  PLAN.push({ kind: 'SWAP', id, answer: s.answer, options: s.options, swaps: s.swaps, why: s.why });
}
for (const a of ANSWERS) PLAN.push({ kind: 'ANSWER', ...a });

// ── 값 파서 ─────────────────────────────────────────────────────────────────
/**
 * 배치 1·2 가 쓰던 **느슨한** 파서(접두 일치). SWAP 의 수치 가드에 그대로 승계한다.
 * 🔴 글자만 비교하면 q214 부류를 또 만든다 — 배치 1 실측: 교체 후보 "2과 9/6"(=3.5)이
 *   정답 "3과 3/6"(=3.5)과 값이 같았다. 글자는 달라 중복 검사를 통과했을 것이다.
 */
function parseNumericish(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  if (t.includes(',')) return null;
  let m = t.match(/^([-+]?\d+)[과와](\d+)\/(\d+)/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^([-+]?\d+)\/(\d+)/); if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^([-+]?\d+(?:\.\d+)?)/); if (m) return Number(m[1]);
  return null;
}
const numEq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
const gcdOf = (a, b) => (b ? gcdOf(b, a % b) : a);
const strip = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
function asFracLoose(s) { const m = strip(s).match(/^([-+]?\d+)\/(\d+)$/); return m ? [Number(m[1]), Number(m[2])] : null; }
/** 보기가 지문의 형식 요구를 만족하는가(현재는 기약분수만 쓴다 — 단위 접미는 없다고 본다). */
function satisfiesFormat(kind, text) {
  if (kind !== 'irreducible') throw new Error(`알 수 없는 형식 종류: ${kind}`);
  const f = asFracLoose(text);
  return !!f && gcdOf(Math.abs(f[0]), f[1]) === 1;
}
const afterSwap = (p) => { const a = p.options.slice(); for (const [i, v] of p.swaps) a[i] = v; return a; };

// ── 계획 자체 검증 (DB 무접촉) ──────────────────────────────────────────────
function selftestPlan() {
  const problems = [];
  const seen = new Set();
  for (const p of PLAN) {
    const tag = `q${p.id}`;
    if (seen.has(p.id)) problems.push(`${tag}: 중복 항목`);
    seen.add(p.id);
    if (!p.why) problems.push(`${tag}: 근거(why)가 없다`);

    if (p.kind === 'ANSWER') {
      const from = Number(p.from), to = Number(p.to);
      if (!Number.isInteger(from) || !Number.isInteger(to)) { problems.push(`${tag}: from/to 가 정수가 아니다`); continue; }
      if (from === to) problems.push(`${tag}: 정답이 이동하지 않는다`);
      if (!(to >= 0 && to < p.options.length)) problems.push(`${tag}: 새 정답 index ${to} 범위 밖`);
      if (!(from >= 0 && from < p.options.length)) problems.push(`${tag}: 옛 정답 index ${from} 범위 밖`);
      // 정답키가 틀렸었다는 것을 형식으로 재확인한다 — 새 정답은 형식을 만족, 옛 정답은 위반
      if (!satisfiesFormat(p.requiredFormat, p.options[to])) {
        problems.push(`${tag}: 새 정답 "${p.options[to]}" 가 지문의 형식 요구(${p.requiredFormat})를 만족하지 않는다`);
      }
      if (satisfiesFormat(p.requiredFormat, p.options[from])) {
        problems.push(`${tag}: 옛 정답 "${p.options[from]}" 가 형식 요구를 이미 만족한다 — 정답키가 틀렸다는 근거가 없다`);
      }
      // 두 보기가 실제로 같은 값이어야 한다(그래서 학생이 옳게 풀고도 틀렸다)
      if (!numEq(parseNumericish(p.options[to]), parseNumericish(p.options[from]))) {
        problems.push(`${tag}: 새 정답과 옛 정답의 값이 다르다 — 이 스크립트의 대상이 아니다`);
      }
      // 해설은 **번호만** 바뀌어야 한다: 숫자·기호를 뺀 나머지가 동일해야 한다
      const numless = (s) => strip(s).replace(/[①②③④⑤]/g, '#');
      if (numless(p.fromExplanation) !== numless(p.toExplanation)) {
        problems.push(`${tag}: 해설이 보기 번호(①②③④⑤) 외의 부분까지 바뀐다 — 번호만 바로잡는다`);
      }
      if (p.fromExplanation === p.toExplanation) problems.push(`${tag}: 해설이 바뀌지 않는다`);
      if (!p.questionText.includes('기약분수')) problems.push(`${tag}: 지문에 형식 요구가 없다 — 정답 이동 근거가 약하다`);
      continue;
    }

    // SWAP — 배치 1·2 와 동일한 가드
    const n = Number(p.answer);
    if (!Number.isInteger(n) || n < 0 || n >= p.options.length) {
      problems.push(`${tag}: answer=${p.answer} 가 범위 밖 (보기수 ${p.options.length})`); continue;
    }
    if (!p.swaps.length) problems.push(`${tag}: 교체 항목이 없다`);
    const av = parseNumericish(p.options[n]);
    for (const [i, v] of p.swaps) {
      if (i === n) problems.push(`${tag}: 교체 대상이 **정답 칸**(index ${n})이다 — 정답은 건드리지 않는다`);
      if (!(i >= 0 && i < p.options.length)) problems.push(`${tag}: 교체 index ${i} 범위 밖`);
      if (!numEq(av, parseNumericish(p.options[i]))) {
        problems.push(`${tag}: 보기[${i}]"${p.options[i]}" 는 정답 "${p.options[n]}" 와 값이 다르다 — 교체 대상이 아니다`);
      }
      if (p.options.some((o) => String(o).trim() === String(v).trim())) {
        problems.push(`${tag}: 새 값 "${v}" 가 기존 보기에 이미 있다`);
      }
    }
    const A = afterSwap(p);
    if (A.length !== p.options.length) problems.push(`${tag}: 보기 개수가 달라진다`);
    if (String(A[n]).trim() !== String(p.options[n]).trim()) problems.push(`${tag}: 정답 보기 텍스트가 바뀐다 — 금지`);
    const norm = A.map((s) => String(s).trim());
    if (new Set(norm).size !== norm.length) problems.push(`${tag}: 교체 후 글자가 같은 보기가 남는다 → ${JSON.stringify(A)}`);
    A.forEach((o, i) => {
      if (i === n) return;
      if (numEq(parseNumericish(o), av)) problems.push(`${tag}: 교체 후에도 보기[${i}]"${o}" 가 정답과 **값이 같다**(${av})`);
    });
  }
  for (const h of HOLD) if (seen.has(h.id)) problems.push(`q${h.id}: 보류 목록의 문항이 변경 계획에 들어 있다`);
  for (const h of HOLD) if (!h.why) problems.push(`q${h.id}: 보류 사유가 없다`);
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  const nS = PLAN.filter((p) => p.kind === 'SWAP').length;
  const nA = PLAN.filter((p) => p.kind === 'ANSWER').length;
  console.log(problems.length
    ? `[selftest] FAIL (${problems.length})\n - ${problems.join('\n - ')}`
    : `[selftest] PASS — SWAP ${nS}건 · ANSWER ${nA}건 · 보류 ${HOLD.length}건`);
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
  const e = strip(explanation).toLowerCase();
  const t = strip(text).toLowerCase();
  return t.length >= 2 && e.includes(t);
}

/**
 * 🔴 정답 이동의 전제 — 이 문항/콘텐츠에 걸린 **제출 기록 수**.
 *
 * 정답 index 를 옮기면 과거 제출의 정오답이 **소급해서 뒤집힌다**. 기록이 하나도 없을 때만
 * 그 위험이 성립하지 않는다. 그래서 "이번엔 괜찮겠지" 가 아니라 매 실행마다 기계가 센다.
 * 테이블이 늘어나면 여기에 추가할 것 — 빠뜨리면 가드가 조용히 약해진다.
 */
function countSubmissions(handle, contentId, questionId) {
  const rows = [];
  const one = (label, sql, ...args) => {
    try { rows.push({ label, n: handle.prepare(sql).get(...args).n }); }
    catch (e) { rows.push({ label, n: -1, err: e.message }); }     // 테이블이 없으면 -1 → 가드가 막는다
  };
  one('content_attempts', 'SELECT COUNT(*) n FROM content_attempts WHERE content_id = ?', contentId);
  one('problem_attempts', 'SELECT COUNT(*) n FROM problem_attempts WHERE content_id = ?', contentId);
  one('diagnosis_answers', 'SELECT COUNT(*) n FROM diagnosis_answers WHERE content_id = ?', contentId);
  one('wrong_answers', 'SELECT COUNT(*) n FROM wrong_answers WHERE content_id = ?', contentId);
  // answers 는 JSON 이라 questionId 가 본문에 박혀 있다 — 콘텐츠 경로를 우회한 기록까지 센다.
  one('content_attempts.answers', "SELECT COUNT(*) n FROM content_attempts WHERE answers LIKE '%' || ? || '%'", String(questionId));
  one('problem_set_attempts.answers', "SELECT COUNT(*) n FROM problem_set_attempts WHERE answers LIKE '%' || ? || '%'", String(questionId));
  return rows;
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

  if (p.kind === 'ANSWER') {
    if (String(r.answer) === p.to && String(r.explanation) === p.toExplanation && String(r.options) === expectOptions) {
      already.push(p.id); continue;
    }
    if (String(r.answer) !== p.from) {
      blockers.push(`q${p.id}: answer 가 계획과 다르다 (기대 '${p.from}' / 현재 '${r.answer}')`); continue;
    }
    if (String(r.options) !== expectOptions) {
      blockers.push(`q${p.id}: 보기가 계획과 다르다 — ANSWER 건은 보기를 바꾸지 않는데도 어긋났다\n      기대: ${expectOptions}\n      현재: ${r.options}`); continue;
    }
    if (String(r.question_text) !== p.questionText) {
      blockers.push(`q${p.id}: 지문이 계획과 다르다\n      기대: ${JSON.stringify(p.questionText)}\n      현재: ${JSON.stringify(r.question_text)}`); continue;
    }
    if (String(r.explanation) !== p.fromExplanation) {
      blockers.push(`q${p.id}: 해설이 계획과 다르다\n      기대: ${JSON.stringify(p.fromExplanation)}\n      현재: ${JSON.stringify(r.explanation)}`); continue;
    }
    // 해설이 새 정답을 지목하는가 (정답 이동 방향이 옳다는 독립 근거)
    if (!namedByExplanation(p.options[Number(p.to)], r.explanation)) {
      blockers.push(`q${p.id}: 해설이 새 정답 "${p.options[Number(p.to)]}" 를 언급하지 않는다 — 이동 근거가 없다`); continue;
    }
    // 🔴 제출 기록 0 건 — 하나라도 있으면 멈춘다
    const subs = countSubmissions(db, r.content_id, p.id);
    const nonZero = subs.filter((s) => s.n !== 0);
    if (nonZero.length) {
      blockers.push(
        `q${p.id}: 🔴 제출 기록이 있습니다 — 정답을 옮기면 과거 제출의 정오답이 뒤집힙니다. 보류하십시오.\n` +
        nonZero.map((s) => `        ${s.label} = ${s.n}${s.err ? ` (${s.err})` : ''}`).join('\n')
      );
      continue;
    }
    todo.push({ ...p, content_id: r.content_id, expectOptions, subs });
    continue;
  }

  // SWAP
  const toOptions = JSON.stringify(afterSwap(p));
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
  todo.push({ ...p, content_id: r.content_id, question_text: r.question_text, expectOptions, toOptions, explanation: r.explanation });
}

const nSwap = todo.filter((t) => t.kind === 'SWAP').length;
const nAns = todo.filter((t) => t.kind === 'ANSWER').length;
console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건 → 변경 ${todo.length}(보기 ${nSwap} · 정답이동 ${nAns}) · 이미 반영 ${already.length} · 차단 ${blockers.length}`);
console.log(`보류(손대지 않음): ${HOLD.map((h) => 'q' + h.id).join(', ') || '없음'}`);
for (const t of todo.filter((x) => x.kind === 'ANSWER')) {
  console.log(`제출 기록 확인 q${t.id}(c${t.content_id}): ${t.subs.map((s) => `${s.label}=${s.n}`).join(' · ')}  → 전부 0, 뒤집힐 기록 없음`);
}

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
  '-- 의미적 중복 정답 수리(2026-08-21 배치3) 롤백',
  '--   SWAP 건은 options 만, ANSWER 건은 answer + explanation 을 되돌린다',
  `-- 생성: ${stampIso}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${todo.length}건 (보기 ${nSwap} · 정답이동 ${nAns})`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...todo.map((t) => (t.kind === 'ANSWER'
    ? `UPDATE content_questions SET answer='${sq(t.from)}', explanation='${sq(t.fromExplanation)}' WHERE id=${t.id};`
    : `UPDATE content_questions SET options='${sq(t.expectOptions)}' WHERE id=${t.id};`)),
  'COMMIT;',
  '',
].join('\n'), (s) => (s.match(/WHERE id=/g) || []).length);

const changesPath = path.join(OUT_DIR, 'changes.csv');
writePreserving(changesPath, [
  ['qid', 'content_id', 'kind', 'answer_index', 'answer_text', 'before', 'after', 'why'].map(csvCell).join(','),
  ...todo.map((t) => (t.kind === 'ANSWER'
    ? [t.id, t.content_id, 'ANSWER', `${t.from} → ${t.to}`, `"${t.options[Number(t.from)]}" → "${t.options[Number(t.to)]}"`,
       t.fromExplanation, t.toExplanation, t.why]
    : [t.id, t.content_id, 'SWAP', t.answer, t.options[Number(t.answer)], t.expectOptions, t.toOptions, t.why]
  ).map(csvCell).join(',')),
  '',
].join('\n'), (s) => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = ['# 의미적 중복 정답 수리 — 배치 3 (2026-08-21)', '',
  `- 생성: ${stampIso}`, `- 대상 DB: \`${DB_PATH}\``, `- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`,
  `- 변경 ${todo.length}건(보기 ${nSwap} · 정답이동 ${nAns}) · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건 · 보류 ${HOLD.length}건`,
  '',
  'SWAP 건은 `options` 의 쌍둥이 칸 하나만 교체했고 **정답 칸은 무변동**입니다.',
  'ANSWER 건(q12417)은 **정답키 자체가 틀려** 있어 예외적으로 정답을 옮겼습니다 —',
  '해당 콘텐츠의 제출 기록이 0 건임을 스크립트 가드로 확인한 뒤에만 허용됩니다.', '',
  '## 1. 보기 교체 (SWAP)', '',
  '| qid | content | 정답 idx | 정답 보기 | 교체 idx | before | after |', '|---|---|---|---|---|---|---|'];
for (const t of todo.filter((x) => x.kind === 'SWAP')) {
  for (const [i, v] of t.swaps) {
    md.push(`| ${t.id} | ${t.content_id} | ${t.answer} | \`${t.options[Number(t.answer)]}\` | ${i} | \`${t.options[i]}\` | \`${v}\` |`);
  }
}
md.push('', '## 2. 정답키 이동 (ANSWER) — 제출 기록 0 건 확인 후', '',
  '| qid | content | answer | 정답 보기 | 제출 기록 |', '|---|---|---|---|---|');
for (const t of todo.filter((x) => x.kind === 'ANSWER')) {
  md.push(`| ${t.id} | ${t.content_id} | \`${t.from}\` → \`${t.to}\` | \`${t.options[Number(t.from)]}\` → \`${t.options[Number(t.to)]}\` | ${t.subs.map((s) => `${s.label}=${s.n}`).join(' · ')} |`);
  md.push(`| | | 해설 before | \`${t.fromExplanation}\` | |`);
  md.push(`| | | 해설 after | \`${t.toExplanation}\` | |`);
}
md.push('', '## 3. 근거(문항군별)', '', '| qid | 종류 | 근거 |', '|---|---|---|');
for (const s of SWAPS) md.push(`| ${s.ids.join(', ')} | 보기 교체 | ${s.why} |`);
for (const a of ANSWERS) md.push(`| ${a.id} | 정답 이동 | ${a.why} |`);
md.push('', '## 4. 보류 — 손대지 않음', '', '| qid | content | 사유 |', '|---|---|---|');
for (const h of HOLD) md.push(`| ${h.id} | ${h.content_id} | ${h.why} |`);
md.push('', `- 롤백: \`${path.relative(ROOT, rollbackPath)}\``, `- 변경 목록: \`${path.relative(ROOT, changesPath)}\``, '');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));
console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) {
    if (t.kind === 'ANSWER') {
      console.log(`  q${t.id}(c${t.content_id}) [정답이동] answer ${t.from}("${t.options[Number(t.from)]}") → ${t.to}("${t.options[Number(t.to)]}")`);
      console.log(`      해설 before: ${t.fromExplanation}`);
      console.log(`      해설 after : ${t.toExplanation}`);
    } else {
      for (const [i, v] of t.swaps) {
        console.log(`  q${t.id}(c${t.content_id}) [보기] 정답idx=${t.answer}("${t.options[Number(t.answer)]}") · 교체idx=${i}: "${t.options[i]}" → "${v}"`);
      }
    }
  }
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
const applyAll = db.transaction((items) => {
  const swp = db.prepare('UPDATE content_questions SET options = ? WHERE id = ? AND options = ? AND answer = ?');
  const ans = db.prepare(
    'UPDATE content_questions SET answer = ?, explanation = ? WHERE id = ? AND answer = ? AND explanation = ? AND options = ?'
  );
  for (const t of items) {
    const info = t.kind === 'ANSWER'
      ? ans.run(t.to, t.toExplanation, t.id, t.from, t.fromExplanation, t.expectOptions)
      : swp.run(t.toOptions, t.id, t.expectOptions, t.answer);
    if (info.changes !== 1) throw new Error(`q${t.id}: UPDATE 가 ${info.changes}행에 적용됨(1이어야 함) — expect 불일치. 전체 롤백합니다.`);
  }
});
try { applyAll(todo); }
catch (e) { console.error(`\n🔴 적용 중단 — 전체 롤백됨: ${e.message}`); db.close(); process.exit(3); }

// ── 사후 검증 ───────────────────────────────────────────────────────────────
const bad = [];
for (const t of todo) {
  const r = db.prepare('SELECT question_text, options, answer, explanation FROM content_questions WHERE id = ?').get(t.id);
  const O = JSON.parse(r.options);
  if (O.length !== t.options.length) bad.push(`q${t.id}: 보기 개수가 달라졌다 (${O.length})`);
  const trimmed = O.map((s) => String(s).trim());
  if (new Set(trimmed).size !== trimmed.length) bad.push(`q${t.id}: 글자가 같은 보기가 있다 → ${r.options}`);

  if (t.kind === 'ANSWER') {
    if (String(r.answer) !== t.to) bad.push(`q${t.id}: answer 가 '${r.answer}' — 기대 '${t.to}'`);
    if (String(r.options) !== t.expectOptions) bad.push(`q${t.id}: 보기가 바뀌었다 — ANSWER 건은 보기를 건드리지 않는다`);
    if (String(r.explanation) !== t.toExplanation) bad.push(`q${t.id}: 해설이 기대와 다르다 → ${r.explanation}`);
    if (!satisfiesFormat(t.requiredFormat, O[Number(t.to)])) bad.push(`q${t.id}: 새 정답 "${O[Number(t.to)]}" 가 지문 형식 요구를 만족하지 않는다`);
    // 해설의 보기 번호가 실제 보기를 가리키는가 — "보기③" 이면 O[2] 가 약분 전 형태여야 한다
    const m = String(r.explanation).match(/보기([①②③④⑤])/);
    if (!m) bad.push(`q${t.id}: 해설의 보기 번호 참조를 찾지 못했다`);
    else {
      const idx = '①②③④⑤'.indexOf(m[1]);
      const f = asFracLoose(O[idx]);
      const okRef = !!f && gcdOf(Math.abs(f[0]), f[1]) !== 1
        && numEq(parseNumericish(O[idx]), parseNumericish(O[Number(t.to)]));
      if (!okRef) bad.push(`q${t.id}: 해설이 가리키는 보기[${idx}]="${O[idx]}" 가 "정답과 값이 같은 약분 전 형태" 가 아니다`);
    }
  } else {
    const n = Number(t.answer);
    if (String(r.answer) !== t.answer) bad.push(`q${t.id}: answer 가 바뀌었다 (${r.answer}) — 절대 일어나선 안 되는 일`);
    if (String(O[n]).trim() !== String(t.options[n]).trim()) bad.push(`q${t.id}: 정답 보기 텍스트가 바뀌었다 (${O[n]})`);
    const av = parseNumericish(O[n]);
    O.forEach((o, i) => {
      if (i !== n && numEq(parseNumericish(o), av)) bad.push(`q${t.id}: 적용 후에도 보기[${i}]"${o}" 가 정답과 값이 같다`);
    });
    for (const [, v] of t.swaps) {
      if (namedByExplanation(v, r.explanation)) bad.push(`q${t.id}: 새 값 "${v}" 가 해설에 등장한다`);
    }
  }
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건(보기 ${nSwap} · 정답이동 ${nAns}).`);
console.log(`   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
