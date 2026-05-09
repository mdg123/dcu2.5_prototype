/**
 * 다채움 과제 표시 모드(display_mode) 마이그레이션
 *
 * 사용자 요구:
 *   - 교사가 과제 만들 때 표시 방식 선택: 리스트형(기본) / 댓글형
 *   - 댓글형: 학생이 댓글처럼 가볍게 답하고, 시간순 댓글 스레드 표시
 *
 * 추가 컬럼:
 *   homework
 *     - display_mode TEXT DEFAULT 'list'   ('list' | 'comment')
 *
 * 실행:
 *   node scripts/migrate_homework_display_mode.js
 *
 * Idempotent: 이미 존재하는 컬럼은 skip.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);

console.log('=== 다채움 과제 display_mode 마이그레이션 시작 ===');
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
if (addColumnIfMissing('homework', 'display_mode', "display_mode TEXT DEFAULT 'list'")) added++;

// 기존 NULL 행이 있다면 'list'로 백필 (DEFAULT는 새 행에만 적용)
const backfill = db.prepare(
  "UPDATE homework SET display_mode = 'list' WHERE display_mode IS NULL OR display_mode = ''"
).run();
if (backfill.changes > 0) {
  console.log(`  ~ BACKFILL homework.display_mode='list' (${backfill.changes}행)`);
}

console.log(`\n=== 완료. 추가된 컬럼: ${added}개 ===`);

// 검증 출력
console.log('\n[검증] homework 컬럼:');
console.log('  ', tableCols('homework').join(', '));

const sample = db.prepare("SELECT id, title, display_mode FROM homework ORDER BY id DESC LIMIT 3").all();
console.log('[검증] 최근 과제 3건:');
for (const r of sample) {
  console.log(`  - id=${r.id} display_mode=${JSON.stringify(r.display_mode)} title=${r.title}`);
}

db.close();
