const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const noticeDb = require('../db/notice');
const classDb = require('../db/class');
const notifDb = require('../db/notifications');
const initSocket = require('../socket'); // initSocket._io 접근용
const buildNavigation = require('../lib/xapi/builders/navigation');
const buildSocial = require('../lib/xapi/builders/social');
const xapiSpool = require('../lib/xapi/spool');

// ─────────────────────────────────────────────────────────
// 공통 미들웨어
// ─────────────────────────────────────────────────────────
function requireMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (isNaN(classId)) return res.status(400).json({ success: false, message: '클래스 ID가 올바르지 않습니다.' });
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  req.isAdmin = req.user.role === 'admin';
  req.isOwner = req.myRole === 'owner' || req.isAdmin;
  next();
}

function requireOwner(req, res, next) {
  if (!req.isOwner) return res.status(403).json({ success: false, message: '개설자만 가능합니다.' });
  next();
}

// 알림장이 해당 클래스에 속하는지 검증 + req.notice에 보관
function loadNotice(req, res, next) {
  const noticeId = parseInt(req.params.noticeId);
  if (isNaN(noticeId)) return res.status(400).json({ success: false, message: '알림 ID가 올바르지 않습니다.' });
  const notice = noticeDb.getNoticeById(noticeId);
  if (!notice || notice.class_id !== req.classId) {
    return res.status(404).json({ success: false, message: '알림을 찾을 수 없습니다.' });
  }
  req.notice = notice;
  req.noticeId = noticeId;
  next();
}

// ─────────────────────────────────────────────────────────
// 임시저장 (특수 경로 — :noticeId 패턴보다 먼저 정의)
// ─────────────────────────────────────────────────────────
router.get('/:classId/draft', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    const draft = noticeDb.getDraft(req.classId, req.user.id);
    res.json({ success: true, draft });
  } catch (err) {
    console.error('[notice/draft GET]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.put('/:classId/draft', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    const draft = noticeDb.upsertDraft(req.classId, req.user.id, req.body || {});
    res.json({ success: true, draft });
  } catch (err) {
    console.error('[notice/draft PUT]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.delete('/:classId/draft', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    noticeDb.deleteDraft(req.classId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[notice/draft DELETE]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 북마크 목록 (특수 경로 — :noticeId 패턴보다 먼저 정의)
// ─────────────────────────────────────────────────────────
router.get('/:classId/bookmarks', requireAuth, requireMember, (req, res) => {
  try {
    const notices = noticeDb.getBookmarkedNotices(req.classId, req.user.id);
    res.json({ success: true, notices });
  } catch (err) {
    console.error('[notice/bookmarks]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 알림장 목록 / 작성
// ─────────────────────────────────────────────────────────
router.get('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    const result = noticeDb.getNoticesByClass(req.classId, {
      page: parseInt(req.query.page) || 1,
      viewerId: req.user.id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[notice GET list]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/:classId', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    if (!req.body || !req.body.title || !req.body.title.trim()) {
      return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    }
    const notice = noticeDb.createNotice(req.classId, req.user.id, req.body);
    // 임시저장 정리
    try { noticeDb.deleteDraft(req.classId, req.user.id); } catch {}
    // Socket.IO 브로드캐스트 (실패해도 응답엔 영향 없음)
    try {
      const io = initSocket._io;
      if (io) io.to(`class:${req.classId}`).emit('notice:created', {
        classId: req.classId,
        notice: { id: notice.id, title: notice.title, author_name: notice.author_name }
      });
    } catch {}
    // 알림: 클래스 학생 전원에게 새 알림장 알림
    try {
      if (notice && notice.id) {
        notifDb.notifyClassMembers(req.classId, {
          type: 'notice_new',
          title: '새 알림장이 등록되었습니다',
          message: notice.title,
          link: `/class/class-notice.html?classId=${req.classId}&noticeId=${notice.id}`,
          excludeUserId: req.user.id
        });
      }
    } catch (e) { console.error('[NOTICE] notify error:', e.message); }
    res.status(201).json({ success: true, notice });
  } catch (err) {
    console.error('[notice POST]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 알림장 상세 / 수정 / 삭제
// ─────────────────────────────────────────────────────────
router.get('/:classId/:noticeId', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    noticeDb.markRead(req.noticeId, req.user.id);
    // 클래스 마일리지 자동 지급 — 알림장 1건 읽음 (daily_limit=20)
    // UNIQUE(class_id, user_id, source_type='notice_read', source_id=noticeId, reason)으로
    // 같은 알림장 재방문 시 중복 지급 자연 차단.
    try {
      const { awardClassMileage } = require('../db/class-mileage');
      awardClassMileage(req.classId, req.user.id, 'notice_read', req.noticeId);
    } catch (_) {}
    // xAPI: 알림장 읽음 → navigation(read)
    try {
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id, classId: req.classId }, {
        verb: 'read',
        target_id: req.noticeId,
        target_title: req.notice && req.notice.title || `알림장 ${req.noticeId}`,
        content_type: 'document',
      });
    } catch (e) { console.error('[xapi:notice_read]', e.message); }
    // 읽음 표시 직후 다시 조회하여 viewerId 메타까지 반영
    const notice = noticeDb.getNoticeById(req.noticeId, req.user.id);
    let extra = {};
    if (req.isOwner) {
      extra = noticeDb.getReadAndUnreadMembers(req.noticeId, req.classId);
    }
    res.json({ success: true, notice, isRead: true, ...extra });
  } catch (err) {
    console.error('[notice GET detail]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.put('/:classId/:noticeId', requireAuth, requireMember, requireOwner, loadNotice, (req, res) => {
  try {
    const notice = noticeDb.updateNotice(req.noticeId, req.body || {});
    res.json({ success: true, notice });
  } catch (err) {
    console.error('[notice PUT]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.delete('/:classId/:noticeId', requireAuth, requireMember, requireOwner, loadNotice, (req, res) => {
  try {
    noticeDb.deleteNotice(req.noticeId);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[notice DELETE]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 리액션 (토글) — 모든 멤버
// ─────────────────────────────────────────────────────────
const ALLOWED_REACTIONS = new Set(['like', 'check', 'love', 'wow']);
router.post('/:classId/:noticeId/reactions', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    const kind = (req.body && req.body.kind) || '';
    if (!ALLOWED_REACTIONS.has(kind)) {
      return res.status(400).json({ success: false, message: '허용되지 않는 리액션입니다.' });
    }
    const result = noticeDb.toggleReaction(req.noticeId, req.user.id, kind);
    // xAPI: 알림장 공감(리액션) → social(participated) like-cnt=1 (toggle-on 시에만 적재)
    // 감리 REWORK: noticeDb.toggleReaction은 { reactions, my_reactions }만 반환.
    // toggle-on은 my_reactions 배열에 해당 kind 포함 여부로 판정.
    try {
      const isOn = result && Array.isArray(result.my_reactions) && result.my_reactions.includes(kind);
      if (isOn) {
        xapiSpool.record('social', buildSocial, { userId: req.user.id, classId: req.classId }, {
          verb: 'liked',
          board_id: `notice-${req.noticeId}`,
          board_kind: 'other',  // 알림장은 게시판 분류상 기타(E)
          board_title: req.notice && req.notice.title || null,
          counts: { like: 1 },
        });
      }
    } catch (e) { console.error('[xapi:notice_reaction]', e.message); }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[notice reaction]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 북마크 (토글) — 모든 멤버
// ─────────────────────────────────────────────────────────
router.post('/:classId/:noticeId/bookmark', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    const result = noticeDb.toggleBookmark(req.noticeId, req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[notice bookmark]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 댓글
// ─────────────────────────────────────────────────────────
router.get('/:classId/:noticeId/comments', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    const comments = noticeDb.getCommentsTree(req.noticeId);
    res.json({ success: true, comments });
  } catch (err) {
    console.error('[notice comments GET]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/:classId/:noticeId/comments', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    const content = (req.body && req.body.content) ? String(req.body.content).trim() : '';
    if (!content) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    if (content.length > 2000) return res.status(400).json({ success: false, message: '댓글은 2000자 이내로 작성해 주세요.' });
    const parent_id = req.body && req.body.parent_id ? parseInt(req.body.parent_id) : null;
    const comment = noticeDb.addComment(req.noticeId, req.user.id, { content, parent_id });
    if (!comment) return res.status(400).json({ success: false, message: '댓글을 작성하지 못했습니다.' });
    // xAPI: 알림장 댓글 → social(participated) comment-cnt=1
    try {
      xapiSpool.record('social', buildSocial, { userId: req.user.id, classId: req.classId }, {
        verb: 'commented',
        board_id: `notice-${req.noticeId}`,
        board_kind: 'other',
        board_title: req.notice && req.notice.title || null,
        parent_comment_id: parent_id || null,
        counts: { comment: 1 },
      });
    } catch (e) { console.error('[xapi:notice_comment]', e.message); }
    res.status(201).json({ success: true, comment });
  } catch (err) {
    console.error('[notice comments POST]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.put('/:classId/:noticeId/comments/:commentId', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const content = (req.body && req.body.content) ? String(req.body.content).trim() : '';
    if (!content) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    const r = noticeDb.updateComment(commentId, req.user.id, content);
    if (!r.ok) {
      if (r.reason === 'not_found') return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
      if (r.reason === 'forbidden') return res.status(403).json({ success: false, message: '본인 댓글만 수정할 수 있습니다.' });
      if (r.reason === 'deleted') return res.status(410).json({ success: false, message: '삭제된 댓글입니다.' });
      return res.status(400).json({ success: false, message: '수정 실패' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[notice comments PUT]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.delete('/:classId/:noticeId/comments/:commentId', requireAuth, requireMember, loadNotice, (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const r = noticeDb.deleteComment(commentId, req.user.id, { isOwner: req.isOwner });
    if (!r.ok) {
      if (r.reason === 'not_found') return res.status(404).json({ success: false, message: '댓글을 찾을 수 없습니다.' });
      if (r.reason === 'forbidden') return res.status(403).json({ success: false, message: '본인 댓글만 삭제할 수 있습니다.' });
      return res.status(400).json({ success: false, message: '삭제 실패' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[notice comments DELETE]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────
// 미확인 멤버에게 재알림 — 개설자/관리자만
// ─────────────────────────────────────────────────────────
router.post('/:classId/:noticeId/remind', requireAuth, requireMember, requireOwner, loadNotice, (req, res) => {
  try {
    const r = noticeDb.remindUnread(req.noticeId, req.classId, req.user.id);
    if (!r.ok) return res.status(404).json({ success: false, message: '알림을 찾을 수 없습니다.' });
    // Socket.IO 이벤트
    try {
      const io = initSocket._io;
      if (io) {
        const payload = {
          classId: req.classId,
          noticeId: req.noticeId,
          title: req.notice.title,
          link: `/class/notice.html?classId=${req.classId}&noticeId=${req.noticeId}`
        };
        for (const uid of r.target_user_ids) {
          io.to(`user:${uid}`).emit('notice:remind', payload);
        }
      }
    } catch {}
    res.json({ success: true, target_count: r.target_count });
  } catch (err) {
    console.error('[notice remind]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
