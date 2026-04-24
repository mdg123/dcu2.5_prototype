// lib/xapi/spool.js
// ─────────────────────────────────────────────────────────────
// xAPI statement 로컬 수집 · 집계 엔진.
//   enqueue(builderResult, ctx)  — 스풀 INSERT + lrs_std_node_stats 조상체인 업서트
//   drainUnsent(limit)           — 송신 대기 조회 (추후 허브 연결용)
//   markSent(id, status, err)    — 상태 업데이트
// 이벤트 실패가 본기능을 막지 않도록 모든 함수가 try 보호.
// ─────────────────────────────────────────────────────────────
const db = require('../../db');
const { userUuid } = require('./common');

const insSpool = db.prepare(`
  INSERT INTO xapi_statement_spool
    (user_uuid, user_id, area, verb, statement_json, event_timestamp,
     primary_std_id, subject_code, object_type, object_id, success, achievement_level,
     sent_at, sent_status, retry_count, created_at)
  VALUES
    (@user_uuid, @user_id, @area, @verb, @statement_json, @event_timestamp,
     @primary_std_id, @subject_code, @object_type, @object_id, @success, @achievement_level,
     NULL, NULL, 0, CURRENT_TIMESTAMP)
`);

const selNodeDepth = db.prepare('SELECT depth FROM curriculum_content_nodes WHERE id = ?');
const upsertStats = db.prepare(`
  INSERT INTO lrs_std_node_stats (user_id, node_id, depth, attempts, correct, last_level, updated_at)
  VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id, node_id) DO UPDATE SET
    attempts   = attempts + 1,
    correct    = correct + excluded.correct,
    last_level = COALESCE(excluded.last_level, last_level),
    depth      = excluded.depth,
    updated_at = CURRENT_TIMESTAMP
`);

/**
 * 빌더 결과({ statement, meta }) 와 ctx({ userId, ...}) 를 받아
 * spool 에 저장하고 표준체계 조상체인 통계를 업데이트.
 * @returns {{ spoolId:number|null, statsUpdated:number, error?:string }}
 */
function enqueue(builderResult, ctx = {}) {
  const res = { spoolId: null, statsUpdated: 0 };
  try {
    if (!builderResult || builderResult.error || !builderResult.statement || !builderResult.meta) {
      res.error = builderResult && builderResult.error || 'invalid builder result';
      return res;
    }
    const { statement, meta } = builderResult;
    const userId = meta.user_id || ctx.userId || null;
    if (!userId) { res.error = 'missing user_id'; return res; }

    const row = {
      user_uuid: userUuid(userId),
      user_id: userId,
      area: meta.area || 'unknown',
      verb: meta.verb || 'unknown',
      statement_json: JSON.stringify(statement),
      event_timestamp: statement.timestamp || new Date().toISOString(),
      primary_std_id: meta.primary_std_id || null,
      subject_code: meta.subject_code || null,
      object_type: meta.object_type || null,
      object_id: meta.object_id != null ? Number(meta.object_id) || null : null,
      success: meta.success != null ? (meta.success ? 1 : 0) : null,
      achievement_level: meta.achievement_level || null,
    };
    const info = insSpool.run(row);
    res.spoolId = info.lastInsertRowid;

    // lrs_std_node_stats 업데이트 - 조상체인 포함 (리프 + 상위)
    const ancestors = Array.isArray(meta.ancestor_union) ? meta.ancestor_union : [];
    if (ancestors.length && userId) {
      const correct = meta.success ? 1 : 0;
      const level = meta.achievement_level || null;
      const tx = db.transaction((nodes) => {
        for (const nid of nodes) {
          const depthRow = selNodeDepth.get(nid);
          if (!depthRow) continue;
          upsertStats.run(userId, nid, depthRow.depth, correct, level);
          res.statsUpdated++;
        }
      });
      tx(ancestors);
    }
    return res;
  } catch (e) {
    res.error = String(e && e.message || e);
    // 절대 본 기능을 막지 않음: 에러를 반환만 하고 끝
    return res;
  }
}

/**
 * 미전송 스풀 일괄 조회 (추후 허브 연결 시 drain → POST)
 */
function drainUnsent(limit = 500) {
  try {
    return db.prepare(
      `SELECT id, user_uuid, area, verb, statement_json, event_timestamp
       FROM xapi_statement_spool WHERE sent_at IS NULL
       ORDER BY event_timestamp ASC LIMIT ?`
    ).all(limit);
  } catch (e) {
    return [];
  }
}

function markSent(id, status = 'ok', errorMessage = null) {
  try {
    db.prepare(
      `UPDATE xapi_statement_spool SET sent_at = CURRENT_TIMESTAMP, sent_status = ?, error_message = ?,
         retry_count = CASE WHEN ? = 'ok' THEN retry_count ELSE retry_count + 1 END WHERE id = ?`
    ).run(status, errorMessage, status, id);
    return true;
  } catch { return false; }
}

/**
 * 빌더 + enqueue 를 하나로 묶은 편의 함수. 라우터에서:
 *   record('assessment', builderFn, ctx, payload)
 * 또는 statement 를 직접 줄 때:
 *   record('assessment', { statement, meta }, ctx)
 */
function record(area, builderOrResult, ctx, payload) {
  try {
    const result = typeof builderOrResult === 'function'
      ? builderOrResult(ctx, payload)
      : builderOrResult;
    if (result && result.meta && !result.meta.area) result.meta.area = area;
    return enqueue(result, ctx);
  } catch (e) {
    return { spoolId: null, statsUpdated: 0, error: String(e && e.message || e) };
  }
}

module.exports = { enqueue, drainUnsent, markSent, record };
