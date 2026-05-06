/**
 * db/featured.js — 추천콘텐츠 큐레이션(관리자 직접 기획) 헬퍼
 * 기준 스펙: docs/spec_admin_featured_curation.md
 *
 * 테이블: featured_sections, featured_section_items
 * 시드: planning / recommend / channels / new (4행 고정)
 */
const db = require('./index');
const contentDb = require('./content');

// =====================================================================
//  In-memory 캐시 (뷰어 응답 5분 TTL — 스펙 F-3)
// =====================================================================
const VIEWER_CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = { key: 'featured:v1', value: null, expiresAt: 0 };

function invalidateFeaturedCache() {
  _cache.value = null;
  _cache.expiresAt = 0;
}
function _readFeaturedCache() {
  if (_cache.value && _cache.expiresAt > Date.now()) return _cache.value;
  return null;
}
function _writeFeaturedCache(value) {
  _cache.value = value;
  _cache.expiresAt = Date.now() + VIEWER_CACHE_TTL_MS;
}

// =====================================================================
//  섹션 조회/수정
// =====================================================================

/**
 * 모든 섹션 + 슬롯 갯수 (관리자 화면용)
 * @param {{activeOnly?: boolean}} options
 */
function listSections({ activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE s.is_active = 1' : '';
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM featured_section_items i WHERE i.section_id = s.id) AS item_count
    FROM featured_sections s
    ${where}
    ORDER BY s.sort_order ASC, s.id ASC
  `).all();
}

function getSection(id) {
  return db.prepare(`SELECT * FROM featured_sections WHERE id = ?`).get(id);
}

function getSectionByKey(key) {
  return db.prepare(`SELECT * FROM featured_sections WHERE key = ?`).get(key);
}

/**
 * 섹션 메타 부분 갱신 (화이트리스트 기반)
 * @param {number} id
 * @param {object} payload
 * @param {number} userId
 * @returns {object} { ok, code?, section? }
 */
function updateSection(id, payload = {}, userId = null) {
  const allowed = ['title', 'subtitle', 'layout', 'sort_order', 'is_active', 'fallback_enabled', 'max_items'];
  const fields = [];
  const params = [];
  for (const key of allowed) {
    if (payload[key] === undefined) continue;
    let v = payload[key];
    if (key === 'is_active' || key === 'fallback_enabled') v = v ? 1 : 0;
    if (key === 'sort_order' || key === 'max_items') v = parseInt(v, 10) || 0;
    fields.push(`${key} = ?`);
    params.push(v);
  }
  if (fields.length === 0) {
    const section = getSection(id);
    return section ? { ok: true, section } : { ok: false, code: 'NOT_FOUND' };
  }

  // 낙관적 동시성 검사 (선택)
  if (payload.expected_updated_at) {
    const cur = db.prepare('SELECT updated_at FROM featured_sections WHERE id = ?').get(id);
    if (!cur) return { ok: false, code: 'NOT_FOUND' };
    if (cur.updated_at !== payload.expected_updated_at) {
      return { ok: false, code: 'STALE_UPDATE' };
    }
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  if (userId) { fields.push('updated_by = ?'); params.push(userId); }
  params.push(id);

  const info = db.prepare(`UPDATE featured_sections SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return { ok: false, code: 'NOT_FOUND' };
  invalidateFeaturedCache();
  return { ok: true, section: getSection(id) };
}

/**
 * 섹션 순서 일괄 갱신
 * @param {Array<{id:number, sort_order:number}>} order
 * @param {number} userId
 */
function reorderSections(order = [], userId = null) {
  if (!Array.isArray(order) || order.length === 0) return { ok: false, code: 'INVALID_PAYLOAD' };
  const stmt = db.prepare(`
    UPDATE featured_sections
       SET sort_order = ?, updated_at = CURRENT_TIMESTAMP, updated_by = COALESCE(?, updated_by)
     WHERE id = ?
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const sid = parseInt(row.id, 10);
      const so = parseInt(row.sort_order, 10);
      if (!sid || Number.isNaN(so)) continue;
      stmt.run(so, userId || null, sid);
    }
  });
  tx(order);
  invalidateFeaturedCache();
  return { ok: true };
}

// =====================================================================
//  슬롯 (items) 조회/수정
// =====================================================================

/**
 * 관리자용: 섹션 내 모든 슬롯 + 콘텐츠/채널 상세 (비공개·삭제도 포함하되 is_visible 플래그)
 */
function listSectionItems(sectionId) {
  const items = db.prepare(`
    SELECT * FROM featured_section_items
    WHERE section_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(sectionId);

  return items.map(it => {
    const snapshot = _hydrateItemSnapshot(it.item_type, it.item_id, /*forAdmin*/true);
    return { ...it, snapshot };
  });
}

/**
 * 뷰어용: 비공개/삭제/미승인은 자동 필터, 응답에서 빠짐
 */
function _listVisibleSectionItems(sectionId, maxItems = 8) {
  const items = db.prepare(`
    SELECT * FROM featured_section_items
    WHERE section_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(sectionId);

  const out = [];
  for (const it of items) {
    const snap = _hydrateItemSnapshot(it.item_type, it.item_id, /*forAdmin*/false);
    if (!snap) continue;
    out.push({
      type: it.item_type,
      id: it.item_id,
      slot_id: it.id,
      badge_label: it.badge_label || null,
      ...snap
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 콘텐츠/채널 상세 조회 + 가시성 판정
 */
function _hydrateItemSnapshot(item_type, item_id, forAdmin = false) {
  if (item_type === 'content') {
    const row = db.prepare(`
      SELECT c.id, c.title, c.thumbnail_url, c.content_type, c.subject, c.grade,
             c.view_count, c.like_count, c.is_public, c.status,
             u.display_name AS creator_name
        FROM contents c
        JOIN users u ON c.creator_id = u.id
       WHERE c.id = ?
    `).get(item_id);
    if (!row) return forAdmin ? { is_visible: false, deleted: true } : null;
    const visible = row.is_public === 1 && row.status === 'approved';
    if (!forAdmin && !visible) return null;
    return {
      title: row.title,
      thumbnail_url: row.thumbnail_url,
      content_type: row.content_type,
      subject: row.subject,
      grade: row.grade,
      view_count: row.view_count,
      like_count: row.like_count,
      creator_name: row.creator_name,
      is_visible: visible
    };
  }
  if (item_type === 'channel') {
    const row = db.prepare(`
      SELECT ch.id, ch.name, ch.description, ch.subscriber_count, ch.content_count, ch.status,
             u.display_name AS owner_name
        FROM channels ch
        JOIN users u ON ch.user_id = u.id
       WHERE ch.id = ?
    `).get(item_id);
    if (!row) return forAdmin ? { is_visible: false, deleted: true } : null;
    const visible = row.status === 'active';
    if (!forAdmin && !visible) return null;
    return {
      name: row.name,
      description: row.description,
      subscriber_count: row.subscriber_count,
      content_count: row.content_count,
      owner_name: row.owner_name,
      is_visible: visible
    };
  }
  return null;
}

/**
 * 슬롯 추가 — 끝(MAX+10)에 붙임
 */
function addSectionItem(sectionId, item_type, item_id, payload = {}, userId = null) {
  const section = getSection(sectionId);
  if (!section) return { ok: false, code: 'NOT_FOUND', message: '섹션이 존재하지 않습니다.' };

  // section.item_type 일치 검증
  if (section.item_type !== item_type) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: `이 섹션은 ${section.item_type} 타입만 추가할 수 있습니다.` };
  }

  // 대상 존재 검증
  if (item_type === 'content') {
    const c = db.prepare(`SELECT id, is_public, status FROM contents WHERE id = ?`).get(item_id);
    if (!c) return { ok: false, code: 'NOT_FOUND', message: '콘텐츠가 존재하지 않습니다.' };
  } else if (item_type === 'channel') {
    const ch = db.prepare(`SELECT id FROM channels WHERE id = ?`).get(item_id);
    if (!ch) return { ok: false, code: 'NOT_FOUND', message: '채널이 존재하지 않습니다.' };
  } else {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'item_type이 올바르지 않습니다.' };
  }

  // 중복 검사 (UNIQUE 인덱스 의존 + 사전 명시 검사)
  const dup = db.prepare(`
    SELECT id FROM featured_section_items
    WHERE section_id = ? AND item_type = ? AND item_id = ?
  `).get(sectionId, item_type, item_id);
  if (dup) return { ok: false, code: 'DUPLICATE', message: '이미 이 섹션에 추가된 항목입니다.' };

  // 정렬값: MAX(sort_order)+10
  const cur = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM featured_section_items WHERE section_id = ?`).get(sectionId);
  const newOrder = (cur?.m || 0) + 10;

  try {
    const info = db.prepare(`
      INSERT INTO featured_section_items
        (section_id, item_type, item_id, sort_order, badge_label, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sectionId, item_type, parseInt(item_id, 10), newOrder,
      (payload.badge_label || null),
      (payload.note || null),
      userId
    );
    invalidateFeaturedCache();
    const item = db.prepare(`SELECT * FROM featured_section_items WHERE id = ?`).get(info.lastInsertRowid);
    return { ok: true, item };
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return { ok: false, code: 'DUPLICATE', message: '이미 이 섹션에 추가된 항목입니다.' };
    }
    throw e;
  }
}

function removeSectionItem(itemId) {
  const info = db.prepare(`DELETE FROM featured_section_items WHERE id = ?`).run(itemId);
  if (info.changes === 0) return { ok: false, code: 'NOT_FOUND' };
  invalidateFeaturedCache();
  return { ok: true };
}

/**
 * 슬롯 순서 일괄 갱신 (같은 섹션 내에서만)
 */
function reorderItems(sectionId, order = []) {
  if (!Array.isArray(order) || order.length === 0) return { ok: false, code: 'INVALID_PAYLOAD' };

  // 같은 섹션 소속인지 검증
  const ids = order.map(o => parseInt(o.id, 10)).filter(Boolean);
  if (ids.length === 0) return { ok: false, code: 'INVALID_PAYLOAD' };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, section_id FROM featured_section_items WHERE id IN (${placeholders})`).all(...ids);
  for (const r of rows) {
    if (r.section_id !== parseInt(sectionId, 10)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: '다른 섹션의 슬롯이 포함되어 있습니다.' };
    }
  }

  const stmt = db.prepare(`UPDATE featured_section_items SET sort_order = ? WHERE id = ?`);
  const tx = db.transaction((rows2) => {
    for (const row of rows2) {
      const iid = parseInt(row.id, 10);
      const so = parseInt(row.sort_order, 10);
      if (!iid || Number.isNaN(so)) continue;
      stmt.run(so, iid);
    }
  });
  tx(order);
  invalidateFeaturedCache();
  return { ok: true };
}

// =====================================================================
//  뷰어 통합 — 폴백 적용 (스펙 F-1)
// =====================================================================

/**
 * 모든 활성 섹션 + items + 폴백 적용
 * @param {{user?: object}} ctx — 로그인 사용자(선택)
 */
function getFeaturedForViewer({ user = null } = {}) {
  // 캐시 (응답이 역할별로 다르지 않으므로 단일 키 사용 — 단, fallback이 user 의존이라 user 단위로 분리)
  // 단순화를 위해 캐시는 비로그인 응답에만 적용
  if (!user) {
    const cached = _readFeaturedCache();
    if (cached) return cached;
  }

  const sections = listSections({ activeOnly: true });
  const result = sections.map(s => {
    const max = s.max_items || 8;
    let items = _listVisibleSectionItems(s.id, max);
    let isFallback = false;

    // 폴백 결정: planning/recommend는 1건 이상이면 폴백 X. channels/new는 부족분 보충.
    const needsFallback = s.fallback_enabled === 1 && items.length < max;
    const allowFallback =
      (s.key === 'planning' || s.key === 'recommend')
        ? items.length === 0          // 슬롯이 비었을 때만 폴백
        : true;                        // channels / new 는 항상 부족분 보충

    if (needsFallback && allowFallback) {
      const fallbackItems = _buildFallback(s, max - items.length, user, items);
      if (fallbackItems.length > 0) {
        items = items.concat(fallbackItems);
        isFallback = items.every(it => it._fallback) || items.length === fallbackItems.length;
        // 메타에서 _fallback 마커 제거
        items = items.map(it => { const { _fallback, ...rest } = it; return rest; });
      }
    }

    return {
      key: s.key,
      title: s.title,
      subtitle: s.subtitle,
      layout: s.layout,
      item_type: s.item_type,
      max_items: max,
      is_fallback: isFallback,
      items: items.slice(0, max)
    };
  });

  const payload = { success: true, sections: result };
  if (!user) _writeFeaturedCache(payload);
  return payload;
}

/**
 * 폴백 아이템 생성 — 기존 콘텐츠 추천/채널 인기를 그대로 사용
 */
function _buildFallback(section, count, user, currentItems) {
  if (count <= 0) return [];

  if (section.item_type === 'channel') {
    // 인기 채널 — 이미 슬롯에 있는 채널 제외
    const existing = new Set(currentItems.map(it => it.id));
    const channels = contentDb.getPopularChannels(count + existing.size);
    return channels
      .filter(ch => !existing.has(ch.id))
      .slice(0, count)
      .map(ch => ({
        type: 'channel',
        id: ch.id,
        name: ch.name,
        description: ch.description,
        subscriber_count: ch.subscriber_count,
        content_count: ch.content_count,
        owner_name: ch.owner_name,
        is_visible: true,
        _fallback: true
      }));
  }

  // content 폴백 — getRecommendations 사용
  const userId = user?.id || 0;
  const opts = {};
  if (user) {
    if (user.role) opts.role = user.role;
    if ((user.role === 'student' || user.role === 'teacher') && user.grade) opts.grade = user.grade;
  }
  const existing = new Set(currentItems.map(it => it.id));
  const recos = contentDb.getRecommendations(userId, count + existing.size, [], opts);
  return recos
    .filter(c => !existing.has(c.id))
    .slice(0, count)
    .map(c => ({
      type: 'content',
      id: c.id,
      title: c.title,
      thumbnail_url: c.thumbnail_url,
      content_type: c.content_type,
      subject: c.subject,
      grade: c.grade,
      view_count: c.view_count,
      like_count: c.like_count,
      creator_name: c.creator_name,
      is_visible: true,
      _fallback: true
    }));
}

// =====================================================================
//  검색 (관리자 큐레이션 모달용)
// =====================================================================

/**
 * @param {{type: 'content'|'channel', q?, subject?, grade?, content_type?, page?, pageSize?, section_id?}} params
 */
function searchForCuration(params = {}) {
  const type = (params.type === 'channel') ? 'channel' : 'content';
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const pageSize = Math.min(60, Math.max(4, parseInt(params.pageSize, 10) || 12));
  const offset = (page - 1) * pageSize;
  const q = (params.q || '').trim();
  const sectionId = params.section_id ? parseInt(params.section_id, 10) : null;

  if (type === 'content') {
    const where = [`c.is_public = 1`, `c.status = 'approved'`];
    const args = [];
    if (q) {
      where.push(`(c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ? OR u.display_name LIKE ?)`);
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    if (params.subject) { where.push(`c.subject = ?`); args.push(params.subject); }
    if (params.grade) { where.push(`c.grade = ?`); args.push(parseInt(params.grade, 10)); }
    if (params.content_type) { where.push(`c.content_type = ?`); args.push(params.content_type); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`
      SELECT COUNT(*) AS cnt
        FROM contents c JOIN users u ON c.creator_id = u.id
        ${whereSql}
    `).get(...args).cnt;
    const rows = db.prepare(`
      SELECT c.id, c.title, c.thumbnail_url, c.content_type, c.subject, c.grade,
             c.view_count, c.like_count, c.created_at,
             u.display_name AS creator_name
        FROM contents c JOIN users u ON c.creator_id = u.id
        ${whereSql}
       ORDER BY c.view_count DESC, c.created_at DESC
       LIMIT ? OFFSET ?
    `).all(...args, pageSize, offset);

    let alreadySet = new Set();
    if (sectionId) {
      const ex = db.prepare(`
        SELECT item_id FROM featured_section_items
        WHERE section_id = ? AND item_type = 'content'
      `).all(sectionId);
      alreadySet = new Set(ex.map(e => e.item_id));
    }
    const items = rows.map(r => ({
      type: 'content',
      ...r,
      already_in_section: sectionId ? alreadySet.has(r.id) : false
    }));
    return {
      success: true,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items
    };
  }

  // channel
  const where = [`ch.status = 'active'`];
  const args = [];
  if (q) {
    where.push(`(ch.name LIKE ? OR ch.description LIKE ? OR u.display_name LIKE ?)`);
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM channels ch JOIN users u ON ch.user_id = u.id
      ${whereSql}
  `).get(...args).cnt;
  const rows = db.prepare(`
    SELECT ch.id, ch.name, ch.description, ch.subscriber_count, ch.content_count, ch.created_at,
           u.display_name AS owner_name
      FROM channels ch JOIN users u ON ch.user_id = u.id
      ${whereSql}
     ORDER BY ch.subscriber_count DESC, ch.content_count DESC
     LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset);

  let alreadySet = new Set();
  if (sectionId) {
    const ex = db.prepare(`
      SELECT item_id FROM featured_section_items
      WHERE section_id = ? AND item_type = 'channel'
    `).all(sectionId);
    alreadySet = new Set(ex.map(e => e.item_id));
  }
  const items = rows.map(r => ({
    type: 'channel',
    ...r,
    already_in_section: sectionId ? alreadySet.has(r.id) : false
  }));
  return {
    success: true,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items
  };
}

module.exports = {
  // sections
  listSections,
  getSection,
  getSectionByKey,
  updateSection,
  reorderSections,
  // items
  listSectionItems,
  addSectionItem,
  removeSectionItem,
  reorderItems,
  // viewer
  getFeaturedForViewer,
  // search
  searchForCuration,
  // cache
  invalidateFeaturedCache
};
