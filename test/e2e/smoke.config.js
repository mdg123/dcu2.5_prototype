// @ts-check
// test/e2e/smoke.config.js
// ─────────────────────────────────────────────────────────────────────────────
// 화면 깨짐 자동 검출 스모크 전용 Playwright 설정.
//   - testDir: test/e2e (이 파일과 같은 폴더의 *.smoke.spec.js)
//   - 별도 포트 3100 (기존 프리뷰 서버 3000 과 충돌 회피)
//   - webServer 로 앱 자동 기동, DB_PATH 는 실 DB 의 임시 복사본 → 실 DB 무오염
//   - 역할별 storageState 3개를 globalSetup 에서 1회 생성하여 재사용
//
//   실행: npx playwright test --config=test/e2e/smoke.config.js
//   (package.json: "test:e2e:smoke" 로도 연결)
// ─────────────────────────────────────────────────────────────────────────────
const { defineConfig } = require('@playwright/test');
const path = require('path');

// ★ config 로드(require) 시점에 실 DB → 임시 복사본 생성.
//   Playwright 는 webServer 를 globalSetup 보다 먼저 띄우므로, 서버가 DB 를 열기
//   전에 복사가 끝나 있어야 한다. config 로드 시점이 가장 이른 안전 지점.
const { SMOKE_DB_PATH, SMOKE_UPLOAD_DIR, makeSmokeDb } = require('./smoke.db-copy');
makeSmokeDb(); // VACUUM INTO 동기 복사

// 기본 3100. 동시 작업으로 포트가 이미 점유된 경우 SMOKE_PORT 로 비켜 간다(평시 불변).
const PORT = parseInt(process.env.SMOKE_PORT || '3100', 10);
const BASE_URL = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /smoke\.spec\.js$/,
  timeout: 45000,
  expect: { timeout: 10000 },
  retries: 0,
  workers: 1, // 단일 워커: 동일 DB 복사본/서버 공유, flaky 최소화
  reporter: [['list']],
  globalSetup: require.resolve('./smoke.global-setup.js'),
  globalTeardown: require.resolve('./smoke.global-teardown.js'),
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    locale: 'ko-KR',
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  projects: [
    { name: 'chromium-smoke', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: 'node server.js',
    port: PORT,
    reuseExistingServer: false, // 항상 격리 DB 로 새 서버 기동
    timeout: 30000,
    env: {
      PORT: String(PORT),
      DB_PATH: SMOKE_DB_PATH,
      // [W4] PDF 산출물도 격리 — 스모크 서버가 정본 uploads/portfolio-reports 를 오염시키지 않도록
      PORTFOLIO_REPORT_DIR: SMOKE_UPLOAD_DIR,
      NODE_ENV: 'test',
    },
    // server.js 의 cwd 는 루트여야 함(정적 파일/상대경로). config 가 test/e2e 에 있어도
    // Playwright 의 webServer.cwd 기본값은 config 파일 폴더가 아닌 process.cwd()(루트).
    cwd: path.join(__dirname, '..', '..'),
  },
});
