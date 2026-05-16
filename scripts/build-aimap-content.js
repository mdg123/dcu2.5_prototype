/**
 * build-aimap-content.js
 *
 * AI 맞춤학습 콘텐츠 빌드 — Sonnet 서브에이전트가 생성한 JSON을 DB에 적재.
 *
 * 입력:
 *   - 작업지시서/콘텐츠빌드/videos_g3math.json   (영상 큐레이션)
 *   - 작업지시서/콘텐츠빌드/questions_g3math.json (차시별 4문항)
 *
 * 동작:
 *   - 영상: contents INSERT + node_contents (단원의 모든 차시) + content_content_nodes
 *   - 문항: contents INSERT (1차시 1 quiz) + content_questions × N + 매핑
 *   - 모든 작업은 단일 트랜잭션
 *
 * 사용법:
 *   node scripts/build-aimap-content.js --dry-run   # 미리보기
 *   node scripts/build-aimap-content.js --apply     # 실제 적재
 *
 * LaTeX 안전망: question_text/options/explanation 에 LaTeX 패턴 발견 시 ABORT
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = args.includes('--dry-run') || !APPLY;

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const VIDEOS_JSON = path.resolve(__dirname, '..', '작업지시서', '콘텐츠빌드', 'videos_g3math.json');
const QUESTIONS_JSON = path.resolve(__dirname, '..', '작업지시서', '콘텐츠빌드', 'questions_g3math.json');

const ADMIN_ID = 1;
const SUBJECT = '수학';
const GRADE = 3;

// ── LaTeX 안전망 ────────────────────────────────────────────────────────────
const LATEX_PATTERNS = [
  /\$[^\$\n]*\$/,           // $...$ inline
  /\$\$[\s\S]*?\$\$/,       // $$...$$ display
  /\\frac\b/,
  /\\sqrt\b/,
  /\\times\b/,
  /\\div\b/,
  /\\le[q]?\b/,
  /\\ge[q]?\b/,
  /\\neq\b/,
  /\\alpha\b/, /\\beta\b/, /\\gamma\b/, /\\theta\b/, /\\pi\b/,
  /\\circ\b/,
  /\^\{[^}]+\}/,             // ^{...}
  /_\{[^}]+\}/,              // _{...}
];

function findLatex(s) {
  if (s == null) return null;
  const str = String(s);
  for (const p of LATEX_PATTERNS) if (p.test(str)) return p.source;
  return null;
}

// ── 입력 검증 ──────────────────────────────────────────────────────────────
function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`[ERR] ${label} JSON 없음: ${p}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[ERR] ${label} JSON 파싱 실패: ${e.message}`);
    return null;
  }
}

function validateVideos(videos) {
  const errors = [];
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!v.unit_name) errors.push(`[video ${i}] unit_name 없음`);
    if (!v.video_id || !/^[A-Za-z0-9_-]{6,15}$/.test(v.video_id)) errors.push(`[video ${i}] video_id 형식 이상: ${v.video_id}`);
    if (!v.video_url || !v.video_url.includes(v.video_id)) errors.push(`[video ${i}] video_url 누락 또는 ID 불일치`);
    if (!Array.isArray(v.node_ids) || v.node_ids.length === 0) errors.push(`[video ${i}] node_ids 비어있음`);
    if (!v.title) errors.push(`[video ${i}] title 없음`);
    const latexHit = findLatex(v.title) || findLatex(v.unit_name);
    if (latexHit) errors.push(`[video ${i}] LaTeX 흔적 (${latexHit}): ${v.title}`);
  }
  return errors;
}

function validateQuestions(items) {
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.node_id) { errors.push(`[q ${i}] node_id 없음`); continue; }
    if (!Array.isArray(it.questions) || it.questions.length === 0) { errors.push(`[q ${i}] questions 비어있음 (node=${it.node_id})`); continue; }
    for (let j = 0; j < it.questions.length; j++) {
      const q = it.questions[j];
      if (!q.question_text) errors.push(`[q ${i}.${j}] question_text 없음`);
      if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(`[q ${i}.${j}] options 4개 아님 (${(q.options||[]).length}개)`);
      const ans = Number(q.answer);
      if (!Number.isInteger(ans) || ans < 0 || ans > 3) errors.push(`[q ${i}.${j}] answer 인덱스 이상: ${q.answer}`);
      const latexFields = [
        ['question_text', q.question_text],
        ['explanation', q.explanation],
        ...(Array.isArray(q.options) ? q.options.map((o, k) => [`options[${k}]`, o]) : []),
      ];
      for (const [name, val] of latexFields) {
        const hit = findLatex(val);
        if (hit) errors.push(`[q ${i}.${j}] LaTeX 흔적 ${name} (${hit}): ${String(val).slice(0, 60)}`);
      }
    }
  }
  return errors;
}

// ── 메인 ───────────────────────────────────────────────────────────────────
function main() {
  console.log(`[mode] ${APPLY ? 'APPLY (실제 DB 변경)' : 'DRY-RUN (변경 없음)'}`);
  console.log(`[db] ${DB_PATH}`);

  const videos = loadJson(VIDEOS_JSON, 'videos');
  const questions = loadJson(QUESTIONS_JSON, 'questions');
  if (!videos || !questions) process.exit(1);

  console.log(`\n[loaded] 영상: ${videos.length}개, 문항 차시: ${questions.length}개`);

  // 검증
  const vErr = validateVideos(videos);
  const qErr = validateQuestions(questions);
  if (vErr.length || qErr.length) {
    console.error(`\n[VALIDATION FAILED]`);
    vErr.forEach(e => console.error('  V', e));
    qErr.forEach(e => console.error('  Q', e));
    console.error(`\n총 오류: 영상 ${vErr.length}건, 문항 ${qErr.length}건. ABORT.`);
    process.exit(2);
  }
  console.log(`[validation] PASS — LaTeX 흔적 없음, 형식 정상`);

  if (DRY) {
    console.log(`\n[dry-run] 검증만 수행. DB 변경 없음. --apply 로 적재.`);
    return;
  }

  // DB 적재
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const insContent = db.prepare(`
    INSERT INTO contents (
      creator_id, title, description, content_type, content_url, thumbnail_url,
      subject, grade, achievement_code, unit_name, school_level,
      tags, is_public, status, difficulty, copyright, allow_comments, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', ?, ?, 1, ?, datetime('now'))
  `);
  const insQuestion = db.prepare(`
    INSERT INTO content_questions (
      content_id, question_number, question_type, question_text, options, answer,
      explanation, points, difficulty, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
  `);
  const insNodeContent = db.prepare(`
    INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)
  `);
  const insCCN = db.prepare(`
    INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)
  `);
  const checkVideoDup = db.prepare(`
    SELECT id FROM contents WHERE content_type='video' AND content_url=? LIMIT 1
  `);

  let stats = { videoInserted: 0, videoSkipped: 0, videoMapped: 0, quizInserted: 0, qInserted: 0, quizMapped: 0 };

  const tx = db.transaction(() => {
    // 1) 영상
    for (const v of videos) {
      const dup = checkVideoDup.get(v.video_url);
      let contentId;
      if (dup) {
        contentId = dup.id;
        stats.videoSkipped++;
      } else {
        const tags = JSON.stringify(['수학', `${GRADE}학년`, v.area || '', v.unit_name, '유튜브', v.channel || ''].filter(Boolean));
        const desc = `초등 ${GRADE}학년 수학 — ${v.unit_name} 강의 영상. 채널: ${v.channel || '미상'}.`;
        const r = insContent.run(
          ADMIN_ID, v.title, desc, 'video',
          v.video_url, `https://img.youtube.com/vi/${v.video_id}/hqdefault.jpg`,
          SUBJECT, GRADE, v.achievement_code || null, v.unit_name, 'elementary',
          tags, 2, 'YouTube', 'youtube'
        );
        contentId = r.lastInsertRowid;
        stats.videoInserted++;
      }
      // 매핑: 단원 내 모든 차시
      for (const nid of v.node_ids) {
        insNodeContent.run(nid, contentId, 'lecture', 0);
        insCCN.run(contentId, nid);
        stats.videoMapped++;
      }
    }

    // 2) 문항
    for (const item of questions) {
      const tags = JSON.stringify(['수학', `${GRADE}학년`, item.unit_name || '', item.lesson_name || '', '문항'].filter(Boolean));
      const desc = `${item.lesson_name} — 객관식 ${item.questions.length}문항.`;
      const r = insContent.run(
        ADMIN_ID, `${item.lesson_name} 연습 문제`, desc, 'quiz',
        null, null,
        SUBJECT, GRADE, item.achievement_code || null, item.unit_name, 'elementary',
        tags, 2, 'CC-BY', null
      );
      const contentId = r.lastInsertRowid;
      stats.quizInserted++;

      for (const q of item.questions) {
        insQuestion.run(
          contentId, q.question_number, q.question_type || 'choice', q.question_text,
          JSON.stringify(q.options), String(q.answer),
          q.explanation || null, Number(q.difficulty) || 2
        );
        stats.qInserted++;
      }
      // 매핑: 1차시만
      insNodeContent.run(item.node_id, contentId, 'practice', 0);
      insCCN.run(contentId, item.node_id);
      stats.quizMapped++;
    }
  });

  try {
    tx();
    console.log(`\n[APPLIED]`);
    console.log(`  영상 신규: ${stats.videoInserted}, 영상 재사용: ${stats.videoSkipped}, 영상-차시 매핑: ${stats.videoMapped}`);
    console.log(`  문항 콘텐츠: ${stats.quizInserted}, 개별 문항: ${stats.qInserted}, 문항-차시 매핑: ${stats.quizMapped}`);
  } catch (e) {
    console.error(`[ERR] 트랜잭션 실패: ${e.message}`);
    process.exit(3);
  }

  // 최종 확인
  const stillEmpty = db.prepare(`
    SELECT COUNT(*) c FROM learning_map_nodes n
    LEFT JOIN node_contents nc ON nc.node_id = n.node_id
    LEFT JOIN contents c ON c.id = nc.content_id
    WHERE n.lesson_name IS NOT NULL AND n.subject='수학' AND n.grade=3
    GROUP BY n.node_id
    HAVING COUNT(c.id) = 0
  `).all();
  console.log(`\n[verify] 초등 3학년 수학 — 여전히 빈 차시: ${stillEmpty.length}개`);

  db.close();
}

main();
