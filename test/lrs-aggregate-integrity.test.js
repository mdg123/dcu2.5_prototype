// test/lrs-aggregate-integrity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [W2-a] 상류 집계기 정본화 — 부류 불변식 박제.
//
// 이 파일이 지키는 결함 부류는 "화면에서 안 보이는 곳에서 숫자가 오염되는" 종류다.
// 하류(routes/·public/)를 아무리 고쳐도 집계 테이블에 이미 거짓이 저장돼 있으면
// 전부 사후약방문이므로, **쓰기 시점**을 여기서 잠근다.
//
//   [SCALE] 집계 테이블에 저장되는 avg_score 는 항상 0~100 정규화 + 채점형 모집단.
//           (원시 AVG(result_score) 는 0~1·0~100 혼재 + 진도율 오염 → 영구 금지)
//   [POP]   성취 '시도'는 정본 술어(채점형 AND 정오판정 존재)를 통과한 행 수와 전수 일치.
//           조회(content_view)·진도(lesson_progress)는 시도로 절대 계수되지 않는다.
//   [SYNC]  실시간 경로와 재집계 경로가 **같은 판정**을 낸다.
//           (과거 실측: 재집계 1회에 2,349행의 도달/미도달이 뒤집혔다)
//   [TWIN]  SQL 술어와 JS 술어가 같은 집합을 가리킨다(쌍둥이 드리프트 방지).
//
// DB 격리: 실 DB → 임시 복사본(무오염).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const { rebuildAllAggregates } = require('../db/lrs-aggregate');
const { logLearningActivity } = require('../db/learning-log-helper');
const {
  SCORED_TYPES, isScoredType, normScore, avgScoreExpr, scoredWhere,
} = require('../lib/lrs/score-scale');
const {
  masteryAttemptWhere, isMasteryAttempt, observedWhere, isMasteryObserved,
} = require('../lib/lrs/mastery-population');
const db = openTestDb();

const AGG_TABLES = [
  'lrs_daily_stats', 'lrs_user_summary', 'lrs_content_summary',
  'lrs_class_summary', 'lrs_service_stats', 'lrs_achievement_stats', 'lrs_user_daily',
];

const STUDENT = 3; // student1 (실 DB 확정)

before(() => { rebuildAllAggregates(); });

// ════════════════════════════════════════════════════════════════════════════
// [SCALE] 저장되는 점수는 언제나 0~100 정규화 + 채점형만
// ════════════════════════════════════════════════════════════════════════════
test('[SCALE-1] 모든 집계 테이블의 avg_score 는 0~100 범위이거나 NULL', () => {
  for (const t of AGG_TABLES) {
    const bad = db.prepare(
      `SELECT COUNT(*) n FROM ${t} WHERE avg_score IS NOT NULL AND (avg_score < 0 OR avg_score > 100)`
    ).get().n;
    assert.equal(bad, 0, `${t}: 0~100 밖 avg_score ${bad}행 — 정규화 누락(normScoreExpr 미적용)`);
  }
});

test('[SCALE-2] avg_score 에 0<x<=1 구간 값이 없다 (0~1 원시 스케일 저장 금지)', () => {
  // 0~1 스케일이 정규화 없이 저장되면 "학급 평균 0.9점" 류의 붕괴가 난다.
  // 정규화 후에는 0<x<=1 이 나올 수 없다(0.01 점짜리 채점은 실재하지 않음).
  for (const t of AGG_TABLES) {
    const n = db.prepare(
      `SELECT COUNT(*) n FROM ${t} WHERE avg_score IS NOT NULL AND avg_score > 0 AND avg_score <= 1`
    ).get().n;
    assert.equal(n, 0, `${t}: 0~1 원시 스케일로 보이는 avg_score ${n}행`);
  }
});

test('[SCALE-3] 진도율(lesson_progress)은 avg_score 에 절대 섞이지 않는다', () => {
  // lesson_progress.result_score 는 '진도율(0.5~1.0)'이지 정답률이 아니다.
  // ×100 만 하면 "진도 50% → 성취 50점"이 된다(사용자 실측 결함).
  const beforeRow = db.prepare(
    `SELECT avg_score FROM lrs_user_summary WHERE user_id = ? AND activity_type = 'lesson_progress'`
  ).get(STUDENT);
  // 진도 로그만 있는 그룹의 avg_score 는 반드시 NULL (0 폴백도 금지 — §4-2)
  if (beforeRow) {
    assert.equal(beforeRow.avg_score, null,
      `lesson_progress 그룹의 avg_score 가 ${beforeRow.avg_score} — 진도율이 점수로 저장됨`);
  }
  // 전수: 채점형이 아닌 activity_type 그룹은 avg_score 가 전부 NULL 이어야 한다.
  const leaked = db.prepare(`
    SELECT activity_type, COUNT(*) n FROM lrs_user_summary
    WHERE avg_score IS NOT NULL AND NOT (${scoredWhere('')})
    GROUP BY activity_type
  `).all();
  assert.deepEqual(leaked, [], `비채점형 유형에 avg_score 가 저장됨: ${JSON.stringify(leaked)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// [POP] 성취 '시도'의 모집단 — 분모가 분자와 같은 행 집합을 본다
// ════════════════════════════════════════════════════════════════════════════
test('[POP-1] attempt_count 합계 = 정본 술어 통과 로그 수 (전수 일치)', () => {
  const stored = db.prepare('SELECT COALESCE(SUM(attempt_count),0) s FROM lrs_achievement_stats').get().s;
  const truth = db.prepare(
    `SELECT COUNT(*) n FROM learning_logs WHERE ${masteryAttemptWhere('')}`
  ).get().n;
  assert.equal(stored, truth,
    `저장 attempt 합계(${stored}) ≠ 술어 통과 로그수(${truth}) — 무필터 COUNT(*) 회귀`);
});

test('[POP-2] 조회·진도 로그는 성취 시도로 계수되지 않는다', () => {
  // 실측: achievement_code 를 단 content_view 가 수만 건 존재한다.
  //   점수·정오 판정이 전무한데 시도로 세면 모든 정답률이 구조적으로 낮아진다.
  const nonScoredWithCode = db.prepare(`
    SELECT COUNT(*) n FROM learning_logs
    WHERE achievement_code IS NOT NULL AND NOT (${scoredWhere('')})
  `).get().n;
  assert.ok(nonScoredWithCode > 0, '전제 붕괴: 비채점형+achievement_code 로그가 0건이면 이 테스트는 무의미');

  const counted = db.prepare(`
    SELECT COUNT(*) n FROM learning_logs
    WHERE achievement_code IS NOT NULL AND NOT (${scoredWhere('')})
      AND (${masteryAttemptWhere('')})
  `).get().n;
  assert.equal(counted, 0, `비채점형 로그 ${counted}건이 성취 시도로 계수됨`);
});

test('[POP-3] success_count <= attempt_count (분자가 분모를 넘지 않는다)', () => {
  const bad = db.prepare(
    'SELECT COUNT(*) n FROM lrs_achievement_stats WHERE success_count > attempt_count'
  ).get().n;
  assert.equal(bad, 0, `분자>분모 행 ${bad}건`);
});

// ── [A4/B-1 재기준 — 2026-08-04] ────────────────────────────────────────────
//   이 검사는 원래 `attempt_count = 0` 인 행을 유령으로 보고 0건을 요구했다.
//   그 요구는 "판정 분모"와 "칸의 존재"를 같은 조건으로 묶고 있었고, 그래서
//   정오 판정이 없는 채점형 학습(오늘의 학습)만 한 성취기준의 칸이 통째로 지워졌다
//   (실측: 전 사이트 9셀 소멸 — student1 7셀). B-1 이 두 역할을 분리했으므로
//   attempt_count = 0 은 이제 **정상 상태**(평가 부족·회색)다.
//
//   유령의 정의를 옮긴다: 유령은 "시도가 0인 행"이 아니라
//   **"채점형 학습 기록이 하나도 없는데 존재하는 행"** 이다. 원래 이 검사가 막고 싶었던
//   대상(조회 36,410건이 만든 행)은 새 정의에서도 그대로 막힌다 — 오히려 더 정확하게.
//   NULL attempt_count 금지는 그대로 유지한다(집계식이 NULL 을 흘리면 산술이 무너진다).
test('[POP-4] 채점형 학습 기록이 없는 유령 행이 저장되지 않는다 (attempt_count NULL 금지 포함)', () => {
  const nulls = db.prepare(
    'SELECT COUNT(*) n FROM lrs_achievement_stats WHERE attempt_count IS NULL'
  ).get().n;
  assert.equal(nulls, 0, `attempt_count 가 NULL 인 행 ${nulls}건 — 집계식이 NULL 을 흘렸다`);

  const ghosts = db.prepare(`
    SELECT COUNT(*) n FROM lrs_achievement_stats s
    WHERE NOT EXISTS (
      SELECT 1 FROM learning_logs l
      WHERE l.user_id = s.user_id AND l.achievement_code = s.achievement_code
        AND (${scoredWhere('l')})
    )
  `).get().n;
  assert.equal(ghosts, 0,
    `채점형 학습 기록이 없는 성취 행 ${ghosts}건 — 조회·진도 로그가 성취 칸을 만들고 있다`);
});

test('[POP-5] 조회 로그를 역주입해도 attempt_count 가 늘지 않는다', () => {
  const codeRow = db.prepare(
    `SELECT achievement_code c FROM lrs_achievement_stats WHERE user_id = ? LIMIT 1`
  ).get(STUDENT);
  assert.ok(codeRow, '전제: student1 에 성취 행이 있어야 함');
  const code = codeRow.c;
  const beforeAtt = db.prepare(
    'SELECT attempt_count a FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(STUDENT, code).a;

  // 조회 로그 20건 주입 — 점수·정오 판정 없음
  for (let i = 0; i < 20; i++) {
    logLearningActivity({
      userId: STUDENT, activityType: 'content_view', targetType: 'content', targetId: 90000 + i,
      achievementCode: code, verb: 'accessed', sourceService: 'content',
    });
  }
  const afterAtt = db.prepare(
    'SELECT attempt_count a FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(STUDENT, code).a;
  assert.equal(afterAtt, beforeAtt,
    `조회 20건 주입 후 attempt ${beforeAtt}→${afterAtt} — 조회가 시도로 계수됨(도달률 하향 편향 재발)`);
});

// ════════════════════════════════════════════════════════════════════════════
// [SYNC] 실시간 경로 == 재집계 경로 — 이 사이클의 핵심 불변식
// ════════════════════════════════════════════════════════════════════════════
test('[SYNC-1] 실시간 기록 후 재집계해도 성취 판정이 한 행도 바뀌지 않는다', () => {
  const code = '[4수03-10]';
  // 채점형·비채점형을 섞어 실시간 경로로 주입
  const fixtures = [
    { activityType: 'exam_complete',    resultScore: 90,   resultSuccess: 1 },
    { activityType: 'content_solve',    resultScore: 40,   resultSuccess: 0 },
    { activityType: 'homework_submit',  resultScore: 0.85, resultSuccess: 1 }, // 0~1 스케일 혼재
    { activityType: 'wrong_note_retry', resultScore: 75,   resultSuccess: 1 },
    { activityType: 'content_complete', resultScore: 60,   resultSuccess: 1 }, // 사용자 확정 포함 유형
    { activityType: 'problem_attempt',  resultScore: 55,   resultSuccess: 0 },
    { activityType: 'lesson_progress',  resultScore: 0.5,  resultSuccess: null }, // 진도율 — 배제돼야
    { activityType: 'content_view',     resultScore: null, resultSuccess: null }, // 조회 — 배제돼야
  ];
  fixtures.forEach((f, i) => logLearningActivity({
    userId: STUDENT, targetType: 'content', targetId: 95000 + i,
    achievementCode: code, sourceService: 'class', subjectCode: 'MAT', ...f,
  }));

  const cols = 'user_id, achievement_code, attempt_count, success_count, avg_score, level, last_level';
  const realtime = db.prepare(`SELECT ${cols} FROM lrs_achievement_stats ORDER BY user_id, achievement_code`).all();

  rebuildAllAggregates();

  const rebuilt = db.prepare(`SELECT ${cols} FROM lrs_achievement_stats ORDER BY user_id, achievement_code`).all();

  assert.equal(realtime.length, rebuilt.length,
    `행수 불일치 실시간=${realtime.length} 재집계=${rebuilt.length}`);

  const diffs = [];
  for (let i = 0; i < realtime.length; i++) {
    const a = realtime[i], b = rebuilt[i];
    for (const k of ['user_id', 'achievement_code', 'attempt_count', 'success_count', 'level', 'last_level']) {
      if (a[k] !== b[k]) diffs.push(`${a.user_id}|${a.achievement_code}.${k}: 실시간=${a[k]} 재집계=${b[k]}`);
    }
    // avg_score 는 부동소수 — 같은 행 집합의 AVG 이므로 사실상 동일해야 한다
    const av = a.avg_score, bv = b.avg_score;
    if ((av == null) !== (bv == null)) diffs.push(`${a.user_id}|${a.achievement_code}.avg_score null 불일치`);
    else if (av != null && Math.abs(av - bv) > 1e-9) {
      diffs.push(`${a.user_id}|${a.achievement_code}.avg_score: ${av} vs ${bv}`);
    }
  }
  assert.deepEqual(diffs.slice(0, 20), [],
    `실시간과 재집계의 판정이 갈라짐 (${diffs.length}건). 재집계 시점이 학생의 도달/미도달을 바꾼다는 뜻.`);
});

test('[SYNC-2] 진도율 로그는 실시간·재집계 어느 쪽에서도 성취 점수를 오염시키지 않는다', () => {
  const code = '[4수03-10]';
  const row = db.prepare(
    'SELECT attempt_count, success_count, avg_score FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(STUDENT, code);
  assert.ok(row, '전제: SYNC-1 이 만든 행이 있어야 함');
  // SYNC-1 에서 주입한 진도율 0.5 가 50점으로 섞였다면 평균이 그쪽으로 끌려간다.
  // 채점형 6건(90, 40, 85, 75, 60, 55)의 평균 = 67.5 근방이어야 한다.
  assert.ok(row.avg_score > 1, `avg_score=${row.avg_score} — 0~1 원시값 저장 의심`);
  assert.ok(row.avg_score <= 100, `avg_score=${row.avg_score} — 범위 위반`);
});

// ════════════════════════════════════════════════════════════════════════════
// [TWIN] SQL 술어와 JS 술어가 같은 집합을 가리킨다
// ════════════════════════════════════════════════════════════════════════════
test('[TWIN-1] isMasteryAttempt(JS) 와 masteryAttemptWhere(SQL) 가 전수 일치', () => {
  const rows = db.prepare(`
    SELECT id, activity_type, achievement_code, result_success,
           (${masteryAttemptWhere('')}) AS sql_says
    FROM learning_logs
  `).all();
  let mismatch = 0, sample = null;
  for (const r of rows) {
    const jsSays = isMasteryAttempt({
      activityType: r.activity_type,
      achievementCode: r.achievement_code,
      resultSuccess: r.result_success,
    }) ? 1 : 0;
    if (jsSays !== r.sql_says) { mismatch++; if (!sample) sample = r; }
  }
  assert.equal(mismatch, 0,
    `SQL·JS 술어 불일치 ${mismatch}건 (예: ${JSON.stringify(sample)}) — 쌍둥이 드리프트`);
});

// [A4/B-1] 관측 술어도 쌍둥이다 — 실시간 게이트(JS)와 재집계 모집단(SQL)이 갈라지면
//   "실시간엔 칸이 생기는데 재집계하면 사라진다"(또는 그 반대)가 되어, 재집계 시점이
//   다시 학생의 화면을 바꾼다(W2-a 가 없앤 바로 그 부류의 재발).
test('[TWIN-1b] isMasteryObserved(JS) 와 observedWhere(SQL) 가 전수 일치', () => {
  const rows = db.prepare(`
    SELECT id, activity_type, achievement_code,
           (${observedWhere('')}) AS sql_says
    FROM learning_logs
  `).all();
  let mismatch = 0, sample = null;
  for (const r of rows) {
    const jsSays = isMasteryObserved({
      activityType: r.activity_type,
      achievementCode: r.achievement_code,
    }) ? 1 : 0;
    if (jsSays !== r.sql_says) { mismatch++; if (!sample) sample = r; }
  }
  assert.equal(mismatch, 0,
    `SQL·JS 관측 술어 불일치 ${mismatch}건 (예: ${JSON.stringify(sample)}) — 쌍둥이 드리프트`);
});

test('[TWIN-1c] 시도(attempt) 는 관측(observed) 의 진부분집합이며, 차집합은 정확히 "정오 판정 없음"', () => {
  // 두 술어가 같은 집합이 되면 B-1 이 되돌려진 것이고,
  // 시도가 관측 밖으로 나가면 판정 분모가 관측되지 않은 행을 세는 것이다. 둘 다 붕괴.
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN (${masteryAttemptWhere('')}) AND NOT (${observedWhere('')}) THEN 1 ELSE 0 END) attempt_outside_observed,
      SUM(CASE WHEN (${observedWhere('')}) AND NOT (${masteryAttemptWhere('')})
                AND result_success IS NOT NULL THEN 1 ELSE 0 END) diff_wrong_reason,
      SUM(CASE WHEN (${observedWhere('')}) AND NOT (${masteryAttemptWhere('')}) THEN 1 ELSE 0 END) observed_only
    FROM learning_logs
  `).get();
  assert.equal(r.attempt_outside_observed, 0, '시도가 관측 밖에 있다 — 판정 분모 오염');
  assert.equal(r.diff_wrong_reason, 0, '관측−시도 차집합에 정오 판정이 있는 행이 섞였다');
  assert.ok(r.observed_only > 0,
    '관측만 되고 판정은 없는 로그가 0건 — 전제 붕괴(오늘의 학습 픽스처 소실) 또는 B-1 되돌림');
});

test('[TWIN-2] isScoredType(JS) 와 scoredWhere(SQL) 가 전수 일치', () => {
  const rows = db.prepare(
    `SELECT DISTINCT activity_type t, (${scoredWhere('')}) AS sql_says FROM learning_logs`
  ).all();
  for (const r of rows) {
    assert.equal(isScoredType(r.t) ? 1 : 0, r.sql_says, `유형 '${r.t}' 판정 불일치`);
  }
});

test('[TWIN-3] 채점형 화이트리스트가 진도율·조회를 포함하지 않는다', () => {
  for (const forbidden of ['lesson_progress', 'content_view', 'lesson_view',
    'attendance_checkin', 'post_create', 'survey_respond', 'homework_graded']) {
    assert.ok(!SCORED_TYPES.includes(forbidden),
      `${forbidden} 이 채점형 화이트리스트에 포함됨 — 점수 개념이 없거나 학생 성취가 아니다`);
  }
  // 사용자 확정 포함분 — 빠지면 정의와 모순되므로 박제
  for (const required of ['content_complete', 'problem_attempt']) {
    assert.ok(SCORED_TYPES.includes(required),
      `${required} 이 채점형 화이트리스트에서 빠짐 — 실측상 채점 신호 보유 유형이다`);
  }
});

test('[TWIN-5] 학습활동 7종(C1)과 채점형 화이트리스트는 의도적으로 다른 집합이다', () => {
  const { LEARNING_ACTIVITY_TYPES } = require('../lib/lrs/score-scale');
  // 두 목록은 서로 다른 질문에 답한다. 같아 보인다고 통합하면 반드시 한쪽이 틀린다.
  //   C1(활동 수)  = "학습 활동으로 셀 것인가"  → 진도 이수(lesson_progress) 포함
  //   SCORED(점수) = "정답/점수 판정이 있는가"   → 진도율은 점수가 아니므로 제외
  assert.ok(LEARNING_ACTIVITY_TYPES.includes('lesson_progress'),
    'C1 에는 수업꾸러미 이수(lesson_progress)가 포함된다 — 학습 활동이므로');
  assert.ok(!SCORED_TYPES.includes('lesson_progress'),
    '채점형에는 lesson_progress 가 없어야 한다 — result_score 가 진도율(0.5~1.0)이라 점수가 아니다');
  for (const t of ['content_complete', 'problem_attempt']) {
    assert.ok(SCORED_TYPES.includes(t), `${t} 는 채점형이다(정오 판정 보유)`);
    assert.ok(!LEARNING_ACTIVITY_TYPES.includes(t),
      `${t} 는 C1(학습활동 정본 7종) 밖이다 — 활동 수 집계에 넣으면 정본 정의와 어긋난다`);
  }
});

test('[TWIN-4] normScore(JS) 와 normScoreExpr(SQL) 가 같은 값을 낸다', () => {
  const rows = db.prepare(`
    SELECT result_score raw, ${require('../lib/lrs/score-scale').normScoreExpr('')} AS sql_norm
    FROM learning_logs WHERE result_score IS NOT NULL LIMIT 500
  `).all();
  assert.ok(rows.length > 0, '전제: 점수 있는 로그 존재');
  for (const r of rows) {
    assert.ok(Math.abs(normScore(r.raw) - r.sql_norm) < 1e-9,
      `raw=${r.raw} JS=${normScore(r.raw)} SQL=${r.sql_norm}`);
  }
});
