// test/class-invite-code-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0-7] 클래스 초대코드 유출 + 관리 화면 전면 진입 차단, [W2-T6-7] 강퇴 후 재가입 복구.
//
// ■ 무엇이 터졌나 (2026-08-05 실서버 실측 재현)
//   student1(일반 멤버)로 GET /api/class/2 →
//     200 | myRole=member | is_public=1 | code=UE9LT9  ← 초대코드가 그대로 내려왔다.
//   초대코드는 **비공개 클래스의 유일한 접근 통제 수단**이다
//   (POST /api/class/join 은 is_public 을 보지 않는다 — "비공개 = 코드로만 가입"이 설계).
//   그 코드가 학급의 모든 학생 화면(클래스 설정·클래스 홈 헤더·나의 클래스 카드)에
//   렌더되고 있었으므로, 학생 한 명이 외부에 뿌리면 임의의 제3자가 학급 게시판·감정·
//   성적 화면까지 들어온다.
//
// ■ 세 겹이었다
//   ① API      : GET /api/class/:id 가 myRole 과 무관하게 classes 행 전체(code 포함) 반환
//   ② 화면     : public/class/manage.html 이 200 여부만 보고 관리 UI(코드·삭제)를 렌더
//   ③ GNB      : common-nav.js '클래스 관리' 에 roles 제한 없음 → 학생 메뉴에 노출
//   이 파일은 ①(+ 목록 계열 전 엔드포인트)을 박제한다. ②③ 은 스모크(E2E)에서 잡는다.
//
// ■ 판정 사본 금지
//   "클래스를 관리할 수 있는가" 의 정본은 lib/auth/can-view-user.js 의 canManageClass 뿐이다.
//   라우트도 FE 도 그 판정을 다시 쓰지 않는다(FE 는 응답의 canManage 플래그를 그대로 쓴다).
//
// ■ 과잉 차단 방지도 함께 박제한다 — owner/admin 은 코드가 보이고 관리 API 가 전부 살아 있어야 한다.
//
// DB 격리: 실 DB → 임시 복사본(실 DB 무오염). 세션은 MemoryStore + x-test-user 주입.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입

const express = require('express');
const session = require('express-session');

let server, baseUrl, tdb;
let ADMIN, TEACHER, STUDENT, STUDENT2;
let ownedClassId, ownedClassCode;   // teacher1 이 테스트용으로 새로 만든 클래스

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/class', require('../routes/class'));
  return app;
}

function req(method, path, { user, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (user) headers['x-test-user'] = String(user);
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const uid = (username) => {
  const row = tdb.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!row) throw new Error(`테스트 전제 붕괴: ${username} 계정이 실 DB 에 없습니다.`);
  return row.id;
};

before(async () => {
  tdb = openTestDb();
  ADMIN = uid('admin'); TEACHER = uid('teacher1'); STUDENT = uid('student1'); STUDENT2 = uid('student2');

  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // 테스트 전용 클래스 (비공개) 생성 — 정본 클래스를 건드리지 않는다.
  const created = await req('POST', '/api/class', {
    user: TEACHER,
    body: { name: 'P0-7 코드유출 검증반', description: '테스트', is_public: 0, class_type: '기타' }
  });
  assert.equal(created.status, 201, '전제: teacher1 이 클래스를 만들 수 있어야 한다');
  ownedClassId = created.body.class.id;
  ownedClassCode = tdb.prepare('SELECT code FROM classes WHERE id = ?').get(ownedClassId).code;
  assert.ok(ownedClassCode, '전제: 생성된 클래스에 초대코드가 있어야 한다');

  // student1 을 일반 멤버로 가입시킨다(코드 가입 경로 그대로).
  const joined = await req('POST', '/api/class/join', { user: STUDENT, body: { code: ownedClassCode } });
  assert.equal(joined.status, 200, '전제: 코드로 가입이 되어야 한다');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { tdb && tdb.close(); } catch (_) {}
});

// ═══════════════════════════════════════════════════════════════════════════
// [INV-P07-1] 상세 API — 비-owner 멤버에게 초대코드를 주지 않는다
// ═══════════════════════════════════════════════════════════════════════════
test('INV-P07-1: GET /api/class/:id — 일반 멤버 응답에 class.code 부재 + canManage=false', async () => {
  const r = await req('GET', `/api/class/${ownedClassId}`, { user: STUDENT });
  assert.equal(r.status, 200, '멤버는 클래스 상세를 볼 수 있어야 한다(과잉 차단 금지)');
  assert.equal(r.body.myRole, 'member');
  assert.equal(
    r.body.class.code, undefined,
    `일반 멤버 응답에 초대코드가 노출됐다(code=${r.body.class.code}). ` +
    '비공개 클래스의 유일한 접근 통제 수단이 학생에게 새고 있다.'
  );
  assert.equal(r.body.canManage, false, 'FE 가 관리 UI 게이트에 쓸 canManage 플래그가 없거나 잘못됐다');
  // 코드 문자열이 응답 본문 어디에도 없어야 한다(다른 필드로 새는 것까지 차단)
  assert.ok(!r.raw.includes(ownedClassCode), '응답 본문 어딘가에 초대코드 문자열이 남아 있다');
});

test('INV-P07-1b: 비멤버 학생은 여전히 403 (기존 차단 유지)', async () => {
  const r = await req('GET', `/api/class/${ownedClassId}`, { user: STUDENT2 });
  assert.equal(r.status, 403);
});

// ═══════════════════════════════════════════════════════════════════════════
// [INV-P07-2] 목록 계열 — 나의 클래스/검색/인기 어디에서도 남의 코드가 나가지 않는다
// ═══════════════════════════════════════════════════════════════════════════
test('INV-P07-2: GET /api/class/my — 내가 owner 가 아닌 클래스의 code 부재', async () => {
  const r = await req('GET', '/api/class/my', { user: STUDENT });
  assert.equal(r.status, 200);
  const leaked = (r.body.classes || []).filter((c) => c.my_role !== 'owner' && c.code);
  assert.equal(
    leaked.length, 0,
    `나의 클래스 목록에서 비-owner 클래스 ${leaked.length}건의 초대코드가 새고 있다: ` +
    leaked.map((c) => `${c.id}:${c.code}`).join(', ')
  );
});

test('INV-P07-2b: GET /api/class/search — 남의 공개 클래스 code 부재(내가 만든 반은 예외)', async () => {
  const r = await req('GET', '/api/class/search?limit=50', { user: STUDENT });
  assert.equal(r.status, 200);
  // student1 은 실 DB 에서 class 999 의 owner 다(학생도 클래스를 개설할 수 있다).
  // 내가 개설한 반의 코드는 보여야 정상 — 과잉 차단 금지. 남의 반만 검사한다.
  const leaked = (r.body.classes || []).filter((c) => c.code && c.owner_id !== STUDENT);
  assert.equal(
    leaked.length, 0,
    `클래스 찾기에서 남의 반 초대코드 ${leaked.length}건 노출: ` + leaked.map((c) => `${c.id}:${c.code}`).join(', ')
  );
  const mine = (r.body.classes || []).filter((c) => c.owner_id === STUDENT);
  if (mine.length) assert.ok(mine.every((c) => c.code), '내가 개설한 반의 코드까지 지웠다(과잉 차단)');
});

test('INV-P07-2c: GET /api/class/popular — 비로그인 응답에 code 부재', async () => {
  const r = await req('GET', '/api/class/popular?limit=20');
  assert.equal(r.status, 200);
  const leaked = (r.body.classes || []).filter((c) => c.code);
  assert.equal(leaked.length, 0, `인기 클래스(비로그인)에서 초대코드 ${leaked.length}건 노출`);
});

test('INV-P07-2d: POST /api/class/join 응답에도 code 를 되돌려주지 않는다', async () => {
  // student2 를 가입시켜 응답을 본다(이 테스트 뒤 강퇴/재가입 테스트에서 재사용).
  const r = await req('POST', '/api/class/join', { user: STUDENT2, body: { code: ownedClassCode } });
  assert.equal(r.status, 200);
  assert.equal(r.body.class.code, undefined, 'join 응답이 초대코드를 그대로 되돌려준다');
});

// ═══════════════════════════════════════════════════════════════════════════
// [INV-P07-3] 과잉 차단 방지 — owner/admin 은 전부 그대로 동작해야 한다
// ═══════════════════════════════════════════════════════════════════════════
test('INV-P07-3: owner 는 code 를 보고 canManage=true', async () => {
  const r = await req('GET', `/api/class/${ownedClassId}`, { user: TEACHER });
  assert.equal(r.status, 200);
  assert.equal(r.body.class.code, ownedClassCode, 'owner 에게서 초대코드를 빼앗았다(과잉 차단)');
  assert.equal(r.body.canManage, true);
});

test('INV-P07-3b: admin 도 code 를 보고 canManage=true', async () => {
  const r = await req('GET', `/api/class/${ownedClassId}`, { user: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.class.code, ownedClassCode, 'admin 에게서 초대코드를 빼앗았다(과잉 차단)');
  assert.equal(r.body.canManage, true);
});

test('INV-P07-3c: owner 의 관리 API(수정·역할변경·강퇴) 가 전부 살아 있다', async () => {
  const upd = await req('PUT', `/api/class/${ownedClassId}`, {
    user: TEACHER, body: { name: 'P0-7 코드유출 검증반(수정)' }
  });
  assert.equal(upd.status, 200, 'owner 의 클래스 수정이 막혔다(과잉 차단)');
  assert.equal(upd.body.class.code, ownedClassCode, 'owner 의 수정 응답에서 코드가 사라졌다(과잉 차단)');

  const role = await req('PUT', `/api/class/${ownedClassId}/members/${STUDENT}/role`, {
    user: TEACHER, body: { role: 'owner' }
  });
  assert.equal(role.status, 200, 'owner 의 역할 변경이 막혔다(과잉 차단)');
  // 원복
  await req('PUT', `/api/class/${ownedClassId}/members/${STUDENT}/role`, { user: TEACHER, body: { role: 'member' } });

  const kick = await req('DELETE', `/api/class/${ownedClassId}/members/${STUDENT2}`, { user: TEACHER });
  assert.equal(kick.status, 200, 'owner 의 강퇴가 막혔다(과잉 차단)');
});

test('INV-P07-3d: 파괴적 API 는 여전히 비-owner 에게 403', async () => {
  const cases = [
    ['PUT', `/api/class/${ownedClassId}`, { name: '탈취' }],
    ['DELETE', `/api/class/${ownedClassId}`, undefined],
    ['DELETE', `/api/class/${ownedClassId}/members/${TEACHER}`, undefined],
    ['PUT', `/api/class/${ownedClassId}/members/${TEACHER}/role`, { role: 'member' }],
  ];
  for (const [m, p, b] of cases) {
    const r = await req(m, p, { user: STUDENT, body: b });
    assert.equal(r.status, 403, `${m} ${p} 가 학생에게 403 이 아니다(status=${r.status})`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// [INV-P07-4] W2-T6-7 — 강퇴/탈퇴 후 재가입이 영구 불가였다
//   removeMember 가 status='removed' 행을 남기는데 addMember 가 UNIQUE 충돌을
//   "이미 멤버"로 삼켜 409 를 돌려주고 있었다. 교사가 실수로 내보낸 학생은
//   DB 를 직접 손대야만 돌아올 수 있었다(복구 경로 부재).
// ═══════════════════════════════════════════════════════════════════════════
test('INV-P07-4: 강퇴 → 코드 재가입 200 이며 status 가 active 로 복구', async () => {
  // 앞 테스트(3c)에서 student2 는 이미 강퇴된 상태다. 전제 확인.
  const before = tdb.prepare('SELECT status FROM class_members WHERE class_id = ? AND user_id = ?')
    .get(ownedClassId, STUDENT2);
  assert.equal(before && before.status, 'removed', '전제: 강퇴 행이 removed 로 남아 있어야 한다');

  const r = await req('POST', '/api/class/join', { user: STUDENT2, body: { code: ownedClassCode } });
  assert.equal(r.status, 200, `강퇴된 학생의 코드 재가입이 막혀 있다(status=${r.status}, ${r.body && r.body.message})`);

  const after = tdb.prepare('SELECT status, role FROM class_members WHERE class_id = ? AND user_id = ?')
    .get(ownedClassId, STUDENT2);
  assert.equal(after.status, 'active', '재가입했는데 class_members.status 가 active 로 복구되지 않았다');
  assert.equal(after.role, 'member');
});

test('INV-P07-4b: 강퇴 → 교사가 아이디로 다시 추가 200', async () => {
  const kick = await req('DELETE', `/api/class/${ownedClassId}/members/${STUDENT2}`, { user: TEACHER });
  assert.equal(kick.status, 200);

  const add = await req('POST', `/api/class/${ownedClassId}/members`, {
    user: TEACHER, body: { username: 'student2' }
  });
  assert.equal(add.status, 200, `교사의 멤버 재추가가 막혀 있다(status=${add.status}, ${add.body && add.body.message})`);
  const row = tdb.prepare('SELECT status FROM class_members WHERE class_id = ? AND user_id = ?')
    .get(ownedClassId, STUDENT2);
  assert.equal(row.status, 'active');
});

test('INV-P07-4c: 이미 active 인 멤버의 중복 가입은 여전히 409', async () => {
  const r = await req('POST', '/api/class/join', { user: STUDENT2, body: { code: ownedClassCode } });
  assert.equal(r.status, 409, '중복 가입까지 200 으로 열어버렸다(재가입 복구가 과하게 넓다)');
});

test('INV-P07-4d: 재가입 후 member_count 가 실제 active 멤버 수와 일치', async () => {
  const real = tdb.prepare("SELECT COUNT(*) n FROM class_members WHERE class_id = ? AND status='active'")
    .get(ownedClassId).n;
  const stored = tdb.prepare('SELECT member_count FROM classes WHERE id = ?').get(ownedClassId).member_count;
  assert.equal(stored, real, `member_count(${stored}) 가 실제 active 멤버 수(${real})와 어긋난다`);
});
