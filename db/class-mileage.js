// db/class-mileage.js
// 클래스 마일리지 시스템 — 클래스별 학습 동기부여 보상 (자동 지급 + 교사 수동 운영)
// 기존 채움포인트(point-helper / user_points)는 그대로 두고 별도 시스템으로 운영.

const db = require('./index');

// ──────────────────────────────────────────────────────────────────────────────
// Socket.IO 인스턴스 주입 (server에서 io를 setIo로 주입; 없으면 emit 생략)
// ──────────────────────────────────────────────────────────────────────────────
let _io = null;
function setIo(io) { _io = io; }

// per-user throttle (1초) — Socket emit 폭주 방지
const _emitThrottle = new Map();
function _throttledEmit(classId, payload) {
  if (!_io) return;
  try {
    const key = `${classId}:${payload.userId}`;
    const now = Date.now();
    const last = _emitThrottle.get(key) || 0;
    if (now - last < 1000) return;
    _emitThrottle.set(key, now);
    // classId·timestamp도 같이 실어 클라이언트가 필요 시 라우팅 가능하게 함.
    const full = { ...payload, classId, at: new Date().toISOString() };
    _io.to(`class:${classId}`).emit('class:mileage:update', full);
  } catch (e) { /* socket 실패는 무시 */ }
}

// ──────────────────────────────────────────────────────────────────────────────
// 기본 규칙 8종
// ──────────────────────────────────────────────────────────────────────────────
const DEFAULT_RULES = [
  { event_type: 'lesson_complete',  points: 10, daily_limit: 5,    description: '수업 100% 이수' },
  { event_type: 'homework_submit',  points: 20, daily_limit: null, description: '과제 최초 제출' },
  { event_type: 'exam_complete',    points: 15, daily_limit: null, description: '평가 응시 완료' },
  { event_type: 'board_post',       points: 5,  daily_limit: 3,    description: '게시글 작성' },
  { event_type: 'board_comment',    points: 2,  daily_limit: 10,   description: '댓글 작성' },
  { event_type: 'attendance',       points: 5,  daily_limit: 1,    description: '출석 체크인' },
  { event_type: 'notice_read',      points: 1,  daily_limit: 20,   description: '알림장 1건 읽음' },
  { event_type: 'survey_submit',    points: 5,  daily_limit: null, description: '설문 참여' },
];

/**
 * 클래스 기본 규칙 8종을 idempotent하게 보장한다.
 * 이미 존재하면 그대로, 없으면 INSERT.
 */
function ensureRules(classId) {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO class_mileage_rules
        (class_id, event_type, points, is_enabled, daily_limit, description)
      VALUES (?, ?, ?, 1, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const r of DEFAULT_RULES) {
        stmt.run(classId, r.event_type, r.points, r.daily_limit, r.description);
      }
    });
    tx();
  } catch (e) {
    console.error('[class-mileage] ensureRules error:', e.message);
  }
}

// KST 오늘 날짜 (yyyy-mm-dd)
function _todayKst() {
  const d = new Date();
  d.setHours(d.getHours() + 9);
  return d.toISOString().slice(0, 10);
}

/**
 * 자동 지급의 핵심 — 이벤트가 일어났을 때 호출.
 * - ensureRules 호출(idempotent)
 * - 멤버 검증 (active class_members)
 * - 규칙 조회 (is_enabled=0 이면 skip)
 * - daily_limit 검증 (오늘 같은 reason 카운트 >= limit 면 skip)
 * - INSERT log (UNIQUE 위반 → 중복으로 silent skip)
 * - UPSERT balance
 * 모든 단계가 try/catch 보호 — 호출자(라우트)에 절대 예외 전파 금지.
 */
function awardClassMileage(classId, userId, eventType, sourceId, opts = {}) {
  try {
    if (!classId || !userId || !eventType) {
      return { success: false, skipped: true, reason: 'invalid_args' };
    }
    classId = parseInt(classId);
    userId = parseInt(userId);
    // sourceId 는 정수형 PK가 일반적이지만 exam.id 같은 UUID 문자열도 들어올 수 있다.
    // 정수형이면 parseInt 후 INTEGER 컬럼에 저장, 문자열이면 그대로 저장(SQLite는 dynamic type).
    if (sourceId == null) {
      sourceId = null;
    } else if (typeof sourceId === 'number') {
      sourceId = sourceId;
    } else {
      const n = parseInt(sourceId);
      // 숫자로 완전히 파싱되는지 확인 — '123' → 123, '0ad1-...' → NaN
      if (!isNaN(n) && String(n) === String(sourceId).trim()) {
        sourceId = n;
      } else {
        sourceId = String(sourceId); // UUID 등 문자열 그대로 유지
      }
    }

    ensureRules(classId);

    // 멤버 검증 + 역할 검증 (교사/운영자는 자동 마일리지 적립 대상에서 제외)
    const member = db.prepare(
      "SELECT id, role FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
    ).get(classId, userId);
    if (!member) return { success: false, skipped: true, reason: 'not_member' };
    if (member.role === 'owner' || member.role === 'teacher' || member.role === 'co_teacher') {
      return { success: false, skipped: true, reason: 'teacher_excluded' };
    }

    // 규칙 조회
    const rule = db.prepare(`
      SELECT points, is_enabled, daily_limit
      FROM class_mileage_rules
      WHERE class_id = ? AND event_type = ?
    `).get(classId, eventType);
    if (!rule) return { success: false, skipped: true, reason: 'no_rule' };
    if (!rule.is_enabled) return { success: false, skipped: true, reason: 'disabled' };
    if (!rule.points || rule.points <= 0) return { success: false, skipped: true, reason: 'zero_points' };

    // daily_limit 검사
    if (rule.daily_limit != null) {
      const today = _todayKst();
      const count = db.prepare(`
        SELECT COUNT(*) AS c
        FROM class_mileage_log
        WHERE class_id = ? AND user_id = ? AND reason = ?
          AND date(created_at, '+9 hours') = ?
      `).get(classId, userId, eventType, today);
      if ((count?.c || 0) >= rule.daily_limit) {
        return { success: false, skipped: true, reason: 'daily_limit' };
      }
    }

    // INSERT log — UNIQUE(class_id, user_id, source_type, source_id, reason) 로 중복 차단
    let inserted = false;
    const sourceType = opts.sourceType || eventType;
    try {
      const info = db.prepare(`
        INSERT INTO class_mileage_log
          (class_id, user_id, delta, reason, source_type, source_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(classId, userId, rule.points, eventType, sourceType, sourceId, opts.note || null);
      inserted = info.changes > 0;
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return { success: false, skipped: true, reason: 'duplicate' };
      }
      throw e;
    }
    if (!inserted) return { success: false, skipped: true, reason: 'no_change' };

    // UPSERT balance
    db.prepare(`
      INSERT INTO class_mileage (class_id, user_id, balance, total_earned, total_deducted, last_event_at, updated_at)
      VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(class_id, user_id) DO UPDATE SET
        balance = balance + excluded.balance,
        total_earned = total_earned + excluded.total_earned,
        last_event_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `).run(classId, userId, rule.points, rule.points);

    const after = db.prepare(
      'SELECT balance FROM class_mileage WHERE class_id = ? AND user_id = ?'
    ).get(classId, userId);

    _throttledEmit(classId, {
      userId,
      delta: rule.points,
      balance: after?.balance || rule.points,
      reason: eventType
    });

    return { success: true, skipped: false, points: rule.points, balance: after?.balance };
  } catch (e) {
    console.error('[class-mileage] awardClassMileage error:', e.message);
    return { success: false, skipped: true, reason: 'error', error: e.message };
  }
}

/**
 * 교사 수동 부여 — 1명 또는 여러 명에게 양수 부여
 */
function manualAward(classId, userIds, points, awardedBy, note) {
  if (!Array.isArray(userIds)) userIds = [userIds];
  points = parseInt(points);
  if (!points || points <= 0) {
    return { success: false, message: '포인트는 1 이상이어야 합니다.' };
  }
  classId = parseInt(classId);
  awardedBy = parseInt(awardedBy);
  const results = [];

  const insertLog = db.prepare(`
    INSERT INTO class_mileage_log
      (class_id, user_id, delta, reason, source_type, source_id, awarded_by, note)
    VALUES (?, ?, ?, 'manual_award', 'manual', NULL, ?, ?)
  `);
  const upsert = db.prepare(`
    INSERT INTO class_mileage (class_id, user_id, balance, total_earned, total_deducted, last_event_at, updated_at)
    VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(class_id, user_id) DO UPDATE SET
      balance = balance + excluded.balance,
      total_earned = total_earned + excluded.total_earned,
      last_event_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    for (const uid of userIds) {
      const userId = parseInt(uid);
      const member = db.prepare(
        "SELECT id FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
      ).get(classId, userId);
      if (!member) { results.push({ userId, skipped: true, reason: 'not_member' }); continue; }
      const info = insertLog.run(classId, userId, points, awardedBy, note || null);
      upsert.run(classId, userId, points, points);
      const after = db.prepare('SELECT balance FROM class_mileage WHERE class_id = ? AND user_id = ?').get(classId, userId);
      results.push({ userId, logId: info.lastInsertRowid, balance: after?.balance, delta: points });
      _throttledEmit(classId, { userId, delta: points, balance: after?.balance, reason: 'manual_award' });
    }
  });
  try { tx(); } catch (e) {
    console.error('[class-mileage] manualAward error:', e.message);
    return { success: false, message: e.message };
  }
  return { success: true, results };
}

/**
 * 교사 수동 차감 — 잔액이 부족해도 음수 허용(설계 단순화).
 */
function manualDeduct(classId, userIds, points, awardedBy, note) {
  if (!Array.isArray(userIds)) userIds = [userIds];
  points = Math.abs(parseInt(points));
  if (!points || points <= 0) {
    return { success: false, message: '차감 포인트는 1 이상이어야 합니다.' };
  }
  classId = parseInt(classId);
  awardedBy = parseInt(awardedBy);
  const results = [];

  const insertLog = db.prepare(`
    INSERT INTO class_mileage_log
      (class_id, user_id, delta, reason, source_type, source_id, awarded_by, note)
    VALUES (?, ?, ?, 'manual_deduct', 'manual', NULL, ?, ?)
  `);
  const upsert = db.prepare(`
    INSERT INTO class_mileage (class_id, user_id, balance, total_earned, total_deducted, last_event_at, updated_at)
    VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(class_id, user_id) DO UPDATE SET
      balance = balance + excluded.balance,
      total_deducted = total_deducted + excluded.total_deducted,
      last_event_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    for (const uid of userIds) {
      const userId = parseInt(uid);
      const member = db.prepare(
        "SELECT id FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
      ).get(classId, userId);
      if (!member) { results.push({ userId, skipped: true, reason: 'not_member' }); continue; }
      const info = insertLog.run(classId, userId, -points, awardedBy, note || null);
      upsert.run(classId, userId, -points, points);
      const after = db.prepare('SELECT balance FROM class_mileage WHERE class_id = ? AND user_id = ?').get(classId, userId);
      results.push({ userId, logId: info.lastInsertRowid, balance: after?.balance, delta: -points });
      _throttledEmit(classId, { userId, delta: -points, balance: after?.balance, reason: 'manual_deduct' });
    }
  });
  try { tx(); } catch (e) {
    console.error('[class-mileage] manualDeduct error:', e.message);
    return { success: false, message: e.message };
  }
  return { success: true, results };
}

/**
 * 특정 로그 회수 — 동일 액수의 역방향 로그 1행 추가.
 * 이미 회수된 로그는 한 번 더 회수되지 않도록 차단.
 */
function revokeLog(classId, logId, awardedBy, note) {
  classId = parseInt(classId);
  logId = parseInt(logId);
  awardedBy = parseInt(awardedBy);
  try {
    const orig = db.prepare(
      'SELECT id, class_id, user_id, delta, reason FROM class_mileage_log WHERE id = ? AND class_id = ?'
    ).get(logId, classId);
    if (!orig) return { success: false, message: '로그를 찾을 수 없습니다.' };

    // 이미 회수된 적 있는지
    const already = db.prepare(
      'SELECT id FROM class_mileage_log WHERE revoked_log_id = ?'
    ).get(logId);
    if (already) return { success: false, message: '이미 회수된 로그입니다.' };

    const delta = -orig.delta;
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO class_mileage_log
          (class_id, user_id, delta, reason, source_type, source_id, awarded_by, revoked_log_id, note)
        VALUES (?, ?, ?, 'revoke', 'revoke', ?, ?, ?, ?)
      `).run(classId, orig.user_id, delta, logId, awardedBy, logId, note || null);

      // 잔액 보정 — 회수 방향이 차감이면 total_deducted 증가, 가산이면 total_earned 증가
      if (delta >= 0) {
        db.prepare(`
          INSERT INTO class_mileage (class_id, user_id, balance, total_earned, total_deducted, last_event_at, updated_at)
          VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(class_id, user_id) DO UPDATE SET
            balance = balance + excluded.balance,
            total_earned = total_earned + excluded.total_earned,
            last_event_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        `).run(classId, orig.user_id, delta, delta);
      } else {
        db.prepare(`
          INSERT INTO class_mileage (class_id, user_id, balance, total_earned, total_deducted, last_event_at, updated_at)
          VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(class_id, user_id) DO UPDATE SET
            balance = balance + excluded.balance,
            total_deducted = total_deducted + excluded.total_deducted,
            last_event_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        `).run(classId, orig.user_id, delta, -delta);
      }
      return info.lastInsertRowid;
    });
    const newLogId = tx();
    const after = db.prepare('SELECT balance FROM class_mileage WHERE class_id = ? AND user_id = ?').get(classId, orig.user_id);
    _throttledEmit(classId, { userId: orig.user_id, delta, balance: after?.balance, reason: 'revoke' });
    return { success: true, logId: newLogId, balance: after?.balance, delta };
  } catch (e) {
    console.error('[class-mileage] revokeLog error:', e.message);
    return { success: false, message: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 조회
// ──────────────────────────────────────────────────────────────────────────────

/** 학생 본인 — 잔액·누적·최근 로그 */
function getMemberMileage(classId, userId) {
  classId = parseInt(classId); userId = parseInt(userId);
  const summary = db.prepare(`
    SELECT balance, total_earned, total_deducted, last_event_at
    FROM class_mileage WHERE class_id = ? AND user_id = ?
  `).get(classId, userId) || { balance: 0, total_earned: 0, total_deducted: 0, last_event_at: null };

  const recent = db.prepare(`
    SELECT id, delta, reason, source_type, source_id, awarded_by, note, created_at
    FROM class_mileage_log
    WHERE class_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 20
  `).all(classId, userId);

  // 클래스 내 본인 순위
  const rank = db.prepare(`
    SELECT COUNT(*) + 1 AS rank
    FROM class_mileage
    WHERE class_id = ? AND balance > (
      SELECT COALESCE(balance, 0) FROM class_mileage WHERE class_id = ? AND user_id = ?
    )
  `).get(classId, classId, userId);

  return { ...summary, rank: rank?.rank || null, recent };
}

/** 랭킹 — { period: 'all'|'week'|'month', limit, withMe } */
function getRanking(classId, opts = {}) {
  classId = parseInt(classId);
  const limit = Math.min(parseInt(opts.limit) || 20, 100);
  const period = opts.period || 'all';

  let rows;
  if (period === 'all') {
    // 학생 랭킹 — owner/teacher/co_teacher 제외 (P1 fix: API 계층에서 안전하게 차단)
    rows = db.prepare(`
      SELECT cm.user_id, u.display_name, u.username, u.profile_image_url,
             cm.balance, cm.total_earned, cm.total_deducted, cm.last_event_at
      FROM class_mileage cm
      JOIN users u ON u.id = cm.user_id
      JOIN class_members m ON m.class_id = cm.class_id AND m.user_id = cm.user_id AND m.status = 'active'
      WHERE cm.class_id = ?
        AND m.role NOT IN ('owner', 'teacher', 'co_teacher')
      ORDER BY cm.balance DESC, cm.last_event_at ASC
      LIMIT ?
    `).all(classId, limit);
  } else {
    // 기간 합계 (week=7일, month=30일) — owner/teacher/co_teacher 제외
    const days = period === 'week' ? 7 : 30;
    rows = db.prepare(`
      SELECT u.id AS user_id, u.display_name, u.username, u.profile_image_url,
             COALESCE(SUM(l.delta), 0) AS balance,
             COALESCE(SUM(CASE WHEN l.delta > 0 THEN l.delta ELSE 0 END), 0) AS total_earned,
             COALESCE(SUM(CASE WHEN l.delta < 0 THEN -l.delta ELSE 0 END), 0) AS total_deducted,
             MAX(l.created_at) AS last_event_at
      FROM users u
      JOIN class_members m ON m.user_id = u.id AND m.class_id = ? AND m.status = 'active'
        AND m.role NOT IN ('owner', 'teacher', 'co_teacher')
      LEFT JOIN class_mileage_log l
        ON l.user_id = u.id AND l.class_id = ?
        AND l.created_at >= datetime('now', ?)
      GROUP BY u.id
      ORDER BY balance DESC
      LIMIT ?
    `).all(classId, classId, `-${days} days`, limit);
  }

  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

/** 교사용 전체 멤버 목록 — 잔액 포함 */
function getMembersMileage(classId, opts = {}) {
  classId = parseInt(classId);
  return db.prepare(`
    SELECT u.id AS user_id, u.display_name, u.username, u.profile_image_url, m.role,
           COALESCE(cm.balance, 0) AS balance,
           COALESCE(cm.total_earned, 0) AS total_earned,
           COALESCE(cm.total_deducted, 0) AS total_deducted,
           cm.last_event_at
    FROM class_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN class_mileage cm ON cm.class_id = m.class_id AND cm.user_id = m.user_id
    WHERE m.class_id = ? AND m.status = 'active'
    ORDER BY balance DESC, u.display_name ASC
  `).all(classId);
}

/** 로그 조회 (필터·페이지네이션) */
function getLogs(classId, opts = {}) {
  classId = parseInt(classId);
  const page = Math.max(parseInt(opts.page) || 1, 1);
  const limit = Math.min(parseInt(opts.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const wheres = ['l.class_id = ?'];
  const params = [classId];
  if (opts.userId) { wheres.push('l.user_id = ?'); params.push(parseInt(opts.userId)); }
  if (opts.reason) { wheres.push('l.reason = ?'); params.push(opts.reason); }
  if (opts.dateFrom) { wheres.push("date(l.created_at, '+9 hours') >= ?"); params.push(opts.dateFrom); }
  if (opts.dateTo)   { wheres.push("date(l.created_at, '+9 hours') <= ?"); params.push(opts.dateTo); }
  if (opts.direction === 'plus')  wheres.push('l.delta > 0');
  if (opts.direction === 'minus') wheres.push('l.delta < 0');

  const whereSql = wheres.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS c FROM class_mileage_log l WHERE ${whereSql}`).get(...params);
  const rows = db.prepare(`
    SELECT l.id, l.user_id, u.display_name AS user_name, u.username,
           l.delta, l.reason, l.source_type, l.source_id, l.awarded_by,
           ab.display_name AS awarded_by_name,
           l.revoked_log_id, l.note, l.created_at
    FROM class_mileage_log l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN users ab ON ab.id = l.awarded_by
    WHERE ${whereSql}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { logs: rows, total: total?.c || 0, page, limit };
}

/** 일자별 추이 — { period: 'week'|'month' } */
function getTrend(classId, opts = {}) {
  classId = parseInt(classId);
  const days = opts.period === 'month' ? 30 : 7;
  const rows = db.prepare(`
    SELECT date(created_at, '+9 hours') AS day,
           SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS earned,
           SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS deducted,
           COUNT(*) AS events
    FROM class_mileage_log
    WHERE class_id = ? AND created_at >= datetime('now', ?)
    GROUP BY day
    ORDER BY day ASC
  `).all(classId, `-${days} days`);
  return rows;
}

/** CSV 내보내기 — UTF-8 한글 정상 출력을 위해 BOM은 라우트에서 prepend */
function exportLogsCSV(classId, opts = {}) {
  // 페이지네이션 무시, 전체 가져오기 (안전상 최대 5000건)
  const { logs } = getLogs(classId, { ...opts, page: 1, limit: 5000 });
  const header = ['id', 'created_at', 'user_id', 'user_name', 'username', 'delta', 'reason', 'source_type', 'source_id', 'awarded_by_name', 'note'];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(',')];
  for (const r of logs) {
    lines.push([
      r.id, r.created_at, r.user_id, r.user_name, r.username,
      r.delta, r.reason, r.source_type, r.source_id, r.awarded_by_name, r.note
    ].map(escape).join(','));
  }
  return lines.join('\r\n');
}

/** 규칙 조회 */
function getRules(classId) {
  classId = parseInt(classId);
  ensureRules(classId);
  return db.prepare(`
    SELECT id, event_type, points, is_enabled, daily_limit, description, updated_at, updated_by
    FROM class_mileage_rules
    WHERE class_id = ?
    ORDER BY id ASC
  `).all(classId);
}

/**
 * 규칙 일괄 수정.
 * rules: [{ event_type, points, is_enabled, daily_limit, description }]
 */
function updateRules(classId, rules, updatedBy) {
  classId = parseInt(classId);
  updatedBy = parseInt(updatedBy);
  ensureRules(classId);
  if (!Array.isArray(rules) || rules.length === 0) {
    return { success: false, message: '수정할 규칙이 없습니다.' };
  }
  const upd = db.prepare(`
    UPDATE class_mileage_rules
       SET points = ?, is_enabled = ?, daily_limit = ?, description = COALESCE(?, description),
           updated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE class_id = ? AND event_type = ?
  `);
  const tx = db.transaction(() => {
    let changed = 0;
    for (const r of rules) {
      // event_type (snake_case) 또는 eventType (camelCase) 둘 다 허용
      const eventType = r.event_type || r.eventType;
      if (!eventType) continue;
      const points = Math.max(0, parseInt(r.points) || 0);
      // is_enabled 또는 isEnabled — 둘 다 허용. 명시적 false/0 인 경우만 0, 그 외 1.
      const rawEnabled = (r.is_enabled !== undefined) ? r.is_enabled : r.isEnabled;
      const enabled = (rawEnabled === false || rawEnabled === 0 || rawEnabled === '0') ? 0 : 1;
      // daily_limit 또는 dailyLimit — 0/null/undefined/'' 는 무제한(null)로 저장
      const rawLimit = (r.daily_limit !== undefined) ? r.daily_limit : r.dailyLimit;
      const limit = (rawLimit === null || rawLimit === undefined || rawLimit === '' || rawLimit === 0 || rawLimit === '0') ? null : Math.max(1, parseInt(rawLimit));
      const info = upd.run(points, enabled, limit, r.description || null, updatedBy, classId, eventType);
      changed += info.changes;
    }
    return changed;
  });
  try {
    const changed = tx();
    return { success: true, changed };
  } catch (e) {
    console.error('[class-mileage] updateRules error:', e.message);
    return { success: false, message: e.message };
  }
}

module.exports = {
  setIo,
  ensureRules,
  awardClassMileage,
  manualAward,
  manualDeduct,
  revokeLog,
  getMemberMileage,
  getRanking,
  getMembersMileage,
  getLogs,
  getTrend,
  exportLogsCSV,
  getRules,
  updateRules,
};
