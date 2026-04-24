const db = require('./index');

// ========== 콘텐츠 CRUD ==========

function createContent(creatorId, data) {
  const info = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, content_url, file_path, thumbnail_url, subject, grade, tags, is_public, status, allow_comments, achievement_code, school_level, unit_name, difficulty, estimated_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now'))
  `).run(
    creatorId, data.title, data.description || null,
    data.content_type || 'document', data.content_url || null,
    data.file_path || null, data.thumbnail_url || null,
    data.subject || null, data.grade || null,
    data.tags ? JSON.stringify(data.tags) : null,
    data.is_public ? 1 : 0,
    data.status || 'approved',
    data.allow_comments !== undefined ? (data.allow_comments ? 1 : 0) : 1,
    data.achievement_code || null,
    data.school_level || null,
    data.unit_name || null,
    data.difficulty || null,
    data.estimated_minutes || null
  );
  return getContentById(info.lastInsertRowid);
}

function getContentById(id) {
  const c = db.prepare(`
    SELECT c.*, u.display_name AS creator_name
    FROM contents c JOIN users u ON c.creator_id = u.id
    WHERE c.id = ?
  `).get(id);
  if (c && c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } }
  // 문항/평가지: questions 포함
  if (c && (c.content_type === 'quiz' || c.content_type === 'exam')) {
    try {
      c.questions = db.prepare('SELECT * FROM content_questions WHERE content_id = ? ORDER BY question_number').all(id);
      c.questions.forEach(q => { if (q.options) try { q.options = JSON.parse(q.options); } catch {} });
    } catch { c.questions = []; }
  }
  // 수업꾸러미: bundle_items 포함
  if (c && (c.content_type === 'bundle' || c.content_type === 'package')) {
    try { c.bundle_items = getBundleItems(id); } catch { c.bundle_items = []; }
  }
  return c;
}

function updateContent(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['title', 'description', 'content_type', 'content_url', 'file_path', 'thumbnail_url', 'subject', 'grade', 'is_public', 'status', 'reject_reason', 'achievement_code', 'school_level', 'unit_name', 'difficulty', 'estimated_minutes', 'allow_comments', 'theme', 'copyright', 'download_allow'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
    if (key === 'tags') {
      fields.push('tags = ?');
      params.push(JSON.stringify(val));
    }
  }
  if (fields.length === 0) return getContentById(id);
  params.push(id);
  db.prepare(`UPDATE contents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getContentById(id);
}

function deleteContent(id) {
  db.prepare('DELETE FROM contents WHERE id = ?').run(id);
}

function incrementViewCount(id) {
  db.prepare('UPDATE contents SET view_count = view_count + 1 WHERE id = ?').run(id);
}

// 공개 콘텐츠 검색
function searchPublicContents({ keyword, subject, grade, content_type, page = 1, limit = 12, sort = 'latest', achievement_codes, curriculum_standard_ids } = {}) {
  const join = ' JOIN users u ON c.creator_id = u.id';
  let where = " WHERE c.is_public = 1 AND c.status = 'approved'";
  const params = [];
  if (keyword) { where += ' AND (c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ? OR u.display_name LIKE ? OR c.achievement_code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (subject) { where += ' AND c.subject = ?'; params.push(subject); }
  if (grade) { where += ' AND c.grade = ?'; params.push(grade); }
  if (content_type) {
    const types = content_type.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) { where += ' AND c.content_type = ?'; params.push(types[0]); }
    else if (types.length > 1) { where += ' AND c.content_type IN (' + types.map(() => '?').join(',') + ')'; types.forEach(t => params.push(t)); }
  }
  if (achievement_codes && achievement_codes.length > 0) {
    const aConds = achievement_codes.map(() => 'c.achievement_code LIKE ?');
    where += ' AND (' + aConds.join(' OR ') + ')';
    achievement_codes.forEach(code => params.push(`%${code}%`));
  }
  if (curriculum_standard_ids && curriculum_standard_ids.length > 0) {
    // 새 표준체계 ID(CSV) 필터 — curriculum_standard_ids 컬럼 또는
    // std_id_map 경유로 achievement_code(legacy) 매핑 모두 지원
    const idConds = [];
    curriculum_standard_ids.forEach(sid => {
      idConds.push('c.curriculum_standard_ids LIKE ?');
      params.push(`%${sid}%`);
      idConds.push(`c.achievement_code IN (SELECT standard_code FROM curriculum_std_id_map WHERE std_id = ?)`);
      params.push(sid);
    });
    where += ' AND (' + idConds.join(' OR ') + ')';
  }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM contents c' + join + where).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;

  let orderBy = ' ORDER BY c.created_at DESC';
  if (sort === 'popular') orderBy = ' ORDER BY c.view_count DESC';
  if (sort === 'likes') orderBy = ' ORDER BY c.like_count DESC';

  const contents = db.prepare(
    'SELECT c.*, u.display_name AS creator_name FROM contents c JOIN users u ON c.creator_id = u.id' +
    where + orderBy + ' LIMIT ? OFFSET ?'
  ).all(...params, limit, (page - 1) * limit);

  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return { contents, total, totalPages };
}

// 내 콘텐츠 목록
function getMyContents(userId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM contents WHERE creator_id = ?').get(userId).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const contents = db.prepare(`
    SELECT * FROM contents WHERE creator_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, (page - 1) * limit);
  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return { contents, total, totalPages };
}

// 수업용 콘텐츠 검색 (자기 콘텐츠 + 공개 콘텐츠 통합)
function searchContentsForLesson(userId, { keyword, content_type, subject, grade, limit = 20 } = {}) {
  let where = " WHERE (c.creator_id = ? OR (c.is_public = 1 AND c.status = 'approved'))";
  const params = [userId];
  if (keyword) { where += ' AND (c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ? OR u.display_name LIKE ? OR c.achievement_code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (content_type) {
    const types = content_type.split(',').map(t => t.trim());
    where += ` AND c.content_type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  if (subject) { where += ' AND c.subject LIKE ?'; params.push(`%${subject}%`); }
  if (grade) { where += ' AND c.grade = ?'; params.push(parseInt(grade)); }

  const contents = db.prepare(
    'SELECT c.*, u.display_name AS creator_name FROM contents c JOIN users u ON c.creator_id = u.id' +
    where + ' ORDER BY c.created_at DESC LIMIT ?'
  ).all(...params, limit);

  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return contents;
}

// ========== 보관함 (Collections) ==========

function addToCollection(userId, contentId, folderName) {
  try {
    db.prepare('INSERT INTO content_collections (user_id, content_id, folder_name) VALUES (?, ?, ?)').run(userId, contentId, folderName || '기본 보관함');
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) return { success: false, already: true };
    throw e;
  }
}

function removeFromCollection(userId, contentId) {
  const info = db.prepare('DELETE FROM content_collections WHERE user_id = ? AND content_id = ?').run(userId, contentId);
  return info.changes > 0;
}

function getCollection(userId, { folderName, page = 1, limit = 20 } = {}) {
  let where = ' WHERE cc.user_id = ?';
  const params = [userId];
  if (folderName) { where += ' AND cc.folder_name = ?'; params.push(folderName); }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM content_collections cc' + where).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;

  const contents = db.prepare(`
    SELECT c.*, u.display_name AS creator_name, cc.folder_name, cc.created_at AS collected_at
    FROM content_collections cc
    JOIN contents c ON cc.content_id = c.id
    JOIN users u ON c.creator_id = u.id
    ${where}
    ORDER BY cc.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return { contents, total, totalPages };
}

function getCollectionFolders(userId) {
  return db.prepare(`
    SELECT folder_name, COUNT(*) as count FROM content_collections WHERE user_id = ? GROUP BY folder_name ORDER BY folder_name
  `).all(userId);
}

function isInCollection(userId, contentId) {
  return !!db.prepare('SELECT id FROM content_collections WHERE user_id = ? AND content_id = ?').get(userId, contentId);
}

// ========== 채널 ==========

function createChannel(userId, data) {
  const info = db.prepare(`
    INSERT INTO channels (user_id, name, description) VALUES (?, ?, ?)
  `).run(userId, data.name, data.description || null);
  return getChannelById(info.lastInsertRowid);
}

function getChannelById(id) {
  return db.prepare(`
    SELECT ch.*, u.display_name AS owner_name
    FROM channels ch JOIN users u ON ch.user_id = u.id
    WHERE ch.id = ? AND ch.status = 'active'
  `).get(id);
}

function getUserChannel(userId) {
  return db.prepare(`
    SELECT ch.*, u.display_name AS owner_name
    FROM channels ch JOIN users u ON ch.user_id = u.id
    WHERE ch.user_id = ? AND ch.status = 'active'
  `).get(userId);
}

function updateChannel(id, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['name', 'description'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return getChannelById(id);
  params.push(id);
  db.prepare(`UPDATE channels SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getChannelById(id);
}

function getPopularChannels(limit = 8) {
  return db.prepare(`
    SELECT ch.*, u.display_name AS owner_name
    FROM channels ch JOIN users u ON ch.user_id = u.id
    WHERE ch.status = 'active'
    ORDER BY ch.subscriber_count DESC, ch.content_count DESC
    LIMIT ?
  `).all(limit);
}

// ========== 구독 ==========

function subscribe(channelId, userId) {
  try {
    db.prepare('INSERT INTO channel_subscriptions (channel_id, subscriber_id) VALUES (?, ?)').run(channelId, userId);
    db.prepare('UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = ?').run(channelId);
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) return { success: false, already: true };
    throw e;
  }
}

function unsubscribe(channelId, userId) {
  const info = db.prepare('DELETE FROM channel_subscriptions WHERE channel_id = ? AND subscriber_id = ?').run(channelId, userId);
  if (info.changes > 0) {
    db.prepare('UPDATE channels SET subscriber_count = MAX(0, subscriber_count - 1) WHERE id = ?').run(channelId);
    return true;
  }
  return false;
}

function isSubscribed(channelId, userId) {
  return !!db.prepare('SELECT id FROM channel_subscriptions WHERE channel_id = ? AND subscriber_id = ?').get(channelId, userId);
}

function getUserSubscriptions(userId) {
  return db.prepare(`
    SELECT ch.*, u.display_name AS owner_name, cs.subscribed_at
    FROM channel_subscriptions cs
    JOIN channels ch ON cs.channel_id = ch.id
    JOIN users u ON ch.user_id = u.id
    WHERE cs.subscriber_id = ? AND ch.status = 'active'
    ORDER BY cs.subscribed_at DESC
  `).all(userId);
}

// 채널의 콘텐츠
function getChannelContents(channelId, { page = 1, limit = 12 } = {}) {
  const channel = getChannelById(channelId);
  if (!channel) return { contents: [], total: 0, totalPages: 1 };
  const userId = channel.user_id;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM contents WHERE creator_id = ? AND is_public = 1').get(userId).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const contents = db.prepare(`
    SELECT c.*, u.display_name AS creator_name
    FROM contents c JOIN users u ON c.creator_id = u.id
    WHERE c.creator_id = ? AND c.is_public = 1
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, (page - 1) * limit);
  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return { contents, total, totalPages };
}

// 좋아요 토글
function toggleLike(contentId) {
  db.prepare('UPDATE contents SET like_count = like_count + 1 WHERE id = ?').run(contentId);
  return getContentById(contentId);
}

// ========== 승인 워크플로우 ==========

function getPendingContents({ page = 1, limit = 20 } = {}) {
  const total = db.prepare("SELECT COUNT(*) as cnt FROM contents WHERE status = 'pending'").get().cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const contents = db.prepare(`
    SELECT c.*, u.display_name AS creator_name
    FROM contents c JOIN users u ON c.creator_id = u.id
    WHERE c.status = 'pending'
    ORDER BY c.created_at ASC LIMIT ? OFFSET ?
  `).all(limit, (page - 1) * limit);
  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return { contents, total, totalPages };
}

function approveContent(id) {
  db.prepare("UPDATE contents SET status = 'approved', reject_reason = NULL WHERE id = ?").run(id);
  return getContentById(id);
}

function rejectContent(id, reason) {
  db.prepare("UPDATE contents SET status = 'rejected', reject_reason = ? WHERE id = ?").run(reason || null, id);
  return getContentById(id);
}

function holdContent(id, reason) {
  db.prepare("UPDATE contents SET status = 'hold', reject_reason = ? WHERE id = ?").run(reason || null, id);
  return getContentById(id);
}

function reviewContent(id) {
  db.prepare("UPDATE contents SET status = 'review' WHERE id = ?").run(id);
  return getContentById(id);
}

function getAllReviewContents({ page = 1, limit = 50, status } = {}) {
  const offset = (page - 1) * limit;
  let where = "WHERE c.is_public = 1";
  const params = [];
  if (status && status !== 'all') { where += " AND c.status = ?"; params.push(status); }
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM contents c ${where}`).get(...params).cnt;
  const contents = db.prepare(`
    SELECT c.*, u.display_name as creator_name FROM contents c
    LEFT JOIN users u ON c.creator_id = u.id
    ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { contents, total, totalPages: Math.ceil(total / limit) };
}

// 추천 콘텐츠 (인기순 + 최신)
function getRecommendations(userId, limit = 12, keywords = []) {
  let contents = [];
  const existIds = new Set();

  // 1순위: 구독 크리에이터의 최신 콘텐츠 (본인 제외)
  try {
    const sub = db.prepare(`
      SELECT c.*, u.display_name AS creator_name
      FROM contents c
      JOIN users u ON c.creator_id = u.id
      JOIN channel_subscribers cs ON cs.user_id = ?
      JOIN channels ch ON ch.id = cs.channel_id AND ch.user_id = c.creator_id
      WHERE c.is_public = 1 AND c.status = 'approved' AND c.creator_id != ?
      ORDER BY c.created_at DESC LIMIT ?
    `).all(userId, userId, limit);
    sub.forEach(c => { contents.push(c); existIds.add(c.id); });
  } catch {}

  // 2순위: 최근 검색 키워드/성취기준 관련 콘텐츠
  if (contents.length < limit && keywords.length > 0) {
    const kws = keywords.slice(0, 5);
    const likeConds = kws.map(() => '(c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ? OR c.achievement_code LIKE ?)').join(' OR ');
    const params = [];
    kws.forEach(k => { const t = `%${k}%`; params.push(t, t, t, t); });
    try {
      const kw = db.prepare(`
        SELECT c.*, u.display_name AS creator_name
        FROM contents c JOIN users u ON c.creator_id = u.id
        WHERE c.is_public = 1 AND c.status = 'approved' AND c.creator_id != ?
        AND (${likeConds})
        ORDER BY c.created_at DESC LIMIT ?
      `).all(userId, ...params, limit - contents.length);
      kw.forEach(c => { if (!existIds.has(c.id)) { contents.push(c); existIds.add(c.id); } });
    } catch {}
  }

  // 3순위: 인기 콘텐츠로 보충
  if (contents.length < limit) {
    const excl = existIds.size ? 'AND c.id NOT IN (' + Array.from(existIds).join(',') + ')' : '';
    const pop = db.prepare(`
      SELECT c.*, u.display_name AS creator_name
      FROM contents c JOIN users u ON c.creator_id = u.id
      WHERE c.is_public = 1 AND c.status = 'approved' AND c.creator_id != ? ${excl}
      ORDER BY c.view_count DESC, c.like_count DESC LIMIT ?
    `).all(userId, limit - contents.length);
    pop.forEach(c => contents.push(c));
  }

  contents.forEach(c => { if (c.tags) { try { c.tags = JSON.parse(c.tags); } catch { c.tags = []; } } });
  return contents;
}

// ========== 내자료 폴더 ==========

function getMyFolders(userId) {
  return db.prepare('SELECT * FROM content_folders WHERE user_id = ? ORDER BY name').all(userId);
}

function createMyFolder(userId, name) {
  const info = db.prepare('INSERT INTO content_folders (user_id, name) VALUES (?, ?)').run(userId, name);
  return { id: info.lastInsertRowid, name };
}

function deleteMyFolder(userId, folderId) {
  db.prepare('UPDATE contents SET folder_id = NULL WHERE creator_id = ? AND folder_id = ?').run(userId, folderId);
  return db.prepare('DELETE FROM content_folders WHERE id = ? AND user_id = ?').run(folderId, userId).changes > 0;
}

function moveContentToFolder(contentId, folderId, userId) {
  return db.prepare('UPDATE contents SET folder_id = ? WHERE id = ? AND creator_id = ?').run(folderId, contentId, userId).changes > 0;
}

// ========== 활동 추이 (실제 데이터) ==========

function getActivityTrend(userId, days = 30, metric = 'views') {
  // 내 콘텐츠의 활동 추이를 일별로 집계
  const activityMap = { views: 'content_view', shares: 'content_share', saves: 'content_save' };
  const actType = activityMap[metric] || 'content_view';

  // learning_logs에서 내 콘텐츠에 대한 활동을 일별 집계
  const rows = db.prepare(`
    SELECT DATE(ll.created_at) as day, COUNT(*) as count
    FROM learning_logs ll
    JOIN contents c ON ll.target_id = c.id AND ll.target_type = 'content'
    WHERE c.creator_id = ? AND ll.activity_type = ?
    AND ll.created_at >= DATE('now', '-' || ? || ' days')
    GROUP BY DATE(ll.created_at)
    ORDER BY day ASC
  `).all(userId, actType, days);

  // 빈 날짜 채우기
  const result = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const found = rows.find(r => r.day === dateStr);
    result.push({ date: dateStr, count: found ? found.count : 0 });
  }
  return result;
}

// ========== 인기 태그 (공개 콘텐츠 기준) ==========

function getPopularTags(limit = 8) {
  const rows = db.prepare("SELECT tags FROM contents WHERE tags IS NOT NULL AND tags != '' AND is_public = 1 AND status = 'approved'").all();
  const count = {};
  rows.forEach(r => {
    try {
      const arr = JSON.parse(r.tags) || [];
      arr.forEach(t => { const k = String(t).trim(); if (k) count[k] = (count[k] || 0) + 1; });
    } catch {}
  });
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, cnt]) => ({ tag, count: cnt }));
}

// ========== 수업꾸러미 아이템 ==========

function saveBundleItems(packageId, items) {
  db.prepare('DELETE FROM package_items WHERE package_id = ?').run(packageId);
  const stmt = db.prepare('INSERT INTO package_items (package_id, content_id, sort_order) VALUES (?, ?, ?)');
  items.forEach(item => {
    try { stmt.run(packageId, item.content_id, item.sort_order || 0); } catch {}
  });
}

function getBundleItems(packageId) {
  return db.prepare(`
    SELECT pi.*, c.title, c.content_type, c.content_url, c.file_path, c.description, c.creator_id, u.display_name as creator_name
    FROM package_items pi
    JOIN contents c ON pi.content_id = c.id
    JOIN users u ON c.creator_id = u.id
    WHERE pi.package_id = ?
    ORDER BY pi.sort_order
  `).all(packageId);
}

// ========== 콘텐츠 댓글 ==========

function getContentComments(contentId) {
  return db.prepare(`
    SELECT cc.*, u.display_name, u.role as user_role
    FROM content_comments cc
    JOIN users u ON cc.user_id = u.id
    WHERE cc.content_id = ?
    ORDER BY cc.created_at ASC
  `).all(contentId);
}

function addContentComment(contentId, userId, text, parentId) {
  const info = db.prepare(`
    INSERT INTO content_comments (content_id, user_id, text, parent_id, created_at)
    VALUES (?, ?, ?, ?, DATETIME('now'))
  `).run(contentId, userId, text, parentId || null);
  return db.prepare(`
    SELECT cc.*, u.display_name, u.role as user_role
    FROM content_comments cc JOIN users u ON cc.user_id = u.id
    WHERE cc.id = ?
  `).get(info.lastInsertRowid);
}

function deleteContentComment(commentId, userId) {
  const comment = db.prepare('SELECT * FROM content_comments WHERE id = ?').get(commentId);
  if (!comment || comment.user_id !== userId) return false;
  db.prepare('DELETE FROM content_comments WHERE id = ?').run(commentId);
  return true;
}

function getContentCommentCount(contentId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM content_comments WHERE content_id = ?').get(contentId).cnt;
}

module.exports = {
  createContent, getContentById, updateContent, deleteContent, incrementViewCount,
  searchPublicContents, getMyContents, searchContentsForLesson,
  addToCollection, removeFromCollection, getCollection, getCollectionFolders, isInCollection,
  createChannel, getChannelById, getUserChannel, updateChannel, getPopularChannels,
  subscribe, unsubscribe, isSubscribed, getUserSubscriptions, getChannelContents,
  toggleLike, getRecommendations,
  getPendingContents, approveContent, rejectContent,
  holdContent, reviewContent, getAllReviewContents,
  getContentComments, addContentComment, deleteContentComment, getContentCommentCount,
  getMyFolders, createMyFolder, deleteMyFolder, moveContentToFolder,
  saveBundleItems, getBundleItems,
  getActivityTrend,
  getPopularTags
};
