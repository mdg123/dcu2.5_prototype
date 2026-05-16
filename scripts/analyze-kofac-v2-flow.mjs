import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const path = require('path');

const p = path.resolve('./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');
const rows = XLSX.utils.sheet_to_json(XLSX.readFile(p).Sheets['학습맵_리니어연결'], { defval: '' });

// 차시별 후속 분석
const unitByNode = {};
for (const r of rows) unitByNode[r['3단계ID']] = r['단원명'];

let intraOnlyCount = 0; // 단원 내 차시로만 연결
let interOnlyCount = 0; // 다른 단원 차시로만 연결
let mixedCount = 0;     // 둘 다
let multiOutCount = 0;  // 후속 2개 이상
let multiInterUnit = []; // 단원 간 N:N 케이스

for (const r of rows) {
  const from = r['3단계ID'];
  const fromUnit = unitByNode[from];
  const nexts = String(r['후속학습ID'] || '').split(/[,\s;]+/).filter(Boolean);
  if (nexts.length === 0) continue;
  if (nexts.length > 1) multiOutCount++;

  const intraNexts = nexts.filter(id => unitByNode[id] === fromUnit);
  const interNexts = nexts.filter(id => unitByNode[id] !== fromUnit);

  if (intraNexts.length && !interNexts.length) intraOnlyCount++;
  else if (!intraNexts.length && interNexts.length) interOnlyCount++;
  else mixedCount++;

  // 단원 간 후속이 2개 이상이면 1:N 케이스
  if (interNexts.length >= 2) {
    const targetUnits = new Set(interNexts.map(id => unitByNode[id]));
    multiInterUnit.push({
      from: r['3단계내용요소'], fromUnit,
      nextCount: interNexts.length,
      targetUnits: [...targetUnits],
      targets: interNexts.map(id => ({ unit: unitByNode[id], lesson: rows.find(x => x['3단계ID']===id)?.['3단계내용요소'] }))
    });
  }
}

console.log(`총 행: ${rows.length}`);
console.log(`후속 2개 이상인 차시: ${multiOutCount}`);
console.log(`단원 내 후속만: ${intraOnlyCount}`);
console.log(`단원 간 후속만: ${interOnlyCount}`);
console.log(`혼합(단원 내+간): ${mixedCount}`);

console.log(`\n[단원 간 N:N 케이스 (1차시 → 2개 이상 다른 단원 차시): ${multiInterUnit.length}건]`);
multiInterUnit.slice(0, 10).forEach(c => {
  console.log(`  [${c.fromUnit}] ${c.from} → ${c.nextCount}개 (${c.targetUnits.join(', ')})`);
  c.targets.forEach(t => console.log(`     → [${t.unit}] ${t.lesson}`));
});
