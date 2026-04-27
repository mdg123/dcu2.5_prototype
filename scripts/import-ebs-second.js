/**
 * 차시 노드당 2번째 EBS 문항 추가
 * 각 3단계 ID의 xlsx 두 번째 행을 import
 */

const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const XLSX_PATH = path.resolve(__dirname, '..', '..', '..', '..', '교육과정표준체계_최종산출물_202412', '4. EBS_문항메타데이터_KOFAC기준매핑_v1.xlsx');
const DB_PATH   = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
const ADMIN_ID  = 1;
const DIFF_MAP  = { '하': 1, '중하': 2, '중': 3, '중상': 4, '상': 5 };

// xlsx 파싱
const wb     = XLSX.readFile(XLSX_PATH);
const sheet  = wb.Sheets[wb.SheetNames[2]];
const rows   = XLSX.utils.sheet_to_json(sheet, { range: 1, defval: null });
const mathRows = rows.filter(r => r['과목'] === '수학' && r['3단계 ID']);
const ebsKey   = Object.keys(mathRows[0]).find(k => k.startsWith('EBS') && k.includes('문항번호'));

// std_id별 최대 2개 행 수집
const byStdId = new Map();
for (const r of mathRows) {
  const stdId = String(r['3단계 ID']).trim();
  if (!byStdId.has(stdId)) byStdId.set(stdId, []);
  if (byStdId.get(stdId).length < 2) byStdId.get(stdId).push(r);
}
const hasSecond = [...byStdId.entries()].filter(([, v]) => v.length >= 2);
console.log(`[xlsx] 2번째 문항 가능한 3단계 ID: ${hasSecond.length}개`);

// Prepared statements
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
const insertStd  = db.prepare('INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)');
const insertNode = db.prepare('INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)');
const checkNode  = db.prepare('SELECT node_id, lesson_name FROM learning_map_nodes WHERE node_id = ?');
const checkDup   = db.prepare("SELECT id FROM contents WHERE creator_id=? AND content_type='quiz' AND title=? LIMIT 1");

const tx = db.transaction(() => {
  let inserted = 0, skipped = 0;

  for (const [stdId, rArr] of hasSecond) {
    const r      = rArr[1]; // 2번째 행
    const ebsNo  = String(r[ebsKey] || '').trim();
    const code   = String(r['성취기준'] || '').trim();
    const grade  = parseInt(String(r['학년']).match(/\d/)?.[0] || '1', 10);
    const area   = String(r['대분류(내용영역)'] || '');
    const unit   = String(r['중분류'] || '');
    const topic  = String(r['소분류'] || '');
    const diff   = DIFF_MAP[String(r['난이도'] || '중')] || 3;
    const answer = String(r['정답'] || '1').trim();

    const node = checkNode.get(stdId);
    if (!node) { skipped++; continue; }

    // 제목: 성취기준 코드 없이 내용으로 요약 (2번째 문항)
    const lessonName = node.lesson_name || topic;
    const title = `${lessonName} 연습문제 2 (EBS ${ebsNo})`;

    const dup = checkDup.get(ADMIN_ID, title);
    if (dup) { skipped++; continue; }

    const ebsUrl = `https://ai-plus.ebs.co.kr/ebs/xip/landingexplanation.ebs?allView=Y&itemId=${ebsNo}`;
    const desc   = `EBS 라이선스 문항. ${area} > ${unit} > ${topic}. ${grade}학년.`;
    const tags   = JSON.stringify([r['과목'], area, unit, `EBS-${ebsNo}`, code]);
    const stem   = `${unit} — ${topic}\n\n(EBS 문항 ${ebsNo}) 다음 문제를 풀어 보세요.`;
    const opts   = ['①', '②', '③', '④', '⑤'];
    const num    = parseInt(answer, 10);
    const ansIdx = (!isNaN(num) && num >= 1 && num <= 5) ? String(num - 1) : '0';
    const expl   = `이 문항은 ${code} 성취기준의 "${topic}" 평가요소에 해당합니다. 정답 번호: ${answer}.`;

    const ci  = insertContent.run(ADMIN_ID, title, desc, ebsUrl, r['과목'], grade, code, tags, diff);
    const cid = ci.lastInsertRowid;

    insertQuestion.run(cid, stem, JSON.stringify(opts), ansIdx, expl, diff);
    insertStd.run(cid, stdId);
    insertNode.run(stdId, cid, 'practice', 1);
    inserted++;

    if (inserted % 100 === 0) console.log(`  진행: ${inserted}개...`);
  }

  return { inserted, skipped };
});

const result = tx();
console.log(`\n✅ 2번째 문항 삽입: ${result.inserted}개, 건너뜀: ${result.skipped}개`);

// 결과 확인
const mappedTwo = db.prepare(`
  SELECT COUNT(DISTINCT node_id) as c
  FROM (SELECT node_id, COUNT(*) as cnt FROM node_contents GROUP BY node_id HAVING cnt >= 2)
`).get();
const totalNodes = db.prepare('SELECT COUNT(*) as c FROM learning_map_nodes WHERE node_level = 3').get();
console.log(`📊 노드당 2개 이상 매핑: ${mappedTwo.c} / ${totalNodes.c} 차시 노드`);

// 기존 1번째 문항 제목도 동일 형식으로 업데이트 (lesson_name 기반)
console.log('\n기존 1번째 문항 제목 업데이트 중...');
const firstContents = db.prepare(`
  SELECT c.id, cq.question_text, ccn.std_id
  FROM contents c
  JOIN content_content_nodes ccn ON ccn.content_id = c.id
  LEFT JOIN content_questions cq ON cq.content_id = c.id AND cq.question_number = 1
  WHERE c.creator_id = 1 AND c.content_type = 'quiz'
    AND c.title NOT LIKE '% (2)%'
    AND c.id >= 393
`).all();

const updateTitle = db.prepare('UPDATE contents SET title = ? WHERE id = ?');
const getNode = db.prepare('SELECT lesson_name FROM learning_map_nodes WHERE node_id = ?');
const getEbsNo = db.prepare("SELECT content_url FROM contents WHERE id = ?");

let titleUpdated = 0;
const tx2 = db.transaction(() => {
  for (const row of firstContents) {
    if (!row.std_id) continue;
    const node = getNode.get(row.std_id);
    if (!node) continue;

    const urlRow = getEbsNo.get(row.id);
    const ebsNo  = urlRow && urlRow.content_url
      ? (urlRow.content_url.match(/itemId=(\d+)/) || [])[1] || ''
      : '';

    const newTitle = ebsNo
      ? `${node.lesson_name} 연습문제 1 (EBS ${ebsNo})`
      : `${node.lesson_name} 연습문제 1`;

    updateTitle.run(newTitle, row.id);
    titleUpdated++;
  }
});
tx2();
console.log(`✅ 1번째 문항 제목 업데이트: ${titleUpdated}개`);

db.close();
