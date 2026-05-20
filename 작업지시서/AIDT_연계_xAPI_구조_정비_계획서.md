# AIDT 데이터수집 연계 — xAPI 구조 정비 작업계획서

> 작성: 도메인 전문가(opus) · 2026-05-20
> 입력 자료: `AIDT 기술규격문서(데이터수집) v2.2_240802.pdf`(KERIS, 2024-07-20), `lib/xapi/**`, `db/learning-log-helper.js`, `db/schema.js`, `routes/*.js`
> 본 문서는 **읽기 전용 분석 결과**. 코드 수정 없음. 실제 구현은 PM이 선택한 Phase에 따라 Backend opus가 진행.

---

## 0. 작업 목적·범위

### 목적
- KERIS 「AI 디지털교과서 데이터수집 API 연계 가이드 v2.2」(2024-07-20)에 정의된 학습활동 데이터(xAPI 일괄 전송, `DATA_API_007`) 규격에 맞춰 다채움의 xAPI 구조를 **수신 준비/구조 맞춤**한다.
- 다채움 고유의 학습데이터(스스로채움·AI 맞춤학습·클래스 활동·나도예술가·마일리지·감정출석부 등)는 **그대로 보존**하되, AIDT 표준에 매핑 가능한 부분은 연계하고 매핑 불가능한 부분은 extension으로 첨부한다.

### 범위
- 본 작업은 다채움 ↔ AIDT 데이터 허브 사이의 **인터페이스 정합성**과 **데이터 구조 정비**에 한정.
- AIDT 측 실제 endpoint(`api_domain + /aidt_rawdata/...`) 연동·운영 인증·partner_access_token 발급은 **별도(Phase 3+ / 운영 전환 시)**.
- 이미 spool에 쌓인 기존 데이터의 마이그레이션 정책은 §7에서 별도 다룬다.

### 제외 범위
- 「대화식 처리 API」(`DATA_API_001~005`, AIDT 시작·종료·진도·완료·점수 메시지) — 운영 전환 시 추가 검토.
- 「전·출입 학습이력 데이터 연계 API」(전학생 데이터 인수인계) — 운영 정책 결정 후 검토.
- KERIS 발급 partner-id/access_token 획득 절차(`API_AUTH_001`) — 실제 등록 시점 별도.

---

## 1. AIDT 명세 핵심 요약 (PDF 28쪽 + 관련 페이지)

### 1.1 학습활동 데이터의 전송 단위 — `DATA_API_007`

| 항목 | 값 |
|---|---|
| API ID | `DATA_API_007` |
| 형식 | `api_domain + /aidt_rawdata/send_statement` |
| 메서드 | REST API / `POST` |
| 주기 | **일괄(Batch)** — 개발사 자체 일정으로 수집 후 일괄 송신 |
| 송신 방향 | AIDT(개발사) → AIDT 플랫폼(KERIS) |
| Body 인코딩 | `Transfer-Encoding: chunked` (HTTP 표준 헤더 + RFC 9112 7.1 명시적 chunk-format) |
| 인증 | `Partner-Access-Token`(JWT, DATA_API_006 으로 사전 발급) + `Transfer-Id` + `Chunked-Index` 헤더 |
| 응답 | `code`(전체 처리 결과), `transfer_id`, `list_error[{code,message,index}]`(개별 statement 검증 실패 목록) |

> chunk format은 응용 레이어가 명시적으로 구성해야 함(써드파티 자동 chunking과 무관). 첫 청크는 `Chunked-Index: 1`, 마지막은 `"0\r\n"`.

### 1.2 xAPI Statement 골격 (28~34쪽)

```jsonc
{
  "timestamp": "2024-04-08T00:00:00.000+00:00",          // 전송 데이터의 해당 일자 (ISO 8601 UTC, ms 포함)
  "actor": {
    "objectType": "Agent",
    "account": {
      "homePage": "http://example.com/aidt-platform",    // 개발사 URL
      "name": "550e8400-e29b-41d4-a716-446655440000"     // 학생/교사 UUID (개인식별코드, §1.4)
    }
  },
  "verb":   { "id": "...", "display": { "en-US": "..." } },
  "object": {
    "id": "http://example.com/240408-{area}-{userUuid}",  // 해당 일자·영역·학습자 단위의 임의 ID (idempotency)
    "objectType": "Activity",
    "definition": {
      "type": "http://aidtbook.kr/xapi/activity-type/{area}",
      "description": { "ko-KR": "..." },
      "extensions": { /* {area}-info — 메타데이터 배열 */ }
    }
  },
  "result":  { "extensions": { /* {area}-detail — 결과 배열 */ } },
  "context": {
    "platform": "A개발사 디지털교과서",
    "extensions": {
      "http://aidtbook.kr/xapi/profiles/cmn/1.0/contexts/extensions/partner-id":
        "230d3200-c23g-56l2-a543-235555890032"
    }
  }
}
```

### 1.3 10개 학습활동 영역 (28쪽 표 — 다채움 builder와 1:1 대응)

| # | 영역(Area) | verb | object | 다채움 builder | 비고 |
|---|---|---|---|---|---|
| ① | Media(미디어) | `played` | `media` | `builders/media.js` | audio/video, length·difficulty·curriculum-standard-id·common |
| ② | Assessment(평가) | `submitted` | `assessment` | `builders/assessment.js` | items-info, type(D/F/S/E), AI튜터 추천여부, 0-100 환산 점수 |
| ③ | Assignment(과제) | `gave` / `finished` | `assignment` | `builders/assignment.js` | gav-assignment(교사), fin-assignment(학생) |
| ④ | Navigation(경로) | `viewed`/`read`/`did`/`learned` | `image`/`document`/`practice`/`etc-content` | `builders/navigation.js` | object가 4종으로 분기 — **현 다채움은 단일 'content'** |
| ⑤ | Objective(목표) | `set` | `objective` | `builders/objective.js` | type(S/D/E), revision-cnt, visit-cnt, completion(%) **— 단일 verb 'set'** |
| ⑥ | Query(질의) | `searched`/`asked` | `keyword`/`question` | `builders/query.js` | search-detail / ask-detail (AI튜터 응답 시간·만족도) |
| ⑦ | Social-Learning(소셜러닝) | `participated` | `social-learning` | `builders/social.js` | board-info(C/G/E), social-learning-detail(view/post/reply/comment/like 카운트 집계) |
| ⑧ | Survey(조사) | `submitted` | `comprehension-survey`/`emotion-survey`/`emotion-today-survey` | `builders/survey.js` | 리커트 척도 명시 필수 |
| ⑨ | Annotation(주석) | `made` | `annotation` | `builders/annotation.js` | 하이라이트·메모·북마크, annotation-cnt(횟수 집계) |
| ⑩ | Teaching(교수활동) | `gave`/`reorganized` | `feedback`/`class` | `builders/teaching.js` | 교사 actor, feedback-info / class-info |

### 1.4 필수 식별·메타 규약

- **학습자 식별자**(`actor.account.name`): **UUID v4 또는 v5**(`User-ID:UUID`). 개발사는 학생/교사 식별 시 평문 ID·이메일을 노출하지 않고 UUID 매핑을 보내야 함.
- **교육과정 표준체계 ID**(`curriculum-standard-id`): KERIS '교육과정 표준체계' 기준 코드(예: `E4MATA01B01C01`). 학교급-학년-교과-단원-주제-내용 6레벨 인코딩.
- **콘텐츠 유형 코드**(query.search-detail.content-type): `E`(평가)·`I`(문항)·`A`(음원)·`V`(영상)·`IM`(이미지)·`T`(텍스트)·`P`(실습)·`Z`(기타).
- **평가 유형 코드**(assessment-info.type): `D`(진단)·`F`(형성)·`S`(총괄)·`E`(기타).
- **문항 유형 코드**(items-info.type): `M`(객관식)·`S`(단답주관식)·`L`(서술주관식)·`E`(기타).
- **게시판 유형 코드**(board-info.type): `C`(학급)·`G`(모둠)·`E`(기타).
- **목표 유형 코드**(objective-detail.type): `S`(선택형)·`D`(서답형)·`E`(기타).
- **난이도 없음 표기**: `-1`(`difficulty`, `difficulty-min`, `difficulty-max` 모두 동일 규약).
- **`common` 플래그**: 콘텐츠가 국가 제공 공통 콘텐츠인지 boolean.
- **`aitutor-recommended` 플래그**: AI튜터가 추천한 콘텐츠/평가/문항인지 boolean.
- **timestamp 형식**: ISO 8601 with milliseconds, **UTC offset 명시**(`+00:00` 권장). 예: `2024-04-08T00:00:00.000+00:00`.

### 1.5 영역별 result 핵심 필드

| 영역 | result 핵심 필드 |
|---|---|
| Media | `audio-detail`/`video-detail` [{id, aitutor-recommended, duration, completion, attempt, mute-cnt, skip-cnt, pause-cnt}] |
| Assessment | `assessment-detail` [{id, aitutor-recommended, score(0~100), timestamp, item-detail[{id, aitutor-recommended, completion, correct(boolean), ...}]}] |
| Assignment | `gav-assignment`(교사) / `fin-assignment`(학생) [{id, timestamp(과제 등록·제출 시각)}] |
| Navigation | (영역별로 별도 result-detail 명세 없음 — object만 분류 의미) |
| Objective | `objective-detail` [{type(S/D/E), content, timestamp, revision-cnt, visit-cnt, completion(%)}] |
| Query | `search-detail`(content-id, search-word, content-type) / `ask-detail`(timestamp, answer(boolean), duration, satisfaction(0~1)) |
| Social-Learning | `social-learning-detail` [{id, view-cnt, post-cnt, reply-cnt, comment-cnt, like-cnt}] **— 게시판 단위 집계 카운트** |
| Survey | `comprehension-survey-detail`/`emotion-survey-detail`/`emotion-today-survey-detail` [{id, item-detail[{id, response-yn, response(int)}]}] |
| Annotation | `annotation-detail` [{content-id, curriculum-standard-id[], annotation-cnt(int)}] **— 콘텐츠 단위 집계** |
| Teaching | result 해당 없음 (feedback/class 모두) |

### 1.6 응답·오류 코드

- 성공: HTTP 200 + body `{ "code": "00000", "transfer_id": "..." }`.
- 부분 실패: body `list_error[]`에 statement index 단위로 에러 코드 반환(예: `XAPI_VAL_ERR`). 개발사는 오류 인덱스만 재전송.
- 응답 코드 표·오류 코드 표는 PDF 91~100쪽(미정독, 운영 단계에서 정합 필요).

---

## 2. 다채움 현재 xAPI 구현 요약

### 2.1 파일 구성

| 경로 | 라인 | 역할 |
|---|---|---|
| `lib/xapi/common.js` | 241 | 상수(EXT/VERB/CONTENT_TYPE_MAP/ASSESSMENT_TYPE_MAP/QUESTION_TYPE_MAP), actor/context/statement/activity 빌더, UUID v5 생성, 성취수준 환산(초 A~C / 중·고 A~E) |
| `lib/xapi/std-resolver.js` | 158 | 표준체계 std_id / 성취기준 code 양방향 보강, items 배열·ancestor_union 산출 |
| `lib/xapi/spool.js` | 134 | `enqueue(builderResult, ctx)` — `xapi_statement_spool` INSERT + `lrs_std_node_stats` 조상체인 업서트, `drainUnsent(limit)`, `markSent(id, status)`, `record(area, builderFn, ctx, payload)` |
| `lib/xapi/builders/media.js` | 78 | verb=`played`, object='content'(단일), `audio-info`/`video-info` extension 미사용 |
| `lib/xapi/builders/assessment.js` | 122 | verb=`submitted`/`scored`/`passed`/`failed` (AIDT는 `submitted` 단일), `assessment-info`/`assessment-detail` 형식 미준수 |
| `lib/xapi/builders/assignment.js` | 115 | verb=`gave`/`finished` ✓, `gav-assignment`/`fin-assignment` 명칭은 미사용(자체 extension URL) |
| `lib/xapi/builders/navigation.js` | 78 | verb=`viewed`/`read`/`did`/`learned` ✓, object type은 `targetType`(보통 'content') — **AIDT 4분기(image/document/practice/etc-content) 미적용** |
| `lib/xapi/builders/objective.js` | 113 | verb=`planned`/`achieved`(AIDT는 `set` 단일), object='objective' ✓, type(S/D/E)·revision-cnt·visit-cnt·completion 미산출 |
| `lib/xapi/builders/query.js` | 98 | verb=`searched`/`asked` ✓, object type='query'(단일) — **AIDT는 `keyword`/`question` 분기**, ask-detail의 duration·satisfaction 미산출 |
| `lib/xapi/builders/social.js` | 85 | verb=`shared`/`commented`/`liked` (AIDT는 `participated` 단일 + `social-learning-detail`로 카운트 집계 — **모델 자체가 다름**) |
| `lib/xapi/builders/survey.js` | 81 | verb=`submitted`/`responded`, object='survey'(단일) — **AIDT는 `comprehension`/`emotion`/`emotion-today` 3분기 + 리커트 척도** |
| `lib/xapi/builders/annotation.js` | 71 | verb=`annotated`(AIDT는 `made`), object='annotation' ✓, annotation-cnt(횟수 집계) 미산출 |
| `lib/xapi/builders/teaching.js` | 98 | verb=`gave`/`reorganized` ✓, object='teaching'/'class' (AIDT는 `feedback`/`class`) |
| `db/learning-log-helper.js` | 449 | **별도 트랙** — `learning_logs` 테이블에 자체 statement_json 기록 + lrs_* 8종 집계 테이블 업서트. xAPI builders와 **이중 기록 구조** |

### 2.2 DB 스키마 (관련 부분)

```sql
-- 1단계: xAPI statement 스풀 (배치 송신 대기/완료)
CREATE TABLE xapi_statement_spool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_uuid TEXT NOT NULL,              -- AIDT UUID v5
  user_id INTEGER,                       -- 다채움 내부 user.id
  area TEXT NOT NULL,                    -- 10영역 분류
  verb TEXT NOT NULL,
  statement_json TEXT NOT NULL,          -- 완성된 xAPI Statement
  event_timestamp DATETIME NOT NULL,
  primary_std_id TEXT,
  subject_code TEXT,
  object_type TEXT,
  object_id INTEGER,
  success INTEGER,                       -- 0/1/null
  achievement_level TEXT,                -- A~E or A~C
  sent_at DATETIME,                      -- NULL = 미전송
  sent_status TEXT,                      -- 'ok'|'error'|'skipped'
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2단계: 표준체계 노드별 누적(리프+조상)
CREATE TABLE lrs_std_node_stats (
  user_id INTEGER, node_id TEXT, depth INTEGER,
  attempts INTEGER, correct INTEGER, last_level TEXT,
  updated_at DATETIME, PRIMARY KEY(user_id, node_id)
);

-- 3단계: 별도 트랙 — learning_logs (lrs_* 8종 집계 source)
CREATE TABLE learning_logs (
  /* user_id, activity_type, target_type, target_id, class_id,
     verb, object_type, object_id, result_score, result_success,
     result_duration, source_service, achievement_code, metadata,
     statement_json, session_id, duration_sec, device_type, platform,
     correct_count, total_items, achievement_level, parent_statement_id,
     subject_code, grade_group, ... */
);
```

### 2.3 Statement 라이프사이클

```
라우터(예: routes/exam.js:513)
  → xapiSpool.record('assessment', buildAssessment, ctx, payload)
    → buildAssessment(ctx, payload) → { statement, meta }
    → xapiSpool.enqueue(...)
      → INSERT xapi_statement_spool
      → ancestor_union 순회 → UPSERT lrs_std_node_stats
  (병렬로 routes 내부에서 logLearningActivity(...) 직접 호출 → learning_logs INSERT + lrs_* 8종 업서트)
```

### 2.4 외부 LRS 연동 여부

- **미연동.** `xapi_statement_spool.sent_at`은 항상 `NULL` 상태로 적재만 됨. `drainUnsent(limit)` 함수는 정의만 되어 있고 호출처 없음.
- `markSent`도 호출처 없음 → spool은 **순수 로컬 로그/대시보드 소스**로만 운영 중.

### 2.5 actor 식별

- `userUuid(userId)` = `uuidv5('dacheum:user:{userId}', NAMESPACE)` → 결정적 UUID v5 생성.
- `homePage`는 `process.env.AIDT_HOMEPAGE || 'https://dacheum.kr'`.
- `name`은 `name: displayName || 'user-{userId}'` + `account.name: <UUID>` 동시 보유.

### 2.6 호출처 (검증된 builders 사용 지점)

| 파일 | 라인 | 영역 | verb | 트리거 |
|---|---|---|---|---|
| `routes/content.js` | 73, 798 | query, assessment | searched, submitted | 콘텐츠 검색·평가 풀이 |
| `routes/exam.js` | 513 | assessment | submitted | 시험 제출 |
| `routes/homework.js` | 65, 284, 344 | assignment | gave/finished | 과제 출제·제출·채점 |
| `routes/lesson.js` | 211, 220 | navigation, media | viewed/played | 수업 열람·미디어 재생 |
| `routes/self-learn.js` | 427, 829, 837, 946 | navigation, annotation, assessment | viewed/annotated/submitted | 오늘의 학습·오답노트·진단 |
| `routes/growth.js` | 1033, 1445 | (enqueue 직접), survey | (custom), submitted | 게이미피케이션·감정설문 |

> social, teaching, objective builder는 정의는 있으나 **실 호출처 없음**(0건). 즉시 후속 라우터에 적용 필요.

---

## 3. 비교·대조 매트릭스

### 3.1 Statement 골격

| 차원 | AIDT v2.2 요구 | 다채움 현재 | 일치 | 갭 | 연계 시 작업 |
|---|---|---|---|---|---|
| `timestamp` 형식 | `2024-04-08T00:00:00.000+00:00` (ms 포함, UTC offset 명시) | `new Date().toISOString()` → `2024-04-08T00:00:00.000Z` (Z 형식) | △ | ms ✓, offset 표기만 다름(Z vs +00:00) | `Z`도 ISO 8601 valid이나 AIDT 예시 일치 위해 `+00:00` 변환 옵션 권장 |
| `actor.objectType` | `"Agent"` | `"Agent"` | ✓ | — | — |
| `actor.account.homePage` | 개발사 AIDT-platform URL (예: `http://example.com/aidt-platform`) | `process.env.AIDT_HOMEPAGE || 'https://dacheum.kr'` | △ | KERIS 등록 시점에 발급되는 **개발사 공식 platform URL**로 교체 필요 | 환경변수 `AIDT_HOMEPAGE`를 운영 등록 URL로 설정 |
| `actor.account.name` | 학생/교사 UUID v4 또는 v5 (36자) | `uuidv5('dacheum:user:{id}', NAMESPACE)` 36자 | ✓ | namespace를 KERIS 표준에 맞출지 자체 관리할지 결정 필요 | `AIDT_UUID_NAMESPACE` env 고정. 실 운영에서 학생당 1개 UUID 일관성만 보장하면 OK |
| `verb.id` | AIDT 영역별 고정 URL (`http://aidtbook.kr/xapi/profiles/{area}/1.0/verbs/{verb}`) | 일부는 ADL(`http://adlnet.gov/...`), 일부는 tincanapi(`http://id.tincanapi.com/...`), AIDT URL 미사용 | ✗ | **모든 verb URL을 AIDT 도메인으로 교체** 필요 | 매핑표 §4에 영역별 verb URL 전부 명세, common.js의 `VERB`를 영역별로 분리 또는 builder에서 영역별 override |
| `verb.display` | `{ "en-US": "..." }` (영문 우선, 한글 옵션) | `{ "ko-KR", "en-US" }` 둘 다 | ✓ | 한글 추가는 무해 (AIDT는 영문 필수만 요구) | 그대로 유지 |
| `object.id` | 자유형식 URL, 일자·영역·학습자 단위로 고유 (`http://example.com/240408-media-{uuid}`) | `http://aidtbook.kr/xapi/objects/{type}/{contentId}` (날짜·학습자 단위 X) | △ | AIDT 예시는 idempotency용으로 일자+학습자 단위로 권고 — 다채움은 콘텐츠 ID 기준 | 권고: object.id에 날짜+학습자 prefix 추가하여 동일 학습자/일자/콘텐츠 중복 방지 |
| `object.objectType` | `"Activity"` | `"Activity"` | ✓ | — | — |
| `object.definition.type` | `http://aidtbook.kr/xapi/activity-type/{area}` (10종 고정) | `http://aidtbook.kr/xapi/activities/{type}` (다채움 임의 type) | ✗ | URL 경로가 `activities/` ≠ `activity-type/`이고 type 값도 임의 | **URL 경로 표준화** + 영역별 정해진 type 값(media/assessment/assignment/image/document/practice/etc-content/keyword/question/social-learning/comprehension-survey/emotion-survey/emotion-today-survey/annotation/feedback/class/objective) 매핑 |
| `object.definition.description` | `{ "ko-KR": "..." }` | 동일 | ✓ | — | — |
| `object.definition.extensions` | 영역별 `{area}-info`(예: `audio-info`, `assessment-info`, `assignment-info`, `image-info`, ...) 표준 URL | 다채움 자체 extension URL(`http://aidtbook.kr/xapi/extensions/content-type` 등) | ✗ | **AIDT 표준 extension URL과 키 구조 채택 필요** | 빌더별로 AIDT 표준 extension 블록 작성 |
| `result.duration` | (영역별 다름. Media는 audio-detail.duration int 초) | ISO 8601 `PT{n}S` 형식 | ✗ | AIDT는 int 초(`"duration": 2839`) — ISO 형식 아님 | duration 표기를 int 초로 변경 |
| `result.score` | Assessment만 `assessment-detail[].score` (0~100 정수, 소수점 X) | `result.score = { raw, max, scaled }` (xAPI 1.0.3 표준) | △ | AIDT는 score를 detail extension에 0-100 정수로 평탄화 | assessment 한정 별도 변환 |
| `result.success` / `completion` | (영역별 별도, completion만 boolean으로 detail 안에) | `result.completion`, `result.success` top-level | △ | top-level 사용은 xAPI 1.0.3 표준이지만 AIDT는 detail 내부 사용 | AIDT 전송 시 detail로 평탄화 |
| `context.platform` | 개발사 이름 문자열 (예: `"A개발사 디지털교과서"`) | `PLATFORM_NAME = '다채움'` | ✓ | KERIS 등록명과 일치 필요 | 등록 시점 결정 (`'충북다채움'` 등) |
| `context.language` | (명세 없음) | `"ko-KR"` | ✓ | 무해 | 유지 |
| `context.extensions.partner-id` | URL: `http://aidtbook.kr/xapi/profiles/cmn/1.0/contexts/extensions/partner-id`, value: UUID(KERIS 발급) | URL: `http://aidtbook.kr/xapi/extensions/partner-id`, value: `process.env.AIDT_PARTNER_ID || 'dacheum'` | ✗ | **URL 경로가 다름** (`/profiles/cmn/1.0/` 누락) + UUID 발급 후 env로 주입 | URL 정정 + env 운영 |

### 3.2 영역별 verb·object 매핑

| 영역 | AIDT verb | AIDT verb URL | AIDT object type | 다채움 verb | 다채움 verb URL | 다채움 object type | 갭 |
|---|---|---|---|---|---|---|---|
| ① Media | `played` | `…/profiles/media/1.0/verbs/played` | `media` (단일) | `played` | `http://adlnet.gov/expapi/verbs/played` | `content` | URL 교체 + object type을 `media`로 |
| ② Assessment | `submitted` | `…/profiles/assessment/1.0/verbs/submitted` | `assessment` | `submitted/scored/passed/failed` (4종) | activitystrea.ms/adlnet | `exam` 등 자유 | **verb를 submitted 1종으로 통일** + scored/passed/failed는 result 내부에 표현, object type을 `assessment`로 |
| ③ Assignment | `gave`/`finished` | `…/profiles/assignment/1.0/verbs/{gave,finished}` | `assignment` | `gave/finished` | `id.tincanapi.com/verb/gave`, `adlnet.gov/.../completed` | `homework` | URL 교체, finished verb URL도 교체, object type을 `assignment`로 |
| ④ Navigation | `viewed/read/did/learned` | `…/profiles/navigation/1.0/verbs/{...}` | **`image/document/practice/etc-content` 4분기** | 동일 4종 verb | tincanapi/adlnet 등 | `content` 단일 | **object type을 콘텐츠 종류별로 분기** — 이미지/문서/실습/기타. 4종에 맞는 정보 메타 추가 |
| ⑤ Objective | `set` (단일) | `…/profiles/objective/1.0/verbs/set` | `objective` | `planned/achieved` | `id.tincanapi.com/verb/planned`, `adlnet.gov/.../achieved` | `objective` | **verb 통일(`set`)** + `objective-detail`에 type(S/D/E)·content·revision-cnt·visit-cnt·completion 산출 |
| ⑥ Query | `searched/asked` | `…/profiles/query/1.0/verbs/{...}` | **`keyword/question` 분기** | `searched/asked` | activitystrea.ms/adlnet | `query` (단일) | object type 분기 + ask-detail의 duration(int 초)·satisfaction(0~1 float) 산출 |
| ⑦ Social-Learning | **`participated` (단일)** | `…/profiles/social-learning/1.0/verbs/participated` | `social-learning` (단일) | `shared/commented/liked` (3종) | activitystrea.ms/adlnet | `post` | **모델 전환** — 다채움은 이벤트 단위, AIDT는 게시판 단위 집계. **결과 집계기 신설** 필요(view/post/reply/comment/like-cnt) |
| ⑧ Survey | `submitted` | `…/profiles/survey/1.0/verbs/submitted` | **`comprehension-survey/emotion-survey/emotion-today-survey` 3분기** | `submitted/responded` | activitystrea.ms/adlnet | `survey` | object type 3분기 + **리커트 척도 메타 필수**(likert-min, likert-min-mean, likert-max, likert-max-mean) |
| ⑨ Annotation | `made` | `…/profiles/annotation/1.0/verbs/made` | `annotation` | `annotated` | `risc-inc.com/annotator/verbs/annotated` | `annotation` | verb URL/key 교체 + annotation-cnt(콘텐츠 단위 누적 활용 횟수) 산출 |
| ⑩ Teaching | `gave/reorganized` | `…/profiles/teaching/1.0/verbs/{...}` | `feedback/class` | `gave/reorganized` | `id.tincanapi.com/verb/{gave,reorganized}` | `teaching/class` | verb URL 교체 + object type을 `feedback/class`로, feedback-info/class-info에 content-id·curriculum-standard-id 첨부 |

### 3.3 식별·메타 코드 체계

| 항목 | AIDT 코드 | 다채움 매핑 (`common.js`) | 일치 |
|---|---|---|---|
| 콘텐츠 유형 | E/I/A/V/IM/T/P/Z | `CONTENT_TYPE_MAP` = V/A/IM/T/P/E/I/Z | ✓ (key 보강만 필요. 'lesson'→Z 추가됨) |
| 평가 유형 | D/F/S/E | `ASSESSMENT_TYPE_MAP` = diagnosis/formative/summative/self-check/homework/practice | △ (4코드로 압축 필요: self-check/homework/practice → E) |
| 문항 유형 | M/S/L/E | `QUESTION_TYPE_MAP` = MCQ/SAQ/ESS/TF/ORD/MAT/FIB | △ (M/S/L/E 4코드 매핑: MCQ→M, SAQ→S, ESS→L, 나머지→E) |
| 게시판 유형 | C/G/E | (현재 builder에 없음 — `board_kind` 자유문자열) | ✗ |
| 목표 유형 | S/D/E | (현재 builder에 없음) | ✗ |
| 학교급 | (명세 없음, 표준체계 ID 1자리로 인코딩) | `school_level` ('초'/'중'/'고') | △ |
| 성취수준 | (명세 없음, 평가 score 0-100만) | `computeAchievementLevel()` → A~C(초)/A~E(중·고) | 다채움 고유, extension으로 첨부 가능 |

---

## 4. 다채움 특수 항목 매핑 표

### 4.1 다채움 고유 활동 → AIDT 영역 매핑

| 다채움 활동 | 현재 builder | AIDT 영역 매핑 | AIDT 영역 외 메타(extension 필요) | 비고 |
|---|---|---|---|---|
| **스스로채움 > 오늘의 학습** (영상 시청) | media | ① Media (`played`) | `today-learning-source`(추천 소스: '오답기반'/'학습맵'/'수동') | object id에 오늘 날짜 prefix |
| **스스로채움 > 오늘의 학습** (수업 자료 열람) | navigation | ④ Navigation (`read`/`viewed`) — 콘텐츠 유형별 | (없음) | object type을 image/document/practice/etc-content로 분기 |
| **AI 맞춤학습 > 학습맵 노드 클릭** | navigation | ④ Navigation (`viewed`) — object='etc-content' | `learning-map-node`(node depth, 표준체계 ID) | etc-content 정의 활용 |
| **AI 맞춤학습 > 진단평가 응시** | assessment | ② Assessment (`submitted`, type='D') | (AIDT 표준에 포함) | 다채움 'diagnosis' → AIDT 'D' |
| **AI 맞춤학습 > 학습 목표 설정** | objective | ⑤ Objective (`set`, type='S' 또는 'D') | `recommended-by`(추천 주체) | revision-cnt/visit-cnt를 DB에 누적 |
| **AI 맞춤학습 > 진단 결과 추천 콘텐츠** | navigation + media | ④ Navigation + ① Media | `aitutor-recommended: true` 플래그 활용 | AIDT 표준 플래그로 처리 |
| **클래스 > 수업 열기** | navigation | ④ Navigation (`learned`+completion) | `lesson-step`(수업 단계) | object='etc-content' |
| **클래스 > 과제 출제** (교사) | assignment | ③ Assignment (`gave`) | `due-at`, `target-user-count` | gav-assignment 표준 적용 |
| **클래스 > 과제 제출** (학생) | assignment | ③ Assignment (`finished`) | `submission-status` | fin-assignment 표준 적용 |
| **클래스 > 평가 응시** | assessment | ② Assessment (`submitted`, type='F' 또는 'S') | `cbt-tab-switch-count`(이탈 횟수) | CBT 이탈 감지 결과 |
| **클래스 > 평가 채점** | assessment | ② Assessment (`submitted`) | 채점은 별도 statement (gav-assignment처럼) | scored verb 폐기 |
| **클래스 > 게시판 활동** | social | ⑦ Social-Learning (`participated`) | (없음 — view/post/reply/comment/like-cnt로 집계) | **이벤트 단위 → 게시판 단위 집계 변환 필요** |
| **클래스 > 알림장 작성/열람** | (현재 없음) | ⑦ Social-Learning 또는 ⑩ Teaching | `notice-kind`('알림장') | 신규 호출 추가 또는 teaching의 feedback-info 활용 |
| **클래스 > 설문 응답** | survey | ⑧ Survey (`submitted`, comprehension-survey) | 리커트 척도 4종 메타 필수 | object type 'comprehension-survey'로 |
| **클래스 > 감정출석부 (이모티콘 + 이유)** | survey | ⑧ Survey (`submitted`, emotion-today-survey) | 이모티콘 코드 → 리커트 0~4 매핑 | object type 'emotion-today-survey' |
| **클래스 > 감정 회고(주간·월간)** | survey | ⑧ Survey (`submitted`, emotion-survey) | 회고 기간(week/month) | object type 'emotion-survey' |
| **클래스 > 출석부 (1클릭 출석)** | (현재 없음) | (AIDT 표준 영역 없음) | **다채움 고유** — extension으로 첨부 | 별도 활동 영역 만들거나 navigation의 etc-content로 |
| **나도예술가 > 작품 업로드** | (현재 없음) | ⑦ Social-Learning 또는 ⑨ Annotation | `artwork-kind`('나도예술가'), `approval-status` | 게시글 등록(post-cnt)로 집계 |
| **나도예술가 > 작품 승인** (교사/관리자) | (현재 없음) | ⑩ Teaching (`gave`) — feedback | `approval-status: 'approved'`, target-user-id | feedback-info 활용 |
| **나도예술가 > 갤러리 댓글/좋아요** | social | ⑦ Social-Learning (`participated`) | board-info type='E'(기타) | social-learning-detail의 comment-cnt/like-cnt 집계 |
| **오답노트 메모/하이라이트** | annotation | ⑨ Annotation (`made`) | (AIDT 표준에 포함) | annotation-cnt를 콘텐츠 단위로 누적 |
| **AI 튜터 질문** | query | ⑥ Query (`asked`, object='question') | satisfaction(0~1), duration(int 초) | ask-detail 구조 적용 |
| **검색** | query | ⑥ Query (`searched`, object='keyword') | search-detail의 content-type(E/I/A/V/IM/T/P/Z) | keyword-info 활용 |
| **마일리지 적립** | (growth.js:1033 enqueue 직접) | **AIDT 표준 영역 없음** | **다채움 고유** — extension `mileage-detail`로 첨부 또는 별도 로컬 트랙 | AIDT 표준에 매핑 불가, 다채움 LRS 전용 |
| **게이미피케이션 (뱃지/스트릭)** | (growth.js) | **AIDT 표준 영역 없음** | 다채움 고유 | 마일리지와 동일 |
| **포트폴리오 자동 등록** | (learning-log-helper.js:412 자동) | (AIDT 표준 영역 없음 — 활동 자체가 부수) | 부수효과이므로 별도 statement 불필요 | 보조 데이터 |
| **소통쪽지** | (현재 없음) | ⑦ Social-Learning (board-info type='E') | message-thread-id | 또는 AIDT 표준에서 제외하고 다채움 전용 |
| **클래스 학습분석/LRS 대시보드 열람** | (집계 데이터 — statement 발행 아님) | — | — | 통계 조회는 xAPI 영역 외 |

### 4.2 결론
- **10개 영역 중 6개**(Media, Assessment, Assignment, Navigation, Query, Annotation, Teaching)는 다채움 builder가 거의 1:1 대응. URL·verb·object type·result 구조 정정만으로 호환 가능.
- **2개 영역**(Objective, Social-Learning)은 verb·모델 자체가 다름 — 다채움 이벤트 단위 → AIDT 집계 단위로 변환 어댑터 필요.
- **1개 영역**(Survey)은 3분기 object type + 리커트 척도 메타 필요. 다채움 감정출석부를 emotion-today-survey 로 매핑하는 작업 필요.
- **다채움 고유**(마일리지·게이미피케이션·승인 워크플로우·포트폴리오·출석부 1클릭·소통쪽지)는 AIDT 표준에 없음 → 다채움 LRS 전용 데이터로 보존 + 가능한 부분만 Teaching/Social의 extension으로 첨부.

---

## 5. 변경 필요 사항 (Phase 분할)

### Phase 1 — 필수 호환성 기반 (M)
> 목표: AIDT 표준 verb·object·extension URL·식별자 규약을 정정. 기존 spool 데이터 형식은 그대로 유지하되, **신규 발행분부터 표준 준수**.

#### 1-1. URL 표준화 (`lib/xapi/common.js`)
- `EXT` 객체의 키 URL 정정:
  - `partnerId`: `http://aidtbook.kr/xapi/extensions/partner-id` → `http://aidtbook.kr/xapi/profiles/cmn/1.0/contexts/extensions/partner-id`
  - 영역별 extension(`audio-info`, `video-info`, `assessment-info`, `assignment-info`, `image-info`, `document-info`, `practice-info`, `etc-content-info`, `keyword-info`, `social-learning-detail`, `comprehension-survey-info`, `emotion-survey-info`, `emotion-today-survey-info`, `annotation-detail`, `feedback-info`, `class-info`)는 AIDT 표준 URL로 매핑한 신규 상수 추가.
  - `makeActivity()`의 `definition.type`: `http://aidtbook.kr/xapi/activities/{type}` → `http://aidtbook.kr/xapi/activity-type/{type}` (경로명 정정).

#### 1-2. verb URL 표준화 (`lib/xapi/common.js` VERB 객체 또는 builder 별 override)
- 영역별 verb URL을 AIDT 도메인으로 교체. 권장: `VERB`는 공용을 유지하되, 각 builder에서 `verb.id`를 영역별 표준 URL로 override.

```js
// 예: builders/media.js
const verb = { id: 'http://aidtbook.kr/xapi/profiles/media/1.0/verbs/played', display: { 'en-US': 'played' } };
```

#### 1-3. 코드 매핑 표 보강 (`lib/xapi/common.js`)
- `BOARD_TYPE_MAP` 신규: `class_board`/`group_board`/`free_board` → `C`/`G`/`E`
- `OBJECTIVE_TYPE_MAP` 신규: `select`/`describe`/`etc` → `S`/`D`/`E`
- `ASSESSMENT_TYPE_MAP` 정합: `diagnosis`→`D`, `formative`→`F`, `summative`→`S`, 나머지→`E`
- `QUESTION_TYPE_MAP` 정합: `multiple_choice`→`M`, `short_answer`→`S`, `essay`→`L`, 나머지→`E`

#### 1-4. timestamp 형식 통일
- `common.js`의 `makeStatement`에서 `timestamp.toISOString()` (`Z` 형식) → `+00:00` 형식 변환 헬퍼 추가. (선택사항이지만 AIDT 예시 일치성 ↑)

#### 1-5. DB 스키마 보강 (`db/schema.js`)
- `xapi_statement_spool` 컬럼 추가:
  - `statement_id TEXT` (xAPI standard `id` 필드 — UUID, idempotency)
  - `actor_uuid TEXT` (이미 `user_uuid` 존재하지만 명시적 alias 권장)
  - `verb_id_full TEXT` (AIDT 표준 URL 추적용 — 옵션)
- 인덱스: `idx_xss_statement_id ON xapi_statement_spool(statement_id)` (재전송 dedup).

#### 1-6. 검증 (Phase 1 완료 기준)
- 임의 builder 호출 → 출력 statement가 AIDT가 제공한 별첨 JSON Schema(`DATA_API_007 xAPI jSON Schema`)에 통과.
- JSON Schema 검증 스크립트(`scripts/validate-xapi.js`) 신설 — spool 최근 100건 dry-validate.

---

### Phase 2 — 구조 정비 (M~L)
> 목표: 영역별 result/object/extension 구조를 AIDT 표준에 완전 정합. 다채움 고유 데이터는 별도 namespace로 분리.

#### 2-1. 영역별 builder 리팩토링

| Builder | 변경 |
|---|---|
| `media.js` | result에 `audio-detail`/`video-detail` extension 추가. `audio-info`/`video-info`(object) 추가. `duration` ISO 형식 → int 초로 변경. |
| `assessment.js` | verb를 `submitted` 단일로 통일 (scored/passed/failed는 result.extensions에 표현). `assessment-info`(items-info 포함) object extension 추가. `assessment-detail` result extension 추가 (score는 0~100 int). |
| `assignment.js` | object type을 `assignment`로 변경. `gav-assignment`/`fin-assignment` result extension 추가. |
| `navigation.js` | object type을 `image/document/practice/etc-content` 4분기. payload에 `content_kind` 추가하여 분기. 각 종류별 `*-info` extension 추가. |
| `objective.js` | verb `planned/achieved` → `set` 단일. `objective-detail` extension 추가(type S/D/E, content, revision-cnt, visit-cnt, completion). DB에 `objective_revisions` 테이블 추가하여 revision-cnt 누적. |
| `query.js` | object type을 `keyword`(searched) / `question`(asked) 분기. `search-detail`(content-id, search-word, content-type) 추가. `ask-detail`(timestamp, answer, duration, satisfaction) 추가. |
| `social.js` | **모델 전환** — `shared/commented/liked` 이벤트 단위 → `participated` + 집계. 새 헬퍼 `aggregateSocialStatements(userId, sinceTs)`: 게시판별로 view/post/reply/comment/like 카운트 집계 후 단일 statement 생성. |
| `survey.js` | object type을 `comprehension-survey/emotion-survey/emotion-today-survey` 3분기. 리커트 척도 메타 필수 산출. 감정출석부 이모티콘→리커트 정수 변환 테이블 추가. |
| `annotation.js` | verb `annotated` → `made`. `annotation-detail` extension 추가 (content-id, curriculum-standard-id, annotation-cnt — 콘텐츠 단위 누적). |
| `teaching.js` | object type을 `feedback/class`로 변경. `feedback-info`(content-id, curriculum-standard-id), `class-info`(curriculum-standard-id) extension 추가. |

#### 2-2. 다채움 고유 extension namespace 분리
- **AIDT 표준 영역**: `http://aidtbook.kr/xapi/profiles/{area}/1.0/...`
- **다채움 고유 extension**: `https://dacheum.kr/xapi/extension/...` (별도 namespace)
  - 예: `https://dacheum.kr/xapi/extension/mileage` — 마일리지 적립 detail
  - 예: `https://dacheum.kr/xapi/extension/badge` — 뱃지/스트릭 detail
  - 예: `https://dacheum.kr/xapi/extension/approval-status` — 갤러리 승인 워크플로우
  - 예: `https://dacheum.kr/xapi/extension/emotion-quick-attend` — 감정출석 한마디 코멘트
  - 예: `https://dacheum.kr/xapi/extension/cbt-tab-switch` — CBT 이탈 감지 카운트
- AIDT 전송 어댑터(Phase 3)에서 **다채움 namespace를 그대로 전송할지(권고), 제거 후 전송할지** 옵션화. 가이드 §1.4 "용어 정의"에 따르면 추가 extension은 무관하나, KERIS와 협의하여 최종 결정.

#### 2-3. 다채움 특수 데이터 매핑

| 다채움 데이터 | 매핑 위치 |
|---|---|
| 마일리지 점수 | result.extensions의 다채움 namespace |
| 뱃지/칭호 | objective의 result.extensions 다채움 namespace |
| 출석부 1클릭 출석 | navigation `did` + object='etc-content' + 다채움 namespace |
| 감정출석부 한마디 | survey의 result.extensions 다채움 namespace |
| 갤러리 승인 status | teaching `gave`(feedback) + 다채움 namespace |
| CBT 이탈 감지 | assessment의 result.extensions 다채움 namespace |

#### 2-4. learning_logs와 xapi_statement_spool 이중 트랙 정리
- 현재 `learning_logs`는 별도 statement_json 보유. **두 트랙의 statement가 다름** → 혼란 소지.
- 권장: `learning_logs.statement_json`은 운영 대시보드/포트폴리오 자동 등록 등 **다채움 내부 용도**, `xapi_statement_spool.statement_json`은 **AIDT 송신용**으로 명시 분리. (변환 어댑터를 통해 동일 이벤트가 양쪽에 일관되게 기록되도록 보장.)
- 또는 **단일 트랙으로 통합** — `learning_logs`를 폐기하고 `xapi_statement_spool` + `lrs_*` 집계 테이블 체제로 통일. (작업량 크지만 유지보수성 ↑)

---

### Phase 3 — 전송 인프라 (M)
> 목표: AIDT 운영 endpoint에 실제 송신 가능한 어댑터 구축. 본 작업은 KERIS 등록·인증키 발급 후에만 가능.

#### 3-1. AIDT 전송 어댑터 (`lib/xapi/aidt-transmitter.js` 신설)
- `obtainTransferToken()` — `DATA_API_006` 호출하여 `transfer_id` + `partner_access_token` 획득
- `transmitBatch(statements[])` — `DATA_API_007` POST
  - HTTP chunked transfer-encoding 구현 (각 statement를 hex chunk-size로 prefix)
  - 헤더: `Transfer-Encoding: chunked`, `Transfer-Id`, `Chunked-Index`, `Partner-Access-Token`
  - 응답 `code !== '00000'` → 전체 재시도, `list_error[]` 존재 → 해당 index만 재전송
- `markSentBatch(spoolIds[], status, errorMap)` — DB 일괄 업데이트

#### 3-2. 송신 스케줄러 (`lib/xapi/aidt-scheduler.js` 신설 또는 cron)
- 주기적(예: 매시간 또는 일 1회) `drainUnsent(limit=500)` → `transmitBatch()` → `markSentBatch()`
- 실패 statement는 `retry_count++` 후 다음 차수에 재시도, 5회 초과 시 `sent_status='error'` 고정 → 운영자 알림

#### 3-3. 환경변수 운영
- `.env` 추가:
  - `AIDT_TRANSMIT_ENABLED=false` (기본 OFF, 운영 전환 시 ON)
  - `AIDT_API_DOMAIN=https://...`
  - `AIDT_PARTNER_ID=<KERIS 발급 UUID>`
  - `AIDT_HOMEPAGE=<KERIS 등록 platform URL>`
  - `AIDT_BATCH_SIZE=500`
  - `AIDT_BATCH_INTERVAL_MIN=60`

#### 3-4. 관리자 UI — 송신 모니터링
- 신규 라우트 `routes/admin/aidt-monitor.js`:
  - 미전송/전송중/완료/실패 statement 카운트
  - 최근 24시간 batch 결과 (transfer_id별 성공/실패)
  - 수동 재전송 트리거

---

### Phase 4 — 운영 준비 (S~M, 선택)
> 목표: 개인정보 거버넌스·동의 기반 전송·법적 요건 충족.

#### 4-1. 학습자 동의 관리
- 학생/보호자 동의 테이블 (`user_data_consents`): `user_id`, `aidt_transmit_consent`, `consent_at`, `revoked_at`
- `obtainTransferToken()` 전에 동의 여부 확인 → 미동의 학습자는 spool에서 제외
- 운영 화면: 동의 철회 시 향후 적재 + 과거 데이터 마스킹/삭제 정책

#### 4-2. PII 마스킹
- `actor.name` (현재 displayName)을 AIDT 송신 시 제거 또는 마스킹. UUID만 송신.
- result.response (게시판 본문, 검색어, 질문 내용) 등 자유 텍스트 마스킹 옵션
- 마스킹 정책 환경변수 `AIDT_PII_MASK_LEVEL` (none/low/high)

#### 4-3. 데이터 거버넌스 로그
- 모든 송신 행위에 대한 감사 로그 (`aidt_audit_log`): 누가·언제·어떤 student의 statement를 송신했는지

---

## 6. 우선순위 옵션 (PM이 사용자에게 제안)

| 옵션 | 범위 | 예상 작업량 | 효과 |
|---|---|---|---|
| **A안. Phase 1만** | URL·verb·코드 매핑 표준화 | 2~3일 | 정합성 기반 확보. 신규 statement부터 AIDT 표준 준수. JSON Schema validator 통과 |
| **B안. Phase 1+2** | + 영역별 builder 리팩토링 + 다채움 namespace 분리 + Survey/Navigation/Objective/Social 모델 정비 | 1~2주 | 완전 구조 정합. KERIS 등록 시 즉시 전송 준비 완료 |
| **C안. Phase 1+2+3** | + 전송 어댑터 + 스케줄러 + 관리자 모니터 | 2~3주 | 실제 송신 가능 상태. KERIS 인증키만 발급되면 즉시 송신 |
| **D안. Phase 1+2+3+4** | + 동의/마스킹/감사 | 3~4주 | 운영 출시 가능 |

**권고**: 사용자가 "수신 준비/구조 맞춤"이라 명시했으므로 **B안(Phase 1+2)** 가 본 작업의 자연스러운 마감점. Phase 3+4는 KERIS 운영 전환 시점에 별도 차수로 진행.

---

## 7. 위험·고려 사항

### 7.1 기존 spool 데이터 마이그레이션
- 현재 `xapi_statement_spool`에 적재된 statement는 자체 verb/URL/object type 사용 — AIDT 표준 미준수.
- 옵션:
  - **(a) 폐기**: 기존 적재분은 다채움 내부 LRS 통계용으로만 사용, AIDT 송신은 Phase 1 적용 시점 이후 신규분만.
  - **(b) 변환 마이그레이션**: 기존 statement_json을 batch script로 표준 변환 후 `sent_status='legacy_migrated'` 표시. 정보 손실 가능성(원래 4종 verb를 1종으로 합치는 등).
  - **권고: (a)** — 마이그레이션 작업 부담 대비 효과 낮음.

### 7.2 식별자 가명화
- 현재 `actor.account.name`은 UUID v5 (`dacheum:user:{id}` 기반). UUID 결정적 생성 = 동일 학생이 다채움/타 AIDT 어디서나 같은 UUID? — **NO**. AIDT 가이드는 학생당 UUID 1개를 KERIS가 관리할 것으로 보임. 다채움은 자체 UUID를 보낸 후 KERIS가 매핑할 수도 있고, KERIS가 발급한 UUID를 받아써야 할 수도 있음. **운영 등록 시 확인 필수**.
- `actor.name` (displayName, 한글 이름) — AIDT 가이드는 actor에 name 필수 아님. **운영 송신 시 제거 권장** (PII 최소화).

### 7.3 학교급·학년 코드 표준화
- 다채움 `school_level`: '초'/'중'/'고' 문자열 — AIDT는 표준체계 ID 1자리(`E`/`M`/`H`)로 인코딩.
- 다채움 `grade_group`: 정수 (1~12) — 학년 그룹 분기. 표준체계 ID와 별개로 운영.
- 표준체계 ID(`E4MATA01B01C01`) 가 이미 학교급·학년·교과·단원·주제·내용을 모두 포함하므로, **표준체계 ID 우선 전송**이면 충돌 없음.

### 7.4 시간대
- 다채움: 서버 로컬 시간이 KST → `new Date().toISOString()`은 항상 UTC로 변환된 `Z` 형식. ✓
- AIDT 예시: `+00:00` 표기 (동일한 UTC지만 표기 형식 다름)
- ISO 8601 표준상 `Z`와 `+00:00`은 동치. KERIS validator가 `Z`도 허용하는지 확인 필요. 안전하게 `+00:00`으로 변환 권장.

### 7.5 chunked transfer-encoding 구현
- AIDT는 RFC 9112 7.1 명시적 chunk format 요구. Node.js `http.request`의 자동 chunking은 RFC 8259 따라 다르게 동작할 수 있음 — `Transfer-Encoding: chunked` 헤더만 설정 후 `req.write()` 호출 시 자동 처리되지만, AIDT가 요구하는 **응용 레이어 명시적 hex chunk-size + CRLF** 형식은 직접 구성해야 함.
- 권장: TCP socket 직접 사용보다 `http.request` + `req.write(Buffer.concat([chunkSizeHex, CRLF, body, CRLF]))` 패턴으로 구현 후 KERIS sandbox에서 검증.

### 7.6 KERIS partner 등록 의존성
- partner-id UUID, access_token, api_domain URL은 모두 KERIS 등록 후 발급. 본 작업서 작성 시점(2026-05-20) 미발급 가정.
- Phase 1·2는 발급 없이도 가능 (구조 정비). Phase 3은 발급 후 가능.

### 7.7 Social-Learning 모델 차이의 영향
- 다채움 현재: 게시글 작성·댓글·좋아요 **이벤트 단위** 발행.
- AIDT: 게시판 단위 **누적 집계** 1 statement.
- 변환 어댑터는 **다채움 trail**(이벤트 단위 spool 그대로 보존) + **AIDT 송신 변환기**(주기적으로 집계 후 별도 statement 생성) 두 트랙 동시 운영 권고.
- 이벤트 단위 데이터의 다채움 내부 활용도(예: 게시글 1건의 클릭 트래커)가 손실되지 않도록 주의.

---

## 8. 다채움 고유 데이터의 유지·연계 전략

### 8.1 이중 트랙 권고
> 사용자가 "유지하되 연계 가능하게"라 명시 → **두 트랙 동시 운영** 방식을 권장.

```
┌─────────────────────────────────────┐
│  다채움 활동 발생 (라우터)            │
└───────────────┬─────────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
┌──────────────┐  ┌──────────────────┐
│ 다채움 트랙   │  │ AIDT 트랙        │
│ (현재 그대로) │  │ (Phase 1·2 신규) │
├──────────────┤  ├──────────────────┤
│ learning_logs│  │ xapi_statement_  │
│ + lrs_* 8종  │  │   spool          │
│ 집계         │  │ + (선택)         │
│ + spool 자체 │  │   AIDT 전송      │
│ (포트폴리오· │  │   어댑터          │
│  대시보드)   │  │                  │
└──────────────┘  └──────────────────┘
       │                  │
       ▼                  ▼
다채움 내부 대시보드   KERIS 데이터 허브
(상세 이벤트 단위)    (영역별 표준 집계)
```

### 8.2 분리 원칙
- **다채움 트랙**(`learning_logs` + spool): 이벤트 단위 그대로. 다채움 내부 분석·포트폴리오·게이미피케이션 트리거 등 자체 용도 100% 유지.
- **AIDT 트랙**(spool 또는 별도 outbox 테이블): AIDT 표준 형식. 송신 후 보관 정책 별도(예: 송신 완료 후 90일 후 archive).
- **공통 보존**: 표준체계 ID 매핑(`std-resolver.js`), UUID 결정적 생성(`userUuid()`), 학교급·학년 메타 — 양 트랙에 동일 적용.

### 8.3 다채움 namespace extension 활용 예시
```jsonc
// 감정출석부 — AIDT 표준 emotion-today-survey + 다채움 한마디 코멘트
{
  "object": {
    "definition": {
      "type": "http://aidtbook.kr/xapi/activity-type/emotion-today-survey",
      "extensions": {
        "http://aidtbook.kr/xapi/profiles/survey/1.0/objects/extensions/emotion-today-survey-info": [
          { "id": "...", "timestamp": "...", "items-info": [{ /* AIDT 리커트 메타 */ }] }
        ]
      }
    }
  },
  "result": {
    "extensions": {
      "http://aidtbook.kr/xapi/profiles/survey/1.0/results/extensions/emotion-today-survey-detail": [
        { "id": "...", "item-detail": [{ "id": "...", "response-yn": true, "response": 4 }] }
      ],
      "https://dacheum.kr/xapi/extension/emotion-quick-attend": {
        "comment": "오늘 기분 최고!",
        "emoji_code": "smile_xl",
        "streak_days": 7
      }
    }
  }
}
```

---

## 9. 개발자 체크리스트

### Backend 작업 (Phase 1·2 기준)
- [ ] `lib/xapi/common.js`
  - [ ] `EXT` 객체 URL을 AIDT 표준으로 정정
  - [ ] `VERB` 객체에 AIDT 표준 영역별 URL 옵션 추가 (또는 builder 별 override 패턴)
  - [ ] `CONTENT_TYPE_MAP`/`ASSESSMENT_TYPE_MAP`/`QUESTION_TYPE_MAP`을 AIDT 단문자 코드(E/I/A/V/IM/T/P/Z 등)로 매핑
  - [ ] `BOARD_TYPE_MAP`(C/G/E), `OBJECTIVE_TYPE_MAP`(S/D/E) 신규
  - [ ] `makeActivity()` 의 `definition.type` URL 경로 `activities/` → `activity-type/`
  - [ ] timestamp `+00:00` 변환 헬퍼 (옵션)
- [ ] `lib/xapi/builders/*.js` 10개 파일 리팩토링 — §5.2-1 매트릭스 참조
  - [ ] media: audio-info/video-info + audio-detail/video-detail
  - [ ] assessment: verb 통일(submitted), assessment-info(items-info), assessment-detail
  - [ ] assignment: object='assignment', gav-assignment/fin-assignment
  - [ ] navigation: object 4분기(image/document/practice/etc-content) + *-info
  - [ ] objective: verb 통일(set), objective-detail(type/content/timestamp/revision-cnt/visit-cnt/completion)
  - [ ] query: object 2분기(keyword/question) + search-detail/ask-detail
  - [ ] social: 모델 전환 - 집계 어댑터 신설(aggregateSocialStatements)
  - [ ] survey: object 3분기(comprehension/emotion/emotion-today) + 리커트 메타
  - [ ] annotation: verb 'made', annotation-detail(콘텐츠 단위 누적)
  - [ ] teaching: object 2분기(feedback/class) + feedback-info/class-info
- [ ] `lib/xapi/spool.js`
  - [ ] enqueue에 `statement_id`(xAPI UUID) 컬럼 보강
  - [ ] dedup 검사 (statement_id 중복 INSERT 방지)
- [ ] `db/schema.js`
  - [ ] `xapi_statement_spool.statement_id TEXT` 컬럼 + 인덱스 추가
  - [ ] (선택) Phase 2 — `objective_revisions` 테이블 (revision-cnt 누적용)
  - [ ] (선택) Phase 2 — `social_aggregation_cursor` (집계 마지막 송신 시각)
- [ ] (Phase 2 선택) 신규 라우터 호출처 추가 — social 집계, objective set, 알림장(teaching/social)
- [ ] (Phase 3) `lib/xapi/aidt-transmitter.js`, `lib/xapi/aidt-scheduler.js` 신설
- [ ] (Phase 3) 환경변수 운영 및 관리자 모니터 UI

### Frontend 작업
- 본 작업은 백엔드/데이터 구조 정비 → **Frontend 작업 없음**.
- Phase 4 (동의 화면)에서만 Frontend 작업 필요.

### 시드 데이터 보강
- [ ] 신규 builder의 정상 동작 확인용 시드 시나리오 추가 (`scripts/seed/aidt-xapi-samples.js`)
  - 각 영역별 1건씩 spool에 INSERT → JSON Schema validator 통과 확인

---

## 10. 검증 시나리오

### 10.1 단위 검증
1. **JSON Schema validator** (`scripts/validate-xapi.js` 신설):
   - 입력: KERIS 별첨 `DATA_API_007 xAPI JSON Schema` 파일
   - 출력: spool 최근 N건의 statement_json 각각에 대한 통과/실패 + 오류 위치
2. **builder unit test** (`tests/xapi/*.test.js`):
   - 각 builder에 더미 payload → 반환 statement가 schema 통과

### 10.2 회귀 검증
3. **기존 라우터 영향 없음**:
   - `routes/exam.js`(시험 제출), `routes/homework.js`(과제 제출·채점), `routes/lesson.js`(수업 열람·미디어), `routes/self-learn.js`(오늘의 학습·진단), `routes/growth.js`(감정설문·게이미피케이션) E2E 시나리오 — 응답 200, learning_logs INSERT, spool INSERT 모두 정상
   - 다채움 내부 LRS 대시보드 정상 표시

### 10.3 데이터 정합성 검증
4. **다채움 고유 데이터 보존**:
   - 마일리지 적립 → spool statement에 다채움 namespace extension 포함
   - 갤러리 승인 → teaching feedback statement에 approval-status 포함
   - CBT 이탈 감지 → assessment statement에 cbt-tab-switch 포함
5. **표준체계 ID 일관성**:
   - `std-resolver.js` 출력의 std_ids·codes·ancestor_union이 statement에 정확히 반영
   - `lrs_std_node_stats` 조상체인 누적 정상

### 10.4 (Phase 3) 송신 검증
6. **AIDT sandbox 송신 테스트**:
   - `transmitBatch([...50건])` → KERIS sandbox 응답 `code: "00000"` 확인
   - 의도적 1건 오류 statement 포함 → `list_error[]`에 해당 index 응답 확인
   - 실패 statement만 재전송 → 성공 확인
7. **chunked transfer-encoding 정합성**:
   - 송신 raw payload를 Wireshark 또는 mock server로 캡처 → hex chunk-size + CRLF 형식 검증

---

## 11. 다음 단계 (PM 진행 권장)

### 11.1 사용자 의사결정 요청 항목
1. **Phase 선택**: A안(Phase 1) / B안(Phase 1+2 — 권고) / C안(Phase 1+2+3) / D안(Phase 1+2+3+4)
2. **이중 트랙 vs 단일 트랙**: §7.1 - learning_logs와 xapi_statement_spool를 이중으로 유지할지, 단일 통합할지 (이중 권고)
3. **AIDT actor.account.name UUID 정책**: 다채움 자체 UUID v5 송신 후 KERIS 측 매핑에 위임할지, KERIS 발급 UUID 수신 후 사용할지 (KERIS 협의 필요)
4. **chunked 송신 구현 방식**: Node.js 표준 `http` 모듈 사용 / 명시적 socket 제어 / 외부 라이브러리(`undici` 등) — Phase 3 진입 시 결정
5. **다채움 namespace extension의 송신 여부**: KERIS가 다채움 namespace를 수용하는지 사전 확인 후 결정 (대안: 다채움 namespace는 별도 사내 LRS에만 보관, AIDT에는 표준 영역만 송신)

### 11.2 진행 권고
1. PM이 사용자에게 §6 옵션 제안 → 선택 수령
2. **B안 선택 시**:
   - Backend opus → Phase 1 구현 (URL·verb·코드 정정)
   - Backend opus → Phase 2 builder별 리팩토링 (병렬 가능: media+assessment, navigation+objective, query+annotation+teaching, social+survey)
   - PM + UI 디자이너 더블체크 — 본 작업은 Backend 중심이므로 디자이너 검수는 §11.1-3·5 의 정책 결정 화면(있다면)으로 한정
   - 학생·교사 테스터 E2E → 다채움 내부 기능 회귀 없는지 확인
   - 도메인 전문가(opus, 본 에이전트) → JSON Schema validator 출력 검수
   - 감리 opus → 본 계획서 vs 구현 대조 → OK/REWORK
   - commit

### 11.3 후속 차수 (B안 완료 후)
- Phase 3 (전송 어댑터·스케줄러) — KERIS 운영 등록 완료 후 별도 차수
- Phase 4 (동의·마스킹·감사) — 운영 출시 직전

---

## 부록 A. AIDT 표준 URL 매핑 표 (Phase 1·2 구현 참조)

### A.1 verb URL
```
http://aidtbook.kr/xapi/profiles/media/1.0/verbs/played
http://aidtbook.kr/xapi/profiles/assessment/1.0/verbs/submitted
http://aidtbook.kr/xapi/profiles/assignment/1.0/verbs/gave
http://aidtbook.kr/xapi/profiles/assignment/1.0/verbs/finished
http://aidtbook.kr/xapi/profiles/navigation/1.0/verbs/viewed
http://aidtbook.kr/xapi/profiles/navigation/1.0/verbs/read
http://aidtbook.kr/xapi/profiles/navigation/1.0/verbs/did
http://aidtbook.kr/xapi/profiles/navigation/1.0/verbs/learned
http://aidtbook.kr/xapi/profiles/objective/1.0/verbs/set
http://aidtbook.kr/xapi/profiles/query/1.0/verbs/searched
http://aidtbook.kr/xapi/profiles/query/1.0/verbs/asked
http://aidtbook.kr/xapi/profiles/social-learning/1.0/verbs/participated
http://aidtbook.kr/xapi/profiles/survey/1.0/verbs/submitted
http://aidtbook.kr/xapi/profiles/annotation/1.0/verbs/made
http://aidtbook.kr/xapi/profiles/teaching/1.0/verbs/gave
http://aidtbook.kr/xapi/profiles/teaching/1.0/verbs/reorganized
```

### A.2 activity-type URL
```
http://aidtbook.kr/xapi/activity-type/media
http://aidtbook.kr/xapi/activity-type/assessment
http://aidtbook.kr/xapi/activity-type/assignment
http://aidtbook.kr/xapi/activity-type/image
http://aidtbook.kr/xapi/activity-type/document
http://aidtbook.kr/xapi/activity-type/practice
http://aidtbook.kr/xapi/activity-type/etc-content
http://aidtbook.kr/xapi/activity-type/objective
http://aidtbook.kr/xapi/activity-type/keyword
http://aidtbook.kr/xapi/activity-type/question
http://aidtbook.kr/xapi/activity-type/social-learning
http://aidtbook.kr/xapi/activity-type/comprehension-survey
http://aidtbook.kr/xapi/activity-type/emotion-survey
http://aidtbook.kr/xapi/activity-type/emotion-today-survey
http://aidtbook.kr/xapi/activity-type/annotation
http://aidtbook.kr/xapi/activity-type/feedback
http://aidtbook.kr/xapi/activity-type/class
```

### A.3 object extension URL (정보 메타 — definition.extensions)
```
…/profiles/media/1.0/objects/extensions/audio-info
…/profiles/media/1.0/objects/extensions/video-info
…/profiles/assessment/1.0/objects/extensions/assessment-info
…/profiles/assignment/1.0/objects/extensions/assignment-info
…/profiles/navigation/1.0/objects/extensions/image-info
…/profiles/navigation/1.0/objects/extensions/document-info
…/profiles/navigation/1.0/objects/extensions/practice-info
…/profiles/navigation/1.0/objects/extensions/etc-content-info
…/profiles/query/1.0/objects/extensions/keyword-info
…/profiles/social-learning/1.0/objects/extensions/board-info
…/profiles/survey/1.0/objects/extensions/comprehension-survey-info
…/profiles/survey/1.0/objects/extensions/emotion-survey-info
…/profiles/survey/1.0/objects/extensions/emotion-today-survey-info
…/profiles/teaching/1.0/objects/extensions/feedback-info
…/profiles/teaching/1.0/objects/extensions/class-info
```

### A.4 result extension URL (결과 detail — result.extensions)
```
…/profiles/media/1.0/results/extensions/audio-detail
…/profiles/media/1.0/results/extensions/video-detail
…/profiles/assessment/1.0/results/extensions/assessment-detail
…/profiles/assignment/1.0/results/extensions/gav-assignment        ← 교사
…/profiles/assignment/1.0/results/extensions/fin-assignment        ← 학생
…/profiles/objective/1.0/results/extensions/objective-detail
…/profiles/query/1.0/results/extensions/search-detail
…/profiles/query/1.0/results/extensions/ask-detail
…/profiles/social-learning/1.0/results/extensions/social-learning-detail
…/profiles/survey/1.0/results/extensions/comprehension-survey-detail
…/profiles/survey/1.0/results/extensions/emotion-survey-detail
…/profiles/survey/1.0/results/extensions/emotion-today-survey-detail
…/profiles/annotation/1.0/results/extensions/annotation-detail
```

### A.5 context extension URL (공통)
```
http://aidtbook.kr/xapi/profiles/cmn/1.0/contexts/extensions/partner-id
```

---

## 부록 B. 영역별 statement 골격 (Phase 2 구현 가이드)

각 영역별 reference 골격은 PDF 28~90쪽 예시를 참조. 다채움 builder에서 출력해야 할 최소 구조는 본 계획서 §3.2·§5.2-1을 참조하여 구현. 본 문서에 모든 영역의 전체 골격을 반복하면 분량이 과도해지므로, 영역별 작업 진입 시 PDF의 해당 페이지를 함께 열어 reference로 사용.

페이지 인덱스:
- Media: 29~33쪽
- Assessment: 35~41쪽
- Assignment: 42~45쪽
- Navigation: 46~55쪽
- Objective: 56~58쪽
- Query: 59~64쪽
- Social-Learning: 65~68쪽
- Survey: 69~80쪽
- Annotation: 81~84쪽
- Teaching: 85~90쪽

---

> **본 계획서 검토 후 사용자가 Phase를 선택하면, 해당 범위만큼 Backend opus를 호출하여 구현을 시작합니다. 본 작업은 코드 수정을 일체 포함하지 않은 분석/계획 단계이며, 실 구현은 별도 차수로 진행됩니다.**
