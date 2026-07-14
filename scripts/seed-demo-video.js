#!/usr/bin/env node
/**
 * seed-demo-video.js — LRS Phase 4a "영상 학습 행동"(완주율·재시청·건너뛰기) 데모 계측 시드
 *
 * 문제
 *   LRS t-behavior ④ "영상 학습 행동"(signal=video / rewatch alias)은 user_content_progress 의
 *   watch_ratio(완주)·view_count(재시청)·seek_count(건너뛰기)를 성취(도달률)와 밴드로 견준다.
 *   그러나 실 DB 의 user_content_progress 는 3행뿐(전부 교사 uid=2), teacher1 담당 반 학생은 0행 →
 *   실제 영상 플레이어 계측(xAPI Video Profile)이 아직 없어 화면이 항상 "준비 중"이다.
 *
 * 해결 (이 스크립트 · 시연용 데모 계측)
 *   teacher1(uid 2) 담당 "활성·소유" 반(class 1 "3학년 1반", class 2 "즐거운 수학교실")의 실제 학생에게만,
 *   그 반 학년·교과에 맞는 content_type='video' 콘텐츠를 학생당 12개 배정하고 (학생×영상) 관측치를
 *   user_content_progress 에 upsert 한다. watch_ratio·view_count·seek_count 는 ★성취와 독립인 현실적
 *   주변분포에서 결정론 PRNG 로 추출(억지 상관 금지 — "느리게=낮음" 같은 커플링 하드코딩 없음).
 *   결과적으로 밴드 간 성취차는 작고 노이즈성인 게 정직이다.
 *
 * 정직성 / 되돌리기
 *   - 모든 시드 행은 is_seed=1 태그(데모 계측 근거·teardown 키). realOnly=1 조회 시 자동 제외.
 *   - learning_logs·achievement_stats·users·class_members 는 절대 미변경 → 성취 하네스(GT) 무오염.
 *     (GT 고정계정 uid3·uid13 도 포함 가능: user_content_progress 시드는 채점 로그를 바꾸지 않는다.)
 *   - 멱등: 재실행 시 대상 학생의 is_seed=1 행을 먼저 purge 후 결정론 재삽입(중복 무증가).
 *     실 데이터(is_seed=0, 3행)는 보존. UNIQUE(user_id,content_id) 충돌 시 is_seed=1 행만 갱신.
 *   - --apply 전 DB 파일 백업(.bak-<ts>). 마이그레이션(seek_count·is_seed 컬럼) 멱등 포함.
 *
 * 범위 최소
 *   - teacher1 활성·소유 반 학생만. 타 반·타 학년·신규 유저·도 모집단 일절 건드리지 않음.
 *
 * 사용법
 *   node scripts/seed-demo-video.js --plan     # 무쓰기 미리보기(대상 반·학생·콘텐츠 풀)
 *   node scripts/seed-demo-video.js --apply    # 마이그레이션 + 백업 후 데모 관측치 재시드
 *   node scripts/seed-demo-video.js --clean    # 데모 관측치 전부 제거(실데이터 3행 불변)
 *   node scripts/seed-demo-video.js --stats    # sub별 밴드 distinct 학생 n·마스킹·도달률(before/after 증적)
 *   옵션: --no-backup(백업 생략, 위험)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const path = require('path');
const fs = require('fs');
const db = require(path.join(__dirname, '..', 'db', 'index'));
const mastery = require(path.join(__dirname, '..', 'db', 'lrs-mastery'));

// ─────────────────────────── CLI ───────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--clean') ? 'clean' : has('--stats') ? 'stats' : has('--plan') ? 'plan' : has('--apply') ? 'apply' : null;
const NO_BACKUP = has('--no-backup');

// ─────────────────────────── 상수 ───────────────────────────
const TEACHER1 = 2;                          // 담임 교사 계정(고정)
const DEMO_TAG = 'demo_video_v1';            // 문서용 태그(ucp 엔 컬럼 없음 → is_seed=1 로 식별)
const SEED = 20260714;
// 학생당 배정 영상 수. 8명 반 × 8영상 = 64관측치에서 주요 밴드 distinct 학생 ≥5 확보 +
// 저빈도 밴드(재시청 4회+)는 자연 마스킹(정직) + 완주 밴드에 소량 자연 노이즈가 생기도록 튜닝(억지 상관 아님).
const VIDEOS_PER_STUDENT = parseInt(process.env.VPS, 10) || 8;
const ACH_DAYS = 90;                          // 성취(도달률) 산출 창 — API 기본 period=90d 정합

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
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pickW = (r, pairs) => {
  const sum = pairs.reduce((s, p) => s + p[1], 0);
  let x = r() * sum;
  for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; }
  return pairs[0][0];
};

// ─────────────────────────── 마이그레이션(멱등) ───────────────────────────
// user_content_progress 에 seek_count·is_seed 컬럼 추가(PRAGMA 확인 후 ADD). 서버 미기동 상태에서도 안전.
function migrate() {
  const cols = new Set(db.prepare('PRAGMA table_info(user_content_progress)').all().map(c => c.name));
  const added = [];
  if (!cols.has('seek_count')) { db.exec('ALTER TABLE user_content_progress ADD COLUMN seek_count INTEGER DEFAULT 0'); added.push('seek_count'); }
  if (!cols.has('is_seed')) { db.exec('ALTER TABLE user_content_progress ADD COLUMN is_seed INTEGER DEFAULT 0'); added.push('is_seed'); }
  if (added.length) console.log(`[demo-video] 마이그레이션: user_content_progress 컬럼 추가 → ${added.join(', ')}`);
  else console.log('[demo-video] 마이그레이션: seek_count·is_seed 이미 존재(멱등, 변경 없음)');
}

// ─────────────────────────── 대상 반·학생·콘텐츠 ───────────────────────────
// teacher1 소유(owner_id) & 활성(status='active') 반 → 학생 멤버(role=student).
function resolveTargets() {
  const classes = db.prepare("SELECT id, name, grade FROM classes WHERE owner_id=? AND status='active' ORDER BY id").all(TEACHER1);
  const targets = [];
  for (const c of classes) {
    const members = db.prepare(`
      SELECT u.id, u.grade, u.school_level FROM class_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.class_id=? AND u.role='student' ORDER BY u.id
    `).all(c.id);
    if (!members.length) continue;
    let grade = null;
    const cg = c.grade != null ? parseInt(c.grade, 10) : NaN;
    if (Number.isInteger(cg) && cg >= 1 && cg <= 6) grade = cg;
    else { const gc = {}; members.forEach(m => { if (m.grade != null) gc[m.grade] = (gc[m.grade] || 0) + 1; }); let best = 0; for (const k of Object.keys(gc)) if (gc[k] > best) { best = gc[k]; grade = Number(k); } }
    targets.push({ classId: c.id, name: c.name, grade, studentIds: members.map(m => m.id) });
  }
  return targets;
}

// 씨딩 대상 학생 = 모든 대상 반 멤버의 합집합(반끼리 겹쳐도 학생당 1회). GT 고정계정도 포함(ucp 시드는 성취 무변경).
function seedStudentIds(targets) {
  const s = new Set();
  targets.forEach(t => t.studentIds.forEach(id => s.add(id)));
  return [...s].sort((a, b) => a - b);
}

// 영상 콘텐츠 풀 — 반 학년·교과에 맞는 content_type='video'(수학 계열 또는 초등 3·4학년). 결정론 셔플로 학생별 배정.
function videoPool() {
  const rows = db.prepare(`
    SELECT id, COALESCE(estimated_minutes,0) AS mins FROM contents
    WHERE content_type='video' AND (subject LIKE '수학%' OR grade IN (3,4))
    ORDER BY id
  `).all();
  return rows;
}

function assignVideos(uid, pool) {
  // 결정론 셔플(Fisher-Yates, student-seeded) 후 앞 N개.
  const r = mulberry32(hashStr(`${DEMO_TAG}|pick|${uid}`) ^ SEED);
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, Math.min(VIDEOS_PER_STUDENT, arr.length));
}

// ─────────────────────────── 관측치 생성 (성취와 독립인 주변분포) ───────────────────────────
// watch_ratio / view_count / seek_count 는 학생 성취(reachRate)와 커플링 없이 결정론 추출한다(억지 상관 금지).
function buildObservation(uid, content) {
  const r = mulberry32(hashStr(`${DEMO_TAG}|obs|${uid}|${content.id}`) ^ SEED);
  // 완주율(watch_ratio): 완주(≥0.9) 45% · 0.5~0.9 35% · <0.5 20% (1.0 초과 소량 허용=재시청 겹침)
  const band = pickW(r, [['full', 45], ['mid', 35], ['low', 20]]);
  let wr;
  if (band === 'full') wr = clamp(0.9 + r() * 0.25, 0.9, 1.15);
  else if (band === 'mid') wr = 0.5 + r() * 0.4;
  else wr = 0.05 + r() * 0.44;
  wr = Math.round(wr * 100) / 100;
  // 재시청(view_count): 1회 65% · 2~3회 28% · 4+회 7%
  const vband = pickW(r, [['once', 65], ['few', 28], ['many', 7]]);
  let vc;
  if (vband === 'once') vc = 1;
  else if (vband === 'few') vc = 2 + Math.floor(r() * 2);            // 2~3
  else vc = pickW(r, [[4, 5], [5, 2], [6, 1]]);                     // 4~6(롱테일)
  // 건너뛰기(seek_count): Poisson(1.5) 근사 — 0~2 다수 + 소수 다빈도
  const seek = pickW(r, [[0, 223], [1, 335], [2, 251], [3, 126], [4, 47], [5, 14], [6, 4]]);
  // 영상 길이·마지막 위치
  const duration = content.mins > 0 ? content.mins * 60 : (300 + Math.floor(r() * 600));
  const position = Math.round(duration * Math.min(wr, 1));
  return { uid, content_id: content.id, wr, vc, seek, duration, position };
}

function generateRows(targets) {
  const students = seedStudentIds(targets);
  const pool = videoPool();
  const rows = [];
  for (const uid of students) {
    const vids = assignVideos(uid, pool);
    for (const c of vids) rows.push(buildObservation(uid, c));
  }
  return { students, poolSize: pool.length, rows };
}

// ─────────────────────────── upsert / purge ───────────────────────────
// ★ lazy prepare: seek_count 컬럼은 migrate() 이후에만 존재 → 모듈 로드시 prepare 하면 실패. apply() 안에서 준비.
function prepareUpsert() {
  return db.prepare(`
    INSERT INTO user_content_progress (user_id, content_id, node_id, position_sec, duration_sec, watch_ratio, view_count, seek_count, is_seed, updated_at)
    VALUES (@uid, @content_id, NULL, @position, @duration, @wr, @vc, @seek, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, content_id) DO UPDATE SET
      position_sec=excluded.position_sec, duration_sec=excluded.duration_sec,
      watch_ratio=excluded.watch_ratio, view_count=excluded.view_count, seek_count=excluded.seek_count,
      is_seed=1, updated_at=CURRENT_TIMESTAMP
    WHERE user_content_progress.is_seed = 1
  `);
}

// 대상 학생의 is_seed=1 행만 purge(실 데이터 is_seed=0 보존).
function purge(studentIds) {
  if (!studentIds.length) return 0;
  const ph = studentIds.map(() => '?').join(',');
  const before = db.prepare(`SELECT COUNT(*) c FROM user_content_progress WHERE is_seed=1 AND user_id IN (${ph})`).get(...studentIds).c;
  db.prepare(`DELETE FROM user_content_progress WHERE is_seed=1 AND user_id IN (${ph})`).run(...studentIds);
  return before;
}

// ─────────────────────────── 백업 ───────────────────────────
function backupDb() {
  if (NO_BACKUP) { console.log('[demo-video] ⚠ --no-backup: 백업 생략'); return null; }
  const dbPath = db.name || path.join(__dirname, '..', 'data', 'dacheum.db');
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
  const dest = dbPath + `.bak-${ts}`;
  fs.copyFileSync(dbPath, dest);
  console.log(`[demo-video] 백업 생성: ${path.basename(dest)} (${(fs.statSync(dest).size / 1048576).toFixed(1)}MB)`);
  return dest;
}

// ─────────────────────────── 성취(도달률) 맵 ───────────────────────────
// _behaviorAchMap 과 동일 산식(정규화 정답률·success/attempts → mastery.reachRate). 학생별 1회.
function reachMap(studentIds) {
  const map = new Map();
  if (!studentIds.length) return map;
  const ph = studentIds.map(() => '?').join(',');
  const NORM = '(CASE WHEN ll.result_score<=1 THEN ll.result_score*100 ELSE ll.result_score END)';
  const rows = db.prepare(`
    SELECT ll.user_id uid, AVG(${NORM}) score,
           SUM(CASE WHEN ll.result_success=1 THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN ll.result_success IN (0,1) THEN 1 ELSE 0 END) attempts
    FROM learning_logs ll
    WHERE ll.user_id IN (${ph}) AND ll.result_score IS NOT NULL
      AND ll.created_at >= date('now', ?)
    GROUP BY ll.user_id
  `).all(...studentIds, `-${ACH_DAYS} days`);
  for (const r of rows) {
    const score = r.score == null ? null : Math.round(Number(r.score) * 10) / 10;
    const reach = mastery.reachRate(r.success, r.attempts, score);
    if (reach != null) map.set(r.uid, Math.round(reach * 10) / 10);
  }
  return map;
}

// ─────────────────────────── apply / clean ───────────────────────────
function apply() {
  const t0 = Date.now();
  console.log('[demo-video] ===== 영상 학습 행동(완주·재시청·건너뛰기) 데모 계측 시드 =====');
  migrate();
  backupDb();
  const targets = resolveTargets();
  if (!targets.length) { console.error('[demo-video] ✗ teacher1 활성 소유 반/학생 없음 — 중단'); process.exit(1); }
  const { students, poolSize, rows } = generateRows(targets);
  const purged = purge(students);
  console.log(`[demo-video] purge: 대상 학생 is_seed=1 관측치 ${purged}건 삭제(멱등)`);

  const upsert = prepareUpsert();
  const flush = db.transaction((rs) => { for (const x of rs) upsert.run(x); });
  flush(rows);

  console.log(`[demo-video] 대상 반 ${targets.length} · 학생 ${students.length}명 · 영상 풀 ${poolSize}개 · 학생당 ${VIDEOS_PER_STUDENT}개`);
  console.table(targets.map(t => ({ classId: t.classId, name: t.name, grade: t.grade, students: t.studentIds.length })));
  console.log(`[demo-video] user_content_progress 데모 관측치 upsert: ${rows.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('[demo-video] (learning_logs·achievement_stats 무변경 — 성취 하네스 GT 무오염)');
  printStats(targets);
}

function clean() {
  migrate();
  backupDb();
  const targets = resolveTargets();
  const students = seedStudentIds(targets);
  const before = db.prepare('SELECT COUNT(*) c FROM user_content_progress WHERE is_seed=1').get().c;
  purge(students);
  const after = db.prepare('SELECT COUNT(*) c FROM user_content_progress WHERE is_seed=1').get().c;
  const real = db.prepare('SELECT COUNT(*) c FROM user_content_progress WHERE COALESCE(is_seed,0)=0').get().c;
  console.log(`[demo-video] --clean: 데모 관측치(is_seed=1) ${before}→${after}. 실 데이터(is_seed=0) 보존: ${real}행`);
}

// ─────────────────────────── stats / plan ───────────────────────────
// sub별 밴드 distinct 학생 n·마스킹·평균 도달률을 API 산식과 동일하게 재현(증적).
function subBands(sub, obs, median) {
  if (sub === 'completion') return [
    ['low', '절반 미만 시청', o => o.wr < 0.5], ['mid', '절반~대부분', o => o.wr >= 0.5 && o.wr < 0.9], ['full', '완주', o => o.wr >= 0.9]];
  if (sub === 'replay') return [
    ['once', '1회', o => o.vc <= 1], ['few', '2~3회', o => o.vc >= 2 && o.vc <= 3], ['many', '4회+', o => o.vc >= 4]];
  return [['low', '적음', o => o.seek <= median], ['high', '많음', o => o.seek > median]];
}
function median(nums) { if (!nums.length) return 0; const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function printStats(targets) {
  targets = targets || resolveTargets();
  const students = seedStudentIds(targets);
  const rMap = reachMap(students);
  const cols = new Set(db.prepare('PRAGMA table_info(user_content_progress)').all().map(c => c.name));
  const seekSel = cols.has('seek_count') ? 'seek_count' : '0';
  const ph = students.map(() => '?').join(',');
  const obs = students.length ? db.prepare(`
    SELECT ucp.user_id uid, ucp.watch_ratio wr, ucp.view_count vc, ${seekSel} seek, COALESCE(ucp.is_seed,0) isSeed
    FROM user_content_progress ucp JOIN contents c ON c.id=ucp.content_id
    WHERE ucp.user_id IN (${ph}) AND c.content_type='video' AND COALESCE(ucp.is_seed,0)=1
  `).all(...students).map(r => ({ uid: r.uid, wr: Number(r.wr) || 0, vc: Number(r.vc) || 0, seek: Number(r.seek) || 0 })) : [];
  console.log(`\n[demo-video] ===== sub별 밴드 요약 (관측치 ${obs.length} · 학생 ${students.length} · 성취산출 ${rMap.size}명) =====`);
  const med = median(obs.map(o => o.seek));
  for (const sub of ['completion', 'replay', 'seek']) {
    const bands = subBands(sub, obs, med);
    const rows = bands.map(([key, label, test]) => {
      const uids = new Set(); obs.forEach(o => { if (test(o)) uids.add(o.uid); });
      const vals = [...uids].map(u => rMap.get(u)).filter(v => v != null);
      const n = vals.length; const masked = n < 5; const low = !masked && n < 10;
      const value = masked ? null : Math.round((vals.reduce((a, b) => a + b, 0) / n) * 10) / 10;
      return { band: `${key}(${label})`, n_distinct: n, masked, lowConf: low, avgReach: value };
    });
    console.log(`\n## ${sub}${sub === 'seek' ? ` (median seek=${med})` : ''}`);
    console.table(rows);
  }
  console.log('\n(참고: realOnly=1 조회 시 이 데모 관측치(is_seed=1)는 제외 → 화면 다시 빔 = 정상)\n');
}

function plan() {
  const targets = resolveTargets();
  const { students, poolSize } = generateRows(targets);
  console.log('\n[demo-video] ===== PLAN (무쓰기) =====');
  console.log(`대상 반 ${targets.length} · 씨딩 학생 ${students.length}명(합집합) · 영상 풀 ${poolSize}개 · 학생당 ${VIDEOS_PER_STUDENT}개 → 관측치 ≈ ${students.length * VIDEOS_PER_STUDENT}`);
  console.table(targets.map(t => ({ classId: t.classId, name: t.name, grade: t.grade, students: t.studentIds.length })));
  console.log('씨딩 학생 ids:', students.join(', '), '(GT 고정계정 uid3·uid13 포함 — ucp 시드는 성취 무변경)');
  const cols = new Set(db.prepare('PRAGMA table_info(user_content_progress)').all().map(c => c.name));
  console.log('현재 컬럼:', [...cols].join(', '));
  console.log('(실 쓰기 없음. --apply 로 실행 — 마이그레이션 포함)');
}

// ─────────────────────────── main ───────────────────────────
function main() {
  if (!MODE) {
    console.log('Usage: node scripts/seed-demo-video.js [--apply | --clean | --stats | --plan] [--no-backup]');
    process.exit(1);
  }
  if (MODE === 'plan') plan();
  else if (MODE === 'stats') printStats();
  else if (MODE === 'clean') clean();
  else if (MODE === 'apply') apply();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { resolveTargets, generateRows, seedStudentIds, reachMap, DEMO_TAG, VIDEOS_PER_STUDENT };
