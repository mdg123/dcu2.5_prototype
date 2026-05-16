import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const path = require('path');

const p = path.resolve('./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');
const rows = XLSX.utils.sheet_to_json(XLSX.readFile(p).Sheets['학습맵_리니어연결'], { defval: '' });

console.log('총 행:', rows.length);

// 엣지 계산
const edges = new Set();
const intraUnit = new Set();
const interUnit = new Set();
const unitByNode = {};
for (const r of rows) {
  unitByNode[r['3단계ID']] = r['단원명'] + '|' + r['적용학년'] + '|' + r['적용학기'];
}
for (const r of rows) {
  const from = r['3단계ID'];
  const fromUnit = unitByNode[from];
  // 선수 (prereq → 현재)
  for (const id of String(r['선수학습ID'] || '').split(/[,\s;]+/).filter(Boolean)) {
    edges.add(id + '→' + from);
    if (unitByNode[id] === fromUnit) intraUnit.add(id + '→' + from);
    else interUnit.add(id + '→' + from);
  }
  // 후속 (현재 → next)
  for (const id of String(r['후속학습ID'] || '').split(/[,\s;]+/).filter(Boolean)) {
    edges.add(from + '→' + id);
    if (unitByNode[id] === fromUnit) intraUnit.add(from + '→' + id);
    else interUnit.add(from + '→' + id);
  }
}
console.log('전체 엣지:', edges.size);
console.log('단원 내 엣지:', intraUnit.size);
console.log('단원 간 엣지:', interUnit.size);

// 세 자리 수 단원 차시들의 후속 확인
console.log('\n[세 자리 수 단원 차시별 후속학습ID]');
const sezari = rows.filter(r => r['단원명'] === '세 자리 수' && r['적용학년'] == 2);
for (const r of sezari) {
  console.log(`${r['3단계ID']} ${r['3단계내용요소']} → ${r['후속학습ID']}`);
}

console.log('\n[9까지의 수 단원 차시별 후속학습ID]');
const ng = rows.filter(r => r['단원명'] === '9까지의 수');
for (const r of ng) {
  console.log(`${r['3단계ID']} ${r['3단계내용요소']} → ${r['후속학습ID']}`);
}
