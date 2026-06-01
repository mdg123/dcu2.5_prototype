const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/Users/user/OneDrive - 금성초등학교/바탕 화면/다채움 품질 제고사업 프로토타입 - 실동작';
const db = new Database(path.join(ROOT, 'data/dacheum.db'), { readonly: true });

const subs = [
  ['chunk-06a-초2-1도형측정-1변화관계', "grade_level='초' AND grade=2 AND semester=1 AND area IN ('도형과 측정','변화와 관계')"],
  ['chunk-06b-초2-2도형측정-2변화관계', "grade_level='초' AND grade=2 AND semester=2 AND area IN ('도형과 측정','변화와 관계')"],
  ['chunk-08a-초3-1도형측정-1변화관계', "grade_level='초' AND grade=3 AND semester=1 AND area IN ('도형과 측정','변화와 관계')"],
  ['chunk-08b-초3-2도형측정-2자료가능성', "grade_level='초' AND grade=3 AND semester=2 AND area IN ('도형과 측정','자료와 가능성')"],
  ['chunk-09a-초4-1', "grade_level='초' AND grade=4 AND semester=1"],
  ['chunk-09b-초4-2', "grade_level='초' AND grade=4 AND semester=2"],
  ['chunk-10a-초5-1수와연산-1변화관계', "grade_level='초' AND grade=5 AND semester=1 AND area IN ('수와 연산','변화와 관계')"],
  ['chunk-10b-초5-2수와연산-2자료가능성', "grade_level='초' AND grade=5 AND semester=2 AND area IN ('수와 연산','자료와 가능성')"],
  ['chunk-12a-초6-1', "grade_level='초' AND grade=6 AND semester=1"],
  ['chunk-12b-초6-2', "grade_level='초' AND grade=6 AND semester=2"],
];

let total = 0;
subs.forEach(([name, where]) => {
  const rows = db.prepare(`SELECT node_id, grade_level, grade, semester, area, unit_name, lesson_name, achievement_code, achievement_text, sort_order FROM learning_map_nodes WHERE node_level=3 AND (${where}) ORDER BY area, unit_name, sort_order`).all();
  fs.writeFileSync(path.join(ROOT, 'input-chunks', name + '.input.json'), JSON.stringify(rows, null, 2));
  console.log(name + ': ' + rows.length + ' lessons');
  total += rows.length;
});
console.log('SUB-BATCH total:', total);
db.close();
