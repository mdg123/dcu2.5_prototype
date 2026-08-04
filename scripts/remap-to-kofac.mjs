import './_stamp-on-write.js'; // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * remap-to-kofac.mjs
 *
 * 기존 영상·문항 JSON의 node_id가 KOFAC v2와 다른 경우,
 * lesson_name·unit_name·achievement_code 기반으로 KOFAC v2 차시 ID를 찾아 재적재.
 *
 * 입력 JSON 종류:
 *  - videos_g*_per_lesson.json (각 항목 { node_id, lesson_name, video_id, title, channel, ... })
 *  - questions_g*math.json (각 항목 { node_id, lesson_name, unit_name, achievement_code, questions: [...] })
 *  - videos_g7math_video_only.json (보강)
 *
 * 매핑 키 우선순위:
 *  1. lesson_name + unit_name (정확 일치, 가장 안전)
 *  2. lesson_name + achievement_code
 *  3. lesson_name 단독 (마지막 fallback, 중복 위험)
 *
 * 사용법:
 *   node scripts/remap-to-kofac.mjs --target videos --dry-run
 *   node scripts/remap-to-kofac.mjs --target videos --apply
 *   node scripts/remap-to-kofac.mjs --target questions --apply
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TARGET = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;

console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}  target=${TARGET || 'all'}`);

const db = new Database('./data/dacheum.db');

// KOFAC v2 차시 인덱스 구축 (DB에서)
const kofacLessons = db.prepare(`
  SELECT node_id, subject, grade, semester, area, unit_name, lesson_name, achievement_code
  FROM learning_map_nodes WHERE lesson_name IS NOT NULL
`).all();

const byLessonUnit = {};      // lesson_name|unit_name → node_id[]
const byLessonAch = {};       // lesson_name|achievement_code → node_id[]
const byLesson = {};          // lesson_name → node_id[]
function normLesson(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

for (const l of kofacLessons) {
  const ln = normLesson(l.lesson_name);
  const un = String(l.unit_name || '').trim();
  const ac = String(l.achievement_code || '').trim();
  if (!ln) continue;
  const k1 = ln + '|' + un;
  const k2 = ln + '|' + ac;
  (byLessonUnit[k1] = byLessonUnit[k1] || []).push(l.node_id);
  if (ac) (byLessonAch[k2] = byLessonAch[k2] || []).push(l.node_id);
  (byLesson[ln] = byLesson[ln] || []).push(l.node_id);
}
console.log(`[index] KOFAC 차시 ${kofacLessons.length}건 인덱싱`);

function findKofacNode(item) {
  const ln = normLesson(item.lesson_name);
  const un = String(item.unit_name || '').trim();
  const ac = String(item.achievement_code || '').trim();
  if (!ln) return { id: null, reason: 'no-lesson' };
  // 1) lesson + unit
  const k1 = ln + '|' + un;
  if (byLessonUnit[k1]?.length === 1) return { id: byLessonUnit[k1][0], reason: 'lesson+unit' };
  // 2) lesson + ach
  if (ac) {
    const k2 = ln + '|' + ac;
    if (byLessonAch[k2]?.length === 1) return { id: byLessonAch[k2][0], reason: 'lesson+ach' };
  }
  // 3) lesson 단독 (1개일 때만)
  if (byLesson[ln]?.length === 1) return { id: byLesson[ln][0], reason: 'lesson-only' };
  if (byLesson[ln]?.length > 1) return { id: null, reason: `ambiguous-${byLesson[ln].length}` };
  return { id: null, reason: 'no-match' };
}

// ============ Videos ============
function processVideos() {
  const ADMIN_ID = 1;
  const videoFiles = [
    'videos_g4math_per_lesson.json', 'videos_g5math_per_lesson.json', 'videos_g6math_per_lesson.json',
    'videos_g7math_per_lesson_part1.json', 'videos_g7math_per_lesson_part2.json', 'videos_g7math_video_only.json',
    'videos_g8math_per_lesson.json', 'videos_g9math_per_lesson.json',
  ];

  const checkVideo = db.prepare(`SELECT id FROM contents WHERE content_type='video' AND content_url=? LIMIT 1`);
  const insContent = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, content_url, thumbnail_url,
      subject, grade, unit_name, school_level, tags, is_public, status, difficulty, copyright, allow_comments, source, created_at)
    VALUES (?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, 1, 'approved', 2, 'YouTube', 1, 'youtube', datetime('now'))
  `);
  const insNC = db.prepare(`INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, 'lecture', 0)`);
  const insCCN = db.prepare(`INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)`);

  let stats = { totalItems: 0, mapped: 0, ambiguous: 0, noMatch: 0, newVideos: 0, reused: 0, edgeAdded: 0 };
  const noMatchSamples = [];

  const tx = db.transaction(() => {
    for (const f of videoFiles) {
      const p = path.join('작업지시서/콘텐츠빌드', f);
      if (!fs.existsSync(p)) continue;
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const it of arr) {
        stats.totalItems++;
        const m = findKofacNode(it);
        if (!m.id) {
          if (m.reason.startsWith('ambiguous')) stats.ambiguous++;
          else stats.noMatch++;
          if (noMatchSamples.length < 5) noMatchSamples.push({ lesson: it.lesson_name, unit: it.unit_name, reason: m.reason });
          continue;
        }
        stats.mapped++;
        if (!APPLY) continue;
        // contents INSERT (reuse if dup)
        const url = it.video_url || `https://www.youtube.com/watch?v=${it.video_id}`;
        const thumb = `https://img.youtube.com/vi/${it.video_id}/hqdefault.jpg`;
        const dup = checkVideo.get(url);
        let cid;
        if (dup) { cid = dup.id; stats.reused++; }
        else {
          // KOFAC node에서 subject/grade/school_level 추출
          const kn = kofacLessons.find(x => x.node_id === m.id);
          const tags = JSON.stringify([kn.subject, `${kn.grade}학년`, it.unit_name || '', '유튜브', it.channel || ''].filter(Boolean));
          const sl = kn.subject === '수학과' ? 'middle' : (kn.subject === '수학' ? 'elementary' : null);
          const r = insContent.run(ADMIN_ID, it.title || it.lesson_name || '강의 영상',
            `${kn.subject} ${kn.grade}학년 — ${it.lesson_name || ''} 강의. 채널: ${it.channel || '미상'}.`,
            url, thumb, kn.subject, kn.grade, it.unit_name || null, sl, tags);
          cid = r.lastInsertRowid;
          stats.newVideos++;
        }
        insNC.run(m.id, cid);
        insCCN.run(cid, m.id);
        stats.edgeAdded++;
      }
    }
  });
  tx();

  console.log('\n[Videos] stats:', JSON.stringify(stats));
  if (noMatchSamples.length) console.log('[Videos] no-match 샘플:', JSON.stringify(noMatchSamples, null, 2));
}

// ============ Questions ============
function processQuestions() {
  const ADMIN_ID = 1;
  const qFiles = [
    'questions_g3math.json', 'questions_g4math.json', 'questions_g5math.json',
    'questions_g6math.json', 'questions_g7math.json', 'questions_g8math.json', 'questions_g9math.json',
  ];

  const insContent = db.prepare(`
    INSERT INTO contents (creator_id, title, description, content_type, subject, grade, achievement_code, unit_name,
      school_level, tags, is_public, status, difficulty, copyright, allow_comments, created_at)
    VALUES (?, ?, ?, 'quiz', ?, ?, ?, ?, ?, ?, 1, 'approved', 2, 'CC-BY', 1, datetime('now'))
  `);
  const insQ = db.prepare(`
    INSERT INTO content_questions (content_id, question_number, question_type, question_text, options, answer, explanation, points, difficulty, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
  `);
  const insNC = db.prepare(`INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, 'practice', 0)`);
  const insCCN = db.prepare(`INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)`);

  let stats = { totalItems: 0, mapped: 0, ambiguous: 0, noMatch: 0, quizInserted: 0, qInserted: 0 };
  const noMatchSamples = [];

  const tx = db.transaction(() => {
    for (const f of qFiles) {
      const p = path.join('작업지시서/콘텐츠빌드', f);
      if (!fs.existsSync(p)) continue;
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const it of arr) {
        stats.totalItems++;
        const m = findKofacNode(it);
        if (!m.id) {
          if (m.reason.startsWith('ambiguous')) stats.ambiguous++; else stats.noMatch++;
          if (noMatchSamples.length < 5) noMatchSamples.push({ lesson: it.lesson_name, unit: it.unit_name, reason: m.reason });
          continue;
        }
        stats.mapped++;
        if (!APPLY) continue;
        const kn = kofacLessons.find(x => x.node_id === m.id);
        const sl = kn.subject === '수학과' ? 'middle' : (kn.subject === '수학' ? 'elementary' : null);
        const tags = JSON.stringify([kn.subject, `${kn.grade}학년`, it.unit_name || '', it.lesson_name || '', '문항'].filter(Boolean));
        const r = insContent.run(ADMIN_ID, `${it.lesson_name} 연습 문제`, `${it.lesson_name} — 객관식 ${(it.questions||[]).length}문항.`,
          kn.subject, kn.grade, it.achievement_code || kn.achievement_code || null, it.unit_name || null, sl, tags);
        const cid = r.lastInsertRowid;
        stats.quizInserted++;
        for (const q of (it.questions || [])) {
          insQ.run(cid, q.question_number, q.question_type || 'choice', q.question_text,
            JSON.stringify(q.options), String(q.answer), q.explanation || null, Number(q.difficulty) || 2);
          stats.qInserted++;
        }
        insNC.run(m.id, cid);
        insCCN.run(cid, m.id);
      }
    }
  });
  tx();

  console.log('\n[Questions] stats:', JSON.stringify(stats));
  if (noMatchSamples.length) console.log('[Questions] no-match 샘플:', JSON.stringify(noMatchSamples, null, 2));
}

if (!TARGET || TARGET === 'videos') processVideos();
if (!TARGET || TARGET === 'questions') processQuestions();

db.close();
