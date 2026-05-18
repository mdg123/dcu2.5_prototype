/**
 * scripts/verify-seeded-items-alive.js
 *
 * 재시드된 4~5월 daily_learning_items 가 가리키는 영상의 URL을 HTTP HEAD로 재검증.
 * - 학년별 sample N개 세트 × 모든 video item
 * - alive 가 100% 가 아니면 죽은 영상 목록 출력
 *
 * 사용: node scripts/verify-seeded-items-alive.js [--sample=5]
 */
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');

const args = process.argv.slice(2);
const sampleArg = args.find((a) => a.startsWith('--sample='));
const SAMPLE = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : 5;

function extractVideoId(url) {
  if (!url) return null;
  const m1 = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = url.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (m2) return m2[1];
  const m3 = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m3) return m3[1];
  return null;
}

function checkAlive(videoId) {
  return new Promise((resolve) => {
    const url = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const req = https.request(
      url,
      {
        method: 'HEAD',
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 dacheum-verify' },
      },
      (res) => {
        resolve({ videoId, status: res.statusCode, alive: res.statusCode === 200 });
        res.resume();
      }
    );
    req.on('error', () => resolve({ videoId, status: 0, alive: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ videoId, status: 0, alive: false });
    });
    req.end();
  });
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  // 학년별 sample 세트
  const grades = [3, 4, 5, 6, 7, 8, 9, 10];
  const sampleSets = [];
  for (const g of grades) {
    const sets = db
      .prepare(
        `SELECT id, title, target_date FROM daily_learning_sets
         WHERE target_grade=? AND target_date BETWEEN '2026-04-01' AND '2026-05-31'
           AND title LIKE '%오늘의 학습 (수학)'
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(g, SAMPLE);
    sampleSets.push(...sets.map((s) => ({ ...s, target_grade: g })));
  }

  console.log(`샘플 세트 수: ${sampleSets.length} (학년당 ${SAMPLE})`);

  // 모든 sample 세트의 video items 추출
  const setIds = sampleSets.map((s) => s.id);
  const ph = setIds.map(() => '?').join(',');
  const items = db
    .prepare(
      `SELECT i.id AS item_id, i.set_id, i.item_title, c.id AS content_id,
              c.content_url, c.content_type, c.status
       FROM daily_learning_items i
       JOIN contents c ON c.id = i.content_id
       WHERE i.set_id IN (${ph})
         AND c.content_type='video'`
    )
    .all(...setIds);

  console.log(`검증할 video item 수: ${items.length}`);

  const results = [];
  const seen = new Map(); // videoId -> result (캐시)
  for (const it of items) {
    const vid = extractVideoId(it.content_url);
    if (!vid) {
      results.push({ ...it, videoId: null, alive: false, reason: 'NO_VIDEO_ID' });
      continue;
    }
    let r = seen.get(vid);
    if (!r) {
      r = await checkAlive(vid);
      seen.set(vid, r);
    }
    results.push({ ...it, videoId: vid, alive: r.alive, status: r.status });
  }

  const alive = results.filter((r) => r.alive).length;
  const dead = results.filter((r) => !r.alive);

  console.log(`\n결과: ${alive}/${results.length} alive`);
  if (dead.length) {
    console.log('\n죽은 영상 목록:');
    dead.forEach((d) =>
      console.log(`  set_id=${d.set_id} item=${d.item_title} content_id=${d.content_id} videoId=${d.videoId} status=${d.status} contents.status=${d.status}`)
    );
  } else {
    console.log('모든 sample 영상이 살아있음.');
  }

  // 학년별 alive 비율
  const byGrade = {};
  results.forEach((r) => {
    const set = sampleSets.find((s) => s.id === r.set_id);
    if (!set) return;
    const g = set.target_grade;
    if (!byGrade[g]) byGrade[g] = { total: 0, alive: 0 };
    byGrade[g].total++;
    if (r.alive) byGrade[g].alive++;
  });
  console.log('\n학년별 alive 비율:');
  Object.entries(byGrade)
    .sort((a, b) => a[0] - b[0])
    .forEach(([g, v]) => console.log(`  grade=${g}: ${v.alive}/${v.total}`));

  db.close();
}

main().catch(console.error);
