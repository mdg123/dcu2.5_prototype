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
const { setupTestDb, openTestDb } = require('./_setup');

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
let server, baseUrl, tdb, SEED_UID, HEAT_TS;
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

test('REG-K3: uid3 ground-truth — ①시급 [4수03-10] ②권장 [4국01-01] ③선택 [4수03-09] + 확정 이유 문구', async () => {
  const r = await req(`/insights/${STUDENT1}?period=30d`, STUDENT1);
  const recs = r.json.recommendations;
  assert.equal(recs.length, 3, 'uid3 은 3건 모두 선정');
  assert.equal(recs[0].priority, 'urgent');
  assert.equal(recs[0].achievement_code, '[4수03-10]', '① 시급 = 미도달·채점 avg 최저');
  assert.equal(recs[0].reasonText, '정답률 25%예요 — 여기부터 다시 잡아봐요', '시급(채점) 템플릿 그대로');
  assert.equal(recs[1].priority, 'recommended');
  assert.equal(recs[1].achievement_code, '[4국01-01]', '② 권장 = 평가부족(채점 우선)');
  assert.equal(recs[1].reasonText, '아직 2번밖에 안 풀었어요 — 3번 이상 풀면 도달 판정을 받을 수 있어요', '권장(평가부족) 템플릿 그대로');
  assert.equal(recs[2].priority, 'optional');
  assert.equal(recs[2].achievement_code, '[4수03-09]', '③ 선택 = 강점(att≥3·avg 최고) 심화');
  assert.equal(recs[2].reasonText, '정답률 100%로 잘하고 있어요 — 한 단계 더 깊게 배워볼까요?', '선택(강점 심화) 템플릿 그대로');
});

test('REG-K3b: 정답률 100%·평가부족 약점행([4영01-08])은 "아직 N번밖에…" 이유로 자명 (기획서 §3 P0-2 ② 해소 방식)', async () => {
  const r = await req(`/insights/${STUDENT1}?period=30d`, STUDENT1);
  const w100 = (r.json.weaknesses || []).find(w => w.avg_score === 100);
  assert.ok(w100, 'uid3 약점에 100% 평가부족 행([4영01-08]) 존재(기획서 실측 전제)');
  assert.equal(w100.status, 'insufficient', '100% 행은 평가부족(att<3)이어야 약점에 남는다');
  assert.match(w100.reasonText, /^아직 \d+번밖에 안 풀었어요/, '평가부족 이유 문구로 "100%인데 왜?" 해소');
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
  const r = await req(`/stats/heatmap-cell?classId=2&dow=${HEAT_DOW}&hour=${HEAT_HOUR}&period=90d`, TEACHER);
  assert.equal(r.status, 200, '200');
  // 시드 3건(content_solve·exam_complete·homework_submit) 이상(기존 실데이터가 같은 칸일 수도 있어 >=)
  assert.ok(r.json.total >= 3, `시드 실데이터 3건 이상 (현재 ${r.json.total})`);
  const services = r.json.items.map(it => String(it.service||''));
  assert.ok(!services.some(s => /demo/i.test(s)), 'demo_seed 행은 items 에 없어야');
  // daily 히트맵 그 칸과 정확히 일치(정합 재확인)
  const daily = await req(`/stats/daily?period=90d`, TEACHER);
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
