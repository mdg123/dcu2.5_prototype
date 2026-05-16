/**
 * derive-unit-edges.js
 *
 * 차시 ↔ 차시 엣지(edge_type='prerequisite')로부터
 * 단원 ↔ 단원 엣지(edge_type='unit_prerequisite')를 자동 도출.
 *
 * 단원 노드(node_level=2)는 parent_node_id로 차시와 연결되며,
 * "차시 A(단원 X) → 차시 B(단원 Y)" 매핑이 있고 X ≠ Y이면
 * "단원 X → 단원 Y" 엣지를 추가한다.
 *
 * 사용법:
 *   node scripts/derive-unit-edges.js --dry-run
 *   node scripts/derive-unit-edges.js --apply
 */

const Database = require('better-sqlite3');
const path = require('path');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);

console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

// 차시 → 단원 매핑 (parent_node_id 통해)
const lessonToUnit = {};
const unitRows = db.prepare(`
  SELECT node_id, parent_node_id FROM learning_map_nodes
  WHERE lesson_name IS NOT NULL AND node_level = 3 AND parent_node_id IS NOT NULL
`).all();
for (const r of unitRows) {
  lessonToUnit[r.node_id] = r.parent_node_id;
}
console.log(`[map] 차시→단원 매핑: ${Object.keys(lessonToUnit).length}건`);

// parent_node_id가 없는 차시도 unit_name 기반으로 단원 노드 찾기
const fallbackByUnitKey = db.prepare(`
  SELECT node_id, subject, grade, semester, unit_name FROM learning_map_nodes
  WHERE lesson_name IS NULL AND node_level = 2
`).all();
const unitNodeMap = {};
for (const u of fallbackByUnitKey) {
  unitNodeMap[`${u.subject}|${u.grade}|${u.semester}|${u.unit_name}`] = u.node_id;
}

const lessonsAll = db.prepare(`
  SELECT node_id, subject, grade, semester, unit_name, parent_node_id
  FROM learning_map_nodes WHERE lesson_name IS NOT NULL AND node_level = 3
`).all();
for (const l of lessonsAll) {
  if (lessonToUnit[l.node_id]) continue;
  const key = `${l.subject}|${l.grade}|${l.semester}|${l.unit_name}`;
  const uid = unitNodeMap[key];
  if (uid) lessonToUnit[l.node_id] = uid;
}
console.log(`[map] 차시→단원 매핑 (fallback 포함): ${Object.keys(lessonToUnit).length}건`);

// 차시 엣지 (prerequisite)
const edges = db.prepare(`
  SELECT from_node_id, to_node_id FROM learning_map_edges
  WHERE edge_type IN ('prerequisite', '') OR edge_type IS NULL
`).all();
console.log(`[edges] 차시 엣지: ${edges.length}건`);

// 단원 간 페어 추출
const unitPairs = new Set();
let crossUnitEdges = 0, withinSameUnit = 0, missingMapping = 0;
for (const e of edges) {
  const fu = lessonToUnit[e.from_node_id];
  const tu = lessonToUnit[e.to_node_id];
  if (!fu || !tu) { missingMapping++; continue; }
  if (fu === tu) { withinSameUnit++; continue; }
  unitPairs.add(`${fu}→${tu}`);
  crossUnitEdges++;
}
console.log(`[derive] 단원 간 차시 엣지: ${crossUnitEdges}, 단원 내: ${withinSameUnit}, 매핑 누락: ${missingMapping}`);
console.log(`[derive] unique 단원→단원 페어: ${unitPairs.size}`);

// 기존 unit_prerequisite 엣지
const existing = db.prepare(`SELECT from_node_id || '→' || to_node_id AS k FROM learning_map_edges WHERE edge_type='unit_prerequisite'`).all();
const existingSet = new Set(existing.map(x => x.k));
console.log(`[existing] unit_prerequisite 엣지: ${existing.length}`);

if (DRY) {
  let toAdd = 0;
  for (const p of unitPairs) if (!existingSet.has(p)) toAdd++;
  console.log(`[dry-run] 추가될 엣지: ${toAdd}건`);
  process.exit(0);
}

// 적재
const ins = db.prepare(`INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id, edge_type) VALUES (?, ?, 'unit_prerequisite')`);
let added = 0;
const tx = db.transaction(() => {
  for (const p of unitPairs) {
    const [from, to] = p.split('→');
    const r = ins.run(from, to);
    if (r.changes > 0) added++;
  }
});
tx();
console.log(`[APPLIED] unit_prerequisite 엣지 추가: ${added}건`);

// 검증
const after = db.prepare(`SELECT COUNT(*) c FROM learning_map_edges WHERE edge_type='unit_prerequisite'`).get();
console.log(`[verify] unit_prerequisite 총: ${after.c}`);

db.close();
