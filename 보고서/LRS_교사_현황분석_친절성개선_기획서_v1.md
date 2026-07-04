# LRS 교사 "현황 분석" 친절성 개선 기획서 v1

- 작성: UI 디자이너(opus)
- 대상 화면: `/lrs/index.html?menu=analytics` → 서브탭 "현황 분석"(`.lrs-tab`) 3개(성취 도달 현황 · 교과별 활동 현황 · 활용 현황)
- 계정: teacher1(김선생), classId 1 / teacherId 2
- 검증일: 2026-07-04 (오늘). 프리뷰 serverId `3f4b8553…`, 데스크탑 1440 / 모바일 375 실측.
- 목표: 사용자(충북교육청) 5개 불만 → "친절한 인터페이스"로 전환. **가로 스크롤 0** 절대 원칙 유지.

> ⚠ 프리뷰 스크린샷은 이 세션에서 canvas 렌더로 인해 30초 타임아웃(3회 재시도 실패) — **DOM 실측(getBoundingClientRect)·라이브 API 응답**으로 대체 검증함. 구현 후 감리/PM은 반드시 스크린샷으로 시각 재확인 요망(특히 이슈1 폭·이슈2 뱃지 겹침·이슈5 범례).

---

## 0. 현재 상태 실측 근거 (개발자·감리 공유)

| 항목 | 실측값 | 출처 |
|---|---|---|
| 이슈1: 성취 매트릭스 카드 폭 | **1136px** | `.mastery-section` getBoundingClientRect |
| 이슈1: 표 실제 폭 | **628px** | `.mastery-heatmap` |
| 이슈1: **우측 빈 공백** | **508px (카드의 약 45%)** | card − table |
| 이슈1: 행 헤더(성취기준) 열 폭 | **220px 고정** | `thead th.corner` = 200px CSS + padding |
| 이슈1: 행 헤더가 확장 가능한 최대 폭 | **~679px** (현재의 3배) | wrapInner 1084 − 학생·요약열 381 − spacing |
| 이슈2: 행 헤더 렌더 | `${label} <span class="mh-code">[code]</span>` — **교과 뱃지 없음** | index.html 5240–5241 |
| 이슈2: mastery API 필드 | 각 행에 `subject:"수학"`, `subject_code:"math-e"` **이미 존재** | `/api/lrs/mastery/class/2` |
| 이슈2: 전체 교과 종류 | 수학·사회·국어·영어·과학 (5종) | 115개 성취기준 distinct |
| 이슈3: by-subject 30d | lessons=**[]**, homework=**[]**, exams=[수학5] | `/api/lrs/stats/by-subject?period=30d` |
| 이슈3: by-subject 90d | lessons=[수학15,영어…], homework=[…], exams=[…] | period=90d |
| 이슈3: by-subject 365d | lessons=[수학20,…], homework, exams 전부 채워짐 | period=365d |
| 이슈4/5: 산점도 색 | flag=`#ef4444`(빨강), 정상=`#9ca3af`(회색) | index.html 4544 |
| 이슈5: 범례 | `legend:{ display:false }` — **범례 전무** | index.html 4554 |
| 모바일 375 | 데스크탑 표 `display:none` → 카드뷰, 카드 sub에 `· 수학 ·` 이미 있음, 가로스크롤 0 | 실측 |

**핵심 통찰**: "성취 도달 현황"은 **누적(기간 무관)**이라 꽉 차 있고, "교과별 활동 현황"은 **최근 30일 생성분(created_at)**만 세어 텅 빔 → 같은 페이지에서 한쪽만 고장 난 것처럼 보이는 게 이슈3의 본질(신뢰 훼손).

---

## 이슈 1 — 성취 매트릭스 우측 빈 공백 제거

### 문제
카드는 풀폭(1136px)인데 표는 내용폭(628px)만 좌측에 붙어 우측 508px가 거대한 흰 박스. 학생 5명이라 학생 열이 좁고, 행 헤더 220px 고정이라 성취기준 전문이 잘림("자릿값의 원리를 바탕으로 소수 두 자리…"에서 끊김).

### 해결 방향 (채택안)
**행 헤더(성취기준) 열이 남는 폭을 흡수**하도록 표를 카드 폭에 맞춘다. → 공백 제거 + 잘려 있던 성취기준 전문 노출(가독성↑) 동시 달성. 검토한 대안(우측에 "반 분포 4상태 미니 스택바 열" 추가)은 **채택하되 이슈1의 부속(옵션)으로 격하** — 아래 "선택 보강" 참조. 우선순위: 폭 흡수(필수) > 분포 스택 열(권장 보강).

### 정확한 스펙 (FE — CSS + 소폭 JS)
`public/lrs/index.html` CSS 블록(464–493 라인대):

```css
/* 표를 카드 폭에 맞춤 — 우측 공백 제거 */
.mastery-heatmap{ width:100%; table-layout:auto; }   /* 기존 width 없음 → 100% 추가 */

/* 행 헤더 열: 고정 200px → 남는 폭 흡수(최소 220 / 최대 없음, 잘림 해제) */
.mastery-heatmap thead th.corner,
.mastery-heatmap tbody th{
  width:auto;               /* 기존 width:200px/max-width:200px 제거 */
  min-width:260px;          /* 최소 폭(코드+한 줄 확보) */
  max-width:none;           /* 잘림 해제 */
  white-space:normal;       /* 기존 nowrap → normal(2줄까지 자연 줄바꿈 허용) */
  line-height:1.45;
}
/* 성취기준 전문이 길어도 2줄 클램프(표 높이 폭주 방지) */
.mastery-heatmap tbody th{
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
}
/* 학생/요약 열은 폭 흡수 금지 — 내용폭 유지 */
.mastery-heatmap thead th.mh-stu,
.mastery-heatmap thead th.summary-h,
.mastery-heatmap td.cell,
.mastery-heatmap td.summary{ width:1%; white-space:nowrap; }
```

- **table-layout:auto + width:100%** → 브라우저가 고정폭(학생 32px·요약) 배분 후 **남는 폭 전부를 행 헤더에 할당**. 실측상 행 헤더가 220→최대 679px로 확장, 표 폭 628→1084px(=wrapInner)로 카드를 꽉 채움. **가로 스크롤 0**(1084 = wrap 내부폭, 초과 없음).
- **리스크 점검**:
  - `tbody th`는 `position:sticky; left:0`(478라인) 유지 — width:auto여도 sticky는 left 기준이라 정상. 단 **가로 스크롤이 0이 되면 sticky 자체가 무의미**(스크롤 없으니 항상 제자리) → 시각 변화 없음, 안전.
  - `td.summary`(반평균·도달수) `text-align:right`(492라인) 정렬 유지 — width:1%로 내용폭 고정하면 정렬 깨지지 않음.
  - 학생 12명 이상 클래스에서 학생 열 총합이 커지면 행 헤더 흡수 폭이 줄어듦 → 그래도 min-width:260px 보장, 초과 시 wrap의 `overflow-x:auto`가 정상 스크롤(다인수 클래스 예외 허용). **금성초 파일럿(5명)에서는 스크롤 0 확정.**

### 선택 보강 (권장, 별도 커밋 가능) — "반 분포" 미니 스택바 열
표가 넓어져도 여전히 여백이 남는 소인수 클래스를 위해, 요약열(도달수) 우측에 **4상태(도달/부분/미도달/평가부족) 100% 스택바** 열 1개 추가. 데이터는 mastery API 각 행의 `reached/partial/notReached/insufficient`(이미 존재, 모바일 카드뷰 `.mastery-stack`과 동일 색·구조 재사용).

```
헤더: "반 분포"  (summary-h 톤, writing-mode 가로)
셀 : <div class="mastery-stack" style="width:120px;height:18px"> …4 segments… </div>
색 : reached=var(--mastery-reached) / partial=var(--mastery-partial) /
     notReached=var(--mastery-notreached) / insufficient=var(--mastery-insufficient)  (기존 변수 재사용)
```
- 폭 120px. hover 시 각 세그먼트 title로 "도달 3 · 부분 1 · 미도달 1"(툴팁). 이건 **여백을 정보로 전환**하는 효과 — UI 디자이너 권장, 단 이슈1 필수 스펙(폭 흡수)만으로도 사용자 불만("빈 곳 보기 싫음")은 해소되므로 **P1(선택)**.

### 담당
- **FE 1인** (public/lrs/index.html): CSS 460–493 라인대 수정. JS는 이슈2와 함께 5240–5241 라인 1곳만 손댐. 선택 보강 시 tbody/thead 템플릿에 열 1개 추가.
- **반응형**: <768 카드뷰 전환(기존) 그대로 — 데스크탑만 변경. 중형(768–1200)도 동일 auto 레이아웃이라 자동 대응(폭만 줄어듦).

---

## 이슈 2 — 행별 교과 뱃지(어느 교과인지)

### 문제
데스크탑 행 헤더에 교과 표시가 없어 교사가 "이 성취기준이 수학인지 사회인지" 모름 → 부족의 맥락 파악 불가. 우상단 "전체 교과" 셀렉트는 **필터(선택)**일 뿐 **행 소속 표시**가 아님(역할 다름).

### 해결 방향
데스크탑 매트릭스 각 행 헤더에 **교과 컬러 pill**을 성취기준 텍스트 **앞**에 붙인다. 기존 `.dc-badge` 교과 색 매핑(`_subjectBadgeClass`, index.html 2973 / `lrs-tokens.css` 290–295) 재사용 → 색상 일관성 자동 확보.

### 정확한 스펙 (FE)
`index.html` 5240–5241 라인의 `tbody th` 템플릿을 아래로 교체(교과 pill을 라벨 앞에 삽입):

```js
// 기존:
// >${escapeHtml(s.label||codeBare)} <span class="mh-code">[${escapeHtml(codeBare)}]</span></th>
// 변경(교과 pill prepend):
>${s.subject
    ? `<span class="mh-subj dc-badge ${_subjectBadgeClass(s.subject)}">${escapeHtml(s.subject)}</span> `
    : ''}${escapeHtml(s.label||codeBare)} <span class="mh-code">[${escapeHtml(codeBare)}]</span></th>
```

pill 전용 CSS(신규, 460라인대 추가):
```css
.mastery-heatmap tbody th .mh-subj{
  display:inline-block; vertical-align:middle; margin-right:6px;
  font-size:12px;            /* 뱃지 예외: 메타 태그성이므로 12px 허용(스케일 표 badge 13, 공간 절약 위해 12 승인). */
  padding:1px 8px; border-radius:9999px; font-weight:700; line-height:1.5;
  white-space:nowrap;        /* 뱃지 자체는 줄바꿈 금지 */
}
```

> 뱃지 12px는 **본문 아님(메타 태그)**이라 "본문 12px 이하 금지" 위반 아님. 다만 CLAUDE.md 스케일 표 badge=13px 기준과 1px 차이 → **감리 판단 필요**. 공간이 충분하면 13px 권장, 좁으면 12px 승인. 색·굵기로 이미 판독성 확보됨.

색(고정, `lrs-tokens.css` 290–295 그대로):
| 교과 | class | bg | text |
|---|---|---|---|
| 수학 | subj-math | #dbeafe | #1d4ed8 |
| 국어 | subj-korean | #fee2e2 | #b91c1c |
| 영어 | subj-english | #ede9fe | #6d28d9 |
| 과학 | subj-science | #d1fae5 | #047857 |
| 사회 | subj-social | #ffedd5 | #c2410c |
| (기타/미지정) | subj-etc | #f3f4f6 | #374151 |

### 겹침·중복 방지
- pill은 행 **왼쪽 시작**, 셀렉트는 카드 **우상단** — 물리적으로 분리, 겹침 없음.
- **"교과가 1종뿐일 때"**: 셀렉트에서 특정 교과 필터를 건 상태(예: 수학만)면 모든 행이 같은 pill → 다소 중복. 하지만 (a) "전체 교과" 기본 상태에선 5색이 섞여 pill이 핵심 정보이고, (b) 필터 상태여도 pill이 "지금 무슨 교과를 보는지" 재확인시켜 **현재 위치 피드백**으로 기능 → **항상 표시 유지 권장**. 과하지 않음(1px 8px 소형).

### 담당
- **FE 1인**: index.html 5240–5241 템플릿 1곳 + CSS 1블록. 모바일 카드뷰(mc-sub, 5254)는 이미 교과 표기 → **변경 없음**(톤 일치 확인만).

---

## 이슈 3 — "교과별 활동 현황"이 비어 보이는 문제 ★가장 중요★

### 문제 (신뢰 훼손)
같은 페이지 형제 탭 "성취 도달 현황"은 꽉 찼는데 "교과별 활동 현황"은 "교과별 집계 데이터가 없어요" 단답. 근본:
- BE `routes/lrs.js` `/stats/by-subject`(950–1015)가 **lessons/homework/exams를 `created_at`이 기간 창(기본 최근 30일) 내인 것만** COUNT.
- teacher1의 자료는 전부 2026-03~05 생성 → 30d 창(06-04~07-04) 밖 → lessons=[], homework=[] (exams만 5).
- 성취 탭은 누적(기간 무관)이라 대비되어 "고장" 인상.
- 부가: lessons/homework 상당수 `subject_code` NULL → `JOIN subjects` INNER에서 탈락(2차 요인).

### 해결안 3종 비교

| 안 | 내용 | 장점 | 단점 | 구현비용 | 형제탭 일관성 |
|---|---|---|---|---|---|
| **①(권장) 이 탭 누적화 + 친절 빈상태** | by-subject를 **기간 무관 누적(period=all)**으로 재정의. NULL subject_code = "(교과 미지정)"으로 LEFT JOIN 포함. 그래도 0이면 친절 빈상태+CTA. | 성취 탭(누적)과 **의미 정합**. 교사가 "내가 이 반에 무슨 교과를 얼마나 운영했나"를 한눈에(운영 총량). 데이터 항상 참. | 기간 칩을 이 탭은 무시 → 화면에 "누적 집계" 명시 필요 | **낮음** (BE where 1곳·JOIN 1곳, FE 배너 1줄) | ★★★ 성취=누적과 완전 일치 |
| ② 학생 참여 기준 재정의 | count 대상을 교사 자료 생성 → **학생 실제 참여(제출·이수·응시)**로 변경 | "최근 활동"을 반영 | 산식 전면 재설계(테이블·조인 대폭 변경), "활용 현황" 탭과 의미 중복, 회귀 위험 | **높음** | 활용 현황과 겹침(혼란) |
| ③ 기간 유지 + 빈상태 CTA만 | 30d 유지, 비면 "최근 30일 없음 + [전체 기간 보기]" | 최소 변경 | "왜 성취는 있고 여긴 없냐"는 근본 의문 잔존(기간 개념을 사용자가 매번 이해해야) | 낮음 | 성취=누적과 여전히 불일치 |

### ★권장: **①안 (이 탭 누적화 + NULL 포함 + 친절 빈상태)**
근거: 사용자 불만의 핵심은 "성취는 있는데 여긴 왜 없냐"(정합 기대). 성취 탭이 누적이므로 **형제 탭도 누적으로 맞추는 것이 가장 친절하고 일관**. "교과별 활동 현황"의 자연스러운 의미 = "이 반에서 **누적으로** 어떤 교과의 수업·과제·평가가 운영됐는가"(운영 총량 리포트)이지, "최근 30일 창"이 아니다. 구현도 가장 싸다.

### BE 구현 지시 (Backend — routes/lrs.js `/stats/by-subject` 950–1015)
1. **날짜 필터 제거(누적화)**: 이 엔드포인트는 `buildDate('*.created_at')`를 **적용하지 않는다**(누적). scope 필터(class/mine)는 유지. → `dl/dh/de`의 `.w`,`.p`를 쿼리에서 빼거나, `period` 파라미터를 무시하고 항상 전체 집계.
   - 대안(더 명시적): 프론트가 `period=all`을 보내면 날짜 필터 skip, 그 외엔 기존 동작. **단 이 탭은 항상 `period=all`로 호출**(FE에서 apiGet 우회, 아래 FE 지시 참조). 이렇게 하면 다른 소비자 영향 0.
2. **NULL subject_code 포함**: 3개 쿼리의 `INNER JOIN subjects` → **`LEFT JOIN subjects`** 로 바꾸고 `WHERE subject_code IS NOT NULL` 조건 제거. subject_name이 NULL이면 `subjectLabel()` 폴백이 이미 있으므로, `enrich`에서 `subject_label`이 빈값이면 **"(교과 미지정)"** 라벨 부여. GROUP BY는 `COALESCE(subject_code,'__none__')` 기준.
   - 결과: 교과 미지정 자료도 한 행("(교과 미지정)")으로 집계 → 교사가 "분류 안 한 자료가 N건 있구나"까지 인지(데이터 품질 힌트).
3. 응답 형태·키(`lessonStats/homeworkStats/examStats`, `count`, `subject_label`)는 **그대로 유지**(FE 무변경 재사용).
4. **회귀 테스트 박제**(test/): "teacher1 by-subject(누적) lessonStats.length ≥ 1 AND examStats 수학 count = 15(또는 시드 실측값)"; "subject_code NULL 자료가 '(교과 미지정)' 행으로 잡힘". CLAUDE.md 하네스 의무.

### FE 구현 지시 (Frontend — index.html `VIEWS['t-subject']` 5702~)
1. **호출을 누적으로**: 5705 `apiGet('/api/lrs/stats/by-subject')` → **`apiGet('/api/lrs/stats/by-subject', { period:'all' })`** (또는 rangeQS 우회로 기간 미부착). BE가 period 무시 방식이면 이대로도 무방.
2. **"누적 집계" 안내 배너**(기간 칩과의 혼란 방지) — 탭 상단에 1줄:
   ```
   <div class="lrs-scope-note">
     <i class="fas fa-layer-group"></i> 이 탭은 <b>전체 기간 누적</b> 기준입니다. (기간 필터의 영향을 받지 않아요)
   </div>
   ```
   스타일: `font-size:14px; color:#6b7280; background:#f3f4f6; border-radius:8px; padding:8px 12px; margin-bottom:12px;`. 페이지 상단 period 칩이 있어도 이 탭만 누적임을 명시 → 사용자 혼란 0.
3. **친절 빈상태**(누적인데도 정말 0인 신규 교사용) — 5724–5726의 `tplEmpty('교과별 집계 데이터가 없어요')` 교체. `tplEmpty`의 cta는 링크만 지원하므로 **커스텀 빈상태 블록** 사용:
   ```
   <div class="dc-state-panel" role="status">
     <i class="fas fa-inbox"></i>
     <p style="font-weight:700;margin-bottom:4px;">아직 등록된 수업·과제·평가가 없어요</p>
     <p style="font-size:14px;color:#6b7280;">이 반에 수업 꾸러미나 과제·평가를 등록하면 교과별로 자동 집계돼요.</p>
     <a class="btn" href="/class/class-home.html">클래스로 이동해 수업 만들기</a>
   </div>
   ```
   (누적화하면 시드 데이터상 teacher1은 항상 참이므로 이 빈상태는 신규 교사·빈 반에서만 노출. "데이터 없어요" 단답 금지 원칙 충족.)

### 담당
- **Backend**: routes/lrs.js 950–1015 (JOIN·where·enrich) + test 회귀.
- **FE**: index.html 5702~5726 (호출·배너·빈상태).
- **반응형**: 배너·빈상태 모두 폭 100% 블록 → 모바일 자동 대응, 가로스크롤 무관.

---

## 이슈 4 — "표면적 학습 감지" 용어 불명확

### 문제
- 제목 "⏱️ 표면적 학습 감지" (4398) — 사용자 "무슨 말인지 모르겠네."
- 부제 "정답은 맞았지만 **표준 시간**보다 훨씬 빨리 끝낸 학습을 짚어요."(4399) — "표준 시간"이 모호(실제는 **반 학생 풀이 시간 중앙값**).

### 해결 방향
**제목은 격식 명사형 유지**(메모리: 카드 제목 격식 명사형·구어 금지). 부제/도움말을 **초등 담임이 즉시 이해**하도록 재작성 + 제목 옆 **(?) 도움말 툴팁** 추가.

### 정확한 카피 문안 (확정 — FE, index.html 4395–4402)
```
제목(유지):  ⏱️ 표면적 학습 감지
             └ 옆에 (?) 도움말 아이콘 추가 (아래)
부제(교체):  반 학생들의 보통 풀이 시간(중앙값)보다 훨씬 빨리 정답 처리한 학습을 모았어요.
도움말 1줄(부제 아래 or (?)툴팁 내용):
             충분히 익히지 않고 넘어갔을 수 있어, 한 번 더 확인해 보면 좋아요.
```

- **"표준 시간" → "반 학생들의 보통 풀이 시간(중앙값)"** 로 구체화(모호어 제거).
- **왜 봐야 하는가** 1줄 추가: "충분히 익히지 않고 넘어갔을 수 있어…" (교사 행동 유도).
- 기존 disclaimer("빠르게 맞힌 게 꼭 부정은 아니에요…", 4390)는 **하단 유지**(균형).

### (?) 도움말 툴팁 스펙 (신규 소형 컴포넌트)
제목 오른쪽에 12px 원형 (?) 아이콘. hover/focus 시 말풍선:
```
<span class="lrs-help" tabindex="0" role="button" aria-label="표면적 학습 감지 설명">
  <i class="fas fa-circle-question"></i>
  <span class="lrs-help-pop">
    같은 콘텐츠를 푼 우리 반 학생들의 <b>중앙값 시간</b>을 기준으로,
    그보다 훨씬 빨리(기준의 40% 미만) 정답 처리한 경우를 표시해요.
  </span>
</span>
```
CSS: 아이콘 `color:#9ca3af; font-size:16px; margin-left:6px; cursor:help;`. 팝업 `position:absolute; z-index:20; width:260px; background:#1f2937; color:#fff; font-size:13px; line-height:1.6; padding:10px 12px; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,.18);` — hover·focus-visible에서 display. (기존 셀 툴팁 톤과 통일.)

> 부제 font-size는 현재 14px(4399 style) 유지 — 스케일 표 "라벨/메타 14–15" 부합. 12px 이하 금지 준수.

### 담당
- **FE**: index.html 4395–4402(header) 카피 교체 + (?)툴팁 마크업/CSS. **BE 무변경**(disclaimer는 BE 폴백 있으나 FE 기본 문구로 덮음 — BE `disclaimer` 필드는 그대로 둬도 무방).

---

## 이슈 5 — 산점도 색 구별 범례 부재

### 문제
산점도에 빨강 점(빠름·flag)과 회색 점(보통)이 섞였는데 **범례·설명 없음**(`legend:{display:false}`, 4554). median 세로 점선(파랑)·좌하 음영(연분홍)도 의미 미표기. 사용자 "왜 색을 구별했는지 모르겠다."

### 해결 방향
차트 **위(캔버스 밖 HTML)** 에 **커스텀 범례 바** 추가(Chart.js 기본 범례 아님 — scatter 단일 데이터셋이라 기본 범례는 색을 못 나눔). 색맹 대비 위해 **점 아이콘 + 텍스트 병기**. 축 의미도 한 줄로.

### 정확한 스펙 (FE — index.html, 4431 `<div id="tShallowChartWrap">` 바로 위에 삽입)
```html
<div class="shallow-legend" role="group" aria-label="산점도 범례">
  <span class="sl-item"><span class="sl-dot" style="background:#ef4444"></span>
    빠른 풀이 · <b>점검 대상</b> <em>(정답이지만 기준보다 훨씬 빠름)</em></span>
  <span class="sl-item"><span class="sl-dot" style="background:#9ca3af"></span>
    보통 속도</span>
  <span class="sl-item"><span class="sl-line"></span>
    기준선 <em>(반 중앙값 시간)</em></span>
  <span class="sl-item"><span class="sl-zone"></span>
    점검 구간 <em>(빠름 + 정답)</em></span>
</div>
<div class="shallow-axes-note">
  가로(X) = 소요 시간(초), 세로(Y) = 정답 / 오답
</div>
```

CSS(신규):
```css
.shallow-legend{ display:flex; flex-wrap:wrap; gap:14px 20px; align-items:center;
  padding:10px 14px; background:#f9fafb; border:1px solid #eef2f7; border-radius:10px; margin-bottom:10px; }
.shallow-legend .sl-item{ display:inline-flex; align-items:center; gap:6px;
  font-size:14px; color:#374151; line-height:1.5; }         /* 메타 14px — 스케일 준수 */
.shallow-legend .sl-item b{ color:#b91c1c; }                 /* 점검 대상 강조 */
.shallow-legend .sl-item em{ font-style:normal; color:#6b7280; font-size:13px; }
.shallow-legend .sl-dot{ width:12px; height:12px; border-radius:50%; border:1.5px solid #fff;
  box-shadow:0 0 0 1px rgba(0,0,0,.08); flex:none; }
.shallow-legend .sl-line{ width:20px; height:0; border-top:2px dashed #2563eb; flex:none; }
.shallow-legend .sl-zone{ width:16px; height:12px; background:#fef2f2; border:1px solid #fecaca; border-radius:3px; flex:none; }
.shallow-axes-note{ font-size:13px; color:#9ca3af; margin-bottom:8px; }
@media(max-width:767px){ .shallow-legend{ gap:8px 14px; } .shallow-axes-note{ display:none; } }
```

- **색·아이콘 병기**: 빨강=🔴 점검 대상, 회색=⚪ 보통, 파란 점선=기준선(반 중앙값), 연분홍 박스=점검 구간 → 4가지 시각요소 전부 설명. 색맹 접근성: 점검 대상은 색뿐 아니라 **"점검 대상" 텍스트 + 더 큰 반지름(7 vs 5, 기존 4545)**으로도 구별 → 색 의존 완화.
- **툴팁 유지**(4555–4559) — 사용자 "좋다"고 함, 변경 없음.
- 범례 색은 산점도 실제 색과 **정확히 동일**(#ef4444/#9ca3af/#2563eb/#fef2f2) → 색상 코딩 일관성.
- **위치**: 차트 위(4431 위). 콘텐츠 셀렉트(4424–4429)와 차트 사이. 차트 캔버스 내부가 아니라 밖이라 canvas 렌더 부하·겹침 0.

> 데인저 레드 강조(#b91c1c)는 "점검 대상" 텍스트에만 1회 — 한 화면 강한 컬러 남발 금지 원칙 준수.

### 담당
- **FE**: index.html 4421~4434 사이에 범례/축주석 HTML 삽입 + CSS 1블록. **차트 옵션·BE 무변경**(색 로직 4544 그대로, 범례만 캔버스 밖 HTML로 설명).
- **반응형**: 범례 flex-wrap → 모바일에서 자동 2~3줄, 축주석은 <768 숨김(모바일은 표만 노출, 4506 isMobile). 가로스크롤 0.

---

## 종합 — 담당·파일·우선순위 매트릭스

| 이슈 | 담당 | 파일·라인 | 변경 성격 | 우선 |
|---|---|---|---|---|
| 1 매트릭스 폭 | FE | index.html CSS 464–493 (+선택 보강 시 5227~5245 열 추가) | CSS 위주 | P0 |
| 2 교과 뱃지 | FE | index.html 5240–5241 템플릿 + CSS 신규 1블록 | JS 1줄+CSS | P0 |
| 3 교과별 활동 누적화 | **BE** + FE | routes/lrs.js 950–1015(JOIN·where·enrich)+test / index.html 5702–5726(호출·배너·빈상태) | BE 쿼리+FE | **P0 최우선** |
| 4 표면적 학습 카피 | FE | index.html 4395–4402 + (?)툴팁 | 카피+소형컴포넌트 | P1 |
| 5 산점도 범례 | FE | index.html 4421~4434 + CSS 1블록 | HTML+CSS | P1 |

### 공통 준수 확인
- 가로 스크롤 0: 이슈1 표 1084=wrap폭(초과0), 모바일 375=375 실측 확인. 이슈3/5 블록은 폭100% → 무관.
- 스케일: 본문 12px 이하 없음(뱃지 12px는 메타 예외·감리 확인), 버튼 14px 이하 없음. 부제 14px, 범례 14px, 축주석/em 13px(메타 허용).
- 색: Primary #2563eb(기준선)·Danger #ef4444/#b91c1c(점검)·교과 6색(lrs-tokens.css) — 전부 기존 토큰 재사용, 신규 색 0.
- 친절성(디자이너 최우선): 진입경로(서브탭 3개 명확)·현재위치(교과 pill·누적 배너·범례)·빈상태(이슈3 CTA)·용어 평이화(이슈4) 전부 반영.

### 후속(감리·PM)
1. 구현 후 **스크린샷 필수 재검증**(이 세션 타임아웃으로 시각 미검증분): ①표 우측 공백 0·성취기준 전문 노출 ②교과 pill 색·겹침 ③범례 색이 실제 점 색과 일치.
2. BE 이슈3 → `npm test` 회귀 추가·통과 확인(하네스 의무).
3. FE 전체 → `npm run test:e2e:smoke`로 가로스크롤·[object Object]·콘솔에러 0.
