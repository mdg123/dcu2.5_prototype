// lib/xapi/builders/assessment.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: submitted (PDF 35~41쪽)
// 평가/문항 풀이 제출·채점 이벤트.
//
// Phase 2 정합:
//   - activity-type slug → 'assessment' (이전 'exam'/'content' 폐기)
//   - verb 통일: scored/passed/failed 도 모두 submitted (URL 동일), 의미는 result 에 담음
//   - object.definition.extensions: assessmentInfo (assessment-type D/F/S/E, items-info)
//   - result.extensions: assessmentDetail (score 0~100 int, item-detail)
//   - result.score.scaled 는 xAPI 표준대로 유지 (0~1 float)
//   - legacy 'item-count'/'correct-count'/'item-results' 키 → assessmentDetail 로 흡수
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

    // 점수 정규화 (score:{raw,max} payload 지원)
    let totalScore, maxScore;
    if (p.score && typeof p.score === 'object') {
      totalScore = Number(p.score.raw) || 0;
      maxScore = Number(p.score.max) || 0;
    } else {
      totalScore = Number(p.total_score) || 0;
      maxScore = Number(p.max_score) || 0;
    }
    // item_results 만 있고 max_score 미지정이면 item 수로 대체
    if (maxScore <= 0 && totalCount > 0) {
      maxScore = totalCount;
      if (totalScore <= 0) totalScore = correctCount;
    }

    // 성취수준 산출 (정답률 기준)
    const achievement_level = computeAchievementLevel({
      subject_code: p.subject_code,
      school_level: p.school_level,
      correct: totalCount > 0 ? correctCount : totalScore,
      total: totalCount > 0 ? totalCount : maxScore,
    });

    // 통과 여부 (기본 60% 컷)
    let success;
    if (typeof p.success === 'boolean') {
      success = p.success;
    } else {
      success = maxScore > 0 ? (totalScore >= maxScore * 0.6) : false;
    }
    if (verbKey === 'passed') success = true;
    else if (verbKey === 'failed') success = false;

    const stdExt = buildStandardExtensions(resolved, { achievement_level });

    const actor = makeActor(ctx.userId, ctx.displayName);

    const assessmentTypeCode = mapAssessmentType(p.assessment_type);
    const scaled = maxScore > 0 ? Math.max(0, Math.min(1, totalScore / maxScore)) : 0;
    const score100 = Math.round(scaled * 100);  // AIDT 표준: 0~100 정수

    // AIDT object.definition.extensions — assessment-info (PDF 35쪽)
    const assessmentInfoBody = [{
      id: String(p.assessment_id != null ? p.assessment_id : ''),
      type: assessmentTypeCode,  // D/F/S/E
      'curriculum-standard-id': resolved.primary_std_id || null,
      title: p.title || null,
      'items-info': items.length ? items.map(i => ({
        id: String(i.question_id != null ? i.question_id : ''),
        type: mapQuestionType(i.question_type),
        'max-score': i.max_score != null ? Number(i.max_score) : null,
      })) : undefined,
    }];

    const object = makeActivity({
      type: 'assessment',
      id: p.assessment_id,
      name: p.title,
      extraExtensions: {
        [EXT.assessmentInfo]: assessmentInfoBody,
        // 다채움 내부 메타 (대시보드용)
        [EXT.assessmentType]: assessmentTypeCode,
      },
    });

    // AIDT result.extensions — assessment-detail (PDF 38쪽)
    const itemDetail = items.length ? items.map(i => ({
      id: String(i.question_id != null ? i.question_id : ''),
      score: i.score != null ? Number(i.score) : null,
      correct: !!i.correct,
      duration: i.duration_seconds != null ? Number(i.duration_seconds) : null,
    })) : undefined;

    const assessmentDetailBody = [{
      id: String(p.assessment_id != null ? p.assessment_id : ''),
      score: score100,                                  // 0~100 정수
      'item-cnt': totalCount,
      'correct-cnt': correctCount,
      duration: Math.max(0, Math.round(Number(p.duration_seconds) || 0)),
      'item-detail': itemDetail,
    }];

    const result = {
      score: {
        raw: totalScore,
        max: maxScore,
        scaled,
      },
      success,
      completion: verbKey !== 'scored',
      duration: `PT${Math.max(0, Math.round(Number(p.duration_seconds) || 0))}S`,
      extensions: {
        [EXT.assessmentDetail]: assessmentDetailBody,
        [EXT.assessmentType]: assessmentTypeCode,
        [EXT.durationSec]: Number(p.duration_seconds) || 0,
      },
    };

    // CBT 이탈 감지 등 다채움 고유 데이터 보존 (다채움 namespace)
    if (p.cbt_tab_switch_count != null || p.cbt_total_leave_time != null) {
      result.extensions['https://dacheum.kr/xapi/extension/cbt-tab-switch'] = {
        'tab-switch-count': Number(p.cbt_tab_switch_count) || 0,
        'total-leave-time-sec': Number(p.cbt_total_leave_time) || 0,
      };
    }

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
      object_type: 'assessment',
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
