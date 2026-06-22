// lib/xapi/builders/assignment.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — 과제 출제/제출
//   - 'gave'(교사 출제)    → assignment-t `assigned` IRI
//   - 'finished'(학생 제출) → assignment `finished` IRI
//
// v1.0 정합:
//   - activity-type slug → 'assignment'
//   - object.definition.extensions: assignment-info(플랫) + curriculum-standard-id(표준 위치)
//   - result.extensions: gav-assignment(출제) / fin-assignment(제출) (플랫)
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension,
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
    // v1.0: gave(교사 출제) → assignment-t assigned, finished(학생 제출) → assignment finished
    const verb = verbKey === 'gave' ? VERB.assigned : VERB.finished;

    // 표준체계 컨텍스트 해소
    const resolved = resolveStandardContext(p);

    const actor = makeActor(ctx.userId);

    // assignment-info(플랫) — object.definition.extensions
    const assignmentInfoBody = [{
      id: String(p.assignment_id != null ? p.assignment_id : (p.homework_id != null ? p.homework_id : '')),
      title: p.title || null,
      'due-at': p.due_at || null,
    }];

    const object = makeActivity({
      type: 'assignment',
      id: p.assignment_id != null ? p.assignment_id : p.homework_id,
      name: p.title,
      description: p.description,
      extraExtensions: {
        [EXT.assignmentInfo]: assignmentInfoBody,
        ...stdIdExtension(resolved),
      },
    });

    let result;
    let success;
    let achievement_level = null;

    if (verbKey === 'gave') {
      // 교사 — 과제 출제 (gav-assignment) PDF 43쪽
      const targets = Array.isArray(p.target_user_ids) ? p.target_user_ids : [];
      const gavBody = [{
        id: String(p.assignment_id != null ? p.assignment_id : (p.homework_id != null ? p.homework_id : '')),
        'target-cnt': targets.length,
        'due-at': p.due_at || null,
        'gave-at': p.gave_at || new Date().toISOString(),
      }];
      result = {
        extensions: {
          [EXT.gavAssignment]: gavBody,
          // 다채움 내부: 실제 대상 user id 목록 (대시보드용)
          [`https://dacheum.kr/xapi/extension/target-user-ids`]: targets,
        },
      };
      // 교사 출제 이벤트에는 success/achievement_level 기록하지 않음
    } else {
      // 학생 — 과제 제출(완료) (fin-assignment) PDF 44쪽
      const sub = p.submission || {};
      const status = String(sub.status || 'submitted');
      const raw = Number(sub.score) || 0;
      const max = Number(sub.max_score) || 0;
      const scaled = max > 0 ? Math.max(0, Math.min(1, raw / max)) : 0;
      const score100 = Math.round(scaled * 100);
      // success 우선순위: payload.success > 점수 기반 추론 > status 기반
      if (typeof p.success === 'boolean') {
        success = p.success;
      } else if (max > 0) {
        success = scaled >= 0.6;
      } else {
        success = (status === 'submitted');
      }

      if (max > 0) {
        achievement_level = computeAchievementLevel({
          subject_code: p.subject_code,
          school_level: p.school_level,
          correct: raw,
          total: max,
        });
      }

      const finBody = [{
        id: String(p.assignment_id != null ? p.assignment_id : (p.homework_id != null ? p.homework_id : '')),
        score: max > 0 ? score100 : null,
        completion: status === 'submitted' || status === 'graded',
        'submitted-at': sub.submitted_at || (status === 'submitted' ? new Date().toISOString() : null),
        'retry-cnt': Number(sub.retry_count) || 0,
        graded: !!sub.graded,
      }];

      result = {
        completion: status === 'submitted' || status === 'graded',
        success,
        extensions: {
          [EXT.finAssignment]: finBody,
        },
      };
      if (max > 0) {
        result.score = { raw, max, scaled };
      }
    }

    const stdExt = buildStandardExtensions(
      resolved,
      achievement_level ? { achievement_level } : {}
    );

    const context = makeContext({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'assignment',
      verb: verbKey,
      object_type: 'assignment',
      object_id: p.assignment_id != null ? p.assignment_id : p.homework_id,
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
