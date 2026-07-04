const db = require('./index');

// ===== 게시판(Board) 관리 함수 =====
function getBoardsByClass(classId) {
  return db.prepare(`
    SELECT cb.*, (SELECT COUNT(*) FROM posts WHERE board_id = cb.id) as post_count
    FROM class_boards cb WHERE cb.class_id = ? AND cb.is_active = 1
    ORDER BY cb.sort_order ASC, cb.id ASC
  `).all(classId);
}

function getBoardById(boardId) {
  return db.prepare('SELECT * FROM class_boards WHERE id = ?').get(boardId) || null;
}

function createBoard(classId, data) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM class_boards WHERE class_id = ?').get(classId);
  const nextOrder = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 0;
  const info = db.prepare(`
    INSERT INTO class_boards (class_id, name, board_type, requires_approval, description, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(classId, data.name || '새 게시판', data.board_type || 'general',
    data.requires_approval ? 1 : 0, data.description || null, nextOrder);
  return getBoardById(info.lastInsertRowid);
}

function updateBoard(boardId, data) {
  const fields = [];
  const params = [];
  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
  if (data.board_type !== undefined) { fields.push('board_type = ?'); params.push(data.board_type); }
  if (data.requires_approval !== undefined) { fields.push('requires_approval = ?'); params.push(data.requires_approval ? 1 : 0); }
  if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description || null); }
  if (data.sort_order !== undefined) { fields.push('sort_order = ?'); params.push(data.sort_order); }
  if (!fields.length) return getBoardById(boardId);
  params.push(boardId);
  db.prepare(`UPDATE class_boards SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getBoardById(boardId);
}

function deleteBoard(boardId) {
  // 해당 게시판 게시글을 board_id = null로 변경 후 삭제
  db.prepare('UPDATE posts SET board_id = NULL WHERE board_id = ?').run(boardId);
  db.prepare('DELETE FROM class_boards WHERE id = ?').run(boardId);
}

function reorderBoards(classId, orderedIds) {
  const stmt = db.prepare('UPDATE class_boards SET sort_order = ? WHERE id = ? AND class_id = ?');
  const updateAll = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, classId));
  });
  updateAll();
}

// ===== 게시글(Post) 함수 =====
function createPost(classId, authorId, data) {
  const info = db.prepare(`
    INSERT INTO posts (class_id, author_id, title, content, image_url, category, board_id, is_pinned, is_anonymous, allow_comments, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(classId, authorId, data.title, data.content || null, data.image_url || null,
    data.category || 'general', data.board_id || null,
    data.is_pinned ? 1 : 0,
    data.is_anonymous ? 1 : 0, data.allow_comments !== undefined ? (data.allow_comments ? 1 : 0) : 1,
    data.approval_status || 'approved');
  return getPostById(info.lastInsertRowid);
}

function getPostById(id, viewerId = null) {
  const post = db.prepare(`
    SELECT p.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
    COALESCE(p.like_count, 0) as like_count,
    CASE WHEN ? IS NULL THEN 0
      ELSE (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id AND user_id = ?)
    END as liked
    FROM posts p JOIN users u ON p.author_id = u.id WHERE p.id = ?
  `).get(viewerId, viewerId, id) || null;
  if (post) {
    post.liked = !!post.liked;
    if (post.is_anonymous) post.author_name = '익명';
  }
  return post;
}

function getPostsByClass(classId, { category, boardId, page = 1, limit = 20, userId } = {}) {
  let where = 'WHERE p.class_id = ?';
  const params = [classId];
  if (boardId) { where += ' AND p.board_id = ?'; params.push(boardId); }
  else if (category) { where += ' AND p.category = ?'; params.push(category); }
  // 갤러리 게시물의 경우: 본인 글은 모든 상태, 타인 글은 승인된 것만
  if (userId) {
    where += ` AND (p.approval_status IS NULL OR p.approval_status = 'approved' OR p.author_id = ?)`;
    params.push(userId);
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM posts p ${where}`).get(...params).cnt;
  const posts = db.prepare(`
    SELECT p.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
    COALESCE(p.like_count, 0) as like_count
    FROM posts p JOIN users u ON p.author_id = u.id
    ${where} ORDER BY p.is_pinned DESC, p.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  // 익명 게시글 작성자 숨기기
  posts.forEach(p => { if (p.is_anonymous) p.author_name = '익명'; });
  return { posts, total, totalPages: Math.ceil(total / limit) || 1 };
}

function approvePost(postId) {
  db.prepare("UPDATE posts SET approval_status = 'approved' WHERE id = ?").run(postId);
  return getPostById(postId);
}

function rejectPost(postId, reason) {
  // rejection_reason 컬럼은 schema.js 마이그레이션에서 추가됨 (idempotent ALTER)
  db.prepare("UPDATE posts SET approval_status = 'rejected', rejection_reason = ? WHERE id = ?")
    .run(reason != null ? String(reason).slice(0, 500) : null, postId);
  return getPostById(postId);
}

function getPendingPosts(classId) {
  return db.prepare(`
    SELECT p.*, u.display_name as author_name
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.class_id = ? AND p.approval_status = 'pending'
    ORDER BY p.created_at DESC
  `).all(classId);
}

function updatePost(id, data) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(data)) {
    if (['title', 'content', 'image_url', 'category', 'is_pinned', 'is_anonymous', 'allow_comments'].includes(k)) { fields.push(`${k} = ?`); params.push(v); }
  }
  if (!fields.length) return getPostById(id);
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.prepare(`UPDATE posts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getPostById(id);
}

function deletePost(id) { db.prepare('DELETE FROM posts WHERE id = ?').run(id); }

function incrementViewCount(id) {
  db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(id);
}

// 댓글
function createComment(postId, authorId, content, parentId = null) {
  // 대댓글 교차 격리: parent_id 가 있으면 그 부모 댓글이 "같은 게시글(post_id)" 소속인지 검증.
  // 불일치(다른 게시글의 댓글 id)면 무시하고 top-level 로 강등한다. (알림장 addComment 와 대칭)
  let pid = null;
  if (parentId != null) {
    const p = db.prepare('SELECT id, post_id FROM comments WHERE id = ?').get(parentId);
    if (p && p.post_id === postId) pid = p.id;
  }
  const info = db.prepare(
    'INSERT INTO comments (post_id, author_id, content, parent_id) VALUES (?, ?, ?, ?)'
  ).run(postId, authorId, content, pid);
  return getCommentById(info.lastInsertRowid);
}

function getCommentById(id) {
  return db.prepare(`
    SELECT c.*, u.display_name as author_name
    FROM comments c JOIN users u ON c.author_id = u.id WHERE c.id = ?
  `).get(id) || null;
}

function getComments(postId) {
  return db.prepare(`
    SELECT c.*, u.display_name as author_name
    FROM comments c JOIN users u ON c.author_id = u.id
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).all(postId);
}

function deleteComment(id) { db.prepare('DELETE FROM comments WHERE id = ?').run(id); }

// 좋아요 토글: post_likes (post_id, user_id) UNIQUE 활용
// 반환: { liked: boolean, like_count: number }
function togglePostLike(postId, userId) {
  const exists = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(postId, userId);
  const tx = db.transaction(() => {
    if (exists) {
      db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
      db.prepare('UPDATE posts SET like_count = MAX(0, COALESCE(like_count, 0) - 1) WHERE id = ?').run(postId);
    } else {
      db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(postId, userId);
      db.prepare('UPDATE posts SET like_count = COALESCE(like_count, 0) + 1 WHERE id = ?').run(postId);
    }
  });
  tx();
  const row = db.prepare('SELECT like_count FROM posts WHERE id = ?').get(postId);
  return { liked: !exists, like_count: row ? (row.like_count || 0) : 0 };
}

module.exports = {
  // 게시판 관리
  getBoardsByClass, getBoardById, createBoard, updateBoard, deleteBoard, reorderBoards,
  // 게시글
  createPost, getPostById, getPostsByClass, updatePost, deletePost, incrementViewCount,
  createComment, getCommentById, getComments, deleteComment,
  approvePost, rejectPost, getPendingPosts,
  togglePostLike
};
