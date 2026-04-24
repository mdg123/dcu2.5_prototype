// lib/xapi/builders/teaching.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: gave, reorganized
// 교사 피드백 (gave) · 학급 재편성 (reorganized) · 중재 등.
// actor 는 교사, 학생 대상은 target 확장에 담아 전달.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp } (교사 ctx)
 * @param {object} payload - 교사 행위 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildTeaching(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'gave').toLowerCase();
    if (!['gave', 'reorganized'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    const verb = VERB[verbKey];

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);

    const kind = p.kind || (verbKey === 'gave' ? 'feedback' : 'group_reshuffle');
    const class_id = p.class_id != null ? p.class_id : ctx.classId;
    const target_user_ids = Array.isArray(p.target_user_ids) ? p.target_user_ids : [];

    let object, result, object_type, object_id;
    if (verbKey === 'gave') {
      object_type = 'teaching';
      object_id = `class-${class_id}-${Date.now()}`;
      object = makeActivity({
        type: 'teaching',
        id: object_id,
        name: `${kind} 피드백`,
      });
      result = {
        response: p.message,
        extensions: {
          'feedback-kind': kind,
          'target-user-count': target_user_ids.length,
          'target-user-ids': target_user_ids,
          'reason': p.reason || null,
        },
      };
    } else {
      // reorganized
      const groups = Array.isArray(p.groups) ? p.groups : [];
      object_type = 'class';
      object_id = class_id;
      object = makeActivity({
        type: 'class',
        id: class_id,
        name: `학급 ${class_id} 재편성`,
      });
      result = {
        extensions: {
          'group-count': groups.length,
          'groups': groups,
          'reason': p.reason || null,
        },
      };
    }

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: class_id,
      extraExtensions: stdExt,
    });

    const statement = makeStatement({
      actor, verb, object, result, context,
      timestamp: ctx.timestamp || new Date().toISOString(),
    });

    const meta = {
      area: 'teaching',
      verb: verbKey,
      object_type,
      object_id,
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
