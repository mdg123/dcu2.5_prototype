# AI 맞춤학습 보완 기획서 — UI/UX 재기획

작성: UI 디자이너 / 기준일: 2026-04-27
대응 점검 보고서: `docs/audit-self-learn/ui-designer-audit.md`
원칙(CLAUDE.md): 사용자 중심 / 동일 기능 동일 레이아웃 / 한 화면 강한 컬러 1개 / 공통 스케일(body 17, h1 28-30, button 16, badge 13)

---

## 우선순위 표

| 우선순위 | ID | 항목 | 영향 파일(line) | 예상 공수 |
|----------|----|------|------------------|-----------|
| P0 | RW-01 | 대시보드 4-grid 데이터 단일화 + 빈 상태 | learning-map.html L650-683, L1379-1393 / dashboard API | 0.5d |
| P0 | RW-02 | 진단 모달 카운터·헤더 정리 | learning-map.html (diagModal 헤더 렌더 함수) | 0.3d |
| P0 | RW-03 | × 버튼 안전 영역 / z-index 11000 | 공통 modal CSS | 0.2d |
| P0 | RW-04 | 페르소나 라우팅 정상화 | dev fixture / 헤더 컴포넌트 | 0.5d (백엔드 동반) |
| P1 | RW-05 | 학습맵 노드 카드 가독성 재정의 | learning-map.html `.svg-node` | 0.5d |
| P1 | RW-06 | 노드 드로어 헤더 3단 압축 | learning-map.html nodeDrawer header | 0.4d |
| P1 | RW-07 | 차시 진행률 바 상태 색 | learning-map.html lesson card v3 | 0.2d |
| P1 | RW-08 | 학습 랭킹 빈 상태 | learning-map.html ranking tab | 0.3d |
| P1 | RW-09 | 드로어 푸터 CTA 위계 | learning-map.html drawer-footer | 0.2d |
| P2 | RW-10 | 색상·스케일 표준 정합 | 전역 CSS variables | 0.5d |
| P2 | RW-11 | 학습경로 빈 상태 카드 강화 | learning-map.html path tab | 0.2d |
| P2 | RW-12 | 반응형 1024 분기 | dashboard-grid CSS | 0.2d |

---

## P0 — 반드시 수정

### RW-01. 대시보드 4-grid 카드 — 데이터 단일화 & 빈 상태

#### 현재
- API `/api/self-learn/dashboard` 키: `totalNodes, completedNodes, inProgressNodes, total_solved, avg_accuracy, total_attempts, progressPercent, streak, area_stats, recent_problems, recentDiagnosis`
- `loadDashboard()`가 참조하지만 응답에 없는 키: `total_time_minutes`, `totalTimeMinutes`, `rank`
- 결과: "총 학습 시간" 카드 항상 `0분`, "랭킹" 카드 항상 `-`
- 동일 페이지 "나의 기록" 탭은 `total_solved=19, avg_accuracy=37%`를 표시 → **0과 19 동시 표출**

#### 변경안
**(a) 카드 구성 재정의** — 데이터가 확보된 4개 KPI로 교체

| 카드 | 표시값 | 보조(sub) | 색상 |
|------|--------|-----------|------|
| 1. 완료한 노드 | `completedNodes` 0 | `전체 {totalNodes}개` | primary 파랑 |
| 2. 학습 진행률 | `progressPercent` 0% | `{inProgressNodes}개 진행 중` | success 초록 |
| 3. 푼 문제 | `total_solved` 19 | `평균 정답률 {avg_accuracy}%` | warning 노랑 |
| 4. 연속 학습 | `streak` 일 | `최근 7일 {streak_week}일 학습` | secondary 보라 |

→ "총 학습 시간"·"랭킹"은 별도 데이터 소스가 준비되기 전까지 카드에서 제거. 랭킹은 이미 전용 탭이 있으므로 중복 해소.

**(b) 빈 상태 처리**
```
value === 0 또는 null:
  value = "—" (em-dash, color #9CA3AF)
  sub = "기록이 쌓이면 표시됩니다"
```

**(c) 데이터 단일 소스화** — `dashboardCache` 객체를 "나의 기록" 탭이 그대로 재사용. `loadRecord()`에서 별도 fetch 제거하고 `dashboardCache.total_solved`, `.avg_accuracy`, `.area_stats`, `.recent_problems` 사용.

#### 스펙
```css
.dash-card {
  padding: 20px 24px;            /* 16/18 → 20/24 */
  border-radius: 16px;
  display: flex; gap: 16px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.dash-icon { width: 48px; height: 48px; border-radius: 12px;
  display:grid; place-items:center; color:#fff; font-size:20px; }
.dash-label { font-size: 13px; color: #6B7280; font-weight: 500; }
.dash-value { font-size: 28px; line-height: 1.2; color: #111827;
  font-weight: 700; letter-spacing: -0.02em; }
.dash-sub   { font-size: 12px; color: #9CA3AF; margin-top: 2px; }
.dash-value--empty { color: #9CA3AF; font-weight: 600; }
```

#### 와이어프레임
```
┌──────────────────────────────────────────────────────────────┐
│ [icon] 완료한 노드     [icon] 학습 진행률                    │
│        0                       0%                            │
│        전체 146개              3개 진행 중                   │
├──────────────────────────────────────────────────────────────┤
│ [icon] 푼 문제         [icon] 연속 학습                      │
│        19                      0일                           │
│        평균 정답률 37%         최근 7일 0일 학습             │
└──────────────────────────────────────────────────────────────┘
```

#### 영향 파일
- `public/self-learn/learning-map.html`
  - L650-683: 카드 마크업 4개(이름·id·sub 변경)
  - L1379-1393: `loadDashboard()` 매핑 갱신, 빈 상태 분기 추가
  - L1395 이후 "나의 기록" 렌더 함수: `dashboardCache` 참조로 통일
- (선택) `routes/self-learn.js` 또는 dashboard 핸들러: 향후 `total_time_minutes`, `streak_week` 추가 가능성 메모

---

### RW-02. 진단 모달 카운터 정리

#### 현재
- 헤더: "진단하기 풀이 1/3 · 문항 1/2"
- 바디: "문항 1/1 · 객관식 10점"
- 분모 1·2·3 동시 노출 → 신뢰도 손상

#### 변경안
헤더는 "**진단 단계 진행**"만, 바디는 "**현재 단계의 문항 진행**"만 표시.

```
헤더 좌측: [step-badge] 1단계 — 풀이중   ← (총 3단계)
바디 상단: 문항 N/M  ·  객관식  ·  10점     ← 현재 단계 내 진행
```

#### 스펙
```css
.diag-step-badge { font-size: 13px; font-weight: 600; color: #4B5563;
  background: #F3F4F6; padding: 4px 10px; border-radius: 999px; }
.diag-q-meta { font-size: 13px; color: #6B7280; display: flex; gap: 8px; }
.diag-q-meta strong { color: #111827; font-weight: 600; }
```

헤더 텍스트 max-width: `calc(100% - 64px)` (× 버튼 영역 확보), 한 줄 ellipsis.

#### 영향 파일
- `public/self-learn/learning-map.html` diagModal 렌더 함수 — 헤더 두 곳 + 바디 한 곳을 위 라벨 체계로 정리.

---

### RW-03. 모달 닫기(×) 안전 영역 / z-index

#### 변경안
모든 모달·드로어 닫기 버튼 공통 규칙:

```css
.modal-close, .drawer-close {
  position: absolute; top: 12px; right: 12px;
  width: 32px; height: 32px; border-radius: 8px;
  display: grid; place-items: center;
  color: #6B7280; background: transparent; border: 0; cursor: pointer;
}
.modal-close:hover { background: #F3F4F6; color: #111827; }
.modal-close:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
.modal { z-index: 11000; }       /* CLAUDE.md ≥10000 */
.modal-backdrop { z-index: 10999; }
.drawer { z-index: 10800; }
```

× 버튼 좌측 40px 안에 배지·버튼·텍스트 금지(헤더 우측 padding 64px).

---

### RW-04. 페르소나 자동 전환 정상화

#### 현재
`/self-learn/today.html` 진입 시 헤더가 학생→교사로 전환됨. 학생 시나리오 점검 자체가 어려움.

#### 변경안 (UI 측면)
- 헤더 우상단 페르소나 표시: 현재 텍스트 "교사 김선생" 작은 크기 → **아이콘 + 색 토큰**
  - 학생: 파랑 dot + "학생"
  - 교사: 보라 dot + "교사"
- 페르소나 전환 시 toast "교사 모드로 전환되었습니다" 1.5s
- 백엔드: dev 자동 로그인 fixture에서 `/self-learn/*` 진입 시 학생 세션 유지 확인(별도 백엔드 작업 필요)

---

## P1 — 강력 권장

### RW-05. 학습맵 노드 카드 재정의

#### 현재
121×72px, 5줄 텍스트, 동일 회색 톤, 상태 라벨이 텍스트로만.

#### 변경안
```
┌────────────────────────────┐  140×80px
│ [영역도트] 9까지의 수      │  title 13px / 600 / #111827 / 2줄 ellipsis
│ 초1·1학기 · 차시 5         │  meta 11px / #6B7280 / 한 줄
│ ━━━━━━━━━━━━━━━━━━ ●     │  진행률 바 4px + 우측 상태 도트 8px
└────────────────────────────┘
```

#### 스펙
```css
.svg-node { min-width: 140px; height: 80px; padding: 10px 12px;
  border-radius: 12px; background:#fff; border:1px solid #E5E7EB; }
.svg-node__title { font: 600 13px/1.3 var(--ko); color:#111827;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.svg-node__meta { font: 400 11px/1.4 var(--ko); color:#6B7280; margin-top:4px; }
.svg-node__bar { height:4px; border-radius:2px; background:#E5E7EB; margin-top:6px; }
.svg-node__bar > span { display:block; height:100%; border-radius:2px; }
.svg-node--available .svg-node__bar > span { background:#9CA3AF; width:0; }
.svg-node--in-progress .svg-node__bar > span { background:#3B82F6; }
.svg-node--done .svg-node__bar > span { background:#10B981; width:100%; }
.svg-node--diagnosing .svg-node__bar > span { background:#F59E0B; }
.svg-node__dot { width:8px;height:8px;border-radius:50%; }  /* 영역색 */
```

영역 색: 수와연산 `#3B82F6` / 변화와관계 `#8B5CF6` / 도형과측정 `#10B981` / 자료와가능성 `#F59E0B`.

---

### RW-06. 노드 드로어 헤더 3단 압축

#### 변경안
```
[← 차시 목록으로]   수와 연산 / 초1학년 / 1학기              [×]
[수와연산] [초1학년] [학습가능]
9까지의 수                                  수와 연산 · 초1학년 1학기
```
- 1줄: 백버튼(왼) + 브레드크럼(중앙) + 닫기(오)
- 2줄: 배지 인라인 3개
- 3줄: 타이틀 20px + 부제 13px

#### 스펙
```css
.drawer-title { font-size: 20px; font-weight: 700; color:#111827; }
.drawer-subtitle { font-size: 13px; color:#6B7280; margin-left: 12px; }
.drawer-badges { display:flex; gap:6px; margin: 4px 0 8px; }
.drawer-badges .badge { font-size: 12px; padding: 3px 8px; border-radius: 6px; }
```

---

### RW-07. 차시 카드 진행률 색상 코딩

#### 변경안
| 상태 | 진행률 | 바 색 | 배지 | 좌측 스트라이프 |
|------|--------|-------|------|-----------------|
| 새 차시 | 0% | `#E5E7EB` | "새 차시" 회색 | 없음 |
| 학습 중 | 1~99% | `#3B82F6` | "학습 중" 노랑 | 4px 파랑 |
| 완료 | 100% | `#10B981` | "완료" 초록 | 4px 초록 |
| 진단 중 | — | `#F59E0B` | "진단 중" 주황 | 4px 주황 |

차시 카드 좌측 4px 스트라이프 추가 → 스캔 시 상태 즉시 인지.

---

### RW-08. 학습 랭킹 빈 상태

#### 변경안
모든 학생 점수 합계가 0이면 리스트 대신 빈 상태 카드:

```
┌─────────────────────────────────────────────┐
│             🏆 (트로피 64px)                 │
│                                             │
│        아직 점수 기록이 없어요               │
│   진단평가나 차시 학습을 완료하면           │
│       점수가 쌓이고 순위가 나타나요          │
│                                             │
│        [진단평가 시작하기]                   │
└─────────────────────────────────────────────┘
```

스펙: 카드 padding 56px / 일러스트 64px / title 18px / desc 15px / `#6B7280` / CTA 파랑 outline.

---

### RW-09. 드로어 푸터 CTA 위계

#### 현재
[진단하기 노랑] [첫 차시 바로 학습 연파] [학습목록 추가 연보] — 동일 사이즈 3색.

#### 변경안
```
[학습목록 추가]              [진단하기]  [첫 차시 바로 학습 →]
text-link, 좌측              outline     primary solid (강조)
```

- 1차 CTA: "첫 차시 바로 학습" — 파랑 solid, 우측 정렬, 폭 자동 + 우측 화살표
- 2차 CTA: "진단하기" — 파랑 outline, 1차 옆
- 보조: "학습목록 추가" — 좌측 text-link(아이콘+텍스트, 파랑)

스펙
```css
.btn-primary { background:#3B82F6; color:#fff; padding:12px 20px; border-radius:10px;
  font-size:16px; font-weight:600; }
.btn-outline { background:#fff; color:#3B82F6; border:1.5px solid #3B82F6;
  padding:11px 18px; border-radius:10px; font-size:16px; font-weight:600; }
.btn-link { background:transparent; color:#3B82F6; padding:8px 4px; font-size:15px; }
```

---

## P2 — 권장

### RW-10. 색상·스케일 표준 정합

전역 CSS variables 정리:
```css
:root {
  /* type scale (CLAUDE.md) */
  --fs-body: 17px;
  --fs-h1: 28px;
  --fs-h2: 22px;
  --fs-button: 16px;
  --fs-badge: 13px;
  --fs-meta: 12px;
  --fs-kpi: 28px;        /* 신설 */

  /* semantic colors */
  --c-ink: #111827;
  --c-ink-2: #4B5563;
  --c-mute: #6B7280;
  --c-line: #E5E7EB;

  --c-primary: #3B82F6;
  --c-primary-dark: #2563EB;
  --c-success: #10B981;
  --c-warning: #F59E0B;
  --c-danger: #EF4444;
  --c-secondary: #8B5CF6;

  /* area (도형과 측정 등) — RW-05와 일치 */
  --c-area-num: #3B82F6;
  --c-area-rel: #8B5CF6;
  --c-area-geo: #10B981;
  --c-area-data: #F59E0B;

  --r-sm: 8px;  --r-md: 12px;  --r-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.04);
  --shadow-md: 0 4px 12px rgba(0,0,0,.08);
}
```

### RW-11. 학습경로 빈 상태 강화
빈 카드 안에 [AI 경로 생성] · [진단평가 시작] 두 CTA 인라인. 우상단 버튼은 보조로 유지.

### RW-12. 반응형 분기점
```css
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}
@media (max-width: 768px) {
  .dashboard-grid { grid-template-columns: 1fr 1fr; }
  .dash-value { font-size: 22px; }
}
@media (max-width: 480px) {
  .dashboard-grid { grid-template-columns: 1fr; }
}
```

학습맵: 모바일에서 SVG 줌·팬 외에 **Linear 모드(리스트형)** 토글 필요(이번 범위 외, 후속 과제로 명시).

---

## 색상·스케일 변경 표

| 요소 | 현재 | 변경 | 사유 |
|------|------|------|------|
| KPI value | 24px | 28px | h1(28-30)과 정렬, 강조 |
| KPI label | 미표준 | 13px badge 토큰 | 공통 스케일 |
| 페이지 타이틀 | 24px | 28px | h1 표준 |
| 카드 padding | 16/18 | 20/24 | 시각 호흡, 모바일 터치 영역 |
| dash-card border-radius | var(--radius-lg) | 16px(고정) | 토큰 명시 |
| modal z-index | 추정 9999 | 11000 | CLAUDE.md ≥10000 |
| 노드 카드 폭 | 121px | 140px | 제목 2줄 보장 |
| 진단 CTA 색 | 노랑 | 파랑 outline | 노랑은 "주의/진단 중" 의미로 한정 |
| 진행률 바 | 단색 회색 | 상태별 4색 | 색상 코딩 일관성 |

---

## 인터랙션 표준 (변경분)

| 상태 | 스펙 |
|------|------|
| hover (버튼) | brightness 95% + transform: translateY(-1px) + shadow-md, 150ms |
| focus-visible | `outline: 2px solid #3B82F6; outline-offset: 2px;` |
| disabled | opacity 0.4, cursor not-allowed, shadow 제거 |
| 카드 hover | shadow-md, border-color #D1D5DB |
| 모달 진입 | 200ms ease-out, transform: translateY(8px)→0, opacity 0→1 |
| 드로어 진입 | 220ms ease-out, transform: translateX(100%)→0 |

---

## 시나리오 검증 (변경 후 가설)

1. **"오늘 무엇을 학습할지"** — 4-grid 첫 카드 "완료한 노드 0/146" + 셋째 카드 "푼 문제 19 / 평균 정답률 37%" → 학생이 "내가 19개 풀었고 평균 37%이며 아직 0개 단원 완료" 한눈에 파악. 빈 상태에서는 카드가 "—"로 표시되고 학습 시작 유도.
2. **진단 → 결과 → 학습** — 모달 헤더 "1단계 풀이중", 바디 "문항 1/3" 단일 카운터로 혼란 제거. 결과 후 학습경로 탭 자동 이동 + 빈 상태 카드의 [AI 경로 생성] CTA로 즉시 다음 단계.
3. **푼 문제 통계** — 대시보드 KPI = 나의 기록 탭 수치 일치(단일 캐시).
4. **위치 명확성** — 드로어 헤더 브레드크럼 + 백버튼이 1줄에 정리, × 버튼 안전 영역 보장.
5. **탭 간 이동** — 상단 4탭(학습맵·진단·경로·기록·랭킹) + 드로어 푸터 [학습목록 추가]가 명확한 위계로 분리.

---

## 산출물 체크리스트

- [x] 점검 보고서 `ui-designer-audit.md` (실측·캡처 기반, 추측 0)
- [x] 보완 기획서 `ui-designer-rework-plan.md` (P0/P1/P2 + 픽셀 스펙)
- [ ] 후속: 모바일 Linear 뷰 별도 기획서
- [ ] 후속: dashboard API 응답 스키마 PR(`total_time_minutes`, `rank` 필요시)

---

## 핵심 메시지

> **사용자 지적은 정확하다 — 대시보드는 시각이 아니라 데이터 매핑이 망가져 있다.**
> 1순위는 카드 4개 중 2개의 "유령 데이터" 제거 + 동일 페이지의 두 영역(상단 카드 ↔ 나의 기록 탭) 단일 소스 통합.
> 그 다음이 노드 카드·드로어·랭킹·CTA 위계 등 시각 정합성. 디자인은 데이터가 정상화된 위에서만 의미를 가진다.
