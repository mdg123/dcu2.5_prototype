# LRS 관리자(교육청) 지역별 성취수준 비교 통합 재편 기획서 v1

- 작성: UI 디자이너(opus) — 관리자 LRS 4개 요청 통합 재편
- 대상 화면: `public/lrs/index.html` 관리자 뷰 — a-home(한눈 현황) · a-svc-ops(서비스 운영 진단·aWeak) · a-macro(거시 비교) · a-equity(형평성)
- **원칙(고정): 코드 수정 없음(본 문서는 구현 스펙). 신규 원자료 수집·외부연동·AI 신설 금지. 기존 `/stats/equity`·`/stats/macro-drill`·`/stats/admin-kpi`·`/weak-trend`·`getWeakTrend` 재사용/확장으로만 해결.**
- 사용자 확정 4건을 그대로 반영. "성취수준 = 채점형 학습활동 평균 정답률(0~100점)"을 전 화면 라벨·툴팁에 병기.

---

## 0. 현 상태 실측 근거 (라이브 admin/1234, 포트 3000 — 2026-07-08)

### 0-1. a-home 주간 활동 추이 — 전체 단일 라인 (요청①의 출발점)
- FE `VIEWS['a-home']`(index.html ~7163). 차트 `aHomeWeek`(~7199)는 `d.weeklyTrend`(전체 8주 count 배열)만 그리는 **단일 라인**.
- 라이브 `weeklyTrend` = `[7주전 5499, 6주전 6098, 5주전 5604, 4주전 5698, 3주전 2582, 2주전 230, 1주전 170, 이번주 9346]`. 학교급 분해 **없음**.
- BE `/stats/admin-kpi`(routes/lrs.js 4436)는 `byLevel`(초·중·고 학생수+기간활동, 라이브: 초 398명/3139건 · 중 164명/2119건 · 고 52명/357건)은 반환하나, **주별×학교급 배열은 없음** → 신규 계약 필요.

### 0-2. a-svc-ops의 aWeak(취약 성취기준 추세 랭킹) — 필터 없음 (요청②)
- FE `aWeakSection`(~7311) → `#aWeakHost`, `renderWeakTrend()`(~7409). 후행 로드로 `/api/lrs/weak-trend?scope=all&limit=15` 1회 호출(7403). **학교급·교과 필터 UI 없음**.
- BE `/weak-trend`(2761)는 `getWeakTrend({userIds,limit})` 호출. userIds = `SELECT id FROM users WHERE role='student'`. `getWeakTrend`(db/lrs-analytics.js 761)는 `lrs_achievement_stats`에서 코드별 도달률 집계 후 `resolveCode(code)`로 `subject`(교과 라벨) 부여. → **school_level은 userIds 축소로, subject는 결과 필터로** 손댈 수 있음(learning_logs 무관).

### 0-3. a-macro(거시 비교) + a-equity(형평성) — 통합 대상 (요청③)
- **a-macro**(`VIEWS['a-macro']` 7501): `지역▸학교급▸학교▸학년▸교과` **5단 브레드크럼 드릴**(`state._macroPath`). `/stats/macro-drill`(4697). 사용자 피드백 = "이 5단 드릴이 이상하다".
- **a-equity**(`VIEWS['a-equity']` 7680): 이미 통합 뷰의 뼈대를 대부분 보유 — 헤드라인 KPI 4칸(라이브: 성취 격차 14.3%p·활성률 1.1%p·1인당활동 2.5배·도달률 31.4%p) + `_equityInsight` 배너 + 지역별 성취 막대 + **우선개입 사분면 산점도(`aEquityScatter`)** + 학교급×지역 히트맵(`_renderEquityCrossLevel`) + 격차 추세 + 상세표. chip은 `단위[지역/학교급] · 기간[30/90]`.
- BE `/stats/equity`(4872): `units·metrics·trend·priorityUnits·crossLevelRegion` 반환. 라이브(dim=region, 30d): 11개 지역(10 표본충족·1 마스킹), 성취 최상위 청주 75.4 ↔ 최하위 괴산 61.1(gap 14.3%p), priorityUnits(both_low)=`괴산·진천·보은`, crossLevelRegion=`초 15.5 · 중 12.4 · 고 1.2`%p.
- **결론**: 통합 뷰는 **a-equity 렌더러를 본체로 삼아**(이미 KPI·히트맵·추세·표 보유) 막대를 1차 비교로 승격 + 교과 필터 신설 + 학교급 dim→필터 전환 + 산점도 제거 + 명칭 개편. a-macro 5단 드릴은 폐지하고 "행 클릭 → 학교 단위 1단 드릴"만 존치.

### 0-4. 교과 코드 저장 실태 — **필터 설계의 핵심 제약** (요청③·④)
- `learning_logs.subject_code`는 **학교급 접미 + 레거시 + 원문 한글이 혼재**: `math-e`·`korean-e`(초), `math-m`(중), `math-h`(고), 대문자 레거시 `MAT`·`KOR`·`SCI`, 심지어 원문 `국어`.
- `subjectLabel(code)`(routes/lrs.js 86)가 이미 정규화: `-[emh]$` 접미 제거 후 `SUBJECT_LABELS` 매핑(대·소문자·한글 모두 수용).
- **따라서 교과 필터는 `WHERE subject_code = ?` 단순 매칭 불가.** 반드시 "요청 교과(canonical) → 해당 교과로 정규화되는 raw code 집합 → `IN (...)`" 방식이어야 함(§A-BE 상세). 라이브 청주 교과 드릴에서 `math-e/m/h`·`MAT`가 모두 "수학"으로 잡히는 것을 확인.
- 표본 현실: 초등은 교과별 충분(수학 167명·국어 166명…), 중·고 특정 교과는 표본 부족(중학교 수학 avgScore null, 고교 수학 2명 마스킹) → **교과×학교급 조합 빈상태 처리 필수**.

---

## 요청 대응 총괄

| # | 요청 | 대상 화면 | 핵심 변경 | 재사용 | 신규 |
|---|---|---|---|---|---|
| A | 거시 비교+형평성 통합 → **"지역별 성취수준 비교"** 단일 뷰, 형평성 탭 제거 | a-macro/a-equity | 필터바(급·교과·기간)·막대 1차·산점도 제거·명칭 개편·학교 1단 드릴 | `/stats/equity`·a-equity 렌더러·히트맵·추세·표·KPI | equity에 `school_level`·`subject` 파라미터 + `availableSubjects` |
| B | 한눈 현황 주간 추이 **학교급별 멀티라인** | a-home | 전체+초·중·고 4라인·범례 | `mkChart(line)` | admin-kpi `weeklyTrendByLevel` |
| C | 취약 성취기준 추세 **학교급·교과 필터** | a-svc-ops(aWeak) | 칩 필터·재조회·빈상태 | `renderWeakTrend`·`/weak-trend`·`getWeakTrend` | weak-trend `school_level`·`subject` 파라미터 |
| D | 성취수준=정답률 명시 | 전 뷰 | 라벨·툴팁·축·표 헤더 병기 | 문구만 | 없음 |

---

# A. 통합 "지역별 성취수준 비교" 뷰 (요청③·④) ★사용자 1순위

## A-1. 메뉴/IA 재편 (MENUS.admin, index.html ~1271)

- **삭제**: `{ id:'a-equity', label:'형평성', ... }` 1줄 제거.
- **개명**: `a-macro` 항목 → `{ id:'a-macro', label:'지역별 성취수준 비교', icon:'fa-scale-balanced', group:'거시 분석', category:'analytics' }`.
  - (아이콘 `fa-scale-balanced`는 기존 형평성 아이콘 — 격차/비교 의미 유지.)
- **현황분석 그룹 내 위치**: `서비스 운영 진단 → 지역별 성취수준 비교 → 활동×성취 교차 → 학습시간 분석` 순(기존 a-macro/a-equity 자리를 하나로 합침).
- **렌더러 배선(권장·최소 churn)**: 현재 `VIEWS['a-equity']` 함수 본체를 **통합 뷰 렌더러**로 확장한 뒤 `VIEWS['a-macro']`에 연결한다(기존 5단 드릴 `VIEWS['a-macro']` 본체는 폐지). 즉 "살아남는 메뉴 id = `a-macro`, 그 핸들러 = (구)a-equity 렌더러 확장본".
  - 이유: a-equity 렌더러가 KPI·히트맵·추세·표를 이미 갖춰 재작성 비용 최소. 사용자 지시("뷰 id는 유지 가능하나 문서에 명시")를 준수하여 **살아남는 id는 a-macro**로 명시.
  - `_equityInsight`·`_renderEquityCrossLevel`·`_equityScoreColor`·`_equityGapTone`·`_renderEquityChips`·`_bindEquityChips` 등 헬퍼는 그대로 재사용(함수명 유지 무방).
- **레거시 호환**: `state`/`setView`에서 구 해시 `#a-equity` 진입 시 `a-macro`로 리다이렉트(setView 폴백 1줄). `LEGACY_MENU_TO_CATEGORY`(1346)의 `'a-equity':'analytics'`·`'a-macro':'analytics'` 매핑은 유지.
- **폐지 코드 정리**: `MACRO_LEVEL_LABEL`·`_macroFiltersFromPath`·브레드크럼(`aMacroBc`)·`state._macroPath` 체인은 제거. 단 **§A-6 학교 1단 드릴**에서 `/stats/macro-drill?level=school`을 재사용하므로 그 호출부만 남긴다.

## A-2. 필터 바 (섹션 ①) — dim 토글을 "필터 3종"으로 교체

기존 `_renderEquityChips`(7953: 단위[지역/학교급]·기간[30/90])를 **학교급·교과·기간 3필터**로 확장. **비교 단위는 지역 고정**(뷰 이름이 "지역별"), 학교급은 dim이 아니라 **스코프 필터**.

```
[ 학교급  ● 전체  ○ 초  ○ 중  ○ 고 ]   [ 교과  ● 전체  ○ 국어  ○ 수학  ○ 영어  ○ 과학  ○ 사회  … ]   [ 기간  ● 30일  ○ 90일 ]
```

- 컴포넌트: 기존 `.dc-unit-toggle` + `.chip`(aria-pressed) 재사용. `_renderEquityChips(level, subject, period)`로 시그니처 확장.
- 상태: `state._eqLevel`('all'|'elementary'|'middle'|'high', 기본 all) · `state._eqSubject`('all'|canonicalKey, 기본 all) · `state._eqPeriod`('30d'|'90d', 기본 30d). (구 `state._equityDim`은 폐지 — 항상 dim=region 호출.)
- **교과 칩은 데이터 주도**: BE `availableSubjects`(present=true인 교과만)로 렌더 → 데이터 없는 죽은 칩 방지. 기본 노출 순서 국어·수학·영어·과학·사회, 그 외(도덕·음악·미술·체육·실과 등)는 뒤. 칩이 많으면 한 줄 내 `flex-wrap`(가로스크롤 0).
- **필터 변경 시 전 섹션 재조회**: 칩 클릭 → 상태 갱신 → `VIEWS['a-macro'](root)` 재호출(단일 API `/stats/equity?dim=region&school_level=&subject=&period=` 1회로 전 섹션 갱신).
- 접근성: 각 그룹 `role="group" aria-label` 유지, 현재 선택 `aria-pressed="true"`. 라벨 글자 15px(var(--fs-body) 600).

## A-3. 섹션 순서·구성 (권장안)

> 헤더 라벨 규칙(요청④): 성취/점수 관련 모든 헤더·축·표 헤더·툴팁에 **"성취수준(정답률)"** 병기. 교과 선택 시 "○○ 정답률"로 적응(예: 수학 → "지역별 수학 정답률").

### ① 필터 바 (§A-2)
- 바로 아래 **정의 캡션 1줄**(항상 노출): `성취수준 = 채점형 학습활동(평가·과제·문항풀이·오늘의 학습 등)의 평균 정답률(0~100점)이에요.` (var(--fs-sm), gray-600)
- 적용 조건 배지: 학교급/교과가 전체가 아니면 `필터: 초등학교 · 수학 · 최근 30일` 요약칩을 캡션 옆에 노출(현재위치 피드백).

### ② 격차 헤드라인 KPI (dc-kpi-grid 4칸) — 기존 유지 + 라벨 정밀화
- 칸: **성취수준(정답률) 격차 %p**(주력) · 활성률 격차 %p · 1인당 활동 배수 · 도달률 격차 %p.
- 성취 칸 제목 `성취 격차` → **`성취수준(정답률) 격차`**(교과 선택 시 `수학 정답률 격차`). subtitle에 `{top}↔{bottom}` 유지(라이브: 청주↔괴산).
- tone: `_equityGapTone`(≥15 danger·8~15 warning·<8 success), 1인당활동 `_equityGapToneX`. CV 보조는 `cvExtra`(kpi-extra 한 줄, "지역 간 산포(변동계수) N% · 낮을수록 고름") 유지.
- 반응형 <768: 4칸 → 2×2.

### ③ 지역별 성취수준(정답률) 막대 — **1차 비교로 승격**
- 기존 `aEquityBar`(7779, indexAxis:'y', 성취 내림차순, 하위 3개 `#dc2626` 강조) 재사용.
- 헤더 `지역별 성취 격차` → **`지역별 성취수준(정답률)`**(교과 선택 시 `지역별 수학 정답률`). subtitle `평균 정답률 내림차순 · 하위 3개 지역 빨강 강조`.
- x축 title `평균 성취점수` → **`성취수준(정답률, 0~100점)`**. 툴팁 afterLabel "하위 3개 — 집중 지원 후보" 유지.
- 데이터: `units`(masked 제외) 그대로.

### ④ 학교급×지역 교차 히트맵 — **학교급=전체일 때만**
- 기존 `_renderEquityCrossLevel`(7993) + `#aEquityCrossLevelSec` 재사용. 셀색 `_equityScoreColor`(빨강↔초록), 마스킹 회색 대각선, 행별 지역격차 + `_equityCrossLevelInsight` 멘트.
- **표시 조건**: `state._eqLevel === 'all'` 일 때만 렌더. 특정 학교급 선택 시 **섹션 통째 숨김**(`sec.style.display='none'`) — 특정 급 안에서 급×지역 교차는 무의미.
  - BE도 `school_level!=all` 이면 `crossLevelRegion:[]` 반환 → FE 기존 "빈배열이면 숨김" 폴백(7999)이 자동 처리(안전).
- 헤더 라벨에 정답률 병기: `초·중·고 각 학교급에서 지역 간 평균 정답률이 얼마나 벌어졌는지`. 교과 선택 시 그 교과 정답률 히트맵.
- 카드 내부 `overflow-x:auto`(`.dc-clr-wrap`) — 지역 11열이 넘쳐도 **페이지 가로스크롤 0**, 카드 안에서만 스크롤.

### ⑤ 우선 지원 후보 지역 — **명칭 개편 + 산점도 제거** (요청③ 핵심)
- 헤더 **`우선개입 후보 진단` → `우선 지원 후보 지역`**.
- subtitle(쉬운 설명, 요청③ 문구): **`활용도와 성취(정답률)가 함께 낮아 먼저 지원이 필요한 지역이에요.`** (교과 선택 시 `수학 활용도와 정답률이 함께 낮은 지역이에요.`)
- **산점도 완전 제거**: `#aEquityScatter` canvas + `scPts` 블록 + `quadShade`·`ptLabels` 플러그인 + `new Chart(scatter)` 전부 삭제(7752~7871 해당 구간).
- **후보 지역 목록만 존치**: 기존 `#aEquityPriority` 카드(7873~7890) 재사용 — 빨강 좌테두리 패널 + `dc-badge--danger` 지역 배지 + `_equityInsight().priority` 멘트.
  - priority 멘트는 이미 평이("…'활용·성취 동반 저조' 구간입니다. 콘텐츠 보급·연수·기기 지원 등 투입 우선순위 후보입니다."). 라벨을 "활용·성취" → "활용도·정답률"로 소폭 순화(초등학생도 이해).
  - 후보 없음: 초록 좌테두리 패널 + "'활용도·정답률 동반 저조' 구간에 해당하는 지역이 없습니다." (기존 폴백 유지).
- 데이터: `d.priorityUnits`(both_low, BE 산정) 그대로 — **사분면 로직은 BE에 남고 FE는 목록만 표시**.

### ⑥ 격차 추세 (라인)
- 기존 `aEquityTrend`(7896, 최근 3구간 성취 격차 %p, masked 점 생략) 재사용. 헤더 `격차 추세`, subtitle `최근 3개 기간 성취수준(정답률) 격차(%p) 추이`. `_equityInsight().trend` 멘트 유지.
- 학교급·교과 필터 반영: BE가 필터 스코프로 3구간 격차 재산출 → 필터별 추세 자동 반영.

### ⑦ 지역별 상세표 — 행 클릭 → 학교 1단 드릴
- 기존 `aEquityTable`(7933) 재사용. 열: 지역 | 학생수 | 활성률(%) | 1인당활동(건) | 평균학습시간(분) | **성취수준(정답률)** | 도달률(%) | 구간(배지). "평균성취" 헤더 → "성취수준(정답률)"(교과 선택 시 "수학 정답률").
- 마스킹 행 회색 "표본 부족" 유지. 구간 배지 `QUAD_BADGE`(이중취약/활용 저조/성취 저조/양호) 유지 — "이중취약" 배지는 ⑤ 우선지원 후보와 색코딩 일치(danger).
- **학교 1단 드릴(계층 드릴 단순화)**: 행 클릭 → **그 행 아래 인라인 확장 패널**(모달 아님)에서 해당 지역의 **학교별 정답률**(내림차순 미니 막대 + 미니표) 노출.
  - 데이터: `/stats/macro-drill?level=school&region=<지역>&school_level=<필터>&subject=<필터>&period=<필터>`(§A-6에서 macro-drill에 subject 필터 추가).
  - 모달 미사용 이유: GNB(`#dacheum-gnb-wrapper` z9999) 겹침·풀스크린 z-index 관리 회피 + 가로스크롤 0 보장. 인라인 패널이 "한 지역만 더 파본다"는 단순 과업에 충분.
  - 재클릭 시 접힘(토글). 표본부족(students<10) 학교는 목록에서 회색 "표본 부족".

## A-4. 성취수준=정답률 라벨링 총괄 (요청④)
| 위치 | 기존 | 변경 |
|---|---|---|
| 정의 캡션 | 없음 | "성취수준 = 채점형 학습활동 평균 정답률(0~100점)" (항상 노출) |
| KPI ② | 성취 격차 | 성취수준(정답률) 격차 / (교과)수학 정답률 격차 |
| 막대 ③ 헤더 | 지역별 성취 격차 | 지역별 성취수준(정답률) / 지역별 수학 정답률 |
| 막대 ③ x축 | 평균 성취점수 | 성취수준(정답률, 0~100점) |
| 히트맵 ④ | …평균 성취… | …평균 정답률… |
| 표 ⑦ 열 | 평균성취 | 성취수준(정답률) / 수학 정답률 |
- 툴팁: 막대·히트맵·KPI 모두 "정답률" 단어 포함. 교과 선택 시 `appliedSubjectLabel`을 문구에 주입.

## A-5. 빈/오류 상태 (친절 문구)
- **표본 충족 지역 < 2**: 기존 `_seedHintEmpty(격차를 산출할 지역 표본이 부족합니다(최소 2개 지역, 각 10명 이상))` + 필터 칩은 유지 노출(다시 넓게 잡도록).
- **교과×학교급 조합 데이터 없음**(예: 고등학교·도덕): 전 섹션 빈이면 → `선택하신 조건(고등학교 · 도덕)에는 집계할 정답률 데이터가 부족해요. 학교급이나 교과를 바꿔보세요.` (적용 필터 라벨을 문구에 삽입). 특정 섹션만 비면 그 카드에 인라인 빈상태(예: 막대는 있으나 추세 표본 부족 → 추세 카드만 "격차 추세 표본이 부족해요").
- **avgScore null(활동은 있으나 채점형 0)**: 해당 지역 막대/셀은 "-" + 표에서 "·", KPI는 표본충족 단위만으로 산출(기존 로직 유지).
- **오류**: `tplError('지역별 성취수준 데이터를 불러오지 못했습니다', 재시도)`.
- 반응형 <768: KPI 2×2 · 막대/추세 세로 스택 · 히트맵/표 카드 내부 스크롤 · **페이지 가로스크롤 0**.

## A-6. BE 계약 — `/stats/equity` 확장 (routes/lrs.js 4872)

기존 반환 전부 유지(하위호환). **파라미터 2종 + 반환 3종 추가.**

```
GET /api/lrs/stats/equity
  params(기존): dim=region|school_level(통합뷰는 항상 region), period=30d|90d, realOnly
  params(신규): school_level = all|elementary|middle|high   (기본 all)
                subject      = all|<canonicalKey>            (기본 all; key 예: korean,math,english,science,social,moral,music,art,pe,practical)

  적용 규칙:
  - school_level != all → aggregate()의 studAgg/logAgg/wauAgg/reachAgg WHERE 에 `AND u.school_level = ?` 추가.
    (dim 은 region 고정 → 지역 비교를 그 학교급으로 스코프.)
  - subject != all → 로그 기반 집계(logAgg/wauAgg/reachAgg/clrScore)의 WHERE 에 `AND ll.subject_code IN (<codeSet>)` 추가.
    studAgg(재학생 분모)는 미변경 → activeRate/actsPerStu 는 "그 교과 활용도"(그 교과로 활동한 학생 비중/1인당 건수)로 해석.
  - codeSet 산출(★ §0-4 제약):
      const raw = db.prepare("SELECT DISTINCT subject_code c FROM learning_logs WHERE subject_code IS NOT NULL").all();
      const codeSet = raw.map(r=>r.c).filter(c => canonicalSubjectKey(subjectLabel(c)) === subject);
      // subjectLabel() 재사용으로 math-e/math-m/math-h/MAT/수학 을 모두 'math' 로 귀속.
      // canonicalSubjectKey(label) = 한글 라벨 → key 역매핑(작은 상수맵). 매칭 raw code 0개면 빈상태.
  - crossLevelRegion: school_level != all 이면 [] 반환(FE 자동 숨김). subject != all 이면 clrScore 에 subject IN 필터 적용(그 교과 히트맵).

  반환(신규):
  - availableSubjects: [{ key, label, present }]   // present = 그 교과로 정규화되는 로그가 현재 필터(급·기간)에 존재
  - appliedLevel: 'all'|'elementary'|...            // FE 요약칩·문구 주입용
  - appliedLevelLabel, appliedSubjectLabel          // '초등학교' / '수학' (전체면 null)
```

- **재사용**: `aggregate()` 내부 4개 서브쿼리에 조건 문자열만 추가(신규 SQL 골격 없음). `scoredWhere`·`normScoreExpr`·`seedFilter`·`MIN_N(=10)`·`_equityMetric`·`crossLevelRegion` 로직 전부 유지.
- **정합**: trend(3구간)도 동일 필터 스코프로 `aggregate(offset)` 호출 → 필터별 추세 자동.
- **신규 원자료·외부연동 없음.**

---

# B. 한눈 현황 주간 활동 추이 — 학교급별 멀티라인 (요청①)

## B-1. 화면 (a-home, index.html ~7186·7199)
- 차트 `aHomeWeek`를 **4라인 멀티라인**으로: 전체(굵은 기준선) + 초·중·고.
- 색: 전체 `var(--chart-1)`(#2563eb, 두께 3), 초 `#10b981`(초록), 중 `#f59e0b`(오렌지), 고 `#8b5cf6`(보라) — 디자인시스템 팔레트·색코딩 일관.
- 범례: `plugins.legend.display=true, position:'top'`(4개). 각 라인 `pointRadius:3, tension:.3`. 전체 라인만 `borderWidth:3`, 나머지 `borderWidth:2`.
- 헤더/서브타이틀: `주간 활동 추이 · 최근 8주 · 학교급별` + 기존 "이번 주 N건(직전주 대비 ±N)" 유지. 서브에 "전체 및 초·중·고 학교급별 활동 건수" 명시.
- 축: y `beginAtZero:true`. (라이브 데이터는 3~1주 전 급감·이번주 급증 = 시드 편중. 멀티라인이 이를 급별로 드러냄 — 정직한 표현. 필요 시 서브에 "예시 데이터가 특정 주에 몰려 굴곡이 있을 수 있어요" 캡션.)
- 빈/부분: `weeklyTrendByLevel` 없거나 특정 급 전부 0 → 그 급 라인 생략(범례에서도 제외) 또는 0 라인 노출 중 택1(권장: 값이 전부 0인 급은 범례에 남기되 라인 0). 전체가 비면 기존 `_seedHintEmpty` 폴백(7204).

## B-2. BE 계약 — `/stats/admin-kpi` 확장 (routes/lrs.js 4504~4514)
```
반환(신규): weeklyTrendByLevel: [
  { weeksAgo:7, total, elementary, middle, high }, ... { weeksAgo:0, ... }   // 8주, 오래된→최근은 FE에서 정렬
]
  SQL: 기존 weekly 쿼리에 JOIN users u ON u.id=ll.user_id + GROUP BY wk, u.school_level.
       초·중·고 3열로 pivot(또는 Map 구성 후 FE pivot). role='student' 필터 권장(학교급 없는 교사 제외).
  전체 라인 = 기존 weeklyTrend 유지(하위호환) 또는 total 합산 사용.
```
- 재사용: 기존 8주 버킷 로직(JULIANDAY /7) 그대로, GROUP BY에 school_level만 추가.

---

# C. 취약 성취기준 추세 랭킹 — 학교급·교과 필터 (요청②)

## C-1. 화면 (a-svc-ops의 aWeak, index.html ~7311·7409)
- `aWeakSection`의 `.ms-head` 우측 `#aWeakConf`(현재 신뢰 배지 자리) 위/옆에 **필터 칩 2줄**:
  ```
  [ 학교급  ● 전체  ○ 초  ○ 중  ○ 고 ]   [ 교과  ● 전체  ○ 국어  ○ 수학  ○ 영어  ○ 과학  ○ 사회  … ]
  ```
- 컴포넌트: A-2와 **동일 chip 컴포넌트**(`.dc-unit-toggle`+`.chip`) 재사용 — 두 화면 필터 UI 통일.
- 상태: `state._weakLevel`(기본 all) · `state._weakSubject`(기본 all). 칩 클릭 → `/api/lrs/weak-trend?scope=all&limit=15&school_level=&subject=` 재호출 → `renderWeakTrend(w)` 재렌더(부분 갱신, 전 뷰 리로드 불필요).
- 교과 칩: BE `availableSubjects`로 데이터 주도(죽은 칩 방지).
- 필터 요약: 선택 시 소제목 아래 "필터: 초등학교 · 수학" 요약칩(현재위치 피드백).
- 빈상태: 필터 결과 랭킹 0 → 기존 `mastery-empty` 톤으로 `선택한 조건(초등학교 · 수학)에서 하락 중인 성취기준이 없어요. 안정적인 추세예요.`(조건 라벨 주입). 표본 부족 → 기존 `lowSampleChip`·신뢰 배지 유지.
- **12px 정리(동반 수정)**: `renderWeakTrend` 표 코드의 `font-size:12px`(7447 `[코드]` 표기)를 **13px(var(--fs-cap))** 로 상향 — 공통 스케일 준수(12px 금지).

## C-2. BE 계약 — `/weak-trend` 확장 (routes/lrs.js 2761)
```
params(신규): school_level = all|elementary|middle|high  (기본 all)
              subject      = all|<canonicalKey>           (기본 all)

적용:
- school_level != all → scope=all userIds 산출 SQL 에 `AND school_level = ?` 추가:
    SELECT id FROM users WHERE role='student' AND school_level = ?
- subject != all → getWeakTrend 결과(out[])를 subject 로 필터.
    getWeakTrend 각 행은 subject(=resolveCode(code).subject_label) 보유 →
    canonicalSubjectKey(row.subject) === subject 인 행만 반환.
    (learning_logs 무관 — lrs_achievement_stats + resolveCode 기반이라 안전.)

반환(신규): availableSubjects:[{key,label,present}], appliedLevelLabel, appliedSubjectLabel
```
- 재사용: `getWeakTrend`(db/lrs-analytics.js 761) 시그니처 유지, subject는 라우트 후처리 필터 또는 `getWeakTrend({userIds,limit,subject})` 인자 1개 추가 중 택1(권장: 라우트 후처리 — 라이브러리 무변경).
- `masked`(n<10) 게이트·`disclaimer` 유지.

---

# D. 공통 준수 (전 항목)

- **공통 UI 스케일**: body17 / h1 28~30 / h2·섹션 19~20 / 본문16 / 버튼16 / 뱃지13. **12px 이하·버튼14 이하 금지**(C-1 12px 상향 포함).
- **가로스크롤 0**: 히트맵(`.dc-clr-wrap`)·상세표·막대·랭킹·학교 드릴 패널은 카드 컨테이너 `overflow-x:auto`로 내부만 스크롤. body 가로스크롤 금지(라이브 a-equity에서 이미 0 확인).
- **색코딩 일관**: 격차 큼=danger #dc2626 · 중간=warning #b45309 · 작음=success #15803d. 이중취약/우선지원=danger. 학교급 라인색(B-1)은 팔레트 고정. `_equityGapTone`·`_equityScoreColor`·`QUAD_BADGE` 재사용.
- **컴포넌트 재사용 우선**: kpiCard·mkChart·renderDataTable·chip(`.dc-unit-toggle`)·`_renderEquityCrossLevel`·`dc-kpi-grid`·`dc-state-panel`·`_equityInsight`·`_seedHintEmpty` — 신규 컴포넌트 최소화. **산점도만 제거, 나머지 equity 자산 전량 승계.**
- **사용자 중심(진입·현재위치·복귀·빈상태·라벨)**:
  - 진입경로: 현황분석 그룹 단일 진입("지역별 성취수준 비교") — 형평성/거시 비교 2개 혼동 제거.
  - 현재위치: 필터 칩 aria-pressed + 적용 필터 요약칩(학교급·교과·기간).
  - 복귀동선: 학교 1단 드릴은 인라인 토글(재클릭 접힘) — 모달 미로 없음. 필터 "전체"로 되돌리기 항상 가능.
  - 빈상태: 조건별 친절 문구(§A-5, C-1)로 "무엇을 바꾸면 되는지" 안내.
  - 라벨: 초등학생도 이해할 평이체(우선 지원 후보 지역, 활용도·정답률 함께 낮음), 카드 제목은 격식 명사형.
- **모달 z-index**: 본 재편은 인페이지 뷰(모달 미사용 권장). 학교 드릴을 굳이 모달로 확장하면 풀스크린 ≥10000(GNB z9999 위) 필수 — 그러나 **인라인 패널 권장**으로 회피.
- **자동 검증 하네스(필수)**:
  - BE(`routes/lrs.js`, `db/lrs-analytics.js`) 수정 후 `npm test` 초록. 신규 불변식 박제 권장:
    1. equity subject 필터: `subject!=all` 시 반환 units의 avgScore 는 그 교과 로그로만 산출(codeSet IN 검증) · availableSubjects.present 일관.
    2. equity school_level 필터: `school_level!=all` 이면 `crossLevelRegion===[]`.
    3. admin-kpi: `weeklyTrendByLevel` 8주 × {total===elementary+middle+high 근사(role=student 스코프 내)} · 길이 8.
    4. weak-trend: `school_level!=all` userIds ⊂ 전체 학생, `subject!=all` 결과 subject 단일.
  - FE(`public/lrs/index.html`) 수정 후 `npm run test:e2e:smoke` — 가로스크롤·`[object Object]`·콘솔에러·깨진 %(8000% 등) 0. admin 계정 a-macro(통합)·a-home·a-svc-ops 데스크탑/모바일 순회.
- **금지 재확인**: 실제 AI/외부연동 신설 없음. 시드 수기 편집 없음. 전부 기존 로그·집계·규칙기반 문구.

---

# 구현 작업 분해 (PM 배분용 — BE/FE, 재사용/신규 구분)

## Backend (routes/lrs.js · db/lrs-analytics.js) — opus
| # | 작업 | 파일·위치 | 재사용/신규 |
|---|---|---|---|
| BE-1 | `/stats/equity`에 `school_level` 파라미터 → aggregate 4서브쿼리 WHERE `AND u.school_level=?` | routes/lrs.js 4888~4944 | **확장**(신규 SQL 없음) |
| BE-2 | `/stats/equity`에 `subject` 파라미터 → codeSet(`subjectLabel` 정규화 IN 리스트)로 logAgg/wauAgg/reachAgg/clrScore 필터 | routes/lrs.js 4904~5084 | **확장** + `canonicalSubjectKey` 소상수맵(신규 15줄) |
| BE-3 | equity 반환에 `availableSubjects·appliedLevel(Label)·appliedSubjectLabel` 추가, `crossLevelRegion` school_level!=all 시 `[]` | routes/lrs.js 5124~5133 | **확장** |
| BE-4 | `/stats/admin-kpi`에 `weeklyTrendByLevel`(주×학교급 pivot) | routes/lrs.js 4504~4532 | **확장**(GROUP BY school_level 추가) |
| BE-5 | `/weak-trend`에 `school_level`(userIds 축소)·`subject`(out 후처리 필터)·`availableSubjects` | routes/lrs.js 2774~2800 | **확장**(getWeakTrend 무변경) |
| BE-6 | (A-6 학교드릴용) `/stats/macro-drill` level=school 경로에 `subject` IN 필터 수용 | routes/lrs.js 4736~4769 | **확장**(선택·A-6 인라인 드릴에 필요) |
| BE-7 | 하네스 회귀·불변식 4종 박제(§D) | test/ | **신규 테스트** |

## Frontend (public/lrs/index.html) — opus
| # | 작업 | 위치 | 재사용/신규 |
|---|---|---|---|
| FE-1 | MENUS.admin: `a-equity` 삭제, `a-macro` 라벨 '지역별 성취수준 비교'·아이콘 fa-scale-balanced. setView 레거시 `#a-equity→a-macro` 리다이렉트 | ~1271, setView | **수정** |
| FE-2 | (구)a-equity 렌더러를 `VIEWS['a-macro']`로 이설·확장, 구 5단 드릴 본체 폐지(macro-drill 호출부는 A-6용만 존치) | 7501~7600, 7680~7950 | **재배치+수정** |
| FE-3 | 필터 바: `_renderEquityChips`를 학교급·교과·기간 3필터로 확장 + `state._eqLevel/_eqSubject/_eqPeriod` + 데이터주도 교과칩 + 정의 캡션·요약칩 | 7953~7977 | **확장** |
| FE-4 | 산점도 제거(`aEquityScatter`·scPts·quadShade·ptLabels·new Chart) | 7752~7871 | **삭제** |
| FE-5 | ⑤ 명칭 개편: 헤더 '우선 지원 후보 지역' + 쉬운 설명, 목록 카드만 존치 | 7752~7756, 7873~7890 | **수정** |
| FE-6 | 라벨링 총괄(성취수준(정답률) 병기·교과별 문구 적응), 히트맵 school_level!=all 숨김 | ②③④⑦ 헤더·축·표 | **수정** |
| FE-7 | ⑦ 상세표 행 클릭 → 학교 1단 인라인 드릴 패널(macro-drill level=school 재사용) | 7933~7949 | **신규(경량)** |
| FE-8 | a-home 주간추이 멀티라인(전체+초·중·고·범례) — `weeklyTrendByLevel` 소비 | 7186, 7199~7206 | **수정** |
| FE-9 | a-svc-ops aWeak 필터 칩(학교급·교과)+재조회+빈상태, `renderWeakTrend` 12px→13px | 7311~7321, 7403, 7447 | **확장** |
| FE-10 | 빈/오류/반응형 문구 정비(§A-5), 가로스크롤 0 스모크 | 전 섹션 | **수정** |

## 배분 요령
- **BE(1인 opus)**: BE-1~7 순차(equity 확장이 A 화면 전체를 좌우 → 최우선). BE-4는 B, BE-5는 C 독립.
- **FE(1인 opus)**: FE-1~7이 A 화면(모놀리식 단일 파일 → 한 에이전트가 A 전담). FE-8(B)·FE-9(C)는 독립 병렬 가능.
- **의존**: FE-3/6/9의 교과 칩은 BE-3/BE-5의 `availableSubjects` 선행. FE-8은 BE-4 선행. → BE를 1차, FE를 2차로.
- **검증**: PM+UI디자이너 더블체크(라벨 병기·산점도 제거·히트맵 숨김·가로스크롤 0) → 교사/관리자 테스터 E2E(필터 조합·빈상태) → 감리 OK.
