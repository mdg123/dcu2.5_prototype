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
// ground-truth 표(직전 확인, uid3=student1):
//   period | exam | homework | self | content(view+lesson+solve) | all
//   7d     |  0   |    0     |  7   |  44 (23+14+7)              | 51
//   30d    | 29   |    2     | 10   |  45 (23+15+7)              | 86
//   90d    | 29   |    2     | 10   |  45 (23+15+7)              | 86
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const BUCKETS = ['exam', 'homework', 'self', 'content', 'all'];
const PERIODS = ['7d', '30d', '90d'];

// ground-truth 절대값(uid3). period → bucket → count.
const GT = {
  '7d':  { exam: 0,  homework: 0, self: 7,  content: 44, all: 51,
           seg: { view: 23, lesson: 14, solve: 7 } },
  '30d': { exam: 29, homework: 2, self: 10, content: 45, all: 86,
           seg: { view: 23, lesson: 15, solve: 7 } },
  '90d': { exam: 29, homework: 2, self: 10, content: 45, all: 86,
           seg: { view: 23, lesson: 15, solve: 7 } },
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
  const cardField = { exam: 'examCount', homework: 'homeworkCount', self: 'selfLearnCount', content: 'contentCount', all: 'totalActs' };
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
test('INV-DRILL-d: content 세그먼트 합 == content.count, ?segment 필터 count 일치', async () => {
  for (const p of PERIODS) {
    const content = await detail('content', p);
    assert.ok(Array.isArray(content.json.segments), `content@${p} segments 배열`);
    const segSum = content.json.segments.reduce((s, x) => s + x.count, 0);
    assert.equal(segSum, content.json.count, `세그먼트 합(${segSum}) != content(${content.json.count}) @${p}`);

    // ?segment=view|lesson|solve 각각의 count == 세그먼트 소계 == items.length
    for (const seg of ['view', 'lesson', 'solve']) {
      const s = await detail('content', p, STUDENT1, `&segment=${seg}`);
      const declared = content.json.segments.find(x => x.key === seg).count;
      assert.equal(s.json.count, declared, `segment=${seg}@${p}: count(${s.json.count}) != 소계(${declared})`);
      assert.equal((s.json.items || []).length, s.json.count, `segment=${seg}@${p}: items.length != count`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓔ ground-truth 절대값 박제(uid3) — 30일 창 밖 은폐/이중카운트 회귀 차단
// ──────────────────────────────────────────────────────────────────────────
test('REG-DRILL-e: uid3 ground-truth 절대값 (period × bucket × 세그먼트)', async () => {
  for (const p of PERIODS) {
    const g = GT[p];
    for (const b of BUCKETS) {
      const r = await detail(b, p);
      assert.equal(r.json.count, g[b], `uid3 ${b}@${p} count=${g[b]} 이어야 (현재 ${r.json.count})`);
    }
    // content 세그먼트 소계 절대값
    const content = await detail('content', p);
    for (const seg of ['view', 'lesson', 'solve']) {
      const declared = content.json.segments.find(x => x.key === seg).count;
      assert.equal(declared, g.seg[seg], `uid3 content/${seg}@${p}=${g.seg[seg]} 이어야 (현재 ${declared})`);
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
  const byTeacher = await req(`/perform/detail?bucket=all&period=30d&userId=${STUDENT1}`, TEACHER);
  assert.equal(byTeacher.status, 200, '교사는 학생 조회 200');
  assert.equal(byTeacher.json.count, GT['30d'].all, '교사 조회 count 도 ground-truth 일치');
  const byAdmin = await req(`/perform/detail?bucket=all&period=30d&userId=${STUDENT1}`, ADMIN);
  assert.equal(byAdmin.status, 200, '관리자는 학생 조회 200');
});
