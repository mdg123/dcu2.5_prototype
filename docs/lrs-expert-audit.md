# 다채움 LRS 전문가 감사 보고서

**작성일**: 2026-04-21
**작성자**: LRS 전문가 (서브에이전트)
**대상**: 다채움 플랫폼의 `learning_logs` 및 5개 집계 테이블, `routes/lrs.js` 18개 API
**범위**: 데이터 모델 감사, KPI 30개 도출, 스키마/집계/API 개선안, 성취기준 연계 설계
**구현 기준**: 현재 코드베이스에서 1~2일 내 적용 가능한 설계 우선

---

## 1. 현재 데이터 모델 감사

### 1.1 스키마 vs 저장 로직 불일치 목록

`db/schema.js`(L430~444)의 `CREATE TABLE` 문과 `db/learning-log-helper.js` / `db/lrs.js` / `routes/lrs.js`의 실제 INSERT 간 컬럼이 서로 다릅니다. 마이그레이션(L1091~1121)이 누락 컬럼을 `ALTER TABLE`로 보강하고 있어 런타임에는 동작하지만, "단일 근원(single source of truth)"이 없어 유지 보수가 어렵습니다.

| 정의된 컬럼 (CREATE TABLE) | `learning-log-helper.js` INSERT 컬럼 | `db/lrs.js` `logActivity` INSERT 컬럼 | 불일치 유형 |
|---|---|---|---|
| id | - | - | OK |
| user_id | user_id | user_id | OK |
| class_id | class_id | class_id | OK |
| activity_type | activity_type | activity_type | OK |
| activity_id | (미사용) | activity_id | `lrs.js`만 사용. 헬퍼는 `target_id` 로 대체 → 같은 의미를 **두 컬럼이 병렬로 쓰임** |
| verb | verb | verb | OK |
| object_type | object_type | object_type | OK |
| object_id | object_id | object_id | OK |
| result (TEXT) | (미사용) | result (JSON string) | 헬퍼는 `result_score/result_success/result_duration`로 분해 저장 → **이중 스키마** |
| duration | (미사용 — `result_duration`으로 저장) | duration | 헬퍼는 `result_duration`(VARCHAR), lrs.js는 `duration`(INTEGER) → **단위/타입 불일치** |
| metadata | metadata | metadata | OK |
| created_at | (DEFAULT) | (DEFAULT) | OK |
| — (마이그레이션 추가) target_type | target_type | — | OK |
| target_id | target_id | — | OK |
| result_score | result_score | — | OK |
| result_success | result_success | — | OK |
| result_duration | result_duration | — | OK |
| context_registration | (미사용) | — | **정의만 있고 아무도 안 씀** |
| source_service | source_service | — | OK |
| achievement_code | achievement_code | — | OK (단, 실제 수집 지점 대부분에서 null) |
| statement_json | statement_json | — | OK |

**핵심 불일치 5가지**

1. **이중 경로(dual-write) 문제**: `logLearningActivity`(확장 헬퍼)와 `lrs.logActivity`(초기 모델)가 서로 다른 컬럼 집합으로 같은 테이블에 기록. 대시보드 쿼리는 둘을 섞어 읽으므로 동일 활동이 다른 형태로 들어가 집계 부정확.
2. **`duration` vs `result_duration`**: `duration`은 INTEGER(초 추정), `result_duration`은 VARCHAR(ISO8601 `PT30S` 형식 예상). 실제로는 `result_duration`에 정수 문자열이 저장되고 있고, 집계는 `CAST AS INTEGER`로 강제 변환(lrs-aggregate.js L34). xAPI 표준은 ISO8601 duration이 정답.
3. **`activity_id` vs `target_id`**: 두 컬럼이 실질적으로 같은 의미지만 다른 라우트가 다른 쪽을 씀. 콘텐츠 조회(`target_type='content', target_id=123`) vs 레거시(`activity_id=123`).
4. **`result`(JSON TEXT) vs 분해 컬럼**: `result` 필드가 남아있어 두 형식이 공존. 쿼리 시 어디를 봐야 할지 모호.
5. **`context_registration` 데드 컬럼**: 정의만 존재, 아무도 쓰지 않음. xAPI의 세션 식별자로 활용 가능하지만 현재 미구현.

### 1.2 5개 집계 테이블 용도/갱신/결측 정리

| 테이블 | 용도 | 갱신 타이밍 | 결측/문제 |
|---|---|---|---|
| `lrs_daily_stats` | 일자×activity_type×서비스×클래스 단위 실시간 집계. 대시보드 일별 추이 카드. | INSERT 시 즉시 UPSERT(`learning-log-helper.js` L16). 관리자 재빌드 가능. | `unique_users`가 실시간 UPSERT에서는 항상 `unique_users`(변경 없음) → **실제 고유 유저가 세지지 않음**. 재빌드 시에만 정확. `avg_score` 가중평균 계산이 `activity_count` 기반이라 null 점수가 섞이면 왜곡. |
| `lrs_user_summary` | 사용자×activity_type 누적. 학생 카드/학부모 알림. | INSERT 시 즉시. | `total_duration` 동일 문제(ISO8601/정수 혼용). `last_streak_days`, `engagement_score` 같은 파생 지표 **없음**. |
| `lrs_content_summary` | 콘텐츠별 조회/완료/평균 점수. | INSERT 시 즉시. | `unique_users`를 "새 사용자 여부 판정 없이 +1"하는 **버그**(L49) → 같은 사용자 반복 조회 시에도 증가. 재빌드 후에만 정확. |
| `lrs_class_summary` | 클래스×activity_type 집계. 교사 대시보드. | INSERT 시 즉시. | `unique_users`가 UPSERT에서 변경되지 않음(L61) → 초기값 1에서 고정. 재빌드 의존. 기간 필터 불가(누적만). |
| `lrs_service_stats` | 서비스(portal/class/content/self-learn/cbt/growth)×verb. 관리자 서비스 점유율. | INSERT 시 즉시. | `unique_users` 동일 이슈. 기간 슬라이스 없음(모든 기간 누적). |

**공통 문제**
- **실시간 UPSERT의 `unique_users` 부정확성**: 5개 테이블 중 4개가 UPSERT에서 고유 사용자 카운트를 실제로 갱신하지 못함. 일시적 재빌드 없이는 신뢰 불가.
- **기간 분할 부재**: `lrs_class_summary`, `lrs_service_stats`, `lrs_user_summary`, `lrs_content_summary`는 모두 "영원 누적"이라 "최근 7일 교사 클래스 상위" 같은 질의는 `learning_logs` 원본 풀스캔이 강제됨.
- **재빌드 비용**: `rebuildAllAggregates`는 트랜잭션 1개에 6개의 `INSERT ... SELECT`를 묶어 있어 로그가 수십만 건이 되면 락 타임이 길어짐.

### 1.3 xAPI 표준 매핑 상태

xAPI Statement 핵심 5요소 기준:

| xAPI 요소 | 매핑 컬럼 | 상태 | 문제점 |
|---|---|---|---|
| actor | `user_id` | 부분 적합 | IRI(`account.name`)만 저장. `account.homePage`, `mbox` 등 없음. 외부 IdP 연계 시 한계. |
| verb | `verb` | 적합 | 단, verb ID가 IRI가 아닌 짧은 키워드(`completed`, `accessed`). `statement_json`에만 IRI가 들어감. **두 가지 표현이 공존**. |
| object | `object_type`, `object_id`, `target_type`, `target_id` | 혼동 | `object_id`가 실제 IRI(`urn:dacheum:lesson:42`) 형식, `target_id`가 raw ID. **중복 표현**. |
| result | `result_score`, `result_success`, `result_duration`, `result` | 적합(단 이중저장) | 위 1.1 참조. `response`(오답 텍스트), `extensions` 없음. |
| context | `context_registration`, `source_service`, `achievement_code`, `class_id` | 부분 적합 | `instructor`, `team`, `platform`, `language`, `statement.parent/grouping` 등 표준 context 전무. |
| timestamp | `created_at` | 적합 | `stored` vs `timestamp` 구분 없음 (xAPI에서는 다름). |
| authority | — | 없음 | 누가 statement를 검증/발행했는지 기록 없음. 외부 LRS 연계 시 필수. |
| attachments | — | 없음 | 파일 첨부 기반 증빙(포트폴리오)은 `portfolio_items`와 별도. |

**결론**: xAPI 0.9 수준 부분 구현. 완전한 xAPI 1.0.3 호환을 원한다면 `statement_json`을 "정본"으로 삼고 나머지 컬럼은 "쿼리 성능용 인덱스 뷰"로 재정의해야 함.

### 1.4 Caliper Analytics 호환성

IMS Caliper는 xAPI와 달리 "Event 분류 체계"가 강제됩니다. 현재 상태:

| Caliper 개념 | 현재 매핑 | 평가 |
|---|---|---|
| Entity (Person, DigitalResource, Assessment 등) | `target_type` 기준 유추 가능 | 부분 적합 |
| Event 유형(AssessmentEvent, MediaEvent, NavigationEvent 등) | `activity_type` 사용 | **Caliper 표준 명칭 미사용** — `lesson_view` ≠ `NavigationEvent` |
| action (Viewed, Submitted, Graded, Paused 등) | `verb` 사용 | xAPI verb와 동일 토큰 쓰는 중 → Caliper에서는 다른 vocabulary |
| membership (사용자-코스 관계) | `class_members` 별도 테이블 | 적합 |
| federatedSession | `context_registration` (미사용) | 빈 칸 |
| generated (학습 결과물) | `result_*` + `portfolio_items` | 부분 적합 |

**권장 전략**: Caliper 완전 호환은 투자비용이 크므로, **xAPI 1.0.3 정본 + Caliper 어댑터 API**(/api/lrs/caliper/events) 형태로 나중에 우선순위 낮게 두고, 당장은 xAPI 표준 정비에 집중.

---

## 2. KPI / 지표 30개

| # | 지표명 | 대상 사용자 | 산출식(의사 SQL) | 필요 raw 필드 | 권장 시각화 | 정책/학업 성취 연관성 |
|---|---|---|---|---|---|---|
| 1 | 오늘의 학습 시간 | 학생/학부모 | `SUM(result_duration) WHERE user_id=? AND DATE(created_at)=today` | user_id, result_duration, created_at | 게이지(목표 60분) | 자기주도학습 시간 최소 기준 |
| 2 | 주간 학습 연속 일수(streak) | 학생 | `연속된 DISTINCT DATE(created_at)` 계산 | user_id, created_at | 카운터+불꽃아이콘 | 학습 지속성(habit) |
| 3 | 활동 유형별 균형도 | 학생/교사 | 각 `activity_type` 비율의 엔트로피 | activity_type | 도넛 + 이상적 분포 대비 | 편식 학습 경고 |
| 4 | 과제 제출률 | 학생/교사/학부모 | `submit_count / assigned_count` | activity_type='homework_submit', class_id | 도넛 게이지 | 책임감, 성실성 |
| 5 | 과제 제시간 제출률 | 교사 | `on_time / submitted` | metadata.due_date vs created_at | 스택 바 | 시간 관리 능력 |
| 6 | 평가 평균 점수 추이 | 학생/학부모 | `AVG(result_score) GROUP BY 주` WHERE activity_type='exam_complete' | result_score, created_at | 선그래프 | 학업 성취 추세 |
| 7 | 성취기준별 도달률 | 학생/교사 | `성공건/시도건 GROUP BY achievement_code` | achievement_code, result_success | 히트맵(성취기준×상중하) | 2022 개정 교육과정 준수 |
| 8 | 교과별 학습 시간 비중 | 학생/학부모 | `SUM(result_duration) GROUP BY subject_code` | metadata.subject_code | 가로 막대 | 교과 균형 |
| 9 | 콘텐츠 완료율 | 학생/교사 | `complete_count / view_count` (lrs_content_summary) | target_type='content' | 도넛 | 자기주도학습 성실성 |
| 10 | 오답률 TOP 10 성취기준 | 교사 | `1 - AVG(result_success) GROUP BY achievement_code ORDER BY 1 DESC LIMIT 10` | achievement_code, result_success | 가로 막대 | 보충지도 우선순위 |
| 11 | 학생별 학습 참여 지수 | 교사/관리자 | `z-score(활동수) + z-score(시간) + z-score(점수)` 가중합 | 전부 | 방사형 차트 | 학습 소외 학생 조기 발견 |
| 12 | 학급 평균 vs 개인 점수 | 학생/학부모 | 학생 평균 - 학급 평균 | result_score, class_id | 횡막대(편차) | 상대적 위치 |
| 13 | 학습 시간대 분포 | 학생/학부모/교사 | `COUNT(*) GROUP BY strftime('%H', created_at)` | created_at | 히트맵(요일×시간) | 학습 습관 |
| 14 | 연속 접속일 백분위 | 관리자 | 학생 streak의 분위수 | user_id, created_at | 박스플롯 | 플랫폼 사용 건강도 |
| 15 | DAU/WAU/MAU | 관리자 | `COUNT(DISTINCT user_id) WHERE ...` | user_id, created_at | 카드 3개 | 플랫폼 활성도 |
| 16 | 서비스별 이용 분포 | 관리자 | `COUNT(*) GROUP BY source_service` | source_service | 스택 면적 차트 | 서비스 ROI |
| 17 | 평균 세션 시간 | 관리자 | `AVG(session_duration)` *세션 정의 필요* | session_id(신규) | 카드 | 몰입도 |
| 18 | 재방문율 (7일) | 관리자 | 가입 후 7일 내 재방문 사용자 비율 | user_id, created_at | 코호트 차트 | 리텐션 |
| 19 | 교사별 수업 개설 수 | 관리자 | `COUNT(*) FROM lessons GROUP BY teacher_id` | lessons | 테이블 랭킹 | 교사 활용도 |
| 20 | 클래스별 활동 풍부도 | 교사/관리자 | `COUNT(DISTINCT activity_type) GROUP BY class_id` | class_id, activity_type | 가로 막대 | 수업 다양성 |
| 21 | 성취수준(상/중/하) 분포 | 교사/학부모 | `CASE WHEN avg_score>=0.8 상, >=0.5 중, ELSE 하` | result_score, achievement_code | 스택 바(학생×상중하) | NEIS 성취수준 보고 |
| 22 | 개인별 약점 성취기준 TOP 5 | 학생/학부모 | `user_id별 최저 평균 5개 achievement_code` | user_id, achievement_code, result_score | 카드 리스트 | 맞춤 학습 추천 |
| 23 | 재시도 개선율 | 교사 | `retry 시 점수 - first 시 점수` 평균 | retry_count, result_score | 스택 바 | 오답 노트 효과 |
| 24 | 감정·학습 상관 | 학생/학부모 | `CORR(emotion_score, learning_duration)` | emotion_logs, duration | 산점도 | 정서-학업 통합 |
| 25 | 출석-참여 상관 | 교사 | `CORR(attendance_rate, activity_count)` | attendance, activity | 산점도 | 학교 적응 |
| 26 | 콘텐츠 인기도(이용/완료/평점) | 관리자/콘텐츠팀 | 가중합 점수 | lrs_content_summary | 테이블 랭킹 | 콘텐츠 품질 관리 |
| 27 | 디바이스/채널별 이용 | 관리자 | `COUNT(*) GROUP BY device_type(신규)` | metadata.device | 도넛 | 인프라 의사결정 |
| 28 | 평가문항 평균 풀이 시간 | 교사 | `AVG(result_duration) WHERE activity_type='exam_complete'` | result_duration | 선 | 문항 난이도 추정 |
| 29 | 포트폴리오 축적도 | 학생/학부모 | `COUNT(portfolio_items) WHERE user_id=?` | portfolio_items | 카운터+타임라인 | 성장 가시화 |
| 30 | AI 튜터/콘텐츠 추천 수용률 | 관리자/기획 | `accept / impressions` | (신규 로그) | 도넛 | AI 효과성 |

---

## 3. 스키마 개선안

### 3.1 `learning_logs` 보강 (SQLite ALTER TABLE, 1일 내 적용 가능)

현재 마이그레이션 블록(`db/schema.js` L1091~1121) 뒤에 이어 붙입니다.

```sql
-- 세션 추적(xAPI context.registration)
ALTER TABLE learning_logs ADD COLUMN session_id VARCHAR(40);
-- 정수 초 단위 소요 시간(정확한 집계용; result_duration은 ISO8601 정본)
ALTER TABLE learning_logs ADD COLUMN duration_sec INTEGER;
-- 디바이스/채널
ALTER TABLE learning_logs ADD COLUMN device_type VARCHAR(20);   -- web/ios/android/pc
ALTER TABLE learning_logs ADD COLUMN platform VARCHAR(30);      -- browser/app/kiosk
-- 재시도/정답 집계용
ALTER TABLE learning_logs ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE learning_logs ADD COLUMN correct_count INTEGER;     -- 문항 중 정답 수
ALTER TABLE learning_logs ADD COLUMN total_items INTEGER;       -- 총 문항 수
-- 성취수준 (상/중/하/미도달) — 실시간 산출 후 캐시
ALTER TABLE learning_logs ADD COLUMN achievement_level VARCHAR(10);
-- 연계 xAPI
ALTER TABLE learning_logs ADD COLUMN parent_statement_id INTEGER;
-- 구조화 메타 (metadata와 별도 정규화된 JSON — 스키마 강제)
ALTER TABLE learning_logs ADD COLUMN metadata_json TEXT;
-- 교과/학년 캐시(메타 조인 비용 절감)
ALTER TABLE learning_logs ADD COLUMN subject_code VARCHAR(20);
ALTER TABLE learning_logs ADD COLUMN grade_group INTEGER;
```

추가 인덱스 (쿼리 패턴 기반):

```sql
CREATE INDEX IF NOT EXISTS idx_ll_user_date      ON learning_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ll_achv          ON learning_logs(achievement_code, result_success);
CREATE INDEX IF NOT EXISTS idx_ll_subject_date  ON learning_logs(subject_code, created_at);
CREATE INDEX IF NOT EXISTS idx_ll_session       ON learning_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_ll_class_date    ON learning_logs(class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ll_service_verb  ON learning_logs(source_service, verb);
```

**폐기(Deprecate)하되 삭제는 보류**: `activity_id`, `duration`(INTEGER), `result`(TEXT). 어댑터 레이어에서 write-shim만 유지하고 새 쿼리는 쓰지 않음. SQLite는 `DROP COLUMN`이 3.35+부터 지원되므로 v2에서 정리.

### 3.2 신규 집계 테이블

```sql
-- (A) 성취기준별 진전도 — 학생 맞춤 대시보드 필수
CREATE TABLE IF NOT EXISTS lrs_achievement_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  achievement_code VARCHAR(50) NOT NULL,
  subject_code VARCHAR(20),
  attempt_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  avg_score REAL,
  last_level VARCHAR(10),            -- 상/중/하/미도달
  last_attempt_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, achievement_code)
);
CREATE INDEX IF NOT EXISTS idx_las_user ON lrs_achievement_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_las_code ON lrs_achievement_stats(achievement_code);

-- (B) 세션 요약 — "평균 세션 시간", "몰입도"
CREATE TABLE IF NOT EXISTS lrs_session_stats (
  session_id VARCHAR(40) PRIMARY KEY,
  user_id INTEGER NOT NULL,
  class_id INTEGER,
  started_at DATETIME,
  ended_at DATETIME,
  duration_sec INTEGER,
  activity_count INTEGER DEFAULT 0,
  services_touched TEXT,             -- JSON array
  device_type VARCHAR(20),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lss_user_date ON lrs_session_stats(user_id, started_at);

-- (C) 학생×일자 요약 — streak/DAU 계산 전용(경량)
CREATE TABLE IF NOT EXISTS lrs_user_daily (
  user_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  activity_count INTEGER DEFAULT 0,
  duration_sec INTEGER DEFAULT 0,
  avg_score REAL,
  subjects_touched TEXT,             -- JSON array of subject_code
  PRIMARY KEY(user_id, stat_date)
);
```

### 3.3 데이터 보존(Retention) 정책 제안

| 테이블 | 보존 기간 | 정리 방식 |
|---|---|---|
| `learning_logs` (raw) | **학년 단위 영구** (법정 생활기록부 연계 대비) | 단, `metadata_json`, `statement_json`는 180일 후 압축 외부 스토리지로 이관 |
| `lrs_daily_stats` | 영구 | 변경 없음 |
| `lrs_session_stats` | 1년 → 월단위 요약 후 삭제 | 크론 |
| 나머지 집계 | 영구 | 재빌드 가능 |

현실적으로 초등 프로토타입은 **원본 2년 + 집계 영구**로 시작해도 됩니다.

---

## 4. API 엔드포인트 개선/추가

### 4.1 기존 18개 중 부족한 점

- `/api/lrs/dashboard`가 **참조 에러 위험**: `routes/lrs.js` L49에서 `db` 변수가 선언되기 전에 쓰임(L116에서 require). 기간 필터 경로만 탔을 때 ReferenceError 가능. **긴급 수정 필요**.
- `/api/lrs/stats/by-achievement`에 학생 필터가 없음 — "내 약점 성취기준" 호출 불가.
- `/api/lrs/stats/daily`가 `duration` 컬럼을 쓰는데 실제 값은 `result_duration`에 있음 → 총 학습 시간 항상 0.
- `/api/lrs/export`는 단일 포맷(CSV)만, 기관 납품 시 JSON-LD/xlsx 요청 가능성 높음.
- `/api/lrs/content/:contentId`가 `target_type='content'`로 하드코딩되어 다른 타입 콘텐츠(비디오/문서) 구분 불가.
- Live 실시간 피드가 없음 — 교사가 "지금 수업 중인 학생"을 볼 수 없음.
- 개별 학생 상세 인사이트(강점/약점/추천) 없음.
- 학부모 뷰용 엔드포인트(자녀 1명 요약) 없음.

### 4.2 신규 엔드포인트 사양

**GET `/api/lrs/insights/:userId`** — 학생 1인 종합 인사이트(사이드바용).

```json
{
  "success": true,
  "userId": 123,
  "asOf": "2026-04-21T12:34:56Z",
  "snapshot": {
    "streakDays": 12,
    "weeklyDurationMin": 234,
    "weeklyTarget": 300,
    "weeklyScoreAvg": 0.78,
    "engagementIndex": 0.82
  },
  "strengths": [
    { "achievementCode": "6수학05-02", "avgScore": 0.92, "attempts": 14 }
  ],
  "weaknesses": [
    { "achievementCode": "6수학03-07", "avgScore": 0.42, "attempts": 9,
      "recommendedContentIds": [4521, 4533] }
  ],
  "subjectBalance": [
    { "subjectCode": "math-e", "durationMin": 90, "pct": 0.38 },
    { "subjectCode": "korean-e", "durationMin": 60, "pct": 0.26 }
  ],
  "nextBestActions": [
    { "type": "homework", "id": 88, "reason": "과제 마감 내일" },
    { "type": "content", "id": 4521, "reason": "약점 보충" }
  ]
}
```

**GET `/api/lrs/live-feed?classId=42&limit=20`** — Server-Sent Events 또는 롱폴링.

```json
{
  "success": true,
  "events": [
    {
      "id": 10234,
      "ts": "2026-04-21T13:45:02Z",
      "userId": 123, "displayName": "김민수",
      "activityType": "exam_complete",
      "verb": "completed",
      "score": 0.85,
      "subject": "수학",
      "achievementCode": "6수학05-02"
    }
  ]
}
```

**GET `/api/lrs/achievement-progress?userId=123&subjectCode=math-e&gradeGroup=6`**

```json
{
  "success": true,
  "subject": { "code": "math-e", "name": "수학" },
  "standards": [
    {
      "code": "6수학05-02",
      "area": "자료와 가능성",
      "content": "평균을 구할 수 있다.",
      "attempts": 14,
      "success": 13,
      "avgScore": 0.92,
      "level": "상",
      "lastAt": "2026-04-20T10:00:00Z"
    }
  ],
  "summary": { "total": 32, "reached": 24, "partial": 6, "notYet": 2 }
}
```

**GET `/api/lrs/class/:classId/heatmap?metric=engagement&from=2026-04-01&to=2026-04-21`** — 학생×일자 히트맵 데이터.

**GET `/api/lrs/parent/:childId/digest?period=week`** — 학부모 주간 리포트.

**POST `/api/lrs/session/start` / `POST /api/lrs/session/end`** — 세션 ID 발급/종료, 자동 클라이언트 heartbeat.

**GET `/api/lrs/compare?userIds=1,2,3&metric=score`** — 교사용 학생 비교 카드.

**GET `/api/lrs/export?format=xlsx|jsonld|xapi`** — 포맷 확장.

### 4.3 기존 엔드포인트 개선 사항 (최소 수정)

| 엔드포인트 | 개선 |
|---|---|
| `POST /api/lrs/log` | `logLearningActivity` 헬퍼로 경로 통합(현재 `lrs.logActivity`만 호출). |
| `GET /api/lrs/stats/daily` | `duration` → `COALESCE(duration, CAST(result_duration AS INTEGER))`로 수정. |
| `GET /api/lrs/dashboard` | `db` require를 상단으로 이동. 버그 수정. |
| `GET /api/lrs/stats/by-achievement` | `user_id`, `subject_code` 필터 추가. curriculum_standards JOIN으로 성취기준명/영역까지 반환. |
| `GET /api/lrs/content/:contentId` | `target_type` 파라미터화. |

---

## 5. 성취기준 연계 설계

### 5.1 `achievement_code`를 `learning_logs`에 결합하는 방법

**수집 지점 3단계 전략** (현재는 거의 모든 호출에서 null):

1. **lessons/homework/exams 테이블에 `achievement_code` 필수화**: 출제자가 수업/과제/평가 생성 시 반드시 curriculum_standards에서 1개 이상 선택. `curriculum-data.json`의 920개 코드를 드롭다운으로 노출.
2. **`logLearningActivity` 호출부 일괄 수정**: `routes/homework.js`, `routes/exam.js`, `routes/lesson.js`, `routes/content.js`에서 호출 시 해당 엔티티의 `achievement_code`를 조회해 인자로 전달.
3. **문항 단위 성취기준**: 평가(CBT)는 문항 1개당 성취기준 1개 매핑. `exam_questions` 테이블에 `achievement_code`를 추가하고, 응시 결과를 문항별로 쪼개어 각각 `learning_logs`에 기록(지금은 시험 1건만 기록됨).

### 5.2 성취수준(상/중/하) 산출 알고리즘

**규칙 기반(1단계, 즉시 적용)**:

```
성취수준 =
  IF 시도 수 < 3  THEN '미도달'
  ELIF 최근 5회 평균 점수 >= 0.80  THEN '상'
  ELIF 최근 5회 평균 점수 >= 0.50  THEN '중'
  ELSE '하'
```

**가중 규칙(2단계, 1주 내 적용)**: 최근일수록 가중, 문항 난이도 보정.

```
weighted_score = Σ(score_i × recency_weight_i × difficulty_weight_i) / Σ(weights)
recency_weight = 0.5^((today - attempt_date) / 14)   -- 반감기 14일
difficulty_weight = 1 + (문항난이도 - 0.5)           -- 어려운 문항 가산
```

**IRT 기반(3단계, 추후)**: CBT 문항별 1PL Rasch 모델로 능력치(θ) 추정 후 cut score 적용. 현 단계에서는 과도한 투자.

### 5.3 교과-단원-차시-성취기준 계층 집계 전략

2022 개정 교육과정 성취기준 코드 예: `6수학05-02` → "초등6학년-수학-자료와가능성(05)-02번".

**계층**:
```
school_level(초/중/고) → subject_code → grade_group → area → standard_code
                                                    ↘ unit(교과서 단원) → lesson(차시)
```

**집계 뷰(VIEW)로 1~2일 내 가능**:

```sql
CREATE VIEW v_lrs_achievement_rollup AS
SELECT
  cs.school_level,
  cs.subject_code,
  s.name as subject_name,
  cs.grade_group,
  cs.area,
  cs.code as achievement_code,
  COUNT(ll.id) as attempts,
  SUM(CASE WHEN ll.result_success=1 THEN 1 ELSE 0 END) as successes,
  AVG(ll.result_score) as avg_score,
  COUNT(DISTINCT ll.user_id) as unique_users
FROM curriculum_standards cs
JOIN subjects s ON s.code = cs.subject_code
LEFT JOIN learning_logs ll ON ll.achievement_code = cs.code
GROUP BY cs.code;
```

**단원/차시 레벨**은 현재 스키마에 단원 테이블이 없으므로(`lessons`만 존재), `lessons.unit_name` 텍스트를 추가한 뒤 `lessons.achievement_codes`(JSON array)로 다대다 관계를 맺으면 됩니다. 별도 매핑 테이블까지는 현 단계에서 과투자.

**대시보드 활용**:
- **학생 뷰**: 교과 선택 → 학년군 영역 카드 → 카드 클릭 시 성취기준 리스트 + 개인 성취수준 표시.
- **교사 뷰**: 학급 전체의 성취기준별 도달률 히트맵 (행=학생, 열=성취기준, 색=성취수준).
- **관리자 뷰**: 학교 단위 교과×학년군 평균 성취수준 분포.

---

## 6. 우선순위 액션 아이템 (1~2일 구현 범위)

### Day 1 (백엔드 — 약 6시간)

1. `learning_logs` 컬럼 추가 마이그레이션(§3.1) — 30분
2. `lrs_achievement_stats`, `lrs_session_stats`, `lrs_user_daily` 테이블 생성 — 30분
3. `logLearningActivity`를 단일 진입점으로 통합, `lrs.logActivity` 제거 또는 내부 위임 — 1시간
4. `rebuildAllAggregates` 확장(성취기준/일별/세션 포함) — 1시간
5. `routes/lrs.js` 4개 버그 수정(§4.3) — 1시간
6. 신규 엔드포인트 3개 구현: `/insights/:userId`, `/achievement-progress`, `/live-feed` — 2시간

### Day 2 (연계 + UI 반영 — 약 6시간)

1. `lessons/homework/exams` 생성 폼에 성취기준 드롭다운 — 2시간
2. 각 서비스 라우트에서 `logLearningActivity` 호출 시 `achievementCode`, `sessionId`, `subjectCode` 전달 — 2시간
3. 성취수준 산출 함수(`computeAchievementLevel`) 및 크론(1일 1회 재산출) — 1시간
4. LRS 대시보드 프런트엔드에서 신규 지표 10개 반영 — 1시간

### 검증 체크리스트

- [ ] 단일 진입점(`logLearningActivity`)만 남고 `lrs.logActivity`는 래퍼
- [ ] 모든 활동 기록 시 `session_id`, `achievement_code`, `subject_code`가 채워지는지 샘플 100건 검사
- [ ] `lrs_achievement_stats` 행 수 > 0
- [ ] `/api/lrs/insights/:userId` 응답 시간 < 200ms (집계 테이블 활용)
- [ ] `rebuildAllAggregates` 10만 건 기준 < 5초

---

## 7. 장기 로드맵 (참고)

- **Phase 2 (2~4주)**: IRT 기반 성취수준, 추천 엔진, 학부모 이메일 주간 다이제스트
- **Phase 3 (1~3개월)**: 외부 LRS(SCORM Cloud/Veracity LRS) 연계, Caliper 1.2 어댑터
- **Phase 4 (3개월~)**: 학습 분석 AI — 드롭아웃 예측, 개인화 학습 경로, 교사 개입 추천

---

## 부록 A — 빠른 참조: 현재 파일 위치

- 스키마 정의: `db/schema.js` L430~519, 마이그레이션 L1091~1121
- 단일 기록 헬퍼: `db/learning-log-helper.js` (15컬럼 경로)
- 레거시 헬퍼: `db/lrs.js` (10컬럼 경로, 통합 대상)
- 재집계: `db/lrs-aggregate.js`
- API 라우터: `routes/lrs.js` (18개 엔드포인트)
- 성취기준: `db/curriculum.js` + `db/curriculum-data.json` (920개)

## 부록 B — 총평

현재 LRS는 "xAPI 스타일 영감을 받은 자체 포맷" 수준으로, 스키마 정의-마이그레이션-저장 로직의 3층이 서로 다른 컬럼 집합을 참조하는 드리프트가 가장 큰 기술 부채입니다. **통합(single writer) + 성취기준 주입 + 집계 테이블 정합성**만 잡아도 대시보드 품질이 극적으로 올라갑니다. 본 보고서의 Day 1~2 액션만 완수해도 KPI 30개 중 22개가 즉시 산출 가능합니다. 나머지 8개(세션 몰입도, 재시도 개선율, 추천 수용률 등)는 세션/재시도/추천 로깅 포인트 보강 후 Phase 2에서 커버하는 것을 권장합니다.
