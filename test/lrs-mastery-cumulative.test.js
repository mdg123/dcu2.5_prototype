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

// ── CUMUL 픽스처 ────────────────────────────────────────────────────────────
//   [2026-08-04 GT 재작성] 예전 CUMUL-1/2 는 "uid3 의 미도달 5건"을 상수로 박아뒀다.
//   그 5건은 집계 결함(무필터 분모)의 산물이었고 — 5개 코드 모두 정오 판정 로그 0건 —
//   W2-a 로 분모가 정화되자 사라졌다. 실 시드 스냅샷을 GT 로 쓰면 이렇게 근거가 증발한다.
//   → 이제 테스트가 **직접 만든 데이터**로 GT 를 세운다:
//        시도 4 · 정답 1 = 25% (<50) · 시도 ≥3  ⇒ 미도달  (정본사전 §1-A-1)
//      로그를 **200일 전**에 두어 7/30/90d 창 바깥에 배치 — 기간 스코프가 되살아나면
//      notReached 가 0 으로 떨어져 즉시 붉어진다(이 검사의 존재 이유).
let CUMUL_UID;
const CUMUL_OLD_CODE = '[4수97-01]';   // 200일 전 미도달
const CUMUL_NEW_CODE = '[4수97-02]';   // 3일 전 도달(대조군)

//   ★ 집계 행은 손으로 넣지 않는다 — 운영 경로(logLearningActivity)가 로그에서 파생하게 둔다.
//     그래야 집계기가 망가지면 이 검사도 함께 붉어진다(집계 우회 = 검사 무력화).
function seedCumulFixture(tdb) {
  const { logLearningActivity } = require('../db/learning-log-helper');
  const uid = Number(tdb.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES ('t_cumul_seed', 'x', '누적판정시드', 'student')"
  ).run().lastInsertRowid);
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) + ' 10:00:00'; };
  const put = (code, success, ago, seq) => logLearningActivity({
    userId: uid, activityType: 'exam_complete', targetType: 'exam', targetId: 9700000 + seq,
    verb: 'completed', sourceService: 'exam', resultScore: success ? 1 : 0, resultSuccess: success,
    achievementCode: code, subjectCode: 'math-e', createdAt: daysAgo(ago),
  });
  [0, 0, 0, 1].forEach((s, i) => put(CUMUL_OLD_CODE, s, 200, i));       // 4시도 1정답 = 25% → 미도달
  [1, 1, 1].forEach((s, i) => put(CUMUL_NEW_CODE, s, 3, 10 + i));       // 3시도 3정답 = 100% → 도달
  return uid;
}

before(async () => {
  { const t = openTestDb(); CUMUL_UID = seedCumulFixture(t); }
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
test('CUMUL-1: 창 밖(200일 전) 미도달은 period 7/30/90/무관 항상 계수 (HTTP)', async () => {
  const paths = ['', '?period=7d', '?period=30d', '?period=90d'].map(q => `/mastery/student/${CUMUL_UID}${q}`);
  for (const p of paths) {
    const r = await req(p, CUMUL_UID);
    assert.equal(r.status, 200, `${p} → 200`);
    assert.equal(r.json.counts.notReached, 1,
      `${p}: 창 밖 미도달이 은폐됨(notReached=${r.json.counts.notReached}, 기대 1)`);
    assert.equal(r.json.counts.reached, 1,
      `${p}: 창 안 도달 1건도 유지돼야(실제=${r.json.counts.reached})`);
    assert.equal(r.json.scoped, false, `${p}: scoped=false(누적)`);
    assert.equal(r.json.period, null, `${p}: period=null(누적)`);
  }
});

test('CUMUL-2: 창 밖 미도달 코드가 weaknesses 에 남아 있어야 (period 무관)', async () => {
  for (const q of ['', '?period=7d', '?period=90d']) {
    const p = `/mastery/student/${CUMUL_UID}${q}`;
    const r = await req(p, CUMUL_UID);
    assert.equal(r.status, 200);
    // route 는 label 을 단원명으로 relabel 하지만 code 는 원본 유지.
    const nr = (r.json.weaknesses || []).filter(w => w.status === 'not_reached');
    const nrCodes = new Set(nr.map(w => w.code));
    assert.ok(nrCodes.has(CUMUL_OLD_CODE), `${p}: 미도달 코드 ${CUMUL_OLD_CODE} 누락(은폐)`);
    assert.equal(nrCodes.size, 1, `${p}: 미도달 코드 수 1이어야. 실제=${nrCodes.size}`);
    // 분자/분모가 화면까지 그대로 실려야 "왜 미도달인지"가 자명하다(정본사전 §6-10-5).
    const row = nr.find(w => w.code === CUMUL_OLD_CODE);
    assert.equal(row.attempts, 4, `${p}: attempts 4(테스트가 심은 시도 수)`);
    assert.equal(row.correct, 1, `${p}: correct 1(테스트가 심은 정답 수)`);
    assert.equal(row.rate, 25, `${p}: rate 25(=1/4) — 분자·분모에서 유도된 값`);
    // 도달(100%)은 약점에 섞이면 안 된다.
    assert.ok(!(r.json.weaknesses || []).some(w => w.code === CUMUL_NEW_CODE),
      `${p}: 도달 코드 ${CUMUL_NEW_CODE} 가 약점에 혼입`);
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

test('DRILL-3: content 은 단일유형 버킷 → 소계 미제공 계약 + 각 segment count===items.length (30d)', async () => {
  const r = await req(`/perform/detail?bucket=content&days=30`, STUDENT1);
  assert.equal(r.status, 200);
  // [수정 2026-07-31 / 재감리 2026-07-31] 과거 `if (segments !== undefined)` 로 감쌌으나,
  //   PERFORM_BUCKET_TYPES.content = ['content_solve'] (1원소) 이므로 라우트의 `types.length > 1`
  //   가드가 영원히 false → segments 는 **항상 undefined** 였고, 안쪽 단언은 구조적으로 도달 불가였다.
  //   (테스트 이름은 "소계 합 == count" 를 광고하는데 실제로는 아무것도 검사하지 않던 죽은 검사)
  //   → 조건부를 없애고 **현행 설계의 계약을 무조건 단언**한다. 누군가 content 버킷에 유형을
  //     되돌려 넣으면(=소계가 다시 생기면) 이 단언이 즉시 터져 소계 불변식 복원을 강제한다.
  const segments = r.json.segments;
  assert.equal(segments, undefined,
    'content 는 단일 유형(content_solve) 버킷이라 세그먼트 소계를 내보내지 않아야 한다 ' +
    '— 소계가 부활했다면 "소계 합 == count" 불변식도 함께 되살려야 한다');
  for (const seg of ['view', 'lesson', 'solve']) {
    const sr = await req(`/perform/detail?bucket=content&segment=${seg}&days=30`, STUDENT1);
    assert.equal(sr.status, 200, `segment=${seg} → 200`);
    // ① 형태 무관 불변식 — 표시값(count)과 내역(items) 은 항상 일치
    assert.equal(sr.json.items.length, Math.min(sr.json.count, 200),
      `segment=${seg}: count(${sr.json.count}) != items.length(${sr.json.items.length})`);
    // ② (구) 소계-상세 교차 검증은 segments 가 항상 undefined 라 도달 불가였으므로 제거.
    //    위에서 "소계 미제공"을 무조건 단언하므로 여기서 다시 볼 것이 없다.
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
