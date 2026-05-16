import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const path = require('path');

const xlsxPath = path.resolve('./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');
const rows = XLSX.utils.sheet_to_json(XLSX.readFile(xlsxPath).Sheets['학습맵_리니어연결'], { defval: '' });
const db = new Database('./data/dacheum.db', { readonly: true });

// 엑셀에 정의된 3단계ID 전체 집합
const excelDefinedIds = new Set(rows.map(r => String(r['3단계ID'] || '').trim()).filter(Boolean));

// DB의 모든 노드 ID 집합
const dbNodeIds = new Set(db.prepare("SELECT node_id FROM learning_map_nodes").all().map(r => r.node_id));

// 후속학습ID에서 엑셀 미정의 ID 찾기
const orphanRefs = [];
for (const r of rows) {
  const from = String(r['3단계ID'] || '').trim();
  if (!from) continue;
  const nexts = String(r['후속학습ID'] || '').split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
  for (const nid of nexts) {
    if (!excelDefinedIds.has(nid)) {
      orphanRefs.push({
        from, fromUnit: r['단원명'], fromLesson: r['3단계내용요소'],
        next: nid,
        inDb: dbNodeIds.has(nid)
      });
    }
  }
}

console.log(`엑셀에 정의 안 된 후속 ID 참조: ${orphanRefs.length}건`);
console.log('\n=== 상세 (모두) ===');
for (const o of orphanRefs) {
  console.log(`from: [${o.fromUnit}] ${o.fromLesson} (${o.from})`);
  console.log(`  → 후속 ID: ${o.next}  | DB에 노드 ${o.inDb ? '있음' : '없음'}`);
}
