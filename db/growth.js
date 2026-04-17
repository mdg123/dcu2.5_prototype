const db = require('./index');

// ========== 포트폴리오 ==========

function createPortfolio(studentId, data) {
  const info = db.prepare(`
    INSERT INTO portfolios (student_id, class_id, title, description, category, content, file_path, thumbnail_url, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    studentId, data.class_id || null, data.title, data.description || null,
    data.category || 'general', data.content || null, data.file_path || null,
    data.thumbnail_url || null, data.is_public ? 1 : 0
  );
  return getPortfolioById(info.lastInsertRowid);
}

function getPortfolioById(id) {
  return db.prepare(`
    SELECT p.*, u.display_name AS student_name
    FROM portfolios p JOIN users u ON p.student_id = u.id
    WHERE p.id = ?
  `).get(id);
}

function getStudentPortfolios(studentId, { classId, category, page = 1, limit = 20 } = {}) {
  let where = ' WHERE p.student_id = ?';
  const params = [studentId];
  if (classId) { where += ' AND p.class_id = ?'; params.push(classId); }
  if (category) { where += ' AND p.category = ?'; params.push(category); }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM portfolios p' + where).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const items = db.prepare(`
    SELECT p.*, u.display_name AS student_name
    FROM portfolios p JOIN users u ON p.student_id = u.id
    ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  return { items, total, totalPages };
}

function updatePortfolio(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['title', 'description', 'category', 'content', 'file_path', 'thumbnail_url', 'is_public'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return getPortfolioById(id);
  params.push(id);
  db.prepare(`UPDATE portfolios SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getPortfolioById(id);
}

function deletePortfolio(id) {
  db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
}

// ========== 성장 리포트 (학습 로그 기반 통계) ==========

function getStudentGrowthSummary(studentId) {
  // 전체 학습 로그 통계
  const totalActivities = db.prepare(
    'SELECT COUNT(*) as cnt FROM learning_logs WHERE user_id = ?'
  ).get(studentId).cnt;

  const totalTime = db.prepare(
    'SELECT COALESCE(SUM(CAST(result_duration AS INTEGER)), 0) as total FROM learning_logs WHERE user_id = ?'
  ).get(studentId).total;

  // 활동 유형별 통계
  const byType = db.prepare(`
    SELECT activity_type, COUNT(*) as cnt, COALESCE(SUM(CAST(result_duration AS INTEGER)), 0) as total_time
    FROM learning_logs WHERE user_id = ?
    GROUP BY activity_type ORDER BY cnt DESC
  `).all(studentId);

  // 최근 7일 활동
  const recentActivity = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as cnt
    FROM learning_logs WHERE user_id = ? AND created_at >= DATE('now', '-7 days')
    GROUP BY DATE(created_at) ORDER BY date
  `).all(studentId);

  // 포트폴리오 수
  const portfolioCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM portfolios WHERE student_id = ?'
  ).get(studentId).cnt;

  // 오답노트 통계
  const wrongTotal = db.prepare('SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ?').get(studentId).cnt;
  const wrongResolved = db.prepare("SELECT COUNT(*) as cnt FROM wrong_answers WHERE student_id = ? AND is_resolved = 1").get(studentId).cnt;

  return {
    totalActivities,
    totalTimeMinutes: Math.round(totalTime / 60),
    byType,
    recentActivity,
    portfolioCount,
    wrongAnswers: { total: wrongTotal, resolved: wrongResolved }
  };
}

// 클래스 내 학생들의 성장 현황 (교사용)
function getClassGrowthOverview(classId) {
  const members = db.prepare(`
    SELECT cm.user_id, u.display_name, u.username
    FROM class_members cm JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.role = 'member' AND u.role = 'student'
    ORDER BY u.display_name
  `).all(classId);

  const studentStats = members.map(m => {
    const activityCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM learning_logs WHERE user_id = ? AND class_id = ?'
    ).get(m.user_id, classId).cnt;

    const totalTime = db.prepare(
      'SELECT COALESCE(SUM(CAST(result_duration AS INTEGER)), 0) as total FROM learning_logs WHERE user_id = ? AND class_id = ?'
    ).get(m.user_id, classId).total;

    const portfolioCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM portfolios WHERE student_id = ? AND class_id = ?'
    ).get(m.user_id, classId).cnt;

    return {
      ...m,
      activityCount,
      totalTimeMinutes: Math.round(totalTime / 60),
      portfolioCount
    };
  });

  return studentStats;
}

// ========== 나도예술가 (갤러리) ==========

function createGalleryItem(studentId, data) {
  const info = db.prepare(`
    INSERT INTO student_gallery (student_id, title, description, image_url, category, approval_status, source_post_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(studentId, data.title, data.description || null, data.image_url || '/images/placeholder.png',
    data.category || 'art', data.approval_status || 'pending', data.source_post_id || null);
  return db.prepare('SELECT * FROM student_gallery WHERE id = ?').get(info.lastInsertRowid);
}

function getGalleryItems({ studentId, category, page = 1, limit = 20, includeAll } = {}) {
  let where = '';
  const params = [];
  if (studentId) { where += (where ? ' AND' : ' WHERE') + ' g.student_id = ?'; params.push(studentId); }
  if (category && category !== 'all') { where += (where ? ' AND' : ' WHERE') + ' g.category = ?'; params.push(category); }
  // 기본: 승인된 항목만 표시
  if (!includeAll) { where += (where ? ' AND' : ' WHERE') + " (g.approval_status = 'approved' OR g.approval_status IS NULL)"; }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM student_gallery g' + where).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const items = db.prepare(`
    SELECT g.*, u.display_name AS student_name
    FROM student_gallery g JOIN users u ON g.student_id = u.id
    ${where} ORDER BY g.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  return { items, total, totalPages };
}

function likeGalleryItem(id) {
  db.prepare('UPDATE student_gallery SET like_count = like_count + 1 WHERE id = ?').run(id);
  return db.prepare('SELECT * FROM student_gallery WHERE id = ?').get(id);
}

function approveGalleryItem(id, approvedBy) {
  db.prepare("UPDATE student_gallery SET approval_status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(approvedBy, id);
}

function rejectGalleryItem(id) {
  db.prepare("UPDATE student_gallery SET approval_status = 'rejected' WHERE id = ?").run(id);
}

module.exports = {
  createPortfolio, getPortfolioById, getStudentPortfolios, updatePortfolio, deletePortfolio,
  getStudentGrowthSummary, getClassGrowthOverview,
  createGalleryItem, getGalleryItems, likeGalleryItem,
  approveGalleryItem, rejectGalleryItem
};
