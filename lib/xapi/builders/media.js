// lib/xapi/builders/media.js
// ─────────────────────────────────────────────────────────────
// 대외연계 v1.0 xAPI builder — verb: played
// 영상·음성 등 미디어 재생/열람 이벤트.
//
// v1.0 정합:
//   - activity-type slug → 'media'
//   - object.definition.extensions: media-info (audio/video 통합) + curriculum-standard-id(표준 위치)
//   - result: duration(ISO Duration, 필수) + media-detail{muteCount, skipCount, pauseCount, completion}
//   - 모든 확장 IRI 플랫. 다채움 내부 메타는 dacheum.kr ns 로 유지.
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현).
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, stdIdExtension, mapContentType,
  resolveStandardContext, DIFFICULTY_NONE,
} = require('../common');

function detectMediaKind(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t === 'audio' || t === 'a' || t === 'sound') return 'audio';
  return 'video';
}

/**
 * @param {object} ctx  - { userId, sessionId, classId, timestamp }
 * @param {object} payload - media 재생 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildMediaPlayed(ctx, payload) {
  try {
    const p = payload || {};
    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId);
    const verb = VERB.played;

    const mediaKind = detectMediaKind(p.content_type || p.media_kind);

    // duration (초)
    const durSec = Math.max(0,
      Number(p.duration_seconds) ||
      Number(p.total_duration_seconds) ||
      Number(p.duration) || 0
    );
    const completionPct = (() => {
      if (p.completion_percent != null) return Math.max(0, Math.min(100, Number(p.completion_percent)));
      if (p.progress_percent != null) return Math.max(0, Math.min(100, Number(p.progress_percent)));
      return p.completed ? 100 : 0;
    })();

    // v1.0 media-info (audio/video 통합) — object.definition.extensions
    const mediaInfoBody = [{
      id: String(p.content_id != null ? p.content_id : ''),
      length: `PT${Math.round(durSec)}S`,                          // ISO Duration
      difficulty:    p.difficulty != null ? Number(p.difficulty) : DIFFICULTY_NONE,
      difficultyMin: p.difficulty_min != null ? Number(p.difficulty_min) : DIFFICULTY_NONE,
      difficultyMax: p.difficulty_max != null ? Number(p.difficulty_max) : DIFFICULTY_NONE,
      common: p.common != null ? !!p.common : false,
      display: p.display || p.title || null,
      type: mediaKind,                                            // 'audio' | 'video'
    }];

    const object = makeActivity({
      type: 'media',
      id: p.content_id,
      name: p.title,
      extraExtensions: {
        [EXT.mediaInfo]: mediaInfoBody,
        ...stdIdExtension(resolved),
        // 다채움 내부 메타 (대시보드/포트폴리오 용)
        [EXT.contentType]: mapContentType(p.content_type),
        ...(p.source_url ? { [EXT.sourceUrl]: p.source_url } : {}),
      },
    });

    // v1.0 media-detail — result.extensions (없으면 -1)
    const num = (v) => (v != null ? Number(v) : DIFFICULTY_NONE);
    const mediaDetailBody = [{
      muteCount:  num(p.mute_count),
      skipCount:  num(p.skip_count),
      pauseCount: num(p.pause_count),
      completion: Math.round(completionPct),
    }];

    const result = {
      duration: `PT${Math.round(durSec)}S`,                       // ISO Duration (필수)
      completion: completionPct >= 100,
      extensions: {
        [EXT.mediaDetail]: mediaDetailBody,
        [EXT.durationSec]: durSec,                                // 다채움 내부 메타
      },
    };

    const context = makeContext({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      classId: ctx.classId,
      extraExtensions: stdExt,
    });

    const timestamp = ctx.timestamp || new Date().toISOString();
    const statement = makeStatement({ actor, verb, object, result, context, timestamp });

    const meta = {
      area: 'media',
      verb: 'played',
      object_type: 'media',
      object_id: p.content_id,
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
