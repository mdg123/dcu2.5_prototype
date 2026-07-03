// test/mastery.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 성취수준(성취기준 도달도) 중심 LRS — P0 하네스.
//   기획서: 작업지시서/LRS_성취수준_인사이트_재설계_기획서.md §C-2 / §D P0-1·P0-2·P0-6
//
// 불변식·회귀 5종:
//   ① 4상태(도달·부분도달·미도달·평가부족) 합 = 전체 (평가부족 포함)
//   ② 모든 rate ∈ [0,100] 또는 null (분모 0 = null, NaN/Infinity 금지)
//   ③ att<3 은 not_reached 가 아니라 insufficient ← BUG 박제("안 해본 것"≠"못한 것")
//   ④ mastery API classId 격리 — class 매트릭스는 해당 반 학생만 포함
//   ⑤ 권한분기 — 학생은 본인만, 타 학생/타 반 차단(403)
//
// DB 격리: 실 DB → 임시 복사본. initSchema()로 격리 DB에도 마이그레이션(std_id·level ADD COLUMN)
//   적용 후 rebuildAllAggregates()로 재집계(insufficient 분리·std_id 충진).
// 계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4. class 1 = teacher1 소유.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                          // ★ db require 전에 DB_PATH 주입
require('../db/schema').initSchema();   // 격리 DB에도 std_id·level 컬럼 마이그레이션
require('../db/lrs-aggregate').rebuildAllAggregates(); // insufficient 분리·std_id 충진 반영

const mastery = require('../db/lrs-mastery');
const db = openTestDb();

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const CLASS = 1;

const VALID_STATUS = new Set(['reached', 'partial', 'not_reached', 'insufficient']);

// ── 직접 모듈 단언용: 성취 데이터가 있는 학생 id 들을 실측으로 고른다.
function studentsWithData(limit = 5) {
  return db.prepare(
    'SELECT user_id FROM lrs_achievement_stats GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT ?'
  ).all(limit).map(r => r.user_id);
}

// ──────────────────────────────────────────────────────────────────────────
// ① 4상태 합 = 전체 (학생 mastery)
// ──────────────────────────────────────────────────────────────────────────
test('INV-M1: 학생 4상태(도달·부분도달·미도달·평가부족) 합 = standards 총수 = distribution.total', () => {
  for (const sid of studentsWithData()) {
    const d = mastery.getStudentMastery(sid);
    const sum = d.counts.reached + d.counts.partial + d.counts.notReached + d.counts.insufficient;
    assert.equal(sum, d.counts.total, `student ${sid}: 4상태 합(${sum}) != total(${d.counts.total})`);
    assert.equal(d.standards.length, d.counts.total, `student ${sid}: standards 길이 != total`);
    // distribution(도넛 키)도 동일
    const distSum = d.distribution.reached + d.distribution.partial + d.distribution.not_reached + d.distribution.insufficient;
    assert.equal(distSum, d.distribution.total, `student ${sid}: distribution 합 != total`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ② rate ∈ [0,100] 또는 null. status 는 4종 중 하나. NaN/Infinity 금지.
// ──────────────────────────────────────────────────────────────────────────
test('INV-M2: 모든 rate ∈ [0,100] 또는 null, status 4종, NaN/Infinity 금지', () => {
  const checkRate = (rate, ctx) => {
    if (rate == null) return;
    assert.ok(Number.isFinite(rate), `${ctx} rate=${rate} 는 유한수여야`);
    assert.ok(rate >= 0 && rate <= 100, `${ctx} rate=${rate} 는 0~100`);
  };
  for (const sid of studentsWithData()) {
    const d = mastery.getStudentMastery(sid);
    for (const s of d.standards) {
      checkRate(s.rate, `student ${sid} ${s.code}`);
      assert.ok(VALID_STATUS.has(s.status), `student ${sid} ${s.code} status=${s.status} 비정상`);
    }
    for (const bs of d.bySubject) {
      checkRate(bs.reachedRate, `student ${sid} subj ${bs.subject_code} reachedRate`);
      checkRate(bs.avgRate, `student ${sid} subj ${bs.subject_code} avgRate`);
    }
  }
  // 클래스 매트릭스 셀 rate 도 검증
  const members = db.prepare(`
    SELECT cm.user_id, u.display_name FROM class_members cm JOIN users u ON cm.user_id=u.id
    WHERE cm.class_id=? AND cm.status='active' AND u.role='student'
  `).all(CLASS).map(m => ({ id: m.user_id, name: m.display_name }));
  const cd = mastery.getClassMastery(CLASS, members);
  for (const code of Object.keys(cd.matrix)) {
    for (const uid of Object.keys(cd.matrix[code])) {
      const cell = cd.matrix[code][uid];
      checkRate(cell.rate, `class ${CLASS} ${code} u${uid}`);
      assert.ok(VALID_STATUS.has(cell.status), `class ${CLASS} ${code} u${uid} status=${cell.status} 비정상`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ③ BUG 박제: att<3 은 not_reached 가 아니라 insufficient.
//    (옛 버그: lrs_aggregate.js 가 시도<3 → '미도달' 로 묶어 "안 해본 것"="못한 것" 혼동)
// ──────────────────────────────────────────────────────────────────────────
test('BUG-M3: att<3 성취기준은 insufficient(평가부족) 이지 not_reached(미도달) 아님', () => {
  // classifyStatus 단위 — 핵심 임계
  assert.equal(mastery.classifyStatus(0, null), 'insufficient', 'att=0 → insufficient');
  assert.equal(mastery.classifyStatus(1, 100), 'insufficient', 'att=1(만점이어도) → insufficient');
  assert.equal(mastery.classifyStatus(2, 0), 'insufficient', 'att=2 → insufficient (미도달 아님)');
  assert.equal(mastery.classifyStatus(3, 0), 'not_reached', 'att=3 rate0 → not_reached');
  assert.equal(mastery.classifyStatus(3, 50), 'partial', 'att=3 rate50 → partial');
  assert.equal(mastery.classifyStatus(3, 80), 'reached', 'att=3 rate80 → reached');
  assert.equal(mastery.classifyStatus(5, null), 'insufficient', 'rate null(분모0) → insufficient');

  // 집계 테이블 전수: att<3 인데 not_reached 인 행이 단 1개도 없어야(BUG 재발 차단)
  const bad = db.prepare(
    "SELECT COUNT(*) c FROM lrs_achievement_stats WHERE attempt_count<3 AND level='not_reached'"
  ).get().c;
  assert.equal(bad, 0, `att<3 인데 level=not_reached 인 행 ${bad}개 — 평가부족으로 분리돼야`);
  // 한글 레거시 컬럼도 동일(att<3 → '평가부족', '미도달' 아님)
  const badKo = db.prepare(
    "SELECT COUNT(*) c FROM lrs_achievement_stats WHERE attempt_count<3 AND last_level='미도달'"
  ).get().c;
  assert.equal(badKo, 0, `att<3 인데 last_level='미도달' 인 행 ${badKo}개 — '평가부족'으로 분리돼야`);
  // 분리가 실제로 발생했는지(insufficient 가 0 이 아님 — 데이터가 있으면)
  const hasData = db.prepare('SELECT COUNT(*) c FROM lrs_achievement_stats WHERE attempt_count<3').get().c;
  if (hasData > 0) {
    const ins = db.prepare("SELECT COUNT(*) c FROM lrs_achievement_stats WHERE level='insufficient'").get().c;
    assert.ok(ins > 0, 'att<3 데이터가 있는데 insufficient 가 0 — 분리 미작동');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ④ classId 격리: class 매트릭스는 해당 반 학생만 포함(타 반 user 셀 없음)
// ──────────────────────────────────────────────────────────────────────────
test('INV-M4: mastery class 매트릭스 classId 격리 — 해당 반 학생만 등장', () => {
  const members = db.prepare(`
    SELECT cm.user_id FROM class_members cm JOIN users u ON cm.user_id=u.id
    WHERE cm.class_id=? AND cm.status='active' AND u.role='student'
  `).all(CLASS).map(m => m.user_id);
  const memberSet = new Set(members);
  const studentsArg = members.map(id => ({ id, name: `s${id}` }));
  const cd = mastery.getClassMastery(CLASS, studentsArg);

  // students 헤더 = 멤버 집합과 동일
  for (const s of cd.students) assert.ok(memberSet.has(s.id), `class ${CLASS}: 매트릭스 학생 ${s.id} 가 반 멤버 아님`);
  // 매트릭스 셀의 user 키도 전부 멤버
  for (const code of Object.keys(cd.matrix)) {
    for (const uid of Object.keys(cd.matrix[code])) {
      assert.ok(memberSet.has(Number(uid)), `class ${CLASS}: 매트릭스 셀 u${uid} 가 반 멤버 아님(격리 위반)`);
    }
  }
  // notReachedStudents 명단도 멤버 한정
  for (const s of cd.standards) {
    for (const u of (s.notReachedStudents || [])) {
      assert.ok(memberSet.has(u.id), `class ${CLASS}: 미도달 명단 u${u.id} 가 반 멤버 아님`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ④b BUG 박제(P0): 성취수준 분류는 "누적" 기준 — 기간(period)으로 은폐되면 안 됨.
//    옛 결함: getStudentMastery 가 fromDate~toDate(30일) 로 성취기준을 필터해, 30일보다
//      이전에 시도한 누적 미도달이 창 밖으로 빠져 은폐됐다(uid3 notReached 5→2). 도달/미도달은
//      그간 학습의 누적 결과이므로, 누적(전기간 lrs_achievement_stats)만 써야 한다.
//    ground-truth 참고(2026-07 실 DB uid3): 누적 미도달 5건
//      [4수01-02]·[4수03-02]·[4수03-04]·[4수01-13]·[4수03-10] (전부 att>=3 & 정답 0).
//    ★[2026-07-03 강건화] "정확히 5건" 절대값 박제는 라이브 DB 드리프트에 취약 —
//      student1 은 프리뷰 데모 계정이라 스위트 실행 중에도 로그가 쌓여(파일별 복사 시점이 달라)
//      과도 상태의 6건 등이 잡히며 flake 났다. → 기대값을 "같은 복사본에 대한 독립 SQL
//      이중장부"(문서화된 임계 att>=3 & rate<50 를 테스트가 별도 산출)로 대체.
//      분류기(classifyStatus·reachRate) 회귀 감시는 유지되고, 핵심 박제(기간 불변)는 그대로다.
// ──────────────────────────────────────────────────────────────────────────
/** 독립 이중장부: 미도달 코드 집합을 테스트 소유 산식(att>=3 & rate<50)으로 직접 산출. */
function sqlNotReachedCodes(uid) {
  return db.prepare(
    'SELECT achievement_code code, attempt_count a, success_count s, avg_score v FROM lrs_achievement_stats WHERE user_id = ?'
  ).all(uid).filter(r => {
    const a = r.a || 0;
    if (a < 3) return false;
    let rate = null;
    if (a > 0 && Number.isFinite(Number(r.s))) rate = (Number(r.s) / a) * 100;
    else if (r.v != null) rate = Number(r.v) > 1 ? Number(r.v) : Number(r.v) * 100;
    if (rate == null || !Number.isFinite(rate)) return false;
    return rate < 50;
  }).map(r => (String(r.code).startsWith('[') ? r.code : `[${r.code}]`));
}

test('BUG-M-CUM: student1(uid3) 누적 미도달 == 독립 SQL 산출 — 기간(period) 무관 동일(은폐 금지)', () => {
  const expected = new Set(sqlNotReachedCodes(STUDENT1));
  assert.ok(expected.size >= 1, '전제: uid3 누적 미도달 최소 1건(빈 데이터로 공허 통과 금지)');

  // opts.period 를 넘겨도 분류는 항상 누적(전기간). period 파라미터는 무시돼야 한다.
  const base = mastery.getStudentMastery(STUDENT1);
  assert.equal(base.counts.notReached, expected.size,
    `uid3 누적 미도달 ${expected.size}건(독립 SQL)이어야(현재 ${base.counts.notReached}) — 30일 창 밖 누적 미도달 은폐 금지`);

  // 분류기(API) 미도달 집합 == 독립 SQL 집합 (이중장부 완전 일치)
  const nrCodes = base.standards.filter(s => s.status === 'not_reached').map(s => s.code).sort();
  assert.deepEqual(nrCodes, [...expected].sort(),
    'standards(not_reached) 코드 집합 != 독립 SQL 산출(분류기 회귀)');

  // weaknesses(상한 5) 구조 계약: 전부 미도달·부분도달에서만, 개수 == min(5, 미도달+부분)
  const weakCodes = (base.weaknesses || []).map(w => w.code);
  const nrOrPartial = new Set(base.standards
    .filter(s => s.status === 'not_reached' || s.status === 'partial').map(s => s.code));
  for (const c of weakCodes) {
    assert.ok(nrOrPartial.has(c), `weakness ${c} 가 미도달/부분도달 밖(약점 정의 위반)`);
  }
  assert.equal(weakCodes.length, Math.min(5, base.counts.notReached + base.counts.partial),
    `weaknesses 개수 != min(5, 미도달+부분도달)`);

  // ★ period(7/30/90d) 를 어떻게 주어도 counts 가 동일(누적 불변) — 은폐 재발 차단(핵심 박제)
  for (const p of ['7d', '30d', '90d']) {
    const d = mastery.getStudentMastery(STUDENT1, { period: p });
    assert.equal(d.counts.notReached, base.counts.notReached,
      `period=${p} 인데 notReached 가 달라짐(${d.counts.notReached}≠${base.counts.notReached}) — 성취수준은 누적이어야`);
    assert.equal(d.counts.reached, base.counts.reached, `period=${p} reached 변동`);
    assert.equal(d.counts.partial, base.counts.partial, `period=${p} partial 변동`);
    assert.equal(d.counts.insufficient, base.counts.insufficient, `period=${p} insufficient 변동`);
    assert.equal(d.counts.total, base.counts.total, `period=${p} total 변동`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⑤ 권한분기 (API 레벨, 실제 라우터+미들웨어 HTTP).
// ──────────────────────────────────────────────────────────────────────────
const express = require('express');
const session = require('express-session');
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
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject); r.end();
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

test('PERM-M5a: 학생은 본인 mastery 조회 가능(200), 타 학생은 차단(403)', async () => {
  const own = await req(`/mastery/student/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200, '본인 조회는 200');
  assert.equal(own.json.success, true);
  assert.ok(own.json.counts && typeof own.json.counts.total === 'number', 'counts.total 존재');

  const other = await req(`/mastery/student/${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '타 학생 조회는 403');
});

test('PERM-M5b: 교사·관리자는 학생 mastery 조회 가능(200)', async () => {
  const byTeacher = await req(`/mastery/student/${STUDENT1}`, TEACHER);
  assert.equal(byTeacher.status, 200, '교사는 학생 조회 200');
  const byAdmin = await req(`/mastery/student/${STUDENT1}`, ADMIN);
  assert.equal(byAdmin.status, 200, '관리자는 학생 조회 200');
});

test('API-M-CUM: /mastery/student/3 — period 7d·30d·90d 전부 동일 counts (누적, 기간 무관)', async () => {
  // 기대값 = 같은 복사본 독립 SQL(BUG-M-CUM 과 동일 이중장부 — 라이브 절대값 5 박제 폐지, 강건화 주석 참조)
  const expected = sqlNotReachedCodes(STUDENT1).length;
  const d30 = await req(`/mastery/student/${STUDENT1}?period=30d`, STUDENT1);
  const d90 = await req(`/mastery/student/${STUDENT1}?period=90d`, STUDENT1);
  const d7  = await req(`/mastery/student/${STUDENT1}?period=7d`, STUDENT1);
  assert.equal(d30.status, 200); assert.equal(d90.status, 200); assert.equal(d7.status, 200);
  assert.equal(d30.json.counts.notReached, expected, `?period=30d notReached=${expected}(독립 SQL) (현재 ${d30.json.counts.notReached})`);
  assert.equal(d90.json.counts.notReached, expected, `?period=90d notReached=${expected} (현재 ${d90.json.counts.notReached})`);
  assert.equal(d7.json.counts.notReached, expected, `?period=7d 도 notReached=${expected} (누적, 은폐 금지)`);
  // 세 기간 counts 완전 동일(누적 불변 — 핵심 박제)
  assert.deepEqual(d90.json.counts, d30.json.counts, '30d↔90d counts 불일치(기간이 분류를 바꿈)');
  assert.deepEqual(d7.json.counts, d30.json.counts, '7d↔30d counts 불일치(기간이 분류를 바꿈)');
  // 응답 weaknesses 는 전부 미도달/부분도달 코드(라벨 relabel 후에도 code 는 유지)
  const nrOrPartial = new Set((d30.json.standards || [])
    .filter(s => s.status === 'not_reached' || s.status === 'partial').map(s => s.code));
  for (const w of (d30.json.weaknesses || [])) {
    assert.ok(nrOrPartial.has(w.code), `?period=30d weakness ${w.code} 가 미도달/부분도달 밖`);
  }
  if (expected > 0) {
    assert.ok((d30.json.weaknesses || []).length > 0, '미도달 존재 시 weaknesses 비어 있으면 안 됨');
  }
});

test('PERM-M5c: class mastery — 소유 교사·관리자 200, 타 학생 403', async () => {
  const byTeacher = await req(`/mastery/class/${CLASS}`, TEACHER);
  assert.equal(byTeacher.status, 200, '소유 교사 class 조회 200');
  assert.ok(Array.isArray(byTeacher.json.standards), 'standards 배열');
  assert.ok(byTeacher.json.matrix && typeof byTeacher.json.matrix === 'object', 'matrix 객체');
  assert.ok(byTeacher.json.distribution && typeof byTeacher.json.distribution.total === 'number', 'distribution.total');

  // 학생(class 멤버여도 매트릭스 차단 — 타 학생 성취 노출 방지). canViewClass: student → false
  const byStudent = await req(`/mastery/class/${CLASS}`, STUDENT1);
  assert.equal(byStudent.status, 403, '학생은 class 매트릭스 차단(403)');
});

test('PERM-M5d: class mastery 응답의 학생은 해당 반 멤버만(API 레벨 격리)', async () => {
  const r = await req(`/mastery/class/${CLASS}`, TEACHER);
  assert.equal(r.status, 200);
  const memberIds = new Set(db.prepare(`
    SELECT cm.user_id FROM class_members cm JOIN users u ON cm.user_id=u.id
    WHERE cm.class_id=? AND cm.status='active' AND u.role='student'
  `).all(CLASS).map(m => m.user_id));
  // masked(n<10) 면 학생 id 는 유지(이름만 마스킹). id 격리 검증.
  for (const code of Object.keys(r.json.matrix)) {
    for (const uid of Object.keys(r.json.matrix[code])) {
      assert.ok(memberIds.has(Number(uid)), `API class ${CLASS}: 매트릭스 u${uid} 가 반 멤버 아님`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⑥ BUG 박제(P0): 비멤버 교사가 "남의 반" 성취 매트릭스/경고/통계에 접근 불가.
//    옛 결함: canViewClass 의 폴백 `return req.user.role==='teacher'` 가 모든 교사에게
//    모든 클래스를 통과시켜 반 경계를 넘은 개인 성취 데이터(per-student 매트릭스) 노출.
//    실 DB: teacher1(id2) 는 class 1·2 의 owner, class 3·4 의 owner_id 는 8·9 → 비멤버.
//    → teacher1 이 자기 소유가 아닌 반을 조회하면 403 이어야 한다.
// ──────────────────────────────────────────────────────────────────────────

// 실측: teacher(id2) 가 멤버가 아닌(=교사 티어 role 이 없는) active 클래스 id 를 고른다.
function classNotMemberedByTeacher() {
  return db.prepare(`
    SELECT c.id FROM classes c
    WHERE c.status='active'
      AND c.id NOT IN (
        SELECT cm.class_id FROM class_members cm
        WHERE cm.user_id=? AND cm.status='active'
          AND cm.role IN ('owner','teacher','co_teacher')
      )
    ORDER BY c.id LIMIT 1
  `).get(TEACHER);
}

test('BUG-M6: 비멤버 교사는 남의 반 mastery/class 차단(403) — P0 권한 누수 fix', async () => {
  const foreign = classNotMemberedByTeacher();
  assert.ok(foreign, '실 DB 에 teacher1 비멤버 active 클래스가 있어야 테스트 가능');
  // 사전 확인: teacher1 은 정말 이 반의 교사-티어 멤버가 아님
  const myRole = db.prepare(
    "SELECT role FROM class_members WHERE class_id=? AND user_id=? AND status='active'"
  ).get(foreign.id, TEACHER);
  assert.ok(!myRole || !['owner','teacher','co_teacher'].includes(myRole.role),
    `전제 위반: teacher1 이 class ${foreign.id} 의 교사-티어 멤버임(role=${myRole && myRole.role})`);

  const r = await req(`/mastery/class/${foreign.id}`, TEACHER);
  assert.equal(r.status, 403, `비멤버 교사의 class ${foreign.id} mastery 는 403 이어야 (현재 ${r.status})`);
});

test('BUG-M6b: 비멤버 교사는 남의 반 warnings 차단(403) — canViewClass 공통 거동', async () => {
  const foreign = classNotMemberedByTeacher();
  assert.ok(foreign, '비멤버 active 클래스 필요');
  const r = await req(`/warnings/${foreign.id}`, TEACHER);
  assert.equal(r.status, 403, `비멤버 교사의 class ${foreign.id} warnings 는 403 이어야 (현재 ${r.status})`);
});

test('BUG-M6c: 비멤버 교사는 남의 반 class LRS 통계 차단(403)', async () => {
  const foreign = classNotMemberedByTeacher();
  assert.ok(foreign, '비멤버 active 클래스 필요');
  const r = await req(`/class/${foreign.id}`, TEACHER);
  assert.equal(r.status, 403, `비멤버 교사의 class ${foreign.id} 통계는 403 이어야 (현재 ${r.status})`);
});

test('BUG-M6d: 회귀 없음 — 소유 교사·관리자는 자기 반/전체 warnings 여전히 200', async () => {
  const ownByTeacher = await req(`/warnings/${CLASS}`, TEACHER);
  assert.equal(ownByTeacher.status, 200, '소유 교사의 자기 반 warnings 200 유지');
  const foreign = classNotMemberedByTeacher();
  const adminAny = await req(`/warnings/${foreign.id}`, ADMIN);
  assert.equal(adminAny.status, 200, '관리자는 임의 반 warnings 200 유지');
});

// ──────────────────────────────────────────────────────────────────────────
// ⑦ 개인정보 마스킹 정책 전환(2026-06) 박제.
//    결정: 담임/담당(owner·teacher·co_teacher 멤버)은 자기 반 학생을 n 과 무관하게 실명.
//          n<10 익명화는 "담임이 아닌" 거시뷰(관리자 비소유·타반)에만 적용(개인정보 보호 유지).
//    실 DB: class 1 = teacher1(id2) 소유, 학생 8명(<10). admin(id1) 은 class 1 비멤버.
// ──────────────────────────────────────────────────────────────────────────

// 익명 라벨("학생 A" 패턴) 판별 — 마스킹 여부 휴리스틱.
function looksAnonymized(name) {
  return /^학생\s*[A-Z]$/.test(String(name || '').trim());
}

test('INV-PRIV1: 전제 — class 1 은 소표본(학생<10) 이고 teacher1 소유, admin 은 비멤버', () => {
  const n = db.prepare(`
    SELECT COUNT(*) c FROM class_members cm JOIN users u ON cm.user_id=u.id
    WHERE cm.class_id=? AND cm.status='active' AND u.role='student'
  `).get(CLASS).c;
  assert.ok(n > 0 && n < 10, `class ${CLASS} 학생수 ${n} 은 0<n<10 이어야(소표본 정책 검증 가능)`);
  const teacherRole = db.prepare("SELECT role FROM class_members WHERE class_id=? AND user_id=? AND status='active'").get(CLASS, TEACHER);
  assert.ok(teacherRole && ['owner','teacher','co_teacher'].includes(teacherRole.role),
    `teacher1 은 class ${CLASS} 의 교사-티어 멤버여야 (role=${teacherRole && teacherRole.role})`);
  const adminRole = db.prepare("SELECT role FROM class_members WHERE class_id=? AND user_id=? AND status='active'").get(CLASS, ADMIN);
  assert.ok(!adminRole || !['owner','teacher','co_teacher'].includes(adminRole.role),
    'admin 은 class 1 의 교사-티어 멤버가 아니어야(거시뷰 익명 검증 전제)');
});

test('INV-PRIV2: 담임/담당(teacher1)은 소표본이어도 자기 반 mastery 실명(masked=false)', async () => {
  const r = await req(`/mastery/class/${CLASS}`, TEACHER);
  assert.equal(r.status, 200, '소유 교사 mastery 200');
  assert.equal(r.json.masked, false, '담임은 masked=false(실명) — n<10 무관');
  // 학생 이름이 익명 라벨이 아니어야(실명 노출)
  const anyAnon = (r.json.students || []).some(s => looksAnonymized(s.name));
  assert.ok(!anyAnon, '담임 뷰의 학생명이 "학생 A" 익명 라벨이면 안 됨(실명이어야)');
  assert.ok((r.json.students || []).length > 0, '학생 헤더가 있어야');
});

test('INV-PRIV3: 비소유 관리자(admin)는 소표본 mastery 익명(masked=true) — 개인정보 불변식', async () => {
  const r = await req(`/mastery/class/${CLASS}`, ADMIN);
  assert.equal(r.status, 200, '관리자 mastery 200');
  assert.equal(r.json.masked, true, '비소유 관리자는 n<10 → masked=true(익명) 유지(개인정보 보호)');
  // 모든 학생명이 익명 라벨이어야
  const allAnon = (r.json.students || []).every(s => looksAnonymized(s.name));
  assert.ok(allAnon, '비소유 관리자 뷰의 학생명은 전부 "학생 A" 형태 익명이어야');
});

test('INV-PRIV4: ews — 담임 실명(masked=false), 비소유 관리자 익명(masked=true)', async () => {
  const t = await req(`/ews/class/${CLASS}`, TEACHER);
  assert.equal(t.status, 200, '담임 ews 200');
  assert.equal(t.json.masked, false, '담임 ews masked=false');
  const a = await req(`/ews/class/${CLASS}`, ADMIN);
  assert.equal(a.status, 200, '관리자 ews 200');
  assert.equal(a.json.masked, true, '비소유 관리자 ews masked=true(소표본 익명)');
  // 담임 위험군 이름이 익명 라벨이 아니어야(데이터가 있을 때만 의미)
  for (const r of (t.json.risk && t.json.risk.list) || []) {
    assert.ok(!looksAnonymized(r.name), `담임 ews 위험군 이름 "${r.name}" 이 익명이면 안 됨`);
  }
  // 관리자 위험군 이름은 익명이어야(데이터가 있을 때)
  for (const r of (a.json.risk && a.json.risk.list) || []) {
    assert.ok(looksAnonymized(r.name), `관리자 ews 위험군 이름 "${r.name}" 은 익명이어야`);
  }
});

test('INV-PRIV5: warnings — 담임 실명, 비소유 관리자 소표본 익명', async () => {
  const t = await req(`/warnings/${CLASS}`, TEACHER);
  assert.equal(t.status, 200, '담임 warnings 200');
  assert.equal(t.json.masked, false, '담임 warnings masked=false(실명)');
  const a = await req(`/warnings/${CLASS}`, ADMIN);
  assert.equal(a.status, 200, '관리자 warnings 200');
  assert.equal(a.json.masked, true, '비소유 관리자 warnings masked=true(소표본 익명)');
  // 이름 노출되는 모든 리스트에 대해 담임=실명 / 관리자=익명 교차 검증(데이터 있을 때)
  const namesOf = (j) => [
    ...(j.inactive || []), ...(j.noData || []), ...(j.consecutiveWrong || []),
    ...(j.weakAchievements || [])
  ].map(x => x.displayName).filter(Boolean);
  for (const nm of namesOf(t.json)) assert.ok(!looksAnonymized(nm), `담임 warnings 이름 "${nm}" 이 익명이면 안 됨`);
  for (const nm of namesOf(a.json)) assert.ok(looksAnonymized(nm), `관리자 warnings 이름 "${nm}" 은 익명이어야`);
});

test('INV-PRIV6: weak-trend — 교사 scope=class masked=false, 관리자 scope=all 소표본 익명 유지', async () => {
  const t = await req(`/weak-trend?scope=class`, TEACHER);
  assert.equal(t.status, 200, '교사 weak-trend(class) 200');
  assert.equal(t.json.scope, 'class');
  assert.equal(t.json.masked, false, '교사 자기 반 weak-trend 는 masked=false');
  const a = await req(`/weak-trend?scope=all`, ADMIN);
  assert.equal(a.status, 200, '관리자 weak-trend(all) 200');
  assert.equal(a.json.scope, 'all');
  // 전체 학생이 10명 미만이면 masked=true 여야(소표본 거시 보호). 10명 이상이면 false.
  const expected = (a.json.studentCount || 0) < (a.json.minSample || 10);
  assert.equal(a.json.masked, expected,
    `관리자 all weak-trend masked 는 (studentCount<minSample)=${expected} 와 일치해야`);
});

test('INV-PRIV7: 비멤버 교사는 여전히 403(권한) — 마스킹 이전에 차단', async () => {
  const foreign = classNotMemberedByTeacher();
  assert.ok(foreign, '비멤버 active 클래스 필요');
  const r = await req(`/mastery/class/${foreign.id}`, TEACHER);
  assert.equal(r.status, 403, '비멤버 교사는 마스킹 분기 이전에 403');
});
