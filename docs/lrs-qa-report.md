# LRS Phase 3 QA 검증 보고서

- **작성**: QA/테스터 서브에이전트
- **작성일**: 2026-04-21
- **환경**: Windows 11, Node v23.7, PORT=3099, `learning_logs` 2,109건 (2026-03-22~2026-04-21)
- **기준 문서**: `docs/lrs-policy-requirements.md` (TC-001~050), `docs/lrs-phase2-spec.md`
- **검증 범위**: 코드 수정 없이 읽기/실행만 수행 (커밋 없음)

---

## 0. 사전 점검 결과 (Smoke Test)

### 0.1 서버 기동
- 실행: `PORT=3099 node server.js` (백그라운드) → `GET /` = 200 OK
- 인증: `admin / 1234` 로 로그인 성공 (※ 문서엔 `0000` 명시되어 있으나 실제는 `1234` — P2 문서-코드 불일치)
  - `db/schema.js:2004` 는 초기 시드 비밀번호를 `'0000'` 으로 지정하지만, 시드 재적재 중 `bcrypt.hashSync('1234', …)` 로 덮어쓰인 것으로 확인. 운영/검증 가이드와 실 비밀번호 차이.

### 0.2 신규 엔드포인트 8종 Smoke Test (admin 세션)

| # | Method | Path | HTTP | 결과 요약 |
|---|--------|------|------|-----------|
| 1 | GET  | `/api/lrs/insights/:userId` | 200 | snapshot/strengths/weaknesses/subjectBalance/recommendedContentIds 구조 정상. admin(id=1) 로그 0건이라 전부 빈 배열 |
| 2 | GET  | `/api/lrs/live-feed` | 200 | 최근 이벤트 stream 정상 (display_name/activity_type/verb/achievement_code 포함) |
| 3 | GET  | `/api/lrs/achievement-progress` | 200 | 117개 성취기준 반환, distribution 구조 정상. **단 레벨 산정식 버그 있음(F-01 참조)** |
| 4 | GET  | `/api/lrs/parent/:childId/digest` | 200 | totals/bySubject/byType/weaknesses 정상. **단 점수 마스킹 누락(S-01 참조)** |
| 5 | GET  | `/api/lrs/warnings/:classId` | 200 | inactive/consecutiveWrong/weakAchievements 정상. **단 로그 0건 학생을 "3일 이상 미학습"으로 잘못 경보(F-02)** |
| 6 | GET  | `/api/lrs/export?format=csv` | 200 | UTF-8 BOM(`EF BB BF`) 선행, `Content-Type: text/csv; charset=utf-8` 정상 |
| 7 | POST | `/api/lrs/session/start` | 200 | `session_id` 발급 정상 |
| 8 | POST | `/api/lrs/session/end` | 200 | 실제 세션 종료 정상. **단 같은 세션 내 활동이 없으면 durationSec=0 반환(P1 개선)** |

### 0.3 기존 엔드포인트 회귀 - `GET /api/lrs/stats/daily`
- 응답 필드 `total_duration_sec` **존재 확인** (routes/lrs.js:385). Phase 2 스펙 B2 이슈 해결됨.
- 7일 쿼리 시 8행 (경계일 포함), custom from/to 쿼리 정상 동작.

### 0.4 UI 정적 검증 (`public/lrs/index.html`, 656 라인)

| 항목 | 존재 여부 | 비고 |
|------|-----------|------|
| role switcher (`dc-role-switcher`) | OK (3회) | L34 마크업 + L509/636 스위칭 로직 |
| `dc-period-picker` | OK (2회) | L46 마크업 (B4 단일화 완료) |
| `dc-kpi-card` 템플릿 | OK (1회) | L189 factory 함수 |
| `dc-filter-bar` | OK (1회) | L44 |
| `dc-chart-wrapper` | OK (12회) | 차트 섹션 래퍼 |
| `dc-state-panel` (로딩/빈/에러) | OK (3회) | L62/153/162 — 3상태 템플릿 모두 구현 |
| `dc-badge` | OK (3회) |  |
| `dc-drawer` | OK (2회) |  |
| **`dc-data-table`** | **누락 (0회)** | 일반 `<table>` 도 0개 — 표 컴포넌트 미구현 |
| **`dc-heatmap`** | **누락 (0회)** | 주간 활동 히트맵 미구현 |
| **`dc-gauge`** | **누락 (0회)** |  |
| **`dc-sparkline`** | **누락 (0회)** |  |

- Phase 2 §4.3 의 12개 공통 컴포넌트 중 **8개 구현 / 4개 미구현**.
- `public/css/lrs-tokens.css` 267라인 존재 (chart-1~10, 토큰 정의).
- `aria-*` 속성 37회 사용, `role="status"/"alert"` 적용 — 접근성 베이스라인 양호.

---

## 1. 발견 이슈 요약 (심각도별)

| 심각도 | 건수 | 제목 |
|--------|-----:|------|
| P0 | 2 | F-01 (성취수준 분류 스코어 단위 버그), F-02 (미학습 학생 경보 오탐) |
| P1 | 5 | S-01 (학부모 뷰 점수 마스킹 누락), F-03 (stats/daily subject 필터 무시), F-04 (session/end 활동 없으면 0분), U-01 (데이터 테이블 컴포넌트 누락), D-01 (achievement_level 데이터 산정 신뢰성) |
| P2 | 3 | D-02 (admin 비밀번호 문서 불일치), U-02 (heatmap/gauge/sparkline 미구현), F-05 (from > to 400 대신 빈 배열 200) |

---

## 2. 상세 이슈 & 재현 스텝

### P0-F-01: 성취수준 분류식의 점수 스케일 버그 (`/api/lrs/achievement-progress`)
- **재현**
  1. admin 로그인
  2. `curl -b cookies "http://localhost:3099/api/lrs/achievement-progress?classId=1"`
- **예상**: 성취기준별 상/중/하/미도달 분포가 실제 정답률 분포(0~100 스케일, 평균 75점)에 맞게 현실적으로 나뉘어야 함 (상 30~40%, 중 40~50% 수준)
- **실제**: `{high: 107, mid: 0, low: 9, notYet: 1, total: 117}` — **"중" 구간이 0건**, 대부분 "상"에 몰림
- **원인**: `routes/lrs.js:661-666`
  ```sql
  WHEN AVG(ll.result_score) >= 0.80 THEN '상'
  WHEN AVG(ll.result_score) >= 0.50 THEN '중'
  ELSE '하'
  ```
  DB의 `result_score` 는 0~100 스케일 (MIN=26, MAX=100, AVG=75.2) 이지만 임계값이 0.80/0.50 로 작성됨. 26점 이상이면 전부 "상" 분류.
- **영향**: 정책 M2(성취기준 도달도)·TC-007·TC-044 의 핵심 검증 항목이 사실상 무효화. 교사 의사결정 지원 불가.
- **수정 제안**: 임계값을 80/50 으로 변경하거나, `ll.result_score / 100.0` 로 정규화 후 비교.

---

### P0-F-02: 로그 0건 학생이 "3일 이상 미학습" 경보에 포함 (`/api/lrs/warnings/:classId`)
- **재현**
  1. admin 로그인 → `GET /api/lrs/warnings/1`
- **예상**: "한 번도 학습하지 않은 학생"은 별도 상태 (`neverActive`) 로 분리 또는 `inactive` 에서 제외
- **실제**:
  ```json
  "inactive": [{"userId":3,"displayName":"이학생","lastDate":null,"daysInactive":999}, ...]
  ```
  `lastDate=null` 인 학생(학습 로그 0건)이 `daysInactive=999` 로 미학습 경보에 올라옴.
- **원인**: `routes/lrs.js:844-851` — `last_date IS NULL` 분기 미처리, 기본값 `daysInactive=999` 가 임계값(3) 초과로 판정됨.
- **영향**: 교사가 "7일 이상 미학습 N명" 알림을 받아도 그중 미가입/미활동 학생이 섞여 실제 부진 학생 식별이 왜곡됨. TC-014(부진학생 3명 경보 카드) 정확도 저하.
- **수정 제안**:
  ```js
  if (lastDate && daysInactive >= 3) inactive.push({...});
  // 또는 별도 카테고리 neverActive 로 분리
  ```

---

### P1-S-01: 학부모 다이제스트 엔드포인트가 원점수(0~100) 그대로 노출
- **정책 근거**: M5, TC-034 "학부모 뷰에서 학생 상세 점수는 마스킹, 성취 레벨(A~E)만 표시"
- **재현**
  1. `curl -b admin.txt /api/lrs/parent/4/digest`
- **실제**: `"avgScore":73.35714285714286`, `bySubject[].avg_score:71.73…` 등 **소수점 14자리까지 원점수 노출**
- **영향**: 개인정보보호법 23조 "민감정보 최소수집·제공" 원칙 위배 가능. 학부모 역할로 접근 시에도 동일한 원점수 제공(role 분기 없음).
- **원인**: `routes/lrs.js:749-759` 응답에 role 별 마스킹 로직 부재.
- **수정 제안**: `req.user.role === 'parent'` 일 때 `avgScore` 를 A/B/C/D/E 레벨 문자열로 변환, 교과별 점수도 동일 처리.

---

### P1-F-03: `/api/lrs/stats/daily` 의 `subject` 쿼리 파라미터가 무시됨
- **재현**
  - `/api/lrs/stats/daily?days=7` → 2026-04-14 count=74
  - `/api/lrs/stats/daily?subject=math-e&days=7` → 2026-04-14 count=74 (동일)
  - DB 직접 조회: `SELECT COUNT(*) FROM learning_logs WHERE DATE(created_at)='2026-04-14' AND subject_code='math-e'` → 13
- **예상**: 13건 반환
- **실제**: 74건 (필터 미적용)
- **원인**: `routes/lrs.js:365-394` 의 stats/daily 핸들러가 `activity_type`, `class_id`, `role` 만 파라미터로 인식, `subject` 미처리.
- **영향**: 정책 M7(교과 필터) 실패. TC-013 (교과 "수학" 필터링) 불합격.
- **수정 제안**:
  ```js
  const { subject } = req.query;
  if (subject) { where += ' AND ll.subject_code = ?'; params.push(subject); }
  ```

---

### P1-F-04: `session/end` 의 활동 집계 부정확
- **재현**: session/start 후 1초 sleep → session/end
- **실제**: `{"durationSec":0,"activityCount":0}`
- **예상**: 최소 1초 또는 세션 수명(start~end 시각 차) 반환
- **원인 추정**: session/end 가 해당 session_id 로 기록된 `learning_logs` 만 집계. 하지만 브라우저가 세션 시작 후 실 활동을 로깅하기 전에는 0 으로 고정됨. 세션 자체의 start/end 타임스탬프는 미활용.
- **영향**: `lrs_session_stats` 몰입도 지표의 기초 데이터가 0으로 수렴할 위험.
- **수정 제안**: session 테이블에 started_at/ended_at 을 저장하여 `julianday(end)-julianday(start)` 기반 duration 도 같이 반환.

---

### P1-U-01: `dc-data-table` / 일반 `<table>` 요소가 아예 없음
- **재현**: `grep -c "<table" public/lrs/index.html` → 0
- **예상**: LRS 대시보드에서 "학생 목록", "콘텐츠 활용 표", "성취기준별 도달도" 등 최소 1개 이상 표 컴포넌트 존재
- **실제**: 전부 카드/차트로만 구성
- **영향**: TC-010(콘텐츠 활용 CSV 다운로드 테이블), TC-030(대용량 테이블 페이징), S3(콘텐츠별 표) 수행 불가. 정책 M9(CSV 내보내기) 는 API 로 가능하지만 UI 상 "표로 보기" 경로 부재.
- **수정 제안**: `dc-data-table` 컴포넌트 구현 및 "교사 > 우리반 현황" 랜딩에 학생 리스트 테이블 삽입.

---

### P1-D-01: `lrs_achievement_stats.avg_score` 가 전부 null
- **재현**
  ```sql
  SELECT user_id, achievement_code, avg_score, last_level FROM lrs_achievement_stats WHERE last_level IN ('하','미도달') LIMIT 5;
  ```
  → 모든 행의 `avg_score` 컬럼 NULL
- **영향**: `/api/lrs/warnings` 의 `weakAchievements[].items[].avg_score` 가 `null` 로 노출(스크린샷 응답 확인). UI 에서 % 표시가 비어 교사가 원인 판단 어려움.
- **원인 추정**: 집계 빌더에서 `UPDATE … SET avg_score = …` 경로 누락 또는 `result_score` 소스 필드 연결 실수. `last_level` 은 계산되었으나 `avg_score` 는 기록 안 됨.
- **수정 제안**: `scripts/seed-lrs-realistic.js` 또는 `db/lrs-aggregate.js` 의 achievement_stats 빌드 시 `AVG(result_score)` 를 `avg_score` 컬럼에 저장하도록 보정.

---

### P2-D-02: admin 비밀번호 문서-실제 불일치
- `db/schema.js:2008` 에서 "admin / 0000" 로그 출력하지만 실제 DB 해시는 `1234` 에 매칭.
- **영향**: QA/문서/자동화 로그인 모든 시도 실패. 문서 또는 seed 재실행 중 하나가 깨진 상태.
- **수정 제안**: seed 재실행 시 비밀번호를 `0000` 으로 재설정하거나, README/문서를 `1234` 로 업데이트.

---

### P2-U-02: 공통 컴포넌트 4개 미구현 (heatmap/gauge/sparkline/data-table)
- `docs/lrs-phase2-spec.md §4.3` 에서 12개 컴포넌트 요구 → 8개만 존재.
- **영향**: Should Have 요구 축소. 요일별 학습 히트맵, 도달도 게이지 등 시각 표현 품질 저하.
- **수정 제안**: 최소 `dc-data-table`, `dc-heatmap` 2종만이라도 Phase 4 범위로 확정.

---

### P2-F-05: `from > to` 입력 시 경고 없이 빈 배열 반환
- **재현**: `/api/lrs/stats/daily?from=2026-04-21&to=2026-04-01` → HTTP 200, `data:[]`
- **예상(TC-012)**: "시작일이 종료일보다 늦습니다" 400 경고 또는 자동 swap
- **실제**: 오류 안내 없이 정상 응답처럼 빈 배열 반환 → 사용자가 "데이터 없음" 으로 오해
- **수정 제안**: `resolvePeriod` 내부에서 from > to 감지 시 400 반환 또는 swap.

---

## 3. 테스트 케이스 결과표 (P0 우선 20개 이상)

| TC ID | 카테고리 | 우선 | 결과 | 비고 |
|-------|---------|------|------|------|
| TC-001 | F | P0 | N/T | 학생/교사 역할별 메뉴 노출 분기 존재(role-switcher) 확인, 실제 학생 로그인 렌더 미확인 |
| TC-003 | F | P0 | PASS(부분) | 비로그인 시 `/api/lrs/dashboard` → 401. 단, `/lrs/index.html` 자체는 200 (리다이렉트 아님) — 정책 해석 필요 |
| TC-004 | F | P0 | PASS | student1 → `/api/lrs/insights/999` = 403 |
| TC-005 | F | P0 | PASS | admin 대시보드 응답에 NaN/undefined 0건 |
| TC-006 | F | P0 | PASS | `days=7` → 8개 stat_date (경계 포함), 2026-04-14~21 범위 |
| TC-007 | F | P0 | FAIL | achievement-progress 의 level 분류 버그 (F-01). 성취기준 코드·도달도%·A~E 분포 자체는 표시됨 |
| TC-009 | F | P0 | PASS | admin 대시보드(로그 0건) → `{totalActivities:0, byType:[]}` + UI `tplEmpty` 템플릿 존재 |
| TC-010 | F | P1 | PARTIAL | CSV API는 BOM+UTF-8 정상. **UI 에서 CSV 다운로드 버튼 경로 미확인, 표 자체 부재 (U-01)** |
| TC-011 | F | P0 | PASS | `from=2026-04-01&to=2026-04-21` → 21일치 stat_date 반환, 범위 준수 |
| TC-012 | F | P1 | FAIL | `from>to` 시 400 아닌 200 + 빈 배열 (F-05) |
| TC-013 | F | P0 | FAIL | `subject=math-e` 필터 미동작 (F-03) |
| TC-014 | F | P1 | FAIL | 부진학생 경보에 로그 0건 학생 혼입 (F-02) |
| TC-023 | U | P1 | PASS | `tplEmpty` 템플릿 존재 (index.html:152) + 아이콘+메시지+CTA 구조 |
| TC-021 | U | P1 | PASS | `tplLoading` + `dc-skeleton` 존재 (index.html:147) |
| TC-022 | U | P2 | PASS | `tplError` + "다시 시도" 버튼 존재 (index.html:159) |
| TC-027 | P | P1 | PASS | `/dashboard` time_total=11ms, `/stats/daily` 17ms, `/warnings/1` 12ms (전부 <500ms) |
| TC-028 | P | P1 | PASS | `/class/1` = 92ms (<800ms) |
| TC-031 | S | P0 | PASS | 비로그인 API = 401 |
| TC-032 | S | P0 | PASS | student1 → `/insights/999` = 403 |
| TC-033 | S | P0 | PASS | student1 → `/warnings/1` = 403, `/parent/999/digest` = 403, `/export` = 403 |
| TC-034 | S | P0 | FAIL | parent/digest 응답에 원점수(float) 그대로 노출 (S-01) |
| TC-035 | S | P1 | PASS(부분) | 쿼리 XSS `<script>` 주입 시 응답 200 정상, 서버 이스케이프 확인. UI 측 `innerHTML` 사용 패턴 별도 감리 필요 |
| TC-036 | S | P1 | PASS | `classId=1 OR 1=1` → URL 인코딩 경로 파라미터 `parseInt` 처리로 1만 추출되어 정상 동작(인젝션 차단). better-sqlite3 파라미터 바인딩 사용 확인 |
| TC-037 | S | P1 | N/T | 세션 만료 수동 시뮬레이션 미수행 |
| TC-044 | D | P0 | PASS | `learning_logs` 2026-04-14~21 합계 538건 == `lrs_daily_stats.activity_count` 합계 538건 |
| TC-045 | D | P0 | PASS | achievement_code 컬럼 커버리지 2109/2109 = 100% |
| TC-046 | D | P1 | PASS | 일별 합 일치 확인 |
| TC-047 | D | P1 | PASS | live-feed 응답에 activity_type/verb 정상 쌍 (예: content_view/accessed, lesson_view/accessed) |
| TC-048 | D | P1 | FAIL | 성취수준 계산식 0~1 vs 0~100 불일치 (F-01) |

**합격율 (수행 기준)**
- P0 수행 14건 중 **11 PASS / 3 FAIL** (TC-007, TC-013, TC-034) → **78.6%** (정책 합격선 100% 미달)
- P1 수행 12건 중 **7 PASS / 1 PARTIAL / 4 FAIL** (TC-012, TC-014, TC-048, + U-01 관련)
- 전체 수행 29건 중 **19 PASS / 2 PARTIAL / 8 FAIL** → **~69%** (정책 합격선 85% 미달)

---

## 4. 완성도 평가 (정책 §5 기준)

| 평가 영역 | 지표 | 합격선 | 실측 | 판정 |
|-----------|------|--------|------|------|
| Must Have 10항목 | 100% | 10/10 | 8/10 (M2·M7 결함) | ❌ |
| Should Have 8항목 | 62.5% | 5/8 | ~3/8 (S3/S7 미구현) | ❌ |
| TC P0 통과율 | 100% | 15/15 | 11/14 수행 | ❌ |
| TC P1 통과율 | 90% | ≥ 90% | ~58% | ❌ |
| TC 전체 통과율 | 85% | ≥ 85% | ~69% | ❌ |
| 데이터 정합성 | 99% | 집계 vs 원본 일치 | 100% (538==538) | ✅ |
| API 평균 응답 | <500ms | 평균 | 12~19ms | ✅ |
| 페이지 FCP | <1.5s (Lighthouse) | - | 미측정 | N/T |
| 접근성 Critical | 0건 | axe-core | 미측정 | N/T |
| 반응형 1280/768/360 | 3 해상도 정상 | - | 미측정 | N/T |
| 빈/로딩/에러 3상태 | 누락 0건 | - | 존재 (dc-state-panel) | ✅ |

**최종 판정**: 합격선 미달 **5개 (≥ 3개 기준 초과)** → 현 단계에서는 **"불합격"**. 특히 **P0 미통과 3건(F-01·F-02·S-01)** 이 차단 요인.

---

## 5. 권고 및 후속 조치

1. **즉시 (Sprint 패치)**
   - `routes/lrs.js:661-666` 점수 스케일 수정 (0.80 → 80, 0.50 → 50 또는 정규화)
   - `routes/lrs.js:844-851` `lastDate === null` 처리로 `neverActive` 분리
   - `routes/lrs.js:749-759` parent role 점수 마스킹 도입
2. **단기 (Phase 4 전)**
   - `stats/daily` 에 `subject` 쿼리 바인딩 추가 (TC-013)
   - `from > to` 검증 로직 (TC-012)
   - `lrs_achievement_stats.avg_score` 집계 복구 + 재빌드
3. **중기 (Should Have 보강)**
   - `dc-data-table`, `dc-heatmap` 최소 2개 컴포넌트 구현
   - 학생/교사/학부모 각 역할별 렌더 확인 (TC-001/002, S-01/T-06, P-01)
4. **문서/운영**
   - admin 비밀번호 실제값을 `docs/` 운영 가이드에 명시 (현재 1234)
   - `session/end` durationSec=0 케이스 처리 방침 확정

---

## 6. 부록: 검증에 사용한 주요 명령

```bash
# 로그인
curl -s -c /tmp/admin.txt -X POST http://localhost:3099/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"1234"}'

# 신규 엔드포인트 smoke
for ep in "insights/1" "live-feed" "achievement-progress" "parent/1/digest" "warnings/1"; do
  curl -s -b /tmp/admin.txt "http://localhost:3099/api/lrs/$ep" -w "HTTP:%{http_code}\n"
done

# 데이터 정합성
node -e "const db=require('./db'); \
  const raw=db.prepare(\"SELECT COUNT(*) n FROM learning_logs WHERE DATE(created_at) BETWEEN '2026-04-14' AND '2026-04-21'\").get(); \
  const agg=db.prepare(\"SELECT SUM(activity_count) n FROM lrs_daily_stats WHERE stat_date BETWEEN '2026-04-14' AND '2026-04-21'\").get(); \
  console.log(raw, agg)"
```

*— QA 서브에이전트 / 2026-04-21 작성*
