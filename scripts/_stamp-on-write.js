'use strict';
/**
 * scripts/_stamp-on-write.js — 데이터 변형 자동 표식 (1줄 require 로 부착)
 * ─────────────────────────────────────────────────────────────────────────────
 * 데이터 변형 스크립트 맨 위에 이 한 줄만 넣는다:
 *
 *     require('./_stamp-on-write');          // (.mjs 는 import './_stamp-on-write.js')
 *
 * 그러면 better-sqlite3 를 후킹해 **실제로 write 문이 실행된 DB 파일**을 기억했다가,
 * 프로세스 종료 시 그 DB 의 harness_stamp.mutation_at 을 갱신한다.
 *
 * ■ 왜 "스크립트마다 손으로 기록 호출" 이 아니라 후킹인가
 *   손으로 넣으면 (a) --apply 분기·조기 return·예외 경로를 빠뜨리고,
 *   (b) 스크립트마다 구조가 달라 넣는 위치를 매번 판단해야 한다.
 *   후킹은 **write 가 실제 일어났을 때만** 기록하므로 DRY-RUN 은 자동으로 제외되고,
 *   중간에 예외로 죽어도 이미 쓴 만큼은 정확히 기록된다.
 *
 * ■ 기록하지 않는 경우 (거짓 표식 방지)
 *   · 임시 디렉터리(os.tmpdir()) 하위 파일 — DRY-RUN 복사본·하네스 격리본
 *   · :memory: DB
 *   · readonly 로 연 핸들 (VACUUM INTO 백업 등 원본 무변경 작업)
 *   · harness_stamp 자기 자신에 대한 write
 *   · 읽기 전용 문(SELECT)·PRAGMA·VACUUM
 *
 * ■ 이 표식이 하는 일
 *   정본 DB(data/dacheum.db)가 변형되면 그 순간부터 하네스 통과 이력은 무효가 된다.
 *   test/harness-freshness.test.js · `npm run verify:fresh` · pre-push · 서버 기동 배너가
 *   이 표식을 읽어 "미검증" 을 붉게 알린다. → `npm test` 전체가 통과해야 해소된다.
 *   (2026-07-31 사고: 재집계가 push 이후에 실행돼 어떤 게이트에도 안 걸렸다)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const stampLib = require('./harness-stamp');

// 중복 부착 방지 (여러 모듈이 require 해도 1회만 패치)
// ⚠ 전체를 try/catch 로 감싼다 — 이 모듈은 66개 데이터 스크립트가 무조건 로드하는
//   부수 장치다. 여기서 예외가 나면 본래 작업(재집계·시드·마이그레이션)까지 죽는다.
//   표식은 "있으면 좋은 안전망" 이지 작업의 전제조건이 아니다. 실패해도 경고만 남긴다.
try {
if (!global.__dacheumStampOnWrite) {
  global.__dacheumStampOnWrite = true;

  const TMP = path.resolve(os.tmpdir());
  const dirty = new Set();   // 확정 변형 (커밋됐거나 트랜잭션 밖)
  const pending = new Set(); // 트랜잭션 안에서 발생 — 커밋/롤백이 갈릴 때까지 보류

  // DML/DDL 판별. PRAGMA·VACUUM·SELECT 는 제외(원본 무변경).
  const WRITE_SQL = /\b(INSERT\s+(?:INTO|OR)|REPLACE\s+INTO|UPDATE\s+[`"'[\]\w.]+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|UNIQUE))\b/i;

  // 트랜잭션 제어문 — write 가 아니어도 커밋/롤백 판정을 위해 관찰해야 한다.
  const TX_CTRL = /\b(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

  /** 이 DB 핸들이 표식 대상 파일인가 (SQL 무관) */
  function dbTarget(db) {
    if (!db || db.readonly) return null;                  // readonly 핸들은 원본 무변경
    const name = db.name;
    if (!name || name === ':memory:' || name === '') return null;
    const abs = path.resolve(name);
    if (abs.startsWith(TMP + path.sep)) return null;      // DRY-RUN·하네스 임시 복사본
    return abs;
  }

  function isWriteSql(sql) {
    return !!sql && WRITE_SQL.test(sql) && !/harness_stamp/i.test(sql); // 스탬프 자신 제외
  }

  const promote = (t) => { if (pending.delete(t)) dirty.add(t); };
  const discard = (t) => { pending.delete(t); };

  /** write 1건 기록 — 트랜잭션 안이면 보류, 밖이면 즉시 확정 */
  function noteWrite(db, target) {
    if (db.inTransaction) pending.add(target); else dirty.add(target);
  }

  /**
   * 호출 직후 트랜잭션 경계가 닫혔는지 보고 보류분을 확정/폐기한다.
   * ⚠ 롤백된 write 는 DB 순변경이 0 이다. 그걸 "변형" 으로 표식하면
   *   write→ROLLBACK 방식 dry-run(=이 저장소에 실재하는 관용구)이 매번 거짓 경보를 낸다.
   *   거짓 경보는 "이 배너는 거짓말한다" 를 학습시켜 경보 장치 전체를 무력화한다.
   */
  function settleTx(db, target, wasInTx, sql) {
    if (!target || !wasInTx || db.inTransaction) return;  // 경계가 안 닫혔으면 판단 보류
    const s = String(sql || '');
    const rolledBack = /\bROLLBACK\b/i.test(s) && !/\bTO\b/i.test(s); // ROLLBACK TO SAVEPOINT 는 부분 롤백
    if (rolledBack && !/\bCOMMIT\b/i.test(s)) discard(target);
    else promote(target);                                  // COMMIT·END, 또는 판정 불가 → 보수적 확정
  }

  const origPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
    const stmt = origPrepare.call(this, sql, ...rest);
    const db = this;
    const target = dbTarget(db);
    const write = isWriteSql(sql);
    // 트랜잭션 제어문도 래핑해야 COMMIT/ROLLBACK 을 관찰할 수 있다.
    if (target && (write || TX_CTRL.test(sql)) && stmt && typeof stmt.run === 'function') {
      const origRun = stmt.run;
      try {
        stmt.run = function patchedRun(...args) {
          const wasInTx = db.inTransaction;
          const r = origRun.apply(stmt, args);
          if (write) noteWrite(db, target);               // 실제 실행된 뒤에만
          settleTx(db, target, wasInTx, sql);
          return r;
        };
      } catch (_) { if (write) dirty.add(target); }       // 확장 불가 객체면 보수적으로 표식
    }
    return stmt;
  };

  const origExec = Database.prototype.exec;
  Database.prototype.exec = function patchedExec(sql, ...rest) {
    const target = dbTarget(this);
    const wasInTx = target ? this.inTransaction : false;
    const r = origExec.call(this, sql, ...rest);
    if (target) {
      if (isWriteSql(sql)) noteWrite(this, target);
      settleTx(this, target, wasInTx, sql);
    }
    return r;
  };

  // ── db.transaction() 래퍼 후킹 ─────────────────────────────────────────────
  // better-sqlite3 의 transaction() 은 BEGIN/COMMIT/SAVEPOINT 를 **C++ 내부에서** 실행하므로
  // prepare/exec 의 SQL 문자열로는 커밋인지 롤백인지 절대 알 수 없다.
  // 호출 경계를 감싸 "정상 반환=커밋 / 예외=롤백" 으로 판정한다.
  // (이 저장소의 dry-run 관용구 중 2건이 '트랜잭션 안에서 일부러 throw' 방식이다)
  const origTransaction = Database.prototype.transaction;
  Database.prototype.transaction = function patchedTransaction(fn) {
    const wrapped = origTransaction.call(this, fn);
    const db = this;
    const target = dbTarget(db);
    if (!target || typeof wrapped !== 'function') return wrapped;

    const wrap = (f) => function patchedTxCall(...args) {
      const outermost = !db.inTransaction;                // 중첩(savepoint)은 최외곽만 판정
      try {
        const out = f.apply(this, args);
        if (outermost && !db.inTransaction) promote(target);   // 커밋 완료
        return out;
      } catch (e) {
        if (outermost && !db.inTransaction) discard(target);   // 롤백 완료 → 순변경 0
        throw e;
      }
    };

    const out = wrap(wrapped);
    // .deferred/.immediate/.exclusive 변형도 동일하게 감싼다.
    for (const k of ['default', 'deferred', 'immediate', 'exclusive']) {
      if (typeof wrapped[k] === 'function') { try { out[k] = wrap(wrapped[k]); } catch (_) {} }
    }
    return out;
  };

  const flush = () => {
    // 보류분이 남았다 = 커밋/롤백 경계를 못 본 채 프로세스가 끝났다(신호 중단·강제 종료 등).
    // 커밋 여부가 불명이면 **변형된 쪽으로** 가정한다 — 놓치는 것보다 과하게 알리는 게 안전하다.
    // (N1: 신호로 끊긴 경우에도 표식이 남아야 한다는 요구와 정확히 같은 방향)
    for (const t of pending) dirty.add(t);
    pending.clear();
    if (dirty.size === 0) return;
    const script = path.basename(process.argv[1] || 'unknown');
    for (const dbPath of dirty) {
      let at = null;
      try {
        at = stampLib.recordMutationPath(dbPath, { script, note: process.argv.slice(2).join(' ') || null });
      } catch (e) {
        console.error(`⚠ 변형 표식 기록 실패(${dbPath}): ${e.message}`);
        continue;
      }
      if (path.resolve(dbPath) === path.resolve(stampLib.CANONICAL_DB)) {
        console.error([
          '',
          '════════════════════════════════════════════════════════════════════',
          '⚠ 정본 DB 가 변경되었습니다 — 지금부터 하네스는 "미검증" 상태입니다.',
          `   변경 스크립트 : ${script}`,
          `   대상 DB       : ${dbPath}`,
          `   표식 시각     : ${at}`,
          '',
          '   하네스(npm test)의 근거 데이터가 바뀌었으므로 직전 통과 이력은 무효입니다.',
          '   ▶ 지금 실행:  npm test        (전체 통과해야 표식이 해소됩니다)',
          '   ▶ 상태 확인:  npm run verify:fresh',
          '   해소 전에는 개별 테스트 실행·pre-push·서버 기동에서 계속 경고가 뜹니다.',
          '════════════════════════════════════════════════════════════════════',
        ].join('\n'));
      } else {
        console.error(`✍ 변형 표식 기록: ${path.basename(dbPath)} (${script})`);
      }
    }
    dirty.clear(); // 재진입(신호 → exit) 시 중복 기록 방지
  };

  process.on('exit', flush);

  // ── 하드 킬 대응 (Ctrl-C / kill) ───────────────────────────────────────────
  // process.on('exit') 는 **신호로 죽을 때 호출되지 않는다**. 긴 재집계를 Ctrl-C 로
  // 끊는 것은 현실적이고, 하필 그 순간이 "일부만 변형된" 상태라 재검증이 가장 필요하다.
  // 신호를 가로채 표식을 남긴 뒤, 기본 동작을 흉내내도록 같은 신호로 스스로를 다시 죽인다
  // (리스너를 떼고 re-raise → 종료코드가 신호 종료로 보존되고, 다른 리스너도 방해받지 않는다).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => {
      try { flush(); } catch (e) { console.error(`⚠ 표식 기록 실패: ${e.message}`); }
      if (process.listenerCount(sig) <= 1) {
        process.removeAllListeners(sig);
        try { process.kill(process.pid, sig); } catch (_) { process.exit(1); }
      }
    });
  }
}
} catch (e) {
  // 장치 부착 실패가 본래 작업을 막지 않게 한다 (경고만).
  console.error(`⚠ 변형 표식 장치 부착 실패 — 이 실행은 표식 없이 진행됩니다: ${e && e.message}`);
}
