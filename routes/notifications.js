// /api/notifications — 사용자 알림 목록·읽음 처리
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const notifDb = require('../db/notifications');

// ─────────────────────────────────────────────────────────────────────────────
// 레거시 알림 링크 구제기 (2026-08-05 P0-4)
//   과거 알림 생성 코드가 **존재하지 않는 파일명·파라미터**를 저장했다.
//   이미 DB 에 쌓인 알림(191건)은 코드를 고쳐도 계속 404 이므로,
//   목록을 내보낼 때 읽기 시점에 정규화한다. (DB 무변형 — 마이그레이션과 독립)
//
//   원본 링크                       → 실제 화면
//   /class/class-notice.html        → /class/notice-board.html   (noticeId 그대로)
//   /class/notice.html              → /class/notice-board.html
//   /class/class-evaluation.html    → /class/exam-view.html      (examId → id)
//   /class/class-homework.html      → /class/homework-view.html  (homeworkId → id)
//
//   ★ 멱등: 이미 올바른 링크는 그대로 통과한다. (test/notification-link-integrity)
// ─────────────────────────────────────────────────────────────────────────────
const LEGACY_LINK_RULES = [
  { from: '/class/class-notice.html',     to: '/class/notice-board.html',   rename: {} },
  { from: '/class/notice.html',           to: '/class/notice-board.html',   rename: {} },
  { from: '/class/class-evaluation.html', to: '/class/exam-view.html',      rename: { examId: 'id' } },
  { from: '/class/class-homework.html',   to: '/class/homework-view.html',  rename: { homeworkId: 'id' } },
];

function normalizeNotifLink(link) {
  if (!link || typeof link !== 'string' || !link.startsWith('/')) return link;
  const qIdx = link.indexOf('?');
  const urlPath = qIdx === -1 ? link : link.slice(0, qIdx);
  const rule = LEGACY_LINK_RULES.find(r => r.from === urlPath);
  if (!rule) return link;                       // 이미 올바른 링크 — 무변경(멱등)
  if (qIdx === -1) return rule.to;
  const qs = link.slice(qIdx + 1)
    .split('&')
    .filter(Boolean)
    .map(kv => {
      const eq = kv.indexOf('=');
      const k = eq === -1 ? kv : kv.slice(0, eq);
      const v = eq === -1 ? '' : kv.slice(eq + 1);
      const nk = rule.rename[k] || k;
      return eq === -1 ? nk : `${nk}=${v}`;
    })
    .join('&');
  return qs ? `${rule.to}?${qs}` : rule.to;
}

// GET /api/notifications?unread=true&limit=20
router.get('/', requireAuth, (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true' || req.query.unread === '1';
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const items = notifDb.listNotifications(req.user.id, { unreadOnly, limit, offset });
    // 레거시 죽은 링크(404) 읽기 시점 구제 — DB 는 건드리지 않는다
    for (const n of items) n.link = normalizeNotifLink(n.link);
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

// 하네스·마이그레이션 스크립트가 같은 규칙을 재사용하도록 노출
router.normalizeNotifLink = normalizeNotifLink;
router.LEGACY_LINK_RULES = LEGACY_LINK_RULES;

module.exports = router;
