# 교육과정 표준체계 · AIDT xAPI 학습분석 시스템

Phase A–F 통합 문서. 2022 개정 교육과정 표준체계를 전 학습 활동에 적용하고 AIDT 규격 xAPI statement를 로컬 수집하여 LRS 학습분석 대시보드에서 시각화한다.

## 아키텍처 한눈에

```
┌────────────────────────────────────────────────────────────────┐
│ [Phase A] 교육과정 표준체계 데이터 기반                           │
│   curriculum_subjects / curriculum_standards                    │
│   curriculum_content_nodes (트리) + curriculum_node_descendants │
│   curriculum_std_id_map (code ↔ std_id 양방향)                  │
│   curriculum_standard_levels (A~E 성취수준)                     │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────────────────────┐
│ [Phase C/D] 재사용 Web Components (UI)                          │
│   <std-smart-search>  : 성취기준 자동완성 검색                  │
│   <std-picker>        : 학교급→교과→학년군→영역 드릴다운       │
│   common-nav.js 자동 로드 → 전 페이지에서 사용 가능             │
└───────────────────┬─────────────────────────────────────────────┘
                    │ 학습 활동 (콘텐츠 풀이/숙제/평가/차시/자기주도)
                    ▼
┌────────────────────────────────────────────────────────────────┐
│ [Phase B] AIDT xAPI 수집 파이프라인 (10 영역)                   │
│   lib/xapi/builders/{media,assessment,assignment,navigation,    │
│     objective,query,social,survey,annotation,teaching}.js       │
│   lib/xapi/std-resolver.js (code ↔ std_id 양방향 해결)          │
│   lib/xapi/spool.js (xapi_statement_spool 에 denormalized 저장) │
│   routes/{content,exam,homework,lesson,self-learn,growth}.js    │
│   ─ try/catch 로 감싸 원 기능을 절대 방해하지 않음              │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────────────────────┐
│ [Phase E] LRS 학습분석 대시보드                                 │
│   routes/lrs.js: /api/lrs/xapi/{overview,std-heatmap,           │
│     achievement-distribution,area-breakdown,recent-events}      │
│   public/lrs/index.html: 학생/교사/관리자 scope별 분석 뷰        │
│   _xapiScopeUserIds() : me / class:N / school 권한 격리         │
└────────────────────────────────────────────────────────────────┘
```

## Phase별 요약

### A. 교육과정 표준체계 데이터 (commit `d78b9f5`)

- KICE 2022 개정 교육과정 데이터 적재
- 양방향 식별자: 성취기준 코드 `[4국01-01]` ↔ 표준체계 ID `E4KORA01B01C01`
- 성취수준: 초 A~C(80%/60%), 중고 A~E(90%/80%/70%/60%)

### B. AIDT xAPI 10 영역 빌더 (commit `420c427`)

- 10개 데이터 영역 빌더가 모두 동일한 시그니처: `build<Area>(ctx, payload) → {statement, meta}`
- 공통 확장: `curriculum-standard-id`, `achievement-code`, `achievement-standard`
- Router 주입 지점 (try/catch 보호):
  - `POST /api/contents/:id/attempts` → assessment.submitted
  - `GET /api/contents` → query.searched
  - `POST /api/exam/:classId/:examId/submit` → assessment.submitted
  - `POST /api/homework/:classId` / submit / grade → assignment.gave / finished
  - `POST /api/lesson/:classId/:lessonId/progress` → navigation + media
  - `POST /api/self-learn/...` → navigation / annotation / assessment
  - `POST /api/growth/emotion-checkin` → survey.submitted

### C. Web Components (commit `e652b6a`)

- `<std-smart-search>` — Shadow DOM, 키워드/코드 자동완성, 다중/단일 선택, 키보드 네비게이션
- `<std-picker>` — 학교급→교과→학년군→영역 계층 드릴, node/standard 2모드
- 테스트 페이지: `/js/components/test.html`

### D. 전역 자동 로드 (commit `5d7e59c`)

- `common-nav.js`에 `loadStdComponents()` IIFE 추가
- 공통 네비게이션을 쓰는 모든 페이지에서 별도 `<script>` 없이 컴포넌트 사용 가능

### E. LRS 학습분석 (commit `ceeae59`)

- 5개 엔드포인트로 대시보드 구성:
  - `overview` — 총/sent/unsent/24h/7d + 영역별 카운트
  - `std-heatmap` — 표준체계 노드별 통계 Top 200 (정답률 색상 코딩)
  - `achievement-distribution` — A~E 성취수준 분포 + 교과별 breakdown
  - `area-breakdown` — 일자별 영역별 추이 (max 90일)
  - `recent-events` — 사용자 display_name 조인, 최근 200건
- Scope: 학생=me, 교사=class:N, 관리자=school (권한 enforced in helper `_xapiScopeUserIds`)

### F. 최종 E2E 검증

라이브 E2E (이 문서 작성 시 검증됨):

1. `POST /api/growth/emotion-checkin` → `xapi_statement_spool` 1행 (survey/submitted) ✓
2. `GET /api/contents?type=quiz` → spool 1행 (query/searched) ✓
3. `POST /api/contents/195/attempts` → spool 1행 (assessment/submitted, primary_std_id=`M3MATA01B01C01` from `9수01-01`) ✓
4. `GET /api/lrs/xapi/overview?scope=school` → `total: 3, byArea: [assessment, query, survey]` ✓

## 알려진 제한사항

1. `content.subject` 필드는 한국어 표기(`수학`)를 담는 경우가 있어 `xxx-e` 접미사로 `school_level`을 추출하는 로직이 실패 → `achievement_level: null`. 향후 개선 필요.
2. 기존 인라인 성취기준 UI(`content/index.html`, `class/class-home.html`, `class/lesson-create.html`, `class/lesson-player.html`, `self-learn/problem-sets.html`)는 주변 상태와 긴밀히 결합되어 있어 본 리팩터링에서 유지. 신규 개발부터 Web Components 우선.
3. 현재 xAPI statement는 로컬 spool만 적재. 외부 LRS로의 전송(sent 카운트)은 후속 작업.

## 주요 파일 인덱스

| 파일 | 역할 |
|------|------|
| `db/migrations/*curriculum*.sql` | Phase A 스키마 |
| `lib/xapi/builders/*.js` | Phase B 10개 영역 빌더 |
| `lib/xapi/std-resolver.js` | 양방향 식별자 해결 |
| `lib/xapi/spool.js` | 로컬 수집 큐 |
| `public/js/components/std-smart-search.js` | Phase C 검색 컴포넌트 |
| `public/js/components/std-picker.js` | Phase C 드릴다운 컴포넌트 |
| `public/js/common-nav.js` | Phase D 자동 로드 |
| `routes/lrs.js` | Phase E xAPI 엔드포인트 |
| `public/lrs/index.html` | Phase E 대시보드 UI |

## 커밋 이력 (`feat/curriculum-std-aidt`)

```
d78b9f5 Phase A — 교육과정 표준체계 적재 기반 구축
420c427 Phase B — AIDT xAPI 로컬 수집 파이프라인
ceeae59 Phase E — xAPI 표준체계 분석 대시보드
e652b6a Phase C — 교육과정 표준체계 Web Components
5d7e59c Phase D — 표준체계 컴포넌트 전역 자동 로드
(Phase F — 최종 E2E 검증 + 본 문서)
```
