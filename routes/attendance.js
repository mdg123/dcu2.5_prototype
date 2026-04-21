const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const attendanceDb = require('../db/attendance');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');

// 클래스 멤버 확인 미들웨어
function requireMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  next();
}

// POST /api/attendance/:classId/checkin - 출석 체크 (감정 필드 제거)
router.post('/:classId/checkin', requireAuth, requireMember, (req, res) => {
  try {
    const { comment } = req.body;
    const result = attendanceDb.checkIn(req.classId, req.user.id, comment, 'manual');
    if (!result.success) {
      return res.status(409).json({ success: false, message: '오늘 이미 출석했습니다.' });
    }
    // 포인트 적립
    try {
      const { awardPoints } = require('../db/point-helper');
      awardPoints(req.user.id, { source: 'attendance', sourceId: result.id || null, points: 10, description: '출석 포인트' });
    } catch (e) {}
    const stats = attendanceDb.getUserStats(req.classId, req.user.id);
    logLearningActivity({
      userId: req.user.id,
      activityType: 'attendance_checkin',
      targetType: 'attendance',
      targetId: result.id || 0,
      classId: req.classId,
      verb: 'attended',
      sourceService: 'class',
      ...extractLogContext(req)
    });
    res.json({ success: true, message: '출석 완료!', ...stats });
  } catch (err) {
    console.error('[ATTENDANCE] checkin error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/status - 오늘 출석 상태 + 통계 (next_badge, 주/월 출석률 포함)
router.get('/:classId/status', requireAuth, requireMember, (req, res) => {
  try {
    const checked = attendanceDb.isCheckedIn(req.classId, req.user.id);
    const stats = attendanceDb.getUserStats(req.classId, req.user.id);
    res.json({ success: true, checkedIn: checked, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/ranking - 출석 랭킹
router.get('/:classId/ranking', requireAuth, requireMember, (req, res) => {
  try {
    const ranking = attendanceDb.getRanking(req.classId);
    const enriched = ranking.map((r, idx) => ({
      ...r,
      rank: idx + 1,
      streak: attendanceDb.getStreak(req.classId, r.user_id)
    }));
    res.json({ success: true, ranking: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/class-stats - 클래스 통계 (교사용)
router.get('/:classId/class-stats', requireAuth, requireMember, (req, res) => {
  try {
    const myRole = classDb.getMemberRole(req.classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }
    const stats = attendanceDb.getClassStats(req.classId);
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/table - 기간별 출석 테이블 (교사용, source 포함)
router.get('/:classId/table', requireAuth, requireMember, (req, res) => {
  try {
    const myRole = classDb.getMemberRole(req.classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }
    const { startDate, endDate, includeWeekends } = req.query;
    const start = startDate || getMonthStart();
    const end = endDate || new Date().toISOString().slice(0, 10);
    const table = attendanceDb.getAttendanceTable(req.classId, start, end, includeWeekends === 'true');
    res.json({ success: true, ...table });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/today - 오늘 출석 목록 (교사용)
router.get('/:classId/today', requireAuth, requireMember, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const records = attendanceDb.getAttendanceByDate(req.classId, today);
    res.json({ success: true, records, date: today });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/settings - 출석부 설정
router.get('/:classId/settings', requireAuth, requireMember, (req, res) => {
  try {
    const settings = attendanceDb.getSettings(req.classId);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/attendance/:classId/settings - 출석부 설정 변경
router.put('/:classId/settings', requireAuth, requireMember, (req, res) => {
  try {
    const myRole = classDb.getMemberRole(req.classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 변경 가능합니다.' });
    }
    const settings = attendanceDb.updateSettings(req.classId, req.body);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

function getMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

module.exports = router;
