const db = require('./index');
const classDb = require('./class');
const kst = require('../lib/kst');

// ═══════════════════════════════════════════════════════════════════════════
// 이 모듈의 두 가지 SSOT 의존 (사본 금지)
//
//  ① 날짜 귀속 — lib/kst.js
//     출석은 "몇 시에 왔나" 가 아니라 **"어느 날 왔나"** 가 판정 기준이다.
//     예전에는 `new Date().toISOString().slice(0,10)`(= UTC 날짜)을 썼는데,
//     KST 00:00~08:59 가 전날 UTC 로 떨어진다. 등교 체크인 시간대(08:00~08:50)가
//     정확히 그 구간이라 실사용 첫날부터 출석일이 하루씩 밀린다.
//     → 날짜는 전부 kst.kstToday() / kst.sqlKstDate() 로만 만든다.
//
//  ② 학생 모집단 — db/class.js studentPopulationSql()/getClassStudents()
//     class_members.role 의 실제 값은 owner/member 두 종뿐이다. 그래서
//     `role !== 'teacher'` 로 거르면 학부모·교직원이 통과하고,
//     `role === 'student'` 로 거르면 항상 0건이 된다. 둘 다 실제로 있었던 결함.
//     → 명단·분모·랭킹은 전부 db/class.js 의 한 벌을 쓴다.
// ═══════════════════════════════════════════════════════════════════════════

// 출석 체크 (1클릭)
function checkIn(classId, userId, comment = null, emotion = null, emotionReason = null, checkinSource = 'manual') {
  const today = kst.kstToday();
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
//   날짜 규칙은 기존 checkIn/isCheckedIn 과 동일(kst.kstToday(), KST 기준 YYYY-MM-DD).
//   스키마 근거(실 DB PRAGMA table_info): attendance(class_id,user_id,attendance_date,status,
//     comment,checked_at,emotion,emotion_reason,emotion_reason_type,emotion_score,checkin_source),
//     UNIQUE(class_id,user_id,attendance_date), status CHECK IN('present','absent','late','excused').
//   source 는 checkin_source 컬럼에 기록(예: 'lesson_view','homework_submit','exam_take',
//     'survey_respond','post_read','comment_write'). 미지정 시 'auto'.
function ensureTodayAttendance(classId, userId, source = 'auto') {
  if (!classId || !userId) return { success: false, skipped: true };
  const today = kst.kstToday();

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
  const today = kst.kstToday();
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
  const today = kst.kstToday();
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

// 날짜 연산은 lib/kst 의 달력 헬퍼를 쓴다.
//   예전에는 `new Date('YYYY-MM-DD').getDay()` 를 썼는데, 이 파싱은 UTC 자정이고
//   getDay() 는 로컬 요일이라 두 기준이 섞여 있었다(UTC 서쪽 지역에서 요일이 밀린다).
//   ymdWeekday/ymdDiffDays 는 둘 다 UTC 달력 기준이라 타임존과 무관하게 일정하다.
function dateDiffDays(earlier, later) {
  return kst.ymdDiffDays(earlier, later);
}

function isWeekendGap(earlier, later) {
  // 금요일→월요일 (3일 차이), 주말에 출석 안 해도 연속으로 인정
  const diff = dateDiffDays(earlier, later);
  if (diff == null) return false;
  if (diff <= 1) return true;
  if (diff > 3) return false;
  const day1 = kst.ymdWeekday(earlier); // 0=일
  // 금→월: day1=5, diff=3
  if (day1 === 5 && diff <= 3) return true;
  // 토→월: day1=6, diff=2
  if (diff === 2 && day1 === 6) return true;
  return false;
}

/** 주말(토·일)인가 — 학교일 분모 계산용. */
function isWeekendYmd(ymd) {
  const w = kst.ymdWeekday(ymd);
  return w === 0 || w === 6;
}

/** [from, to] 사이의 학교일(주말 제외) 'YYYY-MM-DD' 배열. */
function schoolDaysBetween(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur && cur <= to && guard++ < 400) {
    if (!isWeekendYmd(cur)) out.push(cur);
    cur = kst.kstAddDays(cur, 1);
  }
  return out;
}

/**
 * 기간 [from, to] 의 출석률(%) — 분모는 **학교일(주말 제외)**, 분자는 present/late.
 * 분모 0(방학·학기 시작 전 등)이면 0 을 돌려준다.
 */
function getRateBetween(classId, userId, from, to) {
  const days = schoolDaysBetween(from, to);
  if (days.length === 0) return 0;
  const ph = days.map(() => '?').join(',');
  const attended = db.prepare(`
    SELECT COUNT(DISTINCT attendance_date) AS cnt
    FROM attendance
    WHERE class_id = ? AND user_id = ?
      AND status IN ('present', 'late')
      AND attendance_date IN (${ph})
  `).get(classId, userId, ...days).cnt;
  return Math.min(100, Math.round((attended / days.length) * 100));
}

/** 역대 최고 연속 출석일 — 현재 스트릭이 끊겨도 "최고 기록" 은 남아야 한다. */
function getBestStreak(classId, userId) {
  const rows = db.prepare(`
    SELECT DISTINCT attendance_date FROM attendance
    WHERE class_id = ? AND user_id = ? AND status IN ('present', 'late')
    ORDER BY attendance_date ASC
  `).all(classId, userId).map(r => r.attendance_date);
  if (rows.length === 0) return 0;
  let best = 1, run = 1;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], curr = rows[i];
    const diff = dateDiffDays(prev, curr);
    // 연속 판정은 현재 스트릭(getStreak)과 동일한 규칙 — 주말 건너뜀 인정.
    if (diff === 1 || isWeekendGap(prev, curr)) run++;
    else run = 1;
    if (run > best) best = run;
  }
  return best;
}

/** 아직 못 받은 다음 뱃지 — "N일 남음" 안내용. 전부 달성했으면 null. */
function getNextBadge(streak) {
  const next = BADGE_DEFS.find(d => d.threshold > streak);
  if (!next) return null;
  return {
    type: next.type,
    name: next.name,
    threshold: next.threshold,
    remaining: Math.max(0, next.threshold - streak)
  };
}

/**
 * 전체 출석 통계 (학생 본인용).
 *
 * ⚠ 반환 키는 FE 계약이다(public/class/attendance.html loadStatus).
 *   this_week_rate·this_month_rate·best_streak·next_badge 가 빠져 있어서
 *   오늘 출석한 학생 화면에도 "이번 주 0% / 이번 달 0%" 도넛이 떴다(W2-T5-3).
 *   test/attendance-p1a.test.js INV-ATT-3 이 이 계약을 박제한다.
 *
 * @param {object} [opts] { ref } — 기준 시각(테스트용). 미지정 시 현재.
 */
function getUserStats(classId, userId, opts = {}) {
  const ref = opts.ref;
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM attendance WHERE class_id = ? AND user_id = ? AND status = 'present'"
  ).get(classId, userId).cnt;

  const streak = getStreak(classId, userId);
  const badges = getUserBadges(classId, userId);
  const title = getTitle(streak);

  // 주/월 출석률 — 기간 끝은 "오늘"까지. 아직 오지 않은 날을 분모에 넣으면
  // 월초에 출석률이 구조적으로 낮게 나와 학생이 손해를 본다.
  const today = kst.kstToday(ref);
  const week = kst.kstWeekRange(ref);
  const month = kst.kstMonthRange(ref);
  const this_week_rate = getRateBetween(classId, userId, week.start, today < week.end ? today : week.end);
  const this_month_rate = getRateBetween(classId, userId, month.start, today < month.end ? today : month.end);

  return {
    totalDays: total,
    streak,
    badges,
    title,
    best_streak: Math.max(streak, getBestStreak(classId, userId)),
    this_week_rate,
    this_month_rate,
    next_badge: getNextBadge(streak),
  };
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
// threshold 를 단일 출처로 두고 check 는 그로부터 파생시킨다.
//   (임계값이 두 곳에 적히면 "다음 목표" 안내와 실제 지급 기준이 어긋난다.)
const BADGE_DEFS = [
  { type: 'streak_3', name: '3일 연속 출석', threshold: 3 },
  { type: 'streak_5', name: '5일 연속 출석', threshold: 5 },
  { type: 'streak_10', name: '10일 연속 출석', threshold: 10 },
  { type: 'streak_20', name: '20일 연속 출석', threshold: 20 },
  { type: 'streak_30', name: '한 달 개근', threshold: 30 },
  { type: 'streak_50', name: '50일 연속 출석', threshold: 50 },
  { type: 'streak_100', name: '100일 연속 출석', threshold: 100 },
].map(d => ({ ...d, check: (streak) => streak >= d.threshold }));

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

/**
 * 클래스 출석 랭킹.
 *
 * 결함(W2-T5-6, 수정 전): 모집단 필터가 하나도 없어서
 *   · 개설자(교사)가 랭킹에 올라왔고 (실측: class1 "김선생 9위")
 *   · 탈퇴자(class_members.status='removed')의 출석 29건이 계속 집계됐으며
 *   · 동점자를 배열 인덱스로 줄 세워 같은 일수인데 순위가 달랐다.
 *
 * 정본: db/class.js 학생 모집단에 INNER JOIN + 표준 경쟁 순위(1,1,3).
 */
function getRanking(classId) {
  const rows = db.prepare(`
    SELECT a.user_id, u.display_name, COUNT(*) as total_days,
           MAX(a.attendance_date) as last_date
    FROM attendance a
    JOIN class_members cm ON cm.user_id = a.user_id AND cm.class_id = a.class_id
    JOIN users u ON u.id = a.user_id
    WHERE a.class_id = ? AND a.status = 'present'
      AND ${classDb.studentPopulationSql('cm', 'u')}
    GROUP BY a.user_id
    ORDER BY total_days DESC, last_date DESC, u.display_name ASC
  `).all(classId);

  // 표준 경쟁 순위(standard competition ranking): 동점은 같은 순위, 다음은 건너뛴다.
  let prevDays = null, prevRank = 0;
  return rows.map((r, idx) => {
    const rank = (r.total_days === prevDays) ? prevRank : idx + 1;
    prevDays = r.total_days;
    prevRank = rank;
    return { ...r, rank };
  });
}

// 클래스 출석 통계 (교사 대시보드용)
function getClassStats(classId) {
  const today = kst.kstToday();
  const todayCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM attendance WHERE class_id = ? AND attendance_date = ? AND status = 'present'"
  ).get(classId, today).cnt;

  // 분모는 순수 학생 수(SSOT). 예전에는 owner·member 를 전부 세어 교사·학부모·
  // 교직원까지 총원에 들어갔고, 그 총원으로 나눈 출석률이 구조적으로 낮게 나왔다.
  const totalMembers = classDb.getClassStudentCount(classId);

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
  // 순수 학생(SSOT) 대상으로 연속 출석·뱃지 집계.
  //   role='member' 만 보면 학부모·교직원의 스트릭이 평균에 섞인다.
  const studentMembers = classDb.getClassStudentIds(classId);

  let maxStreak = 0;
  let sumStreak = 0;
  for (const uid of studentMembers) {
    const s = getStreak(classId, uid) || 0;
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

// 멤버별 출석 테이블 (교사 화면 매트릭스 + 엑셀 다운로드)
function getAttendanceTable(classId, startDate, endDate, includeWeekends = false) {
  // 명단 = 순수 학생만 (SSOT).
  //   결함(W2-T5-4): status='active' 전원을 돌려주고 걸러내는 일을 FE·export 에
  //   맡겼는데, 그 필터가 class_members.role 을 봤다. 실제 값은 owner/member 뿐이라
  //   학부모(parent1)·교직원(staff1)이 그대로 통과해 명단·CSV·분모를 오염시켰다.
  //   ⚠ 과잉 필터 아님 — 여기서 빠지는 건 학생이 아니거나(학부모·교직원·교사)
  //     이 클래스 소속이 아닌(탈퇴) 사람뿐이다. 출석부는 학생 명부다.
  const members = classDb.getClassStudents(classId)
    .map(m => ({ user_id: m.user_id, display_name: m.display_name, username: m.username }));

  // 출석 데이터 (checkin_source, emotion, emotion_reason 포함 — 4팀 통합 보고서·교사 테이블 노출용)
  const records = db.prepare(`
    SELECT user_id, attendance_date, status, comment, checkin_source, emotion, emotion_reason, checked_at
    FROM attendance
    WHERE class_id = ? AND attendance_date BETWEEN ? AND ?
  `).all(classId, startDate, endDate);

  // 날짜 목록 생성 — 달력 문자열 연산(타임존 무관).
  //   예전에는 Date 객체를 로컬로 증가시키고 toISOString()(UTC)으로 되돌려서
  //   요일 판정과 출력 날짜의 기준이 서로 달랐다.
  const dates = [];
  let cur = String(startDate).slice(0, 10);
  const end = String(endDate).slice(0, 10);
  let guard = 0;
  while (cur && cur <= end && guard++ < 800) {
    if (includeWeekends || !isWeekendYmd(cur)) dates.push(cur);
    cur = kst.kstAddDays(cur, 1);
  }

  // 멤버×날짜 매트릭스
  const recordMap = {};
  for (const r of records) {
    recordMap[`${r.user_id}_${r.attendance_date}`] = r;
  }

  return { members, dates, records: recordMap };
}

function getWeekStart() {
  return kst.kstWeekStart();
}

module.exports = {
  checkIn, ensureTodayAttendance, isCheckedIn, getAttendanceByDate, getAttendanceRange,
  getStreak, getBestStreak, getUserStats, getRanking, getClassStats,
  getSettings, updateSettings, getAttendanceTable, getUserBadges,
  getRateBetween, schoolDaysBetween,
};
