/**
 * 통합 검색 API
 * GET /api/search?q=분수&type=all
 */
const express = require('express');
const router = express.Router();
const db = require('../db/index');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  try {
    const q = req.query.q?.trim();
    const type = req.query.type || 'all';
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);

    if (!q || q.length < 1) {
      return res.json({ success: true, results: {}, total: 0 });
    }

    const term = `%${q}%`;
    const results = {};
    let total = 0;

    // 수업 (lessons)
    if (type === 'all' || type === 'lesson') {
      const lessons = db.prepare(`
        SELECT l.id, l.title, l.description, l.class_id, l.lesson_date, l.status,
               c.name as class_name, u.display_name as author_name
        FROM lessons l
        JOIN classes c ON l.class_id = c.id
        JOIN users u ON l.teacher_id = u.id
        JOIN class_members cm ON cm.class_id = l.class_id AND cm.user_id = ?
        WHERE (l.title LIKE ? OR l.description LIKE ? OR l.content LIKE ?)
        ORDER BY l.created_at DESC LIMIT ?
      `).all(req.user.id, term, term, term, limit);
      results.lessons = lessons;
      total += lessons.length;
    }

    // 콘텐츠 (contents)
    if (type === 'all' || type === 'content') {
      const contents = db.prepare(`
        SELECT c.id, c.title, c.description, c.content_type, c.subject, c.grade, u.display_name as author_name, c.view_count, c.created_at
        FROM contents c
        LEFT JOIN users u ON c.creator_id = u.id
        WHERE c.status = 'approved' AND (c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ? OR c.subject LIKE ?)
        ORDER BY c.created_at DESC LIMIT ?
      `).all(term, term, term, term, limit);
      results.contents = contents;
      total += contents.length;
    }

    // 과제 (homework)
    if (type === 'all' || type === 'homework') {
      const homework = db.prepare(`
        SELECT h.id, h.title, h.description, h.class_id, h.due_date, h.status,
               c.name as class_name
        FROM homework h
        JOIN classes c ON h.class_id = c.id
        JOIN class_members cm ON cm.class_id = h.class_id AND cm.user_id = ?
        WHERE (h.title LIKE ? OR h.description LIKE ?)
        ORDER BY h.created_at DESC LIMIT ?
      `).all(req.user.id, term, term, limit);
      results.homework = homework;
      total += homework.length;
    }

    // 평가 (exams)
    if (type === 'all' || type === 'exam') {
      const exams = db.prepare(`
        SELECT e.id, e.title, e.class_id, e.status, e.question_count, e.time_limit,
               c.name as class_name
        FROM exams e
        JOIN classes c ON e.class_id = c.id
        JOIN class_members cm ON cm.class_id = e.class_id AND cm.user_id = ?
        WHERE (e.title LIKE ?)
        ORDER BY e.created_at DESC LIMIT ?
      `).all(req.user.id, term, limit);
      results.exams = exams;
      total += exams.length;
    }

    // 게시글 (posts)
    if (type === 'all' || type === 'post') {
      const posts = db.prepare(`
        SELECT p.id, p.title, p.content, p.class_id, p.category, p.view_count, p.created_at,
               c.name as class_name,
               CASE WHEN p.is_anonymous = 1 THEN '익명' ELSE u.display_name END as author_name
        FROM posts p
        JOIN classes c ON p.class_id = c.id
        JOIN users u ON p.author_id = u.id
        JOIN class_members cm ON cm.class_id = p.class_id AND cm.user_id = ?
        WHERE (p.title LIKE ? OR p.content LIKE ?)
        ORDER BY p.created_at DESC LIMIT ?
      `).all(req.user.id, term, term, limit);
      results.posts = posts;
      total += posts.length;
    }

    res.json({ success: true, results, total, query: q });
  } catch (err) {
    console.error('[SEARCH] error:', err);
    res.status(500).json({ success: false, message: '검색 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
