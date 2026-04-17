// db/portal-extended.js
const db = require('./index');

// 마이그레이션: bookmark_count 컬럼 추가
try { db.exec('ALTER TABLE contents ADD COLUMN bookmark_count INTEGER DEFAULT 0'); } catch(e) {}

function getHallOfFame(month, period) {
  // period: 'weekly' = 최근 7일, 'monthly' = 해당 월 또는 최근 30일
  let dateFilter, contentDateFilter;
  const useMonth = month && /^\d{4}-\d{2}$/.test(month);
  if (period === 'weekly') {
    dateFilter = ` AND ll.created_at >= DATE('now', '-7 days')`;
    contentDateFilter = ` AND ct.created_at >= DATE('now', '-7 days')`;
  } else if (useMonth) {
    dateFilter = ` AND strftime('%Y-%m', ll.created_at) = ?`;
    contentDateFilter = ` AND strftime('%Y-%m', ct.created_at) = ?`;
  } else {
    dateFilter = ` AND ll.created_at >= DATE('now', '-30 days')`;
    contentDateFilter = ` AND ct.created_at >= DATE('now', '-30 days')`;
  }

  // 최다활동 클래스
  const topClasses = db.prepare(`
    SELECT c.id, c.name, c.school_name, COUNT(*) as activity_count,
      (SELECT COUNT(DISTINCT cm.user_id) FROM class_members cm WHERE cm.class_id = c.id AND cm.status='active') as member_count
    FROM learning_logs ll JOIN classes c ON ll.class_id = c.id
    WHERE ll.class_id IS NOT NULL ${dateFilter}
    GROUP BY c.id ORDER BY activity_count DESC LIMIT 20
  `).all(...(useMonth ? [month] : []));

  // 최다콘텐츠 크리에이터 (공개 및 승인된 콘텐츠 - 해당 기간 통계)
  const topCreators = db.prepare(`
    SELECT u.id, u.display_name, u.school_name, u.role,
      COUNT(*) as content_count,
      COALESCE(SUM(ct.view_count), 0) as total_views,
      COALESCE(SUM(ct.like_count), 0) as total_likes,
      COALESCE(SUM(ct.bookmark_count), 0) as total_bookmarks,
      (SELECT COUNT(*) FROM contents c2 WHERE c2.creator_id = u.id AND c2.is_public = 1) as all_content_count
    FROM contents ct JOIN users u ON ct.creator_id = u.id
    WHERE ct.is_public = 1 ${contentDateFilter}
    GROUP BY u.id ORDER BY content_count DESC LIMIT 20
  `).all(...(useMonth ? [month] : []));

  // 최다학습 학습자
  const topLearners = db.prepare(`
    SELECT u.id, u.display_name, u.school_name, u.grade, COUNT(*) as learning_count
    FROM learning_logs ll JOIN users u ON ll.user_id = u.id
    WHERE u.role = 'student' ${dateFilter}
    GROUP BY u.id ORDER BY learning_count DESC LIMIT 20
  `).all(...(useMonth ? [month] : []));

  return { topClasses, topCreators, topLearners };
}

function getCalendarEvents(userId, { startDate, endDate, month, year } = {}) {
  // 사용자가 속한 클래스 목록
  const classIds = db.prepare('SELECT class_id FROM class_members WHERE user_id = ?').all(userId).map(r => r.class_id);
  if (classIds.length === 0) return [];

  // month/year 파라미터로 startDate/endDate 자동 계산
  if (!startDate && !endDate && month && year) {
    const m = String(month).padStart(2, '0');
    startDate = `${year}-${m}-01`;
    // 해당 월의 마지막 날 계산
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    endDate = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;
  }

  const placeholders = classIds.map(() => '?').join(',');
  const events = [];

  // 클래스 이름 조회용 맵
  const classMap = {};
  db.prepare(`SELECT id, name FROM classes WHERE id IN (${placeholders})`).all(...classIds).forEach(c => {
    classMap[c.id] = c.name;
  });

  const dateFilter = (startDate && endDate);

  // 수업 일정
  const lessonSql = dateFilter
    ? `SELECT id, class_id, title, lesson_date as event_date, 'lesson' as event_type
       FROM lessons WHERE class_id IN (${placeholders}) AND lesson_date BETWEEN ? AND ? AND status = 'published'`
    : `SELECT id, class_id, title, lesson_date as event_date, 'lesson' as event_type
       FROM lessons WHERE class_id IN (${placeholders}) AND status = 'published'`;
  const lessons = dateFilter
    ? db.prepare(lessonSql).all(...classIds, startDate, endDate)
    : db.prepare(lessonSql).all(...classIds);
  events.push(...lessons);

  // 과제 마감일
  const hwSql = dateFilter
    ? `SELECT id, class_id, title, due_date as event_date, 'homework' as event_type
       FROM homework WHERE class_id IN (${placeholders}) AND due_date BETWEEN ? AND ? AND status = 'published'`
    : `SELECT id, class_id, title, due_date as event_date, 'homework' as event_type
       FROM homework WHERE class_id IN (${placeholders}) AND status = 'published'`;
  const homeworks = dateFilter
    ? db.prepare(hwSql).all(...classIds, startDate, endDate)
    : db.prepare(hwSql).all(...classIds);
  events.push(...homeworks);

  // 평가 일정 (start_date > started_at > created_at 우선순위, draft 제외)
  const examSql = dateFilter
    ? `SELECT id, class_id, title, DATE(COALESCE(start_date, started_at, created_at)) as event_date,
         DATE(COALESCE(end_date, ended_at)) as event_end_date, 'exam' as event_type, status as exam_status, time_limit
       FROM exams WHERE class_id IN (${placeholders}) AND status != 'draft'
         AND (
           (DATE(COALESCE(start_date, started_at, created_at)) BETWEEN ? AND ?)
           OR (DATE(COALESCE(end_date, ended_at)) BETWEEN ? AND ?)
         )`
    : `SELECT id, class_id, title, DATE(COALESCE(start_date, started_at, created_at)) as event_date,
         DATE(COALESCE(end_date, ended_at)) as event_end_date, 'exam' as event_type, status as exam_status, time_limit
       FROM exams WHERE class_id IN (${placeholders}) AND status != 'draft'`;
  const exams = dateFilter
    ? db.prepare(examSql).all(...classIds, startDate, endDate, startDate, endDate)
    : db.prepare(examSql).all(...classIds);
  events.push(...exams);

  // 설문 마감일
  const surveySql = dateFilter
    ? `SELECT id, class_id, title, end_date as event_date, 'survey' as event_type
       FROM surveys WHERE class_id IN (${placeholders}) AND end_date BETWEEN ? AND ? AND status = 'active'`
    : `SELECT id, class_id, title, end_date as event_date, 'survey' as event_type
       FROM surveys WHERE class_id IN (${placeholders}) AND status = 'active'`;
  const surveys = dateFilter
    ? db.prepare(surveySql).all(...classIds, startDate, endDate)
    : db.prepare(surveySql).all(...classIds);
  events.push(...surveys);

  // 각 이벤트에 class_name 추가
  events.forEach(e => {
    e.class_name = classMap[e.class_id] || null;
  });

  // event_date 기준 정렬
  events.sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));

  return events;
}

function getTrendingPosts(userId, { limit = 10 } = {}) {
  const classIds = db.prepare('SELECT class_id FROM class_members WHERE user_id = ?').all(userId).map(r => r.class_id);
  if (classIds.length === 0) return { popular: [], latest: [], surveys: [] };

  const placeholders = classIds.map(() => '?').join(',');

  const popular = db.prepare(`
    SELECT p.*, u.display_name as author_name, c.name as class_name
    FROM posts p JOIN users u ON p.author_id = u.id JOIN classes c ON p.class_id = c.id
    WHERE p.class_id IN (${placeholders})
    ORDER BY p.view_count DESC LIMIT ?
  `).all(...classIds, limit);
  popular.forEach(p => { if (p.is_anonymous) p.author_name = '익명'; });

  const latest = db.prepare(`
    SELECT p.*, u.display_name as author_name, c.name as class_name
    FROM posts p JOIN users u ON p.author_id = u.id JOIN classes c ON p.class_id = c.id
    WHERE p.class_id IN (${placeholders})
    ORDER BY p.created_at DESC LIMIT ?
  `).all(...classIds, limit);
  latest.forEach(p => { if (p.is_anonymous) p.author_name = '익명'; });

  const surveys = db.prepare(`
    SELECT s.*, u.display_name as author_name, c.name as class_name
    FROM surveys s JOIN users u ON s.author_id = u.id JOIN classes c ON s.class_id = c.id
    WHERE s.class_id IN (${placeholders}) AND s.status = 'active'
    ORDER BY s.end_date ASC LIMIT ?
  `).all(...classIds, limit);

  return { popular, latest, surveys };
}

function getMyDashboardSummary(userId) {
  const classCount = db.prepare('SELECT COUNT(*) as cnt FROM class_members WHERE user_id = ?').get(userId).cnt;

  // 미완료 과제
  const classIds = db.prepare('SELECT class_id FROM class_members WHERE user_id = ?').all(userId).map(r => r.class_id);
  let pendingHomework = 0;
  if (classIds.length > 0) {
    const placeholders = classIds.map(() => '?').join(',');
    const hwIds = db.prepare(`SELECT id FROM homework WHERE class_id IN (${placeholders}) AND status = 'published' AND due_date >= DATE('now')`).all(...classIds).map(r => r.id);
    if (hwIds.length > 0) {
      const hwPlaceholders = hwIds.map(() => '?').join(',');
      const submitted = db.prepare(`SELECT COUNT(*) as cnt FROM homework_submissions WHERE homework_id IN (${hwPlaceholders}) AND student_id = ?`).get(...hwIds, userId).cnt;
      pendingHomework = hwIds.length - submitted;
    }
  }

  // 읽지 않은 알림
  const unreadNotifications = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).cnt;

  // 오늘의 학습 현황
  const today = new Date().toISOString().slice(0, 10);
  const dailyProgress = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM daily_learning_progress p
    JOIN daily_learning_items i ON p.item_id = i.id
    JOIN daily_learning_sets s ON i.set_id = s.id
    WHERE p.user_id = ? AND s.target_date = ?
  `).get(userId, today);

  // 총 포인트
  const totalPoints = db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM user_points WHERE user_id = ?').get(userId).total;

  // 교사용: 예정 평가 — 본인이 소유한 클래스의 published/active/waiting 상태 평가 중 end_date 미도래
  let upcomingExams = 0;
  try {
    upcomingExams = db.prepare(`
      SELECT COUNT(*) as cnt FROM exams
      WHERE owner_id = ?
        AND status IN ('active','waiting','published')
        AND (end_date IS NULL OR end_date >= DATE('now'))
    `).get(userId).cnt;
  } catch {}

  // 학생용: 이번 주(월~일) 완료 학습 수
  let weekCompleted = 0;
  try {
    const now = new Date();
    const dow = now.getDay();
    const monday = new Date(now); monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const monStr = monday.toISOString().slice(0, 10);
    const sunStr = sunday.toISOString().slice(0, 10);
    weekCompleted = db.prepare(`
      SELECT COUNT(*) as cnt FROM daily_learning_progress
      WHERE user_id = ? AND status='completed' AND DATE(completed_at) BETWEEN ? AND ?
    `).get(userId, monStr, sunStr).cnt;
  } catch {}

  // 담은 자료(보관함) 수
  let collectionCount = 0;
  try {
    collectionCount = db.prepare('SELECT COUNT(*) as cnt FROM content_collection WHERE user_id = ?').get(userId).cnt;
  } catch {
    try {
      collectionCount = db.prepare('SELECT COUNT(*) as cnt FROM content_collections WHERE user_id = ?').get(userId).cnt;
    } catch {}
  }

  return {
    classCount,
    pendingHomework: Math.max(0, pendingHomework),
    unreadNotifications,
    dailyLearning: dailyProgress,
    totalPoints,
    upcomingExams,
    weekCompleted,
    collectionCount
  };
}

function getRecentActivities(userId, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT ll.*, u.display_name,
      CASE ll.activity_type
        WHEN 'content_view' THEN '콘텐츠 조회'
        WHEN 'homework_submit' THEN '과제 제출'
        WHEN 'exam_submit' THEN '평가 응시'
        WHEN 'attendance_checkin' THEN '출석 체크'
        WHEN 'lesson_view' THEN '수업 참여'
        WHEN 'post_create' THEN '게시글 작성'
        WHEN 'survey_response' THEN '설문 응답'
        ELSE ll.activity_type
      END as activity_label
    FROM learning_logs ll
    JOIN users u ON ll.user_id = u.id
    WHERE ll.user_id = ?
    ORDER BY ll.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

module.exports = { getHallOfFame, getCalendarEvents, getTrendingPosts, getMyDashboardSummary, getRecentActivities };
