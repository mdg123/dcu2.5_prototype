#!/usr/bin/env node
/**
 * seed-lrs-realistic.js
 *
 * LRS Phase 2 §5 — 현실적인 learning_logs 시드 데이터 생성기.
 *
 * 사용법:
 *   node scripts/seed-lrs-realistic.js            # 추가 삽입 (days=30)
 *   node scripts/seed-lrs-realistic.js --reset    # learning_logs 비우고 새로 생성
 *   node scripts/seed-lrs-realistic.js --days=14  # 최근 14일치
 *   node scripts/seed-lrs-realistic.js --class=1  # 특정 클래스 멤버만
 *
 * 설계 주의:
 * - Phase 2 ALTER 컬럼(duration_sec, session_id, device_type, platform, retry_count,
 *   correct_count, total_items, achievement_level, parent_statement_id,
 *   subject_code, grade_group)이 아직 적용되지 않았을 수 있다.
 *   PRAGMA table_info 로 존재하는 컬럼만 채운다.
 * - 학생 계정을 직접 생성하지 않는다. 부족하면 경고 후 진행.
 * - 생성 후 rebuildAllAggregates() 호출로 집계 테이블 재빌드.
 */

'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'db'));
const { rebuildAllAggregates } = require(path.join(__dirname, '..', 'db', 'lrs-aggregate'));
const { logLearningActivity } = require(path.join(__dirname, '..', 'db', 'learning-log-helper'));

// ─────────────────────────── CLI 파싱 ───────────────────────────
const args = process.argv.slice(2);
const flags = { reset: false, days: 30, classId: null };
for (const a of args) {
  if (a === '--reset') flags.reset = true;
  else if (a.startsWith('--days=')) flags.days = parseInt(a.slice(7), 10) || 30;
  else if (a.startsWith('--class=')) flags.classId = parseInt(a.slice(8), 10) || null;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node scripts/seed-lrs-realistic.js [--reset] [--days=30] [--class=<id>]');
    process.exit(0);
  }
}

console.log('[seed-lrs-realistic] opts:', flags);

// ─────────────────────────── 유틸 ───────────────────────────
function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickWeighted(pairs) {
  // pairs: [[value, weight], ...]
  const sum = pairs.reduce((s, p) => s + p[1], 0);
  let r = Math.random() * sum;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
function uuid() {
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ─────────────────────────── 컬럼 존재 체크 ───────────────────────────
const existingCols = new Set(
  db.prepare('PRAGMA table_info(learning_logs)').all().map(c => c.name)
);
function hasCol(name) { return existingCols.has(name); }

const REQUIRED_BASE = ['user_id', 'activity_type', 'target_type', 'target_id', 'class_id',
  'verb', 'object_type', 'object_id', 'result_score', 'result_success',
  'result_duration', 'source_service', 'achievement_code', 'metadata', 'statement_json', 'created_at'];
const OPTIONAL_PHASE2 = ['duration_sec', 'subject_code', 'grade_group', 'achievement_level',
  'session_id', 'device_type', 'platform', 'retry_count', 'correct_count', 'total_items', 'parent_statement_id'];

console.log('[seed-lrs-realistic] learning_logs 컬럼:', [...existingCols].length, '개');
const missingPhase2 = OPTIONAL_PHASE2.filter(c => !hasCol(c));
if (missingPhase2.length) {
  console.log('[seed-lrs-realistic] ⚠ Phase 2 미적용 컬럼(스킵):', missingPhase2.join(', '));
}

// ─────────────────────────── 학생 로드 ───────────────────────────
let students;
if (flags.classId) {
  students = db.prepare(`
    SELECT u.id, u.display_name, u.grade, u.class_number
    FROM users u
    JOIN class_members cm ON cm.user_id = u.id
    WHERE u.role = 'student' AND cm.class_id = ? AND cm.status = 'active'
    ORDER BY u.id
    LIMIT 30
  `).all(flags.classId);
} else {
  students = db.prepare(`
    SELECT id, display_name, grade, class_number
    FROM users
    WHERE role = 'student'
    ORDER BY id
    LIMIT 30
  `).all();
}
if (students.length === 0) {
  console.error('[seed-lrs-realistic] ✗ 학생(role=student) 계정이 없습니다. 시드 계정을 먼저 만드세요.');
  process.exit(1);
}
if (students.length < 30) {
  console.warn(`[seed-lrs-realistic] ⚠ 학생이 ${students.length}명뿐입니다. (목표 30명) — 계정을 생성하지 않고 진행합니다.`);
}
console.log(`[seed-lrs-realistic] 학생 ${students.length}명 사용.`);

// ─────────────────────────── 클래스 매핑 ───────────────────────────
const classMembership = db.prepare(`
  SELECT cm.user_id, cm.class_id, c.subject
  FROM class_members cm
  JOIN classes c ON c.id = cm.class_id
  WHERE cm.status = 'active'
`).all();
const userClasses = new Map(); // user_id -> [{class_id, subject}]
for (const m of classMembership) {
  if (!userClasses.has(m.user_id)) userClasses.set(m.user_id, []);
  userClasses.get(m.user_id).push({ class_id: m.class_id, subject: m.subject });
}

// ─────────────────────────── 커리큘럼 로드 ───────────────────────────
const allStandards = db.prepare(`
  SELECT code, subject_code, grade_group FROM curriculum_standards
  WHERE school_level = '초'
`).all();
if (allStandards.length === 0) {
  console.warn('[seed-lrs-realistic] ⚠ curriculum_standards(초) 비어있음. achievement_code=null 로 진행.');
}

// 학년군별 인덱싱 (초등 기준: 1-2학년군=2, 3-4학년군=4, 5-6학년군=6)
function gradeToGroup(g) {
  if (!g) return 4; // 기본 3-4학년
  if (g <= 2) return 2;
  if (g <= 4) return 4;
  return 6;
}
function standardsFor(gradeGroup) {
  return allStandards.filter(s => s.grade_group === gradeGroup);
}

// ─────────────────────────── 학생 프로필 지정 (부진/우수/경고) ───────────────────────────
// 부진 3명(평균 40~60, 미학습일 5+), 우수 1명(90+), 경고 2명(연속 3일 미학습)
// 학생 수가 부족하면 비율 유지해서 축소
const profiles = {}; // user_id -> {tier, avgScore, skipRate, warnTailDays}
const shuffled = [...students].sort(() => Math.random() - 0.5);
const nLow = Math.max(1, Math.round(students.length * (3 / 30)));
const nHigh = Math.max(1, Math.round(students.length * (1 / 30)));
const nWarn = Math.max(1, Math.round(students.length * (2 / 30)));

let idx = 0;
for (let i = 0; i < nLow && idx < shuffled.length; i++, idx++) {
  profiles[shuffled[idx].id] = { tier: 'low', avgScore: randInt(40, 60), skipRate: 0.30, warnTail: 0 };
}
for (let i = 0; i < nHigh && idx < shuffled.length; i++, idx++) {
  profiles[shuffled[idx].id] = { tier: 'high', avgScore: randInt(90, 98), skipRate: 0.02, warnTail: 0 };
}
for (let i = 0; i < nWarn && idx < shuffled.length; i++, idx++) {
  profiles[shuffled[idx].id] = { tier: 'warn', avgScore: randInt(55, 75), skipRate: 0.15, warnTail: randInt(3, 5) };
}
for (; idx < shuffled.length; idx++) {
  profiles[shuffled[idx].id] = { tier: 'normal', avgScore: randInt(70, 88), skipRate: 0.10, warnTail: 0 };
}
console.log('[seed-lrs-realistic] 프로필:', Object.entries(profiles).reduce((a, [k, v]) => { a[v.tier] = (a[v.tier] || 0) + 1; return a; }, {}));

// ─────────────────────────── 분포 정의 ───────────────────────────
const ACTIVITY_DIST = [
  // [activity_type, weight, verb, target_type, source_service, hasScore]
  ['lesson_view',     40, 'accessed',   'lesson',   'class',       false],
  ['content_view',    25, 'accessed',   'content',  'content',     false],
  ['self_learn',      20, 'completed',  'daily_learning', 'self-learn', true],
  ['exam_complete',    7, 'answered',   'exam',     'cbt',         true],
  ['homework_submit',  5, 'submitted',  'homework', 'class',       true],
  ['post_create',      1, 'created',    'post',     'growth',      false],
  ['attendance_checkin', 1, 'attended', 'attendance', 'portal',    false],
  ['portfolio_add',    1, 'created',    'portfolio', 'growth',     false],
];

const DEVICE_DIST = [['web', 60], ['android', 25], ['ios', 15]];
const PLATFORM_BY_DEVICE = { web: 'web-chrome', android: 'android-app', ios: 'ios-app' };

// 시간대 분포 (hour, weight)
const HOUR_DIST = [];
// 08-09시 15%
for (const h of [8]) HOUR_DIST.push([h, 15]);
// 10-13시 35% (10,11,12)
for (const h of [10, 11, 12]) HOUR_DIST.push([h, 35 / 3]);
// 13-15시 30% (13,14)
for (const h of [13, 14]) HOUR_DIST.push([h, 30 / 2]);
// 19-21시 20% (19,20)
for (const h of [19, 20]) HOUR_DIST.push([h, 20 / 2]);

// ─────────────────────────── 리셋 ───────────────────────────
function tableExists(n) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
}
if (flags.reset) {
  const before = db.prepare('SELECT COUNT(*) c FROM learning_logs').get().c;
  db.prepare('DELETE FROM learning_logs').run();
  // Phase 2: 세션 스냅샷도 초기화해야 새 세션과 일치
  if (tableExists('lrs_session_stats')) db.prepare('DELETE FROM lrs_session_stats').run();
  // 집계 테이블도 초기화 (UPSERT 경로는 누적이므로 재빌드 전에 비움)
  for (const t of ['lrs_daily_stats','lrs_user_summary','lrs_content_summary','lrs_class_summary','lrs_service_stats','lrs_user_daily','lrs_achievement_stats']) {
    if (tableExists(t)) db.prepare(`DELETE FROM ${t}`).run();
  }
  console.log(`[seed-lrs-realistic] --reset: learning_logs ${before}건 + 세션/집계 삭제`);
}

// ─────────────────────────── lrs_session_stats 선(先) 생성 ───────────────────────────
// helper.logLearningActivity 가 session activity_count 를 increment 하므로
// 세션 행이 먼저 있어야 FK-like 정합성이 유지된다. (D3 해결 포인트)
const hasSessionStats = tableExists('lrs_session_stats');
function createSessionRow({ sessionId, userId, classId, deviceType, startedAtIso }) {
  if (!hasSessionStats) return;
  try {
    db.prepare(`
      INSERT INTO lrs_session_stats (session_id, user_id, class_id, started_at, activity_count, device_type)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, userId, classId || null, startedAtIso, deviceType || null);
  } catch (_) {
    // ON CONFLICT 미지원/스키마 차이 fallback
    try {
      db.prepare(`INSERT OR IGNORE INTO lrs_session_stats (session_id, user_id, class_id, started_at, activity_count, device_type) VALUES (?, ?, ?, ?, 0, ?)`)
        .run(sessionId, userId, classId || null, startedAtIso, deviceType || null);
    } catch (_) {}
  }
}

// ─────────────────────────── 단일 로그 기록 래퍼 ───────────────────────────
function seedOneLog({ userId, classId, activityType, verb, targetType, sourceService, hasScore, profile, subjectCode, gradeGroup, achievementCode, createdAtIso, durationSec, device }) {
  const targetId = String(randInt(1, 500));
  const objectId = `urn:dacheum:${targetType}:${targetId}`;

  let score = null, success = null, correct = null, total = null, achvLevel = null, retry = 0;
  if (hasScore) {
    const base = profile.avgScore + rand(-15, 15);
    score = Math.max(0, Math.min(100, Math.round(base)));
    success = score >= 60 ? 1 : 0;
    if (activityType === 'exam_complete' || activityType === 'self_learn') {
      total = pick([5, 10, 15, 20]);
      correct = Math.round(total * (score / 100));
      retry = score < 60 ? randInt(0, 2) : 0;
    }
    achvLevel = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
  }

  return logLearningActivity({
    userId,
    activityType,
    targetType,
    targetId,
    classId: classId || null,
    verb,
    objectType: 'Activity',
    objectId,
    resultScore: score,
    resultSuccess: success, // 1/0/null — SQLite bind 호환
    resultDuration: `PT${durationSec}S`,
    sourceService,
    achievementCode,
    metadata: { seed: 'lrs-realistic', tier: profile.tier, subject: subjectCode || undefined },
    sessionId: device.sessionId,
    durationSec,
    deviceType: device.type,
    platform: PLATFORM_BY_DEVICE[device.type] || device.type,
    retryCount: retry,
    correctCount: correct,
    totalItems: total,
    achievementLevel: achvLevel,
    subjectCode,
    gradeGroup,
    createdAt: createdAtIso
  });
}

// ─────────────────────────── 메인 루프 ───────────────────────────
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

let totalInserted = 0;

for (const student of students) {
  const profile = profiles[student.id];
  const gradeGroup = gradeToGroup(student.grade);
  const myClasses = userClasses.get(student.id) || [];

  for (let dayOffset = flags.days - 1; dayOffset >= 0; dayOffset--) {
    const day = new Date(today);
    day.setDate(day.getDate() - dayOffset);

    // 경고 학생: 최근 N일 연속 미학습
    if (profile.tier === 'warn' && dayOffset < profile.warnTail) continue;

    // 부진: 미학습일 5+ → skipRate 높음
    if (Math.random() < profile.skipRate) continue;

    // 일 평균 5~15건, 부진은 하한, 우수는 상한
    let dailyCount;
    if (profile.tier === 'low') dailyCount = randInt(3, 8);
    else if (profile.tier === 'high') dailyCount = randInt(10, 18);
    else dailyCount = randInt(5, 15);

    // 하루에 1~3 세션
    const numSessions = randInt(1, 3);
    const sessions = [];
    for (let s = 0; s < numSessions; s++) {
      const dev = pickWeighted(DEVICE_DIST);
      const sid = uuid();
      sessions.push({ sessionId: sid, type: dev });
      // lrs_session_stats 에 세션 행 선행 등록 (started_at = 해당 날짜 오전)
      const startDate = new Date(day);
      startDate.setHours(8, 0, 0, 0);
      const startedAtIso = startDate.toISOString().replace('T', ' ').substring(0, 19);
      createSessionRow({ sessionId: sid, userId: student.id, classId: (myClasses.length ? myClasses[0].class_id : null), deviceType: dev, startedAtIso });
    }

    for (let i = 0; i < dailyCount; i++) {
      const chosenType = pickWeighted(ACTIVITY_DIST.map(x => [x[0], x[1]]));
      const actEntry = ACTIVITY_DIST.find(a => a[0] === chosenType) || ACTIVITY_DIST[0];
      const activityType = actEntry[0];
      const verb = actEntry[2];
      const targetType = actEntry[3];
      const sourceService = actEntry[4];
      const hasScore = actEntry[5];

      const hour = pickWeighted(HOUR_DIST);
      const minute = randInt(0, 59);
      const second = randInt(0, 59);
      const ts = new Date(day);
      ts.setHours(hour, minute, second, 0);
      const createdAtIso = ts.toISOString().replace('T', ' ').substring(0, 19);

      // duration
      let durationSec;
      switch (activityType) {
        case 'lesson_view':   durationSec = randInt(300, 2400); break;   // 5-40분
        case 'content_view':  durationSec = randInt(120, 900); break;    // 2-15분
        case 'self_learn':    durationSec = randInt(300, 1800); break;   // 5-30분
        case 'exam_complete': durationSec = randInt(600, 2700); break;   // 10-45분
        case 'homework_submit': durationSec = randInt(600, 3600); break; // 10-60분
        default:              durationSec = randInt(30, 300); break;
      }

      // 교과 & 성취기준 선택
      // 학생이 속한 클래스의 과목에서 선택 (없으면 랜덤)
      const classChoice = myClasses.length ? pick(myClasses) : null;
      const classIdForLog = classChoice ? classChoice.class_id : null;

      // subject_code 는 curriculum_standards.subject_code 와 맞춘다
      const subjectPool = ['korean-e', 'math-e', 'science-e', 'social-e', 'english-e'];
      const subjectCode = pick(subjectPool);

      const candidates = allStandards.filter(s => s.subject_code === subjectCode && s.grade_group === gradeGroup);
      let achievementCode = null;
      if (candidates.length) {
        // 각 학생이 자주 다루는 achievement 약 20-30개 풀에서 선택 → 분포 현실화
        const studentPoolSize = Math.min(25, candidates.length);
        const seed = student.id;
        const pool = candidates.slice(0, studentPoolSize);
        // 랜덤한 salt 기반으로 일부 섞기
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        achievementCode = chosen.code;
      }

      const device = pick(sessions);

      const ret = seedOneLog({
        userId: student.id,
        classId: classIdForLog,
        activityType, verb, targetType, sourceService,
        hasScore,
        profile,
        subjectCode,
        gradeGroup,
        achievementCode,
        createdAtIso,
        durationSec,
        device
      });
      if (ret && ret.id) totalInserted++;
    }
  }
}

totalInserted = db.prepare('SELECT COUNT(*) c FROM learning_logs').get().c;
console.log(`[seed-lrs-realistic] learning_logs 총 ${totalInserted}건`);

// ─────────────────────────── 집계 재빌드 ───────────────────────────
// rebuildAllAggregates 는 Phase 2 신규 테이블(lrs_achievement_stats 등)을 건드릴 수 있다.
// 미적용 환경에서는 실패하므로, 실패 시 동등 로직을 수동 수행한다.
function rebuildAggregatesSafe() {
  try {
    rebuildAllAggregates();
    return;
  } catch (e) {
    console.warn('[seed-lrs-realistic] rebuildAllAggregates 실패, 수동 재집계로 폴백:', e.message);
  }
  const existsTable = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const tx = db.transaction(() => {
    if (existsTable('lrs_daily_stats')) {
      db.exec('DELETE FROM lrs_daily_stats');
      db.exec(`
        INSERT INTO lrs_daily_stats (stat_date, activity_type, source_service, class_id, activity_count, unique_users, avg_score, total_duration)
        SELECT DATE(created_at), activity_type,
               COALESCE(source_service, ''), COALESCE(class_id, 0),
               COUNT(*), COUNT(DISTINCT user_id),
               AVG(result_score),
               COALESCE(SUM(CAST(result_duration AS INTEGER)), 0)
        FROM learning_logs
        GROUP BY DATE(created_at), activity_type, COALESCE(source_service,''), COALESCE(class_id,0)
      `);
    }
    if (existsTable('lrs_user_summary')) {
      db.exec('DELETE FROM lrs_user_summary');
      db.exec(`
        INSERT INTO lrs_user_summary (user_id, activity_type, total_count, total_duration, avg_score, last_activity_at)
        SELECT user_id, activity_type, COUNT(*),
               COALESCE(SUM(CAST(result_duration AS INTEGER)),0),
               AVG(result_score), MAX(created_at)
        FROM learning_logs
        GROUP BY user_id, activity_type
      `);
    }
    if (existsTable('lrs_content_summary')) {
      db.exec('DELETE FROM lrs_content_summary');
      db.exec(`
        INSERT INTO lrs_content_summary (target_type, target_id, view_count, complete_count, unique_users, avg_score)
        SELECT target_type, target_id,
               SUM(CASE WHEN verb='accessed' OR activity_type LIKE '%view%' THEN 1 ELSE 0 END),
               SUM(CASE WHEN verb IN ('completed','submitted','answered') THEN 1 ELSE 0 END),
               COUNT(DISTINCT user_id), AVG(result_score)
        FROM learning_logs
        WHERE target_type IS NOT NULL AND target_id IS NOT NULL
        GROUP BY target_type, target_id
      `);
    }
    if (existsTable('lrs_class_summary')) {
      db.exec('DELETE FROM lrs_class_summary');
      db.exec(`
        INSERT INTO lrs_class_summary (class_id, activity_type, total_count, unique_users, avg_score)
        SELECT class_id, activity_type, COUNT(*), COUNT(DISTINCT user_id), AVG(result_score)
        FROM learning_logs WHERE class_id IS NOT NULL
        GROUP BY class_id, activity_type
      `);
    }
    if (existsTable('lrs_service_stats')) {
      db.exec('DELETE FROM lrs_service_stats');
      db.exec(`
        INSERT INTO lrs_service_stats (source_service, verb, total_count, unique_users, avg_score)
        SELECT COALESCE(source_service,'unknown'), verb, COUNT(*), COUNT(DISTINCT user_id), AVG(result_score)
        FROM learning_logs
        GROUP BY COALESCE(source_service,'unknown'), verb
      `);
    }
  });
  tx();
  console.log('[seed-lrs-realistic] 수동 재집계 완료');
}
rebuildAggregatesSafe();

// ─────────────────────────── 검증 리포트 ───────────────────────────
const verify = {
  total: db.prepare('SELECT COUNT(*) c FROM learning_logs').get().c,
  distinctAchv: db.prepare("SELECT COUNT(DISTINCT achievement_code) c FROM learning_logs WHERE achievement_code IS NOT NULL").get().c,
  userSummary: db.prepare('SELECT COUNT(DISTINCT user_id) c FROM lrs_user_summary').get().c,
  dailyStats: db.prepare('SELECT COUNT(*) c FROM lrs_daily_stats').get().c,
  byActivity: db.prepare('SELECT activity_type, COUNT(*) c FROM learning_logs GROUP BY activity_type ORDER BY c DESC').all(),
};
console.log('[seed-lrs-realistic] 검증:', verify);

console.log('\n=== 완료 ===');
console.log(`학생 수: ${students.length} / 로그: ${verify.total} / 성취기준 종류: ${verify.distinctAchv}`);
process.exit(0);
