// test/lrs-equity-p2.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 관리자 P2 심화(BE) — a-equity 학교급×지역 교차 + a-quality 세션 커버리지 정식화
//   기획서: 보고서/LRS_관리자_효용제고_격차모니터링_신뢰도_기획서_v1.md §P2
//   대상 엔드포인트:
//     (1) GET /api/lrs/stats/equity      → crossLevelRegion 필드 추가(항상 반환)
//     (2) GET /api/lrs/dataset-coverage  → session_coverage_rate·denominators.session 추가
//
//   [crossLevelRegion]
//     INV-P2-1  crossLevelRegion 배열 존재 — dim 무관 항상. 순서 elementary→middle→high.
//     INV-P2-2  각 행 regionGapPP === top.v − bottom.v (표본충족 셀 중 최상위−최하위 %p).
//     INV-P2-3  마스킹 — students<10 셀은 masked·avgScore null·격차/top/bottom 산정 제외.
//     INV-P2-4  cells 평균성취 내림차순(표본충족 먼저, 성취null 뒤로).
//     INV-P2-5  levelLabel 한글(초/중/고), level 코드 동봉.
//
//   [session_coverage_rate]
//     INV-P2-6  세션 의미 유형 분모 한정 — 조회(content_view) 로그가 분모에 안 섞임.
//     INV-P2-7  session_coverage_rate 0~100 · denominators.session 정합 · = filled/denom.
//     INV-P2-8  커버리지(양의 지표) — session_id 채운 비율(결측률 아님). missing_session_rate 계속 미제공.
//     INV-P2-9  권한/계약 회귀 유지.
//
// DB 격리: 실 DB → 임시 복사본(_setup). admin id=1. HTTP 하네스 동일 패턴.
//   결정적 검증: 고유 학교급×지역 셀(합성 학생) + 고유 서비스(세션 대조)로 격리 삽입해
//   거대·가변 실데이터에 무의존한 정확값 박제. 전체 응답 위에서 불변식 교차 대조.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const ADMIN = 1;
// 학교급×지역 교차 합성 셀 — 고유 지역명(실데이터와 충돌 없게).
// 초등: 두 지역(격차 산정 가능). 중등: 마스킹 셀 포함(표본부족). 고등: 한 지역만(격차 미산정).
const R_E_HI = 'P2_초상위';   // elementary · 성취 高 · 10명(표본충족)
const R_E_LO = 'P2_초하위';   // elementary · 성취 低 · 10명(표본충족)
const R_M_OK = 'P2_중충족';   // middle · 10명(표본충족)
const R_M_MASK = 'P2_중소표'; // middle · 6명(<10, 마스킹)
const R_H_ONLY = 'P2_고단독'; // high · 10명(표본충족·단독 → 격차 null)

const SVC_SESS = 't_p2_sess';  // 세션 커버리지 격리 대조 전용 서비스

let server, baseUrl, tdb, studentId, teacherId, synthUid;

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

// 학생 1명(is_seed=0, 지정 region·school_level). 반환 uid.
function mkStudent(region, level, suffix) {
  return Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role, region, school_level) VALUES (?, ?, 'x', 'student', ?, ?)"
  ).run(`t_p2_${level}_${region}_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, `P2테스트${suffix}`, region, level).lastInsertRowid);
}

before(async () => {
  tdb = openTestDb();

  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, activity_type, verb, source_service, subject_code, duration_sec, result_score, is_seed, created_at)
    VALUES (?, 'exam_complete', 'completed', 'content', 'math', 300, ?, 0, datetime('now','localtime'))
  `);
  // 학교급×지역 셀 시딩: n명 학생, 각 1건 채점형(score) → 셀 평균성취≈score.
  function seedCell(region, level, n, score) {
    for (let i = 0; i < n; i++) {
      const uid = mkStudent(region, level, i);
      insLog.run(uid, score);
    }
  }
  // ── 초등: 상위(90)·하위(50) 각 10명 → 초등 지역격차 ≈ 40%p ──
  seedCell(R_E_HI, 'elementary', 10, 90);
  seedCell(R_E_LO, 'elementary', 10, 50);
  // ── 중등: 충족(80) 10명 + 소표본(99) 6명 → 마스킹 셀 격차 산정 제외 ──
  seedCell(R_M_OK, 'middle', 10, 80);
  seedCell(R_M_MASK, 'middle', 6, 99);
  // ── 고등: 단독(70) 10명 → 표본충족 셀 1개뿐 → 격차 null(2개 미만) ──
  seedCell(R_H_ONLY, 'high', 10, 70);

  // ── 세션 커버리지 격리 서비스 SVC_SESS ─────────────────────────────────────
  //   세션 의미 유형(exam_complete 등) 6건 중 4건 session_id 채움·2건 NULL → coverage 4/6.
  //   조회(content_view) 5건 — session_id 유무 무관, 세션 분모에서 제외되어야 함.
  synthUid = Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', 'student')"
  ).run(`t_p2_sess_${Date.now()}`, 'P2세션테스트').lastInsertRowid);
  const insSess = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, source_service, session_id, is_seed, created_at)
    VALUES (?, ?, 'completed', ?, ?, 0, datetime('now'))
  `);
  // 세션 의미 유형 6건: 4채움·2결측
  insSess.run(synthUid, 'exam_complete', SVC_SESS, 'sid-1');
  insSess.run(synthUid, 'exam_complete', SVC_SESS, 'sid-2');
  insSess.run(synthUid, 'homework_submit', SVC_SESS, 'sid-3');
  insSess.run(synthUid, 'self_learn', SVC_SESS, 'sid-4');
  insSess.run(synthUid, 'exam_complete', SVC_SESS, null);   // 결측
  insSess.run(synthUid, 'self_learn', SVC_SESS, '   ');      // 공백 → 결측 취급
  // 조회 5건(세션 분모 아님) — session_id 있어도 무시돼야 함
  for (let i = 0; i < 5; i++) insSess.run(synthUid, 'content_view', SVC_SESS, `view-sid-${i}`);

  // 권한 테스트용 계정
  studentId = synthUid;
  const t = tdb.prepare("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1").get();
  teacherId = t ? Number(t.id)
    : Number(tdb.prepare("INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', 'teacher')").run(`t_p2_tch_${Date.now()}`, 'P2교사').lastInsertRowid);

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

async function fetchEquity(qs = '?dim=region&period=90d') {
  const r = await req('/stats/equity' + qs, ADMIN);
  assert.equal(r.status, 200, `200 기대, got ${r.status}: ${r.raw}`);
  return r.json;
}
const findLevel = (j, lv) => (j.crossLevelRegion || []).find(x => x.level === lv);
const findCell = (row, region) => (row.cells || []).find(c => c.region === region);

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-1: crossLevelRegion 존재·항상 반환·순서 초→중→고
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-1: crossLevelRegion 배열 — dim 무관 항상, 순서 elementary→middle→high', async () => {
  const jRegion = await fetchEquity('?dim=region&period=90d');
  assert.ok(Array.isArray(jRegion.crossLevelRegion), 'crossLevelRegion 배열(dim=region)');
  const jLevel = await fetchEquity('?dim=school_level&period=90d');
  assert.ok(Array.isArray(jLevel.crossLevelRegion), 'crossLevelRegion 배열(dim=school_level)도 반환');

  // 합성으로 초·중·고 3급 모두 존재 → 3행 이상, 순서 고정
  const levels = jRegion.crossLevelRegion.map(x => x.level);
  assert.ok(levels.includes('elementary') && levels.includes('middle') && levels.includes('high'),
    '초·중·고 3학교급 모두 존재');
  const order = { elementary: 0, middle: 1, high: 2 };
  for (let i = 1; i < levels.length; i++) {
    assert.ok(order[levels[i - 1]] < order[levels[i]], `학교급 순서 초→중→고 (${levels[i - 1]}→${levels[i]})`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-2: regionGapPP === top.v − bottom.v (표본충족 셀 최상위−최하위)
//   초등: 상위90·하위50 → gap≈40. 결정적 박제 + 전 학교급 불변식.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-2: regionGapPP === top.v − bottom.v (초등 90-50=40 결정적 + 전급 불변식)', async () => {
  const j = await fetchEquity();
  const elem = findLevel(j, 'elementary');
  assert.ok(elem, '초등 행 존재');
  assert.ok(elem.top && elem.bottom, '초등 top/bottom 존재(표본충족 2셀)');
  const eHi = findCell(elem, R_E_HI), eLo = findCell(elem, R_E_LO);
  assert.equal(eHi.avgScore, 90, '초상위 셀 성취=90');
  assert.equal(eLo.avgScore, 50, '초하위 셀 성취=50');
  assert.equal(elem.regionGapPP, 40, '초등 지역격차=90-50=40%p');
  assert.equal(elem.top.v, 90, 'top=90'); assert.equal(elem.bottom.v, 50, 'bottom=50');

  // 전 학교급 불변식: regionGapPP === top.v − bottom.v (표본충족 2셀 이상일 때만 non-null)
  for (const row of j.crossLevelRegion) {
    if (row.regionGapPP != null) {
      assert.ok(row.top && row.bottom, `${row.level}: gap 있으면 top/bottom 존재`);
      const expect = Math.round((row.top.v - row.bottom.v) * 10) / 10;
      assert.equal(row.regionGapPP, expect, `${row.level}: regionGapPP(${row.regionGapPP}) == top−bottom(${expect})`);
      assert.ok(row.regionGapPP >= 0, `${row.level}: regionGapPP ≥ 0`);
      assert.ok(row.top.v >= row.bottom.v, `${row.level}: top.v ≥ bottom.v`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-2b: 표본충족 셀 < 2인 학교급은 regionGapPP null (top/bottom null).
//   실 DB(임시본)에 다른 지역 셀이 있을 수 있어 셀 수를 단정하지 않는다.
//   대신 "표본충족 셀 < 2 ⟺ regionGapPP null" 불변식을 전 학교급에 전수 대조하고,
//   합성 단독 셀(R_H_ONLY)이 격차 산정에 쓰이지 않는지(고등 단독이면 gap null) 검증.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-2b: 표본충족 셀 < 2 ⟺ regionGapPP null (전 학교급 전수)', async () => {
  const j = await fetchEquity();
  for (const row of j.crossLevelRegion) {
    const scored = (row.cells || []).filter(c => !c.masked && c.avgScore != null);
    if (scored.length < 2) {
      assert.equal(row.regionGapPP, null, `${row.level}: 표본충족<2 → regionGapPP null`);
      assert.equal(row.top, null, `${row.level}: top null`);
      assert.equal(row.bottom, null, `${row.level}: bottom null`);
    } else {
      assert.ok(row.regionGapPP != null, `${row.level}: 표본충족≥2 → regionGapPP 존재`);
    }
  }
  // 고등에 합성 단독 셀 R_H_ONLY 가 존재(마스킹 아님)
  const high = findLevel(j, 'high');
  const hCell = findCell(high, R_H_ONLY);
  assert.ok(hCell && hCell.masked === false, '고등 합성 셀 표본충족(10명)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-3: 마스킹 — students<10 셀은 masked·avgScore null·격차 산정 제외.
//   중등: 충족(80,10명)·소표본(99,6명). 소표본 셀 마스킹, 격차 top/bottom 에 미포함.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-3: <10 셀 마스킹 — avgScore null·top/bottom 에서 제외', async () => {
  const j = await fetchEquity();
  const mid = findLevel(j, 'middle');
  assert.ok(mid, '중등 행 존재');
  const mask = findCell(mid, R_M_MASK), ok = findCell(mid, R_M_OK);
  assert.ok(mask && ok, '중등 두 셀 모두 존재');
  assert.equal(mask.students, 6, '소표본 셀 6명(<10)');
  assert.equal(mask.masked, true, '소표본 셀 masked=true');
  assert.equal(mask.avgScore, null, '마스킹 셀 avgScore null');
  assert.equal(ok.masked, false, '충족 셀 masked=false');
  assert.equal(ok.avgScore, 80, '충족 셀 성취=80');
  // 마스킹 셀(R_M_MASK)은 격차 산정(top/bottom)에서 절대 제외 — 실 DB 다른 중등 지역과 무관하게 불변.
  if (mid.top) assert.notEqual(mid.top.id, R_M_MASK, 'top 은 마스킹 셀 아님');
  if (mid.bottom) assert.notEqual(mid.bottom.id, R_M_MASK, 'bottom 은 마스킹 셀 아님');
  // 전수: 어떤 학교급이든 마스킹 셀은 top/bottom 이 될 수 없다.
  for (const row of j.crossLevelRegion) {
    const maskedIds = new Set((row.cells || []).filter(c => c.masked).map(c => c.region));
    if (row.top) assert.ok(!maskedIds.has(row.top.id), `${row.level}: top 이 마스킹 셀`);
    if (row.bottom) assert.ok(!maskedIds.has(row.bottom.id), `${row.level}: bottom 이 마스킹 셀`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-4: cells 평균성취 내림차순(표본충족 먼저, 성취null 뒤로).
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-4: cells 평균성취 내림차순 + 성취null(마스킹) 뒤로', async () => {
  const j = await fetchEquity();
  for (const row of j.crossLevelRegion) {
    const cells = row.cells || [];
    let seenNull = false;
    let prev = Infinity;
    for (const c of cells) {
      if (c.avgScore == null) { seenNull = true; continue; }
      assert.ok(!seenNull, `${row.level}: 성취값 셀이 null 셀보다 뒤에 옴(정렬 위반)`);
      assert.ok(c.avgScore <= prev, `${row.level}: 내림차순 위반 (${c.avgScore} > ${prev})`);
      prev = c.avgScore;
    }
  }
  // 초등: [초상위90, 초하위50] 순서 확정
  const elem = findLevel(j, 'elementary');
  const scored = (elem.cells || []).filter(c => c.avgScore != null);
  assert.equal(scored[0].region, R_E_HI, '초등 첫 셀 = 상위(90)');
  assert.equal(scored[scored.length - 1].region, R_E_LO, '초등 마지막 셀 = 하위(50)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-5: levelLabel 한글 + level 코드 동봉.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-5: levelLabel 한글(초/중/고) + level 코드·cells 계약', async () => {
  const j = await fetchEquity();
  const map = { elementary: '초등학교', middle: '중학교', high: '고등학교' };
  for (const row of j.crossLevelRegion) {
    assert.equal(row.levelLabel, map[row.level], `${row.level} → ${map[row.level]}`);
    assert.ok(Array.isArray(row.cells), `${row.level}: cells 배열`);
    for (const c of row.cells) {
      assert.equal(typeof c.region, 'string', 'cell.region 문자열');
      assert.equal(typeof c.regionLabel, 'string', 'cell.regionLabel 문자열');
      assert.equal(typeof c.students, 'number', 'cell.students 숫자');
      assert.equal(typeof c.masked, 'boolean', 'cell.masked 불리언');
      assert.ok(c.avgScore === null || typeof c.avgScore === 'number', 'cell.avgScore null 또는 숫자');
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-6: 세션 커버리지 분모 — 세션 의미 유형만(조회 로그 제외).
//   SVC_SESS: 세션유형 6건(4채움·2결측) + 조회 5건. 커버리지 분모=6, filled=4 → 66.7%.
//   조회 5건(session_id 채워도)은 분모에 안 섞임.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-6: session_coverage 분모=세션 의미 유형만 — 조회 로그 제외(SQL 미러)', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  assert.equal(r.status, 200);
  const d = r.json;
  // 전역 denominators.session 은 세션 의미 유형만 카운트(조회 제외) — SQL 미러로 교차.
  const SESS = "'exam_complete','homework_submit','self_learn','content_solve','lesson_progress','wrong_note_retry','daily_complete'";
  const mir = tdb.prepare(`
    SELECT SUM(CASE WHEN activity_type IN (${SESS}) THEN 1 ELSE 0 END) denom,
           SUM(CASE WHEN activity_type IN (${SESS}) AND (session_id IS NOT NULL AND TRIM(session_id)<>'') THEN 1 ELSE 0 END) filled
    FROM learning_logs
    WHERE source_service IS NOT NULL AND source_service NOT LIKE 'demo%'
      AND DATE(created_at) >= DATE('now','-30 days') AND DATE(created_at) <= DATE('now')
  `).get();
  assert.equal(d.denominators.session, mir.denom, `denominators.session(${d.denominators.session}) == SQL 세션 분모(${mir.denom})`);
  const expectRate = mir.denom > 0 ? Math.round((mir.filled / mir.denom) * 1000) / 10 : 0;
  assert.equal(d.session_coverage_rate, expectRate, `session_coverage_rate(${d.session_coverage_rate}) == filled/denom(${expectRate})`);

  // 조회 로그가 분모에 안 섞였는지: 합성 서비스 SVC_SESS 만 격리해 세션 분모=6 확인.
  const svcMir = tdb.prepare(`
    SELECT SUM(CASE WHEN activity_type IN (${SESS}) THEN 1 ELSE 0 END) denom,
           SUM(CASE WHEN activity_type IN (${SESS}) AND (session_id IS NOT NULL AND TRIM(session_id)<>'') THEN 1 ELSE 0 END) filled,
           COUNT(*) total
    FROM learning_logs WHERE source_service = ?
  `).get(SVC_SESS);
  assert.equal(svcMir.total, 11, 'SVC_SESS 총 11건(세션6+조회5)');
  assert.equal(svcMir.denom, 6, 'SVC_SESS 세션 분모=6(조회 5건 제외)');
  assert.equal(svcMir.filled, 4, 'SVC_SESS 세션 채움=4(공백 session_id 는 결측)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-7: session_coverage_rate 0~100 · denominators.session 정합.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-7: session_coverage_rate 0~100 · denominators.session 숫자', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  const d = r.json;
  assert.equal(typeof d.session_coverage_rate, 'number', 'session_coverage_rate 숫자');
  assert.ok(d.session_coverage_rate >= 0 && d.session_coverage_rate <= 100,
    `session_coverage_rate 0~100: ${d.session_coverage_rate}`);
  assert.ok(d.denominators && typeof d.denominators.session === 'number', 'denominators.session 숫자');
  assert.ok(d.denominators.session >= 0, 'denominators.session ≥ 0');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-8: 커버리지(양의 지표) — 채운 비율이지 결측률 아님. missing_session_rate 계속 미제공.
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-8: 커버리지=양의 지표(채움비율) · missing_session_rate 계속 미제공', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  const d = r.json;
  // missing_session_rate 는 P2 에서도 미제공(FE 폴백 유지) — 새 지표는 커버리지로 별도.
  assert.ok(d.missing_session_rate === undefined, 'missing_session_rate 계속 미제공(계약)');
  // 커버리지 = filled/denom (양). denom>0 이면 filled=denom×rate/100 로 역산 검증.
  if (d.denominators.session > 0) {
    const impliedFilled = Math.round(d.denominators.session * d.session_coverage_rate / 100);
    assert.ok(impliedFilled >= 0 && impliedFilled <= d.denominators.session,
      '커버리지×분모 = 채운 건수(0~분모 범위)');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-P2-9: 권한/계약 회귀 유지 — student 403, equity 학생·교사 403·admin 200,
//   기존 P0/P1 필드 동시 존재(회귀).
// ──────────────────────────────────────────────────────────────────────────
test('INV-P2-9: 권한·기존 계약 회귀 유지', async () => {
  // dataset-coverage: student 403
  const rc = await req('/dataset-coverage', studentId);
  assert.equal(rc.status, 403, 'dataset-coverage student 403');
  // 기존 P0 필드 동시 존재(회귀)
  const ra = await req('/dataset-coverage', ADMIN);
  const d = ra.json;
  assert.equal(d.total_logs, d.totalStatements, 'total_logs 별칭 유지');
  for (const k of ['missing_achievement_rate', 'missing_subject_rate', 'missing_duration_rate']) {
    assert.equal(typeof d[k], 'number', `${k} 유지`);
  }
  assert.ok(Array.isArray(d.per_service), 'per_service 유지');
  assert.ok(typeof d.denominators.achievement === 'number', 'denominators.achievement 유지');

  // equity: 학생·교사 403·admin 200 (crossLevelRegion 회귀 시 권한 게이트 보존)
  const es = await req('/stats/equity?dim=region', studentId);
  assert.equal(es.status, 403, 'equity student 403');
  const et = await req('/stats/equity?dim=region', teacherId);
  assert.equal(et.status, 403, 'equity teacher 403');
  const ea = await req('/stats/equity?dim=region', ADMIN);
  assert.equal(ea.status, 200, 'equity admin 200');
  // 기존 P1 필드 + P2 신규 필드 동시 존재
  assert.ok(Array.isArray(ea.json.units), 'units 유지(P1)');
  assert.ok(ea.json.metrics && ea.json.trend && Array.isArray(ea.json.priorityUnits), 'metrics/trend/priorityUnits 유지(P1)');
  assert.ok(Array.isArray(ea.json.crossLevelRegion), 'crossLevelRegion 신규(P2)');
});
