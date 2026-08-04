// test/lrs-keris-p2.test.js
// ─────────────────────────────────────────────────────────────────────────────
// KERIS 벤치마킹 P2 하네스 (BE 소관 불변식 박제)
//   기획서: 작업지시서/LRS_P2_교사히트맵_타임라인메타_스펙.md §7 (INV-K12~K15·K11′)
//
//   INV-K12  mastery/detail 계약 — count == items.length == lrs_achievement_stats.attempt_count
//            (uid3 [4수01-04] 실측 8=8=8) · items 행 date·typeLabel 존재·success ∈ {1,0,null}
//            · 학생 세션 타 학생 user_id → 403 · 기간 파라미터 무시(누적 — deepEqual)
//   INV-K13  타임라인 메타 계약 — ① lesson progressPct == round(NORM(result_score)) ∈ [0,100]
//            ② homework hwStatus ∈ {graded,submitted}, graded ⇔ result_score 존재
//            ③ withClassAvg=1: classAvg 존재 ⇔ takers ≥ 5, classAvg ∈ [0,100]
//            ④ withClassAvg 미지정 → classAvg·takers 키 부재(응답 불변 — deepEqual)
//            ⑤ limit=8 → items ≤ 8·count 는 전체 · 키 화이트리스트(식별자 미노출)
//   INV-K14  히트맵 데이터 정합(BE 부분) — standards 행 카운트 == matrix 파생 집계 ==
//            distribution (렌더 셀 수·드로어 DOM 검사는 스모크 FE 소관)
//   INV-K11′ middle 완전판(BE 부분) — 시드(scripts/seed-middle-class.js) 멱등 +
//            middle1 로그인 자격 + peer-compare(2040).peerCount ≥ 5 +
//            mteacher1 mastery/class 학생 8·성취기준 >0·실명(masked=false)
//            (middle1 렌더 분기 스모크는 FE 소관 — 본 파일은 BE 데이터 계약만)
//   INV-K15  평가부족 어휘는 FE DOM 검사(스모크 소관). BE 몫인 '반 평균 -' 마이너스 표기
//            금지는 INV-K13③(classAvg ∈ [0,100] — 음수 불가)과 regression INV-K9 가 커버.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 계정(실 DB 확정): teacher1=2, student1=3, student2=4,
//   middle1=2040(시드 후). HTTP 하네스는 lrs-keris-p0/p1 테스트와 동일 패턴.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb, fixtureWindow } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');
const seedMiddle = require('../scripts/seed-middle-class');

const TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4, MIDDLE1 = 2040;
const MIN_PEERS = 5;

let server, baseUrl, tdb, mteacherId, midClassId;

// ── EXAM_GT_Q: INV-K13③④⑥ 이 공유하는 **시계 독립** 기간 쿼리 조각 ─────────
//   ★ 절대 `period=NNd`(롤링 창)로 되돌리지 말 것 — 2026-07-30 사고 재발.
//     uid3 의 exam_complete 는 2026-06-22(응시자 7명·가드 통과)·2026-07-04
//     (응시자 1명·가드 차단) 두 날짜뿐이라, 롤링 30일 창은 07-22 경 06-22 자
//     데이터를 잃고 "가드 통과 케이스 존재" 단언이 코드 변경 없이 붕괴한다.
//     fixtureWindow 는 창을 시계가 아니라 데이터에서 유도 → 오늘과 무관하게 동일.
//   되돌림 감시는 INV-K13⑥(시계 이동 불변성)이 기계적으로 수행한다.
let EXAM_GT_Q;
// ── LESSON_GT_Q: INV-K13① 용 시계 독립 창 ──────────────────────────────────
//   같은 부류의 2차 폭탄이었다: uid3 의 lesson_progress 는 2026-06-22·06-29·06-30·
//   07-01 뿐이라 롤링 30일 창은 **2026-08-01 에 0건**이 되어 `sqlRows.length > 0`
//   전제가 붕괴한다(실측 시뮬레이션 확인). 창을 데이터에서 유도해 무력화.
let LESSON_GT_Q;
let MIDDLE_GT_Q;

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
// 멀티셋 비교(정렬 후 deepEqual) — 순서 무관 값 일치
const multiset = (arr) => arr.map(x => JSON.stringify(x)).sort();

before(async () => {
  tdb = openTestDb();

  // ── 시드 실행 + 멱등 검증(INV-K11′ 전제) ─────────────────────────────────
  //   임시 DB 가 이미 시드된 복사본이든 아니든: 1차 실행으로 시드 보장 → 스냅샷 →
  //   2차 실행 → 스냅샷 동일(중복 0)이어야 멱등.
  const snap = () => ({
    users: tdb.prepare('SELECT COUNT(*) c FROM users').get().c,
    classes: tdb.prepare('SELECT COUNT(*) c FROM classes').get().c,
    members: tdb.prepare('SELECT COUNT(*) c FROM class_members').get().c,
  });
  seedMiddle.run({ log: () => {} });
  const s1 = snap();
  seedMiddle.run({ log: () => {} });
  const s2 = snap();
  assert.deepEqual(s2, s1, '시드 재실행이 행을 추가함(멱등 위반)');

  // INV-K13③④⑥ 공용 창 — uid3 exam_complete 로그 전 구간(시계 독립).
  const w = fixtureWindow(tdb, { userId: STUDENT1, activityType: 'exam_complete' });
  EXAM_GT_Q = `from=${w.from}&to=${w.to}`;
  const wl = fixtureWindow(tdb, { userId: STUDENT1, activityType: 'lesson_progress' });
  LESSON_GT_Q = `from=${wl.from}&to=${wl.to}`;
  // MIDDLE_GT_Q: INV-K11′ 용. middle1(2040) 의 exam_complete 는 실 DB 고정분(2026-03-16~06-05)이라
  //   롤링 90일 창은 2026-09-04 경 비어 classAvg 부착 0건 → `withAvg.length > 0` 붕괴(실측 시뮬레이션).
  //   seedMiddle.run() 이후에 계산해야 시드로 생성된 계정·로그까지 창에 든다.
  const wm = fixtureWindow(tdb, { userId: MIDDLE1, activityType: 'exam_complete' });
  MIDDLE_GT_Q = `from=${wm.from}&to=${wm.to}`;

  mteacherId = tdb.prepare("SELECT id FROM users WHERE username = 'mteacher1'").get().id;
  midClassId = tdb.prepare(
    "SELECT id FROM classes WHERE owner_id = ? AND name LIKE '%1학년 수학' AND status = 'active'"
  ).get(mteacherId).id;

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-K12①: 표시값=내역 — uid3 상위 코드( [4수01-04] 포함 ) 전수:
//   count == items.length == attempt_count == **시도** 로그 행수(동일 WHERE).
//
// ── 2026-08-04 재기준 (W2-a 시도 술어 도입) ───────────────────────────────
//   이 검사의 "로그 행수" 레그는 원래 무필터 COUNT(*) 였다. attempt_count 도 무필터라
//   우연히 맞아떨어졌을 뿐, 주석이 광고하던 "동일 WHERE"는 실제로 지켜지지 않았다.
//   W2-a 가 attempt_count 를 정본 술어로 좁히자 즉시 갈라졌고(uid3 [4수01-07] 셀 5 ↔ 서랍 6),
//   그 괴리가 여기서 붉게 잡혔다 — 검사는 옳았고 **라우트가 틀렸다**(routes/lrs.js /mastery/detail).
//
//   ★ 이중장부 유지: 술어를 lib/lrs/mastery-population 에서 import 하지 **않고** 여기 손으로 적는다.
//     SSOT 를 같이 import 하면 SSOT 가 통째로 틀어져도 양쪽이 사이좋게 틀려 초록이 된다
//     (W2 감리 지적 "테스트가 검사 대상과 같은 SSOT 를 import 해 이중장부 소멸"의 재발 방지).
// ──────────────────────────────────────────────────────────────────────────
// 시도 술어의 **독립 사본**(손으로 적은 장부). 정본과 뜻이 같아야 하되 코드는 공유하지 않는다.
//   ① achievement_code 존재 ② 채점형 유형 ③ 정오 판정(result_success) 존재
const ATTEMPT_TYPES_SQL = [
  'exam_complete', 'homework_submit', 'content_solve', 'self_learn', 'daily_complete',
  'wrong_note_retry', 'node_complete', 'content_complete', 'problem_attempt',
].map(t => `'${t}'`).join(',');
const ATTEMPT_WHERE_2ND_BOOK =
  `achievement_code IS NOT NULL AND activity_type IN (${ATTEMPT_TYPES_SQL}) AND result_success IS NOT NULL`;

test('INV-K12①: mastery/detail count == items.length == attempt_count == 시도 로그 행수 (uid3 상위 3코드+[4수01-04])', async () => {
  const tops = tdb.prepare(
    'SELECT achievement_code code, attempt_count FROM lrs_achievement_stats WHERE user_id = ? ORDER BY attempt_count DESC LIMIT 3'
  ).all(STUDENT1);
  assert.ok(tops.length > 0, '전제: uid3 stats 존재');
  // [4수01-07] 을 강제 포함 — 판정 없는 학습 이력(daily_complete)이 섞여 있어 필터 유무가 갈리는 코드.
  const codes = [...new Set([...tops.map(t => t.code), '[4수01-04]', '[4수01-07]'])];
  for (const code of codes) {
    const r = await req(`/mastery/detail?user_id=${STUDENT1}&achievement_code=${encodeURIComponent(code)}`, TEACHER);
    assert.equal(r.status, 200, `${code}: HTTP 200`);
    const j = r.json;
    assert.equal(j.success, true);
    const attemptRows = tdb.prepare(
      `SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND achievement_code = ? AND ${ATTEMPT_WHERE_2ND_BOOK}`
    ).get(STUDENT1, code).c;
    const stat = tdb.prepare(
      'SELECT attempt_count FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
    ).get(STUDENT1, code);
    assert.equal(j.count, attemptRows, `${code}: count(${j.count}) != 시도 로그 행수(${attemptRows})`);
    // items 는 LIMIT 50 캡 — cap 인지 비교(R-2 부류 재발 방지: count 는 항상 전체, items 는 캡 내)
    assert.equal(j.items.length, Math.min(50, j.count), `${code}: items.length != min(50, count)`);
    // 서랍에 판정 없는 행이 섞이면 "시도 내역"이 아니게 된다 — 행 단위로도 막는다.
    for (const it of j.items) {
      assert.ok(it.success === 1 || it.success === 0,
        `${code}: 시도 내역에 정오 판정 없는 행(${it.activityType})이 섞임 — 셀 분모와 서랍이 갈라진다`);
    }
    if (stat) {
      assert.equal(j.attempts, stat.attempt_count, `${code}: attempts != attempt_count`);
      assert.equal(j.count, stat.attempt_count, `${code}: count != attempt_count(표시값=내역 계약)`);
    }
    // 실측 박제: [4수01-04] 은 8=8=8 (스펙 §1-4) — 전건 exam_complete 라 필터 전후 불변.
    if (code === '[4수01-04]') assert.equal(j.count, 8, '[4수01-04] 실측 8 회귀');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K12①': 필터가 **실제로 걸리는지**를 역으로 증명한다.
//   [4수01-07](uid3) 은 원시 로그 6행 중 1행이 daily_complete·result_success NULL 이다.
//   따라서 무필터 6 ≠ 시도 5. 라우트가 필터를 빼먹으면 count 가 6 이 되어 여기서 잡힌다.
//   (INV-K12① 만으로는 "양쪽 다 무필터"여도 통과하므로 이 검사가 필요하다.)
// ──────────────────────────────────────────────────────────────────────────
test("INV-K12①': 필터 유효성 역증명 — [4수01-07] 원시 6행 ≠ 시도 5행, 서랍은 5를 보여야", async () => {
  const CODE = '[4수01-07]';
  const raw = tdb.prepare(
    'SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND achievement_code = ?'
  ).get(STUDENT1, CODE).c;
  const att = tdb.prepare(
    `SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND achievement_code = ? AND ${ATTEMPT_WHERE_2ND_BOOK}`
  ).get(STUDENT1, CODE).c;
  assert.ok(raw > att,
    `전제 붕괴: ${CODE} 에 판정 없는 학습 이력이 없어 필터 유효성을 증명할 수 없음(raw=${raw}, att=${att}). ` +
    '실 DB 픽스처가 바뀌었으면 같은 성질(판정 없는 행 혼재)의 코드로 교체할 것.');
  const r = await req(`/mastery/detail?user_id=${STUDENT1}&achievement_code=${encodeURIComponent(CODE)}`, TEACHER);
  assert.equal(r.status, 200);
  assert.equal(r.json.count, att, `${CODE}: count 는 시도(${att})여야 — 무필터(${raw})면 필터 누락`);
  assert.notEqual(r.json.count, raw, `${CODE}: count 가 무필터 행수(${raw})와 같음 = 필터 미적용`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K12②: items 행 계약 + status/rate 분류 일관(셀과 동일 분류기).
// ──────────────────────────────────────────────────────────────────────────
test('INV-K12②: items 행 date·activityType·typeLabel 존재, success ∈ {1,0,null}, scoreNorm 0~100|null, 최신순', async () => {
  const r = await req(`/mastery/detail?user_id=${STUDENT1}&achievement_code=${encodeURIComponent('[4수01-04]')}`, TEACHER);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.ok(['reached', 'partial', 'not_reached', 'insufficient'].includes(j.status), `status enum: ${j.status}`);
  assert.ok(j.rate == null || (j.rate >= 0 && j.rate <= 100), `rate 범위: ${j.rate}`);
  assert.ok(typeof j.label === 'string' && j.label.length > 0, 'label 존재(resolveCode 보강)');
  let prev = null;
  for (const it of j.items) {
    assert.ok(it.date, 'date 존재');
    assert.ok(typeof it.activityType === 'string' && it.activityType, 'activityType 존재');
    assert.ok(typeof it.typeLabel === 'string' && it.typeLabel.length > 0, 'typeLabel 존재');
    assert.ok(it.success === 1 || it.success === 0 || it.success === null, `success enum: ${it.success}`);
    assert.ok(it.scoreNorm == null || (it.scoreNorm >= 0 && it.scoreNorm <= 100), `scoreNorm 범위: ${it.scoreNorm}`);
    if (prev) assert.ok(String(it.date) <= String(prev), 'items 최신순(DESC)');
    prev = it.date;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K12③: 권한 — 학생이 타 학생 user_id → 403 / 본인 → 200 / 잘못된 입력 → 400.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K12③: 권한 403(학생→타 학생)·200(본인·교사)·400(파라미터 누락)', async () => {
  const code = encodeURIComponent('[4수01-04]');
  const other = await req(`/mastery/detail?user_id=${STUDENT2}&achievement_code=${code}`, STUDENT1);
  assert.equal(other.status, 403, '학생 → 타 학생 403');
  const self = await req(`/mastery/detail?user_id=${STUDENT1}&achievement_code=${code}`, STUDENT1);
  assert.equal(self.status, 200, '학생 → 본인 200');
  const noUid = await req(`/mastery/detail?achievement_code=${code}`, TEACHER);
  assert.equal(noUid.status, 400, 'user_id 누락 400');
  const noCode = await req(`/mastery/detail?user_id=${STUDENT1}`, TEACHER);
  assert.equal(noCode.status, 400, 'achievement_code 누락 400');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K12④: 기간 파라미터 무시(누적 정책) — period/from/to 를 줘도 응답 동일.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K12④: mastery/detail 은 누적 — period=7d 지정 응답 == 무지정 응답(deepEqual)', async () => {
  const code = encodeURIComponent('[4수01-04]');
  const plain = await req(`/mastery/detail?user_id=${STUDENT1}&achievement_code=${code}`, TEACHER);
  const scoped = await req(`/mastery/detail?user_id=${STUDENT1}&achievement_code=${code}&period=7d`, TEACHER);
  assert.equal(plain.status, 200); assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.json, plain.json, '기간 파라미터가 응답을 바꿈(누적 정책 위반)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K13①②⑤: perform/detail 상시 메타(progressPct·hwStatus) + limit 클램프.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K13①: lesson_progress progressPct == round(NORM(result_score)) ∈ [0,100] — SQL 멀티셋 대조(cap 인지)', async () => {
  // [감리 R-2 fix] 과거엔 bucket=all 의 items(200 cap)를 "uncapped SQL 행수"와 비교 —
  //   content_view 대량 유입(프리뷰 사용 로그 1,400+건)으로 lesson 행이 top-200 밖으로 밀리면
  //   API 0건이 정상인데 어서션이 FAIL 하는 데이터 의존 취약. → 세그먼트 드릴(bucket=content&
  //   segment=lesson — 같은 라우트·같은 item 매핑 코드)로 lesson 행만 요청하고, SQL 미러에도
  //   라우트와 동일한 "최신순 LIMIT 200" 캡을 걸어 어느 데이터 상태에서도 결정적으로 대조한다.
  //   [2026-07-30 fix] period=30d(롤링) → LESSON_GT_Q(데이터 유도). 롤링 창이면
  //   uid3 lesson_progress 가 2026-08-01 에 창 밖으로 노화되어 L227 전제가 붕괴한다.
  const r = await req(`/perform/detail?bucket=content&segment=lesson&${LESSON_GT_Q}`, STUDENT1);
  assert.equal(r.status, 200);
  const j = r.json;
  const [from, to] = String(j.period).split(' ~ ');
  const lessonItems = j.items;
  for (const it of lessonItems) {
    assert.equal(it.segment, 'lesson', 'segment=lesson 필터 정합');
    if (it.progressPct != null) {
      assert.ok(Number.isInteger(it.progressPct) && it.progressPct >= 0 && it.progressPct <= 100,
        `progressPct 정수 0~100: ${it.progressPct}`);
    }
  }
  // SQL 기대값(동일 WHERE·동일 NORM·동일 캡: 최신순 LIMIT 200) — 멀티셋 일치
  const sqlRows = tdb.prepare(`
    SELECT (CASE WHEN result_score <= 1 THEN result_score*100 ELSE result_score END) AS norm, result_score
    FROM learning_logs
    WHERE user_id = ? AND activity_type = 'lesson_progress'
      AND DATE(created_at) >= ? AND DATE(created_at) <= ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(STUDENT1, from, to);
  assert.ok(sqlRows.length > 0, '전제: 기간 내 lesson_progress 행 존재(uid3)');
  assert.equal(lessonItems.length, sqlRows.length, 'lesson 항목 수 == SQL 행수(동일 캡 기준)');
  assert.equal(lessonItems.length, Math.min(200, j.count), 'items.length == min(200, count)');
  const expected = sqlRows.filter(x => x.result_score != null)
    .map(x => Math.max(0, Math.min(100, Math.round(Number(x.norm)))));
  const got = lessonItems.filter(it => it.progressPct != null).map(it => it.progressPct);
  assert.deepEqual(multiset(got), multiset(expected), 'progressPct 멀티셋 == round(NORM) 멀티셋');
  const nullExpected = sqlRows.filter(x => x.result_score == null).length;
  const nullGot = lessonItems.filter(it => it.progressPct == null).length;
  assert.equal(nullGot, nullExpected, 'result_score null → progressPct 생략 수 일치');
  // bucket=all 경로도 구조 검증(캡 안에 lesson 행이 있든 없든 항상 참인 계약만 — 데이터 무의존)
  const all = await req('/perform/detail?bucket=all&period=30d', STUDENT1);
  for (const it of all.json.items.filter(x => x.segment === 'lesson')) {
    assert.ok(it.progressPct == null || (Number.isInteger(it.progressPct) && it.progressPct >= 0 && it.progressPct <= 100),
      `bucket=all lesson 행 progressPct 계약: ${it.progressPct}`);
  }
});

test('INV-K13②: homework hwStatus ∈ {graded,submitted}, graded ⇔ result_score 존재', async () => {
  const r = await req('/perform/detail?bucket=homework&period=90d', STUDENT1);
  assert.equal(r.status, 200);
  const j = r.json;
  const [from, to] = String(j.period).split(' ~ ');
  for (const it of j.items) {
    assert.ok(it.hwStatus === 'graded' || it.hwStatus === 'submitted', `hwStatus enum: ${it.hwStatus}`);
  }
  // SQL 미러에도 라우트와 동일 캡(최신순 LIMIT 200) — R-2 부류(uncapped 비교) 재발 방지.
  const gradedSql = tdb.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT result_score FROM learning_logs
      WHERE user_id = ? AND activity_type = 'homework_submit'
        AND DATE(created_at) >= ? AND DATE(created_at) <= ?
      ORDER BY created_at DESC
      LIMIT 200
    ) WHERE result_score IS NOT NULL
  `).get(STUDENT1, from, to).c;
  const gradedGot = j.items.filter(it => it.hwStatus === 'graded').length;
  assert.equal(gradedGot, gradedSql, 'graded 수 == result_score 채움 행수(⇔ 계약)');
});

test('INV-K13⑤: limit=8 → items ≤ 8 · count 는 전체 불변 · 클램프(0→1, 9999→200)', async () => {
  const base = await req('/perform/detail?bucket=all&period=30d', STUDENT1);
  const lim8 = await req('/perform/detail?bucket=all&period=30d&limit=8', STUDENT1);
  assert.equal(lim8.status, 200);
  assert.ok(lim8.json.items.length <= 8, `limit=8: items ${lim8.json.items.length} ≤ 8`);
  assert.equal(lim8.json.items.length, Math.min(8, base.json.count), 'limit=8: items == min(8, 전체)');
  assert.equal(lim8.json.count, base.json.count, 'count 는 limit 무관 전체 건수');
  const lim0 = await req('/perform/detail?bucket=all&period=30d&limit=0', STUDENT1);
  assert.ok(lim0.json.items.length <= 1, 'limit=0 → 1 클램프');
  const limBig = await req('/perform/detail?bucket=all&period=30d&limit=9999', STUDENT1);
  assert.ok(limBig.json.items.length <= 200, 'limit=9999 → 200 클램프');
  assert.deepEqual(limBig.json, base.json, 'limit=9999(=CAP 클램프) == 미지정 응답');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K13③④: withClassAvg 옵트인 — 표본 가드·SQL 대조·미지정 불변·식별자 미노출.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K13③: withClassAvg=1 — classAvg 존재 ⇔ takers ≥ 5, classAvg ∈ [0,100], SQL 멀티셋 대조 (uid3: 7명 6건 통과·1명 1건 차단)', async () => {
  const r = await req(`/perform/detail?bucket=exam&${EXAM_GT_Q}&withClassAvg=1`, STUDENT1);
  assert.equal(r.status, 200);
  const j = r.json;
  const [from, to] = String(j.period).split(' ~ ');
  for (const it of j.items) {
    const hasAvg = it.classAvg !== undefined, hasTakers = it.takers !== undefined;
    assert.equal(hasAvg, hasTakers, 'classAvg·takers 동반 존재/부재');
    if (hasAvg) {
      assert.ok(it.takers >= MIN_PEERS, `takers ${it.takers} ≥ ${MIN_PEERS}(표본 가드)`);
      assert.ok(it.classAvg >= 0 && it.classAvg <= 100, `classAvg 0~100: ${it.classAvg}`);
    }
  }
  // SQL 기대값: 항목별(로그별) 같은 target_id 응시자 전원 AVG(NORM)·COUNT(DISTINCT user) — 기간 무관 전체.
  //   미러에도 라우트와 동일 캡(최신순 LIMIT 200) — R-2 부류(uncapped 비교) 재발 방지.
  const expRows = tdb.prepare(`
    SELECT me.created_at,
           (SELECT ROUND(AVG(CASE WHEN x.result_score <= 1 THEN x.result_score*100 ELSE x.result_score END), 1)
              FROM learning_logs x WHERE x.activity_type='exam_complete' AND x.target_id = me.target_id) AS avg_norm,
           (SELECT COUNT(DISTINCT x.user_id)
              FROM learning_logs x WHERE x.activity_type='exam_complete' AND x.target_id = me.target_id) AS takers
    FROM learning_logs me
    WHERE me.user_id = ? AND me.activity_type = 'exam_complete'
      AND DATE(me.created_at) >= ? AND DATE(me.created_at) <= ?
    ORDER BY me.created_at DESC
    LIMIT 200
  `).all(STUDENT1, from, to);
  const expected = expRows.map(x => (x.takers >= MIN_PEERS && x.avg_norm != null)
    ? { classAvg: x.avg_norm, takers: x.takers } : { classAvg: undefined, takers: undefined });
  const got = j.items.map(it => ({ classAvg: it.classAvg, takers: it.takers }));
  assert.equal(got.length, expected.length, 'exam 항목 수 == SQL 행수');
  assert.deepEqual(multiset(got), multiset(expected), 'classAvg·takers 멀티셋 == SQL 기대값');
  // 실측 회귀(스펙 §1-4): 응시자 7명 평가는 통과, 1명 평가는 차단 — 둘 다 존재해야 가드가 실검증됨
  //   창은 EXAM_GT_Q(데이터 유도)라 시계와 무관하게 양 케이스가 항상 창 안에 있다.
  assert.ok(got.some(x => x.takers !== undefined),
    '가드 통과 케이스 존재(응시자 ≥5) — 0이면 EXAM_GT_Q 가 롤링 창으로 되돌아갔는지 확인');
  assert.ok(got.some(x => x.takers === undefined), '가드 차단 케이스 존재(응시자 <5)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K13⑥ [회귀 박제 — 2026-07-30 사고]: GT 창의 **시계 독립성**.
//   사고: INV-K13③ 이 `period=30d`(wall-clock 롤링)를 쓰는 바람에, 근거 데이터
//         (uid3 exam_complete 2026-06-22)가 창 밖으로 노화되자 코드 변경 0 인데도
//         "가드 통과 케이스 존재" 단언이 붕괴했다(마지막 green 2026-07-16).
//   박제: 시스템 시각을 크게 밀어도 EXAM_GT_Q 응답이 **완전 동일**해야 한다.
//         누군가 EXAM_GT_Q 를 롤링 period 로 되돌리면 이 테스트가 즉시 잡는다
//         (롤링 창은 시각이 바뀌면 응답이 달라지므로 deepEqual 실패).
// ──────────────────────────────────────────────────────────────────────────
test('INV-K13⑥: GT 창 시계 독립 — 시스템 시각 +400일/-400일 이동에도 withClassAvg 응답 불변(롤링 창 회귀 방지)', async () => {
  const RealDate = global.Date;
  const shiftClock = (deltaDays) => {
    const fixed = RealDate.now() + deltaDays * 86400000;
    class FakeDate extends RealDate {
      constructor(...a) { return a.length === 0 ? super(fixed) : super(...a); }
      static now() { return fixed; }
    }
    global.Date = FakeDate;
  };
  const path = `/perform/detail?bucket=exam&${EXAM_GT_Q}&withClassAvg=1`;
  const base = await req(path, STUDENT1);
  assert.equal(base.status, 200);

  let future, past;
  try {
    shiftClock(400); future = await req(path, STUDENT1);
    global.Date = RealDate;
    shiftClock(-400); past = await req(path, STUDENT1);
  } finally { global.Date = RealDate; }

  assert.deepEqual(future.json, base.json,
    'GT 창이 시계에 의존함(+400일에서 응답 변화) — EXAM_GT_Q 가 롤링 period 로 회귀했는지 확인');
  assert.deepEqual(past.json, base.json,
    'GT 창이 시계에 의존함(-400일에서 응답 변화) — EXAM_GT_Q 가 롤링 period 로 회귀했는지 확인');
  // 비공허성: 창 안에 가드 통과·차단 양 케이스가 실제로 있어야 ③ 이 의미를 갖는다.
  const t = base.json.items.map(x => x.takers);
  assert.ok(t.some(x => x !== undefined) && t.some(x => x === undefined),
    'GT 창이 가드 통과·차단 양 케이스를 담지 못함 — 픽스처 노화(공허 통과) 감시');
});

test('INV-K13④: withClassAvg 미지정 → classAvg·takers 키 부재 + (옵트인 응답 − 두 키) == 미지정 응답 deepEqual', async () => {
  // ③ 과 동일한 시계 독립 창 — 롤링 창이면 exam 항목이 0건이 되어 공허하게 통과한다.
  const plain = await req(`/perform/detail?bucket=exam&${EXAM_GT_Q}`, STUDENT1);
  const opted = await req(`/perform/detail?bucket=exam&${EXAM_GT_Q}&withClassAvg=1`, STUDENT1);
  assert.equal(plain.status, 200); assert.equal(opted.status, 200);
  assert.ok(plain.json.items.length > 0, '비공허성: 비교할 exam 항목이 0건(픽스처 노화)');
  for (const it of plain.json.items) {
    assert.ok(!('classAvg' in it) && !('takers' in it), '미지정 응답에 classAvg/takers 키 존재(회귀)');
  }
  const stripped = JSON.parse(JSON.stringify(opted.json, (k, v) => (k === 'classAvg' || k === 'takers') ? undefined : v));
  assert.deepEqual(stripped, plain.json, '옵트인은 두 키 추가 외 응답 불변이어야');
});

test('INV-K13 키 화이트리스트: items 에 개별 학생 식별자(이름·id) 미노출', async () => {
  const ALLOWED = new Set(['title', 'date', 'score', 'sub', 'typeLabel', 'badge', 'segment',
    'progressPct', 'hwStatus', 'classAvg', 'takers']);
  const r = await req('/perform/detail?bucket=all&period=30d&withClassAvg=1', STUDENT1);
  for (const it of r.json.items) {
    for (const k of Object.keys(it)) {
      assert.ok(ALLOWED.has(k), `허용 밖 키 노출: ${k}(식별자/원시 필드 유출 감시)`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// [감리 R-1] learnOnly=1 — 학습활동 정본 7종 옵트인 필터 (routes/lrs.js L281
//   LRS_LEARN_ACTIVITY_TYPES 와 동일 기준: content_view 등 조회성 제외).
//   미지정/비-1 값 → 응답 완전 불변. count·segments·subtotals 도 필터 후 기준(표시값=내역).
// ──────────────────────────────────────────────────────────────────────────
const LEARN7 = ['lesson_progress', 'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'node_complete', 'wrong_note_retry']; // 테스트 소유 미러(이중 장부)

test('R-1①: learnOnly=1 bucket=all — content_view 0건 · count == 7종∩버킷 SQL · subtotals 합 == count', async () => {
  const r = await req('/perform/detail?bucket=all&period=30d&learnOnly=1', STUDENT1);
  assert.equal(r.status, 200);
  const j = r.json;
  const [from, to] = String(j.period).split(' ~ ');
  // ① 조회성(content_view) 항목 0건 — segment 'view'·라벨 '콘텐츠 학습' 부재
  assert.equal(j.items.filter(it => it.segment === 'view').length, 0, 'learnOnly 응답에 view(조회) 항목 잔존');
  // ② count == 7종∩all버킷 유형 SQL(테스트 독립 미러)
  // [수정 2026-07-31] 미러가 all 버킷 정의와 어긋나 있었다(테스트 자체 결함, 롤링 시드가 노출).
  //   · 잘못 포함: lesson_progress — all 버킷은 '진도'를 제외한다(INV-DRILL-c/d 가 박제한 계약).
  //   · 잘못 누락: wrong_note_retry · node_complete — all 버킷에 포함되는 유형이다.
  //   uid3 에 두 유형 로그가 0건이던 동안은 두 오류가 상쇄돼 통과했고, 재시드로 진도 7건이
  //   들어오자 기대값이 9(=진도7+평가2), 실제가 3(=평가2+오답노트1)로 갈라졌다.
  //   → routes/lrs.js PERFORM_BUCKET_TYPES.all 과 동일한 집합으로 미러를 교정한다.
  const ALL_BUCKET = ['exam_complete', 'homework_submit', 'self_learn', 'daily_complete',
    'wrong_note_retry', 'node_complete', 'content_solve'];
  const allowed = LEARN7.filter(t => ALL_BUCKET.includes(t));
  const ph = allowed.map(() => '?').join(',');
  const expected = tdb.prepare(`
    SELECT COUNT(*) c FROM learning_logs
    WHERE user_id = ? AND activity_type IN (${ph})
      AND DATE(created_at) >= ? AND DATE(created_at) <= ?
  `).get(STUDENT1, ...allowed, from, to).c;
  assert.equal(j.count, expected, `learnOnly count(${j.count}) != 7종 SQL(${expected}) — 표시값=내역`);
  assert.equal(j.items.length, Math.min(200, j.count), 'items.length == min(200, count)');
  // ③ subtotals 합 == count (필터 후 기준 일관)
  const subSum = j.subtotals.reduce((s, x) => s + x.count, 0);
  assert.equal(subSum, j.count, `learnOnly subtotals 합(${subSum}) != count(${j.count})`);
});

test('R-1②: learnOnly 미지정/비-1 값 → 응답 완전 불변(deepEqual — 기존 드릴 모달 계약 보호)', async () => {
  const plain = await req('/perform/detail?bucket=all&period=30d', STUDENT1);
  const zero = await req('/perform/detail?bucket=all&period=30d&learnOnly=0', STUDENT1);
  const junk = await req('/perform/detail?bucket=all&period=30d&learnOnly=yes', STUDENT1);
  assert.equal(plain.status, 200);
  assert.deepEqual(zero.json, plain.json, 'learnOnly=0 이 응답을 바꿈(비-1 값은 불변이어야)');
  assert.deepEqual(junk.json, plain.json, 'learnOnly=yes 가 응답을 바꿈(비-1 값은 불변이어야)');
  // 미지정 응답엔 조회성(view) 항목이 정상 포함(기존 bucket=all 계약 그대로) — 데이터 존재 시
  const viewSql = tdb.prepare(`
    SELECT COUNT(*) c FROM learning_logs
    WHERE user_id = ? AND activity_type = 'content_view'
      AND DATE(created_at) >= ? AND DATE(created_at) <= ?
  `).get(STUDENT1, ...String(plain.json.period).split(' ~ ')).c;
  if (viewSql > 0) {
    assert.ok(plain.json.count > 0 && plain.json.count >= viewSql, '미지정 count 에 조회성 포함(기존 계약)');
  }
});

test('R-1③: learnOnly=1 bucket=content — 단일유형이라 소계 미제공(계약) / segment=view → 빈 응답', async () => {
  const r = await req('/perform/detail?bucket=content&period=30d&learnOnly=1', STUDENT1);
  assert.equal(r.status, 200);
  const j = r.json;
  // [수정 2026-07-31 / 재감리 2026-07-31] 과거 `if (j.segments !== undefined)` 로 감싼 단언 3개는
  //   PERFORM_BUCKET_TYPES.content = ['content_solve'] (1원소) 때문에 라우트의 `types.length > 1`
  //   가드가 영원히 false → segments 항상 undefined → **한 번도 실행되지 않는 죽은 검사**였다.
  //   그런데 테스트 이름은 "segments == lesson·solve·합==count" 를 광고해 거짓 안심을 줬다.
  //   → 조건부 제거. 현행 계약(소계 미제공)을 무조건 단언하고, 이름도 실제 검사에 맞춘다.
  //     content 버킷에 유형이 되돌아오면 이 단언이 터져 view 배제·소계합 불변식 복원을 강제한다.
  assert.equal(j.segments, undefined,
    'content 는 단일 유형(content_solve) 버킷 → 세그먼트 소계 미제공이어야 한다 ' +
    '(소계가 부활했다면 view 배제·"소계 합 == count" 단언도 함께 되살릴 것)');
  // 7종 밖 세그먼트 명시 요청 → 빈 응답(공집합 가드 — 500/SQL 오류 없이)
  const view = await req('/perform/detail?bucket=content&period=30d&segment=view&learnOnly=1', STUDENT1);
  assert.equal(view.status, 200, 'segment=view&learnOnly=1 도 200(공집합 가드)');
  assert.equal(view.json.count, 0, '공집합 count 0');
  assert.deepEqual(view.json.items, [], '공집합 items []');
});

test('R-1④: FE 카드 호출 형태(learnOnly=1&limit=8&withClassAvg=1) — 조회성 0·items ≤ 8·count 전체·classAvg 가드 유지', async () => {
  const r = await req('/perform/detail?bucket=all&period=30d&learnOnly=1&limit=8&withClassAvg=1', STUDENT1);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.ok(j.items.length <= 8, `items ${j.items.length} ≤ 8`);
  assert.equal(j.items.filter(it => it.segment === 'view').length, 0, '카드 항목에 조회성 없음');
  const learnOnlyFull = await req('/perform/detail?bucket=all&period=30d&learnOnly=1', STUDENT1);
  assert.equal(j.count, learnOnlyFull.json.count, 'count 는 limit 무관 learnOnly 전체 건수');
  for (const it of j.items) {
    if (it.classAvg !== undefined) {
      assert.ok(it.takers >= MIN_PEERS && it.classAvg >= 0 && it.classAvg <= 100, '반평균 가드·범위 유지');
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K14(BE): 히트맵 데이터 삼중 정합 — standards 행 == matrix 파생 == distribution.
//   (teacher1 classId=2 + mteacher1 middle 시드 반 — 렌더 셀 수/드로어 검사는 스모크 소관)
// ──────────────────────────────────────────────────────────────────────────
test('INV-K14(BE): mastery/class — standards 카운트 == matrix 집계 == distribution (class 2·middle 반)', async () => {
  const cases = [ { classId: 2, as: TEACHER }, { classId: midClassId, as: mteacherId } ];
  for (const c of cases) {
    const r = await req(`/mastery/class/${c.classId}`, c.as);
    assert.equal(r.status, 200, `class ${c.classId}: HTTP 200`);
    const j = r.json;
    const dist = { reached: 0, partial: 0, not_reached: 0, insufficient: 0, total: 0 };
    for (const row of j.standards) {
      const cell = j.matrix[row.code] || {};
      const tally = { reached: 0, partial: 0, not_reached: 0, insufficient: 0 };
      for (const uid of Object.keys(cell)) tally[cell[uid].status]++;
      assert.equal(row.reached, tally.reached, `${row.code}: reached 행 != matrix`);
      assert.equal(row.partial, tally.partial, `${row.code}: partial 행 != matrix`);
      assert.equal(row.notReached, tally.not_reached, `${row.code}: notReached 행 != matrix`);
      assert.equal(row.insufficient, tally.insufficient, `${row.code}: insufficient 행 != matrix`);
      assert.equal(row.studentCount, Object.keys(cell).length, `${row.code}: studentCount != matrix 엔트리 수`);
      assert.equal(row.evaluated, tally.reached + tally.partial + tally.not_reached, `${row.code}: evaluated 정의`);
      // 행 드로어(§2-5) 근거: notReachedStudents id == matrix not_reached 엔트리
      const nrIds = (row.notReachedStudents || []).map(u => u.id).sort();
      const nrMx = Object.keys(cell).filter(uid => cell[uid].status === 'not_reached').map(Number).sort();
      assert.deepEqual(nrIds, nrMx, `${row.code}: notReachedStudents != matrix not_reached`);
      dist.reached += tally.reached; dist.partial += tally.partial;
      dist.not_reached += tally.not_reached; dist.insufficient += tally.insufficient;
      dist.total += Object.keys(cell).length;
    }
    assert.deepEqual(j.distribution, dist, `class ${c.classId}: distribution == Σ standards/matrix`);
    // 열 드로어(§2-6) 근거: 학생별 상태 카운트 합 == 그 학생 matrix 엔트리 수(총합 == distribution.total)
    let colTotal = 0;
    for (const s of j.students) {
      let cnt = 0;
      for (const code of Object.keys(j.matrix)) if (j.matrix[code][s.id]) cnt++;
      colTotal += cnt;
    }
    assert.equal(colTotal, dist.total, `class ${c.classId}: 열 파생 총합 == distribution.total`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K11′(BE): middle 시드 완전판 — 계정 자격·peer 표본·교사 히트맵 표본·델타 자산.
// ──────────────────────────────────────────────────────────────────────────
test("INV-K11′(BE): middle1 자격(비번 1234·role student·middle) + mteacher1 + 반 학생 8명", () => {
  const bcrypt = require('bcryptjs');
  const stu = tdb.prepare('SELECT * FROM users WHERE id = ?').get(MIDDLE1);
  assert.equal(stu.username, 'middle1', 'id 2040 → username middle1');
  assert.equal(stu.role, 'student'); assert.equal(stu.school_level, 'middle');
  assert.ok(bcrypt.compareSync('1234', stu.password), 'middle1 비밀번호 1234 로그인 가능');
  const t = tdb.prepare("SELECT * FROM users WHERE username = 'mteacher1'").get();
  assert.equal(t.role, 'teacher'); assert.equal(t.school_level, 'middle');
  assert.equal(t.school_name, stu.school_name, 'mteacher1 학교 == 2040 학교');
  const members = tdb.prepare(`
    SELECT COUNT(*) c FROM class_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'
  `).get(midClassId).c;
  assert.equal(members, 8, '반 학생 8명(≥ MIN_PEERS 5 + 여유)');
});

test("INV-K11′(BE): peer-compare(2040).peerCount ≥ 5 + mteacher1 mastery/class 학생 8·성취기준 >0·실명", async () => {
  const pc = await req(`/peer-compare/${MIDDLE1}`, MIDDLE1);
  assert.equal(pc.status, 200);
  assert.ok((pc.json.peerCount || 0) >= MIN_PEERS, `peerCount ${pc.json.peerCount} ≥ ${MIN_PEERS}`);
  const mc = await req(`/mastery/class/${midClassId}`, mteacherId);
  assert.equal(mc.status, 200);
  assert.equal(mc.json.students.length, 8, 'mastery/class 학생 8명');
  assert.ok(mc.json.standards.length > 0, '성취기준 > 0(히트맵 데이터 존재)');
  assert.equal(mc.json.masked, false, '담임(mteacher1)은 실명(masked=false)');
  // 권한 회귀: 비담당 교사(teacher1)가 middle 반 매트릭스 → 403 (반 경계)
  const forbidden = await req(`/mastery/class/${midClassId}`, TEACHER);
  assert.equal(forbidden.status, 403, '비담당 교사 403(반 경계 가드)');
});

test("INV-K11′(BE): P2-2 델타 자산 — middle1 withClassAvg=1 평가 항목에 classAvg 존재(응시자 ≥5 평가 보유)", async () => {
  // [2026-07-30 fix] period=90d(롤링) → MIDDLE_GT_Q(데이터 유도).
  const r = await req(`/perform/detail?bucket=exam&${MIDDLE_GT_Q}&withClassAvg=1`, MIDDLE1);
  assert.equal(r.status, 200);
  const withAvg = r.json.items.filter(it => it.classAvg !== undefined);
  assert.ok(withAvg.length > 0, `middle1 평가 중 classAvg 부착 ${withAvg.length}건 > 0(델타 칩 실검증 가능)`);
  for (const it of withAvg) {
    assert.ok(it.takers >= MIN_PEERS && it.classAvg >= 0 && it.classAvg <= 100, '가드·범위 계약');
  }
});
