const db = require('./index');

function createLesson(classId, teacherId, data) {
  const info = db.prepare(`
    INSERT INTO lessons (class_id, teacher_id, title, description, content, lesson_date, start_date, end_date, estimated_minutes, lesson_order, status, subject_code, grade_group, achievement_code, school_level, tags, theme, classify_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(classId, teacherId, data.title, data.description || null, data.content || null,
    data.lesson_date || null, data.start_date || null, data.end_date || null,
    data.estimated_minutes || 0, data.lesson_order || null, data.status || 'draft',
    data.subject_code || null, data.grade_group || null, data.achievement_code || null,
    data.school_level || null, data.tags || null, data.theme || null, data.classify_mode || 'curriculum');
  const lessonId = info.lastInsertRowid;
  if (Array.isArray(data.std_ids) && data.std_ids.length > 0) {
    setLessonStdIds(lessonId, data.std_ids);
  }
  return getLessonById(lessonId);
}

function setLessonStdIds(lessonId, stdIds) {
  const ids = Array.from(new Set((stdIds || []).filter(Boolean).map(String)));
  const tx = db.transaction((lid, list) => {
    db.prepare('DELETE FROM lesson_content_nodes WHERE lesson_id = ?').run(lid);
    const ins = db.prepare('INSERT OR IGNORE INTO lesson_content_nodes (lesson_id, std_id) VALUES (?, ?)');
    for (const sid of list) ins.run(lid, sid);
  });
  tx(lessonId, ids);
}

function getLessonStdIds(lessonId) {
  return db.prepare('SELECT std_id FROM lesson_content_nodes WHERE lesson_id = ? ORDER BY created_at').all(lessonId).map(r => r.std_id);
}

function getLessonById(id) {
  return db.prepare(`
    SELECT l.*, u.display_name as author_name
    FROM lessons l JOIN users u ON l.teacher_id = u.id
    WHERE l.id = ?
  `).get(id) || null;
}

function getLessonsByClass(classId, { status, page = 1, limit = 20, std_ids } = {}) {
  let where = 'WHERE l.class_id = ?';
  const params = [classId];
  if (status) { where += ' AND l.status = ?'; params.push(status); }

  // std_ids 필터 (closure table 활용: 상위 노드 선택 시 자손 std도 매칭)
  const stdList = Array.isArray(std_ids) ? std_ids.filter(Boolean) : [];
  if (stdList.length > 0) {
    const ph = stdList.map(() => '?').join(',');
    where += ` AND l.id IN (
      SELECT lcn.lesson_id FROM lesson_content_nodes lcn
      WHERE lcn.std_id IN (${ph})
         OR lcn.std_id IN (SELECT descendant_id FROM curriculum_node_descendants WHERE ancestor_id IN (${ph}))
    )`;
    params.push(...stdList, ...stdList);
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM lessons l ${where}`).get(...params).cnt;
  const lessons = db.prepare(`
    SELECT l.*, u.display_name as author_name
    FROM lessons l JOIN users u ON l.teacher_id = u.id
    ${where} ORDER BY l.lesson_date DESC, l.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  return { lessons, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateLesson(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['title', 'description', 'content', 'lesson_date', 'start_date', 'end_date', 'estimated_minutes', 'lesson_order', 'status', 'subject_code', 'grade_group', 'achievement_code', 'school_level', 'tags', 'theme', 'classify_mode'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return getLessonById(id);
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.prepare(`UPDATE lessons SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getLessonById(id);
}

function deleteLesson(id) {
  db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
}

function addAttachment(lessonId, data) {
  const info = db.prepare(`
    INSERT INTO lesson_attachments (lesson_id, file_name, file_url, file_size, file_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(lessonId, data.file_name, data.file_url, data.file_size || 0, data.file_type || null);
  return info.lastInsertRowid;
}

function getAttachments(lessonId) {
  return db.prepare('SELECT * FROM lesson_attachments WHERE lesson_id = ?').all(lessonId);
}

// 수업에 콘텐츠 연결
function addContentToLesson(lessonId, contentId, sortOrder = 0) {
  try {
    db.prepare('INSERT INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?, ?, ?)').run(lessonId, contentId, sortOrder);
    return true;
  } catch (e) {
    if (e.message.includes('UNIQUE')) return false;
    throw e;
  }
}

function removeContentFromLesson(lessonId, contentId) {
  return db.prepare('DELETE FROM lesson_contents WHERE lesson_id = ? AND content_id = ?').run(lessonId, contentId).changes > 0;
}

function getLessonContents(lessonId) {
  const contents = db.prepare(`
    SELECT c.*, lc.sort_order, u.display_name as creator_name
    FROM lesson_contents lc
    JOIN contents c ON lc.content_id = c.id
    JOIN users u ON c.creator_id = u.id
    WHERE lc.lesson_id = ?
    ORDER BY lc.sort_order ASC
  `).all(lessonId);
  // quiz/exam 유형에 문항 데이터 포함
  contents.forEach(c => {
    if (c.content_type === 'quiz' || c.content_type === 'exam') {
      try {
        c.questions = db.prepare('SELECT * FROM content_questions WHERE content_id = ? ORDER BY question_number').all(c.id);
        c.questions.forEach(q => { if (q.options) try { q.options = JSON.parse(q.options); } catch {} });
      } catch { c.questions = []; }
    }
  });
  return contents;
}

// 학생의 수업 콘텐츠 진도 기록
function getContentProgress(userId, contentId, lessonId) {
  return db.prepare('SELECT * FROM content_progress WHERE user_id = ? AND content_id = ? AND lesson_id = ?').get(userId, contentId, lessonId || null) || null;
}

function updateContentProgress(userId, contentId, lessonId, { progress_percent, completed, last_position }) {
  const existing = db.prepare('SELECT id FROM content_progress WHERE user_id = ? AND content_id = ? AND lesson_id = ?').get(userId, contentId, lessonId || null);
  if (existing) {
    const sets = ['updated_at = CURRENT_TIMESTAMP'];
    const params = [];
    if (progress_percent !== undefined) { sets.push('progress_percent = ?'); params.push(progress_percent); }
    if (completed !== undefined) { sets.push('completed = ?'); params.push(completed ? 1 : 0); if (completed) sets.push('completed_at = CURRENT_TIMESTAMP'); }
    if (last_position !== undefined) { sets.push('last_position = ?'); params.push(last_position); }
    params.push(existing.id);
    db.prepare(`UPDATE content_progress SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } else {
    db.prepare('INSERT INTO content_progress (user_id, content_id, lesson_id, progress_percent, completed, last_position) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId, contentId, lessonId || null, progress_percent || 0, completed ? 1 : 0, last_position || null
    );
  }
}

function getLessonProgress(userId, lessonId) {
  return db.prepare(`
    SELECT cp.*, c.title as content_title
    FROM content_progress cp
    JOIN contents c ON cp.content_id = c.id
    WHERE cp.user_id = ? AND cp.lesson_id = ?
  `).all(userId, lessonId);
}

// 특정 수업의 특정 사용자 이수율 계산
function getLessonCompletionRate(lessonId, userId) {
  const totalContents = db.prepare('SELECT COUNT(*) as cnt FROM lesson_contents WHERE lesson_id = ?').get(lessonId).cnt;
  if (totalContents === 0) return 0;
  const completedContents = db.prepare(
    'SELECT COUNT(*) as cnt FROM content_progress WHERE lesson_id = ? AND user_id = ? AND completed = 1'
  ).get(lessonId, userId).cnt;
  return Math.round((completedContents / totalContents) * 100);
}

// 클래스 전체 이수율 (특정 사용자 기준)
function getClassCompletionStats(classId, userId) {
  // 공개된 수업의 총 콘텐츠 수
  const totalResult = db.prepare(`
    SELECT COUNT(lc.id) as cnt
    FROM lesson_contents lc
    JOIN lessons l ON lc.lesson_id = l.id
    WHERE l.class_id = ? AND l.status = 'published'
  `).get(classId);
  const totalContents = totalResult.cnt;
  if (totalContents === 0) return 0;

  const completedResult = db.prepare(`
    SELECT COUNT(cp.id) as cnt
    FROM content_progress cp
    JOIN lesson_contents lc ON cp.lesson_id = lc.lesson_id AND cp.content_id = lc.content_id
    JOIN lessons l ON lc.lesson_id = l.id
    WHERE l.class_id = ? AND cp.user_id = ? AND cp.completed = 1 AND l.status = 'published'
  `).get(classId, userId);

  return Math.round((completedResult.cnt / totalContents) * 100);
}

// 수업 목록에 각 수업별 이수율 포함하여 반환
function getLessonsByClassWithProgress(classId, userId, { status, page = 1, limit = 20, std_ids } = {}) {
  const result = getLessonsByClass(classId, { status, page, limit, std_ids });
  result.lessons.forEach(l => { try { l.std_ids = getLessonStdIds(l.id); } catch { l.std_ids = []; } });
  result.lessons = result.lessons.map(lesson => {
    const totalContents = db.prepare('SELECT COUNT(*) as cnt FROM lesson_contents WHERE lesson_id = ?').get(lesson.id).cnt;
    let completedContents = 0;
    let completionRate = 0;
    if (totalContents > 0) {
      completedContents = db.prepare(
        'SELECT COUNT(*) as cnt FROM content_progress WHERE lesson_id = ? AND user_id = ? AND completed = 1'
      ).get(lesson.id, userId).cnt;
      completionRate = Math.round((completedContents / totalContents) * 100);
    }
    // 콘텐츠 타입 목록
    const contentTypes = db.prepare(`
      SELECT DISTINCT c.content_type FROM lesson_contents lc
      JOIN contents c ON lc.content_id = c.id
      WHERE lc.lesson_id = ?
    `).all(lesson.id).map(r => r.content_type);
    return {
      ...lesson,
      completion_rate: completionRate,
      content_count: totalContents,
      my_completed: completedContents,
      my_total: totalContents,
      content_types: contentTypes
    };
  });
  return result;
}

// 수업 게시판용 통계
function getLessonBoardStats(classId) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM lessons WHERE class_id = ?').get(classId).cnt;
  const active = db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE class_id = ? AND status = 'published'").get(classId).cnt;
  const scheduled = db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE class_id = ? AND status = 'scheduled'").get(classId).cnt;
  const draft = db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE class_id = ? AND status = 'draft'").get(classId).cnt;
  const archived = db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE class_id = ? AND status = 'archived'").get(classId).cnt;
  const totalMinutes = db.prepare('SELECT COALESCE(SUM(estimated_minutes), 0) as mins FROM lessons WHERE class_id = ?').get(classId).mins;
  return { total, active, scheduled, draft, archived, totalMinutes };
}

// 수업별 이수율 + 콘텐츠 타입 + 이수 인원
function getLessonBoardList(classId, { status, search, sort = 'latest', page = 1, limit = 20, userId } = {}) {
  let where = 'WHERE l.class_id = ?';
  const params = [classId];
  if (status && status !== 'all') {
    if (status === 'active') { where += " AND l.status = 'published'"; }
    else if (status === 'completed') { where += " AND l.status = 'archived'"; }
    else if (status === 'scheduled') { where += " AND l.status = 'scheduled'"; }
    else if (status === 'draft') { where += " AND l.status = 'draft'"; }
    else { where += ' AND l.status = ?'; params.push(status); }
  }
  if (search) { where += ' AND l.title LIKE ?'; params.push('%' + search + '%'); }

  let orderBy = 'ORDER BY l.created_at DESC';
  if (sort === 'name') orderBy = 'ORDER BY l.title ASC';
  else if (sort === 'order') orderBy = 'ORDER BY l.lesson_order ASC, l.created_at DESC';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM lessons l ${where}`).get(...params).cnt;
  const lessons = db.prepare(`
    SELECT l.*, u.display_name as author_name
    FROM lessons l JOIN users u ON l.teacher_id = u.id
    ${where} ${orderBy} LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  // 클래스 전체 멤버 수
  const memberCount = db.prepare('SELECT COUNT(*) as cnt FROM class_members WHERE class_id = ?').get(classId).cnt;

  // 각 수업에 추가 정보 부여
  const enriched = lessons.map(lesson => {
    // 콘텐츠 수 & 타입 목록
    const contents = db.prepare(`
      SELECT c.content_type FROM lesson_contents lc
      JOIN contents c ON lc.content_id = c.id
      WHERE lc.lesson_id = ?
    `).all(lesson.id);
    const contentTypes = [...new Set(contents.map(c => c.content_type))];
    const contentCount = contents.length;

    // 이수 완료 학생 수 (모든 콘텐츠를 완료한 학생)
    let completedStudents = 0;
    if (contentCount > 0) {
      const result = db.prepare(`
        SELECT COUNT(DISTINCT cp.user_id) as cnt
        FROM content_progress cp
        WHERE cp.lesson_id = ? AND cp.completed = 1
      `).get(lesson.id);
      completedStudents = result.cnt;
    }

    // 평균 이수율 (전체 학생 기준)
    let avgCompletionRate = 0;
    if (contentCount > 0 && memberCount > 0) {
      avgCompletionRate = Math.round((completedStudents / memberCount) * 100);
    }

    // 요청한 사용자의 개인 이수 현황
    let myCompleted = 0;
    if (userId && contentCount > 0) {
      const myRes = db.prepare(`
        SELECT COUNT(*) as cnt FROM content_progress
        WHERE lesson_id = ? AND user_id = ? AND completed = 1
      `).get(lesson.id, userId);
      myCompleted = myRes.cnt;
    }

    return {
      ...lesson,
      content_count: contentCount,
      content_types: contentTypes,
      completed_students: completedStudents,
      member_count: memberCount,
      avg_completion_rate: avgCompletionRate,
      my_completed: myCompleted,
      my_total: contentCount
    };
  });

  return { lessons: enriched, total, totalPages: Math.ceil(total / limit) || 1 };
}

// 특정 수업의 모든 학생별 이수 현황
function getLessonStudentProgress(lessonId, classId) {
  // 클래스 멤버 (학생만)
  const members = db.prepare(`
    SELECT cm.user_id, u.display_name, u.username
    FROM class_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.role = 'member'
    ORDER BY u.display_name
  `).all(classId);

  // 수업 콘텐츠 수
  const totalContents = db.prepare('SELECT COUNT(*) as cnt FROM lesson_contents WHERE lesson_id = ?').get(lessonId).cnt;

  // 각 학생별 이수 현황
  return members.map(m => {
    let completedCount = 0;
    let lastActivity = null;
    if (totalContents > 0) {
      const result = db.prepare(
        'SELECT COUNT(*) as cnt, MAX(completed_at) as last_at FROM content_progress WHERE lesson_id = ? AND user_id = ? AND completed = 1'
      ).get(lessonId, m.user_id);
      completedCount = result.cnt;
      lastActivity = result.last_at;
    }
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      username: m.username,
      completed_count: completedCount,
      total_count: totalContents,
      rate: totalContents > 0 ? Math.round((completedCount / totalContents) * 100) : 0,
      is_complete: completedCount >= totalContents && totalContents > 0,
      last_activity: lastActivity
    };
  });
}

module.exports = {
  createLesson, getLessonById, getLessonsByClass, updateLesson, deleteLesson,
  addAttachment, getAttachments,
  addContentToLesson, removeContentFromLesson, getLessonContents,
  setLessonStdIds, getLessonStdIds,
  getContentProgress, updateContentProgress, getLessonProgress,
  getLessonCompletionRate, getClassCompletionStats, getLessonsByClassWithProgress,
  getLessonBoardStats, getLessonBoardList, getLessonStudentProgress
};
