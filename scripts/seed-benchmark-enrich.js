#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * seed-benchmark-enrich.js — LRS 도 전체 벤치마크(성취기준 단위) 집중 재시드 (Phase 0)
 *
 * 기획서: 보고서/LRS_확장_통합기획서_v1.md §4(시드 보강 계획), 특히 §4-4.
 * 승인: 사용자(충북 평가자) — §7-1 Q3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 목적
 *   성취기준 셀(학년×교과×성취기준) 표본이 중앙값 n=2 로 붕괴 → 벤치마크 통계 불가.
 *   초등 핵심 성취기준을 큐레이션(교과×학년군마다 10개)하고, 각 학년 학생이 그 코드에
 *   ≥3회 시도하도록 "집중" 재시드하여 셀당 n≥30~50 확보. 도달률을 고/중/취약으로
 *   의도적으로 스프레드하여 우수·취약 Top10 이 모두 통계적으로 유의하게 채워지도록 한다.
 *
 * 왜 learning_logs 만 넣으면 되는가 (핵심 설계)
 *   lrs_achievement_stats 는 rebuildAllAggregates() 가 learning_logs 로부터
 *   DELETE 후 GROUP BY 재INSERT 한다(db/lrs-aggregate.js:21,102-116):
 *     attempt_count=COUNT(*), success_count=SUM(result_success=1), avg_score=AVG(result_score)
 *   → learning_logs 만 단일 진실원으로 채우고 rebuild 하면 stats 는 자동 정합·자동 멱등.
 *   도달 분류(classifyStatus/reachRate, db/lrs-mastery.js): rate=success/attempt*100,
 *     att<3=평가부족, rate>=80=도달, >=50=부분, <50=미도달.
 *
 * 사용법
 *   node scripts/seed-benchmark-enrich.js --plan     # 무쓰기 미리보기(현재상태+계획 규모)
 *   node scripts/seed-benchmark-enrich.js --apply     # 백업 후 재시드 + 집계 재빌드
 *   node scripts/seed-benchmark-enrich.js --clean      # 벤치 시드 전부 제거 + 재빌드(실데이터·기존시드 불변)
 *   node scripts/seed-benchmark-enrich.js --stats       # 재시드 후 셀 분포/Top10 통계만 출력
 *   옵션: --no-rebuild(집계 재빌드 생략, 디버그) / --no-backup(백업 생략, 위험)
 *
 * 멱등성
 *   - 벤치 로그 태그: learning_logs.context_registration = 'bench_enrich_v1'
 *   - 벤치 신규 학생: users.username LIKE 'be_s%' (is_seed=1)
 *   재실행 시 위 두 태그를 먼저 purge 후 재생성 → 중복 폭증 없음. GCP 에서도 동일 실행 가능.
 *
 * 정직성
 *   - 모든 신규 행 is_seed=1(학생·로그). 벤치 로그 metadata_json.src='bench_enrich'.
 *   - 기존 실사용자(is_seed=0: teacher1·student1 등) 데이터는 절대 건드리지 않는다.
 *     (재시드 대상 = is_seed=1 초등 학생 + 신규 be_s 학생만)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require(path.join(__dirname, '..', 'db', 'index'));
let rebuildAllAggregates = null;
try { ({ rebuildAllAggregates } = require(path.join(__dirname, '..', 'db', 'lrs-aggregate'))); } catch (_) {}

// ─────────────────────────── CLI ───────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--clean') ? 'clean' : has('--stats') ? 'stats' : has('--plan') ? 'plan' : has('--apply') ? 'apply' : null;
const NO_REBUILD = has('--no-rebuild');
const NO_BACKUP = has('--no-backup');
if (!MODE) {
  console.log('Usage: node scripts/seed-benchmark-enrich.js [--apply | --clean | --stats | --plan] [--no-rebuild] [--no-backup]');
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
// 결정론적 문자열 해시 → PRNG 시드 (학생×코드×학년 단위 재현)
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const SEED = 20260710;
const rng = mulberry32(SEED);
const randInt = (lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ─────────────────────────── 상수 ───────────────────────────
const BENCH_TAG = 'bench_enrich_v1';          // 로그 멱등 태그(context_registration)
const BENCH_USER_PREFIX = 'be_s';              // 신규 학생 username 접두
const SUBJECTS = ['korean-e', 'math-e', 'english-e', 'science-e', 'social-e'];
// 학년 → 학년군(교육과정 성취기준 코드 접두: 1-2군=[2..], 3-4군=[4..], 5-6군=[6..])
const GRADE_GROUP = { 1: 2, 2: 2, 3: 4, 4: 4, 5: 6, 6: 6 };
const CODES_PER_CELL = 10;
// 학년별 신규 학생 보강량(§4-4): 초5 +23, 초4 +10, 초6 +10. 그 외 유지.
const STUDENT_BOOST = { 4: 10, 5: 23, 6: 10 };

// 학습활동 유형(정본 7종 중 채점형 화이트리스트 = routes/lrs.js scoredWhere 와 정합).
//   [activity_type, verb, source_service, durLo, durHi, weight]
const ACT_TYPES = [
  ['content_solve',     'completed', 'content',    300, 1500, 30], // 콘텐츠 문항 풀이
  ['self_learn',        'completed', 'self-learn', 300, 1800, 22], // 오늘의 학습
  ['exam_complete',     'answered',  'cbt',        600, 2700, 16], // 평가
  ['homework_submit',   'submitted', 'class',      600, 3600, 12], // 과제
  ['wrong_note_retry',  'attempted', 'self-learn',  60,  500, 12], // 오답노트
  ['node_complete',     'completed', 'self-learn', 300, 1200,  8], // AI 학습맵 노드
];
function pickAct() {
  const sum = ACT_TYPES.reduce((s, a) => s + a[5], 0);
  let r = rng() * sum;
  for (const a of ACT_TYPES) { if ((r -= a[5]) <= 0) return a; }
  return ACT_TYPES[0];
}

// 한국어 이름
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구'.split('');
const GIVEN1 = '민서지예준현우도하시은주가나윤소영재호태수연승규세진'.split('');
const GIVEN2 = '준호윤서연우진아영수빈서현지율찬혁성민호은희정아람들'.split('');
const koreanName = () => pick(SURNAMES) + pick(GIVEN1) + pick(GIVEN2);

// 도달률 밴드 → 목표 도달률 범위 + 비도달자 중 부분도달 비율
const BANDS = {
  high: { reachLo: 0.80, reachHi: 0.95, partialOfRest: 0.60 }, // 우수 셀
  mid:  { reachLo: 0.50, reachHi: 0.79, partialOfRest: 0.50 }, // 중간 셀
  weak: { reachLo: 0.15, reachHi: 0.49, partialOfRest: 0.35 }, // 취약 셀
};

// ─────────────────────────── 컬럼 가드 ───────────────────────────
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
const llCols = new Set(db.prepare('PRAGMA table_info(learning_logs)').all().map(c => c.name));
for (const [t, cols, need] of [['users', userCols, ['region', 'is_seed', 'school_level']], ['learning_logs', llCols, ['is_seed', 'achievement_code', 'subject_code', 'grade_group', 'duration_sec', 'context_registration']]]) {
  for (const c of need) if (!cols.has(c)) { console.error(`[bench] ✗ ${t}.${c} 컬럼 없음 — 서버 1회 기동(initSchema) 후 재실행.`); process.exit(1); }
}

// ─────────────────────────── 코어 코드 선정 ───────────────────────────
// curriculum_standards(canonical) 에서 (교과, 학년군, 초) 코드를 sort_order 로 정렬해 균등 간격 10개.
//   → 특정 단원 쏠림 없이 영역 다양성 확보. "실제 존재하는 코드"만(가공 없음).
function loadCoreCodes() {
  const cells = []; // { subject, gg, codes:[{code,label}], groupIdx }
  const ggList = [2, 4, 6];
  let groupIdx = 0;
  for (const gg of ggList) {
    for (const subject of SUBJECTS) {
      const rows = db.prepare(`
        SELECT code, content FROM curriculum_standards
        WHERE subject_code=? AND grade_group=? AND school_level='초'
        ORDER BY sort_order, code
      `).all(subject, gg);
      if (rows.length === 0) continue; // gg2 영어/과학/사회 = 성취기준 자체 없음(정직 스킵)
      // 균등 간격 10개(코드 수 <10 이면 전부)
      const n = Math.min(CODES_PER_CELL, rows.length);
      const picked = [];
      if (rows.length <= n) picked.push(...rows);
      else {
        const stride = rows.length / n;
        for (let i = 0; i < n; i++) picked.push(rows[Math.floor(i * stride)]);
      }
      cells.push({ subject, gg, groupIdx, codes: picked.map(r => ({ code: r.code, label: r.content })) });
      groupIdx++;
    }
  }
  return cells;
}

// 밴드 배정: 그룹(교과×학년군)마다 교대로 (2高·4中·4弱)/(3高·4中·3弱) → 전체 정확히 25/40/35.
//   같은 코드는 두 학년(예 5·6)에서 동일 밴드 → 학년필터·전체집계 양쪽에서 깨끗한 스프레드.
function assignBands(cells) {
  const bandByCode = new Map();
  cells.forEach((cell, gi) => {
    const codes = cell.codes.map(c => c.code);
    const nHigh = (gi % 2 === 0) ? 2 : 3;
    const nWeak = (gi % 2 === 0) ? 4 : 3;
    const nMid = codes.length - nHigh - nWeak;
    // 그룹 내 위치 셔플(결정론)
    const idx = codes.map((_, i) => i);
    const gr = mulberry32(hashStr(cell.subject + '|' + cell.gg) ^ SEED);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(gr() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const labels = [];
    for (let i = 0; i < nHigh; i++) labels.push('high');
    for (let i = 0; i < nMid; i++) labels.push('mid');
    for (let i = 0; i < nWeak; i++) labels.push('weak');
    idx.forEach((pos, k) => {
      const band = labels[k];
      // 코드별 목표 도달률(밴드 범위 내, 결정론 지터)
      const gr2 = mulberry32(hashStr('rate|' + codes[pos]) ^ SEED);
      const b = BANDS[band];
      const targetReach = b.reachLo + gr2() * (b.reachHi - b.reachLo);
      bandByCode.set(codes[pos], { band, targetReach, subject: cell.subject, gg: cell.gg });
    });
  });
  return bandByCode;
}

// ─────────────────────────── 시도 계획기 ───────────────────────────
// 기존 유기 로그(existingA/S)를 반영해, 최종(att,succ)이 outcome 밴드에 들도록 bench(성공/실패) 산출.
//   outcome: 'reached'(rate>=80) | 'partial'(50~79) | 'notReached'(<50). 최종 att>=3, bench>=3 보장.
function planAttempts(existingA, existingS, outcome, r) {
  let benchTotal = 3 + (r() < 0.45 ? 1 : 0) + (r() < 0.18 ? 1 : 0); // 3~5(대부분 3~4)
  for (let tries = 0; tries < 10; tries++) {
    const finalA = existingA + benchTotal;
    let lo, hi; // 최종 성공수 허용범위
    if (outcome === 'reached') { lo = Math.ceil(0.80 * finalA); hi = finalA; }
    else if (outcome === 'partial') { lo = Math.ceil(0.50 * finalA); hi = Math.floor(0.799 * finalA); }
    else { lo = 0; hi = Math.floor(0.499 * finalA); }
    if (hi < lo) { benchTotal++; continue; }
    // 최종 성공수는 기존 성공수 이상이어야(로그 삭제 불가)
    const flo = Math.max(lo, existingS);
    if (flo > hi) { benchTotal++; continue; } // 기존 성공이 밴드 상한 초과 → 실패 추가로 희석
    const finalS = flo + Math.floor(r() * (hi - flo + 1));
    const benchS = finalS - existingS;
    if (benchS < 0 || benchS > benchTotal) { benchTotal++; continue; }
    return { benchS, benchF: benchTotal - benchS };
  }
  // 폴백(수렴 실패 — 사실상 없음): outcome 기본형
  if (outcome === 'reached') return { benchS: 4, benchF: 0 };
  if (outcome === 'partial') return { benchS: 2, benchF: 1 };
  return { benchS: 0, benchF: 3 };
}

// 시각 분포용 시간(최근 D일, 평일 가중, 9~21시)
function randCreatedAt() {
  const D = 80;
  let dback;
  do { dback = Math.floor(Math.abs(gauss()) * 26); } while (dback > D); // 최근일 가중
  const t = new Date();
  t.setDate(t.getDate() - dback);
  const dow = t.getDay();
  if ((dow === 0 || dow === 6) && rng() < 0.6) t.setDate(t.getDate() - 2); // 주말 저조 → 평일로 당김
  t.setHours(randInt(9, 21), randInt(0, 59), randInt(0, 59), 0);
  return t.toISOString().replace('T', ' ').substring(0, 19);
}

// ─────────────────────────── purge(멱등) ───────────────────────────
function purgeBench() {
  const tableExists = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const beIds = db.prepare(`SELECT id FROM users WHERE username LIKE '${BENCH_USER_PREFIX}%'`).all().map(r => r.id);
  const tx = db.transaction(() => {
    // 1) 벤치 로그(기존 seed_s + be_s 학생 모두 포함) 삭제
    db.prepare('DELETE FROM learning_logs WHERE context_registration = ?').run(BENCH_TAG);
    // 2) be_s 학생의 파생행 + 학생 삭제
    if (beIds.length) {
      const ph = beIds.map(() => '?').join(',');
      for (const [tbl, col] of [
        ['lrs_user_summary', 'user_id'], ['lrs_user_daily', 'user_id'],
        ['lrs_achievement_stats', 'user_id'], ['lrs_session_stats', 'user_id'],
        ['class_members', 'user_id'], ['notifications', 'user_id'], ['user_points', 'user_id'],
      ]) {
        if (!tableExists(tbl)) continue;
        try { db.prepare(`DELETE FROM ${tbl} WHERE ${col} IN (${ph})`).run(...beIds); } catch (_) {}
      }
      db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...beIds);
    }
  });
  tx();
  return { logs: 'purged', beStudents: beIds.length };
}

// ─────────────────────────── 백업 ───────────────────────────
function backupDb() {
  if (NO_BACKUP) { console.log('[bench] ⚠ --no-backup: 백업 생략'); return null; }
  const dbPath = db.name || path.join(__dirname, '..', 'data', 'dacheum.db');
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14); // YYYYMMDDHHmmss
  const dest = dbPath + `.bak-${ts}`;
  fs.copyFileSync(dbPath, dest);
  console.log(`[bench] 백업 생성: ${path.basename(dest)} (${(fs.statSync(dest).size / 1048576).toFixed(1)}MB)`);
  return dest;
}

// ─────────────────────────── 신규 학생 생성 ───────────────────────────
function createBoostStudents() {
  // 기존 초등 시드 학교(school_name, region) 재사용 → 지역 분포 정합, 학교 신설 없음
  const schoolPool = db.prepare(`
    SELECT DISTINCT school_name, region FROM users
    WHERE is_seed=1 AND school_level='elementary' AND school_name IS NOT NULL AND region IS NOT NULL
  `).all();
  const hash = bcrypt.hashSync('1234', 10);
  const ins = db.prepare(`
    INSERT INTO users (username, password, display_name, role, school_name, region, grade, class_number, school_level, status, is_seed, created_at)
    VALUES (?, ?, ?, 'student', ?, ?, ?, ?, 'elementary', 'active', 1, ?)
  `);
  // 기존 be_s 최대 인덱스 뒤부터(멱등: purge 후엔 항상 0부터)
  let idx = 0;
  const created = {};
  const tx = db.transaction(() => {
    for (const [gradeStr, n] of Object.entries(STUDENT_BOOST)) {
      const grade = Number(gradeStr);
      created[grade] = 0;
      for (let k = 0; k < n; k++) {
        idx++;
        const sc = schoolPool.length ? pick(schoolPool) : { school_name: '청주다채움초등학교', region: '청주' };
        const createdAt = (() => { const t = new Date(); t.setDate(t.getDate() - randInt(90, 200)); return t.toISOString().replace('T', ' ').substring(0, 19); })();
        ins.run(BENCH_USER_PREFIX + String(idx).padStart(3, '0'), hash, koreanName(), sc.school_name, sc.region, grade, randInt(1, 3), createdAt);
        created[grade]++;
      }
    }
  });
  tx();
  return created;
}

// ─────────────────────────── 대상 학생 조회 ───────────────────────────
function seedElementaryByGrade() {
  // is_seed=1 초등 학생만(실사용자 is_seed=0 제외). 학년별.
  const rows = db.prepare(`
    SELECT id, grade FROM users
    WHERE is_seed=1 AND role='student' AND school_level='elementary' AND grade BETWEEN 1 AND 6
  `).all();
  const byGrade = new Map();
  for (const r of rows) {
    if (!byGrade.has(r.grade)) byGrade.set(r.grade, []);
    byGrade.get(r.grade).push(r.id);
  }
  return byGrade;
}

// ─────────────────────────── 로그 삽입 ───────────────────────────
const insLog = db.prepare(`
  INSERT INTO learning_logs (
    user_id, class_id, activity_type, verb, object_type, object_id,
    target_type, target_id, result_score, result_success, result_duration,
    context_registration, source_service, achievement_code, duration_sec,
    device_type, platform, correct_count, total_items, achievement_level,
    subject_code, grade_group, metadata_json, created_at, is_seed
  ) VALUES (
    @user_id, NULL, @activity_type, @verb, 'Activity', @object_id,
    @target_type, @target_id, @result_score, @result_success, @result_duration,
    @context_registration, @source_service, @achievement_code, @duration_sec,
    'web', 'web-chrome', @correct_count, @total_items, @achievement_level,
    @subject_code, @grade_group, @metadata_json, @created_at, 1
  )
`);

function buildAttemptLog(userId, code, subject, gg, success) {
  const act = pickAct();
  const [activity_type, verb, source_service, durLo, durHi] = act;
  let score;
  if (success) score = Math.max(60, Math.min(100, Math.round(85 + gauss() * 7)));
  else score = Math.max(5, Math.min(59, Math.round(40 + gauss() * 9)));
  const dur = randInt(durLo, durHi);
  const level = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
  return {
    user_id: userId, activity_type, verb,
    object_id: `urn:dacheum:std:${code}`,
    target_type: 'achievement', target_id: code,
    result_score: score, result_success: success ? 1 : 0,
    result_duration: `PT${dur}S`,
    context_registration: BENCH_TAG,
    source_service, achievement_code: code, duration_sec: dur,
    correct_count: success ? 1 : 0, total_items: 1, achievement_level: level,
    subject_code: subject, grade_group: gg,
    metadata_json: JSON.stringify({ src: 'bench_enrich', v: 1, band: undefined }),
    created_at: randCreatedAt(),
  };
}

// ─────────────────────────── apply ───────────────────────────
function apply() {
  const t0 = Date.now();
  console.log('[bench] ===== 벤치마크 집중 재시드 시작 =====');
  backupDb();

  // 멱등: 기존 벤치 시드 purge
  const purged = purgeBench();
  console.log(`[bench] purge: 벤치로그 삭제, be_s 학생 ${purged.beStudents}명 제거`);

  // 1) 코어 코드 + 밴드
  const cells = loadCoreCodes();
  const bandByCode = assignBands(cells);
  const allCodes = Array.from(bandByCode.keys());
  const bandCount = { high: 0, mid: 0, weak: 0 };
  for (const c of allCodes) bandCount[bandByCode.get(c).band]++;
  console.log(`[bench] 코어 코드 ${allCodes.length}개 (셀그룹 ${cells.length}) — 高 ${bandCount.high} / 中 ${bandCount.mid} / 弱 ${bandCount.weak}`);

  // 2) 학년별 코어코드(gg별) 인덱스
  const codesByGG = { 2: {}, 4: {}, 6: {} };
  for (const cell of cells) {
    if (!codesByGG[cell.gg][cell.subject]) codesByGG[cell.gg][cell.subject] = [];
    codesByGG[cell.gg][cell.subject].push(...cell.codes.map(c => c.code));
  }

  // 3) 신규 보강 학생
  const created = createBoostStudents();
  console.log(`[bench] 신규 학생: ${Object.entries(created).map(([g, n]) => `초${g}+${n}`).join(' · ')}`);

  // 4) 대상 학생(기존 시드 + 신규)
  const byGrade = seedElementaryByGrade();

  // 5) 기존 유기 로그 (user,code) 시도/성공 조회 — 밴드 정밀 제어용(벤치 태그 제외)
  //    대상: 초등 시드 학생 × 코어코드. 재현성 위해 벤치로그 이미 purge 됨.
  const existing = new Map(); // `${uid}|${code}` -> {a,s}
  {
    const ph = allCodes.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT ll.user_id AS uid, ll.achievement_code AS code,
             COUNT(*) AS a, SUM(CASE WHEN ll.result_success=1 THEN 1 ELSE 0 END) AS s
      FROM learning_logs ll
      JOIN users u ON u.id = ll.user_id
      WHERE u.is_seed=1 AND u.school_level='elementary'
        AND ll.achievement_code IN (${ph})
      GROUP BY ll.user_id, ll.achievement_code
    `).all(...allCodes);
    for (const r of rows) existing.set(`${r.uid}|${r.code}`, { a: r.a || 0, s: r.s || 0 });
  }

  // 6) 셀별 학생 outcome 배정 + 로그 생성
  let batch = [];
  const BATCH = 3000;
  const flush = db.transaction((rows) => { for (const r of rows) insLog.run(r); });
  let totalLogs = 0;
  const cellStats = []; // {grade,subject,code,band,n,reached,partial,notReached,targetReach}

  for (const [grade, ids] of byGrade.entries()) {
    const gg = GRADE_GROUP[grade];
    const subjMap = codesByGG[gg];
    for (const subject of SUBJECTS) {
      const codes = subjMap[subject];
      if (!codes) continue; // gg2 영·과·사 없음
      for (const code of codes) {
        const meta = bandByCode.get(code);
        const n = ids.length;
        const reachedTarget = Math.round(meta.targetReach * n);
        const rest = n - reachedTarget;
        const partialTarget = Math.round(BANDS[meta.band].partialOfRest * rest);
        // 학생 순위(결정론) → outcome 배정
        const ranked = ids.map(uid => ({ uid, key: mulberry32(hashStr(`${code}|${grade}|${uid}`))() }))
          .sort((x, y) => x.key - y.key);
        let reached = 0, partial = 0, notReached = 0;
        for (let i = 0; i < ranked.length; i++) {
          const uid = ranked[i].uid;
          let outcome;
          if (i < reachedTarget) outcome = 'reached';
          else if (i < reachedTarget + partialTarget) outcome = 'partial';
          else outcome = 'notReached';
          const ex = existing.get(`${uid}|${code}`) || { a: 0, s: 0 };
          const r = mulberry32(hashStr(`plan|${code}|${grade}|${uid}`) ^ SEED);
          const { benchS, benchF } = planAttempts(ex.a, ex.s, outcome, r);
          for (let k = 0; k < benchS; k++) { batch.push(buildAttemptLog(uid, code, subject, gg, true)); totalLogs++; }
          for (let k = 0; k < benchF; k++) { batch.push(buildAttemptLog(uid, code, subject, gg, false)); totalLogs++; }
          if (outcome === 'reached') reached++; else if (outcome === 'partial') partial++; else notReached++;
          if (batch.length >= BATCH) { flush(batch); batch = []; }
        }
        cellStats.push({ grade, subject, code, band: meta.band, n, reached, partial, notReached, targetReach: Math.round(meta.targetReach * 100) });
      }
    }
  }
  if (batch.length) flush(batch);
  console.log(`[bench] learning_logs 삽입: ${totalLogs}건 (셀 ${cellStats.length}개), ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 7) 집계 재빌드 → lrs_achievement_stats 자동 재파생(단일 진실원=logs)
  if (!NO_REBUILD) doRebuild();

  console.log(`[bench] --apply 완료 (총 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  printStats();
}

// ─────────────────────────── clean ───────────────────────────
function clean() {
  backupDb();
  const before = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(BENCH_TAG).c;
  const beBefore = db.prepare(`SELECT COUNT(*) c FROM users WHERE username LIKE '${BENCH_USER_PREFIX}%'`).get().c;
  purgeBench();
  const after = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(BENCH_TAG).c;
  console.log(`[bench] --clean: 벤치로그 ${before}→${after}, be_s 학생 ${beBefore}→0`);
  const real = db.prepare("SELECT COUNT(*) c FROM users WHERE COALESCE(is_seed,0)=0").get().c;
  console.log(`[bench] 실데이터 사용자 보존: ${real}`);
  if (!NO_REBUILD) doRebuild();
}

// ─────────────────────────── plan(dry) ───────────────────────────
function plan() {
  const cells = loadCoreCodes();
  const bandByCode = assignBands(cells);
  const bandCount = { high: 0, mid: 0, weak: 0 };
  for (const [, v] of bandByCode) bandCount[v.band]++;
  const byGrade = seedElementaryByGrade();
  console.log('\n[bench] ===== PLAN (무쓰기) =====');
  console.log(`코어 코드: ${bandByCode.size}개  (高 ${bandCount.high} / 中 ${bandCount.mid} / 弱 ${bandCount.weak})`);
  console.log('셀 그룹(교과×학년군):');
  console.table(cells.map(c => ({ subject: c.subject, gg: c.gg, codes: c.codes.length })));
  console.log('학년별 기존 시드 초등 학생수(신규 보강 전):');
  const gt = [];
  let cells240 = 0;
  for (const grade of [1, 2, 3, 4, 5, 6]) {
    const n = (byGrade.get(grade) || []).length + (STUDENT_BOOST[grade] || 0);
    const gg = GRADE_GROUP[grade];
    const subjCount = SUBJECTS.filter(s => cells.some(c => c.gg === gg && c.subject === s)).length;
    const gcells = subjCount * CODES_PER_CELL;
    cells240 += gcells;
    gt.push({ grade, seed_now: (byGrade.get(grade) || []).length, boost: STUDENT_BOOST[grade] || 0, after: n, subjects: subjCount, cells: gcells });
  }
  console.table(gt);
  console.log(`총 셀(학년×교과×코드): ${cells240}개`);
  console.log('(실 쓰기 없음. --apply 로 실행)');
}

// ─────────────────────────── 재빌드 ───────────────────────────
function doRebuild() {
  const t0 = Date.now();
  if (rebuildAllAggregates) rebuildAllAggregates();
  else console.warn('[bench] ⚠ rebuildAllAggregates 모듈 없음 — 집계 미갱신');
  console.log(`[bench] 집계 재빌드 (${Date.now() - t0}ms)`);
}

// ─────────────────────────── stats/검증 ───────────────────────────
function pearson(xs, ys) {
  const n = xs.length; if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx === 0 || dy === 0) ? 0 : num / Math.sqrt(dx * dy);
}

function printStats() {
  console.log('\n[bench] ===== 재시드 후 통계 =====');
  const beCnt = db.prepare(`SELECT COUNT(*) c FROM users WHERE username LIKE '${BENCH_USER_PREFIX}%'`).get().c;
  const benchLogs = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(BENCH_TAG).c;
  const totalLogs = db.prepare('SELECT COUNT(*) c FROM learning_logs').get().c;
  console.log(`벤치 신규학생 ${beCnt} · 벤치로그 ${benchLogs} · 전체로그 ${totalLogs}`);

  console.log('\n[초등 코어 셀 표본밀도(학년×코드, 평가학생 att>=3)]');
  const coreCodes = Array.from(assignBands(loadCoreCodes()).keys());
  const ph = coreCodes.map(() => '?').join(',');
  const density = db.prepare(`
    WITH ev AS (
      SELECT u.grade AS grade, s.achievement_code AS code, s.user_id,
             CASE WHEN s.attempt_count>=3 THEN 1 ELSE 0 END AS evaluated,
             CASE WHEN s.attempt_count>=3 AND (CAST(s.success_count AS REAL)/s.attempt_count)>=0.8 THEN 1 ELSE 0 END AS reached
      FROM lrs_achievement_stats s JOIN users u ON u.id=s.user_id
      WHERE u.role='student' AND u.school_level='elementary' AND s.achievement_code IN (${ph})
    ), cell AS (
      SELECT grade, code, SUM(evaluated) AS n_eval, SUM(reached) AS n_reach
      FROM ev GROUP BY grade, code
    )
    SELECT CASE WHEN n_eval>=50 THEN 'a) >=50' WHEN n_eval>=30 THEN 'b) 30-49' WHEN n_eval>=10 THEN 'c) 10-29' ELSE 'd) <10' END bucket,
           COUNT(*) cells
    FROM cell GROUP BY bucket ORDER BY bucket
  `).all(...coreCodes);
  console.table(density);

  console.log('\n[코어 셀 도달률 밴드 분포]');
  const bandByCode = assignBands(loadCoreCodes());
  const cellReach = db.prepare(`
    WITH ev AS (
      SELECT u.grade AS grade, s.achievement_code AS code,
             CASE WHEN s.attempt_count>=3 THEN 1 ELSE 0 END AS evaluated,
             CASE WHEN s.attempt_count>=3 AND (CAST(s.success_count AS REAL)/s.attempt_count)>=0.8 THEN 1 ELSE 0 END AS reached
      FROM lrs_achievement_stats s JOIN users u ON u.id=s.user_id
      WHERE u.role='student' AND u.school_level='elementary' AND s.achievement_code IN (${ph})
    )
    SELECT grade, code, SUM(evaluated) n_eval, SUM(reached) n_reach
    FROM ev GROUP BY grade, code HAVING n_eval>0
  `).all(...coreCodes);
  const bandBuckets = { high: 0, mid: 0, weak: 0 };
  for (const c of cellReach) {
    const rate = c.n_reach / c.n_eval;
    if (rate >= 0.80) bandBuckets.high++; else if (rate >= 0.50) bandBuckets.mid++; else bandBuckets.weak++;
  }
  console.log(`실현 도달률: 高(>=80%) ${bandBuckets.high} · 中(50-79%) ${bandBuckets.mid} · 弱(<50%) ${bandBuckets.weak}  (총 ${cellReach.length} 셀)`);

  // 우수/취약 Top10 미리보기(초등 전체 스코프, getWeakTrend 로직 근사)
  try {
    const analytics = require(path.join(__dirname, '..', 'db', 'lrs-analytics'));
    const elemIds = db.prepare("SELECT id FROM users WHERE role='student' AND school_level='elementary'").all().map(r => r.id);
    const strong = analytics.getWeakTrend({ userIds: elemIds, limit: 10, order: 'strong' });
    const weak = analytics.getWeakTrend({ userIds: elemIds, limit: 10, order: 'weak' });
    console.log('\n[우수 Top10 상위 5 — 초등 전체]');
    console.table(strong.slice(0, 5).map(r => ({ code: r.code, 도달률: r.reachedRate, 평가학생: r.evaluatedStudents })));
    console.log('[취약 Top10 상위 5 — 초등 전체]');
    console.table(weak.slice(0, 5).map(r => ({ code: r.code, 도달률: r.reachedRate, 평가학생: r.evaluatedStudents })));
  } catch (e) { console.log('Top10 미리보기 skip:', e.message); }
  console.log('===================================\n');
}

// ─────────────────────────── main ───────────────────────────
if (MODE === 'plan') plan();
else if (MODE === 'stats') printStats();
else if (MODE === 'clean') clean();
else if (MODE === 'apply') apply();
process.exit(0);
