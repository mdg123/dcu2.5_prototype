/**
 * EBS 문항 전체 import — 초등 수학, 3단계 ID 채워진 모든 행
 *
 * xlsx에서 3단계 ID별로 첫 번째 문항만 선택(대표 1개)하여
 * learning_map_nodes에 매핑된 차시 노드 전체에 EBS quiz 콘텐츠를 생성한다.
 *
 * 실행: node scripts/import-ebs-all.js
 */

const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const XLSX_PATH = path.resolve(__dirname, '..', '..', '..', '..', '교육과정표준체계_최종산출물_202412', '4. EBS_문항메타데이터_KOFAC기준매핑_v1.xlsx');
const DB_PATH   = path.resolve(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);
const ADMIN_ID = 1;

// ── xlsx 파싱 ──────────────────────────────────────────────────────────────
const wb    = XLSX.readFile(XLSX_PATH);
const sheet = wb.Sheets[wb.SheetNames[2]]; // 초등 시트
const rows  = XLSX.utils.sheet_to_json(sheet, { range: 1, defval: null });

// 수학 + 3단계 ID 있는 행
const mathRows = rows.filter(r => r['과목'] === '수학' && r['3단계 ID']);
console.log(`[xlsx] 초등 수학 3단계ID 행: ${mathRows.length}개`);

// 3단계 ID별로 대표 1개씩 선택 (첫 번째 행)
const byStdId = new Map();
for (const r of mathRows) {
  const stdId = String(r['3단계 ID']).trim();
  if (!byStdId.has(stdId)) byStdId.set(stdId, r);
}
console.log(`[xlsx] 고유 3단계 ID: ${byStdId.size}개`);

// EBS 문항번호 컬럼 키 찾기
const sampleRow = mathRows[0];
const ebsKey = Object.keys(sampleRow).find(k => k.startsWith('EBS') && k.includes('문항번호'));
console.log(`[xlsx] EBS 문항번호 컬럼: "${ebsKey}"`);

// ── Prepared Statements ────────────────────────────────────────────────────
const insertContent = db.prepare(`
  INSERT INTO contents (
    creator_id, title, description, content_type, content_url, file_path,
    subject, grade, achievement_code, tags, is_public, status,
    difficulty, copyright, allow_comments, created_at
  ) VALUES (?, ?, ?, 'quiz', ?, NULL, ?, ?, ?, ?, 1, 'approved', ?, 'CC-BY', 1, datetime('now'))
`);

const insertQuestion = db.prepare(`
  INSERT INTO content_questions (
    content_id, question_number, question_text, question_type,
    options, answer, explanation, points, difficulty
  ) VALUES (?, 1, ?, 'multiple_choice', ?, ?, ?, 10, ?)
`);

const insertStdId = db.prepare(`
  INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)
`);

const insertNodeMapping = db.prepare(`
  INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order)
  VALUES (?, ?, 'practice', 0)
`);

const checkMapNode   = db.prepare('SELECT node_id, lesson_name, unit_name, achievement_code, achievement_text FROM learning_map_nodes WHERE node_id = ?');
const checkDuplicate = db.prepare('SELECT id FROM contents WHERE creator_id = ? AND content_type = ? AND title = ? LIMIT 1');

// ── 난이도 레이블 → 숫자 ──────────────────────────────────────────────────
const DIFF_MAP = { '하': 1, '중하': 2, '중': 3, '중상': 4, '상': 5 };

// ── 선택지 생성 헬퍼 ───────────────────────────────────────────────────────
function buildStem(r, node) {
  const unit  = r['중분류'] || node.unit_name || '';
  const topic = r['소분류'] || '';
  const ebsNo = r[ebsKey];
  const code  = r['성취기준'] || node.achievement_code || '';
  return `[${code}] ${unit} — ${topic}\n\n(EBS 문항 ${ebsNo}) 다음 문제를 풀어 보세요.`;
}

function buildOptions(answer) {
  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= 5) {
    return ['①', '②', '③', '④', '⑤'];
  }
  // 단답형 등 → 기본 5지 선택지
  return ['①', '②', '③', '④', '⑤'];
}

function getAnswerIdx(answer, options) {
  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return String(num - 1);  // 0-based
  }
  return '0';
}

// ── Transaction ────────────────────────────────────────────────────────────
const tx = db.transaction(() => {
  let inserted = 0, skipped = 0, noNode = 0;

  for (const [stdId, r] of byStdId) {
    const node = checkMapNode.get(stdId);
    if (!node) { noNode++; continue; }

    const ebsNo   = String(r[ebsKey] || '').trim();
    const code    = String(r['성취기준'] || node.achievement_code || '').trim();
    const grade   = parseInt(String(r['학년']).match(/\d/)?.[0] || '1', 10);
    const subject = String(r['과목'] || '수학');
    const area    = String(r['대분류(내용영역)'] || '');
    const unit    = String(r['중분류'] || node.unit_name || '');
    const topic   = String(r['소분류'] || node.lesson_name || '');
    const diffLbl = String(r['난이도'] || '중');
    const diff    = DIFF_MAP[diffLbl] || 3;
    const answer  = String(r['정답'] || '1').trim();

    const title = `${code} ${topic} — EBS ${ebsNo}`;

    // 중복 체크
    const dup = checkDuplicate.get(ADMIN_ID, 'quiz', title);
    if (dup) { skipped++; continue; }

    const ebsUrl     = `https://ai-plus.ebs.co.kr/ebs/xip/landingexplanation.ebs?allView=Y&itemId=${ebsNo}`;
    const description = `EBS 라이선스 문항. ${area} > ${unit} > ${topic}. ${grade}학년, 난이도: ${diffLbl}.`;
    const tags        = JSON.stringify([subject, area, unit, `EBS-${ebsNo}`, code]);

    const ci        = insertContent.run(ADMIN_ID, title, description, ebsUrl, subject, grade, code, tags, diff);
    const contentId = ci.lastInsertRowid;

    const options   = buildOptions(answer);
    const stem      = buildStem(r, node);
    const answerIdx = getAnswerIdx(answer, options);
    const expl      = `이 문항은 ${code} 성취기준의 "${topic}" 평가요소에 해당합니다. 정답 번호: ${answer}.`;

    insertQuestion.run(contentId, stem, JSON.stringify(options), answerIdx, expl, diff);
    insertStdId.run(contentId, stdId);
    insertNodeMapping.run(stdId, contentId);

    inserted++;
    if (inserted % 50 === 0) console.log(`  진행: ${inserted}개 삽입 완료...`);
  }

  return { inserted, skipped, noNode };
});

console.log('\n실행 중...');
const startTime = Date.now();
const result = tx();
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(`\n✅ 완료 (${elapsed}초)`);
console.log(`  삽입: ${result.inserted}개`);
console.log(`  중복 건너뜀: ${result.skipped}개`);
console.log(`  DB 노드 없음: ${result.noNode}개`);

// 매핑된 노드 통계
const mappedCount = db.prepare('SELECT COUNT(DISTINCT node_id) as c FROM node_contents').get();
const totalNodes  = db.prepare('SELECT COUNT(*) as c FROM learning_map_nodes WHERE node_level = 3').get();
console.log(`\n📊 AI 맞춤학습 매핑 현황: ${mappedCount.c} / ${totalNodes.c} 차시 노드`);

db.close();
