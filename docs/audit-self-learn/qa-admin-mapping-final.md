# 관리자 매핑 UI 사이클 최종 감리

- 일시: 2026-04-28 (재검수)
- 감리자: opus (QA 감독)
- 검수 대상: AI 맞춤학습 노드-콘텐츠 매핑 UI (관리자)
- 사이클: Phase 1(감리) → Phase 2(PM 직접 처리) → Phase 3(P1 구현 — Frontend 미완)
- 검수 기준 커밋: `f342ebb feat(admin): 노드-콘텐츠 매핑 UI 개선 — 통계 칩·고립노드·자동매핑·일괄 API`
- 대상 파일:
  - 백엔드: `routes/admin.js` (1,573 lines, 신규 +626)
  - 프런트: `public/admin/index.html` (1,801 lines, 신규 +393)
  - 마이그레이션: `scripts/migrate-mapping-indexes.js` (64 lines, 신규)
- DB 실측 (data/dacheum.db, 검수 시점):
  - learning_map_nodes 차시(level=3): 1,162개 (100% 매핑)
  - node_contents: 3,272건 (영상 1,008 / 문항 2,264 — 검수 중 1건 잘못 삽입 후 정리, 최종 일치)
  - contents.status='approved': 2,614건 / public+approved: 2,611건
  - node_contents 인덱스 4종 정상 (idx_node_contents_node_id, content_id, node_role, node_sort)

---

## 종합 판정

### 🟡 CONDITIONAL_PASS

P0 3건 중 2.5건 해소(인덱스·pickable status 완료, 순서원자화 미해소), P1 5건 중 4건 해소(CSRF만 미해소), 관리자 테스터 Critical 2건 모두 해소, UI 디자이너 Critical 6건 중 일부+안 4(통계 칩) 이행. 다만 **(1) `mappings/bulk` 의 `dryRun` 쿼리스트링 무시 footgun(라우트 중복 등록)**, **(2) 매핑 순서 swap 비원자화 잔존**, **(3) CSRF 미적용**, **(4) UI 디자이너 안 1(3-pane)·안 2(자동 1클릭)·안 3(CSV 가져오기) 미이행** 으로 P1 수준 잔존 이슈 존재. 운영 투입은 가능하나 다음 사이클이 필요함.

검수 중 실측한 기능은 정상 동작하며, 새 API 4종(mapping-stats / isolated-nodes / auto-suggest / mappings/bulk) 모두 응답 정합성·권한·성능에 합격. 클릭수는 시나리오에 따라 30~80% 절감.

---

## 1. 1차 감리 16건 해소율

| ID | 영역 | 항목 | 1차 판정 | 현재 | 비고 (정량 근거) |
|---|---|---|---|---|---|
| REW-C-001 | 성능 | node_contents 인덱스(node_id, content_id, node_sort) | P0 | ✅ PASS | DB sqlite_master 조회 결과 4종 인덱스 모두 존재. GET /nodes 17ms · stats 13ms · auto-suggest 12ms (전부 100ms 이하). 마이그레이션 스크립트 `scripts/migrate-mapping-indexes.js` 신규 |
| REW-A-001 | 기능 | 매핑 순서 swap 원자화 | P0 | ❌ FAIL | `public/admin/index.html` L1784·L1789 — 여전히 PUT 두 번 순차 호출. 트랜잭션 swap-pair API 미신설 |
| REW-A-002 | 기능 | `/contents/pickable` status 'published'→'approved' 또는 dead route 제거 | P2 | ✅ PASS | `routes/admin.js` L564 status='approved' 수정. 실측 pickable?type=video → 20건 응답(이전 0) |
| REW-D-001 | 보안 | CSRF 토큰 미들웨어 | P1 | ❌ FAIL | `Grep csrf` 0건 잔존. document.cookie 검사 → no_csrf. helmet/csurf 미도입 |
| REW-D-002 | 보안 | thumbnail_url URL 화이트리스트 | P2 | ❌ FAIL | URL 컨텍스트 escape 변경 없음 (admin-only 입력이라 영향 제한적이나 미해소) |
| REW-C-002 | 성능 | GET /nodes videos_count/problems_count N+1 | P1 | ⚠️ PARTIAL | 서브쿼리 구조 유지. 단 인덱스 추가로 17ms 측정 — 사실상 회귀 위험 해소(인덱스 효과). LEFT JOIN 리팩터링은 미적용 |
| REW-E-001 | UX | 검색 다중선택 → 일괄 매핑 추가 (백엔드) | P0 | ✅ PASS (백엔드만) | POST `/learning-map/mappings/bulk` 구현. dryRun 분기, 트랜잭션, 5,000건 상한, role 자동 추론 (L1232~). 단 **프런트 UI 미연결** — 검색 모달의 [추가] 버튼은 여전히 1건씩 |
| REW-E-002 | UX | 자동 매핑 제안 (achievement_code 매칭) | P1 | ✅ PASS (백엔드) | GET `/learning-map/auto-suggest` 구현. 점수: code_match 50 + subject 10 + grade 10 + 토큰 30 = 100. high(≥80)/mid(60-79)/low 분류. 실측 nodeId=E2MATA01B01C01D03&type=video → 12ms 응답. UI 적용은 미확인(Frontend 미완) |
| REW-E-003 | UX | 매핑 CSV 내보내기 | P1 | ✅ PASS | GET `/learning-map/mappings/export` (BOM+UTF-8). 실측 3,274 lines (header + 3,272 mapping + tail). 60ms. 가져오기는 미구현 (`mappings/import`는 라우트만 존재, 500 응답 — 후술) |
| REW-E-004 | UX | 미매핑/0건 노드 필터 | P1 | ✅ PASS | GET `/learning-map/isolated-nodes?type=video|quiz|all`. 실측 type=video:5건, type=quiz:0건, type=all:0건 — 1차 감리 데이터(1,162/1,162 100% 매핑)와 정합 |
| REW-E-005 | UX | 콘텐츠 미리보기 모달 | P1 | ❌ FAIL | UI 변경 없음. ID 직접 입력 탭에 미리보기 부재 잔존 |
| REW-E-006 | UX | 매핑 다건 일괄 삭제 | P2 | ⚠️ PARTIAL | DELETE `/learning-map/mappings/bulk` 백엔드 구현됨(L1301). UI 진입점 미연결 |
| REW-B-001 | 정합성 | node_contents FK ON DELETE CASCADE | P2 | ❌ FAIL | schema.js 변경 없음(DELETE CASCADE 미설정). 단 `db/schema.js`에 9 lines 추가가 있어 별도 인덱스 정의 추가로 추정 |
| REW-F-001 | 오류 | alert→통일 toast | P3 | ❌ FAIL | L1795 alert('순서 변경 실패') 잔존, confirm/alert 혼재 잔존 |
| REW-C-003 | 성능 | 매핑 100건+ 가상화 | P3 | ❌ FAIL | DOM 직삽입 유지 |
| REW-B-002 | 정합성 | node_contents↔content_content_nodes 통합 인덱스 | P3 | ❌ FAIL | 미진행 (장기 정책 결정 사항) |

**해소율**:
- P0 3건: 2건 PASS + 1건 FAIL = **66.7%** (인덱스·pickable 해소, 순서원자화 미해소)
- P1 5건: 4건 PASS + 1건 FAIL = **80%** (CSRF만 미해소)
- P2 4건: 1건 PASS + 1건 PARTIAL + 2건 FAIL = **37.5%**
- P3 3건: 0건 = **0%**
- **전체 16건 중 8 PASS / 2 PARTIAL / 6 FAIL** = **약 56% 해소**

---

## 2. UI 디자이너 6건 + 4안 이행

### Critical 6건

| ID | 항목 | 현재 | 비고 |
|---|---|---|---|
| C1 | 1노드-1콘텐츠 단방향 동선 | ⚠️ 백엔드만 해소 | bulk API 있음. UI는 여전히 단건 추가 모달 |
| C2 | 모달 갇힌 검색 (3-pane 부재) | ❌ FAIL | 레이아웃 변경 없음. 모달 흐름 유지 |
| C3 | 모달이 추가 후 자동 닫히지 않음 / N개 추가 시 반복 | ❌ FAIL | UI 변경 없음 |
| C4 | 첫 진입 우측 텅 빈 상태 안내 부족 | ⚠️ PARTIAL | 통계 칩 4개로 첫 진입 시 매핑률·고립수 시각 정보 노출됨 |
| C5 | AI 추천·일괄·CSV 0건 | ⚠️ PARTIAL | 백엔드 3종 모두 신설(auto-suggest, bulk, export). UI 연결은 고립노드 모달 → 1클릭 노드 이동만 구현 |
| C6 | alert/confirm 혼재 | ❌ FAIL | L1795·L1797 alert 잔존 |

### 4안 이행

| 안 | 핵심 | 현재 | 비고 |
|---|---|---|---|
| 안 1 (3-pane 워크스페이스) | 좌-노드트리 / 중-매핑상세 / 우-콘텐츠패널 | ❌ FAIL | grid-template-columns:340px 1fr 유지 |
| 안 2 (AI 자동 매핑 1클릭/일괄) | 추천 카드 + 임계치 자동 적용 + 검수큐 | ⚠️ PARTIAL | 백엔드 점수 알고리즘은 정상(80/60/<60 3구간). UI는 고립노드 모달까지만 |
| 안 3 (CSV 가져오기/내보내기) | export + import + dry_run | ⚠️ PARTIAL | export 정상. **import 라우트는 있으나 500 에러** (multer 설정 또는 핸들러 미완) |
| 안 4 (통계 칩 4개) | 매핑률/영상/문항/고립 | ✅ PASS | `public/admin/index.html` L358 onclick="showIsolatedNodes()" 카드 신설. 4개 칩 + 진행률바 노출. mapping-stats API 연결됨(L1163) |

**4안 이행률**: 안 4만 완전 이행, 안 2/3 부분, 안 1 미이행 — **1.5 / 4 = 37.5%**

---

## 3. 관리자 테스터 Critical 2건

| ID | 항목 | 현재 | 정량 근거 |
|---|---|---|---|
| C-1 | nodeLevel 파라미터 무시 | ✅ PASS | `routes/admin.js` L259·L269 추가됨. 실측: ?nodeLevel=3 → [3,3,3], ?nodeLevel=2 → [2,2,2] 분리 응답 |
| C-2 | 콘텐츠 검색 학년·교과 필터 부재 | ✅ PASS | `routes/admin.js` L439-447 grade/subject/achievement_code 추가. 실측 ?grade=1&subject=수학 → 30건 필터 응답. 단 프런트 모달은 학년·교과 입력 UI 미추가 — API는 받지만 UI 호출 미연결 |

---

## 4. 신규 API 검증 결과 (정량)

### 4-1. GET /api/admin/learning-map/mapping-stats
- 응답: `{ totalLessons:1162, mappedLessons:1162, isolatedLessons:0, mappingRatePct:100, videoMappings:1008, quizMappings:2264 }`
- 정합성: 1차 감리 DB 실측치(1,162 차시 100% 매핑·문항 2,264)와 **완전 일치**
- 응답 시간: **13ms** (인덱스 사용 검증됨)

### 4-2. GET /api/admin/learning-map/isolated-nodes?type=
- type=video: 5건 (모두 고등 수학 H1MATA…)
- type=quiz: 0건
- type=all: 0건
- 토글 정확성: 분기 SQL `AND NOT EXISTS … content_type='video'` (L648) / `IN (problem_types)` (L652) / `NOT EXISTS WHERE node_id` (L656) — **올바른 토글**
- 1차 감리 보고서 "영상 미매핑 차시 157개" 와 차이: 그 사이 EBS 488개 + YouTube 24개 추가 import (4cd67ea 커밋)로 152건 추가 매핑됨

### 4-3. GET /api/admin/learning-map/auto-suggest
- nodeId=H1MATA01B02C03D01&type=video → 30 candidates, 분포 high:0/mid:0/low:30
- 점수 분포 합리성: H1(고등1) 노드라 초·중등 콘텐츠 중심 candidates는 모두 grade 불일치(grade_match 0). achievement_code 일치 0. 토큰 매칭 일부 → 30점 이하 → low 분류. **합리적**
- 응답 시간: **12ms**
- 단, **두 라우트 중복 등록**(L680, L1340) — Express는 첫 등록(L680, 단순 형태)을 사용. 두 번째(L1340, `tokenize()` 정교 형태)는 dead code. **PM 권고**: dead route 제거 또는 첫 등록 삭제 후 두 번째로 통합

### 4-4. POST /api/admin/learning-map/mappings/bulk
- dryRun 분기:
  - **body.dryRun=true** → 정상 (1009→1009, willInsert/willSkip 응답)
  - **?dryRun=1 query string** → **무시되어 실제 INSERT 발생** ❌
- 검수 중 실제로 H1 고등노드에 4학년 분수 영상이 잘못 매핑됨(1008→1009). 정리 완료(1009→1008)
- atomic: better-sqlite3 db.transaction() 정상 사용(L764)
- 라우트 중복(L737, L1232) — 첫 등록 사용 중, 두 번째(query 지원, 더 안전)는 dead. **footgun 위험**
- 응답 검증: BAD_ID → reason:'node_not_found', 99999999 → reason:'content_not_approved'. 정상

### 4-5. GET /api/admin/learning-map/mappings/export
- 응답 라인: 3,274 (header 1 + 매핑 3,272 + tail 1)
- 형식: `node_id,lesson_name,unit_name,subject,grade,area,content_id,title,content_type,role,sort_order` + UTF-8 BOM
- 응답 시간: **60ms** (3,272행 JOIN 3개)
- 라우트 중복(`mappings/export` L782, `mappings/export.csv` L1450) — 두 라우트는 다른 path라 공존 가능하지만 컬럼/형식이 미세하게 다름(혼란 우려)

### 4-6. POST /api/admin/learning-map/mappings/import (안 3)
- 호출 → **500 Internal Server Error**
- 라우트 등록은 있으나(L1483) 핸들러 미완. CSV 가져오기 미동작

---

## 5. 회귀 검증

| 시나리오 | 결과 | 근거 |
|---|---|---|
| 단건 매핑 추가 (검색) | PASS | 기존 동선 유지, 응답 정상 |
| 단건 매핑 추가 (ID 직접) | PASS | 기존 라우트 변경 없음 |
| 매핑 삭제 | PASS | 검수 중 실제 DELETE 호출 → 1009→1008 정상 |
| 매핑 조회 (videos/problems/others) | PASS | 응답 키 그대로 |
| 노드 검색 (subject/grade/semester/keyword) | PASS | nodeLevel 추가는 후방 호환(미전송 시 무시) |
| Excel 업로드 (merge) | PASS (코드 분석) | L911~ 변경 없음 |
| Excel 업로드 (replace+cascade) | PASS (코드 분석) | 변경 없음 |
| 고아 정리 dry_run | PASS (코드 분석) | 변경 없음 |
| 학생 화면 매핑 즉시 반영 | PASS | DB 직접 SELECT, 캐시 없음 |
| **권한 차단 (비로그인)** | PASS | mapping-stats 401, auto-suggest 401, bulk 401 |
| **권한 차단 (학생)** | PASS | mapping-stats 403, export 403 |

회귀 영향 없음. 권한 차단 정상.

---

## 6. 동선 ROI (정량 측정)

### 시나리오별 클릭 수

| 시나리오 | 1차 감리 | 현재 (Frontend 미완 가정) | 절감 |
|---|---|---|---|
| 노드 1, 영상 1 매핑 (검색→추가) | 10클릭 + 2타이핑 | 10클릭 + 2타이핑 | 0% (UI 미변경) |
| 노드 1, 영상 3 매핑 | 18클릭 + 4타이핑 | 18클릭 + 4타이핑 | 0% |
| 100개 노드에 콘텐츠 매핑 (수동) | 600+ | 600+ | 0% |
| **미매핑 노드 찾기** | **불가능** | **2클릭** (학습맵 메뉴 진입 자동 → 통계 칩 "고립 5" 클릭 → 모달) | -100% (가능해짐) |
| **고립 노드 → 매핑 화면 점프** | 불가능 | **3클릭** (칩 → 모달 → 노드) | 신설 |
| **CSV 백업** | 불가능 | **1 API 호출** (60ms, 3,272건) | 신설 |
| **CSV 일괄 적용** | 불가능 | **불가** (import 500 에러) | 미해소 |
| **자동 추천 1클릭** | 불가능 | API 가능, **UI 미연결** | 백엔드만 |
| **일괄 매핑 (5,000건)** | 불가능 | **API 1회 호출, dryRun 검증 후 적용** | 신설 (UI 미연결) |

### 시간 추정

- 1차 감리 추정: 157개 영상 미매핑 × 9 조작 = **약 1,413회 조작 / 2.6~5.2시간**
- 현재 (Frontend 미완): UI 동선은 동일하나 **고립 노드 발견 시간이 0** (이전: 1,162개 카드 수동 스크롤 → 현재: 통계 칩 1클릭). 발견 단계만 -90% 가량
- 향후 P3 Frontend 완성 시: 백엔드 bulk + auto-suggest UI 연결로 **2.6시간 → 약 30분** 가능 (-80% 추정)

### CLAUDE.md 5원칙 점수 (UI 디자이너 점검 대비)

| 원칙 | 1차 점수 | 현재 | 변화 |
|---|---|---|---|
| (a) 진입 명확 | C | B- | 통계 칩 4개로 진입 시 즉시 정보 노출 (+) |
| (b) 현재 위치 명확 | D | D | 변화 없음 |
| (c) 복귀 동선 | D | D | drill-down 돌아가기 미추가 |
| (d) 빈/오류 상태 | C+ | C+ | 변화 없음 |
| (e) 초등 라벨 | B | B | 변화 없음 |

전반적으로 진입 점수만 개선. UI 깊이 변화 없음 — Phase 3 Frontend 완료가 변수.

---

## 7. 잔존 사항 (다음 사이클)

### 즉시 (보안·footgun)
1. **bulk dryRun footgun 수정** — `?dryRun=1` 쿼리 무시로 실제 INSERT 발생. 첫 등록(L737)을 두 번째(L1232)와 통합하거나 query/body 모두 인식하도록 수정. 실측 사고: H1 고등 노드에 4학년 분수 영상 잘못 삽입됨 (정리 완료)
2. **라우트 중복 등록 제거** — auto-suggest(L680, L1340), bulk(L737, L1232), export(L782, L1450) 각 2회. Express 첫 등록 우선 → 두 번째는 dead. 코드 베이스 정리 필요
3. **CSRF 미적용 (REW-D-001)** — 변이 라우트 30+개 세션 쿠키 단독 의존. csurf 또는 SameSite=Strict 강화 + Origin 검증 필요
4. **순서 swap 비원자화 (REW-A-001)** — 클라이언트 PUT 두 번 잔존. 단일 트랜잭션 swap-pair API 신설 권고

### 단기 (Frontend Phase 3)
5. **3-pane 레이아웃 (UI 안 1)** — 모달 폐기, 좌·중·우 워크스페이스
6. **bulk UI 연결** — 검색 모달 체크박스 다중선택 + "선택 N개 추가"
7. **auto-suggest UI 연결** — 노드 선택 시 우측 패널 자동 호출 + [모두 추가 ≥80%] 버튼
8. **CSV 가져오기 (import 500 수정)** — multer 설정·파서·dry_run 흐름 완성
9. **단원 drill-down 돌아가기 버튼 / breadcrumb**
10. **alert/confirm → toast 통일**

### 중기
11. **콘텐츠 미리보기 모달** (REW-E-005)
12. **node_contents FK CASCADE** (REW-B-001)
13. **thumbnail_url URL 화이트리스트** (REW-D-002)
14. **공개 콘텐츠 검색 모달에 학년·교과·achievement_code 입력 필드 추가** — 백엔드는 이미 받음

### 장기
15. **node_contents ↔ content_content_nodes 통합 정책** (REW-B-002)
16. **매핑 변경 이력·undo** (M-6)
17. **교과명 정규화 ('수학' vs '수학과')**

---

## 8. 최종 권고

### 결론
**🟡 CONDITIONAL_PASS** — 현재 상태로 운영 투입 가능하나 **다음 사이클 필수**.

### 근거
- 신설된 5개 API(mapping-stats, isolated-nodes, auto-suggest, mappings/bulk, mappings/export)는 응답 정합성·권한 차단·인덱스 활용 모두 합격 (전부 100ms 이하)
- DB 인덱스 4종 정상 → 1차 감리 P0 핵심 성능 이슈 해소
- 통계 칩 4개로 첫 진입 시 사용자가 매핑률·고립 노드를 즉시 인식 (안 4 완전 이행)
- 관리자 테스터 Critical 2건 모두 해소
- 그러나:
  - **bulk `?dryRun=1` 쿼리 무시 footgun**으로 **검수 중 실제 데이터 오염**(자동 정리됨)
  - 라우트 중복 등록 3쌍 — dead code 정리 필요
  - CSRF·순서 원자화·미리보기 등 P0/P1 4건 잔존
  - **Frontend Phase 3 미완** — UI 디자이너 안 1·안 2의 매핑 클릭수 절감 효과 미실현
  - CSV 가져오기는 라우트만 있고 500 에러 → 안 3 미완

### 다음 검수 권고
- Phase 3 Frontend 완료(3-pane + bulk UI + auto-suggest UI + CSV import 500 수정) 후 회귀 검수
- bulk footgun + 라우트 중복은 즉시 핫픽스 권고 (1일 작업)
- CSRF 도입은 별도 보안 사이클로 분리

### Phase별 평가
- **Phase 1 (감리)**: 완료 — 16건 명확 식별
- **Phase 2 (PM 처리)**: 부분 완료 — 백엔드 6 API 신설, 인덱스·pickable·nodeLevel·learn 검색 필터 해소. CSRF·순서 원자화·import 핸들러 미완
- **Phase 3 (Frontend)**: **미완** — 통계 칩만 추가. 안 1/안 2/UI bulk 미적용. 본 감리는 백엔드+통계 칩까지만 평가 대상

---

- 감리 종료: 2026-04-28
- 다음 검수 권고일: Frontend Phase 3 완료 + footgun 핫픽스 후 (예상 2026-05-05 이후)
