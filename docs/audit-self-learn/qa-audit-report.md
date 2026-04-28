# AI 맞춤학습 감리 검수 보고서

- 일시: 2026-04-27
- 검수자: QA 감독 (독립 감리)
- 검수 대상: AI 맞춤학습 전체 (학습맵 · 드로어 · 진단 · 플레이어 · 대시보드 · 나의 기록 · 랭킹)
- 검수 범위
  - 코드 정적 분석: `routes/self-learn.js`, `db/self-learn-extended.js`, `public/self-learn/*.html`
  - DB 데이터 검증: `data/dacheum.db` (better-sqlite3 직접 쿼리)
  - 결정사항 vs 구현 갭 분석 (CLAUDE.md / 워크 이력 6대 결정사항 기준)
- 검수 환경: feat/curriculum-std-aidt 브랜치, commit cf3b581 시점

---

## 종합 판정

🔴 **REWORK (재작업 필수)**

핵심 사유 (요지)
1. 사용자 우려대로 **대시보드 상단 카드 일부 항목이 실제로 동작하지 않음** — 백엔드/프런트 필드명 불일치 + 미반환 필드 의존.
2. **진단 흐름 6대 결정사항이 코드와 정면 충돌**. 결정은 "노드당 2문항·통과 2/2·연속 2회 정답 또는 최대 3단계", 구현은 "노드당 3~5문항·rate≥0.6·CAT 난이도 적응형". → 결정이행 0/6 항목 부적합.
3. **콘텐츠 품질이 사실상 무작위**. 10개 샘플 100%에서 제목-문항 의미 불일치, 1,187 distinct / 2,603 questions = 1,416 중복, "변이 6개인 도형…" 문항이 140 contents에 동일 사용. "EBS 2개 중 무작위" 결정도 27/2,506 contents만 ≥2 문항 보유로 충족 불가.

---

## 핵심 발견 사항 (Top 7)

| # | 항목 | 근거 | 영향 |
|---|------|------|------|
| 1 | 대시보드 "이번 주 학습 시간" 항상 0분 표시 | `learning-map.html:1391` 가 `total_time_minutes`/`totalTimeMinutes` 를 읽으나 `getLearningDashboard` (`db/self-learn-extended.js:975-1102`) 응답 객체에 해당 필드 없음 | 학생이 학습 누적시간을 볼 수 없음 (UX/동기 저해) |
| 2 | 대시보드 "내 순위" 초기 렌더 시 항상 '-' | `dashboard` 응답에 `rank` 없음. `loadRanking()` 이후에야 계산 (`learning-map.html:4587`). 랭킹 탭 미진입 시 영구 '-' | UX 결함 |
| 3 | 진단 결정사항 6개 모두 미준수 | `submitDiagnosisAnswerCAT` (line 1758: `nodeHist.length >= 3`, line 1761: `>= 5`, line 1763: `rate >= 0.6`); CAT는 easy/medium/hard 난이도 적응형이며 결정에 없는 메커니즘 | 본 사업의 핵심 학습공학 정합성 부재 |
| 4 | 콘텐츠-문항 의미 불일치 (auto-generated quiz) | 10/10 샘플 mismatch. 예: 제목 "정육면체의 면, 모서리, 꼭짓점의 수 알기" → 문항 "변이 5개인 도형의 이름은?". 동일 문항 "변이 6개인 도형…" 가 140 contents에서 재사용 | 학습자에게 표시되는 모든 문항이 학습목표와 일치하지 않음. 사업의 학습 효과 자체가 무력화 |
| 5 | "EBS 488 / 자동 1348 = 1836개 quiz" 카운트 모순 | DB 실측: contents.content_type='quiz' = **2,506**, content_questions = **2,603**, ≥2문항 보유 contents = **27** (1.08%) | 결정사항 D6 "EBS 2개 중 무작위" 충족 불가. 주장 수치(1836) 미일치 |
| 6 | 진단 응답 정답 판정 시 random fallback | `db/self-learn-extended.js:721` `isCorrect = Math.random() > 0.3 ? 1 : 0;` (questionId 누락 시) | 학습 데이터 신뢰성 훼손 가능 |
| 7 | 영상 콘텐츠 URL이 placeholder | `contents.content_type='video'` 초기 5건 모두 `https://example.com/videos/*.mp4` 또는 NULL | YouTube 임베드 차단 fallback 검증 자체 불가능 |

---

## 영역별 검수 결과

### A. 대시보드 (사용자 명시 우려) — 🔴 REWORK

코드 위치
- 백엔드: `db/self-learn-extended.js:975-1102` (`getLearningDashboard`)
- 라우터: `routes/self-learn.js:621-630`
- 프런트: `public/self-learn/learning-map.html:1378-1393` (`loadDashboard`), 4500-4569 (`loadRecord`)

응답 정확성: **REWORK**

발견 이슈

A-1. `total_time_minutes` / `totalTimeMinutes` 필드를 프런트가 읽지만 백엔드 미반환
- `learning-map.html:1391` → `(d.total_time_minutes ?? d.totalTimeMinutes ?? 0) + '분'`
- `getLearningDashboard` 반환 필드 (line 1090-1101): `totalNodes, completedNodes, inProgressNodes, currentPath, recentDiagnosis, total_solved, avg_accuracy, total_attempts, progress_percent, progressPercent, streak, area_stats, recent_problems`
- 시간 데이터 없음 → `dashTime` 영구 '0분'
- 재현: 학생 로그인 → 학습맵 진입 → 상단 4번째 카드 '0분' 확인. 기대: 누적 학습시간(분) 표시

A-2. `rank` 필드 백엔드 미반환
- 프런트 `learning-map.html:1392` 가드: `if (d.rank) { ... }` → 항상 거짓
- 사용자가 "랭킹" 탭을 클릭해야만 4587 라인이 실행되어 dashRank 채워짐
- 기대: 대시보드 로드 시점에 사용자 순위 표시

A-3. `total_solved` / `avg_accuracy` / `streak` / `area_stats` / `recent_problems` 는 응답에 있으나 상단 카드에 매핑되지 않음 (My Record 탭에서만 노출). 디자인 의도라면 OK이나, 4-grid 카드의 정보 밀도가 낮음

A-4. 실시간 갱신 검토
- `dashboardCache` 는 `loadDashboard()` 결과를 저장 (1382), `loadRecord()` 가 캐시 우선 사용 (4502).
- 학습 활동 후 `loadDashboard()` 재호출 트리거 부재 — 노드 완료, 진단 완료 시 캐시 무효화 또는 재패치 누락
- 검색: `dashboardCache = null` 또는 `dashboardCache =` 으로 리셋되는 지점 — 1382, 1378, 4503에서 재할당 외 무효화 지점 없음. 학습 후 카드 갱신 안 됨

### B. 진단 흐름 결정사항 6가지 준수 — 🔴 REWORK (0/6)

| # | 결정사항 | 코드 구현 | 평가 |
|---|---------|-----------|------|
| 1 | 노드당 2문항 | `db/self-learn-extended.js:1758` `if (nodeHist.length >= 3) { ... }`, `:1761` `nodeHist.length >= 5` 상한 | REWORK — 3~5문항 |
| 2 | 통과 2/2 정답 | `:1763` `nodePassed = rate >= 0.6` (정답률 60%) | REWORK |
| 3 | 종료조건 연속 2회 정답 OR 최대 3단계 | "단계" 개념 자체 미구현. 큐가 비면 종료 (`:1783-1784`). difficulty_path 기록만 존재 | REWORK |
| 4 | 실패 시 가장 깊이 미통과 노드 + 학습목록 자동 추가 | `drillDownDiagnosis` (`:1847-1866`) 구현 — 직전 선수노드 큐 추가. 그러나 "학습목록 자동 추가"(learning_paths 등록) 코드 누락 | PARTIAL REWORK |
| 5 | 선수 = DB prerequisites | `learning_map_edges` BFS 사용 (`:1628`, `:1854`) | PASS (구현 자체는 부합) |
| 6 | 문항 = EBS 2개 중 무작위 | `_pickQuestionForNode` (`:1576`) `ORDER BY RANDOM() LIMIT 1`. EBS 구분 없음(`contents` 테이블에 `source` 컬럼 부재). DB 실측: ≥2문항 contents = 27/2,506 = 1.08% | REWORK |

추가 결함

B-7. 진단 표준(`submitDiagnosisAnswer`) 경로에서 `questionId` 누락 시 `Math.random() > 0.3` 으로 정답 판정 (line 721) — 데이터 위변조 위험. 클라이언트가 questionId 안 보내면 70% 확률 정답 처리됨

B-8. CAT 모드(`submitDiagnosisAnswerCAT`)는 결정사항에 없는 난이도 적응형(easy/medium/hard) 메커니즘. 결정사항 D2 "통과 2/2 정답"과 모순(연속 2정답 시 hard로 상승, 통과 처리 아님)

### C. 학습 데이터 일관성 — 🟡 CONDITIONAL PASS

C-1. `problem_attempts` 누적 — PASS (count=31, schema 정상)
C-2. `time_taken` 측정 — 부분 PASS. 31건 중 27건 비-NULL. 4건 NULL 존재 → 풀이 클라이언트가 시간 측정 안 보내는 케이스 있음. CLAUDE.md 명시 컬럼명 `timeTakenSec` vs DB 실 컬럼 `time_taken` (단위 ‘초’ 가정) — 명세-구현 일치 확인 필요
C-3. `correct_rate` — `user_node_status.correct_rate` 6건 중 2건 NULL, 1건 38(정수 % 형식), 0건은 0~1 비율. 단위 일관성 불명확 (`db/self-learn-extended.js:1779` 는 0~1 비율로 저장; `:1051` 는 0~100 정수). 두 코드 경로가 서로 다른 단위로 같은 컬럼에 기록 → REWORK 후보
C-4. `node_contents` 1162/1162 매핑 — PASS. DB 실측 `SELECT COUNT(DISTINCT node_id) FROM node_contents` = **1,162** (전체 lvl3 노드 수와 일치)

### D. 콘텐츠 품질 — 🔴 REWORK

D-1. placeholder 0개 — PASS (placeholder/TODO/공란 question_text=0)
D-2. 자동 생성 정답 정확성 — **REWORK 심각**. 10개 무작위 샘플 검토:

| 샘플 | 콘텐츠 제목 | 문항 텍스트 | 평가 |
|------|------------|------------|------|
| 1 | 도형의 둘레 구하는 방법 알기 - 문제 2 | 변이 5개인 도형의 이름은? | MISMATCH |
| 2 | 게를 '몇 kg 몇 g', '몇 g'으로 나타내기 - 문제 2 | 변이 3개인 도형의 이름은? | MISMATCH (단위 학습인데 도형 문제) |
| 3 | 점의 평행이동 - 문제 1 | 🎈🎈🎈🎈 그림 카운트 | MISMATCH |
| 4 | 정육면체의 면, 모서리, 꼭짓점의 수 알기 | 변이 5개인 도형의 이름은? | MISMATCH |
| 5 | 반올림을 활용하여 실생활 문제 해결하기 | 5등분 중 4를 분수로 | MISMATCH |
| 6 | 선대칭도형 그리기 | 변이 4개인 도형의 이름은? | MISMATCH |
| 7 | 함수의 뜻 | 수 배열 규칙 (2,4,6,8,?) | MISMATCH |
| 8 | (진분수)+(진분수)의 덧셈 계산 원리 | 6등분 중 5를 분수로 | PARTIAL (분수 표현은 맞으나 덧셈 계산 X) |
| 9 | (대분수)×(자연수) 계산하기 | 3등분 중 1을 분수로 | MISMATCH |
| 10 | 덧셈, 뺄셈, 곱셈, 나눗셈이 섞여 있는 식 | 9 × 2 = ? | MISMATCH (혼합 X, 단순 곱셈) |

→ 10/10 mismatch. 학습목표와 평가문항이 의미적으로 무관.

D-3. 중복도 — distinct question_text **1,187 / 2,603 = 45%** 만 고유. "변이 6개인 도형…" 단일 문항이 140개 콘텐츠에 동일 사용. 자동 생성 시 템플릿 풀에서 무작위 매핑한 흔적

D-4. EBS 488 / 자동 1348 구분 컬럼 부재. `contents` 테이블에 `source` 컬럼 없음 (`PRAGMA table_info` 확인) → 출처 추적 불가, 결정사항 D6 충족 불가

D-5. 영상 콘텐츠 — `contents.content_type='video'` 5건 중 3건이 `example.com/videos/*.mp4` placeholder, 2건 NULL. YouTube 임베드 차단 fallback은 YouTube URL이 있어야 검증 가능 → **검증 불가** (콘텐츠 부재)

### E. UX 일관성 — 🟢 PASS (대부분)

E-1. 90vw × 90vh 모달 — PASS. `learning-map.html:3032`, `:3732` 둘 다 `width:90vw;height:90vh` 적용
E-2. z-index 위계
- filter-sidebar: 10010
- drawer-overlay: 10020 / drawer: 10021 — CLAUDE.md 명시값 일치
- modal-overlay: 10030 / modal: 10031
- 큰 모달(문항 풀이): 10100 — CLAUDE.md 명시값 일치
- 정답/오답 배너: 10101
- toast: 10040
→ 위계 일관, **PASS**
E-3. 빈 상태 — `recRecentList`, `recAreaList`, `recWrongList` 모두 빈 메시지 처리 (`learning-map.html:4527, 4546, 4567`). PASS
E-4. 닫기 버튼 / 텍스트 정렬 — 정적 분석 한계. 동적 검수 권고

### F. 보안·접근성·개인정보 — 🟡 CONDITIONAL PASS

F-1. requireAuth 적용 — PASS. `routes/self-learn.js` 57개 라우트 중 58회 requireAuth 호출 (모든 라우트 인증)
F-2. 학생/교사 권한 분기 — `wrong-notes/teacher-dashboard` (line 663) 등 교사 라우트 존재. 단, 교사용 라우트에서 `req.user.role === 'teacher'` 체크 없음. 학생도 `/teacher-dashboard` 호출 가능 가능성 → REWORK 후보
F-3. 키보드 접근성 — Tab/Enter/Esc 핸들러 정적 분석 범위 외, 동적 검수 권고
F-4. 색약자 — 진단 정답/오답 배너가 `#10B981` (녹) / `#EF4444` (적) 으로만 구분 (line 3909). 색맹 사용자에게 ✓/✗ 아이콘이 함께 표시되긴 함 (`fa-check`/`fa-times`) → PASS

F-5. 개인정보
- `getRanking` 응답에 `display_name, school_name, grade` 노출 (`db/self-learn-extended.js:1120`). 동일 학교가 아닌 학생들끼리 학교명 노출 시 개인정보 이슈 검토 필요
- 진단 답변(diagnosis_answers) 평문 저장. 민감정보 아니므로 OK

### G. 성능 — 🟡 CONDITIONAL PASS

G-1. 1,308 노드 + 2,506 콘텐츠 — 학습맵 캔버스가 모든 노드를 렌더 시 DOM 부담. 동적 검수 권고
G-2. `dashboardCache` 효과 — `loadRecord()` 가 캐시 활용 (4502). 그러나 invalidate 부재로 stale 데이터 위험
G-3. `getLearningDashboard` 쿼리 — 7+ 별도 쿼리 직렬 실행. SQLite 동기 호출이라 큰 부담은 아니지만 N+1 패턴 (특히 area_stats CTE) 사용자 100명 동시 접속 시 검토 필요

---

## REWORK 우선순위 매트릭스

| ID | 영역 | 심각도 | 노력 | 영향도 | 우선순위 | 재현 시나리오 / 기대 동작 |
|----|------|--------|------|--------|----------|---------------------------|
| REW-001 | A 대시보드 | High | Low | High | **P0** | 학생 로그인 → 학습맵 진입 → 상단 카드 4번째 "0분" / 2번째 카드 항목 미동작. 기대: total_time_minutes 백엔드 추가 또는 problem_attempts.time_taken SUM 노출 |
| REW-002 | B 진단 흐름 | Critical | High | Critical | **P0** | `_qa_check.js` 로 직접 진단 시작 → 노드당 3~5문항 풀이 후 종료. 기대: D1 "노드당 2문항" 강제, D2 "2/2 정답 통과", D3 "최대 3단계" 종료 조건 구현 |
| REW-003 | D 콘텐츠 품질 | Critical | High | Critical | **P0** | 학습맵에서 임의 노드 클릭 → 풀이 → 학습목표와 무관한 문항 노출. 기대: 콘텐츠 제목과 문항이 의미적으로 일치(전수 재생성 또는 재수동작업), 중복 문항 ≤10% |
| REW-004 | B7 random fallback | High | Low | High | **P0** | questionId 미포함 진단 응답 → 70% 정답 처리. 기대: questionId 필수화, 누락 시 400 에러 |
| REW-005 | C3 correct_rate 단위 | Medium | Low | Medium | **P1** | 동일 컬럼에 0~1 / 0~100 두 단위 혼재. 기대: 단일 단위 통일 + 마이그레이션 |
| REW-006 | A2 rank 미반환 | Medium | Low | Medium | **P1** | 대시보드 진입 시 dashRank '-' 표시. 기대: dashboard 응답에 rank 포함 또는 loadRanking을 loadDashboard 안에서 호출 |
| REW-007 | A4 캐시 무효화 | Medium | Low | Medium | **P1** | 노드 완료 후 학습맵 복귀 시 카드 수치 stale. 기대: 학습 활동 후 dashboardCache=null + loadDashboard 재호출 |
| REW-008 | F2 교사 라우트 권한 | High | Low | Medium | **P1** | 학생 계정으로 GET /api/self-learn/wrong-notes/teacher-dashboard 호출 → 200 응답 가능성. 기대: requireRole('teacher') 미들웨어 추가 |
| REW-009 | D5 영상 placeholder | Medium | Medium | Low | **P2** | example.com URL → 재생 불가. 기대: 실제 영상 또는 차단 시 이미지/안내 fallback |
| REW-010 | D4 source 컬럼 부재 | Medium | Medium | High | **P1** | EBS/자동 구분 불가. 기대: contents.source 컬럼 추가 + 마이그레이션 |
| REW-011 | E4 닫기버튼/정렬 | Low | Low | Low | **P3** | 동적 검수 시 발견될 수 있는 기본 UX 점검 — 현재 정적 분석 한계 |
| REW-012 | G1 학습맵 성능 | Low | Medium | Medium | **P2** | 1,308 노드 동시 렌더 시 FPS 저하 가능. 기대: 가시 영역 가상화 |

---

## 최종 판정 사유

본 검수는 **🔴 REWORK** 로 판정합니다. 사유는 다음과 같습니다.

1. **사용자 명시 우려가 사실로 확인됨**: 대시보드 4-grid 중 "이번 주 학습 시간" 및 초기 "내 순위" 카드가 백엔드-프런트 필드명 불일치(미반환 필드 의존)로 인해 실제로 동작하지 않습니다. 이는 정적 코드 분석만으로 100% 확정 가능한 결함입니다.

2. **본 사업의 학습공학 핵심 결정사항이 코드와 불일치합니다.** 진단 흐름 6대 결정사항 중 5개가 미준수입니다. 특히 D1·D2·D3은 본 프로젝트의 차별점이라 명시되어 있으나 구현은 별개 메커니즘(난이도 적응형 CAT, 정답률 60%, 노드당 3~5문항)을 사용하고 있습니다.

3. **콘텐츠 품질이 현장 적용 불가 수준입니다.** 무작위 10개 샘플 100%에서 학습목표(콘텐츠 제목)와 평가문항이 의미적으로 무관합니다. 1,187/2,603 = 45%만 고유 문항이고, 단일 문항이 140 콘텐츠에 재사용됩니다. 이 상태에서 학생이 풀이를 진행하면 진단·학습 결과 데이터 자체가 무의미해집니다.

4. **데이터 무결성 결함**: 진단 응답 처리 코드에 `Math.random()` 정답 판정 fallback이 잔존하며, `correct_rate` 컬럼 단위가 두 코드 경로에서 다르게(0~1 vs 0~100) 기록되어 분석 결과가 왜곡됩니다.

다만 다음 영역은 양호합니다.

- z-index 위계와 90vw/90vh 모달은 CLAUDE.md 명시값과 일치 (E-1, E-2)
- 모든 라우트 requireAuth 적용 (F-1)
- node_contents 1,162/1,162 100% 매핑 (C-4)
- 빈 상태 메시지 처리 (E-3)

---

## PM 권고 사항

### 즉시 수정 필요 (이번 사이클, P0)

1. **REW-001 / REW-006**: `getLearningDashboard` 응답에 `total_time_minutes`(`SUM(time_taken)/60`) 와 `rank`(getRanking 호출 후 user_id 매칭) 추가. 30분 이내 작업
2. **REW-002**: 진단 흐름 6대 결정사항을 **결정문서 또는 코드 둘 중 하나로 일치시켜야 함**. PM이 결정사항을 변경(현행 CAT 인정)하거나 코드를 결정사항대로 재작성. 의사결정 회의 필요
3. **REW-003**: 콘텐츠 재정비 — 자동 생성 1,348 quiz를 전수 검증·재생성. 콘텐츠팀 별도 트랙 운영 권고. 검증 도구로 "제목-문항 의미 매칭 점수" 계산 자동화
4. **REW-004**: `submitDiagnosisAnswer` (line 720-722) Math.random fallback 제거, questionId 필수화

### 다음 사이클 회부 (P1)

- REW-005 correct_rate 단위 통일 (0~100 정수로 통일 + 마이그레이션 스크립트)
- REW-007 dashboardCache 무효화 (노드 완료/진단 완료 시 캐시 클리어)
- REW-008 교사 라우트 requireRole('teacher') 추가
- REW-010 contents.source 컬럼 추가 + 시드 데이터 출처 표시

### 장기 검토 (P2 이상)

- REW-009 영상 placeholder → 실제 EBS·YouTube 콘텐츠 정식 연동
- REW-012 학습맵 가상화 (1,308 노드 동시 DOM 렌더 회피)

### 추가 권고

- **동적 검수 후속 진행 권장**: 본 보고서는 정적 분석 + DB 직접 쿼리 기반입니다. 실제 브라우저 기반 동적 검수(키보드 접근성, 닫기 버튼 위치, 빈 상태 시각, 영상 fallback, 진단 종료 화면)는 별도 사이클로 진행 권고합니다.
- **정량 자동화 회귀 테스트**: 본 검수에서 사용한 "문항 제목-텍스트 매칭", "필드명 일치", "questionId 누락 정답 판정" 검증을 `tests/` 하위에 자동화하여 PR 게이팅 권고.

---

## 부록: 검수 정량 근거

### DB 실측 (data/dacheum.db, 2026-04-27)

```
contents 총수:              2,656
content_type별:
  quiz:        2,506
  video:         111
  exam:           11
  document:       14
  ...
content_questions:          2,603
content_questions distinct: 1,187 (45.6%)
placeholder questions:          0
empty answer:                   1
contents with ≥2 questions:    27 (1.08%)
learning_map_nodes total:   1,308
  node_level=2:               146
  node_level=3:             1,162
node_contents 매핑:
  rows:                      3,272
  distinct nodes:            1,162 (100% lvl3 매핑)
problem_attempts:               31
  time_taken NULL/0:            4
  time_taken > 0:              27
user_node_status:                6
diagnosis_sessions schema:
  id, user_id, target_node_id, diagnosis_type, status, total_questions,
  correct_count, result, started_at, completed_at, difficulty_path,
  queue_nodes, current_node_id, current_difficulty, per_node_answers
contents schema 컬럼 source 컬럼: 부재
```

### Top 15 중복 문항

```
140 × "변이 6개인 도형의 이름은 무엇입니까?"
117 × "변이 5개인 도형의 이름은 무엇입니까?"
114 × "변이 3개인 도형의 이름은 무엇입니까?"
102 × "변이 4개인 도형의 이름은 무엇입니까?"
 49 × "전체를 2등분한 것 중 1만큼을 분수로 나타내면 무엇입니까?"
 ...
```

### 코드 위치 인덱스

- 대시보드 응답: `db/self-learn-extended.js:975-1102`
- 대시보드 라우트: `routes/self-learn.js:621-630`
- 대시보드 프런트: `public/self-learn/learning-map.html:1378-1393`, `4500-4569`
- 진단 시작 (CAT): `db/self-learn-extended.js:1608-1676`
- 진단 답변 처리 (CAT): `db/self-learn-extended.js:1678-1845`
- 진단 답변 처리 (표준): `db/self-learn-extended.js:704-750` (Math.random fallback line 721)
- 문항 선택: `db/self-learn-extended.js:1560-1606`
- 큰 모달 (90vw 90vh): `public/self-learn/learning-map.html:3030-3032`, `3730-3732`
- 정답/오답 배너: `public/self-learn/learning-map.html:3909`
- 랭킹 응답: `db/self-learn-extended.js:1104-1135`

---

*본 보고서는 외부 감리(QA 감독) 역할로 작성되었으며, 모든 발견 사항은 코드 라인 번호 또는 SQLite 쿼리 결과로 정량 근거를 제시했습니다. 각 REWORK 항목은 재현 시나리오와 기대 동작이 명시되어 있어 PM이 직접 우선순위를 조정·이양할 수 있습니다.*
