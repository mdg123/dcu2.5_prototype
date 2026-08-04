require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 일회성 정리 스크립트 — student1(user_id=3) "HOLD(보류) 항목" 안전 정리
 *
 * 배경:
 *   직전 BE 가 cleanup-student1-learning-reset.js 에서 핵심 학습 테이블(user_node_status,
 *   problem_attempts, user_content_progress, daily_learning, wrong_answers, user_learning_list,
 *   content_attempts/progress, learning_paths, lesson_self_check, user_last_activity)은 이미
 *   정리 완료. 다만 "타 사용자 FK 연결" 또는 "비학습 이벤트 혼재" 위험 때문에 HOLD 한 항목들이
 *   남아 있다. 이 스크립트는 그 HOLD 항목을 **학습 흔적만 선별**해 안전하게 정리한다.
 *
 * ── 절대 원칙 ──
 *   - user_id = 3 (student1/이학생) 에만 작용.
 *   - 타 사용자(1,2,4...)의 데이터·저작물·FK 절대 미접근.
 *   - id 999(학생개설테스트반) 및 그 데이터 미접근.
 *   - 비학습 데이터(출석/정서/게시판/쪽지/설문/프로필/클래스멤버십) 보존.
 *   - 백업 먼저(JSON), 단일 트랜잭션, idempotent. 선별 불가·위험하면 보존하고 보고(과삭제 금지).
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  처리 정책 (테이블별)
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  [1] problem_set_attempts  : WHERE user_id=3 만 삭제(본인 풀이 흔적, ids 1~4).
 *      problem_sets / problem_set_items : **보존**(저작/콘텐츠. user3 작성 #1 을 user1,2 가 풀어
 *        problem_set_attempts(FK)가 가리킴 → 삭제 시 타 사용자 orphan/FK 위반). 타 사용자(1,2)
 *        attempts(ids 5,6)도 절대 보존.
 *
 *  [2] learning_logs (394)   : activity_type 으로 **학습성만** 선별 삭제.
 *      삭제 = content_view, lesson_view, lesson_progress, diagnosis_complete, self_learn,
 *             exam_complete, problem_attempt, daily_complete, node_complete, wrong_note_retry,
 *             homework_submit, homework_graded
 *      보존 = post_create(게시판), attendance_checkin(출석), survey_respond(설문)
 *
 *      xapi_statement_spool (423) : area 로 **학습성만** 선별 삭제.
 *      삭제 = assessment, assignment, media, navigation, query, annotation, objective
 *             (평가/과제/콘텐츠재생/콘텐츠열람·검색/주석/학습목표 — 전부 학습 서비스 활동)
 *      보존 = social(social-learning 참여), survey(설문·정서·이해도), teaching(교사측 class
 *             재구성·피드백 — student3 본인 학습 흔적 아님). ※ 의심스러우면 보존 원칙 적용.
 *
 *  [3] lrs_* 집계(user_id=3 보유 5종) : 학습 분석 집계. 비학습(attendance/post/survey)도 일부
 *      혼재하나, **노드/성취/세션/일자 집계**는 학습 분석 surface 전용이며 활동유형별로 선별 가능.
 *      - lrs_std_node_stats   (327) : 노드별 학습 통계 → **전삭제**(전부 학습 노드).
 *      - lrs_achievement_stats(107) : 성취기준 학습 통계 → **전삭제**(전부 학습 성취).
 *      - lrs_user_daily       (27)  : 일자별 학습활동 집계(content/diagnosis 위주) → **전삭제**.
 *      - lrs_session_stats    (5)   : 학습 세션 집계 → **전삭제**.
 *      - lrs_user_summary     (15)  : activity_type 별 누적 → **학습 activity_type 만 선별 삭제**,
 *             attendance_checkin / post_create / survey_respond 행은 보존.
 *      (user_id 없는 lrs_daily_stats/content_summary/class_summary/service_stats 는 전체 집계 →
 *       user3 단독 분리 불가 → 미접근/보존.)
 *
 *  [4] reading_logs(15)    : 독서기록(학습활동) → user_id=3 **전삭제**.
 *      growth_goals(2)     : 성장목표(학습)         → user_id=3 **전삭제**.
 *      user_learn_settings(1): 학습설정             → user_id=3 **전삭제**.
 *
 *  [5] user_points(59행/533p) : source 로 **학습 사유분만** 삭제.
 *      삭제 = daily_learning, problem_attempt, problem_set, node_complete, wrong_note (학습)
 *      보존 = attendance (출석, 10행/100p — 비학습)
 *
 *      class_mileage / class_mileage_log : **보존(미접근)**.
 *        사유: class_mileage 는 class_mileage_log 로부터 산출되는 **비정규화 집계 잔액**
 *        (balance/total_earned/total_deducted). 로그에는 학습(homework_submit, exam_complete,
 *        lesson_complete)과 비학습(attendance, board_post, board_comment, notice_read,
 *        survey_submit, manual_award/deduct, revoke)이 혼재하며, revoke 행이 manual 행을
 *        revoked_log_id 로 참조한다. 학습 로그만 부분 삭제하면 잔액 재계산이 revoke/manual 체인
 *        때문에 매우 취약(과삭제·정합성 붕괴 위험). 마일리지는 SFR-017 클래스 게이미피케이션
 *        surface 로 핵심 학습 baseline(map/성취/오답/오늘학습)과 무관 → **보존하고 보고**.
 *
 * 실행: node scripts/cleanup-student1-hold-items.js
 *   (서버가 WAL 공유 중에도 동작하나 안전을 위해 정지 후 권장)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TARGET_USER_ID = 3; // student1 (이학생)
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP_PATH = path.join(BACKUP_DIR, `student1-hold-cleanup-${STAMP}.json`);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

console.log('=== student1(user_id=3) HOLD 항목 안전 정리 시작 ===');
console.log('DB:', DB_PATH);
console.log('대상 user_id:', TARGET_USER_ID);

// 학습성 분류 기준 ────────────────────────────────────────────────
const LL_LEARNING_TYPES = [
  'content_view', 'lesson_view', 'lesson_progress', 'diagnosis_complete',
  'self_learn', 'exam_complete', 'problem_attempt', 'daily_complete',
  'node_complete', 'wrong_note_retry', 'homework_submit', 'homework_graded',
];
const LL_NONLEARNING_TYPES = ['post_create', 'attendance_checkin', 'survey_respond'];

const XAPI_LEARNING_AREAS = [
  'assessment', 'assignment', 'media', 'navigation', 'query', 'annotation', 'objective',
];
const XAPI_NONLEARNING_AREAS = ['social', 'survey', 'teaching'];

const UP_LEARNING_SOURCES = [
  'daily_learning', 'problem_attempt', 'problem_set', 'node_complete', 'wrong_note',
];
const UP_NONLEARNING_SOURCES = ['attendance'];

const LRS_SUMMARY_LEARNING_TYPES = LL_LEARNING_TYPES; // 동일 활동유형 체계
const LRS_SUMMARY_NONLEARNING_TYPES = LL_NONLEARNING_TYPES;

const placeholders = (arr) => arr.map(() => '?').join(',');

// 백업 대상 정의 — user_id=3 기준 모든 HOLD 테이블 (삭제하든 보존하든 전부 스냅샷)
const BACKUP_DEFS = [
  { key: 'problem_sets',          sql: 'SELECT * FROM problem_sets WHERE user_id = ?' },
  { key: 'problem_set_items',     sql: 'SELECT i.* FROM problem_set_items i JOIN problem_sets s ON i.problem_set_id = s.id WHERE s.user_id = ?' },
  { key: 'problem_set_attempts',  sql: 'SELECT * FROM problem_set_attempts WHERE user_id = ?' },
  { key: 'learning_logs',         sql: 'SELECT * FROM learning_logs WHERE user_id = ?' },
  { key: 'xapi_statement_spool',  sql: 'SELECT * FROM xapi_statement_spool WHERE user_id = ?' },
  { key: 'lrs_std_node_stats',    sql: 'SELECT * FROM lrs_std_node_stats WHERE user_id = ?' },
  { key: 'lrs_achievement_stats', sql: 'SELECT * FROM lrs_achievement_stats WHERE user_id = ?' },
  { key: 'lrs_user_daily',        sql: 'SELECT * FROM lrs_user_daily WHERE user_id = ?' },
  { key: 'lrs_session_stats',     sql: 'SELECT * FROM lrs_session_stats WHERE user_id = ?' },
  { key: 'lrs_user_summary',      sql: 'SELECT * FROM lrs_user_summary WHERE user_id = ?' },
  { key: 'reading_logs',          sql: 'SELECT * FROM reading_logs WHERE user_id = ?' },
  { key: 'growth_goals',          sql: 'SELECT * FROM growth_goals WHERE user_id = ?' },
  { key: 'user_learn_settings',   sql: 'SELECT * FROM user_learn_settings WHERE user_id = ?' },
  { key: 'user_points',           sql: 'SELECT * FROM user_points WHERE user_id = ?' },
  { key: 'class_mileage',         sql: 'SELECT * FROM class_mileage WHERE user_id = ?' },
  { key: 'class_mileage_log',     sql: 'SELECT * FROM class_mileage_log WHERE user_id = ?' },
];

// ── 1. 백업 ─────────────────────────────────────────────────────
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const snapshot = {
  meta: {
    purpose: 'student1(user_id=3) HOLD 항목 안전 정리 전 백업',
    target_user_id: TARGET_USER_ID,
    db_path: DB_PATH,
    taken_at: new Date().toISOString(),
  },
  tables: {},
};
for (const { key, sql } of BACKUP_DEFS) {
  snapshot.tables[key] = db.prepare(sql).all(TARGET_USER_ID);
}
fs.writeFileSync(BACKUP_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
console.log('\n[백업 완료]', BACKUP_PATH);
const bk = {};
for (const k of Object.keys(snapshot.tables)) bk[k] = snapshot.tables[k].length;
console.log('백업 행수:', JSON.stringify(bk, null, 2));

// 행수 카운트 헬퍼 (user_id=3)
const cnt = (sql) => db.prepare(sql).get(TARGET_USER_ID).c;

// ── 2. 정리 전 행수 ─────────────────────────────────────────────
const before = {
  problem_set_attempts_u3:   cnt('SELECT COUNT(*) c FROM problem_set_attempts WHERE user_id = ?'),
  problem_sets_u3:           cnt('SELECT COUNT(*) c FROM problem_sets WHERE user_id = ?'),
  problem_set_items_u3:      db.prepare('SELECT COUNT(*) c FROM problem_set_items i JOIN problem_sets s ON i.problem_set_id=s.id WHERE s.user_id=?').get(TARGET_USER_ID).c,
  learning_logs_u3:          cnt('SELECT COUNT(*) c FROM learning_logs WHERE user_id = ?'),
  xapi_u3:                   cnt('SELECT COUNT(*) c FROM xapi_statement_spool WHERE user_id = ?'),
  lrs_std_node_stats_u3:     cnt('SELECT COUNT(*) c FROM lrs_std_node_stats WHERE user_id = ?'),
  lrs_achievement_stats_u3:  cnt('SELECT COUNT(*) c FROM lrs_achievement_stats WHERE user_id = ?'),
  lrs_user_daily_u3:         cnt('SELECT COUNT(*) c FROM lrs_user_daily WHERE user_id = ?'),
  lrs_session_stats_u3:      cnt('SELECT COUNT(*) c FROM lrs_session_stats WHERE user_id = ?'),
  lrs_user_summary_u3:       cnt('SELECT COUNT(*) c FROM lrs_user_summary WHERE user_id = ?'),
  reading_logs_u3:           cnt('SELECT COUNT(*) c FROM reading_logs WHERE user_id = ?'),
  growth_goals_u3:           cnt('SELECT COUNT(*) c FROM growth_goals WHERE user_id = ?'),
  user_learn_settings_u3:    cnt('SELECT COUNT(*) c FROM user_learn_settings WHERE user_id = ?'),
  user_points_u3:            cnt('SELECT COUNT(*) c FROM user_points WHERE user_id = ?'),
  user_points_sum_u3:        db.prepare('SELECT COALESCE(SUM(points),0) c FROM user_points WHERE user_id=?').get(TARGET_USER_ID).c,
  class_mileage_u3:          cnt('SELECT COUNT(*) c FROM class_mileage WHERE user_id = ?'),
  class_mileage_log_u3:      cnt('SELECT COUNT(*) c FROM class_mileage_log WHERE user_id = ?'),
};

// 타 사용자/비학습/저작물 불변 검증용 (정리 전)
const guardsBefore = {
  // 타 사용자(1,2)가 user3 문제집을 푼 attempts (ids 5,6) — 불변이어야 함
  others_attempts_on_u3_sets: db.prepare('SELECT COUNT(*) c FROM problem_set_attempts a JOIN problem_sets s ON a.problem_set_id=s.id WHERE s.user_id=3 AND a.user_id<>3').get().c,
  // 타 사용자 problem_sets (user 2,4) 불변
  other_users_problem_sets: db.prepare('SELECT COUNT(*) c FROM problem_sets WHERE user_id<>3').get().c,
  // 비학습 보존: learning_logs 비학습 활동유형
  ll_nonlearning_u3: db.prepare(`SELECT COUNT(*) c FROM learning_logs WHERE user_id=? AND activity_type IN (${placeholders(LL_NONLEARNING_TYPES)})`).get(TARGET_USER_ID, ...LL_NONLEARNING_TYPES).c,
  // 비학습 보존: xapi 비학습 area
  xapi_nonlearning_u3: db.prepare(`SELECT COUNT(*) c FROM xapi_statement_spool WHERE user_id=? AND area IN (${placeholders(XAPI_NONLEARNING_AREAS)})`).get(TARGET_USER_ID, ...XAPI_NONLEARNING_AREAS).c,
  // 비학습 보존: user_points attendance
  up_attendance_u3: db.prepare('SELECT COUNT(*) c FROM user_points WHERE user_id=? AND source=?').get(TARGET_USER_ID, 'attendance').c,
  // 비학습 보존: lrs_user_summary 비학습 활동유형
  lrs_summary_nonlearning_u3: db.prepare(`SELECT COUNT(*) c FROM lrs_user_summary WHERE user_id=? AND activity_type IN (${placeholders(LRS_SUMMARY_NONLEARNING_TYPES)})`).get(TARGET_USER_ID, ...LRS_SUMMARY_NONLEARNING_TYPES).c,
  // 핵심 비학습 surface 불변
  attendance_u3: db.prepare('SELECT COUNT(*) c FROM attendance WHERE user_id=?').get(TARGET_USER_ID).c,
  emotion_checkins_u3: db.prepare('SELECT COUNT(*) c FROM emotion_checkins WHERE user_id=?').get(TARGET_USER_ID).c,
  posts_u3: db.prepare('SELECT COUNT(*) c FROM posts WHERE author_id=?').get(TARGET_USER_ID).c,
  messages_u3: db.prepare('SELECT COUNT(*) c FROM messages WHERE sender_id=?').get(TARGET_USER_ID).c,
  // id 999 클래스 미접근 확인 (멤버 행수 불변)
  class999_members: db.prepare('SELECT COUNT(*) c FROM class_members WHERE class_id=999').get().c,
};

console.log('\n[정리 전 — user3 행수]');
console.log(JSON.stringify(before, null, 2));

// ── 3. 선별 삭제 (단일 트랜잭션) ───────────────────────────────
const tx = db.transaction(() => {
  // [1] 본인 problem_set_attempts 만
  db.prepare('DELETE FROM problem_set_attempts WHERE user_id = ?').run(TARGET_USER_ID);

  // [2] learning_logs — 학습 활동유형만
  db.prepare(`DELETE FROM learning_logs WHERE user_id = ? AND activity_type IN (${placeholders(LL_LEARNING_TYPES)})`).run(TARGET_USER_ID, ...LL_LEARNING_TYPES);
  //    xapi — 학습 area 만
  db.prepare(`DELETE FROM xapi_statement_spool WHERE user_id = ? AND area IN (${placeholders(XAPI_LEARNING_AREAS)})`).run(TARGET_USER_ID, ...XAPI_LEARNING_AREAS);

  // [3] lrs_* 집계 — 학습 전용 테이블 전삭제 + user_summary 는 학습 활동유형만
  db.prepare('DELETE FROM lrs_std_node_stats WHERE user_id = ?').run(TARGET_USER_ID);
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id = ?').run(TARGET_USER_ID);
  db.prepare('DELETE FROM lrs_user_daily WHERE user_id = ?').run(TARGET_USER_ID);
  db.prepare('DELETE FROM lrs_session_stats WHERE user_id = ?').run(TARGET_USER_ID);
  db.prepare(`DELETE FROM lrs_user_summary WHERE user_id = ? AND activity_type IN (${placeholders(LRS_SUMMARY_LEARNING_TYPES)})`).run(TARGET_USER_ID, ...LRS_SUMMARY_LEARNING_TYPES);

  // [4] 독서기록/성장목표/학습설정 — user3 전삭제
  db.prepare('DELETE FROM reading_logs WHERE user_id = ?').run(TARGET_USER_ID);
  db.prepare('DELETE FROM growth_goals WHERE user_id = ?').run(TARGET_USER_ID);
  db.prepare('DELETE FROM user_learn_settings WHERE user_id = ?').run(TARGET_USER_ID);

  // [5] user_points — 학습 사유만
  db.prepare(`DELETE FROM user_points WHERE user_id = ? AND source IN (${placeholders(UP_LEARNING_SOURCES)})`).run(TARGET_USER_ID, ...UP_LEARNING_SOURCES);
  // class_mileage / class_mileage_log : 미접근(보존)
});
tx();

// ── 4. 정리 후 검증 ─────────────────────────────────────────────
const after = {
  problem_set_attempts_u3:   cnt('SELECT COUNT(*) c FROM problem_set_attempts WHERE user_id = ?'),
  problem_sets_u3:           cnt('SELECT COUNT(*) c FROM problem_sets WHERE user_id = ?'),
  problem_set_items_u3:      db.prepare('SELECT COUNT(*) c FROM problem_set_items i JOIN problem_sets s ON i.problem_set_id=s.id WHERE s.user_id=?').get(TARGET_USER_ID).c,
  learning_logs_u3:          cnt('SELECT COUNT(*) c FROM learning_logs WHERE user_id = ?'),
  xapi_u3:                   cnt('SELECT COUNT(*) c FROM xapi_statement_spool WHERE user_id = ?'),
  lrs_std_node_stats_u3:     cnt('SELECT COUNT(*) c FROM lrs_std_node_stats WHERE user_id = ?'),
  lrs_achievement_stats_u3:  cnt('SELECT COUNT(*) c FROM lrs_achievement_stats WHERE user_id = ?'),
  lrs_user_daily_u3:         cnt('SELECT COUNT(*) c FROM lrs_user_daily WHERE user_id = ?'),
  lrs_session_stats_u3:      cnt('SELECT COUNT(*) c FROM lrs_session_stats WHERE user_id = ?'),
  lrs_user_summary_u3:       cnt('SELECT COUNT(*) c FROM lrs_user_summary WHERE user_id = ?'),
  reading_logs_u3:           cnt('SELECT COUNT(*) c FROM reading_logs WHERE user_id = ?'),
  growth_goals_u3:           cnt('SELECT COUNT(*) c FROM growth_goals WHERE user_id = ?'),
  user_learn_settings_u3:    cnt('SELECT COUNT(*) c FROM user_learn_settings WHERE user_id = ?'),
  user_points_u3:            cnt('SELECT COUNT(*) c FROM user_points WHERE user_id = ?'),
  user_points_sum_u3:        db.prepare('SELECT COALESCE(SUM(points),0) c FROM user_points WHERE user_id=?').get(TARGET_USER_ID).c,
  class_mileage_u3:          cnt('SELECT COUNT(*) c FROM class_mileage WHERE user_id = ?'),
  class_mileage_log_u3:      cnt('SELECT COUNT(*) c FROM class_mileage_log WHERE user_id = ?'),
};

const guardsAfter = {
  others_attempts_on_u3_sets: db.prepare('SELECT COUNT(*) c FROM problem_set_attempts a JOIN problem_sets s ON a.problem_set_id=s.id WHERE s.user_id=3 AND a.user_id<>3').get().c,
  other_users_problem_sets: db.prepare('SELECT COUNT(*) c FROM problem_sets WHERE user_id<>3').get().c,
  ll_nonlearning_u3: db.prepare(`SELECT COUNT(*) c FROM learning_logs WHERE user_id=? AND activity_type IN (${placeholders(LL_NONLEARNING_TYPES)})`).get(TARGET_USER_ID, ...LL_NONLEARNING_TYPES).c,
  xapi_nonlearning_u3: db.prepare(`SELECT COUNT(*) c FROM xapi_statement_spool WHERE user_id=? AND area IN (${placeholders(XAPI_NONLEARNING_AREAS)})`).get(TARGET_USER_ID, ...XAPI_NONLEARNING_AREAS).c,
  up_attendance_u3: db.prepare('SELECT COUNT(*) c FROM user_points WHERE user_id=? AND source=?').get(TARGET_USER_ID, 'attendance').c,
  lrs_summary_nonlearning_u3: db.prepare(`SELECT COUNT(*) c FROM lrs_user_summary WHERE user_id=? AND activity_type IN (${placeholders(LRS_SUMMARY_NONLEARNING_TYPES)})`).get(TARGET_USER_ID, ...LRS_SUMMARY_NONLEARNING_TYPES).c,
  attendance_u3: db.prepare('SELECT COUNT(*) c FROM attendance WHERE user_id=?').get(TARGET_USER_ID).c,
  emotion_checkins_u3: db.prepare('SELECT COUNT(*) c FROM emotion_checkins WHERE user_id=?').get(TARGET_USER_ID).c,
  posts_u3: db.prepare('SELECT COUNT(*) c FROM posts WHERE author_id=?').get(TARGET_USER_ID).c,
  messages_u3: db.prepare('SELECT COUNT(*) c FROM messages WHERE sender_id=?').get(TARGET_USER_ID).c,
  class999_members: db.prepare('SELECT COUNT(*) c FROM class_members WHERE class_id=999').get().c,
};

console.log('\n[정리 후 — user3 행수]');
console.log(JSON.stringify(after, null, 2));

// 전/후 변화 표
console.log('\n[테이블별 전 → 후 (user3)]');
for (const k of Object.keys(before)) {
  const flag = before[k] !== after[k] ? '  (변경)' : '';
  console.log('  ' + k.padEnd(28) + before[k] + ' -> ' + after[k] + flag);
}

// 가드 검증
console.log('\n[안전 가드 — 불변이어야 하는 값]');
let guardOK = true;
for (const k of Object.keys(guardsBefore)) {
  const same = guardsBefore[k] === guardsAfter[k];
  if (!same) guardOK = false;
  console.log('  ' + (same ? '[OK]  ' : '[!!]  ') + k.padEnd(28) + guardsBefore[k] + ' -> ' + guardsAfter[k]);
}

// 보존(미접근) 판정 항목 명시
console.log('\n[보존(미접근) 판정 항목]');
console.log('  - problem_sets / problem_set_items : 저작/콘텐츠, 타 사용자 FK 연결 → 보존');
console.log('  - class_mileage / class_mileage_log : 비정규화 잔액 + 학습/비학습 혼재 + revoke 체인 → 재계산 위험으로 보존');
console.log('  - user_points(attendance) : 비학습 적립 → 보존');
console.log('  - learning_logs(post_create/attendance_checkin/survey_respond) : 비학습 → 보존');
console.log('  - xapi(social/survey/teaching) : 비학습/교사측 → 보존');
console.log('  - lrs_user_summary(attendance_checkin/post_create/survey_respond) : 비학습 → 보존');
console.log('  - lrs_daily_stats/content_summary/class_summary/service_stats : 전체집계(user 분리불가) → 미접근');

console.log('\n[종합] 안전 가드:', guardOK ? 'OK (모두 불변)' : '!! 일부 변경됨 — 확인 필요');

db.close();
console.log('\n=== HOLD 항목 안전 정리 완료 ===');
