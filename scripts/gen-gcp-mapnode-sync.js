#!/usr/bin/env node
/**
 * gen-gcp-mapnode-sync.js
 * ----------------------------------------------------------------------------
 * 로컬 DB(정본)의 학습맵 노드/엣지를 운영서버(GCP)로 동기화하기 위한
 * UPSERT SQL 파일을 생성한다.
 *
 * 배경:
 *   GCP 운영서버의 learning_map_nodes 에서 level3(개념/차시) 1162개 중 852개의
 *   parent_node_id 가 NULL 로 끊겨, 단원(level2)의 자식 개념(level3)을 못 찾아
 *   conceptTotal=0 → 진단 불가. (예: 4학년 "꺾은선그래프" Ud1bdeb35ff145182)
 *   노드 자체(node_id)는 GCP에도 존재하나 부모-자식 관계만 끊김.
 *   로컬은 1162개 전부 parent_node_id 채워짐(정본).
 *   content_questions·node_contents 는 직전에 동기화 완료 → 이번엔 노드/엣지만.
 *
 * 핵심 안전 원칙 (id/참조 무손상):
 *   - learning_map_nodes 의 PK 는 id(INTEGER AUTOINCREMENT) 지만, GCP 의 id 와
 *     로컬의 id 가 다를 수 있다(자동 증가 순서 차이). 따라서 **id 는 절대 동기화하지
 *     않는다.** id 기반 INSERT OR REPLACE 는 GCP id 와 로컬 id 불일치 시 중복/오염을
 *     일으키므로 **금지**.
 *   - 대신 node_id(VARCHAR UNIQUE)를 매칭 키로 사용한다:
 *       INSERT INTO learning_map_nodes (id 제외 전 컬럼)
 *       VALUES (...)
 *       ON CONFLICT(node_id) DO UPDATE SET <id 제외 전 컬럼> = excluded.<col>;
 *     → node_id 가 이미 있으면 그 행을 그대로 두고(id 유지) 나머지 컬럼만 갱신.
 *       node_id 가 없으면 새로 INSERT(id 는 GCP에서 자동 부여).
 *   - 참조 무손상: user_node_status.node_id / node_contents.node_id /
 *     learning_map_edges.from_node_id·to_node_id 는 모두 **node_id(문자열) 참조**
 *     (정수 id 참조 아님). node_id 를 유지하므로 모든 참조가 무손상.
 *
 *   - learning_map_edges 는 UNIQUE(from_node_id, to_node_id) 보유.
 *       INSERT INTO learning_map_edges (id 제외 전 컬럼)
 *       VALUES (...)
 *       ON CONFLICT(from_node_id, to_node_id) DO UPDATE SET edge_type=excluded.edge_type;
 *     → 동일 키 행은 edge_type 갱신, 없으면 추가. 삭제 없음(GCP-only 엣지 보존).
 *
 * 출력:
 *   backups/gcp-mapnode-sync.sql  — BEGIN; ... COMMIT; 단일 트랜잭션
 *
 * Escape (이전 gcp-content-sync 와 동일 규칙):
 *   - TEXT 작은따옴표(')는 '' 로 이중화. 줄바꿈/탭/백슬래시는 SQLite 리터럴이 허용.
 *   - NULL → NULL 리터럴, 숫자 컬럼은 affinity 보존(따옴표 없이).
 *   - 컬럼/타입은 PRAGMA table_info 로 동적 획득.
 *
 * 사용법:
 *   node scripts/gen-gcp-mapnode-sync.js
 *   node scripts/gen-gcp-mapnode-sync.js --db data/dacheum.db --out backups/gcp-mapnode-sync.sql
 *
 * 멱등성: 동일 DB 상태 재실행 시 동일 SQL 산출.
 *
 * 라이선스: 프로젝트 내부 사용 한정 (다채움 2.0)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── 인자 파싱 ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(PROJECT_ROOT, getArg('--db', 'data/dacheum.db'));
const OUT_PATH = path.resolve(PROJECT_ROOT, getArg('--out', 'backups/gcp-mapnode-sync.sql'));

// ── 값 직렬화 (gcp-content-sync 와 동일 규칙) ─────────────────────────────────
function serialize(val, isNumeric) {
  if (val === null || val === undefined) return 'NULL';
  if (Buffer.isBuffer(val)) return "X'" + val.toString('hex') + "'";
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 'NULL';
    return String(val);
  }
  if (typeof val === 'bigint') return val.toString();
  const s = String(val);
  if (isNumeric && /^-?\d+(\.\d+)?$/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

function isNumericType(declType) {
  if (!declType) return false;
  const t = declType.toUpperCase();
  return t.includes('INT') || t.includes('REAL') || t.includes('FLOA') ||
         t.includes('DOUB') || t.includes('NUMERIC') || t.includes('DECIMAL');
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[ERROR] DB 파일 없음: ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const db = new Database(DB_PATH, { readonly: true });
  const ts = new Date().toISOString();

  const header = [
    '-- ============================================================================',
    '-- gcp-mapnode-sync.sql  (자동 생성 — gen-gcp-mapnode-sync.js)',
    `-- 생성 시각: ${ts}`,
    `-- 소스 DB : ${path.relative(PROJECT_ROOT, DB_PATH).replace(/\\/g, '/')}`,
    '-- 대상     : GCP 운영서버 data/dacheum.db (learning_map_nodes, learning_map_edges)',
    '-- 목적     : GCP의 끊긴 parent_node_id(level3 852개 NULL) 등 노드 관계 복구',
    '-- 방식     : node_id / (from,to)_node_id 기준 UPSERT (id 무동기화 → id/참조 무손상)',
    '--            · learning_map_nodes : ON CONFLICT(node_id) DO UPDATE (id 제외 전 컬럼)',
    '--            · learning_map_edges : ON CONFLICT(from_node_id,to_node_id) DO UPDATE',
    '--            · 삭제 없음 → GCP-only 행/엣지 보존, orphan/FK 안전',
    '-- ----------------------------------------------------------------------------',
    '-- 적용 전 반드시 GCP DB 백업:',
    '--   sqlite3 data/dacheum.db ".backup data/dacheum.db.bak-mapnode-presync"',
    '-- 적용:  sqlite3 data/dacheum.db < gcp-mapnode-sync.sql',
    '-- ============================================================================',
    '',
    'PRAGMA foreign_keys=OFF;',
    'BEGIN TRANSACTION;',
    '',
  ];

  const out = fs.createWriteStream(OUT_PATH, { encoding: 'utf8' });
  out.write(header.join('\n'));

  const summary = {};

  // ── learning_map_nodes : node_id 기준 UPSERT (id 제외) ────────────────────
  {
    const table = 'learning_map_nodes';
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) { console.error(`[ERROR] 테이블 없음: ${table}`); process.exit(1); }

    // node_id UNIQUE 존재 확인 (UPSERT conflict target 보장)
    const idxList = db.prepare(`PRAGMA index_list(${table})`).all();
    const hasNodeIdUnique = idxList.some((ix) => {
      if (!ix.unique) return false;
      const c = db.prepare(`PRAGMA index_info(${ix.name})`).all().map((x) => x.name);
      return c.length === 1 && c[0] === 'node_id';
    });
    if (!hasNodeIdUnique) {
      console.error(`[ERROR] ${table}.node_id 에 UNIQUE 없음 — ON CONFLICT(node_id) 불가. 중단.`);
      process.exit(1);
    }

    // id(PK)를 제외한 컬럼만 동기화 (GCP id 보존)
    const allNames = cols.map((c) => c.name);
    const syncCols = cols.filter((c) => c.name !== 'id');
    const syncNames = syncCols.map((c) => c.name);
    const numericFlags = syncCols.map((c) => isNumericType(c.type));
    const colList = syncNames.map((n) => `"${n}"`).join(', ');
    // UPDATE SET 절: conflict 키(node_id) 제외 전 컬럼 갱신
    const updateSet = syncNames
      .filter((n) => n !== 'node_id')
      .map((n) => `"${n}"=excluded."${n}"`)
      .join(', ');

    out.write(`-- ---- ${table} (sync ${syncNames.length} cols, id 제외) ----------------\n`);
    out.write(`-- UPSERT: ON CONFLICT(node_id) DO UPDATE — GCP id 유지, node_id 매칭으로 컬럼 복구\n`);

    const rows = db.prepare(`SELECT ${colList} FROM "${table}" ORDER BY "node_id"`).iterate();
    let count = 0;
    const prefix = `INSERT INTO "${table}" (${colList}) VALUES `;
    const suffix = ` ON CONFLICT(node_id) DO UPDATE SET ${updateSet};\n`;
    for (const row of rows) {
      const vals = syncNames.map((n, i) => serialize(row[n], numericFlags[i]));
      out.write(prefix + '(' + vals.join(', ') + ')' + suffix);
      count++;
    }
    out.write(`-- ${table}: ${count} UPSERT\n\n`);
    summary[table] = count;
    void allNames;
  }

  // ── learning_map_edges : (from,to)_node_id 기준 UPSERT (id 제외) ───────────
  {
    const table = 'learning_map_edges';
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) { console.error(`[ERROR] 테이블 없음: ${table}`); process.exit(1); }

    const idxList = db.prepare(`PRAGMA index_list(${table})`).all();
    const hasComposite = idxList.some((ix) => {
      if (!ix.unique) return false;
      const c = db.prepare(`PRAGMA index_info(${ix.name})`).all().map((x) => x.name);
      return c.length === 2 && c.includes('from_node_id') && c.includes('to_node_id');
    });
    if (!hasComposite) {
      console.error(`[ERROR] ${table} 에 UNIQUE(from_node_id,to_node_id) 없음 — 중단.`);
      process.exit(1);
    }

    const syncCols = cols.filter((c) => c.name !== 'id');
    const syncNames = syncCols.map((c) => c.name);
    const numericFlags = syncCols.map((c) => isNumericType(c.type));
    const colList = syncNames.map((n) => `"${n}"`).join(', ');
    const keySet = new Set(['from_node_id', 'to_node_id']);
    const updateCols = syncNames.filter((n) => !keySet.has(n));
    // edge_type 외 갱신 대상이 없으면 DO NOTHING 으로(키만 있는 행) 안전 폴백
    const upsertTail = updateCols.length
      ? ` ON CONFLICT(from_node_id, to_node_id) DO UPDATE SET ${updateCols.map((n) => `"${n}"=excluded."${n}"`).join(', ')};\n`
      : ` ON CONFLICT(from_node_id, to_node_id) DO NOTHING;\n`;

    out.write(`-- ---- ${table} (sync ${syncNames.length} cols, id 제외) ----------------\n`);
    out.write(`-- UPSERT: ON CONFLICT(from_node_id,to_node_id) — 기존 엣지 edge_type 갱신, 신규 추가\n`);

    const rows = db.prepare(`SELECT ${colList} FROM "${table}" ORDER BY "from_node_id", "to_node_id"`).iterate();
    let count = 0;
    const prefix = `INSERT INTO "${table}" (${colList}) VALUES `;
    for (const row of rows) {
      const vals = syncNames.map((n, i) => serialize(row[n], numericFlags[i]));
      out.write(prefix + '(' + vals.join(', ') + ')' + upsertTail);
      count++;
    }
    out.write(`-- ${table}: ${count} UPSERT\n\n`);
    summary[table] = count;
  }

  out.write('COMMIT;\n');
  out.write('PRAGMA foreign_keys=ON;\n');
  out.write('\n-- 검증 SQL (적용 후 실행 권장):\n');
  out.write("-- 1) level3 parent NOT NULL 수 (1162 기대):\n");
  out.write("--    SELECT COUNT(*) FROM learning_map_nodes WHERE node_level=3 AND parent_node_id IS NOT NULL;\n");
  out.write("-- 2) 꺾은선그래프 자식 수 (6 기대):\n");
  out.write("--    SELECT COUNT(*) FROM learning_map_nodes WHERE parent_node_id='Ud1bdeb35ff145182' AND node_level=3;\n");
  out.write("-- 3) 엣지 총수:\n");
  out.write("--    SELECT COUNT(*) FROM learning_map_edges;\n");
  out.end();

  db.close();

  out.on('finish', () => {
    const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
    console.log('=== GCP mapnode sync SQL 생성 완료 ===');
    console.log(`출력: ${path.relative(PROJECT_ROOT, OUT_PATH).replace(/\\/g, '/')} (${sizeKB} KB)`);
    console.log(`  learning_map_nodes: ${summary['learning_map_nodes']} UPSERT (node_id 기준, id 제외)`);
    console.log(`  learning_map_edges: ${summary['learning_map_edges']} UPSERT ((from,to)_node_id 기준, id 제외)`);
  });
}

main();
