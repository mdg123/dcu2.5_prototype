// routes/portal.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const portalDb = require('../db/portal-extended');

// GET /hall-of-fame — 명예의 전당
router.get('/hall-of-fame', requireAuth, (req, res) => {
  try {
    const data = portalDb.getHallOfFame(req.query.month, req.query.period);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[PORTAL] hall-of-fame error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /calendar — 캘린더 이벤트
// Query params: startDate, endDate (직접 지정) 또는 month, year (월 단위 조회)
router.get('/calendar', requireAuth, (req, res) => {
  try {
    const { startDate, endDate, month, year } = req.query;
    const events = portalDb.getCalendarEvents(req.user.id, { startDate, endDate, month, year });
    res.json({ success: true, events });
  } catch (err) {
    console.error('[PORTAL] calendar error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /trending — 인기글/새글/설문
router.get('/trending', requireAuth, (req, res) => {
  try {
    const data = portalDb.getTrendingPosts(req.user.id, req.query);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[PORTAL] trending error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /recent-activities — 최근 활동 목록
router.get('/recent-activities', requireAuth, (req, res) => {
  try {
    const activities = portalDb.getRecentActivities(req.user.id, { limit: parseInt(req.query.limit) || 20 });
    res.json({ success: true, activities });
  } catch (err) {
    console.error('[PORTAL] recent-activities error:', err);
    res.status(500).json({ success: false, activities: [] });
  }
});

// GET /my-summary — 내 대시보드 요약
router.get('/my-summary', requireAuth, (req, res) => {
  try {
    const summary = portalDb.getMyDashboardSummary(req.user.id);
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error('[PORTAL] my-summary error:', err);
    res.status(500).json({ success: false, classCount: 0, pendingHomework: 0, unreadNotifications: 0, dailyLearning: { total: 0, completed: 0 }, totalPoints: 0 });
  }
});

module.exports = router;
