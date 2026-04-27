const db = require('./index');

function createHomework(classId, teacherId, data) {
  const info = db.prepare(`
    INSERT INTO homework (class_id, teacher_id, title, description, content, due_date, max_score, status, subject_code, grade_group, achievement_code, public_submissions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(classId, teacherId, data.title, data.description || null, data.content || null,
    data.due_date || null, data.max_score || 100, data.status || 'published',
    data.subject_code || null, data.grade_group || null, data.achievement_code || null,
    data.public_submissions ? 1 : 0);
  const hwId = info.lastInsertRowid;
  if (Array.isArray(data.std_ids) && data.std_ids.length > 0) {
    setHomeworkStdIds(hwId, data.std_ids);
  }
  return getHomeworkById(hwId);
}

function setHomeworkStdIds(homeworkId, stdIds) {
  const ids = Array.from(new Set((stdIds || []).filter(Boolean).map(String)));
  const tx = db.transaction((hid, list) => {
    db.prepare('DELETE FROM homework_content_nodes WHERE homework_id = ?').run(hid);
    const ins = db.prepare('INSERT OR IGNORE INTO homework_content_nodes (homework_id, std_id) VALUES (?, ?)');
    for (const sid of list) ins.run(hid, sid);
  });
  tx(homeworkId, ids);
}

function getHomeworkStdIds(homeworkId) {
  return db.prepare('SELECT std_id FROM homework_content_nodes WHERE homework_id = ? ORDER BY created_at').all(homeworkId).map(r => r.std_id);
}

function getHomeworkById(id) {
  const hw = db.prepare(`
    SELECT h.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id) as submission_count
    FROM homework h JOIN users u ON h.teacher_id = u.id
    WHERE h.id = ?
  `).get(id);
  if (!hw) return null;
  hw.std_ids = getHomeworkStdIds(id);
  return hw;
}

function getHomeworkByClass(classId, { status, page = 1, limit = 20, userId = null, std_ids } = {}) {
  let where = 'WHERE h.class_id = ?';
  const params = [classId];
  if (status) { where += ' AND h.status = ?'; params.push(status); }

  const stdList = Array.isArray(std_ids) ? std_ids.filter(Boolean) : [];
  if (stdList.length > 0) {
    const ph = stdList.map(() => '?').join(',');
    where += ` AND h.id IN (
      SELECT hcn.homework_id FROM homework_content_nodes hcn
      WHERE hcn.std_id IN (${ph})
         OR hcn.std_id IN (SELECT descendant_id FROM curriculum_node_descendants WHERE ancestor_id IN (${ph}))
    )`;
    params.push(...stdList, ...stdList);
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM homework h ${where}`).get(...params).cnt;
  const mySubSelect = userId
    ? `, (SELECT hs.id FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ${Number(userId)}) as my_submission`
    : '';
  const list = db.prepare(`
    SELECT h.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id) as submission_count
    ${mySubSelect}
    FROM homework h JOIN users u ON h.teacher_id = u.id
    ${where} ORDER BY h.due_date DESC, h.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  return { homework: list, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateHomework(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['title', 'description', 'content', 'due_date', 'max_score', 'status', 'subject_code', 'grade_group', 'achievement_code', 'public_submissions'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(key === 'public_submissions' ? (val ? 1 : 0) : val);
    }
  }
  if (fields.length === 0) {
    if (Array.isArray(data.std_ids)) setHomeworkStdIds(id, data.std_ids);
    return getHomeworkById(id);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.prepare(`UPDATE homework SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  if (Array.isArray(data.std_ids)) setHomeworkStdIds(id, data.std_ids);
  return getHomeworkById(id);
}

function deleteHomework(id) {
  db.prepare('DELETE FROM homework WHERE id = ?').run(id);
}

function submitHomework(homeworkId, studentId, data) {
  try {
    db.prepare(`
      INSERT INTO homework_submissions (homework_id, student_id, content, file_path, file_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(homeworkId, studentId, data.content || null, data.file_path || null, data.file_name || null);
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      db.prepare(`
        UPDATE homework_submissions SET content = ?, file_path = ?, file_name = ?,
        submitted_at = CURRENT_TIMESTAMP, status = 'resubmitted'
        WHERE homework_id = ? AND student_id = ?
      `).run(data.content || null, data.file_path || null, data.file_name || null, homeworkId, studentId);
      return { success: true, updated: true };
    }
    throw e;
  }
}

function getSubmission(homeworkId, studentId) {
  return db.prepare(
    'SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ?'
  ).get(homeworkId, studentId) || null;
}

function getSubmissionById(submissionId) {
  return db.prepare('SELECT * FROM homework_submissions WHERE id = ?').get(submissionId) || null;
}

function getSubmissions(homeworkId) {
  return db.prepare(`
    SELECT hs.*, u.display_name, u.username
    FROM homework_submissions hs JOIN users u ON hs.student_id = u.id
    WHERE hs.homework_id = ?
    ORDER BY hs.submitted_at DESC
  `).all(homeworkId);
}

function gradeSubmission(submissionId, score, feedback) {
  db.prepare(`
    UPDATE homework_submissions SET score = ?, feedback = ?, status = 'graded', graded_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(score, feedback || null, submissionId);
}

// ===== 과제 피드백 (1:1 채팅) =====
function getFeedback(submissionId) {
  return db.prepare(`
    SELECT f.*, u.display_name as author_name, u.username as author_username, u.role as author_role
    FROM homework_feedback f
    JOIN users u ON f.author_id = u.id
    WHERE f.submission_id = ?
    ORDER BY f.created_at ASC
  `).all(submissionId);
}

function addFeedback(submissionId, authorId, content) {
  const info = db.prepare(`
    INSERT INTO homework_feedback (submission_id, author_id, content)
    VALUES (?, ?, ?)
  `).run(submissionId, authorId, content);
  return db.prepare(`
    SELECT f.*, u.display_name as author_name, u.username as author_username, u.role as author_role
    FROM homework_feedback f JOIN users u ON f.author_id = u.id
    WHERE f.id = ?
  `).get(info.lastInsertRowid);
}

module.exports = {
  createHomework, getHomeworkById, getHomeworkByClass, updateHomework, deleteHomework,
  setHomeworkStdIds, getHomeworkStdIds,
  submitHomework, getSubmission, getSubmissionById, getSubmissions, gradeSubmission,
  getFeedback, addFeedback
};
