const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const contentDb = require('../db/content');
const { logLearningActivity } = require('../db/learning-log-helper');

// ===== 내자료 폴더 =====
router.get('/folders', requireAuth, (req, res) => {
  try { res.json({ success: true, folders: contentDb.getMyFolders(req.user.id) }); }
  catch { res.status(500).json({ success: false, message: '서버 오류' }); }
});

router.post('/folders', requireAuth, (req, res) => {
  try {
    if (!req.body.name?.trim()) return res.status(400).json({ success: false, message: '폴더 이름을 입력하세요.' });
    const folder = contentDb.createMyFolder(req.user.id, req.body.name.trim());
    res.status(201).json({ success: true, folder });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ success: false, message: '이미 같은 이름의 폴더가 있습니다.' });
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

router.delete('/folders/:id', requireAuth, (req, res) => {
  try {
    const ok = contentDb.deleteMyFolder(req.user.id, parseInt(req.params.id));
    res.json({ success: true, deleted: ok });
  } catch { res.status(500).json({ success: false, message: '서버 오류' }); }
});

router.post('/move-to-folder', requireAuth, (req, res) => {
  try {
    const ok = contentDb.moveContentToFolder(parseInt(req.body.contentId), req.body.folderId ? parseInt(req.body.folderId) : null, req.user.id);
    res.json({ success: true, moved: ok });
  } catch { res.status(500).json({ success: false, message: '서버 오류' }); }
});

// GET /api/contents - 공개 콘텐츠 검색
router.get('/', requireAuth, (req, res) => {
  try {
    const { keyword, subject, grade, content_type, page, limit, sort, achievement_codes } = req.query;
    const result = contentDb.searchPublicContents({
      keyword, subject,
      grade: grade ? parseInt(grade) : null,
      content_type,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 12,
      sort,
      achievement_codes: achievement_codes ? achievement_codes.split(',').filter(Boolean) : null
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CONTENT] search error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/search-for-lesson - 수업용 콘텐츠 검색 (자기 콘텐츠 + 공개 콘텐츠)
router.get('/search-for-lesson', requireAuth, (req, res) => {
  try {
    const { keyword, content_type, subject, grade } = req.query;
    const contents = contentDb.searchContentsForLesson(req.user.id, {
      keyword: keyword || '',
      content_type: content_type || null,
      subject: subject || null,
      grade: grade || null,
      limit: parseInt(req.query.limit) || 20
    });
    res.json({ success: true, contents });
  } catch (err) {
    console.error('[CONTENT] search-for-lesson error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/activity-trend - 내 콘텐츠 활동 추이 (실제 데이터)
router.get('/activity-trend', requireAuth, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const metric = req.query.metric || 'views'; // views, shares, saves
    const trend = contentDb.getActivityTrend(req.user.id, days, metric);
    res.json({ success: true, trend });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/popular-tags - 인기 태그 (공개 콘텐츠 기준 집계)
router.get('/popular-tags', requireAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    const tags = contentDb.getPopularTags(limit);
    res.json({ success: true, tags });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/recommendations - 추천 콘텐츠
router.get('/recommendations', requireAuth, (req, res) => {
  try {
    const keywords = req.query.keywords ? req.query.keywords.split(',').filter(Boolean) : [];
    const contents = contentDb.getRecommendations(req.user.id, parseInt(req.query.limit) || 12, keywords);
    res.json({ success: true, contents });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/pending - 승인 대기 콘텐츠 (교사/관리자)
router.get('/pending', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const result = contentDb.getPendingContents({ page: parseInt(req.query.page) || 1 });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/approve - 콘텐츠 승인
router.post('/:id/approve', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.approveContent(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '콘텐츠가 승인되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/reject - 콘텐츠 반려
router.post('/:id/reject', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.rejectContent(parseInt(req.params.id), req.body.reason);
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '콘텐츠가 반려되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/hold - 콘텐츠 보류
router.post('/:id/hold', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.holdContent(parseInt(req.params.id), req.body.reason);
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '콘텐츠가 보류되었습니다.' });
  } catch (err) {
    console.error('[CONTENT] hold error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/review - 콘텐츠 검토중으로 변경
router.post('/:id/review', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.reviewContent(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '검토 상태로 변경되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/review-all - 전체 검토 대상 콘텐츠 (승인관리용)
router.get('/review-all', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const result = contentDb.getAllReviewContents({
      page: parseInt(req.query.page) || 1,
      status: req.query.status || 'all'
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/my - 내 콘텐츠
router.get('/my', requireAuth, (req, res) => {
  try {
    const result = contentDb.getMyContents(req.user.id, {
      page: parseInt(req.query.page) || 1,
      limit: req.query.limit ? parseInt(req.query.limit) : undefined
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents - 콘텐츠 생성
router.post('/', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    if (typeof req.body.tags === 'string') {
      req.body.tags = req.body.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    // 서버에서 status 결정 (클라이언트 값 무시)
    if (req.body.is_public) {
      req.body.status = req.user.role === 'admin' ? 'approved' : 'pending';
    } else {
      req.body.status = 'draft';
    }
    const content = contentDb.createContent(req.user.id, req.body);

    // 수업꾸러미: package_items 저장
    if (req.body.bundle_items && Array.isArray(req.body.bundle_items) && content.id) {
      contentDb.saveBundleItems(content.id, req.body.bundle_items);
    }

    // 평가지: quiz_content_ids에서 문항 복사
    if (req.body.quiz_content_ids && Array.isArray(req.body.quiz_content_ids) && content.id) {
      const db = require('../db/index');
      let qNum = 1;
      for (const srcContentId of req.body.quiz_content_ids) {
        try {
          const questions = db.prepare('SELECT * FROM content_questions WHERE content_id = ? ORDER BY question_number').all(srcContentId);
          for (const q of questions) {
            db.prepare('INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
              content.id, qNum++, q.question_text, q.question_type || 'multiple_choice', q.options, q.answer, q.explanation, q.points || 10
            );
          }
        } catch (e) { console.error('[CONTENT] quiz copy error:', e.message); }
      }
    }

    // questions 직접 전달된 경우 (문항 직접 만들기)
    if (req.body.questions && Array.isArray(req.body.questions) && content.id) {
      const db = require('../db/index');
      req.body.questions.forEach((q, i) => {
        db.prepare(`INSERT INTO content_questions
          (content_id, question_number, question_text, question_type, options, answer, explanation, points, difficulty, instruction, passage, media_url, media_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          content.id, i + 1,
          q.question_text || q.text || '',
          q.question_type || q.type || 'multiple_choice',
          typeof q.options === 'string' ? q.options : JSON.stringify(q.options || []),
          q.answer !== undefined ? q.answer : (q.answer_index !== undefined ? q.answer_index : 0),
          q.explanation || '',
          q.points || 10,
          q.difficulty || 3,
          q.instruction || null,
          q.passage || null,
          q.media_url || null,
          q.media_type || null
        );
      });
    }

    res.status(201).json({ success: true, content });
  } catch (err) {
    console.error('[CONTENT] create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/:id - 콘텐츠 상세
router.get('/:id', requireAuth, (req, res) => {
  try {
    const content = contentDb.getContentById(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    contentDb.incrementViewCount(content.id);
    logLearningActivity({
      userId: req.user.id,
      activityType: 'content_view',
      targetType: 'content',
      targetId: req.params.id,
      verb: 'accessed',
      sourceService: 'content'
    });
    const isCollected = contentDb.isInCollection(req.user.id, content.id);
    res.json({ success: true, content, isCollected });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/:id/comments - 댓글 목록
router.get('/:id/comments', requireAuth, (req, res) => {
  try {
    const comments = contentDb.getContentComments(parseInt(req.params.id));
    res.json({ success: true, comments });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/comments - 댓글 작성
router.post('/:id/comments', requireAuth, (req, res) => {
  try {
    if (!req.body.text || !req.body.text.trim()) return res.status(400).json({ success: false, message: '댓글 내용을 입력하세요.' });
    const comment = contentDb.addContentComment(parseInt(req.params.id), req.user.id, req.body.text.trim(), req.body.parentId);
    res.status(201).json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/contents/:id/comments/:commentId - 댓글 삭제
router.delete('/:id/comments/:commentId', requireAuth, (req, res) => {
  try {
    const ok = contentDb.deleteContentComment(parseInt(req.params.commentId), req.user.id);
    if (!ok) return res.status(403).json({ success: false, message: '삭제 권한이 없습니다.' });
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/contents/:id - 콘텐츠 수정
router.put('/:id', requireAuth, (req, res) => {
  try {
    const content = contentDb.getContentById(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    if (content.creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // 공개/비공개 전환 시 status 자동 조정 (관리자 외에는 status 필드 직접 수정 불가)
    let statusChanged = false;
    let newStatus = null;
    if (req.user.role !== 'admin') {
      // 일반 사용자는 status 필드를 직접 지정할 수 없음
      if ('status' in req.body) delete req.body.status;
    }
    if ('is_public' in req.body) {
      const nextPublic = req.body.is_public ? 1 : 0;
      const prevPublic = content.is_public ? 1 : 0;
      if (nextPublic === 1 && prevPublic === 0) {
        // 비공개 → 공개 전환: 관리자는 즉시 승인, 그 외는 승인 대기로 전환
        newStatus = req.user.role === 'admin' ? 'approved' : 'pending';
        req.body.status = newStatus;
        statusChanged = true;
      } else if (nextPublic === 0 && prevPublic === 1) {
        // 공개 → 비공개 전환: draft로 되돌림
        newStatus = 'draft';
        req.body.status = newStatus;
        statusChanged = true;
      }
    }

    const updated = contentDb.updateContent(content.id, req.body);
    let message = '수정되었습니다.';
    if (statusChanged) {
      if (newStatus === 'pending') message = '수정되었습니다. 공개 승인 대기 상태로 전환되었습니다.';
      else if (newStatus === 'approved') message = '수정되었습니다. 공개 상태로 전환되었습니다.';
      else if (newStatus === 'draft') message = '수정되었습니다. 비공개로 전환되었습니다.';
    }
    res.json({ success: true, content: updated, statusChanged, newStatus, message });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/contents/:id - 콘텐츠 삭제
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const content = contentDb.getContentById(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    if (content.creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    contentDb.deleteContent(content.id);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/like - 좋아요
router.post('/:id/like', requireAuth, (req, res) => {
  try {
    const content = contentDb.toggleLike(parseInt(req.params.id));
    res.json({ success: true, like_count: content.like_count });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 보관함 ==========

// GET /api/contents/collection/list - 보관함 목록
router.get('/collection/list', requireAuth, (req, res) => {
  try {
    const result = contentDb.getCollection(req.user.id, {
      folderName: req.query.folder,
      page: parseInt(req.query.page) || 1
    });
    const folders = contentDb.getCollectionFolders(req.user.id);
    res.json({ success: true, ...result, folders });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/collection/:contentId - 보관함 추가
router.post('/collection/:contentId', requireAuth, (req, res) => {
  try {
    const result = contentDb.addToCollection(req.user.id, parseInt(req.params.contentId), req.body && req.body.folder);
    if (!result.success) return res.status(409).json({ success: false, message: '이미 보관함에 있습니다.' });
    res.json({ success: true, message: '보관함에 추가했습니다.' });
  } catch (err) {
    console.error('[CONTENT] collection add error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', error: err.message });
  }
});

// DELETE /api/contents/collection/:contentId - 보관함에서 제거
router.delete('/collection/:contentId', requireAuth, (req, res) => {
  try {
    contentDb.removeFromCollection(req.user.id, parseInt(req.params.contentId));
    res.json({ success: true, message: '보관함에서 제거했습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 채널 ==========

// GET /api/contents/channels/list - 인기 채널
router.get('/channels/list', requireAuth, (req, res) => {
  try {
    const channels = contentDb.getPopularChannels(parseInt(req.query.limit) || 8);
    res.json({ success: true, channels });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/my - 내 채널
router.get('/channels/my', requireAuth, (req, res) => {
  try {
    let channel = contentDb.getUserChannel(req.user.id);
    res.json({ success: true, channel });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/channels - 채널 생성
router.post('/channels', requireAuth, (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ success: false, message: '채널 이름을 입력하세요.' });
    const existing = contentDb.getUserChannel(req.user.id);
    if (existing) return res.status(409).json({ success: false, message: '이미 채널이 있습니다.', channel: existing });
    const channel = contentDb.createChannel(req.user.id, req.body);
    res.status(201).json({ success: true, channel });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/contents/channels/:channelId - 채널 수정
router.put('/channels/:channelId', requireAuth, (req, res) => {
  try {
    const channel = contentDb.getChannelById(parseInt(req.params.channelId));
    if (!channel) return res.status(404).json({ success: false, message: '채널을 찾을 수 없습니다.' });
    if (channel.user_id !== req.user.id) return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    const updated = contentDb.updateChannel(channel.id, req.body);
    res.json({ success: true, channel: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/:channelId - 채널 상세 + 콘텐츠
router.get('/channels/:channelId', requireAuth, (req, res) => {
  try {
    const channel = contentDb.getChannelById(parseInt(req.params.channelId));
    if (!channel) return res.status(404).json({ success: false, message: '채널을 찾을 수 없습니다.' });
    const isSubscribed = contentDb.isSubscribed(channel.id, req.user.id);
    const result = contentDb.getChannelContents(channel.id, { page: parseInt(req.query.page) || 1 });
    res.json({ success: true, channel, isSubscribed, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/channels/:channelId/subscribe - 구독/구독취소 토글
router.post('/channels/:channelId/subscribe', requireAuth, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    if (contentDb.isSubscribed(channelId, req.user.id)) {
      contentDb.unsubscribe(channelId, req.user.id);
      res.json({ success: true, subscribed: false, message: '구독을 취소했습니다.' });
    } else {
      contentDb.subscribe(channelId, req.user.id);
      res.json({ success: true, subscribed: true, message: '채널을 구독했습니다.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/channels/:channelId/posts - 채널 커뮤니티 게시
router.post('/channels/:channelId/posts', requireAuth, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    const db = require('../db');
    const info = db.prepare('INSERT INTO channel_posts (channel_id, user_id, content) VALUES (?, ?, ?)').run(channelId, req.user.id, content.trim());
    const post = db.prepare('SELECT cp.*, u.display_name FROM channel_posts cp JOIN users u ON cp.user_id = u.id WHERE cp.id = ?').get(info.lastInsertRowid);
    res.status(201).json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/:channelId/posts - 채널 커뮤니티 목록
router.get('/channels/:channelId/posts', requireAuth, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const db = require('../db');
    const posts = db.prepare('SELECT cp.*, u.display_name FROM channel_posts cp JOIN users u ON cp.user_id = u.id WHERE cp.channel_id = ? ORDER BY cp.created_at DESC LIMIT 50').all(channelId);
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/subscriptions/list - 내 구독 채널
router.get('/channels/subscriptions/list', requireAuth, (req, res) => {
  try {
    const channels = contentDb.getUserSubscriptions(req.user.id);
    res.json({ success: true, channels });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
