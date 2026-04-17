/**
 * E2E 테스트 공통 헬퍼
 */

/** API 테스트용 로그인 (page.request 쿠키 설정) */
async function login(page, username, password = '1234') {
  // page.request로 로그인하면 API 호출용 쿠키가 설정됨
  const res = await page.request.post('/api/auth/login', {
    data: { username, password }
  });
  const data = await res.json();
  if (!data.success) throw new Error(`로그인 실패: ${username}`);
  return data;
}

/** UI 테스트용 로그인 (실제 로그인 폼 통해 세션 쿠키 설정) */
async function loginUI(page, username, password = '1234') {
  await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  await page.fill('#loginId', username);
  await page.fill('#loginPw', password);
  await page.click('.submit-btn, button[type="submit"]');
  // 로그인 성공 후 리다이렉트 대기
  await page.waitForURL('**/', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** 특정 페이지로 이동하고 로딩 완료 대기 */
async function goTo(page, path) {
  await page.goto(path, { waitUntil: 'networkidle' });
}

/** 모달이 열릴 때까지 대기 */
async function waitForModal(page, selector = '#modalOverlay') {
  await page.waitForSelector(`${selector}.active`, { timeout: 5000 });
}

/** 모달이 닫힐 때까지 대기 */
async function waitForModalClose(page, selector = '#modalOverlay') {
  await page.waitForSelector(`${selector}:not(.active)`, { timeout: 5000 });
}

/** 토스트 메시지 확인 */
async function waitForToast(page) {
  const toast = page.locator('#toast.show, .toast.show');
  await toast.waitFor({ timeout: 5000 });
  return await toast.textContent();
}

module.exports = { login, loginUI, goTo, waitForModal, waitForModalClose, waitForToast };
