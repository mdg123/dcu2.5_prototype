require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * build-aimap-videos-per-lesson.js
 *
 * AI 맞춤학습 — 차시별 영상 적재 (초4·5·6 + 중1·2·3).
 * 7개 JSON 파일을 통합 → contents INSERT + node_contents 매핑.
 *
 * 핵심: 같은 video_id가 여러 차시에 매핑된 경우 contents row는 1개만 생성하고
 *       node_contents에 차시별 매핑만 추가 (DB 효율).
 *
 * 사용법:
 *   node scripts/build-aimap-videos-per-lesson.js --dry-run
 *   node scripts/build-aimap-videos-per-lesson.js --apply
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const ADMIN_ID = 1;

// 파일별 (subject, grade) 매핑
const FILES = [
  { file: 'videos_g4math_per_lesson.json',         subject: '수학',   grade: 4, schoolLevel: 'elementary' },
  { file: 'videos_g5math_per_lesson.json',         subject: '수학',   grade: 5, schoolLevel: 'elementary' },
  { file: 'videos_g6math_per_lesson.json',         subject: '수학',   grade: 6, schoolLevel: 'elementary' },
  { file: 'videos_g7math_per_lesson_part1.json',   subject: '수학과', grade: 1, schoolLevel: 'middle' },
  { file: 'videos_g7math_per_lesson_part2.json',   subject: '수학과', grade: 1, schoolLevel: 'middle' },
  { file: 'videos_g8math_per_lesson.json',         subject: '수학과', grade: 2, schoolLevel: 'middle' },
  { file: 'videos_g9math_per_lesson.json',         subject: '수학과', grade: 3, schoolLevel: 'middle' },
];

const BASE = path.resolve(__dirname, '..', '작업지시서', '콘텐츠빌드');

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function findLatex(s) {
  if (s == null) return null;
  const str = String(s);
  const patterns = [/\$[^\$\n]*\$/, /\\frac\b/, /\\sqrt\b/, /\\times\b/, /\\div\b/, /\^\{/, /_\{/];
  for (const p of patterns) if (p.test(str)) return p.source;
  return null;
}

function main() {
  console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // 1) 모든 JSON 로드
  const allItems = [];
  let totalLessons = 0;
  for (const f of FILES) {
    const p = path.join(BASE, f.file);
    const arr = loadJson(p);
    if (!arr) { console.error('[ERR] missing:', f.file); return; }
    for (const it of arr) {
      // 차시별 매핑 형식: { node_id, video_id, title, channel, ... }
      if (!it.node_id || !it.video_id) {
        console.error('[ERR] invalid item in', f.file, '— node_id 또는 video_id 누락');
        return;
      }
      // LaTeX 흔적 검사
      const hit = findLatex(it.title) || findLatex(it.lesson_name);
      if (hit) {
        console.error('[ERR] LaTeX in', f.file, ':', it.video_id, hit);
        return;
      }
      allItems.push({
        ...it,
        subject: f.subject,
        grade: f.grade,
        schoolLevel: f.schoolLevel,
        video_url: it.video_url || `https://www.youtube.com/watch?v=${it.video_id}`,
        thumbnail_url: `https://img.youtube.com/vi/${it.video_id}/hqdefault.jpg`,
      });
    }
    totalLessons += arr.length;
  }

  // 2) 통계
  const uniqueVideos = new Set(allItems.map(it => it.video_id));
  console.log(`[loaded] 차시 ${totalLessons}, 고유 영상 ${uniqueVideos.size}`);

  if (DRY) {
    console.log('[dry-run] 검증 통과. --apply 로 적재.');
    return;
  }

  // 3) DB 적재
  const db = new Database(DB_PATH);

  const checkVideo = db.prepare(`
    SELECT id FROM contents WHERE content_type='video' AND content_url=? LIMIT 1
  `);
  const insContent = db.prepare(`
    INSERT INTO contents (
      creator_id, title, description, content_type, content_url, thumbnail_url,
      subject, grade, unit_name, school_level,
      tags, is_public, status, difficulty, copyright, allow_comments, source, created_at
    ) VALUES (?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, 1, 'approved', 2, 'YouTube', 1, 'youtube', datetime('now'))
  `);
  const insNodeContent = db.prepare(`
    INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, 'lecture', 0)
  `);
  const insCCN = db.prepare(`
    INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)
  `);

  // video_url → content_id 캐시
  const videoContentIdCache = new Map();
  let stats = { videoNew: 0, videoReused: 0, nodeMapped: 0 };

  const tx = db.transaction(() => {
    for (const it of allItems) {
      let contentId = videoContentIdCache.get(it.video_url);
      if (!contentId) {
        // DB에 이미 있는지
        const dup = checkVideo.get(it.video_url);
        if (dup) {
          contentId = dup.id;
          stats.videoReused++;
        } else {
          const tags = JSON.stringify([it.subject, `${it.grade}학년`, it.unit_name || '', '유튜브', it.channel || ''].filter(Boolean));
          const desc = `${it.subject} ${it.grade}학년 — ${it.lesson_name || ''} 강의. 채널: ${it.channel || '미상'}.`;
          const r = insContent.run(
            ADMIN_ID, it.title || it.lesson_name || '강의 영상',
            desc, it.video_url, it.thumbnail_url,
            it.subject, it.grade, it.unit_name || null, it.schoolLevel, tags
          );
          contentId = r.lastInsertRowid;
          stats.videoNew++;
        }
        videoContentIdCache.set(it.video_url, contentId);
      }
      insNodeContent.run(it.node_id, contentId);
      insCCN.run(contentId, it.node_id);
      stats.nodeMapped++;
    }
  });
  tx();

  console.log(`[APPLIED] 신규 영상: ${stats.videoNew}, 재사용: ${stats.videoReused}, 차시 매핑: ${stats.nodeMapped}`);

  // 검증
  const empty = db.prepare(`
    SELECT n.subject, n.grade, COUNT(*) c FROM learning_map_nodes n
    LEFT JOIN node_contents nc ON nc.node_id = n.node_id
    LEFT JOIN contents c ON c.id = nc.content_id AND c.content_type IN ('video','youtube')
    WHERE n.lesson_name IS NOT NULL
    GROUP BY n.subject, n.grade
    HAVING SUM(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END) = 0
  `).all();
  console.log('[verify] 영상 0건 학년:', empty.length === 0 ? '없음' : JSON.stringify(empty));

  db.close();
}

main();
