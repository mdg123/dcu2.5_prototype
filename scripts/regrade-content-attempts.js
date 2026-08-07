require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * scripts/regrade-content-attempts.js
 *
 * `content_attempts` 재채점 정합 스크립트.
 *
 * ── 배경 ────────────────────────────────────────────────────────────────
 * scripts/fix-answer-index-base.js 로 `content_questions.answer` 인덱스 기준을 바로잡기
 * **이전에** 제출된 풀이 기록은 옛 정답키로 채점돼 있다. 실측(2026-08-07 감리):
 *   attempt 3 — student2 가 content 196 에서 [1, 3] 로 **둘 다 맞게** 골랐는데 `0/2 · 0%`.
 * 이 값이 LRS·성취 집계로 그대로 흘러가므로 현재 정답키로 다시 채점해 맞춘다.
 *
 * ── 채점 규칙 ───────────────────────────────────────────────────────────
 * routes/content.js `POST /api/contents/:id/grade` 와 **같은 규칙**을 쓴다(라벨↔집계 일치).
 *   · choice : String 비교        · short : 공백제거+소문자 비교
 *   · essay  : 자동채점 보류      · 미응답 : 오답 아님(분모에서 제외)
 *   · correct_count = 정답 **문항 수**, score_percent = 배점 가중 %(자동채점분 기준)
 *
 * ── 사용법 ──────────────────────────────────────────────────────────────
 *   node scripts/regrade-content-attempts.js                    # 분석만(읽기전용)
 *   node scripts/regrade-content-attempts.js --db <사본>         # 사본 검증
 *   node scripts/regrade-content-attempts.js --apply            # 실제 UPDATE
 *   옵션: --out <디렉터리>  --max <n>(기본 1 — 이보다 많으면 적용 중단)
 *
 * 🔴 안전 규칙
 *   ① `--apply` 전에 rollback.sql 을 **먼저** 기록한다(없으면 중단).
 *   ② 대상이 `--max`(기본 1)건을 넘으면 **적용하지 않고 중단**한다 — 규모가 다르면 판단이 달라진다.
 *   ③ **멱등** — 저장값과 재계산값이 같아지면 다음 실행에서 대상이 0건이 된다. 두 번 돌려도 안전하다.
 *   ④ 증적 출력 폴더는 **--db 를 따라간다**(사본 대상 실행이 정본 증적을 덮지 않게).
 *      fix-answer-index-base.js 가 이 규칙이 없어 정본 report.md 가 사본 산출물로 덮인 사고가 있었다.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const pre = process.argv.find(a => a.startsWith(name + '='));
  if (pre) return pre.slice(name.length + 1);
  return def;
}
const APPLY = process.argv.includes('--apply');
const DB_PATH = path.resolve(ROOT, argVal('--db', path.join('data', 'dacheum.db')));
const MAX = Number(argVal('--max', '1'));
const CANON_DB = path.resolve(ROOT, 'data', 'dacheum.db');
const IS_CANON = path.resolve(DB_PATH) === CANON_DB;
// 사본 대상 실행은 **사본 옆에** 증적을 쓴다(정본 증적 폴더를 덮지 않는다).
const OUT_DIR = path.resolve(ROOT, argVal('--out',
  IS_CANON
    ? path.join('보고서', '증적', '채점정합_content_attempts_20260807')
    : path.join(path.dirname(DB_PATH), '증적_' + path.basename(DB_PATH, path.extname(DB_PATH)))
));

if (!fs.existsSync(DB_PATH)) {
  console.error(`[중단] DB 를 찾을 수 없습니다: ${DB_PATH}`);
  process.exit(1);
}

// ── 채점 규칙 (routes/content.js 와 동일) ───────────────────────────────
function normShort(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }
function normType(t) {
  const s = String(t || '').toLowerCase();
  if (s === 'multiple_choice' || s === 'multiple' || s === 'mc' || s === 'choice') return 'choice';
  if (s === 'short_answer' || s === 'short-answer' || s === 'fill' || s === 'short') return 'short';
  if (s === 'essay' || s === 'long' || s === 'written' || s === 'long_answer') return 'essay';
  return 'choice';
}

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('busy_timeout = 5000');

const attempts = db.prepare('SELECT * FROM content_attempts ORDER BY id').all();
const qStmt = db.prepare(
  'SELECT id, question_number, question_type, answer, points FROM content_questions WHERE content_id = ? ORDER BY question_number'
);

const stale = [];
const skipped = [];

for (const a of attempts) {
  let picks;
  try { picks = JSON.parse(a.answers); } catch (_) { picks = null; }
  if (!Array.isArray(picks)) { skipped.push({ id: a.id, why: `answers 가 배열이 아님(${JSON.stringify(a.answers)})` }); continue; }
  const qs = qStmt.all(a.content_id);
  if (qs.length === 0) { skipped.push({ id: a.id, why: `content ${a.content_id} 에 문항 0건` }); continue; }

  let earned = 0, maxTotal = 0, autoScored = 0, correctCount = 0;
  qs.forEach((q, i) => {
    const pts = Number(q.points) || 1;
    maxTotal += pts;
    const given = picks[i];
    const t = normType(q.question_type);
    if (given == null || given === '') return;   // 미응답 — 자동채점 분모에서 제외
    if (t === 'essay') return;                   // 서술형 — 자동채점 보류
    autoScored += pts;
    const ok = t === 'choice'
      ? String(given) === String(q.answer)
      : (normShort(q.answer) !== '' && normShort(given) === normShort(q.answer));
    if (ok) { earned += pts; correctCount++; }
  });
  const base = autoScored > 0 ? autoScored : maxTotal;
  const pct = base > 0 ? Math.round((earned / base) * 100) : 0;

  if (correctCount !== a.correct_count || pct !== a.score_percent || qs.length !== a.total_questions) {
    stale.push({
      id: a.id, content_id: a.content_id, user_id: a.user_id, attempted_at: a.attempted_at,
      picks,
      stored: { tq: a.total_questions, cc: a.correct_count, pct: a.score_percent },
      next: { tq: qs.length, cc: correctCount, pct },
    });
  }
}

// ── 증적 ───────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const rollbackPath = path.join(OUT_DIR, 'rollback.sql');
const rollback = [
  '-- content_attempts 재채점 롤백 스크립트',
  `-- 생성: ${new Date().toISOString()}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${stale.length}건`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...stale.map(s => `UPDATE content_attempts SET total_questions=${s.stored.tq}, correct_count=${s.stored.cc}, score_percent=${s.stored.pct} WHERE id=${s.id};`),
  'COMMIT;',
  '',
].join('\n');

/**
 * 대상이 **줄어든** 산출물로 기존 증적을 덮지 않는다.
 *
 * 🔴 적용이 끝난 뒤 재실행하면 대상이 0건이 되므로, 그대로 덮으면 "대상 0건 / 영향 0건" 이라는
 *   **사실과 다른 증적**만 남는다(2026-08-07 fix-answer-index-base.js 에서 실제로 그렇게 됐다).
 *   rollback.sql 뿐 아니라 **report.md 도** 같은 규칙으로 지킨다 — 감리가 읽는 것은 report.md 다.
 *
 * @param {string} target   덮어쓸 파일
 * @param {string} content  새 내용
 * @param {(s:string)=>number} countOf  파일 내용에서 "대상 건수" 를 뽑는 함수
 * @param {string} previewName  보존 시 새 내용을 대신 기록할 파일명
 */
function writePreserving(target, content, countOf, previewName) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return;
    const prevN = countOf(prev), nextN = countOf(content);
    const ts = new Date(fs.statSync(target).mtime).toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(target);
    const bak = path.join(path.dirname(target), `${path.basename(target, ext)}.${ts}.bak${ext}`);
    fs.copyFileSync(target, bak);
    if (nextN < prevN) {
      fs.writeFileSync(path.join(path.dirname(target), previewName), content, 'utf8');
      console.warn(`[보존] 기존 ${path.basename(target)}(대상 ${prevN}건)이 새 산출물(${nextN}건)보다 많아 덮어쓰지 않았습니다 → ${previewName}`);
      return;
    }
    console.warn(`[보존] 기존 ${path.basename(target)} 을 ${path.basename(bak)} 로 백업하고 갱신합니다.`);
  }
  fs.writeFileSync(target, content, 'utf8');
}
const countUpdates = s => (s.match(/WHERE id=/g) || []).length;
const countReportTargets = s => {
  const m = s.match(/재채점 대상: \*\*(\d+)건\*\*/);
  return m ? Number(m[1]) : 0;
};
writePreserving(rollbackPath, rollback, countUpdates, 'rollback.preview.sql');

const md = [
  '# content_attempts 재채점 — 리포트',
  '',
  `- 생성: ${new Date().toISOString()}`,
  `- 대상 DB: \`${DB_PATH}\``,
  `- 모드: ${APPLY ? '**APPLY(실제 반영)**' : 'ANALYZE(읽기전용)'}`,
  `- 전체 시도: ${attempts.length}건 / 재채점 대상: **${stale.length}건** / 건너뜀: ${skipped.length}건`,
  '',
  '## 재채점 대상',
  '',
  '| attempt | content | user | 제출시각 | 선택 | 저장값 | 재계산 |',
  '|---|---|---|---|---|---|---|',
  ...stale.map(s => `| ${s.id} | ${s.content_id} | ${s.user_id} | ${s.attempted_at} | ${JSON.stringify(s.picks)} | ${s.stored.cc}/${s.stored.tq} · ${s.stored.pct}% | ${s.next.cc}/${s.next.tq} · ${s.next.pct}% |`),
  '',
  '## 건너뛴 행',
  '',
  ...(skipped.length ? skipped.map(s => `- attempt ${s.id} — ${s.why}`) : ['- 없음']),
  '',
  `- 롤백: \`${path.relative(ROOT, rollbackPath)}\``,
  '',
];
writePreserving(path.join(OUT_DIR, 'report.md'), md.join('\n'), countReportTargets, 'report.preview.md');

// ── 적용 ───────────────────────────────────────────────────────────────
/**
 * 실제 UPDATE. ⚠ 모듈 최상위에 write 를 두지 않는다(REG-HF8 — 로드만으로 DB 가 바뀌면 안 됨).
 */
function applyChanges(handle, list) {
  const upd = handle.prepare('UPDATE content_attempts SET total_questions = ?, correct_count = ?, score_percent = ? WHERE id = ?');
  let n = 0;
  handle.transaction(rows => { for (const s of rows) { upd.run(s.next.tq, s.next.cc, s.next.pct, s.id); n++; } })(list);
  return n;
}

let applied = 0;
if (APPLY) {
  if (!fs.existsSync(rollbackPath)) { console.error('[중단] rollback.sql 이 없습니다. 적용 금지.'); process.exit(1); }
  if (stale.length === 0) console.log('[안내] 재채점 대상 0건 — 적용할 것이 없습니다(멱등).');
  else if (stale.length > MAX) {
    console.error(`[중단] 재채점 대상 ${stale.length}건 > --max ${MAX}. 규모가 예상과 달라 적용하지 않았습니다. PM 확인 필요.`);
    process.exitCode = 1;
  } else applied = applyChanges(db, stale);
}

console.log('=== content_attempts 재채점 ===');
console.log(`DB: ${DB_PATH}`);
console.log(`모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기전용)'} / max=${MAX}`);
console.log(`전체 ${attempts.length}건 · 대상 ${stale.length}건 · 건너뜀 ${skipped.length}건`);
for (const s of stale) {
  console.log(`  attempt ${s.id} c${s.content_id} u${s.user_id} picks=${JSON.stringify(s.picks)}  저장 ${s.stored.cc}/${s.stored.tq}·${s.stored.pct}%  →  재계산 ${s.next.cc}/${s.next.tq}·${s.next.pct}%`);
}
for (const s of skipped) console.log(`  [건너뜀] attempt ${s.id} — ${s.why}`);
if (APPLY) console.log(`적용 완료: ${applied}건`);
console.log(`리포트: ${OUT_DIR}`);

db.close();
