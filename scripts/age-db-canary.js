#!/usr/bin/env node
/**
 * 시간 부패 카나리아 (age-db-canary)
 * ────────────────────────────────────────────────────────────────────────────
 * 실 DB 를 복사한 뒤 **모든 타임스탬프를 N일 앞당겨** 저장한다.
 * 그 DB 로 `npm test` 를 돌리면 "N일 뒤"의 하네스 상태를 재현한다.
 *
 * ── 왜 데이터를 옮기고 시계는 두는가 ────────────────────────────────────────
 * 시계(JS Date)만 미는 방식은 SQLite 의 `DATE('now')`(앱 코드 94곳)와 어긋나
 * 진짜 폭탄이 아닌 desync 오탐을 만든다. 데이터를 앞당기면 JS·SQLite 가 모두
 * 실시간을 보므로 desync 가 없고, **상대 기간창(period=30d 등)만** N일 뒤처럼
 * 동작한다. 테스트가 런타임에 `now` 기준으로 심는 시드는 그대로 창 안에 남으므로
 * (자기 갱신형 = 안전), 창 밖으로 밀려나는 것은 **실 DB 의 고정 GT 데이터뿐**이다.
 * → 실패한 테스트 = "고정 GT × 롤링 창" 시한폭탄. 정확한 판별기.
 *
 * ── 배경(2026-07-30 사고) ──────────────────────────────────────────────────
 * INV-K13③ 이 `period=30d` 위에 고정 실측 GT 를 얹은 탓에, 근거 데이터
 * (uid3 exam_complete = 2026-06-22)가 창 밖으로 노화되며 코드 변경 0 인데도
 * 깨졌다. learning_logs 는 2026-07-16 에서 멈춰 있는데 창만 매일 전진한다.
 *
 * 사용법:
 *   node scripts/age-db-canary.js --days 45 --out data/_canary45.db
 *   TEST_SRC_DB=data/_canary45.db npm test     # 실패 = 45일 내 터질 폭탄
 *
 * 실 DB 는 읽기 전용으로만 연다(원본 무변경).
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DAYS = parseInt(argOf('--days', '45'), 10);
const REAL = path.join(__dirname, '..', 'data', 'dacheum.db');
const OUT = path.resolve(argOf('--out', path.join(__dirname, '..', 'data', `_canary${DAYS}.db`)));

if (!Number.isFinite(DAYS) || DAYS <= 0) { console.error('--days 는 양의 정수'); process.exit(1); }
if (!fs.existsSync(REAL)) { console.error(`실 DB 없음: ${REAL}`); process.exit(1); }

// 1) 실 DB → OUT 스냅샷 (VACUUM INTO: WAL 안전·원본 무변경)
for (const ext of ['', '-wal', '-shm']) { try { fs.existsSync(OUT + ext) && fs.unlinkSync(OUT + ext); } catch (_) {} }
{
  const src = new Database(REAL, { readonly: true });
  src.exec(`VACUUM INTO '${OUT.replace(/'/g, "''")}'`);
  src.close();
}

// 2) 모든 타임스탬프 컬럼을 DAYS 일 앞당김
const db = new Database(OUT);
db.pragma('journal_mode = WAL');
const TS = /(^|_)(created_at|updated_at|deleted_at|submitted_at|graded_at|completed_at|started_at|ended_at|opened_at|closed_at|published_at|last_seen|last_synced|timestamp|due_date|start_date|end_date|target_date|attendance_date|date)$/i;

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(r => r.name);

let touched = 0, cols = 0;
db.exec('BEGIN');
for (const t of tables) {
  let info;
  try { info = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch (_) { continue; }
  const tsCols = info.filter(c => TS.test(c.name)).map(c => c.name);
  if (!tsCols.length) continue;
  for (const c of tsCols) {
    // 날짜형 문자열만 이동(숫자 epoch·NULL·비날짜 문자열은 건드리지 않음)
    let r;
    try {
      r = db.prepare(
        `UPDATE "${t}" SET "${c}" = datetime("${c}", '-${DAYS} days')
           WHERE "${c}" IS NOT NULL
             AND typeof("${c}") = 'text'
             AND datetime("${c}") IS NOT NULL`
      ).run();
    } catch (e) { continue; }
    if (r.changes > 0) { touched += r.changes; cols++; }
  }
}
db.exec('COMMIT');

const maxLog = (() => {
  try { return db.prepare('SELECT MAX(DATE(created_at)) m FROM learning_logs').get().m; } catch (_) { return '?'; }
})();
db.close();

console.log(`✔ 카나리아 생성: ${OUT}`);
console.log(`  ${DAYS}일 앞당김 · 컬럼 ${cols}개 · 행 ${touched.toLocaleString()}건 이동`);
console.log(`  learning_logs 최신일: ${maxLog}  (오늘 ${new Date().toISOString().slice(0, 10)})`);
if (DAYS % 7 !== 0) {
  console.log(`  ⚠ ${DAYS}일은 7의 배수가 아니라 **요일이 ${DAYS % 7}칸 회전**합니다.`);
  console.log(`    요일 버킷 단언(히트맵 dow 등)에서 가짜 실패가 납니다 — 7의 배수(예: 91)를 권장.`);
}

if (argv.includes('--run')) {
  const { spawnSync } = require('child_process');
  console.log(`\n▶ 카나리아 DB 로 전체 하네스 실행 — 실패 = ${DAYS}일 내 터질 시한폭탄\n`);
  const r = spawnSync(process.execPath,
    ['--test', '--test-concurrency=1', '--test-timeout=180000', 'test/*.test.js'],
    { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, TEST_SRC_DB: OUT } });
  console.log(`\n※ 실패가 있다면 먼저 "절대 창(from/to 리터럴)을 쓰는 테스트인지" 확인하세요.`);
  console.log(`   절대 창 테스트는 카나리아가 데이터를 옮겨서 깨지는 **오탐**입니다(실제로는 시간에 강건).`);
  console.log(`   롤링 창(period=NNd·days=NN) + 존재성/고정 GT 조합만 진성 폭탄입니다.`);
  process.exit(r.status == null ? 1 : r.status);
}
console.log(`\n  실행:  TEST_SRC_DB="${OUT}" npm test      (또는 --run 플래그)`);
console.log(`  실패한 테스트 = ${DAYS}일 내 터질 "고정 GT × 롤링 창" 시한폭탄`);
