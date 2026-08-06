// test/growth-heatmap-weeks.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 성장리포트 > 오늘의 학습 현황 히트맵 — 주차열 수 계약.
//
// 왜 박제하는가 (2026-08-06, 사용자 지적):
//   히트맵 오른쪽 끝에 **셀 없이 머리글만 있는 빈 열**("8/10")이 떠 있었다.
//     const weeks = Math.round((gridEnd - gridStart) / 86400000 / 7) + 1;   // ← 결함
//   gridStart(그 주 월요일)~gridEnd(그 주 일요일)의 **차이**는 (주수×7 - 1)일이라
//   7로 나눠 반올림하면 그 자체가 주 수다. `+1` 이 항상 한 주를 덧붙였다.
//   덧붙은 열의 칸은 전부 범위 밖(.out, 투명)이라 **셀은 안 보이고 머리글만 남아**,
//   사용자가 "이 열은 뭘 의미하냐"고 물었다.
//
//   ⚠ 이 부류는 하네스가 놓치기 쉽다 — DOM 은 정상이고 콘솔 에러도 없다.
//     "보이지 않는 요소가 자리를 차지한다"는 **눈으로만 보이는** 결함이다.
//
// 불변식:
//   INV-HM1  주차열 수 = 그리드가 덮는 날짜 수 / 7 (정확히 나누어떨어진다)
//   INV-HM2  마지막 열에 표시 범위(start~today) 안의 날이 **최소 1개** 있다 ← 빈 열 금지
//   INV-HM3  첫 열에도 범위 안의 날이 최소 1개 있다
//   INV-HM4  (소스 락) 결함 형태가 되살아나지 않았다
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'growth', 'student-report.html');

// student-report.html 의 renderDailyCalendarB 와 **같은 규칙**을 재현한다.
//   (월=0 … 일=6 주 시작, 표시 범위 = today-(n-1) ~ today)
function gridOf(todayStr, n) {
  const today = new Date(todayStr + 'T00:00:00');
  const start = new Date(today); start.setDate(start.getDate() - (n - 1));
  const startDow = (start.getDay() + 6) % 7;
  const gridStart = new Date(start); gridStart.setDate(gridStart.getDate() - startDow);
  const endDow = (today.getDay() + 6) % 7;
  const gridEnd = new Date(today); gridEnd.setDate(gridEnd.getDate() + (6 - endDow));
  const spanDays = (gridEnd - gridStart) / 86400000 + 1;   // 양끝 포함
  const weeks = Math.round(spanDays / 7);
  return { today, start, gridStart, gridEnd, spanDays, weeks };
}

// 그리드 (row=요일, w=주차) → 실제 날짜. 페이지의 셀 배치와 동일.
function cellDate(gridStart, w, row) {
  const d = new Date(gridStart);
  d.setDate(d.getDate() + w * 7 + row);
  return d;
}

const PERIODS = [15, 20, 28, 30, 45, 60, 90];

test('INV-HM1: 주차열 수 × 7 == 그리드가 덮는 날짜 수', () => {
  for (let i = 0; i < 400; i++) {
    const t = new Date('2026-01-01T00:00:00'); t.setDate(t.getDate() + i);
    const ts = t.toISOString().slice(0, 10);
    for (const n of PERIODS) {
      const g = gridOf(ts, n);
      assert.strictEqual(g.weeks * 7, g.spanDays,
        `${ts} / ${n}일: weeks=${g.weeks} 인데 그리드가 ${g.spanDays}일을 덮는다`);
    }
  }
});

test('INV-HM2: 마지막 주차열에 표시 범위 안의 날이 최소 1개 있다 (빈 열 금지)', () => {
  for (let i = 0; i < 400; i++) {
    const t = new Date('2026-01-01T00:00:00'); t.setDate(t.getDate() + i);
    const ts = t.toISOString().slice(0, 10);
    for (const n of PERIODS) {
      const g = gridOf(ts, n);
      const last = g.weeks - 1;
      let inRange = 0;
      for (let row = 0; row < 7; row++) {
        const d = cellDate(g.gridStart, last, row);
        if (d >= g.start && d <= g.today) inRange++;
      }
      assert.ok(inRange > 0,
        `${ts} / ${n}일: 마지막 열(${g.weeks}번째)에 표시할 날이 하나도 없다. ` +
        `셀은 투명하고 머리글만 남아 "이 열은 뭐냐"는 질문을 만든다.`);
    }
  }
});

test('INV-HM3: 첫 주차열에도 표시 범위 안의 날이 최소 1개 있다', () => {
  for (let i = 0; i < 400; i++) {
    const t = new Date('2026-01-01T00:00:00'); t.setDate(t.getDate() + i);
    const ts = t.toISOString().slice(0, 10);
    for (const n of PERIODS) {
      const g = gridOf(ts, n);
      let inRange = 0;
      for (let row = 0; row < 7; row++) {
        const d = cellDate(g.gridStart, 0, row);
        if (d >= g.start && d <= g.today) inRange++;
      }
      assert.ok(inRange > 0, `${ts} / ${n}일: 첫 열이 통째로 비었다`);
    }
  }
});

test('사용자가 지적한 그 날짜 재현 — 2026-08-06 · 30일 = 5주 (6주 아님)', () => {
  const g = gridOf('2026-08-06', 30);
  assert.strictEqual(g.gridStart.getMonth() + 1, 7);
  assert.strictEqual(g.gridStart.getDate(), 6, 'gridStart 는 7/6(월)');
  assert.strictEqual(g.weeks, 5,
    '6주가 나오면 "8/10" 머리글만 있는 빈 열이 생긴다 — 사용자가 본 그 화면');
});

test('INV-HM4 (소스 락): 결함 형태가 되살아나지 않았다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // 주석에는 결함 형태가 인용돼 있으므로 **실행되는 코드 줄**만 본다.
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  assert.equal(/86400000\s*\/\s*7\s*\)\s*\+\s*1/.test(code), false,
    '차이(diff)를 7로 나눈 뒤 +1 하면 항상 한 주가 더 그려진다. ' +
    '양끝 포함 일수(diff+1)를 7로 나눌 것.');
  assert.match(code, /86400000\s*\+\s*1\s*\)\s*\/\s*7/,
    '주차열 수는 (diff + 1) / 7 로 계산해야 한다');
});
