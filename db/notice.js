const db = require('./index');

function createNotice(classId, authorId, data) {
  const info = db.prepare(`
    INSERT INTO notices (class_id, author_id, title, content, is_pinned, theme)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(classId, authorId, data.title, data.content || null, data.is_pinned ? 1 : 0, data.theme || 'classic');
  return getNoticeById(info.lastInsertRowid);
}

function getNoticeById(id) {
  return db.prepare(`
    SELECT n.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM notice_reads WHERE notice_id = n.id) as read_count
    FROM notices n JOIN users u ON n.author_id = u.id WHERE n.id = ?
  `).get(id) || null;
}

function getNoticesByClass(classId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM notices WHERE class_id = ?').get(classId).cnt;
  const notices = db.prepare(`
    SELECT n.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM notice_reads WHERE notice_id = n.id) as read_count
    FROM notices n JOIN users u ON n.author_id = u.id
    WHERE n.class_id = ?
    ORDER BY n.is_pinned DESC, n.created_at DESC LIMIT ? OFFSET ?
  `).all(classId, limit, (page - 1) * limit);
  return { notices, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateNotice(id, data) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(data)) {
    if (['title', 'content', 'is_pinned', 'theme'].includes(k)) { fields.push(`${k} = ?`); params.push(v); }
  }
  if (!fields.length) return getNoticeById(id);
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.prepare(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getNoticeById(id);
}

function deleteNotice(id) { db.prepare('DELETE FROM notices WHERE id = ?').run(id); }

function markRead(noticeId, userId) {
  try { db.prepare('INSERT INTO notice_reads (notice_id, user_id) VALUES (?, ?)').run(noticeId, userId); } catch {}
}

function isRead(noticeId, userId) {
  return !!db.prepare('SELECT id FROM notice_reads WHERE notice_id = ? AND user_id = ?').get(noticeId, userId);
}

module.exports = { createNotice, getNoticeById, getNoticesByClass, updateNotice, deleteNotice, markRead, isRead };
