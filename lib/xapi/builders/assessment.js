// lib/xapi/builders/assessment.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — verb: submitted (assessment)
// 평가/문항 풀이 제출·채점 이벤트.
//
// v1.0 정합:
//   - activity-type slug → 'assessment'
//   - verb 입력 submitted/scored/passed/failed → 전부 assessment submitted IRI
//     (문항 단위 answered statement 는 후속 — VERB.answered IRI 는 common 에 준비됨)
//   - object.definition.extensions: assessment-info(플랫) + curriculum-standard-id(표준 위치)
//   - result.score.scaled: -1~1 (없으면 -1) + duration + assessment-detail(플랫)
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension,
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
    // v1.0: 입력 submitted/scored/passed/failed → 모두 assessment submitted IRI
    const verb = VERB.submitted;

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

    const actor = makeActor(ctx.userId);

    const assessmentTypeCode = mapAssessmentType(p.assessment_type);
    // v1.0 score.scaled: -1~1, 없으면 -1
    const scaled = maxScore > 0 ? Math.max(-1, Math.min(1, totalScore / maxScore)) : -1;
    const score100 = maxScore > 0 ? Math.round(Math.max(0, scaled) * 100) : 0;

    // v1.0 assessment-info(플랫) — object.definition.extensions
    const assessmentInfoBody = [{
      id: String(p.assessment_id != null ? p.assessment_id : ''),
      type: assessmentTypeCode,  // D/F/S/E
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
        ...stdIdExtension(resolved),
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
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'assessment',
      verb: 'submitted',
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
