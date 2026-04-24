// lib/xapi/builders/media.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: played
// 영상·음성·이미지 등 미디어 재생/열람 완료 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, mapContentType,
  resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - media 재생 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildMediaPlayed(ctx, payload) {
  try {
    const p = payload || {};
    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const verb = VERB.played;

    const object = makeActivity({
      type: 'content',
      id: p.content_id,
      name: p.title,
      extraExtensions: {
        [EXT.contentType]: mapContentType(p.content_type),
        ...(p.source_url ? { [EXT.sourceUrl]: p.source_url } : {}),
      },
    });

    const dur = Number(p.duration_seconds) || 0;
    const totalDur = Number(p.total_duration_seconds) || 0;

    const result = {
      duration: `PT${Math.max(0, Math.round(dur))}S`,
      completion: !!p.completed,
      extensions: {
        [EXT.durationSec]: dur,
        'http://aidtbook.kr/xapi/extensions/total-duration-seconds': totalDur,
      },
    };

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'media',
      verb: 'played',
      object_type: 'content',
      object_id: p.content_id,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      success: undefined,
      achievement_level: undefined,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union || []),
    };

    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};

// Selftest (manual):
// node -e "console.log(JSON.stringify(require('./lib/xapi/builders/media')({userId:3,displayName:'김학생',sessionId:'sess-abc',classId:101},{content_id:42,title:'소리의 특성',content_type:'video',duration_seconds:120,total_duration_seconds:180,completed:false,curriculum_standard_ids:'E4KORA01B01C01'}), null, 2))"
