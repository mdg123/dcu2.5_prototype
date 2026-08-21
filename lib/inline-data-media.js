// lib/inline-data-media.js
// ─────────────────────────────────────────────────────────────────────────────
// 본문(HTML) 안의 `data:` URL 을 **실제 업로드 파일로 바꾸는** 변환기.
//
// 발단(사용자 실측 2026-08-21, GCP 정본 student_gallery 41~48 · posts 98~105)
//   교사가 갤러리 게시판에 작품 8건을 올렸는데
//     · 채움클래스 갤러리   → 이미지가 **보임**   (본문에서 첫 <img> 를 꺼내 그리므로 base64 도 렌더)
//     · 나도예술가          → **빈 이미지(팔레트 이모지)**
//   원인은 이미지가 파일이 아니라 본문에 `data:image/png;base64,…` 로 박혀 있어서였다
//   (Quill 에디터에 이미지를 **붙여넣기** 하면 base64 로 들어간다).
//
// base64 가 DB 에 그대로 쌓이면 생기는 일
//   ⓐ 나도예술가로 못 넘어간다 — gallery_attachments.url 은 1000자로 잘라 저장하므로
//      base64 를 넣으면 **잘린 쓰레기 URL** 이 된다(깨진 이미지 = 지금보다 더 나쁨).
//   ⓑ posts.content 가 비대해진다(이미지 1장에 수백 KB~수 MB).
//   ⓒ 목록 API 가 content 를 통째로 실어 나르므로 게시판 로딩이 무거워진다.
//   ⓓ 캐시·CDN 이 못 태운다. 브라우저가 매번 같은 바이트를 다시 받는다.
//
// 그래서 **저장 시점에 파일로 바꾼다**. 화면·연동·정리 스크립트를 각각 고치는 대신
// 데이터가 들어오는 문 앞에서 한 번 정규화하는 쪽이 근본 처방이다.
//
// ★ 규칙은 새로 만들지 않는다 — 저장 위치·파일명·허용 확장자·용량 상한은
//   lib/upload-rules.js(= /api/upload 의 multer 가 쓰는 그 규칙) 를 그대로 쓴다.
//   `data:` 가 **검사를 건너뛰는 뒷문**이 되면 안 되기 때문이다.
//   미디어 종류 판정은 public/js/media-kind.js(SSOT) 의 표를 뒤집어 쓴다(upload-rules.extForMime).
//
// 동영상·음원 `data:` 도 같이 처리하는가 — **한다.** (판단 근거)
//   · 위 ⓐ(1000자 절단)·ⓑ·ⓒ 는 형식과 무관하게 똑같이 발생하고, 용량이 커서 오히려 더 심하다.
//   · `<video src="data:...">` 는 Range 요청이 안 돼 탐색(seek)·부분 재생이 불가능하다.
//   · 허용 목록(mp4·mp3·wav)에 들어 있으므로 파일로 바꿔도 업로드 규칙 안이다.
//   · 반대로 "이미지만 바꾼다"로 두면 동영상 base64 가 그대로 남아 같은 결함을 다시 만든다.
//
// 다루지 않는 것
//   · `<a href="data:...">` — 우리 에디터(Quill)가 만들지 않는다. 필요해지면 여기에 추가할 것.
//     (그 경우에도 규칙은 upload-rules 를 그대로 쓸 것)
// ─────────────────────────────────────────────────────────────────────────────
const rules = require('./upload-rules');
const MediaKind = require('../public/js/media-kind');

/** 글 1건에서 변환할 수 있는 data: 미디어 최대 개수 — 무한 첨부 방지. */
const MAX_DATA_FILES = 20;

// 붙여넣기 파일의 기본 이름. **ASCII 로 둔다** — 파일명이 그대로 URL 이 되므로
// 한글이면 매 요청마다 퍼센트 인코딩을 타고, 서버 이관·로그·ops 검색에서 불편하다.
// (기존 업로드분도 paste-…png 형태가 이미 있다 — 그 관례를 따른다)
const PASTED_BASENAME = 'paste';

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** src 속성에 들어 있는 data: URL 을 찾는다. (앞에 공백이 있어야 data-src= 같은 것과 안 섞인다) */
const SRC_DATA_RE = /(\ssrc\s*=\s*)(?:"(data:[^"]*)"|'(data:[^']*)'|(data:[^\s>"']+))/gi;

/**
 * data: URL 하나를 파싱한다.
 * @returns {{mime:string, buffer:Buffer}}
 * @throws {Error & {code:'BAD_DATA_URL'|'BAD_TYPE'}}
 */
function decodeDataUrl(dataUrl) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!m) throw err('BAD_DATA_URL', '본문에 들어 있는 이미지 데이터를 읽을 수 없습니다.');
  const meta = m[1] || '';
  const payload = m[2] || '';
  const mime = (meta.split(';')[0] || '').toLowerCase().trim();
  if (!mime) throw err('BAD_TYPE', rules.MSG_BAD_TYPE);
  const isBase64 = /(^|;)base64($|;)/i.test(meta);
  let buffer;
  if (isBase64) {
    buffer = Buffer.from(payload, 'base64');
  } else {
    // 퍼센트 인코딩 형태(data:image/svg+xml,%3Csvg…). 허용 목록에서 어차피 걸리지만,
    // "base64 가 아니면 검사 없이 통과" 같은 구멍을 남기지 않도록 여기서도 디코드해 같은 관문에 넣는다.
    let text;
    try { text = decodeURIComponent(payload); } catch (_) { text = payload; }
    buffer = Buffer.from(text, 'utf8');
  }
  if (!buffer.length) throw err('BAD_DATA_URL', '본문에 들어 있는 이미지 데이터가 비어 있습니다.');
  return { mime, buffer };
}

/**
 * 본문의 data: URL 을 전부 파일로 저장하고, src 를 파일 경로로 바꾼 본문을 돌려준다.
 *
 * @param {string} html 본문
 * @param {{queryType?:string, maxBytes?:number, maxFiles?:number, dryRun?:boolean}} [opts]
 *        queryType: mime 을 모를 때 쓸 하위 폴더(=/api/upload?type= 과 같은 의미)
 *        maxBytes : 파일 1개 상한. **기본값은 업로드 규칙의 50MB** (테스트 주입용으로만 낮춘다)
 *        dryRun   : 검사·치환 결과는 그대로 계산하되 파일을 쓰지 않는다(복구 스크립트 DRY-RUN)
 * @returns {{content:string, changed:boolean, files:Array<{url:string,mime:string,size:number,kind:string|null}>, firstImageUrl:string|null}}
 * @throws {Error & {code:'BAD_TYPE'|'TOO_LARGE'|'TOO_MANY'|'BAD_DATA_URL'}}
 */
function materializeDataUrls(html, opts = {}) {
  const src = html == null ? '' : String(html);
  const empty = { content: src, changed: false, files: [], firstImageUrl: null };
  if (!src || src.indexOf('data:') === -1) return empty;

  const maxBytes = opts.maxBytes != null ? Number(opts.maxBytes) : rules.MAX_FILE_SIZE;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : MAX_DATA_FILES;
  const queryType = opts.queryType || null;

  // ① 먼저 **전부 검사**한다(파일은 아직 쓰지 않는다).
  //    하나라도 규칙 위반이면 파일을 한 개도 남기지 않고 던진다 — 중간까지 쓴 고아 파일 금지.
  const pending = [];
  SRC_DATA_RE.lastIndex = 0;
  let m;
  while ((m = SRC_DATA_RE.exec(src)) !== null) {
    const dataUrl = (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || '');
    if (!dataUrl) continue;
    if (pending.length >= maxFiles) {
      throw err('TOO_MANY', `본문에 넣을 수 있는 이미지·동영상은 최대 ${maxFiles}개입니다.`);
    }
    const { mime, buffer } = decodeDataUrl(dataUrl);
    if (buffer.length > maxBytes) throw err('TOO_LARGE', rules.MSG_TOO_LARGE);
    const ext = rules.extForMime(mime);
    // 확장자를 못 정하는 mime(text/html 등)은 애초에 허용 목록 밖이다.
    if (!ext) throw err('BAD_TYPE', rules.MSG_BAD_TYPE);
    // 허용 확장자 판정도 **여기서 미리** 같은 관문으로 본다(저장 직전이 아니라).
    if (!rules.isAllowedFileName(`${PASTED_BASENAME}.${ext}`)) throw err('BAD_TYPE', rules.MSG_BAD_TYPE);
    pending.push({ dataUrl, mime, buffer, ext });
  }

  if (!pending.length) return empty;

  // ② 검사를 다 통과한 뒤에 저장한다. 최종 판정도 upload-rules.saveBuffer 가 다시 한다.
  const files = [];
  const replacements = [];   // dataUrl → 파일 URL
  for (const it of pending) {
    const saved = rules.saveBuffer(it.buffer, {
      originalName: `${PASTED_BASENAME}.${it.ext}`,
      mime: it.mime,
      queryType,
      dryRun: !!opts.dryRun,
    });
    files.push({ url: saved.url, mime: it.mime, size: saved.size, kind: MediaKind.mediaKindOf(saved.url) });
    replacements.push([it.dataUrl, saved.url]);
  }

  let out = src;
  for (const [from, to] of replacements) {
    // data: URL 은 정규식 메타문자를 포함할 수 있으므로 split/join 으로 문자열 치환한다.
    out = out.split(from).join(to);
  }

  const firstImage = files.find(f => f.kind === 'image');
  return {
    content: out,
    changed: true,
    files,
    firstImageUrl: firstImage ? firstImage.url : null,
  };
}

/**
 * materializeDataUrls 가 던지는 코드 중 **사용자 입력 잘못**인 것들.
 * 이것만 400 으로 바꾸고, 나머지(디스크 오류 등)는 그대로 위로 던져 500 이 되게 한다.
 */
const INPUT_ERROR_CODES = new Set(['BAD_TYPE', 'TOO_LARGE', 'TOO_MANY', 'BAD_DATA_URL']);

/**
 * 저장 직전 **관문** — 요청 본문 객체의 HTML 필드 하나를 제자리에서 정규화한다.
 *
 * Quill 에디터가 있는 곳(게시판 글·알림장·과제 제출)은 전부 같은 증상을 갖는다:
 * 이미지를 **붙여넣으면** `data:image/png;base64,…` 가 본문에 통째로 박힌다.
 * 화면마다 따로 대응하지 말고 **데이터가 들어오는 문 앞에서 한 번** 파일로 바꾼다.
 *
 * ⚠ 규칙(허용 확장자·50MB·저장 위치·파일명)은 lib/upload-rules.js 한 벌만 쓴다.
 *   여기서 새 판정을 적으면 `data:` 가 업로드 검사를 건너뛰는 뒷문이 된다.
 * ⚠ 하나라도 규칙 위반이면 materializeDataUrls 가 **파일을 한 개도 쓰지 않고** 던진다
 *   (2-패스). 따라서 400 을 돌려주는 시점에 고아 파일은 남지 않는다.
 *
 * @param {object} target      수정 대상 객체(요청 본문의 **사본**을 넘길 것 — 제자리 수정한다)
 * @param {{field?:string, queryType?:string, coverField?:string|null, maxBytes?:number, maxFiles?:number}} [opts]
 *        field     : 정규화할 필드명 (기본 'content')
 *        queryType : mime 을 모를 때 쓸 업로드 하위 폴더 (= /api/upload?type=)
 *        coverField: 대표 이미지 필드명. **비어 있을 때만** 변환된 첫 이미지로 채운다.
 *                    그런 필드가 없는 테이블(알림장·과제 제출)은 넘기지 않는다 — 없는 규약을 만들지 않는다.
 * @returns {null | {status:number, message:string}} null 이면 정상, 아니면 그대로 응답할 에러
 */
function normalizeInlineMedia(target, opts = {}) {
  const field = opts.field || 'content';
  if (!target || target[field] == null) return null;
  try {
    const out = materializeDataUrls(target[field], {
      queryType: opts.queryType || null,
      maxBytes: opts.maxBytes,
      maxFiles: opts.maxFiles,
    });
    if (!out.changed) return null;
    target[field] = out.content;
    const cover = opts.coverField;
    if (cover && !target[cover] && out.firstImageUrl) target[cover] = out.firstImageUrl;
    return null;
  } catch (e) {
    if (e && INPUT_ERROR_CODES.has(e.code)) return { status: 400, message: e.message };
    throw e;
  }
}

/** 본문에 아직 data: 미디어가 남아 있는가 — 회귀 검사·복구 스크립트용. */
function hasInlineDataMedia(html) {
  const s = html == null ? '' : String(html);
  if (!s || s.indexOf('data:') === -1) return false;
  SRC_DATA_RE.lastIndex = 0;
  return SRC_DATA_RE.test(s);
}

module.exports = {
  MAX_DATA_FILES,
  SRC_DATA_RE,
  INPUT_ERROR_CODES,
  decodeDataUrl,
  materializeDataUrls,
  normalizeInlineMedia,
  hasInlineDataMedia,
};
