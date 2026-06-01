/**
 * [비교/조사 전용 스크립트 — DB 무변경]
 * SSOT 인 KOFAC v2 엑셀의 시트 구조를 들여다보고, 폐기된 임시 엑셀(연결_완성)과
 * 컬럼/행 차이를 한눈에 비교하기 위한 유틸. 시드 경로가 아님.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const path = require('path');

const p = path.resolve('./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');
const wb = XLSX.readFile(p);

console.log('=== KOFAC v2 엑셀 분석 ===');
console.log('Sheets:', wb.SheetNames);

for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  console.log(`\n=== Sheet: ${sheetName} ===`);
  console.log(`행 수: ${rows.length}`);
  if (rows.length > 0) {
    console.log('컬럼:', Object.keys(rows[0]));
    console.log('\n첫 3행 샘플:');
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      console.log(JSON.stringify(rows[i], null, 2));
    }
  }
}

// 폐기된 임시 엑셀과 비교 (디버그용 — SSOT 아님)
console.log('\n\n=== 폐기된 임시 엑셀(연결_완성)과 차이점 ===');
const old = XLSX.readFile(path.resolve('./통합_학습맵_계통도_연결_완성.xlsx'));
console.log('기존 시트:', old.SheetNames);
const oldRows = XLSX.utils.sheet_to_json(old.Sheets[old.SheetNames[0]], { defval: '' });
console.log('기존 행 수:', oldRows.length);
console.log('기존 컬럼:', oldRows.length ? Object.keys(oldRows[0]) : []);
