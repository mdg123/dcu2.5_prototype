const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/index');
const lrsDb = require('../db/lrs');
const classDb = require('../db/class');
const { rebuildAllAggregates } = require('../db/lrs-aggregate');
const { logLearningActivity } = require('../db/learning-log-helper');
const { LRS_CONFIG } = require('../lib/lrs-config');

/**
 * CSV 셀 injection 방어 — 값이 수식/명령 프리픽스(=, +, -, @, TAB, CR)로 시작하면
 * 작은따옴표를 앞에 붙여 Excel/Sheets가 수식으로 해석하지 못하게 한다.
 * 콤마/따옴표/개행은 기존대로 RFC 4180 quoting 적용.
 */
function csvEscapeCell(v) {
  if (v == null) return '';
  let s = String(v);
  // CSV injection 방어 (OWASP): 첫 글자가 =, +, -, @, 탭, CR 이면 ' 로 prefix
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// /log 화이트리스트: student 역할은 서버 산출/민감 필드 주입 금지
const LOG_STUDENT_FIELDS = new Set([
  'activity_type','verb','target_type','target_id','object_type','object_id',
  'class_id','source_service','subject_code','grade_group','session_id',
  'device_type','platform','duration_sec','duration','result_duration',
  'metadata','activity_id'
]);

function maskDigestScore(val) {
  if (val == null) return null;
  const ratio = (typeof val === 'number' && val > 1) ? val / 100 : val;
  if (ratio >= 0.80) return '상';
  if (ratio >= 0.50) return '중';
  if (ratio >= 0) return '하';
  return '미도달';
}

// ─────────────────────────────────────────────────────────
// 공용 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * 기간 파라미터 통일: period=7d|30d|90d|custom + from/to.
 * 반환: { fromDate, toDate, label }
 */
function resolvePeriod(req) {
  const { period, from, to, days } = req.query;
  const today = new Date();
  const toIso = (d) => d.toISOString().slice(0, 10);

  if (period && period !== 'custom') {
    const n = parseInt(String(period).replace('d', ''), 10);
    if (!isNaN(n)) {
      const start = new Date(today);
      start.setDate(start.getDate() - n);
      return { fromDate: toIso(start), toDate: toIso(today), label: `${n}d` };
    }
  }
  if (from || to) {
    // from > to 검증: 두 값 모두 주어졌고 역전된 경우 invalid 마킹
    if (from && to && String(from) > String(to)) {
      return { fromDate: from, toDate: to, label: 'custom', invalid: true, reason: 'from > to' };
    }
    return { fromDate: from || null, toDate: to || null, label: 'custom' };
  }
  // 레거시 days 파라미터 지원
  if (days) {
    const n = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    const start = new Date(today);
    start.setDate(start.getDate() - n);
    return { fromDate: toIso(start), toDate: toIso(today), label: `${n}d` };
  }
  // 기본 30일
  const start = new Date(today);
  start.setDate(start.getDate() - 30);
  return { fromDate: toIso(start), toDate: toIso(today), label: '30d' };
}

function dateRangeWhere(req, col = 'created_at', alias = '') {
  const c = alias ? `${alias}.${col}` : col;
  const period = resolvePeriod(req);
  const { fromDate, toDate, invalid, reason } = period;
  let where = ''; const params = [];
  if (fromDate) { where += ` AND DATE(${c}) >= ?`; params.push(fromDate); }
  if (toDate)   { where += ` AND DATE(${c}) <= ?`; params.push(toDate); }
  return { where, params, hasRange: !!(fromDate || toDate), fromDate, toDate, invalid: !!invalid, reason };
}

/** 공통 400 응답: resolvePeriod 가 invalid=true 를 반환했을 때. */
function sendInvalidPeriod(res, reason) {
  return res.status(400).json({ success: false, message: `잘못된 기간 파라미터: ${reason || 'from > to'}` });
}

/** 역할 가드: 본인이거나 teacher/admin만 허용 */
function canViewUser(req, targetUserId) {
  if (!req.user) return false;
  if (req.user.id === targetUserId) return true;
  return req.user.role === 'teacher' || req.user.role === 'admin';
}

/** 클래스 소유자/교사/관리자만 허용 */
function canViewClass(req, classId) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  try {
    const role = classDb.getMemberRole(classId, req.user.id);
    if (role === 'owner' || role === 'teacher') return true;
  } catch (_) {}
  return req.user.role === 'teacher';
}

// ─────────────────────────────────────────────────────────
// 기존 18개 엔드포인트
// ─────────────────────────────────────────────────────────

// POST /api/lrs/log
router.post('/log', requireAuth, (req, res) => {
  try {
    if (!req.body.activity_type || !req.body.verb) {
      return res.status(400).json({ success: false, message: 'activity_type과 verb는 필수입니다.' });
    }
    // M-6: student는 서버 산출/민감 필드 주입 금지. admin/teacher만 전체 필드 허용.
    let body = req.body;
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      body = {};
      for (const [k, v] of Object.entries(req.body)) {
        if (LOG_STUDENT_FIELDS.has(k)) body[k] = v;
      }
    }
    const log = lrsDb.logActivity(req.user.id, body);
    res.status(201).json({ success: true, log });
  } catch (err) {
    console.error('[LRS] log error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/logs
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

// GET /api/lrs/dashboard (B1 수정: db는 이제 최상단 require)
router.get('/dashboard', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    if (r.hasRange) {
      const userId = req.user.id;
      let where = 'WHERE user_id = ?' + r.where;
      const params = [userId, ...r.params];
      const totalActivities = db.prepare(`SELECT COUNT(*) cnt FROM learning_logs ${where}`).get(...params).cnt;
      const byType = db.prepare(`SELECT activity_type, COUNT(*) cnt FROM learning_logs ${where} GROUP BY activity_type ORDER BY cnt DESC`).all(...params);
      return res.json({ success: true, stats: { totalActivities, byType } });
    }
    const stats = lrsDb.getDashboardStats(req.user.id);
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[LRS] dashboard error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/class/:classId
router.get('/class/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const stats = lrsDb.getClassLrsStats(classId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/student/:studentId
router.get('/student/:studentId', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    if (!canViewUser(req, studentId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const stats = lrsDb.getDashboardStats(studentId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/content/:contentId
router.get('/content/:contentId', requireAuth, (req, res) => {
  try {
    // C-3: student는 콘텐츠 집계 조회 차단 (학교/클래스 전체 집계 노출 방지)
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const contentId = parseInt(req.params.contentId);
    const targetType = req.query.target_type || 'content';
    const summary = db.prepare(
      "SELECT * FROM lrs_content_summary WHERE target_type = ? AND target_id = ?"
    ).get(targetType, contentId);
    const viewCount = summary?.view_count || 0;
    const uniqueUsers = summary?.unique_users || 0;
    const completeCount = summary?.complete_count || 0;
    const recentViewers = db.prepare(`
      SELECT DISTINCT ll.user_id, u.display_name, MAX(ll.created_at) as last_viewed
      FROM learning_logs ll JOIN users u ON ll.user_id = u.id
      WHERE ll.target_type = ? AND ll.target_id = ?
      GROUP BY ll.user_id ORDER BY last_viewed DESC LIMIT 10
    `).all(targetType, String(contentId));
    res.json({ success: true, contentId, viewCount, uniqueUsers, completeCount, recentViewers });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/statements
router.get('/statements', requireAuth, (req, res) => {
  try {
    const { service, verb, page = 1, limit = 20 } = req.query;
    // 두 쿼리 분리: 합계는 ll 별칭 없이, 상세는 별칭 포함
    const rPlain = dateRangeWhere(req, 'created_at');
    if (rPlain.invalid) return sendInvalidPeriod(res, rPlain.reason);
    const rAliased = dateRangeWhere(req, 'created_at', 'll');
    const plainParams = [...rPlain.params];
    const aliasedParams = [...rAliased.params];
    let wherePlain = 'WHERE 1=1' + rPlain.where;
    let whereAliased = 'WHERE 1=1' + rAliased.where;
    // C-3: student는 본인 데이터만 조회
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      wherePlain += ' AND user_id = ?'; plainParams.push(req.user.id);
      whereAliased += ' AND ll.user_id = ?'; aliasedParams.push(req.user.id);
    }
    if (service) {
      wherePlain += ' AND source_service = ?'; plainParams.push(service);
      whereAliased += ' AND ll.source_service = ?'; aliasedParams.push(service);
    }
    if (verb) {
      wherePlain += ' AND verb = ?'; plainParams.push(verb);
      whereAliased += ' AND ll.verb = ?'; aliasedParams.push(verb);
    }

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM learning_logs ${wherePlain}`).get(...plainParams).cnt;
    const statements = db.prepare(`
      SELECT ll.*, u.display_name FROM learning_logs ll
      JOIN users u ON ll.user_id = u.id
      ${whereAliased} ORDER BY ll.created_at DESC LIMIT ? OFFSET ?
    `).all(...aliasedParams, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    res.json({ success: true, statements, total, totalPages: Math.ceil(total / parseInt(limit)) || 1 });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/statements/:id
router.get('/statements/:id', requireAuth, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(parseInt(req.params.id));
    if (!stmt) return res.status(404).json({ success: false, message: 'Statement를 찾을 수 없습니다.' });
    // C-2: statement의 user_id에 대한 조회 권한 확인
    if (!canViewUser(req, stmt.user_id)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    if (stmt.statement_json) { try { stmt.statement_json = JSON.parse(stmt.statement_json); } catch (_) {} }
    if (stmt.metadata) { try { stmt.metadata = JSON.parse(stmt.metadata); } catch (_) {} }
    res.json({ success: true, statement: stmt });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-service
router.get('/stats/by-service', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const role = req.query.role;
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
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-achievement
router.get('/stats/by-achievement', requireAuth, (req, res) => {
  try {
    const r = dateRangeWhere(req);
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const { user_id, subject_code } = req.query;
    let where = 'WHERE achievement_code IS NOT NULL' + r.where;
    const params = [...r.params];
    if (user_id) {
      const uid = parseInt(user_id);
      if (!canViewUser(req, uid)) {
        return res.status(403).json({ success: false, message: '권한이 없습니다.' });
      }
      where += ' AND user_id = ?'; params.push(uid);
    }
    if (subject_code) { where += ' AND subject_code = ?'; params.push(subject_code); }
    const stats = db.prepare(`
      SELECT achievement_code, subject_code, COUNT(*) as count,
        AVG(result_score) as avg_score,
        SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) as success_count
      FROM learning_logs
      ${where}
      GROUP BY achievement_code ORDER BY count DESC
    `).all(...params);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/dataset-coverage
router.get('/dataset-coverage', requireAuth, (req, res) => {
  try {
    // C-3: admin/teacher 전용 (전체 계정/데이터셋 집계 노출 방지)
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const userCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN role IN ('student','teacher') THEN 1 ELSE 0 END) as totalLearners,
        SUM(CASE WHEN role='student' THEN 1 ELSE 0 END) as totalStudents,
        SUM(CASE WHEN role='teacher' THEN 1 ELSE 0 END) as totalTeachers,
        COUNT(*) as totalAccounts
      FROM users
    `).get();
    const r = dateRangeWhere(req);
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const types = db.prepare(`SELECT activity_type, COUNT(*) as count FROM learning_logs WHERE 1=1 ${r.where} GROUP BY activity_type`).all(...r.params);
    const verbs = db.prepare(`SELECT verb, COUNT(*) as count FROM learning_logs WHERE 1=1 ${r.where} GROUP BY verb`).all(...r.params);
    const services = db.prepare(`SELECT source_service, COUNT(*) as count FROM learning_logs WHERE source_service IS NOT NULL ${r.where} GROUP BY source_service`).all(...r.params);
    const totalStatements = types.reduce((s, t) => s + t.count, 0);
    res.json({ success: true, totalStatements, byType: types, byVerb: verbs, byService: services, ...userCounts });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/xapi/statements
router.post('/xapi/statements', requireAuth, (req, res) => {
  try {
    // M-11: logLearningActivity로 dual-write (집계 테이블/세션 반영)
    const { verb, object, result, context } = req.body || {};
    const verbId = (verb && typeof verb === 'object') ? (verb.id || 'completed') : (verb || 'completed');
    const verbShort = String(verbId).split('/').pop();
    const objectType = object?.objectType || 'Activity';
    const objectId = object?.id || '';

    const ret = logLearningActivity({
      userId: req.user.id,
      activityType: 'external',
      targetType: objectType,
      targetId: objectId,
      verb: verbShort,
      objectType,
      objectId,
      resultScore: result?.score?.scaled ?? result?.score?.raw ?? null,
      resultSuccess: result?.success !== undefined ? (result.success ? 1 : 0) : null,
      resultDuration: result?.duration || null,
      sourceService: 'external',
      sessionId: context?.registration || null,
      metadata: req.body
    });
    res.json({ success: true, id: ret && ret.id });
  } catch (err) {
    console.error('[LRS] /xapi/statements error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/export — CSV/Excel/JSON 포맷 선택
router.get('/export', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const { format = 'csv', service } = req.query;
    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    let sql = `SELECT id, user_id, activity_type, target_type, target_id, class_id, verb, source_service, result_score, result_success, duration_sec, result_duration, achievement_code, subject_code, session_id, created_at FROM learning_logs WHERE 1=1` + r.where;
    const params = [...r.params];
    if (service) { sql += ` AND source_service = ?`; params.push(service); }
    sql += ` ORDER BY created_at DESC LIMIT ${LRS_CONFIG.csvExportLimit}`;

    const rows = db.prepare(sql).all(...params);

    const cols = ['id','user_id','activity_type','target_type','target_id','class_id','verb','source_service','result_score','result_success','duration_sec','result_duration','achievement_code','subject_code','session_id','created_at'];

    if (format === 'csv' || format === 'excel' || format === 'xlsx') {
      // SEP=, 지시자 + UTF-8 BOM을 추가하면 Excel 한글 정상 표시
      // csvEscapeCell 은 CSV injection 방어까지 포함 (=, +, -, @, TAB, CR prefix → ')
      const header = cols.join(',') + '\n';
      const csv = header + rows.map(r => cols.map(c => csvEscapeCell(r[c])).join(',')).join('\n');
      const filename = (format === 'excel' || format === 'xlsx') ? 'lrs_export.csv' : 'lrs_export.csv';
      const prefix = (format === 'excel' || format === 'xlsx') ? 'sep=,\n' : '';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      return res.send('\uFEFF' + prefix + csv);
    }

    if (format === 'jsonld' || format === 'xapi') {
      // xAPI Statement 배열 형태
      const stmts = db.prepare(`
        SELECT statement_json FROM learning_logs WHERE 1=1 ${r.where}
        ${service ? ' AND source_service = ?' : ''}
        ORDER BY created_at DESC LIMIT 10000
      `).all(...params);
      const items = stmts.map(s => { try { return JSON.parse(s.statement_json || '{}'); } catch { return null; } }).filter(Boolean);
      return res.json({ success: true, statements: items, total: items.length });
    }

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[LRS] export error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/daily — B2 수정: duration_sec 우선, result_duration fallback
router.get('/stats/daily', requireAuth, (req, res) => {
  try {
    const { activity_type, class_id, role, subject } = req.query;
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    let where = 'WHERE 1=1' + r.where;
    const params = [...r.params];
    if (activity_type) { where += ' AND ll.activity_type = ?'; params.push(activity_type); }
    if (class_id) { where += ' AND ll.class_id = ?'; params.push(parseInt(class_id)); }
    if (subject) { where += ' AND ll.subject_code = ?'; params.push(subject); }

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
        COALESCE(SUM(COALESCE(ll.duration_sec, CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as total_duration_sec
      FROM learning_logs ll ${join}
      ${where}
      GROUP BY DATE(ll.created_at) ORDER BY stat_date ASC
    `).all(...params);
    res.json({ success: true, data, period: r.fromDate && r.toDate ? { from: r.fromDate, to: r.toDate } : null });
  } catch (err) {
    console.error('[LRS] /stats/daily error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/by-subject
router.get('/stats/by-subject', requireAuth, (req, res) => {
  try {
    const period = resolvePeriod(req);
    if (period.invalid) return sendInvalidPeriod(res, period.reason);
    const { fromDate: from, toDate: to } = period;
    const buildDate = (col) => {
      let w = ''; const p = [];
      if (from) { w += ` AND DATE(${col}) >= ?`; p.push(from); }
      if (to)   { w += ` AND DATE(${col}) <= ?`; p.push(to); }
      return { w, p };
    };
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

// GET /api/lrs/stats/by-class
router.get('/stats/by-class', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const r = dateRangeWhere(req, 'created_at', 'll');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const stats = db.prepare(`
      SELECT ll.class_id, c.name as class_name, ll.activity_type,
        COUNT(*) as total_count, COUNT(DISTINCT ll.user_id) as unique_users,
        AVG(ll.result_score) as avg_score
      FROM learning_logs ll JOIN classes c ON ll.class_id = c.id
      WHERE ll.class_id IS NOT NULL ${r.where}
      GROUP BY ll.class_id, ll.activity_type
      ORDER BY total_count DESC LIMIT 50
    `).all(...r.params);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lrs/stats/user-summary
router.get('/stats/user-summary', requireAuth, (req, res) => {
  try {
    const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const r = dateRangeWhere(req);
    if (r.invalid) return sendInvalidPeriod(res, r.reason);
    const summary = db.prepare(`
      SELECT activity_type, COUNT(*) as total_count,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as total_duration_sec,
        AVG(result_score) as avg_score,
        MAX(created_at) as last_activity_at
      FROM learning_logs WHERE user_id = ? ${r.where}
      GROUP BY activity_type ORDER BY total_count DESC
    `).all(userId, ...r.params);
    const total = summary.reduce((s, x) => s + x.total_count, 0);
    res.json({ success: true, userId, total, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lrs/rebuild-aggregates
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

// ─────────────────────────────────────────────────────────
// 신규 엔드포인트 8개 (Phase 2)
// ─────────────────────────────────────────────────────────

// 1. GET /api/lrs/insights/:userId — 개인 인사이트
router.get('/insights/:userId', requireAuth, (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // streak: 연속 학습 일수
    const dailyRows = db.prepare(`
      SELECT stat_date FROM lrs_user_daily
      WHERE user_id = ? ORDER BY stat_date DESC LIMIT 60
    `).all(userId);
    let streakDays = 0;
    {
      const today = new Date();
      const iso = (d) => d.toISOString().slice(0, 10);
      let cursor = new Date(today);
      const set = new Set(dailyRows.map(r => r.stat_date));
      // 오늘 미학습이면 어제부터 셈
      if (!set.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
      while (set.has(iso(cursor))) {
        streakDays++;
        cursor.setDate(cursor.getDate() - 1);
      }
    }

    // 주간 통계
    const weekly = db.prepare(`
      SELECT COALESCE(SUM(duration_sec),0) as dur, AVG(avg_score) as avg_score
      FROM lrs_user_daily
      WHERE user_id = ? AND stat_date >= DATE('now','-7 days')
    `).get(userId);

    // 약점 TOP5
    const weaknesses = db.prepare(`
      SELECT achievement_code, subject_code, attempt_count, success_count, avg_score, last_level
      FROM lrs_achievement_stats
      WHERE user_id = ? AND attempt_count >= 1
      ORDER BY COALESCE(avg_score, 0) ASC, attempt_count DESC
      LIMIT 5
    `).all(userId);

    // 추천 콘텐츠 (약점 성취기준에 매핑된 콘텐츠)
    const recommendedContentIds = [];
    for (const w of weaknesses) {
      try {
        const cs = db.prepare(`
          SELECT id FROM contents WHERE achievement_code = ? ORDER BY id DESC LIMIT 3
        `).all(w.achievement_code);
        w.recommendedContentIds = cs.map(c => c.id);
        cs.forEach(c => recommendedContentIds.push(c.id));
      } catch (_) { w.recommendedContentIds = []; }
    }

    // 강점 TOP5
    const strengths = db.prepare(`
      SELECT achievement_code, subject_code, attempt_count, avg_score, last_level
      FROM lrs_achievement_stats
      WHERE user_id = ? AND attempt_count >= 3
      ORDER BY COALESCE(avg_score, 0) DESC
      LIMIT 5
    `).all(userId);

    // 교과별 비중 (최근 30일)
    const subjectBalance = db.prepare(`
      SELECT subject_code,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) as duration_sec,
        COUNT(*) as count
      FROM learning_logs
      WHERE user_id = ? AND subject_code IS NOT NULL
        AND DATE(created_at) >= DATE('now','-30 days')
      GROUP BY subject_code ORDER BY duration_sec DESC
    `).all(userId);

    res.json({
      success: true,
      userId,
      asOf: new Date().toISOString(),
      snapshot: {
        streakDays,
        weeklyDurationMin: Math.round((weekly.dur || 0) / 60),
        weeklyTarget: LRS_CONFIG.weeklyTargetMin,
        weeklyScoreAvg: weekly.avg_score,
        engagementIndex: streakDays >= 7 ? 0.9 : (streakDays / 7)
      },
      strengths,
      weaknesses,
      subjectBalance,
      recommendedContentIds: [...new Set(recommendedContentIds)].slice(0, 10)
    });
  } catch (err) {
    console.error('[LRS] /insights error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 2. GET /api/lrs/live-feed?limit=20
router.get('/live-feed', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    let where = 'WHERE 1=1';
    const params = [];
    // 권한: 일반 학생은 본인 클래스 소속 활동만
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      where += ' AND ll.user_id = ?';
      params.push(req.user.id);
    }
    if (classId) {
      where += ' AND ll.class_id = ?';
      params.push(classId);
    }
    const events = db.prepare(`
      SELECT ll.id, ll.created_at as ts, ll.user_id, u.display_name,
        ll.activity_type, ll.verb, ll.result_score, ll.subject_code,
        ll.achievement_code, ll.class_id, ll.source_service
      FROM learning_logs ll
      LEFT JOIN users u ON u.id = ll.user_id
      ${where}
      ORDER BY ll.created_at DESC LIMIT ?
    `).all(...params, limit);
    res.json({ success: true, events });
  } catch (err) {
    console.error('[LRS] /live-feed error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 3. GET /api/lrs/achievement-progress?userId=|classId=
router.get('/achievement-progress', requireAuth, (req, res) => {
  try {
    const userId = req.query.userId ? parseInt(req.query.userId) : null;
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    const subjectCode = req.query.subjectCode || null;

    if (userId && !canViewUser(req, userId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    if (classId && !canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    let standards;
    if (userId) {
      let where = 'WHERE user_id = ?';
      const params = [userId];
      if (subjectCode) { where += ' AND subject_code = ?'; params.push(subjectCode); }
      standards = db.prepare(`
        SELECT achievement_code as code, subject_code, attempt_count as attempts,
          success_count as success, avg_score, last_level as level, last_attempt_at as lastAt
        FROM lrs_achievement_stats
        ${where}
        ORDER BY attempt_count DESC
      `).all(...params);
    } else if (classId) {
      let where = 'WHERE ll.class_id = ? AND ll.achievement_code IS NOT NULL';
      const params = [classId];
      if (subjectCode) { where += ' AND ll.subject_code = ?'; params.push(subjectCode); }
      standards = db.prepare(`
        SELECT ll.achievement_code as code, ll.subject_code,
          COUNT(*) as attempts,
          SUM(CASE WHEN ll.result_success = 1 THEN 1 ELSE 0 END) as success,
          AVG(ll.result_score) as avg_score,
          CASE
            WHEN COUNT(*) < 3 THEN '미도달'
            WHEN AVG(ll.result_score) IS NULL THEN '미도달'
            WHEN AVG(CASE WHEN ll.result_score > 1 THEN ll.result_score/100.0 ELSE ll.result_score END) >= 0.80 THEN '상'
            WHEN AVG(CASE WHEN ll.result_score > 1 THEN ll.result_score/100.0 ELSE ll.result_score END) >= 0.50 THEN '중'
            ELSE '하'
          END as level,
          MAX(ll.created_at) as lastAt
        FROM learning_logs ll
        ${where}
        GROUP BY ll.achievement_code
        ORDER BY attempts DESC
      `).all(...params);
    } else {
      // 기본: 요청 사용자 본인
      standards = db.prepare(`
        SELECT achievement_code as code, subject_code, attempt_count as attempts,
          success_count as success, avg_score, last_level as level, last_attempt_at as lastAt
        FROM lrs_achievement_stats
        WHERE user_id = ?
        ORDER BY attempt_count DESC
      `).all(req.user.id);
    }

    const summary = { total: standards.length, 상: 0, 중: 0, 하: 0, 미도달: 0 };
    standards.forEach(s => { if (summary[s.level] !== undefined) summary[s.level]++; });
    // level 키 래핑
    const distribution = {
      high: summary['상'], mid: summary['중'], low: summary['하'], notYet: summary['미도달'], total: summary.total
    };

    res.json({ success: true, standards, distribution });
  } catch (err) {
    console.error('[LRS] /achievement-progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 4. GET /api/lrs/parent/:childId/digest?period=7d
router.get('/parent/:childId/digest', requireAuth, (req, res) => {
  try {
    const childId = parseInt(req.params.childId);
    // 학부모 관계 검증: users 테이블에 parent_of 관계가 있으면 사용. 기본적으로는 admin/teacher/본인 허용.
    let allowed = canViewUser(req, childId);
    if (!allowed && req.user.role === 'parent') {
      try {
        const rel = db.prepare("SELECT 1 FROM users WHERE id = ? AND parent_id = ?").get(childId, req.user.id);
        if (rel) allowed = true;
      } catch (_) {}
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    const r = dateRangeWhere(req, 'created_at');
    if (r.invalid) return sendInvalidPeriod(res, r.reason);

    // 총 학습량
    const totals = db.prepare(`
      SELECT COUNT(*) as activities,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) as durSec,
        AVG(result_score) as avg_score,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM learning_logs WHERE user_id = ? ${r.where}
    `).get(childId, ...r.params);

    // 교과별
    const bySubject = db.prepare(`
      SELECT subject_code,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)),0) as dur,
        COUNT(*) as count, AVG(result_score) as avg_score
      FROM learning_logs WHERE user_id = ? AND subject_code IS NOT NULL ${r.where}
      GROUP BY subject_code ORDER BY dur DESC
    `).all(childId, ...r.params);

    // 활동 유형별
    const byType = db.prepare(`
      SELECT activity_type, COUNT(*) as count
      FROM learning_logs WHERE user_id = ? ${r.where}
      GROUP BY activity_type ORDER BY count DESC
    `).all(childId, ...r.params);

    // 약점 TOP3
    const weaknesses = db.prepare(`
      SELECT achievement_code, attempt_count, avg_score, last_level
      FROM lrs_achievement_stats
      WHERE user_id = ? AND attempt_count >= 1
      ORDER BY COALESCE(avg_score,0) ASC LIMIT 3
    `).all(childId);

    // P1-S-01: parent role은 점수 원값 마스킹 → 성취수준 레이블
    const isParent = req.user.role === 'parent';
    const maskedBySubject = isParent
      ? bySubject.map(s => ({ ...s, avg_score: undefined, level: maskDigestScore(s.avg_score) }))
      : bySubject;
    const maskedWeak = isParent
      ? weaknesses.map(w => ({ ...w, avg_score: undefined, level: w.last_level || maskDigestScore(w.avg_score) }))
      : weaknesses;

    res.json({
      success: true,
      childId,
      period: { from: r.fromDate, to: r.toDate },
      totals: {
        activities: totals.activities,
        durationMin: Math.round((totals.durSec || 0) / 60),
        avgScore: isParent ? undefined : totals.avg_score,
        level: isParent ? maskDigestScore(totals.avg_score) : undefined,
        activeDays: totals.active_days
      },
      bySubject: maskedBySubject, byType, weaknesses: maskedWeak
    });
  } catch (err) {
    console.error('[LRS] /parent/digest error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 5. POST /api/lrs/session/start
router.post('/session/start', requireAuth, (req, res) => {
  try {
    // session_id 는 VARCHAR(40) 수용. hex 32자(16 bytes)로 충분.
    const sessionId = crypto.randomBytes(LRS_CONFIG.sessionIdBytes).toString('hex');
    const { classId, deviceType, platform } = req.body || {};
    db.prepare(`
      INSERT INTO lrs_session_stats (session_id, user_id, class_id, started_at, activity_count, device_type)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0, ?)
    `).run(sessionId, req.user.id, classId || null, deviceType || null);
    res.json({ success: true, session_id: sessionId, sessionId });
  } catch (err) {
    console.error('[LRS] /session/start error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 6. POST /api/lrs/session/end
router.post('/session/end', requireAuth, (req, res) => {
  try {
    const { sessionId, session_id } = req.body || {};
    const sid = sessionId || session_id;
    if (!sid) return res.status(400).json({ success: false, message: 'sessionId가 필요합니다.' });
    const row = db.prepare('SELECT * FROM lrs_session_stats WHERE session_id = ?').get(sid);
    if (!row) return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    if (row.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    // 세션 동안 쌓인 로그에서 duration 합산
    const agg = db.prepare(`
      SELECT COUNT(*) as cnt,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as dur,
        GROUP_CONCAT(DISTINCT source_service) as services
      FROM learning_logs WHERE session_id = ?
    `).get(sid);
    // P1-F-04: duration 합계가 0이면 session 테이블 started_at ~ now 차이로 fallback
    let durSec = agg.dur || 0;
    if (!durSec) {
      try {
        const diff = db.prepare(`
          SELECT CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) as sec
          FROM lrs_session_stats WHERE session_id = ?
        `).get(sid);
        if (diff && diff.sec > 0 && diff.sec < 86400 * 2) durSec = diff.sec;
      } catch (_) {}
    }
    db.prepare(`
      UPDATE lrs_session_stats
      SET ended_at = CURRENT_TIMESTAMP,
          duration_sec = ?,
          activity_count = ?,
          services_touched = ?
      WHERE session_id = ?
    `).run(durSec, agg.cnt || 0, agg.services || null, sid);
    res.json({ success: true, sessionId: sid, durationSec: durSec, activityCount: agg.cnt || 0 });
  } catch (err) {
    console.error('[LRS] /session/end error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 7. GET /api/lrs/warnings/:classId
router.get('/warnings/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!canViewClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // M-3: 단일 JOIN 쿼리로 멤버 + 마지막 활동일 조회 (기존 N+1 제거)
    const memberRows = db.prepare(`
      SELECT u.id as user_id, u.display_name,
        (SELECT MAX(DATE(ll.created_at)) FROM learning_logs ll WHERE ll.user_id = u.id) as last_date
      FROM class_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = ? AND (cm.role = 'student' OR u.role = 'student')
    `).all(classId);

    const inactive = [];
    const noData = [];   // P0-F-02: 로그 0건 학생 별도 라벨
    for (const m of memberRows) {
      if (!m.last_date) {
        noData.push({ userId: m.user_id, displayName: m.display_name, status: 'no_data' });
        continue;
      }
      const diff = db.prepare("SELECT CAST((julianday('now') - julianday(?)) AS INTEGER) as days").get(m.last_date).days;
      if (diff >= 3) {
        inactive.push({ userId: m.user_id, displayName: m.display_name, lastDate: m.last_date, daysInactive: diff });
      }
    }

    // 연속 오답 일괄 조회 — 최근 10건 이내 선두 연속 0 개수 집계
    const wrongRows = db.prepare(`
      SELECT user_id, result_success, created_at,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
      FROM learning_logs
      WHERE class_id = ? AND result_success IS NOT NULL
        AND user_id IN (SELECT cm.user_id FROM class_members cm WHERE cm.class_id = ?)
    `).all(classId, classId);
    const streakByUser = new Map();
    // 사용자별 첫 10건까지만 고려, 선두 연속 0 카운트
    const buckets = new Map();
    for (const row of wrongRows) {
      if (row.rn > 10) continue;
      if (!buckets.has(row.user_id)) buckets.set(row.user_id, []);
      buckets.get(row.user_id).push(row);
    }
    for (const [uid, rows] of buckets.entries()) {
      rows.sort((a,b) => a.rn - b.rn);
      let s = 0;
      for (const r of rows) {
        if (r.result_success === 0) s++;
        else break;
      }
      if (s >= 3) streakByUser.set(uid, s);
    }
    const consecutiveWrong = [];
    for (const m of memberRows) {
      const s = streakByUser.get(m.user_id);
      if (s) consecutiveWrong.push({ userId: m.user_id, displayName: m.display_name, wrongStreak: s });
    }

    // 결손 성취기준 — 클래스 멤버 전체 한 번에
    const weakRows = db.prepare(`
      SELECT las.user_id, u.display_name, las.achievement_code, las.avg_score, las.last_level, las.attempt_count
      FROM lrs_achievement_stats las
      JOIN users u ON u.id = las.user_id
      WHERE las.user_id IN (SELECT cm.user_id FROM class_members cm WHERE cm.class_id = ?)
        AND (las.last_level = '하' OR las.last_level = '미도달')
      ORDER BY las.user_id, COALESCE(las.avg_score, 0) ASC
    `).all(classId);
    const weakMap = new Map();
    for (const w of weakRows) {
      if (!weakMap.has(w.user_id)) weakMap.set(w.user_id, { userId: w.user_id, displayName: w.display_name, items: [] });
      const rec = weakMap.get(w.user_id);
      if (rec.items.length < 5) rec.items.push({
        achievement_code: w.achievement_code, avg_score: w.avg_score, last_level: w.last_level, attempt_count: w.attempt_count
      });
    }
    const weakAchievements = Array.from(weakMap.values());

    res.json({
      success: true, classId,
      inactive, noData, consecutiveWrong, weakAchievements,
      summary: {
        inactiveCount: inactive.length,
        noDataCount: noData.length,
        consecutiveWrongCount: consecutiveWrong.length,
        weakCount: weakAchievements.length
      }
    });
  } catch (err) {
    console.error('[LRS] /warnings error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 8. /api/lrs/export — 위에서 이미 format=csv|excel|xlsx|jsonld|xapi|json 지원

module.exports = router;
