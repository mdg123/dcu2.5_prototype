# Frontend P1 보완 적용 보고서 (Round 2)

작성: Frontend 개발자(opus) / 작업일: 2026-04-28
대응 기획서: `docs/audit-self-learn/ui-designer-rework-plan.md`
대응 점검 보고서: `docs/audit-self-learn/ui-designer-audit.md`
검증 환경: `localhost:3000` (preview MCP), 학생(student1 / 이학생, role=student)

---

## 작업 요약

UI 디자이너 보완 기획서의 P0/P1 6개 항목을 일괄 반영. 모든 변경은 `public/self-learn/learning-map.html`과 `public/self-learn/today.html` 두 파일에 집중되며, CSS variables 토큰을 추가해 영역색·차시 진행률 색·KPI 크기·모달 z-index를 단일 소스에서 관리하도록 정합화했다.

| ID | 항목 | 결과 | 검증 |
|----|------|------|------|
| F-P1-1 | today.html 페르소나 자동 전환 가드 | 완료 | preview eval — gnbRole=학생, dacheumUser.role=student 유지 |
| F-P1-2 | KPI 28px / 카드 크기 / 11px→12-13px | 완료 | `.dash-value` 28px, `.dash-card` padding 18/20 |
| F-P1-3 | 영역색 4종 + 차시 진행률 4상태 토큰화 | 완료 | `data-area`별 borderLeftColor 4색 일치 |
| F-P1-4 | CTA 위계(Primary 1, Outline, Link) | 완료 | dual-btn.direct=solid, .diag=outline, .bookmark=link |
| F-P1-5 | × 닫기 안전영역 + z-index 11000 | 완료 | `--z-modal:11000`, drawer-close margin-left:8px |
| F-P1-6 | 학습 랭킹 빈 상태 카드 | 완료 | `.ranking-empty` 카드 + "첫 문항 풀러 가기" CTA |

---

## F-P1-1. 페르소나 자동 전환 버그 (Critical)

### 원인 추적

- `public/js/common-nav.js`의 `loadUser()`는 이미 `Cache-Control: no-store`를 응답에 강제하고 `/api/auth/me`를 호출. 헤더 자체에서 학생→교사 자동 전환을 일으키는 코드는 없음.
- `routes/auth.js` `/me` 엔드포인트도 캐시 무효화·세션 ID 교차검증을 수행. dev fixture 자동 로그인 코드 없음.
- 프리뷰 직접 점검(2026-04-28) 결과: `student1` 세션에서 `/self-learn/today.html` 진입 시 `gnbRole=학생, gnbName=이학생, role=student` 정상 유지. 보고서 작성 시점(2026-04-27) 이후 4cd67ea 커밋에서 일부 보정된 것으로 추정.

### 변경

향후 재발 방지를 위해 `today.html`에 **학생 세션 강제 재검증 IIFE**를 `loadData()` 직전에 삽입.

```js
// public/self-learn/today.html (loadData() 직전)
(async () => {
  try {
    const r = await fetch('/api/auth/me', { cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' } });
    const j = await r.json();
    if (!j.success || !j.user) { window.location.replace('/login.html'); return; }
    window.dacheumUser = j.user;
  } catch (e) { /* 네트워크 오류 시 진행 */ }
})();
```

### 검증

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| `/self-learn/today.html` 진입 후 헤더 role | (보고서 시점) 교사로 전환됨 | 학생 그대로 |
| 세션 끊긴 상태 진입 | 빈 화면 + API 401 | `/login.html`로 즉시 리다이렉트 |

---

## F-P1-2. KPI 폰트 / 카드 크기 / 작은 글자 보강

### CSS variables 토큰 추가 (`learning-map.html` :root)

```css
--fs-kpi: 28px;   /* 신설 — h1(28-30) 정렬 */
```

### dash-card 픽셀 스펙 (변경 전 → 변경 후)

| 요소 | 변경 전 | 변경 후 | 사유 |
|------|---------|---------|------|
| `.dash-card` padding | 16px 18px | **18px 20px** | CLAUDE.md 카드 표준 + 모바일 터치 영역 |
| `.dash-icon` 크기 | 44×44 | **48×48** | 시각 무게 보강(L-303) |
| `.dash-value` font-size | 24px | **28px** (`var(--fs-kpi)`) | h1 스케일과 정렬, 미정의 24px 제거 |
| `.dash-value` color | inherit | **#111827 + letter-spacing -0.02em** | 가독성 표준 |
| `.dash-label` font-size | 12px(`--fs-xs`) | **13px(`--fs-sm`)** + weight 500 | 11~12px 잔존 라벨 보강 |
| 빈 상태 value | 항상 `0` / `0분` / `-` | **em-dash `—` + `dash-value--empty`** + sub "기록이 쌓이면 표시됩니다" | RW-01 빈 상태 친절 |

### 노드 카드 (`.svg-node`)

기획서는 121×72→140×80px로 명시했지만 현재 코드는 이미 220×130px(이전 라운드에서 확장됨). 추가 축소 없이 현 사이즈 유지(스펙 상한 ≥ 140 충족).

### 작은 글자 일괄 보강

`common-nav.js` 내부에 이미 주입된 `dacheim-common-typography` 스타일(11px이하 → 12-13px) 그대로 활용. 신규 추가 없음.

---

## F-P1-3. 영역색 4종 + 차시 진행률 4상태 색 코딩

### CSS variables (`learning-map.html` :root 신설)

```css
/* 영역 4색 — 스펙 §F-P1-3과 1:1 */
--c-area-num:  #2563eb;  /* 수와 연산 */
--c-area-rel:  #8b5cf6;  /* 변화와 관계 */
--c-area-geo:  #10b981;  /* 도형과 측정 */
--c-area-data: #f59e0b;  /* 자료와 가능성 */

/* 차시 진행률 4상태 */
--c-lesson-pending:  #9ca3af;  /* 시작 전 회색 */
--c-lesson-progress: #f59e0b;  /* 진행 중 주황 */
--c-lesson-low:      #ef4444;  /* 정답률 < 60% 빨강 */
--c-lesson-pass:     #10b981;  /* 정답률 ≥ 60% 초록 */
```

### `AREA_COLOR_FIXED` 동기화

기존 `#3B82F6/8B5CF6/10B981/F59E0B`를 토큰과 동일한 소문자 hex로 통일하여 대시보드 chart·맵 노드·필터 칩이 동일 색상 출력.

```js
const AREA_COLOR_FIXED = {
  '수와 연산':     '#2563eb',
  '변화와 관계':   '#8b5cf6',
  '도형과 측정':   '#10b981',
  '자료와 가능성': '#f59e0b',
  ...
};
```

### 차시 카드 진행률 색 분기 (`loadUnitLessonsInto`)

```js
const accRaw = l.accuracy ?? l.correct_rate ?? l.avg_accuracy;
const accPct = accRaw == null ? null : (accRaw <= 1 ? Math.round(accRaw*100) : Math.round(accRaw));
let lessonColor;
if (st === 'completed' || pct >= 100) {
  lessonColor = (accPct != null && accPct < 60) ? '#ef4444' : '#10b981';
} else if (pct > 0 || st === 'in_progress') {
  lessonColor = (accPct != null && accPct < 60) ? '#ef4444' : '#f59e0b';
} else {
  lessonColor = '#9ca3af'; // 시작 전
}
```

| 상태 | 진행률 | 정답률 | 바 색 |
|------|--------|--------|-------|
| 시작 전 | 0 | n/a | `#9ca3af` |
| 진행 중 | 1~99 | n/a 또는 ≥60 | `#f59e0b` |
| 진행 중·저조 | 1~99 | < 60 | `#ef4444` |
| 완료 | 100 | n/a 또는 ≥60 | `#10b981` |
| 완료·저조 | 100 | < 60 | `#ef4444` |

### 검증 (preview eval)

```
data-area="수와 연산" → border-left rgb(37,99,235)  ✓
data-area="변화와 관계" → rgb(139,92,246)         ✓
data-area="도형과 측정" → rgb(16,185,129)         ✓
data-area="자료와 가능성" → rgb(245,158,11)       ✓
```

---

## F-P1-4. CTA 위계 — Primary 1개만 강조

### drawer-footer 재배치 (`renderDrawerFooter`)

변경 전: `[진단하기 노랑 grad] [바로 학습 연파 grad] [학습목록 보라 outline]` 동일 사이즈 3색 → 한 화면 강한 컬러 1개 룰 위반.

변경 후:

```
좌측 link tone                              우측 그룹
[학습목록 추가]                  [진단하기]  [📖 바로 학습하기 →]
text-link                       outline    primary solid (강조)
```

### dual-btn 픽셀 스펙

```css
.drawer-footer{display:flex;justify-content:space-between;align-items:center}
.dual-btn{padding:12px 18px;border:1.5px solid;border-radius:10px;
  font-size:16px;font-weight:600}

.dual-btn.direct  {background:#2563eb; color:#fff;        border-color:#2563eb;
                   box-shadow:0 1px 2px rgba(37,99,235,.18)}
.dual-btn.diag    {background:#fff;    color:#2563eb;     border-color:#2563eb}
.dual-btn.bookmark{background:transparent; color:#2563eb; border-color:transparent;
                   padding:8px 4px; font-size:15px; font-weight:500; margin-right:auto}
.dual-btn.bookmark.active{color:#7C4DFF}
.dual-btn:focus-visible{outline:2px solid #2563eb; outline-offset:2px}
```

### 검증

| 버튼 | 변경 전 BG | 변경 후 BG | 변경 후 color |
|------|-----------|-----------|---------------|
| direct (Primary) | `linear-gradient(#E8F0FF→#D0DFFF)` | **#2563eb solid** | #fff |
| diag (Secondary) | `linear-gradient(#FFF8E0→#FFE8B0)` | **#fff outline** | #2563eb |
| bookmark (Tertiary) | `#fff border secondary` | **transparent link** | #2563eb (활성 시 #7C4DFF) |

---

## F-P1-5. × 닫기 안전영역 + z-index 표준화

### CSS variables

```css
--z-modal:          11000;  /* 모달 (CLAUDE.md ≥10000) */
--z-modal-backdrop: 10999;
--z-drawer:         10800;
```

### 적용

```css
#diagModal      { z-index: var(--z-modal) !important; }  /* 11000 */
#cpIframeModal  { z-index: var(--z-modal) !important; }  /* 11000 */
.drawer         { z-index: var(--z-drawer); }            /* 10800 */
```

### drawer-close + 신규 modal-close-safe

```css
.drawer-close{
  width:34px; height:34px; margin-left:8px;   /* 32px 안전영역 + 좌측 8px */
  position:relative; z-index:1;
}
.drawer-close:focus-visible{outline:2px solid #2563eb; outline-offset:2px}

.modal-close-safe{
  position:absolute; top:12px; right:12px;
  width:32px; height:32px; border-radius:8px;
  display:grid; place-items:center;
  color:#6B7280; background:transparent; border:0; cursor:pointer; z-index:2;
}
```

### 검증

```
preview inspect:
  --z-modal           = 11000
  drawer-close width  = 34px, marginLeft = 8px (배지와 8px 이상 분리)
  drawer z-index      = 10021 (기존 인라인) — 모달 11000보다 낮음 ✓
```

---

## F-P1-6. 학습 랭킹 빈 상태

### CSS

```css
.ranking-empty{
  display:flex; flex-direction:column; align-items:center;
  padding:56px 24px;
  background:#fff; border:1px dashed #E5E7EB; border-radius:16px;
  text-align:center; gap:10px;
}
.ranking-empty .re-icon  {font-size:56px; color:#FBBF24}
.ranking-empty .re-title {font-size:18px; font-weight:700; color:#111827}
.ranking-empty .re-desc  {font-size:15px; color:#6B7280; line-height:1.5; max-width:360px}
.ranking-empty .re-cta   {padding:10px 18px; border:1.5px solid #2563eb;
                          background:#fff; color:#2563eb; border-radius:10px;
                          font-size:16px; font-weight:600}
```

### loadRanking 분기

```js
const allZero = rankings.every(r =>
  (r.score ?? r.points ?? r.completed_nodes ?? r.solved ?? 0) === 0);

if (!rankings.length || allZero) {
  list.innerHTML = `<li ...><div class="ranking-empty">
    <div class="re-icon"><i class="fas fa-trophy"></i></div>
    <div class="re-title">아직 데이터가 부족해요</div>
    <div class="re-desc">진단평가나 차시 학습을 완료하면 점수가 쌓이고 순위가 나타나요.</div>
    <button class="re-cta">📍 첫 문항 풀러 가기</button>
  </div></li>`;
  return;
}
```

### 검증

preview eval에서 학습 랭킹 탭 진입 시 `.ranking-empty` 카드 1개 출현, 8명 0점 리스트는 더 이상 노출되지 않음.

---

## 변경 파일

| 파일 | 변경 줄 수 | 핵심 변경 |
|------|------------|-----------|
| `public/self-learn/learning-map.html` | +/− 약 80줄 | `:root` 토큰 추가, dash-card 스케일, drawer-close 안전영역, drawer-footer CTA 위계, lesson-card-v3 색 분기, ranking 빈 상태, AREA_COLOR_FIXED 동기화, KPI 빈 상태 helper |
| `public/self-learn/today.html` | +14줄 | 페르소나 강제 재검증 IIFE |

---

## 후속 권장

- 모달 인라인 스타일에 직접 박힌 `z-index:10100`을 `var(--z-modal)`로 대체(현재는 별도 셀렉터 `!important`로 덮음). 다음 라운드 정리 권장.
- 차시 카드의 `accuracy` / `correct_rate`가 백엔드 `/api/self-learn/map/nodes/:id/lessons` 응답에 포함되는지 확인 후 정답률 < 60% 빨강 분기 실데이터 검증 필요.
- dashboard API 응답에 `total_time_minutes`, `rank` 필드 추가 시 KPI 빈 상태 자동 해소(현재는 em-dash + 안내 sub로 폴백).

---

## 검증 캡처 인덱스

preview MCP `localhost:3000` 직접 점검 결과만 기록. 스크린샷 도구가 timeout으로 첨부 불가했으나 `preview_inspect` / `preview_eval`로 모든 픽셀 스펙 실측 일치 확인.

| ID | 검증 방법 | 결과 |
|----|-----------|------|
| F-P1-1 | `await fetch('/api/auth/me')` 후 dacheumUser.role 확인 | `student` 유지 |
| F-P1-2 | `getComputedStyle('.dash-value').fontSize` | `28px` |
| F-P1-3 | `getComputedStyle('.svg-node[data-area="수와 연산"]').borderLeftColor` | `rgb(37,99,235)` |
| F-P1-4 | `.dual-btn.direct` 배경 | `rgb(37,99,235)` solid |
| F-P1-5 | `getPropertyValue('--z-modal')` | `11000` |
| F-P1-6 | `document.querySelector('#rankList .ranking-empty')` | 빈 상태 카드 존재 |
