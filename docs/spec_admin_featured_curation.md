# 추천콘텐츠 큐레이션(관리자 직접 기획) 상세 기획서

| 메타 | 값 |
|------|------|
| 문서명 | spec_admin_featured_curation.md |
| 버전 | v1.0 |
| 작성자 | UI 디자이너 + 도메인 전문가 (서브에이전트) |
| 작성일 | 2026-05-06 |
| 대상 페이지(뷰어) | `public/content/index.html` 의 `renderRecommend()` (라인 2152~2269) |
| 대상 페이지(편집) | `public/admin/index.html` 좌측 사이드바 신규 메뉴 "추천콘텐츠 큐레이션" |
| 관련 라우트 | `routes/content.js`(기존), `routes/admin.js`(신규 큐레이션 API 추가) |
| 관련 DB | `contents`, `channels`(기존) + `featured_sections`, `featured_section_items`(신규) |
| 적용 표준 | CLAUDE.md UI 공통 스케일 / 사용자 5원칙 / 디자이너 8책임 / 모달 90vw×90vh / GNB 회피 z-index / 토스트 top-center 2.4s |

---

## 0. 요구 한 줄 요약
> 추천콘텐츠 페이지의 4개 섹션(기획섹션·추천콘텐츠·인기채널·새로 올라온 맞춤 자료) 각각의 **타이틀**과 **콘텐츠 배치**를 관리자가 직접 기획·편집할 수 있게 한다. 슬롯이 비어있으면 기존 알고리즘으로 자동 폴백한다.

---

## 1. 정보 구조 / 데이터 모델 (A)

### 1.1 신규 테이블 2종

#### (1) `featured_sections` — 섹션 메타
> 추천콘텐츠 페이지에 어떤 섹션이 어떤 순서·어떤 타이틀로 노출되는지 관리.

```sql
CREATE TABLE IF NOT EXISTS featured_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT    NOT NULL UNIQUE,         -- planning | recommend | channels | new (시드 4개 고정)
  title        TEXT    NOT NULL,                -- 예: "2026학년도 1학기 추천 자료"
  subtitle     TEXT,                            -- 예: "교과 연구회 추천 콘텐츠"
  layout       TEXT    NOT NULL DEFAULT 'card-grid',  -- card-grid | channel-row | list
  item_type    TEXT    NOT NULL DEFAULT 'content',    -- content | channel
  sort_order   INTEGER NOT NULL DEFAULT 0,      -- 페이지 내 섹션 노출 순서 (오름차순)
  is_active    INTEGER NOT NULL DEFAULT 1,      -- 0이면 페이지에서 숨김
  fallback_on  INTEGER NOT NULL DEFAULT 1,      -- 슬롯 비었을 때 자동 폴백 사용 여부
  max_items    INTEGER NOT NULL DEFAULT 8,      -- 노출 최대 개수
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by   INTEGER,                         -- users.id (admin)
  CHECK(key IN ('planning','recommend','channels','new')),
  CHECK(layout IN ('card-grid','channel-row','list')),
  CHECK(item_type IN ('content','channel'))
);

CREATE INDEX IF NOT EXISTS idx_featured_sections_active_sort
  ON featured_sections(is_active, sort_order);
```

**시드 데이터(설치 시 1회 INSERT OR IGNORE)**

| key | title (기본) | subtitle | layout | item_type | sort_order |
|-----|-------------|---------|--------|-----------|------------|
| `planning` | 2026학년도 1학기 추천 자료 | 교과 연구회가 직접 고른 콘텐츠 | card-grid | content | 10 |
| `recommend` | 맞춤 추천 콘텐츠 | 역할·키워드 기반 큐레이션 | card-grid | content | 20 |
| `channels` | 인기 채널 | 구독자가 많은 우수 채널 | channel-row | channel | 30 |
| `new` | 새로 올라온 맞춤 자료 | 최근 등록된 신규 자료 | card-grid | content | 40 |

> **`title` 고정 X**: 관리자가 학기 변경 시 자유 변경 가능. `key` 만 시스템 식별자로 고정.

#### (2) `featured_section_items` — 섹션 슬롯
> 각 섹션에 어떤 콘텐츠/채널이 어떤 순서로 들어가는지 관리.

```sql
CREATE TABLE IF NOT EXISTS featured_section_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id   INTEGER NOT NULL,
  item_type    TEXT    NOT NULL,                -- content | channel (section.item_type와 일치 권장)
  item_id      INTEGER NOT NULL,                -- contents.id 또는 channels.id
  sort_order   INTEGER NOT NULL DEFAULT 0,      -- 섹션 내 표시 순서 (오름차순)
  badge_label  TEXT,                            -- 선택: "NEW", "추천", "이번 주" 등 카드에 덧입힐 배지
  note         TEXT,                            -- 관리자 메모 (운영 코멘트, 학생/교사 비노출)
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by   INTEGER,                         -- users.id (admin)
  FOREIGN KEY (section_id) REFERENCES featured_sections(id) ON DELETE CASCADE,
  CHECK(item_type IN ('content','channel'))
);

-- 한 섹션에 동일 (item_type, item_id) 중복 방지
CREATE UNIQUE INDEX IF NOT EXISTS uq_featured_items_section_item
  ON featured_section_items(section_id, item_type, item_id);

-- 정렬 조회 최적화
CREATE INDEX IF NOT EXISTS idx_featured_items_section_sort
  ON featured_section_items(section_id, sort_order);
```

> **외래키는 ON DELETE CASCADE** (section 삭제 시 슬롯 동반 삭제)
> **item_id에 대한 FK는 두지 않음** (item_type이 content/channel 두 테이블을 가리키는 다형성 관계). 무결성은 서버 layer에서 검증 + 런타임 join 시 누락 자동 필터.

### 1.2 표시 규칙 (서버 측 로직)

| 상황 | 처리 |
|------|------|
| 섹션 `is_active = 0` | 페이지 응답 배열에서 **제외** |
| 섹션 슬롯 0건 + `fallback_on = 1` | 기존 알고리즘으로 자동 채움 (planning/recommend/new → `getRecommendations`, channels → `getPopularChannels`) |
| 섹션 슬롯 0건 + `fallback_on = 0` | 빈 배열 그대로 반환 (뷰어가 빈 상태 안내 카드 노출) |
| 슬롯이 가리키는 콘텐츠가 비공개/삭제/미승인 | 응답에서 **자동 필터**(서버 측 `WHERE c.status='approved' AND c.is_public=1`). slots 테이블은 그대로 두고 응답에서만 빠짐 |
| 채널 슬롯이 가리키는 채널 `status != 'active'` | 위와 동일하게 응답에서 자동 필터 |
| 슬롯 + 폴백 mix | 슬롯이 우선, 부족분만 폴백으로 채움 (max_items까지). 단 `recommend`는 슬롯이 1개 이상 있으면 폴백 X(기획 의도 보존). 그 외 섹션은 부족분 채우기 허용 |

> **두 가지 폴백 전략**을 한 컬럼(`fallback_on`)으로 단순화하기 위해, "슬롯 1건 이상이면 폴백 비활성"의 보수적 동작을 **planning / recommend** 두 섹션에 적용한다(관리자 의도가 있으면 자동 끼어들지 않음). `channels / new` 섹션은 max_items까지 폴백으로 보충.

---

## 2. 관리자 화면 (B) — `/admin/index.html` 신규 메뉴 "추천콘텐츠 큐레이션"

### 2.1 사이드바 진입점

```diff
  <ul class="admin-nav">
    <li class="active" data-section="dashboard"><i class="fas fa-chart-pie"></i> 대시보드</li>
    <li data-section="users"><i class="fas fa-users"></i> 사용자 관리</li>
    <li data-section="contents"><i class="fas fa-file-alt"></i> 콘텐츠 관리</li>
+   <li data-section="featured"><i class="fas fa-star"></i> 추천콘텐츠 큐레이션</li>
    <li data-section="lessons"><i class="fas fa-chalkboard-teacher"></i> 수업 관리</li>
    ...
  </ul>
```

- 위치: **콘텐츠 관리 바로 다음 줄** (콘텐츠 운영 흐름 인접)
- 아이콘: `fa-star` (`#f59e0b`)
- 라벨: 16px / padding 12px 16px (기존 사이드바 항목과 동일)
- 권한: `admin` 만 (다른 역할 진입 시 `/admin/login`으로 redirect — 기존 패턴 동일)

### 2.2 메인 화면 와이어프레임 (1440 기준)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  page-title  ★  추천콘텐츠 큐레이션         [미리보기 새 탭 ↗] [변경 이력]   │
│  설명: 학생·교사·비로그인 포털에서 보이는 4개 섹션을 직접 편집합니다.        │
├──────────────────┬───────────────────────────────────────────────────────────┤
│ 좌측 패널 360px  │ 우측 패널 (가변)                                          │
│ "섹션 4개"       │ "선택된 섹션 슬롯 편집"                                   │
│                  │                                                            │
│ ┌──────────────┐ │  ┌───────────────────────────────────────────────────┐  │
│ │ ⋮⋮  기획섹션 │ │  │ 섹션 헤더(타이틀 inline 편집)                      │  │
│ │ 2026 1학기…  │ │  │  타이틀: [2026학년도 1학기 추천 자료      ]✎      │  │
│ │ 카드 4 / 8   │ │  │  부제 :  [교과 연구회가 직접 고른 콘텐츠 ]✎       │  │
│ │ ON ▢───●     │ │  │  레이아웃: [card-grid ▼]   max: [ 8 ▼]            │  │
│ │              │ │  │  자동 폴백: ☑ 슬롯이 부족하면 자동 추천으로 채움  │  │
│ │ ⋮⋮  추천콘…  │ │  └───────────────────────────────────────────────────┘  │
│ │ ON ▢───●     │ │                                                            │
│ │              │ │  ┌──── 슬롯 (드래그로 순서 변경) ─────────────────┐    │
│ │ ⋮⋮  인기채…  │ │  │ #1 [썸네일] 봄꽃 관찰 활동지     ⋮⋮  ✕         │    │
│ │ OFF ●───▢    │ │  │     국어/3학년 · 김선생  · 조회 1,204            │    │
│ │              │ │  ├──────────────────────────────────────────────────┤    │
│ │ ⋮⋮  새로…    │ │  │ #2 [썸네일] 분수의 덧셈 영상   ⋮⋮  ✕             │    │
│ │ ON ▢───●     │ │  │     수학/4학년 · 박선생  · 조회 887              │    │
│ └──────────────┘ │  └──────────────────────────────────────────────────┘    │
│                  │                                                            │
│  + 새 섹션은      │  [ + 콘텐츠 추가 ]    (현재 2/8 · 폴백 6개 자동)         │
│   허용 X (4개     │                                                            │
│   고정)           │  ── 빈 상태 안내 ────────────────────────────────────    │
│                   │  슬롯이 비어있어요. 자동 폴백이 켜져 있어 시스템         │
│                   │  추천이 표시되며, 직접 골라 붙이려면 위 버튼을 누르세요.│
└──────────────────┴───────────────────────────────────────────────────────────┘
```

### 2.3 좌측 — 섹션 리스트(360px 고정)

| 요소 | 스펙 |
|------|------|
| 카드 컨테이너 | 흰 배경, border 1px `#e5e7eb`, radius 12px, padding 16px 18px, 카드 간격 12px |
| 드래그 핸들 `⋮⋮` | 좌측 끝, 14px 회색, hover 시 `#1d4ed8` |
| 섹션 타이틀 | 18~19px / 700 / `#1A1A2E` (편집 X — 우측에서만 inline 편집) |
| 부제(2줄 클램프) | 14~15px / 500 / `#6B7280` |
| 메타 | 13px / `#9ca3af` — `카드 {슬롯개수} / max:{n}` `자동폴백 ON/OFF` 칩 |
| ON/OFF 토글 스위치 | 36×20px, ON `#16a34a` / OFF `#cbd5e1`, 클릭 즉시 PATCH |
| 선택 상태 | 카드 좌측 4px `#2563eb` 보더 + 배경 `#eff6ff` |
| hover | shadow `0 2px 8px rgba(0,0,0,.08)`, transition 120ms |

> **핵심 인터랙션**: 카드 클릭 → 우측 패널 갱신. 드래그 → `sort_order` 즉시 PATCH (SortableJS CDN 사용).

### 2.4 우측 — 슬롯 편집 패널

#### 2.4.1 섹션 헤더 (편집 영역)

| 요소 | 스펙 |
|------|------|
| 컨테이너 | 흰 배경, radius 14px, padding 24px 28px, margin-bottom 16px, border 1px `#e5e7eb` |
| 타이틀 input | 19~20px / 700, padding 10px 14px, border 1.5px `#d1d5db`, focus border `#2563eb` |
| 부제 input | 16px / 500, padding 10px 14px |
| 레이아웃 select | 16px, padding 8px 12px (`card-grid`/`channel-row`/`list`) |
| max_items select | 16px (4·6·8·12 옵션) |
| 자동 폴백 체크박스 | 18×18px, accent `#2563eb`, 라벨 15px |
| 저장 방식 | input blur · select change 이벤트 → 자동 PATCH (디바운스 400ms) |
| 저장 피드백 | 우상단 small 토스트 "저장됨 ✓" (top-center, 1.6s) |

> **편집 잠금**: `key`(planning/recommend/channels/new), `item_type`은 시스템 고정 — UI에서 표시만, 변경 X.

#### 2.4.2 슬롯 리스트

```
┌─ 슬롯 카드(높이 92px) ─────────────────────────────────────────┐
│ ⋮⋮ │ [썸네일 100×72] │ 제목(16px·700·2줄 클램프)        │ ✕  │
│    │                  │ 메타(14px·500): 교과/학년·작성자  │     │
│    │                  │ 메타2(13px·400): 조회 1,204·❤ 87  │     │
└────────────────────────────────────────────────────────────────┘
```

| 요소 | 스펙 |
|------|------|
| 컨테이너 | radius 12px, border 1px `#e5e7eb`, padding 12px 16px, gap 14px(요소 간) |
| 슬롯 간격 | 10px (vertical) |
| 드래그 핸들 `⋮⋮` | 18px / `#9ca3af`, hover `#2563eb`, cursor: grab |
| 썸네일 | 100×72, radius 8px, object-fit cover, fallback 회색 placeholder + 아이콘 |
| 제목 | 16px / 700 / `#1A1A2E`, line-clamp 2 |
| 메타 / 메타2 | 14px / 13px, `#6B7280` / `#9ca3af` |
| 제거 버튼 ✕ | 32×32px, hover 배경 `#fee2e2`, 색 `#dc2626`, confirm: "이 슬롯을 제거하시겠습니까?" |
| 채널 슬롯 | 썸네일 자리에 채널 이니셜 아바타 64×64 원형 (배경 `#dbeafe`, 글자 24px / 700) |
| 배지(badge_label) | 우상단 22px high, 13px / 700, 7가지 색 팔레트 중 선택 (NEW=red, 추천=amber, 이번주=blue …) |

#### 2.4.3 액션 영역

| 요소 | 스펙 |
|------|------|
| `+ 콘텐츠 추가` 버튼 | 풀폭, dashed border 2px `#cbd5e1`, padding 14px, font 16px / 600, hover border `#2563eb` + 배경 `#eff6ff` |
| 현재 카운트 | 우측 정렬 13px `#6B7280` — `현재 2 / 8 · 폴백 6개 자동` |

#### 2.4.4 빈 상태 / 폴백 미사용 빈 상태

```
┌─────────────────────────────────────────┐
│            [아이콘] (48px)              │
│  슬롯이 비어 있어요                     │
│  자동 폴백이 켜져 있어 시스템 추천 8개 │
│  가 자동으로 노출됩니다.                │
│                                         │
│  [ + 직접 골라 추가 ]                   │
└─────────────────────────────────────────┘
```

- 폴백 OFF + 슬롯 0건 → 색을 `#fef2f2` 톤으로 바꿔 경고 분위기 + "이 섹션은 페이지에 빈 상태로 노출됩니다" 강조.

#### 2.4.5 추가 모달 (콘텐츠 검색 / 채널 검색)

> **크기**: `width: 90vw; height: 90vh` (CLAUDE.md 표준 플레이어 모달 규격 준수)
> **z-index**: 10001 (관리자 화면 GNB 9999 위에 안전하게)

```
┌─ 콘텐츠 추가  (섹션: 추천콘텐츠 · 현재 2/8) ────────────  ✕ ┐
│ 검색바: [🔍 제목·키워드·작성자  검색       ] 검색           │
│ 필터: [교과 ▼] [학년 ▼] [유형 ▼] [정렬: 최신 ▼]  최근 추가:│
│         · [봄꽃 관찰] · [분수 영상]                          │
├──────────────────────────────────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                 │
│ │썸네│ │썸네│ │썸네│ │썸네│   4열 그리드                    │
│ │ +  │ │ ✓  │ │ +  │ │ +  │   카드 클릭 → 즉시 슬롯 끝에   │
│ │추가│ │들어│ │추가│ │추가│   추가, 모달은 유지(여러 개   │
│ └────┘ └감──┘ └────┘ └────┘   일괄 추가)                    │
│                                                                │
│ [< 이전] [1] [2] [3] [4] ... [다음 >]                         │
├──────────────────────────────────────────────────────────────┤
│ 현재 섹션 미니뷰: #1 #2 #3(NEW)  + ←(방금 추가)              │
│ [완료(닫기)]                                                  │
└──────────────────────────────────────────────────────────────┘
```

| 요소 | 스펙 |
|------|------|
| 모달 컨테이너 | 90vw × 90vh, radius 16px, padding 0(헤더/본문/푸터 별도) |
| 헤더 | height 60px, padding 16px 24px, border-bottom 1px `#e5e7eb` |
| 검색 input | 16px, padding 12px 14px, prefix 🔍 아이콘 |
| 필터 select | 14~15px, padding 8px 12px |
| 결과 그리드 | 4열, gap 16px, 카드 width 100%, height 220px |
| 결과 카드 썸네일 | aspect 16/10, radius 10px |
| 결과 카드 제목 | 16px / 700, 2줄 클램프 |
| 결과 카드 메타 | 14px, `#6B7280` |
| 카드 hover | border 2px `#2563eb`, transform translateY(-2px) |
| 이미 추가된 카드 | 우상단 ✓ 체크칩 (배경 `#16a34a`, 글자 #fff), 클릭 시 토스트 "이미 추가된 콘텐츠입니다" |
| 페이지네이션 | 14px, 현재 페이지 `#2563eb` 배경 |
| 미니뷰(푸터) | 추가된 슬롯의 작은 썸네일 4×4=16개 미리보기, 마지막 추가는 강조 보더 |
| 닫기 버튼 ✕ | 우상단 40×40px, 주변 40px 무배지 영역(배지 겹침 금지) |
| 채널 모달 | 동일 골격에 카드만 채널 카드(아바타+이름+구독자수+콘텐츠수) |

### 2.5 인터랙션 요약

| 트리거 | 동작 | API |
|--------|------|-----|
| 좌측 카드 드래그 종료 | 섹션 sort_order 일괄 갱신 | `PATCH /api/admin/featured/sections/reorder` |
| 좌측 ON/OFF 토글 | is_active PATCH | `PATCH /api/admin/featured/sections/:id` |
| 우측 타이틀/부제 blur | 즉시 PATCH (디바운스 400ms) | `PATCH /api/admin/featured/sections/:id` |
| 우측 layout/max/폴백 변경 | 즉시 PATCH | 〃 |
| 슬롯 ✕ 클릭 → confirm OK | 슬롯 삭제 | `DELETE /api/admin/featured/items/:itemId` |
| 슬롯 드래그 종료 | 섹션 슬롯 sort_order 일괄 갱신 | `PATCH /api/admin/featured/items/reorder` |
| `+ 콘텐츠/채널 추가` | 모달 open | `GET /api/admin/featured/search` |
| 모달 카드 클릭 | 슬롯 끝에 추가 + 토스트 | `POST /api/admin/featured/sections/:id/items` |
| 모달 닫기 | 모달 close, 좌측 슬롯 카드 자동 갱신 | (클라 상태 sync) |

### 2.6 토스트 / 피드백
- 위치: **top-center** (CLAUDE.md 규칙)
- 수명: **2.4초** (저장 알림은 1.6초)
- 색: 성공 `#16a34a`, 실패 `#dc2626`, 정보 `#2563eb`
- 폰트: 15px / 600
- z-index: 10010 (모달 위)

### 2.7 권한 / 진입 가드
- `requireAuth + requireRole('admin')` 미들웨어 (모든 관리자 API)
- 화면 진입 시 `GET /api/auth/me` 응답 `role !== 'admin'` 이면 `/admin/login` redirect
- 사이드바 메뉴는 admin 외 역할에게 숨김(기존 패턴 동일)

---

## 3. 추천콘텐츠 뷰어 페이지 변경 (C) — `public/content/index.html`

### 3.1 기존 → 신규 구조

| 항목 | AS-IS (현행) | TO-BE (신규) |
|------|-------------|--------------|
| API 호출 | 2개 fetch (`/recommendations`, `/channels/list`) 동시 | **단일** `GET /api/contents/featured` |
| 섹션 타이틀 | 하드코딩 (`${y}학년도 ${semester} 추천 자료` 등) | **API 응답의 `title/subtitle`** 사용 |
| 섹션 4개 렌더 분기 | 인라인 HTML 4번 | **layout별 함수 3개**로 분기 |
| 비로그인 노출 | 일부 섹션은 데이터 빔 | 동일 레이아웃 보장(서버에서 폴백 채워서 옴) |

### 3.2 새 렌더 흐름

```js
async function renderRecommend(c) {
  const res = await fetch('/api/contents/featured').then(r => r.json());
  const sections = res.sections || [];

  // 검색바는 기존 그대로 위에 유지

  c.innerHTML = `
    ${renderSearchBar() /* 기존 검색 영역 */}
    ${sections.map(renderFeaturedSection).join('')}
  `;
  injectCardStats(c);
  bindStdSmartSearch();
}

function renderFeaturedSection(s) {
  const body = (() => {
    if (!s.items || s.items.length === 0) return renderEmptySection(s);
    switch (s.layout) {
      case 'card-grid':   return renderCardGrid(s.items);
      case 'channel-row': return renderChannelRow(s.items);
      case 'list':        return renderListSection(s.items);
      default:            return renderCardGrid(s.items);
    }
  })();
  return `
    <div style="margin-bottom:32px">
      <div class="mb-12">
        ${s.key === 'planning' ? '<span class="section-badge">기획</span>' : ''}
        <span class="section-title">${escHtml(s.title)}</span>
      </div>
      ${s.subtitle ? `<div class="text-xs text-gray mb-12">${escHtml(s.subtitle)}</div>` : ''}
      ${body}
    </div>
  `;
}
```

### 3.3 layout별 렌더 함수

| 함수 | 사용 섹션 | 출력 |
|------|----------|------|
| `renderCardGrid(items)` | planning / recommend / new | `<div class="grid-4">` 안에 `renderContentCard()` 4~8개 |
| `renderChannelRow(items)` | channels | `<div class="grid-4">` 안에 `.channel-card` (기존 채널 카드 마크업 재사용) |
| `renderListSection(items)` | (예비) | `<div class="flex-col">` 안에 `renderListRow()` |
| `renderEmptySection(s)` | 빈 섹션 (폴백 OFF + 슬롯 0) | "콘텐츠가 준비 중입니다" 안내 (`empty-state` 컴포넌트 재사용) |

### 3.4 비로그인 정책
- `/api/contents/featured`는 `optionalAuth` 사용 (CLAUDE.md "포털 무조건 보임" 정책 준수).
- 비로그인도 동일 레이아웃 / 동일 섹션 노출. 슬롯 콘텐츠는 `is_public=1 AND status='approved'` 만.

### 3.5 미리보기 동선
- 관리자 화면 우상단 "미리보기 새 탭 ↗" 버튼 클릭 → `/content/index.html?view=recommend&preview=admin` 새 탭 오픈.
- 페이지에서 `?preview=admin` 인 경우 우상단에 작은 "관리자 미리보기 모드" 칩 표시(편집은 X).

---

## 4. API 명세 (D)

### 4.1 뷰어용

#### `GET /api/contents/featured`
- 인증: `optionalAuth`
- 동작: 활성(is_active=1) 섹션을 `sort_order` 오름차순으로 모두 반환. 각 섹션의 슬롯을 검증·필터·폴백 적용 후 `items[]`에 채워서 반환.
- 응답:
```json
{
  "success": true,
  "sections": [
    {
      "key": "planning",
      "title": "2026학년도 1학기 추천 자료",
      "subtitle": "교과 연구회가 직접 고른 콘텐츠",
      "layout": "card-grid",
      "item_type": "content",
      "max_items": 4,
      "is_fallback": false,
      "items": [
        {
          "type": "content",
          "id": 124,
          "title": "봄꽃 관찰 활동지",
          "thumbnail_url": "/uploads/.../thumb.jpg",
          "content_type": "document",
          "subject": "국어",
          "grade": 3,
          "view_count": 1204,
          "like_count": 87,
          "creator_name": "김선생",
          "badge_label": "NEW"
        }
      ]
    },
    {
      "key": "channels",
      "title": "인기 채널",
      "subtitle": "구독자가 많은 우수 채널",
      "layout": "channel-row",
      "item_type": "channel",
      "max_items": 8,
      "is_fallback": true,
      "items": [
        { "type":"channel","id":12,"name":"수학교실","owner_name":"박선생","subscriber_count":340,"content_count":21 }
      ]
    }
  ]
}
```

> `is_fallback`: 해당 섹션의 items가 폴백 알고리즘으로 채워진 경우 true (감리·디버깅용 메타).

### 4.2 관리자용 (모두 `requireAuth + requireRole('admin')`)

#### `GET /api/admin/featured/sections`
- 응답:
```json
{
  "success": true,
  "sections": [
    {
      "id": 1, "key":"planning", "title":"...", "subtitle":"...",
      "layout":"card-grid", "item_type":"content",
      "sort_order":10, "is_active":1, "fallback_on":1, "max_items":8,
      "item_count": 3,
      "updated_at":"2026-05-06 13:22:11", "updated_by":1
    }
  ]
}
```

#### `PATCH /api/admin/featured/sections/:id`
- body(부분 업데이트 허용):
```json
{ "title":"...", "subtitle":"...", "layout":"card-grid", "max_items":6, "fallback_on":0, "is_active":1, "sort_order":20 }
```
- 동작: 화이트리스트 컬럼만 갱신, `updated_by = req.user.id`, `updated_at = CURRENT_TIMESTAMP`.
- 응답: `{ success:true, section:{...} }`

#### `PATCH /api/admin/featured/sections/reorder`
- body: `{ "order": [ {"id":3,"sort_order":10}, {"id":1,"sort_order":20}, ... ] }`
- 동작: 트랜잭션으로 일괄 갱신.
- 응답: `{ success:true }`

#### `GET /api/admin/featured/sections/:id/items`
- 응답:
```json
{
  "success":true,
  "section": { "id":1, "key":"planning", "title":"...", "max_items":8 },
  "items": [
    { "id":55, "item_type":"content", "item_id":124, "sort_order":10,
      "badge_label":"NEW", "note":"교과 연구회 추천",
      "snapshot": {
        "title":"봄꽃 관찰 활동지","thumbnail_url":"/uploads/...","subject":"국어","grade":3,
        "creator_name":"김선생","view_count":1204,"like_count":87,
        "is_visible":true /* 비공개/삭제 시 false → UI에서 회색 처리 */
      } }
  ]
}
```

#### `POST /api/admin/featured/sections/:id/items`
- body: `{ "item_type":"content", "item_id":124, "badge_label":"NEW", "note":"" }`
- 검증: section.item_type 과 일치 / 대상 콘텐츠/채널 존재·노출가능 / 중복 방지(unique 인덱스 의존).
- 동작: `sort_order = MAX(sort_order)+10` (끝에 추가), `created_by = req.user.id`.
- 응답: `{ success:true, item:{...} }` / 중복 시 `{ success:false, code:"DUPLICATE", message:"이미 이 섹션에 추가된 항목입니다." }`(409)

#### `DELETE /api/admin/featured/items/:itemId`
- 응답: `{ success:true }` / 404 가능

#### `PATCH /api/admin/featured/items/reorder`
- body: `{ "section_id":1, "order":[ {"id":55,"sort_order":10}, {"id":56,"sort_order":20} ] }`
- 동작: 같은 section 내에서만 갱신(서버 검증).

#### `GET /api/admin/featured/search`
- query: `type=content|channel`, `q`(키워드), `subject`, `grade`, `content_type`, `page`(기본 1), `pageSize`(기본 12)
- content 검색 조건: `status='approved' AND is_public=1` 만 반환.
- channel 검색 조건: `status='active'`.
- 응답:
```json
{
  "success":true, "total":78, "page":1, "pageSize":12, "totalPages":7,
  "items":[
    { "type":"content","id":124,"title":"...","thumbnail_url":"...","subject":"국어","grade":3,
      "creator_name":"김선생","view_count":1204,"like_count":87,
      "already_in_section": true /* 현재 편집 중 섹션에 이미 있으면 true */ }
  ]
}
```

> 'already_in_section' 판단을 위해 query에 `section_id`를 추가로 받아 LEFT JOIN으로 확인.

### 4.3 에러 코드 (공통)

| HTTP | code | 메시지 |
|------|------|--------|
| 400 | INVALID_PAYLOAD | 요청 본문이 올바르지 않습니다. |
| 403 | FORBIDDEN | 관리자 권한이 필요합니다. |
| 404 | NOT_FOUND | 대상이 존재하지 않습니다. |
| 409 | DUPLICATE | 이미 이 섹션에 추가된 항목입니다. |
| 409 | STALE_UPDATE | 다른 관리자가 먼저 수정했습니다. 새로고침 후 다시 시도해주세요. |
| 500 | SERVER_ERROR | 서버 오류가 발생했습니다. |

---

## 5. 인터랙션 시나리오 E2E (E)

### 5.1 [관리자] 학기 시작 큐레이션

| # | 행위 | 기대 동작 |
|---|------|----------|
| 1 | `/admin` 로그인 → 좌측 "추천콘텐츠 큐레이션" 클릭 | 4개 섹션 카드 좌측 패널 노출 |
| 2 | "기획섹션" 카드 클릭 | 우측 패널이 해당 섹션의 슬롯·헤더로 갱신 |
| 3 | 타이틀 "2025… → 2026학년도 1학기 추천 자료" 수정 후 blur | "저장됨 ✓" 토스트, 좌측 카드 타이틀 자동 동기화 |
| 4 | `+ 콘텐츠 추가` 클릭 → 검색 "봄꽃" → 카드 4개 클릭 | 모달 유지, 4개 슬롯 즉시 추가, 푸터 미니뷰에 4개 표시 |
| 5 | 모달 "완료(닫기)" → 슬롯 드래그로 #1↔#3 순서 변경 | 즉시 PATCH, 새로고침 후에도 순서 유지 |
| 6 | 좌측 "인기채널" OFF 토글 | `is_active=0` 즉시 반영, 좌측 카드 회색 처리 |
| 7 | 우상단 "미리보기 새 탭 ↗" 클릭 | `/content/index.html?view=recommend` 새 탭, 인기채널 섹션 안 보임, 기획섹션 4개 카드 노출 |
| 8 | 새 탭에서 인기채널 섹션 X / 기획섹션 4개 표시 / 다른 섹션은 폴백으로 자동 채움 확인 | 시나리오 종료 |

### 5.2 [학생/비로그인] 추천콘텐츠 페이지 열람

| # | 행위 | 기대 동작 |
|---|------|----------|
| 1 | 비로그인 상태로 `/content/index.html?view=recommend` 진입 | 4개 섹션 자동 노출 (관리자 OFF 섹션 제외) |
| 2 | 기획섹션 카드 4개가 관리자가 고른 그대로 표시 | 타이틀/부제도 관리자 입력값 |
| 3 | 인기채널 섹션은 보이지 않음 | (5.1 #6에서 OFF 처리됨) |
| 4 | 새로 올라온 맞춤 자료 섹션은 폴백 자동 채움 8개 노출 | `is_fallback:true` 응답 (UI엔 표시 안함) |
| 5 | 새로고침 → 결과 일관 유지 | 캐시·DB 정합성 확인 |

### 5.3 [교사] 권한 확인

| # | 행위 | 기대 동작 |
|---|------|----------|
| 1 | teacher1 로그인 → `/admin/index.html` 직접 URL 접근 | 기존 admin 가드에 의해 `/admin/login` redirect (변경 없음) |
| 2 | teacher1 세션으로 `PATCH /api/admin/featured/sections/1` 직접 호출 | 403 FORBIDDEN |
| 3 | 학생 화면(`/content/index.html`)에서 추천콘텐츠 섹션은 정상 열람 | 관리자 영역 노출 X, 페이지 정상 |

---

## 6. 엣지 케이스 (F)

### 6.1 슬롯 콘텐츠 비공개/삭제
- **응답 시점 자동 필터**: `featured_section_items` JOIN 시 `c.status='approved' AND c.is_public=1`. 누락된 슬롯은 응답에서 빠지지만 DB 행은 유지(관리자 화면에서 회색 처리 + "비공개로 전환됨" 배지).
- **관리자 화면 표시**: `snapshot.is_visible=false` 슬롯은 카드 opacity 0.6 + 우측 상단 `숨김` 배지(빨강) + 호버 시 "이 콘텐츠는 비공개되어 페이지에 노출되지 않습니다" 툴팁.
- **부족분 폴백**: `channels`/`new` 섹션은 비공개 슬롯이 빠진 자리만큼 폴백으로 보충.

### 6.2 동시 편집 충돌
- `featured_sections`에 `updated_at` 컬럼 존재 → PATCH 요청 시 클라이언트가 `If-Match: <updated_at>` 같은 옵션 헤더 또는 body에 `expected_updated_at`을 함께 보냄.
- 서버는 현재 행의 `updated_at`과 비교, 다르면 409 `STALE_UPDATE` 반환.
- 클라이언트는 토스트 "다른 관리자가 먼저 수정했습니다. 최신 값을 불러옵니다." → GET 재호출 후 화면 자동 갱신.
- **단순화 정책**: 슬롯 reorder/추가/삭제는 충돌 검사 생략(낙관적), 섹션 메타(타이틀/부제/layout/max/fallback/active) 만 검사.

### 6.3 캐시 정책
- 뷰어 응답(`/api/contents/featured`)은 **in-memory 5분 TTL** 캐시.
- 무효화 트리거(아래 중 하나라도 발생 시 캐시 즉시 클리어):
  - 모든 admin PATCH/POST/DELETE 큐레이션 API
  - 관련 콘텐츠/채널의 status·is_public 변경 (admin 콘텐츠 관리에서 발생 시 hook으로 클리어)
- 캐시 키: `featured:v1` 단일 키 (역할별 분기 X — 응답이 동일하므로).
- 서버 부팅 직후 첫 요청은 cold path → 정상 빌드.

### 6.4 시드 누락 / 마이그레이션
- 서버 부팅 시 `featured_sections` 시드 4행을 `INSERT OR IGNORE`로 보장.
- 누군가 실수로 시드 행을 DELETE 한 경우, 다음 부팅 시 자동 복구(타이틀은 기본값으로).

### 6.5 max_items vs 슬롯 수
- 관리자가 `max_items=4`인 섹션에 슬롯 8개를 채워 둔 경우, 응답은 앞에서 4개만 잘라 반환 + 관리자 화면에 "max(4) 초과 — 5번째부터 페이지에 노출되지 않습니다" 안내 노출.

### 6.6 채널 슬롯이 channels 섹션이 아닌 곳에 들어간 경우
- 서버 검증에서 차단 (POST 시 section.item_type !== 'channel' 이면 400). UI에서 `+ 채널 추가` 버튼은 channels 섹션에서만 노출.

---

## 7. 검증 체크리스트 (G) — 감리/테스터용

### 7.1 디자인
- [ ] 좌측 섹션 카드 / 우측 슬롯 카드 모두 radius·padding·border·hover가 admin 다른 섹션과 일관
- [ ] 모든 텍스트 공통 UI 스케일 준수 (body 16~17 / h1 28~30 / 카드 h3 19~20 / button 16 / badge 13)
- [ ] 12px 이하 본문, 14px 이하 버튼 **없음**
- [ ] 추가 모달 90vw × 90vh, 닫기 버튼 우상단 40px 무배지 영역 확보
- [ ] 추가 모달 z-index 10001 이상 (관리자 GNB 9999 위에 정상)
- [ ] 토스트 top-center, 2.4초, 색 위계 일관

### 7.2 권한
- [ ] teacher1/student1 세션으로 `/api/admin/featured/*` 직접 호출 시 403
- [ ] teacher1로 `/admin` 진입 → 사이드바에 "추천콘텐츠 큐레이션" 메뉴 안 보임 또는 redirect

### 7.3 폴백 / 자동 알고리즘
- [ ] 슬롯 0건 + 폴백 ON → 응답에 `getRecommendations`/`getPopularChannels` 결과 채워짐
- [ ] 슬롯 0건 + 폴백 OFF → 응답 items 빈 배열 → 뷰어에 "준비 중" 빈 상태
- [ ] planning/recommend는 슬롯 1건 이상이면 폴백 X (기획 의도 보존)
- [ ] channels/new는 슬롯 일부 + 폴백 부족분 보충

### 7.4 기능
- [ ] 좌측 카드 드래그로 섹션 순서 변경 → 새로고침 후 유지
- [ ] 우측 슬롯 드래그로 순서 변경 → 새로고침 후 유지 → 학생 페이지에도 동일 순서
- [ ] 타이틀 inline 편집 blur → PATCH → 학생 페이지에 즉시(최대 5분 캐시) 반영
- [ ] ON/OFF 토글 → 학생 페이지에서 해당 섹션 사라짐
- [ ] 추가 모달에서 4개 클릭 → 슬롯에 4개 일괄 추가, 모달 유지
- [ ] 이미 추가된 콘텐츠 카드는 모달에서 ✓ 칩, 재클릭 시 토스트
- [ ] 비공개 콘텐츠 슬롯 → 학생 페이지에 노출 X, 관리자 패널에서 "숨김" 배지

### 7.5 모바일 반응형 (<768px)
- [ ] 좌·우 패널이 세로 스택으로 변환 (좌측 4개 카드 → 가로 스크롤 칩 리스트로 축약 옵션)
- [ ] 추가 모달 width 100vw / height 100vh / radius 0
- [ ] 슬롯 카드 썸네일 80×60, 제목 1줄 클램프
- [ ] 드래그 핸들이 터치 친화적 크기(44×44 hit area)

### 7.6 사용자 5원칙(UI 디자이너 자가 검증)
- [ ] (a) 진입 경로: 사이드바 "추천콘텐츠 큐레이션" 한 번 클릭으로 도착
- [ ] (b) 현재 위치 피드백: 선택된 섹션 카드 좌측 4px 보더 + 배경색 변경
- [ ] (c) 복귀 동선: 우상단 "관리자 대시보드" 링크 + 사이드바 항상 노출
- [ ] (d) 빈 상태/오류 상태: 슬롯 0건 / 검색 결과 0건 / 권한 오류 모두 친절한 안내 문구
- [ ] (e) 라벨 평이성: "추천콘텐츠 큐레이션", "콘텐츠 추가", "자동 폴백" — 약어/외래어 최소화 ("폴백 → 자동 추천으로 채움" 부연 설명 병기)

### 7.7 도메인 관점(LRS·접근성·보안)
- [ ] 관리자 액션 로그 필요 시 `learning_logs`에 admin verb 기록(선택, 운영 감사용)
- [ ] 관리자 화면 모든 input `<label for>` 쌍, 키보드 네비 가능
- [ ] 드래그 대안: 키보드 ↑/↓ 단축키로 순서 이동 (접근성)
- [ ] 추가 모달의 콘텐츠 결과는 `is_public=1 AND status='approved'` 강제 (개인정보·미승인 자료 노출 방지)
- [ ] 색만으로 상태 구분 X (숨김 배지엔 텍스트 동반 — 색맹 대응)

---

## 8. 구현 순서 권고 (Backend → Frontend)

| Phase | 작업 | 산출 |
|-------|------|------|
| P0 | `db/schema.js`에 2개 테이블 + 시드 4행 추가 | DB 마이그 PASS |
| P1 | `routes/content.js`에 `GET /api/contents/featured` 추가(폴백 로직 포함) | 뷰어 API 단일 호출 가능 |
| P2 | `routes/admin.js`(또는 신규 `routes/admin-featured.js`)에 7개 admin API 추가 | Postman·preview_eval로 CRUD PASS |
| P3 | `public/admin/index.html` 사이드바 + 섹션 마크업 + JS 렌더 | 관리자 화면 동작 |
| P4 | `public/content/index.html` `renderRecommend()` 단일 API로 리팩터 + layout 분기 함수 3개 | 뷰어 페이지 PASS |
| P5 | 추가 모달(검색·페이지네이션·일괄 추가) 구현 | 큐레이션 UX 완성 |
| P6 | UI 디자이너 더블체크 → 테스터 E2E → 감리 OK | 사용자 보고 |

---

## 9. 참고 / 비고

- **새 섹션 추가는 v2 범위 밖**: 시드 4개 고정. 학교/시즌별 새 섹션이 필요해지면 v2에서 "+ 섹션 추가" UI를 도입.
- **추천콘텐츠 페이지 검색 영역 보존**: 기존 통합 검색바는 그대로 유지(섹션 위에 위치), 큐레이션 영향 X.
- **외부 의존성 추가**: SortableJS CDN 1줄 추가만 필요 (`https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js`).
- **기존 hardcoded 학기 분기 로직** (`(m >= 3 && m <= 7) ? '1학기' : ...`)은 제거. 학기 정보는 관리자가 타이틀에 직접 적도록.
- **CLAUDE.md 모달 표준 준수**: 추가 모달 90vw × 90vh, 닫기 우상단 무배지 영역, z-index 10001.
- **CLAUDE.md 토스트 표준 준수**: top-center, 2.4초.
- **CLAUDE.md 공통 UI 스케일 준수**: 본문 16~17 / 버튼 16 / 배지 13 / 카드 h3 19~20.

---

문서 끝.
