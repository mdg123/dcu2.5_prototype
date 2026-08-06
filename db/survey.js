const db = require('./index');
// 학생 모집단 SSOT — 분모·명단은 손 SQL 로 다시 적지 말 것 (db/class.js 주석 참조)
const { studentPopulationSql } = require('./class');

// questions JSON 을 방어적으로 배열로 파싱한다.
//  - 정상: '[{...},{...}]' → 배열
//  - 이중 인코딩(손상): '"[{...}]"' (JSON.parse 하면 문자열) → 한 번 더 unwrap 시도
//  - 그 외 손상/비배열 → [] (question_count 0)
// 감사가 survey id=2 에서 "236문항" 이상치를 본 원인 = 이중 인코딩된 문자열의 .length 를 셌기 때문.
function parseQuestions(raw) {
  if (raw == null) return [];
  let v = raw;
  try {
    for (let i = 0; i < 2; i++) {          // 최대 2회 파싱(이중 인코딩까지 unwrap)
      if (Array.isArray(v)) return v;
      if (typeof v !== 'string') return [];
      v = JSON.parse(v);
    }
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// 문항 수(FE 가 소비하는 필드명 = question_count). 파싱 실패/비배열 시 0.
function countQuestions(raw) {
  return parseQuestions(raw).length;
}

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
  s.questions = parseQuestions(s.questions);   // 방어적 파싱(이중 인코딩 unwrap 포함)
  s.question_count = s.questions.length;
  return s;
}

function getSurveysByClass(classId, { status, page = 1, limit = 20, userId = null } = {}) {
  let where = 'WHERE s.class_id = ?';
  const params = [classId];
  if (status) { where += ' AND s.status = ?'; params.push(status); }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM surveys s ${where}`).get(...params).cnt;
  // 본인 응답 정보 (학생/멤버 본인 표시용)
  const myRespondedSelect = userId
    ? `, (SELECT sr.id FROM survey_responses sr WHERE sr.survey_id = s.id AND sr.user_id = ${Number(userId)} LIMIT 1) as my_response,
         (SELECT sr.submitted_at FROM survey_responses sr WHERE sr.survey_id = s.id AND sr.user_id = ${Number(userId)} LIMIT 1) as my_responded_at`
    : '';
  const surveys = db.prepare(`
    SELECT s.id, s.class_id, s.author_id, s.title, s.description, s.status,
           s.start_date, s.end_date, s.is_anonymous, s.created_at, s.questions,
           u.display_name as author_name,
           (SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id) as response_count,
           -- 응답률의 분모·분자는 모두 학생 모집단 SSOT. 손 SQL 시절엔 u.role 을 안 봐서
           -- 학부모·교직원·삭제 계정이 "응답 대상"으로 잡혔다(실측 class 1: 분모 10, 정본 7).
           (SELECT COUNT(DISTINCT sr.user_id) FROM survey_responses sr
             JOIN class_members cm ON cm.user_id = sr.user_id AND cm.class_id = s.class_id
             JOIN users su ON su.id = cm.user_id
             WHERE sr.survey_id = s.id
               AND ${studentPopulationSql('cm', 'su')}) as respondent_count,
           (SELECT COUNT(*) FROM class_members cm2 JOIN users su2 ON su2.id = cm2.user_id
             WHERE cm2.class_id = s.class_id
               AND ${studentPopulationSql('cm2', 'su2')}) as member_count
           ${myRespondedSelect}
    FROM surveys s JOIN users u ON s.author_id = u.id
    ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit)
    .map(s => {
      // FE(class-home.html)가 소비하는 문항 수 필드. 방어적 파싱(손상 JSON → 0).
      s.question_count = countQuestions(s.questions);
      delete s.questions;   // 목록 페이로드에 원본 questions 블롭은 내보내지 않음(count 만 소비)
      return s;
    });
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

// isAnonymous=true 이면 응답자 신원 필드(user_id/display_name/username)를 제거해 반환한다.
// 응답 내용(answers)·제출시각·점수 등 집계에 필요한 필드는 유지 → 통계엔 지장 없음.
function getResponses(surveyId, isAnonymous = false) {
  return db.prepare(`
    SELECT sr.*, u.display_name, u.username
    FROM survey_responses sr JOIN users u ON sr.user_id = u.id
    WHERE sr.survey_id = ? ORDER BY sr.submitted_at
  `).all(surveyId).map(r => {
    try { r.answers = JSON.parse(r.answers || '[]'); } catch { r.answers = []; }
    if (isAnonymous) {
      delete r.user_id;
      delete r.display_name;
      delete r.username;
    }
    return r;
  });
}

module.exports = {
  createSurvey, getSurveyById, getSurveysByClass, updateSurvey, deleteSurvey,
  submitResponse, getResponse, getResponses
};
