// 클래스 2에 20개 수업 + 셀프체크 응답 시드 (이해도/집중도 스크롤 검증)
const Database = require('better-sqlite3');
const db = new Database('./data/dacheum.db');
const exists = db.prepare("SELECT COUNT(*) c FROM lessons WHERE class_id=2 AND title LIKE 'SC_TEST%'").get().c;
if (exists > 0) { console.log('이미 시드 존재:', exists); process.exit(0); }
const insL = db.prepare(`INSERT INTO lessons (class_id, teacher_id, title, description, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'published', datetime('now', '-' || ? || ' days'), datetime('now'))`);
const insSc = db.prepare(`INSERT INTO lesson_self_check (lesson_id, user_id, class_id, understanding, focus, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);
const students = db.prepare("SELECT u.id FROM users u JOIN class_members cm ON cm.user_id=u.id WHERE cm.class_id=2 AND u.role='student'").all();
let lcount = 0, scount = 0;
for (let i = 1; i <= 20; i++) {
  const r = insL.run(2, 2, `SC_TEST 수업 ${String(i).padStart(2,'0')}`, '스크롤 테스트', 40 - i);
  lcount++;
  students.forEach((s, idx) => {
    // 다양한 값 분포
    const u = ((i + idx) % 5) + 1;
    const f = ((i * 2 + idx) % 5) + 1;
    insSc.run(r.lastInsertRowid, s.id, 2, u, f);
    scount++;
  });
}
console.log('시드 완료: 수업', lcount, '개 + self_check', scount, '건');
