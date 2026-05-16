const db = require('better-sqlite3')('./data/dacheum.db', { readonly: true });

// 모든 단원별 차시 수와 단원 내 연결 수 비교
const r = db.prepare(`
  SELECT n.subject, n.grade, n.semester, n.unit_name,
    COUNT(DISTINCT n.node_id) AS lesson_count,
    (
      SELECT COUNT(*) FROM learning_map_edges e
      JOIN learning_map_nodes n1 ON n1.node_id = e.from_node_id
      JOIN learning_map_nodes n2 ON n2.node_id = e.to_node_id
      WHERE n1.subject = n.subject AND n1.grade = n.grade AND n1.semester = n.semester AND n1.unit_name = n.unit_name
        AND n2.subject = n.subject AND n2.grade = n.grade AND n2.semester = n.semester AND n2.unit_name = n.unit_name
    ) AS intra_unit_edges
  FROM learning_map_nodes n
  WHERE n.lesson_name IS NOT NULL
  GROUP BY n.subject, n.grade, n.semester, n.unit_name
  HAVING lesson_count >= 2
  ORDER BY n.subject, n.grade, n.semester, n.unit_name
`).all();

let zeroIntra = 0, hasIntra = 0;
const missing = [];
for (const u of r) {
  if (u.intra_unit_edges === 0 && u.lesson_count >= 2) {
    zeroIntra++;
    missing.push(u);
  } else if (u.intra_unit_edges > 0) {
    hasIntra++;
  }
}
console.log(`총 단원: ${r.length}, 단원 내 연결 있음: ${hasIntra}, 단원 내 연결 0: ${zeroIntra}`);
console.log('\n단원 내 연결 누락 (차시 ≥ 2) 샘플 10개:');
console.log(JSON.stringify(missing.slice(0, 10), null, 2));
console.log(`...총 ${missing.length}개 단원 보강 필요`);

const totalLessonsAffected = missing.reduce((a, b) => a + b.lesson_count, 0);
console.log(`\n영향받는 차시: ${totalLessonsAffected}개`);
// 단원 내 차시 순차 연결 보강 시 추가될 엣지 수: 각 단원에서 (lesson_count - 1) 개
const totalEdgesToAdd = missing.reduce((a, b) => a + (b.lesson_count - 1), 0);
console.log(`보강할 엣지 수: ${totalEdgesToAdd}개`);
