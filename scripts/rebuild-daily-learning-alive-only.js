require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * scripts/rebuild-daily-learning-alive-only.js
 *
 * "오늘의 학습 4~5월" 데이터를 살아있는 YouTube 영상만으로 재구성.
 *
 * 절차:
 *   [A] verify-youtube-alive (실측 또는 캐시) 결과로 죽은 영상의 contents.status를 'inactive'로 마킹
 *   [B] 2026-04-01 ~ 2026-05-31 기간 / title LIKE '%오늘의 학습 (수학)' 인 세트의
 *       daily_learning_progress / daily_learning_items / daily_learning_sets 전부 삭제
 *   [C] seed-daily-learning-apr-may.js (초3~6)  + seed-daily-learning-middle-high.js (중1~고1)
 *       순차 실행 (status='approved'만 select → 죽은 영상 자동 제외)
 *
 * 옵션:
 *   --use-cache    : dead-youtube-ids.json 캐시 사용 (검증 스킵)
 *   --skip-verify  : 검증/마킹 단계 스킵 (이미 마킹 완료된 경우)
 *   --dry          : 단계별 카운트만 보고, 변경 없음
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dacheum.db');

const args = process.argv.slice(2);
const opts = {
  useCache: args.includes('--use-cache'),
  skipVerify: args.includes('--skip-verify'),
  dry: args.includes('--dry'),
};

function runNode(script, extraArgs = []) {
  console.log(`\n─── 실행: node ${script} ${extraArgs.join(' ')} ───`);
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...extraArgs], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (r.status !== 0) throw new Error(`script failed: ${script}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  오늘의 학습 4~5월 — 살아있는 영상만으로 재구성');
  console.log('═══════════════════════════════════════════════════════');
  console.log('옵션:', opts);

  // ─── [A] 검증 + inactive 마킹 + 죽은 items 제거 ───
  if (!opts.skipVerify) {
    const verifyArgs = [];
    if (opts.useCache) verifyArgs.push('--use-cache');
    if (opts.dry) verifyArgs.push('--dry');
    runNode('scripts/verify-youtube-alive.js', verifyArgs);
  } else {
    console.log('\n[A] 검증/마킹 스킵 (--skip-verify)');
  }

  if (opts.dry) {
    console.log('\n[B/C] dry — 삭제·재시드 스킵');
    return;
  }

  // ─── [B] 4~5월 세트 삭제 ───
  console.log('\n─────────────────────────────────────────');
  console.log('  [B] 4~5월 "오늘의 학습 (수학)" 세트 전체 삭제');
  console.log('─────────────────────────────────────────');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const tx = db.transaction(() => {
    // 1. 대상 set_id 수집
    const sets = db
      .prepare(
        `SELECT id FROM daily_learning_sets
         WHERE target_date BETWEEN '2026-04-01' AND '2026-05-31'
           AND title LIKE '%오늘의 학습 (수학)'`
      )
      .all();
    const setIds = sets.map((s) => s.id);
    console.log(`  대상 세트: ${setIds.length}개`);
    if (!setIds.length) return { sets: 0, items: 0, progress: 0 };
    const ph = setIds.map(() => '?').join(',');

    // 2. items 수집
    const items = db.prepare(`SELECT id FROM daily_learning_items WHERE set_id IN (${ph})`).all(...setIds);
    const itemIds = items.map((i) => i.id);

    // 3. progress 삭제
    let progressDel = 0;
    if (itemIds.length) {
      const iph = itemIds.map(() => '?').join(',');
      const r = db.prepare(`DELETE FROM daily_learning_progress WHERE item_id IN (${iph})`).run(...itemIds);
      progressDel = r.changes;
    }

    // 4. items 삭제
    const ri = db.prepare(`DELETE FROM daily_learning_items WHERE set_id IN (${ph})`).run(...setIds);

    // 5. sets 삭제
    const rs = db.prepare(`DELETE FROM daily_learning_sets WHERE id IN (${ph})`).run(...setIds);

    console.log(`  - progress 삭제: ${progressDel}건`);
    console.log(`  - items 삭제: ${ri.changes}건`);
    console.log(`  - sets 삭제: ${rs.changes}건`);
    return { sets: rs.changes, items: ri.changes, progress: progressDel };
  });
  const delResult = tx();
  db.close();

  // ─── [C] 재시드 ───
  console.log('\n─────────────────────────────────────────');
  console.log('  [C] 재시드 — 살아있는 영상만 (status=approved)');
  console.log('─────────────────────────────────────────');
  runNode('scripts/seed-daily-learning-apr-may.js');
  runNode('scripts/seed-daily-learning-middle-high.js');

  // ─── 사후 검증 ───
  console.log('\n─────────────────────────────────────────');
  console.log('  사후 검증');
  console.log('─────────────────────────────────────────');
  const db2 = new Database(DB_PATH, { readonly: true });
  const total = db2
    .prepare(
      `SELECT COUNT(*) AS n FROM daily_learning_sets
       WHERE target_date BETWEEN '2026-04-01' AND '2026-05-31'
         AND title LIKE '%오늘의 학습 (수학)'`
    )
    .get();
  const byGrade = db2
    .prepare(
      `SELECT target_grade, COUNT(*) AS n FROM daily_learning_sets
       WHERE target_date BETWEEN '2026-04-01' AND '2026-05-31'
         AND title LIKE '%오늘의 학습 (수학)'
       GROUP BY target_grade ORDER BY target_grade`
    )
    .all();
  console.log(`재시드된 세트: ${total.n}개`);
  console.log(`학년별:`);
  byGrade.forEach((r) => console.log(`  target_grade=${r.target_grade}: ${r.n}개`));

  // 죽은 영상이 items에 남아있는지 더블체크
  const rejectedCount = db2
    .prepare(`SELECT COUNT(*) AS n FROM contents WHERE status='rejected' AND content_type='video'`)
    .get();
  console.log(`rejected video contents (죽은 영상 포함): ${rejectedCount.n}개`);

  const leakItems = db2
    .prepare(
      `SELECT COUNT(*) AS n FROM daily_learning_items i
       JOIN contents c ON c.id = i.content_id
       WHERE c.status != 'approved'`
    )
    .get();
  console.log(`approved가 아닌 contents를 참조하는 daily_learning_items: ${leakItems.n}개 (0이어야 함)`);

  db2.close();
  console.log('\n완료.');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
