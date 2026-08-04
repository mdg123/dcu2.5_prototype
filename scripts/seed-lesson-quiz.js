require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
const Database = require('better-sqlite3');
const db = new Database('./data/dacheum.db');
const quiz = db.prepare("SELECT id FROM contents WHERE content_type='quiz' LIMIT 1").get();
if (quiz) {
  db.prepare('INSERT OR IGNORE INTO lesson_contents (lesson_id, content_id, sort_order) VALUES (?,?,?)').run(29, quiz.id, 0);
  db.prepare("INSERT OR IGNORE INTO content_attempts (content_id, user_id, total_questions, correct_count, score_percent, attempted_at) VALUES (?,?,?,?,?,datetime('now'))").run(quiz.id, 3, 5, 4, 80);
  db.prepare("INSERT OR IGNORE INTO content_attempts (content_id, user_id, total_questions, correct_count, score_percent, attempted_at) VALUES (?,?,?,?,?,datetime('now'))").run(quiz.id, 4, 5, 3, 60);
  console.log('seeded lesson 29 ← quiz', quiz.id, '+ 2 attempts');
}
