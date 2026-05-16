const db = require('better-sqlite3')('./data/dacheum.db', { readonly: true });

// 1) 모든 차시별 후속(out-degree) 분포
const outDeg = db.prepare(`
  SELECT n.node_id, n.lesson_name, n.unit_name, n.grade, n.semester,
    (SELECT COUNT(*) FROM learning_map_edges WHERE from_node_id = n.node_id) AS out_count
  FROM learning_map_nodes n
  WHERE n.lesson_name IS NOT NULL
`).all();

const histOut = {};
for (const r of outDeg) histOut[r.out_count] = (histOut[r.out_count] || 0) + 1;
console.log('[차시별 후속 수 분포]', JSON.stringify(histOut));

// 2) 후속 2개 이상인 차시 (다대다 흔적)
const multiOut = outDeg.filter(r => r.out_count > 1);
console.log(`\n[후속 2개 이상인 차시: ${multiOut.length}개]`);
multiOut.slice(0, 10).forEach(r => console.log(`  ${r.node_id} ${r.unit_name} > ${r.lesson_name} : 후속 ${r.out_count}개`));

// 3) 단원의 마지막 차시 (sort_order 최대)만 다음 단원과 연결되는지
const lastByUnit = db.prepare(`
  WITH last_orders AS (
    SELECT subject, grade, semester, unit_name, MAX(sort_order) AS max_order
    FROM learning_map_nodes WHERE lesson_name IS NOT NULL
    GROUP BY subject, grade, semester, unit_name
  )
  SELECT n.node_id, n.unit_name, n.grade, n.semester, n.lesson_name
  FROM learning_map_nodes n
  JOIN last_orders lo ON lo.subject = n.subject AND lo.grade = n.grade
    AND lo.semester = n.semester AND lo.unit_name = n.unit_name AND lo.max_order = n.sort_order
  WHERE n.lesson_name IS NOT NULL
`).all();

let lastWithCrossUnit = 0, nonLastWithCrossUnit = 0;
for (const r of outDeg) {
  const isLast = lastByUnit.some(l => l.node_id === r.node_id);
  if (r.out_count === 0) continue;
  // 후속이 다른 단원에 있는지
  const nexts = db.prepare(`
    SELECT n.unit_name, n.grade, n.semester FROM learning_map_edges e
    JOIN learning_map_nodes n ON n.node_id = e.to_node_id
    WHERE e.from_node_id = ?
  `).all(r.node_id);
  const meRow = db.prepare(`SELECT unit_name, grade, semester FROM learning_map_nodes WHERE node_id = ?`).get(r.node_id);
  const hasCrossUnit = nexts.some(n => n.unit_name !== meRow.unit_name || n.grade !== meRow.grade || n.semester !== meRow.semester);
  if (hasCrossUnit) {
    if (isLast) lastWithCrossUnit++;
    else nonLastWithCrossUnit++;
  }
}
console.log(`\n[단원 간 연결 위치]`);
console.log(`  마지막 차시에서만 단원 간 연결: ${lastWithCrossUnit}개`);
console.log(`  비-마지막 차시에서도 단원 간 연결: ${nonLastWithCrossUnit}개 (있다면 비선형)`);

// 4) 시작 차시 (선수 0)
const startNodes = outDeg.filter(r => {
  const inCnt = db.prepare(`SELECT COUNT(*) c FROM learning_map_edges WHERE to_node_id=?`).get(r.node_id).c;
  return inCnt === 0;
});
console.log(`\n[시작 차시 (선수 0): ${startNodes.length}개]`);
startNodes.slice(0, 5).forEach(r => console.log(`  ${r.node_id} ${r.unit_name} > ${r.lesson_name}`));
