require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * add-intra-unit-edges.js
 *
 * 단원 내 차시들을 sort_order 순으로 순차 연결.
 * learning_map_edges에 (from_node_id, to_node_id) 추가.
 *
 * 사용법:
 *   node scripts/add-intra-unit-edges.js --dry-run
 *   node scripts/add-intra-unit-edges.js --apply
 */

const Database = require('better-sqlite3');
const path = require('path');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);

console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

// 모든 단원별 차시를 sort_order 순으로 정렬
const units = db.prepare(`
  SELECT DISTINCT subject, grade, semester, unit_name
  FROM learning_map_nodes
  WHERE lesson_name IS NOT NULL
`).all();

const insEdge = db.prepare(`
  INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id, edge_type)
  VALUES (?, ?, 'sequence')
`);

// learning_map_edges 컬럼 확인
const edgeCols = db.prepare("PRAGMA table_info(learning_map_edges)").all().map(c => c.name);
const hasEdgeType = edgeCols.includes('edge_type');
const insSimple = db.prepare(`INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id) VALUES (?, ?)`);

let totalAdded = 0;
const tx = db.transaction(() => {
  for (const u of units) {
    const lessons = db.prepare(`
      SELECT node_id FROM learning_map_nodes
      WHERE subject=? AND grade=? AND semester=? AND unit_name=? AND lesson_name IS NOT NULL
      ORDER BY sort_order
    `).all(u.subject, u.grade, u.semester, u.unit_name);
    if (lessons.length < 2) continue;
    for (let i = 0; i < lessons.length - 1; i++) {
      const from = lessons[i].node_id;
      const to = lessons[i + 1].node_id;
      if (DRY) {
        totalAdded++;
      } else {
        let r;
        if (hasEdgeType) {
          try { r = insEdge.run(from, to); } catch (e) { r = insSimple.run(from, to); }
        } else {
          r = insSimple.run(from, to);
        }
        if (r.changes > 0) totalAdded++;
      }
    }
  }
});

if (APPLY) tx();
else {
  // dry-run: 추가될 엣지 수 계산
  let dryCount = 0;
  for (const u of units) {
    const c = db.prepare(`
      SELECT COUNT(*) cnt FROM learning_map_nodes
      WHERE subject=? AND grade=? AND semester=? AND unit_name=? AND lesson_name IS NOT NULL
    `).get(u.subject, u.grade, u.semester, u.unit_name).cnt;
    if (c >= 2) dryCount += (c - 1);
  }
  console.log(`[dry-run] 추가될 엣지 (최대): ${dryCount}개 (중복 제외 전)`);
}

if (APPLY) {
  console.log(`[APPLIED] 신규 엣지 추가: ${totalAdded}개`);
  // 검증
  const recheck = db.prepare(`
    SELECT COUNT(DISTINCT u.unit_name || '|' || u.grade || '|' || u.semester) AS units_with_intra
    FROM learning_map_nodes u
    WHERE EXISTS (
      SELECT 1 FROM learning_map_edges e
      JOIN learning_map_nodes n1 ON n1.node_id = e.from_node_id
      JOIN learning_map_nodes n2 ON n2.node_id = e.to_node_id
      WHERE n1.unit_name = u.unit_name AND n1.grade = u.grade AND n1.semester = u.semester
        AND n2.unit_name = u.unit_name AND n2.grade = u.grade AND n2.semester = u.semester
    )
    AND u.lesson_name IS NOT NULL
  `).get();
  console.log(`[verify] 단원 내 연결 있는 단원 수: ${recheck.units_with_intra}`);
}

db.close();
