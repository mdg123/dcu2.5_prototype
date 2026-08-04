require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 다채움 추천 키워드 — 대상별 노출 컬럼 추가 마이그레이션
 *
 * 사용자 요구:
 *   - 관리자에서 추천 키워드도 대상(학교급/역할/학년/교과)을 선택해서 노출
 *   - 추천콘텐츠(featured_sections)와 동일 패턴 채용
 *
 * 추가 컬럼 (모두 TEXT NULL — JSON 배열 또는 NULL=전체):
 *   - target_school_levels  TEXT  ['elementary'|'middle'|'high']
 *   - target_roles          TEXT  ['student'|'teacher'|'parent'|'staff'|'admin']
 *   - target_grades         TEXT  [1..12]
 *   - target_subjects       TEXT  ['국어'|'수학'|...]
 *
 * 정책:
 *   - NULL 또는 빈 배열 = 전체 노출 (모든 사용자)
 *   - 배열 지정 시 그 값에 매칭되는 사용자에게만 노출
 *   - 기존 23건은 NULL 그대로 → 모든 사용자에게 노출 (기본값)
 *
 * 실행:
 *   node scripts/migrate_suggested_keywords_target.js
 *
 * Idempotent: 이미 컬럼이 있으면 건너뛴다.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('=== 다채움 추천 키워드 — 대상별 노출 컬럼 추가 ===');
console.log('DB:', DB_PATH);

// 0. 테이블 존재 확인
const exists = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='suggested_keywords'`
).get();
if (!exists) {
  console.error('  ! suggested_keywords 테이블이 없습니다. scripts/migrate_suggested_keywords.js 를 먼저 실행하세요.');
  db.close();
  process.exit(1);
}

// 1. 기존 컬럼 목록 조회
const existingCols = db.prepare(`PRAGMA table_info(suggested_keywords)`).all().map(c => c.name);
console.log('  · 현재 컬럼:', existingCols.join(', '));

// 2. 4개 컬럼 추가 (이미 있으면 skip)
const addCols = [
  { name: 'target_school_levels', sql: `ALTER TABLE suggested_keywords ADD COLUMN target_school_levels TEXT DEFAULT NULL` },
  { name: 'target_roles',         sql: `ALTER TABLE suggested_keywords ADD COLUMN target_roles TEXT DEFAULT NULL` },
  { name: 'target_grades',        sql: `ALTER TABLE suggested_keywords ADD COLUMN target_grades TEXT DEFAULT NULL` },
  { name: 'target_subjects',      sql: `ALTER TABLE suggested_keywords ADD COLUMN target_subjects TEXT DEFAULT NULL` },
];

let addedCount = 0;
for (const col of addCols) {
  if (existingCols.includes(col.name)) {
    console.log(`  = ${col.name} (이미 존재 — skip)`);
  } else {
    db.exec(col.sql);
    console.log(`  + ${col.name} 컬럼 추가`);
    addedCount++;
  }
}

console.log(`\n=== 결과: 신규 컬럼 ${addedCount}건 추가 ===\n`);

// 3. 검증 — 기존 데이터 NULL 유지 확인
const totalRows = db.prepare(`SELECT COUNT(*) AS c FROM suggested_keywords`).get().c;
const nullRows = db.prepare(`
  SELECT COUNT(*) AS c FROM suggested_keywords
  WHERE target_school_levels IS NULL
    AND target_roles IS NULL
    AND target_grades IS NULL
    AND target_subjects IS NULL
`).get().c;
console.log(`[검증] 전체 ${totalRows}건 중 모든 target_* NULL인 행 = ${nullRows}건`);
console.log(`  · NULL = 전체 대상(모든 사용자에게 노출). 기존 데이터는 그대로 동작 보존.`);

// 4. 최종 스키마 출력
console.log('\n[검증] 최종 컬럼 목록:');
const finalCols = db.prepare(`PRAGMA table_info(suggested_keywords)`).all();
for (const c of finalCols) {
  const tag = ['target_school_levels', 'target_roles', 'target_grades', 'target_subjects'].includes(c.name) ? ' ← NEW' : '';
  console.log(`  - ${c.name} (${c.type}${c.dflt_value ? ', default=' + c.dflt_value : ''})${tag}`);
}

db.close();
console.log('\n=== 마이그레이션 완료 ===');
