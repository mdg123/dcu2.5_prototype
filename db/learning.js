const db = require('./index');

// ========== 오늘의 학습 ==========

function getTodayLearning(userId) {
  const today = new Date().toISOString().slice(0, 10);
  let record = db.prepare('SELECT * FROM daily_learning WHERE user_id = ? AND learning_date = ?').get(userId, today);
  if (!record) {
    db.prepare('INSERT INTO daily_learning (user_id, learning_date, goals) VALUES (?, ?, ?)').run(userId, today, '[]');
    record = db.prepare('SELECT * FROM daily_learning WHERE user_id = ? AND learning_date = ?').get(userId, today);
  }
  if (record.goals) { try { record.goals = JSON.parse(record.goals); } catch { record.goals = []; } }
  return record;
}

function updateTodayLearning(userId, data) {
  const today = new Date().toISOString().slice(0, 10);
  getTodayLearning(userId); // ensure exists
  const fields = [];
  const params = [];
  if (data.goals !== undefined) { fields.push('goals = ?'); params.push(JSON.stringify(data.goals)); }
  if (data.progress_percent !== undefined) { fields.push('progress_percent = ?'); params.push(data.progress_percent); }
  if (data.actual_time_minutes !== undefined) { fields.push('actual_time_minutes = ?'); params.push(data.actual_time_minutes); }
  if (fields.length === 0) return getTodayLearning(userId);
  fields.push("updated_at = CURRENT_TIMESTAMP");
  params.push(userId, today);
  db.prepare(`UPDATE daily_learning SET ${fields.join(', ')} WHERE user_id = ? AND learning_date = ?`).run(...params);
  return getTodayLearning(userId);
}

function getLearningHistory(userId, days = 7) {
  return db.prepare(`
    SELECT * FROM daily_learning WHERE user_id = ? ORDER BY learning_date DESC LIMIT ?
  `).all(userId, days);
}

// ========== 오답노트 ==========

function getWrongAnswers(userId, { subject, page = 1, limit = 20, resolved } = {}) {
  let where = ' WHERE student_id = ?';
  const params = [userId];
  if (subject) { where += ' AND subject = ?'; params.push(subject); }
  if (resolved !== undefined) { where += ' AND is_resolved = ?'; params.push(resolved ? 1 : 0); }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM wrong_answers' + where).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const items = db.prepare('SELECT * FROM wrong_answers' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, limit, (page - 1) * limit);
  return { items, total, totalPages };
}

function addWrongAnswer(userId, data) {
  const info = db.prepare(`
    INSERT INTO wrong_answers (student_id, exam_id, question_number, question_text, student_answer, correct_answer, explanation, subject)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, data.exam_id || null, data.question_number || null, data.question_text || null,
    data.student_answer || null, data.correct_answer || null, data.explanation || null, data.subject || null);
  return db.prepare('SELECT * FROM wrong_answers WHERE id = ?').get(info.lastInsertRowid);
}

function resolveWrongAnswer(id, userId) {
  db.prepare('UPDATE wrong_answers SET is_resolved = 1 WHERE id = ? AND student_id = ?').run(id, userId);
  return db.prepare('SELECT * FROM wrong_answers WHERE id = ?').get(id);
}

function getWrongAnswerStats(userId) {
  const total = db.prepare("SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ?").get(userId).cnt;
  const resolved = db.prepare("SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ? AND is_resolved = 1").get(userId).cnt;
  const bySubject = db.prepare(`
    SELECT subject, COUNT(*) as cnt, SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved
    FROM wrong_answers WHERE student_id = ? AND subject IS NOT NULL GROUP BY subject
  `).all(userId);
  return { total, resolved, unresolved: total - resolved, bySubject };
}

// ========== 학습맵 ==========

function getLearningMapNodes({ subject, level } = {}) {
  let where = '';
  const params = [];
  if (subject) { where += (where ? ' AND' : ' WHERE') + ' subject = ?'; params.push(subject); }
  if (level) { where += (where ? ' AND' : ' WHERE') + ' level = ?'; params.push(level); }
  return db.prepare('SELECT * FROM learning_map_nodes' + where + ' ORDER BY subject, topic, level').all(...params);
}

function getNodeProgress(userId, nodeId) {
  return db.prepare('SELECT * FROM learning_map_progress WHERE user_id = ? AND node_id = ?').get(userId, nodeId);
}

function getUserMapProgress(userId) {
  return db.prepare(`
    SELECT lmp.*, lmn.subject, lmn.topic, lmn.subtopic, lmn.level
    FROM learning_map_progress lmp
    JOIN learning_map_nodes lmn ON lmp.node_id = lmn.id
    WHERE lmp.user_id = ?
    ORDER BY lmn.subject, lmn.topic
  `).all(userId);
}

function updateNodeProgress(userId, nodeId, data) {
  const existing = getNodeProgress(userId, nodeId);
  if (!existing) {
    db.prepare(`INSERT INTO learning_map_progress (user_id, node_id, status, progress_percent, started_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(userId, nodeId, data.status || 'in_progress', data.progress_percent || 0);
  } else {
    const fields = [];
    const params = [];
    if (data.status) { fields.push('status = ?'); params.push(data.status); }
    if (data.progress_percent !== undefined) { fields.push('progress_percent = ?'); params.push(data.progress_percent); }
    if (data.status === 'completed') { fields.push('completed_at = CURRENT_TIMESTAMP'); }
    fields.push('attempts = attempts + 1');
    params.push(userId, nodeId);
    db.prepare(`UPDATE learning_map_progress SET ${fields.join(', ')} WHERE user_id = ? AND node_id = ?`).run(...params);
  }
  return getNodeProgress(userId, nodeId);
}

// ========== 학습 목표 ==========

function getLearningGoals(userId) {
  return db.prepare('SELECT * FROM learning_goals WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function createLearningGoal(userId, data) {
  const info = db.prepare('INSERT INTO learning_goals (user_id, title, description, start_date, end_date) VALUES (?, ?, ?, ?, ?)')
    .run(userId, data.title, data.description || null, data.start_date || null, data.end_date || null);
  return db.prepare('SELECT * FROM learning_goals WHERE id = ?').get(info.lastInsertRowid);
}

function updateLearningGoal(id, userId, data) {
  if (data.status === 'completed') {
    db.prepare('UPDATE learning_goals SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run('completed', id, userId);
  } else if (data.status) {
    db.prepare('UPDATE learning_goals SET status = ? WHERE id = ? AND user_id = ?').run(data.status, id, userId);
  }
  return db.prepare('SELECT * FROM learning_goals WHERE id = ?').get(id);
}

// ========== 교사 학습 배포 ==========

function createDailyAssignment(classId, teacherId, data) {
  const info = db.prepare(`
    INSERT INTO daily_assignments (class_id, teacher_id, title, description, goals, assign_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(classId, teacherId, data.title, data.description || null,
    data.goals ? JSON.stringify(data.goals) : '[]',
    data.assign_date || new Date().toISOString().slice(0, 10),
    data.status || 'active');

  const assignment = db.prepare('SELECT * FROM daily_assignments WHERE id = ?').get(info.lastInsertRowid);

  // 클래스 학생들에게 오늘의 학습 자동 배포
  if (assignment.status === 'active') {
    const members = db.prepare(`
      SELECT user_id FROM class_members WHERE class_id = ? AND role = 'student' AND status = 'active'
    `).all(classId);

    for (const m of members) {
      const today = assignment.assign_date;
      const existing = db.prepare('SELECT id FROM daily_learning WHERE user_id = ? AND learning_date = ?').get(m.user_id, today);
      const goals = data.goals || [];
      if (existing) {
        db.prepare('UPDATE daily_learning SET goals = ? WHERE id = ?').run(JSON.stringify(goals), existing.id);
      } else {
        db.prepare('INSERT INTO daily_learning (user_id, learning_date, goals) VALUES (?, ?, ?)').run(m.user_id, today, JSON.stringify(goals));
      }
    }
  }

  return assignment;
}

function getClassAssignments(classId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM daily_assignments WHERE class_id = ?').get(classId).cnt;
  const items = db.prepare(`
    SELECT da.*, u.display_name AS teacher_name
    FROM daily_assignments da JOIN users u ON da.teacher_id = u.id
    WHERE da.class_id = ? ORDER BY da.assign_date DESC LIMIT ? OFFSET ?
  `).all(classId, limit, (page - 1) * limit);
  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

module.exports = {
  getTodayLearning, updateTodayLearning, getLearningHistory,
  getWrongAnswers, addWrongAnswer, resolveWrongAnswer, getWrongAnswerStats,
  getLearningMapNodes, getNodeProgress, getUserMapProgress, updateNodeProgress,
  getLearningGoals, createLearningGoal, updateLearningGoal,
  createDailyAssignment, getClassAssignments
};
