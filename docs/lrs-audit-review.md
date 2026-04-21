# 다채움 LRS Phase 3 코드 감리 보고서

- 감리 대상: DB 계층(`db/schema.js`, `db/learning-log-helper.js`, `db/lrs.js`, `db/lrs-aggregate.js`), API(`routes/lrs.js`), 서비스 로거(`routes/{attendance,board,content,homework,exam,lesson,survey}.js`, `lib/log-context.js`), UI(`public/lrs/index.html`, `public/css/lrs-tokens.css`), 시드(`scripts/seed-lrs-realistic.js`).
- 감리 방법: 정적 코드 리뷰 (실행/수정 없음)
- 발굴 이슈 수: **23개** (Critical 5 / Major 11 / Minor 7)

## 요약(Executive Summary)

| 분류 | 건수 | 비고 |
|---|---|---|
| Critical | 5 | 인증된 XSS, 권한 우회 가능 엔드포인트, 존재하지 않는 컬럼 참조, 집계 unique_users 오카운팅 버그, dateRangeWhere 입력검증 누락 |
| Major | 11 | N+1 쿼리, 레거시 스키마 잔존, CSRF 부재, 에러 응답 일관성, trace id 부재, `result_duration` 파싱의 ISO 8601 미지원, Self-learn 라우트 logContext 미사용, 세션 end 동시성 버그 |
| Minor | 7 | 매직넘버, 중복 라우트 로직, 비일관 네이밍, 응답 shape 불일치(UI와 계약 어긋남), preparedStmt 캐시 테스트 어려움 |

---

## Critical

### C-1. UI에서 사용자 제어 값을 `innerHTML`로 주입 — Stored XSS 경로
- 위치: `public/lrs/index.html:272-281`, `:366-375`, `:389-400`, `:591-603`, `:525-529`
- 문제: 서버 응답(`w.achievement_code`, `w.name`, `w.reason`, `student.last_active`, `student.reason`, 메뉴 `it.label`) 을 별도 escape 없이 template literal → `innerHTML`로 주입. 특히 `learning_logs.metadata`(`post_create`, 설문 응답 등 사용자 입력 데이터)가 경유하는 경고/드로어 경로에서 악의적 학생이 `display_name`, `reason`(서버가 확장 시)에 `<script>` 삽입 시 교사 브라우저에서 실행됨. `w.user_id` 값을 `onclick` 인라인 스트링에 직접 보간(`onclick="LRS.teacherAction('message','${w.user_id||w.id||''}')"`)하므로, id 위치에 `');alert(1);//` 같은 값이 들어올 경우 JS 인젝션 성립.
  또한 `openDrilldown(${JSON.stringify(w).replace(/"/g,'&quot;')})` — JSON.stringify는 `<`,`&` 등을 이스케이프하지 않으므로 같은 경로.
- 수정 제안:
```js
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// 사용
`<h3>${esc(w.name||w.student_name||('학생 #'+(w.user_id||'?')))}</h3>`
// onclick 대신 addEventListener + dataset
`<button data-uid="${esc(w.user_id||'')}" data-kind="message">메시지</button>`
// 그리고 bind 단계에서 querySelectorAll('[data-kind]').forEach(b => b.onclick = ...)
```

### C-2. `/api/lrs/statements/:id` — 타인 Statement 무권한 열람
- 위치: `routes/lrs.js:204-214`
- 문제: `requireAuth`만 통과하면 어떤 사용자든 임의 id의 `learning_logs` 상세(+ `statement_json`, `metadata`)를 조회할 수 있음. `canViewUser()` 가드 누락. LRS statement는 성적·성취·세션ID 등 민감 정보 보유.
- 수정 제안:
```js
const stmt = db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(parseInt(req.params.id));
if (!stmt) return res.status(404).json({...});
if (!canViewUser(req, stmt.user_id)) return res.status(403).json({ success:false, message:'권한이 없습니다.' });
```

### C-3. `/api/lrs/content/:contentId` — 권한 없음 + `/statements` / `/dataset-coverage` 관리자 전용 데이터 노출
- 위치: `routes/lrs.js:158-178`, `:181-201`, `:271-290`
- 문제: 학생 계정이 전체 콘텐츠의 `recentViewers`(다른 학생 이름·최근 시청 시각), 전체 statements 목록(`display_name` join), 전체 사용자 수 통계를 조회할 수 있음. LRS 문서 §4(프라이버시 정책)에 배치되지 않아야 할 데이터.
- 수정 제안: `req.user.role === 'teacher' || 'admin'` 가드를 셋 모두에 추가. 학생 본인 활동만 필요한 경우 `WHERE user_id = req.user.id` 필터 추가.

### C-4. `learning_logs` 스키마의 레거시 컬럼(`activity_id`, `result`, `duration`)과 Phase 2 컬럼이 공존 — 데이터 분기 발생
- 위치: `db/schema.js:430-444`, `db/lrs.js:82-100`, `db/lrs-aggregate.js:28-53`
- 문제: 테이블 정의(`schema.js:430-444`)에는 레거시 `activity_id INTEGER`, `result TEXT`, `duration INTEGER` 컬럼만 존재. Phase 2 컬럼(`target_type`, `target_id`, `source_service`, `duration_sec`, `result_score`, `result_success`, `subject_code`, ... )은 초기 CREATE 블록에 없고 어딘가의 ALTER 마이그레이션으로만 추가됨(시드의 `PRAGMA table_info` 방어코드로 확인). 반면 `db/lrs.js:82` `getDashboardStats`는 여전히 구 컬럼 `duration`을 `SUM` 하고, 새 로거(`learning-log-helper.js`)는 `duration_sec`에만 기록 → **같은 유저의 시간이 두 곳으로 쪼개져 대시보드 합계가 틀림**.
- 수정 제안:
  1) `schema.js`의 CREATE 블록을 Phase 2 최종 컬럼으로 업데이트하여 신규 DB 생성 시에도 일관되도록 하고,
  2) `db/lrs.js:82,87,91,97`의 `SUM(duration)` → `SUM(COALESCE(duration_sec, duration, 0))`로 통일,
  3) 별도 1회성 백필 스크립트 `UPDATE learning_logs SET duration_sec=duration WHERE duration_sec IS NULL AND duration IS NOT NULL` 실행.

### C-5. `unique_users` 집계 누적 버그 — 값이 무한 증가
- 위치: `db/learning-log-helper.js:46-56`, `:84-94`, `:96-106`, `:71-83`
- 문제: UPSERT 시 `unique_users = unique_users + excluded.unique_users` 형태. `checkDailyUser` 등은 "오늘/전체 기간"의 중복을 보지만 `lrs_class_summary`, `lrs_service_stats`, `lrs_content_summary`처럼 기간 개념 없는 누적 테이블의 경우 "유저가 처음 활동한 날(=isNewClassUser=1)"이 클래스 변경, 서비스 재접속 등으로 여러 번 1로 계산될 수 있음. 특히 `upsertDaily`는 날짜가 바뀌면 새 row(UNIQUE (date, type, svc, class))로 들어가므로 `isNewDailyUser` 계산이 "오늘 날짜 기준"인데 INSERT 시 `unique_users=1`로 세팅되어 항상 1씩만 추가되지만, UPDATE 분기에서 `+ excluded.unique_users`가 **이미 INSERT된 행에만 들어오므로 동일 유저가 같은 날 재활동 시 `excluded.unique_users=0`가 되어 옳다** — 하지만 `checkDailyUser` 쿼리는 UPSERT **이전** 에 실행되지만 같은 `logLearningActivity` 트랜잭션으로 감싸지 않아, 동시 두 요청에서 둘 다 `isNewDailyUser=1`이 나오고 둘 다 `unique_users += 1` 실행 → **경쟁 상태**. `lrs_content_summary`는 더 심각: `view_count + complete_count + 1`을 분모로 사용하지만 이전 avg_score를 `view_count + complete_count`로 가중평균하므로 실제 집계 분모와 맞지 않아 수치가 점점 왜곡됨.
- 수정 제안:
```js
// (a) logLearningActivity 전체를 db.transaction 으로 감싼다
const runLog = db.transaction((payload) => { /* existing body */ });
// (b) unique_users 업데이트는 lrs_user_summary 의 INSERT OR IGNORE 결과(changes)를 보고 1/0 판정
const ret = stmts.ensureUserActivity.run(userId, activityType); // INSERT OR IGNORE
const isNewUserActivity = ret.changes > 0 ? 1 : 0;
// 이후 content/class/service 도 동일하게 first-seen sentinel 테이블로 판정
```

---

## Major

### M-1. 존재하지 않는 `users.parent_id` 컬럼 참조 — 학부모 대시보드 무조건 403
- 위치: `routes/lrs.js:706`
- 문제: `"SELECT 1 FROM users WHERE id = ? AND parent_id = ?"` — `users` 테이블 스키마(`db/schema.js:7-26`)에 `parent_id` 컬럼이 없음. try/catch로 삼켜져 `allowed=false`가 유지되므로 학부모 전체 기능이 사일런트로 망가짐.
- 수정 제안: 관계 테이블을 별도 도입하거나(`parent_child_rels(parent_id, child_id)`), 실제 `users`에 컬럼 추가 후 `schema.js`에 ALTER 포함. 현재 코드에서 join 쿼리 리네임 권장.

### M-2. `rebuild-aggregates` — 학습 데이터가 실운영 중일 때 블로킹 DELETE→INSERT
- 위치: `db/lrs-aggregate.js:9-153`, `routes/lrs.js:480-491`
- 문제: 단일 트랜잭션으로 `DELETE … ; INSERT SELECT …` 을 7개 집계 테이블에 반복. `learning_logs`가 커질수록(시드만 10만건) 수 초~분 동안 write 락. 재빌드 중 `/api/lrs/log` 가 SQLITE_BUSY로 실패.
- 수정 제안: 배치로 `PRAGMA busy_timeout=30000` + 스테이징 테이블 후 swap (`CREATE TABLE lrs_daily_stats_new AS SELECT …; DROP TABLE lrs_daily_stats; ALTER TABLE lrs_daily_stats_new RENAME TO lrs_daily_stats;`). 또한 API 레벨에서 큐잉(이미 진행중이면 409).

### M-3. `/api/lrs/warnings/:classId` — 클래스당 N+1 쿼리, 멤버 40명에 4 쿼리씩 = 160쿼리
- 위치: `routes/lrs.js:817-893`
- 문제: 각 멤버마다 4번의 prepare().run (최근활동, julianday, 최근10건, weak achievements). 40명 학급이면 160회 개별 쿼리. 단일 GROUP BY로 풀어낼 수 있음.
- 수정 제안:
```sql
-- inactive: 하나의 쿼리로
SELECT u.id, u.display_name, MAX(ll.created_at) AS last_at,
       CAST(julianday('now') - julianday(MAX(ll.created_at)) AS INTEGER) AS days_inactive
FROM class_members cm JOIN users u ON u.id=cm.user_id
LEFT JOIN learning_logs ll ON ll.user_id=u.id
WHERE cm.class_id=? AND (cm.role='student' OR u.role='student')
GROUP BY u.id HAVING days_inactive>=3 OR last_at IS NULL;
```
연속 오답/약점도 유사하게 윈도우 함수(`ROW_NUMBER()`)로 단일 쿼리 가능.

### M-4. `result_duration`의 ISO 8601 파싱이 `PT…S` 포맷에만 국한
- 위치: `routes/lrs.js:385,466,719,797` (+ `lrs-aggregate.js:36,48,127`)
- 문제: `CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER)` — `PT5M` / `PT1H30M` / `PT30.5S` 같은 표준 Duration은 0으로 파싱됨. xapi ingest(`/xapi/statements`)로 외부 LRS가 쏜 `PT1M30S` 전부 손실.
- 수정 제안: `duration_sec` 를 단일 소스로 정하고(로거에서 이미 계산), SQL 에서는 `duration_sec` 만 집계. `result_duration`은 display용 문자열로만 보관. 또는 INGEST 단계에서 Duration → 초 변환 (작은 util 함수) 후 `duration_sec` 채우기.

### M-5. CSRF 보호 완전 부재 — `/api/lrs/log`, `/rebuild-aggregates`, `/session/*` 모두 쿠키 세션 사용
- 위치: 전 라우트. `routes/lrs.js` 어디에도 csrf 미들웨어 없음. `fetch(..., { credentials:'include' })` 기반.
- 문제: 외부 사이트가 교사 세션으로 `POST /api/lrs/rebuild-aggregates` 강제 실행 가능 (관리자 한정이지만 관리자가 공격 페이지를 열면 전체 집계 파괴). 악의적 링크 클릭으로 학생이 자기 계정에 임의 statement 주입(`/log`) 가능 → 성취 데이터 위조.
- 수정 제안: `csurf` 또는 double-submit 쿠키 도입. 변경계 라우트(POST/PUT/DELETE)에 `SameSite=Strict` + CSRF 토큰 헤더 검증. 최소한 `Origin` 헤더 검사 미들웨어 추가.

### M-6. `/api/lrs/log` — 클라이언트 임의 `result_score`, `result_success`, `achievement_code` 주입 가능
- 위치: `routes/lrs.js:79-90`, `db/lrs.js:5-61`
- 문제: `lrsDb.logActivity(req.user.id, req.body)` 가 body 전체를 pass-through. 학생이 `{activity_type:'exam_complete', verb:'completed', result_score:1.0, result_success:true, achievement_code:'9수01-01'}` 를 POST 하면 `lrs_achievement_stats.avg_score` 자동 상승 + 성장 목표 진행률 증가 + 포트폴리오 등재(`learning-log-helper.js:348-376`).
- 수정 제안: 학생용 `/log`는 화이트리스트된 activity_type만 허용하고 score 필드 무시. 점수가 수반되는 활동은 오직 서비스 라우트(exam, homework)에서만 서버측 계산으로 로깅.

### M-7. `self-learn.js`는 logLearningActivity 호출하나 `extractLogContext` 미사용
- 위치: `routes/self-learn.js:6` (require만 있음 — helper만 import). self-learn 라우트는 확인 필요.
- 문제: self-learn 은 "스스로채움" 서비스로 세션/디바이스 필드가 가장 중요한 서비스인데 `log-context` 헬퍼를 사용하지 않아 device/platform/session이 전부 null로 저장됨. Phase 2 구조화 로그의 의도와 어긋남.
- 수정 제안: self-learn 의 모든 `logLearningActivity({...})` 호출에 `...extractLogContext(req)` 스프레드 추가.

### M-8. `session/end` 경쟁 상태 & 권한 체크 지연
- 위치: `routes/lrs.js:784-814`
- 문제: SELECT → 권한체크 → 집계 UPDATE가 3 쿼리로 분리되어 동일 세션에 대해 end 요청 2번이 겹칠 때 activity_count 가 double-summed. 또한 이미 `ended_at != null`인 세션을 다시 end 해도 오류 없이 재계산됨 — 악용 시 포트폴리오 횟수 중복.
- 수정 제안: 단일 UPDATE `… WHERE session_id=? AND user_id=? AND ended_at IS NULL` 후 `info.changes === 0`이면 404/409 반환.

### M-9. 에러 로깅에 trace/request id 없음 — 운영 디버깅 불가
- 위치: 거의 모든 `catch (err) { console.error(...) }`
- 문제: 학생이 "대시보드 안 떠요" 호소 시 어떤 요청의 로그인지 특정 불가. `session_id`, `user_id`, `path`, `method`, 요청 시각을 함께 찍어야 하고, 이상적으로는 `x-request-id`를 연동해야 함.
- 수정 제안: 최소 공통 미들웨어
```js
app.use((req,_,next)=>{ req.traceId = crypto.randomBytes(6).toString('hex'); next(); });
// 각 catch에서
console.error(`[LRS][${req.traceId}] ${req.method} ${req.path} user=${req.user?.id}`, err);
```
또는 `pino` 등 구조화 로거 도입.

### M-10. `subjects_touched` CSV 필드 — 무한 증가 + instr 오탐
- 위치: `db/learning-log-helper.js:122-138`
- 문제: `subjects_touched` 컬럼은 CSV 문자열로 과목을 누적. `instr(subjects_touched, excluded.subjects_touched)`는 `math-e` 가 이미 있어도 `math-e-2`를 서브스트링으로 매칭해 스킵(거짓 일치). 또한 무제한 append여서 1년 뒤 수백 바이트. `GROUP_CONCAT(DISTINCT subject_code)` 로 재집계되는 경로(rebuild)와 증분 경로의 형식이 달라 표현 불일치.
- 수정 제안: 별도 `lrs_user_subject_daily(user_id, stat_date, subject_code)` UNIQUE 테이블로 정규화, 또는 JSON array + `json_each` 로 중복 방지.

### M-11. `xapi/statements` INSERT가 `statement_json` 만 기록, 집계 미반영
- 위치: `routes/lrs.js:293-308`
- 문제: 직접 `db.prepare().run()` 으로 INSERT만 하고 `logLearningActivity` 경로를 타지 않음. 집계 테이블(`lrs_user_summary` 등) 동기화 누락. 결과적으로 외부 LRS 연동 statement가 대시보드·경고·포트폴리오에 전혀 반영되지 않음. 또한 `verb?.id || verb` 만 저장되어 `http://adlnet.gov/expapi/verbs/…` 전체 URL이 verb 컬럼에 들어감 — 다른 곳의 `verb='completed'` 단어 비교와 불일치.
- 수정 제안: `logLearningActivity({...})` 로 위임. verb URL → display 파싱 (`verb.display?.['ko-KR'] || verb.id.split('/').pop()`).

---

## Minor

### m-1. 하드코딩된 주당 목표(weeklyTarget=300), 성취 임계치 0.80/0.50
- 위치: `routes/lrs.js:580`, `db/learning-log-helper.js:155-161`, `db/lrs-aggregate.js:107-112`
- 문제: 교과/학년에 따라 달라져야 할 값이 매직넘버. 테스트 어려움.
- 수정: `lib/lrs-constants.js` 또는 `system_settings` 테이블로 외부화.

### m-2. `dateRangeWhere()` 에서 `from`/`to` 값 입력 검증 없음
- 위치: `routes/lrs.js:47-54`, `:31-33`
- 문제: 사용자 제공 `from='2024-01-01 OR 1=1'` 같은 문자열이 들어와도 parameter binding 덕에 SQL 인젝션은 차단되지만, `DATE(col) >= '...'` 비교가 항상 false/true 가 되어 의도치 않은 결과. 날짜 regex 검증 필요.
- 수정: `const DATE_RE=/^\d{4}-\d{2}-\d{2}$/; if(from && !DATE_RE.test(from)) return 400;`

### m-3. `routes/lrs.js:86` — `log error` 로그인데 다른 곳들은 `[LRS]` 프리픽스 일관
- 위치: `routes/lrs.js` 전반 `console.error('[LRS] …')` vs `console.error('[ATTENDANCE] …')` vs `[BOARD]` 등.
- 문제: 서비스 로거별 prefix가 제각각. 필터/파싱 규칙 일관화 필요.
- 수정: 공통 로거 유틸로 prefix=`[lrs.route]` 등 점 표기.

### m-4. UI 응답 shape 가정 오류 — `insights.data.summary` 등 존재하지 않는 경로
- 위치: `public/lrs/index.html:220-221`, `:294`, `:335`, `:388`, `:418`, `:450,455`, `:470`
- 문제: `/api/lrs/insights/:userId` 실제 응답은 `{ success, snapshot:{...}, weaknesses:[...] }` 인데 UI는 `insights.data.summary`, `insights.data.weak` 를 읽음 → 영구적으로 빈 카드가 노출됨. `achievement-progress`도 `{ standards, distribution }` 반환인데 UI는 `r.data` 로 접근. `warnings`는 `{ inactive, consecutiveWrong, weakAchievements }` 인데 UI는 단일 배열로 처리.
- 수정: 계약을 OpenAPI/문서로 고정하고 UI를 실제 응답 키에 맞추거나, 서버 응답에 `data` 래퍼를 표준화.

### m-5. Prepared Statement 캐시가 모듈 싱글턴 — 테스트 시 모킹 곤란
- 위치: `db/learning-log-helper.js:5-146`
- 문제: `_stmts`가 모듈 상단 let. 유닛 테스트에서 각 테스트마다 in-memory DB를 새로 만들어도 이전 stmt 객체가 닫힌 DB를 참조. 재초기화 함수 부재.
- 수정: `function resetStmts(){ _stmts = null; }` export 하여 테스트 hook 제공.

### m-6. `lrs-tokens.css` 와 `common-nav.css` 토큰 중복 위험
- 위치: `public/css/lrs-tokens.css:8-62` 와 기존 `common-nav.css`
- 문제: `--gray-*`, `--space-*`, `--radius-*`, `--font-sans`가 `common-nav.css`에 이미 정의되어 있을 경우 LRS 진입 시 덮어쓰기 → 다른 페이지 스타일 회귀 가능. 주석에는 "LRS 전용 --lrs-*" 라고 하지만 실제로는 `--gray-*` 도 정의됨.
- 수정: 전역 토큰은 common-nav.css에만 두고 lrs-tokens.css 는 `--lrs-*`, `--chart-*`, `--heat-*`, `--lvl-*` 만.

### m-7. 시드 스크립트가 `logLearningActivity` 경로를 우회하고 직접 INSERT
- 위치: `scripts/seed-lrs-realistic.js:196-376`, `rebuildAggregatesSafe()`
- 문제: 로거 경로(포트폴리오 자동 생성·성장 목표 자동 진행·세션 추적)를 스킵하고 raw INSERT 후 rebuild 만 수행. 운영 DB에서 실 로거가 만들어내는 파생 데이터와 시드 상태가 다름 → "실동작" 테스트 전제가 흐려짐.
- 수정: 시드도 `logLearningActivity({...})` 를 호출하되 `created_at` 오버라이드가 필요하면 helper에 `createdAtIso` 파라미터 추가.

---

## 추가 관찰 (수정 미권장이나 인지 필요)

- `db/lrs.js:70` — `WHERE created_at <= ? || ' 23:59:59'` 는 `?` 에 파라미터 `endDate` 가 concat되는 SQLite `||` 문자열 연결. 작동은 하지만 직관에 반함. `DATE(created_at) <= ?` 로 바꿀 것.
- `routes/lrs.js:337-340` — `escapeCell`이 CSV injection(`=cmd|`로 시작) 방어 미포함. Excel/LibreOffice에서 수식 실행 가능. 셀 시작이 `=,+,-,@` 이면 `\t` 또는 `'` prefix 권장.
- `routes/lrs.js:770` — `crypto.randomBytes(16).toString('hex')` = 32자 session_id. 다른 곳의 `sessionID.slice(0,40)` 와 길이 상이.
- `routes/lrs.js:331` — `parseInt(req.query.classId)` 결과가 `NaN`일 때 `canViewClass(req, NaN)`는 admin만 통과. 400 응답으로 명시 권장.
- UI: `setTimeout(...,0)` 으로 retry 버튼 바인딩(`index.html:160-161`) — 템플릿 문자열로 만든 HTML 을 innerHTML 하면 React/Vue 없이는 불가피한 패턴이나, 이벤트 위임(`addEventListener`)으로 바꾸면 더 견고.
- `computeAchievementLevel(attempts, avgScore)` 의 0.80 기준은 `avgScore` 가 0~1 스케일을 전제. `/xapi/statements` 로 들어온 `result.score.raw=85` 같은 0~100 값이 그대로 result_score로 들어가면 무조건 `상`으로 판정됨.

---

## 우선순위 요약 (처리 권고)

1. C-1(XSS), C-2/C-3(권한) — 베타테스트 전 즉시
2. M-5(CSRF), M-6(/log 점수 위조) — 실제 사용자 투입 전
3. C-4(스키마 정합성) — 추후 리포트 오차 누적 방지
4. C-5(unique_users) — rebuild 스케줄을 야간 크론으로 병행해 당장 완화
5. M-3(N+1) — 학급 40명 초과 시 즉시 체감
6. M-4, M-11 — 외부 xAPI 연동 시작 시점 전
7. 나머지 Major/Minor — Phase 3 안정화 스프린트

---

## 참고 파일 경로 (전 issue에서 참조)

- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\db\schema.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\db\learning-log-helper.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\db\lrs.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\db\lrs-aggregate.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\routes\lrs.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\routes\{attendance,board,content,homework,exam,lesson,survey,self-learn}.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\lib\log-context.js`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\public\lrs\index.html`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\public\css\lrs-tokens.css`
- `C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\scripts\seed-lrs-realistic.js`
