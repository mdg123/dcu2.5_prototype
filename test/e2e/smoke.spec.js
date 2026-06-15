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
        brokenPct: t.match(/\b[1-9]\d{3,}\s*%/g) || [],
      };
    }, modalSel);
    expect.soft(inModal.objObj, `${label} [모달] (A)[object Object] ${inModal.objObj}건`).toBe(0);
    expect.soft(inModal.brokenPct.length, `${label} [모달] (D)깨진 백분율: ${JSON.stringify(inModal.brokenPct)}`).toBe(0);

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
