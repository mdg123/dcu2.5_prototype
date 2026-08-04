// test/growth-permission-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 보안·개인정보 — W3] routes/growth.js "학생 단위 / 클래스 단위" 교차 열람 차단.
//
// 결함(2026-08-04 실측, 로컬 3100 실세션):
//   W1(3c08d2a)이 routes/lrs.js 에서 막은 것과 **동일 부류**의 구멍이 growth 에 남아 있었다.
//   ① 검사 자체가 없던 라우트 3곳
//      · GET  /report/parent/:studentId  — 아무 로그인 사용자나 남의 자녀 성장 리포트를
//        실명("이학생")·정서발달 점수·참여도까지 200 으로 읽었다.
//      · GET  /emotion-monitor/:classId  — 학생 계정으로 학급 전원의 감정·자유서술 사유·
//        "주의 필요 학생"(3일 연속 부정 감정) 실명 목록이 200. 서비스 최민감 데이터.
//      · PUT  /report/visibility/:studentId — 쓰기. 아무나 임의 학생의 리포트 공개 설정을 덮어씀.
//   ② 역할만 보고 소속을 안 본 라우트 12곳 — 타 학교 교사(mteacher1)가 임의 학생의
//      리포트·관찰기록·포트폴리오·독서기록·오늘의학습 정오답을 **본인이 본 것과 바이트 동일**하게 열람.
//
// 불변식(INV-SEC-G0 ~ G9):
//   G0. 픽스처 전제(담당/비담당/부모 관계)가 실제로 성립
//   G1. 비담당 교사 → 학생 단위 growth 전수 403
//   G2. 담당 교사   → 200 유지 (과차단 없음)
//   G3. 학생        → 본인 200 / 타 학생 403
//   G4. admin       → 200 유지
//   G5. principal   → 자기 학교 학생 200 / 타 학교 403
//   G6. 학부모      → 자기 자녀 report/parent 200 / 남의 자녀 403 / 그 외 학생단위 403
//   G7. 클래스 단위 3종 → 비담당 교사·학생 403, 담당 교사 200
//   G8. 쓰기(visibility) → 학생·비담당 교사 403이며 **DB 행이 실제로 안 생김**
//   G9. 차단 응답 계약 — 403 + success:false + 한국어 message
//
// 검증 방식: permission.test.js / lrs-cross-teacher-guard.test.js 의 node:http + x-test-user
//   패턴. 실제 라우터·실제 미들웨어를 mount 하므로 권한 게이트 코드가 그대로 실행된다.
// DB 격리: 실 DB → 임시 복사본(무오염). G8 은 복사본에만 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입
const express = require('express');
const session = require('express-session');
const db = openTestDb();

let server, baseUrl;

function uidOf(username) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r.id;
}

const ADMIN = uidOf('admin');
const T1 = uidOf('teacher1');       // class 1 owner — S_TARGET 담당
const TFOE = uidOf('mteacher1');    // 청주북중 교사(class 1004 owner) — S_TARGET 비담당
const TSEED = uidOf('seed_t001');   // 청주남중 교사 — 클래스 미소유
const S_TARGET = uidOf('student1'); // 금성초, class 1 멤버 = 교차열람 표적
const S_OTHER = uidOf('student8');  // school_name NULL — principal 스코프 밖 대조군
const PRIN = uidOf('principal1');   // 금성초등학교 교장
const PARENT = uidOf('parent1');    // student1·student2 의 학부모(users.parent_id)

const TEACHER_TIER = ['owner', 'teacher', 'co_teacher'];

/** t 가 s 와 "교사-티어로 같은 클래스"를 공유하는가 (테스트 측 독립 판정). */
function sharesClass(teacherId, studentId) {
  const ph = TEACHER_TIER.map(() => '?').join(',');
  return !!db.prepare(`
    SELECT 1 FROM class_members t
    JOIN class_members s ON s.class_id = t.class_id
    WHERE t.user_id = ? AND t.status='active' AND t.role IN (${ph})
      AND s.user_id = ? AND s.status='active' LIMIT 1
  `).get(teacherId, ...TEACHER_TIER, studentId);
}

/** teacherId 가 교사-티어 멤버인 클래스 하나 (담당 클래스 대조군용). */
function ownClassOf(teacherId) {
  const ph = TEACHER_TIER.map(() => '?').join(',');
  const r = db.prepare(
    `SELECT class_id FROM class_members WHERE user_id = ? AND status='active' AND role IN (${ph}) LIMIT 1`
  ).get(teacherId, ...TEACHER_TIER);
  return r ? r.class_id : null;
}

const CLASS_T1 = ownClassOf(T1);      // teacher1 담당 클래스
const CLASS_FOE = ownClassOf(TFOE);   // mteacher1 담당 클래스 (teacher1 에겐 남의 반)

// ── 학생 단위 growth 엔드포인트 전수 ─────────────────────────────────────────
//   ※ "권한 게이트"만 검증한다. 허용 케이스는 데이터 사정에 따라 200/400/404 가 될 수
//     있으므로 `!== 403` 을 통과로 본다(pdf-report-permission.test.js 와 동일 관례).
function studentEndpoints(uid) {
  return [
    ['학부모 리포트',        `/api/growth/report/parent/${uid}`],
    ['성장 리포트',          `/api/growth/report/student/${uid}`],
    ['리포트 영역 상세',      `/api/growth/report/student/${uid}/area/academic`],
    ['교사 관찰기록(민감)',   `/api/growth/report/observations/${uid}`],
    ['리포트 드릴다운',       `/api/growth/report/student/${uid}/detail?type=assignment`],
    ['보고서 종합 페이로드',  `/api/growth/portfolios/${uid}/report-data`],
    ['포트폴리오 항목',       `/api/growth/portfolio/items?userId=${uid}`],
    ['역량 통계',            `/api/growth/portfolio/competency-stats?userId=${uid}`],
    ['포트폴리오 통계',       `/api/growth/portfolio/stats?userId=${uid}`],
    ['성장 목표',            `/api/growth/portfolio/goals?userId=${uid}`],
    ['독서기록',             `/api/growth/reading?studentId=${uid}`],
    ['오늘의학습 세트 항목',  `/api/growth/report/student/${uid}/daily-set/1/items`],
    ['오늘의학습 항목 결과',  `/api/growth/report/student/${uid}/daily-item/1/result`],
  ];
}

// 학생 본인·학부모에게는 "교사 업무" 라우트가 원래부터 닫혀 있다(정책, 결함 아님).
const TEACHER_ONLY = new Set(['오늘의학습 세트 항목', '오늘의학습 항목 결과']);

function classEndpoints(cid) {
  return [
    ['학급 감정 모니터(민감)', `/api/growth/emotion-monitor/${cid}`],
    ['학급 성장 대시보드',     `/api/growth/report/class/${cid}`],
    ['학급 오늘의학습',        `/api/growth/report/class/${cid}/daily-learning`],
  ];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/growth', require('../routes/growth'));
  return app;
}

function call(method, path, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(baseUrl + path, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (p, u) => call('GET', p, u);

before(async () => {
  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// G0: 픽스처 전제 — 시드가 바뀌어 대조가 무너지면 G1~G7 이 무의미해지므로 먼저 못박는다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G0: 픽스처 전제 — 담당/비담당/부모관계/학교스코프가 성립', () => {
  assert.ok(sharesClass(T1, S_TARGET), 'teacher1 은 student1 과 클래스를 공유해야(담당)');
  assert.ok(!sharesClass(TFOE, S_TARGET), 'mteacher1 은 student1 과 클래스를 공유하면 안 됨(타 학교)');
  assert.ok(!sharesClass(TSEED, S_TARGET), 'seed_t001 은 student1 과 클래스를 공유하면 안 됨');
  assert.ok(CLASS_T1, 'teacher1 의 담당 클래스가 존재');
  assert.ok(CLASS_FOE, 'mteacher1 의 담당 클래스가 존재(teacher1 에겐 남의 반)');
  assert.notEqual(CLASS_T1, CLASS_FOE, '두 클래스는 서로 달라야 대조가 성립');

  const rel = db.prepare('SELECT parent_id FROM users WHERE id = ?').get(S_TARGET);
  assert.equal(rel.parent_id, PARENT, '전제: parent1 은 student1 의 학부모(users.parent_id)');
  const other = db.prepare('SELECT parent_id FROM users WHERE id = ?').get(S_OTHER);
  assert.notEqual(other.parent_id, PARENT, '전제: student8 은 parent1 의 자녀가 아니다');

  const pS = db.prepare('SELECT school_name s FROM users WHERE id = ?').get(PRIN).s;
  const tS = db.prepare('SELECT school_name s FROM users WHERE id = ?').get(S_TARGET).s;
  const oS = db.prepare('SELECT school_name s FROM users WHERE id = ?').get(S_OTHER).s;
  assert.ok(pS, '전제: principal1 은 school_name 을 가진다');
  assert.equal(tS, pS, '전제: student1 은 교장과 같은 학교');
  assert.notEqual(String(oS || ''), String(pS), '전제: student8 은 교장의 학교가 아니다');
});

// ──────────────────────────────────────────────────────────────────────────
// G1: 비담당 교사 → 학생 단위 growth 전수 403. (P0 결함 재현 → 고친 뒤 초록)
// ──────────────────────────────────────────────────────────────────────────
for (const [label, tid] of [['mteacher1(타 학교)', () => TFOE], ['seed_t001(타 학교)', () => TSEED]]) {
  test(`INV-SEC-G1: 비담당 교사 ${label} → 학생 단위 growth 전수 403`, async () => {
    const leaks = [];
    for (const [name, path] of studentEndpoints(S_TARGET)) {
      const r = await get(path, tid());
      if (r.status !== 403) leaks.push(`${name} (${path}) → ${r.status}`);
    }
    assert.deepEqual(leaks, [], `비담당 교사에게 열린 학생 단위 엔드포인트:\n  - ${leaks.join('\n  - ')}`);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// G2: 담당 교사 → 통과 유지 (과차단 회귀 방지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G2: 담당 교사(teacher1) → 자기 반 학생 growth 게이트 통과 유지', async () => {
  const broken = [];
  for (const [name, path] of studentEndpoints(S_TARGET)) {
    const r = await get(path, T1);
    if (r.status === 403) broken.push(`${name} (${path}) → 403`);
  }
  assert.deepEqual(broken, [], `담당 교사가 차단됨(과차단):\n  - ${broken.join('\n  - ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// G3: 학생 — 본인 통과 / 타 학생 403.
//   ★ report/parent 가 여기 포함된다: 과거엔 검사가 없어 타 학생이 200 으로 읽었다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G3: 학생 → 본인 통과 · 타 학생 전수 403', async () => {
  const selfBroken = [], leaks = [];
  for (const [name, path] of studentEndpoints(S_TARGET)) {
    if (TEACHER_ONLY.has(name)) continue;         // 교사 업무 라우트는 본인에게도 닫힘(정책)
    const r = await get(path, S_TARGET);
    if (r.status === 403) selfBroken.push(`${name} → 403`);
  }
  for (const [name, path] of studentEndpoints(S_TARGET)) {
    const r = await get(path, S_OTHER);           // 남의 학생 계정으로
    if (r.status !== 403) leaks.push(`${name} (${path}) → ${r.status}`);
  }
  assert.deepEqual(selfBroken, [], `학생 본인 열람이 막힘: ${selfBroken.join(', ')}`);
  assert.deepEqual(leaks, [], `학생이 타 학생 데이터를 열람:\n  - ${leaks.join('\n  - ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// G4: admin → 통과 유지 (거버넌스 전체 권한).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G4: admin → 학생 단위 growth 통과 유지', async () => {
  const broken = [];
  for (const [name, path] of studentEndpoints(S_TARGET)) {
    const r = await get(path, ADMIN);
    if (r.status === 403) broken.push(`${name} → 403`);
  }
  assert.deepEqual(broken, [], `admin 이 차단됨: ${broken.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// G5: principal — 자기 school_name 학교 학생만 (requireSchoolScope 스코프와 정합).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G5: principal → 자기 학교 학생 통과 · 타 학교 학생 403', async () => {
  const broken = [], leaks = [];
  for (const [name, path] of studentEndpoints(S_TARGET)) {
    if (TEACHER_ONLY.has(name)) continue;         // 담임 업무 라우트는 교장 대상 아님
    const r = await get(path, PRIN);
    if (r.status === 403) broken.push(`${name} → 403`);
  }
  for (const [name, path] of studentEndpoints(S_OTHER)) {
    const r = await get(path, PRIN);
    if (r.status !== 403) leaks.push(`${name} → ${r.status}`);
  }
  assert.deepEqual(broken, [], `교장이 자기 학교 학생을 못 봄(과차단): ${broken.join(', ')}`);
  assert.deepEqual(leaks, [], `교장이 타 학교 학생을 열람: ${leaks.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// G6: 학부모 — 관계(users.parent_id) 기반 전용 경로만. 그 외 학생 단위는 전부 거부.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G6: 학부모 → 자기 자녀 report/parent 200 · 남의 자녀 403 · 그 외 학생단위 403', async () => {
  const mine = await get(`/api/growth/report/parent/${S_TARGET}`, PARENT);
  assert.equal(mine.status, 200, `자기 자녀 학부모 리포트는 200 (실제=${mine.status})`);

  const other = await get(`/api/growth/report/parent/${S_OTHER}`, PARENT);
  assert.equal(other.status, 403, `남의 자녀 학부모 리포트는 403 (실제=${other.status})`);

  const leaks = [];
  for (const [name, path] of studentEndpoints(S_TARGET)) {
    if (name === '학부모 리포트') continue;       // 위에서 별도 검증(정상 동선)
    const r = await get(path, PARENT);
    if (r.status !== 403) leaks.push(`${name} → ${r.status}`);
  }
  assert.deepEqual(leaks, [], `학부모가 전용 경로 밖 학생 데이터를 열람: ${leaks.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// G7: 클래스 단위 3종 — 감정 모니터는 이 서비스 최민감 데이터인데 무검사였다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G7: 클래스 단위 — 담당 교사 200 · 비담당 교사/학생 403', async () => {
  const broken = [], leaks = [];
  for (const [name, path] of classEndpoints(CLASS_T1)) {
    const r = await get(path, T1);
    if (r.status === 403) broken.push(`담당 교사 ${name} → 403`);
    const foe = await get(path, TFOE);
    if (foe.status !== 403) leaks.push(`비담당 교사 ${name} → ${foe.status}`);
    const stu = await get(path, S_TARGET);
    if (stu.status !== 403) leaks.push(`학생(멤버) ${name} → ${stu.status}`);
  }
  // 담당 교사라도 "남의 반" 은 막혀야 한다.
  for (const [name, path] of classEndpoints(CLASS_FOE)) {
    const r = await get(path, T1);
    if (r.status !== 403) leaks.push(`teacher1 이 남의 반 ${name} → ${r.status}`);
  }
  assert.deepEqual(broken, [], `담당 교사가 차단됨(과차단): ${broken.join(', ')}`);
  assert.deepEqual(leaks, [], `클래스 경계 유출:\n  - ${leaks.join('\n  - ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// G8: 쓰기 라우트 — PUT /report/visibility/:studentId.
//   403 만 보지 않고 **DB 행이 실제로 안 생겼는지**까지 확인한다(응답만 막고 쓰기는
//   되는 형태의 회귀 방지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G8: 리포트 공개설정 쓰기 — 학생·비담당 교사 403 + DB 미변경, 담당 교사만 반영', async () => {
  const countRows = (teacherId) => db.prepare(
    'SELECT COUNT(*) c FROM report_visibility WHERE teacher_id = ? AND student_id = ?'
  ).get(teacherId, S_TARGET).c;

  const body = { isVisible: false, showEmotion: false, classId: 0 };

  const beforeStu = countRows(S_TARGET);
  const r1 = await call('PUT', `/api/growth/report/visibility/${S_TARGET}`, S_TARGET, body);
  assert.equal(r1.status, 403, `학생이 자기 공개설정을 바꾸면 403 (실제=${r1.status})`);
  assert.equal(countRows(S_TARGET), beforeStu, '차단됐는데 report_visibility 행이 생겼다(쓰기 누출)');

  const beforeFoe = countRows(TFOE);
  const r2 = await call('PUT', `/api/growth/report/visibility/${S_TARGET}`, TFOE, body);
  assert.equal(r2.status, 403, `비담당 교사의 공개설정 변경은 403 (실제=${r2.status})`);
  assert.equal(countRows(TFOE), beforeFoe, '차단됐는데 report_visibility 행이 생겼다(쓰기 누출)');

  const r3 = await call('PUT', `/api/growth/report/visibility/${S_TARGET}`, T1, body);
  assert.equal(r3.status, 200, `담당 교사는 공개설정을 바꿀 수 있어야 (실제=${r3.status})`);
  assert.ok(countRows(T1) > 0, '담당 교사의 설정이 report_visibility 에 반영돼야 한다');
});

// ──────────────────────────────────────────────────────────────────────────
// G9: 차단 응답 계약 — 403 + success:false + 한국어 message. 정보 노출 없이 거부.
//   그리고 파라미터형(userId=)은 "조용한 본인 폴백"이 아니라 명시적 거부여야 한다
//   (조용한 폴백은 호출자가 남의 데이터를 본 줄 알게 만들어 진단을 어렵게 한다).
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// G10: **쓰기(POST/PUT/DELETE) 경로 전수** — 읽기만 보고 감사한 것이 W3 1차의 누락 원인이다.
//
//   1차 커밋은 GET 13종만 표로 만들어 막았고, 같은 자원의 쓰기를 놓쳤다. 감리가 뚫었다:
//     mteacher1(청주북중, 무관 교사) POST /report/observation {studentId:3} → 200
//     → teacher_observations 14→15행 → student1 본인·teacher1 담임 화면에
//       **모르는 교사 명의의 생활지도 서술**이 그대로 렌더.
//   읽기 가드와 쓰기 가드는 반드시 짝으로 존재해야 한다. 이 테스트가 그 짝을 강제한다.
//
//   403 만 보지 않고 **DB 행 수가 안 변했는지**까지 확인한다(응답만 막고 쓰기는 되는 형태 차단).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G10: 학생 대상 쓰기 — 비담당 교사·학생·학부모 403 + DB 미변경, 담당 교사/admin 만 반영', async () => {
  const obsCount = () => db.prepare(
    'SELECT COUNT(*) c FROM teacher_observations WHERE student_id = ?'
  ).get(S_TARGET).c;

  // 학생 대상 쓰기 라우트 전수 (body/param 으로 대상 학생을 지정하는 것들)
  const writes = [
    ['관찰 기록 작성', 'POST', '/api/growth/report/observation',
      { studentId: S_TARGET, classId: CLASS_T1, text: '[G10 침투] 무관 교사 주입 시도', area: '학습태도' }],
    ['리포트 공개설정', 'PUT', `/api/growth/report/visibility/${S_TARGET}`,
      { isVisible: false, showEmotion: false, classId: 0 }],
  ];

  // ① 무관 교사·타 학생·학부모 → 전수 403, 그리고 행 수 불변
  for (const [who, actor] of [['mteacher1(비담당)', TFOE], ['seed_t001(비담당)', TSEED],
                              ['student8(타 학생)', S_OTHER], ['parent1(학부모)', PARENT],
                              ['student1(본인)', S_TARGET]]) {
    for (const [label, method, path, body] of writes) {
      const before = obsCount();
      const r = await call(method, path, actor, body);
      assert.equal(r.status, 403, `${who} 의 "${label}" 쓰기는 403 이어야 (실제=${r.status} ${r.body.slice(0, 90)})`);
      assert.equal(obsCount(), before,
        `${who} 의 "${label}" 이 차단됐는데 teacher_observations 행이 늘었다(쓰기 누출)`);
    }
  }

  // ② 담당 교사·admin → 실제로 써져야 한다(과차단 방지). 행 수 증가로 확인.
  for (const [who, actor] of [['teacher1(담임)', T1], ['admin', ADMIN]]) {
    const before = obsCount();
    const r = await call('POST', '/api/growth/report/observation', actor,
      { studentId: S_TARGET, classId: CLASS_T1, text: `[G10] ${who} 정상 기록`, area: '학습태도' });
    assert.notEqual(r.status, 403, `${who} 의 관찰 기록 작성이 차단됨(과차단, 실제=${r.status})`);
    assert.equal(obsCount(), before + 1, `${who} 의 관찰 기록이 실제로 저장돼야 한다`);
  }

  // ③ studentId 누락/비정수 → 400. (구 코드는 body 를 그대로 넘겨 student_id=NULL 행을 만들었다.)
  const bad = await call('POST', '/api/growth/report/observation', T1, { text: 'studentId 없음' });
  assert.equal(bad.status, 400, `studentId 없는 관찰 기록은 400 (실제=${bad.status})`);
});

// ──────────────────────────────────────────────────────────────────────────
// G10b: 본인 소유 자원 쓰기(독서·진로·성장목표)는 그대로 동작하고, 남의 것은 못 건드린다.
//   이 라우트들은 req.user.id 를 db 층에 넘기고 db 가 `WHERE id=? AND user_id=?` 로
//   스코프한다(감사 확인). 그 스코프가 사라지면 여기서 붉어진다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G10b: 본인 소유 쓰기 유지 · 남의 자원 id 로는 수정/삭제 불가', async () => {
  // 본인 쓰기 정상
  const mk = await call('POST', '/api/growth/reading', S_TARGET, { bookTitle: 'G10b 테스트 도서' });
  assert.equal(mk.status, 200, `학생 본인 독서기록 작성은 200 (실제=${mk.status})`);
  const mineId = JSON.parse(mk.body).id;
  assert.ok(mineId, '생성된 독서기록 id 를 받아야 한다');

  // 남의 학생이 그 id 를 수정/삭제 시도 → 404(소유 스코프 밖이라 대상 없음)
  const upd = await call('PUT', `/api/growth/reading/${mineId}`, S_OTHER, { bookTitle: '탈취 시도' });
  assert.equal(upd.status, 404, `남의 독서기록 수정은 404 (실제=${upd.status})`);
  const del = await call('DELETE', `/api/growth/reading/${mineId}`, S_OTHER);
  assert.equal(del.status, 404, `남의 독서기록 삭제는 404 (실제=${del.status})`);

  // 원본이 살아 있어야 한다(실제 미변경 확인)
  const still = db.prepare('SELECT book_title FROM reading_logs WHERE id = ?').get(mineId);
  assert.ok(still, '차단됐는데 남의 계정이 원본을 지웠다');
  assert.equal(still.book_title, 'G10b 테스트 도서', '차단됐는데 남의 계정이 원본을 고쳤다');
});

// ──────────────────────────────────────────────────────────────────────────
// G11: 리포트 3라우트(생성 POST · 화면조회 GET report-data · 다운로드 GET download)의
//   권한 판정이 **같아야** 한다.
//
//   W3 1차가 canAccessStudentReport 에 principal 을 넣으면서 생성·조회는 통과하는데
//   다운로드만 판정을 손으로 다시 써(role==='teacher' && shares) principal 을 빠뜨렸다.
//   → 교장이 PDF 를 만들 수는 있는데 받을 수 없고 uploads/ 에 고아 파일만 쌓였다(실측).
//   pdf-report-permission.test.js 의 "결함 #7"(그땐 담임이 피해자)과 같은 모순의 재발.
//   판정이 갈라지는 순간 붉어지도록, 세 라우트의 403 여부를 actor 별로 대조한다.
//
//   ※ PDF 를 실제로 만들지 않는다(디스크 오염 금지) — 합성 행을 격리 사본에 넣고
//     "게이트 통과 시 404(파일 없음) / 차단 시 403" 의 차이로 판정한다.
// ──────────────────────────────────────────────────────────────────────────
//   [W4] 여기에 **PDF 이력(GET /portfolios/reports?userId=)** 을 4번째 라우트로 합류시킨다.
//   이력만 판정을 손으로 다시 써(`role==='admin' && query.userId` 일 때만 대상 인정) 담임·교장이
//   요청한 userId 를 **조용히 무시하고 본인 것으로 폴백**했다 → 담임 화면에 "이력 없음"(실측
//   2026-08-04: teacher1 → 200 reports:0, student1 본인 → 200 reports:18).
//   조용한 폴백은 "권한이 없다"를 "데이터가 없다"로 위장해 진단을 막는다(G9 가 금지한 패턴).
test('INV-SEC-G11: 리포트 생성·조회·다운로드·이력 4라우트의 권한 판정 일치(principal 포함)', async () => {
  const rid = `rpt_g11_${Date.now()}`;
  db.prepare(`
    INSERT INTO portfolio_reports (id, user_id, title, period_from, period_to, school_level, file_path, status)
    VALUES (?, ?, 'G11 게이트 검증', '2026-01-01', '2026-12-31', 'elementary', ?, 'ready')
  `).run(rid, S_TARGET, `${rid}-존재하지-않는-파일.pdf`);

  const actors = [
    ['본인(student1)', S_TARGET, true],
    ['담임(teacher1)', T1, true],
    ['admin', ADMIN, true],
    ['교장(자기 학교)', PRIN, true],
    ['비담당 교사(mteacher1)', TFOE, false],
    ['타 학생(student8)', S_OTHER, false],
    ['학부모(parent1)', PARENT, false],
  ];

  const mismatches = [];
  for (const [who, actor, shouldPass] of actors) {
    const dl = await call('GET', `/api/growth/portfolios/report/${rid}/download`, actor);
    const view = await call('GET', `/api/growth/portfolios/${S_TARGET}/report-data`, actor);
    const hist = await call('GET', `/api/growth/portfolios/reports?userId=${S_TARGET}`, actor);
    const dlPassed = dl.status !== 403;
    const viewPassed = view.status !== 403;
    const histPassed = hist.status !== 403;

    if (dlPassed !== viewPassed) {
      mismatches.push(`${who}: 화면조회 ${viewPassed ? '허용' : '차단'} 인데 다운로드 ${dlPassed ? '허용' : '차단'}`);
    }
    if (histPassed !== viewPassed) {
      mismatches.push(`${who}: 화면조회 ${viewPassed ? '허용' : '차단'} 인데 PDF 이력 ${histPassed ? '허용' : '차단'}`);
    }
    if (dlPassed !== shouldPass) {
      mismatches.push(`${who}: 다운로드 기대=${shouldPass ? '허용' : '차단'} 실제=${dl.status}`);
    }
    // 게이트를 통과했다면 파일이 없으니 404 여야 한다(=권한이 아니라 파일 문제).
    if (dlPassed) {
      assert.equal(dl.status, 404, `${who}: 게이트 통과 시 파일 부재 404 여야 (실제=${dl.status})`);
    }
  }
  assert.deepEqual(mismatches, [],
    `리포트 3라우트 권한 판정 불일치:\n  - ${mismatches.join('\n  - ')}`);

  db.prepare('DELETE FROM portfolio_reports WHERE id = ?').run(rid);   // 격리 사본 정리
});

// ──────────────────────────────────────────────────────────────────────────
// G12: PDF 이력의 **대상 해석** — "허용/차단"만이 아니라 "누구의 데이터를 돌려주는가".
//
//   G11 은 403 여부만 본다. 조용한 본인 폴백은 403 을 내지 않으므로 G11 만으로는 못 잡는다
//   (담임 → 200 인데 내용이 본인 것 = "이력 없음"으로 보임). 그래서 여기서 **내용**을 대조한다:
//     · 담임/교장/admin 이 ?userId=학생 으로 받은 목록 == 학생 본인이 받은 목록
//     · 요청자 본인의 이력이 섞여 있으면 폴백(붉어짐)
//     · 파라미터를 안 주면 종전대로 본인 이력(회귀 방지)
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G12: PDF 이력 — 담당 교사·교장·admin 이 "대상 학생의" 이력을 받는다(조용한 본인 폴백 금지)', async () => {
  const stamp = Date.now();
  const ridS = `rpt_g12_s_${stamp}`;   // 대상 학생 소유
  const ridT = `rpt_g12_t_${stamp}`;   // 요청자(교사) 본인 소유 — 폴백 검출용 미끼
  const ins = db.prepare(`
    INSERT INTO portfolio_reports (id, user_id, title, period_from, period_to, school_level, status)
    VALUES (?, ?, ?, '2026-01-01', '2026-12-31', 'elementary', 'ready')
  `);
  ins.run(ridS, S_TARGET, 'G12 학생 이력');
  ins.run(ridT, T1, 'G12 교사 본인 이력');

  const idsOf = (r) => {
    const p = JSON.parse(r.body);
    assert.ok(Array.isArray(p.reports), `reports 배열이 있어야 한다 (실제=${r.body.slice(0, 120)})`);
    return p.reports.map((x) => x.id);
  };

  try {
    const self = await get('/api/growth/portfolios/reports', S_TARGET);
    assert.equal(self.status, 200, `학생 본인 이력은 200 (실제=${self.status})`);
    const selfIds = idsOf(self).sort();
    assert.ok(selfIds.includes(ridS), '전제: 학생 본인 이력에 합성 행이 보여야 한다');

    for (const [who, actor] of [['담임(teacher1)', T1], ['교장(자기 학교)', PRIN], ['admin', ADMIN]]) {
      const r = await get(`/api/growth/portfolios/reports?userId=${S_TARGET}`, actor);
      assert.equal(r.status, 200, `${who} 의 학생 PDF 이력 조회는 200 (실제=${r.status})`);
      const got = idsOf(r).sort();
      assert.ok(got.includes(ridS), `${who} 가 학생 이력을 못 본다(조용한 본인 폴백)`);
      assert.ok(!got.includes(ridT), `${who} 응답에 요청자 본인 이력이 섞였다(조용한 본인 폴백)`);
      assert.deepEqual(got, selfIds, `${who} 가 받은 이력이 학생 본인 것과 다르다`);
    }

    // 차단은 "빈 목록 200" 이 아니라 403 이어야 한다(권한 문제를 데이터 문제로 위장 금지).
    for (const [who, actor] of [['비담당 교사(mteacher1)', TFOE], ['타 학생(student8)', S_OTHER],
                                ['학부모(parent1)', PARENT]]) {
      const r = await get(`/api/growth/portfolios/reports?userId=${S_TARGET}`, actor);
      assert.equal(r.status, 403, `${who} 의 남의 PDF 이력 조회는 403 (실제=${r.status} ${r.body.slice(0, 90)})`);
      const p = JSON.parse(r.body);
      assert.equal(p.success, false, `${who} 차단 응답은 success:false`);
      assert.ok(!('reports' in p), `${who} 차단인데 reports 를 함께 돌려줬다`);
    }

    // 파라미터 미지정 = 본인 이력(기존 동선 회귀 방지)
    const own = await get('/api/growth/portfolios/reports', T1);
    assert.equal(own.status, 200, `파라미터 없는 본인 이력은 200 (실제=${own.status})`);
    const ownIds = idsOf(own);
    assert.ok(ownIds.includes(ridT), '파라미터 없으면 요청자 본인 이력이어야 한다');
    assert.ok(!ownIds.includes(ridS), '파라미터가 없는데 남의 이력이 섞였다');
  } finally {
    db.prepare('DELETE FROM portfolio_reports WHERE id IN (?, ?)').run(ridS, ridT);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// G13: 클래스 성장 현황(GET /api/growth/class/:classId) 의 판정이 **SSOT 한 벌**인가.
//
//   이 라우트만 `getMemberRole(...) === 'owner'` 로 손수 판정해 SSOT
//   (lib/auth/can-view-user.js: CLASS_TEACHER_ROLES = owner|teacher|co_teacher)를 안 썼다.
//   현재 시드에 co_teacher 행이 0 건이라 실해는 없지만, **같은 판정이 두 벌 있는 상태 자체**가
//   W3 사고(다운로드만 principal 누락)의 원인이었다. 판정이 갈라지면 여기서 붉어진다.
//
//   ※ class_members 에는 아직 CHECK(role IN ('owner','member')) 가 남아 있어 co_teacher 를
//     정상 INSERT 할 수 없다(별건 — 스키마·SSOT 불일치로 보고). 격리 사본에서만
//     ignore_check_constraints 로 우회해 "SSOT 가 인정하는 티어"를 실제로 태워 본다.
//     정본 DB 는 손대지 않는다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-G13: 클래스 성장 현황 — SSOT 교사-티어(co_teacher) 통과 · 비멤버/학생 403', async () => {
  const url = `/api/growth/class/${CLASS_FOE}`;

  const existing = db.prepare('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?')
    .get(CLASS_FOE, TSEED);
  assert.ok(!existing, '전제: seed_t001 은 CLASS_FOE 의 멤버가 아니어야 한다');

  const before = await get(url, TSEED);
  assert.equal(before.status, 403, `비멤버 교사는 403 (실제=${before.status})`);

  db.pragma('ignore_check_constraints = ON');
  db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'co_teacher', 'active')")
    .run(CLASS_FOE, TSEED);
  try {
    const co = await get(url, TSEED);
    assert.notEqual(co.status, 403,
      `co_teacher 는 CLASS_TEACHER_ROLES(SSOT) 에 속하는데 차단됨(실제=${co.status}) — ` +
      `라우트가 role==='owner' 를 손으로 다시 판정하고 있다`);

    const owner = await get(url, TFOE);
    assert.notEqual(owner.status, 403, `개설자(owner)가 차단됨(과차단 회귀, 실제=${owner.status})`);
    const ad = await get(url, ADMIN);
    assert.notEqual(ad.status, 403, `admin 이 차단됨(실제=${ad.status})`);

    const stu = await get(`/api/growth/class/${CLASS_T1}`, S_TARGET);
    assert.equal(stu.status, 403, `학생 멤버가 클래스 성장 현황을 열람(실제=${stu.status})`);
    const foe = await get(`/api/growth/class/${CLASS_T1}`, TFOE);
    assert.equal(foe.status, 403, `비담당 교사가 남의 반 성장 현황을 열람(실제=${foe.status})`);
  } finally {
    db.prepare("DELETE FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'co_teacher'")
      .run(CLASS_FOE, TSEED);
    db.pragma('ignore_check_constraints = OFF');
  }
});

test('INV-SEC-G9: 차단 응답 계약 — 403 + success:false + 한국어 message', async () => {
  for (const path of [
    `/api/growth/report/parent/${S_TARGET}`,
    `/api/growth/emotion-monitor/${CLASS_T1}`,
    `/api/growth/portfolio/items?userId=${S_TARGET}`,
  ]) {
    const r = await get(path, TFOE);
    assert.equal(r.status, 403, `${path} 는 비담당 교사에게 403 (실제=${r.status})`);
    const p = JSON.parse(r.body);
    assert.equal(p.success, false, `${path} 차단 응답은 success:false`);
    assert.equal(typeof p.message, 'string', `${path} 는 한국어 message 포함`);
    assert.ok(/[가-힣]/.test(p.message), `${path} message 는 한국어여야 한다`);
  }
});
