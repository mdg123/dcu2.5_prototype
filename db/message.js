const db = require('./index');

function createRoom(classId, type, name, memberIds) {
  const info = db.prepare(
    'INSERT INTO message_rooms (class_id, name, type) VALUES (?, ?, ?)'
  ).run(classId || null, name || null, type || 'direct');
  const roomId = info.lastInsertRowid;
  const insert = db.prepare('INSERT INTO message_room_members (room_id, user_id) VALUES (?, ?)');
  for (const uid of memberIds) insert.run(roomId, uid);
  return getRoomById(roomId);
}

function getRoomById(id) {
  return db.prepare('SELECT * FROM message_rooms WHERE id = ?').get(id) || null;
}

function getUserRooms(userId) {
  return db.prepare(`
    SELECT mr.*,
      (SELECT content FROM messages WHERE room_id = mr.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages WHERE room_id = mr.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM messages WHERE room_id = mr.id AND is_read = 0 AND sender_id != ?) as unread_count
    FROM message_rooms mr
    JOIN message_room_members mrm ON mr.id = mrm.room_id
    WHERE mrm.user_id = ?
    ORDER BY last_message_at DESC
  `).all(userId, userId);
}

function getRoomMembers(roomId) {
  return db.prepare(`
    SELECT u.id, u.display_name, u.username, u.role
    FROM message_room_members mrm JOIN users u ON mrm.user_id = u.id
    WHERE mrm.room_id = ?
  `).all(roomId);
}

function sendMessage(roomId, senderId, content) {
  const info = db.prepare(
    'INSERT INTO messages (room_id, sender_id, content) VALUES (?, ?, ?)'
  ).run(roomId, senderId, content);
  return db.prepare(`
    SELECT m.*, u.display_name as sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?
  `).get(info.lastInsertRowid);
}

function getMessages(roomId, { page = 1, limit = 50 } = {}) {
  return db.prepare(`
    SELECT m.*, u.display_name as sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `).all(roomId, limit, (page - 1) * limit).reverse();
}

function markAsRead(roomId, userId) {
  db.prepare(
    'UPDATE messages SET is_read = 1 WHERE room_id = ? AND sender_id != ? AND is_read = 0'
  ).run(roomId, userId);
}

function isRoomMember(roomId, userId) {
  return !!db.prepare('SELECT id FROM message_room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
}

function findDirectRoom(userId1, userId2) {
  return db.prepare(`
    SELECT mr.id FROM message_rooms mr
    WHERE mr.type = 'direct'
    AND (SELECT COUNT(*) FROM message_room_members WHERE room_id = mr.id) = 2
    AND EXISTS (SELECT 1 FROM message_room_members WHERE room_id = mr.id AND user_id = ?)
    AND EXISTS (SELECT 1 FROM message_room_members WHERE room_id = mr.id AND user_id = ?)
  `).get(userId1, userId2);
}

function deleteMessage(messageId, userId) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!msg) return false;
  if (msg.sender_id !== userId) return false;
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  return true;
}

function getUnreadCount(userId) {
  const result = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages m
    JOIN message_room_members mrm ON m.room_id = mrm.room_id
    WHERE mrm.user_id = ? AND m.sender_id != ? AND m.is_read = 0
  `).get(userId, userId);
  return result.cnt;
}

module.exports = {
  createRoom, getRoomById, getUserRooms, getRoomMembers,
  sendMessage, getMessages, markAsRead, isRoomMember, findDirectRoom,
  deleteMessage, getUnreadCount
};
