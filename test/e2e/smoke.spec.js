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

// 1000% 이상의 깨진 백분율 (예: 8000%). 정상 범위(0~999%)는 통과.
const BROKEN_PCT_RE = /\b[1-9]\d{3,}\s*%/;

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

      // 권한 리다이렉트 → 스킵 처리 (login.html 로 튕기거나 403)
      const landed = page.url();
      if (/\/login\.html/i.test(landed) || (resp && resp.status() === 403)) {
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

      // ── (D) 깨진 백분율(1000%+) 0건 ──
      const brokenPct = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const re = /\b[1-9]\d{3,}\s*%/g;
        return t.match(re) || [];
      });
      expect.soft(brokenPct.length, `${label} [${vp.name}] (D)깨진 백분율 발견: ${JSON.stringify(brokenPct)}`).toBe(0);

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

// ── 역할별 검사 대상 화면 ──────────────────────────────────────────────────
const SCREENS = {
  student: [
    { url: '/', label: '학생-포털메인' },
    { url: '/growth/student-report.html', label: '학생-성장리포트' },
    { url: '/self-learn/learning-map.html', label: '학생-AI맞춤학습 학습맵' },
    { url: '/content/index.html', label: '학생-채움콘텐츠' },
    { url: '/self-learn/wrong-note.html', label: '학생-오답노트' },
  ],
  teacher: [
    { url: '/', label: '교사-포털메인' },
    { url: '/growth/class-dashboard.html', label: '교사-클래스대시보드 학습분석' },
    { url: '/growth/student-report.html', label: '교사-성장리포트(학생조회)' },
    { url: '/class/manage.html', label: '교사-클래스 관리' },
    { url: '/content/index.html', label: '교사-채움콘텐츠' },
  ],
  admin: [
    { url: '/', label: '관리자-포털메인' },
    { url: '/lrs/index.html', label: '관리자-LRS 학습분석' },
    { url: '/admin/index.html', label: '관리자-관리자 페이지' },
  ],
};

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
