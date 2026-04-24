# 교육과정 표준체계 + AIDT xAPI 도입 작업계획서 (상세)

> 참조: `AIDT 기술규격문서(데이터수집) v2.2_240802.hwpx` (22~88p)
> 엑셀: `교육과정표준체계_최종산출물_202412/` (KICE 국어·사회·영어·실과, KOFAC 과학·정보, 충북형 수학)
> 환각 방지를 위해 각 단계는 **명확한 입력·출력·검증 체크리스트**를 갖고, 단계 간 의존성을 명시한다.

---

## 0. 전체 Phase 개요

| Phase | 이름 | 실행 | 선행 의존 | 예상 규모 |
|---|---|---|---|---|
| A | 데이터 기반 구축 | 병렬+순차 | — | 중 |
| B | xAPI 빌더 · 스풀 · 송신 | 병렬+순차 | A완료 | 대 |
| C | 메타데이터 UI 컴포넌트 | 순차+병렬 | A완료 | 중 |
| D | 각 UI 지점 적용 | 병렬 | C1·C2완료 | 대 |
| E | 배치 송신 · 대시보드 · 운영 | 순차 | B·D완료 | 중 |
| F | 통합 검증 · 회귀 테스트 | 순차 | 전단계 | 중 |

---

## Phase A. 데이터 기반 구축

### A0. 브랜치 & 안전장치 (순차, 5분)
- 별도 feature 브랜치 `feat/curriculum-std-aidt` 생성 (현재 `claude/distracted-blackwell` 기반)
- `.claude/plans/` 에 본 문서, 체크리스트 체크박스 추적
- DB 백업 사본 `data/dacheum.db.bak-YYYYMMDD` 생성

**검증**: 브랜치 확인 + 백업 파일 존재.

### A1. 엑셀 구조 사전 조사 (병렬 - 서브에이전트 1명)
**목적**: 실제 엑셀 파일의 시트명·컬럼명·샘플 로우를 각 교과별 표로 정리.
**산출물**: `docs/plans/excel-schema-survey.md` — 교과별 시트명 / 컬럼 배열 / 대표 3행 / 특이사항.
**서브에이전트 프롬프트 요지**: Python openpyxl로 7개 파일 파싱, 계층 컬럼 모두 식별. 수학·영어·정보 변형 주목.

**검증**:
- 각 교과에 대해 ID/영역/1~3단계/성취기준코드/성취기준/성취수준 컬럼 존재 여부 체크리스트
- 수학(충북) 선수/후속 컬럼 위치 확정
- 중간보고서를 인간이 한 번 리뷰

### A2. DB 스키마 변경 (순차, A1 후)
**추가 테이블**:
```sql
-- 내용체계 트리
curriculum_content_nodes(id PK, subject_code, school_level, grade_group, depth, parent_id, label, sort_order, source, version)
-- 성취기준 ↔ 노드 매핑 (N:N)
curriculum_standard_nodes(standard_code, node_id, PRIMARY KEY)
-- 성취수준
curriculum_standard_levels(standard_code, level_code, description, PRIMARY KEY)
-- 성취기준 코드 ↔ 표준체계 ID 매핑
curriculum_std_id_map(standard_code, std_id, subject_code, grade_group, PRIMARY KEY)
-- 자손 사전계산
curriculum_node_descendants(ancestor_id, descendant_id, depth_diff, PRIMARY KEY)
-- xAPI 스풀
xapi_statement_spool(id, user_uuid, area, verb, statement_json, event_timestamp, sent_at, sent_status, error_message, created_at)
-- 표준체계 기반 로컬 집계
lrs_std_node_stats(user_id, node_id, depth, attempts, correct, last_level, updated_at, PK)
```

**ALTER**:
```sql
ALTER TABLE contents      ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE lessons       ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE homework      ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE exams         ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE quiz_items    ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE problem_sets  ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE wrong_answers ADD COLUMN curriculum_standard_ids TEXT;
ALTER TABLE curriculum_standards ADD COLUMN std_source TEXT;
```

**구현 위치**: `db/schema.js` 하단 블록 + 기존 `init` 흐름 준수(멱등성).

**검증**:
- `sqlite3 data/dacheum.db ".schema"` 실행해 모든 신규 테이블/컬럼 존재 확인
- 기존 seed/start-up 스크립트가 오류 없이 종료
- 기존 테이블 데이터 건수 변동 없음(sample 3개 테이블 select count)

### A3. 엑셀 → 시드 파서 (병렬 - 서브에이전트 분담 가능)
**스크립트**: `scripts/import-curriculum-std.mjs`
- 어댑터 패턴: `adapters/kice-standard.js` (국어·사회·과학·실과), `adapters/kice-english.js` (영어 3단계), `adapters/kofac-info.js` (정보 5단계), `adapters/cb-math.js` (수학).
- 각 어댑터 → 동일한 표준 출력: `{nodes[], standards[], standardNodes[], standardLevels[], stdIdMap[]}`
- 상위 드라이버가 각 어댑터 결과를 upsert.

**병렬 전략**: 서브에이전트 4명에게 어댑터 1개씩 맡긴다 (각 독립 파일).
- 서브에이전트 1: `adapters/kice-standard.js` + 단위테스트
- 서브에이전트 2: `adapters/kice-english.js`
- 서브에이전트 3: `adapters/kofac-info.js`
- 서브에이전트 4: `adapters/cb-math.js` + 학습맵 엣지 변환

**검증 체크리스트 (각 어댑터)**:
- [ ] 엑셀 총 행 수 == 출력 `nodes` + `standards` 개수 정합
- [ ] `standard_code` 포맷 `\[\d[가-힣]\d{2}-\d{2}\]` 통과
- [ ] `std_id` 포맷 `E\d(KOR|SOC|ENG|SCI|PRA|MAT|INF)A\d{2}(B\d{2})?(C\d{2})?(D\d{2})?` 통과
- [ ] 성취수준 레벨 값 ∈ {A,B,C,D,E}
- [ ] parent_id가 존재하는 노드를 참조 (dangling 없음)
- [ ] 수학: 선수/후속학습ID가 존재하는 노드를 참조

**통합 드라이버 검증**:
- 로더 실행 후 `curriculum_content_nodes` 총 건수 >= 1000
- `curriculum_standard_nodes` N:N이 중복 없이 유일
- 기존 `curriculum_standards` 920건 그대로 + 실과/정보만 추가

### A4. 조회 API 추가 (순차, A3 후)
**신규**:
- `GET /api/curriculum/content-nodes?subject_code&grade_group&depth&parent_id`
- `GET /api/curriculum/content-nodes/:id/standards` — 리프 성취기준
- `GET /api/curriculum/standards/:code/levels` — 성취수준 A~E
- `GET /api/curriculum/std-id-map?standard_code=[4수01-01]` — 양방향 resolve

**확장** (호환 유지):
- `GET /api/contents?curriculum_standard_ids=E4MATA01B02` — 자손까지 매칭(CTE)
- 기존 `achievement_codes=` 계속 허용

**검증 (API별)**:
- 입력 필드 validation 실패시 400
- 미존재 코드는 404
- 자손 포함 쿼리가 `curriculum_node_descendants` join으로 나오는지 EXPLAIN 확인
- 기존 API 회귀 테스트 (curl 5개 대표 요청)

### A5. 통합 검증 (순차)
- 서버 재시작 → 콘솔 에러 0
- 기존 플로우(콘텐츠 목록, 평가 생성, 수업 생성) 수동 클릭 테스트 → 이전과 동일 동작
- 체크리스트 통과 후 **Phase A 종료 커밋**

---

## Phase B. xAPI 빌더 · 스풀 · 송신

### B1. 공통 유틸 (순차)
**파일**: `lib/xapi/common.js`
- `makeActor(userUuid, homePage)` → xAPI Agent
- `makeContext(partnerId, platformName)` → `context.platform` + `partner-id`
- `mapContentType(internalType)` → AIDT E/I/A/V/IM/T/P/Z
- `mapAssessmentType`, `mapItemType`, `mapQuestionType`
- `resolveStdIds(curriculum_standard_ids, achievement_codes)` — DB 매핑 테이블 조회
- `computeAchievementLevel(subject_code, itemResults)` — A~C / A~E 환산

**검증**:
- 각 유틸에 `tests/xapi-common.test.mjs` 단위테스트(입·출력 3케이스 이상)
- 성취수준 환산 경계값(0.79/0.80 등) 통과

### B2. 영역별 빌더 (병렬 - 서브에이전트 분담)
**10개 파일** `lib/xapi/builders/{area}.js`:
- media.js / assessment.js / assignment.js / navigation.js / objective.js / query.js / social.js / survey.js / annotation.js / teaching.js

**서브에이전트 분담**: 3명
- 서브1: media, navigation(4개 verb), query — **콘텐츠 관련**
- 서브2: assessment, assignment, objective — **평가/과제 관련**
- 서브3: survey, annotation, teaching, social — **학습자/교사 활동**

**각 빌더 시그니처**: 공통 입력 `(commonCtx, payload)` → Statement 객체.

**검증 체크리스트 (빌더별)**:
- [ ] AIDT 예시 JSON(문서 내 샘플)과 필드명 100% 일치
- [ ] 모든 extension IRI가 `http://aidtbook.kr/xapi/profiles/*` 범위
- [ ] 필수 필드 누락시 throw
- [ ] `curriculum-standard-id` 배열 포함 (해당 영역 규격상 필수인 경우)
- [ ] `tests/builders/{area}.test.mjs`로 샘플 1건 이상 스냅샷 테스트

### B3. 스풀 + 로컬 저장 (순차, B1 완료 후)
**파일**: `lib/xapi/spool.js`
- `enqueue(statement, {area, verb, userUuid, timestamp})` — `xapi_statement_spool` INSERT
- `markSent(id, status, err)` — 전송 후 상태 업데이트
- `drainUnsent(limit)` — 미전송 조회
- 동시에 `lrs_std_node_stats` upsert 훅 (리프 + 조상 체인)

**검증**:
- enqueue 후 select 가능, 멱등성(같은 event_id 중복 방지 옵션)
- stats upsert가 depth 전체(0~3)에 반영
- 단위테스트 통과

### B4. 이벤트 경로 주입 (병렬 - 각 라우터 독립)
각 기능 경로에 builder + spool 호출 추가:

| 경로 | 라우터 파일 | 빌더 |
|---|---|---|
| 콘텐츠 열람 | `routes/content.js` | navigation (viewed/read/did/learned) |
| 미디어 재생 완료 | `routes/content.js` | media.played |
| 평가 제출 | `routes/exam.js` | assessment.submitted |
| 과제 등록 | `routes/class.js` (homework) | assignment.gave |
| 과제 제출 | `routes/class.js` | assignment.finished |
| 스마트 검색 | `routes/search.js` (신규) | query.searched |
| AI튜터 질문 | 해당 라우터 | query.asked |
| 감정/이해도 조사 | `routes/growth.js` | survey.submitted(×3) |
| 주석 | `routes/self-learn.js` (wrong-note) | annotation.made |
| 교사 피드백·학급 재편성 | `routes/class.js` | teaching.gave/reorganized |
| 목표 설정 | `routes/self-learn.js` | objective.set |

**서브에이전트 분담**: 2명 (콘텐츠/평가/과제, 검색/설문/주석/교수)

**검증 (경로별)**:
- 호출 시 `xapi_statement_spool`에 1건 추가됨 (curl + DB select)
- 실패해도 원래 응답은 정상 반환(부가 기능이 본기능 막지 않음)
- 기존 API 응답 포맷 무변경 (회귀 없음)

### B5. Phase B 통합 검증 (순차)
- 대표 시나리오 10개를 수동으로 발생시켜 spool 레코드 10건 이상 생성 확인
- 샘플 statement 3건을 AIDT 규격 JSON validator (수작업 체크)로 검증

---

## Phase C. 메타데이터 UI 컴포넌트

### C1. `<std-picker>` — 선택용 (순차)
**파일**: `public/common/std-picker.js` (Web Component)
- Props: `subject-code`, `grade-group`, `multiple`
- 교과·학년 확정 시 `/api/curriculum/content-nodes?depth=0` 호출 → 노드 있으면 **계층 모드**, 없으면 **레거시 모드**(기존 성취기준 검색만)
- 값(`value`) = `{ curriculum_standard_ids: [], achievement_codes: [] }`
- 선택·해제 이벤트 `change` 발생

**검증**:
- 표준체계 있는 교과(초4 국어)에서 4단 드릴다운 동작
- 표준체계 없는 교과(초1-2 수학)에서 검색창만 표시
- 선택 결과 `value` 두 배열 모두 자동 resolve (`curriculum_std_id_map` 사용)

### C2. `<std-smart-search>` — 검색용 (순차, C1 완료 후)
**파일**: `public/common/std-smart-search.js`
- 단일 검색창 + 자동파싱(성취기준코드 / std_id / 키워드 / "초4 국어" 등)
- 드롭다운 섹션: 성취기준 / 영역 / 내용요소(2~3단계) / 콘텐츠
- 칩 누적 AND, 동일 depth 내 OR
- 통합 API `GET /api/search/smart` 호출
- 검색 결과 클릭 → `selected` 이벤트 (검색어 + 선택 콘텐츠) → 호출자가 `searched` statement 발행

**서버 신규**: `routes/search.js` with `GET /api/search/smart` (병렬로 C2와 함께 진행)

**검증**:
- 5개 입력 패턴에 대해 각 섹션 올바르게 채워짐
- 표준체계 없는 교과는 "영역/내용요소" 섹션 자동 숨김
- 2초 내 응답 (debounce 200ms + 서버 100ms 목표)

### C3. 공용 어댑터 (순차)
**파일**: `public/common/std-search-adapter.js`
- 기존 `searchPubStandards` 스타일의 입력+드롭다운+칩 UI를 1줄 import로 교체 가능하게

**검증**: `content/index.html` 업로드 폼에 1곳 적용 → 기존과 동일 사용감 + 결과 형식 확장.

---

## Phase D. UI 지점별 적용 (병렬)

Phase C가 끝나면 각 지점 적용은 독립적 → 병렬 가능.

### D 분담 (서브에이전트 6명)
- D1: `public/content/index.html` 업로드 폼 + 목록 검색 필터
- D2: `public/class/class-home.html` examModal 3모드 + homeworkModal
- D3: `public/class/lesson-create.html` + `lesson-player.html`
- D4: `public/self-learn/problem-sets.html` + `learning-map.html`
- D5: `public/self-learn/wrong-note.html` + `today.html`
- D6: `public/admin/index.html` + `public/lrs/index.html`

**각 D 검증 체크리스트**:
- [ ] `<std-picker>` 또는 `<std-smart-search>` 교체 완료
- [ ] 저장 API 요청 본문에 `curriculum_standard_ids` 배열 포함
- [ ] 기존 `achievement_codes` 필드 계속 전송(레거시 호환)
- [ ] 교과·학년 전환 시 모드 전환 정상
- [ ] 기존 사용자 플로우(저장·불러오기) 회귀 없음
- [ ] 콘솔 에러 0

### D7. 통합 수동 QA (순차)
- 교사: 콘텐츠 업로드 → 평가 생성 → 과제 생성 → 수업 생성 → 대시보드 조회
- 학생: 문제 풀이 → 오답노트 → 감정 체크 → 학습맵
- 각 단계에서 `xapi_statement_spool`에 해당 statement 생성 확인

---

## Phase E. 배치 송신 · 대시보드 · 운영

### E1. 배치 송신 스크립트 (순차)
**파일**: `scripts/send-xapi-batch.mjs`
- 미전송 100건 단위 chunk 송신
- 응답 파싱: statement별 index 에러 구별
- 성공 → `markSent`, 실패 → error_message 기록 + 지수 백오프
- cron/scheduled-task 등록 방법 문서화 (`docs/ops/xapi-batch.md`)

**검증**: Mock AIDT 엔드포인트로 200/4xx/5xx 응답에 대해 시나리오 테스트 3종.

### E2. 표준체계 기반 LRS 대시보드 (순차)
`public/lrs/index.html`에 탭 추가:
- 영역별 성취수준 분포
- 학생별 취약 내용요소 히트맵
- xAPI 전송 상태(성공/실패/대기) 패널

**검증**: 실제 spool 데이터로 렌더링 + 숫자 sanity check.

### E3. 환경 설정 (순차)
- `.env.example`에 `AIDT_API_DOMAIN`, `AIDT_AUTH_KEY_TEST`, `AIDT_AUTH_KEY_PROD`, `AIDT_PARTNER_ID`, `AIDT_PLATFORM_NAME`, `AIDT_PLATFORM_HOMEPAGE`, `AIDT_UUID_NAMESPACE` 추가
- 테스트/운영 분기 `lib/xapi/config.js`

**검증**: 누락 env 시 서버 시작 시점 경고만(서비스 가능하게).

---

## Phase F. 통합 검증 · 회귀 테스트

### F1. E2E 시나리오 (순차)
`tests/e2e/curriculum-std-aidt.spec.mjs` (Playwright) — 아래 시나리오:
1. 초등 수학 교사가 평가를 만들고 학생이 제출 → assessment.submitted statement 생성, achievement-level 정확
2. 초등 국어 검색 → searched statement + search-detail 생성
3. 표준체계 없는 교과(중학 국어) 저장 → `curriculum_standard_ids = []`
4. 학습맵 노드 클릭 → 해당 노드 기반 검색 결과

### F2. 회귀 체크리스트
- 기존 `achievement_code` 기반 검색 결과 변동 없음
- 기존 LRS 대시보드 숫자 변동 없음
- 기존 콘텐츠 불러오기 / 평가 / 과제 전부 정상

### F3. 문서화
- `docs/xapi-integration.md` — 개발자 가이드
- `docs/curriculum-std-schema.md` — 스키마 참조
- `RELEASE_NOTES.md` 업데이트

---

## 체크포인트 & 커밋 단위

커밋은 Phase 내 섹션 단위로 쪼개서 되돌리기 쉽도록:
- `A0` → branch 생성만
- `A1` → survey.md만
- `A2` → schema.js 변경
- `A3` → 각 adapter별 별도 커밋(4개) + 통합 driver 1개
- `A4` → API + 테스트
- `B1` → common 유틸
- `B2` → 빌더 3~4개씩 커밋(서브에이전트별)
- `B3` → spool
- `B4` → 경로 주입 2~3개씩
- `C1/C2/C3` → 각 1커밋
- `D1..D6` → 각 1커밋
- `E1/E2/E3` → 각 1커밋
- `F` → 최종

각 커밋 후 **인간 리뷰 5분 + 간단 수동 테스트** → 통과 시 다음 단계.

---

## 서브에이전트 운영 원칙

1. **독립 파일만 부여** — 같은 파일 동시 수정 금지.
2. **입출력 스키마 고정** — 프롬프트에 정확한 시그니처 명시.
3. **검증 책임 부여** — 프롬프트에 "끝나면 단위테스트 작성·통과시켜라" 명시.
4. **결과 합칠 때 diff 리뷰** — 에이전트 보고 신뢰하지 말고 실제 변경 파일 Grep/Read로 확인.
5. **컨텍스트 최소화** — 각 에이전트에게는 자신이 만질 파일 경로, 관련 스펙 절, 출력 포맷만 전달.

---

## 환각 방지 가드레일

- 모든 서브에이전트 프롬프트에 **"AIDT 문서 섹션 번호/페이지를 근거로 인용하라. 근거 없는 필드명은 추가하지 마라."** 명시
- 모든 DB 변경은 **기존 건수 sanity check**(before/after COUNT 비교)
- UI 변경은 **기존 저장 payload에 필드를 빼지 말고 추가만** 하라 규칙
- 각 Phase 종료 시점에 **인간이 한 번 눈으로 본다 → 이상 없으면 push**

---

## 진행 상태 추적

각 체크박스 완료 시 이 문서에 `- [x]`로 표시. 별도 이슈 트래커는 사용하지 않음.

- [ ] A0 브랜치·백업
- [ ] A1 엑셀 구조 조사
- [ ] A2 DB 스키마
- [ ] A3 어댑터 × 4 + 드라이버
- [ ] A4 조회 API
- [ ] A5 Phase A 통합 검증
- [ ] B1 공통 유틸
- [ ] B2 빌더 × 10
- [ ] B3 스풀
- [ ] B4 경로 주입
- [ ] B5 Phase B 통합 검증
- [ ] C1 `<std-picker>`
- [ ] C2 `<std-smart-search>` + search API
- [ ] C3 어댑터
- [ ] D1~D6 UI 지점 적용
- [ ] D7 통합 수동 QA
- [ ] E1 배치 송신
- [ ] E2 LRS 대시보드
- [ ] E3 환경 설정
- [ ] F1 E2E
- [ ] F2 회귀
- [ ] F3 문서화
