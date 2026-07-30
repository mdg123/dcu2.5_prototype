// test/lrs-mastery-cumulative.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 마무리 2건 HTTP 레벨 하네스 (실제 라우터 + 미들웨어 순회).
//
//   TASK 1 — 성취수준 누적화(P0):
//     · /api/lrs/mastery/student/3 의 counts.notReached 가 period 7/30/90/무관하게 항상 5.
//       (도달/미도달은 누적 결과 — 기간 창 밖 누적 미도달 은폐 방지.)
//
//   TASK 2 — 카드 드릴다운 /api/lrs/perform/detail:
//     · count == items.length(200 상한 내), 5 bucket × 2 기간.
//     · all count == exam+homework+self+content 합. content segments 소계 합 == content count.
//     · 카드=내역 일치: /stats/perform summary 카드 숫자 == detail bucket count.
//     · score 정규화: solve items score 0~100(비 null), view items score 전부 null.
//     · 권한: 타 학생 조회 시 학생 403, 교사/관리자 200.
//
// DB 격리: 실 DB → 임시 복사본(_setup). db require 전에 DB_PATH 주입.
// 계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const { setupTestDb, openTestDb, fixtureWindow } = require('./_setup');

setupTestDb();                          // ★ db require 전에 DB_PATH 주입
require('../db/schema').initSchema();   // 격리 DB 마이그레이션(std_id·level 등)

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;

// ── HTTP 하니스 (mastery.test.js 패턴 복제) ──────────────────────────────────
let server, baseUrl, CONTENT_GT_Q;
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
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject); r.end();
  });
}

before(async () => {
  // ── CONTENT_GT_Q: DRILL-6 용 시계 독립 창 (2026-07-30 시한폭탄 fix) ─────────
  //   DRILL-6 은 days=90(롤링) 위에서 solve·view 항목이 **존재함**을 단언한다. 실 로그가
  //   2026-07-16 에서 멈춰 있어 90일 창은 2026-10-14 경 완전히 비고 전제가 붕괴한다
  //   (카나리아 63일에서 재현 — 45일에서는 아직 통과). 창을 uid3 로그 전 구간에서 유도.
  {
    const tdb = openTestDb();
    const w = fixtureWindow(tdb, { userId: STUDENT1 });
    CONTENT_GT_Q = `from=${w.from}&to=${w.to}`;
  }
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// TASK 1 — 성취수준 누적화(P0): notReached 는 period 무관 항상 5.
// ──────────────────────────────────────────────────────────────────────────
test('CUMUL-1: /mastery/student/3 notReached 는 period 7/30/90/무관 항상 5', async () => {
  const paths = [
    '/mastery/student/3',
    '/mastery/student/3?period=7d',
    '/mastery/student/3?period=30d',
    '/mastery/student/3?period=90d',
  ];
  for (const p of paths) {
    const r = await req(p, STUDENT1);
    assert.equal(r.status, 200, `${p} → 200`);
    assert.equal(r.json.counts.notReached, 5,
      `${p}: notReached 는 5여야(누적 미도달 은폐 방지). 실제=${r.json.counts.notReached}`);
    assert.equal(r.json.scoped, false, `${p}: scoped=false(누적)`);
    assert.equal(r.json.period, null, `${p}: period=null(누적)`);
  }
});

test('CUMUL-2: /mastery/student/3 미도달 5개 코드 전부 포함(period 무관)', async () => {
  const EXPECTED = new Set(['[4수01-02]', '[4수03-02]', '[4수03-10]', '[4수01-13]', '[4수03-04]']);
  for (const p of ['/mastery/student/3', '/mastery/student/3?period=90d']) {
    const r = await req(p, STUDENT1);
    assert.equal(r.status, 200);
    // route 는 label 을 단원명으로 relabel 하지만 code 는 원본 유지.
    const nrCodes = new Set(
      (r.json.weaknesses || []).filter(w => w.status === 'not_reached').map(w => w.code)
    );
    for (const code of EXPECTED) assert.ok(nrCodes.has(code), `${p}: 미도달 코드 ${code} 누락`);
    assert.equal(nrCodes.size, 5, `${p}: 미도달 weakness 코드 수 5여야. 실제=${nrCodes.size}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// TASK 2 — 드릴다운 count 불변식: count == items.length (5 bucket × 2 기간).
// ──────────────────────────────────────────────────────────────────────────
const BUCKETS = ['exam', 'homework', 'self', 'content', 'all'];

test('DRILL-1: 5 bucket × 2 기간(30d/90d) count === items.length(200 상한 내)', async () => {
  for (const days of [30, 90]) {
    for (const b of BUCKETS) {
      const r = await req(`/perform/detail?bucket=${b}&days=${days}`, STUDENT1);
      assert.equal(r.status, 200, `bucket=${b} days=${days} → 200`);
      assert.equal(r.json.success, true);
      const cap = 200;
      const expectLen = Math.min(r.json.count, cap);
      assert.equal(r.json.items.length, expectLen,
        `bucket=${b} days=${days}: items.length(${r.json.items.length}) != min(count=${r.json.count},200)`);
    }
  }
});

test('DRILL-2: all count === exam+homework+self+content count 합 (30d)', async () => {
  const get = async (b) => (await req(`/perform/detail?bucket=${b}&days=30`, STUDENT1)).json.count;
  const [exam, hw, self, content, all] = await Promise.all(
    ['exam', 'homework', 'self', 'content', 'all'].map(get)
  );
  assert.equal(all, exam + hw + self + content,
    `all(${all}) != exam+hw+self+content(${exam}+${hw}+${self}+${content})`);
});

test('DRILL-3: content segments 소계 합 === content count, 각 segment count===items.length (30d)', async () => {
  const r = await req(`/perform/detail?bucket=content&days=30`, STUDENT1);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.segments), 'content 응답에 segments 배열');
  const segSum = r.json.segments.reduce((s, x) => s + x.count, 0);
  assert.equal(segSum, r.json.count, `segments 합(${segSum}) != content count(${r.json.count})`);
  // 각 segment 재요청: count===items.length
  for (const seg of ['view', 'lesson', 'solve']) {
    const sr = await req(`/perform/detail?bucket=content&segment=${seg}&days=30`, STUDENT1);
    assert.equal(sr.status, 200, `segment=${seg} → 200`);
    assert.equal(sr.json.items.length, Math.min(sr.json.count, 200),
      `segment=${seg}: count(${sr.json.count}) != items.length(${sr.json.items.length})`);
    // segments 소계와 세그먼트 상세 count 일치
    const segMeta = r.json.segments.find(x => x.key === seg);
    assert.equal(sr.json.count, segMeta.count,
      `segment=${seg}: 상세 count(${sr.json.count}) != 소계(${segMeta.count})`);
  }
});

test('DRILL-4: all subtotals 소계 합 === all count === totalActs (30d)', async () => {
  const r = await req(`/perform/detail?bucket=all&days=30`, STUDENT1);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.subtotals), 'all 응답에 subtotals 배열');
  const sum = r.json.subtotals.reduce((s, x) => s + x.count, 0);
  assert.equal(sum, r.json.count, `subtotals 합(${sum}) != all count(${r.json.count})`);
});

// ──────────────────────────────────────────────────────────────────────────
// TASK 2 — 카드=내역 일치: /stats/perform summary 카드 숫자 == detail bucket count.
// ──────────────────────────────────────────────────────────────────────────
test('DRILL-5: 카드=내역 일치 — stats/perform summary == detail count (30d, student1)', async () => {
  const perf = await req(`/stats/perform?days=30&scope=mine`, STUDENT1);
  assert.equal(perf.status, 200);
  const s = perf.json.summary;
  const detailCount = async (b) => (await req(`/perform/detail?bucket=${b}&days=30`, STUDENT1)).json.count;
  assert.equal(await detailCount('exam'), s.examCount, `examCount(${s.examCount}) != detail exam`);
  assert.equal(await detailCount('homework'), s.homeworkCount, `homeworkCount(${s.homeworkCount}) != detail homework`);
  assert.equal(await detailCount('self'), s.selfLearnCount, `selfLearnCount(${s.selfLearnCount}) != detail self`);
  assert.equal(await detailCount('content'), s.contentCount, `contentCount(${s.contentCount}) != detail content`);
  assert.equal(await detailCount('all'), s.totalActs, `totalActs(${s.totalActs}) != detail all`);
});

// ──────────────────────────────────────────────────────────────────────────
// TASK 2 — score 정규화: solve 는 0~100(비 null), view 는 전부 null.
// ──────────────────────────────────────────────────────────────────────────
test('DRILL-6: content solve items score 0~100(비 null), view items score 전부 null (90d)', async () => {
  const solve = await req(`/perform/detail?bucket=content&segment=solve&${CONTENT_GT_Q}`, STUDENT1);
  assert.equal(solve.status, 200);
  assert.ok(solve.json.items.length > 0, 'solve 항목이 존재해야(90d)');
  for (const it of solve.json.items) {
    assert.ok(it.score != null, `solve item score 는 비 null 이어야. title=${it.title}`);
    assert.ok(it.score >= 0 && it.score <= 100, `solve score(${it.score}) 는 0~100`);
  }
  const view = await req(`/perform/detail?bucket=content&segment=view&${CONTENT_GT_Q}`, STUDENT1);
  assert.equal(view.status, 200);
  assert.ok(view.json.items.length > 0, 'view 항목이 존재해야(90d)');
  for (const it of view.json.items) {
    assert.equal(it.score, null, `view(조회) item score 는 null 이어야. title=${it.title}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// TASK 2 — 권한: 학생은 타 학생 403, 교사/관리자는 200.
// ──────────────────────────────────────────────────────────────────────────
test('DRILL-7: 권한 — 학생은 타 학생 detail 403, 본인 200, 교사/관리자 200', async () => {
  const own = await req(`/perform/detail?bucket=all&days=30`, STUDENT1);
  assert.equal(own.status, 200, '본인 조회 200');

  const otherByStudent = await req(`/perform/detail?bucket=all&days=30&userId=${STUDENT2}`, STUDENT1);
  assert.equal(otherByStudent.status, 403, '학생이 타 학생(userId=4) 조회 → 403');

  const byTeacher = await req(`/perform/detail?bucket=all&days=30&userId=${STUDENT1}`, TEACHER);
  assert.equal(byTeacher.status, 200, '교사가 학생 조회 → 200');
  const byAdmin = await req(`/perform/detail?bucket=all&days=30&userId=${STUDENT1}`, ADMIN);
  assert.equal(byAdmin.status, 200, '관리자가 학생 조회 → 200');
});

test('DRILL-8: 잘못된 bucket → 400', async () => {
  const r = await req(`/perform/detail?bucket=nonsense&days=30`, STUDENT1);
  assert.equal(r.status, 400, '알 수 없는 bucket → 400');
});
