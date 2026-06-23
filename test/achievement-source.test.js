// test/achievement-source.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 결함 A·B 회귀/불변식 하네스 (격리 DB).
//
//   결함 A — 자기주도 problem_attempt 가 성취 히트맵에 반영 안 됨:
//     recordProblemAttempt → logLearningActivity 에 achievement_code/subject_code 누락
//     → learning_logs.achievement_code = NULL → rebuildAllAggregates 가
//     WHERE achievement_code IS NOT NULL 로만 집계 → mastery 에 영원히 안 잡힘.
//     fix: resolveAchievementForAttempt(nodeId, contentId) 로 괄호형 코드 해석 후 주입.
//
//   결함 B — 저장 level 임계 ≠ mastery API:
//     lrs_achievement_stats 재집계가 avg_score 기반 CASE SQL 로 level 산출 →
//     avg_score IS NULL 인데 success/attempt 가 미도달인 행이 'insufficient' 로 박혀
//     mastery API(success/attempt 기반) 와 어긋남(2020행).
//     fix: 재집계를 집계-INSERT + 단일 분류기(classifyStatus/reachRate/STATUS_KO) UPDATE 로 통일.
//
//   DB 격리: 실 DB → 임시 복사본. initSchema()로 마이그레이션 후 rebuild.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();                          // ★ db require 전에 DB_PATH 주입
require('../db/schema').initSchema();   // 격리 DB에도 std_id·level 컬럼 마이그레이션

const selfLearn = require('../db/self-learn-extended');
const { rebuildAllAggregates } = require('../db/lrs-aggregate');
const { classifyStatus, reachRate, STATUS_KO } = require('../db/lrs-mastery');
const db = openTestDb();

// 실측으로 고른 테스트 픽스처 (probe 로 확인):
//   - 매핑 있는 node: achievement_code 비어있지 않은 node_id 1개
//   - content (코드/매핑 없는): null 유지 검증용
function pickMappedNode() {
  return db.prepare(
    "SELECT node_id, achievement_code FROM learning_map_nodes WHERE achievement_code IS NOT NULL AND achievement_code <> '' LIMIT 1"
  ).get();
}
// 코드도 없고 코드매핑 node_contents 도 없는 content (null 유지 검증용)
function pickNoMapContent() {
  return db.prepare(`
    SELECT id FROM contents
    WHERE (achievement_code IS NULL OR achievement_code = '')
      AND id NOT IN (
        SELECT content_id FROM node_contents
        WHERE node_id IN (SELECT node_id FROM learning_map_nodes WHERE achievement_code IS NOT NULL AND achievement_code <> '')
      )
    LIMIT 1
  `).get();
}

// ──────────────────────────────────────────────────────────────────────────
// A-0: resolveAchievementForAttempt 헬퍼 단위 — 4우선순위 단언
// ──────────────────────────────────────────────────────────────────────────
test('A-0: resolveAchievementForAttempt — 매핑 있는 node → 괄호형, 없으면 null', () => {
  const mapped = pickMappedNode();
  assert.ok(mapped, '실 DB 에 achievement_code 가 있는 node 가 있어야 테스트 가능');
  const noMap = pickNoMapContent();
  assert.ok(noMap, '코드·매핑 없는 content 가 있어야 함');

  // 1) node 우선순위 — 매핑 있는 node → 괄호형 standard_code
  const viaNode = selfLearn.resolveAchievementForAttempt(mapped.node_id, noMap.id);
  assert.ok(viaNode && /^\[.*\]$/.test(viaNode), `node 경유 코드는 괄호형이어야 (got ${viaNode})`);
  assert.equal(viaNode, mapped.achievement_code, 'node.achievement_code 와 동일해야');

  // 2) content.achievement_code 경유
  const cWith = db.prepare("SELECT id, achievement_code FROM contents WHERE achievement_code IS NOT NULL AND achievement_code <> '' LIMIT 1").get();
  if (cWith) {
    const viaContent = selfLearn.resolveAchievementForAttempt(null, cWith.id);
    assert.equal(viaContent, String(cWith.achievement_code).trim(), 'content.achievement_code 경유 동일');
  }

  // 3) node_contents → node 경유
  const ncRow = db.prepare(`
    SELECT nc.content_id, lmn.achievement_code
    FROM node_contents nc JOIN learning_map_nodes lmn ON nc.node_id = lmn.node_id
    WHERE lmn.achievement_code IS NOT NULL AND lmn.achievement_code <> '' LIMIT 1
  `).get();
  if (ncRow) {
    const viaNc = selfLearn.resolveAchievementForAttempt(null, ncRow.content_id);
    assert.ok(viaNc && /^\[.*\]$/.test(viaNc), 'node_contents 경유 코드는 괄호형');
  }

  // 4) 매핑 전무 → null (억지 생성 금지)
  const none = selfLearn.resolveAchievementForAttempt('ZZZ_NOMAP', noMap.id);
  assert.equal(none, null, '매핑 없는 node + 코드없는 content → null 유지');
});

// ──────────────────────────────────────────────────────────────────────────
// A-1: 매핑 있는 node 로 problem_attempt → learning_logs.achievement_code NOT NULL(괄호형)
//      → rebuild → 해당 standard 의 attempt_count 증가
// ──────────────────────────────────────────────────────────────────────────
test('A-1: 자기주도 problem_attempt(매핑 node) → learning_logs 코드 주입 + rebuild 집계 반영', () => {
  const mapped = pickMappedNode();
  const noMap = pickNoMapContent();
  assert.ok(mapped && noMap);
  const code = mapped.achievement_code;

  // 사용 학생: student role 1명
  const stu = db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get();
  assert.ok(stu, 'student 계정 필요');
  const userId = stu.id;

  // fix 전 코드 주입 누락을 잡기 위해, 호출 직전 learning_logs 의 해당 code 행수 기록
  const beforeLogs = db.prepare(
    'SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND activity_type = ? AND achievement_code = ?'
  ).get(userId, 'problem_attempt', code).c;

  // 매핑 있는 node + (코드없는) content 로 풀이 1건 (정답)
  //   content 는 코드/매핑이 없어 node 우선순위로만 코드가 잡혀야 함(경로 격리)
  const r = selfLearn.recordProblemAttempt(userId, noMap.id, { isCorrect: true, nodeId: mapped.node_id });
  assert.ok(r && r.attempt_id, 'problem_attempt 기록 성공');

  // learning_logs 에 achievement_code(괄호형) 주입 확인
  const lastLog = db.prepare(
    "SELECT achievement_code, subject_code FROM learning_logs WHERE user_id = ? AND activity_type = 'problem_attempt' ORDER BY id DESC LIMIT 1"
  ).get(userId);
  assert.ok(lastLog, 'problem_attempt 로그 존재');
  assert.ok(lastLog.achievement_code, 'achievement_code 가 NULL 이 아니어야 (결함 A)');
  assert.ok(/^\[.*\]$/.test(lastLog.achievement_code), `괄호형이어야 (got ${lastLog.achievement_code})`);
  assert.equal(lastLog.achievement_code, code, 'node 의 코드와 동일해야');
  assert.ok(lastLog.subject_code, 'subject_code 도 해석돼 채워져야');

  const afterLogs = db.prepare(
    'SELECT COUNT(*) c FROM learning_logs WHERE user_id = ? AND activity_type = ? AND achievement_code = ?'
  ).get(userId, 'problem_attempt', code).c;
  assert.equal(afterLogs, beforeLogs + 1, 'learning_logs 에 코드 달린 problem_attempt 1건 증가');

  // rebuild → mastery 집계 테이블에 잡히는지
  rebuildAllAggregates();
  const stat = db.prepare(
    'SELECT attempt_count FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(userId, code);
  assert.ok(stat, '해당 standard 의 집계행이 존재해야 (자기주도 풀이가 히트맵에 반영)');
  assert.ok(stat.attempt_count >= 1, `attempt_count >= 1 이어야 (got ${stat && stat.attempt_count})`);
});

// ──────────────────────────────────────────────────────────────────────────
// A-2: 매핑 없는 node → learning_logs.achievement_code IS NULL 유지 (억지 생성 금지)
// ──────────────────────────────────────────────────────────────────────────
test('A-2: 매핑 없는 node 로 problem_attempt → learning_logs.achievement_code NULL 유지', () => {
  const noMap = pickNoMapContent();
  assert.ok(noMap);
  const stu = db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get();
  const userId = stu.id;

  // 존재하지 않는 node + 코드/매핑 없는 content → 어떤 우선순위로도 코드 못 구함
  const r = selfLearn.recordProblemAttempt(userId, noMap.id, { isCorrect: false, nodeId: 'ZZZ_NOMAP' });
  assert.ok(r && r.attempt_id, '기록 성공');

  const lastLog = db.prepare(
    "SELECT achievement_code FROM learning_logs WHERE user_id = ? AND activity_type = 'problem_attempt' ORDER BY id DESC LIMIT 1"
  ).get(userId);
  assert.ok(lastLog, '로그 존재');
  assert.equal(lastLog.achievement_code, null, '매핑 없으면 achievement_code 는 NULL 이어야 (억지 생성 금지)');
});

// ──────────────────────────────────────────────────────────────────────────
// B: 불변식 — rebuild 후 저장 level/last_level === 단일 분류기 (전수 위반 0)
// ──────────────────────────────────────────────────────────────────────────
test('B: rebuild 후 lrs_achievement_stats.level === classifyStatus(단일 분류기) 전수 일치', () => {
  rebuildAllAggregates();
  const rows = db.prepare(
    'SELECT id, attempt_count, success_count, avg_score, level, last_level FROM lrs_achievement_stats'
  ).all();
  assert.ok(rows.length > 0, '집계행이 있어야 검증 의미 있음');

  let levelMismatch = 0;
  let koMismatch = 0;
  for (const r of rows) {
    const rate = reachRate(r.success_count, r.attempt_count, r.avg_score);
    const status = classifyStatus(r.attempt_count, rate);
    if (r.level !== status) levelMismatch++;
    if (r.last_level !== STATUS_KO[status]) koMismatch++;
  }
  assert.equal(levelMismatch, 0, `stored level !== classifyStatus 위반 ${levelMismatch}행 (fix 전엔 2020 이었음)`);
  assert.equal(koMismatch, 0, `stored last_level !== STATUS_KO 위반 ${koMismatch}행`);
});

// ──────────────────────────────────────────────────────────────────────────
// B-2: 핵심 경계 — avg_score NULL 이고 attempt 多·success 0 → not_reached (insufficient 아님)
//      (결함 B 의 실제 결함 형태를 재현하는 합성 행으로 분류기 통일 검증)
// ──────────────────────────────────────────────────────────────────────────
test('B-2: avg_score NULL & attempt>=3 & success 0 → 저장 level=not_reached(미도달), insufficient 아님', () => {
  // 합성 행 삽입: avg_score NULL, attempt_count 91, success 0 (결함 B 의 2020행 형태)
  //   user_id/achievement_code 는 충돌 없는 합성값.
  const synthUser = 999999;
  const synthCode = '[ZZ테스트01-01]';
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?').run(synthUser, synthCode);
  db.prepare(`
    INSERT INTO lrs_achievement_stats (user_id, achievement_code, attempt_count, success_count, avg_score, level, last_level)
    VALUES (?, ?, 91, 0, NULL, 'WRONG', '엉터리')
  `).run(synthUser, synthCode);

  // 분류기 기대값: rate = 0/91 = 0 → att>=3 & rate<50 → not_reached
  const rate = reachRate(0, 91, null);
  const expected = classifyStatus(91, rate);
  assert.equal(expected, 'not_reached', '분류기상 att91·success0 → not_reached 여야 (avg NULL 폴백 무시)');

  // 직접 UPDATE 루프(rebuild 의 7-classify 와 동일 산식)를 합성행에 적용해 통일성 확인
  const r = db.prepare('SELECT id, attempt_count, success_count, avg_score FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?').get(synthUser, synthCode);
  const status = classifyStatus(r.attempt_count, reachRate(r.success_count, r.attempt_count, r.avg_score));
  db.prepare('UPDATE lrs_achievement_stats SET level = ?, last_level = ? WHERE id = ?').run(status, STATUS_KO[status], r.id);
  const after = db.prepare('SELECT level, last_level FROM lrs_achievement_stats WHERE id = ?').get(r.id);
  assert.equal(after.level, 'not_reached', '단일 분류기 적용 후 not_reached');
  assert.equal(after.last_level, '미도달', "last_level 은 STATUS_KO['not_reached'] = '미도달'");

  // 정리
  db.prepare('DELETE FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?').run(synthUser, synthCode);
});

// ──────────────────────────────────────────────────────────────────────────
// 추가 결함 (히트맵 반영 갭 2건) — 오늘의 학습 완료 / 오답노트 재풀이
//   배경: logLearningActivity 는 호출부가 명시한 achievement_code 만 기록한다.
//     · daily_complete (completeDailyItem)  : 코드 미주입 → 실측 0/19 → 히트맵 누락
//     · wrong_note_retry (retryWrongNote)   : 코드 미주입 → 원문항 성취기준 누락
//   fix: 두 곳 모두 resolveAchievementForAttempt(...) 로 해석해 주입.
//        daily 는 item.node_id/content_id, retry 는 note.content_id 경유.
//        매핑 없으면 null 유지(억지 생성 금지). 단일 분류기로 자동 집계.
// ──────────────────────────────────────────────────────────────────────────

// 코드 해석 가능한 content 1개 (content.achievement_code 또는 node_contents→node 경유)
function pickMappedContent() {
  const direct = db.prepare(
    "SELECT id, achievement_code FROM contents WHERE achievement_code IS NOT NULL AND achievement_code <> '' LIMIT 1"
  ).get();
  if (direct) return { id: direct.id, code: String(direct.achievement_code).trim() };
  const viaNc = db.prepare(`
    SELECT nc.content_id AS id, lmn.achievement_code AS code
    FROM node_contents nc JOIN learning_map_nodes lmn ON nc.node_id = lmn.node_id
    WHERE lmn.achievement_code IS NOT NULL AND lmn.achievement_code <> '' LIMIT 1
  `).get();
  return viaNc ? { id: viaNc.id, code: String(viaNc.code).trim() } : null;
}

// ── 갭 A-1: 매핑된 daily item 완료 → learning_logs.achievement_code NOT NULL(원문항 기준) ──
test('갭 A: 매핑된 오늘의 학습 item 완료 → daily_complete 로그에 achievement_code 주입', () => {
  const c = pickMappedContent();
  assert.ok(c, '코드 해석 가능한 content 가 있어야 테스트 가능');
  const expected = selfLearn.resolveAchievementForAttempt(null, c.id);
  assert.ok(expected, 'resolveAchievementForAttempt 로 해석되는 content 여야');

  const stu = db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get();
  const userId = stu.id;
  const teacher = db.prepare("SELECT id FROM users WHERE role = 'teacher' ORDER BY id LIMIT 1").get() || stu;

  // 격리 픽스처: 세트 + (코드 content 연결) item + pending progress 행 시드
  const setInfo = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, is_active, target_date)
    VALUES (NULL, ?, '[테스트] 갭A 세트', 1, DATE('now'))
  `).run(teacher.id);
  const setId = setInfo.lastInsertRowid;
  const itemInfo = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, content_id, node_id, item_title, sort_order)
    VALUES (?, 'content', ?, NULL, '[테스트] 갭A 문항', 1)
  `).run(setId, c.id);
  const itemId = itemInfo.lastInsertRowid;
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, started_at)
    VALUES (?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)
  `).run(userId, itemId, setId);

  const res = selfLearn.completeDailyItem(itemId, userId, { score: 100, timeSpent: 30 });
  assert.ok(res && res.success && !res.alreadyCompleted, '최초 완료 처리 성공');

  const log = db.prepare(
    "SELECT achievement_code, subject_code FROM learning_logs WHERE user_id = ? AND activity_type = 'daily_complete' AND target_id = ? ORDER BY id DESC LIMIT 1"
  ).get(userId, String(itemId));
  assert.ok(log, 'daily_complete 로그 존재');
  assert.ok(log.achievement_code, 'achievement_code 가 NULL 이 아니어야 (갭 A)');
  assert.equal(log.achievement_code, expected, 'item content 기준 코드와 동일해야');
  assert.ok(/^\[.*\]$/.test(log.achievement_code), `괄호형이어야 (got ${log.achievement_code})`);
  assert.ok(log.subject_code, 'subject_code 도 해석돼 채워져야');

  // realtime 으로 lrs_achievement_stats 에 해당 기준 행/attempt 반영
  const stat = db.prepare(
    'SELECT attempt_count FROM lrs_achievement_stats WHERE user_id = ? AND achievement_code = ?'
  ).get(userId, expected);
  assert.ok(stat && stat.attempt_count >= 1, '오늘의 학습 완료가 히트맵 집계에 실시간 반영돼야');

  // 정리
  db.prepare('DELETE FROM daily_learning_progress WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM daily_learning_items WHERE id = ?').run(itemId);
  db.prepare('DELETE FROM daily_learning_sets WHERE id = ?').run(setId);
});

// ── 갭 A-2: 매핑 없는 daily item 완료 → achievement_code NULL 유지 (억지 생성 금지) ──
test('갭 A: 매핑 없는 오늘의 학습 item 완료 → achievement_code NULL 유지', () => {
  const noMap = pickNoMapContent();
  assert.ok(noMap, '코드·매핑 없는 content 필요');
  const stu = db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get();
  const userId = stu.id;
  const teacher = db.prepare("SELECT id FROM users WHERE role = 'teacher' ORDER BY id LIMIT 1").get() || stu;

  const setInfo = db.prepare(`
    INSERT INTO daily_learning_sets (class_id, teacher_id, title, is_active, target_date)
    VALUES (NULL, ?, '[테스트] 갭A nomap 세트', 1, DATE('now'))
  `).run(teacher.id);
  const setId = setInfo.lastInsertRowid;
  const itemInfo = db.prepare(`
    INSERT INTO daily_learning_items (set_id, source_type, content_id, node_id, item_title, sort_order)
    VALUES (?, 'content', ?, NULL, '[테스트] 갭A nomap 문항', 1)
  `).run(setId, noMap.id);
  const itemId = itemInfo.lastInsertRowid;
  db.prepare(`
    INSERT INTO daily_learning_progress (user_id, item_id, set_id, status, started_at)
    VALUES (?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)
  `).run(userId, itemId, setId);

  const res = selfLearn.completeDailyItem(itemId, userId, { score: 80, timeSpent: 20 });
  assert.ok(res && res.success, '완료 처리 성공');

  const log = db.prepare(
    "SELECT achievement_code FROM learning_logs WHERE user_id = ? AND activity_type = 'daily_complete' AND target_id = ? ORDER BY id DESC LIMIT 1"
  ).get(userId, String(itemId));
  assert.ok(log, '로그 존재');
  assert.equal(log.achievement_code, null, '매핑 없으면 achievement_code 는 NULL 이어야 (억지 생성 금지)');

  db.prepare('DELETE FROM daily_learning_progress WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM daily_learning_items WHERE id = ?').run(itemId);
  db.prepare('DELETE FROM daily_learning_sets WHERE id = ?').run(setId);
});

// ── 갭 B-1: content_id 매핑된 wrong_answer 재풀이 → achievement_code = 원문항 기준 ──
test('갭 B: content 매핑된 오답노트 재풀이 → wrong_note_retry 로그에 원문항 성취기준 주입', () => {
  const c = pickMappedContent();
  assert.ok(c, '코드 해석 가능한 content 필요');
  const expected = selfLearn.resolveAchievementForAttempt(null, c.id);
  assert.ok(expected, '해석 가능한 content 여야');

  const stu = db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get();
  const userId = stu.id;

  // content_id 가 달린 오답 1건 시드 (객관식 — 채점 가능하게 옵션/정답 단순화는 불필요: 정오 무관, 코드 주입만 검증)
  const waInfo = db.prepare(`
    INSERT INTO wrong_answers (student_id, question_text, student_answer, correct_answer, subject, source, content_id, is_resolved, attempt_count)
    VALUES (?, '[테스트] 갭B 문항', '오답', '정답', '수학', 'content', ?, 0, 0)
  `).run(userId, c.id);
  const noteId = waInfo.lastInsertRowid;

  const r = selfLearn.retryWrongNote(noteId, userId, { answer: '아무거나' });
  assert.ok(r && !r.forbidden, '재풀이 처리 성공(권한 OK)');

  const log = db.prepare(
    "SELECT achievement_code, subject_code FROM learning_logs WHERE user_id = ? AND activity_type = 'wrong_note_retry' AND target_id = ? ORDER BY id DESC LIMIT 1"
  ).get(userId, String(noteId));
  assert.ok(log, 'wrong_note_retry 로그 존재');
  assert.ok(log.achievement_code, 'achievement_code 가 NULL 이 아니어야 (갭 B)');
  assert.equal(log.achievement_code, expected, '원문항(content) 기준 코드와 동일해야');
  assert.ok(/^\[.*\]$/.test(log.achievement_code), `괄호형이어야 (got ${log.achievement_code})`);

  db.prepare('DELETE FROM wrong_answers WHERE id = ?').run(noteId);
});

// ── 갭 B-2: content_id 없는 wrong_answer 재풀이 → achievement_code NULL 유지 ──
test('갭 B: content 매핑 없는 오답노트 재풀이 → achievement_code NULL 유지', () => {
  const stu = db.prepare("SELECT id FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get();
  const userId = stu.id;

  // content_id NULL 인 오답 (수기 등록형 — 콘텐츠 미연결)
  const waInfo = db.prepare(`
    INSERT INTO wrong_answers (student_id, question_text, student_answer, correct_answer, subject, source, content_id, is_resolved, attempt_count)
    VALUES (?, '[테스트] 갭B nomap', '오답', '정답', '수학', 'manual', NULL, 0, 0)
  `).run(userId);
  const noteId = waInfo.lastInsertRowid;

  const r = selfLearn.retryWrongNote(noteId, userId, { answer: '아무거나' });
  assert.ok(r && !r.forbidden, '재풀이 처리 성공');

  const log = db.prepare(
    "SELECT achievement_code FROM learning_logs WHERE user_id = ? AND activity_type = 'wrong_note_retry' AND target_id = ? ORDER BY id DESC LIMIT 1"
  ).get(userId, String(noteId));
  assert.ok(log, '로그 존재');
  assert.equal(log.achievement_code, null, '매핑 없으면 achievement_code 는 NULL 이어야 (억지 생성 금지)');

  db.prepare('DELETE FROM wrong_answers WHERE id = ?').run(noteId);
});
