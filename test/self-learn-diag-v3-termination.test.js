// test/self-learn-diag-v3-termination.test.js
// ─────────────────────────────────────────────────────────────────────────────
// AI 맞춤학습 진단(concept-v3) — 종료 조건 · 중단 · 학습경로 회귀 박제
// 기획서: 보고서/기획_진단v3_종료·중단·학습경로_v1.md §8 (INV-DV3-1 ~ 9)
//
// ── 왜 필요한가 (사용자가 직접 겪은 결함) ──────────────────────────────────
//   "일부러 문제를 틀려서 이전 학년이나 학기로 이동하는 것은 좋아, 그러다가 출발선을 확인해서 맞았음.
//    그러면 진단결과를 제공하고 학습경로가 추천해야 하는데 갑자기 원래 진단한 학년-학기의 문제가 나옴.
//    진단이 언제 끝나는거야"
//
//   조사 결과 — v3 엔진에는 "출발선을 찾았다 → 종료" 조건이 **아예 없었다.**
//   v2/CAT 의 position_found 에 대응하는 코드가 한 줄도 없고,
//   원 단원 복귀(_v3RestoreOriginUnit)는 [P1 본류복귀 2026-06-11] 로 **의도된 설계**였다.
//   그 설계가 결함이다. 그리고 세션이 끝나지 않으므로 status 는 영원히 in_progress 로 남아
//   learning_paths·user_node_status 반영(POST /finish 안에만 있음)도 통째로 누락됐다.
//   실측(HEAD 대비, 격리 사본): 같은 시나리오에서 구 엔진 14문항 in_progress · 원단원 재출제 YES
//                              → 신 엔진 13문항 completed(position_found) · 재출제 no.
//
// ── 불변식 ────────────────────────────────────────────────────────────────
//   INV-DV3-1  본류 2연속 오답 → 후퇴 → 선수 갈래 통과 → 큐 소진 시 종료
//              (finished && sessionComplete && endReason==='position_found', nextQuestion===null,
//               DB status='completed')
//   INV-DV3-2  ★ 원 단원 문항이 다시 나오지 않는다 (사용자 지적 직접 재현)
//   INV-DV3-3  큐에 갈래가 2개 이상 남아 있으면 첫 통과로 종료하지 않는다
//   INV-DV3-4  출발선 = 실패한 것 중 근본도 최저 (통과 단원 개념은 출발선이 될 수 없다)
//   INV-DV3-5  큐 정렬이 높은 학년·학기 우선, 절단 후에도 목표에 가까운 후보가 남는다
//   INV-DV3-6  종료 시 learning_paths 1건 + user_node_status.diagnosis_result NOT NULL
//   INV-DV3-7  중단 — 'finish' → completed + 실패 단원 경로 제공 / 미선택 → in_progress 유지
//   INV-DV3-8  하위호환 — downCount/prereqQueue/branchVerdicts 없는 구 세션이 throw 없이 동작하고
//              조기종료를 타지 않는다 (정본 DB v3 세션 89건이 전부 이 형태)
//   INV-DV3-9  유한성 — 전부 오답으로 자동 응답해도 200문항 이내 finished
//   INV-DV3-23 ★ 목표 단원(본류)에서도 프리셋 문항 수만큼 출제된다 (첫 문제 오답으로 멈추지 않는다)
//   INV-DV3-24 ★ 목표 단원에서 통과가 **불가능해진 뒤에도** 남은 문항이 계속 출제된다
//   INV-DV3-25 ★ 목표 단원 판정 기준 == 갈래 단원(needPass 동일). 프리셋수-1 정답이면 통과
//   INV-DV3-26 ★ softStop 이 §1-B(more-units) 턴과 겹쳐도 소실되지 않는다(표식만 태우지 않는다)
//
// DB 격리: 실 DB → 임시 복사본(무오염).
// ⚠ 단언을 조건문 안에 가두지 않는다. 픽스처 전제가 무너지면 **테스트가 실패**해야 한다
//   (조건 안에 갇힌 단언은 몇 달간 한 번도 실행되지 않은 채 초록불을 준다 — 2026-08-07 사고).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const sl = require('../db/self-learn-extended');
const db = openTestDb();

// ── 픽스처 ────────────────────────────────────────────────────────────────
const UID = (() => {
  const u = db.prepare("SELECT id FROM users WHERE username = 'student1'").get();
  assert.ok(u, '픽스처 전제 붕괴: student1 계정이 없습니다.');
  return u.id;
})();

/**
 * "다른 단원의 개념을 선수로 갖는" 단원 = 하향(후퇴)이 실제로 발생할 수 있는 단원.
 * 선수 갈래가 3개 이상이어야 INV-DV3-3(첫 통과로 끝나지 않음)을 검증할 수 있다.
 */
function unitsWithCrossUnitPrereqs(minBranches = 3, limit = 8) {
  return db.prepare(`
    SELECT p.node_id AS unitId, p.unit_name AS unitName, COUNT(DISTINCT e.from_node_id) AS pre
    FROM learning_map_nodes c
    JOIN learning_map_nodes p   ON p.node_id = c.parent_node_id AND p.node_level = 2
    JOIN learning_map_edges e   ON e.to_node_id = c.node_id AND e.edge_type = 'prerequisite'
    JOIN learning_map_nodes src ON src.node_id = e.from_node_id
    WHERE c.node_level = 3 AND src.parent_node_id <> p.node_id
      AND EXISTS (SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id = nc.content_id WHERE nc.node_id = c.node_id)
      AND EXISTS (SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id = nc.content_id WHERE nc.node_id = src.node_id)
    GROUP BY p.node_id HAVING pre >= ?
    ORDER BY pre DESC, p.node_id ASC LIMIT ?
  `).all(minBranches, limit);
}

const FIXTURE_UNITS = unitsWithCrossUnitPrereqs(3, 8);
assert.ok(
  FIXTURE_UNITS.length > 0,
  '픽스처 전제 붕괴: 타 단원 선수를 3개 이상 가진 문항보유 단원이 없습니다(학습맵 엣지 소실).'
);
const UNIT = FIXTURE_UNITS[0];

// 엔진 자신의 채점기로 정답/오답 보기를 탐침한다.
//   DB 의 answer 가 0-based/텍스트로 혼재해 있어 테스트가 따로 해석하면 어긋난다.
function answerFor(questionId, want /* 'correct' | 'wrong' */) {
  const q = db.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(questionId);
  let opts = [];
  try { opts = JSON.parse((q && q.options) || '[]'); } catch (_) { opts = []; }
  if (Array.isArray(opts) && opts.length) {
    for (let i = 0; i < opts.length; i++) {
      const ok = sl.judgeQuestionAnswer(q, String(opts[i]), i);
      if (want === 'correct' ? ok : !ok) return { answer: String(opts[i]), answerIndex: i };
    }
    return { answer: String(opts[0]), answerIndex: 0 };
  }
  return want === 'correct'
    ? { answer: String((q && q.answer) == null ? '' : q.answer), answerIndex: null }
    : { answer: '__WRONG__' + Math.random(), answerIndex: null };
}

/**
 * 진단 세션을 끝까지(또는 상한까지) 자동 진행한다.
 * @param decide ({ concept, step }) => 'correct' | 'wrong'
 * @returns 진행 로그
 */
function drive(unitNodeId, decide, { preset, maxSteps = 400, acceptMore = true } = {}) {
  const start = sl.startDiagnosisV3(UID, { unitNodeId, preset });
  const sid = start.sessionId;
  let q = start.question;
  let concept = start.concept;
  const steps = [];
  const moreAsks = [];             // [§1-B] 추가 진단 확인이 뜬 시점·예고 내용
  let last = null;
  let downOccurred = false;
  let originUnitAfterDown = 0;     // ★ INV-DV3-2 — 후퇴 이후 원 단원 문항이 다시 출제된 횟수
  const originUnitName = start.unit && start.unit.name;
  let guard = 0;

  while (q && guard++ < maxSteps) {
    if (downOccurred && concept && concept.unitName === originUnitName) originUnitAfterDown++;
    const want = decide({ concept, step: steps.length + 1, originUnitName });
    const a = answerFor(q.questionId, want);
    const r = sl.submitDiagnosisV3(sid, {
      questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId,
      answer: a.answer, answerIndex: a.answerIndex
    });
    last = r;
    steps.push({
      conceptId: concept && concept.nodeId, unitName: concept && concept.unitName,
      want, isCorrect: !!r.isCorrect, stage: r.attemptStage, finished: !!r.finished,
      endReason: r.endReason || null, queueRemaining: r.queueRemaining,
      branch: r.branch ? r.branch.type : null, softStop: r.softStop ? r.softStop.reason : null
    });
    if (r.branch && r.branch.type === 'down') downOccurred = true;
    // [§1-B] 추가 진단 확인 — [추가 진단에 넣기]/[넣지 않기]. 어느 쪽이든 진단은 계속된다.
    if (r.moreUnits) {
      moreAsks.push({ atStep: steps.length, units: r.moreUnits.units, questions: r.moreUnits.questions,
                      unitName: r.moreUnits.unitName, failedUnit: concept && concept.unitName });
      // [§1-B] '넣기'를 고르면 그대로 하향한다 — 예전 'down' 분기와 같은 의미의 후퇴다.
      if (acceptMore) downOccurred = true;
      const adv = sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: acceptMore });
      if (adv.finished || adv.sessionComplete) { last = adv; break; }
      q = adv.question; concept = adv.concept;
      continue;
    }
    if (r.finished || r.sessionComplete) break;
    if (r.branch && r.branch.type === 'down' && r.branch.prereqConcept) {
      const adv = sl.advanceDiagnosisV3(sid, { action: 'go-prereq' });
      if (adv.finished || adv.sessionComplete) { last = adv; break; }
      q = adv.question; concept = adv.concept;
      continue;
    }
    if (r.branch && r.branch.type === 'unit-complete') break;
    if (r.nextQuestion) { q = r.nextQuestion; if (r.nextConcept) concept = r.nextConcept; continue; }
    const nx = sl.getNextDiagnosisV3(sid);
    if (!nx || nx.finished || nx.sessionComplete || !nx.question) break;
    q = nx.question; if (nx.concept) concept = nx.concept;
  }

  const row = db.prepare('SELECT status, total_questions FROM diagnosis_sessions WHERE id = ?').get(sid);
  return { sid, steps, last, status: row.status, asked: steps.length, originUnitAfterDown, downOccurred, originUnitName, start, moreAsks };
}

// 본류(원 단원)는 일부러 오답, 선수 갈래는 정답 = 사용자가 겪은 시나리오 그대로
const FAIL_ORIGIN_PASS_PREREQ = ({ concept, originUnitName }) =>
  (concept && concept.unitName === originUnitName) ? 'wrong' : 'correct';

/**
 * 목표 단원(본류)을 오답으로 밀어 §1-B 추가 진단 확인이 뜰 때까지 진행한다.
 *
 * ★ [§1-A 본류 표본 2026-08-07] **오답 1회 = 즉시 모달이 아니다.**
 *   목표 단원도 프리셋 문항 수를 끝까지 채운 뒤에만 판정하므로, 모달은 표본 소진 후에 뜬다.
 *   (이 헬퍼 이전 버전은 "본류 오답 1회 → moreUnits"를 전제했고, 그것이 사용자가 지적한
 *    "화면은 5문제라는데 1문제만 나온다"의 코드 쪽 표현이었다.)
 * @returns {{ r, asked }} 마지막 응답(moreUnits 포함 기대)과 본류에서 출제된 문항 수
 */
function failMainlineUntilAsk(sid, firstQuestion, maxSteps = 30) {
  let q = firstQuestion, r = null, asked = 0;
  while (q && asked < maxSteps) {
    const a = answerFor(q.questionId, 'wrong');
    r = sl.submitDiagnosisV3(sid, {
      questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId,
      answer: a.answer, answerIndex: a.answerIndex
    });
    asked++;
    if (r.moreUnits) break;
    q = r.nextQuestion;
  }
  return { r, asked };
}

const pathRowOf = (sid) =>
  db.prepare("SELECT path_nodes FROM learning_paths WHERE session_id = ? AND source_type = 'diagnosis'").get(sid);

// ─────────────────────────────────────────────────────────────────────────────
test('INV-DV3-1 — 후퇴 후 선수 갈래를 다 보고 큐가 소진되면 진단이 종료된다(position_found)', () => {
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);

  // 픽스처 전제: 이 시나리오는 반드시 후퇴(하향)를 유발해야 한다.
  assert.equal(run.downOccurred, true,
    `픽스처 전제 붕괴: "${UNIT.unitName}" 에서 본류 오답이 하향을 유발하지 않았습니다.`);

  assert.equal(run.last.finished, true, '큐 소진 후에도 finished 가 서지 않았습니다.');
  assert.equal(run.last.sessionComplete, true, 'sessionComplete 가 서지 않았습니다.');
  assert.equal(run.last.endReason, 'position_found',
    `endReason 이 position_found 가 아닙니다(실제: ${run.last.endReason}).`);
  assert.equal(run.last.nextQuestion, null, '종료 응답에 다음 문항이 실려 있습니다.');
  assert.equal(run.status, 'completed', `DB 세션 status 가 completed 가 아닙니다(실제: ${run.status}).`);
});

test('INV-DV3-2 — ★ 후퇴 이후 원 단원 문항이 다시 나오지 않는다 (사용자 지적 직접 재현)', () => {
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);

  assert.equal(run.downOccurred, true, '픽스처 전제 붕괴: 하향이 발생하지 않았습니다.');
  // ★ 부정 단언은 조건 밖. 원 단원 재출제는 단 1회도 허용하지 않는다.
  assert.equal(run.originUnitAfterDown, 0,
    `후퇴 이후 원 단원("${run.originUnitName}") 문항이 ${run.originUnitAfterDown}회 재출제됐습니다. ` +
    '_v3BranchSamplePass 의 본류 복귀(_v3RestoreOriginUnit)가 되살아났는지 확인하십시오.');
  // 종료 응답의 다음 개념도 원 단원이 아니어야 한다(라운드트립 없이 곧장 재진입하는 형태 차단).
  const nextConcept = run.last && run.last.nextConcept;
  assert.equal(nextConcept, null, '종료 응답에 다음 개념이 실려 있습니다(원 단원 재진입 경로).');
  assert.equal(run.last.attemptStage, 'finished', `종료 stage 가 finished 가 아닙니다(${run.last.attemptStage}).`);
});

test('INV-DV3-3 — 큐에 갈래가 남아 있으면 첫 통과로 종료하지 않는다', () => {
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);

  // 종료된 스텝의 인덱스
  const endIdx = run.steps.findIndex(s => s.finished);
  assert.ok(endIdx >= 0, '종료 스텝을 찾지 못했습니다.');

  // 종료 시점에는 남은 큐가 0이어야 한다.
  assert.equal(run.steps[endIdx].queueRemaining, 0,
    `큐가 ${run.steps[endIdx].queueRemaining}개 남았는데 종료했습니다(§2 위반 — 갈래는 다 봐야 한다).`);

  // 그리고 종료 전에 "큐가 남은 채 갈래를 통과한" 시점이 실제로 존재해야 한다
  // (= 첫 통과로 끝내지 않고 남은 갈래를 계속 봤다는 증거).
  // [감리 P2-2 2026-08-07] `(queueRemaining || 0) >= 0` 은 **항상 참인 죽은 조건**이었다
  //   (변수명은 "큐가 남은 채 통과"인데 실제로는 stage 만 세고 있었다). 남은 큐를 실제로 본다.
  const passedWithQueueLeft = run.steps.slice(0, endIdx)
    .filter(s => s.stage === 'next-prereq' && (s.queueRemaining || 0) > 0).length;
  assert.ok(passedWithQueueLeft >= 1,
    '갈래를 통과하고 다음 갈래로 넘어간 흔적(next-prereq)이 없습니다 — 다갈래 검사가 동작하지 않습니다.');

  // 검사한 서로 다른 선수 단원이 2개 이상이어야 "남은 갈래를 다 봤다"가 성립한다.
  const branchUnits = new Set(run.steps.map(s => s.unitName).filter(n => n && n !== run.originUnitName));
  assert.ok(branchUnits.size >= 2,
    `선수 갈래를 ${branchUnits.size}개만 검사했습니다(2개 이상이어야 §2 성립). 검사한 단원: ${[...branchUnits].join(', ')}`);
});

test('INV-DV3-4 — 출발선은 "실패한 것 중" 근본도 최저이며, 통과한 단원의 개념이 아니다', () => {
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);
  const result = sl.getDiagnosisResultV3(run.sid);
  assert.ok(result && result.recommendedStartNode, '추천 시작점(출발선)이 산출되지 않았습니다.');

  const startId = result.recommendedStartNode.nodeId;
  const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(run.sid).difficulty_path);

  // ① 출발선은 통과한 개념이 아니다.
  assert.equal((st.passedConcepts || []).includes(startId), false,
    '출발선이 이미 통과한 개념입니다 — 아는 것에서 학습을 시작하게 됩니다.');

  // ② 출발선이 속한 단원은 '통과(pass)' 판정을 받은 단원이 아니다. (부정 단언 — 조건 밖)
  const verdicts = st.branchVerdicts || {};
  const parentRow = db.prepare('SELECT parent_node_id FROM learning_map_nodes WHERE node_id = ?').get(startId);
  const startUnit = parentRow && parentRow.parent_node_id;
  assert.notEqual(verdicts[startUnit], 'pass',
    `출발선("${result.recommendedStartNode.name}")이 통과 판정 단원에 속합니다 — §3 위반.`);

  // ③ 이 시나리오에서는 본류(원 단원)를 실패했으므로 출발선은 원 단원 개념이어야 한다.
  const originUnitId = run.start.unit.nodeId;
  assert.equal(startUnit, originUnitId,
    `출발선이 실패한 원 단원("${run.originUnitName}")이 아닙니다(실제 단원: ${startUnit}).`);
});

test('INV-DV3-5 — 선수 큐는 높은 학년·학기 우선(목표에 가까운 순)으로 정렬되고 절단해도 그 순서가 남는다', () => {
  // 본류 표본 실패 → [§1-B] 추가 진단 확인 → '넣기' → 큐 적재 직후 상태를 검사한다(갈래 진입 전).
  //   [§1-A 본류 표본] 목표 단원도 프리셋 문항 수를 다 본 뒤 판정되므로 표본을 소진시킨다.
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId });
  const sid = start.sessionId;
  const { r } = failMainlineUntilAsk(sid, start.question);
  assert.ok(r && r.moreUnits, '픽스처 전제 붕괴: 본류 표본 실패에서 추가 진단 확인이 뜨지 않았습니다.');
  sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: true });
  const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);

  // [§1-B] '넣기'는 적재 + 첫 갈래 진입까지 한 번에 한다. 따라서 지금 보이는 것은
  //   "이번에 진입한 갈래(st.unit)" + "큐에 남은 후보"다. 둘을 합쳐 검사 순서를 검증한다.
  const entered = st.unit && st.unit.nodeId;   // 방금 들어간 선수 단원
  assert.ok(entered, '픽스처 전제 붕괴: 갈래 단원 진입이 일어나지 않았습니다.');
  const queued = st.prereqQueue || [];
  assert.ok(queued.length >= 1,
    `픽스처 전제 붕괴: 본류 오답 후 큐에 남은 선수 후보가 ${queued.length}개입니다(1개 이상 필요).`);

  // 절대학년(초1-1=2 … 고3-2=25) — _gradeAbsOf 와 같은 정의를 테스트에서 독립 계산한다.
  const gradeAbsOf = (conceptId) => {
    const n = db.prepare('SELECT grade_level, grade, semester, parent_node_id FROM learning_map_nodes WHERE node_id = ?').get(conceptId);
    if (!n) return 999;
    let gl = n.grade_level, g = n.grade, sem = n.semester;
    if ((g == null || gl == null) && n.parent_node_id) {
      const p = db.prepare('SELECT grade_level, grade, semester FROM learning_map_nodes WHERE node_id = ?').get(n.parent_node_id);
      if (p) { gl = gl || p.grade_level; g = (g == null) ? p.grade : g; sem = (sem == null) ? p.semester : sem; }
    }
    const base = gl === '중' ? 6 : (gl === '고' ? 9 : 0);
    return (base + (Number(g) || 0)) * 2 + (Number(sem) === 2 ? 1 : 0);
  };

  const absList = queued.map(gradeAbsOf);
  // 남은 큐가 내림차순(비증가)이어야 한다 — 목표에 가까운(높은 학년·학기) 선수부터 검사.
  for (let i = 1; i < absList.length; i++) {
    assert.ok(absList[i - 1] >= absList[i],
      `선수 큐가 내림차순이 아닙니다(§6 위반): ${JSON.stringify(absList)}. ` +
      '오름차순이면 절단(slice)이 목표에 가까운 후보를 버려 출발선을 놓칩니다.');
  }
  // ★ 핵심: **먼저 진입한 갈래**가 큐에 남은 어떤 후보보다 목표에 가까워야 한다.
  //   오름차순이던 시절엔 가장 낮은 학년부터 들어가 절단이 경계 후보를 버렸다.
  const enteredAbs = gradeAbsOf(entered);
  const maxQueued = Math.max(...absList);
  assert.ok(enteredAbs >= maxQueued,
    `먼저 진입한 갈래(${entered}, abs=${enteredAbs})가 큐에 남은 후보(max abs=${maxQueued})보다 ` +
    `목표에서 멀습니다 — 검사 순서가 뒤집혔습니다: ${JSON.stringify(absList)}`);
});

test('INV-DV3-6 — 종료 시 learning_paths 1건 + user_node_status.diagnosis_result 가 채워진다', () => {
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);
  assert.equal(run.status, 'completed', '세션이 완료되지 않았습니다.');

  // 결과 조회(= FE 결과 화면 진입) 시점에 반드시 반영돼 있어야 한다.
  const result = sl.getDiagnosisResultV3(run.sid);
  assert.ok(result && result.summary, '결과가 산출되지 않았습니다.');

  const path = pathRowOf(run.sid);
  assert.ok(path, 'learning_paths 가 생성되지 않았습니다(§7-1 회귀 — /finish 누수).');
  const nodes = JSON.parse(path.path_nodes || '[]');
  assert.ok(nodes.length >= 1, `학습경로 STEP 이 비었습니다: ${path.path_nodes}`);

  // 실패한 원 단원이 경로에 들어 있어야 한다(사용자 요구 ③ "학습이 필요한 실패한 단원").
  assert.ok(nodes.includes(run.start.unit.nodeId),
    `실패한 목표 단원(${run.start.unit.nodeId})이 학습경로에 없습니다: ${JSON.stringify(nodes)}`);

  // 통과 판정을 받은 단원은 경로에 없어야 한다(§1-A — 아는 단원은 넣지 않는다). 부정 단언, 조건 밖.
  const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(run.sid).difficulty_path);
  const passedUnits = Object.keys(st.branchVerdicts || {}).filter(u => st.branchVerdicts[u] === 'pass');
  const leaked = nodes.filter(n => passedUnits.includes(n));
  assert.deepEqual(leaked, [],
    `통과한 단원이 학습경로에 들어갔습니다: ${JSON.stringify(leaked)} (§1-A 위반)`);

  // 진단 결과가 노드 상태에 반영됐는지 — 이 세션에서 채점된 개념 중 최소 1개.
  const graded = db.prepare('SELECT DISTINCT node_id FROM diagnosis_answers WHERE session_id = ?').all(run.sid).map(r => r.node_id);
  assert.ok(graded.length > 0, '채점된 문항이 없습니다(픽스처 전제 붕괴).');
  const applied = db.prepare(`
    SELECT COUNT(*) AS c FROM user_node_status
    WHERE user_id = ? AND diagnosis_result IS NOT NULL AND node_id IN (${graded.map(() => '?').join(',')})
  `).get(UID, ...graded);
  assert.ok(applied.c > 0,
    'user_node_status.diagnosis_result 가 한 건도 채워지지 않았습니다(§7-1 회귀).');
});

test('INV-DV3-7 — 중단: "결과 보기"(finish)는 completed + 경로 제공 / 고르지 않으면 in_progress 유지', () => {
  // ① 몇 문항만 풀고 중단 없이 두면 세션은 진행중으로 남는다("나중에 이어서 하기").
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId });
  const sid = start.sessionId;
  let q = start.question;
  for (let i = 0; i < 2 && q; i++) {
    const a = answerFor(q.questionId, 'correct');
    const r = sl.submitDiagnosisV3(sid, { questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId, answer: a.answer, answerIndex: a.answerIndex });
    q = r.nextQuestion;
  }
  const mid = db.prepare('SELECT status FROM diagnosis_sessions WHERE id = ?').get(sid);
  assert.equal(mid.status, 'in_progress',
    '중단을 고르지 않았는데 세션이 종료됐습니다 — "나중에 이어서 하기"가 성립하지 않습니다.');

  // 재개 경로가 실제로 이 세션을 돌려줘야 한다(§7-3 — "이어서 진단"이 새 세션을 만들면 안 된다).
  const active = sl.getActiveDiagnosisV3(UID);
  assert.ok(active, '진행중 세션 조회(/v3/active)가 비었습니다.');
  assert.equal(active.sessionId, sid, `재개 대상 세션이 다릅니다(기대 ${sid}, 실제 ${active.sessionId}).`);
  assert.equal(active.targetNodeId, UNIT.unitId, '재개 세션의 목표 단원이 다릅니다(단원 CTA 재개 판정 근거).');

  // ② "결과 보기" 선택 → completed + 결과 + 학습경로
  const fin = sl.advanceDiagnosisV3(sid, { action: 'finish' });
  assert.equal(fin.finished, true, 'finish 액션이 종료를 반환하지 않았습니다.');
  const after = db.prepare('SELECT status FROM diagnosis_sessions WHERE id = ?').get(sid);
  assert.equal(after.status, 'completed', 'finish 후에도 세션이 completed 가 아닙니다.');

  const result = sl.getDiagnosisResultV3(sid);
  assert.ok(result && result.summary, '중단 후 결과가 비었습니다 — "결과 보기"가 빈손이면 안 됩니다.');
  assert.ok(pathRowOf(sid), '중단 후 학습경로가 생성되지 않았습니다(사용자 요구 ③).');
});

test('INV-DV3-8 — 하위호환: downCount/prereqQueue/branchVerdicts 가 없는 구 세션이 조기종료를 타지 않는다', () => {
  // 정본 DB 의 v3 세션 89건이 전부 이 형태다. 신규 필드를 지운 구 세션을 인위적으로 만든다.
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId });
  const sid = start.sessionId;
  const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  for (const k of ['prereqQueue', 'downCount', 'branchDepth', 'branchSample', 'branchVerdicts',
                   'prereqRound', 'nextRoundQueue', 'unitRound', 'preset', 'endReason', 'softStopAsked']) {
    delete st[k];
  }
  db.prepare('UPDATE diagnosis_sessions SET difficulty_path = ? WHERE id = ?').run(JSON.stringify(st), sid);

  // ① throw 없이 조회된다.
  const nx = sl.getNextDiagnosisV3(sid);
  assert.ok(nx, '구 세션에서 다음 문항 조회가 실패했습니다.');
  const res0 = sl.getDiagnosisResultV3(sid);
  assert.ok(res0 && res0.summary, '구 세션 결과 조회가 실패했습니다.');
  // 프리셋 미지정 구 세션은 표준으로 폴백해야 한다(정보 부재로 throw 금지).
  assert.equal(res0.preset.key, 'standard', `구 세션 프리셋 폴백이 표준이 아닙니다(${res0.preset.key}).`);

  // ② 정답 제출이 조기종료를 타지 않는다 — downCount 는 0 으로 정규화되므로 §4-1 게이트 밖.
  let q = nx.question || start.question;
  assert.ok(q, '구 세션에 출제 문항이 없습니다(픽스처 전제 붕괴).');
  const a = answerFor(q.questionId, 'correct');
  const r = sl.submitDiagnosisV3(sid, { questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId, answer: a.answer, answerIndex: a.answerIndex });
  assert.equal(r.isCorrect, true, '구 세션 채점이 정답을 정답으로 처리하지 않았습니다.');
  // ★ 부정 단언은 조건 밖 — 구 세션은 position_found 조기종료를 절대 타지 않는다.
  assert.notEqual(r.endReason, 'position_found',
    '구 세션이 조기종료(position_found)를 탔습니다 — 하위호환 게이트(downCount>0)가 깨졌습니다.');
  const st2 = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  assert.equal(st2.downCount || 0, 0, '구 세션 downCount 가 0 으로 유지되지 않았습니다.');
});

test('INV-DV3-8b — 하위호환 게이트 실작동: downCount 가 0 인 세션은 큐가 비어도 조기종료 대신 본류로 복귀한다', () => {
  // ⚠ INV-DV3-8 만으로는 부족하다 — 그 픽스처는 갈래에 진입하지 않아 §4-1 게이트를
  //   **한 번도 실행하지 않는다**(게이트를 지워도 초록불이 뜬다). 여기서 게이트 자체를 때린다.
  //   구성: 갈래에 실제로 진입한 뒤 downCount 를 구 세션처럼 0 으로 되돌리고, 큐를 비워
  //   "이 갈래를 통과하면 곧바로 큐 소진" 상태를 만든다.
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId });
  const sid = start.sessionId;

  // ① 본류 표본 전부 오답(§1-A — 표본을 다 본 뒤 판정) → [§1-B] 추가 진단 확인
  const { r } = failMainlineUntilAsk(sid, start.question);
  assert.ok(r && r.moreUnits, '픽스처 전제 붕괴: 본류 표본 실패가 추가 진단 확인을 만들지 않았습니다.');

  // ② '넣기' → 선수 갈래 진입
  const adv = sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: true });
  assert.ok(adv && adv.question, '픽스처 전제 붕괴: 선수 갈래 진입에 실패했습니다.');
  let concept = adv.concept, cur = adv.question;

  // ③ 구 세션처럼 downCount 를 0 으로 되돌리고 남은 큐를 비운다(= 이 갈래 통과 = 큐 소진)
  const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  st.downCount = 0;
  st.prereqQueue = [];
  st.nextRoundQueue = [];
  db.prepare('UPDATE diagnosis_sessions SET difficulty_path = ? WHERE id = ?').run(JSON.stringify(st), sid);
  const branchUnitName = concept && concept.unitName;
  const originUnitName = start.unit && start.unit.name;
  assert.notEqual(branchUnitName, originUnitName, '픽스처 전제 붕괴: 갈래 단원이 원 단원과 같습니다.');

  // ④ 갈래를 정답으로 통과시킨다 → 큐 소진 시점 도달
  let sawEarlyEnd = false, returnedToOrigin = false, guard = 0;
  while (cur && guard++ < 20) {
    const a = answerFor(cur.questionId, 'correct');
    const rr = sl.submitDiagnosisV3(sid, { questionId: cur.questionId, contentId: cur.contentId, nodeId: cur.nodeId, answer: a.answer, answerIndex: a.answerIndex });
    if (rr.endReason === 'position_found') { sawEarlyEnd = true; break; }
    if (rr.prereqDone === true) {
      // 본류 복귀 신호 — 구 세션의 기존 동작. 복귀 단원이 원 단원이어야 한다.
      returnedToOrigin = !!(rr.unit && rr.unit.name === originUnitName) ||
                         !!(rr.nextConcept && rr.nextConcept.unitName === originUnitName);
      break;
    }
    if (rr.finished || rr.sessionComplete) break;
    if (!rr.nextQuestion) break;
    cur = rr.nextQuestion;
    if (rr.nextConcept) concept = rr.nextConcept;
  }

  // ★ 부정 단언은 조건 밖 — downCount===0 세션은 §4-1 조기종료를 절대 타지 않는다.
  assert.equal(sawEarlyEnd, false,
    'downCount 가 0 인(구 세션 형태) 세션이 position_found 조기종료를 탔습니다 — ' +
    '하위호환 게이트가 제거되면 정본 DB 의 v3 세션 89건이 이상 동작합니다.');
  assert.equal(returnedToOrigin, true,
    '구 세션 형태에서 본류 복귀(_v3RestoreOriginUnit)가 일어나지 않았습니다 — 기존 동작이 깨졌습니다.');
});

// [2026-08-07] 문항 하드 상한(200) 제거 — 사용자 확정 "상한 필요없어".
//   아래 두 단언은 "200문항 이내"를 검사했는데, 그 숫자는 **진단이 끝나지 않던 시절의
//   응급 처치**였다. 이제 검사할 것은 숫자가 아니라 **반드시 끝나는가** 다.
//   유한성의 근거는 구조다 — visitedConcepts 단조 증가 + branchVerdicts 재진입 차단으로
//   같은 노드를 다시 방문할 수 없고, 노드 그래프가 유한하다. DIAG_V3_DOWN_CONCEPT_CAP(20)도 유지된다.
//   ⚠ 숫자 상한이 사라졌으므로 **무한 루프가 생기면 테스트가 멈춘다**. drive() 의 maxSteps 가
//     그 안전망이며, maxSteps 에 걸리는 것 자체가 실패다(= 종료 조건이 무력화됐다는 뜻).

test('INV-DV3-9 — 유한성: 전부 오답으로 자동 응답해도 반드시 종료된다', () => {
  // 갈래가 많은 단원 3개로 전수. 어느 하나라도 무한히 이어지면 실패.
  const targets = FIXTURE_UNITS.slice(0, 3);
  assert.ok(targets.length > 0, '픽스처 전제 붕괴: 대상 단원이 없습니다.');
  for (const t of targets) {
    const run = drive(t.unitId, () => 'wrong', { maxSteps: 600 });
    assert.equal(run.status, 'completed',
      `"${t.unitName}": 전부 오답인데 세션이 종료되지 않았습니다(status=${run.status}, ${run.asked}문항). ` +
      '숫자 상한을 없앴으므로 종료는 구조(visited·branchVerdicts·downCount·floor_reached)가 보장해야 합니다.');
    assert.equal(run.last.finished, true, `"${t.unitName}": 마지막 응답에 finished 가 없습니다.`);
    // maxSteps 에 닿았다면 사실상 무한 — 종료가 아니라 안전망에 걸린 것이다.
    assert.ok(run.asked < 600,
      `"${t.unitName}": ${run.asked}문항 — 테스트 안전망(maxSteps)에 닿았습니다. 종료 조건이 무력화됐습니다.`);
  }
});

test('INV-DV3-9b — 유한성(최장 조합): 꼼꼼히 + 전부 오답 + 매번 "넣기" 도 반드시 종료된다', () => {
  // ⚠ 여기가 **실측 최장 경로**다. 목표 단원에도 프리셋을 적용한 뒤(§1-A) 실측 최대가 194문항이었다.
  //   하드 상한(200)을 제거했으므로 이제 이 경로의 상한은 downCount(20) × 프리셋 문항 수다.
  //   학습맵에 차시가 더 붙으면 가장 먼저 길어지는 조합이므로 여기에 박아 둔다.
  const targets = FIXTURE_UNITS.slice(0, 2);
  assert.ok(targets.length > 0, '픽스처 전제 붕괴: 대상 단원이 없습니다.');
  const stuck = [];
  for (const t of targets) {
    const run = drive(t.unitId, () => 'wrong', { preset: 'thorough', maxSteps: 800 });
    if (run.status !== 'completed' || run.asked >= 800) stuck.push(`${t.unitName}: ${run.asked}문항/${run.status}`);
  }
  // ★ 부정 단언은 조건 밖.
  assert.deepEqual(stuck, [],
    `꼼꼼히 최장 경로가 종료되지 않았습니다: ${stuck.join(', ')} — ` +
    '숫자 상한이 없으므로 구조적 종료 조건이 유일한 방어선입니다.');
});

test('INV-DV3-11 — collectFallbackProblems 는 다른 과목·다른 학교급 문항을 절대 반환하지 않는다', () => {
  // 결함(2026-08-07): 'SELECT parent_id … FROM learning_map_nodes' 오타(실제는 parent_node_id)로
  //   폴백 2·3 이 throw → 침묵 catch → 매번 폴백 4(전 과목·전 학년 랜덤)로 떨어졌다.
  //   초1 수학 노드를 진단하는데 중등 이차함수·영어 문항이 섞여 나왔다.
  const CONTENT_TYPES = ['quiz', 'exam', 'problem', 'assessment', 'question'];

  // 문항형 콘텐츠에 "수학이 아닌" 과목이 실제로 존재해야 이 테스트가 의미를 갖는다(오염원 존재 확인).
  const foreign = db.prepare(`
    SELECT COUNT(*) AS c FROM contents
    WHERE content_type IN (${CONTENT_TYPES.map(() => '?').join(',')})
      AND subject IS NOT NULL AND subject NOT LIKE '수학%'
  `).get(...CONTENT_TYPES);
  assert.ok(foreign.c > 0,
    '픽스처 전제 붕괴: 비수학 문항형 콘텐츠가 0건이라 교차 오염을 검증할 수 없습니다.');

  // 노드에 직접 매핑이 없어 폴백을 실제로 타는 노드를 고른다(= 결함이 드러나던 경로).
  const candidates = db.prepare(`
    SELECT n.node_id, n.subject, n.grade_level, n.grade
    FROM learning_map_nodes n
    WHERE n.subject LIKE '수학%' AND n.grade_level = '초'
      AND NOT EXISTS (
        SELECT 1 FROM curriculum_node_descendants d
        JOIN node_contents nc ON nc.node_id = d.descendant_id
        JOIN contents c ON c.id = nc.content_id
        WHERE d.ancestor_id = n.node_id AND c.content_type IN (${CONTENT_TYPES.map(() => '?').join(',')})
      )
    ORDER BY n.node_id LIMIT 25
  `).all(...CONTENT_TYPES);
  assert.ok(candidates.length > 0,
    '픽스처 전제 붕괴: 폴백을 타는 초등 수학 노드가 없습니다.');

  let served = 0;
  const violations = [];
  for (const n of candidates) {
    const probs = sl.collectFallbackProblems(n.node_id, UID, 10) || [];
    served += probs.length;
    for (const p of probs) {
      const cid = Number(p.content_id != null ? p.content_id : p.id);
      const c = db.prepare('SELECT id, subject, grade FROM contents WHERE id = ?').get(cid);
      if (!c) continue;
      // 과목 교차 — 수학 노드에 국어·영어·과학·사회 문항이 오면 안 된다.
      if (c.subject && !/^수학/.test(String(c.subject))) {
        violations.push(`${n.node_id} → content ${cid} 과목=${c.subject}`);
      }
      // 학교급 교차 — 초등 노드에 중·고 문항이 오면 안 된다.
      if (c.grade != null && Number(c.grade) > 6) {
        violations.push(`${n.node_id} → content ${cid} 학년=${c.grade}(중·고)`);
      }
    }
  }
  // ★ 부정 단언은 조건 밖. 폴백이 0건을 돌려주는 것은 허용이지만(문항 준비 중), 오염은 0건이어야 한다.
  assert.deepEqual(violations, [],
    `폴백이 다른 과목·학교급 문항을 반환했습니다:\n  ${violations.slice(0, 10).join('\n  ')}`);
  assert.ok(served > 0,
    '폴백이 25개 노드 전부에서 0건을 반환했습니다 — 폴백 2·3 이 다시 죽었는지 확인하십시오(parent_node_id 오타).');
});

test('INV-DV3-12 (소스 락) — learning_map_nodes 를 존재하지 않는 parent_id 컬럼으로 조회하는 코드가 없다', () => {
  // 같은 오타의 재발·전파 방지. learning_map_nodes 의 부모 컬럼은 parent_node_id 다.
  //   (parent_id 자체는 comments·notice_comments·users 등 다른 테이블의 정상 컬럼이므로
  //    전역 금칙어로 두지 않고, learning_map_nodes 문맥에서만 금지한다.)
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const SKIP = new Set(['node_modules', '.git', 'data', 'uploads', '.claude']);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) files.push(p);
    }
  })(ROOT);
  assert.ok(files.length > 50, `소스 스캔 대상이 ${files.length}개뿐입니다(스캔 실패).`);

  // 주석은 제거하고 검사한다 — 결함 이력을 설명하는 주석까지 잡으면 소스 락이 무의미해진다.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const offenders = [];
  for (const f of files) {
    if (path.resolve(f) === path.resolve(__filename)) continue;   // 자기 자신(금칙어 문자열 보유) 제외
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    if (!src.includes('learning_map_nodes')) continue;
    // learning_map_nodes 가 등장하는 SQL 문자열 안에서 parent_node_id 가 아닌 parent_id 사용
    const re = /(?:SELECT|WHERE|JOIN|,)[^;`'"]{0,400}?learning_map_nodes[^;`'"]{0,400}/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const chunk = m[0];
      if (/(^|[^_\w])parent_id\b/.test(chunk.replace(/parent_node_id/g, 'PARENT_OK'))) {
        offenders.push(`${path.relative(ROOT, f)} :: ${chunk.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
    // 위 SQL 조각을 벗어난 별칭 접근(lmn.parent_id 등)도 잡는다.
    for (const alias of ['lmn.parent_id', 'n.parent_id', 'node.parent_id']) {
      if (src.includes(alias)) offenders.push(`${path.relative(ROOT, f)} :: ${alias}`);
    }
  }
  assert.deepEqual(offenders, [],
    `learning_map_nodes 를 parent_id 로 다루는 코드가 있습니다(실제 컬럼: parent_node_id):\n  ${offenders.join('\n  ')}`);
});

// ── 차시당 1문제 + 조기 확정 제거 (2026-08-07 사용자 확정) ──────────────────
//   "미리 단원을 진단시 사용자가 단원 진단문항을 설정했으면 해당 수량으로 봐야 함" + "B. 조기 확정 제거"
//   → 고른 수 = 실제 출제 수. 재출제(2-strike)도, 조기 확정도 없다.

/** 단원의 "출제 가능한 차시 수"(문항 보유) — 갈래당 기대 출제 수의 상한. */
function testableConceptCount(unitId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM learning_map_nodes lmn
    WHERE lmn.parent_node_id = ? AND lmn.node_level = 3
      AND EXISTS (SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id = nc.content_id WHERE nc.node_id = lmn.node_id)
  `).get(unitId).c;
}
const parentUnitOf = (conceptId) => {
  const r = db.prepare('SELECT parent_node_id FROM learning_map_nodes WHERE node_id = ?').get(conceptId);
  return r && r.parent_node_id;
};

test('INV-DV3-13 — 한 차시에서 문항이 2개 이상 출제되지 않는다 (재출제 제거)', () => {
  // 본류를 일부러 틀리는 시나리오 + 전부 틀리는 시나리오 둘 다에서 검증한다.
  //   전부 오답은 예전 2-strike 라면 **모든 차시가 2번씩** 나왔을 시나리오다.
  for (const [name, decide] of [['본류오답', FAIL_ORIGIN_PASS_PREREQ], ['전부오답', () => 'wrong']]) {
    const run = drive(UNIT.unitId, decide, { maxSteps: 260 });
    const seen = new Map();
    for (const s of run.steps) {
      if (!s.conceptId) continue;
      seen.set(s.conceptId, (seen.get(s.conceptId) || 0) + 1);
    }
    const repeated = [...seen.entries()].filter(([, n]) => n > 1);
    // ★ 부정 단언은 조건 밖.
    assert.deepEqual(repeated, [],
      `[${name}] 같은 차시가 2번 이상 출제됐습니다: ${JSON.stringify(repeated)} — 재출제(2-strike)가 되살아났습니다.`);
    assert.ok(run.steps.length > 0, `[${name}] 출제가 0건입니다(픽스처 전제 붕괴).`);
  }
});

test('INV-DV3-14 — 갈래당 출제 문항이 정확히 cap 개 (차시가 부족한 단원은 그 수만큼)', () => {
  for (const presetKey of ['quick', 'standard']) {
    const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ, { preset: presetKey });
    const cap = presetKey === 'quick' ? 4 : 5;
    const originUnitId = run.start.unit.nodeId;

    // 갈래(선수 단원)별 출제 수 집계 — 본류(목표 단원)는 제외
    const byUnit = new Map();
    for (const s of run.steps) {
      const uid = s.conceptId ? parentUnitOf(s.conceptId) : null;
      if (!uid || uid === originUnitId) continue;
      byUnit.set(uid, (byUnit.get(uid) || 0) + 1);
    }
    assert.ok(byUnit.size >= 2,
      `[${presetKey}] 검사된 선수 갈래가 ${byUnit.size}개입니다(2개 이상이어야 검증 성립).`);

    const bad = [];
    for (const [uid, asked] of byUnit) {
      const expected = Math.min(cap, testableConceptCount(uid));
      // 미만도 초과도 안 된다 — 조기 확정 제거로 "미만"이 사라졌다.
      if (asked !== expected) bad.push(`${uid}: 출제 ${asked} ≠ 기대 ${expected}(cap ${cap}, 출제가능차시 ${testableConceptCount(uid)})`);
    }
    assert.deepEqual(bad, [],
      `[${presetKey}] 갈래당 출제 수가 cap 과 다릅니다:\n  ${bad.join('\n  ')}`);
  }
});

test('INV-DV3-15 — 통과가 확정된 뒤에도 남은 문항이 계속 출제된다 (조기 확정 재발 방지)', () => {
  // 표준(cap 5, needPass 4): 앞 4개를 다 맞혀 통과가 확정돼도 5번째를 반드시 묻는다.
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ, { preset: 'standard' });
  const originUnitId = run.start.unit.nodeId;

  const byUnit = new Map();
  for (const s of run.steps) {
    const uid = s.conceptId ? parentUnitOf(s.conceptId) : null;
    if (!uid || uid === originUnitId) continue;
    if (!byUnit.has(uid)) byUnit.set(uid, []);
    byUnit.get(uid).push(s);
  }

  // 통과 확정선(needPass=4) 이후에도 문항이 더 나온 갈래가 **반드시 존재**해야 한다.
  //   (차시 5개 이상인 갈래가 하나라도 있으면 성립. 없으면 픽스처 전제 붕괴.)
  const eligible = [...byUnit.entries()].filter(([uid]) => testableConceptCount(uid) >= 5);
  assert.ok(eligible.length > 0,
    `픽스처 전제 붕괴: 차시 5개 이상인 선수 갈래가 없어 조기 확정 여부를 검증할 수 없습니다. ` +
    `갈래별 차시 수: ${[...byUnit.keys()].map(u => `${u}:${testableConceptCount(u)}`).join(', ')}`);

  const shortStopped = [];
  for (const [uid, steps] of eligible) {
    const correctPrefix = steps.slice(0, 4).every(s => s.isCorrect);
    // 앞 4개를 다 맞혔는데 5개째가 없으면 = 조기 확정이 살아 있다.
    if (correctPrefix && steps.length < 5) shortStopped.push(`${uid}: ${steps.length}문항에서 멈춤`);
  }
  assert.deepEqual(shortStopped, [],
    `통과 확정 후 남은 문항을 묻지 않고 멈췄습니다(조기 확정 재발): ${shortStopped.join(', ')}`);
});

// ── §1-B 추가 진단 확인 (2026-08-07 최종 확정) ──────────────────────────────
//   단원이 실패할 때마다 [추가 진단에 넣기] / [넣지 않기] 를 묻는다.
//   🔴 "넣지 않기" 는 **진단 종료가 아니다** — 그 단원 아래로 더 안 파는 것뿐이고
//     현재 큐에 이미 들어간 단원은 그대로 진행된다.

test('INV-DV3-16 — 추가 진단 확인은 단원이 실패할 때마다 뜨고, 통과한 단원에서는 뜨지 않는다', () => {
  // ① 본류 실패 + 갈래는 전부 통과 → 실패한 단원은 본류 1개뿐 → 질문도 1회
  const passRun = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);
  assert.equal(passRun.moreAsks.length, 1,
    `통과한 갈래에서도 추가 진단 확인이 떴습니다(기대 1회, 실제 ${passRun.moreAsks.length}회): ` +
    JSON.stringify(passRun.moreAsks.map(a => a.failedUnit)));
  assert.equal(passRun.moreAsks[0].failedUnit, passRun.originUnitName,
    '첫 질문이 실패한 본류 단원에서 뜨지 않았습니다.');

  // ② 전부 오답 → 단원이 실패할 때마다 떠야 하므로 2회 이상
  const failRun = drive(UNIT.unitId, () => 'wrong', { maxSteps: 260 });
  assert.ok(failRun.moreAsks.length >= 2,
    `단원이 여러 개 실패했는데 추가 진단 확인이 ${failRun.moreAsks.length}회뿐입니다 — ` +
    '"실패할 때마다"가 라운드당 1회로 묶였는지 확인하십시오.');

  // ③ 통과한 단원에서는 뜨지 않는다 — 질문이 뜬 단원은 전부 미통과여야 한다.
  const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(passRun.sid).difficulty_path);
  const verdicts = st.branchVerdicts || {};
  const askedOnPassed = passRun.moreAsks.filter(a => {
    const uid = Object.keys(verdicts).find(u => verdicts[u] === 'pass' &&
      (db.prepare('SELECT unit_name FROM learning_map_nodes WHERE node_id = ?').get(u) || {}).unit_name === a.failedUnit);
    return !!uid;
  });
  assert.deepEqual(askedOnPassed, [],
    `통과 판정 단원에서 추가 진단 확인이 떴습니다: ${JSON.stringify(askedOnPassed)}`);
});

test('INV-DV3-17 — 예고한 단원 수·문항 수가 "넣기" 후 실제 추가·출제 수와 일치한다', () => {
  // 조기 확정을 없앴으므로(§1-A) 이 수치는 추정이 아니라 확정값이다. 어긋나면 화면이 거짓말한다.
  const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ);
  assert.equal(run.moreAsks.length, 1, `추가 진단 확인이 1회가 아닙니다(${run.moreAsks.length}회).`);
  const forecast = run.moreAsks[0];
  assert.ok(forecast.units > 0 && forecast.questions > 0,
    `예고 값이 비었습니다: ${JSON.stringify(forecast)}`);

  const originUnitId = run.start.unit.nodeId;
  // 예고 이후 실제로 검사된 "선수 단원"과 그 출제 문항 수
  const after = run.steps.slice(forecast.atStep);
  const byUnit = new Map();
  for (const s of after) {
    const uid = s.conceptId ? parentUnitOf(s.conceptId) : null;
    if (!uid || uid === originUnitId) continue;
    byUnit.set(uid, (byUnit.get(uid) || 0) + 1);
  }
  const actualUnits = byUnit.size;
  let actualQuestions = 0;
  for (const n of byUnit.values()) actualQuestions += n;

  assert.equal(actualUnits, forecast.units,
    `예고한 단원 수(${forecast.units}) ≠ 실제 검사한 단원 수(${actualUnits}) — 화면이 거짓말합니다.`);
  assert.equal(actualQuestions, forecast.questions,
    `예고한 문항 수(${forecast.questions}) ≠ 실제 출제 수(${actualQuestions}) — 화면이 거짓말합니다.`);
});

test('INV-DV3-18 — 🔴 "넣지 않기"를 눌러도 진단이 끝나지 않고 현재 큐의 남은 단원이 이어진다', () => {
  // 가장 오해하기 쉬운 지점. 큐에 갈래가 여러 개 쌓인 뒤 거절해도 남은 갈래는 계속 확인돼야 한다.
  //   구성: 첫 실패(본류)는 넣기 → 갈래 여러 개 적재. 이후 갈래 실패는 전부 넣지 않기.
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId });
  const sid = start.sessionId;
  let q = start.question, concept = start.concept, guard = 0;
  let firstAsk = true;
  const unitsSeen = [];
  const declinedAt = [];
  while (q && guard++ < 200) {
    if (concept && concept.unitName) unitsSeen.push(concept.unitName);
    const a = answerFor(q.questionId, 'wrong');   // 전부 오답 → 단원마다 실패
    const r = sl.submitDiagnosisV3(sid, { questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId, answer: a.answer, answerIndex: a.answerIndex });
    if (r.moreUnits) {
      const accept = firstAsk;            // 첫 번째만 넣기 → 큐에 갈래를 쌓는다
      if (!accept) declinedAt.push(unitsSeen[unitsSeen.length - 1]);
      firstAsk = false;
      const adv = sl.advanceDiagnosisV3(sid, { action: 'more-units', accept });
      if (adv.finished || adv.sessionComplete) break;
      q = adv.question; concept = adv.concept;
      continue;
    }
    if (r.finished || r.sessionComplete) break;
    if (r.branch && r.branch.type === 'down' && r.branch.prereqConcept) {
      const adv = sl.advanceDiagnosisV3(sid, { action: 'go-prereq' });
      if (adv.finished || adv.sessionComplete) break;
      q = adv.question; concept = adv.concept; continue;
    }
    if (r.branch && r.branch.type === 'unit-complete') break;
    if (r.nextQuestion) { q = r.nextQuestion; if (r.nextConcept) concept = r.nextConcept; continue; }
    const nx = sl.getNextDiagnosisV3(sid);
    if (!nx || nx.finished || nx.sessionComplete || !nx.question) break;
    q = nx.question; if (nx.concept) concept = nx.concept;
  }

  assert.ok(declinedAt.length >= 1,
    '픽스처 전제 붕괴: "넣지 않기"를 한 번도 고르지 않았습니다(질문이 2회 이상 떠야 함).');
  // ★ 거절 이후에도 다른 단원이 계속 검사돼야 한다 — 거절 = 종료가 아니다. (부정 단언, 조건 밖)
  const distinctUnits = [...new Set(unitsSeen)];
  assert.ok(distinctUnits.length >= 3,
    `거절 후 진단이 조기 종료됐습니다. 검사된 단원이 ${distinctUnits.length}개뿐입니다: ${distinctUnits.join(', ')} — ` +
    '"넣지 않기"는 그 단원 아래로 안 파는 것일 뿐, 현재 큐의 남은 단원은 계속 확인돼야 합니다.');
});

test('INV-DV3-19 — "넣지 않기"를 고르면 그 단원의 선수가 적립되지 않는다', () => {
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId });
  const sid = start.sessionId;
  let q = start.question, r = null, guard = 0;
  while (q && guard++ < 20) {
    const a = answerFor(q.questionId, 'wrong');
    r = sl.submitDiagnosisV3(sid, { questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId, answer: a.answer, answerIndex: a.answerIndex });
    if (r.moreUnits) break;
    q = r.nextQuestion;
  }
  assert.ok(r && r.moreUnits, '픽스처 전제 붕괴: 추가 진단 확인이 뜨지 않았습니다.');
  assert.ok(r.moreUnits.units > 0, `예고 단원 수가 0입니다: ${JSON.stringify(r.moreUnits)}`);

  const before = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  const beforeQ = (before.prereqQueue || []).length + (before.nextRoundQueue || []).length;

  sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: false });

  const after = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  const afterQ = (after.prereqQueue || []).length + (after.nextRoundQueue || []).length;
  // ★ 거절했으므로 큐가 늘어나면 안 된다. (부정 단언, 조건 밖)
  assert.ok(afterQ <= beforeQ,
    `"넣지 않기"인데 큐가 늘었습니다: ${beforeQ} → ${afterQ} (적립이 취소되지 않았습니다).`);
});

test('INV-DV3-20 — 모든 단원에서 "넣지 않기"를 고르면 큐 소진으로 정상 종료된다', () => {
  for (const t of FIXTURE_UNITS.slice(0, 3)) {
    const run = drive(t.unitId, () => 'wrong', { acceptMore: false, maxSteps: 260 });
    assert.equal(run.status, 'completed',
      `"${t.unitName}": 전부 거절했는데 세션이 종료되지 않았습니다(status=${run.status}).`);
    assert.ok(run.moreAsks.length >= 1,
      `"${t.unitName}": 추가 진단 확인이 한 번도 뜨지 않았습니다.`);
    // [2026-08-07] 하드 상한(200) 제거 — 검사 대상은 숫자가 아니라 "끝났는가"(위 status 단언).
    //   여기서는 안전망(maxSteps)에 닿지 않았는지만 본다. 닿았다면 사실상 무한이다.
    assert.ok(run.asked < 260,
      `"${t.unitName}": ${run.asked}문항 — 테스트 안전망에 닿았습니다(종료 조건 무력화).`);
  }
});

test('INV-DV3-22 — 오래 푼 학생에게 중단 확인(§5-1)을 반드시 한 번 묻는다 (하향 경로 포함)', () => {
  // 결함(2026-08-07 실측): 중단 확인 판정을 submitDiagnosisV3 **끝줄**에 두었는데,
  //   재출제 제거 후 오답 경로가 전부 _v3SampleConceptFail·_v3DownTo 에서 조기 return 하면서
  //   그 줄에 도달하지 못했다. 8개 단원 × 3프리셋 전부 softStop 0건 — 95문항을 풀어도 아무도 묻지 않았다.
  //   (되살린 브레이크가 다시 잠든 것) → 판정을 래퍼 한 곳으로 모아 모든 반환 경로를 덮는다.
  const targets = FIXTURE_UNITS.slice(0, 3);
  assert.ok(targets.length > 0, '픽스처 전제 붕괴: 대상 단원이 없습니다.');

  const noAsk = [];
  for (const t of targets) {
    const run = drive(t.unitId, () => 'wrong', { maxSteps: 260 });
    const asked = run.steps.filter(s => s.softStop);
    // 개념 상한(30)을 넘길 만큼 길게 푼 경우에만 의미가 있다 — 전제를 단언으로 고정.
    assert.ok(run.steps.length > 30,
      `"${t.unitName}": ${run.steps.length}문항뿐이라 중단 확인 조건(개념 30)에 도달하지 않습니다(픽스처 전제 붕괴).`);
    if (asked.length === 0) noAsk.push(`${t.unitName}: ${run.steps.length}문항 풀었는데 0회`);
    // 세션당 1회만 물어야 한다(매 제출마다 모달이 뜨면 진단이 불가능).
    if (asked.length > 1) noAsk.push(`${t.unitName}: ${asked.length}회 중복 질문`);
  }
  // ★ 부정 단언은 조건 밖.
  assert.deepEqual(noAsk, [],
    `중단 확인이 정확히 1회 발생하지 않았습니다:\n  ${noAsk.join('\n  ')}`);
});

// ── §1-A 🔴 목표 단원(본류)에도 프리셋을 똑같이 적용 (2026-08-07 사용자 확정) ───────────
//   > "해당 단원을 프리셋에서 설정한 문항 수만큼 본다고, 이미 정답률이 기준에 못 미친다고
//   >  바로 하향으로 내리지 말라고"
//   결함(이 회귀 이전): 목표 단원만 표본 없이 진행돼 **1문제 오답 즉시 하향**했다.
//   화면은 "5문제 볼게요"라고 하는데 실제로는 1문제만 나왔다(라벨↔동작 불일치).

/** 목표 단원(본류)에서 실제로 출제될 표본 크기 — 프리셋 cap 과 출제가능 차시 수의 min. */
function mainlineCapOf(unitId, presetKey) {
  const cap = presetKey === 'quick' ? 4 : 5;
  return Math.min(cap, testableConceptCount(unitId));
}

/**
 * 목표 단원에서 지시대로 답하며 **본류 단원에서 출제된 문항만** 센다.
 * @param decide (i) => 'correct'|'wrong'   i = 본류에서의 0-based 문항 순번
 */
function driveMainline(unitNodeId, decide, presetKey) {
  const start = sl.startDiagnosisV3(UID, { unitNodeId, preset: presetKey });
  const sid = start.sessionId;
  const originUnitId = start.unit.nodeId;
  let q = start.question, concept = start.concept, r = null;
  const asked = [];        // 본류에서 출제된 { conceptId, want, isCorrect, stage }
  let guard = 0;
  while (q && guard++ < 40) {
    const inOrigin = concept && concept.nodeId && parentUnitOf(concept.nodeId) === originUnitId;
    if (!inOrigin) break;                      // 갈래로 넘어갔으면 본류 집계 종료
    const want = decide(asked.length);
    const a = answerFor(q.questionId, want);
    r = sl.submitDiagnosisV3(sid, {
      questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId,
      answer: a.answer, answerIndex: a.answerIndex
    });
    asked.push({ conceptId: concept.nodeId, want, isCorrect: !!r.isCorrect, stage: r.attemptStage });
    if (r.moreUnits || r.finished || r.sessionComplete || r.unitDone) break;
    if (r.branch && r.branch.type === 'down') break;
    if (!r.nextQuestion) break;
    q = r.nextQuestion;
    if (r.nextConcept) concept = r.nextConcept;
  }
  return { sid, start, originUnitId, asked, last: r };
}

test('INV-DV3-23 — 목표 단원에서도 프리셋 문항 수만큼 출제된다 (첫 문제를 틀려도 멈추지 않는다)', () => {
  for (const presetKey of ['quick', 'standard']) {
    const expected = mainlineCapOf(UNIT.unitId, presetKey);
    assert.ok(expected >= 2,
      `픽스처 전제 붕괴: "${UNIT.unitName}" 의 출제가능 차시가 ${testableConceptCount(UNIT.unitId)}개라 검증이 성립하지 않습니다.`);

    // ① 전부 오답 — 1문제 오답으로 즉시 하향하면 asked 가 1 에서 멈춘다(과거 결함).
    const allWrong = driveMainline(UNIT.unitId, () => 'wrong', presetKey);
    assert.equal(allWrong.asked.length, expected,
      `[${presetKey}] 전부 오답: 목표 단원에서 ${allWrong.asked.length}문항만 출제됐습니다(기대 ${expected}). ` +
      '화면이 예고한 문항 수와 실제 출제 수가 어긋납니다 — 본류 즉시 하향이 되살아났는지 확인하십시오.');
    assert.ok(allWrong.last && allWrong.last.moreUnits,
      `[${presetKey}] 표본 소진 후 §1-B 추가 진단 확인이 뜨지 않았습니다.`);

    // ② 전부 정답 — 조기 확정이 되살아나면 needPass 도달 즉시 멈춘다.
    const allRight = driveMainline(UNIT.unitId, () => 'correct', presetKey);
    assert.equal(allRight.asked.length, expected,
      `[${presetKey}] 전부 정답: 목표 단원에서 ${allRight.asked.length}문항만 출제됐습니다(기대 ${expected}) — 조기 확정 재발.`);
    assert.equal(allRight.last.unitDone, true,
      `[${presetKey}] 목표 단원 표본 통과인데 단원 완료(unitDone)가 서지 않았습니다.`);
    assert.equal(allRight.last.branch && allRight.last.branch.type, 'unit-complete',
      `[${presetKey}] 통과 후 분기가 unit-complete 가 아닙니다(${allRight.last.branch && allRight.last.branch.type}).`);
    // 통과했으므로 하향 예고(§1-B)가 뜨면 안 된다. 부정 단언, 조건 밖.
    assert.equal(allRight.last.moreUnits, undefined,
      `[${presetKey}] 통과한 목표 단원에서 추가 진단 확인이 떴습니다.`);
  }
});

test('INV-DV3-24 — 🔴 목표 단원에서 통과가 불가능해진 뒤에도 남은 문항이 계속 출제된다', () => {
  // 표준(5문제 / 4개 통과): 1·2번을 틀리면 4개 통과가 **수학적으로 불가능**하다.
  //   그래도 3·4·5번을 다 물어야 한다("5문제 볼게요"라고 했으므로). 여기서 멈추면 화면이 거짓말이다.
  const expected = mainlineCapOf(UNIT.unitId, 'standard');
  assert.ok(expected >= 4,
    `픽스처 전제 붕괴: 목표 단원 표본이 ${expected}개라 "통과 불가능 후 계속" 을 검증할 수 없습니다(4 이상 필요).`);

  const run = driveMainline(UNIT.unitId, (i) => (i < 2 ? 'wrong' : 'correct'), 'standard');
  assert.equal(run.asked.length, expected,
    `앞 2문제를 틀려 통과가 불가능해진 뒤 출제가 ${run.asked.length}문항에서 멈췄습니다(기대 ${expected}) — 조기 확정(불가능 판정) 재발.`);

  // 불가능 확정(2번째 오답) 이후에도 실제로 문항이 더 나왔는지 — 개수로 직접 확인.
  const afterImpossible = run.asked.length - 2;
  assert.ok(afterImpossible >= 2,
    `통과 불가능 확정 이후 출제가 ${afterImpossible}문항뿐입니다(기대 ${expected - 2}).`);
  // 그 뒤 문항들은 전부 정답이었는데도 판정은 '하향'이어야 한다(needPass 미달).
  assert.equal(run.asked.slice(2).every(s => s.isCorrect), true,
    '통과 불가능 이후 문항이 정답 처리되지 않았습니다(픽스처 전제 붕괴).');
  assert.ok(run.last && run.last.moreUnits,
    '표본 소진 후 needPass 미달인데 하향(§1-B 추가 진단 확인)으로 가지 않았습니다.');
});

test('INV-DV3-25 — 목표 단원의 판정 기준이 갈래 단원과 동일하다 (프리셋수-1 정답이면 통과)', () => {
  // ① 세션 상태에 박힌 표본 기준(cap·needPass)이 본류와 갈래에서 같은 값이어야 한다.
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId, preset: 'standard' });
  const sid = start.sessionId;
  const readSample = () => {
    const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
    return st.branchSample;
  };
  const mainBs = readSample();
  assert.ok(mainBs && mainBs.unitId,
    '목표 단원(본류)에 표본이 서 있지 않습니다 — 프리셋이 본류에 적용되지 않았습니다.');
  assert.equal(mainBs.unitId, start.unit.nodeId, '본류 표본의 단원이 목표 단원이 아닙니다.');
  assert.equal(mainBs.needPass, start.preset.needPass,
    `본류 표본 통과 기준(${mainBs.needPass})이 프리셋 기준(${start.preset.needPass})과 다릅니다.`);

  // 갈래로 내려간 뒤의 기준과 대조
  const { r } = failMainlineUntilAsk(sid, start.question);
  assert.ok(r && r.moreUnits, '픽스처 전제 붕괴: 본류 표본 실패가 추가 진단 확인을 만들지 않았습니다.');
  const adv = sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: true });
  assert.ok(adv && adv.question, '픽스처 전제 붕괴: 갈래 진입에 실패했습니다.');
  const branchBs = readSample();
  assert.ok(branchBs && branchBs.unitId, '갈래 단원에 표본이 서 있지 않습니다.');
  assert.notEqual(branchBs.unitId, mainBs.unitId, '픽스처 전제 붕괴: 갈래 단원이 목표 단원과 같습니다.');
  assert.equal(branchBs.needPass, mainBs.needPass,
    `판정 기준이 두 개입니다 — 본류 needPass=${mainBs.needPass}, 갈래 needPass=${branchBs.needPass} (§1-A "예외 없다" 위반).`);

  // ② 표준(5/4)에서 **1개만 틀려도 통과**여야 한다 — 목표 단원만 1오답으로 탈락시키면 기준이 두 개가 된다.
  const cap = mainlineCapOf(UNIT.unitId, 'standard');
  const needPass = Math.min(cap, 4);
  assert.ok(cap - needPass >= 1,
    `픽스처 전제 붕괴: 목표 단원 표본 ${cap}개 · 통과 기준 ${needPass}개라 "1개 오답 허용"을 검증할 수 없습니다.`);
  const run = driveMainline(UNIT.unitId, (i) => (i === 0 ? 'wrong' : 'correct'), 'standard');
  assert.equal(run.asked.length, cap,
    `1오답 시나리오에서 ${run.asked.length}문항만 출제됐습니다(기대 ${cap}).`);
  assert.equal(run.last.unitDone, true,
    `${cap}문제 중 ${cap - 1}개 정답인데 목표 단원이 통과되지 않았습니다 — 갈래(같은 기준)라면 통과입니다.`);
  // 부정 단언은 조건 밖 — 통과했으므로 하향 예고가 뜨면 안 된다.
  assert.equal(run.last.moreUnits, undefined,
    `${cap - 1}/${cap} 정답인데 하향(추가 진단 확인)으로 갔습니다 — 목표 단원 기준이 갈래보다 엄격합니다.`);
});

test('INV-DV3-27 — 표본으로 통과한 단원의 "안 물어본 개념"이 나중에 선수로 되돌아오지 않는다', () => {
  // ★ 본류 표본화(§1-A)가 새로 만든 구멍. 예전엔 목표 단원의 개념을 **전부** 물어 통과했으므로
  //   남는 개념이 없었다. 이제는 9개 중 5개만 묻고 통과하므로 안 물어본 4개가 남고,
  //   그 개념이 다른 단원의 선수로 걸리면 **방금 통과한 단원을 다시 물어보게 된다**
  //   (§1-A "통과한 단원의 선수는 큐에 넣지 않는다" 정면 위반).
  //
  // 픽스처는 우연에 맡기지 않는다 — 선수 엣지(A개념 → B개념)가 실제로 있는 단원 쌍을 SQL 로 고르고,
  //   A 를 "표본으로 통과해 마친 단원"(completedUnits)으로 만든 상태에서 B 를 실패시킨다.
  const pair = db.prepare(`
    SELECT ca.node_id AS a, pa.node_id AS unitA, pa.unit_name AS nameA,
           cb.node_id AS b, pb.node_id AS unitB, pb.unit_name AS nameB
    FROM learning_map_edges e
    JOIN learning_map_nodes ca ON ca.node_id = e.from_node_id AND ca.node_level = 3
    JOIN learning_map_nodes cb ON cb.node_id = e.to_node_id   AND cb.node_level = 3
    JOIN learning_map_nodes pa ON pa.node_id = ca.parent_node_id AND pa.node_level = 2
    JOIN learning_map_nodes pb ON pb.node_id = cb.parent_node_id AND pb.node_level = 2
    WHERE e.edge_type = 'prerequisite' AND pa.node_id <> pb.node_id
      AND EXISTS (SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id = nc.content_id WHERE nc.node_id = ca.node_id)
      AND EXISTS (SELECT 1 FROM node_contents nc JOIN content_questions cq ON cq.content_id = nc.content_id WHERE nc.node_id = cb.node_id)
      -- b 의 선수가 **전부 A 안에** 있어야 한다: A 를 걸러내면 추가할 것이 하나도 남지 않는 상태 →
      --   "통과한 단원뿐이면 추가 진단을 예고조차 하지 않는다"가 관측 가능해진다.
      AND NOT EXISTS (
        SELECT 1 FROM learning_map_edges e2
        JOIN learning_map_nodes c2 ON c2.node_id = e2.from_node_id AND c2.node_level = 3
        WHERE e2.to_node_id = cb.node_id AND e2.edge_type = 'prerequisite'
          AND c2.parent_node_id <> pa.node_id
      )
    ORDER BY pa.node_id, pb.node_id LIMIT 1
  `).get();
  assert.ok(pair, '픽스처 전제 붕괴: 단원을 가로지르는 선수 엣지가 없습니다(학습맵 엣지 소실).');

  // B 단원 진단 세션을 만들고, "A 는 표본으로 통과해 이미 마친 단원" 상태를 주입한다.
  const start = sl.startDiagnosisV3(UID, { unitNodeId: pair.unitB, preset: 'quick' });
  const sid = start.sessionId;
  const stRow = () => JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  const st0 = stRow();
  st0.completedUnits = [pair.unitA];      // A 를 통과 단원으로
  st0.currentConcept = pair.b;            // 지금 푸는 개념 = A 를 선수로 갖는 B 개념
  st0.branchSample = null;                // 표본 미적용 경로(_v3DownTo)로 곧장 하향 판정시킨다
  if (!st0.visitedConcepts.includes(pair.b)) st0.visitedConcepts.push(pair.b);
  db.prepare('UPDATE diagnosis_sessions SET difficulty_path = ?, current_node_id = ? WHERE id = ?')
    .run(JSON.stringify(st0), pair.b, sid);

  // 전제 ①: A 의 그 개념은 아직 검사되지 않았다(= "안 물어본 개념").
  assert.equal(st0.visitedConcepts.includes(pair.a), false, `픽스처 전제 붕괴: A 개념(${pair.a})이 이미 방문됐습니다.`);
  assert.equal((st0.passedConcepts || []).includes(pair.a), false, `픽스처 전제 붕괴: A 개념(${pair.a})이 이미 통과됐습니다.`);
  // 전제 ②: A 개념은 실제로 B 개념의 선수다(가드가 없으면 반드시 후보로 올라온다).
  const backward = db.prepare(
    "SELECT from_node_id AS id FROM learning_map_edges WHERE to_node_id = ? AND edge_type = 'prerequisite'"
  ).all(pair.b).map(r => r.id);
  assert.ok(backward.includes(pair.a),
    `픽스처 전제 붕괴: A 개념(${pair.a})이 B 개념(${pair.b})의 선수가 아닙니다.`);

  // B 개념을 오답으로 실패시킨다 → 선수 적재(또는 적재 예고)가 일어나는 지점.
  const nx = sl.getNextDiagnosisV3(sid);
  assert.ok(nx && nx.question, '픽스처 전제 붕괴: B 개념에 출제할 문항이 없습니다.');
  const a0 = answerFor(nx.question.questionId, 'wrong');
  const r = sl.submitDiagnosisV3(sid, {
    questionId: nx.question.questionId, contentId: nx.question.contentId, nodeId: nx.question.nodeId,
    answer: a0.answer, answerIndex: a0.answerIndex
  });
  // ★ ① 추가할 것이 통과 단원뿐이면 §1-B 예고 자체가 뜨면 안 된다.
  //   (뜬다면 학생은 "이미 통과한 단원 4문제를 더 풀라"는 말을 듣는다 — 화면이 거짓말한다.)
  assert.equal(r.moreUnits, undefined,
    `통과로 마친 단원("${pair.nameA}") 하나뿐인데 추가 진단을 예고했습니다: ${JSON.stringify(r.moreUnits)} — ` +
    '_v3PrereqCandidates 의 completedUnits 가드가 빠졌습니다.');
  if (r.moreUnits) sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: true });

  // ★ ② 큐·현재 개념에도 올라오면 안 된다(적재/pop 양쪽 가드). 부정 단언, 조건 밖.
  const st1 = stRow();
  const queued = [...(st1.prereqQueue || []), ...(st1.nextRoundQueue || []),
                  st1._pendingPrereq, st1.currentConcept].filter(Boolean);
  const leaked = queued.filter(c => parentUnitOf(c) === pair.unitA);
  assert.deepEqual(leaked, [],
    `통과로 마친 단원("${pair.nameA}")의 개념이 다시 진단 대상이 됐습니다: ${JSON.stringify(leaked)} — ` +
    '표본 통과 뒤 남은 개념이 선수로 되돌아오는 구멍(§1-A 위반)입니다.');
});

test('INV-DV3-26 — 중단 확인(softStop)이 §1-B 추가 진단 턴과 겹쳐도 소실되지 않는다', () => {
  // 결함(감리 84회 주행 중 1회 실측): more-units 턴에 softStop 을 함께 실으면 FE 는
  //   추가 진단 모달을 띄우고 return 해 softStop 을 읽지 않는데, BE 는 softStopAsked 를 이미 소진해
  //   **그 세션의 중단 확인이 영구 소실**됐다. 되살린 브레이크가 좁은 경로에서 다시 잠든 형태.
  const CONCEPT_CAP = 30;
  const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId, preset: 'quick' });
  const sid = start.sessionId;
  const stateOf = () => JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid).difficulty_path);
  const saveState = (st) => db.prepare('UPDATE diagnosis_sessions SET difficulty_path = ? WHERE id = ?').run(JSON.stringify(st), sid);
  // "오래 푼 학생" 상태를 만든다 — 매 제출 직전 개념 수를 상한 직전으로 맞춰, 어느 턴이든 조건이 참이 되게.
  const primeLongSession = () => { const st = stateOf(); st.diagnosedConcepts = CONCEPT_CAP - 1; saveState(st); };

  // 본류 표본을 전부 오답으로 소진 → 마지막 문항에서 more-units 턴이 된다.
  //   ★ 조건(개념 30)은 **그 마지막 턴에만** 참이 되게 한다. 앞 턴들에서 미리 참이 되면
  //     그때 정상적으로 물어(=표식 소진) 정작 검증하려는 겹침 상황이 만들어지지 않는다.
  const capQ = mainlineCapOf(UNIT.unitId, 'quick');
  assert.ok(capQ >= 2, `픽스처 전제 붕괴: 목표 단원 표본이 ${capQ}개입니다(2 이상 필요).`);
  let q = start.question, r = null, step = 0;
  while (q && step < capQ) {
    step++;
    if (step === capQ) primeLongSession();   // 마지막 턴 = §1-B 추가 진단 확인이 뜨는 턴
    const a = answerFor(q.questionId, 'wrong');
    r = sl.submitDiagnosisV3(sid, { questionId: q.questionId, contentId: q.contentId, nodeId: q.nodeId, answer: a.answer, answerIndex: a.answerIndex });
    if (r.moreUnits) break;
    q = r.nextQuestion;
  }
  assert.ok(r && r.moreUnits, '픽스처 전제 붕괴: more-units 턴에 도달하지 못했습니다.');
  assert.equal(step, capQ, `픽스처 전제 붕괴: ${step}번째 턴에서 추가 진단 확인이 떴습니다(기대 ${capQ}).`);
  assert.ok((stateOf().diagnosedConcepts || 0) >= CONCEPT_CAP,
    `픽스처 전제 붕괴: 개념 수가 ${stateOf().diagnosedConcepts} 라 중단 확인 조건(${CONCEPT_CAP})이 참이 아닙니다.`);

  // ★ 이 턴에는 표식을 태우면 안 된다 — FE 가 이 턴을 추가 진단 모달로 소비하기 때문.
  assert.equal(stateOf().softStopAsked, false,
    'more-units 턴에서 softStopAsked 가 소진됐습니다 — 그 세션의 중단 확인이 영구 소실됩니다(감리 P1-1 재발).');

  // 진단을 이어가면(학생이 실제로 문항을 받는 턴) 반드시 한 번은 물어야 한다.
  const adv = sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: true });
  assert.ok(adv && adv.question, '픽스처 전제 붕괴: 갈래 진입에 실패했습니다.');
  let q2 = adv.question, sawSoftStop = false, guard2 = 0;
  while (q2 && guard2++ < 12) {
    primeLongSession();
    const a = answerFor(q2.questionId, 'correct');
    const rr = sl.submitDiagnosisV3(sid, { questionId: q2.questionId, contentId: q2.contentId, nodeId: q2.nodeId, answer: a.answer, answerIndex: a.answerIndex });
    if (rr.softStop && rr.softStop.reason) { sawSoftStop = true; break; }
    if (rr.finished || rr.sessionComplete) break;
    if (rr.moreUnits) { const nx = sl.advanceDiagnosisV3(sid, { action: 'more-units', accept: true }); if (!nx || !nx.question) break; q2 = nx.question; continue; }
    if (rr.branch && rr.branch.type === 'down') { const nx = sl.advanceDiagnosisV3(sid, { action: 'go-prereq' }); if (!nx || !nx.question) break; q2 = nx.question; continue; }
    if (!rr.nextQuestion) break;
    q2 = rr.nextQuestion;
  }
  // ★ 부정 단언은 조건 밖 — 미룬 판정은 반드시 되살아나야 한다(미루는 것과 삼키는 것은 다르다).
  assert.equal(sawSoftStop, true,
    'more-units 턴 이후에도 중단 확인이 한 번도 뜨지 않았습니다 — 표식만 태우고 모달은 사라진 것과 같습니다.');
});

test('INV-DV3-21 (소스 락) — 프리셋 문구가 BE 정본(_v3PresetInfo.desc)과 화면에서 같다', () => {
  // "화면마다 다른 말"을 막는 가드. FE 프리셋 카드의 rule 문자열은 BE desc 와 글자까지 같아야 한다.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'self-learn', 'learning-map.html'), 'utf8');

  const expectedByKey = {};
  for (const key of ['quick', 'standard', 'thorough']) {
    // BE 정본 문구 — 세션 상태에 preset 만 담아 호출하는 것과 동치인 경로로 얻는다.
    const start = sl.startDiagnosisV3(UID, { unitNodeId: UNIT.unitId, preset: key });
    expectedByKey[key] = start.preset.desc;
    assert.ok(start.preset.desc && start.preset.desc.length > 3, `${key} 프리셋 desc 가 비었습니다.`);
  }

  const missing = [];
  for (const [key, desc] of Object.entries(expectedByKey)) {
    // FE 카드 정의에서 해당 key 의 rule 문자열을 추출
    const m = html.match(new RegExp(`key:'${key}'[^}]*rule:'([^']*)'`));
    if (!m) { missing.push(`${key}: FE 카드 정의를 찾지 못함`); continue; }
    if (m[1] !== desc) missing.push(`${key}: FE "${m[1]}" ≠ BE "${desc}"`);
  }
  assert.deepEqual(missing, [],
    `프리셋 문구가 화면과 서버에서 다릅니다:\n  ${missing.join('\n  ')}`);
});

test('INV-DV3-10 — 프리셋 3종이 실제로 다른 표본 크기로 동작한다(§1-A)', () => {
  const seen = {};
  for (const p of ['quick', 'standard', 'thorough']) {
    const run = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ, { preset: p });
    const st = JSON.parse(db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(run.sid).difficulty_path);
    assert.equal(st.preset, p, `세션에 프리셋이 ${p} 로 저장되지 않았습니다(실제: ${st.preset}).`);
    const res = sl.getDiagnosisResultV3(run.sid);
    assert.equal(res.preset.key, p, `결과에 표시되는 프리셋이 다릅니다(기대 ${p}, 실제 ${res.preset.key}).`);
    seen[p] = run.asked;
  }
  // 통과 기준 개수가 프리셋대로여야 한다(화면 문구 "차시 N개 중 M개 정답"의 근거).
  const q = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ, { preset: 'quick' });
  const rq = sl.getDiagnosisResultV3(q.sid);
  assert.equal(rq.preset.sampleCap, 4, '빠르게 프리셋의 표본이 4가 아닙니다.');
  assert.equal(rq.preset.needPass, 3, '빠르게 프리셋의 통과 기준이 3개가 아닙니다.');
  const s = drive(UNIT.unitId, FAIL_ORIGIN_PASS_PREREQ, { preset: 'standard' });
  const rs = sl.getDiagnosisResultV3(s.sid);
  assert.equal(rs.preset.sampleCap, 5, '표준 프리셋의 표본이 5가 아닙니다.');
  assert.equal(rs.preset.needPass, 4, '표준 프리셋의 통과 기준이 4개가 아닙니다.');

  // 꼼꼼히는 빠르게보다 적게 물을 수 없다(차시를 전부 보므로).
  assert.ok(seen.thorough >= seen.quick,
    `꼼꼼히(${seen.thorough}문항)가 빠르게(${seen.quick}문항)보다 적게 출제됐습니다 — 프리셋이 동작하지 않습니다.`);
});
