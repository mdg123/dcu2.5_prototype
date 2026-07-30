// test/lrs-behavior-phase4a.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS Phase 4a — 영상 학습 행동(완주율·재시청·건너뛰기) ↔ 성취 하네스 (BE 불변식 박제)
//   기획: 보고서/LRS_Phase4a_영상행동_방법론_API_v1.md(정본 산식·시드·API) · _UI_기획_v1.md(FE 계약)
//   대상: GET /api/lrs/stats/behavior?signal=video&sub=completion|replay|seek  (+ rewatch alias)
//
//   INV-V1  응답 구조 — video 3 sub 각각 groups[]·insights[](1~2)·caveats[](비어있지 않음)·
//           demoInstrumented===true·instrumentation==='demo'·seedNotice===true·metricLabel·unit.
//   INV-V2  마스킹 — group masked ⇔ n<5. masked→value===null(0채움 금지). 5≤n<10→lowConfidence.
//   INV-V3  밴드 스펙 — completion[low,mid,full]·replay[once,few,many]·seek[low,high]. seek medianThreshold.
//   INV-V4  activation — 시드 후 주요 밴드 unmask → available:true(3 sub 모두). realOnly=1 → 빈 결과.
//   INV-V5  metrics 우산 — sub 미지정 시 metrics.length===3, keys [completion,replay,seek].
//   INV-V6  rewatch 하위호환 — signal echo 'rewatch' · sub 'replay' · groups[once,few,many] · demoInstrumented.
//   INV-V7  caveats 정직 — 연관≠인과·소표본·역인과·교란·데모 계측 포함. 오독차단 disclaimer(재시청 도움/건너뛰기 무해).
//   INV-V8  권한/검증 — 비소유 403 · classId 누락 400 · bad sub 400.
//   INV-V9  인과 단정 금지 — insights[].text 에 '때문에','영향' 미포함(관찰형 강제).
//   INV-V10 GT 무오염 — 시드는 user_content_progress 만 변경. uid3·uid13 learning_logs 카운트 불변.
//
//   DB 격리: 실 DB → 임시 복사본(_setup). 계정: teacher1=2. 시드는 이 테스트가 격리 copy 에 직접 주입.
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

let server, baseUrl, tdb;
let ownedClassId, notOwnedClassId, studentIds = [], manyStudentIds = [];

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

// 격리 copy 에 결정론 데모 관측치 주입 — 밴드 마스킹 패턴을 확정(재시청 many 만 마스킹)한다.
//   완주 3밴드/재시청 once·few/건너뛰기 2밴드 = 전원(≥5) unmask, 재시청 many = 3명(<5) 마스킹.
function seedVideoFixture() {
  // 1) 마이그레이션(멱등) — seek_count·is_seed 컬럼 확인 후 추가.
  const cols = new Set(tdb.prepare('PRAGMA table_info(user_content_progress)').all().map(c => c.name));
  if (!cols.has('seek_count')) tdb.exec('ALTER TABLE user_content_progress ADD COLUMN seek_count INTEGER DEFAULT 0');
  if (!cols.has('is_seed')) tdb.exec('ALTER TABLE user_content_progress ADD COLUMN is_seed INTEGER DEFAULT 0');

  // 2) 대상 학생(소유 반 role=student). clean slate(라이브 시드 상태 무관하게 결정론) — is_seed=1 만 제거.
  studentIds = tdb.prepare(
    "SELECT u.id FROM class_members cm JOIN users u ON u.id=cm.user_id WHERE cm.class_id=? AND u.role='student' ORDER BY u.id"
  ).all(ownedClassId).map(r => r.id);
  assert.ok(studentIds.length >= 5, `소유 반 학생 ${studentIds.length}명 (마스킹 회피 위해 ≥5 필요)`);
  const ph = studentIds.map(() => '?').join(',');
  tdb.prepare(`DELETE FROM user_content_progress WHERE is_seed=1 AND user_id IN (${ph})`).run(...studentIds);

  // 3) 영상 콘텐츠 6개.
  const vids = tdb.prepare("SELECT id FROM contents WHERE content_type='video' ORDER BY id LIMIT 6").all().map(r => r.id);
  assert.ok(vids.length >= 6, `영상 콘텐츠 ${vids.length}개(≥6 필요)`);

  const ins = tdb.prepare(`
    INSERT INTO user_content_progress (user_id, content_id, position_sec, duration_sec, watch_ratio, view_count, seek_count, is_seed, updated_at)
    VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, content_id) DO UPDATE SET
      watch_ratio=excluded.watch_ratio, view_count=excluded.view_count, seek_count=excluded.seek_count, is_seed=1
  `);
  // [wr, vc, seek] — 밴드 커버: low/mid/full(완주) · once/few(재시청) · seek 저/고.
  const baseObs = [
    [0.30, 1, 0], // low  · once · seek저
    [0.70, 2, 3], // mid  · few  · seek고
    [0.95, 1, 0], // full · once · seek저
    [0.85, 3, 4], // mid  · few  · seek고
    [1.00, 1, 1], // full · once · seek저
  ];
  const manyObs = [0.40, 5, 6]; // low · many(4+) · seek고 — 앞 3명에게만 → many 밴드 n=3(마스킹)
  manyStudentIds = studentIds.slice(0, 3);
  const tx = tdb.transaction(() => {
    studentIds.forEach((uid, idx) => {
      baseObs.forEach(([wr, vc, seek], k) => {
        const dur = 600; ins.run(uid, vids[k], Math.round(dur * Math.min(wr, 1)), dur, wr, vc, seek);
      });
      if (idx < 3) { const [wr, vc, seek] = manyObs; ins.run(uid, vids[5], Math.round(600 * Math.min(wr, 1)), 600, wr, vc, seek); }
    });
  });
  tx();
}

const inRangeOrNull = (v, lo, hi) => v == null || (typeof v === 'number' && v >= lo && v <= hi);

before(async () => {
  tdb = openTestDb();
  const owned = tdb.prepare("SELECT id FROM classes WHERE owner_id = ? ORDER BY id").all(TEACHER1);
  for (const c of owned) {
    const n = tdb.prepare(`SELECT COUNT(*) n FROM class_members cm JOIN users u ON u.id=cm.user_id WHERE cm.class_id=? AND u.role='student'`).get(c.id).n;
    if (n >= 5) { ownedClassId = c.id; break; }
  }
  assert.ok(ownedClassId, 'teacher1 소유 · student ≥5 반을 찾지 못함');

  notOwnedClassId = tdb.prepare(`
    SELECT id FROM classes WHERE owner_id != ? AND id NOT IN (SELECT class_id FROM class_members WHERE user_id = ?)
    ORDER BY id LIMIT 1
  `).get(TEACHER1, TEACHER1).id;
  assert.ok(notOwnedClassId, '비소유 반을 찾지 못함');

  seedVideoFixture();

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

function assertMasking(b, label) {
  assert.ok(Array.isArray(b.groups) && b.groups.length > 0, `${label}: groups 비어있음`);
  for (const g of b.groups) {
    assert.equal(g.masked, g.n < MASK_N, `${label}/${g.key}: masked 규칙(n<${MASK_N}) 위반 (n=${g.n})`);
    if (g.masked) assert.equal(g.value, null, `${label}/${g.key}: masked 인데 value 노출(0채움 금지)`);
    else {
      assert.ok(inRangeOrNull(g.value, 0, 100), `${label}/${g.key}: value 범위 위반 (${g.value})`);
      assert.equal(!!g.lowConfidence, g.n < LOWCONF_N, `${label}/${g.key}: lowConfidence(5≤n<10) 규칙 위반 (n=${g.n})`);
    }
  }
}
function assertVideoHonesty(b, label) {
  assert.equal(b.demoInstrumented, true, `${label}: demoInstrumented 플래그 누락`);
  assert.equal(b.instrumentation, 'demo', `${label}: instrumentation !== 'demo'`);
  assert.equal(b.seedNotice, true, `${label}: seedNotice 누락`);
  assert.equal(b.unit, '%', `${label}: unit 불일치`);
  assert.ok(typeof b.metricLabel === 'string' && b.metricLabel.length, `${label}: metricLabel 없음`);
  assert.ok(Array.isArray(b.insights) && b.insights.length >= 1 && b.insights.length <= 2, `${label}: insights 1~2 위반`);
  const cj = (b.caveats || []).join(' ');
  assert.ok(b.caveats.length >= 5, `${label}: caveats 5종 이상`);
  assert.ok(cj.includes('연관성') && cj.includes('원인'), `${label}: 연관≠인과 caveat 누락`);
  assert.ok(/역인과/.test(cj), `${label}: 역인과 caveat 누락`);
  assert.ok(/교란변수/.test(cj), `${label}: 교란변수 caveat 누락`);
  assert.ok(/데모 계측/.test(cj), `${label}: 데모 계측 caveat 누락`);
  for (const it of b.insights) assert.ok(!/때문에|영향/.test(it.text || ''), `${label}: insight 인과 단정 금지어 → "${it.text}"`);
}

const SUB_KEYS = { completion: ['low', 'mid', 'full'], replay: ['once', 'few', 'many'], seek: ['low', 'high'] };

for (const sub of ['completion', 'replay', 'seek']) {
  test(`INV-V1/2/3/9: video&sub=${sub} — 구조·마스킹·밴드·관찰형`, async () => {
    const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=${sub}`, TEACHER1);
    assert.equal(r.status, 200, `${sub}: 200 아님 (${r.status})`);
    const b = r.json;
    assert.equal(b.success, true);
    assert.equal(b.signal, 'video');
    assert.equal(b.sub, sub);
    assert.deepEqual(b.groups.map(g => g.key), SUB_KEYS[sub], `${sub}: 밴드 키/순서 불일치`);
    if (sub === 'seek') assert.ok(typeof b.medianThreshold === 'number', 'seek medianThreshold 누락');
    assertMasking(b, sub);
    assertVideoHonesty(b, sub);
  });
}

test('INV-V4: activation — 시드 후 3 sub 모두 available:true · realOnly=1 은 빈 결과', async () => {
  for (const sub of ['completion', 'replay', 'seek']) {
    // [2026-07-30 시한폭탄 부분 완화] available 은 _behaviorAchMap(성취 원천 = 실 DB
    //   learning_logs)이 창 안에 있어야 true 다. 기본 창은 90일 → 실 로그가 2026-07-16 에
    //   멈춰 있어 2026-10-14 경 붕괴한다(카나리아 119일에서 재현, 63일에서는 통과).
    //   ※ /stats/behavior 는 period 를 {30d,90d,term} 화이트리스트로만 받아(routes/lrs.js
    //     L3262·BEHAV_PERIOD_DAYS L2731) from/to 데이터 유도 창을 표현할 수 없다. 따라서
    //     최장인 term(180일)로 완화만 가능 — 도화선이 2027-01 경으로 밀릴 뿐 제거는 아니다.
    //     근본 해결은 (a) /stats/behavior 에 from/to 지원 추가 또는 (b) GT 데이터 재시드.
    const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=${sub}&period=term`, TEACHER1);
    assert.equal(r.json.available, true, `${sub}: 시드 후 available 이어야 함`);
    const unmasked = r.json.groups.filter(g => !g.masked).length;
    assert.ok(unmasked >= 2, `${sub}: 주요 2밴드 이상 unmask 필요 (unmasked=${unmasked})`);
  }
  // 재시청 many 밴드는 3명(<5) → 마스킹(정직) 확인.
  const rp = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=replay`, TEACHER1);
  const many = rp.json.groups.find(g => g.key === 'many');
  assert.equal(many.masked, true, 'replay many(4회+) 밴드는 3명이라 마스킹 되어야 함');
  // realOnly=1 → 데모 시드 제외 → 빈 결과.
  const rr = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=completion&realOnly=1`, TEACHER1);
  assert.equal(rr.json.observations, 0, 'realOnly=1 관측치 0');
  assert.equal(rr.json.available, false, 'realOnly=1 available:false');
  assert.equal(rr.json.empty, true, 'realOnly=1 empty:true');
});

test('INV-V5: metrics 우산 — sub 미지정 시 3지표 한 페이로드', async () => {
  const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=video`, TEACHER1);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.metrics) && r.json.metrics.length === 3, 'metrics 3개');
  assert.deepEqual(r.json.metrics.map(m => m.key), ['completion', 'replay', 'seek']);
  assert.equal(r.json.demoInstrumented, true);
  for (const m of r.json.metrics) assertMasking(m, `umbrella/${m.key}`);
});

test('INV-V6: rewatch 하위호환 alias → video/replay', async () => {
  const r = await req(`/stats/behavior?classId=${ownedClassId}&signal=rewatch`, TEACHER1);
  assert.equal(r.status, 200);
  const b = r.json;
  assert.equal(b.signal, 'rewatch', 'rewatch 는 요청 신호 그대로 echo');
  assert.equal(b.sub, 'replay', 'rewatch → sub=replay');
  assert.deepEqual(b.groups.map(g => g.key), ['once', 'few', 'many']);
  assertVideoHonesty(b, 'rewatch');
});

test('INV-V7: 오독 차단 disclaimer — 재시청=도움 신호 · 건너뛰기=무해', async () => {
  const rp = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=replay`, TEACHER1);
  assert.ok(/도움 신호/.test(rp.json.disclaimer || ''), 'replay disclaimer 에 "도움 신호" 프레이밍 필요');
  const rs = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=seek`, TEACHER1);
  assert.ok(/이미 아는/.test(rs.json.disclaimer || ''), 'seek disclaimer 에 "이미 아는 내용" 무해 프레이밍 필요');
});

test('INV-V8: 권한/검증 — 비소유 403 · classId 누락 400 · bad sub 400', async () => {
  const r403 = await req(`/stats/behavior?classId=${notOwnedClassId}&signal=video&sub=completion`, TEACHER1);
  assert.equal(r403.status, 403, '비소유 반이 403 아님');
  const rNoClass = await req(`/stats/behavior?signal=video&sub=completion`, TEACHER1);
  assert.equal(rNoClass.status, 400, 'classId 누락이 400 아님');
  const rBadSub = await req(`/stats/behavior?classId=${ownedClassId}&signal=video&sub=bogus`, TEACHER1);
  assert.equal(rBadSub.status, 400, 'bad sub 이 400 아님');
});

test('INV-V10: GT 무오염 — 시드는 user_content_progress 만 변경(learning_logs 불변)', async () => {
  // 시드는 before() 에서 완료. uid3·uid13 의 learning_logs 는 시드가 건드리지 않으므로,
  //   is_seed=1 ucp 행이 존재하되 그 학생들의 채점 로그(성취 원천)는 그대로여야 한다.
  for (const uid of [3, 13]) {
    const ucp = tdb.prepare('SELECT COUNT(*) c FROM user_content_progress WHERE user_id=? AND is_seed=1').get(uid).c;
    const llScored = tdb.prepare('SELECT COUNT(*) c FROM learning_logs WHERE user_id=? AND result_score IS NOT NULL').get(uid).c;
    assert.ok(ucp > 0, `uid${uid}: 데모 ucp 관측치 존재`);
    assert.ok(llScored > 0, `uid${uid}: 채점 learning_logs 보존(성취 원천)`);
  }
  // ucp 시드가 learning_logs 를 늘리지 않았음(활동유형 content 관련 신규 로그 0) — 정본 불변 근거.
  const seedLogs = tdb.prepare("SELECT COUNT(*) c FROM learning_logs WHERE context_registration='demo_video_v1'").get().c;
  assert.equal(seedLogs, 0, 'video 시드는 learning_logs 에 기록하지 않아야 함(GT 무오염)');
});
