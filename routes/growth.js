const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const growthDb = require('../db/growth');
const classDb = require('../db/class');
const growthExtDb = require('../db/growth-extended');

// ===== 포트폴리오 =====

// GET /api/growth/portfolios - 내 포트폴리오
router.get('/portfolios', requireAuth, (req, res) => {
  try {
    const result = growthDb.getStudentPortfolios(req.user.id, {
      classId: req.query.classId ? parseInt(req.query.classId) : null,
      category: req.query.category,
      page: parseInt(req.query.page) || 1
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] portfolios error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/portfolios - 포트폴리오 생성
router.post('/portfolios', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    const portfolio = growthDb.createPortfolio(req.user.id, req.body);
    res.status(201).json({ success: true, portfolio });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/portfolios/:id
router.get('/portfolios/:id', requireAuth, (req, res) => {
  try {
    const portfolio = growthDb.getPortfolioById(parseInt(req.params.id));
    if (!portfolio) return res.status(404).json({ success: false, message: '포트폴리오를 찾을 수 없습니다.' });
    res.json({ success: true, portfolio });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/growth/portfolios/:id
router.put('/portfolios/:id', requireAuth, (req, res) => {
  try {
    const portfolio = growthDb.getPortfolioById(parseInt(req.params.id));
    if (!portfolio) return res.status(404).json({ success: false, message: '포트폴리오를 찾을 수 없습니다.' });
    if (portfolio.student_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const updated = growthDb.updatePortfolio(portfolio.id, req.body);
    res.json({ success: true, portfolio: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/growth/portfolios/:id
router.delete('/portfolios/:id', requireAuth, (req, res) => {
  try {
    const portfolio = growthDb.getPortfolioById(parseInt(req.params.id));
    if (!portfolio) return res.status(404).json({ success: false, message: '포트폴리오를 찾을 수 없습니다.' });
    if (portfolio.student_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    growthDb.deletePortfolio(portfolio.id);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 성장 리포트 =====

// GET /api/growth/summary - 내 성장 요약
router.get('/summary', requireAuth, (req, res) => {
  try {
    const summary = growthDb.getStudentGrowthSummary(req.user.id);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/class/:classId - 클래스 성장 현황 (교사용)
router.get('/class/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const myRole = classDb.getMemberRole(classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }
    const overview = growthDb.getClassGrowthOverview(classId);
    res.json({ success: true, overview });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 갤러리 =====

// GET /api/growth/gallery - 갤러리 목록
router.get('/gallery', requireAuth, (req, res) => {
  try {
    const result = growthDb.getGalleryItems({
      studentId: req.query.mine === 'true' ? req.user.id : null,
      category: req.query.category,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      includeAll: req.query.includeAll === 'true' && ['teacher', 'admin'].includes(req.user.role)
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery - 갤러리 작품 등록
router.post('/gallery', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    const item = growthDb.createGalleryItem(req.user.id, req.body);
    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/like - 좋아요
router.post('/gallery/:id/like', requireAuth, (req, res) => {
  try {
    const item = growthDb.likeGalleryItem(parseInt(req.params.id));
    res.json({ success: true, like_count: item.like_count });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/approve - 작품 승인
router.post('/gallery/:id/approve', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 승인할 수 있습니다.' });
    }
    growthDb.approveGalleryItem(parseInt(req.params.id), req.user.id);
    res.json({ success: true, message: '승인되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/reject - 작품 반려
router.post('/gallery/:id/reject', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 반려할 수 있습니다.' });
    }
    growthDb.rejectGalleryItem(parseInt(req.params.id));
    res.json({ success: true, message: '반려되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 포트폴리오 아카이브 (확장) =====

router.get('/portfolio/items', requireAuth, (req, res) => {
  try {
    const userId = (req.user.role === 'teacher' || req.user.role === 'admin') && req.query.userId
      ? parseInt(req.query.userId)
      : req.user.id;
    const result = growthExtDb.getPortfolioItems(userId, req.query);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/portfolio/items/:id', requireAuth, (req, res) => {
  try {
    const detail = growthExtDb.getPortfolioItemDetail(parseInt(req.params.id));
    if (!detail) return res.status(404).json({ success: false, message: '항목을 찾을 수 없습니다.' });
    if (req.user.role === 'student' && detail.item && detail.item.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
    }
    res.json({ success: true, ...detail });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/portfolio/items/:id/life-task', requireAuth, (req, res) => {
  try {
    const result = growthExtDb.toggleLifeTask(parseInt(req.params.id), req.user.id);
    if (!result) return res.status(404).json({ success: false, message: '항목을 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/portfolio/items/:id/reflection', requireAuth, (req, res) => {
  try {
    growthExtDb.saveReflection(parseInt(req.params.id), req.user.id, req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/portfolio/items/:id/privacy', requireAuth, (req, res) => {
  try {
    growthExtDb.updatePrivacy(parseInt(req.params.id), req.user.id, req.body.isPublic);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/portfolio/stats', requireAuth, (req, res) => {
  try {
    const userId = (req.user.role === 'teacher' || req.user.role === 'admin') && req.query.userId
      ? parseInt(req.query.userId)
      : req.user.id;
    const stats = growthExtDb.getPortfolioStats(userId);
    res.json({ success: true, ...stats });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/portfolio/goals', requireAuth, (req, res) => {
  try {
    const userId = (req.user.role === 'teacher' || req.user.role === 'admin') && req.query.userId
      ? parseInt(req.query.userId)
      : req.user.id;
    const goals = growthExtDb.getGrowthGoals(userId);
    res.json({ success: true, goals });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/portfolio/goals', requireAuth, (req, res) => {
  try {
    const result = growthExtDb.createGrowthGoal(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// ===== 성장보고서 (확장) =====

router.get('/report/class/:classId', requireAuth, (req, res) => {
  try {
    // 교사/관리자만 클래스 대시보드 접근 가능
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 접근 가능합니다.' });
    }
    const data = growthExtDb.getClassDashboard(parseInt(req.params.classId), req.user.id, req.query);
    res.json({ success: true, ...data });
  } catch (err) { console.error('[GROWTH] class dashboard error:', err); res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// 교사: 특정 학생의 오늘의학습 항목 정오답 결과 조회
router.get('/report/student/:studentId/daily-item/:itemId/result', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 접근 가능합니다.' });
    }
    const selfLearnDb = require('../db/self-learn-extended');
    const studentId = parseInt(req.params.studentId);
    const itemId = parseInt(req.params.itemId);
    const result = selfLearnDb.getDailyItemResult(itemId, studentId);
    if (!result) return res.status(404).json({ success: false, message: '항목을 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] daily-item result error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 교사: 특정 학생의 특정 날짜 오늘의학습 진행 항목 목록 (set 단위)
router.get('/report/student/:studentId/daily-set/:setId/items', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 접근 가능합니다.' });
    }
    const studentId = parseInt(req.params.studentId);
    const setId = parseInt(req.params.setId);
    const db = require('../db/index');
    const items = db.prepare(`
      SELECT i.id, i.item_title, i.source_type, i.content_id, i.sort_order,
             p.status, p.score, p.completed_at, p.correct_count, p.total_questions, p.answers_json
      FROM daily_learning_items i
      LEFT JOIN daily_learning_progress p ON p.item_id = i.id AND p.user_id = ?
      WHERE i.set_id = ?
      ORDER BY i.sort_order, i.id
    `).all(studentId, setId);
    const set = db.prepare('SELECT id, title, target_date, target_subject FROM daily_learning_sets WHERE id = ?').get(setId);
    const student = db.prepare('SELECT id, display_name, username FROM users WHERE id = ?').get(studentId);
    res.json({ success: true, set, student, items });
  } catch (err) {
    console.error('[GROWTH] daily-set items error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 클래스별 오늘의학습 상세 (날짜별 학생 참여 현황)
router.get('/report/class/:classId/daily-learning', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 접근 가능합니다.' });
    }
    const { period, startDate, endDate } = req.query;
    const data = growthExtDb.getClassDailyLearning(parseInt(req.params.classId), { period, startDate, endDate });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[GROWTH] daily-learning error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.get('/report/student/:studentId', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    // 학생은 자신의 리포트만 조회 가능
    if (req.user.role === 'student' && req.user.id !== studentId) {
      return res.status(403).json({ success: false, message: '본인의 리포트만 조회 가능합니다.' });
    }
    const report = growthExtDb.getStudentReport(studentId, req.query);
    res.json({ success: true, report });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/report/student/:studentId/area/:areaName', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    if (req.user.role === 'student' && req.user.id !== studentId) {
      return res.status(403).json({ success: false, message: '본인의 리포트만 조회 가능합니다.' });
    }
    const data = growthExtDb.getStudentReportArea(studentId, req.params.areaName, req.query);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/report/observation', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 관찰 기록을 작성할 수 있습니다.' });
    }
    const result = growthExtDb.createObservation(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/report/observations/:studentId', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    if (req.user.role === 'student' && req.user.id !== studentId) {
      return res.status(403).json({ success: false, message: '본인의 기록만 조회 가능합니다.' });
    }
    const observations = growthExtDb.getObservations(studentId, req.query.classId ? parseInt(req.query.classId) : null);
    res.json({ success: true, observations });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/report/visibility/:studentId', requireAuth, (req, res) => {
  try {
    growthExtDb.setReportVisibility(req.user.id, parseInt(req.params.studentId), req.body.classId || 0, req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/report/parent/:studentId', requireAuth, (req, res) => {
  try {
    const report = growthExtDb.getParentReport(parseInt(req.params.studentId));
    res.json({ success: true, report });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// ===== 독서 기록 =====

router.get('/reading', requireAuth, (req, res) => {
  try {
    // 교사/관리자가 studentId 파라미터로 학생 독서기록 조회 가능
    let targetUserId = req.user.id;
    if (req.query.studentId && (req.user.role === 'teacher' || req.user.role === 'admin')) {
      targetUserId = parseInt(req.query.studentId);
    }
    const result = growthExtDb.getReadingLogs(targetUserId, req.query);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/reading', requireAuth, (req, res) => {
  try {
    if (!req.body.bookTitle) return res.status(400).json({ success: false, message: '책 제목을 입력하세요.' });
    const result = growthExtDb.addReadingLog(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/reading/:id', requireAuth, (req, res) => {
  try {
    if (!req.body.bookTitle) return res.status(400).json({ success: false, message: '책 제목을 입력하세요.' });
    const result = growthExtDb.updateReadingLog(req.user.id, parseInt(req.params.id), req.body);
    if (!result) return res.status(404).json({ success: false, message: '독서 기록을 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.delete('/reading/:id', requireAuth, (req, res) => {
  try {
    const result = growthExtDb.deleteReadingLog(req.user.id, parseInt(req.params.id));
    if (!result) return res.status(404).json({ success: false, message: '독서 기록을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// ===== 진로탐색 기록 =====

router.get('/career', requireAuth, (req, res) => {
  try {
    const result = growthExtDb.getCareerLogs(req.user.id, req.query);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/career', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '활동 제목을 입력하세요.' });
    const result = growthExtDb.addCareerLog(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/career/:id', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '활동 제목을 입력하세요.' });
    const result = growthExtDb.updateCareerLog(req.user.id, parseInt(req.params.id), req.body);
    if (!result) return res.status(404).json({ success: false, message: '진로 기록을 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.delete('/career/:id', requireAuth, (req, res) => {
  try {
    const result = growthExtDb.deleteCareerLog(req.user.id, parseInt(req.params.id));
    if (!result) return res.status(404).json({ success: false, message: '진로 기록을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// ===== 감정 체크 (출석 독립) =====
router.post('/emotion-checkin', requireAuth, (req, res) => {
  try {
    const { emotion, emotionReason, emotionScore, classId } = req.body;
    const validEmotions = ['happy', 'excited', 'good', 'great', 'calm', 'sad', 'angry', 'anxious', 'tired', 'frustrated'];
    if (!emotion || !validEmotions.includes(emotion)) {
      return res.status(400).json({ success: false, message: '유효하지 않은 감정입니다.' });
    }
    // emotionScore 유효성: 1.0~10.0 범위
    let score = emotionScore != null ? parseFloat(emotionScore) : null;
    if (score != null && (isNaN(score) || score < 1 || score > 10)) score = null;
    // 감정은 학생 단위 상태이므로 classId 미제공 시 ingestEmotion이
    // 학생이 속한 모든 활성 클래스에 UPSERT 한다.
    const result = growthExtDb.ingestEmotion({
      userId: req.user.id,
      classId: classId ? parseInt(classId) : null,
      emotion,
      emotionReason: emotionReason || null,
      emotionScore: score,
      date: new Date().toISOString().slice(0, 10)
    });
    res.json({ success: true, id: result.id, classCount: result.classCount });
  } catch (err) {
    console.error('[GROWTH] emotion-checkin error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 오늘 감정 체크 여부 조회
router.get('/emotion-today', requireAuth, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const record = require('../db/index').prepare(
      'SELECT emotion, emotion_reason, emotion_score FROM attendance WHERE user_id = ? AND attendance_date = ? AND emotion IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get(req.user.id, today);
    res.json({ success: true, hasChecked: !!record, emotion: record?.emotion || null, reason: record?.emotion_reason || null, emotionScore: record?.emotion_score != null ? record.emotion_score : null });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 감정 기록 히스토리 조회 (학생 본인)
router.get('/emotion-history', requireAuth, (req, res) => {
  try {
    const db = require('../db/index');
    const limit = parseInt(req.query.limit) || 30;
    const records = db.prepare(`
      SELECT attendance_date, emotion, emotion_reason, emotion_score
      FROM attendance
      WHERE user_id = ? AND emotion IS NOT NULL
      ORDER BY attendance_date DESC
      LIMIT ?
    `).all(req.user.id, limit);

    // 주간 감정 통계 (최근 7일)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStart = weekAgo.toISOString().slice(0, 10);
    const weekStats = db.prepare(`
      SELECT emotion, COUNT(*) as cnt
      FROM attendance
      WHERE user_id = ? AND emotion IS NOT NULL AND attendance_date >= ?
      GROUP BY emotion ORDER BY cnt DESC
    `).all(req.user.id, weekStart);

    // 총 체크인 수 + 연속 체크인 일수
    const totalCheckins = db.prepare(
      'SELECT COUNT(DISTINCT attendance_date) as cnt FROM attendance WHERE user_id = ? AND emotion IS NOT NULL'
    ).get(req.user.id).cnt;

    // 연속일수 계산
    const dates = db.prepare(
      'SELECT DISTINCT attendance_date FROM attendance WHERE user_id = ? AND emotion IS NOT NULL ORDER BY attendance_date DESC'
    ).all(req.user.id).map(r => r.attendance_date);
    let streak = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < dates.length; i++) {
      const expected = new Date();
      expected.setDate(expected.getDate() - i);
      if (dates[i] === expected.toISOString().slice(0, 10)) {
        streak++;
      } else break;
    }

    // 긍정 감정 비율
    const positiveEmotions = ['happy', 'excited', 'good', 'great', 'calm'];
    const positiveCount = records.filter(r => positiveEmotions.includes(r.emotion)).length;
    const positiveRate = records.length > 0 ? Math.round(positiveCount / records.length * 100) : 0;

    res.json({
      success: true,
      records,
      weekStats,
      totalCheckins,
      streak,
      positiveRate
    });
  } catch (err) {
    console.error('[GROWTH] emotion-history error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 교사용 학급 감정 모니터링 상세 데이터
router.get('/emotion-monitor/:classId', requireAuth, (req, res) => {
  try {
    const db = require('../db/index');
    const classId = parseInt(req.params.classId);
    const today = new Date().toISOString().slice(0, 10);
    const positiveEmotions = ['happy', 'excited', 'good', 'great', 'calm'];

    // 날짜 필터 (query params)
    const qStart = req.query.startDate;
    const qEnd = req.query.endDate;
    const filterDate = qStart || today; // 단일 날짜 또는 시작일
    const filterEndDate = qEnd || filterDate; // 종료일
    const isRange = !!(qStart && qEnd);

    // 1. 해당 기간 감정 기록한 학생별 목록
    let dateWhere, dateParams;
    if (isRange) {
      dateWhere = 'a.attendance_date BETWEEN ? AND ?';
      dateParams = [classId, qStart, qEnd];
    } else {
      dateWhere = 'a.attendance_date = ?';
      dateParams = [classId, filterDate];
    }

    const periodEmotions = db.prepare(`
      SELECT a.user_id, u.display_name, a.emotion, a.emotion_reason, a.attendance_date
      FROM attendance a JOIN users u ON a.user_id = u.id
      WHERE a.class_id = ? AND a.emotion IS NOT NULL AND ${dateWhere}
      ORDER BY a.attendance_date DESC, a.id DESC
    `).all(...dateParams);

    // 중복 제거 (같은 학생 여러 기록 중 최신만)
    const seen = new Set();
    const uniqueToday = periodEmotions.filter(e => { if (seen.has(e.user_id)) return false; seen.add(e.user_id); return true; });

    // 2. 감정 분포
    const emotionDist = {};
    uniqueToday.forEach(e => { emotionDist[e.emotion] = (emotionDist[e.emotion] || 0) + 1; });

    // 3. 학급 전체 학생 수
    const totalStudents = db.prepare(
      "SELECT COUNT(*) as cnt FROM class_members WHERE class_id = ? AND role = 'member'"
    ).get(classId).cnt;

    // 4. 추이 분석 기간 설정 (기간 검색 시 해당 범위, 아닐 경우 최근 30일 ~ 오늘)
    let startDate, endDate;
    if (isRange) {
      startDate = qStart;
      endDate = qEnd;
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      startDate = thirtyDaysAgo.toISOString().slice(0, 10);
      endDate = today;
    }

    const recentEmotions = db.prepare(`
      SELECT a.user_id, u.display_name, a.emotion, a.attendance_date, a.checked_at, a.emotion_score
      FROM attendance a JOIN users u ON a.user_id = u.id
      WHERE a.class_id = ? AND a.emotion IS NOT NULL AND a.attendance_date >= ? AND a.attendance_date <= ?
      ORDER BY a.attendance_date ASC
    `).all(classId, startDate, endDate);

    // 5. 학생별 감정 통계 (주의 학생 파악)
    const studentStats = {};
    recentEmotions.forEach(e => {
      if (!studentStats[e.user_id]) {
        studentStats[e.user_id] = { name: e.display_name, emotions: [], dates: [], checkedAts: [], emotionScores: [], positiveCount: 0, totalCount: 0 };
      }
      const s = studentStats[e.user_id];
      s.emotions.push(e.emotion);
      s.dates.push(e.attendance_date);
      s.checkedAts.push(e.checked_at || null);
      s.emotionScores.push(e.emotion_score != null ? e.emotion_score : null);
      s.totalCount++;
      if (positiveEmotions.includes(e.emotion)) s.positiveCount++;
    });

    // 주의 필요 학생: 최근 3일 연속 부정 감정
    const alertStudents = [];
    Object.entries(studentStats).forEach(([userId, s]) => {
      const last3 = s.emotions.slice(-3);
      if (last3.length >= 3 && last3.every(e => !positiveEmotions.includes(e))) {
        alertStudents.push({ userId: parseInt(userId), name: s.name, emotion: last3[last3.length - 1], days: 3, type: 'consecutive_negative' });
      }
      // 급격한 감정 하락 감지
      if (s.emotions.length >= 2) {
        const scoreMap = { happy: 9, excited: 9, great: 8, good: 7, calm: 5, tired: 3, sad: 2, angry: 2, anxious: 3, frustrated: 2 };
        const recent = s.emotions.slice(-1)[0];
        const prev = s.emotions.slice(-3, -1);
        const prevAvg = prev.length > 0 ? prev.reduce((sum, e) => sum + (scoreMap[e] || 5), 0) / prev.length : 5;
        const recentScore = scoreMap[recent] || 5;
        if (prevAvg - recentScore >= 4) {
          alertStudents.push({ userId: parseInt(userId), name: s.name, emotion: recent, drop: Math.round(prevAvg - recentScore), type: 'sudden_drop' });
        }
      }
    });

    // 6. 감정 클러스터 분석
    const clusterDef = [
      { id: 'positive', label: '긍정 그룹', emotions: positiveEmotions, color: '#4caf50' },
      { id: 'watch', label: '관찰 필요', emotions: ['tired', 'anxious'], color: '#ff9800' },
      { id: 'help', label: '도움 필요', emotions: ['sad', 'angry', 'frustrated'], color: '#f44336' }
    ];
    const clusters = clusterDef.map(cl => {
      const students = new Set();
      uniqueToday.filter(e => cl.emotions.includes(e.emotion)).forEach(e => students.add(e.user_id));
      return { ...cl, count: students.size, studentNames: [...students].map(uid => uniqueToday.find(e => e.user_id === uid)?.display_name).filter(Boolean) };
    });

    // 7. 감정 점수 매핑 (Feelings Stairs용)
    const emotionLevel = { happy: 5, excited: 5, great: 5, good: 4, calm: 3, tired: 2, anxious: 2, sad: 1, angry: 1, frustrated: 1 };
    const stairsData = uniqueToday.map(e => ({
      userId: e.user_id,
      name: e.display_name,
      emotion: e.emotion,
      reason: e.emotion_reason,
      level: emotionLevel[e.emotion] || 3
    }));

    res.json({
      success: true,
      today: isRange ? `${qStart} ~ ${qEnd}` : filterDate,
      filterStart: isRange ? qStart : null,
      filterEnd: isRange ? qEnd : null,
      totalStudents,
      checkedCount: uniqueToday.length,
      emotionDist,
      stairsData,
      alertStudents,
      clusters,
      studentTimeline: Object.entries(studentStats).map(([uid, s]) => ({
        userId: parseInt(uid), name: s.name,
        positiveRate: s.totalCount > 0 ? Math.round(s.positiveCount / s.totalCount * 100) : 0,
        totalCount: s.totalCount,
        lastEmotion: s.emotions[s.emotions.length - 1],
        timeline: s.dates.map((d, i) => ({ date: d, emotion: s.emotions[i], checkedAt: s.checkedAts[i] || null, emotionScore: s.emotionScores[i] != null ? s.emotionScores[i] : null }))
      }))
    });
  } catch (err) {
    console.error('[GROWTH] emotion-monitor error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
