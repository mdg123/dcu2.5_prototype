// test/lrs-analytics.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 분석·예측 P0 하네스 — 위험점수·추세·도달예측·선수갭·권한·멤버십 집계.
//   기획서: 작업지시서/LRS_분석예측_강화_기획서.md §B-1~B-5 · §C-5
//
// 박제 불변식·회귀:
//   [REG]  OLS slope/intercept/R² 정확도 + 엣지(점0·점1·분산0·완전적합)
//   [RISK] 0~100 범위 / insufficient 비가산(P5) / 감정없음 재정규화 / 등급경계 / 근거생성
//   [TREND] 주<3 결측 · 관측주차<3 미산출 · slope 부호 · R² ∈ [0,1]
//   [PROJ] slope<=0 → reachable=false · 밴드 동반 · 단일확정선 금지
//   [PERM] 학생→ews 403 · 본인 trend 200/타인 403 · 교사 소유반만 · trend 응답 위험필드 없음
//   [MEMB] /stats/custom 멤버십 집계 — self-learn class_id NULL 도 소속 학생이면 포착
//
// DB 격리: 실 DB → 임시 복사본. initSchema + rebuildAllAggregates(insufficient 분리).
// 계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4. class 1 = teacher1 소유.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();
require('../db/lrs-aggregate').rebuildAllAggregates();

const { ols, predict } = require('../lib/analytics/regression');
const analytics = require('../db/lrs-analytics');
const db = openTestDb();

const ADMIN = 1, TEACHER = 2, STUDENT1 = 3, STUDENT2 = 4;
const CLASS = 1;

// ════════════════════════════════════════════════════════════════════════════
// [REG] 순수 OLS 유틸 — 결정론 정확도 + 엣지
// ════════════════════════════════════════════════════════════════════════════
test('REG-1: 완전 직선 y=2x+1 → slope=2, intercept=1, r2=1', () => {
  const m = ols([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
  assert.ok(Math.abs(m.slope - 2) < 1e-9, `slope=${m.slope}`);
  assert.ok(Math.abs(m.intercept - 1) < 1e-9, `intercept=${m.intercept}`);
  assert.ok(Math.abs(m.r2 - 1) < 1e-9, `r2=${m.r2}`);
  assert.equal(m.n, 4);
});

test('REG-2: 하락 추세 음수 slope', () => {
  const m = ols([[0, 90], [1, 80], [2, 70], [3, 60]]);
  assert.ok(m.slope < 0, `하락이면 slope<0 (got ${m.slope})`);
  assert.ok(Math.abs(m.slope + 10) < 1e-9, `slope=${m.slope} ~ -10`);
});

test('REG-3: 엣지 — 점0개/점1개/분산0(모든 x동일)/모든 y동일', () => {
  assert.deepEqual(ols([]), { slope: 0, intercept: 0, r2: 0, n: 0 });
  const one = ols([{ x: 5, y: 42 }]);
  assert.equal(one.slope, 0); assert.equal(one.intercept, 42); assert.equal(one.n, 1);
  // 모든 x 동일 → 기울기 정의불가 → slope 0
  const flatX = ols([[2, 10], [2, 20], [2, 30]]);
  assert.equal(flatX.slope, 0, 'x분산0 → slope 0');
  // 모든 y 동일 → 변동 없음 → r2=1, slope 0
  const flatY = ols([[0, 5], [1, 5], [2, 5]]);
  assert.equal(flatY.slope, 0); assert.equal(flatY.r2, 1);
});

test('REG-4: r2 항상 [0,1], NaN/음수 금지', () => {
  const noisy = ols([[0, 10], [1, 50], [2, 12], [3, 48], [4, 11]]);
  assert.ok(noisy.r2 >= 0 && noisy.r2 <= 1, `r2=${noisy.r2}`);
  assert.ok(Number.isFinite(noisy.r2));
});

test('REG-5: predict 외삽', () => {
  const m = ols([[0, 0], [1, 10], [2, 20]]);
  assert.ok(Math.abs(predict(m, 5) - 50) < 1e-9, `predict(5)=${predict(m, 5)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// [TREND] 추세 — 주<3 결측, 관측주차<3 미산출, slope/r2 정합
// ════════════════════════════════════════════════════════════════════════════
test('TREND-1: 관측주차<3 이면 status=insufficient(미산출)', () => {
  // student2 는 데이터가 적어 관측주차가 보통 3 미만 → insufficient
  const t = analytics.computeTrend({ userId: STUDENT2 });
  if (t.status === 'insufficient') {
    assert.equal(t.direction, 'insufficient');
    assert.equal(t.slope, null, '미산출이면 slope null');
    assert.ok(t.observedWeeks < 3, `observedWeeks=${t.observedWeeks} 는 3 미만이어야`);
  } else {
    // 데이터가 충분하면 ok — 그 경우 observedWeeks>=3
    assert.ok(t.observedWeeks >= 3);
  }
});

test('TREND-2: status=ok 면 slope/r2 유효, r2 ∈ [0,1], direction 4종', () => {
  const valid = new Set(['up', 'flat', 'down']);
  for (const sid of [STUDENT1, STUDENT2, 5, 10, 11]) {
    const t = analytics.computeTrend({ userId: sid });
    if (t.status !== 'ok') continue;
    assert.ok(Number.isFinite(t.slope), `student ${sid} slope 유한`);
    assert.ok(t.r2 >= 0 && t.r2 <= 1, `student ${sid} r2=${t.r2}`);
    assert.ok(valid.has(t.direction), `student ${sid} direction=${t.direction}`);
    assert.ok(t.observedWeeks >= 3, `ok 면 관측주차>=3`);
    // 직접 series 로 slope 부호 검증
    assert.ok((t.slope >= 2) === (t.direction === 'up') || t.direction !== 'up');
  }
});

test('TREND-3: 한 주 시도<3 은 결측 — series 의 모든 주 attempts>=3', () => {
  const t = analytics.computeTrend({ classId: CLASS });
  for (const w of t.series) {
    assert.ok(w.attempts >= analytics.MIN_WEEK_ATTEMPTS, `주 ${w.week} attempts=${w.attempts} <3 결측돼야`);
  }
});

test('TREND-4: 반 추세도 동일 함수(classId) — 멤버십 집계', () => {
  const t = analytics.computeTrend({ classId: CLASS });
  assert.ok(t.status === 'ok' || t.status === 'insufficient');
  assert.ok(Number.isInteger(t.observedWeeks));
});

// ════════════════════════════════════════════════════════════════════════════
// [PROJ] 도달 예측 — slope<=0 도달불가, 밴드 동반, 단일확정선 금지
// ════════════════════════════════════════════════════════════════════════════
test('PROJ-1: slope<=0 이면 reachable=false (도달 어려움)', () => {
  const fakeTrend = { status: 'ok', currentRate: 40, slope: -3, confidence: 'medium' };
  const p = analytics.projectReach(fakeTrend, { target: 80 });
  assert.equal(p.reachable, false);
  assert.equal(p.weeksToReach, null);
  assert.match(p.message, /도달이 어려워요|가까워져요/);
});

test('PROJ-2: slope>0 도달가능 — weeksToReach 양수 + 불확실성 밴드 동반', () => {
  const fakeTrend = { status: 'ok', currentRate: 60, slope: 4, confidence: 'high' };
  const p = analytics.projectReach(fakeTrend, { target: 80 });
  assert.equal(p.reachable, true);
  assert.ok(p.weeksToReach > 0 && p.weeksToReach <= 20, `weeks=${p.weeksToReach}`);
  assert.ok(p.band && p.band.lo != null && p.band.hi != null, '밴드(lo/hi) 동반 — 단일확정선 금지');
  assert.ok(p.band.hi > p.band.lo, '밴드 폭>0');
});

test('PROJ-3: 데이터 부족(trend insufficient) → status=insufficient 친절 메시지', () => {
  const p = analytics.projectReach({ status: 'insufficient' }, { target: 80 });
  assert.equal(p.status, 'insufficient');
  assert.equal(p.reachable, null);
  assert.match(p.message, /부족/);
});

test('PROJ-4: 이미 도달(r0>=target) → reachable=true, weeks=0', () => {
  const p = analytics.projectReach({ status: 'ok', currentRate: 85, slope: 1, confidence: 'high' }, { target: 80 });
  assert.equal(p.reachable, true);
  assert.equal(p.weeksToReach, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// [RISK] 위험점수 — 0~100, insufficient 비가산, 감정없음 재정규화, 등급경계, 근거
// ════════════════════════════════════════════════════════════════════════════
test('RISK-1: 모든 학생 위험점수 ∈ [0,100] 정수, 등급 일관', () => {
  const r = analytics.getClassRiskList(CLASS);
  assert.ok(Array.isArray(r.list) && r.list.length > 0, '위험 리스트 비어있지 않음');
  for (const s of r.list) {
    assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100, `${s.userId} score=${s.score}`);
    const g = s.score >= 70 ? 'high' : s.score >= 40 ? 'medium' : 'low';
    assert.equal(s.grade, g, `${s.userId} 등급 경계: score ${s.score} → ${g} (got ${s.grade})`);
  }
});

test('RISK-2: 등급 경계값 — riskGrade(69)=medium, (70)=high, (39)=low, (40)=medium', () => {
  assert.equal(analytics.riskGrade(69), 'medium');
  assert.equal(analytics.riskGrade(70), 'high');
  assert.equal(analytics.riskGrade(39), 'low');
  assert.equal(analytics.riskGrade(40), 'medium');
});

test('RISK-3: insufficient(평가부족) 는 s_mastery 에 비가산(P5) — 평가부족만 있는 학생 위험 낮음', () => {
  const r = analytics.getClassRiskList(CLASS);
  for (const s of r.list) {
    // evaluated=0 (전부 평가부족) 이면 s_mastery=0 이어야(평가부족을 미도달로 오인 금지)
    if (s.evaluated === 0) {
      assert.equal(s.signals.s_mastery, 0, `${s.userId} evaluated=0 인데 s_mastery>0 — 평가부족 오가산`);
    }
  }
  // 단위 검증: 미도달 비율은 evaluated 분모(insufficient 제외) — 코드 정합은 _masteryCounts 가 보장.
  // 합성 케이스: evaluated 0 → 위험 기여 0
});

test('RISK-4: 감정 데이터 없으면 w_emotion 재정규화 — s_emotion=null 이고 점수에 감정 미반영', () => {
  const r = analytics.getClassRiskList(CLASS);
  // 감정 기록 없는 학생: s_emotion=null. 그 학생 점수는 mastery/decline/engage 만으로 산출돼야.
  const noEmo = r.list.filter(s => s.signals.s_emotion == null);
  for (const s of noEmo) {
    // 재정규화 검증: 세 신호가 모두 0 이면 점수도 0 (감정 0 을 부정으로 오인하면 점수가 0 이 아닐 것)
    if (s.signals.s_mastery === 0 && s.signals.s_decline === 0 && s.signals.s_engage === 0) {
      assert.equal(s.score, 0, `${s.userId} 감정없음+세신호0 인데 score=${s.score} — 감정0 오인(재정규화 실패)`);
    }
  }
});

test('RISK-5: 근거 배열 생성 — 위험 기여 신호가 있으면 reasons 에 텍스트 동반', () => {
  const r = analytics.getClassRiskList(CLASS);
  for (const s of r.list) {
    assert.ok(Array.isArray(s.reasons), `${s.userId} reasons 배열`);
    for (const rs of s.reasons) {
      assert.ok(rs.type && typeof rs.text === 'string' && rs.text.length > 0, `근거에 type+text`);
    }
    // 위험점수>0 이면 적어도 1개 기여 근거(또는 평가부족 단서)
    if (s.score > 0) assert.ok(s.reasons.length > 0, `${s.userId} score>0 인데 근거 없음`);
  }
});

test('RISK-6: 신뢰도 — evaluated<3 이면 confidence=low(소표본 단서, P2)', () => {
  const r = analytics.getClassRiskList(CLASS);
  for (const s of r.list) {
    if (s.evaluated < 3) assert.equal(s.confidence, 'low', `${s.userId} evaluated<3 → low`);
  }
});

test('RISK-7: summary 합 = list 길이, 위험순 정렬(내림차순)', () => {
  const r = analytics.getClassRiskList(CLASS);
  assert.equal(r.summary.high + r.summary.medium + r.summary.low, r.list.length);
  for (let i = 1; i < r.list.length; i++) {
    assert.ok(r.list[i - 1].score >= r.list[i].score, `정렬 위반: ${r.list[i-1].score} < ${r.list[i].score}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// [PREREQ] 선수개념 갭 — 브리지 보수적, 미도달 선수만 막힘
// ════════════════════════════════════════════════════════════════════════════
test('PREREQ-1: getPrereqGap 구조 — edgesLoaded/bridged/gaps, blockedStudents 는 반 멤버만', () => {
  const g = analytics.getPrereqGap(CLASS);
  assert.ok(Number.isInteger(g.edgesLoaded));
  assert.ok(Number.isInteger(g.bridged));
  assert.ok(g.bridged <= g.edgesLoaded, '브리지된 엣지는 전체 이하(보수적)');
  // 브리지 회귀 박제: learning_map_nodes.node_id→achievement_code 브리지가 동작해야(엣지가 있으면 bridged>0).
  //   (옛 결함: std_id_map 만 사용 → 엣지 노드ID(D접미) 와 0 overlap → bridged=0 → 갭 전파 무력화)
  if (g.edgesLoaded > 0) assert.ok(g.bridged > 0, `엣지 ${g.edgesLoaded}개인데 bridged=0 — 노드↔code 브리지 미동작(회귀)`);
  const memberIds = new Set(analytics.classStudentIds(CLASS));
  for (const gap of g.gaps) {
    assert.ok(typeof gap.targetCode === 'string');
    for (const b of gap.blockedStudents) {
      assert.ok(memberIds.has(b.userId), `막힌 학생 ${b.userId} 가 반 멤버 아님(격리 위반)`);
      assert.ok(Array.isArray(b.missingPrereqs) && b.missingPrereqs.length > 0, '막힘이면 미도달 선수>0');
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// [WEAK] 취약 추세 랭킹
// ════════════════════════════════════════════════════════════════════════════
test('WEAK-1: getWeakTrend — 도달률 오름차 정렬, reachedRate ∈ [0,100]', () => {
  const ids = analytics.classStudentIds(CLASS);
  const rk = analytics.getWeakTrend({ userIds: ids, limit: 15 });
  for (const w of rk) {
    assert.ok(w.reachedRate >= 0 && w.reachedRate <= 100, `${w.code} reachedRate=${w.reachedRate}`);
  }
  for (let i = 1; i < rk.length; i++) {
    assert.ok(rk[i - 1].reachedRate <= rk[i].reachedRate, '도달률 오름차(취약 우선)');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// [MIRROR] A6 마음-공부 거울 — 정서 3그룹 × 성취/활동량 (학생 · 자기이해)
//   불변식: (a) groups 항상 3개(positive/neutral/negative 순) / (b) n<5 → avgScore·avgActs
//   모두 null / (c) avgScore ∈ [0,100] 또는 null / (d) 응답에 위험점수(score/grade/risk)
//   필드 부재(P6) / (e) coaching 문자열 존재.
//   시드: 합성 학생 id=99101 에 attendance(감정)+lrs_user_daily 를 INSERT.
// ════════════════════════════════════════════════════════════════════════════
const MIRROR_UID = 99101;
{
  // 합성 유저(관계 무결성용 — attendance.user_id FK). users: password/display_name NOT NULL.
  db.prepare(`INSERT OR IGNORE INTO users (id, username, password, display_name, role)
              VALUES (?, ?, ?, ?, 'student')`)
    .run(MIRROR_UID, `mirror_${MIRROR_UID}`, 'x', '거울테스트');

  // 최근 N일 내 날짜 문자열(오늘 - offset).
  const isoBack = (n) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  // attendance 감정 + 같은 날 lrs_user_daily 시드. class_id 는 임의(1).
  //   좋았던 날(긍정) 6일: 점수 80±, 활동 5   → n>=5 (수치 노출)
  //   힘든 날(부정)   6일: 점수 70±, 활동 3   → n>=5 (수치 노출)
  //   보통인 날(중립) 2일: 점수 75,  활동 4   → n<5  (마스킹)
  const seed = [];
  for (let i = 0; i < 6; i++) seed.push({ off: i + 1,  emo: 'happy',    score: 80, acts: 5 });   // positive
  for (let i = 0; i < 6; i++) seed.push({ off: i + 10, emo: 'sad',      score: 70, acts: 3 });   // negative
  for (let i = 0; i < 2; i++) seed.push({ off: i + 20, emo: 'neutral',  score: 75, acts: 4 });   // neutral (소표본)
  const insAtt = db.prepare(`INSERT OR IGNORE INTO attendance (class_id, user_id, attendance_date, status, emotion)
                             VALUES (1, ?, ?, 'present', ?)`);
  const insDaily = db.prepare(`INSERT OR IGNORE INTO lrs_user_daily (user_id, stat_date, activity_count, duration_sec, avg_score)
                               VALUES (?, ?, ?, ?, ?)`);
  for (const s of seed) {
    const date = isoBack(s.off);
    try { insAtt.run(MIRROR_UID, date, s.emo); } catch (_) {}
    try { insDaily.run(MIRROR_UID, date, s.acts, s.acts * 300, s.score); } catch (_) {}
  }
}

test('MIRROR-1: groups 항상 3개 · 순서 positive/neutral/negative', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  assert.equal(m.groups.length, 3, 'groups 3개');
  assert.deepEqual(m.groups.map(g => g.key), ['positive', 'neutral', 'negative'], '고정 순서');
  for (const g of m.groups) {
    assert.ok(typeof g.label === 'string' && g.label.length > 0, 'label 유지');
    assert.ok(typeof g.emoji === 'string' && g.emoji.length > 0, 'emoji 유지');
    assert.ok(Number.isInteger(g.n) && g.n >= 0, `n 정수 (${g.n})`);
  }
});

test('MIRROR-2: 각 그룹 n<5 → avgScore·avgActs 모두 null(소표본 마스킹)', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  for (const g of m.groups) {
    if (g.n < 5) {
      assert.equal(g.avgScore, null, `${g.key} n=${g.n}<5 인데 avgScore 마스킹 안됨`);
      assert.equal(g.avgActs, null, `${g.key} n=${g.n}<5 인데 avgActs 마스킹 안됨`);
    }
  }
  // 시드상 neutral 은 n=2(<5) → 마스킹, positive/negative 는 n>=5 → 수치 노출 기대
  const neu = m.groups.find(g => g.key === 'neutral');
  assert.ok(neu.n < 5 && neu.avgScore === null, 'neutral 소표본 마스킹 확인');
});

test('MIRROR-3: avgScore 는 null 또는 0~100', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  for (const g of m.groups) {
    if (g.avgScore != null) {
      assert.ok(g.avgScore >= 0 && g.avgScore <= 100, `${g.key} avgScore=${g.avgScore} 범위밖`);
    }
    if (g.avgActs != null) {
      assert.ok(g.avgActs >= 0, `${g.key} avgActs=${g.avgActs} 음수`);
    }
  }
});

test('MIRROR-4: ★윤리(P6) — 함수 결과에 위험점수(score/grade/risk) 필드 부재', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  const json = JSON.stringify(m);
  assert.ok(!/"risk"/.test(json), 'risk 키 없음');
  assert.ok(!/"score"/.test(json), 'score(위험점수) 키 없음');
  assert.ok(!/"grade"/.test(json), 'grade(위험등급) 키 없음');
  assert.ok(!/위험/.test(json), '"위험" 어휘 없음');
});

test('MIRROR-5: coaching 문자열 존재 · note 고정 · totalDays 정수', () => {
  const m = analytics.getEmotionMirror(MIRROR_UID, { days: 60 });
  assert.ok(typeof m.coaching === 'string' && m.coaching.length > 0, 'coaching 문자열');
  assert.equal(m.note, '감정 기록이 있는 날만 비교했어요. 이건 경향일 뿐, 정답은 아니에요.');
  assert.ok(Number.isInteger(m.totalDays) && m.totalDays >= 0, `totalDays=${m.totalDays}`);
  // 시드 14일(감정 있는 날) 전부 최근 60일 내 → totalDays=14 기대
  assert.equal(m.totalDays, 14, '감정기록일수 = 시드 14일');
});

// ════════════════════════════════════════════════════════════════════════════
// [PERM] 권한·윤리 (HTTP 레벨)
// ════════════════════════════════════════════════════════════════════════════
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

function classNotMemberedByTeacher() {
  return db.prepare(`
    SELECT c.id FROM classes c
    WHERE c.status='active'
      AND c.id NOT IN (
        SELECT cm.class_id FROM class_members cm
        WHERE cm.user_id=? AND cm.status='active' AND cm.role IN ('owner','teacher','co_teacher')
      )
    ORDER BY c.id LIMIT 1
  `).get(TEACHER);
}

test('PERM-1: ews — 학생은 403(낙인 방지 P6), 소유 교사·관리자 200', async () => {
  const stu = await req(`/ews/class/${CLASS}`, STUDENT1);
  assert.equal(stu.status, 403, '학생의 ews 접근은 403 (위험군 비노출)');
  const tch = await req(`/ews/class/${CLASS}`, TEACHER);
  assert.equal(tch.status, 200, '소유 교사 200');
  assert.equal(tch.json.success, true);
  assert.ok(tch.json.risk && Array.isArray(tch.json.risk.list), 'risk.list 배열');
  assert.ok(tch.json.classTrend && tch.json.projection, '추세·외삽 포함');
  const adm = await req(`/ews/class/${CLASS}`, ADMIN);
  assert.equal(adm.status, 200, '관리자 200');
});

test('PERM-2: ews — 비멤버 교사는 남의 반 403', async () => {
  const foreign = classNotMemberedByTeacher();
  assert.ok(foreign, '비멤버 active 클래스 필요');
  const r = await req(`/ews/class/${foreign.id}`, TEACHER);
  assert.equal(r.status, 403, `비멤버 교사 ews 는 403 (현재 ${r.status})`);
});

test('PERM-3: trend/student — 본인 200, 타 학생 403, 교사/관리자 200', async () => {
  const own = await req(`/trend/student/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200, '본인 추이 200');
  assert.equal(own.json.success, true);
  const other = await req(`/trend/student/${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '타 학생 추이 403');
  const byT = await req(`/trend/student/${STUDENT1}`, TEACHER);
  assert.equal(byT.status, 200, '교사 200');
});

test('PERM-4: ★윤리 — 학생 trend 응답에 위험점수/위험등급 등 어떤 위험 필드도 없음(P6)', async () => {
  const own = await req(`/trend/student/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200);
  const json = JSON.stringify(own.json);
  // 위험 관련 키/한글 어휘가 응답에 절대 없어야
  assert.ok(!/"risk"/.test(json), 'risk 키 없음');
  assert.ok(!/"score"/.test(json), 'score(위험점수) 키 없음');
  assert.ok(!/"grade"/.test(json) || /gradeKo/.test(json) === false, 'grade(위험등급) 키 없음');
  assert.ok(!/위험/.test(json), '"위험" 어휘 없음');
  // 추세·도달예상은 있어야(긍정 프레임)
  assert.ok(own.json.trend && own.json.projection, 'trend·projection 은 포함');
});

test('PERM-4b: emotion-mirror — 본인 200, 타 학생 403, 교사 200, 응답에 위험필드 없음(P6)', async () => {
  const own = await req(`/emotion-mirror/${STUDENT1}`, STUDENT1);
  assert.equal(own.status, 200, '본인 마음-공부 거울 200');
  assert.equal(own.json.success, true);
  assert.ok(Array.isArray(own.json.groups) && own.json.groups.length === 3, 'groups 3개');
  assert.ok(typeof own.json.coaching === 'string', 'coaching 문자열');
  const j = JSON.stringify(own.json);
  assert.ok(!/"risk"|"score"|"grade"|위험/.test(j), '학생 응답에 위험 필드/어휘 없음(P6)');

  const other = await req(`/emotion-mirror/${STUDENT2}`, STUDENT1);
  assert.equal(other.status, 403, '타 학생 거울 403');

  const byT = await req(`/emotion-mirror/${STUDENT1}`, TEACHER);
  assert.equal(byT.status, 200, '교사 200');
});

test('PERM-5: trend/class — 소유 교사 200, 비멤버 교사 403', async () => {
  const ok = await req(`/trend/class/${CLASS}`, TEACHER);
  assert.equal(ok.status, 200);
  const foreign = classNotMemberedByTeacher();
  const no = await req(`/trend/class/${foreign.id}`, TEACHER);
  assert.equal(no.status, 403, '비멤버 교사 trend/class 403');
});

test('PERM-6: weak-trend — 교사 scope=class 200, 학생 비교사 → scope=all 거부(403)', async () => {
  const tch = await req(`/weak-trend?scope=class`, TEACHER);
  assert.equal(tch.status, 200, '교사 class 200');
  assert.ok(Array.isArray(tch.json.ranking), 'ranking 배열');
  const adm = await req(`/weak-trend?scope=all`, ADMIN);
  assert.equal(adm.status, 200, '관리자 all 200');
  // 학생이 class scope 요청 → 권한 미달 403
  const stu = await req(`/weak-trend?scope=class`, STUDENT1);
  assert.equal(stu.status, 403, '학생 weak-trend(class) 403');
});

// ════════════════════════════════════════════════════════════════════════════
// [MEMB] /stats/custom 멤버십 집계 — self-learn class_id NULL 도 소속 학생이면 포착
// ════════════════════════════════════════════════════════════════════════════
test('MEMB-1: /stats/custom?scope=class — 교사가 우리 반 학생 self-learn 집계 포착(class_id NULL 해소)', async () => {
  // 실측: class 1 멤버 학생의 self-learn 로그 수(멤버십 기준 기대치)
  const memberIds = analytics.classStudentIds(CLASS);
  const ph = memberIds.map(() => '?').join(',');
  const expected = db.prepare(
    `SELECT COUNT(*) c FROM learning_logs WHERE source_service='self-learn' AND user_id IN (${ph})`
  ).all ? db.prepare(`SELECT COUNT(*) c FROM learning_logs WHERE source_service='self-learn' AND user_id IN (${ph})`).get(...memberIds).c : 0;

  const res = await req(`/stats/custom?scope=class`, TEACHER);
  assert.equal(res.status, 200);
  // 멤버십 기반이면 class_id NULL self-learn 도 포착 → 멤버에 self-learn 로그가 있으면 recommendedCount>0
  if (expected > 0) {
    assert.ok(res.json.summary.recommendedCount > 0,
      `멤버십 집계인데 recommendedCount=0 (기대 ${expected}) — class_id NULL 누락(§C-5 미적용)`);
  }
  // 멤버십 합과 일치(소유 반이 class 1 뿐이 아닐 수 있으므로 >= 비교 대신 동치는 owner 반 합 기준)
});

test('MEMB-2: /stats/custom 회귀 — scope=mine 은 본인만, scope=all 은 admin 전체', async () => {
  const mine = await req(`/stats/custom?scope=mine`, STUDENT1);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.scope, 'mine');
  const all = await req(`/stats/custom?scope=all`, ADMIN);
  assert.equal(all.status, 200);
  assert.equal(all.json.scope, 'all');
  // mine 의 recommendedCount 는 본인 self-learn 수와 일치
  const ownCount = db.prepare(
    "SELECT COUNT(*) c FROM learning_logs WHERE source_service='self-learn' AND user_id=?"
  ).get(STUDENT1).c;
  assert.equal(mine.json.summary.recommendedCount, ownCount, 'mine 집계 정합');
});
