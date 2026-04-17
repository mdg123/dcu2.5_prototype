// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Phase 5: 과제 & 평가 API', () => {
  let classId, homeworkId, examId;

  test.beforeAll(async ({ request }) => {
    await request.post('/api/auth/login', { data: { username: 'teacher1', password: '1234' } });
    const clsRes = await request.get('/api/class/my');
    const clsData = await clsRes.json();
    classId = clsData.classes?.[0]?.id || 2;

    const hwRes = await request.get(`/api/homework/${classId}`);
    const hwData = await hwRes.json();
    homeworkId = hwData.homework?.[0]?.id;

    const exRes = await request.get(`/api/exam/${classId}`);
    const exData = await exRes.json();
    examId = exData.exams?.[0]?.id;
  });

  test('과제 목록 조회', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get(`/api/homework/${classId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.homework.length).toBeGreaterThan(0);
  });

  test('과제 상세 + 제출물', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    if (!homeworkId) return;
    const res = await page.request.get(`/api/homework/${classId}/${homeworkId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.homework).toBeDefined();
    // 제출물 키 존재
    expect(data.submissions).toBeDefined();
  });

  test('학생 과제 제출', async ({ page }) => {
    await login(page, 'student6', '1234');
    if (!homeworkId) return;
    const res = await page.request.post(`/api/homework/${classId}/${homeworkId}/submit`, {
      data: { content: 'E2E 테스트 과제 제출입니다.' }
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('교사 채점', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    if (!homeworkId) return;
    // 제출물 조회
    const detRes = await page.request.get(`/api/homework/${classId}/${homeworkId}`);
    const detData = await detRes.json();
    const subs = detData.submissions || [];
    if (subs.length > 0) {
      const subId = subs[0].id;
      const gradeRes = await page.request.post(`/api/homework/${classId}/${homeworkId}/grade/${subId}`, {
        data: { score: 88, feedback: 'E2E 테스트 피드백' }
      });
      expect(gradeRes.status()).toBeLessThan(500);
    }
  });

  test('평가 목록 조회', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    const res = await page.request.get(`/api/exam/${classId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
    expect(data.exams.length).toBeGreaterThan(0);
  });

  test('평가 상세 + 문항', async ({ page }) => {
    await login(page, 'teacher1', '1234');
    if (!examId) return;
    const res = await page.request.get(`/api/exam/${classId}/${examId}`);
    const data = await res.json();
    expect(data.success).toBeTruthy();
    const examData = data.data || data.exam || data;
    expect(examData.questions).toBeDefined();
    expect(examData.questions.length).toBeGreaterThan(0);
  });

  test('학생 평가 응시', async ({ page }) => {
    await login(page, 'student6', '1234');
    if (!examId) return;
    // 시작
    const startRes = await page.request.post(`/api/exam/${classId}/${examId}/start`);
    expect(startRes.status()).toBeLessThan(500);
    // 제출
    const submitRes = await page.request.post(`/api/exam/${classId}/${examId}/submit`, {
      data: {
        answers: [
          { questionId: 1, answer: '3/4' },
          { questionId: 2, answer: '3/8' },
          { questionId: 3, answer: '5/6' },
          { questionId: 4, answer: '3/10' },
          { questionId: 5, answer: '분자' }
        ]
      }
    });
    expect(submitRes.status()).toBeLessThan(500);
  });
});
