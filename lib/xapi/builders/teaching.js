// lib/xapi/builders/teaching.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — 교사 행위
//   - gave        → feedback-t/1.0/verbs/gave   (피드백)
//   - reorganized → teaching-t/1.0/verbs/reorganized (수업 재구성)
//   (과제 출제 assignment-t/assigned 는 assignment.js 에서 분리 처리)
//
// v1.0 정합:
//   - activity-type slug 2분기: feedback / class
//   - object.definition.extensions: feedback-info/class-info(플랫) + curriculum-standard-id(표준 위치)
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension, resolveStandardContext,
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
    // v1.0: gave → feedback-t/gave, reorganized → teaching-t/reorganized
    const verb = verbKey === 'gave' ? VERB.feedbackGave : VERB.reorganized;

    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId);

    const kind = p.kind || (verbKey === 'gave' ? 'feedback' : 'group_reshuffle');
    const class_id = p.class_id != null ? p.class_id : ctx.classId;
    const target_user_ids = Array.isArray(p.target_user_ids) ? p.target_user_ids : [];

    // slug 분기
    const slug = verbKey === 'gave' ? 'feedback' : 'class';
    const objectId = verbKey === 'gave'
      ? (p.feedback_id || `fb-${class_id}-${Date.now()}`)
      : (class_id || `class-${ctx.userId}-${Date.now()}`);

    // *-info(플랫) object.definition.extensions
    const extraExtensions = { ...stdIdExtension(resolved) };
    if (slug === 'feedback') {
      // feedback-info(플랫)
      extraExtensions[EXT.feedbackInfo] = [{
        id: String(objectId),
        'content-id': p.content_id != null ? String(p.content_id) : (p.target_id != null ? String(p.target_id) : null),
        'feedback-kind': kind,
        'target-cnt': target_user_ids.length,
      }];
    } else {
      // class-info(플랫)
      extraExtensions[EXT.classInfo] = [{
        id: String(objectId),
        'class-id': class_id != null ? String(class_id) : null,
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
      userId: ctx.userId,
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
