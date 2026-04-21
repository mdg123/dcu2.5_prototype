// db/lrs-aggregate.js
// 기존 learning_logs 데이터를 5개 집계 테이블로 일괄 재집계하는 배치 함수
const db = require('./index');

/**
 * 모든 집계 테이블을 초기화하고 learning_logs에서 재집계한다.
 * 관리자 전용 기능.
 */
function rebuildAllAggregates() {
  const startTime = Date.now();

  // 트랜잭션으로 묶어 원자성 보장
  const rebuild = db.transaction(() => {
    // 1. 기존 집계 데이터 삭제
    db.exec(`
      DELETE FROM lrs_daily_stats;
      DELETE FROM lrs_user_summary;
      DELETE FROM lrs_content_summary;
      DELETE FROM lrs_class_summary;
      DELETE FROM lrs_service_stats;
      DELETE FROM lrs_achievement_stats;
      DELETE FROM lrs_user_daily;
    `);

    // 2. lrs_daily_stats 재집계
    db.exec(`
      INSERT INTO lrs_daily_stats (stat_date, activity_type, source_service, class_id, activity_count, unique_users, avg_score, total_duration)
      SELECT
        DATE(created_at) as stat_date,
        activity_type,
        COALESCE(source_service, '') as source_service,
        COALESCE(class_id, 0) as class_id,
        COUNT(*) as activity_count,
        COUNT(DISTINCT user_id) as unique_users,
        AVG(result_score) as avg_score,
        COALESCE(SUM(CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER)), 0) as total_duration
      FROM learning_logs
      GROUP BY DATE(created_at), activity_type, COALESCE(source_service,''), COALESCE(class_id,0)
    `);

    // 3. lrs_user_summary 재집계
    db.exec(`
      INSERT INTO lrs_user_summary (user_id, activity_type, total_count, total_duration, avg_score, last_activity_at)
      SELECT
        user_id,
        activity_type,
        COUNT(*) as total_count,
        COALESCE(SUM(CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER)), 0) as total_duration,
        AVG(result_score) as avg_score,
        MAX(created_at) as last_activity_at
      FROM learning_logs
      GROUP BY user_id, activity_type
    `);

    // 4. lrs_content_summary 재집계
    db.exec(`
      INSERT INTO lrs_content_summary (target_type, target_id, view_count, complete_count, unique_users, avg_score)
      SELECT
        target_type,
        target_id,
        SUM(CASE WHEN verb = 'accessed' OR activity_type LIKE '%view%' THEN 1 ELSE 0 END) as view_count,
        SUM(CASE WHEN verb IN ('completed','submitted','answered') THEN 1 ELSE 0 END) as complete_count,
        COUNT(DISTINCT user_id) as unique_users,
        AVG(result_score) as avg_score
      FROM learning_logs
      WHERE target_type IS NOT NULL AND target_id IS NOT NULL
      GROUP BY target_type, target_id
    `);

    // 5. lrs_class_summary 재집계
    db.exec(`
      INSERT INTO lrs_class_summary (class_id, activity_type, total_count, unique_users, avg_score)
      SELECT
        class_id,
        activity_type,
        COUNT(*) as total_count,
        COUNT(DISTINCT user_id) as unique_users,
        AVG(result_score) as avg_score
      FROM learning_logs
      WHERE class_id IS NOT NULL
      GROUP BY class_id, activity_type
    `);

    // 6. lrs_service_stats 재집계
    db.exec(`
      INSERT INTO lrs_service_stats (source_service, verb, total_count, unique_users, avg_score)
      SELECT
        COALESCE(source_service, 'unknown') as source_service,
        verb,
        COUNT(*) as total_count,
        COUNT(DISTINCT user_id) as unique_users,
        AVG(result_score) as avg_score
      FROM learning_logs
      GROUP BY COALESCE(source_service, 'unknown'), verb
    `);

    // 7. lrs_achievement_stats 재집계 (D1: 0-1/0-100 스케일 혼재 방어)
    //    result_score > 1 이면 0-100 스케일로 보고 maxScore=100 기준 비율로 환산.
    //    avg_ratio >= 0.80 → 상, >= 0.50 → 중, < 0.50 → 하, 시도 < 3 → 미도달
    db.exec(`
      INSERT INTO lrs_achievement_stats (user_id, achievement_code, subject_code, attempt_count, success_count, avg_score, last_level, last_attempt_at, updated_at)
      SELECT
        user_id,
        achievement_code,
        MAX(subject_code) as subject_code,
        COUNT(*) as attempt_count,
        SUM(CASE WHEN result_success = 1 THEN 1 ELSE 0 END) as success_count,
        AVG(result_score) as avg_score,
        CASE
          WHEN COUNT(*) < 3 THEN '미도달'
          WHEN AVG(CASE WHEN result_score > 1 THEN result_score/100.0 ELSE result_score END) >= 0.80 THEN '상'
          WHEN AVG(CASE WHEN result_score > 1 THEN result_score/100.0 ELSE result_score END) >= 0.50 THEN '중'
          WHEN AVG(result_score) IS NULL THEN '미도달'
          ELSE '하'
        END as last_level,
        MAX(created_at) as last_attempt_at,
        CURRENT_TIMESTAMP as updated_at
      FROM learning_logs
      WHERE achievement_code IS NOT NULL
      GROUP BY user_id, achievement_code
    `);

    // 8. lrs_user_daily 재집계
    db.exec(`
      INSERT INTO lrs_user_daily (user_id, stat_date, activity_count, duration_sec, avg_score, subjects_touched)
      SELECT
        user_id,
        DATE(created_at) as stat_date,
        COUNT(*) as activity_count,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER))), 0) as duration_sec,
        AVG(result_score) as avg_score,
        GROUP_CONCAT(DISTINCT subject_code) as subjects_touched
      FROM learning_logs
      GROUP BY user_id, DATE(created_at)
    `);

    // 결과 요약
    const counts = {
      daily: db.prepare('SELECT COUNT(*) as cnt FROM lrs_daily_stats').get().cnt,
      user: db.prepare('SELECT COUNT(*) as cnt FROM lrs_user_summary').get().cnt,
      content: db.prepare('SELECT COUNT(*) as cnt FROM lrs_content_summary').get().cnt,
      class: db.prepare('SELECT COUNT(*) as cnt FROM lrs_class_summary').get().cnt,
      service: db.prepare('SELECT COUNT(*) as cnt FROM lrs_service_stats').get().cnt,
      achievement: db.prepare('SELECT COUNT(*) as cnt FROM lrs_achievement_stats').get().cnt,
      userDaily: db.prepare('SELECT COUNT(*) as cnt FROM lrs_user_daily').get().cnt,
      totalLogs: db.prepare('SELECT COUNT(*) as cnt FROM learning_logs').get().cnt
    };

    return counts;
  });

  const counts = rebuild();
  const elapsed = Date.now() - startTime;

  console.log(`[다채움] LRS 집계 재빌드 완료 (${elapsed}ms):`, counts);
  return { ...counts, elapsedMs: elapsed };
}

module.exports = { rebuildAllAggregates };
