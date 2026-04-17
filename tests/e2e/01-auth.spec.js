// @ts-check
const { test, expect } = require('@playwright/test');
const { login, loginUI, goTo } = require('./helpers');

test.describe('Phase 1: 인증', () => {

  test('로그인 페이지 표시', async ({ page }) => {
    await goTo(page, '/login.html');
    await expect(page.locator('input[name="username"], #username, input[type="text"]').first()).toBeVisible();
  });

  test('교사 로그인 성공', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, '/');
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toContain('김선생');
  });

  test('학생 로그인 성공', async ({ page }) => {
    await loginUI(page, 'student1', '1234');
    await goTo(page, '/');
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body.length).toBeGreaterThan(100);
  });

  test('잘못된 비밀번호 로그인 실패', async ({ page }) => {
    const res = await page.request.post('/api/auth/login', {
      data: { username: 'teacher1', password: '9999' }
    });
    const data = await res.json();
    expect(data.success).toBeFalsy();
  });

  test('admin 로그인', async ({ page }) => {
    await loginUI(page, 'admin', '0000');
    // 페이지 컨텍스트에서 me 확인
    const data = await page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return await res.json();
    });
    expect(data.user.role).toBe('admin');
  });
});
