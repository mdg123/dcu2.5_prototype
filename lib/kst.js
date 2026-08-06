'use strict';
/**
 * KST(한국 표준시) 시각 SSOT — 백엔드 전용.
 *
 * ── 정본 규약 (PM 승인 2026-08-06, 선택지 "다") ────────────────────────────
 *  1) 저장은 UTC 를 유지한다.  DB 의 사실상 단일 규약은 SQLite `CURRENT_TIMESTAMP`
 *     = UTC `'YYYY-MM-DD HH:MM:SS'` (구분자 공백, 오프셋 표기 없음)이다.
 *     기존 데이터를 흔들지 않는다 → 마이그레이션 없음.
 *  2) "어느 날인가"(날짜 귀속)와 표시만 KST 로 계산한다.
 *  3) KST 는 **고정 +9** 로 계산한다. `datetime('now','localtime')` 은 프로세스
 *     타임존(= VM 의 `timedatectl`)에 의존하므로 쓰지 않는다. 대한민국은 1988년
 *     이후 일광절약시간이 없어 고정 오프셋이 항상 안전하다.
 *
 * ── 왜 SSOT 인가 ───────────────────────────────────────────────────────────
 *  `new Date().toISOString().slice(0,10)` 은 **UTC 날짜**다. KST 00:00~08:59 에
 *  일어난 일이 전날로 기록된다. 등교 체크인 시간대(08:00~08:50 KST)가 정확히
 *  이 구간이라 실사용 시작과 동시에 출석 날짜가 하루씩 밀린다.
 *  이 모듈이 그 판정의 유일한 출처다. 사본을 만들지 말 것.
 *
 * ── 승격 출처 ──────────────────────────────────────────────────────────────
 *  `routes/exam.js` 의 `kstTodayStr()` 를 이 모듈로 승격했다(원본은 이 모듈을
 *  참조하도록 변경). 새 규약의 발명이 아니라 이미 있던 정답의 단일화다.
 *
 * ── 대응 프론트엔드 ────────────────────────────────────────────────────────
 *  `public/js/kst.js` — 같은 규약의 표시 계층. 상대시간·절대시간이 동일 파서를
 *  쓰도록 강제하여 "9시간 전 ↔ 03:56" 같은 자기모순을 구조적으로 차단한다.
 */

/** KST 오프셋(밀리초). 대한민국은 DST 없음 → 고정값. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** SQLite 에서 UTC 컬럼을 KST 로 시프트하는 modifier. */
const KST_SQL_SHIFT = '+9 hours';

/**
 * SQL 조각 생성기 — UTC 저장 컬럼의 **KST 날짜**를 뽑는다.
 * 예: sqlKstDate('a.checked_at') → "date(a.checked_at, '+9 hours')"
 * 컬럼식은 호출부가 만든 식별자만 넣을 것(사용자 입력 금지).
 */
function sqlKstDate(expr) {
  return `date(${expr}, '${KST_SQL_SHIFT}')`;
}

/** 현재 KST 날짜의 SQL 식. */
function sqlKstToday() {
  return `date('now', '${KST_SQL_SHIFT}')`;
}

/**
 * 서버 저장 시각 문자열 → Date(정확한 절대시각).
 *
 * 핵심: `'2026-08-05 03:56:16'` 처럼 **구분자가 공백이고 오프셋이 없는** 문자열을
 * JS `new Date()` 에 그대로 넣으면 V8 이 **로컬 시각**으로 파싱해 KST 에서 +9시간
 * 어긋난다. DB 는 UTC 로 저장하므로 명시적으로 UTC 로 해석해야 한다.
 *
 * 허용 입력: Date / epoch ms / 'YYYY-MM-DD HH:MM:SS' / ISO(Z·오프셋 포함) / 'YYYY-MM-DD'
 * 반환: Date, 해석 불가 시 null.
 */
function parseServerTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const s = String(value).trim();
  if (!s) return null;

  // 날짜만: KST 달력 날짜로 간주 → 그 날 KST 00:00 의 절대시각.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(t) ? new Date(t - KST_OFFSET_MS) : null;
  }

  // 오프셋(Z 또는 ±HH:MM)이 이미 있으면 그대로 신뢰.
  const normalized = s.replace(' ', 'T');
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  const t = Date.parse(hasOffset ? normalized : normalized + 'Z');
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * KST 벽시계 부품을 UTC 접근자로 읽기 위해 +9h 시프트한 Date 를 만든다.
 * ⚠ 내부용. 반환 Date 의 getUTCFullYear()/getUTCDate()/getUTCDay() 가 KST 값이다.
 *   절대시각으로서는 틀린 값이므로 밖으로 내보내지 말 것.
 */
function _shifted(ref) {
  const base = ref == null ? Date.now()
    : (ref instanceof Date ? ref.getTime()
      : (typeof ref === 'number' ? ref : (parseServerTime(ref) || new Date(NaN)).getTime()));
  return new Date(base + KST_OFFSET_MS);
}

function _ymd(shifted) {
  const p = n => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`;
}

/** 오늘(KST) 'YYYY-MM-DD'. ref 를 주면 그 시점 기준. */
function kstToday(ref) {
  return _ymd(_shifted(ref));
}

/** 서버 저장 시각 → 그 시각이 속한 **KST 날짜** 'YYYY-MM-DD'. 해석 불가 시 null. */
function kstDateOf(value) {
  const d = parseServerTime(value);
  if (!d) return null;
  return _ymd(new Date(d.getTime() + KST_OFFSET_MS));
}

/** 서버 저장 시각 → KST 'HH:MM'. 해석 불가 시 null. */
function kstTimeOf(value) {
  const d = parseServerTime(value);
  if (!d) return null;
  const s = new Date(d.getTime() + KST_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
}

/** 'YYYY-MM-DD' 에 일수를 더한 'YYYY-MM-DD'. 달력 날짜 연산이라 TZ 무관. */
function kstAddDays(ymd, days) {
  const t = Date.parse(String(ymd).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 의 요일 (0=일 ~ 6=토). TZ 무관. */
function ymdWeekday(ymd) {
  const t = Date.parse(String(ymd).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCDay();
}

/** 두 'YYYY-MM-DD' 사이의 일수 차 (later - earlier). TZ 무관. */
function ymdDiffDays(earlier, later) {
  const a = Date.parse(String(earlier).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(later).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** 이번 주(월~일, KST) 범위 { start, end }. */
function kstWeekRange(ref) {
  const today = kstToday(ref);
  const dow = ymdWeekday(today);           // 0=일
  const backToMonday = dow === 0 ? 6 : dow - 1;
  const start = kstAddDays(today, -backToMonday);
  return { start, end: kstAddDays(start, 6) };
}

/** 이번 달(1일~말일, KST) 범위 { start, end }. */
function kstMonthRange(ref) {
  const s = _shifted(ref);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth();
  const p = n => String(n).padStart(2, '0');
  const start = `${y}-${p(m + 1)}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { start, end: `${y}-${p(m + 1)}-${p(lastDay)}` };
}

/** 이번 달 1일(KST) 'YYYY-MM-01'. */
function kstMonthStart(ref) {
  return kstMonthRange(ref).start;
}

/** 이번 주 월요일(KST). */
function kstWeekStart(ref) {
  return kstWeekRange(ref).start;
}

module.exports = {
  KST_OFFSET_MS,
  KST_SQL_SHIFT,
  sqlKstDate,
  sqlKstToday,
  parseServerTime,
  kstToday,
  kstDateOf,
  kstTimeOf,
  kstAddDays,
  ymdWeekday,
  ymdDiffDays,
  kstWeekRange,
  kstMonthRange,
  kstMonthStart,
  kstWeekStart,
};
