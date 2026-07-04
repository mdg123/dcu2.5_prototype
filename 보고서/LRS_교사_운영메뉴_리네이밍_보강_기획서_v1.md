# LRS 교사 "운영" 메뉴 — 리네이밍 · 내용 보강 기획서 v1

- 작성: UI 디자이너(opus)
- 대상 화면: `/lrs/index.html?menu=operations` (교사 로그인) → 뷰 `t-teacher-idx`
- 작성일: 2026-07-05
- 상태: 개발 착수용(Backend + Frontend 동시 지시). 임의 해석 금지, 본 문서 스펙대로 구현.

---

## 0. 프리뷰 실측 근거 (현재 상태 확정)

로그인: `teacher1 / 1234` (김선생, user_id=2, role=teacher). 프리뷰 serverId `120c5c83…`, 뷰포트 1440·375 양쪽 실측.

### 0-1. 현재 렌더 (스크린샷 확인)
2차 상단 탭: `홈 · 현황 분석 · 학습 활동 · 운영`. "운영" 탭에 하위 1개(`t-teacher-idx`). 브레드크럼 = "LRS › 교사 › **운영** › **교사 활용지수**".

현재 뷰 구성(빈약):
- KPI 4개: `작성 콘텐츠 8개(·누적)` / `진행 수업 0건(·기간)` / `개설 평가 7건(·누적)` / `피드백 수 0건(·누적)`
- 막대차트 1개: "나의 지표 구성 / 4개 지표" (콘텐츠·수업·평가·피드백 4개 막대)
- 상태패널: "나의 활용지수 **100**점" — **"상위 N%" 텍스트가 렌더되지 않음**(사유는 0-3)
- 기간칩(최근7/30/90/사용자지정) 존재하나, 아래 지표에 부분만 반영.
- 가로 스크롤: 1440·375 모두 0 (docW=winW). ✅

### 0-2. API 실측 — `GET /api/lrs/stats/teacher-index`
반환 키: `success, scope, period{fromDate,toDate}, metricScopes, teachers[], myIndex`.
`myIndex` (teacher1) = `{class_count:6, contents_authored:8, exams_opened:7, feedback_count:0, lessons_held:0, utilization_score:100, name:"김선생", user_id:2}`.
`teachers.length === 1` (교사 스코프는 서버가 `scope='mine'`로 강제 → 배열 길이 1).
`metricScopes = { contents_authored:'period', lessons_held:'period', exams_opened:'period', feedback_count:'period', class_count:'cumulative' }`.

### 0-3. 실측으로 드러난 결함 3종 (보강 시 반드시 동반 수정)

라이브 DB(`data/dacheum.db`) 직접 조회 결과, 현재 지수 산정이 부정확:

| 지표 | API 반환(teacher1) | DB 실제(teacher_id/owner/creator/author=2) | 문제 |
|---|---|---|---|
| 진행 수업 `lessons_held` | **0** | `lessons` 테이블 소유 **32건** | **소스 오류**. 서버가 `learning_logs.activity_type='lesson_view' AND user_id=2`(=0, 교사는 자기 수업을 lesson_view로 안 남김)를 셈. **`lessons WHERE teacher_id=?`로 교체 필요.** |
| 작성 콘텐츠 `contents_authored` | 8(기간) | `contents` 소유 누적 **183건** | 값 자체는 기간필터라 정상. 단 **FE 서브라벨 "누적" 오표기**(실제 period). |
| 피드백 수 `feedback_count` | 0(기간) | `homework_feedback` author_id=2 누적 **4건** | 기간필터로 최근 0. FE 서브라벨 "누적" 오표기. |
| 활용지수 `utilization_score` | **100** | — | 교사 스코프는 배열 1개 → `maxRaw=본인raw` → **항상 100점**. 무의미(항상 만점). 순위(상위 N%)도 `teachers.length>1` 조건이라 **영구 미표시**. |

> 결론: 현재 화면의 "활용지수 100점"과 "상위 N%"는 **교사에게 아무 정보도 주지 못하는 죽은 지표**다. 리네이밍과 함께 **지수·순위 프레이밍을 폐기하고 "활동 요약 + 추이 + 최근 항목"** 중심으로 재구성한다. `lessons_held` 소스 버그도 이 작업에서 함께 고친다.

---

## 1. 리네이밍 (사용자 노출명)

### 1-1. 문제 정의
- "**운영**"(카테고리) + "**교사 활용지수**"(항목)는 대상이 **교사 본인의 활동/기여**인데, 형제 탭 "**활용 현황**"(`t-usage`, 학급·학생 활동 분석)과 **"활용"이라는 단어가 겹쳐** 혼동. 둘은 대상이 정반대(본인 vs 학급).
- "활용지수"는 모호어 + 실측상 항상 100점이라 **지수라는 명명 자체가 오해**를 부른다.

### 1-2. 후보안

| 안 | 카테고리(교사 운영) | 항목/뷰 제목 | 근거 | 판정 |
|---|---|---|---|---|
| A | **나의 활동** | **나의 수업 활동 요약** | "나의"로 본인 대상 즉시 명시, "활용" 단어 제거로 t-usage와 완전 분리. 초등 교사도 직관 이해. | ✅ **추천** |
| B | 수업 운영 | 나의 수업 운영 현황 | "운영"을 살려 관리자 카테고리와 톤 통일. 단 "운영"이 여전히 추상적, 본인 대상임이 약함. | 차선 |
| C | 나의 기여 | 나의 콘텐츠·수업 기여도 | "기여"가 긍정적이나 다소 격식·거창. "기여도"가 다시 점수/평가 뉘앙스(활용지수와 같은 함정). | 비추천 |

### 1-3. 추천 = 안 A
- **카테고리 라벨(교사 전용)**: `운영` → **`나의 활동`**
- **항목/뷰 제목**: `교사 활용지수` → **`나의 수업 활동 요약`** (메뉴 label), 뷰 헤더 h1도 동일.
- "활용지수"라는 모호어는 **폐기**. 점수/순위 프레이밍을 없애므로 "지수" 단어를 남기면 안 됨.
- 아이콘: 현행 `fa-chalkboard-teacher` 유지(교사 본인 표상, 무난).

### 1-4. 변경 위치 (라인 지정 — 교사 스코프만, 관리자 회귀 금지)

⚠ **카테고리 라벨은 role별 분기 구조가 이미 존재.** `menuLabel(cat, role)`(약 1096줄)가 학생은 `MENU_LABELS_STUDENT`로 오버라이드, 나머지는 `MENU_LABELS` 공용. `operations:'운영'`(약 1088줄)은 **교사·관리자 공유**이므로 여기를 직접 고치면 **관리자 운영 3항목(표준체계·교사 실행지수·데이터 품질) 라벨까지 오염**된다.

→ **교사 전용 오버라이드 맵을 신설**하고 `menuLabel`에 교사 분기를 추가한다. (학생 패턴 그대로 복제)

**(a) 메뉴 항목 label — `public/lrs/index.html` 약 1053줄**
```js
// 변경 전
{ id:'t-teacher-idx',label:'교사 활용지수', icon:'fa-chalkboard-teacher', group:'운영', category:'operations' },
// 변경 후 (label + group 문자열만 교체, id·icon·category 불변)
{ id:'t-teacher-idx',label:'나의 수업 활동 요약', icon:'fa-chalkboard-teacher', group:'나의 활동', category:'operations' },
```
> `group`은 사이드바/브레드크럼 표시용 문자열이므로 함께 `나의 활동`으로. `category`는 `operations` **불변**(라우팅·`MENU_TO_VIEW.operations.teacher='t-teacher-idx'` 유지).

**(b) 교사 카테고리 라벨 오버라이드 신설 — 약 1090~1094줄 (`MENU_LABELS_STUDENT` 바로 아래에 추가)**
```js
/* 교사 전용 카테고리 라벨 오버라이드 — operations 만 '나의 활동'으로.
   관리자 operations('운영' 3항목)는 공용 MENU_LABELS 유지(회귀 방지). */
const MENU_LABELS_TEACHER = {
  operations: '나의 활동'
};
```

**(c) `menuLabel` 헬퍼에 교사 분기 추가 — 약 1096~1100줄**
```js
function menuLabel(cat, role){
  const r = role || state.role;
  if (r === 'student' && MENU_LABELS_STUDENT[cat]) return MENU_LABELS_STUDENT[cat];
  if (r === 'teacher' && MENU_LABELS_TEACHER[cat]) return MENU_LABELS_TEACHER[cat];  // ← 추가
  return MENU_LABELS[cat] || cat;
}
```
> `menuLabel` 호출부(약 7190·7257줄, 상단 탭 aria-label·브레드크럼)는 모두 이 헬퍼를 경유하므로 자동 반영. **관리자·학생은 무영향.**

**회귀 확인 항목(감리)**: admin 로그인 → "운영" 탭이 여전히 `운영`이고 하위 3항목(표준체계 분석/교사 실행지수/데이터 품질) 정상. 교사만 `나의 활동`.

---

## 2. 내용 보강 — 뷰 `t-teacher-idx` 재구성

### 2-0. 재구성 원칙
- **순위·지수·만점 프레이밍 폐기.** 교사 개인에게 "상위 N%"는 관리·압박 성격이고, 실측상 항상 100점이라 정보가치 0. → **중립적 자기 요약**으로 재프레이밍.
- 화면 = 위→아래 4블록: ①이번 기간 활동 요약(KPI) → ②내 활동 추이(라인) → ③내 활동 구성(도넛/막대) → ④최근 내 활동(타임라인/표).
- 기존 헬퍼 재사용: `kpiCard()`, `chartWrap()`, `mkChart()`, `renderDataTable()`, `tplEmpty()`, `tplLoading()`. **새 컴포넌트 신설 최소화**(일관성).
- 공통 스케일 준수: 본문 16px·h1 28~30·섹션 h2 19~20·버튼 16·뱃지 13. **12px 이하 본문·14px 이하 버튼 금지.**

### 2-1. 블록 ① — 이번 기간 활동 요약 (KPI 4장, 존치·라벨 정정)

기존 4카드 유지하되 **서브라벨을 metricScopes와 일치**시킨다(0-3의 오표기 버그 fix).

| 카드 | 값 | 단위 | 서브라벨(정정) | tone |
|---|---|---|---|---|
| 작성 콘텐츠 | `contents_authored` | 개 | **기간** (period) | primary |
| 진행 수업 | `lessons_held`(소스 수정 후) | 건 | **기간** | success |
| 개설 평가 | `exams_opened` | 건 | **기간** | warning |
| 피드백 | `feedback_count` | 건 | **기간** | purple(#8b5cf6) |

- 서브라벨은 `metricScopes[key]==='period' ? '기간' : '누적'`로 **동적 파생**(하드코딩 금지). 4개 모두 period → 전부 "기간".
- **증감 화살표 채우기**: 현재 `{dir:'flat',text:'누적/기간'}`으로 화살표가 죽어있음. BE가 직전 동일기간 대비 델타(2-5의 `prev`)를 주면 `dir:'up'/'down'`, `text:'지난 기간 대비 +N'`으로 채운다. 데이터 없으면 `flat`, text는 "기간".
- 레이아웃: 기존 `.dc-kpi-grid`(4열, <768 2열/1열 자동). 변경 없음.
- 문구: "활용지수" 언급 전면 삭제.

### 2-2. 블록 ② — 내 활동 추이 (신규, 라인차트)

- **목적**: 내 콘텐츠·수업·평가·피드백이 시간에 따라 어떻게 변했나. period 칩 연동(7/30/90/사용자지정 → 버킷 자동).
- 컴포넌트: `chartWrap('tIdxTrend','내 활동 추이','주별 신규 활동 건수')` + `mkChart(type:'line')`.
- 데이터: BE 신규 `trend[]` (2-5). x축=기간 버킷 라벨(주/일), y축=건수. 4개 데이터셋(콘텐츠·수업·평가·피드백) **동일 색 토큰**(#2563eb/#10b981/#f59e0b/#8b5cf6, 블록①③과 통일).
- **빈 상태**: `trend`가 전부 0이면 차트 대신 친절 안내 — "선택한 기간에 기록된 활동이 없어요. 콘텐츠를 만들거나 수업을 진행하면 이곳에 추이가 쌓입니다." (`tplEmpty` 스타일, 아이콘 `fa-chart-line`).
- 인사이트 1줄(선택): `insight` 파라미터로 "이번 기간 활동이 지난 기간보다 N건 늘었어요" 등 요약(상관·요약 수준, 인과주장 금지).
- 레이아웃: `.dc-chart-grid` 1열 풀폭. 높이 `.chart-body` 기존 값. <768 그대로 세로 축소.

### 2-3. 블록 ③ — 내 활동 구성 (기존 막대 → 도넛으로 개선)

- 기존 "나의 지표 구성" 막대는 정보량 적고 순위 프레이밍 잔재. **도넛(구성비)**로 교체해 "내 활동이 어떤 유형에 몰려있나"를 한눈에.
- 컴포넌트: `chartWrap('tIdxMix','내 활동 구성','유형별 비중')` + `mkChart(type:'doughnut')`.
- 데이터: 블록①의 4값(콘텐츠·수업·평가·피드백) 그대로. 색 토큰 동일.
- 도넛 중앙: 총 활동 건수(4지표 합) + "총 활동" 라벨. (기존 도넛 중앙 플러그인 재사용 — 정렬 검증 필수, 메모리 [[project_lrs_perf_detail_fixes]] 중앙정렬 이슈 재발 금지.)
- **주의(비례 검증)**: 도넛 직경 대비 중앙 숫자 크기 — 숫자 `var(--fs-h1)`(28~30), 라벨 13px. 64px 도넛에 20px 텍스트 같은 과대 금지(CLAUDE.md UI디자이너 책임 2).
- 블록②·③을 2열로 나란히(≥1200px), <1200 1열 세로.

### 2-4. 블록 ④ — 최근 내 활동 (신규, 타임라인 표)

- **목적**: "내가 최근에 무엇을 만들었나"를 실제 항목으로. 추상 숫자→구체 활동.
- 컴포넌트: `renderDataTable(container, {columns, rows, initialSort:'date', initialDir:'desc'})` (기존 dc-data-table 재사용, 정렬·우측정렬 지원).
- 컬럼:
  - `날짜`(date, 정렬 desc 기본) — YYYY-MM-DD
  - `유형`(뱃지: 콘텐츠/수업/평가/피드백, 색 토큰 = 블록①③과 동일)
  - `제목`(콘텐츠명·수업명·평가명, 피드백은 "○○ 과제 피드백")
  - `학급`(class_name, 없으면 "-")
- 최근 **10건** 통합 정렬(4개 소스 UNION, created_at desc). 기간칩 반영.
- **빈 상태**: "선택한 기간에 활동 기록이 없어요." + CTA 없음(안내만).
- 레이아웃: 풀폭 `.dc-data-table`. <768 가로 스크롤 방지 — 표는 `overflow-x:auto` **자체 컨테이너**로 감싸 페이지 body 가로스크롤 0 유지(학급 컬럼은 <768에서 숨김 가능).

### 2-5. (선택) 블록 ⑤ — 내 활동과 우리 학급 (가벼운 인사이트)

무리한 인과 금지, **상관·요약 1~2줄**만. 데이터 부족/표본 작으면 **생략**(억지 카드 금지).
- 예: "이번 기간 피드백 N건을 남겼어요. 피드백을 받은 학생의 과제 재제출률은 M%입니다." (요약 서술, `dc-state-panel`).
- BE가 근거 수치를 못 주면 이 블록은 **렌더하지 않음**(빈 카드 금지).
- v1에서는 **선택(후순위)**. BE 여력에 따라 결정.

---

## 3. Backend 데이터 지시 (개발자가 그대로 구현)

엔드포인트 `GET /api/lrs/stats/teacher-index` (`routes/lrs.js` 약 3248~3351줄) 확장. **관리자 `scope='all'` 경로·`teacher-index-dist`는 건드리지 말 것**(교사 경로만).

### 3-1. [버그 fix·필수] `lessons_held` 소스 교체
현행(약 3290줄): `learning_logs WHERE user_id=? AND activity_type='lesson_view'` → 교사는 0. **교체**:
```js
// 교사가 소유(개설)한 수업 건수. lessons.teacher_id 기준, 기간은 lessons.created_at.
lessonsHeld = db.prepare(
  `SELECT COUNT(*) c FROM lessons WHERE teacher_id = ? ${periodWhere}`
).get(tid, ...periodParams).c;
```
(라이브 DB 확인: `lessons` 테이블 존재, 컬럼 `teacher_id, created_at` 有, teacher_id=2 → 32건.)

### 3-2. [필수] 직전 기간 델타 (`prev`) — KPI 화살표용
현재 기간 [from,to]의 **직전 동일 길이 구간** [from-span, from-1]에 대해 4지표를 동일 산식으로 계산해 `prev`로 반환:
```json
"prev": { "contents_authored": N, "lessons_held": N, "exams_opened": N, "feedback_count": N }
```
(daily-snapshot 엔드포인트 3400~3413줄의 prevFrom/prevTo 계산 로직 그대로 참고.)

### 3-3. [필수] 활동 추이 `trend[]` — 블록②
선택 기간을 균등 버킷(기간≤14일→일별, ≤90일→주별, >90→월별)으로 나눠 각 버킷의 신규 4지표 건수:
```json
"trend": [
  { "label": "6/23~6/29", "contents": 3, "lessons": 1, "exams": 0, "feedback": 2 },
  { "label": "6/30~7/6",  "contents": 1, "lessons": 2, "exams": 1, "feedback": 0 }
]
```
- 소스: `contents.created_at`(creator_id), `lessons.created_at`(teacher_id), `exams.created_at`(owner_id), `homework_feedback.created_at`(author_id).
- 교사 본인(req.user.id)만. 버킷 라벨은 한국어 날짜 범위.

### 3-4. [필수] 최근 활동 `recent[]` — 블록④
4개 소스를 UNION, `created_at desc LIMIT 10` (기간 필터 적용):
```json
"recent": [
  { "type":"content", "title":"분수의 덧셈 카드", "class_name":null, "date":"2026-07-03" },
  { "type":"exam",    "title":"3단원 형성평가",   "class_name":"3학년 1반", "date":"2026-07-02" },
  { "type":"feedback","title":"받아쓰기 과제 피드백","class_name":"3학년 1반","date":"2026-07-01" }
]
```
- `type` ∈ `content|lesson|exam|feedback`. 피드백 title은 대상 과제명 조인(없으면 "과제 피드백").
- class_name: lessons.class_id·exams.class_id 조인. 콘텐츠는 학급 없으면 null.

### 3-5. [권장] 순위/지수 제거 정리
- `utilization_score`는 하위호환 위해 응답에 **남겨도 되나**, FE는 더 이상 렌더 안 함. 신규 필드로 대체됐음을 주석.
- (선택) 블록⑤용: 피드백 대상 학생의 재제출률 등은 v1 후순위. 스펙 미확정 시 미구현.

### 3-6. 응답 계약 요약(교사 스코프)
```json
{
  "success": true, "scope": "mine",
  "period": { "fromDate": "...", "toDate": "..." },
  "metricScopes": { "...": "period", "class_count": "cumulative" },
  "myIndex": { "contents_authored", "lessons_held"(수정), "exams_opened", "feedback_count", "class_count", "name" },
  "prev": { "contents_authored", "lessons_held", "exams_opened", "feedback_count" },
  "trend": [ ... ],
  "recent": [ ... ]
}
```
> BE 수정 후 `npm test` 필수(CLAUDE.md). `lessons_held` 소스 교체·기간 반응성 회귀 테스트 추가 권장(teacher_id=2 → 기간 무한대 시 32, 7일 시 축소).

---

## 4. 색 · 스케일 · 상태 · 반응형 (공통 준수)

### 4-1. 색 토큰 (4지표 고정 매핑, 전 블록 통일)
- 콘텐츠 `#2563eb`(primary) · 수업 `#10b981`(success) · 평가 `#f59e0b`(warning) · 피드백 `#8b5cf6`(purple)
- 증감: 증가 `#10b981`·감소 `#ef4444`·보합 회색. (기존 `.kpi-trend up/down/flat` 클래스 사용)

### 4-2. 스케일
- h1(뷰 제목 "나의 수업 활동 요약") 28~30 / 섹션 h2(chartWrap header) 19~20 / KPI value `--fs-h1` / KPI label·서브라벨 14~15 / 뱃지 13 / 표 본문 16 / 표 헤더 15. **12px 이하 금지.**

### 4-3. 상태(진입·현재위치·빈·오류)
- **진입**: 뷰 상단 헤더 "나의 수업 활동 요약" + 부제 "내가 이번 기간에 만든 콘텐츠·수업·평가·피드백을 한눈에 봅니다." (기존 헤더 부제 자리).
- **현재위치**: 상단 탭 "나의 활동" 활성 + 브레드크럼 "LRS › 교사 › 나의 활동 › 나의 수업 활동 요약".
- **빈 상태**: 블록②④ 각각 개별 빈 상태 안내(2-2·2-4). 4지표 전부 0이면 KPI는 0으로 표시하되 추이/최근은 안내 문구.
- **오류**: `!d.success` → `tplEmpty('활동 데이터를 불러오지 못했습니다')` (기존 패턴 유지, "교사활용지수" 문구는 "활동 데이터"로 교체).

### 4-4. 반응형
- **≥1200px**: KPI 4열. 블록②(추이)·③(구성) 2열 나란히. 최근활동 표 풀폭.
- **768~1199px**: KPI 2열. ②③ 각 1열 세로. 표 풀폭.
- **<768px**: KPI 1~2열(기존 grid 자동). ②③ 1열. 표는 `overflow-x:auto` 자체 컨테이너, 학급 컬럼 숨김. **페이지 body 가로 스크롤 0**(1440·375 재검증 의무).

---

## 5. 감리 체크리스트 (완료 판정 게이트)

- [ ] 교사: 상단 탭·브레드크럼이 "나의 활동 / 나의 수업 활동 요약"으로 표기. "활용"·"지수" 단어 화면에서 완전 소거.
- [ ] **관리자 회귀**: admin "운영" 탭 라벨 `운영` 유지 + 하위 3항목 정상(오염 0).
- [ ] 학생 회귀: 학생 카테고리 라벨 무영향.
- [ ] `lessons_held`가 실제 소유 수업 수 반영(0→정상값). KPI 서브라벨 4개 모두 "기간"(metricScopes 파생).
- [ ] 추이 라인·구성 도넛·최근활동 표 렌더. 도넛 중앙 숫자 정렬·비례 정상(과대 없음).
- [ ] 빈 상태 3종(추이·최근·전체0) 친절 안내.
- [ ] 색 토큰 4지표 전 블록 통일. CTA/강조 남발 없음.
- [ ] **가로 스크롤 0** (1440·375 프리뷰 실측 스크린샷 첨부). 겹침·잘림·빈공백 없음.
- [ ] `npm test` 초록불. `npm run test:e2e:smoke` 화면 무결.

---

## 부록 — 참조 코드 위치
- 메뉴 레지스트리(교사): `public/lrs/index.html` 약 1043~1054줄
- 카테고리 라벨 맵·`menuLabel`: 약 1087~1100줄 (학생 오버라이드 패턴 참조)
- `MENU_TO_VIEW.operations`: 약 1107줄 (불변)
- 뷰 구현 `VIEWS['t-teacher-idx']`: 약 2546~2576줄
- 헬퍼: `kpiCard` 1312 · `chartWrap` 1334 · `mkChart` 1274 · `renderDataTable` 1347 · `tplEmpty` 1184 · `tplLoading` 1179 · `sparklineSvg` 1752
- BE 엔드포인트: `routes/lrs.js` 약 3248~3351줄 (`lessons_held` 3290 · 응답 3334)
- 델타·버킷 참고 로직: `routes/lrs.js` daily-snapshot 3400~3419줄
