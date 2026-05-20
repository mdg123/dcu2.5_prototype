// lib/xapi/builders/navigation.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verbs: viewed | read | did | learned (PDF 46~55쪽)
// 콘텐츠 열람 / 수업 이동 / 완료 등 탐색·학습 진입 이벤트.
//
// Phase 2 정합:
//   - activity-type slug 4분기 (PDF §1.3 navigation 영역):
//       · image       → 이미지 콘텐츠
//       · document    → 문서/텍스트/lesson 콘텐츠
//       · practice    → 실습·문항 콘텐츠 (오답 아닌 학습용)
//       · etc-content → 기타 (영상/음성을 navigation 으로 보내거나 1클릭 출석 등)
//   - object.definition.extensions: imageInfo / documentInfo / practiceInfo / etcContentInfo
//     (PDF 가이드에 따르면 image-info 는 detail 없음. 나머지는 *-info 만 필수)
//   - payload.content_type 또는 payload.nav_slug 로 분기. 호출처가 명시 안 하면 자동 매핑.
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, mapNavigationSlug,
  resolveStandardContext,
} = require('../common');

const ALLOWED_VERBS = new Set(['viewed', 'read', 'did', 'learned']);

// slug → AIDT 표준 *-info extension URL 매핑
const INFO_KEY_BY_SLUG = {
  'image':       EXT.imageInfo,
  'document':    EXT.documentInfo,
  'practice':    EXT.practiceInfo,
  'etc-content': EXT.etcContentInfo,
};

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - navigation 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildNavigation(ctx, payload) {
  try {
    const p = payload || {};
    const verbKey = String(p.verb || '').toLowerCase();
    // lesson 진행 호환: 'finished'/'started' 등 lesson 라우터에서 흘러올 수 있음
    let normalizedVerb = verbKey;
    if (verbKey === 'finished') normalizedVerb = 'learned';
    if (verbKey === 'started') normalizedVerb = 'viewed';
    if (verbKey === 'completed') normalizedVerb = 'learned';
    if (!ALLOWED_VERBS.has(normalizedVerb)) {
      throw new Error(`invalid navigation verb: ${p.verb}`);
    }
    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const verb = VERB[normalizedVerb];

    // 4분기 slug 결정: payload.nav_slug > content_type 매핑 > 기본 etc-content
    let navSlug = String(p.nav_slug || '').toLowerCase();
    if (!INFO_KEY_BY_SLUG[navSlug]) {
      navSlug = mapNavigationSlug(p.content_type || p.target_type);
    }
    const infoKey = INFO_KEY_BY_SLUG[navSlug];

    // 대상 ID 정규화: lesson_id > target_id > content_id
    const objectId = p.lesson_id != null ? p.lesson_id
      : (p.target_id != null ? p.target_id : p.content_id);
    const objectTitle = p.target_title || p.title;

    // *-info 본문 (image-info 도 동일 구조 — id + curriculum-standard-id + content-type)
    const infoBody = [{
      id: String(objectId != null ? objectId : ''),
      'curriculum-standard-id': resolved.primary_std_id || null,
      'content-type': p.content_type || null,
      title: objectTitle || null,
    }];

    const extraExtensions = {
      [infoKey]: infoBody,
    };
    if (p.referrer_url) {
      extraExtensions[EXT.sourceUrl] = p.referrer_url;
    }

    const object = makeActivity({
      type: navSlug,
      id: objectId,
      name: objectTitle,
      extraExtensions,
    });

    // result: 'learned' + completed/progress 100% 인 경우에만 completion 기록
    let result;
    if (normalizedVerb === 'learned' && (p.completed === true || Number(p.progress_percent) >= 100)) {
      result = {
        completion: true,
        extensions: {
          [EXT.durationSec]: Number(p.duration_sec) || 0,
        },
      };
    } else if (p.duration_sec != null || p.progress_percent != null) {
      result = {
        extensions: {
          [EXT.durationSec]: Number(p.duration_sec) || 0,
        },
      };
      if (p.progress_percent != null) {
        result.extensions[`https://dacheum.kr/xapi/extension/progress-percent`] = Number(p.progress_percent);
      }
    }

    const context = makeContext({
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'navigation',
      verb: normalizedVerb,
      object_type: navSlug,
      object_id: objectId,
      primary_std_id: resolved.primary_std_id,
      subject_code: resolved.subject_code,
      success: undefined,
      achievement_level: undefined,
      user_id: ctx.userId,
      ancestor_union: Array.from(resolved.ancestor_union || []),
    };

    return { statement, meta };
  } catch (e) {
    return { statement: null, meta: null, error: e.message };
  }
};
