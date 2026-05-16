// /api/notifications — 사용자 알림 목록·읽음 처리
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const notifDb = require('../db/notifications');

// GET /api/notifications?unread=true&limit=20
router.get('/', requireAuth, (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true' || req.query.unread === '1';
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const items = notifDb.listNotifications(req.user.id, { unreadOnly, limit, offset });
    const unread_count = notifDb.countUnread(req.user.id);
    res.json({ success: true, items, unread_count });
  } catch (err) {
    console.error('[NOTIFICATIONS] list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const ok = notifDb.markRead(id, req.user.id);
    if (!ok) return res.status(404).json({ success: false, message: '알림을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[NOTIFICATIONS] read error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, (req, res) => {
  try {
    const changed = notifDb.markAllRead(req.user.id);
    res.json({ success: true, changed });
  } catch (err) {
    console.error('[NOTIFICATIONS] read-all error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
