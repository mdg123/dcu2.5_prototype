/**
 * [비교/조사 전용 스크립트 — DB 무변경]
 *
 * 두 엑셀 비교: 통합_학습맵_계통도_연결_완성.xlsx vs 통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx
 *  - 시트 구조, 컬럼명, 행 수
 *  - 단원(level=2) 수, 차시(level=3) 수
 *  - "두 자리 수의 곱셈(2)" 단원의 차시 비교
 *
 * 단일 정본(SSOT)은 KOFAC v2 임. 본 스크립트는 두 엑셀의 차이를 진단하기 위해
 * 양쪽을 동시에 읽는 정당한 사유가 있는 비교용 유틸.
 */
'use strict';
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const PATH_OLD = path.join(ROOT, '통합_학습맵_계통도_연결_완성.xlsx');
const PATH_NEW = path.join(ROOT, '통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');

function loadAllSheets(p) {
  const wb = XLSX.readFile(p);
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
    const cols = rows.length ? Object.keys(rows[0]) : [];
    return { name, rows: rows.length, cols, data: rows };
  });
}

const oldSheets = loadAllSheets(PATH_OLD);
const newSheets = loadAllSheets(PATH_NEW);

console.log('=== OLD (통합_학습맵_계통도_연결_완성.xlsx) ===');
oldSheets.forEach((s) => console.log(`  Sheet "${s.name}" | rows=${s.rows} | cols=[${s.cols.join(', ')}]`));
console.log('\n=== NEW (통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx) ===');
newSheets.forEach((s) => console.log(`  Sheet "${s.name}" | rows=${s.rows} | cols=[${s.cols.join(', ')}]`));

const oldData = oldSheets[0].data;
const newData = newSheets[0].data;

// 단원·차시 집계
function summarize(data, label) {
  console.log(`\n--- ${label} 데이터 통계 (Sheet ${0}) ---`);
  const unitSet = new Set();
  const lessonSet = new Set();
  const gradeSemester = {};
  data.forEach((r) => {
    const uname = (r['단원명'] || '').toString().trim();
    const lname = (r['3단계내용요소'] || '').toString().trim();
    const g = r['적용학년'];
    const s = r['적용학기'];
    const lessonId = r['3단계ID'];
    if (uname) unitSet.add(`${g}-${s}|${uname}`);
    if (lessonId && lname) lessonSet.add(lessonId);
    const k = `${g}-${s}`;
    gradeSemester[k] = (gradeSemester[k] || 0) + 1;
  });
  console.log('  총 행:', data.length);
  console.log('  유니크 단원 수(학년-학기|단원명):', unitSet.size);
  console.log('  유니크 차시(3단계ID):', lessonSet.size);
  console.log('  학년-학기별 행 수:', JSON.stringify(gradeSemester));
  return { unitSet, lessonSet, gradeSemester };
}

const oldSum = summarize(oldData, 'OLD');
const newSum = summarize(newData, 'NEW (KOFAC v2)');

// 단원 차이
console.log('\n=== 단원 집합 차이 ===');
const onlyInOldUnits = [...oldSum.unitSet].filter((k) => !newSum.unitSet.has(k));
const onlyInNewUnits = [...newSum.unitSet].filter((k) => !oldSum.unitSet.has(k));
console.log('  OLD에만 있는 단원:', onlyInOldUnits.length);
onlyInOldUnits.slice(0, 30).forEach((k) => console.log('   -', k));
console.log('  NEW에만 있는 단원:', onlyInNewUnits.length);
onlyInNewUnits.slice(0, 30).forEach((k) => console.log('   +', k));

// 차시 ID 집합 차이
console.log('\n=== 차시(3단계ID) 집합 차이 ===');
const onlyInOldLessons = [...oldSum.lessonSet].filter((k) => !newSum.lessonSet.has(k));
const onlyInNewLessons = [...newSum.lessonSet].filter((k) => !oldSum.lessonSet.has(k));
console.log('  OLD에만 있는 차시 ID:', onlyInOldLessons.length);
console.log('  NEW에만 있는 차시 ID:', onlyInNewLessons.length);
console.log('  교집합:', [...oldSum.lessonSet].filter((k) => newSum.lessonSet.has(k)).length);

// "두 자리 수의 곱셈(2)" 단원 비교
console.log('\n=== "두 자리 수의 곱셈(2)" 차시 비교 ===');
function unitRows(data, unitName) {
  return data.filter((r) => (r['단원명'] || '').toString().trim() === unitName);
}
const oldTarget = unitRows(oldData, '두 자리 수의 곱셈(2)');
const newTarget = unitRows(newData, '두 자리 수의 곱셈(2)');
console.log('  OLD 행 수:', oldTarget.length);
oldTarget.forEach((r) => console.log('   -', r['3단계ID'], '|', r['3단계내용요소'], '| 학년', r['적용학년'], '학기', r['적용학기'], '| code:', r['성취기준코드'] || r['성취기준'] || ''));
console.log('  NEW 행 수:', newTarget.length);
newTarget.forEach((r) => console.log('   +', r['3단계ID'], '|', r['3단계내용요소'], '| 학년', r['적용학년'], '학기', r['적용학기'], '| code:', r['성취기준코드'] || r['성취기준'] || ''));

// KOFAC 컬럼 탐지
console.log('\n=== KOFAC 관련 컬럼 탐색 (NEW) ===');
const newCols = newSheets[0].cols;
console.log('  전체 컬럼:', newCols);
const kofacCols = newCols.filter((c) => /KOFAC|kofac|성취|코드|기준/.test(c));
console.log('  KOFAC/성취/코드/기준 관련 컬럼:', kofacCols);
if (newData[0]) {
  console.log('  NEW 첫 행 샘플:');
  Object.entries(newData[0]).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
}
if (oldData[0]) {
  console.log('  OLD 첫 행 샘플:');
  Object.entries(oldData[0]).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
}
