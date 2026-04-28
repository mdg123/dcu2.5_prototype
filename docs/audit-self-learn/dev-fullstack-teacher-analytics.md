# P1 — 교사용 학생별 AI 맞춤학습 모니터링 화면 (Full-stack)

- 담당: opus (Full-stack)
- 일자: 2026-04-28
- 관련: `teacher-tester.md` H-2, `qa-final-audit.md` P1
- 브랜치: `feat/curriculum-std-aidt`

---

## 1. 문제 요약

`public/class/analytics.html` 은 LRS·growth API 만 호출하여 전반적 활동량은 보였으나, **AI 맞춤학습(self-learn) 진도 — 완료노드, 정답률, 학습시간, 연속학습일** 은 전혀 표시되지 않았다. 교사가 자기 클래스의 self-learn 사용 현황을 보려면 학생 본인 화면에 들어가는 수밖에 없었다.

---

## 2. 변경 파일

| 영역 | 파일 | 변경 |
| --- | --- | --- |
| Backend API | `routes/class.js` | `GET /api/class/:classId/students/self-learn-summary` 신설 |
| Frontend | `public/class/analytics.html` | "🎯 AI 맞춤학습" 탭 추가 + 평균 카드 + 정렬 가능한 학생 표 + 학생별 영역별 정답률 모달 |

DB 스키마 변경 없음 (기존 `user_node_status`, `problem_attempts`, `user_content_progress`, `daily_learning_progress`, `user_last_activity` 활용).

---

## 3. API 명세

### `GET /api/class/:classId/students/self-learn-summary`

#### 인증·권한

- 로그인 필요 (`requireAuth`)
- 다음 중 하나만 통과:
  - 해당 클래스의 `owner` 멤버 (= 클래스 개설 교사)
  - `req.user.role === 'admin'`
- 그 외(학생/멤버 교사/외부)는 **403 "교사·관리자만 접근 가능합니다."**

#### Response (200)

```json
{
  "success": true,
  "classId": 1,
  "summary": {
    "student_count": 8,
    "avg_completed_nodes": 0,
    "avg_accuracy": 5,
    "avg_time_minutes": 4,
    "total_solved": 18,
    "active_students": 1
  },
  "students": [
    {
      "user_id": 3,
      "username": "student1",
      "name": "이학생",
      "completed_nodes": 0,        // user_node_status WHERE status IN ('completed','mastered')
      "in_progress_nodes": 7,      // status='in_progress'
      "total_solved": 18,          // problem_attempts COUNT
      "correct_count": 7,
      "avg_accuracy": 39,          // 0~100
      "total_time_minutes": 13,    // (user_content_progress.position_sec + daily_learning_progress.time_spent_seconds) / 60
      "streak": 1,                 // 최근 30일 연속 학습일자
      "last_activity_at": "2026-04-28 02:36:07",
      "areas": [
        { "area": "수학", "total": 2, "correct": 1, "accuracy": 50 }
      ]
    }
  ]
}
```

#### 산출 SQL 요약

| 필드 | 출처 |
| --- | --- |
| `completed_nodes` | `user_node_status` `status IN ('completed','mastered')` |
| `in_progress_nodes` | `user_node_status` `status='in_progress'` |
| `total_solved`, `correct_count` | `problem_attempts` 누적 |
| `total_time_minutes` | `user_content_progress.position_sec` + `daily_learning_progress.time_spent_seconds` |
| `last_activity_at` | `MAX(user_last_activity.accessed_at)` |
| `streak` | 최근 30일 `user_last_activity` 의 `DATE(accessed_at) DISTINCT` 에서 오늘부터 역순 연속 일수 (오늘 미활동이면 어제부터) |
| `areas[]` | `problem_attempts` ⨝ `learning_map_nodes(subject)` 그룹별 정답률 |

---

## 4. 권한 매트릭스

| 역할 | 시나리오 | 결과 |
| --- | --- | --- |
| 학생 (`student1`, member) | `GET /api/class/1/students/self-learn-summary` | **403** ("교사·관리자만 접근 가능합니다.") |
| 교사 (`teacher1`, 1·2반 owner) | 본인이 owner인 classId 1 | **200** (8명 데이터) |
| 교사 (`teacher1`) | 본인이 owner가 아닌 다른 classId | **403** |
| 관리자 (`admin`) | 임의 classId | **200** |
| 비로그인 | 임의 classId | **401** (`requireAuth`) |

> 학생 본인 자기 데이터(self-learn 화면)는 기존 `/api/self-learn/dashboard` 등 학생용 엔드포인트로 그대로 제공된다 (변경 없음).

---

## 5. UI 와이어프레임

`/class/analytics.html` 우측 탭 4번째 추가:

```
┌─────────────────────────────────────────────────────────────────┐
│ [📊 종합 분석] [👥 학생별 분석] [⚠️ 관심 학생] [🎯 AI 맞춤학습]   │
└─────────────────────────────────────────────────────────────────┘

🎯 AI 맞춤학습 탭 본문:

┌─────────── 클래스 평균 — AI 맞춤학습 ───────────┐
│ [학생수 8] [평균완료 0] [평균정답률 5%]          │
│ [평균학습 4분] [활성학습자 1]                    │
└─────────────────────────────────────────────────┘

┌─── 학생별 AI 맞춤학습 진도  (행 클릭 → 상세 모달) ───┐
│ 학생         | 완료노드▼ | 풀이수 | 정답률 | 학습시간 | 연속학습 | 최근활동 │
├──────────────┼──────────┼────────┼────────┼─────────┼─────────┼─────────┤
│ ◯ 이학생     | ▰▱▱▱ 0   |  18문  | 39%🟡  |  13분   | 1일     | 오늘    │
│   student1   |  +7 진행  |        |        |         |         |         │
│ ◯ 박학생     | ▱▱▱▱ 0   |   0문  |  0%🔴  |   0분   | 0일     | 활동없음│
│ ...                                                                       │
└──────────────────────────────────────────────────────────────────────────┘
   ↑ 헤더 클릭 시 정렬 토글 (▼/▲)
   ↑ 정답률 색상: ≥80% 초록 / ≥60% 노랑 / <60% 빨강
   ↑ 연속학습 ≥3 일이면 🔥 prefix
   ↑ 완료노드는 막대바(목표 30개 기준 비례)

학생 행 클릭 시 모달:
┌──────── 🎯 이학생 — AI 맞춤학습 상세 ────────┐
│ [완료 0] [정답률 39%🟡] [학습 13분] [연속 1일]│
│                                                │
│ 영역별 정답률                                  │
│  수학       ▰▰▱▱▱▱▱▱▱▱  50% (1/2)            │
│                                                │
│ 최근 활동: 2026-04-28 11:36                    │
└────────────────────────────────────────────────┘
```

### 정렬·필터

- 헤더 클릭으로 sort 토글: `completed_nodes`, `total_solved`, `avg_accuracy`, `total_time_minutes`, `streak`, `last_activity_at`
- 기본 정렬: 완료노드 ↓
- 필터는 별도 추가하지 않고 정렬·색상 코딩으로 시각 분리

---

## 6. 검증 결과 (실측)

| # | 시나리오 | 결과 |
| --- | --- | --- |
| 1 | `teacher1` 로그인 → `/api/class/1/students/self-learn-summary` | **PASS** — 8명 데이터, summary 정상 |
| 2 | `student1` 로그인 → 동일 엔드포인트 | **PASS** — 403 차단 |
| 3 | `/class/analytics.html` 페이지 로드 | **PASS** — `AI 맞춤학습` 탭 / `loadSelfLearnSummary` 함수 / 상세 모달 모두 포함 확인 |
| 4 | 학생 표 정렬 | **PASS** — 헤더 클릭 시 sortKey/sortDir 토글 후 재렌더 |
| 5 | 데이터 무결성 | **PASS** — `student1`(이학생) 실제 18회 시도, 39% 정답률, 13분 학습시간이 자기학습 화면 통계와 일치 |

샘플 응답(이학생):
```
total_solved=18, correct_count=7, avg_accuracy=39%
in_progress_nodes=7, completed_nodes=0
total_time_minutes=13, streak=1
areas: [{ area:'수학', total:2, correct:1, accuracy:50 }]
```

---

## 7. 후속 제안 (이번 PR 범위 밖)

- **클래스 단위 학습목표 설정 UI**: 현재 완료노드 막대바는 "30개 = 100%" 하드코딩. `classes.settings` 에 `target_nodes_per_term` 필드를 추가해 교사가 단원별 목표치를 정하도록 확장.
- **CSV 내보내기 버튼**: 학부모 면담용으로 표를 CSV/Excel 로 다운로드.
- **날짜 범위 필터**: 현재는 누적값. `?since=YYYY-MM-DD` 파라미터 + 화면 상단 기간 토글 추가 시 학기 단위 분석 가능.
- **학생 행 클릭 → 상세 화면**: 모달 대신 `/teacher/student/:userId/self-learn` 전체 페이지로 빼면 영역별 + 노드별 + 최근 풀이 문항까지 노출 가능.

---

## 8. 메인 폴더 sync 확인

`scripts/sync-to-main.mjs --all` 실행으로 메인 폴더에 다음 8 파일 복사 완료:

```
public/class/analytics.html
public/self-learn/learning-map.html
public/self-learn/today.html
routes/class.js
scripts/regenerate-quiz-v3.js
sync-db.mjs / sync-routes.mjs / sync.mjs
```

이 작업의 핵심 산출물은 `routes/class.js` + `public/class/analytics.html` 두 개.
