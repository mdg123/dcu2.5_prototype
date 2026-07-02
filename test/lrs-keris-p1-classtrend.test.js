// test/lrs-keris-p1-classtrend.test.js
// ─────────────────────────────────────────────────────────────────────────────
// KERIS 벤치마킹 P1-3 하네스 (BE 소관 불변식 박제 — INV-K8)
//   기획서: 작업지시서/LRS_P1_3구간IA_스택바_학급비교_스펙.md §4-2·§7 INV-K8
//
//   INV-K8 classTrend 계약 — GET /trend/student/:id?withClass=1 옵트인 확장:
//     ① 반 학생 4명 → classTrend.status='insufficient' · series 키 부재
//     ② 반 학생 6명·특정 주 기여자 3명 → 그 주 series 미포함(주별 이중 가드)
//     ③ 반환 전 주: rate 0~100 · contributors≥MIN_PEERS(5) · attempts≥MIN_WEEK_ATTEMPTS(3)
//        · week 형식 /^\d{4}-\d{2}$/ (strftime %Y-%W — 내 series 와 동일 키)
//     ④ withClass 미지정 → classTrend 키 부재 + 나머지 응답 deepEqual(완전 불변 — 회귀 0)
//     ⑤ series 항목·classTrend 에 user_id·name 류 개별 학생 식별 키 부재(익명 집계만)
//   + 반 없음 → classTrend.status='no_class'
//   + peer-compare 회귀: _peerIdsOf 헬퍼 추출 후 3분기(ok/insufficient/no_class) 동작 불변,
//     peerCount 가 classTrend 와 동일(“학급” 정의 단일화 증명)
//   + 권한 회귀: 학생이 타 학생 trend 요청 시 withClass 여부와 무관하게 403
//
// DB 격리: 실 DB → 임시 복사본(_setup). 계정(실 DB 확정): admin=1, teacher1=2, student1=3.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const TEACHER = 2, STUDENT1 = 3;
const MIN_PEERS = 5, MIN_WEEK_ATTEMPTS = 3;
const WEEK_RE = /^\d{4}-\d{2}$/;

// ── HTTP 하네스 (lrs-keris-p0.test.js 와 동일 패턴) ──────────────────────────
let server, baseUrl, tdb;
// 시드 id 들
let A = [], B = [], LONER; // A: 4명 반, B: 6명 반, LONER: 무소속
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

// 시드 주차 키(검증용) — _weeklyRateSeries 와 동일한 strftime('%Y-%W') 를 DB 에서 산출.
let WEEK_M15, WEEK_M8, WEEK_NOW; // -15일(기여 6명) / -8일(기여 3명) / 오늘(기여 5명)

before(async () => {
  tdb = openTestDb();
  const insUser = tdb.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, 'student')"
  );
  const insClass = tdb.prepare(
    "INSERT INTO classes (code, name, owner_id) VALUES (?, ?, ?)"
  );
  const insMember = tdb.prepare(
    "INSERT INTO class_members (class_id, user_id, role) VALUES (?, ?, 'member')"
  );
  const insLog = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, result_success, created_at)
    VALUES (?, 'content_solve', 'attempted', ?, datetime('now', ?))
  `);
  const stamp = Date.now();

  // ── 시드 A: 4명 반(INV-K8① — 전체 가드 peer<5) ────────────────────────
  const clsA = Number(insClass.run(`t_p13_a_${stamp}`, 'P1-3 소반(4명)', TEACHER).lastInsertRowid);
  for (let i = 1; i <= 4; i++) {
    const uid = Number(insUser.run(`t_p13_a${i}_${stamp}`, `학급비교시드A${i}`, ).lastInsertRowid);
    A.push(uid); insMember.run(clsA, uid);
  }
  // 4명 전원이 로그를 쌓아도(주별 가드와 무관하게) 전체 가드가 먼저 차단해야 한다.
  for (const uid of A) { insLog.run(uid, 1, '-1 days'); insLog.run(uid, 0, '-1 days'); }

  // ── 시드 B: 6명 반(INV-K8②③ — 주별 이중 가드) ─────────────────────────
  const clsB = Number(insClass.run(`t_p13_b_${stamp}`, 'P1-3 본반(6명)', TEACHER).lastInsertRowid);
  for (let i = 1; i <= 6; i++) {
    const uid = Number(insUser.run(`t_p13_b${i}_${stamp}`, `학급비교시드B${i}`).lastInsertRowid);
    B.push(uid); insMember.run(clsB, uid);
  }
  // 주1(-15일): 6명 전원 × 2회(성공1·실패1) → attempts 12·success 6·rate 50·contributors 6 → 반환
  for (const uid of B) { insLog.run(uid, 1, '-15 days'); insLog.run(uid, 0, '-15 days'); }
  // 주2(-8일): 3명만 × 2회(전부 성공) → contributors 3 < 5 → 그 주 미반환(결측)
  for (const uid of B.slice(0, 3)) { insLog.run(uid, 1, '-8 days'); insLog.run(uid, 1, '-8 days'); }
  // 주3(오늘): 5명 × 1회(전부 성공) → attempts 5·rate 100·contributors 5 → 반환(경계값 5 통과)
  for (const uid of B.slice(0, 5)) { insLog.run(uid, 1, '-0 days'); }

  // ── 시드 L: 무소속(no_class) ─────────────────────────────────────────
  LONER = Number(insUser.run(`t_p13_loner_${stamp}`, '학급비교무소속').lastInsertRowid);
  insLog.run(LONER, 1, '-1 days');

  // 주차 키를 DB 와 동일 산식으로 확보(달력 계산 미러 금지 — SQLite 가 정본)
  const wk = (mod) => tdb.prepare(`SELECT strftime('%Y-%W', datetime('now', ?)) AS w`).get(mod).w;
  WEEK_M15 = wk('-15 days'); WEEK_M8 = wk('-8 days'); WEEK_NOW = wk('-0 days');
  assert.notEqual(WEEK_M15, WEEK_M8, '시드 전제: -15일과 -8일은 다른 주차여야');
  assert.notEqual(WEEK_M8, WEEK_NOW, '시드 전제: -8일과 오늘은 다른 주차여야');

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-K8④: withClass 미지정 → classTrend 키 부재 + 응답 나머지 deepEqual(완전 불변).
//   시드 학생(B1)과 실 데이터 학생(student1) 양쪽에서 검증.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K8④: withClass 미지정 응답 완전 불변 — classTrend 키 부재 + deepEqual', async () => {
  for (const uid of [B[0], STUDENT1]) {
    const plain = await req(`/trend/student/${uid}?period=30d`, uid);
    const withC = await req(`/trend/student/${uid}?period=30d&withClass=1`, uid);
    assert.equal(plain.status, 200); assert.equal(withC.status, 200);
    assert.ok(!('classTrend' in plain.json), `uid ${uid}: 미지정 응답에 classTrend 키가 없어야`);
    assert.ok('classTrend' in withC.json, `uid ${uid}: withClass=1 응답에는 classTrend 가 있어야`);
    const rest = { ...withC.json };
    delete rest.classTrend;
    assert.deepEqual(rest, plain.json,
      `uid ${uid}: withClass=1 은 classTrend "추가"만 해야 — 기존 필드 변형 0(회귀 0)`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K8①: 전체 가드 — 반 학생 4명(<MIN_PEERS) → status='insufficient'·series 부재.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K8①: peer 4명 → classTrend.status=insufficient · series 키 부재', async () => {
  const r = await req(`/trend/student/${A[0]}?period=30d&withClass=1`, A[0]);
  assert.equal(r.status, 200);
  const ct = r.json.classTrend;
  assert.equal(ct.status, 'insufficient');
  assert.equal(ct.peerCount, 4);
  assert.equal(ct.minPeers, MIN_PEERS);
  assert.ok(!('series' in ct), 'peer<5 는 series 키 자체가 없어야(스펙 §4-2 가드①)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K8②: 주별 가드 — 기여자 3명인 주(-8일)는 series 미포함, 6명·5명 주는 포함.
//   시드 확정값 교차: 주1 rate 50(12회 중 6성공)·주3 rate 100(5회 전부 성공).
// ──────────────────────────────────────────────────────────────────────────
test('INV-K8②: 기여자<5 주 미반환 + 반환 주 값 시드 일치(rate·attempts·contributors)', async () => {
  const r = await req(`/trend/student/${B[0]}?period=30d&withClass=1`, B[0]);
  assert.equal(r.status, 200);
  const ct = r.json.classTrend;
  assert.equal(ct.status, 'ok');
  assert.equal(ct.peerCount, 6);
  const weeks = ct.series.map(w => w.week);
  assert.ok(weeks.includes(WEEK_M15), `기여 6명 주(${WEEK_M15})는 포함되어야 (현재 ${weeks})`);
  assert.ok(weeks.includes(WEEK_NOW), `기여 5명(경계) 주(${WEEK_NOW})는 포함되어야 (현재 ${weeks})`);
  assert.ok(!weeks.includes(WEEK_M8), `기여 3명 주(${WEEK_M8})는 미반환이어야 (현재 ${weeks})`);
  const w1 = ct.series.find(w => w.week === WEEK_M15);
  assert.equal(w1.attempts, 12, '주1 attempts=12(6명×2회)');
  assert.equal(w1.contributors, 6);
  assert.equal(w1.rate, 50, '주1 rate=50(12회 중 성공 6회)');
  const w3 = ct.series.find(w => w.week === WEEK_NOW);
  assert.equal(w3.attempts, 5); assert.equal(w3.contributors, 5);
  assert.equal(w3.rate, 100, '주3 rate=100(5회 전부 성공)');
  assert.equal(ct.currentRate, w3.rate, 'currentRate = 유효 마지막 주 rate');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K8③: 반환 전 주 경계 — rate 0~100 · contributors≥5 · attempts≥3 · week 형식 · 시간순.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K8③: series 전 항목 경계값 + week 형식(%Y-%W) + 오름차순', async () => {
  const r = await req(`/trend/student/${B[0]}?period=30d&withClass=1`, B[0]);
  const ct = r.json.classTrend;
  assert.equal(ct.status, 'ok');
  assert.ok(ct.series.length >= 2, '시드상 유효 주 2개 이상');
  for (const w of ct.series) {
    assert.match(w.week, WEEK_RE, `week 형식 %Y-%W 이어야 (현재 ${w.week})`);
    assert.ok(w.rate >= 0 && w.rate <= 100, `rate 0~100 (현재 ${w.rate})`);
    assert.ok(w.contributors >= MIN_PEERS, `contributors≥${MIN_PEERS} (현재 ${w.contributors})`);
    assert.ok(w.attempts >= MIN_WEEK_ATTEMPTS, `attempts≥${MIN_WEEK_ATTEMPTS} (현재 ${w.attempts})`);
    assert.ok(Number.isInteger(w.attempts) && Number.isInteger(w.contributors), '정수 카운트');
  }
  const weeks = ct.series.map(w => w.week);
  assert.deepEqual(weeks, [...weeks].sort(), '주차 오름차순(사전순=시간순) 이어야');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K8⑤: 익명성 — series 항목·classTrend 에 개별 학생 식별 키 부재(집계값+인원수만).
// ──────────────────────────────────────────────────────────────────────────
test('INV-K8⑤: classTrend 개별 학생 식별자 0 — 허용 키 화이트리스트', async () => {
  const r = await req(`/trend/student/${B[0]}?period=30d&withClass=1`, B[0]);
  const ct = r.json.classTrend;
  const ALLOWED_TOP = ['status', 'peerCount', 'minPeers', 'currentRate', 'series'];
  for (const k of Object.keys(ct)) {
    assert.ok(ALLOWED_TOP.includes(k), `classTrend 허용 외 키 발견: ${k}`);
  }
  const ALLOWED_ITEM = ['week', 'rate', 'attempts', 'contributors'];
  for (const w of ct.series) {
    assert.deepEqual(Object.keys(w).sort(), [...ALLOWED_ITEM].sort(),
      `series 항목 키는 정확히 ${ALLOWED_ITEM} 이어야 (현재 ${Object.keys(w)})`);
  }
  // 식별 어휘 스캔(2중 방어): 직렬화 본문에 id/name 류 키 부재
  assert.ok(!/"(user_?id|username|display_?name|student_?id|name)"\s*:/i.test(JSON.stringify(ct)),
    'classTrend 직렬화 본문에 개별 학생 식별 키가 없어야');
});

// ──────────────────────────────────────────────────────────────────────────
// 주차 키 정합: classTrend 주 키가 내(trend.series) 주 키와 동일 형식·정렬 가능.
//   B1 은 3주 전부 기여 → 내 series 주 집합이 classTrend 주 집합을 포함해야 한다.
// ──────────────────────────────────────────────────────────────────────────
test('classTrend 주 키 = 내 series 와 동일 %Y-%W (FE align 전제)', async () => {
  const r = await req(`/trend/student/${B[0]}?period=30d&withClass=1`, B[0]);
  const mine = new Set(r.json.trend.series.map(w => w.week));
  for (const w of r.json.trend.series) assert.match(w.week, WEEK_RE);
  for (const w of r.json.classTrend.series) {
    assert.ok(mine.has(w.week),
      `classTrend 주 ${w.week} 는 (전 주 기여한 B1의) 내 series 주 집합에 있어야 — 키 형식 불일치 신호`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 반 없음: withClass=1 이어도 classTrend.status='no_class' (비교 데이터 없음).
// ──────────────────────────────────────────────────────────────────────────
test('무소속 학생 → classTrend.status=no_class · series 부재', async () => {
  const r = await req(`/trend/student/${LONER}?period=30d&withClass=1`, LONER);
  assert.equal(r.status, 200);
  assert.equal(r.json.classTrend.status, 'no_class');
  assert.ok(!('series' in r.json.classTrend));
});

// ──────────────────────────────────────────────────────────────────────────
// peer-compare 회귀: _peerIdsOf 헬퍼 추출 후 3분기 동작 불변 + "학급" 정의 단일화.
// ──────────────────────────────────────────────────────────────────────────
test('peer-compare 회귀: 헬퍼 추출 후 ok/insufficient/no_class 3분기 불변', async () => {
  // ① 실 데이터 student1 — 기획서 실측(§1-2): peerCount 8 · status ok
  const ok = await req(`/peer-compare/${STUDENT1}`, STUDENT1);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'ok');
  assert.ok(ok.json.peerCount >= MIN_PEERS);
  assert.equal(ok.json.minPeers, MIN_PEERS);
  assert.equal(ok.json.anonymous, true);
  for (const k of ['reach', 'activity', 'disclaimer']) assert.ok(k in ok.json, `peer-compare 계약 필드 ${k}`);
  // ② 시드 4명 반 — insufficient(peerCount 4)
  const ins = await req(`/peer-compare/${A[0]}`, A[0]);
  assert.equal(ins.json.status, 'insufficient');
  assert.equal(ins.json.peerCount, 4);
  // ③ 무소속 — no_class
  const nc = await req(`/peer-compare/${LONER}`, LONER);
  assert.equal(nc.json.status, 'no_class');
  // ④ 학급 정의 단일화: peer-compare 의 peerCount == classTrend 의 peerCount (같은 헬퍼)
  const pcB = await req(`/peer-compare/${B[0]}`, B[0]);
  const ctB = await req(`/trend/student/${B[0]}?period=30d&withClass=1`, B[0]);
  assert.equal(pcB.json.peerCount, ctB.json.classTrend.peerCount,
    'peer-compare 와 classTrend 의 peer 집합 크기가 같아야(_peerIdsOf 공용)');
});

// ──────────────────────────────────────────────────────────────────────────
// 권한 회귀: 학생이 타 학생 trend 요청 → withClass 여부와 무관하게 403(canViewUser 불변).
// ──────────────────────────────────────────────────────────────────────────
test('권한: 학생이 타 학생 trend/classTrend 요청 시 403 (교사는 200)', async () => {
  const denied = await req(`/trend/student/${B[1]}?period=30d&withClass=1`, B[0]);
  assert.equal(denied.status, 403, '학생→타 학생: 403');
  const teacher = await req(`/trend/student/${B[1]}?period=30d&withClass=1`, TEACHER);
  assert.equal(teacher.status, 200, '교사: 200');
  assert.ok('classTrend' in teacher.json, '교사 열람에도 동일 계약');
});
