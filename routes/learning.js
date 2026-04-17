const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const learningDb = require('../db/learning');

// ===== 오늘의 학습 =====

// GET /api/learning/today
router.get('/today', requireAuth, (req, res) => {
  try {
    const today = learningDb.getTodayLearning(req.user.id);
    res.json({ success: true, today });
  } catch (err) {
    console.error('[LEARNING] today error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/learning/today
router.put('/today', requireAuth, (req, res) => {
  try {
    const today = learningDb.updateTodayLearning(req.user.id, req.body);
    res.json({ success: true, today });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/learning/history
router.get('/history', requireAuth, (req, res) => {
  try {
    const records = learningDb.getLearningHistory(req.user.id, parseInt(req.query.days) || 7);
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 오답노트 =====

// GET /api/learning/wrong-answers
router.get('/wrong-answers', requireAuth, (req, res) => {
  try {
    const result = learningDb.getWrongAnswers(req.user.id, {
      subject: req.query.subject,
      page: parseInt(req.query.page) || 1,
      resolved: req.query.resolved !== undefined ? req.query.resolved === 'true' : undefined
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/learning/wrong-answers/stats
router.get('/wrong-answers/stats', requireAuth, (req, res) => {
  try {
    const stats = learningDb.getWrongAnswerStats(req.user.id);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/learning/wrong-answers
router.post('/wrong-answers', requireAuth, (req, res) => {
  try {
    const item = learningDb.addWrongAnswer(req.user.id, req.body);
    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/learning/wrong-answers/:id/resolve
router.put('/wrong-answers/:id/resolve', requireAuth, (req, res) => {
  try {
    const item = learningDb.resolveWrongAnswer(parseInt(req.params.id), req.user.id);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 학습맵 =====

// GET /api/learning/map/nodes
router.get('/map/nodes', requireAuth, (req, res) => {
  try {
    const nodes = learningDb.getLearningMapNodes({
      subject: req.query.subject,
      level: req.query.level ? parseInt(req.query.level) : null
    });
    res.json({ success: true, nodes });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/learning/map/progress
router.get('/map/progress', requireAuth, (req, res) => {
  try {
    const progress = learningDb.getUserMapProgress(req.user.id);
    res.json({ success: true, progress });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/learning/map/progress/:nodeId
router.post('/map/progress/:nodeId', requireAuth, (req, res) => {
  try {
    const progress = learningDb.updateNodeProgress(req.user.id, parseInt(req.params.nodeId), req.body);
    res.json({ success: true, progress });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 학습 목표 =====

// GET /api/learning/goals
router.get('/goals', requireAuth, (req, res) => {
  try {
    const goals = learningDb.getLearningGoals(req.user.id);
    res.json({ success: true, goals });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/learning/goals
router.post('/goals', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '목표를 입력하세요.' });
    const goal = learningDb.createLearningGoal(req.user.id, req.body);
    res.status(201).json({ success: true, goal });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/learning/goals/:id
router.put('/goals/:id', requireAuth, (req, res) => {
  try {
    const goal = learningDb.updateLearningGoal(parseInt(req.params.id), req.user.id, req.body);
    res.json({ success: true, goal });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/learning/goals/:id
router.delete('/goals/:id', requireAuth, (req, res) => {
  try {
    const db = require('../db/index');
    const id = parseInt(req.params.id);
    const goal = db.prepare('SELECT * FROM learning_goals WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!goal) return res.status(404).json({ success: false, message: '목표를 찾을 수 없습니다.' });
    db.prepare('DELETE FROM learning_goals WHERE id = ?').run(id);
    res.json({ success: true, message: '목표가 삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 관리자/교사 학습 배포 =====

const { requireRole } = require('../middleware/auth');

// POST /api/learning/assign/:classId - 교사/관리자가 클래스에 오늘의 학습 배포
router.post('/assign/:classId', requireAuth, requireRole('teacher', 'admin'), (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    const assignment = learningDb.createDailyAssignment(classId, req.user.id, req.body);
    res.status(201).json({ success: true, assignment });
  } catch (err) {
    console.error('[LEARNING] assign error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/learning/assign/:classId - 클래스 학습 배포 목록
router.get('/assign/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const result = learningDb.getClassAssignments(classId, { page: parseInt(req.query.page) || 1 });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/learning/assign-all - 관리자가 전체 클래스에 일괄 배포
router.post('/assign-all', requireAuth, requireRole('admin'), (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    const db = require('../db/index');
    const classes = db.prepare('SELECT id FROM classes').all();
    const assignments = [];
    for (const c of classes) {
      const assignment = learningDb.createDailyAssignment(c.id, req.user.id, req.body);
      assignments.push(assignment);
    }
    res.status(201).json({ success: true, message: `${assignments.length}개 클래스에 배포 완료`, assignments });
  } catch (err) {
    console.error('[LEARNING] assign-all error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/learning/assign/:classId/completion - 학습 배포 완료 현황 (교사용)
router.get('/assign/:classId/completion', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const db = require('../db/index');
    const classDb = require('../db/class');

    // 클래스 멤버 중 학생 목록
    const members = classDb.getClassMembers(classId).filter(m => m.role === 'student');
    // 해당 날짜의 학습 기록 조회
    const records = db.prepare(`
      SELECT dl.*, u.display_name FROM daily_learning dl
      JOIN users u ON dl.user_id = u.id
      WHERE dl.user_id IN (${members.map(m => m.user_id).join(',') || '0'})
      AND dl.learning_date = ?
    `).all(date);

    const recordMap = {};
    records.forEach(r => { recordMap[r.user_id] = r; });

    const completion = members.map(m => {
      const rec = recordMap[m.user_id];
      return {
        user_id: m.user_id,
        display_name: m.display_name,
        progress_percent: rec ? rec.progress_percent : 0,
        actual_time_minutes: rec ? rec.actual_time_minutes : 0,
        completed: rec ? rec.progress_percent >= 100 : false
      };
    });

    const completedCount = completion.filter(c => c.completed).length;
    res.json({
      success: true, date, completion,
      total: members.length, completed: completedCount,
      rate: members.length > 0 ? Math.round(completedCount / members.length * 100) : 0
    });
  } catch (err) {
    console.error('[LEARNING] completion error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
