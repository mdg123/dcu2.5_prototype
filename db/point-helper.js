// db/point-helper.js
const db = require('./index');

/**
 * 사용자에게 포인트를 부여하는 공통 함수.
 */
function awardPoints(userId, { source, sourceId = null, points, description }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO user_points (user_id, points, source, source_id, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(userId, points, source, sourceId, description);
  } catch (error) {
    console.error('[다채움] 포인트 부여 실패:', error.message);
  }
}

/**
 * 사용자의 총 포인트 조회
 */
function getTotalPoints(userId) {
  const result = db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM user_points WHERE user_id = ?').get(userId);
  return result.total;
}

/**
 * 시스템 설정 조회
 */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

module.exports = { awardPoints, getTotalPoints, getSetting };
