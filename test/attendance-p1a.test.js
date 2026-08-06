// test/attendance-p1a.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P1-A] 출석·감정·게이미피케이션 결함 박제 — W2-T5-1 ~ W2-T5-6.
//
// ── 결함 (수정 전, 로컬 사본 실측) ─────────────────────────────────────────
//  ② 모집단 혼입 (W2-T5-4)
//     db/attendance.js getAttendanceTable 이 class_members.status='active' **전원**을
//     반환. FE·export 필터는 `role !== 'owner' && role !== 'teacher'` 뿐인데
//     class_members.role 의 실제 값은 owner/member 두 종뿐이라(실측: member 63·owner 11)
//     학부모(parent1)·교직원(staff1)이 mrole='member' 로 **통과**한다.
//     → 교사 출석부 명단에 이학부모·정교직원, CSV 에 `4,이학부모,-,-,-,0,0,-`.
//       평균 출석률·개근자수·랭킹 분모가 전부 오염.
//  ③ KPI 라벨↔산식 모순 (W2-T5-5)
//     같은 화면에 "평균 출석률 4%" 와 "개근자 수 10명"(전원). computeKPIs 가 개근을
//     "absent 셀 0개" 로 정의하는데 실 DB absent 는 0건 → **미기록(-)도 개근**.
//  ④ 클래스 공동 목표 300% (W2-T5-2)
//     attendance.html: `members.filter(m => m.role === 'student').length || 1`
//     → class_members.role 에 'student' 가 없어 항상 0 → 분모 1.
//       3명 출석 시 "현재 300% / 목표 90.0% / 🎉 목표 달성!". 1명만 와도 즉시 달성.
//  ⑤ 주/월 출석률 항상 0% (W2-T5-3)
//     FE 가 status.this_week_rate·this_month_rate·next_badge·best_streak 를 읽는데
//     서버 getUserStats 는 {totalDays, streak, badges, title} 만 반환.
//  ⑥ 랭킹 모집단 필터 전무 (W2-T5-6)
//     db/attendance.js getRanking 에 users.role='student' 도 class_members.status 도
//     없다. 실측: class1 랭킹에 김선생(교사) 9위. 탈퇴자 출석 29건도 집계.
//     동점 공동순위 없이 배열 인덱스로 순위 부여.
//  ⑦ 감정 데이터 권한 (W2-T5-1) — P0
//     GET /:classId/today 가 주석은 "(교사용)" 인데 requireMember 만 걸려 있다.
//     바로 옆 /class-stats·/table 에는 있는 owner 검사가 여기만 빠졌고
//     db getAttendanceByDate 가 `SELECT a.*` 라 emotion_reason(감정 사유 자유서술)이
//     그대로 나간다. 실측: student1 이 student2 의
//     {emotion:"bad", emotion_reason:"수학 시험이 걱정돼서 마음이 무거워요"} 를 조회.
//     교사가 is_public=0 으로 꺼도 API 는 200 + 전원 감정·사유를 반환(게이트가 FE 에만).
//
//     ⚠ 의도 판별: 학생 피드(attendance.html loadFeed)가 렌더하는 필드는
//       display_name · comment · 이모지 · checked_at **4종뿐이고 emotion_reason 은
//       화면에 없다**. 즉 "출석 한마디 공유" 는 의도된 기능이고, 감정 사유는 의도
//       범위 밖의 과다 응답이다. → 기능은 살리고 사유만 막는다(과잉 차단 금지).
//
// ── 정본 ───────────────────────────────────────────────────────────────────
//   모집단: db/class.js studentPopulationSql()/getClassStudentIds() (팀B SSOT 재사용).
//           출석 모듈은 자체 판정을 갖지 않는다.
//   /today: owner/admin = 전체 행 / 비-owner = is_public=1 일 때만 공개 4필드 /
//           is_public=0 이면 카운트만 (loadGoal 이 필요한 건 인원수뿐이라 기능 유지).
//
// ── 역주입 증명 ────────────────────────────────────────────────────────────
//   · getAttendanceTable 의 멤버 쿼리를 옛 `status='active'` 전원으로 되돌리면 INV-ATT-1
//   · getRanking 에서 모집단 조인을 빼면 INV-ATT-2, 공동순위를 빼면 INV-ATT-2b
//   · getUserStats 에서 주/월 필드를 빼면 INV-ATT-3
//   · /today 의 스코프 분기를 빼면 INV-ATT-6/6b/6c
//   · attendance.html 의 개근 정의를 `absentForMe===0` 로 되돌리면 INV-ATT-4
//   · 목표 분모를 `m.role==='student'` 로 되돌리면 INV-ATT-5
//
// DB 격리: 실 DB → 임시 사본(_setup). 전용 시드로 결정적. 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ 라우터가 db 모듈을 require 하기 전에 DB_PATH 주입
require('../db/schema').initSchema();
const express = require('express');
const session = require('express-session');
const attendanceDb = require('../db/attendance');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');
const readSrc = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let server, baseUrl;
let _seq = 0;
const uniq = () => `${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function insUser(role, name) {
  return Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', ?, ?)"
  ).run(`p1a_${role}_${uniq()}`, name, role).lastInsertRowid);
}

// ── 라이브 class 1 구성 재현 ───────────────────────────────────────────────
//   owner(교사) + 학생 3 + 학부모 1 + 교직원 1 + 탈퇴(removed) 학생 1
//   → class_members active 행 6 / 정본 학생 모집단 3
const F = (() => {
  const owner = insUser('teacher', '김선생');
  const s1 = insUser('student', '이학생');
  const s2 = insUser('student', '박학생');
  const s3 = insUser('student', '최학생');
  const parent = insUser('parent', '이학부모');
  const staff = insUser('staff', '정교직원');
  const gone = insUser('student', '떠난학생');
  const outsider = insUser('teacher', '남의반선생');

  const cls = Number(db.prepare(
    "INSERT INTO classes (code, name, owner_id) VALUES (?, 'P1A출석검증반', ?)"
  ).run(`P1A${uniq().slice(-6)}`, owner).lastInsertRowid);

  const join = (uid, role, status) => db.prepare(
    'INSERT INTO class_members (class_id, user_id, role, status) VALUES (?,?,?,?)'
  ).run(cls, uid, role, status);
  join(owner, 'owner', 'active');
  join(s1, 'member', 'active');
  join(s2, 'member', 'active');
  join(s3, 'member', 'active');
  join(parent, 'member', 'active');   // ← 결함 ②: 옛 필터를 통과하던 학부모
  join(staff, 'member', 'active');    // ← 결함 ②: 옛 필터를 통과하던 교직원
  join(gone, 'member', 'removed');    // ← 결함 ⑥: 랭킹에 집계되던 탈퇴자

  return { cls, owner, s1, s2, s3, parent, staff, gone, outsider };
})();

// ── 출석 기록 시드 ─────────────────────────────────────────────────────────
//   학교일 3일(월~수). s1 = 3일 전부 출석(개근), s2 = 1일만, s3 = 0일(미기록).
//   교사·학부모·교직원·탈퇴자도 출석행을 넣어 "모집단 밖인데 집계되는지" 를 본다.
const D = ['2026-06-01', '2026-06-02', '2026-06-03'];   // 월·화·수
function att(uid, date, extra = {}) {
  db.prepare(`
    INSERT INTO attendance (class_id, user_id, attendance_date, status, comment, emotion, emotion_reason, checkin_source, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(F.cls, uid, date, extra.status || 'present', extra.comment || null,
    extra.emotion || null, extra.reason || null, 'manual',
    extra.checkedAt || `${date} 00:10:00`);   // UTC 00:10 = KST 09:10 (같은 날)
}
D.forEach(d => att(F.s1, d, { comment: '안녕하세요' }));
att(F.s2, D[0], {
  comment: '오늘도 화이팅',
  emotion: 'bad',
  reason: '수학 시험이 걱정돼서 마음이 무거워요',   // ← 결함 ⑦ 의 유출 표적
});
D.forEach(d => att(F.owner, d));      // 교사 — 랭킹·명단에 나오면 안 됨
att(F.parent, D[0]);                  // 학부모
att(F.staff, D[0]);                   // 교직원
D.forEach(d => att(F.gone, d));       // 탈퇴자 3일 — 랭킹 1위로 치고 올라오던 행

// ── "오늘" 시드 ────────────────────────────────────────────────────────────
//   /today 계열은 KST 오늘 날짜를 읽으므로 별도로 오늘 행을 넣는다.
//   (이걸 빠뜨리면 records 가 빈 배열이라 유출 테스트가 **공허하게 통과**한다.)
const TODAY = require('../lib/kst').kstToday();
att(F.s2, TODAY, {
  comment: '오늘도 화이팅',
  emotion: 'bad',
  reason: '수학 시험이 걱정돼서 마음이 무거워요',   // ← 결함 ⑦ 의 유출 표적
});
att(F.s1, TODAY, { comment: '안녕하세요', emotion: 'good' });
att(F.parent, TODAY);                 // 모집단 밖 인물이 피드에 뜨는지
att(F.staff, TODAY);

db.prepare(
  'INSERT INTO attendance_settings (class_id, is_public, show_ranking, class_goal) VALUES (?,1,1,90)'
).run(F.cls);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/attendance', require('../routes/attendance'));
  return app;
}

function call(method, p, asUser, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(baseUrl + p, { method, headers }, (res) => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: b, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (p, u) => call('GET', p, u);

before(async () => {
  await new Promise(resolve => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

const names = arr => (arr || []).map(m => m.display_name).sort();

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-0: 픽스처 전제 — 이게 무너지면 아래 전부 무의미.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-0: 픽스처 전제 — 학부모·교직원이 class_members.role=member 로 들어있다', () => {
  const roles = db.prepare(
    "SELECT DISTINCT role FROM class_members WHERE class_id = ?"
  ).all(F.cls).map(r => r.role).sort();
  assert.deepEqual(roles, ['member', 'owner'],
    "class_members.role 에는 owner/member 만 존재 — 'student'/'teacher' 로 거르는 코드는 전부 오작동");

  const parentRow = db.prepare(
    'SELECT role, status FROM class_members WHERE class_id=? AND user_id=?'
  ).get(F.cls, F.parent);
  assert.equal(parentRow.role, 'member', '학부모가 member 로 들어있어야 결함 재현');
  assert.equal(parentRow.status, 'active');
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-1 (W2-T5-4): 출석부 명단은 순수 학생만.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-1: getAttendanceTable 명단에 학부모·교직원·개설자·탈퇴자가 없다', () => {
  const t = attendanceDb.getAttendanceTable(F.cls, D[0], D[2], true);
  assert.deepEqual(names(t.members), ['박학생', '이학생', '최학생'],
    '순수 학생 3명만 — 이학부모/정교직원/김선생/떠난학생이 보이면 명단·분모가 오염된다');
  assert.equal(t.members.length, 3, '총원은 3명 (옛 코드는 7명)');
});

test('INV-ATT-1b: 모집단 판정이 db/class.js SSOT 한 벌이다 (사본 금지)', () => {
  const classDb = require('../db/class');
  const ssot = classDb.getClassStudentIds(F.cls).sort((a, b) => a - b);
  const table = attendanceDb.getAttendanceTable(F.cls, D[0], D[2], true)
    .members.map(m => m.user_id).sort((a, b) => a - b);
  assert.deepEqual(table, ssot, '출석부 명단 = 클래스 학생 SSOT');

  const src = readSrc('db/attendance.js');
  assert.ok(/require\('\.\/class'\)/.test(src),
    'db/attendance.js 가 db/class.js SSOT 를 참조해야 한다 — 자체 SQL 로 다시 적으면 두 벌');
});

test('INV-ATT-1c: CSV/엑셀 export 도 같은 명단을 쓴다', async () => {
  const r = await get(`/api/attendance/${F.cls}/export?from=${D[0]}&to=${D[2]}&format=csv&includeWeekends=true`, F.owner);
  assert.equal(r.status, 200);
  assert.equal(r.body.includes('이학부모'), false, 'CSV 에 학부모가 있으면 안 된다');
  assert.equal(r.body.includes('정교직원'), false, 'CSV 에 교직원이 있으면 안 된다');
  assert.equal(r.body.includes('떠난학생'), false, 'CSV 에 탈퇴자가 있으면 안 된다');
  assert.ok(r.body.includes('이학생'), '학생은 그대로 나와야 한다 (과잉 필터 금지)');
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-2 (W2-T5-6): 랭킹 모집단 + 공동순위.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-2: 랭킹에 교사·학부모·교직원·탈퇴자가 없다', () => {
  const r = attendanceDb.getRanking(F.cls);
  const shown = names(r);
  assert.deepEqual(shown, ['이학생', '박학생'].sort(),
    '출석 기록이 있는 순수 학생만 — 김선생(교사) 9위 같은 것이 결함이었다');
  assert.equal(r.some(x => x.user_id === F.gone), false,
    '탈퇴자(status=removed)의 출석은 집계에서 빠져야 한다');
});

test('INV-ATT-2b: 동점은 공동순위 (배열 인덱스 순위 금지)', () => {
  // s2 를 s1 과 동점(3일)으로 만들고 별도 클래스에서 검증 — 기존 픽스처 불변 유지.
  const owner = insUser('teacher', '동점반선생');
  const a = insUser('student', '동점가');
  const b = insUser('student', '동점나');
  const c = insUser('student', '삼등');
  const cls = Number(db.prepare(
    "INSERT INTO classes (code, name, owner_id) VALUES (?, '동점반', ?)"
  ).run(`TIE${uniq().slice(-6)}`, owner).lastInsertRowid);
  [[owner, 'owner'], [a, 'member'], [b, 'member'], [c, 'member']].forEach(([u, ro]) =>
    db.prepare("INSERT INTO class_members (class_id,user_id,role,status) VALUES (?,?,?,'active')").run(cls, u, ro));
  D.forEach(d => {
    db.prepare("INSERT INTO attendance (class_id,user_id,attendance_date,status) VALUES (?,?,?,'present')").run(cls, a, d);
    db.prepare("INSERT INTO attendance (class_id,user_id,attendance_date,status) VALUES (?,?,?,'present')").run(cls, b, d);
  });
  db.prepare("INSERT INTO attendance (class_id,user_id,attendance_date,status) VALUES (?,?,?,'present')").run(cls, c, D[0]);

  const r = attendanceDb.getRanking(cls);
  assert.equal(r.length, 3);
  assert.equal(r[0].total_days, 3);
  assert.equal(r[1].total_days, 3);
  assert.equal(r[0].rank, 1, '동점 1위');
  assert.equal(r[1].rank, 1, '동점자는 같은 순위여야 한다 (2위로 밀리면 안 됨)');
  assert.equal(r[2].rank, 3, '동점 2명 다음은 3위 (표준 경쟁 순위)');
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-3 (W2-T5-3): 학생 통계 계약 — FE 가 읽는 필드를 서버가 준다.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-3: getUserStats 가 주/월 출석률·최고기록·다음뱃지를 반환한다', () => {
  const s = attendanceDb.getUserStats(F.cls, F.s1);
  for (const k of ['totalDays', 'streak', 'badges', 'title',
    'this_week_rate', 'this_month_rate', 'best_streak', 'next_badge']) {
    assert.ok(k in s, `getUserStats 에 ${k} 누락 — FE 가 읽는 계약(attendance.html:1456-1463)`);
  }
  assert.equal(typeof s.this_week_rate, 'number');
  assert.equal(typeof s.this_month_rate, 'number');
  assert.ok(s.this_week_rate >= 0 && s.this_week_rate <= 100, '출석률은 0~100%');
  assert.ok(s.this_month_rate >= 0 && s.this_month_rate <= 100, '출석률은 0~100%');
  assert.ok(s.best_streak >= s.streak, '최고 기록은 현재 연속보다 작을 수 없다');
});

test('INV-ATT-3b: 출석한 달의 출석률이 0% 가 아니다 (도넛 거짓말 금지)', () => {
  // 2026-06-01~03 에 3일 출석한 s1 의 "그 달" 출석률은 0 이 아니어야 한다.
  const s = attendanceDb.getUserStats(F.cls, F.s1, { ref: Date.parse('2026-06-03T04:00:00Z') });
  assert.ok(s.this_month_rate > 0,
    '출석 기록이 있는데 이번 달 0% 면 학생 화면 도넛이 거짓말을 한다');
  assert.ok(s.this_week_rate > 0, '같은 주에 출석했는데 0% 면 안 된다');

  const none = attendanceDb.getUserStats(F.cls, F.s3, { ref: Date.parse('2026-06-03T04:00:00Z') });
  assert.equal(none.this_month_rate, 0, '한 번도 출석 안 한 학생은 0% (과대계상 금지)');
});

test('INV-ATT-3c: next_badge 는 아직 못 받은 다음 목표를 가리킨다', () => {
  const s = attendanceDb.getUserStats(F.cls, F.s1);
  if (s.next_badge) {
    assert.ok(s.next_badge.threshold > s.streak,
      '다음 목표는 현재 연속보다 커야 한다 (이미 달성한 뱃지를 가리키면 "0일 남음")');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-4 (W2-T5-5): KPI 라벨↔산식 정합 — "4% 인데 전원 개근" 불가능.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-4: 개근자 수는 평균 출석률과 수학적으로 모순될 수 없다', () => {
  // computeKPIs(attendance.html)의 정본 산식을 같은 픽스처로 재현한다.
  //   rate        = presentLate / (학생수 × 학교일수)
  //   perfectCount= 모든 학교일에 present/late 인 학생 수
  // 정의상 perfectCount/total ≤ rate/100 이 항상 성립한다.
  // 옛 산식(absent 셀 0개 = 개근)은 미기록 학생까지 개근으로 세어 이 부등식을 깬다.
  const t = attendanceDb.getAttendanceTable(F.cls, D[0], D[2], true);
  const students = t.members, dates = t.dates, rec = t.records;
  let presentLate = 0, perfect = 0;
  for (const m of students) {
    let mine = 0;
    for (const d of dates) {
      const r = rec[`${m.user_id}_${d}`];
      if (r && (r.status === 'present' || r.status === 'late')) mine++;
    }
    presentLate += mine;
    if (dates.length > 0 && mine === dates.length) perfect++;
  }
  const rate = dates.length ? (presentLate / (students.length * dates.length)) * 100 : 0;

  assert.equal(perfect, 1, '전부 출석한 학생은 이학생 1명 (옛 산식은 미기록자까지 3명으로 셌다)');
  assert.ok(perfect / students.length <= rate / 100 + 1e-9,
    `개근율(${(perfect / students.length * 100).toFixed(1)}%)이 평균 출석률(${rate.toFixed(1)}%)을 넘을 수 없다`);
});

test('INV-ATT-4b: 소스 락 — "absent 셀 0개 = 개근" 정의가 부활하지 않는다', () => {
  const html = readSrc('public/class/attendance.html');
  const i = html.indexOf('function computeKPIs');
  assert.notEqual(i, -1, 'computeKPIs 가 있어야 한다');
  const body = html.slice(i, i + 2200);
  assert.equal(/absentForMe\s*===\s*0/.test(body), false,
    '개근을 "absent 셀 0개" 로 정의하면 미기록(-)까지 개근이 된다 — 출석일수로 판정할 것');
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-5 (W2-T5-2): 클래스 공동 목표 분모.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-5: 소스 락 — 목표 분모가 존재하지 않는 role 값을 쓰지 않는다', () => {
  // 주석 줄은 결함 설명을 담고 있으므로 제외하고 실제 코드만 본다.
  const html = readSrc('public/class/attendance.html')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(/\.filter\(\s*m\s*=>\s*m\.role\s*===\s*'student'\s*\)/.test(html), false,
    "class_members.role 에 'student' 는 존재하지 않는다 → 항상 0건 → 분모 1 → 300%");
  assert.equal(/\.length\s*\|\|\s*1\b/.test(html), false,
    '분모 0 을 `|| 1` 로 덮으면 1명만 출석해도 100% 가 된다 — 빈 상태로 표시할 것');
});

test('INV-ATT-5b: 서버가 목표 계산용 학생 수를 제공하고 그 값이 SSOT 와 같다', async () => {
  const classDb = require('../db/class');
  const r = await get(`/api/attendance/${F.cls}/today`, F.s1);
  assert.equal(r.status, 200);
  assert.equal(r.json.student_total, classDb.getClassStudentCount(F.cls),
    '학생 화면 목표 분모는 서버 SSOT 에서 와야 한다 (FE 가 추측하면 300% 가 난다)');
  assert.equal(r.json.student_total, 3);
  assert.ok(r.json.present_count <= r.json.student_total,
    '출석 인원이 학생 수를 넘을 수 없다 (넘으면 100% 초과가 나온다)');
});

// ═══════════════════════════════════════════════════════════════════════════
// INV-ATT-6 (W2-T5-1, P0): 감정 사유 유출 차단 — 기능 손실 0.
// ═══════════════════════════════════════════════════════════════════════════
test('INV-ATT-6: 학생은 남의 감정 사유(자유서술)를 읽을 수 없다', async () => {
  const r = await get(`/api/attendance/${F.cls}/today`, F.s1);
  assert.equal(r.status, 200, 'is_public=1 이면 피드는 살아 있어야 한다 (과잉 차단 금지)');
  assert.equal(r.body.includes('수학 시험이 걱정돼서'), false,
    '감정 사유는 민감정보 — 학생 응답에 절대 실리면 안 된다');
  for (const rec of r.json.records) {
    assert.equal('emotion_reason' in rec, false, `emotion_reason 필드 자체가 없어야 한다`);
  }
});

test('INV-ATT-6b: 학생 피드에 필요한 4필드는 그대로 내려간다 (기능 유지)', async () => {
  const r = await get(`/api/attendance/${F.cls}/today`, F.s1);
  const mine = r.json.records.find(x => x.user_id === F.s2);
  assert.ok(mine, '출석한 친구가 피드에 보여야 한다');
  assert.equal(mine.display_name, '박학생', '실명 표시는 의도된 기능(loadFeed)');
  assert.equal(mine.comment, '오늘도 화이팅', '출석 한마디 공유는 의도된 기능');
  assert.equal(mine.emotion, 'bad', '이모지 표시는 의도된 기능 (사유와 달리 화면에 있다)');
  assert.ok(mine.checked_at, '시각 표시 필요');
});

test('INV-ATT-6c: is_public=0 이면 명단이 안 나가고 카운트만 나간다', async () => {
  attendanceDb.updateSettings(F.cls, { is_public: 0 });
  try {
    const r = await get(`/api/attendance/${F.cls}/today`, F.s1);
    assert.equal(r.status, 200, '카운트는 필요하므로 403 이 아니다 (공동목표 기능 유지)');
    assert.deepEqual(r.json.records, [], '공개를 끄면 명단이 나가면 안 된다 — 게이트가 FE 에만 있었다');
    assert.equal(r.body.includes('박학생'), false, '이름도 새면 안 된다');
    assert.equal(typeof r.json.present_count, 'number', '카운트는 유지 (loadGoal 이 쓴다)');
    assert.ok(r.json.present_count > 0, '실제 출석 인원은 계속 계산돼야 한다');
  } finally {
    attendanceDb.updateSettings(F.cls, { is_public: 1 });
  }
});

test('INV-ATT-6d: 교사(개설자)·admin 은 감정 사유까지 전부 본다 (과잉 차단 금지)', async () => {
  const r = await get(`/api/attendance/${F.cls}/today`, F.owner);
  assert.equal(r.status, 200);
  const target = r.json.records.find(x => x.user_id === F.s2);
  assert.equal(target.emotion_reason, '수학 시험이 걱정돼서 마음이 무거워요',
    '교사 감정 리포트·관심학생 기능이 죽으면 안 된다');

  // is_public=0 이어도 교사는 계속 봐야 한다(공개 스위치는 학생 피드용이지 교사 차단이 아니다).
  attendanceDb.updateSettings(F.cls, { is_public: 0 });
  try {
    const r2 = await get(`/api/attendance/${F.cls}/today`, F.owner);
    assert.equal(r2.json.records.length > 0, true, '공개를 꺼도 교사는 오늘 출석 현황을 본다');
    assert.ok(r2.json.records.find(x => x.user_id === F.s2).emotion_reason,
      '교사에게는 사유가 계속 보여야 한다');
  } finally {
    attendanceDb.updateSettings(F.cls, { is_public: 1 });
  }
});

test('INV-ATT-6e: 비멤버는 여전히 403 (기존 게이트 회귀 금지)', async () => {
  const r = await get(`/api/attendance/${F.cls}/today`, F.outsider);
  assert.equal(r.status, 403, '남의 반 교사는 접근 불가');
});

test('INV-ATT-6f: 학생용 응답에는 모집단 밖 인물이 안 나온다', async () => {
  const r = await get(`/api/attendance/${F.cls}/today`, F.s1);
  const shown = r.json.records.map(x => x.display_name);
  assert.equal(shown.includes('이학부모'), false, '학부모가 학생 피드에 뜨면 안 된다');
  assert.equal(shown.includes('정교직원'), false, '교직원이 학생 피드에 뜨면 안 된다');
});
