const db = require('./index');
// 소프트 삭제 계정 판정은 db/class.js 정본 헬퍼만 사용 (술어 손복사 금지).
const { liveUserSql } = require('./class');

// ─────────────────────────────────────────────────────────
// JSON 안전 직렬화/역직렬화 헬퍼
// ─────────────────────────────────────────────────────────
function safeStringify(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
}
function safeParse(s, fallback = null) {
  if (s === null || s === undefined) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ─────────────────────────────────────────────────────────
// 메타 보강: 리액션 집계 / 댓글 수 / 북마크·읽음 (사용자 관점)
// ─────────────────────────────────────────────────────────
function getReactionsByNotice(noticeId) {
  const rows = db.prepare(`
    SELECT kind, COUNT(*) AS cnt
    FROM notice_reactions
    WHERE notice_id = ?
    GROUP BY kind
  `).all(noticeId);
  const out = {};
  rows.forEach(r => { out[r.kind] = r.cnt; });
  return out;
}

function getMyReactionsByNotice(noticeId, userId) {
  return db.prepare(`
    SELECT kind FROM notice_reactions WHERE notice_id = ? AND user_id = ?
  `).all(noticeId, userId).map(r => r.kind);
}

function getCommentCount(noticeId) {
  return db.prepare(`
    SELECT COUNT(*) AS cnt FROM notice_comments WHERE notice_id = ? AND deleted_at IS NULL
  `).get(noticeId).cnt;
}

function isBookmarkedBy(noticeId, userId) {
  return !!db.prepare('SELECT id FROM notice_bookmarks WHERE notice_id = ? AND user_id = ?').get(noticeId, userId);
}

// ─────────────────────────────────────────────────────────
// 알림장 CRUD
// ─────────────────────────────────────────────────────────
function createNotice(classId, authorId, data) {
  const info = db.prepare(`
    INSERT INTO notices (class_id, author_id, title, content, is_pinned, theme, attachments, auto_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    classId,
    authorId,
    data.title,
    data.content || null,
    data.is_pinned ? 1 : 0,
    data.theme || 'classic',
    safeStringify(data.attachments) || null,
    data.auto_date ? 1 : 0
  );
  return getNoticeById(info.lastInsertRowid);
}

function getNoticeById(id, viewerId = null) {
  const row = db.prepare(`
    SELECT n.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM notice_reads WHERE notice_id = n.id) as read_count
    FROM notices n JOIN users u ON n.author_id = u.id WHERE n.id = ?
  `).get(id);
  if (!row) return null;
  row.attachments = safeParse(row.attachments, []) || [];
  row.reactions = getReactionsByNotice(row.id);
  row.comment_count = getCommentCount(row.id);
  if (viewerId) {
    row.my_reactions = getMyReactionsByNotice(row.id, viewerId);
    row.is_bookmarked_by_me = isBookmarkedBy(row.id, viewerId);
    row.is_read_by_me = isRead(row.id, viewerId);
  }
  return row;
}

function getNoticesByClass(classId, { page = 1, limit = 20, viewerId = null } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM notices WHERE class_id = ?').get(classId).cnt;
  const notices = db.prepare(`
    SELECT n.*, u.display_name as author_name,
    (SELECT COUNT(*) FROM notice_reads WHERE notice_id = n.id) as read_count
    FROM notices n JOIN users u ON n.author_id = u.id
    WHERE n.class_id = ?
    ORDER BY n.is_pinned DESC, n.created_at DESC LIMIT ? OFFSET ?
  `).all(classId, limit, (page - 1) * limit);

  for (const n of notices) {
    n.attachments = safeParse(n.attachments, []) || [];
    n.reactions = getReactionsByNotice(n.id);
    n.comment_count = getCommentCount(n.id);
    if (viewerId) {
      n.my_reactions = getMyReactionsByNotice(n.id, viewerId);
      n.is_bookmarked_by_me = isBookmarkedBy(n.id, viewerId);
      n.is_read_by_me = isRead(n.id, viewerId);
    }
  }
  return { notices, total, totalPages: Math.ceil(total / limit) || 1 };
}

function updateNotice(id, data) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(data)) {
    if (['title', 'content', 'theme'].includes(k)) {
      fields.push(`${k} = ?`);
      params.push(v);
    } else if (k === 'is_pinned' || k === 'auto_date') {
      fields.push(`${k} = ?`);
      params.push(v ? 1 : 0);
    } else if (k === 'attachments') {
      fields.push('attachments = ?');
      params.push(safeStringify(v));
    }
  }
  if (!fields.length) return getNoticeById(id);
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.prepare(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getNoticeById(id);
}

function deleteNotice(id) { db.prepare('DELETE FROM notices WHERE id = ?').run(id); }

// ─────────────────────────────────────────────────────────
// 읽음 처리
// ─────────────────────────────────────────────────────────
function markRead(noticeId, userId) {
  try { db.prepare('INSERT INTO notice_reads (notice_id, user_id) VALUES (?, ?)').run(noticeId, userId); } catch {}
}

function isRead(noticeId, userId) {
  return !!db.prepare('SELECT id FROM notice_reads WHERE notice_id = ? AND user_id = ?').get(noticeId, userId);
}

// 개설자 전용: 읽은 멤버 / 미확인 멤버 (active 멤버 기준)
// 도달율 왜곡 방지: 해당 알림장 "작성자(author)"는 읽음/미읽음 분모에서 제외한다.
// (작성자는 스스로 알림장을 열지 않아도 되며, remindUnread 도 senderId 를 필터함 — 동일 기준)
// 모집단 규약: 알림장은 "멤버 전원"이 대상이다 — 학부모·교직원도 알림장을 받아야 하므로
//   분모에 그대로 포함한다(사용자 결정 2026-08-07). 여기서 빠지는 건 작성자와
//   로그인 자체가 불가능한 소프트 삭제 계정뿐. ⚠ 역할로 좁히지 말 것.
function getReadAndUnreadMembers(noticeId, classId) {
  const notice = db.prepare('SELECT author_id FROM notices WHERE id = ?').get(noticeId);
  const authorId = notice ? notice.author_id : null;
  const members = db.prepare(`
    SELECT cm.user_id, u.display_name, u.username, u.profile_image_url, cm.role
    FROM class_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.status = 'active'
      AND cm.user_id != ?
      AND ${liveUserSql('u')}
  `).all(classId, authorId);
  const readSet = new Set(
    db.prepare('SELECT user_id FROM notice_reads WHERE notice_id = ?').all(noticeId).map(r => r.user_id)
  );
  const read_members = [];
  const unread_members = [];
  for (const m of members) {
    (readSet.has(m.user_id) ? read_members : unread_members).push(m);
  }
  return { read_members, unread_members };
}

// ─────────────────────────────────────────────────────────
// 리액션 (토글)
// ─────────────────────────────────────────────────────────
function toggleReaction(noticeId, userId, kind) {
  const existing = db.prepare(`
    SELECT id FROM notice_reactions WHERE notice_id = ? AND user_id = ? AND kind = ?
  `).get(noticeId, userId, kind);
  if (existing) {
    db.prepare('DELETE FROM notice_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO notice_reactions (notice_id, user_id, kind) VALUES (?, ?, ?)').run(noticeId, userId, kind);
  }
  return {
    reactions: getReactionsByNotice(noticeId),
    my_reactions: getMyReactionsByNotice(noticeId, userId)
  };
}

// ─────────────────────────────────────────────────────────
// 북마크 (토글)
// ─────────────────────────────────────────────────────────
function toggleBookmark(noticeId, userId) {
  const existing = db.prepare('SELECT id FROM notice_bookmarks WHERE notice_id = ? AND user_id = ?').get(noticeId, userId);
  if (existing) {
    db.prepare('DELETE FROM notice_bookmarks WHERE id = ?').run(existing.id);
    return { is_bookmarked: false };
  }
  db.prepare('INSERT INTO notice_bookmarks (notice_id, user_id) VALUES (?, ?)').run(noticeId, userId);
  return { is_bookmarked: true };
}

function getBookmarkedNotices(classId, userId) {
  const rows = db.prepare(`
    SELECT n.*, u.display_name as author_name,
      (SELECT COUNT(*) FROM notice_reads WHERE notice_id = n.id) as read_count,
      (SELECT b2.created_at FROM notice_bookmarks b2 WHERE b2.notice_id = n.id AND b2.user_id = ?) as bookmarked_at
    FROM notice_bookmarks b
    JOIN notices n ON b.notice_id = n.id
    JOIN users u ON n.author_id = u.id
    WHERE b.user_id = ? AND n.class_id = ?
    ORDER BY b.created_at DESC
  `).all(userId, userId, classId);
  for (const n of rows) {
    n.attachments = safeParse(n.attachments, []) || [];
    n.reactions = getReactionsByNotice(n.id);
    n.comment_count = getCommentCount(n.id);
    n.my_reactions = getMyReactionsByNotice(n.id, userId);
    n.is_bookmarked_by_me = true;
    n.is_read_by_me = isRead(n.id, userId);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────
// 댓글 (트리 구조)
// ─────────────────────────────────────────────────────────
function getCommentsTree(noticeId) {
  const rows = db.prepare(`
    SELECT c.*, u.display_name as author_name, u.username, u.profile_image_url
    FROM notice_comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.notice_id = ?
    ORDER BY (c.parent_id IS NULL) DESC, COALESCE(c.parent_id, c.id) ASC, c.created_at ASC
  `).all(noticeId);

  // 정렬: 최상위(parent_id NULL)를 먼저 모두 두고, 각 root 아래에 자식들을 따라 붙임
  const byId = new Map();
  const roots = [];
  rows.forEach(r => {
    // soft delete 처리: 본문 마스킹
    if (r.deleted_at) r.content = '[삭제된 댓글]';
    r.replies = [];
    byId.set(r.id, r);
  });
  rows.forEach(r => {
    if (r.parent_id && byId.has(r.parent_id)) {
      byId.get(r.parent_id).replies.push(r);
    } else if (!r.parent_id) {
      roots.push(r);
    }
  });
  // 루트는 오래된 순(작성순), 답글도 작성순
  roots.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const r of roots) {
    r.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  return roots;
}

function addComment(noticeId, userId, { content, parent_id = null }) {
  if (!content || !content.trim()) return null;
  // parent_id가 있으면 같은 notice_id에 속하는지 검증
  let pid = null;
  if (parent_id) {
    const p = db.prepare('SELECT id, notice_id, parent_id FROM notice_comments WHERE id = ? AND deleted_at IS NULL').get(parent_id);
    if (p && p.notice_id === noticeId) {
      // 1단계 중첩만 허용 (대댓글의 대댓글은 부모의 부모로 평탄화)
      pid = p.parent_id ? p.parent_id : p.id;
    }
  }
  const info = db.prepare(`
    INSERT INTO notice_comments (notice_id, user_id, parent_id, content)
    VALUES (?, ?, ?, ?)
  `).run(noticeId, userId, pid, content);
  return db.prepare(`
    SELECT c.*, u.display_name as author_name, u.username, u.profile_image_url
    FROM notice_comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?
  `).get(info.lastInsertRowid);
}

function updateComment(commentId, userId, content) {
  const row = db.prepare('SELECT id, user_id, deleted_at FROM notice_comments WHERE id = ?').get(commentId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.user_id !== userId) return { ok: false, reason: 'forbidden' };
  if (row.deleted_at) return { ok: false, reason: 'deleted' };
  db.prepare('UPDATE notice_comments SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, commentId);
  return { ok: true };
}

function deleteComment(commentId, userId, { isOwner = false } = {}) {
  const row = db.prepare('SELECT id, user_id, deleted_at FROM notice_comments WHERE id = ?').get(commentId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!isOwner && row.user_id !== userId) return { ok: false, reason: 'forbidden' };
  if (row.deleted_at) return { ok: true, alreadyDeleted: true };
  db.prepare('UPDATE notice_comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(commentId);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────
// 임시저장 (UPSERT) — class_id × user_id 1행
// ─────────────────────────────────────────────────────────
function getDraft(classId, userId) {
  const row = db.prepare('SELECT * FROM notice_drafts WHERE class_id = ? AND user_id = ?').get(classId, userId);
  if (!row) return null;
  row.attachments = safeParse(row.attachments, []) || [];
  return row;
}

function upsertDraft(classId, userId, data) {
  const payload = {
    title: data.title || null,
    content: data.content || null,
    theme: data.theme || 'classic',
    attachments: safeStringify(data.attachments)
  };
  const exists = db.prepare('SELECT id FROM notice_drafts WHERE class_id = ? AND user_id = ?').get(classId, userId);
  if (exists) {
    db.prepare(`
      UPDATE notice_drafts SET title = ?, content = ?, theme = ?, attachments = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(payload.title, payload.content, payload.theme, payload.attachments, exists.id);
  } else {
    db.prepare(`
      INSERT INTO notice_drafts (class_id, user_id, title, content, theme, attachments)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(classId, userId, payload.title, payload.content, payload.theme, payload.attachments);
  }
  return getDraft(classId, userId);
}

function deleteDraft(classId, userId) {
  db.prepare('DELETE FROM notice_drafts WHERE class_id = ? AND user_id = ?').run(classId, userId);
}

// ─────────────────────────────────────────────────────────
// 알림(미확인 멤버에게 재알림) — notifications 테이블에 INSERT
// ─────────────────────────────────────────────────────────
function remindUnread(noticeId, classId, senderId) {
  const notice = db.prepare('SELECT id, title, class_id FROM notices WHERE id = ?').get(noticeId);
  if (!notice) return { ok: false, reason: 'not_found' };
  const { unread_members } = getReadAndUnreadMembers(noticeId, classId);
  // 본인(개설자)에게는 알림 보내지 않음
  const targets = unread_members.filter(m => m.user_id !== senderId);
  const ins = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (?, 'notice_remind', ?, ?, ?)
  `);
  for (const m of targets) {
    try {
      ins.run(
        m.user_id,
        '알림장 재안내',
        `"${notice.title}" 알림장을 확인해 주세요.`,
        `/class/notice.html?classId=${classId}&noticeId=${noticeId}`
      );
    } catch (e) { /* 단건 실패는 무시 */ }
  }
  return { ok: true, target_count: targets.length, target_user_ids: targets.map(t => t.user_id) };
}

module.exports = {
  createNotice, getNoticeById, getNoticesByClass, updateNotice, deleteNotice,
  markRead, isRead, getReadAndUnreadMembers,
  toggleReaction, getReactionsByNotice, getMyReactionsByNotice,
  toggleBookmark, getBookmarkedNotices, isBookmarkedBy,
  getCommentsTree, addComment, updateComment, deleteComment, getCommentCount,
  getDraft, upsertDraft, deleteDraft,
  remindUnread
};
