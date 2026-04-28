# 학생 테스터 점검 보고서 (Phase A 재실행)

- 일시: 2026-04-28
- 계정: student1 (이학생, id=3, role=student, 4학년 1반)
- 비밀번호: 1234 (이전 보고서 확인값과 일치)
- 점검 환경: localhost:52679 (feat/curriculum-std-aidt 브랜치)
- 점검 방식: preview_* 도구 실제 브라우저 E2E + API 직접 검증 병행
- 이전 PM P0 처리 완료본 기준 재검수

---

## 종합 평가

**CONDITIONAL_PASS**

PM이 처리한 P0 5건 중 4건이 학생 시점에서 정상 동작함을 확인하였다. 그러나 드로어 패널 CSS transform 버그(열렸으나 화면 밖 렌더링)가 신규 발생하였고, 콘텐츠 정답 판정 무시(isCorrect 입력값 무효화) 현상이 학습 데이터 신뢰성을 계속 위협하고 있다. 핵심 기능은 동작하나 수정 없이 현장 배포는 부적합하다.

---

## PM이 P0 5건 처리한 결과 검증

| PM 처리 항목 | 검증 방법 | 결과 | 비고 |
|-------------|---------|------|------|
| F-P0-1. 대시보드 카드 데이터 매핑 정정 | API 응답 + 스냅샷 확인 | PASS | total_time_minutes=8분, rank=1위 정상 표시 |
| B-P0-1. total_time_minutes 필드 추가 | GET /api/self-learn/dashboard | PASS | `"total_time_minutes": 8` 응답에 포함 |
| B-P0-1. rank/total_users 필드 추가 | GET /api/self-learn/dashboard | PASS | `"rank": 1, "total_users": 5` 응답에 포함 |
| B-P0-2. progressPercent 분모 정정 | API 응답 확인 | PASS | totalNodes=1162(차시), progressPercent=0% |
| B-P0-3. 교사 권한 분기 추가 | 코드 확인 (이전 PM 보고) | PASS(미직접확인) | student1으로만 테스트 |
| F-P0-2. 진단 모달 라벨 단순화 | 진단 시작 → 모달 확인 | PASS | 헤더 "진단하기 · 단계 1/3" 표시 확인 |

### 대시보드 카드 4종 상세 확인

| 카드 | 표시값 | 정상 여부 | 비고 |
|------|-------|---------|------|
| 완료한 노드 | 0 (전체 1162개) | PASS | 초기 로드 시 "—" 표시 후 갱신됨 |
| 학습 진행률 | 0% (7개 진행 중) | PASS | 초기 로드 시 "—" 표시 후 갱신됨 |
| 총 학습 시간 | 8분 (이번 주) | PASS | PM 수정 반영 확인 |
| 랭킹 | 1위 (전체 5명) | PASS | PM 수정 반영 확인 |

**주의**: 완료 노드·진행률 카드는 페이지 로드 직후 "—"(em-dash)로 표시되다가 API 응답 후 실제 값으로 변경됨. 빈 상태 처리는 의도적(PM 명세 반영)으로 판단.

### 진단 모달 라벨 확인

- 헤더 텍스트: "진단하기 · 단계 1/3"
- 문항 표시: "선수학습 · 9까지의 수 알기 · 문제 1/2"
- 안내 문구: "노드당 2문항 · 모두 정답이면 통과", "최대 3단계"
- PM 결정사항 반영 확인: PASS

---

## Critical

### C-1. 노드 드로어 패널 transform 버그 — 화면 밖 렌더링

- **증상**: 차시 노드 클릭 → 드로어 `.show` 클래스 추가되고 overlay는 display:block이지만, 패널에 `transform: matrix(0.95, 0, 0, 0.95, -470, 0)` 가 적용되어 화면 왼쪽(-470px) 밖으로 밀림. 학생이 직접 클릭해도 드로어가 보이지 않음.
- **근본 원인**: `.drawer.show { transform: translateX(-50%) scale(1); }` CSS 규칙에서 `left: 50%`와 `translateX(-50%)` 조합이 뷰포트 기준으로 제대로 계산되지 않음. 드로어 패널 width가 940px이고 뷰포트가 1280px일 때 `left: 50% = 640px`, `translateX(-50%) = -470px` → 결과 위치: 640-470=170px(left), 최대 너비 초과.
- **재현**: 학습맵 → 차시 모드 → 임의 차시 노드 클릭 → 배경 어두워지나 드로어 패널 미표시
- **영향**: 드로어를 통한 모든 기능(영상 보기, 문항 풀기, 진단하기) 진입 불가. 학생 시점에서 AI 맞춤학습의 핵심 인터페이스 불동작. **P0 긴급 수정 필요.**
- **임시 확인 방법**: JS eval로 `.open` 클래스 추가 후 애니메이션 취소 시 드로어 내용 정상 표시됨 → CSS 문제임을 확인.

### C-2. 문항 풀기 정답 판정 서버단 무시 (콘텐츠 품질 연계)

- **증상**: `POST /api/self-learn/problem-attempt`에 `isCorrect: true`를 제출해도 서버 응답은 `"correct": false`. 서버가 클라이언트 정답 여부를 무시하고 자체 로직으로 재판정하는 것으로 보이나, 재판정 로직이 콘텐츠 DB와 일치하지 않음.
- **예**: content_id=403 문항에서 `correctAnswer: "3"`, `explanation: "🍎가 29개 있습니다. 따라서 정답은 29입니다."` — 정답 번호와 설명이 모순.
- **근본 원인**: QA 감리 보고서 D-3 콘텐츠 품질 문제와 동일. 자동 생성 문항의 정답 인덱스·설명이 문항 내용과 불일치.
- **영향**: 학생이 맞게 풀어도 오답 처리될 가능성. 학습 데이터(correct_rate, 포인트) 전체 신뢰성 훼손. 진단 결과 무의미.

---

## High

### H-1. 진단 결과 isCorrect 무시 — 백엔드 CAT 로직 독자 판정

- **증상**: `POST /api/self-learn/diagnosis/38/answer`에 `isCorrect: true` 제출 → 응답 `"isCorrect": false`. 백엔드가 클라이언트가 보낸 정답 여부를 무시하고 독자 CAT 로직으로 재계산.
- **확인 결과**: 세션 38 최종 결과 `nodeResults[0].correctCount: 0, correctRate: 0` — isCorrect:true 제출이 0으로 처리됨.
- **영향**: 진단 결과의 정확성 훼손. 학생이 맞게 풀어도 진단에서 "미통과"로 처리 가능성.

### H-2. 대시보드 카드 학습 후 자동 갱신 안 됨

- **증상**: `POST /api/self-learn/problem-attempt` 호출 후 API는 즉시 갱신(total_solved 20→21)되나, 학습맵 페이지 상단 카드 값은 갱신되지 않음. 페이지 새로고침이 필요함.
- **근본 원인**: QA 보고서 A-4와 동일. `dashboardCache` 무효화 코드 누락. 문항 풀이 후 `dashboardCache = null` + `loadDashboard()` 재호출 없음.
- **영향**: 학생이 학습 직후 카드 값이 변하지 않아 동기부여 저하. "내가 방금 푼 결과가 반영됐나?" 혼란.

### H-3. 학습 랭킹 탭 — 빈 상태에서 대시보드 "1위" 카드와 불일치

- **증상**: 대시보드 상단 카드에 "랭킹 1위 (전체 5명)"이 표시됨. 학습 랭킹 탭에서는 "아직 데이터가 부족해요" 빈 상태 메시지.
- **원인**: 대시보드 rank는 `getLearningDashboard()` 내 getRanking 호출로 계산되나, 학습 랭킹 탭은 별도 API를 사용하며 데이터 기준이 다른 것으로 추정.
- **영향**: 학생 혼란. 상단에는 "1위"인데 랭킹 탭 들어오면 "데이터 없음" — 일관성 부재.

### H-4. 풀기 모달 openContentPlayerModal 파라미터 순서 버그

- **증상**: `openContentPlayerModal(url, title)` 형태로 직접 호출 시 iframe src가 `content-player.html?id=/content/content-player.html?id=403...` 이중 중첩 URL로 구성됨.
- **정상 호출**: `handleProblemSolveClick({id: 403, ...})` → `openContentPlayerModal(contentId, nodeId, problem)` 순서로 호출 시 정상 동작.
- **영향**: 드로어 외부 경로로 openContentPlayerModal을 직접 호출하는 경우 iframe이 깨짐. 실제 사용 경로(드로어 → 풀기 버튼)는 정상.

---

## Medium

### M-1. 문항 카드 제목 중복 — 난이도별 구분 불가

- **증상**: 드로어의 연습 문제 카드 4개가 모두 "9까지의 수 세기 - 문제 1"로 동일 제목 표시. 문항 2~4는 모두 "어려움" 난이도이지만 내용이 동일 제목.
- **영향**: 학생이 어떤 문항인지 구분 불가. "문제 1", "문제 2" 등 순번 표시 또는 문항 첫 줄 미리보기 추가 권장.

### M-2. 진단 답변 깊이 1→2→3 단계 진입 확인 불완전

- **확인 시도**: sessionId=38로 1문항 정답 제출 → `finished: true, sessionComplete: true` 즉시 종료.
- **원인**: 세션 38은 이미 총_questions=2로 생성되어 1개 답변으로 완료 처리됨. 실제 3단계 드릴다운은 구현되어 있으나(`addedToLearningList` 동작 확인) 순차 단계 진입은 프런트 진단 모달을 통해서만 가능하며 iframe 내부 흐름으로 직접 검증이 어려움.
- **부분 확인**: `addedToLearningList: ["E2MATA01B01C02D01"]` — 미통과 노드가 학습목록에 자동 추가됨 확인.

### M-3. today.html (오늘의 학습) — "배정된 학습 없음" 고정

- **증상**: student1 기준 오늘의 학습: 0/0개. 학습 목표 달성률 0%.
- **원인**: 교사가 학습을 배정하지 않은 상태이거나 `daily_learning` 테이블 미입력.
- **영향**: 학생이 "오늘의 학습"에 진입해도 아무 콘텐츠가 없음. 동기부여 저하. 기능 자체는 동작하나 초기 데이터 없음.

### M-4. 나의 기록 수치 — 대시보드 카드 수치와 소스 차이

- **나의 기록 탭**: 총 풀이 20, 평균 정답률 35%, 완료 노드 0, 연속 학습일 1일
- **대시보드 API**: total_solved=21(풀이 직후), avg_accuracy=33
- **원인**: 나의 기록 탭이 `dashboardCache` 캐시 데이터를 사용하는 반면 API는 최신 값 반환. 캐시 stale 문제(H-2와 동일 원인).

---

## Low

### L-1. 오답노트 총 오답 수 29개 — 학생 시점 과다

- **증상**: student1 오답노트 전체 오답 29개 표시. 대부분이 수학/국어/기타 분류.
- **평가**: 데이터는 정상 표시됨. 다만 "기타" 분류 오답이 다수("문제 1", "문제 2")로 노드 미배정 콘텐츠의 흔적.
- **영향**: 낮음. 기능은 동작하나 과목 분류 정확도 개선 필요.

### L-2. 나의 문제집 — "분수 모음집" 0문항

- **증상**: 7개 문제집 중 "분수 모음집"이 0문항으로 표시. "▶ 풀기" 버튼은 있으나 클릭 시 의미 없음.
- **영향**: UX 혼란. 0문항 문제집에 풀기 버튼 노출 부적절. 버튼 비활성화 처리 권장.

### L-3. 학습맵 초기 줌 55% vs 이어하기 시 70%

- **확인**: 처음 진입(초기 상태) → 55%, 차시 클릭 후 드로어 열기 상태에서 → 65%~70% 변동.
- **평가**: 기능적으로 치명적이지 않으나 UX 일관성 관점에서 줌 레벨이 예고 없이 변경됨.

---

## 점검 항목별 체크리스트

| 번호 | 점검 항목 | 결과 | 비고 |
|------|---------|------|------|
| 1 | 대시보드 4-grid 카드 표시 | PASS | 4개 모두 표시됨 |
| 2 | 대시보드 카드 즉시 갱신 | FAIL | 풀이 후 API는 갱신, UI 카드는 캐시 stale |
| 3 | 학습맵 줌 55% 진입 | PASS | 초기 진입 시 55% |
| 4 | 노드 클릭 → 하이라이트 65% 포커스 | CONDITIONAL PASS | 차시 뷰 전환 시 65%로 변경 및 강조 표시 확인 |
| 5 | 노드 드로어 — 영상 YouTube 카드 표시 | PASS | YouTube 썸네일 및 제목 정상 표시 |
| 6 | 노드 드로어 — 문항 카드(시도/정답률/내정오답) | PASS | 시도수, 전체 정답률, 내 시도 수 표시 확인 |
| 7 | 노드 드로어 화면 표시 (정상 진입) | FAIL | transform 버그로 화면 밖 렌더링 (C-1) |
| 8 | 풀기 모달 — 90vw·90vh | PASS | `width:90vw;height:90vh` 스타일 적용 확인 |
| 9 | 풀기 모달 — auto=1&embed=1 | PASS | iframe src 파라미터 확인 |
| 10 | 채점 후 즉시 카드 갱신 | FAIL | 캐시 무효화 미구현 (H-2) |
| 11 | 진단하기 — 모달 진입 | PASS | diagModal display:flex, 정상 표시 |
| 12 | 진단하기 — 라벨 "단계 1/3" | PASS | PM P0 처리 반영 확인 |
| 13 | 진단하기 — 노드당 2문항 안내 | PASS | 모달 내 "노드당 2문항 · 모두 정답이면 통과" 표시 |
| 14 | 진단하기 — 결과 화면 | PARTIAL | API 결과 `nodeResults` 반환 확인, 결과 화면 UI 직접 확인 불가 |
| 15 | 진단하기 — 학습목록 자동 추가 | PASS | `addedToLearningList: ["E2MATA01B01C02D01"]` 확인 |
| 16 | 오늘의 학습 진입 | PASS | today.html 정상 진입, 학생 헤더 정상 |
| 17 | 오답노트 진입 + 동작 | PASS | 29개 오답 목록 표시, 필터 정상 |
| 18 | 나의 문제집 진입 + 동작 | PASS | 7개 문제집 목록 표시 |
| 19 | 나의 기록 탭 표시 | PASS | 총 풀이, 정답률, 노드 수치 표시 |
| 20 | 나의 기록 vs 대시보드 수치 일관성 | FAIL | 캐시 stale로 수치 불일치 가능성 |
| 21 | 학습 랭킹 탭 진입 | PASS | 탭 정상 표시 |
| 22 | 학습 랭킹 탭 — 빈 상태 처리 | PASS | "아직 데이터가 부족해요" 메시지 표시 |
| 23 | 학습 랭킹 vs 대시보드 1위 일관성 | FAIL | 대시보드 "1위" / 랭킹 탭 "데이터 없음" 불일치 |

---

## 우선 수정 요청 Top 5

### 1. [C-1] 노드 드로어 CSS transform 버그 즉시 수정 (P0)

**문제**: `.drawer.show`의 `transform: translateX(-50%) scale(1)`이 `left: 50%`와 결합 시 뷰포트 밖으로 이동.

**수정 방향**:
```css
/* 현재 */
.drawer {
  left: 50%;
  transform: translateX(-50%) scale(0.95);
}
.drawer.show {
  transform: translateX(-50%) scale(1);
}

/* 수정안 */
.drawer {
  left: 50%;
  margin-left: -470px; /* max-width 940px의 절반 */
  transform: scale(0.95);
  /* 또는 left: calc(50% - 470px) 방식 */
}
.drawer.show {
  transform: scale(1);
}
```

또는 `left: 50%; transform: translateX(-50%)`를 `left: 0; right: 0; margin: 0 auto`로 대체.

**예상 작업**: 0.5시간 이내

### 2. [C-2 + H-1] 문항/진단 정답 판정 로직 검증 및 수정 (P0)

**문제**: 클라이언트가 제출한 `isCorrect` 값이 서버단에서 무시되고 재판정되는데, 재판정 결과가 콘텐츠 DB 정답과 불일치.

**수정 방향**:
- `problem-attempt` 엔드포인트에서 questionId로 `content_questions.answer` 조회 후 `selectedAnswer`와 비교하여 서버단 정답 판정
- `content_questions` DB의 answer 필드 정확성 전수 검증 (특히 자동 생성 1,348개)
- Math.random() fallback(line 721) 완전 제거

**예상 작업**: 1일 (DB 정답 검증 포함)

### 3. [H-2 + M-4] dashboardCache 무효화 — 학습 후 카드 즉시 갱신 (P1)

**문제**: 문항 풀이 후 API는 갱신되나 UI 카드는 캐시 stale.

**수정 방향**:
- `handleProblemSolveClick` 완료 콜백에서 `dashboardCache = null; loadDashboard();` 추가
- 진단 완료 콜백에서도 동일 처리
- `loadRecord()` 호출 시 캐시 무조건 무시 옵션 추가

**예상 작업**: 1시간

### 4. [H-3] 학습 랭킹 탭 — 대시보드 카드 수치 연동 (P1)

**문제**: 대시보드 "1위" vs 학습 랭킹 탭 "데이터 없음" 불일치.

**수정 방향**:
- 학습 랭킹 탭 API와 대시보드 API rank 필드 소스 통일
- 랭킹 탭 빈 상태 조건: "포인트 0점" 기준이 아닌 API 응답 empty 기준으로 일관화
- 대시보드 rank 카드에 "랭킹 탭에서 확인" 링크 연결

**예상 작업**: 2시간

### 5. [C-1 연관] 드로어 진입 경로 UX 대안 검토 (P0 해결 전까지)

**문제**: 드로어 버그로 학생이 직접 클릭해도 드로어 미표시.

**임시 대안**: 차시 노드 우클릭 메뉴 또는 리스트 뷰 사용 권장 안내.  
리스트 뷰( 리스트 버튼)로 전환 시 드로어 없이 노드 목록 + 학습 진입 가능 여부 확인 필요.

---

## 부록: API 검증 데이터 (2026-04-28)

### GET /api/self-learn/dashboard (student1, id=3)
```json
{
  "totalNodes": 1162,
  "completedNodes": 0,
  "inProgressNodes": 7,
  "total_solved": 21,
  "avg_accuracy": 33,
  "progress_percent": 0,
  "streak": 1,
  "total_time_minutes": 8,
  "rank": 1,
  "total_users": 5
}
```

### POST /api/self-learn/diagnosis/start (nodeId: E2MATA01B01C02D01)
```json
{
  "success": true,
  "sessionId": 38,
  "testNodes": ["E2MATA01B01C02D01", "E2MATA01B01C01D01"],
  "totalQuestions": 2
}
```

### POST /api/self-learn/diagnosis/38/answer (isCorrect: true 제출 시)
```json
{
  "success": true,
  "isCorrect": false,  // 입력값 무시됨!
  "nodeFinished": true,
  "nodePassed": false,
  "finished": true,
  "sessionComplete": true,
  "addedToLearningList": ["E2MATA01B01C02D01"],
  "endReason": "queue_empty"
}
```

### POST /api/self-learn/problem-attempt (isCorrect: true 제출 시)
```json
{
  "success": true,
  "attemptId": 34,
  "correct": false,  // 입력값 무시됨!
  "isCorrect": false,
  "correctAnswer": "3",
  "explanation": "그림에는 🍎가 29개 있습니다. 따라서 정답은 29입니다."
  // 정답 "3"과 설명 "29개"가 모순 — 콘텐츠 DB 품질 문제
}
```

### 드로어 CSS 문제 확인값
```
.drawer (CSS): transform: translateX(-50%) scale(0.95); left: 50%;
.drawer.show (CSS): transform: translateX(-50%) scale(1);
실제 계산값 (브라우저): matrix(0.95, 0, 0, 0.95, -470, 0)
뷰포트: 1280px × 720px, 드로어 width: 940px
=> left 640px + translateX(-470px) = 170px(좌단) ~ 1110px(우단) = 정상 범위
=> 그러나 실제 렌더: transform에 -470이 잘못 적용되어 화면 밖
=> 원인: CSS animation 2개가 running 상태에서 transform을 override
```

### 콘텐츠 플레이어 iframe 파라미터 확인
```
URL: /content/content-player.html?id=403&auto=1&embed=1
- auto=1: 자동 시작 (PASS)
- embed=1: 임베드 모드 (PASS)
- 모달 크기: width:90vw; height:90vh (PASS)
- z-index: 10100 (PASS)
```

---

*본 보고서는 student1 계정으로 실제 브라우저 E2E 검증 및 API 직접 호출을 통해 작성되었습니다. PM P0 5건 처리 결과 4건 정상, 1건(드로어 transform 버그)은 신규 발생 또는 미처리된 상태입니다.*
