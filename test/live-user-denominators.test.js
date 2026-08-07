// test/live-user-denominators.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [멤버 전원 규약] "살아있는 계정" 분모 회귀 박제 — 2026-08-07.
//
// ── 배경: 이 플랫폼에는 분모 규약이 **두 벌** 있고, 그것이 정상이다 ──────────
//   ⓐ 학생 모집단(과제·평가·설문·성장·오늘의학습·LRS 42곳)
//        = db/class.js studentPopulationSql() — cm.role='member' + u.role='student'
//   ⓑ 멤버 전원(마일리지·알림장·게시판 활동·admin 클래스 목록)  ← 이 파일의 대상
//        = 학부모(parent)·교직원(staff)·개설자(teacher)도 "클래스 멤버"이므로 그대로 센다.
//   사용자 결정(2026-08-07): "삭제 계정이 섞여 세는 것은 문제이지만,
//   학부모·교직원도 클래스 멤버라면 같이 세는 게 맞다."
//   → ⓑ 를 ⓐ 로 '정합화'하는 것은 **고치는 게 아니라 망가뜨리는 것**이다.
//
// ── 잡는 결함 (수정 전 실측, data/dacheum.db 2026-08-07 스냅샷) ──────────────
//   ① db/class-mileage.js getRanking()       class 1 주간 랭킹 10명
//        → 삭제 계정 한서윤(student7, id 13, users.status='deleted') 포함. 9명이 정답.
//        (period='all' 분기도 같은 결함 — 해당 계정에 class_mileage 행이 없어 눈에만 안 띄었다)
//   ② db/class-mileage.js getMembersMileage() class 1/2/4 = 11/7/8 → 10/7/8
//        교사 마일리지 운영 화면 명단에 삭제 계정 실명이 그대로 떴다.
//   ③ db/notice.js getReadAndUnreadMembers()  class 1/2/4 분모 10/6/7 → 9/6/7
//        읽음률 분모에 로그인 불가 계정이 남아 "영원한 미확인 1명"을 만들었다.
//   ④ routes/class.js 게시판 활동 랭킹 모집단 class 1/2/4 = 11/7/8 → 10/7/8
//   ⑤ routes/admin.js /api/admin/classes member_count
//        cm.status 를 아예 보지 않아 강퇴(removed)·초대중(invited)까지 셌다.
//        class 1/2/4 = 11/8/8 → 10/7/8. (어느 규약으로도 오답)
//        상세 명단인 classDb.getClassMembers() 는 이미 삭제 계정을 빼므로
//        삭제 계정을 안 빼면 "카드(11) ≠ 내역(10)" 이 된다 → live 조건도 함께 적용.
//
// 정본: 술어는 db/class.js liveUserSql() 한 벌뿐이다. 손으로 다시 적지 말 것
//       (이 프로젝트의 반복 결함 = "정본 옆의 판정 사본").
//
// ★ 역주입 증명 (2026-08-07 실행):
//   · class-mileage/notice/class.js 에서 liveUserSql 절을 제거 → INV-LU1 붉음
//   · routes/admin.js member_count 를 옛 `(SELECT COUNT(*) FROM class_members
//     WHERE class_id = c.id)` 로 되돌림 → INV-LU3 붉음
//   · 반대로 studentPopulationSql 로 '정합화'해 학부모·교직원을 빼면 → INV-LU2 붉음
//
// DB 격리: 실 DB → 임시 사본(_setup). 전용 시드로 결정적. 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ 라우터/ db 모듈 require "전에" DB_PATH 주입

const express = require('express');
const session = require('express-session');
const classDb   = require('../db/class');
const mileageDb = require('../db/class-mileage');
const noticeDb  = require('../db/notice');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');
const ADMIN = 1;                      // 실 DB 실측: admin=id1
let _seq = 0;
const uniq = () => `${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function insUser(role, name, extra = {}) {
  const id = Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, ?)"
  ).run(`lu_${role}_${uniq()}`, name, role).lastInsertRowid);
  if (extra.deleted) {
    db.prepare("UPDATE users SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }
  return id;
}

// ── 시드: 라이브 class 1 구성 재현 ──────────────────────────────────────────
//   개설자(teacher) + 학생 3 + 학부모 1 + 교직원 1 + 삭제계정 학생 1(한서윤)
//   + 강퇴(removed) 학생 1 + 초대중(invited) 학생 1
//   → class_members 행 = 8 · status='active' 행 = 7 · 살아있는 active 멤버 = 6(정답)
const F = (() => {
  const owner   = insUser('teacher', '락김선생');
  const s1      = insUser('student', '락이학생');
  const s2      = insUser('student', '락박학생');
  const s3      = insUser('student', '락최학생');
  const parent  = insUser('parent',  '락이학부모');                 // ★ 남아야 한다
  const staff   = insUser('staff',   '락정교직원');                 // ★ 남아야 한다
  const gone    = insUser('student', '락한서윤', { deleted: true }); // ★ 빠져야 한다
  const removed = insUser('student', '락강다은');                   // cm.status='removed'
  const invited = insUser('student', '락정민재');                   // cm.status='invited'

  const classId = Number(db.prepare(
    "INSERT INTO classes (name, owner_id, code) VALUES ('살아있는분모반', ?, ?)"
  ).run(owner, `LU_${uniq()}`.toUpperCase().slice(0, 16)).lastInsertRowid);

  const addM = db.prepare(
    'INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, ?, ?)'
  );
  addM.run(classId, owner,   'owner',  'active');
  for (const u of [s1, s2, s3, parent, staff, gone]) addM.run(classId, u, 'member', 'active');
  addM.run(classId, removed, 'member', 'removed');
  addM.run(classId, invited, 'member', 'invited');

  // 마일리지 잔액 — active 멤버 전원(개설자 제외 대상 포함) + 삭제 계정에도 부여.
  //   삭제 계정에 잔액을 주지 않으면 period='all' 분기의 결함이 시야에서 사라진다.
  const insBal = db.prepare(
    'INSERT INTO class_mileage (class_id, user_id, balance, total_earned) VALUES (?, ?, ?, ?)'
  );
  const insLog = db.prepare(
    "INSERT INTO class_mileage_log (class_id, user_id, delta, reason) VALUES (?, ?, ?, 'test')"
  );
  for (const u of [owner, s1, s2, s3, parent, staff, gone, removed, invited]) {
    insBal.run(classId, u, 50, 50);
    insLog.run(classId, u, 50);       // created_at = now → week/month 창 안
  }

  // 알림장 1건 (작성자 = 개설자 → 분모에서 제외됨)
  const noticeId = Number(db.prepare(
    "INSERT INTO notices (class_id, author_id, title, content) VALUES (?, ?, '분모알림', '내용')"
  ).run(classId, owner).lastInsertRowid);

  // 게시판 활동 — 학부모·교직원·삭제계정 모두 글/댓글을 남긴다.
  //   (활동 0 인 사람은 라우트가 필터하므로, 활동을 줘야 "포함/제외"가 증명된다)
  const insPost = db.prepare(
    "INSERT INTO posts (class_id, author_id, title, content, category) VALUES (?, ?, ?, '내용', 'general')"
  );
  for (const u of [s1, parent, staff, gone]) insPost.run(classId, u, `분모글_${uniq()}`);

  return { classId, noticeId, owner, s1, s2, s3, parent, staff, gone, removed, invited };
})();

const NAME = {
  owner: '락김선생', parent: '락이학부모', staff: '락정교직원',
  gone: '락한서윤', removed: '락강다은', invited: '락정민재'
};

// ── HTTP 하네스 (routes/class.js · routes/admin.js 인라인 SQL 검증용) ────────
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
  app.use('/api/class', require('../routes/class'));
  app.use('/api/admin', require('../routes/admin'));
  return app;
}

function get(p, asUser) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const req = http.request(baseUrl + p, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { try { server && server.close(); } catch (_) {} });

// 이름 목록 헬퍼
const names = (rows) => rows.map((r) => r.display_name || r.name);

async function boardTopMembers() {
  const res = await get(`/api/class/${F.classId}/analytics/board/top-members?limit=50`, F.owner);
  assert.equal(res.status, 200, `게시판 활동 랭킹 200 이어야 한다 (실제 ${res.status}: ${res.body.slice(0, 200)})`);
  return JSON.parse(res.body).items || [];
}

async function adminMemberCount() {
  const res = await get('/api/admin/classes?limit=500', ADMIN);
  assert.equal(res.status, 200, `admin 클래스 목록 200 이어야 한다 (실제 ${res.status}: ${res.body.slice(0, 200)})`);
  const row = (JSON.parse(res.body).classes || []).find((c) => c.id === F.classId);
  assert.ok(row, '시드 클래스가 admin 목록에 있어야 한다');
  return row.member_count;
}

// ─────────────────────────────────────────────────────────────────────────────
// INV-LU1. 소프트 삭제 계정(한서윤)이 4개 지점의 분모·명단 어디에도 없다.
//   ★ 역주입: 각 지점에서 liveUserSql 절을 빼면 여기가 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-LU1 마일리지·알림장·게시판 랭킹·admin 분모에 소프트 삭제 계정이 없다', async () => {
  const gone = NAME.gone;

  for (const period of ['all', 'week', 'month']) {
    const rows = mileageDb.getRanking(F.classId, { period, limit: 100 });
    assert.ok(!names(rows).includes(gone),
      `[①] 마일리지 랭킹(${period}) 에 삭제 계정 ${gone} 이 남아 있다 — liveUserSql 누락`);
    assert.ok(!rows.some((r) => r.user_id === F.gone), `[①] 랭킹(${period}) user_id 로도 남으면 안 된다`);
  }

  const members = mileageDb.getMembersMileage(F.classId);
  assert.ok(!names(members).includes(gone),
    `[②] getMembersMileage 명단에 삭제 계정 ${gone} 실명이 노출된다`);

  const rd = noticeDb.getReadAndUnreadMembers(F.noticeId, F.classId);
  const all = [...rd.read_members, ...rd.unread_members];
  assert.ok(!names(all).includes(gone),
    `[③] 알림장 읽음/미읽음 분모에 삭제 계정 ${gone} 이 남아 "영원한 미확인" 이 된다`);

  const board = await boardTopMembers();
  assert.ok(!names(board).includes(gone),
    `[④] 게시판 활동 랭킹에 삭제 계정 ${gone} 이 노출된다`);

  // 분모 수치 — 살아있는 active 멤버 6명(개설자 포함) 기준
  assert.equal(members.length, 6, '[②] getMembersMileage = 개설자+학생3+학부모+교직원 = 6명');
  assert.equal(all.length, 5, '[③] 알림장 분모 = 6명 - 작성자(개설자) = 5명');
  assert.equal(await adminMemberCount(), 6, '[⑤] admin member_count = 살아있는 active 멤버 6명');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-LU2. 과잉 차단 방지 — 학부모·교직원·개설자는 **여전히 포함**된다.
//   사용자 결정(2026-08-07): 학부모·교직원도 클래스 멤버라면 같이 센다.
//   ★ 역주입: 이 4개 지점에 studentPopulationSql / u.role='student' 를 끼워
//     '정합화'하면 여기가 붉어진다. 그것은 고치는 게 아니라 망가뜨리는 것이다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-LU2 학부모·교직원은 멤버 전원 규약 분모에서 빠지지 않는다', async () => {
  for (const period of ['all', 'week', 'month']) {
    const n = names(mileageDb.getRanking(F.classId, { period, limit: 100 }));
    assert.ok(n.includes(NAME.parent), `[①] 마일리지 랭킹(${period}) 에 학부모가 있어야 한다`);
    assert.ok(n.includes(NAME.staff),  `[①] 마일리지 랭킹(${period}) 에 교직원이 있어야 한다`);
    // 단, 개설자(cm.role='owner')는 랭킹에서만 제외 — 기존 P1 정책 유지
    assert.ok(!n.includes(NAME.owner), `[①] 마일리지 랭킹(${period}) 은 개설자를 제외한다(기존 정책)`);
    assert.equal(n.length, 5, `[①] 랭킹(${period}) = 학생3+학부모+교직원 = 5명`);
  }

  const m = names(mileageDb.getMembersMileage(F.classId));
  assert.ok(m.includes(NAME.parent) && m.includes(NAME.staff),
    '[②] 교사 마일리지 운영 명단은 학부모·교직원을 포함한다');
  assert.ok(m.includes(NAME.owner), '[②] 교사 마일리지 운영 명단은 개설자도 포함한다');

  const rd = noticeDb.getReadAndUnreadMembers(F.noticeId, F.classId);
  const all = names([...rd.read_members, ...rd.unread_members]);
  assert.ok(all.includes(NAME.parent) && all.includes(NAME.staff),
    '[③] 알림장은 학부모·교직원에게도 도달해야 하므로 분모에 포함한다');

  const board = names(await boardTopMembers());
  assert.ok(board.includes(NAME.parent) && board.includes(NAME.staff),
    '[④] 게시판 활동 랭킹은 실제로 글을 쓴 학부모·교직원을 보여준다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-LU3. routes/admin.js member_count 가 강퇴(removed)·초대중(invited)을 세지 않는다.
//   ★ 역주입: `(SELECT COUNT(*) FROM class_members WHERE class_id = c.id)` 로 되돌리면
//     8 이 나와 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-LU3 admin 클래스 목록 member_count 가 탈퇴자·초대중을 세지 않는다', async () => {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM class_members WHERE class_id = ? GROUP BY status')
    .all(F.classId);
  const total = rows.reduce((a, r) => a + r.c, 0);
  assert.equal(total, 9, '시드 전제: class_members 행 9 (active 7 + removed 1 + invited 1)');

  const cnt = await adminMemberCount();
  assert.notEqual(cnt, 9, 'member_count 가 cm.status 를 무시하고 전체 행을 세고 있다');
  assert.equal(cnt, 6, 'member_count = active 7 - 삭제계정 1 = 6');

  // 카드(member_count) = 내역(getClassMembers) — 관리자 화면 드릴다운 정합
  assert.equal(cnt, classDb.getClassMembers(F.classId).length,
    'admin member_count 와 멤버 상세 명단 길이가 어긋나면 카드≠내역이다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-LU4. 술어 사본 금지 — 4개 지점 모두 db/class.js liveUserSql 을 경유한다.
//   손으로 `status <> 'deleted'` 를 다시 적으면 정본이 바뀌어도 따라오지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-LU4 삭제계정 술어를 손으로 복사하지 않고 liveUserSql 정본을 쓴다', () => {
  const targets = ['db/class-mileage.js', 'db/notice.js', 'routes/class.js', 'routes/admin.js'];
  for (const rel of targets) {
    const src = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim())).join('\n');
    assert.ok(/liveUserSql\s*\(/.test(code),
      `${rel} 이 liveUserSql 정본 헬퍼를 쓰지 않는다`);
    // users 소프트 삭제 술어의 손복사만 잡는다.
    //   (notice_comments.deleted_at IS NULL 같은 다른 테이블의 삭제 플래그는 무관)
    assert.ok(!/(?:<>|!=)\s*'deleted'/i.test(code),
      `${rel} 에 계정 삭제 판정 술어 사본이 있다 — db/class.js liveUserSql() 로 대체할 것`);
  }
});
