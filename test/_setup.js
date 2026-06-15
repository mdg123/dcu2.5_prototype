// test/_setup.js
// ─────────────────────────────────────────────────────────────────────────────
// DB 격리 헬퍼 (필수). 실 DB(data/dacheum.db)를 절대 직접 쓰지 않는다.
//
//   1) 실 DB → 임시 파일로 "WAL 안전 복사" (better-sqlite3 backup API).
//      단순 fs.copyFileSync 는 WAL 미체크포인트 데이터 누락 위험 → backup() 권장.
//   2) process.env.DB_PATH = 임시경로  로 주입.
//      ★ db/index.js 는 require 시점 1회 process.env.DB_PATH 를 읽는다.
//        그러므로 반드시 db 모듈을 require 하기 "전에" 이 헬퍼를 호출해야 한다.
//   3) 임시 파일은 복사본 → INSERT/수정 자유. 테스트가 끝나면 폐기(실 DB 무오염).
//
// 사용법(각 *.test.js 맨 위):
//   const { setupTestDb } = require('./_setup');
//   setupTestDb();                       // ← db 모듈 require "전에" 호출 (DB_PATH 주입)
//   const g = require('../db/growth-extended');
//
// backup() 은 비동기(Promise)지만, node:test 가 require 시점에 동기 경로를 요구하므로
// 여기서는 동기 대체로 VACUUM INTO 를 1차 사용하고, 실패 시 backup() 동기 대기(Atomics)로 폴백한다.
// (둘 다 WAL 안전. VACUUM INTO 는 깨끗한 단일 파일을 만들어 핸들 잠금/삭제 문제도 줄인다.)
// ─────────────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REAL_DB = path.join(__dirname, '..', 'data', 'dacheum.db');

// 정리 대상 임시 파일 목록 + 열린 핸들 (테스트 종료 시 close 후 best-effort 삭제)
const _tempFiles = [];
const _openHandles = []; // openTestDb()가 연 핸들 (exit 시 close 해야 Windows 잠금 해제)
let _installedExitHook = false;

function _installExitCleanup() {
  if (_installedExitHook) return;
  _installedExitHook = true;
  process.on('exit', () => {
    // 1) 우리가 연 핸들 close
    for (const h of _openHandles) { try { h.open && h.close(); } catch (_) {} }
    // 2) db/index.js 싱글톤도 close (require 됐다면) — Windows 파일 잠금 해제용
    try {
      const dbMod = require.cache[require.resolve('../db/index')];
      if (dbMod && dbMod.exports && typeof dbMod.exports.close === 'function' && dbMod.exports.open) {
        dbMod.exports.close();
      }
    } catch (_) {}
    // 3) 임시 파일 삭제 (WAL/SHM/저널 포함). 여전히 잠겨 있으면 무시(OS가 후속 정리).
    for (const f of _tempFiles) {
      for (const ext of ['', '-wal', '-shm', '-journal']) {
        try { fs.existsSync(f + ext) && fs.unlinkSync(f + ext); } catch (_) { /* EBUSY 무시 */ }
      }
    }
  });
}

// WAL 안전 복사. 우선 VACUUM INTO(동기·단일파일), 실패 시 backup()을 동기 대기.
function _copyDbSync(srcPath, destPath) {
  // 1차: VACUUM INTO — 소스 DB의 일관된 스냅샷을 destPath 단일 파일로 생성(WAL 포함 반영).
  let src;
  try {
    src = new Database(srcPath, { readonly: true });
    // VACUUM INTO 는 destPath 가 이미 존재하면 실패하므로 사전 삭제.
    try { fs.existsSync(destPath) && fs.unlinkSync(destPath); } catch (_) {}
    src.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    src.close();
    return;
  } catch (eVacuum) {
    try { src && src.close(); } catch (_) {}
    // 2차 폴백: backup() Promise 를 동기 대기 (Atomics.wait 로 마이크로 스핀).
    try {
      const ro = new Database(srcPath, { readonly: true });
      let done = false, err = null;
      ro.backup(destPath).then(() => { done = true; }).catch((e) => { err = e; done = true; });
      const sab = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 30000;
      while (!done) {
        Atomics.wait(sab, 0, 0, 10); // 10ms 단위 대기 (이벤트 루프 양보 없이 동기 스핀 방지용 짧은 슬립)
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

/**
 * 실 DB 를 임시 복사본으로 만들고 process.env.DB_PATH 에 주입한다.
 * @returns {string} 임시 DB 경로
 */
function setupTestDb() {
  if (!fs.existsSync(REAL_DB)) {
    throw new Error(`실 DB 가 없습니다: ${REAL_DB}`);
  }
  const tmp = path.join(
    os.tmpdir(),
    `dacheum_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`
  );
  _copyDbSync(REAL_DB, tmp);
  process.env.DB_PATH = tmp;
  _tempFiles.push(tmp);
  _installExitCleanup();
  return tmp;
}

/**
 * 격리된 DB 핸들을 직접 연다 (테스트에서 시드 INSERT 용).
 * setupTestDb() 가 주입한 DB_PATH(복사본)를 사용 → 실 DB 무오염.
 */
function openTestDb() {
  const p = process.env.DB_PATH;
  if (!p) throw new Error('setupTestDb() 를 먼저 호출하세요.');
  const d = new Database(path.resolve(p));
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  _openHandles.push(d); // exit 시 close 대상 등록 (테스트가 close 해도 무해 — 이중 close 가드됨)
  return d;
}

module.exports = { setupTestDb, openTestDb, REAL_DB };
