// test/self-learn-path-ui.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [학습경로 탭 — 사용자 중심 재구성] 회귀 박제  (2026-08-07)
//
// 사용자 지적(실서버 스크린샷): "내 학습 경로에서 목록이 많다보니까 실제 학습해야 하는
// 목록이 매우 아래에 있음." — 진단 이력 9행(전부 진행률 0%)을 지나야 STEP 1 이 나왔다.
//
// 그래서 아래 5가지를 화면 계약으로 못 박는다. 하나라도 되돌리면 이 파일이 붉어진다.
//   INV-PU1  "지금 할 것"(히어로 카드)이 이력보다 **먼저** 렌더된다 (DOM 순서)
//   INV-PU2  이력은 **기본 접힘**이고, 항목이 많아도 첫 화면을 밀어내지 않는다
//   INV-PU3  잠긴 STEP 에 **눈에 보이는 잠금 사유 문구**가 있다 (예전엔 title 툴팁뿐)
//   INV-PU4  **강조(solid) CTA 는 1개**뿐이다 (히어로) — 목록 버튼은 아웃라인
//   INV-PU5  요약 수치가 서로 모순되지 않는다 — 통과 + 복습 필요 == 진단한 단원
//
// ⚠ INV-PU5 의 배경(숫자 모순의 진짜 원인):
//   BE(db/self-learn-extended.js getRecommendedPathBySession) 의 summary 는
//     totalNodes  = pathNodes.length            → **경로 STEP 수**
//     passedNodes = diagByNode 중 passed        → **진단에서 응답한 단원 중 통과**
//     failedNodes = diagByNode 중 !passed       → 〃 미통과
//   즉 totalNodes 와 passed/failed 는 **서로 다른 집합**이다(경로는 통과 단원을 제외하고
//   목표 단원을 포함하므로). 그런데 FE 가 totalNodes 를 "진단 단원"이라 불러
//   "진단 단원 3개 · 통과 1 · 복습 필요 3"(1+3=4≠3) 이 그대로 노출됐다.
//   → BE 산식은 정상. **FE 라벨/정의만** 고쳤다(진단한 단원 = 통과+복습필요).
//   실측 재현(격리 사본): student1 세션 705 → totalNodes=2, passed=0, failed=1.
//
// 렌더 함수는 모놀리스 HTML 안에 있으므로, test/growth-report-labels.test.js 와 같은
// 방식으로 소스 구간을 잘라 샌드박스에서 실행해 **실제 산출 HTML**을 검사한다.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'public', 'self-learn', 'learning-map.html');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const SLICE_FROM = 'let _pathTabSessionId = null;';
const SLICE_TO = '// (보존·미사용) 구 BFS 경로 생성';

/** 학습경로 탭 렌더 구간을 샌드박스에서 실행해 렌더러 묶음을 돌려준다. */
function loadPathUi() {
  const a = SRC.indexOf(SLICE_FROM);
  const b = SRC.indexOf(SLICE_TO);
  assert.ok(a > 0 && b > a,
    '학습경로 탭 렌더 구간을 못 찾았다. 함수/마커가 바뀌었으면 이 테스트의 마커도 갱신할 것.');
  const code = SRC.slice(a, b);

  // 가짜 DOM — innerHTML 만 받아 두는 상자
  const boxes = { pathContainer: { innerHTML: '' }, phListWrap: { innerHTML: '' } };
  const fakeDoc = {
    getElementById: (id) => boxes[id] || null,
    querySelector: () => null
  };

  const factory = new Function(
    'document', '$', 'escHtml', '_recPathGradeClass', '_recPathGroupLabel', 'fetchApi', 'showToast',
    code +
    '\n return {' +
    '   renderBody: _renderPathTabBody,' +
    '   renderHistory: _renderPathHistoryList,' +
    '   toggleHistory: togglePathHistory,' +
    '   showAll: showAllPathHistory,' +
    '   buildGroups: _phBuildGroups,' +
    '   toggleMerged: togglePhMerged,' +
    '   lockWhy: _pathLockWhy,' +
    '   setHistory: (list, sel) => { _pathHistory = list; _pathHistorySel = sel != null ? sel : null; },' +
    '   setViewingSession: (id) => { _pathTabSessionId = id; }' +
    ' };'
  );

  const api = factory(
    fakeDoc,
    (id) => boxes[id] || null,
    (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    (grade) => 'g-' + (grade || 0),
    (g) => g.label || '',
    async () => ({ success: false }),
    () => {}
  );
  api.boxes = boxes;
  return api;
}

// ── 픽스처 ───────────────────────────────────────────────────────────────────
// 사용자가 실제로 본 그 데이터: 경로 STEP 3개(전부 0%), 진단 단원은 4개(통과 1·복습 3).
function fixtureUserCase() {
  return {
    success: true,
    hasDiagnosis: true,
    session: { id: 900, diagnosedAt: '2026-08-07 09:10:00' },
    targetNode: { nodeId: 'N3', title: '소수의 나눗셈(2)' },
    summary: {
      totalNodes: 3, passedNodes: 1, failedNodes: 3,
      averageCorrectRate: 0.31, progressPercent: 0,
      completedCount: 0, inProgressCount: 0, pendingCount: 2, lockedCount: 1
    },
    groups: [
      {
        groupKey: 'g1', label: '초등 5학년 2학기 · 수와 연산', grade: 5, semester: 2, area: '수와 연산',
        steps: [
          {
            step: 1, nodeId: 'N1', title: '소수의 곱셈',
            diagResult: { passed: false, correctCount: 1, totalCount: 4, correctRate: 0.25 },
            progressStatus: 'pending', progressLabel: '미시작',
            lessons: { total: 15, completed: 0 }, estimatedMinutes: 75,
            isTarget: false, lockReason: null, conceptHint: '(1보다 작은 소수)×(자연수) 개념부터'
          },
          {
            step: 2, nodeId: 'N2', title: '소수의 나눗셈(1)',
            diagResult: { passed: false, correctCount: 0, totalCount: 4, correctRate: 0 },
            progressStatus: 'pending', progressLabel: '미시작',
            lessons: { total: 14, completed: 0 }, estimatedMinutes: 70,
            isTarget: false, lockReason: null
          }
        ]
      },
      {
        groupKey: 'g2', label: '초등 6학년 2학기 · 수와 연산', grade: 6, semester: 2, area: '수와 연산',
        steps: [
          {
            step: 3, nodeId: 'N3', title: '소수의 나눗셈(2)',
            diagResult: null,
            progressStatus: 'locked', progressLabel: '잠금',
            lessons: { total: 12, completed: 0 }, estimatedMinutes: 60,
            isTarget: true, lockReason: '앞 STEP을 모두 완료하면 풀려요'
          }
        ]
      }
    ]
  };
}

// 이력 12건 — 같은 날 같은 단원 재진단(중복) 2건 + 진행 중 1건 포함
function fixtureHistory() {
  const rows = [];
  rows.push({ sessionId: 900, diagnosedAt: '2026-08-07 09:10:00', targetUnitName: '소수의 나눗셈(2)', gradeLabel: '초6-2', area: '수와 연산', progressPercent: 0 });
  rows.push({ sessionId: 890, diagnosedAt: '2026-08-06 23:00:00', targetUnitName: '(세 자리 수)×(두 자리 수)', gradeLabel: '초3-2', area: '수와 연산', progressPercent: 0 });
  rows.push({ sessionId: 889, diagnosedAt: '2026-08-06 23:00:00', targetUnitName: '십만, 백만, 천만', gradeLabel: '초4-1', area: '수와 연산', progressPercent: 0 });
  rows.push({ sessionId: 888, diagnosedAt: '2026-08-06 23:00:00', targetUnitName: '꺾은선그래프', gradeLabel: '초4-2', area: '자료와 가능성', progressPercent: 40 });
  rows.push({ sessionId: 870, diagnosedAt: '2026-06-15 10:00:00', targetUnitName: '분수의 덧셈', gradeLabel: '초5-1', area: '수와 연산', progressPercent: 0 });
  rows.push({ sessionId: 861, diagnosedAt: '2026-06-09 11:00:00', targetUnitName: '평면도형의 이동', gradeLabel: '초4-1', area: '도형', progressPercent: 0 });
  rows.push({ sessionId: 860, diagnosedAt: '2026-06-09 10:00:00', targetUnitName: '평면도형의 이동', gradeLabel: '초4-1', area: '도형', progressPercent: 0 });
  rows.push({ sessionId: 855, diagnosedAt: '2026-06-08 10:00:00', targetUnitName: '각도', gradeLabel: '초4-1', area: '측정', progressPercent: 0 });
  rows.push({ sessionId: 850, diagnosedAt: '2026-06-07 10:00:00', targetUnitName: '곱셈과 나눗셈', gradeLabel: '초3-1', area: '수와 연산', progressPercent: 0 });
  rows.push({ sessionId: 845, diagnosedAt: '2026-06-06 10:00:00', targetUnitName: '분수와 소수', gradeLabel: '초3-2', area: '수와 연산', progressPercent: 0 });
  rows.push({ sessionId: 840, diagnosedAt: '2026-06-05 10:00:00', targetUnitName: '들이와 무게', gradeLabel: '초3-2', area: '측정', progressPercent: 0 });
  rows.push({ sessionId: 835, diagnosedAt: '2026-06-04 10:00:00', targetUnitName: '시간의 덧셈', gradeLabel: '초3-1', area: '측정', progressPercent: 0 });
  return rows;
}

const countOf = (html, needle) => html.split(needle).length - 1;

// ─────────────────────────────────────────────────────────────────────────────
test('INV-PU1 "지금 할 것"(히어로)이 이력보다 먼저 온다 — 정적 DOM 순서', () => {
  const iPath = SRC.indexOf('id="pathContainer"');
  const iHist = SRC.indexOf('id="phListWrap"');
  assert.ok(iPath > 0, '#pathContainer 가 없다');
  assert.ok(iHist > 0, '#phListWrap 이 없다');
  assert.ok(iPath < iHist,
    '학습경로 탭에서 이력(#phListWrap)이 본문(#pathContainer)보다 위에 있다. ' +
    '학생이 과거 이력을 지나야 "지금 할 것"에 닿게 되므로 순서를 되돌리지 말 것.');
});

test('INV-PU1 히어로 카드가 STEP 목록·개요보다 먼저 렌더된다 — 산출 HTML 순서', () => {
  const ui = loadPathUi();
  ui.renderBody(fixtureUserCase());
  const html = ui.boxes.pathContainer.innerHTML;

  const iHero = html.indexOf('pt-hero');
  const iOverview = html.indexOf('pt-overview');
  const iStep = html.indexOf('rp-step ');
  assert.ok(iHero >= 0, '히어로 카드(.pt-hero)가 렌더되지 않았다');
  assert.ok(iOverview >= 0, '개요 스트립(.pt-overview)이 렌더되지 않았다');
  assert.ok(iStep >= 0, 'STEP 카드가 렌더되지 않았다');
  assert.ok(iHero < iOverview, '히어로가 개요 스트립보다 뒤에 있다');
  assert.ok(iHero < iStep, '히어로가 STEP 목록보다 뒤에 있다');

  // 히어로에는 실제 다음 단원(STEP 1)이 담겨야 한다
  assert.ok(/pt-hero-title[^>]*>소수의 곱셈</.test(html), '히어로에 첫 학습 단원명이 없다');
  assert.ok(html.includes('지금은 여기부터'), '히어로에 "지금은 여기부터" 안내가 없다');
  // 히어로로 올린 STEP 은 목록에서 중복 노출하지 않는다
  assert.equal(countOf(html, '>소수의 곱셈<'), 1, '히어로 단원이 목록에도 중복 렌더됐다');
});

test('INV-PU2 이력은 기본 접힘이고 첫 화면을 밀어내지 않는다', () => {
  const ui = loadPathUi();
  const hist = fixtureHistory();
  ui.setHistory(hist, 900);

  ui.renderHistory();
  const collapsed = ui.boxes.phListWrap.innerHTML;
  assert.ok(collapsed.includes('ph-toggle'), '이력 접기/펼치기 버튼이 없다');
  assert.ok(collapsed.includes('aria-expanded="false"'), '이력이 기본 펼침 상태다(접혀 있어야 한다)');
  assert.equal(countOf(collapsed, 'data-session="'), 0,
    '접힌 상태인데 이력 항목이 렌더됐다 — 12건이 본문을 밀어낸다');
  assert.ok(collapsed.includes('12개'), '접힌 버튼에 이력 건수 안내가 없다');

  // 펼치면 보이되, 한 번에 쏟아내지 않는다(미리보기 + 더 보기)
  ui.toggleHistory();
  const opened = ui.boxes.phListWrap.innerHTML;
  const openRows = countOf(opened, 'data-session="');
  assert.ok(opened.includes('aria-expanded="true"'), '펼친 뒤에도 aria-expanded 가 false 다');
  assert.ok(openRows > 0, '펼쳤는데 이력 항목이 없다');
  assert.ok(openRows <= 8, `펼침 즉시 ${openRows}행을 쏟아낸다 — 미리보기(더 보기)로 잘라야 한다`);
  assert.ok(opened.includes('ph-more'), '"더 보기" 버튼이 없다');

  // 더 보기 → 전량
  ui.showAll();
  const all = ui.boxes.phListWrap.innerHTML;
  assert.ok(countOf(all, 'data-session="') > openRows, '"더 보기"를 눌렀는데 항목이 늘지 않았다');

  // 다시 접으면 원상복귀
  ui.toggleHistory();
  assert.equal(countOf(ui.boxes.phListWrap.innerHTML, 'data-session="'), 0, '접었는데 항목이 남아 있다');
});

test('INV-PU2b 이력 정리 — 같은 날 같은 단원은 병합, 진행 중은 앞으로, 날짜로 묶는다', () => {
  const ui = loadPathUi();
  const hist = fixtureHistory();
  const { inProgress, dateGroups } = ui.buildGroups(hist, 900);

  // 6월 9일 "평면도형의 이동" 2건(861·860)은 1행으로 병합
  const flat = dateGroups.reduce((a, g) => a.concat(g.items), []);
  const move = flat.filter(m => m.p.targetUnitName === '평면도형의 이동');
  assert.equal(move.length, 1, '같은 날 같은 단원 재진단이 여러 행으로 남아 있다');
  assert.equal(move[0].count, 2, '병합 건수(재진단 횟수)가 집계되지 않았다');

  // 진행 중(40%)인 꺾은선그래프는 별도 섹션으로 앞에
  assert.equal(inProgress.length, 1, '진행 중 항목이 앞으로 분리되지 않았다');
  assert.equal(inProgress[0].p.targetUnitName, '꺾은선그래프');

  // 날짜 그룹 — 8월 6일에 같은 시각 2건(진행 중 1건은 위로 빠짐)이 한 그룹으로 묶인다
  const aug6 = dateGroups.find(g => g.label === '8월 6일');
  assert.ok(aug6, '8월 6일 날짜 그룹이 없다');
  assert.equal(aug6.items.length, 2, '같은 날 진단이 날짜 그룹으로 묶이지 않았다');

  // 전체 행 수는 원본 12건보다 줄어야 한다(중복 병합 효과)
  assert.ok(flat.length + inProgress.length < hist.length,
    '중복 병합이 전혀 일어나지 않았다');
});

test('INV-PU3 잠긴 STEP 에 눈에 보이는 잠금 사유가 있다', () => {
  const ui = loadPathUi();
  ui.renderBody(fixtureUserCase());
  const html = ui.boxes.pathContainer.innerHTML;

  assert.ok(html.includes('pt-lock-why'),
    '잠금 사유가 화면 문구로 없다(title 툴팁만으로는 학생이 알 수 없다)');
  assert.ok(/pt-lock-why[^>]*>[^<]*열려요/.test(html), '잠금 사유 문구에 "열려요" 안내가 없다');

  // 앞의 미완료 STEP 이 2개면 "앞의 STEP 2개를 모두 마치면 열려요"
  const data = fixtureUserCase();
  const flat = data.groups.reduce((a, g) => a.concat(g.steps), []);
  const locked = flat.find(s => s.progressStatus === 'locked');
  assert.equal(ui.lockWhy(locked, flat), '앞의 STEP 2개를 모두 마치면 열려요');

  // 앞의 미완료 STEP 이 1개면 그 번호를 짚어 준다(조사 을/를 포함)
  const flat2 = [
    { step: 1, progressStatus: 'completed' },
    { step: 2, progressStatus: 'pending' },
    { step: 3, progressStatus: 'locked' }
  ];
  assert.equal(ui.lockWhy(flat2[2], flat2), 'STEP 2를 마치면 열려요');
});

test('INV-PU4 강조(solid) CTA 는 화면에 1개뿐이다', () => {
  const ui = loadPathUi();
  ui.renderBody(fixtureUserCase());
  const html = ui.boxes.pathContainer.innerHTML;

  const strong = countOf(html, 'pt-hero-cta') + countOf(html, 'pt-btn-main') + countOf(html, 'rp-btn-primary');
  assert.equal(strong, 1, `강조 CTA 가 ${strong}개다 — 히어로 1개만 강조하고 나머지는 톤 다운해야 한다`);
  assert.equal(countOf(html, 'pt-hero-cta'), 1, '강조 CTA 1개는 히어로의 학습 시작 버튼이어야 한다');
  // 목록 STEP 버튼은 아웃라인
  assert.ok(countOf(html, 'rp-btn-outline') >= 1, '목록 STEP 버튼이 아웃라인 톤이 아니다');
  // 보조 액션(전체 담기)은 링크 톤
  assert.ok(html.includes('pt-link-btn'), '"전체를 학습목록에 담기"가 보조 링크 톤이 아니다');
  assert.equal(countOf(html, 'pt-btn-secondary'), 0, '하단에 회색 버튼이 남아 있다(링크 톤으로 대체됐어야 한다)');
});

test('INV-PU5 요약 수치가 모순되지 않는다 — 통과 + 복습 필요 == 진단한 단원', () => {
  const ui = loadPathUi();
  ui.renderBody(fixtureUserCase());
  const html = ui.boxes.pathContainer.innerHTML;

  const m = html.match(/진단한 단원 (\d+)개 \(통과 (\d+) · 복습 필요 (\d+)\)/);
  assert.ok(m, '개요 스트립에서 진단 요약 문구를 찾지 못했다');
  const [, totalTxt, passTxt, failTxt] = m;
  assert.equal(Number(passTxt) + Number(failTxt), Number(totalTxt),
    `요약 수치 모순: 통과 ${passTxt} + 복습 필요 ${failTxt} != 진단한 단원 ${totalTxt}`);
  assert.equal(Number(totalTxt), 4, '진단한 단원은 통과(1)+복습필요(3)=4 여야 한다');

  // 경로 STEP 수(3)를 "진단 단원"이라 부르던 옛 라벨이 되살아나면 안 된다
  assert.ok(!/진단 단원 \d+개/.test(html),
    '경로 STEP 수를 "진단 단원"이라 부르는 옛 라벨이 남아 있다(1+3=4≠3 모순의 원인)');
  // 경로 STEP 수는 진행률 문구가 담당
  assert.ok(html.includes('0/3 단원 완료'), '경로 STEP 수(0/3 단원 완료)가 표시되지 않았다');

  // 같은 정의를 추천경로 모달도 공유해야 한다(두 화면이 다른 말을 하면 안 됨)
  assert.ok(!/진단 단원 \$\{sm\.totalNodes/.test(SRC),
    '추천경로 모달에 옛 라벨(진단 단원 = totalNodes)이 남아 있다');
});

test('빈 상태 — 진단 이력이 없는 학생에게 다음 행동을 안내한다', () => {
  const ui = loadPathUi();
  ui.setHistory([], null);
  ui.renderBody({ success: true, hasDiagnosis: false, groups: [] });
  const html = ui.boxes.pathContainer.innerHTML;

  assert.ok(html.includes('아직 학습 경로가 없어요'), '빈 상태 제목이 없다');
  assert.ok(html.includes('pt-empty-cta'), '빈 상태에 진단검사 CTA 가 없다');
  assert.ok(html.includes('① 진단검사 풀기'), '빈 상태에 진행 단계 안내가 없다');

  ui.renderHistory();
  assert.equal(ui.boxes.phListWrap.innerHTML, '', '이력 0건인데 이력 영역이 그려졌다');
});

test('전부 완료 — 히어로 없이 축하 배너, 강조 CTA 0개', () => {
  const ui = loadPathUi();
  const data = fixtureUserCase();
  data.groups.forEach(g => g.steps.forEach(s => { s.progressStatus = 'completed'; s.progressLabel = '완료'; }));
  data.summary.completedCount = 3;
  data.summary.pendingCount = 0;
  data.summary.lockedCount = 0;
  data.summary.progressPercent = 100;
  ui.renderBody(data);
  const html = ui.boxes.pathContainer.innerHTML;

  assert.equal(countOf(html, 'pt-hero-cta'), 0, '모두 완료인데 "지금 할 것" 히어로가 떴다');
  assert.ok(html.includes('모두 끝냈어요'), '완료 축하 배너가 없다');
  const strong = countOf(html, 'pt-hero-cta') + countOf(html, 'pt-btn-main') + countOf(html, 'rp-btn-primary');
  assert.equal(strong, 0, '완료 화면에 강조 CTA 가 남아 있다');
  assert.equal(countOf(html, '>소수의 곱셈<'), 1, '완료 화면에서 STEP 이 누락되거나 중복됐다');
});

test('지난 경로를 열람 중이면 최신 경로로 돌아가는 동선을 준다', () => {
  const ui = loadPathUi();
  ui.setHistory(fixtureHistory(), 870);
  ui.setViewingSession(870);
  const data = fixtureUserCase();
  data.session.id = 870;
  ui.renderBody(data);
  const html = ui.boxes.pathContainer.innerHTML;

  assert.ok(html.includes('pt-stale-bar'), '지난 진단 경로를 보는데 안내가 없다');
  assert.ok(html.includes('최신 경로 보기'), '최신 경로로 돌아가는 버튼이 없다');
  assert.ok(html.indexOf('pt-stale-bar') < html.indexOf('pt-hero'), '안내가 히어로보다 뒤에 있다');
});

test('본문 글자 크기가 공통 스케일을 지킨다 — 학습경로 탭 신규 CSS 12px 이하 금지', () => {
  const block = SRC.slice(SRC.indexOf('.rp-scope .pt-hero{'), SRC.indexOf('.ph-more:focus-visible'));
  assert.ok(block.length > 200, '학습경로 탭 신규 CSS 구간을 찾지 못했다');
  const sizes = [...block.matchAll(/font-size:(\d+)px/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 0, 'font-size 선언을 찾지 못했다');
  const tooSmall = sizes.filter(v => v < 13);
  assert.deepEqual(tooSmall, [], `12px 이하 글자가 있다: ${tooSmall.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2026-08-20 감리 지적 반영분 회귀 박제
// ═════════════════════════════════════════════════════════════════════════════

// INV-PU6 (감리 B-a) — 병합으로 밀려난 세션에 **가는 길**이 있어야 한다.
//   같은 날·같은 단원을 1행으로 접는 것은 읽기 편하자고 하는 일이지,
//   그 세션을 못 열게 만들자는 게 아니다. "더 보기"로도 복구되지 않으면 정보 삭제다.
test('INV-PU6 병합된 재진단 세션을 펼쳐서 열 수 있다 (정보 손실 금지)', () => {
  const ui = loadPathUi();
  ui.setHistory(fixtureHistory(), 900);
  ui.toggleHistory();                     // 이력 펼침
  ui.showAll();                           // 미리보기 잘림 해제(6/9 그룹까지 보이게)
  const before = ui.boxes.phListWrap.innerHTML;

  // 전제 — 6/9 "평면도형의 이동" 2건(861·860)이 1행으로 병합돼 861 만 보인다
  assert.ok(before.includes('재진단 2회'), '전제 — 재진단 병합 배지가 있어야');
  assert.equal(countOf(before, 'data-session="861"'), 1, '전제 — 대표 세션 861 은 보여야');
  assert.equal(countOf(before, 'data-session="860"'), 0, '전제 — 밀려난 세션 860 은 접혀 있어야');

  // 밀려난 세션으로 가는 버튼이 있어야 한다
  assert.ok(before.includes('ph-sub-toggle'), '병합된 세션을 펼치는 버튼(.ph-sub-toggle)이 없다');
  assert.ok(before.includes('이전 시도 1개 보기'), '펼치기 버튼 문구가 몇 개인지 알려주지 않는다');

  // 펼치면 실제로 열 수 있는 행(onclick=selectPathHistory)이 나온다
  const key = '2026-6-9|평면도형의 이동';
  ui.toggleMerged(key);
  const after = ui.boxes.phListWrap.innerHTML;
  assert.equal(countOf(after, 'data-session="860"'), 1, '펼쳤는데 밀려난 세션 860 이 나오지 않는다');
  assert.ok(after.includes('selectPathHistory(860)'), '밀려난 세션을 여는 동선(클릭)이 없다');
  assert.ok(after.includes('이전 시도 접기'), '다시 접는 문구가 없다(복귀 동선)');

  // 다시 접으면 원상복귀 — 목록이 도로 길어지지 않는다
  ui.toggleMerged(key);
  assert.equal(countOf(ui.boxes.phListWrap.innerHTML, 'data-session="860"'), 0, '접었는데 남아 있다');
});

// INV-PU7 (감리 B-c) — 이번 재구성이 죽인 "📍 지금 여기!" 핀은 되살아나면 안 된다.
//   히어로 카드가 현재 위치를 전담한다. 목록에도 핀이 뜨면 강조가 두 곳에서 경쟁한다.
test('INV-PU7 "지금 여기!" 핀 죽은 코드가 남아 있지 않다', () => {
  assert.equal(SRC.includes('pt-here-pin'), false, '.pt-here-pin (핀) 이 되살아났다 — 히어로와 중복 강조');
  assert.equal(SRC.includes('isHere'), false, '호출부가 없는 isHere 분기가 되살아났다(죽은 코드)');
  // 주석의 서술(제거 경위 기록)은 허용하되, **렌더되는 마크업**으로 되살아나면 안 된다
  assert.equal(SRC.includes('지금 여기!</span>'), false, '"지금 여기!" 핀 마크업이 되살아났다');
});

// INV-PU8 (감리 B-e) — 모바일에서 히어로 CTA 가 접힘선에 걸리지 않도록 한 조치가 남아야 한다.
//   실측(375×812): 조치 전 ctaBottom 808 / 폴드까지 4px. 실기기 브라우저 크롬(≈100px)이면 접힘 아래.
test('INV-PU8 모바일 폴드 확보 조치가 남아 있다 — 대시보드 기본 접힘 + 히어로 축소', () => {
  // ① 사용자가 고른 적이 없을 때만, 모바일에서 상단 대시보드를 접은 채 시작한다
  assert.ok(/matchMedia\('\(max-width: 767px\)'\)\.matches/.test(SRC),
    '모바일 기본 접힘 판정(matchMedia 767px)이 사라졌다');
  assert.ok(/stored === null \? defaultCollapsed : stored === '1'/.test(SRC),
    '사람이 고른 값이 항상 우선해야 한다(저장값 우선 분기가 사라졌다)');

  // ② 767px 이하에서 히어로 안팎 여백을 줄인 선언이 남아야 한다
  const mq = SRC.slice(SRC.indexOf('@media (max-width: 767px) {'));
  const block = mq.slice(0, mq.indexOf('}\n') > 0 ? mq.indexOf('\n    }') : 2000);
  assert.ok(/\.rp-scope \.pt-hero\{padding:16px 16px;margin-bottom:14px\}/.test(block),
    '모바일 히어로 축소(padding/margin)가 사라졌다');
  assert.ok(/\.rp-scope \.pt-hero-cta\{[^}]*margin-top:12px/.test(block),
    '모바일 CTA 상단 여백 축소가 사라졌다');
  assert.ok(/\.path-container\.rp-scope\{padding-top:14px\}/.test(block),
    '모바일 경로 컨테이너 상단 여백 축소가 사라졌다');
});
