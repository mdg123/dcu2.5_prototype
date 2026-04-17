// routes/ingest.js
// 외부 데이터 수신(Ingest) 게이트웨이
// 외부 시스템(학력진단, 독서교육, 진로체험 등)에서 데이터를 Push할 수 있는 API
const express = require('express');
const router = express.Router();
const growthExtDb = require('../db/growth-extended');

// 인증 미들웨어: API 키 또는 세션 기반
function requireIngestAuth(req, res, next) {
  // 방법 1: API 키 헤더 (외부 시스템 연동용)
  const apiKey = req.headers['x-ingest-api-key'];
  if (apiKey && apiKey === (process.env.INGEST_API_KEY || 'dachaeum-ingest-2026')) {
    req.ingestSource = req.headers['x-ingest-source'] || 'external';
    return next();
  }
  // 방법 2: 세션 기반 (관리자/교사 직접 업로드용)
  if (req.session && req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'teacher')) {
    req.ingestSource = 'manual-' + req.session.user.username;
    return next();
  }
  res.status(401).json({ success: false, message: 'Ingest 인증이 필요합니다. API 키 또는 관리자 로그인이 필요합니다.' });
}

// 사용자 ID 검증 헬퍼
function validateUserId(userId) {
  if (!userId || typeof userId !== 'number') return false;
  const db = require('../db/index');
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  return !!user;
}

// ===== 기초학력 진단 결과 수신 =====

// 단건 수신
router.post('/diagnosis', requireIngestAuth, (req, res) => {
  try {
    const { userId, sourceSystem, targetNodeId, result, correctCount, totalQuestions, completedAt } = req.body;
    if (!userId || !totalQuestions) {
      return res.status(400).json({ success: false, message: 'userId와 totalQuestions는 필수입니다.' });
    }
    if (!validateUserId(userId)) {
      return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
    }
    const data = growthExtDb.ingestDiagnosis({
      userId, sourceSystem: sourceSystem || req.ingestSource,
      targetNodeId, result, correctCount, totalQuestions, completedAt
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Ingest] 기초학력 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 배치 수신
router.post('/diagnosis/batch', requireIngestAuth, (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });
    }
    if (items.length > 500) {
      return res.status(400).json({ success: false, message: '한 번에 최대 500건까지 처리 가능합니다.' });
    }
    // 유효성 검증
    for (const item of items) {
      if (!item.userId || !item.totalQuestions) {
        return res.status(400).json({ success: false, message: '모든 항목에 userId와 totalQuestions가 필요합니다.' });
      }
    }
    const result = growthExtDb.ingestDiagnosisBatch(items);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Ingest] 기초학력 배치 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 독서활동 데이터 수신 =====

router.post('/reading', requireIngestAuth, (req, res) => {
  try {
    const { userId, bookTitle, author, readDate, rating, review } = req.body;
    if (!userId || !bookTitle) {
      return res.status(400).json({ success: false, message: 'userId와 bookTitle은 필수입니다.' });
    }
    if (!validateUserId(userId)) {
      return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
    }
    const data = growthExtDb.ingestReading({ userId, bookTitle, author, readDate, rating, review });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Ingest] 독서활동 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/reading/batch', requireIngestAuth, (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });
    }
    if (items.length > 500) {
      return res.status(400).json({ success: false, message: '한 번에 최대 500건까지 처리 가능합니다.' });
    }
    for (const item of items) {
      if (!item.userId || !item.bookTitle) {
        return res.status(400).json({ success: false, message: '모든 항목에 userId와 bookTitle이 필요합니다.' });
      }
    }
    const result = growthExtDb.ingestReadingBatch(items);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Ingest] 독서활동 배치 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 진로탐색 데이터 수신 =====

router.post('/career', requireIngestAuth, (req, res) => {
  try {
    const { userId, activityType, title, description, interestArea, reflection, activityDate } = req.body;
    if (!userId || !title) {
      return res.status(400).json({ success: false, message: 'userId와 title은 필수입니다.' });
    }
    if (!validateUserId(userId)) {
      return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
    }
    const data = growthExtDb.ingestCareer({ userId, activityType, title, description, interestArea, reflection, activityDate });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Ingest] 진로탐색 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/career/batch', requireIngestAuth, (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });
    }
    if (items.length > 500) {
      return res.status(400).json({ success: false, message: '한 번에 최대 500건까지 처리 가능합니다.' });
    }
    for (const item of items) {
      if (!item.userId || !item.title) {
        return res.status(400).json({ success: false, message: '모든 항목에 userId와 title이 필요합니다.' });
      }
    }
    const result = growthExtDb.ingestCareerBatch(items);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Ingest] 진로탐색 배치 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 학습활동 범용 데이터 수신 =====

router.post('/learning', requireIngestAuth, (req, res) => {
  try {
    const { userId, classId, activityType, contentId, contentTitle, resultScore, timeSpent, sourceService } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId는 필수입니다.' });
    }
    if (!validateUserId(userId)) {
      return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
    }
    const data = growthExtDb.ingestLearningLog({
      userId, classId, activityType, contentId, contentTitle,
      resultScore, timeSpent, sourceService: sourceService || req.ingestSource
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Ingest] 학습활동 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 정서(감정) 데이터 수신 =====

router.post('/emotion', requireIngestAuth, (req, res) => {
  try {
    const { userId, classId, emotion, emotionReason, date } = req.body;
    if (!userId || !emotion) {
      return res.status(400).json({ success: false, message: 'userId와 emotion은 필수입니다.' });
    }
    if (!validateUserId(userId)) {
      return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
    }
    const validEmotions = ['happy', 'excited', 'good', 'great', 'calm', 'sad', 'angry', 'anxious', 'tired', 'frustrated'];
    if (!validEmotions.includes(emotion)) {
      return res.status(400).json({ success: false, message: `emotion은 다음 중 하나여야 합니다: ${validEmotions.join(', ')}` });
    }
    const data = growthExtDb.ingestEmotion({ userId, classId, emotion, emotionReason, date });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Ingest] 정서 데이터 수신 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 수신 현황 조회 (관리자용) =====

router.get('/stats', requireIngestAuth, (req, res) => {
  try {
    const stats = growthExtDb.getIngestStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== API 스펙 문서 =====

router.get('/spec', (req, res) => {
  res.json({
    title: '다채움 외부 데이터 수신(Ingest) API',
    version: '1.0',
    auth: {
      method: 'API Key 헤더 또는 세션 인증',
      header: 'X-Ingest-Api-Key',
      note: '관리자/교사 세션으로도 인증 가능'
    },
    endpoints: {
      'POST /api/ingest/diagnosis': {
        description: '기초학력 진단 결과 수신 (단건)',
        required: ['userId', 'totalQuestions'],
        optional: ['sourceSystem', 'targetNodeId', 'result', 'correctCount', 'completedAt']
      },
      'POST /api/ingest/diagnosis/batch': {
        description: '기초학력 진단 결과 일괄 수신',
        body: '{ items: [...] } (최대 500건)'
      },
      'POST /api/ingest/reading': {
        description: '독서활동 데이터 수신 (단건)',
        required: ['userId', 'bookTitle'],
        optional: ['author', 'readDate', 'rating', 'review']
      },
      'POST /api/ingest/reading/batch': {
        description: '독서활동 일괄 수신',
        body: '{ items: [...] } (최대 500건)'
      },
      'POST /api/ingest/career': {
        description: '진로탐색 활동 수신 (단건)',
        required: ['userId', 'title'],
        optional: ['activityType', 'description', 'interestArea', 'reflection', 'activityDate']
      },
      'POST /api/ingest/career/batch': {
        description: '진로탐색 일괄 수신',
        body: '{ items: [...] } (최대 500건)'
      },
      'POST /api/ingest/learning': {
        description: '학습활동 범용 수신',
        required: ['userId'],
        optional: ['classId', 'activityType', 'contentId', 'contentTitle', 'resultScore', 'timeSpent', 'sourceService']
      },
      'POST /api/ingest/emotion': {
        description: '정서(감정) 데이터 수신',
        required: ['userId', 'emotion'],
        optional: ['classId', 'emotionReason', 'date'],
        validEmotions: ['happy', 'excited', 'good', 'great', 'calm', 'sad', 'angry', 'anxious', 'tired', 'frustrated']
      },
      'GET /api/ingest/stats': {
        description: '수신 현황 통계 조회 (관리자용)'
      },
      'GET /api/ingest/spec': {
        description: 'API 스펙 문서 (현재 페이지)'
      }
    }
  });
});

module.exports = router;
