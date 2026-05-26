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

// 클래스 멤버 일괄 알림 — 과제/평가/알림장 발행 시 사용
// excludeUserId: 작성자(교사) 본인은 제외
// memberRoles: 기본 ['member'] — class_members.role CHECK = ('owner', 'member')
//              교사 owner 포함하려면 ['member','owner'] 전달
function notifyClassMembers(classId, { type, title, message = null, link = null, excludeUserId = null, memberRoles = ['member'] } = {}) {
  if (!classId || !type || !title) return 0;
  const placeholders = memberRoles.map(() => '?').join(',');
  const members = db.prepare(
    `SELECT user_id FROM class_members
     WHERE class_id = ? AND status = 'active' AND role IN (${placeholders})`
  ).all(classId, ...memberRoles);

  const ins = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (?, ?, ?, ?, ?)
  `);
  const titleStr = String(title).slice(0, 200);
  const msgStr = message != null ? String(message).slice(0, 1000) : null;
  const linkStr = link != null ? String(link).slice(0, 500) : null;

  let count = 0;
  const tx = db.transaction(() => {
    for (const m of members) {
      if (excludeUserId && m.user_id === excludeUserId) continue;
      ins.run(m.user_id, String(type), titleStr, msgStr, linkStr);
      count++;
    }
  });
  try {
    tx();
  } catch (err) {
    console.error('[NOTIF] notifyClassMembers tx error:', err);
  }
  return count;
}

module.exports = {
  createNotification,
  notifyClassMembers,
  listNotifications,
  countUnread,
  markRead,
  markAllRead
};
