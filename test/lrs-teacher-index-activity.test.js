// test/lrs-teacher-index-activity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 교사 "나의 수업 활동 요약"(t-teacher-idx) BE 확장 회귀 박제.
//   기획서: 보고서/LRS_교사_운영메뉴_리네이밍_보강_기획서_v1.md §3
//   대상: GET /api/lrs/stats/teacher-index (교사 스코프, scope='mine' 강제)
//
//   ★ 핵심 버그(재발 방지): lessons_held 가 learning_logs.activity_type='lesson_view'
//     AND user_id=tid 를 세어 교사는 항상 0 이었다. → lessons.teacher_id 소유 기준으로 교체.
//     (라이브 확인: teacher_id=2 실제 수업 30건인데 API 는 0 반환하던 버그.)
//
//   INV-T1  lessons_held == lessons.teacher_id COUNT(기간창) 과 일치. 시드 3건 → 0 아님.
//   INV-T2  scope 는 항상 'mine'(교사). scope=all 요청해도 교사는 mine 로 강등.
//   INV-T3  응답 계약: prev·trend·recent 키 존재. prev 는 4지표 객체.
//   INV-T4  recent ≤ 10건, 각 원소 {type∈content|lesson|exam|feedback, title, class_name, date},
//           date 내림차순 정렬.
//   INV-T5  trend 버킷: 각 원소 {label, contents, lessons, exams, feedback} 정수, 기간 반응
//           (7d=일별 8칸 / 90d=월별 다수) — 버킷수가 기간에 따라 달라진다.
//   INV-T6  prev = 직전 동일폭 기간 카운트. 시드 배치로 현재>0·직전=0 확인 가능.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 시드는 먼 미래 유저(간섭 최소).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

// ── HTTP 하네스 (lrs-keris-p0.test.js 와 동일 패턴) ──────────────────────────
let server, baseUrl, tdb;
let SEED_TID, SEED_CLASS, SEED_HW, SEED_SUB;
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

before(async () => {
  tdb = openTestDb();
  // 새 교사 계정 (실 데이터와 안 겹치게).
  SEED_TID = Number(tdb.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES ('t_idx_seed','x','활동요약시드','teacher')"
  ).run().lastInsertRowid);
  SEED_CLASS = Number(tdb.prepare(
    "INSERT INTO classes (code, name, owner_id) VALUES ('TIDX01','활동요약테스트반',?)"
  ).run(SEED_TID).lastInsertRowid);

  // 최근(now) 기준 시드 — 현재 기간(7d/30d/90d)에 잡힘.
  //   수업 3건 · 콘텐츠 2건 · 평가 1건 · 피드백 1건.
  const L = tdb.prepare("INSERT INTO lessons (class_id, teacher_id, title, created_at) VALUES (?,?,?,datetime('now'))");
  L.run(SEED_CLASS, SEED_TID, '시드수업1');
  L.run(SEED_CLASS, SEED_TID, '시드수업2');
  L.run(SEED_CLASS, SEED_TID, '시드수업3');
  const C = tdb.prepare("INSERT INTO contents (creator_id, title, created_at) VALUES (?,?,datetime('now'))");
  C.run(SEED_TID, '시드콘텐츠1');
  C.run(SEED_TID, '시드콘텐츠2');
  tdb.prepare("INSERT INTO exams (title, answers, owner_id, class_id, created_at) VALUES (?,?,?,?,datetime('now'))")
    .run('시드평가1', '[]', SEED_TID, SEED_CLASS);
  // 피드백: homework → submission → feedback 체인.
  SEED_HW = Number(tdb.prepare("INSERT INTO homework (class_id, teacher_id, title, created_at) VALUES (?,?,?,datetime('now'))")
    .run(SEED_CLASS, SEED_TID, '시드과제1').lastInsertRowid);
  SEED_SUB = Number(tdb.prepare("INSERT INTO homework_submissions (homework_id, student_id) VALUES (?,?)")
    .run(SEED_HW, SEED_TID).lastInsertRowid);
  tdb.prepare("INSERT INTO homework_feedback (submission_id, author_id, content, created_at) VALUES (?,?,?,datetime('now'))")
    .run(SEED_SUB, SEED_TID, '시드피드백');

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-T1: lessons_held 소스 버그 — lessons.teacher_id COUNT 과 일치, 0 아님.
//   (옛 버그: learning_logs lesson_view 를 세서 교사는 영구 0.)
// ──────────────────────────────────────────────────────────────────────────
test('INV-T1: lessons_held = lessons.teacher_id 카운트(기간창)와 일치 · 0 아님', async () => {
  for (const p of ['30d', '90d']) {
    const r = await req(`/stats/teacher-index?period=${p}`, SEED_TID);
    assert.equal(r.status, 200, `${p} 200`);
    assert.equal(r.json.success, true);
    const held = r.json.myIndex.lessons_held;
    assert.ok(held > 0, `${p}: lessons_held(${held}) 는 0 이 아니어야 (버그 재발 시 0)`);
    // 동일 창을 lessons 테이블 직접 SQL 로 세어 전수 일치.
    const { fromDate, toDate } = r.json.period;
    const direct = tdb.prepare(
      'SELECT COUNT(*) c FROM lessons WHERE teacher_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?'
    ).get(SEED_TID, fromDate, toDate).c;
    assert.equal(held, direct, `${p}: API lessons_held(${held}) == lessons 직접 SQL(${direct})`);
    assert.equal(held, 3, `${p}: 시드 수업 3건 모두 최근 → 3 이어야 (현재 ${held})`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-T2: scope='mine' 강제 — 교사가 scope=all 요청해도 mine 으로 강등, 배열 1개.
// ──────────────────────────────────────────────────────────────────────────
test('INV-T2: 교사 스코프는 항상 mine (scope=all 요청도 강등)', async () => {
  const r = await req('/stats/teacher-index?period=30d&scope=all', SEED_TID);
  assert.equal(r.status, 200);
  assert.equal(r.json.scope, 'mine', '교사는 scope=all 요청해도 mine 강등');
  assert.equal(r.json.teachers.length, 1, 'mine 스코프 → teachers 배열 길이 1');
  assert.equal(r.json.teachers[0].user_id, SEED_TID);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-T3: 응답 계약 — prev·trend·recent 키 존재. prev 4지표 객체.
// ──────────────────────────────────────────────────────────────────────────
test('INV-T3: 신규 응답 계약 prev·trend·recent 키 존재', async () => {
  const r = await req('/stats/teacher-index?period=30d', SEED_TID);
  assert.equal(r.status, 200);
  for (const k of ['prev', 'trend', 'recent', 'myIndex', 'metricScopes', 'period']) {
    assert.ok(k in r.json, `응답에 ${k} 키가 있어야 (신규 계약)`);
  }
  assert.ok(r.json.prev && typeof r.json.prev === 'object', 'prev 는 객체');
  for (const k of ['contents_authored', 'lessons_held', 'exams_opened', 'feedback_count']) {
    assert.ok(k in r.json.prev, `prev.${k} 존재`);
    assert.ok(Number.isInteger(r.json.prev[k]), `prev.${k} 정수`);
  }
  assert.ok(Array.isArray(r.json.trend), 'trend 는 배열');
  assert.ok(Array.isArray(r.json.recent), 'recent 는 배열');
  // metricScopes 4지표 전부 period (KPI 서브라벨 '기간' 파생 근거).
  for (const k of ['contents_authored', 'lessons_held', 'exams_opened', 'feedback_count']) {
    assert.equal(r.json.metricScopes[k], 'period', `metricScopes.${k} === 'period'`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-T4: recent ≤ 10건, 원소 계약, date 내림차순.
// ──────────────────────────────────────────────────────────────────────────
test('INV-T4: recent 최대 10건 · 원소 계약 · date desc', async () => {
  const r = await req('/stats/teacher-index?period=90d', SEED_TID);
  assert.equal(r.status, 200);
  const recent = r.json.recent;
  assert.ok(recent.length <= 10, `recent ≤ 10 (현재 ${recent.length})`);
  assert.ok(recent.length > 0, '시드 활동이 있으므로 recent 비어있지 않음');
  const TYPES = new Set(['content', 'lesson', 'exam', 'feedback']);
  for (const it of recent) {
    assert.ok(TYPES.has(it.type), `type ∈ content|lesson|exam|feedback (현재 ${it.type})`);
    assert.equal(typeof it.title, 'string', 'title 문자열');
    assert.ok('class_name' in it, 'class_name 키 존재(없으면 null)');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(it.date), `date YYYY-MM-DD (현재 ${it.date})`);
  }
  // 내림차순 정렬 확인
  for (let i = 1; i < recent.length; i++) {
    assert.ok(recent[i - 1].date >= recent[i].date, 'recent 는 date 내림차순');
  }
  // 4소스 모두 시드했으므로 4 type 모두 등장
  const seenTypes = new Set(recent.map(x => x.type));
  for (const t of ['content', 'lesson', 'exam', 'feedback']) {
    assert.ok(seenTypes.has(t), `recent 에 ${t} 유형 등장(시드함)`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-T5: trend 버킷 계약 + 기간 반응(버킷수 달라짐).
// ──────────────────────────────────────────────────────────────────────────
test('INV-T5: trend 버킷 계약 · 기간별 버킷수 상이(7d 일별 8칸 vs 90d 월별)', async () => {
  const r7 = await req('/stats/teacher-index?period=7d', SEED_TID);
  const r90 = await req('/stats/teacher-index?period=90d', SEED_TID);
  assert.equal(r7.status, 200); assert.equal(r90.status, 200);
  for (const b of r90.json.trend) {
    for (const k of ['label', 'contents', 'lessons', 'exams', 'feedback']) {
      assert.ok(k in b, `trend 원소에 ${k} 키`);
    }
    assert.equal(typeof b.label, 'string', 'label 문자열');
    for (const k of ['contents', 'lessons', 'exams', 'feedback']) {
      assert.ok(Number.isInteger(b[k]), `trend.${k} 정수`);
    }
  }
  // 7d(≤14일) → 일별 8칸. 90d → 월별(대개 4칸). 두 기간 버킷수가 달라야 = 기간 반응.
  assert.equal(r7.json.trend.length, 8, `7d 는 일별 8칸 (현재 ${r7.json.trend.length})`);
  assert.notEqual(r7.json.trend.length, r90.json.trend.length, '7d 와 90d 버킷수는 달라야(기간 반응)');
  // 버킷 합 = 해당 지표 기간 총합(정합). lessons 합 = myIndex.lessons_held.
  const sumLessons = r90.json.trend.reduce((s, b) => s + b.lessons, 0);
  assert.equal(sumLessons, r90.json.myIndex.lessons_held, 'trend lessons 버킷 합 == myIndex.lessons_held');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-T6: prev = 직전 동일폭 기간. 시드는 전부 now 근처 → 직전 30일은 0.
// ──────────────────────────────────────────────────────────────────────────
test('INV-T6: prev = 직전 동일폭 기간 카운트 (시드 없는 직전 구간 → 0)', async () => {
  const r = await req('/stats/teacher-index?period=30d', SEED_TID);
  assert.equal(r.status, 200);
  // 현재 30일엔 시드 3수업, 직전 30일엔 시드 0.
  assert.equal(r.json.myIndex.lessons_held, 3, '현재 기간 수업 3');
  assert.equal(r.json.prev.lessons_held, 0, '직전 30일엔 시드 수업 없음 → prev.lessons_held 0');
  assert.equal(r.json.prev.contents_authored, 0, '직전 30일 콘텐츠 0');
});
