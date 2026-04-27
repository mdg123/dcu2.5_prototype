/**
 * EBS 문항 → 채움콘텐츠 (공개·승인됨) → AI 맞춤학습(node_contents) 매핑 import
 *
 * 출처: 4. EBS_문항메타데이터_KOFAC기준매핑_v1.xlsx
 * 시트: 초등 (sheet index 2), header=1
 * 대상: 과목=수학, 3단계 ID 채워진 행 중 첫 3건
 *
 * 흐름:
 *   1) 관리자(admin)로 직접 DB에 quiz 콘텐츠 생성 (status=approved, is_public=1)
 *   2) content_questions에 문항 본문/정답 저장
 *   3) content_content_nodes 에 std_id 매핑 등록
 *   4) node_contents 에 learning_map_nodes의 node_id 매핑 (AI 맞춤학습 노출용)
 *
 * 주의: EBS 문항 뷰어 본문은 별도 시스템이라 외부 접근 불가 — 본 스크립트에서는
 *       메타데이터(핵심·평가요소·정답)와 std_id의 lesson_name을 합성하여
 *       데모용 문항 본문을 구성한다. 실제 EBS 본문은 EBS 측에서 XML 재전달 시 교체.
 */

const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const XLSX_PATH = path.resolve(__dirname, '..', '..', '..', '..', '교육과정표준체계_최종산출물_202412', '4. EBS_문항메타데이터_KOFAC기준매핑_v1.xlsx');
const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');

const db = new Database(DB_PATH);
const ADMIN_ID = 1;

// 1) xlsx 파싱 — 초등 시트, 수학 + 3단계ID 채워진 행
const wb = XLSX.readFile(XLSX_PATH);
const sheet = wb.Sheets[wb.SheetNames[2]]; // 초등
const rows = XLSX.utils.sheet_to_json(sheet, { range: 1, defval: null });
const mathRowsWithStdId = rows.filter(r => r['과목'] === '수학' && r['3단계 ID']);
console.log(`[xlsx] 초등 수학 + 3단계ID 채워진 행: ${mathRowsWithStdId.length}건`);

// 처음 3건 선택 (모두 동일 std_id E2MATA01B01C02D01 = "9까지의 수 세기")
const selected = mathRowsWithStdId.slice(0, 3);

// 2) 각 문항을 콘텐츠로 import
const insertContent = db.prepare(`
  INSERT INTO contents (
    creator_id, title, description, content_type, content_url, file_path,
    subject, grade, achievement_code, tags, is_public, status,
    difficulty, copyright, allow_comments, created_at
  ) VALUES (?, ?, ?, 'quiz', NULL, NULL, ?, ?, ?, ?, 1, 'approved', ?, 'CC-BY', 1, datetime('now'))
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
  INSERT INTO node_contents (node_id, content_id, content_role, sort_order)
  VALUES (?, ?, 'practice', ?)
`);
const checkMapNode = db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_id = ?');

const tx = db.transaction(() => {
  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const r = selected[i];
    const stdId = String(r['3단계 ID']).trim();
    const ebsKey = Object.keys(r).find(k => k.startsWith('EBS') && k.includes('문항번호'));
    const ebsNo = r[ebsKey];
    const code = r['성취기준'];
    const subject = r['과목'];
    const grade = parseInt(String(r['학년']).match(/\d/)?.[0] || '1', 10);
    const area = r['대분류(내용영역)'];
    const sub1 = r['중분류'] || '';
    const sub2 = r['소분류'] || '';
    const diffLabel = r['난이도'] || '중';
    const correct = String(r['정답']).trim();

    // 데모용 문항 본문 생성 (실제 EBS 본문은 XML 재전달로 교체 필요)
    const stem = `[EBS ${ebsNo}] ${sub1} — ${sub2}\n다음 그림이 나타내는 수를 고르시오.`;
    const opts = ['1', '2', '3', '4', '5'];
    const answerIdx = Math.max(0, Math.min(opts.length - 1, parseInt(correct, 10) - 1));
    const explanation = `이 문항은 ${code} 성취기준의 "${sub2}" 평가요소에 해당합니다. 정답: ${correct}.`;
    const difficulty = ({ '하': 1, '중하': 2, '중': 3, '중상': 4, '상': 5 })[diffLabel] || 3;

    // code 자체에 대괄호가 포함되어 있으므로 그대로 사용
    const title = `${code} ${sub2} — EBS ${ebsNo}`;
    const description = `EBS 라이선스 문항. ${area} > ${sub1} > ${sub2}. 난이도: ${diffLabel}.`;
    const tags = JSON.stringify([subject, area, sub1, `EBS-${ebsNo}`, code]);

    const ci = insertContent.run(ADMIN_ID, title, description, subject, grade, code, tags, difficulty);
    const contentId = ci.lastInsertRowid;

    insertQuestion.run(contentId, stem, JSON.stringify(opts), String(answerIdx), explanation, difficulty);
    insertStdId.run(contentId, stdId);

    // learning_map_nodes 의 node_id 가 std_id 와 동일 — AI 맞춤학습 노드에 매핑
    const mapNode = checkMapNode.get(stdId);
    if (mapNode) {
      insertNodeMapping.run(stdId, contentId, i);
    }

    results.push({ contentId, ebsNo, code, stdId, mapped: !!mapNode });
  }
  return results;
});

const out = tx();
console.log('[import] 완료:');
out.forEach(r => console.log(`  content_id=${r.contentId}  EBS=${r.ebsNo}  ${r.code}  std=${r.stdId}  AI맞춤학습 매핑=${r.mapped}`));
db.close();
