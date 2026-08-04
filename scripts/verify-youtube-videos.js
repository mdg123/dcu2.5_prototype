require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * verify-youtube-videos.js
 *
 * contents 테이블의 YouTube 영상이 외부에서 살아있는지 일괄 검증.
 * 죽은 영상(404 등)은 scripts/dead-youtube-ids.json 에 캐시.
 *
 * 사용:
 *   node scripts/verify-youtube-videos.js              # 검증만
 *   node scripts/verify-youtube-videos.js --mark       # 검증 + DB inactive 마킹
 *   node scripts/verify-youtube-videos.js --use-cache  # 캐시 파일 재사용 (검증 스킵)
 *
 * 검증 방법: i.ytimg.com/vi/<id>/hqdefault.jpg 에 HEAD 요청.
 * 404 → 영상 삭제됨. 120 / 90px 더미 이미지일 수도 있어 default.jpg 도 보조 확인.
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const CACHE_PATH = path.join(__dirname, 'dead-youtube-ids.json');
const CONCURRENCY = 20;
const REQUEST_TIMEOUT_MS = 10000;

function extractVideoId(url) {
  if (!url) return null;
  // /embed/<id>
  let m = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  // youtu.be/<id>
  m = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  // ?v=<id>
  m = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  return null;
}

function headThumb(videoId) {
  return new Promise((resolve) => {
    const url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const req = https.request(url, { method: 'HEAD', timeout: REQUEST_TIMEOUT_MS }, (res) => {
      // 200 = 살아있음, 404 = 삭제, 302 따라가지 않음
      // YouTube는 hqdefault가 없으면 404 응답
      resolve({ videoId, status: res.statusCode, contentLength: parseInt(res.headers['content-length'] || '0', 10) });
      res.resume();
    });
    req.on('error', (err) => resolve({ videoId, status: 0, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ videoId, status: 0, error: 'TIMEOUT' }); });
    req.end();
  });
}

async function pool(items, worker, concurrency, onProgress) {
  let idx = 0;
  let done = 0;
  const results = new Array(items.length);
  async function runOne() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const doMark = args.includes('--mark');
  const useCache = args.includes('--use-cache');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const rows = db.prepare(`
    SELECT id, content_url FROM contents
    WHERE content_type='video' AND status='approved'
      AND (content_url LIKE '%youtube.com%' OR content_url LIKE '%youtu.be%')
  `).all();
  console.log(`[verify] 검증 대상 영상: ${rows.length}개`);

  // video_id -> [contentId, ...]
  const idMap = new Map();
  const skipped = [];
  for (const r of rows) {
    const vid = extractVideoId(r.content_url);
    if (!vid) { skipped.push(r); continue; }
    if (!idMap.has(vid)) idMap.set(vid, []);
    idMap.get(vid).push(r.id);
  }
  console.log(`[verify] 추출된 고유 video_id: ${idMap.size}개 (URL 파싱 실패: ${skipped.length}개)`);
  if (skipped.length) {
    console.log('[verify] 파싱 실패 샘플:', skipped.slice(0, 3));
  }

  const uniqueIds = Array.from(idMap.keys());

  let dead = [];
  let alive = [];
  let errors = [];

  if (useCache && fs.existsSync(CACHE_PATH)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    dead = cached.deadVideoIds || [];
    console.log(`[verify] 캐시 사용: 죽은 영상 ${dead.length}개 (검증 스킵)`);
  } else {
    console.log(`[verify] 병렬 ${CONCURRENCY}개로 HEAD 요청 시작...`);
    const t0 = Date.now();
    let lastLogged = 0;
    const results = await pool(uniqueIds, headThumb, CONCURRENCY, (done, total) => {
      if (done - lastLogged >= 50 || done === total) {
        lastLogged = done;
        const pct = Math.round((done / total) * 100);
        process.stdout.write(`  ${done}/${total} (${pct}%)\r`);
      }
    });
    console.log('');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[verify] HEAD 완료 (${elapsed}s)`);

    for (const r of results) {
      if (r.status === 200) {
        alive.push(r.videoId);
      } else if (r.status === 404) {
        dead.push(r.videoId);
      } else {
        errors.push(r);
      }
    }

    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: uniqueIds.length,
      alive: alive.length,
      dead: dead.length,
      errors: errors.length,
      deadVideoIds: dead,
      errorSample: errors.slice(0, 10),
    }, null, 2), 'utf-8');
    console.log(`[verify] 캐시 저장: ${CACHE_PATH}`);
  }

  console.log('');
  console.log('=== 검증 결과 ===');
  console.log(`  살아있음: ${alive.length}`);
  console.log(`  죽음(404): ${dead.length}`);
  console.log(`  에러/타임아웃: ${errors.length}`);

  // 죽은 video_id → contents.id 목록
  const deadContentIds = [];
  for (const vid of dead) {
    const ids = idMap.get(vid) || [];
    deadContentIds.push(...ids);
  }
  console.log(`  영향받는 contents.id 수: ${deadContentIds.length}`);

  if (doMark && deadContentIds.length > 0) {
    console.log('');
    console.log('=== rejected 마킹 (reject_reason=youtube_deleted) ===');
    // contents.status CHECK 제약: draft/pending/review/hold/approved/rejected
    // → 'rejected' + reject_reason='youtube_deleted' 로 외부 삭제 사실 기록
    const placeholders = deadContentIds.map(() => '?').join(',');
    const result = db.prepare(
      `UPDATE contents SET status='rejected', reject_reason='youtube_deleted' WHERE id IN (${placeholders})`
    ).run(...deadContentIds);
    console.log(`  UPDATE 결과: ${result.changes}건 변경`);
  } else if (deadContentIds.length > 0) {
    console.log('');
    console.log('[verify] DB 마킹은 생략 (--mark 옵션 미지정)');
  }

  db.close();
  return { aliveCount: alive.length, deadCount: dead.length, errorCount: errors.length, deadContentIds };
}

main().catch((err) => {
  console.error('[verify] 실패:', err);
  process.exit(1);
});
