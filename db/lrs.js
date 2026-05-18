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

  // ====== summary 5지표 (RFP P0 — 클래스별 학습분석) ======
  // 기간 절을 임의 컬럼/타입에 맞게 생성하는 헬퍼
  function rangeFor(col) {
    const parts = [];
    const params = [];
    if (startDate) { parts.push(`${col} >= ?`); params.push(startDate + ' 00:00:00'); }
    if (endDate)   { parts.push(`${col} <= ?`); params.push(endDate + ' 23:59:59'); }
    return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
  }

  // 활동 멤버 수 (status='active', role='member' — 학생만)
  const memberCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM class_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'`
  ).get(classId).cnt || 0;

  // 수업 수 (published 만 — 학생에게 노출된 것만 분모로)
  const lessonRange = rangeFor('created_at');
  const lessonCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM lessons WHERE class_id = ? AND status = 'published'${lessonRange.sql}`
  ).get(classId, ...lessonRange.params).cnt || 0;

  // 수업 이수 — lesson_self_check 작성을 이수로 간주 (RFP P1 진행도 트래킹 부재 시 표준 대용)
  const lscRange = rangeFor('lsc.created_at');
  const completedLessonsRow = db.prepare(
    `SELECT COUNT(DISTINCT lsc.lesson_id || '_' || lsc.user_id) AS cnt
     FROM lesson_self_check lsc
     JOIN lessons l ON l.id = lsc.lesson_id
     WHERE lsc.class_id = ? AND l.status = 'published'${lscRange.sql}`
  ).get(classId, ...lscRange.params);
  const completedLessons = (completedLessonsRow && completedLessonsRow.cnt) || 0;
  const lessonDenom = lessonCount * memberCount;
  const lessonCompletionRate = lessonDenom > 0
    ? Math.round((completedLessons / lessonDenom) * 1000) / 10 : 0;

  // 과제 수 (published 만)
  const hwRange = rangeFor('created_at');
  const homeworkCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM homework WHERE class_id = ? AND status = 'published'${hwRange.sql}`
  ).get(classId, ...hwRange.params).cnt || 0;

  // 과제 제출 수 (학생이 제출한 row — is_draft != 1 또는 NULL, submitted_at NOT NULL)
  const hwsRange = rangeFor('hs.submitted_at');
  const homeworkSubmitted = db.prepare(
    `SELECT COUNT(*) AS cnt FROM homework_submissions hs
     JOIN homework h ON h.id = hs.homework_id
     WHERE h.class_id = ? AND h.status = 'published'
       AND hs.submitted_at IS NOT NULL
       AND COALESCE(hs.is_draft, 0) = 0${hwsRange.sql}`
  ).get(classId, ...hwsRange.params).cnt || 0;
  const hwDenom = homeworkCount * memberCount;
  const homeworkSubmitRate = hwDenom > 0
    ? Math.round((homeworkSubmitted / hwDenom) * 1000) / 10 : 0;

  // 평가 수 (waiting/active/ended 모두 — 학생 응시 대상)
  const exRange = rangeFor('created_at');
  const examCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM exams WHERE class_id = ?${exRange.sql}`
  ).get(classId, ...exRange.params).cnt || 0;

  // 평가 제출자 수
  const esRange = rangeFor('es.submitted_at');
  const examSubmitted = db.prepare(
    `SELECT COUNT(*) AS cnt FROM exam_students es
     JOIN exams e ON e.id = es.exam_id
     WHERE e.class_id = ? AND es.submitted_at IS NOT NULL${esRange.sql}`
  ).get(classId, ...esRange.params).cnt || 0;
  const exDenom = examCount * memberCount;
  const examSubmitRate = exDenom > 0
    ? Math.round((examSubmitted / exDenom) * 1000) / 10 : 0;

  // 평가 평균 점수 (제출자 한정)
  const avgScoreRow = db.prepare(
    `SELECT AVG(es.score) AS avg FROM exam_students es
     JOIN exams e ON e.id = es.exam_id
     WHERE e.class_id = ? AND es.submitted_at IS NOT NULL AND es.score IS NOT NULL${esRange.sql}`
  ).get(classId, ...esRange.params);
  const avgScore = (avgScoreRow && avgScoreRow.avg != null)
    ? Math.round(avgScoreRow.avg * 10) / 10 : 0;

  // 게시판 글 수 (approved 또는 approval_status NULL — 일반 글 포함)
  const postRange = rangeFor('created_at');
  const communityPostCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM posts WHERE class_id = ?
     AND (approval_status IS NULL OR approval_status = 'approved')${postRange.sql}`
  ).get(classId, ...postRange.params).cnt || 0;

  const summary = {
    lessonCompletionRate,
    homeworkSubmitRate,
    examSubmitRate,
    avgScore,
    communityPostCount,
    lessonCount,
    homeworkCount,
    examCount,
    memberCount
  };

  return { totalLogs, byStudent, byType, dailyTrend, summary };
}

module.exports = { logActivity, getUserLogs, getDashboardStats, getClassLrsStats };
