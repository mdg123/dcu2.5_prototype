// test/e2e/smoke.global-setup.js
// ─────────────────────────────────────────────────────────────────────────────
// Playwright globalSetup. (config 의 globalSetup 으로 지정)
//   1) 실 DB → 임시 복사본 생성 (DB_PATH 로 webServer 에 주입됨).
//   2) 앱(webServer) 이 기동된 뒤, 역할별로 1회 로그인 → storageState(쿠키) 저장.
//      이후 모든 스모크 테스트는 storageState 를 재사용하여 빠르게 화면을 순회한다.
//
//   ★ 실행 순서 주의: Playwright 는 globalSetup 을 webServer 기동 "후"에 호출한다.
//      (config 에 webServer 가 있으면 globalSetup 전에 서버를 띄움)
//      DB 복사는 webServer 가 DB 를 열기 전에 끝나야 하므로, config 모듈 로드 시점
//      (require) 에 즉시 복사를 수행한다. 여기서는 storageState 생성만 담당.
// ─────────────────────────────────────────────────────────────────────────────
const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const STATE_DIR = path.join(__dirname, '.smoke-state');

const ACCOUNTS = [
  { role: 'student', username: 'student1', password: '1234' },
  { role: 'teacher', username: 'teacher1', password: '1234' },
  { role: 'admin',   username: 'admin',    password: '1234' },
];

async function loginAndSaveState(baseURL, account) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL, locale: 'ko-KR' });
  const page = await ctx.newPage();
  try {
    await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
    await page.fill('#loginId', account.username);
    await page.fill('#loginPw', account.password);
    await page.click('.submit-btn, button[type="submit"]');
    // 로그인 성공 검증: /api/auth/me 가 해당 role 을 반환할 때까지 대기
    await page.waitForFunction(async (expectedRole) => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok) return false;
        const d = await r.json();
        return d && d.user && d.user.role === expectedRole;
      } catch (_) { return false; }
    }, account.role, { timeout: 15000 });

    const statePath = path.join(STATE_DIR, `${account.role}.json`);
    await ctx.storageState({ path: statePath });
    return statePath;
  } finally {
    await browser.close();
  }
}

module.exports = async (config) => {
  const baseURL =
    (config.projects && config.projects[0] && config.projects[0].use && config.projects[0].use.baseURL) ||
    'http://localhost:3100';

  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  for (const acc of ACCOUNTS) {
    await loginAndSaveState(baseURL, acc);
  }
};
