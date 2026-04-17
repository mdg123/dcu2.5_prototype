const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const authDb = require('../db/auth');
const db = require('../db/index');

const adminOnly = [requireAuth, requireRole('admin')];

// GET /api/admin/users - 사용자 목록
router.get('/users', ...adminOnly, (req, res) => {
  try {
    const { role, status, page = 1 } = req.query;
    const users = authDb.getAllUsers({ role, status, page: parseInt(page) });
    const total = authDb.getUserCount({ role, status });
    res.json({ success: true, users, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/users/:id - 사용자 정보 수정 (역할, 상태)
router.put('/users/:id', ...adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role, status } = req.body;
    const fields = [];
    const params = [];
    if (role) { fields.push('role = ?'); params.push(role); }
    if (status) { fields.push('status = ?'); params.push(status); }
    if (fields.length === 0) return res.json({ success: true, message: '변경 사항이 없습니다.' });
    params.push(userId);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    const user = authDb.findUserById(userId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/users/:id - 사용자 삭제
router.delete('/users/:id', ...adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) return res.status(400).json({ success: false, message: '자기 자신은 삭제할 수 없습니다.' });
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/stats - 시스템 통계
router.get('/stats', ...adminOnly, (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const studentCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'student'").get().count;
    const teacherCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'teacher'").get().count;
    const classCount = db.prepare('SELECT COUNT(*) as count FROM classes').get().count;
    const contentCount = db.prepare('SELECT COUNT(*) as count FROM contents').get().count;
    const pendingContents = db.prepare("SELECT COUNT(*) as count FROM contents WHERE status = 'pending'").get().count;
    let pendingLessons = 0;
    try { pendingLessons = db.prepare("SELECT COUNT(*) as count FROM lessons WHERE status = 'pending'").get().count; } catch(e) {}
    const pendingTotal = pendingContents + pendingLessons;
    const logCount = db.prepare('SELECT COUNT(*) as count FROM learning_logs').get().count;
    const logToday = db.prepare("SELECT COUNT(*) as count FROM learning_logs WHERE DATE(created_at) = DATE('now', 'localtime')").get().count;
    const logWeek = db.prepare("SELECT COUNT(*) as count FROM learning_logs WHERE created_at >= DATE('now', 'weekday 0', '-6 days')").get().count;
    res.json({
      success: true,
      stats: { totalUsers, studentCount, teacherCount, classCount, contentCount, pendingContents, pendingLessons, pendingTotal, logCount, logToday, logWeek }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/classes - 전체 클래스 목록
router.get('/classes', ...adminOnly, (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const total = db.prepare('SELECT COUNT(*) as cnt FROM classes').get().cnt;
    const classes = db.prepare(`
      SELECT c.*, u.display_name as creator_name,
        (SELECT COUNT(*) FROM class_members WHERE class_id = c.id) as member_count
      FROM classes c JOIN users u ON c.created_by = u.id
      ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    res.json({ success: true, classes, total, totalPages: Math.ceil(total / parseInt(limit)) || 1 });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/contents - 콘텐츠 관리 (승인 대기 포함)
router.get('/contents', ...adminOnly, (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    let where = '';
    const params = [];
    if (status) { where = ' WHERE c.status = ?'; params.push(status); }
    const total = db.prepare('SELECT COUNT(*) as cnt FROM contents c' + where).get(...params).cnt;
    const contents = db.prepare(`
      SELECT c.*, u.display_name AS creator_name
      FROM contents c JOIN users u ON c.creator_id = u.id
      ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    res.json({ success: true, contents, total, totalPages: Math.ceil(total / parseInt(limit)) || 1 });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/contents/:id/approve - 콘텐츠 승인
router.put('/contents/:id/approve', ...adminOnly, (req, res) => {
  try {
    db.prepare("UPDATE contents SET status = 'published' WHERE id = ?").run(parseInt(req.params.id));
    res.json({ success: true, message: '승인되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/contents/:id/reject - 콘텐츠 거절
router.put('/contents/:id/reject', ...adminOnly, (req, res) => {
  try {
    db.prepare("UPDATE contents SET status = 'rejected' WHERE id = ?").run(parseInt(req.params.id));
    res.json({ success: true, message: '거절되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/contents/:id - 콘텐츠 삭제
router.delete('/contents/:id', ...adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM contents WHERE id = ?').run(parseInt(req.params.id));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ======== 수업 관리 ========

// GET /api/admin/lessons - 수업 목록 (승인 대기 포함)
router.get('/lessons', ...adminOnly, (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    let where = '';
    const params = [];
    if (status) { where = ' WHERE l.status = ?'; params.push(status); }
    const total = db.prepare('SELECT COUNT(*) as cnt FROM lessons l' + where).get(...params).cnt;
    const lessons = db.prepare(`
      SELECT l.*, u.display_name AS teacher_name, cl.name AS class_name
      FROM lessons l
      JOIN users u ON l.teacher_id = u.id
      JOIN classes cl ON l.class_id = cl.id
      ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    res.json({ success: true, lessons, total, totalPages: Math.ceil(total / parseInt(limit)) || 1 });
  } catch (err) {
    console.error('[ADMIN] lessons error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/lessons/:id/approve - 수업 승인 (pending → published)
router.put('/lessons/:id/approve', ...adminOnly, (req, res) => {
  try {
    db.prepare("UPDATE lessons SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parseInt(req.params.id));
    res.json({ success: true, message: '수업이 승인되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/lessons/:id/reject - 수업 거절
router.put('/lessons/:id/reject', ...adminOnly, (req, res) => {
  try {
    db.prepare("UPDATE lessons SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parseInt(req.params.id));
    res.json({ success: true, message: '수업이 거절되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/assignments - 학습 배포 이력 (전체)
router.get('/assignments', ...adminOnly, (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const rows = db.prepare(`
      SELECT da.id, da.title, da.description, da.assign_date, da.created_at,
             da.class_id, cl.name AS class_name,
             u.display_name AS teacher_name
      FROM daily_assignments da
      LEFT JOIN classes cl ON da.class_id = cl.id
      LEFT JOIN users u ON da.teacher_id = u.id
      ORDER BY da.created_at DESC
      LIMIT ?
    `).all(parseInt(limit));
    res.json({ success: true, assignments: rows });
  } catch (err) {
    console.error('[ADMIN] assignments error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/lessons/:id - 수업 삭제
router.delete('/lessons/:id', ...adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM lessons WHERE id = ?').run(parseInt(req.params.id));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
