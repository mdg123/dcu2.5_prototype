// test/lrs-perform-detail.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS "활동 유형별 수행" KPI 카드 Drill-down 하네스.
//   기획서: 작업지시서/LRS_활동유형별수행_카드드릴다운_스펙.md §3 (데이터 계약)
//   대상 API: GET /api/lrs/perform/detail?bucket=&segment=&period=&userId=
//
// ★ 카드=내역 count 계약(불변식) — 어긋나면 자동 REWORK:
//   ⓐ  detail.count == items.length (200 상한 내)  — 5 bucket × 7d/30d/90d 전수
//   ⓑ  detail.count == /stats/perform 카드 숫자     — bucket ↔ summary 필드 정확 일치
//   ⓒ  bucket=all.count == exam+homework+self+content (subtotals 합 = all)
//   ⓓ  bucket=content segments(view+lesson+solve) 합 == content.count
//   ⓔ  ground-truth(uid3) 절대값 박제 — 30일 창 밖 은폐/이중카운트 회귀 차단
//   ⓕ  점수 정규화: score 는 0~100 또는 null. content 조회/수업(view·lesson)은 null.
//   ⓖ  권한 — 학생은 본인만(타 학생 403), 잘못된 bucket 400.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4.
// ground-truth 절대값(uid3=student1) — ★고정 from/to 창(2026-04-01 ~ 2026-07-02)★:
//   과거 상대기간(7d/30d/90d) GT 는 달력이 지나며 창 밖으로 로그가 빠져 자연 붕괴했다
//   (2026-07-03 실측: content@7d 44→39 — 06-25 로그 5건이 7d 창을 벗어남. 제품 버그 아님).
//   → 절대값 박제는 "고정 창"으로 옮겨 영구 안정화(uid3 최초 로그 2026-04-19, 창이 전 데이터
//   포괄·창 끝이 과거라 미래 로그 유입에도 불변). 상대기간은 REG-DRILL-e 에서 원천 SQL
//   독립 대조로 검증(달력 무관 — 창 시프트·은폐·이중카운트 여전히 적발).
//   fixed window | exam | homework | self | content(view+lesson+solve) | all
//   04-01~07-02  |  29  |    2     |  10  |  45 (23+15+7)              | 86
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
// [W2-b 6-9] 버킷 재편 — all = 학습 활동 정본 7종(C1). 조회(view)·진도(lesson)는 학습 활동이
//   아니므로 all 에서 빠지고 **별도 버킷**으로 드릴한다(합산 금지, 은폐도 금지).
const BUCKETS = ['exam', 'homework', 'self', 'content', 'all', 'view', 'lesson'];
// all 을 구성하는 4버킷(소계 합 == all 불변식 대상). view·lesson 은 여기 들어가면 안 된다.
const SUM_BUCKETS = ['exam', 'homework', 'self', 'content'];
const PERIODS = ['7d', '30d', '90d'];

// ground-truth 절대값(uid3) — 고정 from/to 창(달력 경과 불변 — 파일 헤더 주석 참조).
//   uid3 최초 로그 2026-04-19: 창이 당시 전 데이터를 포괄하고, 창 끝(07-02)이 과거로 고정이라
//   이후 새 로그가 쌓여도 이 절대값은 변하지 않는다(재시드 시에만 갱신).
//   ★ W2-b 재산출: all 86 → 50. 감소가 정상이다 — 조회 23건·진도 15건이 '학습 활동'에서 빠지고
//     오답노트 재풀이 2건이 자기주도 학습에 들어왔다(29+2+12+7=50). 조회·진도는 별도 버킷에 그대로 남는다.
//     problem_attempt 11건은 채점형(SCORED)이지만 C1 7종 밖이라 활동 수에는 안 들어간다(모집단 분리).
const GT_FIXED = {
  from: '2026-04-01', to: '2026-07-02',
  exam: 29, homework: 2, self: 12, content: 7, all: 50,
  view: 23, lesson: 15,
};
// 상대기간 SQL 독립 대조용 — 라우트와 같은 화이트리스트를 테스트가 별도로 소유(이중 장부).
//   라우트 쪽 화이트리스트가 바뀌면 여기와 어긋나 빨간불 → 의도된 감시.
const BUCKET_TYPES_MIRROR = {
  exam: ['exam_complete'], homework: ['homework_submit'],
  self: ['self_learn', 'daily_complete', 'wrong_note_retry', 'node_complete'],
  content: ['content_solve'],
  all: ['exam_complete', 'homework_submit', 'self_learn', 'daily_complete',
        'wrong_note_retry', 'node_complete', 'content_solve'],
  view: ['content_view'], lesson: ['lesson_progress'],
};

// ── HTTP 하네스 ────────────────────────────────────────────────────────────
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
const detail = (bucket, period, userId = STUDENT1, extra = '') =>
  req(`/perform/detail?bucket=${bucket}&period=${period}${extra}`, userId);

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// ⓐ count == items.length — 5 bucket × 3 기간 전수 (200 상한 내)
// ──────────────────────────────────────────────────────────────────────────
test('INV-DRILL-a: detail.count == items.length (5 bucket × 7d/30d/90d)', async () => {
  for (const p of PERIODS) {
    for (const b of BUCKETS) {
      const r = await detail(b, p);
      assert.equal(r.status, 200, `${b}@${p} 200`);
      assert.equal(r.json.success, true, `${b}@${p} success`);
      const n = r.json.count;
      const len = (r.json.items || []).length;
      if (n <= 200) {
        assert.equal(len, n, `${b}@${p}: items.length(${len}) != count(${n}) — 카드=내역 계약 위반`);
      } else {
        assert.equal(len, 200, `${b}@${p}: count>200 이면 items 는 200(상한)`);
        assert.ok(r.json.note, `${b}@${p}: 200 상한 안내 note 필요`);
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓑ detail.count == /stats/perform 카드 숫자 (bucket ↔ summary 필드)
// ──────────────────────────────────────────────────────────────────────────
test('INV-DRILL-b: detail.count == stats/perform 카드 숫자 (동일 원천·필터)', async () => {
  // [W2-b 6-9] 분리된 조회·진도 카드도 같은 '카드=내역' 계약을 지켜야 한다(분리했다고 검증 면제 아님).
  const cardField = { exam: 'examCount', homework: 'homeworkCount', self: 'selfLearnCount',
    content: 'contentCount', all: 'totalActs',
    view: 'contentViewCount', lesson: 'lessonProgressCount' };
  for (const p of PERIODS) {
    const perf = await req(`/stats/perform?period=${p}&scope=mine`, STUDENT1);
    assert.equal(perf.status, 200, `stats/perform@${p} 200`);
    for (const b of BUCKETS) {
      const r = await detail(b, p);
      assert.equal(r.json.count, perf.json.summary[cardField[b]],
        `${b}@${p}: detail.count(${r.json.count}) != 카드 ${cardField[b]}(${perf.json.summary[cardField[b]]})`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓒ all == exam + homework + self + content  (subtotals 합 = all)
// ──────────────────────────────────────────────────────────────────────────
test('INV-DRILL-c: all.count == exam+homework+self+content (subtotals 합 = all)', async () => {
  for (const p of PERIODS) {
    const counts = {};
    for (const b of BUCKETS) counts[b] = (await detail(b, p)).json.count;
    const sum4 = counts.exam + counts.homework + counts.self + counts.content;
    assert.equal(counts.all, sum4, `all(${counts.all}) != 4버킷 합(${sum4}) @${p}`);

    // all 응답의 subtotals 필드도 합·라벨 검증
    const all = await detail('all', p);
    assert.ok(Array.isArray(all.json.subtotals), `all@${p} subtotals 배열`);
    const subSum = all.json.subtotals.reduce((s, x) => s + x.count, 0);
    assert.equal(subSum, counts.all, `subtotals 합(${subSum}) != all(${counts.all}) @${p}`);
    for (const st of all.json.subtotals) {
      assert.equal(st.count, counts[st.bucket], `subtotal ${st.bucket}(${st.count}) != detail(${counts[st.bucket]}) @${p}`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓓ content segments(view+lesson+solve) 합 == content.count, 세그먼트 필터 count 일치
// ──────────────────────────────────────────────────────────────────────────
// [W2-b 6-9 개정] content 버킷이 content_solve 단일 유형이 되면서 세그먼트 소계가 사라졌다.
//   과거 세그먼트(view·lesson)는 이제 **독립 버킷**이다. 여기서 지키는 것은 두 가지:
//     ① 조회·진도가 '학습 활동'(all)에 절대 섞이지 않는다   ② 그렇다고 은폐되지도 않는다(버킷으로 조회 가능)
test('INV-DRILL-d: 조회·진도는 all 에 불포함이되 별도 버킷으로 조회 가능(합산 금지·은폐 금지)', async () => {
  for (const p of PERIODS) {
    const content = await detail('content', p);
    assert.equal(content.json.segments, undefined, `content@${p}: 단일 유형이므로 segments 없음`);
    assert.equal(content.json.title, '콘텐츠 문항풀이', 'content 버킷 제목 = 콘텐츠 문항풀이');

    const all = await detail('all', p);
    const view = await detail('view', p);
    const lesson = await detail('lesson', p);
    assert.equal(view.json.title, '콘텐츠 조회', 'view 버킷 제목 = 콘텐츠 조회');
    // ① all 은 4버킷 합과 정확히 같다 → 조회·진도가 섞였다면 여기서 깨진다.
    let sum = 0;
    for (const b of SUM_BUCKETS) sum += (await detail(b, p)).json.count;
    assert.equal(all.json.count, sum, `all(${all.json.count}) != 4버킷 합(${sum}) @${p}`);
    // ② 조회·진도 로그가 존재하면 각 버킷에서 실제로 조회돼야 한다(은폐 금지).
    for (const [b, r] of [['view', view], ['lesson', lesson]]) {
      assert.equal(r.status, 200, `${b}@${p} 200`);
      assert.equal((r.json.items || []).length, Math.min(200, r.json.count),
        `${b}@${p}: items.length != min(200, count)`);
      if (r.json.count > 200) assert.ok(r.json.note, `${b}@${p}: 상한 안내 note 필요`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓔ ground-truth 절대값 박제(uid3) — 은폐/이중카운트 회귀 차단.
//   ⓔ-1 고정 창 절대값: from/to 커스텀 기간으로 호출 — 달력이 지나도 영구 불변.
//   ⓔ-2 상대기간(7d/30d/90d): 절대값 대신 "원천 SQL 독립 대조"(테스트 소유 화이트리스트·
//       테스트가 직접 계산한 창) — 어느 날짜에 돌려도 창 시프트·JOIN 소실·스코프 누수 적발.
//   (과거: 상대기간에 절대값을 박아 달력 경과로 자연 붕괴 — 2026-07-03 content@7d 44→39.)
// ──────────────────────────────────────────────────────────────────────────
test('REG-DRILL-e1: uid3 고정 창(2026-04-01~07-02) 절대값 (bucket × 세그먼트)', async () => {
  const win = `&from=${GT_FIXED.from}&to=${GT_FIXED.to}`;
  const actual = {};
  for (const b of BUCKETS) {
    const r = await req(`/perform/detail?bucket=${b}${win}`, STUDENT1);
    assert.equal(r.status, 200, `${b}@fixed 200`);
    assert.equal(r.json.count, GT_FIXED[b], `uid3 ${b}@고정창 count=${GT_FIXED[b]} 이어야 (현재 ${r.json.count})`);
    actual[b] = r.json.count;
  }
  // [재감리 2026-07-31] 과거 이 줄은 `assert.equal(GT_FIXED.all, sum4)` — 상수끼리의 비교(50===50)라
  //   I/O 가 전혀 없었다. 소스가 어떻게 깨져도 절대 붉어지지 않는 죽은 단언이면서
  //   주석은 "조회·진도 혼입 시 즉시 빨간불" 이라 광고했다.
  //   → **API 가 실제로 돌려준 값끼리** 대조한다. bucket=all 에 조회(content_view)나
  //     진도(lesson_progress)가 섞이면 all 이 4버킷 합을 초과해 여기서 즉시 터진다.
  const sum4 = SUM_BUCKETS.reduce((s, b) => s + actual[b], 0);
  assert.equal(actual.all, sum4,
    `API 실측 정합: all(${actual.all}) == ${SUM_BUCKETS.join('+')}(${sum4}) — 초과분은 조회·진도 혼입`);
});

test('REG-DRILL-e2: uid3 상대기간(7d/30d/90d) — 원천 SQL 독립 대조 (달력 무관)', async () => {
  const tdb = openTestDb();
  // 창을 테스트가 독립 계산(resolvePeriod 문서 규약: today-n .. today, UTC ISO).
  //   라우트가 창 산식을 바꾸면 여기와 어긋나 빨간불(의도된 감시 — P2 오프바이원 주석 참조).
  const toIso = (d) => d.toISOString().slice(0, 10);
  for (const p of PERIODS) {
    const n = parseInt(p, 10);
    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - n);
    const from = toIso(start), to = toIso(today);
    for (const b of BUCKETS) {
      const types = BUCKET_TYPES_MIRROR[b];
      const ph = types.map(() => '?').join(',');
      const expected = tdb.prepare(`
        SELECT COUNT(*) c FROM learning_logs
        WHERE user_id = ? AND activity_type IN (${ph})
          AND DATE(created_at) >= ? AND DATE(created_at) <= ?
      `).get(STUDENT1, ...types, from, to).c;
      const r = await detail(b, p);
      assert.equal(r.json.count, expected, `uid3 ${b}@${p}: count(${r.json.count}) != 원천 SQL(${expected})`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓕ 점수 정규화 — score 0~100 또는 null. 조회(view)/수업(lesson)은 null.
// ──────────────────────────────────────────────────────────────────────────
test('INV-DRILL-f: score ∈ [0,100] 또는 null; content 조회·수업은 항상 null', async () => {
  for (const p of PERIODS) {
    for (const b of BUCKETS) {
      const r = await detail(b, p);
      for (const it of (r.json.items || [])) {
        if (it.score != null) {
          assert.ok(Number.isFinite(it.score), `${b}@${p} score=${it.score} 유한수`);
          assert.ok(it.score >= 0 && it.score <= 100, `${b}@${p} score=${it.score} 는 0~100`);
        }
      }
    }
    // content 조회/수업 세그먼트는 점수 없음 → 전부 null
    for (const seg of ['view', 'lesson']) {
      const s = await detail('content', p, STUDENT1, `&segment=${seg}`);
      for (const it of (s.json.items || [])) {
        assert.equal(it.score, null, `content/${seg}@${p} 는 점수 개념 없음 → score 는 null (현재 ${it.score})`);
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓖ 정렬(최신순) · 권한 · 잘못된 파라미터
// ──────────────────────────────────────────────────────────────────────────
test('INV-DRILL-g1: items 최신순(created_at DESC)', async () => {
  const r = await detail('all', '90d');
  const dates = (r.json.items || []).map(it => it.date);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i - 1] >= dates[i], `최신순 위반: ${dates[i - 1]} < ${dates[i]}`);
  }
});

test('PERM-DRILL-g2: 학생은 본인만(타 학생 403), 잘못된 bucket 400', async () => {
  const own = await detail('exam', '30d', STUDENT1);
  assert.equal(own.status, 200, '본인 조회 200');
  const other = await req(`/perform/detail?bucket=exam&period=30d&userId=${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '학생이 타 학생(userId) 조회는 403');
  const bad = await detail('bogus', '30d', STUDENT1);
  assert.equal(bad.status, 400, '잘못된 bucket 은 400');
});

test('PERM-DRILL-g3: 교사·관리자는 학생 drill-down 조회 가능(200)', async () => {
  // ground-truth 는 고정 창 절대값(GT_FIXED — 달력 불변)으로 대조.
  const win = `&from=${GT_FIXED.from}&to=${GT_FIXED.to}`;
  const byTeacher = await req(`/perform/detail?bucket=all${win}&userId=${STUDENT1}`, TEACHER);
  assert.equal(byTeacher.status, 200, '교사는 학생 조회 200');
  assert.equal(byTeacher.json.count, GT_FIXED.all, '교사 조회 count 도 ground-truth(고정 창) 일치');
  const byAdmin = await req(`/perform/detail?bucket=all${win}&userId=${STUDENT1}`, ADMIN);
  assert.equal(byAdmin.status, 200, '관리자는 학생 조회 200');
});
