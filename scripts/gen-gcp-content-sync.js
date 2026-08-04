#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * gen-gcp-content-sync.js
 * ----------------------------------------------------------------------------
 * 로컬 DB(정본)의 학습 문항 데이터를 운영서버(GCP)로 동기화하기 위한
 * INSERT OR REPLACE SQL 파일을 생성한다.
 *
 * 배경:
 *   GCP 운영서버의 content_questions / node_contents 행이 로컬보다 부족해
 *   일부 단원(예: 4학년 "꺾은선그래프")이 conceptTotal=0 으로 진단 불가.
 *   노드(learning_map_nodes)/엣지는 양쪽 동일. 문항과 개념-문항 연결만 부족.
 *
 * 산출:
 *   backups/gcp-content-sync.sql
 *     - BEGIN; ... COMMIT; 로 감싼 단일 트랜잭션
 *     - content_questions 전체 INSERT OR REPLACE (PK=id 기준 교체/추가)
 *     - node_contents      전체 INSERT OR REPLACE (PK=id 기준 교체/추가)
 *
 * 안전성:
 *   - INSERT OR REPLACE 는 PRIMARY KEY(id) 충돌 시 해당 행 교체, 없으면 추가.
 *     **삭제 없음** → GCP-only 행은 그대로 유지되어 orphan/FK 안전.
 *   - 두 테이블 모두 PK 가 id(AUTOINCREMENT) 단일. UNIQUE 보조 제약 없음
 *     → node_contents 의 (node_id, content_id) 중복행(정상 데이터)도
 *       id 단위로 1:1 보존됨. (node_id+content_id 키로 하면 중복행 유실됨 → 금지)
 *   - 컬럼 목록은 PRAGMA table_info 로 동적 획득(스키마 변화 대비).
 *
 * Escape:
 *   - TEXT 값의 작은따옴표(')는 ''로 이중화.
 *   - 줄바꿈/탭/백슬래시 등은 SQLite 문자열 리터럴이 그대로 허용하므로
 *     별도 변환 없이 작은따옴표만 escape 하면 안전.
 *   - NULL 은 대문자 NULL 리터럴로, INTEGER/REAL 은 숫자 그대로 직렬화.
 *   - 컬럼별 선언 타입(PRAGMA)으로 숫자/문자 직렬화 분기.
 *
 * 사용법:
 *   node scripts/gen-gcp-content-sync.js
 *   node scripts/gen-gcp-content-sync.js --db data/dacheum.db --out backups/gcp-content-sync.sql
 *
 * 멱등성: 동일 DB 상태에서 재실행하면 동일 SQL 산출(재생성 가능).
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
const OUT_PATH = path.resolve(PROJECT_ROOT, getArg('--out', 'backups/gcp-content-sync.sql'));

// 동기화 대상 테이블 (순서: FK 의존성 없는 평면 데이터지만 명시 순서 유지)
const TABLES = ['content_questions', 'node_contents'];

// ── 값 직렬화 ────────────────────────────────────────────────────────────────
/**
 * SQL 리터럴로 직렬화.
 * @param {*} val  better-sqlite3 가 반환한 JS 값 (string|number|null|Buffer)
 * @param {boolean} isNumeric  컬럼 선언 타입이 숫자 계열인지
 */
function serialize(val, isNumeric) {
  if (val === null || val === undefined) return 'NULL';
  if (Buffer.isBuffer(val)) {
    // BLOB → X'..' (현재 대상 테이블엔 BLOB 없음, 방어적 처리)
    return "X'" + val.toString('hex') + "'";
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 'NULL'; // NaN/Infinity 방어
    return String(val);
  }
  if (typeof val === 'bigint') {
    return val.toString();
  }
  // 문자열 (또는 숫자 컬럼에 들어간 문자열 등 모든 비숫자)
  const s = String(val);
  // 숫자 컬럼인데 순수 정수/실수 문자열이면 따옴표 없이(타입 affinity 보존)
  if (isNumeric && /^-?\d+(\.\d+)?$/.test(s)) {
    return s;
  }
  // 작은따옴표 이중화. 줄바꿈/백슬래시/탭 등은 SQLite 리터럴이 그대로 허용.
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
    '-- gcp-content-sync.sql  (자동 생성 — gen-gcp-content-sync.js)',
    `-- 생성 시각: ${ts}`,
    `-- 소스 DB : ${path.relative(PROJECT_ROOT, DB_PATH).replace(/\\/g, '/')}`,
    '-- 대상     : GCP 운영서버 data/dacheum.db (content_questions, node_contents)',
    '-- 방식     : INSERT OR REPLACE (PK=id 기준 교체/추가, 삭제 없음 → FK/orphan 안전)',
    '-- ----------------------------------------------------------------------------',
    '-- 적용 전 반드시 GCP DB 백업: sqlite3 data/dacheum.db ".backup data/dacheum.db.bak-presync"',
    '-- 적용:        sqlite3 data/dacheum.db < gcp-content-sync.sql',
    '-- ----------------------------------------------------------------------------',
    '-- ★ 적용 직후 반드시 실행 (빠뜨리면 안 됨):',
    '--     node scripts/harness-stamp.js mark --script gcp-content-sync.sql',
    '--   sqlite3 CLI 는 better-sqlite3 를 거치지 않으므로 하네스 변형 표식이',
    '--   **자동으로 남지 않는다**. 이 한 줄을 빠뜨리면 데이터가 바뀐 줄 모른 채',
    '--   하네스가 계속 초록으로 보인다 — 2026-07-31 사고와 정확히 같은 형태다.',
    '--   표식 후 해소: 로컬에서 npm test 전건 통과 / 확인: npm run verify:fresh',
    '-- ============================================================================',
    '',
    'PRAGMA foreign_keys=OFF;',
    'BEGIN TRANSACTION;',
    '',
  ];

  const out = fs.createWriteStream(OUT_PATH, { encoding: 'utf8' });
  out.write(header.join('\n'));

  const summary = {};

  for (const table of TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) {
      console.error(`[ERROR] 테이블 없음 또는 컬럼 0: ${table}`);
      process.exit(1);
    }
    const colNames = cols.map((c) => c.name);
    const numericFlags = cols.map((c) => isNumericType(c.type));
    const colList = colNames.map((n) => `"${n}"`).join(', ');

    out.write(`-- ---- ${table} (${colNames.length} cols) -----------------------------------------\n`);

    // PK(id) 정렬 — 안정적/멱등 산출
    const orderCol = colNames.includes('id') ? 'id' : colNames[0];
    const rows = db.prepare(`SELECT ${colList} FROM "${table}" ORDER BY "${orderCol}"`).iterate();

    let count = 0;
    const prefix = `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES `;
    for (const row of rows) {
      const vals = colNames.map((n, i) => serialize(row[n], numericFlags[i]));
      out.write(prefix + '(' + vals.join(', ') + ');\n');
      count++;
    }
    out.write(`-- ${table}: ${count} rows\n\n`);
    summary[table] = count;
  }

  out.write('COMMIT;\n');
  out.write('PRAGMA foreign_keys=ON;\n');
  out.end();

  db.close();

  out.on('finish', () => {
    const totalInserts = Object.values(summary).reduce((a, b) => a + b, 0);
    const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
    console.log('=== GCP content sync SQL 생성 완료 ===');
    console.log(`출력: ${path.relative(PROJECT_ROOT, OUT_PATH).replace(/\\/g, '/')} (${sizeKB} KB)`);
    for (const t of TABLES) console.log(`  ${t}: ${summary[t]} INSERT OR REPLACE`);
    console.log(`  합계: ${totalInserts} 개 INSERT`);
  });
}

main();
