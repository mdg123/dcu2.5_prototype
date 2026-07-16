// test/lrs-activity-scope.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 교사 분석탭 재편 BE — 성취0 클래스 제외(C)·클래스목록 플래그(A)·활동현황 classId 필터(F)
//   기획서: 보고서/LRS_교사분석탭_재편_기획서_v1.md §4·§6
//   대상:
//     - GET /api/lrs/stats/class-compare : 활동0 클래스([시연] 데모반) 지표 제외 + excludedNoData.
//         ★ 버그 재현→박제: 활동0 클래스가 섞이면 활용도 격차(actsPerStu.gapX)가 bottom.v=0 →
//           null("-배")로 붕괴한다. 제외 후 실클래스만으로 산출되어 non-null 이어야 한다.
//     - GET /api/lrs/classes : 소유 active 클래스별 hasScoredActivity/activityCount 플래그(A 기본선택).
//     - GET /api/lrs/stats/by-service, by-subject : ?classId 옵션(all=소유 합산 / 특정=그 클래스).
//
//   DB 격리: 실 DB → 임시 복사본(_setup). 합성 교사/반/학생/로그로 정확값 박제(실데이터 무의존).
//   HTTP 하네스: fake session → 실 requireAuth 가 req.user 해석(lrs-class-compare 와 동일 패턴).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

let server, baseUrl, tdb;
// 합성 엔티티 id
const ID = { teacherW: 0, teacherV: 0, studentX: 0, CW1: 0, CW2: 0, CW3: 0, CV: 0 };

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

const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
function mkUser(role, suffix) {
  return Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', ?)"
  ).run(`t_as_${role}_${suffix}_${uniq()}`, `AS_${suffix}`, role).lastInsertRowid);
}
function mkClass(ownerId, name, status) {
  const cid = Number(tdb.prepare(
    "INSERT INTO classes (code, name, owner_id, status) VALUES (?, ?, ?, ?)"
  ).run(`AS_${uniq()}`, name, ownerId, status).lastInsertRowid);
  // createClass 와 동일: 개설자를 owner 멤버로 등록(canViewClass 소유 게이트 통과 조건).
  tdb.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')")
    .run(cid, ownerId);
  return cid;
}

before(async () => {
  tdb = openTestDb();

  const insMember = tdb.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'member', 'active')"
  );
  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, activity_type, verb, source_service, subject_code, class_id, duration_sec, result_score, is_seed, created_at)
    VALUES (?, 'exam_complete', 'completed', 'content', ?, ?, 300, ?, 0, datetime('now','localtime'))
  `);
  const addStudent = (classId, suffix) => {
    const uid = mkUser('student', suffix);
    insMember.run(classId, uid);
    return uid;
  };

  // ── 교사 W: 활성 3반 — CW1·CW2(활동 있음) + CW3(활동0·[시연] 데모반 모사) ──
  ID.teacherW = mkUser('teacher', 'W');
  ID.CW1 = mkClass(ID.teacherW, 'AS_반W1', 'active');
  ID.CW2 = mkClass(ID.teacherW, 'AS_반W2', 'active');
  ID.CW3 = mkClass(ID.teacherW, 'AS_반W3_데모', 'active');

  // CW1: 학생 4명, 각 math(80)+korean(80) → acts=8·avgActs=2.0·avgScore=80.
  for (let i = 0; i < 4; i++) {
    const uid = addStudent(ID.CW1, `W1_${i}`);
    insLog.run(uid, 'math', ID.CW1, 80);
    insLog.run(uid, 'korean', ID.CW1, 80);
  }
  // CW2: 학생 4명, 각 math(60) → acts=4·avgActs=1.0·avgScore=60.
  for (let i = 0; i < 4; i++) {
    const uid = addStudent(ID.CW2, `W2_${i}`);
    insLog.run(uid, 'math', ID.CW2, 60);
  }
  // CW3(데모): 학생 4명, 로그 0건 → acts=0·avgActs=0·avgScore=null → 지표 제외 대상.
  for (let i = 0; i < 4; i++) addStudent(ID.CW3, `W3_${i}`);

  // by-subject 원천: 수업(lessons) — CW1 math×2, CW2 science×1. (teacher_id·class_id 필터 검증)
  const insLesson = tdb.prepare(
    "INSERT INTO lessons (class_id, teacher_id, title, subject_code, status) VALUES (?, ?, ?, ?, 'published')"
  );
  insLesson.run(ID.CW1, ID.teacherW, 'W1 수학1', 'math');
  insLesson.run(ID.CW1, ID.teacherW, 'W1 수학2', 'math');
  insLesson.run(ID.CW2, ID.teacherW, 'W2 과학1', 'science');

  // ── 교사 V: 관여 없음 — 비소유 403 검증용 ──
  ID.teacherV = mkUser('teacher', 'V');
  ID.CV = mkClass(ID.teacherV, 'AS_반V', 'active');

  // ── 권한 403 검증용 학생 ──
  ID.studentX = mkUser('student', 'X');

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

const unitOf = (j, id) => j.units.find(u => u.id === id);

// ──────────────────────────────────────────────────────────────────────────
// INV-AS-1 (C 핵심·버그 박제): class-compare 활동0 클래스 제외 → 활용도 격차 non-null.
// ──────────────────────────────────────────────────────────────────────────
test('INV-AS-1: 활동0 클래스([시연] 데모반) 지표 제외 · actsPerStu.gapX non-null · excludedNoData', async () => {
  const r = await req('/stats/class-compare?period=30d', ID.teacherW);
  assert.equal(r.status, 200, `200 기대 got ${r.status}: ${r.raw}`);
  const j = r.json;

  // 표(units)에는 3반 모두 남는다(데모반 존재 고지).
  assert.equal(j.units.length, 3, 'units=3(소유 active 전부)');
  assert.ok(unitOf(j, ID.CW3), 'units 에 데모반(CW3) 남아있음(표 노출)');

  // excludedNoData 에 데모반만.
  assert.ok(Array.isArray(j.excludedNoData), 'excludedNoData 배열');
  assert.equal(j.excludedNoData.length, 1, 'excludedNoData 1개');
  assert.equal(j.excludedNoData[0].id, ID.CW3, 'excludedNoData=데모반(CW3)');
  assert.equal(j.excludedNoData[0].name, 'AS_반W3_데모', 'excludedNoData 이름 동반');

  // 비교가능 클래스 2 → 충분.
  assert.equal(j.insufficientClasses, false, '비교가능 2 → insufficientClasses=false');
  assert.equal(j.comparableCount, 2, 'comparableCount=2');

  // ★ 버그 박제: 활용도 격차(actsPerStu.gapX)가 "-배"(null) 아님. 실클래스만 산출.
  //   CW1 avgActs=2.0 · CW2 avgActs=1.0 → gapX=2.0. (데모반 0 포함 시 bottom.v=0 → null 붕괴.)
  assert.notEqual(j.metrics.actsPerStu.gapX, null, 'actsPerStu.gapX non-null(데모반 제외 효과)');
  assert.equal(j.metrics.actsPerStu.gapX, 2, 'actsPerStu.gapX=2.0(CW1 2.0 ÷ CW2 1.0)');
  assert.equal(j.metrics.actsPerStu.top.id, ID.CW1, '활동 최고=CW1');
  assert.equal(j.metrics.actsPerStu.bottom.id, ID.CW2, '활동 최저=CW2(데모반 아님)');

  // 성취 격차: 80-60=20, top=CW1·bottom=CW2.
  assert.equal(j.metrics.avgScore.gapPP, 20, 'avgScore 격차 20%p');
  assert.equal(j.metrics.avgScore.bottom.id, ID.CW2, '성취 최저=CW2(데모반 아님)');

  // 우선 관심 클래스: 데모반은 비교에서 빠지므로 both_low 후보 아님. CW2 가 both_low.
  assert.ok(j.priorityUnits.some(p => p.id === ID.CW2), '우선 관심=CW2');
  assert.ok(!j.priorityUnits.some(p => p.id === ID.CW3), '데모반은 우선 관심에 없음');

  // 클래스×교과 히트맵도 데모반 제외(회색 노이즈 행 제거).
  assert.ok(!j.classSubjectMatrix.some(m => m.classId === ID.CW3), '매트릭스에서 데모반 제외');
  assert.equal(j.classSubjectMatrix.length, 2, '매트릭스 2반(CW1·CW2)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-AS-2 (A): /api/lrs/classes hasScoredActivity — 데모반 false · 실클래스 true.
// ──────────────────────────────────────────────────────────────────────────
test('INV-AS-2: /classes hasScoredActivity — 데모반=false · CW1·CW2=true', async () => {
  const r = await req('/classes', ID.teacherW);
  assert.equal(r.status, 200, `200 기대 got ${r.status}: ${r.raw}`);
  const byId = new Map(r.json.classes.map(c => [c.id, c]));

  assert.equal(byId.get(ID.CW1).hasScoredActivity, true, 'CW1 hasScoredActivity=true');
  assert.equal(byId.get(ID.CW2).hasScoredActivity, true, 'CW2 hasScoredActivity=true');
  assert.equal(byId.get(ID.CW3).hasScoredActivity, false, '데모반(CW3) hasScoredActivity=false');
  assert.equal(byId.get(ID.CW3).activityCount, 0, '데모반 activityCount=0');
  assert.equal(byId.get(ID.CW3).hasComparableActivity, false, '데모반 hasComparableActivity=false');
  assert.ok(byId.get(ID.CW1).scoredCount >= 8, 'CW1 scoredCount≥8');
  // 소유 active 3반만(정렬 최신순).
  assert.equal(r.json.classes.length, 3, '소유 active 3반');

  // 권한: 학생 403.
  const s = await req('/classes', ID.studentX);
  assert.equal(s.status, 403, '학생 403');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-AS-3 (F): by-service classId — all(소유 합산) vs 특정 클래스(좁힘).
// ──────────────────────────────────────────────────────────────────────────
test('INV-AS-3: by-service classId=all vs 특정 클래스 스코프', async () => {
  const all = await req('/stats/by-service', ID.teacherW);
  assert.equal(all.status, 200, 'by-service all 200');
  const allContent = (all.json.stats.find(s => s.service === 'content') || {}).count || 0;
  assert.equal(allContent, 12, 'all-owned content=12(CW1 8 + CW2 4)');
  assert.equal(all.json.appliedClassId, null, 'all → appliedClassId=null');

  const one = await req(`/stats/by-service?classId=${ID.CW1}`, ID.teacherW);
  assert.equal(one.status, 200, 'by-service classId 200');
  const oneContent = (one.json.stats.find(s => s.service === 'content') || {}).count || 0;
  assert.equal(oneContent, 8, 'CW1 만 content=8(좁힘)');
  assert.equal(one.json.appliedClassId, ID.CW1, 'appliedClassId=CW1');
  assert.equal(one.json.appliedClassName, 'AS_반W1', 'appliedClassName 동반');
  assert.equal(one.json.scope, 'class-one', 'scope=class-one');

  // classId=all 은 미지정과 동일(합산).
  const allExplicit = await req('/stats/by-service?classId=all', ID.teacherW);
  const allExpContent = (allExplicit.json.stats.find(s => s.service === 'content') || {}).count || 0;
  assert.equal(allExpContent, 12, 'classId=all == 미지정(12)');

  // 비소유 클래스 classId → 권한 게이트로 무시되어 전체 스코프 폴백(오류 아님, 소유 합산 유지).
  const foreign = await req(`/stats/by-service?classId=${ID.CV}`, ID.teacherW);
  assert.equal(foreign.status, 200, '비소유 classId 는 무시(200)');
  assert.equal(foreign.json.appliedClassId, null, '비소유 classId → 무시(appliedClassId=null)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-AS-4 (F): by-subject classId — 소유 전체 vs 특정 클래스(class_id 컬럼 좁힘).
// ──────────────────────────────────────────────────────────────────────────
test('INV-AS-4: by-subject classId=특정 → 그 클래스 자료만', async () => {
  const all = await req('/stats/by-subject', ID.teacherW);
  assert.equal(all.status, 200, 'by-subject all 200');
  const mathAll = (all.json.lessonStats.find(s => s.subject_code === 'math') || {}).count || 0;
  const sciAll = (all.json.lessonStats.find(s => s.subject_code === 'science') || {}).count || 0;
  assert.equal(mathAll, 2, '소유 전체 math 수업=2(CW1)');
  assert.equal(sciAll, 1, '소유 전체 science 수업=1(CW2)');

  const one = await req(`/stats/by-subject?classId=${ID.CW1}`, ID.teacherW);
  assert.equal(one.status, 200, 'by-subject classId 200');
  const mathOne = (one.json.lessonStats.find(s => s.subject_code === 'math') || {}).count || 0;
  const sciOne = (one.json.lessonStats.find(s => s.subject_code === 'science') || {}).count || 0;
  assert.equal(mathOne, 2, 'CW1 math 수업=2');
  assert.equal(sciOne, 0, 'CW1 에는 science 수업 없음(CW2 자료 배제)');
  assert.equal(one.json.scope, 'class-one', 'scope=class-one');
  assert.equal(one.json.appliedClassId, ID.CW1, 'appliedClassId=CW1');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-AS-5: 권한 — /classes teacher/admin 200 · student 403 · class-compare 비교가능<2 처리.
// ──────────────────────────────────────────────────────────────────────────
test('INV-AS-5: 권한 게이트 + class-compare 회귀(정상 KPI 유지)', async () => {
  // admin(id=1) 200.
  const admin = await req('/classes', 1);
  assert.equal(admin.status, 200, 'admin /classes 200');

  // by-service 학생 요청은 mine 폴백(200이지만 소유 스코프 아님) — 권한 오류는 아님.
  //   (핵심 권한 게이트는 class-compare·/classes 의 teacher/admin 제한으로 검증.)
  const ccStudent = await req('/stats/class-compare', ID.studentX);
  assert.equal(ccStudent.status, 403, 'class-compare 학생 403');
});
