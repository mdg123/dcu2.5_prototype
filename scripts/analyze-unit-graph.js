const db = require('better-sqlite3')('./data/dacheum.db', { readonly: true });

// 차시 → 차시 엣지로부터 단원 → 단원 매핑 도출
const rows = db.prepare(`
  SELECT e.from_node_id AS from_node, e.to_node_id AS to_node,
    n1.subject || '|' || n1.grade || '|' || n1.semester || '|' || n1.unit_name AS from_unit,
    n2.subject || '|' || n2.grade || '|' || n2.semester || '|' || n2.unit_name AS to_unit
  FROM learning_map_edges e
  JOIN learning_map_nodes n1 ON n1.node_id = e.from_node_id
  JOIN learning_map_nodes n2 ON n2.node_id = e.to_node_id
  WHERE n1.lesson_name IS NOT NULL AND n2.lesson_name IS NOT NULL
`).all();

console.log('총 엣지(차시간):', rows.length);

const interEdges = rows.filter(r => r.from_unit !== r.to_unit);
const intraEdges = rows.filter(r => r.from_unit === r.to_unit);
console.log('단원 내 차시간:', intraEdges.length);
console.log('단원 간 차시간:', interEdges.length);

// 단원 → 단원 unique
const unitPairs = new Set();
for (const r of interEdges) unitPairs.add(r.from_unit + '→→' + r.to_unit);
console.log('단원 간 unique 매핑:', unitPairs.size);

// 단원별 in/out 분포
const outDeg = {}, inDeg = {};
for (const r of interEdges) {
  outDeg[r.from_unit] = (outDeg[r.from_unit] || 0) + 1;
  inDeg[r.to_unit] = (inDeg[r.to_unit] || 0) + 1;
}

// 모든 단원
const allUnits = db.prepare(`
  SELECT DISTINCT subject || '|' || grade || '|' || semester || '|' || unit_name AS key,
    subject, grade, semester, unit_name
  FROM learning_map_nodes
  WHERE lesson_name IS NOT NULL
`).all();

const noOut = allUnits.filter(u => !outDeg[u.key]);
const noIn = allUnits.filter(u => !inDeg[u.key]);
console.log(`총 단원: ${allUnits.length}`);
console.log(`out-degree=0 (다음 단원 없음): ${noOut.length}`);
console.log(`in-degree=0 (이전 단원 없음, 시작 단원): ${noIn.length}`);

// out=0인 단원 (학습 흐름이 끊긴 단원)
console.log('\n=== out-degree=0 단원 샘플 (다음 단원 연결 없음) ===');
noOut.slice(0, 20).forEach(u => console.log(`  [${u.subject} ${u.grade}-${u.semester}] ${u.unit_name}`));

console.log('\n=== in-degree=0 단원 샘플 (이전 단원 없음) ===');
noIn.slice(0, 20).forEach(u => console.log(`  [${u.subject} ${u.grade}-${u.semester}] ${u.unit_name}`));
