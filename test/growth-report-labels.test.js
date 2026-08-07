// test/growth-report-labels.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 성장기록 > 성장리포트 > "오늘의 학습 현황" — **라벨 정합** 계약.
//
// 왜 박제하는가 (2026-08-07, 사용자 지적):
//   기간을 6개월로 두면 한 카드(가로 200px 안쪽) 안에 이렇게 떴다.
//     · 좌측 KPI      완료율 100%
//     · 상단 문장     "이번 기간 27회 학습을 완료했습니다. 완료율은 100%입니다."
//     · 막대 하단     "완료 4일 / 180일 (2%)"
//   → **6개월 중 4일 공부한 학생이 "완료율 100%"를 읽는다.**
//
//   두 값 모두 **각자는 맞다**. 문제는 계산이 아니라 이름이었다.
//     · 항목(회) 기준 : daily_learning_progress 행 27개 중 27개 completed → 100%
//     · 날짜 기준     : 기간 180일 중 학습한 날 4일 → 2%
//   둘 다 지역 변수명이 `rate` 였고, 화면 라벨도 둘 다 "완료율"이었다.
//
//   ⚠ 이 부류는 기존 하네스가 원리적으로 못 잡는다 — 두 숫자 다 정확하고, DOM 도
//     정상이고, 콘솔 에러도 없다. **"맞는 숫자 두 개에 같은 이름을 붙였다"** 는
//     의미론적 결함이라 값 검사로는 절대 붉어지지 않는다. 그래서 라벨을 박제한다.
//
// 불변식:
//   INV-GR1  뜻이 다른 두 값이 같은 이름("완료율")으로 동시에 렌더되지 않는다 (+ 소스 락)
//   INV-GR2  4군데(KPI·문장·막대요약·인사이트)의 라벨이 서로 일관된다
//   INV-GR3  기간별 3형태(칩/히트맵/막대) 각각에 "지금 무엇을 보는지" 표기가 있다
//
// 검증 방식: 정규식 스캔이 아니라 **student-report.html 의 실제 렌더 함수를 잘라내
//   실행**하고 산출 HTML 을 본다. 문구를 바꿔도 뜻이 유지되면 통과하고, 뜻이 무너지면
//   붉어진다. (jsdom 없이 문자열 조립만 하는 함수들이라 순수 실행이 가능하다)
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'public', 'growth', 'student-report.html');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

// ── 렌더 함수 추출 ───────────────────────────────────────────────────────────
// fmtLocalDate ~ renderDailyLearningBody 까지가 연속 구간이다(그 다음이 독서 활동 카드).
const SLICE_FROM = '  function fmtLocalDate(d) {';
const SLICE_TO = '  function renderReadingActivityCard(report, areaData) {';

function sliceSource(src) {
  const a = src.indexOf(SLICE_FROM);
  const b = src.indexOf(SLICE_TO);
  assert.ok(a > 0 && b > a,
    '오늘의 학습 렌더 구간을 못 찾았다. 함수명이 바뀌었으면 이 테스트의 마커도 갱신할 것.');
  return src.slice(a, b);
}

/** 잘라낸 구간을 샌드박스에서 실행해 렌더 함수 묶음을 돌려준다. */
function loadRenderers(src, periodDays) {
  const code = sliceSource(src);
  const factory = new Function('currentPeriod', 'escapeHtml',
    code + '\n return { renderDailyLearningBody, dayCoverageLine,' +
    ' renderDailyCalendarA, renderDailyCalendarB, renderDailyCalendarC };');
  return factory(
    { days: periodDays, startDate: null, endDate: null },
    (s) => String(s == null ? '' : s)
  );
}

/** 오늘 기준으로 최근 k개 "학습한 날"을 만든다(간격을 벌려 연속일 오염 회피). */
function recentDays(k, stride = 9) {
  const out = [];
  const t = new Date(); t.setHours(0, 0, 0, 0);
  for (let i = 0; i < k; i++) {
    const d = new Date(t); d.setDate(d.getDate() - i * stride);
    out.push(fmt(d));
  }
  return out;
}
function fmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}

/** 사용자가 본 그 데이터: 6개월, 항목 27/27 완료, 학습한 날 4일. */
const USER_CASE = {
  dailyLearning: {
    total: 27, completed: 27, avgAccuracy: 82, maxStreak: 1,
    recentDays: recentDays(4)
  }
};

// 태그를 벗겨 "사용자가 실제로 읽는 글자"만 남긴다.
function textOf(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// INV-GR1 — 같은 이름으로 다른 뜻을 부르지 않는다
// ─────────────────────────────────────────────────────────────────────────────
test('INV-GR1: 사용자가 본 그 화면(6개월·27/27·4일)에 "완료율"이라는 이름이 없다', () => {
  const R = loadRenderers(SRC, 180);
  const html = R.renderDailyLearningBody(USER_CASE);
  const txt = textOf(html);

  assert.ok(!/완료율/.test(txt),
    '"완료율"은 항목 기준(100%)과 날짜 기준(2%) 어느 쪽을 가리키는지 알 수 없는 이름이다. ' +
    '6개월 중 4일 학습한 학생이 "완료율 100%"를 읽게 된다.\n실제 렌더: ' + txt);

  // 두 값 자체는 그대로 살아 있어야 한다 — 숫자를 지워서 통과시키면 안 된다.
  assert.ok(/100\s*%/.test(txt), '항목 기준 100% 가 사라졌다(숫자를 바꾸면 안 된다)');
  assert.ok(/2\s*%/.test(txt), '날짜 기준 2% 가 사라졌다(숫자를 바꾸면 안 된다)');
});

test('INV-GR1: 두 100%/2% 는 각각 다른 이름표를 달고 있다', () => {
  const R = loadRenderers(SRC, 180);
  const txt = textOf(R.renderDailyLearningBody(USER_CASE));

  // 항목 기준 100% 바로 곁에 "이수율"이, 날짜 기준 2% 바로 곁에 "날짜 기준"이 있어야 한다.
  assert.match(txt, /이수율[^%]{0,12}100\s*%|100\s*%[^%]{0,12}이수율/,
    '100% 에 "이수율"(항목 기준)이라는 이름이 붙어 있지 않다: ' + txt);
  assert.match(txt, /날짜 기준\s*2\s*%/,
    '2% 에 "날짜 기준"이라는 이름이 붙어 있지 않다: ' + txt);
});

test('INV-GR1 (소스 락): 실행되는 코드에 "완료율" 라벨이 되살아나지 않았다', () => {
  // 주석에는 사고 경위로 "완료율"이 인용돼 있으므로 실행 줄만 본다.
  const code = SRC.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.equal(/완료율/.test(code), false,
    'student-course 리포트 화면에서 "완료율"은 금지어다. 무엇의 비율인지 밝히는 이름을 쓸 것 ' +
    '(항목 기준 → "항목 이수율", 날짜 기준 → "학습한 날").');
});

test('INV-GR1 (소스 락): 오늘의 학습 구간에 뜻 모를 `rate` 변수가 없다', () => {
  const region = sliceSource(SRC).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.equal(/\b(const|let|var)\s+rate\s*=/.test(region), false,
    '항목 기준과 날짜 기준이 둘 다 `rate` 라는 이름을 쓰다가 화면 라벨까지 같아졌다. ' +
    'itemRate / dayRatio 처럼 무엇의 비율인지 드러나는 이름을 쓸 것.');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-GR2 — 4군데 라벨 일관
// ─────────────────────────────────────────────────────────────────────────────
test('INV-GR2: 4군데(KPI·문장·막대요약·인사이트)가 모두 기준을 밝힌다', () => {
  const R = loadRenderers(SRC, 180);
  const html = R.renderDailyLearningBody(USER_CASE);

  // ① 좌측 KPI 카드
  const kpi = html.match(/<div class="daily-stat-label">((?:(?!<\/div>).)*)/g) || [];
  const kpiText = kpi.map(textOf).join(' | ');
  assert.match(kpiText, /이수율/, '① KPI 카드 라벨이 항목 기준임을 밝히지 않는다: ' + kpiText);

  // ② 상단 문장
  const sentence = textOf((html.match(/class="daily-insight">([\s\S]*?)<\/div>/) || [])[1] || '');
  assert.ok(sentence, '② 상단 문장(.daily-insight)이 없다');
  assert.match(sentence, /이수율/, '② 문장이 항목 기준임을 밝히지 않는다: ' + sentence);
  assert.match(sentence, /학습/, '② 문장이 비었다: ' + sentence);
  // 문장은 날짜 기준도 함께 담아 100% 를 "기간 내내 했다"로 오독할 수 없게 한다.
  assert.match(sentence, /\d+\s*일/, '② 문장에 "며칠 학습했는지"가 없어 100% 가 홀로 읽힌다: ' + sentence);

  // ③ 막대 하단 요약
  const bar = textOf((html.match(/class="weekbar-summary"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
  assert.ok(bar, '③ 막대 하단 요약(.weekbar-summary)이 없다');
  assert.match(bar, /학습한 날/, '③ 막대 요약이 날짜 기준임을 밝히지 않는다: ' + bar);
  assert.match(bar, /날짜 기준/, '③ 막대 요약의 % 가 무엇의 비율인지 밝히지 않는다: ' + bar);

  // ④ 우측 인사이트 패널
  const side = textOf((html.match(/class="daily-side-panel">([\s\S]*)/) || [])[1] || '');
  assert.ok(side, '④ 인사이트 패널이 없다');
  assert.match(side, /항목 이수율/, '④ 인사이트 패널이 항목 기준임을 밝히지 않는다: ' + side);
  assert.match(side, /학습한 날/, '④ 인사이트 패널의 날짜 지표 이름이 다르다: ' + side);
});

test('INV-GR2: 항목 기준 라벨이 KPI·문장·인사이트에서 **같은 낱말**을 쓴다', () => {
  const R = loadRenderers(SRC, 180);
  const html = R.renderDailyLearningBody(USER_CASE);
  const kpi = textOf((html.match(/<div class="daily-stat-label">((?:(?!<\/div>).)*)/g) || []).join(' '));
  const sentence = textOf((html.match(/class="daily-insight">([\s\S]*?)<\/div>/) || [])[1] || '');
  const side = textOf((html.match(/class="daily-side-panel">([\s\S]*)/) || [])[1] || '');

  for (const [name, t] of [['KPI', kpi], ['문장', sentence], ['인사이트', side]]) {
    assert.match(t, /이수율/, name + ' 만 다른 낱말을 쓰면 같은 값이 다른 지표로 보인다: ' + t);
  }
});

test('INV-GR2: 날짜 기준 문구는 dayCoverageLine 한 곳에서만 나온다 (폼마다 갈라지지 않게)', () => {
  const region = sliceSource(SRC);
  const hits = (region.match(/학습한 날 <strong>/g) || []).length;
  assert.strictEqual(hits, 1,
    '날짜 기준 요약 문구가 ' + hits + '곳에 흩어져 있다. dayCoverageLine() 하나만 쓸 것 — ' +
    '흩어지면 폼(칩/히트맵/막대)마다 라벨이 갈라진다.');
});

test('INV-GR2: 세 폼 모두 같은 날짜 기준 요약 줄을 낸다', () => {
  const set = new Set(recentDays(4));
  const R = loadRenderers(SRC, 180);
  const outs = {
    'A(칩)': R.renderDailyCalendarA(7, set),
    'B(히트맵)': R.renderDailyCalendarB(30, set),
    'C(주별막대)': R.renderDailyCalendarC(180, set, 180),
    'C(월별막대)': R.renderDailyCalendarC(200, set, 'all'),
  };
  for (const [name, html] of Object.entries(outs)) {
    const t = textOf(html);
    assert.match(t, /학습한 날 \d+일 \/ \d+일/, name + ' 에 날짜 기준 요약이 없다: ' + t);
    assert.match(t, /날짜 기준 \d+%/, name + ' 의 % 가 무엇의 비율인지 밝히지 않는다: ' + t);
    assert.ok(!/완료율/.test(t), name + ' 에 금지어 "완료율"이 있다: ' + t);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-GR3 — 기간별 3형태 각각에 "지금 무엇을 보는지" 표기
// ─────────────────────────────────────────────────────────────────────────────
test('INV-GR3: 기간을 바꾸면 그림이 바뀌는 것을 제목이 알려준다', () => {
  // 기간 → 기대 형태. 사용자가 "이게 원래 의도한 거냐"고 물은 지점.
  const cases = [
    { days: 7,     form: 'A', hint: /일자별/ },
    { days: 30,    form: 'B', hint: /히트맵/ },
    { days: 90,    form: 'B', hint: /히트맵/ },
    { days: 180,   form: 'C', hint: /주별/ },
    { days: 'all', form: 'C', hint: /월별/ },
  ];
  for (const c of cases) {
    const R = loadRenderers(SRC, c.days);
    const html = R.renderDailyLearningBody(USER_CASE);
    const label = textOf((html.match(/class="calendar-label">([\s\S]*?)<\/div>\s*<div/) || [])[1] ||
                         (html.match(/class="calendar-label">([\s\S]*?)<\/div>/) || [])[1] || '');
    assert.ok(label, c.days + ': calendar-label 이 없다');
    assert.match(label, /현황/, c.days + ': 기간 표기가 사라졌다 — ' + label);
    assert.match(label, c.hint,
      c.days + ': 지금 보고 있는 그림의 형태(' + c.form + ')를 알려주지 않는다. ' +
      '기간만 바꿨는데 완전히 다른 그림이 나오면 "이게 맞냐"는 질문이 나온다. 실제: ' + label);
  }
});

test('INV-GR3: 폼 배지는 제목과 분리된 요소로 붙는다 (제목 문자열에 묻히지 않게)', () => {
  const R = loadRenderers(SRC, 180);
  const html = R.renderDailyLearningBody(USER_CASE);
  assert.match(html, /class="cal-form"/,
    '폼 표기는 .cal-form 배지로 렌더해야 스캔이 쉽다');
  assert.match(SRC, /#dailyLearningSection \.calendar-label \.cal-form\s*\{/,
    '.cal-form 스타일이 정의돼 있지 않다(라벨과 배지가 붙어 읽힌다)');
});

test('INV-GR3: 히트맵은 가로·세로 축이 무엇인지 화면에서 설명한다', () => {
  const set = new Set(recentDays(4));
  const R = loadRenderers(SRC, 30);
  const t = textOf(R.renderDailyCalendarB(30, set));
  assert.match(t, /가로/, '히트맵 가로축(주) 설명이 없다: ' + t);
  assert.match(t, /세로/, '히트맵 세로축(요일) 설명이 없다: ' + t);
  assert.match(t, /요일/, '세로가 요일이라는 설명이 없다: ' + t);
  // 범례(완료/미완료)는 그대로 유지 — 안내를 넣느라 지우면 안 된다.
  assert.match(t, /완료/, '히트맵 범례가 사라졌다: ' + t);
});

// ─────────────────────────────────────────────────────────────────────────────
// 회귀 — 숫자는 손대지 않았다 (이건 이름 문제였지 계산 문제가 아니다)
// ─────────────────────────────────────────────────────────────────────────────
test('숫자 보존: 항목 27/27 → 100%, 날짜 4/180 → 2% 그대로다', () => {
  const R = loadRenderers(SRC, 180);
  const txt = textOf(R.renderDailyLearningBody(USER_CASE));
  assert.match(txt, /항목 이수율 100\s*%|이수율\s*100\s*%/, '항목 이수율 100% 가 바뀌었다: ' + txt);
  assert.match(txt, /학습한 날 4일 \/ 180일/, '날짜 커버리지 4/180 이 바뀌었다: ' + txt);
  assert.match(txt, /날짜 기준 2\s*%/, '날짜 기준 2% 가 바뀌었다: ' + txt);
});

test('빈 상태: 기록이 없어도 라벨이 무너지지 않는다', () => {
  const R = loadRenderers(SRC, 180);
  const html = R.renderDailyLearningBody({ dailyLearning: { total: 0, completed: 0, recentDays: [] } });
  const txt = textOf(html);
  assert.ok(!/완료율/.test(txt), '빈 상태에도 금지어가 없어야 한다: ' + txt);
  assert.match(txt, /아직 오늘의 학습 기록이 없습니다/, '빈 상태 안내가 없다: ' + txt);
  assert.ok(!/\[object Object\]/.test(txt), '[object Object] 유출: ' + txt);
});
