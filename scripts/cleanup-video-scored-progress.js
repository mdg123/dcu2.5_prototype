require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// scripts/cleanup-video-scored-progress.js
// 영상·자료 시청 항목 완료 데이터 중 score가 들어있는 행을 NULL로 정리.
// 정책: 시청형 콘텐츠(video/document/image/external/audio)는 점수 없음.
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(dbPath);

const NON_SCORED_TYPES = ['video','document','image','external','audio'];
const placeholders = NON_SCORED_TYPES.map(() => '?').join(',');

function countDirty() {
  return db.prepare(`
    SELECT COUNT(*) AS cnt FROM daily_learning_progress p
     JOIN daily_learning_items i ON p.item_id = i.id
     JOIN contents c ON i.content_id = c.id
    WHERE p.status='completed' AND p.score IS NOT NULL
      AND c.content_type IN (${placeholders})
  `).get(...NON_SCORED_TYPES).cnt;
}

function listDirty() {
  return db.prepare(`
    SELECT p.user_id, p.item_id, p.set_id, p.score, c.content_type, c.title
      FROM daily_learning_progress p
      JOIN daily_learning_items i ON p.item_id = i.id
      JOIN contents c ON i.content_id = c.id
     WHERE p.status='completed' AND p.score IS NOT NULL
       AND c.content_type IN (${placeholders})
  `).all(...NON_SCORED_TYPES);
}

console.log('[cleanup] DB:', dbPath);
const beforeCount = countDirty();
console.log('[cleanup] BEFORE dirty rows =', beforeCount);
if (beforeCount > 0) {
  console.log('[cleanup] Rows to fix:');
  listDirty().forEach(r => console.log('  ', JSON.stringify(r)));
}

const update = db.prepare(`
  UPDATE daily_learning_progress
     SET score = NULL
   WHERE status='completed' AND score IS NOT NULL
     AND item_id IN (
       SELECT i.id FROM daily_learning_items i
       JOIN contents c ON i.content_id = c.id
       WHERE c.content_type IN (${placeholders})
     )
`);

const tx = db.transaction(() => update.run(...NON_SCORED_TYPES));
const result = tx();
console.log('[cleanup] UPDATE changes =', result.changes);

const afterCount = countDirty();
console.log('[cleanup] AFTER dirty rows =', afterCount);

// 멱등성 재실행
const result2 = tx();
console.log('[cleanup] Idempotency check (second run) changes =', result2.changes);
console.log('[cleanup] Done.');
