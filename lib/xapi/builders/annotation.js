// lib/xapi/builders/annotation.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: made (PDF 81~84쪽)
// 오답노트 주석 · 메모 · 하이라이트 · 교정.
//
// Phase 2 정합:
//   - activity-type slug → 'annotation' (이전 'content'/'annotation' 혼용 폐기)
//   - verb: annotated → 'made' (URL 동일)
//   - result.extensions: annotationDetail
//       · annotation-cnt: 콘텐츠 단위(또는 std-id 단위) 누적 주석 횟수.
//         payload.annotation_count 가 있으면 사용, 없으면 1.
//       · content-id, curriculum-standard-id
//   - 누적 카운트 정밀 집계는 Phase 3(별도 테이블) 위임.
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
    const verb = VERB.made;

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);

    const annotation_kind = p.annotation_kind || 'memo';
    const target_type = p.target_type || 'content';
    const annotationId = p.annotation_id || `ann-${ctx.userId}-${Date.now()}`;

    const object = makeActivity({
      type: 'annotation',
      id: annotationId,
      name: p.target_title ? `${p.target_title} 주석` : '주석',
      description: p.body,
    });

    // annotation-detail (PDF 81쪽)
    const annotationDetailBody = [{
      id: String(annotationId),
      'content-id': p.target_id != null ? String(p.target_id) : null,
      'curriculum-standard-id': resolved.primary_std_id || null,
      'annotation-cnt': Number(p.annotation_count) || 1,
      'annotation-kind': annotation_kind,
      timestamp: ctx.timestamp || new Date().toISOString(),
    }];

    const result = {
      response: p.body || p.response || null,
      extensions: {
        [EXT.annotationDetail]: annotationDetailBody,
        // 다채움 내부 메타 (대시보드용)
        'https://dacheum.kr/xapi/extension/annotation-kind': annotation_kind,
        'https://dacheum.kr/xapi/extension/target-type': target_type,
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
      verb: 'made',  // 표준 통일
      object_type: 'annotation',
      object_id: (typeof p.annotation_id === 'number') ? p.annotation_id : null,
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
