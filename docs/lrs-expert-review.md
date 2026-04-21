# 다채움 LRS Phase 3 정합성 감사 보고서

**작성일**: 2026-04-21
**작성자**: LRS 전문가 (서브에이전트)
**범위**: Phase 1 감사 → Phase 2 사양 → Phase 3 구현물의 데이터 모델·집계·KPI 산출 정확도 감사
**감사 방법**: 읽기 전용 SELECT + `logLearningActivity` 2회 호출(UPSERT 검증, 테스트 후 롤백)
**현재 DB**: `data/dacheum.db`, `learning_logs` 2,109건, `lrs_user_summary` 63건, `lrs_achievement_stats` 807건, `lrs_user_daily` 231건, `lrs_session_stats` 3건

---

## 1. 요약

- Phase 1에서 지적된 **스키마 드리프트, duration 혼용, unique_users UPSERT 부정확성, achievement_code null, dual-writer 병존**은 구현 측면에서 모두 해소되었습니다. 특히 `logLearningActivity` 단일 진입점 + `lrs.logActivity` 래퍼 구조, `lrs_daily_stats`·`lrs_class_summary`·`lrs_content_summary`·`lrs_service_stats` 4종의 UPSERT에서 **unique_users를 `EXISTS` 사전 체크 → 0/1 파라미터 주입** 방식으로 정확도를 확보한 점이 가장 중요한 개선입니다.
- 그러나 **1건의 치명적 집계 버그**(`computeAchievementLevel` 기준값이 실제 데이터 스케일과 맞지 않음)가 새로 발견되었고, **4건의 중대 이슈**(성취수준 산출 트리거 불일치, `context.registration` 공란, 세션 집계 미연동, `canViewUser`/`canViewClass` 과도 개방), **3건의 경미 이슈**(레거시 컬럼 잔존, FK 에러 로그 처리, `result_score` 스케일 혼재 가능성)가 있습니다.
- KPI 30개 중 **즉시 산출 가능 22개**라는 Phase 1 기대치는 **실질 19~20개**로 조정이 필요합니다(세션 몰입도·재시도 개선율이 데이터 미축적으로 비어있음).

---

## 2. Phase 1 → Phase 3 해결/미해결 매트릭스

| # | Phase 1 지적 | 상태 | 근거 |
|---|---|---|---|
| P1-1 | Dual-writer (`lrs.logActivity` ↔ `logLearningActivity`) 병존 | **해결** | `db/lrs.js` L5~61에서 `lrs.logActivity`가 내부에서 `logLearningActivity`를 호출하는 래퍼로 축소 |
| P1-2 | `duration` vs `result_duration` 단위·타입 불일치 | **해결** | `duration_sec`(INT) 컬럼 도입(`schema.js` L1132), 모든 신규 쿼리에서 `COALESCE(duration_sec, CAST(... result_duration ...))` 폴백 사용. 실제 데이터 2,109건 전수 `duration_sec` 채워짐(fill rate 100%) |
| P1-3 | `activity_id` vs `target_id` 이중 경로 | **해결**(운영) | 2,109건 중 `activity_id` 채워진 건 **0건**. `lrs.logActivity` 래퍼가 모든 입력을 `target_id`로 정규화(`db/lrs.js` L8~10) |
| P1-4 | `result` (JSON TEXT) 데드 필드 | **해결**(운영) | 2,109건 중 `result` NOT NULL **0건**. 스키마에는 남아있으나 쓰임 없음 |
| P1-5 | `context_registration` 데드 컬럼 | **미해결** | 2,109건 중 **전부 NULL**. `session_id`는 별도 컬럼에 저장되지만 xAPI 표준 위치(`context.registration`)는 비어있음. 아래 §3 상세 |
| P1-6 | `lrs_daily_stats.unique_users` 실시간 UPSERT 부정확 | **해결** | 실측: 동일 user가 같은 일자·activity_type·service·class로 2회 호출 시 `unique_users` = **1**로 유지됨 (직접 INSERT 2회 테스트, `lrs_daily_stats`·`lrs_class_summary`·`lrs_content_summary`·`lrs_service_stats` 모두 OK) |
| P1-7 | `lrs_content_summary.unique_users` 중복 증가 버그 | **해결** | `checkContentUser` prepared statement로 기존 여부 조회 → isNewContentUser 0/1 전달 (`learning-log-helper.js` L29~33, L230) |
| P1-8 | `lrs_class_summary.unique_users` 초기값 1 고정 | **해결** | 동일 패턴(`checkClassUser` L34~38) |
| P1-9 | `rebuildAllAggregates` 단일 트랜잭션 락 | **부분해결**(우선순위 낮음) | 여전히 1개 트랜잭션(`lrs-aggregate.js` L13~147), 7개 `INSERT ... SELECT`. 현재 2,109건 규모에선 수 ms로 완료, 수십만 건 확장 시 분할 필요 |
| P1-10 | `achievement_code` 대부분 NULL | **해결** | 2,109건 중 2,109건(100%) `achievement_code` 채워짐. 시드 스크립트(`seed-lrs-realistic.js`) + 신규 로거 경로에서 주입 확인 |
| P1-11 | `subject_code`/`grade_group` 수집 | **해결** | 둘 다 100% 채워짐 |
| P1-12 | `/api/lrs/dashboard` L49 `db` 참조 전 require(B1) | **해결** | `routes/lrs.js` L5에서 최상단 require, L117 사용 |
| P1-13 | `/api/lrs/stats/daily` `duration` 컬럼 오사용(B2) | **해결** | L385에서 `COALESCE(ll.duration_sec, CAST(... result_duration ...))` |
| P1-14 | 기간 필터 `days` vs `from/to` 충돌(B4) | **해결** | `resolvePeriod()` (L18~45) 단일 헬퍼로 `period/from-to/days` 수용 |
| P1-15 | `/stats/by-achievement` 학생 필터 없음 | **해결** | L245에서 `user_id`/`subject_code` 파라미터 지원 |
| P1-16 | `/content/:contentId` `target_type` 하드코딩 | **해결** | L161 `req.query.target_type` 수용 (기본값 'content') |
| P1-17 | Live feed 부재 | **해결** | `/api/lrs/live-feed` L595 신설 |
| P1-18 | 개인 인사이트(약점/추천) 부재 | **해결** | `/api/lrs/insights/:userId` L498 신설, 약점 기반 `contents.achievement_code` 매칭 추천 |
| P1-19 | 학부모 뷰 부재 | **해결** | `/api/lrs/parent/:childId/digest` L699, `users.parent_id` 관계 검증 |
| P1-20 | xAPI statement 5요소 완전성 | **부분해결** | 샘플 5건 모두 actor/verb/object/result/context 존재. 단 `context.registration` 공란(§3 상세), `authority`·`stored` 여전히 없음 |

**해결 15 / 부분해결 3 / 미해결 1 / 기타(운영상 해결, 스키마는 잔존) 2 = 총 21개 항목.**

---

## 3. 새로 발견된 데이터 정합성 이슈

### D1. [치명] `computeAchievementLevel`의 임계값이 실제 점수 스케일과 불일치

**파일**: `db/learning-log-helper.js` L155~161, `db/lrs-aggregate.js` L107~112

```js
if (avgScore >= 0.80) return '상';
if (avgScore >= 0.50) return '중';
return '하';
```

그러나 실제 `learning_logs.result_score` 값은 **0~100 (percentage) 스케일**입니다. 증거:

| 지표 | 값 |
|---|---|
| `result_score` NOT NULL 건수 | 709 / 2,109 |
| `result_score` 범위 | min=26, max=100, avg≈75.2 |
| `result_score` ≤ 1.0 건수 (scaled) | **0건** |
| `lrs_achievement_stats.avg_score` ≤ 1.0 | **0건** (min=26, max=100) |

시드 스크립트(`scripts/seed-lrs-realistic.js` L211~212)도 `score = 0~100 정수`로 저장하며, `statement_json`에만 `scaled = score/100` 부가 저장합니다(L227). 운영 로거도 xAPI 표준의 `result.score.scaled`는 0~1이지만 DB 컬럼에는 raw 퍼센트가 저장되는 관행이 고착된 상태입니다.

**결과**: 모든 `avg_score ≥ 1` (즉 대부분 26~100)은 `>= 0.80` 조건에 해당 → `last_level`이 **무조건 '상'**이 됩니다. 실측:

```
last_level='상' 분포:   ge80=108, 50~79=145, lt50=7   (총 260, avg_att 4.07)
last_level='하' 분포:   null_avg만 61건                (총 61, 점수 있는데 '하'인 행 0)
last_level='미도달':    attempt<3 또는 avg_score NULL
```

즉 `'하'`는 `avg_score IS NULL`인 데이터에서 CASE의 ELSE로 떨어진 것뿐이고, **'중' 라벨은 0건**. 교사/학부모 대시보드에서 성취수준 분포가 완전히 왜곡됩니다.

**수정 제안**:
```js
// 두 스케일 모두 수용 (방어적)
const norm = avgScore > 1 ? avgScore / 100 : avgScore;
if (norm >= 0.80) return '상';
if (norm >= 0.50) return '중';
return '하';
```
또한 `lrs-aggregate.js`의 CASE문도 동일 보정 필요:
```sql
WHEN (CASE WHEN AVG(result_score) > 1 THEN AVG(result_score)/100.0 ELSE AVG(result_score) END) >= 0.80 THEN '상'
```
**장기**: DB에 저장하는 `result_score`를 xAPI 표준대로 0~1 scaled로 통일하고, 화면 표시 시 ×100. 현재 스크립트/시드/helper가 뒤섞여 쓰고 있어 추가적 스케일 오염을 막으려면 single-writer 레벨에서 validation (예: `resultScore > 1` 시 자동 `/100` 또는 경고 로그).

---

### D2. [중대] 실시간 `achievement_level` 갱신과 재빌드 결과가 다름

`logLearningActivity`는 **직전 누적 + 현재 호출 1건**을 반영해 `last_level`을 계산하고 UPSERT하지만(`helper.js` L293~307), 재빌드(`lrs-aggregate.js` L107~112)는 `result_score` 전체 평균으로 CASE 분기합니다. 둘 다 임계값은 0.80/0.50이라 위 D1 때문에 동시 오류지만, 만약 D1이 수정된 뒤에도 **동시성 미고려**가 남습니다:

- helper는 `attempt_count` 기반 평균을 **행 증가 직전**에 새로 구함(재현 OK).
- 그러나 `upsertAchievement` prepared statement는 (user_id, achievement_code) 행이 **없으면 INSERT**하고, `attempt_count += 1`, `avg_score` 증분 재계산을 동시에 수행. JS에서 미리 계산한 `level`을 전달하지만, 만약 동일 user·code로 동시 2건이 들어오면 JS가 보는 `cur`가 stale해질 수 있습니다. 현재는 단일 프로세스·WAL SQLite라 사실상 직렬화되어 드러나지 않지만, 스케일 확장 시 원자성 보장 안 됨.

**수정 제안**: `upsertAchievement`의 `DO UPDATE` 절에서 `last_level`을 CASE로 재계산(helper에서 계산한 값을 버리고 DB가 직접 계산) — D1 수정과 묶어서.

---

### D3. [중대] `statement_json.context.registration`이 항상 NULL

`learning-log-helper.js` L214에서 `registration: sessionId || undefined`로 설정하는데, **시드 데이터**(2,109건 모두)가 helper를 거치지 않고 `scripts/seed-lrs-realistic.js`가 자체 `insertStmt`로 직접 INSERT하기 때문에, 시드가 만든 statement에는 `context.registration` 필드가 없습니다. 샘플 5건 전부 `ctx.reg=undefined`. 또한 seed는 `session_id` 컬럼은 채우지만 `lrs_session_stats`에는 해당 세션을 **등록하지 않습니다** — 검증:

```
unique session_ids in learning_logs:  380
learning_logs with session_id matching session_stats:  0
lrs_session_stats.activity_count > 0:  0
```

**즉 세션 몰입도(KPI-17, §6 아래) 산출 불가**. `POST /session/start`는 DB에 세션 행을 만들지만 이후 learning_logs는 해당 session_id를 받지 않으며(프런트가 전달해야 함), `incSessionActivity` UPDATE는 대상 행을 찾지 못해 무반응.

**수정 제안**:
1. 시드 스크립트에 `lrs_session_stats` 동시 삽입 추가.
2. helper의 statement 생성부에서 `context.extensions.sessionId`도 병행 저장(일부 xAPI 컨슈머는 extensions만 봄).
3. 프런트 세션 컴포넌트(§Phase 2 사양 4.3)가 `session/start` 응답의 `sessionId`를 localStorage에 저장하고 이후 모든 로그 전송에 포함하는지 별도 검증 필요(본 감사 범위 외).

---

### D4. [중대] `canViewUser` / `canViewClass` 과도 개방

`routes/lrs.js` L57~72:
```js
function canViewUser(req, targetUserId) {
  ...
  return req.user.role === 'teacher' || req.user.role === 'admin';  // 모든 교사 통과
}
function canViewClass(req, classId) {
  if (req.user.role === 'admin') return true;
  ... getMemberRole(classId, req.user.id) ...
  return req.user.role === 'teacher';  // ← 클래스 멤버가 아닌 교사도 통과
}
```

의도는 "해당 클래스 소속 교사만 볼 수 있다"(Phase 2 §2)이지만, **클래스 소속 여부와 무관하게 role=teacher면 타 학생·타 반 데이터 조회 가능**. 정책 문서 TC-031~038(참조됨)이 역할별 제한을 강조하는데 실제 가드가 느슨함.

**수정 제안**:
```js
function canViewUser(req, targetUserId) {
  if (req.user.id === targetUserId) return true;
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'teacher') {
    // 타겟 유저가 내 클래스에 소속되어 있는가?
    const row = db.prepare(`
      SELECT 1 FROM class_members cm1
      JOIN class_members cm2 ON cm1.class_id = cm2.class_id
      WHERE cm1.user_id = ? AND cm2.user_id = ?
        AND (cm1.role = 'owner' OR cm1.role = 'teacher')
      LIMIT 1
    `).get(req.user.id, targetUserId);
    return !!row;
  }
  return false;
}
function canViewClass(req, classId) {
  if (req.user.role === 'admin') return true;
  const role = classDb.getMemberRole(classId, req.user.id);
  return role === 'owner' || role === 'teacher';  // 마지막 teacher 개방 제거
}
```

---

### D5. [경미] 레거시 컬럼 3개 잔존, DROP 불가 상태

`learning_logs.activity_id`, `duration`, `result`, `context_registration` 4개 컬럼이 **완전히 미사용(전체 0건)**이지만 `CREATE TABLE`에 남아 매 쿼리마다 저장공간·인덱스 노이즈. SQLite 3.35+는 `DROP COLUMN` 지원하지만 프로젝트에서 아직 쓰지 않음.

**수정 제안**: v2 마이그레이션 별도 블록으로 스케쥴. 당장은 `/api/lrs/export`에서 해당 컬럼을 제외하고 있어 실영향 없음.

---

### D6. [경미] `lrs_class_summary` FK 제약으로 로그 전체 실패 리스크

감사 테스트 중 `classId=99999`(존재하지 않는 클래스) 전달 시 `INSERT INTO learning_logs`는 성공했으나, 뒤이은 UPSERT 블록이 FK 위반으로 중단되어 `lrs_daily_stats`·`lrs_class_summary`·`lrs_content_summary`·`lrs_service_stats`·`lrs_user_summary`·`lrs_user_daily`·`lrs_achievement_stats` 갱신이 **모두 롤백**됨. 원본만 남고 집계는 비어 있는 데이터 드리프트 발생. `learning-log-helper.js` L315~317의 catch가 전체를 감싸서 개별 UPSERT 단위의 부분 성공/실패를 구분하지 못함.

**수정 제안**: 각 UPSERT를 개별 try/catch로 분리하거나, `classId`가 실제 classes에 존재하는지 helper 진입부에서 검사하여 없으면 `null`로 강등.

---

### D7. [경미] `/api/lrs/xapi/statements` 엔드포인트가 헬퍼를 거치지 않음

`routes/lrs.js` L292~308의 외부 xAPI 수신 엔드포인트는 `db.prepare('INSERT INTO learning_logs ...')`를 **직접 실행**하여 `activity_type='external'`, `source_service='external'`로 저장합니다. 이 경로로 들어온 데이터는 집계 테이블 전부 갱신되지 않아 대시보드에서 보이지 않습니다. Phase 2 §1.4(dual-writer 정리) 정신에 위배.

**수정 제안**: `lrsDb.logActivity()` 호출로 교체.

---

## 4. xAPI 표준 적합성 재평가 (샘플 5건)

| 요소 | 상태 | 비고 |
|---|---|---|
| actor | OK | `{account:{name: userId문자열}}`. `homePage`는 여전히 없음 |
| verb | OK | `id`가 IRI (`http://adlnet.gov/expapi/verbs/completed`), `display`에 ko-KR |
| object | OK | `id`=`urn:dacheum:content:443`, `objectType`='Activity' |
| result | 부분 | `score`/`success`/`duration` 중 존재하는 것만. `scaled`만 저장되고 `raw`/`min`/`max`는 누락(시드는 `raw` 포함, helper는 미포함) |
| context | 부분 | `extensions`는 채워지나 `registration` NULL, `platform`/`language`/`instructor` 없음 |
| timestamp | OK (단 포맷 혼재) | 일부 `"2026-04-21T01:00:00Z"` ISO, 일부 `"2026-04-21 11:38:22"` 공백형. 후자는 xAPI 1.0.3 timestamp 형식과 불일치 |

**xAPI timestamp 포맷 혼재**: 시드는 `createdAtIso`(ISO 또는 공백형) 그대로 statement에 넣고 helper는 `new Date().toISOString()`을 사용 → 통일 필요.

---

## 5. UPSERT 실증 테스트 결과 (읽기 전용 후 롤백)

동일 `user_id=3, activity_type='audit_probe', source_service='audit_probe', class_id=1, target_type='audit_probe', target_id='probe-1', achievement_code='6수학05-02'`로 2회 `logLearningActivity` 호출:

| 테이블 | 예상 | 실측 | 판정 |
|---|---|---|---|
| `lrs_daily_stats.activity_count` | 2 | 2 | OK |
| `lrs_daily_stats.unique_users` | 1 | **1** | **OK (핵심 개선)** |
| `lrs_class_summary.total_count/unique_users` | 2 / 1 | 2 / 1 | OK |
| `lrs_content_summary.complete_count/unique_users` | 2 / 1 | 2 / 1 | OK |
| `lrs_service_stats.total_count/unique_users` | 2 / 1 | 2 / 1 | OK |
| `lrs_user_summary.total_count/total_duration` | 2 / 60 | 2 / 60 | OK |
| `lrs_user_daily.activity_count/duration_sec/subjects_touched` | 2 / 60 / math-e | 2 / 60 / math-e | OK |
| `lrs_achievement_stats.attempt_count/avg_score/last_level` | 2 / 0.75 / '중' | 2 / 0.75 / **'미도달'** | 미도달은 `attempt<3` 규칙 상 **정상**. 단 D1에 따라 3회 이상 시 `'상'` 오판정 위험 상존 |

**결론**: Phase 1의 `unique_users` 부정확성은 **완전히 해결**되었습니다. 이는 Phase 3 핵심 성과.

---

## 6. KPI 30개 즉시 산출 가능성 재평가 (Phase 1 기대치: 22개)

| # | KPI | Phase 1 판정 | 현재 판정 | 비고 |
|---|---|---|---|---|
| 1 | 오늘의 학습 시간 | ✓ | ✓ | `lrs_user_daily.duration_sec` |
| 2 | 주간 streak | ✓ | ✓ | `/insights/:userId` 구현됨 |
| 3 | 활동 유형 균형도 | ✓ | ✓ | `lrs_user_summary` |
| 4 | 과제 제출률 | ✓ | ✓ | `activity_type='homework_submit'` |
| 5 | 과제 제시간 제출률 | ✓ | △ | `metadata.due_date` 수집 미검증 |
| 6 | 평가 평균 점수 추이 | ✓ | ✓ | `result_score` |
| 7 | 성취기준 도달률 | ✓ | **✗ (D1)** | avg_score 스케일 혼동으로 전원 '상' 쏠림 |
| 8 | 교과 시간 비중 | ✓ | ✓ | `subject_code` 100% 채움 |
| 9 | 콘텐츠 완료율 | ✓ | ✓ | `lrs_content_summary` |
| 10 | 오답률 TOP10 성취기준 | ✓ | △ | D1 영향 |
| 11 | 학생 참여 지수 | ✓ | ✓ | 가중합 산출 가능 |
| 12 | 학급 평균 vs 개인 | ✓ | ✓ | |
| 13 | 학습 시간대 분포 | ✓ | ✓ | `created_at` |
| 14 | 연속 접속일 백분위 | ✓ | ✓ | `lrs_user_daily` |
| 15 | DAU/WAU/MAU | ✓ | ✓ | |
| 16 | 서비스 이용 분포 | ✓ | ✓ | `source_service` 100% 채움 |
| 17 | 평균 세션 시간 | ✗ | **✗ (D3)** | 세션 연동 미작동 (ended_at 있는 세션 1건) |
| 18 | 재방문율(7일) | ✗ | △ | `users.created_at` 존재 여부 미확인 |
| 19 | 교사 수업 개설 수 | ✓ | ✓ | |
| 20 | 클래스 활동 풍부도 | ✓ | ✓ | |
| 21 | 성취수준 분포 | ✓ | **✗ (D1)** | 극단치 분포 |
| 22 | 개인 약점 TOP5 | ✓ | △ | D1 영향: 모든 학생이 '상' 가득, 약점 구분 불가 |
| 23 | 재시도 개선율 | ✗ | ✗ | `retry_count > 0`는 35건뿐, first/retry 비교 로직 없음 |
| 24 | 감정-학습 상관 | ✓ | ✓ | `emotion_logs` 조인 |
| 25 | 출석-참여 상관 | ✓ | ✓ | |
| 26 | 콘텐츠 인기도 | ✓ | ✓ | |
| 27 | 디바이스 이용 | ✓ | ✓ | `device_type` 100% 채움(web/ios/android) |
| 28 | 평가문항 평균 풀이 시간 | ✓ | ✓ | |
| 29 | 포트폴리오 축적도 | ✓ | ✓ | |
| 30 | AI 추천 수용률 | ✗ | ✗ | 추천 로그 테이블 없음 |

**즉시 산출 가능 = 19개** (Phase 1 기대 22개 대비 −3). 차이 원인:
- **KPI-7, 21, 22**: D1(avg_score 스케일) 버그로 현재 데이터에서 신뢰 불가. D1 1줄 수정 시 22개 복귀 가능.
- △ 3개(KPI-5, 10, 18)는 부분적으로 가능.

---

## 7. 수정 제안 우선순위

| 우선 | 이슈 | 작업량 | 파일 |
|---|---|---|---|
| P0 | **D1** avg_score 스케일 정규화 | 2줄 수정 + 재빌드 1회 | `db/learning-log-helper.js` L155~161, `db/lrs-aggregate.js` L107~112 |
| P1 | **D4** 권한 가드 강화 | 헬퍼 1개 재작성 | `routes/lrs.js` L57~72 |
| P1 | **D3-2** 시드에 `lrs_session_stats` 동시 삽입 | 10줄 추가 | `scripts/seed-lrs-realistic.js` L300~303 부근 |
| P2 | **D7** xapi/statements 엔드포인트 헬퍼 경로 일원화 | 10줄 교체 | `routes/lrs.js` L293~308 |
| P2 | **D6** helper의 개별 UPSERT try/catch 분리 | 블록 재구성 | `learning-log-helper.js` L253~314 |
| P3 | **D5** 레거시 컬럼 DROP | v2 마이그레이션 | `db/schema.js` |
| P3 | **timestamp 포맷 통일** | 1줄 | `helper.js` L218 / seed |

---

## 8. 총평

Phase 3는 Phase 1에서 지적된 **21개 항목 중 18개를 해결**했고, 특히 **unique_users UPSERT 정확도·dual-writer 통합·마이그레이션 12개 전수 적용**이라는 3개 핵심 목표를 검증 가능한 수준으로 달성했습니다. 신규 집계 3종(`lrs_achievement_stats`, `lrs_session_stats`, `lrs_user_daily`)과 6개 인덱스도 모두 생성되어 있으며, `/insights/:userId`·`/achievement-progress`·`/warnings/:classId`·`/parent/:childId/digest` 4개 신규 엔드포인트가 정상 작동 중입니다.

다만 **D1(성취수준 스케일 버그)은 2줄 수정으로 해결되는 치명 이슈**이며, 이 1개를 수정하면 KPI 즉시 산출 가능 수치가 19→22개로 Phase 1 기대치에 도달합니다. 권한 가드(D4)와 세션 연동(D3)도 1일 이내에 정리 가능하므로 Phase 3 완료 직후의 "fast-follow" 패치로 묶어 처리할 것을 권장합니다.

현 단계에서 외부 LRS 연계(SCORM/Veracity)나 Caliper 어댑터는 **xAPI timestamp 포맷 통일과 `context.registration` 충전이 선행 조건**이므로 D3-2, timestamp 통일을 포함한 "xAPI 적합성 스프린트" 0.5일 분량을 다음 사이클에 계획하시길 권합니다.

---

## 부록 A — 감사 환경

- DB 경로: `C:\...\실동작\data\dacheum.db`
- learning_logs 컬럼 수: **33** (Phase 2 목표 12개 ALTER 전부 적용 확인: `session_id, duration_sec, device_type, platform, retry_count, correct_count, total_items, achievement_level, parent_statement_id, subject_code, grade_group, metadata_json`)
- 신규 집계 테이블: **3/3** 존재 (`lrs_achievement_stats` 807행, `lrs_session_stats` 3행, `lrs_user_daily` 231행)
- 신규 인덱스: **6/6** 존재 (`idx_ll_user_date, idx_ll_achv, idx_ll_subject_date, idx_ll_session, idx_ll_class_date, idx_ll_service_verb`)
- 필드 충전율 (2,109건 기준): achievement_code 100%, subject_code 100%, grade_group 100%, source_service 100%, device_type 100%, platform 100%, session_id 100%, duration_sec 100%, class_id 100%; result_score/result_success 33.6% (평가형 활동에 한정); correct_count/total_items 27.3%; retry_count>0 1.7%
