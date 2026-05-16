// 알림 CRUD — notifications 테이블 (schema.js 31~43)
// type: 'gallery_approved', 'gallery_rejected', 'gallery_takedown', 'gallery_report_dismissed' 등 free-form
const db = require('./index');

function createNotification({ userId, type, title, message = null, link = null }) {
  if (!userId || !type || !title) return null;
  const info = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, String(type), String(title).slice(0, 200),
         message != null ? String(message).slice(0, 1000) : null,
         link != null ? String(link).slice(0, 500) : null);
  return info.lastInsertRowid;
}

function listNotifications(userId, { unreadOnly = false, limit = 20, offset = 0 } = {}) {
  let where = ' WHERE user_id = ?';
  const params = [userId];
  if (unreadOnly) { where += ' AND is_read = 0'; }
  const items = db.prepare(`
    SELECT id, user_id, type, title, message, link, is_read, created_at
    FROM notifications
    ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  // boolean 변환
  for (const n of items) n.is_read = !!n.is_read;
  return items;
}

function countUnread(userId) {
  const r = db.prepare('SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0').get(userId);
  return r ? r.cnt : 0;
}

function markRead(notificationId, userId) {
  const info = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notificationId, userId);
  return info.changes > 0;
}

function markAllRead(userId) {
  const info = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
  return info.changes;
}

module.exports = {
  createNotification,
  listNotifications,
  countUnread,
  markRead,
  markAllRead
};
