// test/lrs-class-compare.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 교사 "반별 비교"(class-compare) BE-6 — 계약·불변식 박제
//   기획서: 보고서/LRS_교사_반별비교_기획서_v1.md §C-1·§C-2·§E
//   대상: GET /api/lrs/stats/class-compare
//     - 권한: teacher/admin (others 403)
//     - 스코프: owner_id = me AND status='active' (deleted/archived 제외)
//     - 반별 집계: class_members 멤버십 조인(user_id IN 반 멤버). scoredWhere·normScoreExpr·
//                  subjectCodeSetFilter·_equityMetric 재사용.
//     - ★ 마스킹: 개인정보(MIN_N) 마스킹 미적용(값 항상 노출). 채점형 학생<3 반만 lowSample=true.
//
//   [§E 하네스 불변식 5종]
//     INV-CC-1  스코프: units 의 id 집합 ⊆ owner_id=me AND status='active' (deleted 클래스 0건).
//     INV-CC-2  마스킹 정책: 8·6명 미만 소반도 units.every(masked===false)·값 노출 · 채점형<3 → lowSample.
//     INV-CC-3  담당 반 <2 계정: insufficientClasses===true · units.length<2.
//     INV-CC-4  subject!=all → avgScore 가 그 교과 codeSet 로그로만 산출 · availableSubjects.present 일관.
//     INV-CC-5  공용 헬퍼 재사용 회귀: equity(admin) 무영향 · 권한(teacher/admin 200, student 403).
//
//   DB 격리: 실 DB → 임시 복사본(_setup). 합성 교사/반/학생/로그를 삽입해 정확값 박제(실데이터 무의존).
//   HTTP 하네스는 lrs-region-compare 와 동일 패턴(fake session → 실 requireAuth 가 req.user 해석).
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
// 합성 엔티티 id (before 에서 채움)
const ID = { teacherT: 0, teacherU: 0, studentX: 0, CA: 0, CB: 0, CD: 0, CU: 0 };

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
  ).run(`t_cc_${role}_${suffix}_${uniq()}`, `CC_${suffix}`, role).lastInsertRowid);
}
function mkClass(ownerId, name, status) {
  return Number(tdb.prepare(
    "INSERT INTO classes (code, name, owner_id, status) VALUES (?, ?, ?, ?)"
  ).run(`CC_${uniq()}`, name, ownerId, status).lastInsertRowid);
}

before(async () => {
  tdb = openTestDb();

  const insMember = tdb.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'member', 'active')"
  );
  // 채점형 로그(exam_complete=SCORED). 최근 30일창(오늘). 0~100 스케일 점수.
  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, activity_type, verb, source_service, subject_code, duration_sec, result_score, is_seed, created_at)
    VALUES (?, 'exam_complete', 'completed', 'content', ?, 300, ?, 0, datetime('now','localtime'))
  `);
  const addStudent = (classId, suffix) => {
    const uid = mkUser('student', suffix);
    insMember.run(classId, uid);
    return uid;
  };

  // ── 교사 T: 활성 2반(CA·CB) + 삭제 1반(CD, deleted → 스코프 제외 검증) ──
  ID.teacherT = mkUser('teacher', 'T');
  ID.CA = mkClass(ID.teacherT, 'CC_반A', 'active');
  ID.CB = mkClass(ID.teacherT, 'CC_반B', 'active');
  ID.CD = mkClass(ID.teacherT, 'CC_반D_삭제', 'deleted');

  // CA: 학생 4명, 각 math(90)+korean(40). → math=90 · korean=40 · all=65 · scored_students=4(lowSample false)
  for (let i = 0; i < 4; i++) {
    const uid = addStudent(ID.CA, `A${i}`);
    insLog.run(uid, 'math', 90);
    insLog.run(uid, 'korean', 40);
  }
  // CB: 학생 4명 중 2명만 math(60). → math=60 · all=60 · scored_students=2(lowSample true) · korean 없음(null)
  for (let i = 0; i < 4; i++) {
    const uid = addStudent(ID.CB, `B${i}`);
    if (i < 2) insLog.run(uid, 'math', 60);
  }
  // CD(deleted): 학생 3명 math(30) — 스코프에서 제외돼야 함(units·availableSubjects 어디에도 미노출).
  for (let i = 0; i < 3; i++) {
    const uid = addStudent(ID.CD, `D${i}`);
    insLog.run(uid, 'math', 30);
  }

  // ── 교사 U: 활성 1반(CU)만 → insufficientClasses 검증 ──
  ID.teacherU = mkUser('teacher', 'U');
  ID.CU = mkClass(ID.teacherU, 'CC_반U', 'active');
  for (let i = 0; i < 3; i++) {
    const uid = addStudent(ID.CU, `U${i}`);
    insLog.run(uid, 'math', 80);
  }

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

async function fetchCC(qs, userId) {
  const r = await req('/stats/class-compare' + qs, userId);
  assert.equal(r.status, 200, `class-compare 200 기대, got ${r.status}: ${r.raw}`);
  return r.json;
}
const unitOf = (j, id) => j.units.find(u => u.id === id);
const availOf = (j, key) => (j.availableSubjects || []).find(s => s.key === key);

// ──────────────────────────────────────────────────────────────────────────
// INV-CC-1: 스코프 — units ⊆ owner+active. deleted(CD) 절대 미노출.
// ──────────────────────────────────────────────────────────────────────────
test('INV-CC-1: 스코프 = 소유 active 반만(2반) · deleted 클래스 0건', async () => {
  const j = await fetchCC('?period=30d', ID.teacherT);
  assert.equal(j.insufficientClasses, false, 'teacher T 는 2반 → 비교 가능');
  assert.equal(j.ownedCount, 2, 'ownedCount=2(active 만)');
  const ids = j.units.map(u => u.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [ID.CA, ID.CB].sort((a, b) => a - b), 'units = {CA,CB} 정확');
  assert.equal(unitOf(j, ID.CD), undefined, 'deleted 반(CD) 은 units 에 없음');
  // deleted 반 학생의 교과(math·30점)는 여전히 노출되지만, CD 자체가 스코프 밖이어야 함.
  // classId/className 계약 필드 동반(FE 양립).
  j.units.forEach(u => { assert.equal(u.classId, u.id); assert.equal(u.className, u.label); });
});

// ──────────────────────────────────────────────────────────────────────────
// INV-CC-2: 마스킹 정책 — 소반(4명<10)도 masked=false·값 노출 · 채점형<3 → lowSample.
// ──────────────────────────────────────────────────────────────────────────
test('INV-CC-2: MIN_N 프라이버시 마스킹 미적용 · lowSample 은 채점형<3 반에만', async () => {
  const j = await fetchCC('?period=30d', ID.teacherT);
  // 두 반 모두 학생수 <10 이지만 마스킹 미적용(값 노출).
  assert.ok(j.units.every(u => u.masked === false), '모든 units masked===false (프라이버시 마스킹 미적용)');
  assert.ok(j.units.every(u => u.avgScore != null), '소반도 avgScore 노출(마스킹으로 null 되지 않음)');

  const ca = unitOf(j, ID.CA), cb = unitOf(j, ID.CB);
  assert.equal(ca.students, 4, 'CA 학생수 4');
  assert.equal(cb.students, 4, 'CB 학생수 4');
  assert.equal(ca.avgScore, 65, 'CA all avgScore=65 ((90+40)/2)');
  assert.equal(cb.avgScore, 60, 'CB all avgScore=60(math 60)');
  // lowSample: CA 채점형학생 4(≥3)→false · CB 채점형학생 2(<3)→true.
  assert.equal(ca.lowSample, false, 'CA lowSample=false(채점형 4명)');
  assert.equal(cb.lowSample, true, 'CB lowSample=true(채점형 2명<3)');
  assert.equal(j.minScoredForCaption, 3, 'minScoredForCaption=3');

  // ── [W2-b 6-11] '도달률' 정의 통일 ──────────────────────────────────────────
  //   구: reachRate = 개인 평균≥60 학생수 / **반 학생 전원**(CB 2/4=50) — 도 스코프와 정의가 달라
  //       같은 탭에서 스코프 칩만 바꿔도 '도달률'의 뜻이 통째로 바뀌었다.
  //   정본: 도달률 = A3(집단 도달률, lrs_achievement_stats + db/lrs-mastery 판정, 누적).
  //       합성 학생에겐 성취통계가 없으므로 null 이어야 한다(0 으로 채우면 '전원 미도달' 거짓).
  assert.equal(ca.reachRate, undefined, "폐기된 'reachRate' 키 잔존 금지(뜻 다른 도달률 2개 금지)");
  assert.equal(ca.groupReachedRate, null, 'CA 도달률 — 성취통계 없음 → null(0 채움 금지)');
  assert.equal(cb.groupReachedRate, null, 'CB 도달률 — 성취통계 없음 → null(0 채움 금지)');
  assert.equal(ca.evaluatedStudents, 0, 'CA 평가충분 표본 0(분모 노출)');
  //   구 값은 '평균 60점 이상 학생 비율'로 개명 + 분모를 분자와 같은 모집단(채점 보유 학생)으로 교정.
  //   CB 는 분모가 4(반 전원) → 2(채점 보유)로 바뀌므로 50 → 100.
  assert.equal(ca.avgOver60Rate, 100, 'CA 평균 60점 이상 비율=100 (채점 4명 전원 ≥60)');
  assert.equal(ca.scoredStudents, 4, 'CA 채점 보유 학생 4명(분모 노출)');
  assert.equal(cb.avgOver60Rate, 100, 'CB 평균 60점 이상 비율=100 (채점 2명 전원 ≥60)');
  assert.equal(cb.scoredStudents, 2, 'CB 채점 보유 학생 2명(분모 노출) — 구 분모 4와 다름');

  // 사분면·우선관심반: n=2 중앙값 분할 → 약한 CB=both_low, CA=good. priorityUnits=[CB].
  assert.equal(ca.quadrant, 'good', 'CA quadrant=good');
  assert.equal(cb.quadrant, 'both_low', 'CB quadrant=both_low');
  assert.ok(j.priorityUnits.some(p => p.id === ID.CB), '우선 관심 반에 CB 포함');
  assert.ok(!j.priorityUnits.some(p => p.id === ID.CA), '우선 관심 반에 CA 미포함');

  // 격차 지표(_equityMetric): avgScore gapPP = 65-60 = 5, top=CA·bottom=CB.
  assert.equal(j.metrics.avgScore.gapPP, 5, 'avgScore 격차 5%p');
  assert.equal(j.metrics.avgScore.top.id, ID.CA, '최고=CA');
  assert.equal(j.metrics.avgScore.bottom.id, ID.CB, '최저=CB');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-CC-3: 담당 반 <2 → insufficientClasses.
// ──────────────────────────────────────────────────────────────────────────
test('INV-CC-3: 담당 active 반 1개 교사 → insufficientClasses=true · units 빈배열', async () => {
  const j = await fetchCC('?period=30d', ID.teacherU);
  assert.equal(j.insufficientClasses, true, 'insufficientClasses=true');
  assert.ok(j.units.length < 2, 'units.length<2');
  assert.equal(j.units.length, 0, 'units 빈배열');
  assert.equal(j.ownedCount, 1, 'ownedCount=1');
  assert.ok(Array.isArray(j.availableSubjects), 'availableSubjects 배열(빈상태에도 계약 유지)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-CC-4: subject 필터 — codeSet 로만 avgScore 산출 · availableSubjects.present 일관.
// ──────────────────────────────────────────────────────────────────────────
test('INV-CC-4: subject=math/korean → 그 교과 codeSet 로그로만 avgScore · present 일관', async () => {
  const all = await fetchCC('?period=30d', ID.teacherT);
  const math = await fetchCC('?period=30d&subject=math', ID.teacherT);
  const kor = await fetchCC('?period=30d&subject=korean', ID.teacherT);

  // subject=math: CA=90(math만), CB=60. subject=korean: CA=40, CB=null(국어 없음).
  assert.equal(unitOf(math, ID.CA).avgScore, 90, 'math CA avgScore=90');
  assert.equal(unitOf(math, ID.CB).avgScore, 60, 'math CB avgScore=60');
  assert.equal(unitOf(kor, ID.CA).avgScore, 40, 'korean CA avgScore=40');
  assert.equal(unitOf(kor, ID.CB).avgScore, null, 'korean CB avgScore=null(국어 로그 없음)');

  // all 은 혼합: CA=(90+40)/2=65, CB=60(math만).
  assert.equal(unitOf(all, ID.CA).avgScore, 65, 'all CA avgScore=65');
  assert.equal(unitOf(all, ID.CB).avgScore, 60, 'all CB avgScore=60');

  // lowSample 은 교과 스코프 기준: korean CB 는 채점형 0명(<3)→true, korean CA 4명→false.
  assert.equal(unitOf(kor, ID.CA).lowSample, false, 'korean CA lowSample=false');
  assert.equal(unitOf(kor, ID.CB).lowSample, true, 'korean CB lowSample=true(0<3)');
  assert.equal(unitOf(math, ID.CB).lowSample, true, 'math CB lowSample=true(2<3)');
  assert.equal(unitOf(math, ID.CA).lowSample, false, 'math CA lowSample=false(4)');

  // availableSubjects present: math·korean 존재(true), science 없음(false).
  assert.equal(availOf(all, 'math').present, true, 'math present');
  assert.equal(availOf(all, 'korean').present, true, 'korean present');
  assert.equal(availOf(all, 'science').present, false, 'science 없음(present=false)');
  assert.equal(all.availableSubjects.length, 10, 'canonical 10교과');
  assert.deepEqual(all.availableSubjects.map(s => s.key),
    ['korean', 'math', 'english', 'science', 'social', 'moral', 'music', 'art', 'pe', 'practical']);

  // appliedSubject/Label.
  assert.equal(math.appliedSubject, 'math');
  assert.equal(math.appliedSubjectLabel, '수학');
  assert.equal(all.appliedSubject, 'all');
  assert.equal(all.appliedSubjectLabel, null);

  // classSubjectMatrix: 교과=all 일 때만 채움. subject 선택 시 [].
  assert.ok(Array.isArray(all.classSubjectMatrix) && all.classSubjectMatrix.length === 2, 'all 매트릭스 2반');
  assert.deepEqual(math.classSubjectMatrix, [], 'subject 선택 시 매트릭스 []');
  const caRow = all.classSubjectMatrix.find(r => r.classId === ID.CA);
  const cbRow = all.classSubjectMatrix.find(r => r.classId === ID.CB);
  const cell = (row, key) => row.cells.find(c => c.subjectKey === key);
  assert.equal(cell(caRow, 'math').avgScore, 90, '매트릭스 CA×math=90');
  assert.equal(cell(caRow, 'korean').avgScore, 40, '매트릭스 CA×korean=40');
  // CB×math 는 채점형 2명<3 → 표본부족 회색(masked·null).
  assert.equal(cell(cbRow, 'math').masked, true, '매트릭스 CB×math masked=true(표본<3)');
  assert.equal(cell(cbRow, 'math').avgScore, null, '매트릭스 CB×math avgScore=null(표본부족)');

  // 잘못된 subject → 400.
  const bad = await req('/stats/class-compare?subject=coding', ID.teacherT);
  assert.equal(bad.status, 400, '잘못된 subject 400');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-CC-5: 권한 + 공용 헬퍼 재사용 회귀(equity 무영향).
// ──────────────────────────────────────────────────────────────────────────
test('INV-CC-5a: 권한 — teacher/admin 200 · student 403', async () => {
  const t = await req('/stats/class-compare', ID.teacherT);
  assert.equal(t.status, 200, 'teacher 200');
  const s = await req('/stats/class-compare', ID.studentX);
  assert.equal(s.status, 403, 'student 403');
  const admin = await req('/stats/class-compare', 1); // admin id=1
  assert.equal(admin.status, 200, 'admin 200(참고 접근 허용)');
  assert.equal(admin.json.success, true, 'admin success');
});

test('INV-CC-5b: 공용 헬퍼 재사용 회귀 — equity(admin) 정상 동작(스키마 무변경)', async () => {
  // class-compare 신설이 equity(공용 헬퍼 소비처)에 영향 없음을 교차 확인.
  const eq = await req('/stats/equity?dim=region&period=30d', 1);
  assert.equal(eq.status, 200, 'equity 200(admin)');
  assert.equal(eq.json.success, true, 'equity success');
  assert.ok(Array.isArray(eq.json.availableSubjects) && eq.json.availableSubjects.length === 10,
    'equity availableSubjects 10(공용 buildAvailableSubjects 정상)');
  // equity 는 users.region 축 — region NULL 인 합성 학생은 미노출(class-compare 삽입이 equity 오염 안 함).
  assert.ok(Array.isArray(eq.json.units), 'equity units 배열 유지');
});
