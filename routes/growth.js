const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const growthDb = require('../db/growth');
const classDb = require('../db/class');
const growthExtDb = require('../db/growth-extended');
const notifDb = require('../db/notifications');
const buildSurvey = require('../lib/xapi/builders/survey');
const buildSocial = require('../lib/xapi/builders/social');
const buildTeaching = require('../lib/xapi/builders/teaching');
const buildNavigation = require('../lib/xapi/builders/navigation');
const xapiSpool = require('../lib/xapi/spool');
const { generatePortfolioReport } = require('../lib/portfolio-pdf');

// PDF 업로드용 multer (메모리 저장 — DB는 file_path 만 보유)
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('PDF 파일만 업로드할 수 있습니다.'), false);
  }
});

// ─── 갤러리 멀티미디어/콘테스트 썸네일 업로드 multer ─────────────────────────
const galleryUploadDir = path.join(__dirname, '..', 'public', 'uploads', 'gallery');
if (!fs.existsSync(galleryUploadDir)) fs.mkdirSync(galleryUploadDir, { recursive: true });

const galleryStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, galleryUploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const baseRaw = path.basename(file.originalname, ext);
    const base = baseRaw.replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 40) || 'file';
    const uniq = Date.now() + '-' + Math.round(Math.random() * 1e4);
    cb(null, `${base}-${uniq}${ext.toLowerCase()}`);
  }
});

// 작품 미디어 업로드 — 이미지/음원 (20MB)
const galleryMediaUpload = multer({
  storage: galleryStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mt = String(file.mimetype || '').toLowerCase();
    if (mt.startsWith('image/') || mt.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('이미지 또는 음원 파일만 업로드할 수 있습니다.'), false);
    }
  }
});

// 콘테스트 썸네일 업로드 — 이미지 전용 (5MB)
const eventThumbUpload = multer({
  storage: galleryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mt = String(file.mimetype || '').toLowerCase();
    if (mt.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드할 수 있습니다.'), false);
  }
});

// 학생-교사 동일 클래스 검사 (보고서 권한)
function teacherSharesClassWithStudent(teacherId, studentId) {
  const db = require('../db/index');
  const row = db.prepare(`
    SELECT 1 FROM class_members tm
    JOIN class_members sm ON sm.class_id = tm.class_id
    WHERE tm.user_id = ? AND tm.role = 'owner' AND sm.user_id = ? AND sm.status = 'active'
    LIMIT 1
  `).get(teacherId, studentId);
  return !!row;
}

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
// 'reports', 'report'는 별도 라우트(아래)에서 매칭. 여기서 들어오면 숫자 id가 아닐 시 404.
router.get('/portfolios/:id', requireAuth, (req, res, next) => {
  // 문자열 라우트(예약어)는 다음 라우터에 위임
  if (['reports', 'report'].includes(req.params.id)) return next('route');
  try {
    const portfolio = growthDb.getPortfolioById(parseInt(req.params.id));
    if (!portfolio) return res.status(404).json({ success: false, message: '포트폴리오를 찾을 수 없습니다.' });
    res.json({ success: true, portfolio });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/growth/portfolios/:id
router.put('/portfolios/:id', requireAuth, (req, res, next) => {
  if (['reports', 'report'].includes(req.params.id)) return next('route');
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
router.delete('/portfolios/:id', requireAuth, (req, res, next) => {
  if (['reports', 'report'].includes(req.params.id)) return next('route');
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
    const overview = growthDb.getClassGrowthOverview(classId, {
      startDate: req.query.startDate,
      endDate: req.query.endDate
    });
    res.json({ success: true, overview });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 갤러리 =====

// 유틸: 정수 파싱
function pInt(v, def = null) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

// GET /api/growth/gallery - 갤러리 목록
// 쿼리:
//   mine=true                   본인 작품만 (pending 포함)
//   category, page, limit
//   includeAll(teacher/admin)   pending/rejected 포함
//   sort=latest|likes|views|comments|popular (기본 latest)
//   q=<keyword>
//   school=ours                 본인 school_name과 동일한 작성자
//   school_name=<문자열>        특정 학교
//   school_level=elementary|middle|high
//   period=today|week|month|year (created_at 기준)
//   from=YYYY-MM-DD, to=YYYY-MM-DD
router.get('/gallery', requireAuth, (req, res) => {
  try {
    const sortRaw = String(req.query.sort || 'latest').toLowerCase();
    const sort = ['latest', 'likes', 'views', 'comments', 'popular'].includes(sortRaw) ? sortRaw : 'latest';
    const mine = req.query.mine === 'true';

    // school=ours → 본인 school_name 자동 매핑
    let schoolName = req.query.school_name || null;
    if (req.query.school === 'ours' && req.user.school_name) {
      schoolName = req.user.school_name;
    }
    const schoolLevelRaw = req.query.school_level ? String(req.query.school_level).toLowerCase() : null;
    const schoolLevel = ['elementary', 'middle', 'high'].includes(schoolLevelRaw) ? schoolLevelRaw : null;
    const periodRaw = req.query.period ? String(req.query.period).toLowerCase() : null;
    const period = ['today', 'week', 'month', 'year'].includes(periodRaw) ? periodRaw : null;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const periodFrom = dateRe.test(String(req.query.from || '')) ? req.query.from : null;
    const periodTo   = dateRe.test(String(req.query.to || '')) ? req.query.to : null;

    const result = growthDb.getGalleryItems({
      studentId: mine ? req.user.id : null,
      category: req.query.category,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      includeAll: req.query.includeAll === 'true' && ['teacher', 'admin'].includes(req.user.role),
      sort,
      q: req.query.q || null,
      viewerId: req.user.id,
      showMine: mine,
      schoolName,
      schoolLevel,
      period,
      periodFrom,
      periodTo
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] gallery list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/gallery/popular?period=week|month|all&limit=6
// 좋아요*3 + 조회수*1 가중치 정렬
router.get('/gallery/popular', requireAuth, (req, res) => {
  try {
    const periodRaw = String(req.query.period || 'week').toLowerCase();
    const period = ['week', 'month', 'all'].includes(periodRaw) ? periodRaw : 'week';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 50);
    const items = growthDb.getPopularGalleryItems({ period, limit, viewerId: req.user.id });
    res.json({ success: true, items });
  } catch (err) {
    console.error('[GROWTH] gallery popular error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery - 갤러리 작품 등록 (멀티미디어 + body_text 지원)
// body: { title, category?, description?, body_text?, attachments?: [{type, url, mime?, file_name?, file_size?, sort_order?}] }
// - attachments 또는 body_text 중 하나 이상 필수
// - attachments 10개 제한, body_text 1000자 제한
// - 항상 approval_status='pending' 으로 저장 (학생 작품 승인 후 공개 원칙)
router.post('/gallery', requireAuth, (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    if (title.length > 100) return res.status(400).json({ success: false, message: '제목은 100자 이하로 입력하세요.' });

    const hasAttachments = Array.isArray(req.body.attachments);
    const hasBodyText = req.body.body_text != null && String(req.body.body_text).length > 0;

    let item;
    if (hasAttachments || hasBodyText) {
      // 신규: 멀티미디어 + 트랜잭션
      item = growthDb.createGalleryItemWithAttachments(req.user.id, { ...req.body, title });
    } else {
      // 레거시: 단일 image_url 만 — 기존 경로 유지 (하위 호환)
      item = growthDb.createGalleryItem(req.user.id, { ...req.body, title });
    }
    // xAPI: 갤러리 작품 업로드 → social(participated) post-cnt=1 (board_kind='other' → E)
    try {
      if (item && item.id) {
        xapiSpool.record('social', buildSocial, { userId: req.user.id }, {
          verb: 'shared',
          board_id: `gallery-${item.id}`,
          board_kind: 'other',
          board_title: title,
          post_id: item.id,
          post_title: title,
          approval_status: 'pending',  // 학생 작품 승인 후 공개 원칙
          counts: { post: 1 },
        });
      }
    } catch (e) { console.error('[xapi:gallery_upload]', e.message); }
    res.status(201).json({ success: true, item });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] gallery create error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/upload-media - 작품 미디어 파일 업로드 (이미지/음원)
// 응답: { success, url, type, mime, file_name, file_size }
router.post('/gallery/upload-media', requireAuth, (req, res, next) => {
  galleryMediaUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: '파일 크기가 20MB를 초과합니다.' });
      }
      return res.status(400).json({ success: false, message: err.message || '업로드 실패' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: '파일이 선택되지 않았습니다.' });
    }
    const mt = String(req.file.mimetype || '').toLowerCase();
    const type = mt.startsWith('image/') ? 'image' : (mt.startsWith('audio/') ? 'audio' : 'image');
    const url = `/uploads/gallery/${req.file.filename}`;
    res.status(201).json({
      success: true,
      url,
      type,
      mime: req.file.mimetype,
      file_name: req.file.originalname,
      file_size: req.file.size
    });
  });
});

// PUT /api/growth/gallery/:id - 본인 작품 수정 (본인 또는 admin만)
// attachments 가 포함되면 전체 교체. body_text 갱신 지원.
router.put('/gallery/:id', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const current = growthDb.getGalleryItemById(id, req.user.id);
    if (!current) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    if (current.student_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    if (req.body.title !== undefined) {
      const t = String(req.body.title || '').trim();
      if (!t) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
      if (t.length > 100) return res.status(400).json({ success: false, message: '제목은 100자 이하로 입력하세요.' });
      req.body.title = t;
    }

    const hasAttachments = Array.isArray(req.body.attachments);
    const hasBodyText = req.body.body_text !== undefined;

    let updated;
    if (hasAttachments || hasBodyText) {
      updated = growthDb.updateGalleryItemWithAttachments(id, req.body);
    } else {
      updated = growthDb.updateGalleryItem(id, req.body);
    }

    // rejected 상태에서 수정 시 자동 pending 복귀 (재제출)
    if (current.approval_status === 'rejected' && req.user.id === current.student_id) {
      const dbIdx = require('../db/index');
      dbIdx.prepare("UPDATE student_gallery SET approval_status = 'pending', reject_reason = NULL WHERE id = ?").run(id);
      updated = growthDb.getGalleryItemWithAttachments(id, req.user.id);
    }

    res.json({ success: true, item: updated });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] gallery update error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/gallery/:id - 단건 조회 (attachments + body_text 포함)
// 본인 또는 admin/teacher가 아니면 approved 작품만 노출
router.get('/gallery/:id', requireAuth, (req, res, next) => {
  // 예약어 라우트는 다음 라우터에 위임 (popular, upload-media 등)
  if (['popular', 'upload-media'].includes(req.params.id)) return next('route');
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const item = growthDb.getGalleryItemWithAttachments(id, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });

    const isOwner = item.student_id === req.user.id;
    const isStaff = req.user.role === 'admin' || req.user.role === 'teacher';
    if (!isOwner && !isStaff && item.approval_status && item.approval_status !== 'approved') {
      return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    }

    res.json({ success: true, item });
  } catch (err) {
    console.error('[GROWTH] gallery detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/growth/gallery/:id - 본인 또는 admin/teacher (soft delete)
router.delete('/gallery/:id', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const current = growthDb.getGalleryItemById(id, req.user.id);
    if (!current) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    const isOwner = current.student_id === req.user.id;
    const isStaff = req.user.role === 'admin' || req.user.role === 'teacher';
    if (!isOwner && !isStaff) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const ok = growthDb.deleteGalleryItem(id);
    if (!ok) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[GROWTH] gallery delete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/like - 좋아요 토글
router.post('/gallery/:id/like', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const item = growthDb.getGalleryItemById(id, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    const result = growthDb.toggleGalleryLike(id, req.user.id);
    res.json({ success: true, liked: result.liked, like_count: result.like_count });
  } catch (err) {
    console.error('[GROWTH] gallery like error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/view - 조회수 +1 (idempotent: 같은 사용자 같은 날 1회만)
// 자기 자신 작품 조회는 카운트 제외.
router.post('/gallery/:id/view', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const item = growthDb.getGalleryItemById(id, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    // 자기 작품은 카운트 제외
    if (item.student_id === req.user.id) {
      return res.json({ success: true, counted: false, view_count: item.view_count || 0 });
    }
    const result = growthDb.recordGalleryView(id, req.user.id);
    res.json({ success: true, counted: result.counted, view_count: result.view_count });
  } catch (err) {
    console.error('[GROWTH] gallery view error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 댓글 =====

// GET /api/growth/gallery/:id/comments?page=1&limit=30
router.get('/gallery/:id/comments', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const item = growthDb.getGalleryItemById(id, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const result = growthDb.listGalleryComments(id, { page, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] gallery comments list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/comments  body: { content }
router.post('/gallery/:id/comments', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    if (content.length > 500) return res.status(400).json({ success: false, message: '댓글은 500자 이하로 입력하세요.' });
    const item = growthDb.getGalleryItemById(id, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    const comment = growthDb.createGalleryComment(id, req.user.id, content);
    res.status(201).json({ success: true, comment });
  } catch (err) {
    console.error('[GROWTH] gallery comment create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/growth/gallery/:id/comments/:commentId  (본인/admin/teacher)
router.delete('/gallery/:id/comments/:commentId', requireAuth, (req, res) => {
  try {
    const galleryId = pInt(req.params.id);
    const commentId = pInt(req.params.commentId);
    if (!galleryId || !commentId) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const comment = growthDb.getGalleryCommentById(commentId);
    if (!comment || comment.gallery_id !== galleryId) {
      return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    }
    const isOwner = comment.user_id === req.user.id;
    const isStaff = req.user.role === 'admin' || req.user.role === 'teacher';
    if (!isOwner && !isStaff) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const ok = growthDb.deleteGalleryComment(commentId);
    if (!ok) return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[GROWTH] gallery comment delete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/approve - 작품 승인 + 작성자 알림
router.post('/gallery/:id/approve', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 승인할 수 있습니다.' });
    }
    const galleryId = parseInt(req.params.id);
    if (!galleryId) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const item = growthDb.getGalleryItemById(galleryId, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });

    growthDb.approveGalleryItem(galleryId, req.user.id);

    // 작성자에게 알림
    try {
      notifDb.createNotification({
        userId: item.student_id,
        type: 'gallery_approved',
        title: '작품이 승인되었어요',
        message: `${item.title || '작품'}이(가) 갤러리에 공개되었습니다.`,
        link: `/plus/gallery.html?open=${galleryId}`
      });
    } catch (_) { /* 알림 실패는 비차단 */ }

    // xAPI: 작품 승인 → teaching(gave) + feedback-info (피드백 대상=학생, 결과=approved)
    try {
      xapiSpool.record('teaching', buildTeaching, { userId: req.user.id }, {
        verb: 'gave',
        kind: 'gallery_approval',
        feedback_id: `gallery-approve-${galleryId}`,
        content_id: galleryId,
        target_id: galleryId,
        target_user_ids: item.student_id ? [item.student_id] : [],
        message: `작품 "${item.title || ''}" 승인`,
        approval_status: 'approved',
      });
    } catch (e) { console.error('[xapi:gallery_approve]', e.message); }

    res.json({ success: true, message: '승인되었습니다.' });
  } catch (err) {
    console.error('[GROWTH] gallery approve error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/reject - 작품 반려 + 작성자 알림 (사유 포함)
router.post('/gallery/:id/reject', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '교사만 반려할 수 있습니다.' });
    }
    const galleryId = parseInt(req.params.id);
    if (!galleryId) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const item = growthDb.getGalleryItemById(galleryId, req.user.id);
    if (!item) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });

    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 200) : null;
    growthDb.rejectGalleryItem(galleryId, reason);

    // 작성자에게 알림 (사유 포함)
    try {
      const msg = reason
        ? `${item.title || '작품'}이(가) 반려되었습니다. 사유: ${reason}`
        : `${item.title || '작품'}이(가) 반려되었습니다.`;
      notifDb.createNotification({
        userId: item.student_id,
        type: 'gallery_rejected',
        title: '작품이 반려되었어요',
        message: msg,
        link: `/plus/gallery.html?open=${galleryId}`
      });
    } catch (_) { /* 알림 실패는 비차단 */ }

    // xAPI: 작품 반려 → teaching(gave) + feedback-info (결과=rejected, 사유 포함)
    try {
      xapiSpool.record('teaching', buildTeaching, { userId: req.user.id }, {
        verb: 'gave',
        kind: 'gallery_rejection',
        feedback_id: `gallery-reject-${galleryId}`,
        content_id: galleryId,
        target_id: galleryId,
        target_user_ids: item.student_id ? [item.student_id] : [],
        message: `작품 "${item.title || ''}" 반려`,
        reason,
        approval_status: 'rejected',
      });
    } catch (e) { console.error('[xapi:gallery_reject]', e.message); }

    res.json({ success: true, message: '반려되었습니다.' });
  } catch (err) {
    console.error('[GROWTH] gallery reject error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ============ 관리자 신고 대시보드 ============

// GET /api/growth/admin/gallery-reports?status=pending|resolved|dismissed&limit=50
router.get('/admin/gallery-reports', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자/교사만 접근할 수 있습니다.' });
    }
    const statusRaw = String(req.query.status || 'pending').toLowerCase();
    const status = ['pending', 'resolved', 'dismissed'].includes(statusRaw) ? statusRaw : 'pending';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = growthDb.listGalleryReports({ status, limit, offset });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] admin reports list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/admin/gallery-reports/:reportId/resolve
// body: { action: 'takedown'|'dismiss', reason? }
router.post('/admin/gallery-reports/:reportId/resolve', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자/교사만 접근할 수 있습니다.' });
    }
    const reportId = parseInt(req.params.reportId, 10);
    if (!reportId) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const action = String(req.body.action || '').toLowerCase();
    if (!['takedown', 'dismiss'].includes(action)) {
      return res.status(400).json({ success: false, message: '처리 액션은 takedown 또는 dismiss 이어야 합니다.' });
    }
    const reason = req.body.reason ? String(req.body.reason).slice(0, 300) : null;

    // 처리 전 신고 조회 (작성자/신고자 알림용)
    const before = growthDb.getGalleryReportById(reportId);
    if (!before) return res.status(404).json({ success: false, message: '신고를 찾을 수 없습니다.' });

    const updated = growthDb.resolveGalleryReport(reportId, action, req.user.id, reason);

    // 알림 발송
    try {
      if (action === 'takedown' && before.author_id) {
        notifDb.createNotification({
          userId: before.author_id,
          type: 'gallery_takedown',
          title: '작품이 내려갔습니다',
          message: reason
            ? `${before.gallery_title || '작품'}이(가) 신고에 따라 비공개 처리되었습니다. 사유: ${reason}`
            : `${before.gallery_title || '작품'}이(가) 신고에 따라 비공개 처리되었습니다.`,
          link: `/plus/gallery.html`
        });
      } else if (action === 'dismiss') {
        notifDb.createNotification({
          userId: before.reporter_id,
          type: 'gallery_report_dismissed',
          title: '신고가 검토되었습니다',
          message: reason
            ? `신고하신 작품을 검토했습니다. 결과: ${reason}`
            : '신고하신 작품을 검토한 결과 문제가 없는 것으로 확인되었습니다.',
          link: `/plus/gallery.html?open=${before.gallery_id}`
        });
      }
    } catch (_) { /* 알림 실패는 비차단 */ }

    res.json({ success: true, report: updated });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] admin report resolve error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/admin/gallery/:id/takedown  body: { reason }
// 신고가 없어도 admin/teacher가 직접 작품 내림 + 작성자 알림
router.post('/admin/gallery/:id/takedown', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자/교사만 접근할 수 있습니다.' });
    }
    const galleryId = parseInt(req.params.id, 10);
    if (!galleryId) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 300) : null;
    if (!reason) return res.status(400).json({ success: false, message: '내림 사유를 입력해 주세요.' });

    // soft delete 전에 작성자/제목 확보
    const before = require('../db/index').prepare('SELECT id, student_id, title FROM student_gallery WHERE id = ?').get(galleryId);
    if (!before) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });

    growthDb.takedownGalleryItemDirect(galleryId, req.user.id, reason);

    // 작성자 알림
    try {
      notifDb.createNotification({
        userId: before.student_id,
        type: 'gallery_takedown',
        title: '작품이 내려갔습니다',
        message: `${before.title || '작품'}이(가) 비공개 처리되었습니다. 사유: ${reason}`,
        link: `/plus/gallery.html`
      });
    } catch (_) {}

    res.json({ success: true, message: '작품을 내렸습니다.' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] admin takedown error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/gallery/:id/report - 작품 신고
router.post('/gallery/:id/report', requireAuth, (req, res) => {
  try {
    const galleryId = parseInt(req.params.id);
    if (!galleryId) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim().slice(0, 300) : '';
    if (!reason) return res.status(400).json({ success: false, message: '신고 사유를 입력해 주세요.' });
    const db = require('../db');
    // 대상 작품 존재 확인
    const target = db.prepare('SELECT id FROM student_gallery WHERE id = ?').get(galleryId);
    if (!target) return res.status(404).json({ success: false, message: '작품을 찾을 수 없습니다.' });
    // UNIQUE(gallery_id, user_id) — 중복 신고 시 IGNORE
    const r = db.prepare(`
      INSERT OR IGNORE INTO gallery_reports (gallery_id, user_id, reason, status)
      VALUES (?, ?, ?, 'pending')
    `).run(galleryId, req.user.id, reason);
    if (r.changes === 0) {
      return res.json({ success: true, message: '이미 신고하신 작품입니다.', alreadyReported: true });
    }
    res.json({ success: true, message: '신고가 접수되었습니다.' });
  } catch (err) {
    console.error('[gallery/report]', err.message);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 콘테스트 (gallery_events) =====

// GET /api/growth/events?status=upcoming|active|past&limit=10
router.get('/events', requireAuth, (req, res) => {
  try {
    const statusRaw = req.query.status ? String(req.query.status).toLowerCase() : null;
    const status = ['upcoming', 'active', 'past'].includes(statusRaw) ? statusRaw : null;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = growthDb.listGalleryEvents({ status, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] events list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/events/:id
router.get('/events/:id', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const event = growthDb.getGalleryEventById(id);
    if (!event) return res.status(404).json({ success: false, message: '콘테스트를 찾을 수 없습니다.' });
    res.json({ success: true, event });
  } catch (err) {
    console.error('[GROWTH] event detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/events - 신규 콘테스트 작성 (admin/teacher)
router.post('/events', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자 또는 교사만 콘테스트를 작성할 수 있습니다.' });
    }
    const event = growthDb.createGalleryEvent(req.user.id, req.body || {});
    res.status(201).json({ success: true, event });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] event create error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/growth/events/:id - 콘테스트 수정 (admin·teacher, host_user_id 본인 또는 admin)
router.put('/events/:id', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자 또는 교사만 수정할 수 있습니다.' });
    }
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const before = growthDb.getGalleryEventById(id);
    if (!before) return res.status(404).json({ success: false, message: '콘테스트를 찾을 수 없습니다.' });
    if (req.user.role !== 'admin' && before.host_user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '본인이 작성한 콘테스트만 수정할 수 있습니다.' });
    }
    const event = growthDb.updateGalleryEvent(id, req.body || {});
    res.json({ success: true, event });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] event update error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/growth/events/:id - 콘테스트 soft delete (작성자 또는 admin)
router.delete('/events/:id', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자 또는 교사만 삭제할 수 있습니다.' });
    }
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const before = growthDb.getGalleryEventById(id);
    if (!before) return res.status(404).json({ success: false, message: '콘테스트를 찾을 수 없습니다.' });
    if (req.user.role !== 'admin' && before.host_user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '본인이 작성한 콘테스트만 삭제할 수 있습니다.' });
    }
    growthDb.softDeleteGalleryEvent(id);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] event delete error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/events/:id/submissions - 응모작 목록 (host 또는 admin·teacher)
router.get('/events/:id/submissions', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '관리자 또는 교사만 응모작을 조회할 수 있습니다.' });
    }
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const event = growthDb.getGalleryEventById(id);
    if (!event) return res.status(404).json({ success: false, message: '콘테스트를 찾을 수 없습니다.' });
    // teacher는 host 본인이거나 admin만 접근 (보안 단순화: admin/teacher 전체 허용은 위에서 통과)
    const sort = ['latest', 'likes'].includes(String(req.query.sort)) ? String(req.query.sort) : 'latest';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const result = growthDb.listEventSubmissions(id, { sort, page, limit });
    res.json({ success: true, event_id: id, ...result });
  } catch (err) {
    console.error('[GROWTH] event submissions error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/events/upload-thumbnail - 콘테스트 썸네일 업로드 (admin·teacher, 5MB)
router.post('/events/upload-thumbnail', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ success: false, message: '관리자 또는 교사만 업로드할 수 있습니다.' });
  }
  eventThumbUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: '파일 크기가 5MB를 초과합니다.' });
      }
      return res.status(400).json({ success: false, message: err.message || '업로드 실패' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: '파일이 선택되지 않았습니다.' });
    }
    const url = `/uploads/gallery/${req.file.filename}`;
    res.status(201).json({ success: true, url });
  });
});

// POST /api/growth/events/:id/submit  body: { title, description, image_url }
router.post('/events/:id/submit', requireAuth, (req, res) => {
  try {
    const id = pInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ success: false, message: '작품 제목을 입력하세요.' });
    if (title.length > 100) return res.status(400).json({ success: false, message: '제목은 100자 이하로 입력하세요.' });
    const description = req.body.description ? String(req.body.description).slice(0, 2000) : null;
    const image_url = req.body.image_url ? String(req.body.image_url).slice(0, 500) : null;

    const result = growthDb.submitGalleryEvent(id, req.user.id, { title, description, image_url });
    res.status(201).json({ success: true, submission: result.submission, galleryItemId: result.galleryItemId });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[GROWTH] event submit error:', err);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// ===== 포트폴리오 아카이브 (확장) =====

// GET /api/growth/portfolio/items
// 쿼리: page, limit, grade, semester, subject, type, source, category,
//       keyword, lifeTask, team, dateRange, from, to, schoolLevel, userId(교사/관리자만)
// BUG-1: 응답 items 에 title alias 포함 (db 함수에서 매핑)
// BUG-3: 학년/학기/과목/유형/기간/학교급 필터 동작
router.get('/portfolio/items', requireAuth, (req, res) => {
  try {
    const userId = (req.user.role === 'teacher' || req.user.role === 'admin') && req.query.userId
      ? parseInt(req.query.userId)
      : req.user.id;
    const opts = {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      grade: req.query.grade || null,
      semester: req.query.semester || null,
      subject: req.query.subject && req.query.subject !== 'all' ? req.query.subject : null,
      type: req.query.type && req.query.type !== 'all' ? req.query.type : null,
      source: req.query.source || null,
      category: req.query.category && req.query.category !== 'all' ? req.query.category : null,
      keyword: req.query.keyword || req.query.q || null,
      lifeTask: req.query.lifeTask || null,
      team: req.query.team || null,
      dateRange: req.query.dateRange || null,
      from: req.query.from || null,
      to: req.query.to || null,
      schoolLevel: req.query.schoolLevel || null
    };
    const result = growthExtDb.getPortfolioItems(userId, opts);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[GROWTH] portfolio items error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/portfolio/items — 비교과 활동 직접 등록 (BUG-2)
router.post('/portfolio/items', requireAuth, (req, res) => {
  try {
    const result = growthExtDb.createPortfolioItem(req.user.id, req.body || {});
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    console.error('[GROWTH] portfolio create error:', err.message);
    res.status(status).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/portfolio/competency-stats — 6대 핵심역량 (BUG-4)
router.get('/portfolio/competency-stats', requireAuth, (req, res) => {
  try {
    const userId = (req.user.role === 'teacher' || req.user.role === 'admin') && req.query.userId
      ? parseInt(req.query.userId)
      : req.user.id;
    const competencies = growthExtDb.getCompetencyStats(userId, {
      startDate: req.query.from || req.query.startDate || null,
      endDate: req.query.to || req.query.endDate || null
    });
    res.json({ success: true, competencies });
  } catch (err) {
    console.error('[GROWTH] competency-stats error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== PDF 보고서 (포트폴리오) =====

// 권한 helper: 본인 / 같은 클래스 교사 / admin
function canAccessStudentReport(req, studentId) {
  if (req.user.role === 'admin') return true;
  if (req.user.id === studentId) return true;
  if (req.user.role === 'teacher' && teacherSharesClassWithStudent(req.user.id, studentId)) return true;
  return false;
}

// GET /api/growth/portfolios/:studentId/report-data
// 보고서 1회 조립용 종합 페이로드 (기획서 §7-1)
router.get('/portfolios/:studentId/report-data', requireAuth, (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId);
    if (!canAccessStudentReport(req, studentId)) {
      return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
    }
    const itemIds = req.query.itemIds
      ? String(req.query.itemIds).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
      : null;
    const data = growthExtDb.getPortfolioReportData(studentId, {
      from: req.query.from || null,
      to: req.query.to || null,
      schoolLevel: req.query.schoolLevel || null,
      itemIds
    });
    if (!data) return res.status(404).json({ success: false, message: '학생을 찾을 수 없습니다.' });
    res.json(data);
  } catch (err) {
    console.error('[GROWTH] report-data error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/growth/portfolios/report
// 서버 사이드에서 PDF 직접 생성 후 uploads/portfolio-reports 에 저장.
// body: { studentId, period: {from, to}, schoolLevel, itemIds, coverNote?, includeReflection?, title? }
// 응답: { success, reportId, downloadUrl, fileName, sizeBytes, generatedAt }
router.post('/portfolios/report', requireAuth, async (req, res) => {
  try {
    const studentId = parseInt(req.body.studentId) || req.user.id;
    // 본인 또는 admin
    if (req.user.id !== studentId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '본인 보고서만 생성할 수 있습니다.' });
    }

    const opts = req.body.options || {};
    const periodFrom = (req.body.period && req.body.period.from) || opts.periodStart || opts.from || req.body.from || null;
    const periodTo = (req.body.period && req.body.period.to) || opts.periodEnd || opts.to || req.body.to || null;
    const schoolLevel = req.body.schoolLevel || opts.schoolLevel || null;
    const itemIds = Array.isArray(req.body.itemIds) ? req.body.itemIds.map(x => parseInt(x, 10)).filter(Boolean) : [];
    const coverNote = req.body.coverNote || opts.coverNote || opts.studentNote || null;
    const includeReflection = req.body.includeReflection !== false;
    const title = req.body.title || opts.title || '포트폴리오 보고서';

    // 필수 필터 검증 (코드 1006)
    if (!periodFrom || !periodTo || !schoolLevel) {
      return res.status(400).json({
        success: false,
        code: 1006,
        message: '기간(from/to)과 학교급(schoolLevel)은 필수입니다.'
      });
    }

    // 데이터 조립 (이때 schoolLevel/from/to 1차 필터)
    const data = growthExtDb.getPortfolioReportData(studentId, {
      from: periodFrom, to: periodTo, schoolLevel, itemIds: itemIds.length ? itemIds : null
    });
    if (!data) return res.status(404).json({ success: false, message: '학생을 찾을 수 없습니다.' });

    // 서버 측 itemIds 재검증: data.items 안에 있는 ID 만 통과 (위변조 차단)
    const validIds = new Set(data.items.map(it => it.id));
    const verifiedIds = itemIds.filter(id => validIds.has(id));
    if (itemIds.length > 0 && verifiedIds.length === 0) {
      return res.status(400).json({
        success: false, code: 1007,
        message: '선택한 활동이 기간/학교급 조합에 없습니다.'
      });
    }
    // verifiedIds 로 다시 좁히기 (선택한 게 있으면)
    if (verifiedIds.length > 0) {
      const verifiedSet = new Set(verifiedIds);
      data.items = data.items.filter(it => verifiedSet.has(it.id));
    }

    // 메타 INSERT (status: pending)
    const report = growthExtDb.createPortfolioReport(studentId, {
      title, periodFrom, periodTo, schoolLevel,
      options: opts, itemIds: verifiedIds.length ? verifiedIds : itemIds,
      coverNote,
      status: 'pending'
    });

    // PDF 생성
    const buffer = await generatePortfolioReport(data, { coverNote, includeReflection, title });

    // 미션 명세 파일명: <studentId>-<timestamp>.pdf
    const ts = Date.now();
    const baseDir = path.join(process.cwd(), 'uploads', 'portfolio-reports');
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const fileName = `${studentId}-${ts}.pdf`;
    const filePath = path.join(baseDir, fileName);

    const updated = growthExtDb.saveGeneratedReport(studentId, report.id, {
      buffer,
      filePath,
      pageCount: null,  // pdfkit에서 정확한 페이지수는 stream 기반 — 별도 산출 시 보강
      itemCount: data.items.length,
      coverNote
    });

    // xAPI: 포트폴리오 보고서 생성 → navigation(learned) etc-content (option a: builder 위임)
    //   이전 코드는 spool.enqueue 에 평탄 객체를 넘겨 항상 invalid 처리되었음 → builder 호출로 교정.
    try {
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id, displayName: req.user.display_name || req.user.username }, {
        verb: 'learned',
        target_id: report.id,
        target_title: title || '포트폴리오 보고서',
        nav_slug: 'etc-content',
        content_type: 'document',
        completed: true,
        progress_percent: 100,
        duration_sec: 0,
      });
    } catch (_) { /* 비차단 */ }

    res.status(201).json({
      success: true,
      reportId: updated.id,
      downloadUrl: `/api/growth/portfolios/report/${updated.id}/download`,
      previewUrl: `/api/growth/portfolios/report/${updated.id}/download`,
      fileName,
      sizeBytes: buffer.length,
      fileSizeKB: updated.file_size_kb,
      pageCount: updated.page_count || null,
      itemCount: updated.item_count || data.items.length,
      generatedAt: updated.created_at,
      title: updated.title,
      periodFrom: updated.period_from,
      periodTo: updated.period_to,
      schoolLevel: updated.school_level,
      coverNote: updated.cover_note || null
    });
  } catch (err) {
    console.error('[GROWTH] generate report error:', err);
    res.status(500).json({ success: false, message: err.message || 'PDF 생성 중 오류가 발생했습니다.' });
  }
});

// PUT /api/growth/portfolios/report/:id/upload — Frontend가 jsPDF로 만든 PDF 업로드
router.put('/portfolios/report/:id/upload', requireAuth, pdfUpload.single('file'), (req, res) => {
  try {
    const reportId = req.params.id;
    const row = growthExtDb.getPortfolioReportById(reportId);
    if (!row) return res.status(404).json({ success: false, message: '보고서를 찾을 수 없습니다.' });
    if (row.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'PDF 파일이 첨부되지 않았습니다.' });
    }
    const pageCount = parseInt(req.body.pageCount) || null;
    const updated = growthExtDb.attachPortfolioReportFile(row.user_id, reportId, {
      buffer: req.file.buffer,
      pageCount
    });
    res.json({
      success: true,
      reportId: updated.id,
      pageCount: updated.page_count,
      fileSizeKB: updated.file_size_kb,
      downloadUrl: `/api/growth/portfolios/report/${updated.id}/download`,
      status: updated.status
    });
  } catch (err) {
    console.error('[GROWTH] upload report file error:', err);
    res.status(500).json({ success: false, message: err.message || '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/portfolios/reports — 학생의 PDF 이력 (본인 + admin 가능)
router.get('/portfolios/reports', requireAuth, (req, res) => {
  try {
    const studentId = (req.user.role === 'admin' && req.query.userId)
      ? parseInt(req.query.userId)
      : req.user.id;
    if (req.user.id !== studentId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '본인 이력만 조회 가능합니다.' });
    }
    const reports = growthExtDb.getPortfolioReports(studentId);
    res.json({ success: true, reports });
  } catch (err) {
    console.error('[GROWTH] get reports error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/growth/portfolios/report/:id/download — PDF 다운로드
router.get('/portfolios/report/:id/download', requireAuth, (req, res) => {
  try {
    const reportId = req.params.id;
    const row = growthExtDb.getPortfolioReportById(reportId);
    if (!row) return res.status(404).json({ success: false, message: '보고서를 찾을 수 없습니다.' });

    const owner = row.user_id;
    const isOwner = req.user.id === owner;
    const isAdmin = req.user.role === 'admin';
    const isTeacherWithAccess = req.user.role === 'teacher' && teacherSharesClassWithStudent(req.user.id, owner);
    if (!isOwner && !isAdmin && !isTeacherWithAccess) {
      return res.status(403).json({ success: false, message: '접근 권한이 없습니다.' });
    }

    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ success: false, message: 'PDF 파일이 아직 준비되지 않았습니다.' });
    }
    // 한글 안전 파일명 (RFC 5987)
    const baseName = (row.title || 'portfolio') + '.pdf';
    const encoded = encodeURIComponent(baseName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report.pdf"; filename*=UTF-8''${encoded}`);
    fs.createReadStream(row.file_path).pipe(res);
  } catch (err) {
    console.error('[GROWTH] download report error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/growth/portfolios/report/:id — 보고서 삭제
router.delete('/portfolios/report/:id', requireAuth, (req, res) => {
  try {
    const row = growthExtDb.getPortfolioReportById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: '보고서를 찾을 수 없습니다.' });
    if (row.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const result = growthExtDb.deletePortfolioReport(row.user_id, req.params.id);
    if (!result) return res.status(404).json({ success: false, message: '보고서를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[GROWTH] delete report error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
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
    // xAPI: 감정 출석부 survey.submitted (표준체계 없음)
    try {
      xapiSpool.record('survey', buildSurvey, { userId: req.user.id, classId: classId ? parseInt(classId) : null }, {
        verb: 'submitted',
        survey_id: result.id,
        title: '감정 출석부',
        survey_kind: 'emotion_attendance',
        emotion: { primary: emotion, intensity: score, reason: emotionReason || null },
      });
    } catch (_) {}
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
      'SELECT emotion, emotion_reason, emotion_score FROM emotion_checkins WHERE user_id = ? AND checkin_date = ? LIMIT 1'
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
    // 감정 체크인 내역 (emotion_checkins: user-level, class-independent, 날짜당 1행)
    const records = db.prepare(`
      SELECT checkin_date AS attendance_date, emotion, emotion_reason, emotion_score
      FROM emotion_checkins
      WHERE user_id = ?
      ORDER BY checkin_date DESC
      LIMIT ?
    `).all(req.user.id, limit);

    // 주간 감정 통계 (최근 7일)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStart = weekAgo.toISOString().slice(0, 10);
    const weekStats = db.prepare(`
      SELECT emotion, COUNT(*) as cnt
      FROM emotion_checkins
      WHERE user_id = ? AND checkin_date >= ?
      GROUP BY emotion ORDER BY cnt DESC
    `).all(req.user.id, weekStart);

    // 총 체크인 수 + 연속 체크인 일수
    const totalCheckins = db.prepare(
      'SELECT COUNT(*) as cnt FROM emotion_checkins WHERE user_id = ?'
    ).get(req.user.id).cnt;

    // 연속일수 계산
    const dates = db.prepare(
      'SELECT checkin_date FROM emotion_checkins WHERE user_id = ? ORDER BY checkin_date DESC'
    ).all(req.user.id).map(r => r.checkin_date);
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
    // 감정 체크인은 emotion_checkins (학생 단위) + class_members JOIN 으로 해당 클래스 소속 학생만 조회
    let dateWhere, dateParams;
    if (isRange) {
      dateWhere = 'ec.checkin_date BETWEEN ? AND ?';
      dateParams = [classId, qStart, qEnd];
    } else {
      dateWhere = 'ec.checkin_date = ?';
      dateParams = [classId, filterDate];
    }

    const periodEmotions = db.prepare(`
      SELECT ec.user_id, u.display_name, ec.emotion, ec.emotion_reason, ec.checkin_date AS attendance_date
      FROM emotion_checkins ec
      JOIN class_members cm ON cm.user_id = ec.user_id AND cm.status = 'active'
      JOIN users u ON u.id = ec.user_id
      WHERE cm.class_id = ? AND ${dateWhere}
      ORDER BY ec.checkin_date DESC, ec.id DESC
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
      SELECT ec.user_id, u.display_name, ec.emotion, ec.checkin_date AS attendance_date, ec.checked_at, ec.emotion_score
      FROM emotion_checkins ec
      JOIN class_members cm ON cm.user_id = ec.user_id AND cm.status = 'active'
      JOIN users u ON u.id = ec.user_id
      WHERE cm.class_id = ? AND ec.checkin_date >= ? AND ec.checkin_date <= ?
      ORDER BY ec.checkin_date ASC
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
