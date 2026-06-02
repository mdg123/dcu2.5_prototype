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
        source_type VARCHAR(20),
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

  // ── 성취수준 6출처 집계: problem_attempts.source_type 컬럼 신설 + 1회성 백필 ──
  // source_type 값: 'today_learning' | 'ai_learning' | 'wrong_note' | 'content'
  //  - ai_learning : node_id ≠ null (AI 맞춤학습/학습맵 경로 문항)
  //  - content     : node_id = null  (채움콘텐츠 내 단발 문항)
  //  - wrong_note  : 오답노트 재풀이 기록 (Phase 3에서 신규 INSERT)
  //  - today_learning 은 daily_learning_progress 가 정본이므로 problem_attempts 에는 기록하지 않음
  try {
    const paCols = db.prepare('PRAGMA table_info(problem_attempts)').all().map(c => c.name);
    if (!paCols.includes('source_type')) {
      db.exec('ALTER TABLE problem_attempts ADD COLUMN source_type VARCHAR(20)');
      // 기존 데이터 백필: node_id ≠ null → 'ai_learning', 그 외 → 'content'
      // (과거 기록에는 오답노트 재풀이가 없으므로 wrong_note 백필 대상 없음)
      const r1 = db.prepare("UPDATE problem_attempts SET source_type = 'ai_learning' WHERE node_id IS NOT NULL AND source_type IS NULL").run();
      const r2 = db.prepare("UPDATE problem_attempts SET source_type = 'content' WHERE node_id IS NULL AND source_type IS NULL").run();
      console.log(`[self-learn init] problem_attempts.source_type 백필 완료 — ai_learning:${r1.changes}, content:${r2.changes}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_pa_source ON problem_attempts(source_type)');
  } catch (e) { console.error('[self-learn init] source_type migration error:', e.message); }

  // 추천학습 경로 시스템 (2026-05-27) — learning_paths 확장 (옵션 A)
  // 진단 세션별 독립된 경로를 보존하기 위해 session_id, source_type 추가
  const lpCols = [
    'session_id INTEGER',                      // diagnosis_sessions.id 참조 (FK 없이)
    "source_type TEXT DEFAULT 'manual'"        // 'diagnosis' | 'manual' | 'teacher_assigned'
  ];
  for (const col of lpCols) {
    try { db.exec(`ALTER TABLE learning_paths ADD COLUMN ${col}`); } catch (e) { /* exists */ }
  }
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lp_session ON learning_paths(session_id);
      CREATE INDEX IF NOT EXISTS idx_lp_user_status ON learning_paths(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_lp_source_type ON learning_paths(source_type);
    `);
  } catch (e) { console.error('[self-learn init] lp index error:', e.message); }
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
      c.title as content_title, c.content_type, c.content_url, c.file_path, c.description as content_desc,
      c.unit_name as content_unit_name, c.theme as content_theme
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

// 영상·자료 시청 항목은 점수 없음 — 정책 일관 (매트릭스 셀 표시 정책)
// 시청형(video/document/image/external/audio)에는 score=null을 강제하여 오염 차단.
const NON_SCORED_CONTENT_TYPES = new Set(['video','document','image','external','audio']);
function normalizeProgressScore(itemId, score) {
  if (score == null) return null;
  try {
    const row = db.prepare(`
      SELECT c.content_type
        FROM daily_learning_items i
        LEFT JOIN contents c ON c.id = i.content_id
       WHERE i.id = ?
    `).get(itemId);
    if (row && row.content_type && NON_SCORED_CONTENT_TYPES.has(String(row.content_type).toLowerCase())) {
      return null;
    }
  } catch (_) { /* fail-open: 조회 실패 시 원래 점수 유지 */ }
  return score;
}

function completeDailyItem(itemId, userId, { score, timeSpent, answers, correctCount, totalQuestions } = {}) {
  const item = db.prepare('SELECT * FROM daily_learning_items WHERE id = ?').get(itemId);
  if (!item) return null;
  // 중복 완료 처리 방지: 이미 completed면 포인트 재지급/로그 반복 안 함
  const prev = db.prepare("SELECT status FROM daily_learning_progress WHERE user_id=? AND item_id=?").get(userId, itemId);
  const wasCompleted = prev && prev.status === 'completed';
  // 정오답 상세(answers): [{questionNumber, questionText, options, myAnswer, correctAnswer, isCorrect, explanation}, ...]
  const answersJson = Array.isArray(answers) && answers.length > 0 ? JSON.stringify(answers) : null;
  // 영상·자료 시청 항목은 점수 없음 — 정책 가드 (매트릭스 셀 표시 정책)
  const safeScore = normalizeProgressScore(itemId, score);
  db.prepare(`
    UPDATE daily_learning_progress
    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, score = ?, time_spent_seconds = ?,
        answers_json = COALESCE(?, answers_json),
        correct_count = COALESCE(?, correct_count),
        total_questions = COALESCE(?, total_questions)
    WHERE user_id = ? AND item_id = ?
  `).run(safeScore ?? null, timeSpent || 0, answersJson, correctCount ?? null, totalQuestions ?? null, userId, itemId);

  if (wasCompleted) {
    return { success: true, alreadyCompleted: true };
  }

  logLearningActivity({
    userId, activityType: 'daily_complete', targetType: 'daily_learning',
    targetId: itemId, verb: 'completed', sourceService: 'self-learn',
    resultScore: safeScore ? safeScore / 100 : null
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
    // 0~1 단위로 통일 (UI에서 ×100 해서 % 표시)
    const correctRate = total > 0 ? (correct / total) : 0;
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
    INSERT INTO diagnosis_sessions (user_id, target_node_id, diagnosis_type, status, total_questions, queue_nodes, current_node_id)
    VALUES (?, ?, ?, 'in_progress', ?, ?, ?)
  `).run(userId, nodeId, type || 'standard', totalQuestions, JSON.stringify(testNodes), nodeId);

  // F1: 프론트가 라벨을 표시할 수 있도록 hydration 정보를 함께 반환
  // 첫 노드의 문항도 함께 시도 (legacy 흐름에서도 즉시 풀이 진입 가능)
  let firstQuestion = null;
  let startNodeId = nodeId;
  for (const qn of testNodes) {
    try {
      const cand = _pickQuestionForNode(qn, 'medium');
      if (cand) { firstQuestion = cand; startNodeId = qn; break; }
    } catch (_) { /* 무시 */ }
  }
  if (startNodeId !== nodeId) {
    db.prepare('UPDATE diagnosis_sessions SET current_node_id = ? WHERE id = ?')
      .run(startNodeId, info.lastInsertRowid);
  }
  // R1 (Phase 1 REWORK): 응답용 큐에서 startNodeId 제외 — 중복 렌더링 방지
  const responseQueue = testNodes.filter(n => n !== startNodeId);
  const queueHydrated = _hydrateDiagNodes(responseQueue);
  const currentNodeHydrated = _hydrateDiagNodes([startNodeId])[0] || { id: startNodeId };
  return {
    sessionId: info.lastInsertRowid,
    testNodes: responseQueue,
    totalQuestions,
    queueNodes: responseQueue,
    queueNodesHydrated: queueHydrated,
    currentNodeId: startNodeId,
    currentNode: currentNodeHydrated,
    question: firstQuestion
  };
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

/**
 * 정답 판정 헬퍼 — content_questions.answer 형식 다양성 흡수.
 *
 * DB 사정:
 *   - content_questions.answer 는 대부분(95%+) **0-based index** 문자열 ("0"~"4"),
 *     일부는 정답 텍스트 자체("27","서울","사과") 형태로 저장됨.
 *   - content-player.html 클라이언트는 `opts[Number(corA)]` 로 정답 텍스트를 산출 →
 *     DB의 answer를 0-based index로 취급함이 정설.
 *
 * 클라이언트가 보내는 selectedAnswer 형식:
 *   - 자기주도학습 직접풀이(line 3378): `idx + 1` (1-based 정수, 예: 1~5)
 *   - 콘텐츠 플레이어 채점(line 3148): null (이 경로는 isCorrect를 신뢰)
 *   - 진단 응답 페이로드: 옵션 텍스트 또는 1-based index 문자열
 *
 * 본 헬퍼는 다음 모두를 정답으로 인정한다:
 *   1) 0-based index (q.answer 자체) 와 동일
 *   2) 1-based index (q.answer + 1) 와 동일
 *   3) options 배열에서 q.answer가 가리키는 항목의 텍스트와 동일
 *      (① 등 prefix 문자 정규화 포함)
 *   4) q.answer 자체가 텍스트인 경우 options 무관 직접 일치
 */
function _normalizeAnswerText(s) {
  return String(s == null ? '' : s)
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]/, '')          // 원숫자 prefix 제거
    .replace(/^\s*\d+[\)\.\s]\s*/, '')         // "1) ", "1. " prefix 제거
    .replace(/\s+/g, '')
    .toLowerCase();
}

function judgeQuestionAnswer(question, submitted) {
  // question: { answer, options(JSON or array) }
  if (!question) return false;
  const rawAnswer = question.answer == null ? '' : String(question.answer).trim();
  const userRaw = submitted == null ? '' : String(submitted).trim();
  if (userRaw === '') return false;

  // 1) 직접 문자열 일치 (q.answer가 텍스트 정답일 때 또는 사용자가 같은 index 보낼 때)
  if (rawAnswer === userRaw) return true;

  // options 파싱
  let opts = null;
  if (Array.isArray(question.options)) opts = question.options;
  else if (typeof question.options === 'string') {
    try { const j = JSON.parse(question.options); if (Array.isArray(j)) opts = j; } catch (_) {}
  }

  // 2) q.answer가 0-based index로 보일 때 — 1-based / 텍스트 매핑 고려
  const ansIdx = Number(rawAnswer);
  if (opts && Number.isInteger(ansIdx) && ansIdx >= 0 && ansIdx < opts.length) {
    // 2-a) 사용자가 1-based index를 보낸 경우
    const userNum = Number(userRaw);
    if (Number.isInteger(userNum)) {
      if (userNum === ansIdx) return true;          // 둘 다 0-based 일치
      if (userNum - 1 === ansIdx) return true;      // user 1-based → 0-based 변환
    }
    // 2-b) 사용자가 옵션 텍스트를 보낸 경우
    const correctText = _normalizeAnswerText(opts[ansIdx]);
    const userText = _normalizeAnswerText(userRaw);
    if (correctText && correctText === userText) return true;
  }

  // 3) q.answer가 텍스트인 경우 — 정규화 비교
  const ansNorm = _normalizeAnswerText(rawAnswer);
  const userNorm = _normalizeAnswerText(userRaw);
  if (ansNorm && ansNorm === userNorm) return true;

  // 4) options에서 사용자 텍스트 위치를 찾아 q.answer(인덱스)와 비교
  if (opts && Number.isInteger(ansIdx)) {
    const userNorm2 = _normalizeAnswerText(userRaw);
    const matchedIdx = opts.findIndex(o => _normalizeAnswerText(o) === userNorm2);
    if (matchedIdx >= 0 && matchedIdx === ansIdx) return true;
  }

  return false;
}

// 정답을 사용자에게 보여줄 텍스트 형태로 반환 (q.answer가 0-based index일 때 옵션 텍스트로 변환)
function resolveCorrectAnswerText(question) {
  if (!question) return null;
  const raw = question.answer == null ? '' : String(question.answer);
  let opts = null;
  if (Array.isArray(question.options)) opts = question.options;
  else if (typeof question.options === 'string') {
    try { const j = JSON.parse(question.options); if (Array.isArray(j)) opts = j; } catch (_) {}
  }
  const n = Number(raw);
  if (opts && Number.isInteger(n) && n >= 0 && n < opts.length) {
    return String(opts[n]);
  }
  return raw;
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

  // 서버 정답 판정: questionId 필수 — 누락 시 호출자 오류
  if (!questionId) {
    const err = new Error('questionId is required');
    err.statusCode = 400;
    throw err;
  }
  let isCorrect = 0;
  const q = db.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(questionId);
  if (!q) {
    const err = new Error('questionId not found');
    err.statusCode = 400;
    throw err;
  }
  if (judgeQuestionAnswer(q, answer)) isCorrect = 1;

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
  // [2026-05-27 fix] 단원(level=2) 노드에 대한 진단은 자동으로 'completed' 라벨을 박지 않는다.
  //   진단 통과는 mastered/proficient/developing/needs_review로 diagnosis_result 컬럼에 보존하고,
  //   user_node_status.status 는 'in_progress'로만 마킹.
  //   단원이 "완료" 라벨을 얻으려면 자식 차시들이 실제 학습 완료되어야 함 (UI에서 합성 산출).
  //   차시(level=3) 노드 진단은 기존 동작 유지 (mastered → completed).
  let nodeLevel = null;
  try {
    const lmn = db.prepare('SELECT node_level FROM learning_map_nodes WHERE node_id = ?').get(session.target_node_id);
    nodeLevel = lmn ? lmn.node_level : null;
  } catch (_) {}
  const isUnitNode = nodeLevel === 2;
  const nextStatus = (result === 'mastered' && !isUnitNode) ? 'completed' : 'in_progress';
  db.prepare(`
    INSERT OR REPLACE INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(session.user_id, session.target_node_id, nextStatus, result, correctRate);

  logLearningActivity({
    userId: session.user_id, activityType: 'diagnosis_complete', targetType: 'diagnosis',
    targetId: sessionId, verb: 'completed', sourceService: 'self-learn',
    resultScore: correctRate, resultSuccess: result === 'mastered' ? 1 : 0
  });

  // 진단 종료 시점에 추천학습 경로 자동 생성 (실패해도 finish 자체는 성공)
  try {
    buildRecommendedPath(sessionId);
  } catch (e) {
    console.error('[finishDiagnosis] buildRecommendedPath 실패:', e.message);
  }

  return { sessionId, result, correctRate, correctCount: session.correct_count, totalQuestions: session.total_questions };
}

// ============================================================
// 추천학습 경로 시스템 (2026-05-27 설계서 §3, §4, §9)
// ============================================================

/**
 * 진단 세션 기반 추천학습 경로 생성.
 *
 * 알고리즘:
 *   1. diagnosis_sessions.difficulty_path 파싱 → 노드별 통과 여부·정답률
 *   2. 실패한 노드(passed=false 또는 정답률 < 0.60) 추출
 *   3. 정렬: 학년 ASC → 학기 ASC → 노드 깊이 ASC → 영역 → sort_order
 *   4. 목표 노드(target_node_id)는 항상 마지막 STEP
 *   5. learning_paths INSERT (source_type='diagnosis', session_id=sessionId)
 *   6. 같은 sessionId 중복 INSERT 방지 (이미 있으면 path_nodes 업데이트)
 *
 * @param {number} sessionId
 * @returns {{pathId:number, sessionId:number, pathNodes:string[], created:boolean}|null}
 */
function buildRecommendedPath(sessionId) {
  const sid = Number(sessionId);
  if (!sid) return null;

  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sid);
  if (!session) return null;

  // 실패 노드 수집 — difficulty_path JSON에서 passed=false 또는 정답률 < 0.60
  let diagPath = [];
  try { diagPath = JSON.parse(session.difficulty_path || '[]'); } catch { diagPath = []; }

  const PASS_THRESHOLD = 0.60;
  const failedNodeIds = [];
  const seenNodes = new Set();
  for (const p of diagPath) {
    if (!p || typeof p !== 'object') continue;
    if (!p.node) continue;                // 메타 항목(_endReason 등) 스킵
    if (seenNodes.has(p.node)) continue;  // 중복 제거
    seenNodes.add(p.node);
    const total = Number(p.total) || 0;
    const correct = Number(p.correct) || 0;
    const rate = total > 0 ? correct / total : 0;
    const isFailed = (p.passed === false) || (total > 0 && rate < PASS_THRESHOLD);
    if (isFailed) failedNodeIds.push(p.node);
  }

  // 목표 노드 정보 + 실패 노드 메타 일괄 hydrate
  const targetNodeId = session.target_node_id;
  const allCandidateIds = [...failedNodeIds];
  if (targetNodeId && !allCandidateIds.includes(targetNodeId)) {
    allCandidateIds.push(targetNodeId);
  }

  let pathNodes = [];

  if (allCandidateIds.length === 0) {
    // 진단 노드가 하나도 없는 비정상 케이스 — target만 잡거나 빈 경로
    if (targetNodeId) pathNodes = [targetNodeId];
  } else {
    // 노드 메타 일괄 조회 (정렬 키 산출용)
    const placeholders = allCandidateIds.map(() => '?').join(',');
    const metas = db.prepare(`
      SELECT node_id, subject, grade, semester, area, node_level, sort_order, unit_name, lesson_name
      FROM learning_map_nodes
      WHERE node_id IN (${placeholders})
    `).all(...allCandidateIds);
    const metaById = Object.fromEntries(metas.map(m => [m.node_id, m]));

    // 실패 노드만 정렬 (학년 ASC → 학기 ASC → node_level ASC → area → sort_order)
    const sortedFailed = [...failedNodeIds].sort((a, b) => {
      const ma = metaById[a] || {};
      const mb = metaById[b] || {};
      if ((ma.grade || 99) !== (mb.grade || 99)) return (ma.grade || 99) - (mb.grade || 99);
      if ((ma.semester || 9) !== (mb.semester || 9)) return (ma.semester || 9) - (mb.semester || 9);
      if ((ma.node_level || 9) !== (mb.node_level || 9)) return (ma.node_level || 9) - (mb.node_level || 9);
      if ((ma.area || '') !== (mb.area || '')) return String(ma.area || '').localeCompare(String(mb.area || ''));
      return (ma.sort_order || 0) - (mb.sort_order || 0);
    });

    // 중복 없이 [실패 노드들, 목표 노드(마지막)] 합성
    pathNodes = sortedFailed.filter(nid => nid !== targetNodeId);
    if (targetNodeId) pathNodes.push(targetNodeId);
  }

  // 중복 INSERT 방지 — 같은 sessionId 행 있으면 UPDATE
  const existing = db.prepare(
    "SELECT id FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis'"
  ).get(sid);

  const pathNodesJson = JSON.stringify(pathNodes);

  if (existing) {
    db.prepare(`
      UPDATE learning_paths
      SET path_nodes = ?, target_node_id = ?, user_id = ?
      WHERE id = ?
    `).run(pathNodesJson, targetNodeId || pathNodes[pathNodes.length - 1] || '', session.user_id, existing.id);
    return { pathId: existing.id, sessionId: sid, pathNodes, created: false };
  }

  const info = db.prepare(`
    INSERT INTO learning_paths (user_id, target_node_id, path_nodes, status, session_id, source_type)
    VALUES (?, ?, ?, 'active', ?, 'diagnosis')
  `).run(
    session.user_id,
    targetNodeId || pathNodes[pathNodes.length - 1] || '',
    pathNodesJson,
    sid
  );
  return { pathId: info.lastInsertRowid, sessionId: sid, pathNodes, created: true };
}

/**
 * 추천학습 경로의 노드별 진행 상태 산출 헬퍼.
 * user_node_status 우선, 자식 차시 활동(problem_attempts/user_content_progress) 보조 평가.
 *
 * @returns 'completed' | 'in_progress' | 'pending'
 */
function _resolvePathNodeProgress(userId, nodeId) {
  // 1) user_node_status 우선
  const uns = db.prepare(
    'SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?'
  ).get(userId, nodeId);
  if (uns) {
    if (uns.status === 'completed' || uns.status === 'mastered') return 'completed';
    if (uns.status === 'in_progress') return 'in_progress';
  }

  // 2) 자식 차시(node_level=3)의 진행 활동 확인
  try {
    const childActivity = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM (
        SELECT 1 FROM problem_attempts WHERE user_id = ? AND node_id = ?
        UNION ALL
        SELECT 1 FROM user_content_progress WHERE user_id = ? AND node_id = ? AND watch_ratio > 0
      )
    `).get(userId, nodeId, userId, nodeId);
    if (childActivity && childActivity.cnt > 0) return 'in_progress';
  } catch (_) {}

  return 'pending';
}

/**
 * 단원의 차시 학습 정보 산출 (총 차시 수, 완료 차시 수, 예상 학습 시간).
 */
function _resolvePathNodeLessons(userId, nodeId) {
  try {
    const children = db.prepare(`
      SELECT node_id FROM learning_map_nodes
      WHERE parent_node_id = ? AND node_level = 3
    `).all(nodeId);
    const total = children.length;
    if (total === 0) {
      return { total: 0, completed: 0, estimatedMinutes: 5 };
    }
    let completed = 0;
    for (const c of children) {
      const s = db.prepare(
        'SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?'
      ).get(userId, c.node_id);
      if (s && (s.status === 'completed' || s.status === 'mastered')) completed++;
    }
    return { total, completed, estimatedMinutes: total * 5 };
  } catch (_) {
    return { total: 0, completed: 0, estimatedMinutes: 5 };
  }
}

/**
 * 학년에 따른 학교급 라벨 (초/중/고)
 */
function _formatGradeLabel(grade) {
  const g = Number(grade) || 0;
  if (g >= 1 && g <= 6) return `초${g}`;
  if (g >= 7 && g <= 9) return `중${g - 6}`;
  if (g >= 10 && g <= 12) return `고${g - 9}`;
  return `${g}학년`;
}

/**
 * 사용자별 추천학습 경로 목록 조회.
 * 진단 세션 기반(source_type='diagnosis') 경로를 날짜 desc로.
 */
function listRecommendedPaths(userId, opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  const statusFilter = opts.status || 'active';

  let where = "WHERE lp.user_id = ? AND lp.source_type = 'diagnosis'";
  const params = [userId];
  if (statusFilter !== 'all') {
    where += ' AND lp.status = ?';
    params.push(statusFilter);
  }

  const rows = db.prepare(`
    SELECT lp.id AS path_id, lp.session_id, lp.target_node_id, lp.path_nodes, lp.status, lp.created_at,
           ds.started_at, ds.completed_at, ds.result, ds.difficulty_path,
           lmn.unit_name, lmn.lesson_name, lmn.area, lmn.subject, lmn.grade, lmn.semester
    FROM learning_paths lp
    LEFT JOIN diagnosis_sessions ds ON ds.id = lp.session_id
    LEFT JOIN learning_map_nodes lmn ON lmn.node_id = lp.target_node_id
    ${where}
    ORDER BY ds.completed_at DESC, lp.created_at DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map(r => {
    let pathNodes = [];
    try { pathNodes = JSON.parse(r.path_nodes || '[]'); } catch {}
    let diagPath = [];
    try { diagPath = JSON.parse(r.difficulty_path || '[]'); } catch {}

    // summary 계산
    const nodeMeta = diagPath.filter(p => p && p.node);
    const totalNodes = pathNodes.length;
    const passedNodes = nodeMeta.filter(p => p.passed === true).length;
    const failedNodes = nodeMeta.filter(p => p.passed === false).length;
    const totalCorrect = nodeMeta.reduce((s, p) => s + (Number(p.correct) || 0), 0);
    const totalQuestions = nodeMeta.reduce((s, p) => s + (Number(p.total) || 0), 0);
    const averageCorrectRate = totalQuestions > 0 ? totalCorrect / totalQuestions : 0;

    let completedCount = 0, inProgressCount = 0, pendingCount = 0;
    for (const nid of pathNodes) {
      const st = _resolvePathNodeProgress(r.user_id || userId, nid);
      if (st === 'completed') completedCount++;
      else if (st === 'in_progress') inProgressCount++;
      else pendingCount++;
    }
    const progressPercent = totalNodes > 0 ? Math.round((completedCount / totalNodes) * 100) : 0;

    return {
      pathId: r.path_id,
      sessionId: r.session_id,
      status: r.status,
      diagnosedAt: r.completed_at || r.started_at || r.created_at,
      relativeTime: _formatRelativeTime(r.completed_at || r.started_at || r.created_at),
      targetNode: {
        nodeId: r.target_node_id,
        title: r.lesson_name || r.unit_name || '이전 단원',
        subject: r.subject || null,
        grade: r.grade || null,
        semester: r.semester || null,
        area: r.area || null
      },
      summary: {
        totalNodes,
        passedNodes,
        failedNodes,
        averageCorrectRate,
        progressPercent,
        completedCount,
        inProgressCount,
        pendingCount
      },
      result: r.result || null,
      resultLabel: _resolveResultLabel(r.result)
    };
  });
}

/**
 * 특정 진단 세션의 추천학습 경로 상세 (학년·학기·영역 그룹핑 + 진행 상태).
 *
 * @returns null 또는 { session, targetNode, summary, groups }
 */
function getRecommendedPathBySession(sessionId, userId) {
  const sid = Number(sessionId);
  if (!sid) return null;

  // session + path 동시 조회
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sid);
  if (!session) return null;

  // 권한 확인 — 본인 진단만 (userId 미제공이면 스킵)
  if (userId && session.user_id !== userId) {
    const err = new Error('FORBIDDEN');
    err.statusCode = 403;
    throw err;
  }

  let pathRow = db.prepare(
    "SELECT * FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis' ORDER BY id DESC LIMIT 1"
  ).get(sid);

  // 경로 없으면 즉시 빌드
  if (!pathRow) {
    try {
      buildRecommendedPath(sid);
      pathRow = db.prepare(
        "SELECT * FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis' ORDER BY id DESC LIMIT 1"
      ).get(sid);
    } catch (e) {
      console.error('[getRecommendedPathBySession] 경로 자동 생성 실패:', e.message);
    }
  }

  let pathNodes = [];
  try { pathNodes = JSON.parse((pathRow && pathRow.path_nodes) || '[]'); } catch {}

  // 진단 노드 결과 (passed/정답률)
  let diagPath = [];
  try { diagPath = JSON.parse(session.difficulty_path || '[]'); } catch {}
  const diagByNode = {};
  for (const p of diagPath) {
    if (p && p.node) {
      const total = Number(p.total) || 0;
      const correct = Number(p.correct) || 0;
      diagByNode[p.node] = {
        passed: !!p.passed,
        correctCount: correct,
        totalCount: total,
        correctRate: total > 0 ? correct / total : 0
      };
    }
  }

  // 노드 메타 일괄 조회
  const targetNodeId = session.target_node_id;
  const allIds = [...new Set([...pathNodes, targetNodeId].filter(Boolean))];
  let nodeMetas = [];
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => '?').join(',');
    nodeMetas = db.prepare(`
      SELECT node_id, subject, grade, semester, area, node_level, sort_order, unit_name, lesson_name
      FROM learning_map_nodes
      WHERE node_id IN (${placeholders})
    `).all(...allIds);
  }
  const metaById = Object.fromEntries(nodeMetas.map(m => [m.node_id, m]));

  // 목표 노드
  const tMeta = metaById[targetNodeId] || {};
  const targetNode = {
    nodeId: targetNodeId,
    title: tMeta.lesson_name || tMeta.unit_name || '이전 단원',
    subject: tMeta.subject || null,
    grade: tMeta.grade || null,
    semester: tMeta.semester || null,
    area: tMeta.area || null
  };

  // 학년·학기·영역 그룹핑 + STEP 번호 부여
  const groupMap = new Map();   // groupKey -> { meta, steps[] }
  let stepCounter = 0;

  for (const nid of pathNodes) {
    stepCounter++;
    const m = metaById[nid] || {};
    const grade = m.grade || null;
    const semester = m.semester || null;
    const area = m.area || '기타';
    const groupKey = `${grade || 0}-${semester || 0}-${area}`;

    const isTarget = (nid === targetNodeId);
    let progressStatus, progressLabel, lockReason = null;
    if (isTarget && pathNodes.length > 1) {
      // 목표 노드: 앞 STEP 모두 완료되어야 풀림
      const priorIds = pathNodes.slice(0, pathNodes.indexOf(nid));
      const allPriorDone = priorIds.every(pid =>
        _resolvePathNodeProgress(session.user_id, pid) === 'completed'
      );
      if (allPriorDone) {
        progressStatus = _resolvePathNodeProgress(session.user_id, nid);
        progressLabel = _progressStatusLabel(progressStatus);
      } else {
        progressStatus = 'locked';
        progressLabel = '잠금';
        lockReason = '앞 STEP을 모두 완료하면 풀려요';
      }
    } else {
      progressStatus = _resolvePathNodeProgress(session.user_id, nid);
      progressLabel = _progressStatusLabel(progressStatus);
    }

    const lessons = _resolvePathNodeLessons(session.user_id, nid);
    const diagResult = diagByNode[nid] || null;

    if (!groupMap.has(groupKey)) {
      const schoolLevel = (Number(grade) >= 1 && Number(grade) <= 6)
        ? '초등'
        : (Number(grade) >= 7 && Number(grade) <= 9 ? '중등' : (Number(grade) >= 10 ? '고등' : '기타'));
      groupMap.set(groupKey, {
        groupKey,
        label: `${_formatGradeLabel(grade)} ${semester || ''}학기 · ${area}`.replace(/\s+/g, ' ').trim(),
        grade,
        semester,
        area,
        schoolLevel,
        steps: []
      });
    }
    groupMap.get(groupKey).steps.push({
      step: stepCounter,
      nodeId: nid,
      title: m.lesson_name || m.unit_name || '단원',
      diagResult,
      progressStatus,
      progressLabel,
      lessons: { total: lessons.total, completed: lessons.completed },
      estimatedMinutes: lessons.estimatedMinutes,
      isTarget,
      lockReason
    });
  }

  const groups = [...groupMap.values()];

  // summary 합성
  const totalNodes = pathNodes.length;
  const passedNodes = Object.values(diagByNode).filter(d => d.passed).length;
  const failedNodes = Object.values(diagByNode).filter(d => !d.passed).length;
  let completedCount = 0, inProgressCount = 0, pendingCount = 0, lockedCount = 0;
  for (const g of groups) {
    for (const s of g.steps) {
      if (s.progressStatus === 'completed') completedCount++;
      else if (s.progressStatus === 'in_progress') inProgressCount++;
      else if (s.progressStatus === 'locked') lockedCount++;
      else pendingCount++;
    }
  }
  const progressPercent = totalNodes > 0 ? Math.round((completedCount / totalNodes) * 100) : 0;
  const totalCorrect = Object.values(diagByNode).reduce((s, d) => s + (d.correctCount || 0), 0);
  const totalQuestions = Object.values(diagByNode).reduce((s, d) => s + (d.totalCount || 0), 0);
  const averageCorrectRate = totalQuestions > 0 ? totalCorrect / totalQuestions : 0;

  return {
    session: {
      id: session.id,
      diagnosedAt: session.completed_at || session.started_at,
      relativeTime: _formatRelativeTime(session.completed_at || session.started_at),
      result: session.result || null,
      resultLabel: _resolveResultLabel(session.result)
    },
    pathId: pathRow ? pathRow.id : null,
    targetNode,
    summary: {
      totalNodes,
      passedNodes,
      failedNodes,
      averageCorrectRate,
      progressPercent,
      completedCount,
      inProgressCount,
      pendingCount,
      lockedCount
    },
    groups
  };
}

/**
 * 진행 상태 라벨 (초등학생 친화 한글)
 */
function _progressStatusLabel(status) {
  switch (status) {
    case 'completed': return '완료';
    case 'in_progress': return '진행 중';
    case 'locked': return '잠금';
    case 'pending':
    default: return '미시작';
  }
}

/**
 * 추천 경로 내 특정 노드의 진행 상태 갱신 (드로어 학습 완료 후 호출).
 * 노드 상태 자동 평가 후 경로 전체의 진행률 재계산.
 */
function updateRecommendedPathProgress(sessionId, userId, nodeId) {
  const sid = Number(sessionId);
  if (!sid || !userId || !nodeId) {
    const err = new Error('잘못된 요청');
    err.statusCode = 400;
    throw err;
  }
  const session = db.prepare('SELECT user_id FROM diagnosis_sessions WHERE id = ?').get(sid);
  if (!session) {
    const err = new Error('진단 세션 없음');
    err.statusCode = 404;
    throw err;
  }
  if (session.user_id !== userId) {
    const err = new Error('FORBIDDEN');
    err.statusCode = 403;
    throw err;
  }

  // 노드 상태 자동 평가 (조건 충족 시 completed로 격상)
  try { evaluateNodeCompletion(userId, nodeId); } catch (_) {}

  const updatedStatus = _resolvePathNodeProgress(userId, nodeId);

  // 경로 전체 진행률 재계산
  const pathRow = db.prepare(
    "SELECT path_nodes FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis' ORDER BY id DESC LIMIT 1"
  ).get(sid);
  let pathNodes = [];
  try { pathNodes = JSON.parse((pathRow && pathRow.path_nodes) || '[]'); } catch {}

  let completedCount = 0;
  for (const nid of pathNodes) {
    if (_resolvePathNodeProgress(userId, nid) === 'completed') completedCount++;
  }
  const progressPercent = pathNodes.length > 0
    ? Math.round((completedCount / pathNodes.length) * 100)
    : 0;

  return {
    sessionId: sid,
    nodeId,
    updatedNodeStatus: updatedStatus,
    progressPercent,
    completedCount,
    totalNodes: pathNodes.length
  };
}

/**
 * 추천 경로의 모든 노드를 사용자의 학습목록(user_learning_list)에 일괄 추가.
 */
function addRecommendedPathToLearningList(sessionId, userId) {
  const sid = Number(sessionId);
  if (!sid || !userId) {
    const err = new Error('잘못된 요청');
    err.statusCode = 400;
    throw err;
  }
  const session = db.prepare('SELECT user_id FROM diagnosis_sessions WHERE id = ?').get(sid);
  if (!session) {
    const err = new Error('진단 세션 없음');
    err.statusCode = 404;
    throw err;
  }
  if (session.user_id !== userId) {
    const err = new Error('FORBIDDEN');
    err.statusCode = 403;
    throw err;
  }

  const pathRow = db.prepare(
    "SELECT path_nodes FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis' ORDER BY id DESC LIMIT 1"
  ).get(sid);
  let pathNodes = [];
  try { pathNodes = JSON.parse((pathRow && pathRow.path_nodes) || '[]'); } catch {}

  if (pathNodes.length === 0) {
    return { addedCount: 0, skippedCount: 0 };
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO user_learning_list (user_id, node_id)
    VALUES (?, ?)
  `);

  let addedCount = 0;
  const txn = db.transaction(() => {
    for (const nid of pathNodes) {
      const info = insertStmt.run(userId, nid);
      if (info.changes > 0) addedCount++;
    }
  });
  txn();

  return {
    addedCount,
    skippedCount: pathNodes.length - addedCount,
    totalNodes: pathNodes.length
  };
}

// B4: 사용자의 최근 진단 이력 조회 — 학생 친화 결과 화면용
//   opts.all = true        → 사용자의 최근 N건 (subject/grade 필터 옵션)
//   opts.subject, opts.grade → 추가 필터 (target_node_id의 노드 메타 기준)
//   opts.limit             → 기본 10
function listDiagnosisHistory(userId, opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10));
  const filters = [];
  const params = [userId];
  let sql = `
    SELECT ds.id, ds.user_id, ds.target_node_id, ds.status,
           ds.total_questions, ds.correct_count,
           ds.started_at, ds.completed_at, ds.result, ds.diagnosis_type,
           ds.difficulty_path,
           lmn.unit_name, lmn.lesson_name, lmn.area, lmn.subject, lmn.grade
    FROM diagnosis_sessions ds
    LEFT JOIN learning_map_nodes lmn ON lmn.node_id = ds.target_node_id
    WHERE ds.user_id = ?
  `;
  if (opts.subject) {
    filters.push('lmn.subject = ?');
    params.push(opts.subject);
  }
  if (opts.grade) {
    filters.push('lmn.grade = ?');
    params.push(Number(opts.grade));
  }
  if (filters.length) sql += ' AND ' + filters.join(' AND ');
  sql += ' ORDER BY ds.id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);

  return rows.map(r => {
    // CAT 세션은 difficulty_path 합산 / 비-CAT은 세션 컬럼 사용
    let totalQuestions = r.total_questions || 0;
    let correctCount = r.correct_count || 0;
    let perNode = [];  // v2: 노드별 통과 여부
    try {
      const path = JSON.parse(r.difficulty_path || '[]');
      if (Array.isArray(path) && path.length > 0) {
        const sumT = path.reduce((s, p) => s + (Number(p.total) || 0), 0);
        const sumC = path.reduce((s, p) => s + (Number(p.correct) || 0), 0);
        if (sumT > 0) { totalQuestions = sumT; correctCount = sumC; }
        // 노드별 요약
        perNode = path.map(p => {
          const nodeInfo = db.prepare(
            'SELECT unit_name, lesson_name FROM learning_map_nodes WHERE node_id = ?'
          ).get(p.node) || {};
          const rate = (p.total || 0) > 0 ? (p.correct || 0) / p.total : 0;
          return {
            nodeId: p.node,
            title: nodeInfo.lesson_name || nodeInfo.unit_name || '이전 단원',
            passed: !!p.passed,
            correctCount: p.correct || 0,
            totalCount: p.total || 0,
            correctRate: rate,
            sheetSize: p.sheetMeta?.sheetSize || (p.total || 0)
          };
        });
      }
    } catch {}
    const correctRate = totalQuestions > 0 ? correctCount / totalQuestions : 0;
    return {
      id: r.id,
      subject: r.subject || null,
      targetNodeId: r.target_node_id,
      targetTitle: r.lesson_name || r.unit_name || '이전 단원',
      area: r.area || null,
      grade: r.grade || null,
      correctCount,
      totalQuestions,
      correctRate,
      status: r.status,
      result: r.result || null,
      resultLabel: _resolveResultLabel(r.result),
      diagnosisType: r.diagnosis_type || null,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      relativeTime: _formatRelativeTime(r.completed_at || r.started_at),
      // v2 — 노드별 통과 여부
      perNode
    };
  });
}

function getDiagnosisResult(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const answers = db.prepare('SELECT * FROM diagnosis_answers WHERE session_id = ? ORDER BY answered_at').all(sessionId);

  // B2: CAT 세션의 nodeResults 재구성 — difficulty_path(노드 단위 진행 경로)에서 복원
  let nodeResults = [];
  let nodePath = [];
  try { nodePath = JSON.parse(session.difficulty_path || '[]'); } catch {}
  if (Array.isArray(nodePath) && nodePath.length > 0) {
    nodeResults = nodePath.map(p => {
      const rate = (p.total || 0) > 0 ? (p.correct || 0) / p.total : 0;
      const nodeInfo = db.prepare(
        'SELECT unit_name, lesson_name, area, grade, subject FROM learning_map_nodes WHERE node_id = ?'
      ).get(p.node) || {};
      return {
        nodeId: p.node,
        node_id: p.node,
        // B3: 노드 ID 노출 금지 — fallback은 '이전 단원'
        title: nodeInfo.lesson_name || nodeInfo.unit_name || '이전 단원',
        area: nodeInfo.area || null,
        grade: nodeInfo.grade || null,
        subject: nodeInfo.subject || null,
        passed: !!p.passed,
        correctCount: p.correct || 0,
        totalCount: p.total || 0,
        correctRate: rate
      };
    });
  } else if (session.target_node_id && session.total_questions > 0) {
    // 비-CAT(=일반 진단) fallback — 단일 노드를 한 묶음으로
    const nodeInfo = db.prepare(
      'SELECT unit_name, lesson_name, area, grade, subject FROM learning_map_nodes WHERE node_id = ?'
    ).get(session.target_node_id) || {};
    const total = session.total_questions || 0;
    const correct = session.correct_count || 0;
    const rate = total > 0 ? correct / total : 0;
    nodeResults = [{
      nodeId: session.target_node_id,
      node_id: session.target_node_id,
      title: nodeInfo.lesson_name || nodeInfo.unit_name || '이전 단원',
      area: nodeInfo.area || null,
      grade: nodeInfo.grade || null,
      subject: nodeInfo.subject || null,
      passed: rate >= 0.9,
      correctCount: correct,
      totalCount: total,
      correctRate: rate
    }];
  }

  // B1/B2 동일 구조 보강
  const { summary, areaStats, recommendNodes, targetNode } = _buildResultEnrichment(session, nodeResults);

  // B5: 빈 진단 케이스 — endReason 결정 (세션에 별도 컬럼 없음 → 응답 기반 추정)
  let endReason = null;
  if (!nodeResults.length) endReason = 'no_question';

  return {
    session,
    answers,
    nodeResults,
    summary,
    areaStats,
    recommendNodes,
    targetNode,
    endReason
  };
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

/**
 * BE-01: 노드의 학습 완료 조건 평가 후 자동 격상.
 *
 * 격상 조건 (PM 결정):
 *   - 노드의 영상 중 watch_ratio ≥ 0.8 인 영상 비율이 ≥ 0.8 (80% 이상의 영상이 80% 이상 시청됨)
 *   - 노드의 문제 중 마지막 시도가 정답인 문제 비율이 ≥ 0.6 (정답률 60%+)
 *   - 영상 0개면 영상 조건 자동 PASS, 문제 0개면 문제 조건 자동 PASS
 *   - 영상 0 + 문제 0이면 격상 안 함 (학습할 게 없는 노드)
 *   - 이미 'completed'/'mastered'면 변경 안 함 (idempotent)
 *   - 격상은 only-up — 정답률 떨어져도 강등 안 함
 *
 * @param {number} userId
 * @param {string} nodeId
 * @returns {boolean} 이번 호출에서 completed로 격상되었으면 true
 */
function evaluateNodeCompletion(userId, nodeId) {
  if (!userId || !nodeId) return false;

  // 이미 종료 상태인지 먼저 확인 (불필요한 작업 회피)
  const existing = db.prepare(
    'SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?'
  ).get(userId, nodeId);
  if (existing && (existing.status === 'completed' || existing.status === 'mastered')) {
    return false;
  }

  // 노드에 매핑된 영상/문제 콘텐츠 ID 수집 (is_public/status 필터 — _evaluateNodeCompletion 동일 정책)
  const videoIds = db.prepare(`
    SELECT c.id
    FROM node_contents nc
    JOIN contents c ON nc.content_id = c.id
    WHERE nc.node_id = ?
      AND c.content_type = 'video'
      AND COALESCE(c.is_public, 1) = 1
      AND COALESCE(c.status, 'approved') = 'approved'
  `).all(nodeId).map(r => r.id);

  const problemIds = db.prepare(`
    SELECT c.id
    FROM node_contents nc
    JOIN contents c ON nc.content_id = c.id
    WHERE nc.node_id = ?
      AND c.content_type IN ('quiz','exam','problem','question','assessment')
      AND COALESCE(c.is_public, 1) = 1
      AND COALESCE(c.status, 'approved') = 'approved'
  `).all(nodeId).map(r => r.id);

  const totalV = videoIds.length;
  const totalP = problemIds.length;

  // 영상도 문제도 없는 노드는 자동 격상 대상 아님
  if (totalV === 0 && totalP === 0) return false;

  // 영상 조건: 영상 중 watch_ratio ≥ 0.8 인 영상의 비율 ≥ 0.8
  let videoPass = true; // 영상 0개면 자동 PASS
  if (totalV > 0) {
    let watchedV = 0;
    for (const vid of videoIds) {
      const p = db.prepare(
        'SELECT watch_ratio FROM user_content_progress WHERE user_id = ? AND content_id = ?'
      ).get(userId, vid);
      if (p && (p.watch_ratio || 0) >= 0.8) watchedV++;
    }
    videoPass = (watchedV / totalV) >= 0.8;
  }

  // 문제 조건: 문제 중 사용자의 마지막 시도가 정답인 문제 비율 ≥ 0.6
  let problemPass = true; // 문제 0개면 자동 PASS
  if (totalP > 0) {
    let solvedP = 0;
    for (const pid of problemIds) {
      // "마지막 시도" 기준 정답 여부
      const last = db.prepare(`
        SELECT is_correct
        FROM problem_attempts
        WHERE user_id = ? AND content_id = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(userId, pid);
      if (last && last.is_correct === 1) solvedP++;
    }
    problemPass = (solvedP / totalP) >= 0.6;
  }

  if (!videoPass || !problemPass) return false;

  // 격상 실행
  db.prepare(`
    INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at, completed_at)
    VALUES (?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, node_id) DO UPDATE SET
      status = 'completed',
      completed_at = COALESCE(user_node_status.completed_at, CURRENT_TIMESTAMP),
      last_accessed_at = CURRENT_TIMESTAMP
  `).run(userId, nodeId);

  // 학습로그 + 포인트 (completeNode와 동일한 부수 효과)
  try {
    logLearningActivity({
      userId, activityType: 'node_complete', targetType: 'learning_node',
      targetId: nodeId, verb: 'completed', sourceService: 'self-learn'
    });
  } catch (_) {}
  try {
    const { awardPoints } = require('./point-helper');
    awardPoints(userId, {
      source: 'node_complete', sourceId: nodeId, points: 10,
      description: '학습노드 자동 완료 포인트'
    });
  } catch (_) {}

  // 활성 학습 경로의 진행도도 함께 갱신 (completeNode와 동일)
  try {
    const path = db.prepare(
      "SELECT * FROM learning_paths WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get(userId);
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
  } catch (_) {}

  return true;
}

/**
 * BE-04: contentId만 들어오고 nodeId가 누락되었을 때 node_contents에서 추론.
 * @returns {string|null}
 */
function inferNodeIdFromContent(contentId) {
  if (!contentId) return null;
  try {
    const r = db.prepare(
      'SELECT node_id FROM node_contents WHERE content_id = ? LIMIT 1'
    ).get(contentId);
    return r && r.node_id ? r.node_id : null;
  } catch (_) {
    return null;
  }
}

function getLearningDashboard(userId) {
  // KPI 단원(level=2) 단위 통일 — 옵션 C / 임계 100%
  //   - totalNodes      : 단원(level=2) 총수
  //   - completedNodes  : 단원의 자식 차시(level=3)가 전부 status='completed' 인 단원 수 (자식 0개 단원은 제외)
  //   - inProgressNodes : 완료 단원이 아니면서, 자식 차시 중 1개라도 status IN ('completed','in_progress') 인 단원 수
  //
  // 응답 키 이름(`totalNodes`, `completedNodes`, `inProgressNodes`)은 프론트엔드 호환성을 위해 유지.
  const unitProgressRows = db.prepare(`
    SELECT
      parent.node_id AS unit_id,
      COUNT(child.node_id) AS total_children,
      SUM(CASE WHEN uns.status = 'completed' THEN 1 ELSE 0 END) AS completed_children,
      SUM(CASE WHEN uns.status IN ('completed','in_progress') THEN 1 ELSE 0 END) AS engaged_children
    FROM learning_map_nodes parent
    LEFT JOIN learning_map_nodes child
      ON child.parent_node_id = parent.node_id AND child.node_level = 3
    LEFT JOIN user_node_status uns
      ON uns.node_id = child.node_id AND uns.user_id = ?
    WHERE parent.node_level = 2
    GROUP BY parent.node_id
  `).all(userId);
  const totalNodes = unitProgressRows.length;
  let completedNodes = 0;
  let inProgressNodes = 0;
  for (const r of unitProgressRows) {
    const total = r.total_children || 0;
    const done = r.completed_children || 0;
    const engaged = r.engaged_children || 0;
    if (total > 0 && done === total) {
      completedNodes++;
    } else if (engaged > 0) {
      inProgressNodes++;
    }
  }
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

  // 진행률(단원 단위로 통일):
  //   - 경로가 있으면: 경로 노드 중 "완료된 단원" 비율
  //   - 경로가 없으면: 학생이 시작한(engaged) 단원 중 완료 단원 비율, 시작 이력 없으면 전체 단원 분모 fallback
  let progressPercent = 0;
  if (currentPath && Array.isArray(currentPath.path_nodes) && currentPath.path_nodes.length > 0) {
    const pathCompleted = db.prepare(`
      SELECT COUNT(*) as cnt FROM user_node_status
      WHERE user_id = ? AND status = 'completed' AND node_id IN (${currentPath.path_nodes.map(() => '?').join(',')})
    `).get(userId, ...currentPath.path_nodes).cnt;
    progressPercent = Math.round((pathCompleted / currentPath.path_nodes.length) * 100);
  } else {
    const engagedUnits = completedNodes + inProgressNodes; // 단원 단위 합성
    if (engagedUnits > 0) {
      progressPercent = Math.round((completedNodes / engagedUnits) * 100);
    } else if (totalNodes > 0) {
      progressPercent = Math.round((completedNodes / totalNodes) * 100);
    }
  }
  if (!Number.isFinite(progressPercent)) progressPercent = 0;

  // 총 학습 시간(분) — problem_attempts.time_taken(초) + user_content_progress.position_sec(영상 시청 시간) 합산
  const timeAgg = db.prepare(`
    SELECT COALESCE(SUM(time_taken), 0) as total_sec
    FROM problem_attempts WHERE user_id = ? AND time_taken IS NOT NULL
  `).get(userId);
  const videoTimeAgg = db.prepare(`
    SELECT COALESCE(SUM(position_sec), 0) as total_sec
    FROM user_content_progress WHERE user_id = ?
  `).get(userId);
  const total_time_minutes = Math.round(((timeAgg.total_sec || 0) + (videoTimeAgg.total_sec || 0)) / 60);

  // 학습 랭킹 — 같은 학년 우선, 없으면 전체. (avg_accuracy * total_solved + streak*2) 점수 기반.
  let rank = null;
  let total_users = 0;
  try {
    const myRow = db.prepare(`SELECT grade FROM users WHERE id = ?`).get(userId);
    const myGrade = myRow?.grade || null;
    const myScore = (avg_accuracy || 0) * (total_solved || 0) + (streak || 0) * 2;
    // 같은 학년 학생만 / 해당 학년 학생이 1명뿐이면 전체 학생 cohort로 fallback
    let cohort = [];
    if (myGrade) {
      cohort = db.prepare(`
        SELECT u.id,
          COALESCE((SELECT COUNT(*) FROM problem_attempts WHERE user_id = u.id AND is_correct = 1), 0) as correct_cnt,
          COALESCE((SELECT COUNT(*) FROM problem_attempts WHERE user_id = u.id), 0) as total_cnt
        FROM users u
        WHERE u.role = 'student' AND u.grade = ?
      `).all(myGrade);
    }
    if (cohort.length < 2) {
      cohort = db.prepare(`
        SELECT u.id,
          COALESCE((SELECT COUNT(*) FROM problem_attempts WHERE user_id = u.id AND is_correct = 1), 0) as correct_cnt,
          COALESCE((SELECT COUNT(*) FROM problem_attempts WHERE user_id = u.id), 0) as total_cnt
        FROM users u
        WHERE u.role = 'student'
      `).all();
    }
    total_users = cohort.length;
    if (total_users > 0) {
      const ranked = cohort.map(r => ({
        userId: r.id,
        score: r.total_cnt > 0 ? Math.round((r.correct_cnt / r.total_cnt) * 100) * r.total_cnt : 0
      })).sort((a, b) => b.score - a.score);
      const idx = ranked.findIndex(r => r.userId === userId);
      rank = idx >= 0 ? idx + 1 : null;
    }
  } catch (e) {
    rank = null;
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
    recent_problems,
    // P0 추가 필드 — 대시보드 4-grid 누락 보완
    total_time_minutes,
    rank,
    total_users
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

  // 성취수준 6출처 집계용: 오답노트 재풀이를 problem_attempts 에 source_type='wrong_note' 로 기록.
  // content_id 는 NOT NULL 이므로 오답노트엔 매핑 콘텐츠가 없을 때 0(센티넬) 사용. node_id 는 NULL.
  try {
    db.prepare(`
      INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, selected_answer, time_taken, source_type)
      VALUES (?, ?, NULL, ?, ?, NULL, 'wrong_note')
    `).run(userId, 0, isCorrect ? 1 : 0, answer != null ? String(answer) : null);
  } catch (e) { /* 집계 기록 실패는 재풀이 흐름에 영향 주지 않음 */ }

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

function recordProblemAttempt(userId, contentId, { isCorrect, selectedAnswer, userAnswer, answer, questionId, timeTaken, nodeId, sourceType }) {
  // 서버 측 정답 판정: questionId가 있으면 content_questions.answer와 비교 (client isCorrect 무시)
  // questionId 없으면 content 단위 제출로 간주하여 기존 client isCorrect 유지 (호환성)
  const submittedAnswer = selectedAnswer ?? userAnswer ?? answer ?? null;
  let finalIsCorrect;
  let questionExplanation = null;
  let correctAnswer = null;
  if (questionId) {
    const q = db.prepare('SELECT answer, options, explanation FROM content_questions WHERE id = ?').get(questionId);
    if (q) {
      finalIsCorrect = judgeQuestionAnswer(q, submittedAnswer) ? 1 : 0;
      questionExplanation = q.explanation || null;
      correctAnswer = resolveCorrectAnswerText(q);  // 사용자 노출용: 0-based index → 옵션 텍스트
    } else {
      finalIsCorrect = isCorrect ? 1 : 0;
    }
  } else {
    // questionId 없을 때 content 단위 대표 문항에서 해설만 조회
    const q = db.prepare('SELECT answer, options, explanation FROM content_questions WHERE content_id = ? ORDER BY question_number LIMIT 1').get(contentId);
    if (q) { questionExplanation = q.explanation || null; correctAnswer = resolveCorrectAnswerText(q); }
    finalIsCorrect = isCorrect ? 1 : 0;
  }

  // BE-04: nodeId가 누락되면 node_contents에서 추론 (하나만 매핑된 경우 자동 보강)
  if (!nodeId) {
    const inferred = inferNodeIdFromContent(contentId);
    if (inferred) nodeId = inferred;
  }

  // 성취수준 6출처 집계용 source_type 판정 (스펙 §3·§7):
  //  - 호출부가 sourceType 을 넘기면 우선 사용(향후 확장 대비)
  //  - 미지정 시: node_id 있으면 'ai_learning'(학습맵 경로), 없으면 'content'(콘텐츠 단발문항)
  //  - today_learning 은 daily_learning_progress 가 정본이므로 여기엔 기록하지 않음(중복 집계 방지)
  const resolvedSource = sourceType || (nodeId ? 'ai_learning' : 'content');

  const info = db.prepare(`
    INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, selected_answer, time_taken, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, contentId, nodeId || null, finalIsCorrect, submittedAnswer, timeTaken || null, resolvedSource);
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
  let nodePromoted = false;
  if (nodeId) {
    try {
      const mine = db.prepare(`
        SELECT COUNT(*) as t, SUM(is_correct) as c
        FROM problem_attempts WHERE user_id = ? AND node_id = ?
      `).get(userId, nodeId);
      // correct_rate는 0~1 단위로 통일 (UI에서 ×100 해서 % 표시)
      const myRate = mine.t > 0 ? (mine.c / mine.t) : 0;
      db.prepare(`
        INSERT INTO user_node_status (user_id, node_id, status, correct_rate, last_accessed_at)
        VALUES (?, ?, 'in_progress', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, node_id) DO UPDATE SET
          correct_rate = excluded.correct_rate,
          last_accessed_at = CURRENT_TIMESTAMP
      `).run(userId, nodeId, myRate);
    } catch (e) { /* 노드 상태 갱신 실패 무시 */ }

    // BE-01: 영상 80%+ AND 정답률 60%+ 시 자동 completed 격상
    try {
      nodePromoted = evaluateNodeCompletion(userId, nodeId);
    } catch (e) { /* 격상 평가 실패는 응답에 영향 없음 */ }
  }

  return {
    attemptId: info.lastInsertRowid,
    attempt_id: info.lastInsertRowid,
    correct: !!finalIsCorrect,
    isCorrect: !!finalIsCorrect,
    correctAnswer,
    explanation: questionExplanation,
    correctRate,
    top_clearers: topClearers,
    node_completed: nodePromoted
  };
}

function recordVideoProgress(userId, contentId, { positionSec, durationSec, nodeId }) {
  // BE-04: nodeId 누락 시 node_contents에서 추론
  if (!nodeId) {
    const inferred = inferNodeIdFromContent(contentId);
    if (inferred) nodeId = inferred;
  }

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

  // BE-01: 영상 80%+ AND 문제 정답률 60%+ 시 자동 completed 격상
  let nodePromoted = false;
  if (nodeId) {
    try {
      nodePromoted = evaluateNodeCompletion(userId, nodeId);
    } catch (e) { /* 격상 평가 실패는 응답에 영향 없음 */ }
  }

  return {
    watch_ratio: ratio,
    position_sec: positionSec || 0,
    duration_sec: durationSec || 0,
    node_watched: nodeCompleted,
    node_completed: nodePromoted
  };
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
  let candidates = db.prepare(`
    SELECT c.id as content_id, c.title, c.difficulty
    FROM node_contents nc JOIN contents c ON nc.content_id = c.id
    WHERE nc.node_id = ? AND c.content_type IN ${problemTypes}
  `).all(nodeId);

  // 폴백 1: 자손 노드의 매핑된 문항 검색 (closure table)
  if (candidates.length === 0) {
    try {
      candidates = db.prepare(`
        SELECT c.id as content_id, c.title, c.difficulty
        FROM curriculum_node_descendants d
        JOIN node_contents nc ON nc.node_id = d.descendant_id
        JOIN contents c ON nc.content_id = c.id
        WHERE d.ancestor_id = ? AND c.content_type IN ${problemTypes}
        LIMIT 30
      `).all(nodeId);
    } catch (_) { /* closure 테이블 없을 수 있음 */ }
  }

  // 폴백 2: 같은 학년·과목 풀에서 무작위 문항 (노드 코드의 학년·과목 prefix 추출)
  if (candidates.length === 0) {
    // E4MATA01... → 4학년 수학. U62... 같은 익명 단원은 매핑되지 않으므로 같은 학년의 노드 풀에서 보충
    const node = db.prepare('SELECT subject, grade FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (node && node.subject) {
      candidates = db.prepare(`
        SELECT c.id as content_id, c.title, c.difficulty
        FROM learning_map_nodes lmn
        JOIN node_contents nc ON nc.node_id = lmn.node_id
        JOIN contents c ON nc.content_id = c.id
        WHERE lmn.subject = ? ${node.grade ? 'AND lmn.grade = ?' : ''} AND c.content_type IN ${problemTypes}
        LIMIT 30
      `).all(...(node.grade ? [node.subject, node.grade] : [node.subject]));
    }
  }

  // 폴백 3: 같은 노드 코드 prefix(예: U62...의 자식 = E2MAT...)에서 추정
  // U* 익명 단원은 자손이 없을 수 있어 prefix 패턴 매칭으로 같은 학년·교과 노드 풀에서 보충
  if (candidates.length === 0) {
    try {
      candidates = db.prepare(`
        SELECT c.id as content_id, c.title, c.difficulty
        FROM contents c
        JOIN content_questions cq ON cq.content_id = c.id
        WHERE c.content_type IN ${problemTypes}
          AND (c.grade IS NULL OR c.grade <= 6)
          AND (c.subject IS NULL OR c.subject LIKE '%수학%' OR c.subject LIKE '%math%')
        GROUP BY c.id
        HAVING COUNT(cq.id) > 0
        ORDER BY RANDOM() LIMIT 10
      `).all();
    } catch (_) { /* contents에 grade/subject 컬럼 없을 수 있음 */ }
  }

  // 폴백 4: 정말 모든 풀에서 무작위 (마지막 수단)
  if (candidates.length === 0) {
    candidates = db.prepare(`
      SELECT c.id as content_id, c.title, c.difficulty
      FROM contents c
      JOIN content_questions cq ON cq.content_id = c.id
      WHERE c.content_type IN ${problemTypes}
      GROUP BY c.id HAVING COUNT(cq.id) > 0
      ORDER BY RANDOM() LIMIT 10
    `).all();
  }

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

// ============================================================
// 진단평가 정책 v2 — 우선순위 큐 헬퍼 (설계서 §2.1)
// ============================================================

// 절대학기: 초→중→고를 연속된 정수로 매핑하여 거리 비교에 사용.
// 데이터 컬럼은 grade_level('초'/'중'/'고')과 grade(1..). semester(1|2)
function _gradeAbs(gradeLevel, grade, semester) {
  const g = Number(grade) || 0;
  const s = Number(semester) || 1;
  const lv = String(gradeLevel || '').trim();
  // 초: 1-1=2, 6-2=13
  // 중: 7-1(=중1-1) → 14, 9-2 → 19
  // 고: 10-1 → 20, 12-2 → 25
  if (lv === '중' || lv === 'mid' || lv === 'middle') return 14 + (g - 1) * 2 + (s - 1);
  if (lv === '고' || lv === 'high') return 20 + (g - 1) * 2 + (s - 1);
  // 초/elem/기본
  return g * 2 + (s - 1);
}

// 노드 메타 일괄 조회 (정렬/거리 계산용)
function _fetchNodeMetaMany(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT node_id, subject, grade, semester, grade_level, sort_order, unit_name, lesson_name, node_level
    FROM learning_map_nodes
    WHERE node_id IN (${placeholders})
  `).all(...nodeIds);
  const byId = new Map(rows.map(r => [r.node_id, r]));
  // 입력 순서로 반환 (누락은 빈 메타로)
  return nodeIds.map(nid => byId.get(nid) || { node_id: nid, subject: null, grade: 0, semester: 1, grade_level: null, sort_order: 0 });
}

// 우선순위 정렬: 목표 학년-학기와의 거리 오름차순 → subject(ko) → sort_order → node_id
// targetMeta: { grade_level, grade, semester } 직접 받아 일관성 유지
function _sortQueueByPriority(nodeIds, targetMeta) {
  if (!Array.isArray(nodeIds) || nodeIds.length <= 1) return [...(nodeIds || [])];
  const targetAbs = _gradeAbs(targetMeta.grade_level, targetMeta.grade, targetMeta.semester);
  const metas = _fetchNodeMetaMany(nodeIds);
  return metas
    .map(m => ({ ...m, _distance: Math.abs(_gradeAbs(m.grade_level, m.grade, m.semester) - targetAbs) }))
    .sort((a, b) => {
      if (a._distance !== b._distance) return a._distance - b._distance;
      const sa = a.subject || '';
      const sb = b.subject || '';
      const cmp = sa.localeCompare(sb, 'ko');
      if (cmp !== 0) return cmp;
      if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
      return String(a.node_id).localeCompare(String(b.node_id));
    })
    .map(m => m.node_id);
}

// 진단지 조립 (설계서 §3.3)
//   - node_level=2(단원)의 자식 차시(node_level=3) 조회
//   - 0개: 단원 자체에서 1문항
//   - 1~5개: 모두
//   - 6개 이상: sort_order 역순 5개
// 반환: [{ lessonId, lessonName, question(_pickQuestionForNode 결과) }, ...]  (길이 0~5)
function _buildDiagnosticSheet(unitNodeId) {
  const lessons = db.prepare(`
    SELECT node_id, lesson_name, sort_order
    FROM learning_map_nodes
    WHERE parent_node_id = ? AND node_level = 3
    ORDER BY sort_order ASC
  `).all(unitNodeId);

  let picked;
  if (!lessons || lessons.length === 0) {
    const q = _pickQuestionForNode(unitNodeId, 'medium');
    if (!q) return [];
    return [{ lessonId: unitNodeId, lessonName: null, question: q, ...q }];
  }
  if (lessons.length <= 5) {
    picked = lessons;
  } else {
    // sort_order 역순 5개 (단원 후반부일수록 핵심 도달 목표에 가깝다 — §3.2)
    picked = [...lessons].reverse().slice(0, 5);
  }
  const sheet = [];
  for (const l of picked) {
    const q = _pickQuestionForNode(l.node_id, 'medium');
    if (q) sheet.push({ lessonId: l.node_id, lessonName: l.lesson_name, question: q, ...q });
  }
  return sheet;
}

// ============================================================

function startDiagnosisCAT(userId, { targetNodeId, subject, grade, type }) {
  // targetNodeId 지정 시 직속 선수노드만 큐 구성 (v2 — BFS 전체 펼침 폐기)
  let nodeId = targetNodeId;
  if (!nodeId && subject) {
    // 학년 필터(있을 때만) — 초/중/고 표기를 정수로 정규화
    let gradeNum = null;
    if (grade != null && grade !== '') {
      const m = String(grade).match(/(\d+)/);
      if (m) gradeNum = parseInt(m[1], 10);
    }
    let first;
    if (gradeNum != null && Number.isFinite(gradeNum)) {
      first = db.prepare('SELECT node_id FROM learning_map_nodes WHERE subject = ? AND grade = ? ORDER BY semester, sort_order LIMIT 1').get(subject, gradeNum);
    }
    if (!first) {
      first = db.prepare('SELECT node_id FROM learning_map_nodes WHERE subject = ? ORDER BY grade, semester, sort_order LIMIT 1').get(subject);
    }
    nodeId = first?.node_id;
  }
  if (!nodeId) {
    const any = db.prepare('SELECT node_id FROM learning_map_nodes LIMIT 1').get();
    nodeId = any?.node_id;
  }
  if (!nodeId) throw new Error('진단 가능한 노드가 없습니다.');

  // 타깃 노드 메타 (우선순위 거리 계산 기준)
  const targetMeta = db.prepare(`
    SELECT node_id, subject, grade, semester, grade_level, unit_name, lesson_name, sort_order
    FROM learning_map_nodes WHERE node_id = ?
  `).get(nodeId) || { node_id: nodeId, grade_level: '초', grade: 0, semester: 1 };

  // v2: 직속 선수만 (한 단계). frontier 1회.
  const directPrereqs = db.prepare(
    'SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?'
  ).all(nodeId).map(r => r.from_node_id);

  // 직속 선수가 있으면 큐는 [선수들] (우선순위 정렬). 타깃 자체는 큐에 포함하지 않음.
  // 직속 선수가 없으면 타깃 자체를 큐에 넣어 진단 진행.
  let priorityQueue;
  if (directPrereqs.length === 0) {
    priorityQueue = [nodeId];
  } else {
    priorityQueue = _sortQueueByPriority(directPrereqs, targetMeta);
  }

  const difficultyPath = [];
  const perNodeAnswers = {};

  const info = db.prepare(`
    INSERT INTO diagnosis_sessions
      (user_id, target_node_id, diagnosis_type, status, total_questions,
       queue_nodes, current_node_id, current_difficulty, difficulty_path, per_node_answers)
    VALUES (?, ?, ?, 'in_progress', 0, ?, ?, 'medium', ?, ?)
  `).run(userId, nodeId, type || 'cat',
    JSON.stringify(priorityQueue), priorityQueue[0],
    JSON.stringify(difficultyPath),
    JSON.stringify(perNodeAnswers));

  // 큐의 첫 노드에서 진단지 조립 — 문항이 0개면 다음 큐 노드로 skip
  let startNodeId = priorityQueue[0];
  let sheet = [];
  for (let i = 0; i < priorityQueue.length; i++) {
    const nn = priorityQueue[i];
    const s = _buildDiagnosticSheet(nn);
    if (s.length > 0) {
      startNodeId = nn;
      sheet = s;
      break;
    }
  }
  if (startNodeId !== priorityQueue[0]) {
    db.prepare('UPDATE diagnosis_sessions SET current_node_id = ? WHERE id = ?')
      .run(startNodeId, info.lastInsertRowid);
  }

  // 응답용 큐는 currentNodeId 제외 (프론트가 current + queue 중복 렌더링하지 않도록)
  const responseQueue = priorityQueue.filter(n => n !== startNodeId);
  const queueNodesHydrated = _hydrateDiagNodes(responseQueue);
  const currentNodeHydrated = _hydrateDiagNodes([startNodeId])[0] || { id: startNodeId };

  // 사전 고지용 — 정렬된 전체 순서(현재 노드 포함, rank/gradeLabel 표기)
  const allOrder = [startNodeId, ...responseQueue];
  const allOrderMeta = _fetchNodeMetaMany(allOrder);
  const queueOrder = allOrderMeta.map((m, idx) => ({
    rank: idx + 1,
    nodeId: m.node_id,
    title: m.lesson_name || m.unit_name || '이전 단원',
    gradeLabel: (m.grade && m.semester) ? `${m.grade}-${m.semester}` : null,
    subject: m.subject || null
  }));

  // 첫 문항(하위호환 — v1 응답 형태) 보존
  const firstQuestion = sheet.length > 0 ? sheet[0].question : null;

  return {
    sessionId: info.lastInsertRowid,
    currentNodeId: startNodeId,
    currentNode: currentNodeHydrated,
    currentDifficulty: 'medium',
    queueNodes: responseQueue,
    queueNodesHydrated,
    // v2 신규
    prereqCount: directPrereqs.length,
    queueOrder,              // 사전 고지 모달용
    queueOrderHydrated: queueOrder,  // alias
    sheet,                   // 첫 단원의 진단지 (0~5문항)
    sheetSize: sheet.length,
    // 하위호환
    question: firstQuestion
  };
}

// 진단 큐 노드 정보 hydration — 라벨 표시용 단원/차시/영역 정보를 일괄 조회
function _hydrateDiagNodes(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return [];
  // SQLite IN(?,?,?,...) 안전 바인딩
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT node_id, unit_name, lesson_name, area, subject, grade
    FROM learning_map_nodes
    WHERE node_id IN (${placeholders})
  `).all(...nodeIds);
  const byId = {};
  rows.forEach(r => { byId[r.node_id] = r; });
  // 입력 순서 보존 + 누락된 노드도 graceful 처리
  // B3: 노드 ID 노출 금지 — fallback은 '이전 단원'으로 통일
  return nodeIds.map(nid => {
    const r = byId[nid];
    const title = r ? (r.lesson_name || r.unit_name || '이전 단원') : '이전 단원';
    return {
      id: nid,
      nodeId: nid,
      node_id: nid,
      title,
      unit_name: r?.unit_name || null,
      lesson_name: r?.lesson_name || null,
      area: r?.area || null,
      subject: r?.subject || null,
      grade: r?.grade || null
    };
  });
}

// ============================================================
// 진단 결과 보강 헬퍼 (B1/B2/B4 공용)
// ============================================================

// 결과 enum → 한글 라벨
function _resolveResultLabel(result) {
  switch (result) {
    case 'mastered': return '완전 이해';
    case 'proficient': return '잘함';
    case 'developing': return '더 봐야 함';
    case 'needs_review': return '다시 도전';
    default: return '결과 미정';
  }
}

// 상대 시간 포맷 (KST 기준 — DB는 CURRENT_TIMESTAMP UTC 저장 가정)
function _formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  // SQLite TIMESTAMP는 'YYYY-MM-DD HH:MM:SS' (UTC) 또는 ISO 형식
  // Date 파싱 시 공백 구분이면 UTC로 간주
  const s = String(timestamp).trim();
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return '방금 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}주 전`;
  // 그 외: YYYY-MM-DD (KST)
  const d = new Date(t + 9 * 60 * 60 * 1000); // UTC+9
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// nodeResults 배열에서 summary + areaStats 동시 산출
function _calculateSummary(nodeResults) {
  const summary = {
    correctRate: 0,
    totalCorrect: 0,
    totalQuestions: 0,
    passedNodes: 0,
    failedNodes: 0,
    totalNodes: 0,
    totalTimeSec: 0
  };
  const areaStats = [];
  if (!Array.isArray(nodeResults) || nodeResults.length === 0) {
    return { summary, areaStats };
  }
  summary.totalNodes = nodeResults.length;
  const areaMap = new Map();
  for (const r of nodeResults) {
    const c = Number(r.correctCount || 0);
    const t = Number(r.totalCount || 0);
    summary.totalCorrect += c;
    summary.totalQuestions += t;
    if (r.passed) summary.passedNodes++;
    else summary.failedNodes++;
    const areaKey = r.area || '기타';
    if (!areaMap.has(areaKey)) {
      areaMap.set(areaKey, { area: areaKey, correctCount: 0, totalCount: 0, rate: 0 });
    }
    const a = areaMap.get(areaKey);
    a.correctCount += c;
    a.totalCount += t;
  }
  summary.correctRate = summary.totalQuestions > 0
    ? summary.totalCorrect / summary.totalQuestions
    : 0;
  for (const a of areaMap.values()) {
    a.rate = a.totalCount > 0 ? a.correctCount / a.totalCount : 0;
    areaStats.push(a);
  }
  return { summary, areaStats };
}

// 세션의 응답 전·후 시각 차로 총 소요시간 계산 (초)
function _calculateTotalTime(sessionId) {
  try {
    const row = db.prepare(`
      SELECT (julianday(MAX(answered_at)) - julianday(MIN(answered_at))) * 86400 AS sec,
             COUNT(*) AS cnt
      FROM diagnosis_answers WHERE session_id = ?
    `).get(sessionId);
    if (!row || !row.cnt) return 0;
    return Math.max(0, Math.round(row.sec || 0));
  } catch {
    return 0;
  }
}

// 실패 노드 중심 추천 노드 + 학습목록 등록 여부
function _buildRecommendNodes(nodeResults, userId) {
  if (!Array.isArray(nodeResults) || nodeResults.length === 0) return [];
  const failed = nodeResults.filter(r => !r.passed);
  if (failed.length === 0) return [];
  // correctRate 오름차순 (가장 낮은 정답률부터)
  failed.sort((a, b) => (a.correctRate || 0) - (b.correctRate || 0));
  // 사용자의 학습목록 일괄 조회 (등록 여부)
  let learningList = new Set();
  try {
    const rows = db.prepare('SELECT node_id FROM user_learning_list WHERE user_id = ?').all(userId);
    learningList = new Set(rows.map(r => r.node_id));
  } catch {}
  return failed.map(r => ({
    nodeId: r.nodeId,
    title: r.title,
    area: r.area || null,
    reason: (r.correctRate || 0) < 0.5 ? '기초가 더 필요해요' : '한 번 더 풀어보면 좋아요',
    addedToLearningList: learningList.has(r.nodeId)
  }));
}

// 진단 결과 응답 보강 공용 — 세션 + nodeResults → summary/areaStats/recommendNodes/targetNode
function _buildResultEnrichment(session, nodeResults) {
  const safeNodeResults = Array.isArray(nodeResults) ? nodeResults : [];
  const { summary, areaStats } = _calculateSummary(safeNodeResults);
  summary.totalTimeSec = _calculateTotalTime(session.id);
  const recommendNodes = _buildRecommendNodes(safeNodeResults, session.user_id);
  // targetNode hydration (B1/B2 공용)
  let targetNode = null;
  if (session.target_node_id) {
    const t = db.prepare(`
      SELECT node_id, unit_name, lesson_name, area, subject, grade
      FROM learning_map_nodes WHERE node_id = ?
    `).get(session.target_node_id);
    targetNode = {
      id: session.target_node_id,
      title: t ? (t.lesson_name || t.unit_name || '이전 단원') : '이전 단원',
      area: t?.area || null,
      subject: t?.subject || null,
      grade: t?.grade || null
    };
  }
  return { summary, areaStats, recommendNodes, targetNode };
}

function submitDiagnosisAnswerCAT(sessionId, payload = {}) {
  // 진단평가 정책 v2 (2026-05-26 설계서):
  //   - 노드당 진단지는 1~5문항(차시 수 기반, _buildDiagnosticSheet)
  //   - 통과 조건 = 정답률 ≥ 0.60
  //   - 종료 = queue_empty | user_decided_to_learn | no_questions_anywhere
  //   - 단계 상한(MAX_NODE_STEPS=3) 및 연속 통과(CONSEC_PASS_TARGET=2) 제거
  //   - 실패 시 자동 종료/자동 drill-down 금지 — 응답에 recommendActions 3옵션 포함, 사용자 선택
  //
  // 본 함수는 "단일 문항" 단위 응답 호환을 유지하되, 시트 종료 시점에 v2 통과 판정을 수행한다.
  // 시트 단위 일괄 제출은 submitDiagnosisSheet(신규)를 사용.

  const PASS_THRESHOLD = 0.60;

  // snake_case/camelCase 모두 지원
  const contentId = payload.contentId != null ? payload.contentId : payload.content_id;
  const questionId = payload.questionId != null ? payload.questionId : payload.question_id;
  const answer = payload.answer;
  const nodeId = payload.nodeId || payload.node_id;

  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('세션 없음');
  if (session.status === 'completed') return { sessionComplete: true, finished: true };

  // questionId 필수 — clientIsCorrect 신뢰 금지(데이터 무결성)
  if (!questionId) {
    const err = new Error('questionId is required');
    err.statusCode = 400;
    throw err;
  }
  const q = db.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(questionId);
  if (!q) {
    const err = new Error('questionId not found');
    err.statusCode = 400;
    throw err;
  }
  const isCorrect = judgeQuestionAnswer(q, answer);

  const curNode = session.current_node_id || nodeId || session.target_node_id || 'unknown';

  // 답안 기록 — FK 방어
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

  // per_node_answers — 노드별 응답
  let perNodeAnswers = {};
  try { perNodeAnswers = JSON.parse(session.per_node_answers || '{}'); } catch {}
  if (!perNodeAnswers[curNode]) perNodeAnswers[curNode] = [];
  perNodeAnswers[curNode].push({ correct: isCorrect ? 1 : 0 });

  // 노드 진행 경로(D3 종료조건 판정용) — node 단위 통과/실패 누적
  let nodePath = [];
  try { nodePath = JSON.parse(session.difficulty_path || '[]'); } catch {}

  // 큐
  let queue = [];
  try { queue = JSON.parse(session.queue_nodes || '[]'); } catch {}

  // v2: 노드 종료는 호출자가 payload.sheetDone=true 로 알려주거나
  //      sheetTotal 메타가 함께 들어왔을 때 nodeHist 길이 ≥ sheetTotal 이면 종료.
  //      그 외에는 단일 문항 누적만 수행(시트 종료 판정은 submit-sheet에서).
  // 감리 REWORK fix: nodeHist 변수 명시 선언 (perNodeAnswers[curNode] 그대로 참조)
  const nodeHist = perNodeAnswers[curNode] || [];
  const sheetTotal = Number(payload.sheetTotal || 0);
  const sheetDone = !!payload.sheetDone || (sheetTotal > 0 && nodeHist.length >= sheetTotal);
  const nodeFinished = sheetDone && nodeHist.length > 0;
  let nodePassed = null;
  if (nodeFinished) {
    const correct = nodeHist.filter(a => a.correct === 1).length;
    nodePassed = (correct / nodeHist.length) >= PASS_THRESHOLD;
  }

  let nextNodeId = curNode;
  let nextQuestion = null;
  let sessionComplete = false;
  let endReason = null;
  let recommendActions = null;
  let drillDownPrereqCount = 0;

  if (nodeFinished) {
    const correct = nodeHist.filter(a => a.correct === 1).length;
    const correctRate = correct / nodeHist.length; // 0~1
    // 노드 상태 저장
    db.prepare(`
      INSERT OR REPLACE INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(session.user_id, curNode,
      nodePassed ? 'completed' : 'in_progress',
      nodePassed
        ? (correctRate >= 0.80 ? 'mastered' : 'proficient')
        : (correctRate >= 0.40 ? 'developing' : 'needs_review'),
      correctRate);

    nodePath.push({
      node: curNode,
      passed: nodePassed ? 1 : 0,
      correct,
      total: nodeHist.length,
      rate: correctRate,
      endedAt: new Date().toISOString()
    });

    // 큐에서 현재 노드 제거
    queue = queue.filter(qn => qn !== curNode);

    if (nodePassed) {
      // 자동 다음 노드 진행 — 문항/진단지가 있는 첫 노드 탐색
      while (queue.length > 0) {
        const nn = queue[0];
        const candSheet = _buildDiagnosticSheet(nn);
        if (candSheet && candSheet.length > 0) {
          nextNodeId = nn;
          nextQuestion = candSheet[0].question;
          break;
        }
        queue.shift();
      }
      if (!nextQuestion) {
        sessionComplete = true;
        endReason = queue.length === 0 ? 'queue_empty' : 'no_questions_anywhere';
      }
    } else {
      // 실패 — 자동 진행/자동 drill-down 금지. 3옵션 후보 반환.
      drillDownPrereqCount = db.prepare(
        'SELECT COUNT(1) AS cnt FROM learning_map_edges WHERE to_node_id = ?'
      ).get(curNode)?.cnt || 0;
      recommendActions = [
        { id: 'retry',      label: '다시 진단하기' },
        { id: 'drill_down', label: '더 아래 단원 진단하기', prereqCount: drillDownPrereqCount, disabled: drillDownPrereqCount === 0 },
        { id: 'learn_here', label: '바로 학습하기' }
      ];
      // 응답 단계에서는 세션을 종료하지 않음. 사용자 선택을 기다림.
      // 큐는 이미 curNode를 제외한 상태로 저장 → 사용자가 retry/drill_down 요청 시 재구성.
    }
  } else {
    // 시트 진행 중 — 다음 문항(같은 노드)을 단순히 1개 추가 제공
    nextQuestion = _pickQuestionForNode(curNode, 'medium');
    if (!nextQuestion) {
      // 문항 풀 고갈 → 시트 중단 종료
      sessionComplete = true;
      endReason = 'no_questions_anywhere';
    }
  }

  // 세션 갱신 (current_difficulty는 항상 medium)
  db.prepare(`
    UPDATE diagnosis_sessions SET
      queue_nodes = ?, current_node_id = ?, current_difficulty = 'medium',
      difficulty_path = ?, per_node_answers = ?,
      status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).run(JSON.stringify(queue), nextNodeId,
    JSON.stringify(nodePath), JSON.stringify(perNodeAnswers),
    sessionComplete ? 1 : 0, sessionComplete ? 1 : 0, sessionId);

  // D4: 세션 완료 시 미통과 노드를 학습목록 자동 추가
  let nodeResults = null;
  let addedToLearningList = [];
  if (sessionComplete) {
    nodeResults = nodePath.map(p => {
      const rate = p.total > 0 ? p.correct / p.total : 0;
      const nodeInfo = db.prepare('SELECT unit_name, lesson_name, area, grade FROM learning_map_nodes WHERE node_id = ?').get(p.node) || {};
      return {
        nodeId: p.node,
        node_id: p.node,
        // B3: 노드 ID 노출 금지 — fallback은 '이전 단원'
        title: nodeInfo.lesson_name || nodeInfo.unit_name || '이전 단원',
        area: nodeInfo.area,
        grade: nodeInfo.grade,
        passed: !!p.passed,
        correctCount: p.correct,
        totalCount: p.total,
        correctRate: rate // 0~1
      };
    });

    // D4: 미통과 노드 학습목록 자동 추가
    for (const r of nodeResults) {
      if (!r.passed) {
        try {
          db.prepare('INSERT OR IGNORE INTO user_learning_list (user_id, node_id) VALUES (?, ?)')
            .run(session.user_id, r.nodeId);
          addedToLearningList.push(r.nodeId);
        } catch (e) { /* 무시 */ }
      }
    }
  }

  // R1 (Phase 1 REWORK): 응답용 큐에서 nextNodeId(=새 currentNode) 제외 — 중복 렌더링 방지
  // DB의 queue_nodes는 진행 추적용으로 nextNodeId를 포함한 채 그대로 유지(이미 위에서 curNode만 필터됨).
  const responseQueue = (nextNodeId && !sessionComplete)
    ? queue.filter(qn => qn !== nextNodeId)
    : queue;

  // F1: 큐 + nextNode hydration (프론트가 라벨을 그릴 수 있도록 단원/차시/영역 정보 첨부)
  const queueNodesHydrated = _hydrateDiagNodes(responseQueue);
  const nextNodeHydrated = nextNodeId ? (_hydrateDiagNodes([nextNodeId])[0] || { id: nextNodeId }) : null;

  // B1/B5: 세션 완료 시 학생 친화 결과 화면용 필드(summary/areaStats/recommendNodes/targetNode) 보강
  let summary = null;
  let areaStats = null;
  let recommendNodes = null;
  let targetNode = null;
  if (sessionComplete) {
    const sessionRow = db.prepare('SELECT id, user_id, target_node_id FROM diagnosis_sessions WHERE id = ?').get(sessionId);
    if (sessionRow) {
      const enrichment = _buildResultEnrichment(sessionRow, nodeResults || []);
      summary = enrichment.summary;
      areaStats = enrichment.areaStats;
      recommendNodes = enrichment.recommendNodes;
      targetNode = enrichment.targetNode;
    }
  }

  // v2: nextAction 분기 — 사용자 선택을 명시
  let nextAction = null;
  if (sessionComplete) {
    nextAction = { type: 'complete' };
  } else if (nodeFinished && nodePassed) {
    nextAction = { type: 'auto_next' };
  } else if (nodeFinished && !nodePassed) {
    nextAction = { type: 'choose', options: recommendActions };
  } else {
    nextAction = { type: 'continue_sheet' };
  }

  // 현재 노드의 누적 정답률 (시트 진행 중에도 노출)
  const curCorrect = nodeHist.filter(a => a.correct === 1).length;
  const curTotal = nodeHist.length;
  const curRate = curTotal > 0 ? curCorrect / curTotal : 0;

  return {
    isCorrect,
    nodeFinished,
    nodePassed,
    correctRate: nodeFinished ? curRate : null,  // v2 — 노드 종료 시 정답률
    nextNodeId,
    nextNode: nextNodeHydrated,
    nextDifficulty: 'medium',
    question: nextQuestion,
    nextQuestion: nextQuestion,
    finished: sessionComplete,
    sessionComplete,
    queueRemaining: responseQueue.length,
    queueNodes: responseQueue,
    queueNodesHydrated,
    queueOrderHydrated: queueNodesHydrated,  // alias
    nodeResults,
    addedToLearningList,
    endReason,
    // v2 신규
    nextAction,
    recommendActions,  // 실패 시 3옵션, 통과/진행 중에는 null
    // B1: 학생 친화 결과 화면용 필드 — sessionComplete=true 일 때만 채워짐
    summary,
    areaStats,
    recommendNodes,
    targetNode
  };
}

// ============================================================
// 진단평가 정책 v2 — 시트 단위 일괄 제출 (신규)
// ============================================================
// 한 노드의 진단지(1~5문항) 응답을 한 번에 제출하여 통과/실패 + 다음 액션을 한 응답에 담는다.
// 프론트는 시트의 모든 문항에 답한 뒤 본 EP를 호출한다.
//
// payload: { answers: [{ questionId, lessonId, userAnswer, contentId? }, ...] }
// 응답: { nodeFinished, nodePassed, correctRate, results[], nextAction, queueRemainingHydrated, ... }
function submitDiagnosisSheet(sessionId, payload = {}) {
  const PASS_THRESHOLD = 0.60;

  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    const err = new Error('세션 없음');
    err.statusCode = 404;
    throw err;
  }
  if (session.status === 'completed') {
    return { sessionComplete: true, finished: true, nextAction: { type: 'complete' } };
  }
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  if (answers.length === 0) {
    const err = new Error('answers 배열이 비어 있습니다.');
    err.statusCode = 400;
    throw err;
  }

  const curNode = session.current_node_id || session.target_node_id;
  if (!curNode) {
    const err = new Error('현재 진단 노드를 확인할 수 없습니다.');
    err.statusCode = 400;
    throw err;
  }

  let perNodeAnswers = {};
  try { perNodeAnswers = JSON.parse(session.per_node_answers || '{}'); } catch {}
  if (!perNodeAnswers[curNode]) perNodeAnswers[curNode] = [];

  let queue = [];
  try { queue = JSON.parse(session.queue_nodes || '[]'); } catch {}
  let nodePath = [];
  try { nodePath = JSON.parse(session.difficulty_path || '[]'); } catch {}

  const results = [];
  let sessTotalDelta = 0;
  let sessCorrectDelta = 0;

  for (const a of answers) {
    const questionId = a.questionId != null ? a.questionId : a.question_id;
    if (!questionId) continue;
    const q = db.prepare('SELECT id, answer, options FROM content_questions WHERE id = ?').get(questionId);
    if (!q) {
      results.push({ questionId, lessonId: a.lessonId || null, isCorrect: false, skipped: true, reason: 'question_not_found' });
      continue;
    }
    const isCorrect = judgeQuestionAnswer(q, a.userAnswer != null ? a.userAnswer : a.answer);
    const contentId = a.contentId != null ? a.contentId : a.content_id;
    const safeContentId = resolveValidContentId(contentId, questionId);
    const recordNodeId = a.lessonId || curNode; // 분석 시 차시 단위 정답률 — §8.3-1
    try {
      db.prepare(`
        INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, recordNodeId, safeContentId, String(a.userAnswer != null ? a.userAnswer : (a.answer || '')), isCorrect ? 1 : 0);
    } catch (e) {
      if (String(e.message).includes('FOREIGN KEY')) {
        const anyContent = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get();
        db.prepare(`
          INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct)
          VALUES (?, ?, ?, ?, ?)
        `).run(sessionId, recordNodeId, anyContent ? anyContent.id : 1, String(a.userAnswer || ''), isCorrect ? 1 : 0);
      } else { throw e; }
    }
    perNodeAnswers[curNode].push({ correct: isCorrect ? 1 : 0, lessonId: a.lessonId || null, questionId });
    results.push({ questionId, lessonId: a.lessonId || null, isCorrect });
    sessTotalDelta += 1;
    if (isCorrect) sessCorrectDelta += 1;
  }

  if (sessTotalDelta > 0) {
    db.prepare(`
      UPDATE diagnosis_sessions
        SET total_questions = total_questions + ?, correct_count = correct_count + ?
       WHERE id = ?
    `).run(sessTotalDelta, sessCorrectDelta, sessionId);
  }

  // 통과 판정
  const correct = results.filter(r => r.isCorrect).length;
  const total = results.length;
  const correctRate = total > 0 ? correct / total : 0;
  const nodePassed = correctRate >= PASS_THRESHOLD;

  // user_node_status 갱신
  db.prepare(`
    INSERT OR REPLACE INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(session.user_id, curNode,
    nodePassed ? 'completed' : 'in_progress',
    nodePassed ? (correctRate >= 0.80 ? 'mastered' : 'proficient') : (correctRate >= 0.40 ? 'developing' : 'needs_review'),
    correctRate);

  // nodePath 누적 + sheetMeta 보존
  nodePath.push({
    node: curNode,
    passed: nodePassed ? 1 : 0,
    correct, total,
    rate: correctRate,
    sheetMeta: { sheetSize: total, answeredCount: total },
    endedAt: new Date().toISOString()
  });

  // 큐에서 curNode 제거 (이미 진단 완료한 노드)
  queue = queue.filter(qn => qn !== curNode);

  let nextNodeId = null;
  let nextSheet = [];
  let sessionComplete = false;
  let endReason = null;
  let recommendActions = null;
  let drillDownPrereqCount = 0;
  let nextAction = null;

  if (nodePassed) {
    // 자동 다음 노드 — 진단지 조립 가능한 첫 노드까지 skip
    while (queue.length > 0) {
      const nn = queue[0];
      const s = _buildDiagnosticSheet(nn);
      if (s && s.length > 0) {
        nextNodeId = nn;
        nextSheet = s;
        break;
      }
      queue.shift();
    }
    if (!nextNodeId) {
      sessionComplete = true;
      endReason = 'queue_empty';
      nextAction = { type: 'complete' };
    } else {
      nextAction = { type: 'auto_next' };
    }
  } else {
    // 실패 — 자동 종료 금지. 3옵션.
    drillDownPrereqCount = db.prepare(
      'SELECT COUNT(1) AS cnt FROM learning_map_edges WHERE to_node_id = ?'
    ).get(curNode)?.cnt || 0;
    recommendActions = [
      { id: 'retry',      label: '다시 진단하기' },
      { id: 'drill_down', label: '더 아래 단원 진단하기', prereqCount: drillDownPrereqCount, disabled: drillDownPrereqCount === 0 },
      { id: 'learn_here', label: '바로 학습하기' }
    ];
    nextAction = { type: 'choose', options: recommendActions };
  }

  // 세션 갱신
  db.prepare(`
    UPDATE diagnosis_sessions SET
      queue_nodes = ?, current_node_id = ?, current_difficulty = 'medium',
      difficulty_path = ?, per_node_answers = ?,
      status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).run(
    JSON.stringify(queue),
    nextNodeId || curNode,
    JSON.stringify(nodePath),
    JSON.stringify(perNodeAnswers),
    sessionComplete ? 1 : 0,
    sessionComplete ? 1 : 0,
    sessionId
  );

  // 세션 완료 시 결과 enrichment
  let nodeResults = null;
  let summary = null, areaStats = null, recommendNodes = null, targetNode = null;
  let addedToLearningList = [];
  if (sessionComplete) {
    nodeResults = nodePath.map(p => {
      const rate = (p.total || 0) > 0 ? (p.correct || 0) / p.total : 0;
      const nodeInfo = db.prepare('SELECT unit_name, lesson_name, area, grade FROM learning_map_nodes WHERE node_id = ?').get(p.node) || {};
      return {
        nodeId: p.node, node_id: p.node,
        title: nodeInfo.lesson_name || nodeInfo.unit_name || '이전 단원',
        area: nodeInfo.area, grade: nodeInfo.grade,
        passed: !!p.passed,
        correctCount: p.correct, totalCount: p.total,
        correctRate: rate
      };
    });
    for (const r of nodeResults) {
      if (!r.passed) {
        try {
          db.prepare('INSERT OR IGNORE INTO user_learning_list (user_id, node_id) VALUES (?, ?)')
            .run(session.user_id, r.nodeId);
          addedToLearningList.push(r.nodeId);
        } catch {}
      }
    }
    const sessionRow = db.prepare('SELECT id, user_id, target_node_id FROM diagnosis_sessions WHERE id = ?').get(sessionId);
    if (sessionRow) {
      const enrichment = _buildResultEnrichment(sessionRow, nodeResults);
      summary = enrichment.summary;
      areaStats = enrichment.areaStats;
      recommendNodes = enrichment.recommendNodes;
      targetNode = enrichment.targetNode;
    }
  }

  // 큐 hydration
  const queueRemainingHydrated = _hydrateDiagNodes(queue);
  const nextNodeHydrated = nextNodeId ? (_hydrateDiagNodes([nextNodeId])[0] || { id: nextNodeId }) : null;

  return {
    nodeFinished: true,
    nodePassed,
    correctRate,
    results,
    nextAction,
    recommendActions,
    // 다음 진행
    nextNodeId,
    nextNode: nextNodeHydrated,
    sheet: nextSheet,                 // 자동 진행 시 다음 단원 진단지
    sheetSize: nextSheet.length,
    queueRemaining: queue.length,
    queueRemainingHydrated,
    queueNodesHydrated: queueRemainingHydrated, // alias (호환)
    queueOrderHydrated: queueRemainingHydrated, // alias
    // 종료 시
    sessionComplete,
    finished: sessionComplete,
    endReason,
    nodeResults,
    summary,
    areaStats,
    recommendNodes,
    targetNode,
    addedToLearningList
  };
}

// ============================================================
// 진단평가 정책 v2 — 노드 재진단 (신규)
// ============================================================
// 같은 노드를 새 문항으로 다시 푼다. per_node_answers의 해당 노드 키를 초기화하고
// _buildDiagnosticSheet으로 새 진단지를 다시 조립한다.
function retryDiagnosisNode(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    const err = new Error('세션 없음');
    err.statusCode = 404;
    throw err;
  }
  if (session.status === 'completed') {
    const err = new Error('완료된 세션은 재진단할 수 없습니다.');
    err.statusCode = 400;
    throw err;
  }
  const curNode = session.current_node_id;
  if (!curNode) {
    const err = new Error('현재 진단 노드가 없습니다.');
    err.statusCode = 400;
    throw err;
  }

  // per_node_answers 초기화
  let perNodeAnswers = {};
  try { perNodeAnswers = JSON.parse(session.per_node_answers || '{}'); } catch {}
  perNodeAnswers[curNode] = [];

  // difficulty_path에서 마지막 동일 노드 항목 제거 (재진단이므로 직전 실패 기록은 빼고 새로 누적)
  let nodePath = [];
  try { nodePath = JSON.parse(session.difficulty_path || '[]'); } catch {}
  if (nodePath.length > 0 && nodePath[nodePath.length - 1].node === curNode) {
    nodePath.pop();
  }

  // 큐에 curNode가 없으면 다시 맨 앞에 추가 (이전 submit으로 제거되었음)
  let queue = [];
  try { queue = JSON.parse(session.queue_nodes || '[]'); } catch {}
  if (!queue.includes(curNode)) queue.unshift(curNode);

  // 새 진단지 조립
  const sheet = _buildDiagnosticSheet(curNode);
  if (!sheet || sheet.length === 0) {
    const err = new Error('재진단할 문항이 없습니다.');
    err.statusCode = 422;
    throw err;
  }

  db.prepare(`
    UPDATE diagnosis_sessions
       SET per_node_answers = ?, difficulty_path = ?, queue_nodes = ?
     WHERE id = ?
  `).run(JSON.stringify(perNodeAnswers), JSON.stringify(nodePath), JSON.stringify(queue), sessionId);

  const responseQueue = queue.filter(n => n !== curNode);
  const currentNodeHydrated = _hydrateDiagNodes([curNode])[0] || { id: curNode };
  return {
    currentNodeId: curNode,
    currentNode: currentNodeHydrated,
    sheet,
    sheetSize: sheet.length,
    queueRemaining: responseQueue.length,
    queueRemainingHydrated: _hydrateDiagNodes(responseQueue),
    queueOrderHydrated: _hydrateDiagNodes([curNode, ...responseQueue])
  };
}

function drillDownDiagnosis(sessionId, failedNodeId) {
  // v2: 실패 노드의 직속 선수를 큐에 추가하고, 기존 큐 전체와 함께 _sortQueueByPriority로 재정렬.
  //     응답에 다음 노드 진단지(sheet)와 정렬된 queueOrderHydrated 포함.
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    const err = new Error('세션 없음');
    err.statusCode = 404;
    throw err;
  }
  if (session.status === 'completed') {
    const err = new Error('완료된 세션은 drill-down 불가');
    err.statusCode = 400;
    throw err;
  }
  const fNodeId = failedNodeId || session.current_node_id;
  if (!fNodeId) {
    const err = new Error('failedNodeId 또는 current_node_id 필요');
    err.statusCode = 400;
    throw err;
  }

  let queue = [];
  try { queue = JSON.parse(session.queue_nodes || '[]'); } catch {}

  // 실패 노드의 직속 선수노드
  const prereqs = db.prepare('SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?')
    .all(fNodeId).map(r => r.from_node_id);
  const added = [];
  for (const p of prereqs) {
    if (!queue.includes(p) && p !== fNodeId) {
      queue.push(p);
      added.push(p);
    }
  }

  // 타깃 노드 메타 기준으로 큐 전체 우선순위 재정렬
  const targetMeta = db.prepare(`
    SELECT node_id, subject, grade, semester, grade_level
    FROM learning_map_nodes WHERE node_id = ?
  `).get(session.target_node_id) || { grade_level: '초', grade: 0, semester: 1 };
  queue = _sortQueueByPriority(queue, targetMeta);

  // 새 current는 큐의 첫 노드. 진단지 조립 가능한 첫 노드까지 skip.
  let currentNodeId = null;
  let sheet = [];
  for (let i = 0; i < queue.length; i++) {
    const nn = queue[i];
    const s = _buildDiagnosticSheet(nn);
    if (s && s.length > 0) {
      currentNodeId = nn;
      sheet = s;
      break;
    }
  }
  if (!currentNodeId && queue.length > 0) {
    currentNodeId = queue[0]; // 문항이 없어도 일단 첫 노드로 (UI에서 안내)
  }

  db.prepare('UPDATE diagnosis_sessions SET queue_nodes = ?, current_node_id = ?, current_difficulty = ? WHERE id = ?')
    .run(JSON.stringify(queue), currentNodeId, 'medium', sessionId);

  const responseQueue = currentNodeId ? queue.filter(n => n !== currentNodeId) : queue;
  const currentNodeHydrated = currentNodeId ? (_hydrateDiagNodes([currentNodeId])[0] || { id: currentNodeId }) : null;
  const queueRemainingHydrated = _hydrateDiagNodes(responseQueue);
  // 사전 고지/사이드바용 — 현재 노드 포함 정렬 순서 + rank/gradeLabel
  const allOrder = currentNodeId ? [currentNodeId, ...responseQueue] : responseQueue;
  const allOrderMeta = _fetchNodeMetaMany(allOrder);
  const queueOrderHydrated = allOrderMeta.map((m, idx) => ({
    rank: idx + 1,
    nodeId: m.node_id,
    title: m.lesson_name || m.unit_name || '이전 단원',
    gradeLabel: (m.grade && m.semester) ? `${m.grade}-${m.semester}` : null,
    subject: m.subject || null
  }));

  return {
    addedNodes: added,
    addedCount: added.length,
    currentNodeId,
    currentNode: currentNodeHydrated,
    sheet,
    sheetSize: sheet.length,
    queueRemaining: responseQueue.length,
    queueRemainingHydrated,
    queueOrderHydrated,
    // 하위호환
    question: sheet.length > 0 ? sheet[0].question : null
  };
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

  // R1 (Phase 1 REWORK): 응답용 큐에서 currentNodeId 제외 — 프론트 중복 렌더링 방지
  const curId = s.current_node_id;
  const responseQueue = curId ? queue.filter(qn => qn !== curId) : queue;

  return {
    sessionId: s.id,
    status: s.status,
    currentNodeId: curId,
    currentNode: curId ? (_hydrateDiagNodes([curId])[0] || { id: curId }) : null,
    currentDifficulty: s.current_difficulty,
    queueNodes: responseQueue,
    queueNodesHydrated: _hydrateDiagNodes(responseQueue),
    queueRemaining: responseQueue.length,
    perNodeAnswers: perNode,
    difficultyPath: path,
    totalQuestions: s.total_questions,
    correctCount: s.correct_count,
    targetNodeId: s.target_node_id
  };
}

// 진단용 폴백 problems: 노드 직접 매핑이 없을 때 자손/같은 단원 차시/같은 학년·과목에서 보충
function collectFallbackProblems(nodeId, userId, limit = 10) {
  const problemTypes = "('quiz','exam','problem','assessment','question')";
  let rows = [];

  // 폴백 1: closure 자손 노드에 매핑된 quiz
  try {
    rows = db.prepare(`
      SELECT c.id AS content_id, c.title, c.content_type, c.difficulty, c.estimated_minutes
      FROM curriculum_node_descendants d
      JOIN node_contents nc ON nc.node_id = d.descendant_id
      JOIN contents c ON nc.content_id = c.id
      WHERE d.ancestor_id = ? AND c.content_type IN ${problemTypes}
      LIMIT ?
    `).all(nodeId, limit);
  } catch (_) { rows = []; }

  // 폴백 2: 같은 단원(parent)의 차시 quiz
  if (rows.length === 0) {
    try {
      const node = db.prepare('SELECT parent_id, subject, grade FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
      if (node && node.parent_id) {
        rows = db.prepare(`
          SELECT c.id AS content_id, c.title, c.content_type, c.difficulty, c.estimated_minutes
          FROM learning_map_nodes lmn
          JOIN node_contents nc ON nc.node_id = lmn.node_id
          JOIN contents c ON nc.content_id = c.id
          WHERE lmn.parent_id = ? AND c.content_type IN ${problemTypes}
          LIMIT ?
        `).all(node.parent_id, limit);
      }
      // 폴백 3: 같은 학년·과목 풀
      if (rows.length === 0 && node && node.subject) {
        rows = db.prepare(`
          SELECT c.id AS content_id, c.title, c.content_type, c.difficulty, c.estimated_minutes
          FROM learning_map_nodes lmn
          JOIN node_contents nc ON nc.node_id = lmn.node_id
          JOIN contents c ON nc.content_id = c.id
          WHERE lmn.subject = ? ${node.grade ? 'AND lmn.grade = ?' : ''} AND c.content_type IN ${problemTypes}
          ORDER BY RANDOM()
          LIMIT ?
        `).all(...(node.grade ? [node.subject, node.grade, limit] : [node.subject, limit]));
      }
    } catch (_) { /* skip */ }
  }

  // 폴백 4: 전체 풀에서 랜덤
  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT c.id AS content_id, c.title, c.content_type, c.difficulty, c.estimated_minutes
      FROM contents c WHERE c.content_type IN ${problemTypes}
      ORDER BY RANDOM() LIMIT ?
    `).all(limit);
  }

  // problems 형태로 매핑 (questions 포함)
  return rows.map(c => {
    let questions = [];
    try {
      questions = db.prepare(`
        SELECT id, question_number, question_text, options, answer, explanation, difficulty, points
        FROM content_questions WHERE content_id = ? ORDER BY question_number LIMIT 5
      `).all(c.content_id).map(q => {
        let opts = []; try { opts = q.options ? JSON.parse(q.options) : []; } catch {}
        return { id: q.id, question_number: q.question_number, question_text: q.question_text,
                 options: opts, answer: q.answer, explanation: q.explanation,
                 difficulty: q.difficulty, points: q.points };
      });
    } catch (_) {}
    return {
      id: c.content_id, content_id: c.content_id,
      title: c.title, content_type: c.content_type,
      difficulty: c.difficulty || 'medium',
      questions, _fallback: true
    };
  });
}

module.exports = {
  init,
  getDailySets, getDailySetDetail, startDailyItem, completeDailyItem, getDailyStats,
  getDailyItemResult,
  createDailySet, updateDailySet, addDailyItem, removeDailyItem,
  getMapNodes, getMapNodeDetail, getMapEdges, getUserNodeStatuses,
  collectFallbackProblems,
  startDiagnosis, submitDiagnosisAnswer, finishDiagnosis, getDiagnosisResult,
  startDiagnosisCAT, submitDiagnosisAnswerCAT, drillDownDiagnosis, getDiagnosisState,
  getNextDiagnosisQuestion, listDiagnosisHistory,
  // 진단평가 정책 v2 신규
  submitDiagnosisSheet, retryDiagnosisNode,
  generateLearningPath, getCurrentPath, completeNode, evaluateNodeCompletion, inferNodeIdFromContent,
  // 추천학습 경로 시스템 (2026-05-27)
  buildRecommendedPath, listRecommendedPaths, getRecommendedPathBySession,
  updateRecommendedPathProgress, addRecommendedPathToLearningList,
  getLearningDashboard, getRanking,
  getWrongNotesExtended, getWrongNoteDashboard, getTeacherWrongNoteDashboard,
  addManualWrongNote, updateWrongNoteTags, retryWrongNote,
  getProblemSets, createProblemSet, getProblemSetDetail,
  addProblemSetItem, removeProblemSetItem, startProblemSet, submitProblemSet,
  // P0 추가
  recordProblemAttempt, recordVideoProgress,
  getLearningList, addLearningList, removeLearningList,
  getLastActivity, reportContent,
  // 정답 판정 헬퍼 (테스트/외부 사용)
  judgeQuestionAnswer, resolveCorrectAnswerText,
  // 시청형 콘텐츠 점수 가드 (테스트/재사용)
  normalizeProgressScore
};
