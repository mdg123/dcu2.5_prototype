// test/fresh-schema-seed.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [결함 #5] gallery_events 시드 FK 실패 (REAL·경미·신규DB 한정)
//   근본원인: gallery_events 시드 블록이 admin·더미유저 시드보다 ~700줄 먼저 실행 →
//     fresh DB 엔 host_user_id 참조 유저가 없어 FK 실패(catch·console.error).
//     → 신규/리셋 설치 시 데모 이벤트 누락(현 운영 DB 는 이미 채워져 무해).
//   수정: gallery_events 시드 블록을 admin·더미유저 시드 "뒤"로 이동(참조 무결).
//
// 검증 전략(빈 DB initSchema):
//   기존 하네스는 "실 DB 복사본"이라 유저가 이미 존재 → FK 버그가 안 드러난다.
//   따라서 이 케이스만 별도로 "빈 파일"을 DB_PATH 로 주입 → initSchema 1회 실행.
//   ★ db/index 는 require 시점 1회 DB_PATH 를 읽으므로, 다른 테스트가 이미 db/index 를
//     require 했다면 싱글톤이 공유된다. 격리를 위해 이 테스트는 자식 프로세스에서
//     깨끗한 module registry 로 실행한다(execFileSync(node, -e ...)).
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// 빈 DB 경로에서 initSchema 를 자식 프로세스로 실행하고, 결과 JSON 을 회수한다.
//   - console.error 를 가로채 FK 류 에러 로그를 수집
//   - gallery_events 시드행 수를 회수
function runFreshInit() {
  const freshDb = path.join(
    os.tmpdir(),
    `dacheum_fresh_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`
  );
  const script = `
    process.env.DB_PATH = ${JSON.stringify(freshDb)};
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(' ')); };
    let threw = null;
    try {
      require(${JSON.stringify(path.join(ROOT, 'db', 'schema'))}).initSchema();
    } catch (e) { threw = e && e.message ? e.message : String(e); }
    const db = require(${JSON.stringify(path.join(ROOT, 'db', 'index'))});
    let evCount = -1, userCount = -1;
    try { evCount = db.prepare('SELECT COUNT(*) c FROM gallery_events').get().c; } catch (e) {}
    try { userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c; } catch (e) {}
    console.error = origErr;
    // FK/시드 관련 에러 로그만 추림
    const seedErrs = errs.filter(s =>
      /gallery_events|FOREIGN KEY|SQLITE_CONSTRAINT/i.test(s)
    );
    process.stdout.write(JSON.stringify({ threw, evCount, userCount, seedErrs }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000
  });
  // 자식 프로세스 stdout 끝에 JSON 1개 — 마지막 '{' 부터 파싱
  const jsonStart = out.lastIndexOf('{');
  const parsed = JSON.parse(out.slice(jsonStart));
  try { for (const ext of ['', '-wal', '-shm', '-journal']) { fs.existsSync(freshDb + ext) && fs.unlinkSync(freshDb + ext); } } catch (_) {}
  return parsed;
}

test('FRESH-SEED: 빈 DB initSchema → FK/시드 에러 0 + gallery_events 시드행 생성', () => {
  const r = runFreshInit();

  assert.equal(r.threw, null, `initSchema 가 throw 하면 안 됨 (실제=${r.threw})`);
  assert.ok(r.userCount > 0, `유저 시드가 생성되어야 (admin/더미). 실제=${r.userCount}`);

  // 핵심: gallery_events 시드 FK 에러 로그가 없어야 한다 (RED: 시드 순서 역전 시 여기 걸림)
  assert.deepEqual(
    r.seedErrs, [],
    `gallery_events 시드 FK 에러 로그가 없어야 한다. 실제=\n${r.seedErrs.join('\n')}`
  );

  // 그리고 데모 이벤트가 실제로 5건 들어가야 한다 (RED: FK 실패 시 0건)
  assert.ok(
    r.evCount >= 5,
    `gallery_events 데모 시드가 5건 이상 생성되어야 한다(신규DB). 실제=${r.evCount}`
  );
});
