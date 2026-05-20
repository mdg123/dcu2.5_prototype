// lib/xapi/builders/media.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI builder — verb: played (PDF 29~33쪽)
// 영상·음성 등 미디어 재생/열람 이벤트.
//
// Phase 2 정합:
//   - activity-type slug → 'media' (이미지/문서는 navigation 영역으로 분기)
//   - object.definition.extensions: audioInfo | videoInfo (AIDT 표준 EXT)
//   - result.extensions: audioDetail | videoDetail (duration int 초, completion %,
//                                                   attempt, mute-cnt, skip-cnt, pause-cnt)
//   - legacy 'total-duration-seconds' 하드코드 → audio/video Detail.duration 으로 흡수
// ─────────────────────────────────────────────────────────────
const {
  makeActor, makeContext, makeStatement, makeActivity,
  VERB, EXT, buildStandardExtensions, mapContentType,
  resolveStandardContext,
} = require('../common');

/**
 * 미디어 종류 판정 (audio | video). 이미지/문서는 media 영역 대상이 아님 — 호출처에서 navigation 으로 보내야 함.
 * 기본값 video (영상 콘텐츠가 절대 다수).
 */
function detectMediaKind(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t === 'audio' || t === 'a' || t === 'sound') return 'audio';
  return 'video';
}

/**
 * @param {object} ctx  - { userId, displayName, sessionId, classId, timestamp }
 * @param {object} payload - media 재생 파라미터
 * @returns {{ statement, meta }}
 */
module.exports = function buildMediaPlayed(ctx, payload) {
  try {
    const p = payload || {};
    const resolved = resolveStandardContext(p);
    const stdExt = buildStandardExtensions(resolved);

    const actor = makeActor(ctx.userId, ctx.displayName);
    const verb = VERB.played;

    const mediaKind = detectMediaKind(p.content_type || p.media_kind);
    const isAudio = mediaKind === 'audio';

    // duration (초) — legacy 두 필드 합쳐서 흡수
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

    // AIDT object.definition.extensions — audio-info / video-info
    // PDF 29쪽 audio-info / 31쪽 video-info 구조 참조
    const infoKey = isAudio ? EXT.audioInfo : EXT.videoInfo;
    const infoBody = [{
      id: String(p.content_id != null ? p.content_id : ''),
      'content-type': mapContentType(p.content_type),
      'curriculum-standard-id': resolved.primary_std_id || null,
      title: p.title || null,
    }];

    const object = makeActivity({
      type: 'media',
      id: p.content_id,
      name: p.title,
      extraExtensions: {
        [infoKey]: infoBody,
        // 다채움 내부 메타는 유지 (대시보드/포트폴리오 용)
        [EXT.contentType]: mapContentType(p.content_type),
        ...(p.source_url ? { [EXT.sourceUrl]: p.source_url } : {}),
      },
    });

    // AIDT result.extensions — audio-detail / video-detail
    const detailKey = isAudio ? EXT.audioDetail : EXT.videoDetail;
    const detailBody = [{
      id: String(p.content_id != null ? p.content_id : ''),
      duration: Math.round(durSec),                           // 초(int)
      completion: Math.round(completionPct),                  // % (int)
      attempt: Number(p.attempt) || 1,
      'mute-cnt': Number(p.mute_count) || 0,
      'skip-cnt': Number(p.skip_count) || 0,
      'pause-cnt': Number(p.pause_count) || 0,
    }];

    const result = {
      duration: `PT${Math.round(durSec)}S`,
      completion: completionPct >= 100,
      extensions: {
        [detailKey]: detailBody,
        [EXT.durationSec]: durSec,
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
