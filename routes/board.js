const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const boardDb = require('../db/board');
const boardGallery = require('../db/board-gallery');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const { ensureTodayAttendance } = require('../db/attendance');
const buildSocial = require('../lib/xapi/builders/social');
const xapiSpool = require('../lib/xapi/spool');
const inlineMedia = require('../lib/inline-data-media');

// 본문에 붙여넣기로 들어온 data:image/... 를 **저장 전에** 실제 업로드 파일로 바꾼다.
//   Quill 에디터는 이미지를 붙여넣으면 base64 로 본문에 박아 넣는다. 그대로 저장하면
//   ① 나도예술가로 못 넘어가고(gallery_attachments.url 1000자 절단) ② posts.content 가 비대해진다.
//   ⚠ 규칙(허용 확장자·50MB·저장 위치·파일명)은 /api/upload 와 **같은 lib/upload-rules.js** 를 쓴다.
//     data: 가 검사를 건너뛰는 뒷문이 되면 안 된다.
//   대표 이미지(image_url)가 비어 있으면 변환된 첫 이미지로 채운다 — 나도예술가 표지가 여기서 나온다.
//
// 판정·치환 본체는 lib/inline-data-media.normalizeInlineMedia 한 곳에만 있다
//   — 알림장(routes/notice.js)·과제 제출(routes/homework.js)도 **같은 함수**를 쓴다.
//     화면마다 규칙을 따로 적으면 그 순간 검사가 여러 벌이 된다.
// @returns {null|{status:number, message:string}} null 이면 정상, 아니면 그대로 응답할 에러
function normalizeInlineMedia(postData) {
  return inlineMedia.normalizeInlineMedia(postData, { queryType: 'board', coverField: 'image_url' });
}

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
    // 본문 붙여넣기 이미지(data:base64) → 실제 파일. 규칙 위반이면 여기서 400.
    const mediaErr = normalizeInlineMedia(postData);
    if (mediaErr) return res.status(mediaErr.status).json({ success: false, message: mediaErr.message });
    if (postData.is_anonymous !== undefined) postData.is_anonymous = postData.is_anonymous ? 1 : 0;
    if (postData.allow_comments !== undefined) postData.allow_comments = postData.allow_comments ? 1 : 0;
    // board_id로 게시판 유형 자동 판별
    let board = null;
    if (postData.board_id) {
      try {
        board = boardDb.getBoardById(parseInt(postData.board_id));
        if (board) {
          postData.category = board.board_type; // general or gallery
          // 갤러리 게시판이고 승인 필요이면 pending
          // (나도예술가 연동 게시판은 db/board.js 가 requires_approval=1 을 강제한다 —
          //  "개설자 승인"이 연동의 게이트라는 확정 사양이기 때문)
          if (board.board_type === 'gallery' && board.requires_approval) {
            postData.approval_status = 'pending';
          }
        }
      } catch(e) {}
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
    // 나도예술가 연동: **게시판 설정(class_boards.share_to_gallery)이 유일한 기준**.
    //   이전에는 "글 단위 체크박스 || category==='gallery'" 라 끄는 방법이 없었고,
    //   image_url(파일 선택분) 하나만 넘겨 본문 에디터 이미지·동영상·음원이 누락됐다.
    //   이제 db/board-gallery.js 가 image_url + 본문의 img/video/audio/source/iframe 을 전부 수집한다.
    //   board_id 가 없는 레거시 글은 따를 게시판 설정이 없으므로 연동하지 않는다.
    if (post) {
      try {
        boardGallery.syncOnPostCreate(post, board, { category: req.body.galleryCategory });
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
    // 수정 경로도 같은 관문을 지난다 — 작성 때만 막으면 수정으로 base64 를 다시 넣을 수 있다.
    const patch = { ...req.body };
    const clientSentCover = patch.image_url !== undefined;
    const mediaErr = normalizeInlineMedia(patch);
    if (mediaErr) return res.status(mediaErr.status).json({ success: false, message: mediaErr.message });
    // 자동 채움(변환된 첫 이미지)은 **원래 대표 이미지가 없을 때만**.
    //   클라이언트가 image_url 을 직접 보냈으면 그 값을 존중하고,
    //   보내지 않았는데 기존 대표 이미지가 있으면 덮지 않는다.
    if (!clientSentCover && patch.image_url && post.image_url) delete patch.image_url;
    const updated = boardDb.updatePost(post.id, patch);
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
    // 연결된 student_gallery 항목 동기화 — 행이 있으면 approved 전환(+첨부 비었으면 이때 채움),
    // 없고 게시판 설정이 켜져 있으면 새로 INSERT (누락 보정). 판단 기준은 생성 시점과 동일하다.
    try {
      const board = post.board_id ? boardDb.getBoardById(post.board_id) : null;
      boardGallery.syncOnPostApprove(post, board, req.user.id);
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
      boardGallery.syncOnPostReject(post, req.body.reason);
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
