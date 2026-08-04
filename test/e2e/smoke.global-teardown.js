// test/e2e/smoke.global-teardown.js
// 스모크 종료 후 임시 DB 복사본과 storageState 를 정리한다(실 DB 무오염 유지).
//   ★ globalSetup/teardown 은 webServer 와 별도 프로세스이고, SMOKE_DB_PATH 는
//      프로세스마다 새로 생성되므로 단일 경로 삭제로는 부족하다.
//      여기서는 OS temp 의 dacheum_smoke_*.db 패턴을 일괄 정리한다(best-effort).
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = async () => {
  // 1) OS temp 의 스모크 임시 DB 전부 정리
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (/^dacheum_smoke_.*\.db(-wal|-shm|-journal)?$/.test(name)) {
        try { fs.unlinkSync(path.join(tmp, name)); } catch (_) {}
      }
    }
  } catch (_) {}

  // 1-b) [W4] 스모크 업로드 격리 디렉터리 정리 (dacheum_smoke_uploads_*)
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (/^dacheum_smoke_uploads_/.test(name)) {
        try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (_) {}

  // 2) storageState(.smoke-state) 정리 — 쿠키 잔존 방지
  const stateDir = path.join(__dirname, '.smoke-state');
  try {
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  } catch (_) {}
};
