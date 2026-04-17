const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const lrsDb = require('../db/lrs');
const classDb = require('../db/class');
const { rebuildAllAggregates } = require('../db/lrs-aggregate');

// POST /api/lrs/log - 학습 활동 기록
router.post('/log', requireAuth, (req, res) => {
  try {
    if (!req.body.activity_type || !req.body.verb) {
      return res.status(400).json({ success: false, message: 'activity_type과 verb는 필수입니다.' });
    }
    const log = lrsDb.logActivity(req.user.id, req.body);
    res.status(201).json({ success: true, log });
  } catch (err) {
    console.error('[LRS] log error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/logs - 내 학습 로그
router.get('/logs', requireAuth, (req, res) => {
  try {
    const result = lrsDb.getUserLogs(req.user.id, {
      classId: req.query.classId ? parseInt(req.query.classId) : null,
      activityType: req.query.activityType,
      page: parseInt(req.query.page) || 1,
      limit: req.query.limit ? parseInt(req.query.limit) : 20,
      startDate: req.query.startDate || req.query.from,
      endDate: req.query.endDate || req.query.to
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/dashboard - 내 대시보드
router.get('/dashboard', requireAuth, (req, res) => {
  try {
    const { from, to } = req.query;
    if (from || to) {
      // 기간 필터 시 직접 집계 (내 활동만)
      const userId = req.user.id;
      let where = 'WHERE user_id = ?'; const params = [userId];
      if (from) { where += ' AND DATE(created_at) >= ?'; params.push(from); }
      if (to)   { where += ' AND DATE(created_at) <= ?'; params.push(to); }
      const totalActivities = db.prepare(`SELECT COUNT(*) cnt FROM learning_logs ${where}`).get(...params).cnt;
      const byType = db.prepare(`SELECT activity_type, COUNT(*) cnt FROM learning_logs ${where} GROUP BY activity_type ORDER BY cnt DESC`).all(...params);
      return res.json({ success: true, stats: { totalActivities, byType } });
    }
    const stats = lrsDb.getDashboardStats(req.user.id);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/class/:classId - 클래스 LRS (교사용)
router.get('/class/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const myRole = classDb.getMemberRole(classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }
    const stats = lrsDb.getClassLrsStats(classId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/student/:studentId - 학생별 학습 통계
router.get('/student/:studentId', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    // 본인이거나 교사/관리자만 조회 가능
    if (req.user.id !== studentId && req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const stats = lrsDb.getDashboardStats(studentId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/content/:contentId - 콘텐츠별 이용 통계 (집계 + 원본 혼합)
router.get('/content/:contentId', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.contentId);
    // 집계 테이블에서 빠르게 읽기
    const summary = db.prepare(
      "SELECT * FROM lrs_content_summary WHERE target_type = 'content' AND target_id = ?"
    ).get(contentId);
    const viewCount = summary?.view_count || 0;
    const uniqueUsers = summary?.unique_users || 0;
    const completeCount = summary?.complete_count || 0;
    // 최근 조회자는 원본에서 (소량 쿼리)
    const recentViewers = db.prepare(`
      SELECT DISTINCT ll.user_id, u.display_name, MAX(ll.created_at) as last_viewed
      FROM learning_logs ll JOIN users u ON ll.user_id = u.id
      WHERE ll.target_type = 'content' AND ll.target_id = ?
      GROUP BY ll.user_id ORDER BY last_viewed DESC LIMIT 10
    `).all(contentId);
    res.json({ success: true, contentId, viewCount, uniqueUsers, completeCount, recentViewers });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== LRS 확장 =====

const db = require('../db/index');

// GET /api/lrs/statements — xAPI Statement 목록
router.get('/statements', requireAuth, (req, res) => {
  try {
    const { service, verb, startDate, endDate, page = 1, limit = 20 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (service) { where += ' AND source_service = ?'; params.push(service); }
    if (verb) { where += ' AND verb = ?'; params.push(verb); }
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND created_at <= ?'; params.push(endDate); }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM learning_logs ${where}`).get(...params).cnt;
    const statements = db.prepare(`
      SELECT ll.*, u.display_name FROM learning_logs ll
      JOIN users u ON ll.user_id = u.id
      ${where} ORDER BY ll.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    res.json({ success: true, statements, total, totalPages: Math.ceil(total / parseInt(limit)) || 1 });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/statements/:id — Statement 상세
router.get('/statements/:id', requireAuth, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(parseInt(req.params.id));
    if (!stmt) return res.status(404).json({ success: false, message: 'Statement를 찾을 수 없습니다.' });
    if (stmt.statement_json) stmt.statement_json = JSON.parse(stmt.statement_json);
    if (stmt.metadata) stmt.metadata = JSON.parse(stmt.metadata);
    res.json({ success: true, statement: stmt });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 공용 헬퍼: 기간 WHERE 절
function dateRangeWhere(req, col = 'created_at', alias = '') {
  const { from, to } = req.query;
  const c = alias ? `${alias}.${col}` : col;
  let where = ''; const params = [];
  if (from) { where += ` AND DATE(${c}) >= ?`; params.push(from); }
  if (to)   { where += ` AND DATE(${c}) <= ?`; params.push(to); }
  return { where, params, hasRange: !!(from || to) };
}

// GET /api/lrs/stats/by-service — 서비스별 통계 (기간/role 필터 시 직접 집계)
router.get('/stats/by-service', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at', 'll');
    const role = req.query.role;
    if (r.hasRange || role) {
      let join = '';
      let where = `WHERE ll.source_service IS NOT NULL ${r.where}`;
      const params = [...r.params];
      if (role) {
        join = 'JOIN users u ON ll.user_id = u.id';
        where += ' AND u.role = ?'; params.push(role);
      }
      const stats = db.prepare(`
        SELECT ll.source_service, COUNT(*) as count, AVG(ll.result_score) as avg_score,
          COUNT(DISTINCT ll.user_id) as unique_users
        FROM learning_logs ll ${join}
        ${where}
        GROUP BY ll.source_service ORDER BY count DESC
      `).all(...params);
      return res.json({ success: true, stats });
    }
    const stats = db.prepare(`
      SELECT source_service, SUM(total_count) as count,
        AVG(avg_score) as avg_score,
        SUM(unique_users) as unique_users
      FROM lrs_service_stats
      GROUP BY source_service ORDER BY count DESC
    `).all();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-achievement — 성취기준별 통계
router.get('/stats/by-achievement', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req);
    const stats = db.prepare(`
      SELECT achievement_code, COUNT(*) as count,
        AVG(result_score) as avg_score,
        SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) as success_count
      FROM learning_logs
      WHERE achievement_code IS NOT NULL ${r.where}
      GROUP BY achievement_code ORDER BY count DESC
    `).all(...r.params);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/dataset-coverage — 데이터셋 수집 현황 (기간 필터 시 직접 집계)
router.get('/dataset-coverage', requireAuth, (req, res) => {
  try {
    // 사용자 수 메타 (활용률 계산용)
    const userCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN role IN ('student','teacher') THEN 1 ELSE 0 END) as totalLearners,
        SUM(CASE WHEN role='student' THEN 1 ELSE 0 END) as totalStudents,
        SUM(CASE WHEN role='teacher' THEN 1 ELSE 0 END) as totalTeachers,
        COUNT(*) as totalAccounts
      FROM users
    `).get();
    const r = dateRangeWhere(req);
    if (r.hasRange) {
      const types = db.prepare(`SELECT activity_type, COUNT(*) as count FROM learning_logs WHERE 1=1 ${r.where} GROUP BY activity_type`).all(...r.params);
      const verbs = db.prepare(`SELECT verb, COUNT(*) as count FROM learning_logs WHERE 1=1 ${r.where} GROUP BY verb`).all(...r.params);
      const services = db.prepare(`SELECT source_service, COUNT(*) as count FROM learning_logs WHERE source_service IS NOT NULL ${r.where} GROUP BY source_service`).all(...r.params);
      const totalStatements = types.reduce((s, t) => s + t.count, 0);
      return res.json({ success: true, totalStatements, byType: types, byVerb: verbs, byService: services, ...userCounts });
    }
    const types = db.prepare(`
      SELECT activity_type, SUM(total_count) as count FROM lrs_user_summary GROUP BY activity_type
    `).all();
    const verbs = db.prepare(`
      SELECT verb, SUM(total_count) as count FROM lrs_service_stats GROUP BY verb
    `).all();
    const services = db.prepare(`
      SELECT source_service, SUM(total_count) as count FROM lrs_service_stats GROUP BY source_service
    `).all();
    const totalStatements = types.reduce((s, t) => s + t.count, 0);
    res.json({ success: true, totalStatements, byType: types, byVerb: verbs, byService: services, ...userCounts });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/xapi/statements — 외부 xAPI Statement 수신
router.post('/xapi/statements', requireAuth, (req, res) => {
  try {
    const { actor, verb, object, result, context } = req.body;
    db.prepare(`
      INSERT INTO learning_logs (user_id, activity_type, verb, object_type, object_id, result_score, result_success, source_service, statement_json)
      VALUES (?, 'external', ?, ?, ?, ?, ?, 'external', ?)
    `).run(
      req.user.id, verb?.id || verb, object?.objectType || 'Activity', object?.id || '',
      result?.score?.scaled || null, result?.success !== undefined ? (result.success ? 1 : 0) : null,
      JSON.stringify(req.body)
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/export - 데이터 내보내기 (CSV)
router.get('/export', requireAuth, (req, res) => {
  try {
    const { format = 'csv', startDate, endDate, service } = req.query;
    let sql = `SELECT id, user_id, activity_type, target_type, target_id, class_id, verb, source_service, result_score, created_at FROM learning_logs WHERE 1=1`;
    const params = [];
    if (startDate) { sql += ` AND created_at >= ?`; params.push(startDate); }
    if (endDate) { sql += ` AND created_at <= ?`; params.push(endDate + ' 23:59:59'); }
    if (service) { sql += ` AND source_service = ?`; params.push(service); }
    sql += ` ORDER BY created_at DESC LIMIT 10000`;

    const db = require('../db/index');
    const rows = db.prepare(sql).all(...params);

    if (format === 'csv') {
      const header = 'id,user_id,activity_type,target_type,target_id,class_id,verb,source_service,result_score,created_at\n';
      const csv = header + rows.map(r =>
        `${r.id},${r.user_id},${r.activity_type},${r.target_type},${r.target_id},${r.class_id||''},${r.verb},${r.source_service||''},${r.result_score||''},${r.created_at}`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=lrs_export.csv');
      return res.send('\uFEFF' + csv);
    }

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[LRS] export error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/daily — 일별 활동 추이 (learning_logs 직접 집계로 정확한 distinct 사용자/총 시간)
router.get('/stats/daily', requireAuth, (req, res) => {
  try {
    const { days = 30, activity_type, class_id, from, to, role } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (from) { where += ' AND DATE(ll.created_at) >= ?'; params.push(from); }
    if (to)   { where += ' AND DATE(ll.created_at) <= ?'; params.push(to); }
    if (!from && !to) {
      const daysInt = Math.min(Math.max(parseInt(days) || 30, 1), 365);
      where += ` AND DATE(ll.created_at) >= DATE('now', '-${daysInt} days')`;
    }
    if (activity_type) { where += ' AND ll.activity_type = ?'; params.push(activity_type); }
    if (class_id) { where += ' AND ll.class_id = ?'; params.push(parseInt(class_id)); }

    let join = '';
    if (role) {
      join = 'JOIN users u ON ll.user_id = u.id';
      where += ' AND u.role = ?'; params.push(role);
    }

    const data = db.prepare(`
      SELECT DATE(ll.created_at) as stat_date,
        COUNT(*) as count,
        COUNT(DISTINCT ll.user_id) as users,
        AVG(ll.result_score) as avg_score,
        COALESCE(SUM(ll.duration), 0) as total_duration
      FROM learning_logs ll ${join}
      ${where}
      GROUP BY DATE(ll.created_at) ORDER BY stat_date ASC
    `).all(...params);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[LRS] /stats/daily error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-subject — 교과별 통계
router.get('/stats/by-subject', requireAuth, (req, res) => {
  try {
    const { from, to } = req.query;
    const buildDate = (col) => {
      let w = ''; const p = [];
      if (from) { w += ` AND DATE(${col}) >= ?`; p.push(from); }
      if (to)   { w += ` AND DATE(${col}) <= ?`; p.push(to); }
      return { w, p };
    };
    // 수업/과제/평가에서 교과 메타 기반 집계
    const dl = buildDate('l.created_at');
    const lessonStats = db.prepare(`
      SELECT l.subject_code, s.name as subject_name, COUNT(*) as lesson_count
      FROM lessons l JOIN subjects s ON l.subject_code = s.code
      WHERE l.subject_code IS NOT NULL ${dl.w}
      GROUP BY l.subject_code ORDER BY lesson_count DESC
    `).all(...dl.p);
    const dh = buildDate('h.created_at');
    const homeworkStats = db.prepare(`
      SELECT h.subject_code, s.name as subject_name, COUNT(*) as hw_count
      FROM homework h JOIN subjects s ON h.subject_code = s.code
      WHERE h.subject_code IS NOT NULL ${dh.w}
      GROUP BY h.subject_code ORDER BY hw_count DESC
    `).all(...dh.p);
    const de = buildDate('e.created_at');
    const examStats = db.prepare(`
      SELECT e.subject_code, s.name as subject_name, COUNT(*) as exam_count
      FROM exams e JOIN subjects s ON e.subject_code = s.code
      WHERE e.subject_code IS NOT NULL ${de.w}
      GROUP BY e.subject_code ORDER BY exam_count DESC
    `).all(...de.p);
    res.json({ success: true, lessonStats, homeworkStats, examStats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-class — 클래스별 통계
router.get('/stats/by-class', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at', 'll'); // classes도 created_at을 가져 alias 필수
    if (r.hasRange) {
      const stats = db.prepare(`
        SELECT ll.class_id, c.name as class_name, ll.activity_type,
          COUNT(*) as total_count, COUNT(DISTINCT ll.user_id) as unique_users,
          AVG(ll.result_score) as avg_score
        FROM learning_logs ll JOIN classes c ON ll.class_id = c.id
        WHERE ll.class_id IS NOT NULL ${r.where}
        GROUP BY ll.class_id, ll.activity_type
        ORDER BY total_count DESC LIMIT 50
      `).all(...r.params);
      return res.json({ success: true, stats });
    }
    const stats = db.prepare(`
      SELECT lcs.class_id, c.name as class_name, lcs.activity_type,
        lcs.total_count, lcs.unique_users, lcs.avg_score
      FROM lrs_class_summary lcs
      JOIN classes c ON lcs.class_id = c.id
      ORDER BY lcs.total_count DESC LIMIT 50
    `).all();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/user-summary — 사용자 활동 요약
router.get('/stats/user-summary', requireAuth, (req, res) => {
  try {
    const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
    if (userId !== req.user.id && req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const r = dateRangeWhere(req);
    if (r.hasRange) {
      const summary = db.prepare(`
        SELECT activity_type, COUNT(*) as total_count,
          COALESCE(SUM(duration), 0) as total_duration,
          AVG(result_score) as avg_score,
          MAX(created_at) as last_activity_at
        FROM learning_logs WHERE user_id = ? ${r.where}
        GROUP BY activity_type ORDER BY total_count DESC
      `).all(userId, ...r.params);
      const total = summary.reduce((s, x) => s + x.total_count, 0);
      return res.json({ success: true, userId, total, summary });
    }
    const summary = db.prepare(`
      SELECT activity_type, total_count, total_duration, avg_score, last_activity_at
      FROM lrs_user_summary WHERE user_id = ?
      ORDER BY total_count DESC
    `).all(userId);
    const total = summary.reduce((s, x) => s + x.total_count, 0);
    res.json({ success: true, userId, total, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/rebuild-aggregates - 집계 테이블 재빌드 (admin only)
router.post('/rebuild-aggregates', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 사용할 수 있습니다.' });
    }
    const result = rebuildAllAggregates();
    res.json({ success: true, message: '집계 테이블 재빌드 완료', data: result });
  } catch (err) {
    console.error('[LRS] rebuild-aggregates error:', err);
    res.status(500).json({ success: false, message: '재빌드 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
