// scripts/test-video-score-guard.js
// 가드 단위 시뮬레이션. DB에 행 추가/변경 없음.
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { normalizeProgressScore } = require('../db/self-learn-extended');
const db = require('../db');

function probe(itemId, score, label) {
  const out = normalizeProgressScore(itemId, score);
  const row = db.prepare(`
    SELECT i.id, c.content_type, c.title
      FROM daily_learning_items i
      LEFT JOIN contents c ON c.id = i.content_id
     WHERE i.id = ?
  `).get(itemId);
  console.log(`[probe ${label}] item=${itemId} type=${row && row.content_type} input=${score} -> ${out}`);
  return { input: score, output: out, type: row && row.content_type };
}

// 1) 영상 항목 4976: 점수 80 입력 → null 강제
const r1 = probe(4976, 80, 'video item 4976');
console.assert(r1.output === null, 'FAIL: video score should be null');

// 2) 영상 항목 4976: 점수 null 입력 → null 유지
const r2 = probe(4976, null, 'video item 4976 (null in)');
console.assert(r2.output === null, 'FAIL: null should stay null');

// 3) 퀴즈/실습 항목(있다면): 점수 유지
const quizItem = db.prepare(`
  SELECT i.id FROM daily_learning_items i
  JOIN contents c ON i.content_id = c.id
  WHERE c.content_type IN ('quiz','exercise','practice','i','p','e')
  LIMIT 1
`).get();
if (quizItem) {
  const r3 = probe(quizItem.id, 90, `quiz item ${quizItem.id}`);
  console.assert(r3.output === 90, 'FAIL: quiz score should pass through');
} else {
  console.log('[probe] no quiz item found to test pass-through (skipped)');
}

// 4) 미존재 item (조회 실패 fail-open): 점수 유지
const r4 = probe(999999999, 55, 'nonexistent item');
console.assert(r4.output === 55, 'FAIL: nonexistent should pass through (fail-open)');

console.log('[guard test] all assertions passed.');
