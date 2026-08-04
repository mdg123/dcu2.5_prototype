#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * import-quiz-questions.js
 * ----------------------------------------------
 * 학습맵 차시별 신규 평가 문항 JSON 파일을 받아 DB에 INSERT한다.
 *
 * 입력 JSON 형식: 작업지시서/문항_작성_가이드라인.md §6 스키마
 * 산출:
 *  - contents 테이블: 차시당 5행 (단일 문항 quiz content 5개)
 *  - content_questions 테이블: content 1행당 1 question (question_number=1)
 *  - node_contents 테이블: 차시 노드 ↔ content 매핑 5행
 *
 * 사용법:
 *   node scripts/import-quiz-questions.js <path/to/chunk-XX.json>           # dry-run (기본)
 *   node scripts/import-quiz-questions.js <path/to/chunk-XX.json> --apply   # 실제 INSERT
 *
 * ⚠ 이 스크립트의 dry-run 은 "write→ROLLBACK" 방식이다.
 *   실제로 INSERT 를 **모두 실행한 뒤** 트랜잭션을 ROLLBACK 한다(DB 순변경 0).
 *   따라서 dry-run 중에도 디스크 I/O·제약조건 검사는 실제로 일어난다.
 *   하네스 변형 표식(scripts/_stamp-on-write.js)은 트랜잭션 결과를 존중하도록 되어 있어
 *   롤백된 write 에는 표식을 남기지 않는다. 그 동작은 test/harness-freshness.test.js
 *   REG-HF6b 가 고정한다 — 후킹을 손볼 때 이 스크립트를 반드시 함께 확인할 것.
 *
 * 옵션:
 *   --apply           실제 트랜잭션 commit (없으면 dry-run = 트랜잭션 rollback)
 *   --db <path>       DB 경로 (기본 data/dacheum.db)
 *   --no-backup       --apply 모드에서 자동 백업 생성 건너뛰기 (위험)
 *   --source <tag>    contents.source 값 (기본 'auto-generated-2026-05')
 *   --creator <id>    contents.creator_id (기본 1 = admin)
 *
 * 중복 방지:
 *   source=<--source> AND title 동일한 contents 행이 이미 있으면 skip.
 *
 * 라이선스: 프로젝트 내부 사용 한정 (다채움 2.0)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ---------- 인자 파싱 ----------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(`
사용법: node scripts/import-quiz-questions.js <path/to/chunk-XX.json> [옵션]

옵션:
  --apply           실제 트랜잭션 commit (없으면 dry-run = rollback)
  --db <path>       DB 경로 (기본 data/dacheum.db)
  --no-backup       --apply 모드에서 자동 백업 건너뛰기
  --source <tag>    contents.source 값 (기본 'auto-generated-2026-05')
  --creator <id>    contents.creator_id (기본 1 = admin)
`);
  process.exit(0);
}

function getOpt(name, defaultVal) {
  const idx = argv.indexOf(name);
  if (idx === -1) return defaultVal;
  return argv[idx + 1];
}

const inputPath = argv.find((a) => !a.startsWith('--') && !path.basename(__filename).includes(a));
if (!inputPath) {
  console.error('ERROR: 입력 JSON 경로가 필요합니다.');
  process.exit(1);
}

const APPLY = argv.includes('--apply');
const SKIP_BACKUP = argv.includes('--no-backup');
const DB_PATH = getOpt('--db', 'data/dacheum.db');
const SOURCE = getOpt('--source', 'auto-generated-2026-05');
const CREATOR_ID = parseInt(getOpt('--creator', '1'), 10);

const absInput = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
const absDb = path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(process.cwd(), DB_PATH);

console.log('================================================================');
console.log('  학습맵 차시 문항 import 스크립트');
console.log('================================================================');
console.log(`입력 JSON     : ${absInput}`);
console.log(`DB            : ${absDb}`);
console.log(`모드          : ${APPLY ? 'APPLY (실제 INSERT, 트랜잭션 commit)' : 'DRY-RUN (트랜잭션 rollback)'}`);
console.log(`source        : ${SOURCE}`);
console.log(`creator_id    : ${CREATOR_ID}`);
console.log('----------------------------------------------------------------');

// ---------- 입력 파일 로드 ----------
if (!fs.existsSync(absInput)) {
  console.error(`ERROR: 입력 파일이 없습니다: ${absInput}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(absInput, 'utf8'));
} catch (e) {
  console.error('ERROR: JSON 파싱 실패:', e.message);
  process.exit(1);
}

if (!payload.lessons || !Array.isArray(payload.lessons)) {
  console.error('ERROR: lessons[] 배열이 없습니다.');
  process.exit(1);
}

console.log(`chunk_id      : ${payload.chunk_id || '(없음)'}`);
console.log(`writer        : ${payload.writer_agent || '(없음)'}`);
console.log(`lessons       : ${payload.lessons.length}`);
console.log(`guideline_ver : ${payload.guideline_version || '(없음)'}`);
console.log('----------------------------------------------------------------');

// ---------- JSON 검증 ----------
const errors = [];
let totalQuestions = 0;

payload.lessons.forEach((lesson, lIdx) => {
  const prefix = `lessons[${lIdx}] (node_id=${lesson.node_id || '?'})`;
  if (!lesson.node_id) errors.push(`${prefix}: node_id 누락`);
  if (!lesson.node_meta_for_context) errors.push(`${prefix}: node_meta_for_context 누락`);
  if (!Array.isArray(lesson.questions)) {
    errors.push(`${prefix}: questions 배열 누락`);
    return;
  }
  if (lesson.questions.length !== 5) {
    errors.push(`${prefix}: questions 수 = ${lesson.questions.length} (5이어야 함)`);
  }

  // 난이도 분포 검증
  const diffCount = { 2: 0, 3: 0, 4: 0 };
  lesson.questions.forEach((q, qIdx) => {
    const qPrefix = `${prefix} q[${qIdx}]`;
    if (!q.title) errors.push(`${qPrefix}: title 누락`);
    if (!q.question_text) errors.push(`${qPrefix}: question_text 누락`);
    if (!Array.isArray(q.options) || q.options.length !== 5) {
      errors.push(`${qPrefix}: options 5개 필요 (현재 ${q.options ? q.options.length : 0})`);
    }
    if (typeof q.answer_index !== 'number' || q.answer_index < 0 || q.answer_index > 4) {
      errors.push(`${qPrefix}: answer_index 0~4 정수 필요 (현재 ${q.answer_index})`);
    }
    if (!q.explanation) errors.push(`${qPrefix}: explanation 누락`);
    if (![2, 3, 4].includes(q.difficulty)) {
      errors.push(`${qPrefix}: difficulty 2/3/4만 허용 (현재 ${q.difficulty})`);
    } else {
      diffCount[q.difficulty]++;
    }
    totalQuestions++;
  });

  // 난이도 분포 = (2,2,3,3,4) → diff 2: 2개, diff 3: 2개, diff 4: 1개
  if (diffCount[2] !== 2 || diffCount[3] !== 2 || diffCount[4] !== 1) {
    errors.push(`${prefix}: 난이도 분포 위반 — diff2=${diffCount[2]}, diff3=${diffCount[3]}, diff4=${diffCount[4]} (기대: 2/2/1)`);
  }
});

if (errors.length > 0) {
  console.error(`\n[검증 실패] ${errors.length}개 오류:`);
  errors.slice(0, 30).forEach((e) => console.error('  - ' + e));
  if (errors.length > 30) console.error(`  ... 그 외 ${errors.length - 30}개`);
  console.error('\n수정 후 다시 실행하세요.');
  process.exit(2);
}

console.log(`[검증 OK] 총 차시 ${payload.lessons.length}, 총 문항 ${totalQuestions}`);
console.log('----------------------------------------------------------------');

// ---------- DB 백업 (APPLY 모드만) ----------
if (APPLY && !SKIP_BACKUP) {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .split('.')[0]; // 20260527T123456 → 20260527123456
  const backupPath = `${absDb}.backup-${ts}-pre-quiz-seed`;
  try {
    fs.copyFileSync(absDb, backupPath);
    console.log(`[백업] ${backupPath}`);
    // WAL/SHM도 백업
    if (fs.existsSync(absDb + '-wal')) fs.copyFileSync(absDb + '-wal', backupPath + '-wal');
    if (fs.existsSync(absDb + '-shm')) fs.copyFileSync(absDb + '-shm', backupPath + '-shm');
  } catch (e) {
    console.error('ERROR: DB 백업 실패:', e.message);
    process.exit(3);
  }
}

// ---------- DB 연결 ----------
const db = new Database(absDb);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- admin 사용자 검증 ----------
const adminRow = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(CREATOR_ID);
if (!adminRow) {
  console.error(`ERROR: creator_id=${CREATOR_ID} 사용자가 없습니다.`);
  process.exit(4);
}
console.log(`[creator 확인] id=${adminRow.id}, username=${adminRow.username}, role=${adminRow.role}`);

// ---------- INSERT 준비 ----------
const insertContent = db.prepare(`
  INSERT INTO contents (
    creator_id, title, description, content_type, subject,
    grade, school_level, achievement_code, unit_name, difficulty,
    estimated_minutes, is_public, status, source, copyright,
    tags, allow_comments, download_allow, theme
  ) VALUES (
    @creator_id, @title, @description, 'quiz', '수학',
    @grade, @school_level, @achievement_code, @unit_name, @difficulty,
    @estimated_minutes, 1, 'approved', @source, 'CC-BY',
    @tags, 0, 0, NULL
  )
`);

const insertQuestion = db.prepare(`
  INSERT INTO content_questions (
    content_id, question_number, question_type, question_text,
    options, answer, explanation, points, difficulty
  ) VALUES (
    @content_id, 1, 'multiple_choice', @question_text,
    @options, @answer, @explanation, 10, @difficulty
  )
`);

const insertNodeContent = db.prepare(`
  INSERT INTO node_contents (
    node_id, content_id, content_role, sort_order
  ) VALUES (
    @node_id, @content_id, 'practice', @sort_order
  )
`);

const findExisting = db.prepare(`
  SELECT id FROM contents
  WHERE source = ? AND title = ? AND creator_id = ?
  LIMIT 1
`);

const checkNode = db.prepare(`
  SELECT node_id FROM learning_map_nodes WHERE node_id = ? AND node_level = 3
`);

// difficulty 숫자 → 문자열 매핑 (contents.difficulty는 TEXT)
const DIFF_MAP = { 2: '쉬움', 3: '보통', 4: '어려움' };

// ---------- 트랜잭션 실행 ----------
let counts = {
  lessons_total: payload.lessons.length,
  lessons_processed: 0,
  lessons_skipped_missing_node: 0,
  contents_inserted: 0,
  contents_skipped_duplicate: 0,
  questions_inserted: 0,
  node_contents_inserted: 0,
};

console.log(`[트랜잭션 시작] ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
db.exec('BEGIN');

try {
  payload.lessons.forEach((lesson, lIdx) => {
    const meta = lesson.node_meta_for_context || {};
    // 노드 존재 확인
    const nodeExists = checkNode.get(lesson.node_id);
    if (!nodeExists) {
      console.warn(`  ⚠ [${lIdx + 1}/${payload.lessons.length}] node_id=${lesson.node_id} 가 learning_map_nodes(level=3)에 없음 — skip`);
      counts.lessons_skipped_missing_node++;
      return;
    }

    let insertedThisLesson = 0;
    lesson.questions.forEach((q, qIdx) => {
      // 중복 확인
      const exist = findExisting.get(SOURCE, q.title, CREATOR_ID);
      if (exist) {
        counts.contents_skipped_duplicate++;
        return;
      }

      // contents INSERT
      const contentRow = insertContent.run({
        creator_id: CREATOR_ID,
        title: q.title,
        description: q.question_text.slice(0, 100),
        grade: meta.grade || null,
        school_level: meta.grade_level || null,
        achievement_code: meta.achievement_code || null,
        unit_name: meta.unit_name || null,
        difficulty: DIFF_MAP[q.difficulty] || '보통',
        estimated_minutes: 2,
        source: SOURCE,
        tags: meta.area || null,
      });
      const contentId = contentRow.lastInsertRowid;
      counts.contents_inserted++;

      // content_questions INSERT
      insertQuestion.run({
        content_id: contentId,
        question_text: q.question_text,
        options: JSON.stringify(q.options),
        answer: String(q.answer_index),
        explanation: q.explanation,
        difficulty: q.difficulty,
      });
      counts.questions_inserted++;

      // node_contents INSERT
      insertNodeContent.run({
        node_id: lesson.node_id,
        content_id: contentId,
        sort_order: qIdx + 1,
      });
      counts.node_contents_inserted++;
      insertedThisLesson++;
    });

    counts.lessons_processed++;
    if ((lIdx + 1) % 20 === 0 || lIdx === payload.lessons.length - 1) {
      console.log(`  진행 ${lIdx + 1}/${payload.lessons.length} — content INSERT ${counts.contents_inserted}, skip ${counts.contents_skipped_duplicate}`);
    }
  });

  if (APPLY) {
    db.exec('COMMIT');
    console.log('[트랜잭션 COMMIT 완료]');
  } else {
    db.exec('ROLLBACK');
    console.log('[트랜잭션 ROLLBACK 완료 — dry-run]');
  }
} catch (e) {
  db.exec('ROLLBACK');
  console.error('ERROR: 트랜잭션 실패 — rollback', e);
  process.exit(5);
}

db.close();

console.log('================================================================');
console.log('  결과 요약');
console.log('================================================================');
console.log(JSON.stringify(counts, null, 2));
console.log(APPLY ? '✓ APPLY 완료' : '◌ DRY-RUN 완료 (실제 변경 없음)');
