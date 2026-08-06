// test/self-learn-daily-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0-6] "오늘의 학습" 세트 API 권한 전면 개방 + [W2-T4-3/4/5/9] 관리·노출 결함.
//
// 결함(2026-08-05 실측, 격리 서버 3241 / student1(uid3, 4학년) 세션 — 전부 200 + DB 반영):
//   ① POST   /api/self-learn/daily/sets            → 학생이 teacher_id=3 인 세트를 임의 학년으로 생성
//   ② PUT    /api/self-learn/daily/sets/1847       → 교사(uid1) 세트 제목이 "학생이 제목 바꿈"으로 변경
//   ③ DELETE /api/self-learn/daily/sets/1847/items/6492 → 교사 세트 항목 삭제 시도(FK 위반으로 500까지)
//   ④ POST   /api/self-learn/daily/6376/complete   → 3학년 세트 항목을 4학년 학생이 이수 + 포인트 적립
//   ⑤ DELETE /api/self-learn/daily/sets/1847       → 404 (관리자 화면의 "삭제" 버튼이 부르는 라우트 부재)
//   4개 라우트가 전부 requireAuth 뿐이었고 completeDailyItem 에 대상 자격 검사가 없었다.
//
// 정책 — 새로 발명하지 않고 routes/class-mileage.js 의 requireClassMember/requireOwner 계층을 따른다.
//   requireSetManager(admin) → requireSetOwner(존재확인·관리자 방어) → requireDailyItemTarget(배포 대상)
//
// [2026-08-06 관리자 전용화 — 사용자 지시] 세트 구성·배포 쓰기 권한을 teacher·admin → **admin 단독**으로.
//   근거: 교사에겐 진입 UI 가 애초에 없었다(common-nav.js "학습 배포 관리" roles:['admin'],
//   관리 화면은 /admin/daily-learning.html 뿐) → 화면 없는 API 전용 능력이었다.
//   ⚠ 과차단이 이 변경의 최대 위험이다. 아래 INV-SLD12 가 "원래 되던 것"을 지킨다.
//
// 불변식:
//   INV-SLD1  학생 세션 — 세트 생성/수정/삭제/항목추가/항목삭제 전수 403 + DB 무변화
//   INV-SLD2  admin 만 200. 교사는 **본인이 만든 세트여도** 쓰기 전수 403
//   INV-SLD11 교사 세션 — 세트 생성/수정/삭제/항목동기화 전수 403 + DB 무변화 (관리자 전용화)
//   INV-SLD12 과차단 없음 — 교사 소유 기존 세트를 학생이 여전히 조회·시작·이수하고,
//             관리자가 그 세트를 계속 관리할 수 있다 (권한 축소는 앞으로의 쓰기만 막는다)
//   INV-SLD13 문구 — today.html 빈 상태가 학생에게 "학습목록 추가"를 권하지 않는다
//   INV-SLD3  DELETE /daily/sets/:id 라우트가 존재(404 아님)하고 실제로 세트·항목·진행행을 정리
//   INV-SLD4  타학년 / 배포중지 세트 항목 이수는 403 + 진행행 미생성
//   INV-SLD5  is_active=0 세트는 getDailySets 기본 결과·학생 GET /daily 에 미포함, 관리 화면엔 포함
//   INV-SLD6  updateDailySet 은 is_active 를 boolean 으로 받아도 예외 없이 반영 (better-sqlite3 바인딩 500)
//   INV-SLD7  진단 v3 finish 후 대상 노드 user_node_status.diagnosis_result 가 NOT NULL
// DB 격리: 실 DB → 임시 복사본(무오염). 쓰기는 전부 복사본에만.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입
const express = require('express');
const session = require('express-session');
const db = openTestDb();
const sl = require('../db/self-learn-extended');

let server, baseUrl;

function uidOf(username) {
  const r = db.prepare('SELECT id, grade, role FROM users WHERE username = ?').get(username);
  assert.ok(r, `테스트 계정 ${username} 이 DB 에 있어야 한다`);
  return r;
}
const STU = uidOf('student1');    // 금성초 4학년 학생
const T1 = uidOf('teacher1');     // 세트 다수의 소유 교사
const TFOE = uidOf('mteacher1');  // 타 학교 교사 — 남의 세트에 대해 비소유
const ADMIN = uidOf('admin');

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
  app.use((req, res) => res.status(404).json({ success: false, message: '요청하신 API를 찾을 수 없습니다.' }));
  return app;
}

function call(method, path, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(baseUrl + path, { method, headers }, (res) => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  server = buildApp().listen(0);
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server && server.close(); } catch (_) {} });

// ── 픽스처: 교사(T1) 소유 세트 + 항목 ────────────────────────────────────────
function makeSet({ teacherId = T1.id, grade = STU.grade, active = 1, title = '[테스트] 세트' } = {}) {
  const info = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, target_subject, is_active, difficulty)
    VALUES (NULL, ?, ?, DATE('now'), ?, '수학', ?, '보통')
  `).run(teacherId, title, grade, active);
  const setId = info.lastInsertRowid;
  const itemId = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, item_title, sort_order, estimated_minutes, point_value)
    VALUES (?, 'content', '[테스트] 항목', 1, 10, 10)
  `).run(setId).lastInsertRowid;
  return { setId, itemId };
}
const titleOf = (id) => (db.prepare('SELECT title FROM daily_learning_sets WHERE id = ?').get(id) || {}).title;
const setExists = (id) => !!db.prepare('SELECT 1 FROM daily_learning_sets WHERE id = ?').get(id);
const itemExists = (id) => !!db.prepare('SELECT 1 FROM daily_learning_items WHERE id = ?').get(id);
const progressOf = (uid, itemId) => db.prepare('SELECT * FROM daily_learning_progress WHERE user_id=? AND item_id=?').get(uid, itemId);

// ── INV-SLD1: 학생 전수 차단 ────────────────────────────────────────────────
test('INV-SLD1 학생 세션 — 세트 관리 API 전수 403 + DB 무변화', async () => {
  const { setId, itemId } = makeSet({ title: '[테스트] 교사 세트' });
  const before = db.prepare('SELECT COUNT(*) n FROM daily_learning_sets').get().n;

  const create = await call('POST', '/api/self-learn/daily/sets', STU.id,
    { title: '학생이 만든 세트', target_grade: 6, target_date: '2026-08-05' });
  assert.equal(create.status, 403, '학생은 학습 세트를 만들 수 없어야 한다');
  assert.equal(create.body.success, false);
  assert.ok(create.body.message && /[가-힣]/.test(create.body.message), '한국어 안내 메시지');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_learning_sets').get().n, before, '세트가 생성되면 안 된다');

  const upd = await call('PUT', `/api/self-learn/daily/sets/${setId}`, STU.id, { title: '학생이 제목 바꿈' });
  assert.equal(upd.status, 403);
  assert.equal(titleOf(setId), '[테스트] 교사 세트', '제목이 바뀌면 안 된다');

  const addItem = await call('POST', `/api/self-learn/daily/sets/${setId}/items`, STU.id,
    { source_type: 'content', item_title: '학생이 넣은 항목' });
  assert.equal(addItem.status, 403);

  const delItem = await call('DELETE', `/api/self-learn/daily/sets/${setId}/items/${itemId}`, STU.id);
  assert.equal(delItem.status, 403);
  assert.ok(itemExists(itemId), '항목이 삭제되면 안 된다');

  const delSet = await call('DELETE', `/api/self-learn/daily/sets/${setId}`, STU.id);
  assert.equal(delSet.status, 403);
  assert.ok(setExists(setId), '세트가 삭제되면 안 된다');
});

// ── INV-SLD2: 관리자만 통과 + 교사(소유·비소유 모두) 차단 ───────────────────
test('INV-SLD2 admin 은 통과, 교사는 본인 세트여도 403', async () => {
  const { setId, itemId } = makeSet({ title: '[테스트] 소유권' });   // teacher_id = T1

  const foe = await call('PUT', `/api/self-learn/daily/sets/${setId}`, TFOE.id, { title: '남의 교사가 바꿈' });
  assert.equal(foe.status, 403, '자기가 만들지 않은 세트는 교사여도 수정 불가');
  assert.equal(titleOf(setId), '[테스트] 소유권');

  // [2026-08-06] 예전에는 200 이었다. 오늘의 학습 구성·배포는 관리자 전용이다.
  const own = await call('PUT', `/api/self-learn/daily/sets/${setId}`, T1.id, { title: '[테스트] 소유교사 수정' });
  assert.equal(own.status, 403, '소유 교사여도 세트를 수정할 수 없어야 한다(관리자 전용)');
  assert.equal(titleOf(setId), '[테스트] 소유권', '교사 요청으로 제목이 바뀌면 안 된다');

  const byAdmin = await call('PUT', `/api/self-learn/daily/sets/${setId}`, ADMIN.id, { title: '[테스트] 관리자 수정' });
  assert.equal(byAdmin.status, 200, 'admin 은 전체 관리 권한');
  assert.equal(titleOf(setId), '[테스트] 관리자 수정');

  const add = await call('POST', `/api/self-learn/daily/sets/${setId}/items`, ADMIN.id,
    { source_type: 'content', item_title: '[테스트] 관리자 추가 항목' });
  assert.equal(add.status, 200);

  const rm = await call('DELETE', `/api/self-learn/daily/sets/${setId}/items/${itemId}`, ADMIN.id);
  assert.equal(rm.status, 200);
  assert.equal(itemExists(itemId), false);

  // 다른 세트의 항목을 이 세트 경로로 지우려는 교차 삭제 차단
  const other = makeSet({ title: '[테스트] 다른 세트' });
  const cross = await call('DELETE', `/api/self-learn/daily/sets/${setId}/items/${other.itemId}`, ADMIN.id);
  assert.equal(cross.status, 404, '경로의 세트에 속하지 않는 항목은 지울 수 없어야 한다');
  assert.ok(itemExists(other.itemId));
});

// ── INV-SLD11: 교사 전수 차단 (관리자 전용화) ───────────────────────────────
//   사용자 지시(2026-08-06): "오늘의 학습은 관리자가 관리페이지에서 구성·배포해야 나오는 것."
//   교사에겐 진입 UI 가 없었으므로 이 권한은 화면 없는 API 전용 능력이었다.
test('INV-SLD11 교사 세션 — 세트 관리 API 전수 403 + DB 무변화', async () => {
  const { setId, itemId } = makeSet({ teacherId: T1.id, title: '[테스트] 교사차단 대상' });
  const before = db.prepare('SELECT COUNT(*) n FROM daily_learning_sets').get().n;
  const koreanish = (m) => assert.ok(m && /[가-힣]/.test(m), `한국어 안내 메시지여야 한다: ${m}`);

  for (const who of [T1, TFOE]) {
    const create = await call('POST', '/api/self-learn/daily/sets', who.id,
      { title: '교사가 만든 세트', target_grade: 5, target_date: '2026-08-06' });
    assert.equal(create.status, 403, `uid${who.id}(teacher) 는 세트를 만들 수 없어야 한다`);
    koreanish(create.body && create.body.message);
    assert.match(create.body.message, /관리자/, '메시지가 실제 정책(관리자 전용)을 말해야 한다');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_learning_sets').get().n, before, '세트가 생성되면 안 된다');

    const upd = await call('PUT', `/api/self-learn/daily/sets/${setId}`, who.id, { title: '교사가 제목 바꿈' });
    assert.equal(upd.status, 403);
    assert.equal(titleOf(setId), '[테스트] 교사차단 대상', '제목이 바뀌면 안 된다');

    const addItem = await call('POST', `/api/self-learn/daily/sets/${setId}/items`, who.id,
      { source_type: 'content', item_title: '교사가 넣은 항목' });
    assert.equal(addItem.status, 403);

    const syncItems = await call('PUT', `/api/self-learn/daily/sets/${setId}/items`, who.id, { items: [] });
    assert.equal(syncItems.status, 403, '항목 동기화(전량 교체) 경로도 막혀야 한다');
    assert.ok(itemExists(itemId), '동기화로 항목이 사라지면 안 된다');

    const delItem = await call('DELETE', `/api/self-learn/daily/sets/${setId}/items/${itemId}`, who.id);
    assert.equal(delItem.status, 403);
    assert.ok(itemExists(itemId), '항목이 삭제되면 안 된다');

    const delSet = await call('DELETE', `/api/self-learn/daily/sets/${setId}`, who.id);
    assert.equal(delSet.status, 403);
    assert.ok(setExists(setId), '세트가 삭제되면 안 된다');
  }
});

// ── INV-SLD12: 과차단 방지 — 기존 교사 소유 세트의 학생 경험은 그대로 ───────
//   정본 DB 에는 teacher1 소유 세트 8건이 이미 배포돼 학생 진행 기록이 붙어 있다.
//   권한 축소는 **앞으로의 쓰기**만 막아야 하고, 이미 배포된 학습의 조회·시작·이수는 그대로여야 한다.
//   (이 작업에서 제일 위험한 실패 모드가 "원래 되던 게 안 되게 되는 것"이다.)
test('INV-SLD12 교사 소유 기존 세트 — 학생은 여전히 조회·시작·이수, 관리자는 여전히 관리', async () => {
  const { setId, itemId } = makeSet({ teacherId: T1.id, grade: STU.grade, active: 1, title: '[테스트] 기존 배포 세트' });

  // ① 목록에 뜬다 (teacher_id 는 노출 조건이 아니다)
  const list = await call('GET', '/api/self-learn/daily', STU.id);
  assert.equal(list.status, 200);
  assert.ok((list.body.sets || []).some(s => s.id === setId),
    '교사가 만든 기존 세트가 학생 목록에서 사라지면 안 된다(과차단)');

  // ② 상세가 열린다
  assert.equal((await call('GET', `/api/self-learn/daily/${setId}`, STU.id)).status, 200,
    '교사 소유 세트의 상세를 학생이 못 열면 안 된다');

  // ③ 시작·이수가 된다 + 진행행이 남는다
  assert.equal((await call('POST', `/api/self-learn/daily/${itemId}/start`, STU.id)).status, 200,
    '교사 소유 세트 항목의 학습 시작이 막히면 안 된다');
  const done = await call('POST', `/api/self-learn/daily/${itemId}/complete`, STU.id, { score: 90 });
  assert.equal(done.status, 200, `교사 소유 세트 항목의 이수가 막히면 안 된다: ${done.raw}`);
  const prog = progressOf(STU.id, itemId);
  assert.ok(prog && prog.status === 'completed', '이수 기록이 남아야 한다');

  // ④ 관리자는 남의(교사) 세트를 계속 관리할 수 있다 — teacher_id 로 admin 을 막으면 8건이 고아가 된다
  const byAdmin = await call('PUT', `/api/self-learn/daily/sets/${setId}`, ADMIN.id, { title: '[테스트] 관리자가 인계' });
  assert.equal(byAdmin.status, 200, '관리자가 교사 소유 세트를 수정하지 못하면 기존 8건이 관리 불능이 된다');
  assert.equal(titleOf(setId), '[테스트] 관리자가 인계');

  // ⑤ 관리자 수정 후에도 학생 이수 기록이 살아 있다
  assert.ok(progressOf(STU.id, itemId), '관리자 수정이 학생 이수 기록을 지우면 안 된다');
});

// ── INV-SLD13: 학생 화면 문구 — 할 수 없는 일을 권하지 않는다 ───────────────
//   발단: today.html 빈 상태가 "학습목록 추가하러 가기"/"직접 학습을 시작할 수 있어요" 라고 말했지만
//   학생은 오늘의 학습을 스스로 채울 수 없다(requireSetManager=admin). 화면이 거짓말하지 않게 박제.
test('INV-SLD13 today.html 빈 상태 — "학습목록 추가" 유도 문구가 없다', () => {
  const p = path.join(__dirname, '..', 'public', 'self-learn', 'today.html');
  const src = fs.readFileSync(p, 'utf8');

  // 주석(정책 설명)에는 과거 문구가 인용될 수 있으므로 **렌더되는 마크업**만 본다.
  const rendered = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  assert.equal(/학습목록 추가/.test(rendered), false,
    '학생 화면이 오늘의 학습을 스스로 추가할 수 있다고 말하면 안 된다 (구성·배포는 관리자 전용)');
  assert.equal(/아래에서 직접 학습을 시작할 수 있어요/.test(rendered), false,
    '오늘의 학습을 스스로 채울 수 있다는 오해를 주는 안내 문구가 남아 있으면 안 된다');

  // 빈 상태가 "누가 올려 주는지" 를 말하고, 학생이 실제로 할 수 있는 곳으로 보내야 한다
  const i = rendered.indexOf('const headLine');
  assert.ok(i > 0, '빈 상태 렌더 코드가 있어야 한다');
  const empty = rendered.slice(i, i + 3000);
  // [2026-08-06] 문구를 통째로 고정하지 않는다.
  //   한때 `/선생님이 올려 주시면/` 을 박아 뒀는데, 구성·배포는 **관리자 전용**이라
  //   교사는 전 경로 403 이다 — 즉 **테스트가 사실이 아닌 문구를 지키고 있었다.**
  //   지켜야 할 것은 특정 낱말이 아니라 **"학생이 채우는 게 아니라 배정받는다"는 뜻**이다.
  assert.match(empty, /배정되면|올려 주시면|정해지면/,
    '빈 상태가 "내가 채우는 게 아니라 배정받는 것"임을 알려야 한다');
  assert.equal(/선생님이 올려/.test(empty), false,
    '교사는 오늘의 학습을 구성·배포할 수 없다(관리자 전용). 학생에게 사실과 다르게 안내하면 안 된다');
  assert.match(empty, /AI 맞춤학습 시작하기/, 'CTA 라벨이 도착지(learning-map.html)와 일치해야 한다');
  assert.match(empty, /learning-map\.html/, 'CTA 링크가 AI 맞춤학습으로 가야 한다');
});

// ── INV-SLD3: 삭제 라우트 존재 + 실제 정리 ──────────────────────────────────
test('INV-SLD3 DELETE /daily/sets/:id — 404 가 아니고 세트·항목·진행행을 정리', async () => {
  const { setId, itemId } = makeSet({ title: '[테스트] 삭제 대상' });
  // 진행행이 있어도 FK 위반 없이 지워져야 한다
  db.prepare(`INSERT INTO daily_learning_progress (user_id, item_id, set_id, status) VALUES (?,?,?,'completed')`)
    .run(STU.id, itemId, setId);

  const res = await call('DELETE', `/api/self-learn/daily/sets/${setId}`, ADMIN.id);
  assert.notEqual(res.status, 404, '라우트가 존재해야 한다 (관리자 화면 삭제 버튼이 부르는 경로)');
  assert.equal(res.status, 200, `삭제 실패: ${res.raw}`);
  assert.equal(setExists(setId), false);
  assert.equal(itemExists(itemId), false);
  assert.equal(progressOf(STU.id, itemId), undefined, '진행행도 함께 정리되어야 한다');
});

// ── INV-SLD4: 대상 자격 ─────────────────────────────────────────────────────
test('INV-SLD4 배포 대상이 아닌 항목 이수 차단 (타학년·배포중지) + 진행행 미생성', async () => {
  const otherGrade = (STU.grade === 3 ? 4 : 3);
  const foreign = makeSet({ grade: otherGrade, title: '[테스트] 타학년 세트' });
  const inactive = makeSet({ grade: STU.grade, active: 0, title: '[테스트] 배포중지 세트' });
  const mine = makeSet({ grade: STU.grade, title: '[테스트] 내 학년 세트' });

  for (const [label, itemId] of [['타학년', foreign.itemId], ['배포중지', inactive.itemId]]) {
    const r = await call('POST', `/api/self-learn/daily/${itemId}/complete`, STU.id, { score: 100 });
    assert.equal(r.status, 403, `${label} 항목 이수는 차단되어야 한다`);
    assert.equal(progressOf(STU.id, itemId), undefined, `${label} 항목의 진행행이 생기면 안 된다`);
    const s = await call('POST', `/api/self-learn/daily/${itemId}/start`, STU.id);
    assert.equal(s.status, 403, `${label} 항목 시작도 차단되어야 한다`);
  }

  const ok = await call('POST', `/api/self-learn/daily/${mine.itemId}/complete`, STU.id, { score: 100 });
  assert.equal(ok.status, 200, '내 학년 배포중 항목은 정상 이수되어야 한다(과차단 금지)');
  assert.ok(progressOf(STU.id, mine.itemId), '정상 이수는 진행행이 생겨야 한다');

  // 읽기(세트 상세)도 같은 자격 기준 — 타학년·배포중지 세트의 제목·항목 구성 열람 차단
  for (const [label, setId] of [['타학년', foreign.setId], ['배포중지', inactive.setId]]) {
    const r = await call('GET', `/api/self-learn/daily/${setId}`, STU.id);
    assert.equal(r.status, 403, `${label} 세트 상세는 학생이 읽을 수 없어야 한다`);
  }
  assert.equal((await call('GET', `/api/self-learn/daily/${mine.setId}`, STU.id)).status, 200,
    '내 학년 배포중 세트는 읽혀야 한다');
  assert.equal((await call('GET', `/api/self-learn/daily/${foreign.setId}`, T1.id)).status, 200,
    '교사는 점검 목적으로 읽을 수 있어야 한다(과차단 금지)');
});

// ── INV-SLD5: 배포중지 세트 노출 ────────────────────────────────────────────
test('INV-SLD5 is_active=0 세트는 학생 화면에 노출되지 않는다', async () => {
  const inactive = makeSet({ grade: STU.grade, active: 0, title: '[테스트] 미배포 세트' });

  const def = sl.getDailySets(STU.id, { grade: STU.grade });
  assert.equal(def.some(s => s.id === inactive.setId), false,
    'getDailySets 기본 호출에 배포중지 세트가 포함되면 안 된다');
  const all = sl.getDailySets(STU.id, { grade: STU.grade, includeInactive: true });
  assert.equal(all.some(s => s.id === inactive.setId), true,
    '관리 화면용 includeInactive=true 에서는 보여야 한다');

  const asStudent = await call('GET', '/api/self-learn/daily', STU.id);
  assert.equal(asStudent.status, 200);
  assert.equal((asStudent.body.sets || []).some(s => s.id === inactive.setId), false,
    '학생 GET /daily 응답에 배포중지 세트가 있으면 안 된다');
  assert.equal((asStudent.body.sets || []).every(s => Number(s.is_active) === 1), true,
    '학생 응답의 모든 세트는 배포중이어야 한다');

  const asAdmin = await call('GET', `/api/self-learn/daily?grade=${STU.grade}`, ADMIN.id);
  assert.equal((asAdmin.body.sets || []).some(s => s.id === inactive.setId), true,
    '관리자 화면은 비활성 세트도 봐야 한다(관리 대상)');
});

// ── INV-SLD6: boolean is_active 바인딩 ──────────────────────────────────────
test('INV-SLD6 updateDailySet — is_active 를 boolean 으로 줘도 500 없이 반영', async () => {
  const { setId } = makeSet({ title: '[테스트] boolean 수정', active: 1 });

  // UI(daily-learning.html) 가 실제로 보내던 형태
  const res = await call('PUT', `/api/self-learn/daily/sets/${setId}`, ADMIN.id, { title: '[테스트] boolean 수정', is_active: false });
  assert.equal(res.status, 200, `boolean is_active 로 500 이 나면 안 된다: ${res.raw}`);
  assert.equal(db.prepare('SELECT is_active FROM daily_learning_sets WHERE id=?').get(setId).is_active, 0);

  const res2 = await call('PUT', `/api/self-learn/daily/sets/${setId}`, ADMIN.id, { is_active: true });
  assert.equal(res2.status, 200);
  assert.equal(db.prepare('SELECT is_active FROM daily_learning_sets WHERE id=?').get(setId).is_active, 1);

  // 정수 형태도 그대로 동작
  assert.doesNotThrow(() => sl.updateDailySet(setId, { is_active: 0 }));
  assert.equal(db.prepare('SELECT is_active FROM daily_learning_sets WHERE id=?').get(setId).is_active, 0);
  assert.doesNotThrow(() => sl.updateDailySet(setId, { is_active: true }));
  assert.equal(db.prepare('SELECT is_active FROM daily_learning_sets WHERE id=?').get(setId).is_active, 1);
});

// ── INV-SLD8: 세트 수정이 학생 이수 기록을 지우지 않는다 (감리 B1) ──────────
//   결함(2026-08-06 감리 실측): 관리자 저장이 항목을 전량 DELETE 후 재삽입 →
//     편집 전 progress 1행 → 편집 후 0행, item_id 7186→7187 재발급.
//     learning_logs.daily_complete.target_id = itemId 라 재발급마다 로그가 고아가 된다.
//   [하네스 구멍 R11b] 이 경로에 불변식이 아예 없어, 진행행 선삭제를 되돌려도 전건 초록이었다.
test('INV-SLD8 항목 동기화 — 같은 구성으로 재저장하면 item id·학생 이수 기록이 보존된다', async () => {
  const { setId, itemId } = makeSet({ title: '[테스트] 이수기록 보존' });
  // 항목 2개 + 학생 진행행(이수 1건)
  const CID_A = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get().id;
  const CID_B = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1 OFFSET 1').get().id;
  db.prepare('UPDATE daily_learning_items SET content_id = ?, source_type = ? WHERE id = ?').run(CID_A, 'content', itemId);
  const itemB = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, content_id, item_title, sort_order, estimated_minutes, point_value)
    VALUES (?, 'content', ?, '[테스트] 항목B', 2, 10, 10)
  `).run(setId, CID_B).lastInsertRowid;
  db.prepare(`INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, completed_at)
              VALUES (?,?,?,'completed',CURRENT_TIMESTAMP)`).run(STU.id, itemId, setId);
  db.prepare(`INSERT INTO daily_learning_progress (user_id, item_id, set_id, status) VALUES (?,?,?,'in_progress')`)
    .run(STU.id, itemB, setId);
  const before = db.prepare('SELECT COUNT(*) n FROM daily_learning_progress WHERE set_id = ?').get(setId).n;
  assert.equal(before, 2, '사전 진행행 2건');

  // ① 제목만 바꾸고 같은 항목 구성으로 저장 (= 관리자 화면 "수정" 흐름)
  const same = [
    { source_type: 'content', content_id: CID_A, item_title: '[테스트] 항목A(제목변경)', sort_order: 1, estimated_minutes: 15 },
    { source_type: 'content', content_id: CID_B, item_title: '[테스트] 항목B', sort_order: 2, estimated_minutes: 10 },
  ];
  const r = await call('PUT', `/api/self-learn/daily/sets/${setId}/items`, ADMIN.id, { items: same });
  assert.equal(r.status, 200, `동기화 실패: ${r.raw}`);
  assert.deepEqual({ kept: r.body.kept, added: r.body.added, removed: r.body.removed },
    { kept: 2, added: 0, removed: 0 }, '같은 구성이면 유지만 하고 추가·삭제가 없어야 한다');

  const ids = db.prepare('SELECT id FROM daily_learning_items WHERE set_id = ? ORDER BY sort_order').all(setId).map(x => x.id);
  assert.deepEqual(ids, [itemId, itemB], '항목 id 가 재발급되면 안 된다 (learning_logs.target_id 고아화)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_learning_progress WHERE set_id = ?').get(setId).n, before,
    '세트를 수정해도 학생 이수 기록이 보존되어야 한다');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_learning_progress WHERE item_id=? AND status='completed'").get(itemId).n, 1,
    '이수(completed) 기록이 살아 있어야 한다');
  // 메타는 갱신됐는가
  const a = db.prepare('SELECT item_title, estimated_minutes FROM daily_learning_items WHERE id=?').get(itemId);
  assert.equal(a.item_title, '[테스트] 항목A(제목변경)');
  assert.equal(a.estimated_minutes, 15);

  // ② 항목 하나를 실제로 빼면 그것만 삭제되고, 남은 항목의 기록은 그대로
  const r2 = await call('PUT', `/api/self-learn/daily/sets/${setId}/items`, ADMIN.id, { items: [same[0]] });
  assert.equal(r2.status, 200);
  assert.deepEqual({ kept: r2.body.kept, added: r2.body.added, removed: r2.body.removed },
    { kept: 1, added: 0, removed: 1 });
  assert.equal(r2.body.removedProgress, 1, '제거된 항목의 진행 기록 수를 호출자에게 알려야 한다');
  assert.ok(itemExists(itemId), '남은 항목은 유지');
  assert.equal(itemExists(itemB), false, '빠진 항목만 삭제');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_learning_progress WHERE item_id=? AND status='completed'").get(itemId).n, 1,
    '남은 항목의 이수 기록은 그대로');

  // ③ preview 는 아무것도 바꾸지 않고 사라질 기록만 알려 준다
  const pv = await call('PUT', `/api/self-learn/daily/sets/${setId}/items?preview=1`, ADMIN.id, { items: [] });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.removing.length, 1);
  assert.equal(pv.body.removing[0].progress, 1);
  assert.ok(itemExists(itemId), 'preview 는 실제로 지우면 안 된다');
});

// ── INV-SLD9: 목록 == 열람 (감리 B2) ────────────────────────────────────────
//   결함: 목록은 is_active 만, 열람은 학년·클래스까지 봐서 "보이는데 열면 403" 이 됐다.
//   student8(grade IS NULL) 은 764건이 뜨고 앞 12건 상세가 전부 403 이었다.
test('INV-SLD9 GET /daily 목록에 뜬 세트는 전부 상세가 200 (보이는데 안 열리는 화면 금지)', async () => {
  // 대조군을 확실히 만든다: 타학년 · 클래스전용(비멤버) · 정상
  const otherGrade = (STU.grade === 3 ? 4 : 3);
  makeSet({ grade: otherGrade, title: '[테스트] 목록검증 타학년' });
  const foreignClass = db.prepare(`
    SELECT c.id FROM classes c
    WHERE NOT EXISTS (SELECT 1 FROM class_members m WHERE m.class_id=c.id AND m.user_id=? AND m.status='active')
    LIMIT 1`).get(STU.id);
  if (foreignClass) {
    db.prepare(`INSERT INTO daily_learning_sets (class_id, teacher_id, title, target_date, target_grade, is_active, difficulty)
                VALUES (?, ?, '[테스트] 목록검증 남의클래스', DATE('now'), NULL, 1, '보통')`).run(foreignClass.id, T1.id);
  }
  makeSet({ grade: STU.grade, title: '[테스트] 목록검증 정상' });
  // 전 학년 대상(target_grade IS NULL) — 목록에도 떠야 하고 상세도 열려야 한다(반대 방향 불일치 방지)
  const allGrades = makeSet({ grade: null, title: '[테스트] 목록검증 전학년' });

  // 학년 미설정 학생 — 소프트 삭제 계정은 requireAuth 가 401 로 막으므로 제외(실측: student7 은 deleted_at 有)
  const gradeNull = db.prepare(
    "SELECT id, grade, role, username FROM users WHERE role='student' AND grade IS NULL AND deleted_at IS NULL LIMIT 1"
  ).get();
  assert.ok(gradeNull, '학년 미설정 학생 픽스처(student8)가 있어야 한다 — 이 부류가 B2 의 최악 사례였다');

  for (const who of [STU, gradeNull].filter(Boolean)) {
    const list = await call('GET', '/api/self-learn/daily', who.id);
    assert.equal(list.status, 200);
    const sets = list.body.sets || [];
    // 전수 검사는 느리므로 상한을 둔다(결함 시 첫 건에서 바로 잡힌다)
    const sample = sets.slice(0, 25);
    for (const s of sample) {
      const d = await call('GET', `/api/self-learn/daily/${s.id}`, who.id);
      assert.equal(d.status, 200,
        `uid${who.id}(grade=${who.grade}) 목록에 뜬 세트 ${s.id} "${s.title}" 가 열리지 않는다 → ${d.status}`);
    }
    // 목록에 뜬 세트는 배포 중이어야 하고, 학년이 지정돼 있으면 내 학년이어야 한다
    for (const s of sets) {
      assert.equal(Number(s.is_active), 1, `배포중지 세트 ${s.id} 가 목록에 있으면 안 된다`);
      if (s.target_grade != null) {
        assert.equal(Number(s.target_grade), Number(who.grade),
          `uid${who.id}(grade=${who.grade}) 목록에 타학년 세트 ${s.id}(target_grade=${s.target_grade}) 가 있으면 안 된다`);
      }
    }
    if (who.grade == null) {
      // 정책: 학년 미설정 학생에게는 **학년 지정 세트를 배정하지 않는다**(전 학년 대상 세트는 받는다).
      //   감리 실측의 "764건 노출 → 앞 12건 전부 403" 이 이 조건으로 사라진다.
      assert.equal(sets.filter(s => s.target_grade != null).length, 0,
        '학년 미설정 학생 목록에 학년 지정 세트가 있으면 안 된다(보이는데 열면 403 이 된다)');
      // 실 데이터에는 전 학년 대상 세트가 없어 목록이 비므로, 그때는 이유를 고지해야 한다
      if (sets.length === 0) {
        assert.ok(list.body.notice && /학년/.test(list.body.notice),
          '빈 이유를 화면이 말할 수 있도록 notice 를 내려야 한다');
      }
    }
  }

  // 전 학년 대상 세트는 목록·상세 양쪽에 있어야 한다 (열리는데 안 보이는 반대 방향 불일치 금지)
  const l1 = await call('GET', '/api/self-learn/daily', STU.id);
  assert.ok((l1.body.sets || []).some(s => s.id === allGrades.setId),
    'target_grade IS NULL(전 학년 대상) 세트가 목록에서 누락되면 안 된다');
  assert.equal((await call('GET', `/api/self-learn/daily/${allGrades.setId}`, STU.id)).status, 200);
  assert.ok((await call('GET', '/api/self-learn/daily', gradeNull.id)).body.sets.some(s => s.id === allGrades.setId),
    '학년 미설정 학생도 전 학년 대상 세트는 받아야 한다');

  // 클래스 전용 세트는 비멤버 목록에 없어야 한다
  const list1 = await call('GET', '/api/self-learn/daily', STU.id);
  const classOnly = (list1.body.sets || []).filter(s => s.class_id != null);
  for (const s of classOnly) {
    const member = db.prepare("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'").get(s.class_id, STU.id);
    assert.ok(member, `비멤버에게 클래스 전용 세트 ${s.id}(class ${s.class_id}) 가 노출되면 안 된다`);
  }
});

// ── INV-SLD10: 관리자 저장 흐름 소스 계약 ───────────────────────────────────
test('INV-SLD10 daily-learning.html — 저장이 항목 전량 DELETE 후 재삽입을 하지 않는다', () => {
  const p = path.join(__dirname, '..', 'public', 'admin', 'daily-learning.html');
  const src = fs.readFileSync(p, 'utf8');
  const i = src.indexOf('async function saveSet');
  assert.ok(i > 0, 'saveSet 이 있어야 한다');
  const body = src.slice(i, i + 6000);

  assert.ok(!/for\s*\(\s*const\s+it\s+of\s*\(cur\.items[\s\S]{0,200}method:\s*'DELETE'/.test(body),
    '기존 항목을 순회 DELETE 하는 전량 교체 코드가 남아 있으면 안 된다 (학생 이수 기록 소실)');
  assert.ok(/\/items['"]?\s*,\s*\{[\s\S]{0,120}method:\s*'PUT'/.test(body) || /method:\s*'PUT'[\s\S]{0,200}\/items/.test(body),
    '항목 저장은 동기화(PUT .../items) 로 해야 한다');
  assert.ok(/preview=1/.test(body),
    '항목 제거 시 사라질 학생 기록을 미리 확인해야 한다');
});

// ── INV-SLD7: 진단 v3 결과 → 노드 상태 ──────────────────────────────────────
//   화면이 쓰는 진단은 v3(DB 100세션 중 89건). 결과 기록 코드가 v2 에만 있어
//   user_node_status.diagnosis_result 가 13행 중 10행 NULL 이었다.
//   ※ status 는 의도적으로 갱신하지 않는다(2026-06-05 진단↔학습 분리 정책).
test('INV-SLD7 finishDiagnosisV3 — 응시 노드의 diagnosis_result 가 기록된다', () => {
  const nodes = db.prepare(
    "SELECT node_id FROM learning_map_nodes WHERE node_level = 3 ORDER BY node_id LIMIT 2"
  ).all().map(r => r.node_id);
  assert.equal(nodes.length, 2, '학습맵 차시 노드 픽스처가 있어야 한다');
  const unit = db.prepare("SELECT node_id FROM learning_map_nodes WHERE node_level = 2 LIMIT 1").get().node_id;
  const anyContent = db.prepare('SELECT id FROM contents ORDER BY id LIMIT 1').get().id;

  const st = { v3: true, unit: { nodeId: unit }, conceptOrder: nodes, visitedConcepts: nodes,
               passedConcepts: [nodes[0]], skippedConcepts: [], completedUnits: [], diagnosedConcepts: 2 };
  const sid = db.prepare(`
    INSERT INTO diagnosis_sessions (user_id, target_node_id, status, total_questions, correct_count, difficulty_path, diagnosis_type)
    VALUES (?, ?, 'in_progress', 4, 3, ?, 'v3')
  `).run(STU.id, unit, JSON.stringify(st)).lastInsertRowid;

  const insA = db.prepare(
    'INSERT INTO diagnosis_answers (session_id, node_id, content_id, user_answer, is_correct) VALUES (?,?,?,?,?)'
  );
  insA.run(sid, nodes[0], anyContent, '0', 1); insA.run(sid, nodes[0], anyContent, '0', 1);
  insA.run(sid, nodes[1], anyContent, '1', 0); insA.run(sid, nodes[1], anyContent, '1', 1);

  // 사전 상태: 이 노드들의 diagnosis_result 를 비워 둔다
  for (const n of [...nodes, unit]) {
    db.prepare('UPDATE user_node_status SET diagnosis_result = NULL WHERE user_id=? AND node_id=?').run(STU.id, n);
  }

  sl.finishDiagnosisV3(sid);

  for (const n of [...nodes, unit]) {
    const row = db.prepare('SELECT status, diagnosis_result, correct_rate FROM user_node_status WHERE user_id=? AND node_id=?')
      .get(STU.id, n);
    assert.ok(row, `노드 ${n} 의 user_node_status 행이 생겨야 한다`);
    assert.ok(row.diagnosis_result != null,
      `노드 ${n} 의 diagnosis_result 가 기록되어야 한다 (v3 진단 결과가 노드에 반영되지 않던 결함)`);
    assert.ok(['mastered', 'proficient', 'developing', 'needs_review'].includes(row.diagnosis_result),
      `diagnosis_result enum 이 v2 와 같아야 한다: ${row.diagnosis_result}`);
  }
  // 통과 개념(정답률 1.0) 은 mastered, 절반 맞춘 개념(0.5)은 developing
  assert.equal(db.prepare('SELECT diagnosis_result d FROM user_node_status WHERE user_id=? AND node_id=?')
    .get(STU.id, nodes[0]).d, 'mastered');
  assert.equal(db.prepare('SELECT diagnosis_result d FROM user_node_status WHERE user_id=? AND node_id=?')
    .get(STU.id, nodes[1]).d, 'developing');
});
