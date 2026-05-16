import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const path = require('path');

const p = path.resolve('./통합_학습맵_계통도_연결_완성.xlsx');
const wb = XLSX.readFile(p);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

console.log('Total rows:', rows.length);
console.log('\n첫 3행 전체:');
for (let i = 0; i < 3; i++) console.log(JSON.stringify(rows[i], null, 2));

console.log('\n세 자리 수 단원 행:');
const target = rows.filter(r => String(r['단원명'] || '').includes('세 자리 수'));
for (const r of target.slice(0, 6)) {
  console.log({
    '3단계ID': r['3단계ID'],
    '3단계내용요소': r['3단계내용요소'],
    '단원명': r['단원명'],
    '학년': r['학년'],
    '적용학년': r['적용학년'],
    '적용학기': r['적용학기'],
    '선수학습ID': r['선수학습ID'],
    '후속학습ID': r['후속학습ID']
  });
}
