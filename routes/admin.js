const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const authDb = require('../db/auth');
const db = require('../db/index');
// 소프트 삭제 계정 판정 정본 헬퍼 (술어 손복사 금지)
const classDb = require('../db/class');

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

// 보호 대상 seed 계정 — 시드 데이터 무결성을 위해 삭제·역할 변경 금지 (BUG-A-02)
const PROTECTED_USERNAMES = new Set(['admin', 'teacher1', 'student1', 'student2', 'student3', 'parent1', 'staff1']);
function isProtectedUser(userId) {
  try {
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    if (!row) return false;
    return PROTECTED_USERNAMES.has(row.username);
  } catch (e) {
    return false;
  }
}
function applyUserUpdate(userId, body) {
  const { role, status } = body || {};
  const fields = [];
  const params = [];
  if (role) {
    if (!['student', 'teacher', 'parent', 'staff', 'admin'].includes(role)) {
      return { ok: false, code: 400, message: '허용되지 않는 역할입니다.' };
    }
    fields.push('role = ?'); params.push(role);
  }
  if (status) {
    if (!['active', 'inactive', 'suspended', 'deleted'].includes(status)) {
      return { ok: false, code: 400, message: '허용되지 않는 상태입니다.' };
    }
    fields.push('status = ?'); params.push(status);
  }
  if (fields.length === 0) return { ok: true, message: '변경 사항이 없습니다.' };
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return { ok: true, user: authDb.findUserById(userId) };
}

// PUT /api/admin/users/:id - 사용자 정보 수정 (역할, 상태)
router.put('/users/:id', ...adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (isProtectedUser(userId) && req.body && req.body.role) {
      return res.status(403).json({ success: false, message: '기본 계정의 역할은 변경할 수 없습니다.' });
    }
    const result = applyUserUpdate(userId, req.body);
    if (!result.ok) return res.status(result.code || 400).json({ success: false, message: result.message });
    res.json({ success: true, user: result.user, message: result.message });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/users/:id/role - 사용자 역할만 변경 (UI 별칭 라우트, BUG-T-06)
router.put('/users/:id/role', ...adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ success: false, message: '역할(role)을 지정해야 합니다.' });
    if (isProtectedUser(userId)) {
      return res.status(403).json({ success: false, message: '기본 계정의 역할은 변경할 수 없습니다.' });
    }
    const result = applyUserUpdate(userId, { role });
    if (!result.ok) return res.status(result.code || 400).json({ success: false, message: result.message });
    res.json({ success: true, user: result.user, message: '역할이 변경되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/users/:id - 사용자 삭제 (소프트 삭제, BUG-A-02)
// FK 제약 위반을 피하기 위해 row 삭제 대신 deleted_at 시각을 설정.
// 인증·목록 조회에서 자동으로 제외되며, 과거 활동 기록(작성 글·로그 등)은 그대로 보존.
router.delete('/users/:id', ...adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: '잘못된 사용자 ID입니다.' });
    if (userId === req.user.id) {
      return res.status(400).json({ success: false, message: '자기 자신은 삭제할 수 없습니다.' });
    }
    const target = db.prepare('SELECT id, username, deleted_at FROM users WHERE id = ?').get(userId);
    if (!target) return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    if (PROTECTED_USERNAMES.has(target.username)) {
      return res.status(403).json({ success: false, message: '기본 계정(admin·teacher1·student1 등)은 삭제할 수 없습니다.' });
    }
    if (target.deleted_at) {
      return res.json({ success: true, message: '이미 삭제된 사용자입니다.' });
    }
    db.prepare("UPDATE users SET deleted_at = CURRENT_TIMESTAMP, status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(userId);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[admin] 사용자 삭제 실패:', err);
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
    // classes 테이블의 소유자 컬럼은 owner_id (created_by 아님 — 스키마 실측).
    // 소유자가 삭제된 클래스도 누락되지 않도록 LEFT JOIN 사용.
    // member_count 규약(2026-08-07):
    //   · cm.status='active'  → 강퇴(removed)·탈퇴(left)·초대중(invited)은 멤버가 아니다.
    //     (이전에는 status 를 아예 안 봐서 탈퇴자·초대중까지 셌다 — 어느 규약으로도 오답)
    //   · liveUserSql        → 로그인 불가능한 소프트 삭제 계정 제외. 상세 명단인
    //     classDb.getClassMembers() 가 이미 삭제 계정을 빼므로, 빼지 않으면 카드≠내역.
    //   · 역할 조건 없음     → 개설자·학부모·교직원도 클래스 멤버이므로 그대로 센다.
    //     ⚠ 여기에 u.role='student' 를 넣지 말 것 (사용자 결정).
    const classes = db.prepare(`
      SELECT c.*, u.display_name as creator_name,
        (SELECT COUNT(*) FROM class_members m JOIN users mu ON mu.id = m.user_id
          WHERE m.class_id = c.id AND m.status = 'active'
            AND ${classDb.liveUserSql('mu')}) as member_count
      FROM classes c LEFT JOIN users u ON c.owner_id = u.id
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
    db.prepare("UPDATE contents SET status = 'approved' WHERE id = ?").run(parseInt(req.params.id));
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
      // ※ 진실의 원천(SSOT)은 `통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx` 임.
      //   KOFAC v2 엑셀도 시트명(`학습맵_리니어연결`)·컬럼 구조(2단계ID·교과·과목·학년·내용체계영역·
      //   1~3단계내용요소·3단계ID·단원명·적용학년·적용학기·선수학습ID·후속학습ID·성취기준코드·성취기준)가
      //   동일하므로 본 업로드 파서를 그대로 사용한다. (확인일 2026-05-27)
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

        // 3차 패스: 차시 엣지 (선수학습ID·후속학습ID 양방향) + 파생된 단원 엣지
        const unitEdgeSeen = new Set(); // "unitA->unitB"
        const addLessonEdge = (fromId, toId) => {
          if (!fromId || !toId || fromId === toId) return;
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
        };
        rows.forEach((row, idx) => {
          try {
            const currentId = row['3단계ID'] ? String(row['3단계ID']).trim() : '';
            if (!currentId) return;
            // 선수학습ID → 현재 3단계ID
            const prereqs = splitIds(row['선수학습ID']);
            prereqs.forEach(fromId => addLessonEdge(fromId, currentId));
            // 현재 3단계ID → 후속학습ID (엑셀 후속학습ID 컬럼은 본행이 선수가 됨)
            const nexts = splitIds(row['후속학습ID']);
            nexts.forEach(toId => addLessonEdge(currentId, toId));
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

// ============================================================================
//  추천콘텐츠 큐레이션 — spec_admin_featured_curation.md D-2
// ============================================================================
const featuredDb = require('../db/featured');

// GET /api/admin/featured/sections — 섹션 목록 + 슬롯 갯수 + PERIOD_OVERLAP 경고
router.get('/featured/sections', ...adminOnly, (req, res) => {
  try {
    const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
    // includeWarnings=true 로 사전 PERIOD_OVERLAP 검출 결과를 각 row에 포함
    const sections = featuredDb.listSections({ activeOnly, includeWarnings: true });
    res.json({ success: true, sections });
  } catch (err) {
    console.error('[ADMIN] featured/sections list error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/featured/sections — 같은 key에 새 발행 row 생성 (다중 발행 허용)
router.post('/featured/sections', ...adminOnly, (req, res) => {
  try {
    const r = featuredDb.createSection(req.body || {}, req.user.id);
    if (!r.ok) {
      return res.status(400).json({ success: false, code: r.code || 'INVALID_PAYLOAD', message: r.message || '요청을 처리하지 못했습니다.' });
    }
    res.status(201).json({ success: true, section: r.section, warnings: r.warnings || [] });
  } catch (err) {
    console.error('[ADMIN] featured/sections POST error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// PATCH /api/admin/featured/sections/reorder — 섹션 순서 일괄 갱신 (** 동적 :id 보다 위에 두어야 함 **)
router.patch('/featured/sections/reorder', ...adminOnly, (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) {
      return res.status(400).json({ success: false, code: 'INVALID_PAYLOAD', message: '요청 본문이 올바르지 않습니다.' });
    }
    const r = featuredDb.reorderSections(order, req.user.id);
    if (!r.ok) return res.status(400).json({ success: false, code: r.code || 'INVALID_PAYLOAD', message: '요청을 처리하지 못했습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] featured/sections/reorder error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// PATCH /api/admin/featured/sections/:id — 부분 갱신
router.patch('/featured/sections/:id', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, code: 'INVALID_PAYLOAD', message: 'id가 올바르지 않습니다.' });

    const r = featuredDb.updateSection(id, req.body || {}, req.user.id);
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') return res.status(404).json({ success: false, code: 'NOT_FOUND', message: '섹션이 존재하지 않습니다.' });
      if (r.code === 'STALE_UPDATE') return res.status(409).json({ success: false, code: 'STALE_UPDATE', message: '다른 관리자가 먼저 수정했습니다. 새로고침 후 다시 시도해주세요.' });
      return res.status(400).json({ success: false, code: r.code || 'INVALID_PAYLOAD', message: r.message || '요청을 처리하지 못했습니다.' });
    }
    res.json({ success: true, section: r.section, warnings: r.warnings || [] });
  } catch (err) {
    console.error('[ADMIN] featured/sections PATCH error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/featured/sections/:id/items — 섹션 슬롯 목록 (admin 뷰)
router.get('/featured/sections/:id/items', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const section = featuredDb.getSection(id);
    if (!section) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: '섹션이 존재하지 않습니다.' });
    const items = featuredDb.listSectionItems(id);
    res.json({ success: true, section, items });
  } catch (err) {
    console.error('[ADMIN] featured/sections/:id/items error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/featured/sections/:id/items — 슬롯 추가 (끝에 붙임)
router.post('/featured/sections/:id/items', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { item_type, item_id, badge_label, note } = req.body || {};
    if (!item_type || !item_id) {
      return res.status(400).json({ success: false, code: 'INVALID_PAYLOAD', message: 'item_type과 item_id가 필요합니다.' });
    }
    const r = featuredDb.addSectionItem(id, item_type, parseInt(item_id, 10), { badge_label, note }, req.user.id);
    if (!r.ok) {
      const status = r.code === 'DUPLICATE' ? 409 : (r.code === 'NOT_FOUND' ? 404 : 400);
      return res.status(status).json({ success: false, code: r.code || 'INVALID_PAYLOAD', message: r.message || '요청을 처리하지 못했습니다.' });
    }
    res.status(201).json({ success: true, item: r.item });
  } catch (err) {
    console.error('[ADMIN] featured/sections/:id/items POST error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// PATCH /api/admin/featured/items/reorder — 슬롯 순서 일괄 갱신
router.patch('/featured/items/reorder', ...adminOnly, (req, res) => {
  try {
    const { section_id, order } = req.body || {};
    if (!section_id || !Array.isArray(order)) {
      return res.status(400).json({ success: false, code: 'INVALID_PAYLOAD', message: 'section_id와 order가 필요합니다.' });
    }
    const r = featuredDb.reorderItems(parseInt(section_id, 10), order);
    if (!r.ok) {
      return res.status(400).json({ success: false, code: r.code || 'INVALID_PAYLOAD', message: r.message || '요청을 처리하지 못했습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] featured/items/reorder error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/featured/items/:itemId — 슬롯 제거
router.delete('/featured/items/:itemId', ...adminOnly, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId, 10);
    const r = featuredDb.removeSectionItem(itemId);
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') return res.status(404).json({ success: false, code: 'NOT_FOUND', message: '슬롯이 존재하지 않습니다.' });
      return res.status(400).json({ success: false, code: r.code || 'INVALID_PAYLOAD', message: '요청을 처리하지 못했습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] featured/items DELETE error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/featured/sections/:id — 발행(섹션 row) 삭제 (시드 4행 보호)
router.delete('/featured/sections/:id', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = featuredDb.deleteSection(id);
    if (!r.ok) {
      const status = r.code === 'NOT_FOUND' ? 404 : (r.code === 'PROTECTED_SEED' ? 403 : 400);
      return res.status(status).json({ success: false, code: r.code, message: r.message });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] featured/sections DELETE error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/featured/sections/:id/preview-audience — 현재 설정 기준 노출 대상 사용자 수 추정
router.get('/featured/sections/:id/preview-audience', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const section = featuredDb.getSection(id);
    if (!section) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: '섹션이 존재하지 않습니다.' });

    const db = require('../db/index');
    const tRoles = section.target_roles;     // 'all' or array
    const tLevels = section.target_school_levels;

    const where = [];
    const params = [];
    if (tRoles === 'all') {
      // 전체 역할 — 추가 조건 없음
    } else if (Array.isArray(tRoles) && tRoles.length > 0) {
      const ph = tRoles.map(() => '?').join(',');
      where.push(`role IN (${ph})`);
      params.push(...tRoles);
    }
    if (tLevels === 'all') {
      // 전체 학교급 — 추가 조건 없음
    } else if (Array.isArray(tLevels) && tLevels.length > 0) {
      const ph = tLevels.map(() => '?').join(',');
      where.push(`(school_level IN (${ph}))`);
      params.push(...tLevels);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM users ${whereSql}`).get(...params);
    res.json({
      success: true,
      section_id: id,
      audience_estimate: row?.cnt || 0,
      target_roles: tRoles,
      target_school_levels: tLevels,
      status_derived: section.status_derived,
      isPublishedNow: section.isPublishedNow
    });
  } catch (err) {
    console.error('[ADMIN] featured/sections/:id/preview-audience error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/admin/featured/search — 큐레이션 모달용 검색 (콘텐츠/채널)
router.get('/featured/search', ...adminOnly, (req, res) => {
  try {
    const result = featuredDb.searchForCuration({
      type: req.query.type || 'content',
      q: req.query.q || '',
      subject: req.query.subject || null,
      grade: req.query.grade ? parseInt(req.query.grade, 10) : null,
      content_type: req.query.content_type || null,
      page: parseInt(req.query.page, 10) || 1,
      pageSize: parseInt(req.query.pageSize, 10) || 12,
      section_id: req.query.section_id ? parseInt(req.query.section_id, 10) : null
    });
    res.json(result);
  } catch (err) {
    console.error('[ADMIN] featured/search error:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: '서버 오류가 발생했습니다.' });
  }
});

// =========================================================================
// 채움콘텐츠 추천 키워드 관리 (관리자 전용 CRUD)
// 공개 GET 엔드포인트는 routes/content.js 의 GET /api/contents/suggested-keywords
// =========================================================================

function _normalizeKw(s) {
  return typeof s === 'string' ? s.trim() : '';
}

// 추천 키워드 대상별 노출 화이트리스트
// (featured_sections 패턴과 동일 — db/featured.js 의 ALLOWED_* 상수와 동치)
const SK_ALLOWED_SCHOOL_LEVELS = ['elementary', 'middle', 'high'];
const SK_ALLOWED_ROLES = ['student', 'teacher', 'parent', 'staff', 'admin'];
const SK_ALLOWED_SUBJECTS = ['국어', '수학', '사회', '과학', '영어', '음악', '미술', '체육', '실과', '도덕', '통합'];

/**
 * 입력값을 정규화 → JSON 문자열(저장용) 또는 NULL 반환.
 * - undefined: undefined 반환 (= 변경 없음 — 호출자가 처리)
 * - null / 'all' / [] : null 반환 (= 전체 대상)
 * - 배열: 화이트리스트로 정제 후 JSON.stringify, 빈 배열 되면 null
 * - 잘못된 값: { error: '메시지' } 반환
 */
function _stringifyTargetArray(value, allowed, fieldLabel, opts = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === 'all') return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const cleaned = [];
    const invalid = [];
    for (const raw of value) {
      const v = opts.parseInt ? parseInt(raw, 10) : (typeof raw === 'string' ? raw.trim() : raw);
      if (opts.parseInt) {
        if (!Number.isInteger(v) || v < 1 || v > 12) {
          invalid.push(String(raw));
          continue;
        }
        cleaned.push(v);
      } else {
        if (!allowed.includes(v)) {
          invalid.push(String(raw));
          continue;
        }
        cleaned.push(v);
      }
    }
    if (invalid.length > 0) {
      return { error: `${fieldLabel} 값이 올바르지 않습니다 (허용: ${opts.parseInt ? '1~12 정수' : allowed.join(', ')}).` };
    }
    if (cleaned.length === 0) return null;
    // 중복 제거
    const uniq = Array.from(new Set(cleaned));
    return JSON.stringify(uniq);
  }
  return { error: `${fieldLabel} 값은 배열이어야 합니다.` };
}

/**
 * DB row 의 target_* TEXT(JSON 또는 NULL) → JS 배열(또는 빈 배열)로 변환.
 * 응답 직렬화 용.
 */
function _parseTargetArray(text) {
  if (text === null || text === undefined || text === '') return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** suggested_keyword row 직렬화 — 4개 target_* 컬럼을 JS 배열로 변환해서 추가 */
function _serializeKeyword(row) {
  if (!row) return row;
  return {
    ...row,
    target_school_levels: _parseTargetArray(row.target_school_levels),
    target_roles:         _parseTargetArray(row.target_roles),
    target_grades:        _parseTargetArray(row.target_grades),
    target_subjects:      _parseTargetArray(row.target_subjects),
  };
}

/**
 * 입력 카테고리 이름이 마스터에 없으면 자동 생성하고, 마스터에 있으면 그대로 사용.
 * (suggested_kw_categories 테이블이 존재하지 않으면 no-op — 마이그레이션 미적용 환경 폴백)
 *
 * 정확히 일치하는 name 이 마스터에 있으면 그대로 반환.
 * 없으면 INSERT (slug 자동 생성, 디폴트 색·아이콘) 후 반환.
 */
function _ensureCategoryMasterRow(categoryName, createdBy) {
  if (!categoryName) return;
  // 테이블 존재 확인 (없으면 no-op)
  const tbl = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='suggested_kw_categories'`
  ).get();
  if (!tbl) return;

  const found = db.prepare('SELECT id, name FROM suggested_kw_categories WHERE name = ?').get(categoryName);
  if (found) return; // 이미 있음

  // 자동 생성
  let slug = (() => {
    const s = String(categoryName || '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return s;
  })();
  if (!slug) slug = 'cat-' + Date.now();

  // slug 충돌 시 suffix
  let suffix = 0;
  let trySlug = slug;
  while (db.prepare('SELECT id FROM suggested_kw_categories WHERE slug = ?').get(trySlug)) {
    suffix++;
    trySlug = `${slug}-${suffix}`;
    if (suffix > 50) break;
  }
  slug = trySlug;

  const last = db.prepare(`SELECT MAX(display_order) AS m FROM suggested_kw_categories`).get();
  const displayOrder = ((last && last.m) || 0) + 100;

  try {
    db.prepare(`
      INSERT INTO suggested_kw_categories
        (name, slug, description, display_order, color, icon, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, NULL, ?, '#2563eb', 'fa-bookmark', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(categoryName, slug, displayOrder, createdBy || null);
  } catch (e) {
    // 동시성으로 인해 그 사이 들어왔다면 무시
    console.warn('[ADMIN] _ensureCategoryMasterRow insert skipped:', e.message);
  }
}

// GET /api/admin/suggested-keywords — 전체 목록(비활성 포함)
router.get('/suggested-keywords', ...adminOnly, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, keyword, COALESCE(category, '기타') AS category,
             search_query, description, display_order, is_active,
             target_school_levels, target_roles, target_grades, target_subjects,
             created_by, created_at, updated_at
      FROM suggested_keywords
      ORDER BY is_active DESC, display_order ASC, id ASC
    `).all();
    const serialized = rows.map(_serializeKeyword);
    res.json({ success: true, keywords: serialized, total: serialized.length });
  } catch (err) {
    console.error('[ADMIN] suggested-keywords list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/suggested-keywords — 신규 추가
router.post('/suggested-keywords', ...adminOnly, (req, res) => {
  try {
    const keyword = _normalizeKw(req.body.keyword);
    const category = _normalizeKw(req.body.category) || '기타';
    const searchQuery = _normalizeKw(req.body.search_query) || keyword;
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : null;
    const displayOrderRaw = req.body.display_order;
    const isActiveRaw = req.body.is_active;

    if (!keyword) {
      return res.status(400).json({ success: false, message: '키워드를 입력하세요.' });
    }
    if (keyword.length > 60) {
      return res.status(400).json({ success: false, message: '키워드는 60자 이내로 입력하세요.' });
    }
    if (category.length > 40) {
      return res.status(400).json({ success: false, message: '카테고리는 40자 이내로 입력하세요.' });
    }

    // display_order 미지정 시 같은 카테고리 마지막 순서 + 10
    let displayOrder;
    if (displayOrderRaw !== undefined && displayOrderRaw !== null && displayOrderRaw !== '') {
      displayOrder = parseInt(displayOrderRaw, 10);
      if (Number.isNaN(displayOrder)) displayOrder = 0;
    } else {
      const last = db.prepare(
        `SELECT MAX(display_order) AS m FROM suggested_keywords WHERE category = ?`
      ).get(category);
      displayOrder = ((last && last.m) || 0) + 10;
    }

    const isActive = (isActiveRaw === 0 || isActiveRaw === '0' || isActiveRaw === false) ? 0 : 1;

    // 대상별 노출 4개 컬럼 (모두 선택사항 — 미지정/null/[]/['all']은 NULL=전체)
    const tLevels   = _stringifyTargetArray(req.body.target_school_levels, SK_ALLOWED_SCHOOL_LEVELS, 'target_school_levels');
    if (tLevels && typeof tLevels === 'object' && tLevels.error) {
      return res.status(400).json({ success: false, message: tLevels.error });
    }
    const tRoles    = _stringifyTargetArray(req.body.target_roles, SK_ALLOWED_ROLES, 'target_roles');
    if (tRoles && typeof tRoles === 'object' && tRoles.error) {
      return res.status(400).json({ success: false, message: tRoles.error });
    }
    const tGrades   = _stringifyTargetArray(req.body.target_grades, null, 'target_grades', { parseInt: true });
    if (tGrades && typeof tGrades === 'object' && tGrades.error) {
      return res.status(400).json({ success: false, message: tGrades.error });
    }
    const tSubjects = _stringifyTargetArray(req.body.target_subjects, SK_ALLOWED_SUBJECTS, 'target_subjects');
    if (tSubjects && typeof tSubjects === 'object' && tSubjects.error) {
      return res.status(400).json({ success: false, message: tSubjects.error });
    }
    // undefined → null (신규 생성 시 미지정은 NULL=전체)
    const finalLevels   = tLevels   === undefined ? null : tLevels;
    const finalRoles    = tRoles    === undefined ? null : tRoles;
    const finalGrades   = tGrades   === undefined ? null : tGrades;
    const finalSubjects = tSubjects === undefined ? null : tSubjects;

    // 카테고리 마스터에 없으면 자동 생성 (기획서 섹션 4: 정합성)
    _ensureCategoryMasterRow(category, req.user.id);

    let info;
    try {
      info = db.prepare(`
        INSERT INTO suggested_keywords
          (keyword, category, search_query, description, display_order, is_active,
           target_school_levels, target_roles, target_grades, target_subjects,
           created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        keyword, category, searchQuery, description, displayOrder, isActive,
        finalLevels, finalRoles, finalGrades, finalSubjects,
        req.user.id
      );
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ success: false, message: '이미 등록된 키워드입니다.' });
      }
      throw e;
    }

    const createdRow = db.prepare('SELECT * FROM suggested_keywords WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ success: true, keyword: _serializeKeyword(createdRow) });
  } catch (err) {
    console.error('[ADMIN] suggested-keywords create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/suggested-keywords/:id — 수정
router.put('/suggested-keywords/:id', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });

    const existing = db.prepare('SELECT * FROM suggested_keywords WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, message: '키워드를 찾을 수 없습니다.' });

    const fields = [];
    const params = [];

    if (req.body.keyword !== undefined) {
      const kw = _normalizeKw(req.body.keyword);
      if (!kw) return res.status(400).json({ success: false, message: '키워드를 입력하세요.' });
      if (kw.length > 60) return res.status(400).json({ success: false, message: '키워드는 60자 이내로 입력하세요.' });
      fields.push('keyword = ?'); params.push(kw);
    }
    if (req.body.category !== undefined) {
      const cat = _normalizeKw(req.body.category) || '기타';
      if (cat.length > 40) return res.status(400).json({ success: false, message: '카테고리는 40자 이내로 입력하세요.' });
      // 카테고리 마스터에 없으면 자동 생성 (기획서 섹션 4: 정합성)
      _ensureCategoryMasterRow(cat, req.user.id);
      fields.push('category = ?'); params.push(cat);
    }
    if (req.body.search_query !== undefined) {
      const sq = _normalizeKw(req.body.search_query);
      fields.push('search_query = ?'); params.push(sq || null);
    }
    if (req.body.description !== undefined) {
      const desc = typeof req.body.description === 'string' ? req.body.description.trim() : null;
      fields.push('description = ?'); params.push(desc);
    }
    if (req.body.display_order !== undefined && req.body.display_order !== null && req.body.display_order !== '') {
      const ord = parseInt(req.body.display_order, 10);
      if (Number.isNaN(ord)) return res.status(400).json({ success: false, message: '정렬 순서는 정수여야 합니다.' });
      fields.push('display_order = ?'); params.push(ord);
    }
    if (req.body.is_active !== undefined) {
      const v = req.body.is_active;
      const isActive = (v === 0 || v === '0' || v === false) ? 0 : 1;
      fields.push('is_active = ?'); params.push(isActive);
    }

    // 대상별 노출 4개 컬럼 — 명시적으로 보낸 경우만 갱신
    const targetSpecs = [
      { key: 'target_school_levels', allowed: SK_ALLOWED_SCHOOL_LEVELS, label: 'target_school_levels', opts: {} },
      { key: 'target_roles',         allowed: SK_ALLOWED_ROLES,         label: 'target_roles',         opts: {} },
      { key: 'target_grades',        allowed: null,                     label: 'target_grades',        opts: { parseInt: true } },
      { key: 'target_subjects',      allowed: SK_ALLOWED_SUBJECTS,      label: 'target_subjects',      opts: {} },
    ];
    for (const spec of targetSpecs) {
      if (req.body[spec.key] === undefined) continue;
      const norm = _stringifyTargetArray(req.body[spec.key], spec.allowed, spec.label, spec.opts);
      if (norm && typeof norm === 'object' && norm.error) {
        return res.status(400).json({ success: false, message: norm.error });
      }
      // norm: null(=전체) 또는 JSON 문자열
      fields.push(`${spec.key} = ?`);
      params.push(norm === undefined ? null : norm);
    }

    if (fields.length === 0) {
      return res.json({ success: true, keyword: _serializeKeyword(existing), message: '변경 사항이 없습니다.' });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    try {
      db.prepare(`UPDATE suggested_keywords SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ success: false, message: '이미 등록된 키워드입니다.' });
      }
      throw e;
    }

    const updatedRow = db.prepare('SELECT * FROM suggested_keywords WHERE id = ?').get(id);
    res.json({ success: true, keyword: _serializeKeyword(updatedRow) });
  } catch (err) {
    console.error('[ADMIN] suggested-keywords update error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/suggested-keywords/:id — 삭제 (기본 hard delete, soft=1 시 비활성화)
router.delete('/suggested-keywords/:id', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });

    const existing = db.prepare('SELECT id FROM suggested_keywords WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, message: '키워드를 찾을 수 없습니다.' });

    const soft = req.query.soft === '1' || req.body?.soft === true || req.body?.soft === 1;
    if (soft) {
      db.prepare(`UPDATE suggested_keywords SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
      return res.json({ success: true, deleted: false, deactivated: true });
    }
    db.prepare(`DELETE FROM suggested_keywords WHERE id = ?`).run(id);
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('[ADMIN] suggested-keywords delete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/suggested-keywords/reorder — 순서 변경 (id 배열 순으로 10단위 재부여)
// body: { ids: [id1, id2, ...], category?: string, base?: number, step?: number }
router.post('/suggested-keywords/reorder', ...adminOnly, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(v => parseInt(v, 10)).filter(Number.isInteger) : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids 배열이 필요합니다.' });
    }
    const base = Number.isInteger(parseInt(req.body.base, 10)) ? parseInt(req.body.base, 10) : 10;
    const step = Number.isInteger(parseInt(req.body.step, 10)) ? parseInt(req.body.step, 10) : 10;
    const category = typeof req.body.category === 'string' ? req.body.category.trim() : null;

    const updateStmt = db.prepare(`
      UPDATE suggested_keywords
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? ${category ? 'AND category = ?' : ''}
    `);

    let updated = 0;
    const tx = db.transaction((list) => {
      list.forEach((id, idx) => {
        const order = base + idx * step;
        const args = category ? [order, id, category] : [order, id];
        const r = updateStmt.run(...args);
        if (r.changes > 0) updated++;
      });
    });
    tx(ids);

    res.json({ success: true, updated, total: ids.length });
  } catch (err) {
    console.error('[ADMIN] suggested-keywords reorder error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// =========================================================================
// 추천 키워드 카테고리 마스터 (관리자 전용 CRUD)
// 기획서: 작업지시서/추천키워드_카테고리CRUD_및_다줄노출_기획서.md (섹션 A·B.8)
// 라우트 경로: /api/admin/kw-categories
// =========================================================================

// 색상 hex (#RRGGBB) 검증 — 6자리 hex 만 허용
const SKC_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// slug — 영문 소문자·숫자·하이픈만 (1~30자)
const SKC_SLUG_RE = /^[a-z0-9-]{1,30}$/;
// Font Awesome 클래스명 — `fa-` 접두 + 영문 소문자·숫자·하이픈
const SKC_ICON_RE = /^fa-[a-z0-9-]+$/;

/** 입력 name 으로부터 ASCII slug 추정 — 공백 → 하이픈, 소문자, 영문/숫자/하이픈 외 제거 */
function _autoSlugFromName(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

/** 카테고리 row 직렬화 — target_* 4컬럼을 JS 배열로 변환 */
function _serializeCategory(row) {
  if (!row) return row;
  return {
    ...row,
    target_school_levels: _parseTargetArray(row.target_school_levels),
    target_roles:         _parseTargetArray(row.target_roles),
    target_grades:        _parseTargetArray(row.target_grades),
    target_subjects:      _parseTargetArray(row.target_subjects),
  };
}

// GET /api/admin/kw-categories — 전체 목록(비활성 포함) + 카테고리별 키워드 수
router.get('/kw-categories', ...adminOnly, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.slug, c.description, c.display_order, c.color, c.icon, c.is_active,
             c.target_school_levels, c.target_roles, c.target_grades, c.target_subjects,
             c.created_by, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM suggested_keywords k WHERE k.category = c.name) AS keyword_count
      FROM suggested_kw_categories c
      ORDER BY c.is_active DESC, c.display_order ASC, c.id ASC
    `).all();
    const serialized = rows.map(_serializeCategory);
    res.json({ success: true, categories: serialized, total: serialized.length });
  } catch (err) {
    console.error('[ADMIN] kw-categories list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/kw-categories — 신규 추가
router.post('/kw-categories', ...adminOnly, (req, res) => {
  try {
    const name = _normalizeKw(req.body.name);
    if (!name) {
      return res.status(400).json({ success: false, message: '카테고리 이름을 입력해 주세요.' });
    }
    if (name.length < 1 || name.length > 30) {
      return res.status(400).json({ success: false, message: '카테고리 이름은 1~30자로 입력해 주세요.' });
    }

    // slug — 미입력 시 name으로부터 자동 생성. 단, 한글 등 비-ASCII 문자가
    // 포함된 경우 ASCII 추출 결과가 무의미하므로 cat-{ts} 폴백 사용 (기획서 L-1).
    let slug = _normalizeKw(req.body.slug);
    if (!slug) {
      const hasNonAscii = /[^\x00-\x7F]/.test(name || '');
      if (hasNonAscii) {
        slug = 'cat-' + Date.now();
      } else {
        slug = _autoSlugFromName(name);
        if (!slug) slug = 'cat-' + Date.now();
      }
    }
    if (!SKC_SLUG_RE.test(slug)) {
      return res.status(400).json({ success: false, message: 'Slug는 영문 소문자·숫자·하이픈(-)만 쓸 수 있어요.' });
    }

    const description = typeof req.body.description === 'string' ? req.body.description.trim() : null;

    let color = typeof req.body.color === 'string' ? req.body.color.trim() : '#2563eb';
    if (!SKC_COLOR_RE.test(color)) {
      return res.status(400).json({ success: false, message: '색상은 #RRGGBB 형식의 hex로 입력해 주세요.' });
    }
    color = color.toLowerCase();

    let icon = typeof req.body.icon === 'string' ? req.body.icon.trim() : 'fa-bookmark';
    if (!icon) icon = 'fa-bookmark';
    if (!SKC_ICON_RE.test(icon)) {
      return res.status(400).json({ success: false, message: '아이콘은 fa-xxx 형식의 Font Awesome 클래스명으로 입력해 주세요.' });
    }

    // display_order 미지정 시 MAX + 100 (기획서 B.3)
    let displayOrder;
    const ordRaw = req.body.display_order;
    if (ordRaw !== undefined && ordRaw !== null && ordRaw !== '') {
      displayOrder = parseInt(ordRaw, 10);
      if (Number.isNaN(displayOrder)) {
        return res.status(400).json({ success: false, message: '정렬 순서는 정수여야 합니다.' });
      }
    } else {
      const last = db.prepare(`SELECT MAX(display_order) AS m FROM suggested_kw_categories`).get();
      displayOrder = ((last && last.m) || 0) + 100;
    }

    const isActiveRaw = req.body.is_active;
    const isActive = (isActiveRaw === 0 || isActiveRaw === '0' || isActiveRaw === false) ? 0 : 1;

    // 노출 대상 4컬럼 (키워드와 동일 패턴)
    const tLevels   = _stringifyTargetArray(req.body.target_school_levels, SK_ALLOWED_SCHOOL_LEVELS, 'target_school_levels');
    if (tLevels && typeof tLevels === 'object' && tLevels.error) {
      return res.status(400).json({ success: false, message: tLevels.error });
    }
    const tRoles    = _stringifyTargetArray(req.body.target_roles, SK_ALLOWED_ROLES, 'target_roles');
    if (tRoles && typeof tRoles === 'object' && tRoles.error) {
      return res.status(400).json({ success: false, message: tRoles.error });
    }
    const tGrades   = _stringifyTargetArray(req.body.target_grades, null, 'target_grades', { parseInt: true });
    if (tGrades && typeof tGrades === 'object' && tGrades.error) {
      return res.status(400).json({ success: false, message: tGrades.error });
    }
    const tSubjects = _stringifyTargetArray(req.body.target_subjects, SK_ALLOWED_SUBJECTS, 'target_subjects');
    if (tSubjects && typeof tSubjects === 'object' && tSubjects.error) {
      return res.status(400).json({ success: false, message: tSubjects.error });
    }
    const finalLevels   = tLevels   === undefined ? null : tLevels;
    const finalRoles    = tRoles    === undefined ? null : tRoles;
    const finalGrades   = tGrades   === undefined ? null : tGrades;
    const finalSubjects = tSubjects === undefined ? null : tSubjects;

    let info;
    try {
      info = db.prepare(`
        INSERT INTO suggested_kw_categories
          (name, slug, description, display_order, color, icon, is_active,
           target_school_levels, target_roles, target_grades, target_subjects,
           created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        name, slug, description, displayOrder, color, icon, isActive,
        finalLevels, finalRoles, finalGrades, finalSubjects,
        req.user.id
      );
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('UNIQUE') && msg.includes('name')) {
        return res.status(409).json({ success: false, message: '같은 이름의 카테고리가 이미 있어요. 다른 이름을 써 주세요.' });
      }
      if (msg.includes('UNIQUE') && msg.includes('slug')) {
        return res.status(409).json({ success: false, message: '같은 slug의 카테고리가 이미 있어요. 다른 slug를 써 주세요.' });
      }
      throw e;
    }

    const created = db.prepare('SELECT * FROM suggested_kw_categories WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ success: true, category: _serializeCategory(created) });
  } catch (err) {
    console.error('[ADMIN] kw-categories create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/admin/kw-categories/:id — 수정
// 이름이 바뀌면 트랜잭션으로 suggested_keywords.category 일괄 update.
router.put('/kw-categories/:id', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });

    const existing = db.prepare('SELECT * FROM suggested_kw_categories WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, message: '카테고리를 찾을 수 없습니다.' });

    const fields = [];
    const params = [];
    let nameChanged = null; // { from, to }

    if (req.body.name !== undefined) {
      const nm = _normalizeKw(req.body.name);
      if (!nm) return res.status(400).json({ success: false, message: '카테고리 이름을 입력해 주세요.' });
      if (nm.length < 1 || nm.length > 30) {
        return res.status(400).json({ success: false, message: '카테고리 이름은 1~30자로 입력해 주세요.' });
      }
      if (nm !== existing.name) {
        nameChanged = { from: existing.name, to: nm };
      }
      fields.push('name = ?'); params.push(nm);
    }
    if (req.body.slug !== undefined) {
      const sl = _normalizeKw(req.body.slug);
      if (!sl || !SKC_SLUG_RE.test(sl)) {
        return res.status(400).json({ success: false, message: 'Slug는 영문 소문자·숫자·하이픈(-)만 쓸 수 있어요.' });
      }
      fields.push('slug = ?'); params.push(sl);
    }
    if (req.body.description !== undefined) {
      const desc = typeof req.body.description === 'string' ? req.body.description.trim() : null;
      fields.push('description = ?'); params.push(desc);
    }
    if (req.body.display_order !== undefined && req.body.display_order !== null && req.body.display_order !== '') {
      const ord = parseInt(req.body.display_order, 10);
      if (Number.isNaN(ord)) return res.status(400).json({ success: false, message: '정렬 순서는 정수여야 합니다.' });
      fields.push('display_order = ?'); params.push(ord);
    }
    if (req.body.color !== undefined) {
      const col = String(req.body.color || '').trim().toLowerCase();
      if (!SKC_COLOR_RE.test(col)) {
        return res.status(400).json({ success: false, message: '색상은 #RRGGBB 형식의 hex로 입력해 주세요.' });
      }
      fields.push('color = ?'); params.push(col);
    }
    if (req.body.icon !== undefined) {
      const ic = String(req.body.icon || '').trim();
      if (!SKC_ICON_RE.test(ic)) {
        return res.status(400).json({ success: false, message: '아이콘은 fa-xxx 형식의 Font Awesome 클래스명으로 입력해 주세요.' });
      }
      fields.push('icon = ?'); params.push(ic);
    }
    if (req.body.is_active !== undefined) {
      const v = req.body.is_active;
      const isActive = (v === 0 || v === '0' || v === false) ? 0 : 1;
      fields.push('is_active = ?'); params.push(isActive);
    }

    // 노출 대상 4컬럼
    const targetSpecs = [
      { key: 'target_school_levels', allowed: SK_ALLOWED_SCHOOL_LEVELS, label: 'target_school_levels', opts: {} },
      { key: 'target_roles',         allowed: SK_ALLOWED_ROLES,         label: 'target_roles',         opts: {} },
      { key: 'target_grades',        allowed: null,                     label: 'target_grades',        opts: { parseInt: true } },
      { key: 'target_subjects',      allowed: SK_ALLOWED_SUBJECTS,      label: 'target_subjects',      opts: {} },
    ];
    for (const spec of targetSpecs) {
      if (req.body[spec.key] === undefined) continue;
      const norm = _stringifyTargetArray(req.body[spec.key], spec.allowed, spec.label, spec.opts);
      if (norm && typeof norm === 'object' && norm.error) {
        return res.status(400).json({ success: false, message: norm.error });
      }
      fields.push(`${spec.key} = ?`);
      params.push(norm === undefined ? null : norm);
    }

    if (fields.length === 0) {
      return res.json({ success: true, category: _serializeCategory(existing), message: '변경 사항이 없습니다.' });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    // 트랜잭션: 카테고리 update + 이름 바뀌면 suggested_keywords.category 일괄 update
    const updateCatStmt = db.prepare(`UPDATE suggested_kw_categories SET ${fields.join(', ')} WHERE id = ?`);
    const updateKwStmt = db.prepare(`
      UPDATE suggested_keywords
      SET category = ?, updated_at = CURRENT_TIMESTAMP
      WHERE category = ?
    `);

    let cascadedKeywords = 0;
    try {
      const tx = db.transaction(() => {
        updateCatStmt.run(...params);
        if (nameChanged) {
          const r = updateKwStmt.run(nameChanged.to, nameChanged.from);
          cascadedKeywords = r.changes;
        }
      });
      tx();
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('UNIQUE') && msg.includes('name')) {
        return res.status(409).json({ success: false, message: '같은 이름의 카테고리가 이미 있어요. 다른 이름을 써 주세요.' });
      }
      if (msg.includes('UNIQUE') && msg.includes('slug')) {
        return res.status(409).json({ success: false, message: '같은 slug의 카테고리가 이미 있어요. 다른 slug를 써 주세요.' });
      }
      throw e;
    }

    const updated = db.prepare('SELECT * FROM suggested_kw_categories WHERE id = ?').get(id);
    res.json({
      success: true,
      category: _serializeCategory(updated),
      cascaded_keywords: cascadedKeywords,
      ...(nameChanged ? { message: `이름이 변경되어 ${cascadedKeywords}건의 키워드 카테고리도 함께 갱신했어요.` } : {})
    });
  } catch (err) {
    console.error('[ADMIN] kw-categories update error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/admin/kw-categories/:id — 삭제
// 키워드 1건 이상이면 409 + { error, keyword_count, code:'CATEGORY_HAS_KEYWORDS' }
router.delete('/kw-categories/:id', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });

    const existing = db.prepare('SELECT id, name FROM suggested_kw_categories WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ success: false, message: '카테고리를 찾을 수 없습니다.' });

    const cnt = db.prepare(
      `SELECT COUNT(*) AS c FROM suggested_keywords WHERE category = ?`
    ).get(existing.name).c;

    if (cnt > 0) {
      return res.status(409).json({
        success: false,
        code: 'CATEGORY_HAS_KEYWORDS',
        keyword_count: cnt,
        error: `이 카테고리에 키워드 ${cnt}개가 있어요. 먼저 다른 카테고리로 옮기거나 비활성화해 주세요.`,
        message: `이 카테고리에 키워드 ${cnt}개가 있어요. 먼저 다른 카테고리로 옮기거나 비활성화해 주세요.`,
      });
    }

    db.prepare(`DELETE FROM suggested_kw_categories WHERE id = ?`).run(id);
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('[ADMIN] kw-categories delete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/kw-categories/reorder — id 배열 순서로 display_order 10단위 재부여
// body: { ids: [...] }
router.post('/kw-categories/reorder', ...adminOnly, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(v => parseInt(v, 10)).filter(Number.isInteger) : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids 배열이 필요합니다.' });
    }
    const base = Number.isInteger(parseInt(req.body.base, 10)) ? parseInt(req.body.base, 10) : 10;
    const step = Number.isInteger(parseInt(req.body.step, 10)) ? parseInt(req.body.step, 10) : 10;

    const updateStmt = db.prepare(`
      UPDATE suggested_kw_categories
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    let updated = 0;
    const tx = db.transaction((list) => {
      list.forEach((id, idx) => {
        const order = base + idx * step;
        const r = updateStmt.run(order, id);
        if (r.changes > 0) updated++;
      });
    });
    tx(ids);

    res.json({ success: true, updated, total: ids.length });
  } catch (err) {
    console.error('[ADMIN] kw-categories reorder error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/admin/kw-categories/:id/migrate-keywords
// body: { target_id: <other category id> }
// — 해당 카테고리의 모든 키워드를 다른 카테고리로 일괄 이동 (삭제 전 안전 이동 용도)
router.post('/kw-categories/:id/migrate-keywords', ...adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const targetId = parseInt(req.body.target_id, 10);
    if (!id || !targetId) {
      return res.status(400).json({ success: false, message: '잘못된 요청입니다. (id 와 target_id 필수)' });
    }
    if (id === targetId) {
      return res.status(400).json({ success: false, message: '같은 카테고리로는 이동할 수 없어요.' });
    }
    const src = db.prepare('SELECT id, name FROM suggested_kw_categories WHERE id = ?').get(id);
    const dst = db.prepare('SELECT id, name FROM suggested_kw_categories WHERE id = ?').get(targetId);
    if (!src) return res.status(404).json({ success: false, message: '원본 카테고리를 찾을 수 없습니다.' });
    if (!dst) return res.status(404).json({ success: false, message: '이동할 카테고리를 찾을 수 없습니다.' });

    const updateKw = db.prepare(`
      UPDATE suggested_keywords
      SET category = ?, updated_at = CURRENT_TIMESTAMP
      WHERE category = ?
    `);

    let moved = 0;
    const tx = db.transaction(() => {
      const r = updateKw.run(dst.name, src.name);
      moved = r.changes;
    });
    tx();

    res.json({
      success: true,
      moved,
      from: { id: src.id, name: src.name },
      to: { id: dst.id, name: dst.name },
      message: `${moved}건의 키워드를 [${src.name}] → [${dst.name}] 로 옮겼어요.`
    });
  } catch (err) {
    console.error('[ADMIN] kw-categories migrate-keywords error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ============================================================================
// 오늘의 학습 학년별 일괄 배포 — 채움콘텐츠 영상·퀴즈 자동 매핑
// ============================================================================
router.post('/daily-learning/bulk-distribute', adminOnly, (req, res) => {
  try {
    const { startDate, endDate, scope = 'all' } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ success: false, message: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
    }
    if (endDate < startDate) return res.status(400).json({ success: false, message: '종료일이 시작일보다 빠릅니다.' });

    const db = require('../db/index');

    // 학년 매핑: scope에 따라 elementary 3~6 + middle 1~3 + high 1
    // contents 식별: school_level + grade 조합
    const gradeDefs = {
      elementary: [
        { tg: 3, levels: ['elementary','초등학교'], g: 3 },
        { tg: 4, levels: ['elementary','초등학교'], g: 4 },
        { tg: 5, levels: ['elementary','초등학교'], g: 5 },
        { tg: 6, levels: ['elementary','초등학교'], g: 6 },
      ],
      middleHigh: [
        { tg: 7, levels: ['middle','중학교'], g: 1 },
        { tg: 8, levels: ['middle','중학교'], g: 2 },
        { tg: 9, levels: ['middle','중학교'], g: 3 },
        { tg: 10, levels: ['고등학교','high'], g: 1, fallbackVideoFrom: { levels: ['middle','중학교'], g: 3 } },
      ],
    };
    let grades = [];
    if (scope === 'elementary') grades = gradeDefs.elementary;
    else if (scope === 'middle-high') grades = gradeDefs.middleHigh;
    else grades = [...gradeDefs.elementary, ...gradeDefs.middleHigh];

    // PRNG
    const mulberry32 = (seed) => () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const shuffle = (arr, rng) => { const a = arr.slice(); for (let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
    const eachDate = (s, e) => { const out=[],cur=new Date(s),last=new Date(e); while(cur<=last){out.push(cur.toISOString().slice(0,10));cur.setDate(cur.getDate()+1);} return out; };

    const dates = eachDate(startDate, endDate);
    const summary = {};
    let totalCreated = 0, totalSkipped = 0;

    const loadPool = (levels, g) => {
      const placeholders = levels.map(() => '?').join(',');
      const videos = db.prepare(`SELECT id, title FROM contents WHERE school_level IN (${placeholders}) AND grade = ? AND content_type='video' AND status='approved'`).all(...levels, g);
      const quizzes = db.prepare(`SELECT id, title FROM contents WHERE school_level IN (${placeholders}) AND grade = ? AND content_type='quiz' AND status='approved'`).all(...levels, g);
      return { videos, quizzes };
    };
    const checkExists = db.prepare(`SELECT id FROM daily_learning_sets WHERE target_date=? AND target_grade=? AND title=?`);
    const insSet = db.prepare(`INSERT INTO daily_learning_sets (teacher_id, title, description, target_date, target_grade, target_subject, difficulty, thumbnail_url, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`);
    const insItem = db.prepare(`INSERT INTO daily_learning_items (set_id, source_type, content_id, item_title, sort_order, point_value) VALUES (?, 'content', ?, ?, ?, 10)`);
    const getThumb = db.prepare(`SELECT thumbnail_url FROM contents WHERE id=?`);

    const gradeLabel = (tg) => tg <= 6 ? `초${tg}` : (tg <= 9 ? `중${tg-6}` : '고1');

    const tx = db.transaction(() => {
      for (const def of grades) {
        const { tg, levels, g } = def;
        const pool = loadPool(levels, g);
        // 고1 fallback (video 풀 없으면 다른 학년에서)
        if (pool.videos.length === 0 && def.fallbackVideoFrom) {
          const fb = loadPool(def.fallbackVideoFrom.levels, def.fallbackVideoFrom.g);
          pool.videos = fb.videos;
        }
        if (pool.videos.length === 0 && pool.quizzes.length === 0) {
          summary[gradeLabel(tg)] = 0;
          continue;
        }
        let created = 0, skipped = 0;
        dates.forEach((date, dayIdx) => {
          const title = `${date} ${gradeLabel(tg)} 오늘의 학습 (수학)`;
          if (checkExists.get(date, tg, title)) { skipped++; return; }
          const rng = mulberry32(tg * 1000 + dayIdx);
          const videoCount = pool.videos.length ? Math.min(pool.videos.length, 1 + Math.floor(rng() * 3)) : 0;
          const quizCount = pool.quizzes.length ? Math.min(pool.quizzes.length, 1 + Math.floor(rng() * 2)) : 0;
          const items = [
            ...shuffle(pool.videos, rng).slice(0, videoCount),
            ...shuffle(pool.quizzes, rng).slice(0, quizCount)
          ];
          if (items.length === 0) { skipped++; return; }
          const thumb = items[0] ? getThumb.get(items[0].id)?.thumbnail_url : null;
          const difficulty = tg <= 4 ? '쉬움' : tg <= 7 ? '보통' : '어려움';
          const setId = insSet.run(1, title, `${gradeLabel(tg)} 수학 학습 ${items.length}개 자료`, date, tg, '수학', difficulty, thumb).lastInsertRowid;
          items.forEach((it, idx) => insItem.run(setId, it.id, it.title, idx + 1));
          created++;
        });
        summary[gradeLabel(tg)] = created;
        totalCreated += created;
        totalSkipped += skipped;
      }
    });
    tx();

    res.json({ success: true, summary, totalCreated, totalSkipped, dateRange: { startDate, endDate } });
  } catch (err) {
    console.error('[ADMIN] daily-learning bulk-distribute error:', err);
    res.status(500).json({ success: false, message: '서버 오류: ' + err.message });
  }
});

module.exports = router;
