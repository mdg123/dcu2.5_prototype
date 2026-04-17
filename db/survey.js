const db = require('./index');

function createSurvey(classId, authorId, data) {
  const info = db.prepare(`
    INSERT INTO surveys (class_id, author_id, title, description, questions, status, start_date, end_date, is_anonymous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(classId, authorId, data.title, data.description || null,
    JSON.stringify(data.questions || []),
    data.status || 'draft',
    data.start_date || null, data.end_date || null,
    data.is_anonymous ? 1 : 0);
  return getSurveyById(info.lastInsertRowid);
}

function getSurveyById(id) {
  const s = db.prepare(`
    SELECT s.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id) as response_count
    FROM surveys s JOIN users u ON s.author_id = u.id WHERE s.id = ?
  `).get(id);
  if (!s) return null;
  try { s.questions = JSON.parse(s.questions || '[]'); } catch { s.questions = []; }
  return s;
}

function getSurveysByClass(classId, { status, page = 1, limit = 20 } = {}) {
  let where = 'WHERE s.class_id = ?';
  const params = [classId];
  if (status) { where += ' AND s.status = ?'; params.push(status); }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM surveys s ${where}`).get(...params).cnt;
  const surveys = db.prepare(`
    SELECT s.id, s.class_id, s.author_id, s.title, s.description, s.status,
           s.start_date, s.end_date, s.is_anonymous, s.created_at,
           u.display_name as author_name,
           (SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id) as response_count
    FROM surveys s JOIN users u ON s.author_id = u.id
    ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  return { surveys, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateSurvey(id, data) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(data)) {
    if (['title', 'description', 'status', 'start_date', 'end_date', 'is_anonymous'].includes(k)) {
      fields.push(`${k} = ?`); params.push(v);
    }
    if (k === 'questions') { fields.push('questions = ?'); params.push(JSON.stringify(v)); }
  }
  if (!fields.length) return getSurveyById(id);
  params.push(id);
  db.prepare(`UPDATE surveys SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getSurveyById(id);
}

function deleteSurvey(id) { db.prepare('DELETE FROM surveys WHERE id = ?').run(id); }

function submitResponse(surveyId, userId, answers) {
  try {
    db.prepare(
      'INSERT INTO survey_responses (survey_id, user_id, answers) VALUES (?, ?, ?)'
    ).run(surveyId, userId, JSON.stringify(answers));
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) return { success: false, duplicate: true };
    throw e;
  }
}

function getResponse(surveyId, userId) {
  const r = db.prepare('SELECT * FROM survey_responses WHERE survey_id = ? AND user_id = ?').get(surveyId, userId);
  if (r) { try { r.answers = JSON.parse(r.answers); } catch { r.answers = []; } }
  return r || null;
}

function getResponses(surveyId) {
  return db.prepare(`
    SELECT sr.*, u.display_name, u.username
    FROM survey_responses sr JOIN users u ON sr.user_id = u.id
    WHERE sr.survey_id = ? ORDER BY sr.submitted_at
  `).all(surveyId).map(r => {
    try { r.answers = JSON.parse(r.answers || '[]'); } catch { r.answers = []; }
    return r;
  });
}

module.exports = {
  createSurvey, getSurveyById, getSurveysByClass, updateSurvey, deleteSurvey,
  submitResponse, getResponse, getResponses
};
