/**
 * KST(한국 표준시) 시각 SSOT — 프론트엔드 전용.  window.DacheumTime 으로 노출.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 *  서버 DB 는 UTC 로 저장한다(SQLite CURRENT_TIMESTAMP → 'YYYY-MM-DD HH:MM:SS',
 *  구분자 공백, 오프셋 표기 없음). 이 문자열을 `new Date(s)` 에 그대로 넣으면
 *  V8 이 **브라우저 로컬 시각**으로 파싱한다. 한국(UTC+9)에서는 그대로 9시간이
 *  어긋나, 12:56 에 쓴 글이 "9시간 전"·"03:56" 으로 표시된다.
 *
 * ── 설계 핵심 ──────────────────────────────────────────────────────────────
 *  상대시간(timeAgo)과 절대시간(fmtDateTime)이 **반드시 같은 파서**(parse)를
 *  거치게 한다. 두 표시가 서로 다른 파서를 쓰던 것이 "9시간 전 ↔ 03:56" 자기모순의
 *  원인이었다. 같은 파서를 공유하면 그 모순이 구조적으로 불가능해진다.
 *  (불변식 test/kst-time-convention.test.js 에 박제)
 *
 * ── 승격 출처 ──────────────────────────────────────────────────────────────
 *  `public/plus/gallery.html` 의 timeAgo 가 이미 올바른 패턴
 *  (`iso.replace(' ','T') + (iso.includes('Z') ? '' : 'Z')`) 을 썼다. 그것을
 *  SSOT 로 승격했다. 원본도 이 모듈을 참조하도록 변경했다.
 *
 * ── 대응 백엔드 ────────────────────────────────────────────────────────────
 *  `lib/kst.js` — 동일 규약(고정 +9). 대한민국은 1988년 이후 DST 없음.
 */
(function (global) {
  'use strict';

  var KST_OFFSET_MS = 9 * 60 * 60 * 1000;

  function pad(n) { return String(n).padStart(2, '0'); }

  /**
   * 서버 저장 시각 → Date(정확한 절대시각). 해석 불가 시 null.
   * 허용: Date / epoch ms / 'YYYY-MM-DD HH:MM:SS' / ISO(Z·오프셋) / 'YYYY-MM-DD'
   */
  function parse(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return isFinite(value.getTime()) ? value : null;
    if (typeof value === 'number') {
      var dn = new Date(value);
      return isFinite(dn.getTime()) ? dn : null;
    }
    var s = String(value).trim();
    if (!s) return null;

    // 날짜만 → 그 날 KST 00:00 의 절대시각
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      var t0 = Date.parse(s + 'T00:00:00Z');
      return isFinite(t0) ? new Date(t0 - KST_OFFSET_MS) : null;
    }

    var normalized = s.replace(' ', 'T');
    var hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
    var t = Date.parse(hasOffset ? normalized : normalized + 'Z');
    return isFinite(t) ? new Date(t) : null;
  }

  /** KST 벽시계 부품 읽기용 시프트 Date (getUTC* 가 KST 값). 내부용. */
  function shift(d) { return new Date(d.getTime() + KST_OFFSET_MS); }

  /** 서버 시각 → KST 'YYYY-MM-DD'. 실패 시 fallback(기본 ''). */
  function fmtDate(value, fallback) {
    var d = parse(value);
    if (!d) return fallback === undefined ? '' : fallback;
    var s = shift(d);
    return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate());
  }

  /** 서버 시각 → KST 'HH:MM'. */
  function fmtTime(value, fallback) {
    var d = parse(value);
    if (!d) return fallback === undefined ? '' : fallback;
    var s = shift(d);
    return pad(s.getUTCHours()) + ':' + pad(s.getUTCMinutes());
  }

  /** 서버 시각 → KST 'YYYY-MM-DD HH:MM'. */
  function fmtDateTime(value, fallback) {
    var d = parse(value);
    if (!d) return fallback === undefined ? '' : fallback;
    return fmtDate(d) + ' ' + fmtTime(d);
  }

  /** 서버 시각 → KST 'YYYY.MM.DD HH:MM' (상세 화면 표기). */
  function fmtDotted(value, fallback) {
    var d = parse(value);
    if (!d) return fallback === undefined ? '' : fallback;
    return fmtDate(d).replace(/-/g, '.') + ' ' + fmtTime(d);
  }

  /**
   * 서버 시각 → 상대시간 한국어. **fmtDateTime 과 동일한 parse 를 공유**한다.
   * 7일 이상 지난 건 KST 절대날짜로 폴백하여 상대·절대 표기가 어긋날 여지를 없앤다.
   */
  function timeAgo(value, fallback) {
    var d = parse(value);
    if (!d) return fallback === undefined ? '' : fallback;
    var sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 0) sec = 0;                       // 미세한 시계 차이로 음수가 나오면 '방금 전'
    if (sec < 60) return '방금 전';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + '분 전';
    var hour = Math.floor(min / 60);
    if (hour < 24) return hour + '시간 전';
    var day = Math.floor(hour / 24);
    if (day < 7) return day + '일 전';
    return fmtDate(d);
  }

  /** 오늘(KST) 'YYYY-MM-DD'. */
  function today() {
    var s = shift(new Date());
    return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate());
  }

  /**
   * 로컬 Date 객체 → 'YYYY-MM-DD' (달력 부품 그대로).
   * `toISOString().slice(0,10)` 은 UTC 로 밀리므로 달력·기간 선택에 쓰면 안 된다.
   */
  function toLocalYMD(d) {
    if (!(d instanceof Date) || !isFinite(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 'YYYY-MM-DD' → 로컬 자정 Date (달력 렌더용. TZ 이동 없음). */
  function parseYMD(s) {
    if (!s) return null;
    var m = String(s).slice(0, 10).split('-').map(Number);
    if (m.length !== 3 || m.some(isNaN)) return null;
    return new Date(m[0], m[1] - 1, m[2]);
  }

  var api = {
    KST_OFFSET_MS: KST_OFFSET_MS,
    parse: parse,
    fmtDate: fmtDate,
    fmtTime: fmtTime,
    fmtDateTime: fmtDateTime,
    fmtDotted: fmtDotted,
    timeAgo: timeAgo,
    today: today,
    toLocalYMD: toLocalYMD,
    parseYMD: parseYMD
  };

  global.DacheumTime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
