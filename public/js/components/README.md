# 교육과정 표준체계 Web Components

2022 개정 교육과정 표준체계를 다루는 재사용 가능한 커스텀 엘리먼트 모음.

## 자동 로드

`common-nav.js`가 포함된 모든 페이지에서 자동으로 등록됨 — 별도 `<script>` 태그 불필요.

수동 로드가 필요한 경우:
```html
<script defer src="/js/components/std-smart-search.js"></script>
<script defer src="/js/components/std-picker.js"></script>
```

## `<std-smart-search>`

성취기준 스마트검색 — 키워드 입력 시 `/api/curriculum/standards?search=`로 자동완성.

### 사용 예

```html
<std-smart-search id="ss" data-placeholder="성취기준 검색"></std-smart-search>
<script>
  document.getElementById('ss').addEventListener('change', e => {
    console.log(e.detail);
    // { codes: ['[4국01-01]'], std_ids: ['E4KORA01B01C01'], items: [...] }
  });
</script>
```

### 속성

| 속성 | 기본값 | 설명 |
|------|--------|------|
| `data-placeholder` | `성취기준 검색 (학년, 교과, 영역, 코드 등)` | 입력 placeholder |
| `data-value` | — | 초기 선택 코드 (쉼표구분, 예: `[4국01-01],[4국01-02]`) |
| `data-multiple` | `true` | `false` 시 단일 선택 |
| `data-subject` | — | 특정 `subject_code`로 검색 범위 제한 |

### API

- `element.value` → `{ codes, std_ids, items }`
- `element.value = [...]` → 선택 강제 설정
- `element.clear()` → 선택 초기화
- 이벤트: `change` (bubbles + composed) with `detail = element.value`

---

## `<std-picker>`

표준체계 계층 드릴다운 — 학교급 → 교과 → 학년군 → 영역 순으로 선택 후 내용 노드/성취기준 목록 표시.

### 사용 예

```html
<std-picker id="sp" data-mode="node"></std-picker>
<script>
  document.getElementById('sp').addEventListener('change', e => {
    console.log(e.detail);
    // { std_ids: ['E4KORA01B01C01'], codes: [], items: [...] }
  });
</script>
```

### 속성

| 속성 | 기본값 | 설명 |
|------|--------|------|
| `data-value` | — | 초기 선택 (쉼표구분, std_id 또는 code 혼합) |
| `data-multiple` | `true` | `false` 시 단일 선택 |
| `data-mode` | `node` | `node` = 내용노드 선택 / `standard` = 성취기준 선택 |

### API

std-smart-search와 동일 (`value`, `clear()`, `change` 이벤트).

---

## 테스트 페이지

`/js/components/test.html` — 4가지 사용 시나리오 (기본/초기값/단일/내용노드/성취기준 모드).

## 설계 원칙

- **Shadow DOM 격리** — 호스트 페이지 스타일에 영향을 주지도 받지도 않음
- **변경 불가 API** — 모든 데이터 변경은 `change` 이벤트로만 외부에 알림
- **바닐라** — 프레임워크 의존 없음, 어디든 붙여 쓸 수 있음
- **API 재사용** — 기존 `/api/curriculum/*` 엔드포인트만 호출, 신규 백엔드 변경 없음

## `DacheumSearch` (검색 인터페이스 공통 컴포넌트)

> Phase 1 — 채움콘텐츠 공개콘텐츠 검색바를 동일 마크업/스타일로 추출. 
> `common-nav.js` 로딩 페이지에서 `window.DacheumSearch` 가 자동 등록된다.

### 사용 예 (회귀 0 전환: legacy ID 호환 모드 + 호스트 글로벌 함수 위임)

```html
<div id="searchHost"></div>
<script>
  const ctrl = DacheumSearch.mount(document.getElementById('searchHost'), {
    mode: 'content',
    sources: ['public'],
    typeFilters: ['video','document','image','quiz','exam','activity','package','recipe'],
    initialTypeFilters: Array.from(typeFilters),
    initialViewMode: viewMode,
    legacyIds: true,           // pubKeyword/pafTitle 등 기존 ID 유지
    enableStdSearch: true,
    enableViewToggle: true,
    showAdvanced: true,
    placeholder: '제목, 키워드, 저작자명으로 검색',
    hooks: {
      onSearch:         (page) => searchPublic(page),
      onKeywordInput:   () => updateSearchCheckboxes(),
      onAdvToggle:      () => togglePubAdvSearch(),
      onAdvReset:       () => resetPubAdvSearch(),
      onToggleType:     (t) => toggleTypeFilter(t),
      onMonthQuick:     (v) => applyPafMonthQuick(v),
      onYearQuick:      (v) => applyPafYearQuick(v),
      onViewModeChange: (m) => { viewMode = m; searchPublic(1); }
    }
  });
</script>
```

### 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `mode` | `content` | `content` / `question` / `exam` — placeholder·라벨 분기 |
| `sources` | `['public']` | 표시할 소스 탭 (단일이면 탭 미노출) |
| `typeFilters` | 8종 | 노출할 유형 칩 키 목록 |
| `typeNames` | 8종 한국어 | 칩 라벨 매핑 |
| `enableStdSearch` | `true` | 상세 검색 폼에 `<std-smart-search>` 노출 |
| `enableViewToggle` | `true` | 카드/리스트 토글 노출 |
| `showAdvanced` | `true` | 상세 검색 토글 노출 |
| `enableDateRange` | `true` | 등록 기간 입력 노출 |
| `legacyIds` | `true` | 기존 DOM ID(`pubKeyword`, `pafTitle` 등) 유지 (회귀 0) |

### 컨트롤러 반환값

- `refresh(page)` / `setQuery(q)` / `setSource(s)` / `getState()` / `getSelectedFilters()` / `destroy()`

### Phase 2~4 마이그레이션 매트릭스

기획서 `작업지시서/검색_인터페이스_공통_컴포넌트_기획서.md` §3 의 마이그레이션 표 참조.
Phase 2 = 수업 모듈, Phase 3 = 평가/문항, Phase 4 = 관리자/기타.

---

## 기존 인라인 구현과의 관계

다음 페이지는 자체 성취기준 UI를 이미 가지고 있음:

- `content/index.html` — `searchPubStandards()`
- `class/class-home.html` — `searchExamPubStandards()`, `searchExamDirectStandards()`
- `class/lesson-create.html` — `searchStandards()`
- `class/lesson-player.html` — `_clmSmart`
- `self-learn/problem-sets.html`

기존 구현은 이미 주변 UI 상태(태그, 콜백, 필터)와 긴밀히 결합되어 있으므로 이번 리팩터링에서는 그대로 두고, 앞으로 **신규 개발**에서는 본 컴포넌트를 우선 사용할 것.
