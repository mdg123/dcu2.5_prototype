# LRS 관리자(교육청) 효용 제고 기획서 — 교육 격차 모니터링 + 대시보드 신뢰도 정상화 v1

- 작성: 도메인 전문가(LRS·학습분석 + 교육 형평성 + 데이터 품질)
- 대상 화면: `public/lrs/index.html` 관리자 뷰 8종(홈/현황분석/운영/리포트)
- 페르소나: 교육청 **거시 운영자**(개별 학생 미시관리 아님). 시드 = 지역 B(충북), 11개 지역·32개교·학생 616명·로그 85,947행(실 12,906 / 시드 73,041, 합성)
- **원칙: 코드 수정 없음(본 문서는 구현 스펙). 실제 AI/외부연동 신설 금지. 시드 수기 편집 금지 — 집계·표현으로만 해결.**

---

## 0. 현 상태 실측 근거 (파일 + 라이브 admin/1234, 포트 3000)

라이브(관리자 세션)에서 세 결함을 그대로 재현했다. 아래는 **판정 근거(증적)**다.

### 0-1. a-quality (데이터 품질) — KPI 8칸 중 6칸이 껍데기 (확정)
- FE(`VIEWS['a-quality']`, index.html 7768行~)가 읽는 필드: `d.total_logs`, `d.missing_achievement_rate`, `d.missing_duration_rate`, `d.missing_subject_rate`, `d.missing_session_rate`, `d.last_synced`, `d.per_service`.
- BE 응답(`routes/lrs.js` `/dataset-coverage`, 782行)의 **실제 키**: `success, totalStatements, byType, byVerb, byService, totalLearners, totalStudents, totalTeachers, totalAccounts`.
- **라이브 확인**: `cov_keys`에 `missing_*_rate`·`per_service`·`total_logs`·`last_synced` **전부 없음**. `totalStatements=15438`(30일 기본창)만 존재.
- 결과: "로그 총 건수 0건" + 결측률 KPI 4종 전부 `0.0%`(초록·정상 오인) + `per_service null`(추정 테이블로 폴백) + 최근 동기화 `-`.

### 0-2. a-xapi (표준체계 분석) — 표본 63건, A~E·노드정답률 전부 0% (확정)
- 라이브: `/xapi/overview?scope=all` → `total=63`, `/xapi/achievement-distribution?scope=all` → `distribution=[]`(빈 배열).
- 원인: 관리자 뷰가 보는 것은 **실수집 xAPI 스풀(`xapi_statement_spool`)의 실데이터**이며, 이 실표본이 63건이고 그중 `achievement_level`이 채워진 행이 사실상 0 → A~E·노드정답률 0%. (참고: 로컬 스풀 총 12,358건은 대부분 합성/미표준화라 A~E 산출 불가.)
- 이건 **버그가 아니라 "실 xAPI 표준 표본이 아직 안 쌓인 상태"**다. → 억지 정상화(가짜 채움) 금지. **정직한 빈상태**로 정상화.

### 0-3. a-svc-ops (서비스 운영 진단) — 시드 골짜기發 과경보 (확정)
- 라이브 8개 서비스 추세Δ: content −12.3(정상), self-learn **−76.3**, class **−74.8**, cbt **−68.4**, growth **−77.7(critical)**, lrs **+100(critical·신규)**, portal **−74.1(critical)**, survey **−74.5(critical)**.
- 원인: `/stats/service-ops`(4435行)의 추세Δ = 최근 `days`(기본 30일) vs **직전 동기간 30일**. 시드 로그가 3~5월에 집중(로그 min `2026-03-16`, max `2026-07-07`)돼, 6월→7월 트레일링 창이 합성 데이터 절벽을 가로질러 **−70%대 급감**이 7종 동시 발생.
- 현 disclaimer는 "최근 급증은 시드 영향일 수 있어요"로 **급증만 커버**. 급감(−) 방향 미커버. 최소 표본·절대량 게이트도 없음 → 저활용 판정이 표본 5건 서비스에도 발동.

### 0-4. a-macro (거시 비교) — 견고, 격차 모니터링의 토대 (재사용)
- `/stats/macro-drill`(4549行): **지역▸학교급▸학교▸학년▸교과** 체인 드릴 + 단위별 학생수·활동량·1인당 학습시간(분)·평균성취 + `MIN_N=10` 표본부족 마스킹. 이미 지역별 평균성취 비교 막대까지 제공.
- **결론: Track 1 격차 지표는 신규 뷰를 만들되, 데이터는 macro-drill을 그대로 소비**(신규 BE 1개 = 지표 계산기)해서 정합·마스킹을 100% 재사용한다.

### 0-5. 실측 결측 구조(품질 KPI 설계의 핵심 입력)
전 로그 85,947행 기준 단순 NULL 비율: 성취 23.3% · 교과 9.4% · 시간 14.5% · 세션 85.3%.
그러나 **activity_type별로 "결측이 정당한지"가 완전히 다르다**(아래 표). 이 구조가 Track 2-A 설계의 근거다.

| activity_type | n | 성취 NULL | 시간 NULL | 세션 NULL | 성취코드가 **당연히** 없어야 하나? |
|---|---:|---:|---:|---:|---|
| content_view | 39,935 | 3,525 | 11,854 | 27,930 | ✔ 조회(성취 무관) |
| self_learn | 10,320 | 4,051 | 0 | 10,245 | ✘ 채점형 — 있어야 함 |
| lesson_view | 7,440 | 3,005 | 0 | 7,324 | ✔ 조회 |
| content_complete | 7,371 | 839 | 0 | 7,371 | △ 이수(성취 선택적) |
| exam_complete | 5,444 | 2,109 | 189 | 5,230 | ✘ 채점형 — 있어야 함 |
| wrong_note_retry | 3,775 | 1,544 | 59 | 3,775 | ✘ 채점형 — 있어야 함 |
| homework_submit | 3,047 | 1,246 | 479 | … | ✘ 채점형 — 있어야 함 |
| attendance_checkin | 2,308 | 984 | — | — | ✔ 출석(성취 무관) |
| survey_respond | 726 | 294 | — | — | ✔ 설문(성취 무관) |

→ **세션 결측 85%는 "결함"이 아니라 대부분 세션 개념이 없는 조회/출석 로그**다. 전체 로그 분모로 결측률을 내면 "정상 데이터를 불량으로 오탐"한다. **분모를 "결측이 의미 있는 activity_type"로 한정**해야 KPI가 의미를 갖는다(2-A의 핵심).

---

## 벤치마크(지표 선택 근거, 평이한 것 우선)

교육청이 별도 학습 없이 읽을 수 있는 표준 형평성 지표로 한정한다.

- **OECD PISA ESCS 형평성 관점** — "성취의 사회·지역 배경 의존도를 줄이는 것"이 형평성. 우리는 배경변수(ESCS) 데이터가 없으므로 **지역·학교급 단위 성취/활용 격차**를 대리 지표로 사용.
- **국가수준 학업성취도평가(NAEA)의 지역 격차 보고 방식** — "기초학력 미달 비율의 지역 간 격차(%p)"를 표준 보고 단위로 사용 → 본 기획도 **최상위–최하위 격차(pp)**를 1차 헤드라인 지표로 채택(직관적).
- **KERIS 디지털 활용 격차** — 활용(접속률·1인당 활동)과 성취를 분리해 보되, "활용이 낮으면서 성취도 낮은" 이중취약을 우선개입 대상으로 식별하는 프레임을 차용 → 본 기획의 **우선개입 사분면(2사분면=이중취약)**에 반영.
- **분산 지표는 변동계수(CV) 하나만** 노출(표준편차/평균, 단위 무관 비교 가능·계산 단순). 지니/애킨슨은 교육청 이해 난이도가 높아 **미채택**(내부 근거로만 CV 사용).

---

# Track 1 — 교육 격차 모니터링 (형평성)  ★사용자 1순위

## T1-0. 무엇을 보는가 (스코프 확정)
- **활용 격차**: ①활성률(WAU/재학생) ②1인당 활동량 ③1인당 학습시간(분) — 지역·학교급 단위.
- **성취 격차**: ④평균 성취(0~100, 채점형만·정규화) ⑤도달률(성취기준 도달 학생 비중) — 지역·학교급 단위.
- **단위**: 기본 **지역(11개)**과 **학교급(초·중·고)**. 학교 단위는 드릴 시에만(마스킹 게이트 통과분). **학급·개인 단위 없음**(거시 운영자 스코프).
- **지표 데이터 출처**: 전부 `/stats/macro-drill`이 이미 반환하는 `children[]`(students·acts·avgActsPerStudent·avgLearnMin·avgScore·masked). **신규 원자료 수집 없음.**

## T1-1. 격차 지표(교육청이 읽을 4종만)
각 지표(활성률/1인당활동/평균성취/도달률)를 지역 배열에 대해 계산:

1. **격차(pp 또는 배수)** = 최상위 단위 − 최하위 단위. `헤드라인`. (성취·도달률·활성률은 %p, 활동량은 "N배" 표기)
2. **사분위 범위(IQR)** = Q3 − Q1. 극단값에 둔감한 "허리 격차". `보조`
3. **변동계수(CV)** = 표준편차/평균 ×100(%). 단위 무관 산포. `보조(내부·툴팁)`
4. **하위 20% 평균 대비 전체 평균 비(%)** = "가장 뒤처진 지역들이 평균의 몇 %인가". `직관 보조`

> 표본부족(students < 10) 단위는 지표 계산에서 **제외**하고 "표본 부족 N개 제외"로 명시(마스킹 규칙 준수, macro-drill의 `masked` 그대로 사용).

## T1-2. 우선개입 대상 식별 (활용×성취 2×2)
지역을 (활용 중앙값, 성취 중앙값) 기준 4사분면에 배치:

| | 성취 高 | 성취 低 |
|---|---|---|
| **활용 高** | ① 양호 | ③ 활용多·성취低(학습질 점검) |
| **활용 低** | ④ 활용少·성취高(효율/외부요인) | ② **이중취약(최우선 개입)** |

- **② 이중취약 = 자원 투입 1순위**. 자동 하이라이트(빨강 테두리 + "우선개입" 배지).
- 각 지역 점에 renderInsights 멘트 부여(아래 T1-5).

## T1-3. 격차 추세(시간축)
- 최근 3개 기간(예: 최근 30일 / 직전 30일 / 그 이전 30일)에 대해 **헤드라인 격차(pp)**만 3점 라인으로. "격차가 벌어지는가/좁혀지는가"를 한눈에.
- 데이터: macro-drill을 period 파라미터만 바꿔 3회 호출(FE) 또는 신규 BE가 3구간을 한 번에 반환(권장, 아래 T1-6).
- 표본부족 기간은 점 생략 + "표본 부족" 표기.

## T1-4. 신규 뷰 vs a-macro 확장 — **신규 뷰 권고**
- **권고: 신규 관리자 뷰 `a-equity`(형평성) 1개 추가**, a-macro는 그대로 둔다.
- 근거:
  - a-macro는 **드릴다운 탐색**(어디로 파고드나) 도구, a-equity는 **격차 진단**(어디가 벌어졌나) 도구 — 사용자 과업이 다르다. 한 화면에 섞으면 둘 다 흐려진다.
  - a-macro의 브레드크럼/드릴 상태(`state._macroPath`)와 충돌 없이 독립 배치 가능.
  - 데이터는 macro-drill을 재사용하므로 BE 신규 비용은 "지표 계산기" 1개뿐.
- 배치: 상단탭 **현황분석** 그룹, a-macro 바로 **다음** 순서(MENUS.admin에 `a-equity` 항목 1줄 추가). 별칭(ADMIN_VIEW_ALIAS) 불필요.

## T1-5. 행동 유도 멘트 (renderInsights 패턴 — 규칙기반, AI 아님)
이 프로젝트에 이미 있는 규칙기반 분석멘트 컴포넌트(교사 현황분석 `renderInsights`, a-cross `_crossInsight`)와 **동일 톤·동일 구조**로 신설 `_equityInsight()`:

- 헤드라인: `"지역 간 평균 성취 격차는 {gap}%p입니다. {top}(최상위)와 {bottom}(최하위)의 차이로, {판정}."`
  - gap ≥ 15 → "격차가 큽니다. 하위 지역 집중 지원을 검토하세요."
  - 8 ≤ gap < 15 → "중간 수준 격차입니다. 추세를 함께 확인하세요."
  - gap < 8 → "격차가 크지 않습니다."
- 추세: `"최근 3개 기간 격차가 {↑벌어짐/→유지/↓좁혀짐}. {직전 대비 Δpp}"`
- 우선개입: `"{지역명} 등 {n}개 지역이 '활용·성취 동반 저조' 구간입니다. 콘텐츠 보급·연수·기기 지원 등 투입 우선순위 후보입니다."`
- 문구는 **초등학생도 이해할 평이한 한국어**, 카드 제목은 **격식 명사형**("지역 간 성취 격차", "우선개입 후보 지역").

## T1-6. 실명 노출/마스킹 정책 준수
- 기존 정책 확인 결과: macro-drill은 `MIN_N=10` 미만 단위를 값 마스킹("표본 부족"), 개인/학급 단위 미제공. LRS 위기/미달 담임 실명은 **audit 로그를 남기는 경우에만** 허용(project_school_dashboard).
- 본 뷰는 **지역·학교급까지만 실명**(공개 행정단위라 안전), **학교 실명은 드릴 시 마스킹 통과분만**. 개별 학생 절대 미노출. 별도 audit 불필요(집계 열람).

## T1-7. 신규 API (BE 1개)
```
GET /api/lrs/stats/equity
  params: dim=region|school_level (기본 region), period=30d|90d, realOnly
  반환:
  {
    success, dim, period, realOnly, minSample:10,
    units: [{ id, label, students, activeRate, avgActsPerStudent, avgLearnMin,
              avgScore, reachRate, quadrant:'both_low|use_low|ach_low|good', masked }],
    excludedMasked: n,
    metrics: {
      activeRate:  { gapPP, iqr, cv, bottom20Ratio, top:{id,label,v}, bottom:{id,label,v} },
      avgScore:    { gapPP, iqr, cv, bottom20Ratio, top, bottom },
      actsPerStu:  { gapX,  iqr, cv, ... },
      reachRate:   { gapPP, iqr, cv, ... }
    },
    trend: { metric:'avgScore', points:[{periodLabel, gapPP, masked}] },  // 최근 3구간
    priorityUnits: [ ...quadrant==='both_low' units ],
    insights: { headline, trend, priority }   // 규칙기반 문장(서버 생성 or FE 생성 택1)
  }
```
- **재사용**: 내부적으로 macro-drill의 학생/로그 집계 SQL(`studAgg`/`logAgg`, scoredWhere·normScoreExpr·seedFilter·MIN_N)을 그대로 호출/복제. reachRate(도달률)는 기존 mastery 도달 기준(att≥3 & 정답률 지표)을 지역 단위로 롤업(lrs-mastery 헬퍼 재사용) 또는 v1은 "평균성취 ≥ 기준선(예 60) 학생 비중"의 간이 정의로 시작(문서에 정의 명시).
- **신규 원자료·외부연동 없음.**

## T1-8. 화면 배치(a-equity) — 와이어프레임
```
[탭: 현황분석 ▸ 형평성(신규)]
① 지표 스위처 chip: [지역] [학교급]  ·  기간 chip: [30일][90일]   (a-macro와 동일 chip 컴포넌트)
② 헤드라인 KPI 4칸(dc-kpi-grid): 성취 격차 {gap}%p / 활성률 격차 {gap}%p / 1인당 활동 {gap}배 / 도달률 격차 {gap}%p
   - 각 칸 tone: gap 큰 지표는 danger, 중간 warning, 작음 success (기존 kpiCard 색코딩 재사용)
③ [분석 멘트 카드] _equityInsight().headline  ← renderInsights 톤
④ [지역별 격차 막대] 가로 막대(성취 내림차순), 최하위 3개 빨강 하이라이트. a-macro의 mkChart(indexAxis:'y') 재사용
⑤ [우선개입 사분면 산점도] x=1인당활동, y=평균성취, 2사분면(이중취약) 음영 + 라벨. a-cross 산점도 스타일 재사용, 표본부족 제외
   - 하단 [우선개입 후보 카드]: 이중취약 지역 리스트 + priority 멘트
⑥ [격차 추세 라인] 최근 3구간 헤드라인 격차(pp) 3점 + trend 멘트
⑦ [상세 표] renderDataTable: 지역 | 학생수 | 활성률 | 1인당활동 | 평균학습시간 | 평균성취 | 도달률 | 구간(배지)
   - 표본부족 행은 "표본 부족" 회색 표기(값 마스킹), 정렬 가능
```
- 빈 상태: 표본 충족 지역 < 2개면 "격차를 산출할 지역 표본이 부족합니다(최소 2개 지역, 각 10명 이상)" `_seedHintEmpty` 재사용.
- 오류 상태: `tplError('형평성 데이터를 불러오지 못했습니다', 재시도)`.
- 반응형: <768px에서 KPI 4칸 → 2×2, 산점도/막대 세로 스택, 표는 컨테이너 `overflow-x:auto`로 **페이지 가로스크롤 0** 보장(카드 내부만 스크롤).

---

# Track 2 — 대시보드 신뢰도 정상화 (결함 3건)  ★사용자 2순위

## 2-A. a-quality — 의미 있는 데이터 품질 KPI 재정의 + 계약 정합

### 2-A-1. "무엇을 결측으로 볼 것인가" (핵심 정의)
전체 로그 분모는 오탐을 낳는다. **필드별로 "결측이 정당한 activity_type"을 제외한 분모**를 쓴다.

| 품질 필드 | 분모(측정 대상 activity_type) | 제외(결측이 정당) |
|---|---|---|
| **성취기준(achievement_code)** | 채점형 7종: exam_complete, homework_submit, content_solve, self_learn, daily_complete, wrong_note_retry, node_complete (= 기존 `LRS_SCORED_TYPES_SQL_LIST`) | content_view·lesson_view·attendance·survey·post_* 등(성취 개념 없음) |
| **교과(subject_code)** | 위 채점형 7종 + content_complete(콘텐츠는 교과 태깅 대상) | attendance·survey·governance·post_* |
| **학습시간(duration_sec)** | 시간이 의미있는 유형: exam/homework/self_learn/content_solve/lesson_progress + content_view(체류) | attendance·survey·post_view(순간 이벤트) |
| **세션(session_id)** | **v1 비노출 권고** — 85% "결측"의 대부분이 세션 개념 없는 조회/출석. 측정 분모 정의가 불명확 → KPI에서 제거하고 "세션 커버리지"는 로드맵(P2)로 이관 |

> 이렇게 하면 "정상 데이터를 불량으로 오탐"이 사라지고, **성취기준 결측률**이 "채점했는데 성취기준 태깅이 빠진 로그 비율"이라는 **행동 가능한 의미**를 갖는다(→ 서비스 로거 풍부화 T-C 대상 식별).

### 2-A-2. BE 계약 확장 (`/dataset-coverage` — FE 필드명과 정확히 일치)
기존 반환 유지(하위호환) + **FE가 읽는 필드 추가**:
```
// 기존 유지: totalStatements, byType, byVerb, byService, totalLearners, totalStudents, totalTeachers, totalAccounts
// 추가:
total_logs: totalStatements,               // 즉시 정상화(별칭)
missing_achievement_rate: <채점형 분모 기준 %, 소수1>,
missing_subject_rate:     <채점형+content_complete 분모 기준 %>,
missing_duration_rate:    <시간의미 유형 분모 기준 %>,
// missing_session_rate 미제공 → FE는 이미 'missing_session_rate==null → "제공 안됨"' 처리 로직 보유(7795행). 계약상 생략 OK.
last_synced: <MAX(created_at) 포맷 'YYYY-MM-DD HH:MM'>,
per_service: [ { service, service_label, total,
                 missing_achievement, missing_subject, missing_duration } , ... ]
             // 서비스별: 위 "정당 분모" 규칙을 서비스 내부에서도 동일 적용한 결측 건수
denominators: { achievement, subject, duration }  // 각 KPI 분모 로그 수(투명성·툴팁용)
```
- 계산 SQL: `scoredWhere` 화이트리스트 재사용. duration 결측 = `duration_sec IS NULL/0 AND result_duration 없음`. 모든 집계에 `demo%`/`realOnly`/기간(`dateRangeWhere`) 필터 기존 규칙 유지.
- **FE 변경 최소**: FE는 이미 이 필드명들을 읽도록 작성돼 있음(7776~7797行) → BE만 채우면 **KPI 8칸 즉시 정상화**. `per_service`가 채워지면 "서비스별 결측률 상세" 테이블이 자동 활성(7838行 분기).

### 2-A-3. KPI 카드 문구·툴팁(오해 방지)
- 각 결측률 카드 부제에 **분모 명시**: "채점형 로그 {denominators.achievement}건 중" 식. 20%↑ danger·10~20% warning·이하 success(기존 `tone()` 유지, 초록=정상 오인 해소됨: 이제 0%가 아니라 실제 비율).
- "세션 결측률" 카드는 **제거**(또는 "세션 커버리지(로드맵)" 회색 비활성). 12px 금지·body17 스케일 유지.

### 2-A-4. 상태
- 빈: 로그 0건이면 "집계할 로그가 없습니다" `tplEmpty`. 오류: 기존 처리.
- 반응형: dc-kpi-grid 2×N, 표 카드 내부 스크롤(가로스크롤 0).

## 2-B. a-xapi — 정직한 데이터부족 빈상태

### 2-B-1. 판정: 억지 정상화 금지, "표본이 쌓이면 채워진다" 안내
- 라이브 total=63, achievement-distribution=[] 확인 → **실 xAPI 표준 표본 부족**이 사실.
- `_renderXapiAnalysis`(7906行) 진입부에서 **표본 게이트** 추가(신규 상수):
```
const XAPI_MIN = 200; // 표준 분석 최소 표본(제안)
if (ov.total < XAPI_MIN) {
  root.innerHTML = tplXapiInsufficient(ov.total, XAPI_MIN);  // 아래 빈상태
  return;
}
```
- **빈상태 카드 `tplXapiInsufficient(total, min)`** (신규 FE 헬퍼, BE 무변경):
  - 아이콘 + 제목 "xAPI 표준 표본이 쌓이는 중입니다"
  - 본문(평이·정직): "현재 표준(xAPI) 형식으로 수집된 학습 기록은 **{total}건**입니다. 성취수준(A~E) 분포와 노드별 정답률은 표본이 **{min}건 이상** 모이면 자동으로 표시됩니다. 그때까지는 '현황분석' 탭의 활동·성취 지표를 이용하세요."
  - 수집 현황 미니 KPI는 **정직하게 노출**: 총 {total}건 / 최근 7일 {recent7d}건 / 미전송 {unsent}건(overview가 이미 반환) — "0%가 아니라 실제 표본 크기"를 보여줘 신뢰.
  - CTA(보조): [현황분석 탭으로 이동] 링크(a-macro/a-cross로 setView).
- 부분 데이터: total ≥ min이어도 achievement-distribution 빈배열이면 그 섹션만 "성취수준 태깅 표본 부족" 인라인 빈상태(전체 화면은 렌더).

### 2-B-2. 상태·스케일
- 12px 금지, 본문 16px/line-height 1.7. 빈상태는 `dc-state-panel` 톤 재사용. 반응형 세로 스택. 가로스크롤 0.

## 2-C. a-svc-ops — 시드 과경보 완화(문맥화)

### 2-C-1. 세 가지 게이트(택1 아님, 3개 동시 적용 권고)
BE `/stats/service-ops`(4483~4518行 룰) 보완:

1. **절대량 게이트**: 현재기간 `count < MIN_ABS`(제안 30) 또는 직전기간 `prevCount < MIN_ABS`면 **추세Δ를 경보로 승격 금지**(status='표본 부족'·severity='info'). 라이브에서 survey(726건 전체지만 최근30일 표본이 얇음)·lrs(신규 +100%) 같은 소표본 급변이 걸러진다.
2. **급감 방향 disclaimer 확장**: 현 문구(7246行) "최근 급증은 시드 영향일 수 있어요" → **"최근 급증·급감은 예시(시드) 데이터가 특정 기간에 몰려 생긴 착시일 수 있어요. 절대 활동량과 함께 보세요."** (급감 커버 + 절대량 병독 유도).
3. **경보 톤 다운(시드 구간 인지)**: `realOnly=0`(시드 포함) 기본 상태에서 추세Δ 기반 '사용 급감' severity를 **warn→caution**으로 강등하고, status 라벨을 "사용 감소(예시데이터 영향 가능)"로. `realOnly=1`일 때만 원래 강도 경보. → 시드가 섞인 기본 화면에서 빨강 남발 제거.

### 2-C-2. BE 반환 보강(계약)
```
services[].dataSufficient: (count>=MIN_ABS && prevCount>=MIN_ABS)   // FE가 경보 표시 여부 판단
services[].seedInfluenced: (realOnly===false)                       // 톤다운 트리거
period 표기와 "직전 동기간" 창을 카드에 명시(오해 방지)
```
- 진단 카드(underused)는 `dataSufficient===false`면 "표본 부족 — 판단 보류"로 분리 렌더(빨강 아님, 회색 info).

### 2-C-3. 상태·스케일
- 급증/급감 chip(`_deltaChip`) 색은 유지하되, `dataSufficient===false`면 chip 회색 처리. 12px 금지. 가로스크롤 0(랭킹·표 카드 내부 스크롤).

---

# 우선순위·단계 롤아웃 (교육청 승인 단위)

## P0 (신뢰도 즉효 — 먼저 승인·배포) — 반나절~1일
- **2-A** a-quality 계약 정합: `/dataset-coverage`에 `total_logs·missing_*_rate(정당 분모)·last_synced·per_service` 추가. FE 무변경으로 KPI 8칸 즉시 정상화. (하네스: `npm test`에 "결측률 분모=채점형 화이트리스트" 불변식 + "total_logs===totalStatements" 회귀 박제)
- **2-B** a-xapi 정직한 빈상태(FE `tplXapiInsufficient` + 표본 게이트). BE 무변경.
- **2-C** a-svc-ops 절대량 게이트 + 급감 disclaimer + 시드 톤다운.

## P1 (형평성 코어 — 사용자 1순위 본체) — 2~3일
- **T1** a-equity 신규 뷰 + `GET /stats/equity`(macro-drill 재사용). 지표 4종·헤드라인 격차·우선개입 사분면·상세표·renderInsights 멘트. MENUS.admin 1줄 추가.
- 하네스: 격차 지표 불변식(gap = top−bottom·CV≥0·표본부족 제외·마스킹 준수) + reachRate 정의 회귀 박제.

## P2 (심화 — 후속) — 여유 시
- 격차 **추세 라인**(3구간)·CV 툴팁 노출.
- a-quality "세션 커버리지" 지표 정식화(세션 의미 유형 재정의 후).
- a-equity 학교급×지역 교차(초·중·고 별 격차 분리).

---

# 공통 준수(전 항목)
- **공통 UI 스케일**: body17 / h1 28~30 / h2·섹션 19~20 / 본문16 / 버튼16 / 뱃지13. **12px 이하·버튼14 이하 금지**.
- **가로스크롤 0**: 표·산점도·막대·랭킹은 카드 컨테이너 `overflow-x:auto`로 내부만 스크롤. 페이지 body 가로스크롤 금지.
- **모달 z-index**: 본 기획은 인페이지 뷰라 모달 없음. 드릴 상세를 모달로 확장 시 풀스크린 ≥10000(GNB `#dacheum-gnb-wrapper` z9999 위).
- **색코딩 일관**: 격차 큼=danger(#dc2626), 중간=warning(#b45309), 작음=success(#15803d). 기존 kpiCard/배지 색과 통일.
- **컴포넌트 재사용**: kpiCard·mkChart·renderDataTable·chip·dc-kpi-grid·dc-state-panel·_deltaChip·renderInsights 톤 — **신규 컴포넌트 최소화**.
- **정합 검증(하네스 필수)**: BE(`routes/lrs.js`) 수정 후 `npm test` 초록 확인, FE 수정 후 `npm run test:e2e:smoke`로 가로스크롤·[object Object]·콘솔에러 0.
- **금지 재확인**: 실제 AI/외부연동 신설 없음(전부 기존 로그·집계). 시드 수기 편집 없음(2-C는 집계·표현·게이트로만 해결).

---

# 데이터 소스·재사용 매핑 요약

| 항목 | 기존 재사용 | 신규 BE | 신규 FE |
|---|---|---|---|
| T1 a-equity | macro-drill SQL(studAgg·logAgg)·scoredWhere·normScoreExpr·seedFilter·MIN_N·mastery 도달헬퍼·kpiCard·mkChart·renderDataTable·산점도 | `GET /stats/equity` 1개 | `VIEWS['a-equity']`+`_equityInsight()`, MENUS.admin 1줄 |
| 2-A a-quality | dateRangeWhere·scoredWhere·SERVICE_LABELS·FE 렌더(무변경) | `/dataset-coverage` 필드 확장 | 없음(카드 문구·세션칸 제거만 소량) |
| 2-B a-xapi | xapi/overview(무변경)·dc-state-panel | 없음 | `tplXapiInsufficient()`+게이트 |
| 2-C a-svc-ops | service-ops 룰·_deltaChip·renderDataTable | 절대량 게이트·계약 2필드·disclaimer | 카드 톤/문구 소량 |
