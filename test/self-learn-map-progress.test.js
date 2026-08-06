// test/self-learn-map-progress.test.js
// ─────────────────────────────────────────────────────────────────────────────
// AI 학습맵 진행률 = "문항" 기준 회귀 박제 (2026-08-06 사용자 확정 정책).
//
// 사용자 확정 정책
//   · 단원 진행률 = 그 단원의 문항을 **총 집계**한 뒤 완료한 것 기준
//   · 차시 진행률 = 그 차시 안의 문항 수 기준
//   · 영상은 봐도 안 봐도 그만 → **진행률 계산에서 완전히 제외**
//
// 수정 전 결함 (사용자 화면 캡처 지적)
//   ① 학습맵 리스트 뷰의 단원 "9까지의 수"(초1-1학기)가 "진행중 50%" 인데
//      그 아래 차시 5개는 전부 0% · 영상 0/1 · 문항 0/8 이었다.
//      - 50% 의 출처: learning-map.html 의 상태 기반 폴백
//        `status === 'in_progress' ? 50 : ...` (단원 노드에는 콘텐츠가 직접
//        달려 있지 않아 실제 계산 분기를 못 타고 이 폴백으로 떨어졌다).
//      - "진행중" 배지의 출처: db/self-learn-extended.js getUserNodeStatuses 의
//        단원 합성 상태 — 자식 차시가 하나라도 in_progress 면 단원을 in_progress
//        로 승격. 문항을 하나도 안 풀어도(0/41) '학습 시작'만 눌렀으면 승격됐다.
//   ② routes/self-learn.js 차시 목록 API 가 진행률에 영상을 50% 반영했다
//      (`(watchedV/totalV)*50 + (solvedP/totalP)*50`).
//
// 불변식
//   INV-MAP1  진행률에 영상이 반영되지 않는다 (영상 시청률만 올려도 진행률 불변)
//   INV-MAP2  차시 진행률 = 그 차시 문항 기준
//   INV-MAP3  단원 진행률 = 자식 차시 문항 **총합** 기준 (차시 평균과 다르다)
//   INV-MAP4  문항을 하나도 완료하지 않으면 단원은 0% — "진행중 50%" 가 안 나온다
//             (실 DB 의 실제 단원 U62dce328384a98e6 + student1 로 재현)
//   INV-MAP5  learning-map.html 에 `in_progress ? 50` 형태의 상태 기반 진행률
//             추정이 남아 있지 않다 (소스 락)
//
// ⚠ "완료" 판정은 기존 정의를 그대로 쓴다 = problem_attempts 에 is_correct=1 이
//    한 번이라도 기록된 문항. (화면의 "문항 n/m" 칩과 같은 값)
//
// 라우트 테스트는 exam-period-gate.test.js 의 node:http + x-test-user 패턴을 따른다.
// 계정(실 DB 실측): student1 = uid 3.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb(); // ★ db 모듈 require 전에 DB_PATH 주입(복사본) — 실 DB 무오염

const express = require('express');
const session = require('express-session');
const selfLearnDb = require('../db/self-learn-extended');

const STUDENT1 = 3;
// 사용자가 지적한 실제 단원: 초1-1학기 수학 "9까지의 수" (차시 5개 · 문항 41개 · 완료 0)
const REAL_UNIT = 'U62dce328384a98e6';

// 테스트 전용 합성 단원 (복사본 DB 안에서만 생성)
const T_UNIT = 'TESTU_MAPPROG';
const T_L1 = 'TESTL_MAPPROG_1';  // 문항 1개(그중 1개 완료) + 영상 1개
const T_L2 = 'TESTL_MAPPROG_2';  // 문항 9개(완료 0)
const T_L3 = 'TESTL_MAPPROG_3';  // 문항 0개 (빈 차시)

let server, baseUrl, db;
let vidId = null;               // T_L1 의 영상 content id
const p1 = [], p2 = [];          // 각 차시의 문항 content id

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/self-learn', require('../routes/self-learn'));
  return app;
}

function req(method, p, asUser, bodyObj) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const r = http.request(baseUrl + p, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// 승인·공개된 콘텐츠 1건 생성 후 노드에 매핑
function seedContent(db, nodeId, type, title) {
  const info = db.prepare(`
    INSERT INTO contents (creator_id, title, content_type, is_public, status, subject, created_at)
    VALUES (1, ?, ?, 1, 'approved', '수학', datetime('now'))
  `).run(title, type);
  const cid = info.lastInsertRowid;
  db.prepare('INSERT INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?,?,?,0)')
    .run(nodeId, cid, type === 'video' ? 'learn' : 'practice');
  return cid;
}

before(async () => {
  db = openTestDb();

  // ── 합성 단원/차시 (복사본 전용) ────────────────────────────────────────────
  const insNode = db.prepare(`
    INSERT INTO learning_map_nodes
      (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name, node_level, parent_node_id, sort_order)
    VALUES (?, '수학', '초', 1, 1, '수와 연산', '진행률테스트단원', ?, ?, ?, ?)
  `);
  insNode.run(T_UNIT, null, 2, null, 900);
  insNode.run(T_L1, '진행률테스트 차시1', 3, T_UNIT, 1);
  insNode.run(T_L2, '진행률테스트 차시2', 3, T_UNIT, 2);
  insNode.run(T_L3, '진행률테스트 차시3(문항없음)', 3, T_UNIT, 3);

  // 차시1: 문항 1개 + 영상 1개 / 차시2: 문항 9개 / 차시3: 없음
  p1.push(seedContent(db, T_L1, 'quiz', '테스트문항 L1-1'));
  vidId = seedContent(db, T_L1, 'video', '테스트영상 L1');
  for (let i = 1; i <= 9; i++) p2.push(seedContent(db, T_L2, 'quiz', `테스트문항 L2-${i}`));

  // 차시1의 문항 1개만 정답 처리 → 단원 총합 1/10 = 10%
  //   (차시 진행률의 평균이면 (100 + 0 + 0)/3 = 33% 로 총합과 확연히 다르다)
  db.prepare(`INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, submitted_at)
              VALUES (?,?,?,1, datetime('now'))`).run(STUDENT1, p1[0], T_L1);

  // 자식 차시를 '학습 시작' 상태로 → 예전 규칙이면 단원이 '진행중' 으로 승격되던 조건
  db.prepare(`INSERT OR REPLACE INTO user_node_status (user_id, node_id, status) VALUES (?,?, 'in_progress')`)
    .run(STUDENT1, T_L2);

  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { db && db.close(); } catch (_) {}
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MAP1 — 진행률에 영상이 반영되지 않는다
// ─────────────────────────────────────────────────────────────────────────────
test('INV-MAP1 영상 시청은 진행률을 움직이지 않는다 (차시·단원 모두)', async () => {
  const before1 = await req('GET', `/api/self-learn/map/nodes/${T_UNIT}/lessons`, STUDENT1);
  assert.equal(before1.status, 200, '차시 목록 200');
  const l1Before = before1.json.lessons.find(l => l.node_id === T_L1);
  assert.ok(l1Before, '차시1 존재');
  assert.equal(l1Before.videos_total, 1, '영상 칩 필드는 유지되어야 한다(화면에 표시됨)');
  assert.equal(l1Before.videos_watched, 0);
  const unitBefore = before1.json.unit.progress_percent;

  // 영상을 100% 시청 처리 (문항은 그대로)
  db.prepare(`INSERT OR REPLACE INTO user_content_progress
              (user_id, content_id, node_id, watch_ratio, view_count, updated_at)
              VALUES (?,?,?,1.0,1, datetime('now'))`).run(STUDENT1, vidId, T_L1);

  // ★ finally 원복 필수 — 실패로 중단돼도 시청 기록이 남으면 뒤 테스트의 전제가 오염된다
  try {
    const after1 = await req('GET', `/api/self-learn/map/nodes/${T_UNIT}/lessons`, STUDENT1);
    const l1After = after1.json.lessons.find(l => l.node_id === T_L1);
    assert.equal(l1After.videos_watched, 1, '영상 시청 수는 반영(칩 표시용)');
    assert.equal(
      l1After.progress_percent, l1Before.progress_percent,
      `영상만 봤는데 차시 진행률이 변했다 (${l1Before.progress_percent}% → ${l1After.progress_percent}%). ` +
      '진행률은 문항 기준이어야 한다.'
    );
    assert.equal(
      after1.json.unit.progress_percent, unitBefore,
      '영상만 봤는데 단원 진행률이 변했다'
    );

    // 목록 API(getMapNodes) 쪽 롤업도 동일해야 한다
    const nodes = selfLearnDb.getMapNodes({ userId: STUDENT1 });
    const unitRow = nodes.find(n => n.node_id === T_UNIT);
    assert.equal(unitRow.progress_percent, unitBefore, '목록 API 단원 진행률도 영상에 흔들리면 안 된다');

    // 차시 카드(맵 뷰)도 마찬가지 — 영상 칩 수치는 오르되 진행률은 그대로
    const l1Row = nodes.find(n => n.node_id === T_L1);
    assert.equal(l1Row.videos_total, 1, '차시 카드의 영상 칩 필드는 표시용으로 존재해야 한다');
    assert.equal(l1Row.videos_watched, 1, '영상 시청 수는 반영');
    assert.equal(l1Row.progress_percent, l1Before.progress_percent,
      '목록 API 차시 진행률이 영상 시청으로 변했다');
    assert.equal(unitRow.videos_total, undefined, '단원 카드에는 영상 칩을 붙이지 않는다(문항·차시 수만)');
  } finally {
    db.prepare('DELETE FROM user_content_progress WHERE user_id=? AND content_id=?').run(STUDENT1, vidId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MAP2 — 차시 진행률 = 그 차시 문항 기준
// ─────────────────────────────────────────────────────────────────────────────
test('INV-MAP2 차시 진행률은 그 차시 문항 수 기준으로 계산된다', async () => {
  const r = await req('GET', `/api/self-learn/map/nodes/${T_UNIT}/lessons`, STUDENT1);
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.lessons.map(l => [l.node_id, l]));

  // 차시1: 문항 1개 중 1개 완료 → 100%
  assert.equal(byId[T_L1].problems_total, 1);
  assert.equal(byId[T_L1].problems_solved, 1);
  assert.equal(byId[T_L1].progress_percent, 100, '1/1 → 100%');

  // 차시2: 문항 9개 중 0개 완료 → 0% (user_node_status 가 in_progress 여도 0)
  assert.equal(byId[T_L2].problems_total, 9);
  assert.equal(byId[T_L2].problems_solved, 0);
  assert.equal(byId[T_L2].user_status, 'in_progress', '전제: 학습 시작 상태');
  assert.equal(
    byId[T_L2].progress_percent, 0,
    "'진행중' 상태만으로 진행률을 지어내면 안 된다 (예전 폴백 30%)"
  );

  // 차시3: 문항 0개 → 0% (영상도 없음)
  assert.equal(byId[T_L3].problems_total, 0);
  assert.equal(byId[T_L3].progress_percent, 0, '문항 없는 차시는 0%');

  // 전 차시 공통: 진행률은 문항 비율과 정확히 일치해야 한다
  for (const l of r.json.lessons) {
    const expect = l.problems_total > 0
      ? Math.round((l.problems_solved / l.problems_total) * 100)
      : 0;
    assert.equal(l.progress_percent, expect,
      `${l.node_id} 진행률 불일치: ${l.progress_percent} != ${expect} (문항 ${l.problems_solved}/${l.problems_total})`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MAP3 — 단원 진행률 = 자식 차시 문항 총합 (평균이 아니다)
// ─────────────────────────────────────────────────────────────────────────────
test('INV-MAP3 단원 진행률은 자식 차시 문항의 총합 기준 (차시 평균 아님)', async () => {
  const r = await req('GET', `/api/self-learn/map/nodes/${T_UNIT}/lessons`, STUDENT1);
  const lessons = r.json.lessons;

  const totalP = lessons.reduce((a, l) => a + l.problems_total, 0);
  const solvedP = lessons.reduce((a, l) => a + l.problems_solved, 0);
  assert.equal(totalP, 10, '전제: 차시별 문항 1 + 9 + 0 = 10 (차시마다 문항 수가 다르다)');
  assert.equal(solvedP, 1);

  const expectTotalBased = Math.round((solvedP / totalP) * 100);   // 10%
  const avgOfLessons = Math.round(
    lessons.reduce((a, l) => a + (l.problems_total ? (l.problems_solved / l.problems_total) * 100 : 0), 0) / lessons.length
  ); // (100+0+0)/3 = 33%
  assert.notEqual(expectTotalBased, avgOfLessons, '전제: 총합 기준과 차시 평균이 달라야 구분이 된다');

  // ① 차시 목록 API 의 unit
  assert.equal(r.json.unit.problems_total, 10);
  assert.equal(r.json.unit.problems_solved, 1);
  assert.equal(r.json.unit.progress_percent, expectTotalBased,
    `단원 진행률이 총합 기준(${expectTotalBased}%)이 아니다 — 차시 평균(${avgOfLessons}%) 등 다른 산식이 쓰였다`);

  // ② 목록 API(getMapNodes, 학습맵 카드가 쓰는 경로)
  const nodes = selfLearnDb.getMapNodes({ userId: STUDENT1 });
  const unitRow = nodes.find(n => n.node_id === T_UNIT);
  assert.ok(unitRow, '단원 노드가 목록에 있어야 한다');
  assert.equal(unitRow.problems_total, 10, '단원 목록 응답에 자식 차시 문항 총합이 실려야 한다');
  assert.equal(unitRow.problems_solved, 1);
  assert.equal(unitRow.progress_percent, expectTotalBased);
  assert.notEqual(unitRow.progress_percent, avgOfLessons);

  // ③ 두 경로(단원 목록 / 차시 목록)가 같은 값을 말해야 한다
  assert.equal(unitRow.progress_percent, r.json.unit.progress_percent,
    '단원 카드와 단원 상세의 진행률이 서로 다르면 안 된다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MAP4 — 사용자 지적의 직접 재현: 문항 0건 완료 단원은 0% · '진행중' 아님
// ─────────────────────────────────────────────────────────────────────────────
test("INV-MAP4 문항을 하나도 완료 안 한 단원은 0% 이고 '진행중 50%' 가 안 나온다 (실 단원 U62dce328384a98e6)", async () => {
  // 전제 — 실 DB 픽스처: student1 은 이 단원의 문항을 하나도 못 맞혔다
  const r = await req('GET', `/api/self-learn/map/nodes/${REAL_UNIT}/lessons`, STUDENT1);
  assert.equal(r.status, 200, '차시 목록 200');
  assert.equal(r.json.unit.unit_name, '9까지의 수', '전제: 대상 단원이 바뀌지 않았다');
  assert.equal(r.json.lessons.length, 5, '전제: 차시 5개');
  assert.equal(r.json.unit.problems_total, 41, '전제: 단원 문항 총합 41개');
  assert.equal(r.json.unit.problems_solved, 0, '전제: 완료 문항 0개');

  // ① 단원 진행률 0% (50% 아님)
  assert.equal(r.json.unit.progress_percent, 0,
    '문항 0/41 인데 단원 진행률이 0% 가 아니다');

  // ② 차시도 전부 0%
  for (const l of r.json.lessons) {
    assert.equal(l.problems_solved, 0, `${l.lesson_name} 전제: 완료 문항 0`);
    assert.equal(l.progress_percent, 0, `${l.lesson_name} 진행률이 0% 가 아니다`);
  }

  // ③ 단원 카드(목록 API)도 0%
  const nodes = selfLearnDb.getMapNodes({ userId: STUDENT1 });
  const unitRow = nodes.find(n => n.node_id === REAL_UNIT);
  assert.ok(unitRow);
  assert.equal(unitRow.progress_percent, 0, '단원 카드 진행률이 0% 가 아니다');
  assert.notEqual(unitRow.progress_percent, 50, '"진행중 = 50%" 폴백이 살아 있다');

  // ④ 배지 상태: 자식 차시에 in_progress 가 있어도 단원을 '진행중' 으로 승격하지 않는다
  //    (승격되면 화면이 다시 상태 기반 색·라벨로 "진행 중"을 말하게 된다)
  const childInProgress = db.prepare(`
    SELECT COUNT(*) c FROM learning_map_nodes n
    JOIN user_node_status u ON u.node_id = n.node_id AND u.user_id = ?
    WHERE n.parent_node_id = ? AND n.node_level = 3 AND u.status = 'in_progress'
  `).get(STUDENT1, REAL_UNIT).c;
  assert.ok(childInProgress > 0, '전제: 자식 차시 중 in_progress 가 존재 (예전 승격 조건)');

  const statuses = selfLearnDb.getUserNodeStatuses(STUDENT1);
  const unitStatus = statuses.find(s => s.node_id === REAL_UNIT);
  assert.equal(unitStatus, undefined,
    `문항을 하나도 안 푼 단원이 '${unitStatus && unitStatus.status}' 로 합성됐다 — 배지가 "진행중"으로 뜬다`);

  // ⑤ 반대 방향(과잉 수정 방지): 문항을 실제로 푼 단원은 진행중이 유지되고 0% 가 아니다
  const tStatus = statuses.find(s => s.node_id === T_UNIT);
  assert.ok(tStatus, '문항을 1개라도 완료한 단원은 상태 합성이 유지되어야 한다');
  assert.equal(tStatus.status, 'in_progress');
  const tRow = nodes.find(n => n.node_id === T_UNIT);
  assert.ok(tRow.progress_percent > 0, '문항을 푼 단원까지 0% 로 만들면 과잉 수정이다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MAP6 — 같은 화면 상단 KPI("N개 진행 중")가 학습맵 배지와 어긋나지 않는다
//   학습맵 카드는 getUserNodeStatuses, 상단 KPI 는 getLearningDashboard 로 산식이
//   따로 있다. 게이트를 한쪽에만 넣으면 "3개 진행 중" vs 카드 1개로 모순이 생긴다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-MAP6 상단 KPI 진행 중 단원 수 == 학습맵에서 진행중으로 뜨는 단원 수', () => {
  const dash = selfLearnDb.getLearningDashboard(STUDENT1);
  const statuses = selfLearnDb.getUserNodeStatuses(STUDENT1);
  const units = new Set(
    db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_level = 2').all().map(r => r.node_id)
  );
  const mapInProgress = statuses.filter(s => units.has(s.node_id) && s.status === 'in_progress').length;
  assert.equal(dash.inProgressNodes, mapInProgress,
    `상단 KPI(${dash.inProgressNodes}개 진행 중)와 학습맵 진행중 단원 수(${mapInProgress})가 다르다`);

  // 문항 0건 완료 단원(9까지의 수)은 어느 쪽에서도 진행 중으로 세지 않는다
  assert.equal(statuses.some(s => s.node_id === REAL_UNIT && s.status === 'in_progress'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MAP5 (소스 락) — 화면에 상태 기반 진행률 추정이 남아 있으면 안 된다
// ─────────────────────────────────────────────────────────────────────────────
test('INV-MAP5 learning-map.html 에 상태 기반 진행률 추정(in_progress ? 50)이 없다', () => {
  const file = path.join(__dirname, '..', 'public', 'self-learn', 'learning-map.html');
  const src = fs.readFileSync(file, 'utf8');

  // 주석(//, /* */)을 제거한 뒤 검사 — 재발 방지 설명 주석까지 잡지 않도록.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  // status 를 진행률 숫자로 바꾸는 삼항식: `'in_progress' ? 50` / `'completed' ? 100` 등
  const bad = [];
  const re = /['"](?:in_progress|completed|diagnosing|mastered)['"]\s*\?\s*\d+/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const lineNo = code.slice(0, m.index).split('\n').length;
    bad.push(`${lineNo}행: ${m[0]}`);
  }
  assert.deepEqual(bad, [],
    '상태로 진행률을 지어내는 폴백이 남아 있다 (진행률은 백엔드의 문항 기준 값만 사용):\n' + bad.join('\n'));
});
