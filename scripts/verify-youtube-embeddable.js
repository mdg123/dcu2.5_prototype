require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// hqdefault.jpg 200이라도 oembed 차단된 영상이 있음 (임베드 불가)
// oembed API로 한 번 더 검증해 embeddable=false 인 영상도 inactive 마킹
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('./data/dacheum.db');
const cachePath = path.join(__dirname, 'dead-youtube-ids.json');

const items = db.prepare(`
  SELECT DISTINCT c.id, c.content_url FROM daily_learning_items i
  JOIN contents c ON c.id = i.content_id
  JOIN daily_learning_sets s ON s.id = i.set_id
  WHERE s.target_date BETWEEN '2026-04-01' AND '2026-05-31'
    AND c.content_type='video' AND c.content_url LIKE '%youtube%' AND c.status='approved'
`).all();

console.log('대상 영상:', items.length);

async function checkEmbed(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.ok;
  } catch (e) { return false; }
}

async function processInBatches(arr, batchSize, fn) {
  const results = [];
  for (let i = 0; i < arr.length; i += batchSize) {
    const batch = arr.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if ((i + batch.length) % 50 === 0 || i + batch.length === arr.length) {
      console.log(`  진행: ${i + batch.length} / ${arr.length}`);
    }
  }
  return results;
}

(async () => {
  const checks = items.map(it => {
    const m = it.content_url.match(/(?:v=|embed\/)([\w-]{11})/);
    return { id: it.id, vid: m ? m[1] : null, url: it.content_url };
  }).filter(c => c.vid);

  const results = await processInBatches(checks, 20, async (c) => {
    const embed = await checkEmbed(c.vid);
    return { ...c, embed };
  });

  const dead = results.filter(r => !r.embed);
  console.log('\n=== 결과 ===');
  console.log('  embeddable:', results.length - dead.length);
  console.log('  임베드 차단:', dead.length);

  if (dead.length > 0) {
    const ids = dead.map(d => d.id);
    const placeholders = ids.map(() => '?').join(',');
    const r = db.prepare(`UPDATE contents SET status='rejected' WHERE id IN (${placeholders})`).run(...ids);
    console.log('  contents 마킹:', r.changes);

    // daily_learning_items 정리
    db.pragma('foreign_keys = OFF');
    const rItems = db.prepare(`DELETE FROM daily_learning_items WHERE content_id IN (${placeholders})`).run(...ids);
    console.log('  items 정리:', rItems.changes);
    db.pragma('foreign_keys = ON');

    // 캐시 업데이트
    let cache = [];
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) {}
    const newCache = Array.from(new Set([...cache, ...dead.map(d => d.vid)]));
    fs.writeFileSync(cachePath, JSON.stringify(newCache, null, 2));
    console.log('  캐시 업데이트:', cache.length, '→', newCache.length);
  }
})();
