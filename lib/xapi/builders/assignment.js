// lib/xapi/builders/assignment.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: gave, finished
// 과제 출제(교사) · 과제 제출(학생) 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions,
  computeAchievementLevel, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 과제 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildAssignment(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'gave').toLowerCase();
    if (!['gave', 'finished'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    const verb = VERB[verbKey];

    // 표준체계 컨텍스트 해소
    const resolved = resolveStandardContext(p);

    const actor = makeActor(ctx.userId, ctx.displayName);

    const object = makeActivity({
      type: 'homework',
      id: p.homework_id,
      name: p.title,
      description: p.description,
    });

    let result;
    let success;
    let achievement_level = null;

    if (verbKey === 'gave') {
      // 교사 — 과제 출제
      const targets = Array.isArray(p.target_user_ids) ? p.target_user_ids : [];
      result = {
        extensions: {
          'http://aidtbook.kr/xapi/extensions/target-user-count': targets.length,
          'http://aidtbook.kr/xapi/extensions/due-at': p.due_at || null,
          'http://aidtbook.kr/xapi/extensions/target-user-ids': targets,
        },
      };
      // 교사 출제 이벤트에는 success/achievement_level 기록하지 않음
    } else {
      // 학생 — 과제 제출(완료)
      const sub = p.submission || {};
      const status = String(sub.status || 'submitted');
      const raw = Number(sub.score) || 0;
      const max = Number(sub.max_score) || 0;
      const scaled = max > 0 ? Math.max(0, Math.min(1, raw / max)) : 0;
      success = (status === 'submitted');

      if (max > 0) {
        // 점수가 있을 때만 성취수준 산출 (정답률 = scaled)
        achievement_level = computeAchievementLevel({
          subject_code: p.subject_code,
          school_level: p.school_level,
          correct: raw,
          total: max,
        });
      }

      result = {
        score: { raw, max, scaled },
        completion: status === 'submitted',
        success,
        extensions: {
          'http://aidtbook.kr/xapi/extensions/submission-status': status,
          'http://aidtbook.kr/xapi/extensions/submitted-at': sub.submitted_at || null,
        },
      };
    }

    const stdExt = buildStandardExtensions(
      resolved,
      achievement_level ? { achievement_level } : {}
    );

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'assignment',
      verb: verbKey,
      object_type: 'homework',
      object_id: p.homework_id,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      success: verbKey === 'finished' ? (success ? 1 : 0) : undefined,
      achievement_level: verbKey === 'finished' ? achievement_level : undefined,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union || []),
    };

    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};
