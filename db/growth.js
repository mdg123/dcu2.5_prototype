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
// opts: { startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' }
function getClassGrowthOverview(classId, opts = {}) {
  const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const startDate = isIso(opts.startDate) ? opts.startDate : null;
  const endDate = isIso(opts.endDate) ? opts.endDate : null;

  const members = db.prepare(`
    SELECT cm.user_id, u.display_name, u.username
    FROM class_members cm JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.role = 'member' AND u.role = 'student'
    ORDER BY u.display_name
  `).all(classId);

  // learning_logs 용 기간 필터 (created_at 기준)
  function logsRange(extraParams) {
    const conds = ['user_id = ?', 'class_id = ?'];
    const params = [...extraParams];
    if (startDate) { conds.push('created_at >= ?'); params.push(startDate + ' 00:00:00'); }
    if (endDate)   { conds.push('created_at <= ?'); params.push(endDate + ' 23:59:59'); }
    return { sql: conds.join(' AND '), params };
  }

  // portfolios 용 기간 필터 (created_at 기준)
  function pfRange(extraParams) {
    const conds = ['student_id = ?', 'class_id = ?'];
    const params = [...extraParams];
    if (startDate) { conds.push('created_at >= ?'); params.push(startDate + ' 00:00:00'); }
    if (endDate)   { conds.push('created_at <= ?'); params.push(endDate + ' 23:59:59'); }
    return { sql: conds.join(' AND '), params };
  }

  const studentStats = members.map(m => {
    const w1 = logsRange([m.user_id, classId]);
    const activityCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM learning_logs WHERE ${w1.sql}`
    ).get(...w1.params).cnt;

    const w2 = logsRange([m.user_id, classId]);
    const totalTime = db.prepare(
      `SELECT COALESCE(SUM(CAST(result_duration AS INTEGER)), 0) as total FROM learning_logs WHERE ${w2.sql}`
    ).get(...w2.params).total;

    const w3 = pfRange([m.user_id, classId]);
    const portfolioCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM portfolios WHERE ${w3.sql}`
    ).get(...w3.params).cnt;

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
    INSERT INTO student_gallery (student_id, title, description, image_url, category, approval_status, source_post_id, source, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(studentId, data.title, data.description || null, data.image_url || '/images/placeholder.png',
    data.category || 'art', data.approval_status || 'pending', data.source_post_id || null,
    data.source || null, data.body_text || null);
  return db.prepare('SELECT * FROM student_gallery WHERE id = ?').get(info.lastInsertRowid);
}

// 멀티미디어 작품 등록 (트랜잭션: student_gallery + gallery_attachments)
// data: { title, description?, body_text?, category, attachments: [{type, url, mime?, file_name?, file_size?, sort_order?}] }
// attachments 또는 body_text 중 하나 이상 필요. attachments 10개 제한, body_text 1000자 제한.
function createGalleryItemWithAttachments(studentId, data) {
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const bodyText = data.body_text ? String(data.body_text) : '';

  // 검증
  if (attachments.length === 0 && !bodyText.trim()) {
    const err = new Error('작품 내용을 한 가지 이상 첨부해주세요.');
    err.status = 400; throw err;
  }
  if (attachments.length > 10) {
    const err = new Error('첨부는 최대 10개까지 등록할 수 있습니다.');
    err.status = 400; throw err;
  }
  if (bodyText.length > 1000) {
    const err = new Error('글 본문은 1000자 이하로 입력해주세요.');
    err.status = 400; throw err;
  }
  const allowedTypes = new Set(['image', 'video', 'audio', 'youtube']);
  for (const a of attachments) {
    if (!a || !a.type || !a.url) {
      const err = new Error('첨부 정보가 올바르지 않습니다.');
      err.status = 400; throw err;
    }
    if (!allowedTypes.has(a.type)) {
      const err = new Error('지원하지 않는 첨부 타입입니다.');
      err.status = 400; throw err;
    }
    if (a.type === 'youtube' && !/^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(String(a.url))) {
      const err = new Error('YouTube 주소 형식이 올바르지 않습니다.');
      err.status = 400; throw err;
    }
  }

  // 대표 이미지 결정: attachments 중 첫 image의 url (없으면 placeholder)
  const firstImg = attachments.find(a => a.type === 'image');
  const imageUrl = firstImg ? firstImg.url : '/images/placeholder.png';

  // 대표 타입 (mixed/image/video/audio/writing)
  let primaryType = 'mixed';
  if (attachments.length === 0 && bodyText.trim()) primaryType = 'writing';
  else if (attachments.length === 1) {
    const t = attachments[0].type;
    primaryType = (t === 'youtube') ? 'video' : t;
  } else if (attachments.every(a => a.type === 'image')) primaryType = 'image';
  else if (attachments.every(a => a.type === 'video' || a.type === 'youtube')) primaryType = 'video';
  else if (attachments.every(a => a.type === 'audio')) primaryType = 'audio';

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO student_gallery (student_id, title, description, image_url, category, approval_status, source, body_text, type)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      studentId,
      data.title,
      data.description || null,
      imageUrl,
      data.category || 'art',
      data.source || null,
      bodyText || null,
      primaryType
    );
    const galleryId = info.lastInsertRowid;

    if (attachments.length > 0) {
      const insAtt = db.prepare(`
        INSERT INTO gallery_attachments (gallery_id, type, url, mime, file_name, file_size, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      attachments.forEach((a, idx) => {
        insAtt.run(
          galleryId,
          a.type,
          String(a.url).slice(0, 1000),
          a.mime ? String(a.mime).slice(0, 100) : null,
          a.file_name ? String(a.file_name).slice(0, 200) : null,
          a.file_size != null ? parseInt(a.file_size, 10) || null : null,
          a.sort_order != null ? parseInt(a.sort_order, 10) : idx
        );
      });
    }
    return galleryId;
  });

  const newId = tx();
  return getGalleryItemWithAttachments(newId);
}

// 단건 조회 + attachments 배열 포함
function getGalleryItemWithAttachments(id, viewerId = null) {
  const row = db.prepare(`
    SELECT g.*, u.display_name AS student_name, u.school_name, u.school_level,
      (SELECT COUNT(*) FROM gallery_comments c WHERE c.gallery_id = g.id) AS comment_count,
      CASE WHEN ? IS NULL THEN 0
        ELSE (SELECT COUNT(*) FROM gallery_likes l WHERE l.gallery_id = g.id AND l.user_id = ?)
      END AS liked_by_me
    FROM student_gallery g JOIN users u ON g.student_id = u.id
    WHERE g.id = ? AND g.deleted_at IS NULL
  `).get(viewerId, viewerId, id);
  if (!row) return null;
  row.liked_by_me = !!row.liked_by_me;
  row.attachments = db.prepare(`
    SELECT id, type, url, mime, file_name, file_size, sort_order, created_at
    FROM gallery_attachments
    WHERE gallery_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(id);
  return row;
}

// 작품 첨부 전체 교체 + body_text 갱신 + 기본 필드 업데이트
function updateGalleryItemWithAttachments(id, data) {
  const attachments = Array.isArray(data.attachments) ? data.attachments : null;
  const bodyText = data.body_text != null ? String(data.body_text) : null;

  if (bodyText != null && bodyText.length > 1000) {
    const err = new Error('글 본문은 1000자 이하로 입력해주세요.');
    err.status = 400; throw err;
  }
  if (attachments && attachments.length > 10) {
    const err = new Error('첨부는 최대 10개까지 등록할 수 있습니다.');
    err.status = 400; throw err;
  }
  const allowedTypes = new Set(['image', 'video', 'audio', 'youtube']);
  if (attachments) {
    for (const a of attachments) {
      if (!a || !a.type || !a.url) {
        const err = new Error('첨부 정보가 올바르지 않습니다.');
        err.status = 400; throw err;
      }
      if (!allowedTypes.has(a.type)) {
        const err = new Error('지원하지 않는 첨부 타입입니다.');
        err.status = 400; throw err;
      }
      if (a.type === 'youtube' && !/^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(String(a.url))) {
        const err = new Error('YouTube 주소 형식이 올바르지 않습니다.');
        err.status = 400; throw err;
      }
    }
  }

  // 최종 attachments + bodyText 중 1개 이상 필요 (전부 비우는 것 금지)
  const willHaveAttachments = attachments ? attachments.length : null;
  const willHaveBody = bodyText != null ? bodyText.trim() : null;

  const tx = db.transaction(() => {
    // 기본 필드 업데이트
    const fields = [];
    const params = [];
    for (const key of ['title', 'description', 'category', 'tags']) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(data[key]);
      }
    }
    if (bodyText != null) {
      fields.push('body_text = ?');
      params.push(bodyText || null);
    }

    // attachments 전체 교체
    if (attachments) {
      db.prepare('DELETE FROM gallery_attachments WHERE gallery_id = ?').run(id);
      if (attachments.length > 0) {
        const insAtt = db.prepare(`
          INSERT INTO gallery_attachments (gallery_id, type, url, mime, file_name, file_size, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        attachments.forEach((a, idx) => {
          insAtt.run(
            id,
            a.type,
            String(a.url).slice(0, 1000),
            a.mime ? String(a.mime).slice(0, 100) : null,
            a.file_name ? String(a.file_name).slice(0, 200) : null,
            a.file_size != null ? parseInt(a.file_size, 10) || null : null,
            a.sort_order != null ? parseInt(a.sort_order, 10) : idx
          );
        });

        // 대표 이미지/타입 갱신
        const firstImg = attachments.find(a => a.type === 'image');
        if (firstImg) {
          fields.push('image_url = ?');
          params.push(firstImg.url);
        }
        let primaryType;
        if (attachments.length === 1) {
          const t = attachments[0].type;
          primaryType = (t === 'youtube') ? 'video' : t;
        } else if (attachments.every(a => a.type === 'image')) primaryType = 'image';
        else if (attachments.every(a => a.type === 'video' || a.type === 'youtube')) primaryType = 'video';
        else if (attachments.every(a => a.type === 'audio')) primaryType = 'audio';
        else primaryType = 'mixed';
        fields.push('type = ?');
        params.push(primaryType);
      } else if (willHaveBody) {
        // 첨부 모두 제거 + body만 있음 → writing
        fields.push('type = ?');
        params.push('writing');
      }
    }

    // 최종 비어있는지 검증 (DB 상태 기준)
    const finalAttCount = attachments != null
      ? attachments.length
      : db.prepare('SELECT COUNT(*) AS c FROM gallery_attachments WHERE gallery_id = ?').get(id).c;
    const finalBody = bodyText != null
      ? bodyText
      : (db.prepare('SELECT body_text FROM student_gallery WHERE id = ?').get(id) || {}).body_text || '';
    if (finalAttCount === 0 && !String(finalBody || '').trim()) {
      const err = new Error('작품 내용을 한 가지 이상 첨부해주세요.');
      err.status = 400; throw err;
    }

    if (fields.length > 0) {
      params.push(id);
      db.prepare(`UPDATE student_gallery SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    }
  });

  tx();
  return getGalleryItemWithAttachments(id);
}

function getGalleryItemById(id, viewerId = null) {
  const row = db.prepare(`
    SELECT g.*, u.display_name AS student_name,
      (SELECT COUNT(*) FROM gallery_comments c WHERE c.gallery_id = g.id) AS comment_count,
      CASE WHEN ? IS NULL THEN 0
        ELSE (SELECT COUNT(*) FROM gallery_likes l WHERE l.gallery_id = g.id AND l.user_id = ?)
      END AS liked_by_me
    FROM student_gallery g JOIN users u ON g.student_id = u.id
    WHERE g.id = ? AND g.deleted_at IS NULL
  `).get(viewerId, viewerId, id);
  if (!row) return null;
  row.liked_by_me = !!row.liked_by_me;
  return row;
}

// 갤러리 목록 — 다중 필터 지원
// opts:
//   studentId      : 특정 학생 작품만 (보통 mine=true → req.user.id)
//   category       : art|music|writing|video|other|all
//   page, limit
//   includeAll     : true (교사/관리자) → pending/rejected 모두 노출
//   sort           : latest|likes|views|comments
//   q              : 검색 키워드
//   viewerId       : 본인 좋아요 여부 + is_mine 판정용
//   showMine       : true 인 경우 viewer 본인 작품은 approval_status 무관하게 노출
//   schoolName     : 정확히 일치하는 작성자의 school_name
//   schoolLevel    : elementary|middle|high → users.school_level 매칭
//   periodFrom     : 'YYYY-MM-DD' (created_at >= )
//   periodTo       : 'YYYY-MM-DD' (created_at <= )
//   period         : today|week|month|year (periodFrom/To 미지정 시 보조 사용)
function getGalleryItems({
  studentId, category, page = 1, limit = 20, includeAll,
  sort = 'latest', q = null, viewerId = null,
  showMine = false, schoolName = null, schoolLevel = null,
  periodFrom = null, periodTo = null, period = null
} = {}) {
  let where = ' WHERE g.deleted_at IS NULL';
  const params = [];
  if (studentId) { where += ' AND g.student_id = ?'; params.push(studentId); }
  if (category && category !== 'all') { where += ' AND g.category = ?'; params.push(category); }

  // 노출 정책 (memory project_artist_approval_principle.md 준수):
  // - includeAll(교사/관리자) : 모든 상태 노출 (관리자 화면 전용)
  // - showMine(mine=true) : 본인 작품 전체(상태 무관) — "내 작품" 탭
  // - 그 외 (일반 갤러리 탭) : approved 만 노출. 본인 pending 도 노출하지 않음 (승인 원칙 절대 준수)
  if (!includeAll) {
    if (showMine && viewerId) {
      // showMine 호출이면 studentId=viewerId 가 이미 적용됨. 별도 status 제한 없이 본인 작품 전체 노출.
    } else {
      where += " AND (g.approval_status = 'approved' OR g.approval_status IS NULL)";
    }
  }

  // 학교명 정확 일치
  if (schoolName) {
    where += ' AND u.school_name = ?';
    params.push(String(schoolName));
  }
  // 학교급 (elementary/middle/high) — DB의 실제 저장값과 한국어 변형 모두 허용
  if (schoolLevel) {
    const lvl = String(schoolLevel).toLowerCase();
    const krMap = { elementary: '초', middle: '중', high: '고' };
    const krVal = krMap[lvl];
    // users.school_level 컬럼은 시드에 따라 'elementary' 또는 '초' 둘 다 존재할 수 있음 → OR 매칭
    if (krVal) {
      where += ' AND (u.school_level = ? OR u.school_level = ?)';
      params.push(lvl, krVal);
    } else {
      where += ' AND u.school_level = ?';
      params.push(schoolLevel);
    }
  }

  // 기간 필터 — period 가 있으면 from/to 자동 계산 (둘 다 미지정 시)
  if (!periodFrom && !periodTo && period) {
    const today = new Date();
    const yyyy = today.toISOString().slice(0, 10);
    let fromDate;
    if (period === 'today') {
      fromDate = yyyy;
    } else if (period === 'week') {
      const d = new Date(today); d.setDate(d.getDate() - 7);
      fromDate = d.toISOString().slice(0, 10);
    } else if (period === 'month') {
      const d = new Date(today); d.setDate(d.getDate() - 30);
      fromDate = d.toISOString().slice(0, 10);
    } else if (period === 'year') {
      const d = new Date(today); d.setFullYear(d.getFullYear() - 1);
      fromDate = d.toISOString().slice(0, 10);
    }
    if (fromDate) { periodFrom = fromDate; }
  }
  if (periodFrom) { where += " AND date(g.created_at) >= date(?)"; params.push(String(periodFrom)); }
  if (periodTo)   { where += " AND date(g.created_at) <= date(?)"; params.push(String(periodTo)); }

  // 검색 (제목·설명·작가명·태그)
  if (q && String(q).trim()) {
    const kw = '%' + String(q).trim().toLowerCase() + '%';
    where += ' AND (LOWER(g.title) LIKE ? OR LOWER(COALESCE(g.description,\'\')) LIKE ? OR LOWER(u.display_name) LIKE ? OR LOWER(COALESCE(g.tags,\'\')) LIKE ?)';
    params.push(kw, kw, kw, kw);
  }

  // 정렬 화이트리스트
  let orderBy;
  switch (sort) {
    case 'likes': orderBy = 'g.like_count DESC, g.created_at DESC'; break;
    case 'views': orderBy = 'g.view_count DESC, g.created_at DESC'; break;
    case 'comments': orderBy = 'comment_count DESC, g.created_at DESC'; break;
    case 'popular': orderBy = '(g.like_count * 3 + COALESCE(g.view_count,0)) DESC, g.created_at DESC'; break;
    case 'latest':
    default: orderBy = 'g.created_at DESC';
  }

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM student_gallery g JOIN users u ON g.student_id = u.id
    ${where}
  `).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;

  const items = db.prepare(`
    SELECT g.*, u.display_name AS student_name, u.school_name AS school_name, u.school_level AS school_level,
      (SELECT COUNT(*) FROM gallery_comments c WHERE c.gallery_id = g.id) AS comment_count,
      CASE WHEN ? IS NULL THEN 0
        ELSE (SELECT COUNT(*) FROM gallery_likes l WHERE l.gallery_id = g.id AND l.user_id = ?)
      END AS liked_by_me,
      CASE WHEN ? IS NULL THEN 0
        WHEN g.student_id = ? THEN 1 ELSE 0 END AS is_mine,
      (SELECT COUNT(*) FROM gallery_attachments a WHERE a.gallery_id = g.id) AS attachment_count,
      CASE WHEN EXISTS (
        SELECT 1 FROM gallery_attachments a
        WHERE a.gallery_id = g.id AND (a.type = 'video' OR a.type = 'youtube')
      ) THEN 1 ELSE 0 END AS has_video,
      CASE WHEN EXISTS (
        SELECT 1 FROM gallery_attachments a
        WHERE a.gallery_id = g.id AND a.type = 'audio'
      ) THEN 1 ELSE 0 END AS has_audio
    FROM student_gallery g JOIN users u ON g.student_id = u.id
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(viewerId, viewerId, viewerId, viewerId, ...params, limit, (page - 1) * limit);

  // boolean 변환
  for (const it of items) {
    it.liked_by_me = !!it.liked_by_me;
    it.is_mine = !!it.is_mine;
    it.has_video = !!it.has_video;
    it.has_audio = !!it.has_audio;
  }

  return { items, total, totalPages };
}

// 인기 작품: like*3 + view*1 가중치
// opts: period='week'|'month'|'all', limit=6
function getPopularGalleryItems({ period = 'week', limit = 6, viewerId = null } = {}) {
  let dateCond = '';
  const params = [];
  if (period === 'week') {
    dateCond = " AND date(g.created_at) >= date('now','-7 days')";
  } else if (period === 'month') {
    dateCond = " AND date(g.created_at) >= date('now','-30 days')";
  } // 'all' 은 무조건

  const lim = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 50);

  const items = db.prepare(`
    SELECT g.*, u.display_name AS student_name, u.school_name AS school_name, u.school_level AS school_level,
      (SELECT COUNT(*) FROM gallery_comments c WHERE c.gallery_id = g.id) AS comment_count,
      CASE WHEN ? IS NULL THEN 0
        ELSE (SELECT COUNT(*) FROM gallery_likes l WHERE l.gallery_id = g.id AND l.user_id = ?)
      END AS liked_by_me,
      CASE WHEN ? IS NULL THEN 0
        WHEN g.student_id = ? THEN 1 ELSE 0 END AS is_mine,
      (g.like_count * 3 + COALESCE(g.view_count, 0)) AS popularity_score
    FROM student_gallery g
    JOIN users u ON g.student_id = u.id
    WHERE g.deleted_at IS NULL
      AND (g.approval_status = 'approved' OR g.approval_status IS NULL)
      ${dateCond}
    ORDER BY popularity_score DESC, g.created_at DESC
    LIMIT ?
  `).all(viewerId, viewerId, viewerId, viewerId, ...params, lim);

  for (const it of items) {
    it.liked_by_me = !!it.liked_by_me;
    it.is_mine = !!it.is_mine;
  }
  return items;
}

// 좋아요 토글: gallery_likes (gallery_id, user_id) UNIQUE 활용
// 반환: { liked: boolean, like_count: number }
function toggleGalleryLike(galleryId, userId) {
  const exists = db.prepare('SELECT 1 FROM gallery_likes WHERE gallery_id = ? AND user_id = ?').get(galleryId, userId);
  const tx = db.transaction(() => {
    if (exists) {
      db.prepare('DELETE FROM gallery_likes WHERE gallery_id = ? AND user_id = ?').run(galleryId, userId);
      db.prepare('UPDATE student_gallery SET like_count = MAX(0, like_count - 1) WHERE id = ?').run(galleryId);
    } else {
      db.prepare('INSERT INTO gallery_likes (gallery_id, user_id) VALUES (?, ?)').run(galleryId, userId);
      db.prepare('UPDATE student_gallery SET like_count = like_count + 1 WHERE id = ?').run(galleryId);
    }
  });
  tx();
  const row = db.prepare('SELECT like_count FROM student_gallery WHERE id = ?').get(galleryId);
  return { liked: !exists, like_count: row ? row.like_count : 0 };
}

// 조회수 +1: 같은 (gallery_id, user_id, view_date) UNIQUE → 같은 날 1회만 카운트
// 자기 작품은 카운트 제외(라우터에서 처리)
function recordGalleryView(galleryId, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    const info = db.prepare(
      'INSERT OR IGNORE INTO gallery_views (gallery_id, user_id, view_date) VALUES (?, ?, ?)'
    ).run(galleryId, userId, today);
    if (info.changes > 0) {
      db.prepare('UPDATE student_gallery SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').run(galleryId);
    }
    return info.changes > 0;
  });
  const counted = tx();
  const row = db.prepare('SELECT view_count FROM student_gallery WHERE id = ?').get(galleryId);
  return { counted, view_count: row ? row.view_count : 0 };
}

function approveGalleryItem(id, approvedBy) {
  db.prepare("UPDATE student_gallery SET approval_status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(approvedBy, id);
}

function rejectGalleryItem(id, reason = null) {
  db.prepare("UPDATE student_gallery SET approval_status = 'rejected', reject_reason = COALESCE(?, reject_reason) WHERE id = ?").run(reason, id);
}

function updateGalleryItem(id, data) {
  const fields = [];
  const params = [];
  for (const key of ['title', 'description', 'category', 'image_url', 'tags']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (fields.length === 0) {
    return db.prepare('SELECT * FROM student_gallery WHERE id = ?').get(id);
  }
  params.push(id);
  db.prepare(`UPDATE student_gallery SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM student_gallery WHERE id = ?').get(id);
}

// soft delete
function deleteGalleryItem(id) {
  const info = db.prepare(
    "UPDATE student_gallery SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL"
  ).run(id);
  return info.changes > 0;
}

// ========== 댓글 ==========

function listGalleryComments(galleryId, { page = 1, limit = 30 } = {}) {
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM gallery_comments WHERE gallery_id = ?').get(galleryId).cnt;
  const totalPages = Math.ceil(total / limit) || 1;
  const items = db.prepare(`
    SELECT c.id, c.gallery_id, c.user_id, c.content, c.created_at,
           u.display_name, u.username, u.role
    FROM gallery_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.gallery_id = ?
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).all(galleryId, limit, (page - 1) * limit);
  return { items, total, totalPages };
}

function createGalleryComment(galleryId, userId, content) {
  const info = db.prepare(
    'INSERT INTO gallery_comments (gallery_id, user_id, content) VALUES (?, ?, ?)'
  ).run(galleryId, userId, content);
  return db.prepare(`
    SELECT c.id, c.gallery_id, c.user_id, c.content, c.created_at,
           u.display_name, u.username, u.role
    FROM gallery_comments c JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(info.lastInsertRowid);
}

function getGalleryCommentById(commentId) {
  return db.prepare('SELECT * FROM gallery_comments WHERE id = ?').get(commentId);
}

function deleteGalleryComment(commentId) {
  const info = db.prepare('DELETE FROM gallery_comments WHERE id = ?').run(commentId);
  return info.changes > 0;
}

// ========== 신고 대시보드 (gallery_reports) ==========

// 신고 목록 (admin/teacher 용) — 작품 + 작성자 + 신고자 정보 join
function listGalleryReports({ status = 'pending', limit = 50, offset = 0 } = {}) {
  const validStatus = ['pending', 'resolved', 'dismissed'];
  let where = '';
  const params = [];
  if (status && validStatus.includes(status)) {
    where = ' WHERE r.status = ?';
    params.push(status);
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  const items = db.prepare(`
    SELECT r.id AS report_id,
           r.gallery_id, r.reason, r.status,
           r.resolved_action, r.resolved_by, r.resolved_at, r.resolution_reason,
           r.created_at AS reported_at,
           r.user_id AS reporter_id,
           ru.display_name AS reporter_name,
           ru.username AS reporter_username,
           g.title AS gallery_title,
           g.description AS gallery_description,
           g.image_url AS gallery_image_url,
           g.category AS gallery_category,
           g.approval_status AS gallery_approval_status,
           g.deleted_at AS gallery_deleted_at,
           g.like_count AS gallery_like_count,
           g.view_count AS gallery_view_count,
           g.student_id AS author_id,
           au.display_name AS author_name,
           au.username AS author_username,
           au.school_name AS author_school
    FROM gallery_reports r
    LEFT JOIN student_gallery g ON g.id = r.gallery_id
    LEFT JOIN users ru ON ru.id = r.user_id
    LEFT JOIN users au ON au.id = g.student_id
    ${where}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, off);

  // status별 카운트 (대시보드 헤더 카드용)
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM gallery_reports GROUP BY status
  `).all();
  const summary = { pending: 0, resolved: 0, dismissed: 0 };
  for (const c of counts) {
    if (summary[c.status] != null) summary[c.status] = c.cnt;
  }

  return { items, summary };
}

function getGalleryReportById(reportId) {
  return db.prepare(`
    SELECT r.*,
           g.title AS gallery_title, g.student_id AS author_id,
           ru.display_name AS reporter_name
    FROM gallery_reports r
    LEFT JOIN student_gallery g ON g.id = r.gallery_id
    LEFT JOIN users ru ON ru.id = r.user_id
    WHERE r.id = ?
  `).get(reportId);
}

// 신고 처리 — takedown: 작품 soft delete + 보고 resolved
// dismiss: 보고 dismissed
function resolveGalleryReport(reportId, action, resolverId, reason = null) {
  if (!['takedown', 'dismiss'].includes(action)) {
    const err = new Error('잘못된 처리 액션입니다.');
    err.status = 400;
    throw err;
  }
  const report = getGalleryReportById(reportId);
  if (!report) {
    const err = new Error('신고를 찾을 수 없습니다.');
    err.status = 404;
    throw err;
  }

  const tx = db.transaction(() => {
    if (action === 'takedown') {
      // 작품 soft delete
      db.prepare("UPDATE student_gallery SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) WHERE id = ?")
        .run(report.gallery_id);
      // 동일 작품에 대한 모든 pending 신고를 한꺼번에 resolved 처리
      db.prepare(`
        UPDATE gallery_reports
        SET status = 'resolved',
            resolved_action = 'takedown',
            resolved_by = ?,
            resolved_at = CURRENT_TIMESTAMP,
            resolution_reason = COALESCE(?, resolution_reason)
        WHERE gallery_id = ? AND status = 'pending'
      `).run(resolverId, reason, report.gallery_id);
    } else {
      // dismiss — 해당 신고만
      db.prepare(`
        UPDATE gallery_reports
        SET status = 'dismissed',
            resolved_action = 'dismiss',
            resolved_by = ?,
            resolved_at = CURRENT_TIMESTAMP,
            resolution_reason = COALESCE(?, resolution_reason)
        WHERE id = ?
      `).run(resolverId, reason, reportId);
    }
  });
  tx();

  return getGalleryReportById(reportId);
}

// admin/teacher 직접 작품 takedown (신고 없이) — soft delete + 신고 같이 정리
function takedownGalleryItemDirect(galleryId, resolverId, reason = null) {
  const item = db.prepare("SELECT id, student_id, title, deleted_at FROM student_gallery WHERE id = ?").get(galleryId);
  if (!item) {
    const err = new Error('작품을 찾을 수 없습니다.');
    err.status = 404;
    throw err;
  }
  if (item.deleted_at) {
    const err = new Error('이미 내려간 작품입니다.');
    err.status = 400;
    throw err;
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE student_gallery SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(galleryId);
    // 관련 pending 신고가 있으면 함께 resolved 처리
    db.prepare(`
      UPDATE gallery_reports
      SET status = 'resolved',
          resolved_action = 'takedown',
          resolved_by = ?,
          resolved_at = CURRENT_TIMESTAMP,
          resolution_reason = COALESCE(?, resolution_reason)
      WHERE gallery_id = ? AND status = 'pending'
    `).run(resolverId, reason, galleryId);
  });
  tx();

  return item;
}

// ========== 콘테스트 (gallery_events) ==========

function listGalleryEvents({ status = null, limit = 10, includeDeleted = false } = {}) {
  let where = ' WHERE 1=1';
  const params = [];
  if (!includeDeleted) {
    where += ' AND (deleted_at IS NULL)';
  }
  // 오늘 날짜 기준 status 분기
  if (status === 'upcoming') {
    where += " AND date(start_date) > date('now') AND (closed_at IS NULL)";
  } else if (status === 'active') {
    where += " AND date(start_date) <= date('now') AND date(end_date) >= date('now') AND (closed_at IS NULL)";
  } else if (status === 'past') {
    where += " AND (date(end_date) < date('now') OR closed_at IS NOT NULL)";
  }
  // 정렬: active 우선 → 임박 순 (start_date 가까운 순) → past는 최근 종료 순
  const orderBy = (status === 'past')
    ? 'end_date DESC, id DESC'
    : 'date(start_date) ASC, date(end_date) ASC';

  const items = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM gallery_event_submissions s WHERE s.event_id = e.id) AS submission_count,
      (SELECT COUNT(*) FROM gallery_event_participants p WHERE p.event_id = e.id) AS participant_count
    FROM gallery_events e
    ${where}
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(...params, limit);

  return { items, total: items.length };
}

function getGalleryEventById(id, { includeDeleted = false } = {}) {
  const row = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM gallery_event_submissions s WHERE s.event_id = e.id) AS submission_count,
      (SELECT COUNT(*) FROM gallery_event_participants p WHERE p.event_id = e.id) AS participant_count
    FROM gallery_events e WHERE e.id = ?
  `).get(id);
  if (!row) return null;
  if (!includeDeleted && row.deleted_at) return null;
  return row;
}

// ===== 콘테스트 CRUD (admin/teacher) =====

// 콘테스트 신규 등록
function createGalleryEvent(hostUserId, data) {
  const title = String(data.title || '').trim();
  if (!title) {
    const err = new Error('제목을 입력하세요.');
    err.status = 400; throw err;
  }
  if (title.length > 200) {
    const err = new Error('제목은 200자 이하로 입력하세요.');
    err.status = 400; throw err;
  }
  const startDate = data.start_date ? String(data.start_date) : null;
  const endDate = data.end_date ? String(data.end_date) : null;
  if (!startDate || !endDate) {
    const err = new Error('시작일과 종료일을 입력하세요.');
    err.status = 400; throw err;
  }
  if (startDate > endDate) {
    const err = new Error('종료일은 시작일 이후여야 합니다.');
    err.status = 400; throw err;
  }
  const category = data.category || 'art';
  const eventType = data.event_type || 'apply';
  const location = data.location ? String(data.location).slice(0, 200) : null;
  const hostSchoolName = data.host_school_name ? String(data.host_school_name).slice(0, 200) : null;
  const description = data.description ? String(data.description).slice(0, 5000) : null;
  const publishToGallery = data.publish_to_gallery == null ? 1 : (data.publish_to_gallery ? 1 : 0);
  const targetSchoolOnly = data.target_school_only ? 1 : 0;
  const targetSchoolLevels = Array.isArray(data.target_school_levels)
    ? JSON.stringify(data.target_school_levels)
    : (data.target_school_levels || null);
  const targetGrades = Array.isArray(data.target_grades)
    ? JSON.stringify(data.target_grades)
    : (data.target_grades || null);
  const thumbnailUrl = data.thumbnail_url ? String(data.thumbnail_url).slice(0, 500) : null;

  const info = db.prepare(`
    INSERT INTO gallery_events (
      title, description, category, event_type, start_date, end_date,
      location, host_user_id, host_school_name, thumbnail_url,
      publish_to_gallery, target_school_levels, target_grades, target_school_only
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title, description, category, eventType, startDate, endDate,
    location, hostUserId, hostSchoolName, thumbnailUrl,
    publishToGallery, targetSchoolLevels, targetGrades, targetSchoolOnly
  );
  return getGalleryEventById(info.lastInsertRowid);
}

// 콘테스트 수정
function updateGalleryEvent(id, data) {
  const before = db.prepare('SELECT * FROM gallery_events WHERE id = ?').get(id);
  if (!before || before.deleted_at) {
    const err = new Error('콘테스트를 찾을 수 없습니다.');
    err.status = 404; throw err;
  }

  const fields = [];
  const params = [];
  const set = (key, val) => { fields.push(`${key} = ?`); params.push(val); };

  if (data.title !== undefined) {
    const t = String(data.title || '').trim();
    if (!t) { const e = new Error('제목을 입력하세요.'); e.status = 400; throw e; }
    if (t.length > 200) { const e = new Error('제목은 200자 이하로 입력하세요.'); e.status = 400; throw e; }
    set('title', t);
  }
  if (data.description !== undefined) set('description', data.description ? String(data.description).slice(0, 5000) : null);
  if (data.category !== undefined) set('category', data.category);
  if (data.event_type !== undefined) set('event_type', data.event_type);
  if (data.start_date !== undefined) set('start_date', data.start_date);
  if (data.end_date !== undefined) set('end_date', data.end_date);
  if (data.location !== undefined) set('location', data.location ? String(data.location).slice(0, 200) : null);
  if (data.host_school_name !== undefined) set('host_school_name', data.host_school_name ? String(data.host_school_name).slice(0, 200) : null);
  if (data.thumbnail_url !== undefined) set('thumbnail_url', data.thumbnail_url ? String(data.thumbnail_url).slice(0, 500) : null);
  if (data.publish_to_gallery !== undefined) set('publish_to_gallery', data.publish_to_gallery ? 1 : 0);
  if (data.target_school_only !== undefined) set('target_school_only', data.target_school_only ? 1 : 0);
  if (data.target_school_levels !== undefined) {
    set('target_school_levels', Array.isArray(data.target_school_levels) ? JSON.stringify(data.target_school_levels) : data.target_school_levels);
  }
  if (data.target_grades !== undefined) {
    set('target_grades', Array.isArray(data.target_grades) ? JSON.stringify(data.target_grades) : data.target_grades);
  }

  // 날짜 검증 (start>end 방지)
  const finalStart = data.start_date !== undefined ? data.start_date : before.start_date;
  const finalEnd = data.end_date !== undefined ? data.end_date : before.end_date;
  if (finalStart && finalEnd && finalStart > finalEnd) {
    const err = new Error('종료일은 시작일 이후여야 합니다.');
    err.status = 400; throw err;
  }

  if (fields.length === 0) return getGalleryEventById(id);
  params.push(id);
  db.prepare(`UPDATE gallery_events SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getGalleryEventById(id);
}

// 콘테스트 soft delete
function softDeleteGalleryEvent(id) {
  const before = db.prepare('SELECT id, deleted_at FROM gallery_events WHERE id = ?').get(id);
  if (!before) {
    const err = new Error('콘테스트를 찾을 수 없습니다.');
    err.status = 404; throw err;
  }
  if (before.deleted_at) return false;
  db.prepare("UPDATE gallery_events SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return true;
}

// 콘테스트 응모작 목록 (admin/teacher 용)
function listEventSubmissions(eventId, { sort = 'latest', page = 1, limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pg - 1) * lim;

  let orderBy;
  switch (sort) {
    case 'likes': orderBy = 'COALESCE(g.like_count, 0) DESC, s.created_at DESC'; break;
    case 'latest':
    default: orderBy = 's.created_at DESC, s.id DESC';
  }

  const total = db.prepare(
    'SELECT COUNT(*) AS cnt FROM gallery_event_submissions WHERE event_id = ?'
  ).get(eventId).cnt;
  const totalPages = Math.ceil(total / lim) || 1;

  const items = db.prepare(`
    SELECT s.id AS submission_id, s.event_id, s.user_id, s.title, s.description,
           s.image_url, s.is_published_to_gallery, s.gallery_item_id,
           s.created_at AS submitted_at,
           u.display_name AS author_name, u.username AS author_username, u.school_name,
           g.id AS gallery_id, g.approval_status, g.like_count, g.view_count, g.deleted_at AS gallery_deleted_at
    FROM gallery_event_submissions s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN student_gallery g ON g.id = s.gallery_item_id
    WHERE s.event_id = ?
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(eventId, lim, offset);

  return { items, total, totalPages };
}

// 응모: gallery_event_submissions에 기록 + (publish_to_gallery=1) student_gallery에 자동 발행
function submitGalleryEvent(eventId, userId, data) {
  const event = db.prepare('SELECT id, publish_to_gallery, category, closed_at, end_date FROM gallery_events WHERE id = ?').get(eventId);
  if (!event) {
    const err = new Error('콘테스트를 찾을 수 없습니다.');
    err.status = 404;
    throw err;
  }
  // 마감 검증
  if (event.closed_at) {
    const err = new Error('마감된 콘테스트입니다.');
    err.status = 400;
    throw err;
  }
  if (event.end_date && event.end_date < new Date().toISOString().slice(0, 10)) {
    const err = new Error('응모 기간이 종료되었습니다.');
    err.status = 400;
    throw err;
  }

  // 갤러리 공개 = (콘테스트가 허용) AND (학생이 선택).
  //  - eventPublish: 콘테스트 정책. null 은 레거시 기본 허용(1)으로 본다.
  //  - studentWants: 학생이 응모 모달에서 체크. data.publish_to_gallery 가 명시되지 않으면(undefined)
  //    레거시 호출 호환을 위해 "선택함(1)"으로 본다. 명시되면 그 값을 따른다(끄면 0).
  const eventPublish = event.publish_to_gallery == null ? 1 : Number(event.publish_to_gallery);
  const studentWants = data.publish_to_gallery === undefined ? 1 : (data.publish_to_gallery ? 1 : 0);
  const publishToGallery = (eventPublish && studentWants) ? 1 : 0;

  const tx = db.transaction(() => {
    // 1) submissions INSERT
    const subInfo = db.prepare(`
      INSERT INTO gallery_event_submissions (event_id, user_id, title, description, image_url, is_published_to_gallery)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, userId, data.title, data.description || null, data.image_url || null, publishToGallery ? 1 : 0);
    const submissionId = subInfo.lastInsertRowid;

    // 2) participants UPSERT (PK가 (event_id, user_id))
    db.prepare(`
      INSERT OR IGNORE INTO gallery_event_participants (event_id, user_id) VALUES (?, ?)
    `).run(eventId, userId);

    // 3) (옵션) gallery 자동 발행
    let galleryItemId = null;
    if (publishToGallery) {
      // category 매핑: gallery_events.category가 'literature'/'etc'면 student_gallery.category에 맞춤
      const catMap = { art: 'art', music: 'music', video: 'video', literature: 'writing', etc: 'other' };
      const sgCategory = catMap[event.category] || 'other';
      const gInfo = db.prepare(`
        INSERT INTO student_gallery (student_id, title, description, image_url, category, approval_status, source)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(userId, data.title, data.description || null, data.image_url || '/images/placeholder.png',
             sgCategory, `event:${eventId}`);
      galleryItemId = gInfo.lastInsertRowid;
      db.prepare('UPDATE gallery_event_submissions SET gallery_item_id = ? WHERE id = ?')
        .run(galleryItemId, submissionId);
    }

    return { submissionId, galleryItemId };
  });

  const result = tx();
  const submission = db.prepare('SELECT * FROM gallery_event_submissions WHERE id = ?').get(result.submissionId);
  return { submission, galleryItemId: result.galleryItemId };
}

module.exports = {
  createPortfolio, getPortfolioById, getStudentPortfolios, updatePortfolio, deletePortfolio,
  getStudentGrowthSummary, getClassGrowthOverview,
  // 갤러리
  createGalleryItem, getGalleryItems, getGalleryItemById, getPopularGalleryItems,
  toggleGalleryLike, recordGalleryView,
  approveGalleryItem, rejectGalleryItem,
  updateGalleryItem, deleteGalleryItem,
  // 멀티미디어 (신규)
  createGalleryItemWithAttachments, getGalleryItemWithAttachments, updateGalleryItemWithAttachments,
  // 댓글
  listGalleryComments, createGalleryComment, getGalleryCommentById, deleteGalleryComment,
  // 신고 대시보드
  listGalleryReports, getGalleryReportById, resolveGalleryReport, takedownGalleryItemDirect,
  // 콘테스트
  listGalleryEvents, getGalleryEventById, submitGalleryEvent,
  // 콘테스트 CRUD (신규)
  createGalleryEvent, updateGalleryEvent, softDeleteGalleryEvent, listEventSubmissions,
  // 하위 호환 (기존 코드가 참조할 수 있음)
  likeGalleryItem: toggleGalleryLike
};
