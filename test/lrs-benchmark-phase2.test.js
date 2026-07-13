// test/lrs-benchmark-phase2.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS Phase 2 — 도 전체 벤치마크 하네스 (BE 불변식 박제)
//   기획: 보고서/LRS_Phase2_벤치마크_방법론_API_v1.md · _UI_기획_v1.md
//   대상: GET /api/lrs/stats/benchmark · GET /api/lrs/stats/daily-benchmark
//
//   INV-BM1  백분위(percentile) ∈ [0,100] 또는 null — 헤드라인·셀 전부.
//   INV-BM2  KEY(classId→학년→도) — provinceStudents == 도내 동 school_level×grade 학생 수(DB 실측 일치).
//   INV-BM3  마스킹 규칙 — cell.masked ⇔ province.n < minSample. masked 면 province.mean===null(0채움 금지).
//   INV-BM4  성취기준 코어 게이트 — level=achievement(초등) 셀은 전부 isCore=true·province.touched≥50.
//            cellCount == (도 distinct 학생 n≥50 코드 수, DB 실측 일치).
//   INV-BM5  권한 — 비소유 클래스 403 · classId 누락 400 · 잘못된 subject 400.
//   INV-BM6  정직성(realOnly) — realOnly=1 이면 도 모집단이 시드 제외로 붕괴 → 헤드라인 masked=true
//            (도 실사용자 표본 < minSample). seedNotice 상시 문자열 반환.
//   INV-DB1  일자 범위 — series 모든 date ∈ [from,to] · 오름차순 · 중복 없음.
//   INV-DB2  class/province 분리 — 각 엔트리에 class{acc,n}·province{acc,n,masked} 동시 존재.
//   INV-DB3  마스킹 — province.masked ⇔ province.n<minSample. masked→acc null. 비마스킹 acc∈[0,100].
//   INV-DB4  self_learn 기반·학년 스코프 — 임의 비마스킹 일자의 province.n ==
//            도내 동학년 학생의 그 날 self_learn distinct 사용자 수(DB 실측 일치).
//   INV-DB5  from>to → 400 · summary.percentile ∈ [0,100]∪null.
//
//   DB 격리: 실 DB → 임시 복사본(_setup). 계정: teacher1=2(소유반 class1=3학년). HTTP 하네스 패턴은
//   lrs-keris-p0/p1/p2 와 동일(x-test-user 세션 주입).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const TEACHER1 = 2;
const MIN_SAMPLE = 10;

let server, baseUrl, tdb;
let ownedClassId, ownedGrade, ownedLevel, notOwnedClassId, provinceCount;

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

const inRangeOrNull = (v, lo, hi) => v == null || (typeof v === 'number' && v >= lo && v <= hi);

before(async () => {
  tdb = openTestDb();

  // teacher1 소유 · 초등 · grade 확정(classes.grade) 반 선택
  const owned = tdb.prepare(
    "SELECT id, grade FROM classes WHERE owner_id = ? AND status = 'active' AND grade IS NOT NULL ORDER BY id"
  ).all(TEACHER1);
  // 멤버가 있고 초등인 반을 고른다
  for (const c of owned) {
    const lvl = tdb.prepare(`
      SELECT u.school_level sl, COUNT(*) n FROM class_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.class_id=? AND u.role='student' AND u.school_level IS NOT NULL
      GROUP BY u.school_level ORDER BY n DESC LIMIT 1
    `).get(c.id);
    if (lvl && lvl.sl === 'elementary') { ownedClassId = c.id; ownedGrade = c.grade; ownedLevel = 'elementary'; break; }
  }
  assert.ok(ownedClassId, 'teacher1 의 초등·grade 확정 소유 반을 찾지 못함');

  provinceCount = tdb.prepare(
    "SELECT COUNT(*) c FROM users WHERE role='student' AND school_level=? AND grade=?"
  ).get(ownedLevel, ownedGrade).c;

  // teacher1 이 소유·소속하지 않은 반(403 검증용)
  notOwnedClassId = tdb.prepare(`
    SELECT id FROM classes
    WHERE owner_id != ? AND id NOT IN (SELECT class_id FROM class_members WHERE user_id = ?)
    ORDER BY id LIMIT 1
  `).get(TEACHER1, TEACHER1).id;
  assert.ok(notOwnedClassId, '비소유 반을 찾지 못함');

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ── benchmark ────────────────────────────────────────────────────────────────
test('INV-BM2/BM3: subject 벤치마크 — 도 표본=동학년 실측 · 마스킹 규칙 · 백분위 범위', async () => {
  const r = await req(`/stats/benchmark?classId=${ownedClassId}&level=subject&metric=reach`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.equal(b.grade, ownedGrade, 'grade 파생이 반 선언학년과 불일치');
  assert.equal(b.schoolLevel, ownedLevel);
  // INV-BM2: KEY — 도 모집단 == 동 school_level×grade 학생 수
  assert.equal(b.provinceStudents, provinceCount, 'provinceStudents 가 동학년 실측과 불일치');
  assert.ok(typeof b.seedNotice === 'string' && b.seedNotice.length > 0, 'seedNotice 문자열 필수');
  // INV-BM1: 헤드라인 백분위 범위
  assert.ok(inRangeOrNull(b.headline.percentile, 0, 100), 'headline.percentile 범위 위반');
  assert.ok(b.cells.length > 0, 'subject 셀이 비어있음');
  for (const c of b.cells) {
    // INV-BM3: 마스킹 규칙(⇔ province.n<minSample) + 0채움 금지
    assert.equal(c.masked, c.province.n < b.minSample, `cell ${c.key} masked 규칙 위반`);
    if (c.masked) assert.equal(c.province.mean, null, `masked 셀 ${c.key} 이 값을 노출(0채움 금지 위반)`);
    // INV-BM1: 셀 백분위 범위
    assert.ok(inRangeOrNull(c.percentile, 0, 100), `cell ${c.key} percentile 범위 위반`);
  }
});

test('INV-BM4: achievement 벤치마크 — 초등 코어(도 distinct n≥50) 화이트리스트만', async () => {
  const r = await req(`/stats/benchmark?classId=${ownedClassId}&level=achievement&metric=reach`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.equal(b.schoolLevel, 'elementary');
  // 모든 셀이 코어(도 distinct 학생 n≥50)
  for (const c of b.cells) {
    assert.equal(c.isCore, true, `비코어 코드 ${c.code} 노출`);
    assert.ok(c.province.touched >= 50, `코드 ${c.code} touched(${c.province.touched}) < 50 인데 노출`);
    assert.ok(inRangeOrNull(c.mineReach, 0, 100), `mineReach 범위 위반 ${c.code}`);
    assert.ok(inRangeOrNull(c.provMeanReach, 0, 100), `provMeanReach 범위 위반 ${c.code}`);
  }
  // cellCount == DB 실측 코어 코드 수(도내 동학년 distinct 학생 n≥50)
  const coreN = tdb.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT s.achievement_code FROM lrs_achievement_stats s JOIN users u ON u.id=s.user_id
      WHERE u.role='student' AND u.school_level=? AND u.grade=?
        AND s.achievement_code IS NOT NULL AND s.achievement_code <> ''
      GROUP BY s.achievement_code HAVING COUNT(DISTINCT s.user_id) >= 50
    )
  `).get(ownedLevel, ownedGrade).c;
  // resolveCode 괄호정규화로 소폭 병합될 수 있어 <= 허용(초과는 금지)
  assert.ok(b.cellCount <= coreN && b.cellCount >= coreN - 3,
    `코어 셀 수(${b.cellCount}) 가 DB 실측(${coreN})과 크게 어긋남`);
  assert.ok(b.cellCount > 0, '코어 성취기준 셀이 0');
});

test('INV-BM5: 권한·검증 — 비소유 403 · classId 누락 400 · 잘못된 subject 400', async () => {
  assert.equal((await req(`/stats/benchmark?classId=${notOwnedClassId}`, TEACHER1)).status, 403);
  assert.equal((await req('/stats/benchmark?level=subject', TEACHER1)).status, 400);
  assert.equal((await req(`/stats/benchmark?classId=${ownedClassId}&subject=bogus`, TEACHER1)).status, 400);
});

test('INV-BM6: 정직성 — realOnly=1 이면 도 모집단 붕괴 → 헤드라인 masked', async () => {
  const full = (await req(`/stats/benchmark?classId=${ownedClassId}&metric=reach`, TEACHER1)).json;
  const real = (await req(`/stats/benchmark?classId=${ownedClassId}&metric=reach&realOnly=1`, TEACHER1)).json;
  assert.equal(real.realOnly, true);
  // 실사용자 도 표본은 시드 제외로 minSample 미만 → 헤드라인 마스킹(정직 빈)
  assert.ok(real.provinceStudents <= full.provinceStudents, 'realOnly 도 표본이 전체보다 큼(불가)');
  assert.equal(real.headline.masked, true, 'realOnly 도 표본이 충분하다고 나옴(시드 지배 실측과 모순)');
});

// ── daily-benchmark ───────────────────────────────────────────────────────────
test('INV-DB1/DB2/DB3: 일자 벤치마크 — 범위·정렬·분리·마스킹', async () => {
  const from = '2026-06-15', to = '2026-07-10';
  const r = await req(`/stats/daily-benchmark?classId=${ownedClassId}&from=${from}&to=${to}`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.ok(typeof b.seedNotice === 'string' && b.seedNotice.length > 0);
  let prev = '';
  for (const s of b.series) {
    // INV-DB1: 범위·오름차순·중복없음
    assert.ok(s.date >= from && s.date <= to, `series date ${s.date} 가 범위 밖`);
    assert.ok(s.date > prev, `series 정렬/중복 위반 @${s.date}`); prev = s.date;
    // INV-DB2: class/province 분리
    assert.ok(s.class && 'acc' in s.class && 'n' in s.class, 'class 블록 누락');
    assert.ok(s.province && 'n' in s.province && 'masked' in s.province, 'province 블록 누락');
    // INV-DB3: 마스킹 규칙
    assert.equal(s.province.masked, s.province.n < MIN_SAMPLE, `province masked 규칙 위반 @${s.date}`);
    if (s.province.masked) assert.equal(s.province.acc, null, `masked 일자 ${s.date} 도 acc 노출`);
    else assert.ok(inRangeOrNull(s.province.acc, 0, 100), `province acc 범위 위반 @${s.date}`);
    assert.ok(inRangeOrNull(s.class.acc, 0, 100), `class acc 범위 위반 @${s.date}`);
  }
  // INV-DB5: summary 백분위 범위
  assert.ok(inRangeOrNull(b.summary.percentile, 0, 100), 'summary.percentile 범위 위반');
});

test('INV-DB4: self_learn 기반·학년 스코프 — 비마스킹 일자 province.n == 동학년 self_learn distinct', async () => {
  const from = '2026-06-15', to = '2026-07-10';
  const b = (await req(`/stats/daily-benchmark?classId=${ownedClassId}&from=${from}&to=${to}`, TEACHER1)).json;
  const target = b.series.find(s => !s.province.masked && s.province.n >= MIN_SAMPLE);
  assert.ok(target, '비마스킹 도 일자가 없음(검증 불가)');
  // DB 실측: 도내 동학년 학생의 그 날 self_learn distinct 사용자 수
  const dbN = tdb.prepare(`
    SELECT COUNT(DISTINCT ll.user_id) n
    FROM learning_logs ll JOIN users u ON u.id = ll.user_id
    WHERE ll.activity_type = 'self_learn' AND u.role='student'
      AND u.school_level = ? AND u.grade = ? AND DATE(ll.created_at) = ?
  `).get(ownedLevel, ownedGrade, target.date).n;
  assert.equal(target.province.n, dbN,
    `province.n(${target.province.n}) 가 self_learn 동학년 실측(${dbN})과 불일치 — 데이터원/스코프 위반`);
});

test('INV-DB5: from>to → 400', async () => {
  const r = await req(`/stats/daily-benchmark?classId=${ownedClassId}&from=2026-07-10&to=2026-06-01`, TEACHER1);
  assert.equal(r.status, 400);
});
