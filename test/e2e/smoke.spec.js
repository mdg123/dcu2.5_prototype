// @ts-check
// test/e2e/smoke.spec.js
// ─────────────────────────────────────────────────────────────────────────────
// 화면 깨짐 자동 검출 스모크. 역할별(student1/teacher1/admin) 주요 화면을 순회하며
// "사람이 눈으로 보던 깨짐" 5종을 기계가 잡는다.
//
//   (A) [object Object] 텍스트 0건 (body.innerText)
//   (B) 콘솔 error 0건 (JS 에러; 무해한 외부 리소스 404 등은 화이트리스트 허용)
//   (C) 가로 스크롤 0 (scrollWidth <= clientWidth) — 데스크탑 1440 + 모바일 375
//   (D) 깨진 백분율 0 (1000%+ 표기 없음; avg_score 8000% 부류)
//   (E) 빈 화면 아님 (공통 GNB 또는 주요 컨테이너 존재 + 본문 텍스트 존재)
//
//   권한 리다이렉트(접근 불가 화면)는 정상으로 처리 → 검사 스킵.
//
//   실행: npx playwright test --config=test/e2e/smoke.config.js
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require('@playwright/test');
const path = require('path');

const STATE_DIR = path.join(__dirname, '.smoke-state');
const stateFor = (role) => path.join(STATE_DIR, `${role}.json`);
const BASE_URL = 'http://localhost:3100'; // smoke.config.js 의 PORT 와 동일

// ── 콘솔 error 화이트리스트: 무해한 외부 리소스/네트워크 잡음만 허용 ──
//    (JS 런타임 에러·정의되지 않은 변수·TypeError 등은 절대 허용하지 않는다)
const CONSOLE_WHITELIST = [
  /favicon\.ico/i,
  /net::ERR_/i,                 // 외부 리소스 네트워크 실패(폰트 CDN 등)
  /Failed to load resource.*\b(40[34]|503)\b/i, // 외부 정적자원 404/403/503
  /the server responded with a status of 40[34]/i,
  /chrome-extension:/i,
  /Download the React DevTools/i,
];

function isWhitelisted(text) {
  return CONSOLE_WHITELIST.some((re) => re.test(text));
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
];

// 깨진 값: 1000% 이상 백분율(예: 8000%) + NaN(예: NaN%·NaN점). 정상 범위(0~999%)는 통과.
// NaN은 한국어 UI에 정상 등장하지 않으므로 리터럴로 검출(참여도 객체 합산 등 FE 계산 깨짐 부류).
const BROKEN_PCT_RE = /\b[1-9]\d{3,}\s*%|NaN/;

/**
 * 한 화면(URL)을 두 뷰포트에서 열고 5종 검출을 수행한다.
 * 권한 리다이렉트(login.html / 다른 경로)면 스킵으로 간주.
 */
async function checkScreen(browser, statePath, url, label) {
  const context = await browser.newContext({
    storageState: statePath,
    locale: 'ko-KR',
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    for (const vp of VIEWPORTS) {
      const page = await context.newPage();
      page.setViewportSize({ width: vp.width, height: vp.height });

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const t = msg.text();
          if (!isWhitelisted(t)) consoleErrors.push(`[${vp.name}] ${t}`);
        }
      });
      // 처리되지 않은 JS 예외(uncaught) — 화이트리스트 없이 무조건 실패
      page.on('pageerror', (err) => {
        pageErrors.push(`[${vp.name}] ${err.message}`);
      });

      const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });

      // 권한 리다이렉트 → 스킵 처리.
      //   ① login.html 로 튕김 / 403
      //   ② 보호 화면이 비권한 사용자를 포털(/)로 되돌림 (예: admin/index.html → '/').
      //      요청 경로가 '/'(포털)가 아니었는데 '/'로 착지하면 권한 리다이렉트로 간주.
      await page.waitForTimeout(150); // location.replace 반영 여유
      const landed = page.url();
      const reqPath = new URL(url, 'http://x').pathname;
      const landedPath = (() => { try { return new URL(landed).pathname; } catch (_) { return landed; } })();
      const redirectedToPortal = reqPath !== '/' && reqPath !== '/index.html'
        && (landedPath === '/' || landedPath === '/index.html');
      if (/\/login\.html/i.test(landed) || (resp && resp.status() === 403) || redirectedToPortal) {
        test.info().annotations.push({ type: 'skip-screen', description: `${label}: 권한 리다이렉트(${landed})` });
        await page.close();
        await context.close();
        return { skipped: true };
      }

      // 동적 렌더 안정화: 공통 GNB 주입 + 네트워크 유휴 대기 (best-effort)
      await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800); // fetch 채움/차트 렌더 여유

      // ── (E) 빈 화면 아님: GNB 또는 주요 컨테이너 + 본문 텍스트 ──
      const skeleton = await page.evaluate(() => {
        const hasGnb = !!document.querySelector('#dacheum-gnb-wrapper');
        const hasMain = !!document.querySelector('main, .main-content, .container, [class*="content"]');
        const textLen = (document.body.innerText || '').trim().length;
        return { hasGnb, hasMain, textLen };
      });
      expect.soft(skeleton.hasGnb || skeleton.hasMain, `${label} [${vp.name}] (E)빈화면: GNB/컨테이너 없음`).toBeTruthy();
      expect.soft(skeleton.textLen, `${label} [${vp.name}] (E)빈화면: 본문 텍스트 거의 없음(${skeleton.textLen}자)`).toBeGreaterThan(50);

      // ── (A) [object Object] 0건 ──
      const objObjCount = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return (t.match(/\[object Object\]/g) || []).length;
      });
      expect.soft(objObjCount, `${label} [${vp.name}] (A)[object Object] ${objObjCount}건 발견`).toBe(0);

      // ── (D) 깨진 값(1000%+ / NaN) 0건 ──
      const brokenPct = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const re = /\b[1-9]\d{3,}\s*%|NaN/g;
        return t.match(re) || [];
      });
      expect.soft(brokenPct.length, `${label} [${vp.name}] (D)깨진 값(8000%/NaN) 발견: ${JSON.stringify(brokenPct)}`).toBe(0);

      // ── (C) 가로 스크롤 0 ──
      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
      });
      // 1px 반올림 오차 허용
      expect.soft(
        overflow.scrollWidth,
        `${label} [${vp.name}] (C)가로 스크롤: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);

      await page.close();
    }
  } finally {
    await context.close();
  }

  // ── (B) 콘솔/페이지 JS 에러 0건 (두 뷰포트 누적) ──
  const allErrors = [...pageErrors, ...consoleErrors];
  expect.soft(allErrors.length, `${label} (B)콘솔/JS 에러:\n${allErrors.join('\n')}`).toBe(0);

  return { skipped: false, consoleErrors, pageErrors };
}

/**
 * 모달이 있는 화면: 화면 5종 검사 후 대표 모달 1개를 열어 그 안도 4종(A·B·C·D) 검사.
 * (겹침/잘림은 범위 밖) 데스크탑 1440에서만 모달을 연다(모바일 모달은 동일 마크업).
 *   opener: 모달을 여는 selector(클릭) 또는 'eval:<js>' (페이지 컨텍스트 실행)
 *   modalSel: 열린 모달 컨테이너 selector (active/표시 상태)
 */
async function checkScreenWithModal(browser, statePath, url, label, opener, modalSel) {
  // 1) 먼저 일반 화면 검사 (스킵이면 그대로 반환)
  const base = await checkScreen(browser, statePath, url, label);
  if (base.skipped) return base;

  // 2) 데스크탑에서 모달 열어 내부 검사
  const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
  const modalErrors = [];
  try {
    const page = await context.newPage();
    page.setViewportSize({ width: 1440, height: 900 });
    page.on('console', (msg) => {
      if (msg.type() === 'error') { const t = msg.text(); if (!isWhitelisted(t)) modalErrors.push(`[modal] ${t}`); }
    });
    page.on('pageerror', (err) => { modalErrors.push(`[modal] ${err.message}`); });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);

    let opened = false;
    if (opener.startsWith('eval:')) {
      opened = await page.evaluate((js) => { try { return !!eval(js) || true; } catch (_) { return false; } }, opener.slice(5)).catch(() => false);
    } else {
      const el = await page.$(opener);
      if (el) { await el.click().catch(() => {}); opened = true; }
    }

    // 모달이 안 열리면(데이터 없음 등) 모달 검사는 정상 스킵 — 화면 검사는 이미 통과
    const shown = opened
      ? await page.waitForSelector(`${modalSel}:visible, ${modalSel}.active, ${modalSel}.show, ${modalSel}[style*="flex"], ${modalSel}[style*="block"]`, { timeout: 5000 }).then(() => true).catch(() => false)
      : false;
    if (!shown) {
      test.info().annotations.push({ type: 'modal-skip', description: `${label}: 대표 모달 미오픈(데이터 없음 가능) → 모달 검사 스킵` });
      await page.close();
      return base;
    }
    await page.waitForTimeout(500); // 모달 내부 렌더 여유

    // (A) [object Object] / (D) 깨진% — 모달 내부 텍스트 기준
    const inModal = await page.evaluate((sel) => {
      const m = document.querySelector(sel);
      const t = (m && m.innerText) || '';
      return {
        objObj: (t.match(/\[object Object\]/g) || []).length,
        brokenPct: t.match(/\b[1-9]\d{3,}\s*%|NaN/g) || [],
      };
    }, modalSel);
    expect.soft(inModal.objObj, `${label} [모달] (A)[object Object] ${inModal.objObj}건`).toBe(0);
    expect.soft(inModal.brokenPct.length, `${label} [모달] (D)깨진 값(8000%/NaN): ${JSON.stringify(inModal.brokenPct)}`).toBe(0);

    // (C) 가로 스크롤 — 모달 컨테이너 자체 overflow
    const mo = await page.evaluate((sel) => {
      const m = document.querySelector(sel);
      if (!m) return null;
      return { scrollWidth: m.scrollWidth, clientWidth: m.clientWidth };
    }, modalSel);
    if (mo) {
      expect.soft(mo.scrollWidth, `${label} [모달] (C)모달 가로스크롤 ${mo.scrollWidth} > ${mo.clientWidth}`).toBeLessThanOrEqual(mo.clientWidth + 1);
    }
    await page.close();
  } finally {
    await context.close();
  }
  expect.soft(modalErrors.length, `${label} [모달] (B)콘솔/JS 에러:\n${modalErrors.join('\n')}`).toBe(0);
  return base;
}

/**
 * 역할별 첫 클래스 ID 해석 (/api/class/my). 상세 화면에 실제 컨텍스트 주입용.
 * 실패하거나 클래스가 없으면 null → 해당 동적 화면은 자동 스킵 처리.
 */
async function resolveClassId(browser, statePath) {
  const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR', baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    // 동일 출처에서 fetch 해야 쿠키/상대경로가 동작 — 가벼운 포털 메인 진입
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const cid = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/class/my');
        if (!r.ok) return null;
        const d = await r.json();
        const list = (d && (d.classes || d)) || [];
        return Array.isArray(list) && list.length ? list[0].id : null;
      } catch (_) { return null; }
    }).catch(() => null);
    await page.close();
    return cid;
  } finally {
    await context.close();
  }
}

// ── 역할별 검사 대상 화면 (정적 — 쿼리파라미터 불필요) ───────────────────────
//    기존 13화면 + 신규 화면. {url,label} 형태. modal 지정 시 대표 모달 1개도 검사.
const SCREENS = {
  student: [
    // ── 기존 5화면 (회귀 유지) ──
    { url: '/', label: '학생-포털메인' },
    { url: '/growth/student-report.html', label: '학생-성장리포트' },
    { url: '/self-learn/learning-map.html', label: '학생-AI맞춤학습 학습맵' },
    { url: '/content/index.html', label: '학생-채움콘텐츠' },
    { url: '/self-learn/wrong-note.html', label: '학생-오답노트' },
    // ── 신규 (학생) ──
    { url: '/self-learn/today.html', label: '학생-오늘의학습(today)' },
    { url: '/self-learn/emotion-checkin.html', label: '학생-마음채움 감정체크인' },
    { url: '/self-learn/problem-sets.html', label: '학생-내 문제집' },
    { url: '/growth/portfolio.html', label: '학생-포트폴리오' },
    { url: '/cbt/index.html', label: '학생-채움CBT 전체평가' },
    { url: '/lrs/index.html?menu=analytics', label: '학생-LRS 현황분석' },
    { url: '/class/find.html', label: '학생-클래스 찾기' },
    { url: '/class/hall-of-fame.html', label: '학생-명예의 전당' },
    { url: '/plus/contests.html', label: '학생-콘테스트' },
  ],
  teacher: [
    // ── 기존 5화면 (회귀 유지) ──
    { url: '/', label: '교사-포털메인' },
    { url: '/growth/class-dashboard.html', label: '교사-클래스대시보드 학습분석' },
    { url: '/growth/student-report.html', label: '교사-성장리포트(학생조회)' },
    { url: '/class/manage.html', label: '교사-클래스 관리' },
    { url: '/content/index.html', label: '교사-채움콘텐츠' },
    // ── 신규 (교사) ──
    { url: '/cbt/index.html', label: '교사-채움CBT 평가관리' },
    { url: '/survey/index.html', label: '교사-설문' },
    { url: '/growth/emotion-monitor.html', label: '교사-마음채움 모니터' },
    { url: '/class/analytics.html', label: '교사-클래스별 학습분석' },
    { url: '/self-learn/problem-sets.html', label: '교사-문제집(출제뷰)' },
    { url: '/lrs/index.html?menu=operations', label: '교사-LRS 운영' },
    { url: '/plus/contests.html', label: '교사-콘테스트(만들기뷰)' },
    { url: '/plus/contests.html?tab=upcoming', label: '교사-콘테스트 예정탭' },
    { url: '/plus/contests.html?tab=past', label: '교사-콘테스트 마감탭' },
  ],
  admin: [
    // ── 기존 3화면 (회귀 유지) ──
    { url: '/', label: '관리자-포털메인' },
    { url: '/lrs/index.html', label: '관리자-LRS 학습분석' },
    { url: '/admin/index.html', label: '관리자-관리자 페이지' },
    // ── 신규 (관리자) ──
    { url: '/lrs/index.html?menu=home', label: '관리자-LRS 홈' },
    { url: '/lrs/index.html?menu=operations', label: '관리자-LRS 운영' },
    { url: '/lrs/index.html?menu=reports', label: '관리자-LRS 리포트' },
    { url: '/admin/daily-learning.html', label: '관리자-학습 배포 관리' },
    { url: '/content/index.html#approval', label: '관리자-콘텐츠 승인관리' },
  ],
};

// ── 공통(역할 무관) 모달 포함 화면 — 카드 클릭 → 대표 모달 1개 내부까지 검사 ──
//    student/teacher 두 역할로 각각 돌려 카드 데이터 유무에 따라 자동 스킵.
const MODAL_SCREENS = [
  {
    role: 'student', url: '/plus/gallery.html', label: '학생-나도예술가 갤러리(모달)',
    opener: '.gallery-card', modalSel: '#detailModal',
  },
  {
    role: 'teacher', url: '/plus/gallery.html', label: '교사-나도예술가 갤러리(모달)',
    opener: '.gallery-card', modalSel: '#detailModal',
  },
  {
    role: 'teacher', url: '/plus/contests.html', label: '교사-콘테스트 상세(모달)',
    opener: '.ct-card', modalSel: '#detailModal',
  },
  {
    role: 'student', url: '/plus/contests.html', label: '학생-콘테스트 상세(모달)',
    opener: '.ct-card', modalSel: '#detailModal',
  },
];

// ── 동적(classId 필요) 상세 화면 — /api/class/my 의 첫 클래스로 컨텍스트 주입 ──
//    클래스가 없으면 자동 스킵. {path, qsBuilder(classId), label}
const DYNAMIC_SCREENS = {
  student: [
    { build: (cid) => `/class/class-home.html?id=${cid}`, label: '학생-클래스홈' },
    { build: (cid) => `/class/notice-board.html?classId=${cid}`, label: '학생-알림장' },
    { build: (cid) => `/class/attendance.html?classId=${cid}`, label: '학생-출석부' },
    { build: (cid) => `/message/index.html?classId=${cid}`, label: '학생-소통쪽지' },
    { build: (cid) => `/class/lesson-board.html?classId=${cid}`, label: '학생-수업 목록' },
  ],
  teacher: [
    { build: (cid) => `/class/class-home.html?id=${cid}`, label: '교사-클래스홈' },
    { build: (cid) => `/class/notice-board.html?classId=${cid}`, label: '교사-알림장' },
    { build: (cid) => `/class/attendance.html?classId=${cid}`, label: '교사-출석부(개설자뷰)' },
    { build: (cid) => `/message/index.html?classId=${cid}`, label: '교사-소통쪽지' },
    { build: (cid) => `/class/lesson-board.html?classId=${cid}`, label: '교사-수업 관리' },
    { build: (cid) => `/class/emotion-monitor.html?classId=${cid}`, label: '교사-클래스 감정모니터' },
  ],
};

// ── 1) 정적 화면 ──
for (const [role, screens] of Object.entries(SCREENS)) {
  test.describe(`스모크: ${role}`, () => {
    for (const s of screens) {
      test(`${s.label} (${s.url})`, async ({ browser }) => {
        const result = await checkScreen(browser, stateFor(role), s.url, s.label);
        if (result.skipped) test.skip(true, '권한 리다이렉트로 스킵');
      });
    }
  });
}

// ── 2) 모달 포함 화면 ──
test.describe('스모크: 모달 포함 화면', () => {
  for (const m of MODAL_SCREENS) {
    test(`${m.label} (${m.url})`, async ({ browser }) => {
      const result = await checkScreenWithModal(browser, stateFor(m.role), m.url, m.label, m.opener, m.modalSel);
      if (result.skipped) test.skip(true, '권한 리다이렉트로 스킵');
    });
  }
});

// ── 3) 동적(classId) 상세 화면 — beforeAll 에서 역할별 classId 해석 ──
for (const [role, screens] of Object.entries(DYNAMIC_SCREENS)) {
  test.describe(`스모크: ${role} 상세(classId)`, () => {
    let classId = null;
    test.beforeAll(async ({ browser }) => {
      classId = await resolveClassId(browser, stateFor(role));
    });
    for (const s of screens) {
      test(`${s.label}`, async ({ browser }) => {
        if (!classId) test.skip(true, `${role} 소속 클래스 없음 → 상세 화면 스킵`);
        const url = s.build(classId);
        const result = await checkScreen(browser, stateFor(role), url, s.label);
        if (result.skipped) test.skip(true, '권한 리다이렉트로 스킵');
      });
    }
  });
}

// ── 4) A6 "마음-공부 거울" 카드 (학생 · s-trend 하단) 집중 회귀 ──
//    LRS s-trend 뷰로 진입 → 카드가 렌더(차트/빈상태/에러 중 하나)되는지 + 가로스크롤 0
//    + [object Object]/JS에러 0 을 데스크탑·모바일 두 뷰포트에서 검증.
test.describe('스모크: LRS A6 감정-성취 비교', () => {
  for (const vp of VIEWPORTS) {
    test(`학생-A6 카드 렌더·무결 [${vp.name}]`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
      const consoleErrors = [];
      const pageErrors = [];
      try {
        const page = await context.newPage();
        page.setViewportSize({ width: vp.width, height: vp.height });
        page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!isWhitelisted(t)) consoleErrors.push(`[${vp.name}] ${t}`); } });
        page.on('pageerror', (err) => { pageErrors.push(`[${vp.name}] ${err.message}`); });

        // ?menu=activities 로 진입 → 학습활동 분석 카테고리 탭(s-trend 버튼 포함)이 렌더됨.
        //   (d9c879a 메뉴 재설계에서 s-trend 가 analytics → activities 로 이동. 구 진입 경로
        //    ?menu=analytics 는 s-trend 버튼이 없어 본 테스트가 무의미하게 타임아웃됨 — 경로 교정.)
        // ※ LRS SPA 는 주기적 sync 타이머가 있어 networkidle 이 안정적으로 안 옴 → 셀렉터 대기로 대체.
        await page.goto('/lrs/index.html?menu=activities', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
        await page.waitForSelector('[data-view="s-trend"]', { timeout: 15000 }).catch(() => {});

        // s-trend(학습 습관) 진입 → 카드 호스트가 채워질 때까지. SPA 비동기 렌더 경합 방어로 최대 3회 재시도.
        let hostFilled = false;
        for (let attempt = 0; attempt < 3 && !hostFilled; attempt++) {
          await page.evaluate(() => {
            const b = document.querySelector('[data-view="s-trend"]');
            if (b) b.click(); else location.hash = '#s-trend';
          }).catch(() => {});
          hostFilled = await page.waitForFunction(() => {
            const h = document.getElementById('sEmotionMirrorHost');
            return !!(h && h.querySelector('.dc-chart-wrapper, .dc-state-panel'));
          }, { timeout: 10000 }).then(() => true).catch(() => false);
        }
        await page.waitForTimeout(400);

        // (렌더) A6 카드 호스트에 차트(canvas) 또는 빈/에러 상태 패널이 존재
        const a6 = await page.evaluate(() => {
          const h = document.getElementById('sEmotionMirrorHost');
          if (!h) return { host: false };
          return {
            host: true,
            hasCanvas: !!h.querySelector('#sEmoMirror'),
            hasStatePanel: !!h.querySelector('.dc-state-panel'),
            hasTitle: /감정체크-학습성취/.test(h.innerText || ''),
            objObj: ((h.innerText || '').match(/\[object Object\]/g) || []).length,
          };
        });
        expect.soft(a6.host, `A6 [${vp.name}] 카드 호스트(#sEmotionMirrorHost) 없음`).toBeTruthy();
        expect.soft(a6.hasCanvas || a6.hasStatePanel, `A6 [${vp.name}] 차트/상태패널 둘 다 없음(렌더 실패)`).toBeTruthy();
        expect.soft(a6.hasTitle, `A6 [${vp.name}] 카드 제목("감정체크-학습성취 수준 연관 분석") 미표시`).toBeTruthy();
        expect.soft(a6.objObj, `A6 [${vp.name}] [object Object] ${a6.objObj}건`).toBe(0);

        // (C) 가로 스크롤 0
        const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect.soft(ov.sw, `A6 [${vp.name}] 가로 스크롤: scrollWidth ${ov.sw} > clientWidth ${ov.cw}`).toBeLessThanOrEqual(ov.cw + 1);

        await page.close();
      } finally {
        await context.close();
      }
      const allErrors = [...pageErrors, ...consoleErrors];
      expect.soft(allErrors.length, `A6 [${vp.name}] (B)콘솔/JS 에러:\n${allErrors.join('\n')}`).toBe(0);
    });
  }
});

// ── 5) LRS 학생 홈·메뉴 재설계 불변식 (스펙 E: INV-a ~ INV-e + INV-f 약점 라벨) ──
//    스펙: 작업지시서/LRS_학생_홈_메뉴_재설계_스펙.md §E
//    사람 눈 대신 매번 전수 검증할 객관 규칙. 학생 홈(s-home) 실렌더 기준.
//
//    INV-a: LRS 점수 표시 0~100 일관 (0~1 스케일 혼입 금지)
//    INV-b: 학생 화면에 "활성 사용자" 등 집계형 무의미 지표 미노출
//    INV-e: 학생 홈 KPI/스냅샷 라벨·증감 ≥ 14px, 값 ≥ 24px
//    INV-f: 약점 차트/카드 라벨이 raw 성취기준 코드([N수..]) 형태가 아니라 한글 단원명
//    (INV-c 도넛 오버레이·INV-d 표 정렬은 s-achieve/표 렌더 뷰 별도 — 여기선 홈 4종 집중)
async function gotoStudentHome(page) {
  await page.goto('/lrs/index.html#s-home', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
  // 홈 스냅샷/KPI 렌더 대기 (SPA 비동기)
  await page.waitForFunction(() => {
    const vr = document.getElementById('viewRoot');
    return !!(vr && vr.querySelector('.dc-snapshot .dc-kpi-card'));
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
}

test.describe('스모크: LRS 학생 홈·메뉴 재설계 불변식(INV-a~f)', () => {
  test('INV-e: 학생 홈 KPI/스냅샷 폰트 라벨·증감≥14px, 값≥24px', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await gotoStudentHome(page);
      const fonts = await page.evaluate(() => {
        const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : null;
        const cards = [...document.querySelectorAll('#viewRoot .dc-kpi-card')];
        return cards.map(c => ({
          label: c.querySelector('.kpi-label')?.textContent || '',
          labelPx: px(c.querySelector('.kpi-label')),
          valuePx: px(c.querySelector('.kpi-value')),
          trendPx: px(c.querySelector('.kpi-trend')),
        }));
      });
      expect.soft(fonts.length, 'INV-e: 학생 홈 KPI 카드가 없음').toBeGreaterThan(0);
      for (const f of fonts) {
        expect.soft(f.labelPx, `INV-e: "${f.label}" 라벨 ${f.labelPx}px < 14`).toBeGreaterThanOrEqual(14);
        expect.soft(f.trendPx, `INV-e: "${f.label}" 증감 ${f.trendPx}px < 14`).toBeGreaterThanOrEqual(14);
        expect.soft(f.valuePx, `INV-e: "${f.label}" 값 ${f.valuePx}px < 24`).toBeGreaterThanOrEqual(24);
      }
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-b: 학생 홈에 "활성 사용자" 등 무의미 집계 지표 미노출', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await gotoStudentHome(page);
      const found = await page.evaluate(() => {
        const t = document.getElementById('viewRoot')?.innerText || '';
        return { hasActiveUsers: t.includes('활성 사용자'), hasUniqueUsers: t.includes('고유 사용자') || t.includes('고유사용자') };
      });
      expect.soft(found.hasActiveUsers, 'INV-b: 학생 홈에 "활성 사용자" 노출됨').toBeFalsy();
      expect.soft(found.hasUniqueUsers, 'INV-b: 학생 홈에 "고유 사용자" 노출됨').toBeFalsy();
    } finally { await context.close(); }
  });

  test('INV-a: 학생 홈 점수/정답률/성취 표시가 0~100 범위(0~1 혼입 금지)', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await gotoStudentHome(page);
      const bad = await page.evaluate(() => {
        const t = document.getElementById('viewRoot')?.innerText || '';
        const out = [];
        const re = /(\d+(?:\.\d+)?)\s*(점|%)/g; let m;
        while ((m = re.exec(t))) {
          const v = parseFloat(m[1]);
          // 0~1 스케일 혼입 신호: 소수점이 있고 값이 1 이하 (예: 0.57점/0.9%), 또는 100 초과
          if (v > 100 || (m[1].includes('.') && v > 0 && v <= 1)) out.push(m[0]);
        }
        return out;
      });
      expect.soft(bad.length, `INV-a: 0~100 벗어난 점/% 표시: ${JSON.stringify(bad)}`).toBe(0);
    } finally { await context.close(); }
  });

  test('INV-f: 약점 차트/카드 라벨이 raw 코드가 아닌 한글 단원명', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await gotoStudentHome(page);
      const res = await page.evaluate(() => {
        const titles = [...document.querySelectorAll('#sWeakCards .dc-warning-card h3')].map(h => (h.textContent || '').trim());
        // raw 코드 형태([4수01-02] / 4수01-02)만으로 된 제목 검출
        const rawCodeOnly = titles.filter(x => /^\[?\S*\d+-\d+\]?$/.test(x) && !/[가-힣]/.test(x.replace(/[\[\]\d수국영과사-]/g, '')));
        // 한글이 하나도 안 들어간 제목(=코드로 추정)
        const noHangul = titles.filter(x => x && !/[가-힣]/.test(x));
        return { count: titles.length, titles, rawCodeOnly, noHangul };
      });
      if (res.count > 0) {
        expect.soft(res.noHangul.length, `INV-f: 약점 카드 제목에 한글 단원명 없음(코드 추정): ${JSON.stringify(res.noHangul)}`).toBe(0);
      }
    } finally { await context.close(); }
  });

  test('메뉴: 학생 s-xapi(표준체계 분석) 메뉴 탭 미노출 + 딥링크는 라우팅', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/lrs/index.html?menu=analytics', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('#lrsTabs .lrs-tab', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
      // INV-K4(P0-3 학령 차등): student1은 elementary → "또래 비교" 탭 DOM 부재(윤리 정책).
      //   초등 analytics 카테고리는 남는 뷰가 "내 성취 분석" 1개뿐이라 탭 바 자체가 미렌더됨
      //   (기존 "뷰 1개 이하 탭 바 미렌더" 정책) — 랜딩 뷰(data-view=s-achieve)로 정상 진입을 검증.
      const analyticsState = await page.evaluate(() => ({
        tabLabels: [...document.querySelectorAll('#lrsTabs .lrs-tab')].map(t => t.textContent.trim()),
        view: document.getElementById('viewRoot')?.getAttribute('data-view') || '',
      }));
      expect.soft(analyticsState.tabLabels.some(l => l.includes('표준체계')), `메뉴: 학생 탭에 표준체계 분석 노출됨 (${JSON.stringify(analyticsState.tabLabels)})`).toBeFalsy();
      expect.soft(analyticsState.tabLabels.some(l => l.includes('또래 비교')), `INV-K4: 초등 학생 탭에 "또래 비교" 노출됨 (${JSON.stringify(analyticsState.tabLabels)})`).toBeFalsy();
      expect.soft(analyticsState.view, `메뉴: 초등 analytics 랜딩 뷰가 s-achieve가 아님(${analyticsState.view})`).toBe('s-achieve');

      // 딥링크 #s-xapi 는 여전히 라우팅(404/준비중 아님)
      await page.evaluate(() => { location.hash = '#s-xapi'; });
      await page.waitForTimeout(1200);
      const routed = await page.evaluate(() => {
        const t = document.getElementById('viewRoot')?.innerText || '';
        return { is404: /준비 중인 화면/.test(t), hasContent: t.length > 50 };
      });
      expect.soft(routed.is404, '메뉴: s-xapi 딥링크가 404("준비 중")로 떨어짐').toBeFalsy();
      expect.soft(routed.hasContent, 's-xapi 딥링크 본문 미렌더').toBeTruthy();
      await page.close();
    } finally { await context.close(); }
  });

  // ── INV-K5(P0-4): 학생 "오늘 활동 요약"(s-daily) 폐지 + 습관 카드 이관 ──
  //    ① 학습활동 분석 탭에 "오늘 활동 요약" 부재
  //    ② s-trend에 "주 학습 시간대" 습관 카드 존재
  //    ③ 구 딥링크 #s-daily → "활동 유형별 수행"(s-perform) 폴백(빈 화면·에러 없음)
  test('INV-K5: s-daily 폐지 — 탭 부재 + 습관 카드 이관 + 구 해시 폴백', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/lrs/index.html?menu=activities', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('#lrsTabs .lrs-tab', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
      const tabLabels = await page.evaluate(() => [...document.querySelectorAll('#lrsTabs .lrs-tab')].map(t => t.textContent.trim()));
      expect.soft(tabLabels.some(l => l.includes('오늘 활동 요약')), `INV-K5: 학생 탭에 "오늘 활동 요약" 잔존 (${JSON.stringify(tabLabels)})`).toBeFalsy();
      expect.soft(tabLabels.some(l => l.includes('학습 습관')), `INV-K5: 학습 습관·추이 탭 없음 (${JSON.stringify(tabLabels)})`).toBeTruthy();

      // ② s-trend 진입 → 습관 카드 렌더(차트 또는 빈상태)
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#lrsTabs .lrs-tab')].find(t => t.textContent.includes('학습 습관'));
        if (b) b.click(); else location.hash = '#s-trend';
      });
      const habit = await page.waitForFunction(() => {
        const h = document.getElementById('sHabitHost');
        return !!(h && /주 학습 시간대/.test(h.innerText || ''));
      }, { timeout: 10000 }).then(() => true).catch(() => false);
      expect.soft(habit, 'INV-K5: s-trend에 "주 학습 시간대" 습관 카드 미렌더').toBeTruthy();

      // ③ 구 딥링크 진입(페이지 로드 경유 — SPA는 hashchange 라우팅이 없어 boot가 처리) → s-perform 폴백
      await page.goto('/lrs/index.html#s-daily', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const vr = document.getElementById('viewRoot');
        return !!(vr && vr.getAttribute('data-view'));
      }, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      const fallback = await page.evaluate(() => ({
        view: document.getElementById('viewRoot')?.getAttribute('data-view') || '',
        text: (document.getElementById('viewRoot')?.innerText || '').slice(0, 200),
      }));
      expect.soft(fallback.view, `INV-K5: #s-daily 딥링크가 s-perform으로 폴백 안 됨(현재 뷰: ${fallback.view})`).toBe('s-perform');
      expect.soft(fallback.text.length, 'INV-K5: 폴백 화면 본문 미렌더').toBeGreaterThan(20);
      await page.close();
    } finally { await context.close(); }
  });
});

// ── 7) LRS P1: 3구간 IA(INV-K10) + 학령 분기 실존·윤리(INV-K11 학생측) ──
//    스펙: 작업지시서/LRS_P1_3구간IA_스택바_학급비교_스펙.md §7
//    (middle 계정 측 검사는 시드 계정 확보 후 확장 — 여기서는 student1(elementary) 기준 절반)
test.describe('스모크: LRS P1 3구간 IA·학령 분기(INV-K10·K11)', () => {
  test('INV-K10: 학생 홈 3구간 now→flow→next + 스냅샷 구간① 내부 + 링크→s-perform + 격식어 0', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await gotoStudentHome(page);
      const zones = await page.evaluate(() => ({
        order: [...document.querySelectorAll('#viewRoot .sh-zone')].map(z => z.getAttribute('data-zone')),
        snapshotInNow: !!document.querySelector('#viewRoot .sh-zone[data-zone="now"] .dc-snapshot'),
        heads: [...document.querySelectorAll('#viewRoot .sh-zone__head')].map(h => (h.textContent || '').trim()),
        hasLink: !!document.getElementById('shZoneFlowLink'),
      }));
      expect.soft(zones.order, `INV-K10: 구간 순서 now→flow→next 아님: ${JSON.stringify(zones.order)}`).toEqual(['now', 'flow', 'next']);
      expect.soft(zones.snapshotInNow, 'INV-K10: 오늘 스냅샷이 구간①(now) 안에 없음(구간 밖으로 샘)').toBeTruthy();
      const formal = zones.heads.filter(t => /이력|현황|계획/.test(t));
      expect.soft(formal.length, `INV-K10: 구간 헤더에 격식어(이력/현황/계획) 노출: ${JSON.stringify(formal)}`).toBe(0);
      expect.soft(zones.hasLink, 'INV-K10: 구간② "최근 활동 자세히 보기" 링크 부재').toBeTruthy();
      // 링크 실클릭 → s-perform 전환 (setView 경유 — 해시 단독 변경 아님)
      await page.click('#shZoneFlowLink');
      await page.waitForFunction(() => document.getElementById('viewRoot')?.getAttribute('data-view') === 's-perform',
        { timeout: 10000 }).catch(() => {});
      const view = await page.evaluate(() => document.getElementById('viewRoot')?.getAttribute('data-view'));
      expect.soft(view, `INV-K10: 링크 클릭 후 s-perform 미전환(현재: ${view})`).toBe('s-perform');
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-K11: 초등(student1) — 스택바 부재·레이더 유지 + withClass 요청 0 + 오버레이·비교 문구 0', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      const withClassReqs = [];
      // withClass=(P1-3 오버레이) + withClassAvg=(P2-2 타임라인 델타) — 초등은 두 파라미터 모두 미발송이어야 함
      page.on('request', (r) => { if (/withClass(Avg)?=/.test(r.url())) withClassReqs.push(r.url()); });
      await page.goto('/lrs/index.html?menu=analytics', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const vr = document.getElementById('viewRoot');
        return !!(vr && vr.getAttribute('data-view') === 's-achieve' && vr.querySelector('.mastery-section'));
      }, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500); // 후행 trend fetch·렌더 대기
      const st = await page.evaluate(() => ({
        hasStack: !!document.getElementById('sSubjStack'),
        hasAvgCard: /교과별 평균 정답률/.test(document.getElementById('viewRoot')?.innerText || ''),
        trendDatasets: (window.Chart && Chart.getChart && Chart.getChart('sTrendChart'))
          ? Chart.getChart('sTrendChart').data.datasets.length : null,
        compareText: /반 평균/.test(document.getElementById('viewRoot')?.innerText || ''),
      }));
      expect.soft(st.hasStack, 'INV-K11: 초등에 #sSubjStack 렌더됨(스택바는 중·고 전용)').toBeFalsy();
      expect.soft(st.hasAvgCard, 'INV-K11: 초등 "교과별 평균 정답률" 카드(레이더/막대 폴백) 부재').toBeTruthy();
      if (st.trendDatasets != null) {
        expect.soft(st.trendDatasets, 'INV-K11: 초등 추이 차트에 학급 오버레이 dataset 혼입').toBe(1);
      }
      expect.soft(st.compareText, 'INV-K11: 초등 화면에 "반 평균" 비교 문구 노출(윤리 위반)').toBeFalsy();
      expect.soft(withClassReqs.length, `INV-K11: 초등이 withClass 요청을 보냄(네트워크 가드 위반): ${JSON.stringify(withClassReqs)}`).toBe(0);
      await page.close();
    } finally { await context.close(); }
  });
});

// ── 8) LRS P2: 최근 학습 활동 카드(INV-K13 FE측) + 히트맵 드릴 3종(INV-K14·K15) + middle 완전판(INV-K11′) ──
//    스펙: 작업지시서/LRS_P2_교사히트맵_타임라인메타_스펙.md §2-8·§3-5·§7
test.describe('스모크: LRS P2 히트맵 드릴·최근 학습 활동(INV-K13~K15·K11′)', () => {

  /* middle1 시드 계정 컨텍스트 — 시드 미착륙(로그인 실패) 시 null 반환 → 테스트는 skip 처리 */
  async function middle1Context(browser) {
    const context = await browser.newContext({ locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const res = await context.request.post('/api/auth/login', { data: { username: 'middle1', password: '1234' } });
      if (!res.ok()) { await context.close(); return null; }
      return context;
    } catch (_) { await context.close(); return null; }
  }

  test('P2-2: 초등(student1) s-perform 최근 학습 활동 카드 — ≤8행·게이지·withClassAvg 0·반평균 문구 0·12px 미만 0', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      const withClassReqs = [];
      page.on('request', (r) => { if (/withClass(Avg)?=/.test(r.url())) withClassReqs.push(r.url()); });
      await page.goto('/lrs/index.html#s-perform', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const h = document.getElementById('sRecentActs');
        return !!(h && h.querySelector('.lrs-dm-row'));
      }, { timeout: 20000 }).catch(() => {});
      const card = await page.evaluate(() => {
        const host = document.getElementById('sRecentActs');
        if (!host || !host.innerHTML) return { exists: false };
        const rows = [...host.querySelectorAll('.lrs-dm-row')];
        const kpi = document.querySelector('.dc-kpi-grid');
        return {
          exists: true,
          rowCount: rows.length,
          h2: (host.querySelector('h2') || {}).textContent || '',
          afterKpi: !!(kpi && (kpi.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)),
          gauges: host.querySelectorAll('.ra-gauge').length,
          lessonRows: rows.filter(r => /수업 진행/.test(r.innerText)).length,
          deltaChips: host.querySelectorAll('.ra-delta').length,
          // 금칙어 검사는 UI 생성 문구(메타·꼬리·부제·헤더)로 한정 — 활동 제목(.lrs-dm-row-primary)은
          // 콘텐츠 고유명이라 제외("초등수학"의 '등수' 부분문자열 오탐 실측 — 스펙 §3-3 개정 기록 R-1e)
          banText: /반 평균|등수|순위|꼴찌|위험|뒤처|낮은 편|부족한 편|못했|실패/.test(
            [...host.querySelectorAll('.lrs-dm-row-meta, .lrs-dm-row-tail, .subtitle, h2')]
              .map(el => el.textContent).join(' ')),
          tinyFonts: [...host.querySelectorAll('*')].filter(el => {
            const fs = parseFloat(getComputedStyle(el).fontSize);
            return el.textContent.trim() && fs > 0 && fs < 13;
          }).length,
          seeAll: !!document.getElementById('raSeeAll'),
          // [감리 R-1] learnOnly: 조회성 content_view(메타 "콘텐츠 학습") 행 0건 — 학습활동 정본 7종만
          //   ('콘텐츠 문항풀이'는 별개 문자열이라 오검출 없음)
          contentViewRows: rows.filter(r => {
            const meta = (r.querySelector('.lrs-dm-row-meta') || {}).textContent || '';
            return meta.includes('콘텐츠 학습');
          }).length,
          // [감리 R-1] 연속 중복 병합: 인접 행의 (제목+메타에서 ×N회 제외) 동일 조합 0건
          adjacentDups: rows.reduce((acc, r, i) => {
            if (i === 0) return acc;
            const sig = (el) => ((el.querySelector('.lrs-dm-row-primary') || {}).textContent || '') + '|' +
              (((el.querySelector('.lrs-dm-row-meta') || {}).textContent || '').replace(/ · ×\d+회/, ''));
            return acc + (sig(r) === sig(rows[i - 1]) ? 1 : 0);
          }, 0),
          dupBadgeSample: ([...host.querySelectorAll('.lrs-dm-row-meta')].map(m => m.textContent).find(t => /×\d+회/.test(t)) || null),
        };
      });
      expect.soft(card.exists, 'P2-2: #sRecentActs 카드 미렌더').toBeTruthy();
      if (card.exists) {
        expect.soft(card.rowCount, `P2-2: 행 수 1~8 위반(${card.rowCount})`).toBeLessThanOrEqual(8);
        expect.soft(card.rowCount, 'P2-2: 행 0건인데 카드 렌더됨').toBeGreaterThan(0);
        expect.soft(card.h2.trim(), 'P2-2: 제목 격식 명사형 "최근 학습 활동" 아님').toBe('최근 학습 활동');
        expect.soft(card.afterKpi, 'P2-2: 카드가 KPI 그리드 아래에 있지 않음').toBeTruthy();
        // 수업 행이 있으면 진도 게이지도 있어야(INV-K13①의 FE측 — progressPct 렌더)
        if (card.lessonRows > 0) {
          expect.soft(card.gauges, `P2-2: 수업 행 ${card.lessonRows}개인데 진도 게이지 ${card.gauges}개`).toBeGreaterThan(0);
        }
        expect.soft(card.deltaChips, 'P2-2: 초등 카드에 반평균 델타 칩 노출(윤리 위반)').toBe(0);
        expect.soft(card.banText, 'P2-2: 초등 카드에 반평균·금칙어 문구 노출').toBeFalsy();
        expect.soft(card.tinyFonts, `P2-2: 카드 내부 12px 이하 글꼴 ${card.tinyFonts}건`).toBe(0);
        expect.soft(card.seeAll, 'P2-2: "활동 전체 보기" 링크 부재').toBeTruthy();
        // [감리 R-1] 학습활동 정본 7종(learnOnly) — 조회성 content_view 행 0건
        expect.soft(card.contentViewRows, `P2-2(R-1): 카드에 조회성 "콘텐츠 학습" 행 ${card.contentViewRows}건 — learnOnly 미반영`).toBe(0);
        // [감리 R-1] 연속 중복 병합 — 인접 동일 활동 행 0건(×N회 병합 후)
        expect.soft(card.adjacentDups, `P2-2(R-1): 카드에 인접 중복 행 ${card.adjacentDups}건 — 연속 병합 미동작`).toBe(0);
        // "활동 전체 보기" → all 드릴 모달 열림(표시값=드릴 동선)
        await page.click('#raSeeAll');
        const modalOpen = await page.waitForFunction(() =>
          document.getElementById('lrsPerfDetailModal')?.classList.contains('open'),
          { timeout: 8000 }).then(() => true).catch(() => false);
        expect.soft(modalOpen, 'P2-2: 활동 전체 보기 클릭 시 all 모달 미오픈').toBeTruthy();
      }
      expect.soft(withClassReqs.length, `P2-2: 초등이 withClassAvg 요청 발송(네트워크 가드 위반): ${JSON.stringify(withClassReqs)}`).toBe(0);
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-K14·K15: 교사(teacher1) 히트맵 드릴 3종 — 셀 시도내역=count·행 그룹합=학생수·열 카운트=열 셀수·평가부족 어휘', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('teacher'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/lrs/index.html?menu=analytics#t-warnings', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.mastery-heatmap td.cell', { timeout: 20000 }).catch(() => {});
      const ready = await page.evaluate(() => !!document.querySelector('.mastery-heatmap td.cell'));
      if (!ready) {
        test.info().annotations.push({ type: 'skip-screen', description: 'INV-K14: 히트맵 미렌더(성취 데이터 부족) — 드릴 검사 스킵' });
        await page.close(); return;
      }

      // ── (A) 셀 드릴: 시도 내역 행수 == "누적 N회" == /mastery/detail count ──
      const cellRes = await page.evaluate(async () => {
        const cell = document.querySelector('.mastery-heatmap td.cell[data-state="notReached"], .mastery-heatmap td.cell[data-state="reached"], .mastery-heatmap td.cell[data-state="partial"]');
        if (!cell) return { skip: true };
        const code = cell.getAttribute('data-code'), uid = cell.getAttribute('data-uid');
        cell.click();
        await new Promise(r => setTimeout(r, 1500));   // fetch 대기
        const rows = document.querySelectorAll('#drwAttList .drw-att-row').length;
        const title = (document.getElementById('drwAttTitle') || {}).textContent || '';
        const n = parseInt((title.match(/누적 (\d+)회/) || [])[1], 10);
        const api = await (await fetch('/api/lrs/mastery/detail?user_id=' + encodeURIComponent(uid) + '&achievement_code=' + encodeURIComponent(code), { credentials: 'include' })).json();
        window.LRS.closeDrawer();
        return { skip: false, rows, titleN: n, apiCount: api.count,
          capped: api.count > 50,   // LIMIT 50 초과 시 rows < count 허용(각주 노출)
          hasActions: !!document.getElementById('drwMessage') };
      });
      if (!cellRes.skip) {
        if (cellRes.capped) {
          expect.soft(cellRes.rows, 'INV-K14③: 셀 드로어 행수가 상한(50) 초과').toBeLessThanOrEqual(50);
        } else {
          expect.soft(cellRes.rows, `INV-K14③: 셀 드로어 행수(${cellRes.rows}) != API count(${cellRes.apiCount})`).toBe(cellRes.apiCount);
        }
        expect.soft(cellRes.titleN, `INV-K14③: "누적 N회" 표기(${cellRes.titleN}) != API count(${cellRes.apiCount})`).toBe(cellRes.apiCount);
      }

      // ── (A′) 평가부족 셀: "정답률" 미출현 + "시도 N회"만 (INV-K15) ──
      const insRes = await page.evaluate(async () => {
        const cell = document.querySelector('.mastery-heatmap td.cell[data-state="insufficient"]');
        if (!cell) return { skip: true };
        cell.click();
        await new Promise(r => setTimeout(r, 1500));
        const stat = (document.getElementById('drwCellStat') || {}).textContent || '';
        window.LRS.closeDrawer();
        return { skip: false, stat };
      });
      if (!insRes.skip) {
        expect.soft(/정답률/.test(insRes.stat), `INV-K15: 평가부족 셀 드로어에 "정답률" 출현(${insRes.stat})`).toBeFalsy();
        expect.soft(/^시도 \d+회$/.test(insRes.stat.trim()), `INV-K15: 평가부족 상태 표기가 "시도 N회" 형식 아님(${insRes.stat})`).toBeTruthy();
      }

      // ── (B) 행 드릴: 그룹 인원 합 == 학생 수 (INV-K14④) ──
      const rowRes = await page.evaluate(async () => {
        const th = document.querySelector('.mastery-heatmap tbody th[data-code]');
        th.click();
        await new Promise(r => setTimeout(r, 400));
        const groups = [...document.querySelectorAll('#drawerBody .drw-group-title')].map(g => g.textContent.trim());
        const sum = groups.reduce((a, g) => a + (parseInt((g.match(/(\d+)명/) || [])[1], 10) || 0), 0);
        const students = document.querySelectorAll('.mastery-heatmap thead th.mh-stu').length;
        const hasGoto = !!document.getElementById('drwGotoT3');
        window.LRS.closeDrawer();
        return { sum, students, hasGoto, groups };
      });
      expect.soft(rowRes.sum, `INV-K14④: 행 드로어 그룹 합(${rowRes.sum}) != 학생 수(${rowRes.students}) — ${JSON.stringify(rowRes.groups)}`).toBe(rowRes.students);
      expect.soft(rowRes.hasGoto, 'INV-K14④: 행 드로어 T3 이동 링크 부재').toBeTruthy();

      // ── (C) 열 드릴: 4상태 카운트 == 그 열의 상태별 셀 수(전체 펼침, INV-K14②) ──
      const colRes = await page.evaluate(async () => {
        const toggle = document.getElementById('tHeatmapToggle');
        if (toggle && /전체/.test(toggle.textContent)) { toggle.click(); await new Promise(r => setTimeout(r, 600)); }
        const th = document.querySelector('.mastery-heatmap thead th.mh-stu[data-uid]');
        const uid = th.getAttribute('data-uid');
        const tally = { reached: 0, partial: 0, notReached: 0, insufficient: 0 };
        document.querySelectorAll(`.mastery-heatmap td.cell[data-uid="${uid}"]`).forEach(td => {
          const s = td.getAttribute('data-state');
          if (tally[s] != null) tally[s]++;
        });
        th.click();
        await new Promise(r => setTimeout(r, 400));
        const badges = [...document.querySelectorAll('#drawerBody .drw-sum-counts .mastery-badge')].map(b => b.textContent.trim());
        const parse = (label) => parseInt(((badges.find(t => t.startsWith(label)) || '').match(/(\d+)$/) || [])[1], 10) || 0;
        const drawer = { reached: parse('도달'), partial: parse('부분'), notReached: parse('미도달'), insufficient: parse('평가부족') };
        window.LRS.closeDrawer();
        return { tally, drawer, badges };
      });
      expect.soft(colRes.drawer, `INV-K14②: 열 드로어 카운트 != 히트맵 열 셀 수 — 드로어 ${JSON.stringify(colRes.drawer)} vs 열 ${JSON.stringify(colRes.tally)}`).toEqual(colRes.tally);

      // 페이지 가로 스크롤 0(히트맵은 내부 컨테이너 스크롤만) + 콘솔 무결은 공통 스모크가 커버
      const hScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(hScroll, `INV-K14: t-warnings 페이지 가로 스크롤 ${hScroll}px`).toBeLessThanOrEqual(0);
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-K11′: 중등(middle1 시드) 완전판 — 또래비교 탭·스택바·평가 델타/중립 칩·withClassAvg 발송·마이너스 0', async ({ browser }) => {
    const context = await middle1Context(browser);
    test.skip(!context, 'middle1 시드 미착륙(로그인 실패) — BE 시드 실행 후 자동 활성화');
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      const withClassAvgReqs = [];
      page.on('request', (r) => { if (r.url().includes('withClassAvg=1')) withClassAvgReqs.push(r.url()); });

      // ① analytics: 또래 비교 탭 + 스택바(#sSubjStack) — 중·고 전용 실존
      await page.goto('/lrs/index.html?menu=analytics', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!document.querySelector('#viewRoot .mastery-section'), { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const mid = await page.evaluate(() => ({
        tabLabels: [...document.querySelectorAll('#lrsTabs .lrs-tab')].map(t => t.textContent.trim()),
        hasStack: !!document.getElementById('sSubjStack'),
      }));
      expect.soft(mid.tabLabels.some(l => l.includes('또래 비교')), `INV-K11′: 중등 탭에 "또래 비교" 부재(${JSON.stringify(mid.tabLabels)})`).toBeTruthy();
      expect.soft(mid.hasStack, 'INV-K11′: 중등에 #sSubjStack(교과별 스택바) 미렌더').toBeTruthy();

      // ② s-perform 90d → 평가 드릴: 델타/중립 칩 ≥1 + 마이너스 표기 0 + withClassAvg 발송
      await page.goto('/lrs/index.html#s-perform', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!document.querySelector('.dc-kpi-card[data-bucket="exam"]'), { timeout: 20000 }).catch(() => {});
      await page.evaluate(() => {
        const chip90 = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '최근 90일');
        if (chip90) chip90.click();
      });
      await page.waitForTimeout(1500);
      await page.click('.dc-kpi-card[data-bucket="exam"]');
      await page.waitForFunction(() => document.querySelectorAll('#lrsDmBody .lrs-dm-row').length > 0, { timeout: 10000 }).catch(() => {});
      const exam = await page.evaluate(() => ({
        rows: document.querySelectorAll('#lrsDmBody .lrs-dm-row').length,
        chips: document.querySelectorAll('#lrsDmBody .ra-delta').length,
        minus: /반 평균 -/.test(document.getElementById('lrsDmBody')?.innerText || ''),
      }));
      if (exam.rows > 0) {
        expect.soft(exam.chips, `INV-K11′: 중등 평가 드릴에 델타/중립 칩 0개(행 ${exam.rows}개)`).toBeGreaterThan(0);
      }
      expect.soft(exam.minus, 'INV-K11′: 델타 칩에 마이너스 표기("반 평균 -") 출현 — 중립 표기 위반').toBeFalsy();
      expect.soft(withClassAvgReqs.length, 'INV-K11′: 중등이 withClassAvg=1 요청을 보내지 않음').toBeGreaterThan(0);
      await page.close();
    } finally { if (context) await context.close(); }
  });
});

// ── 9) CBT 이탈 감지 — 이탈"시간" 누적 계약 + 감독 화면 이탈시간 열(감사 확정 결함 3건) ──
//    스펙: 감사 리포트(대외연계_기술규격_검토의견_v1) — 결함 3건
//      [H] player.html 이탈 시간 영구 0: blur 가 focus:lost{duration:0} 고정 → 서버 미누적
//          → fixed: leaveStartTime 기록 후 복귀 시 경과 초를 focus:lost{duration>0} 로 송신
//      [M] supervisor.html 에 이탈"시간" 열 부재 → fixed: "이탈 시간" 컬럼 + student:leave-time 수신
//      [M] 감독 입장 전 제출 미반영(onStudentSubmitted early-return) → fixed: 미등록 학생 생성·반영
//    ※ CBT 응시 UI 는 세션·평가 상태 의존이 커 E2E 흐름 대신 "이벤트 계약·렌더 함수"를 정적+렌더로 검증.
//      실 소켓 누적 E2E 는 별도 하네스(scratchpad/cbt_leavetime_e2e.js)에서 확인(DB total_leave_time 증가).
test.describe('스모크: CBT 이탈 감지 계약(이탈시간 누적·감독 열·제출 반영)', () => {

  test('결함1[H]: player.html — blur 가 focus:lost{duration:0} 고정이 아니라 경과초를 송신', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('teacher'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      const res = await page.request.get('/cbt/player.html');
      const src = await res.text();
      // (a) 회귀 가드: blur 에서 duration:0 을 그대로 emit 하는 옛 계약이 남아있으면 실패
      expect.soft(/focus:lost['"]\s*,\s*\{\s*examId\s*,\s*duration:\s*0\s*\}/.test(src),
        "결함1[H]: player.html 에 옛 계약 emit('focus:lost',{examId,duration:0}) 잔존").toBeFalsy();
      // (b) 복귀 시 초 단위 경과값(Date.now()-leaveStartTime)/1000 을 focus:lost 로 송신하는 정본 계약 존재
      expect.soft(/leaveStartTime/.test(src), "결함1[H]: player.html 이탈 시작시각(leaveStartTime) 기록 부재").toBeTruthy();
      expect.soft(/\/\s*1000/.test(src) && /focus:lost/.test(src),
        "결함1[H]: player.html 복귀 시 초 단위(/1000) focus:lost 송신 계약 부재").toBeTruthy();
      // (c) exam-view 정본과 동일하게 focus:lost 에 duration 변수(durationSec)를 실어야 함 (duration:0 리터럴만이면 안 됨)
      expect.soft(/emit\(['"]focus:lost['"]\s*,\s*\{[^}]*duration:\s*durationSec/.test(src),
        "결함1[H]: focus:lost 에 실제 경과초(durationSec) 미탑재").toBeTruthy();
      await page.close();
    } finally { await context.close(); }
  });

  test('결함2[M]·3[M]: supervisor.html — 이탈 시간 열·student:leave-time 수신·미등록 제출 반영', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('teacher'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      const res = await page.request.get('/cbt/supervisor.html');
      const src = await res.text();
      // (결함2) 테이블 헤더에 "이탈 시간" 컬럼 존재 + 실시간 갱신 리스너 + 렌더 함수
      expect.soft(/<th[^>]*>\s*이탈 시간\s*<\/th>/.test(src), "결함2[M]: supervisor 테이블에 '이탈 시간' 헤더 부재").toBeTruthy();
      expect.soft(/socket\.on\(['"]student:leave-time['"]/.test(src), "결함2[M]: student:leave-time 소켓 리스너 부재").toBeTruthy();
      expect.soft(/function getLeaveTimeHtml/.test(src) && /function formatLeaveDuration/.test(src),
        "결함2[M]: 이탈시간 렌더 함수(getLeaveTimeHtml/formatLeaveDuration) 부재").toBeTruthy();
      expect.soft(/leaveTimeHtml/.test(src), "결함2[M]: 렌더 행에 이탈시간 셀(leaveTimeHtml) 미삽입").toBeTruthy();
      // (결함3) onStudentSubmitted 가 미등록 학생을 early-return 으로 버리지 않고 생성·반영
      const fnBody = (src.match(/function onStudentSubmitted\(data\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
      expect.soft(/if\s*\(!students\[data\.userId\]\)\s*return/.test(fnBody),
        "결함3[M]: onStudentSubmitted 에 미등록 학생 early-return(버그) 잔존").toBeFalsy();
      expect.soft(/students\[uid\]\s*=\s*\{[^}]*status:\s*'active'/.test(fnBody) || /if\s*\(!students\[uid\]\)/.test(fnBody),
        "결함3[M]: onStudentSubmitted 이 미등록 학생을 생성·반영하지 않음").toBeTruthy();

      // 렌더 함수 실측: 페이지 컨텍스트에서 정의를 추출·평가하여 출력값 검증(초/분·경계 색상 임계)
      const rendered = await page.evaluate((source) => {
        // supervisor.html 원문에서 두 함수 정의를 추출해 안전 평가
        const fmt = (source.match(/function formatLeaveDuration[\s\S]*?\n  \}/) || [''])[0];
        const ght = (source.match(/function getLeaveTimeHtml[\s\S]*?\n  \}/) || [''])[0];
        // eslint-disable-next-line no-new-func
        const mk = new Function(fmt + '\n' + ght + '\nreturn { formatLeaveDuration, getLeaveTimeHtml };');
        const { formatLeaveDuration, getLeaveTimeHtml } = mk();
        return {
          zero: getLeaveTimeHtml(0),
          four: getLeaveTimeHtml(4),
          thirty: getLeaveTimeHtml(30),
          min125: formatLeaveDuration(125),
        };
      }, src);
      expect.soft(/0초/.test(rendered.zero) && /none/.test(rendered.zero), `이탈시간 0초 렌더 이상: ${rendered.zero}`).toBeTruthy();
      expect.soft(/4초/.test(rendered.four) && /low/.test(rendered.four), `이탈시간 4초(low) 렌더 이상: ${rendered.four}`).toBeTruthy();
      expect.soft(/30초/.test(rendered.thirty) && /high/.test(rendered.thirty), `이탈시간 30초(임계 high) 렌더 이상: ${rendered.thirty}`).toBeTruthy();
      expect.soft(rendered.min125, '분·초 포맷(125초→"2분 5초") 이상').toBe('2분 5초');
      await page.close();
    } finally { await context.close(); }
  });
});

// ── 6) [Phase 3] LRS 교사 "학습 행동 심화 분석"(t-behavior) 집중 회귀 ──
//    기획: 보고서/LRS_Phase3_행동성취_UI_기획_v1.md
//    activities 진입 → t-behavior 탭 → 4신호 세그먼트 순회. 각 신호에서:
//      (A) 신호 카드(.behav-card) 렌더  (B) 상단+하단 caveat 안전장치 존재(상관≠인과)
//      (C) [object Object]/깨진% 0  (D) 콘솔·JS 에러 0  (E) 가로 스크롤 0
//    데스크탑·모바일 두 뷰포트. 신호①은 그룹비교 막대 + 흡수한 정오×속도 매트릭스 동시 존재.
test.describe('스모크: LRS 학습 행동 심화 분석(t-behavior)', () => {
  for (const vp of VIEWPORTS) {
    test(`교사-t-behavior 4신호 렌더·무결·caveat [${vp.name}]`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: stateFor('teacher'), locale: 'ko-KR', baseURL: BASE_URL });
      const consoleErrors = [];
      const pageErrors = [];
      try {
        const page = await context.newPage();
        page.setViewportSize({ width: vp.width, height: vp.height });
        page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!isWhitelisted(t)) consoleErrors.push(`[${vp.name}] ${t}`); } });
        page.on('pageerror', (err) => { pageErrors.push(`[${vp.name}] ${err.message}`); });

        await page.goto('/lrs/index.html?menu=activities', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
        await page.waitForSelector('[data-view="t-behavior"]', { timeout: 15000 }).catch(() => {});

        // t-behavior 탭 진입 → 신호 카드(또는 담당 0반 빈패널) 렌더 대기.
        let landed = false;
        for (let attempt = 0; attempt < 3 && !landed; attempt++) {
          await page.evaluate(() => { const b = document.querySelector('[data-view="t-behavior"]'); if (b) b.click(); else location.hash = '#t-behavior'; }).catch(() => {});
          landed = await page.waitForFunction(() => {
            const vr = document.getElementById('viewRoot');
            return !!(vr && vr.querySelector('.behav-card, .dc-state-panel'));
          }, { timeout: 10000 }).then(() => true).catch(() => false);
        }
        expect.soft(landed, `t-behavior [${vp.name}] 신호 카드/빈패널 미렌더`).toBeTruthy();

        const noClass = await page.evaluate(() => !document.querySelector('.behav-seg-btn'));
        if (noClass) { test.skip(true, '담당(개설) 반 0개 — 빈 패널로 스킵'); }

        const SIGS = ['speed', 'retry', 'participation', 'video']; // [Phase 4a] ④ rewatch→video(영상 학습 행동 우산)
        for (const sig of SIGS) {
          await page.evaluate((s) => { const b = document.querySelector(`.behav-seg-btn[data-behavsig="${s}"]`); if (b) b.click(); }, sig).catch(() => {});
          await page.waitForFunction((s) => {
            return (window.state && state._behavSignal === s) && !!document.querySelector('.behav-card');
          }, sig, { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(250);

          const r = await page.evaluate(() => {
            const card = document.querySelector('.behav-card');
            const txt = card ? (card.innerText || '') : '';
            return {
              hasCard: !!card,
              topCaveat: !!document.querySelector('.behav-card .lrs-insight.info'),
              botCaveats: document.querySelectorAll('.behav-caveats li').length,
              hasGroupsOrEmpty: !!(document.querySelector('.behav-gc-row') || document.querySelector('.behav-card .dc-state-panel')),
              hasMatrix: !!document.querySelector('#behavShallowHost .shallow-matrix'),
              objObj: (txt.match(/\[object Object\]/g) || []).length,
              broken: /\b[1-9]\d{3,}\s*%|NaN/.test(txt),
              titlePx: (() => { const h = document.querySelector('.behav-card-title'); return h ? parseFloat(getComputedStyle(h).fontSize) : null; })(),
            };
          });
          expect.soft(r.hasCard, `t-behavior/${sig} [${vp.name}] 신호 카드 없음`).toBeTruthy();
          expect.soft(r.topCaveat, `t-behavior/${sig} [${vp.name}] 상단 상관≠인과 캐비어트 배너 없음`).toBeTruthy();
          expect.soft(r.botCaveats, `t-behavior/${sig} [${vp.name}] 하단 caveats 목록 없음`).toBeGreaterThan(0);
          expect.soft(r.hasGroupsOrEmpty, `t-behavior/${sig} [${vp.name}] 그룹 막대/빈상태 둘 다 없음`).toBeTruthy();
          expect.soft(r.objObj, `t-behavior/${sig} [${vp.name}] [object Object] ${r.objObj}건`).toBe(0);
          expect.soft(r.broken, `t-behavior/${sig} [${vp.name}] 깨진 %/NaN 표기`).toBeFalsy();
          expect.soft(r.titlePx, `t-behavior/${sig} [${vp.name}] 카드 제목 ${r.titlePx}px < 19(스케일 위반)`).toBeGreaterThanOrEqual(19);
          if (sig === 'speed') expect.soft(r.hasMatrix, `t-behavior/speed [${vp.name}] 흡수한 정오×속도 매트릭스 없음`).toBeTruthy();

          // 가로 스크롤 0 (각 신호마다)
          const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
          expect.soft(ov.sw, `t-behavior/${sig} [${vp.name}] 가로 스크롤 scrollWidth ${ov.sw} > clientWidth ${ov.cw}`).toBeLessThanOrEqual(ov.cw + 1);
        }
        await page.close();
      } finally {
        await context.close();
      }
      const allErrors = [...pageErrors, ...consoleErrors];
      expect.soft(allErrors.length, `t-behavior [${vp.name}] 콘솔/JS 에러:\n${allErrors.join('\n')}`).toBe(0);
    });
  }
});

// ── 7) [활동 현황 F] LRS 교사 활용 히트맵 스코프 계약 회귀 (감리 REWORK 박제) ──
//    RW-1: 전체 스코프 히트맵 셀 드릴이 classId=all 전송으로 400(첫 방문 전원 영향)이 되지 않아야 함.
//          FE 계약: 전체 스코프 드릴은 권한 게이트용 classId(소유 반)만 + heatScope 미전송 → BE all-owned 200.
//    RW-2: 특정 클래스 스코프에서 daily 히트맵은 heatScope=class 로 좁혀져 by-service(도넛) 합과 일치해야 함
//          (INV-HC1: heatmapDowHour 합 == by-service count 합 == heatmap-cell 드릴 total 정합).
test.describe('스모크: LRS 활동 현황 히트맵 스코프 계약(감리 REWORK)', () => {
  test('전체 드릴 200(400 아님) · 클래스 히트맵==도넛 합 · 드릴 heatScope 좁힘', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('teacher'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await page.goto('/lrs/index.html?menu=analytics#t-usage', { waitUntil: 'domcontentloaded' });
      // 소유 클래스 목록 → 데이터(비 데모/시연) 클래스 선정
      const owned = await page.evaluate(async () => {
        const r = await fetch('/api/class/my', { credentials: 'include' });
        const j = await r.json();
        return (j.classes || []).map(c => ({ id: c.id, name: c.name }));
      });
      if (!owned.length) { test.info().annotations.push({ type: 'skip-screen', description: '담당 클래스 0 — 스킵' }); await page.close(); return; }
      const dataClass = owned.find(c => !/시연|데모/.test(c.name || '')) || owned[0];

      // RW-1: 전체 스코프 드릴(권한용 classId + heatScope 없음) → 200. classId=all(NaN) → 400 회귀 감시.
      const rw1 = await page.evaluate(async (cid) => {
        const okAll = await fetch(`/api/lrs/stats/heatmap-cell?dow=0&hour=1&classId=${cid}`, { credentials: 'include' }).then(r => r.status);
        const badAll = await fetch('/api/lrs/stats/heatmap-cell?dow=0&hour=1&classId=all', { credentials: 'include' }).then(r => r.status);
        return { okAll, badAll };
      }, dataClass.id);
      expect(rw1.okAll, `RW-1: 전체 스코프 드릴(classId=${dataClass.id}, heatScope 없음) 200 기대`).toBe(200);
      expect(rw1.badAll, 'RW-1 회귀 감시: classId=all 은 400(FE 가 이 값을 보내면 안 됨)').toBe(400);

      // RW-2: 특정 클래스 스코프 — daily(heatScope=class) 히트맵 합 == by-service(classId) 도넛 합.
      const rw2 = await page.evaluate(async (cid) => {
        const daily = await fetch(`/api/lrs/stats/daily?classId=${cid}&heatScope=class`, { credentials: 'include' }).then(r => r.json());
        const svc = await fetch(`/api/lrs/stats/by-service?classId=${cid}`, { credentials: 'include' }).then(r => r.json());
        const heat = (daily.heatmapDowHour || []).reduce((a, row) => a + row.reduce((x, y) => x + (Number(y) || 0), 0), 0);
        const donut = (svc.stats || []).reduce((a, r) => a + (Number(r.count) || 0), 0);
        const drillStatus = await fetch(`/api/lrs/stats/heatmap-cell?dow=0&hour=1&classId=${cid}&heatScope=class`, { credentials: 'include' }).then(r => r.status);
        return { heat, donut, drillStatus };
      }, dataClass.id);
      expect(rw2.drillStatus, 'RW-2: 클래스 스코프 드릴(classId+heatScope) 200 기대').toBe(200);
      expect(rw2.heat, `RW-2: 클래스 히트맵 합(${rw2.heat}) == 도넛 합(${rw2.donut}) (heatScope 좁힘 정합)`).toBe(rw2.donut);

      await page.close();
    } finally {
      await context.close();
    }
  });
});
