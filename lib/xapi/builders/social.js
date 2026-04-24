// lib/xapi/builders/social.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: shared, commented, liked
// 학급 게시판 · 자유게시판 · 숙제피드백 등 소셜 활동.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 소셜 활동 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildSocial(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'shared').toLowerCase();
    if (!['shared', 'commented', 'liked'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    const verb = VERB[verbKey];

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const board_kind = p.board_kind || 'class_board';

    const object = makeActivity({
      type: 'post',
      id: p.post_id,
      name: p.post_title,
      extraExtensions: { 'board-kind': board_kind },
    });

    let result;
    if (verbKey === 'shared') {
      result = {
        response: p.body,
        extensions: { 'board-kind': board_kind },
      };
    } else if (verbKey === 'commented') {
      result = {
        response: p.body,
        extensions: {
          'board-kind': board_kind,
          'parent-comment-id': p.parent_comment_id || null,
        },
      };
    } else {
      // liked
      result = {
        extensions: { 'board-kind': board_kind },
      };
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
      verb: verbKey,
      object_type: 'post',
      object_id: p.post_id,
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
