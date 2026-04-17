// @ts-check
const { test, expect } = require('@playwright/test');
const { login, goTo } = require('./helpers');

test.describe('Phase 4: 채움콘텐츠', () => {

  test('콘텐츠 목록 페이지 로딩', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    await goTo(page, '/content/index.html');
    await page.waitForTimeout(1500);
    const body = await page.textContent('body');
    expect(body.length).toBeGreaterThan(100);
  });

  test('콘텐츠 검색 API', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get('/api/contents?keyword=' + encodeURIComponent('분수'));
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('콘텐츠 유형 필터', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get('/api/contents?content_type=video');
    const data = await res.json();
    expect(data.success).toBeTruthy();
    if (data.data) {
      data.data.forEach(c => expect(c.content_type).toBe('video'));
    }
  });

  test('보관함 담기/조회', async ({ page }) => {
    await login(page, 'student1', '1234');
    // 담기
    const addRes = await page.request.post('/api/contents/collection/1', {
      data: { folder: '테스트 폴더' }
    });
    expect(addRes.status()).toBeLessThan(500);
    // 조회
    const listRes = await page.request.get('/api/contents/collection/list');
    const data = await listRes.json();
    expect(data.success).toBeTruthy();
  });

  test('콘텐츠 좋아요', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.post('/api/contents/1/like');
    expect(res.status()).toBeLessThan(500);
  });
});
