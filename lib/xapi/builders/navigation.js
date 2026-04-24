// lib/xapi/builders/navigation.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: viewed | read | did | learned
// 콘텐츠 열람 / 수업 이동 / 완료 등 탐색·학습 진입 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions,
  resolveStandardContext,
} = require('../common');

const ALLOWED_VERBS = new Set(['viewed', 'read', 'did', 'learned']);

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - navigation 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildNavigation(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || '').toLowerCase();
    if (!ALLOWED_VERBS.has(verbKey)) {
      throw new Error(`invalid navigation verb: ${p.verb}`);
    }
    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const verb = VERB[verbKey];

    const targetType = p.target_type || 'content';
    const object = makeActivity({
      type: targetType,
      id: p.target_id,
      name: p.target_title,
      extraExtensions: p.referrer_url
        ? { 'http://aidtbook.kr/xapi/extensions/referrer-url': p.referrer_url }
        : {},
    });

    // result: 'learned' + completed 인 경우에만 completion 기록
    let result;
    if (verbKey === 'learned' && p.completed === true) {
      result = { completion: true };
    }

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'navigation',
      verb: verbKey,
      object_type: targetType,
      object_id: p.target_id,
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
// node -e "console.log(JSON.stringify(require('./lib/xapi/builders/navigation')({userId:3,displayName:'김학생',sessionId:'sess-abc',classId:101},{verb:'read',target_type:'content',target_id:42,target_title:'소리의 특성',achievement_codes:'[4국01-01]'}), null, 2))"
