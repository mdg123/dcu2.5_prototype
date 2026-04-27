const db = require('./index');
const { v4: uuidv4 } = require('uuid');

function createExam(classId, ownerId, data) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO exams (id, class_id, title, description, pdf_file, answers, question_count, status, owner_id, time_limit, subject_code, grade_group, achievement_code, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, classId, data.title, data.description || null, data.pdf_file || null,
    JSON.stringify(data.answers || data.questions || []),
    data.question_count || (data.questions ? data.questions.length : 0),
    data.status || 'waiting', ownerId, data.time_limit || null,
    data.subject_code || null, data.grade_group || null, data.achievement_code || null,
    data.start_date || null, data.end_date || null);
  if (Array.isArray(data.std_ids) && data.std_ids.length > 0) {
    setExamStdIds(id, data.std_ids);
  }
  return getExamById(id);
}

function setExamStdIds(examId, stdIds) {
  const ids = Array.from(new Set((stdIds || []).filter(Boolean).map(String)));
  const tx = db.transaction((eid, list) => {
    db.prepare('DELETE FROM exam_content_nodes WHERE exam_id = ?').run(eid);
    const ins = db.prepare('INSERT OR IGNORE INTO exam_content_nodes (exam_id, std_id) VALUES (?, ?)');
    for (const sid of list) ins.run(eid, sid);
  });
  tx(examId, ids);
}

function getExamStdIds(examId) {
  return db.prepare('SELECT std_id FROM exam_content_nodes WHERE exam_id = ? ORDER BY created_at').all(examId).map(r => r.std_id);
}

function getExamById(id) {
  const exam = db.prepare(`
    SELECT e.*, u.display_name as author_name,
           (SELECT COUNT(*) FROM exam_students WHERE exam_id = e.id) as student_count
    FROM exams e JOIN users u ON e.owner_id = u.id
    WHERE e.id = ?
  `).get(id);
  if (!exam) return null;
  try { exam.questions = JSON.parse(exam.answers || '[]'); } catch { exam.questions = []; }
  exam.std_ids = getExamStdIds(id);
  return exam;
}

function getExamsByClass(classId, { status, page = 1, limit = 20, std_ids } = {}) {
  let where = 'WHERE e.class_id = ?';
  const params = [classId];
  if (status) { where += ' AND e.status = ?'; params.push(status); }

  const stdList = Array.isArray(std_ids) ? std_ids.filter(Boolean) : [];
  if (stdList.length > 0) {
    const ph = stdList.map(() => '?').join(',');
    where += ` AND e.id IN (
      SELECT ecn.exam_id FROM exam_content_nodes ecn
      WHERE ecn.std_id IN (${ph})
         OR ecn.std_id IN (SELECT descendant_id FROM curriculum_node_descendants WHERE ancestor_id IN (${ph}))
    )`;
    params.push(...stdList, ...stdList);
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM exams e ${where}`).get(...params).cnt;
  const exams = db.prepare(`
    SELECT e.id, e.class_id, e.title, e.question_count, e.status, e.owner_id,
           e.time_limit, e.created_at, e.started_at, e.ended_at,
           e.start_date, e.end_date,
           u.display_name as author_name,
           (SELECT COUNT(*) FROM exam_students WHERE exam_id = e.id) as student_count
    FROM exams e JOIN users u ON e.owner_id = u.id
    ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  return { exams, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateExam(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['title', 'description', 'pdf_file', 'question_count', 'status', 'time_limit', 'start_date', 'end_date', 'started_at', 'start_mode', 'tab_detection', 'allow_retry'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
    if (key === 'answers' || key === 'questions') {
      fields.push('answers = ?');
      params.push(JSON.stringify(val));
      if (Array.isArray(val)) { fields.push('question_count = ?'); params.push(val.length); }
    }
    if (key === 'status' && val === 'active' && !data.started_at) { fields.push('started_at = CURRENT_TIMESTAMP'); }
    if (key === 'status' && val === 'ended') { fields.push('ended_at = CURRENT_TIMESTAMP'); }
  }
  if (fields.length === 0) {
    if (Array.isArray(data.std_ids)) setExamStdIds(id, data.std_ids);
    return getExamById(id);
  }
  params.push(id);
  db.prepare(`UPDATE exams SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  if (Array.isArray(data.std_ids)) setExamStdIds(id, data.std_ids);
  return getExamById(id);
}

function deleteExam(id) {
  db.prepare('DELETE FROM exams WHERE id = ?').run(id);
}

// 학생 시험 참여
function startExam(examId, userId) {
  try {
    db.prepare(`
      INSERT INTO exam_students (exam_id, user_id, status, joined_at)
      VALUES (?, ?, 'in_progress', CURRENT_TIMESTAMP)
    `).run(examId, userId);
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) return { success: false, already: true };
    throw e;
  }
}

function submitExam(examId, userId, answers, score) {
  db.prepare(`
    UPDATE exam_students SET answers = ?, score = ?, status = 'submitted',
    submitted_at = CURRENT_TIMESTAMP WHERE exam_id = ? AND user_id = ?
  `).run(JSON.stringify(answers), score, examId, userId);
}

function getStudentExam(examId, userId) {
  const row = db.prepare(
    'SELECT * FROM exam_students WHERE exam_id = ? AND user_id = ?'
  ).get(examId, userId);
  if (row && row.answers) {
    try { row.answers = JSON.parse(row.answers); } catch { row.answers = []; }
  }
  return row || null;
}

function getExamStudents(examId) {
  return db.prepare(`
    SELECT es.*, u.display_name, u.username
    FROM exam_students es JOIN users u ON es.user_id = u.id
    WHERE es.exam_id = ?
    ORDER BY es.submitted_at
  `).all(examId).map(r => {
    try { r.answers = JSON.parse(r.answers || '[]'); } catch { r.answers = []; }
    return r;
  });
}

function recordTabLeave(examId, userId) {
  db.prepare(`
    UPDATE exam_students SET tab_switch_count = tab_switch_count + 1, current_focus = 0
    WHERE exam_id = ? AND user_id = ?
  `).run(examId, userId);
}

function updateLeaveTime(examId, userId, seconds) {
  db.prepare(`
    UPDATE exam_students SET total_leave_time = total_leave_time + ?, current_focus = 1
    WHERE exam_id = ? AND user_id = ?
  `).run(seconds, examId, userId);
}

module.exports = {
  createExam, getExamById, getExamsByClass, updateExam, deleteExam,
  setExamStdIds, getExamStdIds,
  startExam, submitExam, getStudentExam, getExamStudents,
  recordTabLeave, updateLeaveTime
};
