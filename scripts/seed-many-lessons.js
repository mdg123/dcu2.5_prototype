// 클래스 2에 25개 수업 추가 시드 (스크롤 동작 검증용)
const Database = require('better-sqlite3');
const db = new Database('./data/dacheum.db');
const exists = db.prepare("SELECT COUNT(*) c FROM lessons WHERE class_id=2 AND title LIKE 'SCROLL_TEST%'").get().c;
if (exists > 0) {
  console.log('이미 시드 존재:', exists, '건. 건너뜀.');
  process.exit(0);
}
const ins = db.prepare(`INSERT INTO lessons (class_id, teacher_id, title, description, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'published', datetime('now', '-' || ? || ' days'), datetime('now'))`);
for (let i = 1; i <= 25; i++) {
  ins.run(2, 2, `SCROLL_TEST 수업 ${String(i).padStart(2,'0')}`, '스크롤 테스트용', 60 - i);
}
console.log('25개 수업 추가 완료. class_id=2');
