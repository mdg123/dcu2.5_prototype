// test/lrs-keris-p0.test.js
// ─────────────────────────────────────────────────────────────────────────────
// KERIS 벤치마킹 P0 하네스 (BE 소관 불변식 박제)
//   기획서: 작업지시서/LRS_개선로드맵_KERIS벤치마킹.md §3 P0-1·P0-2·P0-4, §6 INV-K1~K3·K5
//
//   INV-K1  재풀이 N·M = 실데이터. wrong_note_retry 3건(성공2·실패1, 문항 2개) 시드 →
//           /retry-growth questions=2·succeeded=1·retryRate=50.
//           result_score 만 있고 result_success 없는 행은 N·M·attempts 미포함.
//   INV-K2  재풀이 값 경계: M ≤ N, attempts ≥ N, 0 ≤ retryRate ≤ 100, N=0 → retryRate === null.
//   INV-K1' 재풀이 API = learning_logs 직접 SQL(동일 창·동일 산식) 전수 일치 (uid3·uid4 × 기간).
//   DRILL   /perform/detail?activityType=wrong_note_retry — count == N == items.length,
//           문항 식별(wrongId·title≤40자·success·date), score=null, "틀림" 어휘 0.
//   INV-K3  추천 카드 계약: recommendations ≤ 3, priority enum·중복 없음, estMinutes 정수 5~60,
//           reasonText 비어있지 않음·템플릿 변수 잔존 없음, code 는 weaknesses∪strengths 실존.
//           + uid3 ground-truth(①[4수03-10] 시급 ②[4국01-01] 권장 ③[4수03-09] 선택).
//           + 정답률 100%·평가부족 행은 "아직 N번밖에…" 이유 문구로 자명(기획서 §3 P0-2 ② 해소).
//   INV-K5(BE) /stats/daily byHour — 24칸·0~23시·합계 = 7종 화이트리스트 기간 내 실데이터.
//   P0-3(BE 확인) auth findUserById 가 school_level 을 노출(auth/me 경유 — BE 추가 작업 0 검증).
//   PERM    retry-growth·activityType 드릴: 학생 본인만(타 학생 403), 교사/관리자 200.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb, fixtureWindow } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const PERIODS = ['7d', '30d', '90d'];
const LEARN7 = [
  'lesson_progress', 'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'node_complete', 'wrong_note_retry'
];

// ── HTTP 하네스 (lrs-perform-detail.test.js 와 동일 패턴) ────────────────────
let server, baseUrl, tdb, SEED_UID, HEAT_TS, HEAT_GT_Q, RECO_UID;
// REG-K3/K3b 픽스처 성취기준 코드(실 데이터와 충돌하지 않는 대역)
const RECO_URGENT_CODE = '[4수96-01]';
const RECO_RECOMMEND_CODE = '[4수96-02]';
const RECO_OPTIONAL_CODE = '[4수96-03]';
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

// resolvePeriod(routes/lrs.js) 와 동일한 창 계산(미러) — 실데이터 대조용.
function periodWindow(nDays) {
  const toIso = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - nDays);
  return { from: toIso(start), to: toIso(today) };
}

before(async () => {
  tdb = openTestDb();
  // INV-K1 시드: 신규 학생 + wrong_note_retry 로그.
  //   문항 t-q1: 성공 2회 / 문항 t-q2: 실패 1회  → N=2, M=1, attempts=3, retryRate=50
  //   문항 t-q3: result_score 만 있고 result_success 없음 → 어디에도 미포함(N·M·attempts 불변)
  const info = tdb.prepare(
    "INSERT INTO users (username, password, display_name, role) VALUES ('t_retry_seed', 'x', '재풀이시드', 'student')"
  ).run();
  SEED_UID = Number(info.lastInsertRowid);
  const ins = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, target_id, result_success, result_score, created_at)
    VALUES (?, 'wrong_note_retry', 'attempted', ?, ?, ?, datetime('now'))
  `);
  ins.run(SEED_UID, 't-q1', 1, null);
  ins.run(SEED_UID, 't-q1', 1, null);
  ins.run(SEED_UID, 't-q2', 0, null);
  ins.run(SEED_UID, 't-q3', null, 80); // score-only 행 — 미포함 검증용

  // ── 히트맵 드릴다운(heatmap-cell) 시드 ──
  //   teacher1(uid2) 이 소유한 class 2 의 student member(uid3) 활동을 특정 (dow,hour) 칸에 심는다.
  //   demo_* 는 히트맵/드릴 모두에서 제외돼야 하므로 같은 칸에 1건 심어 '제외 정합' 확인.
  //   created_at 은 '주중 정오'로 고정(HEAT_DOW·HEAT_HOUR) — strftime localtime 기준 칸 귀속.
  const insHm = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, target_id, source_service, created_at)
    VALUES (?, ?, 'completed', ?, ?, ?)
  `);
  // 최근 화요일(dow=2) 10:30 로컬. 90d 창 안에 들도록 today 기준 최근 화요일 계산.
  const now = new Date();
  const back = (now.getDay() - 2 + 7) % 7 || 7;          // 오늘이 화면 7일 전 화요일(항상 과거·창 안)
  const tue = new Date(now); tue.setDate(now.getDate() - back); tue.setHours(10, 30, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  const tueLocal = `${tue.getFullYear()}-${pad(tue.getMonth()+1)}-${pad(tue.getDate())} 10:30:00`;
  HEAT_TS = tueLocal;
  insHm.run(3, 'content_solve', 'c-hm1', 'content', tueLocal);         // 실데이터(포함)
  insHm.run(3, 'exam_complete', 'e-hm1', 'exam', tueLocal);           // 실데이터(포함)
  insHm.run(4, 'homework_submit', 'h-hm1', 'homework', tueLocal);     // 실데이터(포함·다른 학생)
  insHm.run(3, 'content_view', 'c-hm2', 'demo_seed', tueLocal);       // demo_* → 히트맵/드릴 모두 제외

  // ── REG-K3/K3b 추천 우선순위 픽스처 ────────────────────────────────────────
  //   [2026-08-04 GT 재작성] 이전 GT 는 uid3 의 실 시드 스냅샷
  //   (①[4수03-10] ②[4국01-01] ③[4수03-09])을 상수로 박아뒀다. 원시 로그 대조 결과
  //   ①② 는 **정오 판정 로그가 0건**(콘텐츠 조회·이수형뿐)인데 무필터 COUNT(*) 가
  //   분모로 들어가 '시도 N · 정답 0 → 0% → 미도달' 로 만들어진 허깨비였다.
  //   W2-a 로 분모가 정화되자 근거가 증발했다(uid3 의 진짜 미도달은 0건).
  //   → 세 우선순위가 **모두 존재하는** 상황을 테스트가 직접 만들어 선정 규칙 자체를 박제한다.
  //      숫자는 전부 테스트가 정한 분자/분모에서 유도되므로 시드가 바뀌어도 흔들리지 않는다.
  //        A 시도4·정답1 → 25% (<50, att≥3) ⇒ 미도달·채점  → ① 시급
  //        B 시도2·정답2 → att<3            ⇒ 평가부족·채점 → ② 권장  (평균 100 → REG-K3b 겸용)
  //        C 시도5·정답5 → 100% (att≥3)     ⇒ 도달          → ③ 선택(강점 심화)
  {
    const { logLearningActivity } = require('../db/learning-log-helper');
    RECO_UID = Number(tdb.prepare(
      "INSERT INTO users (username, password, display_name, role) VALUES ('t_reco_seed', 'x', '추천선정시드', 'student')"
    ).run().lastInsertRowid);
    const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) + ' 10:00:00'; };
    const put = (code, success, seq) => logLearningActivity({
      userId: RECO_UID, activityType: 'exam_complete', targetType: 'exam', targetId: 9800000 + seq,
      verb: 'completed', sourceService: 'exam', resultScore: success ? 1 : 0, resultSuccess: success,
      achievementCode: code, subjectCode: 'math-e', createdAt: ago(2),
    });
    [0, 0, 0, 1].forEach((s, i) => put(RECO_URGENT_CODE, s, i));        // 1/4 = 25%  → 미도달
    [1, 1].forEach((s, i) => put(RECO_RECOMMEND_CODE, s, 10 + i));      // 2/2, att<3 → 평가부족(평균 100)
    [1, 1, 1, 1, 1].forEach((s, i) => put(RECO_OPTIONAL_CODE, s, 20 + i)); // 5/5      → 도달(강점)
  }

  // ── HEAT_GT_Q: INV-HC2 용 시계 독립 창 (2026-07-30 시한폭탄 fix) ────────────
  //   INV-HC2 의 total>=3 은 사실상 **실 DB 고정 데이터**(class 2 의 화요일 10시 칸)에
  //   기대고 있다(위 시드는 localtime 변환으로 다른 시각 칸에 귀속). 롤링 90일 창이라
  //   실측상 2026-09-30 경 그 칸이 0건이 되어 전제가 붕괴한다(카나리아 45일에서 재현).
  //   창을 learning_logs 전 구간(시드 포함 — 이 시점 이후 계산)에서 유도해 결정화.
  {
    const hw = fixtureWindow(tdb);
    HEAT_GT_Q = `from=${hw.from}&to=${hw.to}`;
  }

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-K1: 시드 재풀이 N·M — 성공2·실패1(문항2) → 2·1·50. score-only 행 미포함.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K1: retry-growth 시드 검증 — questions=2·succeeded=1·retryRate=50, score-only 행 미포함', async () => {
  const r = await req(`/retry-growth/${SEED_UID}?period=30d`, SEED_UID);
  assert.equal(r.status, 200, 'retry-growth 200');
  assert.equal(r.json.success, true);
  assert.equal(r.json.questions, 2, `questions=2 이어야 (현재 ${r.json.questions}) — t-q3(score-only) 이 섞이면 3`);
  assert.equal(r.json.succeeded, 1, `succeeded=1 이어야 (현재 ${r.json.succeeded})`);
  assert.equal(r.json.attempts, 3, `attempts=3 이어야 (현재 ${r.json.attempts}) — score-only 행 미포함`);
  assert.equal(r.json.retryRate, 50, `retryRate=50 이어야 (현재 ${r.json.retryRate})`);
  // 응답 계약 필드 존재
  for (const k of ['userId', 'period', 'questions', 'succeeded', 'attempts', 'retryRate', 'wrongTotal', 'wrongResolved']) {
    assert.ok(k in r.json, `응답에 ${k} 필드가 있어야 (기획서 §3 P0-1 (b) 계약)`);
  }
  assert.equal(typeof r.json.period.label, 'string', 'period.label 존재');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K2: 값 경계 — M ≤ N, attempts ≥ N, retryRate ∈ [0,100] 정수 또는 null(N=0)
// ──────────────────────────────────────────────────────────────────────────
test('INV-K2: retry-growth 경계 — M≤N, attempts≥N, retryRate 0~100 또는 null(N=0)', async () => {
  for (const uid of [STUDENT1, STUDENT2, SEED_UID]) {
    for (const p of PERIODS) {
      const r = await req(`/retry-growth/${uid}?period=${p}`, uid === SEED_UID ? SEED_UID : uid);
      assert.equal(r.status, 200, `uid${uid}@${p} 200`);
      const { questions: n, succeeded: m, attempts, retryRate } = r.json;
      assert.ok(m <= n, `uid${uid}@${p}: M(${m}) ≤ N(${n})`);
      assert.ok(attempts >= n, `uid${uid}@${p}: attempts(${attempts}) ≥ N(${n})`);
      if (n === 0) {
        assert.equal(retryRate, null, `uid${uid}@${p}: N=0 이면 retryRate 는 null (0 금지 — 빈상태 오독 방지)`);
      } else {
        assert.ok(Number.isInteger(retryRate), `uid${uid}@${p}: retryRate 정수`);
        assert.ok(retryRate >= 0 && retryRate <= 100, `uid${uid}@${p}: retryRate(${retryRate}) 0~100`);
      }
      assert.ok(r.json.wrongTotal >= 0 && r.json.wrongResolved >= 0, '보조 카운트 0 이상');
      assert.ok(r.json.wrongResolved <= r.json.wrongTotal, 'wrongResolved ≤ wrongTotal');
    }
  }
  // N=0 확정 케이스: 먼 과거 custom 기간 → questions=0, retryRate null
  const past = await req(`/retry-growth/${STUDENT1}?from=2020-01-01&to=2020-01-31`, STUDENT1);
  assert.equal(past.status, 200);
  assert.equal(past.json.questions, 0, '먼 과거 기간은 N=0');
  assert.equal(past.json.retryRate, null, 'N=0 → retryRate null');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K1': API = learning_logs 직접 SQL 전수 일치 (동일 창·동일 산식)
// ──────────────────────────────────────────────────────────────────────────
test("INV-K1': retry-growth = 실데이터(learning_logs 직접 SQL) 일치 — uid3·uid4 × 7d/30d/90d", async () => {
  const sql = tdb.prepare(`
    SELECT COUNT(DISTINCT target_id) AS n,
           COUNT(DISTINCT CASE WHEN result_success = 1 THEN target_id END) AS m,
           COUNT(*) AS attempts
    FROM learning_logs
    WHERE user_id = ? AND activity_type = 'wrong_note_retry'
      AND result_success IS NOT NULL
      AND DATE(created_at) >= ? AND DATE(created_at) <= ?
  `);
  for (const uid of [STUDENT1, STUDENT2]) {
    for (const p of PERIODS) {
      const n = parseInt(p, 10);
      const w = periodWindow(n);
      const gt = sql.get(uid, w.from, w.to);
      const r = await req(`/retry-growth/${uid}?period=${p}`, uid);
      assert.equal(r.json.questions, gt.n, `uid${uid}@${p} questions=${gt.n} (실데이터) — 현재 ${r.json.questions}`);
      assert.equal(r.json.succeeded, gt.m, `uid${uid}@${p} succeeded=${gt.m} (실데이터) — 현재 ${r.json.succeeded}`);
      assert.equal(r.json.attempts, gt.attempts, `uid${uid}@${p} attempts=${gt.attempts} (실데이터) — 현재 ${r.json.attempts}`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// DRILL: /perform/detail?activityType=wrong_note_retry — 카드=내역 계약(count==N==행수)
// ──────────────────────────────────────────────────────────────────────────
test('DRILL-K1: activityType=wrong_note_retry — count == retry-growth.questions == items.length', async () => {
  for (const uid of [STUDENT1, SEED_UID]) {
    for (const p of PERIODS) {
      const card = await req(`/retry-growth/${uid}?period=${p}`, uid);
      const drill = await req(`/perform/detail?activityType=wrong_note_retry&period=${p}&userId=${uid}`, uid);
      assert.equal(drill.status, 200, `drill uid${uid}@${p} 200`);
      assert.equal(drill.json.count, card.json.questions,
        `uid${uid}@${p}: drill.count(${drill.json.count}) != 카드 N(${card.json.questions}) — 카드=내역 계약 위반`);
      assert.equal((drill.json.items || []).length, Math.min(drill.json.count, 200),
        `uid${uid}@${p}: items.length != count`);
    }
  }
});

test('DRILL-K2: 재풀이 드릴 항목 — 문항 식별(wrongId·title≤40·success·date), score=null, "틀림" 어휘 0', async () => {
  const r = await req(`/perform/detail?activityType=wrong_note_retry&period=30d&userId=${SEED_UID}`, SEED_UID);
  assert.equal(r.status, 200);
  assert.equal(r.json.title, '다시 푼 문항', '모달 제목 어휘(기획서 (d))');
  assert.equal(r.json.count, 2, '시드 N=2');
  const byTarget = new Map(r.json.items.map(it => [String(it.wrongId), it]));
  assert.ok(byTarget.has('t-q1') && byTarget.has('t-q2'), '문항 2개(t-q1·t-q2)만 — score-only(t-q3) 부재');
  assert.ok(!byTarget.has('t-q3'), 'result_success 없는 t-q3 은 내역에 없어야');
  assert.equal(byTarget.get('t-q1').success, true, 't-q1 은 다시 맞힘(성공 1회 이상)');
  assert.equal(byTarget.get('t-q2').success, false, 't-q2 는 아직');
  for (const it of r.json.items) {
    assert.ok('wrongId' in it, '문항 식별 wrongId 존재');
    assert.equal(typeof it.title, 'string');
    assert.ok(it.title.length > 0 && it.title.length <= 40, `title 은 1~40자 (현재 ${it.title.length})`);
    assert.ok(it.date, '일시 존재');
    assert.equal(it.score, null, 'result_score 의존 금지 — score 는 항상 null');
    assert.equal(typeof it.success, 'boolean', 'success 는 boolean');
    assert.ok(['맞힘', '아직'].includes(it.badge.text), `뱃지 어휘는 맞힘/아직만 (현재 ${it.badge.text})`);
  }
  // 학생 뷰 윤리: 부정 어휘 금지("틀림"·"실패" — 응답 전문 스캔)
  assert.ok(!/틀림|실패/.test(r.raw), '응답에 부정 어휘("틀림"·"실패") 금지');
  // 지원하지 않는 activityType 은 400
  const bad = await req(`/perform/detail?activityType=bogus&period=30d`, STUDENT1);
  assert.equal(bad.status, 400, '미지원 activityType 은 400');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K3: 추천 카드 계약 (recommendations + weaknesses 부착 필드)
// ──────────────────────────────────────────────────────────────────────────
const PRIORITY_ENUM = ['urgent', 'recommended', 'optional'];
test('INV-K3: recommendations ≤3 · priority enum 중복없음 · estMinutes 5~60 정수 · reasonText 잔존변수 0 · code 실존', async () => {
  for (const uid of [STUDENT1, STUDENT2]) {
    for (const p of PERIODS) {
      const r = await req(`/insights/${uid}?period=${p}`, uid);
      assert.equal(r.status, 200, `insights uid${uid}@${p} 200`);
      const recs = r.json.recommendations;
      assert.ok(Array.isArray(recs), 'recommendations 는 배열');
      assert.ok(recs.length <= 3, `recommendations ≤ 3 (현재 ${recs.length})`);
      const seen = new Set();
      const known = new Set([
        ...(r.json.weaknesses || []).map(w => w.achievement_code),
        ...(r.json.strengths || []).map(s => s.achievement_code),
      ]);
      for (const rec of recs) {
        assert.ok(PRIORITY_ENUM.includes(rec.priority), `priority(${rec.priority}) ∈ enum`);
        assert.ok(!seen.has(rec.priority), `priority 중복 없음 (${rec.priority})`);
        seen.add(rec.priority);
        assert.ok(Number.isInteger(rec.estMinutes), `estMinutes 정수 (현재 ${rec.estMinutes})`);
        assert.ok(rec.estMinutes >= 5 && rec.estMinutes <= 60, `estMinutes(${rec.estMinutes}) 5~60`);
        assert.equal(typeof rec.reasonText, 'string');
        assert.ok(rec.reasonText.length > 0, 'reasonText 비어있지 않음');
        assert.ok(!/\{avg\}|\{att\}|\{N\}|null%/.test(rec.reasonText), `템플릿 변수 잔존 금지: "${rec.reasonText}"`);
        assert.ok(known.has(rec.achievement_code), `code(${rec.achievement_code})는 weaknesses∪strengths 에 실존`);
      }
      // weaknesses 행 단위 부착(s-home Compact 바인딩 계약)
      for (const w of (r.json.weaknesses || [])) {
        assert.ok(typeof w.reasonText === 'string' && w.reasonText.length > 0, `약점행 reasonText 필수 (${w.achievement_code})`);
        assert.ok(!/\{avg\}|\{att\}|null%/.test(w.reasonText), `약점행 템플릿 잔존 금지: "${w.reasonText}"`);
        assert.ok(Number.isInteger(w.estMinutes) && w.estMinutes >= 5 && w.estMinutes <= 60,
          `약점행 estMinutes(${w.estMinutes}) 5~60 정수 — 0·null 금지`);
        assert.ok(w.priority === null || PRIORITY_ENUM.includes(w.priority), `약점행 priority(${w.priority})`);
      }
    }
  }
});

test('REG-K3: 추천 3단 선정 규칙 — ①시급=미도달·채점 ②권장=평가부족 ③선택=강점 + 확정 이유 문구', async () => {
  const r = await req(`/insights/${RECO_UID}?period=30d`, RECO_UID);
  assert.equal(r.status, 200);
  const recs = r.json.recommendations;
  assert.equal(recs.length, 3, '세 우선순위가 모두 존재하는 픽스처이므로 3건 전부 선정돼야');

  assert.equal(recs[0].priority, 'urgent');
  assert.equal(recs[0].achievement_code, RECO_URGENT_CODE, '① 시급 = 미도달·채점 avg 최저');
  assert.equal(recs[0].status, 'not_reached', '① 은 미도달 상태여야(평가부족을 시급으로 올리면 안 됨)');
  // 문구의 두 수는 테스트가 심은 분자/분모에서 그대로 유도된다:
  //   평균 점수 = AVG(정규화 점수) = (0+0+0+100)/4 = 25 · 정답 인정 = success/attempt = 1/4
  assert.equal(recs[0].reasonText, '평균 점수 25점 · 정답 인정 1/4회 — 여기부터 다시 잡아봐요',
    '시급(채점) 템플릿 — 라벨=평균 점수(값 정체 일치) + 도달판정 분자/분모 병기');

  assert.equal(recs[1].priority, 'recommended');
  assert.equal(recs[1].achievement_code, RECO_RECOMMEND_CODE, '② 권장 = 평가부족(채점 우선)');
  assert.equal(recs[1].status, 'insufficient', '② 는 평가부족(att<3)');
  assert.equal(recs[1].reasonText, '아직 2번밖에 안 풀었어요 — 3번 이상 풀면 도달 판정을 받을 수 있어요',
    '권장(평가부족) 템플릿 그대로 — {att} 는 심은 시도 수 2');

  assert.equal(recs[2].priority, 'optional');
  assert.equal(recs[2].achievement_code, RECO_OPTIONAL_CODE, '③ 선택 = 강점(att≥3·avg 최고) 심화');
  assert.equal(recs[2].reasonText, '평균 점수 100점 · 정답 인정 5/5회 — 한 단계 더 깊게 배워볼까요?',
    '선택(강점 심화) 템플릿');

  // 도달한 성취기준이 약점 목록에 섞이면 안 된다(정본사전 §6-10-2: 도달은 항상 제외).
  assert.ok(!(r.json.weaknesses || []).some(w => w.achievement_code === RECO_OPTIONAL_CODE),
    '도달(100%) 코드가 약점에 혼입');
});

test('REG-K3b: 평균 점수 100%·평가부족 약점행은 "아직 N번밖에…" 이유로 자명 (기획서 §3 P0-2 ② 해소 방식)', async () => {
  const r = await req(`/insights/${RECO_UID}?period=30d`, RECO_UID);
  const w100 = (r.json.weaknesses || []).find(w => w.achievement_code === RECO_RECOMMEND_CODE);
  assert.ok(w100, '평균 100%·시도 2회 행이 약점에 남아야(도달 판정을 못 받았으므로)');
  assert.equal(w100.avg_score, 100, '평균 점수 100 — 2회 모두 만점');
  assert.equal(w100.status, 'insufficient', '100% 행은 평가부족(att<3)이어야 약점에 남는다');
  assert.match(w100.reasonText, /^아직 2번밖에 안 풀었어요/, '평가부족 이유 문구로 "100%인데 왜?" 해소');
});

// ──────────────────────────────────────────────────────────────────────────
// REG-K3c: 실 계정(uid3) 이중장부 — 성취 카드의 시도/정답이 **원시 로그**와 일치하는가.
//   위 REG-K3 를 픽스처로 옮긴 대신, "실 계정 GT" 의 역할은 이 검사가 이어받는다.
//   드리프트하는 상수를 박는 대신, 같은 사실을 **다른 경로로 두 번 계산해 대조**한다:
//     · 좌변: /insights 응답(= lrs_achievement_stats 경유)
//     · 우변: learning_logs 에 시도 술어를 손으로 걸어 센 값(집계 테이블 미경유)
//   시드가 늘든 줄든 양변이 같이 움직이므로 시한폭탄이 아니고,
//   집계 테이블이 로그와 어긋나는 순간(= 재집계 누락·증분 드리프트) 붉어진다.
// ──────────────────────────────────────────────────────────────────────────
test('REG-K3c: uid3 이중장부 — insights 약점·강점의 시도/정답 == 원시 로그 손계산', async () => {
  const ATTEMPT_TYPES = [
    'exam_complete', 'homework_submit', 'content_solve', 'self_learn', 'daily_complete',
    'wrong_note_retry', 'node_complete', 'content_complete', 'problem_attempt',
  ].map(t => `'${t}'`).join(',');
  const r = await req(`/insights/${STUDENT1}?period=30d`, STUDENT1);
  assert.equal(r.status, 200);
  const rows = [...(r.json.weaknesses || []), ...(r.json.strengths || [])];
  assert.ok(rows.length > 0, '전제: uid3 약점∪강점이 비어있지 않음');
  let checked = 0;
  for (const row of rows) {
    const gt = tdb.prepare(`
      SELECT COUNT(*) att, SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) succ
      FROM learning_logs
      WHERE user_id = ? AND achievement_code = ?
        AND activity_type IN (${ATTEMPT_TYPES}) AND result_success IS NOT NULL
    `).get(STUDENT1, row.achievement_code);
    assert.equal(row.attempt_count, gt.att,
      `${row.achievement_code}: 시도 불일치 — 집계 ${row.attempt_count} vs 로그 ${gt.att}`);
    assert.equal(row.success_count, gt.succ,
      `${row.achievement_code}: 정답 불일치 — 집계 ${row.success_count} vs 로그 ${gt.succ}`);
    checked++;
  }
  assert.ok(checked >= 3, `대조한 성취기준이 너무 적다(${checked}) — 전제 붕괴 가능`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K3L (C-1 표기 정직성): **라벨 ↔ 값 정체 일치**를 박제한다.
//   결함 부류(재발 방지 대상): 라벨은 "정답률"인데 값은 avg_score(평균 점수)를 넣는 것.
//   두 지표는 실제로 다르다 — 실측 lrs_achievement_stats 채점행 19,282건 중 30.4%(5,860건)가
//   |평균 점수 − 정답률| ≥ 20%p. 라벨을 잘못 붙이면 "미도달인데 정답률 75%" 같은 자기모순이 뜬다.
//   규칙: reasonText 안의 모든 수치는 그 라벨이 가리키는 필드와 정확히 일치해야 한다.
//     · "평균 점수 N점"  → N === round(avg_score)      (avg_score 없으면 이 조각 자체가 없어야 함)
//       ※ 단위는 반드시 "점". 2026-08-04 이전엔 "평균 점수 N%" 였는데, avg_score 는 0~100 **점수**이지
//         백분율이 아니다. 정본사전 §6-13 이 "점수를 %로 표기"를 자동 REWORK 사유로 규정한다.
//         아래 NO-PCT 단언이 이 표기의 재발을 막는다.
//     · "정답률 N%"      → N === round(correctRate)    (avg_score 재사용 금지)
//     · "정답 인정 S/A회" → S === success_count, A === attempt_count (도달 판정 분자/분모)
//   + correctRate 계약: null 이거나 0~100, 그리고 success/attempt 에서 파생된 값과 일치.
// ──────────────────────────────────────────────────────────────────────────
test('INV-K3L: reasonText 라벨↔값 정체 일치 (평균 점수=avg_score · 정답률=correctRate · 정답 인정=succ/att)', async () => {
  let checked = 0, avgFrags = 0, hitFrags = 0;
  for (const uid of [STUDENT1, STUDENT2]) {
    for (const p of PERIODS) {
      const r = await req(`/insights/${uid}?period=${p}`, uid);
      assert.equal(r.status, 200, `insights uid${uid}@${p} 200`);
      const rows = [...(r.json.recommendations || []), ...(r.json.weaknesses || []), ...(r.json.strengths || [])];
      for (const row of rows) {
        const t = row.reasonText;
        if (typeof t !== 'string' || !t) continue;
        checked++;
        const where = `uid${uid}@${p} ${row.achievement_code}: "${t}"`;

        // (0) 숫자 자리에 결측이 새는 것 금지
        assert.ok(!/(null|undefined|NaN)\s*%/.test(t), `결측 표기 금지 — ${where}`);
        assert.ok(!/\/\s*(null|undefined|NaN)/.test(t), `결측 분모 금지 — ${where}`);

        // (1) "평균 점수 N점" ↔ avg_score
        assert.ok(!/평균 점수\s*\d+(?:\.\d+)?%/.test(t),
          `NO-PCT: 점수를 "%"로 표기하면 안 된다 — avg_score 는 0~100 점수다 (정본사전 §6-13) — ${where}: ${t}`);
        const mAvg = t.match(/평균 점수\s*(\d+(?:\.\d+)?)점/);
        if (mAvg) {
          avgFrags++;
          assert.ok(row.avg_score != null, `"평균 점수" 표기가 있으면 avg_score 필수 — ${where}`);
          assert.equal(Number(mAvg[1]), Math.round(Number(row.avg_score)),
            `"평균 점수 N점" 의 N 은 avg_score 반올림과 일치 (avg_score=${row.avg_score}) — ${where}`);
        }

        // (2) "정답률 N%" ↔ correctRate  (★ avg_score 를 정답률로 부르는 것이 이 결함의 본체)
        const mRate = t.match(/정답률\s*(\d+(?:\.\d+)?)%/);
        if (mRate) {
          assert.ok(row.correctRate != null, `"정답률" 표기가 있으면 correctRate 필수 — ${where}`);
          assert.equal(Number(mRate[1]), Math.round(Number(row.correctRate)),
            `"정답률 N%" 의 N 은 correctRate(success/attempt) 와 일치해야 하며 avg_score 재사용 금지 ` +
            `(correctRate=${row.correctRate}, avg_score=${row.avg_score}) — ${where}`);
        }

        // (3) "정답 인정 S/A회" ↔ success_count / attempt_count (도달 판정 입력값 그대로)
        const mHit = t.match(/정답 인정\s*(\d+)\s*\/\s*(\d+)회/);
        if (mHit) {
          hitFrags++;
          assert.equal(Number(mHit[1]), Number(row.success_count),
            `"정답 인정 S/A" 의 S 는 success_count — ${where}`);
          assert.equal(Number(mHit[2]), Number(row.attempt_count),
            `"정답 인정 S/A" 의 A 는 attempt_count — ${where}`);
        }

        // (4) correctRate 계약 — null 또는 0~100, success/attempt 파생값과 일치
        if (row.correctRate != null) {
          assert.ok(row.correctRate >= 0 && row.correctRate <= 100,
            `correctRate(${row.correctRate}) 0~100 — ${where}`);
          if (row.attempt_count > 0 && row.success_count != null) {
            const expect = Math.round((row.success_count / row.attempt_count) * 1000) / 10;
            assert.equal(row.correctRate, expect,
              `correctRate 는 success/attempt 파생 (기대 ${expect}) — ${where}`);
          }
        }
      }
    }
  }
  assert.ok(checked > 0, '검사한 reasonText 행이 있어야 한다');
  assert.ok(avgFrags > 0, '"평균 점수 N점" 조각이 최소 1건은 나와야 한다(템플릿 실제 사용 확인)');
  assert.ok(hitFrags > 0, '"정답 인정 S/A회" 조각이 최소 1건은 나와야 한다(판정 근거 병기 확인)');
});

// FE 정적 가드: 같은 결함 부류가 화면단에서 재발하는 것을 막는다.
//   public/lrs/index.html 에서 "정답률" 이라는 라벨과 avg_score 가 **같은 줄**에 있으면
//   avg_score 를 정답률로 표기하는 것 — 이 결함의 화면판이다. (진짜 정답률은 correctRate 사용)
test('INV-K3L-FE: LRS 화면 소스에 "정답률" 라벨 + avg_score 동시 등장 0건 (avg_score 를 정답률로 표기 금지)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'public', 'lrs', 'index.html');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const bad = [];
  lines.forEach((ln, i) => {
    if (ln.includes('정답률') && /avg_score/.test(ln) && !/correctRate/.test(ln)) {
      // 주석 줄은 설명 목적이므로 제외(라벨 렌더가 아님)
      const s = ln.trim();
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return;
      bad.push(`${i + 1}: ${s.slice(0, 160)}`);
    }
  });
  assert.equal(bad.length, 0,
    `avg_score 를 "정답률" 라벨로 렌더하는 줄이 있으면 안 된다(평균 점수로 표기하거나 correctRate 사용):\n${bad.join('\n')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-K5(BE): /stats/daily byHour — 24칸·기간 연동·7종 화이트리스트 실데이터 일치
// ──────────────────────────────────────────────────────────────────────────
test('INV-K5-BE: stats/daily byHour — 24칸(0~23시), 합계 = 기간 내 학습활동 7종 실데이터', async () => {
  const ph = LEARN7.map(() => '?').join(',');
  const sql = tdb.prepare(`
    SELECT COUNT(*) AS c FROM learning_logs
    WHERE user_id = ? AND activity_type IN (${ph})
      AND DATE(created_at) >= ? AND DATE(created_at) <= ?
  `);
  let prevSum = null;
  for (const p of PERIODS) {
    const r = await req(`/stats/daily?period=${p}`, STUDENT1); // 학생 scope=mine 기본
    assert.equal(r.status, 200, `stats/daily@${p} 200`);
    const bh = r.json.byHour;
    assert.ok(Array.isArray(bh) && bh.length === 24, 'byHour 는 항상 24칸');
    bh.forEach((x, i) => {
      assert.equal(x.hour, i, `hour 오름차순 0~23 (${i}번째=${x.hour})`);
      assert.ok(Number.isInteger(x.count) && x.count >= 0, `count(${x.count}) 0 이상 정수`);
    });
    const sum = bh.reduce((s, x) => s + x.count, 0);
    const w = periodWindow(parseInt(p, 10));
    const gt = sql.get(STUDENT1, ...LEARN7, w.from, w.to);
    assert.equal(sum, gt.c, `@${p}: byHour 합(${sum}) = 7종 실데이터(${gt.c}) — 기간칩 연동·화이트리스트 계약`);
    if (prevSum != null) assert.ok(sum >= prevSum, `기간이 길수록 합계 단조증가 (7d≤30d≤90d)`);
    prevSum = sum;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// P0-3(BE 확인): auth/me 경유 school_level 노출 — findUserById SELECT 포함 검증
// ──────────────────────────────────────────────────────────────────────────
test('P0-3-BE: findUserById(auth/me 원천)가 school_level·grade 노출 — uid3 = elementary', () => {
  const authDb = require('../db/auth');
  const u = authDb.findUserById(STUDENT1);
  assert.ok(u, 'uid3 존재');
  assert.ok('school_level' in u, 'school_level 필드 노출 (P0-3 분기 키 — BE 추가 작업 0 전제)');
  assert.ok('grade' in u, 'grade 필드 노출');
  assert.equal(u.school_level, 'elementary', 'student1 은 elementary(초등)');
});

// ──────────────────────────────────────────────────────────────────────────
// PERM: 권한 가드 — 본인/교사/관리자 200, 타 학생 403
// ──────────────────────────────────────────────────────────────────────────
test('PERM-K: retry-growth·재풀이 드릴 — 학생 본인 200, 타 학생 403, 교사·관리자 200', async () => {
  assert.equal((await req(`/retry-growth/${STUDENT1}?period=30d`, STUDENT1)).status, 200, '본인 200');
  assert.equal((await req(`/retry-growth/${STUDENT2}?period=30d`, STUDENT1)).status, 403, '학생→타 학생 403');
  assert.equal((await req(`/retry-growth/${STUDENT1}?period=30d`, TEACHER)).status, 200, '교사 200');
  assert.equal((await req(`/retry-growth/${STUDENT1}?period=30d`, ADMIN)).status, 200, '관리자 200');
  assert.equal((await req(`/retry-growth/abc?period=30d`, STUDENT1)).status, 400, '잘못된 uid 400');
  const drillOther = await req(`/perform/detail?activityType=wrong_note_retry&period=30d&userId=${STUDENT2}`, STUDENT1);
  assert.equal(drillOther.status, 403, '드릴도 학생→타 학생 403');
});

// ──────────────────────────────────────────────────────────────────────────
// HEATMAP-CELL: 활용 현황 히트맵 셀 클릭 드릴다운
//   INV-HC1  count 정합: 임의 (dow,hour) 칸에서 heatmap-cell.total ==
//            /stats/daily heatmapDowHour[dow][hour] (멤버십 스코프·demo 제외·기간·셀필터 동일).
//            teacher1(uid2) scope=class 기본 → 소유 반(class 2) 학생 합집합.
//   INV-HC2  demo_* 제외: 시드한 demo_seed 행은 count·items 어디에도 안 잡힘.
//   PERM-HC  비담임 교사 403(teacher3=uid9 는 class 2 비멤버), 학생 403, 담임 200.
//   BOUND-HC 잘못된 dow/hour/classId → 400. 상한(count ≤ 100).
// ──────────────────────────────────────────────────────────────────────────
const HEAT_DOW = 2, HEAT_HOUR = 10;   // 시드 화요일 10시

test('INV-HC1: heatmap-cell.total == /stats/daily heatmapDowHour 전 칸 정합(teacher1·전 기간)', async () => {
  for (const p of PERIODS) {
    const daily = await req(`/stats/daily?period=${p}`, TEACHER); // scope=class 기본
    assert.equal(daily.status, 200, `daily@${p} 200`);
    const hm = daily.json.heatmapDowHour;
    assert.ok(Array.isArray(hm) && hm.length === 7, 'heatmapDowHour 7행');
    // 값>0 인 칸을 전수 대조(개수 폭주 방지 위해 상위 몇 칸만)
    const nonZero = [];
    hm.forEach((row, dow) => row.forEach((v, hour) => { if (v > 0) nonZero.push({ dow, hour, v }); }));
    for (const cell of nonZero.slice(0, 12)) {
      const r = await req(`/stats/heatmap-cell?classId=2&dow=${cell.dow}&hour=${cell.hour}&period=${p}`, TEACHER);
      assert.equal(r.status, 200, `heatmap-cell@${p} (${cell.dow},${cell.hour}) 200`);
      assert.equal(r.json.total, cell.v,
        `@${p} 칸(${cell.dow},${cell.hour}): heatmap-cell.total(${r.json.total}) == heatmapDowHour(${cell.v})`);
      assert.equal(r.json.count, Math.min(cell.v, 100), 'count = min(total,100) 상한');
      assert.ok(Array.isArray(r.json.items) && r.json.items.length <= 100, 'items ≤ 100');
      // items 계약 필드
      r.json.items.forEach(it => {
        for (const k of ['userId','name','activityType','activityKo','createdAt']) {
          assert.ok(k in it, `item 에 ${k} 필드`);
        }
        assert.ok(!/demo/i.test(String(it.service||'')), 'demo_* 서비스 미노출');
      });
    }
  }
});

test('INV-HC2: 시드 화요일 10시 칸 — 실데이터 3건(demo 제외), demo_seed 미포함', async () => {
  // [2026-07-30 fix] period=90d(롤링) → HEAT_GT_Q(데이터 유도). 롤링 창이면 이 칸의
  //   실 데이터가 2026-09-30 경 0건이 되어 아래 total>=3 전제가 코드 변경 없이 붕괴한다.
  const r = await req(`/stats/heatmap-cell?classId=2&dow=${HEAT_DOW}&hour=${HEAT_HOUR}&${HEAT_GT_Q}`, TEACHER);
  assert.equal(r.status, 200, '200');
  // 시드 3건(content_solve·exam_complete·homework_submit) 이상(기존 실데이터가 같은 칸일 수도 있어 >=)
  assert.ok(r.json.total >= 3, `시드 실데이터 3건 이상 (현재 ${r.json.total})`);
  const services = r.json.items.map(it => String(it.service||''));
  assert.ok(!services.some(s => /demo/i.test(s)), 'demo_seed 행은 items 에 없어야');
  // daily 히트맵 그 칸과 정확히 일치(정합 재확인)
  const daily = await req(`/stats/daily?${HEAT_GT_Q}`, TEACHER); // 같은 창이어야 정합 비교 성립
  assert.equal(r.json.total, daily.json.heatmapDowHour[HEAT_DOW][HEAT_HOUR], '그 칸 heatmapDowHour 와 일치');
});

test('PERM-HC: 담임 200 · 비담임 교사 403 · 학생 403', async () => {
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=${HEAT_DOW}&hour=${HEAT_HOUR}&period=90d`, TEACHER)).status, 200, '담임(teacher1) 200');
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=${HEAT_DOW}&hour=${HEAT_HOUR}&period=90d`, 9)).status, 403, '비담임 교사(teacher3) 403');
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=${HEAT_DOW}&hour=${HEAT_HOUR}&period=90d`, STUDENT1)).status, 403, '학생 403');
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=${HEAT_DOW}&hour=${HEAT_HOUR}&period=90d`, ADMIN)).status, 200, '관리자 200');
});

test('BOUND-HC: 잘못된 dow/hour/classId → 400', async () => {
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=7&hour=10`, TEACHER)).status, 400, 'dow=7 400');
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=2&hour=24`, TEACHER)).status, 400, 'hour=24 400');
  assert.equal((await req(`/stats/heatmap-cell?classId=abc&dow=2&hour=10`, TEACHER)).status, 400, 'classId=abc 400');
  assert.equal((await req(`/stats/heatmap-cell?classId=2&dow=-1&hour=10`, TEACHER)).status, 400, 'dow=-1 400');
});
