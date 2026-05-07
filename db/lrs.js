const db = require('./index');
const { logLearningActivity } = require('./learning-log-helper');

// 학습 로그 기록 (레거시 진입점 — 내부적으로 logLearningActivity 래핑)
function logActivity(userId, data) {
  // 레거시 필드를 Phase 2 필드로 정규화
  const targetType = data.target_type || data.object_type || 'Activity';
  const targetId = data.target_id != null ? data.target_id
                 : (data.activity_id != null ? data.activity_id
                 : (data.object_id != null ? data.object_id : null));

  // result 객체가 있다면 분해
  let resultScore = data.result_score !== undefined ? data.result_score : null;
  let resultSuccess = data.result_success !== undefined ? data.result_success : null;
  let resultDuration = data.result_duration !== undefined ? data.result_duration : null;
  if (data.result && typeof data.result === 'object') {
    if (data.result.score !== undefined && resultScore === null) {
      resultScore = typeof data.result.score === 'object' ? data.result.score.scaled : data.result.score;
    }
    if (data.result.success !== undefined && resultSuccess === null) {
      resultSuccess = data.result.success ? 1 : 0;
    }
    if (data.result.duration !== undefined && resultDuration === null) {
      resultDuration = String(data.result.duration);
    }
  }

  const ret = logLearningActivity({
    userId,
    activityType: data.activity_type,
    targetType,
    targetId,
    classId: data.class_id || null,
    verb: data.verb || 'completed',
    objectType: data.object_type || 'Activity',
    objectId: data.object_id || null,
    resultScore,
    resultSuccess,
    resultDuration: resultDuration || (data.duration != null ? String(data.duration) : null),
    sourceService: data.source_service || 'class',
    achievementCode: data.achievement_code || null,
    metadata: data.metadata || null,
    sessionId: data.session_id || null,
    durationSec: data.duration_sec != null ? data.duration_sec : (data.duration != null ? data.duration : null),
    deviceType: data.device_type || null,
    platform: data.platform || null,
    retryCount: data.retry_count || 0,
    correctCount: data.correct_count || null,
    totalItems: data.total_items || null,
    achievementLevel: data.achievement_level || null,
    parentStatementId: data.parent_statement_id || null,
    subjectCode: data.subject_code || null,
    gradeGroup: data.grade_group || null
  });

  const insertedId = ret && ret.id;
  if (insertedId) {
    return db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(insertedId);
  }
  return null;
}

// 사용자별 활동 로그
function getUserLogs(userId, { classId, activityType, page = 1, limit = 20, startDate, endDate } = {}) {
  let where = ' WHERE user_id = ?';
  const params = [userId];
  if (classId) { where += ' AND class_id = ?'; params.push(classId); }
  if (activityType) { where += ' AND activity_type = ?'; params.push(activityType); }
  if (startDate) { where += ' AND created_at >= ?'; params.push(startDate); }
  if (endDate) { where += " AND created_at <= ? || ' 23:59:59'"; params.push(endDate); }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM learning_logs' + where).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const logs = db.prepare('SELECT * FROM learning_logs' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, limit, (page - 1) * limit);
  return { logs, total, totalPages };
}

// 대시보드 통계
function getDashboardStats(userId) {
  // duration_sec 우선, legacy duration/result_duration 보조 (C-4)
  const DUR_EXPR = "COALESCE(duration_sec, duration, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER), 0)";

  // 전체 통계
  const totalActivities = db.prepare('SELECT COUNT(*) as cnt FROM learning_logs WHERE user_id = ?').get(userId).cnt;
  const totalDuration = db.prepare(`SELECT COALESCE(SUM(${DUR_EXPR}), 0) as total FROM learning_logs WHERE user_id = ?`).get(userId).total;

  // 오늘 통계
  const today = new Date().toISOString().slice(0, 10);
  const todayActivities = db.prepare("SELECT COUNT(*) as cnt FROM learning_logs WHERE user_id = ? AND DATE(created_at) = ?").get(userId, today).cnt;
  const todayDuration = db.prepare(`SELECT COALESCE(SUM(${DUR_EXPR}), 0) as total FROM learning_logs WHERE user_id = ? AND DATE(created_at) = ?`).get(userId, today).total;

  // 활동 유형별
  const byType = db.prepare(`
    SELECT activity_type, COUNT(*) as cnt, COALESCE(SUM(${DUR_EXPR}), 0) as total_duration
    FROM learning_logs WHERE user_id = ? GROUP BY activity_type ORDER BY cnt DESC
  `).all(userId);

  // 최근 30일 일별 활동
  const dailyActivity = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as cnt, COALESCE(SUM(${DUR_EXPR}), 0) as duration
    FROM learning_logs WHERE user_id = ? AND created_at >= DATE('now', '-30 days')
    GROUP BY DATE(created_at) ORDER BY date
  `).all(userId);

  // 과목별 (verb 기준)
  const byVerb = db.prepare(`
    SELECT verb, COUNT(*) as cnt FROM learning_logs WHERE user_id = ? GROUP BY verb ORDER BY cnt DESC
  `).all(userId);

  return {
    totalActivities,
    totalDurationMinutes: Math.round(totalDuration / 60),
    todayActivities,
    todayDurationMinutes: Math.round(todayDuration / 60),
    byType,
    dailyActivity,
    byVerb
  };
}

// ISO YYYY-MM-DD 날짜 검증 (잘못된 형식이면 null 반환)
function _validIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// 클래스 LRS 통계 (교사용)
// opts: { startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' }
function getClassLrsStats(classId, opts = {}) {
  const startDate = _validIsoDate(opts.startDate);
  const endDate = _validIsoDate(opts.endDate);

  // 공통 WHERE 절 빌더 (테이블 별칭 옵션)
  function buildWhere(alias) {
    const a = alias ? alias + '.' : '';
    const conds = [`${a}class_id = ?`];
    const params = [classId];
    if (startDate) { conds.push(`${a}created_at >= ?`); params.push(startDate + ' 00:00:00'); }
    if (endDate)   { conds.push(`${a}created_at <= ?`); params.push(endDate + ' 23:59:59'); }
    return { sql: conds.join(' AND '), params };
  }

  const wTot = buildWhere();
  const totalLogs = db.prepare(`SELECT COUNT(*) as cnt FROM learning_logs WHERE ${wTot.sql}`).get(...wTot.params).cnt;

  // 학생별 활동 통계 — duration_sec 우선 (C-4)
  const wByS = buildWhere('ll');
  const byStudent = db.prepare(`
    SELECT ll.user_id, u.display_name, COUNT(*) as activity_count,
           COALESCE(SUM(COALESCE(ll.duration_sec, ll.duration, CAST(REPLACE(REPLACE(COALESCE(ll.result_duration,''),'PT',''),'S','') AS INTEGER), 0)), 0) as total_duration
    FROM learning_logs ll JOIN users u ON ll.user_id = u.id
    WHERE ${wByS.sql}
    GROUP BY ll.user_id ORDER BY activity_count DESC
  `).all(...wByS.params);

  // 활동 유형별
  const wType = buildWhere();
  const byType = db.prepare(
    `SELECT activity_type, COUNT(*) as cnt FROM learning_logs WHERE ${wType.sql} GROUP BY activity_type ORDER BY cnt DESC`
  ).all(...wType.params);

  // 일별 추이 — 기간 미지정 시 종전대로 최근 7일, 지정 시 해당 구간 전체
  let dailyTrend;
  if (startDate || endDate) {
    const wTrend = buildWhere();
    dailyTrend = db.prepare(
      `SELECT DATE(created_at) as date, COUNT(*) as cnt FROM learning_logs WHERE ${wTrend.sql} GROUP BY DATE(created_at) ORDER BY date`
    ).all(...wTrend.params);
  } else {
    dailyTrend = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as cnt
      FROM learning_logs WHERE class_id = ? AND created_at >= DATE('now', '-7 days')
      GROUP BY DATE(created_at) ORDER BY date
    `).all(classId);
  }

  return { totalLogs, byStudent, byType, dailyTrend };
}

module.exports = { logActivity, getUserLogs, getDashboardStats, getClassLrsStats };
