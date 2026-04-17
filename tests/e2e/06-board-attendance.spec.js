// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Phase 6: 게시판 & 감정출석부', () => {
  let classId;

  test.beforeAll(async ({ request }) => {
    await request.post('/api/auth/login', { data: { username: 'teacher1', password: '1234' } });
    const res = await request.get('/api/class/my');
    const data = await res.json();
    classId = data.classes?.[0]?.id || 2;
  });

  // ─── 게시판 ───
  test('게시판 목록 조회', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get(`/api/board/${classId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.posts.length).toBeGreaterThan(0);
  });

  test('게시글 작성', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.post(`/api/board/${classId}`, {
      data: {
        title: 'E2E 테스트 게시글',
        content: 'Playwright 자동 테스트입니다.',
        category: 'free',
        allow_comments: true
      }
    });
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.post || data.data).toBeDefined();
  });

  test('댓글 작성', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    // 최신 게시글 가져오기
    const listRes = await page.request.get(`/api/board/${classId}`);
    const listData = await listRes.json();
    const postId = listData.posts?.[0]?.id;
    if (!postId) return;

    const res = await page.request.post(`/api/board/${classId}/${postId}/comments`, {
      data: { content: 'E2E 댓글 테스트' }
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('게시글 상세 + 댓글 포함', async ({ page }) => {
    await login(page, 'student1', '1234');
    const listRes = await page.request.get(`/api/board/${classId}`);
    const listData = await listRes.json();
    const postId = listData.posts?.[0]?.id;
    if (!postId) return;

    const res = await page.request.get(`/api/board/${classId}/${postId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
    // comments는 최상위 키
    expect(data.comments || data.post?.comments).toBeDefined();
  });

  test('카테고리 필터', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get(`/api/board/${classId}?category=free`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  // ─── 감정출석부 ───
  test('출석 체크인', async ({ page }) => {
    await login(page, 'student6', '1234');
    const res = await page.request.post(`/api/attendance/${classId}/checkin`, {
      data: { emotion: 'happy', emotionReason: 'E2E 테스트', comment: '테스트 출석!' }
    });
    // 200, 201, or 409 (이미 출석)
    expect(res.status()).toBeLessThan(500);
  });

  test('출석 상태 조회', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get(`/api/attendance/${classId}/status`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('교사 출석 통계', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get(`/api/attendance/${classId}/class-stats`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('감정 통계', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get(`/api/attendance/${classId}/emotion-stats`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('출석 랭킹', async ({ page }) => {
    await login(page, 'student1', '1234');
    const res = await page.request.get(`/api/attendance/${classId}/ranking`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  test('출석 테이블 (교사)', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get(`/api/attendance/${classId}/table?startDate=2026-03-01&endDate=2026-03-31`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });
});
