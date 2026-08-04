// db/learning-log-helper.js
const db = require('./index');
// [W2-a] 점수 스케일·채점형 모집단 SSOT. 집계 테이블에 **정규화된 값만** 넣기 위해 쓴다.
//   과거 이 파일은 resultScore 를 원시값 그대로 집계에 흘려보냈다 → 0~1 과 0~100 이
//   같은 컬럼에 섞이고, 진도율(lesson_progress 0.5~1.0)이 '성취 점수'로 둔갑했다.
const { normScore, isScoredType } = require('../lib/lrs/score-scale');
const { isMasteryObserved, masteryRecomputeSql } = require('../lib/lrs/mastery-population');

// 학년 → 학교급 매핑 (growth-extended.js gradeToSchoolLevel 와 동일 규칙을 로컬 복제 — 순환참조 방지)
function gradeToSchoolLevel(grade) {
  const g = parseInt(grade, 10);
  if (!g || isNaN(g)) return null;
  if (g >= 1 && g <= 6) return 'elementary';
  if (g >= 7 && g <= 9) return 'middle';
  if (g >= 10 && g <= 12) return 'high';
  return null;
}

// ── Prepared Statements 캐시 (성능 최적화) ──
let _stmts = null;
function getStmts() {
  if (_stmts) return _stmts;
  _stmts = {
    insertLog: db.prepare(`
      INSERT INTO learning_logs (
        user_id, activity_type, target_type, target_id, class_id,
        verb, object_type, object_id, result_score, result_success,
        result_duration, source_service, achievement_code, metadata, statement_json,
        session_id, duration_sec, device_type, platform, retry_count,
        correct_count, total_items, achievement_level, parent_statement_id,
        subject_code, grade_group, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // ── 고유 사용자 체크용 EXISTS 쿼리 (UPSERT 전에 호출) ──
    checkDailyUser: db.prepare(`
      SELECT 1 FROM learning_logs
      WHERE user_id = ? AND activity_type = ? AND COALESCE(source_service,'') = ?
        AND COALESCE(class_id,0) = ? AND DATE(created_at) = DATE('now')
      LIMIT 1
    `),
    checkUserSum: db.prepare(`
      SELECT 1 FROM lrs_user_summary WHERE user_id = ? AND activity_type = ? LIMIT 1
    `),
    checkContentUser: db.prepare(`
      SELECT 1 FROM learning_logs
      WHERE user_id = ? AND target_type = ? AND target_id = ?
      LIMIT 1
    `),
    checkClassUser: db.prepare(`
      SELECT 1 FROM learning_logs
      WHERE user_id = ? AND class_id = ? AND activity_type = ?
      LIMIT 1
    `),
    checkServiceUser: db.prepare(`
      SELECT 1 FROM learning_logs
      WHERE user_id = ? AND source_service = ? AND verb = ?
      LIMIT 1
    `),
    // ── UPSERT문들 (unique_users를 파라미터로 전달) ──
    upsertDaily: db.prepare(`
      INSERT INTO lrs_daily_stats (stat_date, activity_type, source_service, class_id, activity_count, unique_users, avg_score, total_duration)
      VALUES (DATE('now'), ?, ?, ?, 1, ?, ?, COALESCE(?,0))
      ON CONFLICT(stat_date, activity_type, source_service, class_id)
      DO UPDATE SET
        activity_count = activity_count + 1,
        unique_users = unique_users + excluded.unique_users,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * activity_count + excluded.avg_score) / (activity_count + 1)
          ELSE avg_score END,
        total_duration = total_duration + COALESCE(excluded.total_duration, 0),
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertUser: db.prepare(`
      INSERT INTO lrs_user_summary (user_id, activity_type, total_count, total_duration, avg_score, last_activity_at)
      VALUES (?, ?, 1, COALESCE(?,0), ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, activity_type)
      DO UPDATE SET
        total_count = total_count + 1,
        total_duration = total_duration + COALESCE(excluded.total_duration, 0),
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * total_count + excluded.avg_score) / (total_count + 1)
          ELSE avg_score END,
        last_activity_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertContent: db.prepare(`
      INSERT INTO lrs_content_summary (target_type, target_id, view_count, complete_count, unique_users, avg_score)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_type, target_id)
      DO UPDATE SET
        view_count = view_count + excluded.view_count,
        complete_count = complete_count + excluded.complete_count,
        unique_users = unique_users + excluded.unique_users,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * (view_count + complete_count) + excluded.avg_score) / (view_count + complete_count + 1)
          ELSE avg_score END,
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertClass: db.prepare(`
      INSERT INTO lrs_class_summary (class_id, activity_type, total_count, unique_users, avg_score)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(class_id, activity_type)
      DO UPDATE SET
        total_count = total_count + 1,
        unique_users = unique_users + excluded.unique_users,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * total_count + excluded.avg_score) / (total_count + 1)
          ELSE avg_score END,
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertService: db.prepare(`
      INSERT INTO lrs_service_stats (source_service, verb, total_count, unique_users, avg_score)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(source_service, verb)
      DO UPDATE SET
        total_count = total_count + 1,
        unique_users = unique_users + excluded.unique_users,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * total_count + excluded.avg_score) / (total_count + 1)
          ELSE avg_score END,
        updated_at = CURRENT_TIMESTAMP
    `),
    // ── [W2-a] 성취 집계: 증분 누적을 버리고 **원천 재계산**으로 전환 ──
    //   과거: attempt_count+1 / avg=(avg*attempt+new)/(attempt+1) 식의 증분 UPSERT.
    //     · 가중치가 attempt_count 였는데 attempt_count 는 점수 없는 행까지 세고 있어
    //       평균이 조용히 표류했고,
    //     · 무엇보다 재집계 경로와 산식이 **따로** 정의돼 있어 재집계 한 번에
    //       2,344행의 도달/미도달이 뒤집혔다(실측).
    //   현재: lib/lrs/mastery-population.js 의 술어·집계식으로 해당 (user, code) 한 쌍만
    //     learning_logs 에서 재계산해 **절대값으로 덮어쓴다.**
    //     원본 INSERT 가 같은 트랜잭션 안에서 먼저 일어나므로 방금 들어온 로그도 자연히 포함된다.
    //     → 재집계 결과와 산술적으로 동일함이 구조적으로 보장된다(동기화 유지 불필요).
    recomputeAchievement: db.prepare(masteryRecomputeSql()),
    upsertAchievement: db.prepare(`
      INSERT INTO lrs_achievement_stats (user_id, achievement_code, subject_code, attempt_count, success_count, avg_score, level, last_level, last_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, achievement_code)
      DO UPDATE SET
        subject_code = COALESCE(excluded.subject_code, subject_code),
        attempt_count = excluded.attempt_count,
        success_count = excluded.success_count,
        avg_score = excluded.avg_score,
        level = excluded.level,
        last_level = excluded.last_level,
        last_attempt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertUserDaily: db.prepare(`
      INSERT INTO lrs_user_daily (user_id, stat_date, activity_count, duration_sec, avg_score, subjects_touched)
      VALUES (?, DATE('now'), 1, COALESCE(?,0), ?, ?)
      ON CONFLICT(user_id, stat_date)
      DO UPDATE SET
        activity_count = activity_count + 1,
        duration_sec = duration_sec + COALESCE(excluded.duration_sec, 0),
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * activity_count + excluded.avg_score) / (activity_count + 1)
          ELSE avg_score END,
        subjects_touched = CASE
          WHEN excluded.subjects_touched IS NULL OR excluded.subjects_touched = '' THEN subjects_touched
          WHEN subjects_touched IS NULL OR subjects_touched = '' THEN excluded.subjects_touched
          WHEN instr(subjects_touched, excluded.subjects_touched) > 0 THEN subjects_touched
          ELSE subjects_touched || ',' || excluded.subjects_touched
        END
    `),
    incSessionActivity: db.prepare(`
      UPDATE lrs_session_stats
      SET activity_count = activity_count + 1
      WHERE session_id = ?
    `)
  };
  return _stmts;
}

/**
 * 성취수준 계산 (규칙 기반):
 *   - computeAchievementLevel(attempts, avgScore)     — 시도 횟수 기반 호출 (레거시)
 *   - computeAchievementLevel(score, maxScore)        — 단일 점수 호출 (신규 시그니처)
 *
 * result_score는 0-100 또는 0-1 스케일이 혼재한다. 값 > 1이면 maxScore 대비 비율로 정규화한다.
 * 비율 기준: >= 0.80 → 상, >= 0.50 → 중, < 0.50 → 하, null → 미도달.
 *
 * 첫 번째 인자가 "시도 횟수"로 해석 가능한 상황(정수 ≥ 3이고 두 번째 인자가 0-1 스케일) 은
 * 레거시 호출로 간주해 시도 < 3이면 미도달을 반환한다.
 */
function computeAchievementLevel(a, b) {
  // 레거시: (attempts, avgScore) — attempts가 정수이고 avgScore <= 1
  const looksLegacy = (
    Number.isInteger(a) && a >= 0 && a <= 1000 &&
    (b == null || (typeof b === 'number' && b >= 0 && b <= 1))
  );
  // 실제로는 attempts가 0/1/2인 경우 미도달 분기만 필요. 다만 (score=3, maxScore=4) 같은 신규 호출도
  // 동일 패턴이라 구별 불가 → 우선 신규 시그니처 우선. 레거시 호출부는 attempts 체크 후 null 전달 패턴이라
  // 여기서는 항상 신규 시그니처로 처리한다.
  let score = a, maxScore = b;
  if (score == null) return '미도달';
  // 값이 > 1이면 0-100 스케일로 가정하고 maxScore(또는 100) 기준으로 정규화
  let ratio;
  if (typeof score !== 'number' || isNaN(score)) return '미도달';
  if (score > 1) {
    const m = (typeof maxScore === 'number' && maxScore > 0) ? maxScore : 100;
    ratio = score / m;
  } else {
    // 0-1 스케일로 간주
    ratio = score;
  }
  if (!isFinite(ratio)) return '미도달';
  if (ratio >= 0.80) return '상';
  if (ratio >= 0.50) return '중';
  return '하';
}

/**
 * ISO 8601 duration 파서: PT[n]H[n]M[n]S 전체 지원. 초 단위 정수 반환.
 * 지원되지 않는 형식이면 null.
 */
function parseIso8601Duration(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const mn = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + mn * 60 + s;
}

/**
 * 학습 활동을 learning_logs 테이블에 기록하는 공통 함수.
 * 모든 라우트에서 학습 활동 발생 시 이 함수를 호출한다.
 * INSERT 후 집계 테이블을 자동 갱신한다.
 */
function logLearningActivity({
  userId,
  activityType,
  targetType,
  targetId,
  classId = null,
  verb = 'completed',
  objectType = 'Activity',
  objectId = null,
  resultScore = null,
  resultSuccess = null,
  resultDuration = null,
  sourceService = 'class',
  achievementCode = null,
  metadata = null,
  // Phase 2 신규 필드
  sessionId = null,
  durationSec = null,
  deviceType = null,
  platform = null,
  retryCount = 0,
  correctCount = null,
  totalItems = null,
  achievementLevel = null,
  parentStatementId = null,
  subjectCode = null,
  gradeGroup = null,
  // 시드/백필 전용: 주어지면 learning_logs.created_at 을 이 값으로 덮어씀 (ISO 'YYYY-MM-DD HH:MM:SS')
  createdAt = null
}) {
  try {
    const stmts = getStmts();
    const autoObjectId = objectId || `urn:dacheum:${targetType}:${targetId}`;

    // durationSec 계산 (명시 전달 우선, 아니면 resultDuration ISO8601에서 추출)
    const finalDurationSec = (durationSec != null) ? durationSec
      : (resultDuration ? (parseIso8601Duration(resultDuration) ?? (parseInt(resultDuration) || 0)) : 0);

    const statement = {
      actor: { account: { name: String(userId) } },
      verb: { id: `http://adlnet.gov/expapi/verbs/${verb}`, display: { 'ko-KR': verb } },
      object: { id: autoObjectId, objectType },
      result: {
        score: resultScore !== null ? { scaled: resultScore } : undefined,
        success: resultSuccess !== null ? !!resultSuccess : undefined,
        duration: resultDuration || undefined
      },
      context: {
        registration: sessionId || undefined,
        extensions: { sourceService, achievementCode, subjectCode, gradeGroup, deviceType, platform }
      },
      timestamp: new Date().toISOString()
    };

    // 전체 INSERT + 집계 업데이트를 단일 트랜잭션으로 감싸 원자성 보장 (C-5)
    let insertedIdOuter = null;
    const runTx = db.transaction(() => {
    // ── 1. 신규 유저 여부 체크 (INSERT 전에) ──
    let isNewDailyUser = 1;
    let isNewUserSummary = 0;
    let isNewContentUser = 1;
    let isNewClassUser = 1;
    let isNewServiceUser = 1;
    try {
      if (stmts.checkDailyUser.get(userId, activityType, sourceService || '', classId || 0)) isNewDailyUser = 0;
      if (!stmts.checkUserSum.get(userId, activityType)) isNewUserSummary = 1;
      if (targetType && targetId) {
        if (stmts.checkContentUser.get(userId, targetType, String(targetId))) isNewContentUser = 0;
      }
      if (classId) {
        if (stmts.checkClassUser.get(userId, classId, activityType)) isNewClassUser = 0;
      }
      if (sourceService) {
        if (stmts.checkServiceUser.get(userId, sourceService, verb)) isNewServiceUser = 0;
      }
    } catch (_) {}

    // 2. 원본 INSERT
    const info = stmts.insertLog.run(
      userId, activityType, targetType, targetId != null ? String(targetId) : null, classId,
      verb, objectType, autoObjectId, resultScore, resultSuccess,
      resultDuration, sourceService, achievementCode,
      metadata ? JSON.stringify(metadata) : null,
      JSON.stringify(statement),
      sessionId, finalDurationSec, deviceType, platform, retryCount || 0,
      correctCount, totalItems, achievementLevel, parentStatementId,
      subjectCode, gradeGroup,
      metadata ? JSON.stringify(metadata) : null
    );
    const insertedId = info.lastInsertRowid;

    // 시드/백필 모드: created_at 과 statement.timestamp 를 전달받은 값으로 맞춤
    if (createdAt) {
      try {
        db.prepare('UPDATE learning_logs SET created_at = ? WHERE id = ?').run(createdAt, insertedId);
        // statement_json.timestamp 도 동기화
        const patched = { ...statement, timestamp: new Date(createdAt.replace(' ', 'T') + 'Z').toISOString() };
        db.prepare('UPDATE learning_logs SET statement_json = ? WHERE id = ?').run(JSON.stringify(patched), insertedId);
      } catch (_) {}
    }

    // 3. 집계 테이블 갱신
    try {
      const durationForAgg = finalDurationSec;

      // ── [W2-a] 집계 테이블에 넣을 점수는 **정규화 + 채점형만** ──────────────
      //   · 채점형이 아니면 NULL → 집계의 avg_score 갱신 분기가 통째로 건너뛴다.
      //     (진도율·조회 로그가 '성취 점수'로 섞이던 경로를 원천 차단)
      //   · 채점형이면 0~100 으로 정규화해서 넣는다(0~1 저장분이 '0.9점'으로 보이던 것 차단).
      //   재집계 경로의 avgScoreExpr(= 채점형 AND 점수기록 행만 정규화 평균)와 같은 규칙이다.
      const scoreForAgg = (isScoredType(activityType) && resultScore != null)
        ? normScore(resultScore)
        : null;

      // lrs_daily_stats
      stmts.upsertDaily.run(activityType, sourceService || '', classId || 0, isNewDailyUser, scoreForAgg, durationForAgg);

      // lrs_user_summary
      stmts.upsertUser.run(userId, activityType, durationForAgg, scoreForAgg);

      // lrs_content_summary
      if (targetType && targetId) {
        const isView = verb === 'accessed' || (activityType && activityType.includes('view'));
        const isComplete = verb === 'completed' || verb === 'submitted' || verb === 'answered';
        stmts.upsertContent.run(
          targetType, String(targetId),
          isView ? 1 : 0,
          isComplete ? 1 : 0,
          isNewContentUser,
          scoreForAgg
        );
      }

      // lrs_class_summary
      if (classId) {
        stmts.upsertClass.run(classId, activityType, isNewClassUser, scoreForAgg);
      }

      // lrs_service_stats
      if (sourceService) {
        stmts.upsertService.run(sourceService, verb, isNewServiceUser, scoreForAgg);
      }

      // 신규: lrs_user_daily
      stmts.upsertUserDaily.run(userId, durationForAgg, scoreForAgg, subjectCode || '');

      // ── 신규: lrs_achievement_stats — [W2-a] 원천 재계산 방식 ────────────────
      //   "성취 1시도"의 정의는 lib/lrs/mastery-population.js 가 단독으로 갖는다:
      //     achievement_code 있음 AND 채점형 유형 AND result_success 있음.
      //
      //   ★ 왜 result_success 를 요구하는가
      //     attempt_count 는 success_count 의 **분모**다. 정오 판정이 없는 행을 분모에만
      //     넣으면 분자에는 영원히 못 들어가 정답률이 구조적으로 낮아진다.
      //     과거 필터(score 또는 success 중 하나만 있어도 통과)는 이 비대칭을 남겨두어,
      //     점수만 있고 정오 판정이 없는 유형(daily_complete 등)이 "시도했는데 0정답"으로
      //     집계되는 함정이 있었다. 이제 분모와 분자가 정의상 같은 행 집합을 본다.
      //
      //   ★ 왜 증분이 아니라 재계산인가
      //     증분식이 재집계식과 따로 존재하는 한 둘은 반드시 갈라진다(실측 2,344행 뒤집힘).
      //     아래는 재집계와 **같은 SQL 술어·집계식**으로 이 (user, code) 한 쌍만 다시 센다.
      //     원본 INSERT 가 같은 트랜잭션에서 선행하므로 방금 들어온 로그도 포함된다.
      //   ★ [A4/B-1] 선판정 게이트는 **관측(observed)** 이다 — 시도(attempt)가 아니다.
      //     정오 판정이 없는 채점형 학습(오늘의 학습 daily_complete 등)도 성취 칸을 만든다.
      //     그 칸은 attempt_count=0 으로 저장돼 classifyStatus 가 평가부족(회색)으로 분류한다
      //     ("안 해본 것"이 아니라 "판정할 자료가 아직 없는 것"). 도달률 분모는 attempt 기준
      //     이므로 불변이다. 비학습형(조회·진도)은 isMasteryObserved 안의 채점형 화이트리스트가
      //     계속 배제한다 — 이 게이트를 유형 무관으로 넓히면 회색 셀이 수만 개 쏟아진다.
      if (isMasteryObserved({ activityType, achievementCode })) {
        const { classifyStatus, reachRate, STATUS_KO } = require('./lrs-mastery');
        const agg = stmts.recomputeAchievement.get(userId, achievementCode);
        // observed_count 로 "그룹이 비었는가"를 본다. 0행이면 SUM 이 NULL 을 돌려주므로
        // attempt_count 만으로는 '시도 0인 관측 칸'과 '아예 없는 칸'이 구분되지 않는다.
        if (agg && agg.observed_count > 0) {
          const attemptCount = agg.attempt_count || 0;
          const successCount = agg.success_count || 0;
          // 분류기도 mastery SSOT 단일 구현(success/attempt 우선, 없으면 avg 폴백).
          const rate = reachRate(successCount, attemptCount, agg.avg_score);
          const status = classifyStatus(attemptCount, rate);
          stmts.upsertAchievement.run(
            userId, achievementCode,
            agg.subject_code ?? subjectCode ?? null,
            attemptCount, successCount, agg.avg_score,
            status, STATUS_KO[status]
          );
        }
      }

      // 신규: session activity_count 증가
      if (sessionId) {
        stmts.incSessionActivity.run(sessionId);
      }

    } catch (aggErr) {
      console.error('[다채움] 집계 테이블 갱신 실패 (원본은 기록됨):', aggErr.message);
      throw aggErr; // 트랜잭션 롤백 유도
    }

    insertedIdOuter = insertedId;
    }); // end db.transaction
    try { runTx(); }
    catch (txErr) {
      console.error('[다채움] learning_logs 트랜잭션 실패:', txErr.message);
      return null;
    }
    const insertedId = insertedIdOuter;

    // 4. 성장 목표 자동 진행률 업데이트
    if (resultSuccess) {
      try {
        const goalTypeMap = {
          'homework_submit': 'homework',
          'homework_graded': 'homework',
          'exam_complete': 'exam',
          'daily_complete': 'daily',
          'content_view': 'content',
          'lesson_view': 'lesson',
          'diagnosis_complete': 'diagnosis',
          'post_create': 'post',
          'portfolio_add': 'portfolio'
        };
        const mappedGoalType = goalTypeMap[activityType];
        if (mappedGoalType) {
          db.prepare(
            'UPDATE growth_goals SET current_count = current_count + 1 WHERE user_id = ? AND goal_type = ? AND current_count < target_count'
          ).run(userId, mappedGoalType);
        }
        db.prepare(
          'UPDATE growth_goals SET current_count = current_count + 1 WHERE user_id = ? AND goal_type = ? AND current_count < target_count'
        ).run(userId, activityType);
      } catch (goalErr) {
        console.error('[다채움] 성장목표 자동 업데이트 실패:', goalErr.message);
      }
    }

    // 5. 포트폴리오 자동 추가
    if (resultSuccess) {
      try {
        const existing = db.prepare(
          'SELECT id FROM portfolio_items WHERE user_id = ? AND source_type = ? AND source_id = ?'
        ).get(userId, sourceService || 'learning', insertedId);

        if (!existing) {
          // 학생 학년 기반으로 grade_year/school_level 메타를 채운다.
          // 메타가 비면 성장기록>포트폴리오 화면의 기본 학교급 필터에서 자동 항목이 전부 가려진다(회귀 박제됨).
          // role='student' 인 사용자만 채우고, grade 가 없으면(교사 본인용 등) NULL 유지한다.
          let pfGradeYear = null;
          let pfSchoolLevel = null;
          try {
            const stu = db.prepare("SELECT grade FROM users WHERE id = ? AND role = 'student'").get(userId);
            if (stu && stu.grade != null && String(stu.grade).trim() !== '') {
              pfGradeYear = String(stu.grade);
              pfSchoolLevel = gradeToSchoolLevel(stu.grade);
            }
          } catch (_) { /* users 조회 실패 시 메타 없이 진행 */ }

          db.prepare(`
            INSERT INTO portfolio_items
            (user_id, source_type, source_id, class_id, activity_name, subject,
             activity_date, score, result_type, activity_type, grade_year, school_level, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
            userId,
            sourceService || 'learning',
            insertedId,
            classId || null,
            objectType || '학습 활동',
            metadata && metadata.subject ? metadata.subject : (subjectCode || null),
            new Date().toISOString().split('T')[0],
            resultScore != null ? String(resultScore) : null,
            'completed',
            activityType || 'activity',
            pfGradeYear,
            pfSchoolLevel
          );
        }
      } catch (pfErr) {
        console.error('[다채움] 포트폴리오 자동 추가 실패:', pfErr.message);
      }
    }

    return { id: insertedId };

  } catch (error) {
    console.error('[다채움] learning_logs 기록 실패:', error.message);
    return null;
  }
}

module.exports = { logLearningActivity, computeAchievementLevel };
