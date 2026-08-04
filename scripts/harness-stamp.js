#!/usr/bin/env node
'use strict';
/**
 * scripts/harness-stamp.js — 하네스 검증 스탬프 (라이브러리 + CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 * ■ 왜 필요한가 (2026-07-31 사고)
 *   하네스(`npm test`)의 근거 데이터는 **정본 DB(data/dacheum.db)** 다.
 *   그런데 DB 는 .gitignore 대상 — **git 이 볼 수 없다.**
 *   그래서 2026-07-31 에 아래 순서가 그대로 통과했다:
 *
 *     16:14 commit  →  push(pre-push: npm test ✅)  →  16:18 재집계 --apply
 *          →  16:20 GCP 배포 + "완료" 보고  →  (4일간 아무 게이트도 안 돎)
 *          →  08-04 사용자 앞에서 npm test 6건 실패
 *
 *   재집계가 하네스의 GT(근거 데이터)를 바꿨는데, 그 변경은 **git 변경이 아니므로**
 *   커밋·푸시 게이트가 원리적으로 감지할 수 없었다. 사람 실수가 아니라 절차의 구멍이다.
 *
 * ■ 장치
 *   정본 DB 안에 `harness_stamp` 1행을 두고 두 시각을 기록한다.
 *     · mutation_at        — 데이터 변형 스크립트가 정본 DB 에 실제로 write 한 시각
 *     · verified_mutation_at — 그 mutation_at 을 "전체 하네스 통과"로 소화한 시각표식
 *   `mutation_at > verified_mutation_at` 이면 **미검증(stale)** 이다.
 *
 *   스탬프를 DB 안에 두는 이유:
 *     ① DB 와 함께 이동 → GCP 실서버에서 재집계해도 그 DB 에 표식이 남는다(로컬 전용 아님).
 *     ② 하네스가 뜨는 임시 복사본(test/_setup.js)에도 그대로 실려 → 테스트가 직접 읽는다.
 *     ③ 파일 기반(.json)과 달리 DB 를 백업/복원해도 표식이 데이터와 어긋나지 않는다.
 *
 * ■ 누가 언제 쓰나
 *   기록(mutation) : scripts/_stamp-on-write.js  — 데이터 변형 스크립트가 1줄 require.
 *                    better-sqlite3 를 후킹해 **실제 write 가 일어난 경우에만** 자동 기록.
 *   기록(verified) : scripts/run-harness.js      — `npm test` 전체 실행이 **통과했을 때만**.
 *   판정           : test/harness-freshness.test.js (하네스 안), 이 파일의 `check` CLI,
 *                    scripts/git-hooks/pre-push, server.js 기동 배너.
 *
 * ■ 알려진 한계 (설계상 의도 / 감수한 것 — 모르고 넘어가지 말 것)
 *   ① **서버 런타임 write 는 의도적으로 계측하지 않는다.**
 *      routes/·db/ 를 통한 학생·교사의 정상 활동은 표식을 남기지 않는다. 남기면 클릭마다
 *      경보가 울려 "미검증" 신호가 상시 참이 되고, 상시 참인 경보는 아무도 안 본다.
 *      대가: 런타임 경로로만 발생한 데이터 변화는 이 장치가 못 잡는다(하네스 GT 가
 *      실사용 트래픽에 흔들릴 수 있다는 기존 위험은 그대로 남는다).
 *   ② **better-sqlite3 를 거치지 않는 적용은 표식이 0 이다.**
 *      `sqlite3 data/dacheum.db < *.sql`(gen-gcp-*-sync.js 산출물 등)이 대표적이다.
 *      → 그 .sql 헤더에 `harness-stamp.js mark` 실행 지시를 박아 두었다. 수동 절차다.
 *   ③ **fail-open**: 스탬프 테이블이 아예 없는 DB 는 "변형 이력 없음"=정상으로 본다.
 *      장치 도입 이전 DB·새로 만든 DB 가 첫 실행부터 붉어지지 않게 하려는 선택이다.
 *      대가: 누군가 harness_stamp 를 DROP 하면 조용히 초록이 된다.
 *   ④ **verified_sha 는 기록만 하고 판정에 쓰지 않는다.**
 *      판정은 오직 mutation_at vs verified_mutation_at 두 시각의 대소다. 따라서
 *      **검증 당시보다 오래된 DB 백업을 복원하면**(스탬프까지 함께 되돌아감) 그 DB 는
 *      초록으로 보인다. 백업 복원 후에는 코드 상태와 무관하게 `npm test` 를 한 번 돌릴 것.
 *
 * ■ CLI
 *   node scripts/harness-stamp.js show   [--db <path>]   현재 스탬프 출력
 *   node scripts/harness-stamp.js check  [--db <path>]   미검증이면 exit 2 (+한국어 경고)
 *   node scripts/harness-stamp.js mark   [--db <path>] --script <name> [--note <s>]
 *                                                        변형 표식 수동 기록(테스트/수동작업용)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const CANONICAL_DB = path.join(ROOT, 'data', 'dacheum.db');

const DDL = `
CREATE TABLE IF NOT EXISTS harness_stamp (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  mutation_at          TEXT,   -- 마지막 데이터 변형 시각 (ISO)
  mutation_script      TEXT,   -- 변형을 일으킨 스크립트 파일명
  mutation_host        TEXT,   -- 어디서 돌았나 (로컬 PC / GCP VM 구분용)
  mutation_note        TEXT,
  verified_at          TEXT,   -- 마지막 "전체 하네스 통과" 시각
  verified_mutation_at TEXT,   -- 그때 소화한 mutation_at 값
  verified_sha         TEXT,   -- 그때의 git HEAD
  verified_host        TEXT
)`;

/** 스탬프 테이블 보장 (열린 핸들 대상, 멱등) */
function ensure(db) {
  db.exec(DDL);
  db.prepare('INSERT OR IGNORE INTO harness_stamp (id) VALUES (1)').run();
  return db;
}

/** 읽기 전용 열기(파일 없으면 null) */
function openRead(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

/**
 * 스탬프 읽기. 테이블이 없으면(=한 번도 기록 안 됨) 빈 스탬프를 돌려준다.
 * @param {import('better-sqlite3').Database} db
 */
function read(db) {
  const EMPTY = {
    mutation_at: null, mutation_script: null, mutation_host: null, mutation_note: null,
    verified_at: null, verified_mutation_at: null, verified_sha: null, verified_host: null,
  };
  try {
    const row = db.prepare('SELECT * FROM harness_stamp WHERE id = 1').get();
    return row ? { ...EMPTY, ...row } : EMPTY;
  } catch (_) {
    return EMPTY; // 테이블 미존재 = 아직 아무 변형도 기록된 적 없음
  }
}

/** 경로로 읽기(핸들 관리 포함) */
function readPath(dbPath) {
  const db = openRead(dbPath);
  if (!db) return null;
  try { return read(db); } finally { try { db.close(); } catch (_) {} }
}

/**
 * 미검증(stale) 판정.
 *   변형 기록이 있는데, 그 변형을 소화한 하네스 통과 기록이 없거나 더 오래됐다 → true
 * 문자열 ISO 비교로 충분(둘 다 toISOString 산출·UTC 고정폭).
 */
function isStale(stamp) {
  if (!stamp || !stamp.mutation_at) return false;
  if (!stamp.verified_mutation_at) return true;
  return String(stamp.verified_mutation_at) < String(stamp.mutation_at);
}

/**
 * 변형 기록 (열린 핸들 대상)
 * @param {{script?:string, note?:string, host?:string, at?:string}} opts
 *        at — 시각 주입(테스트에서 두 사건의 선후를 ms 충돌 없이 고정하기 위함). 평시 생략.
 */
function recordMutation(db, { script, note, host, at: atOverride } = {}) {
  ensure(db);
  const at = atOverride || new Date().toISOString();
  db.prepare(`
    UPDATE harness_stamp
       SET mutation_at = ?, mutation_script = ?, mutation_host = ?, mutation_note = ?
     WHERE id = 1
  `).run(at, script || 'unknown', host || os.hostname(), note || null);
  return at;
}

/** 변형 기록 (경로 대상) */
function recordMutationPath(dbPath, opts) {
  const db = new Database(dbPath);
  try { return recordMutation(db, opts); } finally { try { db.close(); } catch (_) {} }
}

/**
 * 검증 통과 기록. **전체 하네스가 통과했을 때만** 호출할 것.
 * verified_mutation_at 에 "지금 DB 에 적힌 mutation_at" 을 그대로 복사해 소화 표시한다.
 */
function recordVerified(db, { sha, host, at: atOverride } = {}) {
  ensure(db);
  const now = atOverride || new Date().toISOString();
  db.prepare(`
    UPDATE harness_stamp
       SET verified_at = ?, verified_mutation_at = mutation_at, verified_sha = ?, verified_host = ?
     WHERE id = 1
  `).run(now, sha || null, host || os.hostname());
  return now;
}

function recordVerifiedPath(dbPath, opts) {
  const db = new Database(dbPath);
  try { return recordVerified(db, opts); } finally { try { db.close(); } catch (_) {} }
}

/** 사람이 읽는 한국어 경고문 */
function staleMessage(stamp, dbPath) {
  return [
    '════════════════════════════════════════════════════════════════════',
    '🔴 하네스 미검증 — 정본 데이터가 바뀐 뒤 전체 하네스를 돌리지 않았습니다.',
    `   대상 DB      : ${dbPath}`,
    `   마지막 변형  : ${stamp.mutation_at}  (${stamp.mutation_script || '?'} @ ${stamp.mutation_host || '?'})`,
    `   마지막 검증  : ${stamp.verified_at || '(없음)'}`,
    '',
    '   하네스의 근거 데이터는 DB 다. DB 가 바뀌면 통과 이력은 무효다.',
    '   지금 해야 할 일:  npm test        ← 통과해야 스탬프가 갱신된다',
    '   상태 확인      :  npm run verify:fresh',
    '════════════════════════════════════════════════════════════════════',
  ].join('\n');
}

// ── 계측 대상 스크립트 판별 ──────────────────────────────────────────────────
// 여기가 "어떤 스크립트가 표식을 달아야 하는가" 의 **유일한 정본**이다.
// test/harness-freshness.test.js 가 이 함수로 전수 검사하므로,
// 계측 없는 데이터 변형 스크립트를 새로 추가하면 `npm test` 가 붉어진다.
// → 사람의 기억이 아니라 하네스가 계측 누락을 잡는다.

/** 쓰기 SQL 을 포함하는가 (문자열 리터럴 기준의 보수적 판별) */
const WRITE_SQL_RE = /\b(INSERT\s+(?:INTO|OR)|REPLACE\s+INTO|UPDATE\s+[`"'[\]\w.]+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE)\b/i;

/** 정적 판별로는 못 잡지만 반드시 계측해야 하는 스크립트 (동적 SQL·위임 호출) */
const ALWAYS_INSTRUMENT = [
  'roll-seed-dates.js',            // 테이블/컬럼을 PRAGMA 로 훑어 동적 UPDATE (리터럴 SQL 없음)
  'age-db-canary.js',              // 동일 기법(시간축 이동)
  'rebuild-lrs-aggregates-w2a.js', // 쓰기를 db/lrs-aggregate 에 위임 (리터럴 SQL 없음)
];

/** 계측 대상에서 제외 — 장치 자신 */
const SELF = ['harness-stamp.js', '_stamp-on-write.js', 'run-harness.js'];

/**
 * 스캔 제외 디렉터리.
 *   test-data 는 .gitignore 대상(로컬 산출물)이라 머신마다 내용이 달라진다.
 *   포함하면 REG-HF4 결과가 환경 의존이 되어 하네스의 결정성이 깨진다.
 */
const SKIP_DIRS = new Set(['node_modules', 'test-data', '.git', 'git-hooks']);

/**
 * scripts/ 를 **재귀로** 훑어 "데이터 변형 스크립트" 를 전수 열거한다.
 *
 * ⚠ 재귀인 이유(2026-08-04 감리 지적): 최상위만 훑던 초판은
 *   scripts/curriculum-std/import-driver.mjs 처럼 하위 디렉터리에서 정본 DB 의
 *   curriculum_* · learning_map_edges 를 INSERT/UPDATE/DELETE 하는 스크립트를
 *   **영구히 못 잡았다**. 사각지대가 있으면 계측 강제 장치 자체가 무의미해진다.
 *
 * @returns {{file:string, reason:string, instrumented:boolean}[]} file 은 scripts/ 기준 상대경로
 */
function listMutationScripts(scriptsDir = __dirname) {
  const out = [];

  const walk = (absDir, relDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(path.join(absDir, ent.name), rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!/\.(js|mjs)$/.test(ent.name)) continue;
      if (SELF.includes(rel)) continue;

      let src;
      try { src = fs.readFileSync(path.join(absDir, ent.name), 'utf8'); } catch (_) { continue; }
      let reason = null;
      if (ALWAYS_INSTRUMENT.includes(rel)) reason = '명시 지정(동적 SQL·위임 쓰기)';
      else if (WRITE_SQL_RE.test(src)) reason = '쓰기 SQL 포함';
      if (!reason) continue;
      out.push({ file: rel, reason, instrumented: /_stamp-on-write/.test(src) });
    }
  };

  walk(scriptsDir, '');
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

module.exports = {
  CANONICAL_DB, DDL,
  ensure, read, readPath, isStale,
  recordMutation, recordMutationPath,
  recordVerified, recordVerifiedPath,
  staleMessage,
  listMutationScripts, ALWAYS_INSTRUMENT, SELF,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'show';
  const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const dbPath = path.resolve(argOf('--db', CANONICAL_DB));

  if (cmd === 'list') {
    const rows = listMutationScripts();
    const miss = rows.filter((r) => !r.instrumented);
    for (const r of rows) console.log(`${r.instrumented ? '✅' : '🔴'} ${r.file}  — ${r.reason}`);
    console.log(`\n총 ${rows.length}개 · 계측 누락 ${miss.length}개`);
    process.exit(miss.length ? 2 : 0);
  }

  if (cmd === 'mark') {
    if (!fs.existsSync(dbPath)) { console.error(`🔴 DB 없음: ${dbPath}`); process.exit(1); }
    const at = recordMutationPath(dbPath, { script: argOf('--script', 'manual'), note: argOf('--note', null) });
    console.log(`✍ 변형 표식 기록: ${at} (${dbPath})`);
    process.exit(0);
  }

  const stamp = readPath(dbPath);
  if (!stamp) { console.error(`🔴 DB 없음: ${dbPath}`); process.exit(1); }

  if (cmd === 'show') {
    console.log(JSON.stringify({ db: dbPath, stale: isStale(stamp), ...stamp }, null, 2));
    process.exit(0);
  }

  if (cmd === 'check') {
    if (isStale(stamp)) { console.error(staleMessage(stamp, dbPath)); process.exit(2); }
    console.log(`✅ 하네스 검증 최신 — 마지막 검증 ${stamp.verified_at || '(변형 이력 없음)'}`);
    process.exit(0);
  }

  console.error(`알 수 없는 명령: ${cmd}  (show | check | mark)`);
  process.exit(1);
}
