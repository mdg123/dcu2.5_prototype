import './_stamp-on-write.js'; // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * purge-non-kofac-lessons.mjs
 *
 * KOFAC v2 엑셀에 없는 차시(854개) + 매핑(node_contents·content_content_nodes·edges) 정리.
 * 단원 노드(node_level=2), 콘텐츠(contents) 자체는 보존.
 *
 * 사용법:
 *   node scripts/purge-non-kofac-lessons.mjs --dry-run
 *   node scripts/purge-non-kofac-lessons.mjs --apply
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

// KOFAC v2 차시 ID 집합
const kofacRows = XLSX.utils.sheet_to_json(XLSX.readFile('./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx').Sheets['학습맵_리니어연결'], { defval: '' });
const kofacIds = new Set(kofacRows.map(r => String(r['3단계ID'] || '').trim()).filter(Boolean));
console.log(`KOFAC v2 차시 ID: ${kofacIds.size}`);

const db = new Database('./data/dacheum.db');

// DB의 차시 중 KOFAC v2에 없는 것
const dbLessons = db.prepare("SELECT node_id FROM learning_map_nodes WHERE lesson_name IS NOT NULL").all();
const toDelete = dbLessons.filter(r => !kofacIds.has(r.node_id)).map(r => r.node_id);
console.log(`삭제 대상 차시: ${toDelete.length}`);

if (toDelete.length === 0) { console.log('정리할 차시 없음.'); process.exit(0); }

// 매핑 통계
const ncCount = db.prepare(`SELECT COUNT(*) c FROM node_contents WHERE node_id IN (${toDelete.map(() => '?').join(',')})`).get(...toDelete).c;
const ccnCount = db.prepare(`SELECT COUNT(*) c FROM content_content_nodes WHERE std_id IN (${toDelete.map(() => '?').join(',')})`).get(...toDelete).c;
const edgeFromCount = db.prepare(`SELECT COUNT(*) c FROM learning_map_edges WHERE from_node_id IN (${toDelete.map(() => '?').join(',')})`).get(...toDelete).c;
const edgeToCount = db.prepare(`SELECT COUNT(*) c FROM learning_map_edges WHERE to_node_id IN (${toDelete.map(() => '?').join(',')})`).get(...toDelete).c;

console.log(`\n영향:`);
console.log(`  node_contents 삭제 예정: ${ncCount}`);
console.log(`  content_content_nodes 삭제 예정: ${ccnCount}`);
console.log(`  learning_map_edges 삭제 예정: ${edgeFromCount + edgeToCount} (from ${edgeFromCount} + to ${edgeToCount})`);
console.log(`  learning_map_nodes 삭제 예정: ${toDelete.length}`);

if (DRY) { console.log('\n[dry-run] DB 변경 없음. --apply 로 실행.'); process.exit(0); }

// 적용
const tx = db.transaction(() => {
  // 1) node_contents 삭제 (차시 → 콘텐츠 매핑)
  const delNC = db.prepare(`DELETE FROM node_contents WHERE node_id = ?`);
  let nc = 0;
  for (const id of toDelete) nc += delNC.run(id).changes;

  // 2) content_content_nodes 삭제 (콘텐츠 → 차시 std_id)
  const delCCN = db.prepare(`DELETE FROM content_content_nodes WHERE std_id = ?`);
  let ccn = 0;
  for (const id of toDelete) ccn += delCCN.run(id).changes;

  // 3) learning_map_edges 삭제 (양방향)
  const delEdgeFrom = db.prepare(`DELETE FROM learning_map_edges WHERE from_node_id = ?`);
  const delEdgeTo = db.prepare(`DELETE FROM learning_map_edges WHERE to_node_id = ?`);
  let e = 0;
  for (const id of toDelete) { e += delEdgeFrom.run(id).changes; e += delEdgeTo.run(id).changes; }

  // 4) learning_map_nodes 삭제
  const delNode = db.prepare(`DELETE FROM learning_map_nodes WHERE node_id = ?`);
  let n = 0;
  for (const id of toDelete) n += delNode.run(id).changes;

  console.log(`\n[APPLIED] node_contents: ${nc}, content_content_nodes: ${ccn}, edges: ${e}, nodes: ${n}`);
});
tx();

// 검증
const after = db.prepare("SELECT COUNT(*) c FROM learning_map_nodes WHERE lesson_name IS NOT NULL").get();
console.log(`\n[verify] 차시 노드 잔여: ${after.c}`);

db.close();
