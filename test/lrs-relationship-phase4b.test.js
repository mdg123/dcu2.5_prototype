// test/lrs-relationship-phase4b.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS Phase 4b — 학급 관계·정서(실명 소시오그램) BE 불변식 하네스
//   기획 정본: 보고서/LRS_Phase4b_교우관계_PIA_기획서_v2.md (§3 지표·§4 계약·§7 권한/audit·§8 데모)
//   대상: GET /api/lrs/stats/relationship?classId=&period=  (+ /behavior/social-climate alias)
//
//   INV-1  권한 — 비소유 교사/학생/타반 403, 소유 교사 자기반 200, classId 누락 400.
//   INV-2  노드 개인결합 차단 — nodes[i] 에 emotion/score/sentiment 등 개인 감정·성취 필드 부재(스키마 강제).
//   INV-3  익명성 보호 — 익명 글(is_anonymous=1)은 작성자 미귀속(edges from/to·participation.posts 에서 제외).
//   INV-4  자기 루프 0 — 자기 글 자기 댓글은 엣지에 없음(from===to 부재).
//   INV-5  정서 마스킹 — emotionClimate n<5 → masked=true·수치 null. n≥5 → 긍정/중립/부정 %.
//   INV-6  소표본 — smallSample === (nodeCount < 20).
//   INV-7  고지 — caveats non-empty(상관≠인과·신호≠판정·목적제한·화면공유금지)·purposeNote 존재.
//   INV-8  네트워크 지표 부재 — 응답·노드에 centrality/cluster/cohesion/degree 등 키 없음.
//   INV-9  데모 시드 — 시드 후 데모학급 nodeCount≥20·엣지>0·demoInstrumented=true. 시드 전(edges 0) 대비.
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

let server, baseUrl, tdb, seed;
let demoClassId, demoStudentIds = [];
let ownedRealClassId, notOwnedClassId, studentUserId;
let ctrlClassId, ctrlA, ctrlB, ctrlC;
let preSnap;   // 데모 학급 콘텐츠 시드 "전" 스냅샷(INV-9 전/후 대비)

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

// 통제 픽스처(INV-3/4/5) — 익명 귀속 제외·자기루프 제외를 결정론으로 검증할 미니 학급.
//   A: 비익명 글 P1 · B: 익명 글 P2 · C→P1 댓글(엣지 C→A) · A→P2 댓글(익명, 제외) · A→P1 자기댓글(자기루프 제외).
function buildControlledFixture() {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const insU = tdb.prepare(`INSERT INTO users (username, password, display_name, role, is_seed, status) VALUES (?, 'x', ?, 'student', 1, 'active')`);
  ctrlA = insU.run('ctrl_soc_A', '가학생').lastInsertRowid;
  ctrlB = insU.run('ctrl_soc_B', '나학생').lastInsertRowid;
  ctrlC = insU.run('ctrl_soc_C', '다학생').lastInsertRowid;
  const info = tdb.prepare(`INSERT INTO classes (code, name, description, owner_id, class_type, status, is_public) VALUES ('CTRLSOC1', '[통제] 익명검증반', 't', ?, '기타', 'active', 0)`).run(TEACHER1);
  ctrlClassId = info.lastInsertRowid;
  tdb.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')").run(ctrlClassId, TEACHER1);
  for (const id of [ctrlA, ctrlB, ctrlC]) tdb.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'member', 'active')").run(ctrlClassId, id);
  // 게시글
  const insP = tdb.prepare(`INSERT INTO posts (class_id, author_id, title, content, is_anonymous, created_at) VALUES (?, ?, ?, 't', ?, ?)`);
  const p1 = insP.run(ctrlClassId, ctrlA, 'P1(비익명)', 0, now).lastInsertRowid;   // A 비익명
  const p2 = insP.run(ctrlClassId, ctrlB, 'P2(익명)', 1, now).lastInsertRowid;     // B 익명
  // 댓글
  const insC = tdb.prepare(`INSERT INTO comments (post_id, author_id, content, parent_id, created_at) VALUES (?, ?, 't', ?, ?)`);
  insC.run(p1, ctrlC, null, now);   // C → P1 → 엣지 C→A (comment)
  insC.run(p2, ctrlA, null, now);   // A → P2(익명) → 대상 미귀속(제외)
  insC.run(p1, ctrlA, null, now);   // A → 자기 글 P1 → 자기루프(제외)
}

before(async () => {
  tdb = openTestDb();

  // teacher1 소유 · 실 게시판 데이터가 있을 법한 반(소표본 실학급) — INV-1(200)·INV-6(smallSample true).
  const owned = tdb.prepare("SELECT id FROM classes WHERE owner_id = ? ORDER BY id").all(TEACHER1);
  ownedRealClassId = owned.length ? owned[0].id : null;
  assert.ok(ownedRealClassId, 'teacher1 소유 반을 찾지 못함');

  notOwnedClassId = tdb.prepare(`
    SELECT id FROM classes WHERE owner_id != ? AND id NOT IN (SELECT class_id FROM class_members WHERE user_id = ?)
    ORDER BY id LIMIT 1
  `).get(TEACHER1, TEACHER1).id;
  assert.ok(notOwnedClassId, '비소유 반을 찾지 못함');

  buildControlledFixture();

  // 데모 시드 — 격리 copy 에 직접(seed 모듈 재사용). 콘텐츠는 preSnap 캡처 후 주입(전/후 대비).
  seed = require('../scripts/seed-demo-social');
  seed.migrate();
  demoClassId = seed.ensureClass();
  demoStudentIds = seed.ensureStudents(demoClassId);
  studentUserId = demoStudentIds[0];   // 학생 계정(role=student) — INV-1 학생 403 검증용
  // ★ REWORK-1: 로컬 DB 에 데모 소셜 데이터가 --apply 되어 있어도 결정적으로 통과하도록,
  //   preSnap("전") 캡처 전에 격리 copy 의 기존 데모 콘텐츠(is_seed 게시글·댓글·감정)를 먼저 clean.
  seed.purgeContent(demoClassId, demoStudentIds);

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // INV-9 "전" — 학생만 있고 콘텐츠 없음(로컬 상태 무관하게 clean 직후) → nodeCount≥20·edges 0.
  preSnap = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;

  // 콘텐츠·감정 주입("후")
  seed.seedContent(demoClassId, demoStudentIds);
  seed.seedEmotions(demoClassId, demoStudentIds);
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

const NETWORK_KEYS = ['centrality', 'betweenness', 'closeness', 'eigenvector', 'cluster', 'clustering', 'cohesion', 'modularity', 'community', 'degree'];

test('INV-1: 권한 — 소유 200 · 비소유 403 · 학생 403 · classId 누락 400', async () => {
  const ok = await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1);
  assert.equal(ok.status, 200, '소유 교사 자기반 200 아님');
  assert.equal(ok.json.success, true);

  const notOwned = await req(`/stats/relationship?classId=${notOwnedClassId}&period=term`, TEACHER1);
  assert.equal(notOwned.status, 403, '비소유 반이 403 아님');

  const stu = await req(`/stats/relationship?classId=${demoClassId}&period=term`, studentUserId);
  assert.equal(stu.status, 403, '학생 계정이 403 아님(역할 차단)');

  const noClass = await req(`/stats/relationship?period=term`, TEACHER1);
  assert.equal(noClass.status, 400, 'classId 누락이 400 아님');

  // alias 경로도 동일 동작
  const alias = await req(`/behavior/social-climate?classId=${demoClassId}&period=term`, TEACHER1);
  assert.equal(alias.status, 200, 'alias 경로 200 아님');
});

test('INV-2: 노드 개인결합 차단 — 감정·성취 필드 부재(스키마 강제)', async () => {
  const b = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  assert.ok(Array.isArray(b.graph.nodes) && b.graph.nodes.length > 0, '노드 비어있음');
  const NODE_KEYS = new Set(['id', 'label', 'participation']);
  const PART_KEYS = new Set(['posts', 'commentsGiven', 'commentsReceived']);
  const FORBIDDEN = ['emotion', 'emotionScore', 'emotion_score', 'score', 'sentiment', 'mood', 'reach', 'reachRate', 'mastery', 'risk'];
  for (const nd of b.graph.nodes) {
    for (const k of Object.keys(nd)) assert.ok(NODE_KEYS.has(k), `노드에 허용되지 않은 키: ${k}`);
    for (const f of FORBIDDEN) assert.ok(!(f in nd), `노드에 개인결합 금지 필드: ${f}`);
    for (const k of Object.keys(nd.participation)) assert.ok(PART_KEYS.has(k), `participation 에 허용되지 않은 키: ${k}`);
    for (const f of FORBIDDEN) assert.ok(!(f in nd.participation), `participation 에 금지 필드: ${f}`);
  }
});

test('INV-3: 익명성 보호 — 익명 글 작성자 미귀속(edges·posts 제외)', async () => {
  const b = (await req(`/stats/relationship?classId=${ctrlClassId}&period=term`, TEACHER1)).json;
  assert.equal(b.nodeCount, 3, '통제 학급 노드 3 아님');
  const nodeA = b.graph.nodes.find(n => n.id === ctrlA);
  const nodeB = b.graph.nodes.find(n => n.id === ctrlB);
  const nodeC = b.graph.nodes.find(n => n.id === ctrlC);
  // A: 비익명 글 1 · B: 익명 글만 → posts 0(익명 제외)
  assert.equal(nodeA.participation.posts, 1, 'A 비익명 글 1 이어야');
  assert.equal(nodeB.participation.posts, 0, 'B 익명 글은 participation.posts 에서 제외되어야(0)');
  // 엣지: C→A(comment) 단 하나. B(익명 글 작성자)는 엣지 대상에 없음.
  assert.equal(b.graph.edges.length, 1, `엣지 1개여야(실제 ${b.graph.edges.length})`);
  const e = b.graph.edges[0];
  assert.deepEqual({ from: e.from, to: e.to, type: e.type }, { from: ctrlC, to: ctrlA, type: 'comment' }, '엣지 C→A(comment) 아님');
  assert.ok(!b.graph.edges.some(x => x.to === ctrlB || x.from === ctrlB), 'B(익명 글 작성자)가 엣지에 귀속되면 안 됨');
  // A 의 익명 글 댓글은 commentsGiven 에 미포함(엣지와 정합)
  assert.equal(nodeA.participation.commentsGiven, 0, 'A 의 익명 글 댓글은 귀속 제외 → commentsGiven 0');
  assert.equal(nodeA.participation.commentsReceived, 1, 'A 받은 댓글 1(C→A)');
  assert.equal(nodeC.participation.commentsGiven, 1, 'C 준 댓글 1');
});

test('INV-4: 자기 루프 0 — from===to 엣지 부재', async () => {
  for (const cid of [ctrlClassId, demoClassId]) {
    const b = (await req(`/stats/relationship?classId=${cid}&period=term`, TEACHER1)).json;
    assert.ok(!b.graph.edges.some(e => e.from === e.to), `class ${cid}: 자기 루프 엣지 존재`);
  }
});

test('INV-5: 정서 마스킹 — n<5 masked · n≥5 %', async () => {
  // 통제 학급: attendance 없음 → n<5 → masked
  const ctrl = (await req(`/stats/relationship?classId=${ctrlClassId}&period=term`, TEACHER1)).json;
  assert.equal(ctrl.emotionClimate.masked, true, '통제 학급 정서 masked 아님');
  assert.ok(ctrl.emotionClimate.n < 5, 'n<5 아님');
  assert.equal(ctrl.emotionClimate.positive, null, 'masked 인데 positive 수치 노출');
  // 데모 학급: 감정 n≥5 → 수치
  const demo = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  assert.equal(demo.emotionClimate.masked, false, '데모 학급 정서 masked 이면 안 됨(n≥5)');
  assert.ok(demo.emotionClimate.n >= 5, '데모 감정 n>=5 아님');
  const { positive, neutral, negative } = demo.emotionClimate;
  for (const v of [positive, neutral, negative]) assert.ok(typeof v === 'number' && v >= 0 && v <= 100, '정서 % 범위 위반');
  assert.ok(Math.abs(positive + neutral + negative - 100) <= 2, '정서 % 합 ≈100 아님');
});

test('INV-6: 소표본 — smallSample === (nodeCount<20)', async () => {
  const demo = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  assert.ok(demo.nodeCount >= 20, `데모 nodeCount≥20 아님(${demo.nodeCount})`);
  assert.equal(demo.smallSample, false, '데모(≥20) smallSample 이면 안 됨');
  const small = (await req(`/stats/relationship?classId=${ownedRealClassId}&period=term`, TEACHER1)).json;
  assert.equal(small.smallSample, small.nodeCount < 20, 'smallSample=nodeCount<20 규칙 위반');
});

test('INV-7: 고지 — caveats non-empty·purposeNote', async () => {
  const b = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  assert.ok(Array.isArray(b.caveats) && b.caveats.length > 0, 'caveats 비어있음');
  const cj = b.caveats.join(' ');
  assert.ok(/상관≠인과/.test(cj), '상관≠인과 caveat 누락');
  assert.ok(/판정이 아/.test(cj), '신호≠판정 caveat 누락');
  assert.ok(/목적 제한/.test(cj), '목적 제한 caveat 누락');
  assert.ok(/화면 공유/.test(cj), '화면 공유 금지 caveat 누락');
  assert.ok(typeof b.purposeNote === 'string' && /상담·평가·생활지도/.test(b.purposeNote), 'purposeNote 목적제한 문구 누락');
  // 데모 학급 → 합성 데이터 고지 + demoInstrumented
  assert.ok(/합성 데이터/.test(cj), '데모 합성 데이터 caveat 누락');
});

test('INV-8: 네트워크 지표 부재 — centrality/cluster/cohesion/degree 키 없음', async () => {
  const b = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  const topKeys = Object.keys(b);
  for (const k of NETWORK_KEYS) assert.ok(!topKeys.includes(k), `응답 최상위에 네트워크 지표 키: ${k}`);
  for (const k of Object.keys(b.graph)) assert.ok(!NETWORK_KEYS.includes(k), `graph 에 네트워크 지표 키: ${k}`);
  for (const nd of b.graph.nodes) for (const k of Object.keys(nd)) assert.ok(!NETWORK_KEYS.includes(k), `노드에 네트워크 지표 키: ${k}`);
});

test('INV-9: 데모 시드 — 시드 후 nodeCount≥20·엣지>0·demoInstrumented (전/후 대비)', async () => {
  // 전(콘텐츠 없음): 노드는 있으나 엣지 0
  assert.ok(preSnap.nodeCount >= 20, `시드 전 nodeCount≥20 아님(${preSnap && preSnap.nodeCount})`);
  assert.equal(preSnap.graph.edges.length, 0, '시드 전 엣지 0 이어야');
  assert.equal(preSnap.demoInstrumented, true, '데모 학급 demoInstrumented=true 아님');
  assert.equal(preSnap.instrumentation, 'demo', 'demo instrumentation 아님');
  // 후(콘텐츠 주입): 엣지>0
  const after = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  assert.ok(after.nodeCount >= 20, `시드 후 nodeCount≥20 아님(${after.nodeCount})`);
  assert.ok(after.graph.edges.length > 0, '시드 후 엣지>0 아님');
  assert.equal(after.demoInstrumented, true, '시드 후 demoInstrumented=true 아님');
  assert.equal(after.seedNotice, true, '데모 학급 seedNotice=true 아님(전원 is_seed)');
  // 엣지 type 은 comment|reply 만
  for (const e of after.graph.edges) assert.ok(['comment', 'reply'].includes(e.type), `엣지 type 불량: ${e.type}`);
});

test('INV-10: realOnly — 데모반 realOnly=1 → 합성 제외(nodeCount 0·edges 0·demoInstrumented false)', async () => {
  // 데모반은 전원 is_seed 학생 + is_seed 콘텐츠 → realOnly=1 시 실멤버 0 → 노드/엣지 0.
  const ro = (await req(`/stats/relationship?classId=${demoClassId}&period=term&realOnly=1`, TEACHER1)).json;
  assert.equal(ro.realOnly, true, 'realOnly echo true 아님');
  assert.equal(ro.demoInstrumented, false, 'realOnly=1 인데 demoInstrumented true(정직 위반)');
  assert.equal(ro.instrumentation, 'live', 'realOnly=1 instrumentation live 아님');
  assert.equal(ro.seedNotice, false, 'realOnly=1 인데 seedNotice true(합성 제외했는데 고지)');
  assert.equal(ro.nodeCount, 0, `realOnly=1 데모반 실멤버 0 아님(${ro.nodeCount})`);
  assert.equal(ro.graph.edges.length, 0, 'realOnly=1 데모반 엣지 0 아님');
  assert.equal(ro.emotionClimate.masked, true, 'realOnly=1 데모반 정서 실데이터 없음 → masked');
  // 대비: realOnly 미적용 시 데모반은 그대로 풍부(nodeCount≥20·edges>0·demo).
  const full = (await req(`/stats/relationship?classId=${demoClassId}&period=term`, TEACHER1)).json;
  assert.ok(full.nodeCount >= 20 && full.graph.edges.length > 0 && full.demoInstrumented === true, 'full 뷰 대비 확인 실패');
  // 통제(실계정) 학급도 realOnly 여부와 무관하게 정상 응답(오류 없이 200).
  const ctrlRo = await req(`/stats/relationship?classId=${ctrlClassId}&period=term&realOnly=1`, TEACHER1);
  assert.equal(ctrlRo.status, 200, '통제 학급 realOnly=1 200 아님');
});
