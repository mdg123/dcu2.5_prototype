/**
 * [비교 전용 스크립트 — DB 무변경]
 * KOFAC v2 단일 정본(SSOT)와 폐기된 임시 엑셀(`통합_학습맵_계통도_연결_완성.xlsx`) 사이의
 * 차시 ID 중첩 분석용. 시드 경로가 아니라 차이 분석에만 사용한다.
 * SSOT 는 `통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx` 임.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const path = require('path');

const kofacRows = XLSX.utils.sheet_to_json(XLSX.readFile('./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx').Sheets['학습맵_리니어연결'], { defval: '' });
// 비교용 (폐기됨, SSOT 아님): 통합_학습맵_계통도_연결_완성.xlsx
const oldRows = XLSX.utils.sheet_to_json(XLSX.readFile('./통합_학습맵_계통도_연결_완성.xlsx').Sheets['학습맵_리니어연결'], { defval: '' });
const db = new Database('./data/dacheum.db', { readonly: true });

const kofacIds = new Set(kofacRows.map(r => r['3단계ID']).filter(Boolean));
const oldIds = new Set(oldRows.map(r => r['3단계ID']).filter(Boolean));

// DB lesson_name 차시
const dbLessons = db.prepare("SELECT node_id FROM learning_map_nodes WHERE lesson_name IS NOT NULL").all();
const dbLessonIds = new Set(dbLessons.map(r => r.node_id));

console.log('KOFAC v2 행 차시 ID:', kofacIds.size);
console.log('기존 엑셀 차시 ID:', oldIds.size);
console.log('DB lesson_name 차시:', dbLessonIds.size);

const inKofacOnly = [...kofacIds].filter(id => !oldIds.has(id));
const inOldOnly = [...oldIds].filter(id => !kofacIds.has(id));
const inBoth = [...kofacIds].filter(id => oldIds.has(id));
console.log('\nKOFAC v2만 (기존 엑셀 X):', inKofacOnly.length);
console.log('기존 엑셀만 (KOFAC v2 X):', inOldOnly.length);
console.log('둘 다:', inBoth.length);

const inDbOnly = [...dbLessonIds].filter(id => !kofacIds.has(id) && !oldIds.has(id));
console.log('\n어떤 엑셀에도 없지만 DB에 있는 차시:', inDbOnly.length);

// node_id 접두사별 DB 차시 분포
const byPrefix = {};
for (const id of dbLessonIds) {
  const p = id.slice(0, 2);
  byPrefix[p] = (byPrefix[p] || 0) + 1;
}
console.log('\nDB 차시 접두사 분포:', JSON.stringify(byPrefix));

// 콘텐츠 매핑 차시 (node_contents에 등록된)
const mapped = db.prepare(`
  SELECT DISTINCT nc.node_id FROM node_contents nc
  JOIN learning_map_nodes n ON n.node_id = nc.node_id
  WHERE n.lesson_name IS NOT NULL
`).all();
const mappedIds = new Set(mapped.map(r => r.node_id));
console.log('\n콘텐츠 매핑된 차시:', mappedIds.size);

// 매핑된 차시 중 KOFAC v2에 없는 것
const orphanMapped = [...mappedIds].filter(id => !kofacIds.has(id));
console.log('  ↑ 그 중 KOFAC v2 행에 없는 차시:', orphanMapped.length);
