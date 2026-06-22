// lib/xapi/builders/annotation.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — annotation `annotated`
// 오답노트 주석 · 메모 · 하이라이트 · 교정.
//
// v1.0 정합:
//   - activity-type slug → 'annotation'
//   - verb 입력 made/annotated → annotation/1.0/verbs/annotated IRI
//   - object.definition.extensions: curriculum-standard-id(표준 위치)
//   - result.extensions: annotation-detail(플랫)
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension, resolveStandardContext,
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

    const actor = makeActor(ctx.userId);

    const annotation_kind = p.annotation_kind || 'memo';
    const target_type = p.target_type || 'content';
    const annotationId = p.annotation_id || `ann-${ctx.userId}-${Date.now()}`;

    const object = makeActivity({
      type: 'annotation',
      id: annotationId,
      name: p.target_title ? `${p.target_title} 주석` : '주석',
      description: p.body,
      extraExtensions: {
        ...stdIdExtension(resolved),
      },
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
      userId: ctx.userId,
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
      verb: 'annotated',  // v1.0 표준
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
