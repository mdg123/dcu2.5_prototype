// db/lrs-aggregate.js
// 기존 learning_logs 데이터를 7개 집계 테이블로 일괄 재집계하는 배치 함수
//
// ── [W2-a] 쓰기 시점 정본화 (2026-07-31) ────────────────────────────────────
// 이 파일은 LRS 지표 오염의 **최상류**였다. 하류(routes/lrs.js·db/lrs-*.js)가 아무리
// 정규화해도, 여기서 이미 오염된 값을 저장하면 그 정규화는 전부 사후약방문이다.
//
//   결함 1  avg_score 7개 컬럼 전부가 원시 AVG(result_score).
//           0~1 과 0~100 이 섞인 채 평균 → "학급 평균 성취 8.5점"(실제 ≈78) 류의 붕괴.
//           게다가 lesson_progress 의 '진도율'(0.5~1.0)이 성취 점수로 섞여 들어갔다.
//           → lib/lrs/score-scale.js 의 avgScoreExpr(정규화 + 채점형 모집단)로 교체.
//
//   결함 2  lrs_achievement_stats.attempt_count 가 무필터 COUNT(*).
//           조회 로그(content_view)까지 '시도'로 계수됐다. 실측: achievement_code 를 단
//           content_view 가 **36,410건**인데 점수·정오 판정이 전무하다.
//           분모에만 들어가고 분자(success_count)에는 절대 못 들어가므로
//           **모든 정답률이 구조적으로 하향 편향**됐다.
//           실측 영향: 풀드 정답 인정률 51.8% → 76.5%, 저장 행 49,336 → 30,989.
//           → lib/lrs/mastery-population.js 의 정본 술어로 교체.
//
//   결함 3  실시간 경로(db/learning-log-helper.js)에는 있던 평가신호 필터가 여기엔 없어
//           **재집계를 돌릴 때마다 2,344행의 도달/미도달이 뒤집혔다.**
//           → 두 경로가 SQL 술어·집계식을 문자 그대로 공유하도록 통일(mastery-population.js).
//
// ⚠ is_seed 전파는 이 커밋 범위 밖(집계 테이블 스키마 변경 + 소비처 배선 필요).
//    현재도 realOnly=1 은 집계 경유 지표에 작동하지 않는다(지표 정본사전 §3-3 규칙 5).
// ─────────────────────────────────────────────────────────────────────────────
const db = require('./index');
const { avgScoreExpr } = require('../lib/lrs/score-scale');
const { masteryAttemptWhere, masteryAggSelect } = require('../lib/lrs/mastery-population');

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
        ${avgScoreExpr('')} as avg_score,
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
        ${avgScoreExpr('')} as avg_score,
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
        ${avgScoreExpr('')} as avg_score
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
        ${avgScoreExpr('')} as avg_score
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
        ${avgScoreExpr('')} as avg_score
      FROM learning_logs
      GROUP BY COALESCE(source_service, 'unknown'), verb
    `);

    // 7. lrs_achievement_stats 재집계 — 집계 컬럼만 INSERT.
    //    level/last_level 은 아래 7-classify 에서 mastery API 와 동일한 단일 분류기로 채운다.
    //    (결함 B fix: 과거에는 avg_score 기반 CASE SQL 로 산출 → avg_score IS NULL 인데
    //     attempt 多·success 0 인 행이 'insufficient/평가부족' 으로 박혀 mastery API 의
    //     success/attempt 기반 'not_reached/미도달' 과 어긋남(2020행 불일치). 분류기 통일로 정합.)
    //
    //    ★ [W2-a] 모집단·집계식은 lib/lrs/mastery-population.js 가 단독 정의한다.
    //      실시간 경로(db/learning-log-helper.js)가 **이 문자열을 그대로 재사용**하므로
    //      두 경로는 키 범위(전수 GROUP BY vs 단일 user+code)만 다르고 판정은 동일하다.
    //      여기에 술어나 집계식을 인라인으로 다시 쓰면 그 순간 두 경로가 갈라진다 — 금지.
    db.exec(`
      INSERT INTO lrs_achievement_stats (user_id, achievement_code, attempt_count, success_count, avg_score, subject_code, last_attempt_at, updated_at)
      SELECT
        user_id,
        achievement_code,
        ${masteryAggSelect('')},
        CURRENT_TIMESTAMP as updated_at
      FROM learning_logs
      WHERE ${masteryAttemptWhere('')}
      GROUP BY user_id, achievement_code
    `);

    // 7-classify: level/last_level 을 mastery API 와 동일한 단일 분류기(DRY)로 채운다.
    //   reachRate(success/attempt 우선, 없으면 avg_score 폴백) → classifyStatus → level(영문),
    //   STATUS_KO[level] → last_level(한글: 도달/부분도달/미도달/평가부족).
    {
      const { classifyStatus, reachRate, STATUS_KO } = require('./lrs-mastery');
      // 주의: lrs_achievement_stats 는 id INTEGER PRIMARY KEY → 'rowid' 별칭이 SELECT 시
      //   'id' 로 반환된다(rowid 키는 안 옴). 반드시 실 PK 컬럼 id 를 키로 UPDATE 한다.
      const allStats = db.prepare('SELECT id, attempt_count, success_count, avg_score FROM lrs_achievement_stats').all();
      const updLevel = db.prepare('UPDATE lrs_achievement_stats SET level = ?, last_level = ? WHERE id = ?');
      for (const s of allStats) {
        const rate = reachRate(s.success_count, s.attempt_count, s.avg_score);
        const status = classifyStatus(s.attempt_count, rate);
        updLevel.run(status, STATUS_KO[status], s.id);
      }
    }

    // 7b. std_id 충진 — achievement_code → std_id resolver (P0-1).
    //     매 쿼리 join 대신 사전 충진(성능). 매핑 없으면 NULL 유지(무손상).
    try {
      const { resolveCode, invalidateCache } = require('./lrs-mastery');
      invalidateCache(); // 재빌드 직전 캐시 무효화(스키마/데이터 변동 반영)
      const codes = db.prepare('SELECT DISTINCT achievement_code FROM lrs_achievement_stats WHERE achievement_code IS NOT NULL').all();
      const updStd = db.prepare('UPDATE lrs_achievement_stats SET std_id = ? WHERE achievement_code = ? AND std_id IS NULL');
      for (const { achievement_code } of codes) {
        const ctx = resolveCode(achievement_code);
        if (ctx && ctx.std_id) updStd.run(ctx.std_id, achievement_code);
      }
    } catch (e) {
      console.warn('[다채움] lrs_achievement_stats std_id 충진 건너뜀:', e && e.message);
    }

    // 8. lrs_user_daily 재집계
    db.exec(`
      INSERT INTO lrs_user_daily (user_id, stat_date, activity_count, duration_sec, avg_score, subjects_touched)
      SELECT
        user_id,
        DATE(created_at) as stat_date,
        COUNT(*) as activity_count,
        COALESCE(SUM(COALESCE(duration_sec, CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER))), 0) as duration_sec,
        ${avgScoreExpr('')} as avg_score,
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
