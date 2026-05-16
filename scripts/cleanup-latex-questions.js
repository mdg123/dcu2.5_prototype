/**
 * cleanup-latex-questions.js
 * content_questions 테이블의 LaTeX 잔류 문항을 한글·유니코드 표기로 치환한다.
 *
 * 사용법:
 *   node scripts/cleanup-latex-questions.js --dry-run   # 변경 예상 내용만 출력 (DB 수정 안 함)
 *   node scripts/cleanup-latex-questions.js --apply     # 실제 DB UPDATE 실행
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/dacheum.db');
const CLEANUP_JSON = path.join(__dirname, '../작업지시서/콘텐츠빌드/latex_cleanup.json');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isApply = args.includes('--apply');

if (!isDryRun && !isApply) {
  console.error('사용법: node scripts/cleanup-latex-questions.js [--dry-run | --apply]');
  process.exit(1);
}

// latex_cleanup.json 로드
const cleanupData = JSON.parse(fs.readFileSync(CLEANUP_JSON, 'utf8'));
console.log(`\n[LaTeX 정리 스크립트] 모드: ${isDryRun ? 'DRY-RUN (DB 수정 안 함)' : 'APPLY (실제 UPDATE)'}`);
console.log(`치환 대상: ${cleanupData.length}건\n`);

const db = new Database(DB_PATH, { readonly: isDryRun });

// 현재 DB 값 확인 함수
function getCurrentRow(id) {
  return db.prepare(
    'SELECT id, question_text, options, explanation FROM content_questions WHERE id = ?'
  ).get(id);
}

if (isDryRun) {
  console.log('='.repeat(70));
  console.log('DRY-RUN 결과 (실제 변경 없음)');
  console.log('='.repeat(70));

  for (const item of cleanupData) {
    const current = getCurrentRow(item.id);
    if (!current) {
      console.log(`\n[id: ${item.id}] DB에서 찾을 수 없음 — SKIP`);
      continue;
    }

    console.log(`\n[id: ${item.id}]`);
    console.log(`  question_text:`);
    console.log(`    BEFORE: ${current.question_text}`);
    console.log(`    AFTER:  ${item.after.question_text}`);

    if (item.after.options !== null) {
      console.log(`  options:`);
      console.log(`    BEFORE: ${current.options}`);
      console.log(`    AFTER:  ${item.after.options}`);
    }

    console.log(`  explanation:`);
    console.log(`    BEFORE: ${current.explanation}`);
    console.log(`    AFTER:  ${item.after.explanation}`);
    console.log(`  rationale: ${item.rationale}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('DRY-RUN 완료. --apply 로 실행하면 위 내용이 DB에 적용됩니다.');

} else {
  // APPLY 모드: 트랜잭션으로 일괄 UPDATE
  console.log('='.repeat(70));
  console.log('DB UPDATE 실행');
  console.log('='.repeat(70));

  const updateStmt = db.prepare(`
    UPDATE content_questions
    SET question_text = ?, options = ?, explanation = ?
    WHERE id = ?
  `);

  const applyAll = db.transaction(() => {
    let successCount = 0;
    let skipCount = 0;

    for (const item of cleanupData) {
      const current = getCurrentRow(item.id);
      if (!current) {
        console.log(`[id: ${item.id}] DB에서 찾을 수 없음 — SKIP`);
        skipCount++;
        continue;
      }

      const newOptions = item.after.options !== undefined ? item.after.options : current.options;

      const result = updateStmt.run(
        item.after.question_text,
        newOptions,
        item.after.explanation,
        item.id
      );

      if (result.changes > 0) {
        console.log(`[id: ${item.id}] UPDATE 완료`);
        console.log(`  Q: ${item.before.question_text}`);
        console.log(`  → ${item.after.question_text}`);
        successCount++;
      } else {
        console.log(`[id: ${item.id}] 변경 없음 — SKIP`);
        skipCount++;
      }
    }

    return { successCount, skipCount };
  });

  const { successCount, skipCount } = applyAll();

  console.log('\n' + '='.repeat(70));
  console.log(`UPDATE 완료: ${successCount}건 성공, ${skipCount}건 스킵`);

  // 잔류 LaTeX 재검사
  console.log('\n[잔류 LaTeX 재검사]');
  const residues = db.prepare(`
    SELECT id, question_text, options, explanation
    FROM content_questions
    WHERE question_text LIKE '%$%'
       OR question_text LIKE '%\\frac%'
       OR question_text LIKE '%\\sqrt%'
       OR question_text LIKE '%\\times%'
       OR question_text LIKE '%\\div%'
       OR options LIKE '%$%'
       OR options LIKE '%\\frac%'
       OR explanation LIKE '%$%'
       OR explanation LIKE '%\\frac%'
  `).all();

  // 실제 LaTeX($기호 포함)만 필터
  const actualLatex = residues.filter(r => {
    const text = (r.question_text || '') + (r.options || '') + (r.explanation || '');
    return text.includes('$') || /\\frac|\\sqrt|\\times|\\div/.test(text);
  });

  if (actualLatex.length === 0) {
    console.log('잔류 LaTeX: 0건 ✓ — 모든 LaTeX가 정리되었습니다.');
  } else {
    console.log(`잔류 LaTeX: ${actualLatex.length}건 (추가 정리 필요)`);
    actualLatex.forEach(r => {
      console.log(`  id: ${r.id} | Q: ${(r.question_text || '').substring(0, 80)}`);
    });
  }
}

db.close();
