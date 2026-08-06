// test/e2e/smoke.global-teardown.js
// 스모크 종료 후 임시 DB 복사본과 storageState 를 정리한다(실 DB 무오염 유지).
//
// ── [2026-08-06] 글롭 전체 삭제 → 자기 실행분만 삭제 ─────────────────────────
//   결함(수정 전): OS temp 의 `dacheum_smoke_*.db` 와 `dacheum_smoke_uploads_*` 를
//   **패턴으로 전부** 지웠다. 사본 경로는 실행마다 분리돼 있는데 **삭제만 전역**이라,
//   두 스모크가 동시에 돌면 먼저 끝난 쪽이 **아직 돌고 있는 쪽의 DB 를 지웠다.**
//   피해자는 `SqliteError: unable to open database file` 로 실패한다 — 코드에는
//   아무 문제가 없는데 붉게 뜨므로, 원인을 못 찾고 "스모크는 원래 불안정하다"로
//   넘어가기 쉬운 형태였다. (2026-08-06 동시 실행 2건에서 실측 재현)
//
//   당시 글롭을 쓴 이유는 주석에 남아 있었다 — teardown 이 별도 프로세스면
//   `smoke.db-copy` 가 재로드되며 `Date.now()` 가 달라져 자기 경로를 지목하지
//   못한다는 것. 그래서 경로를 **env 에 고정**해 프로세스 트리가 같은 값을 보게
//   했다(`smoke.db-copy.js` 참조). 이제 자기 것만 정확히 지울 수 있다.
//
//   고아 잔여물(teardown 세그폴트 등으로 남은 것)은 여전히 청소하되, 기준을
//   "패턴 일치"가 아니라 **"2시간 이상 오래됨"** 으로 바꿔 live 실행을 비껴간다.
const fs = require('fs');
const path = require('path');
const { cleanupSmokeDb, sweepStaleSmokeTemp } = require('./smoke.db-copy');

module.exports = async () => {
  // 1) 이번 실행의 임시 DB·업로드 디렉터리만 정리
  try { cleanupSmokeDb(); } catch (_) {}

  // 2) 오래된 고아 잔여물만 정리 (돌고 있는 남의 실행은 건드리지 않는다)
  try { sweepStaleSmokeTemp(); } catch (_) {}

  // 3) storageState(.smoke-state) 정리 — 쿠키 잔존 방지
  const stateDir = path.join(__dirname, '.smoke-state');
  try {
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  } catch (_) {}
};
