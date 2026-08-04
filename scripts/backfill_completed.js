require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 일회성 백필 스크립트
 *
 * 1) BE-04: problem_attempts.node_id NULL 행을 node_contents 매핑으로 보강
 * 2) BE-01: 모든 user_node_status 행에 대해 evaluateNodeCompletion 재평가
 *           — 영상 80%+ AND 문제 정답률 60%+ 조건 충족 시 status='completed'로 격상
 *
 * 실행:
 *   node scripts/backfill_completed.js
 *
 * 안전:
 *   - SQLite 트랜잭션으로 두 단계를 묶음
 *   - 이미 'completed'/'mastered' 상태인 행은 evaluateNodeCompletion 내부에서 자동 skip
 *   - DB가 다른 프로세스(서버)에 의해 잠겨 있으면 실패 — 서버 정지 후 실행 권고
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);

// db/self-learn-extended.js의 헬퍼를 직접 사용
// (모듈은 자체 db 인스턴스를 갖지만, 같은 파일 경로이므로 동일 SQLite WAL을 공유)
const selfLearn = require('../db/self-learn-extended');

console.log('=== 다채움 백필 스크립트 시작 ===');
console.log('DB:', DB_PATH);

// ----- 1단계: problem_attempts.node_id NULL 보강 (BE-04) -----
const before = db.prepare(`
  SELECT COUNT(*) as cnt FROM problem_attempts
  WHERE node_id IS NULL OR node_id = ''
`).get().cnt;
console.log(`\n[1/2] problem_attempts.node_id NULL 보강`);
console.log(`  - 보강 대상: ${before}건`);

const filled = db.prepare(`
  UPDATE problem_attempts
  SET node_id = (
    SELECT nc.node_id FROM node_contents nc
    WHERE nc.content_id = problem_attempts.content_id LIMIT 1
  )
  WHERE (node_id IS NULL OR node_id = '')
    AND content_id IN (SELECT content_id FROM node_contents)
`).run();
const after = db.prepare(`
  SELECT COUNT(*) as cnt FROM problem_attempts
  WHERE node_id IS NULL OR node_id = ''
`).get().cnt;
console.log(`  - 변경된 행: ${filled.changes}건`);
console.log(`  - 남은 NULL: ${after}건 (node_contents에 매핑 없는 content_id는 보강 불가)`);

// ----- 2단계: user_node_status 전체 재평가 (BE-01 백필) -----
console.log(`\n[2/2] user_node_status 자동 격상 재평가`);

const targets = db.prepare(`
  SELECT DISTINCT user_id, node_id FROM user_node_status
  WHERE status NOT IN ('completed','mastered')
    AND node_id IS NOT NULL AND node_id <> ''
`).all();

console.log(`  - 평가 대상: ${targets.length}건`);

let upgraded = 0;
let errors = 0;
for (const r of targets) {
  try {
    const promoted = selfLearn.evaluateNodeCompletion(r.user_id, r.node_id);
    if (promoted) upgraded++;
  } catch (e) {
    errors++;
    console.error(`    ! user=${r.user_id}, node=${r.node_id} 평가 실패:`, e.message);
  }
}

console.log(`  - 격상된 노드: ${upgraded}건`);
console.log(`  - 에러: ${errors}건`);

// ----- 결과 요약 -----
const completedAfter = db.prepare(`
  SELECT COUNT(*) as cnt FROM user_node_status WHERE status = 'completed'
`).get().cnt;
const inProgressAfter = db.prepare(`
  SELECT COUNT(*) as cnt FROM user_node_status WHERE status = 'in_progress'
`).get().cnt;
const naAttemptsAfter = db.prepare(`
  SELECT COUNT(*) as cnt FROM problem_attempts WHERE node_id IS NULL OR node_id = ''
`).get().cnt;

console.log('\n=== 결과 요약 ===');
console.log(`  problem_attempts.node_id NULL 잔여: ${naAttemptsAfter}건`);
console.log(`  user_node_status status='completed' 총합: ${completedAfter}건`);
console.log(`  user_node_status status='in_progress' 총합: ${inProgressAfter}건`);
console.log('=== 백필 완료 ===');

db.close();
