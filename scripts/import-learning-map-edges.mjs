#!/usr/bin/env node
import './_stamp-on-write.js'; // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * scripts/import-learning-map-edges.mjs
 * ------------------------------------------------------------------
 * 공식 KOFAC 기준 엑셀 계통도(`통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx`)를 진실의 원천(SSOT)으로 삼아
 * `learning_map_edges` 테이블을 재시드한다.
 *
 * [2026-05-27 갱신] 기본 엑셀 경로를 KOFAC v2 로 단일화함.
 *   - 과거 임시 엑셀 `통합_학습맵_계통도_연결_완성.xlsx` 는 폐기.
 *   - KOFAC v2 엑셀도 시트명(`학습맵_리니어연결`)과 컬럼 구조가 동일하므로 파서 변경 없음.
 *
 * - 행마다 3단계ID + 선수학습ID + 후속학습ID 파싱
 *   - 후속ID: from = 3단계ID, to = 후속ID
 *   - 선수ID: from = 선수ID,   to = 3단계ID
 * - 분리자: `,` `;` 공백/줄바꿈 모두 지원
 * - edge_type = 'prerequisite' (직계 선수, 차시 단위)
 *
 * 모드
 * - `--truncate`         : `edge_type IN ('prerequisite','next','unit_prerequisite')` 전체 삭제 후 재시드
 *                          (단, `edge_type IN ('manual','custom')` 는 보존)
 * - 기본(`--truncate` 없음) : INSERT OR IGNORE 로 누락분만 보강
 * - `--dry-run`          : DB 변경 없이 시뮬레이션
 *                          ⚠ 방식은 "write→ROLLBACK" — db.transaction() 안에서 실제로
 *                          INSERT 를 수행한 뒤 의도적 throw 로 롤백한다(DB 순변경 0).
 *                          하네스 변형 표식은 트랜잭션 결과를 존중해 롤백분을 표식하지
 *                          않는다(test/harness-freshness.test.js REG-HF6b 가 고정).
 * - `--excel <경로>`     : 엑셀 경로 (기본 ./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx)
 * - `--db <경로>`        : SQLite 경로 (기본 ./data/dacheum.db)
 *
 * 사용 예:
 *   node scripts/import-learning-map-edges.mjs --truncate
 *   node scripts/import-learning-map-edges.mjs --excel ./통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx --truncate
 *   node scripts/import-learning-map-edges.mjs --dry-run
 *
 * 멱등성: 같은 엑셀로 여러 번 실행해도 결과 동일.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

// ─── 인자 파싱 ────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { truncate: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--truncate') args.truncate = true;
    else if (a === '--dry-run' || a === '--dryRun') args.dryRun = true;
    else if (a === '--excel') args.excel = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const ARGS = parseArgs(process.argv);
if (ARGS.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'));
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(path.join(__dirname, '..'));
const EXCEL_PATH = ARGS.excel ? path.resolve(ARGS.excel) : path.join(ROOT, '통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');
const DB_PATH = ARGS.db ? path.resolve(ARGS.db) : path.join(ROOT, 'data', 'dacheum.db');

if (!fs.existsSync(EXCEL_PATH)) {
  console.error(`[import-edges] 엑셀 파일을 찾을 수 없습니다: ${EXCEL_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`[import-edges] DB 파일을 찾을 수 없습니다: ${DB_PATH}`);
  process.exit(1);
}

console.log('========================================');
console.log('[import-edges] 학습맵 선수/후속 엣지 재시드');
console.log('  엑셀:', EXCEL_PATH);
console.log('  DB  :', DB_PATH);
console.log('  옵션:', { truncate: ARGS.truncate, dryRun: ARGS.dryRun });
console.log('========================================');

// ─── 엑셀 로드 ─────────────────────────────────────────────────────
const wb = XLSX.readFile(EXCEL_PATH);
const SHEET = '학습맵_리니어연결';
if (!wb.SheetNames.includes(SHEET)) {
  console.error(`[import-edges] 시트 '${SHEET}' 를 찾을 수 없습니다.`);
  console.error('  존재 시트:', wb.SheetNames);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { defval: '' });
console.log(`[import-edges] 엑셀 행 수: ${rows.length}`);

// ─── 헬퍼: ID 분리 ─────────────────────────────────────────────────
const ID_PATTERN = /^[A-Z]\d?[A-Z]{2,4}[A-Z0-9]+$/i; // 예: E2MATA01B01C01D01
function splitIds(s) {
  return String(s ?? '')
    .split(/[,;\s\n\r]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => ID_PATTERN.test(x));
}

// ─── 엑셀에서 expected 엣지 집합 / 노드 정보 추출 ─────────────────
const expectedEdges = new Set(); // 'from->to'
const nodeInfo = new Map(); // 3단계ID -> { subject, grade, semester, ... }
const referencedNodeIds = new Set(); // 등장한 모든 노드 ID
let edgesFromFollow = 0;
let edgesFromPrereq = 0;
let rowsMissing3 = 0;
let invalidIdRefs = 0;

function pickGradeLevel(grade) {
  const g = Number(grade);
  if (!Number.isFinite(g)) return '초';
  if (g <= 6) return '초';
  if (g <= 9) return '중';
  return '고';
}

for (const r of rows) {
  const cur = String(r['3단계ID'] ?? '').trim();
  if (!cur) { rowsMissing3++; continue; }
  if (!ID_PATTERN.test(cur)) { invalidIdRefs++; continue; }

  referencedNodeIds.add(cur);

  const grade = Number(r['적용학년']) || null;
  const semester = Number(r['적용학기']) || null;
  const subject = String(r['교과'] ?? '').trim() || null;
  const area = String(r['내용체계영역'] ?? '').trim() || null;
  const unit = String(r['단원명'] ?? '').trim() || null;
  const lesson = String(r['3단계내용요소'] ?? '').trim() || null;
  const achCode = String(r['성취기준코드'] ?? '').trim() || null;
  const achText = String(r['성취기준'] ?? '').trim() || null;

  // 3단계ID에 대한 가장 풍부한 정보를 우선 보존 (먼저 만난 행)
  if (!nodeInfo.has(cur)) {
    nodeInfo.set(cur, {
      node_id: cur,
      subject,
      grade_level: pickGradeLevel(grade),
      grade: grade || 0,
      semester,
      area,
      unit_name: unit,
      lesson_name: lesson,
      achievement_code: achCode,
      achievement_text: achText,
      node_level: 3,
      parent_node_id: null,
      sort_order: 0,
    });
  }

  for (const to of splitIds(r['후속학습ID'])) {
    referencedNodeIds.add(to);
    if (to === cur) continue;
    expectedEdges.add(`${cur}->${to}`);
    edgesFromFollow++;
  }
  for (const from of splitIds(r['선수학습ID'])) {
    referencedNodeIds.add(from);
    if (from === cur) continue;
    expectedEdges.add(`${from}->${cur}`);
    edgesFromPrereq++;
  }
}

console.log(`[import-edges] 3단계ID 정의된 행:       ${rows.length - rowsMissing3}`);
console.log(`[import-edges] 행에서 추출한 후속 참조: ${edgesFromFollow}`);
console.log(`[import-edges] 행에서 추출한 선수 참조: ${edgesFromPrereq}`);
console.log(`[import-edges] 유니크 expected 엣지:    ${expectedEdges.size}`);
console.log(`[import-edges] 유니크 referenced 노드:  ${referencedNodeIds.size}`);
if (rowsMissing3) console.log(`[import-edges] ! 3단계ID 비어있는 행: ${rowsMissing3}`);
if (invalidIdRefs) console.log(`[import-edges] ! 패턴 불일치 ID 토큰: ${invalidIdRefs}`);

// ─── DB 작업 ──────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const stats = {
  before_edges: 0,
  before_nodes_referenced_present: 0,
  deleted_edges: 0,
  inserted_edges: 0,
  ignored_edges: 0,
  inserted_nodes: 0,
  after_edges: 0,
  preserved_manual: 0,
  excel_matched_after: 0,
  excel_missing_after: 0,
};

stats.before_edges = db.prepare('SELECT COUNT(*) c FROM learning_map_edges').get().c;
stats.preserved_manual = db.prepare(
  "SELECT COUNT(*) c FROM learning_map_edges WHERE edge_type IN ('manual','custom')"
).get().c;

// 보강용: 현재 노드 존재여부
const nodeExistsStmt = db.prepare('SELECT 1 AS x FROM learning_map_nodes WHERE node_id = ?');
for (const id of referencedNodeIds) {
  if (nodeExistsStmt.get(id)) stats.before_nodes_referenced_present++;
}

const insertNode = db.prepare(`
  INSERT OR IGNORE INTO learning_map_nodes
    (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name,
     achievement_code, achievement_text, node_level, parent_node_id, sort_order)
  VALUES (@node_id, @subject, @grade_level, @grade, @semester, @area, @unit_name, @lesson_name,
          @achievement_code, @achievement_text, @node_level, @parent_node_id, @sort_order)
`);

const truncateAutoEdges = db.prepare(
  "DELETE FROM learning_map_edges WHERE edge_type IS NULL OR edge_type IN ('prerequisite','next','unit_prerequisite')"
);
const insertEdge = db.prepare(
  "INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id, edge_type) VALUES (?, ?, 'prerequisite')"
);

const runTx = db.transaction(() => {
  // 1) 누락 노드 보강
  for (const id of referencedNodeIds) {
    if (nodeExistsStmt.get(id)) continue;
    const info = nodeInfo.get(id) || {
      node_id: id,
      subject: null,
      grade_level: '초',
      grade: 0,
      semester: null,
      area: null,
      unit_name: null,
      lesson_name: null,
      achievement_code: null,
      achievement_text: null,
      node_level: 3,
      parent_node_id: null,
      sort_order: 0,
    };
    const res = insertNode.run(info);
    if (res.changes) stats.inserted_nodes++;
  }

  // 2) 기존 자동 엣지 삭제 (truncate 모드)
  if (ARGS.truncate) {
    const r = truncateAutoEdges.run();
    stats.deleted_edges = r.changes;
  }

  // 3) 엑셀 엣지 삽입
  for (const key of expectedEdges) {
    const [from, to] = key.split('->');
    const res = insertEdge.run(from, to);
    if (res.changes === 1) stats.inserted_edges++;
    else stats.ignored_edges++;
  }
});

const edgeExistsStmt = db.prepare(
  'SELECT 1 AS x FROM learning_map_edges WHERE from_node_id = ? AND to_node_id = ?'
);
const countEdgesStmt = db.prepare('SELECT COUNT(*) c FROM learning_map_edges');
const missingSamples = [];

function validateAfter() {
  stats.after_edges = countEdgesStmt.get().c;
  stats.excel_matched_after = 0;
  stats.excel_missing_after = 0;
  missingSamples.length = 0;
  for (const key of expectedEdges) {
    const [from, to] = key.split('->');
    if (edgeExistsStmt.get(from, to)) stats.excel_matched_after++;
    else {
      stats.excel_missing_after++;
      if (missingSamples.length < 10) missingSamples.push(key);
    }
  }
}

if (ARGS.dryRun) {
  // dry-run: 변경사항을 트랜잭션 내에서 적용 → 검증 → 강제 ROLLBACK
  console.log('[import-edges] --dry-run: 변경사항 ROLLBACK 됩니다 (검증은 적용 상태에서 실시)');
  try {
    db.transaction(() => {
      runTx();
      validateAfter();
      throw new Error('__DRY_RUN_ROLLBACK__');
    })();
  } catch (err) {
    if (err.message !== '__DRY_RUN_ROLLBACK__') throw err;
  }
} else {
  runTx();
  validateAfter();
}

const matchRate = expectedEdges.size
  ? ((stats.excel_matched_after / expectedEdges.size) * 100).toFixed(2)
  : '0.00';

console.log('\n========== 결과 ==========');
console.log(`before_edges                : ${stats.before_edges}`);
console.log(`preserved_manual            : ${stats.preserved_manual}`);
console.log(`deleted_edges (truncate)    : ${stats.deleted_edges}`);
console.log(`inserted_nodes (보강)       : ${stats.inserted_nodes}`);
console.log(`inserted_edges              : ${stats.inserted_edges}`);
console.log(`ignored_edges (이미 존재)   : ${stats.ignored_edges}`);
console.log(`after_edges                 : ${stats.after_edges}`);
console.log(`엑셀 매칭 (DB에 있음)       : ${stats.excel_matched_after} / ${expectedEdges.size}  (${matchRate}%)`);
console.log(`엑셀 누락 (DB에 없음)       : ${stats.excel_missing_after}`);
if (missingSamples.length) {
  console.log(`누락 샘플:`);
  for (const s of missingSamples) console.log(`  - ${s}`);
}
console.log('========================');

if (ARGS.dryRun) console.log('[import-edges] dry-run 완료 — DB 변경 없음');
else console.log('[import-edges] 완료');

db.close();
process.exit(0);
