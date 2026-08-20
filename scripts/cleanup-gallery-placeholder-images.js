require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// ─────────────────────────────────────────────────────────────────────────────
// scripts/cleanup-gallery-placeholder-images.js
//
// 나도예술가 레거시 "빈 이미지" 정리 (2026-08-20 감리 별건 · 사용자 지적 원인 중 하나)
//
// 무엇이 문제인가
//   student_gallery.image_url 에 **서버에 없는 자리표시자 파일**을 가리키는 행이 남아 있다.
//     /images/placeholder.png · /images/placeholder-art.png · /uploads/placeholder.jpg
//   `public/images/` 디렉터리 자체가 없다 → 목록을 열 때마다 404 가 나고,
//   onerror 폴백이 있는 화면은 이모지로 때우지만 없는 화면은 깨진 이미지가 그대로 보인다.
//   사용자가 "빈 이미지" 라고 지목한 화면이 바로 이것이다.
//
// 왜 DB 를 고치는가(FE 가드가 아니라)
//   image_url 을 읽어 <img> 로 그리는 화면이 gallery.html·contests.html·admin/index.html·
//   growth/index.html 등 여러 곳이다. 화면마다 가드를 베끼면 이번 R1 과 똑같은
//   "정본 옆에 판정 사본" 이 된다. **데이터를 한 번 비우면 모든 화면이 함께 낫는다.**
//   비운 뒤에는 각 화면의 기존 분기(`image_url ? <img> : 이모지`)가 그대로 이모지 카드를 그린다.
//
// 복구 가능성 조사 결과(2026-08-20 정본 실측)
//   · 대상 24건 중 원본 게시글이 살아 있는 것 **0건** (source_post_id 가 있는 2건은 post 55·56 → 삭제됨)
//   · 첨부(gallery_attachments)로 살릴 이미지가 있는 것 **0건**
//     (id=7 의 첨부 1건도 /images/placeholder-art.png 로 같은 자리표시자)
//   → 살릴 원본이 없다. 자리표시자를 **비우는 것**이 최선이다.
//
// 사용법
//   node scripts/cleanup-gallery-placeholder-images.js            # DRY-RUN (기본, 무변형)
//   node scripts/cleanup-gallery-placeholder-images.js --apply    # 실제 반영 (+ 롤백 SQL 선기록)
//   node scripts/cleanup-gallery-placeholder-images.js --apply --db <경로>   # 사본으로 리허설
//
// ★ --apply 는 **반영 전에** 롤백 SQL 을 보고서/증적/ 아래에 먼저 기록한다.
// ★ --apply 뒤에는 `npm test` 전건을 다시 돌려야 한다(하네스 표식이 자동으로 붉어진다).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const dbFlag = process.argv.indexOf('--db');
const DB_PATH = dbFlag > -1 && process.argv[dbFlag + 1]
  ? path.resolve(process.argv[dbFlag + 1])
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const EVID_DIR = path.join(__dirname, '..', '보고서', '증적', '나도예술가_자리표시자_정리_20260820');

// 자리표시자 판정은 SSOT(public/js/media-kind.js) 와 같은 규칙을 쓴다.
const { isPlaceholderUrl } = require('../public/js/media-kind');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ── 1) 대상 수집 ─────────────────────────────────────────────────────────────
const galleryRows = db.prepare(`
  SELECT id, title, image_url, type, approval_status, deleted_at, source_post_id,
         (SELECT COUNT(*) FROM gallery_attachments a WHERE a.gallery_id = student_gallery.id) AS att,
         (SELECT COUNT(*) FROM posts p WHERE p.id = student_gallery.source_post_id) AS post_alive
    FROM student_gallery
   WHERE image_url IS NOT NULL AND image_url <> ''
   ORDER BY id
`).all().filter(r => isPlaceholderUrl(r.image_url));

const attRows = db.prepare(`
  SELECT id, gallery_id, type, url FROM gallery_attachments ORDER BY id
`).all().filter(r => isPlaceholderUrl(r.url));

console.log(`DB: ${DB_PATH}`);
console.log(`모드: ${APPLY ? '★ APPLY (실제 반영)' : 'DRY-RUN (무변형)'}`);
console.log(`\n=== student_gallery.image_url 자리표시자: ${galleryRows.length}건 ===`);
const live = galleryRows.filter(r => r.approval_status === 'approved' && !r.deleted_at);
console.log(`  그중 나도예술가에 실제 노출(approved · 미삭제): ${live.length}건 [${live.map(r => r.id).join(',')}]`);
for (const r of galleryRows) {
  console.log(`  id=${r.id} ${r.approval_status}${r.deleted_at ? '(삭제됨)' : ''} type=${r.type} att=${r.att} ` +
    `post=${r.source_post_id == null ? '-' : r.source_post_id + (r.post_alive ? ':살아있음' : ':삭제됨')} ` +
    `url=${r.image_url} title=${JSON.stringify((r.title || '').slice(0, 20))}`);
}
console.log(`\n=== gallery_attachments.url 자리표시자: ${attRows.length}건 ===`);
for (const r of attRows) console.log(`  att=${r.id} gallery=${r.gallery_id} type=${r.type} url=${r.url}`);

// 살릴 원본이 있는지 다시 확인 — 있으면 손대지 않고 사람이 판단하도록 남긴다.
const salvageable = galleryRows.filter(r => r.post_alive > 0);
if (salvageable.length) {
  console.log(`\n⚠ 원본 게시글이 살아 있는 행이 ${salvageable.length}건 있다: ` +
    `[${salvageable.map(r => r.id).join(',')}] — 비우지 않고 남긴다(승인 재처리로 복구 가능).`);
}
const targets = galleryRows.filter(r => r.post_alive === 0);

if (!targets.length && !attRows.length) {
  console.log('\n대상 0건 — 아무것도 하지 않는다.');
  db.close();
  process.exit(0);
}

// ── 2) 롤백 SQL 선기록 ───────────────────────────────────────────────────────
const rollback = [
  '-- 롤백 SQL — scripts/cleanup-gallery-placeholder-images.js --apply 되돌리기',
  `-- 생성 ${new Date().toISOString()}  DB=${DB_PATH}`,
  'BEGIN;',
  ...targets.map(r => `UPDATE student_gallery SET image_url = ${sq(r.image_url)} WHERE id = ${r.id};`),
  ...attRows.map(r =>
    `INSERT INTO gallery_attachments (id, gallery_id, type, url) VALUES (${r.id}, ${r.gallery_id}, ${sq(r.type)}, ${sq(r.url)});`),
  'COMMIT;',
  ''
].join('\n');

if (APPLY) {
  fs.mkdirSync(EVID_DIR, { recursive: true });
  const f = path.join(EVID_DIR, `rollback.${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
  fs.writeFileSync(f, rollback, 'utf8');
  console.log(`\n롤백 SQL 선기록: ${f}`);
} else {
  console.log('\n--- 롤백 SQL (미리보기) ---\n' + rollback);
}

// ── 3) 반영 ──────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`\nDRY-RUN 종료 — 반영하려면 --apply 를 붙일 것. ` +
    `(대상: student_gallery ${targets.length}건 / gallery_attachments ${attRows.length}건)`);
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  let g = 0, a = 0;
  const upd = db.prepare("UPDATE student_gallery SET image_url = '' WHERE id = ?");
  for (const r of targets) g += upd.run(r.id).changes;
  const del = db.prepare('DELETE FROM gallery_attachments WHERE id = ?');
  for (const r of attRows) a += del.run(r.id).changes;
  return { g, a };
});
const done = tx();
console.log(`\n반영 완료 — student_gallery.image_url 비움 ${done.g}건 / gallery_attachments 삭제 ${done.a}건`);

// ── 4) 사후 검증 ─────────────────────────────────────────────────────────────
const left = db.prepare(`SELECT COUNT(*) c FROM student_gallery WHERE image_url LIKE '%placeholder%'`).get().c;
const leftAtt = db.prepare(`SELECT COUNT(*) c FROM gallery_attachments WHERE url LIKE '%placeholder%'`).get().c;
console.log(`사후 검증 — 남은 자리표시자: student_gallery ${left}건 / gallery_attachments ${leftAtt}건` +
  (salvageable.length ? ` (원본 살아있어 남긴 ${salvageable.length}건 포함)` : ''));
console.log('\n★ 이 스크립트를 --apply 로 돌렸으므로 `npm test` 전건을 다시 돌릴 것.');
db.close();
