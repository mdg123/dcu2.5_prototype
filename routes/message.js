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

// POST /api/message/rooms - 채팅방 생성 (1:1 + 다자(그룹) 지원)
router.post('/rooms', requireAuth, (req, res) => {
  try {
    const { classId, targetUserId, name } = req.body;
    let { memberIds } = req.body;

    // 1) memberIds 우선, 없으면 targetUserId → [targetUserId] 로 변환 (1:1 호환)
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      if (targetUserId !== undefined && targetUserId !== null && targetUserId !== '') {
        memberIds = [targetUserId];
      } else {
        memberIds = [];
      }
    }

    // 정수 변환 + 유효값만 통과
    memberIds = memberIds
      .map(v => parseInt(v, 10))
      .filter(v => Number.isInteger(v) && v > 0);

    // 2) 자기 자신 자동 포함 + 중복 제거 (Set)
    const meId = req.user.id;
    const uniqueOthers = Array.from(new Set(memberIds.filter(v => v !== meId)));

    // 다른 멤버가 0명이면 400
    if (uniqueOthers.length === 0) {
      return res.status(400).json({ success: false, message: '받는 사람을 선택하세요.' });
    }

    const finalMemberIds = [meId, ...uniqueOthers];

    // 3) 다른 멤버 1명 → direct + findDirectRoom 재사용
    if (uniqueOthers.length === 1) {
      const otherId = uniqueOthers[0];
      const existing = messageDb.findDirectRoom(meId, otherId);
      if (existing) {
        return res.json({ success: true, room: messageDb.getRoomById(existing.id), existed: true });
      }
      const room = messageDb.createRoom(classId || null, 'direct', null, finalMemberIds);
      return res.status(201).json({ success: true, room, existed: false });
    }

    // 4) 다른 멤버 2명 이상 → group (항상 신규 방)
    const groupName = (typeof name === 'string' && name.trim()) ? name.trim() : null;
    const room = messageDb.createRoom(classId || null, 'group', groupName, finalMemberIds);
    return res.status(201).json({ success: true, room, existed: false });
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
