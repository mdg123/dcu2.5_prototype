// test/lrs-a4-population.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [A4 / D2] 성취 모집단 정합 — B-1(관측·시도 2단 분리) + B-3(약점표 mastery SSOT 흡수)
//   기획서: 보고서/LRS_A4_성취모집단_정합_UI_기획_v1.md §4-5 (INV-A4-1~8)
//
// ■ 이 파일이 지키는 결함 부류
//   ① **셀 소멸** — 학생이 실제로 푼 성취기준이 화면에서 통째로 사라진다.
//      (W2-a 가 유령 행을 지울 때 "판정 분모"와 "칸의 존재"를 한 술어로 묶어버린 부작용.
//       실측 2026-08-04: student1 19개 코드 중 7개 소멸 — 전부 오늘의 학습(daily_complete).
//       정본사전 §1-B 가 이미 "daily_complete 는 result_success 가 항상 NULL" 이라 경고한 유형.)
//   ② **한 코드가 두 화면에서 반대말을 함** — 성취수준 화면은 "도달(5/5)",
//      스스로채움 약점표는 "보완 필요(0/1)". 같은 학생·같은 성취기준인데.
//      (약점표가 learning_logs 를 자체 GROUP BY 로 다시 세고 있었다.)
//   ③ **되살리기의 부작용** — 배제해야 할 조회·진도·게시글·출석 셀이 함께 유입되면
//      회색 셀이 수만 개 쏟아져 도넛이 회색 덩어리가 된다(실측 17,355~22,735셀).
//   ④ **도달률 회귀** — ①을 고치면서 A1~A3 수치가 흔들리면 그건 고친 게 아니라 부순 것이다.
//
// ■ 이중장부 원칙 (W2 감리 지적 계승)
//   술어를 lib/lrs/mastery-population 에서 import 하지 **않고** 아래에 손으로 다시 적는다.
//   검사 대상과 같은 SSOT 를 import 하면 SSOT 가 통째로 틀어져도 양쪽이 사이좋게 틀려 초록이 된다.
//
// ■ GT 원칙
//   "현재 출력을 베낀 숫자"를 단언하지 않는다. 모든 기대값은
//   (a) 테스트가 직접 심은 분자/분모, 또는 (b) 손으로 적은 술어에서 SQL 로 재유도한다.
//   기간 창은 fixtureWindow(데이터에서 유도)만 쓴다 — 롤링 창 위 고정 GT 금지(2026-07-30 사고).
//
// DB 격리: 실 DB → 임시 복사본(_setup). 정본 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb, fixtureWindow } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');
const { rebuildAllAggregates } = require('../db/lrs-aggregate');
const { logLearningActivity } = require('../db/learning-log-helper');

const STUDENT1 = 3; // 실 DB 확정 픽스처(소멸 7셀의 당사자)
const MIN_ATTEMPTS_2ND = 3; // 손으로 적은 판정 최소 시도(db/lrs-mastery MIN_ATTEMPTS 의 독립 사본)

// ── 손으로 적은 장부 ① 채점형 유형(lib/lrs/score-scale SCORED_TYPES 의 독립 사본) ──────
const SCORED_TYPES_2ND = [
  'exam_complete', 'homework_submit', 'content_solve', 'self_learn', 'daily_complete',
  'wrong_note_retry', 'node_complete', 'content_complete', 'problem_attempt',
];
const SCORED_SQL_2ND = SCORED_TYPES_2ND.map(t => `'${t}'`).join(',');
// ── 손으로 적은 장부 ② 관측(observed) — "칸이 화면에 존재하는가" ────────────────────
const OBSERVED_WHERE_2ND =
  `achievement_code IS NOT NULL AND achievement_code != '' AND activity_type IN (${SCORED_SQL_2ND})`;
// ── 손으로 적은 장부 ③ 시도(attempt) — "도달 판정의 분모인가" ★ 정의 불변 ──────────
const ATTEMPT_WHERE_2ND = `${OBSERVED_WHERE_2ND} AND result_success IS NOT NULL`;
// ── 손으로 적은 장부 ④ 상태 분류기(db/lrs-mastery classifyStatus 의 독립 사본) ────────
function classify2nd(attempts, success, avgScore) {
  const a = Number(attempts) || 0;
  if (a < MIN_ATTEMPTS_2ND) return 'insufficient';
  let rate;
  if (Number.isFinite(Number(success))) rate = (Number(success) / a) * 100;
  else if (avgScore != null && Number.isFinite(Number(avgScore))) {
    rate = Number(avgScore) > 1 ? Number(avgScore) : Number(avgScore) * 100;
  } else return 'insufficient';
  if (rate >= 80) return 'reached';
  if (rate >= 50) return 'partial';
  return 'not_reached';
}

// 비학습형(성취 칸을 만들면 안 되는 유형) — 정본사전 §1-C C1 제외 대상
const NON_LEARNING_TYPES = ['content_view', 'lesson_progress', 'post_create', 'attendance_checkin'];

let db, server, baseUrl, GT_WINDOW_Q;

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
function get(path, userId) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
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
  db = openTestDb();
  // 정본 DB 사본은 아직 A4 재집계 전일 수 있다. 이 파일의 모든 단언은 **재집계 후 상태**를
  // 대상으로 하므로, 사본 위에서 한 번 재집계해 정본 DB 의 재집계 시점에 의존하지 않게 한다.
  rebuildAllAggregates();
  const w = fixtureWindow(db, { userId: STUDENT1 });
  GT_WINDOW_Q = `from=${w.from}&to=${w.to}`;
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ════════════════════════════════════════════════════════════════════════════
// INV-A4-3  셀 소멸 금지 — 채점형 로그가 1건이라도 있으면 칸은 반드시 존재한다
// ════════════════════════════════════════════════════════════════════════════
test('[INV-A4-3①] 관측 술어를 통과한 (학생×성취기준) 은 하나도 빠짐없이 집계에 존재', () => {
  const missing = db.prepare(`
    WITH obs AS (
      SELECT DISTINCT user_id u, achievement_code c
      FROM learning_logs WHERE ${OBSERVED_WHERE_2ND}
    )
    SELECT obs.u, obs.c FROM obs
    WHERE NOT EXISTS (
      SELECT 1 FROM lrs_achievement_stats s
      WHERE s.user_id = obs.u AND s.achievement_code = obs.c
    )
    LIMIT 20
  `).all();
  assert.deepEqual(missing, [],
    `채점형 학습 기록이 있는데 성취 칸이 사라진 (학생×성취기준) ${missing.length}건 — ` +
    `학생이 실제로 한 학습이 화면에서 존재 자체가 지워진다`);
});

test('[INV-A4-3②] 판정 자료가 0건인 칸도 사라지지 않는다 — 전제(그런 칸이 실재)를 함께 검사', () => {
  // ③구간: 채점형 로그는 있으나 정오 판정이 전량 없는 (학생×성취기준).
  //   이 그룹이 0건이면 이 불변식은 무의미해진다 → 전제부터 검사한다.
  const zeroJudged = db.prepare(`
    SELECT user_id u, achievement_code c
    FROM learning_logs
    WHERE ${OBSERVED_WHERE_2ND}
    GROUP BY user_id, achievement_code
    HAVING SUM(CASE WHEN result_success IS NOT NULL THEN 1 ELSE 0 END) = 0
  `).all();
  assert.ok(zeroJudged.length > 0,
    '전제 붕괴: "채점형 로그는 있는데 정오 판정이 0건" 인 칸이 실 DB 에 하나도 없다. ' +
    '픽스처가 사라졌다면 이 불변식은 아무것도 지키지 못한다.');

  const rows = db.prepare(
    `SELECT user_id u, achievement_code c, attempt_count a, level lv FROM lrs_achievement_stats`
  ).all();
  const byKey = new Map(rows.map(r => [`${r.u}|${r.c}`, r]));
  const bad = [];
  for (const z of zeroJudged) {
    const r = byKey.get(`${z.u}|${z.c}`);
    if (!r) { bad.push(`${z.u}|${z.c} 칸 없음`); continue; }
    if ((r.a || 0) !== 0) bad.push(`${z.u}|${z.c} attempt_count=${r.a} (판정 자료 0건인데 시도가 있다)`);
    if (r.lv !== 'insufficient') bad.push(`${z.u}|${z.c} level=${r.lv} (평가 부족이어야 한다)`);
  }
  assert.deepEqual(bad.slice(0, 20), [],
    `판정 자료 0건인 칸 ${zeroJudged.length}개 중 ${bad.length}건 위반 — ` +
    `"안 해본 것"과 "판정할 자료가 아직 없는 것"을 구분하지 못하고 있다`);
});

test('[INV-A4-3③] student1 의 소멸 코드가 mastery API 응답에 회색(평가부족)으로 복원돼 있다', async () => {
  // GT 는 코드 목록을 하드코딩하지 않고 손으로 적은 술어로 실 DB 에서 재유도한다.
  const expected = db.prepare(`
    SELECT achievement_code c
    FROM learning_logs
    WHERE user_id = ? AND ${OBSERVED_WHERE_2ND}
    GROUP BY achievement_code
    HAVING SUM(CASE WHEN result_success IS NOT NULL THEN 1 ELSE 0 END) = 0
    ORDER BY achievement_code
  `).all(STUDENT1).map(r => r.c);
  assert.ok(expected.length > 0, '전제 붕괴: student1 에 판정 자료 0건 코드가 없다');

  const res = await get(`/api/lrs/mastery/student/${STUDENT1}`, STUDENT1);
  assert.equal(res.status, 200);
  const byCode = new Map((res.json.standards || []).map(s => [s.code, s]));
  const bad = [];
  for (const c of expected) {
    const s = byCode.get(c);
    if (!s) { bad.push(`${c} — standards[] 에 없음(소멸)`); continue; }
    if (s.status !== 'insufficient') bad.push(`${c} — status=${s.status} (평가부족이어야)`);
    if ((s.attempts || 0) !== 0) bad.push(`${c} — attempts=${s.attempts} (0이어야)`);
    if (s.rate != null) bad.push(`${c} — rate=${s.rate} (판정 자료가 없으므로 null 이어야)`);
  }
  assert.deepEqual(bad, [],
    `student1 의 판정자료 0건 코드 ${expected.length}개 중 ${bad.length}건이 화면에서 사라졌거나 오분류`);
});

// ════════════════════════════════════════════════════════════════════════════
// INV-A4-6  비학습형 배제 — 조회·진도·게시글·출석만 있는 칸은 절대 유입되지 않는다
//   (이 방벽이 뚫리면 회색 셀이 수만 개 쏟아져 도넛이 회색 덩어리가 된다)
// ════════════════════════════════════════════════════════════════════════════
test('[INV-A4-6①] 채점형 로그가 한 건도 없는 (학생×성취기준) 은 집계에 존재하지 않는다', () => {
  const intruders = db.prepare(`
    SELECT s.user_id u, s.achievement_code c FROM lrs_achievement_stats s
    WHERE NOT EXISTS (
      SELECT 1 FROM learning_logs l
      WHERE l.user_id = s.user_id AND l.achievement_code = s.achievement_code
        AND l.activity_type IN (${SCORED_SQL_2ND})
    )
    LIMIT 20
  `).all();
  assert.deepEqual(intruders, [],
    `비채점형(조회·진도·게시글·출석)만 있는 칸 ${intruders.length}건이 성취 집계에 유입됐다 — ` +
    `관측 술어가 채점형 화이트리스트를 잃었다는 뜻`);
});

test('[INV-A4-6②] 비학습형 로그를 아무리 넣어도 새 성취 칸이 생기지 않는다 (실시간·재집계 양쪽)', () => {
  const CODE = '[9A4-06-NONLEARN]'; // 실 데이터 무간섭 합성 코드
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').run(STUDENT1, CODE);
  const exists = () => db.prepare(
    'SELECT COUNT(*) n FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?'
  ).get(STUDENT1, CODE).n;
  assert.equal(exists(), 0, '전제: 합성 코드 칸이 없어야 한다');

  NON_LEARNING_TYPES.forEach((t, i) => {
    for (let k = 0; k < 5; k++) {
      logLearningActivity({
        userId: STUDENT1, activityType: t, targetType: 'content', targetId: 970000 + i * 10 + k,
        achievementCode: CODE, verb: 'accessed', sourceService: 'content',
        resultScore: t === 'lesson_progress' ? 0.9 : null, resultSuccess: null,
      });
    }
  });
  assert.equal(exists(), 0,
    `비학습형 ${NON_LEARNING_TYPES.length * 5}건 주입 후 성취 칸이 생겼다 — 실시간 경로 방벽 붕괴`);

  rebuildAllAggregates();
  assert.equal(exists(), 0,
    `재집계 후 비학습형만 있는 칸이 생겼다 — 재집계 경로 방벽 붕괴(회색 셀 수만 개 유입 위험)`);

  // 같은 재집계 결과 위에서 ①의 전수 조건도 다시 성립해야 한다(주입이 다른 코드로 새지 않았는가).
  const intruders = db.prepare(`
    SELECT COUNT(*) n FROM lrs_achievement_stats s
    WHERE NOT EXISTS (
      SELECT 1 FROM learning_logs l
      WHERE l.user_id = s.user_id AND l.achievement_code = s.achievement_code
        AND l.activity_type IN (${SCORED_SQL_2ND})
    )
  `).get().n;
  assert.equal(intruders, 0, `재집계 후 비채점형 전용 칸 ${intruders}건`);
});

// ════════════════════════════════════════════════════════════════════════════
// INV-A4-4  도달률 회귀 0 — 관측 전용 칸은 A1~A3 의 분자·분모에 절대 들어가지 않는다
// ════════════════════════════════════════════════════════════════════════════
test('[INV-A4-4①] 도달률 분자·분모가 저장값·원천로그 두 경로에서 칸 단위로 동일 (분모 오염 0)', () => {
  // 저장 경로: lrs_achievement_stats 의 attempt/success 를 그대로 쓴다.
  const stored = new Map(db.prepare(
    'SELECT user_id u, achievement_code c, attempt_count a, success_count s FROM lrs_achievement_stats'
  ).all().map(r => [`${r.u}|${r.c}`, r]));
  // 원천 경로: learning_logs 를 손으로 적은 **시도** 술어로 직접 집계.
  const raw = db.prepare(`
    SELECT user_id u, achievement_code c,
           SUM(CASE WHEN result_success IS NOT NULL THEN 1 ELSE 0 END) a,
           SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) s
    FROM learning_logs WHERE ${ATTEMPT_WHERE_2ND}
    GROUP BY user_id, achievement_code
  `).all();
  assert.ok(raw.length > 0, '전제 붕괴: 시도 술어를 통과한 칸이 0개');

  // ① 칸 단위 분자·분모 일치 — 관측 전용 행이 분모에 한 건이라도 새면 여기서 잡힌다.
  const diffs = [];
  for (const r of raw) {
    const st = stored.get(`${r.u}|${r.c}`);
    if (!st) { diffs.push(`${r.u}|${r.c} 저장 칸 없음`); continue; }
    if ((st.a || 0) !== r.a) diffs.push(`${r.u}|${r.c} attempt 저장=${st.a} 원천=${r.a}`);
    if ((st.s || 0) !== r.s) diffs.push(`${r.u}|${r.c} success 저장=${st.s} 원천=${r.s}`);
  }
  // ② 반대 방향 — 원천에 시도가 0인 칸이 저장에서 시도를 갖고 있으면 안 된다.
  const rawKeys = new Set(raw.map(r => `${r.u}|${r.c}`));
  for (const [k, st] of stored) {
    if (!rawKeys.has(k) && (st.a || 0) !== 0) diffs.push(`${k} 원천 시도 0인데 저장 attempt=${st.a}`);
  }
  assert.deepEqual(diffs.slice(0, 20), [],
    `도달률의 분자·분모가 저장·원천 두 경로에서 갈라진 ${diffs.length}칸 — ` +
    `관측(observed) 행이 판정(attempt) 분모로 샜다는 뜻`);

  // ③ 총계 도달률도 함께(사람이 읽는 수치 레벨의 회귀 감시)
  let evStored = 0, rcStored = 0;
  for (const st of stored.values()) {
    const s = classify2nd(st.a, st.s, null);
    if (s === 'insufficient') continue;
    evStored++; if (s === 'reached') rcStored++;
  }
  let evRaw = 0, rcRaw = 0;
  for (const r of raw) {
    const s = classify2nd(r.a, r.s, null);
    if (s === 'insufficient') continue;
    evRaw++; if (s === 'reached') rcRaw++;
  }
  assert.ok(evStored > 0, '전제 붕괴: 평가충분 칸이 0개');
  assert.deepEqual({ evaluated: evStored, reached: rcStored }, { evaluated: evRaw, reached: rcRaw },
    '집계 저장값과 원천 로그의 도달률 모집단이 갈라졌다');
});

test('[INV-A4-4②] 판정 없는 채점형 학습을 새로 넣어도 도달률·기존 칸 판정이 한 글자도 안 바뀐다', async () => {
  const snapshot = async () => {
    const r = await get(`/api/lrs/mastery/student/${STUDENT1}`, STUDENT1);
    assert.equal(r.status, 200);
    const st = r.json.standards || [];
    return {
      counts: r.json.counts,
      // 평가된 칸(=도달률 분모)의 판정 튜플 전량
      evaluated: st.filter(s => s.status !== 'insufficient')
        .map(s => `${s.code}|${s.attempts}|${s.correct}|${s.rate}|${s.status}`).sort(),
    };
  };
  const before = await snapshot();
  assert.ok(before.evaluated.length > 0, '전제 붕괴: student1 에 평가충분 칸이 없다');

  // (a) 이미 '도달'로 판정된 칸에 정오 판정 없는 채점형 학습 1건을 얹는다.
  const reachedCode = (await get(`/api/lrs/mastery/student/${STUDENT1}`, STUDENT1))
    .json.standards.find(s => s.status === 'reached').code;
  // (b) 아예 새 코드로도 1건 — 새 회색 칸이 하나 늘어야 한다.
  const NEW_CODE = '[9A4-04-UNJUDGED]';
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id=? AND achievement_code=?').run(STUDENT1, NEW_CODE);

  for (const code of [reachedCode, NEW_CODE]) {
    logLearningActivity({
      userId: STUDENT1, activityType: 'daily_complete', targetType: 'daily_learning',
      targetId: 9410000 + (code === NEW_CODE ? 1 : 0), verb: 'completed', sourceService: 'self-learn',
      resultScore: 0.9, resultSuccess: null, achievementCode: code, subjectCode: 'math-e',
    });
  }

  const after = await snapshot();
  assert.deepEqual(after.evaluated, before.evaluated,
    '정오 판정 없는 학습 1건이 기존 평가충분 칸의 판정을 바꿨다 — 도달률 회귀');
  assert.equal(after.counts.reached, before.counts.reached, '도달 수가 변했다');
  assert.equal(after.counts.partial, before.counts.partial, '부분도달 수가 변했다');
  assert.equal(after.counts.notReached, before.counts.notReached, '미도달 수가 변했다');
  assert.equal(after.counts.insufficient, before.counts.insufficient + 1,
    '판정 자료가 없는 새 학습이 회색 칸으로 되살아나지 않았다(소멸 재발)');
});

// ════════════════════════════════════════════════════════════════════════════
// INV-A4-1 / INV-A4-2  상태 SSOT 단일화 — 같은 코드가 두 화면에서 반대말을 하지 않는다
// ════════════════════════════════════════════════════════════════════════════
// 검사 대상 학생: student1(GT 앵커) + 비도달 성취 행을 가진 실계정 학생 몇 명.
function sampleStudents() {
  const rows = db.prepare(`
    SELECT s.user_id id FROM lrs_achievement_stats s JOIN users u ON u.id = s.user_id
    WHERE u.role = 'student'
    GROUP BY s.user_id
    HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC LIMIT 4
  `).all().map(r => r.id);
  return [...new Set([STUDENT1, ...rows])];
}

test('[INV-A4-1] 약점표 status == 성취수준 status (전건 일치, 기간 무관)', async () => {
  const students = sampleStudents();
  assert.ok(students.length >= 1, '전제 붕괴: 검사 대상 학생 없음');
  const mismatches = [];
  let compared = 0;
  for (const uid of students) {
    const m = await get(`/api/lrs/mastery/student/${uid}`, uid);
    assert.equal(m.status, 200, `mastery/student/${uid} http=${m.status}`);
    const byCode = new Map((m.json.standards || []).map(s => [s.code, s.status]));
    for (const q of ['period=30d', 'period=90d', GT_WINDOW_Q]) {
      const c = await get(`/api/lrs/stats/custom?scope=mine&${q}`, uid);
      assert.equal(c.status, 200, `stats/custom(${q}) http=${c.status}`);
      for (const t of (c.json.weakTargets || [])) {
        compared++;
        const ms = byCode.get(t.achievement_code);
        if (ms === undefined) {
          mismatches.push(`uid${uid} ${q} ${t.achievement_code}: 약점표=${t.status} / 성취수준에 칸 없음`);
        } else if (ms !== t.status) {
          mismatches.push(`uid${uid} ${q} ${t.achievement_code}: 약점표=${t.status} / 성취수준=${ms}`);
        }
      }
    }
  }
  assert.ok(compared > 0, '전제 붕괴: 대조한 (학생×코드) 가 0건 — 약점표가 전부 비어 검사가 무의미');
  assert.deepEqual(mismatches.slice(0, 20), [],
    `두 화면의 성취 판정이 갈라진 ${mismatches.length}건 — 약점표가 자체 산식을 되찾았다는 뜻`);
});

test('[INV-A4-2] 도달한 성취기준은 어떤 기간·스코프에서도 약점 목록에 없다', async () => {
  const students = sampleStudents();
  const leaks = [];
  for (const uid of students) {
    const m = await get(`/api/lrs/mastery/student/${uid}`, uid);
    const reached = new Set((m.json.standards || []).filter(s => s.status === 'reached').map(s => s.code));
    for (const q of ['period=30d', 'period=90d', GT_WINDOW_Q]) {
      const c = await get(`/api/lrs/stats/custom?scope=mine&${q}`, uid);
      for (const t of (c.json.weakTargets || [])) {
        if (reached.has(t.achievement_code)) leaks.push(`uid${uid} ${q} ${t.achievement_code}`);
        if (t.status === 'reached') leaks.push(`uid${uid} ${q} ${t.achievement_code} status=reached`);
      }
    }
  }
  assert.deepEqual(leaks.slice(0, 20), [],
    `도달한 성취기준이 "보완이 필요한 성취기준" 으로 등재된 ${leaks.length}건`);
});

test('[INV-A4-2b] 교사 스코프 약점표도 성취 SSOT 를 그대로 풀링한 값이다', async () => {
  // 교사 스코프는 여러 학생을 코드별로 합산하므로 개인 mastery 와 1:1 대조할 수 없다.
  // → SSOT(lrs_achievement_stats)에서 **손으로 다시 풀링**해 응답과 대조한다.
  //   응답이 learning_logs 를 다시 세고 있다면 여기서 즉시 갈라진다.
  const teacher = db.prepare(
    "SELECT id FROM users WHERE role='teacher' AND id IN (SELECT owner_id FROM classes) LIMIT 1"
  ).get();
  assert.ok(teacher, '전제 붕괴: 반을 소유한 교사 계정이 없다');
  const memberIds = db.prepare(`
    SELECT DISTINCT cm.user_id id FROM class_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.class_id IN (SELECT id FROM classes WHERE owner_id = ?) AND u.role = 'student'
  `).all(teacher.id).map(r => r.id);
  assert.ok(memberIds.length > 0, '전제 붕괴: 교사 소유 반에 학생 멤버가 없다');

  const ph = memberIds.map(() => '?').join(',');
  const pooled = new Map(db.prepare(`
    SELECT achievement_code c, SUM(attempt_count) a, SUM(success_count) s,
           SUM(CASE WHEN avg_score IS NOT NULL THEN avg_score * attempt_count END)
             / NULLIF(SUM(CASE WHEN avg_score IS NOT NULL THEN attempt_count END), 0) v
    FROM lrs_achievement_stats
    WHERE user_id IN (${ph}) AND achievement_code IS NOT NULL AND achievement_code != ''
    GROUP BY achievement_code
  `).all(...memberIds).map(r => [r.c, r]));

  const c = await get(`/api/lrs/stats/custom?scope=class&${GT_WINDOW_Q}`, teacher.id);
  assert.equal(c.status, 200);
  const list = c.json.weakTargets || [];
  assert.ok(list.length > 0, '전제 붕괴: 교사 약점표가 비어 대조 불가');
  const bad = [];
  for (const t of list) {
    if (t.status === 'reached') { bad.push(`${t.achievement_code} status=reached (도달은 약점이 아니다)`); continue; }
    const p = pooled.get(t.achievement_code);
    if (!p) { bad.push(`${t.achievement_code} — SSOT 에 없는 코드가 등재됨`); continue; }
    const expected = classify2nd(p.a, p.s, p.v);
    if (expected !== t.status) bad.push(`${t.achievement_code}: 응답=${t.status} / SSOT 풀링=${expected}`);
    if ((p.a || 0) !== t.attempts) bad.push(`${t.achievement_code}: attempts 응답=${t.attempts} / SSOT=${p.a}`);
    if ((p.s || 0) !== t.successCount) bad.push(`${t.achievement_code}: successCount 응답=${t.successCount} / SSOT=${p.s}`);
  }
  assert.deepEqual(bad.slice(0, 20), [],
    `교사 약점표 ${list.length}건 중 ${bad.length}건이 성취 SSOT 와 어긋난다`);
});

test('[INV-A4-2c] 약점표의 판정 축은 누적 — 기간 칩을 바꿔도 status·attempts 가 흔들리지 않는다', async () => {
  // 기간 창은 "이 기간 연습(periodPracticeCount)" 에만 영향을 주어야 한다.
  //   (과거 결함: 기간 창 안의 self-learn 로그만으로 도달/미도달을 자체 판정 → 창이 판정을 바꿨다)
  const pick = (json) => (json.weakTargets || [])
    .map(t => `${t.achievement_code}|${t.status}|${t.attempts}|${t.successCount}`).sort();
  const a = await get(`/api/lrs/stats/custom?scope=mine&period=30d`, STUDENT1);
  const b = await get(`/api/lrs/stats/custom?scope=mine&${GT_WINDOW_Q}`, STUDENT1);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.ok(pick(a.json).length > 0, '전제 붕괴: student1 약점표가 비어 비교 불가');
  assert.deepEqual(pick(a.json), pick(b.json),
    '기간 칩이 성취 판정을 바꿨다 — 약점표가 다시 기간 창으로 자체 판정하고 있다');

  // 반대로 기간 연습량은 기간에 따라 달라질 수 있어야 한다(판정과 분리돼 있다는 증거).
  const has = (j) => (j.weakTargets || []).every(t => typeof t.periodPracticeCount === 'number');
  assert.ok(has(a.json) && has(b.json), 'periodPracticeCount 필드가 없다 — 연습량이 판정과 분리되지 않았다');
});
