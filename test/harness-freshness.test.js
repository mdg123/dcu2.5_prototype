// test/harness-freshness.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [회귀 박제] 2026-07-31 "재집계 후 미검증 배포" 사고
//
// ── 무슨 일이 있었나 ────────────────────────────────────────────────────────
//   15:46  감리가 npm test 576 pass / 0 fail 측정
//   16:14  commit 2b9b0ef
//   (push) pre-push 훅이 npm test 를 돌려 ✅ 통과 — **이 시점의 데이터 기준으로는 맞다**
//   16:18  scripts/rebuild-lrs-aggregates-w2a.js --apply  ← 하네스의 근거 데이터가 바뀜
//   16:20  GCP 배포 + 사용자에게 "완료" 보고
//   08-04  사용자 앞에서 npm test 6건 실패로 드러남 (나흘 방치)
//
// ── 왜 기존 게이트가 못 잡았나 (핵심) ───────────────────────────────────────
//   하네스의 근거 데이터는 data/dacheum.db 인데 이 파일은 .gitignore 대상이다.
//   즉 **재집계는 git 변경을 한 글자도 만들지 않는다.** commit·push 게이트는
//   git diff 를 보는 장치이므로 원리적으로 감지 불가능했다. 게다가 재집계가
//   push "이후" 였으므로 pre-push 는 아예 다시 돌 기회조차 없었다.
//   → 사람이 "재집계했으니 하네스 다시 돌려야지" 를 기억하는 것 말고 아무 장치가 없었다.
//
// ── 이 파일이 박제하는 것 ───────────────────────────────────────────────────
//   INV-HF1  격리 사본의 스탬프가 미검증이면, 지금 런이 그 변형을 소화 중인
//            **전건 런**이어야 한다. 아니면 실패. (= 재집계 후 개별 테스트만
//            돌려놓고 "통과했다" 고 말할 수 없게 만든다)
//   REG-HF2  스탬프 상태기계 — 07-31 순서를 그대로 재연해 각 지점의 stale 판정 검사
//   REG-HF3  게이트 CLI 가 미검증에서 exit 2 + 한국어 경고, 검증됨에서 exit 0
//   REG-HF4  계측 전수 — 데이터 변형 스크립트가 전부 자동 표식을 달고 있는가
//   REG-HF5  러너 계약 — 전건 통과일 때만 verified 갱신 (실패·부분 실행은 불가)
//
// ── 역주입 증명 방법 (재현 절차) ────────────────────────────────────────────
//   1) 정본 사본 생성:  node -e "...VACUUM INTO 'data/_stale.db'..."
//   2) 변형 표식 주입:  node scripts/harness-stamp.js mark --db data/_stale.db --script demo
//   3) 미검증 상태 실행: TEST_SRC_DB=data/_stale.db node --test test/harness-freshness.test.js
//      → INV-HF1 이 붉어진다.
//   4) 소화 런 흉내:     위에 HARNESS_FULL_RUN=1 HARNESS_ACK_MUTATION=<표식시각> 추가
//      → 초록.
//
//   ⚠ 4)는 **장치 검증용 재현 절차이지 우회 수단이 아니다.** 이 환경변수는 화면에
//     보이는 이 테스트만 통과시킬 뿐, **DB 의 미검증 표식은 그대로 남는다**.
//     표식을 해소하는 경로는 단 하나 — `npm test` 전건이 실제로 통과해
//     scripts/run-harness.js 가 verified 를 기록하는 것뿐이다. 그러므로 위조 env 로는
//     `npm run verify:fresh`·pre-push·서버 기동 배너를 절대 통과하지 못한다.
//     (실제 게이트는 이 테스트가 아니라 DB 스탬프다)
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { setupTestDb, openTestDb } = require('./_setup');
setupTestDb(); // ← db 모듈 require 전에 DB_PATH 주입 (실 DB 무오염)

const Database = require('better-sqlite3');
const stampLib = require('../scripts/harness-stamp');
const { shouldRecordVerified } = require('../scripts/run-harness');

const ROOT = path.join(__dirname, '..');

// 합성 스탬프 실험용 임시 DB (실 DB 와 완전 무관)
const _tmp = [];
function synthDb() {
  const p = path.join(os.tmpdir(), `hf_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
  _tmp.push(p);
  const d = new Database(p);
  stampLib.ensure(d);
  return { path: p, db: d };
}
process.on('exit', () => {
  for (const p of _tmp) for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + e); } catch (_) {} }
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-HF1 — 미검증 상태로는 하네스가 초록일 수 없다
// ─────────────────────────────────────────────────────────────────────────────
test('INV-HF1 데이터 변형 후 전체 하네스를 돌리지 않았으면 실패한다', () => {
  const db = openTestDb();
  const stamp = stampLib.read(db);

  if (!stampLib.isStale(stamp)) return; // 변형 이력 없음 또는 이미 소화됨 → 정상

  // 미검증이다. 지금 런이 "그 변형을 소화하는 전건 런" 이어야만 통과시킨다.
  const isFullRun = process.env.HARNESS_FULL_RUN === '1';
  const acked = process.env.HARNESS_ACK_MUTATION === String(stamp.mutation_at);

  assert.ok(
    isFullRun && acked,
    [
      '',
      '🔴 하네스 미검증 — 정본 데이터가 바뀐 뒤 전체 하네스를 돌리지 않았습니다.',
      `   마지막 변형 : ${stamp.mutation_at} (${stamp.mutation_script || '?'} @ ${stamp.mutation_host || '?'})`,
      `   마지막 검증 : ${stamp.verified_at || '(없음)'}`,
      `   현재 런     : ${isFullRun ? '전건' : '부분/직접 실행'}` +
        `${acked ? '' : ` · 소화 대상 불일치(ACK=${process.env.HARNESS_ACK_MUTATION || '없음'})`}`,
      '',
      '   2026-07-31 사고와 동일한 상태입니다. 재집계/시드 스크립트가 DB 를 바꿨는데',
      '   그 데이터 위에서 전체 하네스가 통과한 적이 없습니다.',
      '   ▶ 해소: npm test  (전건 통과해야 표식이 갱신됩니다)',
      '',
    ].join('\n')
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF2 — 07-31 타임라인을 스탬프 상태기계로 재연
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF2 스탬프 상태기계 — 07-31 순서 재연', () => {
  const { db } = synthDb();

  // ① 아무 이력 없음 → 미검증 아님 (변형이 없으면 검증할 것도 없다)
  assert.equal(stampLib.isStale(stampLib.read(db)), false, '변형 이력 없는 DB 를 미검증으로 오판하면 안 됨');

  // ② 15:46 하네스 통과
  stampLib.recordVerified(db, { sha: '2b9b0ef', at: '2026-07-31T06:46:00.000Z' });
  assert.equal(stampLib.isStale(stampLib.read(db)), false);

  // ③ 16:18 재집계 --apply  ← 사고의 분기점
  stampLib.recordMutation(db, {
    script: 'rebuild-lrs-aggregates-w2a.js', at: '2026-07-31T07:18:00.000Z',
  });
  const afterRebuild = stampLib.read(db);
  assert.equal(stampLib.isStale(afterRebuild), true,
    '재집계 직후는 반드시 미검증이어야 한다 — 07-31 에 이 신호가 아예 없었다');
  assert.equal(afterRebuild.mutation_script, 'rebuild-lrs-aggregates-w2a.js');

  // ④ 16:20 배포 시점 — 아무것도 안 했으므로 여전히 미검증 (배포가 상태를 씻어주지 않는다)
  assert.equal(stampLib.isStale(stampLib.read(db)), true);

  // ⑤ 전건 하네스 통과 → 해소
  stampLib.recordVerified(db, { sha: '2fe11c0', at: '2026-08-04T02:19:00.000Z' });
  const afterVerify = stampLib.read(db);
  assert.equal(stampLib.isStale(afterVerify), false);
  assert.equal(afterVerify.verified_mutation_at, '2026-07-31T07:18:00.000Z',
    '검증은 "그때의 변형" 을 소화했다고 기록해야 한다');

  // ⑥ 다음 변형이 오면 다시 미검증 — 1회 검증이 영구 면죄부가 되면 안 된다
  stampLib.recordMutation(db, { script: 'repair-daily-complete-success.js', at: '2026-08-05T01:00:00.000Z' });
  assert.equal(stampLib.isStale(stampLib.read(db)), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF3 — 게이트 CLI 종료코드
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF3 verify:fresh 게이트 — 미검증이면 exit 2, 검증됨이면 exit 0', () => {
  const { path: p, db } = synthDb();
  stampLib.recordMutation(db, { script: 'rebuild-lrs-aggregates-w2a.js', at: '2026-07-31T07:18:00.000Z' });
  db.close();

  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'harness-stamp.js'), 'check', '--db', p], {
    cwd: ROOT, encoding: 'utf8',
  });

  const bad = run();
  assert.equal(bad.status, 2, '미검증 DB 에 대해 게이트가 통과하면 안 된다');
  assert.match(String(bad.stderr), /미검증/, '경고문이 한국어로 사유를 밝혀야 한다');
  assert.match(String(bad.stderr), /rebuild-lrs-aggregates-w2a\.js/, '어떤 스크립트가 바꿨는지 지목해야 한다');

  stampLib.recordVerifiedPath(p, { sha: 'test' });
  const good = run();
  assert.equal(good.status, 0, '전건 검증 후에는 게이트가 열려야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF4 — 계측 누락 방지 (사람 기억에 의존하지 않는 부분)
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF4 데이터 변형 스크립트는 전부 자동 표식이 부착돼 있어야 한다', () => {
  const rows = stampLib.listMutationScripts();
  assert.ok(rows.length > 0, '분류기가 아무 스크립트도 못 찾았다 — 분류 규칙이 깨졌다');

  const missing = rows.filter((r) => !r.instrumented).map((r) => `${r.file} (${r.reason})`);
  assert.deepEqual(missing, [], [
    '',
    '🔴 데이터 변형 스크립트에 자동 표식이 없습니다.',
    '   아래 파일 맨 위(shebang 다음)에 한 줄을 넣으세요:',
    "     require('./_stamp-on-write');   // .mjs 는 import './_stamp-on-write.js';",
    '',
    '   이 표식이 없으면 그 스크립트가 정본 DB 를 바꿔도 하네스가 눈치채지 못합니다',
    '   (= 2026-07-31 사고 재발 경로).',
    '',
    ...missing.map((m) => `   · ${m}`),
    '',
  ].join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF5 — 러너 계약: 전건 통과일 때만 검증으로 인정
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF5 러너는 전건 통과일 때만 verified 를 갱신한다', () => {
  assert.equal(shouldRecordVerified({ exitCode: 0, isFullRun: true }), true);
  assert.equal(shouldRecordVerified({ exitCode: 1, isFullRun: true }), false, '실패한 런을 검증으로 인정하면 안 된다');
  assert.equal(shouldRecordVerified({ exitCode: 0, isFullRun: false }), false,
    '개별 테스트 몇 개 통과를 "하네스 통과" 로 승격시키면 안 된다');
  assert.equal(shouldRecordVerified({ exitCode: 1, isFullRun: false }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF6 — 자동 표식 후킹이 실제 write 에만 반응하는가 (거짓 표식 방지)
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF6 자동 표식 — 실제 write 는 잡고, DRY-RUN 임시본은 잡지 않는다', () => {
  // 부착 방식이 "스크립트가 손으로 기록 호출" 이 아니라 better-sqlite3 후킹이므로,
  // ① 실제 write 가 일어나면 반드시 표식되고
  // ② os.tmpdir() 하위(=DRY-RUN 복사본·하네스 격리본)에는 표식되지 않아야 한다.
  // ②가 깨지면 경보가 상시 울려 무의미해지고, ①이 깨지면 07-31 사고가 그대로 재발한다.
  const targets = {
    real: path.join(ROOT, 'data', `_hf_probe_${process.pid}_${Date.now()}.db`), // 정본 아님(임시 파일)
    tmp: synthDb().path,
  };
  const probe = path.join(os.tmpdir(), `hf_probe_${process.pid}_${Date.now()}.js`);
  _tmp.push(probe, targets.real);
  fs.writeFileSync(probe, `
    require(${JSON.stringify(path.join(ROOT, 'scripts', '_stamp-on-write'))});
    const D = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
    for (const p of ${JSON.stringify([targets.real, targets.tmp])}) {
      const d = new D(p);
      d.exec('CREATE TABLE IF NOT EXISTS probe_t (a INT)');
      d.prepare('INSERT INTO probe_t VALUES (?)').run(1);
      d.close();
    }
  `, 'utf8');

  const r = spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `프로브 실패: ${r.stderr}`);

  assert.notEqual(stampLib.readPath(targets.real).mutation_at, null,
    '실제 write 가 일어난 DB 에 변형 표식이 남지 않았다 — 후킹이 죽었다');
  assert.equal(stampLib.readPath(targets.tmp).mutation_at, null,
    'os.tmpdir() 하위 DB 는 DRY-RUN/격리본이므로 변형 표식을 남기면 안 된다');
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF6b — 롤백된 write 는 표식하지 않는다 (write→ROLLBACK 방식 dry-run)
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF6b 트랜잭션 — 롤백은 무표식, 커밋은 표식 (두 관용구 모두)', () => {
  // 이 저장소의 dry-run 중 일부는 "실제로 INSERT 한 뒤 ROLLBACK" 이다
  //   · scripts/import-quiz-questions.js        — exec('BEGIN') … exec('ROLLBACK')
  //   · scripts/import-learning-map-edges.mjs   — db.transaction() 안에서 의도적 throw
  // 롤백된 write 는 DB 순변경이 0 이다. 이를 "변형" 으로 표식하면 dry-run 마다 거짓 경보가
  // 뜨고, 사용자는 "이 배너는 거짓말한다" 를 학습한다. 경보 장치의 신뢰도는 경보 자체로
  // 담보할 수 없으므로, 롤백 무표식은 반드시 기계가 지켜야 한다.
  //
  // ★ 동시에 **커밋 경로는 여전히 표식**돼야 한다. 여기서 거짓 음성으로 뒤집히면
  //   장치 전체가 무의미해진다(2026-07-31 사고를 못 잡는 상태로 회귀).
  const cases = [
    ['sql_rollback', false], ['sql_commit', true],
    ['tx_rollback', false], ['tx_commit', true],
  ];

  for (const [mode, shouldStamp] of cases) {
    const dbFile = path.join(ROOT, 'data', `_hf_tx_${mode}_${process.pid}_${Date.now()}.db`);
    _tmp.push(dbFile);

    // 준비는 계측 없는 별도 프로세스에서 — 트랜잭션 "밖" write 가 섞이면
    // 롤백 여부와 무관하게 정당한 표식이 남아 측정이 오염된다.
    const prep = path.join(os.tmpdir(), `hf_prep_${mode}_${process.pid}_${Date.now()}.js`);
    _tmp.push(prep);
    fs.writeFileSync(prep, `
      const D = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
      const d = new D(${JSON.stringify(dbFile)});
      d.exec('CREATE TABLE t (a INT)');
      d.close();
    `, 'utf8');
    const pr = spawnSync(process.execPath, [prep], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(pr.status, 0, `준비 실패(${mode}): ${pr.stderr}`);

    const body = {
      sql_rollback: `d.exec('BEGIN'); d.prepare('INSERT INTO t VALUES (?)').run(1); d.exec('ROLLBACK');`,
      sql_commit: `d.exec('BEGIN'); d.prepare('INSERT INTO t VALUES (?)').run(1); d.exec('COMMIT');`,
      tx_rollback: `try { d.transaction(() => { d.prepare('INSERT INTO t VALUES (?)').run(1); throw new Error('__DRY__'); })(); } catch (e) { if (e.message !== '__DRY__') throw e; }`,
      tx_commit: `d.transaction(() => { d.prepare('INSERT INTO t VALUES (?)').run(1); })();`,
    }[mode];

    const probe = path.join(os.tmpdir(), `hf_tx_${mode}_${process.pid}_${Date.now()}.js`);
    _tmp.push(probe);
    fs.writeFileSync(probe, `
      require(${JSON.stringify(path.join(ROOT, 'scripts', '_stamp-on-write'))});
      const D = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
      const d = new D(${JSON.stringify(dbFile)});
      ${body}
      console.log('ROWS=' + d.prepare('SELECT COUNT(*) c FROM t').get().c);
      d.close();
    `, 'utf8');

    const r = spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `프로브 실패(${mode}): ${r.stderr}`);

    // DB 순변경이 기대와 맞는지 먼저 확인 — 이게 어긋나면 시나리오 자체가 무효다
    assert.match(String(r.stdout), new RegExp(`ROWS=${shouldStamp ? 1 : 0}`),
      `${mode}: DB 순변경 행수가 예상과 다르다 — 테스트 전제 붕괴`);

    const at = stampLib.readPath(dbFile).mutation_at;
    if (shouldStamp) {
      assert.notEqual(at, null,
        `${mode}: 커밋된 변형이 표식되지 않았다 — 거짓 음성이면 장치가 무의미하다`);
    } else {
      assert.equal(at, null,
        `${mode}: 롤백돼 DB 순변경이 0 인데 변형 표식이 남았다 — dry-run 마다 거짓 경보가 뜬다`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF8 — 거짓 표식을 낳는 코드 패턴 정적 탐지 (앞으로 들어올 것을 잡는다)
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF8 거짓 표식 유발 패턴 — 가드 앞 최상위 write 는 0건이어야 한다', () => {
  // ── 왜 정적 스캔인가 ────────────────────────────────────────────────────────
  // 동적 전수 검증(전 스크립트를 dry-run 해보기)은 불가능하다. 상당수 스크립트가
  // DB 경로를 하드코딩해 --db·DB_PATH 를 무시하므로, 돌리는 것 자체가 정본을 오염시킨다.
  // 그래서 "실행하지 않고 소스만 보고" 잡을 수 있는 패턴을 기계가 지킨다.
  //
  // ── 잡는 것: R1 동형 = 모듈 최상위(중괄호 깊이 0)에서 무조건 실행되는 write ──
  // repair-daily-complete-success.js 가 그랬다. CREATE TABLE 이 --dry-run 가드보다
  // 위에 있어 모듈 로드만으로 실행됐고, DRY-RUN 인데 변형 표식이 남았다.
  // 함수 안(깊이>0)의 write 는 호출돼야 실행되므로 가드가 걸릴 수 있어 제외한다.
  const scriptsDir = path.join(ROOT, 'scripts');

  // 문자열·주석을 건너뛰며 각 위치의 괄호 깊이를 구한다(따옴표 안 괄호에 오염되지 않게).
  const depthMap = (src) => {
    const d = new Array(src.length).fill(0);
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; d[i] = depth; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; d[i] = depth; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; i++;
        while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
        d[i] = depth; continue;
      }
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      d[i] = depth;
    }
    return d;
  };

  const WRITE = /\b(INSERT\s+(?:INTO|OR)|REPLACE\s+INTO|UPDATE\s+[`"'[\]\w.]+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|UNIQUE))\b/i;

  const offenders = [];
  for (const row of stampLib.listMutationScripts()) {
    const full = path.join(scriptsDir, row.file);
    let src; try { src = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }

    // 실행 분기 플래그가 없는 스크립트는 "항상 변형이 목적" 이므로 최상위 write 가 정상이다.
    if (!/--dry-run|--dry\b|--apply|DRY_RUN|dryRun/.test(src)) continue;

    const d = depthMap(src);
    const re = /\.(run|exec)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      if ((d[m.index] || 0) !== 0) continue;                     // 함수 안 → 가드 가능

      // 그 호출이 실제로 실행하는 SQL 텍스트만 본다.
      //   · .exec(…)          → 괄호 안 인자
      //   · prepare(…).run()  → 체인 앞쪽 prepare 의 인자
      // 앞뒤 컨텍스트를 뭉뚱그려 보면 db.exec('BEGIN') 이 근처 INSERT 문자열 때문에
      // write 로 오판된다(실측 오탐).
      let sql = '';
      if (m[1] === 'exec') {
        sql = src.slice(m.index, m.index + 400);
      } else {
        const before = src.slice(Math.max(0, m.index - 1500), m.index);
        const pi = before.lastIndexOf('prepare(');
        if (pi < 0) continue;                                    // 변수 참조 → 정적 판정 불가
        sql = before.slice(pi);
      }
      if (!WRITE.test(sql)) continue;                            // write 문이 아님
      if (/harness_stamp/i.test(sql)) continue;                  // 스탬프 자신
      offenders.push(`${row.file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }

  // ── 오탐 힌트 (판정에는 영향 없음) ─────────────────────────────────────────
  // depthMap 은 정규식 리터럴을 모른다. `s.replace(/'/g, "''")` 처럼 정규식 안에 맨따옴표가
  // 있으면 그 따옴표를 "문자열 시작" 으로 읽고 이후 수백 줄을 건너뛰어 깊이가 어긋난다
  // → 함수 안의 write 가 "최상위 write" 로 잘못 잡힌다(2026-08-21 실측).
  // 정규식 판별(나눗셈 `/` 과의 구분)을 제대로 하려면 앞 토큰까지 봐야 하는데, 잘못 맞히면
  // 코드 덩어리를 통째로 건너뛰어 **진짜 위반을 놓치는**(거짓 음성) 더 나쁜 실패가 된다.
  // 안전 스캐너에서 거짓 양성은 시끄럽고 즉시 고쳐지지만 거짓 음성은 조용히 잠든다.
  // → 파서를 고치는 대신 **힌트만** 준다(판정은 그대로).
  const quoteInRegex = [...new Set(offenders.map((o) => o.split(':')[0]))].filter((f) => {
    try {
      return /\/[^/\n\\]*['"][^/\n]*\/[gimsuy]*/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8'));
    } catch (_) { return false; }
  });

  assert.deepEqual(offenders, [], [
    '',
    '🔴 dry-run 플래그가 있는데 **모듈 최상위에서 무조건 실행되는 write** 가 있습니다.',
    '   모듈 로드만으로 실행되므로 --dry-run 에서도 DB 가 바뀌고, 변형 표식이 거짓으로 남습니다.',
    '   (2026-07-31 직후 repair-daily-complete-success.js 에서 실제로 발생한 결함)',
    '',
    '   고치는 법: 그 write 를 함수로 감싸고 **가드(--dry-run 검사) 통과 뒤**에만 호출하세요.',
    '',
    ...offenders.map((o) => `   · ${o}`),
    '',
    ...(quoteInRegex.length ? [
      '   ⚠ 오탐일 수 있습니다 — 아래 파일에 **정규식 리터럴 안의 따옴표**가 있습니다:',
      `       ${quoteInRegex.join(', ')}`,
      '     이 스캐너는 정규식을 모르므로 그 따옴표를 문자열 시작으로 읽어 깊이가 어긋납니다.',
      "     `s.replace(/'/g, \"''\")` 같은 코드를 split/join 으로 바꾸면 해소됩니다:",
      "       const Q = String.fromCharCode(39); s.split(Q).join(Q + Q)",
      '     (scripts/fix-answer-index-base.js 의 csvCell 이 같은 이유로 split/join 을 씁니다)',
      '',
    ] : []),
  ].join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// REG-HF7 — 하드 킬(Ctrl-C)로 끊겨도 표식이 남는가
// ─────────────────────────────────────────────────────────────────────────────
test('REG-HF7 신호로 중단돼도 이미 일어난 변형은 표식된다', () => {
  // process.on('exit') 는 신호 종료 시 호출되지 않는다. 긴 재집계를 Ctrl-C 로 끊는 것은
  // 현실적이고, 하필 그 순간이 "일부만 변형된" 상태라 재검증이 가장 절실하다.
  // 여기서 새면 "중간에 끊었으니 안 바뀌었겠지" 라는 착각이 그대로 배포로 이어진다.
  //
  // ※ Windows 한계 — 신호 전달 기구가 없어 TerminateProcess 로 하드 종료된다:
  //     · process.kill(self,'SIGINT') 도, Git Bash `kill -TERM <pid>` 같은 **외부 kill 도**
  //       리스너를 거치지 않는다. 즉 Windows 에서 외부 kill 로 끊으면 표식이 안 남는다.
  //     · 반면 **콘솔 Ctrl-C 는** Node 가 SIGINT 리스너로 변환해 주므로 정상 동작한다.
  //   그래서 여기서는 실제 Ctrl-C 가 타는 경로인 **리스너 호출**을 emit 으로 재현한다.
  //   Linux(GCP)에서는 Ctrl-C·외부 kill 모두 동일한 리스너로 들어온다.
  const target = path.join(ROOT, 'data', `_hf_sig_${process.pid}_${Date.now()}.db`);
  const probe = path.join(os.tmpdir(), `hf_sig_${process.pid}_${Date.now()}.js`);
  _tmp.push(probe, target);
  fs.writeFileSync(probe, `
    require(${JSON.stringify(path.join(ROOT, 'scripts', '_stamp-on-write'))});
    const D = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
    const d = new D(${JSON.stringify(target)});
    d.exec('CREATE TABLE IF NOT EXISTS sig_t (a INT)');
    d.prepare('INSERT INTO sig_t VALUES (?)').run(1);
    d.close();
    process.emit('SIGINT');           // ← Ctrl-C 와 같은 리스너 경로
    console.log('NOT_REACHED');       // 리스너가 프로세스를 끝내야 정상
  `, 'utf8');

  const r = spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8' });

  assert.notEqual(stampLib.readPath(target).mutation_at, null,
    '신호로 중단된 실행에서 이미 커밋된 write 가 표식되지 않았다 — 가장 재검증이 필요한 순간을 놓친다');
  assert.doesNotMatch(String(r.stdout), /NOT_REACHED/,
    '신호 처리 후 기본 동작(종료)을 흉내내야 한다 — 삼켜버리면 Ctrl-C 가 안 먹는다');
});
