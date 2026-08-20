// lib/board-gallery-link.js
// ─────────────────────────────────────────────────────────────────────────────
// 채움클래스 게시판 → 나도예술가 연동의 **순수 판단부**.
//
// 배경(사용자 지적 2026-08-20):
//   "왜 채움클래스에서 게시판 갤러리로 이미지를 올렸는데 나도예술가에는 빈 이미지로만 나오는지"
//
// 원인은 두 갈래였다.
//   ① 연동 여부가 "글 단위 체크박스 || category==='gallery'" 라 **끌 수가 없었다**.
//   ② 게시판에서 이미지를 넣는 길은 둘(파일 선택 / 본문 에디터)인데
//      연동은 `post.image_url`(파일 선택) **하나만** 봤다.
//      목록 썸네일은 `image_url || 본문 첫 <img>` 로 둘 다 보므로,
//      본문에 넣은 글은 **게시판에서는 정상, 나도예술가에서는 placeholder** 가 됐다.
//
// 이 모듈이 정하는 것:
//   · shouldLinkPostToGallery(board)  — 연동 여부는 **게시판 설정이 유일한 기준**
//   · extractPostMedia(post)          — image_url + 본문의 img/video/audio/source/iframe 을 **전부** 수집
//   · extractPostBodyText(post)       — 미디어가 하나도 없을 때 쓸 글 본문(태그 제거)
//
// DB 접근은 하지 않는다(테스트 용이성). 실제 INSERT 는 db/board-gallery.js 담당.
// ─────────────────────────────────────────────────────────────────────────────

// ★ 미디어 종류 판정은 **public/js/media-kind.js 한 곳**에만 둔다(SSOT).
//   브라우저(class-home.html·gallery.html)와 이 모듈이 같은 파일을 쓴다.
//   2026-08-20 감리 R1: 판정을 화면마다 베껴 쓴 탓에 4곳 중 2곳만 고쳐져
//   게시글 상세에 깨진 <img> 가 남았다. 여기서 다시 정의하지 말 것.
const MediaKind = require('../public/js/media-kind');
const { mediaKindOf: classifyUrl, guessMime, fileNameOf, isPlaceholderUrl } = MediaKind;

// db/growth.js 의 gallery_attachments CHECK 제약과 동일해야 한다.
const ALLOWED_TYPES = new Set(MediaKind.ALLOWED_TYPES);
// db/growth.js createGalleryItemWithAttachments 의 첨부 상한과 동일.
const MAX_ATTACHMENTS = 10;

/**
 * HTML 안의 미디어 URL 을 **문서 순서대로 전부** 뽑는다.
 * 대상: <img src> · <video src> · <audio src> · <source src> · <iframe src>(YouTube)
 *
 * ⚠ 첫 개만 보던 것이 이 기능의 버그였다 — 여기서는 반드시 전부 수집한다.
 * @param {string} html
 * @returns {Array<{url:string, hint:string|null}>}
 */
function scanHtmlMedia(html) {
  const s = String(html || '');
  if (!s) return [];
  const out = [];
  // 태그명 + src 속성을 한 번에 훑어 문서 순서를 보존한다.
  const TAG_RE = /<\s*(img|video|audio|source|iframe|embed)\b([^>]*)>/gi;
  let m;
  while ((m = TAG_RE.exec(s)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const srcM = attrs.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!srcM) continue;
    const url = (srcM[2] != null ? srcM[2] : srcM[3] != null ? srcM[3] : srcM[4] || '').trim();
    if (!url) continue;
    // <source type="video/mp4"> 처럼 타입이 명시돼 있으면 그것을 힌트로 쓴다.
    const typeM = attrs.match(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const declaredType = typeM ? (typeM[2] || typeM[3] || typeM[4] || '') : '';
    let hint = null;
    if (/^image\//i.test(declaredType)) hint = 'image';
    else if (/^video\//i.test(declaredType)) hint = 'video';
    else if (/^audio\//i.test(declaredType)) hint = 'audio';
    else if (tag === 'img') hint = 'image';
    else if (tag === 'video') hint = 'video';
    else if (tag === 'audio') hint = 'audio';
    // <source> 는 부모(video/audio)를 모르므로 힌트 없이 URL 로 판정 (확장자·type 으로 충분)
    // <iframe>/<embed> 는 YouTube 만 인정 (classifyUrl 이 걸러낸다)
    out.push({ url, hint });
  }
  return out;
}

/** URL 정규화 — 중복 판정용. 앞뒤 공백·트레일링 슬래시 제거, 프로토콜 무시하지 않음(안전). */
function normUrl(url) {
  return String(url || '').trim();
}

/**
 * 게시글에서 나도예술가로 넘길 첨부 목록을 만든다.
 *
 * 수집 순서(= sort_order):
 *   1) post.image_url  — 파일 선택/촬영 업로드분. 있으면 항상 첫 번째(대표 이미지 규약).
 *   2) post.content    — 본문 에디터에 삽입된 img/video/audio/source/iframe 을 문서 순서대로.
 *
 * @param {{image_url?:string, content?:string}} post
 * @returns {Array<{type:string,url:string,mime:string|null,file_name:string|null,sort_order:number}>}
 */
function extractPostMedia(post) {
  const p = post || {};
  const seen = new Set();
  const picked = [];

  const push = (rawUrl, hint) => {
    const url = normUrl(rawUrl);
    if (!url) return;
    // 존재하지 않는 자리표시자는 "미디어 없음"으로 취급한다 (이것이 사용자가 본 '빈 이미지').
    //   판정은 SSOT(media-kind.js) — classifyUrl 도 자리표시자면 null 을 돌려주지만,
    //   의도를 코드에 남기기 위해 여기서도 먼저 건너뛴다.
    if (isPlaceholderUrl(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    const type = classifyUrl(url, hint);
    if (!type || !ALLOWED_TYPES.has(type)) return;
    seen.add(key);
    picked.push({
      type,
      url: url.slice(0, 1000),
      mime: guessMime(url),
      file_name: fileNameOf(url),
      sort_order: picked.length,
    });
  };

  if (p.image_url) push(p.image_url, 'image');
  for (const { url, hint } of scanHtmlMedia(p.content)) push(url, hint);

  return picked.slice(0, MAX_ATTACHMENTS);
}

/**
 * 본문 HTML 에서 순수 텍스트를 뽑는다(미디어가 하나도 없는 글을 "글 작품"으로 올릴 때 사용).
 * @param {{content?:string}} post
 * @param {number} maxLen db/growth.js body_text 상한과 맞춘다.
 */
function extractPostBodyText(post, maxLen = 1000) {
  const raw = String((post && post.content) || '');
  if (!raw) return '';
  const text = raw
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, maxLen);
}

/**
 * 이 게시글을 나도예술가에 연동할 것인가 — **게시판 설정이 유일한 기준**.
 *
 * 이전 규칙(`shareToGallery === true || category === 'gallery'`)은
 *   · 글 단위라 게시판 단위 설정이 아니었고
 *   · 갤러리 게시판이면 무조건 켜져 끄는 방법이 없었다.
 * 이제 글 단위 체크박스는 폐지하고, board.share_to_gallery 만 본다.
 *
 * board_id 가 없는 레거시 글(board=null)은 **연동하지 않는다** —
 * 어느 게시판 설정을 따라야 할지 알 수 없으므로 추측하지 않는다.
 *
 * @param {{share_to_gallery?:number, board_type?:string}|null} board
 */
function shouldLinkPostToGallery(board) {
  if (!board) return false;
  return Number(board.share_to_gallery) === 1;
}

module.exports = {
  ALLOWED_TYPES,
  MAX_ATTACHMENTS,
  MediaKind,          // SSOT 재노출 — 테스트·다른 BE 모듈이 같은 판정을 쓰게
  isPlaceholderUrl,
  classifyUrl,
  guessMime,
  scanHtmlMedia,
  extractPostMedia,
  extractPostBodyText,
  shouldLinkPostToGallery,
};
