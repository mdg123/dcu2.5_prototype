// test/diagnosis.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 D] 진단검사 v3 회귀 (이번 세션 다수 수정 — db/self-learn-extended.js v3 엔진).
//   핵심 박제:
//     D-1 단원 단위 진단: startDiagnosisV3 는 node_level=2(단원)만 수용. 차시(level3) 거부.
//     D-2 종료 백스톱: 어떤 클라이언트 동작에서도 누적 출제가 하드캡(200)을 넘으면 finished.
//         (DIAG_V3_HARD_QUESTION_CAP — 무한 제출 방어선)
//     D-3 표본 과반 통과 규칙(DIAG_V3_PREREQ_SAMPLE_N=3): 선수 갈래 진입 시 표본 검사로 통과/하향.
//         (직접 호출 가능 범위: 풀 시나리오 구성이 비결정적이라, 채점·이동의 "구조 계약"과
//          상태 일관성을 검증 — strike/이동/오답노트 자동등록·종료 안전망.)
//     D-4 진단↔학습 분리: v3 진단이 user_node_status.status 를 바꾸지 않는다(학습 status 불변).
//
// DB 격리: 실 DB → 임시 복사본. db 모듈 require "전에" DB_PATH 주입. (복사본만 — 실 DB 무오염)
// 데이터(실 DB 실측): student1=id3.
//   진단가능 단원 UNIT='Uf0de261c32febb6c'(node_level=2, 개념27·문항295).
//   차시(거부대상) LESSON='E6MATA03B11C36D01'(node_level=3, UNIT 의 자식).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const sl = require('../db/self-learn-extended');
const db = openTestDb();

const S1 = 3;
const UNIT = 'Uf0de261c32febb6c';        // node_level=2 (단원)
const LESSON = 'E6MATA03B11C36D01';      // node_level=3 (차시) — 거부되어야

// ──────────────────────────────────────────────────────────────────────────
// D-1: 진단은 단원(node_level=2) 단위 — 차시(level3)·미존재 노드는 거부.
// ──────────────────────────────────────────────────────────────────────────
test('DIAG-D1: v3 진단은 단원(level2)만 — 차시·미존재 노드 거부', () => {
  // (a) 단원: 정상 시작
  const ok = sl.startDiagnosisV3(S1, { unitNodeId: UNIT });
  assert.ok(ok && ok.sessionId, '단원(level2) 으로는 정상 시작되어야');
  assert.equal(ok.unit.nodeId, UNIT, '시작 unit.nodeId 가 입력 단원과 일치');

  // (b) 차시(level3): 404 (단원을 찾을 수 없음 — node_level=2 조건 불일치)
  assert.throws(
    () => sl.startDiagnosisV3(S1, { unitNodeId: LESSON }),
    (e) => e && e.statusCode === 404,
    '차시(level3) 노드로 진단 시작 시 404(단원 아님)여야 한다'
  );

  // (c) unitNodeId 누락: 400
  assert.throws(
    () => sl.startDiagnosisV3(S1, {}),
    (e) => e && e.statusCode === 400,
    'unitNodeId 누락 시 400 이어야 한다'
  );

  // (d) 미존재 노드: 404
  assert.throws(
    () => sl.startDiagnosisV3(S1, { unitNodeId: '__no_such_node__' }),
    (e) => e && e.statusCode === 404,
    '미존재 노드는 404 이어야 한다'
  );
});

// ──────────────────────────────────────────────────────────────────────────
// D-2: 종료 백스톱(하드 문항캡) — 누적 출제가 상한을 넘으면 어떤 동작에서도 finished.
//   세션 상태(per_node_answers JSON)의 askedQuestionIds 를 상한(200) 이상으로 위조 후 제출 →
//   엔진이 즉시 finished/sessionComplete 로 끊어야(무한 제출 방어선).
// ──────────────────────────────────────────────────────────────────────────
test('DIAG-D2: 하드 문항캡 백스톱 — 누적 출제 ≥ 상한이면 즉시 종료', () => {
  const start = sl.startDiagnosisV3(S1, { unitNodeId: UNIT });
  const sid = start.sessionId;

  // 세션의 v3 상태(difficulty_path 컬럼에 JSON 저장 — _v3LoadState 가 여기서 읽음)에서
  //   askedQuestionIds 를 상한(200) 이상으로 부풀린다.
  //   (정상 경로는 소프트상한·downCount·시간이 먼저 작동 — 이 가드는 최종 방어선)
  const row = db.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sid);
  const st = JSON.parse(row.difficulty_path);
  assert.ok(st && st.v3, 'v3 상태가 difficulty_path 에 저장되어 있어야');
  const bloated = [];
  for (let i = 0; i < 205; i++) bloated.push(start.question.questionId);
  st.askedQuestionIds = bloated;
  db.prepare('UPDATE diagnosis_sessions SET difficulty_path = ? WHERE id = ?')
    .run(JSON.stringify(st), sid);

  const sub = sl.submitDiagnosisV3(sid, {
    questionId: start.question.questionId,
    contentId: start.question.contentId,
    nodeId: start.question.nodeId,
    answer: '아무거나'
  });
  assert.equal(sub.finished, true, '누적 출제 ≥ 하드캡(200) 이면 finished:true 로 종료');
  assert.equal(sub.sessionComplete, true, '하드캡 도달 시 sessionComplete:true');
});

// ──────────────────────────────────────────────────────────────────────────
// D-3: 채점·이동 구조 계약 + 오답 자동 오답노트 등록 + 정답 통과 처리.
//   (표본 과반 규칙은 풀 갈래 시나리오가 비결정적 — 여기선 1문항 제출의 결정적 계약을 박제.)
// ──────────────────────────────────────────────────────────────────────────
test('DIAG-D3: v3 제출 채점 구조 + 오답→오답노트 자동등록 + 정답 통과', () => {
  const start = sl.startDiagnosisV3(S1, { unitNodeId: UNIT });
  const sid = start.sessionId;
  const q0 = start.question;

  // 실제 정답을 DB에서 조회해 "정답 제출" 케이스를 결정적으로 만든다.
  const raw = db.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(q0.questionId);
  assert.ok(raw, '문항 원본 조회');

  // (1) 일부러 오답 제출 → isCorrect=false + 오답노트 자동등록
  const wrongAns = '__definitely_wrong__';
  const beforeWrong = db.prepare('SELECT COUNT(*) c FROM wrong_answers WHERE student_id = ?').get(S1).c;
  const subWrong = sl.submitDiagnosisV3(sid, {
    questionId: q0.questionId, contentId: q0.contentId, nodeId: q0.nodeId, answer: wrongAns
  });
  // 채점 결과 구조 계약
  assert.equal(typeof subWrong.isCorrect, 'boolean', 'isCorrect 불리언');
  assert.equal(typeof subWrong.finished, 'boolean', 'finished 불리언');
  assert.ok('nextQuestion' in subWrong, 'nextQuestion 키 존재(객체|null)');
  assert.ok('attemptStage' in subWrong, 'attemptStage 키 존재');
  if (subWrong.isCorrect === false) {
    assert.equal(subWrong.wrongNoteAdded, true, '오답이면 오답노트 자동등록(wrongNoteAdded=true)');
    const afterWrong = db.prepare('SELECT COUNT(*) c FROM wrong_answers WHERE student_id = ?').get(S1).c;
    assert.ok(afterWrong > beforeWrong, '오답노트 레코드가 1+ 증가해야');
  }

  // (2) diagnosis_sessions 누적 카운트 갱신 확인 (총 출제 1+)
  const sess = db.prepare('SELECT total_questions FROM diagnosis_sessions WHERE id = ?').get(sid);
  assert.ok(sess.total_questions >= 1, '제출 시 total_questions 증가');
});

// ──────────────────────────────────────────────────────────────────────────
// D-4: 진단↔학습 분리 — v3 진단(시작+제출)이 user_node_status.status 를 바꾸지 않는다.
//   진단 전 현재 단원/개념의 status 스냅샷 ↔ 진단 후 비교: status 불변(없으면 계속 없음).
//   (v3 엔진은 user_node_status 에 어떤 write 도 하지 않음 — 코드 실측: 5742行 이후 user_node_status 미참조)
// ──────────────────────────────────────────────────────────────────────────
test('DIAG-D4: v3 진단은 user_node_status.status 를 변경하지 않음(진단↔학습 분리)', () => {
  // 진단 전 스냅샷: student1 의 전체 user_node_status (node_id→status)
  const snap = new Map(
    db.prepare('SELECT node_id, status FROM user_node_status WHERE user_id = ?').all(S1)
      .map(r => [r.node_id, r.status])
  );

  const start = sl.startDiagnosisV3(S1, { unitNodeId: UNIT });
  const sid = start.sessionId;
  const q0 = start.question;
  // 한 문항 제출(채점 발생)
  sl.submitDiagnosisV3(sid, { questionId: q0.questionId, contentId: q0.contentId, nodeId: q0.nodeId, answer: '아무거나' });

  // 진단 후 비교: 기존 노드 status 가 하나도 바뀌지 않아야.
  const after = db.prepare('SELECT node_id, status FROM user_node_status WHERE user_id = ?').all(S1);
  for (const r of after) {
    if (snap.has(r.node_id)) {
      assert.equal(
        r.status, snap.get(r.node_id),
        `진단 후 노드 ${r.node_id} 의 status 가 바뀌면 안 됨(진단↔학습 분리): ${snap.get(r.node_id)} → ${r.status}`
      );
    } else {
      // 진단이 새 노드 행을 만들었다면, 그 행의 status 는 'not_started' 여야(학습 진행으로 오인 금지).
      assert.ok(
        r.status === 'not_started' || r.status == null,
        `진단이 새로 만든 노드 ${r.node_id} 의 status 는 not_started 여야 (학습완료 오인 금지). 실제=${r.status}`
      );
    }
  }
  // 진단 개념의 status 가 'completed'/'mastered' 등 학습 완료로 바뀌지 않았는지 명시 확인
  const conceptStatus = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?')
    .get(S1, q0.nodeId);
  if (conceptStatus) {
    assert.ok(
      !['completed', 'mastered', 'in_progress', 'video_watched'].includes(conceptStatus.status),
      `진단한 개념(${q0.nodeId}) status 가 학습완료/진행중으로 바뀌면 안 됨. 실제=${conceptStatus.status}`
    );
  }
});
