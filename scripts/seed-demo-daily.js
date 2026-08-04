#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * seed-demo-daily.js — "오늘의 학습 도 비교"(daily-benchmark) 우리 반 라인 최근기간 보강 (데모)
 *
 * 문제
 *   LRS Phase2 t-daily-benchmark(오늘의 학습 도 비교)는 self_learn 로그를 활동일 DATE(created_at)로
 *   집계해 "우리 반 vs 충북 동학년"을 일자 시계열로 그린다. 도(道) 라인은 시드로 최근 30일이 조밀하지만,
 *   teacher1 담당 두 반(class 1 "3학년 1반", class 2 "즐거운 수학교실")의 실제 학생들은 self_learn 로그가
 *   2026-04-18~05-07 에만 있어(그 뒤 공백) 기본 조회(최근 30일)에서 "우리 반" 라인이 통째로 비어 보인다.
 *
 * 해결 (이 스크립트)
 *   teacher1 담당 "활성·소유" 클래스의 실제 class_members(학생) 에게만, 최근 창(기본 2026-06-15~07-10,
 *   = 현재 도 라인 커버리지와 동일 구간)에 self_learn 로그를 "소량·현실적"으로 추가한다.
 *   - 도 평균(≈74%)과 자연스럽게 비교되는 값(학생별 능력·성실도 편차, 억지 100%/0% 금지)
 *   - 학생마다 며칠씩만(전원 매일 아님), 하루 대개 1건(가끔 2건)
 *
 * daily-benchmark 정합 (routes/lrs.js /stats/daily-benchmark)
 *   반 라인   = class_members(role=student) 학생들의 self_learn 을 DATE(created_at) 로 GROUP BY,
 *               acc = AVG(normScore), n = COUNT(DISTINCT user_id). (log.class_id 는 무시 — 멤버십 기준)
 *   normScore = CASE WHEN result_score<=1 THEN *100 ELSE result_score → result_score 는 0~1 스케일로 저장.
 *   ★ 집계는 learning_logs 를 "라이브"로 읽는다 → lrs_achievement_stats / lrs_user_daily 재빌드 불필요.
 *     achievement_code=NULL 로 넣어 성취 통계(도달률)에도 영향 없음(범위 최소).
 *
 * 정직성 / 되돌리기
 *   - 추가 로그는 전부 is_seed=1 · context_registration='demo_daily_v1' 태그.
 *     → realOnly=1 조회 시 자동 제외(우리 반 라인 다시 빔 = 정상). 실사용자(is_seed=0) 로그는 무변경.
 *   - 멱등: 재실행 시 태그 로그를 먼저 purge 후 재삽입(중복 폭증 없음). GCP 에서도 동일 실행 가능.
 *   - --apply 전 DB 파일 백업(.bak-<ts>). 신규 사용자 생성 없음(기존 반 학생에만 추가).
 *
 * 범위 최소
 *   - teacher1 활성·소유 클래스의 학생만. 도 모집단/타 반/타 학년/신규 유저 일절 건드리지 않음.
 *
 * 사용법
 *   node scripts/seed-demo-daily.js --plan     # 무쓰기 미리보기(대상 반·학생·창)
 *   node scripts/seed-demo-daily.js --apply     # 백업 후 데모 로그 재시드
 *   node scripts/seed-demo-daily.js --clean      # 데모 로그 전부 제거(실데이터·타 시드 불변)
 *   node scripts/seed-demo-daily.js --stats       # 반별 최근30일 series(반/도 n·acc) 출력(before/after 증적)
 *   옵션: --no-backup(백업 생략, 위험)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const path = require('path');
const fs = require('fs');
const db = require(path.join(__dirname, '..', 'db', 'index'));

// ─────────────────────────── CLI ───────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--clean') ? 'clean' : has('--stats') ? 'stats' : has('--plan') ? 'plan' : has('--apply') ? 'apply' : null;
const NO_BACKUP = has('--no-backup');
if (!MODE) {
  console.log('Usage: node scripts/seed-demo-daily.js [--apply | --clean | --stats | --plan] [--no-backup]');
  process.exit(1);
}

// ─────────────────────────── 상수 ───────────────────────────
const TEACHER1 = 2;                          // 담임 교사 계정(고정)
const DEMO_TAG = 'demo_daily_v1';            // 멱등 태그(context_registration)
const SEED = 20260714;
// 보강 창: 도(시드) 라인 커버리지 끝에 자동으로 맞춘다 — 두 라인이 "나란히" 끝나게.
//   ★ 과거에는 '2026-06-15'~'2026-07-10' 로 **고정**돼 있었다. 그 탓에 달력이 지나면
//     이 데모 보강분이 기본 조회 창(today-29~today) 밖으로 통째로 빠져나가
//     "우리 반" 라인이 다시 비어버렸다(2026-07-30 사고의 한 갈래).
//   → 이제 DB 의 실제 시드 라인 끝(MAX)에서 역산한다. 시드를 롤링해도 자동 추종.
//     명시 지정이 필요하면 --from / --to 로 덮어쓴다.
const argOfLocal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const _seedLineEnd = (() => {
  try {
    const r = db.prepare("SELECT MAX(DATE(created_at)) m FROM learning_logs WHERE is_seed = 1").get();
    return (r && r.m) || null;
  } catch (_) { return null; }
})();
const _today = new Date().toISOString().slice(0, 10);
const WIN_TO   = argOfLocal('--to', _seedLineEnd || _today);
const WIN_FROM = argOfLocal('--from', (() => {
  const d = new Date(WIN_TO + 'T00:00:00'); d.setDate(d.getDate() - 25);
  return d.toISOString().slice(0, 10);
})());
// 오늘의 학습(self_learn) 교과 — 두 반 모두 수학 편중(class2=수학교실, class1 최빈=math-e). 캐노니컬 -e 코드.
const SUBJECT_WEIGHTS = [
  ['math-e', 55], ['korean-e', 15], ['science-e', 12], ['english-e', 10], ['social-e', 8],
];
// 회귀 하네스가 "고정 계정"으로 박제 중인 학생은 제외한다(데모 로그가 그 불변식을 깨므로).
//   · uid 3(student1): test/lrs-perform-detail.test.js GT_FIXED — 고정 창(2026-04-01~07-02) 절대값
//     드릴다운(self/all …)을 박제. 창 안(06-15~07-02)에 로그가 들어가면 절대값이 어긋난다.
//   · uid 13(한서윤): test/lrs-analytics.test.js ENGDETAIL-4 — "최근 2주 활동 없는 빈 학생" 정직응답 픽스처.
//   반 라인은 나머지 멤버(반당 5~6명)로 충분히 채워지므로 이 둘을 빼도 데모 목적(우리 반 라인 채움)에 영향 없음.
//   (교사 화면의 반 라인은 멤버 평균이라 특정 학생 1~2명 제외는 비가시. 재시드 시 이 목록만 확인하면 하네스 안전.)
const HARNESS_PINNED_UIDS = new Set([3, 13]);

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
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function gaussFrom(r) { // Box-Muller from a [0,1) rng
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pickW = (r, pairs) => {
  const sum = pairs.reduce((s, p) => s + p[1], 0);
  let x = r() * sum;
  for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; }
  return pairs[0][0];
};

// ─────────────────────────── 컬럼 가드 ───────────────────────────
const llCols = new Set(db.prepare('PRAGMA table_info(learning_logs)').all().map(c => c.name));
for (const c of ['is_seed', 'subject_code', 'duration_sec', 'context_registration', 'source_service']) {
  if (!llCols.has(c)) { console.error(`[demo-daily] ✗ learning_logs.${c} 컬럼 없음 — 서버 1회 기동(initSchema) 후 재실행.`); process.exit(1); }
}

// ─────────────────────────── 대상 반·학생 ───────────────────────────
// teacher1 소유(owner_id) & 활성(status='active') 클래스 → 학생 멤버(role=student).
//   _benchClassCtx 와 동일하게 grade 는 classes.grade(1~6) 우선, 없으면 멤버 최빈 grade, level 은 멤버 최빈.
function resolveTargets() {
  const classes = db.prepare(
    "SELECT id, name, grade FROM classes WHERE owner_id=? AND status='active' ORDER BY id"
  ).all(TEACHER1);
  const targets = [];
  for (const c of classes) {
    const members = db.prepare(`
      SELECT u.id, u.grade, u.school_level FROM class_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.class_id=? AND u.role='student' ORDER BY u.id
    `).all(c.id);
    if (!members.length) continue;
    // grade 해석
    let grade = null, gradeSource = null;
    const cg = c.grade != null ? parseInt(c.grade, 10) : NaN;
    if (Number.isInteger(cg) && cg >= 1 && cg <= 6) { grade = cg; gradeSource = 'class'; }
    else {
      const gc = {}; members.forEach(m => { if (m.grade != null) gc[m.grade] = (gc[m.grade] || 0) + 1; });
      let best = 0; for (const k of Object.keys(gc)) if (gc[k] > best) { best = gc[k]; grade = Number(k); }
      if (grade != null) gradeSource = 'members';
    }
    // level 최빈
    const sc = {}; members.forEach(m => { if (m.school_level) sc[m.school_level] = (sc[m.school_level] || 0) + 1; });
    let level = null, lb = 0; for (const k of Object.keys(sc)) if (sc[k] > lb) { lb = sc[k]; level = k; }
    if (!level && grade != null && grade >= 1 && grade <= 6) level = 'elementary';
    targets.push({ classId: c.id, name: c.name, grade, gradeSource, level, studentIds: members.map(m => m.id) });
  }
  return targets;
}

// 씨딩 대상 학생 = 모든 대상 반 멤버의 합집합(반끼리 학생이 겹쳐도 학생당 1회만 로그 생성 —
//   반 라인은 멤버십으로 파생되므로 겹치는 학생의 로그가 양쪽 반에 자동 반영). 하네스 고정 계정은 제외.
function seedStudentIds(targets) {
  const s = new Set();
  targets.forEach(t => t.studentIds.forEach(id => { if (!HARNESS_PINNED_UIDS.has(id)) s.add(id); }));
  return [...s].sort((a, b) => a - b);
}

// ─────────────────────────── 날짜 유틸 ───────────────────────────
function dateList(fromStr, toStr) {
  const out = [];
  const d = new Date(fromStr + 'T00:00:00');
  const end = new Date(toStr + 'T00:00:00');
  while (d <= end) { out.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return out;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ─────────────────────────── 로그 삽입 ───────────────────────────
const insLog = db.prepare(`
  INSERT INTO learning_logs (
    user_id, class_id, activity_type, verb, object_type, object_id,
    result_score, result_success, duration_sec, source_service,
    achievement_code, subject_code, grade_group,
    device_type, platform, context_registration, metadata_json, created_at, is_seed
  ) VALUES (
    @user_id, NULL, 'self_learn', 'completed', 'daily-learning', @object_id,
    @result_score, @result_success, @duration_sec, 'self-learn',
    NULL, @subject_code, NULL,
    @device_type, @platform, @context_registration, @metadata_json, @created_at, 1
  )
`);

// 학생별 결정론 프로파일 — 능력(baseAcc)·성실도(diligence)·평균 학습시간(baseDur)
function studentProfile(uid) {
  const r = mulberry32(hashStr(`${DEMO_TAG}|prof|${uid}`) ^ SEED);
  const baseAcc = clamp(0.76 + gaussFrom(r) * 0.10, 0.50, 0.95);   // 도(≈74%)와 자연 비교되는 스프레드
  const diligence = 0.30 + r() * 0.32;                              // 0.30~0.62(평일 활동 확률)
  const baseDur = Math.round(clamp(1000 + gaussFrom(r) * 240, 480, 1500)); // 평균 학습시간(초)
  return { baseAcc, diligence, baseDur };
}

function buildDayLogs(uid, dateObj) {
  const dstr = iso(dateObj);
  const prof = studentProfile(uid);
  const r = mulberry32(hashStr(`${DEMO_TAG}|day|${uid}|${dstr}`) ^ SEED);
  const dow = dateObj.getDay(); // 0=일,6=토
  const isWeekend = dow === 0 || dow === 6;
  const pActive = isWeekend ? prof.diligence * 0.35 : prof.diligence;
  if (r() >= pActive) return [];                                    // 이 날은 무활동
  const count = r() < 0.15 ? 2 : 1;                                 // 대개 1건, 가끔 2건
  const logs = [];
  for (let k = 0; k < count; k++) {
    const acc = clamp(prof.baseAcc + gaussFrom(r) * 0.08, 0.30, 1.0);
    const score = Math.round(acc * 100) / 100;                     // 0~1 스케일(기존 self_learn 로그와 동일)
    const dur = Math.round(clamp(prof.baseDur + gaussFrom(r) * 220, 300, 1800));
    const hh = 14 + Math.floor(r() * 8);                           // 방과후 14~21시
    const mm = Math.floor(r() * 60), ss = Math.floor(r() * 60);
    logs.push({
      user_id: uid,
      object_id: String(1 + Math.floor(r() * 120)),
      result_score: score,
      result_success: score >= 0.6 ? 1 : 0,
      duration_sec: dur,
      subject_code: pickW(r, SUBJECT_WEIGHTS),
      device_type: pickW(r, [['tablet', 5], ['desktop', 3], ['mobile', 2]]),
      platform: pickW(r, [['web', 6], ['mobile', 4]]),
      context_registration: DEMO_TAG,
      metadata_json: JSON.stringify({ src: 'demo_daily', v: 1 }),
      created_at: `${dstr} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
    });
  }
  return logs;
}

// ─────────────────────────── purge(멱등) ───────────────────────────
function purge() {
  const before = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(DEMO_TAG).c;
  db.prepare('DELETE FROM learning_logs WHERE context_registration=?').run(DEMO_TAG);
  return before;
}

// ─────────────────────────── 백업 ───────────────────────────
function backupDb() {
  if (NO_BACKUP) { console.log('[demo-daily] ⚠ --no-backup: 백업 생략'); return null; }
  const dbPath = db.name || path.join(__dirname, '..', 'data', 'dacheum.db');
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
  const dest = dbPath + `.bak-${ts}`;
  fs.copyFileSync(dbPath, dest);
  console.log(`[demo-daily] 백업 생성: ${path.basename(dest)} (${(fs.statSync(dest).size / 1048576).toFixed(1)}MB)`);
  return dest;
}

// ─────────────────────────── apply ───────────────────────────
function apply() {
  const t0 = Date.now();
  console.log('[demo-daily] ===== 오늘의 학습 도 비교 우리 반 라인 보강 =====');
  backupDb();
  const purged = purge();
  console.log(`[demo-daily] purge: 기존 데모 로그 ${purged}건 삭제(멱등)`);

  const targets = resolveTargets();
  if (!targets.length) { console.error('[demo-daily] ✗ teacher1 활성 소유 반/학생 없음 — 중단'); process.exit(1); }
  const students = seedStudentIds(targets);
  const days = dateList(WIN_FROM, WIN_TO);

  let batch = [];
  const flush = db.transaction((rows) => { for (const x of rows) insLog.run(x); });
  let total = 0;
  const perStudentDays = new Map();
  for (const uid of students) {
    let daysActive = 0;
    for (const d of days) {
      const logs = buildDayLogs(uid, d);
      if (logs.length) daysActive++;
      for (const lg of logs) { batch.push(lg); total++; }
      if (batch.length >= 2000) { flush(batch); batch = []; }
    }
    perStudentDays.set(uid, daysActive);
  }
  if (batch.length) flush(batch);

  console.log(`[demo-daily] 대상 반 ${targets.length} · 학생 ${students.length}명 · 창 ${WIN_FROM}~${WIN_TO}(${days.length}일)`);
  console.table(targets.map(t => ({ classId: t.classId, name: t.name, grade: t.grade, gradeSrc: t.gradeSource, level: t.level, students: t.studentIds.length })));
  console.log('[demo-daily] 학생별 활동일 수:');
  console.table([...perStudentDays.entries()].map(([uid, d]) => ({ user_id: uid, active_days: d })));
  console.log(`[demo-daily] self_learn 데모 로그 삽입: ${total}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('[demo-daily] (집계 재빌드 불필요 — daily-benchmark 는 learning_logs 라이브 조회, achievement_code=NULL)');

  printStats(targets);
}

// ─────────────────────────── clean ───────────────────────────
function clean() {
  backupDb();
  const before = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(DEMO_TAG).c;
  purge();
  const after = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(DEMO_TAG).c;
  const real = db.prepare("SELECT COUNT(*) c FROM learning_logs WHERE COALESCE(is_seed,0)=0 AND activity_type='self_learn'").get().c;
  console.log(`[demo-daily] --clean: 데모 로그 ${before}→${after}. 실사용자 self_learn 로그 보존: ${real}`);
}

// ─────────────────────────── stats/plan ───────────────────────────
// 반별 최근 30일(today-29~today) series 를 엔드포인트와 동일한 방식으로 재현(반/도 n·acc·masked).
function classSeries(target, from, to) {
  const NORM = "(CASE WHEN result_score<=1 THEN result_score*100 ELSE result_score END)";
  const provIds = (target.level && target.grade != null)
    ? db.prepare("SELECT id FROM users WHERE role='student' AND school_level=? AND grade=?").all(target.level, target.grade).map(r => r.id)
    : [];
  const agg = (ids) => {
    if (!ids.length) return new Map();
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DATE(created_at) d, ROUND(AVG(${NORM}),1) acc, COUNT(DISTINCT user_id) n
      FROM learning_logs WHERE activity_type='self_learn' AND user_id IN (${ph})
        AND DATE(created_at) BETWEEN ? AND ? GROUP BY d`).all(...ids, from, to);
    return new Map(rows.map(r => [r.d, r]));
  };
  const cMap = agg(target.studentIds), pMap = agg(provIds);
  const dates = [...new Set([...cMap.keys(), ...pMap.keys()])].sort();
  return dates.map(d => {
    const c = cMap.get(d), p = pMap.get(d);
    const pMasked = !p || p.n < 10;
    return { date: d, cls_n: c ? c.n : 0, cls_acc: c ? c.acc : null, prov_n: p ? p.n : 0, prov_acc: pMasked ? null : p.acc, prov_masked: pMasked };
  });
}

function printStats(targets) {
  targets = targets || resolveTargets();
  // 엔드포인트 기본 창 = today-29 ~ today
  const today = new Date();
  const to = iso(today); const f = new Date(today); f.setDate(f.getDate() - 29); const from = iso(f);
  console.log(`\n[demo-daily] ===== 반별 최근 30일 series (${from} ~ ${to}) =====`);
  for (const t of targets) {
    const s = classSeries(t, from, to);
    const clsDates = s.filter(x => x.cls_n > 0);
    const clsAccAll = clsDates.length ? Math.round(clsDates.reduce((a, x) => a + x.cls_acc, 0) / clsDates.length * 10) / 10 : null;
    console.log(`\n## class ${t.classId} "${t.name}" (grade ${t.grade}/${t.gradeSource}, 도=${t.level} ${t.grade}학년)`);
    console.log(`   우리 반 데이터 있는 일자: ${clsDates.length} / ${s.length}  (반 평균 acc ${clsAccAll == null ? '—' : clsAccAll + '%'})`);
    // 최근 12일만 표로(가독)
    console.table(s.slice(-12));
  }
  console.log('\n(참고: realOnly=1 조회 시 이 데모 로그(is_seed=1)는 제외 → 우리 반 라인 다시 빔 = 정상)\n');
}

function plan() {
  const targets = resolveTargets();
  const students = seedStudentIds(targets);
  const days = dateList(WIN_FROM, WIN_TO);
  console.log('\n[demo-daily] ===== PLAN (무쓰기) =====');
  console.log(`대상 반 ${targets.length} · 씨딩 대상 학생 ${students.length}명(합집합) · 창 ${WIN_FROM}~${WIN_TO}(${days.length}일)`);
  console.table(targets.map(t => ({ classId: t.classId, name: t.name, grade: t.grade, gradeSrc: t.gradeSource, level: t.level, students: t.studentIds.length })));
  console.log('씨딩 대상 학생 ids:', students.join(', '));
  console.log('하네스 고정 계정 제외:', [...HARNESS_PINNED_UIDS].join(', '), '(uid3=드릴다운 GT_FIXED, uid13=ENGDETAIL 빈학생)');
  const existing = db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(DEMO_TAG).c;
  console.log(`기존 데모 로그(태그 ${DEMO_TAG}): ${existing}건 (--apply 시 purge 후 재생성)`);
  console.log('(실 쓰기 없음. --apply 로 실행)');
}

// ─────────────────────────── main ───────────────────────────
if (MODE === 'plan') plan();
else if (MODE === 'stats') printStats();
else if (MODE === 'clean') clean();
else if (MODE === 'apply') apply();
process.exit(0);
