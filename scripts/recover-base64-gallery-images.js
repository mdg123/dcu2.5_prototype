require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// ─────────────────────────────────────────────────────────────────────────────
// scripts/recover-base64-gallery-images.js
//
// 본문에 base64 로 박힌 이미지를 **실제 파일로 되살려** 나도예술가 표지를 복구한다.
//
// 무엇이 문제인가 (사용자 실측 2026-08-21 · GCP 정본 student_gallery 41~48 / posts 98~105)
//   교사(teacher1)가 갤러리 게시판에 작품 8건을 올려 승인까지 했는데
//     · 채움클래스 갤러리 → 이미지가 보인다   (본문에서 첫 <img> 를 꺼내 그리므로 base64 도 렌더)
//     · 나도예술가        → 팔레트 이모지(빈 이미지)
//   이미지가 파일이 아니라 본문에 `data:image/png;base64,…` 로 박혀 있고
//   (Quill 에디터 **붙여넣기**), student_gallery.image_url 에는 서버에 없는
//   자리표시자(/images/placeholder.png)가 들어가 있기 때문이다.
//
// scripts/cleanup-gallery-placeholder-images.js 가 이 8건을 건너뛴 것은 **옳은 동작**이다
//   ("살릴 원본이 있으면 건드리지 않는다"). 그 규칙은 그대로 두고, 여기서 **살린다**.
//
// 하는 일
//   ① posts.content 의 data: 미디어 → 실제 업로드 파일로 저장하고 src 를 파일 경로로 치환
//      (규칙은 /api/upload 와 같은 lib/upload-rules.js — 허용 확장자·50MB·저장 위치·파일명)
//   ② 연결된 student_gallery.image_url 이 자리표시자/data:/빈값이면 → 첫 이미지 파일로 교체
//   ③ gallery_attachments 가 비었거나 전부 못 쓰는 값(자리표시자·data:)이면 → 파일 URL 로 다시 채움
//      (쓸 수 있는 첨부가 하나라도 있으면 **손대지 않는다** — 학생이 나도예술가에서 직접 손본 작품 보호)
//
// 왜 posts.content 도 바꾸는가 (판단 근거)
//   안 바꾸면 DB 비대(ⓑ)·목록 API 무게(ⓒ)가 그대로 남고, 다음에 그 글을 승인·재연동할 때
//   또 base64 가 흘러든다. 파일 경로로 바꿔도 채움클래스 갤러리는 여전히
//   `image_url || 본문 첫 <img>` 로 그리므로 **화면은 그대로 정상**이다.
//   원본 content 는 롤백 SQL 에 통째로 선기록하므로 되돌릴 수 있다.
//
// 사용법
//   node scripts/recover-base64-gallery-images.js                 # DRY-RUN (기본, 무변형·파일도 안 씀)
//   node scripts/recover-base64-gallery-images.js --apply         # 실제 반영 (+ 롤백 SQL 선기록)
//   node scripts/recover-base64-gallery-images.js --db <경로>     # 사본으로 리허설
//   node scripts/recover-base64-gallery-images.js --only-gallery  # 나도예술가에 연결된 글만
//
// ★ --apply 는 **반영 전에** 롤백 SQL 을 보고서/증적/ 아래에 먼저 기록한다.
// ★ --apply 뒤에는 `npm test` 전건을 다시 돌려야 한다(하네스 표식이 자동으로 붉어진다).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const ONLY_GALLERY = process.argv.includes('--only-gallery');
const dbFlag = process.argv.indexOf('--db');
const DB_PATH = dbFlag > -1 && process.argv[dbFlag + 1]
  ? path.resolve(process.argv[dbFlag + 1])
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const EVID_DIR = path.join(__dirname, '..', '보고서', '증적', '나도예술가_base64_복구_20260821');

const { materializeDataUrls, hasInlineDataMedia } = require('../lib/inline-data-media');
const { isPlaceholderUrl } = require('../public/js/media-kind');
const { extractPostMedia } = require('../lib/board-gallery-link');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

/** 대표 이미지를 갈아야 하는가 — 자리표시자·data:·빈값이면 못 쓰는 값이다. */
function coverUnusable(url) {
  const s = String(url == null ? '' : url).trim();
  return !s || isPlaceholderUrl(s) || /^data:/i.test(s);
}

// ── 1) 대상 수집 ─────────────────────────────────────────────────────────────
const allPosts = db.prepare(`
  SELECT id, class_id, board_id, author_id, title, content, image_url
    FROM posts
   WHERE content LIKE '%data:image%' OR content LIKE '%data:video%' OR content LIKE '%data:audio%'
   ORDER BY id
`).all().filter(p => hasInlineDataMedia(p.content));

const galleryByPost = new Map();
if (allPosts.length) {
  const ids = allPosts.map(p => p.id);
  const rows = db.prepare(`
    SELECT id, source_post_id, image_url, type, approval_status, deleted_at
      FROM student_gallery
     WHERE deleted_at IS NULL AND source_post_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  for (const r of rows) galleryByPost.set(r.source_post_id, r);
}

const targets = allPosts.filter(p => (ONLY_GALLERY ? galleryByPost.has(p.id) : true));
const skippedUnlinked = allPosts.length - targets.length;

console.log(`DB: ${DB_PATH}`);
console.log(`모드: ${APPLY ? '★ APPLY (실제 반영)' : 'DRY-RUN (무변형 · 파일도 쓰지 않음)'}`);
console.log(`범위: ${ONLY_GALLERY ? '나도예술가 연결 글만' : '본문에 data: 미디어가 있는 모든 글'}`);
console.log(`\n=== 본문에 data: 미디어가 있는 게시글: ${allPosts.length}건 ` +
  `(나도예술가 연결 ${galleryByPost.size}건${skippedUnlinked ? ` · 범위 밖 ${skippedUnlinked}건` : ''}) ===`);

// ── 2) 변환 계획 수립 (DRY-RUN 은 파일을 쓰지 않는다) ────────────────────────
const plans = [];
const failures = [];
for (const p of targets) {
  const g = galleryByPost.get(p.id) || null;
  let out;
  try {
    out = materializeDataUrls(p.content, { queryType: 'board', dryRun: !APPLY });
  } catch (e) {
    failures.push({ post: p.id, title: p.title, code: e.code || 'ERR', message: e.message });
    console.log(`  ✖ post=${p.id} "${String(p.title).slice(0, 24)}" 변환 실패 [${e.code || 'ERR'}] ${e.message}`);
    continue;
  }
  if (!out.changed) continue;

  const atts = g
    ? db.prepare('SELECT id, gallery_id, type, url, mime, file_name, file_size, sort_order FROM gallery_attachments WHERE gallery_id = ? ORDER BY id').all(g.id)
    : [];
  const usableAtt = atts.filter(a => !isPlaceholderUrl(a.url) && !/^data:/i.test(a.url)).length;
  const needCover = !!g && coverUnusable(g.image_url);
  const needAtts = !!g && usableAtt === 0;

  plans.push({ post: p, gallery: g, out, atts, needCover, needAtts });

  console.log(
    `  post=${p.id} "${String(p.title).slice(0, 20)}" 본문 ${kb(String(p.content).length)} → ${kb(out.content.length)} ` +
    `· 파일 ${out.files.length}건 [${out.files.map(f => `${f.kind}/${kb(f.size)}`).join(', ')}]\n` +
    `      gallery=${g ? g.id : '-'}${g ? ` cover=${needCover ? '교체' : '유지'}(${String(g.image_url).slice(0, 40)})` +
      ` att=${atts.length}건(쓸수있음 ${usableAtt}) ${needAtts ? '→ 다시채움' : '→ 유지'}` : ' (연결 없음 — 본문만 정리)'}`
  );
}

if (failures.length) {
  console.log(`\n⚠ 변환 실패 ${failures.length}건 — 이 글은 건드리지 않는다(원본 보존):`);
  for (const f of failures) console.log(`   post=${f.post} [${f.code}] ${f.message}`);
}

if (!plans.length) {
  console.log('\n대상 0건 — 아무것도 하지 않는다. (이미 복구됐거나 base64 글이 없다)');
  db.close();
  process.exit(0);
}

// ── 3) 롤백 SQL 선기록 ───────────────────────────────────────────────────────
const rollback = [
  '-- 롤백 SQL — scripts/recover-base64-gallery-images.js --apply 되돌리기',
  `-- 생성 ${new Date().toISOString()}  DB=${DB_PATH}`,
  '-- ⚠ 되돌리면 본문은 다시 base64 가 되고 나도예술가 표지는 다시 빈 이미지가 된다.',
  '--   변환으로 만들어진 /uploads/... 파일은 이 SQL 이 지우지 않는다(고아 파일로 남음).',
  'BEGIN;',
];
for (const pl of plans) {
  rollback.push(`UPDATE posts SET content = ${sq(pl.post.content)} WHERE id = ${pl.post.id};`);
  if (pl.post.image_url == null || pl.post.image_url === '') {
    rollback.push(`UPDATE posts SET image_url = ${sq(pl.post.image_url)} WHERE id = ${pl.post.id};`);
  }
  if (pl.gallery && pl.needCover) {
    rollback.push(`UPDATE student_gallery SET image_url = ${sq(pl.gallery.image_url)}, type = ${sq(pl.gallery.type)} WHERE id = ${pl.gallery.id};`);
  }
  if (pl.gallery && pl.needAtts) {
    rollback.push(`DELETE FROM gallery_attachments WHERE gallery_id = ${pl.gallery.id};`);
    for (const a of pl.atts) {
      rollback.push(
        `INSERT INTO gallery_attachments (id, gallery_id, type, url, mime, file_name, file_size, sort_order) VALUES ` +
        `(${a.id}, ${a.gallery_id}, ${sq(a.type)}, ${sq(a.url)}, ${sq(a.mime)}, ${sq(a.file_name)}, ` +
        `${a.file_size == null ? 'NULL' : a.file_size}, ${a.sort_order == null ? 0 : a.sort_order});`
      );
    }
  }
}
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

// ── 4) 반영 ──────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`\nDRY-RUN 종료 — 반영하려면 --apply 를 붙일 것. ` +
    `(대상: 게시글 ${plans.length}건 / 표지 교체 ${plans.filter(p => p.needCover).length}건 / ` +
    `첨부 재구성 ${plans.filter(p => p.needAtts).length}건)`);
  db.close();
  process.exit(0);
}

const insAtt = db.prepare(`
  INSERT INTO gallery_attachments (gallery_id, type, url, mime, file_name, file_size, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const tx = db.transaction(() => {
  const stat = { posts: 0, covers: 0, attRows: 0, coverFilled: 0 };
  for (const pl of plans) {
    db.prepare('UPDATE posts SET content = ? WHERE id = ?').run(pl.out.content, pl.post.id);
    stat.posts++;
    // 게시글 대표 이미지가 비어 있으면 변환된 첫 이미지로 채운다(게시판 목록 썸네일 안정화)
    if ((pl.post.image_url == null || pl.post.image_url === '') && pl.out.firstImageUrl) {
      db.prepare('UPDATE posts SET image_url = ? WHERE id = ?').run(pl.out.firstImageUrl, pl.post.id);
      stat.coverFilled++;
    }
    if (!pl.gallery) continue;

    const fixedPost = { ...pl.post, content: pl.out.content, image_url: pl.post.image_url || pl.out.firstImageUrl || null };
    const media = extractPostMedia(fixedPost);

    if (pl.needCover && pl.out.firstImageUrl) {
      const type = media.length && media.every(a => a.type === 'image') ? 'image' : (pl.gallery.type || 'image');
      db.prepare('UPDATE student_gallery SET image_url = ?, type = ? WHERE id = ?')
        .run(pl.out.firstImageUrl, type, pl.gallery.id);
      stat.covers++;
    }
    if (pl.needAtts && media.length) {
      db.prepare('DELETE FROM gallery_attachments WHERE gallery_id = ?').run(pl.gallery.id);
      media.forEach((a, i) => {
        insAtt.run(pl.gallery.id, a.type, String(a.url).slice(0, 1000),
          a.mime ? String(a.mime).slice(0, 100) : null,
          a.file_name ? String(a.file_name).slice(0, 200) : null, null,
          a.sort_order != null ? a.sort_order : i);
        stat.attRows++;
      });
    }
  }
  return stat;
});
const done = tx();
console.log(`\n반영 완료 — 게시글 본문 ${done.posts}건 · 게시글 대표이미지 ${done.coverFilled}건 · ` +
  `나도예술가 표지 ${done.covers}건 · 첨부 ${done.attRows}행`);

// ── 5) 사후 검증 ─────────────────────────────────────────────────────────────
const leftPosts = db.prepare(`
  SELECT id, title FROM posts
   WHERE content LIKE '%data:image%' OR content LIKE '%data:video%' OR content LIKE '%data:audio%'
`).all().filter(p => hasInlineDataMedia(p.content));
console.log(`사후 검증 — 본문에 data: 미디어가 남은 글: ${leftPosts.length}건` +
  (leftPosts.length ? ` [${leftPosts.map(p => p.id).join(',')}]` : ''));

for (const pl of plans) {
  if (!pl.gallery) continue;
  const g = db.prepare('SELECT id, image_url, type FROM student_gallery WHERE id = ?').get(pl.gallery.id);
  const ok = g && !coverUnusable(g.image_url);
  const abs = g && !coverUnusable(g.image_url)
    ? fs.existsSync(path.join(__dirname, '..', 'public', g.image_url.replace(/^\//, '')))
    : false;
  console.log(`  gallery=${pl.gallery.id} cover=${ok ? 'OK' : '여전히 못 씀'} 파일존재=${abs ? 'Y' : 'N'} url=${g ? String(g.image_url).slice(0, 60) : '-'}`);
}
console.log('\n★ 이 스크립트를 --apply 로 돌렸으므로 `npm test` 전건을 다시 돌릴 것.');
db.close();
