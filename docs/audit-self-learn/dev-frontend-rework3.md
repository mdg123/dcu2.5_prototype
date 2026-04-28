# Frontend rework #3 — 감리 P1 후속 처리

- 일시: 2026-04-28
- 담당: Frontend (opus)
- 대상 보고서: `qa-final-audit.md`(RES-003 / RES-004), `student-tester2.md`(H-3 / M-3)
- 브랜치: `feat/curriculum-std-aidt`
- 워크트리: `.claude/worktrees/distracted-blackwell`
- 메인 폴더 sync 완료

---

## 처리 요약

| ID | 항목 | 등급 | 처리 결과 |
|----|------|------|-----------|
| F-P1-A | 대시보드 rank 카드 ↔ 랭킹 탭 데이터 소스 통일 | P1 | ✅ 해소 (옵션 B — `dashboardCache` 단일 소스화) |
| F-P1-B | today.html 빈 데이터 UX 보강 | P1 | ✅ 해소 (안내 + CTA 2종 + 0/0 통계 안내) |
| F-P1-C | 영상 카드 디자인 디테일 | 선택 | 작업 시간 미여유로 미점검 |

---

## F-P1-A. 대시보드 rank vs 랭킹 탭 데이터 소스 통일

### 1. 문제 (감리 RES-003 / 학생 테스터 H-3)

- 대시보드 카드 "랭킹 1위 (전체 5명)" — `/api/self-learn/dashboard` 의 `rank`/`total_users` 사용
- 학습 랭킹 탭 — `/api/self-learn/ranking` API 응답 사용
- 두 API 결과가 비어 있을 때 또는 cohort 계산 기준이 달라질 때 "1위 ↔ 데이터 없음" 모순 발생
- 기존 `loadRanking()` 마지막 5줄: ranking API 응답으로 `dashRank` 를 덮어쓰는 코드가 있어 두 소스가 충돌

### 2. 처리 방침

**옵션 B 채택** — `dashboardCache` 를 단일 소스(Single Source of Truth)로 지정.

- 대시보드 카드: `loadDashboard()` 가 dashboardCache 에 저장 후 카드에 표시 (기존 동일)
- 랭킹 탭: `loadRanking()` 진입 시 `dashboardCache` 가 없으면 `loadDashboard()` 를 await 후, cache 의 `rank`/`total_users`/`total_solved` 를 본인 행의 정답 정보로 사용
- ranking API 는 보조 데이터(2~10등 표시)로만 활용하며, 본인 행은 dashboardCache 가 있으면 항상 cache 기준으로 보정/삽입
- ranking API 응답으로 `dashRank` 를 다시 덮어쓰던 라인 제거 → 대시보드는 항상 dashboardCache 만 신뢰

### 3. 코드 변경 (`public/self-learn/learning-map.html` `loadRanking()`)

핵심 흐름:

1. `if (!dashboardCache) await loadDashboard()` — 단일 소스 강제 보장
2. `myRank = dc.rank`, `totalUsers = dc.total_users`, `myScore = dc.total_solved ?? completedNodes`
3. ranking API 호출 → `rankings` 배열 확보 (보조)
4. `myRank > 0` 이면:
   - 본인 행이 API 결과에 이미 있으면 score 만 cache 기준으로 보정
   - 없으면 `myRank-1` 위치에 본인 행 삽입
5. 이전의 `$('dashRank').textContent = (myIdx + 1) + '위'` 라인 **제거** → dashboardCache 가 단일 소스

### 4. 검증 (preview, student1)

- dashboard 카드: `dashRank="1위"`, `dashRankSub="전체 5명"`
- 랭킹 탭 첫 행: `<li class="rank-item me"> ... <div class="rank-num gold">1</div> ... <span class="rank-score">18점</span>`
- 일치: 두 화면 모두 "1위, 본인 행 (나) 표시" 정합

### 5. 검증 (preview, teacher1)

- dashboard 카드: `dashRank="—"`, `dashRankSub="아직 데이터가 없어요"` (교사는 cohort 미포함 → rank 없음)
- 랭킹 탭: 학생 5명 표시되나 "(나)" 표기 없음 — 교사 본인이 랭킹에 등장하지 않으므로 일관됨
- 두 화면 모두 "교사는 랭킹 대상 아님" 메시지 일관

---

## F-P1-B. today.html 빈 데이터 UX

### 1. 문제 (감리 RES-004 / 학생 테스터 M-3)

- student1 등 신규 학생: `daily_learning` 시드 없음 → "배정된 학습이 없습니다" 단일 줄만 표시
- 학습 그리드가 사실상 빈 화면처럼 보여 동기부여 저하
- 동시에 상단 "학습 목표 달성률" 위젯이 0% / 0/0 으로 표시되며 의미 모호

### 2. 처리 방침

1. 학습 카드 그리드 빈 상태를 "친절한 안내 + CTA 2종" 카드로 재디자인
2. 통계 영역(`goalPct`)이 0/0 일 때 grayout + tooltip 으로 학습 시작 전임을 명시
3. 모든 변경은 인라인 스타일로 처리하여 기존 CSS 토큰(`--fs-lg/sm`, `var(--gray-*)`)과 일치

### 3. 빈 상태 카드 픽셀 스펙 (`public/self-learn/today.html` `renderLearnCards()` 빈 분기)

| 요소 | 스펙 |
|------|------|
| 컨테이너 | `grid-column:1/-1`, `background:#fff`, `border:1px dashed #E5E7EB`, `border-radius:12px`, `padding:36px 20px`, `display:flex;flex-direction:column;align-items:center;gap:10px` |
| 아이콘 원 | 64×64px, `border-radius:50%`, `background:#EFF6FF`, 내부 `<i class="fas fa-clipboard-list">` 30px / `#2563EB` |
| 헤드라인 | `font-size:var(--fs-lg)`, `font-weight:700`, `color:#111827` — 텍스트: "오늘 학습할 항목이 아직 없어요" (날짜 선택 시 "{MM/DD}에는 배정된 학습이 없어요") |
| 서브라인 | `font-size:var(--fs-sm)`, `color:#6B7280`, `line-height:1.5`, `max-width:420px` |
| CTA Primary | `<a href="/self-learn/learning-map.html">` "학습목록 추가하러 가기" — `padding:10px 18px`, `background:#2563EB`, `color:#fff`, `border-radius:10px` |
| CTA Secondary | `<a href="/self-learn/wrong-note.html">` "최근 풀이로 이어서" — outline `border:1.5px solid #2563EB`, `color:#2563EB`, `background:#fff` |
| (조건부) "전체 보기" | 날짜 선택 상태일 때만 노출, 회색 톤 |

반응형:
- `flex-wrap:wrap` + `justify-content:center` 로 모바일에서 자연 줄바꿈
- 컨테이너는 grid full row 차지 → 240px 최소 그리드 셀에 종속되지 않음

### 4. 통계 영역 0/0 안내

- `renderGoal()` 끝부분에서 `totalAll === 0` 일 때 `goalPct.style.color = 'var(--gray-400)'` + `title="학습이 배정되거나 시작되면 달성률이 표시됩니다"` 설정
- 0 이상이면 색상/title 초기화

### 5. 검증 (preview, student1 / teacher1)

| 페르소나 | hasEmpty | headline | btnCount | goalPctColor | goalTitle |
|----------|----------|----------|----------|--------------|-----------|
| student1 | true | "오늘 학습할 항목이 아직 없어요" | 2 | var(--gray-400) | "학습이 배정되거나 시작되면 달성률이 표시됩니다" |
| teacher1 | true | "오늘 학습할 항목이 아직 없어요" | 2 | var(--gray-400) | (동일) |

링크 검증:
- `<a href="/self-learn/learning-map.html">학습목록 추가하러 가기</a>`
- `<a href="/self-learn/wrong-note.html">최근 풀이로 이어서</a>`

---

## F-P1-C. 영상 카드 디자인 디테일

선택 항목으로 명시되어 있어 본 사이클에서는 미점검. 영상 콘텐츠는 EBS YouTube 96건 + placeholder 5건이 이미 4cd67ea 커밋에 임포트되어 있고, 카드 자체 디자인은 dev-frontend-rework2 §F-P1-3 에서 점검 완료된 상태.

---

## 변경 파일

```
M public/self-learn/learning-map.html  (loadRanking() 전면 재작성: dashboardCache 단일 소스화)
M public/self-learn/today.html         (renderLearnCards 빈 상태 카드 + renderGoal 0/0 안내)
```

워크트리 → 메인 폴더 sync 완료 (`public/self-learn/learning-map.html`, `public/self-learn/today.html`).

---

## 잔존 사항

- F-P1-C 영상 카드 디테일은 별도 트랙으로 권고
- 감리 RES-001 (콘텐츠 폴백 690건 영역별 동일 템플릿) — 콘텐츠팀 별도 트랙
- 감리 RES-005 (교사용 analytics.html self-learn API 연동) — 본 작업 범위 외
- 감리 RES-010 (content-player time 측정 미커밋) — 본 작업 범위 외 (`public/content/content-player.html` 의 `solveStartTime` staged 변경)

---

*본 보고서는 preview 도구로 student1·teacher1 양 페르소나 검증을 마친 후 메인 폴더 sync 완료된 시점의 결과를 정리한 문서입니다.*
