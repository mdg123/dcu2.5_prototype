# Dev Backend Rework #2 — 진단 결정사항 정합화

- 일시: 2026-04-28
- 담당: Backend (opus)
- 브랜치: feat/curriculum-std-aidt
- 근거 보고서: `docs/audit-self-learn/qa-audit-report.md` REW-002, REW-004, REW-005

## 1. 작업 범위

| 결정사항 | 요구 | 이전 구현 | 본 작업 |
|---------|------|-----------|--------|
| D1 | 노드당 2문항 | 3~5문항 | **2문항 고정** |
| D2 | 통과 = 2/2 정답 | rate ≥ 0.6 | **correct === 2** |
| D3 | 종료 = 연속 2회 정답 OR 최대 3단계 | 큐 소진까지 | **consecutive_pass / max_steps / queue_empty** |
| D4 | 실패 시 학습목록 자동 추가 | 미구현 | **세션 완료 시 미통과 노드 INSERT OR IGNORE** |
| D5 | 선수 = DB prerequisites | learning_map_edges BFS | 유지 |
| D6 | 문항 = EBS/자동 2개 중 무작위 | ORDER BY RANDOM() LIMIT 1 | 유지 |
| 추가 | questionId 필수, Math.random fallback 제거 | line 721 random | **400 에러 반환** |
| 추가 | correct_rate 단위 통일 (0~1) | 0~1 / 0~100 혼재 | **0~1 통일** |

## 2. 변경 파일 / 라인

### `db/self-learn-extended.js`

- **line 533** `correctRate`: `Math.round((correct/total)*100)` → `(correct/total)` (0~1 단위)
- **line 715-727** `submitDiagnosisAnswer`: questionId 누락 시 `Math.random() > 0.3` fallback 제거 → `err.statusCode=400` throw
- **line 1497-1511** `recordProblemAttempt`의 `user_node_status.correct_rate` 업데이트: `Math.round((c/t)*100)` → `(c/t)` (0~1 단위)
- **line 1730~1900** `submitDiagnosisAnswerCAT` 전면 재작성:
  - 상수 `NODE_QUESTIONS=2`, `MAX_NODE_STEPS=3`, `CONSEC_PASS_TARGET=2`
  - questionId 필수화 + DB 정답 비교 (clientIsCorrect fallback 제거)
  - 난이도 적응형(easy/medium/hard) 제거 — `nextDifficulty: 'medium'` 고정
  - `nodeHist.length >= 2` 시 `nodeFinished=true`, `nodePassed = (correct === 2)`
  - `difficulty_path` 컬럼은 노드 진행 경로(node-level) 누적용으로 의미 변경 (`{node, passed, correct, total}`)
  - 세션 종료조건: `consecutive_pass`(마지막 2단계 모두 통과) / `max_steps`(3단계 누적) / `queue_empty` / `no_question`
  - 세션 완료 시 미통과 노드 → `INSERT OR IGNORE INTO user_learning_list`
  - `correctRate` 응답에 0~1 비율로 통일

### `routes/self-learn.js`

- **line 519-528** `/diagnosis/:sessionId/answer` 에러 핸들러: `err.statusCode` 활용해 400/500 분기

### `public/self-learn/learning-map.html`

- **line 3010-3015** 정답률 표시: 백엔드 0~1 단위 가정 + 레거시 0~100 호환 (`rawRate <= 1 ? *100 : raw`)
- **line 4300-4313** 진단 답변 페이로드: `questionId, nodeId, answer` 명시 전송
- **line 4314-4334** 서버 `isCorrect` 우선 + `nodeResults` 활용 + 다음 노드 자동 갱신
- **line 4326-4329** 통과 기준: `correct >= total*0.6` → `correct === total` (D2)
- **line 4319** 응답 호환: `nextQuestion` (camelCase) 추가

## 3. 검증 결과 (E2E, 학생 student1)

서버 재시작 후 `localhost:3000` 직접 fetch 테스트.

### 시나리오 A: 모든 정답 → 연속 2회 정답 종료

```
SID=34, target=E2MATA01B01C02D01 (queue 2개)
Q1 정답 → nodeFinished:false (1/2)
Q2 정답 → nodeFinished:true, nodePassed:true (2/2), 다음 노드로 이동
Q3 정답 → nodeFinished:false (1/2)
Q4 정답 → finished:true, endReason:"consecutive_pass"
nodeResults[0]: correctRate=1, passed=true (2/2)
nodeResults[1]: correctRate=1, passed=true (2/2)
addedToLearningList: []  ← 모두 통과이므로 빈 배열
```

### 시나리오 B: 모든 오답 + 큐 2개 → queue_empty + 학습목록 추가

```
SID=35, target=E2MATA01B01C02D01
iter1 오답 → nodeFinished:false
iter2 오답 → nodeFinished:true, nodePassed:false (0/2)
iter3 오답 → nodeFinished:false
iter4 오답 → finished:true, endReason:"queue_empty"
addedToLearningList: ["E2MATA01B01C02D01", "E2MATA01B01C01D01"]
```

### 시나리오 C: 모든 오답 + 큐 13개 → max_steps 종료

```
SID=36, target=E6MATA01B01C01D01 (queue 13개)
iter1~iter6 모두 오답 (3개 노드 처리)
iter6: finished:true, endReason:"max_steps", queueRemaining:8
```
큐가 8개 남아있어도 3단계 도달 시 종료 — D3 충족.

### 시나리오 D: questionId 누락 → 400

```
POST /diagnosis/37/answer  body: {contentId:1, answer:"1"}
HTTP 400
{"success":false, "message":"필수 파라미터가 누락되었습니다.", "detail":"questionId is required"}
```

### DB 단위 검증

세션 35/36 완료 후:
- `user_node_status.correct_rate` = 0.0 (오답 노드, 0~1)
- `user_node_status.correct_rate` = 1.0 (정답 노드)
- 0~100 정수 혼재 없음 (`recordProblemAttempt` 경로도 동일 단위)

## 4. 호환성 / 위험

- **`difficulty_path` 컬럼** 의미 변경 (난이도 path → 노드 진행 path). 기존 세션 데이터(JSON)와 신규 데이터의 스키마가 다름. 진행 중 세션은 새로 시작 권고. 완료된 세션은 통계 영향 없음.
- **레거시 `current_difficulty` 컬럼** 항상 'medium' 저장 — 기존 컬럼 보존.
- **프런트 학생 0~100 정수 데이터(과거 user_node_status 일부)** UI에서 `rawRate <= 1` 분기로 호환 처리.
- **`submitDiagnosisAnswer` (CAT 아닌 표준 경로)**: questionId 필수화로 인해 questionId 미전송 클라이언트는 400 받음. 표준 진단 경로는 사용처가 거의 없으므로 영향 미미하나, 호출 추적 권장.

## 5. 미수행 / 후속 권고

- **REW-001** 대시보드 `total_time_minutes`/`rank` 추가는 이미 `getLearningDashboard` (line 1091-1136)에 반영되어 있음. 본 작업에서는 미변경.
- **REW-003** 콘텐츠 품질 — 본 작업 범위 외 (PM/콘텐츠팀 트랙).
- **REW-008** 교사 라우트 `requireRole('teacher')` 미들웨어 — 별도 PR 권고.
- **REW-010** `contents.source` 컬럼(EBS/자동 구분) — 마이그레이션 필요, 별도 작업.

## 6. Sync

- 워크트리 → 메인 폴더 직접 cp 완료:
  - `db/self-learn-extended.js`
  - `routes/self-learn.js`
  - `public/self-learn/learning-map.html`

---
*본 보고서는 결정사항 정합화 작업의 변경/검증 근거를 기록합니다.*
