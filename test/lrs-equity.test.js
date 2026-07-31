// test/lrs-equity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 관리자 P1 — 교육 격차 모니터링(형평성) BE 계약·불변식 박제
//   기획서: 보고서/LRS_관리자_효용제고_격차모니터링_신뢰도_기획서_v1.md §T1-1 ~ §T1-7
//   대상 엔드포인트: GET /api/lrs/stats/equity  (macro-drill 집계 재사용)
//
//   INV-E1  계약 필드 — units/metrics/trend/priorityUnits/excludedMasked/minSample=10
//   INV-E2  격차(gapPP) = top.v − bottom.v (부호·값). avgScore·activeRate·reachRate.
//   INV-E3  actsPerStu.gapX = top.v / bottom.v (배수). gapPP 없음(활동량은 배수 규약).
//   INV-E4  CV ≥ 0, bottom20Ratio 0~100(모든 지표).
//   INV-E5  마스킹 — students<10 단위는 masked=true·값 null·지표 분모 제외.
//           excludedMasked 카운트 == masked 단위 수. metrics.top/bottom 에 마스킹 단위 미포함.
//   INV-E6  사분면 — both_low 는 활용(avgActsPerStudent)·성취(avgScore) 둘 다 중앙값 이하.
//           priorityUnits == quadrant==='both_low' 단위(활용·성취 값 포함).
//   INV-E7  trend — points 3개(최근/직전/직전전), 각 gapPP 는 그 구간 avgScore top−bottom.
//   INV-E8  권한 — 학생·교사 403, admin 200. 잘못된 dim 400.
//   INV-E9  reachRate(v1 간이) = 개인 avg_score≥60 학생수 / 재학생수 ×100 (단위별 SQL 미러).
//
// DB 격리: 실 DB → 임시 복사본(_setup). HTTP 하네스는 lrs-reliability-p0 와 동일 패턴.
//   결정적 검증을 위해 고유 region('T_격차구역')에 학생 6명을 합성 삽입해 정확값을 박제하고,
//   전체(실+합성) 응답 위에서 격차·마스킹·사분면 불변식을 교차 대조한다.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb, fixtureWindow } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const ADMIN = 1;
const REGION_A = 'T_격차상위';   // 합성 지역 A(성취 高·활동 多) — 표본충족
const REGION_B = 'T_격차하위';   // 합성 지역 B(성취 低·활동 少) — 표본충족·이중취약 후보
const REGION_MASK = 'T_격차소표'; // 합성 지역 C(학생 6명 < 10) — 마스킹 대상

let server, baseUrl, tdb;
let studentId, teacherId, EQUITY_GT_Q;

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

// 학생 1명 생성(is_seed=0, 지정 region). 반환: uid
function mkStudent(region, suffix) {
  return Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role, region, school_level) VALUES (?, ?, 'x', 'student', ?, 'elementary')"
  ).run(`t_eq_${region}_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, `격차테스트${suffix}`, region).lastInsertRowid);
}

before(async () => {
  tdb = openTestDb();

  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, activity_type, verb, source_service, subject_code, duration_sec, result_score, is_seed, created_at)
    VALUES (?, 'exam_complete', 'completed', 'content', 'math', ?, ?, 0, datetime('now','localtime'))
  `);
  // 학생별 채점형 로그 n건 삽입(모두 최근 30일창). result_score 0~100.
  function seedStudent(region, suffix, nActs, score) {
    const uid = mkStudent(region, suffix);
    for (let i = 0; i < nActs; i++) insLog.run(uid, 300, score); // 300초=5분/act
    return uid;
  }

  // ── REGION_A: 학생 10명, 각 20 acts, score=90 → avgScore≈90·avgActs=20·reach=100% ──
  for (let i = 0; i < 10; i++) seedStudent(REGION_A, i, 20, 90);
  // ── REGION_B: 학생 10명, 각 1 act, score=50 → avgScore≈50·avgActs=1·reach=0% ──
  //   견고화: 실 지역 avgActs 중앙값(30일창·시드 노후화로 3.2~4 부근 변동)보다 B가 확실히 낮아야
  //   both_low(활용 중앙값 이하)가 시점 독립적으로 성립. 4→1(실 최소보다도 낮게)로 마진 확보.
  for (let i = 0; i < 10; i++) seedStudent(REGION_B, i, 1, 50);
  // ── REGION_MASK: 학생 6명(<10) → 마스킹. 값 있어도 units 에서 null·지표 제외 ──
  for (let i = 0; i < 6; i++) seedStudent(REGION_MASK, i, 30, 99);

  // 권한 테스트용 계정
  studentId = Number(tdb.prepare("SELECT id FROM users WHERE role='student' ORDER BY id LIMIT 1").get().id);
  const t = tdb.prepare("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1").get();
  teacherId = t ? Number(t.id)
    : Number(tdb.prepare("INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', 'teacher')").run(`t_eq_tch_${Date.now()}`, '격차교사').lastInsertRowid);

  // ── EQUITY_GT_Q: INV-E3·E5b 용 시계 독립 창 (2026-07-30 시한폭탄 fix) ──────
  //   두 테스트는 합성 지역(A/B)을 **실 지역들과 상대 비교**한다(gapX=top/bottom,
  //   quadrant=중앙값 대비). 합성 시드는 now 기준이라 자가갱신이지만 **실 지역 활동량은
  //   실 DB 고정분**이고 로그가 2026-07-16 에서 멈춰 있어, 롤링 30일 창은 2026-08-16 부터
  //   실 지역이 전부 0 활동이 된다 → bottom.v=0(gapX null)·B 사분면 뒤집힘으로 붕괴.
  //   (카나리아 45일에서 정확히 재현: gapX object·quadrant ach_low)
  //   ★ 시드 INSERT 이후에 계산 — 창이 실 고정분 + now 시드를 모두 덮어야 한다.
  //   ※ /stats/equity 는 macroDays(routes/lrs.js L5495)로 **period=Nd 만** 해석한다
  //     (from/to 미지원 → 넘겨도 무시되고 기본 30일로 떨어진다). 그래서 창을 "데이터 전
  //     구간을 덮는 일수"로 유도한다. 어느 날 돌려도 포함 행 집합은 항상 전체 = 결정적.
  {
    const w = fixtureWindow(tdb);
    const spanDays = Math.ceil((Date.now() - new Date(`${w.from}T00:00:00Z`).getTime()) / 86400000) + 1;
    assert.ok(spanDays <= 365,
      `equity 창(${spanDays}일)이 라우트 상한 365일 초과 — 가장 오래된 로그(${w.from})가 범위 밖. GT 재설계 필요`);
    EQUITY_GT_Q = `period=${spanDays}d`;
  }

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// 편의: region dim 30일 응답 + 합성 단위 추출
async function fetchEquity(qs = '?dim=region&period=30d') {
  const r = await req('/stats/equity' + qs, ADMIN);
  assert.equal(r.status, 200, `200 기대, got ${r.status}: ${r.raw}`);
  return r.json;
}
const findUnit = (j, id) => j.units.find(u => u.id === id);

// ──────────────────────────────────────────────────────────────────────────
// INV-E1: 계약 필드 존재/형태
// ──────────────────────────────────────────────────────────────────────────
test('INV-E1: 계약 필드 — units/metrics/trend/priorityUnits/excludedMasked/minSample', async () => {
  const j = await fetchEquity();
  assert.equal(j.success, true);
  assert.equal(j.dim, 'region');
  assert.equal(j.period, '30d');
  assert.equal(j.minSample, 10);
  assert.ok(Array.isArray(j.units) && j.units.length >= 3, 'units 배열');
  assert.equal(typeof j.excludedMasked, 'number', 'excludedMasked 숫자');
  for (const m of ['activeRate', 'avgScore', 'actsPerStu', 'groupReachedRate', 'avgOver60Rate']) {
    assert.ok(j.metrics[m], `metrics.${m} 존재`);
  }
  assert.equal(j.trend.metric, 'avgScore');
  assert.ok(Array.isArray(j.trend.points) && j.trend.points.length === 3, 'trend 3점');
  assert.ok(Array.isArray(j.priorityUnits), 'priorityUnits 배열');
  // 합성 단위가 응답에 포함
  assert.ok(findUnit(j, REGION_A) && findUnit(j, REGION_B) && findUnit(j, REGION_MASK), '합성 3지역 포함');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E2: 격차(gapPP) = top.v − bottom.v (부호·값). %p 지표.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E2: gapPP === top.v − bottom.v (avgScore·activeRate·reachRate)', async () => {
  const j = await fetchEquity();
  for (const m of ['avgScore', 'activeRate', 'groupReachedRate', 'avgOver60Rate']) {
    const mm = j.metrics[m];
    assert.equal(typeof mm.gapPP, 'number', `${m}.gapPP 숫자`);
    assert.ok(mm.top && mm.bottom, `${m} top/bottom 존재`);
    const expect = Math.round((mm.top.v - mm.bottom.v) * 10) / 10;
    assert.equal(mm.gapPP, expect, `${m}: gapPP(${mm.gapPP}) === top−bottom(${expect})`);
    assert.ok(mm.gapPP >= 0, `${m}: gapPP ≥ 0 (top≥bottom)`);
    assert.ok(mm.top.v >= mm.bottom.v, `${m}: top.v ≥ bottom.v`);
    // %p 지표에는 gapX 없음(규약)
    assert.equal(mm.gapX, undefined, `${m}: %p 지표는 gapX 없음`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E3: actsPerStu 는 배수(gapX = top/bottom), gapPP 없음.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E3: actsPerStu.gapX === top.v / bottom.v (배수), gapPP 없음', async () => {
  // 실 지역과의 상대 비교라 롤링 창이면 시간이 지나 bottom.v=0 → gapX null 붕괴. 창 결정화.
  const j = await fetchEquity(`?dim=region&${EQUITY_GT_Q}`);
  const m = j.metrics.actsPerStu;
  assert.equal(typeof m.gapX, 'number', 'actsPerStu.gapX 숫자');
  assert.equal(m.gapPP, undefined, 'actsPerStu 는 gapPP 없음(배수 규약)');
  assert.ok(m.bottom.v > 0, '전제: bottom 활동량 > 0');
  const expect = Math.round((m.top.v / m.bottom.v) * 10) / 10;
  assert.equal(m.gapX, expect, `gapX(${m.gapX}) === top/bottom(${expect})`);
  assert.ok(m.gapX >= 1, 'gapX ≥ 1 (top≥bottom)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E4: CV ≥ 0, bottom20Ratio 0~100 (모든 4지표).
// ──────────────────────────────────────────────────────────────────────────
test('INV-E4: CV ≥ 0 · bottom20Ratio 0~100 (전 지표)', async () => {
  const j = await fetchEquity();
  for (const m of ['activeRate', 'avgScore', 'actsPerStu', 'groupReachedRate', 'avgOver60Rate']) {
    const mm = j.metrics[m];
    assert.ok(mm.cv >= 0, `${m}: cv ≥ 0 (got ${mm.cv})`);
    assert.ok(mm.bottom20Ratio >= 0 && mm.bottom20Ratio <= 100, `${m}: bottom20Ratio 0~100 (got ${mm.bottom20Ratio})`);
    assert.ok(mm.iqr >= 0, `${m}: iqr ≥ 0`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E5: 마스킹 — students<10 단위는 masked=true·값 null·지표 top/bottom 미포함.
//   excludedMasked == masked 단위 수.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E5: 마스킹 — <10 단위 값 null·지표 제외·excludedMasked 카운트 일치', async () => {
  const j = await fetchEquity();
  const mask = findUnit(j, REGION_MASK);
  assert.ok(mask, '마스킹 지역 units 에 포함');
  assert.equal(mask.students, 6, '학생 6명(<10)');
  assert.equal(mask.masked, true, 'masked=true');
  for (const f of ['activeRate', 'avgActsPerStudent', 'avgLearnMin', 'avgScore', 'groupReachedRate', 'avgOver60Rate']) {
    assert.equal(mask[f], null, `마스킹 단위 ${f}=null`);
  }
  assert.equal(mask.quadrant, null, '마스킹 단위 quadrant=null');

  // excludedMasked == 실제 masked 단위 수
  const maskedCount = j.units.filter(u => u.masked).length;
  assert.equal(j.excludedMasked, maskedCount, `excludedMasked(${j.excludedMasked}) == masked 단위 수(${maskedCount})`);

  // 지표 top/bottom 에 마스킹 단위 id 가 절대 등장하지 않음(분모 제외 증거)
  const maskedIds = new Set(j.units.filter(u => u.masked).map(u => u.id));
  for (const m of ['activeRate', 'avgScore', 'actsPerStu', 'groupReachedRate', 'avgOver60Rate']) {
    const mm = j.metrics[m];
    assert.ok(!maskedIds.has(mm.top.id), `${m}.top 은 마스킹 단위 아님`);
    assert.ok(!maskedIds.has(mm.bottom.id), `${m}.bottom 은 마스킹 단위 아님`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E5b: 합성 표본충족 단위의 값 정확성(결정적 박제).
//   REGION_A: 각 학생 20 acts·score90 → avgActs=20·avgScore≈90·reach=100.
//   REGION_B: 각 학생 1 act·score50  → avgActs=1·avgScore≈50·reach=0.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E5b: 합성 지역 값 정확 — avgActs/avgScore/reachRate 결정적', async () => {
  // b.quadrant 는 실 지역 중앙값 대비 판정 → 롤링 창이면 실 지역 0활동으로 뒤집힌다. 창 결정화.
  const j = await fetchEquity(`?dim=region&${EQUITY_GT_Q}`);
  const a = findUnit(j, REGION_A), b = findUnit(j, REGION_B);
  assert.equal(a.masked, false); assert.equal(b.masked, false);
  assert.equal(a.students, 10); assert.equal(b.students, 10);
  assert.equal(a.avgActsPerStudent, 20, 'A 1인당 활동=20');
  assert.equal(b.avgActsPerStudent, 1, 'B 1인당 활동=1');
  assert.equal(a.avgScore, 90, 'A 평균성취=90');
  assert.equal(b.avgScore, 50, 'B 평균성취=50');
  // [W2-b 6-1] 구 reachRate 는 '평균 60점 이상 학생 비율'(avgOver60Rate)로 개명·분모 교정됐다.
  //   분모가 '재적 전수' → '채점 기록 보유 학생'이라 합성 지역(전원 채점 로그 보유)에선 값이 같다.
  assert.equal(a.reachRate, undefined, "폐기된 'reachRate' 키가 남아 있으면 안 된다(뜻이 다른 도달률 2개 금지)");
  assert.equal(a.avgOver60Rate, 100, 'A 평균 60점 이상 학생 비율=100(전원 ≥60)');
  assert.equal(b.avgOver60Rate, 0, 'B 평균 60점 이상 학생 비율=0(전원 <60)');
  assert.equal(a.scoredStudents, 10, 'A 채점 기록 보유 학생 10명(분모 노출)');
  assert.equal(b.scoredStudents, 10, 'B 채점 기록 보유 학생 10명(분모 노출)');
  // A 는 활용·성취 모두 최상위권 → good, B 는 하위권 → both_low 후보
  assert.equal(b.quadrant, 'both_low', 'B 는 이중취약(both_low)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E6: 사분면 — both_low 는 활용·성취 둘 다 중앙값 이하.
//   priorityUnits == quadrant==='both_low'.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E6: both_low 는 활용·성취 둘 다 중앙값 이하 + priorityUnits 일치', async () => {
  const j = await fetchEquity();
  const ok = j.units.filter(u => !u.masked && u.avgScore != null && u.avgActsPerStudent != null);
  // 중앙값 재계산(선형보간과 무관하게 both_low 판정은 "≤ 중앙값" 이므로 정렬 중앙 기준으로 검증)
  const actsSorted = ok.map(u => u.avgActsPerStudent).sort((x, y) => x - y);
  const scoreSorted = ok.map(u => u.avgScore).sort((x, y) => x - y);
  const pctile = (arr, p) => {
    if (!arr.length) return null;
    if (arr.length === 1) return arr[0];
    const idx = p * (arr.length - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
  };
  const medActs = pctile(actsSorted, 0.5), medScore = pctile(scoreSorted, 0.5);
  for (const u of ok) {
    if (u.quadrant === 'both_low') {
      assert.ok(u.avgActsPerStudent <= medActs, `${u.id}: both_low → 활용 ≤ 중앙값(${u.avgActsPerStudent}≤${medActs})`);
      assert.ok(u.avgScore <= medScore, `${u.id}: both_low → 성취 ≤ 중앙값(${u.avgScore}≤${medScore})`);
    }
  }
  // priorityUnits == both_low 단위 id 집합
  const bothLowIds = new Set(ok.filter(u => u.quadrant === 'both_low').map(u => u.id));
  const priIds = new Set(j.priorityUnits.map(u => u.id));
  assert.deepEqual([...priIds].sort(), [...bothLowIds].sort(), 'priorityUnits == both_low 단위');
  // priorityUnits 각 항목에 활용·성취 값 포함
  for (const p of j.priorityUnits) {
    assert.equal(typeof p.avgActsPerStudent, 'number', `${p.id} priorityUnit 에 활용값`);
    assert.equal(typeof p.avgScore, 'number', `${p.id} priorityUnit 에 성취값`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E7: trend — 3점(최근/직전/직전전), 각 gapPP 는 그 구간 avgScore top−bottom.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E7: trend 3점 — 각 점 gapPP 는 숫자 또는 masked, 최근점 == metrics.avgScore.gapPP', async () => {
  const j = await fetchEquity();
  const pts = j.trend.points;
  assert.equal(pts.length, 3);
  for (const p of pts) {
    assert.equal(typeof p.periodLabel, 'string', 'periodLabel 문자열');
    assert.equal(typeof p.masked, 'boolean', 'masked 불리언');
    if (p.masked) assert.equal(p.gapPP, null, '표본부족 구간 gapPP null');
    else assert.ok(typeof p.gapPP === 'number' && p.gapPP >= 0, 'gapPP ≥ 0 숫자');
  }
  // 최근 구간 == metrics.avgScore.gapPP (같은 최근 days 창)
  const last = pts[2]; // 최근 days
  assert.equal(last.masked, false, '최근 구간 표본충족');
  assert.equal(last.gapPP, j.metrics.avgScore.gapPP, '최근 trend gapPP == metrics.avgScore.gapPP');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E8: 권한 — 학생·교사 403, admin 200, 잘못된 dim 400.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E8: 권한 — 학생·교사 403, admin 200, dim 오류 400', async () => {
  const rs = await req('/stats/equity?dim=region', studentId);
  assert.equal(rs.status, 403, '학생 → 403');
  const rt = await req('/stats/equity?dim=region', teacherId);
  assert.equal(rt.status, 403, '교사 → 403');
  const ra = await req('/stats/equity?dim=region', ADMIN);
  assert.equal(ra.status, 200, 'admin → 200');
  const rbad = await req('/stats/equity?dim=grade', ADMIN);
  assert.equal(rbad.status, 400, '잘못된 dim → 400');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E9(W2-b 개정): '평균 60점 이상 학생 비율' SQL 미러 — 분모는 **채점 기록 보유 학생**.
//   구 정의(분모=재적 전수)는 정본사전 §1-A-2 로 폐기됐다. 폐기 근거:
//     분자 서브쿼리가 INNER JOIN + HAVING uavg IS NOT NULL 이라 채점 로그 0건 학생은 분자에
//     절대 못 들어가는데 분모는 로그 유무 무관 전수 → 수학적으로 `값 ≤ 채점 데이터 보유율`.
//     즉 성취가 아니라 커버리지를 재던 지표였고, 교과 필터가 분자에만 걸려 교과를 좁히면 붕괴했다.
//   → 분자·분모를 같은 모집단으로 맞춘다(교과 필터도 분자·분모 동시 적용).
// ──────────────────────────────────────────────────────────────────────────
test('INV-E9: avgOver60Rate 분모 = 채점 기록 보유 학생(재적 전수 아님) — SQL 미러', async () => {
  const j = await fetchEquity();
  const SCORED = "'exam_complete','homework_submit','content_solve','self_learn','daily_complete','wrong_note_retry','node_complete','content_complete','problem_attempt'";
  const norm = '(CASE WHEN ll.result_score <= 1 THEN ll.result_score*100 ELSE ll.result_score END)';
  for (const region of [REGION_A, REGION_B]) {
    const u = findUnit(j, region);
    const row = tdb.prepare(`
      SELECT COUNT(*) scored, SUM(CASE WHEN uavg >= 60 THEN 1 ELSE 0 END) reached
      FROM (
        SELECT u.id uid, AVG(CASE WHEN ll.activity_type IN (${SCORED}) THEN ${norm} END) uavg
        FROM users u JOIN learning_logs ll ON ll.user_id = u.id
        WHERE u.role='student' AND u.region = ?
          AND DATE(ll.created_at) >= DATE('now','localtime','-29 days')
        GROUP BY u.id HAVING uavg IS NOT NULL
      )
    `).get(region);
    const reached = row.reached || 0, scored = row.scored || 0;
    const expect = scored > 0 ? Math.round((reached / scored) * 1000) / 10 : null;
    assert.equal(u.scoredStudents, scored, `${region}: scoredStudents(분모) 노출 일치`);
    assert.equal(u.avgOver60Rate, expect, `${region}: avgOver60Rate(${u.avgOver60Rate}) == reached/scored(${expect})`);
    // 폐기 계약: '도달률' 의미 필드는 groupReachedRate(A3) 하나뿐이어야 한다.
    assert.equal(u.reachRate, undefined, `${region}: 폐기된 reachRate 키 잔존 금지`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-E10: school_level dim — 라벨 한글화(초/중/고), 계약 유지.
// ──────────────────────────────────────────────────────────────────────────
test('INV-E10: dim=school_level — 라벨 한글·계약 유지', async () => {
  const j = await fetchEquity('?dim=school_level&period=90d');
  assert.equal(j.dim, 'school_level');
  assert.equal(j.period, '90d');
  const labels = j.units.map(u => u.label);
  // elementary→초등학교 등 라벨 매핑(levelLabel) 적용 확인(합성 학생이 elementary)
  assert.ok(labels.includes('초등학교'), '초등학교 라벨 존재');
  // 지표·trend 구조 동일
  assert.equal(typeof j.metrics.avgScore.gapPP, 'number');
  assert.equal(j.trend.points.length, 3);
});
