/**
 * EBS 문항(3개) + 유튜브 영상(3개) → 채움콘텐츠(공개·승인) → AI 맞춤학습 매핑
 *
 * 선택 문항: 학년 다양성 확보 (2학년 / 4학년 / 6학년)
 *   1. E2MATA01B01C04D01 - 2학년, 세 자리 수의 자릿값 (EBS 21040751)
 *   2. E4MATA01B01C01D01 - 4학년, 다섯 자리 수의 자릿값 (EBS 21284018)
 *   3. E6MATA01B10C37D03 - 6학년, 분수의 나눗셈 (EBS 21136413)
 *
 * 유튜브 영상: 각 학년·단원에 대응하는 한국 초등 수학 강의
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
const ADMIN_ID = 1;

// ── 1. EBS 문항 데이터 (xlsx 파싱 결과 + DB 매핑 확인 완료) ─────────────────
const EBS_QUESTIONS = [
  {
    stdId: 'E2MATA01B01C04D01',
    ebsNo: '21040751',
    grade: 2,
    subject: '수학',
    area: '수와 연산',
    unit: '세 자리 수',
    topic: '세 자리 수',
    achievementCode: '[2수01-02]',
    lessonName: '세 자리 수의 자릿값과 위치적 기수법',
    diffLabel: '중하',
    difficulty: 2,
    answer: '3',          // 실제 정답 (보기 번호)
    stem: '[2수01-02] 세 자리 수 — 자릿값과 위치적 기수법\n\n다음 중 247에서 4가 나타내는 값은 얼마입니까?',
    options: ['4', '40', '400', '4000', '40000'],
    answerIdx: '1',       // 0-based index → 40
    explanation: '247에서 4는 십의 자리 숫자입니다. 십의 자리 숫자 4는 40을 나타냅니다. 각 자릿값: 2=200(백), 4=40(십), 7=7(일).',
  },
  {
    stdId: 'E4MATA01B01C01D01',
    ebsNo: '21284018',
    grade: 4,
    subject: '수학',
    area: '수와 연산',
    unit: '큰 수',
    topic: '다섯 자리 이상의 수',
    achievementCode: '[4수01-01]',
    lessonName: '다섯 자리 수의 자릿값과 위치적 기수법 이해하기',
    diffLabel: '하',
    difficulty: 1,
    answer: '4',
    stem: '[4수01-01] 큰 수 — 다섯 자리 이상의 수\n\n53,782에서 만의 자리 숫자가 나타내는 값은 얼마입니까?',
    options: ['5', '500', '5000', '50000', '500000'],
    answerIdx: '3',       // 50000
    explanation: '53,782에서 만의 자리는 5이며, 5×10,000=50,000을 나타냅니다. 각 자릿값: 5=50000(만), 3=3000(천), 7=700(백), 8=80(십), 2=2(일).',
  },
  {
    stdId: 'E6MATA01B10C37D03',
    ebsNo: '21136413',
    grade: 6,
    subject: '수학',
    area: '수와 연산',
    unit: '분수의 나눗셈',
    topic: '(자연수)÷(자연수)의 몫을 분수로 나타내기',
    achievementCode: '[6수01-10]',
    lessonName: '몫이 1보다 큰 (자연수)÷(자연수)의 몫을 분수로 나타내기',
    diffLabel: '중',
    difficulty: 3,
    answer: '3',
    stem: '[6수01-10] 분수의 나눗셈 — (자연수)÷(자연수)의 몫을 분수로 나타내기\n\n7÷4를 분수로 나타내면 얼마입니까?',
    options: ['4/7', '1과 2/7', '1과 3/4', '7/4와 1과 3/4는 같음', '2'],
    answerIdx: '2',       // 1과 3/4 = 7/4
    explanation: '7÷4=7/4이고, 이를 대분수로 나타내면 1과 3/4입니다. 몫이 1보다 크면 자연수 부분(1)과 분수 부분(3/4)으로 나타냅니다.',
  },
];

// ── 2. 유튜브 영상 데이터 ───────────────────────────────────────────────────
const YOUTUBE_VIDEOS = [
  {
    stdId: 'E2MATA01B01C04D01',
    grade: 2,
    subject: '수학',
    title: '[초등 2학년 수학] 세 자리 수를 알아볼까요 — 재미수학',
    description: '초등학교 2학년 1학기 수학 세 자리 수 단원. 자릿값(백의 자리·십의 자리·일의 자리)의 개념을 시각적으로 쉽게 설명합니다.',
    contentUrl: 'https://www.youtube.com/watch?v=tmEUXaNIR7A',
    achievementCode: '[2수01-02]',
    tags: ['수학', '수와 연산', '세 자리 수', '자릿값', '2학년', '유튜브'],
  },
  {
    stdId: 'E4MATA01B01C01D01',
    grade: 4,
    subject: '수학',
    title: '[수개념] 4-1-1. 큰 수 — 다섯 자리 수 알아보기',
    description: '초등학교 4학년 1학기 수학 큰 수 단원. 다섯 자리 이상의 수(십만, 백만, 천만)의 자릿값 개념과 읽는 방법을 설명합니다.',
    contentUrl: 'https://www.youtube.com/watch?v=4dPb1QOd2VY',
    achievementCode: '[4수01-01]',
    tags: ['수학', '수와 연산', '큰 수', '다섯 자리 수', '4학년', '유튜브'],
  },
  {
    stdId: 'E6MATA01B10C37D03',
    grade: 6,
    subject: '수학',
    title: '분수의 나눗셈 — (자연수)÷(자연수)의 몫을 분수로 나타내어 볼까요(1) [당근쌤]',
    description: '초등학교 6학년 1학기 수학 분수의 나눗셈 단원. (자연수)÷(자연수)의 몫을 분수로 나타내는 방법을 교과서 10~11쪽 기준으로 설명합니다.',
    contentUrl: 'https://www.youtube.com/watch?v=sPZ7TNsrQ0U',
    achievementCode: '[6수01-10]',
    tags: ['수학', '수와 연산', '분수의 나눗셈', '자연수', '6학년', '유튜브', '당근쌤'],
  },
];

// ── Prepared Statements ───────────────────────────────────────────────────────
const insertContent = db.prepare(`
  INSERT INTO contents (
    creator_id, title, description, content_type, content_url, file_path,
    subject, grade, achievement_code, tags, is_public, status,
    difficulty, copyright, allow_comments, created_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, 'approved', ?, 'CC-BY', 1, datetime('now'))
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
  VALUES (?, ?, ?, ?)
`);

const checkMapNode = db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_id = ?');

const checkDuplicateContent = db.prepare(`
  SELECT id FROM contents
  WHERE creator_id = ? AND achievement_code = ? AND content_type = ? AND title LIKE ?
  LIMIT 1
`);

// ── Transaction ───────────────────────────────────────────────────────────────
const tx = db.transaction(() => {
  const results = { quiz: [], video: [] };

  // ① EBS 퀴즈 콘텐츠
  for (let i = 0; i < EBS_QUESTIONS.length; i++) {
    const q = EBS_QUESTIONS[i];
    const title = `${q.achievementCode} ${q.topic} — EBS ${q.ebsNo}`;
    const ebsViewerUrl = `https://ai-plus.ebs.co.kr/ebs/xip/landingexplanation.ebs?allView=Y&itemId=${q.ebsNo}`;

    // 중복 체크
    const dup = checkDuplicateContent.get(ADMIN_ID, q.achievementCode, 'quiz', `%EBS ${q.ebsNo}%`);
    if (dup) {
      console.log(`[SKIP] 이미 존재: ${title} (id=${dup.id})`);
      results.quiz.push({ skipped: true, contentId: dup.id, title });
      continue;
    }

    const description = `EBS 라이선스 문항. ${q.area} > ${q.unit} > ${q.topic}. 학년: ${q.grade}학년, 난이도: ${q.diffLabel}.`;
    const tags = JSON.stringify(q.achievementCode ? [q.subject, q.area, q.unit, `EBS-${q.ebsNo}`, q.achievementCode] : [q.subject, q.area, q.unit]);

    const ci = insertContent.run(
      ADMIN_ID, title, description, 'quiz', ebsViewerUrl,
      q.subject, q.grade, q.achievementCode, tags, q.difficulty
    );
    const contentId = ci.lastInsertRowid;

    insertQuestion.run(
      contentId, q.stem, JSON.stringify(q.options), q.answerIdx, q.explanation, q.difficulty
    );
    insertStdId.run(contentId, q.stdId);

    const mapNode = checkMapNode.get(q.stdId);
    if (mapNode) {
      insertNodeMapping.run(q.stdId, contentId, 'practice', i);
    }

    results.quiz.push({ contentId, ebsNo: q.ebsNo, stdId: q.stdId, mapped: !!mapNode, title });
  }

  // ② 유튜브 영상 콘텐츠
  for (let i = 0; i < YOUTUBE_VIDEOS.length; i++) {
    const v = YOUTUBE_VIDEOS[i];

    // 중복 체크
    const dup = checkDuplicateContent.get(ADMIN_ID, v.achievementCode, 'video', `%${v.contentUrl.slice(-11)}%`);
    if (dup) {
      console.log(`[SKIP] 이미 존재: ${v.title} (id=${dup.id})`);
      results.video.push({ skipped: true, contentId: dup.id, title: v.title });
      continue;
    }

    const tags = JSON.stringify(v.tags);
    const ci = insertContent.run(
      ADMIN_ID, v.title, v.description, 'video', v.contentUrl,
      v.subject, v.grade, v.achievementCode, tags, 2
    );
    const contentId = ci.lastInsertRowid;

    insertStdId.run(contentId, v.stdId);

    const mapNode = checkMapNode.get(v.stdId);
    if (mapNode) {
      insertNodeMapping.run(v.stdId, contentId, 'lecture', i + 10);
    }

    results.video.push({ contentId, stdId: v.stdId, mapped: !!mapNode, title: v.title, url: v.contentUrl });
  }

  return results;
});

const out = tx();

console.log('\n✅ EBS 문항 import 완료:');
out.quiz.forEach(r => {
  if (r.skipped) console.log(`  [건너뜀] id=${r.contentId} "${r.title}"`);
  else console.log(`  content_id=${r.contentId}  EBS=${r.ebsNo}  std=${r.stdId}  AI맞춤학습=${r.mapped}  "${r.title}"`);
});

console.log('\n✅ 유튜브 영상 import 완료:');
out.video.forEach(r => {
  if (r.skipped) console.log(`  [건너뜀] id=${r.contentId} "${r.title}"`);
  else console.log(`  content_id=${r.contentId}  std=${r.stdId}  AI맞춤학습=${r.mapped}  "${r.title}"`);
});

db.close();
