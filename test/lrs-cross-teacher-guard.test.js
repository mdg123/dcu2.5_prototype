// test/lrs-cross-teacher-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 보안·개인정보] 비담당 교사의 "학생 단위" LRS 열람 차단 (canViewUser 소속 검증).
//
// 결함(교사 감사관 실증, 2026-07-30):
//   routes/lrs.js canViewUser() 판정이 사실상 "본인 or role==='teacher' or role==='admin'" 이라
//   담임·소속 검증이 전무했다. → 시스템의 아무 교사나(심지어 전혀 다른 학교의 중학교 교사
//   seed_t001) 아무 학생의 학습·정서 데이터를 200 OK 로 열람할 수 있었다.
//   emotion-mirror(감정) 포함 = 민감정보 유출.
//   대조: 반 단위 가드(canViewClass)는 이미 올바르게 403 이었다 → 학생 단위만 뚫려 있었다.
//
// 불변식(INV-SEC-U1 ~ U4):
//   U1. 비담당 교사 → 학생 단위 LRS 엔드포인트 전수 403 (담당 클래스 공유 없음)
//   U2. 담당 교사(그 학생이 자기 클래스 active 멤버) → 200 유지 (과차단 없음)
//   U3. 학생 → 본인 200 / 타 학생 403
//   U4. admin → 200 유지
//
// 검증 방식: permission.test.js 의 node:http + x-test-user(테스트 세션 주입) 패턴.
//   실제 라우터·실제 미들웨어를 mount 하므로 권한 게이트 코드 그대로 실행된다.
// DB 격리: 실 DB → 임시 복사본(무오염).
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
  const r = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r.id;
}

const ADMIN = uidOf('admin');
const T1 = uidOf('teacher1');      // class 1 소유 (담당 교사)
const T2 = uidOf('teacher2');      // 다른 클래스 소유 (비담당)
const TSEED = uidOf('seed_t001');  // 전혀 다른 학교(청주남중) 교사 — 클래스 미소유
const S_SELF = uidOf('student1');  // 본인 열람 대조군
const S_TARGET = uidOf('student8'); // teacher1 반(class 1)에만 속한 학생 = 교차열람 표적

// 교사-티어 멤버 role (routes/lrs.js CLASS_TEACHER_ROLES 와 동일 정의)
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

// mastery/detail 은 achievement_code 필수(400 이 403 보다 먼저) → 실제 코드 하나 확보.
function pickAchievementCode() {
  const r = db.prepare(`
    SELECT achievement_code c FROM learning_logs
    WHERE achievement_code IS NOT NULL AND achievement_code <> '' LIMIT 1
  `).get();
  return (r && r.c) || '[4수01-01]';
}
// statements/:id 는 404 가 먼저 → S_TARGET 소유 로그 id 확보(없으면 null → 해당 항목 skip)
function pickStatementId(userId) {
  const r = db.prepare('SELECT id FROM learning_logs WHERE user_id = ? LIMIT 1').get(userId);
  return r ? r.id : null;
}

const ACODE = encodeURIComponent(pickAchievementCode());
const STMT_ID = pickStatementId(S_TARGET);

// ── 학생 단위 LRS 엔드포인트 전수 (canViewUser 를 게이트로 쓰는 라우트) ──────────
//   ※ statements/:id 는 STMT_ID 확보 시에만 포함.
function endpointsFor(uid) {
  const list = [
    { label: '학생 상세',            path: `/api/lrs/student/${uid}` },
    { label: '인사이트',              path: `/api/lrs/insights/${uid}` },
    { label: '성취수준(학생)',        path: `/api/lrs/mastery/student/${uid}` },
    { label: '성취수준 드릴다운',     path: `/api/lrs/mastery/detail?user_id=${uid}&achievement_code=${ACODE}` },
    { label: '추세(학생)',            path: `/api/lrs/trend/student/${uid}` },
    { label: '감정-성취 미러(민감)',  path: `/api/lrs/emotion-mirror/${uid}` },
    { label: '또래 비교',             path: `/api/lrs/peer-compare/${uid}` },
    { label: '다음 단계 추천',        path: `/api/lrs/next-step/${uid}` },
    { label: '재도전 성장',           path: `/api/lrs/retry-growth/${uid}` },
    { label: '사용자 요약 통계',      path: `/api/lrs/stats/user-summary?user_id=${uid}` },
    { label: '성취기준별 통계',       path: `/api/lrs/stats/by-achievement?user_id=${uid}` },
    { label: '성취기준 진척',         path: `/api/lrs/achievement-progress?userId=${uid}` },
    { label: '수행 드릴다운',         path: `/api/lrs/perform/detail?userId=${uid}&bucket=all` },
    { label: '학부모 다이제스트',     path: `/api/lrs/parent/${uid}/digest` },
  ];
  if (STMT_ID && uid === S_TARGET) {
    list.push({ label: 'statement 단건', path: `/api/lrs/statements/${STMT_ID}` });
  }
  return list;
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
  app.use('/api/lrs', require('../routes/lrs'));
  return app;
}

function get(path, asUser) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const req = http.request(baseUrl + path, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

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
// 전제조건 — 픽스처가 "담당/비담당" 대조를 실제로 성립시키는지 먼저 못박는다.
//   (시드가 바뀌어 T2 가 S_TARGET 담당이 되면 U1 이 무의미해지므로 여기서 빨간불.)
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U0: 픽스처 전제 — T1은 S_TARGET 담당, T2·seed_t001은 비담당', () => {
  assert.ok(sharesClass(T1, S_TARGET), 'teacher1 은 student8 과 클래스를 공유해야(담당)');
  assert.ok(!sharesClass(T2, S_TARGET), 'teacher2 는 student8 과 클래스를 공유하면 안 됨(비담당)');
  assert.ok(!sharesClass(TSEED, S_TARGET), 'seed_t001 은 student8 과 클래스를 공유하면 안 됨(타 학교)');
});

// ──────────────────────────────────────────────────────────────────────────
// U1: 비담당 교사 → 학생 단위 LRS 전수 403. (P0 결함 재현 → 고친 뒤 초록)
// ──────────────────────────────────────────────────────────────────────────
for (const [label, tid] of [['teacher2(타 반 담임)', () => T2], ['seed_t001(타 학교 교사)', () => TSEED]]) {
  test(`INV-SEC-U1: 비담당 교사 ${label} → 학생 단위 LRS 전수 403`, async () => {
    const leaks = [];
    for (const ep of endpointsFor(S_TARGET)) {
      const r = await get(ep.path, tid());
      if (r.status !== 403) leaks.push(`${ep.label} (${ep.path}) → ${r.status}`);
    }
    assert.deepEqual(leaks, [], `비담당 교사에게 열린 학생 단위 엔드포인트:\n  - ${leaks.join('\n  - ')}`);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// U2: 담당 교사 → 200 유지 (과차단 회귀 방지). 정당한 교사가 깨지면 안 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U2: 담당 교사(teacher1) → 자기 반 학생 학생단위 LRS 200 유지', async () => {
  const broken = [];
  for (const ep of endpointsFor(S_TARGET)) {
    const r = await get(ep.path, T1);
    if (r.status !== 200) broken.push(`${ep.label} (${ep.path}) → ${r.status}`);
  }
  assert.deepEqual(broken, [], `담당 교사가 차단됨(과차단):\n  - ${broken.join('\n  - ')}`);
});

// 담당 판정이 "클래스 공유" 기반임을 양성 대조로 못박는다.
//   teacher2 는 student8(비담당) 은 못 보지만, 자기 반 멤버인 student1 은 봐야 한다.
test('INV-SEC-U2b: 비담당이 아니라 "공유 클래스" 기준 — teacher2 → student1(자기 반 멤버) 200', async () => {
  assert.ok(sharesClass(T2, S_SELF), '전제: teacher2 는 student1 과 클래스를 공유(자기 반 멤버)');
  const broken = [];
  for (const ep of endpointsFor(S_SELF)) {
    const r = await get(ep.path, T2);
    if (r.status !== 200) broken.push(`${ep.label} → ${r.status}`);
  }
  assert.deepEqual(broken, [], `공유 클래스 학생인데 차단됨: ${broken.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// U3: 학생 — 본인 200 / 타 학생 403 (기존 정상 동작 회귀 방지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U3: 학생 → 본인 200 · 타 학생 403', async () => {
  const selfBroken = [], leaks = [];
  for (const ep of endpointsFor(S_SELF)) {
    const r = await get(ep.path, S_SELF);
    if (r.status !== 200) selfBroken.push(`${ep.label} → ${r.status}`);
  }
  for (const ep of endpointsFor(S_TARGET)) {
    const r = await get(ep.path, S_SELF);
    if (r.status !== 403) leaks.push(`${ep.label} → ${r.status}`);
  }
  assert.deepEqual(selfBroken, [], `학생 본인 열람이 막힘: ${selfBroken.join(', ')}`);
  assert.deepEqual(leaks, [], `학생이 타 학생 데이터를 열람: ${leaks.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// U4: admin → 200 유지 (거버넌스 전체 권한).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U4: admin → 학생 단위 LRS 200 유지', async () => {
  const broken = [];
  for (const ep of endpointsFor(S_TARGET)) {
    const r = await get(ep.path, ADMIN);
    if (r.status !== 200) broken.push(`${ep.label} → ${r.status}`);
  }
  assert.deepEqual(broken, [], `admin 이 차단됨: ${broken.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// U5: 차단 응답 계약 — 403 + { success:false, message:'권한이 없습니다.' }.
//   민감 라우트(감정)가 정보 노출 없이 거부되는지.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U5: 감정 미러 차단 응답은 403 + success:false 계약', async () => {
  const r = await get(`/api/lrs/emotion-mirror/${S_TARGET}`, TSEED);
  assert.equal(r.status, 403, `타 학교 교사의 감정 데이터 접근은 403 (실제=${r.status})`);
  const p = JSON.parse(r.body);
  assert.equal(p.success, false, '차단 응답은 success:false');
  assert.equal(typeof p.message, 'string', '한국어 message 포함');
});

// ──────────────────────────────────────────────────────────────────────────
// U6: principal — 자기 school_name 학교 학생만. (middleware/auth requireSchoolScope 의
//     "users.school_name 정확 일치" 스코프와 정합. 타 학교/학교없음 → 403.)
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U6: principal → 자기 학교 학생 200 · 학교 불일치 403', async () => {
  const P = uidOf('principal1');
  const pSchool = db.prepare('SELECT school_name s FROM users WHERE id = ?').get(P).s;
  const tSchool = db.prepare('SELECT school_name s FROM users WHERE id = ?').get(S_TARGET).s;
  assert.ok(pSchool, '전제: principal1 은 school_name 을 가진다');
  assert.notEqual(String(tSchool || ''), String(pSchool), '전제: S_TARGET 은 교장의 학교 소속이 아니다');

  // 자기 학교 학생(student1 = 금성초등학교) → 200
  const sameSchool = db.prepare(
    "SELECT id FROM users WHERE role='student' AND school_name = ? LIMIT 1"
  ).get(pSchool);
  assert.ok(sameSchool, '전제: 교장 학교 소속 학생이 최소 1명');
  const ok = await get(`/api/lrs/insights/${sameSchool.id}`, P);
  assert.equal(ok.status, 200, `교장은 자기 학교 학생을 볼 수 있어야 (실제=${ok.status})`);

  // 학교 불일치 학생 → 전수 403
  const leaks = [];
  for (const ep of endpointsFor(S_TARGET)) {
    const r = await get(ep.path, P);
    if (r.status !== 403) leaks.push(`${ep.label} → ${r.status}`);
  }
  assert.deepEqual(leaks, [], `교장이 타 학교 학생을 열람: ${leaks.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// U7: parent — canViewUser 가 parent 를 거부해도 /parent/:childId/digest 의
//     parent_id 관계 검증 경로는 살아 있어야 한다(정상 동선 회귀 방지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-SEC-U7: 학부모 → 자기 자녀 digest 200 · 남의 자녀 403', async () => {
  const rel = db.prepare('SELECT id, parent_id FROM users WHERE parent_id IS NOT NULL LIMIT 1').get();
  assert.ok(rel, '전제: parent_id 관계를 가진 학생이 최소 1명');
  const mine = await get(`/api/lrs/parent/${rel.id}/digest`, rel.parent_id);
  assert.equal(mine.status, 200, `자기 자녀 digest 는 200 (실제=${mine.status})`);
  const other = db.prepare(
    "SELECT id FROM users WHERE role='student' AND (parent_id IS NULL OR parent_id <> ?) LIMIT 1"
  ).get(rel.parent_id);
  assert.ok(other, '전제: 남의 자녀(비관계 학생)가 존재');
  const r = await get(`/api/lrs/parent/${other.id}/digest`, rel.parent_id);
  assert.equal(r.status, 403, `남의 자녀 digest 는 403 (실제=${r.status})`);
});
