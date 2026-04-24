// lib/xapi/builders/annotation.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: annotated
// 오답노트 주석 · 메모 · 하이라이트 · 교정.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 주석 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildAnnotation(ctx, payload) {
  try {
    const p = payload || {};
    const verb = VERB.annotated;

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);

    const annotation_kind = p.annotation_kind || 'memo';
    const target_type = p.target_type || 'content';

    const object = makeActivity({
      type: 'annotation',
      id: p.annotation_id,
      name: p.target_title ? `${p.target_title} 주석` : '주석',
      description: p.body,
    });

    const result = {
      response: p.body,
      extensions: {
        'annotation-kind': annotation_kind,
        'target-type': target_type,
        'target-id': p.target_id,
      },
    };

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
      area: 'annotation',
      verb: 'annotated',
      object_type: 'annotation',
      object_id: p.annotation_id,
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
