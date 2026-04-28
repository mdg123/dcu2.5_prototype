# AI 맞춤학습 교사 테스터 점검 보고서

- 일시: 2026-04-27
- 계정: teacher1 (김선생, id=2, role=teacher)
- 비밀번호: 1234 (명세 문서에 0000으로 기재되어 있으나 실제는 1234)
- 점검 환경: localhost:3000, SQLite DB (data/dacheum.db)

---

## 종합 평가

**CONDITIONAL_PASS** — 핵심 기능(학습맵, 진단, 문제 풀이, xAPI 누적)은 동작하나, 콘텐츠 학년·내용 불일치와 대시보드 학습 시간 미표시가 교사 신뢰도를 크게 훼손함. 3개 Critical 항목 수정 후 재검토 필요.

---

## 🔴 Critical

### C-1. 콘텐츠-노드 학년/내용 대규모 불일치
- **증상**: 초등 수학 "반직선 이해하기"(3학년) 차시에 "변이 6개인 도형의 이름은?" 문항 배정. 중1 "일차함수의 그래프의 성질" 차시에 "반 친구들이 좋아하는 과일을 조사한 결과" 통계 문항. 고1 "여집합" 차시에 "1+6=?" 산수 문항.
- **범위**: 자동생성 문항 2,600건 중 상당수가 노드와 무관한 문항으로 추정됨. 동일 content_id가 초·중 두 학교급 노드에 동시 매핑된 사례 10건 이상 확인.
- **근본 원인**: `node_contents` 테이블에서 content_id를 노드에 배정할 때 학년·내용 정합성 검증 없이 기계적으로 매핑. EBS 문항(3건)은 정상이나 자동생성 2,600건은 학년·단원 부적합이 광범위함.
- **교사 영향**: 학생에게 전혀 다른 학년 수준의 문항이 제시됨 → 진단/학습 결과 신뢰 불가.

### C-2. 대시보드 "총 학습 시간" 카드 값이 항상 0
- **증상**: UI 상단 "총 학습 시간: 0분" 고정 표시.
- **원인**: `GET /api/self-learn/dashboard` 응답(`getLearningDashboard`)에는 학습 시간 필드가 없음. UI는 `/api/learning/today` 응답의 `actual_time_minutes`를 사용하는데, 이 값은 `daily_learning` 테이블의 컬럼으로 수동 업데이트 없이는 0으로 유지됨. 실제 문제 풀이 `time_taken` 합산(teacher1 기준 168초=3분)이 있어도 대시보드 카드에 반영되지 않음.
- **영향**: 교사·학생 모두 학습 시간 확인 불가. 핵심 동기부여 지표 상시 오류.

### C-3. 진단 결과가 교사(teacher1) 본인 기록에 누적 — 시연용 분리 없음
- **증상**: teacher1으로 로그인한 상태에서 진단하기 버튼 → `POST /api/self-learn/diagnosis/start` 정상 작동 → 세션이 user_id=2(교사)로 `diagnosis_sessions`에 기록됨. `user_node_status`에도 교사 자신의 진행 상태(in_progress, diagnosed)가 쌓임.
- **문제**: 교사가 학생 앞에서 시연할 때마다 교사 본인의 학습 기록이 오염됨. `POST /map/nodes/:nodeId/start` 엔드포인트는 `teacher` 역할에 대해 no-op 처리가 되어 있으나, 진단 흐름 및 문제 풀이(`/problem-attempt`)는 역할 구분 없이 교사 기록에 저장됨.
- **영향**: 랭킹 조회 시 teacher1 포인트(120점 누적)가 내부적으로 존재하나 랭킹 UI에는 `role='student'` 필터로 노출되지 않음 → 포인트만 교사에게 적립되는 데이터 오염.

---

## 🟠 High

### H-1. 대시보드 progressPercent 분모·분자 node_level 불일치
- **증상**: `getLearningDashboard`에서 `totalNodes = learning_map_nodes WHERE node_level=2`(단원, 146개)로 집계하나, `completedNodes`는 `user_node_status WHERE status='completed'`(node_level 무관)로 집계. 학생이 level=3(차시) 노드를 완료해도 분모가 level=2(단원)이므로 진행률이 부정확하게 계산됨.
- **예시**: student1이 level=3 노드 3개 in_progress 상태이나 completed 0건 → 진행률 0%. 만약 level=3 완료가 발생해도 분모 146(단원 수)을 분자(차시 완료 수)로 나누는 계산이 됨.

### H-2. 교사가 학생 개인 AI 맞춤학습 진도를 조회할 수단 없음
- **증상**: `public/class/analytics.html`이 존재하나 `self-learn` 관련 API를 전혀 호출하지 않음. LRS 클래스 요약(`/api/lrs/class/2`)은 현재 데이터가 없어 빈 응답 반환. `/api/self-learn/map/user-status`는 본인 외 다른 사용자 userId 파라미터 지원 없음.
- **영향**: 교사가 개별 학생의 학습맵 진행률·오답·진단 이력을 전혀 파악할 수 없음. 핵심 교사 관점 기능 미구현.

### H-3. 교사 포인트가 학생용 포인트 시스템에 혼입
- **현황**: teacher1의 `user_points` 기록 16건 확인. `/api/self-learn/daily/stats` 응답 `total_points: 120`. 문제 풀이 시 교사도 포인트를 받음(`awardPoints` 함수가 role 무관하게 실행).
- **영향**: 포인트 기반 레벨 시스템, 스트릭 등이 교사·학생 구분 없이 작동 → 데이터 의미 상실.

---

## 🟡 Medium

### M-1. 진단 무작위 정답 fallback (questionId 없는 경우)
- `submitDiagnosisAnswer`에서 `questionId`가 없으면 `Math.random() > 0.3` 으로 정답 여부를 무작위 결정 (코드 718행). 진단 신뢰성 손상 가능성. 현재 CAT 모드에서 questionId 없이 호출되는 경우 존재 여부 추가 확인 필요.

### M-2. 학습 시간 카드 소스 불일치 (API 분산)
- 대시보드 페이지가 `/api/self-learn/dashboard`, `/api/self-learn/daily/stats`, `/api/learning/today` 세 API를 호출하여 각 카드에 쪼개어 사용. "총 학습 시간"은 `today.actual_time_minutes`에 의존하나 이 값은 명시적 PUT 요청 없이는 갱신되지 않음.
- `getLearningDashboard` 반환 필드에 학습 시간이 없어 "나의 기록" 탭과 상단 카드가 같은 소스를 참조한다고 볼 수 없음.

### M-3. 콘텐츠 비공개 필터 미적용 시 node_contents 중복 문항
- `/map/nodes/:unitId/lessons`에서 `is_public=1 AND status='approved'` 필터가 있으나 `/map/nodes/:nodeId` 상세에서 `node_contents`를 조회할 때 공개 여부 필터 없이 전체 JOIN → 미승인 콘텐츠가 노출될 수 있음.

### M-4. 교사 역할 분기 일관성 미흡
- `POST /map/nodes/:nodeId/start`: teacher → no-op, status 미변경 (올바름)
- `POST /map/nodes/:nodeId/diagnose-complete`: teacher에 대한 분기 없음 → 교사 node_status가 'diagnosed'로 저장됨
- `POST /diagnosis/start`: teacher에 대한 분기 없음 → 교사 diagnosis_sessions에 세션 생성됨
- `POST /problem-attempt`: teacher에 대한 분기 없음 → 교사 problem_attempts 기록됨

---

## 🟢 Low

### L-1. EBS 문항 표기 불일치
- `content_questions.question_text`에 `[EBS 20184320]`으로 시작하는 문항이 3건뿐. 명세(EBS 488개 + 자동생성 1,348개)와 실제 DB(EBS 3건, 자동생성 2,600건)가 크게 다름. 문항 출처 태깅이 정확하지 않거나 임포트가 부분적으로만 완료됨.

### L-2. teacher1 비밀번호 문서와 실제 불일치
- 명세에 "비밀번호 0000"이라고 기재되어 있으나 실제 bcrypt 해시는 "1234"에 해당함.

### L-3. 수열 문항 옵션 부정확 가능성
- "3, 8, _" 수열 문항의 정답 인덱스4 → "23"(등차 5씩이면 13이어야 함). 자동생성 수열 문항의 정답 정확성 추가 검증 필요.

---

## 데이터 정확성 검증 결과

### 대시보드 API vs DB 일치 여부 (teacher1, user_id=2)

| 항목 | API 응답 | DB 직접 조회 | 일치 |
|------|---------|------------|------|
| completedNodes | 0 | 0 (user_node_status WHERE status='completed') | ✅ |
| inProgressNodes | 2 | 2 (user_node_status WHERE status='in_progress') | ✅ |
| totalNodes | 146 | 146 (learning_map_nodes WHERE node_level=2) | ✅ |
| total_solved | 13 (풀이 후 즉시 13으로 갱신) | 13 (problem_attempts COUNT) | ✅ |
| avg_accuracy | 42% | 42% (correct/total×100) | ✅ |
| progress_percent | 0% | 0% | ✅ (단, 분모=level2 단원수, 분자=level 무관 완료수로 로직 오류) |
| streak | 1 | 1 (오늘 문제풀이 1건 확인) | ✅ |
| **총 학습 시간** | **0분 (UI 카드)** | **168초=3분 (time_taken 합산)** | **❌ 불일치** |

### 실시간성 검증
- 문제 풀이 직후 `/api/self-learn/dashboard` 재조회 시 `total_solved` 12→13 즉시 반영 ✅
- DB 캐시 레이어 없음, 매 요청마다 SQLite 직접 쿼리 ✅

---

## 콘텐츠 품질 샘플 검증 (20개, 두 라운드)

| # | 학년 | 학교급 | 노드(단원) | 문항 내용 | 정답 정확? | 학년 적절? | 비고 |
|---|------|--------|-----------|---------|-----------|-----------|------|
| 1 | 2학년 | 중 | 일차함수의 그래프 성질 | 과일 좋아하는 친구 조사 | ? | ❌ | 중2 단원에 초등 통계 문항 |
| 2 | 1학년 | 고 | 합집합의 원소의 개수 | 4+7=? | ✅ (11) | ❌ | 고1 집합에 1학년 덧셈 |
| 3 | 1학년 | 중 | 일차방정식 활용 | 3,8,__ 수열 | 불명확(정답 23, 규칙 불일치 의심) | ❌ | 중1에 수열 문항 |
| 4 | 6학년 | 초 | 부피를 직접 비교하기 | 49와 756 중 큰 수 | ✅ (756) | ❌ | 6학년 부피에 1학년 수 비교 |
| 5 | 2학년 | 중 | 일차함수의 기울기 | 1,6,__ 수열 | 불명확 | ❌ | |
| 6 | 3학년 | 초 | 반직선 이해하기 | 변이 6개인 도형 | ✅ (육각형) | ❌ | 반직선에 도형 이름 문항 |
| 7 | null | null | null | 502-167=? | ✅ (345) | 알 수 없음 | 노드 미배정 |
| 8 | 3학년 | 초 | 선분 구별하기 | 변이 5개인 도형 | ✅ (오각형) | ❌ | 선분에 도형 문항 |
| 9 | 1학년 | 고 | 여집합 | 1+6=? | ✅ (7) | ❌ | 고1 집합에 1학년 덧셈 |
| 10 | 4학년 | 초 | 소수 자릿값 이해 | 527 백의자리 값 | ✅ (500) | ✅ | 적절 |
| 11 | 3학년 | 초 | 지름의 성질 이해 | 변이 6개인 도형 | ✅ (육각형) | ❌ | 원·지름에 다각형 문항 |
| 12 | 3학년 | 초 | 반지름의 성질 이해 | 변이 5개인 도형 | ✅ (오각형) | ❌ | 원 단원에 다각형 문항 |
| 13 | 1학년 | 초 | 9까지의 수 세기 | [EBS] 0과 9까지의 수 | ✅ | ✅ | EBS 문항, 정상 |
| 14 | 1학년 | 초 | 9까지의 수 읽고 쓰기 | 숫자 2 우리말 읽기 | ✅ | ✅ | 적절 |
| 15 | 5학년 | 초 | (진분수)×(자연수) | 6등분 중 2를 분수로 | ✅ (2/6) | ✅ | 적절 |
| 16 | 2학년 | 초 | 세 자리 수 자릿값 | 247에서 4가 나타내는 값 | ✅ (40) | ✅ | 적절 |
| 17 | 1학년 | 고 | 좌표평면 두 점 거리 | 그림(🌸×6) 나타내는 수 | ✅ (6) | ❌ | 좌표기하에 수세기 문항 |
| 18 | 1학년 | 고 | 두 직선이 수직인 조건 | 768,330 만의자리 값 | ✅ (60000) | ❌ | 고급기하에 자릿값 문항 |
| 19 | 1학년 | 초 | 수직선 위 두 점 거리 | 그림(🐱×2) 나타내는 수 | ✅ (2) | ❌ | 수직선 기하에 수세기 문항 |
| 20 | 6학년 | 초 | 부피 직접 비교 | 97과 13 중 큰 수 | ✅ (97) | ❌ | 6학년에 1학년 수 비교 |

**요약**: 20개 중 정답 정확성은 18개 맞음(90%), 학년·내용 적절성은 20개 중 7개(35%)만 적절. 자동생성 문항의 65%가 해당 노드와 무관한 내용.

---

## 권한 분기 점검 결과

| 기능 | 교사(teacher1) 접근 | 결과 | 평가 |
|------|------------------|------|------|
| `/api/self-learn/dashboard` | 본인 기록 조회 | teacher 자신의 문제풀이 기록 반환 | ⚠️ teacher에게 학생용 대시보드 노출 |
| `/api/self-learn/map/nodes/:id/start` | no-op 처리 | status 변경 안 함 | ✅ 의도적 분기 |
| `/api/self-learn/diagnosis/start` | 정상 세션 생성 | teacher 세션이 diagnosis_sessions에 저장 | ❌ 분기 없음 |
| `/api/self-learn/problem-attempt` | 정상 기록 | teacher 시도가 problem_attempts에 저장 | ❌ 분기 없음 |
| `/api/self-learn/map/nodes/:id/diagnose-complete` | 정상 처리 | teacher node_status = 'diagnosed' 저장 | ❌ 분기 없음 |
| `/api/self-learn/wrong-notes` | 접근 가능 | 교사 오답노트 조회 (13건) | ⚠️ 교사 오답 의미 불명확 |
| `/api/self-learn/wrong-notes/teacher-dashboard` | 접근 가능 | 학생별 오답 현황 반환 | ✅ 교사 전용 기능 |
| `/api/self-learn/ranking` | 반환 | role='student'만 포함 (교사 제외) | ✅ |
| `/api/class/my` | 본인 클래스 반환 | 2개 클래스 확인 | ✅ |
| `/api/lrs/class/:classId` | 접근 가능 | 데이터 없어 빈 응답 | ⚠️ LRS 집계 미작동 |
| `student_node_status` 다른 학생 조회 | userId 파라미터 무시 | 항상 본인 데이터만 | ❌ 교사용 학생 조회 불가 |

### student 전용 진입 시
- 교사가 학생 전용 기능(`/api/self-learn/problem-attempt` 등)에 진입해도 403/401 차단 없음. 데이터가 교사 user_id로 저장되어 오염.

### teacher가 봐야 하는데 안 보이는 기능
- 개별 학생 AI 맞춤학습 진도 조회 화면 없음 (`analytics.html`에서 self-learn 미연동)
- 클래스별 진단 이력 집계 화면 없음
- 학생별 학습맵 완료 현황 교사 뷰 없음

---

## 학습 분석 가능 여부

### LRS 현황
- `xapi_statement_spool` 테이블: 158건 누적 (verb: submitted, did, viewed, searched 등)
- `learning_logs` 테이블: 530건 누적
- 교사가 LRS 데이터를 볼 수 있는 경로: `public/lrs/index.html` → `/api/lrs/class/:id` 호출 (현재 빈 응답)
- `lrs_class_summary` 테이블 존재하나 데이터 없음 → LRS 집계 배치 미실행 상태

### 교사 모니터링 화면
- `analytics.html`: LRS 요약 + 성장기록 데이터 기반 (self-learn 미포함)
- AI 맞춤학습 전용 교사 대시보드: **없음**

---

## 진단 통계의 의미성 평가

### 진단 결과 → 학습 계획 반영
- 진단 완료(`finishDiagnosis`) 후 `user_node_status`에 결과 저장, `generateLearningPath` 호출 가능
- 진단 결과가 낮으면(correctRate < 0.4) 'needs_review' 상태로 학습목록 자동 추가 가능하나, 현재 UI에서 진단 후 자동 경로 추천까지 연결하는 흐름이 완성되지 않음
- teacher1 진단 세션 3개: 2개 in_progress(미완), 1개 completed(quick, 0문항) → 진단 데이터 의미 없음

### 학습목록 자동 추가
- `POST /api/self-learn/learning-list`로 nodeId 추가는 가능하나 진단 결과에서 자동 트리거되지 않음
- `generateLearningPath`에서 경로 생성 후 학습목록 자동 추가하는 로직 없음

---

## 우선 수정 요청 Top 5

1. **[C-3] 교사 역할 시 진단·문제풀이 no-op 처리** — `POST /diagnosis/start`, `POST /problem-attempt`, `POST /diagnose-complete`에 `role === 'teacher'` 분기 추가. 교사 기록이 학생 데이터와 혼입되는 것을 방지. (1일 작업 예상)

2. **[C-2] 총 학습 시간 카드 데이터 연결** — `getLearningDashboard` 함수에 `problem_attempts.time_taken` 합산 및 `user_content_progress.duration_sec × watch_ratio` 기반 총 학습 시간 계산 로직 추가. UI 카드와 API 필드 매핑. (0.5일)

3. **[H-1] progressPercent 분모·분자 node_level 통일** — `completedNodes` 쿼리를 `node_level=3`(차시) 기준으로 변경하거나, `totalNodes`를 전체 node 수로 일관성 있게 수정. (2시간)

4. **[H-2] 교사용 학생 AI 맞춤학습 모니터링 화면 구현** — `analytics.html` 또는 별도 페이지에서 classId 기반으로 학생별 `user_node_status`, `problem_attempts`, `diagnosis_sessions` 집계 API 추가. (3일 예상)

5. **[C-1] 콘텐츠-노드 매핑 정합성 검증 도구 마련** — 자동생성 2,600개 문항에 대해 노드의 `grade`, `grade_level`, `lesson_name`과 문항 내용의 일치성을 점수화하는 검증 스크립트 실행. 부적합 매핑 정리 후 재배포. (1주 이상)

---

## 부록: 주요 확인 수치

| 항목 | 수치 |
|------|------|
| 학습맵 노드 총수 | 1,308개 (level2: 146, level3: 1,162) |
| 콘텐츠 총수 | 2,656건 (quiz 2,506 + video 111 + 기타) |
| content_questions 총수 | 2,603건 |
| EBS 태깅 문항 | 3건 (명세 488건과 불일치) |
| 자동생성 문항 | 2,600건 |
| xapi_statement_spool 누적 | 158건 |
| learning_logs 누적 | 530건 |
| 학생 수 | 8명 |
| teacher1 포인트 누적 | 120점 (학생용 시스템에 혼입) |
| teacher1 진단 세션 | 3건 (모두 의미 없는 상태) |
| 대시보드 실시간 갱신 | ✅ (캐시 없음) |
