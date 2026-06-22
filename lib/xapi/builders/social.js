// lib/xapi/builders/social.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — social-learning (이벤트형)
// 학급 게시판 · 자유게시판 · 모둠 활동 등 소셜 활동.
//
// v1.0 정합 (이벤트형 verb):
//   - 라우터 입력 verb 매핑(최종 verb.id 는 항상 social-learning 프로필 이벤트형 IRI):
//       shared/created/posted → posted, liked → liked, commented → commented,
//       replied → replied, viewed → social-learning viewed,
//       participated(집계) → posted
//   - activity-type slug → 'social-learning'
//   - object.definition.extensions: board-info(플랫) + curriculum-standard-id(표준 위치)
//   - result.extensions: social-learning-detail(플랫, view/post/reply/comment/like-cnt + duration)
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension, mapBoardType,
  resolveStandardContext,
} = require('../common');

/**
 * 라우터 입력 verb → v1.0 social-learning 이벤트형 표준 verb 키 + 카운트
 */
function mapSocialVerb(verbKey) {
  switch (verbKey) {
    case 'shared':
    case 'created':
    case 'posted':       return { verbObj: VERB.posted,       name: 'posted',    counts: { post: 1 } };
    case 'commented':    return { verbObj: VERB.commented,    name: 'commented', counts: { comment: 1 } };
    case 'replied':      return { verbObj: VERB.replied,      name: 'replied',   counts: { reply: 1 } };
    case 'liked':        return { verbObj: VERB.liked,        name: 'liked',     counts: { like: 1 } };
    case 'viewed':       return { verbObj: VERB.socialViewed, name: 'viewed',    counts: { view: 1 } };
    case 'participated': return { verbObj: VERB.posted,       name: 'posted',    counts: {} }; // 집계 — counts 별도
    default:             return { verbObj: VERB.posted,       name: 'posted',    counts: {} };
  }
}

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 소셜 활동 파라미터
 *   필수:
 *     - board_kind (class/group/free/...) — mapBoardType 으로 C/G/E 변환
 *     - board_id  (게시판 식별자) 또는 post_id (이벤트 단위 호출 호환)
 *   선택:
 *     - verb: shared/commented/liked/viewed/replied/participated
 *     - counts: { view, post, reply, comment, like } — 집계 호출 시
 *     - duration_seconds, post_title 등
 * @returns {{ statement, meta }}
 */
module.exports = function buildSocial(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'posted').toLowerCase();
    const mapped = mapSocialVerb(verbKey);
    const verb = mapped.verbObj; // 항상 social-learning 이벤트형 IRI

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId);
    const boardKind = p.board_kind || 'class_board';
    const boardTypeCode = mapBoardType(boardKind);  // C/G/E
    const boardId = p.board_id != null ? p.board_id : (p.post_id != null ? `post-${p.post_id}` : `board-${ctx.classId || 0}`);

    // board-info(플랫) — object.definition.extensions
    const boardInfoBody = [{
      id: String(boardId),
      type: boardTypeCode,
      title: p.board_title || p.post_title || null,
    }];

    const object = makeActivity({
      type: 'social-learning',
      id: boardId,
      name: p.board_title || p.post_title || `게시판 ${boardId}`,
      extraExtensions: {
        [EXT.boardInfo]: boardInfoBody,
        ...stdIdExtension(resolved),
      },
    });

    // 카운트 집계: payload.counts 우선, 없으면 verb 기반 1건 카운트
    const counts = p.counts && typeof p.counts === 'object'
      ? p.counts
      : mapped.counts;

    const duration = Math.max(0, Math.round(Number(p.duration_seconds) || 0));

    // social-learning-detail (PDF 66쪽)
    const detailBody = [{
      id: String(boardId),
      'board-type': boardTypeCode,
      'view-cnt': Number(counts.view) || 0,
      'post-cnt': Number(counts.post) || 0,
      'reply-cnt': Number(counts.reply) || 0,
      'comment-cnt': Number(counts.comment) || 0,
      'like-cnt': Number(counts.like) || 0,
      duration,
    }];

    const result = {
      extensions: {
        [EXT.socialLearningDetail]: detailBody,
      },
    };

    // 다채움 내부: 이벤트 본문은 별도 namespace 로 보존
    if (p.body) {
      result.response = p.body;
    }
    if (p.parent_comment_id != null) {
      result.extensions['https://dacheum.kr/xapi/extension/parent-comment-id'] = p.parent_comment_id;
    }
    // 갤러리 승인 상태 등 다채움 고유 데이터
    if (p.approval_status) {
      result.extensions['https://dacheum.kr/xapi/extension/approval-status'] = p.approval_status;
    }

    const context = makeContext({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const statement = makeStatement({
      actor, verb, object, result, context,
      timestamp: ctx.timestamp || new Date().toISOString(),
    });

    const meta = {
      area: 'social',
      verb: mapped.name,
      object_type: 'social-learning',
      object_id: (typeof boardId === 'number') ? boardId : null,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union),
    };
    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};
