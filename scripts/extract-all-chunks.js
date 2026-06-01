const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/Users/user/OneDrive - 금성초등학교/바탕 화면/다채움 품질 제고사업 프로토타입 - 실동작';
const db = new Database(path.join(ROOT, 'data/dacheum.db'), { readonly: true });

const chunks = [
  ['chunk-01-초1-수와연산',    "grade_level='초' AND grade=1 AND area='수와 연산'"],
  ['chunk-02-초1-도형측정-도형방정식', "grade_level='초' AND grade=1 AND area IN ('도형과 측정','도형의 방정식')"],
  ['chunk-03-초1-변화관계-방정식-함수그래프', "grade_level='초' AND grade=1 AND area IN ('변화와 관계','방정식과 부등식','함수와 그래프')"],
  ['chunk-04-초1-기타5영역',  "grade_level='초' AND grade=1 AND area IN ('경우의 수','다항식','자료와 가능성','집합과 명제','행렬')"],
  ['chunk-05-초2-수와연산-자료가능성', "grade_level='초' AND grade=2 AND area IN ('수와 연산','자료와 가능성')"],
  ['chunk-06-초2-도형측정-변화관계', "grade_level='초' AND grade=2 AND area IN ('도형과 측정','변화와 관계')"],
  ['chunk-07-초3-수와연산',    "grade_level='초' AND grade=3 AND area='수와 연산'"],
  ['chunk-08-초3-도형측정-변화관계-자료가능성', "grade_level='초' AND grade=3 AND area IN ('도형과 측정','변화와 관계','자료와 가능성')"],
  ['chunk-09-초4',  "grade_level='초' AND grade=4"],
  ['chunk-10-초5-수와연산-변화관계-자료가능성', "grade_level='초' AND grade=5 AND area IN ('수와 연산','변화와 관계','자료와 가능성')"],
  ['chunk-11-초5-도형측정',    "grade_level='초' AND grade=5 AND area='도형과 측정'"],
  ['chunk-12-초6',  "grade_level='초' AND grade=6"],
];

const outDir = path.join(ROOT, 'input-chunks');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

let total = 0;
chunks.forEach(([name, where]) => {
  const rows = db.prepare(`SELECT node_id, grade_level, grade, semester, area, unit_name, lesson_name, achievement_code, achievement_text, sort_order FROM learning_map_nodes WHERE node_level=3 AND (${where}) ORDER BY semester, area, unit_name, sort_order`).all();
  fs.writeFileSync(path.join(outDir, name + '.input.json'), JSON.stringify(rows, null, 2));
  console.log(name + ': ' + rows.length + ' lessons');
  total += rows.length;
});
console.log('TOTAL extracted:', total);
db.close();
