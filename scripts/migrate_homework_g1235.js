require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 다채움 과제 페이지 갭 시공 — G1/G2/G3/G5 DB 마이그레이션
 *
 * 추가 컬럼:
 *   homework
 *     - start_date         TEXT  DEFAULT NULL  (G5 예약 과제, 'YYYY-MM-DD')
 *     - attachments        TEXT  DEFAULT NULL  (G3 교사 첨부, JSON 배열)
 *
 *   homework_submissions
 *     - is_draft           INTEGER DEFAULT 0  (G1 임시저장 플래그)
 *     - draft_content      TEXT    DEFAULT NULL
 *     - draft_attachments  TEXT    DEFAULT NULL  (JSON 배열)
 *     - draft_updated_at   TEXT    DEFAULT NULL
 *     - attachments        TEXT    DEFAULT NULL  (G2 멀티미디어 제출, JSON 배열)
 *
 * 실행:
 *   node scripts/migrate_homework_g1235.js
 *
 * Idempotent: 이미 존재하는 컬럼은 skip.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);

console.log('=== 다채움 과제 G1/G2/G3/G5 마이그레이션 시작 ===');
console.log('DB:', DB_PATH);

function tableCols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addColumnIfMissing(table, columnName, ddl) {
  const cols = tableCols(table);
  if (cols.includes(columnName)) {
    console.log(`  - SKIP ${table}.${columnName} (이미 존재)`);
    return false;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`  + ADD  ${table}.${columnName}`);
  return true;
}

let added = 0;

// ----- homework -----
console.log('\n[homework]');
if (addColumnIfMissing('homework', 'start_date', 'start_date TEXT DEFAULT NULL')) added++;
if (addColumnIfMissing('homework', 'attachments', 'attachments TEXT DEFAULT NULL')) added++;

// ----- homework_submissions -----
console.log('\n[homework_submissions]');
if (addColumnIfMissing('homework_submissions', 'is_draft', 'is_draft INTEGER DEFAULT 0')) added++;
if (addColumnIfMissing('homework_submissions', 'draft_content', 'draft_content TEXT DEFAULT NULL')) added++;
if (addColumnIfMissing('homework_submissions', 'draft_attachments', 'draft_attachments TEXT DEFAULT NULL')) added++;
if (addColumnIfMissing('homework_submissions', 'draft_updated_at', 'draft_updated_at TEXT DEFAULT NULL')) added++;
if (addColumnIfMissing('homework_submissions', 'attachments', 'attachments TEXT DEFAULT NULL')) added++;

// 인덱스(예약 공개 조회 가속)
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_homework_start_date ON homework(class_id, start_date)");
  console.log('\n  + INDEX idx_homework_start_date');
} catch (e) {
  console.log('  - INDEX skip:', e.message);
}

console.log(`\n=== 완료. 추가된 컬럼: ${added}개 ===`);

// 검증 출력
console.log('\n[검증] homework 컬럼:');
console.log('  ', tableCols('homework').join(', '));
console.log('[검증] homework_submissions 컬럼:');
console.log('  ', tableCols('homework_submissions').join(', '));

db.close();
