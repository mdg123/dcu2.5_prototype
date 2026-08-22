#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 중복 정답 문항 수리 — q214 (2026-08-21)
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 스크립트는 **정답키가 아니라 문항(보기·해설)** 을 고친다.
 * 정답키만으로는 해소할 수 없는 부류이기 때문이다.
 *
 * ■ 대상
 *   content 187 "분수의 덧셈과 뺄셈 문항" · 초3 수학 · q214 "3/4 - 1/4 의 값은?"
 *     보기 ["1/2","2/4","1/4","3/4"] · answer "4"(범위 초과) · 해설 "…(3-1)/4 = 2/4 = 1/2입니다."
 *
 * ■ 왜 정답키로는 못 고치나
 *   보기 안에 **정답이 두 개**(2/4 와 1/2 은 같은 값) 있다. 어느 칸을 키로 잡아도
 *   다른 칸을 고른 학생이 부당하게 오답 처리된다. 게다가 지금은 answer 가 보기 수(4)를
 *   벗어나 있어 **어떤 보기를 골라도 오답** — 현재 상태가 가장 나쁘다(전원 오답).
 *
 * ■ 무엇을 고치나 (판단 근거)
 *   1. 정답은 `2/4` 로 확정한다. 초3(3학년) 동분모 분수 뺄셈의 교육과정 답은 `2/4` 이고
 *      약분은 5학년 내용이다. 해설도 `(3-1)/4 = 2/4` 를 먼저 쓴다.
 *   2. 중복 정답인 `1/2` 를 **오답 보기 `4/4` 로 교체**한다.
 *      `4/4` 는 "빼기를 더하기로 착각"(3/4 + 1/4)한 초3 오개념에 대응한다.
 *      같은 문항의 형제 q2462(content 2514, "3/4 - 1/4 = ?")가 이미
 *      보기 ["2/4","4/2","4/4","2/8","3/4"] 로 `4/4` 를 오답 보기로 쓰고 있어
 *      **플랫폼 안에서 쓰던 오답 보기 어휘와도 일치**한다.
 *   3. 해설 꼬리 `= 1/2입니다` 는 보기에 없는 값을 가리키게 되므로
 *      `(3-1)/4 = 2/4 입니다.` 로 다듬는다. 이러면 해설이 보기 **정확히 하나**만 지목한다.
 *   4. 보기 순서는 바꾸지 않는다(`2/4` 는 index 1 유지) — 변경 면적을 최소로.
 *      결과 보기 ["4/4","2/4","1/4","3/4"] 는 네 값이 모두 다르고 정답은 하나뿐이다.
 *        · 4/4 = 덧셈 착각   · 1/4 = 빼는 수를 그대로 답으로 씀   · 3/4 = 빼지 않음
 *
 * ■ 과거 제출 영향: 0건 (content 187 참조가 content_attempts·problem_attempts 모두 0)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 정본 DB 쓰기 규약 — scripts/fix-answer-key-integrity-20260821.js 와 동일
 *   · DRY-RUN 기본, `--apply` 로만 반영
 *   · 롤백 SQL 을 **DB 쓰기 전에** 기록, 쓰기보존형
 *   · expect 가드 — options·answer·explanation **세 값 모두**가 계획과 같아야 쓴다.
 *     UPDATE 도 `WHERE id=? AND options=? AND answer=? AND explanation IS ?` 로 2차 확인.
 *   · 멱등 — 이미 목표값이면 SKIP(상대 연산 없음)
 *
 * 사용법
 *   node scripts/fix-question-duplicate-answer-20260821.js              # DRY-RUN
 *   node scripts/fix-question-duplicate-answer-20260821.js --apply
 *   node scripts/fix-question-duplicate-answer-20260821.js --db <사본> --apply
 *   node scripts/fix-question-duplicate-answer-20260821.js --selftest   # 계획 검증(DB 무접촉)
 *
 *   --apply 직후 반드시: npm test
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
const IS_CANON = path.resolve(DB_PATH) === path.resolve(ROOT, 'data', 'dacheum.db');
const OUT_DIR = path.resolve(ROOT, argVal('--out', IS_CANON
  ? path.join('보고서', '증적', '문항중복정답_q214_20260821')
  : path.join(path.dirname(DB_PATH), '증적_문항중복정답_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 계획 ────────────────────────────────────────────────────────────────────
const PLAN = [{
  id: 214,
  expect: {
    options: JSON.stringify(['1/2', '2/4', '1/4', '3/4']),
    answer: '4',
    explanation: '분모가 같으면 분자끼리 뺍니다. (3-1)/4 = 2/4 = 1/2입니다.',
  },
  to: {
    options: JSON.stringify(['4/4', '2/4', '1/4', '3/4']),
    answer: '1',
    explanation: '분모가 같으면 분자끼리 뺍니다. (3-1)/4 = 2/4 입니다.',
  },
  why: '중복 정답(1/2 = 2/4) 제거 — 1/2 을 오답 보기 4/4(덧셈 착각)로 교체하고 정답을 2/4(index 1)로 확정. 초3 동분모 뺄셈은 약분 전 형태가 정답(약분은 5학년).',
}];

const FIELDS = ['options', 'answer', 'explanation'];

// ── 계획 자체 검증 (DB 무접촉) ──────────────────────────────────────────────
function selftestPlan() {
  const problems = [];
  for (const p of PLAN) {
    if (!p.why) problems.push(`q${p.id}: 판정 근거(why)가 없다`);
    for (const f of FIELDS) {
      if (typeof p.expect[f] !== 'string' || typeof p.to[f] !== 'string') {
        problems.push(`q${p.id}.${f}: expect/to 는 문자열이어야 한다`);
      }
    }
    let before, after;
    try { before = JSON.parse(p.expect.options); after = JSON.parse(p.to.options); }
    catch (_) { problems.push(`q${p.id}: options 가 JSON 배열이 아니다`); continue; }

    if (before.length !== after.length) problems.push(`q${p.id}: 보기 개수가 달라진다 (${before.length} → ${after.length})`);
    const n = Number(p.to.answer);
    if (!Number.isInteger(n) || n < 0 || n >= after.length) {
      problems.push(`q${p.id}: 목표 answer=${p.to.answer} 가 0-based 범위 밖 (보기수 ${after.length})`);
    }
    // 핵심 — 고친 뒤에도 중복 정답이 남으면 고친 의미가 없다
    const norm = after.map((s) => String(s).replace(/\s+/g, '').toLowerCase());
    if (new Set(norm).size !== norm.length) problems.push(`q${p.id}: 교체 후에도 보기에 중복이 남는다 → ${JSON.stringify(after)}`);
    // 해설은 정답 보기를 **정확히 하나**만 지목해야 한다
    const expl = String(p.to.explanation).replace(/\s+/g, '').toLowerCase();
    const named = norm.map((t, i) => (t.length >= 2 && expl.includes(t) ? i : -1)).filter((i) => i >= 0);
    if (named.length !== 1) problems.push(`q${p.id}: 해설이 보기 ${named.length}개를 지목한다(정확히 1개여야 함) → [${named}]`);
    else if (named[0] !== n) problems.push(`q${p.id}: 해설이 지목한 보기(index ${named[0]})와 목표 answer(${n})가 다르다`);
    // 바뀌는 것이 실제로 있어야 한다
    if (FIELDS.every((f) => p.expect[f] === p.to[f])) problems.push(`q${p.id}: 바뀌는 값이 없다`);
  }
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  console.log(problems.length ? `[selftest] FAIL\n - ${problems.join('\n - ')}` : `[selftest] PASS — 계획 ${PLAN.length}건`);
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

const todo = [];
const already = [];
const blockers = [];
for (const p of PLAN) {
  const r = db.prepare(
    'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
  ).get(p.id);
  if (!r) { blockers.push(`q${p.id}: DB 에 없다`); continue; }
  if (FIELDS.every((f) => String(r[f]) === p.to[f])) { already.push(p.id); continue; }
  const diff = FIELDS.filter((f) => String(r[f]) !== p.expect[f]);
  if (diff.length) {
    blockers.push(
      `q${p.id}: ${diff.join('·')} 가 계획과 다르다 — 문항이 이미 바뀌었다\n` +
      diff.map((f) => `      ${f}\n        기대: ${p.expect[f]}\n        현재: ${r[f]}`).join('\n')
    );
    continue;
  }
  todo.push({ ...p, content_id: r.content_id, question_text: r.question_text });
}

console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건 → 변경 ${todo.length} · 이미 반영 ${already.length} · 차단 ${blockers.length}`);

if (blockers.length) {
  console.error(`\n🔴 expect 가드 위반 — **한 행도 쓰지 않고 중단합니다**:\n - ${blockers.join('\n - ')}`);
  db.close();
  process.exit(2);
}

// ── 증적: 쓰기 **전에** ─────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
// SQL 문자열 이스케이프.
// ⚠ 정규식 리터럴 안에 **맨따옴표를 쓰지 않는다**(`/'/g` 금지).
//   test/harness-freshness.test.js REG-HF8 의 괄호 깊이 스캐너는 정규식 리터럴을 모르므로
//   그 따옴표를 "문자열 시작" 으로 보고 이후 수백 줄을 통째로 건너뛴다 → 깊이가 어긋나
//   함수 안의 write 를 "가드 앞 최상위 write" 로 오판한다(2026-08-21 실측).
//   split/join 은 따옴표가 문자열 리터럴 안에만 있어 스캐너가 정상 처리한다.
const SQUOTE = String.fromCharCode(39);
const sq = (s) => String(s).split(SQUOTE).join(SQUOTE + SQUOTE);
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
  '-- 중복 정답 문항 수리(q214, 2026-08-21) 롤백',
  `-- 생성: ${stampIso}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${todo.length}건`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...todo.map((t) => `UPDATE content_questions SET options='${sq(t.expect.options)}', answer='${sq(t.expect.answer)}', explanation='${sq(t.expect.explanation)}' WHERE id=${t.id};`),
  'COMMIT;',
  '',
].join('\n'), (s) => (s.match(/WHERE id=/g) || []).length);

const changesPath = path.join(OUT_DIR, 'changes.csv');
writePreserving(changesPath, [
  ['qid', 'content_id', 'question_text', 'field', 'before', 'after', 'why'].map(csvCell).join(','),
  ...todo.flatMap((t) => FIELDS
    .filter((f) => t.expect[f] !== t.to[f])
    .map((f) => [t.id, t.content_id, t.question_text, f, t.expect[f], t.to[f], t.why].map(csvCell).join(','))),
  '',
].join('\n'), (s) => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = ['# 중복 정답 문항 수리 — q214 (2026-08-21)', '',
  `- 생성: ${stampIso}`, `- 대상 DB: \`${DB_PATH}\``, `- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`,
  `- 변경 ${todo.length}건 · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건`, ''];
for (const t of todo) {
  md.push(`## q${t.id} (content ${t.content_id}) — ${t.question_text}`, '');
  md.push('| 항목 | before | after |', '|---|---|---|');
  for (const f of FIELDS) md.push(`| ${f} | \`${t.expect[f]}\` | \`${t.to[f]}\` |`);
  md.push('', `근거: ${t.why}`, '');
}
md.push(`- 롤백: \`${path.relative(ROOT, rollbackPath)}\``, `- 변경 목록: \`${path.relative(ROOT, changesPath)}\``, '');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));
console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) {
    console.log(`  q${t.id}(c${t.content_id})`);
    for (const f of FIELDS) if (t.expect[f] !== t.to[f]) console.log(`    ${f}: ${t.expect[f]}  →  ${t.to[f]}`);
  }
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
const applyAll = db.transaction((items) => {
  const stmt = db.prepare(
    `UPDATE content_questions SET options = ?, answer = ?, explanation = ?
      WHERE id = ? AND options = ? AND answer = ? AND explanation IS ?`
  );
  for (const t of items) {
    const info = stmt.run(t.to.options, t.to.answer, t.to.explanation,
      t.id, t.expect.options, t.expect.answer, t.expect.explanation);
    if (info.changes !== 1) throw new Error(`q${t.id}: UPDATE 가 ${info.changes}행에 적용됨(1이어야 함) — expect 불일치. 전체 롤백합니다.`);
  }
});
try { applyAll(todo); }
catch (e) { console.error(`\n🔴 적용 중단 — 전체 롤백됨: ${e.message}`); db.close(); process.exit(3); }

// 사후 검증
const bad = [];
for (const t of todo) {
  const r = db.prepare('SELECT options, answer, explanation FROM content_questions WHERE id = ?').get(t.id);
  for (const f of FIELDS) if (String(r[f]) !== t.to[f]) bad.push(`q${t.id}.${f}: ${r[f]}`);
  const O = JSON.parse(r.options);
  const n = Number(r.answer);
  if (!(n >= 0 && n < O.length)) bad.push(`q${t.id}: 적용 후에도 0-based 범위 밖 (${r.answer} / 보기수 ${O.length})`);
  const norm = O.map((s) => String(s).replace(/\s+/g, '').toLowerCase());
  if (new Set(norm).size !== norm.length) bad.push(`q${t.id}: 적용 후에도 보기에 중복이 있다`);
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건. 롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
