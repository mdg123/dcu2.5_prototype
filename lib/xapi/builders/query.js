// lib/xapi/builders/query.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: searched | asked (PDF 59~64쪽)
// 검색 / AI 튜터 질문 이벤트.
//
// Phase 2 정합:
//   - activity-type slug 2분기:
//       · keyword  (searched 검색)
//       · question (asked 질문)
//   - object.definition.extensions:
//       · keywordInfo  (id, search-word, content-type, curriculum-standard-id)
//   - result.extensions:
//       · searched → searchDetail (id, duration int 초, result-count, satisfaction 0~1)
//       · asked    → askDetail (id, answer, duration, satisfaction)
//   - legacy 'query-filters', 'result-count' 하드코드 → keywordInfo/searchDetail 로 흡수
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension, mapContentType,
  resolveStandardContext,
} = require('../common');

const ALLOWED_VERBS = new Set(['searched', 'asked', 'closed']);

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
      curriculum_standard_ids: filters.curriculum_standard_ids || p.curriculum_standard_ids,
      achievement_codes: filters.achievement_codes || p.achievement_codes,
      subject_code: filters.subject_code || p.subject_code,
      grade_group: filters.grade_group || p.grade_group,
    });
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId);
    // v1.0: searched/asked/closed → query/1.0/verbs/{verb}
    const verb = verbKey === 'searched' ? VERB.searched
               : verbKey === 'closed'   ? VERB.closed
               : VERB.asked;

    // 2분기 slug: searched→keyword, asked/closed→question
    const slug = verbKey === 'searched' ? 'keyword' : 'question';
    const queryId = p.query_id || hashQueryId(p.query_text);

    // object.definition.extensions
    const extraExtensions = { ...stdIdExtension(resolved) };
    if (slug === 'keyword') {
      // keyword-info(플랫)
      extraExtensions[EXT.keywordInfo] = [{
        id: String(queryId),
        'search-word': p.query_text || '',
        'content-type': filters.content_type ? mapContentType(filters.content_type) : null,
      }];
    }
    // 다채움 내부: 전체 필터 보존 (대시보드용)
    if (filters && Object.keys(filters).length) {
      extraExtensions['https://dacheum.kr/xapi/extension/query-filters'] = filters;
    }

    const object = makeActivity({
      type: slug,
      id: queryId,
      name: p.query_text,
      extraExtensions,
    });

    // result.extensions
    const duration = Math.max(0, Math.round(Number(p.duration_seconds) || 0));
    const resultCount = p.result_count != null ? Number(p.result_count) : null;
    const satisfaction = p.satisfaction != null ? Math.max(0, Math.min(1, Number(p.satisfaction))) : null;

    const resultExt = {};
    if (verbKey === 'searched') {
      // search-detail(플랫)
      resultExt[EXT.searchDetail] = [{
        id: String(queryId),
        duration,
        'result-cnt': resultCount,
        satisfaction,
      }];
    } else {
      // ask-detail(플랫) — asked/closed 공용
      resultExt[EXT.askDetail] = [{
        id: String(queryId),
        answer: p.answer || null,
        duration,
        satisfaction,
        'asked-to': p.asked_to || null,
        closed: verbKey === 'closed',
      }];
    }

    const result = {
      response: String(p.query_text || ''),
      extensions: resultExt,
    };

    const context = makeContext({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'query',
      verb: verbKey,
      object_type: slug,
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
