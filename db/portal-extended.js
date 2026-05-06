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

// ====================================================================
// my-summary 역할별 헬퍼 (포털 메인 재설계 — spec_portal_main_redesign.md)
// ====================================================================
function _getUserRole(userId) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return u ? u.role : 'student';
}

function _getChildIds(parentId) {
  // users.parent_id 기반 자녀 목록
  try {
    return db.prepare('SELECT id FROM users WHERE parent_id = ? AND role = ?').all(parentId, 'student').map(r => r.id);
  } catch { return []; }
}

function _safeCount(sql, ...args) {
  try { return db.prepare(sql).get(...args).cnt || 0; } catch { return 0; }
}

// 학생 4슬롯 + 오늘 할 일 데이터
function _studentSummary(userId) {
  const classCount = _safeCount('SELECT COUNT(*) as cnt FROM class_members WHERE user_id = ? AND status = ?', userId, 'active');

  // 오늘 마감 과제 (todayDueHw): 오늘이 마감일인 과제 중 미제출
  const classIds = db.prepare('SELECT class_id FROM class_members WHERE user_id = ? AND status = ?').all(userId, 'active').map(r => r.class_id);
  let todayDueHw = 0;
  let pendingHomework = 0;
  if (classIds.length > 0) {
    const ph = classIds.map(() => '?').join(',');
    // 오늘 마감 (D-day)
    const todayHwIds = db.prepare(`SELECT id FROM homework WHERE class_id IN (${ph}) AND status = 'published' AND DATE(due_date) = DATE('now')`).all(...classIds).map(r => r.id);
    if (todayHwIds.length > 0) {
      const hp = todayHwIds.map(() => '?').join(',');
      const submitted = _safeCount(`SELECT COUNT(*) as cnt FROM homework_submissions WHERE homework_id IN (${hp}) AND student_id = ?`, ...todayHwIds, userId);
      todayDueHw = todayHwIds.length - submitted;
    }
    // 향후 마감 (전체 미제출)
    const hwIds = db.prepare(`SELECT id FROM homework WHERE class_id IN (${ph}) AND status = 'published' AND DATE(due_date) >= DATE('now')`).all(...classIds).map(r => r.id);
    if (hwIds.length > 0) {
      const hp2 = hwIds.map(() => '?').join(',');
      const sub2 = _safeCount(`SELECT COUNT(*) as cnt FROM homework_submissions WHERE homework_id IN (${hp2}) AND student_id = ?`, ...hwIds, userId);
      pendingHomework = hwIds.length - sub2;
    }
  }

  // 미응시 평가 (pendingExams) — 본인이 속한 클래스의 active/published 평가 중 본인이 제출 안 한 것
  let pendingExams = 0;
  if (classIds.length > 0) {
    const ph = classIds.map(() => '?').join(',');
    try {
      pendingExams = _safeCount(`
        SELECT COUNT(*) as cnt FROM exams e
        WHERE e.class_id IN (${ph})
          AND e.status IN ('active','published','waiting')
          AND (e.end_date IS NULL OR DATE(e.end_date) >= DATE('now'))
          AND NOT EXISTS (
            SELECT 1 FROM exam_students es
            WHERE es.exam_id = e.id AND es.user_id = ? AND es.submitted_at IS NOT NULL
          )
      `, ...classIds, userId);
    } catch {}
  }

  // 미확인 알림장 (unreadNotices)
  let unreadNotices = 0;
  if (classIds.length > 0) {
    const ph = classIds.map(() => '?').join(',');
    unreadNotices = _safeCount(`
      SELECT COUNT(*) as cnt FROM notices n
      WHERE n.class_id IN (${ph})
        AND NOT EXISTS (SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = ?)
    `, ...classIds, userId);
  }

  // 새 알림 (notifications, 읽지 않은 시스템 알림)
  const unreadNotifications = _safeCount('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0', userId);

  // 오늘의 학습 현황
  const today = new Date().toISOString().slice(0, 10);
  let dailyProgress = { total: 0, completed: 0 };
  try {
    dailyProgress = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM daily_learning_progress p
      JOIN daily_learning_items i ON p.item_id = i.id
      JOIN daily_learning_sets s ON i.set_id = s.id
      WHERE p.user_id = ? AND s.target_date = ?
    `).get(userId, today) || dailyProgress;
  } catch {}

  // 이번 주(월~일) 완료 학습 수
  let weekCompleted = 0;
  try {
    const now = new Date();
    const dow = now.getDay();
    const monday = new Date(now); monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const monStr = monday.toISOString().slice(0, 10);
    const sunStr = sunday.toISOString().slice(0, 10);
    weekCompleted = _safeCount(`
      SELECT COUNT(*) as cnt FROM daily_learning_progress
      WHERE user_id = ? AND status='completed' AND DATE(completed_at) BETWEEN ? AND ?
    `, userId, monStr, sunStr);
  } catch {}

  // 담은 자료
  let collectionCount = 0;
  try {
    collectionCount = _safeCount('SELECT COUNT(*) as cnt FROM content_collections WHERE user_id = ?', userId);
  } catch {}

  // 총 포인트
  const totalPoints = (() => {
    try { return db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM user_points WHERE user_id = ?').get(userId).total || 0; } catch { return 0; }
  })();

  return {
    classCount,
    todayDueHw,
    pendingHomework: Math.max(0, pendingHomework),
    pendingExams,
    unreadNotices,
    unreadNotifications,
    dailyLearning: { total: dailyProgress.total || 0, completed: dailyProgress.completed || 0 },
    weekCompleted,
    collectionCount,
    totalPoints
  };
}

function _teacherSummary(userId) {
  // 내가 만든 클래스
  const ownedClassIds = db.prepare("SELECT id FROM classes WHERE owner_id = ? AND status = 'active'").all(userId).map(r => r.id);
  const classCount = ownedClassIds.length;

  // 미채점 과제 (ungraded)
  let ungraded = 0;
  if (ownedClassIds.length > 0) {
    const ph = ownedClassIds.map(() => '?').join(',');
    try {
      ungraded = _safeCount(`
        SELECT COUNT(*) as cnt FROM homework_submissions hs
        JOIN homework h ON hs.homework_id = h.id
        WHERE h.class_id IN (${ph})
          AND hs.status = 'submitted'
      `, ...ownedClassIds);
    } catch {}
  }

  // 승인 대기 (pendingApprovals): 가입 신청 + 갤러리 신고/대기
  let pendingApprovals = 0;
  if (ownedClassIds.length > 0) {
    const ph = ownedClassIds.map(() => '?').join(',');
    // 가입 invited 상태
    pendingApprovals += _safeCount(`SELECT COUNT(*) as cnt FROM class_members WHERE class_id IN (${ph}) AND status = 'invited'`, ...ownedClassIds);
    // 갤러리 신고 pending (전역 — 교사가 처리할 신고)
    try {
      pendingApprovals += _safeCount("SELECT COUNT(*) as cnt FROM gallery_reports WHERE status = 'pending'");
    } catch {}
  }

  // 마감 임박 평가 (examsDueSoon): 본인 소유, 향후 7일 내 마감
  let examsDueSoon = 0;
  try {
    examsDueSoon = _safeCount(`
      SELECT COUNT(*) as cnt FROM exams
      WHERE owner_id = ?
        AND status IN ('active','waiting','published')
        AND end_date IS NOT NULL
        AND DATE(end_date) BETWEEN DATE('now') AND DATE('now', '+7 days')
    `, userId);
  } catch {}

  // 오늘 수업 (todayLessons): 본인 클래스에서 오늘 날짜의 published 수업
  let todayLessons = 0;
  if (ownedClassIds.length > 0) {
    const ph = ownedClassIds.map(() => '?').join(',');
    todayLessons = _safeCount(`
      SELECT COUNT(*) as cnt FROM lessons
      WHERE class_id IN (${ph}) AND status = 'published' AND DATE(lesson_date) = DATE('now')
    `, ...ownedClassIds);
  }

  // 미제출 학생 명단 수 (missingSubs): 마감일 지난/오늘 마감 과제 미제출 합계
  let missingSubs = 0;
  if (ownedClassIds.length > 0) {
    const ph = ownedClassIds.map(() => '?').join(',');
    try {
      const hwList = db.prepare(`
        SELECT id, class_id FROM homework
        WHERE class_id IN (${ph}) AND status = 'published'
          AND DATE(due_date) <= DATE('now', '+1 day')
      `).all(...ownedClassIds);
      for (const hw of hwList) {
        const total = _safeCount(`SELECT COUNT(*) as cnt FROM class_members WHERE class_id = ? AND status='active' AND role='member'`, hw.class_id);
        const submitted = _safeCount(`SELECT COUNT(*) as cnt FROM homework_submissions WHERE homework_id = ?`, hw.id);
        missingSubs += Math.max(0, total - submitted);
      }
    } catch {}
  }

  // 학생용 공통 필드도 포함 (대시보드 호환성)
  const unreadNotifications = _safeCount('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0', userId);

  return {
    classCount,
    ungraded,
    pendingApprovals,
    examsDueSoon,
    todayLessons,
    missingSubs,
    unreadNotifications
  };
}

function _parentSummary(userId) {
  const childIds = _getChildIds(userId);
  const childrenCount = childIds.length;

  // 자녀 합산 미제출 과제 (todayDueHw — 학부모 시각: 자녀 미제출 과제 N건 — 향후 마감 분 통합)
  let todayDueHw = 0;
  let unconfirmedContents = 0;
  if (childIds.length > 0) {
    for (const cid of childIds) {
      const ccls = db.prepare('SELECT class_id FROM class_members WHERE user_id = ? AND status = ?').all(cid, 'active').map(r => r.class_id);
      if (ccls.length > 0) {
        const ph = ccls.map(() => '?').join(',');
        const hwIds = db.prepare(`SELECT id FROM homework WHERE class_id IN (${ph}) AND status = 'published' AND DATE(due_date) >= DATE('now')`).all(...ccls).map(r => r.id);
        if (hwIds.length > 0) {
          const hp = hwIds.map(() => '?').join(',');
          const sub = _safeCount(`SELECT COUNT(*) as cnt FROM homework_submissions WHERE homework_id IN (${hp}) AND student_id = ?`, ...hwIds, cid);
          todayDueHw += Math.max(0, hwIds.length - sub);
        }
      }
      // 미확인 콘텐츠 (자녀 새 알림장)
      const cclsIds = ccls;
      if (cclsIds.length > 0) {
        const ph = cclsIds.map(() => '?').join(',');
        unconfirmedContents += _safeCount(`
          SELECT COUNT(*) as cnt FROM notices n
          WHERE n.class_id IN (${ph})
            AND NOT EXISTS (SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = ?)
        `, ...cclsIds, cid);
      }
    }
  }

  // 자녀 출결 (childAttendance): 오늘 자녀 출석 상태 요약
  let childAttendance = { total: childrenCount, present: 0, absent: 0, late: 0 };
  if (childIds.length > 0) {
    for (const cid of childIds) {
      try {
        const att = db.prepare(`
          SELECT status FROM attendance
          WHERE user_id = ? AND attendance_date = DATE('now')
          ORDER BY checked_at DESC LIMIT 1
        `).get(cid);
        if (att) {
          if (att.status === 'present') childAttendance.present++;
          else if (att.status === 'absent') childAttendance.absent++;
          else if (att.status === 'late') childAttendance.late++;
        }
      } catch {}
    }
  }

  // 새 교사 메시지 (unreadTeacherMsgs): messages 중 읽지 않음 + 발신자 role=teacher
  let unreadTeacherMsgs = 0;
  try {
    unreadTeacherMsgs = _safeCount(`
      SELECT COUNT(*) as cnt FROM messages m
      JOIN message_room_members mrm ON m.room_id = mrm.room_id AND mrm.user_id = ?
      JOIN users u ON m.sender_id = u.id
      WHERE m.is_read = 0 AND m.sender_id != ? AND u.role = 'teacher'
    `, userId, userId);
  } catch {}

  // 시스템 알림
  const unreadNotifications = _safeCount('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0', userId);

  return {
    childrenCount,
    childIds,
    todayDueHw,
    childAttendance,
    unreadTeacherMsgs,
    unconfirmedContents,
    unreadNotifications
  };
}

function _staffSummary(userId) {
  // 미확인 공지 (unreadNotices) — 본인이 속한 클래스/전역 공지 중 미열람
  const classIds = db.prepare('SELECT class_id FROM class_members WHERE user_id = ? AND status = ?').all(userId, 'active').map(r => r.class_id);
  let unreadNotices = 0;
  if (classIds.length > 0) {
    const ph = classIds.map(() => '?').join(',');
    unreadNotices = _safeCount(`
      SELECT COUNT(*) as cnt FROM notices n
      WHERE n.class_id IN (${ph})
        AND NOT EXISTS (SELECT 1 FROM notice_reads nr WHERE nr.notice_id = n.id AND nr.user_id = ?)
    `, ...classIds, userId);
  }

  // 이번 주 학사 일정 (weeklyEvents): 향후 7일간 lessons/homework/exams/surveys 합계
  let weeklyEvents = 0;
  try {
    if (classIds.length > 0) {
      const ph = classIds.map(() => '?').join(',');
      weeklyEvents += _safeCount(`SELECT COUNT(*) as cnt FROM lessons WHERE class_id IN (${ph}) AND DATE(lesson_date) BETWEEN DATE('now') AND DATE('now','+7 days') AND status='published'`, ...classIds);
      weeklyEvents += _safeCount(`SELECT COUNT(*) as cnt FROM homework WHERE class_id IN (${ph}) AND DATE(due_date) BETWEEN DATE('now') AND DATE('now','+7 days') AND status='published'`, ...classIds);
    }
  } catch {}

  // 멤버 합계 (memberTotal): 전체 활성 사용자 수 (학교 단위 운영 통계)
  const memberTotal = _safeCount("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'");

  // 결재 대기 (pendingApprovals): 운영 클래스 가입 대기 + 콘텐츠 pending
  let pendingApprovals = 0;
  // 본인이 운영하는 클래스
  const ownedClassIds = db.prepare("SELECT id FROM classes WHERE owner_id = ? AND status = 'active'").all(userId).map(r => r.id);
  if (ownedClassIds.length > 0) {
    const ph = ownedClassIds.map(() => '?').join(',');
    pendingApprovals += _safeCount(`SELECT COUNT(*) as cnt FROM class_members WHERE class_id IN (${ph}) AND status = 'invited'`, ...ownedClassIds);
  }
  try {
    pendingApprovals += _safeCount("SELECT COUNT(*) as cnt FROM contents WHERE status IN ('pending','review')");
  } catch {}

  const ownedClassCount = ownedClassIds.length;
  const unreadNotifications = _safeCount('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0', userId);

  return {
    unreadNotices,
    weeklyEvents,
    memberTotal,
    pendingApprovals,
    ownedClassCount,
    unreadNotifications
  };
}

function _adminSummary(userId) {
  const totalUsers = _safeCount("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'");
  const classCount = _safeCount("SELECT COUNT(*) as cnt FROM classes WHERE status = 'active'");
  // 오늘 활동 로그
  let logToday = 0;
  try {
    logToday = _safeCount("SELECT COUNT(*) as cnt FROM learning_logs WHERE DATE(created_at) = DATE('now')");
  } catch {}
  // 결재/승인 합산
  let pendingTotal = 0;
  try {
    pendingTotal += _safeCount("SELECT COUNT(*) as cnt FROM contents WHERE status IN ('pending','review')");
  } catch {}
  try {
    pendingTotal += _safeCount("SELECT COUNT(*) as cnt FROM gallery_reports WHERE status = 'pending'");
  } catch {}
  pendingTotal += _safeCount("SELECT COUNT(*) as cnt FROM class_members WHERE status = 'invited'");

  // 시스템 알림 (admin 전용 알림 — notifications 중 type='system' 또는 본인 미열람)
  const systemAlerts = _safeCount('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0', userId);

  return {
    totalUsers,
    classCount,
    logToday,
    pendingTotal,
    systemAlerts
  };
}

function getMyDashboardSummary(userId) {
  const role = _getUserRole(userId);
  let summary = {};
  if (role === 'teacher') summary = _teacherSummary(userId);
  else if (role === 'parent') summary = _parentSummary(userId);
  else if (role === 'staff') summary = _staffSummary(userId);
  else if (role === 'admin') summary = _adminSummary(userId);
  else summary = _studentSummary(userId);

  // 호환성: 학생 키들도 항상 포함 (기존 my-summary 사용처 보존)
  if (role !== 'student') {
    // 다른 역할이라도 일부 공통 키(classCount/unreadNotifications/dailyLearning/totalPoints)를 채워둠
    if (summary.classCount === undefined) {
      summary.classCount = _safeCount('SELECT COUNT(*) as cnt FROM class_members WHERE user_id = ? AND status = ?', userId, 'active');
    }
    if (summary.unreadNotifications === undefined) {
      summary.unreadNotifications = _safeCount('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0', userId);
    }
  }

  return { role, summary, ...summary };
}

// ====================================================================
// "오늘 할 일" 카드용 데이터 (포털 메인 재설계 4.2.1)
// ====================================================================
function getTodayAction(userId, requestedRole) {
  const role = requestedRole || _getUserRole(userId);
  const items = [];
  const empty = (msg) => ({ items, role, message: msg });

  if (role === 'student') {
    const s = _studentSummary(userId);
    if (s.todayDueHw > 0) {
      items.push({ label: '오늘 마감 과제', count: s.todayDueHw, href: '/class/index.html?filter=due', severity: 'urgent' });
    }
    if (s.pendingExams > 0) {
      items.push({ label: '미응시 평가', count: s.pendingExams, href: '/cbt/index.html?filter=pending', severity: 'warning' });
    }
    if (s.unreadNotices > 0) {
      items.push({ label: '새 알림장', count: s.unreadNotices, href: '/class/index.html?tab=notice', severity: 'info' });
    }
    if (s.unreadNotifications > 0 && items.length < 3) {
      items.push({ label: '새 알림', count: s.unreadNotifications, href: '/notifications.html', severity: 'info' });
    }
    if (items.length === 0) return empty('오늘 할 일이 없어요! 여유 있게 활동을 즐겨보세요 🎉');
    return { items: items.slice(0, 3), role };
  }

  if (role === 'teacher') {
    const t = _teacherSummary(userId);
    if (t.ungraded > 0) {
      items.push({ label: '미채점 과제', count: t.ungraded, href: '/class/index.html?filter=ungraded', severity: 'urgent' });
    }
    if (t.pendingApprovals > 0) {
      items.push({ label: '승인 대기', count: t.pendingApprovals, href: '/class/index.html?filter=pending', severity: 'warning' });
    }
    if (t.examsDueSoon > 0) {
      items.push({ label: '마감 임박 평가', count: t.examsDueSoon, href: '/cbt/index.html?filter=upcoming', severity: 'warning' });
    }
    if (t.todayLessons > 0 && items.length < 3) {
      items.push({ label: '오늘 수업', count: t.todayLessons, href: '/class/index.html?filter=today', severity: 'info' });
    }
    if (items.length === 0) return empty('오늘 할 일이 없어요! 모든 채점·승인을 완료하셨습니다 👍');
    return { items: items.slice(0, 3), role };
  }

  if (role === 'parent') {
    const p = _parentSummary(userId);
    if (p.todayDueHw > 0) {
      items.push({ label: '자녀 미제출 과제', count: p.todayDueHw, href: '/class/index.html?role=parent&filter=overdue', severity: 'urgent' });
    }
    if (p.childAttendance && p.childAttendance.absent > 0) {
      items.push({ label: '자녀 결석', count: p.childAttendance.absent, href: '/growth/index.html?tab=attendance', severity: 'urgent' });
    }
    if (p.unreadTeacherMsgs > 0) {
      items.push({ label: '새 교사 메시지', count: p.unreadTeacherMsgs, href: '/message/index.html', severity: 'warning' });
    }
    if (p.unconfirmedContents > 0 && items.length < 3) {
      items.push({ label: '새 알림장', count: p.unconfirmedContents, href: '/class/index.html?role=parent&tab=notice', severity: 'info' });
    }
    if (items.length === 0) return empty('자녀 모두 잘 지내고 있어요. 평안한 하루 되세요 😊');
    return { items: items.slice(0, 3), role };
  }

  if (role === 'staff') {
    const st = _staffSummary(userId);
    if (st.unreadNotices > 0) {
      items.push({ label: '미확인 공지', count: st.unreadNotices, href: '/notice', severity: 'urgent' });
    }
    if (st.weeklyEvents > 0) {
      items.push({ label: '이번 주 학사 일정', count: st.weeklyEvents, href: '/calendar?role=staff', severity: 'info' });
    }
    if (st.pendingApprovals > 0) {
      items.push({ label: '결재 대기', count: st.pendingApprovals, href: '/admin/approval', severity: 'warning' });
    }
    if (items.length === 0) return empty('오늘은 처리할 학사가 없어요!');
    return { items: items.slice(0, 3), role };
  }

  if (role === 'admin') {
    const a = _adminSummary(userId);
    if (a.pendingTotal > 0) {
      items.push({ label: '미승인 항목', count: a.pendingTotal, href: '/admin/approval', severity: 'urgent' });
    }
    if (a.systemAlerts > 0) {
      items.push({ label: '시스템 알림', count: a.systemAlerts, href: '/admin/notifications', severity: 'warning' });
    }
    // 오늘 가입한 사용자
    const todayJoin = _safeCount("SELECT COUNT(*) as cnt FROM users WHERE DATE(created_at) = DATE('now')");
    if (todayJoin > 0) {
      items.push({ label: '오늘 가입자', count: todayJoin, href: '/admin/users', severity: 'info' });
    }
    if (items.length === 0) return empty('오늘은 운영 알림이 없어요!');
    return { items: items.slice(0, 3), role };
  }

  return empty('오늘 할 일이 없어요!');
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

module.exports = {
  getHallOfFame,
  getCalendarEvents,
  getTrendingPosts,
  getMyDashboardSummary,
  getRecentActivities,
  getTodayAction
};
