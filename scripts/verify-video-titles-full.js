require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * verify-video-titles-full.js
 * daily_learning_items에 연결된 모든 YouTube 영상의 제목을 oEmbed로 확인하여
 * DB 저장 제목과 비교. 유사도 20% 미만 = 가짜 매핑.
 *
 * 옵션:
 *   --mark   : 가짜 영상의 contents.status를 'rejected'로 마킹 + reject_reason='wrong_content'
 *              + daily_learning_items에서 해당 행 삭제
 *   --json   : 결과를 dead-titles.json에 저장
 */

const Database = require('better-sqlite3');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const CACHE_PATH = path.join(__dirname, 'dead-titles.json');

const args = process.argv.slice(2);
const DO_MARK = args.includes('--mark');
const DO_JSON = args.includes('--json');
const USE_CACHE = args.includes('--use-cache');

function extractYtId(url) {
  if (!url) return null;
  let m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/embed\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

function getOembed(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, data: JSON.parse(body) }); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

// 한국어 단어 기반 유사도
function similarity(a, b) {
  const norm = s => s.toLowerCase().replace(/[^\w가-힣\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const wordsA = norm(a);
  const wordsB = norm(b);
  if (!wordsA.length || !wordsB.length) return 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / Math.max(setA.size, setB.size);
}

// 수학 교육 관련 키워드 (가짜 판별 보조) — 단일 글자 키워드는 false positive 유발하므로 2자 이상만
const EDU_KEYWORDS = ['수학','분수','소수','덧셈','뺄셈','곱셈','나눗셈','도형','각도','삼각형','사각형','원기둥','원뿔',
  '비율','자료','그래프','평균','측정','길이','무게','부피','넓이','자연수','정수','유리수','함수',
  '방정식','부등식','확률','통계','입체','대칭','합동','다각형','초등','중학','고등','단원','학기','학년','풀이','문제',
  '미적분','벡터','다항식','이차식','부피','넓이','지수','로그','수열','수열의'];

async function pool(items, worker, concurrency = 10, onProgress) {
  let idx = 0;
  let done = 0;
  const results = new Array(items.length);
  async function runOne() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (onProgress && (done % 10 === 0 || done === items.length)) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()));
  return results;
}

async function main() {
  const db = new Database(DB_PATH);

  const rows = db.prepare(`
    SELECT DISTINCT c.id, c.title AS db_title, c.content_url, c.grade
    FROM daily_learning_items i
    JOIN contents c ON c.id = i.content_id
    WHERE c.content_type = 'video'
      AND c.status = 'approved'
      AND (c.content_url LIKE '%youtube%' OR c.content_url LIKE '%youtu.be%')
    ORDER BY c.id
  `).all();

  console.log(`검증 대상 영상: ${rows.length}개\n`);

  let cache = {};
  if (USE_CACHE && fs.existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
    catch {}
    console.log(`캐시 사용: ${Object.keys(cache).length}건\n`);
  }

  const results = await pool(rows, async (row) => {
    const ytId = extractYtId(row.content_url);
    if (!ytId) return { ...row, status: 'no_id' };

    // 캐시는 oEmbed 결과(realTitle)만 활용. status는 현재 필터로 재평가.
    let realTitle = null;
    if (cache[ytId] && cache[ytId].realTitle != null) {
      realTitle = cache[ytId].realTitle;
    } else {
      const r = await getOembed(ytId);
      if (!r.ok) return { ...row, ytId, status: 'oembed_fail' };
      realTitle = (r.data && r.data.title) || '';
    }

    const sim = similarity(row.db_title, realTitle);
    const realHasEdu = EDU_KEYWORDS.some(k => realTitle.includes(k));
    const isFake = sim < 0.2 && !realHasEdu;
    return { ...row, ytId, realTitle, similarity: sim, realHasEdu, status: isFake ? 'fake' : 'ok' };
  }, 12, (done, total) => process.stdout.write(`  진행: ${done}/${total}\r`));
  console.log('');

  const fake = results.filter(r => r.status === 'fake');
  const ok = results.filter(r => r.status === 'ok');
  const failed = results.filter(r => r.status === 'oembed_fail' || r.status === 'no_id');

  console.log(`\n=== 결과 ===`);
  console.log(`  실제 매핑: ${ok.length}`);
  console.log(`  가짜 매핑: ${fake.length}`);
  console.log(`  확인 실패: ${failed.length}`);

  if (fake.length) {
    console.log(`\n--- 가짜 영상 목록 ---`);
    fake.forEach(f => {
      console.log(`  id=${f.id} grade=${f.grade} ytId=${f.ytId} 유사도=${(f.similarity*100).toFixed(0)}%`);
      console.log(`    DB: ${f.db_title}`);
      console.log(`    실제: ${f.realTitle}`);
    });
  }

  // 캐시 저장
  if (DO_JSON) {
    const newCache = { ...cache };
    for (const r of results) {
      if (r.ytId && (r.realTitle || r.status === 'oembed_fail')) {
        newCache[r.ytId] = { realTitle: r.realTitle, similarity: r.similarity, status: r.status };
      }
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(newCache, null, 2), 'utf8');
    console.log(`\n캐시 저장: ${CACHE_PATH} (${Object.keys(newCache).length}건)`);
  }

  if (DO_MARK && fake.length) {
    const ids = fake.map(f => f.id);
    const ph = ids.map(() => '?').join(',');
    const r1 = db.prepare(`UPDATE contents SET status='rejected', reject_reason='wrong_content' WHERE id IN (${ph})`).run(...ids);
    console.log(`\ncontents rejected: ${r1.changes}건`);

    // daily_learning_items 삭제
    const items = db.prepare(`SELECT id FROM daily_learning_items WHERE content_id IN (${ph})`).all(...ids);
    const itemIds = items.map(i => i.id);
    if (itemIds.length) {
      const iph = itemIds.map(() => '?').join(',');
      const rProgress = db.prepare(`DELETE FROM daily_learning_progress WHERE item_id IN (${iph})`).run(...itemIds);
      const rItems = db.prepare(`DELETE FROM daily_learning_items WHERE id IN (${iph})`).run(...itemIds);
      console.log(`daily_learning_progress 삭제: ${rProgress.changes}건`);
      console.log(`daily_learning_items 삭제: ${rItems.changes}건`);
    }
  }

  db.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
