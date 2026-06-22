// lib/xapi/builders/navigation.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — content-viewing `viewed`
// 콘텐츠 열람 / 수업 이동 / 완료 등 탐색·학습 진입 이벤트.
//
// v1.0 정합:
//   - 라우터가 넘기는 열람 verb(viewed/read/did/learned/finished/completed/started/
//     accessed/progressed/attended 등) → 전부 content-viewing `viewed` IRI 로 통일.
//     (대외연계는 콘텐츠 열람 단위 통일이 합리적. 진행/완료 정도는 result 로 표현.)
//   - activity-type slug 4분기: image / document / practice / etc-content
//   - object.definition.extensions: *-info(플랫) + curriculum-standard-id(표준 위치)
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension, mapNavigationSlug,
  resolveStandardContext,
} = require('../common');

// 라우터가 넘기는 다양한 열람 verb 입력 — 전부 content-viewing viewed 로 매핑
const ALLOWED_VERBS = new Set([
  'viewed', 'read', 'did', 'learned',
  'finished', 'completed', 'started', 'progressed', 'accessed', 'attended',
]);

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
    const verbKey = String(p.verb || 'viewed').toLowerCase();
    if (!ALLOWED_VERBS.has(verbKey)) {
      throw new Error(`invalid navigation verb: ${p.verb}`);
    }
    // 완료성 판정(result.completion 용)만 verb 로 구분, 송신 verb 는 항상 content-viewing viewed
    const isCompleteVerb = (verbKey === 'finished' || verbKey === 'completed' || verbKey === 'learned');
    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId);
    // v1.0: 모든 콘텐츠 열람 verb → content-viewing viewed
    const verb = VERB.contentViewed;

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

    // *-info 본문(플랫) — id + content-type + title
    const infoBody = [{
      id: String(objectId != null ? objectId : ''),
      'content-type': p.content_type || null,
      title: objectTitle || null,
    }];

    const extraExtensions = {
      [infoKey]: infoBody,
      ...stdIdExtension(resolved),
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

    // result: 완료성 verb + completed/progress 100% 인 경우에만 completion 기록
    let result;
    if (isCompleteVerb && (p.completed === true || Number(p.progress_percent) >= 100)) {
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
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'navigation',
      verb: 'viewed',
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
