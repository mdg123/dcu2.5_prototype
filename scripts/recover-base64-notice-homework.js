require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// ─────────────────────────────────────────────────────────────────────────────
// scripts/recover-base64-notice-homework.js
//
// 알림장(notices.content) · 과제 제출(homework_submissions.content) ·
// 알림장 댓글(notice_comments.content) 본문에
// base64 로 박혀 있는 이미지를 **실제 업로드 파일로 바꾼다**(이미 쌓인 것 정리).
//
// 앞으로 들어올 것은 저장 관문이 막는다(routes/notice.js · routes/homework.js →
// lib/inline-data-media.normalizeInlineMedia). 이 스크립트는 **관문이 생기기 전에
// 이미 들어온 행**만 상대한다. 게시글(posts)은 scripts/recover-base64-gallery-images.js 담당.
//
// 왜 정리하는가
//   ⓐ content 가 비대해진다(이미지 1장에 수백 KB~수 MB) — 목록 API 가 그 본문을 통째로 실어 나른다.
//     알림장 목록은 **학부모까지 보는 화면**이라 응답 크기가 곧 체감 속도다.
//   ⓑ 업로드 검사(허용 확장자·50MB)를 한 번도 받지 않은 바이트가 DB 에 남아 있다.
//   ⓒ 캐시·CDN 을 못 태운다. 브라우저가 매번 같은 바이트를 다시 받는다.
//
// ★ 학생 제출물을 다루므로 지키는 선 (건드리지 않는 것)
//   · 바꾸는 것은 **content 의 src 문자열뿐**이다. 글자·태그·첨부·유튜브 iframe 은 그대로.
//   · submitted_at · status · score · feedback · graded_at · is_draft 은 **UPDATE 문에 없다**.
//     (채점·피드백·제출시각이 이 스크립트 때문에 달라지는 일은 구조적으로 불가능하다)
//   · draft_content(임시저장)는 **일부러 손대지 않는다** — 정식 제출 시 NULL 로 정리되는
//     전이 데이터이고, 교사 화면·통계·채점이 보지 않는다. 저장 관문도 같은 이유로 임시저장을
//     변환하지 않으므로 정리 정책이 어긋나지 않는다.
//   · 한 행이라도 규칙 위반이면 그 행은 **건너뛴다**(원본 보존). 나머지는 계속 처리한다.
//
// 멱등성: 변환 후 본문에는 data: 가 남지 않으므로 두 번째 실행은 대상 0건이 된다.
//   (확인은 반드시 **사본**에서 — `--db <복사본>` 로 두 번 돌려볼 것)
//
// 사용법
//   node scripts/recover-base64-notice-homework.js                 # DRY-RUN (기본, 무변형·파일도 안 씀)
//   node scripts/recover-base64-notice-homework.js --apply         # 실제 반영 (+ 롤백 SQL 선기록)
//   node scripts/recover-base64-notice-homework.js --db <경로>     # 사본으로 리허설
//   node scripts/recover-base64-notice-homework.js --only notices  # notices | submissions | comments 한쪽만
//
// ★ --apply 는 **반영 전에** 롤백 SQL 을 보고서/증적/ 아래에 먼저 기록한다.
// ★ --apply 뒤에는 `npm test` 전건을 다시 돌려야 한다(하네스 표식이 자동으로 붉어진다).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const onlyFlag = process.argv.indexOf('--only');
const ONLY = onlyFlag > -1 ? String(process.argv[onlyFlag + 1] || '') : null;
const dbFlag = process.argv.indexOf('--db');
const DB_PATH = dbFlag > -1 && process.argv[dbFlag + 1]
  ? path.resolve(process.argv[dbFlag + 1])
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const EVID_DIR = path.join(__dirname, '..', '보고서', '증적', '알림장_과제제출_base64_복구_20260821');

const { materializeDataUrls, hasInlineDataMedia } = require('../lib/inline-data-media');

if (ONLY && !['notices', 'submissions', 'comments'].includes(ONLY)) {
  console.error(`--only 는 notices | submissions | comments 만 가능합니다 (받은 값: ${ONLY})`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

// 처리 대상 정의 — 표를 늘릴 때 여기만 고친다(규칙은 관문 한 벌 그대로).
const TARGETS = [
  {
    key: 'notices',
    label: '알림장(notices.content)',
    queryType: 'notice',
    select: `SELECT id, class_id, title, content FROM notices
              WHERE content LIKE '%data:image%' OR content LIKE '%data:video%' OR content LIKE '%data:audio%'
              ORDER BY id`,
    describe: (r) => `notice=${r.id} class=${r.class_id} "${String(r.title || '').slice(0, 24)}"`,
    // ⚠ content 만 바꾼다. updated_at 도 건드리지 않는다 —
    //   "내용은 그대로인데 수정된 것처럼 보이는" 알림장을 만들지 않기 위함(학부모가 보는 화면).
    update: 'UPDATE notices SET content = ? WHERE id = ?',
    rollback: (r) => `UPDATE notices SET content = ${sq(r.content)} WHERE id = ${r.id};`,
  },
  {
    key: 'submissions',
    label: '과제 제출(homework_submissions.content)',
    queryType: 'homework',
    select: `SELECT id, homework_id, student_id, status, score, graded_at, submitted_at, is_draft, content
               FROM homework_submissions
              WHERE content LIKE '%data:image%' OR content LIKE '%data:video%' OR content LIKE '%data:audio%'
              ORDER BY id`,
    describe: (r) => `submission=${r.id} hw=${r.homework_id} student=${r.student_id} ` +
      `status=${r.status} score=${r.score == null ? '-' : r.score} draft=${r.is_draft ? 'Y' : 'N'}`,
    // ⚠ content 만. 제출시각·채점 컬럼은 SET 목록에 아예 없다.
    update: 'UPDATE homework_submissions SET content = ? WHERE id = ?',
    rollback: (r) => `UPDATE homework_submissions SET content = ${sq(r.content)} WHERE id = ${r.id};`,
  },
  {
    key: 'comments',
    label: '알림장 댓글(notice_comments.content)',
    queryType: 'notice',
    // 삭제된 댓글(deleted_at)은 제외한다 — 화면에 "[삭제된 댓글]" 로만 나오므로
    //   변환해봐야 아무도 못 보는 파일만 새로 만든다(고아 파일 방지).
    select: `SELECT id, notice_id, user_id, parent_id, content FROM notice_comments
              WHERE deleted_at IS NULL
                AND (content LIKE '%data:image%' OR content LIKE '%data:video%' OR content LIKE '%data:audio%')
              ORDER BY id`,
    describe: (r) => `comment=${r.id} notice=${r.notice_id} user=${r.user_id}` +
      `${r.parent_id ? ` (대댓글→${r.parent_id})` : ''}`,
    // ⚠ content 만. updated_at 은 건드리지 않는다 — 내용은 그대로인데 "수정됨" 으로 보이면 안 된다.
    update: 'UPDATE notice_comments SET content = ? WHERE id = ?',
    rollback: (r) => `UPDATE notice_comments SET content = ${sq(r.content)} WHERE id = ${r.id};`,
  },
];

const active = TARGETS.filter(t => !ONLY || t.key === ONLY);

console.log(`DB: ${DB_PATH}`);
console.log(`모드: ${APPLY ? '★ APPLY (실제 반영)' : 'DRY-RUN (무변형 · 파일도 쓰지 않음)'}`);
console.log(`범위: ${active.map(t => t.label).join(' + ')}`);

// ── 1) 대상 수집 + 변환 계획 (DRY-RUN 은 파일을 쓰지 않는다) ──────────────────
const plans = [];
const failures = [];
for (const t of active) {
  const rows = db.prepare(t.select).all().filter(r => hasInlineDataMedia(r.content));
  console.log(`\n=== ${t.label}: ${rows.length}건 ===`);
  if (!rows.length) console.log('  (대상 없음)');
  for (const r of rows) {
    let out;
    try {
      out = materializeDataUrls(r.content, { queryType: t.queryType, dryRun: !APPLY });
    } catch (e) {
      failures.push({ target: t.key, id: r.id, code: e.code || 'ERR', message: e.message });
      console.log(`  ✖ ${t.describe(r)} 변환 실패 [${e.code || 'ERR'}] ${e.message} — 원본 보존(건너뜀)`);
      continue;
    }
    if (!out.changed) continue;
    plans.push({ target: t, row: r, out });
    console.log(
      `  ${t.describe(r)}\n` +
      `      본문 ${kb(String(r.content).length)} → ${kb(out.content.length)} · ` +
      `파일 ${out.files.length}건 [${out.files.map(f => `${f.kind}/${kb(f.size)}`).join(', ')}]`
    );
  }
}

if (failures.length) {
  console.log(`\n⚠ 변환 실패 ${failures.length}건 — 이 행은 건드리지 않는다(원본 보존):`);
  for (const f of failures) console.log(`   ${f.target}#${f.id} [${f.code}] ${f.message}`);
}

if (!plans.length) {
  console.log('\n대상 0건 — 아무것도 하지 않는다. (이미 정리됐거나 base64 본문이 없다)');
  db.close();
  process.exit(0);
}

// ── 2) 롤백 SQL 선기록 ───────────────────────────────────────────────────────
const rollback = [
  '-- 롤백 SQL — scripts/recover-base64-notice-homework.js --apply 되돌리기',
  `-- 생성 ${new Date().toISOString()}  DB=${DB_PATH}`,
  '-- ⚠ 되돌리면 본문은 다시 base64 가 된다.',
  '--   변환으로 만들어진 /uploads/... 파일은 이 SQL 이 지우지 않는다(고아 파일로 남음).',
  '-- ⚠ 이 스크립트는 content 외 컬럼을 바꾸지 않으므로 롤백도 content 만 되돌린다',
  '--   (제출시각·채점·피드백은 애초에 변경 대상이 아니었다).',
  'BEGIN;',
];
for (const pl of plans) rollback.push(pl.target.rollback(pl.row));
rollback.push('COMMIT;', '');
const rollbackSql = rollback.join('\n');

if (APPLY) {
  fs.mkdirSync(EVID_DIR, { recursive: true });
  const f = path.join(EVID_DIR, `rollback.${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
  fs.writeFileSync(f, rollbackSql, 'utf8');
  console.log(`\n롤백 SQL 선기록: ${f} (${kb(Buffer.byteLength(rollbackSql))})`);
} else {
  const head = rollbackSql.length > 1200 ? rollbackSql.slice(0, 1200) + '\n… (본문이 길어 생략)' : rollbackSql;
  console.log('\n--- 롤백 SQL (미리보기 · --apply 시 파일로 선기록) ---\n' + head);
}

// ── 3) 반영 ──────────────────────────────────────────────────────────────────
if (!APPLY) {
  const byKey = {};
  for (const pl of plans) byKey[pl.target.key] = (byKey[pl.target.key] || 0) + 1;
  console.log(`\nDRY-RUN 종료 — 반영하려면 --apply 를 붙일 것. ` +
    `(대상: ${Object.entries(byKey).map(([k, v]) => `${k} ${v}건`).join(' / ')})`);
  db.close();
  process.exit(0);
}

// 채점·제출 메타 사전 스냅샷 — 반영 뒤 "정말 안 바뀌었는지"를 스스로 검증한다.
const metaBefore = new Map();
for (const pl of plans) {
  if (pl.target.key !== 'submissions') continue;
  const r = pl.row;
  metaBefore.set(r.id, {
    status: r.status, score: r.score, graded_at: r.graded_at,
    submitted_at: r.submitted_at, is_draft: r.is_draft,
  });
}

const tx = db.transaction(() => {
  const stat = {};
  for (const pl of plans) {
    db.prepare(pl.target.update).run(pl.out.content, pl.row.id);
    stat[pl.target.key] = (stat[pl.target.key] || 0) + 1;
  }
  return stat;
});
const done = tx();
console.log(`\n반영 완료 — ${Object.entries(done).map(([k, v]) => `${k} ${v}건`).join(' / ')}`);

// ── 4) 사후 검증 ─────────────────────────────────────────────────────────────
for (const t of active) {
  const left = db.prepare(t.select).all().filter(r => hasInlineDataMedia(r.content));
  console.log(`사후 검증 — ${t.label} 에 data: 가 남은 행: ${left.length}건` +
    (left.length ? ` [${left.map(r => r.id).join(',')}]` : ''));
}

// 변환된 파일이 실제로 디스크에 있는지 (없으면 화면에서 404 = 빈 이미지가 된다)
let missing = 0;
for (const pl of plans) {
  for (const f of pl.out.files) {
    const abs = path.join(__dirname, '..', 'public', f.url.replace(/^\//, ''));
    if (!fs.existsSync(abs)) { missing++; console.log(`  ✖ 파일 없음: ${f.url} (${pl.target.key}#${pl.row.id})`); }
  }
}
console.log(`파일 존재 검증 — 누락 ${missing}건`);

// ★ 학생 제출물 보호 확인 — 채점·제출 메타가 한 칸도 안 바뀌었는지 실제로 다시 읽어 대조
let metaDrift = 0;
for (const [id, before] of metaBefore) {
  const now = db.prepare(
    'SELECT status, score, graded_at, submitted_at, is_draft FROM homework_submissions WHERE id = ?'
  ).get(id);
  for (const k of Object.keys(before)) {
    if (String(now[k]) !== String(before[k])) {
      metaDrift++;
      console.log(`  ✖ submission#${id} ${k}: ${before[k]} → ${now[k]} (바뀌면 안 되는 값이다)`);
    }
  }
}
console.log(`제출·채점 메타 보존 검증 — 변동 ${metaDrift}건 (0 이어야 정상)`);

console.log('\n★ 이 스크립트를 --apply 로 돌렸으므로 `npm test` 전건을 다시 돌릴 것.');
db.close();
