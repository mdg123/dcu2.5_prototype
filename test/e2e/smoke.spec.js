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
// smoke.config.js 의 PORT 와 동일. 여러 작업자가 동시에 돌 때 3100 이 이미 점유돼 있으면
// SMOKE_PORT 로 비켜 갈 수 있다(기본값은 그대로 3100 — 평시 동작 불변).
const BASE_URL = `http://localhost:${process.env.SMOKE_PORT || 3100}`;

// ── [W4] 시간 부패(롤링 창 시한폭탄) 방어 ──────────────────────────────────
//   LRS 기본 기간칩은 "최근 30일"(wall clock). 그 위에 "행이 존재한다" 류의 단언을 얹으면
//   코드가 한 줄도 안 바뀌어도 근거 데이터가 창 밖으로 노화되는 순간 터진다.
//   실제 사례 — P2-2("최근 학습 활동" 카드): student1 의 마지막 학습활동이 2026-07-04 인데
//   2026-08-04 의 30일 창(07-05~08-04)에는 0 건 → #sRecentActs 미렌더로 08-04 부터 자동 실패.
//   해법은 커밋 cf04470(고정 GT 11건)과 동일: **창을 시계가 아니라 데이터에서 유도**한다.
//   test/_setup.js 의 fixtureWindow(SSOT)를 스모크 DB 사본에 그대로 적용하고, 화면에서는
//   실제 UI 경로(기간칩 "사용자 지정" → from/to → 적용)로 그 창을 태운다.
const { SMOKE_DB_PATH } = require('./smoke.db-copy');
const { fixtureWindow } = require('../_setup');

/** 스모크 DB 사본에서 특정 계정의 learning_logs 전 구간 창(YYYY-MM-DD)을 유도. */
function activityWindowFor(username) {
  const Database = require('better-sqlite3');
  const db = new Database(SMOKE_DB_PATH, { readonly: true });
  try {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!u) throw new Error(`스모크 DB 에 ${username} 계정이 없습니다(테스트 전제 붕괴).`);
    return fixtureWindow(db, { userId: u.id, pad: 1 });
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/** 기간칩을 "사용자 지정"으로 바꾸고 from~to 를 적용한다(실 UI 경로 — state 직접 주입 아님). */
async function applyCustomPeriod(page, { from, to }) {
  await page.waitForSelector('#periodPicker button[data-period="custom"]', { timeout: 15000 });
  await page.click('#periodPicker button[data-period="custom"]');
  await page.fill('#rangeFrom', from);
  await page.fill('#rangeTo', to);
  await page.click('#applyCustom');
}

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
      // [W4] 기본 30일 롤링 창 대신 **데이터에서 유도한 창**을 적용한다(시간 부패 방어).
      //   student1 의 학습활동 전 구간을 덮으므로 오늘이 언제든 같은 행 집합을 본다.
      await applyCustomPeriod(page, activityWindowFor('student1'));
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

// ── 8) [A4 성취 모집단 정합] 학생 뷰 고지 정합·표기 정직성 회귀 박제 ──────────
//    기획서: 보고서/LRS_A4_성취모집단_정합_UI_기획_v1.md §4-5
//      INV-A4-5 고지 정합 : 도넛 부제의 "아직 판정 못 한 N개" == counts.insufficient
//                           == standards[status==='insufficient'].length == 범례 개수
//                           (N 을 하드코딩하면 재집계 후 3↔10 처럼 즉시 어긋난다)
//      INV-A4-7 % 금지     : "평균 점수 12%" 부류 0건 — 평균 점수는 점, 정답률만 %
//      INV-A4-8 금지 표현  : 미측정을 정상으로 단정하는 문구("잘하고 있어요"·"이상 없음"·
//                           "격차 없음") 0건 + 저신뢰(r²<0.3)에 방향·시기를 단정하지 않는지
//    INV-A4-1~4·6 은 BE 하네스(test/lrs-a4-population.test.js)가 담당한다.
test.describe('스모크: LRS A4 성취 모집단 고지 정합·표기 정직성(INV-A4-5·7·8)', () => {
  /** 학생 "성취수준 분석"(s-achieve) 진입 — 도넛 + 후행 로드(추이/다음 한 걸음)까지 대기. */
  async function gotoStudentAchieve(page) {
    await page.goto('/lrs/index.html?menu=analytics#s-achieve', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dacheum-gnb-wrapper', { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => {
      const vr = document.getElementById('viewRoot');
      return !!(vr && (vr.querySelector('#sMastDonut') || vr.querySelector('.mastery-empty')));
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => {
      const c = document.getElementById('sTrendChips');
      const n = document.getElementById('sNextStepHost');
      return !!(c && c.innerHTML) || !!(n && n.innerHTML);
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  for (const vp of VIEWPORTS) {
    test(`INV-A4-5: 도넛 고지 N == counts.insufficient == 배열 길이 == 범례 [${vp.name}]`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
      try {
        const page = await context.newPage();
        page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoStudentAchieve(page);

        const r = await page.evaluate(async () => {
          const me = await fetch('/api/auth/me', { credentials: 'include' }).then((x) => x.json()).catch(() => null);
          const uid = me && (me.user ? me.user.id : me.id);
          const api = uid
            ? await fetch('/api/lrs/mastery/student/' + uid, { credentials: 'include' }).then((x) => x.json()).catch(() => null)
            : null;
          const txt = (document.getElementById('viewRoot') || {}).innerText || '';
          const subM = txt.match(/아직 판정 못 한 성취기준 (\d+)개/);
          // [A4b R-3] 세 번째 독립 렌더러가 추천 카운터 → 강·약 부제로 바뀌었다.
          //   카운터에서 모집단 수를 뺀 이유: 한 줄에 "판정 전 1개 … 전체 미판정 14개"처럼
          //   같은 상태의 이름이 둘 등장했기 때문(어휘 분열). 대신 **다른 DOM 노드**를 읽어
          //   도넛 부제와의 독립성을 유지한다(innerText 전체 match 는 첫 일치만 잡혀 자기참조가 된다).
          const dvSub = document.querySelector('#sDivergeSection .mastery-sub');
          const recoM = (dvSub ? (dvSub.textContent || '') : '').match(/아직 판정 못 한 (\d+)개는 위 도넛/);
          // 도넛 범례·세그먼트는 canvas 안이라 innerText 로 안 잡힌다 → Chart 인스턴스에서 직접 읽는다.
          const canvas = document.getElementById('sMastDonut');
          const ch = (canvas && window.Chart && window.Chart.getChart) ? window.Chart.getChart(canvas) : null;
          let segN = null;
          if (ch && ch.data && Array.isArray(ch.data.labels)) {
            const i = ch.data.labels.indexOf('아직 판정 못 함');
            if (i >= 0) segN = Number(ch.data.datasets[0].data[i]);
          }
          return {
            hasDonut: !!canvas,
            noData: !api || api.success === false || !api.counts,
            apiInsuf: api && api.counts ? Number(api.counts.insufficient) : null,
            arrLen: api && Array.isArray(api.standards)
              ? api.standards.filter((s) => s && s.status === 'insufficient').length : null,
            subN: subM ? Number(subM[1]) : null,
            segN,
            recoN: recoM ? Number(recoM[1]) : null,
            // 구 어휘("평가 부족")가 학생 도넛 범례로 되살아나면 실패
            oldLegend: !!(ch && ch.data && Array.isArray(ch.data.labels) && ch.data.labels.indexOf('평가 부족') >= 0),
            oldSub: /평가 부족 \d+개는 분모에서 제외/.test(txt),
          };
        });

        if (r.noData || !r.hasDonut) {
          test.info().annotations.push({ type: 'skip-screen', description: 'mastery 데이터 없음 — 스킵' });
          await page.close();
          return;
        }
        // (a) BE 자체 정합
        expect.soft(r.arrLen, `INV-A4-5 [${vp.name}] counts.insufficient(${r.apiInsuf}) != standards 배열 길이(${r.arrLen})`).toBe(r.apiInsuf);
        // (b) 화면 고지가 그 값을 그대로 렌더하는가(하드코딩 금지)
        if (r.apiInsuf > 0) {
          expect.soft(r.subN, `INV-A4-5 [${vp.name}] 도넛 부제 고지 N(${r.subN}) != counts.insufficient(${r.apiInsuf})`).toBe(r.apiInsuf);
          expect.soft(r.segN, `INV-A4-5 [${vp.name}] 도넛 회색 세그먼트 값(${r.segN}) != counts.insufficient(${r.apiInsuf})`).toBe(r.apiInsuf);
          expect.soft(r.recoN, `INV-A4-5 [${vp.name}] 강·약 부제 고지 N(${r.recoN}) != counts.insufficient(${r.apiInsuf})`).toBe(r.apiInsuf);
        }
        expect.soft(r.oldSub, `INV-A4-5 [${vp.name}] 구 문구 "평가 부족 N개는 분모에서 제외" 재출현`).toBeFalsy();
        expect.soft(r.oldLegend, `INV-A4-5 [${vp.name}] 학생 도넛 범례에 구 어휘 "평가 부족" 재출현`).toBeFalsy();

        await page.close();
      } finally { await context.close(); }
    });
  }

  test('INV-A4-7: 학생 뷰에 "평균 점수 N%" 0건 (평균 점수는 점, 정답률만 %)', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      const hits = [];
      for (const go of [gotoStudentHome, gotoStudentAchieve]) {
        await go(page);
        const found = await page.evaluate(() => {
          const t = (document.getElementById('viewRoot') || {}).innerText || '';
          return (t.match(/평균\s*점수\s*\d+(?:\.\d+)?\s*%/g) || []);
        });
        hits.push(...found);
      }
      expect(hits.length, `INV-A4-7: "평균 점수 N%" 표기 발견: ${JSON.stringify(hits)}`).toBe(0);
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-A4-8: 학생 뷰 금지 표현 0 + 저신뢰 추세 방향·시기 단정 금지', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });

      // 미측정을 정상으로 단정하는 문구(정본사전 §5-1).
      //   "모두 도달"은 측정 범위를 앞에 밝힌 형태("평가로 판정한 …는 모두 도달")만 허용하므로 목록에서 제외.
      const BANNED = ['잘하고 있어요', '이상 없음', '격차 없음', '막힌 곳이 없어요'];
      const all = [];
      for (const go of [gotoStudentHome, gotoStudentAchieve]) {
        await go(page);
        const found = await page.evaluate((banned) => {
          const t = (document.getElementById('viewRoot') || {}).innerText || '';
          return banned.filter((b) => t.includes(b));
        }, BANNED);
        all.push(...found);
      }
      expect.soft(all.length, `INV-A4-8: 금지 표현 노출: ${JSON.stringify([...new Set(all)])}`).toBe(0);

      // 저신뢰(BE confidence !== 'high') 추세에 상승/시기를 단정하는 칩이 뜨면 실패.
      //   BE _trendConfidence: 관측 6주 이상 ∧ r² ≥ 0.3 일 때만 'high'.
      await gotoStudentAchieve(page);
      const tr = await page.evaluate(async () => {
        const me = await fetch('/api/auth/me', { credentials: 'include' }).then((x) => x.json()).catch(() => null);
        const uid = me && (me.user ? me.user.id : me.id);
        const td = uid
          ? await fetch('/api/lrs/trend/student/' + uid, { credentials: 'include' }).then((x) => x.json()).catch(() => null)
          : null;
        const chips = document.getElementById('sTrendChips');
        return {
          conf: td && td.trend ? td.trend.confidence : null,
          status: td && td.trend ? td.trend.status : null,
          weeks: td && td.trend ? Number(td.trend.observedWeeks) : null,
          chipsTxt: chips ? (chips.innerText || '') : '',
          hasBadge: !!document.querySelector('.strend-lowconf'),
        };
      });
      if (tr.status === 'ok' && tr.conf && tr.conf !== 'high' && (tr.weeks || 0) >= 3) {
        expect.soft(/꾸준히 오르고 있어요/.test(tr.chipsTxt),
          `INV-A4-8: confidence=${tr.conf}(저신뢰)인데 "꾸준히 오르고 있어요" 단정 노출 — ${tr.chipsTxt}`).toBeFalsy();
        expect.soft(/\d+\s*주 후/.test(tr.chipsTxt),
          `INV-A4-8: confidence=${tr.conf}(저신뢰)인데 "N주 후" 시기 단정 노출 — ${tr.chipsTxt}`).toBeFalsy();
        expect.soft(tr.hasBadge,
          `INV-A4-8: confidence=${tr.conf}(저신뢰)인데 "변동이 커서 참고용" 배지 없음`).toBeTruthy();
      }
      await page.close();
    } finally { await context.close(); }
  });
});

// ── 9) [A4b 판정 임계 일관성] 도넛·강약차트·추천 카운터·추세 문구가 같은 분류기를 쓰는가 ──
//    배경: A4 배포 후 GCP 실서버 student1(전 셀 attempts<3)에서 한 화면이 세 가지로 말했다.
//      · 도넛 중앙 "14 / 14"(= 14개 중 14개 달성으로 읽힘) — 실제 도달 0개
//      · 도넛 "평가된 0개" ↔ 강·약 차트 빨간 "미도달" 막대 2개(정본사전 §4-3 위반)
//      · r²=0.02 인데 "이미 정답률 80% 수준이에요 · 이대로 꾸준히!"
//    원인: 도넛은 SSOT status(classifyStatus, MIN_ATTEMPTS=3)를 쓰는데 강·약 차트와
//          추천 카운터는 임계를 보지 않고 rate 만 봤다(FE 에 임계가 두 벌).
//
//      INV-A4-9  임계 일관성 : 강·약 차트에 그려진 막대는 전부 status !== 'insufficient'.
//                              판정 끝난 셀이 0개면 차트가 아니라 빈 상태.
//      INV-A4-10 도넛 중앙   : .dc-num 이 "A / B" 형태라면 A==counts.reached ∧ B==평가된 수.
//                              (분모 0에서 비율을 만들지 않는다 — "14 / 14" 재발 차단)
//      INV-A4-11 저신뢰 단정 : confidence!=='high' 이면 성취 수준·유지 단정 문구 0건.
//    실 DB 는 이 상태를 재현하지 못하므로(로컬·스모크 사본 student1 은 판정 완료 셀 보유)
//    GCP 실측을 그대로 옮긴 합성 페이로드를 route 스텁으로 주입해 FE 계약만 검사한다.
test.describe('스모크: LRS A4b 판정 임계 일관성(INV-A4-9·10·11)', () => {
  /** GCP 실측 재현 픽스처 — total 14 / 전부 insufficient / attempts>0 7건 / attempts>=3 0건 */
  const S = (code, label, attempts, correct, subject) => ({
    code, std_id: null, std_ids: [], label, fullLabel: label, area: null,
    subject_code: 'math-e', subject: subject || '수학',
    attempts, correct,
    rate: attempts > 0 ? Math.round((correct / attempts) * 1000) / 10 : null,
    status: 'insufficient', statusKo: '평가부족',
    lastAt: '2026-08-01 10:00:00', recommendations: [],
  });
  const FIX_MASTERY = {
    success: true, userId: 3, scoped: false, period: null,
    counts: { total: 14, reached: 0, partial: 0, notReached: 0, insufficient: 14 },
    distribution: { reached: 0, partial: 0, not_reached: 0, insufficient: 14, total: 14 },
    bySubject: [
      { subject_code: 'math-e', subject: '수학', standardCount: 13, evaluatedCount: 0, reachedCount: 0, reachedRate: null, avgRate: 77.8 },
      { subject_code: 'english-e', subject: '영어', standardCount: 1, evaluatedCount: 0, reachedCount: 0, reachedRate: null, avgRate: null },
    ],
    strengths: [], weaknesses: [],
    standards: [
      S('[4수01-16]', '나눗셈의 활용', 2, 2),
      S('[4수01-05]', '나눗셈의 의미', 1, 0),   // rate 0 — 과거 코드가 빨간 "미도달"로 그리던 셀
      S('[4수01-14]', '곱셈의 활용', 1, 1),
      S('[4수01-15]', '분수의 크기 비교', 1, 1),
      S('[4수02-03]', '직각삼각형', 1, 0),      // rate 0 — 위와 같음
      S('[4수01-11]', '소수의 덧셈', 1, 1),
      S('[4수03-09]', '들이와 무게', 2, 2),
      S('[4수01-02]', '큰 수의 자릿값', 0, 0),
      S('[4수01-13]', '분수의 덧셈', 0, 0),
      S('[4수03-02]', '평면도형의 이동', 0, 0),
      S('[4수03-04]', '각도의 합과 차', 0, 0),
      S('[4수03-10]', '시간의 계산', 0, 0),
      S('[4수04-02]', '막대그래프', 0, 0),
      S('[4영01-08]', '알파벳 익히기', 0, 0, '영어'),
    ],
  };
  const RECO_ROW = {
    priority: 'recommended', achievement_code: '[4수01-05]', label: '나눗셈의 의미', fullLabel: '나눗셈의 의미',
    subject_code: 'math-e', subject_label: '수학', status: 'insufficient', statusLabel: '평가부족',
    hasScore: false, avg_score: null, correctRate: 0, success_count: 0, attempt_count: 1,
    // ⚠ 실제 BE 문구 그대로(routes/lrs.js recoReasonText — STATUS.INSUFFICIENT 분기).
    //   픽스처가 임의 문구를 쓰면 어휘 단언이 화면이 아니라 픽스처를 검사하게 된다.
    reasonText: '아직 1번밖에 안 풀었어요 — 3번 이상 풀면 도달 판정을 받을 수 있어요',
    estMinutes: 12, recommendedContentIds: [],
  };
  const FIX_INSIGHTS = { success: true, userId: 3, weaknesses: [RECO_ROW], strengths: [], recommendations: [RECO_ROW] };
  // r²=0.02(저신뢰) · 관측 4주 · 이번 주 100%(2문제 중 2개) · 최근 2주 35 → 100(+65%p)
  const FIX_TREND = {
    success: true, userId: 3, target: 80,
    period: { fromDate: '2026-07-06', toDate: '2026-08-05', label: '최근 30일', weeks: 8 },
    trend: {
      status: 'ok', slope: 3.1, r2: 0.02, confidence: 'low',
      direction: 'up', directionKo: '상승', observedWeeks: 4, currentRate: 100,
      series: [
        { week: '2026-28', rate: 50, attempts: 4 },
        { week: '2026-29', rate: 0, attempts: 1 },
        { week: '2026-30', rate: 35, attempts: 3 },
        { week: '2026-31', rate: 100, attempts: 2 },
      ],
    },
    projection: { status: 'ok', reachable: true, weeksToReach: 2, band: { lo: 40, hi: 100 } },
    disclaimer: '이 추정은 규칙 기반이라 실제와 다를 수 있어요.',
  };

  async function gotoAchieve(page) {
    await page.goto('/lrs/index.html?menu=analytics#s-achieve', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#viewRoot', { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => {
      const vr = document.getElementById('viewRoot');
      return !!(vr && (vr.querySelector('#sMastDonut') || vr.querySelector('.mastery-empty')));
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => {
      const c = document.getElementById('sTrendChips');
      return !!(c && c.innerHTML);
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
  }

  /** 화면에서 도넛 중앙·강약 막대·추천 카운터·추세 문구를 한 번에 채집. */
  const probe = (page) => page.evaluate(async () => {
    const vr = document.getElementById('viewRoot');
    const txt = (vr && vr.innerText) || '';
    const me = await fetch('/api/auth/me', { credentials: 'include' }).then((x) => x.json()).catch(() => null);
    const uid = me && (me.user ? me.user.id : me.id);
    const api = uid
      ? await fetch('/api/lrs/mastery/student/' + uid, { credentials: 'include' }).then((x) => x.json()).catch(() => null)
      : null;
    const dc = document.querySelector('#sMastDonut')?.closest('.donut-wrap')?.querySelector('.donut-center');
    const ch = (window.Chart && window.Chart.getChart)
      ? window.Chart.getChart(document.getElementById('sMastDiverge')) : null;
    const ds = ch && ch.data && ch.data.datasets[0] ? ch.data.datasets[0] : null;
    const meta = ds ? (ds._meta || []) : null;
    const c = api && api.counts ? api.counts : null;
    // 카운터는 innerText 전역 매치가 아니라 **그 노드**에서 읽는다(다른 문구와 섞이지 않게).
    const cnt = document.querySelector('#sNextSection .ms-controls')?.textContent || '';
    // 범례 색(CSS 디자인 토큰) — 막대 색 계약의 기준값. JS 상수를 테스트가 복제하지 않는다.
    const rs = getComputedStyle(document.documentElement);
    const norm = (v) => String(v || '').trim().toLowerCase();
    const legendHex = {
      reached: norm(rs.getPropertyValue('--mastery-reached')),
      partial: norm(rs.getPropertyValue('--mastery-partial')),
      notReached: norm(rs.getPropertyValue('--mastery-notreached')),
      insufficient: norm(rs.getPropertyValue('--mastery-insufficient')),
    };
    const normStatusT = (s) => (s === 'not_reached' || s === 'notReached') ? 'notReached'
      : (s === 'reached' || s === 'partial' || s === 'insufficient') ? s : 'insufficient';
    const bg = ds ? ds.backgroundColor : null;
    return {
      ok: !!(api && api.success && c),
      counts: c,
      evaluated: c ? (Number(c.reached || 0) + Number(c.partial || 0) + Number(c.notReached || 0)) : null,
      dcNum: dc ? (dc.querySelector('.dc-num')?.textContent || '') : null,
      barStatuses: meta ? meta.map((s) => String(s && s.status)) : null,
      barCount: meta ? meta.length : 0,
      // [A4b R-4] 막대별 (라벨, 상태, 실제 칠해진 색, 상태가 요구하는 범례 색, 부호)
      bars: meta ? meta.map((s, i) => ({
        label: s && s.label, status: normStatusT(s && s.status),
        color: norm(Array.isArray(bg) ? bg[i] : bg),
        want: legendHex[normStatusT(s && s.status)],
        value: ds.data[i],
      })) : null,
      legendHex,
      divergeEmpty: !!document.querySelector('#sDivergeBody .mastery-empty'),
      // 빈 상태에서 막대에 종속된 부속 UI 가 남아 있는지(R-2)
      asideVisible: ['#sDivergeSection .ms-controls', '#sDivergeSection .mastery-legend']
        .map((sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display !== 'none' : false; }),
      recoFill: (cnt.match(/보완\s*(\d+)\s*개/) || [null, null])[1],
      recoPre: (cnt.match(/아직 판정 못 함\s*(\d+)\s*개/) || [null, null])[1],
      recoDeep: (cnt.match(/심화\s*(\d+)\s*개/) || [null, null])[1],
      counterTxt: cnt,
      // [A4b R-3] 평가부족 상태를 부르는 이름이 화면에 몇 종류나 있는가(SSOT 1종이어야 함)
      vocabHits: ['판정 전', '미판정', '판정을 기다리'].filter((w) => txt.includes(w)),
      recoCards: document.querySelectorAll('#sRecoGrid .reco-card').length,
      chips: document.getElementById('sTrendChips')?.innerText || '',
      rx: document.getElementById('sTrendRxText')?.innerText || '',
      lowConfBadge: !!document.querySelector('.strend-lowconf'),
    };
  });

  /** 임계 일관성 + 도넛 중앙 비율 계약 — 어떤 데이터에서도 성립해야 하는 공통 단언. */
  function assertThresholdContract(r, tag) {
    // (1) 그려진 막대는 전부 판정이 끝난 셀이어야 한다("평가 부족" ≠ "미도달")
    const bad = (r.barStatuses || []).filter((s) => s === 'insufficient');
    expect.soft(bad.length,
      `INV-A4-9 [${tag}] 강·약 차트에 판정 임계 미달(insufficient) 막대 ${bad.length}개 — 도넛은 평가된 ${r.evaluated}개라고 말하는데 여기선 미도달로 그린다`).toBe(0);
    // (1-b) [A4b R-4] 막대 색은 **버킷(좌/우)이 아니라 상태**를 따라야 한다.
    //   좌반면을 무조건 빨강(미도달)으로 칠하면 정답률 50~69 인 "부분 도달"이 범례상 미도달로 보인다.
    //   기준값은 테스트가 복제한 상수가 아니라 화면이 실제로 쓰는 CSS 디자인 토큰(범례 색)이다.
    for (const b of (r.bars || [])) {
      if (!b.want) continue; // 토큰 미해석(브라우저 차이) 시 건너뜀 — 위양성 방지
      expect.soft(b.color, `INV-A4-9 [${tag}] 막대 "${b.label}"(${b.status}) 색 ${b.color} != 범례 ${b.status} 색 ${b.want}`).toBe(b.want);
    }
    // (2) 판정 끝난 셀이 0개면 막대가 하나도 없어야 하고, 빈 상태가 떠야 한다
    if (r.evaluated === 0) {
      expect.soft(r.barCount, `INV-A4-9 [${tag}] 평가된 성취기준 0개인데 강·약 막대 ${r.barCount}개 렌더`).toBe(0);
      expect.soft(r.divergeEmpty, `INV-A4-9 [${tag}] 평가된 성취기준 0개인데 강·약 빈 상태 안내 없음`).toBeTruthy();
      // [A4b R-2] 막대가 0개면 그 막대를 설명하는 부속 UI(표시 개수·4색 범례)도 남으면 안 된다
      expect.soft(r.asideVisible, `INV-A4-9 [${tag}] 빈 상태인데 [표시개수, 범례] 노출 = ${JSON.stringify(r.asideVisible)}`).toEqual([false, false]);
    }
    // (2-b) [A4b R-3] 평가부족 상태의 이름은 SSOT 1종("아직 판정 못 함")만 쓴다
    expect.soft(r.vocabHits, `INV-A4-9 [${tag}] 평가부족 어휘 분열 — 금지 표현 ${JSON.stringify(r.vocabHits)} 노출(SSOT: insufKo())`).toEqual([]);
    // (3) 도넛 중앙이 "A / B" 비율이면 A=도달·B=평가된 수여야 한다(분모 0 비율 창작 금지)
    const m = String(r.dcNum || '').match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (m) {
      expect.soft(Number(m[1]), `INV-A4-10 [${tag}] 도넛 중앙 분자(${m[1]}) != counts.reached(${r.counts.reached})`).toBe(Number(r.counts.reached || 0));
      expect.soft(Number(m[2]), `INV-A4-10 [${tag}] 도넛 중앙 분모(${m[2]}) != 평가된 성취기준 수(${r.evaluated}) — "N / N"이 완료율로 오독된다`).toBe(Number(r.evaluated));
    }
    // (4) 추천 카운터: 보완/판정 전/심화 합 == 실제 렌더된 추천 카드 수
    if (r.recoFill != null && r.recoPre != null && r.recoDeep != null) {
      const sum = Number(r.recoFill) + Number(r.recoPre) + Number(r.recoDeep);
      expect.soft(sum, `INV-A4-9 [${tag}] 추천 카운터 합(${sum}) != 렌더된 추천 카드 수(${r.recoCards})`).toBe(r.recoCards);
    }
  }

  test('INV-A4-9·10: 실 데이터 — 강·약 막대 전부 판정 완료 · 도넛 중앙 비율 계약', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      await gotoAchieve(page);
      const r = await probe(page);
      if (!r.ok) {
        test.info().annotations.push({ type: 'skip-screen', description: 'mastery 데이터 없음 — 스킵' });
      } else {
        assertThresholdContract(r, '실DB');
      }
      await page.close();
    } finally { await context.close(); }
  });

  for (const vp of VIEWPORTS) {
    test(`INV-A4-9·10·11: GCP 재현(전 셀 판정 임계 미달) 합성 페이로드 [${vp.name}]`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
      try {
        const page = await context.newPage();
        page.setViewportSize({ width: vp.width, height: vp.height });
        const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        await page.route('**/api/lrs/mastery/student/**', (rt) => rt.fulfill(json(FIX_MASTERY)));
        await page.route('**/api/lrs/insights/**', (rt) => rt.fulfill(json(FIX_INSIGHTS)));
        await page.route('**/api/lrs/trend/student/**', (rt) => rt.fulfill(json(FIX_TREND)));
        await gotoAchieve(page);
        const r = await probe(page);

        expect(r.ok, `[${vp.name}] 합성 mastery 페이로드가 주입되지 않음(route 스텁 실패)`).toBeTruthy();
        expect(r.evaluated, `[${vp.name}] 픽스처 전제 붕괴 — 평가된 성취기준이 0이 아님`).toBe(0);
        assertThresholdContract(r, `${vp.name}/합성`);

        // 도넛 중앙이 "14 / 14"(= 평가부족 수 / 총계)로 되살아나면 실패
        expect.soft(r.dcNum, `INV-A4-10 [${vp.name}] 도넛 중앙이 "N / N"(완료율 오독) 로 재출현 — ${r.dcNum}`)
          .not.toMatch(/^\s*14\s*\/\s*14\s*$/);
        // 판정 임계를 못 넘은 추천은 "보완"이 아니다(도넛의 평가된 0개와 모순)
        expect.soft(Number(r.recoFill), `INV-A4-9 [${vp.name}] 평가된 0개인데 추천 카운터 "보완 ${r.recoFill}개"`).toBe(0);
        // 고지 N 은 여전히 counts.insufficient(INV-A4-5 계약 유지)
        // 고지 N 은 여전히 counts.insufficient — 렌더러가 카운터 → 강·약 부제로 바뀌었을 뿐(R-3)
        const dvN = await page.evaluate(() => {
          const e = document.querySelector('#sDivergeSection .mastery-sub');
          const m = (e ? (e.textContent || '') : '').match(/아직 판정 못 한 (\d+)개는 위 도넛/);
          return m ? Number(m[1]) : null;
        });
        expect.soft(dvN, `INV-A4-5 [${vp.name}] 강·약 부제 고지 N(${dvN}) != counts.insufficient(14)`).toBe(14);

        // ── INV-A4-11: 저신뢰(r²=0.02)에서 성취 수준·유지 단정 금지 ──
        expect.soft(/이미 정답률\s*\d+%\s*수준/.test(r.chips),
          `INV-A4-11 [${vp.name}] 저신뢰(r²=0.02)·평가된 0개인데 "이미 정답률 N% 수준" 단정 — ${r.chips}`).toBeFalsy();
        expect.soft(/이대로 꾸준히!/.test(r.chips),
          `INV-A4-11 [${vp.name}] 저신뢰인데 "이대로 꾸준히!" 단정 — ${r.chips}`).toBeFalsy();
        expect.soft(/꾸준히 오르고 있어요/.test(r.chips),
          `INV-A4-11 [${vp.name}] 저신뢰인데 방향 단정 — ${r.chips}`).toBeFalsy();
        expect.soft(/\d+\s*주 후/.test(r.chips),
          `INV-A4-11 [${vp.name}] 저신뢰인데 시기 단정 — ${r.chips}`).toBeFalsy();
        expect.soft(r.lowConfBadge,
          `INV-A4-11 [${vp.name}] 저신뢰인데 "변동이 커서 참고용" 배지 없음`).toBeTruthy();
        // 1~2문제만 푼 주가 낀 Δ 로 "N점 올랐어요" 단정 금지(35%→100% 의 실체는 2문제 중 2개)
        expect.soft(/정답률이\s*\d+점\s*올랐어요/.test(r.rx),
          `INV-A4-11 [${vp.name}] 표본 얇은 주(1~2문제)를 근거로 상승 단정 — ${r.rx}`).toBeFalsy();

        // 가로 스크롤 0 (합성 데이터에서도)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect.soft(overflow, `[${vp.name}] 가로 스크롤 ${overflow}px`).toBeLessThanOrEqual(0);

        await page.close();
      } finally { await context.close(); }
    });
  }

  // ── [A4b R-4] 색 계약 — 4상태가 섞인 상태에서 막대 색이 상태와 1:1인가 ────────────
  //   위 GCP 재현 픽스처는 전 셀이 평가부족이라 막대가 0개다. 그래서 "약점 버킷을 무조건
  //   빨강으로 칠하던" 결함은 그 픽스처로는 **절대 재현되지 않는다**(감리 역주입 R5 가 뚫린 이유).
  //   도달·부분(강)·부분(약)·미도달·평가부족을 한 학생에 섞어, 정답률 50~69 인 "부분 도달"이
  //   좌반면에 놓여도 주황을 유지하는지 본다. 기준값은 화면이 쓰는 CSS 토큰(범례 색)이다.
  const M = (code, label, attempts, correct, status) => ({
    code, std_id: null, std_ids: [], label, fullLabel: label, area: null,
    subject_code: 'math-e', subject: '수학', attempts, correct,
    rate: attempts > 0 ? Math.round((correct / attempts) * 1000) / 10 : null,
    status, statusKo: status, lastAt: '2026-08-01 10:00:00', recommendations: [],
  });
  const FIX_MIXED = {
    success: true, userId: 3, scoped: false, period: null,
    counts: { total: 5, reached: 1, partial: 2, notReached: 1, insufficient: 1 },
    distribution: { reached: 1, partial: 2, not_reached: 1, insufficient: 1, total: 5 },
    bySubject: [{ subject_code: 'math-e', subject: '수학', standardCount: 5, evaluatedCount: 4, reachedCount: 1, reachedRate: 25, avgRate: 62 }],
    strengths: [], weaknesses: [],
    standards: [
      M('[4수01-04]', '두 자리 수의 곱셈', 10, 10, 'reached'),      // 100% → 강점 · 초록
      M('[4수01-07]', '들이와 무게', 10, 7, 'partial'),             //  70% → 강점 · 주황
      M('[4수01-08]', '분수의 크기 비교', 10, 6, 'partial'),        //  60% → 약점 · 주황  ★ R5 표적
      M('[4수01-05]', '나눗셈의 의미', 10, 2, 'not_reached'),       //  20% → 약점 · 빨강
      M('[4수03-02]', '평면도형의 이동', 1, 0, 'insufficient'),     //   0% → 그리지 않음
    ],
  };

  test('INV-A4-9(색 계약): 4상태 혼합 — 막대 색 == 상태 색, 약점 부분도달이 빨강으로 강등되지 않음', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      page.setViewportSize({ width: 1440, height: 900 });
      const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      await page.route('**/api/lrs/mastery/student/**', (rt) => rt.fulfill(json(FIX_MIXED)));
      await gotoAchieve(page);
      const r = await probe(page);

      expect(r.ok, '합성 mastery 페이로드 주입 실패').toBeTruthy();
      // 평가부족 1건은 제외되고 판정 완료 4건만 그려진다
      expect.soft(r.barCount, `INV-A4-9(색): 막대 수 ${r.barCount} != 판정 완료 4건`).toBe(4);
      assertThresholdContract(r, '혼합');

      const by = Object.fromEntries((r.bars || []).map((b) => [b.label, b]));
      const pw = by['분수의 크기 비교'];   // 60% — 약점 버킷의 부분 도달
      const nr = by['나눗셈의 의미'];      // 20% — 미도달
      const ps = by['들이와 무게'];        // 70% — 강점 버킷의 부분 도달
      const rc = by['두 자리 수의 곱셈'];  // 100% — 도달

      expect.soft(!!pw, 'INV-A4-9(색): 약점 부분도달 막대가 없음(픽스처 전제 붕괴)').toBeTruthy();
      if (pw) {
        // ★ 감리 R5 역주입(약점 버킷 = 무조건 빨강)이 정확히 여기서 붉어진다
        expect.soft(pw.color, `INV-A4-9(색): 정답률 60% "부분 도달"이 미도달 빨강(${r.legendHex.notReached})으로 강등 — 범례와 불일치`).toBe(r.legendHex.partial);
        expect.soft(pw.color, 'INV-A4-9(색): 부분 도달 막대가 미도달 색과 같음').not.toBe(r.legendHex.notReached);
        expect.soft(pw.value < 0, `INV-A4-9(색): 약점(60%)이 좌반면(음수)에 있지 않음 — value=${pw.value}`).toBeTruthy();
      }
      if (ps) {
        expect.soft(ps.color, 'INV-A4-9(색): 강점 부분도달 색 != 범례 부분도달').toBe(r.legendHex.partial);
        expect.soft(ps.value > 0, `INV-A4-9(색): 강점(70%)이 우반면(양수)에 있지 않음 — value=${ps.value}`).toBeTruthy();
      }
      if (nr) expect.soft(nr.color, 'INV-A4-9(색): 미도달 색 != 범례 미도달').toBe(r.legendHex.notReached);
      if (rc) expect.soft(rc.color, 'INV-A4-9(색): 도달 색 != 범례 도달').toBe(r.legendHex.reached);
      // 부분 도달 두 개가 좌·우로 갈려도 **같은 색**이어야 한다(버킷이 색을 바꾸지 않는다)
      if (pw && ps) expect.soft(pw.color, 'INV-A4-9(색): 같은 부분 도달인데 좌/우 버킷에 따라 색이 다름').toBe(ps.color);
      // 막대가 있으면 부속 UI(표시 개수·범례)는 보여야 한다(R-2 의 반대 방향 — 과잉 숨김 금지)
      expect.soft(r.asideVisible, `INV-A4-9(색): 막대가 있는데 [표시개수, 범례] 노출 = ${JSON.stringify(r.asideVisible)}`).toEqual([true, true]);

      await page.close();
    } finally { await context.close(); }
  });
});

// ── 8) [P0-7] 클래스 설정 화면 전면 진입 + 초대코드 유출 회귀 ───────────────
//   2026-08-05 실서버 실측: student1(일반 멤버)이 /class/manage.html?id=N 로 그대로 들어가
//   초대코드·복사/QR·공개여부 편집·멤버 강퇴·"클래스 삭제"까지 렌더됐다.
//   초대코드는 비공개 클래스의 유일한 접근 통제 수단이므로(join 이 is_public 을 보지 않는다)
//   학생이 외부에 뿌리면 임의의 제3자가 학급 게시판·감정·성적 화면까지 들어온다.
//   API 층은 test/class-invite-code-guard.test.js 가 박제한다. 여기는 **화면과 GNB**다.
test.describe('스모크: P0-7 클래스 설정 접근 통제', () => {
  /** 해당 역할의 클래스 중 my_role 이 조건에 맞는 첫 클래스 id */
  async function pickClass(browser, role, wantOwner) {
    const context = await browser.newContext({ storageState: stateFor(role), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await page.goto('/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const id = await page.evaluate(async (wo) => {
        try {
          const r = await fetch('/api/class/my');
          if (!r.ok) return null;
          const d = await r.json();
          const hit = (d.classes || []).find((c) => (c.my_role === 'owner') === wo);
          return hit ? hit.id : null;
        } catch (_) { return null; }
      }, wantOwner).catch(() => null);
      await page.close();
      return id;
    } finally { await context.close(); }
  }

  test('P0-7①: 학생(일반 멤버)이 클래스 설정에 들어가면 권한 안내 — 초대코드·위험영역 0', async ({ browser }) => {
    const cid = await pickClass(browser, 'student', false);
    if (!cid) test.skip(true, 'student1 이 일반 멤버인 클래스 없음');
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await page.goto(`/class/manage.html?id=${cid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const code = document.getElementById('codeDisplay');
        return {
          denied: !!document.getElementById('dcDeniedPanel'),
          codeText: code ? code.textContent.trim() : '',
          codeVisible: !!(code && code.offsetParent !== null),
          hasInviteLabel: /초대 코드/.test(t),
          hasDanger: /위험 영역|클래스 삭제/.test(t),
          hasKick: /내보내기|권한부여/.test(t),
          hasPublicToggle: /공개 \(클래스 찾기에 노출\)/.test(t),
        };
      });
      expect.soft(r.denied, 'P0-7①: 학생에게 권한 안내 패널이 안 뜬다(관리 UI 가 그대로 렌더됨)').toBeTruthy();
      expect.soft(r.codeText, `P0-7①: 학생 화면에 초대코드 문자열이 남아 있다(${r.codeText})`).toBe('');
      expect.soft(r.codeVisible, 'P0-7①: 초대코드 요소가 학생에게 보인다').toBeFalsy();
      expect.soft(r.hasInviteLabel, 'P0-7①: 학생 화면에 "초대 코드" 라벨 노출').toBeFalsy();
      expect.soft(r.hasDanger, 'P0-7①: 학생 화면에 위험 영역/클래스 삭제 노출').toBeFalsy();
      expect.soft(r.hasKick, 'P0-7①: 학생 화면에 멤버 강퇴/권한부여 노출').toBeFalsy();
      expect.soft(r.hasPublicToggle, 'P0-7①: 학생 화면에 공개여부 편집 폼 노출').toBeFalsy();
      await page.close();
    } finally { await context.close(); }
  });

  test('P0-7②: GNB "클래스 관리" 가 학생에게 미노출 · 교사에게 노출', async ({ browser }) => {
    for (const [role, want] of [['student', false], ['teacher', true]]) {
      const context = await browser.newContext({ storageState: stateFor(role), locale: 'ko-KR', baseURL: BASE_URL });
      try {
        const page = await context.newPage();
        await page.goto('/class/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800);
        const items = await page.evaluate(() =>
          [...document.querySelectorAll('.gnb-nav2-item')].map((a) => a.textContent.trim()));
        const has = items.includes('클래스 관리');
        expect.soft(has, `P0-7②: ${role} GNB "클래스 관리" 노출=${has} (기대 ${want}) — 실제 메뉴 ${JSON.stringify(items)}`).toBe(want);
        await page.close();
      } finally { await context.close(); }
    }
  });

  test('P0-7③: 나의 클래스 목록에 남의 반 초대코드 칩 0 (내가 만든 반은 유지)', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('student'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await page.goto('/class/index.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(async () => {
        const pills = [...document.querySelectorAll('.class-code-pill')].map((e) => e.textContent.trim()).filter(Boolean);
        const d = await fetch('/api/class/my').then((x) => x.json()).catch(() => ({}));
        const list = d.classes || [];
        return {
          pills,
          ownedCodes: list.filter((c) => c.my_role === 'owner').map((c) => c.code).filter(Boolean),
          memberWithCode: list.filter((c) => c.my_role !== 'owner' && c.code).length,
        };
      });
      expect.soft(r.memberWithCode, `P0-7③: 일반 멤버 클래스 ${r.memberWithCode}건의 초대코드가 API 에서 내려온다`).toBe(0);
      // 화면 칩은 "내가 개설한 반"의 코드만 남아야 한다 — 과잉 차단(내 반 코드까지 제거) 도 실패로 잡는다
      expect.soft(r.pills.sort(), `P0-7③: 코드 칩 집합 불일치 (칩=${JSON.stringify(r.pills)} / 내가 개설=${JSON.stringify(r.ownedCodes)})`)
        .toEqual(r.ownedCodes.sort());
      await page.close();
    } finally { await context.close(); }
  });

  test('P0-7④(과잉차단 금지): 교사(개설자)는 초대코드·위험영역·멤버관리가 그대로', async ({ browser }) => {
    const cid = await pickClass(browser, 'teacher', true);
    if (!cid) test.skip(true, 'teacher1 이 개설한 클래스 없음');
    const context = await browser.newContext({ storageState: stateFor('teacher'), locale: 'ko-KR', baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await page.goto(`/class/manage.html?id=${cid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => {
        const code = document.getElementById('codeDisplay');
        return {
          denied: !!document.getElementById('dcDeniedPanel'),
          code: code ? code.textContent.trim() : '',
          tabs: [...document.querySelectorAll('.tab-btn')].map((b) => b.textContent.trim()),
        };
      });
      expect.soft(r.denied, 'P0-7④: 개설자인데 권한 안내가 떴다(과잉 차단)').toBeFalsy();
      expect.soft(/^[A-Z0-9]{6,}$/.test(r.code), `P0-7④: 개설자 화면에서 초대코드가 사라졌다(code="${r.code}")`).toBeTruthy();
      expect.soft(r.tabs.some((t) => /위험 영역/.test(t)), 'P0-7④: 개설자 화면에서 위험 영역 탭이 사라졌다').toBeTruthy();
      expect.soft(r.tabs.some((t) => /멤버 관리/.test(t)), 'P0-7④: 개설자 화면에서 멤버 관리 탭이 사라졌다').toBeTruthy();
      await page.close();
    } finally { await context.close(); }
  });
});
