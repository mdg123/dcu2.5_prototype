/**
 * 현재 DB의 learning_map_nodes(level=2/3)와 KOFAC v2 엑셀의 정합성 점검
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const XLSX_NEW = path.join(__dirname, '..', '통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');

const db = new Database(DB_PATH, { readonly: true });
const wb = XLSX.readFile(XLSX_NEW);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });

const units = db.prepare(`SELECT node_id, subject, grade, semester, unit_name FROM learning_map_nodes WHERE node_level=2`).all();
const lessons = db.prepare(`SELECT node_id, parent_node_id, lesson_name, grade, semester, unit_name, achievement_code FROM learning_map_nodes WHERE node_level=3`).all();

console.log('=== DB 통계 ===');
console.log('  level=2 단원 수:', units.length);
console.log('  level=3 차시 수:', lessons.length);

// node_contents/user_node_status 참조 차시 확인
const ncRefs = db.prepare(`SELECT DISTINCT node_id FROM node_contents`).all();
const unsRefs = db.prepare(`SELECT DISTINCT node_id FROM user_node_status`).all();
console.log('  node_contents 참조 노드:', ncRefs.length);
console.log('  user_node_status 참조 노드:', unsRefs.length);

// KOFAC v2와 DB 차시 ID 비교
const dbLessonIds = new Set(lessons.map((l) => l.node_id));
const xlsxLessonIds = new Set(rows.filter((r) => r['3단계ID']).map((r) => r['3단계ID']));

const onlyDb = [...dbLessonIds].filter((x) => !xlsxLessonIds.has(x));
const onlyXlsx = [...xlsxLessonIds].filter((x) => !dbLessonIds.has(x));
const both = [...dbLessonIds].filter((x) => xlsxLessonIds.has(x));

console.log('\n=== 차시 ID 매핑 (DB vs KOFAC v2) ===');
console.log('  DB에만:', onlyDb.length, '(KOFAC v2에 없는 차시 — 삭제/구버전)');
console.log('  KOFAC v2에만:', onlyXlsx.length, '(DB에 없는 차시 — 신규 추가 필요)');
console.log('  교집합:', both.length);

// DB-only 중 node_contents/user_node_status 참조 있는 것
const ncSet = new Set(ncRefs.map((r) => r.node_id));
const unsSet = new Set(unsRefs.map((r) => r.node_id));
const onlyDbWithRefs = onlyDb.filter((id) => ncSet.has(id) || unsSet.has(id));
console.log('  DB-only 중 외래키 참조 있는 노드:', onlyDbWithRefs.length);
if (onlyDbWithRefs.length) {
  console.log('  ', onlyDbWithRefs.slice(0, 10));
}

// '두 자리 수의 곱셈(2)' DB 상태
console.log('\n=== DB "두 자리 수의 곱셈(2)" 단원 차시 ===');
const targetUnit = units.find((u) => u.unit_name === '두 자리 수의 곱셈(2)');
console.log('  단원 노드:', targetUnit);
if (targetUnit) {
  const targetLessons = lessons.filter((l) => l.parent_node_id === targetUnit.node_id);
  console.log('  소속 차시 수:', targetLessons.length);
  targetLessons.forEach((l) => console.log('   -', l.node_id, '|', l.lesson_name));
}

// 신규 단원 (KOFAC v2에만 있는 단원명) DB 일치 확인
console.log('\n=== KOFAC v2 신규 단원명 4건 DB 존재 여부 ===');
const newUnits = [
  { g: 2, s: 1, name: '일차함수와 그래프' },
  { g: 3, s: 1, name: '이차함수와 그래프' },
  { g: 2, s: 1, name: '삼각형, 사각형, 원과 구성 요소' },
  { g: 1, s: 1, name: '행렬과 연산' },
];
newUnits.forEach((u) => {
  const found = units.find((x) => x.grade === u.g && x.semester === u.s && x.unit_name === u.name);
  console.log(`  ${u.g}-${u.s} | ${u.name} : ${found ? 'DB 존재' : 'DB 없음'} (KOFAC v2에 추가/변경된 단원명)`);
});

db.close();
