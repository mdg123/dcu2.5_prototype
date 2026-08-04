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
const _tempDirs = [];    // 업로드 산출물 격리 디렉터리 (exit 시 통째로 삭제)
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
    // 4) 업로드 산출물 임시 디렉터리 삭제 (남아도 OS 가 정리 — best effort)
    for (const d of _tempDirs) {
      try { fs.existsSync(d) && fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
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
  // TEST_SRC_DB: 복사 원본 오버라이드(기본 = 실 DB).
  //   "시간 부패 카나리아"(scripts/age-db-canary.js)가 만든 **N일 앞당긴 DB**를 주입해
  //   `npm test` 를 그대로 돌리면, 롤링 창(period=30d 등)이 N일 뒤 상태로 동작한다.
  //   JS Date 와 SQLite 'now' 를 둘 다 실시간으로 두므로 desync 위산(false positive) 없음.
  //   미설정 시 동작 완전 불변 — 평시 npm test 에 영향 0.
  const SRC = process.env.TEST_SRC_DB || REAL_DB;
  if (!fs.existsSync(SRC)) {
    throw new Error(`원본 DB 가 없습니다: ${SRC}`);
  }
  const tmp = path.join(
    os.tmpdir(),
    `dacheum_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`
  );
  _copyDbSync(SRC, tmp);
  process.env.DB_PATH = tmp;
  _tempFiles.push(tmp);

  // ★ [W4] 업로드 산출물도 격리한다.
  //   DB 만 사본으로 돌리고 PDF 는 정본 uploads/portfolio-reports 에 쓰고 있었다 →
  //   테스트를 돌릴 때마다 3 개씩 쌓여 1000+ 개의 "정본 DB 미참조 고아 PDF" 가 남았다.
  //   db/growth-extended.js reportsDirFor() 가 호출 시점에 이 env 를 읽는다(미설정 시 평시 경로).
  //   ※ 여러 테스트 파일이 각각 setupTestDb() 를 호출하지만 프로세스가 다르므로 충돌 없음.
  if (!process.env.PORTFOLIO_REPORT_DIR) {
    const upl = path.join(os.tmpdir(), `dacheum_test_uploads_${process.pid}_${Date.now()}`);
    fs.mkdirSync(upl, { recursive: true });
    process.env.PORTFOLIO_REPORT_DIR = upl;
    _tempDirs.push(upl);
  }

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

/**
 * GT(실측 회귀) 단언이 쓸 **시계 독립 창(from/to)** 을 데이터에서 유도한다.
 *
 * ── 왜 필요한가: 2026-07-30 사고(롤링 창 시한폭탄) ───────────────────────────
 * `period=30d` 는 wall clock 기준(오늘-30일 ~ 오늘)으로 매일 움직인다. 그 위에
 * "실측 GT"(하드코딩 숫자·존재성 단언)를 얹으면, **코드가 한 줄도 안 바뀌어도**
 * 근거 데이터가 창 밖으로 노화되는 순간 테스트가 깨진다.
 * 실제 사례 — test/lrs-keris-p2.test.js INV-K13③:
 *   · uid3(student1) 의 exam_complete 로그는 2026-06-22(29건)·2026-07-04(2건) 뿐.
 *   · 응시자 ≥5(가드 통과) 평가는 전부 06-22 자. 07-04 자 2건은 응시자 1명(차단).
 *   · 2026-07-16(마지막 green push) 창 = 06-16~07-16 → 통과 26·차단 5 → PASS.
 *   · 2026-07-30 창 = 06-30~07-30 → 통과 0·차단 2 → "가드 통과 케이스 존재" 붕괴.
 * 즉 07-22 경부터 자동 폭발하도록 예약돼 있던 시한폭탄이었다.
 *
 * ── 해법: 창을 시계가 아니라 데이터에서 유도 ────────────────────────────────
 * 대상 계정·활동유형 로그의 전 구간[MIN(DATE) - pad, MAX(DATE) + pad]을 돌려준다.
 * 그 계정·유형의 모든 행을 항상 포함하므로 **오늘이 언제든 같은 행 집합**을 본다.
 * 시드가 나중에 행을 더 넣어도 창이 함께 넓어져 전수를 유지한다(결정성 보존).
 *
 * 규칙: 롤링 `period=NNd` 위에 고정 GT 를 얹지 말 것. GT 단언은 이 헬퍼를 쓸 것.
 *
 * @param {import('better-sqlite3').Database} db  openTestDb() 핸들
 * @param {{userId:number, activityType:string, pad?:number}} opts
 * @returns {{from:string, to:string, rows:number}} YYYY-MM-DD 창 + 포함 행수
 */
function fixtureWindow(db, { userId, activityType, pad = 1 } = {}) {
  // userId·activityType 은 선택. 둘 다 생략하면 learning_logs 전체 구간을 덮는다
  //   (클래스 스코프·지역 집계처럼 특정 계정에 매이지 않는 GT 용).
  //   ★ 런타임 시드를 쓰는 테스트는 **시드 INSERT 이후**에 호출할 것 —
  //     그래야 창이 "실 DB 고정분 + now 기준 시드"를 모두 덮는다.
  const cond = [], args = [];
  if (userId != null) { cond.push('user_id = ?'); args.push(userId); }
  if (activityType != null) { cond.push('activity_type = ?'); args.push(activityType); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const r = db.prepare(`
    SELECT MIN(DATE(created_at)) lo, MAX(DATE(created_at)) hi, COUNT(*) n
    FROM learning_logs ${where}
  `).get(...args);
  if (!r || !r.lo || !r.hi) {
    throw new Error(
      `fixtureWindow: ${userId != null ? `GT 고정계정 uid${userId} 의 ` : ''}` +
      `${activityType || 'learning_logs'} 로그가 0건입니다. ` +
      `실 DB 픽스처가 사라졌거나 계정 id 가 바뀌었습니다(테스트 전제 붕괴).`
    );
  }
  const shift = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return { from: shift(r.lo, -pad), to: shift(r.hi, pad), rows: r.n };
}

module.exports = { setupTestDb, openTestDb, fixtureWindow, REAL_DB };
