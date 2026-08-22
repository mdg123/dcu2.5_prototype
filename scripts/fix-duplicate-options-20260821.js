#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 중복 보기 수리 — 정답과 글자가 같은 오답 보기 교체 (2026-08-21)
 * ─────────────────────────────────────────────────────────────────────────────
 * ■ 무엇이 문제였나
 *   보기 배열에 **정답 칸과 글자가 완전히 같은 다른 칸**이 있었다.
 *     예) q9152 "879 - 456" 보기 ["413","423","433","423"] answer=1
 *         → index 3 을 고른 학생은 정답과 **똑같은 글자**를 골랐는데 오답 처리된다.
 *   q214(보기에 1/2 과 2/4 가 함께 있던 문항)와 같은 계열이며, 학생 입장에서
 *   납득이 불가능한 채점이다.
 *
 * ■ 원칙 (이번 수리의 안전선)
 *   A. **정답 칸은 절대 건드리지 않는다.** answer 값도, 정답 보기의 텍스트도 그대로 둔다.
 *      정답이 이동하면 기존 제출 기록의 정오답이 뒤집힌다.
 *      → UPDATE 는 `options` 한 컬럼만 쓰고, 바꾸는 것은 **중복된 오답 칸 하나**뿐이다.
 *   B. 교체 값은 **그 문항의 오개념에 대응**하는 값으로 고른다(아래 why 참조).
 *      같은 지문의 형제 문항이 쓰는 오답 보기 어휘를 우선 참고한다.
 *   C. 판단이 안 서면 **건드리지 않는다**. 26건 중 1건(q11666)은 제외했다 — 아래 UNDECIDED.
 *
 * ■ 가드 (--selftest + DB 단계)
 *   · 교체 칸 index ≠ 정답 index                     (정답 보호)
 *   · 교체 후 보기 값이 **전부 상이**                  (중복 잔존 0)
 *   · 새 값이 기존 보기 어디에도 없음
 *   · 보기 개수 불변 · 정답 index 가 여전히 범위 안
 *   · **해설이 오답 보기를 지목하지 않는다**(DB 단계) — 새 오답 보기가 해설에 등장하면
 *     학생이 "해설이 이 보기를 정답이라 한다" 고 읽게 된다. 해설이 지목하는 보기는
 *     정답 칸뿐이거나(가장 흔함) 하나도 없어야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 정본 DB 쓰기 규약 — 앞선 두 스크립트와 동일
 *   DRY-RUN 기본 · 롤백 SQL 선기록(쓰기보존형) · expect 가드(**보기 전문** 대조) ·
 *   UPDATE 에도 expect 재확인 · 멱등(상대 연산 없음)
 *
 * 사용법
 *   node scripts/fix-duplicate-options-20260821.js              # DRY-RUN
 *   node scripts/fix-duplicate-options-20260821.js --apply
 *   node scripts/fix-duplicate-options-20260821.js --db <사본> --apply
 *   node scripts/fix-duplicate-options-20260821.js --selftest   # 계획 검증(DB 무접촉)
 *
 *   --apply 직후 반드시: npm test
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DQUOTE = String.fromCharCode(34);
// SQL 문자열 이스케이프. 정규식 리터럴(`/'/g`)을 쓰지 않는다 —
// test/harness-freshness.test.js REG-HF8 의 괄호 깊이 스캐너가 정규식 안의 따옴표를
// "문자열 시작" 으로 오판해 함수 안의 write 를 최상위 write 로 잘못 잡는다(2026-08-21 실측).
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
  ? path.join('보고서', '증적', '중복보기_20260821')
  : path.join(path.dirname(DB_PATH), '증적_중복보기_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 계획 ────────────────────────────────────────────────────────────────────
// { id, answer(불변, expect), options(현재 전문), dupIdx(교체할 오답 칸), to(새 값), why }
const P = (id, answer, options, dupIdx, to, why) => ({ id, answer, options, dupIdx, to, why });

const PLAN = [
  // ── 넓이 ────────────────────────────────────────────────────────────────
  P(2512, '1', ['17cm²', '18cm²', '9cm²', '18cm²', '19cm²'], 3, '36cm²',
    '세로만 두 번 곱함(6×6). 기존 보기 9cm²(가로+세로)와 같은 계열의 연산 착각'),
  P(2520, '0', ['16cm²', '17cm²', '8cm²', '16cm²', '15cm²'], 3, '14cm²',
    '근접 오답 — 이 문항의 기존 오답 보기 17·15 와 같은 ±근접 계열로 맞춤(둘레 2×(4+4)=16 은 정답과 겹쳐 못 씀)'),
  P(3331, '2', ['14cm²', '48cm²', '24cm²', '24cm²'], 3, '96cm²',
    '마름모 넓이에서 ÷2 대신 ×2. 기존 48cm²(÷2 누락)의 연장선'),
  P(4851, '2', ['14cm²', '48cm²', '24cm²', '24cm²'], 3, '96cm²',
    'q3331 과 동일 문항의 복제본 — 같은 교체값으로 어휘 일치'),
  P(3559, '0', ['81cm²', '144cm²', '81cm²', '225cm²'], 2, '9cm²',
    '넓이의 차를 한 변의 차로 계산((15-12)²=9). 초등에서 가장 흔한 오개념'),
  P(5071, '0', ['81cm²', '144cm²', '81cm²', '225cm²'], 2, '9cm²',
    'q3559 와 동일 문항의 복제본 — 같은 교체값'),

  // ── 대분수 ──────────────────────────────────────────────────────────────
  P(3370, '0', ['4과 1/6', '4과 1/6', '3과 7/6', '3과 1/6'], 1, '3과 7/12',
    '분모끼리 더함(3/6+4/6→7/12). 자연수는 2+1=3 그대로 둔 형태'),
  P(4882, '0', ['4과 1/6', '4과 1/6', '3과 7/6', '3과 1/6'], 1, '3과 7/12',
    'q3370 과 동일 문항의 복제본 — 같은 교체값'),
  // ⚠ 처음 후보였던 "2과 9/6" 은 폐기했다 — 2+9/6 = 3.5 로 **정답 3과 3/6 과 값이 같다**.
  //   q214(1/2 = 2/4)와 똑같은 "값이 같은 두 정답" 을 새로 만들 뻔했다. 값 동일성 가드가 잡았다.
  P(3381, '1', ['3과 5/6', '3과 3/6', '7과 5/6', '3과 3/6'], 3, '3과 4/6',
    '자연수만 빼고 분수는 큰 수의 것을 그대로 씀(5-2=3, 분수는 4/6). 값 3과 4/6 ≠ 정답 3과 3/6'),
  P(4893, '1', ['3과 5/6', '3과 3/6', '7과 5/6', '3과 3/6'], 3, '3과 4/6',
    'q3381 과 동일 문항의 복제본 — 같은 교체값'),
  P(3385, '2', ['3과 3/6', '3과 7/6', '2와 3/6', '2와 3/6'], 3, '1과 3/6',
    '받아내림을 두 번 해 자연수를 과도하게 줄임'),
  P(4897, '2', ['3과 3/6', '3과 7/6', '2와 3/6', '2와 3/6'], 3, '1과 3/6',
    'q3385 와 동일 문항의 복제본 — 같은 교체값'),
  P(3395, '2', ['3과 1/8 kg', '4과 1/8 kg', '4과 1/8 kg', '3과 9/8 kg'], 1, '3과 9/16 kg',
    '분모끼리 더함(3/8+6/8→9/16). 기존 3과 9/8 kg(가분수 그대로)과 짝이 되는 오개념'),
  P(4907, '2', ['3과 1/8 kg', '4과 1/8 kg', '4과 1/8 kg', '3과 9/8 kg'], 1, '3과 9/16 kg',
    'q3395 와 동일 문항의 복제본 — 같은 교체값'),

  // ── 세 자리 수 덧셈·뺄셈 ────────────────────────────────────────────────
  P(9152, '1', ['413', '423', '433', '423'], 3, '523',
    '백의 자리 계산 오류(8-4를 5로). 기존 413·433 은 십의 자리 ±1 이라 자리별 오류를 한 벌 더 채움'),
  P(9153, '0', ['375', '385', '365', '375'], 3, '475',
    '백의 자리 받아내림 누락(5-1=4 로 두고 빌림 반영 안 함)'),
  P(9154, '0', ['486', '496', '476', '486'], 3, '586',
    '백의 자리 받아내림 누락(7-2=5 로 두고 빌림 반영 안 함)'),
  P(9159, '0', ['689', '699', '679', '689'], 3, '789',
    '백의 자리에 없는 받아올림을 더함(4+2=6 을 7 로)'),

  // ── 중등 ────────────────────────────────────────────────────────────────
  P(10803, '1', ['105°', '180°', '210°', '180°'], 3, '360°',
    '사각형 내각의 합과 혼동. 기존 210°(문제 수치 그대로)·105°(210÷2)와 다른 결의 오개념'),
  P(11645, '3', ['1초', '2초', '3초', '2초'], 1, '4초',
    't²=4 에서 t=4 로 읽음(제곱근을 취하지 않음)'),
  P(11651, '3', ['6', '12', '18', '18'], 2, '36',
    '반지름 대신 지름(12)으로 3배(12×3=36). 기존 6(하나만)·12(둘만)와 다른 결의 오류'),
  P(11658, '3', ['0.08', '8', '0.8', '0.8'], 2, '80',
    '소수점을 반대 방향으로 이동(×0.1 대신 ×10). 기존 0.08(두 칸 이동)의 반대편'),
  P(11670, '2', ['30', '35', '35', '40'], 1, '12',
    '곱셈 대신 덧셈(7+5=12). 기존 30·40 은 근접 오답이라 연산 오개념을 한 벌 채움'),
  P(11675, '1', ['3, 8, 11, 14', '5, 8, 11, 14', '5, 8, 11, 14', '3, 6, 9, 12'], 2, '6, 7, 8, 9',
    '□×3+2 를 □+3+2 로 읽음. 기존 3,6,9,12(+2 누락)와 짝이 되는 오개념'),
  P(12294, '2', ['(x+2)²+(y-1)²=3', '(x-2)²+(y+1)²=9', '(x-2)²+(y+1)²=9', '(x+2)²+(y-1)²=9'], 1, '(x-2)²+(y+1)²=3',
    '중심 부호는 맞게 옮겼으나 반지름을 제곱하지 않음(r 대신 r 그대로)'),
];

// 판정 불가로 **일부러 제외** — INV-AI5 백로그에 사유와 함께 남는다.
const UNDECIDED = [{
  id: 11666, content_id: 9842, dupIdx: 0, answer: 2,
  why: '보기 ["0.6÷3, 0.8÷4, 0.9÷3"(중복), 정답 동일 문자열, "0.9÷3, 0.8÷4, 0.6÷3", "0.8÷4, 0.6÷3, 0.9÷3"] — '
     + '0.6÷3 과 0.8÷4 가 **둘 다 0.2 로 동점**이라 index 3("0.8÷4, 0.6÷3, 0.9÷3")도 오름차순으로 옳다. '
     + '중복 칸만 바꿔도 **정답이 두 개인 상태가 남는다**(q214 와 같은 의미적 중복). '
     + '해소하려면 나눗셈 수치를 바꿔 동점을 없애야 하는데, 그러면 정답 보기의 문구까지 바뀌어 '
     + '"정답 칸 불변" 원칙에 어긋난다 → 문항 전면 재작성 대상. 손대지 않음.',
}];

/**
 * 보기 텍스트를 **수치**로 읽는다(읽을 수 없으면 null).
 *
 * 🔴 왜 필요한가 — 글자만 비교하면 q214 부류를 또 만든다.
 *   이번 작업 중 실제로 q3381 의 교체 후보로 "2과 9/6" 을 골랐는데, 2+9/6 = 3.5 로
 *   **정답 "3과 3/6" 과 값이 같았다**. 글자는 다르니 중복 검사는 통과했을 것이고,
 *   결과적으로 "정답이 두 개인 문항" 을 새로 만들 뻔했다. 그래서 값까지 본다.
 *   지원 형태: 정수·소수("423","0.8"), 단위 접미("36cm²","180°","4초"),
 *              분수("3/4"), 대분수("3과 7/12","2와 3/6","3과 9/16 kg")
 *   목록형("5, 8, 11, 14")·수식("(x-2)²+…")은 판정하지 않는다(null).
 */
function parseNumericish(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  if (t.includes(',')) return null;                                // 목록형은 값 비교 대상 아님
  let m = t.match(/^(-?\d+)[과와](\d+)\/(\d+)/);                   // 대분수
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(-?\d+)\/(\d+)/);                                  // 분수
  if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(-?\d+(?:\.\d+)?)/);                               // 정수·소수 (뒤 단위 무시)
  if (m) return Number(m[1]);
  return null;                                                     // 수식 등
}
const numEq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

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
      problems.push(`${tag}: answer=${p.answer} 가 0-based 범위 밖 (보기수 ${p.options.length})`);
      continue;
    }
    // A. 정답 칸 보호 — 정답 index 를 바꾸지 않는다
    if (p.dupIdx === n) problems.push(`${tag}: 교체 대상이 **정답 칸**(index ${n})이다 — 정답은 건드리지 않는다`);
    if (!(p.dupIdx >= 0 && p.dupIdx < p.options.length)) problems.push(`${tag}: dupIdx=${p.dupIdx} 범위 밖`);

    // 교체 대상이 실제로 정답과 글자가 같은 칸인지
    if (String(p.options[p.dupIdx]).trim() !== String(p.options[n]).trim()) {
      problems.push(`${tag}: index ${p.dupIdx} 는 정답과 글자가 다르다 — 중복 칸이 아니다`);
    }
    // 새 값이 기존 보기에 이미 있으면 중복이 옮겨갈 뿐이다
    if (p.options.some((o) => String(o).trim() === String(p.to).trim())) {
      problems.push(`${tag}: 새 값 "${p.to}" 가 기존 보기에 이미 있다`);
    }

    const after = p.options.slice();
    after[p.dupIdx] = p.to;
    if (after.length !== p.options.length) problems.push(`${tag}: 보기 개수가 달라진다`);
    if (String(after[n]).trim() !== String(p.options[n]).trim()) {
      problems.push(`${tag}: 정답 보기 텍스트가 바뀐다 — 금지`);
    }
    // B. 교체 후 보기 **글자**가 전부 상이해야 한다
    const norm = after.map((s) => String(s).trim());
    if (new Set(norm).size !== norm.length) {
      problems.push(`${tag}: 교체 후에도 글자가 같은 보기가 남는다 → ${JSON.stringify(after)}`);
    }
    // C. 새 값이 기존 보기와 **수치로도** 달라야 한다.
    //    글자만 보면 "2과 9/6"(=3.5) 처럼 정답과 값이 같은 보기를 새로 만들 수 있다(실제 발생).
    const toNum = parseNumericish(p.to);
    p.options.forEach((o, i) => {
      if (numEq(toNum, parseNumericish(o))) {
        problems.push(
          `${tag}: 새 값 "${p.to}" 가 보기[${i}] "${o}" 와 **수치가 같다**(${toNum})` +
          (i === n ? ' — 정답과 같은 값이므로 정답이 두 개가 된다' : '')
        );
      }
    });
  }
  if (UNDECIDED.some((u) => seen.has(u.id))) problems.push('판정 불가 목록의 문항이 변경 계획에 들어 있다');
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  console.log(problems.length
    ? `[selftest] FAIL\n - ${problems.join('\n - ')}`
    : `[selftest] PASS — 계획 ${PLAN.length}건, 판정 불가 ${UNDECIDED.length}건`);
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

/** 해설이 지목하는 보기 index 목록(공백 제거·소문자, 2글자 이상만). */
function optionsNamedByExplanation(options, explanation) {
  const e = String(explanation == null ? '' : explanation).replace(/\s+/g, '').toLowerCase();
  if (!e) return [];
  return options
    .map((o, i) => {
      const t = String(o).replace(/\s+/g, '').toLowerCase();
      return (t.length >= 2 && e.includes(t)) ? i : -1;
    })
    .filter((i) => i >= 0);
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
  const after = p.options.slice();
  after[p.dupIdx] = p.to;
  const toOptions = JSON.stringify(after);

  if (String(r.options) === toOptions && String(r.answer) === p.answer) { already.push(p.id); continue; }
  if (String(r.answer) !== p.answer) {
    blockers.push(`q${p.id}: answer 가 계획과 다르다 (기대 '${p.answer}' / 현재 '${r.answer}')`);
    continue;
  }
  if (String(r.options) !== expectOptions) {
    blockers.push(`q${p.id}: 보기가 계획과 다르다 — 문항이 이미 바뀌었다\n      기대: ${expectOptions}\n      현재: ${r.options}`);
    continue;
  }
  // 해설이 **오답 보기**를 지목하면 안 된다 (교체 후 기준)
  const named = optionsNamedByExplanation(after, r.explanation);
  const wrongNamed = named.filter((i) => i !== Number(p.answer));
  if (wrongNamed.length) {
    blockers.push(
      `q${p.id}: 교체 후 해설이 오답 보기 [${wrongNamed}] 를 지목한다 — 학생이 그 보기를 정답으로 읽는다\n` +
      `      보기: ${toOptions}\n      해설: ${r.explanation}`
    );
    continue;
  }
  todo.push({ ...p, content_id: r.content_id, question_text: r.question_text,
    expectOptions, toOptions, explanation: r.explanation, named });
}

console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건 → 변경 ${todo.length} · 이미 반영 ${already.length} · 차단 ${blockers.length}`);
console.log(`판정 불가(손대지 않음): ${UNDECIDED.map((u) => 'q' + u.id).join(', ') || '없음'}`);

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
      console.warn(`[보존] ${path.basename(target)} 에 손으로 덧붙인 주석(> …)이 있어 덮어쓰지 않았습니다. 새 산출물: ${preview}`);
      return;
    }
  }
  fs.writeFileSync(target, content, 'utf8');
}

const stampIso = new Date().toISOString();
const rollbackPath = path.join(OUT_DIR, 'rollback.sql');
writePreserving(rollbackPath, [
  '-- 중복 보기 수리(2026-08-21) 롤백 — options 컬럼만 되돌린다(answer 는 애초에 안 바꿨다)',
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
  ['qid', 'content_id', 'question_text', 'answer_index', 'replaced_index', 'before_option', 'after_option',
   'before_options', 'after_options', 'why'].map(csvCell).join(','),
  ...todo.map((t) => [t.id, t.content_id, t.question_text, t.answer, t.dupIdx,
    t.options[t.dupIdx], t.to, t.expectOptions, t.toOptions, t.why].map(csvCell).join(',')),
  '',
].join('\n'), (s) => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = ['# 중복 보기 수리 — 정답과 글자가 같은 오답 보기 교체 (2026-08-21)', '',
  `- 생성: ${stampIso}`, `- 대상 DB: \`${DB_PATH}\``, `- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`,
  `- 변경 ${todo.length}건 · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건 · 판정 불가 ${UNDECIDED.length}건`,
  // ⚠ 이 생성기는 blockquote(`>`) 줄을 **만들지 않는다** — writePreservingAnnotations 가
  //   `>` 를 "사람이 손으로 덧붙인 주석" 으로 보고 파일을 지켜 버리기 때문이다(실측).
  '', '**정답 칸(answer 값·정답 보기 텍스트)은 한 건도 바뀌지 않았습니다** — `options` 의 중복 오답 칸 하나만 교체했습니다.', '',
  '## 1. 교체 내역', '',
  '| qid | content | 문항 | 정답 idx | 교체 idx | before | after | 근거 |', '|---|---|---|---|---|---|---|---|'];
for (const t of todo) {
  md.push(`| ${t.id} | ${t.content_id} | ${String(t.question_text).replace(/\|/g, '\\|').slice(0, 40)} | ${t.answer} | ${t.dupIdx} | \`${t.options[t.dupIdx]}\` | \`${t.to}\` | ${t.why} |`);
}
md.push('', '## 2. 판정 불가 — 손대지 않음', '', '| qid | content | 이유 |', '|---|---|---|');
for (const u of UNDECIDED) md.push(`| ${u.id} | ${u.content_id} | ${u.why} |`);
md.push('', `- 롤백: \`${path.relative(ROOT, rollbackPath)}\``, `- 변경 목록: \`${path.relative(ROOT, changesPath)}\``, '');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));
console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) {
    console.log(`  q${t.id}(c${t.content_id}) 정답idx=${t.answer} · 교체idx=${t.dupIdx}: "${t.options[t.dupIdx]}" → "${t.to}"`);
  }
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
// options 한 컬럼만 쓴다. answer 는 WHERE 절의 확인용으로만 쓰고 갱신하지 않는다.
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
  if (String(r.answer) !== t.answer) bad.push(`q${t.id}: answer 가 바뀌었다 (${r.answer}) — 절대 일어나선 안 되는 일`);
  const O = JSON.parse(r.options);
  const n = Number(r.answer);
  if (String(O[n]).trim() !== String(t.options[t.answer]).trim()) bad.push(`q${t.id}: 정답 보기 텍스트가 바뀌었다 (${O[n]})`);
  if (!(n >= 0 && n < O.length)) bad.push(`q${t.id}: 정답 index 가 범위 밖 (${r.answer} / ${O.length})`);
  const norm = O.map((s) => String(s).trim());
  if (new Set(norm).size !== norm.length) bad.push(`q${t.id}: 적용 후에도 중복 보기가 남아 있다 → ${r.options}`);
  const wrongNamed = optionsNamedByExplanation(O, r.explanation).filter((i) => i !== n);
  if (wrongNamed.length) bad.push(`q${t.id}: 해설이 오답 보기 [${wrongNamed}] 를 지목한다`);
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건(정답 칸 무변동). 롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
