const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const boardDb = require('../db/board');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const { ensureTodayAttendance } = require('../db/attendance');
const buildSocial = require('../lib/xapi/builders/social');
const xapiSpool = require('../lib/xapi/spool');

// 게시판 카테고리 → AIDT board_kind (C/G/E) 매핑용
function _resolveBoardKind(post, classDb) {
  const cat = String(post && post.category || '').toLowerCase();
  if (cat === 'gallery') return 'other';     // → E (기타)
  if (cat === 'group') return 'group';       // → G
  // 학급 일반 게시글은 학급 게시판 (C)
  return 'class';
}

function requireMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  next();
}

// ===== 게시판(Board) 관리 API =====
// 게시판 목록
router.get('/:classId/boards', requireAuth, requireMember, (req, res) => {
  try {
    const boards = boardDb.getBoardsByClass(req.classId);
    res.json({ success: true, boards });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// 게시판 생성 (교사/개설자만)
router.post('/:classId/boards', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 게시판을 만들 수 있습니다.' });
    if (!req.body.name) return res.status(400).json({ success: false, message: '게시판 이름을 입력하세요.' });
    const board = boardDb.createBoard(req.classId, req.body);
    res.status(201).json({ success: true, board });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// 게시판 수정
router.put('/:classId/boards/:boardId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 수정할 수 있습니다.' });
    const board = boardDb.updateBoard(parseInt(req.params.boardId), req.body);
    res.json({ success: true, board });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// 게시판 삭제
router.delete('/:classId/boards/:boardId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 삭제할 수 있습니다.' });
    boardDb.deleteBoard(parseInt(req.params.boardId));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// 게시판 순서 변경
router.put('/:classId/boards/reorder', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    boardDb.reorderBoards(req.classId, req.body.ids || []);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===== 게시글 목록 (board_id 필터 지원) =====
router.get('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    const result = boardDb.getPostsByClass(req.classId, {
      category: req.query.category,
      boardId: req.query.boardId ? parseInt(req.query.boardId) : null,
      page: parseInt(req.query.page) || 1,
      userId: req.user.id
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    // is_anonymous, allow_comments 처리
    const postData = { ...req.body };
    if (postData.is_anonymous !== undefined) postData.is_anonymous = postData.is_anonymous ? 1 : 0;
    if (postData.allow_comments !== undefined) postData.allow_comments = postData.allow_comments ? 1 : 0;
    // board_id로 게시판 유형 자동 판별
    if (postData.board_id) {
      try {
        const board = boardDb.getBoardById(parseInt(postData.board_id));
        if (board) {
          postData.category = board.board_type; // general or gallery
          // 갤러리 게시판이고 승인 필요이면 pending
          if (board.board_type === 'gallery' && board.requires_approval) {
            postData.approval_status = 'pending';
          }
        }
      } catch(e) {}
    }
    // 갤러리 + 나도예술가 공유 요청 시 승인 대기 상태로 생성
    if (postData.category === 'gallery' && postData.shareToGallery) {
      postData.approval_status = 'pending';
    }
    const post = boardDb.createPost(req.classId, req.user.id, postData);
    logLearningActivity({
      userId: req.user.id,
      activityType: 'post_create',
      targetType: 'post',
      targetId: post ? post.id : 0,
      classId: req.classId,
      verb: 'created',
      sourceService: 'class',
      ...extractLogContext(req)
    });
    // 나도예술가 공유 옵션: 갤러리 게시글을 student_gallery에도 등록
    // 트리거 조건 (둘 중 하나):
    //   (1) shareToGallery=true (사용자 명시적 옵션)
    //   (2) 갤러리 게시판(board_type='gallery')에 작성된 게시글 → 자동 동기화
    // image_url이 없어도 placeholder로 row를 생성해야 승인/반려 시 동기화가 가능
    const shouldShareToGallery = (req.body.shareToGallery === true)
      || (postData.category === 'gallery');
    if (shouldShareToGallery && post) {
      try {
        const growthDb = require('../db/growth');
        const created = growthDb.createGalleryItem(req.user.id, {
          title: req.body.title,
          description: req.body.content || '',
          image_url: req.body.image_url || '/images/placeholder.png',
          category: req.body.galleryCategory || 'art',
          approval_status: 'pending',
          source_post_id: post.id,
          source: 'board'
        });
        if (!created || !created.id) {
          console.error('[BOARD] gallery share: createGalleryItem returned empty', { post_id: post.id });
        }
      } catch (e) {
        console.error('[BOARD] gallery share error:', e && e.message, 'post_id=', post.id);
      }
    }
    // 클래스 마일리지 자동 지급 — 게시글 작성 (daily_limit=3)
    try {
      if (post && post.id) {
        const { awardClassMileage } = require('../db/class-mileage');
        awardClassMileage(req.classId, req.user.id, 'board_post', post.id);
      }
    } catch (_) {}
    // xAPI: 게시글 작성 → social(participated) — post-cnt=1
    try {
      if (post && post.id) {
        const boardKind = _resolveBoardKind(post);
        xapiSpool.record('social', buildSocial, { userId: req.user.id, classId: req.classId }, {
          verb: 'shared',
          board_id: post.board_id != null ? `board-${post.board_id}` : `class-${req.classId}`,
          board_kind: boardKind,
          board_title: post.title || null,
          post_id: post.id,
          post_title: post.title || null,
          counts: { post: 1 },
        });
      }
    } catch (e) { console.error('[xapi:board_post]', e.message); }
    res.status(201).json({ success: true, post });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/:classId/:postId', requireAuth, requireMember, (req, res) => {
  try {
    const post = boardDb.getPostById(parseInt(req.params.postId), req.user.id);
    if (!post || post.class_id !== req.classId) return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    // 승인 가드: 교사(개설자)·관리자는 전부 열람 가능. 그 외에는
    // approved(또는 레거시 approval_status IS NULL) 또는 본인 글만 열람. 그렇지 않으면 존재를 은닉(404).
    // (목록 getPostsByClass 의 은닉 규칙과 대칭 — 미승인/반려 글이 상세로만 뚫리던 문제 차단)
    const isPrivileged = req.myRole === 'owner' || req.user.role === 'admin';
    const isVisible = post.approval_status == null || post.approval_status === 'approved' || post.author_id === req.user.id;
    if (!isPrivileged && !isVisible) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    boardDb.incrementViewCount(post.id);
    const comments = boardDb.getComments(post.id);
    try { ensureTodayAttendance(req.classId, req.user.id, 'post_read'); } catch (e) {}
    res.json({ success: true, post: { ...post, view_count: post.view_count + 1 }, comments });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// 게시글 좋아요 토글
router.post('/:classId/:postId/like', requireAuth, requireMember, (req, res) => {
  try {
    const postId = parseInt(req.params.postId);
    const post = boardDb.getPostById(postId);
    if (!post || post.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    const result = boardDb.togglePostLike(postId, req.user.id);
    // xAPI: 좋아요 추가시에만 호출 (취소시는 노이즈 방지를 위해 호출 안 함)
    if (result.liked) {
      try {
        const boardKind = _resolveBoardKind(post);
        xapiSpool.record('social', buildSocial, { userId: req.user.id, classId: req.classId }, {
          verb: 'liked',
          board_id: post.board_id != null ? `board-${post.board_id}` : `class-${req.classId}`,
          board_kind: boardKind,
          board_title: post.title || null,
          post_id: postId,
          post_title: post.title || null,
          counts: { like: 1 },
        });
      } catch (e) { console.error('[xapi:board_like]', e.message); }
    }
    res.json({ success: true, liked: result.liked, like_count: result.like_count });
  } catch (err) {
    console.error('[BOARD] like error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.put('/:classId/:postId', requireAuth, requireMember, (req, res) => {
  try {
    const post = boardDb.getPostById(parseInt(req.params.postId));
    if (!post) return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    if (post.author_id !== req.user.id && req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const updated = boardDb.updatePost(post.id, req.body);
    res.json({ success: true, post: updated });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.delete('/:classId/:postId', requireAuth, requireMember, (req, res) => {
  try {
    const post = boardDb.getPostById(parseInt(req.params.postId));
    if (!post) return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    if (post.author_id !== req.user.id && req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    boardDb.deletePost(post.id);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// 댓글
router.post('/:classId/:postId/comments', requireAuth, requireMember, (req, res) => {
  try {
    if (!req.body.content) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    // 댓글없는 게시글 체크
    const post = boardDb.getPostById(parseInt(req.params.postId));
    if (post && post.allow_comments === 0) {
      return res.status(403).json({ success: false, message: '이 게시글은 댓글이 비활성화되어 있습니다.' });
    }
    const comment = boardDb.createComment(parseInt(req.params.postId), req.user.id, req.body.content, req.body.parent_id || null);
    try { ensureTodayAttendance(req.classId, req.user.id, 'comment_write'); } catch (e) {}
    // 클래스 마일리지 자동 지급 — 댓글 작성 (daily_limit=10)
    try {
      if (comment && comment.id) {
        const { awardClassMileage } = require('../db/class-mileage');
        awardClassMileage(req.classId, req.user.id, 'board_comment', comment.id);
      }
    } catch (_) {}
    // xAPI: 댓글 작성 → social(participated) — comment-cnt=1
    try {
      if (comment && comment.id) {
        const boardKind = _resolveBoardKind(post);
        xapiSpool.record('social', buildSocial, { userId: req.user.id, classId: req.classId }, {
          verb: 'commented',
          board_id: post && post.board_id != null ? `board-${post.board_id}` : `class-${req.classId}`,
          board_kind: boardKind,
          board_title: post ? post.title : null,
          post_id: parseInt(req.params.postId),
          parent_comment_id: req.body.parent_id || null,
          counts: { comment: 1 },
        });
      }
    } catch (e) { console.error('[xapi:board_comment]', e.message); }
    res.status(201).json({ success: true, comment });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.delete('/:classId/:postId/comments/:commentId', requireAuth, requireMember, (req, res) => {
  try {
    const comment = boardDb.getCommentById(parseInt(req.params.commentId));
    if (!comment) return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
    if (comment.author_id !== req.user.id && req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    boardDb.deleteComment(comment.id);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// 승인 대기 게시물 목록 (교사)
router.get('/:classId/pending/list', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    const posts = boardDb.getPendingPosts(req.classId);
    res.json({ success: true, posts });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// 게시물 승인
router.post('/:classId/:postId/approve', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 승인할 수 있습니다.' });
    const post = boardDb.approvePost(parseInt(req.params.postId));
    if (!post) return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    // 연결된 student_gallery 항목 동기화 — row가 없으면 새로 INSERT (UPSERT 패턴)
    try {
      const db = require('../db/index');
      const existing = db.prepare('SELECT id FROM student_gallery WHERE source_post_id = ?').get(post.id);
      if (existing) {
        const upd = db.prepare(`
          UPDATE student_gallery SET approval_status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
          WHERE source_post_id = ?
        `).run(req.user.id, post.id);
        if (!upd.changes) {
          console.error('[BOARD] approve: gallery UPDATE no-op', { post_id: post.id });
        }
      } else if (post.category === 'gallery') {
        // 갤러리 카테고리 게시글인데 student_gallery row가 없는 경우 — 누락 보정
        const growthDb = require('../db/growth');
        const created = growthDb.createGalleryItem(post.author_id, {
          title: post.title,
          description: post.content || '',
          image_url: post.image_url || '/images/placeholder.png',
          category: 'art',
          approval_status: 'approved',
          source_post_id: post.id,
          source: 'board'
        });
        if (created && created.id) {
          db.prepare(`
            UPDATE student_gallery SET approved_by = ?, approved_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(req.user.id, created.id);
        } else {
          console.error('[BOARD] approve: gallery backfill INSERT failed', { post_id: post.id });
        }
      }
    } catch (e) {
      console.error('[BOARD] approve gallery sync error:', e && e.message, 'post_id=', post.id);
    }
    res.json({ success: true, post, message: '승인되었습니다.' });
  } catch (err) {
    console.error('[BOARD] approve error:', err && err.message);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 게시물 반려
router.post('/:classId/:postId/reject', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 반려할 수 있습니다.' });
    const post = boardDb.rejectPost(parseInt(req.params.postId), req.body.reason);
    if (!post) return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    // 연결된 student_gallery 항목도 반려
    try {
      const db = require('../db/index');
      const upd = db.prepare("UPDATE student_gallery SET approval_status = 'rejected', reject_reason = ? WHERE source_post_id = ?")
        .run(req.body.reason || null, post.id);
      if (!upd.changes && post.category === 'gallery') {
        console.error('[BOARD] reject: no student_gallery row to sync', { post_id: post.id });
      }
    } catch (e) {
      console.error('[BOARD] reject gallery sync error:', e && e.message, 'post_id=', post.id);
    }
    res.json({ success: true, post, message: '반려되었습니다.' });
  } catch (err) {
    console.error('[BOARD] reject error:', err && err.message);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
