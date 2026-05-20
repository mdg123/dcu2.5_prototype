// lib/xapi/builders/social.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: participated (PDF 65~68쪽)
// 학급 게시판 · 자유게시판 · 모둠 활동 등 소셜 활동.
//
// Phase 2 모델 전환:
//   - 다채움 trail: 이벤트 단위(shared/commented/liked)는 learning_logs 에 그대로 보존.
//   - AIDT 트랙: 게시판 단위 누적 집계 1 statement (verb=participated).
//   - activity-type slug → 'social-learning' (이전 'post' 폐기)
//   - object.definition.extensions: boardInfo (board-type C/G/E, board-id 등)
//   - result.extensions: socialLearningDetail (view-cnt, post-cnt, reply-cnt,
//                                              comment-cnt, like-cnt, duration)
//   - 두 가지 호출 모드 지원:
//       · 이벤트 단위 호출(legacy): payload.verb 가 shared/commented/liked 인 경우 →
//                                    내부에서 1건짜리 카운트로 변환 (호출처 호환).
//       · 집계 호출(권장): payload.counts = { view, post, reply, comment, like } →
//                          그대로 socialLearningDetail 에 반영.
//   - 헬퍼: aggregateSocialStatements()  → db/learning-log-helper.js 에 신설
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, mapBoardType,
  resolveStandardContext,
} = require('../common');

/**
 * 이벤트 단위 verb → 단일 카운트로 변환
 */
function eventVerbToCounts(verbKey) {
  switch (verbKey) {
    case 'shared': return { post: 1 };
    case 'commented': return { comment: 1 };
    case 'replied': return { reply: 1 };
    case 'liked': return { like: 1 };
    case 'viewed': return { view: 1 };
    case 'participated': return {};  // counts 별도 전달
    default: return {};
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
    const verbKey = String(p.verb || 'participated').toLowerCase();
    // 이벤트 단위 verb 도 모두 'participated' 로 흡수 — AIDT 표준 단일 verb
    const verb = VERB.participated;

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const boardKind = p.board_kind || 'class_board';
    const boardTypeCode = mapBoardType(boardKind);  // C/G/E
    const boardId = p.board_id != null ? p.board_id : (p.post_id != null ? `post-${p.post_id}` : `board-${ctx.classId || 0}`);

    // board-info — object.definition.extensions (PDF 65쪽)
    const boardInfoBody = [{
      id: String(boardId),
      type: boardTypeCode,
      title: p.board_title || p.post_title || null,
      'curriculum-standard-id': resolved.primary_std_id || null,
    }];

    const object = makeActivity({
      type: 'social-learning',
      id: boardId,
      name: p.board_title || p.post_title || `게시판 ${boardId}`,
      extraExtensions: {
        [EXT.boardInfo]: boardInfoBody,
      },
    });

    // 카운트 집계: payload.counts 우선, 없으면 verb 기반 1건 카운트
    const counts = p.counts && typeof p.counts === 'object'
      ? p.counts
      : eventVerbToCounts(verbKey);

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
      verb: 'participated',
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
