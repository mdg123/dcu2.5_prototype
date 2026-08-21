// lib/upload-rules.js
// ─────────────────────────────────────────────────────────────────────────────
// 파일 업로드 **규칙의 단일 정본(SSOT)** — 저장 위치·파일명·허용 목록·용량 상한.
//
// 왜 뽑아냈는가 (2026-08-21)
//   게시글 본문에 붙여넣기로 들어온 `data:image/...;base64,...` 를 실제 파일로 바꾸는
//   경로(lib/inline-data-media.js)가 새로 생겼다. 그 경로가 자기만의 저장 위치·파일명·
//   허용 목록·용량 상한을 새로 적으면 **업로드 규칙이 두 벌**이 되고,
//   그때부터 `data:` 는 "검사를 건너뛰는 뒷문"이 된다.
//   → 규칙은 여기 한 벌. routes/upload.js(multer) 와 data: 변환기가 **같은 상수·같은 함수**를 쓴다.
//
// ⚠ 확장자 허용 목록·용량 상한·하위 폴더 규칙을 이 파일 밖에서 다시 쓰지 말 것.
//   (미디어 "종류" 판정은 public/js/media-kind.js 가 정본 — 역할이 다르다.
//    여기는 "받아줄 것인가/어디에 어떤 이름으로 둘 것인가", 거기는 "이게 무슨 미디어인가")
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');

const MediaKind = require('../public/js/media-kind');

/** 업로드 루트 — public/uploads (정적 서빙 경로 /uploads/…) */
const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

/** 허용 확장자 — multer fileFilter 와 **같은 정규식 한 벌**. */
const ALLOWED_EXT_RE = /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|ppt|pptx|hwp|hwpx|txt|zip|mp4|mp3|wav)$/i;

/** 파일 1개 용량 상한 — 50MB. multer limits.fileSize 와 동일 값. */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** 사용자에게 보여줄 한국어 메시지 — 업로드 API 응답과 문구를 맞춘다. */
const MSG_BAD_TYPE = '허용되지 않는 파일 형식입니다.';
const MSG_TOO_LARGE = '파일 크기가 50MB를 초과합니다.';

/** MIME → 하위 폴더. (mime 을 모르면 queryType, 그것도 없으면 general) */
function getSubDir(mimeType, queryType) {
  if (mimeType) {
    if (mimeType.startsWith('video/')) return 'videos';
    if (mimeType.startsWith('image/')) return 'images';
    if (mimeType.startsWith('audio/')) return 'audios';
    if (mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.includes('hwp') ||
        mimeType.includes('presentation') || mimeType.includes('spreadsheet') || mimeType.includes('text/')) return 'documents';
  }
  return queryType || 'general';
}

/** 저장 파일명 — multer storage.filename 과 동일 규칙. */
function makeFilename(originalName) {
  const ext = path.extname(originalName || '');
  const basename = path.basename(originalName || '', ext).replace(/[^a-zA-Z0-9가-힣_-]/g, '_') || 'file';
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
  return `${basename}-${uniqueSuffix}${ext}`;
}

/** 확장자 허용 여부 — 파일명 기준(multer fileFilter 와 동일 판정). */
function isAllowedFileName(originalName) {
  return ALLOWED_EXT_RE.test(path.extname(String(originalName || '')));
}

/**
 * MIME → 확장자. 표는 media-kind.js(SSOT) 의 EXT_MIME 을 뒤집어 쓴다 — 손으로 다시 적지 않는다.
 * @returns {string|null} 점 없는 소문자 확장자. 모르는 mime 은 null.
 */
const MIME_EXT = (() => {
  const m = Object.create(null);
  for (const [ext, mime] of Object.entries(MediaKind.EXT_MIME)) {
    if (!(mime in m)) m[mime] = ext;   // 먼저 나온 것을 대표로 (jpeg → jpg)
  }
  return m;
})();
function extForMime(mime) {
  const key = String(mime || '').toLowerCase().split(';')[0].trim();
  return MIME_EXT[key] || null;
}

/** 업로드 하위 디렉터리를 만들고 절대 경로를 돌려준다. */
function ensureSubDir(subDir) {
  const dir = path.join(UPLOAD_ROOT, subDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 버퍼를 업로드 규칙(위치·이름·허용·용량) 그대로 파일로 저장한다.
 * multer 를 거치지 않는 경로(본문 data: URL 변환 등)가 **검사를 건너뛰지 않도록** 하는 관문.
 *
 * @param {Buffer} buffer
 * @param {{originalName:string, mime?:string|null, queryType?:string|null, dryRun?:boolean}} opts
 *        dryRun: 검사는 그대로 하되 파일을 쓰지 않는다(복구 스크립트 DRY-RUN 용).
 *                검사를 건너뛰는 모드가 아니다 — 통과/탈락 판정은 동일하다.
 * @returns {{url:string, fileName:string, size:number, mimetype:string|null, absPath:string, written:boolean}}
 * @throws {Error & {code:'BAD_TYPE'|'TOO_LARGE'}}
 */
function saveBuffer(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const originalName = String(opts.originalName || '');
  if (!isAllowedFileName(originalName)) {
    const e = new Error(MSG_BAD_TYPE); e.code = 'BAD_TYPE'; throw e;
  }
  if (buf.length > MAX_FILE_SIZE) {
    const e = new Error(MSG_TOO_LARGE); e.code = 'TOO_LARGE'; throw e;
  }
  const subDir = getSubDir(opts.mime || null, opts.queryType || null);
  const dir = opts.dryRun ? path.join(UPLOAD_ROOT, subDir) : ensureSubDir(subDir);
  // 이름 충돌 방지 — makeFilename 은 (같은 ms + 1/1만 난수) 로 겹칠 수 있다.
  //   글 하나에서 이미지 여러 장을 연달아 저장하는 경로(본문 data: 변환)가 새로 생겼으므로
  //   겹치면 앞 이미지가 조용히 덮인다. 존재하면 다시 뽑는다.
  let fileName = makeFilename(originalName);
  for (let i = 0; i < 5 && fs.existsSync(path.join(dir, fileName)); i++) {
    fileName = makeFilename(originalName);
  }
  const absPath = path.join(dir, fileName);
  if (!opts.dryRun) fs.writeFileSync(absPath, buf);
  return {
    url: `/uploads/${subDir}/${fileName}`,
    fileName,
    size: buf.length,
    mimetype: opts.mime || null,
    absPath,
    written: !opts.dryRun,
  };
}

module.exports = {
  UPLOAD_ROOT,
  ALLOWED_EXT_RE,
  MAX_FILE_SIZE,
  MSG_BAD_TYPE,
  MSG_TOO_LARGE,
  getSubDir,
  makeFilename,
  isAllowedFileName,
  extForMime,
  ensureSubDir,
  saveBuffer,
};
