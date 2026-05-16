const db = require('better-sqlite3')('./data/dacheum.db', { readonly: true });

const lessons = db.prepare(`
  SELECT node_id, unit_name, lesson_name, sort_order, achievement_code
  FROM learning_map_nodes
  WHERE subject='수학' AND grade=2 AND semester=1 AND unit_name='세 자리 수' AND lesson_name IS NOT NULL
  ORDER BY sort_order
`).all();
console.log("[단원: 세 자리 수, 초2 1학기 차시 목록]");
console.log(JSON.stringify(lessons, null, 2));

console.log("\n[단원 내 차시 간 연결]");
for (const l of lessons) {
  const prereqs = db.prepare(`
    SELECT n.lesson_name FROM learning_map_edges e
    JOIN learning_map_nodes n ON n.node_id = e.from_node_id
    WHERE e.to_node_id = ? AND n.unit_name = ? AND n.grade = ?
  `).all(l.node_id, l.unit_name, 2);
  const nexts = db.prepare(`
    SELECT n.lesson_name FROM learning_map_edges e
    JOIN learning_map_nodes n ON n.node_id = e.to_node_id
    WHERE e.from_node_id = ? AND n.unit_name = ? AND n.grade = ?
  `).all(l.node_id, l.unit_name, 2);
  const prereqsAll = db.prepare(`SELECT COUNT(*) c FROM learning_map_edges WHERE to_node_id=?`).get(l.node_id);
  const nextsAll = db.prepare(`SELECT COUNT(*) c FROM learning_map_edges WHERE from_node_id=?`).get(l.node_id);
  console.log(`\n[${l.sort_order}] ${l.lesson_name}`);
  console.log(`  ← 단원 내 선행: ${prereqs.length}개 | 전체 선행: ${prereqsAll.c}개`);
  console.log(`  → 단원 내 후속: ${nexts.length}개 | 전체 후속: ${nextsAll.c}개`);
  if (prereqs.length) console.log(`     선행: ${prereqs.map(x=>x.lesson_name).join(', ')}`);
  if (nexts.length) console.log(`     후속: ${nexts.map(x=>x.lesson_name).join(', ')}`);
}
