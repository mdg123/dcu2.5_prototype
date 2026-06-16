// test/contest-dday.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 회귀] 콘테스트 D-day 경계값 계산 (public/plus/contests.html 의 calcDDay).
//   calcDDay 는 순수 FE 함수(DB 무관)이므로, 동일 로직을 여기서 박제해
//   경계값(종료 / 오늘마감 / D-1 / D-2 / D-3 / D-7 / D-8)의 라벨·색 클래스를 고정한다.
//   색 규칙(기획서 §6):
//     종료(과거)        → closed
//     오늘 마감(D-0)    → danger
//     D-1 · D-2         → danger
//     D-3 ~ D-7         → warn
//     D-8 이상          → safe
//
//   ★ 정합 핵심(REWORK M-1): 실 gallery_events.end_date 는 거의 전부 date-only
//      ('2026-07-01'). 과거(2026-06-15)엔 calcDDay 가 ≤10자에 'T23:59:59'를 붙여
//      Math.ceil 로 계산 → 당일 마감이 "오늘 마감"이 아니라 D-1 로 +1 시프트되고
//      "종료"도 실제 마감 다음날에야 떴다. 단위테스트는 full-ISO 경로만 봤다(회귀 공백).
//      → 이제 calcDDay 는 "로컬 자정 기준 날짜 차"로 계산하고, now(기준일) 주입을 받는다.
//        본 테스트는 production 경로인 date-only 입력 경계를 명시적으로 박제한다.
//
//   ★ 같은 버그 재발 0: contests.html 의 calcDDay 를 수정하면 이 박제본도 함께 갱신해
//      라벨/색 경계가 어긋나지 않게 유지한다(하네스 = 객관 검증).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── contests.html 의 calcDDay 와 동일 로직 (박제) ──
// end 는 date-only('YYYY-MM-DD') 든 full-ISO 든 날짜 부분만 추출해 로컬 자정끼리 일수 차로 계산.
// now(기준일) 주입 가능 → 테스트가 고정 "오늘"을 넣어 경계를 결정적으로 검증.
function calcDDay(endDate, now) {
  if (!endDate) return { label: '', cls: '' };
  const m = String(endDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { label: '', cls: '' };
  const endMid = new Date(+m[1], +m[2] - 1, +m[3]); // 로컬 자정
  const base = now ? new Date(now) : new Date();
  const nowMid = new Date(base.getFullYear(), base.getMonth(), base.getDate()); // 오늘 로컬 자정
  const days = Math.round((endMid.getTime() - nowMid.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: '종료', cls: 'closed' };
  if (days === 0) return { label: '오늘 마감', cls: 'danger' };
  if (days <= 2) return { label: `D-${days}`, cls: 'danger' };
  if (days <= 7) return { label: `D-${days}`, cls: 'warn' };
  return { label: `D-${days}`, cls: 'safe' };
}

// 고정 기준일(KST 한낮으로 둬 자정 경계 흔들림 방지). 날짜는 하드코딩하되
// end 는 기준일로부터 offset(일) 으로 계산 → "오늘이 언제든" 결정적.
const BASE = new Date(2026, 5, 16, 13, 0, 0); // 2026-06-16 13:00 로컬
function dateOnlyOffset(days) {
  const d = new Date(BASE.getFullYear(), BASE.getMonth(), BASE.getDate() + days);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`; // date-only (production 형식)
}

test('DDAY-1: 빈 값 → 라벨/클래스 없음', () => {
  assert.deepEqual(calcDDay(null), { label: '', cls: '' });
  assert.deepEqual(calcDDay(undefined), { label: '', cls: '' });
  assert.deepEqual(calcDDay(''), { label: '', cls: '' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ PRODUCTION 경로: date-only 입력 경계 (REWORK M-1 회귀 박제)
//   기준일(BASE)을 now 로 주입해 "오늘"을 고정하고, end 를 offset 으로 만든다.
// ─────────────────────────────────────────────────────────────────────────────
test('DDAY-DO-1: 오늘 마감(date-only, end==오늘) → 오늘 마감/danger (이전 버그: D-1 로 시프트됨)', () => {
  const r = calcDDay(dateOnlyOffset(0), BASE);
  assert.equal(r.label, '오늘 마감');
  assert.equal(r.cls, 'danger');
});

test('DDAY-DO-2: 내일 마감(date-only, +1) → D-1/danger', () => {
  const r = calcDDay(dateOnlyOffset(1), BASE);
  assert.equal(r.label, 'D-1');
  assert.equal(r.cls, 'danger');
});

test('DDAY-DO-3: +2 (date-only) → D-2/danger', () => {
  const r = calcDDay(dateOnlyOffset(2), BASE);
  assert.equal(r.label, 'D-2');
  assert.equal(r.cls, 'danger');
});

test('DDAY-DO-4: +3 (date-only, warn 시작) → D-3/warn', () => {
  const r = calcDDay(dateOnlyOffset(3), BASE);
  assert.equal(r.label, 'D-3');
  assert.equal(r.cls, 'warn');
});

test('DDAY-DO-5: +7 (date-only, warn 끝) → D-7/warn', () => {
  const r = calcDDay(dateOnlyOffset(7), BASE);
  assert.equal(r.label, 'D-7');
  assert.equal(r.cls, 'warn');
});

test('DDAY-DO-6: +8 (date-only, safe 시작) → D-8/safe', () => {
  const r = calcDDay(dateOnlyOffset(8), BASE);
  assert.equal(r.label, 'D-8');
  assert.equal(r.cls, 'safe');
});

test('DDAY-DO-7: 어제 마감(date-only, -1) → 종료/closed (이전 버그: 마감 다음날에야 종료 표시)', () => {
  const r = calcDDay(dateOnlyOffset(-1), BASE);
  assert.equal(r.label, '종료');
  assert.equal(r.cls, 'closed');
});

// ─────────────────────────────────────────────────────────────────────────────
// full-ISO(시각 포함) 입력도 날짜만 추출해 date-only 와 동일하게 처리되는지 일관성 검증.
// ─────────────────────────────────────────────────────────────────────────────
test('DDAY-ISO-1: full-ISO(오늘 23:59:59) → 오늘 마감/danger (date-only 와 동일)', () => {
  const today = dateOnlyOffset(0);
  const r = calcDDay(`${today}T23:59:59`, BASE);
  assert.equal(r.label, '오늘 마감');
  assert.equal(r.cls, 'danger');
});

test('DDAY-ISO-2: full-ISO(+3 09:00) → D-3/warn (시각 무관, 날짜 차만)', () => {
  const d = dateOnlyOffset(3);
  const r = calcDDay(`${d}T09:00:00`, BASE);
  assert.equal(r.label, 'D-3');
  assert.equal(r.cls, 'warn');
});

test('DDAY-ISO-3: "YYYY-MM-DD HH:MM:SS" 공백 구분 형식도 처리', () => {
  const d = dateOnlyOffset(5);
  const r = calcDDay(`${d} 14:30:00`, BASE);
  assert.equal(r.label, 'D-5');
  assert.equal(r.cls, 'warn');
});

// now 미주입(실시간) 경로도 죽지 않고 동작 — "충분히 먼 미래"는 safe.
test('DDAY-LIVE: now 미주입 + 먼 미래(date-only) → safe', () => {
  const r = calcDDay('2099-12-31');
  assert.equal(r.cls, 'safe');
});
