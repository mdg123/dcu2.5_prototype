// lib/xapi/builders/survey.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: submitted (PDF 69~80쪽)
// 감정 출석부 · 이해도 조사 · 설문 · 만족도 이벤트.
//
// Phase 2 정합:
//   - activity-type slug 3분기 (PDF §1.3 survey 영역):
//       · comprehension-survey   → 이해도/일반 설문
//       · emotion-survey         → 감정 회고 (주간/월간)
//       · emotion-today-survey   → 일일 감정 출석부 (이모티콘 + 이유)
//   - object.definition.extensions:
//       · comprehensionSurveyInfo / emotionSurveyInfo / emotionTodaySurveyInfo
//       · items-info 메타: 리커트 척도(min~max)·문항 type 포함
//   - result.extensions:
//       · comprehensionSurveyDetail / emotionSurveyDetail / emotionTodaySurveyDetail
//       · item-detail: response-yn(bool), response(int) — 리커트 정수
//   - 감정 이모티콘 → 리커트 정수 변환: common.emotionToLikert()
//   - 감정 한마디 코멘트는 다채움 namespace 로 보존 (emotion-quick-attend)
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions,
  emotionToLikert,
  resolveStandardContext,
} = require('../common');

// payload.survey_kind 별 AIDT slug 매핑
function pickSurveySlug(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'emotion_attendance' || k === 'emotion-today' || k === 'emotion_today') return 'emotion-today-survey';
  if (k === 'emotion_review' || k === 'emotion-review' || k === 'emotion' || k === 'weekly_emotion' || k === 'monthly_emotion') return 'emotion-survey';
  // comprehension / feedback / satisfaction 등 일반 설문
  return 'comprehension-survey';
}

// slug → AIDT *-info / *-detail EXT URL
const INFO_KEY = {
  'comprehension-survey':   EXT.comprehensionSurveyInfo,
  'emotion-survey':         EXT.emotionSurveyInfo,
  'emotion-today-survey':   EXT.emotionTodaySurveyInfo,
};
const DETAIL_KEY = {
  'comprehension-survey':   EXT.comprehensionSurveyDetail,
  'emotion-survey':         EXT.emotionSurveyDetail,
  'emotion-today-survey':   EXT.emotionTodaySurveyDetail,
};

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - 설문 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildSurvey(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || 'submitted').toLowerCase();
    if (!['submitted', 'responded'].includes(verbKey)) {
      throw new Error(`Unsupported verb: ${p.verb}`);
    }
    // AIDT 표준: 모든 영역의 submitted 의미를 영역별 profile URL로 분리.
    // Survey 영역은 VERB.responded (URL: /profiles/survey/1.0/verbs/submitted) 사용.
    // VERB.submitted는 assessment profile URL이므로 여기서 쓰면 안 됨.
    const verb = VERB.responded;

    // 표준체계 컨텍스트 해소 (감정 출석부는 empty 허용 — warnings 만 남김)
    const resolved = resolveStandardContext(p);

    const slug = pickSurveySlug(p.survey_kind);
    const surveyId = p.survey_id || `survey-${ctx.userId}-${Date.now()}`;

    const responses = Array.isArray(p.responses) ? p.responses : null;
    // items-info: 리커트 척도 메타 (감정출석부의 경우 1~5)
    const itemsInfo = responses
      ? responses.map(r => ({
          id: String(r.question_id != null ? r.question_id : ''),
          type: r.question_type || (slug === 'comprehension-survey' ? 'likert' : 'emotion'),
          'min-value': r.min_value != null ? Number(r.min_value) : (slug === 'comprehension-survey' ? 1 : 1),
          'max-value': r.max_value != null ? Number(r.max_value) : 5,
        }))
      : [];

    // *-info object.definition.extensions (PDF 69쪽 comprehension-survey-info, 75쪽 emotion-today-survey-info)
    const infoBody = [{
      id: String(surveyId),
      title: p.title || null,
      timestamp: ctx.timestamp || new Date().toISOString(),
      'curriculum-standard-id': resolved.primary_std_id || null,
      'items-info': itemsInfo,
    }];

    const stdExt = buildStandardExtensions(resolved);
    const actor = makeActor(ctx.userId, ctx.displayName);

    const object = makeActivity({
      type: slug,
      id: surveyId,
      name: p.title,
      extraExtensions: {
        [INFO_KEY[slug]]: infoBody,
      },
    });

    // *-detail result.extensions
    let itemDetail;
    if (responses && responses.length) {
      itemDetail = responses.map(r => ({
        id: String(r.question_id != null ? r.question_id : ''),
        'response-yn': r.response_yn != null ? !!r.response_yn : (r.answer != null || r.score != null),
        response: r.score != null ? Number(r.score)
                : (typeof r.answer === 'number' ? Number(r.answer) : null),
      }));
    } else if (slug === 'emotion-today-survey' && p.emotion) {
      // 단일 감정 응답 — 이모티콘 → 리커트
      const primary = (typeof p.emotion === 'object' && p.emotion) ? p.emotion.primary : p.emotion;
      const score = (typeof p.emotion === 'object' && p.emotion) ? p.emotion.intensity : null;
      itemDetail = [{
        id: 'emotion',
        'response-yn': true,
        response: emotionToLikert(primary, score),
      }];
    } else {
      itemDetail = [];
    }

    const detailBody = [{
      id: String(surveyId),
      timestamp: ctx.timestamp || new Date().toISOString(),
      'item-detail': itemDetail,
    }];

    const result = {
      completion: verbKey === 'submitted',
      extensions: {
        [DETAIL_KEY[slug]]: detailBody,
      },
    };

    // 다채움 고유: 감정 한마디 + 이유 (PII 보존, AIDT 표준 외)
    if (slug === 'emotion-today-survey') {
      const emoji = (typeof p.emotion === 'object' && p.emotion) ? p.emotion.primary : (p.emotion || null);
      const reason = (typeof p.emotion === 'object' && p.emotion) ? p.emotion.reason : (p.emotion_reason || null);
      const comment = p.comment || null;
      if (emoji || reason || comment) {
        result.extensions['https://dacheum.kr/xapi/extension/emotion-quick-attend'] = {
          emoji_code: emoji,
          reason,
          comment,
        };
      }
    }

    // makeContext 가 partnerId 를 자동 주입하므로, 표준체계가 비어도 안전.
    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const statement = makeStatement({
      actor, verb, object, result, context,
      timestamp: ctx.timestamp || new Date().toISOString(),
    });

    const meta = {
      area: 'survey',
      verb: verbKey,
      object_type: slug,
      object_id: (typeof p.survey_id === 'number') ? p.survey_id : null,
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
