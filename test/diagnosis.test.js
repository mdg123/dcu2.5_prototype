// test/diagnosis.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 D] 진단검사 v3 회귀 (이번 세션 다수 수정 — db/self-learn-extended.js v3 엔진).
//   핵심 박제:
//     D-1 단원 단위 진단: startDiagnosisV3 는 node_level=2(단원)만 수용. 차시(level3) 거부.
//     D-2 [2026-08-07 제거] 하드 문항캡(200) 백스톱 — 종료 조건 신설로 불필요해져 삭제.
//         유한성은 self-learn-diag-v3-termination.test.js 의 INV-DV3-9·9b 가 지킨다.
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
// D-2: [2026-08-07 제거됨 — 아래 주석 참조]
//   (구) 종료 백스톱(하드 문항캡) — 누적 출제가 상한을 넘으면 어떤 동작에서도 finished.
//   세션 상태(per_node_answers JSON)의 askedQuestionIds 를 상한(200) 이상으로 위조 후 제출 →
//   엔진이 즉시 finished/sessionComplete 로 끊어야(무한 제출 방어선).
// ──────────────────────────────────────────────────────────────────────────
// [2026-08-07 제거] DIAG-D2 하드 문항캡(200) 백스톱 — 사용자 확정 "상한 필요없어".
//
//   그 상한은 **진단이 끝나지 않던 시절의 응급 처치**였다. 당시 v3 엔진에는
//   "출발선을 찾았으면 종료" 조건이 아예 없어 무한 제출을 끊을 방법이 숫자뿐이었다.
//   옛 주석은 "정상 경로는 소프트상한·downCount·시간이 먼저 작동한다" 고 했으나
//   **그 셋이 전부 꺼져 있었다**(개념 30 상한은 빈 if 문, 12분 소프트스톱은 v3 미연결).
//
//   2026-08-07 종료 조건을 신설하면서 상한을 제거했다. 유한성은 이제 구조가 보장한다 —
//   visitedConcepts 단조 증가 + branchVerdicts 재진입 차단으로 같은 노드를 다시 방문할 수
//   없고, 노드 그래프가 유한하며, DIAG_V3_DOWN_CONCEPT_CAP(20)이 남아 있다.
//
//   ⚠ 이 테스트를 되살리지 말 것. 대신 **"반드시 끝나는가"** 를 검사하는
//     `test/self-learn-diag-v3-termination.test.js` 의 INV-DV3-9 · 9b 가 그 역할을 한다.
//     숫자 상한이 없으므로 무한 루프가 생기면 그쪽 안전망(maxSteps)에 걸려 붉어진다.

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
