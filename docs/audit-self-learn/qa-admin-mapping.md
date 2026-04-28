# 관리자 매핑 UI 감리 검수
- 일시: 2026-04-28 12:17 KST
- 감리자: opus (QA 감독)
- 검수 대상: AI 맞춤학습 노드-콘텐츠 매핑 UI
- 대상 파일:
  - 프런트: `public/admin/index.html` (1,532 lines) — section L256-340, JS L962-1518
  - 백엔드: `routes/admin.js` (955 lines) — L248-953
  - 스키마: `db/schema.js` L620-627 (node_contents), L1018-1025 (content_content_nodes)
  - 미들웨어: `middleware/auth.js`
- DB 실측 (data/dacheum.db, 2026-04-28):
  - learning_map_nodes: **1,308** (level=2 단원 146, level=3 차시 1,162)
  - node_contents: **3,272** 매핑 / 고아 0건
  - 매핑된 차시: **1,162 / 1,162 = 100%** (모든 차시에 최소 1건 매핑됨)
  - contents: video 111, quiz 2,506, exam 11, assessment 1, document 14, image 7, package 3
  - contents.status 분포: approved 2,614 · draft 28 · pending 5 · review 3 · rejected 3 · hold 3
  - content_content_nodes: 3,278건 (별개 매핑 — 콘텐츠 ↔ std_id, 학습맵 노드와 무관)

---

## 종합 판정

### 🟡 CONDITIONAL_PASS

핵심 동선(추가/삭제/검색/drill-down/Excel 업로드)은 **모두 동작**하며, level=3 가드·중복 차단·orphan cleanup 등 방어 로직이 잘 갖춰져 있다. 그러나 **(1) `/contents/pickable` API의 status 값 불일치로 사용자 콘텐츠 검색이 0건 반환**, **(2) `node_contents` 테이블의 인덱스 전무**(1,162노드 × 3,272행, GET /nodes 에서 N+1 서브쿼리 풀스캔), **(3) "맵핑을 편리하게" 사용자 요청 기능(일괄/자동/내보내기) 전무**, **(4) 사용자 요청 핵심 가설(`node_contents` ↔ `content_content_nodes` 양방향 일관성)이 스키마 상 존재하지 않음** — 이 4건은 P0/P1 REWORK가 필요하다.

---

## 영역별 검수

### A. 기능 완전성

| 항목 | 결과 | 근거 |
|---|---|---|
| 매핑 추가 (검색 후) | PASS | admin.js L328 POST `/nodes/:nodeId/contents`. level=3 가드(L336), 콘텐츠 존재 검증(L339), 중복 409(L342) |
| 매핑 추가 (ID 직접) | PASS | admin.js L433 by-id. content_type 기반 role 자동(L453-457). UI L1375 |
| 매핑 삭제 | PASS | admin.js L508 DELETE. UI confirm L1481 |
| 매핑 순서 변경 | CONDITIONAL | UI L1493 moveContentOrder — sort_order **두 번 PUT 호출**(L1504/L1509) 비원자적, 중간 실패 시 데이터 꼬임 가능. 트랜잭션 1회 호출 API 권장 |
| 매핑 조회 | PASS | admin.js L300. video/problem/others 분리 응답(L316-318) |
| 노드 검색 (필터) | PASS | admin.js L254. subject/grade/semester/keyword + nodeLevel 처리(UI L1162) |
| 단원→차시 drill-down | PASS | admin.js L363, UI L1238 renderUnitDrilldown. 단원 노드는 직접 매핑 차단 안내 표시 |
| Excel 업로드 — merge | PASS | admin.js L621-868. 단원 해시 ID 자동 생성(L653), 0/1/2/3차 패스 트랜잭션(L705) |
| Excel 업로드 — replace+cascade | PASS | admin.js L706-717. 5개 참조 테이블 일괄 삭제, dry/confirm 2단계 UI L1037-1041 |
| Excel 업로드 — replace 단독 | PASS | cascade=false → 노드/엣지만 삭제, 고아 잔존 인지 가능(stats.orphan_nodes_remaining) |
| 콘텐츠 ID 유효성 검증 | PASS | admin.js L339, L446. 존재하지 않는 ID → 404 자연어 메시지 |
| 삭제된 ID 검증 | N/A — 일관 | contents 테이블에 ON DELETE CASCADE 미설정. node_contents.content_id FK는 있으나(schema L626) ON DELETE 미지정 → 콘텐츠 삭제 시 매핑 잔존 가능 |
| 다른 사용자 콘텐츠 매핑 | INTENTIONAL | admin은 어떤 콘텐츠든 매핑 가능(by-id는 status 무관 L446). public-search는 `is_public=1 AND status='approved'`(L397)로 필터 |
| 고아 데이터 정리 | PASS | admin.js L918 cleanup-orphans. dry_run 우선, 6개 테이블 일관 삭제(L928-945) |

### B. 데이터 정합성

| 항목 | 결과 | 근거 |
|---|---|---|
| 사용자 가설(`node_contents` ↔ `content_content_nodes` 양방향) | **FAIL — 가설 자체 오류** | 두 테이블은 **서로 다른 매핑**: `node_contents(node_id varchar, content_id)` = 학습맵 차시↔콘텐츠 (3,272건), `content_content_nodes(content_id, std_id text)` = 콘텐츠↔표준체계 내용요소 (3,278건). schema.js L620 vs L1018. **양방향 일관성을 적용할 수 없음**(node_id ≠ std_id) |
| 매핑 추가 시 양쪽 테이블 동시 갱신 | INTENTIONAL ABSENT | 위 이유로 동시 갱신은 의미가 없음. 단, **차시 노드의 achievement_code 와 std_id 사이 가교가 부재** — 향후 통합 인덱스 검토 필요 |
| cascade 삭제 양쪽 일관성 | PARTIAL | replace+cascade는 node_contents 삭제(L709), 그러나 content_content_nodes 는 손대지 않음(영역 분리상 정합). cleanup-orphans 도 동일 |
| 학생 화면 즉시 반영 | PASS | admin은 `node_contents` 만 갱신, 학생 드로어(self-learn.js L245+)는 동일 테이블 SELECT — 추가/삭제 즉시 다음 GET 부터 반영. 캐시 없음 |
| 고아 노드/매핑 발생 가능성 | LOW | replace 모드 cascade=false 시만 발생. UI L1074 에 경고 노출 |
| FK 무결성 | WEAK | `node_contents.content_id` FK 있으나 ON DELETE 행위 미지정(schema L626). `node_id` 는 FK 자체 없음 — learning_map_nodes 삭제 시 cleanup-orphans 수동 호출 필요 |

### C. 성능

| 항목 | 결과 | 근거 |
|---|---|---|
| **node_contents 인덱스 부재** | **FAIL** | `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='node_contents'` → **빈 결과**. PK auto만 존재. `WHERE node_id=?` (admin.js L312, L347, L460, L489, L512), `WHERE content_id=?` 모두 풀스캔 |
| GET /nodes 의 N+1 서브쿼리 | FAIL | admin.js L274-278: 페이지당 20행 × 2개 상관 서브쿼리(videos_count, problems_count) = 40회 풀스캔. 1,162 차시 전체 로드 시 2,324회 |
| 단원 drill-down 의 동일 N+1 | FAIL | admin.js L372-376: 단원당 평균 8개 차시 × 3 서브쿼리 = ~24회 |
| 매핑 목록 페이징 | PARTIAL | UI 노드 목록은 page/limit 20 + "더 보기"(L1175). **매핑 상세는 페이징 없음** — 한 차시에 100+ 콘텐츠 매핑 시 일괄 렌더 |
| 가상화/무한스크롤 | NONE | DOM 직삽입(L1216 appendChild). 200개 이상 시 렉 가능 |
| Excel 업로드 트랜잭션 | PASS | better-sqlite3 db.transaction(L705). 1회 트랜잭션 처리 |
| 1,162 차시 + 2,506 quiz + 111 video 일괄 로딩 | N/A — 미측정 | 일괄 로딩 API 없음. 페이지당 20개 로드 — 측정 가능한 회귀는 GET /nodes 응답 시간 |

### D. 권한·보안

| 항목 | 결과 | 근거 |
|---|---|---|
| admin 외 접근 차단 | PASS | 모든 라우트 `...adminOnly` 체인(admin.js L10, L23, L254, L300, L328, …). 401/403 분기(middleware/auth.js L13, L24) |
| 클라이언트측 가드 | PASS | admin/index.html L1521-1525 dacheim:user-loaded 이벤트로 admin 외 redirect |
| CSRF | **FAIL** | CSRF 토큰 미들웨어 부재. `Grep csrf` 결과 0건. Same-origin cookie 의존만 — 관리자 세션 탈취 시 매핑 일괄 변조 가능 |
| XSS — 출력 escape | PASS | admin/index.html L487 escHtml() 일관 사용 (L977, L1208, L1265, L1340 등). 다만 `style.background-image:url('${escHtml(thumb)}')`(L1340, L1445) 는 URL 컨텍스트라 escHtml 만으로 부족 — `javascript:` URL 차단 불가 |
| SQL Injection — 일반 라우트 | PASS | 모든 SQL prepare + ? 바인딩 |
| SQL Injection — Excel 파싱 | PASS | xlsx.utils.sheet_to_json 결과를 named param(@field)으로 바인딩(L666). 파일명 검증(L17 정규식)도 OK |
| 파일 업로드 크기 제한 | PASS | 30MB(L15) |
| 콘텐츠 thumbnail_url 검증 | FAIL | DB 저장값을 그대로 url('...')로 출력 — 악성 admin이 등록한 `javascript:` URL은 escHtml 후에도 `'` escape 만 됨. 단 admin-only 입력이라 영향 제한적 |

### E. 사용자 편의성 ("맵핑을 편리하게" 요청 검토)

| 도구 | 현재 상태 | 영향 |
|---|---|---|
| 단건 매핑 추가 (검색 / ID) | 있음 (L1356-1416) | 1건씩만 — 1,162 차시 × 평균 2.8개 매핑 시 3,272회 클릭 |
| **일괄 매핑 (체크박스 다중 선택 → 한 번에 추가)** | **없음** | P0 — 가장 큰 사용자 요청. 검색 결과에서 row 별 [추가] 버튼만(L1452) |
| **자동 매핑 제안** (제목/태그/achievement_code 매칭) | **없음** | P1 — 콘텐츠 측 achievement_code 와 노드 achievement_code 가 모두 존재(admin.js L267, L416)함에도 자동 연결 없음 |
| **CSV/Excel 매핑 내보내기** | **없음** | P2 — 노드↔콘텐츠 매핑 백업/대량 편집 불가. Excel 업로드는 노드/엣지만 다룸 |
| **매핑 일괄 가져오기** (node_id, content_id 컬럼 Excel) | **없음** | P1 — replace/append 모드의 매핑 버전 |
| 일괄 삭제 (선택한 매핑 다건 제거) | 없음 | P2 — 1건씩 confirm 후 삭제(L1481) |
| 노드 다건 선택 → 동일 콘텐츠 일괄 매핑 | 없음 | P2 |
| 검색 필터 — 매핑된 노드/미매핑 노드만 보기 | **없음** | P1 — 현재 1,162/1,162 100% 매핑이지만 운영 중 누락 발견 어려움 |
| 검색 필터 — 매핑 0건 차시 | 없음 | P1 — 위와 같음 |
| 정렬 — 매핑 수 / 갱신일 | 없음 | P2 (현재 subject/grade/semester/sort_order 고정 ORDER L281) |
| 미리보기 (영상/문항 클릭 시 모달) | **없음** | P1 — 추가 전 콘텐츠 확인 불가, ID만 보고 판단 |
| 키보드 단축키 (다음 노드, 빠른 추가) | 없음 | P3 |
| 진행률/통계 (단원별 매핑 충실도 막대) | 없음 | P2 |

### F. 빈 상태·오류 상태

| 항목 | 결과 | 근거 |
|---|---|---|
| 매핑 0건 노드 안내 | PASS | UI L1330 "매핑된 영상/문항이 없습니다." |
| 노드 검색 0건 | PASS | UI L1187 "결과가 없습니다." |
| 단원 drill-down 자식 0건 | PASS | UI L1256 "이 단원에 등록된 차시가 없습니다." |
| 단원 직접 매핑 차단 안내 | PASS | UI L1246 색상 강조 + 안내문 + 차시 그리드 |
| 콘텐츠 ID 오류 메시지 | PASS | 404/409 한국어 자연어 (UI L1400-1402) |
| 네트워크 오류 | PASS | 모든 fetch try/catch (L1083, L1131, L1180, L1317, L1456) |
| 서버 500 처리 | PARTIAL | data.message 노출하지만 stack 노출 없음. 다만 단순 `alert()` 다용(L1170, L1487) — toast 와 혼재 |
| **`/contents/pickable` 빈 결과 디버그 어려움** | FAIL | admin.js L528 `WHERE c.status = 'published'` 인데 실 데이터에 'published' status는 **0건**(전부 'approved'). 검색 시 항상 0건. UI 측에서는 "조건에 맞는 공개 콘텐츠가 없습니다"만 표시되어 원인 파악 불가. 단, 현재 UI는 `/public-search`만 사용하고 `/pickable`은 호출하지 않음 — **dead route이거나 미래 fallback** |

---

## REWORK 우선순위 매트릭스

| ID | 영역 | 항목 | 심각도 | 노력 | 영향 | 우선순위 |
|---|---|---|---|---|---|---|
| REW-C-001 | 성능 | `node_contents` 인덱스 추가 (`node_id`, `content_id`, `(node_id, sort_order)`) | High | Low | High | **P0** |
| REW-E-001 | UX | 검색 결과 다중선택 → 일괄 매핑 추가 | High | Mid | High | **P0** |
| REW-A-001 | 기능 | 매핑 순서 변경 원자화 (단일 트랜잭션 PUT, swap-pair API) | Mid | Low | Mid | **P0** |
| REW-D-001 | 보안 | CSRF 토큰 미들웨어 도입 (admin 변이 라우트 전체) | High | Mid | Mid | **P1** |
| REW-C-002 | 성능 | GET /nodes 의 videos_count/problems_count 서브쿼리 → LEFT JOIN + GROUP BY 또는 캐시 컬럼 | Mid | Mid | High | **P1** |
| REW-E-002 | UX | 자동 매핑 제안 (achievement_code 매칭 → 후보 추천) | High | High | High | **P1** |
| REW-E-003 | UX | 매핑 CSV/Excel 내보내기·가져오기 | Mid | Mid | High | **P1** |
| REW-E-004 | UX | 미매핑 차시 / 매핑 0건 / 영상만/문항만 부족 필터 | Mid | Low | Mid | **P1** |
| REW-E-005 | UX | 콘텐츠 미리보기 모달 (추가 전 확인) | Mid | Mid | Mid | **P1** |
| REW-A-002 | 기능 | `/contents/pickable` status='published' → 'approved' 또는 라우트 제거 | Mid | Low | Low | **P2** |
| REW-B-001 | 정합성 | `node_contents.node_id` FK + `node_contents.content_id ON DELETE CASCADE` 추가 | Mid | Mid | Mid | **P2** |
| REW-D-002 | 보안 | thumbnail_url URL 컨텍스트 화이트리스트(http(s)/data:image only) | Low | Low | Low | **P2** |
| REW-E-006 | UX | 매핑 다건 선택 → 일괄 삭제 | Low | Low | Mid | **P2** |
| REW-C-003 | 성능 | 매핑 상세 100건+ 가상화 | Low | Mid | Low | **P3** |
| REW-F-001 | 오류 | alert() → 통일된 toast/모달 + 에러코드 노출 | Low | Mid | Low | **P3** |
| REW-B-002 | 정합성(가설) | `node_contents` ↔ `content_content_nodes` 통합 인덱스 (achievement_code → std_id 매핑) | Mid | High | Mid | **P3** |

총 16건. **P0 3건, P1 5건, P2 4건, P3 3건, 기타 1건**

---

## 핵심 발견 Top 5

### 1. `node_contents` 테이블 인덱스 전무 (REW-C-001)
- `sqlite_master`에 인덱스 0건. 1,162 노드 × 3,272 매핑 풀스캔.
- admin.js L312, L347, L460, L489, L512 등 모든 액세스 패턴이 `node_id` 기반.
- **즉시 수정 가능** — `CREATE INDEX idx_nc_node ON node_contents(node_id, sort_order); CREATE INDEX idx_nc_content ON node_contents(content_id);` 한 번 실행으로 전체 매핑 UI 응답시간 5-10x 개선 예상.

### 2. "맵핑을 편리하게" 사용자 요청 미반영 — 일괄 작업 도구 부재 (REW-E-001/002/003)
- 사용자가 명시적으로 "편리하게" 요청한 핵심 시나리오:
  - 검색 결과 다중 선택 → 일괄 추가: **없음**
  - achievement_code 자동 매칭 제안: **없음** (양쪽 모두 코드를 보유함에도)
  - Excel 매핑 가져오기/내보내기: **없음** (학습맵 노드/엣지만 있음)
- 현재 동선으로 1,162 차시에 평균 2.8건 매핑 시 **3,272회 단건 클릭**.

### 3. 사용자 가설(`node_contents` ↔ `content_content_nodes` 양방향 일관성)은 스키마 상 불성립
- `node_contents`는 **학습맵 노드(node_id varchar, U-prefix 또는 E/M/H prefix)** ↔ 콘텐츠 (3,272건)
- `content_content_nodes`는 **콘텐츠 ↔ 표준체계 std_id** (3,278건, schema.js L1018)
- 두 테이블은 서로 다른 분류 체계로, 직접 양방향 동기화는 부적절.
- **PM 확인 필요**: 사용자가 의도한 "양방향"이 (a) 가교 인덱스 신설인지 (b) 두 테이블 통합 리팩터인지 (c) 단순 오해인지.

### 4. CSRF 보호 부재 (REW-D-001)
- 변이 엔드포인트(POST/PUT/DELETE) 30+개 모두 **세션 쿠키 단독 의존**.
- `Grep csrf` 0건. helmet/express-rate-limit 도 미적용.
- 관리자가 외부 사이트 방문 시 매핑 일괄 변조 가능 (low likelihood, high impact).

### 5. `/contents/pickable` 라우트의 status 값 불일치 (REW-A-002)
- admin.js L528 `WHERE c.status = 'published'` ← 실제 DB는 `'approved'` 2,614건, `'published'` **0건**.
- 다행히 현재 UI는 `/public-search`(L391, status='approved' OK)만 호출 — pickable은 dead route.
- 그러나 `/pickable`을 미래 사용 시 항상 빈 결과. 제거 또는 수정 필요.

---

## PM 권고

### 즉시 처리 (이번 사이클, 1-2일)
- **REW-C-001 인덱스 추가** — 5분 작업, 영향 최대. 마이그레이션 스크립트 1줄.
- **REW-A-001 매핑 순서 swap API 원자화** — 현재 두 번 PUT 호출 중간 실패 시 순서 꼬임. 단일 트랜잭션 엔드포인트 신설 또는 sort_order 일괄 PATCH.
- **REW-A-002 pickable status 정정 또는 dead route 제거**.

### 다음 사이클 (1주)
- **REW-E-001 일괄 매핑 추가 UI** — 검색 결과 체크박스 + "선택한 N개 추가" 버튼. 백엔드는 기존 POST를 N회 호출하거나 배열 body 받는 신규 엔드포인트.
- **REW-E-004 미매핑/0건 필터** — 백엔드 한 줄 LEFT JOIN.
- **REW-D-001 CSRF** — `csurf` 패키지 + admin 폼 토큰 헤더화.
- **REW-C-002 N+1 제거** — 단일 GROUP BY 쿼리 또는 매핑 수 caching column 추가 후 트리거 갱신.

### 중기 (2-4주)
- **REW-E-002 자동 매핑 제안** — `learning_map_nodes.achievement_code` ↔ `contents.achievement_code` 정확 일치 → 후보 리스트. Top 5 자동 + 1-click 일괄 채택.
- **REW-E-003 매핑 Excel 가져오기/내보내기** — 운영 백업 + 외부 협업 가능.
- **REW-E-005 미리보기 모달** — `/api/contents/:id/preview` 신설 또는 기존 라우트 재사용.

### 장기 / 정책 결정 필요
- **REW-B-002** `node_contents` ↔ `content_content_nodes` 통합 정책 — 사용자 의도 확인 후 가교 테이블 설계 또는 std_id를 learning_map_nodes에 컬럼 추가.
- **REW-B-001** FK ON DELETE CASCADE 도입 — 마이그레이션 시 기존 고아 정리 후 진행.

### 검수 결론
현재 상태로 **운영 투입은 가능**하나, 사용자가 표현한 "맵핑을 편리하게"의 핵심 가치(일괄/자동/내보내기)가 누락되어 **사용자 만족도는 낮을 것**으로 예상. P0 3건과 P1의 REW-E-001(일괄 매핑) 만이라도 다음 릴리스에 포함하면 운영 시간 50% 이상 단축이 가능하다고 판단함.

---
- 감리 종료: 2026-04-28
- 다음 검수 권고일: P0/P1 처리 후 회귀 검수 (예상 2026-05-12 이후)
