// test/smoke-temp-isolation.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 스모크 하네스의 임시파일 격리 계약.
//
// 왜 박제하는가 (2026-08-06):
//   `smoke.global-teardown.js` 가 OS temp 의 `dacheum_smoke_*` 를 **글롭으로 전부**
//   삭제하고 있었다. 사본 경로는 실행마다 분리돼 있는데 삭제만 전역이라, 스모크
//   두 개가 동시에 돌면 먼저 끝난 쪽이 **아직 돌고 있는 쪽의 DB 를 지웠다.**
//   피해자는 `SqliteError: unable to open database file` 로 실패한다 — 코드는
//   멀쩡한데 붉게 뜨므로 "스모크는 원래 불안정하다"로 넘어가기 쉬웠고, 실제로
//   이 세션에서 여러 번 그렇게 넘어갔다.
//
//   이 결함은 **거짓 실패만 만들고 거짓 통과는 못 만든다.** 그래서 초록 결과는
//   유효했지만, 붉은 결과의 원인을 매번 사람이 판별해야 했다.
//
// 불변식:
//   INV-SMK1  임시 경로는 프로세스 트리 전체에서 동일하다(env 고정)
//   INV-SMK2  청소는 "돌고 있는 남의 실행"을 절대 지우지 않는다  ← 결함의 핵심
//   INV-SMK3  고아 잔여물(오래된 것)은 여전히 지운다 — 청소를 포기한 게 아니다
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepStaleSmokeTemp } = require('../test/e2e/smoke.db-copy');

// 실제 OS temp 를 건드리지 않도록 전용 샌드박스에서 검증한다.
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smk_iso_'));
  return dir;
}

function touch(dir, name, ageMs) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'x');
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(full, t, t);
  }
  return full;
}

test('INV-SMK1: 임시 경로는 프로세스 트리 전체에서 동일하다(env 고정)', () => {
  // 모듈이 다시 로드돼도 같은 값이어야 한다. env 에 심어 뒀으므로
  // require 캐시를 지우고 재로드해도 경로가 바뀌면 안 된다.
  const before = require('../test/e2e/smoke.db-copy').SMOKE_DB_PATH;
  delete require.cache[require.resolve('../test/e2e/smoke.db-copy')];
  const after = require('../test/e2e/smoke.db-copy').SMOKE_DB_PATH;

  assert.strictEqual(after, before,
    '재로드마다 경로가 달라지면 teardown 이 자기 실행분을 지목하지 못해 ' +
    '"전부 삭제"로 되돌아가게 된다(그게 원래 결함의 원인이었다).');
  assert.ok(process.env.SMOKE_DB_PATH_RESOLVED,
    'env 앵커가 없으면 자식 프로세스가 다른 경로를 본다.');
});

test('INV-SMK2: 청소가 돌고 있는 남의 스모크를 지우지 않는다', () => {
  const box = makeSandbox();
  try {
    // 다른 세션이 방금 만든 것들 — 살아남아야 한다
    const liveDb = touch(box, 'dacheum_smoke_99999_1700000000000.db', 0);
    const liveWal = touch(box, 'dacheum_smoke_99999_1700000000000.db-wal', 0);
    fs.mkdirSync(path.join(box, 'dacheum_smoke_uploads_99999_1700000000000'));
    const liveUploads = path.join(box, 'dacheum_smoke_uploads_99999_1700000000000');

    const removed = sweepStaleSmokeTemp(2 * 60 * 60 * 1000, box);

    assert.ok(fs.existsSync(liveDb),
      '돌고 있는 남의 스모크 DB 가 지워졌다 — 무고한 실패를 만든다(원래 결함).');
    assert.ok(fs.existsSync(liveWal), 'WAL 도 함께 지워지면 안 된다.');
    assert.ok(fs.existsSync(liveUploads), '업로드 격리 디렉터리도 지워지면 안 된다.');
    assert.strictEqual(removed.length, 0, `최근 파일은 삭제 대상이 아니다: ${removed.join(', ')}`);
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
});

test('INV-SMK3: 고아 잔여물(오래된 것)은 여전히 지운다', () => {
  const box = makeSandbox();
  try {
    const THREE_HOURS = 3 * 60 * 60 * 1000;
    const staleDb = touch(box, 'dacheum_smoke_11111_1600000000000.db', THREE_HOURS);
    const fresh = touch(box, 'dacheum_smoke_22222_1700000000000.db', 0);
    const unrelated = touch(box, 'something_else.db', THREE_HOURS);

    const removed = sweepStaleSmokeTemp(2 * 60 * 60 * 1000, box);

    assert.ok(!fs.existsSync(staleDb),
      '오래된 고아는 지워야 한다 — 청소를 포기하면 temp 가 무한히 쌓인다.');
    assert.ok(fs.existsSync(fresh), '최근 파일은 남아야 한다.');
    assert.ok(fs.existsSync(unrelated), '스모크와 무관한 파일은 건드리면 안 된다.');
    assert.deepStrictEqual(removed, [staleDb]);
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
});

test('INV-SMK4: makeSmokeDb 는 멱등 — 재호출이 사본을 새로 만들지 않는다', () => {
  // Playwright 는 config 를 메인·globalSetup·각 워커에서 여러 번 로드하고,
  // 그때마다 makeSmokeDb() 가 호출된다. 예전에는 로드마다 경로가 달라져
  // **DB 사본이 하나씩 새로 생겼고**, 그 쓰레기를 치우려고 teardown 이
  // 글롭 삭제를 하게 됐다(= INV-SMK2 결함의 뿌리).
  const { makeSmokeDb, SMOKE_DB_PATH } = require('../test/e2e/smoke.db-copy');

  const first = makeSmokeDb();
  assert.ok(fs.existsSync(first), '1회차에 사본이 만들어져야 한다.');
  const stat1 = fs.statSync(first);

  const second = makeSmokeDb();   // 재호출 — 던지지 않아야 한다
  assert.strictEqual(second, first, '재호출이 다른 경로를 만들면 사본이 늘어난다.');

  const stat2 = fs.statSync(second);
  assert.strictEqual(stat2.mtimeMs, stat1.mtimeMs,
    '재호출이 DB 를 다시 복사했다. 스냅샷 시점이 흔들리고 사본이 쌓인다.');

  // 이번 실행분은 남겨두면 다른 검증을 오염시키므로 정리
  require('../test/e2e/smoke.db-copy').cleanupSmokeDb();
});

test('INV-SMK2b: teardown 이 글롭 전체 삭제로 되돌아가지 않았다 (소스 락)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, 'e2e', 'smoke.global-teardown.js'), 'utf8');

  // 결함의 형태: readdir 로 훑으며 패턴만 보고 unlink/rm 하는 코드
  const hasRawGlobDelete =
    /readdirSync/.test(src) && /(unlinkSync|rmSync)/.test(src);

  assert.ok(!hasRawGlobDelete,
    'teardown 이 다시 "temp 를 훑어 패턴 일치하면 삭제"로 돌아갔다. ' +
    '동시에 돌던 남의 스모크 DB 를 지워 무고한 실패를 만든다. ' +
    '삭제는 cleanupSmokeDb()(자기 실행분) + sweepStaleSmokeTemp()(나이 기준)만 쓸 것.');
  assert.ok(/cleanupSmokeDb/.test(src) && /sweepStaleSmokeTemp/.test(src),
    'teardown 은 자기 실행분 삭제와 나이 기준 청소를 모두 거쳐야 한다.');
});
