// test/lrs-behavior-phase3.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS Phase 3 — 심화 행동분석 하네스 (BE 불변식 박제)
//   기획: 보고서/LRS_Phase3_행동성취_방법론_API_v1.md · _UI_기획_v1.md
//   대상: GET /api/lrs/stats/behavior?scope=class&classId=&signal=speed|retry|participation|rewatch
//
//   INV-BH1  응답 구조 — 4신호 모두 groups[](배열)·insights[](1~2)·caveats[](비어있지 않음)·
//            metricLabel·unit·studentCount·seedNoticeText 존재.
//   INV-BH2  마스킹 — 그룹 masked ⇔ n<5. masked→value===null(0채움 금지). 5≤n<10→lowConfidence.
//            비마스킹 value ∈ [0,100].
//   INV-BH3  caveats 필수 — 연관≠인과·소표본·역인과·교란·시드 5종 포함(신호별). 비어있지 않음.
//   INV-BH4  권한 — 비소유 403 · classId 누락 400 · bad signal 400.
//   INV-BH5  participation 실테이블 — byActivity(lesson/homework/exam) 존재 · onTime.available===false
//            (합성 id 조인 계측 금지). 2그룹(참여/미참여).
//   INV-BH6  retry 2그룹 — 정확히 [오답 재풀이함, 재풀이 안 함].
//   INV-BH7  인과 단정 금지 — insights[].text 에 금지어('때문에','영향') 미포함(관찰형 강제).
//   INV-BH8  rewatch 정직 — available===false(반 스코프) · reason 존재 · masked===true(억지 그래프 금지).
//   INV-BH9  speed 위임 — getShallowLearning 소비: matrix 존재 · 속도밴드 3그룹(빠름/보통/느림).
//   INV-BH10 realOnly — studentCount(realOnly) ≤ studentCount(전체) · caveats·seedNoticeText 여전히 존재.
//
//   DB 격리: 실 DB → 임시 복사본(_setup). 계정: teacher1=2. HTTP 하네스 패턴은
//   lrs-benchmark-phase2 와 동일(x-test-user 세션 주입).
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
const MASK_N = 5;
const LOWCONF_N = 10;
const SIGNALS = ['speed', 'retry', 'participation', 'rewatch'];

let server, baseUrl, tdb;
let ownedClassId, notOwnedClassId;

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
  // teacher1 소유 · student 멤버가 있는 반
  const owned = tdb.prepare("SELECT id FROM classes WHERE owner_id = ? ORDER BY id").all(TEACHER1);
  for (const c of owned) {
    const n = tdb.prepare(`SELECT COUNT(*) n FROM class_members cm JOIN users u ON u.id=cm.user_id WHERE cm.class_id=? AND u.role='student'`).get(c.id).n;
    if (n >= 3) { ownedClassId = c.id; break; }
  }
  assert.ok(ownedClassId, 'teacher1 소유 · student 멤버 반을 찾지 못함');

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

// ── 공통 구조·마스킹·정직성 불변식(4신호 순회) ────────────────────────────────
function assertGroupMasking(b, label) {
  assert.ok(Array.isArray(b.groups), `${label}: groups 배열 아님`);
  for (const g of b.groups) {
    // INV-BH2: 마스킹 규칙
    assert.equal(g.masked, g.n < MASK_N, `${label}/${g.key}: masked 규칙(n<${MASK_N}) 위반 (n=${g.n})`);
    if (g.masked) {
      assert.equal(g.value, null, `${label}/${g.key}: masked 인데 value 노출(0채움 금지 위반)`);
    } else {
      assert.ok(inRangeOrNull(g.value, 0, 100), `${label}/${g.key}: value 범위 위반 (${g.value})`);
      const expectLow = g.n < LOWCONF_N;
      assert.equal(!!g.lowConfidence, expectLow, `${label}/${g.key}: lowConfidence(5≤n<10) 규칙 위반 (n=${g.n})`);
    }
  }
}

function assertCommonHonesty(b, label) {
  // INV-BH1: 구조
  assert.ok(Array.isArray(b.insights) && b.insights.length >= 1 && b.insights.length <= 2, `${label}: insights 1~2 위반 (${b.insights && b.insights.length})`);
  assert.ok(typeof b.metricLabel === 'string' && b.metricLabel.length > 0, `${label}: metricLabel 없음`);
  assert.equal(b.unit, '%', `${label}: unit 불일치`);
  assert.ok(typeof b.studentCount === 'number', `${label}: studentCount 없음`);
  assert.ok(typeof b.seedNoticeText === 'string' && b.seedNoticeText.length > 0, `${label}: seedNoticeText 없음`);
  // INV-BH3: caveats 필수(비어있지 않음 + 연관≠인과 + 시드 문구)
  assert.ok(Array.isArray(b.caveats) && b.caveats.length >= 4, `${label}: caveats 4종 이상 필수`);
  const joined = b.caveats.join(' ');
  assert.ok(joined.includes('연관성') && joined.includes('원인'), `${label}: '연관≠인과' 캐비어트 누락`);
  assert.ok(joined.includes('시연용 시드'), `${label}: 시드 캐비어트 누락`);
  assert.ok(/역인과/.test(joined), `${label}: 역인과 캐비어트 누락`);
  assert.ok(/교란변수/.test(joined), `${label}: 교란변수 캐비어트 누락`);
  // INV-BH7: 인과 단정 금지 — insights 관찰형
  for (const it of b.insights) {
    assert.ok(!/때문에|영향/.test(it.text || ''), `${label}: insight 인과 단정 금지어 포함 → "${it.text}"`);
    assert.ok(['info', 'warn', 'danger', 'good'].includes(it.level), `${label}: insight level 이상 (${it.level})`);
  }
}

for (const signal of SIGNALS) {
  test(`INV-BH1/2/3/7: ${signal} — 구조·마스킹·caveats·관찰형`, async () => {
    const r = await req(`/stats/behavior?scope=class&classId=${ownedClassId}&signal=${signal}`, TEACHER1);
    assert.equal(r.status, 200, `${signal}: 200 아님 (${r.status})`);
    const b = r.json;
    assert.equal(b.success, true);
    assert.equal(b.signal, signal);
    assertGroupMasking(b, signal);
    assertCommonHonesty(b, signal);
  });
}

// ── INV-BH4: 권한 ─────────────────────────────────────────────────────────────
test('INV-BH4: 권한 — 비소유 403 · classId 누락 400 · bad signal 400', async () => {
  const r403 = await req(`/stats/behavior?classId=${notOwnedClassId}&signal=retry`, TEACHER1);
  assert.equal(r403.status, 403, '비소유 반이 403 아님');
  const rNoClass = await req(`/stats/behavior?signal=retry`, TEACHER1);
  assert.equal(rNoClass.status, 400, 'classId 누락이 400 아님');
  const rBadSig = await req(`/stats/behavior?classId=${ownedClassId}&signal=bogus`, TEACHER1);
  assert.equal(rBadSig.status, 400, 'bad signal 이 400 아님');
});

// ── INV-BH5: participation 실테이블 ──────────────────────────────────────────
test('INV-BH5: participation — 실 제출테이블·byActivity·onTime 비계측·2그룹', async () => {
  const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=participation`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.ok(b.byActivity && typeof b.byActivity.lesson.n === 'number' && typeof b.byActivity.homework.n === 'number' && typeof b.byActivity.exam.n === 'number', 'byActivity(lesson/homework/exam) 누락');
  assert.ok(b.onTime && b.onTime.available === false && typeof b.onTime.reason === 'string', 'onTime 은 비계측(available:false)이어야 함');
  assert.equal(b.groups.length, 2, 'participation 은 참여/미참여 2그룹');
  assert.deepEqual(b.groups.map(g => g.key), ['participated', 'not_participated']);
});

// ── INV-BH6: retry 2그룹 ─────────────────────────────────────────────────────
test('INV-BH6: retry — 정확히 2그룹(재풀이 유/무)', async () => {
  const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=retry`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.equal(b.groups.length, 2, 'retry 는 2그룹');
  assert.deepEqual(b.groups.map(g => g.key), ['retried', 'not_retried']);
});

// ── INV-BH8: rewatch — Phase 4a 로 계약 변경(video/replay 하위호환 alias) ─────
//   기존 "정직 비노출(available:false)" 계약은 Phase 4a 에서 데모 계측 활성화로 대체.
//   이제 rewatch 는 signal=video&sub=replay 로 승격되어 완주/재시청/건너뛰기 중 재시청 지표를 반환한다.
//   (available 값은 시드 유무에 따라 달라지므로 단언하지 않고, alias 구조·정직 플래그를 박제한다.)
test('INV-BH8: rewatch — video/replay 하위호환 alias(demoInstrumented·once/few/many)', async () => {
  const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=rewatch`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.equal(b.signal, 'rewatch', 'rewatch 는 요청 신호 그대로 echo');
  assert.equal(b.sub, 'replay', 'rewatch → sub=replay 로 매핑');
  assert.equal(b.demoInstrumented, true, 'video 계약: demoInstrumented 플래그');
  assert.equal(b.instrumentation, 'demo', "video 계약: instrumentation==='demo'");
  assert.deepEqual(b.groups.map(g => g.key), ['once', 'few', 'many'], '재시청 밴드 once/few/many');
  assert.ok((b.caveats || []).join(' ').includes('데모 계측'), 'video caveats 에 데모 계측 문구 필요');
});

// ── INV-BH9: speed 위임 ──────────────────────────────────────────────────────
test('INV-BH9: speed — getShallowLearning 위임(matrix·속도밴드 3그룹)', async () => {
  const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=speed`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.ok(b.matrix && b.matrix.correct && b.matrix.wrong, 'speed 는 getShallowLearning matrix 를 실어야 함');
  assert.equal(b.groups.length, 3, 'speed 속도밴드 3그룹(빠름/보통/느림)');
  assert.deepEqual(b.groups.map(g => g.key), ['fast', 'normal', 'slow']);
});

// ── INV-BH10: realOnly ───────────────────────────────────────────────────────
test('INV-BH10: realOnly — 실사용자 필터로 studentCount 축소·정직성 유지', async () => {
  const full = await req(`/stats/behavior?classId=${ownedClassId}&signal=retry`, TEACHER1);
  const real = await req(`/stats/behavior?classId=${ownedClassId}&signal=retry&realOnly=1`, TEACHER1);
  assert.equal(full.status, 200); assert.equal(real.status, 200);
  assert.ok(real.json.studentCount <= full.json.studentCount, 'realOnly studentCount 가 전체보다 크면 안 됨');
  assert.equal(real.json.realOnly, true);
  // 정직성: realOnly 여도 caveats·seedNoticeText 존재
  assert.ok(Array.isArray(real.json.caveats) && real.json.caveats.length >= 4);
  assert.ok(typeof real.json.seedNoticeText === 'string' && real.json.seedNoticeText.length > 0);
});
