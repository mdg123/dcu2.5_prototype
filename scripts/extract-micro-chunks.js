const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
const db = new Database(path.join(ROOT, 'data/dacheum.db'), { readonly: true });

// 최대 50 차시씩 영역+학년+학기 단위로 묶고, 초과하면 단원 단위로 split
const groups = db.prepare(`
  SELECT grade_level, grade, semester, area, COUNT(*) as cnt
  FROM learning_map_nodes
  WHERE node_level=3 AND NOT ((grade_level='중' AND grade=1) OR (grade_level='고' AND grade=1))
  GROUP BY grade_level, grade, semester, area
  ORDER BY grade_level, grade, semester, area
`).all();

const MAX = 50;
const outDir = path.join(ROOT, 'input-chunks-micro');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

let microCount = 0;
let totalLessons = 0;
const manifest = [];

groups.forEach(g => {
  const rows = db.prepare(`
    SELECT node_id, grade_level, grade, semester, area, unit_name, lesson_name, achievement_code, achievement_text, sort_order
    FROM learning_map_nodes
    WHERE node_level=3 AND grade_level=? AND grade=? AND semester=? AND area=?
    ORDER BY unit_name, sort_order
  `).all(g.grade_level, g.grade, g.semester, g.area);
  
  // 50개 이하면 단일 micro, 초과면 50개 단위 split
  for (let i = 0; i < rows.length; i += MAX) {
    const slice = rows.slice(i, i + MAX);
    microCount++;
    const partLabel = rows.length > MAX ? `-p${Math.floor(i/MAX)+1}` : '';
    const safeArea = g.area.replace(/\s+/g, '');
    const name = `m${String(microCount).padStart(2,'0')}-${g.grade_level}${g.grade}-${g.semester}-${safeArea}${partLabel}`;
    const fn = path.join(outDir, name + '.input.json');
    fs.writeFileSync(fn, JSON.stringify(slice, null, 2));
    manifest.push({ id: name, lessons: slice.length, grade_level: g.grade_level, grade: g.grade, semester: g.semester, area: g.area });
    totalLessons += slice.length;
  }
});

fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));
console.log('micro chunks:', microCount);
console.log('total lessons:', totalLessons, '(target 1114)');
console.log('avg lessons/chunk:', (totalLessons/microCount).toFixed(1));
console.log('max:', Math.max(...manifest.map(m=>m.lessons)));
db.close();
