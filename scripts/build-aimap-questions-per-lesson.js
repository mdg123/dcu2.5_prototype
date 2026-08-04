require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * build-aimap-questions-per-lesson.js
 *
 * AI 맞춤학습 — 차시별 문항 적재.
 * questions_g4math.json·g5math·g6math·g7math·g8math·g9math.json 통합.
 *
 * 차시당 contents row 1개 (quiz) + content_questions N개.
 * 자체 LaTeX 안전망 + 정답 분포 검증.
 *
 * 사용법:
 *   node scripts/build-aimap-questions-per-lesson.js --dry-run
 *   node scripts/build-aimap-questions-per-lesson.js --apply
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const BASE = path.resolve(__dirname, '..', '작업지시서', '콘텐츠빌드');
const ADMIN_ID = 1;

const FILES = [
  { file: 'questions_g4math.json', subject: '수학',   grade: 4, schoolLevel: 'elementary' },
  { file: 'questions_g5math.json', subject: '수학',   grade: 5, schoolLevel: 'elementary' },
  { file: 'questions_g6math.json', subject: '수학',   grade: 6, schoolLevel: 'elementary' },
  { file: 'questions_g7math.json', subject: '수학과', grade: 1, schoolLevel: 'middle' },
  { file: 'questions_g8math.json', subject: '수학과', grade: 2, schoolLevel: 'middle' },
  { file: 'questions_g9math.json', subject: '수학과', grade: 3, schoolLevel: 'middle' },
];

const LATEX_PATTERNS = [
  /\$[^\$\n]*\$/, /\$\$[\s\S]*?\$\$/,
  /\\frac\b/, /\\sqrt\b/, /\\times\b/, /\\div\b/,
  /\\le[q]?\b/, /\\ge[q]?\b/, /\\neq\b/,
  /\\alpha\b/, /\\beta\b/, /\\gamma\b/, /\\theta\b/, /\\pi\b/,
  /\^\{[^}]+\}/, /_\{[^}]+\}/,
];

function findLatex(s) {
  if (s == null) return null;
  const str = String(s);
  for (const p of LATEX_PATTERNS) if (p.test(str)) return p.source;
  return null;
}

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function validate(items, src) {
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.node_id) errors.push(`${src}[${i}] node_id 없음`);
    if (!Array.isArray(it.questions) || it.questions.length === 0) errors.push(`${src}[${i}] questions 비어있음`);
    if (it.questions && it.questions.length < 3) errors.push(`${src}[${i}] 문항 수 < 3 (${it.questions.length})`);
    for (let j = 0; j < (it.questions || []).length; j++) {
      const q = it.questions[j];
      if (!q.question_text) errors.push(`${src}[${i}.${j}] question_text 없음`);
      if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(`${src}[${i}.${j}] options 4개 아님`);
      const ans = Number(q.answer);
      if (!Number.isInteger(ans) || ans < 0 || ans > 3) errors.push(`${src}[${i}.${j}] answer 인덱스 이상: ${q.answer}`);
      const blob = [q.question_text, q.explanation, ...(q.options || [])].join(' ');
      const hit = findLatex(blob);
      if (hit) errors.push(`${src}[${i}.${j}] LaTeX (${hit})`);
    }
  }
  return errors;
}

function main() {
  console.log(`[mode] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const allBlocks = [];
  let totalLessons = 0, totalQuestions = 0;
  let allErrors = [];

  for (const f of FILES) {
    const p = path.join(BASE, f.file);
    if (!fs.existsSync(p)) { console.log(`[skip] ${f.file} (없음)`); continue; }
    const arr = loadJson(p);
    if (!arr) { console.error('[ERR]', f.file); return; }
    const errs = validate(arr, f.file);
    if (errs.length) {
      allErrors.push(...errs);
      console.error(`[ERR] ${f.file} 검증 실패: ${errs.length}건`);
      errs.slice(0, 5).forEach(e => console.error('  -', e));
    }
    totalLessons += arr.length;
    arr.forEach(it => totalQuestions += (it.questions || []).length);
    allBlocks.push({ meta: f, items: arr });
  }

  if (allErrors.length) {
    console.error(`\n총 검증 오류: ${allErrors.length}. ABORT.`);
    process.exit(2);
  }

  console.log(`\n[loaded] 차시 ${totalLessons}, 문항 ${totalQuestions}`);

  // 정답 분포 검증
  const dist = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const b of allBlocks) for (const it of b.items) for (const q of it.questions) dist[String(q.answer)]++;
  console.log('[정답 분포]', JSON.stringify(dist));
  for (const k of Object.keys(dist)) {
    const pct = totalQuestions ? dist[k] / totalQuestions : 0;
    if (pct < 0.10 || pct > 0.40) console.warn(`[WARN] 정답 ${k}번 분포 비정상: ${(pct * 100).toFixed(1)}%`);
  }

  if (DRY) {
    console.log('[dry-run] 검증 통과. --apply 로 적재.');
    return;
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const insContent = db.prepare(`
    INSERT INTO contents (
      creator_id, title, description, content_type,
      subject, grade, achievement_code, unit_name, school_level,
      tags, is_public, status, difficulty, copyright, allow_comments, created_at
    ) VALUES (?, ?, ?, 'quiz', ?, ?, ?, ?, ?, ?, 1, 'approved', 2, 'CC-BY', 1, datetime('now'))
  `);
  const insQuestion = db.prepare(`
    INSERT INTO content_questions (
      content_id, question_number, question_type, question_text, options, answer,
      explanation, points, difficulty, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
  `);
  const insNC = db.prepare(`INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, 'practice', 0)`);
  const insCCN = db.prepare(`INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)`);

  let stats = { quizInserted: 0, qInserted: 0, mapped: 0 };

  const tx = db.transaction(() => {
    for (const b of allBlocks) {
      const f = b.meta;
      for (const it of b.items) {
        const tags = JSON.stringify([f.subject, `${f.grade}학년`, it.unit_name || '', it.lesson_name || '', '문항'].filter(Boolean));
        const desc = `${it.lesson_name} — 객관식 ${it.questions.length}문항.`;
        const r = insContent.run(
          ADMIN_ID, `${it.lesson_name} 연습 문제`, desc,
          f.subject, f.grade, it.achievement_code || null, it.unit_name || null, f.schoolLevel, tags
        );
        const contentId = r.lastInsertRowid;
        stats.quizInserted++;
        for (const q of it.questions) {
          insQuestion.run(
            contentId, q.question_number, q.question_type || 'choice',
            q.question_text, JSON.stringify(q.options), String(q.answer),
            q.explanation || null, Number(q.difficulty) || 2
          );
          stats.qInserted++;
        }
        insNC.run(it.node_id, contentId);
        insCCN.run(contentId, it.node_id);
        stats.mapped++;
      }
    }
  });
  tx();

  console.log(`[APPLIED] quiz contents: ${stats.quizInserted}, 문항: ${stats.qInserted}, 매핑: ${stats.mapped}`);
  db.close();
}

main();
