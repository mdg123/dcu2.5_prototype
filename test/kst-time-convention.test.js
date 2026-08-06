// test/kst-time-convention.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P1-A] 시각 규약 SSOT 박제 — W1-T2-10 · W2-T5-7 · W2-T5-13.
//
// ── 정본 규약 (PM 승인 2026-08-06, 선택지 "다") ────────────────────────────
//   저장은 UTC 유지(SQLite CURRENT_TIMESTAMP) · 날짜 귀속과 표시만 **고정 +9**(KST).
//   `datetime('now','localtime')` 은 프로세스 TZ 의존이라 쓰지 않는다.
//
// ── 결함 (수정 전 실측) ────────────────────────────────────────────────────
//   ① 날짜 귀속: db/attendance.js:5,34,61,100,217 · routes/attendance.js:158,169,
//      213,244,631 이 `new Date().toISOString().slice(0,10)` = **UTC 날짜**.
//      KST 00:00~08:59 체크인이 전날로 기록된다. 등교 시간대(08:00~08:50 KST)가
//      정확히 이 구간 → 실사용 시작과 동시에 출석일이 하루씩 밀린다.
//      ※ 실 DB 실측: 실사용 체크인 270행의 오귀속 0건(UTC 15~23시 행이 아직 0개).
//        즉 잠복 상태이며 마이그레이션 불필요. 이 테스트가 재발을 영구 차단한다.
//   ② 표시: DB 는 'YYYY-MM-DD HH:MM:SS'(UTC·오프셋 표기 없음)로 저장하는데
//      FE 가 `new Date(s)` 로 파싱 → V8 이 **로컬**로 읽어 9시간 어긋난다.
//      12:56 에 쓴 글이 "9시간 전"·"2026.08.05 03:56" 으로 표시되고
//      상대시간과 절대시간이 서로도 불일치했다.
//   ③ 감정 차트: public/growth/emotion-monitor.html:589 가 주석에
//      "checkedAt이 UTC이면 로컬로 보정" 이라 적어두고 **보정 코드가 비어 있었다**
//      (`if(!isNaN(ts)){/*이미 파싱됨*/}`). KST 16:59 입력이 X축 7시에 찍혔다.
//
// ── 정본 ───────────────────────────────────────────────────────────────────
//   lib/kst.js        (BE) — routes/exam.js kstTodayStr() 승격
//   public/js/kst.js  (FE) — public/plus/gallery.html timeAgo 패턴 승격
//   두 모듈은 같은 규약을 구현하며 INV-KST-5 가 결과 일치를 강제한다.
//
// ── 역주입 증명 ────────────────────────────────────────────────────────────
//   · lib/kst.js kstToday 를 `new Date().toISOString().slice(0,10)` 로 되돌리면
//     INV-KST-1/2 가 붉어진다.
//   · parseServerTime 의 'Z' 부착을 빼면 INV-KST-3/5/6 이 붉어진다.
//   · public/js/kst.js timeAgo 가 별도 파서를 쓰면 INV-KST-6 이 붉어진다.
//   · db/attendance.js 에 toISOString().slice(0,10) 을 되살리면 INV-KST-7 이 붉어진다.
//
// DB 격리: 실 DB → 임시 사본(_setup). 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                        // ★ db 모듈 require 전에 DB_PATH 주입
require('../db/schema').initSchema();
const kst = require('../lib/kst');
const attendanceDb = require('../db/attendance');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');
const readSrc = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// public/js/kst.js 를 CommonJS 로 로드 (module.exports 폴백 경로가 있다).
const feKst = require('../public/js/kst.js');

// ── 위험 구간 기준 시각 ────────────────────────────────────────────────────
//   2026-09-01 08:30 KST = 2026-08-31 23:30 UTC.
//   등교 체크인 시간대. UTC 날짜(08-31)와 KST 날짜(09-01)가 갈리는 바로 그 지점.
const MORNING_KST = Date.parse('2026-08-31T23:30:00Z');

let _seq = 0;
const uniq = () => `${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function seedClassWithStudent() {
  const owner = Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', '김선생', 'teacher')"
  ).run(`kst_t_${uniq()}`).lastInsertRowid);
  const stu = Number(db.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES (?, 'x', '이학생', 'student')"
  ).run(`kst_s_${uniq()}`).lastInsertRowid);
  const cls = Number(db.prepare(
    "INSERT INTO classes (code, name, owner_id) VALUES (?, 'KST검증반', ?)"
  ).run(`KST${uniq().slice(-6)}`, owner).lastInsertRowid);
  db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?,?,'owner','active')").run(cls, owner);
  db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?,?,'member','active')").run(cls, stu);
  return { cls, owner, stu };
}

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-1: 날짜 귀속은 KST. 등교 시간대(KST 08:30)에 UTC 날짜를 쓰면 전날이 된다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-1: KST 08:30 의 "오늘" 은 그 날이다 (UTC 날짜로 전날 밀림 금지)', () => {
  assert.equal(kst.kstToday(MORNING_KST), '2026-09-01',
    'KST 08:30 은 09-01 이다. toISOString().slice(0,10) 은 08-31 을 준다(결함)');

  // 결함 재현: 옛 산식이 실제로 전날을 준다는 것을 같은 시각으로 대조 고정.
  const buggy = new Date(MORNING_KST).toISOString().slice(0, 10);
  assert.equal(buggy, '2026-08-31', '옛 UTC 산식은 전날을 준다 — 이 차이가 결함의 실체');
  assert.notEqual(kst.kstToday(MORNING_KST), buggy, 'SSOT 는 옛 산식과 달라야 한다');

  // 경계 반대편: KST 09:00 이후는 UTC 날짜와 같아져 결함이 숨는다(그래서 지금껏 안 터졌다).
  assert.equal(kst.kstToday(Date.parse('2026-09-01T04:00:00Z')), '2026-09-01');
});

test('INV-KST-1b: KST 자정 직후·직전 경계', () => {
  assert.equal(kst.kstToday(Date.parse('2026-08-31T15:00:00Z')), '2026-09-01', 'KST 00:00 정각');
  assert.equal(kst.kstToday(Date.parse('2026-08-31T14:59:59Z')), '2026-08-31', 'KST 23:59:59');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-2: 실제 체크인 경로가 KST 날짜로 기록한다 (행동 검증, 시계 고정).
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-2: checkIn/isCheckedIn 이 KST 08:30 을 그 날로 기록한다', (t) => {
  const { cls, stu } = seedClassWithStudent();
  mock.timers.enable({ apis: ['Date'], now: MORNING_KST });
  t.after(() => mock.timers.reset());

  const r = attendanceDb.checkIn(cls, stu, '좋은 아침이에요');
  assert.equal(r.success, true, '체크인 성공');
  assert.equal(r.date, '2026-09-01',
    'KST 08:30 체크인은 09-01 출석이다 — 08-31 이면 등교 출석이 전날로 밀린 것');

  const row = db.prepare('SELECT attendance_date FROM attendance WHERE class_id=? AND user_id=?').get(cls, stu);
  assert.equal(row.attendance_date, '2026-09-01', 'DB 에 저장된 날짜도 KST 기준');

  // 같은 날 재체크인은 중복으로 막혀야 한다(날짜 키가 흔들리면 중복 출석이 생긴다).
  assert.equal(attendanceDb.isCheckedIn(cls, stu), true, '같은 KST 날 안에서는 출석 완료로 보여야 한다');
  assert.equal(attendanceDb.checkIn(cls, stu).already, true, '중복 체크인 차단');
});

test('INV-KST-2b: ensureTodayAttendance(자동출석)도 같은 KST 날짜 키를 쓴다', (t) => {
  const { cls, stu } = seedClassWithStudent();
  mock.timers.enable({ apis: ['Date'], now: MORNING_KST });
  t.after(() => mock.timers.reset());

  const a = attendanceDb.ensureTodayAttendance(cls, stu, 'lesson_view');
  assert.equal(a.date, '2026-09-01', '자동 출석도 KST 날짜');
  // 멱등: 수동 체크인이 뒤따라도 새 행이 생기면 안 된다(날짜 키 불일치 시 2행이 된다).
  attendanceDb.checkIn(cls, stu, '한마디');
  const n = db.prepare('SELECT COUNT(*) c FROM attendance WHERE class_id=? AND user_id=?').get(cls, stu).c;
  assert.equal(n, 1, '자동+수동이 같은 날짜 키를 써야 행이 1개 — 2개면 규약이 두 벌');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-3: 저장 문자열은 UTC 로 파싱한다 (로컬 파싱 금지).
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-3: 공백 구분 저장 문자열을 UTC 로 해석한다', () => {
  const stored = '2026-08-05 03:56:16';                 // DB 저장 형태(UTC, 오프셋 표기 없음)
  const parsed = kst.parseServerTime(stored);
  assert.equal(parsed.getTime(), Date.parse('2026-08-05T03:56:16Z'),
    'UTC 로 읽어야 한다 — new Date(s) 는 KST 브라우저에서 9시간 어긋난다');

  // 이 시각의 KST 벽시계는 12:56 (사용자가 실제로 글을 쓴 시각).
  assert.equal(kst.kstDateOf(stored), '2026-08-05');
  assert.equal(kst.kstTimeOf(stored), '12:56', '"03:56" 로 표시되던 것이 결함이었다');

  // 오프셋이 이미 있으면 그대로 신뢰한다(xapi spool 은 ISO Z 로 저장).
  assert.equal(kst.parseServerTime('2026-08-05T03:56:16.000Z').getTime(),
    Date.parse('2026-08-05T03:56:16Z'));
  assert.equal(kst.parseServerTime('2026-08-05T12:56:16+09:00').getTime(),
    Date.parse('2026-08-05T03:56:16Z'), '명시 오프셋을 이중 변환하면 안 된다');

  // 해석 불가 입력은 조용히 null (화면에 Invalid Date / NaN 이 새지 않도록).
  assert.equal(kst.parseServerTime(null), null);
  assert.equal(kst.parseServerTime(''), null);
  assert.equal(kst.parseServerTime('없음'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-4: SQL 날짜 귀속도 같은 +9 를 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-4: sqlKstDate 가 UTC 컬럼을 KST 날짜로 귀속한다', () => {
  const row = db.prepare(
    `SELECT ${kst.sqlKstDate("'2026-08-31 23:30:00'")} AS d`
  ).get();
  assert.equal(row.d, '2026-09-01', 'SQL 경로도 JS 경로와 같은 날짜를 줘야 한다');
  assert.equal(row.d, kst.kstToday(MORNING_KST), 'SQL·JS 두 경로가 같은 답 (규약 단일)');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-5: FE·BE 두 모듈이 같은 규약을 구현한다 (두 벌 방지).
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-5: public/js/kst.js 와 lib/kst.js 의 결과가 일치한다', () => {
  const samples = [
    '2026-08-05 03:56:16',
    '2026-08-31 23:30:00',
    '2026-01-01 00:00:00',
    '2026-08-05T03:56:16.000Z',
    '2026-08-05',
  ];
  for (const s of samples) {
    assert.equal(feKst.parse(s).getTime(), kst.parseServerTime(s).getTime(), `parse 불일치: ${s}`);
    assert.equal(feKst.fmtDate(s), kst.kstDateOf(s), `fmtDate 불일치: ${s}`);
    assert.equal(feKst.fmtTime(s), kst.kstTimeOf(s), `fmtTime 불일치: ${s}`);
  }
  assert.equal(feKst.today(), kst.kstToday(), '오늘 날짜가 두 계층에서 같아야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-6: 상대시간과 절대시간이 **같은 파서**를 쓴다.
//   "9시간 전 ↔ 2026.08.05 03:56" 자기모순의 구조적 차단.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-6: 상대시간·절대시간이 서로 모순되지 않는다', (t) => {
  // 기준: 2026-08-05 12:56 KST. 저장 문자열은 UTC 03:56.
  const nowKst = Date.parse('2026-08-05T06:56:16Z');   // = 15:56 KST (3시간 뒤)
  mock.timers.enable({ apis: ['Date'], now: nowKst });
  t.after(() => mock.timers.reset());

  const stored = '2026-08-05 03:56:16';
  assert.equal(feKst.timeAgo(stored), '3시간 전', '상대시간은 3시간 전');
  assert.equal(feKst.fmtDateTime(stored), '2026-08-05 12:56', '절대시간은 KST 12:56');

  // 두 표시의 정합: 절대시각 + 상대경과 = 현재. 파서가 한 벌이면 항상 성립한다.
  const abs = feKst.parse(stored).getTime();
  const elapsedHours = Math.floor((Date.now() - abs) / 3600000);
  assert.equal(feKst.timeAgo(stored), `${elapsedHours}시간 전`,
    '상대시간이 절대시간과 같은 파서에서 유도돼야 한다');

  // 방금 작성한 글이 "9시간 전" 으로 뜨던 결함의 직접 재현 방지.
  const justNow = '2026-08-05 06:56:00';               // = 15:56 KST, 16초 전
  assert.equal(feKst.timeAgo(justNow), '방금 전', '방금 쓴 글이 "9시간 전" 이면 안 된다');
});

test('INV-KST-6b: 미래로 살짝 어긋난 시각도 음수 표기가 새지 않는다', (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-05T06:56:00Z') });
  t.after(() => mock.timers.reset());
  assert.equal(feKst.timeAgo('2026-08-05 06:56:05'), '방금 전', '"-1분 전" 같은 표기 금지');
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-KST-7: 소스 락 — 담당 파일에서 UTC 날짜 산식이 부활하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
test('INV-KST-7: 출석 모듈에 UTC 날짜 산식(toISOString().slice(0,10))이 없다', () => {
  const BUGGY = /new Date\([^)]*\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;
  for (const f of ['db/attendance.js', 'routes/attendance.js']) {
    const src = readSrc(f)
      // 주석 줄은 결함 설명을 담고 있으므로 제외하고 실제 코드만 본다.
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.equal(BUGGY.test(src), false,
      `${f} 에 UTC 날짜 산식이 남아 있다 — lib/kst.js 의 kstToday() 를 쓸 것`);
  }
});

test('INV-KST-7b: 담당 FE 화면이 시각 SSOT(public/js/kst.js)를 로드한다', () => {
  const pages = [
    'public/class/attendance.html',
    'public/class/emotion-board.html',
    'public/class/emotion-monitor.html',
    'public/growth/emotion-monitor.html',
  ];
  for (const p of pages) {
    assert.ok(readSrc(p).includes('/js/kst.js'),
      `${p} 가 시각 SSOT 를 로드하지 않는다 — 사본 파서가 부활할 자리`);
  }
});

test('INV-KST-7d: 담당 FE 화면에 UTC 날짜 산식·로컬 파싱이 남아 있지 않다', () => {
  const pages = [
    'public/class/attendance.html',
    'public/class/emotion-board.html',
    'public/class/emotion-monitor.html',
    'public/growth/emotion-monitor.html',
  ];
  for (const p of pages) {
    const src = readSrc(p).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.equal(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(src), false,
      `${p}: toISOString().slice(0,10) 은 UTC 날짜 — KST 새벽에 하루 밀린다`);
    // 서버 저장 시각을 그대로 new Date() 에 넣으면 로컬로 파싱돼 9시간 어긋난다.
    assert.equal(/new Date\(\s*\w+\.check(ed_at|edAt)\s*\)/.test(src), false,
      `${p}: checked_at 을 new Date() 로 직접 파싱하면 안 된다 — T.parse() 를 쓸 것`);
  }
});

test('INV-KST-7c: 승격 원본이 사본을 유지하지 않는다 (SSOT 참조)', () => {
  // routes/exam.js 의 kstTodayStr() 는 lib/kst.js 로 승격됐다. 자기 사본을 남기면 두 벌.
  const exam = readSrc('routes/exam.js');
  assert.ok(exam.includes("require('../lib/kst')"), 'routes/exam.js 가 lib/kst.js 를 참조해야 한다');
  assert.equal(/function kstTodayStr\s*\(\s*\)\s*\{[^}]*toISOString/.test(exam), false,
    'routes/exam.js 에 자체 KST 사본이 남아 있다');
  // public/plus/gallery.html 의 timeAgo 도 SSOT 를 쓰도록 승격.
  assert.ok(readSrc('public/plus/gallery.html').includes('/js/kst.js'),
    'gallery.html 이 시각 SSOT 를 로드해야 한다');
});
