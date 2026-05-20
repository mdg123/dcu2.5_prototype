// routes/class-mileage.js
// 클래스 마일리지 시스템 라우트
// 마운트: app.use('/api/class/:classId/mileage', requireAuth, classMileageRoutes)

const express = require('express');
const router = express.Router({ mergeParams: true });
const mileageDb = require('../db/class-mileage');
const classDb = require('../db/class');

// ──────────────────────────────────────────────────────────────────────────────
// 공통 미들웨어 — 클래스 멤버 검증 / 개설자 검증
// ──────────────────────────────────────────────────────────────────────────────
function requireClassMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classId || isNaN(classId)) {
    return res.status(400).json({ success: false, message: '잘못된 클래스 ID입니다.' });
  }
  if (!req.user) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  if (req.user.role === 'admin') {
    req.classId = classId;
    req.myRole = classDb.getMemberRole(classId, req.user.id) || 'admin';
    return next();
  }
  if (!classDb.isMember(classId, req.user.id)) {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근할 수 있습니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  next();
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (req.myRole !== 'owner') {
    return res.status(403).json({ success: false, message: '개설자(교사)만 수행할 수 있습니다.' });
  }
  next();
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. GET /me — 본인 마일리지 (잔액·누적·최근 로그·랭킹)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/me', requireClassMember, (req, res) => {
  try {
    const data = mileageDb.getMemberMileage(req.classId, req.user.id);
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[mileage GET me]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. GET /ranking — 클래스 랭킹 ?period=all|week|month&limit=20
// ──────────────────────────────────────────────────────────────────────────────
router.get('/ranking', requireClassMember, (req, res) => {
  try {
    const ranking = mileageDb.getRanking(req.classId, {
      period: req.query.period,
      limit: req.query.limit
    });
    res.json({ success: true, ranking });
  } catch (e) {
    console.error('[mileage GET ranking]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. GET /members — 교사용 전체 멤버 잔액 목록
// ──────────────────────────────────────────────────────────────────────────────
router.get('/members', requireClassMember, requireOwner, (req, res) => {
  try {
    const members = mileageDb.getMembersMileage(req.classId);
    res.json({ success: true, members });
  } catch (e) {
    console.error('[mileage GET members]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. GET /logs — 로그 조회 (필터·페이지네이션)
//    교사: 모든 멤버 / 학생: 본인만
// ──────────────────────────────────────────────────────────────────────────────
router.get('/logs', requireClassMember, (req, res) => {
  try {
    const opts = {
      page: req.query.page,
      limit: req.query.limit,
      reason: req.query.reason || null,
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
      direction: req.query.direction || null,
    };
    // 학생은 본인 로그만
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      opts.userId = req.user.id;
    } else if (req.query.userId) {
      opts.userId = parseInt(req.query.userId);
    }
    const data = mileageDb.getLogs(req.classId, opts);
    res.json({ success: true, ...data });
  } catch (e) {
    console.error('[mileage GET logs]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. GET /trend — 일자별 추이 ?period=week|month
// ──────────────────────────────────────────────────────────────────────────────
router.get('/trend', requireClassMember, requireOwner, (req, res) => {
  try {
    const trend = mileageDb.getTrend(req.classId, { period: req.query.period });
    res.json({ success: true, trend });
  } catch (e) {
    console.error('[mileage GET trend]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. POST /award — 교사 수동 부여 { userIds: [], points, note }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/award', requireClassMember, requireOwner, (req, res) => {
  try {
    const { userIds, points, note } = req.body || {};
    if (!userIds || (Array.isArray(userIds) && userIds.length === 0)) {
      return res.status(400).json({ success: false, message: '대상 학생을 선택해 주세요.' });
    }
    if (!points || parseInt(points) <= 0) {
      return res.status(400).json({ success: false, message: '부여할 포인트는 1 이상이어야 합니다.' });
    }
    const result = mileageDb.manualAward(req.classId, userIds, points, req.user.id, note);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[mileage POST award]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. POST /deduct — 교사 수동 차감
// ──────────────────────────────────────────────────────────────────────────────
router.post('/deduct', requireClassMember, requireOwner, (req, res) => {
  try {
    const { userIds, points, note } = req.body || {};
    if (!userIds || (Array.isArray(userIds) && userIds.length === 0)) {
      return res.status(400).json({ success: false, message: '대상 학생을 선택해 주세요.' });
    }
    if (!points || parseInt(points) <= 0) {
      return res.status(400).json({ success: false, message: '차감 포인트는 1 이상이어야 합니다.' });
    }
    const result = mileageDb.manualDeduct(req.classId, userIds, points, req.user.id, note);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[mileage POST deduct]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. POST /logs/:logId/revoke — 특정 로그 회수
// ──────────────────────────────────────────────────────────────────────────────
router.post('/logs/:logId/revoke', requireClassMember, requireOwner, (req, res) => {
  try {
    const logId = parseInt(req.params.logId);
    const result = mileageDb.revokeLog(req.classId, logId, req.user.id, req.body?.note);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[mileage POST revoke]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 9. GET /rules — 규칙 조회 (모든 멤버 가능)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/rules', requireClassMember, (req, res) => {
  try {
    const rules = mileageDb.getRules(req.classId);
    res.json({ success: true, rules });
  } catch (e) {
    console.error('[mileage GET rules]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 10. PUT /rules — 규칙 일괄 수정 (교사 전용)
// ──────────────────────────────────────────────────────────────────────────────
router.put('/rules', requireClassMember, requireOwner, (req, res) => {
  try {
    const { rules } = req.body || {};
    const result = mileageDb.updateRules(req.classId, rules, req.user.id);
    if (!result.success) return res.status(400).json(result);
    // 갱신 후 최신 규칙 반환
    const latest = mileageDb.getRules(req.classId);
    res.json({ success: true, changed: result.changed, rules: latest });
  } catch (e) {
    console.error('[mileage PUT rules]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 11. GET /export.csv — 로그 CSV 내보내기 (교사 전용)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/export.csv', requireClassMember, requireOwner, (req, res) => {
  try {
    const csv = mileageDb.exportLogsCSV(req.classId, {
      userId: req.query.userId,
      reason: req.query.reason,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      direction: req.query.direction,
    });
    const today = new Date();
    today.setHours(today.getHours() + 9);
    const ymd = today.toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mileage_${req.classId}_${ymd}.csv"`);
    res.write('﻿'); // UTF-8 BOM — Excel 한글 호환
    res.end(csv);
  } catch (e) {
    console.error('[mileage GET export.csv]', e);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
