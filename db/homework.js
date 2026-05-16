const db = require('./index');

// display_mode 화이트리스트
const DISPLAY_MODE_VALUES = ['list', 'comment'];
function _normalizeDisplayMode(v) {
  return DISPLAY_MODE_VALUES.includes(v) ? v : 'list';
}

function createHomework(classId, teacherId, data) {
  // G3: 교사 첨부 자료 (JSON 배열) — 안전 직렬화
  const attachmentsJson = Array.isArray(data.attachments)
    ? JSON.stringify(data.attachments)
    : (typeof data.attachments === 'string' && data.attachments.trim() ? data.attachments : null);
  // G5: start_date 'YYYY-MM-DD'
  const startDate = data.start_date ? String(data.start_date).slice(0, 10) : null;
  // 표시 모드 — 화이트리스트 외 값은 'list'로 폴백
  const displayMode = _normalizeDisplayMode(data.display_mode);

  const info = db.prepare(`
    INSERT INTO homework (class_id, teacher_id, title, description, content, due_date, max_score, status, subject_code, grade_group, achievement_code, public_submissions, start_date, attachments, display_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(classId, teacherId, data.title, data.description || null, data.content || null,
    data.due_date || null, data.max_score || 100, data.status || 'published',
    data.subject_code || null, data.grade_group || null, data.achievement_code || null,
    data.public_submissions ? 1 : 0,
    startDate, attachmentsJson, displayMode);
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
    (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id AND COALESCE(is_draft,0) = 0) as submission_count
    FROM homework h JOIN users u ON h.teacher_id = u.id
    WHERE h.id = ?
  `).get(id);
  if (!hw) return null;
  hw.std_ids = getHomeworkStdIds(id);
  // G3: attachments JSON parse (안전)
  hw.attachments = parseJsonArray(hw.attachments);
  // 표시 모드 정규화 — NULL/빈값/잘못된 값은 'list'로
  hw.display_mode = _normalizeDisplayMode(hw.display_mode);
  return hw;
}

// 내부 유틸: JSON 배열 안전 파싱
function parseJsonArray(text) {
  if (!text) return [];
  if (Array.isArray(text)) return text;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function getHomeworkByClass(classId, { status, page = 1, limit = 20, userId = null, std_ids, hideScheduled = false } = {}) {
  let where = 'WHERE h.class_id = ?';
  const params = [classId];
  if (status) { where += ' AND h.status = ?'; params.push(status); }

  // G5: 예약 과제 — 학생/일반 사용자에게는 시작일이 지난 항목만 노출
  // hideScheduled = true 일 때 (today ≥ start_date OR start_date IS NULL)
  if (hideScheduled) {
    where += " AND (h.start_date IS NULL OR h.start_date <= date('now', '+9 hours'))";
  }

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
    ? `, (SELECT hs.id FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ${Number(userId)} AND COALESCE(hs.is_draft,0) = 0) as my_submission
       , (SELECT hs.submitted_at FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ${Number(userId)} AND COALESCE(hs.is_draft,0) = 0) as my_submitted_at
       , (SELECT hs.status FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ${Number(userId)} AND COALESCE(hs.is_draft,0) = 0) as my_submission_status
       , (SELECT hs.score FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ${Number(userId)} AND COALESCE(hs.is_draft,0) = 0) as my_score`
    : '';
  const list = db.prepare(`
    SELECT h.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id AND COALESCE(is_draft,0) = 0) as submission_count,
    (SELECT COUNT(DISTINCT hs.student_id) FROM homework_submissions hs
      JOIN class_members cm ON cm.user_id = hs.student_id
                           AND cm.class_id = h.class_id
                           AND cm.role = 'member'
                           AND cm.status = 'active'
      WHERE hs.homework_id = h.id AND COALESCE(hs.is_draft,0) = 0) as submitted_count,
    (SELECT COUNT(DISTINCT hs.student_id) FROM homework_submissions hs
      JOIN class_members cm ON cm.user_id = hs.student_id
                           AND cm.class_id = h.class_id
                           AND cm.role = 'member'
                           AND cm.status = 'active'
      WHERE hs.homework_id = h.id AND COALESCE(hs.is_draft,0) = 0 AND hs.status = 'graded') as graded_count,
    (SELECT COUNT(*) FROM class_members cm2 WHERE cm2.class_id = h.class_id AND cm2.role = 'member' AND cm2.status = 'active') as member_count
    ${mySubSelect}
    FROM homework h JOIN users u ON h.teacher_id = u.id
    ${where} ORDER BY h.due_date DESC, h.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  // G3: 각 항목의 attachments JSON parse + G5: is_scheduled 플래그
  const todayKst = (() => {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().slice(0, 10);
  })();
  for (const h of list) {
    h.attachments = parseJsonArray(h.attachments);
    h.is_scheduled = !!(h.start_date && h.start_date > todayKst);
    // 표시 모드 정규화 — NULL/빈값/잘못된 값은 'list'로
    h.display_mode = _normalizeDisplayMode(h.display_mode);
  }

  return { homework: list, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateHomework(id, data) {
  const fields = [];
  const params = [];
  // G3/G5: attachments, start_date 컬럼 화이트리스트 추가 + display_mode
  const allowed = ['title', 'description', 'content', 'due_date', 'max_score', 'status',
                   'subject_code', 'grade_group', 'achievement_code', 'public_submissions',
                   'start_date', 'attachments', 'display_mode'];
  for (const [key, val] of Object.entries(data)) {
    if (!allowed.includes(key)) continue;
    fields.push(`${key} = ?`);
    if (key === 'public_submissions') {
      params.push(val ? 1 : 0);
    } else if (key === 'attachments') {
      // JSON 배열 또는 이미 직렬화된 문자열 허용. null/undefined → NULL
      if (Array.isArray(val)) params.push(JSON.stringify(val));
      else if (typeof val === 'string' && val.trim()) params.push(val);
      else params.push(null);
    } else if (key === 'start_date') {
      params.push(val ? String(val).slice(0, 10) : null);
    } else if (key === 'display_mode') {
      // 화이트리스트 외 값은 'list'로 폴백
      params.push(_normalizeDisplayMode(val));
    } else {
      params.push(val);
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
  // G2: attachments JSON 배열 (멀티미디어 통합)
  const attachmentsJson = Array.isArray(data.attachments) ? JSON.stringify(data.attachments) : null;
  try {
    db.prepare(`
      INSERT INTO homework_submissions
        (homework_id, student_id, content, file_path, file_name, attachments,
         is_draft, draft_content, draft_attachments, draft_updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 'submitted')
    `).run(homeworkId, studentId, data.content || null,
           data.file_path || null, data.file_name || null,
           attachmentsJson);
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      // G1: 정식 제출 시 임시저장 컬럼 정리
      db.prepare(`
        UPDATE homework_submissions
           SET content = ?, file_path = ?, file_name = ?, attachments = ?,
               is_draft = 0, draft_content = NULL, draft_attachments = NULL, draft_updated_at = NULL,
               submitted_at = CURRENT_TIMESTAMP,
               status = CASE WHEN status = 'graded' THEN 'resubmitted'
                             WHEN status = 'submitted' THEN 'resubmitted'
                             ELSE 'submitted' END
        WHERE homework_id = ? AND student_id = ?
      `).run(data.content || null, data.file_path || null, data.file_name || null,
             attachmentsJson, homeworkId, studentId);
      return { success: true, updated: true };
    }
    throw e;
  }
}

// G1: 임시저장 (학생 전용)
function saveDraft(homeworkId, studentId, data) {
  const draftContent = (typeof data.content === 'string') ? data.content : null;
  const draftAttachmentsJson = Array.isArray(data.attachments) ? JSON.stringify(data.attachments) : null;
  // 한국시간 ISO 문자열
  const nowKst = (() => {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().replace('T', ' ').substring(0, 19);
  })();

  const existing = db.prepare(
    'SELECT id, status FROM homework_submissions WHERE homework_id = ? AND student_id = ?'
  ).get(homeworkId, studentId);

  if (existing) {
    // 정식 제출 컬럼은 보존 — draft 컬럼만 업데이트
    db.prepare(`
      UPDATE homework_submissions
         SET draft_content = ?, draft_attachments = ?, draft_updated_at = ?,
             is_draft = 1
       WHERE homework_id = ? AND student_id = ?
    `).run(draftContent, draftAttachmentsJson, nowKst, homeworkId, studentId);
  } else {
    // 신규 행 — status는 'submitted' (CHECK 통과용 placeholder), is_draft=1로 진실 표시
    // submitted_at NULL 처리 (DEFAULT CURRENT_TIMESTAMP를 NULL로 명시 덮어쓰기)
    db.prepare(`
      INSERT INTO homework_submissions
        (homework_id, student_id, content, file_path, file_name, attachments,
         is_draft, draft_content, draft_attachments, draft_updated_at,
         status, submitted_at)
      VALUES (?, ?, NULL, NULL, NULL, NULL, 1, ?, ?, ?, 'submitted', NULL)
    `).run(homeworkId, studentId, draftContent, draftAttachmentsJson, nowKst);
  }

  return {
    content: draftContent,
    attachments: draftAttachmentsJson ? JSON.parse(draftAttachmentsJson) : [],
    updated_at: nowKst
  };
}

function _decorateSubmission(s) {
  if (!s) return s;
  s.attachments = parseJsonArray(s.attachments);
  s.draft_attachments = parseJsonArray(s.draft_attachments);
  // is_draft NULL → 0
  s.is_draft = s.is_draft ? 1 : 0;
  return s;
}

function getSubmission(homeworkId, studentId) {
  const s = db.prepare(
    'SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ?'
  ).get(homeworkId, studentId) || null;
  return _decorateSubmission(s);
}

function getSubmissionById(submissionId) {
  const s = db.prepare('SELECT * FROM homework_submissions WHERE id = ?').get(submissionId) || null;
  return _decorateSubmission(s);
}

function getSubmissions(homeworkId) {
  // G6: 정식 제출(is_draft=0)만 표시 — 임시저장 행은 학생 본인만 봄
  const rows = db.prepare(`
    SELECT hs.*, u.display_name, u.username
    FROM homework_submissions hs JOIN users u ON hs.student_id = u.id
    WHERE hs.homework_id = ? AND COALESCE(hs.is_draft, 0) = 0
    ORDER BY hs.submitted_at DESC
  `).all(homeworkId);
  return rows.map(_decorateSubmission);
}

// G6: 제출률 통계 — 클래스 전체 학생 수 대비 제출 수
function getSubmissionStats(homeworkId, classId) {
  const submitted_count = db.prepare(`
    SELECT COUNT(*) AS c
      FROM homework_submissions
     WHERE homework_id = ? AND COALESCE(is_draft, 0) = 0
  `).get(homeworkId).c;

  // 'student' 역할의 활성 멤버를 분모로 사용 (교사/관리자 제외)
  const total_students = db.prepare(`
    SELECT COUNT(*) AS c
      FROM class_members cm
      JOIN users u ON cm.user_id = u.id
     WHERE cm.class_id = ? AND cm.status = 'active'
       AND cm.role <> 'owner' AND u.role = 'student'
  `).get(classId).c;

  const percent = total_students > 0
    ? Math.round((submitted_count / total_students) * 1000) / 10  // 소수1자리
    : 0;
  return { total_students, submitted_count, percent };
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
  submitHomework, saveDraft,
  getSubmission, getSubmissionById, getSubmissions, getSubmissionStats,
  gradeSubmission,
  getFeedback, addFeedback
};
