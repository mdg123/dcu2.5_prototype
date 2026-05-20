// lib/xapi/builders/teaching.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: gave (피드백), reorganized (수업 재구성) (PDF 85~90쪽)
// actor 는 교사, 학생 대상은 target 확장에 담아 전달.
//
// Phase 2 정합:
//   - activity-type slug 2분기:
//       · feedback → 평가·과제·작품에 대한 교사 피드백 (gave)
//       · class    → 학급 수업 재구성·재편성·모둠 변경 (reorganized)
//   - object.definition.extensions:
//       · feedback → feedbackInfo (content-id, curriculum-standard-id, target-cnt)
//       · class    → classInfo (curriculum-standard-id, class-id)
//   - verb URL: teaching 의 gave 는 teaching profile (VERB.teachingGave)
//                reorganized 는 VERB.reorganized
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
    // teaching의 gave URL은 assignment의 gave와 다름 — VERB.teachingGave 사용
    const verb = verbKey === 'gave' ? VERB.teachingGave : VERB.reorganized;

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);

    const kind = p.kind || (verbKey === 'gave' ? 'feedback' : 'group_reshuffle');
    const class_id = p.class_id != null ? p.class_id : ctx.classId;
    const target_user_ids = Array.isArray(p.target_user_ids) ? p.target_user_ids : [];

    // slug 분기
    const slug = verbKey === 'gave' ? 'feedback' : 'class';
    const objectId = verbKey === 'gave'
      ? (p.feedback_id || `fb-${class_id}-${Date.now()}`)
      : (class_id || `class-${ctx.userId}-${Date.now()}`);

    // *-info object.definition.extensions
    const extraExtensions = {};
    if (slug === 'feedback') {
      // feedback-info (PDF 85쪽)
      extraExtensions[EXT.feedbackInfo] = [{
        id: String(objectId),
        'content-id': p.content_id != null ? String(p.content_id) : (p.target_id != null ? String(p.target_id) : null),
        'curriculum-standard-id': resolved.primary_std_id || null,
        'feedback-kind': kind,
        'target-cnt': target_user_ids.length,
      }];
    } else {
      // class-info (PDF 88쪽)
      extraExtensions[EXT.classInfo] = [{
        id: String(objectId),
        'class-id': class_id != null ? String(class_id) : null,
        'curriculum-standard-id': resolved.primary_std_id || null,
        title: p.title || `학급 ${class_id}`,
      }];
    }

    const object = makeActivity({
      type: slug,
      id: objectId,
      name: verbKey === 'gave' ? `${kind} 피드백` : `학급 ${class_id} 재편성`,
      extraExtensions,
    });

    let result;
    if (verbKey === 'gave') {
      result = {
        response: p.message || p.body || null,
        extensions: {
          'https://dacheum.kr/xapi/extension/feedback-kind': kind,
          'https://dacheum.kr/xapi/extension/target-user-count': target_user_ids.length,
          'https://dacheum.kr/xapi/extension/target-user-ids': target_user_ids,
        },
      };
      if (p.reason) {
        result.extensions['https://dacheum.kr/xapi/extension/reason'] = p.reason;
      }
      // 갤러리 승인 워크플로우 등 다채움 고유
      if (p.approval_status) {
        result.extensions['https://dacheum.kr/xapi/extension/approval-status'] = p.approval_status;
      }
    } else {
      // reorganized
      const groups = Array.isArray(p.groups) ? p.groups : [];
      result = {
        extensions: {
          'https://dacheum.kr/xapi/extension/group-count': groups.length,
          'https://dacheum.kr/xapi/extension/groups': groups,
        },
      };
      if (p.reason) {
        result.extensions['https://dacheum.kr/xapi/extension/reason'] = p.reason;
      }
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
      object_type: slug,
      object_id: (typeof objectId === 'number') ? objectId : null,
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
