# AI 맞춤학습 REWORK 결과 — PM 직접 처리

- 일시: 2026-04-28
- 처리자: PM(Claude Code) — 서브에이전트 토큰 한도 초과로 PM이 직접 처리
- 종합 판정: 🟡 P0 4건 완료 / P0 1건(콘텐츠 매칭) 추가 작업 필요

## 처리 완료 항목

### B-P0-1. 대시보드 API 누락 필드 추가 ✅
- 파일: `db/self-learn-extended.js` `getLearningDashboard()` (line 975~)
- 추가 필드:
  - `total_time_minutes` — `problem_attempts.time_taken` 합산 ÷ 60
  - `rank` / `total_users` — 같은 학년 cohort 우선, 1명뿐이면 전체 학생 cohort fallback
- 동시 수정: `school_id` 컬럼 미존재 오류로 try block에서 throw → 수정
- 검증: GET /api/self-learn/dashboard 응답:
  ```json
  { "total_time_minutes": 8, "rank": 1, "total_users": 5, ... }
  ```

### B-P0-2. progressPercent 분모 정정 ✅
- 분모를 level=2 단원(146개) → level=3 차시(1162개)로 통일
- 분자/분모 일관성 확보 (둘 다 차시 기준)

### B-P0-3. 교사 권한 분기 추가 ✅
- 파일: `routes/self-learn.js`
- `POST /diagnosis/start` line 482: teacher/admin 시 `{skipped:true, reason:'teacher_no_record'}` 반환
- `POST /problem-attempt` line 859: 동일 분기
- 효과: 교사가 진단/풀이해도 학생 기록(diagnosis_sessions, problem_attempts, 포인트) 누적 안 됨

### F-P0-1. 대시보드 카드 데이터 매핑 정정 ✅
- 파일: `public/self-learn/learning-map.html` `loadDashboard()` (line 1379~)
- 응답 키 정규화 + 빈 상태 em-dash(`—`) 표기
- 60분 이상이면 "N시간 M분" 표시
- 랭킹 없으면 "아직 데이터가 없어요" 안내

### F-P0-2. 진단 모달 라벨 모순 해결 ✅
- 헤더: "깊이 1/3 · 문항 1/2" → **"단계 1/3"** 으로 단순화
- 바디: "문제 1/2" 만 표시
- 학생 혼란 제거

## EBS 콘텐츠 추적 (감리 보고 정정)

감리 보고서: "EBS 태깅 문항이 명세상 488개이나 실제 DB에 3건뿐"

**실측 결과 (정정)**:
- 전체 quiz: 2,375개
- EBS 태그(`tags LIKE '%EBS-%'`): **916개** ✓ 정상
- EBS URL 보유: 916개
- 자동생성: 1,348개
- 합계: 916 + 1,348 = 2,264 + 기타 111 = 2,375 ✓

→ 감리의 "3건" 보고는 검색 방식 오류였음. EBS 콘텐츠는 정상 import됨.

## 추가 작업 필요 (다음 사이클)

### P0-콘텐츠. 자동 생성 1,348 문항 노드 mismatch (재생성)
- 감리/교사테스터 일치 발견: 약 65% 노드와 무관한 문항 (예: "정육면체 면·모서리" → "변이 5개 도형?")
- 원인: `generateProblem()` 의 lesson_name 패턴 매칭 단순
- 해결안: lesson_name별 더 정밀한 분기 + 중·고등학교 용어 추가 + 대규모 재생성
- 별도 트랙으로 진행 권장 (콘텐츠팀 검수 동반)

### P1-진단. 백엔드 진단 로직 결정사항 정합
- 결정: 노드당 2문항·통과 2/2·최대 3단계
- 코드: 3~5문항·rate≥0.6·CAT 적응형 (`db/self-learn-extended.js:1758`)
- 프런트는 결정대로 동작하지만 백엔드 startDiagnosisCAT 등이 다른 로직
- 해결 방향: CAT 백엔드를 결정사항대로 단순화 OR 결정사항을 CAT 방식으로 업데이트
- 사용자 결정 필요

### P1-UX. UI 디자이너 보완 기획서의 P1/P2 (5건)
- 진단 모달 헤더 z-index/안전영역 32px
- 노드 카드 140×80px (현재 121×72)
- 영역색 4종 / 차시 진행률 4상태 색 코딩
- CTA 위계 (primary 1개만)
- 학습 랭킹 빈 상태 디자인

### P1-페르소나. today.html 역할 자동 전환 버그
- UI 디자이너 발견: `/self-learn/today.html` 진입 시 학생→교사로 헤더 전환
- 추적 필요: `public/js/common-nav.js` 또는 today.html 자체 코드

### P1-analytics. 교사용 학생별 진도 화면
- 교사 테스터 H-2: `analytics.html` 존재하나 self-learn API 미호출
- 교사가 학생 학습을 모니터링하는 표준 화면 필요

## 영향 받은 파일

- `db/self-learn-extended.js` — getLearningDashboard 확장
- `routes/self-learn.js` — 권한 분기 추가
- `public/self-learn/learning-map.html` — 대시보드 카드, 진단 라벨

## 메인 폴더 sync
- 모든 변경 파일 메인 폴더에 sync 완료
- `node scripts/sync-to-main.mjs HEAD` 또는 직접 cp 사용
