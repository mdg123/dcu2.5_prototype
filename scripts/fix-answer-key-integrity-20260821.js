#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * content_questions.answer 정답키 정합 — 2026-08-21
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 부류를 **문항별 개별 판정**으로 고친다. 일괄 규칙(-1 / +1)은 쓰지 않는다.
 *
 *  ① 실수 문자열 정규화 (11건)  `answer='0.0'` → `'0'`
 *     - **숫자값은 바뀌지 않는다**(Number('0.0') === Number('0') === 0).
 *       정답 보기가 바뀌는 변경이 아니라, 문자열 비교기가 읽을 수 있게 만드는 표기 정규화다.
 *     - 왜 생겼나: better-sqlite3 는 JS number 를 REAL 로 바인딩하고, SQLite 의 TEXT
 *       affinity 는 REAL 0 을 `'0.0'` 으로 저장한다(실측: 0→'0.0', 1→'1.0').
 *       `seed-quiz-items.js` 가 `item.ans`(JS number)를 그대로 넘겼다.
 *       이후 정규화 패스들이 전부 `CAST(answer AS INTEGER) >= 1` 로 걸러서
 *       **0 만 구조적으로 빠졌다**(1.0·2.0 은 정리됐는데 0.0 만 남은 이유).
 *       평가지 생성(routes/content.js 문항 복사)이 이 값을 그대로 복제해 11건으로 번졌다.
 *     - 무엇이 깨지나: `routes/content.js` `/grade` 는 `String(given) === String(q.answer)`.
 *       학생이 보내는 값은 0-based 인덱스 `0` → `'0' !== '0.0'` → **영구 오답**.
 *
 *  ② 정답키 손상 (34건)  범위 밖(`answer >= 보기수`) — 감리가 2026-08-07 지목한 35건 중 34건
 *     - 이 부류는 "1-based 저장" 이 아니다. `-1` 을 하면 **엉뚱한 보기가 정답이 된다**.
 *       (c102: 보기 ["12cm³","20cm³","60cm³","35cm³"] answer=4, 해설은 60cm³ → -1 하면 "35cm³")
 *     - 그래서 **해설의 문구를 보기와 대조**해 올바른 index 를 문항별로 산출했다.
 *     - q214 는 **판정 불가로 제외**한다(보기에 "1/2" 와 "2/4" 가 모두 있고 둘 다 3/4-1/4 의
 *       정답이며 해설이 두 값을 모두 적는다 → 문항 자체 결함. 정답키가 아니라 문항을 고쳐야 한다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 정본 DB 쓰기 규약 (2026-08-07 이중적용 사고 재발 방지)
 *   · 기본은 DRY-RUN. `--apply` 로만 반영한다.
 *   · **롤백 SQL 을 DB 에 쓰기 *전에*** 파일로 남긴다. 쓰기보존형(기존 파일을 덮지 않는다).
 *   · `expect` 가드 — 모든 대상 행의 현재 값이 계획과 다르면 **한 행도 쓰지 않고 중단**.
 *     UPDATE 도 `WHERE id=? AND answer=?` 로 걸어 트랜잭션 안에서 한 번 더 확인한다.
 *   · 옵션/해설 지문까지 대조한다(`optionsExact`·`explanationHas`). 문항이 바뀌었으면 중단.
 *   · 멱등: 이미 목표값이면 SKIP(누적 차감 불가능한 구조 — 상대 연산을 쓰지 않는다).
 *
 * 사용법
 *   node scripts/fix-answer-key-integrity-20260821.js                 # DRY-RUN(정본)
 *   node scripts/fix-answer-key-integrity-20260821.js --apply         # 정본 반영
 *   node scripts/fix-answer-key-integrity-20260821.js --db <사본> --apply
 *   node scripts/fix-answer-key-integrity-20260821.js --selftest      # 계획 자체 검증(DB 무접촉)
 *
 *   --apply 직후 반드시: npm test   (하네스 표식 해소)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DQUOTE = String.fromCharCode(34);

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const APPLY = process.argv.includes('--apply');
const DB_PATH = path.resolve(ROOT, argVal('--db', path.join('data', 'dacheum.db')));
const CANON_DB = path.resolve(ROOT, 'data', 'dacheum.db');
const IS_CANON = path.resolve(DB_PATH) === CANON_DB;
// 사본 대상 실행이 정본 증적을 덮지 않도록 출력 폴더를 DB 에 묶는다(2026-08-07 교훈).
const OUT_DIR = path.resolve(ROOT, argVal('--out', IS_CANON
  ? path.join('보고서', '증적', '정답키정합_20260821')
  : path.join(path.dirname(DB_PATH), '증적_정답키정합_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 계획 ────────────────────────────────────────────────────────────────────
// 각 항목: { id, expect(현재값), to(목표값), why, optionsExact?, explanationHas? }
const TEMPLATE_OPTIONS = JSON.stringify(
  ['잘못된 적용 1', '잘못된 적용 2', '잘못된 적용 3', '올바른 적용', '해당 없음']
);
const TEMPLATE_IDS = [
  276, 279, 282, 285, 288, 291, 294, 297, 300, 303,
  306, 309, 312, 315, 318, 321, 324, 327, 330, 333,
  336, 339, 342, 345, 348, 351, 354, 357, 360, 363,
];

/** ① '0.0' → '0' — 값 동일(Number 기준), 문자열 표기만 정규화. */
const DECIMAL_IDS = [42, 43, 161, 176, 177, 182, 183, 190, 191, 206, 209];

const PLAN = [
  ...DECIMAL_IDS.map(id => ({
    id, kind: 'DECIMAL', expect: '0.0', to: '0',
    why: '실수 문자열 표기 정규화 — 숫자값 불변(0). 해설이 보기[0]을 지목함(시드 원본도 ans:0)',
  })),

  // ── ② 정답키 손상 — 해설 이중 대조로 문항별 산출 ──────────────────────────
  {
    id: 86, kind: 'BROKEN_KEY', expect: '4', to: '2',
    optionsExact: JSON.stringify(['12cm³', '20cm³', '60cm³', '35cm³']),
    explanationHas: '60cm³',
    why: '해설 "3 × 4 × 5 = 60cm³" → 보기[2]="60cm³" 와 문자열 완전 일치. -1(=3)은 "35cm³" 로 오답',
  },
  {
    id: 213, kind: 'BROKEN_KEY', expect: '4', to: '1',
    optionsExact: JSON.stringify(['2/5', '5/6', '3/5', '1/6']),
    explanationHas: '5/6',
    why: '해설 "3/6 + 2/6 = 5/6" → 보기[1]="5/6". 동일 문항 q210(content 186, 보기까지 동일)이 answer=1 로 정상 보관 중 — 형제 대조 일치',
  },
  {
    id: 239, kind: 'BROKEN_KEY', expect: '4', to: '2',
    optionsExact: JSON.stringify(['①1', '②2', '③3', '④9']),
    explanationHas: '3',
    why: '√9 문항. 해설 "3²=9" → 정답은 3 → 보기[2]="③3". 보기의 원숫자 라벨(③=3번째)도 같은 칸을 가리킴. -1(=3)은 "④9" 로 오답',
  },
  {
    id: 240, kind: 'BROKEN_KEY', expect: '4', to: '1',
    optionsExact: JSON.stringify(['①2', '②4', '③8', '④16']),
    explanationHas: '4',
    why: '√16 문항. 해설 "4²=16" → 정답은 4 → 보기[1]="②4". 원숫자 라벨(②=2번째)도 일치. -1(=3)은 "④16" 으로 오답',
  },
  ...TEMPLATE_IDS.map(id => ({
    id, kind: 'BROKEN_KEY', expect: '5', to: '3',
    optionsExact: TEMPLATE_OPTIONS,
    explanationHas: '4번이 정답',
    why: '해설 "…적용하면 4번이 정답입니다" → 1-based 4번 = 보기[3]="올바른 적용". 문항 지문("올바르게 적용한 것은?")과 보기 의미도 같은 칸을 가리킴(신호 2종 일치). -1(=4)은 "해당 없음" 이라 오히려 악화',
  })),
];

// 판정 불가로 **일부러 제외**한 항목 — 보고용(코드가 잊지 않게 여기에 남긴다).
const UNDECIDED = [
  {
    id: 214, content_id: 187, current: '4',
    why: '보기 ["1/2","2/4","1/4","3/4"] 에 3/4-1/4 의 정답이 **두 개**(1/2 와 2/4) 들어 있고 '
       + '해설도 "(3-1)/4 = 2/4 = 1/2입니다" 로 둘을 모두 적는다. 어느 칸을 키로 잡아도 '
       + '다른 칸을 고른 학생이 부당하게 오답 처리된다 → 정답키가 아니라 **문항(보기)을 고쳐야 한다**. '
       + '형제 문항 q2462 는 "2/4" 를 정답으로 잡아 해설 종결어("1/2입니다")와 반대 방향을 가리킨다 — 판정 불가.',
  },
];

// ── 계획 자체 검증 (DB 무접촉) ──────────────────────────────────────────────
function selftestPlan() {
  const problems = [];
  const seen = new Set();
  for (const p of PLAN) {
    if (seen.has(p.id)) problems.push(`중복 id: ${p.id}`);
    seen.add(p.id);
    if (typeof p.expect !== 'string' || typeof p.to !== 'string') problems.push(`q${p.id}: expect/to 는 문자열이어야 한다`);
    if (p.expect === p.to) problems.push(`q${p.id}: expect 와 to 가 같다`);
    if (!/^\d+$/.test(p.to)) problems.push(`q${p.id}: to 는 정규 정수 문자열이어야 한다 (${p.to})`);
    if (!p.why) problems.push(`q${p.id}: 판정 근거(why)가 없다`);
    if (p.kind === 'BROKEN_KEY') {
      if (!p.optionsExact) problems.push(`q${p.id}: 손상 정정에는 optionsExact 대조가 필수다`);
      if (!p.explanationHas) problems.push(`q${p.id}: 손상 정정에는 explanationHas 대조가 필수다`);
      const opts = JSON.parse(p.optionsExact);
      const to = Number(p.to);
      if (!(to >= 0 && to < opts.length)) problems.push(`q${p.id}: to=${to} 가 0-based 범위 밖 (보기수 ${opts.length})`);
    }
    if (p.kind === 'DECIMAL' && Number(p.expect) !== Number(p.to)) {
      problems.push(`q${p.id}: 표기 정규화인데 숫자값이 달라진다 (${p.expect} → ${p.to})`);
    }
  }
  if (UNDECIDED.some(u => seen.has(u.id))) problems.push('판정 불가 목록의 문항이 변경 계획에 들어 있다');
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  console.log(problems.length ? `[selftest] FAIL\n - ${problems.join('\n - ')}` : `[selftest] PASS — 계획 ${PLAN.length}건, 판정 불가 ${UNDECIDED.length}건`);
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

const rows = new Map(
  db.prepare(
    `SELECT id, content_id, question_type, options, answer, explanation
       FROM content_questions WHERE id IN (${PLAN.map(p => p.id).join(',')})`
  ).all().map(r => [r.id, r])
);

const todo = [];
const already = [];
const blockers = [];
for (const p of PLAN) {
  const r = rows.get(p.id);
  if (!r) { blockers.push(`q${p.id}: DB 에 없다`); continue; }
  if (String(r.answer) === p.to) { already.push(p.id); continue; }      // 멱등 — 이미 반영됨
  if (String(r.answer) !== p.expect) {
    blockers.push(`q${p.id}: expect='${p.expect}' 인데 현재값='${r.answer}' — 계획 수립 이후 값이 바뀌었다`);
    continue;
  }
  if (p.optionsExact && String(r.options) !== p.optionsExact) {
    blockers.push(`q${p.id}: 보기가 계획과 다르다 — 문항이 교체됐을 수 있다\n      기대: ${p.optionsExact}\n      현재: ${r.options}`);
    continue;
  }
  if (p.explanationHas && !String(r.explanation || '').includes(p.explanationHas)) {
    blockers.push(`q${p.id}: 해설에 '${p.explanationHas}' 가 없다 — 판정 근거가 사라졌다\n      현재 해설: ${r.explanation}`);
    continue;
  }
  todo.push({ ...p, content_id: r.content_id, options: r.options, explanation: r.explanation });
}

console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건 → 변경 ${todo.length} · 이미 반영 ${already.length} · 차단 ${blockers.length}`);
console.log(`판정 불가(손대지 않음): ${UNDECIDED.map(u => 'q' + u.id).join(', ') || '없음'}`);

if (blockers.length) {
  console.error(`\n🔴 expect 가드 위반 — **한 행도 쓰지 않고 중단합니다**:\n - ${blockers.join('\n - ')}`);
  db.close();
  process.exit(2);
}

// ── 증적: 쓰기 **전에** 롤백/변경목록/리포트를 남긴다 ────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

function csvCell(s) {
  return DQUOTE + String(s == null ? '' : s).split(DQUOTE).join(DQUOTE + DQUOTE) + DQUOTE;
}
// SQL 문자열 이스케이프. 정규식 리터럴(`/'/g`)을 쓰지 않는 이유는 DQUOTE 주석과 같다 —
// REG-HF8 의 괄호 깊이 스캐너가 정규식 안의 따옴표를 문자열 시작으로 오판한다.
const SQUOTE = String.fromCharCode(39);
const sq = (s) => String(s).split(SQUOTE).join(SQUOTE + SQUOTE);

/**
 * 기존 산출물을 **빈 내용/축소된 내용으로 덮지 않는다**.
 * 🔴 2026-08-07 사고: 적용 후 재실행으로 rollback.sql 이 0행짜리로 덮여 되돌릴 수단이 사라졌다.
 *   재실행은 언제든 일어나므로 "쓰기 전 보존" 만이 안전하다.
 * @param {(s:string)=>number} countRows 파일 내용에서 유효 행 수를 세는 함수
 */
function writePreserving(target, content, countRows) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return { action: 'same' };
    const bakName = path.basename(target).replace(/(\.[^.]+)$/, `.${new Date(fs.statSync(target).mtime).toISOString().replace(/[:.]/g, '-')}.bak$1`);
    const bak = path.join(path.dirname(target), bakName);
    fs.copyFileSync(target, bak);
    if (countRows(content) < countRows(prev)) {
      const preview = target.replace(/(\.[^.]+)$/, '.preview$1');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(`[보존] 기존 ${path.basename(target)}(${countRows(prev)}행)이 새 산출물(${countRows(content)}행)보다 많아 덮어쓰지 않았습니다.`);
      console.warn(`        기존 유지: ${target}\n        새 산출물: ${preview}`);
      return { action: 'preserved', preview };
    }
    console.warn(`[보존] 기존 ${path.basename(target)} 을 ${path.basename(bak)} 로 백업하고 갱신합니다.`);
  }
  fs.writeFileSync(target, content, 'utf8');
  return { action: 'written' };
}
/** 사람이 덧붙인 blockquote(>) 주석이 있으면 원본을 지킨다. 이 생성기는 `>` 줄을 만들지 않는다. */
function writePreservingAnnotations(target, content) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return { action: 'same' };
    if (prev.split(/\r?\n/).some(l => /^\s*>/.test(l))) {
      const preview = target.replace(/(\.[^.]+)$/, '.preview$1');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(`[보존] ${path.basename(target)} 에 손으로 덧붙인 주석(> …)이 있어 덮어쓰지 않았습니다. 새 산출물: ${preview}`);
      return { action: 'preserved', preview };
    }
  }
  fs.writeFileSync(target, content, 'utf8');
  return { action: 'written' };
}

const stampIso = new Date().toISOString();
const rollbackSql = [
  '-- content_questions.answer 정답키 정합(2026-08-21) 롤백',
  `-- 생성: ${stampIso}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${todo.length}건`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...todo.map(t => `UPDATE content_questions SET answer='${sq(t.expect)}' WHERE id=${t.id};`),
  'COMMIT;',
  '',
].join('\n');
const rollbackPath = path.join(OUT_DIR, 'rollback.sql');
writePreserving(rollbackPath, rollbackSql, s => (s.match(/WHERE id=/g) || []).length);

const changesCsv = [
  ['qid', 'content_id', 'kind', 'before', 'after', 'options', 'explanation', 'why']
    .map(csvCell).join(','),
  ...todo.map(t => [t.id, t.content_id, t.kind, t.expect, t.to, t.options, t.explanation, t.why]
    .map(csvCell).join(',')),
  '',
].join('\n');
const changesPath = path.join(OUT_DIR, 'changes.csv');
writePreserving(changesPath, changesCsv, s => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = [];
md.push('# content_questions.answer 정답키 정합 — 2026-08-21');
md.push('');
md.push(`- 생성: ${stampIso}`);
md.push(`- 대상 DB: \`${DB_PATH}\``);
md.push(`- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`);
md.push(`- 변경 ${todo.length}건 · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건 · 판정 불가 ${UNDECIDED.length}건`);
md.push('');
md.push('## 1. 변경 대상');
md.push('');
md.push('| qid | content | 부류 | before | after | 판정 근거 |');
md.push('|---|---|---|---|---|---|');
for (const t of todo) md.push(`| ${t.id} | ${t.content_id} | ${t.kind} | \`${t.expect}\` | \`${t.to}\` | ${t.why} |`);
md.push('');
md.push('## 2. 판정 불가 — 손대지 않음');
md.push('');
md.push('| qid | content | 현재 answer | 이유 |');
md.push('|---|---|---|---|');
for (const u of UNDECIDED) md.push(`| ${u.id} | ${u.content_id} | \`${u.current}\` | ${u.why} |`);
md.push('');
md.push(`- 롤백: \`${path.relative(ROOT, rollbackPath)}\``);
md.push(`- 변경 목록: \`${path.relative(ROOT, changesPath)}\``);
md.push('');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));

console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) console.log(`  q${t.id}(c${t.content_id}) ${t.expect} → ${t.to}   ${t.kind}`);
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
// UPDATE 에도 expect 를 건다(트랜잭션 안 2차 확인). 한 행이라도 어긋나면 전체 롤백.
const applyAll = db.transaction((items) => {
  const stmt = db.prepare('UPDATE content_questions SET answer = ? WHERE id = ? AND answer = ?');
  for (const t of items) {
    const info = stmt.run(t.to, t.id, t.expect);
    if (info.changes !== 1) {
      throw new Error(`q${t.id}: UPDATE 가 ${info.changes}행에 적용됨(1이어야 함) — expect 불일치. 전체 롤백합니다.`);
    }
  }
});
try {
  applyAll(todo);
} catch (e) {
  console.error(`\n🔴 적용 중단 — 전체 롤백됨: ${e.message}`);
  db.close();
  process.exit(3);
}

// 사후 검증 — 목표값과 0-based 범위를 모두 확인
const bad = [];
for (const t of todo) {
  const r = db.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(t.id);
  if (String(r.answer) !== t.to) bad.push(`q${t.id}: ${r.answer} (기대 ${t.to})`);
  try {
    const O = JSON.parse(r.options);
    if (Array.isArray(O) && O.length && !(Number(r.answer) >= 0 && Number(r.answer) < O.length)) {
      bad.push(`q${t.id}: 적용 후에도 0-based 범위 밖 (${r.answer} / 보기수 ${O.length})`);
    }
  } catch (_) {}
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건. 롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
