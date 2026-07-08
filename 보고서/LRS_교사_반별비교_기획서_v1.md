# LRS 교사 "반별 비교" 신규 뷰 기획서 v1

- 작성: UI 디자이너(opus)
- 요청(원문): "교사 계정의 lrs는 클래스간 비교가 필요함 / 관리자 계정의 lrs처럼"
- 해석: 방금 배포한 **관리자 "지역별 성취수준 비교"(a-macro)** 의 **교사판**. 비교 단위만 **지역 → 반(클래스)**, 스코프는 **교사 본인이 담당(소유)하는 반들만**.
- 대상 화면: `public/lrs/index.html` 교사 뷰(`t-*`) — 신규 뷰 `VIEWS['t-classcompare']` 1개 추가.
- **원칙(고정): 코드 수정 없음(본 문서는 구현 스펙). 신규 원자료 수집·외부연동·AI 신설 금지.** 관리자 equity 렌더러/헬퍼·기존 교사 반별 집계 패턴(`resolveMembershipScopeFilter`·`_equityMetric`·`scoredWhere`·`normScoreExpr`·`subjectCodeSetFilter`)을 **재사용/확장**으로만 해결.
- "성취수준 = 채점형 학습활동 평균 정답률(0~100점)"을 전 라벨·툴팁에 병기(관리자와 동일 규칙).

---

## 0. 현 상태 실측 근거 (라이브 teacher1/1234·admin/1234, 포트 3000 — 2026-07-08)

### 0-1. 재사용 원본 — 관리자 a-macro(지역별 성취수준 비교) 자산 목록
`public/lrs/index.html`에서 **그대로 승계 가능한** 컴포넌트/헬퍼(라인은 현재 파일 기준):

| 자산 | 위치 | 교사판에서의 역할 |
|---|---|---|
| `VIEWS['a-macro']` 렌더 골격 | ~7767 | 섹션 배치(필터바→막대→표→우선지원)를 그대로 복제 |
| `_equityInsight(d)` | 7717 | 헤드라인·우선지원 분석멘트(규칙기반). `dimLabel`만 '지역'→'반'으로 |
| `_renderEquityChips`/`_bindEquityChips` | 7976/8001 | 필터 칩 컴포넌트(`.dc-unit-toggle`+`.chip`) |
| `aEquityBar`(막대) | 7876 | 반별 정답률 내림차순 막대(하위 강조) |
| `aEquityTable`(상세표) | 7954 `renderDataTable` | 반별 상세표(정렬·행클릭 드릴) |
| `#aEquityPriority`(우선지원 목록) | 7899 | "우선 관심 반" 목록(산점도 아님) |
| `_renderEquityCrossLevel`/`_equityScoreColor` | 8027/8015 | (선택) 반×교과 미니 히트맵의 색·표 골격 |
| `_equityGapTone`/`_equityGapToneX` | 7695/7702 | 격차 tone(danger/warning/success) |

- 관리자 BE `/stats/equity`(routes/lrs.js 4984)는 **`_adminOnly` 게이트**로 교사 접근 불가. 집계 축이 `u.region`/`u.school_level`(users 컬럼) 고정이라 **반(멤버십) 단위 재사용 불가** → BE는 **교사 전용 형제 엔드포인트 신설**(§C-1) 필요. 단, 내부 순수함수(`_equityMetric`·`scoredWhere`·`normScoreExpr`·`subjectCodeSetFilter`·`buildAvailableSubjects`·`canonicalSubjectKey`·`_pctile`)는 전부 재사용.

### 0-2. 교사 LRS 현 IA·스코프 — "반별로 쪼갠 비교"가 지금은 없음
- 교사 분석 탭(라이브 확인): **성취 도달 현황(t-warnings) · 교과별 활동 현황(t-subject) · 활용 현황(t-usage) · 표준체계 분석(t-xapi) · 일일현황(t-daily)**. **"반별 비교" 탭 없음.**
- 현 교사 뷰는 전부 `resolveMembershipScopeFilter(req,'ll')`(routes/lrs.js 473)로 **"담당 반 학생 전체 합집합"** 을 하나로 집계한다(예: t-home `/api/lrs/dashboard`·`/stats/daily`, t-usage `/stats/by-service`). 즉 **여러 반이 하나로 뭉쳐** 표시 → 반 사이의 우열/격차가 안 보임. **반별 비교는 진짜 신규 역량**(현재 화면의 단순 재배치가 아님).

### 0-3. teacher1 담당 반 실측 — ★ 설계의 최대 제약 (표본·삭제 클래스)
`teacher1`(id=2)이 **소유(owner_id=2)** 한 반은 DB상 6개지만, 실제 비교 대상은 **활성 2개**:

| id | 이름 | 상태 | 학생수 | 30일 채점형학생수 |
|---|---|---|---|---|
| 1 | **3학년 1반** | active | 8 | 7 |
| 2 | **즐거운 수학교실** | active | 6 | 6 |
| 1000~1003 | fix검증·reject검증 등 | **deleted** | 0~1 | 0~1 |

- 라이브 `/api/class/my`는 **이미 active만 반환**(deleted 4건 제외) → teacher1 = **2개 반**. ✅ 사용자 진술("class1·class2 두 반")과 일치. **BE도 `status='active'` 필터 필수**(deleted 테스트 클래스 혼입 방지).
- **★ 결정적 제약**: 두 활성 반 모두 학생수 **8·6명 → 관리자 equity의 개인정보 마스킹 게이트 `MIN_N=10` 미만.** 관리자 로직을 그대로 이식하면 **모든 반이 마스킹되어 화면이 텅 빈다.**
  - **해결(§C-2)**: 반별 비교는 **개인정보 마스킹(이름 숨김)을 적용하지 않는다.** 근거 — 교사는 **자기 소유 반의 개별 학생 데이터를 이미 t-home·t-drill에서 실명으로 열람**한다. 반 평균끼리 비교하는 것은 새 정보 노출이 아니므로 프라이버시 위험이 없다. 대신 **통계 신뢰 캡션**("표본 적음 · 참고용")만 소표본 반에 부착. → 관리자 `MIN_N=10`(프라이버시)과 **정책이 다름**을 문서에 명시.

### 0-4. 반(클래스) 단위 집계 방식 — 멤버십 조인 (users 컬럼 아님)
- 지역/학교급은 `users` 테이블 컬럼이라 `GROUP BY u.region`이 되지만, **반은 `class_members` 멤버십**이다. 또 self-learn(99.4%)·content 로그는 `learning_logs.class_id`가 NULL → **class_id 기준 집계는 대부분 0건**. 그래서 `resolveMembershipScopeFilter`가 이미 쓰는 **"반 → 학생 멤버 user_id 집합 → 그 학생들의 로그"** 방식(멤버십 조인)을 반별로 반복한다(§C-1). 이러면 class_id NULL인 자기주도 활동도 그 반에 귀속된다(교사 다른 탭과 동일 정책).
- **다중 소속 주의(정상 동작)**: 한 학생이 교사의 두 반(예: 담임반+교과반)에 동시 소속이면 **두 반 평균에 각각 반영**된다 — 각 반의 평균은 그 반 로스터 기준이 맞으므로 **버그가 아니라 의도**. (문서에 캡션으로 고지: "한 학생이 두 반에 속하면 각 반 통계에 모두 반영됩니다.")

### 0-5. 교과 코드 정규화 — 이미 해결된 자산 재사용
- `learning_logs.subject_code`는 접미(`math-e/-m/-h`)·레거시 대문자(`MAT`)·원문 한글(`국어`) 혼재. 이미 `subjectLabel(code)`(routes/lrs.js 86)+`canonicalSubjectKey(label)`(116)+`subjectCodeSetFilter(key,alias)`(125)가 "canonical key → codeSet IN(...)" 를 제공. **교과 필터는 이 3함수 그대로 재사용**(신규 정규화 로직 0). `buildAvailableSubjects(presentKeys)`(139)로 데이터 주도 교과 칩(죽은 칩 방지)도 그대로.

---

## A. IA·진입 (사용자 중심)

### A-1. 신규 뷰/메뉴 배치 (MENUS.teacher, index.html 1292~1303)
- **신규 항목 1줄 추가** (성취 비교 형제인 t-warnings 바로 뒤 = 발견성 최상):
  ```js
  { id:'t-warnings',    label:'성취 도달 현황',   icon:'fa-table-cells',    group:'분석', category:'analytics' },
  { id:'t-classcompare',label:'반별 비교',        icon:'fa-scale-balanced', group:'분석', category:'analytics' }, // 신규
  { id:'t-subject',     label:'교과별 활동 현황', icon:'fa-book',           group:'분석', category:'analytics' },
  ```
  - 라벨 **"반별 비교"**(초등 교사도 즉시 이해되는 평이·명사형). 아이콘 `fa-scale-balanced` = 관리자 지역비교와 **동일**(격차/저울=비교의 의미적 일관성).
  - **관리자 지역비교의 교사판**임을 IA로 명확히: 같은 아이콘·같은 섹션 구성(막대+표+우선목록)을 재사용해 "이건 우리 반 버전의 그 화면"이라는 인지 전이.
- **라우팅 부수 반영**: `LEGACY_MENU_TO_CATEGORY`(1368)에 `'t-classcompare':'analytics'` 1줄 추가(딥링크 호환). `viewToMenu`는 `categoryForView`로 자동 해석되므로 추가 작업 불필요.

### A-2. 권한 스코프 (교사 본인 담당 반만)
- 비교 대상 = **`SELECT id,name FROM classes WHERE owner_id = <본인> AND status='active'`**(§C-1). `resolveScopeFilter`의 class 분기(routes/lrs.js 442)와 동일 소유 기준. 남의 반은 절대 비교 대상에 포함 불가.
- (co_teacher/공동담임은 프로젝트상 휴면 → v1은 owner만. 후속 확장 여지만 남김.)

### A-3. 빈 상태 — 반 1개 이하
- 활성 담당 반 **< 2** 이면 비교 불가:
  > 🏫 **반별 비교는 담당 반이 2개 이상일 때 볼 수 있어요.**
  > 지금 담당 반은 **{N}개**예요. 반을 더 만들면 반끼리 성취·활용을 나란히 비교할 수 있어요.
  > [클래스로 이동] (→ `/class/index.html`)
- 컴포넌트: 기존 `dc-state-panel`(친절 빈상태) 재사용. 진입 자체는 허용하되(메뉴는 항상 노출) 본문만 빈상태로 안내(현재위치·다음행동 명확).

---

## B. 비교 지표·구성 (관리자 지역비교 미러링 + 반 규모에 맞춘 단순화)

> **단순화 원칙(사용자 지시)**: 반은 보통 2~3개로 적으므로 관리자의 **격차 헤드라인 4KPI·CV(변동계수)·우선개입 사분면 산점도는 과하다.** → **"반 나란히 비교(막대+표)" 중심 + 가벼운 우선목록**으로 축약. 통계 산포(CV)·산점도는 **넣지 않는다.**

### 섹션 순서 (권장안)

#### ① 필터 바 (§A-2 chip 재사용)
```
[ 교과  ● 전체  ○ 국어  ○ 수학  ○ 영어  ○ 과학  ○ 사회  … ]     [ 기간  ● 30일  ○ 90일 ]
```
- **학교급 필터 없음**: 한 교사의 반들은 대개 동일 학교급(초등 담임=한 학교급) → 불필요. (관리자판의 학교급 필터를 **제거**한 것이 교사판의 단순화 포인트.)
- 교과 칩은 **데이터 주도**(`availableSubjects` present=true만). 기본 순서 국어·수학·영어·과학·사회, 그 외 뒤. `flex-wrap`(가로스크롤 0).
- 컴포넌트: `_renderEquityChips`를 **교과·기간 2필터 버전**으로 경량 복제(`_renderClassCmpChips`). 상태: `state._ccSubject`(기본 all)·`state._ccPeriod`(기본 30d). 칩 클릭 → `VIEWS['t-classcompare'](root)` 재호출(단일 API 1회로 전 섹션 갱신).
- **정의 캡션(항상 노출)**: `성취수준 = 채점형 학습활동(평가·과제·문항풀이·오늘의 학습 등)의 평균 정답률(0~100점)이에요.`
- **적용 필터 요약칩**(현재위치 피드백): 교과가 전체가 아니면 `필터: 수학 · 최근 30일`.
- **다중소속 캡션**(§0-4): 정의 캡션 옆 작은 글씨 `한 학생이 두 반에 속하면 각 반 통계에 모두 반영돼요.`

#### ② 핵심 비교 요약 배너 (insight) + 경량 KPI 2칸
- **인사이트 배너**(`dc-insight-banner` 재사용, `_equityInsight` 톤): `dimLabel`을 '반'으로 바꿔:
  > 💡 반 간 평균 정답률 차이는 **{gap}%p**입니다. **{topClass}**(최고)와 **{bottomClass}**(최저)의 차이예요. {큼/중간/작음 판정}.
  - 교과 선택 시 "평균 정답률"→"수학 정답률".
- **KPI 2칸만**(관리자 4칸 → 축약, `dc-kpi-grid` 재사용):
  1. **성취수준(정답률) 격차** `{gap}%p` — subtitle `{topClass}↔{bottomClass}`, tone=`_equityGapTone`.
  2. **활용도 격차(1인당 활동)** `{gapX}배` — tone=`_equityGapToneX`.
  - **CV(변동계수) 라인 미표시**(kpi-extra 생략) — 2~3개 반에서 무의미.
  - 반응형 <768: 2칸 → 세로 스택.

#### ③ 반별 성취수준(정답률) 막대 — ★ 1차 비교(주력)
- `aEquityBar` 재사용: `indexAxis:'y'`, **정답률 내림차순**, **최하위 반 빨강(`#dc2626`)** 강조, 나머지 `var(--chart-1)`.
- 헤더 **`반별 성취수준(정답률)`**(교과 선택 시 `반별 수학 정답률`). subtitle `평균 정답률 내림차순 · 가장 낮은 반 빨강 강조`.
- x축 `성취수준(정답률, 0~100점)`, `min:0 max:100`. 툴팁 `{반} · 정답률 {n}점`, 최하위엔 `가장 낮은 반 — 먼저 살펴보세요`.
- **소표본 반 표기**: 채점형 학생 < 3인 반은 막대 라벨 뒤 `· 표본 적음` 회색 접미(막대는 그대로 노출, 마스킹 아님).
- 활동 0인 반(예: 신설 반): 막대에서 제외하고 표(④)에서 `활동 없음`으로만 표기.

#### ④ 반별 상세표 — 행 클릭 → 그 반 교과별 드릴(인라인)
- `renderDataTable`(aEquityTable) 재사용. 열:
  `반 | 학생수 | 활성률(%) | 1인당활동(건) | 평균학습시간(분) | 성취수준(정답률) | 도달률(%) | 구간(배지)`
  - "성취수준(정답률)"(교과 선택 시 "수학 정답률"). `initialSort:'avgScore' desc`.
  - 구간 배지 `QUAD_BADGE`(이중취약/활용 저조/성취 저조/양호) 재사용 — 색코딩은 ⑤ 우선목록과 일치(이중취약=danger).
  - **마스킹 행 없음**(교사 소유) — 대신 소표본 반은 활성률/정답률 셀 옆 `표본 적음` 회색 캡션.
- **행 클릭 → 그 반의 교과별 정답률 인라인 확장 패널**(모달 아님): 미니 막대(교과 내림차순)+미니표. 데이터는 §C 응답의 `classSubjectMatrix`에서 그 반 행만 사용(추가 API 불필요) 또는 `/stats/by-subject?class_id=` 경량 호출 중 택1(권장: 응답 내장 매트릭스 재사용 → 추가 호출 0). 재클릭 접힘. **모달 미사용 = GNB(z9999) 겹침·가로스크롤 회피.**

#### ⑤ 우선 관심 반 — 목록만(산점도 없음)
- 헤더 **`우선 관심 반`**. subtitle(평이): `활용도와 성취(정답률)가 함께 낮아 먼저 살펴보면 좋은 반이에요.`(교과 선택 시 `수학 활용도와 정답률이 함께 낮은 반이에요.`)
- `#aEquityPriority` 패널(빨강 좌테두리 + `dc-badge--danger` 반 배지 + `_equityInsight().priority` 멘트) 재사용. `dimLabel`='반'.
- 판정: `both_low`(활용 중앙값 이하 AND 정답률 중앙값 이하). **2개 반이면** 두 축 모두 낮은 쪽만 후보(없을 수도 있음). 후보 없으면 초록 패널 `'활용도·정답률 동반 저조' 구간에 해당하는 반이 없어요.`
- **산점도·사분면 차트 미구현**(사용자 지시). 사분면 판정 로직은 BE에만 남고 FE는 목록만.

#### ⑥ (선택·P1) 반×교과 미니 히트맵 — 교과별 강/약 한눈에
- 관리자 "학교급×지역 히트맵"의 **반×교과 버전**. 행=반, 열=교과, 셀=그 반·그 교과 평균 정답률(`_equityScoreColor` 초록↔빨강, 표본부족 회색). `_renderEquityCrossLevel` 골격 재사용(행 라벨만 학교급→반, 열 라벨 지역→교과).
- **교과=전체일 때만** 노출(특정 교과 선택 시 열이 1개라 무의미 → 섹션 숨김, 기존 "빈배열이면 숨김" 폴백과 동일).
- 카드 내부 `overflow-x:auto`(`.dc-clr-wrap`) — 교과 열이 많아도 **페이지 가로스크롤 0**.
- 행별 "교과 간 격차" 요약(최고↔최저 교과) + `_equityCrossLevelInsight` 톤 멘트("이 반은 국어가 가장 낮아요").
- v1 우선순위: ③④⑤ 필수, ⑥은 데이터/일정 여유 시(P1). 없어도 ①~⑤로 요청 충족.

#### (미포함) 격차 추세 라인
- 관리자 ⑥ 격차 추세는 **v1 미포함**(2~3개 반·짧은 시드에서 3구간 추세는 노이즈). 필요 시 P2.

---

## C. 재사용·데이터 (BE 계약)

### C-1. 신규 형제 엔드포인트 — `GET /api/lrs/stats/class-compare`
(equity를 오염시키지 않기 위해 **신규 엔드포인트**. 응답 스키마는 equity와 **동일 필드명**으로 맞춰 FE가 렌더러를 통째 재사용.)

```
GET /api/lrs/stats/class-compare
  auth: requireAuth + role ∈ {teacher, admin}   // admin은 참고 접근(옵션), 주 사용자=teacher
  params:
    subject = all|<canonicalKey>   (기본 all; korean/math/english/science/social/moral/music/art/pe/practical)
    period  = 30d|90d              (기본 30d)

  스코프(재사용):
    ownedClasses = SELECT id, name FROM classes
                   WHERE owner_id = :uid AND status='active'
    if ownedClasses.length < 2 → { success:true, units:[], insufficientClasses:true, ownedCount:N }
       (FE 빈상태 §A-3)

  반별 집계(각 class c):
    memberIds(c) = SELECT cm.user_id FROM class_members cm JOIN users u ON u.id=cm.user_id
                   WHERE cm.class_id=c.id AND u.role='student'         // resolveMembershipScopeFilter 방식
    studentsC   = memberIds.length
    로그 집계는 memberIds IN(...) 로(멤버십 조인 → class_id NULL 자기주도 활동 포착):
      logAgg: COUNT(*) acts,
              SUM(duration) dur_sec,
              AVG(CASE WHEN scoredWhere('ll') THEN normScoreExpr('ll') END) avg_score
              WHERE ll.user_id IN(memberIds) AND DATE(created_at)>=... {subjectCodeSetFilter}
      wau:    COUNT(DISTINCT user_id) 최근7일 (activeRate 분자)
      reach:  개인 avg_score>=60 학생 수 (reachRate 분자)   // equity reachAgg 동일 산식
    → unit = {
        id: c.id, label: c.name, students: studentsC,
        activeRate, avgActsPerStudent, avgLearnMin, avgScore, reachRate,
        quadrant(아래), masked:false,           // ★ 프라이버시 마스킹 미적용(§C-2)
        lowSample: (채점형학생수 < 3)            // 통계 캡션용(신규 플래그)
      }

  지표(재사용 _equityMetric):
    metrics = {
      avgScore:   _equityMetric(mkVals('avgScore'),'pp'),
      actsPerStu: _equityMetric(mkVals('avgActsPerStudent'),'ratio'),
      activeRate: _equityMetric(mkVals('activeRate'),'pp'),   // KPI엔 2칸만 쓰지만 계약은 유지
      reachRate:  _equityMetric(mkVals('reachRate'),'pp')
    }
  사분면(재사용): 활용(avgActsPerStudent) 중앙값 × 성취(avgScore) 중앙값 → quadrant(both_low/…)
  priorityUnits: quadrant==='both_low' 반 목록(성취 낮은 순)
  availableSubjects: 소유 반 학생 로그(급 무관)에 존재하는 교과만 present=true (buildAvailableSubjects 재사용)
  classSubjectMatrix(선택·⑥): [{ classId, className, cells:[{subjectKey, subjectLabel, avgScore, students, masked(표본<3만 회색)}] }]
                              // 반 × 교과 avg_score. 교과=all일 때만 채움(그 외 [])
  appliedSubject, appliedSubjectLabel  // FE 라벨 주입

  반환(권장):
    { success, period, units, metrics, priorityUnits, availableSubjects,
      classSubjectMatrix, appliedSubject, appliedSubjectLabel,
      insufficientClasses:false, ownedCount, minScoredForCaption:3 }
```

- **재사용 요약**: `_equityMetric`·`scoredWhere`·`normScoreExpr`·`subjectCodeSetFilter`·`buildAvailableSubjects`·`canonicalSubjectKey`·`_pctile` **전부 그대로**. 신규는 (a) 반 루프 스코프 SQL(멤버십 조인, 기존 `resolveMembershipScopeFilter` 패턴 복제), (b) `status='active'` 필터, (c) `lowSample` 플래그뿐.
- **equity와의 차이(문서화 필수)**: ① `_adminOnly` 대신 teacher 허용, ② 집계축 users컬럼→멤버십, ③ **MIN_N 프라이버시 마스킹 미적용**(§C-2), ④ crossLevelRegion 없음(대신 classSubjectMatrix), ⑤ 학교급 필터 없음.

### C-2. 표본·마스킹 정책 (관리자와 다름 — 근거 명시)
- **개인정보 마스킹(이름/값 숨김) 미적용.** 교사는 자기 소유 반 학생을 이미 실명 열람(t-home EWS·t-drill) → 반 평균 비교는 새 노출이 아님. 관리자 `MIN_N=10`은 "비담임/거시뷰의 소집단 재식별 방지"용이라 교사 자기반 비교에는 부적용.
- 대신 **통계 신뢰 캡션**: 채점형 학생 < 3 인 반은 막대·표에 `표본 적음 · 참고용`(회색). 값은 표시하되 "적은 표본" 주의만.
- 활동/채점 0인 반: 막대 제외 + 표 `활동 없음`. 지표(metrics) 계산에서도 avgScore null 반은 자동 제외(_equityMetric이 null 필터).

### C-3. FE 렌더러 재사용 배선
- 신규 `VIEWS['t-classcompare']` 는 `VIEWS['a-macro']`(7767) 골격을 복제하되:
  - API: `/api/lrs/stats/class-compare?subject=&period=`.
  - `dimLabel='반'`, `_equityInsight`에 넘길 때 지역→반 라벨 치환(작은 래퍼 `_classCmpInsight(d)` 또는 `_equityInsight` 시그니처에 dimLabel 인자 1개 추가 — 권장: 인자 추가로 공용화).
  - 필터바 = 교과·기간 2필터 경량본(`_renderClassCmpChips`).
  - KPI 2칸(격차·활용도), 막대·표·우선목록·(선택)히트맵 재사용.
- **자매(관리자) 회귀 방지**: `_equityInsight`에 dimLabel 인자를 추가할 경우 기본값 '지역'으로 두어 관리자 호출부 무변경. 공용 헬퍼 수정 시 `npm test`로 equity 회귀 확인.

---

## D. 빈/오류/반응형 (친절 문구)

- **담당 반 < 2**: §A-3 빈상태(클래스 이동 CTA).
- **교과×기간 조합 데이터 없음**(예: 특정 교과로 아무 반도 채점형 0): 전 섹션 대신
  `선택하신 조건({수학 · 최근 30일})에는 비교할 정답률 데이터가 부족해요. 교과나 기간을 바꿔보세요.` (적용 필터 라벨 주입) — 필터 칩은 유지 노출(다시 넓히도록).
- **일부 섹션만 빈**(막대는 있으나 히트맵 표본부족): 그 카드에만 인라인 빈상태(`_seedHintEmpty`).
- **오류**: `tplError('반별 비교 데이터를 불러오지 못했습니다', 재시도)`.
- **반응형**: <768 KPI 2칸→세로 스택, 막대 세로, 표/히트맵 카드 내부 `overflow-x:auto`, **페이지 가로스크롤 0**. 반 이름이 길면 막대 y축 라벨 말줄임(`ticks.callback` clamp).

---

## E. 공통 준수 (전 섹션)

- **공통 UI 스케일**: body17 / h2·섹션 19~20 / 본문16 / 버튼16 / 뱃지13 / 캡션13. **12px 이하·버튼14 이하 금지**(관리자 equity에서 `[코드]`류 12px가 남아있었던 전례 → 신규 코드엔 13px 이상만 사용).
- **가로스크롤 0**: 히트맵·표·막대·드릴 패널은 카드 컨테이너 내부 스크롤. body 가로 0(스모크로 검증).
- **색코딩 일관**: 격차 큼=danger `#dc2626` · 중간=warning `#b45309` · 작음=success `#15803d`. 이중취약/우선관심=danger. `_equityGapTone`·`_equityScoreColor`·`QUAD_BADGE` 재사용(관리자와 동일 팔레트).
- **컴포넌트 재사용 우선**: `kpiCard`·`mkChart`·`renderDataTable`·`.dc-unit-toggle` 칩·`dc-insight-banner`·`dc-state-panel`·`dc-kpi-grid`·`_equityInsight`·`_seedHintEmpty` — 신규 컴포넌트 최소화. **산점도·CV·격차추세만 제외, 나머지 equity 자산 승계.**
- **사용자 중심(진입·현재위치·복귀·빈상태·라벨)**:
  - 진입: 분석 그룹 "반별 비교" 단일 진입, 관리자 지역비교와 동일 형상 → 인지 전이.
  - 현재위치: 필터 칩 `aria-pressed` + 적용 필터 요약칩 + 막대 최하위 강조.
  - 복귀: 표 행 드릴은 인라인 토글(재클릭 접힘, 모달 미로 없음). 필터 "전체"로 되돌리기 항상 가능.
  - 빈상태: 조건별 친절 문구("무엇을 바꾸면 되는지" 안내).
  - 라벨: 초등 교사도 이해할 평이체(반별 비교·우선 관심 반·표본 적음), 카드 제목은 격식 명사형.
- **모달 z-index**: 인페이지 뷰(모달 미사용). 드릴은 인라인 패널. (부득이 모달 시 풀스크린 ≥10000, GNB z9999 위 — 그러나 인라인 권장으로 회피.)
- **자동 검증 하네스(필수)**:
  - BE(`routes/lrs.js`) 수정 후 `npm test` 초록. **신규 불변식 박제**:
    1. class-compare 스코프: 반환 `units`의 id 집합 ⊆ `classes WHERE owner_id=uid AND status='active'` (deleted 클래스 0건).
    2. 마스킹 정책: teacher1(8·6명) 호출 시 `units.every(u=>u.masked===false)` (프라이버시 마스킹 미적용) · 채점형<3 반은 `lowSample===true`.
    3. 담당 반 <2 계정: `insufficientClasses===true` · `units.length<2`.
    4. subject 필터: `subject!=all` 시 avgScore가 그 교과 codeSet 로그로만 산출 · `availableSubjects.present` 일관.
    5. 공용 헬퍼(`_equityInsight` dimLabel 인자화) 수정 시 **equity(admin a-macro) 회귀 없음**(기존 '지역' 문구 유지).
  - FE(`public/lrs/index.html`) 수정 후 `npm run test:e2e:smoke` — teacher 계정 t-classcompare 데스크탑/모바일 순회: 가로스크롤·`[object Object]`·콘솔에러·깨진 %(8000% 등) 0.
- **금지 재확인**: 실제 AI/외부연동 신설 없음. 시드 수기 편집 없음. 전부 기존 로그·집계·규칙기반 문구.

---

# 구현 작업 분해 (PM 배분용 — BE/FE, 재사용/신규 구분)

## Backend (routes/lrs.js) — opus
| # | 작업 | 위치·근거 | 재사용/신규 |
|---|---|---|---|
| BE-1 | `GET /stats/class-compare` 신설(requireAuth + teacher/admin). 소유 active 반 스코프(`owner_id AND status='active'`), 반<2 → `insufficientClasses` | routes/lrs.js (equity 4984 인접에 신설) | **신규(골격)** — `resolveScopeFilter` class 분기 442 패턴 참고 |
| BE-2 | 반별 멤버십 집계(memberIds IN → acts/dur/avg_score/wau/reach). `scoredWhere`·`normScoreExpr`·`subjectCodeSetFilter` 재사용 | 동 엔드포인트 | **재사용 조립** |
| BE-3 | 지표·사분면·priorityUnits: `_equityMetric`·`_pctile`·중앙값 사분면 그대로 | 4939·5120 재사용 | **재사용** |
| BE-4 | **마스킹 정책 분기**: MIN_N 프라이버시 마스킹 미적용, `lowSample`(채점형<3) 플래그만. availableSubjects(`buildAvailableSubjects`) | 동 엔드포인트 | **신규(경량)** |
| BE-5 | (⑥ 선택) `classSubjectMatrix`(반×교과 avg_score, 교과=all일 때만). `_equityScoreColor`와 대응 | 동 엔드포인트 | **신규(선택)** |
| BE-6 | 불변식·회귀 5종 박제(§E) | test/ | **신규 테스트** |

## Frontend (public/lrs/index.html) — opus
| # | 작업 | 위치 | 재사용/신규 |
|---|---|---|---|
| FE-1 | MENUS.teacher에 `t-classcompare`('반별 비교', fa-scale-balanced) 추가(t-warnings 뒤) + LEGACY 매핑 1줄 | 1294·1368 | **수정(1~2줄)** |
| FE-2 | `VIEWS['t-classcompare']` 신설 — a-macro(7767) 골격 복제, API=`/stats/class-compare`, dimLabel='반' | VIEWS 블록 | **신규(재배치+수정)** |
| FE-3 | 필터바 경량본 `_renderClassCmpChips`(교과·기간 2필터, 학교급 제거) + 정의/요약/다중소속 캡션 + `state._ccSubject/_ccPeriod` | _renderEquityChips 7976 기반 | **확장(경량 복제)** |
| FE-4 | ② 인사이트 배너 + KPI 2칸(격차·활용도, CV 라인 제거) | _equityInsight 7717·kpiCard | **재사용+축약** |
| FE-5 | ③ 반별 정답률 막대(aEquityBar 재사용, 최하위 강조, 소표본 접미) | 7876 | **재사용** |
| FE-6 | ④ 상세표(aEquityTable 재사용, 마스킹행 제거·소표본 캡션) + 행클릭 인라인 교과 드릴 | 7954 | **재사용+신규(경량 드릴)** |
| FE-7 | ⑤ 우선 관심 반 목록(#aEquityPriority 재사용, 산점도 미구현) | 7899 | **재사용** |
| FE-8 | (선택) ⑥ 반×교과 히트맵(_renderEquityCrossLevel 골격, 행=반·열=교과, 교과=all만) | 8027 | **재사용(선택)** |
| FE-9 | 빈/오류/반응형 문구(§D), 가로스크롤 0·12px 금지 스모크 | 전 섹션 | **수정** |

## 배분 요령
- **BE 1인(opus)**: BE-1~4 순차(엔드포인트가 화면 전체를 좌우 → 최우선). BE-5(⑥)·BE-6은 뒤. `_equityInsight` 공용화(dimLabel 인자) 시 equity 회귀 `npm test` 필수.
- **FE 1인(opus)**: FE-1~7이 신규 뷰 본체(모놀리식 단일 파일 → 한 에이전트 전담). FE-8은 선택. **BE-4의 `availableSubjects`·`units`(마스킹 정책) 선행** → BE 1차, FE 2차.
- **의존**: FE-3 교과 칩 ← BE-4 availableSubjects. FE-6 드릴 ← BE-5 classSubjectMatrix(또는 by-subject?class_id). FE-8 ← BE-5.
- **검증**: PM+UI디자이너 더블체크(관리자 지역비교와 동일 형상·산점도 미구현·마스킹 정책·12px·가로스크롤 0) → 교사 테스터 E2E(teacher1 2반 비교·교과 필터·빈상태 계정) → 감리 OK.

## 핵심 리스크·검토 포인트 (PM 필독)
1. **소표본 마스킹 함정(★)**: 관리자 `MIN_N=10`을 그대로 이식하면 teacher1의 두 반(8·6명)이 **전부 마스킹되어 빈 화면**. 반드시 §C-2 정책(마스킹 미적용 + lowSample 캡션)으로 구현. BE-4·불변식#2가 방어선.
2. **deleted 클래스 혼입**: `status='active'` 필터 누락 시 fix검증/reject검증 등 테스트 클래스 4개가 비교에 섞임. 불변식#1이 방어선.
3. **멤버십 집계(class_id NULL)**: `learning_logs.class_id` 기준 집계는 자기주도 활동 대부분 누락 → 반드시 **멤버십(user_id IN) 조인**(§0-4). 다른 교사 탭과 동일.
4. **공용 헬퍼 회귀**: `_equityInsight` 등 공유 함수를 dimLabel 인자화할 때 관리자 a-macro 문구('지역') 회귀 없는지 `npm test`.
