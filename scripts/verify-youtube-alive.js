/**
 * scripts/verify-youtube-alive.js
 *
 * contents 테이블의 모든 YouTube 영상 URL을 HTTP HEAD로 검증.
 * - 응답 코드 4xx (특히 404)면 죽은 영상
 * - 결과를 scripts/dead-youtube-ids.json 에 저장
 * - 죽은 영상의 contents.status 를 'rejected' 로 마킹
 *   (CHECK 제약: status IN ('draft','pending','review','hold','approved','rejected') — 'inactive' 미허용,
 *    'rejected'로 마킹해도 시드 스크립트가 status='approved' 만 select 하므로 동일 효과)
 * - daily_learning_items 에서 죽은 영상을 가리키는 행 제거
 *
 * 옵션:
 *   --dry          : DB 변경 없이 검증만
 *   --use-cache    : 기존 dead-youtube-ids.json 캐시 사용 (검증 스킵)
 *   --no-mark      : 검증만 하고 status/items 업데이트 스킵
 *   --concurrency=20
 *
 * 실행: node scripts/verify-youtube-alive.js
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const CACHE_PATH = path.join(__dirname, 'dead-youtube-ids.json');

const args = process.argv.slice(2);
const opts = {
  dry: args.includes('--dry'),
  useCache: args.includes('--use-cache'),
  noMark: args.includes('--no-mark'),
  concurrency: 20,
};
const concArg = args.find(a => a.startsWith('--concurrency='));
if (concArg) opts.concurrency = parseInt(concArg.split('=')[1], 10) || 20;

function extractVideoId(url) {
  if (!url) return null;
  const m1 = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = url.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (m2) return m2[1];
  const m3 = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m3) return m3[1];
  const m4 = url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (m4) return m4[1];
  return null;
}

// HEAD 요청 (img.youtube.com)
function checkVideoAlive(videoId) {
  return new Promise((resolve) => {
    const url = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const req = https.request(
      url,
      {
        method: 'HEAD',
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Accept: 'image/avif,image/webp,*/*',
        },
      },
      (res) => {
        // 404 = 죽음. 200 = 살아있음. 다른 코드는 일단 살아있다고 보되 기록.
        resolve({ videoId, status: res.statusCode, alive: res.statusCode === 200 });
        res.resume();
      }
    );
    req.on('error', (err) => {
      resolve({ videoId, status: 0, alive: false, error: err.code || err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ videoId, status: 0, alive: false, error: 'TIMEOUT' });
    });
    req.end();
  });
}

async function runInChunks(items, concurrency, worker, onProgress) {
  const results = [];
  let idx = 0;
  let done = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      const r = await worker(items[cur], cur);
      results[cur] = r;
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  YouTube 영상 살아있음 검증 + inactive 마킹');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`옵션:`, opts);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 1. 모든 video contents 로드 (youtube/youtu.be 둘 다 + null/example.com 등 부적격도 포함해 정리)
  const rows = db
    .prepare(
      `SELECT id, content_url, status
       FROM contents
       WHERE content_type='video'`
    )
    .all();

  console.log(`\n[1] video 행 전체: ${rows.length}개`);

  // video_id 추출 + 행 매핑. youtube가 아니거나 url null인 행은 'invalid'로 분류.
  const items = []; // 검증 대상 (실제 youtube)
  const invalidRows = []; // url null 또는 youtube가 아닌 행 → 죽은 영상으로 취급
  for (const r of rows) {
    const url = r.content_url || '';
    const isYT = /youtube\.com|youtu\.be/i.test(url);
    if (!isYT) {
      invalidRows.push({ contentId: r.id, status: r.status, url, reason: url ? 'NOT_YOUTUBE' : 'NULL_URL' });
      continue;
    }
    const vid = extractVideoId(url);
    if (vid) items.push({ contentId: r.id, videoId: vid, status: r.status, url });
    else invalidRows.push({ contentId: r.id, status: r.status, url, reason: 'NO_VIDEO_ID' });
  }
  console.log(`  - YouTube video_id 추출 성공(검증 대상): ${items.length}개`);
  console.log(`  - 부적격(url null/non-youtube/추출 실패): ${invalidRows.length}개 — 죽은 영상 처리`);

  // 중복 video_id 통계
  const byVid = new Map();
  items.forEach((it) => {
    if (!byVid.has(it.videoId)) byVid.set(it.videoId, []);
    byVid.get(it.videoId).push(it);
  });
  console.log(`  - 고유 video_id 수: ${byVid.size}개`);

  // 2. 검증 (또는 캐시 로드)
  let deadVideoIds;
  if (opts.useCache && fs.existsSync(CACHE_PATH)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    deadVideoIds = new Set(cache.deadVideoIds);
    console.log(`\n[2] 캐시 사용 — dead: ${deadVideoIds.size}개 (검증 스킵)`);
  } else {
    console.log(`\n[2] HTTP HEAD 검증 시작 (동시 ${opts.concurrency}개)...`);
    const t0 = Date.now();
    const uniqueIds = Array.from(byVid.keys());
    const results = await runInChunks(uniqueIds, opts.concurrency, checkVideoAlive, (done, total) => {
      const pct = ((done / total) * 100).toFixed(1);
      process.stdout.write(`  진행: ${done}/${total} (${pct}%)\r`);
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n  완료. 소요시간 ${elapsed}s`);

    const dead = results.filter((r) => !r.alive);
    const alive = results.filter((r) => r.alive);
    deadVideoIds = new Set(dead.map((r) => r.videoId));

    console.log(`  - 살아있음: ${alive.length}개`);
    console.log(`  - 죽음: ${dead.length}개`);

    // 상태별 집계
    const byStatus = {};
    dead.forEach((r) => {
      const k = r.error || r.status;
      byStatus[k] = (byStatus[k] || 0) + 1;
    });
    console.log(`  - 죽음 상태별:`, byStatus);

    // 캐시 저장
    const cachePayload = {
      generatedAt: new Date().toISOString(),
      total: uniqueIds.length,
      alive: alive.length,
      dead: dead.length,
      errors: dead.filter((r) => r.error).length,
      deadVideoIds: Array.from(deadVideoIds),
      deadDetails: dead.map((d) => ({
        videoId: d.videoId,
        status: d.status,
        error: d.error || null,
      })),
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cachePayload, null, 2), 'utf8');
    console.log(`  - 캐시 저장: ${CACHE_PATH}`);
  }

  // 3. 죽은 영상에 매핑되는 contents.id 수집 + 부적격 행도 포함
  const deadContentIds = [];
  for (const it of items) {
    if (deadVideoIds.has(it.videoId)) deadContentIds.push(it.contentId);
  }
  console.log(`\n[3] 죽은 video_id에 매핑되는 contents 행: ${deadContentIds.length}개`);
  for (const inv of invalidRows) {
    deadContentIds.push(inv.contentId);
  }
  console.log(`  + 부적격 video contents: ${invalidRows.length}개 → 합계: ${deadContentIds.length}개`);

  // 죽은 영상이지만 이미 inactive/rejected 인 것 제외
  const stmtStatusByIds = (ids) => {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id, status FROM contents WHERE id IN (${ph})`).all(...ids);
  };
  const curStatus = stmtStatusByIds(deadContentIds);
  const grouped = curStatus.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`  - 현재 status 분포:`, grouped);

  // 'rejected' 사용 (CHECK 제약: 'inactive' 미허용)
  const DEAD_STATUS = 'rejected';
  const toInactivate = curStatus.filter((r) => r.status !== DEAD_STATUS).map((r) => r.id);
  console.log(`  - ${DEAD_STATUS} 마킹 대상: ${toInactivate.length}개`);

  // 4. daily_learning_items 영향
  let affectedItems = 0;
  if (deadContentIds.length) {
    const ph = deadContentIds.map(() => '?').join(',');
    affectedItems = db
      .prepare(`SELECT COUNT(*) AS n FROM daily_learning_items WHERE content_id IN (${ph})`)
      .get(...deadContentIds).n;
  }
  console.log(`  - 영향 받는 daily_learning_items: ${affectedItems}개`);

  // 5. 적용
  if (opts.dry || opts.noMark) {
    console.log(`\n[5] dry/no-mark 옵션 — DB 변경 스킵`);
  } else {
    console.log(`\n[5] DB 업데이트...`);
    const tx = db.transaction(() => {
      // 5-1. contents.status = 'rejected' (dead 영상 마킹)
      if (toInactivate.length) {
        const ph = toInactivate.map(() => '?').join(',');
        const r1 = db
          .prepare(`UPDATE contents SET status='${DEAD_STATUS}' WHERE id IN (${ph})`)
          .run(...toInactivate);
        console.log(`  - contents ${DEAD_STATUS} 마킹: ${r1.changes}건`);
      }

      // 5-2. daily_learning_progress 먼저 정리 (FK)
      if (deadContentIds.length) {
        const ph = deadContentIds.map(() => '?').join(',');
        const pr = db
          .prepare(
            `DELETE FROM daily_learning_progress
             WHERE item_id IN (
               SELECT id FROM daily_learning_items WHERE content_id IN (${ph})
             )`
          )
          .run(...deadContentIds);
        console.log(`  - daily_learning_progress 삭제: ${pr.changes}건`);

        const r2 = db
          .prepare(`DELETE FROM daily_learning_items WHERE content_id IN (${ph})`)
          .run(...deadContentIds);
        console.log(`  - daily_learning_items 삭제: ${r2.changes}건`);
      }
    });
    tx();
    console.log(`  완료.`);
  }

  // 6. 보고
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  보고`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`총 YouTube 영상 행: ${rows.length}`);
  console.log(`고유 video_id: ${byVid.size}`);
  console.log(`죽은 video_id: ${deadVideoIds.size}`);
  console.log(`매핑된 죽은 contents 행: ${deadContentIds.length}`);
  console.log(`rejected 마킹: ${opts.dry || opts.noMark ? '스킵' : toInactivate.length + '건'}`);
  console.log(`items 영향: ${affectedItems}건`);

  db.close();
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
