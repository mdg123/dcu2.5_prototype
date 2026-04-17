// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Phase 7: 성장기록 & LRS', () => {
  let classId;

  test.beforeAll(async ({ request }) => {
    await request.post('/api/auth/login', { data: { username: 'teacher1', password: '1234' } });
    const res = await request.get('/api/class/my');
    classId = (await res.json()).classes?.[0]?.id || 2;
  });

  // ─── 성장기록 ───
  test('포트폴리오 등록', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.post('/api/growth/portfolios', {
      data: { classId, type: 'journal', title: 'E2E 학습일지', content: '자동 테스트 일지', tags: 'e2e,테스트' }
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('포트폴리오 목록', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get(`/api/growth/portfolios?classId=${classId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('독서기록 등록', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.post('/api/growth/reading', {
      data: { bookTitle: 'E2E 테스트 책', author: '테스터', rating: 4, review: '좋은 책!' }
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('성장 요약', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get('/api/growth/summary');
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('나도예술가 갤러리', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get('/api/growth/gallery');
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('교사 관찰기록', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const meRes = await page.request.get('/api/auth/me');
    const meData = await meRes.json();
    // student1 ID 조회
    await login(page, 'student1', '1234');
    const stRes = await page.request.get('/api/auth/me');
    const stData = await stRes.json();
    const studentId = stData.user?.id;
    if (!studentId) return;

    await login(page, 'teacher1', '1234');
    const res = await page.request.post('/api/growth/report/observation', {
      data: { studentId, classId, text: 'E2E 관찰기록', tags: ['테스트'] }
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ─── LRS ───
  test('LRS 리빌드', async ({ page }) => {
    await login(page, 'admin', '0000');
    const res = await page.request.post('/api/lrs/rebuild-aggregates');
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('LRS 일별 추이', async ({ page }) => {
    await login(page, 'admin', '0000');
    const res = await page.request.get('/api/lrs/stats/daily?days=30');
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('LRS 서비스별', async ({ page }) => {
    await login(page, 'admin', '0000');
    const res = await page.request.get('/api/lrs/stats/by-service');
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('LRS 학생 로그', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get('/api/lrs/logs');
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  // ─── 관리자 ───
  test('관리자 통계', async ({ page }) => {
    await login(page, 'admin', '0000');
    const res = await page.request.get('/api/admin/stats');
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.stats.totalUsers).toBeGreaterThanOrEqual(10);
  });

  test('교육과정 검색', async ({ page }) => {
    await login(page, 'admin', '0000');
    const res = await page.request.get('/api/curriculum/standards?search=' + encodeURIComponent('분수'));
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.data.length).toBeGreaterThan(0);
  });
});
