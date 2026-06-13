#!/usr/bin/env node
/**
 * seed-lrs-macro.js — LRS 관리자 거시분석용 격리 더미 시드 (중형 B)
 *
 * 기획서: 작업지시서/LRS_관리자_거시분석_기획서.md §5(C) + 사용자 확정 "중형 B"
 *
 * 사용법:
 *   node scripts/seed-lrs-macro.js --apply        # 시드 생성 (is_seed=1)
 *   node scripts/seed-lrs-macro.js --clean        # 시드 전부 삭제 (실데이터 불변)
 *   node scripts/seed-lrs-macro.js --stats        # 현재 통계만 출력 (변경 없음)
 *   node scripts/seed-lrs-macro.js --apply --no-rebuild  # 집계 재빌드 생략(디버그)
 *
 * 규모(중형 B):
 *   - 11개 교육지원청(region) × 학교 30개(초18·중8·고4, 한국식 실명풍)
 *   - 학생 600 · 교사 60 (username: seed_s001.. / seed_t001..)
 *   - learning_logs 약 10만행 (최근 90일, 평일 주간·저녁 피크, 주말 저조)
 *
 * 설계 핵심(화면이 "보이게"):
 *   - 학생별 잠재 성실도 θ∈[0,1] → 활동량 ∝ θ, 성취점수 ∝ θ ⇒ 활동↔성취 r≈0.5~0.7
 *   - 학교급/지역 평균 차이 소폭 주입(거시 비교가 밋밋하지 않게)
 *   - 저사용 서비스(survey/portal) 1~2%만 → "안 쓰이는 서비스" 진단 발동
 *   - 시드 가능 PRNG(mulberry32)로 재현 가능
 *
 * 격리:
 *   - users.is_seed=1 / learning_logs.is_seed=1
 *   - username 접두사 seed_  →  --clean 한 번에 원복
 *   - 거시 집계는 is_seed 무관 전체 합산(시드+실 함께 보임)
 */
'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const db = require(path.join(__dirname, '..', 'db', 'index'));
let rebuildAllAggregates = null;
try {
  ({ rebuildAllAggregates } = require(path.join(__dirname, '..', 'db', 'lrs-aggregate')));
} catch (_) { /* 폴백은 아래에서 처리 */ }

// ─────────────────────────── CLI ───────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--clean') ? 'clean' : has('--stats') ? 'stats' : has('--apply') ? 'apply' : null;
const NO_REBUILD = has('--no-rebuild');
if (!MODE) {
  console.log('Usage: node scripts/seed-lrs-macro.js [--apply | --clean | --stats] [--no-rebuild]');
  process.exit(1);
}

// ─────────────────────────── 재현 가능 PRNG ───────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260613;
const rng = mulberry32(SEED);
const rnd = () => rng();
const randInt = (lo, hi) => Math.floor(rnd() * (hi - lo + 1)) + lo;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const gauss = () => { // Box-Muller (대략 정규)
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const pickWeighted = (pairs) => {
  const sum = pairs.reduce((s, p) => s + p[1], 0);
  let r = rnd() * sum;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
};

// ─────────────────────────── 컬럼 가드 ───────────────────────────
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
const llCols = new Set(db.prepare('PRAGMA table_info(learning_logs)').all().map(c => c.name));
if (!userCols.has('region') || !userCols.has('is_seed') || !llCols.has('is_seed')) {
  console.error('[seed-lrs-macro] ✗ 마이그레이션 미적용: users.region/is_seed 또는 learning_logs.is_seed 컬럼 없음.');
  console.error('  서버를 한 번 기동(initSchema)하거나 node -e "require(\'./db/schema\').initSchema()" 후 재실행하세요.');
  process.exit(1);
}

// ─────────────────────────── 도메인 상수 ───────────────────────────
// 11개 교육지원청. [지역, 학교 수, 활동/성취 보정 bias] — 청주(도시) 약간↑, 군지역 약간↓
const REGIONS = [
  { name: '청주', schools: 8, bias: +0.06 },
  { name: '충주', schools: 4, bias: +0.02 },
  { name: '제천', schools: 3, bias: +0.01 },
  { name: '보은', schools: 2, bias: -0.03 },
  { name: '옥천', schools: 2, bias: -0.02 },
  { name: '영동', schools: 2, bias: -0.03 },
  { name: '증평', schools: 2, bias: -0.01 },
  { name: '진천', schools: 2, bias:  0.00 },
  { name: '괴산', schools: 2, bias: -0.04 },
  { name: '음성', schools: 2, bias: -0.01 },
  { name: '단양', schools: 1, bias: -0.05 },
];
// 합계 학교 30개. 급별 목표분포: 초 18 · 중 8 · 고 4.

// 학교명 풍(風) 어절 풀 — 한국식 실명풍, region별 접두 + 어간 + 급별 접미
const SCHOOL_STEMS = ['중앙', '신', '동', '서', '남', '북', '한솔', '버들', '봉명', '용암', '가경', '복대',
  '운호', '주성', '내수', '오창', '청남', '대성', '금천', '솔밭', '미평', '교현', '수곡', '산남'];
const LEVELS = [
  { key: 'elementary', suffix: '초등학교', grades: [1, 2, 3, 4, 5, 6] },
  { key: 'middle',     suffix: '중학교',   grades: [1, 2, 3] },
  { key: 'high',       suffix: '고등학교', grades: [1, 2, 3] },
];

// 한국어 이름 생성
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구'.split('');
const GIVEN1 = '민서지예준현우도하시은주가나윤소영재호태수연승규세진'.split('');
const GIVEN2 = '준호윤서연우진아영수빈서현지율찬혁성민호은희정아람들'.split('');
function koreanName() {
  return pick(SURNAMES) + pick(GIVEN1) + pick(GIVEN2);
}

// 활동 유형 분포 [activity_type, weight, verb, target_type, source_service, hasScore]
// source_service 가중: content 50 · self-learn 20 · class 15 · cbt 8 · growth 5 · (survey/portal 저사용)
const ACTIVITY_DIST = [
  ['content_view',      38, 'accessed',  'content',        'content',    false],
  ['content_complete',  10, 'completed',  'content',       'content',    true ],
  ['self_learn',        14, 'completed',  'daily_learning','self-learn', true ],
  ['wrong_note_retry',   5, 'attempted',  'wrong_note',    'self-learn', true ],
  ['lesson_view',       10, 'accessed',   'lesson',        'class',      false],
  ['homework_submit',    4, 'submitted',  'homework',      'class',      true ],
  ['exam_complete',      7, 'answered',   'exam',          'cbt',        true ],
  ['problem_attempt',    4, 'attempted',  'problem',       'cbt',        true ],
  ['attendance_checkin', 3, 'attended',   'attendance',    'growth',     false],
  ['portfolio_add',      2, 'created',    'portfolio',     'growth',     false],
  // ── 저사용 서비스(의도적 1~2%): survey / portal ──
  ['survey_respond',     1, 'responded',  'survey',        'survey',     false],
  ['post_view',          1, 'accessed',   'post',          'portal',     false],
];

// 교과 분포(KOR/MAT/ENG↑, 음악·도덕↓ — 교과 활용 격차 가시화). 초등 코드 기준.
const SUBJECT_DIST = [
  ['math-e',    24], ['korean-e', 22], ['english-e', 18], ['science-e', 14],
  ['social-e',  12], ['music-e',   4], ['art-e',      3], ['moral-e',   3],
];
const DEVICE_DIST = [['web', 58], ['android', 27], ['ios', 15]];
const PLATFORM_BY_DEVICE = { web: 'web-chrome', android: 'android-app', ios: 'ios-app' };

const SEED_PASSWORD_HASH = bcrypt.hashSync('1234', 10); // 시드 계정 공통 비번 1234

// ─────────────────────────── --stats ───────────────────────────
function printStats() {
  const seedUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE is_seed=1").get().c;
  const seedStu = db.prepare("SELECT COUNT(*) c FROM users WHERE is_seed=1 AND role='student'").get().c;
  const seedTea = db.prepare("SELECT COUNT(*) c FROM users WHERE is_seed=1 AND role='teacher'").get().c;
  const seedLogs = db.prepare("SELECT COUNT(*) c FROM learning_logs WHERE is_seed=1").get().c;
  const realUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE COALESCE(is_seed,0)=0").get().c;
  const realLogs = db.prepare("SELECT COUNT(*) c FROM learning_logs WHERE COALESCE(is_seed,0)=0").get().c;

  console.log('\n========== LRS MACRO SEED — STATS ==========');
  console.log(`시드 사용자: ${seedUsers} (학생 ${seedStu} / 교사 ${seedTea})`);
  console.log(`시드 로그  : ${seedLogs}`);
  console.log(`실데이터 사용자(불변 기준): ${realUsers} / 실데이터 로그: ${realLogs}`);

  if (seedUsers > 0) {
    console.log('\n[지역별 학생/학교 분포]');
    console.table(db.prepare(`
      SELECT region, COUNT(DISTINCT school_name) AS 학교수, COUNT(*) AS 학생수
      FROM users WHERE is_seed=1 AND role='student'
      GROUP BY region ORDER BY 학생수 DESC
    `).all());

    console.log('[학교급별 학생 분포]');
    console.table(db.prepare(`
      SELECT school_level, COUNT(DISTINCT school_name) AS 학교수, COUNT(*) AS 학생수
      FROM users WHERE is_seed=1 AND role='student'
      GROUP BY school_level
    `).all());

    console.log('[로그 기간 커버]');
    console.table(db.prepare("SELECT MIN(DATE(created_at)) 시작, MAX(DATE(created_at)) 종료, COUNT(DISTINCT DATE(created_at)) 일수 FROM learning_logs WHERE is_seed=1").all());

    console.log('[서비스별 비중(시드)]');
    console.table(db.prepare(`
      SELECT source_service AS 서비스, COUNT(*) AS 건수,
             ROUND(100.0*COUNT(*)/(SELECT COUNT(*) FROM learning_logs WHERE is_seed=1), 2) AS 비중퍼센트
      FROM learning_logs WHERE is_seed=1
      GROUP BY source_service ORDER BY 건수 DESC
    `).all());

    // 활동량 × 성취 상관계수 (학생별 활동수 vs 평균점수)
    const pairs = db.prepare(`
      SELECT u.id,
             COUNT(*) AS acts,
             AVG(ll.result_score) AS avgscore
      FROM users u JOIN learning_logs ll ON ll.user_id=u.id
      WHERE u.is_seed=1 AND u.role='student' AND ll.is_seed=1
      GROUP BY u.id
      HAVING avgscore IS NOT NULL
    `).all();
    const r = pearson(pairs.map(p => p.acts), pairs.map(p => p.avgscore));
    console.log(`\n[활동량 × 평균성취 상관계수 r = ${r.toFixed(4)}]  (n=${pairs.length} 학생)`);

    // 콘텐츠 활용 상/하위 33% 집단 성취 격차
    printQuartileGap();
  }
  console.log('============================================\n');
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return (dx === 0 || dy === 0) ? 0 : num / Math.sqrt(dx * dy);
}

function printQuartileGap() {
  const rows = db.prepare(`
    SELECT u.id,
           SUM(CASE WHEN ll.source_service='content' THEN 1 ELSE 0 END) AS content_acts,
           AVG(ll.result_score) AS avgscore
    FROM users u JOIN learning_logs ll ON ll.user_id=u.id
    WHERE u.is_seed=1 AND u.role='student' AND ll.is_seed=1
    GROUP BY u.id HAVING avgscore IS NOT NULL
    ORDER BY content_acts ASC
  `).all();
  if (rows.length < 6) return;
  const lo = rows.slice(0, Math.floor(rows.length / 3));
  const hi = rows.slice(Math.ceil(rows.length * 2 / 3));
  const avg = (a) => a.reduce((s, x) => s + x.avgscore, 0) / a.length;
  const gap = avg(hi) - avg(lo);
  console.log(`[콘텐츠 활용 상위33% vs 하위33% 평균점수 격차 = +${gap.toFixed(1)}%p]  (상위 ${avg(hi).toFixed(1)} / 하위 ${avg(lo).toFixed(1)})`);
}

// ─────────────────────────── 시드 청소(공통) ───────────────────────────
// 시드 사용자/로그 + 그들을 참조하는 파생 행을 FK 순서에 맞게 모두 삭제한다.
// 집계 테이블(lrs_user_summary 등)은 rebuild 가 시드 user_id 를 채울 수 있으므로
// users 삭제 전에 시드 user_id 참조 행을 제거한다. (실데이터 행은 건드리지 않음)
function purgeSeed() {
  // 시드 user_id 를 참조할 수 있는 user-FK 테이블 (rebuild 산출물 + 시드 부수 데이터)
  const userRefTables = [
    ['lrs_user_summary', 'user_id'],
    ['lrs_user_daily', 'user_id'],
    ['lrs_achievement_stats', 'user_id'],
    ['lrs_session_stats', 'user_id'],
    ['class_members', 'user_id'],
    ['portfolio_items', 'user_id'],
    ['growth_goals', 'user_id'],
    ['user_points', 'user_id'],
    ['notifications', 'user_id'],
  ];
  const tableExists = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const tx = db.transaction(() => {
    // 1) 시드 로그
    db.prepare('DELETE FROM learning_logs WHERE is_seed=1').run();
    // 2) 시드 user_id 참조 행 (존재하는 테이블만)
    for (const [tbl, col] of userRefTables) {
      if (!tableExists(tbl)) continue;
      try {
        db.prepare(`DELETE FROM ${tbl} WHERE ${col} IN (SELECT id FROM users WHERE is_seed=1)`).run();
      } catch (_) { /* 컬럼 부재 등 무시 */ }
    }
    // 3) 시드 사용자가 owner 인 클래스
    try { db.prepare(`DELETE FROM classes WHERE owner_id IN (SELECT id FROM users WHERE is_seed=1)`).run(); } catch (_) {}
    // 4) 시드 사용자
    db.prepare('DELETE FROM users WHERE is_seed=1').run();
  });
  tx();
}

// ─────────────────────────── --clean ───────────────────────────
function clean() {
  const before = {
    users: db.prepare('SELECT COUNT(*) c FROM users WHERE is_seed=1').get().c,
    logs: db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE is_seed=1').get().c,
  };
  purgeSeed();
  const after = {
    users: db.prepare('SELECT COUNT(*) c FROM users WHERE is_seed=1').get().c,
    logs: db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE is_seed=1').get().c,
  };
  console.log(`[seed-lrs-macro] --clean: 시드 사용자 ${before.users}→${after.users}, 시드 로그 ${before.logs}→${after.logs}`);
  if (after.users !== 0 || after.logs !== 0) {
    console.error('  ⚠ 시드 잔존! is_seed=1 행이 남아있습니다.');
  }
  // 실데이터 불변 확인
  const real = {
    users: db.prepare("SELECT COUNT(*) c FROM users WHERE COALESCE(is_seed,0)=0").get().c,
    logs: db.prepare("SELECT COUNT(*) c FROM learning_logs WHERE COALESCE(is_seed,0)=0").get().c,
  };
  console.log(`  실데이터 보존: 사용자 ${real.users} / 로그 ${real.logs}`);
  if (!NO_REBUILD) doRebuild();
}

// ─────────────────────────── --apply ───────────────────────────
function apply() {
  // 멱등성: 기존 시드 있으면 먼저 청소
  const existing = db.prepare('SELECT COUNT(*) c FROM users WHERE is_seed=1').get().c;
  if (existing > 0) {
    console.log(`[seed-lrs-macro] 기존 시드 ${existing}명 감지 → 먼저 청소 후 재생성(멱등).`);
    purgeSeed();
  }

  const t0 = Date.now();

  // ── 1. 학교 생성: region별 학교 수, 급별 분포(초18·중8·고4) ──
  const schools = buildSchools();
  console.log(`[seed-lrs-macro] 학교 ${schools.length}개 생성 (초 ${schools.filter(s => s.level === 'elementary').length} · 중 ${schools.filter(s => s.level === 'middle').length} · 고 ${schools.filter(s => s.level === 'high').length})`);

  // ── 2. 사용자(학생 600·교사 60) 생성 ──
  const insUser = db.prepare(`
    INSERT INTO users (username, password, display_name, role, school_name, region, grade, class_number, school_level, status, is_seed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)
  `);

  const students = [];
  const teachers = [];
  const TARGET_STUDENTS = 600, TARGET_TEACHERS = 60;
  // 학생을 학교에 배분(가중: 큰 급=초가 더 많이). 학교당 대략 균등 + 약간 변동.
  const perSchoolBase = Math.floor(TARGET_STUDENTS / schools.length);

  const nowMs = Date.now();
  let sIdx = 0, tIdx = 0;
  const insertAll = db.transaction(() => {
    for (const sc of schools) {
      // 학교 규모: 초 약간 큼, 군지역 약간 작음
      const sizeFactor = (sc.level === 'elementary' ? 1.1 : sc.level === 'middle' ? 1.0 : 0.7);
      let nStu = Math.max(8, Math.round(perSchoolBase * sizeFactor + gauss() * 2));
      sc.students = [];
      for (let k = 0; k < nStu && students.length < TARGET_STUDENTS; k++) {
        sIdx++;
        const grade = pick(sc.grades);
        const classNo = randInt(1, 3);
        // 잠재 성실도 θ(활동 동인): 지역/급 bias 반영
        const theta = clamp01(0.5 + gauss() * 0.22 + sc.bias + sc.levelBias);
        // 성취 잠재변수: θ와 부분상관(블렌드 0.55) + 독립노이즈(0.45) → 활동↔성취 r≈0.5~0.7
        const thetaAch = clamp01(0.50 * theta + 0.50 * clamp01(0.5 + gauss() * 0.25) + sc.bias * 0.5);
        const username = 'seed_s' + String(sIdx).padStart(3, '0');
        const createdAt = isoDaysAgo(randInt(91, 200)); // 가입은 90일 이전부터
        const info = insUser.run(username, SEED_PASSWORD_HASH, koreanName(), 'student',
          sc.name, sc.region, grade, classNo, sc.level, createdAt);
        const stu = { id: info.lastInsertRowid, theta, thetaAch, grade, school: sc, level: sc.level, region: sc.region };
        students.push(stu);
        sc.students.push(stu);
      }
      if (students.length >= TARGET_STUDENTS) break;
    }
    // 정확히 600에 못 미치면(반올림 변동) 마지막 학교에 보충
    while (students.length < TARGET_STUDENTS) {
      const sc = schools[students.length % schools.length];
      sIdx++;
      const grade = pick(sc.grades);
      const theta = clamp01(0.5 + gauss() * 0.22 + sc.bias + sc.levelBias);
      const thetaAch = clamp01(0.50 * theta + 0.50 * clamp01(0.5 + gauss() * 0.25) + sc.bias * 0.5);
      const username = 'seed_s' + String(sIdx).padStart(3, '0');
      const info = insUser.run(username, SEED_PASSWORD_HASH, koreanName(), 'student',
        sc.name, sc.region, grade, randInt(1, 3), sc.level, isoDaysAgo(randInt(91, 200)));
      const stu = { id: info.lastInsertRowid, theta, thetaAch, grade, school: sc, level: sc.level, region: sc.region };
      students.push(stu);
      sc.students.push(stu);
    }
    // 교사 60: 학교에 분배
    for (let i = 0; i < TARGET_TEACHERS; i++) {
      tIdx++;
      const sc = schools[i % schools.length];
      const username = 'seed_t' + String(tIdx).padStart(3, '0');
      const createdAt = isoDaysAgo(randInt(120, 240));
      const info = insUser.run(username, SEED_PASSWORD_HASH, koreanName() + ' 선생님', 'teacher',
        sc.name, sc.region, pick(sc.grades), randInt(1, 3), sc.level, createdAt);
      teachers.push({ id: info.lastInsertRowid, school: sc });
    }
  });
  insertAll();
  console.log(`[seed-lrs-macro] 사용자 생성: 학생 ${students.length} / 교사 ${teachers.length} (${Date.now() - t0}ms)`);

  // ── 3. learning_logs 생성 (θ 상관) ──
  insertLogs(students);

  const t1 = Date.now();
  console.log(`[seed-lrs-macro] --apply 완료 (총 ${((t1 - t0) / 1000).toFixed(1)}s)`);

  if (!NO_REBUILD) doRebuild();
  printStats();
}

function clamp01(x) { return Math.max(0.02, Math.min(0.98, x)); }
function isoDaysAgo(d) {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(randInt(8, 20), randInt(0, 59), randInt(0, 59), 0);
  return t.toISOString().replace('T', ' ').substring(0, 19);
}

function buildSchools() {
  // 급별 목표: 초18·중8·고4 = 30. region 비중에 맞춰 분배.
  const levelQuota = { elementary: 18, middle: 8, high: 4 };
  const levelBias = { elementary: +0.00, middle: -0.01, high: -0.02 };
  const schools = [];
  const usedNames = new Set();
  // region별 학교 수만큼 채우되, 전체 급별 쿼터를 소진
  const levelPool = [];
  for (const [lv, q] of Object.entries(levelQuota)) for (let i = 0; i < q; i++) levelPool.push(lv);
  // levelPool 셔플(결정론적)
  for (let i = levelPool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [levelPool[i], levelPool[j]] = [levelPool[j], levelPool[i]]; }
  let lp = 0;
  for (const region of REGIONS) {
    for (let s = 0; s < region.schools; s++) {
      const lv = levelPool[lp++] || 'elementary';
      const levelDef = LEVELS.find(L => L.key === lv);
      let name;
      let guard = 0;
      do {
        name = region.name + pick(SCHOOL_STEMS) + levelDef.suffix;
        guard++;
      } while (usedNames.has(name) && guard < 40);
      // 그래도 충돌이면 일련번호 부여
      if (usedNames.has(name)) name = region.name + pick(SCHOOL_STEMS) + (schools.length) + levelDef.suffix;
      usedNames.add(name);
      schools.push({
        name, region: region.name, level: lv, grades: levelDef.grades,
        bias: region.bias, levelBias: levelBias[lv],
      });
    }
  }
  return schools;
}

function insertLogs(students) {
  const tLog0 = Date.now();
  const insLog = db.prepare(`
    INSERT INTO learning_logs (
      user_id, class_id, activity_type, verb, object_type, object_id,
      target_type, target_id, result_score, result_success, result_duration,
      source_service, achievement_code, duration_sec, device_type, platform,
      retry_count, correct_count, total_items, achievement_level,
      subject_code, grade_group, metadata, created_at, is_seed
    ) VALUES (
      @user_id, NULL, @activity_type, @verb, 'Activity', @object_id,
      @target_type, @target_id, @result_score, @result_success, @result_duration,
      @source_service, @achievement_code, @duration_sec, @device_type, @platform,
      @retry_count, @correct_count, @total_items, @achievement_level,
      @subject_code, @grade_group, @metadata, @created_at, 1
    )
  `);

  // 성취기준 풀 캐시 (subject_code+grade_group)
  const stdCache = new Map();
  function standardsFor(subjectCode, gradeGroup) {
    const key = subjectCode + '|' + gradeGroup;
    if (stdCache.has(key)) return stdCache.get(key);
    let rows = [];
    try {
      rows = db.prepare("SELECT code FROM curriculum_standards WHERE subject_code=? AND grade_group=? AND school_level='초' LIMIT 60").all(subjectCode, gradeGroup).map(r => r.code);
    } catch (_) {}
    stdCache.set(key, rows);
    return rows;
  }
  const gradeToGroup = (g) => (!g ? 4 : g <= 2 ? 2 : g <= 4 ? 4 : 6);

  const DAYS = 90;
  // 시간대 가중: 평일 09~16 집중 + 19~21 저녁 피크
  const WEEKDAY_HOURS = [[9, 8], [10, 12], [11, 12], [12, 8], [13, 11], [14, 12], [15, 10], [16, 7], [17, 4], [19, 9], [20, 8], [21, 5]];
  const WEEKEND_HOURS = [[10, 6], [11, 7], [14, 6], [15, 6], [16, 5], [20, 5]];

  let total = 0;
  const BATCH = 2000;
  let batch = [];
  const flush = db.transaction((rows) => { for (const r of rows) insLog.run(r); });

  for (const stu of students) {
    const theta = stu.theta;
    const gg = gradeToGroup(stu.grade);
    // 학생별 일평균 활동량 ∝ θ : base 0.6~3.5건/일
    const dailyMean = 0.5 + theta * 3.0;
    for (let d = DAYS - 1; d >= 0; d--) {
      const date = new Date();
      date.setDate(date.getDate() - d);
      const dow = date.getDay(); // 0=일,6=토
      const isWeekend = (dow === 0 || dow === 6);
      // 활동 발생 확률/건수: 주말은 저조
      let lambda = dailyMean * (isWeekend ? 0.28 : 1.0);
      // 결석/저활동일: θ 낮으면 더 자주 0건
      if (rnd() > (0.35 + theta * 0.6)) lambda *= 0.4;
      const count = Math.max(0, Math.round(lambda + gauss() * 0.7));
      if (count === 0) continue;

      const sessionId = 'seedsess-' + stu.id + '-' + d + '-' + Math.floor(rnd() * 1000);
      const device = pickWeighted(DEVICE_DIST);
      for (let i = 0; i < count; i++) {
        const act = pickWeighted(ACTIVITY_DIST.map(a => [a, a[1]]));
        const [activity_type, , verb, target_type, source_service, hasScore] = act;
        const hour = pickWeighted(isWeekend ? WEEKEND_HOURS : WEEKDAY_HOURS);
        const ts = new Date(date);
        ts.setHours(hour, randInt(0, 59), randInt(0, 59), 0);
        const created_at = ts.toISOString().replace('T', ' ').substring(0, 19);

        // 점수 ∝ thetaAch(성취 잠재변수) : 40 + 48·thetaAch + 노이즈(±10) — 학교/지역 bias 소폭
        // (활동 동인 θ와 부분상관이므로 활동량↔성취 r≈0.5~0.7 로 나타남)
        let result_score = null, result_success = null, correct_count = null, total_items = null, achievement_level = null, retry_count = 0;
        if (hasScore) {
          let sc = 40 + 50 * stu.thetaAch + gauss() * 9 + (stu.school.bias * 35);
          sc = Math.max(0, Math.min(100, Math.round(sc)));
          result_score = sc;
          result_success = sc >= 60 ? 1 : 0;
          if (activity_type === 'exam_complete' || activity_type === 'self_learn' || activity_type === 'problem_attempt') {
            total_items = pick([5, 10, 15, 20]);
            correct_count = Math.round(total_items * sc / 100);
            retry_count = sc < 60 ? randInt(0, 2) : 0;
          }
          achievement_level = sc >= 90 ? 'A' : sc >= 75 ? 'B' : sc >= 60 ? 'C' : sc >= 40 ? 'D' : 'E';
        }

        // 교과/성취기준 (시드 충진율 ~85%)
        let subject_code = null, achievement_code = null;
        if (rnd() < 0.85) {
          subject_code = pickWeighted(SUBJECT_DIST);
          const stds = standardsFor(subject_code, gg);
          if (stds.length) achievement_code = pick(stds);
        }

        let durationSec;
        switch (activity_type) {
          case 'lesson_view': durationSec = randInt(300, 2400); break;
          case 'content_view': durationSec = randInt(120, 900); break;
          case 'content_complete': durationSec = randInt(300, 1500); break;
          case 'self_learn': durationSec = randInt(300, 1800); break;
          case 'exam_complete': durationSec = randInt(600, 2700); break;
          case 'homework_submit': durationSec = randInt(600, 3600); break;
          case 'problem_attempt': durationSec = randInt(60, 600); break;
          case 'wrong_note_retry': durationSec = randInt(60, 500); break;
          default: durationSec = randInt(30, 300); break;
        }

        const targetId = String(randInt(1, 800));
        batch.push({
          user_id: stu.id,
          activity_type, verb,
          object_id: `urn:dacheum:${target_type}:${targetId}`,
          target_type, target_id: targetId,
          result_score, result_success,
          result_duration: `PT${durationSec}S`,
          source_service, achievement_code,
          duration_sec: durationSec, device_type: device, platform: PLATFORM_BY_DEVICE[device] || device,
          retry_count, correct_count, total_items, achievement_level,
          subject_code, grade_group: gg,
          metadata: JSON.stringify({ seed: 'lrs-macro' }),
          created_at,
        });
        total++;
        if (batch.length >= BATCH) { flush(batch); batch = []; }
      }
    }
  }
  if (batch.length) flush(batch);
  console.log(`[seed-lrs-macro] learning_logs 시드 ${total}건 삽입 (${((Date.now() - tLog0) / 1000).toFixed(1)}s)`);
}

// ─────────────────────────── 집계 재빌드 ───────────────────────────
function doRebuild() {
  const t0 = Date.now();
  try {
    if (rebuildAllAggregates) {
      rebuildAllAggregates();
    } else {
      throw new Error('rebuildAllAggregates 모듈 없음');
    }
  } catch (e) {
    console.warn('[seed-lrs-macro] rebuildAllAggregates 실패 → 폴백 재집계:', e.message);
    fallbackRebuild();
  }
  console.log(`[seed-lrs-macro] LRS 집계 재빌드 완료 (${Date.now() - t0}ms)`);
}

function fallbackRebuild() {
  const exists = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const tx = db.transaction(() => {
    if (exists('lrs_daily_stats')) {
      db.exec('DELETE FROM lrs_daily_stats');
      db.exec(`INSERT INTO lrs_daily_stats (stat_date, activity_type, source_service, class_id, activity_count, unique_users, avg_score, total_duration)
        SELECT DATE(created_at), activity_type, COALESCE(source_service,''), COALESCE(class_id,0), COUNT(*), COUNT(DISTINCT user_id), AVG(result_score), COALESCE(SUM(duration_sec),0)
        FROM learning_logs GROUP BY DATE(created_at), activity_type, COALESCE(source_service,''), COALESCE(class_id,0)`);
    }
    if (exists('lrs_service_stats')) {
      db.exec('DELETE FROM lrs_service_stats');
      db.exec(`INSERT INTO lrs_service_stats (source_service, verb, total_count, unique_users, avg_score)
        SELECT COALESCE(source_service,'unknown'), verb, COUNT(*), COUNT(DISTINCT user_id), AVG(result_score)
        FROM learning_logs GROUP BY COALESCE(source_service,'unknown'), verb`);
    }
    if (exists('lrs_user_summary')) {
      db.exec('DELETE FROM lrs_user_summary');
      db.exec(`INSERT INTO lrs_user_summary (user_id, activity_type, total_count, total_duration, avg_score, last_activity_at)
        SELECT user_id, activity_type, COUNT(*), COALESCE(SUM(duration_sec),0), AVG(result_score), MAX(created_at)
        FROM learning_logs GROUP BY user_id, activity_type`);
    }
  });
  tx();
}

// ─────────────────────────── main ───────────────────────────
if (MODE === 'stats') printStats();
else if (MODE === 'clean') clean();
else if (MODE === 'apply') apply();
process.exit(0);
