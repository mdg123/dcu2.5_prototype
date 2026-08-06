const db = require('./index');
// 학생 모집단 SSOT (db/class.js). 이수율 분모·이수 명단은 전부 이것을 경유한다.
//   여기서 SQL 을 따로 적으면 test/class-student-population.test.js INV-P6 이 붉어진다.
const { studentPopulationSql, getClassStudents, getClassStudentIds, getClassStudentCount } = require('./class');

// ============================================================
// 콘텐츠 공개정책 1단계 — 수업↔그림자 contents 동기화 헬퍼
// (routes 사양: contents.source = 'lesson_<id>' 로 그림자 표시,
//  is_public=0, status='approved', content_type='lesson_bundle')
// ============================================================
function _gradeToInt(data) {
  // contents.grade 는 INTEGER. grade_group/school_level 텍스트는 매핑 불가하므로
  // 숫자(또는 '3' 같은 문자열 숫자)만 받아들이고, 그렇지 않으면 NULL 로 저장.
  const raw = data.grade_group || data.school_level || null;
  if (raw === null || raw === undefined) return null;
  const n = parseInt(raw);
  return Number.isFinite(n) ? n : null;
}

function _shadowInsert(lessonId, teacherId, data) {
  const linkedSource = `lesson_${lessonId}`;
  // 기존 그림자가 있으면 중복 방지 (이전 백필/이중 호출 대비)
  const existed = db.prepare(
    "SELECT id FROM contents WHERE source = ? AND creator_id = ?"
  ).get(linkedSource, teacherId);
  if (existed) return existed.id;
  const info = db.prepare(`
    INSERT INTO contents
      (creator_id, title, description, content_type, subject, grade,
       is_public, status, source, created_at)
    VALUES (?, ?, ?, 'lesson_bundle', ?, ?, 0, 'approved', ?, datetime('now'))
  `).run(
    teacherId,
    data.title,
    data.description || data.content || null,
    data.subject_code || null,
    _gradeToInt(data),
    linkedSource
  );
  return info.lastInsertRowid;
}

function _shadowUpdate(lessonId, data) {
  const linkedSource = `lesson_${lessonId}`;
  const fields = [];
  const params = [];
  if (data.title !== undefined) { fields.push('title = ?'); params.push(data.title); }
  if (data.description !== undefined || data.content !== undefined) {
    fields.push('description = ?');
    params.push(data.description !== undefined ? data.description : (data.content || null));
  }
  if (data.subject_code !== undefined) { fields.push('subject = ?'); params.push(data.subject_code || null); }
  if (data.grade_group !== undefined || data.school_level !== undefined) {
    fields.push('grade = ?');
    params.push(_gradeToInt(data));
  }
  if (fields.length === 0) return;
  params.push(linkedSource);
  db.prepare(
    `UPDATE contents SET ${fields.join(', ')} WHERE source = ?`
  ).run(...params);
}

function _shadowDelete(lessonId) {
  const linkedSource = `lesson_${lessonId}`;
  // 비공개 그림자(is_public=0)는 함께 삭제
  db.prepare(
    "DELETE FROM contents WHERE source = ? AND is_public = 0"
  ).run(linkedSource);
  // 공개·승인된 그림자(is_public=1)는 다른 사용자 보관함에 있을 수 있어 보존하되 원본 끊기
  db.prepare(
    "UPDATE contents SET source = ? WHERE source = ? AND is_public = 1"
  ).run(`lesson_deleted_${lessonId}`, linkedSource);
}

function createLesson(classId, teacherId, data) {
  // 1단계 정책: 사용자가 명시적으로 'draft'를 지정하지 않으면 기본 'published'
  // (비공개여도 클래스 학생에게 즉시 노출되어야 한다는 정책 반영)
  const status = data.status || 'published';
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO lessons (class_id, teacher_id, title, description, content, lesson_date, start_date, end_date, estimated_minutes, lesson_order, status, subject_code, grade_group, achievement_code, school_level, tags, theme, classify_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(classId, teacherId, data.title, data.description || null, data.content || null,
      data.lesson_date || null, data.start_date || null, data.end_date || null,
      data.estimated_minutes || 0, data.lesson_order || null, status,
      data.subject_code || null, data.grade_group || null, data.achievement_code || null,
      data.school_level || null, data.tags || null, data.theme || null, data.classify_mode || 'curriculum');
    const lessonId = info.lastInsertRowid;
    if (Array.isArray(data.std_ids) && data.std_ids.length > 0) {
      setLessonStdIds(lessonId, data.std_ids);
    }
    // 그림자 contents INSERT (실패 시 트랜잭션 롤백)
    _shadowInsert(lessonId, teacherId, data);
    return lessonId;
  });
  const lessonId = tx();
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
    ${where} ORDER BY (l.lesson_date IS NULL) ASC, l.lesson_date DESC, l.created_at DESC LIMIT ? OFFSET ?
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
  const tx = db.transaction(() => {
    const sets = fields.slice();
    const ps = params.slice();
    sets.push('updated_at = CURRENT_TIMESTAMP');
    ps.push(id);
    db.prepare(`UPDATE lessons SET ${sets.join(', ')} WHERE id = ?`).run(...ps);
    // 그림자 contents 동기화 (제목·설명·교과·학년만, is_public/status는 마켓플레이스 흐름 독립)
    try {
      _shadowUpdate(id, data);
    } catch (e) {
      console.error('[SYNC] lesson→content update', e.message);
      throw e;
    }
  });
  tx();
  return getLessonById(id);
}

function deleteLesson(id) {
  const tx = db.transaction(() => {
    // 그림자 contents 먼저 정리(비공개는 삭제, 공개·승인은 보존하되 원본 링크 끊기)
    _shadowDelete(id);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
  });
  tx();
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

// 클래스 평균 이수율 (교사·개설자 홈 탭 활동 도넛)
// ── [P1-B / W1-T1-4] 2026-08-06 ────────────────────────────────────────────
//   routes/lesson.js 가 getClassMembers().filter(m => m.role === 'member') 로
//   손계산하고 있었다 → 학부모·교직원·삭제 계정이 분모에 들어가 라이브 class 1 에서
//   분모 10(도넛) vs 8(수업 탭) vs 7(정답) 세 벌이 한 화면에 공존했다.
//   평균의 모집단은 db/class.js 학생 SSOT 하나뿐이다.
// @returns {number} 0~100 정수. 학생이 없으면 0.
function getClassAverageCompletionRate(classId) {
  const ids = getClassStudentIds(classId);
  if (ids.length === 0) return 0;
  const sum = ids.reduce((acc, uid) => acc + getClassCompletionStats(classId, uid), 0);
  return Math.round(sum / ids.length);
}

// 수업 목록에 각 수업별 이수율 포함하여 반환
function getLessonsByClassWithProgress(classId, userId, { status, page = 1, limit = 20, std_ids } = {}) {
  const result = getLessonsByClass(classId, { status, page, limit, std_ids });
  result.lessons.forEach(l => { try { l.std_ids = getLessonStdIds(l.id); } catch { l.std_ids = []; } });
  // 클래스 학생 수 — 정본 분모는 db/class.js SSOT 하나뿐 (모든 lesson 공통값).
  const memberCount = getClassStudentCount(classId);
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
    // 이수 인원 = 수업의 **모든** 콘텐츠를 완료한 학생 수 (학생 모집단 SSOT 한정).
    //   콘텐츠가 0개면 0명.
    let completedStudents = 0;
    if (totalContents > 0 && memberCount > 0) {
      const row = db.prepare(`
        SELECT COUNT(*) as cnt FROM (
          SELECT cp.user_id
            FROM content_progress cp
            JOIN class_members cm ON cm.user_id = cp.user_id AND cm.class_id = ?
            JOIN users cu ON cu.id = cm.user_id
            JOIN lesson_contents lc ON lc.lesson_id = cp.lesson_id
                                    AND lc.content_id = cp.content_id
           WHERE cp.lesson_id = ?
             AND cp.completed = 1
             AND ${studentPopulationSql('cm', 'cu')}
           GROUP BY cp.user_id
          HAVING COUNT(DISTINCT cp.content_id) >= ?
        )
      `).get(classId, lesson.id, totalContents);
      completedStudents = row ? row.cnt : 0;
    }
    return {
      ...lesson,
      completion_rate: completionRate,
      content_count: totalContents,
      my_completed: completedContents,
      my_total: totalContents,
      content_types: contentTypes,
      completed_students: completedStudents,
      member_count: memberCount
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

  // 클래스 학생 수 — 정본 분모는 db/class.js SSOT 하나뿐.
  const memberCount = getClassStudentCount(classId);

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

    // 이수 완료 학생 수 = 수업의 **모든** 콘텐츠를 완료한 학생 (학생 모집단 SSOT 한정).
    //
    // ── [P1-B / W1-T1-3] 2026-08-06 라벨↔산식 불일치 수정 ─────────────────────
    //   주석은 "모든 콘텐츠를 완료한 학생"인데 SQL 은
    //     COUNT(DISTINCT cp.user_id) WHERE cp.lesson_id=? AND cp.completed=1
    //   이라 **1개라도 완료하면 이수**로 셌다. 콘텐츠 2개 수업에서 student1 이 1개만
    //   완료한 상태에서 교사 화면은 "8명 중 1명 이수", 같은 교사의 학생별 이수 현황표는
    //   전원 is_complete=false(student1 은 1/2) — 두 곳이 정면으로 모순됐다.
    //   getLessonsByClassWithProgress 는 이미 HAVING >= totalContents 였으므로
    //   같은 파일 안에서도 두 벌이었다. 여기를 정답 산식으로 통일한다.
    let completedStudents = 0;
    if (contentCount > 0) {
      const result = db.prepare(`
        SELECT COUNT(*) as cnt FROM (
          SELECT cp.user_id
            FROM content_progress cp
            JOIN class_members cm ON cm.user_id = cp.user_id AND cm.class_id = ?
            JOIN users u ON u.id = cm.user_id
            JOIN lesson_contents lc ON lc.lesson_id = cp.lesson_id
                                    AND lc.content_id = cp.content_id
           WHERE cp.lesson_id = ?
             AND cp.completed = 1
             AND ${studentPopulationSql('cm', 'u')}
           GROUP BY cp.user_id
          HAVING COUNT(DISTINCT cp.content_id) >= ?
        )
      `).get(classId, lesson.id, contentCount);
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
  // 클래스 학생 명단 — db/class.js SSOT.
  //   owner·co_teacher·parent·staff·removed·삭제계정 제외 → 이수 명단에 살아있는 학생만.
  //   (삭제 계정의 실명이 교사 이수 현황표에 남아 있던 W1-T1-9 도 여기서 함께 닫힌다)
  const members = getClassStudents(classId);

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

// ============ 수업 셀프체크 (이해도·집중도) — RFP SFR-019 ============

// 24시간 (ms) — 응답 수정 가능 윈도우
const SELF_CHECK_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function getSelfCheck(lessonId, userId) {
  return db.prepare(
    'SELECT * FROM lesson_self_check WHERE lesson_id = ? AND user_id = ?'
  ).get(lessonId, userId) || null;
}

function getSelfChecksByLesson(lessonId) {
  return db.prepare(`
    SELECT lsc.*, u.display_name, u.username
    FROM lesson_self_check lsc
    JOIN users u ON lsc.user_id = u.id
    WHERE lsc.lesson_id = ?
    ORDER BY lsc.created_at DESC
  `).all(lessonId);
}

/**
 * 셀프체크 UPSERT
 * - 최초: INSERT, mode='created'
 * - 24시간 이내(created_at 기준): UPDATE, mode='updated'
 * - 24시간 초과: throw Error('EDIT_WINDOW_EXPIRED')
 */
function upsertSelfCheck({ lessonId, userId, classId, understanding, focus, comment }) {
  const existing = getSelfCheck(lessonId, userId);
  if (existing) {
    // created_at은 SQLite의 CURRENT_TIMESTAMP(UTC) 문자열로 저장됨 → 'Z' 보정
    const createdMs = Date.parse(existing.created_at.replace(' ', 'T') + 'Z');
    const ageMs = Date.now() - createdMs;
    if (Number.isFinite(createdMs) && ageMs > SELF_CHECK_EDIT_WINDOW_MS) {
      const err = new Error('EDIT_WINDOW_EXPIRED');
      err.code = 'EDIT_WINDOW_EXPIRED';
      throw err;
    }
    db.prepare(`
      UPDATE lesson_self_check
         SET understanding = ?, focus = ?, comment = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(understanding, focus, comment || null, existing.id);
    return { mode: 'updated', record: getSelfCheck(lessonId, userId) };
  }
  db.prepare(`
    INSERT INTO lesson_self_check (lesson_id, user_id, class_id, understanding, focus, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(lessonId, userId, classId, understanding, focus, comment || null);
  return { mode: 'created', record: getSelfCheck(lessonId, userId) };
}

/**
 * 클래스 셀프체크 집계 (대시보드용)
 * @param {number} classId
 * @param {object} opts { startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD', lessonId?: number }
 */
function getClassSelfCheckAggregate(classId, { startDate, endDate, lessonId } = {}) {
  // 대상 수업 선정 (status='published'만 — 통계 일관성)
  let where = "WHERE l.class_id = ? AND l.status = 'published'";
  const params = [classId];
  if (lessonId) {
    where += ' AND l.id = ?';
    params.push(parseInt(lessonId));
  }
  // 기간 필터: lesson_date 우선, 없으면 created_at(등록일)
  if (startDate) {
    where += " AND COALESCE(l.lesson_date, DATE(l.created_at)) >= ?";
    params.push(startDate);
  }
  if (endDate) {
    where += " AND COALESCE(l.lesson_date, DATE(l.created_at)) <= ?";
    params.push(endDate);
  }
  const lessons = db.prepare(`
    SELECT l.id, l.title, l.lesson_date, l.created_at
    FROM lessons l
    ${where}
    ORDER BY COALESCE(l.lesson_date, DATE(l.created_at)) ASC, l.id ASC
  `).all(...params);

  // 클래스 학생 수·명단 — db/class.js 학생 모집단 SSOT
  //
  // ── [P1-B 재작업 / 감리 B-1] 2026-08-06 ────────────────────────────────────
  //   바로 아래 getClassNonRespondents 는 SSOT 로 바꾸면서 이 함수만 건너뛰어,
  //   **같은 lesson 의 미응답 명단이 화면마다 달라졌다**(라이브 실측):
  //     /api/class/1/lessons/self-check/aggregate → 10명
  //        강다은·박학생·윤서준·이학부모·이학생·임지호·정교직원·정민재·최학생·한서윤
  //                        ↑학부모      ↑교직원                    ↑삭제 계정
  //     /api/lesson/1/1/self-check                → 7명 (정본)
  //   수정 전에는 둘 다 틀려서 최소한 일관됐는데, 부분 수정이 불일치를 새로 만들었다.
  //   교사 화면에 삭제 계정(한서윤) 실명이 남아 있던 것도 여기였다.
  //   ※ 명단 키: getClassStudents 는 user_id 와 id 를 함께 주지만, 아래 memberMap·
  //     nonRespondList 가 m.id 를 쓰므로 여기서 명시적으로 정규화한다(키 어긋남 방지).
  const totalMembers = getClassStudentCount(classId);
  const classMembers = getClassStudents(classId)
    .map(m => ({ id: m.user_id, display_name: m.display_name, username: m.username }));
  const memberMap = new Map(classMembers.map(m => [m.id, m]));

  let sumU = 0, sumF = 0, respondTotal = 0, lessonRespondRateSum = 0;

  const lessonRows = lessons.map(lesson => {
    const responses = db.prepare(`
      SELECT user_id, understanding, focus, comment, updated_at
      FROM lesson_self_check
      WHERE lesson_id = ? AND class_id = ?
    `).all(lesson.id, classId);

    const u_dist = [0, 0, 0, 0, 0, 0]; // 1..5, none(미응답)
    const f_dist = [0, 0, 0, 0, 0, 0];
    let uSum = 0, fSum = 0;

    // rosters: 각 단계별 학생 명단 (이름·id·시각)
    const rosters = {
      understanding: { '1': [], '2': [], '3': [], '4': [], '5': [], none: [] },
      focus:         { '1': [], '2': [], '3': [], '4': [], '5': [], none: [] }
    };
    const respondedIds = new Set();

    responses.forEach(r => {
      const m = memberMap.get(r.user_id);
      const display = m ? m.display_name : `User ${r.user_id}`;
      const entry = { user_id: r.user_id, display_name: display, updated_at: r.updated_at };
      respondedIds.add(r.user_id);
      if (r.understanding >= 1 && r.understanding <= 5) {
        u_dist[r.understanding - 1] += 1;
        uSum += r.understanding;
        rosters.understanding[String(r.understanding)].push(entry);
      }
      if (r.focus >= 1 && r.focus <= 5) {
        f_dist[r.focus - 1] += 1;
        fSum += r.focus;
        rosters.focus[String(r.focus)].push(entry);
      }
    });

    // 미응답 학생 명단
    const nonRespondList = classMembers
      .filter(m => !respondedIds.has(m.id))
      .map(m => ({ user_id: m.id, display_name: m.display_name }));
    rosters.understanding.none = nonRespondList;
    rosters.focus.none = nonRespondList;

    const respondentCount = responses.length;
    const nonRespond = nonRespondList.length;
    u_dist[5] = nonRespond;
    f_dist[5] = nonRespond;

    const avgU = respondentCount > 0 ? Math.round((uSum / respondentCount) * 10) / 10 : null;
    const avgF = respondentCount > 0 ? Math.round((fSum / respondentCount) * 10) / 10 : null;

    sumU += uSum;
    sumF += fSum;
    respondTotal += respondentCount;
    if (totalMembers > 0) {
      lessonRespondRateSum += respondentCount / totalMembers;
    }

    return {
      lesson_id: lesson.id,
      lesson_title: lesson.title,
      registered_at: lesson.lesson_date || (lesson.created_at ? String(lesson.created_at).slice(0, 10) : null),
      understanding_dist: u_dist,
      focus_dist: f_dist,
      respondent_count: respondentCount,
      total_members: totalMembers,
      avg_understanding: avgU,
      avg_focus: avgF,
      rosters
    };
  });

  const totalLessons = lessonRows.length;
  const classSummary = {
    total_lessons: totalLessons,
    avg_understanding: respondTotal > 0 ? Math.round((sumU / respondTotal) * 10) / 10 : null,
    avg_focus: respondTotal > 0 ? Math.round((sumF / respondTotal) * 10) / 10 : null,
    response_rate: totalLessons > 0
      ? Math.round((lessonRespondRateSum / totalLessons) * 100) / 100
      : 0
  };

  return { lessons: lessonRows, class_summary: classSummary };
}

function getClassNonRespondents(classId, lessonId) {
  return db.prepare(`
    SELECT u.id as user_id, u.display_name, u.username
    FROM class_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND ${studentPopulationSql()}
      AND u.id NOT IN (
        SELECT user_id FROM lesson_self_check WHERE lesson_id = ?
      )
    ORDER BY u.display_name
  `).all(classId, lessonId);
}

module.exports = {
  createLesson, getLessonById, getLessonsByClass, updateLesson, deleteLesson,
  addAttachment, getAttachments,
  addContentToLesson, removeContentFromLesson, getLessonContents,
  setLessonStdIds, getLessonStdIds,
  getContentProgress, updateContentProgress, getLessonProgress,
  getLessonCompletionRate, getClassCompletionStats, getClassAverageCompletionRate,
  getLessonsByClassWithProgress,
  getLessonBoardStats, getLessonBoardList, getLessonStudentProgress,
  // 셀프체크
  getSelfCheck, getSelfChecksByLesson, upsertSelfCheck,
  getClassSelfCheckAggregate, getClassNonRespondents,
  SELF_CHECK_EDIT_WINDOW_MS
};
