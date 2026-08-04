require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 일회성 정리 스크립트 — student1(user_id=3) 학습 흔적 완전 초기화 → "학습-전 baseline"
 *
 * 배경 (사용자 결정):
 *   student1(이학생)은 시연·확인용 계정으로 실제 학습한 적이 없다. 과거 시드/테스트 단계의
 *   problem_attempts·user_content_progress·진단 시뮬 잔여물이 학습맵 노드를 in_progress/
 *   video_watched 로 만들고 있어, 이 학습 흔적을 전부 제거해 "학습 전" 깨끗한 baseline 으로 만든다.
 *   (성취수준·오답노트·오늘의학습이 빈 상태가 되는 것은 정상 — 학습을 한 적이 없으므로.)
 *
 * 정책:
 *   - user_id = 3 (이학생/student1) 에만 작용. id 999(학생개설테스트반) 및 타 사용자(2,4 등) 절대 미접근.
 *   - 비학습 데이터(계정/프로필 users, 클래스 멤버십 class_members, 출석 attendance, 정서
 *     emotion_*, 게시판 posts/comments, 쪽지 messages 등)는 절대 보존 — 건드리지 않음.
 *   - 단일 트랜잭션, idempotent(재실행 안전), user_id=3 바인딩만.
 *   - 삭제 전 백업 필수: 삭제 대상 + HOLD(보류) 대상까지 모든 user3 학습성 행을 JSON 스냅샷으로 저장.
 *
 * ── 삭제(DELETE) 대상 — 학습맵 status / 성취 / 오답노트 / 오늘의학습 / self-learn 을 직접 구동하는 학습 흔적 ──
 *   user_node_status          (학습맵 노드 status — map/nodes 가 이 테이블만 본다)
 *   problem_attempts          (문제풀이 기록 — map 진행률 is_correct 산출)
 *   user_content_progress     (영상 시청 watch_ratio — map 진행률 산출)
 *   daily_learning_progress   (오늘의학습 학생 진행)
 *   daily_learning            (오늘의학습 per-user 목표/진행)
 *   diagnosis_sessions(+answers CASCADE)  (진단 세션/응답)
 *   wrong_answers             (오답노트 — student_id 컬럼; auto/diagnosis/manual 전부)
 *   user_learning_list        (오늘의학습 담기 등 학습 목록)
 *   content_attempts          (콘텐츠 퀴즈 시도 결과/점수)
 *   content_progress          (콘텐츠 진행률)
 *   learning_paths            (AI 학습맵 생성 경로)
 *   lesson_self_check         (수업 자기점검 — 학습 회고)
 *   user_last_activity        (마지막 학습 활동 포인터)
 *
 * ── 보류(HOLD) — 백업만 하고 삭제하지 않음. 검증 surface 와 무관하거나 비학습 데이터가 혼재되어 위험 ──
 *   lrs_achievement_stats / lrs_std_node_stats / lrs_user_daily / lrs_user_summary / lrs_session_stats
 *       → LRS 분석 집계(별도 화면). 핵심 검증 surface(map/성취/오답/오늘학습) 와 무관.
 *   learning_logs / xapi_statement_spool
 *       → 원천 xAPI 이벤트 스트림. 학습(content_view 등)뿐 아니라 attendance/post/survey 등
 *         비학습 이벤트가 혼재 → 통삭제 시 비학습 흔적까지 삭제 위험.
 *   reading_logs / growth_goals / user_learn_settings
 *       → 독서기록/성장목표/학습설정. "학습 흔적"보다 프로필·생활기록 성격 → PM 확인 후 결정.
 *   class_mileage / class_mileage_log / user_points
 *       → 게이미피케이션 마일리지/포인트. 출석·과제·갤러리 등 비학습 사유도 합산 → 보존.
 *   problem_sets / problem_set_items / problem_set_attempts
 *       → 학생 본인이 만든 "내 문제집". 단, user3 의 problem_set #1 을 타 사용자(1,2)가 풀어
 *         problem_set_attempts(FK NO ACTION)가 가리키고 있음 → 삭제 시 타 사용자 데이터 orphan/FK 위반.
 *         "타 사용자 미접근" 원칙상 삭제 불가 → 보류. (map/성취/오답/오늘학습 surface 와도 무관.)
 *
 * 실행:
 *   (서버가 DB 를 WAL 로 공유하므로 기동 중에도 동작하나, 안전을 위해 정지 후 권장)
 *   node scripts/cleanup-student1-learning-reset.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TARGET_USER_ID = 3; // student1 (이학생)
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-'); // 파일명 안전
const BACKUP_PATH = path.join(BACKUP_DIR, `student1-learning-snapshot-${STAMP}.json`);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON'); // diagnosis_answers ON DELETE CASCADE 적용

console.log('=== student1(user_id=3) 학습 흔적 완전 초기화 시작 ===');
console.log('DB:', DB_PATH);
console.log('대상 user_id:', TARGET_USER_ID);

// 테이블별 (user-ref 컬럼) 정의 — 백업·삭제·검증 공통 사용
const DELETE_TABLES = [
  { table: 'user_node_status',        col: 'user_id' },
  { table: 'problem_attempts',        col: 'user_id' },
  { table: 'user_content_progress',   col: 'user_id' },
  { table: 'daily_learning_progress', col: 'user_id' },
  { table: 'daily_learning',          col: 'user_id' },
  { table: 'diagnosis_sessions',      col: 'user_id' },
  { table: 'wrong_answers',           col: 'student_id' },
  { table: 'user_learning_list',      col: 'user_id' },
  { table: 'content_attempts',        col: 'user_id' },
  { table: 'content_progress',        col: 'user_id' },
  { table: 'learning_paths',          col: 'user_id' },
  { table: 'lesson_self_check',       col: 'user_id' },
  { table: 'user_last_activity',      col: 'user_id' },
];

// 자식(child) 테이블 — 부모 user3 행을 통해 백업·삭제
const CHILD_TABLES = [
  { table: 'diagnosis_answers', via: 'SELECT * FROM diagnosis_answers WHERE session_id IN (SELECT id FROM diagnosis_sessions WHERE user_id = ?)' },
];

// HOLD — 백업만, 삭제 안 함
const HOLD_TABLES = [
  { table: 'lrs_achievement_stats',  col: 'user_id' },
  { table: 'lrs_std_node_stats',     col: 'user_id' },
  { table: 'lrs_user_daily',         col: 'user_id' },
  { table: 'lrs_user_summary',       col: 'user_id' },
  { table: 'lrs_session_stats',      col: 'user_id' },
  { table: 'learning_logs',          col: 'user_id' },
  { table: 'xapi_statement_spool',   col: 'user_id' },
  { table: 'reading_logs',           col: 'user_id' },
  { table: 'growth_goals',           col: 'user_id' },
  { table: 'user_learn_settings',    col: 'user_id' },
  { table: 'class_mileage',          col: 'user_id' },
  { table: 'class_mileage_log',      col: 'user_id' },
  { table: 'user_points',            col: 'user_id' },
  { table: 'problem_sets',           col: 'user_id' },
  { table: 'problem_set_attempts',   col: 'user_id' },
];

// 보존(PRESERVE) 검증용 — 정리 전/후 행수가 불변이어야 하는 비학습 테이블
const PRESERVE_TABLES = [
  { table: 'users',           col: 'id' },          // 계정
  { table: 'class_members',   col: 'user_id' },     // 클래스 멤버십
  { table: 'attendance',      col: 'user_id' },     // 출석
  { table: 'emotion_checkins',col: 'user_id' },     // 정서 체크인
  { table: 'posts',           col: 'author_id' },   // 게시판
  { table: 'messages',        col: 'sender_id' },   // 쪽지
];

function rows(table, col) {
  return db.prepare(`SELECT * FROM "${table}" WHERE "${col}" = ?`).all(TARGET_USER_ID);
}
function rowsVia(sql) {
  return db.prepare(sql).all(TARGET_USER_ID);
}
function count(table, col) {
  return db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" = ?`).get(TARGET_USER_ID).c;
}

// ── 1. 백업 (삭제 + 자식 + HOLD 전부) ────────────────────────────
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const snapshot = {
  meta: {
    purpose: 'student1(user_id=3) 학습 흔적 완전 초기화 전 백업',
    target_user_id: TARGET_USER_ID,
    db_path: DB_PATH,
    taken_at: new Date().toISOString(),
  },
  delete_tables: {},
  child_tables: {},
  hold_tables: {},
};
for (const { table, col } of DELETE_TABLES) snapshot.delete_tables[table] = rows(table, col);
for (const { table, via } of CHILD_TABLES) snapshot.child_tables[table] = rowsVia(via);
for (const { table, col } of HOLD_TABLES) snapshot.hold_tables[table] = rows(table, col);
fs.writeFileSync(BACKUP_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
console.log('\n[백업 완료]', BACKUP_PATH);
const bkSummary = {};
for (const k of Object.keys(snapshot.delete_tables)) bkSummary[k] = snapshot.delete_tables[k].length;
for (const k of Object.keys(snapshot.child_tables)) bkSummary['(child)' + k] = snapshot.child_tables[k].length;
for (const k of Object.keys(snapshot.hold_tables)) bkSummary['(hold)' + k] = snapshot.hold_tables[k].length;
console.log('백업 행수:', JSON.stringify(bkSummary, null, 2));

// ── 2. 정리 전 행수 ─────────────────────────────────────────────
const before = {};
for (const { table, col } of DELETE_TABLES) before[table] = count(table, col);
before['(child)diagnosis_answers'] = rowsVia(CHILD_TABLES[0].via).length;
const preserveBefore = {};
for (const { table, col } of PRESERVE_TABLES) preserveBefore[table] = count(table, col);
const holdBefore = {};
for (const { table, col } of HOLD_TABLES) holdBefore[table] = count(table, col);

// 타 사용자(2,4) 학습데이터 불변 확인용 — 대표 테이블 행수
function countUser(table, col, uid) {
  return db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" = ?`).get(uid).c;
}
// 타 사용자(1,2)가 user3 의 problem_set 을 푼 attempt 가 보존되는지(orphan/삭제 안 됨) 확인
function attemptsOnUser3Sets() {
  return db.prepare(
    'SELECT COUNT(*) c FROM problem_set_attempts psa JOIN problem_sets ps ON psa.problem_set_id = ps.id WHERE ps.user_id = 3'
  ).get().c;
}
const otherBefore = {
  user2_user_node_status: countUser('user_node_status', 'user_id', 2),
  user2_problem_attempts: countUser('problem_attempts', 'user_id', 2),
  user2_wrong_answers: countUser('wrong_answers', 'student_id', 2),
  user4_user_node_status: countUser('user_node_status', 'user_id', 4),
  user4_problem_attempts: countUser('problem_attempts', 'user_id', 4),
  user4_wrong_answers: countUser('wrong_answers', 'student_id', 4),
  attempts_on_user3_sets: attemptsOnUser3Sets(),
};

console.log('\n[정리 전 — 삭제대상 행수(user3)]');
console.log(JSON.stringify(before, null, 2));

// ── 3. 삭제 (단일 트랜잭션) ─────────────────────────────────────
const tx = db.transaction(() => {
  // diagnosis_answers 는 CASCADE 지만 명시 삭제도 안전(현재 0행).
  db.prepare('DELETE FROM diagnosis_answers WHERE session_id IN (SELECT id FROM diagnosis_sessions WHERE user_id = ?)').run(TARGET_USER_ID);
  for (const { table, col } of DELETE_TABLES) {
    db.prepare(`DELETE FROM "${table}" WHERE "${col}" = ?`).run(TARGET_USER_ID);
  }
});
tx();

// ── 4. 정리 후 검증 ─────────────────────────────────────────────
const after = {};
for (const { table, col } of DELETE_TABLES) after[table] = count(table, col);
after['(child)diagnosis_answers'] = rowsVia(CHILD_TABLES[0].via).length;
const preserveAfter = {};
for (const { table, col } of PRESERVE_TABLES) preserveAfter[table] = count(table, col);
const holdAfter = {};
for (const { table, col } of HOLD_TABLES) holdAfter[table] = count(table, col);
const otherAfter = {
  user2_user_node_status: countUser('user_node_status', 'user_id', 2),
  user2_problem_attempts: countUser('problem_attempts', 'user_id', 2),
  user2_wrong_answers: countUser('wrong_answers', 'student_id', 2),
  user4_user_node_status: countUser('user_node_status', 'user_id', 4),
  user4_problem_attempts: countUser('problem_attempts', 'user_id', 4),
  user4_wrong_answers: countUser('wrong_answers', 'student_id', 4),
  attempts_on_user3_sets: attemptsOnUser3Sets(),
};

console.log('\n[정리 후 — 삭제대상 행수(user3)]');
console.log(JSON.stringify(after, null, 2));

const dist = db.prepare(
  'SELECT status, COUNT(*) c FROM user_node_status WHERE user_id = ? GROUP BY status'
).all(TARGET_USER_ID);
console.log('\n[정리 후 user_node_status status 분포(user3)] — 전부 비어야 함');
console.log(JSON.stringify(dist, null, 2));

// 검증: 보존 불변
let preserveOK = true;
for (const k of Object.keys(preserveBefore)) {
  if (preserveBefore[k] !== preserveAfter[k]) { preserveOK = false; console.log('  !! 보존 변경:', k, preserveBefore[k], '->', preserveAfter[k]); }
}
let holdOK = true;
for (const k of Object.keys(holdBefore)) {
  if (holdBefore[k] !== holdAfter[k]) { holdOK = false; console.log('  !! HOLD 변경:', k, holdBefore[k], '->', holdAfter[k]); }
}
let otherOK = true;
for (const k of Object.keys(otherBefore)) {
  if (otherBefore[k] !== otherAfter[k]) { otherOK = false; console.log('  !! 타사용자 변경:', k, otherBefore[k], '->', otherAfter[k]); }
}

console.log('\n[보존 검증]');
console.log('  비학습 보존 테이블 불변:', preserveOK ? 'OK' : '!! 변경됨');
console.log('  HOLD 테이블 불변:', holdOK ? 'OK' : '!! 변경됨');
console.log('  타 사용자(2,4) 학습데이터 불변:', otherOK ? 'OK' : '!! 변경됨');
console.log('  PRESERVE 행수:', JSON.stringify(preserveAfter));
console.log('  HOLD 행수:', JSON.stringify(holdAfter));
console.log('  OTHER 행수:', JSON.stringify(otherAfter));

db.close();
console.log('\n=== 학습 흔적 완전 초기화 완료 ===');
