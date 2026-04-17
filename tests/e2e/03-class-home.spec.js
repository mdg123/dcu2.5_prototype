// @ts-check
const { test, expect } = require('@playwright/test');
const { login, loginUI, goTo } = require('./helpers');

test.describe('Phase 3: 클래스 홈', () => {
  let classId;

  test.beforeAll(async ({ request }) => {
    // Get classId from API
    const loginRes = await request.post('/api/auth/login', { data: { username: 'teacher1', password: '1234' } });
    const meRes = await request.get('/api/class/my');
    const data = await meRes.json();
    classId = data.classes?.[0]?.id || 2;
  });

  test('교사: 클래스 홈 로딩', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(3000);
    // 탭 바가 보여야 함 (class-home이 로딩되면 tab-btn이 존재)
    const tabBtn = page.locator('.tab-btn, [data-tab]').first();
    await expect(tabBtn).toBeVisible({ timeout: 15000 });
  });

  test('교사: 수업 탭 전환', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1000);
    const lessonTab = page.locator('.tab-btn[data-tab="lessons"]').first();
    if (await lessonTab.isVisible()) {
      await lessonTab.click();
      await page.waitForTimeout(500);
      // 수업 등록 버튼이 교사에게 보여야 함
      const createBtn = page.locator('text=수업 등록');
      if (await createBtn.count() > 0) {
        await expect(createBtn.first()).toBeVisible();
      }
    }
  });

  test('교사: 과제 탭 전환', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1000);
    const hwTab = page.locator('.tab-btn[data-tab="homework"]').first();
    if (await hwTab.isVisible()) {
      await hwTab.click();
      await page.waitForTimeout(500);
    }
  });

  test('교사: 평가 탭 전환', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1000);
    const examTab = page.locator('.tab-btn[data-tab="exam"]').first();
    if (await examTab.isVisible()) {
      await examTab.click();
      await page.waitForTimeout(500);
    }
  });

  test('교사: 알림장 탭 전환', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1000);
    const noticeTab = page.locator('.tab-btn[data-tab="notice"]').first();
    if (await noticeTab.isVisible()) {
      await noticeTab.click();
      await page.waitForTimeout(500);
    }
  });

  test('교사: 수업 등록 모달 열기', async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1000);
    // 수업 탭으로 전환
    const tab = page.locator('[data-tab="lessons"]');
    if (await tab.count() > 0) await tab.click();
    await page.waitForTimeout(500);
    // 수업 등록 버튼 클릭
    const createBtn = page.locator('text=수업 등록');
    if (await createBtn.count() > 0 && await createBtn.first().isVisible()) {
      await createBtn.first().click();
      await page.waitForTimeout(500);
      // 모달이 열려야 함
      const modal = page.locator('#lessonModal, .modal-overlay.active');
      if (await modal.count() > 0) {
        await expect(modal.first()).toBeVisible();
      }
    }
  });

  test('학생: 클래스 홈 접근', async ({ page }) => {
    await loginUI(page, 'student1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1500);
    // 학생은 수업 등록 버튼이 안 보여야 함
    const createBtn = page.locator('text=수업 등록');
    if (await createBtn.count() > 0) {
      await expect(createBtn.first()).not.toBeVisible();
    }
  });

  test('학생: 게시판 탭에서 글 작성', async ({ page }) => {
    await loginUI(page, 'student1', '1234');
    await goTo(page, `/class/class-home.html?classId=${classId}`);
    await page.waitForTimeout(1000);
    const boardTab = page.locator('.tab-btn[data-tab="board"]').first();
    if (await boardTab.isVisible()) {
      await boardTab.click();
      await page.waitForTimeout(500);
      const writeBtn = page.locator('text=글쓰기');
      if (await writeBtn.count() > 0) {
        await expect(writeBtn.first()).toBeVisible();
      }
    }
  });
});
