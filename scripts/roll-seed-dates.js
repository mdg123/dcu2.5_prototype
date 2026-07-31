#!/usr/bin/env node
/**
 * roll-seed-dates.js — 시드 로그 롤링화(시간축 전진)
 * ────────────────────────────────────────────────────────────────────────────
 * 시드 데이터는 "생성된 날"에 고정돼 있어 시간이 지나면 화면의 롤링 창
 * (최근 7일·30일·DAU/WAU)에서 통째로 빠져나간다. 2026-07-30 시점에 시드 로그가
 * 2026-07-10 에서 끊겨(20일 공백) 관리자 활성률 0.0%p·지역비교 "표본 부족"·
 * 교사 DAU/WAU 0 이 된 사고가 그 결과다.
 *
 * 이 스크립트는 **시드 행만** 골라 시간축을 앞으로 밀어 "항상 최근까지 이어지는"
 * 상태로 되돌린다. age-db-canary.js 의 역(逆)연산이며 기법(전 테이블 시간컬럼
 * 일괄 이동)을 공유한다.
 *
 * ── 안전 원칙 ───────────────────────────────────────────────────────────────
 *  1. **is_seed=0(실사용) 행은 절대 건드리지 않는다.** 실제 기록 조작 금지.
 *     실데이터가 과거에 머무는 것은 정직한 상태다.
 *  2. **요일 보존**: 오프셋은 항상 7의 배수. 시드는 주중(~2,100~3,300건)과
 *     주말(~800건)의 밀도차가 뚜렷해, 7의 배수가 아니면 "주말 모양"의 데이터가
 *     월요일에 얹혀 요일 히트맵·주간 집계가 거짓이 된다.
 *  3. **멱등**: 오프셋을 매 실행마다 데이터에서 재계산한다. 이미 최신이면 no-op.
 *  4. **포맷 보존**: 날짜온리('2026-07-10')·datetime('... 09:12:33')·
 *     ISO8601Z('...T01:16:20.520Z') 를 행 단위로 판별해 원래 형식 그대로 유지.
 *     (datetime() 로 일괄 처리하면 날짜온리 컬럼에 시각이 붙고 xAPI 의 T/Z 가 깨진다)
 *
 * ── 시드 판별 기준(테이블별) ────────────────────────────────────────────────
 *   A. is_seed 컬럼 보유       → is_seed = 1                (명시적·최우선)
 *   B. 없으면 사용자 참조 보유 → user_id ∈ (시드 계정)      (소유 기반)
 *   C. 둘 다 없음(순수 집계)   → 귀속 불가 → **건너뜀**(보고서에 명시)
 *
 * 사용법:
 *   node scripts/roll-seed-dates.js --db data/_roll.db              # 드라이런(기본)
 *   node scripts/roll-seed-dates.js --db data/_roll.db --apply      # 실제 적용
 *   node scripts/roll-seed-dates.js --db data/_roll.db --apply --days 14
 *
 * ⚠ --db 는 필수. 실수로 정본(data/dacheum.db)에 적용되지 않도록 기본값을 두지 않는다.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const APPLY = has('--apply');
const DB_PATH = argOf('--db', null);
const FORCE_DAYS = argOf('--days', null);
const DEMO_SEED = has('--include-demo-seed'); // 실계정 위 시드행도 이동할지

if (!DB_PATH) {
  console.error('✖ --db <경로> 는 필수입니다. (정본 오적용 방지)');
  console.error('  예: node scripts/roll-seed-dates.js --db data/_roll.db --apply');
  process.exit(1);
}
const DB = path.resolve(DB_PATH);
if (!fs.existsSync(DB)) { console.error(`✖ DB 없음: ${DB}`); process.exit(1); }

const db = new Database(DB);
db.pragma('journal_mode = WAL');

// ── 0) 시드 계정 집합 ───────────────────────────────────────────────────────
const SEED_USERS_SQL = '(SELECT id FROM users WHERE is_seed = 1)';
const seedUserCount = db.prepare('SELECT COUNT(*) c FROM users WHERE is_seed = 1').get().c;

// ── 1) 오프셋 산출 (데이터 파생 → 멱등) ─────────────────────────────────────
// 기준점: learning_logs 의 시드 최신일. 화면의 DAU/WAU/30일 창이 모두 이 축을 본다.
// ★ 기준 조건은 아래 실제 이동 스코프와 반드시 일치해야 한다.
//   (이동하지 않는 행까지 세면 기준일이 영원히 과거에 머물러 매 실행마다 또 밀린다 = 멱등 붕괴)
const SEED_LOG_SCOPE = DEMO_SEED ? 'is_seed = 1' : `is_seed = 1 AND user_id IN ${SEED_USERS_SQL}`;
const anchorRow = db.prepare(
  `SELECT MAX(DATE(created_at)) mx FROM learning_logs WHERE ${SEED_LOG_SCOPE}`
).get();
const anchorDate = anchorRow && anchorRow.mx;
if (!anchorDate) { console.error('✖ learning_logs 에 is_seed=1 행이 없습니다.'); process.exit(1); }

const today = db.prepare("SELECT DATE('now','localtime') d").get().d;
const gap = db.prepare("SELECT CAST(julianday(?) - julianday(?) AS INTEGER) g").get(today, anchorDate).g;

let OFFSET;
if (FORCE_DAYS != null) {
  OFFSET = parseInt(FORCE_DAYS, 10);
  if (!Number.isFinite(OFFSET)) { console.error('✖ --days 는 정수'); process.exit(1); }
} else {
  // 7의 배수로 반올림 — 요일 보존이 최우선 제약.
  OFFSET = 7 * Math.round(gap / 7);
}

console.log('══════════ roll-seed-dates ══════════');
console.log(`DB            : ${DB}`);
console.log(`모드          : ${APPLY ? 'APPLY(실제 적용)' : 'DRY-RUN(기본, 변경 없음)'}`);
console.log(`오늘          : ${today}`);
console.log(`시드 최신일   : ${anchorDate}  (learning_logs is_seed=1)`);
console.log(`공백          : ${gap}일`);
console.log(`오프셋        : +${OFFSET}일 ${FORCE_DAYS != null ? '(--days 지정)' : '(자동: 7의 배수 반올림)'}`);
console.log(`시드 계정     : ${seedUserCount}명`);
console.log(`데모시드 포함 : ${DEMO_SEED ? 'YES (--include-demo-seed) — 실계정 위 시드행도 이동' : 'NO (기본) — 실계정 소유 시드행은 제자리'}`);

if (OFFSET <= 0) {
  console.log('\n✔ 이미 최신입니다 — 이동할 것이 없습니다 (no-op).');
  console.log('  (멱등: 오프셋을 데이터에서 재계산하므로 반복 실행해도 두 배로 밀리지 않습니다)');
  db.close();
  process.exit(0);
}
if (OFFSET % 7 !== 0) {
  console.log(`\n⚠ ${OFFSET}일은 7의 배수가 아닙니다 — 요일이 ${OFFSET % 7}칸 회전합니다.`);
  console.log('  주말(저밀도) 데이터가 평일 칸에 얹혀 요일 히트맵·주간 집계가 거짓이 됩니다.');
}
console.log(`이동 후 예상 시드 최신일: ${db.prepare("SELECT DATE(?, '+' || ? || ' days') d").get(anchorDate, OFFSET).d}`);

// ── 2) 시간 컬럼 자동 탐지 ──────────────────────────────────────────────────
// 이름 휴리스틱(넓게) + 값 검증(datetime 파싱 가능). 이름만 화이트리스트로 잡으면
// last_attempt_at·checked_at·joined_at·last_activity_at 같은 컬럼을 놓친다.
const NAME_RE = /(_at|_date|_time|_timestamp)$/i;
const NAME_EXACT = /^(timestamp|date|time)$/i;

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);

const USER_COLS = ['user_id', 'student_id', 'author_id', 'actor_user_id', 'owner_id', 'member_id'];

const plan = [];      // 이동 대상
const skipped = [];   // 귀속 불가 등

for (const t of tables) {
  let info;
  try { info = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch (_) { continue; }
  const names = info.map(c => c.name);
  const timeCols = names.filter(n => NAME_RE.test(n) || NAME_EXACT.test(n));
  if (!timeCols.length) continue;

  let rows = 0;
  try { rows = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (_) { continue; }
  if (rows === 0) continue;

  // 시드 판별 기준 결정
  const hasSeedFlag = names.some(n => n.toLowerCase() === 'is_seed');
  const userCol = USER_COLS.find(u => names.includes(u));
  let scope, basis;
  if (hasSeedFlag && userCol && DEMO_SEED) {
    // --include-demo-seed: 실계정(데모) 위에 얹힌 시드 행도 함께 이동.
    // teacher1 데모 클래스 구성원이 실계정이라, 이걸 켜야 교사 "내 클래스끼리"
    // 활성률이 살아난다. 대신 uid3 고정 창 GT 2건 재고정 필요(테스트 파일 정책상 "재시드 시 갱신").
    scope = 'is_seed = 1';
    basis = 'A) is_seed 플래그(데모 포함)';
  }
  else if (hasSeedFlag && userCol) {
    // is_seed=1 이어도 **실계정 소유면 제외**한다.
    // 실계정(데모 포함)의 타임라인에는 옮기지 않는 is_seed=0 행이 섞여 있어,
    // 일부만 앞으로 밀면 한 사용자의 이력이 조각나 앞뒤가 안 맞게 된다.
    // (실제 사례: uid3=student1 의 content_solve 7건만 튀어나가 고정 창 GT 붕괴)
    scope = `is_seed = 1 AND "${userCol}" IN ${SEED_USERS_SQL}`;
    basis = `A) is_seed=1 ∧ 시드계정(${userCol})`;
  }
  else if (hasSeedFlag) { scope = 'is_seed = 1'; basis = 'A) is_seed 플래그'; }
  else if (userCol) { scope = `"${userCol}" IN ${SEED_USERS_SQL}`; basis = `B) 소유(${userCol}∈시드계정)`; }
  else { skipped.push({ t, rows, reason: 'C) 귀속 불가(집계·시드 판별 불가)', cols: timeCols.join(',') }); continue; }

  // 실제로 시드 행이 있는지 + 컬럼별 형식 판별
  let scopeRows = 0;
  try { scopeRows = db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE ${scope}`).get().c; } catch (_) { continue; }
  if (scopeRows === 0) { skipped.push({ t, rows, reason: '시드 행 0건(전부 실사용) → 미대상', cols: timeCols.join(',') }); continue; }

  for (const c of timeCols) {
    let f;
    try {
      f = db.prepare(
        `SELECT COUNT(*) n,
                SUM(CASE WHEN datetime("${c}") IS NOT NULL THEN 1 ELSE 0 END) parseable
           FROM "${t}"
          WHERE "${c}" IS NOT NULL AND typeof("${c}") = 'text' AND ${scope}`
      ).get();
    } catch (_) { continue; }
    if (!f || !f.n || !f.parseable) continue;   // 값이 없거나 날짜가 아니면 제외
    plan.push({ t, c, scope, basis, n: f.n });
  }
}

// ── 3) 형식 보존 이동식 ─────────────────────────────────────────────────────
// 행 단위로 원래 포맷을 판별해 그대로 유지한다.
const mod = (days) => (days >= 0 ? `+${days} days` : `${days} days`);
const shiftExpr = (c, days) => `
  CASE
    WHEN "${c}" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      THEN DATE("${c}", '${mod(days)}')
    WHEN "${c}" LIKE '%T%Z'
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', "${c}", '${mod(days)}')
    ELSE datetime("${c}", '${mod(days)}')
  END`;

// ── 3-b) UNIQUE 인덱스에 참여하는 컬럼 판별 ─────────────────────────────────
// 시간 컬럼이 UNIQUE 키의 일부이면, 행을 하나씩 앞으로 밀 때
// "아직 안 옮겨진 형제 행"과 순간적으로 충돌한다(예: attendance 05-30→06-20 인데
// 06-20 행이 아직 그 자리에 있음). 실제 중복이 아니라 **이동 순서 artifact** 다.
// → 충돌 불가능한 먼 미래로 일단 대피(park)시켰다가 되돌리는 2단계로 해소한다.
const PARK_DAYS = 100000; // ≈274년 — 기존 어떤 행과도 겹치지 않음
const uniqueColsOf = (t) => {
  const s = new Set();
  try {
    for (const i of db.prepare(`PRAGMA index_list("${t}")`).all()) {
      if (!i.unique) continue;
      for (const ci of db.prepare(`PRAGMA index_info("${i.name}")`).all()) if (ci.name) s.add(ci.name);
    }
  } catch (_) {}
  return s;
};

// ── 4) 전 상태 스냅샷 ───────────────────────────────────────────────────────
// 불변 대상 = 이동 스코프의 여집합(실사용 + 실계정 소유 시드행) 전체
const KEEP = `NOT (${SEED_LOG_SCOPE})`;
const snap = () => ({
  seedMax: db.prepare(`SELECT MAX(DATE(created_at)) m FROM learning_logs WHERE ${SEED_LOG_SCOPE}`).get().m,
  realMax: db.prepare(`SELECT MAX(DATE(created_at)) m FROM learning_logs WHERE ${KEEP}`).get().m,
  realMin: db.prepare(`SELECT MIN(DATE(created_at)) m FROM learning_logs WHERE ${KEEP}`).get().m,
  realCnt: db.prepare(`SELECT COUNT(*) c FROM learning_logs WHERE ${KEEP}`).get().c,
  realSum: db.prepare(`SELECT COALESCE(SUM(CAST(strftime('%s',created_at) AS INTEGER)),0) s FROM learning_logs WHERE ${KEEP}`).get().s,
});
const before = snap();

console.log(`\n── 이동 계획: ${plan.length}개 컬럼 (${new Set(plan.map(p => p.t)).size}개 테이블) ──`);
const byTable = new Map();
for (const p of plan) {
  if (!byTable.has(p.t)) byTable.set(p.t, { basis: p.basis, cols: [], n: 0 });
  const e = byTable.get(p.t); e.cols.push(p.c); e.n = Math.max(e.n, p.n);
}
for (const [t, e] of [...byTable.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${t.padEnd(26)} ${String(e.n).padStart(7)}행  [${e.basis}]  ${e.cols.join(', ')}`);
}
if (skipped.length) {
  console.log(`\n── 제외: ${skipped.length}개 테이블 ──`);
  for (const s of skipped) console.log(`  ${s.t.padEnd(26)} ${String(s.rows).padStart(7)}행  ${s.reason}`);
}

if (!APPLY) {
  console.log('\n✔ DRY-RUN 종료 — 아무것도 변경하지 않았습니다. 적용하려면 --apply');
  db.close();
  process.exit(0);
}

// ── 5) 적용 (단일 트랜잭션) ─────────────────────────────────────────────────
let totalRows = 0;
const perTable = [];
db.exec('BEGIN');
try {
  for (const p of plan) {
    const guard = `${p.scope}
                    AND "${p.c}" IS NOT NULL
                    AND typeof("${p.c}") = 'text'
                    AND datetime("${p.c}") IS NOT NULL`;
    const isUniq = uniqueColsOf(p.t).has(p.c);
    let changes;
    if (isUniq) {
      // 2단계: 먼 미래로 대피 → 되돌리기. 이동 순서에 따른 일시적 UNIQUE 충돌 회피.
      db.prepare(`UPDATE "${p.t}" SET "${p.c}" = ${shiftExpr(p.c, OFFSET + PARK_DAYS)} WHERE ${guard}`).run();
      const back = db.prepare(`UPDATE "${p.t}" SET "${p.c}" = ${shiftExpr(p.c, -PARK_DAYS)} WHERE ${guard}`).run();
      changes = back.changes;
      // 대피지에 남은 행이 있으면(=진짜 중복) 즉시 실패시켜 전체 롤백한다. 조용한 오염 방지.
      const stuck = db.prepare(
        `SELECT COUNT(*) c FROM "${p.t}" WHERE ${p.scope} AND "${p.c}" > '2100-01-01'`
      ).get().c;
      if (stuck) throw new Error(`${p.t}.${p.c}: 되돌리기 실패 ${stuck}행(진짜 UNIQUE 중복) — 롤백`);
    } else {
      changes = db.prepare(`UPDATE "${p.t}" SET "${p.c}" = ${shiftExpr(p.c, OFFSET)} WHERE ${guard}`).run().changes;
    }
    totalRows += changes;
    perTable.push({ t: p.t, c: p.c, changes, twoPhase: isUniq });
  }

  // 5-b) JSON 안에 박힌 타임스탬프도 함께 이동 (컬럼과 desync 방지)
  //      xAPI statement 의 $.timestamp 는 ISO8601Z 형식.
  for (const [t, jc] of [['learning_logs', 'statement_json'], ['xapi_statement_spool', 'statement_json']]) {
    const names = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    if (!names.includes(jc)) continue;
    const scope = names.includes('is_seed') ? 'is_seed = 1' : `user_id IN ${SEED_USERS_SQL}`;
    const r = db.prepare(
      `UPDATE "${t}"
          SET "${jc}" = json_set("${jc}", '$.timestamp',
                strftime('%Y-%m-%dT%H:%M:%fZ', json_extract("${jc}", '$.timestamp'), '+${OFFSET} days'))
        WHERE ${scope}
          AND "${jc}" IS NOT NULL
          AND json_valid("${jc}")
          AND json_extract("${jc}", '$.timestamp') IS NOT NULL
          AND datetime(json_extract("${jc}", '$.timestamp')) IS NOT NULL`
    ).run();
    if (r.changes) perTable.push({ t, c: `${jc}:$.timestamp`, changes: r.changes });
    totalRows += r.changes;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\n✖ 실패 — 전체 롤백했습니다:', e.message);
  db.close();
  process.exit(1);
}

// ── 6) 후 상태 + 불변식 검사 ────────────────────────────────────────────────
const after = snap();
console.log(`\n✔ 적용 완료: ${totalRows.toLocaleString()}행 이동 (+${OFFSET}일)`);
console.log('\n── 전/후 ──');
console.log(`  시드 최신일 : ${before.seedMax}  →  ${after.seedMax}   (오늘 ${today})`);
console.log(`  실 최신일   : ${before.realMax}  →  ${after.realMax}   ← 불변이어야 함`);
console.log(`  실 최초일   : ${before.realMin}  →  ${after.realMin}   ← 불변이어야 함`);
console.log(`  실 행수     : ${before.realCnt}  →  ${after.realCnt}    ← 불변이어야 함`);

const ok = before.realMax === after.realMax && before.realMin === after.realMin
        && before.realCnt === after.realCnt && before.realSum === after.realSum;
console.log(`\n  is_seed=0 무변경 검증(행수·최소·최대·타임스탬프 총합): ${ok ? '✔ PASS' : '✖ FAIL'}`);

const future = db.prepare(
  `SELECT COUNT(*) c, MAX(DATE(created_at)) m FROM learning_logs WHERE ${SEED_LOG_SCOPE} AND DATE(created_at) > DATE('now','localtime')`
).get();
if (future.c) {
  console.log(`\n  ⚠ 미래 일자 시드 로그 ${future.c.toLocaleString()}건 (최대 ${future.m}).`);
  console.log('    오프셋이 7의 배수라 오늘에 정확히 안 떨어질 때 생기는 잔여입니다.');
  console.log(`    보수적으로 가려면 --days ${OFFSET - 7} (미래 0, 대신 최신일이 오늘보다 이릅니다).`);
}
db.close();
if (!ok) process.exit(1);
