// lib/xapi/builders/assessment.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: submitted, scored, passed, failed
// 평가/문항 풀이 제출·채점 이벤트.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions,
  mapAssessmentType, mapQuestionType,
  computeAchievementLevel, resolveStandardContext,
} = require('../common');

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 평가 제출 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildAssessment(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'submitted').toLowerCase();
    if (!['submitted', 'scored', 'passed', 'failed'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    const verb = VERB[verbKey];

    // 표준체계 컨텍스트 해소
    const resolved = resolveStandardContext(p);

    // 문항 집계
    const items = Array.isArray(p.item_results) ? p.item_results : [];
    const totalCount = items.length;
    const correctCount = items.filter(i => !!i.correct).length;

    // 성취수준 산출 (정답률 기준)
    const achievement_level = computeAchievementLevel({
      subject_code: p.subject_code,
      school_level: p.school_level,
      correct: correctCount,
      total: totalCount,
    });

    // 통과 여부 (기본 60% 컷)
    const totalScore = Number(p.total_score) || 0;
    const maxScore = Number(p.max_score) || 0;
    let success = maxScore > 0 ? (totalScore >= maxScore * 0.6) : false;
    if (verbKey === 'passed') success = true;
    else if (verbKey === 'failed') success = false;

    const stdExt = buildStandardExtensions(resolved, { achievement_level });

    const actor = makeActor(ctx.userId, ctx.displayName);

    const assessmentTypeCode = mapAssessmentType(p.assessment_type);

    const object = makeActivity({
      type: p.target_kind || 'exam',
      id: p.assessment_id,
      name: p.title,
      extraExtensions: {
        [EXT.assessmentType]: assessmentTypeCode,
      },
    });

    // item-results 최소 표현 (PII 최소화)
    const minimalItems = items.map(i => ({
      question_id: i.question_id,
      question_type: mapQuestionType(i.question_type),
      correct: !!i.correct,
      score: i.score != null ? Number(i.score) : null,
      max_score: i.max_score != null ? Number(i.max_score) : null,
    }));

    const dur = Number(p.duration_seconds) || 0;
    const scaled = maxScore > 0 ? (totalScore / maxScore) : 0;

    const result = {
      score: {
        raw: totalScore,
        max: maxScore,
        scaled: Math.max(0, Math.min(1, scaled)),
      },
      success,
      completion: verbKey !== 'scored',
      duration: `PT${Math.max(0, Math.round(dur))}S`,
      extensions: {
        'http://aidtbook.kr/xapi/extensions/item-count': totalCount,
        'http://aidtbook.kr/xapi/extensions/correct-count': correctCount,
        [EXT.assessmentType]: assessmentTypeCode,
        'http://aidtbook.kr/xapi/extensions/item-results': minimalItems,
        [EXT.durationSec]: dur,
      },
    };

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'assessment',
      verb: verbKey,
      object_type: p.target_kind || 'exam',
      object_id: p.assessment_id,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      success: success ? 1 : 0,
      achievement_level,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union || []),
    };

    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};
