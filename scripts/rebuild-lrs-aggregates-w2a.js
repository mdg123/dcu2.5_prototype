#!/usr/bin/env node
/**
 * scripts/rebuild-lrs-aggregates-w2a.js
 * ─────────────────────────────────────────────────────────────────────────────
 * [W2-a] 상류 집계기 정본화 이후, **정본 DB 의 집계 테이블을 새 규칙으로 재작성**한다.
 *
 * ⚠ 왜 별도 스크립트인가
 *   코드를 고쳐도 이미 저장된 집계 값은 저절로 바뀌지 않는다.
 *   lrs_achievement_stats 는 실시간 경로가 건드린 (user, code) 만 갱신되므로,
 *   **활동이 멈춘 학생·성취기준은 낡은 오염값을 영구히 유지**한다.
 *   따라서 배포 후 이 스크립트를 1회 돌려야 화면 숫자가 정본과 일치한다.
 *
 * ⚠ 파괴적 작업이다
 *   rebuildAllAggregates() 는 7개 집계 테이블을 DELETE 후 재작성한다.
 *   원천(learning_logs)은 건드리지 않으므로 **이론상 언제든 재생성 가능**하지만,
 *   실행 전 백업을 강제한다(아래 --backup 기본 ON).
 *
 * ── 사용법 ───────────────────────────────────────────────────────────────────
 *   1) DRY-RUN (기본값. 아무것도 쓰지 않는다)
 *        node scripts/rebuild-lrs-aggregates-w2a.js
 *      → 임시 복사본에서 재집계해 **전/후 대비표만** 출력한다. 정본 DB 무변경.
 *
 *   2) 실제 적용
 *        node scripts/rebuild-lrs-aggregates-w2a.js --apply
 *      → ① 백업 생성 → ② 정본 DB 재집계 → ③ 전/후 대비표 + 사후 검증 출력
 *
 *   옵션
 *     --apply            실제 정본 DB 에 적용 (없으면 DRY-RUN)
 *     --no-backup        백업 생략 (권장하지 않음)
 *     --db <path>        대상 DB 경로 (기본 data/dacheum.db)
 *
 * ── 롤백 ─────────────────────────────────────────────────────────────────────
 *   백업 파일을 원위치로 복사하면 즉시 복구된다:
 *     cp data/backups/dacheum.db.pre-w2a-<타임스탬프> data/dacheum.db
 *   또는 코드를 이전 커밋으로 되돌린 뒤 이 스크립트를 --apply 로 재실행해도
 *   집계는 learning_logs 로부터 완전히 재생성된다(원천 무손상이므로 가역).
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const APPLY = has('--apply');
const DO_BACKUP = !has('--no-backup');
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.resolve(val('--db', path.join(ROOT, 'data', 'dacheum.db')));

if (!fs.existsSync(DB_PATH)) {
  console.error(`🔴 DB 가 없습니다: ${DB_PATH}`);
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const pad = (x, n) => String(x).padStart(n);

// ── 집계 스냅샷(전/후 대비용) ────────────────────────────────────────────────
function snapshot(db) {
  const lv = Object.fromEntries(
    db.prepare('SELECT level, COUNT(*) n FROM lrs_achievement_stats GROUP BY level').all()
      .map(r => [r.level, r.n])
  );
  const t = db.prepare(
    'SELECT COUNT(*) rows, COALESCE(SUM(attempt_count),0) att, COALESCE(SUM(success_count),0) suc FROM lrs_achievement_stats'
  ).get();
  const reached = lv.reached || 0, partial = lv.partial || 0;
  const notReached = lv.not_reached || 0, insufficient = lv.insufficient || 0;
  const evaluated = reached + partial + notReached;
  const scaleViolations = {};
  for (const tb of ['lrs_daily_stats', 'lrs_user_summary', 'lrs_content_summary',
    'lrs_class_summary', 'lrs_service_stats', 'lrs_achievement_stats', 'lrs_user_daily']) {
    scaleViolations[tb] = db.prepare(
      `SELECT COUNT(*) n FROM ${tb} WHERE avg_score IS NOT NULL AND (avg_score < 0 OR avg_score > 100 OR (avg_score > 0 AND avg_score <= 1))`
    ).get().n;
  }
  return {
    rows: t.rows, att: t.att, suc: t.suc,
    reached, partial, notReached, insufficient, evaluated,
    groupReach: evaluated ? +(reached / evaluated * 100).toFixed(1) : null,
    pooled: t.att ? +(t.suc / t.att * 100).toFixed(1) : null,
    scaleViolations,
  };
}

function diffTable(b, a) {
  console.log('\n══════ 전/후 대비표 (lrs_achievement_stats) ══════');
  console.log('  지표                    BEFORE         AFTER        변화');
  const row = (label, x, y, suf = '') => {
    const d = (y == null || x == null) ? '—' : ((y - x > 0 ? '+' : '') + (y - x).toFixed(Number.isInteger(y - x) ? 0 : 1));
    console.log(`  ${label.padEnd(20)} ${pad(x ?? '—', 10)} ${pad(y ?? '—', 13)} ${pad(d, 11)}${suf}`);
  };
  row('저장 행수', b.rows, a.rows);
  row('attempt 합계', b.att, a.att);
  row('success 합계', b.suc, a.suc);
  row('도달', b.reached, a.reached);
  row('부분도달', b.partial, a.partial);
  row('미도달', b.notReached, a.notReached);
  row('평가부족', b.insufficient, a.insufficient);
  row('평가된(분모)', b.evaluated, a.evaluated);
  row('집단도달률 A3', b.groupReach, a.groupReach, ' %p');
  row('풀드 정답인정률', b.pooled, a.pooled, ' %p');

  console.log('\n  ── 스케일 위반(0~100 밖 또는 0<x<=1) ──');
  for (const k of Object.keys(a.scaleViolations)) {
    const bv = b.scaleViolations[k], av = a.scaleViolations[k];
    console.log(`  ${k.padEnd(24)} ${pad(bv, 8)} → ${pad(av, 8)} ${av === 0 ? '✅' : '🔴 잔존'}`);
  }
}

// ── 사후 검증 (적용 후 반드시 통과해야 하는 불변식) ──────────────────────────
function verify(db) {
  const { masteryAttemptWhere } = require(path.join(ROOT, 'lib', 'lrs', 'mastery-population'));
  const checks = [];
  const stored = db.prepare('SELECT COALESCE(SUM(attempt_count),0) s FROM lrs_achievement_stats').get().s;
  const truth = db.prepare(`SELECT COUNT(*) n FROM learning_logs WHERE ${masteryAttemptWhere('')}`).get().n;
  checks.push(['attempt 합계 = 정본 술어 통과 로그수', stored === truth, `${stored} vs ${truth}`]);
  checks.push(['분자 <= 분모', db.prepare('SELECT COUNT(*) n FROM lrs_achievement_stats WHERE success_count > attempt_count').get().n === 0, '']);
  checks.push(['시도 0 유령행 없음', db.prepare('SELECT COUNT(*) n FROM lrs_achievement_stats WHERE COALESCE(attempt_count,0)=0').get().n === 0, '']);
  let scaleOk = true;
  for (const tb of Object.keys(snapshot(db).scaleViolations)) {
    if (snapshot(db).scaleViolations[tb] !== 0) scaleOk = false;
  }
  checks.push(['모든 avg_score 가 0~100 정규화', scaleOk, '']);

  console.log('\n══════ 사후 검증 ══════');
  let allOk = true;
  for (const [name, ok, detail] of checks) {
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✅' : '🔴'} ${name}${detail ? ' — ' + detail : ''}`);
  }
  return allOk;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(function main() {
  console.log(`대상 DB : ${DB_PATH}`);
  console.log(`모드    : ${APPLY ? '🔴 APPLY (정본 DB 를 실제로 재작성)' : '✅ DRY-RUN (정본 DB 무변경)'}`);

  let workPath = DB_PATH;
  let tempPath = null;

  if (!APPLY) {
    // DRY-RUN: 정본을 임시 복사본으로 떠서 그 위에서만 재집계한다.
    tempPath = path.join(require('os').tmpdir(), `w2a_dryrun_${process.pid}_${Date.now()}.db`);
    const src = new Database(DB_PATH, { readonly: true });
    src.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    src.close();
    workPath = tempPath;
    console.log(`DRY-RUN 복사본: ${tempPath}`);
  } else if (DO_BACKUP) {
    const backupDir = path.join(path.dirname(DB_PATH), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `dacheum.db.pre-w2a-${ts}`);
    const src = new Database(DB_PATH, { readonly: true });
    src.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    src.close();
    const mb = (fs.statSync(backupPath).size / 1048576).toFixed(1);
    console.log(`✅ 백업 생성: ${backupPath} (${mb} MB)`);
    console.log(`   롤백: copy "${backupPath}" "${DB_PATH}"`);
  } else {
    console.log('⚠ --no-backup 지정됨 — 백업 없이 진행합니다.');
  }

  // db/index.js 는 require 시점 1회 DB_PATH 를 읽는다 → 반드시 require 전에 주입.
  process.env.DB_PATH = workPath;
  const db = require(path.join(ROOT, 'db', 'index'));
  const { rebuildAllAggregates } = require(path.join(ROOT, 'db', 'lrs-aggregate'));

  const before = snapshot(db);
  const t0 = Date.now();
  const counts = rebuildAllAggregates();
  const after = snapshot(db);

  diffTable(before, after);
  console.log(`\n재집계 소요: ${Date.now() - t0}ms · 총 로그 ${counts.totalLogs}건`);
  const ok = verify(db);

  if (!APPLY) {
    console.log('\n※ DRY-RUN 이므로 정본 DB 는 변경되지 않았습니다.');
    console.log('   실제 적용하려면: node scripts/rebuild-lrs-aggregates-w2a.js --apply');
    try { db.close(); } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.existsSync(tempPath + ext) && fs.unlinkSync(tempPath + ext); } catch (_) {}
    }
  } else {
    console.log(ok ? '\n✅ 적용 완료 — 사후 검증 전부 통과.' : '\n🔴 적용됐으나 사후 검증 실패 — 백업으로 롤백을 검토하세요.');
  }
  process.exit(ok ? 0 : 1);
})();
