// scripts/curriculum-std/import-driver.mjs
// ─────────────────────────────────────────────────────────────────────
// 교육과정 표준체계 통합 드라이버 (Phase A3 최종)
//  - 3개 어댑터(kice-standard / kice-ext / cb-math)를 호출
//  - curriculum_content_nodes / curriculum_standard_nodes / curriculum_standard_levels
//    curriculum_std_id_map / curriculum_node_descendants / learning_map_edges 업서트
//  - tech-home-m / tech-home-h 가 subjects 테이블에 없으면 사전 등록
//  - 모든 쓰기는 단일 트랜잭션으로 수행 (실패 시 롤백)
//
// 사용법:
//   EXCEL_DIR="..../교육과정표준체계_최종산출물_202412" node scripts/curriculum-std/import-driver.mjs
//   또는:  node scripts/curriculum-std/import-driver.mjs --excel "<폴더>"  [--dry]
// ─────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import * as kiceStd from './adapters/kice-standard.mjs';
import * as kiceExt from './adapters/kice-ext.mjs';
import * as cbMath  from './adapters/cb-math.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ---- CLI / env ----
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { excel: process.env.EXCEL_DIR || null, dry: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--excel' || a === '-e') && args[i + 1]) { out.excel = args[++i]; }
    else if (a === '--dry') out.dry = true;
  }
  if (!out.excel) {
    // 기본: 부모 프로젝트의 교육과정표준체계 폴더
    const guess = path.resolve(PROJECT_ROOT, '..', '..', '..', '..', '교육과정표준체계_최종산출물_202412');
    if (fs.existsSync(guess)) out.excel = guess;
  }
  return out;
}

const FILE_MAP = [
  // [adapter module, relative filename]
  [kiceStd, '(KICE) 교육과정 표준체계_국어과_2412_최종.xlsx'],
  [kiceStd, '(KICE) 교육과정 표준체계_사회과_2412_최종.xlsx'],
  [kiceStd, '(KICE)) 교육과정 표준체계_실과및기술가정_2412_최종.xlsx'],
  [kiceStd, '(KOFAC) 교육과정 표준체계_과학과_2412_최종.xlsx'],
  [kiceExt, '(KICE) 교육과정 표준체계_영어과_2412_최종.xlsx'],
  [kiceExt, '(KOFAC) 교육과정 표준체계_정보과_2412_최종.xlsx'],
  [cbMath,  '3. 충북형_수학과_학습맵_계통도_KOFAC기준매핑_v2.xlsx'],
];

// ──────────────────────────────────────────────────────────
// DB 연결
// ──────────────────────────────────────────────────────────
function openDb() {
  const dbPath = path.join(PROJECT_ROOT, 'data', 'dacheum.db');
  if (!fs.existsSync(dbPath)) throw new Error(`DB 파일 없음: ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF'); // self-FK + FK를 엄격 검사하지 않음
  db.pragma('journal_mode = WAL');
  return db;
}

// ──────────────────────────────────────────────────────────
// Subjects 선등록 (tech-home-m / tech-home-h)
// ──────────────────────────────────────────────────────────
function ensureSubjects(db) {
  const existing = new Set(db.prepare('SELECT code FROM subjects').all().map(r => r.code));
  const add = [];
  if (!existing.has('tech-home-m')) add.push({ code: 'tech-home-m', name: '기술·가정', school_level: '중', sort_order: 8 });
  if (!existing.has('tech-home-h')) add.push({ code: 'tech-home-h', name: '기술·가정', school_level: '고', sort_order: 8 });
  if (add.length === 0) return { added: 0 };
  const ins = db.prepare(
    'INSERT INTO subjects (code, name, school_level, sort_order, is_active) VALUES (?, ?, ?, ?, 1)'
  );
  const tx = db.transaction(() => { for (const s of add) ins.run(s.code, s.name, s.school_level, s.sort_order); });
  tx();
  return { added: add.length, codes: add.map(a => a.code) };
}

// ──────────────────────────────────────────────────────────
// 어댑터 실행 (병렬)
// ──────────────────────────────────────────────────────────
async function runAdapters(excelDir) {
  const tasks = FILE_MAP.map(async ([mod, fname]) => {
    const full = path.join(excelDir, fname);
    if (!fs.existsSync(full)) {
      return { fname, error: '파일 없음', result: null };
    }
    try {
      const result = await mod.parseFile(full, {});
      return { fname, error: null, result };
    } catch (e) {
      return { fname, error: String(e && e.message || e), result: null };
    }
  });
  return await Promise.all(tasks);
}

// ──────────────────────────────────────────────────────────
// 출력 머지 (adapter별 결과 → 단일 배열)
// ──────────────────────────────────────────────────────────
function mergeResults(runs) {
  const all = {
    nodes: [], standards: [], standardNodes: [],
    standardLevels: [], stdIdMap: [], mapEdges: [],
    warnings: [],
  };
  const seen = {
    nodes: new Set(), stds: new Set(), stdNodes: new Set(),
    levels: new Set(), stdMap: new Set(), edges: new Set(),
  };
  for (const run of runs) {
    if (!run.result) {
      if (run.error) all.warnings.push(`[${run.fname}] ${run.error}`);
      continue;
    }
    const r = run.result;
    for (const n of (r.nodes || [])) {
      if (seen.nodes.has(n.id)) continue;
      seen.nodes.add(n.id); all.nodes.push(n);
    }
    for (const s of (r.standards || [])) {
      if (seen.stds.has(s.code)) continue;
      seen.stds.add(s.code);
      // 표준화: cb-math 는 school_level/area/content 등이 비어있어 파생
      const subj = s.subject_code || '';
      let school_level = s.school_level;
      if (!school_level) {
        if (subj.endsWith('-e')) school_level = '초';
        else if (subj.endsWith('-m')) school_level = '중';
        else if (subj.endsWith('-h')) school_level = '고';
      }
      all.standards.push({
        code: s.code,
        subject_code: subj,
        school_level: school_level || '초',
        grade_group: s.grade_group,
        grade_label: s.grade_label || '',
        area: s.area || '',
        content: s.content || s.text || '',
        sort_order: s.sort_order || all.standards.length + 1,
        std_source: s.std_source || 'CB_MATH',
        primary_node_id: s.primary_node_id || null,
      });
    }
    for (const sn of (r.standardNodes || [])) {
      const k = `${sn.standard_code}\u0000${sn.node_id}`;
      if (seen.stdNodes.has(k)) continue;
      seen.stdNodes.add(k); all.standardNodes.push(sn);
    }
    for (const lv of (r.standardLevels || [])) {
      const k = `${lv.standard_code}\u0000${lv.level_code}`;
      if (seen.levels.has(k)) continue;
      seen.levels.add(k); all.standardLevels.push(lv);
    }
    for (const m of (r.stdIdMap || [])) {
      const k = `${m.standard_code}\u0000${m.std_id}`;
      if (seen.stdMap.has(k)) continue;
      seen.stdMap.add(k); all.stdIdMap.push(m);
    }
    for (const e of (r.mapEdges || [])) {
      const k = `${e.from_node_id}\u0000${e.to_node_id}\u0000${e.edge_type || 'prerequisite'}`;
      if (seen.edges.has(k)) continue;
      seen.edges.add(k); all.mapEdges.push(e);
    }
    for (const w of (r.warnings || [])) {
      all.warnings.push(`[${run.fname}] ${w}`);
    }
  }
  return all;
}

// ──────────────────────────────────────────────────────────
// descendants 클로저 테이블 계산
// ──────────────────────────────────────────────────────────
function computeDescendants(nodes) {
  // id → parent_id
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const out = [];
  const seen = new Set();
  for (const n of nodes) {
    // 자기 자신 depth_diff=0
    const self = `${n.id}\u0000${n.id}`;
    if (!seen.has(self)) { seen.add(self); out.push({ ancestor_id: n.id, descendant_id: n.id, depth_diff: 0 }); }
    // 부모 체인 순회
    let cur = n;
    let d = 0;
    while (cur && cur.parent_id) {
      d++;
      const p = byId.get(cur.parent_id);
      if (!p) break;
      const k = `${p.id}\u0000${n.id}`;
      if (!seen.has(k)) { seen.add(k); out.push({ ancestor_id: p.id, descendant_id: n.id, depth_diff: d }); }
      cur = p;
      if (d > 16) break; // 안전 가드
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// DB 업서트
// ──────────────────────────────────────────────────────────
function writeAll(db, merged) {
  const stats = {
    nodes: 0, standards: 0, standardNodes: 0, standardLevels: 0,
    stdIdMap: 0, descendants: 0, mapEdges: 0,
  };

  // 준비
  const upNode = db.prepare(`
    INSERT INTO curriculum_content_nodes
      (id, subject_code, school_level, grade_group, depth, parent_id, label, sort_order, source, version)
    VALUES (@id, @subject_code, @school_level, @grade_group, @depth, @parent_id, @label, @sort_order, @source, @version)
    ON CONFLICT(id) DO UPDATE SET
      subject_code=excluded.subject_code,
      school_level=excluded.school_level,
      grade_group=excluded.grade_group,
      depth=excluded.depth,
      parent_id=excluded.parent_id,
      label=excluded.label,
      sort_order=excluded.sort_order,
      source=excluded.source,
      version=excluded.version
  `);
  const upStd = db.prepare(`
    INSERT INTO curriculum_standards
      (code, subject_code, school_level, grade_group, grade_label, area, content, sort_order, std_source, primary_node_id)
    VALUES (@code, @subject_code, @school_level, @grade_group, @grade_label, @area, @content, @sort_order, @std_source, @primary_node_id)
    ON CONFLICT(code) DO UPDATE SET
      subject_code   = CASE WHEN excluded.subject_code   <> '' THEN excluded.subject_code   ELSE curriculum_standards.subject_code END,
      school_level   = CASE WHEN excluded.school_level   <> '' THEN excluded.school_level   ELSE curriculum_standards.school_level END,
      grade_group    = COALESCE(excluded.grade_group, curriculum_standards.grade_group),
      grade_label    = CASE WHEN excluded.grade_label    <> '' THEN excluded.grade_label    ELSE curriculum_standards.grade_label END,
      area           = CASE WHEN excluded.area           <> '' THEN excluded.area           ELSE curriculum_standards.area END,
      content        = CASE WHEN excluded.content        <> '' THEN excluded.content        ELSE curriculum_standards.content END,
      std_source     = COALESCE(excluded.std_source, curriculum_standards.std_source),
      primary_node_id= COALESCE(excluded.primary_node_id, curriculum_standards.primary_node_id)
  `);
  const upStdNode = db.prepare(`
    INSERT OR IGNORE INTO curriculum_standard_nodes (standard_code, node_id) VALUES (?, ?)
  `);
  const upLevel = db.prepare(`
    INSERT INTO curriculum_standard_levels (standard_code, level_code, description)
    VALUES (?, ?, ?)
    ON CONFLICT(standard_code, level_code) DO UPDATE SET description=excluded.description
  `);
  const upMap = db.prepare(`
    INSERT OR IGNORE INTO curriculum_std_id_map (standard_code, std_id, subject_code, grade_group)
    VALUES (?, ?, ?, ?)
  `);
  const delDesc = db.prepare('DELETE FROM curriculum_node_descendants');
  const insDesc = db.prepare('INSERT OR IGNORE INTO curriculum_node_descendants (ancestor_id, descendant_id, depth_diff) VALUES (?, ?, ?)');
  const insEdge = db.prepare('INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id, edge_type) VALUES (?, ?, ?)');

  // curriculum_standards 가 UNIQUE(code) 를 갖지 않을 수도 있으므로 대비
  const csIdx = db.prepare("PRAGMA index_list('curriculum_standards')").all();
  const hasUnique = csIdx.some(i => i.unique);

  const tx = db.transaction(() => {
    // nodes: parent 먼저 들어가도록 depth 오름차순
    const nodesSorted = [...merged.nodes].sort((a, b) => a.depth - b.depth);
    for (const n of nodesSorted) { upNode.run(n); stats.nodes++; }

    for (const s of merged.standards) {
      try {
        upStd.run(s);
      } catch (e) {
        // UNIQUE 없는 구 스키마라면 수동 upsert
        const row = db.prepare('SELECT id FROM curriculum_standards WHERE code=?').get(s.code);
        if (row) {
          db.prepare(`UPDATE curriculum_standards SET subject_code=?, school_level=?, grade_group=?, grade_label=?, area=?, content=?, std_source=?, primary_node_id=? WHERE code=?`)
            .run(s.subject_code, s.school_level, s.grade_group, s.grade_label, s.area, s.content, s.std_source, s.primary_node_id, s.code);
        } else {
          db.prepare(`INSERT INTO curriculum_standards (code, subject_code, school_level, grade_group, grade_label, area, content, sort_order, std_source, primary_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(s.code, s.subject_code, s.school_level, s.grade_group, s.grade_label, s.area, s.content, s.sort_order, s.std_source, s.primary_node_id);
        }
      }
      stats.standards++;
    }

    for (const sn of merged.standardNodes) { upStdNode.run(sn.standard_code, sn.node_id); stats.standardNodes++; }
    for (const lv of merged.standardLevels) { upLevel.run(lv.standard_code, lv.level_code, lv.description); stats.standardLevels++; }
    for (const m of merged.stdIdMap) { upMap.run(m.standard_code, m.std_id, m.subject_code, m.grade_group); stats.stdIdMap++; }

    // descendants는 완전 재계산 → 기존 행 삭제 후 재삽입
    delDesc.run();
    const desc = computeDescendants(merged.nodes);
    for (const d of desc) { insDesc.run(d.ancestor_id, d.descendant_id, d.depth_diff); stats.descendants++; }

    for (const e of merged.mapEdges) {
      insEdge.run(e.from_node_id, e.to_node_id, e.edge_type || 'prerequisite');
      stats.mapEdges++;
    }
    return stats;
  });

  return tx();
}

// ──────────────────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────────────────
(async function main() {
  const { excel, dry } = parseArgs();
  if (!excel) {
    console.error('엑셀 폴더 경로를 지정하세요. --excel <folder> 또는 EXCEL_DIR 환경변수');
    process.exit(2);
  }
  if (!fs.existsSync(excel)) {
    console.error(`엑셀 폴더 없음: ${excel}`);
    process.exit(2);
  }

  console.log('─'.repeat(60));
  console.log('교육과정 표준체계 통합 임포트');
  console.log('엑셀 폴더:', excel);
  console.log('드라이런 :', dry ? 'YES' : 'no');
  console.log('─'.repeat(60));

  const db = openDb();
  try {
    const subjRes = ensureSubjects(db);
    if (subjRes.added > 0) console.log(`▸ subjects 선등록: ${subjRes.codes.join(', ')}`);

    console.log('▸ 어댑터 병렬 실행 중...');
    const runs = await runAdapters(excel);
    for (const r of runs) {
      if (r.result) {
        console.log(`  ✓ ${r.fname}  nodes=${r.result.nodes.length} std=${r.result.standards.length} lv=${r.result.standardLevels.length} edges=${(r.result.mapEdges||[]).length} warn=${r.result.warnings.length}`);
      } else {
        console.log(`  ✗ ${r.fname}  ${r.error}`);
      }
    }

    const merged = mergeResults(runs);
    console.log('▸ 병합 결과:',
      `nodes=${merged.nodes.length}`,
      `standards=${merged.standards.length}`,
      `standardNodes=${merged.standardNodes.length}`,
      `standardLevels=${merged.standardLevels.length}`,
      `stdIdMap=${merged.stdIdMap.length}`,
      `mapEdges=${merged.mapEdges.length}`,
      `warnings=${merged.warnings.length}`);

    if (dry) {
      console.log('▸ --dry 모드: DB 쓰기 스킵');
    } else {
      console.log('▸ DB 업서트 시작 (단일 트랜잭션)...');
      const stats = writeAll(db, merged);
      console.log('▸ 완료:', stats);
    }

    if (merged.warnings.length) {
      console.log('─'.repeat(60));
      console.log(`경고 ${merged.warnings.length}건 (앞 20건만 출력):`);
      for (const w of merged.warnings.slice(0, 20)) console.log('  !', w);
    }

    // 사후 검증
    const sumNodes = db.prepare('SELECT COUNT(*) c FROM curriculum_content_nodes').get().c;
    const sumStd = db.prepare('SELECT COUNT(*) c FROM curriculum_standards WHERE std_source IS NOT NULL').get().c;
    const sumLv = db.prepare('SELECT COUNT(*) c FROM curriculum_standard_levels').get().c;
    const sumMap = db.prepare('SELECT COUNT(*) c FROM curriculum_std_id_map').get().c;
    const sumDesc = db.prepare('SELECT COUNT(*) c FROM curriculum_node_descendants').get().c;
    const sumEdge = db.prepare('SELECT COUNT(*) c FROM learning_map_edges').get().c;
    console.log('─'.repeat(60));
    console.log('DB 현재 상태:');
    console.log(`  curriculum_content_nodes       = ${sumNodes}`);
    console.log(`  curriculum_standards (신규소스) = ${sumStd}`);
    console.log(`  curriculum_standard_levels     = ${sumLv}`);
    console.log(`  curriculum_std_id_map          = ${sumMap}`);
    console.log(`  curriculum_node_descendants    = ${sumDesc}`);
    console.log(`  learning_map_edges             = ${sumEdge}`);
  } finally {
    db.close();
  }
})().catch(e => {
  console.error('실패:', e);
  process.exit(1);
});
