const db = require('./index');

// 출석 체크 (1클릭)
function checkIn(classId, userId, comment = null, emotion = null, emotionReason = null, checkinSource = 'manual') {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const info = db.prepare(`
      INSERT INTO attendance (class_id, user_id, attendance_date, status, comment, emotion, emotion_reason, checkin_source)
      VALUES (?, ?, ?, 'present', ?, ?, ?, ?)
    `).run(classId, userId, today, comment || null, emotion || null, emotionReason || null, checkinSource || 'manual');

    // 뱃지 확인
    checkAndAwardBadges(classId, userId);
    return { success: true, date: today, id: info.lastInsertRowid };
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return { success: false, already: true };
    }
    throw e;
  }
}

// 오늘 출석 자동 기록 (멱등) — 학습 활동 발생 시 라우트가 호출.
//   수업 이수·과제 열람·평가 응시·설문 응답·게시판 활동 등에서 "오늘 출석"을 자동 present 기록한다.
//   ⚠ 멱등: 오늘 이미 출석행(수동 checkin·감정 포함)이 있으면 절대 덮어쓰지 않고 skip.
//   날짜 규칙은 기존 checkIn/isCheckedIn 과 동일(new Date().toISOString().slice(0,10), YYYY-MM-DD).
//   스키마 근거(실 DB PRAGMA table_info): attendance(class_id,user_id,attendance_date,status,
//     comment,checked_at,emotion,emotion_reason,emotion_reason_type,emotion_score,checkin_source),
//     UNIQUE(class_id,user_id,attendance_date), status CHECK IN('present','absent','late','excused').
//   source 는 checkin_source 컬럼에 기록(예: 'lesson_view','homework_submit','exam_take',
//     'survey_respond','post_read','comment_write'). 미지정 시 'auto'.
function ensureTodayAttendance(classId, userId, source = 'auto') {
  if (!classId || !userId) return { success: false, skipped: true };
  const today = new Date().toISOString().slice(0, 10);

  // 이미 오늘 출석행이 있으면 무변경(수동 checkin·감정 데이터 보존).
  const existing = db.prepare(
    'SELECT id FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?'
  ).get(classId, userId, today);
  if (existing) return { success: false, already: true, id: existing.id };

  try {
    const info = db.prepare(`
      INSERT INTO attendance (class_id, user_id, attendance_date, status, checkin_source)
      VALUES (?, ?, ?, 'present', ?)
    `).run(classId, userId, today, source || 'auto');
    // 자동 출석도 게이미피케이션 스트릭·뱃지에 반영.
    checkAndAwardBadges(classId, userId);
    return { success: true, date: today, id: info.lastInsertRowid, auto: true };
  } catch (e) {
    // 동시 요청 레이스 등으로 UNIQUE 충돌 시 이미 기록된 것으로 간주(멱등 유지).
    if (e.message && e.message.includes('UNIQUE')) {
      return { success: false, already: true };
    }
    throw e;
  }
}

// 오늘 출석 여부 확인
function isCheckedIn(classId, userId) {
  const today = new Date().toISOString().slice(0, 10);
  return !!db.prepare(
    "SELECT id FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?"
  ).get(classId, userId, today);
}

// 날짜별 출석 목록 (교사용)
function getAttendanceByDate(classId, date) {
  return db.prepare(`
    SELECT a.*, u.display_name, u.username
    FROM attendance a JOIN users u ON a.user_id = u.id
    WHERE a.class_id = ? AND a.attendance_date = ?
    ORDER BY a.checked_at
  `).all(classId, date);
}

// 기간별 출석 현황 (교사용)
function getAttendanceRange(classId, startDate, endDate, includeWeekends = false) {
  let sql = `
    SELECT a.attendance_date, a.user_id, a.status, a.comment, a.checked_at,
           u.display_name, u.username
    FROM attendance a JOIN users u ON a.user_id = u.id
    WHERE a.class_id = ? AND a.attendance_date BETWEEN ? AND ?
    ORDER BY a.attendance_date, u.display_name
  `;
  return db.prepare(sql).all(classId, startDate, endDate);
}

// 연속 출석 일수 계산 (주말 제외, 주말에 출석해도 카운트)
function getStreak(classId, userId) {
  const rows = db.prepare(`
    SELECT attendance_date FROM attendance
    WHERE class_id = ? AND user_id = ? AND status = 'present'
    ORDER BY attendance_date DESC
  `).all(classId, userId);

  if (rows.length === 0) return 0;

  let streak = 1; // 가장 최근 출석일 포함
  const today = new Date().toISOString().slice(0, 10);
  const lastDate = rows[0].attendance_date;

  // 마지막 출석이 오늘도 어제도 아니면 스트릭 끊긴 것
  const diffFromToday = dateDiffDays(lastDate, today);
  if (diffFromToday > 1) {
    // 주말 건너뛰기: 금요일 출석 후 월요일이면 OK
    if (!isWeekendGap(lastDate, today)) return 0;
  }

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].attendance_date;
    const curr = rows[i].attendance_date;
    const diff = dateDiffDays(curr, prev);
    if (diff === 1 || isWeekendGap(curr, prev)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function dateDiffDays(earlier, later) {
  const d1 = new Date(earlier);
  const d2 = new Date(later);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

function isWeekendGap(earlier, later) {
  // 금요일→월요일 (3일 차이), 주말에 출석 안 해도 연속으로 인정
  const diff = dateDiffDays(earlier, later);
  if (diff <= 1) return true;
  if (diff > 3) return false;
  const d1 = new Date(earlier);
  const day1 = d1.getDay(); // 0=Sun
  // 금→월: day1=5, diff=3
  if (day1 === 5 && diff <= 3) return true;
  // 금→토→월 등 중간 주말 포함
  if (diff === 2) {
    // 토→월: day1=6, diff=2
    if (day1 === 6) return true;
  }
  return false;
}

// 전체 출석 통계 (학생 본인용)
function getUserStats(classId, userId) {
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM attendance WHERE class_id = ? AND user_id = ? AND status = 'present'"
  ).get(classId, userId).cnt;

  const streak = getStreak(classId, userId);
  const badges = getUserBadges(classId, userId);
  const title = getTitle(streak);

  return { totalDays: total, streak, badges, title };
}

// 칭호 계산
function getTitle(streak) {
  if (streak >= 100) return '출석의 전설';
  if (streak >= 50) return '출석 마스터';
  if (streak >= 30) return '출석 달인';
  if (streak >= 20) return '꾸준한 학습자';
  if (streak >= 10) return '성실한 학생';
  if (streak >= 5) return '출석 새싹';
  if (streak >= 3) return '시작이 반';
  return '새내기';
}

// 뱃지 시스템
const BADGE_DEFS = [
  { type: 'streak_3', name: '3일 연속 출석', check: (streak) => streak >= 3 },
  { type: 'streak_5', name: '5일 연속 출석', check: (streak) => streak >= 5 },
  { type: 'streak_10', name: '10일 연속 출석', check: (streak) => streak >= 10 },
  { type: 'streak_20', name: '20일 연속 출석', check: (streak) => streak >= 20 },
  { type: 'streak_30', name: '한 달 개근', check: (streak) => streak >= 30 },
  { type: 'streak_50', name: '50일 연속 출석', check: (streak) => streak >= 50 },
  { type: 'streak_100', name: '100일 연속 출석', check: (streak) => streak >= 100 },
];

function checkAndAwardBadges(classId, userId) {
  const streak = getStreak(classId, userId);
  const existing = db.prepare(
    'SELECT badge_type FROM attendance_badges WHERE class_id = ? AND user_id = ?'
  ).all(classId, userId).map(b => b.badge_type);

  for (const def of BADGE_DEFS) {
    if (def.check(streak) && !existing.includes(def.type)) {
      db.prepare(
        'INSERT INTO attendance_badges (class_id, user_id, badge_type, badge_name) VALUES (?, ?, ?, ?)'
      ).run(classId, userId, def.type, def.name);
    }
  }
}

function getUserBadges(classId, userId) {
  return db.prepare(
    'SELECT * FROM attendance_badges WHERE class_id = ? AND user_id = ? ORDER BY earned_at'
  ).all(classId, userId);
}

// 클래스 출석 랭킹
function getRanking(classId) {
  return db.prepare(`
    SELECT a.user_id, u.display_name, COUNT(*) as total_days,
           MAX(a.attendance_date) as last_date
    FROM attendance a JOIN users u ON a.user_id = u.id
    WHERE a.class_id = ? AND a.status = 'present'
    GROUP BY a.user_id
    ORDER BY total_days DESC, last_date DESC
  `).all(classId);
}

// 클래스 출석 통계 (교사 대시보드용)
function getClassStats(classId) {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM attendance WHERE class_id = ? AND attendance_date = ? AND status = 'present'"
  ).get(classId, today).cnt;

  const totalMembers = db.prepare(
    "SELECT COUNT(*) as cnt FROM class_members WHERE class_id = ? AND status = 'active' AND role IN ('student', 'owner', 'teacher', 'member')"
  ).get(classId).cnt;

  // 이번 주 출석 현황
  const weekStart = getWeekStart();
  const weekAttendance = db.prepare(`
    SELECT attendance_date, COUNT(*) as cnt
    FROM attendance
    WHERE class_id = ? AND attendance_date >= ? AND status = 'present'
    GROUP BY attendance_date
    ORDER BY attendance_date
  `).all(classId, weekStart);

  // ─── 게이미피케이션 통계 (RFP SFR-017) ────────────────────────────
  // 학생 멤버(role='member') 대상으로 연속 출석·뱃지 집계
  const studentMembers = db.prepare(
    "SELECT user_id FROM class_members WHERE class_id = ? AND status = 'active' AND role = 'member'"
  ).all(classId);

  let maxStreak = 0;
  let sumStreak = 0;
  for (const m of studentMembers) {
    const s = getStreak(classId, m.user_id) || 0;
    if (s > maxStreak) maxStreak = s;
    sumStreak += s;
  }
  const avgStreak = studentMembers.length > 0
    ? Math.round((sumStreak / studentMembers.length) * 10) / 10
    : 0;

  // 뱃지: badge_type별 획득자 수 집계 + 총 발급 수
  const badgeRows = db.prepare(`
    SELECT badge_type,
           COUNT(*) AS total_awarded,
           COUNT(DISTINCT user_id) AS unique_users
    FROM attendance_badges
    WHERE class_id = ?
    GROUP BY badge_type
    ORDER BY total_awarded DESC
  `).all(classId);
  const totalBadges = badgeRows.reduce((acc, b) => acc + (b.total_awarded || 0), 0);

  // totalStreak: 클래스 멤버 전체의 연속 출석일 집계 (최대치 강조)
  const totalStreak = {
    max: maxStreak,
    avg: avgStreak,
    sum: sumStreak,
    memberCount: studentMembers.length
  };

  // badges: 뱃지별 획득자 + 합산
  const badges = {
    total: totalBadges,
    byType: badgeRows
  };

  return { todayCount, totalMembers, weekAttendance, totalStreak, badges };
}

// 출석부 설정
function getSettings(classId) {
  let settings = db.prepare('SELECT * FROM attendance_settings WHERE class_id = ?').get(classId);
  if (!settings) {
    db.prepare('INSERT INTO attendance_settings (class_id) VALUES (?)').run(classId);
    settings = db.prepare('SELECT * FROM attendance_settings WHERE class_id = ?').get(classId);
  }
  return settings;
}

function updateSettings(classId, data) {
  const fields = [];
  const params = [];
  // 허용 컬럼: 기존 5종 + notify_absent / notify_time (도메인 전문가 보강, SFR-017)
  const allowed = ['is_public', 'show_ranking', 'allow_comments', 'include_weekends', 'class_goal', 'notify_absent', 'notify_time'];
  for (const [key, val] of Object.entries(data)) {
    if (allowed.includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return getSettings(classId);
  params.push(classId);
  db.prepare(`UPDATE attendance_settings SET ${fields.join(', ')} WHERE class_id = ?`).run(...params);
  return getSettings(classId);
}

// 멤버별 출석 테이블 (교사 엑셀 다운로드용)
function getAttendanceTable(classId, startDate, endDate, includeWeekends = false) {
  // 멤버 목록
  const members = db.prepare(`
    SELECT cm.user_id, u.display_name, u.username
    FROM class_members cm JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.status = 'active'
    ORDER BY u.display_name
  `).all(classId);

  // 출석 데이터 (checkin_source, emotion, emotion_reason 포함 — 4팀 통합 보고서·교사 테이블 노출용)
  const records = db.prepare(`
    SELECT user_id, attendance_date, status, comment, checkin_source, emotion, emotion_reason, checked_at
    FROM attendance
    WHERE class_id = ? AND attendance_date BETWEEN ? AND ?
  `).all(classId, startDate, endDate);

  // 날짜 목록 생성
  const dates = [];
  const d = new Date(startDate);
  const end = new Date(endDate);
  while (d <= end) {
    const day = d.getDay();
    if (includeWeekends || (day !== 0 && day !== 6)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() + 1);
  }

  // 멤버×날짜 매트릭스
  const recordMap = {};
  for (const r of records) {
    recordMap[`${r.user_id}_${r.attendance_date}`] = r;
  }

  return { members, dates, records: recordMap };
}

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

module.exports = {
  checkIn, ensureTodayAttendance, isCheckedIn, getAttendanceByDate, getAttendanceRange,
  getStreak, getUserStats, getRanking, getClassStats,
  getSettings, updateSettings, getAttendanceTable, getUserBadges
};
