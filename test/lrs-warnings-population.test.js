// test/lrs-warnings-population.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [N-1 / N-2] "절반만 고쳐서 새 모순을 만든" 결함 부류를 박제한다.
//
// ■ 이 파일이 지키는 것 — 개별 줄이 아니라 **부류**
//   ① 한 응답 안에서 모집단이 갈리지 않는다 (INV-W1)
//      /api/lrs/warnings/:classId 는 명단을 4개(inactive · noData · consecutiveWrong ·
//      weakAchievements) 돌려준다. 이들은 **같은 반의 같은 학생 집합**을 보는 것이므로
//      한 명단에 있고 다른 명단에 없는 사람이 생기면 그건 데이터가 아니라 버그다.
//
//      결함(수정 전, 실측 2026-08-06 class 2):
//        · inactive/noData/consecutiveWrong → memberRows = studentPopulationSql (SSOT)
//        · weakAchievements                 → 손 SQL `JOIN users u2 ... u2.role='student'`
//                                             (cm.role·cm.status·계정삭제 미검사)
//        → 탈퇴 멤버 강다은(user 11, cm.status='removed')이 inactive 에는 없는데
//          weakAchievements 에는 **실명으로** 남았다. 교사는 "위험 학생" 화면에서
//          한 목록엔 있고 다른 목록엔 없는 사람을 보게 된다.
//      ⚠ 더 나쁜 2차 효과: 소표본 익명화 경로의 labelById 는 memberRows 로만 만들어져
//        모집단 밖 사람은 '학생' 폴백으로 떨어진다 = 정체불명 항목이 생긴다.
//      ⚠ HEAD(수정 전전)에는 양쪽 다 강다은을 포함해 **일관되게 틀렸다**. 절반만 고친
//        중간 상태가 오히려 더 나빴다는 점이 이 부류의 핵심이다.
//
//   ② 소스 락이 별칭 이름에 휘둘리지 않는다 (INV-W2)
//      ①이 소스 락(INV-L3)을 통과한 이유는 그 술어가 `\b(u|cu)\.role='student'` 로
//      **별칭을 열거**했기 때문이다. 실제 코드의 별칭은 `u2` 였다. 별칭은 작성자가
//      마음대로 붙이는 이름이라(u2·x·stu·s…) 열거는 원리적으로 샌다.
//      → 스캐너를 별칭 무관으로 일반화했고(test/_source-lock.js), 그 성질을 여기서 잠근다.
//
//   ③ 죽은 조건이 되살아난 채로 유지된다 (INV-N2)
//      db/learning.js createDailyAssignment 의 자동 배포 루프는
//      `class_members.role = 'student'` 로 걸렀는데 cm.role 값 도메인은 {member, owner}
//      뿐이라 **항상 0행**이었다. API 는 201 을 돌려주므로 교사에겐 "배포 완료"로 보였다
//      (조용한 무동작). 같은 결함을 routes/learning.js 에서는 먼저 고치고 여기만 남겼다.
//
// ■ 이중장부 원칙
//   모집단 술어를 db/class.js 에서 import 하지 않고 아래에 **손으로 다시 적는다**.
//   같은 SSOT 를 import 하면 SSOT 가 통째로 틀어져도 양쪽이 사이좋게 틀려 초록이 된다.
//
// ■ 역주입 (2026-08-06 실측)
//   · INV-W1  : routes/lrs.js:4194 를 옛 손 SQL 로 되돌리면
//               "weakAchievements 에 강다은(모집단 밖)" 으로 붉어진다.
//   · INV-W2  : _source-lock.js 술어를 `\b(u|cu)\.role='student'` 로 되돌리면
//               u2/x/stu 케이스가 전부 통과해 붉어진다.
//   · INV-N2  : db/learning.js 를 `role = 'student'` 손 SQL 로 되돌리면 배포 0명으로 붉어진다.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 정본 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');
const {
  scanClassScopedPopulationSource,
  scanClassScopedPopulation,
  POPULATION_SCAN_CLASSJOIN_TARGETS,
} = require('./_source-lock');

// ── 손으로 적은 장부: 학생 모집단 술어(db/class.js studentPopulationSql 의 독립 사본) ──
const POPULATION_WHERE_2ND =
  `cm.role = 'member' AND cm.status = 'active' AND u.role = 'student' ` +
  `AND COALESCE(u.status, 'active') <> 'deleted' AND u.deleted_at IS NULL`;

const CLASS_ID = 2;          // 즐거운 수학교실 — 탈퇴 멤버가 실재하는 반
const TEACHER_ID = 2;        // 김선생 (class 2 개설자 = 담임 → 실명 노출 경로)
const REMOVED_ID = 11;       // 강다은 — cm.status='removed'
const REMOVED_NAME = '강다은';

let db, server, baseUrl;

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

function get(p, userId) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + p);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: userId ? { 'x-test-user': String(userId) } : {} },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject); r.end();
  });
}

/** 손으로 적은 술어로 재유도한 정답 명단. */
function ssotStudents(classId) {
  return db.prepare(`
    SELECT cm.user_id AS user_id, u.display_name AS display_name
      FROM class_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.class_id = ? AND ${POPULATION_WHERE_2ND}
  `).all(classId);
}

before(async () => {
  db = openTestDb();

  // ── 픽스처 고정 ────────────────────────────────────────────────────────────
  // 실 DB 사본에 이미 존재하는 상황을 그대로 쓰되, 시드가 바뀌어도 이 회귀가
  // 조용히 무력화되지 않도록 "탈퇴 멤버 + 결손 성취기준" 을 보장한다(멱등).
  const u = db.prepare('SELECT id, display_name, role FROM users WHERE id = ?').get(REMOVED_ID);
  assert.ok(u, `픽스처 전제: user ${REMOVED_ID}(${REMOVED_NAME}) 가 존재해야 한다`);
  db.prepare(`UPDATE users SET role='student', status='active', deleted_at=NULL WHERE id=?`).run(REMOVED_ID);
  const cm = db.prepare('SELECT * FROM class_members WHERE class_id=? AND user_id=?').get(CLASS_ID, REMOVED_ID);
  if (cm) db.prepare(`UPDATE class_members SET role='member', status='removed' WHERE class_id=? AND user_id=?`).run(CLASS_ID, REMOVED_ID);
  else db.prepare(`INSERT INTO class_members (class_id, user_id, role, status) VALUES (?,?,'member','removed')`).run(CLASS_ID, REMOVED_ID);

  // 결손 성취기준 1건 보장 (weakAchievements 에 실제로 등장할 조건)
  const weakN = db.prepare(
    `SELECT COUNT(*) c FROM lrs_achievement_stats WHERE user_id=? AND (last_level IN ('하','미도달') OR level='not_reached')`
  ).get(REMOVED_ID).c;
  if (weakN === 0) {
    db.prepare(`INSERT INTO lrs_achievement_stats (user_id, achievement_code, avg_score, last_level, attempt_count)
                VALUES (?, '[6수01-01]', 0.2, '미도달', 5)`).run(REMOVED_ID);
  }

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ════════════════════════════════════════════════════════════════════════════
// INV-W1  /warnings/:classId 의 모든 명단이 같은 모집단을 쓴다
// ════════════════════════════════════════════════════════════════════════════
test('[INV-W1 전제] class 2 에 "모집단 밖인데 결손 성취기준이 있는" 사람이 실재한다', () => {
  const ssotIds = new Set(ssotStudents(CLASS_ID).map(s => s.user_id));
  assert.ok(!ssotIds.has(REMOVED_ID),
    `전제 확인 실패: ${REMOVED_NAME}(${REMOVED_ID})가 학생 모집단 안에 있다 — 이 회귀가 무력화된 상태`);
  const weakN = db.prepare(
    `SELECT COUNT(*) c FROM lrs_achievement_stats WHERE user_id=? AND (last_level IN ('하','미도달') OR level='not_reached')`
  ).get(REMOVED_ID).c;
  assert.ok(weakN > 0,
    `전제 확인 실패: ${REMOVED_NAME} 에게 결손 성취기준이 없다 — 옛 손 SQL 로 되돌려도 안 걸린다`);
  // 옛 손 SQL(u2.role='student' 뿐)이라면 실제로 뽑히는지 = 역주입 시 붉어짐이 보장되는지
  const oldHit = db.prepare(`
    SELECT COUNT(*) c FROM class_members cm JOIN users u2 ON u2.id = cm.user_id
     WHERE cm.class_id = ? AND u2.role = 'student' AND cm.user_id = ?
  `).get(CLASS_ID, REMOVED_ID).c;
  assert.equal(oldHit, 1,
    '전제 확인 실패: 옛 손 SQL 로도 이 사람이 안 잡힌다 — 역주입 증명이 성립하지 않는다');
});

test('[INV-W1] 위험학생 응답의 4개 명단이 모두 학생 모집단(SSOT) 안에 있다', async () => {
  const res = await get(`/api/lrs/warnings/${CLASS_ID}`, TEACHER_ID);
  assert.equal(res.status, 200, `담임(${TEACHER_ID})은 200 이어야 한다 (실제 ${res.status})`);
  const j = res.json;
  assert.ok(j && j.success, '응답이 success 여야 한다');

  const ssot = ssotStudents(CLASS_ID);
  const ssotIds = new Set(ssot.map(s => s.user_id));
  const LISTS = ['inactive', 'noData', 'consecutiveWrong', 'weakAchievements'];

  const offenders = [];
  for (const key of LISTS) {
    const arr = j[key] || [];
    assert.ok(Array.isArray(arr), `${key} 는 배열이어야 한다`);
    for (const it of arr) {
      if (!ssotIds.has(it.userId)) offenders.push(`${key}: userId=${it.userId} name=${it.displayName}`);
    }
  }
  assert.deepEqual(offenders, [],
    '한 응답 안에서 모집단이 갈렸다 — 어떤 명단은 SSOT, 어떤 명단은 손 SQL 을 쓰고 있다.\n'
    + `SSOT(${ssotIds.size}명): ${[...ssotIds].join(',')}\n`
    + '모집단 밖 항목:\n  ' + offenders.join('\n  '));
});

test('[INV-W1] 탈퇴 멤버(강다은)가 어느 명단에도 실명으로 남지 않는다', async () => {
  const j = (await get(`/api/lrs/warnings/${CLASS_ID}`, TEACHER_ID)).json;
  const where = [];
  for (const key of ['inactive', 'noData', 'consecutiveWrong', 'weakAchievements']) {
    for (const it of (j[key] || [])) {
      if (it.userId === REMOVED_ID || it.displayName === REMOVED_NAME) where.push(`${key}`);
    }
  }
  assert.deepEqual(where, [],
    `탈퇴 멤버 ${REMOVED_NAME}(cm.status='removed')가 ${where.join(', ')} 에 남았다 — `
    + '교사 화면에 이 반 학생이 아닌 사람이 실명으로 노출된다');
});

test('[INV-W1] summary 카운트가 각 명단 길이와 일치한다 (요약만 다른 모집단이면 안 됨)', async () => {
  const j = (await get(`/api/lrs/warnings/${CLASS_ID}`, TEACHER_ID)).json;
  assert.equal(j.summary.inactiveCount, j.inactive.length, 'inactiveCount 가 명단 길이와 다르다');
  assert.equal(j.summary.noDataCount, j.noData.length, 'noDataCount 가 명단 길이와 다르다');
  assert.equal(j.summary.consecutiveWrongCount, j.consecutiveWrong.length, 'consecutiveWrongCount 가 명단 길이와 다르다');
  assert.equal(j.summary.weakCount, j.weakAchievements.length, 'weakCount 가 명단 길이와 다르다');
});

// ════════════════════════════════════════════════════════════════════════════
// INV-W2  소스 락이 별칭 이름과 무관하게 잡는다
// ════════════════════════════════════════════════════════════════════════════
test('[INV-W2] 별칭이 u2·x·stu·s 무엇이든 "반을 세는 손 SQL" 이 걸린다', () => {
  // 실제 사고 형태 그대로: class_members 와 같은 SQL 창 안에서 손으로 적은 학생 조건
  const mkSrc = (alias) => [
    'const rows = db.prepare(`',
    '  SELECT las.user_id FROM lrs_achievement_stats las',
    '  WHERE las.user_id IN (SELECT cm.user_id FROM class_members cm',
    `                         JOIN users ${alias} ON ${alias}.id = cm.user_id`,
    `                        WHERE cm.class_id = ? AND ${alias}.role = 'student')`,
    '`).all(classId);',
  ].join('\n');

  const missed = [];
  for (const alias of ['u', 'cu', 'u2', 'u3', 'x', 'stu', 's', 'usr', '_u']) {
    if (scanClassScopedPopulationSource(mkSrc(alias), 'synthetic.js').length === 0) missed.push(alias);
  }
  assert.deepEqual(missed, [],
    `소스 락이 별칭 ${missed.join('/')} 를 놓쳤다 — 별칭은 작성자가 마음대로 붙이는 이름이라\n`
    + '열거식 술어는 원리적으로 샌다(실제 사고: routes/lrs.js:4194 의 u2 가 통과했다)');
});

test('[INV-W2] 별칭 없는 `role = \'student\'` 도 창 안이면 걸린다', () => {
  const src = [
    'const rows = db.prepare(`',
    '  SELECT user_id FROM class_members',
    "  WHERE class_id = ? AND role='student' AND status='active'",
    '`).all(classId);',
  ].join('\n');
  assert.ok(scanClassScopedPopulationSource(src, 'synthetic.js').length > 0,
    '별칭 없는 손 SQL(= db/learning.js:154 의 죽은 조건과 같은 형태)이 안 걸린다');
});

test('[INV-W2] 오탐 방지 — 거시 집계·다른 컬럼·JS 비교는 걸리지 않는다', () => {
  const cases = [
    // ① 거시 집계: 창에 class_members 가 없다 → 정당(INV-L4 가 보호하는 23건 부류)
    ["const r = db.prepare(`SELECT COUNT(*) c FROM users u WHERE u.role='student' AND u.school_name IS NOT NULL`).get();", '거시 집계'],
    // ② 다른 컬럼: user_role / my_role 은 모집단 술어가 아니다
    ["const r = db.prepare(`SELECT * FROM class_members cm JOIN users u ON u.id=cm.user_id WHERE u.user_role='student'`).all();", 'user_role 컬럼'],
    // ③ JS 비교(===)는 SQL 이 아니다 — FE/JS 는 별도 검사가 담당
    ["const s = members.filter(m => m.role === 'student');  // class_members 기반", 'JS === 비교'],
  ];
  const wrong = [];
  for (const [src, label] of cases) {
    const hits = scanClassScopedPopulationSource(src, 'synthetic.js');
    if (hits.length > 0) wrong.push(`${label}: ${hits.join(' | ')}`);
  }
  assert.deepEqual(wrong, [],
    '일반화가 과해져 정당한 SQL 까지 잡는다 — 오탐이 늘면 pop-ok 남발로 락이 무력화된다:\n' + wrong.join('\n'));
});

test('[INV-W2] 일반화한 락으로 LRS 계열 전 파일을 다시 훑어도 잔존 0 건', () => {
  const ROOT = path.join(__dirname, '..');
  const offenders = [];
  for (const rel of POPULATION_SCAN_CLASSJOIN_TARGETS) {
    offenders.push(...scanClassScopedPopulation(path.join(ROOT, rel), rel));
  }
  assert.deepEqual(offenders, [],
    '별칭 무관 스캔에서 새 잔존이 나왔다 — 고치기 전에 목록을 감리에 보고할 것\n'
    + '(거시 집계를 클래스 로스터로 좁히면 INV-L4 가 붉어진다):\n' + offenders.join('\n'));
});

// ════════════════════════════════════════════════════════════════════════════
// INV-N2  db/learning.js 의 대상자 조회가 0행이 아니다
// ════════════════════════════════════════════════════════════════════════════
test('[INV-N2] 오늘의 학습 자동 배포가 학생 모집단 전원에게 실제로 꽂힌다', () => {
  const learningDb = require('../db/learning');
  const D = '2027-01-15';                       // 기존 픽스처와 겹치지 않는 날짜
  db.prepare('DELETE FROM daily_learning WHERE learning_date = ?').run(D);

  const expected = ssotStudents(CLASS_ID);
  assert.ok(expected.length > 0, '전제 확인: class 2 에 학생이 있어야 한다');

  learningDb.createDailyAssignment(CLASS_ID, TEACHER_ID, {
    title: '회귀 배포', goals: [{ title: '국어 읽기', completed: false }], assign_date: D,
  });

  const got = db.prepare('SELECT user_id FROM daily_learning WHERE learning_date = ? ORDER BY user_id').all(D).map(r => r.user_id);
  assert.notEqual(got.length, 0,
    '자동 배포 루프가 0명에게 꽂혔다 — cm.role 값 도메인은 {member, owner} 뿐이라 '
    + "`role='student'` 로 거르면 항상 0행이다(조용한 무동작). 교사에겐 201 '배포 완료'로 보인다");
  assert.deepEqual(got, expected.map(s => s.user_id).sort((a, b) => a - b),
    '배포 대상이 학생 모집단과 다르다 — 탈퇴자·학부모·교직원·삭제계정이 섞였거나 빠졌다');
});

test('[INV-N2] 같은 날짜에 두 번 배포해도 행이 불어나지 않는다 (과다 배포 방지)', () => {
  const learningDb = require('../db/learning');
  const D = '2027-01-16';
  db.prepare('DELETE FROM daily_learning WHERE learning_date = ?').run(D);
  const body = { title: '멱등 배포', goals: [{ title: '수학 익힘', completed: false }], assign_date: D };

  learningDb.createDailyAssignment(CLASS_ID, TEACHER_ID, body);
  const n1 = db.prepare('SELECT COUNT(*) c FROM daily_learning WHERE learning_date=?').get(D).c;
  learningDb.createDailyAssignment(CLASS_ID, TEACHER_ID, body);
  const n2 = db.prepare('SELECT COUNT(*) c FROM daily_learning WHERE learning_date=?').get(D).c;

  assert.equal(n2, n1, `재배포로 행이 ${n1} → ${n2} 로 불어났다 (UNIQUE(user_id, learning_date) 우회)`);
  assert.equal(n1, ssotStudents(CLASS_ID).length, '1회 배포 행 수가 학생 모집단 수와 달라졌다');
});
