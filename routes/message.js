const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const messageDb = require('../db/message');

// GET /api/message/rooms - 내 채팅방 목록
router.get('/rooms', requireAuth, (req, res) => {
  try {
    const rooms = messageDb.getUserRooms(req.user.id);
    // 각 방의 멤버 정보
    const enriched = rooms.map(r => {
      const members = messageDb.getRoomMembers(r.id);
      return { ...r, members };
    });
    res.json({ success: true, rooms: enriched });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// POST /api/message/rooms - 채팅방 생성
router.post('/rooms', requireAuth, (req, res) => {
  try {
    const { classId, targetUserId, name, type } = req.body;
    const memberIds = [req.user.id];
    if (targetUserId) {
      // 1:1 대화 - 기존 방 확인
      const existing = messageDb.findDirectRoom(req.user.id, targetUserId);
      if (existing) return res.json({ success: true, room: messageDb.getRoomById(existing.id), existed: true });
      memberIds.push(targetUserId);
    }
    const room = messageDb.createRoom(classId || null, type || 'direct', name || null, memberIds);
    res.status(201).json({ success: true, room });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// GET /api/message/rooms/:roomId/messages - 메시지 목록
router.get('/rooms/:roomId/messages', requireAuth, (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId);
    if (!messageDb.isRoomMember(roomId, req.user.id)) {
      return res.status(403).json({ success: false, message: '채팅방 멤버가 아닙니다.' });
    }
    messageDb.markAsRead(roomId, req.user.id);
    const messages = messageDb.getMessages(roomId, { page: parseInt(req.query.page) || 1 });
    res.json({ success: true, messages });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// POST /api/message/rooms/:roomId/messages - 메시지 전송
router.post('/rooms/:roomId/messages', requireAuth, (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId);
    if (!messageDb.isRoomMember(roomId, req.user.id)) {
      return res.status(403).json({ success: false, message: '채팅방 멤버가 아닙니다.' });
    }
    if (!req.body.content) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    const message = messageDb.sendMessage(roomId, req.user.id, req.body.content);
    res.status(201).json({ success: true, message });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// DELETE /api/message/rooms/:roomId/messages/:messageId - 메시지 삭제
router.delete('/rooms/:roomId/messages/:messageId', requireAuth, (req, res) => {
  try {
    const roomId = parseInt(req.params.roomId);
    if (!messageDb.isRoomMember(roomId, req.user.id)) {
      return res.status(403).json({ success: false, message: '채팅방 멤버가 아닙니다.' });
    }
    const deleted = messageDb.deleteMessage(parseInt(req.params.messageId), req.user.id);
    if (!deleted) return res.status(403).json({ success: false, message: '본인이 보낸 메시지만 삭제할 수 있습니다.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// GET /api/message/unread-count - 안 읽은 쪽지 수
router.get('/unread-count', requireAuth, (req, res) => {
  try {
    const count = messageDb.getUnreadCount(req.user.id);
    res.json({ success: true, count });
  } catch (err) { res.json({ success: true, count: 0 }); }
});

module.exports = router;
