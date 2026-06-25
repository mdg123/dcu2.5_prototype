// test/school-dashboard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 학교 경영 대시보드(교장·교감) P0 하네스 — 기획서: 작업지시서/학교관리자_대시보드_기획서.md
//
// 박제(SCH-1~12):
//   SCH-1  role principal 마이그레이션 — principal INSERT 허용 + principal1 시드(금성초)
//   SCH-2  principal 스코프 격리 — principal1 → 자기 학교(금성초) 학생만 집계, 타 학교 없음
//   SCH-3  비principal/비admin → 403 (학생·교사·학부모)
//   SCH-4  admin 전체 200 (?school 미지정 = 거시) + ?school 지정 시 그 학교 스코프
//   SCH-5  admin 이 학교 단위 화면(/access 등) 호출 시 school 미지정이면 400 가이드
//   SCH-6  타 학교 차단 — principal 이 ?school=다른학교 줘도 자기 학교로 고정
//   SCH-7  위기/미달 명단 실명(principal 자기학교) — watchlist 에 실명 + named=true
//   SCH-8  ?names=0 마스킹 미리보기 — 이름 "학생 A" 형태, id 유지
//   SCH-9  n<10 교과×학급 교차드릴 — heatmap 셀 crossMasked=true(개별 비노출, 카운트만)
//   SCH-10 집계 정합 — 단일 분류기(평가부족 분모 제외). reachedRate = reached/evaluated
//   SCH-11 자동 인사이트 근거 정확 — evidence 수치가 실제 집계와 일치
//   SCH-12 audit — principal 실명 명단 열람 시 learning_logs governance 1건 적재
//
// DB 격리: 실 DB → 임시 복사본. initSchema(principal 마이그레이션·시드 포함).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();
require('../db/lrs-aggregate').rebuildAllAggregates();

const db = openTestDb();

// 계정 — 실 DB 확정 id (금성초): admin=1, student1=3(금성초 학생), teacher1=2.
const ADMIN = 1;
const TEACHER1 = 2;
const STUDENT1 = 3;
const SCHOOL = '금성초등학교';

// principal1 은 시드로 새로 생성됨 — id 동적 조회.
const PRINCIPAL = db.prepare("SELECT id FROM users WHERE username='principal1'").get().id;
// 학부모 계정(parent1) — 403 검증용
const PARENT = (db.prepare("SELECT id FROM users WHERE username='parent1'").get() || {}).id || null;
// 타 학교명 1곳(금성초 아님)
const OTHER_SCHOOL = (db.prepare("SELECT school_name FROM users WHERE role='student' AND school_name <> ? AND school_name IS NOT NULL LIMIT 1").get(SCHOOL) || {}).school_name;

// 금성초 학생 ID 집합(정합 검증 기준)
const GEUMSEONG_STUDENT_IDS = db.prepare("SELECT id FROM users WHERE school_name=? AND role='student'").all(SCHOOL).map(r => r.id);

const express = require('express');
const session = require('express-session');
let server, baseUrl;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/school', require('../routes/school'));
  return app;
}

function call(method, path, userId, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = userId ? { 'x-test-user': String(userId) } : {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let s = '';
        res.on('data', c => s += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (p, uid) => call('GET', p, uid);

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ════════════════════════════════════════════════════════════════════════════
// SCH-1: role principal 마이그레이션 + 시드
// ════════════════════════════════════════════════════════════════════════════
test('SCH-1: principal role 마이그레이션 — INSERT 허용 + principal1 시드(금성초)', () => {
  // 시드 계정 확인
  const p = db.prepare("SELECT id, role, school_name FROM users WHERE username='principal1'").get();
  assert.ok(p, 'principal1 시드 존재');
  assert.equal(p.role, 'principal');
  assert.equal(p.school_name, SCHOOL);
  // CHECK 가 principal 을 허용하는지(롤백 삽입)
  db.exec('SAVEPOINT chk');
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO users (username,password,display_name,role) VALUES (?,?,?,?)")
      .run('__sch_probe__', 'x', 'probe', 'principal');
  }, 'principal INSERT 허용');
  db.exec('ROLLBACK TO chk'); db.exec('RELEASE chk');
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-2: principal 스코프 격리 — 자기 학교(금성초)만
// ════════════════════════════════════════════════════════════════════════════
test('SCH-2: principal1 /overview — 자기 학교(금성초) 학생만 집계', async () => {
  const r = await get('/api/school/overview', PRINCIPAL);
  assert.equal(r.status, 200, `principal overview 200 (got ${r.status})`);
  assert.equal(r.json.scope.school, SCHOOL, '스코프 학교 = 금성초');
  // 학생수 = 금성초 학생 수와 정확히 일치(타 학교 미혼입)
  assert.equal(r.json.overview.studentCount, GEUMSEONG_STUDENT_IDS.length,
    `학생수 ${r.json.overview.studentCount} == 금성초 ${GEUMSEONG_STUDENT_IDS.length}`);
  assert.ok(r.json.overview.studentCount > 0 && r.json.overview.studentCount < 50, '학교 단위(전국 616 아님)');
  assert.ok(Array.isArray(r.json.insights) && r.json.insights.length >= 1, '인사이트 배열');
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-3: 비principal/비admin → 403
// ════════════════════════════════════════════════════════════════════════════
test('SCH-3: 학생/교사/학부모 → 403 (학교 경영 비열람)', async () => {
  const rStu = await get('/api/school/overview', STUDENT1);
  assert.equal(rStu.status, 403, `학생 403 (got ${rStu.status})`);
  const rTea = await get('/api/school/overview', TEACHER1);
  assert.equal(rTea.status, 403, `교사 403 (got ${rTea.status})`);
  if (PARENT) {
    const rPar = await get('/api/school/safety', PARENT);
    assert.equal(rPar.status, 403, `학부모 403 (got ${rPar.status})`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-4: admin 전체 200 + ?school 스코프
// ════════════════════════════════════════════════════════════════════════════
test('SCH-4: admin /enrollment — school 미지정=거시(200), ?school=금성초=학교 스코프', async () => {
  // enrollment 는 school 없이도 거시 분포 허용(전국 role/grade)
  const macro = await get('/api/school/enrollment', ADMIN);
  assert.equal(macro.status, 200, `admin 거시 enrollment 200 (got ${macro.status})`);
  assert.ok(macro.json.scope.isAdminMacro === true, 'admin 거시 플래그');
  assert.ok((macro.json.byRole.student || 0) > 100, '전국 학생 분포(>100)');

  // ?school 지정 → 금성초 스코프
  const scoped = await get(`/api/school/enrollment?school=${encodeURIComponent(SCHOOL)}`, ADMIN);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.json.scope.school, SCHOOL);
  assert.equal(scoped.json.byRole.student, GEUMSEONG_STUDENT_IDS.length, 'admin?school 금성초 학생수 일치');
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-5: admin 학교 단위 화면은 school 미지정이면 400 가이드
// ════════════════════════════════════════════════════════════════════════════
test('SCH-5: admin /access (학교 단위) — school 미지정 400 가이드', async () => {
  const r = await get('/api/school/access', ADMIN);
  assert.equal(r.status, 400, `admin 학교화면 school 미지정 400 (got ${r.status})`);
  // ?school 지정하면 200
  const ok = await get(`/api/school/access?school=${encodeURIComponent(SCHOOL)}`, ADMIN);
  assert.equal(ok.status, 200, 'admin?school access 200');
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-6: 타 학교 차단 — principal 이 ?school 줘도 자기 학교 고정
// ════════════════════════════════════════════════════════════════════════════
test('SCH-6: principal ?school=타학교 무시 — 자기 학교(금성초)로 고정', async () => {
  if (!OTHER_SCHOOL) return; // 타 학교 없으면 skip
  const r = await get(`/api/school/overview?school=${encodeURIComponent(OTHER_SCHOOL)}`, PRINCIPAL);
  assert.equal(r.status, 200);
  assert.equal(r.json.scope.school, SCHOOL, `타 학교 요청 무시 → 금성초 고정(got ${r.json.scope.school})`);
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-7: 위기/미달 명단 실명 (principal 자기학교)
// ════════════════════════════════════════════════════════════════════════════
test('SCH-7: principal /safety — watchlist 실명(named=true), 금성초 학생만', async () => {
  const r = await get('/api/school/safety', PRINCIPAL);
  assert.equal(r.status, 200, `safety 200 (got ${r.status})`);
  assert.equal(r.json.named, true, '실명 노출 named=true');
  // watchlist 의 모든 userId 가 금성초 학생 집합에 속함(타 학교 0)
  const idset = new Set(GEUMSEONG_STUDENT_IDS);
  for (const w of r.json.watchlist) {
    assert.ok(idset.has(w.userId), `명단 학생 ${w.userId} 는 금성초 소속`);
    assert.ok(typeof w.name === 'string' && !/^학생 [A-Z]$/.test(w.name), `실명(마스킹 아님): ${w.name}`);
  }
  assert.ok(r.json.riskSummary && typeof r.json.riskSummary.high === 'number', 'riskSummary 존재');
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-8: ?names=0 마스킹 미리보기
// ════════════════════════════════════════════════════════════════════════════
test('SCH-8: principal /safety?names=0 — 익명 라벨(학생 A), id 유지', async () => {
  const r = await get('/api/school/safety?names=0', PRINCIPAL);
  assert.equal(r.status, 200);
  assert.equal(r.json.named, false, 'named=false');
  for (const w of r.json.watchlist) {
    assert.match(w.name, /^학생 [A-Z]$/, `마스킹 라벨: ${w.name}`);
    assert.ok(Number.isInteger(w.userId), 'id 는 유지');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-9: n<10 교과×학급 교차드릴 — crossMasked 카운트만
// ════════════════════════════════════════════════════════════════════════════
test('SCH-9: /achievement heatmap — 금성초 표본<10 셀 crossMasked=true', async () => {
  const r = await get('/api/school/achievement', PRINCIPAL);
  assert.equal(r.status, 200, `achievement 200 (got ${r.status})`);
  assert.ok(Array.isArray(r.json.heatmap), 'heatmap 배열');
  assert.equal(r.json.minCrossN, 10, 'minCrossN=10');
  // 금성초는 학생 6명 → 모든 학년×교과 셀의 evaluated<10 이므로 crossMasked=true 여야 함
  for (const c of r.json.heatmap) {
    if (c.evaluated < 10) {
      assert.equal(c.crossMasked, true, `evaluated ${c.evaluated}<10 셀은 crossMasked`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-10: 집계 정합 — 단일 분류기(평가부족 분모 제외)
// ════════════════════════════════════════════════════════════════════════════
test('SCH-10: 집계 정합 — reachedRate = reached/evaluated, insufficient 분모 제외', async () => {
  const r = await get('/api/school/achievement', PRINCIPAL);
  const ov = r.json.overall;
  assert.ok(ov, 'overall 존재');
  // evaluated = reached + partial + notReached (insufficient 제외)
  assert.equal(ov.evaluated, ov.reached + ov.partial + ov.notReached, 'evaluated = 도달+부분+미도달');
  assert.equal(ov.total, ov.evaluated + ov.insufficient, 'total = evaluated + insufficient');
  if (ov.evaluated > 0) {
    const expect = Math.round((ov.reached / ov.evaluated) * 1000) / 10;
    assert.equal(ov.reachedRate, expect, `reachedRate=${ov.reachedRate} == reached/evaluated=${expect}`);
    assert.ok(ov.reachedRate >= 0 && ov.reachedRate <= 100, '0~100 범위');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-11: 자동 인사이트 근거 정확 — evidence 수치가 실제 집계와 일치
// ════════════════════════════════════════════════════════════════════════════
test('SCH-11: /overview 인사이트 — evidence 수치 정합 + 신뢰도/표본 꼬리표', async () => {
  const r = await get('/api/school/overview', PRINCIPAL);
  const ins = r.json.insights;
  assert.ok(ins.length >= 1, '최소 1개');
  for (const i of ins) {
    assert.ok(typeof i.text === 'string' && i.text.length > 0, '근거 문장');
    assert.ok(['ok', 'caution', 'warn', 'critical'].includes(i.severity), 'severity');
    assert.ok(['high', 'medium', 'low'].includes(i.confidence), 'confidence 라벨');
    assert.ok('sample' in i, 'sample(표본) 동반');
    // 소표본 꼬리표 규칙: sample<10 이면 "참고용" 문구 포함
    if (i.sample != null && i.sample < 10) {
      assert.match(i.text, /참고용/, '소표본 꼬리표');
    }
  }
  // 저참여 룰이 떴다면 evidence 가 todayLearning 과 일치
  const dailyLow = ins.find(i => i.id === 'daily-low');
  if (dailyLow) {
    assert.equal(dailyLow.evidence.studentCount, r.json.overview.todayLearning.studentCount, '참여 evidence 정합');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-12: audit — principal 실명 명단 열람 시 learning_logs governance 1건
// ════════════════════════════════════════════════════════════════════════════
test('SCH-12: principal 실명 명단 열람 → governance audit 1건 적재', async () => {
  const before = db.prepare(`
    SELECT COUNT(*) c FROM learning_logs
    WHERE user_id=? AND activity_type='governance' AND target_type='school-roster'
  `).get(PRINCIPAL).c;
  // 명단이 있을 때만 audit — watchlist 있는지 먼저 확인
  const safety = await get('/api/school/safety', PRINCIPAL);
  const hasNames = safety.json.named && safety.json.watchlist.length > 0;
  const after = db.prepare(`
    SELECT COUNT(*) c FROM learning_logs
    WHERE user_id=? AND activity_type='governance' AND target_type='school-roster'
  `).get(PRINCIPAL).c;
  if (hasNames) {
    assert.ok(after > before, `명단 열람 시 audit 증가 (before ${before} → after ${after})`);
  } else {
    assert.equal(after, before, '명단 비면 audit 미적재');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-13: benchmark — 학교 vs 학교급/지역 평균 + 전월 대비
// ════════════════════════════════════════════════════════════════════════════
test('SCH-13: principal /benchmark — ours + levelAvg/regionAvg + monthCompare', async () => {
  const r = await get('/api/school/benchmark', PRINCIPAL);
  assert.equal(r.status, 200, `benchmark 200 (got ${r.status})`);
  assert.equal(r.json.scope.school, SCHOOL);
  assert.ok(r.json.ours && r.json.ours.students === GEUMSEONG_STUDENT_IDS.length, 'ours 학생수 정합');
  assert.ok('monthCompare' in r.json, '전월 대비 포함');
  // levelAvg/regionAvg 는 존재(또는 null) — 구조 계약
  assert.ok('levelAvg' in r.json && 'regionAvg' in r.json, '평균 비교 구조');
});

// ════════════════════════════════════════════════════════════════════════════
// SCH-14: 외부 서비스 external 플래그 (P0-4)
// ════════════════════════════════════════════════════════════════════════════
test('SCH-14: /pages — 내부 서비스 + 외부 4서비스 external=true', async () => {
  const r = await get('/api/school/pages', PRINCIPAL);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.internal), 'internal 배열');
  assert.ok(Array.isArray(r.json.external) && r.json.external.length === 4, '외부 4서비스');
  for (const e of r.json.external) {
    assert.equal(e.external, true, '외부 플래그');
    assert.equal(e.count, null, '외부는 데이터 없음(null)');
  }
});
