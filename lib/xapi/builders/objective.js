// lib/xapi/builders/objective.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: set (PDF 56~58쪽)
// AI 맞춤학습의 '이 표준체계 학습을 목표로 설정' / '재방문' / '달성' 이벤트.
//
// Phase 2 정합:
//   - activity-type slug → 'objective' (이전 'content'/'objective' 혼용 폐기)
//   - verb 통일: planned/achieved → 'set' 단일 (AIDT URL은 같은 것을 가리킴)
//   - result.extensions: objectiveDetail
//       · type S/D/E (선택형/서답형/기타) — mapObjectiveType
//       · content (목표 내용)
//       · timestamp
//       · revision-cnt (수정 횟수, payload.revision_count)
//       · visit-cnt (재방문 횟수, payload.visit_count)
//       · completion (% int)
//   - revision-cnt/visit-cnt 누적 — Phase 2 에서는 호출처가 카운트를 전달.
//     별도 테이블 정합은 Phase 3 위임.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension,
  mapObjectiveType,
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
    const verbKey = String(p.verb || 'set').toLowerCase();
    if (!['set', 'planned', 'achieved'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    // 모두 set 으로 통일 (URL 동일)
    const verb = VERB.set;

    // 목표로 삼은 표준체계를 resolveStandardContext 입력으로 매핑
    const resolvedInput = {
      curriculum_standard_ids: p.target_curriculum_standard_ids || p.curriculum_standard_ids,
      achievement_codes: p.target_achievement_codes || p.achievement_codes,
      subject_code: p.subject_code,
      grade_group: p.grade_group,
    };
    const resolved = resolveStandardContext(resolvedInput);

    let achievement_level = null;
    let success;
    let completion;
    let completionPct = 0;

    if (verbKey === 'achieved' || p.achieved === true) {
      const prog = p.progress || {};
      const completed = Number(prog.completed_count) || 0;
      const total = Number(prog.total_count) || 0;
      if (total > 0) {
        achievement_level = computeAchievementLevel({
          subject_code: p.subject_code,
          school_level: p.school_level,
          correct: completed,
          total,
        });
        completionPct = Math.round((completed / total) * 100);
      } else if (p.completion_percent != null) {
        completionPct = Math.max(0, Math.min(100, Number(p.completion_percent)));
      } else {
        completionPct = 100;
      }
      success = true;
      completion = true;
    } else {
      // planned / set (목표 설정)
      completionPct = Number(p.completion_percent) || 0;
    }

    // AIDT result.extensions — objective-detail (PDF 56~58쪽)
    const objectiveDetailBody = [{
      id: String(p.objective_id != null ? p.objective_id : (resolved.primary_std_id || '')),
      type: mapObjectiveType(p.objective_type),    // S/D/E
      content: p.content || p.title || null,
      timestamp: ctx.timestamp || new Date().toISOString(),
      'revision-cnt': Number(p.revision_count) || 0,
      'visit-cnt': Number(p.visit_count) || 0,
      completion: completionPct,
      'curriculum-standard-id': resolved.primary_std_id || null,
    }];

    const stdExt = buildStandardExtensions(
      resolved,
      achievement_level ? { achievement_level } : {}
    );

    const actor = makeActor(ctx.userId);

    const object = makeActivity({
      type: 'objective',
      id: p.objective_id || resolved.primary_std_id || `obj-${ctx.userId}-${Date.now()}`,
      name: p.title || p.content,
      extraExtensions: {
        ...stdIdExtension(resolved),
      },
    });

    const resultExt = {
      [EXT.objectiveDetail]: objectiveDetailBody,
    };
    // 다채움 고유: 추천 출처
    if (p.recommended_by) {
      resultExt['https://dacheum.kr/xapi/extension/recommended-by'] = p.recommended_by;
    }
    if (p.reason) {
      resultExt['https://dacheum.kr/xapi/extension/reason'] = p.reason;
    }

    const result = {
      completion: !!completion,
      extensions: resultExt,
    };
    if (success !== undefined) result.success = success;

    const context = makeContext({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'objective',
      verb: 'set',  // 표준 단일
      object_type: 'objective',
      object_id: p.objective_id,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      success: success ? 1 : undefined,
      achievement_level,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union || []),
    };

    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};
