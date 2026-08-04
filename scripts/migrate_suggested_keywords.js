require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 다채움 채움콘텐츠 추천 키워드 테이블 마이그레이션
 *
 * 사용자 요구:
 *   - 채움콘텐츠 페이지의 "추천 키워드" 칩을 관리자가 직접 입력·수정·삭제·정렬 관리
 *   - 자동 생성(인기 태그) 폐기 → 관리자가 넣은 만큼만 표시
 *   - 카테고리별 그룹화 노출
 *
 * 신설 테이블: suggested_keywords
 *
 * 실행:
 *   node scripts/migrate_suggested_keywords.js
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

console.log('=== 다채움 추천 키워드 테이블 마이그레이션 시작 ===');
console.log('DB:', DB_PATH);

// ----- 테이블 생성 -----
db.exec(`
  CREATE TABLE IF NOT EXISTS suggested_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    category TEXT DEFAULT '기타',
    search_query TEXT,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(keyword)
  );
`);
console.log('  + TABLE suggested_keywords (CREATE IF NOT EXISTS)');

db.exec(`CREATE INDEX IF NOT EXISTS idx_suggested_keywords_category_order ON suggested_keywords (category, display_order, id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_suggested_keywords_active ON suggested_keywords (is_active);`);
console.log('  + INDEX idx_suggested_keywords_category_order');
console.log('  + INDEX idx_suggested_keywords_active');

// ----- 시드 데이터 (디자이너 권고 도착 전 합리적 추측) -----
// 카테고리: 교과 학습 / 시리즈·기획 / 도구·자료 / 시기·테마
const SEED = [
  // 교과 학습 (display_order 1xx)
  { category: '교과 학습', keyword: '수학',           order: 110, q: '수학',         desc: '수학 교과 콘텐츠 보기' },
  { category: '교과 학습', keyword: '국어',           order: 120, q: '국어',         desc: '국어 교과 콘텐츠 보기' },
  { category: '교과 학습', keyword: '영어',           order: 130, q: '영어',         desc: '영어 교과 콘텐츠 보기' },
  { category: '교과 학습', keyword: '과학',           order: 140, q: '과학',         desc: '과학 교과 콘텐츠 보기' },
  { category: '교과 학습', keyword: '사회',           order: 150, q: '사회',         desc: '사회 교과 콘텐츠 보기' },
  { category: '교과 학습', keyword: '수와 연산',      order: 160, q: '수와 연산',    desc: '수학 영역 - 수와 연산' },
  { category: '교과 학습', keyword: '변화와 관계',    order: 170, q: '변화와 관계',  desc: '수학 영역 - 변화와 관계' },
  { category: '교과 학습', keyword: '도형과 측정',    order: 180, q: '도형과 측정',  desc: '수학 영역 - 도형과 측정' },
  { category: '교과 학습', keyword: '자료와 가능성',  order: 190, q: '자료와 가능성', desc: '수학 영역 - 자료와 가능성' },

  // 시리즈·기획 (display_order 2xx)
  { category: '시리즈·기획', keyword: '오늘의 영단어',     order: 210, q: '오늘의 영단어',   desc: '매일 한 단어 영어 시리즈' },
  { category: '시리즈·기획', keyword: '오늘의 책',         order: 220, q: '오늘의 책',       desc: '매일 한 권 추천 도서 시리즈' },
  { category: '시리즈·기획', keyword: '오늘의 맞춤법',     order: 230, q: '오늘의 맞춤법',   desc: '매일 한 가지 맞춤법 시리즈' },
  { category: '시리즈·기획', keyword: '디지털 리터러시',   order: 240, q: '디지털 리터러시', desc: '디지털 시민 역량 시리즈' },
  { category: '시리즈·기획', keyword: '다채움 예술온',     order: 250, q: '예술온',          desc: '다채움 예술 기획 시리즈' },

  // 도구·자료 (display_order 3xx)
  { category: '도구·자료', keyword: '평가문항',  order: 310, q: '평가문항', desc: '평가용 문항 자료' },
  { category: '도구·자료', keyword: '활동지',    order: 320, q: '활동지',   desc: '수업 활동지 자료' },
  { category: '도구·자료', keyword: '워크북',    order: 330, q: '워크북',   desc: '학습 워크북 자료' },
  { category: '도구·자료', keyword: '진단검사',  order: 340, q: '진단검사', desc: '진단 평가 자료' },

  // 시기·테마 (display_order 4xx)
  { category: '시기·테마', keyword: '진로교육',  order: 410, q: '진로교육', desc: '진로 탐색 교육 콘텐츠' },
  { category: '시기·테마', keyword: '보건교육',  order: 420, q: '보건교육', desc: '보건·건강 교육 콘텐츠' },
  { category: '시기·테마', keyword: '안전교육',  order: 430, q: '안전교육', desc: '안전 교육 콘텐츠' },
  { category: '시기·테마', keyword: '인성교육',  order: 440, q: '인성교육', desc: '인성·도덕 교육 콘텐츠' },
  { category: '시기·테마', keyword: '영양ON',    order: 450, q: '영양ON',   desc: '영양·식생활 교육 콘텐츠' },
];

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO suggested_keywords
    (keyword, category, search_query, description, display_order, is_active, created_by)
  VALUES (?, ?, ?, ?, ?, 1, NULL)
`);

let inserted = 0;
const tx = db.transaction((rows) => {
  for (const row of rows) {
    const r = insertStmt.run(row.keyword, row.category, row.q, row.desc, row.order);
    if (r.changes > 0) inserted++;
  }
});
tx(SEED);

const total = db.prepare('SELECT COUNT(*) AS c FROM suggested_keywords').get().c;
const active = db.prepare('SELECT COUNT(*) AS c FROM suggested_keywords WHERE is_active = 1').get().c;
console.log(`\n=== 시드 결과: 신규 INSERT ${inserted}건 / 시드 후보 ${SEED.length}건 ===`);
console.log(`=== 테이블 총 ${total}건 (활성 ${active}건) ===\n`);

// ----- 검증 출력 -----
console.log('[검증] 카테고리별 카운트:');
const catCounts = db.prepare(`
  SELECT category, COUNT(*) AS cnt
  FROM suggested_keywords
  WHERE is_active = 1
  GROUP BY category
  ORDER BY MIN(display_order)
`).all();
for (const c of catCounts) console.log(`  - ${c.category}: ${c.cnt}건`);

console.log('\n[검증] 샘플 5건 (display_order ASC):');
const sample = db.prepare(`
  SELECT id, category, keyword, search_query, display_order, is_active
  FROM suggested_keywords
  ORDER BY display_order ASC, id ASC
  LIMIT 5
`).all();
for (const r of sample) {
  console.log(`  - id=${r.id} [${r.category}] ${r.keyword} (q=${r.search_query}, order=${r.display_order})`);
}

db.close();
console.log('\n=== 마이그레이션 완료 ===');
