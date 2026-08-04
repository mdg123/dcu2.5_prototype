require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// 빈(items=0) daily_learning_sets 정리 + 사후 검증
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const emptySets = db.prepare(`
  SELECT s.id, s.title, s.target_date, s.target_grade
  FROM daily_learning_sets s
  WHERE NOT EXISTS (SELECT 1 FROM daily_learning_items WHERE set_id = s.id)
`).all();

console.log('=== 삭제 대상 빈 세트 ===');
emptySets.forEach(s => console.log(`  set=${s.id} grade=${s.target_grade} date=${s.target_date} "${s.title}"`));

if (emptySets.length === 0) {
  console.log('  (없음)');
} else {
  const ids = emptySets.map(s => s.id);
  const ph = ids.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM daily_learning_sets WHERE id IN (${ph})`).run(...ids);
  console.log(`\n빈 세트 삭제: ${r.changes}건`);
}

// 사후 검증
console.log('\n=== 사후 검증 ===');
const totalApproved = db.prepare(`
  SELECT COUNT(DISTINCT c.id) AS n FROM daily_learning_items i
  JOIN contents c ON c.id = i.content_id
  WHERE c.content_type = 'video' AND c.status = 'approved'
`).get();
console.log(`daily_learning_items에 연결된 approved 영상 (고유): ${totalApproved.n}개`);

const rejected = db.prepare(`
  SELECT COUNT(*) AS n FROM contents WHERE status='rejected' AND reject_reason IN ('youtube_deleted','wrong_content')
`).get();
console.log(`rejected (youtube_deleted + wrong_content): ${rejected.n}개`);

// 4~5월 수학 세트별 학년 분포 + 총 items
const stat = db.prepare(`
  SELECT s.target_grade,
    COUNT(DISTINCT s.id) AS sets,
    (SELECT COUNT(*) FROM daily_learning_items i JOIN daily_learning_sets s2 ON s2.id = i.set_id WHERE s2.target_grade = s.target_grade AND s2.target_date BETWEEN '2026-04-01' AND '2026-05-31' AND s2.title LIKE '%오늘의 학습 (수학)') AS items
  FROM daily_learning_sets s
  WHERE s.target_date BETWEEN '2026-04-01' AND '2026-05-31'
    AND s.title LIKE '%오늘의 학습 (수학)'
  GROUP BY s.target_grade
  ORDER BY s.target_grade
`).all();
console.log(`\n4~5월 "오늘의 학습 (수학)" 학년별 통계:`);
stat.forEach(r => console.log(`  grade=${r.target_grade}: 세트 ${r.sets}개, items ${r.items}개`));

db.close();
console.log('\n완료.');
