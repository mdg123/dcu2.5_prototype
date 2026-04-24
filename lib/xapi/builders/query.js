// lib/xapi/builders/query.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: searched | asked
// 검색 / AI 튜터 질문 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions,
  resolveStandardContext,
} = require('../common');

const ALLOWED_VERBS = new Set(['searched', 'asked']);

/** query_text → 16자 base64 short id (안정적 식별자) */
function hashQueryId(text) {
  const t = String(text || '');
  if (!t) return 'empty';
  return Buffer.from(t, 'utf8').toString('base64').replace(/[^A-Za-z0-9]/g, '').substring(0, 16) || 'empty';
}

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - query 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildQuery(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || '').toLowerCase();
    if (!ALLOWED_VERBS.has(verbKey)) {
      throw new Error(`invalid query verb: ${p.verb}`);
    }
    const filters = p.filters || {};
    // resolver 는 query 자체보다 filters 쪽 표준체계 정보를 본다
    const resolved = resolveStandardContext({
      curriculum_standard_ids: filters.curriculum_standard_ids,
      achievement_codes: filters.achievement_codes,
      subject_code: filters.subject_code,
      grade_group: filters.grade_group,
    });
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const verb = VERB[verbKey];

    const queryId = p.query_id || hashQueryId(p.query_text);
    const object = makeActivity({
      type: 'query',
      id: queryId,
      name: p.query_text,
      extraExtensions: {
        'http://aidtbook.kr/xapi/extensions/query-filters': filters,
      },
    });

    const resultExt = {
      'http://aidtbook.kr/xapi/extensions/result-count':
        p.result_count != null ? Number(p.result_count) : null,
    };
    if (verbKey === 'asked') {
      resultExt['http://aidtbook.kr/xapi/extensions/asked-to'] = p.asked_to || null;
    }
    const result = {
      response: String(p.query_text || ''),
      extensions: resultExt,
    };

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'query',
      verb: verbKey,
      object_type: 'query',
      object_id: queryId,
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
// node -e "console.log(JSON.stringify(require('./lib/xapi/builders/query')({userId:3,displayName:'김학생',sessionId:'sess-abc',classId:101},{verb:'searched',query_text:'중요한 내용 파악하며 듣기',filters:{subject_code:'korean-e',grade_group:4},result_count:7}), null, 2))"
