// db/growth-extended.js
const db = require('./index');

// 서비스 미제공 영역 — 실제 데이터가 없을 때만 점수 0 처리 (데이터가 있으면 정상 표시)
const NO_SERVICE_AREAS = [];

// ========== 포트폴리오 아카이브 ==========

function getPortfolioItems(userId, { grade, subject, type, keyword, lifeTaskOnly, page = 1, limit = 20 } = {}) {
  let where = 'WHERE pi.user_id = ?';
  const params = [userId];
  if (grade) { where += ' AND pi.grade_year = ?'; params.push(grade); }
  if (subject) { where += ' AND pi.subject = ?'; params.push(subject); }
  if (type) { where += ' AND pi.source_type = ?'; params.push(type); }
  if (keyword) { where += ' AND (pi.activity_name LIKE ? OR pi.subject LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (lifeTaskOnly) { where += ' AND pi.is_life_task = 1'; }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM portfolio_items pi ${where}`).get(...params).cnt;
  const items = db.prepare(`
    SELECT pi.* FROM portfolio_items pi ${where}
    ORDER BY pi.activity_date DESC, pi.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  items.forEach(item => {
    if (item.competency_tags) { try { item.competency_tags = JSON.parse(item.competency_tags); } catch { item.competency_tags = []; } }
  });

  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

function getPortfolioItemDetail(id) {
  const item = db.prepare('SELECT * FROM portfolio_items WHERE id = ?').get(id);
  if (!item) return null;
  if (item.competency_tags) { try { item.competency_tags = JSON.parse(item.competency_tags); } catch { item.competency_tags = []; } }
  const attachments = db.prepare('SELECT * FROM portfolio_attachments WHERE portfolio_item_id = ?').all(id);
  return { item, attachments };
}

function toggleLifeTask(id, userId) {
  const item = db.prepare('SELECT is_life_task FROM portfolio_items WHERE id = ? AND user_id = ?').get(id, userId);
  if (!item) return null;
  const newVal = item.is_life_task ? 0 : 1;
  db.prepare('UPDATE portfolio_items SET is_life_task = ? WHERE id = ?').run(newVal, id);
  return { isLifeTask: !!newVal };
}

function saveReflection(id, userId, { reflection, competencyTags }) {
  db.prepare('UPDATE portfolio_items SET reflection = ?, competency_tags = ? WHERE id = ? AND user_id = ?')
    .run(reflection || null, competencyTags ? JSON.stringify(competencyTags) : null, id, userId);
}

function updatePrivacy(id, userId, isPublic) {
  db.prepare('UPDATE portfolio_items SET is_public = ? WHERE id = ? AND user_id = ?').run(isPublic ? 1 : 0, id, userId);
}

function getPortfolioStats(userId) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ?').get(userId).cnt;
  const lifeTaskCount = db.prepare('SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? AND is_life_task = 1').get(userId).cnt;
  const reflectionCount = db.prepare("SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? AND reflection IS NOT NULL AND reflection != ''").get(userId).cnt;
  const goalCount = db.prepare('SELECT COUNT(*) as cnt FROM growth_goals WHERE user_id = ?').get(userId).cnt;
  const bySubject = db.prepare('SELECT subject, COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? AND subject IS NOT NULL GROUP BY subject').all(userId);
  const byType = db.prepare('SELECT source_type, COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? GROUP BY source_type').all(userId);
  return { total, lifeTaskCount, reflectionCount, goalCount, bySubject, byType };
}

function getGrowthGoals(userId) {
  return db.prepare('SELECT * FROM growth_goals WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function createGrowthGoal(userId, data) {
  const goalType = data.goalType || data.area || 'general';
  const targetCount = data.targetCount || 10;
  const periodLabel = data.periodLabel || data.title || null;
  const info = db.prepare(`
    INSERT INTO growth_goals (user_id, goal_type, target_count, period, period_label)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, goalType, targetCount, data.period || 'semester', periodLabel);
  return { id: info.lastInsertRowid };
}

function updateGrowthGoalProgress(id, delta) {
  db.prepare('UPDATE growth_goals SET current_count = current_count + ? WHERE id = ?').run(delta, id);
}

// ========== 포트폴리오 자동 추가 ==========

function autoAddPortfolioItem(userId, logData) {
  // 이미 같은 source_id로 등록된 항목이 있으면 중복 방지
  const existing = db.prepare(
    'SELECT id FROM portfolio_items WHERE user_id = ? AND source_type = ? AND source_id = ?'
  ).get(userId, logData.source_service || 'learning', logData.id);
  if (existing) return;

  db.prepare(`
    INSERT INTO portfolio_items
    (user_id, source_type, source_id, class_id, activity_name, subject,
     activity_date, score, result_type, activity_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    userId,
    logData.source_service || 'learning',
    logData.id,
    logData.class_id || null,
    logData.activity_name || logData.object_type || '학습 활동',
    logData.subject || null,
    new Date().toISOString().split('T')[0],
    logData.result_score != null ? String(logData.result_score) : null,
    logData.result_success ? 'completed' : 'attempted',
    logData.activity_type || 'activity'
  );
}

// ========== 성장보고서 6대 영역 ==========

function getClassDashboard(classId, teacherId, { period, startDate, endDate } = {}) {
  // 클래스 정보
  const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(classId);
  const className = cls ? cls.name : '';

  const members = db.prepare(`
    SELECT u.id, u.display_name, u.grade, u.class_number,
      (SELECT COUNT(*) FROM attendance WHERE class_id = ? AND user_id = u.id AND status = 'present') as attendance_count,
      (SELECT COUNT(*) FROM learning_logs WHERE class_id = ? AND user_id = u.id) as activity_count,
      (SELECT emotion FROM attendance WHERE class_id = ? AND user_id = u.id ORDER BY attendance_date DESC LIMIT 1) as latest_emotion
    FROM class_members cm JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.role = 'member'
    ORDER BY u.display_name
  `).all(classId, classId, classId, classId);

  // 각 학생의 6대 영역 점수 계산
  const students = members.map(m => {
    const report = getStudentReport(m.id, { classId, startDate, endDate });
    return {
      id: m.id,
      studentId: m.id,
      display_name: m.display_name,
      studentName: m.display_name,
      grade: m.grade,
      class_number: m.class_number,
      attendance_count: m.attendance_count,
      activity_count: m.activity_count,
      latest_emotion: m.latest_emotion,
      averageScore: report.overallScore,
      areas: report.areas
    };
  });

  // 클래스 전체 평균 계산
  const studentCount = students.length;
  const avgScore = studentCount > 0 ? students.reduce((s, st) => s + (st.averageScore || 0), 0) / studentCount : 0;

  // 영역별 평균
  const areaNames = ['정서발달', '기초학력', '학습역량', '오늘의학습', '독서활동', '진로탐색'];
  const areas = {};
  areaNames.forEach(name => {
    const scores = students.map(s => s.areas?.[name]?.score ?? 0);
    const hasDataCount = students.filter(s => s.areas?.[name]?.hasData !== false).length;
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const completed = scores.filter(s => s > 0).length;
    areas[name] = {
      averageScore: Math.round(avg),
      completionRate: studentCount > 0 ? Math.round(completed / studentCount * 100) : 0,
      hasData: hasDataCount > 0
    };
  });

  // 서비스 미제공 영역 강제 0점 처리
  NO_SERVICE_AREAS.forEach(name => {
    if (areas[name]) {
      areas[name].averageScore = 0;
      areas[name].completionRate = 0;
      areas[name].hasData = false;
    }
  });

  // 완료율 (활동이 1건 이상인 학생 비율)
  const activeStudents = students.filter(s => s.activity_count > 0).length;
  const completionRate = studentCount > 0 ? Math.round(activeStudents / studentCount * 100) : 0;

  // 관찰 기록 수
  const obsCount = db.prepare('SELECT COUNT(*) as cnt FROM teacher_observations WHERE class_id = ?').get(classId)?.cnt || 0;

  // 관심 필요 학생 (클래스 평균 대비 상대 기준)
  const avgActivity = studentCount > 0
    ? students.reduce((s, st) => s + st.activity_count, 0) / studentCount
    : 0;

  const attentionStudents = students.filter(s => {
    // 조건 1: 클래스 평균의 30% 이하 활동 (또는 3건 미만 중 작은 값)
    if (s.activity_count < Math.min(avgActivity * 0.3, 3)) return true;
    // 조건 2: 최근 부정 감정
    if (s.latest_emotion === 'sad' || s.latest_emotion === 'angry') return true;
    // 조건 3: 클래스 평균의 50% 미만 점수
    if (s.averageScore != null && s.averageScore < avgScore * 0.5) return true;
    return false;
  }).map(s => {
    let reason = '';
    let severity = 'medium';
    if (s.latest_emotion === 'sad' || s.latest_emotion === 'angry') {
      reason = '최근 감정 상태 주의';
      severity = 'high';
    } else if (s.averageScore != null && s.averageScore < avgScore * 0.5) {
      reason = '성장 점수 저조';
      severity = 'high';
    } else {
      reason = '학습 활동 부족';
    }
    return { studentId: s.id, studentName: s.display_name, level: severity === 'high' ? 'danger' : 'warning', message: reason, severity };
  });

  // 클래스 전체 콘텐츠 활용 통계
  const memberIds = members.map(m => m.id);
  let contentUsage = { byType: [], byService: [], totalActivities: 0, uniqueContents: 0 };
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => '?').join(',');
    contentUsage.byType = db.prepare(`
      SELECT activity_type, COUNT(*) as cnt, AVG(CAST(result_score AS REAL)) as avg_score
      FROM learning_logs WHERE user_id IN (${placeholders})
      GROUP BY activity_type ORDER BY cnt DESC
    `).all(...memberIds);
    contentUsage.byService = db.prepare(`
      SELECT source_service, COUNT(*) as cnt
      FROM learning_logs WHERE user_id IN (${placeholders}) AND source_service IS NOT NULL AND source_service != ''
      GROUP BY source_service ORDER BY cnt DESC
    `).all(...memberIds);
    const totals = db.prepare(`
      SELECT COUNT(*) as total, COUNT(DISTINCT object_id) as unique_contents
      FROM learning_logs WHERE user_id IN (${placeholders})
    `).get(...memberIds);
    contentUsage.totalActivities = totals?.total || 0;
    contentUsage.uniqueContents = totals?.unique_contents || 0;
  }

  // 요일별 감정 통계 (실제 attendance 데이터 기반)
  let emotionDateFilter = '';
  const emotionDateParams = [classId];
  if (startDate && endDate) {
    emotionDateFilter = ' AND attendance_date BETWEEN ? AND ?';
    emotionDateParams.push(startDate, endDate);
  }
  const weekdayEmotionRows = db.prepare(`
    SELECT CAST(strftime('%w', attendance_date) AS INTEGER) as weekday,
      COUNT(*) as total,
      SUM(CASE WHEN emotion IN ('happy','excited','good','great','calm') THEN 1 ELSE 0 END) as positive_count
    FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${emotionDateFilter}
    GROUP BY weekday ORDER BY weekday
  `).all(...emotionDateParams);
  const weekdayPositiveRates = [0, 0, 0, 0, 0]; // 월~금
  weekdayEmotionRows.forEach(w => {
    const idx = w.weekday - 1;
    if (idx >= 0 && idx < 5 && w.total > 0) {
      weekdayPositiveRates[idx] = Math.round(w.positive_count / w.total * 100);
    }
  });

  // 감정별 전체 통계
  const emotionCounts = db.prepare(`
    SELECT emotion, COUNT(*) as cnt FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${emotionDateFilter}
    GROUP BY emotion ORDER BY cnt DESC
  `).all(...emotionDateParams);

  return {
    className,
    studentCount,
    averageScore: Math.round(avgScore),
    completionRate,
    observationCount: obsCount,
    areas,
    students,
    attentionStudents,
    alerts: attentionStudents,
    contentUsage,
    emotionStats: { weekdayPositiveRates, emotionCounts }
  };
}

function getStudentReport(studentId, { classId, startDate, endDate } = {}) {
  // 파라미터화된 쿼리로 SQL Injection 방지
  const dateParams = [];
  let dateFilter = '';
  let attDateFilter = '';
  if (startDate && endDate) {
    dateFilter = ' AND created_at BETWEEN ? AND ?';
    attDateFilter = ' AND attendance_date BETWEEN ? AND ?';
    dateParams.push(startDate, endDate);
  }

  // 학생 정보 조회
  const student = db.prepare('SELECT id, display_name, username, role FROM users WHERE id = ?').get(studentId);
  const studentName = student ? student.display_name : '학생';

  // 클래스 정보
  let className = '';
  if (classId) {
    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(classId);
    if (cls) className = cls.name;
  }

  // 1. 정서발달: 감정 비율
  const emotionParams = [studentId];
  let emotionWhere = 'WHERE user_id = ?';
  if (classId) { emotionWhere += ' AND class_id = ?'; emotionParams.push(classId); }
  emotionWhere += ' AND emotion IS NOT NULL';
  if (startDate && endDate) { emotionWhere += ' AND attendance_date BETWEEN ? AND ?'; emotionParams.push(startDate, endDate); }
  const emotions = db.prepare(`SELECT emotion, COUNT(*) as cnt FROM attendance ${emotionWhere} GROUP BY emotion`).all(...emotionParams);

  // 2. 기초학력: 진단 결과
  const diagDateFilter = startDate && endDate ? ' AND completed_at BETWEEN ? AND ?' : '';
  const diagParams = [studentId, ...dateParams];
  const diagnoses = db.prepare(`
    SELECT target_node_id, result, correct_count, total_questions
    FROM diagnosis_sessions WHERE user_id = ? AND status = 'completed' ${diagDateFilter}
    ORDER BY completed_at DESC LIMIT 10
  `).all(...diagParams);

  // 3. 학습역량: 학습 로그 통계
  const learnParams = [studentId, ...dateParams];
  const learningStats = db.prepare(`
    SELECT activity_type, COUNT(*) as cnt,
      AVG(CAST(result_score AS REAL)) as avg_score
    FROM learning_logs WHERE user_id = ? ${dateFilter}
    GROUP BY activity_type
  `).all(...learnParams);

  // 4. 오늘의학습: 완료율 + 연속일 + 최근 7일 현황 + 평균 정답률
  const dailyDateFilter = startDate && endDate ? ' AND completed_at BETWEEN ? AND ?' : '';
  const dailyParams = [studentId, ...dateParams];
  const dailyStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'completed' THEN COALESCE(correct_count, 0) ELSE 0 END) as totalCorrect,
      SUM(CASE WHEN status = 'completed' THEN COALESCE(total_questions, 0) ELSE 0 END) as totalQuestions
    FROM daily_learning_progress WHERE user_id = ? ${dailyDateFilter}
  `).get(...dailyParams);
  // 평균 정답률 계산: 누적 정답 수 / 누적 문항 수 (score가 0~1 또는 0~100인 경우 모두 안전)
  if (dailyStats) {
    if (dailyStats.totalQuestions > 0) {
      dailyStats.avgAccuracy = Math.round((dailyStats.totalCorrect / dailyStats.totalQuestions) * 100);
    } else {
      // fallback: score 컬럼 평균 (score가 0~1 범위라 가정)
      const scoreRow = db.prepare(`
        SELECT AVG(CAST(score AS REAL)) as avgScore, COUNT(*) as cnt
        FROM daily_learning_progress WHERE user_id = ? AND status = 'completed' AND score IS NOT NULL ${dailyDateFilter}
      `).get(...dailyParams);
      if (scoreRow && scoreRow.cnt > 0 && scoreRow.avgScore != null) {
        const avg = scoreRow.avgScore;
        dailyStats.avgAccuracy = Math.round(avg <= 1 ? avg * 100 : avg);
      } else {
        dailyStats.avgAccuracy = null;
      }
    }
  }

  // 최근 7일 완료 날짜 조회 (연속일 및 캘린더 계산용)
  const recentDailyDays = db.prepare(`
    SELECT DISTINCT DATE(completed_at) as day
    FROM daily_learning_progress
    WHERE user_id = ? AND status = 'completed'
    ORDER BY day DESC LIMIT 30
  `).all(studentId).map(r => r.day);

  // 연속일 계산
  let maxStreak = 0, currentStreak = 0;
  if (recentDailyDays.length > 0) {
    currentStreak = 1;
    for (let i = 1; i < recentDailyDays.length; i++) {
      const prev = new Date(recentDailyDays[i - 1]);
      const curr = new Date(recentDailyDays[i]);
      const diff = (prev - curr) / (1000 * 60 * 60 * 24);
      if (diff === 1) { currentStreak++; }
      else { maxStreak = Math.max(maxStreak, currentStreak); currentStreak = 1; }
    }
    maxStreak = Math.max(maxStreak, currentStreak);
  }
  if (dailyStats) {
    dailyStats.maxStreak = maxStreak;
    dailyStats.recentDays = recentDailyDays.slice(0, 7);
  }

  // 5. 독서활동
  const readParams = [studentId, ...dateParams];
  const readingLogs = db.prepare(`
    SELECT * FROM reading_logs WHERE user_id = ? ${dateFilter} ORDER BY read_date DESC
  `).all(...readParams);

  // 6. 진로탐색: career_logs 전용 데이터만 사용
  const careerLogParams = [studentId, ...dateParams];
  let careerLogDateFilter = dateFilter.replace('created_at', 'activity_date');
  const careerLogs = db.prepare(`
    SELECT * FROM career_logs WHERE user_id = ? ${careerLogDateFilter} ORDER BY activity_date DESC
  `).all(...careerLogParams);

  // 진로 관심 분야 (career_logs의 interest_area 기반)
  const careerInterests = db.prepare(`
    SELECT interest_area, COUNT(*) as cnt FROM career_logs
    WHERE user_id = ? AND interest_area IS NOT NULL AND interest_area != '' ${careerLogDateFilter}
    GROUP BY interest_area ORDER BY cnt DESC
  `).all(...careerLogParams);

  // 7. 콘텐츠 활용 현황
  // 내가 담은 콘텐츠 (보관함)
  const savedContents = db.prepare(`
    SELECT COUNT(*) as cnt FROM content_collections WHERE user_id = ?
  `).get(studentId)?.cnt || 0;

  // 조회 콘텐츠 (content_view 활동)
  const viewedContents = db.prepare(`
    SELECT COUNT(DISTINCT object_id) as cnt FROM learning_logs WHERE user_id = ? AND activity_type = 'content_view' ${dateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 좋아요 (내가 올린 콘텐츠의 총 좋아요 수)
  const totalLikes = db.prepare(`
    SELECT COALESCE(SUM(like_count), 0) as cnt FROM contents WHERE creator_id = ?
  `).get(studentId)?.cnt || 0;

  // 내가 올린 콘텐츠
  const uploadedContents = db.prepare(`
    SELECT COUNT(*) as cnt FROM contents WHERE creator_id = ?
  `).get(studentId)?.cnt || 0;

  // 채널 구독자 수
  const subscriberCount = db.prepare(`
    SELECT COALESCE(SUM(subscriber_count), 0) as cnt FROM channels WHERE user_id = ?
  `).get(studentId)?.cnt || 0;

  // 내가 구독한 수
  const mySubscriptions = db.prepare(`
    SELECT COUNT(*) as cnt FROM channel_subscriptions WHERE subscriber_id = ?
  `).get(studentId)?.cnt || 0;

  // 자주 조회한 콘텐츠 (learning_logs의 object_type에서 추출)
  const searchKeywords = db.prepare(`
    SELECT COALESCE(object_type, '기타') as keyword, COUNT(*) as cnt
    FROM learning_logs WHERE user_id = ? AND activity_type = 'content_view' AND object_type IS NOT NULL AND object_type != '' ${dateFilter}
    GROUP BY object_type ORDER BY cnt DESC LIMIT 10
  `).all(studentId, ...dateParams);

  // 성취기준 (학습한 성취기준)
  const achievementStandards = db.prepare(`
    SELECT achievement_code as code, COUNT(*) as cnt
    FROM learning_logs WHERE user_id = ? AND achievement_code IS NOT NULL AND achievement_code != '' ${dateFilter}
    GROUP BY achievement_code ORDER BY cnt DESC LIMIT 10
  `).all(studentId, ...dateParams);

  // 포트폴리오 항목 수
  const portfolioCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ?
  `).get(studentId)?.cnt || 0;

  // 선생님 관찰 기록
  const observations = classId
    ? db.prepare('SELECT * FROM teacher_observations WHERE student_id = ? AND class_id = ? ORDER BY observation_date DESC').all(studentId, classId)
    : db.prepare('SELECT * FROM teacher_observations WHERE student_id = ? ORDER BY observation_date DESC').all(studentId);

  // 영역별 점수 계산
  const emotionTotal = emotions.reduce((s, e) => s + e.cnt, 0);
  const positiveEmotions = emotions.filter(e => ['happy', 'excited', 'good', 'great', 'calm'].includes(e.emotion));
  const positiveRatio = emotionTotal > 0 ? positiveEmotions.reduce((s, e) => s + e.cnt, 0) / emotionTotal * 100 : 0;

  const diagAvg = diagnoses.length > 0
    ? diagnoses.reduce((s, d) => s + (d.correct_count && d.total_questions ? d.correct_count / d.total_questions * 100 : 0), 0) / diagnoses.length
    : 0;

  const learnAvg = learningStats.length > 0
    ? learningStats.reduce((s, l) => s + (l.avg_score ? l.avg_score * 100 : 0), 0) / learningStats.length
    : 0;

  const dailyRate = dailyStats && dailyStats.total > 0
    ? (dailyStats.completed / dailyStats.total) * 100
    : 0;

  // 독서활동: 구간별 점수화
  const bookCount = readingLogs.length;
  const readingScore = bookCount === 0 ? 0 :
    bookCount <= 2 ? bookCount * 20 :       // 0-2권: 0, 20, 40
    bookCount <= 5 ? 40 + (bookCount - 2) * 15 : // 3-5권: 55, 70, 85
    Math.min(85 + (bookCount - 5) * 5, 100);     // 6권+: 90, 95, 100

  // 진로탐색: career_logs 기반 점수 (관심분야 다양성 + 활동 수)
  const careerLogCount = careerLogs.length;
  const interestAreaCount = careerInterests.length;
  const careerScore = Math.min(
    interestAreaCount * 20 + careerLogCount * 15,
    100
  );

  const dailyTotal = dailyStats ? dailyStats.total : 0;

  const areas = {
    '정서발달': { score: Math.round(positiveRatio), hasData: emotionTotal > 0, trend: '' },
    '기초학력': { score: Math.round(diagAvg), hasData: diagnoses.length > 0, trend: '' },
    '학습역량': { score: Math.round(learnAvg), hasData: learningStats.length > 0, trend: '' },
    '오늘의학습': { score: Math.round(dailyRate), hasData: dailyTotal > 0, trend: '' },
    '독서활동': { score: readingScore, hasData: readingLogs.length > 0, bookCount: readingLogs.length, trend: '' },
    '진로탐색': { score: careerScore, hasData: careerLogs.length > 0, interestAreaCount: interestAreaCount, careerLogCount: careerLogCount, trend: '' }
  };

  // 서비스 미제공 영역 강제 0점 처리
  NO_SERVICE_AREAS.forEach(name => {
    if (areas[name]) {
      areas[name].score = 0;
      areas[name].hasData = false;
    }
  });

  // 가중치 기반 종합 점수 계산 (hasData인 영역만)
  const weights = {
    '정서발달': 0.15,
    '기초학력': 0.25,
    '학습역량': 0.20,
    '오늘의학습': 0.15,
    '독서활동': 0.15,
    '진로탐색': 0.10
  };
  const validAreas = Object.entries(areas).filter(([_, a]) => a.hasData);
  let overallScore = 0;
  if (validAreas.length > 0) {
    const totalWeight = validAreas.reduce((s, [name, _]) => s + weights[name], 0);
    overallScore = Math.round(
      validAreas.reduce((s, [name, a]) => s + a.score * weights[name], 0) / totalWeight
    );
  }

  return {
    studentName,
    className,
    role: student ? student.role : 'student',
    overallScore,
    areas,
    emotionDevelopment: emotions,
    academicFoundation: diagnoses,
    learningCapacity: learningStats,
    dailyLearning: dailyStats,
    readingActivity: { books: readingLogs, count: readingLogs.length },
    careerExploration: { interests: careerInterests, logs: careerLogs },
    contentUsage: {
      savedContents,
      viewedContents,
      totalLikes,
      uploadedContents,
      subscriberCount,
      mySubscriptions,
      searchKeywords,
      achievementStandards,
      portfolioCount
    },
    observations
  };
}

function getStudentReportArea(studentId, areaName, { startDate, endDate } = {}) {
  const report = getStudentReport(studentId, { startDate, endDate });
  const areaMap = {
    emotion: 'emotionDevelopment',
    academic: 'academicFoundation',
    learning: 'learningCapacity',
    daily: 'dailyLearning',
    reading: 'readingActivity',
    career: 'careerExploration'
  };
  return report[areaMap[areaName]] || null;
}

// ========== 선생님 관찰 기록 ==========

function createObservation(teacherId, { studentId, classId, text, content, area, tags }) {
  const obsText = text || content || '';
  const tagData = tags ? (typeof tags === 'string' ? tags : JSON.stringify(tags)) : (area ? JSON.stringify({ area }) : null);
  const areaValue = area || '';
  const info = db.prepare(`
    INSERT INTO teacher_observations (teacher_id, student_id, class_id, observation_text, tags, area)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(teacherId, studentId, classId, obsText, tagData, areaValue);
  return { id: info.lastInsertRowid };
}

function getObservations(studentId, classId) {
  let rows;
  if (classId) {
    rows = db.prepare(`
      SELECT o.*, u.display_name as teacher_name
      FROM teacher_observations o JOIN users u ON o.teacher_id = u.id
      WHERE o.student_id = ? AND o.class_id = ? ORDER BY o.observation_date DESC
    `).all(studentId, classId);
  } else {
    rows = db.prepare(`
      SELECT o.*, u.display_name as teacher_name
      FROM teacher_observations o JOIN users u ON o.teacher_id = u.id
      WHERE o.student_id = ? ORDER BY o.observation_date DESC
    `).all(studentId);
  }
  // area 컬럼 직접 사용 (기존 데이터 호환: area 컬럼이 비어있으면 tags에서 추출)
  return rows.map(o => {
    let area = o.area || '';
    if (!area && o.tags) { try { const t = JSON.parse(o.tags); area = t.area || ''; } catch { area = ''; } }
    return { ...o, area, content: o.observation_text };
  });
}

// ========== 오늘의학습 클래스 상세 ==========

function getClassDailyLearning(classId, { period = 'weekly', startDate, endDate } = {}) {
  // 1. 클래스 학생 목록
  const members = db.prepare(`
    SELECT u.id, u.display_name FROM class_members cm
    JOIN users u ON cm.user_id = u.id WHERE cm.class_id = ? AND u.role = 'student'
    ORDER BY u.display_name
  `).all(classId);
  if (members.length === 0) return { students: [], dates: [], sets: [] };

  // 2. 날짜 범위 계산
  const today = new Date();
  if (!startDate || !endDate) {
    if (period === 'monthly') {
      startDate = today.toISOString().slice(0, 8) + '01';
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      endDate = today.toISOString().slice(0, 8) + String(lastDay).padStart(2, '0');
    } else {
      // weekly: 이번 주 월~일
      const day = today.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(today);
      monday.setDate(today.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      startDate = monday.toISOString().slice(0, 10);
      endDate = sunday.toISOString().slice(0, 10);
    }
  }

  // 3. 해당 기간의 학습 세트 조회
  const sets = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM daily_learning_items WHERE set_id = s.id) as item_count
    FROM daily_learning_sets s
    WHERE (s.class_id = ? OR s.class_id IS NULL)
      AND s.target_date BETWEEN ? AND ?
      AND s.is_active = 1
    ORDER BY s.target_date ASC
  `).all(classId, startDate, endDate);

  // 4. 날짜 목록 생성
  const dates = [];
  const d = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }

  // 5. 학생별 날짜별 진행 상황 조회
  const studentIds = members.map(m => m.id);
  const studentPlaceholders = studentIds.map(() => '?').join(',');

  // 세트ID 목록
  const setIds = sets.map(s => s.id);

  const studentData = members.map(member => {
    const dailyMap = {};
    dates.forEach(date => {
      dailyMap[date] = { participated: false, totalItems: 0, completedItems: 0, score: null, accuracy: null };
    });

    if (setIds.length > 0) {
      const setPlaceholders = setIds.map(() => '?').join(',');
      // 날짜별 세트에 대한 진행 상황
      const progress = db.prepare(`
        SELECT s.target_date,
          COUNT(DISTINCT i.id) as total_items,
          COUNT(DISTINCT CASE WHEN p.status = 'completed' THEN p.item_id END) as completed_items,
          AVG(CASE WHEN p.status = 'completed' THEN p.score END) as avg_score
        FROM daily_learning_sets s
        JOIN daily_learning_items i ON i.set_id = s.id
        LEFT JOIN daily_learning_progress p ON p.item_id = i.id AND p.user_id = ?
        WHERE s.id IN (${setPlaceholders})
        GROUP BY s.target_date
      `).all(member.id, ...setIds);

      progress.forEach(row => {
        if (dailyMap[row.target_date]) {
          dailyMap[row.target_date] = {
            participated: row.completed_items > 0,
            totalItems: row.total_items,
            completedItems: row.completed_items,
            score: row.avg_score != null ? Math.round(row.avg_score) : null,
            accuracy: row.total_items > 0 ? Math.round(row.completed_items / row.total_items * 100) : 0
          };
        }
      });
    }

    // 총 참여율 & 평균 정답률
    const participated = Object.values(dailyMap).filter(v => v.participated).length;
    const datesWithSets = Object.entries(dailyMap).filter(([dt]) => sets.some(s => s.target_date === dt)).length;
    const scores = Object.values(dailyMap).filter(v => v.score != null).map(v => v.score);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    return {
      id: member.id,
      name: member.display_name,
      daily: dailyMap,
      participationRate: datesWithSets > 0 ? Math.round(participated / datesWithSets * 100) : 0,
      avgScore
    };
  });

  return {
    students: studentData,
    dates,
    startDate,
    endDate,
    period,
    sets: sets.map(s => ({ id: s.id, title: s.title, targetDate: s.target_date, itemCount: s.item_count, subject: s.target_subject }))
  };
}

// ========== 독서 기록 ==========

function getReadingLogs(userId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM reading_logs WHERE user_id = ?').get(userId).cnt;
  const items = db.prepare('SELECT * FROM reading_logs WHERE user_id = ? ORDER BY read_date DESC LIMIT ? OFFSET ?')
    .all(userId, limit, (page - 1) * limit);
  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

function addReadingLog(userId, data) {
  const info = db.prepare(`
    INSERT INTO reading_logs (user_id, book_title, author, read_date, rating, review)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, data.bookTitle, data.author || null, data.readDate || null, data.rating || null, data.review || null);
  return { id: info.lastInsertRowid };
}

function updateReadingLog(userId, logId, data) {
  const existing = db.prepare('SELECT * FROM reading_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare(`
    UPDATE reading_logs SET book_title = ?, author = ?, read_date = ?, rating = ?, review = ? WHERE id = ? AND user_id = ?
  `).run(data.bookTitle, data.author || null, data.readDate || null, data.rating || null, data.review || null, logId, userId);
  return { id: logId };
}

function deleteReadingLog(userId, logId) {
  const existing = db.prepare('SELECT * FROM reading_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM reading_logs WHERE id = ? AND user_id = ?').run(logId, userId);
  return { id: logId };
}

// ========== 진로탐색 기록 ==========

function getCareerLogs(userId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM career_logs WHERE user_id = ?').get(userId).cnt;
  const items = db.prepare('SELECT * FROM career_logs WHERE user_id = ? ORDER BY activity_date DESC LIMIT ? OFFSET ?')
    .all(userId, limit, (page - 1) * limit);
  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

function addCareerLog(userId, data) {
  const info = db.prepare(`
    INSERT INTO career_logs (user_id, activity_type, title, description, interest_area, reflection, activity_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, data.activityType || '기타', data.title, data.description || null, data.interestArea || null, data.reflection || null, data.activityDate || null);
  return { id: info.lastInsertRowid };
}

function updateCareerLog(userId, logId, data) {
  const existing = db.prepare('SELECT * FROM career_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare(`
    UPDATE career_logs SET activity_type = ?, title = ?, description = ?, interest_area = ?, reflection = ?, activity_date = ? WHERE id = ? AND user_id = ?
  `).run(data.activityType || '기타', data.title, data.description || null, data.interestArea || null, data.reflection || null, data.activityDate || null, logId, userId);
  return { id: logId };
}

function deleteCareerLog(userId, logId) {
  const existing = db.prepare('SELECT * FROM career_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM career_logs WHERE id = ? AND user_id = ?').run(logId, userId);
  return { id: logId };
}

// ========== 학부모 공개 설정 ==========

function setReportVisibility(teacherId, studentId, classId, settings) {
  db.prepare(`
    INSERT OR REPLACE INTO report_visibility (teacher_id, student_id, class_id, show_summary, show_emotion, show_academics, show_teacher_comment, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(teacherId, studentId, classId,
    settings.showSummary !== undefined ? (settings.showSummary ? 1 : 0) : 1,
    settings.showEmotion !== undefined ? (settings.showEmotion ? 1 : 0) : 1,
    settings.showAcademics !== undefined ? (settings.showAcademics ? 1 : 0) : 1,
    settings.showTeacherComment !== undefined ? (settings.showTeacherComment ? 1 : 0) : 1);
}

function getParentReport(studentId) {
  // 공개 설정된 영역만 반환
  const visibility = db.prepare('SELECT * FROM report_visibility WHERE student_id = ? LIMIT 1').get(studentId);
  const report = getStudentReport(studentId, {});

  if (visibility) {
    if (!visibility.show_emotion) delete report.emotionDevelopment;
    if (!visibility.show_academics) delete report.academicFoundation;
    if (!visibility.show_teacher_comment) delete report.observations;
  }

  return report;
}

// ========== 외부 데이터 수신(Ingest) 게이트웨이 ==========

/**
 * 기초학력 진단 결과 수신
 * 외부 학력진단 시스템(학력진단-보정 시스템, AI 진단 등)에서 결과를 전송
 * @param {Object} data - { userId, sourceSystem, targetNodeId, result, correctCount, totalQuestions, completedAt }
 */
function ingestDiagnosis(data) {
  const { userId, sourceSystem, targetNodeId, result, correctCount, totalQuestions, completedAt } = data;
  // diagnosis_sessions 테이블에 삽입
  const info = db.prepare(`
    INSERT INTO diagnosis_sessions (user_id, target_node_id, status, result, correct_count, total_questions, started_at, completed_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(
    userId,
    targetNodeId || sourceSystem || 'external',
    result || (correctCount >= totalQuestions * 0.6 ? 'pass' : 'fail'),
    correctCount || 0,
    totalQuestions || 0,
    completedAt || new Date().toISOString(),
    completedAt || new Date().toISOString()
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 기초학력 진단 결과 일괄 수신 (배치)
 * @param {Array} items - 진단 결과 배열
 */
function ingestDiagnosisBatch(items) {
  const insert = db.prepare(`
    INSERT INTO diagnosis_sessions (user_id, target_node_id, status, result, correct_count, total_questions, started_at, completed_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
  `);
  const results = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const info = insert.run(
        item.userId,
        item.targetNodeId || item.sourceSystem || 'external',
        item.result || (item.correctCount >= item.totalQuestions * 0.6 ? 'pass' : 'fail'),
        item.correctCount || 0,
        item.totalQuestions || 0,
        item.completedAt || new Date().toISOString(),
        item.completedAt || new Date().toISOString()
      );
      results.push({ id: info.lastInsertRowid });
    }
  });
  tx();
  return { inserted: results.length, results };
}

/**
 * 독서활동 데이터 수신
 * 외부 독서교육종합지원시스템, 학교 도서관 시스템 등에서 전송
 * @param {Object} data - { userId, bookTitle, author, readDate, rating, review, isbn, sourceSystem }
 */
function ingestReading(data) {
  const info = db.prepare(`
    INSERT INTO reading_logs (user_id, book_title, author, read_date, rating, review)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.bookTitle,
    data.author || null,
    data.readDate || new Date().toISOString().slice(0, 10),
    data.rating || null,
    data.review || null
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 독서활동 일괄 수신 (배치)
 */
function ingestReadingBatch(items) {
  const insert = db.prepare(`
    INSERT INTO reading_logs (user_id, book_title, author, read_date, rating, review)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const info = insert.run(
        item.userId,
        item.bookTitle,
        item.author || null,
        item.readDate || new Date().toISOString().slice(0, 10),
        item.rating || null,
        item.review || null
      );
      results.push({ id: info.lastInsertRowid });
    }
  });
  tx();
  return { inserted: results.length, results };
}

/**
 * 진로탐색 데이터 수신
 * 외부 진로적성검사 시스템, 진로체험 플랫폼 등에서 전송
 * @param {Object} data - { userId, activityType, title, description, interestArea, reflection, activityDate, sourceSystem }
 */
function ingestCareer(data) {
  const info = db.prepare(`
    INSERT INTO career_logs (user_id, activity_type, title, description, interest_area, reflection, activity_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.activityType || '외부연동',
    data.title,
    data.description || null,
    data.interestArea || null,
    data.reflection || null,
    data.activityDate || new Date().toISOString().slice(0, 10)
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 진로탐색 일괄 수신 (배치)
 */
function ingestCareerBatch(items) {
  const insert = db.prepare(`
    INSERT INTO career_logs (user_id, activity_type, title, description, interest_area, reflection, activity_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const info = insert.run(
        item.userId,
        item.activityType || '외부연동',
        item.title,
        item.description || null,
        item.interestArea || null,
        item.reflection || null,
        item.activityDate || new Date().toISOString().slice(0, 10)
      );
      results.push({ id: info.lastInsertRowid });
    }
  });
  tx();
  return { inserted: results.length, results };
}

/**
 * 학습활동 데이터 수신 (학습역량/오늘의학습 등 범용)
 * 외부 LMS, 에듀테크 플랫폼 등에서 학습 활동 로그 전송
 */
function ingestLearningLog(data) {
  const info = db.prepare(`
    INSERT INTO learning_logs (user_id, class_id, activity_type, object_id, object_type, verb, result_score, duration, source_service)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.classId || null,
    data.activityType || 'external',
    data.contentId || null,
    data.contentTitle || 'content',
    'completed',
    data.resultScore || null,
    data.timeSpent || null,
    data.sourceService || data.sourceSystem || 'external'
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 정서(감정) 데이터 수신
 * 외부 감정체크 앱, 설문 시스템 등에서 전송
 *
 * 감정은 학생 단위 상태이므로, classId 미지정 시 학생이 속한 모든 활성 클래스에
 * UPSERT 한다 (각 클래스 담임이 자기 반 학생의 감정을 볼 수 있도록).
 */
function ingestEmotion(data) {
  const date = data.date || new Date().toISOString().slice(0, 10);
  const explicitClassId = data.classId ? parseInt(data.classId) : null;

  const upsertStmt = db.prepare(`
    INSERT INTO attendance (class_id, user_id, attendance_date, status, emotion, emotion_reason, emotion_score)
    VALUES (?, ?, ?, 'present', ?, ?, ?)
    ON CONFLICT(class_id, user_id, attendance_date) DO UPDATE SET
      emotion = excluded.emotion,
      emotion_reason = excluded.emotion_reason,
      emotion_score = excluded.emotion_score,
      status = 'present',
      checked_at = CURRENT_TIMESTAMP
  `);
  const findRowStmt = db.prepare(
    'SELECT id FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?'
  );

  const upsertOne = (cid) => {
    const info = upsertStmt.run(cid, data.userId, date, data.emotion, data.emotionReason || null, data.emotionScore != null ? data.emotionScore : null);
    let id = info.lastInsertRowid;
    if (!id) {
      const row = findRowStmt.get(cid, data.userId, date);
      id = row ? row.id : null;
    }
    return id;
  };

  // 1) 명시적 classId 제공 + 해당 학생이 그 클래스 소속이면 단일 UPSERT
  if (explicitClassId && explicitClassId > 0) {
    const member = db.prepare(
      "SELECT 1 FROM class_members WHERE user_id = ? AND class_id = ? AND status = 'active' LIMIT 1"
    ).get(data.userId, explicitClassId);
    if (member) {
      const id = upsertOne(explicitClassId);
      return { id, source: 'ingest', classCount: 1 };
    }
    // 유효하지 않으면 아래 멀티 인서트 경로로 폴백
  }

  // 2) 학생이 속한 모든 활성 클래스에 UPSERT
  const memberships = db.prepare(
    "SELECT class_id FROM class_members WHERE user_id = ? AND status = 'active' ORDER BY id ASC"
  ).all(data.userId);

  if (memberships.length > 0) {
    let firstId = null;
    const tx = db.transaction(() => {
      for (const m of memberships) {
        const id = upsertOne(m.class_id);
        if (firstId == null) firstId = id;
      }
    });
    tx();
    return { id: firstId, source: 'ingest', classCount: memberships.length };
  }

  // 3) 폴백: 멤버십이 전혀 없으면 가장 오래된 클래스에 기록 (데이터 소실 방지)
  const anyClass = db.prepare('SELECT id FROM classes ORDER BY id ASC LIMIT 1').get();
  if (!anyClass) {
    throw new Error('유효한 클래스를 찾을 수 없습니다.');
  }
  const id = upsertOne(anyClass.id);
  return { id, source: 'ingest', classCount: 1 };
}

/**
 * Ingest 처리 현황 조회 (관리자용)
 */
function getIngestStats() {
  const diagCount = db.prepare("SELECT COUNT(*) as cnt FROM diagnosis_sessions WHERE target_node_id LIKE 'external%' OR target_node_id NOT LIKE 'M-%'").get().cnt;
  const readingCount = db.prepare("SELECT COUNT(*) as cnt FROM reading_logs").get().cnt;
  const careerCount = db.prepare("SELECT COUNT(*) as cnt FROM career_logs").get().cnt;
  const learningCount = db.prepare("SELECT COUNT(*) as cnt FROM learning_logs WHERE source_service = 'external'").get().cnt;
  return {
    diagnosis: diagCount,
    reading: readingCount,
    career: careerCount,
    externalLearning: learningCount,
    total: diagCount + readingCount + careerCount + learningCount
  };
}

module.exports = {
  autoAddPortfolioItem,
  getPortfolioItems, getPortfolioItemDetail, toggleLifeTask, saveReflection, updatePrivacy,
  getPortfolioStats, getGrowthGoals, createGrowthGoal, updateGrowthGoalProgress,
  getClassDashboard, getStudentReport, getStudentReportArea, getClassDailyLearning,
  createObservation, getObservations,
  getReadingLogs, addReadingLog, updateReadingLog, deleteReadingLog,
  getCareerLogs, addCareerLog, updateCareerLog, deleteCareerLog,
  setReportVisibility, getParentReport,
  // Ingest 게이트웨이
  ingestDiagnosis, ingestDiagnosisBatch,
  ingestReading, ingestReadingBatch,
  ingestCareer, ingestCareerBatch,
  ingestLearningLog, ingestEmotion,
  getIngestStats
};
