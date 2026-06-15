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

// config 로드 시점에 1회 결정되는 임시 DB 경로. (모듈 캐시로 동일 값 보장)
const SMOKE_DB_PATH = path.join(
  os.tmpdir(),
  `dacheum_smoke_${process.pid}_${Date.now()}.db`
);

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

function makeSmokeDb() {
  if (!fs.existsSync(REAL_DB)) {
    throw new Error(`실 DB 가 없습니다: ${REAL_DB}`);
  }
  copyDbSync(REAL_DB, SMOKE_DB_PATH);
  return SMOKE_DB_PATH;
}

function cleanupSmokeDb() {
  for (const f of _temp) {
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      try { fs.existsSync(f + ext) && fs.unlinkSync(f + ext); } catch (_) {}
    }
  }
}

module.exports = { SMOKE_DB_PATH, REAL_DB, makeSmokeDb, cleanupSmokeDb };
