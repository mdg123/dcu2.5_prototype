// db/board-gallery.js
// ─────────────────────────────────────────────────────────────────────────────
// 채움클래스 게시판 게시글 → 나도예술가(student_gallery + gallery_attachments) 연동의 **쓰기부**.
//
// 확정 사양(사용자, 2026-08-20):
//   "갤러리 게시판 생성 시 나도예술가에 업로드할지도 설정하고, 그렇게 세팅하면
//    게시물 승인을 클래스 개설자가 하면 그 게시물의 이미지 및 동영상, 음원 등이
//    나도예술가로 연결되어 표시"
//
//   게시판 생성 → [나도예술가 연결] 설정(게시판 단위, class_boards.share_to_gallery)
//                        ↓ (켜져 있으면)
//   학생이 게시물 업로드 → 개설자 승인 → 나도예술가에 표시 (이미지·동영상·음원 전부)
//
// 이전 구현이 틀렸던 지점:
//   · 연동 여부가 글 단위 체크박스라 게시판 단위로 끌 수 없었다  → shouldLinkPostToGallery(board)
//   · `image_url` 하나만 넘겨 동영상·음원이 누락되고, 본문 에디터에 넣은 이미지는
//     placeholder 로 대체돼 "빈 이미지"가 됐다                    → extractPostMedia(post) 전부 수집
//
// 승인 주체(클래스 개설자)는 정상 동작이므로 건드리지 않는다 — 여기서는 승인 "이후"만 다룬다.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./index');
const {
  extractPostMedia,
  extractPostBodyText,
  shouldLinkPostToGallery,
} = require('../lib/board-gallery-link');

// 나도예술가 카테고리 화이트리스트 (public/plus/gallery.html 의 칩과 동일)
const GALLERY_CATEGORIES = new Set(['art', 'music', 'writing', 'video', 'other']);

function normCategory(c) {
  const v = String(c || '').toLowerCase();
  return GALLERY_CATEGORIES.has(v) ? v : 'art';
}

/**
 * 첨부 목록으로부터 student_gallery.type(대표 타입)을 정한다.
 * db/growth.js createGalleryItemWithAttachments 의 규약과 동일하게 맞춘다.
 */
function primaryTypeOf(attachments, hasBody) {
  if (!attachments.length) return hasBody ? 'writing' : 'image';
  if (attachments.length === 1) {
    const t = attachments[0].type;
    return t === 'youtube' ? 'video' : t;
  }
  if (attachments.every(a => a.type === 'image')) return 'image';
  if (attachments.every(a => a.type === 'video' || a.type === 'youtube')) return 'video';
  if (attachments.every(a => a.type === 'audio')) return 'audio';
  return 'mixed';
}

/** 대표 이미지 = 첫 image 첨부 (public/plus/gallery.html:2546 이 쓰는 규약). */
function coverImageOf(attachments) {
  const firstImg = attachments.find(a => a.type === 'image');
  // student_gallery.image_url 은 NOT NULL 이므로 빈 문자열을 쓴다.
  //   → gallery.html 카드/리스트가 `item.image_url ? <img> : <span class="no-image">이모지`
  //     로 분기하므로, 없는 파일(/images/placeholder.png)을 넣는 것보다 훨씬 낫다.
  //     "빈 이미지" 로 보이던 것이 바로 그 없는 placeholder 였다.
  return firstImg ? firstImg.url : '';
}

/** gallery_attachments 를 통째로 다시 채운다(같은 트랜잭션 안에서 호출). */
function _replaceAttachments(galleryId, attachments) {
  db.prepare('DELETE FROM gallery_attachments WHERE gallery_id = ?').run(galleryId);
  if (!attachments.length) return;
  const ins = db.prepare(`
    INSERT INTO gallery_attachments (gallery_id, type, url, mime, file_name, file_size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  attachments.forEach((a, idx) => {
    ins.run(galleryId, a.type, String(a.url).slice(0, 1000),
      a.mime ? String(a.mime).slice(0, 100) : null,
      a.file_name ? String(a.file_name).slice(0, 200) : null,
      null,
      a.sort_order != null ? a.sort_order : idx);
  });
}

/**
 * 게시글 하나를 나도예술가 작품 1건으로 환산한다(DB 미접촉, 순수 계산).
 * @returns {{attachments:Array, bodyText:string, imageUrl:string, type:string, linkable:boolean}}
 */
function describePostAsArtwork(post) {
  const attachments = extractPostMedia(post);
  const bodyText = extractPostBodyText(post);
  const hasBody = !!bodyText.trim();
  // 글 한 벌을 **description 과 body_text 중 한 곳에만** 넣는다(상호배타).
  //   미디어가 있으면 글은 "소개문", 미디어가 없으면 글 자체가 "작품 본문" 이다.
  //   둘 다 채우면 상세 모달에서 같은 글이 두 번 보인다 (감리 R2).
  const isWritingOnly = attachments.length === 0;
  return {
    attachments,
    bodyText,
    descriptionText: (!isWritingOnly && hasBody) ? bodyText : null,
    bodyTextField: (isWritingOnly && hasBody) ? bodyText : null,
    imageUrl: coverImageOf(attachments),
    type: primaryTypeOf(attachments, hasBody),
    // 미디어도 글도 없으면 갤러리에 올릴 내용이 없다 → 연동 자체를 건너뛴다.
    //   (지금까지는 존재하지 않는 placeholder.png 로 빈 카드를 만들고 있었다.)
    linkable: attachments.length > 0 || hasBody,
  };
}

/**
 * 게시글로부터 student_gallery 행을 새로 만든다.
 * @param {object} post posts 행 (id, author_id, title, content, image_url)
 * @param {{category?:string, approvalStatus?:string, approvedBy?:number}} opts
 * @returns {{id:number, attachmentCount:number}|null} 올릴 내용이 없으면 null
 */
function createGalleryFromPost(post, opts = {}) {
  const art = describePostAsArtwork(post);
  if (!art.linkable) return null;

  const status = opts.approvalStatus === 'approved' ? 'approved' : 'pending';
  const category = normCategory(opts.category);

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO student_gallery
        (student_id, title, description, image_url, category, approval_status,
         source_post_id, source, body_text, type, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'board', ?, ?, ?, ?)
    `).run(
      post.author_id,
      post.title,
      // description(소개문) 과 body_text("작품 본문" 블록) 는 **상호배타**다.
      //   둘 다 같은 글로 채우면 나도예술가 상세 모달에 본문이 두 번 보인다(감리 R2 실측).
      //   · 미디어가 있는 작품  → 글은 소개문(description)으로만
      //   · 미디어 없는 글 작품 → 글은 작품 본문(body_text)으로만
      art.descriptionText,
      art.imageUrl,
      category,
      status,
      post.id,
      art.bodyTextField,
      art.type,
      status === 'approved' ? (opts.approvedBy || null) : null,
      status === 'approved' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
    );
    const gid = info.lastInsertRowid;
    _replaceAttachments(gid, art.attachments);
    return gid;
  });

  const id = tx();
  return { id, attachmentCount: art.attachments.length };
}

/**
 * 게시글 작성 시점의 연동. 게시판 설정이 켜져 있을 때만 pending 행을 만든다.
 * @param {object} post
 * @param {object|null} board class_boards 행 (board_id 없는 레거시 글은 null)
 * @param {{category?:string}} opts
 */
function syncOnPostCreate(post, board, opts = {}) {
  if (!post || !shouldLinkPostToGallery(board)) return null;
  return createGalleryFromPost(post, { category: opts.category, approvalStatus: 'pending' });
}

/**
 * 개설자 승인 시점의 연동.
 *   · 이미 행이 있으면 approved 로 전환. 첨부가 비어 있으면(레거시·생성 실패분) 이때 채운다.
 *   · 행이 없고 게시판 설정이 켜져 있으면 approved 상태로 새로 만든다(누락 보정).
 * @param {object} post
 * @param {object|null} board
 * @param {number} approverId
 */
function syncOnPostApprove(post, board, approverId) {
  if (!post) return null;
  const existing = db.prepare(
    'SELECT id, image_url FROM student_gallery WHERE source_post_id = ? AND deleted_at IS NULL'
  ).get(post.id);

  if (existing) {
    const art = describePostAsArtwork(post);
    const attCount = db.prepare('SELECT COUNT(*) AS c FROM gallery_attachments WHERE gallery_id = ?')
      .get(existing.id).c;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE student_gallery
           SET approval_status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(approverId, existing.id);
      // 첨부가 아예 없을 때만 다시 채운다 — 학생이 나도예술가에서 직접 손본 작품은 덮지 않는다.
      if (attCount === 0 && art.attachments.length > 0) {
        _replaceAttachments(existing.id, art.attachments);
        db.prepare('UPDATE student_gallery SET image_url = ?, type = ? WHERE id = ?')
          .run(art.imageUrl, art.type, existing.id);
      }
    });
    tx();
    return { id: existing.id, created: false };
  }

  if (!shouldLinkPostToGallery(board)) return null;
  const created = createGalleryFromPost(post, { approvalStatus: 'approved', approvedBy: approverId });
  return created ? { id: created.id, created: true } : null;
}

/** 개설자 반려 시점 — 연결된 작품도 함께 반려. */
function syncOnPostReject(post, reason) {
  if (!post) return 0;
  const upd = db.prepare(
    "UPDATE student_gallery SET approval_status = 'rejected', reject_reason = ? WHERE source_post_id = ?"
  ).run(reason != null ? String(reason).slice(0, 500) : null, post.id);
  return upd.changes;
}

module.exports = {
  describePostAsArtwork,
  createGalleryFromPost,
  syncOnPostCreate,
  syncOnPostApprove,
  syncOnPostReject,
  normCategory,
  primaryTypeOf,
  coverImageOf,
};
