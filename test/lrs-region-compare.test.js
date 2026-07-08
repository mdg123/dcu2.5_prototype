// test/lrs-region-compare.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 관리자 "지역별 성취수준 비교" 통합 재편 (BE-1~7) — 계약·불변식 박제
//   기획서: 보고서/LRS_관리자_지역별성취비교_통합_기획서_v1.md §A-6·§B-2·§C-2·§0-4·§D
//   대상 엔드포인트:
//     (1) GET /api/lrs/stats/equity     → school_level·subject 파라미터 + availableSubjects·appliedXxx
//     (2) GET /api/lrs/stats/admin-kpi  → weeklyTrendByLevel(주×학교급)
//     (3) GET /api/lrs/weak-trend       → school_level·subject 파라미터 + availableSubjects
//
//   [§D 하네스 불변식]
//     INV-RC-1  equity subject!=all → units.avgScore 는 codeSet(subjectLabel 정규화) 로그로만 산출.
//               math-e·MAT·math 가 모두 'math'로 귀속(§0-4 제약 검증). availableSubjects.present 일관.
//     INV-RC-2  equity school_level!=all → crossLevelRegion===[]. 그 급 단위만 units 에 노출.
//     INV-RC-3  admin-kpi weeklyTrendByLevel 길이 8 · weeksAgo 7..0 · total===elem+mid+high.
//     INV-RC-4  weak-trend school_level!=all → userIds ⊂ 전체(studentCount 축소).
//               subject!=all → ranking 전 행 canonicalSubjectKey(subject)===요청(단일 교과).
//
// DB 격리: 실 DB → 임시 복사본(_setup). admin id=1. HTTP 하네스는 lrs-equity 와 동일 패턴.
//   결정적 검증: 고유 지역(RC_*)·고유 성취기준([RC-*])에 합성 학생을 삽입해 정확값을 박제하고
//   전체(실+합성) 응답 위에서 불변식을 교차 대조(거대·가변 실데이터에 무의존).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();
const mastery = require('../db/lrs-mastery');

const express = require('express');
const session = require('express-session');

const ADMIN = 1;
// 교과 필터(§0-4) 검증 — 초등 지역. math 3변형(math·math-e·MAT) 모두 90, korean 40.
const REGION_A = 'RC_초A';   // elementary · 10명 · math(90)×3변형 + korean(40)
// 학교급 필터 검증 — 중등 지역.
const REGION_M = 'RC_중M';   // middle · 10명 · math(70)
// weak-trend 교과 단일 검증 — 중등 합성 성취기준.
const REGION_MW = 'RC_중W';  // middle · 12명 · 성취기준 [RC-M-MATH]/[RC-M-KOR]
const CODE_MATH = '[RC-M-MATH]';
const CODE_KOR = '[RC-M-KOR]';

let server, baseUrl, tdb;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/lrs', require('../routes/lrs'));
  return app;
}
function req(path, userId) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/lrs' + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: userId ? { 'x-test-user': String(userId) } : {} },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j, raw: body }); });
      });
    r.on('error', reject); r.end();
  });
}

// 학생 1명(is_seed=0, region·level). 반환 uid.
function mkStudent(region, level, suffix) {
  return Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role, region, school_level) VALUES (?, ?, 'x', 'student', ?, ?)"
  ).run(`t_rc_${level}_${region}_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, `RC테스트${suffix}`, region, level).lastInsertRowid);
}

before(async () => {
  tdb = openTestDb();

  // 채점형 로그 삽입(임의 subject_code·score, 최근 30일창).
  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, activity_type, verb, source_service, subject_code, duration_sec, result_score, is_seed, created_at)
    VALUES (?, 'exam_complete', 'completed', 'content', ?, 300, ?, 0, datetime('now','localtime'))
  `);

  // ── REGION_A(초등) 10명: 각 math 3변형(90) + korean(40) ──
  //   subject=math → codeSet {math,math-e,MAT} IN → avg 90. subject=korean → 40. all → 77.5.
  for (let i = 0; i < 10; i++) {
    const uid = mkStudent(REGION_A, 'elementary', i);
    insLog.run(uid, 'math', 90);
    insLog.run(uid, 'math-e', 90);
    insLog.run(uid, 'MAT', 90);
    insLog.run(uid, 'korean', 40);
  }
  // ── REGION_M(중등) 10명: math(70) ──
  for (let i = 0; i < 10; i++) {
    const uid = mkStudent(REGION_M, 'middle', i);
    insLog.run(uid, 'math', 70);
  }

  // ── weak-trend 교과 단일 검증: 합성 성취기준(curriculum) + achievement_stats ──
  //   resolveCode 는 curriculum_standards(code→subject_code) 기반이라 코드 2종을 심어 급×교과 제어.
  //   subject_code 는 subjects(code) FK — 중등 접미 코드 사용(subjectLabel 이 '-m' 제거 후 매핑).
  const insCurr = tdb.prepare(
    "INSERT INTO curriculum_standards (code, subject_code, school_level, grade_group, area, content) VALUES (?, ?, 'middle', 7, ?, ?)"
  );
  insCurr.run(CODE_MATH, 'math-m', '수와 연산', 'RC 합성 수학 성취기준');
  insCurr.run(CODE_KOR, 'korean-m', '읽기', 'RC 합성 국어 성취기준');
  mastery.invalidateCache(); // 새 curriculum 반영(다음 resolveCode 재빌드)

  const insStat = tdb.prepare(`
    INSERT INTO lrs_achievement_stats
      (user_id, achievement_code, subject_code, attempt_count, success_count, avg_score, updated_at)
    VALUES (?, ?, ?, 5, ?, ?, datetime('now'))
  `);
  // 12명(중등): 각 [RC-M-MATH](5시도·2정답=40%·미도달) + [RC-M-KOR](5시도·1정답=20%·미도달).
  //   → 두 코드 모두 evaluated(attempts>=3), reachedRate 낮음 → 랭킹 상위(취약 우선).
  for (let i = 0; i < 12; i++) {
    const uid = mkStudent(REGION_MW, 'middle', `w${i}`);
    insStat.run(uid, CODE_MATH, 'math', 2, 40);
    insStat.run(uid, CODE_KOR, 'korean', 1, 20);
  }

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

async function fetchEquity(qs) {
  const r = await req('/stats/equity' + qs, ADMIN);
  assert.equal(r.status, 200, `equity 200 기대, got ${r.status}: ${r.raw}`);
  return r.json;
}
const findUnit = (j, id) => j.units.find(u => u.id === id);
const availOf = (j, key) => (j.availableSubjects || []).find(s => s.key === key);

// ──────────────────────────────────────────────────────────────────────────
// INV-RC-1: equity subject 필터 — codeSet(§0-4) 로만 avgScore 산출 + availableSubjects
// ──────────────────────────────────────────────────────────────────────────
test('INV-RC-1: equity subject=math 는 codeSet(math·math-e·MAT) 로그로만 avgScore 산출', async () => {
  const all = await fetchEquity('?dim=region&period=30d');
  const math = await fetchEquity('?dim=region&period=30d&subject=math');
  const kor = await fetchEquity('?dim=region&period=30d&subject=korean');

  const uAll = findUnit(all, REGION_A);
  const uMath = findUnit(math, REGION_A);
  const uKor = findUnit(kor, REGION_A);
  assert.ok(uAll && uMath && uKor, 'REGION_A 단위 존재(전체·math·korean)');

  // subject=math → math 3변형(90) 만 → 90.0 (math-e·MAT 도 'math' 로 귀속됨을 증명 = §0-4)
  assert.equal(uMath.avgScore, 90, `math avgScore=90 기대, got ${uMath.avgScore}`);
  // subject=korean → korean(40) 만 → 40.0
  assert.equal(uKor.avgScore, 40, `korean avgScore=40 기대, got ${uKor.avgScore}`);
  // subject=all → (90·90·90·40)/4 = 77.5 (필터 없으면 혼합)
  assert.equal(uAll.avgScore, 77.5, `all avgScore=77.5 기대, got ${uAll.avgScore}`);

  // availableSubjects — math·korean present=true, appliedSubjectLabel 정확
  assert.equal(availOf(math, 'math').present, true, 'math present');
  assert.equal(availOf(math, 'korean').present, true, 'korean present');
  assert.equal(math.appliedSubject, 'math');
  assert.equal(math.appliedSubjectLabel, '수학');
  assert.equal(all.appliedSubject, 'all');
  assert.equal(all.appliedSubjectLabel, null);
  // availableSubjects 순서·형태(10 canonical, {key,label,present})
  assert.equal(all.availableSubjects.length, 10, 'canonical 10교과');
  assert.deepEqual(all.availableSubjects.map(s => s.key),
    ['korean', 'math', 'english', 'science', 'social', 'moral', 'music', 'art', 'pe', 'practical']);
  all.availableSubjects.forEach(s => { assert.equal(typeof s.label, 'string'); assert.equal(typeof s.present, 'boolean'); });
});

test('INV-RC-1b: present 일관 — 데이터 없는 교과로 필터 시 그 단위 avgScore null', async () => {
  // REGION_A 는 math·korean 만 보유 → subject=science 면 REGION_A 채점 로그 0 → avgScore null.
  const sci = await fetchEquity('?dim=region&period=30d&subject=science');
  const uSci = findUnit(sci, REGION_A);
  assert.ok(uSci, 'REGION_A 단위(재학생 분모)는 여전히 존재');
  assert.equal(uSci.avgScore, null, 'science 로그 없는 REGION_A 는 avgScore null');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-RC-2: equity school_level 필터 — crossLevelRegion===[] · 급 스코프
// ──────────────────────────────────────────────────────────────────────────
test('INV-RC-2: school_level!=all → crossLevelRegion===[] · 그 급 단위만 units', async () => {
  const all = await fetchEquity('?dim=region&period=30d');
  const elem = await fetchEquity('?dim=region&period=30d&school_level=elementary');
  const mid = await fetchEquity('?dim=region&period=30d&school_level=middle');

  // 전체는 crossLevelRegion 비어있지 않음(초·중 존재)
  assert.ok(Array.isArray(all.crossLevelRegion) && all.crossLevelRegion.length >= 1, '전체 crossLevelRegion 존재');
  // 급 지정 시 [] (기획서 §A-6)
  assert.deepEqual(elem.crossLevelRegion, [], 'elementary crossLevelRegion===[]');
  assert.deepEqual(mid.crossLevelRegion, [], 'middle crossLevelRegion===[]');

  // appliedLevel/Label
  assert.equal(elem.appliedLevel, 'elementary');
  assert.equal(elem.appliedLevelLabel, '초등학교');
  assert.equal(all.appliedLevel, 'all');
  assert.equal(all.appliedLevelLabel, null);

  // 급 스코프: elementary 응답엔 REGION_A(초) 있고 REGION_M(중) 없음. middle 은 반대.
  assert.ok(findUnit(elem, REGION_A), 'elementary 에 REGION_A(초) 존재');
  assert.equal(findUnit(elem, REGION_M), undefined, 'elementary 에 REGION_M(중) 없음');
  assert.ok(findUnit(mid, REGION_M), 'middle 에 REGION_M(중) 존재');
  assert.equal(findUnit(mid, REGION_A), undefined, 'middle 에 REGION_A(초) 없음');
  // 급 스코프에서 REGION_M avgScore=70(math 70)
  assert.equal(findUnit(mid, REGION_M).avgScore, 70, 'REGION_M avgScore=70');
});

test('INV-RC-2b: 잘못된 school_level/subject → 400', async () => {
  const r1 = await req('/stats/equity?dim=region&school_level=college', ADMIN);
  assert.equal(r1.status, 400, 'school_level 오류 400');
  const r2 = await req('/stats/equity?dim=region&subject=coding', ADMIN);
  assert.equal(r2.status, 400, 'subject 오류 400');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-RC-3: admin-kpi weeklyTrendByLevel — 8주 · total===초+중+고+무학년
//   [2026-07 정합 개편] 활동 카운트가 학생×학습활동 7종 스코프로 통일되며 weeklyTrend 와
//   weeklyTrendByLevel 을 단일 소스로 산출. total 은 무학년(unleveled)까지 포함해
//   weeklyTrend.count 과 정확히 일치해야 한다(같은 스코프). 초·중·고 3선 + unleveled 각주.
// ──────────────────────────────────────────────────────────────────────────
test('INV-RC-3: admin-kpi weeklyTrendByLevel 길이8 · weeksAgo 7..0 · total===elem+mid+high+unleveled === weeklyTrend.count', async () => {
  const r = await req('/stats/admin-kpi?period=30d', ADMIN);
  assert.equal(r.status, 200, `admin-kpi 200, got ${r.status}: ${r.raw}`);
  const w = r.json.weeklyTrendByLevel;
  const wt = r.json.weeklyTrend;
  assert.ok(Array.isArray(w) && w.length === 8, `weeklyTrendByLevel 길이 8, got ${w && w.length}`);
  // 기존 weeklyTrend 하위호환 유지
  assert.ok(Array.isArray(wt) && wt.length === 8, 'weeklyTrend 하위호환');
  for (let i = 0; i < 8; i++) {
    const e = w[i];
    assert.equal(e.weeksAgo, 7 - i, `weeksAgo 순서(오래된→최근): idx${i} 기대 ${7 - i}`);
    ['total', 'elementary', 'middle', 'high', 'unleveled'].forEach(k => {
      assert.ok(Number.isInteger(e[k]) && e[k] >= 0, `${k} 음이 아닌 정수`);
    });
    assert.equal(e.total, e.elementary + e.middle + e.high + e.unleveled,
      `total===초+중+고+무학년 (weeksAgo ${e.weeksAgo})`);
    // 단일 소스 정합: weeklyTrend.count === weeklyTrendByLevel.total (같은 스코프).
    assert.equal(wt[i].count, e.total, `weeklyTrend.count===byLevel.total (weeksAgo ${e.weeksAgo})`);
  }
  // 합성 데이터(오늘 생성)는 weeksAgo 0 버킷 → elementary·middle > 0 이어야
  const now = w[7];
  assert.ok(now.elementary > 0, `이번주 elementary>0 (REGION_A 합성), got ${now.elementary}`);
  assert.ok(now.middle > 0, `이번주 middle>0 (REGION_M 합성), got ${now.middle}`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-RC-4: weak-trend school_level(축소)·subject(단일 교과)
// ──────────────────────────────────────────────────────────────────────────
test('INV-RC-4a: weak-trend school_level=middle → studentCount ⊂ 전체', async () => {
  const all = await req('/weak-trend?scope=all&limit=50', ADMIN);
  const mid = await req('/weak-trend?scope=all&limit=50&school_level=middle', ADMIN);
  assert.equal(all.status, 200); assert.equal(mid.status, 200);
  assert.ok(mid.json.studentCount > 0, 'middle 학생 존재(합성 12명+)');
  assert.ok(mid.json.studentCount <= all.json.studentCount, 'middle ⊂ 전체(studentCount 축소)');
  assert.ok(mid.json.studentCount >= 12, `합성 중등 12명 이상, got ${mid.json.studentCount}`);
  assert.equal(mid.json.appliedLevel, 'middle');
  assert.equal(mid.json.appliedLevelLabel, '중학교');
  assert.ok(Array.isArray(mid.json.availableSubjects), 'availableSubjects 배열');
});

test('INV-RC-4b: weak-trend subject=math → 반환 ranking 전 행이 단일 교과(math)', async () => {
  // ※ 라우트는 limit≤50 캡. 합성 코드는 실데이터 176명에 밀려 top-50 창 밖(랭킹 73위)일 수 있으므로
  //   "합성 코드가 top-N에 있다"에 의존하지 않고, 필터의 핵심 불변식(단일 교과화)을 검증한다.
  const mid = await req('/weak-trend?scope=all&limit=50&school_level=middle', ADMIN);
  const midMath = await req('/weak-trend?scope=all&limit=50&school_level=middle&subject=math', ADMIN);
  assert.equal(mid.status, 200); assert.equal(midMath.status, 200);

  // canonical 역매핑 미러(라우트 canonicalSubjectKey 와 동일 상수).
  const SUBJ_TO_KEY = { '국어': 'korean', '수학': 'math', '영어': 'english', '과학': 'science',
    '사회': 'social', '도덕': 'moral', '음악': 'music', '예술': 'art', '예술/미술': 'art', '미술': 'art',
    '체육': 'pe', '실과': 'practical' };
  const keyOf = (row) => SUBJ_TO_KEY[String(row.subject || '').trim()] || null;

  // 필터 전: 여러 교과가 섞여 있음(수학 + 비수학 최소 1개) — 필터가 좁힐 대상이 실제로 존재.
  const midKeys = new Set(mid.json.ranking.map(keyOf));
  assert.ok(midKeys.has('math'), '필터 전 ranking 에 수학 행 존재');
  assert.ok([...midKeys].some(k => k && k !== 'math'), '필터 전 ranking 에 비수학 교과도 존재(좁힐 대상 있음)');

  // ★ 핵심 불변식: subject=math 결과의 전 행이 단일 교과(math) — 비수학 0건.
  assert.ok(midMath.json.ranking.length > 0, 'subject=math ranking 비어있지 않음');
  for (const row of midMath.json.ranking) {
    assert.equal(keyOf(row), 'math', `subject=math 인데 '${row.subject}'(${row.code}) 가 수학 아님`);
  }
  assert.deepEqual([...new Set(midMath.json.ranking.map(keyOf))], ['math'], 'subject=math 결과는 단일 교과(math)뿐');

  // 결정적 제거 증명: 필터 전 랭킹의 임의 비수학 코드는 필터 후 랭킹에서 반드시 사라진다.
  const nonMath = mid.json.ranking.find(r => keyOf(r) && keyOf(r) !== 'math');
  assert.ok(nonMath, '비수학 코드 표본 존재');
  assert.ok(!midMath.json.ranking.some(r => r.code === nonMath.code),
    `비수학 코드 ${nonMath.code}(${nonMath.subject}) 가 subject=math 결과에서 제거됨`);

  assert.equal(midMath.json.appliedSubject, 'math');
  assert.equal(midMath.json.appliedSubjectLabel, '수학');
  // availableSubjects present: 현재 급 스코프에 수학·국어 로그 존재 → present=true.
  const av = (k) => midMath.json.availableSubjects.find(s => s.key === k);
  assert.equal(av('math').present, true, 'math present');
  assert.equal(av('korean').present, true, 'korean present');
});

test('INV-RC-4c: weak-trend 잘못된 파라미터 → 400', async () => {
  const r1 = await req('/weak-trend?scope=all&school_level=univ', ADMIN);
  assert.equal(r1.status, 400, 'school_level 오류 400');
  const r2 = await req('/weak-trend?scope=all&subject=coding', ADMIN);
  assert.equal(r2.status, 400, 'subject 오류 400');
});
