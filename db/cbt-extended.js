// db/cbt-extended.js
const db = require('./index');
const crypto = require('crypto');

function importFromContent(contentId, classId, userId, opts = {}) {
  const content = db.prepare('SELECT * FROM contents WHERE id = ?').get(contentId);
  if (!content) return null;

  // 콘텐츠에 연결된 문항 가져오기
  const questions = db.prepare('SELECT * FROM content_questions WHERE content_id = ? ORDER BY question_number').all(contentId);
  let answers;
  let qCount;
  if (questions.length > 0) {
    answers = JSON.stringify(questions.map(q => {
      let options = [];
      try { options = JSON.parse(q.options || '[]'); } catch(e) {}
      return { question: q.question_text || q.question || '', options: options.map(o => typeof o === 'string' ? o : (o.text || o)), answer: q.answer ?? 0, explanation: q.explanation || '' };
    }));
    qCount = questions.length;
  } else {
    answers = JSON.stringify([{ question: content.title, options: ['①', '②', '③', '④'], answer: 0 }]);
    qCount = 1;
  }

  const examId = crypto.randomUUID();
  const title = opts.title || content.title;
  const desc = opts.description || content.description || '';
  const timeLimit = opts.time_limit || null;
  const startDate = opts.start_date || null;
  const endDate = opts.end_date || null;

  db.prepare(`
    INSERT INTO exams (id, class_id, title, description, answers, question_count, status, owner_id, source_content_id, time_limit, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
  `).run(examId, classId || null, title, desc, answers, qCount, userId, contentId, timeLimit, startDate, endDate);

  // std_ids 저장: opts.std_ids 우선, 없으면 원본 content의 std_ids 상속
  let stdIds = Array.isArray(opts.std_ids) ? opts.std_ids : null;
  if (!stdIds) {
    try {
      stdIds = db.prepare('SELECT std_id FROM content_content_nodes WHERE content_id = ?').all(contentId).map(r => r.std_id);
    } catch (e) { stdIds = []; }
  }
  if (stdIds && stdIds.length > 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO exam_content_nodes (exam_id, std_id) VALUES (?, ?)');
    for (const sid of stdIds) { try { ins.run(examId, String(sid)); } catch(e) {} }
  }

  return { examId, title };
}

function exportToContent(examId, userId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return null;

  const info = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, is_public, status)
    VALUES (?, ?, ?, 'assessment', 0, 'approved')
  `).run(userId, exam.title, `평가 문항 ${exam.question_count}개`);

  return { contentId: info.lastInsertRowid };
}

function autoSaveAnswers(examId, userId, answers) {
  db.prepare(`
    INSERT OR REPLACE INTO exam_autosaves (exam_id, user_id, answers, saved_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(examId, userId, JSON.stringify(answers));
  return { success: true };
}

function getAutoSavedAnswers(examId, userId) {
  const row = db.prepare('SELECT * FROM exam_autosaves WHERE exam_id = ? AND user_id = ?').get(examId, userId);
  if (!row) return null;
  row.answers = JSON.parse(row.answers || '[]');
  return row;
}

function delegateAccess(examId, delegatorId, { delegateId, scope }) {
  db.prepare(`
    INSERT OR REPLACE INTO exam_delegates (exam_id, delegator_id, delegate_id, scope)
    VALUES (?, ?, ?, ?)
  `).run(examId, delegatorId, delegateId, scope || 'all');
  return { success: true };
}

function getExamResultsForExport(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return null;

  const students = db.prepare(`
    SELECT es.*, u.display_name, u.grade, u.class_number
    FROM exam_students es JOIN users u ON es.user_id = u.id
    WHERE es.exam_id = ?
    ORDER BY u.display_name
  `).all(examId);

  const questions = JSON.parse(exam.answers || '[]');

  // 내보내기용 배열 생성
  const rows = students.map(s => {
    const studentAnswers = JSON.parse(s.answers || '[]');
    return {
      이름: s.display_name,
      학년: s.grade || '',
      반: s.class_number || '',
      점수: s.score || 0,
      제출시각: s.submitted_at || '',
      이탈횟수: s.tab_switch_count,
      이탈시간_초: s.total_leave_time,
      ...Object.fromEntries(questions.map((q, i) => [`문항${i + 1}`, studentAnswers[i] !== undefined ? studentAnswers[i] : '']))
    };
  });

  return { exam, rows, questions };
}

module.exports = {
  importFromContent, exportToContent,
  autoSaveAnswers, getAutoSavedAnswers,
  delegateAccess, getExamResultsForExport
};
