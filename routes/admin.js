const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const authDb = require('../db/auth');
const db = require('../db/index');

const adminOnly = [requireAuth, requireRole('admin')];

// 학습맵 업로드 전용 multer (메모리 버퍼)
const learningMapUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('xlsx/xls 파일만 업로드 가능합니다.'), false);
  }
});

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

// GET /api/admin/lessons/:id - 수업 상세 (미리보기)
router.get('/lessons/:id', ...adminOnly, (req, res) => {
  try {
    const lesson = db.prepare(`
      SELECT l.*, u.display_name AS teacher_name, cl.name AS class_name
      FROM lessons l
      JOIN users u ON l.teacher_id = u.id
      JOIN classes cl ON l.class_id = cl.id
      WHERE l.id = ?
    `).get(parseInt(req.params.id));
    if (!lesson) return res.status(404).json({ success: false, message: '수업을 찾을 수 없습니다.' });
    res.json({ success: true, lesson });
  } catch (err) {
    console.error('[ADMIN] lesson detail error:', err);
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

// ======== 학습맵 노드-콘텐츠 매핑 관리 ========

const PROBLEM_TYPES = ['quiz', 'exam', 'problem', 'assessment', 'question'];
const PROBLEM_TYPES_SQL = `('quiz','exam','problem','assessment','question')`;

// GET /api/admin/learning-map/nodes - 노드 검색/목록 (매핑된 콘텐츠 수 포함)
router.get('/learning-map/nodes', ...adminOnly, (req, res) => {
  try {
    const { subject, grade, semester, area, keyword } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const nodeLevel = req.query.nodeLevel ? parseInt(req.query.nodeLevel) : null;
    // mappingFilter: empty_video | empty_problem | empty_all | mapped (videos_count/problems_count 기반 필터)
    const mappingFilter = (req.query.mappingFilter || '').toString().trim();

    let where = 'WHERE 1=1';
    const params = [];
    if (subject) { where += ' AND n.subject = ?'; params.push(subject); }
    if (grade) { where += ' AND n.grade = ?'; params.push(parseInt(grade)); }
    if (semester) { where += ' AND n.semester = ?'; params.push(parseInt(semester)); }
    if (area) { where += ' AND n.area = ?'; params.push(area); }
    if (nodeLevel) { where += ' AND n.node_level = ?'; params.push(nodeLevel); }
    if (keyword) {
      where += ' AND (n.unit_name LIKE ? OR n.lesson_name LIKE ? OR n.achievement_code LIKE ? OR n.achievement_text LIKE ? OR n.node_id LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw, kw, kw);
    }

    // mappingFilter 처리 (HAVING 절)
    let having = '';
    if (mappingFilter === 'empty_video') having = 'HAVING videos_count = 0';
    else if (mappingFilter === 'empty_problem') having = 'HAVING problems_count = 0';
    else if (mappingFilter === 'empty_all') having = 'HAVING videos_count = 0 AND problems_count = 0';
    else if (mappingFilter === 'mapped') having = 'HAVING (videos_count + problems_count) > 0';

    // total 계산: HAVING이 있으면 서브쿼리로 감싸야 정확
    const totalSql = having
      ? `SELECT COUNT(*) AS cnt FROM (
           SELECT n.node_id,
             (SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id=c.id
               WHERE nc.node_id=n.node_id AND c.content_type='video') AS videos_count,
             (SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id=c.id
               WHERE nc.node_id=n.node_id AND c.content_type IN ${PROBLEM_TYPES_SQL}) AS problems_count
           FROM learning_map_nodes n ${where} ${having}
         )`
      : `SELECT COUNT(*) as cnt FROM learning_map_nodes n ${where}`;
    const total = db.prepare(totalSql).get(...params).cnt;
    const nodes = db.prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id = c.id
          WHERE nc.node_id = n.node_id AND c.content_type = 'video') AS videos_count,
        (SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id = c.id
          WHERE nc.node_id = n.node_id AND c.content_type IN ${PROBLEM_TYPES_SQL}) AS problems_count
      FROM learning_map_nodes n
      ${where}
      ${having}
      ORDER BY n.subject, n.grade, n.semester, n.sort_order
      LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    res.json({
      success: true,
      nodes,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err) {
    console.error('[ADMIN] learning-map/nodes error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/learning-map/nodes/:nodeId/contents - 노드에 매핑된 콘텐츠 (videos/problems 분리)
router.get('/learning-map/nodes/:nodeId/contents', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const node = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });

    const rows = db.prepare(`
      SELECT nc.id AS mapping_id, nc.node_id, nc.content_id, nc.content_role, nc.sort_order,
             c.title, c.content_type, c.content_url, c.file_path, c.thumbnail_url,
             c.subject, c.grade, c.description, c.status, c.view_count
      FROM node_contents nc
      JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ?
      ORDER BY nc.sort_order, nc.id
    `).all(nodeId);

    const videos = rows.filter(r => r.content_type === 'video');
    const problems = rows.filter(r => PROBLEM_TYPES.includes(r.content_type));
    const others = rows.filter(r => r.content_type !== 'video' && !PROBLEM_TYPES.includes(r.content_type));

    res.json({ success: true, node, videos, problems, others, total: rows.length });
  } catch (err) {
    console.error('[ADMIN] learning-map/nodes/:id/contents error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/learning-map/nodes/:nodeId/contents - 매핑 추가
router.post('/learning-map/nodes/:nodeId/contents', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const { content_id, content_role = 'learn', sort_order } = req.body || {};
    if (!content_id) return res.status(400).json({ success: false, message: 'content_id 필요' });

    const node = db.prepare('SELECT node_id, node_level FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });
    if (node.node_level !== 3) {
      return res.status(400).json({ success: false, message: '콘텐츠는 차시(level=3) 노드에만 매핑할 수 있습니다.' });
    }
    const content = db.prepare('SELECT id FROM contents WHERE id = ?').get(parseInt(content_id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });

    const dup = db.prepare('SELECT id FROM node_contents WHERE node_id = ? AND content_id = ?').get(nodeId, parseInt(content_id));
    if (dup) return res.status(409).json({ success: false, message: '이미 매핑된 콘텐츠입니다.' });

    let order = sort_order;
    if (order === undefined || order === null || order === '') {
      const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM node_contents WHERE node_id = ?').get(nodeId);
      order = (maxRow.mx || 0) + 1;
    }
    const info = db.prepare(`
      INSERT INTO node_contents (node_id, content_id, content_role, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(nodeId, parseInt(content_id), content_role, parseInt(order));

    res.json({ success: true, id: info.lastInsertRowid, node_id: nodeId, content_id: parseInt(content_id), content_role, sort_order: parseInt(order) });
  } catch (err) {
    console.error('[ADMIN] learning-map add mapping error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/learning-map/nodes/:unitId/lessons - 단원(level=2) 의 자식 차시 목록 (총 매핑 수 포함)
router.get('/learning-map/nodes/:unitId/lessons', ...adminOnly, (req, res) => {
  try {
    const unitId = req.params.unitId;
    const unit = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id = ?').get(unitId);
    if (!unit) return res.status(404).json({ success: false, message: '단원을 찾을 수 없습니다.' });

    const lessons = db.prepare(`
      SELECT n.node_id, n.subject, n.grade, n.semester, n.unit_name, n.lesson_name,
             n.achievement_code, n.node_level, n.parent_node_id, n.sort_order,
             (SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id = c.id
                WHERE nc.node_id = n.node_id AND c.content_type = 'video') AS videos_count,
             (SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id = c.id
                WHERE nc.node_id = n.node_id AND c.content_type IN ${PROBLEM_TYPES_SQL}) AS problems_count,
             (SELECT COUNT(*) FROM node_contents nc WHERE nc.node_id = n.node_id) AS total_count
      FROM learning_map_nodes n
      WHERE n.parent_node_id = ? AND n.node_level = 3
      ORDER BY n.sort_order, n.node_id
    `).all(unitId);

    res.json({ success: true, unit, lessons });
  } catch (err) {
    console.error('[ADMIN] learning-map/nodes/:unitId/lessons error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/contents/public-search?keyword=&type=
// type: video | question | quiz | exam (question 은 quiz/exam/problem/assessment 포괄). 공개 승인된 콘텐츠만.
router.get('/contents/public-search', ...adminOnly, (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    const type = (req.query.type || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));

    let where = `WHERE c.is_public = 1 AND c.status = 'approved'`;
    const params = [];
    if (type === 'video') {
      where += ` AND c.content_type = 'video'`;
    } else if (type === 'question') {
      where += ` AND c.content_type IN ${PROBLEM_TYPES_SQL}`;
    } else if (type === 'quiz') {
      where += ` AND c.content_type = 'quiz'`;
    } else if (type === 'exam') {
      where += ` AND c.content_type = 'exam'`;
    }
    if (keyword) {
      where += ` AND (c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ?)`;
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    // B-P0-4: 노드 컨텍스트 필터 (학년/교과/성취기준코드)
    const subject = (req.query.subject || '').toString().trim();
    const grade = req.query.grade ? parseInt(req.query.grade) : null;
    const achievementCode = (req.query.achievement_code || '').toString().trim();
    if (subject) {
      // '수학' / '수학과' 정규화 — 두 표기 모두 매칭
      const norm = subject.replace(/과$/, '');
      where += ` AND (c.subject = ? OR c.subject = ?)`;
      params.push(norm, norm + '과');
    }
    if (grade) { where += ` AND c.grade = ?`; params.push(grade); }
    if (achievementCode) { where += ` AND c.achievement_code = ?`; params.push(achievementCode); }

    const rows = db.prepare(`
      SELECT c.id, c.title, c.content_type, c.subject, c.grade, c.unit_name,
             c.achievement_code, c.thumbnail_url, c.difficulty, c.estimated_minutes,
             c.view_count, c.created_at
      FROM contents c
      ${where}
      ORDER BY c.view_count DESC, c.id DESC
      LIMIT ?
    `).all(...params, limit);

    res.json({ success: true, contents: rows, total: rows.length });
  } catch (err) {
    console.error('[ADMIN] contents/public-search error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/learning-map/nodes/:nodeId/contents/by-id
// body: { contentId, role }  — 콘텐츠 ID 직접 매핑 (level=3 가드 포함)
router.post('/learning-map/nodes/:nodeId/contents/by-id', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const { contentId, role } = req.body || {};
    const cid = parseInt(contentId);
    if (!cid) return res.status(400).json({ success: false, message: 'contentId 필요' });

    const node = db.prepare('SELECT node_id, node_level FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });
    if (node.node_level !== 3) {
      return res.status(400).json({ success: false, message: '콘텐츠는 차시(level=3) 노드에만 매핑할 수 있습니다.' });
    }

    const content = db.prepare('SELECT id, content_type FROM contents WHERE id = ?').get(cid);
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });

    const dup = db.prepare('SELECT id FROM node_contents WHERE node_id = ? AND content_id = ?').get(nodeId, cid);
    if (dup) return res.status(409).json({ success: false, message: '이미 매핑된 콘텐츠입니다.' });

    // role 기본: video 면 'video', 문제류면 'problem', 그 외 'learn'
    let finalRole = role;
    if (!finalRole) {
      if (content.content_type === 'video') finalRole = 'video';
      else if (PROBLEM_TYPES.includes(content.content_type)) finalRole = 'problem';
      else finalRole = 'learn';
    }

    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM node_contents WHERE node_id = ?').get(nodeId);
    const order = (maxRow.mx || 0) + 1;

    const info = db.prepare(`
      INSERT INTO node_contents (node_id, content_id, content_role, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(nodeId, cid, finalRole, order);

    res.json({
      success: true,
      id: info.lastInsertRowid,
      node_id: nodeId,
      content_id: cid,
      content_role: finalRole,
      sort_order: order
    });
  } catch (err) {
    console.error('[ADMIN] learning-map add by-id error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/learning-map/nodes/:nodeId/contents/:contentId - sort_order, content_role 수정
router.put('/learning-map/nodes/:nodeId/contents/:contentId', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const contentId = parseInt(req.params.contentId);
    const { content_role, sort_order } = req.body || {};

    const existing = db.prepare('SELECT id FROM node_contents WHERE node_id = ? AND content_id = ?').get(nodeId, contentId);
    if (!existing) return res.status(404).json({ success: false, message: '매핑을 찾을 수 없습니다.' });

    const fields = [];
    const params = [];
    if (content_role !== undefined) { fields.push('content_role = ?'); params.push(content_role); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(parseInt(sort_order)); }
    if (fields.length === 0) return res.json({ success: true, message: '변경 사항이 없습니다.' });

    params.push(nodeId, contentId);
    db.prepare(`UPDATE node_contents SET ${fields.join(', ')} WHERE node_id = ? AND content_id = ?`).run(...params);
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] learning-map update mapping error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/learning-map/nodes/:nodeId/contents/:contentId - 매핑 제거
router.delete('/learning-map/nodes/:nodeId/contents/:contentId', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const contentId = parseInt(req.params.contentId);
    const info = db.prepare('DELETE FROM node_contents WHERE node_id = ? AND content_id = ?').run(nodeId, contentId);
    if (info.changes === 0) return res.status(404).json({ success: false, message: '매핑을 찾을 수 없습니다.' });
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[ADMIN] learning-map delete mapping error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/contents/pickable?type=video|question&keyword= - 매핑용 콘텐츠 선택 목록
router.get('/contents/pickable', ...adminOnly, (req, res) => {
  try {
    const { type, keyword, subject, grade } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    // B-P0-3: DB 실 상태값은 'approved'. 'published'는 0건 — 상수 수정.
    let where = "WHERE c.status = 'approved'";
    const params = [];
    if (type === 'video') {
      where += ' AND c.content_type = ?';
      params.push('video');
    } else if (type === 'question' || type === 'problem') {
      where += ` AND c.content_type IN ${PROBLEM_TYPES_SQL}`;
    } else if (type) {
      where += ' AND c.content_type = ?';
      params.push(type);
    }
    if (keyword) {
      where += ' AND (c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    if (subject) { where += ' AND c.subject = ?'; params.push(subject); }
    if (grade) { where += ' AND c.grade = ?'; params.push(parseInt(grade)); }
    // B-P0-4: achievement_code 필터 (노드 컨텍스트 기반 자동 추천)
    if (req.query.achievement_code) {
      where += ' AND c.achievement_code = ?';
      params.push(req.query.achievement_code);
    }

    const total = db.prepare(`SELECT COUNT(*) AS cnt FROM contents c ${where}`).get(...params).cnt;
    const contents = db.prepare(`
      SELECT c.id, c.title, c.content_type, c.subject, c.grade, c.description,
             c.thumbnail_url, c.file_path, c.content_url, c.view_count, c.status
      FROM contents c
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    res.json({ success: true, contents, total, page, limit, totalPages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error('[ADMIN] contents/pickable error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ======== 매핑 통계 + 자동 매핑 + 일괄 + CSV ========

// GET /api/admin/learning-map/mapping-stats — 매핑률·영상·문항·고립 통계
router.get('/learning-map/mapping-stats', ...adminOnly, (req, res) => {
  try {
    const totalLessons = db.prepare("SELECT COUNT(*) AS c FROM learning_map_nodes WHERE node_level = 3").get().c;
    const mappedLessons = db.prepare(`
      SELECT COUNT(DISTINCT n.node_id) AS c
      FROM learning_map_nodes n JOIN node_contents nc ON nc.node_id = n.node_id
      WHERE n.node_level = 3
    `).get().c;
    const isolatedLessons = totalLessons - mappedLessons;
    const videoMappings = db.prepare(`
      SELECT COUNT(*) AS c FROM node_contents nc JOIN contents c ON c.id = nc.content_id
      WHERE c.content_type = 'video'
    `).get().c;
    const quizMappings = db.prepare(`
      SELECT COUNT(*) AS c FROM node_contents nc JOIN contents c ON c.id = nc.content_id
      WHERE c.content_type IN ${PROBLEM_TYPES_SQL}
    `).get().c;
    res.json({
      success: true,
      totalLessons, mappedLessons, isolatedLessons,
      mappingRatePct: totalLessons ? Math.round((mappedLessons / totalLessons) * 100) : 0,
      videoMappings, quizMappings
    });
  } catch (err) {
    console.error('[ADMIN] mapping-stats error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/admin/learning-map/isolated-nodes — 고립(미매핑) 차시 노드 목록
router.get('/learning-map/isolated-nodes', ...adminOnly, (req, res) => {
  try {
    const grade = parseIntOrNull(req.query.grade);
    const subject = req.query.subject || null;
    const area = req.query.area || null;
    const type = req.query.type; // 'video' | 'quiz' — 부재 콘텐츠 타입 기준 필터
    const limit = Math.min(500, parseInt(req.query.limit) || 100);

    let condTypeJoin = '';
    if (type === 'video') {
      condTypeJoin = `AND NOT EXISTS (
        SELECT 1 FROM node_contents nc JOIN contents c ON c.id = nc.content_id
        WHERE nc.node_id = n.node_id AND c.content_type = 'video')`;
    } else if (type === 'quiz' || type === 'question') {
      condTypeJoin = `AND NOT EXISTS (
        SELECT 1 FROM node_contents nc JOIN contents c ON c.id = nc.content_id
        WHERE nc.node_id = n.node_id AND c.content_type IN ${PROBLEM_TYPES_SQL})`;
    } else {
      condTypeJoin = `AND NOT EXISTS (SELECT 1 FROM node_contents nc WHERE nc.node_id = n.node_id)`;
    }

    let where = `WHERE n.node_level = 3 ${condTypeJoin}`;
    const params = [];
    if (grade) { where += ' AND n.grade = ?'; params.push(grade); }
    if (subject) { where += ' AND n.subject = ?'; params.push(subject); }
    if (area) { where += ' AND n.area = ?'; params.push(area); }

    const nodes = db.prepare(`
      SELECT n.node_id, n.lesson_name, n.unit_name, n.area, n.subject, n.grade, n.achievement_code
      FROM learning_map_nodes n
      ${where}
      ORDER BY n.grade, n.unit_name, n.sort_order
      LIMIT ?
    `).all(...params, limit);
    res.json({ success: true, nodes, count: nodes.length });
  } catch (err) {
    console.error('[ADMIN] isolated-nodes error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/admin/learning-map/auto-suggest?nodeId=...&type=video|quiz — AI 추천
router.get('/learning-map/auto-suggest', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.query.nodeId;
    const type = req.query.type || 'quiz';
    if (!nodeId) return res.status(400).json({ success: false, message: 'nodeId 필요' });

    const node = db.prepare('SELECT node_id, lesson_name, unit_name, area, subject, grade, achievement_code FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) return res.status(404).json({ success: false, message: '노드 없음' });

    // 1) 같은 std_id로 매핑된 후보 (가장 신뢰)
    // 2) 같은 학년·교과·achievement_code 매칭
    // 3) lesson_name 키워드(공백 분할) 콘텐츠 title/tags 매칭

    const tokens = (node.lesson_name || '').split(/[\s\-·,()]+/).filter(t => t && t.length >= 2);
    const tokenScore = tokens.length;

    let typeFilter = '';
    if (type === 'video') typeFilter = "AND c.content_type = 'video'";
    else typeFilter = `AND c.content_type IN ${PROBLEM_TYPES_SQL}`;

    // 이미 매핑된 콘텐츠는 제외
    const candidates = db.prepare(`
      SELECT c.id, c.title, c.content_type, c.subject, c.grade, c.achievement_code, c.tags,
        CASE WHEN c.achievement_code = ? THEN 50 ELSE 0 END AS code_match,
        CASE WHEN c.subject = ? THEN 10 ELSE 0 END AS subject_match,
        CASE WHEN c.grade = ? THEN 10 ELSE 0 END AS grade_match
      FROM contents c
      WHERE c.status = 'approved' AND c.is_public = 1
        ${typeFilter}
        AND NOT EXISTS (SELECT 1 FROM node_contents nc WHERE nc.node_id = ? AND nc.content_id = c.id)
      LIMIT 500
    `).all(node.achievement_code || '', node.subject || '', node.grade || 0, nodeId);

    // lesson_name 토큰 매칭 점수 추가
    const scored = candidates.map(c => {
      const blob = `${c.title || ''} ${c.tags || ''}`;
      let tokMatched = 0;
      for (const t of tokens) if (blob.includes(t)) tokMatched++;
      const tokScore = tokenScore > 0 ? Math.round((tokMatched / tokenScore) * 30) : 0;
      const total = c.code_match + c.subject_match + c.grade_match + tokScore;
      // 정확도 % 환산: 100 만점
      const accuracy = Math.min(100, total);
      return { id: c.id, title: c.title, content_type: c.content_type, accuracy, code_match: !!c.code_match, tok_matched: tokMatched, tok_total: tokenScore };
    }).sort((a, b) => b.accuracy - a.accuracy).slice(0, 30);

    const high = scored.filter(s => s.accuracy >= 80);
    const mid = scored.filter(s => s.accuracy >= 60 && s.accuracy < 80);
    const low = scored.filter(s => s.accuracy < 60);

    res.json({ success: true, node, suggestions: { high, mid, low }, total: scored.length });
  } catch (err) {
    console.error('[ADMIN] auto-suggest error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// POST /api/admin/learning-map/mappings/bulk — 일괄 매핑 추가
router.post('/learning-map/mappings/bulk', ...adminOnly, (req, res) => {
  try {
    const { mappings } = req.body || {};
    // dryRun: query string(?dryRun=1) 또는 body.dryRun 둘 다 지원 (감리 footgun 수정)
    const dryRun = req.body?.dryRun === true || req.body?.dryRun === 'true' || req.body?.dryRun === 1
                || req.query?.dryRun === '1' || req.query?.dryRun === 'true';
    if (!Array.isArray(mappings) || !mappings.length) {
      return res.status(400).json({ success: false, message: 'mappings 배열 필요' });
    }
    const ins = db.prepare(`
      INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order)
      VALUES (?, ?, ?, ?)
    `);
    const checkNode = db.prepare('SELECT 1 FROM learning_map_nodes WHERE node_id = ?');
    const checkContent = db.prepare("SELECT 1 FROM contents WHERE id = ? AND status = 'approved'");

    let inserted = 0, skipped = 0;
    const errors = [];

    if (dryRun) {
      for (const m of mappings) {
        const { nodeId, contentId } = m;
        if (!checkNode.get(nodeId)) { errors.push({ nodeId, contentId, reason: 'node_not_found' }); continue; }
        if (!checkContent.get(contentId)) { errors.push({ nodeId, contentId, reason: 'content_not_approved' }); continue; }
        const exists = db.prepare('SELECT 1 FROM node_contents WHERE node_id=? AND content_id=?').get(nodeId, contentId);
        if (exists) skipped++; else inserted++;
      }
      return res.json({ success: true, dryRun: true, willInsert: inserted, willSkip: skipped, errors });
    }

    const tx = db.transaction(() => {
      for (const m of mappings) {
        const { nodeId, contentId, role = 'practice', sortOrder = 0 } = m;
        if (!checkNode.get(nodeId)) { errors.push({ nodeId, contentId, reason: 'node_not_found' }); continue; }
        if (!checkContent.get(contentId)) { errors.push({ nodeId, contentId, reason: 'content_not_approved' }); continue; }
        const r = ins.run(nodeId, parseInt(contentId), role, sortOrder);
        if (r.changes > 0) inserted++; else skipped++;
      }
    });
    tx();
    res.json({ success: true, inserted, skipped, errors });
  } catch (err) {
    console.error('[ADMIN] mappings/bulk error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /api/admin/learning-map/mappings/export — CSV 내보내기
router.get('/learning-map/mappings/export', ...adminOnly, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT nc.node_id, n.lesson_name, n.unit_name, n.subject, n.grade, n.area,
             nc.content_id, c.title, c.content_type, nc.content_role, nc.sort_order
      FROM node_contents nc
      JOIN learning_map_nodes n ON n.node_id = nc.node_id
      JOIN contents c ON c.id = nc.content_id
      ORDER BY n.grade, n.unit_name, nc.node_id, nc.sort_order
    `).all();
    const header = 'node_id,lesson_name,unit_name,subject,grade,area,content_id,title,content_type,role,sort_order\n';
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    };
    const body = rows.map(r => [r.node_id, r.lesson_name, r.unit_name, r.subject, r.grade, r.area, r.content_id, r.title, r.content_type, r.content_role, r.sort_order].map(escape).join(',')).join('\n');
    const csv = '﻿' + header + body;  // BOM for Excel UTF-8
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="node-content-mappings.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[ADMIN] mappings/export error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ======== 학습맵 Excel 업로드 ========

function parseIntOrNull(v, dflt = null) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function deriveGradeLevel(grade, nodeId) {
  const id = String(nodeId || '').trim().toUpperCase();
  if (id.startsWith('H')) return '고';
  if (id.startsWith('M')) return '중';
  if (id.startsWith('E')) return '초';
  // fallback: grade 숫자 기반
  const g = parseInt(grade, 10);
  if (Number.isFinite(g) && g >= 10) return '고';
  if (Number.isFinite(g) && g >= 7) return '중';
  return '초';
}

function splitIds(str) {
  if (!str) return [];
  return String(str).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

// GET /api/admin/learning-map/summary - 학습맵 요약 통계
router.get('/learning-map/summary', ...adminOnly, (req, res) => {
  try {
    const total_nodes = db.prepare('SELECT COUNT(*) AS cnt FROM learning_map_nodes').get().cnt;
    const total_edges = db.prepare('SELECT COUNT(*) AS cnt FROM learning_map_edges').get().cnt;
    const by_subject = db.prepare(`
      SELECT subject, COUNT(*) AS cnt
      FROM learning_map_nodes
      GROUP BY subject
      ORDER BY cnt DESC
    `).all();
    const by_grade = db.prepare(`
      SELECT grade, COUNT(*) AS cnt
      FROM learning_map_nodes
      GROUP BY grade
      ORDER BY grade
    `).all();
    const by_semester = db.prepare(`
      SELECT semester, COUNT(*) AS cnt
      FROM learning_map_nodes
      WHERE semester IS NOT NULL
      GROUP BY semester
      ORDER BY semester
    `).all();
    res.json({ success: true, summary: { total_nodes, total_edges, by_subject, by_grade, by_semester } });
  } catch (err) {
    console.error('[ADMIN] learning-map/summary error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/learning-map/upload - 학습맵 Excel 업로드
router.post('/learning-map/upload', ...adminOnly, (req, res, next) => {
  learningMapUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    if (!req.file) return res.status(400).json({ success: false, message: '파일이 선택되지 않았습니다.' });

    const mode = (req.body.mode || 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
    // cascade: replace 모드에서 참조 테이블도 함께 삭제할지 여부 (기본: true)
    const cascadeRaw = req.body.cascade;
    const cascade = cascadeRaw === undefined || cascadeRaw === null
      ? true
      : !(cascadeRaw === false || cascadeRaw === 'false' || cascadeRaw === '0' || cascadeRaw === 0);
    const stats = {
      inserted_lesson_nodes: 0,
      updated_lesson_nodes: 0,
      inserted_unit_nodes: 0,
      updated_unit_nodes: 0,
      inserted_lesson_edges: 0,
      inserted_unit_edges: 0,
      skipped_rows: 0,
      skipped_missing_unit_name: 0,
      deleted_nodes: 0,
      deleted_edges: 0,
      deleted_contents_mappings: 0,
      deleted_user_statuses: 0,
      deleted_diagnosis_sessions: 0,
      deleted_diagnosis_answers: 0,
      deleted_learning_paths: 0,
      orphan_nodes_remaining: 0,
      errors: []
    };

    // 단원 해시 노드 ID 생성 (U + sha1(key).slice(0,16), 17자)
    const makeUnitNodeId = (subject, grade, semester, unitName, gradeLevel) => {
      const key = `${gradeLevel || ''}||${subject}||${grade}||${semester == null ? '' : semester}||${unitName}`;
      return 'U' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    };

    try {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames.includes('학습맵_리니어연결') ? '학습맵_리니어연결' : wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      if (!sheet) return res.status(400).json({ success: false, message: '시트를 찾을 수 없습니다.' });
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

      const upsertNode = db.prepare(`
        INSERT INTO learning_map_nodes
          (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name,
           achievement_code, achievement_text, node_level, parent_node_id, sort_order)
        VALUES (@node_id, @subject, @grade_level, @grade, @semester, @area, @unit_name, @lesson_name,
                @achievement_code, @achievement_text, @node_level, @parent_node_id, @sort_order)
        ON CONFLICT(node_id) DO UPDATE SET
          subject = excluded.subject,
          grade_level = excluded.grade_level,
          grade = excluded.grade,
          semester = excluded.semester,
          area = excluded.area,
          unit_name = excluded.unit_name,
          lesson_name = excluded.lesson_name,
          achievement_code = excluded.achievement_code,
          achievement_text = excluded.achievement_text,
          node_level = excluded.node_level,
          parent_node_id = excluded.parent_node_id,
          sort_order = excluded.sort_order
      `);
      const existsNode = db.prepare('SELECT 1 FROM learning_map_nodes WHERE node_id = ?');
      const insertEdge = db.prepare(`
        INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id, edge_type)
        VALUES (?, ?, 'prerequisite')
      `);
      const insertUnitEdge = db.prepare(`
        INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id, edge_type)
        VALUES (?, ?, 'unit_prerequisite')
      `);
      const deleteAllNodes = db.prepare('DELETE FROM learning_map_nodes');
      const deleteAllEdges = db.prepare('DELETE FROM learning_map_edges');
      const deleteAllContentsMap = db.prepare('DELETE FROM node_contents');
      const deleteAllUserStatus = db.prepare('DELETE FROM user_node_status');
      const deleteAllDiagAnswers = db.prepare('DELETE FROM diagnosis_answers');
      const deleteAllDiagSessions = db.prepare('DELETE FROM diagnosis_sessions');
      const deleteAllLearningPaths = db.prepare('DELETE FROM learning_paths');

      // 이번 업로드에 등장하는 node_id 집합 (3단계 + 2단계, 중복 제거 후 기록)
      const uploadedNodeIds = new Set();

      const run = db.transaction(() => {
        if (mode === 'replace') {
          if (cascade) {
            // 참조 테이블 선 삭제 (FK 없지만 일관성 유지)
            stats.deleted_contents_mappings = deleteAllContentsMap.run().changes;
            stats.deleted_user_statuses = deleteAllUserStatus.run().changes;
            stats.deleted_diagnosis_answers = deleteAllDiagAnswers.run().changes;
            stats.deleted_diagnosis_sessions = deleteAllDiagSessions.run().changes;
            stats.deleted_learning_paths = deleteAllLearningPaths.run().changes;
          }
          stats.deleted_edges = deleteAllEdges.run().changes;
          stats.deleted_nodes = deleteAllNodes.run().changes;
        }

        // 0차 패스: 단원 노드 그룹핑 (subject, grade, semester, 단원명) → 대표행
        // lessonId → unitNodeId 매핑도 함께 기록
        const unitGroups = new Map(); // unitKey -> { unitNodeId, subject, grade, semester, grade_level, area, unit_name, representativeIdx }
        const lessonToUnit = new Map(); // 3단계ID -> unitNodeId

        rows.forEach((row, idx) => {
          const unitName = row['단원명'] ? String(row['단원명']).trim() : '';
          if (!unitName) return;
          const subject = row['교과'] ? String(row['교과']).trim() : '기타';
          const grade = parseIntOrNull(row['적용학년'], 1) || 1;
          const semester = parseIntOrNull(row['적용학기'], null);
          const grade_level = deriveGradeLevel(grade, row['3단계ID'] || row['2단계ID']);
          const unitNodeId = makeUnitNodeId(subject, grade, semester, unitName, grade_level);
          if (!unitGroups.has(unitNodeId)) {
            unitGroups.set(unitNodeId, {
              unitNodeId,
              subject,
              grade,
              semester,
              grade_level,
              area: row['내용체계영역'] ? String(row['내용체계영역']).trim() : null,
              unit_name: unitName,
              representativeIdx: idx
            });
          }
        });

        // 1차 패스: 단원 노드 upsert (node_level=2)
        let unitOrder = 0;
        for (const grp of unitGroups.values()) {
          try {
            const wasExisting = !!existsNode.get(grp.unitNodeId);
            upsertNode.run({
              node_id: grp.unitNodeId,
              subject: grp.subject,
              grade_level: grp.grade_level,
              grade: grp.grade,
              semester: grp.semester,
              area: grp.area,
              unit_name: grp.unit_name,
              lesson_name: null,
              achievement_code: null,
              achievement_text: null,
              node_level: 2,
              parent_node_id: null,
              sort_order: unitOrder++
            });
            uploadedNodeIds.add(grp.unitNodeId);
            if (!wasExisting) stats.inserted_unit_nodes++;
            else stats.updated_unit_nodes++;
          } catch (e) {
            if (stats.errors.length < 20) stats.errors.push(`unit ${grp.unit_name}: ${e.message}`);
          }
        }

        // 2차 패스: 차시 노드 upsert (node_level=3)
        rows.forEach((row, idx) => {
          try {
            const nodeId = row['3단계ID'] ? String(row['3단계ID']).trim() : '';
            if (!nodeId) { stats.skipped_rows++; return; }
            const unitName = row['단원명'] ? String(row['단원명']).trim() : '';
            if (!unitName) {
              stats.skipped_missing_unit_name++;
              if (stats.errors.length < 20) stats.errors.push(`row ${idx + 2} (${nodeId}): 단원명 누락으로 skip`);
              return;
            }
            const subject = row['교과'] ? String(row['교과']).trim() : '기타';
            const grade = parseIntOrNull(row['적용학년'], 1) || 1;
            const semester = parseIntOrNull(row['적용학기'], null);
            const grade_level = deriveGradeLevel(grade, nodeId);
            const unitNodeId = makeUnitNodeId(subject, grade, semester, unitName, grade_level);

            const isNew = !existsNode.get(nodeId);
            upsertNode.run({
              node_id: nodeId,
              subject,
              grade_level,
              grade,
              semester,
              area: row['내용체계영역'] ? String(row['내용체계영역']).trim() : null,
              unit_name: unitName,
              lesson_name: row['3단계내용요소'] ? String(row['3단계내용요소']).trim() : null,
              achievement_code: row['성취기준코드'] ? String(row['성취기준코드']).trim() : null,
              achievement_text: row['성취기준'] ? String(row['성취기준']).trim() : null,
              node_level: 3,
              parent_node_id: unitNodeId,
              sort_order: idx
            });
            uploadedNodeIds.add(nodeId);
            lessonToUnit.set(nodeId, unitNodeId);
            if (isNew) stats.inserted_lesson_nodes++;
            else stats.updated_lesson_nodes++;
          } catch (e) {
            stats.skipped_rows++;
            if (stats.errors.length < 20) stats.errors.push(`row ${idx + 2}: ${e.message}`);
          }
        });

        // 3차 패스: 차시 엣지 (선수학습ID → 현재 3단계ID) + 파생된 단원 엣지
        const unitEdgeSeen = new Set(); // "unitA->unitB"
        rows.forEach((row, idx) => {
          try {
            const toId = row['3단계ID'] ? String(row['3단계ID']).trim() : '';
            if (!toId) return;
            const prereqs = splitIds(row['선수학습ID']);
            prereqs.forEach(fromId => {
              if (fromId === toId) return;
              const info = insertEdge.run(fromId, toId);
              if (info.changes > 0) stats.inserted_lesson_edges++;

              // 단원 엣지 파생
              const unitA = lessonToUnit.get(fromId);
              const unitB = lessonToUnit.get(toId);
              if (unitA && unitB && unitA !== unitB) {
                const key = `${unitA}->${unitB}`;
                if (!unitEdgeSeen.has(key)) {
                  unitEdgeSeen.add(key);
                  const uinfo = insertUnitEdge.run(unitA, unitB);
                  if (uinfo.changes > 0) stats.inserted_unit_edges++;
                }
              }
            });
          } catch (e) {
            if (stats.errors.length < 20) stats.errors.push(`edge row ${idx + 2}: ${e.message}`);
          }
        });
      });

      run();

      // 트랜잭션 바깥: orphan_nodes_remaining (merge 모드일 때만 의미있음)
      if (mode === 'merge' && uploadedNodeIds.size > 0) {
        const allNodeIds = db.prepare('SELECT node_id FROM learning_map_nodes').all().map(r => r.node_id);
        stats.orphan_nodes_remaining = allNodeIds.filter(id => !uploadedNodeIds.has(id)).length;
      }

      res.json({
        success: true,
        mode,
        cascade: mode === 'replace' ? cascade : null,
        sheet: sheetName,
        total_rows: rows.length,
        unique_uploaded_node_ids: uploadedNodeIds.size,
        stats
      });
    } catch (err) {
      console.error('[ADMIN] learning-map/upload error:', err);
      res.status(500).json({ success: false, message: '업로드 처리 중 오류: ' + err.message, stats });
    }
  });
});

// ======== 고아 데이터 정리 ========

// 고아 레퍼런스 개수 계산 (learning_map_nodes에 존재하지 않는 node_id 참조)
function countOrphanRefs() {
  const countStmt = (sql) => db.prepare(sql).get().cnt;
  return {
    node_contents: countStmt(`
      SELECT COUNT(*) AS cnt FROM node_contents
      WHERE node_id NOT IN (SELECT node_id FROM learning_map_nodes)
    `),
    user_node_status: countStmt(`
      SELECT COUNT(*) AS cnt FROM user_node_status
      WHERE node_id NOT IN (SELECT node_id FROM learning_map_nodes)
    `),
    diagnosis_sessions: countStmt(`
      SELECT COUNT(*) AS cnt FROM diagnosis_sessions
      WHERE target_node_id NOT IN (SELECT node_id FROM learning_map_nodes)
    `),
    diagnosis_answers: countStmt(`
      SELECT COUNT(*) AS cnt FROM diagnosis_answers
      WHERE node_id NOT IN (SELECT node_id FROM learning_map_nodes)
    `),
    learning_paths: countStmt(`
      SELECT COUNT(*) AS cnt FROM learning_paths
      WHERE target_node_id NOT IN (SELECT node_id FROM learning_map_nodes)
    `),
    edges: countStmt(`
      SELECT COUNT(*) AS cnt FROM learning_map_edges
      WHERE from_node_id NOT IN (SELECT node_id FROM learning_map_nodes)
         OR to_node_id NOT IN (SELECT node_id FROM learning_map_nodes)
    `)
  };
}

// GET /api/admin/learning-map/orphans - 고아 참조 요약
router.get('/learning-map/orphans', ...adminOnly, (req, res) => {
  try {
    const orphans = countOrphanRefs();
    const total = Object.values(orphans).reduce((a, b) => a + b, 0);
    res.json({ success: true, orphans, total });
  } catch (err) {
    console.error('[ADMIN] learning-map/orphans error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/learning-map/cleanup-orphans - 고아 참조 정리
router.post('/learning-map/cleanup-orphans', ...adminOnly, (req, res) => {
  try {
    const dryRun = !!(req.body && (req.body.dry_run === true || req.body.dry_run === 'true'));
    if (dryRun) {
      const orphans = countOrphanRefs();
      return res.json({ success: true, dry_run: true, deleted: orphans });
    }
    // 삭제 전 개수
    const before = countOrphanRefs();
    const run = db.transaction(() => {
      db.prepare(`DELETE FROM node_contents
                  WHERE node_id NOT IN (SELECT node_id FROM learning_map_nodes)`).run();
      db.prepare(`DELETE FROM user_node_status
                  WHERE node_id NOT IN (SELECT node_id FROM learning_map_nodes)`).run();
      // diagnosis_answers: diagnosis_sessions 삭제 전에 먼저 처리
      db.prepare(`DELETE FROM diagnosis_answers
                  WHERE node_id NOT IN (SELECT node_id FROM learning_map_nodes)
                     OR session_id IN (
                       SELECT id FROM diagnosis_sessions
                       WHERE target_node_id NOT IN (SELECT node_id FROM learning_map_nodes)
                     )`).run();
      db.prepare(`DELETE FROM diagnosis_sessions
                  WHERE target_node_id NOT IN (SELECT node_id FROM learning_map_nodes)`).run();
      db.prepare(`DELETE FROM learning_paths
                  WHERE target_node_id NOT IN (SELECT node_id FROM learning_map_nodes)`).run();
      db.prepare(`DELETE FROM learning_map_edges
                  WHERE from_node_id NOT IN (SELECT node_id FROM learning_map_nodes)
                     OR to_node_id NOT IN (SELECT node_id FROM learning_map_nodes)`).run();
    });
    run();
    res.json({ success: true, dry_run: false, deleted: before });
  } catch (err) {
    console.error('[ADMIN] learning-map/cleanup-orphans error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ======== B-P0-5: 매핑 순서 swap (단일 트랜잭션) ========
// PUT /api/admin/learning-map/nodes/:nodeId/contents/swap
// body: { contentIdA, contentIdB } — 두 매핑의 sort_order를 원자적으로 교환
router.put('/learning-map/nodes/:nodeId/contents/swap', ...adminOnly, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const { contentIdA, contentIdB } = req.body || {};
    const a = parseInt(contentIdA), b = parseInt(contentIdB);
    if (!a || !b || a === b) return res.status(400).json({ success: false, message: 'contentIdA, contentIdB 필요' });

    const get = db.prepare('SELECT id, sort_order FROM node_contents WHERE node_id = ? AND content_id = ?');
    const upd = db.prepare('UPDATE node_contents SET sort_order = ? WHERE node_id = ? AND content_id = ?');
    const run = db.transaction(() => {
      const ra = get.get(nodeId, a);
      const rb = get.get(nodeId, b);
      if (!ra || !rb) throw Object.assign(new Error('매핑을 찾을 수 없습니다.'), { status: 404 });
      upd.run(rb.sort_order, nodeId, a);
      upd.run(ra.sort_order, nodeId, b);
      return { a: { content_id: a, sort_order: rb.sort_order }, b: { content_id: b, sort_order: ra.sort_order } };
    });
    const result = run();
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    if (status !== 404) console.error('[ADMIN] mapping swap error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// ======== B-P0-6: 일괄 매핑 추가 (트랜잭션) ========
// POST /api/admin/learning-map/mappings/bulk?dryRun=1
// body: { mappings: [{ nodeId, contentId, role?, sortOrder? }, ...] }
router.post('/learning-map/mappings/bulk', ...adminOnly, (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true' || req.body?.dry_run === true;
    const items = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
    if (items.length === 0) return res.status(400).json({ success: false, message: 'mappings 배열 필요' });
    if (items.length > 5000) return res.status(400).json({ success: false, message: '한 번에 최대 5000건까지 처리합니다.' });

    const stats = { total: items.length, inserted: 0, skipped_duplicate: 0, skipped_invalid_node: 0,
                    skipped_invalid_content: 0, skipped_non_lesson: 0, errors: [] };
    const inserted = [];

    const getNode = db.prepare('SELECT node_id, node_level FROM learning_map_nodes WHERE node_id = ?');
    const getContent = db.prepare('SELECT id, content_type FROM contents WHERE id = ?');
    const getDup = db.prepare('SELECT id FROM node_contents WHERE node_id = ? AND content_id = ?');
    const getMaxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS mx FROM node_contents WHERE node_id = ?');
    const insert = db.prepare('INSERT INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)');

    const run = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const nodeId = String(it.nodeId || it.node_id || '').trim();
        const cid = parseInt(it.contentId || it.content_id);
        if (!nodeId || !cid) { stats.errors.push(`#${i}: nodeId/contentId 누락`); continue; }

        const node = getNode.get(nodeId);
        if (!node) { stats.skipped_invalid_node++; continue; }
        if (node.node_level !== 3) { stats.skipped_non_lesson++; continue; }

        const content = getContent.get(cid);
        if (!content) { stats.skipped_invalid_content++; continue; }

        const dup = getDup.get(nodeId, cid);
        if (dup) { stats.skipped_duplicate++; continue; }

        let role = it.role || it.content_role;
        if (!role) {
          role = content.content_type === 'video' ? 'video'
               : PROBLEM_TYPES.includes(content.content_type) ? 'problem' : 'learn';
        }
        let order = it.sortOrder ?? it.sort_order;
        if (order === undefined || order === null || order === '') {
          order = (getMaxOrder.get(nodeId).mx || 0) + 1;
        }

        if (!dryRun) {
          const info = insert.run(nodeId, cid, role, parseInt(order));
          inserted.push({ id: info.lastInsertRowid, node_id: nodeId, content_id: cid, content_role: role, sort_order: parseInt(order) });
        } else {
          inserted.push({ node_id: nodeId, content_id: cid, content_role: role, sort_order: parseInt(order), dry_run: true });
        }
        stats.inserted++;
      }
      if (dryRun) {
        // 트랜잭션 롤백을 위해 의도적으로 throw — better-sqlite3 transaction 은 throw 시 자동 롤백
        const e = new Error('__DRY_RUN_ROLLBACK__'); e.__dry = true; throw e;
      }
    });
    try { run(); }
    catch (e) { if (!e.__dry) throw e; }

    res.json({ success: true, dry_run: dryRun, stats, inserted });
  } catch (err) {
    console.error('[ADMIN] mappings/bulk error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/learning-map/mappings/bulk - 일괄 삭제
// body: { ids: [mapping_id, ...] } 또는 { pairs: [{nodeId, contentId}, ...] }
router.delete('/learning-map/mappings/bulk', ...adminOnly, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n)).filter(Boolean) : [];
    const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
    if (ids.length === 0 && pairs.length === 0) return res.status(400).json({ success: false, message: 'ids 또는 pairs 필요' });

    const delById = db.prepare('DELETE FROM node_contents WHERE id = ?');
    const delByPair = db.prepare('DELETE FROM node_contents WHERE node_id = ? AND content_id = ?');
    let deleted = 0;
    const run = db.transaction(() => {
      for (const id of ids) deleted += delById.run(id).changes;
      for (const p of pairs) {
        const nodeId = String(p.nodeId || p.node_id || '');
        const cid = parseInt(p.contentId || p.content_id);
        if (nodeId && cid) deleted += delByPair.run(nodeId, cid).changes;
      }
    });
    run();
    res.json({ success: true, deleted });
  } catch (err) {
    console.error('[ADMIN] mappings/bulk DELETE error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ======== B-P0-7: AI 자동 매핑 추천 ========
// GET /api/admin/learning-map/auto-suggest?nodeId=X&type=video|question&limit=10
//  - 노드의 lesson_name / unit_name / achievement_code 토큰화 후 contents.title/tags/achievement_code 매칭 점수화
//  - 응답: { suggestions: [{contentId, score, reason, ...}], node }
const _STOP_TOKENS = new Set(['의','을','를','이','가','은','는','와','과','에','로','으로','및','등','한','하기','알기','구하기','이해','이해하기']);
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .replace(/[\(\)\[\]\{\}<>"'`~!@#$%^&*+=|\\\/?,.;:]/g, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && !_STOP_TOKENS.has(s));
}

router.get('/learning-map/auto-suggest', ...adminOnly, (req, res) => {
  try {
    const nodeId = (req.query.nodeId || '').toString().trim();
    const type = (req.query.type || '').toString().trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    if (!nodeId) return res.status(400).json({ success: false, message: 'nodeId 필요' });

    const node = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });

    const tokens = Array.from(new Set([
      ...tokenize(node.lesson_name),
      ...tokenize(node.unit_name),
      ...tokenize(node.achievement_text)
    ])).slice(0, 10);

    let typeWhere = '';
    if (type === 'video') typeWhere = ` AND c.content_type = 'video'`;
    else if (type === 'question' || type === 'problem') typeWhere = ` AND c.content_type IN ${PROBLEM_TYPES_SQL}`;

    // 이미 매핑된 콘텐츠는 제외
    const candidates = db.prepare(`
      SELECT c.id, c.title, c.content_type, c.subject, c.grade, c.tags, c.achievement_code, c.thumbnail_url, c.description, c.view_count
      FROM contents c
      WHERE c.is_public = 1 AND c.status = 'approved'
        ${typeWhere}
        AND c.id NOT IN (SELECT content_id FROM node_contents WHERE node_id = ?)
        ${node.subject ? 'AND (c.subject = ? OR c.subject = ?)' : ''}
        ${node.grade ? 'AND c.grade = ?' : ''}
      LIMIT 500
    `).all(...[
      nodeId,
      ...(node.subject ? [node.subject.replace(/과$/, ''), node.subject.replace(/과$/, '') + '과'] : []),
      ...(node.grade ? [node.grade] : [])
    ]);

    // 점수화: achievement_code 정확 일치 +5, lesson_name 토큰 매칭 +1/토큰, tags 매칭 +0.5/토큰
    const suggestions = [];
    for (const c of candidates) {
      let score = 0;
      const reasons = [];
      if (node.achievement_code && c.achievement_code === node.achievement_code) {
        score += 5;
        reasons.push(`성취기준 일치(${node.achievement_code})`);
      }
      const titleLow = (c.title || '').toLowerCase();
      const tagsLow = (c.tags || '').toLowerCase();
      const matched = [];
      for (const t of tokens) {
        const tl = t.toLowerCase();
        if (titleLow.includes(tl)) { score += 1; matched.push(t); }
        else if (tagsLow.includes(tl)) { score += 0.5; matched.push(t + '(tag)'); }
      }
      if (matched.length) reasons.push('키워드 ' + matched.join(','));
      if (score > 0) suggestions.push({
        contentId: c.id,
        score: Number(score.toFixed(2)),
        reason: reasons.join(' | '),
        title: c.title,
        content_type: c.content_type,
        thumbnail_url: c.thumbnail_url,
        achievement_code: c.achievement_code,
        view_count: c.view_count
      });
    }
    suggestions.sort((a, b) => b.score - a.score);
    res.json({
      success: true,
      node: { node_id: node.node_id, lesson_name: node.lesson_name, unit_name: node.unit_name, achievement_code: node.achievement_code },
      tokens,
      suggestions: suggestions.slice(0, limit),
      total_candidates: candidates.length
    });
  } catch (err) {
    console.error('[ADMIN] auto-suggest error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ======== B-P0-8: 매핑 CSV export / import ========
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function parseCsv(text) {
  // 단순 RFC4180 파서 (필드 따옴표 + 이스케이프 지원)
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c && c.length > 0));
}

// GET /api/admin/learning-map/mappings/export.csv?subject=&grade=
router.get('/learning-map/mappings/export.csv', ...adminOnly, (req, res) => {
  try {
    const { subject, grade } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (subject) { where += ' AND n.subject = ?'; params.push(subject); }
    if (grade) { where += ' AND n.grade = ?'; params.push(parseInt(grade)); }

    const rows = db.prepare(`
      SELECT nc.id AS mapping_id, nc.node_id, n.subject, n.grade, n.semester, n.unit_name, n.lesson_name,
             nc.content_id, c.content_type, c.title, nc.content_role, nc.sort_order
      FROM node_contents nc
      JOIN learning_map_nodes n ON nc.node_id = n.node_id
      JOIN contents c ON nc.content_id = c.id
      ${where}
      ORDER BY n.subject, n.grade, n.semester, n.sort_order, nc.sort_order
    `).all(...params);

    const header = ['mapping_id','node_id','subject','grade','semester','unit_name','lesson_name','content_id','content_type','title','content_role','sort_order'];
    const lines = [header.join(',')];
    for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(','));
    const body = '﻿' + lines.join('\r\n'); // UTF-8 BOM (Excel 호환)

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="learning-map-mappings-${Date.now()}.csv"`);
    res.send(body);
  } catch (err) {
    console.error('[ADMIN] mappings/export.csv error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/learning-map/mappings/import (multipart: file=csv, mode=append|replace, dryRun=1)
router.post('/learning-map/mappings/import', ...adminOnly, (req, res, next) => {
  learningMapUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });

    try {
      const dryRun = req.query.dryRun === '1' || req.body.dryRun === '1' || req.body.dry_run === 'true';
      const mode = (req.body.mode || 'append').toLowerCase() === 'replace' ? 'replace' : 'append';

      let rowsRaw;
      if (req.file && /\.(xlsx|xls)$/i.test(req.file.originalname)) {
        const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        rowsRaw = xlsx.utils.sheet_to_json(sheet, { defval: null });
      } else if (req.file) {
        const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
        const csv = parseCsv(text);
        if (csv.length < 2) return res.status(400).json({ success: false, message: 'CSV 헤더와 1행 이상 필요' });
        const header = csv[0].map(h => h.trim());
        rowsRaw = csv.slice(1).map(arr => {
          const o = {}; header.forEach((h, i) => o[h] = arr[i]); return o;
        });
      } else {
        return res.status(400).json({ success: false, message: '파일이 없습니다.' });
      }

      // node_id, content_id 컬럼 필수
      const stats = { total: rowsRaw.length, inserted: 0, replaced_groups: 0,
                      skipped_duplicate: 0, skipped_invalid_node: 0,
                      skipped_invalid_content: 0, skipped_non_lesson: 0, errors: [] };

      const getNode = db.prepare('SELECT node_id, node_level FROM learning_map_nodes WHERE node_id = ?');
      const getContent = db.prepare('SELECT id, content_type FROM contents WHERE id = ?');
      const getDup = db.prepare('SELECT id FROM node_contents WHERE node_id = ? AND content_id = ?');
      const insert = db.prepare('INSERT INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)');
      const deleteByNode = db.prepare('DELETE FROM node_contents WHERE node_id = ?');

      // replace 모드: import 안에서 등장하는 node_id 별로 기존 매핑을 일괄 삭제 후 재삽입
      const touchedNodes = new Set();

      const run = db.transaction(() => {
        if (mode === 'replace') {
          for (const r of rowsRaw) {
            const nid = String(r.node_id || r.nodeId || '').trim();
            if (nid) touchedNodes.add(nid);
          }
          if (!dryRun) {
            for (const nid of touchedNodes) {
              const info = deleteByNode.run(nid);
              if (info.changes > 0) stats.replaced_groups++;
            }
          } else {
            stats.replaced_groups = touchedNodes.size;
          }
        }

        for (let i = 0; i < rowsRaw.length; i++) {
          const r = rowsRaw[i];
          const nodeId = String(r.node_id || r.nodeId || '').trim();
          const cid = parseInt(r.content_id || r.contentId);
          if (!nodeId || !cid) { stats.errors.push(`row ${i+2}: node_id/content_id 누락`); continue; }
          const node = getNode.get(nodeId);
          if (!node) { stats.skipped_invalid_node++; continue; }
          if (node.node_level !== 3) { stats.skipped_non_lesson++; continue; }
          const content = getContent.get(cid);
          if (!content) { stats.skipped_invalid_content++; continue; }
          if (mode === 'append' && getDup.get(nodeId, cid)) { stats.skipped_duplicate++; continue; }
          let role = (r.content_role || r.role || '').toString().trim();
          if (!role) {
            role = content.content_type === 'video' ? 'video'
                 : PROBLEM_TYPES.includes(content.content_type) ? 'problem' : 'learn';
          }
          const order = parseInt(r.sort_order) || ((i % 1000) + 1);
          if (!dryRun) insert.run(nodeId, cid, role, order);
          stats.inserted++;
        }

        if (dryRun) {
          const e = new Error('__DRY_RUN_ROLLBACK__'); e.__dry = true; throw e;
        }
      });
      try { run(); } catch (e) { if (!e.__dry) throw e; }

      res.json({ success: true, dry_run: dryRun, mode, stats });
    } catch (err) {
      console.error('[ADMIN] mappings/import error:', err);
      res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
    }
  });
});

module.exports = router;
