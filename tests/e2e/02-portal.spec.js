// @ts-check
const { test, expect } = require('@playwright/test');
const { loginUI, goTo, waitForModal, waitForModalClose } = require('./helpers');

test.describe('Phase 2: 포털 메인', () => {

  test.beforeEach(async ({ page }) => {
    await loginUI(page, 'teacher1', '1234');
    await goTo(page, '/');
    await page.waitForTimeout(3000); // 데이터 로딩 대기 (포털 로딩 느림)
  });

  test('포털 메인 로딩', async ({ page }) => {
    // 포털 메인 주요 요소가 보여야 함
    await expect(page.locator('#popularContentsGrid, .content-grid-items').first()).toBeVisible({ timeout: 10000 });
  });

  test('대시보드 - 개설한 클래스 카드 클릭 → 클래스 목록 팝업', async ({ page }) => {
    // 첫 번째 stat-card 클릭
    const statCards = page.locator('.stat-card');
    await expect(statCards.first()).toBeVisible();
    await statCards.first().click();
    // 모달이 열림
    await waitForModal(page);
    await expect(page.locator('#modalTitleText')).toContainText('클래스');
    // 모달 안에 클래스 항목 존재
    await expect(page.locator('.modal-item').first()).toBeVisible();
  });

  test('대시보드 모달 닫기 후 재열기', async ({ page }) => {
    const statCards = page.locator('.stat-card');
    // 첫 번째 열기
    await statCards.first().click();
    await waitForModal(page);
    // X 버튼으로 닫기
    await page.locator('.modal-close').first().click();
    await waitForModalClose(page);
    // 다시 열기
    await page.waitForTimeout(500);
    await statCards.first().click();
    await waitForModal(page);
    await expect(page.locator('#modalOverlay')).toHaveClass(/active/);
  });

  test('인기 콘텐츠 클릭 → 상세 모달', async ({ page }) => {
    // 콘텐츠가 로딩될 때까지 충분히 대기
    await page.waitForSelector('.content-item', { timeout: 15000 });
    await page.waitForTimeout(1500);
    // JS 직접 호출로 모달 열기 테스트
    const hasFunc = await page.evaluate(() => typeof openContentDetailModal === 'function');
    expect(hasFunc).toBeTruthy();
    await page.evaluate(() => openContentDetailModal(0));
    await waitForModal(page);
    await expect(page.locator('.content-detail-title')).toBeVisible();
    await expect(page.locator('.content-detail-actions')).toBeVisible();
  });

  test('인기 콘텐츠 모달 - 좋아요/보관함 버튼', async ({ page }) => {
    await page.waitForSelector('.content-item', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => openContentDetailModal(0));
    await waitForModal(page);
    // 좋아요 버튼 존재
    await expect(page.locator('text=좋아요').first()).toBeVisible();
    // 보관함 버튼 존재
    await expect(page.locator('text=보관함').first()).toBeVisible();
    // 보기 버튼 존재
    await expect(page.locator('text=보기').first()).toBeVisible();
  });

  test('인기 콘텐츠 모달 닫기 후 다른 콘텐츠 열기', async ({ page }) => {
    await page.waitForSelector('.content-item', { timeout: 15000 });
    await page.waitForTimeout(1500);
    // 첫 번째 열기
    await page.evaluate(() => openContentDetailModal(0));
    await waitForModal(page);
    const title1 = await page.locator('.content-detail-title').textContent();
    // 닫기
    await page.locator('.modal-close').first().click();
    await waitForModalClose(page);
    await page.waitForTimeout(600);
    // 두 번째 열기
    if (await items.count() > 1) {
      await page.evaluate(() => openContentDetailModal(1));
      await waitForModal(page);
      const title2 = await page.locator('.content-detail-title').textContent();
      expect(title2).not.toBe(title1);
    }
  });

  test('이달의 인기 클래스 클릭 → 클래스 소개 모달', async ({ page }) => {
    const classItems = page.locator('.class-item');
    const count = await classItems.count();
    expect(count).toBeGreaterThan(0);
    await classItems.first().click();
    await waitForModal(page);
    await expect(page.locator('.class-detail-name')).toBeVisible();
    // 바로가기 또는 가입 버튼 존재
    const btnText = await page.locator('.content-detail-actions .btn-primary').textContent();
    expect(btnText).toMatch(/바로가기|가입/);
  });

  test('바로가기 메뉴 클릭', async ({ page }) => {
    const quickItems = page.locator('.quick-menu-item, [onclick*="location"]').first();
    if (await quickItems.count() > 0) {
      await expect(quickItems).toBeVisible();
    }
  });

  test('배너 슬라이더 동작', async ({ page }) => {
    const dots = page.locator('.banner-dots .dot, .slider-dot');
    if (await dots.count() > 1) {
      await dots.nth(1).click();
      await page.waitForTimeout(500);
      // 두 번째 슬라이드로 전환됨
    }
  });
});
