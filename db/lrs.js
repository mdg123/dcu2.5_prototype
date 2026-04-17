const db = require('./index');

// 학습 로그 기록
function logActivity(userId, data) {
  const info = db.prepare(`
    INSERT INTO learning_logs (user_id, class_id, activity_type, activity_id, verb, object_type, object_id, result, duration, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, data.class_id || null, data.activity_type, data.activity_id || null,
    data.verb, data.object_type || null, data.object_id || null,
    data.result ? JSON.stringify(data.result) : null,
    data.duration || null, data.metadata ? JSON.stringify(data.metadata) : null
  );
  return db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(info.lastInsertRowid);
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
  // 전체 통계
  const totalActivities = db.prepare('SELECT COUNT(*) as cnt FROM learning_logs WHERE user_id = ?').get(userId).cnt;
  const totalDuration = db.prepare('SELECT COALESCE(SUM(duration), 0) as total FROM learning_logs WHERE user_id = ?').get(userId).total;

  // 오늘 통계
  const today = new Date().toISOString().slice(0, 10);
  const todayActivities = db.prepare("SELECT COUNT(*) as cnt FROM learning_logs WHERE user_id = ? AND DATE(created_at) = ?").get(userId, today).cnt;
  const todayDuration = db.prepare("SELECT COALESCE(SUM(duration), 0) as total FROM learning_logs WHERE user_id = ? AND DATE(created_at) = ?").get(userId, today).total;

  // 활동 유형별
  const byType = db.prepare(`
    SELECT activity_type, COUNT(*) as cnt, COALESCE(SUM(duration), 0) as total_duration
    FROM learning_logs WHERE user_id = ? GROUP BY activity_type ORDER BY cnt DESC
  `).all(userId);

  // 최근 30일 일별 활동
  const dailyActivity = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as cnt, COALESCE(SUM(duration), 0) as duration
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

// 클래스 LRS 통계 (교사용)
function getClassLrsStats(classId) {
  const totalLogs = db.prepare('SELECT COUNT(*) as cnt FROM learning_logs WHERE class_id = ?').get(classId).cnt;

  // 학생별 활동 통계
  const byStudent = db.prepare(`
    SELECT ll.user_id, u.display_name, COUNT(*) as activity_count,
           COALESCE(SUM(ll.duration), 0) as total_duration
    FROM learning_logs ll JOIN users u ON ll.user_id = u.id
    WHERE ll.class_id = ?
    GROUP BY ll.user_id ORDER BY activity_count DESC
  `).all(classId);

  // 활동 유형별
  const byType = db.prepare(`
    SELECT activity_type, COUNT(*) as cnt FROM learning_logs WHERE class_id = ? GROUP BY activity_type ORDER BY cnt DESC
  `).all(classId);

  // 최근 7일 추이
  const dailyTrend = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as cnt
    FROM learning_logs WHERE class_id = ? AND created_at >= DATE('now', '-7 days')
    GROUP BY DATE(created_at) ORDER BY date
  `).all(classId);

  return { totalLogs, byStudent, byType, dailyTrend };
}

module.exports = { logActivity, getUserLogs, getDashboardStats, getClassLrsStats };
