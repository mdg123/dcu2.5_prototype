// lib/xapi/aggregator.js
// ─────────────────────────────────────────────────────────────
// AIDT xAPI 영역별 집계 변환기 (Phase 2).
//
// AIDT 표준은 Social-Learning 영역을 "게시판 단위 누적 1 statement" 로 요구한다(PDF 65~68쪽).
// 다채움은 게시글/댓글/좋아요를 이벤트 단위로 발행해 왔으므로, 일정 주기로
// 다채움 trail 을 게시판 단위 집계로 변환하여 단일 participated statement 를 산출한다.
//
// 본 모듈은 다채움 내부 trail 을 폐기하지 않는다 (이중 트랙 유지).
//   - 다채움 트랙 (learning_logs / spool 이벤트 단위) → 내부 대시보드·포트폴리오
//   - AIDT 트랙 (spool 집계 1건)                       → KERIS 송신 대상
//
// 사용 예:
//   const { aggregateSocialStatements } = require('./lib/xapi/aggregator');
//   const r = aggregateSocialStatements({ userId: 3, sinceTs: '2026-05-01T00:00:00Z' });
//   r.spooled  // 집계 → spool 적재된 statement 수
// ─────────────────────────────────────────────────────────────
const db = require('../../db');
const buildSocial = require('./builders/social');
const spool = require('./spool');
const { EXT } = require('./common');

/**
 * 사용자별 소셜 이벤트 trail 을 게시판 단위로 집계해 AIDT participated statement 로 변환.
 *
 * @param {object} opts
 *   - userId   (필수): 집계 대상 학습자
 *   - sinceTs  (필수): ISO 8601 timestamp — 이 시각 이후 발생 이벤트만 집계
 *   - untilTs  (선택): 이 시각까지 (기본 now)
 *   - sessionId, classId (선택): context 보강용
 *   - displayName (선택): actor.name 용
 *   - dryRun (선택, bool): true 면 spool INSERT 하지 않고 결과만 반환
 *
 * @returns {{ aggregates: Array, spooled: number, dryRun: boolean, error?: string }}
 *   aggregates: [{ board_id, board_kind, counts, statement, meta }]
 */
function aggregateSocialStatements(opts = {}) {
  const { userId, sinceTs, untilTs, sessionId, classId, displayName, dryRun = false } = opts;
  const out = { aggregates: [], spooled: 0, dryRun };
  try {
    if (!userId) { out.error = 'userId required'; return out; }
    if (!sinceTs) { out.error = 'sinceTs required'; return out; }
    const since = String(sinceTs);
    const until = untilTs ? String(untilTs) : new Date().toISOString();

    // 1) social area 이벤트 trail 조회 (legacy 이벤트 단위 statement)
    //    statement_id 가 있는 신규 항목만 → Phase 1 이후 적재분
    const rows = db.prepare(`
      SELECT id, statement_json, verb, object_type, object_id, event_timestamp
      FROM xapi_statement_spool
      WHERE user_id = ?
        AND area = 'social'
        AND event_timestamp >= ?
        AND event_timestamp < ?
      ORDER BY event_timestamp ASC
    `).all(userId, since, until);

    if (!rows.length) return out;

    // 2) 게시판 단위 집계 — board_id + board_kind 키
    //    legacy statement_json 에서 board_id 추출 (object.id 또는 result.extensions['board-kind'])
    const groups = new Map();  // key=`${boardId}|${boardKind}` → { boardId, boardKind, counts, lastTs }

    for (const r of rows) {
      let s;
      try { s = JSON.parse(r.statement_json); } catch { continue; }
      const verb = r.verb;
      const objectId = s.object && s.object.id ? s.object.id : null;
      // board_id 추출: object.id 의 마지막 segment, 또는 result.extensions[board-id]
      let boardId = null;
      let boardKind = 'class_board';
      try {
        const ext = (s.object && s.object.definition && s.object.definition.extensions) || {};
        boardKind = ext['board-kind'] || boardKind;
        const resExt = (s.result && s.result.extensions) || {};
        boardKind = resExt['board-kind'] || boardKind;
        // object.id 패턴: http://aidtbook.kr/xapi/objects/{slug}/{boardId}
        if (objectId) {
          const m = String(objectId).match(/\/([^/]+)$/);
          if (m) boardId = m[1];
        }
        if (r.object_id) boardId = r.object_id;
      } catch (_) {}
      if (!boardId) boardId = 'unknown';

      const key = `${boardId}|${boardKind}`;
      if (!groups.has(key)) {
        groups.set(key, {
          boardId,
          boardKind,
          counts: { view: 0, post: 0, reply: 0, comment: 0, like: 0 },
          lastTs: r.event_timestamp,
          stdContext: extractStdContextFromStatement(s),
        });
      }
      const g = groups.get(key);
      // verb → counts 매핑
      switch (String(verb || '').toLowerCase()) {
        case 'shared': g.counts.post += 1; break;
        case 'commented': g.counts.comment += 1; break;
        case 'replied': g.counts.reply += 1; break;
        case 'liked': g.counts.like += 1; break;
        case 'viewed': g.counts.view += 1; break;
        case 'participated':
        case 'posted':
          // 이미 집계/이벤트 형태 → counts 가산 (v1.0 플랫 social-learning-detail IRI)
          {
            const det = (s.result && s.result.extensions && s.result.extensions[
              EXT.socialLearningDetail
            ]) || [];
            const c0 = (det && det[0]) || {};
            g.counts.view += Number(c0['view-cnt']) || 0;
            g.counts.post += Number(c0['post-cnt']) || 0;
            g.counts.reply += Number(c0['reply-cnt']) || 0;
            g.counts.comment += Number(c0['comment-cnt']) || 0;
            g.counts.like += Number(c0['like-cnt']) || 0;
          }
          break;
        default: break;
      }
      if (r.event_timestamp > g.lastTs) g.lastTs = r.event_timestamp;
    }

    // 3) 게시판별 1 statement 생성 + (옵션) spool 적재
    for (const g of groups.values()) {
      const builderCtx = {
        userId,
        displayName,
        sessionId,
        classId,
        timestamp: g.lastTs,
      };
      const result = buildSocial(builderCtx, {
        verb: 'participated',
        board_id: g.boardId,
        board_kind: g.boardKind,
        counts: g.counts,
        curriculum_standard_ids: g.stdContext.std_ids,
        achievement_codes: g.stdContext.codes,
        subject_code: g.stdContext.subject_code,
      });
      if (!result || result.error) continue;
      out.aggregates.push({
        board_id: g.boardId,
        board_kind: g.boardKind,
        counts: g.counts,
        statement: result.statement,
        meta: result.meta,
      });
      if (!dryRun) {
        const r2 = spool.enqueue(result, { userId });
        if (r2 && r2.spoolId) out.spooled += 1;
      }
    }

    return out;
  } catch (e) {
    out.error = String(e && e.message || e);
    return out;
  }
}

/**
 * 기존 statement 에서 표준체계 컨텍스트(std_ids·codes·subject_code) 추출 — best effort.
 */
function extractStdContextFromStatement(s) {
  const out = { std_ids: null, codes: null, subject_code: null };
  try {
    const ext = (s.context && s.context.extensions) || {};
    out.std_ids = ext['https://dacheum.kr/xapi/extension/curriculum-standard-id'] || null;
    out.codes = ext['https://dacheum.kr/xapi/extension/achievement-code'] || null;
    out.subject_code = ext['https://dacheum.kr/xapi/extension/subject-code'] || null;
  } catch (_) {}
  return out;
}

module.exports = { aggregateSocialStatements };
