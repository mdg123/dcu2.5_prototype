/* public/js/media-kind.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 첨부 URL → 미디어 종류(이미지·동영상·음원·유튜브) 판정의 **단일 정본(SSOT)**.
 *
 * 왜 한 벌만 두는가 (2026-08-20 감리 REWORK R1):
 *   게시판 첨부 accept 를 mp4·mp3·wav 로 넓히면서 `post.image_url` 에 비이미지가
 *   들어갈 수 있게 됐는데, 그것을 `<img>` 로 그리는 지점이 4곳(목록·카드·상세·승인대기)이었다.
 *   판정을 각 지점에 손으로 베껴 넣은 결과 **2곳만 고쳐지고 2곳이 남아** 깨진 이미지가 노출됐다.
 *   ("정본 옆에 판정 사본" — 이 프로젝트의 반복 결함)
 *   → 이제 판정은 이 파일에만 있다. 브라우저(FE)와 Node(BE) 가 **같은 파일**을 쓴다.
 *
 * 사용처
 *   · 브라우저: <script src="/js/media-kind.js"> → window.DacheumMedia
 *       - public/class/class-home.html  (게시판 목록·카드·상세·승인대기 4곳)
 *       - public/plus/gallery.html      (나도예술가 카드/리스트 썸네일)
 *   · Node:    require('../public/js/media-kind')
 *       - lib/board-gallery-link.js (extractPostMedia 의 타입·mime 판정)
 *
 * ⚠ 확장자 목록·유튜브 정규식·placeholder 규칙을 여기 밖에서 다시 쓰지 말 것.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.DacheumMedia = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // db/growth.js gallery_attachments 의 CHECK 제약과 동일해야 한다.
  var ALLOWED_TYPES = ['image', 'video', 'audio', 'youtube'];

  var EXT_MIME = {
    // image
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
    // video
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', m4v: 'video/x-m4v',
    // audio
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm'
  };

  var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
  var VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'mov', 'm4v'];
  var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'weba'];

  var YOUTUBE_RE = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i;

  // 실제로 존재하지 않는 자리표시자 이미지 — 사용자가 "빈 이미지"라 지목한 바로 그것.
  //   /images/placeholder.png · /images/placeholder-art.png · /uploads/placeholder.jpg
  //   셋 다 서버에 파일이 없다(public/images 디렉터리 자체가 없음).
  //   → 미디어 "없음" 으로 취급해 이모지 폴백이 뜨게 한다.
  var PLACEHOLDER_RE = /(^|\/)placeholder(-[a-z0-9]+)?\.(png|jpe?g|gif|webp)(\?|#|$)/i;

  function has(arr, v) { for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true; return false; }

  /** URL 에서 확장자(소문자). 쿼리·해시 제거. data: URI 는 null. */
  function extOf(url) {
    var s = String(url == null ? '' : url);
    if (/^data:/i.test(s)) return null;
    var clean = s.split('#')[0].split('?')[0];
    var m = clean.match(/\.([A-Za-z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : null;
  }

  /** 확장자·data URI 로 mime 추정. 모르면 null. */
  function guessMime(url) {
    var s = String(url == null ? '' : url);
    var dm = s.match(/^data:([^;,]+)[;,]/i);
    if (dm) return dm[1].toLowerCase();
    var ext = extOf(s);
    return (ext && EXT_MIME[ext]) || null;
  }

  /** URL 파일명. 없으면 null. */
  function fileNameOf(url) {
    var s = String(url == null ? '' : url);
    if (/^data:/i.test(s)) return null;
    var clean = s.split('#')[0].split('?')[0];
    var m = clean.match(/\/([^/]+)$/);
    if (!m || !m[1]) return null;
    try { return decodeURIComponent(m[1]).slice(0, 200); } catch (e) { return m[1].slice(0, 200); }
  }

  /** 존재하지 않는 자리표시자인가 — "미디어 없음" 으로 취급한다. */
  function isPlaceholderUrl(url) {
    return PLACEHOLDER_RE.test(String(url == null ? '' : url).trim());
  }

  /**
   * URL(+태그 힌트) → 미디어 종류.
   * @param {string} url
   * @param {'image'|'video'|'audio'|null} [hint] 태그에서 온 힌트(<video> 안의 <source> 등)
   * @returns {'image'|'video'|'audio'|'youtube'|null}  판정 불가·자리표시자는 null
   */
  function mediaKindOf(url, hint) {
    var s = String(url == null ? '' : url).trim();
    if (!s) return null;
    if (isPlaceholderUrl(s)) return null;          // 없는 파일 → 미디어 없음
    if (YOUTUBE_RE.test(s)) return 'youtube';
    var ext = extOf(s);
    if (ext) {
      if (has(IMAGE_EXTS, ext)) return 'image';
      if (has(VIDEO_EXTS, ext)) return 'video';
      if (has(AUDIO_EXTS, ext)) return 'audio';
    }
    var dm = s.match(/^data:([a-z]+)\//i);
    if (dm) {
      var kind = dm[1].toLowerCase();
      if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
    }
    // 확장자로 못 가리면 태그 힌트를 따른다 (예: /api/file/123 형태의 <img src>)
    if (hint && has(ALLOWED_TYPES, hint)) return hint;
    return null;
  }

  /** 이미지로 그려도 안전한 URL 만 통과. 아니면 null → 호출부는 아이콘/이모지 폴백. */
  function asImageUrl(url) {
    return mediaKindOf(url) === 'image' ? String(url).trim() : null;
  }

  // 종류별 표시 메타 — 아이콘·라벨·이모지를 화면마다 다르게 쓰지 않도록 여기서 고정한다.
  var KIND_META = {
    image: { icon: 'fa-image', label: '이미지', emoji: '🖼️' },
    video: { icon: 'fa-video', label: '동영상', emoji: '🎬' },
    youtube: { icon: 'fa-video', label: '동영상', emoji: '🎬' },
    audio: { icon: 'fa-music', label: '음원', emoji: '🎵' }
  };

  /** 종류 메타. 모르는 종류는 null. */
  function kindMeta(kind) {
    return KIND_META[kind] || null;
  }

  /**
   * "이미지가 아닌 미디어"의 표시 메타. 이미지·판정불가는 null.
   * 목록/카드/상세/승인대기 네 곳이 전부 이것으로 아이콘·라벨을 얻는다.
   */
  function nonImageKindMeta(url) {
    var k = mediaKindOf(url);
    if (!k || k === 'image') return null;
    return kindMeta(k);
  }

  return {
    ALLOWED_TYPES: ALLOWED_TYPES,
    EXT_MIME: EXT_MIME,
    IMAGE_EXTS: IMAGE_EXTS,
    VIDEO_EXTS: VIDEO_EXTS,
    AUDIO_EXTS: AUDIO_EXTS,
    YOUTUBE_RE: YOUTUBE_RE,
    extOf: extOf,
    guessMime: guessMime,
    fileNameOf: fileNameOf,
    isPlaceholderUrl: isPlaceholderUrl,
    mediaKindOf: mediaKindOf,
    asImageUrl: asImageUrl,
    kindMeta: kindMeta,
    nonImageKindMeta: nonImageKindMeta
  };
});
