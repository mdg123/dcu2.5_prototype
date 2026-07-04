# LRS 교사 "지금 지원이 필요한 학생" — 약점 교과·성취기준 보기 재설계 기획서 v1

- 작성: UI 디자이너 (opus)
- 대상 파일: `public/lrs/index.html` (BE 무변경, `/api/lrs/insights/:userId` 재사용)
- 배경: 위험 학생 카드의 학생용 "맞춤학습" 버튼이 교사를 `/self-learn/?user_id=X`(학생 자기주도 학습 페이지)로 보내는 오배치. 사용자 확정 방향 = **교사에게 그 학생이 부족한 교과·성취기준을 바로 보여주기**(배정 기능 제외).
- 핵심 결정 한 줄: **카드 primary를 "약점 상세"(파랑)로 바꾸고, 그 클릭이 여는 드로어를 "이 학생의 약한 교과·성취기준" 중심으로 강화한다. 교사 화면의 모든 `→/self-learn` 딥링크(맞춤학습/보충 배정)를 제거한다.**

---

## 0. 프리뷰 실측 근거 (teacher1 / 김선생 / 3학년 1반, class 1)

### 0-1. 현재 카드 (menu=home → "지금 지원이 필요한 학생")
- 첫 카드 = **임지호**. 액션 버튼 4개 실측: `[맞춤학습]` `[메시지]` `[과제부과]` `[상세]`.
- `맞춤학습`(파랑 primary, `data-action=recommend`) → `teacherAction('recommend')` → `location.href = '/self-learn/?user_id=' + sid ...` (오배치 확인).
- `상세`(`data-action=detail`) → `openDrilldown(...)`.

### 0-2. 현재 드로어 (`상세` 클릭 시, openDrilldown)
실측 본문 텍스트:
```
최근 학습: -
사유: 미도달 6/6개 · 최근 감정 부정 비율 90% · 최근 6주 정답률 -5%p/주
[추천 액션]  메시지  과제부과  맞춤학습 추천
[최근 활동 로그]  최근 활동 데이터가 없습니다
```
- 드로어 폭 실측: 데스크탑 **420px**(우측 고정), 모바일 375뷰 **약 338px(90vw)**, 가로 스크롤 0.
- **결함**: 그 학생의 약한 교과/성취기준이 **전혀 안 보임**. 하단에 큰 빈 공백. "맞춤학습 추천" 버튼(→/self-learn)이 교사 화면에 그대로 노출.

### 0-3. `/api/lrs/insights/:userId` 실 응답 형태 (teacher1이 자기 반 학생 조회, 200 OK)
`weaknesses[]` 각 항목(실데이터 필드):
| 필드 | 예시(이학생 3 / 임지호 12) | 용도 |
|---|---|---|
| `subject_label` | "수학","국어","영어","사회" | 교과 pill 라벨(SSOT) |
| `subject_code` | "math-e","korean-e"… **또는 null** | pill 색 매핑(널이면 label로 폴백) |
| `label` | "세 자리 수의 덧셈과 뺄셈" | 성취기준 단원명(1줄 클램프) |
| `fullLabel` | "자연수의 덧셈…어림셈을 할 수 있다." | title 툴팁 |
| `achievement_code` | "[4수01-08]" | 코드 메타 |
| `status` | "not_reached"/"partial"/"insufficient" | 상태 뱃지 클래스 |
| `statusLabel` | "미도달"/"부분도달"/"평가부족" | 상태 뱃지 텍스트 |
| `avg_score` | 40, 52, null | 정답률(0~100 정수 or null) |
| `hasScore` | true/false | 정답률 표기 여부 게이트 |
| `attempt_count` | 5, 2, 1 | 시도수 |
| `priority` | "urgent"/"recommended"/"optional"/null | 우선순위 정렬 보조 |

- **관측 사실**: 이학생(3)의 최취약 `[4수03-10]`은 `subject_code:null` + `subject_label:"수학"` → **색 매핑은 subject_label 우선, subject_code는 보조**로 설계.
- 실 반 위험학생 예: 임지호(12) 수학 미도달 다수, 최학생(5) 수학, 이학생(3) 수학·국어·영어 혼재. 즉 **교과별 그룹핑이 실제로 의미 있음**(단일 교과가 아님).
- 학생 톤 카피(`reasonText`="여기부터 다시 잡아봐요")는 **교사 뷰에서 사용하지 않음**(격식 위반). 교사 뷰는 상태 뱃지 + 정답률 + 시도수 사실 위주.

---

## 1. 카드 액션 재편 (renderEwsList, index.html ~5017~5024)

### 1-1. 결정: 4버튼 → 3버튼, primary를 "약점 상세"로 통합
`[맞춤학습]`(→self-learn) **제거**. 기존 `[상세]`와 신규 primary가 중복되므로 **`[상세]`를 "약점 상세"로 승격·통합**(버튼 수 순증 방지).

**최종 버튼(순서·라벨·색·아이콘·data-action):**
| # | 라벨 | data-action | 스타일 | 아이콘 | 동작 |
|---|---|---|---|---|---|
| 1 | **약점 상세** | `detail` | primary (파랑, `.mastery-btn .mastery-btn-sm`) | `fa-magnifying-glass-chart` | 강화된 `openDrilldown` 드로어 |
| 2 | 메시지 | `message` | ghost (`.mastery-btn-sm .mastery-btn-ghost`) | `fa-envelope` | class-home 쪽지(기존) |
| 3 | 과제부과 | `homework` | ghost | `fa-clipboard-list` | class-home 과제신규(기존) |

- **primary는 1개만**(약점 상세). 메시지·과제부과는 톤다운 ghost 유지 → "무엇이 부족한지 먼저 보고(파랑), 그다음 조치(회톤)" 시선 흐름.
- 라벨 "약점 상세" = 격식 명사형. (대안 "약점 교과·성취기준"은 버튼 폭 초과로 2줄 위험 → 카드 버튼엔 "약점 상세", 드로어 섹션 제목에 풀네임 사용.)
- 아이콘은 `fa-wand-magic-sparkles`(마법=추천 뉘앙스) 폐기 → **`fa-magnifying-glass-chart`**(분석·들여다보기).

### 1-2. 정확한 마크업 (교체본)
`renderEwsList` 내 액션 블록(현재 5017~5022) 전체를 아래로 교체:
```html
<div class="ews-actions" data-student-id="${escapeAttr(uid)}" data-warn-idx="${idx}">
  <button type="button" class="mastery-btn mastery-btn-sm" data-action="detail">
    <i class="fas fa-magnifying-glass-chart"></i> 약점 상세</button>
  <button type="button" class="mastery-btn mastery-btn-sm mastery-btn-ghost" data-action="message">
    <i class="fas fa-envelope"></i> 메시지</button>
  <button type="button" class="mastery-btn mastery-btn-sm mastery-btn-ghost" data-action="homework">
    <i class="fas fa-clipboard-list"></i> 과제부과</button>
</div>
```
- `recommend` 버튼 라인(5018) 삭제. `.ews-actions` 바인딩(5027~5040)은 그대로 동작(detail→openDrilldown, 나머지→teacherAction). **`recommend` 케이스는 더 이상 카드에서 발생하지 않음.**
- 크기: `.mastery-btn-sm` = font 14px / padding 8px 14px(기존 토큰 유지). 버튼 3개 `.ews-actions`(flex, `flex:0 0 auto`)는 420px 카드폭에서 1줄 수용. 라벨 최장 "과제부과"(4자)로 2줄 줄바꿈 없음(실측 시 확인).

---

## 2. 드로어(openDrilldown) 강화 — 핵심 (index.html ~7274~7327)

목표: 드로어를 열면 **① 이 학생이 특히 어려워하는 것(1줄 요약) → ② 약한 교과·성취기준(교과별 그룹) → ③ 교사 조치(메시지·과제부과) → ④ 최근 활동 로그** 순으로 자연스럽게 읽히게.

### 2-1. 드로어 본문 구조 (위→아래)

```
┌ [드로어 header — 기존 재사용] 학생명            × 닫기
│
│ (A) 위험 요약 배너
│     "미도달 6/6개 · 최근 정답률 -5%p/주" (기존 reason 유지, 회색 소형)
│
│ (B) ⚑ 이 학생이 특히 어려워하는 것       ← 신규, 핵심 1줄
│     [수학] 세 자리 수의 덧셈과 뺄셈 · 미도달 · 정답률 40%
│
│ (C) 약점 교과·성취기준                    ← 신규, 본체
│     ▸ 수학 3       (교과 그룹 헤더: subj pill + 개수)
│        · 세 자리 수의 덧셈과 뺄셈  [미도달] 40%
│          [4수01-08] · 5회 시도
│        · 두 자리 수의 곱셈(1)     [미도달] 52%
│          [4수01-04] · 5회 시도
│     ▸ 국어 1
│        · 중요한 내용과 주제…       [평가부족]
│          [4국01-01] · 2회 시도
│
│ (D) 교사 조치 (기존 "추천 액션" 리네이밍)
│     [메시지]  [과제부과]            ← "맞춤학습 추천" 제거
│
│ (E) 최근 활동 로그                        ← 기존 유지, 약점 아래로 이동
│     (표 or 빈상태)
└
```

### 2-2. 데이터 로드
- `openDrilldown`에 **insights 비동기 로드 1건 추가**: `apiGet('/api/lrs/insights/' + uid)`.
- 카드에서 넘어온 `student.user_id`(uid)로 조회. 권한은 BE `canViewUser`가 보장(교사=자기 반). 실패/403이면 (C)(B)는 빈상태로.
- 기존 `student-activity` 로드(E)는 그대로. **두 fetch 병렬** 가능(Promise.all 권장, 순차도 무방).

### 2-3. (B) "이 학생이 특히 어려워하는 것" — 취약 1순위 요약
- 정렬 후 **weaknesses[0]**(§2-5 정렬 기준) 1건을 강조 카드로.
- 구성: `⚑` 아이콘 + 교과 pill + 단원명(`label`) + 상태 뱃지 + 정답률(hasScore일 때만).
- 빈 상태(weaknesses 0건): 이 블록 생략하고 (C)에서 안내.

**마크업:**
```html
<div class="ews-drw-hero">
  <div class="ews-drw-hero__cap"><i class="fas fa-flag"></i> 이 학생이 특히 어려워하는 것</div>
  <div class="ews-drw-hero__body">
    <span class="dc-badge ${subjCls}">${escapeHtml(w0.subject_label||'기타')}</span>
    <span class="ews-drw-hero__unit" title="${escapeAttr(w0.fullLabel||'')}">${escapeHtml(w0.label||w0.achievement_code)}</span>
    <span class="mastery-badge ${normStatus(w0.status)}">${escapeHtml(w0.statusLabel||masteryKo(w0.status))}</span>
    ${(w0.hasScore && w0.avg_score!=null) ? `<span class="ews-drw-hero__rate">정답률 ${Math.round(w0.avg_score)}%</span>` : ''}
  </div>
</div>
```

### 2-4. (C) 약점 교과·성취기준 — 교과별 그룹 (본체)
- weaknesses[]를 **`subject_label` 키로 그룹핑**. 그룹 순서 = "그룹 내 최취약 항목의 취약도"가 높은 교과 먼저(§2-5). 그룹 내부도 취약 우선 정렬.
- 그룹 헤더: 교과 pill(`_subjectBadgeClass(subject_label)` → subj-* 색) + "N개".
- 항목 행: 단원명(`label`, 1줄 클램프) + 상태 뱃지 + 정답률(hasScore·avg_score≠null일 때만, `insufficient`/평가부족은 미표기) + 메타(`[코드] · N회 시도`).
- 최대 표시: 교과 무제한, **총 항목 8개까지** 그리고 초과 시 "외 N개" 안내(회색 텍스트, 클릭 없음 — 드로어는 지도 참고용이라 별도 확장 불필요). insights weaknesses는 통상 5건이라 대부분 전체 표시.

**마크업(그룹 반복):**
```html
<div class="ews-drw-sect">
  <div class="ews-drw-sect__title">부족한 교과·성취기준 <span class="ews-drw-sect__n">${totalW}개</span></div>
  ${groupsHtml}   <!-- 아래 그룹 템플릿 반복 -->
</div>
```
그룹 1개:
```html
<div class="ews-drw-grp">
  <div class="ews-drw-grp__head">
    <span class="dc-badge ${subjCls}">${escapeHtml(subject)}</span>
    <span class="ews-drw-grp__n">${items.length}개</span>
  </div>
  <ul class="ews-drw-items">
    ${items.map(w => `
    <li class="ews-drw-item">
      <div class="ews-drw-item__top">
        <span class="ews-drw-item__unit" title="${escapeAttr(w.fullLabel||'')}">${escapeHtml(w.label||w.achievement_code)}</span>
        <span class="mastery-badge ${normStatus(w.status)}">${escapeHtml(w.statusLabel||masteryKo(w.status))}</span>
        ${(w.hasScore && w.avg_score!=null && normStatus(w.status)!=='insufficient')
           ? `<span class="ews-drw-item__rate">${Math.round(w.avg_score)}%</span>` : ''}
      </div>
      <div class="ews-drw-item__meta">${escapeHtml(String(w.achievement_code||'').replace(/^\[|\]$/g,''))
           ? '['+escapeHtml(String(w.achievement_code).replace(/^\[|\]$/g,''))+']' : ''} · ${Number(w.attempt_count)||0}회 시도</div>
    </li>`).join('')}
  </ul>
</div>
```

### 2-5. 정렬 규칙 (취약 우선)
그룹·항목 공통 정렬 키(오름=더 취약이 위):
1. status 랭크: `not_reached`(0) < `partial`(1) < `insufficient`(2) — 미도달을 최상단.
2. 같은 status면 `avg_score` 오름차순(null은 뒤로).
3. 그룹 정렬 = 각 그룹의 "대표 항목(정렬 후 첫 항목)"의 위 키로.
- (insights가 이미 priority/취약순으로 내려주지만, FE에서 재정렬해 결정적으로.)

### 2-6. (D) 교사 조치 — "맞춤학습 추천" 제거
현재(7291~7298) `dc-warning-card`의 액션을 아래로 교체:
```html
<div class="dc-warning-card" data-severity="${escapeAttr(student.severity||'medium')}">
  <h3>교사 조치</h3>
  <div class="actions" data-student-id="${escapeAttr(uid)}" data-achievement-code="${escapeAttr(code)}">
    <button type="button" data-action="message">메시지</button>
    <button type="button" data-action="homework">과제부과</button>
  </div>
</div>
```
- `<button data-action="recommend">맞춤학습 추천</button>` **삭제**.
- 제목 "추천 액션" → **"교사 조치"**(격식·의미 명확). `bindWarningActions` 그대로(message/homework만 발생).

### 2-7. (E) 최근 활동 로그
- 기존 로직 유지(`student-activity` 표). 위치만 (D) 아래로. 제목 그대로 "최근 활동 로그".
- 빈상태 문구 유지("최근 활동 데이터가 없습니다").

### 2-8. 빈 상태 (친절성)
- **insights 로드 실패/403**: (B)(C) 자리에
  `<div class="ews-drw-empty"><i class="fas fa-triangle-exclamation"></i> 약점 데이터를 불러오지 못했어요. 잠시 후 다시 시도해주세요.</div>`
- **weaknesses 0건(약점 없음)**: (B) 생략, (C) 자리에
  `<div class="ews-drw-empty ok"><i class="fas fa-face-smile"></i> 지금 특별히 부족한 성취기준이 없어요. 최근 활동 로그를 확인해보세요.</div>`
- 두 경우 모두 (D)(E)는 정상 노출(교사가 조치·활동은 여전히 볼 수 있게).

---

## 3. 신규 CSS (index.html `<style>` 블록 내, `.drw-*` 인근에 추가)

토큰 스케일이 압축형(--fs-body 14)이라 CLAUDE.md "본문 12px↓·버튼 14px↓ 금지"를 지키기 위해 **명시 px** 사용(코드 기존 관행: 296/577/592줄과 동일).

```css
/* ── EWS 약점 드로어 ── */
.ews-drw-hero{ margin:14px 0 4px; padding:14px 16px; border-radius:12px;
  background:#fef2f2; border:1px solid #fecaca; }
.ews-drw-hero__cap{ font-size:13px; font-weight:700; color:#b91c1c; margin-bottom:8px;
  display:flex; align-items:center; gap:6px; }
.ews-drw-hero__body{ display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.ews-drw-hero__unit{ font-size:16px; font-weight:700; color:#1f2937; }
.ews-drw-hero__rate{ font-size:15px; font-weight:700; color:#b91c1c;
  font-variant-numeric:tabular-nums; }

.ews-drw-sect{ margin-top:20px; }
.ews-drw-sect__title{ font-size:16px; font-weight:700; color:#374151;
  margin:0 0 10px; display:flex; align-items:baseline; gap:6px; }
.ews-drw-sect__n{ font-size:14px; font-weight:600; color:#6b7280; }

.ews-drw-grp{ margin-bottom:14px; }
.ews-drw-grp__head{ display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.ews-drw-grp__n{ font-size:13px; font-weight:600; color:#6b7280; }
.ews-drw-items{ list-style:none; margin:0; padding:0;
  display:flex; flex-direction:column; gap:8px; }
.ews-drw-item{ padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px;
  background:#fff; }
.ews-drw-item__top{ display:flex; align-items:center; gap:8px; }
.ews-drw-item__unit{ flex:1 1 auto; min-width:0; font-size:15px; font-weight:600;
  color:#1f2937; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ews-drw-item .mastery-badge{ flex:none; }
.ews-drw-item__rate{ flex:none; font-size:14px; font-weight:700; color:#b91c1c;
  font-variant-numeric:tabular-nums; }
.ews-drw-item__meta{ margin-top:4px; font-size:13px; color:#9ca3af;
  font-variant-numeric:tabular-nums; }

.ews-drw-empty{ margin:14px 0; padding:16px; border-radius:10px; background:#f9fafb;
  border:1px dashed #e5e7eb; color:#6b7280; font-size:14px; line-height:1.6;
  display:flex; align-items:center; gap:8px; }
.ews-drw-empty.ok{ background:#f0fdf4; border-color:#bbf7d0; color:#15803d; }
.ews-drw-empty i{ font-size:16px; }
```
색상 근거(일관성):
- 상태 뱃지: `.mastery-badge .notReached/.partial/.insufficient` 재사용(미도달=빨강 soft/ink, 부분=주황, 평가부족=회색). **신규 색 도입 없음.**
- 교과 pill: `.dc-badge .subj-*` 재사용(수학 파랑/국어 빨강/영어 보라/사회 주황/과학 초록/기타 회색).
- hero/rate 강조 빨강 `#b91c1c` = `--mastery-notreached-ink`와 동일 계열.

---

## 4. teacherAction 정리 (index.html ~7351~7370)

- `kind === 'recommend'` 분기(7365~7367, `location.href = '/self-learn/?user_id='...`)를 **교사 진입점에서 도달 불가로 만든다.** 카드·드로어에서 `recommend`를 발생시키는 호출을 모두 제거(§1·§2·§5)하므로, 이 분기는 **dead code가 됨**.
- 처리 방침: **`recommend` 케이스 자체를 삭제**(else의 `unknown teacherAction` 경고로 흡수)하여 "교사→/self-learn" 경로가 코드에서 사라지도록 한다. BE 변경 없음. `message`/`homework` 분기는 유지.
- (주의: `teacherAction`은 학생 s-home 렌더러와 무관 — 이 함수는 LRS 교사/관리자 드릴다운 전용이므로 학생 자기화면 "맞춤학습"에 영향 없음.)

---

## 5. 다른 교사용 recommend 버튼 처리 (교사용에 한해)

| 위치(줄) | 현재 | 성격 | 방침 |
|---|---|---|---|
| ~5018 | 카드 `[맞춤학습]` `data-action=recommend` | 교사 | **제거**(§1, "약점 상세"로 대체) |
| ~7296 | openDrilldown 드로어 `[맞춤학습 추천]` | 교사 | **제거**(§2-6) |
| ~5386 | 셀 드로어 `#drwRecommend` "이 학생에게 보충 배정" | 교사 | **제거** — `drwRecommend` 버튼 삭제, 옆의 `#drwMessage`(쪽지)만 유지. (7340~7343의 `drwRecommend` 이벤트 바인딩도 함께 제거.) |
| ~5501 | 열 드로어 `[맞춤학습 추천]` `data-action=recommend` | 교사(비담임 masked면 이미 숨김) | **제거** — 해당 버튼 라인 삭제, `[메시지][과제부과]`만 유지. |

- 위 4곳 모두 교사/관리자가 **학생을 대상으로** 보는 위치 → 오배치 제거 대상.
- **학생 본인(s-home) "맞춤학습"·`/self-learn` 링크(3075·3374·3484·3678·2971·4008 등)는 정당 → 절대 건드리지 않음.** 이들은 학생이 자기 화면에서 자기 학습으로 가는 링크. `teacherAction`을 거치지 않는 `<a href>` 직접 링크라 이번 변경과 분리됨.
- 판별 근거: 대상이 `data-uid`/`user_id`(타인)인 교사 렌더러 = 제거 대상 / 로그인 학생 자신의 CTA = 유지.

---

## 6. 반응형 · 겹침 · 스케일 체크

- **드로어 폭**: 데스크탑 420px, 모바일 90vw(≈338px). 신규 요소 모두 폭 내 정렬. `.ews-drw-item__unit`·`.ews-drw-hero__unit`는 `text-overflow:ellipsis`로 1줄 클램프 → **가로 스크롤 0(1440·375 실측 예정)**.
- **모바일(<768)**: 드로어는 이미 90vw로 자동 축소. 항목 행 내부(`__top`)는 flex-wrap 없이 unit이 축소(min-width:0). 정답률·뱃지는 flex:none으로 유지. 추가 미디어쿼리 불필요.
- **닫기(×) 겹침**: 신규 콘텐츠는 `drawer-body`(header 아래) 내부에만 추가 → 우상단 닫기 버튼과 겹칠 여지 없음.
- **스케일 준수**: hero unit 16px, sect title 16px, item unit 15px, meta 13px, 뱃지 13px(mastery-badge 기존) — 본문 최소 13px(뱃지·메타), 12px 이하 없음. 버튼(카드)은 14px(mastery-btn-sm) 유지.
- **빈 공백 제거**: 현재 드로어 하단 대형 공백 → 약점 리스트가 채우므로 자연 해소.

---

## 7. 개발자 작업 요약 (index.html 단일 파일, BE 무변경)

1. **~5017~5022** 카드 액션 블록 → §1-2 3버튼으로 교체(`recommend` 삭제, `detail`을 "약점 상세" primary로).
2. **~7286~7300** `openDrilldown` 본문 템플릿 → §2 구조로 재작성: (A)요약 유지 → (B)hero → (C)약점 그룹(insights fetch) → (D)"교사 조치"(recommend 삭제) → (E)활동 로그(아래로). insights 비동기 로드 추가 + 그룹핑/정렬 헬퍼.
3. **~5386~5388** 셀 드로어 `#drwRecommend` "보충 배정" 버튼 삭제 + **~7340~7343** 그 이벤트 바인딩 삭제.
4. **~5499~5501** 열 드로어 `data-action=recommend` "맞춤학습 추천" 버튼 라인 삭제.
5. **~7365~7367** `teacherAction`의 `recommend` 분기 삭제.
6. **`<style>`** 블록에 §3 CSS 추가.
7. 검증: `npm test`(BE 무변경이라 회귀 없어야 함) + 프리뷰 `menu=home`에서 카드 3버튼·약점드로어 실측(teacher1) + 가로스크롤 0(1440/375) + `/self-learn` 딥링크가 교사 화면에서 사라졌는지 grep/실측.

### 회귀 방지(하네스) 권고
- 스모크/회귀에 "LRS 교사 홈 카드 버튼에 '맞춤학습' 라벨 없음" + "openDrilldown 드로어에 `href*=/self-learn` 없음" 정적 어서션 추가 권장(오배치 재발 박제).

---

## 8. 카피 확정(격식 명사형)
- 카드 버튼: **약점 상세**
- 드로어 hero 캡션: **이 학생이 특히 어려워하는 것**
- 드로어 본체 제목: **부족한 교과·성취기준**
- 조치 카드 제목: **교사 조치**
- 빈상태(실패): 약점 데이터를 불러오지 못했어요. 잠시 후 다시 시도해주세요.
- 빈상태(약점 없음): 지금 특별히 부족한 성취기준이 없어요. 최근 활동 로그를 확인해보세요.
- 상태 뱃지 텍스트: statusLabel 그대로(미도달/부분도달/평가부족).
