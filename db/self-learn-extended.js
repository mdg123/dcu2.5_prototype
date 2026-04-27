// db/self-learn-extended.js
const db = require('./index');
const { logLearningActivity } = require('./learning-log-helper');
const { awardPoints, getSetting } = require('./point-helper');

// ========== 스키마 초기화 (P0 AI 맞춤학습 확장) ==========
function init() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS problem_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content_id INTEGER NOT NULL,
        node_id VARCHAR(50),
        is_correct INTEGER NOT NULL DEFAULT 0,
        selected_answer TEXT,
        time_taken INTEGER,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pa_content ON problem_attempts(content_id);
      CREATE INDEX IF NOT EXISTS idx_pa_user ON problem_attempts(user_id);
      CREATE INDEX IF NOT EXISTS idx_pa_node ON problem_attempts(node_id);

      CREATE TABLE IF NOT EXISTS user_learning_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        node_id VARCHAR(50) NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS user_last_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        activity_type TEXT,
        node_id VARCHAR(50),
        content_id INTEGER,
        title TEXT,
        accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS content_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content_id INTEGER NOT NULL,
        content_type TEXT,
        reason TEXT,
        details TEXT,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_content_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content_id INTEGER NOT NULL,
        node_id VARCHAR(50),
        position_sec INTEGER DEFAULT 0,
        duration_sec INTEGER DEFAULT 0,
        watch_ratio REAL DEFAULT 0,
        view_count INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, content_id)
      );
    `);
  } catch (e) { console.error('[self-learn init] schema error:', e.message); }

  // diagnosis_sessions 컬럼 확장 (ALTER 안전 가드)
  const diagCols = ['difficulty_path TEXT', 'queue_nodes TEXT', 'current_node_id VARCHAR(50)', 'current_difficulty TEXT', 'per_node_answers TEXT'];
  for (const col of diagCols) {
    try { db.exec(`ALTER TABLE diagnosis_sessions ADD COLUMN ${col}`); } catch (e) { /* exists */ }
  }
}

// 서버 시작 시 즉시 1회 실행
try { init(); } catch (e) { console.error('[self-learn auto-init] ', e.message); }


// ========== 오늘의 학습 세트 ==========

function getDailySets(userId, { date, grade, subject } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  if (date) { where += ' AND s.target_date = ?'; params.push(date); }
  if (grade) { where += ' AND s.target_grade = ?'; params.push(parseInt(grade)); }
  if (subject) { where += ' AND s.target_subject = ?'; params.push(subject); }

  const sets = db.prepare(`
    SELECT s.*, u.display_name as teacher_name,
      (SELECT COUNT(*) FROM daily_learning_items WHERE set_id = s.id) as total_items,
      (SELECT COUNT(*) FROM daily_learning_progress p
        JOIN daily_learning_items i ON p.item_id = i.id
        WHERE i.set_id = s.id AND p.user_id = ? AND p.status = 'completed') as completed_items
    FROM daily_learning_sets s
    LEFT JOIN users u ON s.teacher_id = u.id
    ${where}
    ORDER BY s.target_date DESC, s.created_at DESC
  `).all(userId, ...params);

  // 각 세트에 items 포함
  const getItems = db.prepare(`
    SELECT i.*, p.status as progress_status, p.score, p.started_at, p.completed_at,
      c.title as content_title, c.content_type, c.content_url, c.file_path, c.description as content_desc
    FROM daily_learning_items i
    LEFT JOIN daily_learning_progress p ON p.item_id = i.id AND p.user_id = ?
    LEFT JOIN contents c ON i.content_id = c.id
    WHERE i.set_id = ?
    ORDER BY i.sort_order
  `);
  sets.forEach(s => {
    s.items = getItems.all(userId, s.id).map(it => ({
      ...it,
      status: it.progress_status || 'not_started',
      title: it.item_title || it.content_title || '학습 항목'
    }));
  });
  return sets;
}

function getDailySetDetail(setId, userId) {
  const set = db.prepare(`
    SELECT s.*, u.display_name as teacher_name
    FROM daily_learning_sets s LEFT JOIN users u ON s.teacher_id = u.id
    WHERE s.id = ?
  `).get(setId);
  if (!set) return null;

  const items = db.prepare(`
    SELECT i.*, p.status as progress_status, p.score, p.time_spent_seconds, p.started_at, p.completed_at
    FROM daily_learning_items i
    LEFT JOIN daily_learning_progress p ON p.item_id = i.id AND p.user_id = ?
    WHERE i.set_id = ?
    ORDER BY i.sort_order
  `).all(userId, setId);

  return { set, items };
}

function startDailyItem(itemId, userId) {
  const item = db.prepare('SELECT * FROM daily_learning_items WHERE id = ?').get(itemId);
  if (!item) return null;
  // 이미 completed 상태면 덮어쓰지 않음 (재시작/auto-navigation 시 완료 상태 보존)
  const prev = db.prepare('SELECT status FROM daily_learning_progress WHERE user_id=? AND item_id=?').get(userId, itemId);
  if (prev && prev.status === 'completed') return { success: true, alreadyCompleted: true };
  db.prepare(`
    INSERT OR REPLACE INTO daily_learning_progress (user_id, item_id, set_id, status, started_at)
    VALUES (?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)
  `).run(userId, itemId, item.set_id);
  return { success: true };
}

function completeDailyItem(itemId, userId, { score, timeSpent, answers, correctCount, totalQuestions } = {}) {
  const item = db.prepare('SELECT * FROM daily_learning_items WHERE id = ?').get(itemId);
  if (!item) return null;
  // 중복 완료 처리 방지: 이미 completed면 포인트 재지급/로그 반복 안 함
  const prev = db.prepare("SELECT status FROM daily_learning_progress WHERE user_id=? AND item_id=?").get(userId, itemId);
  const wasCompleted = prev && prev.status === 'completed';
  // 정오답 상세(answers): [{questionNumber, questionText, options, myAnswer, correctAnswer, isCorrect, explanation}, ...]
  const answersJson = Array.isArray(answers) && answers.length > 0 ? JSON.stringify(answers) : null;
  db.prepare(`
    UPDATE daily_learning_progress
    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, score = ?, time_spent_seconds = ?,
        answers_json = COALESCE(?, answers_json),
        correct_count = COALESCE(?, correct_count),
        total_questions = COALESCE(?, total_questions)
    WHERE user_id = ? AND item_id = ?
  `).run(score ?? null, timeSpent || 0, answersJson, correctCount ?? null, totalQuestions ?? null, userId, itemId);

  if (wasCompleted) {
    return { success: true, alreadyCompleted: true };
  }

  logLearningActivity({
    userId, activityType: 'daily_complete', targetType: 'daily_learning',
    targetId: itemId, verb: 'completed', sourceService: 'self-learn',
    resultScore: score ? score / 100 : null
  });

  const pts = parseInt(getSetting('daily_learning_complete_point') || '10');
  awardPoints(userId, { source: 'daily_learning', sourceId: itemId, points: pts, description: '오늘의 학습 완료' });

  return { success: true };
}

function getDailyStats(userId) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM daily_learning_progress WHERE user_id = ?').get(userId).cnt;
  const completed = db.prepare("SELECT COUNT(*) as cnt FROM daily_learning_progress WHERE user_id = ? AND status = 'completed'").get(userId).cnt;

  // 연속 학습일 계산
  const dates = db.prepare(`
    SELECT DISTINCT DATE(completed_at) as d FROM daily_learning_progress
    WHERE user_id = ? AND status = 'completed' ORDER BY d DESC
  `).all(userId).map(r => r.d);

  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);
  let checkDate = today;
  for (const d of dates) {
    if (d === checkDate) {
      streak++;
      const prev = new Date(checkDate);
      prev.setDate(prev.getDate() - 1);
      checkDate = prev.toISOString().slice(0, 10);
    } else break;
  }

  // 총 포인트
  let totalPoints = 0;
  try {
    const pts = db.prepare('SELECT COALESCE(SUM(points), 0) as p FROM user_points WHERE user_id = ?').get(userId);
    totalPoints = pts?.p || 0;
  } catch {}

  // 오늘의 학습 완료 수 / 전체 수 (활성화된 모든 세트 기준)
  let todayCompleted = 0, todayTotal = 0;
  try {
    const allSets = db.prepare("SELECT id FROM daily_learning_sets WHERE is_active = 1").all();
    if (allSets.length) {
      const setIds = allSets.map(s => s.id).join(',');
      todayTotal = db.prepare(`SELECT COUNT(*) as cnt FROM daily_learning_items WHERE set_id IN (${setIds})`).get().cnt;
      todayCompleted = db.prepare(`SELECT COUNT(*) as cnt FROM daily_learning_progress p JOIN daily_learning_items i ON p.item_id = i.id WHERE i.set_id IN (${setIds}) AND p.user_id = ? AND p.status = 'completed'`).get(userId).cnt;
    }
  } catch {}

  // AI 맞춤학습 완료 수
  let aiCompleted = 0, aiTotal = 0;
  try {
    const ns = db.prepare("SELECT COUNT(*) as cnt FROM user_node_status WHERE user_id = ? AND status = 'completed'").get(userId);
    aiCompleted = ns?.cnt || 0;
    const totalNodes = db.prepare("SELECT COUNT(*) as cnt FROM learning_map_nodes").get();
    aiTotal = totalNodes?.cnt || 0;
  } catch {}

  // 오답노트 해결 현황
  let wrongResolved = 0, wrongTotal = 0;
  try {
    const wt = db.prepare('SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ?').get(userId);
    const wr = db.prepare("SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ? AND is_resolved = 1").get(userId);
    wrongTotal = wt?.cnt || 0;
    wrongResolved = wr?.cnt || 0;
  } catch {}

  // 주간 일별 완료 데이터 (이번 주 월~일)
  let weekly = [];
  try {
    const now = new Date();
    const dow = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      // 해당 날짜에 배정된 세트의 아이템 수/완료 수
      const sets = db.prepare("SELECT id FROM daily_learning_sets WHERE target_date = ? AND is_active = 1").all(dateStr);
      if (sets.length) {
        const sids = sets.map(s => s.id).join(',');
        const t = db.prepare(`SELECT COUNT(*) as cnt FROM daily_learning_items WHERE set_id IN (${sids})`).get().cnt;
        const c = db.prepare(`SELECT COUNT(*) as cnt FROM daily_learning_progress p JOIN daily_learning_items i ON p.item_id = i.id WHERE i.set_id IN (${sids}) AND p.user_id = ? AND p.status = 'completed'`).get(userId).cnt;
        weekly.push({ completed: c, total: t });
      } else {
        weekly.push({ completed: 0, total: 0 });
      }
    }
  } catch {}

  // ===== "이번 주(월~일)" 기준 집계 (누적 아님) =====
  const nowW = new Date();
  const dowW = nowW.getDay();
  const monW = new Date(nowW); monW.setDate(nowW.getDate() - (dowW === 0 ? 6 : dowW - 1));
  const sunW = new Date(monW); sunW.setDate(monW.getDate() + 6);
  const monStr = monW.toISOString().slice(0, 10);
  const sunStr = sunW.toISOString().slice(0, 10);
  // 이번 주 배포된 세트의 아이템 수 / 완료 수
  let weekDailyCompleted = 0, weekDailyTotal = 0;
  try {
    const wsets = db.prepare("SELECT id FROM daily_learning_sets WHERE target_date BETWEEN ? AND ? AND is_active = 1").all(monStr, sunStr);
    if (wsets.length) {
      const ids = wsets.map(s => s.id).join(',');
      weekDailyTotal = db.prepare(`SELECT COUNT(*) as cnt FROM daily_learning_items WHERE set_id IN (${ids})`).get().cnt;
      weekDailyCompleted = db.prepare(`SELECT COUNT(*) as cnt FROM daily_learning_progress p JOIN daily_learning_items i ON p.item_id = i.id WHERE i.set_id IN (${ids}) AND p.user_id = ? AND p.status='completed'`).get(userId).cnt;
    }
  } catch {}
  // 이번 주 AI 맞춤학습 (assigned_date 있으면 범위 필터, 없으면 최근 7일 완료 수)
  let aiCompletedWeek = 0, aiTotalWeek = 0;
  try {
    const cols = db.prepare("PRAGMA table_info(user_node_status)").all().map(c => c.name);
    if (cols.includes('assigned_date')) {
      aiTotalWeek = db.prepare("SELECT COUNT(*) as cnt FROM user_node_status WHERE user_id = ? AND assigned_date BETWEEN ? AND ?").get(userId, monStr, sunStr).cnt;
      aiCompletedWeek = db.prepare("SELECT COUNT(*) as cnt FROM user_node_status WHERE user_id = ? AND assigned_date BETWEEN ? AND ? AND status='completed'").get(userId, monStr, sunStr).cnt;
    } else {
      const col = cols.includes('completed_at') ? 'completed_at' : (cols.includes('updated_at') ? 'updated_at' : null);
      if (col) {
        aiCompletedWeek = db.prepare(`SELECT COUNT(*) as cnt FROM user_node_status WHERE user_id = ? AND status='completed' AND DATE(${col}) BETWEEN ? AND ?`).get(userId, monStr, sunStr).cnt;
        aiTotalWeek = aiCompletedWeek;
      }
    }
  } catch {}
  // 이번 주 등록/해결된 오답
  let wrongResolvedWeek = 0, wrongTotalWeek = 0;
  try {
    const cols = db.prepare("PRAGMA table_info(wrong_answers)").all().map(c => c.name);
    const createdCol = cols.includes('created_at') ? 'created_at' : null;
    const resolvedCol = cols.includes('resolved_at') ? 'resolved_at' : null;
    if (createdCol) {
      wrongTotalWeek = db.prepare(`SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ? AND DATE(${createdCol}) BETWEEN ? AND ?`).get(userId, monStr, sunStr).cnt;
    }
    if (resolvedCol) {
      wrongResolvedWeek = db.prepare(`SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ? AND is_resolved = 1 AND DATE(${resolvedCol}) BETWEEN ? AND ?`).get(userId, monStr, sunStr).cnt;
    }
  } catch {}

  return {
    total, completed, completionRate: total > 0 ? Math.round(completed / total * 100) : 0,
    streak, total_points: totalPoints,
    today_completed: todayCompleted, today_total: todayTotal,
    ai_completed: aiCompleted, ai_total: aiTotal,
    wrong_resolved: wrongResolved, wrong_total: wrongTotal,
    // 이번 주(월~일) 기준 (today.html 주간 목표 달성률용)
    week_daily_completed: weekDailyCompleted, week_daily_total: weekDailyTotal,
    ai_completed_week: aiCompletedWeek, ai_total_week: aiTotalWeek,
    wrong_resolved_week: wrongResolvedWeek, wrong_total_week: wrongTotalWeek,
    weekly
  };
}

function createDailySet(teacherId, data) {
  // thumbnail_url / difficulty 컬럼 포함
  let sql = 'INSERT INTO daily_learning_sets (class_id, teacher_id, title, description, target_date, target_grade, target_subject, is_active, difficulty';
  let vals = '?, ?, ?, ?, ?, ?, ?, ?, ?';
  const params = [data.classId || data.class_id || null, teacherId, data.title, data.description || null,
    data.targetDate || data.target_date || null, data.targetGrade || data.target_grade || null,
    data.targetSubject || data.target_subject || null, data.is_active ? 1 : (data.is_active === false ? 0 : 1),
    data.difficulty || '보통'];
  if (data.thumbnail_url) { sql += ', thumbnail_url'; vals += ', ?'; params.push(data.thumbnail_url); }
  sql += ') VALUES (' + vals + ')';
  const info = db.prepare(sql).run(...params);
  const set = db.prepare('SELECT * FROM daily_learning_sets WHERE id = ?').get(info.lastInsertRowid);
  return { id: info.lastInsertRowid, set };
}

function updateDailySet(setId, data) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(data)) {
    if (['title', 'description', 'target_date', 'target_grade', 'target_subject', 'is_active', 'difficulty'].includes(k)) {
      fields.push(`${k} = ?`); params.push(v);
    }
  }
  if (!fields.length) return;
  params.push(setId);
  db.prepare(`UPDATE daily_learning_sets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

function addDailyItem(setId, data) {
  // snake_case (API/UI 표준) 우선, camelCase fallback
  const sourceType = data.source_type || data.sourceType || 'content';
  const contentId = data.content_id ?? data.contentId ?? null;
  const externalUrl = data.external_url || data.externalUrl || null;
  const externalTitle = data.external_title || data.externalTitle || null;
  const nodeId = data.node_id || data.nodeId || null;
  const itemTitle = data.item_title || data.itemTitle || data.title || '학습 항목';
  const itemDescription = data.item_description || data.itemDescription || null;
  const sortOrder = data.sort_order ?? data.sortOrder ?? 0;
  const estimatedMinutes = data.estimated_minutes ?? data.estimatedMinutes ?? 10;
  const pointValue = data.point_value ?? data.pointValue ?? 10;
  const info = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, content_id, external_url, external_title, node_id, item_title, item_description, sort_order, estimated_minutes, point_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(setId, sourceType, contentId, externalUrl, externalTitle, nodeId,
    itemTitle, itemDescription, sortOrder, estimatedMinutes, pointValue);
  return { id: info.lastInsertRowid };
}

function removeDailyItem(itemId) {
  db.prepare('DELETE FROM daily_learning_items WHERE id = ?').run(itemId);
}

// ========== AI 맞춤학습 (학습맵) ==========

function getMapNodes({ subject, gradeLevel, grade, grades, schoolLevel, schoolLevels, semester, area, keyword, status, userId } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  if (subject) { where += ' AND subject = ?'; params.push(subject); }
  if (gradeLevel) { where += ' AND grade_level = ?'; params.push(gradeLevel); }
  if (grade) { where += ' AND grade = ?'; params.push(parseInt(grade)); }
  // grades: 학년군 (comma-separated list of grades, optionally paired with gradeLevel)
  if (grades) {
    const arr = String(grades).split(',').map(x => parseInt(x)).filter(x => !isNaN(x));
    if (arr.length) {
      where += ' AND grade IN (' + arr.map(() => '?').join(',') + ')';
      params.push(...arr);
    }
  }
  if (semester) { where += ' AND semester = ?'; params.push(parseInt(semester)); }
  if (area) { where += ' AND area = ?'; params.push(area); }
  // schoolLevels (CSV 복수): 'elementary,middle,high' 등 복수 학교급 필터
  if (schoolLevels) {
    const mapSL = { elementary: '초', middle: '중', high: '고', '초': '초', '중': '중', '고': '고' };
    const arr = String(schoolLevels).split(',').map(s => mapSL[s.trim()]).filter(Boolean);
    if (arr.length) {
      where += ' AND grade_level IN (' + arr.map(() => '?').join(',') + ')';
      params.push(...arr);
    }
  } else if (schoolLevel === 'elementary' || schoolLevel === '초') { where += " AND grade_level = '초'"; }
  else if (schoolLevel === 'middle' || schoolLevel === '중') { where += " AND grade_level = '중'"; }
  else if (schoolLevel === 'high' || schoolLevel === '고') { where += " AND grade_level = '고'"; }
  if (keyword) {
    where += ' AND (unit_name LIKE ? OR lesson_name LIKE ? OR achievement_code LIKE ? OR achievement_text LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  let rows = db.prepare(`SELECT * FROM learning_map_nodes ${where} ORDER BY grade, semester, sort_order`).all(...params);

  // 단원(level=2)에 대해 자식 차시(level=3) 개수를 lesson_count 로 주입
  try {
    const cntStmt = db.prepare('SELECT COUNT(*) AS c FROM learning_map_nodes WHERE parent_node_id = ? AND node_level = 3');
    rows = rows.map(r => {
      if (r.node_level === 2) {
        const c = cntStmt.get(r.node_id);
        return { ...r, lesson_count: (c && c.c) || 0 };
      }
      return r;
    });
  } catch (_) {}

  // userId 기반 status 주입 + status 필터
  if (userId) {
    const statuses = db.prepare('SELECT node_id, status FROM user_node_status WHERE user_id = ?').all(userId);
    const map = new Map(statuses.map(s => [s.node_id, s.status]));
    rows = rows.map(r => ({ ...r, user_status: map.get(r.node_id) || 'not_started' }));
    if (status) rows = rows.filter(r => r.user_status === status);
  }
  return rows;
}

function getMapNodeDetail(nodeId, userId = null) {
  const node = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
  if (!node) return null;

  // 선수/후속 — 사람이 읽을 수 있는 이름(lesson_name / unit_name)을 함께 포함
  const prerequisites = db.prepare(`
    SELECT e.from_node_id AS id, n.node_level, n.unit_name, n.lesson_name, n.achievement_code
    FROM learning_map_edges e
    LEFT JOIN learning_map_nodes n ON n.node_id = e.from_node_id
    WHERE e.to_node_id = ?
  `).all(nodeId).map(r => ({
    id: r.id,
    node_id: r.id,
    node_level: r.node_level,
    unit_name: r.unit_name,
    lesson_name: r.lesson_name,
    title: r.lesson_name || r.unit_name || r.id,
    name: r.lesson_name || r.unit_name || r.id
  }));
  const nextNodes = db.prepare(`
    SELECT e.to_node_id AS id, n.node_level, n.unit_name, n.lesson_name, n.achievement_code
    FROM learning_map_edges e
    LEFT JOIN learning_map_nodes n ON n.node_id = e.to_node_id
    WHERE e.from_node_id = ?
  `).all(nodeId).map(r => ({
    id: r.id,
    node_id: r.id,
    node_level: r.node_level,
    unit_name: r.unit_name,
    lesson_name: r.lesson_name,
    title: r.lesson_name || r.unit_name || r.id,
    name: r.lesson_name || r.unit_name || r.id
  }));

  // node_contents와 contents JOIN, content_type으로 video / problem 분리
  const contents = db.prepare(`
    SELECT nc.id as nc_id, nc.sort_order, nc.content_role,
           c.id as content_id, c.title, c.content_type, c.content_url, c.file_path,
           c.thumbnail_url, c.description, c.difficulty, c.estimated_minutes, c.view_count
    FROM node_contents nc
    JOIN contents c ON nc.content_id = c.id
    WHERE nc.node_id = ?
    ORDER BY nc.sort_order ASC, nc.id ASC
  `).all(nodeId);

  // 비디오: content_type in ('video')
  const videos = contents.filter(c => c.content_type === 'video').map(c => {
    let myViews = 0, myRatio = 0, watched = false, myPosition = 0, myDuration = 0;
    if (userId) {
      const p = db.prepare('SELECT view_count, watch_ratio, position_sec, duration_sec FROM user_content_progress WHERE user_id = ? AND content_id = ?').get(userId, c.content_id);
      if (p) {
        myViews = p.view_count || 0;
        myRatio = p.watch_ratio || 0;
        myPosition = p.position_sec || 0;
        myDuration = p.duration_sec || 0;
        watched = (p.watch_ratio || 0) >= 0.8;
      }
    }
    const durationSec = myDuration || (c.estimated_minutes ? c.estimated_minutes * 60 : null);
    return {
      id: c.content_id,
      content_id: c.content_id,
      title: c.title,
      file_path: c.file_path || null,
      content_url: c.content_url || null,
      thumbnail_url: c.thumbnail_url || null,
      duration_sec: durationSec,
      duration_min: c.estimated_minutes || null,
      view_count: c.view_count || 0,
      total_views: c.view_count || 0,
      sort_order: c.sort_order,
      user_progress: {
        position_sec: myPosition,
        watch_ratio: myRatio,
        view_count: myViews,
        watched
      },
      // 하위 호환
      my_views: myViews,
      watch_ratio: myRatio,
      watched
    };
  });

  // 문제: content_type in ('quiz','exam','problem','assessment')
  const problemTypes = new Set(['quiz', 'exam', 'problem', 'assessment', 'question']);
  const problems = contents.filter(c => problemTypes.has(c.content_type)).map(c => {
    const agg = db.prepare(`
      SELECT COUNT(*) as total_attempts,
             SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct_cnt,
             COUNT(DISTINCT user_id) as distinct_users
      FROM problem_attempts WHERE content_id = ?
    `).get(c.content_id) || {};
    const total = agg.total_attempts || 0;
    const correct = agg.correct_cnt || 0;
    const correctRate = total > 0 ? Math.round((correct / total) * 100) : 0;
    let myAttempts = 0, cleared = false, lastCorrect = null;
    if (userId) {
      const mine = db.prepare('SELECT COUNT(*) as c, SUM(is_correct) as ok FROM problem_attempts WHERE user_id = ? AND content_id = ?').get(userId, c.content_id) || {};
      myAttempts = mine.c || 0;
      cleared = (mine.ok || 0) > 0;
      if (myAttempts > 0) {
        const lastRow = db.prepare('SELECT is_correct FROM problem_attempts WHERE user_id = ? AND content_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1').get(userId, c.content_id);
        lastCorrect = lastRow ? !!lastRow.is_correct : null;
      }
    }
    // 클리어 TOP3: 정답자 중 time_taken 짧은 순
    const top = db.prepare(`
      SELECT pa.user_id, MIN(pa.time_taken) as time_sec,
             MAX(CASE WHEN pa.is_correct=1 THEN 1 ELSE 0 END) as ok,
             u.display_name, u.username
      FROM problem_attempts pa
      JOIN users u ON pa.user_id = u.id
      WHERE pa.content_id = ? AND pa.is_correct = 1
      GROUP BY pa.user_id
      ORDER BY time_sec ASC NULLS LAST
      LIMIT 3
    `).all(c.content_id).map(r => ({
      name: r.display_name || r.username,
      score: 100,
      time_sec: r.time_sec || 0
    }));
    // 문항 내용 (content_questions 에서 1개)
    const qRow = db.prepare(`
      SELECT id as question_id, question_text, options, answer, explanation, difficulty as q_difficulty
      FROM content_questions WHERE content_id = ? ORDER BY question_number LIMIT 1
    `).get(c.content_id);
    let qOpts = [];
    if (qRow?.options) {
      try {
        const parsed = JSON.parse(qRow.options);
        qOpts = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      } catch { qOpts = []; }
    }
    return {
      id: c.content_id,
      content_id: c.content_id,
      contentId: c.content_id,
      question_id: qRow?.question_id || null,
      title: c.title,
      sort_order: c.sort_order,
      difficulty: qRow?.q_difficulty || c.difficulty || 'medium',
      correct_rate: correctRate,
      accuracy: correctRate,
      total_attempts: total,
      distinct_users: agg.distinct_users || 0,
      my_attempts: myAttempts,
      attempts_count: myAttempts,
      last_correct: lastCorrect,
      cleared,
      top_clearers: top,
      clear_top3: top,
      // 문항 본문 — 프론트 openSolve 에서 사용
      question: qRow?.question_text || null,
      options: qOpts,
      answer: qRow?.answer || null,
      explanation: qRow?.explanation || null
    };
  });

  let userStatus = null;
  if (userId) {
    const st = db.prepare('SELECT status, correct_rate FROM user_node_status WHERE user_id = ? AND node_id = ?').get(userId, nodeId);
    userStatus = { status: st?.status || 'not_started', progress: st?.correct_rate || 0 };
  }

  return {
    node: {
      ...node,
      prerequisites,
      next_nodes: nextNodes
    },
    videos,
    problems,
    // 하위 호환
    contents,
    prerequisites,
    nextNodes,
    userStatus
  };
}

function getMapEdges({ subject, gradeLevel } = {}) {
  if (subject || gradeLevel) {
    let where = 'WHERE 1=1';
    const params = [];
    if (subject) { where += ' AND n.subject = ?'; params.push(subject); }
    if (gradeLevel) { where += ' AND n.grade_level = ?'; params.push(gradeLevel); }
    return db.prepare(`
      SELECT e.* FROM learning_map_edges e
      JOIN learning_map_nodes n ON e.from_node_id = n.node_id
      ${where}
    `).all(...params);
  }
  return db.prepare('SELECT * FROM learning_map_edges').all();
}

function getUserNodeStatuses(userId) {
  // learning_map_nodes에 존재하지 않는 node_id 참조는 자동 무시 (에러 방지)
  return db.prepare(`
    SELECT uns.* FROM user_node_status uns
    WHERE uns.user_id = ?
      AND EXISTS (SELECT 1 FROM learning_map_nodes lmn WHERE lmn.node_id = uns.node_id)
  `).all(userId);
}

function startDiagnosis(userId, { nodeId, subject, type } = {}) {
  // nodeId가 없으면 subject로 첫 번째 노드 찾기
  if (!nodeId && subject) {
    const firstNode = db.prepare('SELECT node_id FROM learning_map_nodes WHERE subject = ? ORDER BY ROWID LIMIT 1').get(subject);
    nodeId = firstNode ? firstNode.node_id : null;
  }
  if (!nodeId) {
    // 아무 노드도 없으면 첫 번째 노드 사용
    const anyNode = db.prepare('SELECT node_id FROM learning_map_nodes LIMIT 1').get();
    nodeId = anyNode ? anyNode.node_id : 'default';
  }

  // BFS로 선수학습 노드 탐색
  const prereqNodes = [];
  const visited = new Set();
  const queue = [nodeId];
  visited.add(nodeId);

  while (queue.length > 0) {
    const current = queue.shift();
    const edges = db.prepare('SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?').all(current);
    for (const edge of edges) {
      if (!visited.has(edge.from_node_id)) {
        visited.add(edge.from_node_id);
        prereqNodes.push(edge.from_node_id);
        queue.push(edge.from_node_id);
      }
    }
  }

  // 진단 대상: 타겟 노드 + 선수학습 노드들
  const testNodes = [nodeId, ...prereqNodes];
  const totalQuestions = testNodes.length;

  const info = db.prepare(`
    INSERT INTO diagnosis_sessions (user_id, target_node_id, diagnosis_type, status, total_questions)
    VALUES (?, ?, ?, 'in_progress', ?)
  `).run(userId, nodeId, type || 'standard', totalQuestions);

  return { sessionId: info.lastInsertRowid, testNodes, totalQuestions };
}

// rawContentId / questionId 중 유효한 contents.id 값을 확정 (없으면 첫 번째 contents.id 폴백)
function resolveValidContentId(rawContentId, questionId) {
  const n = Number(rawContentId);
  if (Number.isFinite(n) && n > 0) {
    const exists = db.prepare('SELECT id FROM contents WHERE id = ?').get(n);
    if (exists) return n;
  }
  if (questionId) {
    const qrow = db.prepare('SELECT content_id FROM content_questions WHERE id = ?').get(questionId);
    if (qrow && qrow.content_id) {
      const cExists = db.prepare('SELECT id FROM contents WHERE id = ?').get(qrow.content_id);
      if (cExists) return qrow.content_id;
    }
  }
  const any = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get();
  return any ? any.id : 1;
}

function submitDiagnosisAnswer(sessionId, payload = {}) {
  // snake_case/camelCase 모두 지원 (QA curl이 content_id 전송하는 케이스 대응)
  const nodeId = payload.nodeId || payload.node_id;
  const rawContentId = payload.contentId != null ? payload.contentId : payload.content_id;
  const questionId = payload.questionId != null ? payload.questionId : payload.question_id;
  const answer = payload.answer;

  // 세션에서 node_id 보강 (nodeId 없으면 session.target_node_id 사용)
  const session = db.prepare('SELECT target_node_id, current_node_id FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  const resolvedNodeId = nodeId || (session && (session.current_node_id || session.target_node_id)) || 'unknown';

  // 서버 정답 판정: questionId 있으면 DB로, 없으면 random fallback
  let isCorrect = 0;
  if (questionId) {
    const q = db.prepare('SELECT answer FROM content_questions WHERE id = ?').get(questionId);
    if (q && String(q.answer) === String(answer)) isCorrect = 1;
  } else {
    isCorrect = Math.random() > 0.3 ? 1 : 0;
  }

  // FK 방어: contents.id에 있는 값만 허용 (contentId NOT NULL + FK → contents(id))
  const safeContentId = resolveValidContentId(rawContentId, questionId);

  try {
    db.prepare(`
      INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, resolvedNodeId, safeContentId, String(answer || ''), isCorrect);
  } catch (e) {
    // FK가 여전히 실패하면(예: contents가 비어있음) content_id 없이 기록 시도 — 스키마가 NOT NULL이라 최소값 사용
    if (String(e.message).includes('FOREIGN KEY')) {
      const anyContent = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get();
      db.prepare(`
        INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, resolvedNodeId, anyContent ? anyContent.id : 1, String(answer || ''), isCorrect);
    } else {
      throw e;
    }
  }

  db.prepare('UPDATE diagnosis_sessions SET total_questions = total_questions + 1 WHERE id = ?').run(sessionId);
  if (isCorrect) {
    db.prepare('UPDATE diagnosis_sessions SET correct_count = correct_count + 1 WHERE id = ?').run(sessionId);
  }
  return { isCorrect: !!isCorrect };
}

function finishDiagnosis(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const correctRate = session.total_questions > 0 ? session.correct_count / session.total_questions : 0;
  let result = 'mastered';
  if (correctRate < 0.4) result = 'needs_review';
  else if (correctRate < 0.7) result = 'developing';
  else if (correctRate < 0.9) result = 'proficient';

  db.prepare(`
    UPDATE diagnosis_sessions SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(result, sessionId);

  // 사용자 노드 상태 업데이트
  db.prepare(`
    INSERT OR REPLACE INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(session.user_id, session.target_node_id,
    result === 'mastered' ? 'completed' : 'in_progress', result, correctRate);

  logLearningActivity({
    userId: session.user_id, activityType: 'diagnosis_complete', targetType: 'diagnosis',
    targetId: sessionId, verb: 'completed', sourceService: 'self-learn',
    resultScore: correctRate, resultSuccess: result === 'mastered' ? 1 : 0
  });

  return { sessionId, result, correctRate, correctCount: session.correct_count, totalQuestions: session.total_questions };
}

function getDiagnosisResult(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const answers = db.prepare('SELECT * FROM diagnosis_answers WHERE session_id = ? ORDER BY answered_at').all(sessionId);
  return { session, answers };
}

function generateLearningPath(userId, opts = {}) {
  // target_node_id / targetNodeId / nodeId 모두 허용
  const {
    nodeId: explicitNodeId,
    targetNodeId: explicitTargetCamel,
    target_node_id: explicitTargetSnake,
    subject,
    grade
  } = opts || {};
  let targetNodeId = explicitTargetCamel || explicitTargetSnake || explicitNodeId;

  // 1) 진단 결과 기반 최근 타겟 노드
  if (!targetNodeId) {
    const latestDiag = db.prepare(`
      SELECT target_node_id FROM diagnosis_sessions
      WHERE user_id = ? AND status = 'completed'
      ORDER BY completed_at DESC, id DESC LIMIT 1
    `).get(userId);
    if (latestDiag && latestDiag.target_node_id) targetNodeId = latestDiag.target_node_id;
  }

  // 2) 과목 기반 fallback
  if (!targetNodeId && subject) {
    const row = db.prepare(`
      SELECT node_id FROM learning_map_nodes
      WHERE subject = ? ${grade ? 'AND grade = ?' : ''}
      ORDER BY grade DESC, semester DESC, sort_order DESC LIMIT 1
    `).get(...(grade ? [subject, grade] : [subject]));
    if (row) targetNodeId = row.node_id;
  }

  // 3) 과목도 없다면 아무 노드
  if (!targetNodeId) {
    const row = db.prepare('SELECT node_id FROM learning_map_nodes LIMIT 1').get();
    if (row) targetNodeId = row.node_id;
  }

  if (!targetNodeId) throw new Error('학습 경로 대상 노드가 없습니다.');

  // BFS로 선수학습 노드부터 순서 생성
  const pathNodeIds = [];
  const visited = new Set();
  const queue = [targetNodeId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const edges = db.prepare('SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?').all(current);
    for (const edge of edges) {
      if (!visited.has(edge.from_node_id)) queue.push(edge.from_node_id);
    }
    pathNodeIds.unshift(current); // 선수학습이 먼저
  }

  // fallback: 같은 과목의 미완료 노드를 학년순으로 채워 넣기
  if (pathNodeIds.length < 3) {
    const status = db.prepare(
      "SELECT node_id FROM user_node_status WHERE user_id = ? AND status = 'completed'"
    ).all(userId).map(r => r.node_id);
    const statusSet = new Set(status);
    const target = db.prepare('SELECT subject, grade FROM learning_map_nodes WHERE node_id = ?').get(targetNodeId);
    const extras = db.prepare(`
      SELECT node_id FROM learning_map_nodes
      WHERE subject = ? ORDER BY grade, semester, sort_order LIMIT 20
    `).all(target ? target.subject : subject || '수학');
    for (const e of extras) {
      if (!pathNodeIds.includes(e.node_id) && !statusSet.has(e.node_id)) {
        pathNodeIds.push(e.node_id);
      }
      if (pathNodeIds.length >= 6) break;
    }
  }

  // Hydrate node info for response
  const placeholders = pathNodeIds.map(() => '?').join(',');
  const nodeDetails = pathNodeIds.length ? db.prepare(`
    SELECT node_id, subject, grade, semester, area, unit_name, lesson_name, achievement_text
    FROM learning_map_nodes WHERE node_id IN (${placeholders})
  `).all(...pathNodeIds) : [];
  const byId = Object.fromEntries(nodeDetails.map(n => [n.node_id, n]));
  const completedSet = new Set(db.prepare(
    "SELECT node_id FROM user_node_status WHERE user_id = ? AND status = 'completed'"
  ).all(userId).map(r => r.node_id));

  const pathSteps = pathNodeIds.map((nid, i) => {
    const info = byId[nid] || {};
    return {
      step: i + 1,
      id: nid,
      node_id: nid,
      title: info.lesson_name || info.unit_name || nid,
      unit_name: info.unit_name,
      subject: info.subject,
      area: info.area,
      grade: info.grade,
      semester: info.semester,
      status: completedSet.has(nid) ? 'completed' : (i === 0 ? 'available' : 'locked')
    };
  });

  try {
    // 기존 active 경로 종료
    db.prepare("UPDATE learning_paths SET status = 'archived' WHERE user_id = ? AND status = 'active'").run(userId);
    const info = db.prepare(`
      INSERT INTO learning_paths (user_id, target_node_id, path_nodes, status)
      VALUES (?, ?, ?, 'active')
    `).run(userId, targetNodeId, JSON.stringify(pathNodeIds));
    return { pathId: info.lastInsertRowid, targetNodeId, pathNodes: pathNodeIds, path: pathSteps };
  } catch (err) {
    // 테이블 구조가 다르거나 INSERT 실패해도 경로 자체는 반환
    return { pathId: null, targetNodeId, pathNodes: pathNodeIds, path: pathSteps, warning: String(err.message) };
  }
}

function getCurrentPath(userId) {
  const path = db.prepare("SELECT * FROM learning_paths WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(userId);
  if (!path) return null;
  let pathNodeIds = [];
  try { pathNodeIds = JSON.parse(path.path_nodes || '[]'); } catch { pathNodeIds = []; }
  path.path_nodes = pathNodeIds;

  // Hydrate to step objects for frontend
  const placeholders = pathNodeIds.map(() => '?').join(',');
  const nodeDetails = pathNodeIds.length ? db.prepare(`
    SELECT node_id, subject, grade, semester, area, unit_name, lesson_name, achievement_text
    FROM learning_map_nodes WHERE node_id IN (${placeholders})
  `).all(...pathNodeIds) : [];
  const byId = Object.fromEntries(nodeDetails.map(n => [n.node_id, n]));
  const completedSet = new Set(db.prepare(
    "SELECT node_id FROM user_node_status WHERE user_id = ? AND status = 'completed'"
  ).all(userId).map(r => r.node_id));
  const currentIdx = path.current_index || 0;

  path.steps = pathNodeIds.map((nid, i) => {
    const info = byId[nid] || {};
    let status = 'locked';
    if (completedSet.has(nid)) status = 'completed';
    else if (i < currentIdx) status = 'completed';
    else if (i === currentIdx) status = 'in_progress';
    else if (i === currentIdx + 1 || i === 0) status = 'available';
    return {
      step: i + 1,
      id: nid,
      node_id: nid,
      title: info.lesson_name || info.unit_name || nid,
      unit_name: info.unit_name,
      subject: info.subject,
      area: info.area,
      grade: info.grade,
      semester: info.semester,
      status
    };
  });
  return path;
}

function completeNode(userId, nodeId) {
  db.prepare(`
    INSERT OR REPLACE INTO user_node_status (user_id, node_id, status, completed_at, last_accessed_at)
    VALUES (?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(userId, nodeId);

  // 경로 진행
  const path = db.prepare("SELECT * FROM learning_paths WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(userId);
  if (path) {
    const nodes = JSON.parse(path.path_nodes || '[]');
    const idx = nodes.indexOf(nodeId);
    if (idx >= 0 && idx === path.current_index) {
      db.prepare('UPDATE learning_paths SET current_index = current_index + 1 WHERE id = ?').run(path.id);
      if (idx + 1 >= nodes.length) {
        db.prepare("UPDATE learning_paths SET status = 'completed' WHERE id = ?").run(path.id);
      }
    }
  }

  logLearningActivity({
    userId, activityType: 'node_complete', targetType: 'learning_node',
    targetId: nodeId, verb: 'completed', sourceService: 'self-learn'
  });

  try { const { awardPoints } = require('./point-helper'); awardPoints(userId, { source: 'node_complete', sourceId: nodeId, points: 10, description: '학습노드 완료 포인트' }); } catch(e) {}

  return { success: true };
}

function getLearningDashboard(userId) {
  const totalNodes = db.prepare('SELECT COUNT(*) as cnt FROM learning_map_nodes WHERE node_level = 2').get().cnt;
  const completedNodes = db.prepare("SELECT COUNT(*) as cnt FROM user_node_status WHERE user_id = ? AND status = 'completed'").get(userId).cnt;
  const inProgressNodes = db.prepare("SELECT COUNT(*) as cnt FROM user_node_status WHERE user_id = ? AND status = 'in_progress'").get(userId).cnt;
  const currentPath = getCurrentPath(userId);
  const recentDiagnosis = db.prepare('SELECT * FROM diagnosis_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 5').all(userId);

  // 전체 풀이수/평균 정답률
  const agg = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct
    FROM problem_attempts WHERE user_id = ?
  `).get(userId) || {};
  const total_solved = agg.total || 0;
  const avg_accuracy = total_solved > 0 ? Math.round((agg.correct / total_solved) * 100) : 0;

  // 연속 학습일 (streak)
  // problem_attempts 의 date(submitted_at) DISTINCT 을 역순으로 조회 후 오늘(또는 어제)부터 연속 카운트
  const dates = db.prepare(`
    SELECT DISTINCT DATE(submitted_at) as d FROM problem_attempts
    WHERE user_id = ? ORDER BY d DESC
  `).all(userId).map(r => r.d);
  // daily_learning_progress 완료일도 포함
  const progressDates = db.prepare(`
    SELECT DISTINCT DATE(completed_at) as d FROM daily_learning_progress
    WHERE user_id = ? AND completed_at IS NOT NULL
  `).all(userId).map(r => r.d).filter(Boolean);
  const dateSet = new Set([...dates, ...progressDates]);
  const sortedDates = [...dateSet].sort((a, b) => b.localeCompare(a));
  let streak = 0;
  if (sortedDates.length > 0) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const yesterday = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
    // 기준일: 오늘 학습 있으면 오늘, 아니면 어제
    let cursor = sortedDates[0] === todayStr ? todayStr
                 : sortedDates[0] === yesterday ? yesterday
                 : null;
    if (cursor) {
      for (const d of sortedDates) {
        if (d === cursor) {
          streak++;
          const prev = new Date(cursor);
          prev.setDate(prev.getDate() - 1);
          cursor = prev.toISOString().slice(0, 10);
        } else if (d < cursor) {
          break;
        }
      }
    }
  }

  // 영역별 통계 (area_stats): 노드의 area 기준 집계 — attempt 당 첫 매칭 노드 1개만 사용
  const areaRows = db.prepare(`
    WITH attempt_area AS (
      SELECT pa.id as aid, pa.is_correct,
             (SELECT n.area FROM learning_map_nodes n
              WHERE n.node_id = COALESCE(
                pa.node_id,
                (SELECT nc.node_id FROM node_contents nc WHERE nc.content_id = pa.content_id LIMIT 1)
              )) as area
      FROM problem_attempts pa
      WHERE pa.user_id = ?
    )
    SELECT area,
           COUNT(*) as total,
           SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct
    FROM attempt_area
    WHERE area IS NOT NULL
    GROUP BY area
    ORDER BY total DESC
  `).all(userId);
  const area_stats = areaRows.map(r => ({
    area: r.area,
    total: r.total || 0,
    correct: r.correct || 0,
    accuracy: r.total ? Math.round((r.correct / r.total) * 100) : 0
  }));

  // 최근 풀이 5건
  const recentRows = db.prepare(`
    SELECT pa.id, pa.content_id, pa.is_correct, pa.submitted_at,
           c.title as title,
           COALESCE(n.unit_name, n.lesson_name) as node_title,
           COALESCE(pa.node_id, nc.node_id) as node_id
    FROM problem_attempts pa
    LEFT JOIN contents c ON c.id = pa.content_id
    LEFT JOIN node_contents nc ON nc.content_id = pa.content_id
    LEFT JOIN learning_map_nodes n ON n.node_id = COALESCE(pa.node_id, nc.node_id)
    WHERE pa.user_id = ?
    GROUP BY pa.id
    ORDER BY pa.submitted_at DESC LIMIT 5
  `).all(userId);
  const recent_problems = recentRows.map(r => ({
    id: r.id,
    content_id: r.content_id,
    title: r.title || '문제',
    is_correct: !!r.is_correct,
    submitted_at: r.submitted_at,
    node_id: r.node_id,
    node_title: r.node_title
  }));

  // 진행률: 경로가 있으면 경로 기준, 없으면 전체 노드 중 완료 비율
  let progressPercent = 0;
  if (currentPath && Array.isArray(currentPath.path_nodes) && currentPath.path_nodes.length > 0) {
    const pathCompleted = db.prepare(`
      SELECT COUNT(*) as cnt FROM user_node_status
      WHERE user_id = ? AND status = 'completed' AND node_id IN (${currentPath.path_nodes.map(() => '?').join(',')})
    `).get(userId, ...currentPath.path_nodes).cnt;
    progressPercent = Math.round((pathCompleted / currentPath.path_nodes.length) * 100);
  } else if (totalNodes > 0) {
    progressPercent = Math.round((completedNodes / totalNodes) * 100);
  }

  return {
    totalNodes, completedNodes, inProgressNodes, currentPath, recentDiagnosis,
    // 확장 필드 — 나의 기록 탭과 상단 카드가 같은 소스(problem_attempts + user_node_status) 사용
    total_solved,
    avg_accuracy,
    total_attempts: total_solved,
    progress_percent: progressPercent,
    progressPercent,
    streak,
    area_stats,
    recent_problems
  };
}

function getRanking({ period, page = 1, limit = 20 } = {}) {
  // 기간 필터: weekly=최근 7일, monthly=최근 30일 (프론트 요청대로)
  let dateFilter = '';
  let paDateFilter = '';
  let diagDateFilter = '';
  if (period === 'week' || period === 'weekly') {
    dateFilter = "AND p.created_at >= DATETIME('now', '-7 days')";
    paDateFilter = "AND submitted_at >= DATETIME('now', '-7 days')";
    diagDateFilter = "AND completed_at >= DATETIME('now', '-7 days')";
  } else if (period === 'month' || period === 'monthly') {
    dateFilter = "AND p.created_at >= DATETIME('now', '-30 days')";
    paDateFilter = "AND submitted_at >= DATETIME('now', '-30 days')";
    diagDateFilter = "AND completed_at >= DATETIME('now', '-30 days')";
  }

  const rankings = db.prepare(`
    SELECT u.id, u.display_name, u.school_name, u.grade,
      COALESCE(SUM(p.points), 0) as total_points,
      (SELECT COUNT(*) FROM user_node_status WHERE user_id = u.id AND status = 'completed') as completed_nodes,
      (SELECT COUNT(*) FROM problem_attempts WHERE user_id = u.id AND is_correct = 1 ${paDateFilter}) as correct_problems,
      (SELECT COUNT(*) FROM problem_attempts WHERE user_id = u.id ${paDateFilter}) as total_attempts,
      (SELECT COUNT(*) FROM diagnosis_sessions WHERE user_id = u.id AND status = 'completed' ${diagDateFilter}) as diagnoses
    FROM users u
    LEFT JOIN user_points p ON u.id = p.user_id ${dateFilter}
    WHERE u.role = 'student'
    GROUP BY u.id
    ORDER BY total_points DESC, correct_problems DESC
    LIMIT ? OFFSET ?
  `).all(limit, (page - 1) * limit);

  return rankings;
}

// ========== 오답노트 확장 ==========

function getWrongNotesExtended(userId, { subject, unit, resolved, period, sort = 'latest', page = 1, limit = 20 } = {}) {
  let where = 'WHERE w.student_id = ?';
  const params = [userId];
  if (subject) { where += ' AND w.subject = ?'; params.push(subject); }
  if (unit) { where += ' AND w.unit_name LIKE ?'; params.push(`%${unit}%`); }
  if (resolved !== undefined) { where += ' AND w.is_resolved = ?'; params.push(resolved ? 1 : 0); }
  if (period) {
    if (period === 'week') where += " AND w.created_at >= DATE('now', '-7 days')";
    else if (period === 'month') where += " AND w.created_at >= DATE('now', '-30 days')";
  }

  let orderBy = 'ORDER BY w.created_at DESC';
  if (sort === 'subject') orderBy = 'ORDER BY w.subject, w.created_at DESC';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM wrong_answers w ${where}`).get(...params).cnt;
  const items = db.prepare(`
    SELECT w.* FROM wrong_answers w ${where} ${orderBy} LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  items.forEach(item => {
    if (item.tags) { try { item.tags = JSON.parse(item.tags); } catch { item.tags = []; } }
  });

  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

function getWrongNoteDashboard(userId) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ?').get(userId).cnt;
  const resolved = db.prepare('SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ? AND is_resolved = 1').get(userId).cnt;
  const bySubject = db.prepare(`
    SELECT subject, COUNT(*) as cnt, SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved_cnt
    FROM wrong_answers WHERE student_id = ? GROUP BY subject
  `).all(userId);

  return { total, resolved, unresolved: total - resolved, resolveRate: total > 0 ? Math.round(resolved / total * 100) : 0, bySubject };
}

function getTeacherWrongNoteDashboard(classId, teacherId) {
  // 학적 기반: 같은 학교+학년+반의 학생만 조회
  const teacher = db.prepare('SELECT school_name, grade, class_number FROM users WHERE id = ?').get(teacherId);
  let students = [];

  if (teacher && teacher.school_name && teacher.grade && teacher.class_number) {
    students = db.prepare(`
      SELECT u.id, u.display_name, u.username,
        (SELECT COUNT(*) FROM wrong_answers WHERE student_id = u.id) as total_wrong,
        (SELECT COUNT(*) FROM wrong_answers WHERE student_id = u.id AND is_resolved = 1) as resolved_wrong
      FROM users u
      WHERE u.role = 'student' AND u.school_name = ? AND u.grade = ? AND u.class_number = ?
      ORDER BY total_wrong DESC
    `).all(teacher.school_name, teacher.grade, teacher.class_number);
  } else if (classId) {
    // 학적 정보 없으면 기존 채움클래스 기반 폴백
    students = db.prepare(`
      SELECT u.id, u.display_name, u.username,
        (SELECT COUNT(*) FROM wrong_answers WHERE student_id = u.id) as total_wrong,
        (SELECT COUNT(*) FROM wrong_answers WHERE student_id = u.id AND is_resolved = 1) as resolved_wrong
      FROM class_members cm JOIN users u ON cm.user_id = u.id
      WHERE cm.class_id = ? AND cm.role = 'member'
      ORDER BY total_wrong DESC
    `).all(classId);
  }

  // 과목별 오답 분포 (학급 전체)
  const studentIds = students.map(s => s.id);
  let bySubject = [];
  if (studentIds.length) {
    bySubject = db.prepare(`
      SELECT subject, COUNT(*) as cnt, SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved_cnt
      FROM wrong_answers WHERE student_id IN (${studentIds.join(',')}) GROUP BY subject
    `).all();
  }

  return { students, bySubject, schoolName: teacher?.school_name, grade: teacher?.grade, classNumber: teacher?.class_number };
}

function addManualWrongNote(userId, data) {
  const info = db.prepare(`
    INSERT INTO wrong_answers (student_id, question_text, student_answer, correct_answer, explanation, subject, unit_name, tags, is_manual, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual')
  `).run(userId, data.questionText, data.studentAnswer || null, data.correctAnswer || null,
    data.explanation || null, data.subject || null, data.unitName || null,
    data.tags ? JSON.stringify(data.tags) : null);
  return { id: info.lastInsertRowid };
}

function updateWrongNoteTags(id, userId, tags) {
  db.prepare('UPDATE wrong_answers SET tags = ? WHERE id = ? AND student_id = ?')
    .run(JSON.stringify(tags), id, userId);
}

function retryWrongNote(id, userId, { answer }) {
  const note = db.prepare('SELECT * FROM wrong_answers WHERE id = ? AND student_id = ?').get(id, userId);
  if (!note) return null;

  const isCorrect = answer === note.correct_answer;
  if (isCorrect) {
    db.prepare('UPDATE wrong_answers SET is_resolved = 1 WHERE id = ?').run(id);
    const pts = parseInt(getSetting('wrong_note_resolve_point') || '5');
    awardPoints(userId, { source: 'wrong_note', sourceId: id, points: pts, description: '오답 해결' });
  }
  db.prepare('UPDATE wrong_answers SET attempt_count = attempt_count + 1 WHERE id = ?').run(id);

  logLearningActivity({
    userId, activityType: 'wrong_note_retry', targetType: 'wrong_answer',
    targetId: id, verb: 'attempted', sourceService: 'self-learn',
    resultSuccess: isCorrect ? 1 : 0
  });

  return { isCorrect, resolved: isCorrect };
}

// ========== 나만의 문제집 ==========

function getProblemSets(userId) {
  return db.prepare(`
    SELECT ps.*, (SELECT COUNT(*) FROM problem_set_items WHERE problem_set_id = ps.id) as item_count,
      (SELECT COUNT(*) FROM problem_set_attempts WHERE problem_set_id = ps.id AND user_id = ?) as attempt_count
    FROM problem_sets ps WHERE ps.user_id = ? ORDER BY ps.updated_at DESC
  `).all(userId, userId);
}

function createProblemSet(userId, { title, description, subject }) {
  const info = db.prepare(`
    INSERT INTO problem_sets (user_id, title, description, subject)
    VALUES (?, ?, ?, ?)
  `).run(userId, title, description || null, subject || null);
  const set = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(info.lastInsertRowid);
  return { id: info.lastInsertRowid, set };
}

function getProblemSetDetail(id, userId) {
  const set = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(id);
  if (!set) return null;
  const items = db.prepare(`
    SELECT psi.*, c.title, c.content_type, c.description
    FROM problem_set_items psi JOIN contents c ON psi.content_id = c.id
    WHERE psi.problem_set_id = ? ORDER BY psi.sort_order
  `).all(id);
  const attempts = db.prepare('SELECT * FROM problem_set_attempts WHERE problem_set_id = ? AND user_id = ? ORDER BY started_at DESC').all(id, userId);
  return { set, items, attempts };
}

function addProblemSetItem(setId, contentId) {
  try {
    // 중복 체크
    const exists = db.prepare('SELECT id FROM problem_set_items WHERE problem_set_id = ? AND content_id = ?').get(setId, contentId);
    if (exists) return { success: false, message: '이미 추가된 문항입니다.' };
    db.prepare('INSERT INTO problem_set_items (problem_set_id, content_id) VALUES (?, ?)').run(setId, contentId);
    db.prepare('UPDATE problem_sets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(setId);
    return { success: true };
  } catch (e) { return { success: false, message: e.message || '추가 실패' }; }
}

function removeProblemSetItem(setId, contentId) {
  db.prepare('DELETE FROM problem_set_items WHERE problem_set_id = ? AND content_id = ?').run(setId, contentId);
  db.prepare('UPDATE problem_sets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(setId);
}

function startProblemSet(id, userId) {
  const items = db.prepare('SELECT * FROM problem_set_items WHERE problem_set_id = ? ORDER BY sort_order').all(id);
  const info = db.prepare(`
    INSERT INTO problem_set_attempts (problem_set_id, user_id, total_questions)
    VALUES (?, ?, ?)
  `).run(id, userId, items.length);
  return { attemptId: info.lastInsertRowid, items };
}

function submitProblemSet(id, userId, { answers }) {
  const items = db.prepare('SELECT * FROM problem_set_items WHERE problem_set_id = ? ORDER BY sort_order').all(id);
  const correctCount = answers ? answers.filter(a => a.isCorrect).length : 0;
  const scorePercent = items.length > 0 ? Math.round(correctCount / items.length * 100) : 0;

  db.prepare(`
    UPDATE problem_set_attempts
    SET correct_count = ?, score_percent = ?, answers = ?, completed_at = CURRENT_TIMESTAMP
    WHERE problem_set_id = ? AND user_id = ? AND completed_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).run(correctCount, scorePercent, JSON.stringify(answers || []), id, userId);

  logLearningActivity({
    userId, activityType: 'problem_set_complete', targetType: 'problem_set',
    targetId: id, verb: 'completed', sourceService: 'self-learn',
    resultScore: scorePercent / 100, resultSuccess: scorePercent >= 60 ? 1 : 0
  });

  try { const { awardPoints } = require('./point-helper'); awardPoints(userId, { source: 'problem_set', sourceId: id, points: 15, description: '문제집 완료 포인트' }); } catch(e) {}

  return { correctCount, totalQuestions: items.length, scorePercent };
}

// 학생/교사용: 특정 사용자의 오늘의 학습 항목 정오답 결과 조회
function getDailyItemResult(itemId, userId) {
  const item = db.prepare(`
    SELECT i.*, s.title AS set_title, s.target_date
    FROM daily_learning_items i
    JOIN daily_learning_sets s ON i.set_id = s.id
    WHERE i.id = ?
  `).get(itemId);
  if (!item) return null;

  const progress = db.prepare(`
    SELECT status, score, completed_at, time_spent_seconds, answers_json, correct_count, total_questions
    FROM daily_learning_progress
    WHERE user_id = ? AND item_id = ?
  `).get(userId, itemId);

  let answers = [];
  if (progress?.answers_json) {
    try { answers = JSON.parse(progress.answers_json); } catch(e) { answers = []; }
  }

  // 정오답 데이터가 없으면 content_questions에서 정답만 반환 (학생이 풀이 안 함)
  let questions = [];
  if (item.source_type === 'content' && item.content_id) {
    questions = db.prepare(`
      SELECT id, question_number, question_text, options, answer, explanation, points
      FROM content_questions WHERE content_id = ?
      ORDER BY question_number, id
    `).all(item.content_id).map(q => {
      let opts = [];
      try { opts = JSON.parse(q.options || '[]'); } catch(e) { opts = []; }
      return { ...q, options: opts };
    });
  }

  return {
    item: {
      id: item.id, title: item.item_title, source_type: item.source_type,
      content_id: item.content_id, set_id: item.set_id,
      set_title: item.set_title, target_date: item.target_date
    },
    progress: progress || null,
    answers,  // [{questionNumber, questionText, options, myAnswer, correctAnswer, isCorrect, ...}]
    questions  // 정답지 (answers가 비어있을 때 fallback)
  };
}

// ========== P0: 문제 풀이 시도 / 비디오 진행도 / 학습목록 / 이어하기 / 오류신고 ==========

function _upsertLastActivity(userId, { activity_type, node_id, content_id, title }) {
  db.prepare(`
    INSERT INTO user_last_activity (user_id, activity_type, node_id, content_id, title, accessed_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      activity_type = excluded.activity_type,
      node_id = excluded.node_id,
      content_id = excluded.content_id,
      title = excluded.title,
      accessed_at = CURRENT_TIMESTAMP
  `).run(userId, activity_type, node_id || null, content_id || null, title || null);
}

function recordProblemAttempt(userId, contentId, { isCorrect, selectedAnswer, userAnswer, answer, questionId, timeTaken, nodeId }) {
  // 서버 측 정답 판정: questionId가 있으면 content_questions.answer와 비교 (client isCorrect 무시)
  // questionId 없으면 content 단위 제출로 간주하여 기존 client isCorrect 유지 (호환성)
  const submittedAnswer = selectedAnswer ?? userAnswer ?? answer ?? null;
  let finalIsCorrect;
  let questionExplanation = null;
  let correctAnswer = null;
  if (questionId) {
    const q = db.prepare('SELECT answer, explanation FROM content_questions WHERE id = ?').get(questionId);
    if (q) {
      finalIsCorrect = String(q.answer).trim() === String(submittedAnswer || '').trim() ? 1 : 0;
      questionExplanation = q.explanation || null;
      correctAnswer = q.answer;
    } else {
      finalIsCorrect = isCorrect ? 1 : 0;
    }
  } else {
    // questionId 없을 때 content 단위 대표 문항에서 해설만 조회
    const q = db.prepare('SELECT answer, explanation FROM content_questions WHERE content_id = ? ORDER BY question_number LIMIT 1').get(contentId);
    if (q) { questionExplanation = q.explanation || null; correctAnswer = q.answer; }
    finalIsCorrect = isCorrect ? 1 : 0;
  }

  const info = db.prepare(`
    INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, selected_answer, time_taken)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, contentId, nodeId || null, finalIsCorrect, submittedAnswer, timeTaken || null);
  isCorrect = !!finalIsCorrect;

  // 제목 fetch
  const ct = db.prepare('SELECT title FROM contents WHERE id = ?').get(contentId);
  _upsertLastActivity(userId, { activity_type: 'problem', node_id: nodeId, content_id: contentId, title: ct?.title });

  // 전체 정답률 + top clearers 재계산
  const agg = db.prepare(`SELECT COUNT(*) as t, SUM(is_correct) as c FROM problem_attempts WHERE content_id = ?`).get(contentId);
  const correctRate = agg.t > 0 ? Math.round((agg.c / agg.t) * 100) : 0;
  const topClearers = db.prepare(`
    SELECT u.display_name as name, MIN(pa.time_taken) as time_sec
    FROM problem_attempts pa JOIN users u ON pa.user_id = u.id
    WHERE pa.content_id = ? AND pa.is_correct = 1
    GROUP BY pa.user_id ORDER BY time_sec ASC NULLS LAST LIMIT 3
  `).all(contentId);

  // 로깅 & 포인트 (정답 시 소량)
  try {
    logLearningActivity({
      userId, activityType: 'problem_attempt', targetType: 'content',
      targetId: contentId, verb: isCorrect ? 'passed' : 'attempted', sourceService: 'self-learn',
      resultSuccess: isCorrect ? 1 : 0
    });
    if (isCorrect) awardPoints(userId, { source: 'problem_attempt', sourceId: contentId, points: 2, description: '문제 정답' });
  } catch (e) {}

  // 노드별 사용자 correct_rate 갱신 (해당 노드 범위의 내 시도 기준)
  if (nodeId) {
    try {
      const mine = db.prepare(`
        SELECT COUNT(*) as t, SUM(is_correct) as c
        FROM problem_attempts WHERE user_id = ? AND node_id = ?
      `).get(userId, nodeId);
      const myRate = mine.t > 0 ? Math.round((mine.c / mine.t) * 100) : 0;
      db.prepare(`
        INSERT INTO user_node_status (user_id, node_id, status, correct_rate, last_accessed_at)
        VALUES (?, ?, 'in_progress', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, node_id) DO UPDATE SET
          correct_rate = excluded.correct_rate,
          last_accessed_at = CURRENT_TIMESTAMP
      `).run(userId, nodeId, myRate);
    } catch (e) { /* 노드 상태 갱신 실패 무시 */ }
  }

  return {
    attemptId: info.lastInsertRowid,
    attempt_id: info.lastInsertRowid,
    correct: !!finalIsCorrect,
    isCorrect: !!finalIsCorrect,
    correctAnswer,
    explanation: questionExplanation,
    correctRate,
    top_clearers: topClearers
  };
}

function recordVideoProgress(userId, contentId, { positionSec, durationSec, nodeId }) {
  const ratio = durationSec && durationSec > 0 ? Math.min(1, positionSec / durationSec) : 0;
  db.prepare(`
    INSERT INTO user_content_progress (user_id, content_id, node_id, position_sec, duration_sec, watch_ratio, view_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, content_id) DO UPDATE SET
      position_sec = excluded.position_sec,
      duration_sec = MAX(user_content_progress.duration_sec, excluded.duration_sec),
      watch_ratio = MAX(user_content_progress.watch_ratio, excluded.watch_ratio),
      view_count = user_content_progress.view_count + 1,
      node_id = COALESCE(excluded.node_id, user_content_progress.node_id),
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, contentId, nodeId || null, positionSec || 0, durationSec || 0, ratio);

  const ct = db.prepare('SELECT title FROM contents WHERE id = ?').get(contentId);
  _upsertLastActivity(userId, { activity_type: 'video', node_id: nodeId, content_id: contentId, title: ct?.title });

  // 시청 완료 임계(0.8) 달성 시 노드 상태 갱신 (terminal 상태는 보존)
  let nodeCompleted = false;
  if (nodeId && ratio >= 0.8) {
    const existing = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?').get(userId, nodeId);
    const terminal = new Set(['completed', 'mastered']);
    if (!existing || !terminal.has(existing.status)) {
      db.prepare(`
        INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at)
        VALUES (?, ?, 'video_watched', CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, node_id) DO UPDATE SET
          status = CASE WHEN user_node_status.status IN ('completed','mastered')
                        THEN user_node_status.status ELSE 'video_watched' END,
          last_accessed_at = CURRENT_TIMESTAMP
      `).run(userId, nodeId);
      nodeCompleted = true;
    }
  }

  return { watch_ratio: ratio, position_sec: positionSec || 0, duration_sec: durationSec || 0, node_watched: nodeCompleted };
}

// 학습목록
function getLearningList(userId) {
  const rows = db.prepare(`
    SELECT ull.id, ull.node_id, ull.added_at,
      n.subject, n.grade, n.semester, n.unit_name, n.lesson_name, n.achievement_code,
      COALESCE(s.status, 'not_started') as user_status, s.correct_rate
    FROM user_learning_list ull
    LEFT JOIN learning_map_nodes n ON ull.node_id = n.node_id
    LEFT JOIN user_node_status s ON s.user_id = ull.user_id AND s.node_id = ull.node_id
    WHERE ull.user_id = ?
    ORDER BY ull.added_at DESC
  `).all(userId);
  // 사용자에게 내부 ID가 노출되지 않도록 제목(title) 필드를 보강
  return rows.map(r => ({
    ...r,
    title: r.lesson_name || r.unit_name || '삭제된 학습 노드',
    orphan: !r.unit_name && !r.lesson_name
  }));
}

function addLearningList(userId, nodeId) {
  try {
    const info = db.prepare('INSERT OR IGNORE INTO user_learning_list (user_id, node_id) VALUES (?, ?)').run(userId, nodeId);
    return { success: true, added: info.changes > 0 };
  } catch (e) { return { success: false, message: e.message }; }
}

function removeLearningList(userId, nodeId) {
  db.prepare('DELETE FROM user_learning_list WHERE user_id = ? AND node_id = ?').run(userId, nodeId);
  return { success: true };
}

function getLastActivity(userId) {
  const row = db.prepare('SELECT activity_type as type, node_id, content_id, title, accessed_at FROM user_last_activity WHERE user_id = ?').get(userId);
  return row || null;
}

function reportContent(userId, contentId, { reason, details, contentType }) {
  const info = db.prepare(`
    INSERT INTO content_reports (user_id, content_id, content_type, reason, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, contentId, contentType || null, reason || 'other', details || null);
  return { success: true, reportId: info.lastInsertRowid };
}

// ========== CAT 진단 확장 ==========

function _pickQuestionForNode(nodeId, difficulty) {
  // node_contents에서 problem 타입 content 중 난이도 맞는 것 선택
  const problemTypes = "('quiz','exam','problem','assessment')";
  const candidates = db.prepare(`
    SELECT c.id as content_id, c.title, c.difficulty
    FROM node_contents nc JOIN contents c ON nc.content_id = c.id
    WHERE nc.node_id = ? AND c.content_type IN ${problemTypes}
  `).all(nodeId);
  if (candidates.length === 0) return null;

  // 난이도 매칭 우선
  const diffMatch = candidates.filter(c => (c.difficulty || 'medium') === difficulty);
  const pool = diffMatch.length > 0 ? diffMatch : candidates;
  const picked = pool[Math.floor(Math.random() * pool.length)];

  // 실제 question 1개 선택
  const q = db.prepare(`
    SELECT id, question_number, question_text, options, answer, explanation, difficulty, points
    FROM content_questions WHERE content_id = ? ORDER BY RANDOM() LIMIT 1
  `).get(picked.content_id);

  if (!q) return null;

  let opts = [];
  try { opts = q.options ? JSON.parse(q.options) : []; } catch { opts = []; }

  return {
    // snake_case (하위 호환)
    content_id: picked.content_id,
    content_title: picked.title,
    question_id: q.id,
    question_number: q.question_number,
    question_text: q.question_text,
    options: opts,
    answer: q.answer,
    explanation: q.explanation,
    difficulty: q.difficulty || difficulty,
    points: q.points,
    node_id: nodeId,
    // camelCase (프론트 신규 API)
    contentId: picked.content_id,
    questionId: q.id,
    title: picked.title,
    questionText: q.question_text,
    nodeId: nodeId
  };
}

function startDiagnosisCAT(userId, { targetNodeId, subject, type }) {
  // targetNodeId 지정 시 BFS로 직전 선수노드 큐 생성
  let nodeId = targetNodeId;
  if (!nodeId && subject) {
    const first = db.prepare('SELECT node_id FROM learning_map_nodes WHERE subject = ? ORDER BY grade, semester, sort_order LIMIT 1').get(subject);
    nodeId = first?.node_id;
  }
  if (!nodeId) {
    const any = db.prepare('SELECT node_id FROM learning_map_nodes LIMIT 1').get();
    nodeId = any?.node_id;
  }
  if (!nodeId) throw new Error('진단 가능한 노드가 없습니다.');

  // BFS: 직전 선수노드 큐 (bottom-up)
  const queue = [];
  const visited = new Set([nodeId]);
  let frontier = [nodeId];
  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const cur of frontier) {
      const edges = db.prepare('SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?').all(cur);
      for (const e of edges) {
        if (!visited.has(e.from_node_id)) {
          visited.add(e.from_node_id);
          queue.push(e.from_node_id);
          nextFrontier.push(e.from_node_id);
        }
      }
    }
    frontier = nextFrontier;
    if (queue.length > 10) break; // 상한
  }
  // 큐: [targetNodeId, ...선수노드들] — 타겟부터 풀어나가되 실패 시 drill down
  const fullQueue = [nodeId, ...queue];

  const difficultyPath = [];
  const perNodeAnswers = {};

  const info = db.prepare(`
    INSERT INTO diagnosis_sessions
      (user_id, target_node_id, diagnosis_type, status, total_questions,
       queue_nodes, current_node_id, current_difficulty, difficulty_path, per_node_answers)
    VALUES (?, ?, ?, 'in_progress', 0, ?, ?, 'medium', ?, ?)
  `).run(userId, nodeId, type || 'cat',
    JSON.stringify(fullQueue), nodeId,
    JSON.stringify(difficultyPath),
    JSON.stringify(perNodeAnswers));

  // 큐 상의 노드 중 문항이 있는 첫 노드 탐색
  let question = null;
  let startNodeId = nodeId;
  for (const qn of fullQueue) {
    const cand = _pickQuestionForNode(qn, 'medium');
    if (cand) { question = cand; startNodeId = qn; break; }
  }
  // 탐색 결과 시작 노드가 바뀌면 current_node_id 갱신
  if (startNodeId !== nodeId) {
    db.prepare('UPDATE diagnosis_sessions SET current_node_id = ? WHERE id = ?')
      .run(startNodeId, info.lastInsertRowid);
  }

  return {
    sessionId: info.lastInsertRowid,
    currentNodeId: startNodeId,
    currentDifficulty: 'medium',
    queueNodes: fullQueue,
    question // null 가능 — 프론트에서 데모 문항으로 합성
  };
}

function submitDiagnosisAnswerCAT(sessionId, payload = {}) {
  // snake_case/camelCase 모두 지원
  const contentId = payload.contentId != null ? payload.contentId : payload.content_id;
  const questionId = payload.questionId != null ? payload.questionId : payload.question_id;
  const answer = payload.answer;
  const nodeId = payload.nodeId || payload.node_id;
  const clientIsCorrect = payload.isCorrect !== undefined ? payload.isCorrect : payload.is_correct;

  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('세션 없음');
  if (session.status === 'completed') return { sessionComplete: true };

  // 서버 정답 판정 (DB의 정답과 비교) — clientIsCorrect는 신뢰하지 않음
  let isCorrect = false;
  if (questionId) {
    const q = db.prepare('SELECT answer FROM content_questions WHERE id = ?').get(questionId);
    if (q && String(q.answer).trim() === String(answer || '').trim()) isCorrect = true;
  } else if (clientIsCorrect !== undefined) {
    // 호환성: questionId 없이 client가 판정한 경우만 fallback
    isCorrect = !!clientIsCorrect;
  }

  // current_node_id 누락 방어 (null이면 nodeId 파라미터 → target_node_id 순으로 보강)
  const curNode = session.current_node_id || nodeId || session.target_node_id || 'unknown';
  const curDiff = session.current_difficulty || 'medium';

  // 답안 기록 — FK 방어 (contents.id에 있는 값으로 보정)
  const safeContentId = resolveValidContentId(contentId, questionId);
  try {
    db.prepare(`
      INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, curNode, safeContentId, String(answer || ''), isCorrect ? 1 : 0);
  } catch (e) {
    if (String(e.message).includes('FOREIGN KEY')) {
      const anyContent = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get();
      db.prepare(`
        INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, curNode, anyContent ? anyContent.id : 1, String(answer || ''), isCorrect ? 1 : 0);
    } else {
      throw e;
    }
  }

  if (isCorrect) {
    db.prepare('UPDATE diagnosis_sessions SET correct_count = correct_count + 1, total_questions = total_questions + 1 WHERE id = ?').run(sessionId);
  } else {
    db.prepare('UPDATE diagnosis_sessions SET total_questions = total_questions + 1 WHERE id = ?').run(sessionId);
  }

  // per_node_answers 업데이트 (노드별 최근 응답 이력)
  let perNodeAnswers = {};
  try { perNodeAnswers = JSON.parse(session.per_node_answers || '{}'); } catch {}
  if (!perNodeAnswers[curNode]) perNodeAnswers[curNode] = [];
  perNodeAnswers[curNode].push({ correct: isCorrect ? 1 : 0, difficulty: curDiff });

  // 난이도 경로
  let difficultyPath = [];
  try { difficultyPath = JSON.parse(session.difficulty_path || '[]'); } catch {}
  difficultyPath.push({ node: curNode, difficulty: curDiff, correct: isCorrect ? 1 : 0 });

  // 연속 2정답→hard, 연속 2오답→easy
  const nodeHist = perNodeAnswers[curNode];
  let nextDiff = curDiff;
  const last2 = nodeHist.slice(-2);
  if (last2.length === 2) {
    if (last2.every(a => a.correct === 1)) {
      nextDiff = curDiff === 'easy' ? 'medium' : 'hard';
    } else if (last2.every(a => a.correct === 0)) {
      nextDiff = curDiff === 'hard' ? 'medium' : 'easy';
    }
  }

  // 노드당 3~5문항 후 통과/실패 판정
  let queue = [];
  try { queue = JSON.parse(session.queue_nodes || '[]'); } catch {}

  let nodeFinished = false;
  let nodePassed = null;
  if (nodeHist.length >= 3) {
    const correct = nodeHist.filter(a => a.correct === 1).length;
    const rate = correct / nodeHist.length;
    if (nodeHist.length >= 5 || rate >= 0.8 || rate <= 0.2) {
      nodeFinished = true;
      nodePassed = rate >= 0.6;
    }
  }

  let nextNodeId = curNode;
  let nextQuestion = null;
  let sessionComplete = false;

  if (nodeFinished) {
    // 노드 상태 저장
    db.prepare(`
      INSERT OR REPLACE INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(session.user_id, curNode,
      nodePassed ? 'completed' : 'in_progress',
      nodePassed ? 'mastered' : 'needs_review',
      nodeHist.filter(a => a.correct === 1).length / nodeHist.length);

    // 큐에서 현재 제거하고 다음 노드
    queue = queue.filter(q => q !== curNode);
    if (queue.length === 0) {
      sessionComplete = true;
    } else {
      nextNodeId = queue[0];
      nextDiff = 'medium';
      nextQuestion = _pickQuestionForNode(nextNodeId, nextDiff);
    }
  } else {
    // 같은 노드 계속 — 다음 난이도 문항
    nextQuestion = _pickQuestionForNode(curNode, nextDiff);
  }

  // 세션 갱신
  db.prepare(`
    UPDATE diagnosis_sessions SET
      queue_nodes = ?, current_node_id = ?, current_difficulty = ?,
      difficulty_path = ?, per_node_answers = ?,
      status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).run(JSON.stringify(queue), nextNodeId, nextDiff,
    JSON.stringify(difficultyPath), JSON.stringify(perNodeAnswers),
    sessionComplete ? 1 : 0, sessionComplete ? 1 : 0, sessionId);

  // 세션 완료 시 노드별 결과 집계 (프론트 결과 화면용)
  let nodeResults = null;
  if (sessionComplete) {
    nodeResults = Object.keys(perNodeAnswers).map(nodeId => {
      const hist = perNodeAnswers[nodeId] || [];
      const correct = hist.filter(a => a.correct === 1).length;
      const total = hist.length;
      const rate = total > 0 ? correct / total : 0;
      const passed = rate >= 0.6;
      // Hydrate node title
      const nodeInfo = db.prepare('SELECT unit_name, lesson_name, area, grade FROM learning_map_nodes WHERE node_id = ?').get(nodeId) || {};
      return {
        nodeId,
        node_id: nodeId,
        title: nodeInfo.lesson_name || nodeInfo.unit_name || nodeId,
        area: nodeInfo.area,
        grade: nodeInfo.grade,
        passed,
        correctCount: correct,
        totalCount: total,
        correctRate: Math.round(rate * 100)
      };
    });
  }

  return {
    isCorrect,
    nodeFinished,
    nodePassed,
    nextNodeId,
    nextDifficulty: nextDiff,
    question: nextQuestion,          // 하위 호환
    nextQuestion: nextQuestion,      // 프론트 신규 필드
    finished: sessionComplete,       // 프론트 호환 (data.finished 체크)
    sessionComplete,
    queueRemaining: queue.length,
    nodeResults                      // 완료 시 노드별 통과/실패 집계
  };
}

function drillDownDiagnosis(sessionId, failedNodeId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('세션 없음');
  let queue = [];
  try { queue = JSON.parse(session.queue_nodes || '[]'); } catch {}

  // 실패 노드의 직전 선수노드를 큐 앞에 추가
  const prereqs = db.prepare('SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?').all(failedNodeId).map(r => r.from_node_id);
  const added = [];
  for (const p of prereqs) {
    if (!queue.includes(p)) {
      queue.unshift(p);
      added.push(p);
    }
  }
  db.prepare('UPDATE diagnosis_sessions SET queue_nodes = ?, current_node_id = ?, current_difficulty = ? WHERE id = ?')
    .run(JSON.stringify(queue), queue[0], 'medium', sessionId);
  const q = _pickQuestionForNode(queue[0], 'medium');
  return { addedNodes: added, currentNodeId: queue[0], question: q, queueRemaining: queue.length };
}

function getNextDiagnosisQuestion(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  if (session.status === 'completed') {
    return { sessionComplete: true, question: null, nextQuestion: null };
  }
  const curNode = session.current_node_id || session.target_node_id;
  const curDiff = session.current_difficulty || 'medium';
  const q = curNode ? _pickQuestionForNode(curNode, curDiff) : null;
  return {
    sessionComplete: false,
    currentNodeId: curNode,
    currentDifficulty: curDiff,
    question: q,
    nextQuestion: q
  };
}

function getDiagnosisState(sessionId) {
  const s = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!s) return null;
  let queue = [], perNode = {}, path = [];
  try { queue = JSON.parse(s.queue_nodes || '[]'); } catch {}
  try { perNode = JSON.parse(s.per_node_answers || '{}'); } catch {}
  try { path = JSON.parse(s.difficulty_path || '[]'); } catch {}
  return {
    sessionId: s.id,
    status: s.status,
    currentNodeId: s.current_node_id,
    currentDifficulty: s.current_difficulty,
    queueNodes: queue,
    queueRemaining: queue.length,
    perNodeAnswers: perNode,
    difficultyPath: path,
    totalQuestions: s.total_questions,
    correctCount: s.correct_count,
    targetNodeId: s.target_node_id
  };
}

module.exports = {
  init,
  getDailySets, getDailySetDetail, startDailyItem, completeDailyItem, getDailyStats,
  getDailyItemResult,
  createDailySet, updateDailySet, addDailyItem, removeDailyItem,
  getMapNodes, getMapNodeDetail, getMapEdges, getUserNodeStatuses,
  startDiagnosis, submitDiagnosisAnswer, finishDiagnosis, getDiagnosisResult,
  startDiagnosisCAT, submitDiagnosisAnswerCAT, drillDownDiagnosis, getDiagnosisState,
  getNextDiagnosisQuestion,
  generateLearningPath, getCurrentPath, completeNode, getLearningDashboard, getRanking,
  getWrongNotesExtended, getWrongNoteDashboard, getTeacherWrongNoteDashboard,
  addManualWrongNote, updateWrongNoteTags, retryWrongNote,
  getProblemSets, createProblemSet, getProblemSetDetail,
  addProblemSetItem, removeProblemSetItem, startProblemSet, submitProblemSet,
  // P0 추가
  recordProblemAttempt, recordVideoProgress,
  getLearningList, addLearningList, removeLearningList,
  getLastActivity, reportContent
};
