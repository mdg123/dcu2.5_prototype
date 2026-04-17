// seed-self-learn-content.js
// 학습맵 노드에 비디오 1+, 문제 3개 이상 매핑하는 시드 스크립트 (INSERT OR IGNORE)
// 실행: node seed-self-learn-content.js

const db = require('./db/index');
require('./db/self-learn-extended').init();

function seed() {
  const nodes = db.prepare('SELECT node_id, subject, grade, unit_name, lesson_name FROM learning_map_nodes ORDER BY grade, sort_order').all();
  if (nodes.length === 0) {
    console.log('[seed] 학습맵 노드가 없습니다. 먼저 learning_map_nodes를 시딩하세요.');
    return;
  }

  // 기존 콘텐츠 풀 분리
  const videos = db.prepare("SELECT id, title, subject FROM contents WHERE content_type = 'video' AND status = 'approved'").all();
  const problems = db.prepare("SELECT id, title, subject, difficulty FROM contents WHERE content_type IN ('quiz','exam','problem','assessment') AND status = 'approved'").all();

  if (videos.length === 0 || problems.length === 0) {
    console.log('[seed] contents에 video/quiz가 부족합니다. v=', videos.length, 'q=', problems.length);
  }

  const insertNC = db.prepare('INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)');

  let mappings = 0;
  nodes.forEach((node, idx) => {
    // 해당 과목의 영상/문제 선택 (없으면 전체에서 순환)
    const subjectVideos = videos.filter(v => !v.subject || v.subject === node.subject);
    const subjectProblems = problems.filter(p => !p.subject || p.subject === node.subject);
    const vPool = subjectVideos.length > 0 ? subjectVideos : videos;
    const pPool = subjectProblems.length > 0 ? subjectProblems : problems;

    // 비디오 1개
    if (vPool.length > 0) {
      const v = vPool[idx % vPool.length];
      const r = insertNC.run(node.node_id, v.id, 'learn', 0);
      if (r.changes > 0) mappings++;
    }
    // 문제 3개 (다양한 난이도)
    for (let i = 0; i < 3 && pPool.length > 0; i++) {
      const p = pPool[(idx * 3 + i) % pPool.length];
      const r = insertNC.run(node.node_id, p.id, 'practice', i + 1);
      if (r.changes > 0) mappings++;
    }
  });

  console.log(`[seed] node_contents 매핑 ${mappings}개 추가 (노드 ${nodes.length}개)`);

  // 샘플 problem_attempts (학생1이 처음 몇 문제 푼 것처럼)
  const student = db.prepare("SELECT id FROM users WHERE username = 'student1'").get();
  if (student) {
    const sampleProblems = db.prepare(`
      SELECT DISTINCT c.id FROM contents c
      JOIN node_contents nc ON nc.content_id = c.id
      WHERE c.content_type IN ('quiz','exam','problem') LIMIT 5
    `).all();
    const insAttempt = db.prepare(`
      INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, time_taken)
      VALUES (?, ?, ?, ?, ?)
    `);
    sampleProblems.forEach((p, i) => {
      // 이미 있으면 pass
      const exist = db.prepare('SELECT id FROM problem_attempts WHERE user_id = ? AND content_id = ?').get(student.id, p.id);
      if (!exist) {
        insAttempt.run(student.id, p.id, null, i % 2 === 0 ? 1 : 0, 30 + i * 10);
      }
    });
    console.log(`[seed] student1 샘플 시도 기록 완료`);
  }

  // ========== 실제 4지선다 문항 보강 (곱셈구구 / 큰 수 / 각도) ==========
  // 기존 content_questions 데이터의 answer 인덱스가 부정확한 경우를 대비해
  // 깨끗한 문항 콘텐츠를 별도로 INSERT (INSERT OR IGNORE 가 title unique 가 없어서 existence 체크).
  const qBank = [
    {
      title: '곱셈구구 기본 (자동 생성)', subject: '수학', grade: 4, difficulty: 'easy',
      node_candidates: ['M-E4-1-03', 'M-E4-1-04', 'M-E4-1-U02'],
      questions: [
        { q: '7 × 8 = ?',          opts: ['54','56','58','64'],        ans: '2', exp: '7 × 8 = 56 입니다.' },
        { q: '6 × 9 = ?',          opts: ['45','54','56','63'],        ans: '2', exp: '6 × 9 = 54 입니다.' },
        { q: '8 × 7 = ?',          opts: ['48','54','56','63'],        ans: '3', exp: '8 × 7 = 56 입니다.' },
        { q: '9 × 9 = ?',          opts: ['72','81','89','99'],        ans: '2', exp: '9 × 9 = 81 입니다.' },
        { q: '4 × 7 = ?',          opts: ['24','27','28','32'],        ans: '3', exp: '4 × 7 = 28 입니다.' }
      ]
    },
    {
      title: '큰 수 읽기 (자동 생성)', subject: '수학', grade: 4, difficulty: 'medium',
      node_candidates: ['M-E4-1-01', 'M-E4-1-02', 'M-E4-1-U01'],
      questions: [
        { q: '10000 을 바르게 읽은 것은?', opts: ['천','만','십만','백만'],      ans: '2', exp: '10000 은 "만" 입니다.' },
        { q: '100만은 몇 자리 수인가요?',  opts: ['5자리','6자리','7자리','8자리'], ans: '3', exp: '100만 = 1,000,000 (7자리).' },
        { q: '1억은 얼마인가요?',          opts: ['1000만','1억','10억','100억'],   ans: '2', exp: '1억 = 100,000,000 입니다.' }
      ]
    }
  ];

  const teacher = db.prepare("SELECT id FROM users WHERE role='teacher' LIMIT 1").get();
  if (teacher) {
    const findContent = db.prepare("SELECT id FROM contents WHERE title = ? LIMIT 1");
    const insContent = db.prepare(`
      INSERT INTO contents (creator_id, title, description, content_type, subject, grade, status, difficulty, created_at)
      VALUES (?, ?, ?, 'quiz', ?, ?, 'approved', ?, CURRENT_TIMESTAMP)
    `);
    const insQ = db.prepare(`
      INSERT INTO content_questions (content_id, question_number, question_type, question_text, options, answer, explanation, difficulty)
      VALUES (?, ?, 'multiple_choice', ?, ?, ?, ?, 3)
    `);
    let added = 0;
    qBank.forEach(bank => {
      let row = findContent.get(bank.title);
      let cid;
      if (row) { cid = row.id; }
      else {
        const r = insContent.run(teacher.id, bank.title, '자동 시드 4지선다 문항', bank.subject, bank.grade, bank.difficulty);
        cid = r.lastInsertRowid;
        bank.questions.forEach((q, i) => {
          insQ.run(cid, i + 1, q.q, JSON.stringify(q.opts), q.ans, q.exp);
        });
        added++;
      }
      // 가능한 노드에 매핑
      bank.node_candidates.forEach(nid => {
        const nodeOk = db.prepare('SELECT 1 FROM learning_map_nodes WHERE node_id = ?').get(nid);
        if (nodeOk) {
          insertNC.run(nid, cid, 'practice', 9); // sort 9 — 뒤쪽
        }
      });
    });
    console.log(`[seed] 4지선다 문항 콘텐츠 ${added}개 추가, 노드 매핑 완료`);
  }
}

seed();
console.log('[seed] 완료');
