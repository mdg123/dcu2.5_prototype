// db/learning-log-helper.js
const db = require('./index');

// ── Prepared Statements 캐시 (성능 최적화) ──
let _stmts = null;
function getStmts() {
  if (_stmts) return _stmts;
  _stmts = {
    insertLog: db.prepare(`
      INSERT INTO learning_logs (
        user_id, activity_type, target_type, target_id, class_id,
        verb, object_type, object_id, result_score, result_success,
        result_duration, source_service, achievement_code, metadata, statement_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertDaily: db.prepare(`
      INSERT INTO lrs_daily_stats (stat_date, activity_type, source_service, class_id, activity_count, unique_users, avg_score, total_duration)
      VALUES (DATE('now'), ?, ?, ?, 1, 1, ?, COALESCE(?,0))
      ON CONFLICT(stat_date, activity_type, source_service, class_id)
      DO UPDATE SET
        activity_count = activity_count + 1,
        unique_users = unique_users,
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
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(target_type, target_id)
      DO UPDATE SET
        view_count = view_count + excluded.view_count,
        complete_count = complete_count + excluded.complete_count,
        unique_users = unique_users + 1,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * (view_count + complete_count) + excluded.avg_score) / (view_count + complete_count + 1)
          ELSE avg_score END,
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertClass: db.prepare(`
      INSERT INTO lrs_class_summary (class_id, activity_type, total_count, unique_users, avg_score)
      VALUES (?, ?, 1, 1, ?)
      ON CONFLICT(class_id, activity_type)
      DO UPDATE SET
        total_count = total_count + 1,
        unique_users = unique_users,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * total_count + excluded.avg_score) / (total_count + 1)
          ELSE avg_score END,
        updated_at = CURRENT_TIMESTAMP
    `),
    upsertService: db.prepare(`
      INSERT INTO lrs_service_stats (source_service, verb, total_count, unique_users, avg_score)
      VALUES (?, ?, 1, 1, ?)
      ON CONFLICT(source_service, verb)
      DO UPDATE SET
        total_count = total_count + 1,
        unique_users = unique_users,
        avg_score = CASE WHEN excluded.avg_score IS NOT NULL
          THEN (COALESCE(avg_score,0) * total_count + excluded.avg_score) / (total_count + 1)
          ELSE avg_score END,
        updated_at = CURRENT_TIMESTAMP
    `)
  };
  return _stmts;
}

/**
 * 학습 활동을 learning_logs 테이블에 기록하는 공통 함수.
 * 모든 라우트에서 학습 활동 발생 시 이 함수를 호출한다.
 * INSERT 후 5개 집계 테이블을 자동 갱신한다.
 */
function logLearningActivity({
  userId,
  activityType,        // lesson_view, homework_submit, exam_complete, content_view, daily_complete, diagnosis_complete, attendance_checkin, post_create, survey_respond
  targetType,          // lesson, homework, exam, content, daily_learning, diagnosis, attendance, post, survey
  targetId,
  classId = null,
  verb = 'completed',  // xAPI: accessed, completed, answered, submitted, attempted, attended, created, responded
  objectType = 'Activity',
  objectId = null,
  resultScore = null,
  resultSuccess = null,
  resultDuration = null,
  sourceService = 'class', // portal, class, content, self-learn, cbt, growth
  achievementCode = null,
  metadata = null
}) {
  try {
    const stmts = getStmts();
    const autoObjectId = objectId || `urn:dacheum:${targetType}:${targetId}`;

    const statement = {
      actor: { account: { name: String(userId) } },
      verb: { id: `http://adlnet.gov/expapi/verbs/${verb}`, display: { 'ko-KR': verb } },
      object: { id: autoObjectId, objectType },
      result: {
        score: resultScore !== null ? { scaled: resultScore } : undefined,
        success: resultSuccess !== null ? !!resultSuccess : undefined,
        duration: resultDuration || undefined
      },
      context: { extensions: { sourceService, achievementCode } },
      timestamp: new Date().toISOString()
    };

    // 1. 원본 INSERT
    stmts.insertLog.run(
      userId, activityType, targetType, String(targetId), classId,
      verb, objectType, autoObjectId, resultScore, resultSuccess,
      resultDuration, sourceService, achievementCode,
      metadata ? JSON.stringify(metadata) : null,
      JSON.stringify(statement)
    );

    // 2. 집계 테이블 갱신 (실패해도 원본 INSERT는 이미 완료)
    try {
      const durationSec = resultDuration ? parseInt(resultDuration) || 0 : 0;

      // lrs_daily_stats (source_service, class_id는 NOT NULL DEFAULT이므로 기본값 전달)
      stmts.upsertDaily.run(activityType, sourceService || '', classId || 0, resultScore, durationSec);

      // lrs_user_summary
      stmts.upsertUser.run(userId, activityType, durationSec, resultScore);

      // lrs_content_summary (조회/완료 구분)
      if (targetType && targetId) {
        const isView = verb === 'accessed' || activityType.includes('view');
        const isComplete = verb === 'completed' || verb === 'submitted' || verb === 'answered';
        stmts.upsertContent.run(
          targetType, targetId,
          isView ? 1 : 0,
          isComplete ? 1 : 0,
          resultScore
        );
      }

      // lrs_class_summary (클래스가 있을 때만)
      if (classId) {
        stmts.upsertClass.run(classId, activityType, resultScore);
      }

      // lrs_service_stats
      stmts.upsertService.run(sourceService, verb, resultScore);

    } catch (aggErr) {
      console.error('[다채움] 집계 테이블 갱신 실패 (원본은 기록됨):', aggErr.message);
    }

    // 3. 성장 목표 자동 진행률 업데이트
    if (resultSuccess) {
      try {
        // goal_type이 activityType과 매칭되는 성장목표의 current_count를 +1
        // 예: homework_submit → goal_type='homework', daily_complete → goal_type='daily' 등
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
        // 범용: goal_type이 activityType 자체와 같은 경우도 처리
        db.prepare(
          'UPDATE growth_goals SET current_count = current_count + 1 WHERE user_id = ? AND goal_type = ? AND current_count < target_count'
        ).run(userId, activityType);
      } catch (goalErr) {
        console.error('[다채움] 성장목표 자동 업데이트 실패:', goalErr.message);
      }
    }

    // 4. 완료된 학습 활동을 포트폴리오에 자동 추가
    if (resultSuccess) {
      try {
        const lastId = db.prepare('SELECT last_insert_rowid() as id').get().id;
        const existing = db.prepare(
          'SELECT id FROM portfolio_items WHERE user_id = ? AND source_type = ? AND source_id = ?'
        ).get(userId, sourceService || 'learning', lastId);

        if (!existing) {
          db.prepare(`
            INSERT INTO portfolio_items
            (user_id, source_type, source_id, class_id, activity_name, subject,
             activity_date, score, result_type, activity_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
            userId,
            sourceService || 'learning',
            lastId,
            classId || null,
            objectType || '학습 활동',
            metadata && metadata.subject ? metadata.subject : null,
            new Date().toISOString().split('T')[0],
            resultScore != null ? String(resultScore) : null,
            'completed',
            activityType || 'activity'
          );
        }
      } catch (pfErr) {
        console.error('[다채움] 포트폴리오 자동 추가 실패:', pfErr.message);
      }
    }

  } catch (error) {
    console.error('[다채움] learning_logs 기록 실패:', error.message);
    // 로그 실패가 메인 기능을 막으면 안 되므로 에러를 삼킨다
  }
}

module.exports = { logLearningActivity };
