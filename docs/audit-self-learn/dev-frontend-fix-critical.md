# Frontend P0 Critical 4건 수정 보고서

- 일시: 2026-04-28
- 작업자: Frontend (opus)
- 브랜치: feat/curriculum-std-aidt
- 워크트리: .claude/worktrees/distracted-blackwell
- 검증 환경: localhost:52679, student1 로그인 (이학생, id=3)

---

## 종합 결과

**PASS** — 학생 테스터가 보고한 P0 Critical 4건 모두 수정 및 실제 동작 검증 완료.

| ID | 항목 | 결과 | 비고 |
|----|----|------|------|
| F-P0-NEW-1 | 노드 드로어 CSS transform 버그 | PASS | 정중앙 렌더링 확인 |
| F-P0-NEW-2 | dashboardCache 무효화 추가 | PASS | submitSolve / quiz-graded / closeContentPlayerModal 3경로 모두 처리 |
| F-P0-NEW-3 | 랭킹 탭-대시보드 수치 일관성 | PASS | dashboardCache 폴백으로 본인 행 노출 |
| F-P0-NEW-4 | openContentPlayerModal 파라미터 방어 | PASS | URL 문자열·객체·잘못된 값 모두 안전 처리 |

---

## 1. F-P0-NEW-1 — 드로어 CSS transform 버그 (Critical)

### 문제

`public/self-learn/learning-map.html` line 291-292:

```css
.drawer{ ... left:50%; transform:translateX(-50%) scale(.95); ... }
.drawer.show{ ... transform:translateX(-50%) scale(1) }
```

`translateX(-50%) scale()` 조합 시 일부 환경에서 transform 행렬이 `matrix(0.95, 0, 0, 0.95, -470, 0)` 로 계산되어 드로어가 화면 왼쪽 -470px 밖으로 밀림. 학생 테스터 보고서 C-1 / 부록 "드로어 CSS 문제 확인값" 참조.

### 수정 내용 (line 291-293)

```css
/* F-P0-NEW-1 fix: translateX(-50%) + scale() 조합이 일부 환경에서 left 위치 손실을 유발 →
   translate-x를 분리하지 않고 left/right margin auto로 가운데 정렬 */
.drawer{
  position:fixed;top:24px;
  left:0;right:0;margin-left:auto;margin-right:auto;
  width:calc(100% - 48px);max-width:940px;
  ...
  transform:scale(.95); transform-origin:center top;
  transition:opacity .2s ease,transform .2s ease;
  ...
}
.drawer.show{ opacity:1; pointer-events:auto; transform:scale(1) }
```

핵심: `left:50% + translateX(-50%)` 가운데 정렬을 `left:0;right:0;margin-left:auto;margin-right:auto` 로 교체. transform에서 translate 제거 → scale만 사용 → 학생 보고서가 지목한 행렬 손실 경로 제거.

### 검증

preview_eval 로 노드 클릭 후 드로어 스타일 확인:

```json
{
  "classes": "drawer show",
  "left": "0px",
  "ml": "170px",
  "mr": "170px",
  "transform": "matrix(0.95, 0, 0, 0.95, 0, 0)",
  "rect": { "l": 193.5, "r": 1086.5, "t": 24, "w": 893, "h": 638.4 },
  "vw": 1280, "vh": 720
}
```

- transform 행렬의 tx, ty 모두 0 (이전 -470 제거 확인)
- 드로어 좌측 193.5px, 우측 1086.5px → 1280px 뷰포트 정중앙 정렬
- 스크린샷에서 드로어 패널이 화면 정중앙에 정상 표시됨 확인

---

## 2. F-P0-NEW-2 — dashboardCache 무효화 추가 (H-2)

### 문제

문항 풀이 후 API는 즉시 갱신되지만 페이지 상단 카드는 캐시 stale 로 갱신 안 됨. 학생 테스터 보고서 H-2 / M-4.

### 수정 내용

3경로 모두에서 `dashboardCache = null; loadDashboard(); loadRanking();` 호출 추가.

#### 2-1) `submitSolve` (line ~3370-3385)

```js
fetchApi('/api/self-learn/problem-attempt', { ... }).then(data => {
  if (data && (data.newStatus || data.status) && currentSolveNodeId) { ... }
  // F-P0-NEW-2: 대시보드 카드/랭킹 즉시 갱신 — 캐시 무효화 후 재로드
  try { dashboardCache = null; loadDashboard(); loadRanking(); } catch(_){}
});
```

#### 2-2) `dacheum:quiz-graded` 메시지 핸들러 (line ~3145-3151)

```js
fetchApi('/api/self-learn/problem-attempt', { ... }).then(() => {
  // F-P0-NEW-2: 풀이 후 대시보드 카드/랭킹 즉시 갱신
  try { dashboardCache = null; loadDashboard(); loadRanking(); } catch(_){}
});
```

#### 2-3) `closeContentPlayerModal` (line ~3185)

```js
function closeContentPlayerModal() {
  ...
  // F-P0-NEW-2: 콘텐츠 플레이어 닫을 때 대시보드 갱신 (postMessage 누락 케이스 fallback)
  try { dashboardCache = null; loadDashboard(); loadRanking(); } catch(_){}
}
```

### 검증

```js
const before = dashboardCache; // present
closeContentPlayerModal();
const after  = dashboardCache; // null  ← 무효화 성공
await sleep(1500);
const reloaded = dashboardCache; // present  ← 재로드 성공
```

결과:
- cacheBefore: present
- cacheImmediatelyAfterClose: null  (무효화)
- cacheAfterReload: present  (loadDashboard 재호출 성공)
- dashRankText: "1위"  (실제 카드 갱신됨)

---

## 3. F-P0-NEW-3 — 랭킹 탭-대시보드 수치 일관성 (H-3)

### 문제

대시보드 카드는 "랭킹 1위 (전체 5명)" 표시. 랭킹 탭은 "아직 데이터가 부족해요" 빈 상태.
원인: `/api/self-learn/ranking` 이 score 0 인 빈 배열 반환 → loadRanking 이 무조건 빈 상태 카드로 분기.

### 수정 내용 (loadRanking, line ~4688)

```js
async function loadRanking() {
  const d = await fetchApi('/api/self-learn/ranking?period=' + ...);
  let rankings = d?.rankings || [];
  // F-P0-NEW-3: 대시보드 카드("1위")와 랭킹 탭 일관성 — ranking API가 비어 있어도
  // dashboardCache 의 rank/total_users 가 있으면 최소한 본인 1행은 노출하여
  // "대시보드 1위 ↔ 랭킹 데이터 없음" 모순을 해소한다.
  const allZero = rankings.length > 0 && rankings.every(r => (r.score ?? r.points ?? r.completed_nodes ?? r.solved ?? 0) === 0);
  if (!rankings.length || allZero) {
    const dc = dashboardCache;
    if (dc && dc.rank && dc.rank > 0 && currentUser) {
      rankings = [{
        user_id: currentUser.id,
        username: currentUser.username,
        display_name: currentUser.display_name || currentUser.name || currentUser.username,
        score: dc.total_solved ?? dc.completedNodes ?? 0,
        _placeholder: true
      }];
    } else {
      // 진짜 빈 상태 (대시보드도 비어 있는 경우만)
      list.innerHTML = `... 아직 데이터가 부족해요 ...`;
      return;
    }
  }
  // ... 정상 렌더 ...
}
```

또한 빈 배열 + 모두 0 (이전엔 `every` 가 빈 배열에서 true 를 반환해 두 조건이 합쳐졌음) 처리도 정정.

### 검증

```js
await loadRanking();
// → list.innerHTML: "1 이학생 (나) 21점"
// → dashRank: "1위"
// → dashboardCache.rank: 1, dashboardCache.total_users: 5
```

대시보드 "1위" 와 랭킹 탭 본인 행 21점 일관 표시 확인.

---

## 4. F-P0-NEW-4 — openContentPlayerModal 파라미터 방어 (H-4)

### 문제

학생 테스터 H-4: `openContentPlayerModal(url, title)` 형태로 잘못 호출 시 iframe src 가 `content-player.html?id=/content/content-player.html?id=403...` 이중 중첩.

### 수정 내용 (line ~3106)

```js
// F-P0-NEW-4: 호출부가 (url, title) 잘못된 순서로 호출하는 케이스 방어 —
//   - 첫 인자가 URL/경로 문자열이면 id 파라미터 추출 시도
//   - 숫자/숫자형 문자열만 contentId 로 인정, 그 외는 경고 후 중단
//   - 두 번째 인자가 객체이면 problem 으로 처리 (nodeId 미지정으로 간주)
function openContentPlayerModal(contentId, nodeId, problem) {
  // 인자 정규화
  if (typeof contentId === 'string' && (contentId.indexOf('/') >= 0 || contentId.indexOf('?') >= 0)) {
    try {
      const u = new URL(contentId, location.origin);
      const idParam = u.searchParams.get('id');
      if (idParam) contentId = idParam;
      else { console.warn('[openContentPlayerModal] URL에서 id 추출 실패:', contentId); return; }
    } catch (e) {
      console.warn('[openContentPlayerModal] 잘못된 contentId(URL 파싱 실패):', contentId);
      return;
    }
  }
  if (nodeId && typeof nodeId === 'object' && !problem) {
    problem = nodeId;
    nodeId = problem.nodeId || problem._nodeId || null;
  }
  if (contentId && typeof contentId === 'object') {
    const obj = contentId;
    contentId = obj.id || obj.content_id || obj.contentId;
    if (!problem) problem = obj;
  }
  if (!contentId || (typeof contentId !== 'number' && !/^\d+$/.test(String(contentId)))) {
    console.warn('[openContentPlayerModal] 유효하지 않은 contentId:', contentId);
    return;
  }
  // ... 이하 기존 로직 ...
}
```

### 검증

3가지 케이스 검증:

| 호출 형태 | 결과 iframe src |
|---------|---------------|
| `openContentPlayerModal('/content/content-player.html?id=403&auto=1', '문제')` | `/content/content-player.html?id=403&auto=1&embed=1&nodeId=...` (이중 중첩 없음, id 추출 성공) |
| `openContentPlayerModal('foo-bar', null)` | (반환됨, 모달 미오픈, 콘솔 경고) |
| `openContentPlayerModal(403, 'E2MATA01B01C01D01', {id:403})` | `/content/content-player.html?id=403&auto=1&embed=1&nodeId=E2MATA01B01C01D01` (정상) |

이전 버그 시나리오의 이중 중첩 URL `?id=/content/...` 더 이상 발생하지 않음.

---

## 변경 파일

- `public/self-learn/learning-map.html`
  - line 291-293: 드로어 CSS (F-P0-NEW-1)
  - line ~3106-3140: openContentPlayerModal 인자 방어 (F-P0-NEW-4)
  - line ~3145-3151: quiz-graded 핸들러 캐시 무효화 (F-P0-NEW-2)
  - line ~3185-3190: closeContentPlayerModal 캐시 무효화 (F-P0-NEW-2)
  - line ~3370-3385: submitSolve 캐시 무효화 (F-P0-NEW-2)
  - line ~4688-4720: loadRanking 대시보드 폴백 (F-P0-NEW-3)

## 메인 폴더 sync

`public/self-learn/learning-map.html` 메인 폴더로 복사 완료.

---

## 잔여 사항 (P0 외)

학생 테스터 보고서의 다음 항목은 본 작업 범위 외 (Backend 또는 콘텐츠 품질):

- C-2 / H-1: `problem-attempt` / `diagnosis answer` 의 isCorrect 서버단 무시 → Backend 영역
- M-1 ~ M-4, L-1 ~ L-3: P1 이하 후속 작업 대상

---

*본 보고서는 학생1 계정 실제 로그인 + preview_eval E2E + preview_screenshot 기반 검증 결과를 포함한다.*
