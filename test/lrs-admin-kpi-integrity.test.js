// test/lrs-admin-kpi-integrity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 관리자 한눈 현황 KPI(/api/lrs/stats/admin-kpi) 활동 카운트 정합 불변식 박제.
//   포렌식 감사(2026-07): admin-kpi 의 활동 카운트가 raw learning_logs 를 무필터로 세어
//     · 오늘 활동/DAU/WAU 에 admin·teacher 의 LRS 열람(governance)·content_view(조회)가 섞이고
//     · periodActs(무필터)와 byLevel.acts(학생×학습)가 ~2.5배 어긋나고(합 불성립)
//     · weeklyTrend(전체)와 weeklyTrendByLevel(학생)이 ~9.6배 모순
//   → 모든 활동 카운트를 JOIN users role='student' AND activity_type IN (정본 7종) 로 통일.
//
//   INV-1  periodActs === Σ byLevel.acts + unleveledActs (전체 = 초+중+고 + 무학년, 합 정합)
//   INV-2  각 주 weeklyTrend[i].count === weeklyTrendByLevel[i].total === 초+중+고+무학년
//   INV-3  todayActs/dau/wau/periodActs 계산에 content_view·governance·비학생(교사)이 절대 미포함
//          (합성: 학생 문제풀이 1 + 교사 열람 1 + content_view 1 + governance 1 → todayActs Δ=1)
//   INV-4  정본 7종 외 activity_type(content_view/post_create/attendance/survey/homework_graded/external/lesson_view)은
//          어떤 활동 카운트에도 안 잡힘 (Δ=0). 역으로 정본 7종 각 값은 모두 카운트됨(Δ=+N).
//
// DB 격리: 실 DB → 임시 복사본(_setup). admin id=1. HTTP 하네스는 lrs-reliability-p0 과 동일 패턴.
//   합성 학생/교사·로그는 is_seed=0(실계정)으로 삽입 → 기본(시드 포함) 화면에서 집계됨.
//   구조 불변식(INV-1·INV-2)은 임의 데이터에서 성립 → 라이브 응답에 직접 단언.
//   제외 불변식(INV-3·INV-4)은 삽입 전후 델타로 검증 → 거대·가변 실데이터에 무의존.
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

// 정본 학습활동 7종 (routes/lrs.js LRS_LEARN_ACTIVITY_TYPES 와 반드시 동일해야 함).
//   수업꾸러미 이수·평가·과제·콘텐츠 문항풀이·오늘의 학습(self_learn∪daily_complete)·AI 노드·오답노트.
const LEARN7 = [
  'lesson_progress', 'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'node_complete', 'wrong_note_retry'
];
// 정본 7종 밖(활동 카운트에 절대 안 잡혀야 하는 유형).
const NON_LEARN = [
  'content_view', 'post_create', 'attendance_checkin', 'survey_respond',
  'homework_graded', 'external', 'lesson_view'
];

let server, baseUrl, tdb;

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
const kpi = async (qs = '') => (await req('/stats/admin-kpi' + qs, ADMIN));

let _seq = 0;
function uid() { return `t_akpi_${Date.now()}_${++_seq}_${Math.random().toString(36).slice(2, 6)}`; }
function newUser(role, schoolLevel) {
  return Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role, school_level, is_seed) VALUES (?, ?, 'x', ?, ?, 0)"
  ).run(uid(), 'KPI정합테스트', role, schoolLevel).lastInsertRowid);
}
let insToday, insDaysAgo;
function today(u, type, n = 1) { for (let i = 0; i < n; i++) insToday.run(u, type); }
function daysAgo(u, type, d) { insDaysAgo.run(u, type, `-${d} days`); }

before(async () => {
  tdb = openTestDb();
  insToday = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, is_seed, created_at)
    VALUES (?, ?, 'completed', 0, datetime('now','localtime'))
  `);
  insDaysAgo = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, is_seed, created_at)
    VALUES (?, ?, 'completed', 0, datetime('now','localtime', ?))
  `);

  // ── 구조 불변식(INV-1·INV-2)이 자명하지 않도록 학교급별 + 무학년 학생 학습로그 + 노이즈 시드 ──
  const elemStu = newUser('student', 'elementary');
  const midStu = newUser('student', 'middle');
  const nullStu = newUser('student', null);      // 무학년 → unleveledActs 로 잡혀야 함
  const teacher = newUser('teacher', 'elementary'); // 교사 → 활동 카운트에서 제외되어야 함

  today(elemStu, 'content_solve', 2);   // 초등 학습 2
  today(midStu, 'exam_complete', 1);    // 중등 학습 1
  today(nullStu, 'self_learn', 1);      // 무학년 학습 1 → unleveledActs >= 1
  daysAgo(elemStu, 'content_solve', 2); // 이번 주(≤55일) 학습 1 (weeklyTrend 비자명화)

  // 노이즈(집계에서 반드시 빠져야 하는 것들) — 구조 불변식이 노이즈에 오염되지 않음도 함께 방증.
  today(elemStu, 'content_view', 3);    // 조회 → 제외
  today(teacher, 'content_solve', 2);   // 교사 학습 → 제외(비학생)
  today(elemStu, 'external', 1);        // governance/7종 밖 → 제외

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-1: periodActs === Σ byLevel.acts + unleveledActs (전체↔학교급 합 정합)
// ──────────────────────────────────────────────────────────────────────────
test('INV-1: periodActs === Σ byLevel.acts + unleveledActs (합=전체 보장)', async () => {
  const r = await kpi(); // 기본 30d
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.success, true);
  const sumLevels = d.byLevel.reduce((s, x) => s + x.acts, 0);
  assert.equal(typeof d.kpi.unleveledActs, 'number', 'kpi.unleveledActs 필드 존재');
  assert.equal(d.unleveledActs, d.kpi.unleveledActs, 'top-level unleveledActs 미러 일치');
  assert.equal(d.kpi.periodActs, sumLevels + d.kpi.unleveledActs,
    `periodActs(${d.kpi.periodActs}) !== Σ byLevel(${sumLevels}) + unleveled(${d.kpi.unleveledActs})`);
  // 무학년 학생(nullStu) 학습로그 1건 이상 존재 → unleveledActs 는 음수가 아니고 최소 1.
  assert.ok(d.kpi.unleveledActs >= 1, `unleveledActs 는 무학년 학생 활동 최소 1: ${d.kpi.unleveledActs}`);
  assert.ok(d.kpi.periodActs >= sumLevels, 'periodActs 는 학교급 합 이상(무학년 포함)');
  // 스코프 계약 노출 확인
  assert.deepEqual(d.activityScope.activityTypes.slice().sort(), LEARN7.slice().sort(),
    'activityScope.activityTypes 가 정본 7종과 일치');
  assert.equal(d.activityScope.role, 'student');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-2: 각 주 weeklyTrend[i].count === weeklyTrendByLevel[i].total === 초+중+고+무학년
// ──────────────────────────────────────────────────────────────────────────
test('INV-2: weeklyTrend.count === weeklyTrendByLevel.total (같은 스코프 단일 소스)', async () => {
  const r = await kpi();
  const d = r.json;
  assert.equal(d.weeklyTrend.length, d.weeklyTrendByLevel.length, '주간 배열 길이 일치');
  assert.equal(d.weeklyTrend.length, 8, '8주 버킷');
  for (let i = 0; i < d.weeklyTrend.length; i++) {
    const wt = d.weeklyTrend[i], wl = d.weeklyTrendByLevel[i];
    assert.equal(wt.weeksAgo, wl.weeksAgo, `index ${i} weeksAgo 정렬 일치`);
    assert.equal(wt.count, wl.total, `주 ${wt.weeksAgo}: weeklyTrend.count(${wt.count}) !== byLevel.total(${wl.total})`);
    assert.equal(wl.total, wl.elementary + wl.middle + wl.high + wl.unleveled,
      `주 ${wt.weeksAgo}: total 이 초+중+고+무학년 합과 불일치`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-3: content_view·governance·비학생(교사)이 오늘 활동/DAU/WAU/periodActs 에 미포함.
//   합성: 학생 문제풀이 1 + 교사 열람 1 + content_view 1 + governance 1 → todayActs Δ=1.
// ──────────────────────────────────────────────────────────────────────────
test('INV-3: 조회·거버넌스·비학생 제외 — 학생 학습 1건만 카운트(Δ=1)', async () => {
  const base = (await kpi()).json.kpi;

  const stu = newUser('student', 'elementary'); // 새 학생(오늘 학습 처음)
  const tea = newUser('teacher', 'elementary');
  today(stu, 'content_solve', 1);  // 학생 학습 → +1
  today(tea, 'content_solve', 1);  // 교사 → 제외(비학생)
  today(stu, 'content_view', 1);   // 조회 → 제외
  today(stu, 'external', 1);       // governance/7종 밖 → 제외

  const after = (await kpi()).json.kpi;
  assert.equal(after.todayActs - base.todayActs, 1, 'todayActs 는 학생 학습활동 1건만 증가(조회·교사·거버넌스 제외)');
  assert.equal(after.dau - base.dau, 1, 'DAU 는 학습활동한 새 학생 1명만 증가');
  assert.equal(after.wau - base.wau, 1, 'WAU 도 새 학생 1명만 증가');
  assert.equal(after.periodActs - base.periodActs, 1, 'periodActs 도 학생 학습 1건만 증가');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-4a: 정본 7종 외 activity_type 은 어떤 활동 카운트에도 안 잡힘(Δ=0).
//   학습활동 없는 학생은 DAU/WAU 에도 미포함.
// ──────────────────────────────────────────────────────────────────────────
test('INV-4a: 7종 외 유형만 한 학생 → 모든 활동 카운트 Δ=0 (DAU 미포함)', async () => {
  const base = (await kpi()).json.kpi;
  const stu = newUser('student', 'middle');
  for (const t of NON_LEARN) today(stu, t, 1); // 7 종류의 비학습 로그
  const after = (await kpi()).json.kpi;
  assert.equal(after.todayActs - base.todayActs, 0, '7종 외 로그는 오늘 활동 0 증가');
  assert.equal(after.dau - base.dau, 0, '학습활동 없는 학생은 DAU 미포함');
  assert.equal(after.wau - base.wau, 0, '학습활동 없는 학생은 WAU 미포함');
  assert.equal(after.periodActs - base.periodActs, 0, 'periodActs 0 증가');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-4b: 정본 7종 각 값은 모두 카운트됨(역방향 커버리지 — 누락 유형 0).
//   한 학생이 7종 각 1건 → todayActs Δ = LEARN7.length, DAU Δ=1.
// ──────────────────────────────────────────────────────────────────────────
test('INV-4b: 정본 7종 각 유형은 모두 활동으로 카운트(Δ=+7종수, DAU +1)', async () => {
  const base = (await kpi()).json.kpi;
  const stu = newUser('student', 'high');
  for (const t of LEARN7) today(stu, t, 1);
  const after = (await kpi()).json.kpi;
  assert.equal(after.todayActs - base.todayActs, LEARN7.length,
    `정본 7종(${LEARN7.length}값) 각 1건 → todayActs Δ=${LEARN7.length}`);
  assert.equal(after.dau - base.dau, 1, '한 학생이 학습 → DAU +1');
  assert.equal(after.periodActs - base.periodActs, LEARN7.length, 'periodActs 도 7종수만큼 증가');
});
