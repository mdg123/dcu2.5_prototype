/**
 * regen-unit-prerequisite.mjs
 *
 * 단원 단위 엣지(edge_type='unit_prerequisite')를 "개념 prerequisite 엣지"의
 * cross-unit 집계로 정확히 재생성한다.
 *
 * 배경:
 *   - 개념 엣지(prerequisite, level3↔level3, 1170개)는 엑셀 정본과 일치하는 "정본"이다.
 *   - 기존 단원 엣지(unit_prerequisite, level2↔level2, 170개)에는 엑셀에 없는 잡엣지·역방향·
 *     사이클이 섞여 있어 학습맵 화살표/노드 드로어가 틀리게 보였다.
 *   - 정본 개념 엣지를 부모 단원(parent_node_id) 단위로 올려 집계하면 잡엣지·역방향·사이클이
 *     자연 제거되고 다갈래(여러 선수 단원)는 보존된다.
 *
 * 재생성 규칙:
 *   1. 모든 prerequisite 엣지 (from_concept → to_concept) 순회.
 *   2. 각 개념(level3)의 부모 단원 = parent_node_id (level2). 모든 level3에 parent 존재.
 *   3. unit(from) != unit(to) 인 경우만 단원 엣지 unit(from) → unit(to) 생성. 중복 제거.
 *   4. 자기참조(같은 단원 내 개념 연결) 금지.
 *   5. 개념 엣지(prerequisite)·node_contents·content_questions 등 다른 데이터는 불변.
 *
 * 안전:
 *   - 적용 전 learning_map_edges 전체를 테이블 복제(learning_map_edges_bak_unitfix)로 백업.
 *   - 기존 unit_prerequisite 행 전부 삭제 후 재생성분 INSERT. (단일 트랜잭션)
 *   - 멱등: 재실행해도 동일 결과. 백업 테이블은 최초 1회만 생성(이미 있으면 보존).
 *
 * 사용법:
 *   node scripts/regen-unit-prerequisite.mjs            # DRY-RUN (기본, 변경 없음)
 *   node scripts/regen-unit-prerequisite.mjs --apply    # 실제 적용
 *   node scripts/regen-unit-prerequisite.mjs --apply --gcp-sql  # 적용 + GCP 동기화 SQL 산출
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dacheum.db');
const BACKUP_TABLE = 'learning_map_edges_bak_unitfix';
const GCP_SQL_PATH = path.join(ROOT, 'backups', 'gcp-unitedge-resync.sql');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const GEN_GCP = args.includes('--gcp-sql');

const LV = { '초': 0, '중': 6, '고': 9 };

function main() {
  console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const db = new Database(DB_PATH);

  // --- 0) 노드 메타 (level2 = 단원, level3 = 개념) ---
  const unitNodes = db.prepare(
    `SELECT node_id, unit_name, grade_level, grade, semester FROM learning_map_nodes WHERE node_level = 2`
  ).all();
  const unitMeta = {};
  for (const u of unitNodes) unitMeta[u.node_id] = u;

  const concepts = db.prepare(
    `SELECT node_id, parent_node_id FROM learning_map_nodes WHERE node_level = 3`
  ).all();
  const concept2unit = {};
  let noParent = 0;
  for (const c of concepts) {
    if (c.parent_node_id) concept2unit[c.node_id] = c.parent_node_id;
    else noParent++;
  }
  console.log(`[map] 개념(level3): ${concepts.length}건, parent 없음: ${noParent}건`);
  if (noParent > 0) {
    console.warn(`[warn] parent_node_id 없는 개념 ${noParent}건은 단원 집계에서 제외됨`);
  }

  // --- 1) 개념 엣지(prerequisite) → cross-unit 집계 ---
  const conceptEdges = db.prepare(
    `SELECT from_node_id, to_node_id FROM learning_map_edges WHERE edge_type = 'prerequisite'`
  ).all();

  const pairSet = new Set(); // "fromUnit|toUnit"
  let cross = 0, sameUnit = 0, missingMap = 0;
  for (const e of conceptEdges) {
    const fu = concept2unit[e.from_node_id];
    const tu = concept2unit[e.to_node_id];
    if (!fu || !tu) { missingMap++; continue; }
    if (fu === tu) { sameUnit++; continue; }           // 규칙 4: 자기참조 금지
    pairSet.add(`${fu}|${tu}`);                         // 규칙 3: 중복 제거
    cross++;
  }
  console.log(`[derive] 개념 엣지 ${conceptEdges.length}건 → cross-unit ${cross} / same-unit ${sameUnit} / 매핑누락 ${missingMap}`);
  console.log(`[derive] 재생성 단원 엣지(unique): ${pairSet.size}건`);

  // --- 2) 정렬된 페어 + 학년 절대값 진단 ---
  const gradeAbs = (id) => {
    const m = unitMeta[id];
    if (!m) return 99999;
    return (LV[m.grade_level] ?? 0) * 100 + (m.grade || 0) * 10 + (m.semester || 1);
  };
  const lab = (id) => {
    const m = unitMeta[id];
    return m ? `${m.unit_name}(${m.grade_level}${m.grade}-${m.semester})` : id;
  };

  const newPairs = [...pairSet]
    .map(k => { const [f, t] = k.split('|'); return { f, t }; })
    .sort((a, b) => (gradeAbs(a.f) - gradeAbs(b.f)) || a.f.localeCompare(b.f) || a.t.localeCompare(b.t));

  // 역방향(학교급-인지) 진단 — 동학년·동학기 페어는 정본 개념엣지 순서이므로 reverse로 보지 않음.
  const reverse = newPairs.filter(p => gradeAbs(p.f) > gradeAbs(p.t));
  console.log(`[verify] 재생성 역방향(상위학년→하위학년) 엣지: ${reverse.length}건`);
  reverse.forEach(p => console.log(`         REV ${lab(p.f)} -> ${lab(p.t)}`));

  // --- 기존 vs 신규 diff ---
  const existing = db.prepare(
    `SELECT from_node_id, to_node_id FROM learning_map_edges WHERE edge_type = 'unit_prerequisite'`
  ).all();
  const exSet = new Set(existing.map(e => `${e.from_node_id}|${e.to_node_id}`));
  const removed = [...exSet].filter(k => !pairSet.has(k));
  const added = [...pairSet].filter(k => !exSet.has(k));
  console.log(`[diff] 이전 unit_prerequisite: ${existing.length} → 이후: ${newPairs.length}`);
  console.log(`[diff] 제거(잡엣지): ${removed.length}건, 추가(누락복원): ${added.length}건`);

  if (!APPLY) {
    console.log('[dry-run] 변경 없음. --apply 로 적용.');
    db.close();
    return;
  }

  // --- 3) 백업 (테이블 복제, 멱등 — 최초 1회만) ---
  const bakExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(BACKUP_TABLE);
  if (bakExists) {
    const cnt = db.prepare(`SELECT COUNT(*) c FROM ${BACKUP_TABLE}`).get().c;
    console.log(`[backup] 기존 백업 테이블 ${BACKUP_TABLE} 보존 (${cnt}행). 덮어쓰지 않음.`);
  } else {
    db.exec(
      `CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM learning_map_edges;`
    );
    const cnt = db.prepare(`SELECT COUNT(*) c FROM ${BACKUP_TABLE}`).get().c;
    console.log(`[backup] 백업 테이블 ${BACKUP_TABLE} 생성 완료 (${cnt}행).`);
  }

  // --- 4) 단일 트랜잭션: 기존 unit 엣지 삭제 → 재생성 INSERT ---
  const del = db.prepare(`DELETE FROM learning_map_edges WHERE edge_type = 'unit_prerequisite'`);
  const ins = db.prepare(
    `INSERT INTO learning_map_edges (from_node_id, to_node_id, edge_type) VALUES (?, ?, 'unit_prerequisite')`
  );
  const tx = db.transaction(() => {
    const dr = del.run();
    let n = 0;
    for (const p of newPairs) { ins.run(p.f, p.t); n++; }
    return { deleted: dr.changes, inserted: n };
  });
  const r = tx();
  console.log(`[APPLIED] 삭제 ${r.deleted}행, 삽입 ${r.inserted}행.`);

  // --- 5) 사후 검증 ---
  const afterCnt = db.prepare(
    `SELECT COUNT(*) c FROM learning_map_edges WHERE edge_type='unit_prerequisite'`
  ).get().c;
  const conceptCnt = db.prepare(
    `SELECT COUNT(*) c FROM learning_map_edges WHERE edge_type='prerequisite'`
  ).get().c;
  console.log(`[verify] unit_prerequisite 총: ${afterCnt} (기대 ${newPairs.length})`);
  console.log(`[verify] prerequisite(개념) 총: ${conceptCnt} (불변 기대 ${conceptEdges.length})`);

  // 평면도형의 이동 before/after
  const PDY = db.prepare(
    `SELECT node_id FROM learning_map_nodes WHERE node_level=2 AND unit_name='평면도형의 이동' AND grade=4`
  ).get();
  if (PDY) {
    const out = db.prepare(
      `SELECT to_node_id FROM learning_map_edges WHERE edge_type='unit_prerequisite' AND from_node_id=?`
    ).all(PDY.node_id).map(x => lab(x.to_node_id));
    const inc = db.prepare(
      `SELECT from_node_id FROM learning_map_edges WHERE edge_type='unit_prerequisite' AND to_node_id=?`
    ).all(PDY.node_id).map(x => lab(x.from_node_id));
    console.log(`[verify] 평면도형의 이동 OUT(선수→): ${JSON.stringify(out)}`);
    console.log(`[verify] 평면도형의 이동 IN(→선수): ${JSON.stringify(inc)}`);
  }

  // --- 6) GCP 동기화 SQL (옵션) ---
  if (GEN_GCP) {
    writeGcpSql(db, newPairs, unitMeta, lab);
  }

  db.close();
  console.log('[done]');
}

function sqlEsc(s) {
  return String(s).replace(/'/g, "''");
}

function writeGcpSql(db, newPairs, unitMeta, lab) {
  const lines = [];
  lines.push('-- ============================================================');
  lines.push('-- gcp-unitedge-resync.sql');
  lines.push('-- 단원 엣지(unit_prerequisite) 재동기화 — 개념 prerequisite 엣지의 cross-unit 집계 결과.');
  lines.push('-- 로컬 regen-unit-prerequisite.mjs --apply 산출물. GCP(원격) learning_map_edges에 반영.');
  lines.push('-- 개념 엣지(prerequisite)·노드·문항은 건드리지 않음 (unit_prerequisite만 교체).');
  lines.push(`-- 재생성 단원 엣지 수: ${newPairs.length}`);
  lines.push('-- ============================================================');
  lines.push('BEGIN TRANSACTION;');
  lines.push("DELETE FROM learning_map_edges WHERE edge_type='unit_prerequisite';");
  for (const p of newPairs) {
    lines.push(
      `INSERT INTO learning_map_edges (from_node_id, to_node_id, edge_type) ` +
      `VALUES ('${sqlEsc(p.f)}', '${sqlEsc(p.t)}', 'unit_prerequisite');  -- ${lab(p.f)} -> ${lab(p.t)}`
    );
  }
  lines.push('COMMIT;');
  lines.push('');
  fs.mkdirSync(path.dirname(GCP_SQL_PATH), { recursive: true });
  fs.writeFileSync(GCP_SQL_PATH, lines.join('\n'), 'utf8');
  console.log(`[gcp-sql] ${GCP_SQL_PATH} 생성 (${newPairs.length} INSERT + 1 DELETE, 트랜잭션).`);
}

main();
