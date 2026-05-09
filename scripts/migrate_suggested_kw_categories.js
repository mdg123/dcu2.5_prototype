/**
 * 다채움 추천 키워드 카테고리 마스터 테이블 마이그레이션
 *
 * 사용자 요구 (기획서: 작업지시서/추천키워드_카테고리CRUD_및_다줄노출_기획서.md):
 *   - 자유 텍스트 카테고리 → 마스터 테이블 + soft 참조
 *   - 카테고리에 색·아이콘·정렬·노출대상(target_*) 메타 부여
 *   - 기존 4개 카테고리 시드 INSERT OR IGNORE
 *
 * 신설 테이블: suggested_kw_categories
 *
 * 실행:
 *   node scripts/migrate_suggested_kw_categories.js
 *
 * Idempotent: CREATE IF NOT EXISTS, INSERT OR IGNORE 시드.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('=== 다채움 추천 키워드 카테고리 마스터 마이그레이션 시작 ===');
console.log('DB:', DB_PATH);

// ----- 테이블 생성 -----
db.exec(`
  CREATE TABLE IF NOT EXISTS suggested_kw_categories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    slug            TEXT NOT NULL UNIQUE,
    description     TEXT,
    display_order   INTEGER DEFAULT 0,
    color           TEXT DEFAULT '#2563eb',
    icon            TEXT DEFAULT 'fa-bookmark',
    is_active       INTEGER DEFAULT 1,
    target_school_levels TEXT DEFAULT NULL,
    target_roles         TEXT DEFAULT NULL,
    target_grades        TEXT DEFAULT NULL,
    target_subjects      TEXT DEFAULT NULL,
    created_by      INTEGER,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
console.log('  + TABLE suggested_kw_categories (CREATE IF NOT EXISTS)');

db.exec(`CREATE INDEX IF NOT EXISTS idx_skc_active_order ON suggested_kw_categories (is_active, display_order, id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_skc_display_order ON suggested_kw_categories (display_order);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_skc_active ON suggested_kw_categories (is_active);`);
console.log('  + INDEX idx_skc_active_order');
console.log('  + INDEX idx_skc_display_order');
console.log('  + INDEX idx_skc_active');

// ----- 시드 데이터 (기획서 D 섹션 — A.4 시드와 동일) -----
const SEED = [
  { name: '교과 학습',   slug: 'subject',   display_order: 100, color: '#2563eb', icon: 'fa-book',         description: '교과·영역 키워드' },
  { name: '시리즈·기획', slug: 'series',    display_order: 200, color: '#8b5cf6', icon: 'fa-layer-group',  description: '연재·기획전 시리즈' },
  { name: '도구·자료',   slug: 'resources', display_order: 300, color: '#10b981', icon: 'fa-toolbox',      description: '활동지·평가 자료' },
  { name: '시기·테마',   slug: 'theme',     display_order: 400, color: '#f59e0b', icon: 'fa-calendar-alt', description: '시기별 교육 테마' },
  { name: '기타',        slug: 'misc',      display_order: 900, color: '#6b7280', icon: 'fa-ellipsis-h',   description: '미분류' },
];

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO suggested_kw_categories
    (name, slug, description, display_order, color, icon, is_active, created_by)
  VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
`);

let inserted = 0;
const tx = db.transaction((rows) => {
  for (const row of rows) {
    const r = insertStmt.run(row.name, row.slug, row.description, row.display_order, row.color, row.icon);
    if (r.changes > 0) inserted++;
  }
});
tx(SEED);

const total = db.prepare('SELECT COUNT(*) AS c FROM suggested_kw_categories').get().c;
const active = db.prepare('SELECT COUNT(*) AS c FROM suggested_kw_categories WHERE is_active = 1').get().c;
console.log(`\n=== 시드 결과: 신규 INSERT ${inserted}건 / 시드 후보 ${SEED.length}건 ===`);
console.log(`=== 테이블 총 ${total}건 (활성 ${active}건) ===\n`);

// ----- 검증 출력 -----
console.log('[검증] 카테고리 마스터 목록 (display_order ASC):');
const list = db.prepare(`
  SELECT id, name, slug, display_order, color, icon, is_active
  FROM suggested_kw_categories
  ORDER BY display_order ASC, id ASC
`).all();
for (const c of list) {
  console.log(`  - id=${c.id} order=${c.display_order} ${c.name} (slug=${c.slug}, color=${c.color}, icon=${c.icon}, active=${c.is_active})`);
}

// ----- suggested_keywords.category 와 마스터 정합성 검증 -----
const skExists = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='suggested_keywords'`
).get();
if (skExists) {
  console.log('\n[검증] suggested_keywords.category 의 distinct 값 vs 마스터 name:');
  const distinctCats = db.prepare(`
    SELECT DISTINCT COALESCE(category, '기타') AS category, COUNT(*) AS cnt
    FROM suggested_keywords
    GROUP BY COALESCE(category, '기타')
    ORDER BY cnt DESC
  `).all();
  const masterNames = new Set(list.map(c => c.name));
  for (const c of distinctCats) {
    const inMaster = masterNames.has(c.category);
    console.log(`  - ${c.category}: ${c.cnt}건  ${inMaster ? 'OK(마스터에 존재)' : '! 마스터에 없음 (자동 생성 대상)'}`);
  }
} else {
  console.log('\n[검증] suggested_keywords 테이블이 없어 정합성 검사 생략. 먼저 migrate_suggested_keywords.js 실행을 권장합니다.');
}

db.close();
console.log('\n=== 마이그레이션 완료 ===');
