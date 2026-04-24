// lib/xapi/builders/survey.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: submitted, responded
// 감정 출석부 · 이해도 조사 · 설문 · 만족도 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 설문 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildSurvey(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'submitted').toLowerCase();
    if (!['submitted', 'responded'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    const verb = VERB[verbKey];

    // 표준체계 컨텍스트 해소 (감정 출석부는 empty 허용 — warnings 만 남김)
    const resolved = resolveStandardContext(p);

    const survey_kind = p.survey_kind || 'feedback';
    const responses = Array.isArray(p.responses) ? p.responses : null;

    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);

    const object = makeActivity({
      type: 'survey',
      id: p.survey_id,
      name: p.title,
      extraExtensions: { 'survey-kind': survey_kind },
    });

    const result = {
      completion: verbKey === 'submitted',
      extensions: {
        'survey-kind': survey_kind,
        'response-count': responses ? responses.length : 0,
        'emotion': p.emotion || null,
        'responses': responses
          ? responses.map(r => ({ q: r.question_id, a: r.answer, s: r.score }))
          : null,
      },
    };

    // makeContext 가 partnerId 를 자동 주입하므로, 표준체계가 비어도 안전.
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
      area: 'survey',
      verb: verbKey,
      object_type: 'survey',
      object_id: p.survey_id,
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
