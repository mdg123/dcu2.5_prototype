const db = require('./index');
const { v4: uuidv4 } = require('uuid');
// 학생 모집단 SSOT — 분모·명단은 손 SQL 로 다시 적지 말 것 (db/class.js 주석 참조)
const { studentPopulationSql } = require('./class');

// ============================================================
// 콘텐츠 공개정책 2단계 — 평가↔그림자 contents 동기화 헬퍼
// (정책: 직접 만들기(start_mode='direct')로 평가를 만들면
//  내 보관함에 비공개(is_public=0, status='approved')로 그림자 등록.
//  학생은 평가 메뉴에서 즉시 응시 가능.
//  공개콘텐츠/보관함 가져오기 모드는 원본 contents가 이미 있으니 그림자 생성 불필요.)
//
// contents.source = 'exam_<id>' 로 그림자 표시,
// content_type='exam_paper'
// ============================================================
function _examGradeToInt(data) {
  // contents.grade 는 INTEGER. grade_group/school_level 텍스트는 매핑 불가하므로
  // 숫자(또는 '3' 같은 문자열 숫자)만 받아들이고, 그렇지 않으면 NULL 로 저장.
  const raw = data.grade_group || data.school_level || null;
  if (raw === null || raw === undefined) return null;
  const n = parseInt(raw);
  return Number.isFinite(n) ? n : null;
}

function _examShadowInsert(examId, ownerId, data) {
  const linkedSource = `exam_${examId}`;
  // 기존 그림자가 있으면 중복 방지 (이전 백필/이중 호출 대비)
  const existed = db.prepare(
    "SELECT id FROM contents WHERE source = ? AND creator_id = ?"
  ).get(linkedSource, ownerId);
  if (existed) return existed.id;
  const info = db.prepare(`
    INSERT INTO contents
      (creator_id, title, description, content_type, subject, grade,
       is_public, status, source, created_at)
    VALUES (?, ?, ?, 'exam_paper', ?, ?, 0, 'approved', ?, datetime('now'))
  `).run(
    ownerId,
    data.title,
    data.description || null,
    data.subject_code || null,
    _examGradeToInt(data),
    linkedSource
  );
  return info.lastInsertRowid;
}

function _examShadowUpdate(examId, data) {
  const linkedSource = `exam_${examId}`;
  const fields = [];
  const params = [];
  if (data.title !== undefined) { fields.push('title = ?'); params.push(data.title); }
  if (data.description !== undefined) {
    fields.push('description = ?');
    params.push(data.description || null);
  }
  if (data.subject_code !== undefined) { fields.push('subject = ?'); params.push(data.subject_code || null); }
  if (data.grade_group !== undefined || data.school_level !== undefined) {
    fields.push('grade = ?');
    params.push(_examGradeToInt(data));
  }
  if (fields.length === 0) return;
  params.push(linkedSource);
  // 그림자(원본 contents)가 없으면 WHERE 매칭이 0행이라 자동 no-op (가져오기 모드 평가는 영향 없음)
  db.prepare(
    `UPDATE contents SET ${fields.join(', ')} WHERE source = ?`
  ).run(...params);
}

function _examShadowDelete(examId) {
  const linkedSource = `exam_${examId}`;
  // 비공개 그림자(is_public=0)는 함께 삭제
  db.prepare(
    "DELETE FROM contents WHERE source = ? AND is_public = 0"
  ).run(linkedSource);
  // 공개·승인된 그림자(is_public=1)는 다른 사용자 보관함에 있을 수 있어 보존하되 원본 끊기
  db.prepare(
    "UPDATE contents SET source = ? WHERE source = ? AND is_public = 1"
  ).run(`exam_deleted_${examId}`, linkedSource);
}

function createExam(classId, ownerId, data) {
  const id = uuidv4();
  const tx = db.transaction(() => {
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
    // 그림자 contents INSERT — direct 모드(직접 만들기)일 때만 라우터에서 _shadow=true 명시
    // 공개콘텐츠 검색('public')·보관함 가져오기('storage') 모드는 원본 contents가 이미 있으므로 그림자 미생성
    if (data._shadow === true) {
      try {
        _examShadowInsert(id, ownerId, data);
      } catch (e) {
        console.error('[SYNC] exam→content insert', e.message);
        throw e;
      }
    }
  });
  tx();
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
           (SELECT COUNT(*) FROM exam_students WHERE exam_id = e.id) as student_count,
           -- 응시율의 분모·분자는 모두 학생 모집단 SSOT. 손 SQL 시절엔 u.role 을 안 봐서
           -- 학부모·교직원·삭제 계정이 "응시 대상"으로 잡혔다(실측 class 1: 분모 10, 정본 7).
           (SELECT COUNT(DISTINCT es.user_id) FROM exam_students es
             JOIN class_members cm ON cm.user_id = es.user_id AND cm.class_id = e.class_id
             JOIN users eu ON eu.id = cm.user_id
             WHERE es.exam_id = e.id
               AND ${studentPopulationSql('cm', 'eu')}) as participated_count,
           (SELECT COUNT(DISTINCT es.user_id) FROM exam_students es
             JOIN class_members cm ON cm.user_id = es.user_id AND cm.class_id = e.class_id
             JOIN users eu ON eu.id = cm.user_id
             WHERE es.exam_id = e.id
               AND (es.submitted_at IS NOT NULL OR es.status IN ('submitted','graded','completed'))
               AND ${studentPopulationSql('cm', 'eu')}) as submitted_count,
           (SELECT COUNT(*) FROM class_members cm2 JOIN users eu2 ON eu2.id = cm2.user_id
             WHERE cm2.class_id = e.class_id
               AND ${studentPopulationSql('cm2', 'eu2')}) as member_count
    FROM exams e JOIN users u ON e.owner_id = u.id
    ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  return { exams, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateExam(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['title', 'description', 'pdf_file', 'question_count', 'status', 'time_limit', 'start_date', 'end_date', 'started_at', 'start_mode', 'tab_detection', 'allow_retry', 'subject_code', 'grade_group', 'achievement_code'].includes(key)) {
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
    // 메타 변경이 없더라도 그림자 동기화 시도 (subject/grade 만 들어온 경우 등)
    try { _examShadowUpdate(id, data); } catch (e) { console.error('[SYNC] exam→content update', e.message); }
    return getExamById(id);
  }
  const tx = db.transaction(() => {
    params.push(id);
    db.prepare(`UPDATE exams SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    if (Array.isArray(data.std_ids)) setExamStdIds(id, data.std_ids);
    // 그림자 contents 동기화 (제목·설명·교과·학년만 — 그림자가 없으면 WHERE 매칭 0행 → no-op)
    try {
      _examShadowUpdate(id, data);
    } catch (e) {
      console.error('[SYNC] exam→content update', e.message);
      throw e;
    }
  });
  tx();
  return getExamById(id);
}

function deleteExam(id) {
  const tx = db.transaction(() => {
    // 그림자 contents 먼저 정리(비공개는 삭제, 공개·승인은 보존하되 원본 링크 끊기)
    _examShadowDelete(id);
    db.prepare('DELETE FROM exams WHERE id = ?').run(id);
  });
  tx();
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
