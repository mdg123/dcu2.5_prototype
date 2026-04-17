const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const noticeDb = require('../db/notice');
const classDb = require('../db/class');

function requireMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  next();
}

router.get('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    const result = noticeDb.getNoticesByClass(req.classId, { page: parseInt(req.query.page) || 1 });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 작성 가능합니다.' });
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    const notice = noticeDb.createNotice(req.classId, req.user.id, req.body);
    res.status(201).json({ success: true, notice });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/:classId/:noticeId', requireAuth, requireMember, (req, res) => {
  try {
    const notice = noticeDb.getNoticeById(parseInt(req.params.noticeId));
    if (!notice || notice.class_id !== req.classId) return res.status(404).json({ success: false, message: '알림을 찾을 수 없습니다.' });
    noticeDb.markRead(notice.id, req.user.id);
    const isRead = true;
    res.json({ success: true, notice, isRead });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/:classId/:noticeId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    const notice = noticeDb.updateNotice(parseInt(req.params.noticeId), req.body);
    res.json({ success: true, notice });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.delete('/:classId/:noticeId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    noticeDb.deleteNotice(parseInt(req.params.noticeId));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

module.exports = router;
