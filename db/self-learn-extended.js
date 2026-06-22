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

  // 진단 오답 → 오답노트 자동 등록 (권고서 §7-2)
  //  - diagnosis_sessions.diag_wrong_added: 이번 세션에서 오답노트에 새로 담은 누적 건수
  //  - wrong_answers 진단 오답 식별/중복방지용 인덱스 (student_id, source, question_number)
  try { db.exec('ALTER TABLE diagnosis_sessions ADD COLUMN diag_wrong_added INTEGER DEFAULT 0'); } catch (e) { /* exists */ }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_diag_dedup ON wrong_answers(student_id, source, question_number)');
  } catch (e) { /* 무시 */ }
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

  // 자기주도 오답 자동 수집(오늘의 학습) — 최초 완료 시점에 채점 상세(answers)에서 틀린 문항을 오답노트에 등록.
  //   콘텐츠 기반 항목(content_id 有)만 플레이어 복구 가능하므로 등록. 중복방지·graceful은 헬퍼가 처리.
  //   item.node_id 가 있으면 subject/unit_name 보강에 사용(있어도 source는 today_learning 고정).
  if (Array.isArray(answers) && answers.length > 0 && item.content_id) {
    for (const a of answers) {
      if (!a || a.isCorrect) continue;  // 정답이면 미등록
      _registerSelfLearnWrongNote(userId, {
        source: 'today_learning',
        contentId: item.content_id,
        nodeId: item.node_id || null,
        question: {
          question_number: a.questionNumber != null ? a.questionNumber : a.question_number,
          text: a.questionText != null ? a.questionText : a.question_text,
          options: a.options,
          answer: a.correctAnswer != null ? a.correctAnswer : a.correct_answer,
          explanation: a.explanation
        },
        studentAnswer: a.myAnswerText != null ? a.myAnswerText
                     : (a.myAnswer != null ? a.myAnswer : a.student_answer)
      });
    }
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
  // [2026-06-05 진단↔학습 분리] 저장된 status는 실제 학습으로만 산출된 값이다.
  //   진단은 status를 기록하지 않으므로 여기서 그대로 노출하면 학습맵이 실제 학습만 반영한다.
  const rows = db.prepare(`
    SELECT uns.* FROM user_node_status uns
    WHERE uns.user_id = ?
      AND EXISTS (SELECT 1 FROM learning_map_nodes lmn WHERE lmn.node_id = uns.node_id)
  `).all(userId);

  // 단원(level=2) 합성 상태 — getLearningDashboard와 동일 규칙.
  //   자식 차시(level=3)가 전부 completed면 단원 completed,
  //   1개라도 completed/in_progress면 단원 in_progress, 그 외 미노출(available).
  //   단원 노드에는 실제 학습이 직접 기록되지 않으므로(콘텐츠/문제는 차시에 매핑),
  //   자식 차시의 실제 학습 status로부터 단원 status를 산출한다.
  try {
    const childStatus = new Map(rows.map(r => [r.node_id, r.status]));
    const unitRows = db.prepare(`
      SELECT
        parent.node_id AS unit_id,
        COUNT(child.node_id) AS total_children,
        SUM(CASE WHEN uns.status = 'completed' THEN 1 ELSE 0 END) AS completed_children,
        SUM(CASE WHEN uns.status IN ('completed','in_progress','video_watched','mastered') THEN 1 ELSE 0 END) AS engaged_children
      FROM learning_map_nodes parent
      LEFT JOIN learning_map_nodes child
        ON child.parent_node_id = parent.node_id AND child.node_level = 3
      LEFT JOIN user_node_status uns
        ON uns.node_id = child.node_id AND uns.user_id = ?
      WHERE parent.node_level = 2
      GROUP BY parent.node_id
    `).all(userId);

    const rowByNode = new Map(rows.map(r => [r.node_id, r]));
    for (const u of unitRows) {
      const total = u.total_children || 0;
      const done = u.completed_children || 0;
      const engaged = u.engaged_children || 0;
      let synth = null;
      if (total > 0 && done === total) synth = 'completed';
      else if (engaged > 0) synth = 'in_progress';
      if (!synth) continue; // 학습 흔적 없는 단원은 미노출(available로 처리됨)
      const existing = rowByNode.get(u.unit_id);
      if (existing) {
        // 실제 학습 합성값으로 단원 status 보정 (강등 금지: completed는 유지)
        if (existing.status !== 'completed') existing.status = synth;
      } else {
        rows.push({ user_id: userId, node_id: u.unit_id, status: synth, diagnosis_result: null, correct_rate: null });
      }
    }
    void childStatus;
  } catch (_) { /* 단원 합성 실패는 차시 status만으로 반환 */ }

  return rows;
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
 * DB 사정 (실측 2026-06-08):
 *   - content_questions.answer 는 **0-based index 문자열과 1-based index 문자열이 혼재**한다.
 *     예) Q7951 answer="2" + opts=["5/8","6/8","7/8","8/8","12/16"] → 정답 "7/8"(0-based idx2)
 *         Q7    answer="3" + opts=["①24","②25","③27","④29"]        → 정답 "③27"(1-based pos3)
 *         Q228  answer="4" + opts=["①0","②-5","③3/4","④√2"]        → 정답 "④√2"(1-based, 0-based면 범위초과)
 *     일부는 정답 텍스트 자체("서울","27")로 저장됨.
 *   - 따라서 **숫자 인덱스만으로는 정답 옵션을 단정할 수 없다.** 가장 신뢰도 높은 신호는
 *     옵션 텍스트에 박힌 원숫자 prefix(①②③④)이다 → `_resolveCorrectIndex` 가 이를 최우선 사용.
 *
 * 채점 규약(통일):
 *   - 모든 FE 객관식 풀이는 **선택한 보기의 텍스트(answer) + 0-based answerIndex** 를 함께 전송한다.
 *     (오답노트 플레이어가 이미 쓰는 규약 — learning-map v2/v3·직접풀이도 동일하게 맞춤)
 *   - 본 헬퍼는 0-based 정답 index 를 robust 하게 산출한 뒤
 *       (a) submittedIndex(0-based) == correctIndex   ← 가장 신뢰
 *       (b) 선택 보기 텍스트 == 정답 보기 텍스트(정규화)
 *     중 하나라도 맞으면 정답으로 인정한다. 단답형은 텍스트 정규화(분수·공백·대소문자) 비교.
 *   - **0/1-based 우연 일치(맨숫자 직접 비교)로 오판하지 않는다.** 숫자만 들어와도
 *     정답 옵션 텍스트로 환산해 비교한다.
 */
function _normalizeAnswerText(s) {
  return String(s == null ? '' : s)
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]/, '')          // 원숫자 prefix 제거
    .replace(/^\s*\d+[\)\.\s]\s*/, '')         // "1) ", "1. " prefix 제거
    .replace(/\s+/g, '')
    .toLowerCase();
}

// 옵션 문자열 맨 앞의 원숫자(①②③④…) → 1-based 위치. 없으면 null.
const _CIRCLED_POS = { '①':1,'②':2,'③':3,'④':4,'⑤':5,'⑥':6,'⑦':7,'⑧':8,'⑨':9,'⑩':10 };
function _circledPos(opt) {
  const c = String(opt == null ? '' : opt).trim()[0];
  return _CIRCLED_POS[c] || null;
}

// question.options 를 배열로 정규화.
function _parseOptions(options) {
  if (Array.isArray(options)) return options;
  if (typeof options === 'string') {
    try { const j = JSON.parse(options); if (Array.isArray(j)) return j; } catch (_) {}
  }
  return null;
}

/**
 * 정답의 0-based index 를 robust 하게 산출.
 * 우선순위:
 *   1) 옵션 텍스트에 원숫자 prefix(①②③④)가 모두 있으면, answer 숫자와
 *      일치하는 prefix 위치를 정답으로 확정 (저장이 0-based든 1-based든 위치로 역산).
 *   2) answer 가 0-based 범위 내 정수면 그 index.
 *   3) answer 가 1-based 범위 내 정수면 index-1.
 *   4) answer 텍스트가 어떤 옵션과 (정규화) 일치하면 그 위치.
 * 산출 불가면 null.
 */
function _resolveCorrectIndex(rawAnswer, opts) {
  if (!opts || !opts.length) return null;
  const n = Number(String(rawAnswer).trim());

  // 1) 원숫자 prefix 기반 — 모든 옵션이 prefix 를 가질 때만 신뢰
  if (Number.isInteger(n)) {
    const positions = opts.map(_circledPos);
    if (positions.every(p => p != null)) {
      // answer 가 0-based 라면 정답 옵션의 prefix == n+1, 1-based 라면 prefix == n.
      // prefix 위치를 직접 찾는다(저장 규약과 무관).
      const byZero = (n >= 0 && n < opts.length) ? positions[n] : null;       // 0-based 가정 시 그 칸의 라벨
      const byOne  = (n >= 1 && n <= opts.length) ? positions[n - 1] : null;   // 1-based 가정 시 그 칸의 라벨
      // 0-based 자기일관(칸 라벨 == n+1) 이면 그 index, 1-based 자기일관(라벨 == n) 이면 index-1
      const zeroConsistent = byZero === n + 1;
      const oneConsistent  = byOne === n;
      if (zeroConsistent && !oneConsistent) return n;
      if (oneConsistent && !zeroConsistent) return n - 1;
      // 둘 다 자기일관이면(예: 균일 라벨 배열) 아래 범위 규칙으로 폴백
    }
  }

  // 2) 0-based 범위
  if (Number.isInteger(n) && n >= 0 && n < opts.length) return n;
  // 3) 1-based 범위 (0-based 범위 밖일 때)
  if (Number.isInteger(n) && n >= 1 && n <= opts.length) return n - 1;

  // 4) answer 텍스트 ↔ 옵션 위치
  const an = _normalizeAnswerText(rawAnswer);
  if (an) {
    const idx = opts.findIndex(o => _normalizeAnswerText(o) === an);
    if (idx >= 0) return idx;
  }
  return null;
}

/**
 * @param question  { answer, options(JSON or array) }
 * @param submitted 선택 보기 텍스트 또는 단답(또는 레거시 숫자 문자열)
 * @param submittedIndex (선택) 0-based 보기 index. 객관식은 이 값을 최우선 비교에 사용.
 */
function judgeQuestionAnswer(question, submitted, submittedIndex) {
  if (!question) return false;
  const rawAnswer = question.answer == null ? '' : String(question.answer).trim();
  const userRaw = submitted == null ? '' : String(submitted).trim();
  const subIdx = (submittedIndex == null || submittedIndex === '') ? null : Number(submittedIndex);
  const hasIdx = Number.isInteger(subIdx) && subIdx >= 0;
  if (userRaw === '' && !hasIdx) return false;

  const opts = _parseOptions(question.options);

  // ── 객관식: 정답 0-based index 를 robust 산출 후 index/텍스트 비교 ──
  if (opts && opts.length) {
    const correctIdx = _resolveCorrectIndex(rawAnswer, opts);

    // (a) 0-based index 직접 비교 (가장 신뢰 — FE 통일 규약)
    if (correctIdx != null && hasIdx && subIdx < opts.length) {
      return subIdx === correctIdx;
    }

    // (b) 선택 보기 텍스트 ↔ 정답 보기 텍스트 (정규화)
    if (correctIdx != null && userRaw !== '') {
      const correctText = _normalizeAnswerText(opts[correctIdx]);
      if (correctText && correctText === _normalizeAnswerText(userRaw)) return true;
    }

    // (b-2) 레거시 폴백: answerIndex 없이 맨숫자만 들어온 경우 → **0-based index**로 단정 비교.
    //   (구 FE/외부 호출 호환. 0/1-based 동시 인정은 오판 원인이므로 금지 — 0-based만 인정.)
    //   단, 숫자가 옵션 텍스트와 직접 일치(예: 옵션이 "3"인 수학 보기)하면 그건 텍스트로 (b)에서 처리됨.
    if (!hasIdx && correctIdx != null && userRaw !== '') {
      const userNum = Number(userRaw);
      if (Number.isInteger(userNum) && userNum >= 0 && userNum < opts.length) {
        // 옵션 텍스트가 그 숫자 자체가 아니면(= index 의도로 해석) 0-based 비교
        const numIsOptionText = opts.some(o => _normalizeAnswerText(o) === _normalizeAnswerText(userRaw));
        if (!numIsOptionText) return userNum === correctIdx;
      }
    }

    // (c) 레거시/방어: 사용자가 보기 텍스트가 아니라 정답 텍스트 자체를 보낸 경우
    if (userRaw !== '' && _normalizeAnswerText(rawAnswer) &&
        _normalizeAnswerText(rawAnswer) === _normalizeAnswerText(userRaw)) {
      return true;
    }

    // (d) index 도 텍스트도 매칭 불가 → 오답
    return false;
  }

  // ── 단답/텍스트 정답 (options 없음) ──
  if (userRaw === '') return false;
  // 직접 일치
  if (rawAnswer === userRaw) return true;
  // 정규화 비교 (① prefix·공백·대소문자)
  const ansNorm = _normalizeAnswerText(rawAnswer);
  const userNorm = _normalizeAnswerText(userRaw);
  if (ansNorm && ansNorm === userNorm) return true;
  // 수치 동치 (분수/소수)
  const a = _toNumericValue(userRaw);
  const b = _toNumericValue(rawAnswer);
  if (a != null && b != null && Math.abs(a - b) < 1e-9) return true;
  return false;
}

// 정답을 사용자에게 보여줄 텍스트 형태로 반환.
// 채점과 동일한 robust 인덱스 산출(_resolveCorrectIndex: 원숫자 prefix·0/1-based 혼재 흡수)을 사용해
// 표시 정답이 채점 정답과 항상 일치하도록 한다.
function resolveCorrectAnswerText(question) {
  if (!question) return null;
  const raw = question.answer == null ? '' : String(question.answer);
  const opts = _parseOptions(question.options);
  if (opts && opts.length) {
    const idx = _resolveCorrectIndex(raw, opts);
    if (idx != null && idx >= 0 && idx < opts.length) return String(opts[idx]);
  }
  return raw;
}

function submitDiagnosisAnswer(sessionId, payload = {}) {
  // snake_case/camelCase 모두 지원 (QA curl이 content_id 전송하는 케이스 대응)
  const nodeId = payload.nodeId || payload.node_id;
  const rawContentId = payload.contentId != null ? payload.contentId : payload.content_id;
  const questionId = payload.questionId != null ? payload.questionId : payload.question_id;
  const answer = payload.answer;
  const answerIndex = payload.answerIndex != null ? payload.answerIndex : payload.answer_index;

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
  if (judgeQuestionAnswer(q, answer, answerIndex)) isCorrect = 1;

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

  // 사용자 노드 진단 결과 기록 (status는 절대 갱신하지 않음)
  // [2026-06-05 진단↔학습 분리] 진단은 노드의 학습 status(완료/진행중)를 바꾸지 않는다.
  //   진단 결과(mastered/proficient/developing/needs_review)는 diagnosis_result·correct_rate 컬럼에만 보존.
  //   노드 status는 오직 실제 학습(영상 시청·문제풀이·차시 완료)으로만 산출된다(evaluateNodeCompletion 등).
  //   → ON CONFLICT DO UPDATE 로 기존 status를 그대로 보존하고 진단 결과 컬럼만 갱신.
  db.prepare(`
    INSERT INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
    VALUES (?, ?, 'not_started', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, node_id) DO UPDATE SET
      diagnosis_result = excluded.diagnosis_result,
      correct_rate = excluded.correct_rate,
      last_accessed_at = CURRENT_TIMESTAMP
  `).run(session.user_id, session.target_node_id, result, correctRate);

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

  // [2026-06-09 v3 분기] difficulty_path가 v3 state 객체({v3:true,...})면 v3 경로 빌더로 위임.
  //   v2(배열)는 아래 기존 로직 그대로 사용. 어떤 입력에도 throw 금지(빈 경로 안전 반환).
  let parsedDP = null;
  try { parsedDP = JSON.parse(session.difficulty_path || 'null'); } catch { parsedDP = null; }
  if (parsedDP && !Array.isArray(parsedDP) && parsedDP.v3) {
    return _buildRecommendedPathV3(session, parsedDP);
  }

  // 실패 노드 수집 — difficulty_path JSON에서 passed=false 또는 정답률 < 0.60
  let diagPath = Array.isArray(parsedDP) ? parsedDP : [];

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
 * [2026-06-09] v3 진단 state 기반 추천학습 경로 빌더.
 *
 * v3는 difficulty_path에 state 객체(배열 아님)를 저장한다(개념 단위 진행 상태).
 * 경로 STEP은 "개념 → 부모 단원 승격" 규칙으로 구성한다(학습 진입·차시 집계가 단원 기준).
 *
 * 규칙(기획서 §3.2):
 *   1. conceptOrder + visitedConcepts 에서 미통과 개념(!passed && !skipped) 수집.
 *   2. STEP 1 = 진단 확정 시작점(recommendedStartNode)의 부모 단원.
 *   3. 미통과 개념들을 각자의 부모 단원(node_level=2)으로 승격, 중복 단원 병합.
 *   4. 정렬: 학년 ASC → 학기 ASC → node_level ASC → area → sort_order (v2와 동일).
 *   5. 목표 단원(target_node_id)은 항상 마지막 STEP.
 *   6. 미통과 단원이 목표뿐이면 pathNodes=[targetUnit] 단일 STEP.
 *   7. learning_paths UPSERT (source_type='diagnosis', session_id).
 *
 * throw 금지: 입력 이상 시 빈/단일 경로로 안전 반환.
 *
 * @param {object} session diagnosis_sessions 행
 * @param {object} st 파싱된 v3 state
 * @returns {{pathId:number, sessionId:number, pathNodes:string[], created:boolean}|null}
 */
function _buildRecommendedPathV3(session, st) {
  const sid = Number(session.id);
  const userId = session.user_id;
  const targetUnitId = session.target_node_id;   // v3 target_node_id는 node_level=2 단원

  // 개념 → 부모 단원(node_level=2) 매핑 헬퍼 (개념이 곧 단원이면 그대로)
  const _parentUnitOf = (conceptId) => {
    if (!conceptId) return null;
    try {
      const n = db.prepare(
        'SELECT node_id, node_level, parent_node_id FROM learning_map_nodes WHERE node_id = ?'
      ).get(conceptId);
      if (!n) return null;
      if (n.node_level === 2) return n.node_id;             // 이미 단원
      if (n.parent_node_id) return n.parent_node_id;        // 개념(차시) → 부모 단원
      return n.node_id;
    } catch (_) { return null; }
  };

  // 1) 미통과 개념 수집 (conceptOrder + visitedConcepts, 통과·스킵 제외)
  const passed = new Set(Array.isArray(st.passedConcepts) ? st.passedConcepts : []);
  const skipped = new Set(Array.isArray(st.skippedConcepts) ? st.skippedConcepts : []);
  const conceptPool = [];
  const seenConcept = new Set();
  const pushConcept = (cid) => {
    if (!cid || seenConcept.has(cid)) return;
    seenConcept.add(cid);
    if (!passed.has(cid) && !skipped.has(cid)) conceptPool.push(cid);
  };
  (Array.isArray(st.conceptOrder) ? st.conceptOrder : []).forEach(pushConcept);
  (Array.isArray(st.visitedConcepts) ? st.visitedConcepts : []).forEach(pushConcept);

  // 2) 진단 확정 시작점(개념)의 부모 단원 → STEP 1 선두
  let startConceptId = null, startUnitId = null;
  try {
    const r = getDiagnosisResultV3(sid);
    if (r && r.recommendedStartNode && r.recommendedStartNode.nodeId) {
      startConceptId = r.recommendedStartNode.nodeId;
      startUnitId = _parentUnitOf(startConceptId);
    }
  } catch (e) {
    console.error('[_buildRecommendedPathV3] getDiagnosisResultV3 실패:', e.message);
  }

  // 3) 미통과 개념 → 부모 단원 승격(중복 제거)
  const unitSet = new Set();
  const unitOrder = [];          // 입력 순서 보존(시작점이 없을 때 폴백 정렬 기준)
  const addUnit = (uid) => {
    if (!uid || unitSet.has(uid)) return;
    unitSet.add(uid); unitOrder.push(uid);
  };
  if (startUnitId) addUnit(startUnitId);
  for (const cid of conceptPool) addUnit(_parentUnitOf(cid));
  // 목표 단원은 항상 후보(마지막에 별도 처리)
  if (targetUnitId) unitSet.add(targetUnitId);

  // 목표 단원을 제외한 중간 단원들
  const midUnits = unitOrder.filter(uid => uid !== targetUnitId);

  // 4) 정렬용 메타 일괄 조회
  const allUnitIds = [...new Set([...midUnits, targetUnitId, startUnitId].filter(Boolean))];
  let pathNodes = [];
  if (allUnitIds.length === 0) {
    pathNodes = [];
  } else {
    const placeholders = allUnitIds.map(() => '?').join(',');
    let metas = [];
    try {
      metas = db.prepare(`
        SELECT node_id, subject, grade, semester, area, node_level, sort_order, unit_name, lesson_name
        FROM learning_map_nodes WHERE node_id IN (${placeholders})
      `).all(...allUnitIds);
    } catch (_) { metas = []; }
    const metaById = Object.fromEntries(metas.map(m => [m.node_id, m]));

    const sortedMid = [...midUnits].sort((a, b) => {
      const ma = metaById[a] || {};
      const mb = metaById[b] || {};
      if ((ma.grade || 99) !== (mb.grade || 99)) return (ma.grade || 99) - (mb.grade || 99);
      if ((ma.semester || 9) !== (mb.semester || 9)) return (ma.semester || 9) - (mb.semester || 9);
      if ((ma.node_level || 9) !== (mb.node_level || 9)) return (ma.node_level || 9) - (mb.node_level || 9);
      if ((ma.area || '') !== (mb.area || '')) return String(ma.area || '').localeCompare(String(mb.area || ''));
      return (ma.sort_order || 0) - (mb.sort_order || 0);
    });

    // 시작점 단원이 정렬 후에도 선두가 되도록 보장(있으면 맨 앞으로)
    pathNodes = [...sortedMid];
    if (startUnitId && pathNodes.includes(startUnitId)) {
      pathNodes = [startUnitId, ...pathNodes.filter(u => u !== startUnitId)];
    }
    // 목표 단원은 마지막
    if (targetUnitId) pathNodes.push(targetUnitId);
  }

  // 6) 단일 STEP 폴백 — 아무것도 없으면 목표 단원만
  if (pathNodes.length === 0 && targetUnitId) pathNodes = [targetUnitId];

  // 7) learning_paths UPSERT
  const pathNodesJson = JSON.stringify(pathNodes);
  const lastNode = targetUnitId || pathNodes[pathNodes.length - 1] || '';
  const existing = db.prepare(
    "SELECT id FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis'"
  ).get(sid);
  if (existing) {
    db.prepare(`
      UPDATE learning_paths SET path_nodes = ?, target_node_id = ?, user_id = ? WHERE id = ?
    `).run(pathNodesJson, lastNode, userId, existing.id);
    return { pathId: existing.id, sessionId: sid, pathNodes, created: false };
  }
  const info = db.prepare(`
    INSERT INTO learning_paths (user_id, target_node_id, path_nodes, status, session_id, source_type)
    VALUES (?, ?, ?, 'active', ?, 'diagnosis')
  `).run(userId, lastNode, pathNodesJson, sid);
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
 * "학년-학기" 라벨 — FE `_diagV3UnitGradeSemLabel`과 동일 문자열 산출.
 *   예) {gradeLevel:'초',grade:3,semester:2} → "초3 2학기" / semester 없으면 "초3" / grade 없으면 ""
 *   gradeLevel(초/중/고)이 없으면 grade로 학교급 접두 추론(1~6 초, 7~9 중1~3, 10~12 고1~3).
 */
function _gradeSemLabel(obj) {
  if (!obj) return '';
  let g = obj.grade != null ? parseInt(obj.grade) : null;
  if (!Number.isFinite(g) || g <= 0) return '';
  let lv = String(obj.gradeLevel || '').trim();
  let dispG = g;
  // gradeLevel 미제공 시 grade로 학교급·학년 추론(중7→중1 등)
  if (!lv) {
    if (g >= 1 && g <= 6) { lv = '초'; dispG = g; }
    else if (g >= 7 && g <= 9) { lv = '중'; dispG = g - 6; }
    else if (g >= 10 && g <= 12) { lv = '고'; dispG = g - 9; }
  } else if (lv === '중' && g >= 7) { dispG = g - 6; }
  else if (lv === '고' && g >= 10) { dispG = g - 9; }
  const p = { '초': '초', '중': '중', '고': '고' }[lv] || '';
  const gradePart = p ? `${p}${dispG}` : `${dispG}학년`;
  const s = obj.semester != null ? parseInt(obj.semester) : null;
  const semPart = (Number.isFinite(s) && (s === 1 || s === 2)) ? ` ${s}학기` : '';
  return gradePart + semPart;
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
           lmn.unit_name, lmn.lesson_name, lmn.area, lmn.subject, lmn.grade, lmn.semester, lmn.grade_level
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
    // difficulty_path는 v2(노드 배열) 또는 v3(state 객체 {v3:true,...})일 수 있음.
    //   v3 객체에 .filter 호출 시 TypeError → 반드시 배열 가드. 비배열(객체/널)이면 빈 배열로 취급.
    let diagPath = [];
    try {
      const p = JSON.parse(r.difficulty_path || '[]');
      diagPath = Array.isArray(p) ? p : [];
    } catch {}

    // summary 계산 (v2 노드 배열 기준; v3는 빈 배열 → passed/failed 0, 진행률은 user_node_status로 산출)
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

    const gradeLabel = _gradeSemLabel({
      gradeLevel: r.grade_level, grade: r.grade, semester: r.semester
    });
    const targetUnitName = r.unit_name || r.lesson_name || '이전 단원';

    return {
      pathId: r.path_id,
      sessionId: r.session_id,
      status: r.status,
      diagnosedAt: r.completed_at || r.started_at || r.created_at,
      relativeTime: _formatRelativeTime(r.completed_at || r.started_at || r.created_at),
      // 이력 라벨용 플랫 필드(기획서 §데이터계약) — FE가 nested 없이도 바로 사용 가능. nested는 하위호환 유지.
      grade: r.grade != null ? r.grade : null,
      gradeLabel,
      area: r.area || null,
      targetUnitName,
      progressPercent,
      stepCount: pathNodes.length,
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

  // 진단 노드 결과 (passed/정답률) — v2(배열)와 v3(state 객체) 분기. 어떤 입력에도 throw 금지.
  let diagPathParsed = null;
  try { diagPathParsed = JSON.parse(session.difficulty_path || 'null'); } catch { diagPathParsed = null; }
  const diagByNode = {};
  const isV3 = diagPathParsed && !Array.isArray(diagPathParsed) && diagPathParsed.v3;

  if (isV3) {
    // v3: difficulty_path에 개념별 정답수가 없음 → diagnosis_answers를 단원(개념의 부모) 기준 집계.
    //   pathNodes는 단원(node_level=2)이므로 키도 단원 nodeId로 맞춘다. 집계 불가 단원은 미포함(FE "미진단").
    try {
      const answers = db.prepare(
        'SELECT node_id, is_correct FROM diagnosis_answers WHERE session_id = ?'
      ).all(sid);
      if (answers.length > 0) {
        // 응답된 개념들의 부모 단원 일괄 조회
        const ansConceptIds = [...new Set(answers.map(a => a.node_id).filter(Boolean))];
        const parentByConcept = {};
        if (ansConceptIds.length > 0) {
          const ph = ansConceptIds.map(() => '?').join(',');
          const rows = db.prepare(`
            SELECT node_id, node_level, parent_node_id FROM learning_map_nodes WHERE node_id IN (${ph})
          `).all(...ansConceptIds);
          for (const r of rows) {
            parentByConcept[r.node_id] = (r.node_level === 2)
              ? r.node_id
              : (r.parent_node_id || r.node_id);
          }
        }
        // 단원별 정답/총합 집계
        const agg = {};   // unitId -> { correct, total }
        for (const a of answers) {
          const unitId = parentByConcept[a.node_id] || a.node_id;
          if (!unitId) continue;
          if (!agg[unitId]) agg[unitId] = { correct: 0, total: 0 };
          agg[unitId].total += 1;
          if (a.is_correct) agg[unitId].correct += 1;
        }
        const PASS_RATE = 0.60;
        for (const [unitId, v] of Object.entries(agg)) {
          const rate = v.total > 0 ? v.correct / v.total : 0;
          diagByNode[unitId] = {
            passed: rate >= PASS_RATE,
            correctCount: v.correct,
            totalCount: v.total,
            correctRate: rate
          };
        }
      }
    } catch (e) {
      console.error('[getRecommendedPathBySession] v3 diagByNode 집계 실패:', e.message);
    }
  } else {
    // v2: difficulty_path 배열에서 노드별 결과 추출 (기존 로직 유지)
    const diagPath = Array.isArray(diagPathParsed) ? diagPathParsed : [];
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

  // [2026-06-09] v3: 첫 STEP(시작점 단원)에 진단 시작 개념명을 conceptHint로 보조 표기.
  let v3StartConceptName = null;
  if (isV3) {
    try {
      const r = getDiagnosisResultV3(sid);
      if (r && r.recommendedStartNode && r.recommendedStartNode.name) {
        v3StartConceptName = r.recommendedStartNode.name;
      }
    } catch (_) {}
  }

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
    const stepObj = {
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
    };
    // 첫 STEP(시작점 단원)에만 진단 시작 개념명 보조 표기(선택). 단원과 개념명이 다를 때만 노출.
    if (stepCounter === 1 && v3StartConceptName && v3StartConceptName !== stepObj.title) {
      stepObj.conceptHint = `${v3StartConceptName} 개념부터`;
    }
    groupMap.get(groupKey).steps.push(stepObj);
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
 * [2026-06-09] 학습경로 탭용 "현재 경로" — 가장 최근 완료 진단 세션의 경로.
 *   완료 세션 0건이면 { hasDiagnosis:false, groups:[] } (빈 상태 신호, throw 금지).
 *
 * @param {number} userId
 * @returns {{ hasDiagnosis:boolean, groups:Array, ... }}
 */
function getRecommendedPathCurrent(userId) {
  // 최신 완료 진단 세션 1건 (v2/v3 무관)
  let latest = null;
  try {
    latest = db.prepare(`
      SELECT id FROM diagnosis_sessions
      WHERE user_id = ? AND status = 'completed'
      ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
      LIMIT 1
    `).get(userId);
  } catch (e) {
    console.error('[getRecommendedPathCurrent] 세션 조회 실패:', e.message);
  }
  if (!latest || !latest.id) {
    return { hasDiagnosis: false, groups: [] };
  }
  let data = null;
  try {
    data = getRecommendedPathBySession(latest.id, userId);
  } catch (e) {
    console.error('[getRecommendedPathCurrent] 경로 합성 실패:', e.message);
  }
  if (!data) {
    return { hasDiagnosis: false, groups: [] };
  }
  return { hasDiagnosis: true, ...data };
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

// ─────────────────────────────────────────────────────────────────────────────
// 자기주도 문항풀이(problem_attempt) → 괄호형 성취기준코드(standard_code) 해석.
//   결함 A fix: learning_logs.achievement_code 가 NULL 이면 rebuildAllAggregates 가
//   WHERE achievement_code IS NOT NULL 로만 집계 → 자기주도 풀이가 mastery 히트맵에
//   영원히 안 잡힘. 그 시점의 nodeId·contentId 로 성취기준코드를 우선순위로 해석한다.
//
//   우선순위 (PM 확정):
//     1) nodeId → learning_map_nodes.achievement_code (이미 '[2수01-01]' 괄호형 저장)
//     2) contentId → contents.achievement_code
//     3) contentId → node_contents → learning_map_nodes.achievement_code
//     4) 없으면 null (억지 생성 금지 — 매핑 없는 node 는 NULL 이 정상)
//   괄호형 standard_code(string) 또는 null 반환. 어떤 경우에도 throw 가 전파되지 않게 graceful.
// ─────────────────────────────────────────────────────────────────────────────
function resolveAchievementForAttempt(nodeId, contentId) {
  // 1) node → achievement_code
  if (nodeId) {
    try {
      const r = db.prepare(
        'SELECT achievement_code FROM learning_map_nodes WHERE node_id = ?'
      ).get(nodeId);
      if (r && r.achievement_code && String(r.achievement_code).trim() !== '') {
        return String(r.achievement_code).trim();
      }
    } catch (_) { /* graceful */ }
  }
  if (contentId) {
    // 2) content → achievement_code
    try {
      const r = db.prepare(
        'SELECT achievement_code FROM contents WHERE id = ?'
      ).get(contentId);
      if (r && r.achievement_code && String(r.achievement_code).trim() !== '') {
        return String(r.achievement_code).trim();
      }
    } catch (_) { /* graceful */ }
    // 3) content → node_contents → node → achievement_code
    try {
      const r = db.prepare(`
        SELECT lmn.achievement_code
        FROM node_contents nc
        JOIN learning_map_nodes lmn ON nc.node_id = lmn.node_id
        WHERE nc.content_id = ? AND lmn.achievement_code IS NOT NULL AND lmn.achievement_code <> ''
        LIMIT 1
      `).get(contentId);
      if (r && r.achievement_code && String(r.achievement_code).trim() !== '') {
        return String(r.achievement_code).trim();
      }
    } catch (_) { /* graceful */ }
  }
  // 4) 매핑 없음 — NULL 유지(억지 생성 금지)
  return null;
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

// ============================================================
// 오답노트 "다시 풀기" 플레이어 — 원본 복구 + 서버 채점 (기획서 §6)
// ============================================================
//
// 보안 대전제: 풀이 화면 진입(/question) 응답에는 정답(answer)·해설(explanation)을
//   절대 포함하지 않는다(커닝 차단). 채점은 서버(retry)에서만 수행하고,
//   정답/해설은 채점 후 응답에서만 공개한다.

// exams.answers JSON 파싱 캐시 (요청 단위 단발 — 모듈 캐시 안 함, exam 행 직접 조회)
function _parseExamAnswers(examId) {
  if (!examId) return null;
  const row = db.prepare('SELECT answers FROM exams WHERE id = ?').get(examId);
  if (!row || !row.answers) return null;
  try {
    const parsed = JSON.parse(row.answers);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

// exams.answers 배열에서 (question_number)에 해당하는 원본 문항 객체를 찾는다.
//   스키마 A) { number, text, type, options, answer, points }   → number 일치
//   스키마 B) { question, options, answer, explanation }         → number 없음, 배열 index+1
function _findExamQuestion(examId, questionNumber) {
  const arr = _parseExamAnswers(examId);
  if (!arr || !arr.length) return null;
  const qn = Number(questionNumber);
  let q = Number.isFinite(qn) ? arr.find(x => x && Number(x.number) === qn) : null;
  if (!q && Number.isInteger(qn) && qn >= 1 && qn <= arr.length) {
    const cand = arr[qn - 1];
    if (cand && cand.number == null) q = cand;
  }
  // question_number 자체가 없으면(NULL) 복구 불가
  return q || null;
}

// 원본 문항 객체를 표준 형태로 정규화한다.
//   반환: { type, text, instruction, passage, options[], points, answer(raw), explanation } | null
// answer/explanation 은 채점/공개용으로만 사용하고, 풀이용 응답에서는 호출부가 제거한다.
function _normalizeOriginalQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const text = q.text != null ? q.text : (q.question != null ? q.question : null);
  if (text == null || String(text).trim() === '') return null;

  let options = null;
  if (Array.isArray(q.options)) options = q.options.slice();
  else if (typeof q.options === 'string') {
    try { const j = JSON.parse(q.options); if (Array.isArray(j)) options = j; } catch (_) { options = null; }
  }
  // 보기 텍스트 prefix(①, "1)" 등) 정리는 하지 않고 원본 그대로 노출(렌더 일관성).

  let type = q.type || q.question_type || null;
  if (!type) type = (options && options.length) ? 'choice' : 'short';
  // content_questions 는 'multiple_choice'/'single_choice' 등으로 저장 — 플레이어가 인식하는 'choice'/'short' 로 정규화.
  const tlc = String(type).toLowerCase();
  if (['multiple_choice', 'single_choice', 'mc', 'objective', 'select'].includes(tlc)) type = 'choice';
  else if (['short_answer', 'subjective', 'fill_blank', 'fill_in_blank'].includes(tlc)) type = 'short';
  if (type === 'essay') type = 'short';            // essay 는 입력칸 동일 취급
  if (type === 'choice' && (!options || !options.length)) type = 'short'; // 보기 없으면 단답 폴백

  return {
    type,
    text: String(text),
    instruction: q.instruction != null ? String(q.instruction) : null,
    passage: q.passage != null ? String(q.passage) : null,
    options: options || null,
    points: q.points != null ? Number(q.points) : null,
    answer: q.answer,                              // raw (index/text/"1.0" 혼재)
    explanation: q.explanation != null ? String(q.explanation) : null
  };
}

/**
 * 오답노트 1건의 원본 문항을 복구한다(채점·복구 공용 내부 헬퍼).
 * @returns {{
 *   recovery: 'ok'|'fallback_short'|'unavailable',
 *   question: {type,text,instruction,passage,options,points} | null,  // 정답/해설 미포함
 *   grading: { type, options, answer, explanation } | null            // 서버 채점 전용(노출 금지)
 * }}
 */
function _recoverWrongNoteQuestion(note) {
  // 1) 평가(exam) 원본 복구 — exam_id + question_number → exams.answers
  if (note.exam_id != null) {
    const raw = _findExamQuestion(note.exam_id, note.question_number);
    const q = _normalizeOriginalQuestion(raw);
    if (q) {
      // 원본 복구 성공 — 객관식(보기有)/단답 모두 정상 복구(recovery:'ok').
      //   기획서 §5: A(객관식)·B(단답) 둘 다 복구 성공이므로 'ok'.
      //   fallback_short 는 원본 링크가 없어 단답으로 폴백한 경우(아래 2단계)에만.
      return {
        recovery: 'ok',
        question: {
          type: q.type, text: q.text, instruction: q.instruction,
          passage: q.passage, options: q.options, points: q.points
        },
        grading: {
          type: q.type, options: q.options,
          answer: q.answer != null ? q.answer : note.correct_answer,
          explanation: q.explanation || note.explanation || null
        }
      };
    }
  }

  // 1-b) 자기주도(content) 원본 복구 — content_id + question_number → content_questions 원본 문항(선택지 포함).
  //   ai_learning / content / today_learning 오답 모두 동일 경로(콘텐츠 문항이 원본).
  if (note.content_id != null) {
    const q = _findContentQuestion(note.content_id, note.question_number);
    if (q) {
      return {
        recovery: 'ok',
        question: {
          type: q.type, text: q.text, instruction: q.instruction,
          passage: q.passage, options: q.options, points: q.points
        },
        grading: {
          type: q.type, options: q.options,
          answer: q.answer != null ? q.answer : note.correct_answer,
          explanation: q.explanation || note.explanation || null
        }
      };
    }
  }

  // 2) 원본 복구 실패 — correct_answer 보유 시 단답 폴백(C), 없으면 풀이 불가(D)
  const hasAnswer = note.correct_answer != null && String(note.correct_answer).trim() !== '';
  if (hasAnswer) {
    const fallbackText = note.question_text && String(note.question_text).trim() !== ''
      ? String(note.question_text) : '문제';
    return {
      recovery: 'fallback_short',
      question: { type: 'short', text: fallbackText, instruction: null, passage: null, options: null, points: null },
      grading: { type: 'short', options: null, answer: note.correct_answer, explanation: note.explanation || null }
    };
  }

  return {
    recovery: 'unavailable',
    question: null,
    grading: { type: null, options: null, answer: null, explanation: note.explanation || null }
  };
}

/**
 * GET /wrong-notes/:id/question 용 — 풀이용 문항(정답·해설 미포함) 반환.
 * @returns null(본인 오답 아님/없음) | { ...정답 미포함 페이로드 }
 */
function getWrongNoteQuestion(noteId, userId) {
  // 권한: 본인 오답만. 존재하나 타인 소유면 forbidden 신호(403), 아예 없으면 null(404).
  const owner = db.prepare('SELECT student_id FROM wrong_answers WHERE id = ?').get(noteId);
  if (!owner) return null;
  if (owner.student_id !== userId) return { forbidden: true };
  const note = db.prepare('SELECT * FROM wrong_answers WHERE id = ?').get(noteId);

  const rec = _recoverWrongNoteQuestion(note);

  // 같은 평가지 미해결 오답 묶음 정보(묶음 풀기 진입 안내용)
  let examGroup = null;
  if (note.exam_id != null) {
    const cnt = db.prepare(
      'SELECT COUNT(*) c FROM wrong_answers WHERE student_id = ? AND exam_id = ? AND is_resolved = 0'
    ).get(userId, note.exam_id).c;
    if (cnt >= 2) examGroup = { examId: note.exam_id, total: cnt };
  }

  const payload = {
    note_id: note.id,
    source: note.source || (note.exam_id != null ? 'exam' : 'manual'),
    subject: note.subject || null,
    unit_name: note.unit_name || null,
    recovery: rec.recovery,
    attempt_count: note.attempt_count || 0,
    is_resolved: note.is_resolved ? 1 : 0,
    examGroup
  };

  if (rec.recovery === 'unavailable') {
    payload.question = null;
    payload.can_retry = false;
    payload.explanation_available = !!(note.explanation && String(note.explanation).trim());
  } else {
    // ⚠ 정답(answer)·해설(explanation)은 절대 포함하지 않는다.
    payload.question = {
      number: note.question_number != null ? note.question_number : null,
      type: rec.question.type,
      instruction: rec.question.instruction,
      passage: rec.question.passage,
      text: rec.question.text,
      options: rec.question.options || null,
      points: rec.question.points
    };
    payload.can_retry = true;
  }
  return payload;
}

/**
 * GET /wrong-notes/by-exam/:examId/questions 용 — 같은 평가지 미해결 오답 묶음(정답 미포함).
 * @returns null(해당 없음) | { exam_id, subject, total, questions:[{note_id, ...정답 미포함}] }
 */
function getWrongNotesByExam(examId, userId) {
  const notes = db.prepare(
    'SELECT * FROM wrong_answers WHERE student_id = ? AND exam_id = ? AND is_resolved = 0 ORDER BY question_number ASC, id ASC'
  ).all(userId, examId);
  if (!notes.length) return null;

  const questions = notes.map(note => {
    const rec = _recoverWrongNoteQuestion(note);
    const item = {
      note_id: note.id,
      subject: note.subject || null,
      unit_name: note.unit_name || null,
      recovery: rec.recovery,
      attempt_count: note.attempt_count || 0
    };
    if (rec.recovery === 'unavailable') {
      item.question = null;
      item.can_retry = false;
    } else {
      item.question = {
        number: note.question_number != null ? note.question_number : null,
        type: rec.question.type,
        instruction: rec.question.instruction,
        passage: rec.question.passage,
        text: rec.question.text,
        options: rec.question.options || null,
        points: rec.question.points
      };
      item.can_retry = true;
    }
    return item;
  });

  const subject = notes.find(n => n.subject)?.subject || null;
  const examTitle = (db.prepare('SELECT title FROM exams WHERE id = ?').get(examId) || {}).title || null;
  return { exam_id: examId, exam_title: examTitle, subject, total: questions.length, questions };
}

// ── 서버 채점 정규화 (기획서 §6.3) ───────────────────────────────────
// 분수/소수 등 수치 동치 비교 (best-effort): "3/10" == "0.3", "1.0" == "1" 등.
function _toNumericValue(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (t === '') return null;
  // 분수 a/b
  const frac = t.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) return null;
    return Number(frac[1]) / den;
  }
  // 일반 수치 (정수/소수/"1.0")
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/**
 * 오답노트 채점 — 제출 답안과 복구된 정답을 정규화 비교.
 * @param grading { type, options, answer }  (복구 grading 객체)
 * @param submittedText  제출 텍스트 (보기 텍스트 또는 단답)
 * @param submittedIndex 제출 보기 index (0-based, 객관식; 없으면 null)
 * @returns { isCorrect, correctText, correctIndex }
 */
function _gradeWrongNote(grading, submittedText, submittedIndex) {
  const opts = Array.isArray(grading.options) ? grading.options : null;
  const rawAnswer = grading.answer == null ? '' : String(grading.answer).trim();

  // 정답 index 산출: answer 가 0-based index 숫자이고 options 범위 내면 그 index.
  //   exams 스키마는 0-based index(예: id130 answer=0), content_questions 는 1-based("1","2") 혼재.
  //   양쪽을 모두 시도하여 보기 텍스트도 함께 확보.
  let correctIndex = null;
  let correctText = rawAnswer;
  if (opts && opts.length) {
    const n = Number(rawAnswer);
    if (Number.isInteger(n)) {
      if (n >= 0 && n < opts.length) { correctIndex = n; correctText = String(opts[n]); }          // 0-based
      else if (n >= 1 && n <= opts.length) { correctIndex = n - 1; correctText = String(opts[n - 1]); } // 1-based
    }
    // answer 가 텍스트면 options 에서 위치 역참조
    if (correctIndex == null) {
      const idx = opts.findIndex(o => _normalizeAnswerText(o) === _normalizeAnswerText(rawAnswer));
      if (idx >= 0) { correctIndex = idx; correctText = String(opts[idx]); }
    }
  }

  // ── 판정 시도 (하나라도 일치하면 정답) ──
  const subText = submittedText == null ? '' : String(submittedText).trim();
  const subIdx = (submittedIndex == null || submittedIndex === '') ? null : Number(submittedIndex);

  // 1) 객관식 index 직접 일치 (정답 index 확정 시)
  if (correctIndex != null && Number.isInteger(subIdx)) {
    if (subIdx === correctIndex) return { isCorrect: true, correctText, correctIndex };
  }
  // 2) 제출 텍스트 == 정답 텍스트 (정규화)
  if (subText !== '') {
    if (_normalizeAnswerText(subText) === _normalizeAnswerText(correctText)) {
      return { isCorrect: true, correctText, correctIndex };
    }
    // 2-b) 제출 텍스트 == raw answer (텍스트 정답이 options 밖일 때)
    if (_normalizeAnswerText(subText) === _normalizeAnswerText(rawAnswer)) {
      return { isCorrect: true, correctText, correctIndex };
    }
    // 2-c) 제출 텍스트가 보기 index 숫자로 들어온 경우(0/1-based) → 정답 index 비교
    const subAsNum = Number(subText);
    if (correctIndex != null && Number.isInteger(subAsNum)) {
      if (subAsNum === correctIndex || subAsNum - 1 === correctIndex) {
        return { isCorrect: true, correctText, correctIndex };
      }
    }
    // 3) 단답 수치 동치 (분수/소수)
    const a = _toNumericValue(subText);
    const b = _toNumericValue(correctText);
    if (a != null && b != null && Math.abs(a - b) < 1e-9) {
      return { isCorrect: true, correctText, correctIndex };
    }
  }
  // 4) 제출 index 로 보기 텍스트 환산 후 텍스트 비교 (정답이 텍스트일 때)
  if (opts && Number.isInteger(subIdx) && subIdx >= 0 && subIdx < opts.length) {
    if (_normalizeAnswerText(opts[subIdx]) === _normalizeAnswerText(correctText)) {
      return { isCorrect: true, correctText, correctIndex };
    }
  }

  return { isCorrect: false, correctText, correctIndex };
}

function retryWrongNote(id, userId, { answer, answerIndex } = {}) {
  // 권한: 본인 오답만. 존재하나 타인 소유면 forbidden 신호(403), 없으면 null(404).
  const owner = db.prepare('SELECT student_id FROM wrong_answers WHERE id = ?').get(id);
  if (!owner) return null;
  if (owner.student_id !== userId) return { forbidden: true };
  const note = db.prepare('SELECT * FROM wrong_answers WHERE id = ?').get(id);

  // 원본 복구 → 서버 정규화 채점 (기획서 §6.2/§6.3)
  const rec = _recoverWrongNoteQuestion(note);
  let isCorrect = false, correctText = null, correctIndex = null;
  if (rec.recovery !== 'unavailable') {
    const graded = _gradeWrongNote(rec.grading, answer, answerIndex);
    isCorrect = graded.isCorrect;
    correctText = graded.correctText;
    correctIndex = graded.correctIndex;
  } else {
    // 복구 불가(D) — correct_answer 없음. 채점 불가, 오답 처리(해결 안 됨).
    correctText = note.correct_answer || null;
  }

  const wasResolved = note.is_resolved === 1;
  let pointsAwarded = 0;
  if (isCorrect && !wasResolved) {
    db.prepare('UPDATE wrong_answers SET is_resolved = 1 WHERE id = ?').run(id);
    const pts = parseInt(getSetting('wrong_note_resolve_point') || '5');
    awardPoints(userId, { source: 'wrong_note', sourceId: id, points: pts, description: '오답 해결' });
    pointsAwarded = pts;
  } else if (isCorrect && wasResolved) {
    // 이미 해결된 항목 재도전 — 해결 상태 유지, 포인트 재지급 없음.
  }
  db.prepare('UPDATE wrong_answers SET attempt_count = attempt_count + 1 WHERE id = ?').run(id);
  const newAttempt = (note.attempt_count || 0) + 1;

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

  // 채점 후이므로 정답·해설 공개 허용
  return {
    isCorrect,
    is_correct: isCorrect,
    resolved: isCorrect || wasResolved,
    attempt_count: newAttempt,
    correct_answer: correctText,
    correct_index: correctIndex,
    explanation: rec.grading.explanation || note.explanation || null,
    points_awarded: pointsAwarded
  };
}

/**
 * POST /wrong-notes/retry-batch 용 — 같은 평가지 묶음 일괄 채점.
 * @param items [{ note_id, answer, answerIndex }]
 * @returns { results:[{ note_id, is_correct, resolved, correct_answer, correct_index, explanation }], score, total }
 */
function retryWrongNoteBatch(userId, items) {
  const list = Array.isArray(items) ? items : [];
  const results = [];
  let score = 0;
  for (const it of list) {
    if (!it || it.note_id == null) continue;
    const r = retryWrongNote(parseInt(it.note_id), userId, { answer: it.answer, answerIndex: it.answerIndex });
    if (!r) { results.push({ note_id: it.note_id, error: 'not_found' }); continue; }
    if (r.forbidden) { results.push({ note_id: it.note_id, error: 'forbidden' }); continue; }
    if (r.is_correct) score++;
    results.push({
      note_id: parseInt(it.note_id),
      is_correct: r.is_correct,
      resolved: r.resolved,
      attempt_count: r.attempt_count,
      correct_answer: r.correct_answer,
      correct_index: r.correct_index,
      explanation: r.explanation,
      points_awarded: r.points_awarded
    });
  }
  return { results, score, total: results.filter(r => !r.error).length };
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

function recordProblemAttempt(userId, contentId, { isCorrect, selectedAnswer, userAnswer, answer, answerIndex, questionId, timeTaken, nodeId, sourceType }) {
  // 서버 측 정답 판정: questionId가 있으면 content_questions.answer와 비교 (client isCorrect 무시)
  // questionId 없으면 content 단위 제출로 간주하여 기존 client isCorrect 유지 (호환성)
  const submittedAnswer = selectedAnswer ?? userAnswer ?? answer ?? null;
  const submittedIndex = answerIndex;
  let finalIsCorrect;
  let questionExplanation = null;
  let correctAnswer = null;
  if (questionId) {
    const q = db.prepare('SELECT answer, options, explanation FROM content_questions WHERE id = ?').get(questionId);
    if (q) {
      finalIsCorrect = judgeQuestionAnswer(q, submittedAnswer, submittedIndex) ? 1 : 0;
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

  // 자기주도 오답 자동 수집 — 틀린 경우에만 오답노트(wrong_answers)에 등록(중복방지·graceful).
  //   source: nodeId 있으면 'ai_learning'(학습맵), 없으면 'content'(공개콘텐츠 단발문항).
  //   원본 문항은 questionId(있으면)→content_id+question_number 로 헬퍼가 조회/보강한다.
  if (!finalIsCorrect) {
    let qForNote = null;
    if (questionId) {
      const qrow = db.prepare(
        'SELECT id, question_number, question_text, question_type, options, answer, explanation, instruction, passage, points FROM content_questions WHERE id = ?'
      ).get(questionId);
      if (qrow) {
        qForNote = {
          question_number: qrow.question_number,
          text: qrow.question_text, type: qrow.question_type,
          options: qrow.options, answer: qrow.answer, explanation: qrow.explanation,
          instruction: qrow.instruction, passage: qrow.passage, points: qrow.points
        };
      }
    }
    _registerSelfLearnWrongNote(userId, {
      source: resolvedSource === 'ai_learning' ? 'ai_learning' : 'content',
      contentId, nodeId: nodeId || null, question: qForNote, studentAnswer: submittedAnswer
    });
  }

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
    // 결함 A fix: 성취기준코드/교과코드 주입 — 미주입 시 mastery 히트맵에 자기주도 풀이가 누락된다.
    const achievementCode = resolveAchievementForAttempt(nodeId, contentId);
    let subjectCode = null;
    if (achievementCode) {
      try {
        const ctx = require('./lrs-mastery').resolveCode(achievementCode);
        subjectCode = ctx && ctx.subject_code ? ctx.subject_code : null;
      } catch (_) { /* graceful */ }
    }
    logLearningActivity({
      userId, activityType: 'problem_attempt', targetType: 'content',
      targetId: contentId, verb: isCorrect ? 'passed' : 'attempted', sourceService: 'self-learn',
      resultSuccess: isCorrect ? 1 : 0,
      achievementCode: achievementCode || null,
      subjectCode: subjectCode || null
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

// ── 정답 비노출 sanitize (보안) ─────────────────────────────────────────────
//   v2 진단(_pickQuestionForNode / _buildDiagnosticSheet)이 만드는 "학생에게 내려가는 문항"
//   객체에서 정답류 필드를 제거한다. 채점은 questionId 로 content_questions 를 재조회하므로
//   응답에서 정답을 가려도 회귀가 없다. (v3 _v3PickQuestion 이 쓰는 비노출 규약과 동일 목적)
//   ⚠ 응답 직전 sanitize 만 — DB·내부 채점 로직의 정답은 그대로 유지.
const _DIAG_ANSWER_KEYS = [
  'answer', 'correct_answer', 'correctAnswer',
  'correctIndex', 'correct_index', 'answerIndex', 'answer_index',
  'explanation'
];
function _sanitizeDiagQuestion(q) {
  if (!q || typeof q !== 'object') return q;
  const out = { ...q };
  for (const k of _DIAG_ANSWER_KEYS) delete out[k];
  return out;
}

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

  // 정답 비노출(보안): answer/explanation 은 응답 객체에 싣지 않는다.
  //   채점은 submitDiagnosisAnswer/submitDiagnosisSheet 가 questionId 로 content_questions 를
  //   재조회해 수행하므로(이 함수 반환의 answer 를 쓰지 않음) 회귀가 없다.
  return _sanitizeDiagQuestion({
    // snake_case (하위 호환)
    content_id: picked.content_id,
    content_title: picked.title,
    question_id: q.id,
    question_number: q.question_number,
    question_text: q.question_text,
    options: opts,
    difficulty: q.difficulty || difficulty,
    points: q.points,
    node_id: nodeId,
    // camelCase (프론트 신규 API)
    contentId: picked.content_id,
    questionId: q.id,
    title: picked.title,
    questionText: q.question_text,
    nodeId: nodeId
  });
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

// 단원당 진단 문항 상한 — 권고서 §6-1 (5→3 축소). 2~3문항으로 수렴해 진단 시간 단축.
const DIAG_SHEET_MAX = 3;

// 진단지 조립 (설계서 §3.3 + 권고서 §6-1 상한 5→3)
//   - node_level=2(단원)의 자식 차시(node_level=3) 조회
//   - 0개: 단원 자체에서 1문항
//   - 1~3개: 모두
//   - 4개 이상: sort_order 역순 3개 (단원 후반부 우선 샘플링)
// 반환: [{ lessonId, lessonName, question(_pickQuestionForNode 결과) }, ...]  (길이 0~3)
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
  if (lessons.length <= DIAG_SHEET_MAX) {
    picked = lessons;
  } else {
    // sort_order 역순 상한 개수만 샘플링 (단원 후반부일수록 핵심 도달 목표에 가깝다 — §3.2·§6-1)
    picked = [...lessons].reverse().slice(0, DIAG_SHEET_MAX);
  }
  const sheet = [];
  for (const l of picked) {
    const q = _pickQuestionForNode(l.node_id, 'medium');
    if (q) sheet.push({ lessonId: l.node_id, lessonName: l.lesson_name, question: q, ...q });
  }
  return sheet;
}

// ============================================================
// 진단 종료 조건 상수 — 권고서 §5 (1차: B/C/D/E)
//   B. 단원 수 상한: 진단한 단원 수 ≥ DIAG_UNIT_CAP → endReason='unit_cap'
//   C. 누적 시간 소프트: 경과 ≥ DIAG_SOFT_TIME_SEC → nextAction.type='soft_stop' (강제 아님)
//   D. 큐 소진 / E. 사용자 종료: 현행 유지
// ============================================================
const DIAG_UNIT_CAP = 6;            // 진단 단원 수 상한
const DIAG_SOFT_TIME_SEC = 720;     // 누적 시간 소프트 한계(초) = 12분

// 세션 started_at 기준 경과 초 산출 (없거나 파싱 실패 시 0)
//   SQLite CURRENT_TIMESTAMP 은 'YYYY-MM-DD HH:MM:SS' 형태의 UTC naive 문자열이다.
//   이를 그대로 new Date() 에 넣으면 로컬 타임존으로 해석되어 타임존 오프셋(KST=9h)만큼
//   가짜 경과시간이 생긴다. ISO 형태로 정규화하고 Z(UTC)를 명시해 정확히 파싱한다.
function _parseSqliteUtc(ts) {
  if (!ts) return NaN;
  let s = String(ts).trim();
  // 이미 타임존 정보(Z/+/-)가 있으면 그대로 사용
  if (/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  // 'YYYY-MM-DD HH:MM:SS[.fff]' → 'YYYY-MM-DDTHH:MM:SS[.fff]Z'
  s = s.replace(' ', 'T');
  if (!/[zZ]$/.test(s)) s += 'Z';
  return new Date(s).getTime();
}

function _diagElapsedSec(session) {
  try {
    if (session && session.started_at) {
      const start = _parseSqliteUtc(session.started_at);
      if (Number.isFinite(start)) return Math.max(0, Math.round((Date.now() - start) / 1000));
    }
  } catch (_) {}
  return 0;
}

// 진단 진행 메타 — FE 헤더 표시용 계약 (권고서 §5·§C)
//   diagnosedUnits: 지금까지 진단(시트 제출 완료)한 단원 수
//   elapsedSec    : 세션 경과 초 (started_at 기준)
//   unitCap       : 단원 수 상한(상수)
//   softTimeLimitSec: 누적 시간 소프트 한계(상수)
function _buildDiagProgress(session, diagnosedUnitsOverride) {
  let diagnosedUnits = diagnosedUnitsOverride;
  if (diagnosedUnits == null) {
    // difficulty_path 길이 = 시트 제출 완료한 단원 수 (종료 메타 항목 _endReason 등은 제외)
    let path = [];
    try { path = JSON.parse((session && session.difficulty_path) || '[]'); } catch {}
    diagnosedUnits = path.filter(p => p && p.node).length;
  }
  return {
    diagnosedUnits,
    elapsedSec: _diagElapsedSec(session),
    unitCap: DIAG_UNIT_CAP,
    softTimeLimitSec: DIAG_SOFT_TIME_SEC
  };
}

// ============================================================
// 진단 2차 — 단원 단위 양방향 적응 헬퍼 (권고서 §4-3·§8 1차)
//   학습맵 unit_prerequisite edge(level2→level2)를 난이도 사다리로 사용한다.
//   전진(상위/후속) = from=현재 → to=후속   (난이도 상향)
//   후퇴(선수/하위) = to=현재   → from=선수  (난이도 하향)
// ============================================================

// 후속(상위) 단원 1개 선택 — 진단지 조립 가능 + 미방문 우선.
//   복수일 때 우선순위: 같은 과목 우선 → gradeAbs 가까운 순 → sort_order → node_id
//   visited(이미 진단·경유한 노드) 제외. 진단지(문항)가 없는 노드는 skip.
function _pickForwardUnit(curNodeId, visitedSet) {
  const succ = db.prepare(
    'SELECT to_node_id FROM learning_map_edges WHERE from_node_id = ?'
  ).all(curNodeId).map(r => r.to_node_id);
  return _pickAdjacentUnit(curNodeId, succ, visitedSet);
}

// 선수(하위) 단원 1개 선택 — 후퇴 방향. 규칙은 전진과 대칭.
function _pickBackwardUnit(curNodeId, visitedSet) {
  const prereq = db.prepare(
    'SELECT from_node_id FROM learning_map_edges WHERE to_node_id = ?'
  ).all(curNodeId).map(r => r.from_node_id);
  return _pickAdjacentUnit(curNodeId, prereq, visitedSet);
}

// 인접 후보 중 1개 선택 (전진/후퇴 공용). 미방문·진단지 조립 가능한 단원만.
function _pickAdjacentUnit(curNodeId, candidateIds, visitedSet) {
  const visited = visitedSet || new Set();
  const cands = (candidateIds || []).filter(id => id && id !== curNodeId && !visited.has(id));
  if (cands.length === 0) return null;
  const curMeta = db.prepare(
    'SELECT subject, grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ?'
  ).get(curNodeId) || {};
  const curAbs = _gradeAbs(curMeta.grade_level, curMeta.grade, curMeta.semester);
  const metas = _fetchNodeMetaMany(cands)
    .map(m => ({
      ...m,
      _sameSubject: (m.subject && curMeta.subject && m.subject === curMeta.subject) ? 0 : 1,
      _distance: Math.abs(_gradeAbs(m.grade_level, m.grade, m.semester) - curAbs)
    }))
    .sort((a, b) => {
      if (a._sameSubject !== b._sameSubject) return a._sameSubject - b._sameSubject;
      if (a._distance !== b._distance) return a._distance - b._distance;
      if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
      return String(a.node_id).localeCompare(String(b.node_id));
    });
  // 진단지 조립 가능한 첫 후보 선택 (문항 없는 노드는 건너뜀)
  for (const m of metas) {
    const s = _buildDiagnosticSheet(m.node_id);
    if (s && s.length > 0) return { nodeId: m.node_id, sheet: s };
  }
  return null;
}

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

  // 진단 2차 — 양방향 적응: 시작 단원 = 선택/타깃 단원 자체에서 출발(권고서 §4-3).
  //   통과 시 후속(상위)으로 전진, 실패 시 선수(하위)로 후퇴를 submitDiagnosisSheet에서 동적으로 결정.
  //   따라서 초기 큐는 타깃 노드 1개만. (선수 노드는 후퇴 시 _pickBackwardUnit이 동적으로 탐색)
  //   단, 타깃 노드 자체에 진단지(문항)가 없으면 직속 선수를 우선순위 정렬해 폴백.
  let priorityQueue;
  const targetSheetProbe = _buildDiagnosticSheet(nodeId);
  if (targetSheetProbe.length > 0 || directPrereqs.length === 0) {
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

  // 진단 진행 메타 (FE 헤더 표시용) — 시작 시점: 진단 완료 단원 0개, 경과 ≈0초
  const startedSession = db.prepare('SELECT started_at, difficulty_path FROM diagnosis_sessions WHERE id = ?').get(info.lastInsertRowid);
  const progress = _buildDiagProgress(startedSession, 0);

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
    sheet,                   // 첫 단원의 진단지 (0~3문항)
    sheetSize: sheet.length,
    // 진단 1차 — 진행 메타 (권고서 §5·§C)
    progress,
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
  const answerIndex = payload.answerIndex != null ? payload.answerIndex : payload.answer_index;
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
  // 오답노트 등록(3차)을 위해 문항 메타(question_text/explanation)까지 확보.
  //   content_id·question_number 도 함께 조회 → 오답노트에 저장해 플레이어가 원본 콘텐츠 문항(객관식 options) 복구 가능
  const q = db.prepare('SELECT id, content_id, question_number, answer, options, question_text, explanation FROM content_questions WHERE id = ?').get(questionId);
  if (!q) {
    const err = new Error('questionId not found');
    err.statusCode = 400;
    throw err;
  }
  const isCorrect = judgeQuestionAnswer(q, answer, answerIndex);

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

  // 진단 3차 — 틀린 문항을 오답노트(wrong_answers)에 자동 등록 (권고서 §7-2). 중복방지는 헬퍼 내부 처리.
  let wrongNotesAdded = 0;
  if (!isCorrect) {
    const added = _registerDiagnosisWrongNote(session.user_id, curNode, q, answer);
    if (added) wrongNotesAdded += 1;
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

  // 현재 노드 누적 정답률 (시트 진행 중에도 노출)
  const curCorrect = nodeHist.filter(a => a.correct === 1).length;
  const curTotal = nodeHist.length;
  const curRate = curTotal > 0 ? curCorrect / curTotal : 0;

  // ────────────────────────────────────────────────────────────
  // 단원완료(nodeFinished): 양방향·종료조건·시작점·오답누적은 공통 헬퍼에 위임 (감리 H-1)
  // ────────────────────────────────────────────────────────────
  if (nodeFinished) {
    const correct = nodeHist.filter(a => a.correct === 1).length;
    const correctRate = correct / nodeHist.length; // 0~1
    // [2026-06-05 진단↔학습 분리] 진단은 노드 학습 status(완료/진행중)를 바꾸지 않는다.
    //   진단 결과(diagnosis_result·correct_rate)만 컬럼에 보존하고 status는 기존값 그대로 유지.
    //   노드 status는 실제 학습(영상·문제·차시 완료)으로만 산출(evaluateNodeCompletion 등).
    const diagResult = nodePassed
      ? (correctRate >= 0.80 ? 'mastered' : 'proficient')
      : (correctRate >= 0.40 ? 'developing' : 'needs_review');
    db.prepare(`
      INSERT INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
      VALUES (?, ?, 'not_started', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, node_id) DO UPDATE SET
        diagnosis_result = excluded.diagnosis_result,
        correct_rate = excluded.correct_rate,
        last_accessed_at = CURRENT_TIMESTAMP
    `).run(session.user_id, curNode, diagResult, correctRate);

    nodePath.push({
      node: curNode,
      passed: nodePassed ? 1 : 0,
      correct,
      total: nodeHist.length,
      rate: correctRate,
      endedAt: new Date().toISOString()
    });

    // 큐에서 현재 노드 제거 후 공통 후처리 (세션 갱신·diag_wrong_added 가산 포함)
    queue = queue.filter(qn => qn !== curNode);
    const fin = _finalizeDiagNodeOutcome({
      sessionId, session, curNode,
      nodePassed, correctRate,
      nodePath, queue, perNodeAnswers,
      wrongNotesAdded
    });

    // 실경로(/answer)는 문항 단건 흐름 — 다음 단원 진단지의 첫 문항 1개를 제공
    const nextQuestion = (fin.nextSheet && fin.nextSheet.length > 0)
      ? fin.nextSheet[0].question
      : null;
    // 전진/후퇴할 다음 노드는 있으나 진단지 첫 문항이 비면 종료 처리 (no_questions_anywhere)
    let sessionComplete = fin.sessionComplete;
    let endReason = fin.endReason;
    if (!sessionComplete && fin.nextNodeId && !nextQuestion) {
      sessionComplete = true;
      endReason = endReason || 'no_questions_anywhere';
      db.prepare(`UPDATE diagnosis_sessions SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(sessionId);
    }

    // 응답용 큐에서 다음 노드 제외 (중복 렌더링 방지)
    const responseQueue = (fin.nextNodeId && !sessionComplete)
      ? fin.queue.filter(qn => qn !== fin.nextNodeId)
      : fin.queue;
    const queueNodesHydrated = _hydrateDiagNodes(responseQueue);

    return {
      isCorrect,
      nodeFinished: true,
      nodePassed,
      correctRate,
      nextNodeId: fin.nextNodeId || curNode,
      nextNode: fin.nextNodeHydrated,
      nextDifficulty: 'medium',
      question: nextQuestion,
      nextQuestion,
      nextSheetSize: (fin.nextSheet && fin.nextSheet.length) || 0,  // 다음 단원 진단지 문항 수 (sheetTotal 인계용)
      finished: sessionComplete,
      sessionComplete,
      queueRemaining: responseQueue.length,
      queueNodes: responseQueue,
      queueNodesHydrated,
      queueOrderHydrated: queueNodesHydrated,
      nodeResults: fin.nodeResults,
      addedToLearningList: fin.addedToLearningList,
      endReason,
      nextAction: fin.nextAction,
      recommendActions: fin.recommendActions,
      // 진단 1·2차 — 진행메타·소프트종료·양방향·시작점
      progress: fin.progress,
      softStop: fin.softStop,
      adaptiveDirection: fin.adaptiveDirection,
      recommendedStartNodeId: fin.recommendedStartNodeId,
      recommendedStartNode: fin.recommendedStartNode,
      // 진단 3차 — 오답노트 등록 건수
      wrongNotesAdded: fin.wrongNotesAdded,
      wrongNotesAddedTotal: fin.wrongNotesAddedTotal,
      // 결과 enrichment (완료 시)
      summary: fin.summary,
      areaStats: fin.areaStats,
      recommendNodes: fin.recommendNodes,
      targetNode: fin.targetNode
    };
  }

  // ────────────────────────────────────────────────────────────
  // 시트 진행 중(단원 미완료): 같은 노드 다음 문항 1개 + 진행메타만
  // ────────────────────────────────────────────────────────────
  let nextQuestion = _pickQuestionForNode(curNode, 'medium');
  let sessionComplete = false;
  let endReason = null;
  if (!nextQuestion) {
    sessionComplete = true;
    endReason = 'no_questions_anywhere';
  }

  // 세션 갱신 (current_difficulty는 항상 medium) + 이번 호출 오답노트 누적
  db.prepare(`
    UPDATE diagnosis_sessions SET
      queue_nodes = ?, current_node_id = ?, current_difficulty = 'medium',
      difficulty_path = ?, per_node_answers = ?,
      diag_wrong_added = COALESCE(diag_wrong_added, 0) + ?,
      status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).run(JSON.stringify(queue), curNode,
    JSON.stringify(nodePath), JSON.stringify(perNodeAnswers),
    wrongNotesAdded,
    sessionComplete ? 1 : 0, sessionComplete ? 1 : 0, sessionId);

  const wrongNotesAddedTotal = db.prepare(
    'SELECT COALESCE(diag_wrong_added, 0) AS n FROM diagnosis_sessions WHERE id = ?'
  ).get(sessionId)?.n || 0;

  // 진행 중 메타 (헤더 표시용) — 종료 필드는 단원완료/세션종료 시에만
  const progress = _buildDiagProgress(
    db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId)
  );

  // 세션 완료(문항 고갈) 시 결과 enrichment
  let nodeResults = null, addedToLearningList = [];
  let summary = null, areaStats = null, recommendNodes = null, targetNode = null;
  if (sessionComplete) {
    nodeResults = nodePath.map(p => {
      const rate = p.total > 0 ? p.correct / p.total : 0;
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
        } catch (e) { /* 무시 */ }
      }
    }
    const sessionRow = db.prepare('SELECT id, user_id, target_node_id FROM diagnosis_sessions WHERE id = ?').get(sessionId);
    if (sessionRow) {
      const enrichment = _buildResultEnrichment(sessionRow, nodeResults || []);
      summary = enrichment.summary;
      areaStats = enrichment.areaStats;
      recommendNodes = enrichment.recommendNodes;
      targetNode = enrichment.targetNode;
    }
  }

  const responseQueue = (curNode && !sessionComplete)
    ? queue.filter(qn => qn !== curNode)
    : queue;
  const queueNodesHydrated = _hydrateDiagNodes(responseQueue);
  const nextNodeHydrated = curNode ? (_hydrateDiagNodes([curNode])[0] || { id: curNode }) : null;

  return {
    isCorrect,
    nodeFinished: false,
    nodePassed: null,
    correctRate: null,
    nextNodeId: curNode,
    nextNode: nextNodeHydrated,
    nextDifficulty: 'medium',
    question: nextQuestion,
    nextQuestion,
    finished: sessionComplete,
    sessionComplete,
    queueRemaining: responseQueue.length,
    queueNodes: responseQueue,
    queueNodesHydrated,
    queueOrderHydrated: queueNodesHydrated,
    nodeResults,
    addedToLearningList,
    endReason,
    nextAction: sessionComplete ? { type: 'complete' } : { type: 'continue_sheet' },
    recommendActions: null,
    // 진행 중에는 progress만 (종료 필드 없음)
    progress,
    wrongNotesAdded,
    wrongNotesAddedTotal,
    summary,
    areaStats,
    recommendNodes,
    targetNode
  };
}

// 진단 오답 1건을 오답노트(wrong_answers)에 자동 등록 — 권고서 §7-2
//  - source='diagnosis', exam_id=NULL(진단은 시험 아님), question_number=문항ID(중복방지 키)
//  - 중복방지: 같은 학생이 같은 문항(question_number)을 진단으로 또 틀리면, 미해결 항목이 있으면
//    attempt_count++ 후 skip. 미해결 항목이 없으면(이미 해결했거나 처음이면) 새로 INSERT.
//  - 메타 부족(question_text 없음)이면 등록하지 않고 false 반환(크래시 금지).
// 반환: 새로 INSERT 했으면 true, (중복으로) attempt_count만 증가/스킵했으면 false.
function _registerDiagnosisWrongNote(userId, nodeId, q, studentAnswer) {
  try {
    const qText = q && q.question_text ? String(q.question_text).trim()
                : (q && q.text != null ? String(q.text).trim() : '');
    if (!qText) return false;  // 메타 부족 → graceful skip

    // content_id / question_number(콘텐츠 문항 1-based 번호) 확보 — 플레이어가 원본 콘텐츠
    //   문항(선택지 options 포함)을 복구하려면 wrong_answers.content_id + question_number 가
    //   _findContentQuestion(content_id, question_number) 와 일치해야 한다.
    //   호출 경로별로 q 가 들고 오는 필드가 달라(진단 V3 시트는 content_id/question_number 보유,
    //   submit-sheet·CAT 경로는 content_questions 일부 컬럼만 SELECT) 부족하면 q.id 로 재조회한다.
    //   ⚠ 기존 버그: q.id(content_questions.id)를 question_number 컬럼에 넣어 복구 매칭이 깨졌었다.
    //     이제는 실제 content_questions.question_number 를 저장한다(content_id 와 함께).
    let contentId = q.content_id != null ? q.content_id
                  : (q.contentId != null ? q.contentId : null);
    let questionNumber = q.question_number != null ? q.question_number
                       : (q.number != null ? q.number : null);
    const rowId = q.id != null ? q.id
                : (q.question_id != null ? q.question_id
                : (q.questionId != null ? q.questionId : null));
    // content_id 또는 question_number 가 비어 있으면 content_questions.id 로 원본 메타 재조회
    if ((contentId == null || questionNumber == null) && rowId != null) {
      const cq = db.prepare(
        'SELECT content_id, question_number FROM content_questions WHERE id = ?'
      ).get(rowId);
      if (cq) {
        if (contentId == null) contentId = cq.content_id != null ? cq.content_id : null;
        if (questionNumber == null) questionNumber = cq.question_number != null ? cq.question_number : null;
      }
    }

    // 노드 메타에서 과목·단원 보강
    let subject = null, unitName = null;
    if (nodeId) {
      const meta = db.prepare(
        'SELECT subject, unit_name, lesson_name FROM learning_map_nodes WHERE node_id = ?'
      ).get(nodeId);
      if (meta) { subject = meta.subject || null; unitName = meta.unit_name || meta.lesson_name || null; }
    }
    // content 메타로 보강 (노드 매핑이 비어 있어도 과목/단원 표기 확보 — 자기주도 경로와 일관)
    if ((!subject || !unitName) && contentId != null) {
      const c = db.prepare('SELECT subject, title FROM contents WHERE id = ?').get(contentId);
      if (c) { subject = subject || c.subject || null; unitName = unitName || c.title || null; }
    }

    // 중복방지: 미해결(is_resolved=0) 진단 오답이 이미 있으면 재등록 대신 attempt_count++.
    //   실제 question_number 는 콘텐츠마다 1,2,3.. 로 중복될 수 있으므로 content_id 를 dedup 키에 포함한다.
    //   content_id 가 없는(레거시·복구불가) 경우만 question_number(=과거 row id 호환) 단독 폴백.
    if (contentId != null && questionNumber != null) {
      const dup = db.prepare(`
        SELECT id FROM wrong_answers
        WHERE student_id = ? AND source = 'diagnosis' AND content_id = ? AND question_number = ? AND is_resolved = 0
        ORDER BY id DESC LIMIT 1
      `).get(userId, contentId, questionNumber);
      if (dup) {
        db.prepare('UPDATE wrong_answers SET attempt_count = COALESCE(attempt_count,1) + 1 WHERE id = ?').run(dup.id);
        return false;  // 신규 아님
      }
    } else if (rowId != null) {
      // content_id 확보 실패(원본 매핑 없음) — 과거 호환: row id 를 식별자로 한 dedup
      const dup = db.prepare(`
        SELECT id FROM wrong_answers
        WHERE student_id = ? AND source = 'diagnosis' AND content_id IS NULL AND question_number = ? AND is_resolved = 0
        ORDER BY id DESC LIMIT 1
      `).get(userId, rowId);
      if (dup) {
        db.prepare('UPDATE wrong_answers SET attempt_count = COALESCE(attempt_count,1) + 1 WHERE id = ?').run(dup.id);
        return false;
      }
    }

    // 저장값: content_id 가 있으면 (content_id, 실제 question_number) 로 → 플레이어 복구 가능.
    //   없으면 과거 호환으로 question_number 칸에 row id 를 남기고 content_id 는 NULL(단답 폴백).
    const storeContentId = contentId != null ? contentId : null;
    const storeQuestionNumber = contentId != null ? questionNumber : rowId;

    db.prepare(`
      INSERT INTO wrong_answers
        (student_id, exam_id, content_id, question_number, question_text, student_answer, correct_answer,
         explanation, subject, unit_name, is_resolved, attempt_count, is_manual, source)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 'diagnosis')
    `).run(
      userId, storeContentId, storeQuestionNumber,
      qText,
      studentAnswer != null ? String(studentAnswer) : null,
      q.answer != null ? String(q.answer) : null,
      q.explanation || null,
      subject, unitName
    );
    return true;
  } catch (e) {
    // 등록 실패는 진단 채점을 막지 않는다(graceful).
    return false;
  }
}

// content_id(+question_number)로 원본 콘텐츠 문항을 표준 형태로 조회한다(자기주도 오답 복구·등록 공용).
//   question_number 가 명시되면 그 문항, 없으면 첫 문항을 반환.
//   반환: { id, question_number, type, text, instruction, passage, options[], points, answer(raw), explanation } | null
function _findContentQuestion(contentId, questionNumber) {
  if (contentId == null) return null;
  let row = null;
  const qn = Number(questionNumber);
  if (Number.isFinite(qn) && questionNumber != null) {
    row = db.prepare(
      'SELECT * FROM content_questions WHERE content_id = ? AND question_number = ? ORDER BY id ASC LIMIT 1'
    ).get(contentId, qn);
  }
  if (!row) {
    row = db.prepare(
      'SELECT * FROM content_questions WHERE content_id = ? ORDER BY question_number ASC, id ASC LIMIT 1'
    ).get(contentId);
  }
  if (!row) return null;
  // exams 원본 정규화기와 동일 키로 매핑(question_text→text, question_type→type 등)
  const norm = _normalizeOriginalQuestion({
    text: row.question_text,
    type: row.question_type,
    options: row.options,
    answer: row.answer,
    explanation: row.explanation,
    instruction: row.instruction,
    passage: row.passage,
    points: row.points
  });
  if (!norm) return null;
  return { id: row.id, question_number: row.question_number, ...norm };
}

// 자기주도 학습(AI맞춤·공개콘텐츠·오늘의학습) 오답 1건을 오답노트(wrong_answers)에 자동 등록.
//   진단 헬퍼(_registerDiagnosisWrongNote)와 동형. 오답일 때만 호출(정답은 미등록).
//   중복방지: 같은 (student_id, source, content_id, question_number) 미해결 오답이 있으면
//     attempt_count++ 후 skip(신규 INSERT 안 함). 없으면 새로 INSERT.
//   문항 메타(질문/정답/선택지)는 우선 인자(question)로, 부족하면 content_id+question_number로 원본 조회해 보강.
//   subject/unit_name 은 node(있으면)→content 순으로 보강.
//   등록 실패가 본 학습 흐름(채점)을 막지 않도록 try/catch graceful.
// 반환: 새로 INSERT 했으면 true, (중복으로) attempt_count만 증가/스킵했으면 false.
function _registerSelfLearnWrongNote(userId, { source, contentId, nodeId, question, studentAnswer } = {}) {
  try {
    if (userId == null || contentId == null) return false;
    const src = source || (nodeId ? 'ai_learning' : 'content');

    // 1) 원본 문항 확보 — 인자 question 우선, 부족하면 content_questions 재조회.
    let q = question || null;
    const qNumberHint = q && q.question_number != null ? q.question_number
                       : (q && q.number != null ? q.number : null);
    if (!q || q.text == null || (q.options == null && q.answer == null)) {
      const fromDb = _findContentQuestion(contentId, qNumberHint);
      if (fromDb) q = { ...fromDb, ...(q || {}) };  // 인자가 채운 값 우선, 빈 곳만 DB로 보강
    }
    if (!q) return false;

    const qText = q.text != null ? String(q.text).trim()
                : (q.question_text != null ? String(q.question_text).trim() : '');
    if (!qText) return false;  // 메타 부족 → graceful skip

    // 중복방지/복구 키: question_number (content_questions 식별). 없으면 원본 조회로 확정 시도.
    let qNumber = q.question_number != null ? q.question_number
                : (q.number != null ? q.number : qNumberHint);
    if (qNumber == null) {
      const fromDb = _findContentQuestion(contentId, null);
      if (fromDb) qNumber = fromDb.question_number;
    }

    // 정답·해설·선택지 raw (저장은 원본 그대로 — 플레이어 채점이 정규화 비교)
    const correctAnswerRaw = q.answer != null ? String(q.answer)
                           : (q.correct_answer != null ? String(q.correct_answer) : null);
    const explanation = q.explanation != null ? String(q.explanation) : null;

    // subject/unit_name 보강: node(우선) → content
    let subject = null, unitName = null;
    if (nodeId) {
      const meta = db.prepare(
        'SELECT subject, unit_name, lesson_name FROM learning_map_nodes WHERE node_id = ?'
      ).get(nodeId);
      if (meta) { subject = meta.subject || null; unitName = meta.unit_name || meta.lesson_name || null; }
    }
    if (!subject || !unitName) {
      const c = db.prepare('SELECT subject, title FROM contents WHERE id = ?').get(contentId);
      if (c) { subject = subject || c.subject || null; unitName = unitName || c.title || null; }
    }

    // 중복방지: 미해결(is_resolved=0) 동일 출처·콘텐츠·문항 오답이 있으면 attempt_count++ 후 skip
    const dup = db.prepare(`
      SELECT id FROM wrong_answers
      WHERE student_id = ? AND source = ? AND content_id = ?
        AND ((question_number IS NULL AND ? IS NULL) OR question_number = ?)
        AND is_resolved = 0
      ORDER BY id DESC LIMIT 1
    `).get(userId, src, contentId, qNumber, qNumber);
    if (dup) {
      db.prepare('UPDATE wrong_answers SET attempt_count = COALESCE(attempt_count,1) + 1 WHERE id = ?').run(dup.id);
      return false;  // 신규 아님
    }

    db.prepare(`
      INSERT INTO wrong_answers
        (student_id, exam_id, content_id, question_number, question_text, student_answer, correct_answer,
         explanation, subject, unit_name, is_resolved, attempt_count, is_manual, source)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?)
    `).run(
      userId, contentId, qNumber,
      qText,
      studentAnswer != null ? String(studentAnswer) : null,
      correctAnswerRaw,
      explanation,
      subject, unitName,
      src
    );
    return true;
  } catch (e) {
    // 등록 실패는 본 학습 채점 흐름을 막지 않는다(graceful).
    return false;
  }
}

// ============================================================
// 진단 단원완료 공통 후처리 — 1·2·3차 로직 단일 구현 (감리 H-1)
// ============================================================
// 한 단원의 진단(시트)이 끝난 직후 호출하여 양방향 적응·종료조건·시작점·진행메타·
// 세션갱신·결과 enrichment·오답노트 누적을 일괄 수행한다.
// submitDiagnosisSheet(시트 일괄)·submitDiagnosisAnswerCAT(문항 단건, 실경로) 양쪽이 공유한다.
//
// 입력 ctx:
//   sessionId, session(DB row), curNode, nodePassed, correctRate,
//   nodePath(현재 단원 push 완료), queue(curNode 제거 완료),
//   perNodeAnswers(현재 단원 누적 완료), wrongNotesAdded(이번 호출 신규 등록 건수)
// 반환: 두 경로가 각자 응답을 조립할 수 있는 통합 결과 객체
function _finalizeDiagNodeOutcome(ctx) {
  const {
    sessionId, session, curNode,
    nodePassed, correctRate,
    nodePath, perNodeAnswers,
    wrongNotesAdded = 0
  } = ctx;
  let queue = Array.isArray(ctx.queue) ? ctx.queue : [];

  let nextNodeId = null;
  let nextSheet = [];
  let sessionComplete = false;
  let endReason = null;
  let recommendActions = null;
  let drillDownPrereqCount = 0;
  let nextAction = null;
  let recommendedStartNodeId = null;   // 확정 학습 시작점 (권고서 §5-A)
  let adaptiveDirection = null;        // 'forward' | 'backward' | null(전환종료)

  // ── 양방향 적응 (권고서 §4-3·§8) ──
  const visited = new Set(nodePath.map(p => p && p.node).filter(Boolean));
  const prevEntry = nodePath.length >= 2 ? nodePath[nodePath.length - 2] : null;
  const prevPassed = prevEntry ? !!prevEntry.passed : null;
  const transition = (prevPassed !== null) && (prevPassed !== nodePassed);

  if (transition) {
    // 위치 확정 — 통과↔실패 경계 발견 → 조기 종료. 보수적으로 더 쉬운(낮은) 쪽이 시작점.
    if (nodePassed) {
      recommendedStartNodeId = prevEntry.node;   // 실패(상위)→통과(하위): 상위 단원이 시작점
    } else {
      recommendedStartNodeId = curNode;          // 통과(하위)→실패(상위): 방금 실패한 현재 단원
    }
    sessionComplete = true;
    endReason = 'position_found';
    nextAction = { type: 'complete' };
  } else if (nodePassed) {
    // 전진(상위/후속 단원으로 도전)
    const fwd = _pickForwardUnit(curNode, visited);
    if (fwd) {
      nextNodeId = fwd.nodeId;
      nextSheet = fwd.sheet;
      adaptiveDirection = 'forward';
      queue = [fwd.nodeId, ...queue.filter(qn => qn !== fwd.nodeId)];
      nextAction = { type: 'auto_next', direction: 'forward' };
    } else {
      recommendedStartNodeId = curNode;          // 천장 도달 — 더 올라갈 후속 없음
      sessionComplete = true;
      endReason = 'ceiling_reached';
      nextAction = { type: 'complete' };
    }
  } else {
    // 후퇴(선수/하위 단원으로 내려감)
    const bwd = _pickBackwardUnit(curNode, visited);
    drillDownPrereqCount = db.prepare(
      'SELECT COUNT(1) AS cnt FROM learning_map_edges WHERE to_node_id = ?'
    ).get(curNode)?.cnt || 0;
    if (bwd) {
      nextNodeId = bwd.nodeId;
      nextSheet = bwd.sheet;
      adaptiveDirection = 'backward';
      queue = [bwd.nodeId, ...queue.filter(qn => qn !== bwd.nodeId)];
      nextAction = { type: 'auto_next', direction: 'backward' };
      recommendActions = [
        { id: 'retry',      label: '다시 진단하기' },
        { id: 'drill_down', label: '더 아래 단원 진단하기', prereqCount: drillDownPrereqCount, disabled: drillDownPrereqCount === 0 },
        { id: 'learn_here', label: '바로 학습하기' }
      ];
    } else {
      recommendedStartNodeId = curNode;          // 최하위 — 더 내려갈 선수 없음
      sessionComplete = true;
      endReason = 'floor_reached';
      nextAction = { type: 'complete' };
    }
  }

  // ── 종료 조건 B: 단원 수 상한 (권고서 §5) ──
  const diagnosedUnits = nodePath.filter(p => p && p.node).length;
  const elapsedSec = _diagElapsedSec(session);
  if (!sessionComplete && diagnosedUnits >= DIAG_UNIT_CAP) {
    sessionComplete = true;
    endReason = 'unit_cap';
    nextAction = { type: 'complete' };
    nextNodeId = null;
    nextSheet = [];
    recommendActions = null;
    adaptiveDirection = null;
  }

  // ── 학습 시작점 fallback (position_found/ceiling/floor 외 종료 경로) ──
  // M-1: all-fail(동률) 시 절대학년 오름차순(가장 쉬운 실패 단원)으로 타이브레이크.
  if (sessionComplete && !recommendedStartNodeId && nodePath.length > 0) {
    const failedEntries = nodePath.filter(p => p && !p.passed);
    if (failedEntries.length > 0) {
      const metaById = new Map(
        _fetchNodeMetaMany(failedEntries.map(p => p.node)).map(m => [m.node_id, m])
      );
      failedEntries.sort((a, b) => {
        const ra = a.rate || 0, rb = b.rate || 0;
        if (ra !== rb) return ra - rb;                       // 1차: 정답률 오름차순
        const ma = metaById.get(a.node) || {}, mb = metaById.get(b.node) || {};
        const ga = _gradeAbs(ma.grade_level, ma.grade, ma.semester);
        const gb = _gradeAbs(mb.grade_level, mb.grade, mb.semester);
        if (ga !== gb) return ga - gb;                       // 2차: 절대학년(더 쉬운 단원) — M-1
        if ((ma.sort_order || 0) !== (mb.sort_order || 0)) return (ma.sort_order || 0) - (mb.sort_order || 0);
        return String(a.node).localeCompare(String(b.node));
      });
      recommendedStartNodeId = failedEntries[0].node;
    } else {
      recommendedStartNodeId = nodePath[nodePath.length - 1].node;
    }
  }

  // ── 종료 조건 C: 누적 시간 소프트(강제 아님) ──
  let softStop = false;
  if (!sessionComplete && elapsedSec >= DIAG_SOFT_TIME_SEC) {
    softStop = true;
    const prevAction = nextAction;
    nextAction = {
      type: 'soft_stop',
      elapsedSec,
      softTimeLimitSec: DIAG_SOFT_TIME_SEC,
      diagnosedUnits,
      continueAction: prevAction
    };
  }

  // 진행 메타 (FE 헤더 표시용)
  const progress = {
    diagnosedUnits,
    elapsedSec,
    unitCap: DIAG_UNIT_CAP,
    softTimeLimitSec: DIAG_SOFT_TIME_SEC
  };

  // 세션 갱신 (진단 오답노트 누적 diag_wrong_added 가산)
  db.prepare(`
    UPDATE diagnosis_sessions SET
      queue_nodes = ?, current_node_id = ?, current_difficulty = 'medium',
      difficulty_path = ?, per_node_answers = ?,
      diag_wrong_added = COALESCE(diag_wrong_added, 0) + ?,
      status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).run(
    JSON.stringify(queue),
    nextNodeId || curNode,
    JSON.stringify(nodePath),
    JSON.stringify(perNodeAnswers),
    wrongNotesAdded,
    sessionComplete ? 1 : 0,
    sessionComplete ? 1 : 0,
    sessionId
  );
  const wrongNotesAddedTotal = db.prepare(
    'SELECT COALESCE(diag_wrong_added, 0) AS n FROM diagnosis_sessions WHERE id = ?'
  ).get(sessionId)?.n || 0;

  // 세션 완료 시 결과 enrichment + 미통과 노드 학습목록 자동 추가
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

  // hydration
  const queueRemainingHydrated = _hydrateDiagNodes(queue);
  const nextNodeHydrated = nextNodeId ? (_hydrateDiagNodes([nextNodeId])[0] || { id: nextNodeId }) : null;
  const recommendedStartNode = recommendedStartNodeId
    ? (_hydrateDiagNodes([recommendedStartNodeId])[0] || { id: recommendedStartNodeId })
    : null;

  return {
    queue, nextNodeId, nextSheet,
    sessionComplete, endReason,
    recommendActions, nextAction, adaptiveDirection,
    recommendedStartNodeId, recommendedStartNode,
    progress, softStop,
    nodeResults, summary, areaStats, recommendNodes, targetNode, addedToLearningList,
    nextNodeHydrated, queueRemainingHydrated,
    wrongNotesAdded, wrongNotesAddedTotal
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
  let wrongNotesAdded = 0;   // 이번 submit 호출에서 오답노트에 새로 담은 문항 수 (권고서 §7-2)

  for (const a of answers) {
    const questionId = a.questionId != null ? a.questionId : a.question_id;
    if (!questionId) continue;
    // content_id·question_number 도 함께 조회 → 오답노트 등록 시 원본 콘텐츠 문항 복구(객관식 options) 가능
    const q = db.prepare('SELECT id, content_id, question_number, answer, options, question_text, explanation FROM content_questions WHERE id = ?').get(questionId);
    if (!q) {
      results.push({ questionId, lessonId: a.lessonId || null, isCorrect: false, skipped: true, reason: 'question_not_found' });
      continue;
    }
    const isCorrect = judgeQuestionAnswer(q, a.userAnswer != null ? a.userAnswer : a.answer, a.answerIndex != null ? a.answerIndex : a.answer_index);
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
    // 진단 오답 → 오답노트 자동 등록 (권고서 §7-2). 틀린 문항만, 차시 노드 기준 과목·단원 보강.
    if (!isCorrect) {
      const added = _registerDiagnosisWrongNote(
        session.user_id, recordNodeId, q,
        a.userAnswer != null ? a.userAnswer : a.answer
      );
      if (added) wrongNotesAdded += 1;
    }
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

  // user_node_status — 진단 결과만 기록 (status는 절대 갱신하지 않음)
  // [2026-06-05 진단↔학습 분리] 진단은 노드 학습 status(완료/진행중)를 바꾸지 않는다.
  //   diagnosis_result·correct_rate만 보존하고 status는 기존값 유지(없으면 not_started).
  //   노드 status는 실제 학습(영상·문제·차시 완료)으로만 산출(evaluateNodeCompletion 등).
  const diagResult = nodePassed
    ? (correctRate >= 0.80 ? 'mastered' : 'proficient')
    : (correctRate >= 0.40 ? 'developing' : 'needs_review');
  db.prepare(`
    INSERT INTO user_node_status (user_id, node_id, status, diagnosis_result, correct_rate, last_accessed_at)
    VALUES (?, ?, 'not_started', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, node_id) DO UPDATE SET
      diagnosis_result = excluded.diagnosis_result,
      correct_rate = excluded.correct_rate,
      last_accessed_at = CURRENT_TIMESTAMP
  `).run(session.user_id, curNode, diagResult, correctRate);

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

  // 단원완료 공통 후처리 — 양방향·종료조건·시작점·진행메타·세션갱신·enrichment·오답노트 누적
  const fin = _finalizeDiagNodeOutcome({
    sessionId, session, curNode,
    nodePassed, correctRate,
    nodePath, queue, perNodeAnswers,
    wrongNotesAdded
  });

  return {
    nodeFinished: true,
    nodePassed,
    correctRate,
    results,
    nextAction: fin.nextAction,
    recommendActions: fin.recommendActions,
    // 다음 진행
    nextNodeId: fin.nextNodeId,
    nextNode: fin.nextNodeHydrated,
    sheet: fin.nextSheet,             // 자동 진행 시 다음 단원 진단지
    sheetSize: fin.nextSheet.length,
    queueRemaining: fin.queue.length,
    queueRemainingHydrated: fin.queueRemainingHydrated,
    queueNodesHydrated: fin.queueRemainingHydrated, // alias (호환)
    queueOrderHydrated: fin.queueRemainingHydrated, // alias
    // 진단 2차 — 양방향 적응 (권고서 §4-3·§8)
    adaptiveDirection: fin.adaptiveDirection,       // 'forward' | 'backward' | null
    recommendedStartNodeId: fin.recommendedStartNodeId,
    recommendedStartNode: fin.recommendedStartNode,
    // 종료 시
    sessionComplete: fin.sessionComplete,
    finished: fin.sessionComplete,
    endReason: fin.endReason,
    // 진단 1차 — 진행 메타 + 소프트 종료 신호 (권고서 §5·§C)
    progress: fin.progress,
    softStop: fin.softStop,
    nodeResults: fin.nodeResults,
    summary: fin.summary,
    areaStats: fin.areaStats,
    recommendNodes: fin.recommendNodes,
    targetNode: fin.targetNode,
    addedToLearningList: fin.addedToLearningList,
    // 진단 3차 — 진단 오답 → 오답노트 자동 등록 (권고서 §7-2)
    wrongNotesAdded: fin.wrongNotesAdded,
    wrongNotesAddedTotal: fin.wrongNotesAddedTotal
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
    targetNodeId: s.target_node_id,
    // 진단 1차 — 진행 메타 (권고서 §5·§C). diagnosedUnits = 시트 제출 완료 단원 수
    progress: _buildDiagProgress(s)
  };
}

// ============================================================
// 진단검사 v3 — 개념(차시) 단위 순차 진단 엔진 (기획서 진단검사_v3_기획서.md)
// ============================================================
// v2(단원 단위 양방향)와 별개의 신규 함수군. v2 함수는 그대로 보존(노드클릭 진단 등 호환).
// 핵심 원칙:
//   - 진단 입자 = 개념(node_level=3). 단원(node_level=2)을 학생이 고르면 그 단원 첫 개념부터.
//   - 개념 선후 = learning_map_edges.edge_type='prerequisite' (정방향=후속, 역방향=선수). 단원 경계 가로지름.
//   - 문항 = content_questions.difficulty(정수 1~5) 기준 (v2 contents.difficulty 문자열 매칭과 다름).
//   - 2-strike: 1차 오답 → 같은 개념·같은 난이도 "다른 문항"(이미 출제 제외) 1회 더 → 2차 오답 → 하향.
//   - 정답 비노출: 출제 시 answer/explanation 미포함. 채점은 서버.
// 세션 상태(diagnosis_sessions.difficulty_path)에 v3 진행 상태(JSON)를 저장한다:
//   { v3:true, unit:{...}, conceptOrder:[...], passedConcepts:[...], skippedConcepts:[...],
//     visitedConcepts:[...], currentConcept, currentDifficulty, strike, askedQuestionIds:[...],
//     completedUnits:[...], diagnosedConcepts, history:[...] }

// node_level=2 단원의 정렬된 개념(차시) 목록 — prerequisite 체인 우선, 폴백 sort_order.
//   반환: [{ nodeId, name, sortOrder }] (단원 소속 개념만, 진입엣지 없는 것이 첫 개념)
function _v3ConceptsOfUnit(unitNodeId) {
  const concepts = db.prepare(`
    SELECT node_id, lesson_name, sort_order
    FROM learning_map_nodes
    WHERE parent_node_id = ? AND node_level = 3
    ORDER BY sort_order ASC
  `).all(unitNodeId);
  if (!concepts || concepts.length === 0) return [];

  const idSet = new Set(concepts.map(c => c.node_id));
  // prerequisite 그래프(단원 내부 한정)로 위상 정렬 시도
  const nextMap = new Map();   // from → [to] (단원 내부)
  const indeg = new Map();
  concepts.forEach(c => { nextMap.set(c.node_id, []); indeg.set(c.node_id, 0); });
  const edges = db.prepare(`
    SELECT from_node_id, to_node_id FROM learning_map_edges WHERE edge_type='prerequisite'
  `).all();
  for (const e of edges) {
    if (idSet.has(e.from_node_id) && idSet.has(e.to_node_id)) {
      nextMap.get(e.from_node_id).push(e.to_node_id);
      indeg.set(e.to_node_id, (indeg.get(e.to_node_id) || 0) + 1);
    }
  }
  // 위상 정렬 (indeg=0 시작, 동순위는 sort_order)
  const byId = new Map(concepts.map(c => [c.node_id, c]));
  const ready = concepts.filter(c => (indeg.get(c.node_id) || 0) === 0)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(c => c.node_id);
  const order = [];
  const localIndeg = new Map(indeg);
  const inReady = new Set(ready);
  while (ready.length > 0) {
    // 항상 sort_order 가장 작은 ready 선택 (안정적 순서)
    ready.sort((a, b) => (byId.get(a).sort_order || 0) - (byId.get(b).sort_order || 0));
    const cur = ready.shift();
    order.push(cur);
    for (const nx of (nextMap.get(cur) || [])) {
      localIndeg.set(nx, (localIndeg.get(nx) || 0) - 1);
      if ((localIndeg.get(nx) || 0) === 0 && !inReady.has(nx) && !order.includes(nx)) {
        ready.push(nx); inReady.add(nx);
      }
    }
  }
  // 사이클 등으로 누락된 개념은 sort_order로 뒤에 보충
  if (order.length < concepts.length) {
    for (const c of concepts) if (!order.includes(c.node_id)) order.push(c.node_id);
  }
  return order.map(id => {
    const c = byId.get(id);
    return { nodeId: id, name: c.lesson_name || '개념', sortOrder: c.sort_order || 0 };
  });
}

// 개념 1개를 v3 표준 형태로 hydrate (단원/이름)
function _v3HydrateConcept(conceptNodeId, conceptOrder) {
  const n = db.prepare('SELECT node_id, lesson_name, unit_name, parent_node_id, grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ?').get(conceptNodeId);
  let index = null, total = null;
  if (Array.isArray(conceptOrder) && conceptOrder.length) {
    const i = conceptOrder.indexOf(conceptNodeId);
    if (i >= 0) { index = i + 1; total = conceptOrder.length; }
  }
  // 개념(차시)에 grade/semester가 비어 있으면 부모 단원의 값으로 보강(하향 분기 시 타 학년 안내용)
  let gradeLevel = n ? (n.grade_level || null) : null;
  let grade = n && n.grade != null ? n.grade : null;
  let semester = n && n.semester != null ? n.semester : null;
  // unitName: 학습맵 단원명(부모 단원의 unit_name)을 기본으로, 없으면 개념 노드 자신의 unit_name 폴백.
  //   → 하향(선수 개념) 안내 시 "단원명 · 개념명"으로 학습맵과 동일 문자열 노출.
  let unitName = n ? (n.unit_name || null) : null;
  if (n && (grade == null || gradeLevel == null || unitName == null) && n.parent_node_id) {
    try {
      const p = db.prepare('SELECT grade_level, grade, semester, unit_name FROM learning_map_nodes WHERE node_id = ?').get(n.parent_node_id);
      if (p) {
        if (gradeLevel == null) gradeLevel = p.grade_level || null;
        if (grade == null) grade = p.grade != null ? p.grade : null;
        if (semester == null) semester = p.semester != null ? p.semester : null;
        if (p.unit_name) unitName = p.unit_name;  // 부모 단원명 우선(학습맵 표기와 동일)
      }
    } catch (_) {}
  }
  return {
    nodeId: conceptNodeId,
    name: n ? (n.lesson_name || n.unit_name || '개념') : '개념',
    unitName,
    gradeLevel, grade, semester,
    index, total
  };
}

// 개념 1개의 난이도 D 문항 1개 선택 (정답 비노출 형태) — content_questions.difficulty(1~5) 기준.
//   excludeQ: 이미 출제한 questionId 배열(제외). 같은 문항 재출제 절대 금지.
//   §9-A 폴백: 같은 난이도 → ±1 난이도 → (없으면 null 반환, 호출자가 하향 처리).
//   반환(공개): { questionId, contentId, type, text, instruction, passage, options[], difficulty } (answer 없음)
//   내부 채점용 raw는 별도 조회.
function _v3PickQuestion(conceptNodeId, difficulty, excludeQ = []) {
  const ex = new Set((excludeQ || []).map(Number).filter(Number.isFinite));
  // 개념에 매핑된 모든 문항 (content_questions.difficulty 포함)
  const all = db.prepare(`
    SELECT cq.id AS question_id, cq.content_id, cq.question_type, cq.question_text,
           cq.options, cq.instruction, cq.passage, cq.points, cq.difficulty
    FROM node_contents nc
    JOIN content_questions cq ON cq.content_id = nc.content_id
    WHERE nc.node_id = ?
  `).all(conceptNodeId);
  if (!all || all.length === 0) return null;

  const avail = all.filter(q => !ex.has(Number(q.question_id)));
  if (avail.length === 0) return null;  // 모든 문항 소진(같은 문항 재출제 금지)

  const D = Number(difficulty) || 3;
  // 우선순위: 같은 난이도 → ±1 → 그 외 (가까운 난이도 순)
  const pickFrom = (pred) => {
    const pool = avail.filter(pred);
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  let chosen = pickFrom(q => Number(q.difficulty) === D);
  if (!chosen) chosen = pickFrom(q => Math.abs(Number(q.difficulty) - D) === 1);
  if (!chosen) {
    // 가장 가까운 난이도 순으로 정렬해 첫 풀
    avail.sort((a, b) => Math.abs(Number(a.difficulty) - D) - Math.abs(Number(b.difficulty) - D));
    chosen = avail[0];
  }
  if (!chosen) return null;

  const norm = _normalizeOriginalQuestion({
    text: chosen.question_text, type: chosen.question_type, options: chosen.options,
    answer: null, explanation: null, instruction: chosen.instruction,
    passage: chosen.passage, points: chosen.points
  });
  if (!norm) return null;
  return {
    questionId: chosen.question_id,
    contentId: chosen.content_id,
    nodeId: conceptNodeId,
    type: norm.type,
    text: norm.text,
    instruction: norm.instruction,
    passage: norm.passage,
    options: norm.options || [],
    points: norm.points,
    difficulty: Number(chosen.difficulty) || D
    // answer / explanation 미포함 (정답 비노출)
  };
}

// 개념이 보유한 문항 난이도 중 진단 시작 난이도 결정 — 중간값(3) 우선, 없으면 보유 난이도 중 3에 가장 가까운 값.
function _v3StartDifficulty(conceptNodeId) {
  const diffs = db.prepare(`
    SELECT DISTINCT cq.difficulty AS d
    FROM node_contents nc JOIN content_questions cq ON cq.content_id = nc.content_id
    WHERE nc.node_id = ?
  `).all(conceptNodeId).map(r => Number(r.d)).filter(Number.isFinite);
  if (diffs.length === 0) return 3;
  if (diffs.includes(3)) return 3;
  diffs.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3));
  return diffs[0];
}

// 개념의 후속 개념(정방향 prerequisite). 같은 단원 우선 — 호출자가 단원 완료 판정에 사용.
function _v3ForwardConcepts(conceptNodeId) {
  return db.prepare(`
    SELECT e.to_node_id AS id
    FROM learning_map_edges e
    WHERE e.from_node_id = ? AND e.edge_type='prerequisite'
  `).all(conceptNodeId).map(r => r.id);
}

// 개념의 선수 개념(역방향 prerequisite). 단원 경계 가로지름 허용.
function _v3BackwardConcepts(conceptNodeId) {
  return db.prepare(`
    SELECT e.from_node_id AS id
    FROM learning_map_edges e
    WHERE e.to_node_id = ? AND e.edge_type='prerequisite'
  `).all(conceptNodeId).map(r => r.id);
}

// 단원의 후속 단원 목록 — 단원의 (마지막) 개념들의 정방향 prerequisite가 가리키는 개념의 부모 단원.
//   폴백: 없으면 unit_prerequisite(level2→level2) 정방향.
//   반환: [{ nodeId, name, conceptTotal }]
function _v3NextUnits(unitNodeId) {
  const concepts = _v3ConceptsOfUnit(unitNodeId);
  const conceptIds = new Set(concepts.map(c => c.nodeId));
  const nextUnitIds = new Set();
  // 개념 정방향 엣지가 단원 밖 개념을 가리키면 그 부모 단원이 후속 단원
  for (const c of concepts) {
    const fwds = _v3ForwardConcepts(c.nodeId);
    for (const f of fwds) {
      if (conceptIds.has(f)) continue;  // 단원 내부 후속은 제외
      const parent = db.prepare('SELECT parent_node_id FROM learning_map_nodes WHERE node_id = ? AND node_level=3').get(f);
      if (parent && parent.parent_node_id && parent.parent_node_id !== unitNodeId) {
        nextUnitIds.add(parent.parent_node_id);
      }
    }
  }
  // 폴백: unit_prerequisite
  if (nextUnitIds.size === 0) {
    const us = db.prepare(`
      SELECT to_node_id AS id FROM learning_map_edges WHERE from_node_id = ? AND edge_type='unit_prerequisite'
    `).all(unitNodeId).map(r => r.id);
    us.forEach(id => nextUnitIds.add(id));
  }
  const out = [];
  for (const uid of nextUnitIds) {
    const u = db.prepare('SELECT node_id, unit_name, grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ? AND node_level=2').get(uid);
    if (!u) continue;
    out.push({
      nodeId: u.node_id, name: u.unit_name || '단원',
      gradeLevel: u.grade_level || null, grade: u.grade != null ? u.grade : null, semester: u.semester != null ? u.semester : null,
      conceptTotal: _v3ConceptsOfUnit(u.node_id).length
    });
  }
  return out;
}

// v3 세션 상태 로드/저장 (difficulty_path 컬럼 재사용)
function _v3LoadState(session) {
  let st = null;
  try { st = JSON.parse(session.difficulty_path || 'null'); } catch { st = null; }
  if (!st || !st.v3) return null;
  // [다갈래 선수큐] 하위호환 — 구 세션엔 세 필드 부재. load 시 1회 정규화(설계서 §3·R7).
  if (st.prereqQueue == null) st.prereqQueue = [];
  if (st.downCount == null) st.downCount = 0;
  if (st.branchDepth == null) st.branchDepth = 0;
  // [선수 표본 과반] 하위호환 — 구 세션은 표본 미적용으로 안전 합류(설계서 §3·R6).
  if (st.branchSample === undefined) st.branchSample = null;
  if (st.branchVerdicts == null || typeof st.branchVerdicts !== 'object') st.branchVerdicts = {};
  // [라운드방식 2026-06-11] 하위호환 — 구 세션(끼어들기·우선순위큐)엔 두 필드 부재.
  //   prereqRound=1(=현재 라운드), nextRoundQueue=[](다음 라운드 적립큐). 구 세션은 nextRoundQueue가 항상 비어
  //   라운드 전환이 발생하지 않으므로 기존 동작 그대로(prereqQueue 소진=하향종료/본류복귀)와 동치.
  if (st.prereqRound == null) st.prereqRound = 1;
  if (st.nextRoundQueue == null || !Array.isArray(st.nextRoundQueue)) st.nextRoundQueue = [];
  // [단계표기 2026-06-11] 하위호환 — 구 세션엔 unitRound 부재. {}로 정규화(diagPlan round 폴백=1).
  if (st.unitRound == null || typeof st.unitRound !== 'object') st.unitRound = {};
  return st;
}
function _v3SaveState(sessionId, st, extra = {}) {
  const fields = ['difficulty_path = ?'];
  const params = [JSON.stringify(st)];
  if (extra.currentNodeId !== undefined) { fields.push('current_node_id = ?'); params.push(extra.currentNodeId); }
  if (extra.status !== undefined) { fields.push('status = ?'); params.push(extra.status); }
  if (extra.completed) { fields.push('completed_at = CURRENT_TIMESTAMP'); }
  if (extra.wrongAddDelta) { fields.push('diag_wrong_added = COALESCE(diag_wrong_added,0) + ?'); params.push(extra.wrongAddDelta); }
  params.push(sessionId);
  db.prepare(`UPDATE diagnosis_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

// v3 단원 진척 카운트 (passed / total, skip 제외 분모)
function _v3UnitProgress(st) {
  const total = st.conceptOrder.filter(id => !st.skippedConcepts.includes(id)).length;
  const passed = st.passedConcepts.filter(id => st.conceptOrder.includes(id)).length;
  return { passed, total };
}

// v3 사이드바 단원 패널 스코프 — start 때 영속한 스코프(최초 선택 학교급/학년)를 반환.
//   구(舊) 세션(scope 없음) 폴백: 현재 진단 단원(node_level=2)의 grade_level/grade로 추론하여 start와 동일 스코프 복원.
function _v3PanelScope(st) {
  if (st && st.scope && (st.scope.schoolLevel != null || st.scope.grade != null)) {
    return { schoolLevel: st.scope.schoolLevel, grade: st.scope.grade, area: st.scope.area != null ? st.scope.area : (st.unit && st.unit.area) || null };
  }
  // 폴백: scope 미보유 구 세션 — 현재 단원의 학년 정보로 추론
  let schoolLevel = null, grade = null;
  try {
    const uid = st && st.unit && st.unit.nodeId;
    if (uid) {
      const row = db.prepare('SELECT grade_level, grade FROM learning_map_nodes WHERE node_id = ? AND node_level=2').get(uid);
      if (row) { schoolLevel = row.grade_level || null; grade = row.grade != null ? row.grade : null; }
    }
  } catch (_) {}
  return { schoolLevel, grade, area: (st && st.scope && st.scope.area != null) ? st.scope.area : (st && st.unit && st.unit.area) || null };
}

// v3 단원 목록 조회 (드릴다운 — 학교급/학년/영역) + 사용자별 진행 상태(미진단/진행중/완료)
//   schoolLevel: '초'|'중'|'고' (또는 elementary/middle/high), grade: 정수, area: 문자열|'전체 영역'|null
function getV3Units(userId, { schoolLevel, grade, area } = {}) {
  const slMap = { elementary: '초', middle: '중', high: '고', '초': '초', '중': '중', '고': '고' };
  const gl = slMap[String(schoolLevel || '').trim()] || null;
  let where = "WHERE node_level=2 AND subject LIKE '수학%'";
  const params = [];
  if (gl) { where += ' AND grade_level = ?'; params.push(gl); }
  if (grade != null && grade !== '') { where += ' AND grade = ?'; params.push(parseInt(grade)); }
  if (area && area !== '전체 영역') { where += ' AND area = ?'; params.push(area); }
  const units = db.prepare(`
    SELECT node_id, unit_name, area, sort_order, grade_level, grade, semester
    FROM learning_map_nodes ${where}
    ORDER BY sort_order ASC
  `).all(...params);

  // 사용자의 v3 진단 세션들에서 단원별 진행 상태 집계
  // 단원 status: completed > in_progress > untested
  const result = units.map(u => {
    const concepts = _v3ConceptsOfUnit(u.node_id);
    const total = concepts.length;
    // 가장 최근 세션에서 이 단원 진행 상태 추출
    let status = 'untested', passed = 0;
    try {
      const sessions = db.prepare(`
        SELECT difficulty_path FROM diagnosis_sessions
        WHERE user_id = ? AND diagnosis_type = 'concept-v3'
        ORDER BY id DESC LIMIT 30
      `).all(userId);
      let best = null; // 0 untested,1 in_progress,2 completed
      for (const s of sessions) {
        let st = null; try { st = JSON.parse(s.difficulty_path || 'null'); } catch {}
        if (!st || !st.v3) continue;
        const completed = (st.completedUnits || []).includes(u.node_id);
        const conceptIds = new Set(concepts.map(c => c.nodeId));
        const passedHere = (st.passedConcepts || []).filter(id => conceptIds.has(id)).length;
        if (completed) {
          if ((best || 0) < 2) { best = 2; passed = total; }
        } else if (passedHere > 0 || (st.unit && st.unit.nodeId === u.node_id)) {
          // 진행 흔적 (통과 개념 있음 또는 현재/과거 진단 단원)
          const visitedHere = (st.visitedConcepts || []).filter(id => conceptIds.has(id)).length;
          if (passedHere > 0 || visitedHere > 0) {
            if ((best || 0) < 1) { best = 1; }
            if (passedHere > passed) passed = passedHere;
          }
        }
      }
      if (best === 2) status = 'completed';
      else if (best === 1) status = 'in_progress';
    } catch (_) {}
    return {
      nodeId: u.node_id, name: u.unit_name || '단원', area: u.area || null,
      gradeLevel: u.grade_level || null, grade: u.grade != null ? u.grade : null, semester: u.semester != null ? u.semester : null,
      conceptTotal: total, status, passed, sortOrder: u.sort_order || 0
    };
  });
  // 정렬: 미진단 → 진행중 → 완료, 같은 상태 내 sort_order (기획서 §3-4)
  const rank = { untested: 0, in_progress: 1, completed: 2 };
  result.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return a.sortOrder - b.sortOrder;
  });
  return result;
}

// v3 드릴다운 — 특정 학교급의 학년 목록 (수학, 단원 ≥1)
function getV3Grades(schoolLevel) {
  const slMap = { elementary: '초', middle: '중', high: '고', '초': '초', '중': '중', '고': '고' };
  const gl = slMap[String(schoolLevel || '').trim()] || null;
  let where = "WHERE node_level=2 AND subject LIKE '수학%'";
  const params = [];
  if (gl) { where += ' AND grade_level = ?'; params.push(gl); }
  return db.prepare(`SELECT DISTINCT grade FROM learning_map_nodes ${where} ORDER BY grade ASC`).all(...params).map(r => r.grade);
}

// v3 드릴다운 — 특정 학교급+학년의 영역 목록 (단원 ≥1 영역만, 기획서 §3-2)
function getV3Areas(schoolLevel, grade) {
  const slMap = { elementary: '초', middle: '중', high: '고', '초': '초', '중': '중', '고': '고' };
  const gl = slMap[String(schoolLevel || '').trim()] || null;
  let where = "WHERE node_level=2 AND subject LIKE '수학%' AND area IS NOT NULL";
  const params = [];
  if (gl) { where += ' AND grade_level = ?'; params.push(gl); }
  if (grade != null && grade !== '') { where += ' AND grade = ?'; params.push(parseInt(grade)); }
  return db.prepare(`SELECT DISTINCT area FROM learning_map_nodes ${where} ORDER BY area ASC`).all(...params).map(r => r.area);
}

// v3 진단 세션 시작 — 선택 단원의 첫 개념부터 첫 문항 출제 (정답 비노출)
function startDiagnosisV3(userId, { schoolLevel, grade, subject, area, unitNodeId } = {}) {
  if (!unitNodeId) {
    const err = new Error('unitNodeId가 필요합니다.'); err.statusCode = 400; throw err;
  }
  const unit = db.prepare('SELECT node_id, unit_name, area, grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ? AND node_level=2').get(unitNodeId);
  if (!unit) { const err = new Error('단원을 찾을 수 없습니다.'); err.statusCode = 404; throw err; }

  const conceptsArr = _v3ConceptsOfUnit(unitNodeId);
  if (conceptsArr.length === 0) { const err = new Error('이 단원에 진단할 개념이 없습니다.'); err.statusCode = 422; throw err; }
  const conceptOrder = conceptsArr.map(c => c.nodeId);

  // 첫 개념: 문항이 있는 첫 개념 (없으면 skip)
  const skipped = [];
  let firstConcept = null, firstQuestion = null, firstDiff = 3;
  for (const cid of conceptOrder) {
    const d = _v3StartDifficulty(cid);
    const q = _v3PickQuestion(cid, d, []);
    if (q) { firstConcept = cid; firstQuestion = q; firstDiff = d; break; }
    skipped.push(cid);
  }
  if (!firstConcept) { const err = new Error('이 단원의 개념에 등록된 문제가 없습니다.'); err.statusCode = 422; throw err; }

  const st = {
    v3: true,
    // 사이드바 단원 패널 스코프 — 학생이 최초로 고른 학교급/학년/영역을 영속(advance 후에도 동일 스코프 유지).
    //   하향으로 실제 진단 단원이 타 학년으로 가더라도 패널 기준은 최초 선택을 유지(report M-1 권장안).
    scope: {
      schoolLevel: (schoolLevel != null && schoolLevel !== '') ? schoolLevel : null,
      grade: (grade != null && grade !== '') ? grade : null,
      area: unit.area || area || null
    },
    unit: { nodeId: unit.node_id, name: unit.unit_name || '단원', area: unit.area || area || null, gradeLevel: unit.grade_level || null, grade: unit.grade != null ? unit.grade : null, semester: unit.semester != null ? unit.semester : null },
    conceptOrder,
    passedConcepts: [],
    skippedConcepts: skipped.slice(),
    visitedConcepts: [firstConcept],
    completedUnits: [],
    currentConcept: firstConcept,
    currentDifficulty: firstDiff,
    strike: 0,
    askedQuestionIds: [firstQuestion.questionId],
    diagnosedConcepts: 0,
    // [다갈래 선수큐] 설계서 §3 — 약점 선수를 모두 담아 근본도순으로 차례 검사
    prereqQueue: [],   // 검사 대기 선수 node_id 큐(근본도 오름차순 정렬 유지)
    downCount: 0,      // 누적 하향(선수로 내려간) 개념 수 — 하드 상한 판정용
    branchDepth: 0,    // 현재 갈래의 연속 하향 깊이 — 깊이 상한·갈래 전환 시 0 리셋
    // [선수 표본 과반] 설계서 §3 — 현재 선수 갈래(단원)의 표본 검사 진행. 본류·미진입이면 null.
    branchSample: null,
    // [선수 표본 과반] done 단원의 갈래 판정(통과/하향) 라벨용. { [unitId]: 'pass'|'down' }
    branchVerdicts: {},
    // [단계표기 2026-06-11] 단원별 진입 라운드 기록 { [unitId]: round } — FE "N단계 내려감" 그룹 표기용.
    //   갈래 진입(_v3MoveIntoPrereq) 시 첫 진입 라운드만 기록(이미 있으면 유지).
    unitRound: {},
    history: []  // [{ concept, correct, strike, questionId }]
  };

  const info = db.prepare(`
    INSERT INTO diagnosis_sessions
      (user_id, target_node_id, diagnosis_type, status, total_questions, correct_count,
       queue_nodes, current_node_id, current_difficulty, difficulty_path, per_node_answers)
    VALUES (?, ?, 'concept-v3', 'in_progress', 0, 0, ?, ?, ?, ?, '{}')
  `).run(userId, unitNodeId, JSON.stringify(conceptOrder), firstConcept, String(firstDiff), JSON.stringify(st));

  const sessionId = info.lastInsertRowid;
  const conceptHydrated = _v3HydrateConcept(firstConcept, conceptOrder);
  const prog = _v3UnitProgress(st);
  return {
    sessionId,
    unit: { nodeId: unit.node_id, name: unit.unit_name || '단원', area: unit.area || null, gradeLevel: unit.grade_level || null, grade: unit.grade != null ? unit.grade : null, semester: unit.semester != null ? unit.semester : null, conceptTotal: conceptOrder.length },
    concept: conceptHydrated,
    question: firstQuestion,
    unitList: getV3Units(userId, { schoolLevel, grade, area: st.unit.area }),
    progress: {
      diagnosedConcepts: 0, elapsedSec: 0,
      conceptCap: DIAG_V3_CONCEPT_CAP, softTimeLimitSec: DIAG_SOFT_TIME_SEC,
      unitPassed: prog.passed, unitTotal: prog.total,
      diagPlan: []   // 시작 시엔 항상 단갈래(큐 없음) → 빈 배열(패널 숨김)
    }
  };
}

// v3 종료 상수
const DIAG_V3_CONCEPT_CAP = 30;   // 누적 진단 개념 소프트 상한
// [루프 안전망] FE 가 down/unit-complete 분기 처리에 실패해 같은 문항을 반복 제출하거나
//   하향이 비정상적으로 길어져도 진단이 절대 무한히 이어지지 않도록 하는 하드 상한.
//   - 어떤 클라이언트 동작에서도 누적 출제 문항 수가 이 값을 넘으면 즉시 종료(finished:true).
//   - 정상 경로(통과/하향/완주)는 위 소프트 상한·downCount(20)·시간 소프트스톱이 먼저 작동하므로
//     이 값은 순수 방어선이다. 정상 진단(최대 약 130문항 관측)보다 충분히 큰 200으로 둔다.
const DIAG_V3_HARD_QUESTION_CAP = 200;

// v3 다갈래 선수큐(prereqQueue) 상한 — 설계서 §5.1 + 사용자 확정(Q1="더 철저히").
//   하향 약점 갈래를 넉넉히 검사하되, 기존 DIAG_V3_CONCEPT_CAP(30)+12분 소프트스톱이 실질 백스톱.
const DIAG_V3_DOWN_CONCEPT_CAP = 20;  // 한 진단에서 하향(선수)으로 검사하는 개념 누적 상한
const DIAG_V3_DOWN_DEPTH_CAP   = 8;   // 한 갈래의 연속 하향 최대 깊이
const DIAG_V3_PREREQ_FANOUT    = 6;   // 한 개념에서 한 번에 큐에 담는 선수 최대 수(근본도 상위)

// [선수 표본 과반] 설계서 §6.1 — 선수 단원 '통과' 판정을 첫 개념 1정답 → 표본 과반으로.
//   N=3: 선수 단원 진입 시 그 단원 개념을 conceptOrder 순으로 최대 3개 표본 검사.
//   각 표본 개념은 기존 2-strike(1정답=통과·2오답=실패) 유지하되, 개념 실패가 즉시 하향을 일으키지 않고
//   표본 카운트(passed/failed)에만 반영 → 표본 통과 과반이면 갈래 '통과', 미달이면 '하향'.
//   조기확정 on: cap3에서 2통과/2실패 도달 즉시 판정해 진단 단축. 본류(branchDepth=0)는 미적용.
const DIAG_V3_PREREQ_SAMPLE_N = 3;             // 선수 단원 표본 검사 개념 수(문항보유 개념 부족 시 축소)
const DIAG_V3_PREREQ_SAMPLE_EARLYSTOP = true;  // 조기 확정 on(통과/실패 과반 도달 즉시 판정)

// v3 다음 문항 1개 (현재 개념·난이도, 이미 출제 제외)
function getNextDiagnosisV3(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const st = _v3LoadState(session);
  if (!st) { const err = new Error('v3 세션이 아닙니다.'); err.statusCode = 400; throw err; }
  if (session.status === 'completed') return { sessionComplete: true, finished: true, question: null };
  const q = _v3PickQuestion(st.currentConcept, st.currentDifficulty, st.askedQuestionIds);
  if (q) {
    st.askedQuestionIds.push(q.questionId);
    _v3SaveState(sessionId, st);
  }
  return {
    sessionComplete: false,
    concept: _v3HydrateConcept(st.currentConcept, st.conceptOrder),
    question: q,
    progress: _v3Progress(session, st)
  };
}

// 개념(node_level=3) node_id의 부모 단원(node_level=2) 메타 조회.
//   반환: { nodeId, unitName, gradeLevel, grade, semester, area } | null
//   개념 노드 자신에 unit_name/학년이 비면 그대로(부모 단원이 정본). 단원 메타만 노출(정답·문항 비포함).
function _v3ParentUnitOf(conceptId) {
  const n = db.prepare('SELECT parent_node_id FROM learning_map_nodes WHERE node_id = ?').get(conceptId);
  if (!n || !n.parent_node_id) return null;
  const u = db.prepare(
    'SELECT node_id, unit_name, grade_level, grade, semester, area FROM learning_map_nodes WHERE node_id = ?'
  ).get(n.parent_node_id);
  if (!u) return null;
  return {
    nodeId: u.node_id,
    unitName: u.unit_name || '단원',
    gradeLevel: u.grade_level || null,
    grade: u.grade != null ? u.grade : null,
    semester: u.semester != null ? u.semester : null,
    area: u.area || null
  };
}

// [다갈래] 진단 진행 계획 목록 — 선수(하향) 갈래 단원만 done/current/pending으로 dedupe.
//   본류 목표 단원(st.unit.nodeId)은 제외(헤더·결과에서 별도 안내). 단갈래/큐없음이면 [].
//   정렬: prereqQueue가 이미 근본도(_gradeAbsOf 학년 오름차순) 순 → 그 순서를 단원 단위로 보존.
//        done(상단) → current(가운데) → pending(하단) 자연 순서.
//   반환: [{ nodeId, unitName, gradeLabel, area, status, passed?, conceptTotal? }]
function _v3BuildDiagPlan(st) {
  if (!st || !st.v3) return [];
  const prereqQueue = Array.isArray(st.prereqQueue) ? st.prereqQueue : [];
  const downCount = st.downCount || 0;
  // 단갈래/하향 없음 → 패널 숨김 신호(빈 배열)
  if (prereqQueue.length === 0 && downCount === 0) return [];

  const passed = new Set(Array.isArray(st.passedConcepts) ? st.passedConcepts : []);
  const visited = Array.isArray(st.visitedConcepts) ? st.visitedConcepts : [];

  // 본류 목표 단원(제외) = 최초 시작 개념(visitedConcepts[0])의 부모 단원.
  //   ⚠ st.unit/conceptOrder는 하향 진입 시 선수 단원으로 재할당되므로 "현재 단원"일 뿐 원 목표가 아님.
  //   visitedConcepts[0]은 시작 개념으로 절대 제거되지 않아 원 목표 단원을 안정적으로 복원.
  const originConcept = visited.length > 0 ? visited[0] : null;
  const originUnit = originConcept ? _v3ParentUnitOf(originConcept) : null;
  const originUnitId = originUnit ? originUnit.nodeId : null;

  // current 단원 = 현재 진단 중 개념(st.currentConcept)의 부모 단원(= st.unit). 하향 갈래면 이 단원이 ▶.
  const curUnit = st.currentConcept ? _v3ParentUnitOf(st.currentConcept) : null;
  const curUnitId = curUnit ? curUnit.nodeId : null;

  // 단원별 누적: { meta, status, conceptIds:Set, passedCount, orderKey }
  const byUnit = new Map();
  const order = [];   // 첫 등장 순서 보존(근본도순 큐/visited 순서)

  const touch = (unitMeta) => {
    if (!unitMeta || !unitMeta.nodeId) return null;
    if (!byUnit.has(unitMeta.nodeId)) {
      byUnit.set(unitMeta.nodeId, { meta: unitMeta, status: 'pending', passedCount: 0, conceptCount: 0 });
      order.push(unitMeta.nodeId);
    }
    return byUnit.get(unitMeta.nodeId);
  };

  // 1) current 단원(본류 목표 단원이 아닐 때만 — 본류는 헤더에서 안내하므로 목록 제외)
  if (curUnitId && curUnitId !== originUnitId) {
    const e = touch(curUnit);
    if (e) e.status = 'current';
  }

  // 2) done — visited 중 통과/검사완료된 개념의 부모 단원 (본류·current 제외)
  for (const cid of visited) {
    const pu = _v3ParentUnitOf(cid);
    if (!pu || pu.nodeId === originUnitId) continue;
    if (pu.nodeId === curUnitId) {            // 진행 중 단원이면 통과 개념만 카운트(상태는 current 유지)
      if (passed.has(cid)) { const e = byUnit.get(curUnitId); if (e) e.passedCount++; }
      continue;
    }
    const e = touch(pu);
    if (!e) continue;
    if (e.status !== 'current') e.status = 'done';
    if (passed.has(cid)) e.passedCount++;
  }

  // 3) pending — prereqQueue(현재 라운드, 아직 미검사) + nextRoundQueue(다음 라운드 적립)의 개념 부모 단원.
  //   [라운드방식 2026-06-11] 현재 라운드 pending을 먼저, 다음 라운드 대기 단원을 그 뒤에 touch(첫 등장 순서 보존)
  //   → 진행 띠(diagPlan)에 다음 라운드 대기 단원도 pending으로 자연 노출(FE 변경 없이). 본류·current 제외.
  const nextRoundQueue = Array.isArray(st.nextRoundQueue) ? st.nextRoundQueue : [];
  // [단계표기 2026-06-11] pending 단원의 round 산정용 — 현재 라운드(prereqQueue)/다음 라운드(nextRoundQueue) 구분.
  //   nextRoundUnits: nextRoundQueue 소속 개념의 부모 단원 집합(현재 라운드에 동시 등장하면 현재 라운드 우선).
  const curRound = st.prereqRound || 1;
  const nextRoundUnits = new Set();
  for (const cid of prereqQueue) {
    const pu = _v3ParentUnitOf(cid);
    if (!pu || pu.nodeId === originUnitId) continue;
    if (pu.nodeId === curUnitId) continue;    // 진행 중 단원이면 current로 이미 표기
    touch(pu);
  }
  for (const cid of nextRoundQueue) {
    const pu = _v3ParentUnitOf(cid);
    if (!pu || pu.nodeId === originUnitId) continue;
    if (pu.nodeId === curUnitId) continue;
    // 현재 라운드(prereqQueue)에 이미 등장한 단원이면 현재 라운드로 본다(round 중복 방지).
    if (!byUnit.has(pu.nodeId)) nextRoundUnits.add(pu.nodeId);
    touch(pu);
  }

  // 정렬: done(위) → current(가운데) → pending(아래). 같은 그룹 내는 첫 등장 순서(근본도 오름차순) 보존.
  const rank = { done: 0, current: 1, pending: 2 };
  const ordered = order
    .map((unitId, i) => ({ unitId, i }))
    .sort((a, b) => {
      const ra = rank[byUnit.get(a.unitId).status], rb = rank[byUnit.get(b.unitId).status];
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .map(x => x.unitId);

  // [선수 표본 과반] 표본 메타 — current 단원이 표본 검사 중이면 "확인 X/N"(분모=표본수) 부착,
  //   done 단원은 branchVerdicts로 통과/하향(verdict) 부착. conceptTotal(단원 전체)은 분모 금지(설계서 §5.1).
  const bs = st.branchSample;
  const verdicts = (st.branchVerdicts && typeof st.branchVerdicts === 'object') ? st.branchVerdicts : {};
  // 단원 개념 총수 보강(pending 라벨 "개념 N개"용) — 단원 소속 개념 수
  return ordered.map(unitId => {
    const e = byUnit.get(unitId);
    const m = e.meta;
    let conceptTotal = 0;
    try { conceptTotal = _v3ConceptsOfUnit(unitId).length; } catch (_) {}
    // [단계표기 2026-06-11] round — FE "N단계 내려감" 그룹 표기용.
    //   done/current: unitRound 기록값(첫 진입 라운드, 없으면 1).
    //   pending: 현재 라운드(prereqQueue 소속)=curRound, 다음 라운드(nextRoundQueue 소속)=curRound+1.
    let round;
    if (e.status === 'pending') {
      round = nextRoundUnits.has(unitId) ? curRound + 1 : curRound;
    } else {
      round = (st.unitRound && st.unitRound[unitId] != null) ? st.unitRound[unitId] : 1;
    }
    const out = {
      nodeId: m.nodeId,
      unitName: m.unitName,
      gradeLabel: _gradeSemLabel({ gradeLevel: m.gradeLevel, grade: m.grade, semester: m.semester }),
      area: m.area || null,
      status: e.status,
      round,           // [단계표기] 진입 라운드(1=1단계 내려감, 2=2단계 …)
      passed: e.passedCount,
      conceptTotal,
      verdict: null   // done 단원의 갈래 판정('pass'|'down'). current·pending은 null.
    };
    // current 단원이 표본 검사 중이면 "확인 X/N" 메타(분모=표본수)
    if (e.status === 'current' && bs && bs.unitId === unitId) {
      out.sampleCap = bs.sampleCap;
      out.sampleTested = (bs.tested || []).length;
      out.samplePassed = bs.passed || 0;
    }
    // done 단원의 통과/하향 판정
    if (e.status === 'done' && verdicts[unitId]) out.verdict = verdicts[unitId];
    return out;
  });
}

function _v3Progress(session, st) {
  const prog = _v3UnitProgress(st);
  return {
    diagnosedConcepts: st.diagnosedConcepts || 0,
    elapsedSec: _diagElapsedSec(session),
    conceptCap: DIAG_V3_CONCEPT_CAP,
    softTimeLimitSec: DIAG_SOFT_TIME_SEC,
    unitPassed: prog.passed, unitTotal: prog.total,
    prereqQueueRemaining: Array.isArray(st.prereqQueue) ? st.prereqQueue.length : 0,  // [다갈래] FE 헤더용 남은 갈래 수
    downCount: st.downCount || 0,                                                      // [다갈래] 누적 하향 개념 수
    diagPlan: _v3BuildDiagPlan(st)                                                     // [다갈래] 진단 진행 계획(선수 단원 done/current/pending). 단갈래=[]
  };
}

// v3 단원 완료 판정 — 단원 conceptOrder의 (skip 제외) 모든 개념이 passed
function _v3IsUnitComplete(st, unitNodeId) {
  const concepts = _v3ConceptsOfUnit(unitNodeId).map(c => c.nodeId);
  const need = concepts.filter(id => !st.skippedConcepts.includes(id));
  if (need.length === 0) return false;
  return need.every(id => st.passedConcepts.includes(id));
}

// v3 통과 후 다음 개념 결정 — 정방향 prerequisite 중 "같은 단원·미통과·미skip" 우선.
//   단원 conceptOrder 순서를 신뢰하여, 현재 개념 다음의 미통과 같은-단원 개념을 반환.
function _v3NextConceptInUnit(st) {
  const unitConcepts = _v3ConceptsOfUnit(st.unit.nodeId).map(c => c.nodeId);
  // 정방향 엣지 우선
  const fwd = _v3ForwardConcepts(st.currentConcept).filter(id =>
    unitConcepts.includes(id) && !st.passedConcepts.includes(id) && !st.skippedConcepts.includes(id));
  if (fwd.length > 0) return fwd[0];
  // 폴백: conceptOrder 상 다음 미통과·미skip 같은-단원 개념
  for (const id of st.conceptOrder) {
    if (unitConcepts.includes(id) && !st.passedConcepts.includes(id) && !st.skippedConcepts.includes(id) && id !== st.currentConcept) {
      return id;
    }
  }
  return null;
}

// v3 하향(선수 개념) 결정 — 역방향 prerequisite 중 미방문 우선 (진동방지 visited).
//   [구 단일갈래 헬퍼] 다갈래 큐 도입 후 본류 흐름에선 미사용. 참조/하위호환용 보존.
function _v3PrereqConcept(st) {
  const back = _v3BackwardConcepts(st.currentConcept);
  // 미방문 우선
  const unvisited = back.filter(id => !st.visitedConcepts.includes(id));
  const pool = unvisited.length > 0 ? unvisited : back.filter(id => !st.passedConcepts.includes(id));
  if (pool.length === 0) return null;
  // 문항 보유 개념 우선
  for (const id of pool) {
    const has = db.prepare(`
      SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id=nc.content_id WHERE nc.node_id=? LIMIT 1
    `).get(id);
    if (has) return id;
  }
  return pool[0];
}

// ============================================================
// 다갈래 선수큐(prereqQueue) — 설계서 §4
//   2-strike 하향 시 현재 개념의 약한 선수를 "모두" 큐에 담아 근본(낮은 학년)부터 차례 검사.
// ============================================================

// 개념 node_id의 절대학년(_gradeAbs) — 개념(차시) 메타가 비면 부모 단원값으로 보강(_v3HydrateConcept 동일 패턴).
function _gradeAbsOf(conceptId) {
  const n = db.prepare('SELECT grade_level, grade, semester, parent_node_id FROM learning_map_nodes WHERE node_id = ?').get(conceptId);
  if (!n) return 999;
  let gradeLevel = n.grade_level || null;
  let grade = n.grade != null ? n.grade : null;
  let semester = n.semester != null ? n.semester : null;
  if ((grade == null || gradeLevel == null) && n.parent_node_id) {
    try {
      const p = db.prepare('SELECT grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ?').get(n.parent_node_id);
      if (p) {
        if (gradeLevel == null) gradeLevel = p.grade_level || null;
        if (grade == null) grade = p.grade != null ? p.grade : null;
        if (semester == null) semester = p.semester != null ? p.semester : null;
      }
    } catch (_) {}
  }
  return _gradeAbs(gradeLevel, grade, semester);
}

// 개념 node_id의 sort_order(동률 정렬용) — 없으면 0.
function _sortOrderOf(conceptId) {
  const n = db.prepare('SELECT sort_order FROM learning_map_nodes WHERE node_id = ?').get(conceptId);
  return n && n.sort_order != null ? n.sort_order : 0;
}

// 개념 node_id에 출제 가능한 문항이 1개라도 있는지.
function _v3HasQuestion(conceptId) {
  const has = db.prepare(`
    SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id=nc.content_id WHERE nc.node_id=? LIMIT 1
  `).get(conceptId);
  return !!has;
}

// §4.1 — 정렬·필터된 선수 후보. 역방향 prerequisite 전체에서 visited/passed/skip/큐중복/자기참조 제외,
//   근본도(절대학년) 오름차순 정렬 후 fanout 상한 절단. (문항 없는 건 enqueue는 하되 pop에서 skip)
function _v3PrereqCandidates(st, conceptId) {
  const raw = _v3BackwardConcepts(conceptId);
  const seen = new Set();
  const cand = [];
  const verdicts = (st.branchVerdicts && typeof st.branchVerdicts === 'object') ? st.branchVerdicts : {};
  for (const id of raw) {
    if (id === conceptId) continue;                       // 자기참조 방어(사이클)
    if (seen.has(id)) continue;                            // 엣지 중복 제거
    if (st.visitedConcepts.includes(id)) continue;        // 이미 검사/방문 X
    if (st.passedConcepts.includes(id)) continue;         // 이미 통과 X
    if (st.skippedConcepts.includes(id)) continue;        // 문항없음 skip X
    if (st.prereqQueue.includes(id)) continue;            // 이미 대기열(현재 라운드) X
    // [라운드방식 2026-06-11] 이미 다음 라운드 적립큐에 있으면 중복 제외 — #217 가드 확장.
    if (Array.isArray(st.nextRoundQueue) && st.nextRoundQueue.includes(id)) continue;  // 이미 다음 라운드 큐 X
    // [P1 본류복귀 2026-06-11/P3 가드] 부모 단원이 이미 판정(pass/down)된 갈래면 후보 제외 — 판정 끝난 단원 재진입 차단.
    const pu = _v3ParentUnitOf(id);
    if (pu && pu.nodeId && verdicts[pu.nodeId]) continue;
    seen.add(id);
    cand.push(id);
  }
  cand.sort((a, b) => (_gradeAbsOf(a) - _gradeAbsOf(b)) || (_sortOrderOf(a) - _sortOrderOf(b)));
  return cand.slice(0, DIAG_V3_PREREQ_FANOUT);
}

// §4.2 — enqueue(현재 라운드, prereqQueue 적재용).
//   [라운드방식 2026-06-11] 본류 2-strike에서 1라운드를 적재할 때만 사용. 라운드 진행 중 순서 불변이 핵심이므로
//   여기서 전역 재정렬은 1회만(=라운드 적재 순간) 수행하고, 이후 dequeue는 순서를 절대 바꾸지 않는다.
//   갈래 내부에서 발견된 더 깊은 선수는 prereqQueue가 아니라 nextRoundQueue로 적립한다(_v3EnqueueNextRound).
function _v3EnqueuePrereqs(st, conceptId) {
  const cands = _v3PrereqCandidates(st, conceptId);
  for (const id of cands) {
    if (!st.prereqQueue.includes(id)) st.prereqQueue.push(id);
  }
  // 라운드 적재 순간 1회 근본도 오름차순 정렬(고정 순서 확정) — 이후 라운드 진행 중에는 재정렬 금지.
  st.prereqQueue.sort((a, b) => (_gradeAbsOf(a) - _gradeAbsOf(b)) || (_sortOrderOf(a) - _sortOrderOf(b)));
  // 큐 길이 상한: 가장 근본(앞)만 남기고 절단
  if (st.prereqQueue.length > DIAG_V3_DOWN_CONCEPT_CAP) {
    st.prereqQueue = st.prereqQueue.slice(0, DIAG_V3_DOWN_CONCEPT_CAP);
  }
  return cands.length;
}

// [라운드방식 2026-06-11] §4.2-R — enqueue(다음 라운드, nextRoundQueue 적립용).
//   갈래 검사 중 발견된 "더 깊은 선수"를 현재 라운드에 끼워넣지 않고 다음 라운드로 미룬다(BFS rounds).
//   가드는 _v3PrereqCandidates가 visited/passed/skipped/prereqQueue/nextRoundQueue/branchVerdicts 단원을 모두 거른다.
//   정렬은 하지 않는다(라운드 시작 시 _v3StartNextRound가 1회 정렬). 누적 상한만 적용.
function _v3EnqueueNextRound(st, conceptId) {
  const cands = _v3PrereqCandidates(st, conceptId);
  let added = 0;
  for (const id of cands) {
    if (!st.nextRoundQueue.includes(id) && !st.prereqQueue.includes(id)) { st.nextRoundQueue.push(id); added++; }
  }
  // 적립 큐도 폭주 방지(근본 우선 절단) — 라운드 시작 시 정렬되므로 여기선 길이만 제한.
  if (st.nextRoundQueue.length > DIAG_V3_DOWN_CONCEPT_CAP) {
    st.nextRoundQueue = st.nextRoundQueue.slice(0, DIAG_V3_DOWN_CONCEPT_CAP);
  }
  return added;
}

// [라운드방식 2026-06-11] §4.3-R — 라운드 전환. 현재 prereqQueue 소진 시 호출.
//   nextRoundQueue가 비었으면 false(라운드 없음 → 호출자가 기존 종료/본류복귀 흐름 진행).
//   비어있지 않으면: prereqRound++ → DEPTH_CAP(라운드 깊이) 초과 시 라운드 폐기(false 반환, 종료 흐름),
//   아니면 prereqQueue = sort(nextRoundQueue), nextRoundQueue=[] (반드시 비움 — 무한루프 가드), true 반환.
//   ⚠ 전환에 성공해도 _v3DequeueNext의 본문 가드(visited/판정단원/문항없음)로 실제 pop은 0개일 수 있다.
//      그 경우 dequeue가 다시 null → 호출자가 또 _v3StartNextRound 시도(다음 라운드도 적립돼 있으면)하므로
//      라운드 전환은 항상 nextRoundQueue를 비워 유한성을 보장한다.
function _v3StartNextRound(st) {
  if (!Array.isArray(st.nextRoundQueue) || st.nextRoundQueue.length === 0) return false;
  st.prereqRound = (st.prereqRound || 1) + 1;
  // 라운드 깊이 상한(연속 하향 깊이와 동일 기준) 초과 → 라운드 폐기·종료 흐름.
  if (st.prereqRound > DIAG_V3_DOWN_DEPTH_CAP) {
    st.nextRoundQueue = [];   // 무한루프 가드: 폐기 시에도 반드시 비운다.
    return false;
  }
  // 다음 라운드 적재 — 근본도 오름차순 1회 정렬(이후 라운드 진행 중 불변).
  const round = st.nextRoundQueue.slice();
  round.sort((a, b) => (_gradeAbsOf(a) - _gradeAbsOf(b)) || (_sortOrderOf(a) - _sortOrderOf(b)));
  st.prereqQueue = (round.length > DIAG_V3_DOWN_CONCEPT_CAP) ? round.slice(0, DIAG_V3_DOWN_CONCEPT_CAP) : round;
  st.nextRoundQueue = [];     // 무한루프 가드: 전환 시 반드시 비운다(설계서 회귀 보존).
  return true;
}

// [라운드방식 2026-06-11] §4.3-R — 라운드 인식 dequeue. 현재 라운드(prereqQueue)에서만 pop하되,
//   현재 라운드 소진 시 다음 라운드를 시작해 계속 pop을 시도한다(유한 — 라운드 수는 DEPTH_CAP, 각 라운드 큐는 비워짐).
//   반환: { id, newRound } — newRound는 이번 호출에서 라운드가 새로 전환됐으면 그 번호, 아니면 null.
//        id=null이면 모든 라운드 소진(호출자가 종료/본류복귀).
function _v3DequeueNextRoundAware(st) {
  let newRound = null;
  // 라운드 수 상한(DEPTH_CAP)만큼만 전환 시도(무한루프 방어).
  let roundGuard = DIAG_V3_DOWN_DEPTH_CAP + 2;
  while (roundGuard-- > 0) {
    const id = _v3DequeueNext(st);
    if (id) return { id, newRound };
    // 현재 라운드 소진 → 다음 라운드 시작 시도.
    if (!_v3StartNextRound(st)) return { id: null, newRound };
    newRound = st.prereqRound;
    // 전환 성공 → 루프 상단에서 새 라운드 prereqQueue로 다시 pop.
  }
  return { id: null, newRound };
}

// §4.3 — dequeue. 가장 근본(앞)부터 pop. visited/passed/skip·상한 가드·문항없음 skip 루프.
//   반환: 다음 검사할 선수 node_id 또는 null(큐 소진/상한 → 하향 전체 종료).
function _v3DequeueNext(st) {
  const maxIter = (st.prereqQueue.length || 0) + 2;  // 무한루프 방어(R3)
  let iter = 0;
  const verdicts = (st.branchVerdicts && typeof st.branchVerdicts === 'object') ? st.branchVerdicts : {};
  while (st.prereqQueue.length > 0 && iter++ < maxIter) {
    if ((st.downCount || 0) >= DIAG_V3_DOWN_CONCEPT_CAP) { st.prereqQueue = []; break; }  // 하드 상한 → 종료
    const id = st.prereqQueue.shift();  // 가장 근본(앞)
    if (!id) continue;
    if (st.visitedConcepts.includes(id) || st.passedConcepts.includes(id) || st.skippedConcepts.includes(id)) continue;  // 그 사이 처리됨
    // [P1 본류복귀 2026-06-11/P3 가드] 부모 단원이 이미 판정(pass/down)된 갈래면 pop 대상에서 제외 — 재진입 차단.
    const pu = _v3ParentUnitOf(id);
    if (pu && pu.nodeId && verdicts[pu.nodeId]) continue;
    if (!_v3HasQuestion(id)) { if (!st.skippedConcepts.includes(id)) st.skippedConcepts.push(id); continue; }  // 문항 없음 skip
    return id;
  }
  return null;
}

// 다갈래 — 선수 개념으로 실제 이동(부모 단원 전환, currentConcept 갱신, visited.push, downCount/branchDepth 증가).
//   반환: 출제 문항(q) 또는 null(문항 없음). go-prereq / next-prereq 공통.
function _v3MoveIntoPrereq(st, prereqId) {
  // 선수 개념의 부모 단원으로 현재 단원 갱신(단원 경계 가로지름 표시)
  const parent = db.prepare('SELECT parent_node_id FROM learning_map_nodes WHERE node_id = ? AND node_level=3').get(prereqId);
  if (parent && parent.parent_node_id && parent.parent_node_id !== st.unit.nodeId) {
    const u = db.prepare('SELECT node_id, unit_name, area, grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ? AND node_level=2').get(parent.parent_node_id);
    if (u) {
      st.unit = { nodeId: u.node_id, name: u.unit_name || '단원', area: u.area || null, gradeLevel: u.grade_level || null, grade: u.grade != null ? u.grade : null, semester: u.semester != null ? u.semester : null };
      st.conceptOrder = _v3ConceptsOfUnit(u.node_id).map(c => c.nodeId);
    }
  }
  // [선수 표본 과반 버그수정 2026-06-11] 표본을 '단원 앞에서부터' N개로 잡고, 진입 개념도
  //   선수 엣지 타깃(prereqId)이 아니라 표본 첫 개념(=단원 기초 개념)으로 둔다. 이렇게 해야
  //   모든 갈래가 동일하게 단원 앞 N개 표본(cap=min(3,가용))을 검사한다. (이전엔 prereqId가
  //   단원 마지막 개념이면 표본 1개로 축소돼 둘째 갈래부터 1정답 통과되던 버그.)
  const sample = (st.unit && st.unit.nodeId) ? _v3UnitSampleConcepts(st.unit.nodeId, prereqId, st) : [];
  const entryConcept = (sample.length > 0) ? sample[0] : prereqId;   // 표본 0이면 폴백(기존 prereqId)

  // [P1 본류복귀 2026-06-11] 소비된 큐 토큰(prereqId)도 visited 마킹 — #216 표본화로 entryConcept(sample[0])만
  //   visited되며 사라졌던 pre-#216 불변 복원. prereqId가 visited되지 않으면 _v3PrereqCandidates 필터를 통과해
  //   같은 선수 개념이 재enqueue될 수 있다(재진입 차단).
  if (prereqId && !st.visitedConcepts.includes(prereqId)) st.visitedConcepts.push(prereqId);

  st.currentConcept = entryConcept;
  st.currentDifficulty = _v3StartDifficulty(entryConcept);
  st.strike = 0;
  if (!st.visitedConcepts.includes(entryConcept)) st.visitedConcepts.push(entryConcept);
  st.downCount = (st.downCount || 0) + 1;
  // [라운드방식 2026-06-11] branchDepth = 현재 라운드 번호(증가 대신). branchDepth>0 게이트(표본 적용)는
  //   라운드>=1이면 항상 성립하므로 그대로 유효. 깊이 상한 검사도 라운드 번호 기준으로 동작.
  st.branchDepth = st.prereqRound || 1;
  // [단계표기 2026-06-11] 이 갈래 단원의 진입 라운드 기록(첫 진입만 — 이미 있으면 유지).
  //   FE가 "N단계 내려감" 그룹 표기에 사용. unitRound[단원] = 진입 시점 라운드.
  if (st.unitRound && typeof st.unitRound === 'object' && st.unit && st.unit.nodeId) {
    if (st.unitRound[st.unit.nodeId] == null) st.unitRound[st.unit.nodeId] = st.prereqRound || 1;
  }
  const q = _v3PickQuestion(entryConcept, st.currentDifficulty, st.askedQuestionIds);
  if (q) st.askedQuestionIds.push(q.questionId);
  // [선수 표본 과반] 새 선수 단원(갈래) 진입 → 표본 검사 초기화(설계서 §4.2). 표본 배열 직접 전달.
  _v3InitBranchSample(st, entryConcept, sample);
  return q;
}

// ============================================================
// [선수 표본 과반] 단원 표본 검사(unit sampling) — 설계서 §4
//   선수 갈래(branchDepth>0)에 한해 '통과' 판정을 첫 개념 1정답 → 표본 N개 중 과반 정답으로 강화.
//   본류(branchDepth=0)는 미적용(기존 순차 진단 그대로).
// ============================================================

// §4.1 — 표본 단원 개념 목록(문항 보유·미통과·미skip, conceptOrder 순).
//   [버그수정 2026-06-11] 진입 개념(선수 엣지 타깃) 이후만 slice 하던 로직 제거 —
//   선수 엣지는 보통 단원의 출구(마지막) 개념을 가리켜 둘째 갈래부터 표본이 1개로 축소되어
//   '과반 통과' 규칙이 무력화(1정답 통과)됐다. 모든 갈래가 동일하게 단원 conceptOrder
//   '앞에서부터' 문항보유·미통과·미skip 개념을 최대 N개 모아 표본으로 삼는다(단원 기초부터 검사).
//   (visited는 무관 — _v3MoveIntoPrereq가 표본 산정 후 sample[0]을 진입 개념으로 세팅·visited.push 하므로
//    표본 산정 단계에서는 visited를 필터에 넣지 않는다.)
function _v3UnitSampleConcepts(unitId, entryConceptId, st) {
  const all = _v3ConceptsOfUnit(unitId).map(c => c.nodeId);   // conceptOrder(위상정렬) 순
  // 단원 앞에서부터: 문항보유 + 미통과 + 미skip만. (visited 무관 — 진입 직전 push 되므로 제외하면 표본 0됨)
  const seq = all.filter(id =>
    _v3HasQuestion(id) && !st.passedConcepts.includes(id) && !st.skippedConcepts.includes(id));
  // 최대 N개(앞에서부터). 문항보유 개념이 N 미만이면 있는 만큼.
  return seq.slice(0, DIAG_V3_PREREQ_SAMPLE_N);
}

// §4.2 — 선수 단원 진입 시 표본 상태 초기화. cap<1이면 null(표본 미적용=구 동작 폴백).
//   sampleArr(선택): _v3MoveIntoPrereq가 이미 계산한 표본 배열(단원 앞 N개). 정합·일관 위해 그대로 사용.
//   미전달 시 내부 재계산(하위호환). 표본 첫 개념=진입 개념, 나머지는 sampleQueue.
function _v3InitBranchSample(st, entryConceptId, sampleArr) {
  const unitId = st.unit && st.unit.nodeId;
  if (!unitId) { st.branchSample = null; return; }
  const seq = (Array.isArray(sampleArr) && sampleArr.length > 0)
    ? sampleArr
    : _v3UnitSampleConcepts(unitId, entryConceptId, st);
  const cap = Math.min(DIAG_V3_PREREQ_SAMPLE_N, seq.length);
  if (cap < 1) { st.branchSample = null; return; }
  st.branchSample = {
    unitId,
    sampleCap: cap,
    sampleQueue: seq.slice(1),   // 진입 개념(seq[0])은 곧 검사하므로 큐에서 제외
    tested: [],
    passed: 0,
    failed: 0
  };
}

// §4.3 — 표본 1개념 판정 반영(개념 통과/실패 확정 순간). passed/failed·tested 갱신.
function _v3SampleRecord(st, conceptId, conceptPassed) {
  const bs = st.branchSample;
  if (!bs) return;
  if (!bs.tested.includes(conceptId)) bs.tested.push(conceptId);
  if (conceptPassed) bs.passed += 1; else bs.failed += 1;
}

// §4.4 — 갈래 판정. 'pass' | 'fail' | 'continue'. 조기확정·소수표본 엄격화 반영.
function _v3SampleVerdict(bs) {
  if (!bs) return 'pass';
  const cap = bs.sampleCap;
  let needPass = Math.ceil(cap / 2);
  let needFail = cap - needPass + 1;
  // 소수 표본 엄격화(S5): cap2는 둘 다 맞아야 통과(1 우연정답 차단), cap1은 단일.
  if (cap === 2) { needPass = 2; needFail = 1; }
  if (cap === 1) { needPass = 1; needFail = 1; }
  if (DIAG_V3_PREREQ_SAMPLE_EARLYSTOP) {
    if (bs.passed >= needPass) return 'pass';   // 조기확정: 과반 통과 도달 즉시
    if (bs.failed >= needFail) return 'fail';   // 조기확정: 과반 미달 확정 즉시
  }
  if (bs.tested.length >= cap) return (bs.passed >= needPass) ? 'pass' : 'fail';  // 표본 소진
  return 'continue';   // 다음 표본 개념으로
}

// §4.6 — 같은 단원 표본 다음 개념 이동(downCount/branchDepth/branchSample.unitId 불변).
//   _v3MoveIntoPrereq(새 갈래 진입)와 달리 같은 갈래 내부 진행이므로 깊이·하향 카운트 미증가.
//   반환: 출제 문항(q) 또는 null(문항 없음).
function _v3MoveToSample(st, conceptId) {
  st.currentConcept = conceptId;
  st.currentDifficulty = _v3StartDifficulty(conceptId);
  st.strike = 0;
  if (!st.visitedConcepts.includes(conceptId)) st.visitedConcepts.push(conceptId);
  const q = _v3PickQuestion(conceptId, st.currentDifficulty, st.askedQuestionIds);
  if (q) st.askedQuestionIds.push(q.questionId);
  return q;
}

// §4.5 — 표본 판정 후 다음 표본 개념 출제(continue) 또는 강제 판정(큐 소진). 문항없음 skip 루프.
//   반환: { kind:'sample-next', question, verdict:null } (다음 표본 출제 성공)
//        | { kind:'verdict', verdict:'pass'|'fail' } (continue 불가 → 강제 판정)
function _v3SampleAdvance(st) {
  const bs = st.branchSample;
  if (!bs) return { kind: 'verdict', verdict: 'pass' };
  const cap = bs.sampleCap;
  let needPass = Math.ceil(cap / 2);
  if (cap === 2) needPass = 2;
  if (cap === 1) needPass = 1;
  // 표본 큐에서 문항 보유 다음 개념을 찾는다(문항없음 개념은 표본 제외·skip).
  let guard = (bs.sampleQueue.length || 0) + 2;
  while (bs.sampleQueue.length > 0 && guard-- > 0) {
    const nextC = bs.sampleQueue.shift();
    if (!nextC) continue;
    if (st.passedConcepts.includes(nextC) || st.visitedConcepts.includes(nextC)) continue;  // 이미 검사됨
    if (!_v3HasQuestion(nextC)) { if (!st.skippedConcepts.includes(nextC)) st.skippedConcepts.push(nextC); continue; }
    const q = _v3MoveToSample(st, nextC);
    if (q) return { kind: 'sample-next', question: q };
    if (!st.skippedConcepts.includes(nextC)) st.skippedConcepts.push(nextC);
  }
  // 큐 소진(문항없음 등으로 cap 미달) → 강제 판정.
  return { kind: 'verdict', verdict: (bs.passed >= needPass) ? 'pass' : 'fail' };
}

// [P1 본류복귀 2026-06-11] 선수 큐 소진(prereqDone) 시 st.unit/conceptOrder를 "원 목표 단원"으로 복원.
//   ⚠ st.unit은 하향 진입(_v3MoveIntoPrereq)에서 마지막 갈래 단원으로 재할당된 채 남는다.
//   복원 안 하면 폴스루(submit isCorrect / _v3ResumeMainAfterPrereq)가 마지막 갈래 단원 기준으로
//   _v3IsUnitComplete/_v3NextConceptInUnit을 수행 → 목표 단원 진단이 방치되고 갈래 단원이 본류로 둔갑.
//   원 목표 단원 = visitedConcepts[0](시작 개념, 절대 제거 안 됨)의 부모 단원 (diagPlan originUnit과 동일 출처).
//   반환: 복원 성공 시 복원된 단원 메타({nodeId,name,area,gradeLevel,grade,semester,conceptTotal}) 또는 null.
function _v3RestoreOriginUnit(st) {
  const visited = Array.isArray(st.visitedConcepts) ? st.visitedConcepts : [];
  const originConcept = visited.length > 0 ? visited[0] : null;
  if (!originConcept) return null;
  const originUnit = _v3ParentUnitOf(originConcept);   // { nodeId, unitName, gradeLevel, grade, semester, area }
  if (!originUnit || !originUnit.nodeId) return null;
  st.unit = {
    nodeId: originUnit.nodeId,
    name: originUnit.unitName || '단원',
    area: originUnit.area || null,
    gradeLevel: originUnit.gradeLevel || null,
    grade: originUnit.grade != null ? originUnit.grade : null,
    semester: originUnit.semester != null ? originUnit.semester : null
  };
  st.conceptOrder = _v3ConceptsOfUnit(originUnit.nodeId).map(c => c.nodeId);
  return {
    nodeId: st.unit.nodeId,
    name: st.unit.name,
    area: st.unit.area,
    gradeLevel: st.unit.gradeLevel,
    grade: st.unit.grade,
    semester: st.unit.semester,
    conceptTotal: st.conceptOrder.length
  };
}

// §4.5 — 갈래 '통과' 확정 처리. 표본 종료 → branchVerdicts[unit]='pass' → 큐 다음 갈래/본류 복귀.
//   resp에 next-prereq(다음 갈래) 출제 또는 prereqDone(본류 복귀) 신호를 채워 반환(완결) 또는 null(본류 합류).
//   반환: resp(완결, return 대상) 또는 null(호출자가 이어서 본류 unit/next-concept 흐름 진행).
function _v3BranchSamplePass(sessionId, session, st, resp, wrongNoteAdded) {
  if (st.branchSample && st.branchSample.unitId) st.branchVerdicts[st.branchSample.unitId] = 'pass';
  st.branchSample = null;
  // [라운드방식 2026-06-11] 큐 다음 갈래 시도 — 라운드 인식 dequeue(현재 라운드 소진 시 다음 라운드로 전환).
  let deq = _v3DequeueNextRoundAware(st);
  let next = deq.id;
  while (next) {
    st.branchDepth = 0;                 // 새 갈래 시작 → 리셋(_v3MoveIntoPrereq가 prereqRound로 세팅)
    const nq = _v3MoveIntoPrereq(st, next);
    if (nq) {
      resp.attemptStage = 'next-prereq';
      if (deq.newRound) resp.newRound = deq.newRound;   // [라운드방식] FE 후속용 라운드 전환 신호
      resp.nextQuestion = nq;
      resp.nextConcept = _v3HydrateConcept(st.currentConcept, st.conceptOrder);
      resp.queueRemaining = st.prereqQueue.length;
      _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }
    if (!st.skippedConcepts.includes(next)) st.skippedConcepts.push(next);
    deq = _v3DequeueNextRoundAware(st);
    next = deq.id;
  }
  // 큐 소진 → 본류 복귀. branchDepth 리셋·prereqDone 신호 후 본류 unit/next-concept 흐름으로 합류.
  st.branchDepth = 0;
  resp.prereqDone = true;
  resp.queueRemaining = 0;
  // [P1 본류복귀 2026-06-11] st.unit이 마지막 갈래 단원에 머물러 있으므로 원 목표 단원으로 복원.
  //   복원 후 폴스루/_v3ResumeMainAfterPrereq가 목표 단원 기준으로 단원완료·후속개념 판정 → 미통과 본류 개념 재출제.
  //   resp.unit으로 FE 플레이어 헤더 단원명을 갈래 단원(예: 다각형)→목표 단원(예: 합동과 대칭)으로 교체.
  const restored = _v3RestoreOriginUnit(st);
  if (restored) resp.unit = restored;
  return null;   // 호출자가 본류 단원완료/후속개념 흐름 이어감
}

// §4.5 — 갈래 '하향(과반 미달)' 확정 처리(DOWNSHIFT). branchVerdicts[unit]='down' → 이 단원 선수 enqueue → 큐 다음.
//   _v3DownTo와 동일한 branch(down) 응답을 만들되, 표본 과반 미달이 진입점. 반환: resp(완결).
function _v3BranchSampleDownshift(sessionId, session, st, resp, wrongNoteAdded) {
  const bs = st.branchSample;
  if (bs && bs.unitId) st.branchVerdicts[bs.unitId] = 'down';
  resp.strike = 2;
  resp.attemptStage = 'down';

  const depthCapped = (st.branchDepth || 0) >= DIAG_V3_DOWN_DEPTH_CAP;
  // [라운드방식 2026-06-11 — 갭 fix 핵심] 실패한 '표본 개념 전체'의 더 깊은 선수를 "다음 라운드"에 적립.
  //   이전: _v3EnqueuePrereqs(st, currentConcept) 1개만 → 표본 중 마지막 실패 개념의 선수만 검사돼
  //         (예: 각·직각 표본의 '각 이해하기' 선수 '반직선 구별하기'가 누락)되던 갭.
  //   이번: bs.tested 중 미통과(=실패) 개념 각각의 선수를 nextRoundQueue로 push(중복·#217 가드는 후보 함수가 처리).
  //   현재 라운드(prereqQueue)엔 끼워넣지 않으므로 라운드 내 고정 순서가 보존된다(끼어들기 제거).
  if (!depthCapped) {
    const tested = (bs && Array.isArray(bs.tested)) ? bs.tested : [];
    const failed = tested.filter(id => !st.passedConcepts.includes(id));
    // 표본 미적용 폴백(bs 없음) 등으로 failed가 비면 현재 개념을 대상으로(하위호환).
    const targets = failed.length > 0 ? failed : [st.currentConcept];
    for (const cid of targets) _v3EnqueueNextRound(st, cid);
  }
  st.branchSample = null;
  // [라운드방식] dequeue는 현재 라운드(prereqQueue)에서만 — 소진 시 _v3DequeueNextRoundAware가 다음 라운드로 전환.
  const deq = _v3DequeueNextRoundAware(st);
  const next = deq.id;
  if (!next) {
    // 더 내려갈 곳 없음/모든 라운드 소진 → 종료형 안내(root 모달 재사용, 본류 복귀 대신 종료형).
    resp.branch = { type: 'down', prereqConcept: null, isRoot: false, queueRemaining: 0, multi: false, autoProceed: false };
    delete st._pendingPrereq;
    _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
    resp.progress = _v3Progress(session, st);
    return resp;
  }
  if (deq.newRound) resp.newRound = deq.newRound;   // [라운드방식] FE 후속용 라운드 전환 신호
  if (depthCapped) st.branchDepth = 0;
  st._pendingPrereq = next;
  const queueRemaining = st.prereqQueue.length;
  resp.branch = {
    type: 'down',
    prereqConcept: _v3HydrateConcept(next, null),
    isRoot: false,
    currentConcept: _v3HydrateConcept(st.currentConcept, st.conceptOrder),
    queueRemaining,
    multi: queueRemaining > 0,
    autoProceed: (st.downCount || 0) > 0   // 선수 갈래 내부라 항상 true(모달없이 go-prereq)
  };
  _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
  resp.progress = _v3Progress(session, st);
  return resp;
}

// §4.5-(B) — 선수 갈래에서 표본 개념 '실패'(2-strike 또는 재출제 없음) 라우팅.
//   즉시 하향이 아니라 표본 실패 카운트 → verdict. continue=같은 단원 다음 표본 출제, fail=하향, pass(드묾)=갈래 통과.
//   diagnosedConcepts++ 는 표본 개념도 "진단한 개념"이므로 여기서 1회 증가(기존 _v3DownTo 패턴 유지).
function _v3SampleConceptFail(sessionId, session, st, resp, wrongNoteAdded) {
  const curConcept = st.currentConcept;
  st.diagnosedConcepts = (st.diagnosedConcepts || 0) + 1;
  _v3SampleRecord(st, curConcept, false);
  let verdict = _v3SampleVerdict(st.branchSample);
  if (verdict === 'continue') {
    const adv = _v3SampleAdvance(st);
    if (adv.kind === 'sample-next') {
      resp.attemptStage = 'sample-next';
      resp.sampleCorrect = false;   // FE 토스트 문구 분기(직전 오답)
      resp.strike = 0;
      resp.nextQuestion = adv.question;
      resp.nextConcept = _v3HydrateConcept(st.currentConcept, st.conceptOrder);
      resp.queueRemaining = st.prereqQueue.length;
      _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }
    verdict = adv.verdict;   // 큐 소진 → 강제 판정
  }
  if (verdict === 'pass') {
    const done = _v3BranchSamplePass(sessionId, session, st, resp, wrongNoteAdded);
    if (done) return done;
    // 본류 복귀(prereqDone) → 본류 단원완료/후속개념 판정으로 합류
    return _v3ResumeMainAfterPrereq(sessionId, session, st, resp, wrongNoteAdded);
  }
  // 'fail' — 표본 과반 미달 → 하향
  return _v3BranchSampleDownshift(sessionId, session, st, resp, wrongNoteAdded);
}

// 선수 큐 소진(prereqDone) 후 본류 단원 흐름 합류 — 단원완료/후속개념 출제.
//   submit 정답 분기는 본문에서 이어가지만, 표본 fail→pass(드묾) 경로는 별도 진입점이 필요해 추출.
function _v3ResumeMainAfterPrereq(sessionId, session, st, resp, wrongNoteAdded) {
  if (_v3IsUnitComplete(st, st.unit.nodeId)) {
    if (!st.completedUnits.includes(st.unit.nodeId)) st.completedUnits.push(st.unit.nodeId);
    resp.unitDone = true; resp.attemptStage = 'unit-done';
    const nextUnits = _v3NextUnits(st.unit.nodeId);
    resp.branch = { type: 'unit-complete', unitName: st.unit.name, nextUnits, isLast: nextUnits.length === 0 };
    _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
    resp.progress = _v3Progress(session, st);
    return resp;
  }
  const nextC = _v3NextConceptInUnit(st);
  if (nextC) {
    st.currentConcept = nextC;
    st.currentDifficulty = _v3StartDifficulty(nextC);
    st.strike = 0;
    if (!st.visitedConcepts.includes(nextC)) st.visitedConcepts.push(nextC);
    const nq = _v3PickQuestion(nextC, st.currentDifficulty, st.askedQuestionIds);
    if (nq) {
      st.askedQuestionIds.push(nq.questionId);
      resp.attemptStage = 'next-concept';
      resp.nextQuestion = nq;
      resp.nextConcept = _v3HydrateConcept(nextC, st.conceptOrder);
      _v3SaveState(sessionId, st, { currentNodeId: nextC, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }
    if (!st.skippedConcepts.includes(nextC)) st.skippedConcepts.push(nextC);
    resp.conceptSkipped = nextC;
    return _v3AdvanceAfterSkip(sessionId, session, st, resp, wrongNoteAdded);
  }
  // 후속 없음 → 단원 완주
  if (!st.completedUnits.includes(st.unit.nodeId)) st.completedUnits.push(st.unit.nodeId);
  resp.unitDone = true; resp.attemptStage = 'unit-done';
  const nextUnits = _v3NextUnits(st.unit.nodeId);
  resp.branch = { type: 'unit-complete', unitName: st.unit.name, nextUnits, isLast: nextUnits.length === 0 };
  _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
  resp.progress = _v3Progress(session, st);
  return resp;
}

// v3 채점 — 정규화 채점(judgeQuestionAnswer 재사용) + 2-strike 상태 관리 + 이동 결정.
//   payload: { questionId, contentId, nodeId, answer }
function submitDiagnosisV3(sessionId, payload = {}) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) { const err = new Error('세션 없음'); err.statusCode = 404; throw err; }
  const st = _v3LoadState(session);
  if (!st) { const err = new Error('v3 세션이 아닙니다.'); err.statusCode = 400; throw err; }
  if (session.status === 'completed') return { finished: true, sessionComplete: true, attemptStage: 'finished' };

  // [루프 안전망] 누적 출제 문항이 하드 상한을 넘으면 — 어떤 분기·클라이언트 동작에서도 — 즉시 종료.
  //   (정상 경로는 통과/하향 상한이 먼저 작동. 이 가드는 FE 분기 실패로 인한 무한 제출을 끊는 최종 방어선.)
  const _askedSoFar = Array.isArray(st.askedQuestionIds) ? st.askedQuestionIds.length : (session.total_questions || 0);
  if (_askedSoFar >= DIAG_V3_HARD_QUESTION_CAP) {
    _v3SaveState(sessionId, st, { status: 'completed', completed: true });
    return { finished: true, sessionComplete: true, attemptStage: 'finished', progress: _v3Progress(session, st) };
  }

  const questionId = payload.questionId != null ? payload.questionId : payload.question_id;
  const answer = payload.answer;
  const answerIndex = payload.answerIndex != null ? payload.answerIndex : payload.answer_index;
  const nodeId = payload.nodeId || payload.node_id || st.currentConcept;
  if (!questionId) { const err = new Error('questionId is required'); err.statusCode = 400; throw err; }
  // content_id·question_number 도 함께 조회 → 오답노트 등록 시 원본 콘텐츠 문항 복구(객관식 options) 가능
  const q = db.prepare('SELECT id, content_id, question_number, answer, options, question_text, explanation FROM content_questions WHERE id = ?').get(questionId);
  if (!q) { const err = new Error('questionId not found'); err.statusCode = 400; throw err; }

  const isCorrect = judgeQuestionAnswer(q, answer, answerIndex);
  const curConcept = st.currentConcept;

  // diagnosis_answers 기록 (FK 방어)
  const safeContentId = resolveValidContentId(payload.contentId != null ? payload.contentId : payload.content_id, questionId);
  try {
    db.prepare(`INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, curConcept, safeContentId, String(answer == null ? '' : answer), isCorrect ? 1 : 0);
  } catch (e) {
    if (String(e.message).includes('FOREIGN KEY')) {
      const anyC = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get();
      db.prepare(`INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct) VALUES (?, ?, ?, ?, ?)`)
        .run(sessionId, curConcept, anyC ? anyC.id : 1, String(answer == null ? '' : answer), isCorrect ? 1 : 0);
    } else throw e;
  }
  db.prepare(`UPDATE diagnosis_sessions SET total_questions = total_questions + 1, correct_count = correct_count + ? WHERE id = ?`)
    .run(isCorrect ? 1 : 0, sessionId);

  // 진단 오답 → 오답노트 자동 등록 (정답일 땐 미등록)
  let wrongNoteAdded = false;
  if (!isCorrect) {
    wrongNoteAdded = _registerDiagnosisWrongNote(session.user_id, curConcept, q, answer);
  }

  st.history.push({ concept: curConcept, correct: isCorrect ? 1 : 0, strike: st.strike, questionId });

  const resp = {
    isCorrect,
    strike: 0,
    attemptStage: null,
    nextQuestion: null,
    nextConcept: null,
    unitDone: false,
    branch: null,
    wrongNoteAdded,
    finished: false,
    prereqDone: false,                         // [다갈래] 선수 큐 소진 후 본류 복귀 신호
    queueRemaining: st.prereqQueue.length      // [다갈래] 남은 갈래 수(FE 헤더용)
  };

  if (isCorrect) {
    // ── 개념 통과 ──
    st.strike = 0;
    if (!st.passedConcepts.includes(curConcept)) st.passedConcepts.push(curConcept);
    st.diagnosedConcepts = (st.diagnosedConcepts || 0) + 1;
    resp.attemptStage = 'next-concept';

    // [선수 표본 과반 §4.5-(A)] 선수 갈래(branchDepth>0)에서 개념 통과(1정답) → 표본 카운트로 라우팅.
    //   branchSample!=null이면: record(passed) → verdict. continue=같은 단원 다음 표본 출제(갈래 유지),
    //   pass=갈래 통과(큐 다음/본류), fail(강제판정)=하향. 본류(branchSample==null)는 영향 없음.
    if ((st.branchDepth || 0) > 0 && st.branchSample) {
      _v3SampleRecord(st, curConcept, true);
      let verdict = _v3SampleVerdict(st.branchSample);
      if (verdict === 'continue') {
        const adv = _v3SampleAdvance(st);
        if (adv.kind === 'sample-next') {
          resp.attemptStage = 'sample-next';
          resp.sampleCorrect = true;   // FE 토스트 문구 분기(직전 정답)
          resp.nextQuestion = adv.question;
          resp.nextConcept = _v3HydrateConcept(st.currentConcept, st.conceptOrder);
          resp.queueRemaining = st.prereqQueue.length;
          _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
          resp.progress = _v3Progress(session, st);
          return resp;
        }
        verdict = adv.verdict;   // 큐 소진 → 강제 판정(pass/fail)
      }
      if (verdict === 'pass') {
        const done = _v3BranchSamplePass(sessionId, session, st, resp, wrongNoteAdded);
        if (done) return done;   // 다음 갈래 출제 완결. null이면 본류 복귀 → 아래 흐름 합류.
      } else {  // 'fail' — 표본 큐 소진 강제판정으로 미달(통과 직후 드묾) → 하향
        return _v3BranchSampleDownshift(sessionId, session, st, resp, wrongNoteAdded);
      }
    } else if ((st.branchDepth || 0) > 0) {
      // [하위호환] 선수 갈래인데 branchSample 없음(구 세션) → 기존 1정답 통과(즉시 큐 다음/본류).
      if (st.branchSample && st.branchSample.unitId) st.branchVerdicts[st.branchSample.unitId] = 'pass';
      const done = _v3BranchSamplePass(sessionId, session, st, resp, wrongNoteAdded);
      if (done) return done;   // null이면 본류 복귀(prereqDone) → 아래 흐름 합류.
    }

    // 단원 완료 판정
    if (_v3IsUnitComplete(st, st.unit.nodeId)) {
      if (!st.completedUnits.includes(st.unit.nodeId)) st.completedUnits.push(st.unit.nodeId);
      resp.unitDone = true;
      resp.attemptStage = 'unit-done';
      const nextUnits = _v3NextUnits(st.unit.nodeId);
      resp.branch = { type: 'unit-complete', unitName: st.unit.name, nextUnits, isLast: nextUnits.length === 0 };
      _v3SaveState(sessionId, st, { currentNodeId: curConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }

    // 후속 개념
    const nextC = _v3NextConceptInUnit(st);
    if (nextC) {
      st.currentConcept = nextC;
      st.currentDifficulty = _v3StartDifficulty(nextC);
      st.strike = 0;
      if (!st.visitedConcepts.includes(nextC)) st.visitedConcepts.push(nextC);
      const nq = _v3PickQuestion(nextC, st.currentDifficulty, st.askedQuestionIds);
      if (nq) {
        st.askedQuestionIds.push(nq.questionId);
        resp.nextQuestion = nq;
        resp.nextConcept = _v3HydrateConcept(nextC, st.conceptOrder);
      } else {
        // 문항 없는 개념 → skip + 단원 완료 재판정
        if (!st.skippedConcepts.includes(nextC)) st.skippedConcepts.push(nextC);
        resp.conceptSkipped = nextC;
        // 재귀적 다음 개념 탐색(간단 루프 — visited로 무한루프 방지)
        return _v3AdvanceAfterSkip(sessionId, session, st, resp, wrongNoteAdded);
      }
    } else {
      // 후속 개념 없음 = 단원 완주(이론상 위에서 처리되나 방어)
      if (!st.completedUnits.includes(st.unit.nodeId)) st.completedUnits.push(st.unit.nodeId);
      resp.unitDone = true; resp.attemptStage = 'unit-done';
      const nextUnits = _v3NextUnits(st.unit.nodeId);
      resp.branch = { type: 'unit-complete', unitName: st.unit.name, nextUnits, isLast: nextUnits.length === 0 };
    }
  } else {
    // ── 오답 ──
    if (st.strike === 0) {
      // 1차 오답 → 같은 개념·같은 난이도 다른 문항(§9-A 폴백 포함)
      const retryQ = _v3PickQuestion(curConcept, st.currentDifficulty, st.askedQuestionIds);
      if (retryQ) {
        st.strike = 1;
        st.askedQuestionIds.push(retryQ.questionId);
        resp.strike = 1;
        resp.attemptStage = 'retry';
        resp.nextQuestion = retryQ;
        resp.nextConcept = _v3HydrateConcept(curConcept, st.conceptOrder);
      } else {
        // §9-A 3단계: 재출제 생략 → 개념 실패 처리.
        resp.noRetryQuestion = true;
        // [선수 표본 과반 §4.5-(B)] 선수 갈래·표본 진행 중이면 즉시 하향이 아니라 '표본 실패 1'.
        if ((st.branchDepth || 0) > 0 && st.branchSample) {
          return _v3SampleConceptFail(sessionId, session, st, resp, wrongNoteAdded);
        }
        return _v3DownTo(sessionId, session, st, resp, wrongNoteAdded, /*forced*/true);
      }
    } else {
      // 2차 오답 → 개념 실패.
      // [선수 표본 과반 §4.5-(B)] 선수 갈래·표본 진행 중이면 즉시 하향이 아니라 '표본 실패 1' → verdict.
      if ((st.branchDepth || 0) > 0 && st.branchSample) {
        return _v3SampleConceptFail(sessionId, session, st, resp, wrongNoteAdded);
      }
      // 본류(또는 표본 미적용) → 기존 하향(선수 개념)
      return _v3DownTo(sessionId, session, st, resp, wrongNoteAdded, false);
    }
  }

  // 종료 조건 (소프트 — 개념 상한)
  if (!resp.finished && (st.diagnosedConcepts || 0) >= DIAG_V3_CONCEPT_CAP && !resp.nextQuestion) {
    // 상한 도달이지만 다음 문항이 없을 때만 종료 신호 (강제 아님)
  }

  _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
  resp.progress = _v3Progress(session, st);
  return resp;
}

// 문항 없는 개념 skip 후 다음 개념으로 진행 (정답 통과 경로 보조)
function _v3AdvanceAfterSkip(sessionId, session, st, resp, wrongNoteAdded) {
  // visited로 무한루프 방지 — 최대 단원 개념 수만큼만 반복
  const maxIter = st.conceptOrder.length + 2;
  for (let i = 0; i < maxIter; i++) {
    if (_v3IsUnitComplete(st, st.unit.nodeId)) {
      if (!st.completedUnits.includes(st.unit.nodeId)) st.completedUnits.push(st.unit.nodeId);
      resp.unitDone = true; resp.attemptStage = 'unit-done';
      const nextUnits = _v3NextUnits(st.unit.nodeId);
      resp.branch = { type: 'unit-complete', unitName: st.unit.name, nextUnits, isLast: nextUnits.length === 0 };
      _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }
    const nextC = _v3NextConceptInUnit(st);
    if (!nextC) {
      // 더 없음 → 단원 완주 처리
      if (!st.completedUnits.includes(st.unit.nodeId)) st.completedUnits.push(st.unit.nodeId);
      resp.unitDone = true; resp.attemptStage = 'unit-done';
      const nextUnits = _v3NextUnits(st.unit.nodeId);
      resp.branch = { type: 'unit-complete', unitName: st.unit.name, nextUnits, isLast: nextUnits.length === 0 };
      _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }
    st.currentConcept = nextC;
    st.currentDifficulty = _v3StartDifficulty(nextC);
    st.strike = 0;
    if (!st.visitedConcepts.includes(nextC)) st.visitedConcepts.push(nextC);
    const nq = _v3PickQuestion(nextC, st.currentDifficulty, st.askedQuestionIds);
    if (nq) {
      st.askedQuestionIds.push(nq.questionId);
      resp.nextQuestion = nq;
      resp.nextConcept = _v3HydrateConcept(nextC, st.conceptOrder);
      _v3SaveState(sessionId, st, { currentNodeId: nextC, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
      resp.progress = _v3Progress(session, st);
      return resp;
    }
    if (!st.skippedConcepts.includes(nextC)) st.skippedConcepts.push(nextC);
  }
  // 안전망: 종료
  _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, status: 'completed', completed: true, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
  resp.finished = true; resp.sessionComplete = true; resp.attemptStage = 'finished';
  resp.progress = _v3Progress(session, st);
  return resp;
}

// 하향(선수 개념) 진입 — 2-strike 실패 또는 §9-A 강제. 선수 없으면 종료형 branch.
//   [다갈래] 설계서 §4.4-A(본류 2-strike) / §4.4-D(선수 2-strike) 통합.
//   실제 이동은 안 하고(FE 확인 대기) branch만 반환. branch.multi/queueRemaining/autoProceed 포함.
//   §4.4-D: 이미 선수 갈래 안(branchDepth>0)에서 2-strike면 깊이 상한 검사 → 상한 도달 시 더 안 내려가고
//           큐의 다음 갈래로(이 갈래의 더 깊은 선수 enqueue 생략). 미도달 시 선수의 선수 enqueue(BFS).
function _v3DownTo(sessionId, session, st, resp, wrongNoteAdded, forced) {
  st.diagnosedConcepts = (st.diagnosedConcepts || 0) + 1;
  resp.strike = 2;
  resp.attemptStage = 'down';
  // [선수 표본 과반] _v3DownTo는 "확정 하향"만 담당. 표본 라우팅은 submit이 끝냄 → 진입 시 표본 정리.
  st.branchSample = null;

  const inBranch = (st.branchDepth || 0) > 0;
  const depthCapped = inBranch && (st.branchDepth || 0) >= DIAG_V3_DOWN_DEPTH_CAP;

  // 역방향 선수가 아예 없으면 root(더 내려갈 곳 없음). enqueue 전에 판정해 isRoot 정확히.
  const hasBackward = _v3BackwardConcepts(st.currentConcept).length > 0;

  // [라운드방식 2026-06-11] enqueue 분기:
  //   - 본류(!inBranch) 2-strike: 이번이 1라운드 적재 시점 → prereqRound=1로 두고 현재 라운드(prereqQueue)에 적재.
  //   - 갈래 내부(inBranch, 표본 미적용 구세션 등에서 직접 _v3DownTo로 진입): 더 깊은 선수는 다음 라운드로 적립.
  //   §4.4-D 깊이 상한 도달이면 이 갈래의 더 깊은 선수는 enqueue 안 함(이 갈래 포기).
  if (!depthCapped) {
    if (!inBranch) {
      st.prereqRound = 1;                        // 1라운드 시작 — 본류 직접 선수 적재
      _v3EnqueuePrereqs(st, st.currentConcept);
    } else {
      _v3EnqueueNextRound(st, st.currentConcept); // 갈래 내부 발견 선수는 다음 라운드로
    }
  }
  // [라운드방식] dequeue는 현재 라운드(prereqQueue)에서만 — 소진 시 _v3DequeueNextRoundAware가 다음 라운드로 전환.
  const deq = _v3DequeueNextRoundAware(st);
  const next = deq.id;
  if (!next) {
    // root/검사 가능한 선수 없음/모든 라운드 소진 → 종료형. (선수 갈래에서 소진이면 본류 복귀 대신 종료형 안내)
    //   isRoot: 본류 개념이면서 역방향 자체가 없을 때만 true. 그 외(큐 소진)는 isRoot false지만 prereqConcept null.
    resp.branch = { type: 'down', prereqConcept: null, isRoot: (!inBranch && !hasBackward), queueRemaining: 0, multi: false, autoProceed: false };
    delete st._pendingPrereq;
    _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
    resp.progress = _v3Progress(session, st);
    return resp;
  }
  if (deq.newRound) resp.newRound = deq.newRound;   // [라운드방식] FE 후속용 라운드 전환 신호
  // 깊이 상한·갈래 전환을 위해 다음 갈래로 가면 branchDepth 리셋(go-prereq의 _v3MoveIntoPrereq가 prereqRound로 세팅).
  if (depthCapped) st.branchDepth = 0;
  // 다음 검사할 선수 확정(go-prereq에서 동일 개념 사용 — 2회 호출 불일치 방지)
  st._pendingPrereq = next;
  const queueRemaining = st.prereqQueue.length;  // next는 이미 큐에서 빠진 상태(설계서 §4.4: 남은 갈래 수)
  const prereqHydrated = _v3HydrateConcept(next, null);
  resp.branch = {
    type: 'down',
    prereqConcept: prereqHydrated,
    isRoot: false,
    currentConcept: _v3HydrateConcept(st.currentConcept, st.conceptOrder),
    queueRemaining,                       // [신규] 남은 갈래 수
    multi: queueRemaining > 0,            // [신규] 다갈래 여부(남은 큐가 있으면 true)
    autoProceed: (st.downCount || 0) > 0  // [신규] 첫 확인 이후 자동 진행 가능 신호(선수 갈래면 모달없이 go-prereq)
  };
  _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept, wrongAddDelta: wrongNoteAdded ? 1 : 0 });
  resp.progress = _v3Progress(session, st);
  return resp;
}

// v3 분기 모달 선택 후 이동 확정 — 후속 단원 계속 / 하향 선수 개념 진입 / 종료
//   payload: { action: 'continue-next-unit'|'go-prereq'|'finish', unitNodeId? }
function advanceDiagnosisV3(sessionId, payload = {}) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) { const err = new Error('세션 없음'); err.statusCode = 404; throw err; }
  const st = _v3LoadState(session);
  if (!st) { const err = new Error('v3 세션이 아닙니다.'); err.statusCode = 400; throw err; }
  if (session.status === 'completed') return { finished: true, sessionComplete: true };

  const action = payload.action;
  if (action === 'finish') {
    _v3SaveState(sessionId, st, { status: 'completed', completed: true });
    return { finished: true, sessionComplete: true };
  }

  if (action === 'continue-next-unit') {
    const unitNodeId = payload.unitNodeId;
    if (!unitNodeId) { const err = new Error('unitNodeId가 필요합니다.'); err.statusCode = 400; throw err; }
    const unit = db.prepare('SELECT node_id, unit_name, area, grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ? AND node_level=2').get(unitNodeId);
    if (!unit) { const err = new Error('단원을 찾을 수 없습니다.'); err.statusCode = 404; throw err; }
    const conceptsArr = _v3ConceptsOfUnit(unitNodeId);
    if (conceptsArr.length === 0) { const err = new Error('이 단원에 진단할 개념이 없습니다.'); err.statusCode = 422; throw err; }
    const conceptOrder = conceptsArr.map(c => c.nodeId);
    // 첫 문항 보유 개념
    let firstConcept = null, firstQuestion = null, firstDiff = 3;
    const newSkipped = [];
    for (const cid of conceptOrder) {
      const d = _v3StartDifficulty(cid);
      const q = _v3PickQuestion(cid, d, st.askedQuestionIds);
      if (q) { firstConcept = cid; firstQuestion = q; firstDiff = d; break; }
      newSkipped.push(cid);
    }
    if (!firstConcept) { const err = new Error('이 단원의 개념에 등록된 문제가 없습니다.'); err.statusCode = 422; throw err; }

    // 단원 전환 — conceptOrder/unit 갱신, 누적 상태(passed/visited/asked/completedUnits)는 유지
    st.unit = { nodeId: unit.node_id, name: unit.unit_name || '단원', area: unit.area || null, gradeLevel: unit.grade_level || null, grade: unit.grade != null ? unit.grade : null, semester: unit.semester != null ? unit.semester : null };
    st.conceptOrder = conceptOrder;
    st.skippedConcepts = Array.from(new Set([...(st.skippedConcepts || []), ...newSkipped]));
    st.currentConcept = firstConcept;
    st.currentDifficulty = firstDiff;
    st.strike = 0;
    if (!st.visitedConcepts.includes(firstConcept)) st.visitedConcepts.push(firstConcept);
    st.askedQuestionIds.push(firstQuestion.questionId);
    _v3SaveState(sessionId, st, { currentNodeId: firstConcept });
    const scope = _v3PanelScope(st);
    return {
      unit: { nodeId: unit.node_id, name: unit.unit_name || '단원', area: unit.area || null, gradeLevel: unit.grade_level || null, grade: unit.grade != null ? unit.grade : null, semester: unit.semester != null ? unit.semester : null, conceptTotal: conceptOrder.length },
      concept: _v3HydrateConcept(firstConcept, conceptOrder),
      question: firstQuestion,
      unitList: getV3Units(session.user_id, { schoolLevel: scope.schoolLevel, grade: scope.grade, area: scope.area }),
      progress: _v3Progress(session, st)
    };
  }

  if (action === 'go-prereq') {
    // [다갈래] submit 때 정한 _pendingPrereq 우선(일관성) → 없으면 큐에서 dequeue.
    let prereq = st._pendingPrereq;
    delete st._pendingPrereq;
    if (!prereq || st.visitedConcepts.includes(prereq) || st.passedConcepts.includes(prereq)) {
      // [라운드방식 2026-06-11] _pendingPrereq 누락·소진 폴백 — 라운드 인식 dequeue(현재 라운드 소진 시 다음 라운드).
      prereq = _v3DequeueNextRoundAware(st).id;
    }
    if (!prereq) {
      _v3SaveState(sessionId, st, { status: 'completed', completed: true });
      return { finished: true, sessionComplete: true, isRoot: true };
    }
    // 선수 개념으로 실제 이동(부모 단원 전환·downCount++·branchDepth=라운드번호·출제) — _v3MoveIntoPrereq
    const q = _v3MoveIntoPrereq(st, prereq);
    if (!q) {
      // 선수 개념도 문항 없음 → skip 후 큐의 다음 갈래 시도(라운드 인식)
      if (!st.skippedConcepts.includes(prereq)) st.skippedConcepts.push(prereq);
      const next2 = _v3DequeueNextRoundAware(st).id;
      if (!next2) {
        _v3SaveState(sessionId, st, { status: 'completed', completed: true });
        return { finished: true, sessionComplete: true };
      }
      const q2 = _v3MoveIntoPrereq(st, next2);
      if (!q2) {
        _v3SaveState(sessionId, st, { status: 'completed', completed: true });
        return { finished: true, sessionComplete: true };
      }
      _v3SaveState(sessionId, st, { currentNodeId: st.currentConcept });
      const scope2 = _v3PanelScope(st);
      return {
        unit: { nodeId: st.unit.nodeId, name: st.unit.name, area: st.unit.area, gradeLevel: st.unit.gradeLevel || null, grade: st.unit.grade != null ? st.unit.grade : null, semester: st.unit.semester != null ? st.unit.semester : null, conceptTotal: st.conceptOrder.length },
        concept: _v3HydrateConcept(st.currentConcept, st.conceptOrder),
        question: q2,
        unitList: getV3Units(session.user_id, { schoolLevel: scope2.schoolLevel, grade: scope2.grade, area: scope2.area }),
        progress: _v3Progress(session, st)
      };
    }
    const prereqId = st.currentConcept;
    _v3SaveState(sessionId, st, { currentNodeId: prereqId });
    // 패널 스코프는 최초 선택 학교급/학년 유지(하향으로 단원이 타 학년으로 가도 동일). 현재 진단 단원은 FE에서 강조.
    const scope = _v3PanelScope(st);
    return {
      unit: { nodeId: st.unit.nodeId, name: st.unit.name, area: st.unit.area, gradeLevel: st.unit.gradeLevel || null, grade: st.unit.grade != null ? st.unit.grade : null, semester: st.unit.semester != null ? st.unit.semester : null, conceptTotal: st.conceptOrder.length },
      concept: _v3HydrateConcept(prereqId, st.conceptOrder),
      question: q,
      unitList: getV3Units(session.user_id, { schoolLevel: scope.schoolLevel, grade: scope.grade, area: scope.area }),
      progress: _v3Progress(session, st)
    };
  }

  const err = new Error('알 수 없는 action입니다.'); err.statusCode = 400; throw err;
}

// v3 완료 — 세션 마감 + 결과 집계 (현재 수준·시작점, 단원 현황)
function finishDiagnosisV3(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const st = _v3LoadState(session);
  if (session.status !== 'completed') {
    db.prepare(`UPDATE diagnosis_sessions SET status='completed', completed_at=CURRENT_TIMESTAMP, result=? WHERE id = ?`)
      .run(_v3ResultEnum(session), sessionId);
  }
  // [2026-06-09] 진단 완료 즉시 추천학습 경로 영속 (v2 finishDiagnosis와 동일 패턴, 실패해도 finish는 성공)
  try {
    buildRecommendedPath(sessionId);
  } catch (e) {
    console.error('[finishDiagnosisV3] buildRecommendedPath 실패:', e.message);
  }
  return getDiagnosisResultV3(sessionId);
}

function _v3ResultEnum(session) {
  const total = session.total_questions || 0;
  const correct = session.correct_count || 0;
  const rate = total > 0 ? correct / total : 0;
  if (rate < 0.4) return 'needs_review';
  if (rate < 0.7) return 'developing';
  if (rate < 0.9) return 'proficient';
  return 'mastered';
}

// v3 결과 — summary + 단원 현황 + 추천 시작점 (기획서 §8)
function getDiagnosisResultV3(sessionId) {
  const session = db.prepare('SELECT * FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const st = _v3LoadState(session);
  if (!st) {
    // v3 아님 — 기존 결과로 폴백
    return getDiagnosisResult(sessionId);
  }

  // L-2: 실제로 "응시(채점된 문항 존재)"한 개념 집합 — diagnosis_answers 에 행이 있는 node_id.
  //   1문항 출제만 되고 미응답한 개념은 여기 포함되지 않음 → 단원 KPI 과다 집계 방지.
  const respondedConcepts = new Set(
    db.prepare('SELECT DISTINCT node_id FROM diagnosis_answers WHERE session_id = ?').all(sessionId).map(r => r.node_id)
  );

  // 진단한 단원 집합 (방문/통과 개념의 부모 단원) — 표시용(현황 리스트)
  const touchedUnits = new Set([st.unit.nodeId, ...st.completedUnits]);
  for (const cid of st.visitedConcepts) {
    const p = db.prepare('SELECT parent_node_id FROM learning_map_nodes WHERE node_id = ? AND node_level=3').get(cid);
    if (p && p.parent_node_id) touchedUnits.add(p.parent_node_id);
  }
  const units = [];
  for (const uid of touchedUnits) {
    const u = db.prepare('SELECT node_id, unit_name FROM learning_map_nodes WHERE node_id = ? AND node_level=2').get(uid);
    if (!u) continue;
    const concepts = _v3ConceptsOfUnit(uid).map(c => c.nodeId);
    const need = concepts.filter(id => !st.skippedConcepts.includes(id));
    const passed = need.filter(id => st.passedConcepts.includes(id)).length;
    const completed = st.completedUnits.includes(uid) || (need.length > 0 && passed === need.length);
    // L-2: 이 단원에서 실제 응시(채점된 문항)·통과가 있었는지 — KPI 카운트 기준
    const responded = completed || passed > 0 || concepts.some(id => respondedConcepts.has(id));
    units.push({
      nodeId: uid, name: u.unit_name || '단원',
      conceptTotal: need.length, passed, responded,
      status: completed ? 'completed' : (passed > 0 ? 'in_progress' : 'untested')
    });
  }

  // 추천 시작점 = [다갈래 §6.2-A] 가장 근본(최저 _gradeAbs) 미통과 개념 1개.
  //   본류·하향 모두 검사한 개념(conceptOrder + visitedConcepts) 중 미통과·미skip을 근본도 오름차순으로 정렬해 최저 선택.
  //   학습은 "가장 기초부터" 시작이 정석 → 경로 STEP1도 그 단원이 선두(_buildRecommendedPathV3가 startUnitId 선두 고정).
  let recommendedStartNode = null;
  const candPool = [];
  const seenCand = new Set();
  for (const id of [...(st.conceptOrder || []), ...(st.visitedConcepts || [])]) {
    if (!id || seenCand.has(id)) continue;
    seenCand.add(id);
    if (st.passedConcepts.includes(id) || st.skippedConcepts.includes(id)) continue;
    candPool.push(id);
  }
  let target = null;
  if (candPool.length > 0) {
    candPool.sort((a, b) => (_gradeAbsOf(a) - _gradeAbsOf(b)) || (_sortOrderOf(a) - _sortOrderOf(b)));
    target = candPool[0];
  } else {
    // 폴백(전부 통과/skip): conceptOrder 첫 미통과(기존 동작 보존)
    target = st.conceptOrder.find(id => !st.passedConcepts.includes(id));
  }
  if (target) {
    const n = db.prepare('SELECT node_id, lesson_name, unit_name, area FROM learning_map_nodes WHERE node_id = ?').get(target);
    if (n) recommendedStartNode = { nodeId: n.node_id, name: n.lesson_name || n.unit_name || '개념', area: n.area || null };
  }
  // 현재 수준: 마지막 통과 개념
  let lastPassedNode = null;
  if (st.passedConcepts.length > 0) {
    const lp = st.passedConcepts[st.passedConcepts.length - 1];
    const n = db.prepare('SELECT node_id, lesson_name, unit_name FROM learning_map_nodes WHERE node_id = ?').get(lp);
    if (n) lastPassedNode = { nodeId: n.node_id, name: n.lesson_name || n.unit_name || '개념' };
  }

  const diagnosedConcepts = st.diagnosedConcepts || 0;
  const passedConcepts = st.passedConcepts.length;
  const reviewConcepts = Math.max(0, diagnosedConcepts - passedConcepts);
  // L-2: "진단 단원" KPI = 실제 응시(채점된 문항)·통과한 단원만 카운트 (1문항 미응답 단원 제외)
  const diagnosedUnits = units.filter(u => u.responded).length;
  const wrongNoteAdded = db.prepare('SELECT COALESCE(diag_wrong_added,0) AS n FROM diagnosis_sessions WHERE id = ?').get(sessionId)?.n || 0;

  return {
    summary: {
      diagnosedConcepts, passedConcepts, reviewConcepts, diagnosedUnits,
      elapsedSec: _diagElapsedSec(session)
    },
    units,
    lastPassedNode,
    recommendedStartNode,
    wrongNoteAdded
  };
}

// M-2: 진행중(in_progress) v3 진단 세션 조회 — FE "이어서 풀기" 배너 복원용.
//   가장 최근 in_progress concept-v3 세션 1건을 재개에 필요한 정보와 함께 반환. 없으면 null.
function getActiveDiagnosisV3(userId) {
  const rows = db.prepare(`
    SELECT id, difficulty_path, started_at, total_questions, correct_count, target_node_id
    FROM diagnosis_sessions
    WHERE user_id = ? AND diagnosis_type = 'concept-v3' AND status = 'in_progress'
    ORDER BY id DESC LIMIT 10
  `).all(userId);
  for (const row of rows) {
    let st = null;
    try { st = JSON.parse(row.difficulty_path || 'null'); } catch { st = null; }
    if (!st || !st.v3) continue;            // v3 상태가 유효한 세션만
    const scope = _v3PanelScope(st);
    const prog = _v3UnitProgress(st);
    const conceptHydrated = st.currentConcept ? _v3HydrateConcept(st.currentConcept, st.conceptOrder) : null;
    return {
      sessionId: row.id,
      unit: st.unit ? {
        nodeId: st.unit.nodeId, name: st.unit.name || '단원', area: st.unit.area || null,
        conceptTotal: Array.isArray(st.conceptOrder) ? st.conceptOrder.length : 0
      } : null,
      currentConcept: conceptHydrated,
      schoolLevel: scope.schoolLevel,
      grade: scope.grade,
      area: scope.area,
      progress: {
        diagnosedConcepts: st.diagnosedConcepts || 0,
        unitPassed: prog.passed,
        unitTotal: prog.total,
        diagPlan: _v3BuildDiagPlan(st)   // 재개 시에도 진행 계획 동기화(다갈래면 done/current/pending)
      },
      totalQuestions: row.total_questions || 0,
      correctCount: row.correct_count || 0,
      startedAt: row.started_at
    };
  }
  return null;
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
  // 진단검사 v3 — 개념(차시) 단위 순차 진단 (기획서 진단검사_v3_기획서.md)
  getV3Units, getV3Grades, getV3Areas,
  startDiagnosisV3, getNextDiagnosisV3, submitDiagnosisV3,
  advanceDiagnosisV3, finishDiagnosisV3, getDiagnosisResultV3, getActiveDiagnosisV3,
  generateLearningPath, getCurrentPath, completeNode, evaluateNodeCompletion, inferNodeIdFromContent,
  // 추천학습 경로 시스템 (2026-05-27)
  buildRecommendedPath, listRecommendedPaths, getRecommendedPathBySession,
  getRecommendedPathCurrent,
  updateRecommendedPathProgress, addRecommendedPathToLearningList,
  getLearningDashboard, getRanking,
  getWrongNotesExtended, getWrongNoteDashboard, getTeacherWrongNoteDashboard,
  addManualWrongNote, updateWrongNoteTags, retryWrongNote,
  // 오답노트 "다시 풀기" 플레이어 (원본 복구 + 묶음 + 일괄채점)
  getWrongNoteQuestion, getWrongNotesByExam, retryWrongNoteBatch,
  getProblemSets, createProblemSet, getProblemSetDetail,
  addProblemSetItem, removeProblemSetItem, startProblemSet, submitProblemSet,
  // P0 추가
  recordProblemAttempt, recordVideoProgress,
  // 결함 A: 자기주도 풀이 성취기준코드 해석 헬퍼 (테스트/재사용)
  resolveAchievementForAttempt,
  getLearningList, addLearningList, removeLearningList,
  getLastActivity, reportContent,
  // 정답 판정 헬퍼 (테스트/외부 사용)
  judgeQuestionAnswer, resolveCorrectAnswerText,
  // 시청형 콘텐츠 점수 가드 (테스트/재사용)
  normalizeProgressScore
};
