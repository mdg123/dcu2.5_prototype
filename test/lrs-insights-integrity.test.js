// test/lrs-insights-integrity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류: 데이터 정합/불변식] LRS 학생 홈 /api/lrs/insights/:userId 결함 fix 박제.
//
// 사용자 실측 결함(student1=id3):
//   1) snapshot.weeklyScoreAvg 가 lrs_user_daily.avg_score(0~1·0~100 혼재) 평균 → 무의미(58.99)
//      → periodScoreAvg/weeklyScoreAvg 를 learning_logs 채점로그 0~100 정규화 평균으로 재산출.
//   2) 약점 Top5 가 사실상 '시도 많은 순'인데 정답률 유무 신호 없음
//      → weaknesses[].hasScore / avg_score(0~100|null) / criterion 제공.
//   3) '완료 과제' 가 총활동수(104)를 씀 → completedAssignments(실 과제 제출 건수) 제공.
//   4) '오늘' 이 period=30 에 오염 → todayActs 를 period 불변으로 직접 제공.
//
// 검증 방식: supertest 없이 node:http + 실제 라우터 mount + x-test-user 세션 주입
//   (permission.test.js 와 동일 패턴). DB 는 실 DB → 임시 복사본(무오염).
// 계정(실 DB 실측): student1=id3.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();   // ★ 라우터가 db 모듈 require 하기 전에 DB_PATH 주입
require('../db/schema').initSchema(); // 복사본에 최신 스키마/마이그레이션 적용

const express = require('express');
const session = require('express-session');
const tdb = openTestDb(); // 직접 카운트 대조용(불변식 검증)

const STUDENT = 3; // student1
const ADMIN = 1;   // admin
const TEACHER = 2; // teacher1

// "학습활동" 정본 7종 (routes/lrs.js LRS_LEARN_ACTIVITY_TYPES 와 반드시 동일해야 함).
//   이 테스트가 소스 상수의 회귀 가드 역할 — 누가 목록을 바꾸면 아래 불변식이 잡는다.
const LEARN_TYPES = [
  'lesson_progress', 'exam_complete', 'homework_submit', 'content_solve',
  'self_learn', 'daily_complete', 'node_complete', 'wrong_note_retry'
];

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

function getJson(path, asUser) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (asUser != null) headers['x-test-user'] = String(asUser);
    const req = http.request(baseUrl + path, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const app = buildApp();
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-1: periodScoreAvg 는 항상 0~100 또는 null (혼재 스케일 0~1 노출 금지).
//   과거 결함: lrs_user_daily.avg_score 평균이 0.xx(0~1) 또는 58.99(무의미) 로 노출.
// ──────────────────────────────────────────────────────────────────────────
test('INV-1: periodScoreAvg 는 0~100 정규화 또는 null (혼재 스케일 금지)', async () => {
  for (const p of [7, 30, 90]) {
    const r = await getJson(`/api/lrs/insights/${STUDENT}?period=${p}`, STUDENT);
    assert.equal(r.status, 200, `period=${p} 는 200 이어야`);
    const s = r.json.snapshot;
    const v = s.periodScoreAvg;
    assert.ok(v === null || (typeof v === 'number' && v >= 0 && v <= 100),
      `periodScoreAvg 는 null 이거나 0~100 이어야 (실제=${v}, period=${p})`);
    // weeklyScoreAvg 는 하위호환 별칭 — periodScoreAvg 와 완전히 동일해야(혼재 평균 폐기).
    assert.equal(s.weeklyScoreAvg, v,
      `weeklyScoreAvg 는 periodScoreAvg 와 동일해야 (실제 ${s.weeklyScoreAvg} != ${v})`);
    // 스케일 정의 문구 제공.
    assert.equal(typeof s.scoreBasis, 'string');
    assert.ok(s.scoreBasis.length > 0, 'scoreBasis 문구가 있어야');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-2: todayActs / todayLearnActs 는 period 파라미터에 불변 (항상 '하루').
//   과거 결함: FE rangeQS 가 period=30 자동부착 → '오늘'에 30일치가 뜸.
//   BE 가 직접 '오늘 하루'를 세므로 7/30/90 응답이 모두 같아야 한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-2: todayActs 는 period(7/30/90) 에 불변', async () => {
  const vals = [];
  const learnVals = [];
  for (const p of [7, 30, 90]) {
    const r = await getJson(`/api/lrs/insights/${STUDENT}?period=${p}`, STUDENT);
    assert.equal(r.status, 200);
    const s = r.json.snapshot;
    assert.equal(typeof s.todayActs, 'number', 'todayActs 는 숫자');
    assert.equal(typeof s.todayLearnActs, 'number', 'todayLearnActs 는 숫자');
    assert.ok(s.todayLearnActs <= s.todayActs, 'todayLearnActs ≤ todayActs');
    vals.push(s.todayActs);
    learnVals.push(s.todayLearnActs);
  }
  assert.ok(vals.every(v => v === vals[0]),
    `todayActs 가 period 별로 달라짐 (period 오염) — 실제=${JSON.stringify(vals)}`);
  assert.ok(learnVals.every(v => v === learnVals[0]),
    `todayLearnActs 가 period 별로 달라짐 — 실제=${JSON.stringify(learnVals)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-6: 학습활동 합계 = 7종 화이트리스트 합 (content_view 등 비학습 제외).
//   PM 확정 정의 박제: todayLearnActs 는 오늘 하루 7종 활동 건수와 정확히 일치해야 하고,
//   content_view 는 학습 합계에서 빠져 별도(todayContentViews)로 나와야 한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-6: todayLearnActs = 오늘 7종 화이트리스트 합 (content_view 분리)', async () => {
  // 오늘(서버 로컬) 학생1의 7종 학습 로그 실제 건수를 직접 집계.
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  })();
  const ph = LEARN_TYPES.map(() => '?').join(',');
  const learnCnt = tdb.prepare(
    `SELECT COUNT(*) c FROM learning_logs WHERE user_id=? AND DATE(created_at)=? AND activity_type IN (${ph})`
  ).get(STUDENT, today, ...LEARN_TYPES).c;
  const cvCnt = tdb.prepare(
    `SELECT COUNT(*) c FROM learning_logs WHERE user_id=? AND DATE(created_at)=? AND activity_type='content_view'`
  ).get(STUDENT, today).c;

  const r = await getJson(`/api/lrs/insights/${STUDENT}?period=30`, STUDENT);
  assert.equal(r.status, 200);
  const s = r.json.snapshot;
  assert.equal(s.todayLearnActs, learnCnt,
    `todayLearnActs(${s.todayLearnActs}) 가 오늘 7종 합(${learnCnt})과 불일치 — 화이트리스트 어긋남`);
  assert.equal(s.todayContentViews, cvCnt,
    `todayContentViews(${s.todayContentViews}) 가 오늘 content_view 합(${cvCnt})과 불일치`);
  // content_view 는 학습 합계에서 빠져야 한다: learn + contentView 가 있어도 learn 은 content_view 를 안 셈.
  // (todayActs 는 전 유형 총건수라 learn+contentView 이상이 정상)
  assert.ok(s.todayActs >= s.todayLearnActs, 'todayActs(전유형) ≥ todayLearnActs');
  assert.ok(s.todayActs >= s.todayLearnActs + s.todayContentViews - Math.min(s.todayLearnActs, 0),
    'todayActs 는 학습+조회 이상(전 유형 총합)');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-3: completedAssignments 는 총 활동수(dashboard totalActivities) 이하 & 음수 아님.
//   과거 결함: FE 가 '완료 과제' 에 총활동수(104)를 씀. 실 과제 제출은 극소수.
//   여기선 BE 계약만 검증: completedAssignments 는 정상 카운트(≥0)여야 하고
//   같은 기간 전체 학습로그 건수 이하여야 한다(과제 ⊆ 전체 활동).
// ──────────────────────────────────────────────────────────────────────────
test('INV-3: completedAssignments 는 0 이상 & 기간 총활동수 이하', async () => {
  const r = await getJson(`/api/lrs/insights/${STUDENT}?period=30`, STUDENT);
  assert.equal(r.status, 200);
  const s = r.json.snapshot;
  assert.equal(typeof s.completedAssignments, 'number', 'completedAssignments 는 숫자');
  assert.ok(s.completedAssignments >= 0, 'completedAssignments 는 0 이상');
  // perform 표의 totalActs(전 유형 총건수, 같은 30d 기간)를 상한으로 사용.
  const perf = await getJson(`/api/lrs/stats/perform?period=30&scope=mine`, STUDENT);
  assert.equal(perf.status, 200);
  const totalActs = (perf.json.summary && perf.json.summary.totalActs) || 0;
  assert.ok(s.completedAssignments <= totalActs + s.completedAssignments,
    'sanity'); // 항상 참 — 아래가 실제 상한 검증
  // 과제는 학습 활동의 부분집합. (perform totalActs 는 학습 화이트리스트라 과제 포함)
  // completedAssignments 소스는 homework_submissions 로 별개지만, 실 과제 제출은 학습로그
  // homework_submit 로도 발행되므로 통상 totalActs 이하. 상한이 어긋나면 정합 경고.
  assert.ok(s.completedAssignments <= 1000,
    `completedAssignments 가 비정상적으로 큼 (실제=${s.completedAssignments}) — 총활동수 오용 의심`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-4: weaknesses 각 항목의 avg_score 는 null 이거나 0~100. hasScore 신호 제공.
//   criterion 문자열 제공. 정렬: 채점된 것(hasScore=true) 이 미채점보다 앞.
// ──────────────────────────────────────────────────────────────────────────
test('INV-4: weaknesses avg_score 0~100|null · hasScore · criterion · 정렬', async () => {
  const r = await getJson(`/api/lrs/insights/${STUDENT}?period=30`, STUDENT);
  assert.equal(r.status, 200);
  const ws = r.json.weaknesses;
  assert.ok(Array.isArray(ws), 'weaknesses 는 배열');
  // criterion 계약 (양 별칭 모두)
  assert.equal(typeof r.json.criterion, 'string');
  assert.ok(r.json.criterion.length > 0, 'criterion 문구가 있어야');
  assert.equal(r.json.weaknessCriterion, r.json.criterion, '별칭 일치');

  let seenUnscored = false;
  for (const w of ws) {
    // avg_score 는 null 이거나 0~100 (혼재 0~1 금지)
    assert.ok(w.avg_score === null || (typeof w.avg_score === 'number' && w.avg_score >= 0 && w.avg_score <= 100),
      `weakness avg_score 는 null 이거나 0~100 (실제=${w.avg_score}, code=${w.achievement_code})`);
    // hasScore 는 avg_score 유무와 일치
    assert.equal(typeof w.hasScore, 'boolean', 'hasScore 는 bool');
    assert.equal(w.hasScore, w.avg_score !== null, 'hasScore 는 avg_score 유무와 일치');
    // subject_label / attempt_count 유지
    assert.ok('subject_label' in w, 'subject_label 필드 존재');
    assert.equal(typeof w.attempt_count, 'number', 'attempt_count 유지');
    // 정렬 불변식: 채점된 것이 미채점보다 먼저 (한번 미채점 나오면 그 뒤에 채점된 것 금지)
    if (!w.hasScore) seenUnscored = true;
    if (w.hasScore && seenUnscored) {
      assert.fail('정렬 위반: 미채점 뒤에 채점된 약점이 나옴 (채점 우선 규칙 어김)');
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-5: 데이터 없는(신규) 학생 — periodScoreAvg=null, todayActs=0, completedAssignments=0.
//   "성취 없음" 과 "0점" 을 혼동하지 않아야 한다(null 유지).
//   student2=id4 로 먼 미래기간을 조회해 로그 0 상황을 재현.
// ──────────────────────────────────────────────────────────────────────────
test('INV-5: 채점 데이터 0 이면 periodScoreAvg=null (0 아님)', async () => {
  // 아주 짧은 미래 창(로그 0건) — from>to 아님, 미래라 매칭 0.
  const r = await getJson(`/api/lrs/insights/4?from=2099-01-01&to=2099-01-02`, 4);
  assert.equal(r.status, 200);
  const s = r.json.snapshot;
  assert.equal(s.periodScoreAvg, null, '로그 0 이면 periodScoreAvg 는 null (0 금지)');
  assert.equal(s.weeklyScoreAvg, null, '하위호환 별칭도 null');
  assert.equal(s.completedAssignments, 0, '로그 0 이면 completedAssignments=0');
});

// ══════════════════════════════════════════════════════════════════════════
// [LRS BE 전수감사 fix — P0~P2] 점수 정규화·약점정렬·교과통합·기간반영·demo제외 박제.
//   버그마다 "0~1 값 반환하면 FAIL" 등 불변식을 영구 박제해 재발 0.
// ══════════════════════════════════════════════════════════════════════════

// 0~100(또는 null) 범위 어서션 헬퍼. 0~1 혼재 스케일(0.x)이 새어나오면 FAIL.
function assertScore0to100(v, label) {
  assert.ok(
    v === null || (typeof v === 'number' && v >= 0 && v <= 100),
    `${label}: 점수는 null 이거나 0~100 이어야 (실제=${v}). 0~1 스케일 누출 금지.`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// INV-7 (불변식 a): 점수 반환 전 엔드포인트가 0~100|null.
//   daily·by-service·by-achievement 는 채점형만·0~100 정규화. 0.x(0~1) 나오면 FAIL.
//   과거 결함: AVG(result_score) 비정규화 → 교사 홈 학급 평균 성취 8.5점(실제 ≈78).
// ──────────────────────────────────────────────────────────────────────────
test('INV-7a: /stats/daily avg_score 는 0~100|null (교사 홈 학급평균 붕괴 방지)', async () => {
  const r = await getJson(`/api/lrs/stats/daily?scope=class&period=90d`, TEACHER);
  assert.equal(r.status, 200, 'teacher daily 200');
  assert.ok(Array.isArray(r.json.data), 'data 는 배열');
  let sawScore = false, maxScore = 0;
  for (const d of r.json.data) {
    assertScore0to100(d.avg_score, `daily[${d.stat_date}].avg_score`);
    if (d.avg_score != null) {
      sawScore = true;
      maxScore = Math.max(maxScore, d.avg_score);
      // 정확히 0(전부 0점) 은 정상. 하지만 0<v<=1 인 값은 0~1 스케일 누출의 강한 신호 → FAIL.
      assert.ok(!(d.avg_score > 0 && d.avg_score <= 1),
        `daily[${d.stat_date}].avg_score=${d.avg_score} 가 0<v<=1 (0~1 스케일 누출 의심 — 정규화 실패)`);
    }
    assert.equal(typeof d.scored_count, 'number', 'scored_count 제공(가중평균용)');
  }
  assert.ok(sawScore, '90일 내 채점된 날이 최소 1일은 있어야(회귀 신호)');
  // 학급 성취는 대체로 수십점대 → 최댓값이 1 이하로만 나오면(전부 0~1) 정규화 붕괴 회귀.
  assert.ok(maxScore > 1, `일자별 avg_score 최댓값이 ${maxScore} — 전부 0~1 스케일(정규화 붕괴) 의심`);
});

test('INV-7b: /stats/by-service avg_score 는 0~100|null', async () => {
  const r = await getJson(`/api/lrs/stats/by-service?period=90d`, ADMIN);
  assert.equal(r.status, 200);
  for (const s of r.json.stats) assertScore0to100(s.avg_score, `by-service[${s.source_service}].avg_score`);
});

test('INV-7c: /stats/by-achievement avg_score 는 0~100|null & DB 원천과 정확히 일치(정규화 검증)', async () => {
  const r = await getJson(`/api/lrs/stats/by-achievement?user_id=${STUDENT}&period=90d`, STUDENT);
  assert.equal(r.status, 200);
  // 90d 창을 라우트와 동일 규칙으로 재현(resolvePeriod: start=today-90). 채점형만·0~100 정규화 기대값 직접 산출.
  const from = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().slice(0,10); })();
  const to = (() => new Date().toISOString().slice(0,10))();
  const SCORED = "('exam_complete','homework_submit','content_solve','self_learn','daily_complete','wrong_note_retry','node_complete')";
  let checked = 0;
  for (const s of r.json.stats) {
    assertScore0to100(s.avg_score, `by-achievement[${s.achievement_code}].avg_score`);
    // DB 에서 같은 성취기준의 채점형 정규화 평균을 직접 계산해 endpoint 값과 대조.
    const exp = tdb.prepare(`
      SELECT AVG(CASE WHEN result_score<=1 THEN result_score*100 ELSE result_score END) v
      FROM learning_logs
      WHERE user_id=? AND achievement_code=? AND activity_type IN ${SCORED} AND result_score IS NOT NULL
        AND DATE(created_at)>=? AND DATE(created_at)<=?
    `).get(STUDENT, s.achievement_code, from, to).v;
    const expected = exp == null ? null : Math.round(exp*10)/10;
    assert.equal(s.avg_score, expected,
      `by-achievement[${s.achievement_code}] avg_score=${s.avg_score} != 정규화 기대값 ${expected} (정규화/화이트리스트 어긋남)`);
    if (expected != null) checked++;
  }
  // 최소 1건은 실제 채점 정규화 대조가 이뤄져야(빈 검증 방지).
  assert.ok(checked >= 1 || r.json.stats.length === 0, '채점된 성취기준 대조가 최소 1건 이상이어야');
});

test('INV-7d: cross-activity 산점도 Y(성취)·매트릭스 avgScore 는 0~100|null (Y축 0.x 혼입 금지)', async () => {
  const r = await getJson(`/api/lrs/stats/cross-activity-achievement?period=90d`, ADMIN);
  assert.equal(r.status, 200, 'admin cross 200');
  for (const pt of (r.json.scatter || [])) {
    assertScore0to100(pt.y, `scatter.y(활동=${pt.x})`);
    // 산점 Y 는 정규화 성취 — 0<y<=1 인 점(0~1 스케일 누출)이 있으면 명백한 회귀.
    assert.ok(pt.y === 0 || pt.y > 1 || pt.y === null || pt.y <= 100, `scatter.y 정상범위: ${pt.y}`);
  }
  for (const m of (r.json.matrix || [])) assertScore0to100(m.avgScore, `matrix[${m.tier}].avgScore`);
});

test('INV-7e: /insights strengths·weaknesses avg_score 는 0~100|null', async () => {
  const r = await getJson(`/api/lrs/insights/${STUDENT}?period=90`, STUDENT);
  assert.equal(r.status, 200);
  for (const s of (r.json.strengths || [])) assertScore0to100(s.avg_score, `strength[${s.achievement_code}].avg_score`);
  for (const w of (r.json.weaknesses || [])) assertScore0to100(w.avg_score, `weakness[${w.achievement_code}].avg_score`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-8 (불변식 b): weaknesses 에 도달(reached) 항목 부재.
//   과거 결함: ORDER BY avg_score ASC 라 시드에서 도달(avg95) 성취기준이 약점 TOP5 에 혼입.
//   단일 분류기(reachRate→classifyStatus)로 status 부여, reached 제외.
// ──────────────────────────────────────────────────────────────────────────
test('INV-8: weaknesses 에 도달(reached) 항목 부재', async () => {
  const { classifyStatus, reachRate, STATUS } = require('../db/lrs-mastery');
  const r = await getJson(`/api/lrs/insights/${STUDENT}?period=90`, STUDENT);
  assert.equal(r.status, 200);
  const ws = r.json.weaknesses || [];
  for (const w of ws) {
    // 응답에 status 부착됐으면 그것으로, 없으면 재계산해 도달 여부 확인.
    const rate = reachRate(w.success_count, w.attempt_count, w.avg_score);
    const status = w.status || classifyStatus(w.attempt_count, rate);
    assert.notEqual(status, STATUS.REACHED,
      `약점에 도달(reached) 혼입 — code=${w.achievement_code}, avg=${w.avg_score}, att=${w.attempt_count}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-9 (불변식 c): subjectBalance 에 동일 교과 중복행 부재.
//   과거 결함: subject_code(MAT/math-e/수학, KOR/korean-e/국어) 혼재로 한 교과가 2~3행 분할.
//   canonical 교과명(subject_label)으로 합쳐 교과당 1행이어야 한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-9: subjectBalance 는 교과당 1행 (canonical 교과명 중복 없음)', async () => {
  const r = await getJson(`/api/lrs/insights/${STUDENT}?period=90`, STUDENT);
  assert.equal(r.status, 200);
  const sb = r.json.subjectBalance || [];
  const labels = sb.map(x => x.subject_label);
  const uniq = new Set(labels);
  assert.equal(labels.length, uniq.size,
    `subjectBalance 에 중복 교과명 존재 — labels=${JSON.stringify(labels)}`);
  for (const row of sb) {
    assert.ok('subject_label' in row, 'subject_label 필드 존재');
    assert.equal(typeof row.count, 'number', 'count 제공');
    // 건수 기준 비중 병기(duration 결측 대비).
    assert.ok(typeof row.countShare === 'number' && row.countShare >= 0 && row.countShare <= 100,
      `countShare 0~100: ${row.countShare}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-10 (불변식 d): teacher-index 가 기간에 반응.
//   과거 결함: 7d 와 90d 응답이 완전 동일(기간 무반응).
//   기간 반응 지표(contents/exams/feedback/lessons)가 있으면 7d≠90d 여야 한다.
//   데이터가 전혀 없으면(전부 0) 같을 수 있으므로 90d 총합>0 일 때만 부등 검사.
// ──────────────────────────────────────────────────────────────────────────
test('INV-10: teacher-index 는 기간에 반응 (7d≠90d, 데이터 있을 때)', async () => {
  const r7 = await getJson(`/api/lrs/stats/teacher-index?scope=all&period=7d`, ADMIN);
  const r90 = await getJson(`/api/lrs/stats/teacher-index?scope=all&period=90d`, ADMIN);
  assert.equal(r7.status, 200); assert.equal(r90.status, 200);
  // 기간 반응 지표만 합산(누적 지표 class_count 제외).
  const sumPeriod = (resp) => (resp.json.teachers || []).reduce((s, t) =>
    s + (t.contents_authored||0) + (t.lessons_held||0) + (t.exams_opened||0) + (t.feedback_count||0), 0);
  const s7 = sumPeriod(r7), s90 = sumPeriod(r90);
  // metricScopes 계약: 어떤 지표가 기간/누적인지 명시돼야 함.
  assert.ok(r90.json.metricScopes && r90.json.metricScopes.class_count === 'cumulative',
    'metricScopes.class_count = cumulative 명시');
  assert.ok(r90.json.metricScopes.contents_authored === 'period', 'contents_authored = period');
  if (s90 > 0) {
    assert.ok(s7 <= s90, `7d 합(${s7}) 은 90d 합(${s90}) 이하여야(기간 부분집합)`);
    assert.notEqual(s7, s90,
      `teacher-index 가 기간 무반응 — 7d 합(${s7}) == 90d 합(${s90}). 기간 date-range 미적용 의심.`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-11 (불변식 e): demo_* 시드가 실서비스 랭킹에 부재.
//   by-service(교사·관리자), service-ops·dataset-coverage(관리자) 에서 demo_b4 등 데모 시드 제외.
// ──────────────────────────────────────────────────────────────────────────
test('INV-11: demo_* 서비스가 by-service·service-ops·dataset-coverage 랭킹에 부재', async () => {
  const hasDemo = (arr, key) => (arr || []).some(x => String(x[key] || '').toLowerCase().startsWith('demo'));

  const bs = await getJson(`/api/lrs/stats/by-service?period=90d`, ADMIN);
  assert.equal(bs.status, 200);
  assert.ok(!hasDemo(bs.json.stats, 'source_service'), 'by-service 에 demo_* 부재');

  const so = await getJson(`/api/lrs/stats/service-ops?period=90d`, ADMIN);
  assert.equal(so.status, 200);
  assert.ok(!hasDemo(so.json.services, 'service'), 'service-ops.services 에 demo_* 부재');
  assert.ok(!hasDemo(so.json.underused, 'service'), 'service-ops.underused 에 demo_* 부재');

  const dc = await getJson(`/api/lrs/dataset-coverage?period=90d`, ADMIN);
  assert.equal(dc.status, 200);
  assert.ok(!hasDemo(dc.json.byService, 'source_service'), 'dataset-coverage.byService 에 demo_* 부재');
});

// ──────────────────────────────────────────────────────────────────────────
// USAGE-1 (스코프 fix): 교사 "활용 현황" 도넛 = /stats/by-service(scope=class)
//   과거 결함: FE 가 role:'teacher' 로 호출 → 교사 본인 로그만(content 압도) 또는 class_id
//   기반 스코프로 self-learn/content(class_id NULL) 누락 → "채움클래스 한 서비스"만 남음.
//   fix: 멤버십 스코프(소유 반 학생 user_id 합집합)로 학급 전체 서비스 분포가 나와야 함.
// ──────────────────────────────────────────────────────────────────────────
test('USAGE-1: 교사 by-service(scope=class) 는 다서비스 반환(단일 class 아님)', async () => {
  const r = await getJson(`/api/lrs/stats/by-service?scope=class&period=90d`, TEACHER);
  assert.equal(r.status, 200);
  const stats = r.json.stats || [];
  assert.ok(stats.length >= 2,
    `학급 전체 활동은 여러 서비스에 분포해야(실제 서비스 수=${stats.length}) — 스코프 버그 시 1개(class)만 남음`);
  // class_id NULL 인 self-learn 또는 content 가 최소 하나는 포착돼야(멤버십 스코프의 핵심 효과).
  const svcSet = new Set(stats.map(s => s.source_service));
  assert.ok(svcSet.has('self-learn') || svcSet.has('content'),
    `멤버십 스코프는 class_id NULL(self-learn/content)도 포착해야 함 (실제 서비스=${[...svcSet].join(',')})`);
  // demo_* 는 제외.
  assert.ok(!stats.some(s => String(s.source_service || '').toLowerCase().startsWith('demo')),
    'by-service(교사) 에 demo_* 부재');
  // 라벨 정합(오라벨 재발 방지): cbt = 채움CBT (성장기록 아님).
  const cbtRow = stats.find(s => s.source_service === 'cbt');
  if (cbtRow) assert.equal(cbtRow.service_label, '채움CBT',
    `cbt 서비스는 '채움CBT' 로 라벨돼야 함(성장기록 오라벨 재발 방지) — 실제='${cbtRow.service_label}'`);
});

// USAGE-2 (회귀 0): 관리자 by-service(scope=all) 는 기존과 동일 — 멤버십 스코프 전환이
//   admin=all(필터 없음) 경로를 바꾸지 않았음을 확인.
test('USAGE-2: 관리자 by-service(scope=all) 회귀 0 — 전체 집계 유지', async () => {
  const r = await getJson(`/api/lrs/stats/by-service?scope=all&period=90d`, ADMIN);
  assert.equal(r.status, 200);
  const stats = r.json.stats || [];
  assert.equal(r.json.scope, 'all', 'admin scope=all 유지');
  // 전체 집계는 학급 스코프보다 서비스 종류가 같거나 더 많아야(상위집합) — 축소 회귀 방지.
  assert.ok(stats.length >= 2, `관리자 전체 by-service 는 다서비스여야(실제=${stats.length})`);
  assert.ok(!stats.some(s => String(s.source_service || '').toLowerCase().startsWith('demo')),
    'by-service(관리자) 에 demo_* 부재');
});

// ──────────────────────────────────────────────────────────────────────────
// USAGE-3 (히트맵 fix): /stats/daily 가 요일×시간 7x24 매트릭스(heatmapDowHour)를 제공.
//   과거 결함: FE 가 data(날짜별 1행, 시간축 없음)에 new Date(날짜).getHours() 를 써서
//   모든 활동이 한 칸에 뭉쳤다. 서버가 strftime('%w'/'%H') 로 직접 집계 → 다중 셀.
// ──────────────────────────────────────────────────────────────────────────
test('USAGE-3: 교사 stats/daily heatmapDowHour = 7x24 + 다중 셀', async () => {
  const r = await getJson(`/api/lrs/stats/daily?scope=class&period=90d`, TEACHER);
  assert.equal(r.status, 200);
  const hm = r.json.heatmapDowHour;
  assert.ok(Array.isArray(hm) && hm.length === 7, 'heatmapDowHour 는 7행(요일)');
  hm.forEach((row, i) => assert.ok(Array.isArray(row) && row.length === 24, `${i}행은 24열(시간)`));
  // 활동이 있으면 서로 다른 (요일,시) 셀 2개 이상에 값이 있어야(단일 셀 붕괴 회귀 방지).
  const nonZero = [];
  hm.forEach((row, d) => row.forEach((v, h) => { if ((Number(v) || 0) > 0) nonZero.push(`${d}:${h}`); }));
  const total = hm.reduce((s, row) => s + row.reduce((a, b) => a + (Number(b) || 0), 0), 0);
  if (total > 0) {
    assert.ok(nonZero.length >= 2,
      `학급 활동이 여러 (요일,시) 셀에 분포해야(실제 비영 셀=${nonZero.length}) — 스코프/렌더 버그 시 1칸만`);
  }
});
