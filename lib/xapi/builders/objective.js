// lib/xapi/builders/objective.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: planned, achieved
// AI 맞춤학습의 '이 표준체계 학습을 목표로 설정' / '완료' 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions,
  computeAchievementLevel, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 목표 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildObjective(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'planned').toLowerCase();
    if (!['planned', 'achieved'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    const verb = VERB[verbKey];

    // 목표로 삼은 표준체계를 resolveStandardContext 입력으로 매핑
    const resolvedInput = {
      curriculum_standard_ids: p.target_curriculum_standard_ids,
      achievement_codes: p.target_achievement_codes,
      subject_code: p.subject_code,
      grade_group: p.grade_group,
    };
    const resolved = resolveStandardContext(resolvedInput);

    let achievement_level = null;
    let result;
    let success;

    if (verbKey === 'planned') {
      result = {
        extensions: {
          'http://aidtbook.kr/xapi/extensions/recommended-by': p.recommended_by || 'self',
          'http://aidtbook.kr/xapi/extensions/reason': p.reason || null,
        },
      };
    } else {
      // achieved
      const prog = p.progress || {};
      const completed = Number(prog.completed_count) || 0;
      const total = Number(prog.total_count) || 0;
      // 진행률 기반 성취수준 (total>0 일 때만)
      if (total > 0) {
        achievement_level = computeAchievementLevel({
          subject_code: p.subject_code,
          school_level: p.school_level,
          correct: completed,
          total,
        });
      }
      success = true;
      result = {
        completion: true,
        success: true,
        extensions: {
          'http://aidtbook.kr/xapi/extensions/progress': {
            completed_count: completed,
            total_count: total,
          },
        },
      };
    }

    const stdExt = buildStandardExtensions(
      resolved,
      achievement_level ? { achievement_level } : {}
    );

    const actor = makeActor(ctx.userId, ctx.displayName);

    const object = makeActivity({
      type: 'objective',
      id: p.objective_id,
      name: p.title,
    });

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'objective',
      verb: verbKey,
      object_type: 'objective',
      object_id: p.objective_id,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      success: verbKey === 'achieved' ? 1 : undefined,
      achievement_level,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union || []),
    };

    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};
