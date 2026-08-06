// test/e2e/smoke.db-copy.js
// ─────────────────────────────────────────────────────────────────────────────
// 스모크 테스트용 DB 격리 헬퍼.
//   실 DB(data/dacheum.db)를 절대 직접 쓰지 않는다.
//   VACUUM INTO 로 WAL 안전 스냅샷을 임시 파일로 만들고, 그 경로를 server.js 의
//   DB_PATH(env)로 주입한다(playwright.config 의 webServer.env). 로그인 시 발생하는
//   last_login_at write 등 모든 write 는 임시 복사본에만 반영 → 실 DB 무오염.
//
//   임시 경로는 config 로드 시점에 1회 결정되고(SMOKE_DB_PATH),
//   globalSetup 에서 실제 복사가 수행된다. webServer 는 동일 경로를 env 로 받는다.
// ─────────────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REAL_DB = path.join(__dirname, '..', '..', 'data', 'dacheum.db');

// ── [2026-08-06] 실행 경로를 **환경변수에 고정**한다 ──────────────────────────
//   결함: 경로를 `${pid}_${Date.now()}` 로만 만들면, 이 모듈이 다른 프로세스에서
//   다시 로드될 때(예: globalTeardown 이 별도 프로세스인 경우) **다른 값**이 나온다.
//   그래서 teardown 이 자기 실행분을 지목하지 못했고, 대신 `dacheum_smoke_*` 를
//   **글롭으로 전부 삭제**하는 방식을 쓰고 있었다. 그 결과 동시에 돌던 **남의
//   스모크 DB 까지 지워** `SqliteError: unable to open database file` 로 무고한
//   실패가 났다(2026-08-06 실측: 동시 실행 2건에서 재현).
//
//   자식 프로세스는 부모의 env 를 상속하므로, 최초 1회 계산한 값을 env 에 심어 두면
//   프로세스 트리 전체가 **같은 경로**를 본다 → 자기 것만 정확히 지울 수 있다.
const SMOKE_DB_PATH = process.env.SMOKE_DB_PATH_RESOLVED || path.join(
  os.tmpdir(),
  `dacheum_smoke_${process.pid}_${Date.now()}.db`
);
process.env.SMOKE_DB_PATH_RESOLVED = SMOKE_DB_PATH;

// [W4] 업로드 산출물 격리 경로. 스모크 서버는 정본 uploads/ 에 쓰면 안 된다
//   (DB 만 사본이고 PDF 는 정본 디스크에 쌓이던 부류의 재발 방지 — webServer.env 로 주입).
const SMOKE_UPLOAD_DIR = process.env.SMOKE_UPLOAD_DIR_RESOLVED || path.join(
  os.tmpdir(),
  `dacheum_smoke_uploads_${process.pid}_${Date.now()}`
);
process.env.SMOKE_UPLOAD_DIR_RESOLVED = SMOKE_UPLOAD_DIR;

const _temp = [SMOKE_DB_PATH];

// WAL 안전 복사: VACUUM INTO(동기·단일 파일). 실패 시 backup() 동기 대기 폴백.
function copyDbSync(srcPath, destPath) {
  let src;
  try {
    src = new Database(srcPath, { readonly: true });
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      try { fs.existsSync(destPath + ext) && fs.unlinkSync(destPath + ext); } catch (_) {}
    }
    src.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    src.close();
    return;
  } catch (eVacuum) {
    try { src && src.close(); } catch (_) {}
    try {
      const ro = new Database(srcPath, { readonly: true });
      let done = false, err = null;
      ro.backup(destPath).then(() => { done = true; }).catch((e) => { err = e; done = true; });
      const sab = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 30000;
      while (!done) {
        Atomics.wait(sab, 0, 0, 10);
        if (Date.now() > deadline) { err = new Error('backup() timeout'); break; }
      }
      try { ro.close(); } catch (_) {}
      if (err) throw err;
      return;
    } catch (eBackup) {
      throw new Error(`DB 복사 실패: VACUUM(${eVacuum.message}) / backup(${eBackup.message})`);
    }
  }
}

// ── 멱등 ─────────────────────────────────────────────────────────────────────
//   이 함수는 `smoke.config.js` 로드 시점에 호출되는데, Playwright 는 config 를
//   메인 프로세스·globalSetup·각 워커에서 **여러 번 로드**한다.
//   경로가 로드마다 달랐던 예전에는 그때마다 **DB 사본이 하나씩 새로 생겼고**,
//   teardown 이 글롭으로 싹 지워야 했던 진짜 이유가 이것이었다(그 글롭이 다시
//   남의 실행을 죽였다). 경로를 env 로 고정한 지금은 한 실행 = 사본 1개다.
//   따라서 이미 만들어져 있으면 **다시 복사하지 않는다**(스냅샷 시점도 1회로 고정).
function makeSmokeDb() {
  if (!fs.existsSync(REAL_DB)) {
    throw new Error(`실 DB 가 없습니다: ${REAL_DB}`);
  }
  try { fs.mkdirSync(SMOKE_UPLOAD_DIR, { recursive: true }); } catch (_) {}

  // 경로에 pid+타임스탬프가 박혀 있어 **이전 실행의 잔재일 수 없다.**
  // 존재한다 = 이번 실행의 다른 로더가 이미 만들었다 → 재복사 금지.
  if (fs.existsSync(SMOKE_DB_PATH) && fs.statSync(SMOKE_DB_PATH).size > 0) {
    return SMOKE_DB_PATH;
  }

  try {
    copyDbSync(REAL_DB, SMOKE_DB_PATH);
  } catch (e) {
    // 동시 로드 경합: 다른 로더가 방금 만들었다면 그 결과를 쓴다.
    if (fs.existsSync(SMOKE_DB_PATH) && fs.statSync(SMOKE_DB_PATH).size > 0) {
      return SMOKE_DB_PATH;
    }
    throw e;
  }
  return SMOKE_DB_PATH;
}

function cleanupSmokeDb() {
  for (const f of _temp) {
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      try { fs.existsSync(f + ext) && fs.unlinkSync(f + ext); } catch (_) {}
    }
  }
  try { fs.existsSync(SMOKE_UPLOAD_DIR) && fs.rmSync(SMOKE_UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ── 고아 잔여물 청소 — **live 실행은 절대 건드리지 않는다** ───────────────────
//   글롭 전체 삭제를 대체한다. 프로세스가 강제 종료(teardown 세그폴트 등)되면
//   임시 파일이 남으므로 청소는 여전히 필요하지만, 판단 기준을 "패턴 일치"가 아니라
//   **"충분히 오래됐다"** 로 바꾼다. 지금 돌고 있는 스모크의 파일은 방금 쓰였으므로
//   maxAgeMs 를 넘지 않아 살아남는다.
//   @returns {string[]} 실제로 지운 경로들 (테스트에서 단언 가능하도록)
function sweepStaleSmokeTemp(maxAgeMs = 2 * 60 * 60 * 1000, tmpDir = os.tmpdir()) {
  const removed = [];
  const cutoff = Date.now() - maxAgeMs;
  let names;
  try { names = fs.readdirSync(tmpDir); } catch (_) { return removed; }
  for (const name of names) {
    const isDb = /^dacheum_smoke_.*\.db(-wal|-shm|-journal)?$/.test(name);
    const isUploads = /^dacheum_smoke_uploads_/.test(name);
    if (!isDb && !isUploads) continue;
    const full = path.join(tmpDir, name);
    // 이번 실행의 산출물은 나이와 무관하게 제외 (cleanupSmokeDb 가 따로 지운다)
    if (full === SMOKE_DB_PATH || full.startsWith(SMOKE_DB_PATH) || full === SMOKE_UPLOAD_DIR) continue;
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;  // 최근 = 남의 live 실행일 수 있다
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch (_) {}
  }
  return removed;
}

module.exports = { SMOKE_DB_PATH, SMOKE_UPLOAD_DIR, REAL_DB, makeSmokeDb, cleanupSmokeDb, sweepStaleSmokeTemp };
