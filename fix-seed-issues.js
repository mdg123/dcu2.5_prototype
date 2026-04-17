// fix-seed-issues.js
// 일회성 데이터 시드 정합성 수정 스크립트
// 실행: node fix-seed-issues.js
const db = require('better-sqlite3')('data/dacheum.db');

const log = (...a) => console.log(...a);
const samples = [];

function parseOptions(s) {
  if (!s) return null;
  try {
    const arr = JSON.parse(s);
    // strip leading '①②③④⑤' or '1.' etc
    return arr.map(o => String(o).replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').replace(/^\d+[.)]\s*/, '').trim());
  } catch { return null; }
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }

function reduceFraction(n, d) {
  const g = gcd(n, d);
  return [n / g, d / g];
}

function computeArithmetic(text) {
  // remove LaTeX wrappers
  const t = text.replace(/\$/g, '').replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2');

  // fraction addition/subtraction same denom: a/b + c/b
  let m = t.match(/(\d+)\/(\d+)\s*([+\-])\s*(\d+)\/(\d+)/);
  if (m) {
    const a = +m[1], b = +m[2], op = m[3], c = +m[4], d = +m[5];
    if (b === d) {
      const num = op === '+' ? a + c : a - c;
      return [`${num}/${b}`, `${num/b}`, reduceFraction(num, b).join('/')];
    }
  }

  // fraction reduction: 6/8을 약분 -> find 기약분수
  m = t.match(/(\d+)\/(\d+).*(약분|기약)/);
  if (m) {
    const [n, d] = reduceFraction(+m[1], +m[2]);
    return [`${n}/${d}`];
  }

  // decimal/integer binary op
  m = t.match(/(\d+(?:\.\d+)?)\s*([+\-×x*÷\/])\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const a = parseFloat(m[1]); const b = parseFloat(m[3]);
    let op = m[2];
    let v;
    if (op === '+') v = a + b;
    else if (op === '-') v = a - b;
    else if (op === '×' || op === 'x' || op === '*') v = a * b;
    else if (op === '÷' || op === '/') v = a / b;
    // format: keep up to 2 decimals, trim trailing zero
    const s1 = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
    return [s1];
  }
  return [];
}

function normalizeForMatch(s) {
  return String(s).replace(/\s+/g, '').replace(/[()\s]/g, '').toLowerCase();
}

function findIndexInOptions(options, candidates) {
  const nopts = options.map(normalizeForMatch);
  for (const cand of candidates) {
    const nc = normalizeForMatch(cand);
    for (let i = 0; i < nopts.length; i++) {
      if (nopts[i] === nc) return i + 1;
      // also accept if option contains candidate or vice-versa exactly
      if (nopts[i].includes(nc) && nc.length >= 1) return i + 1;
    }
  }
  return 0;
}

function extractFromExplanation(exp) {
  if (!exp) return [];
  const out = [];
  // "답 3/10" or "= 3/10" or just "3/10"
  const fracs = exp.match(/\d+\/\d+/g) || [];
  out.push(...fracs);
  // "=4.3" or "= 4.3" or "정답은 4.3"
  const m = exp.match(/=\s*(-?\d+(?:\.\d+)?)/);
  if (m) out.push(m[1]);
  const m2 = exp.match(/정답[은:]\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)/);
  if (m2) out.push(m2[1]);
  // any number
  const nums = exp.match(/-?\d+(?:\.\d+)?/g) || [];
  out.push(...nums);
  return out;
}

// ========================================
// ISSUE 1: content_questions answer fix
// ========================================
log('\n=== ISSUE 1: content_questions 정답 정합성 수정 ===');
const qrows = db.prepare(`
  SELECT id, question_text, options, answer, explanation
  FROM content_questions
  WHERE options IS NOT NULL AND options != ''
`).all();
log('검사 대상:', qrows.length);

const upd = db.prepare('UPDATE content_questions SET answer = ? WHERE id = ?');
let fixed = 0;

const fixTx = db.transaction(() => {
  for (const q of qrows) {
    const opts = parseOptions(q.options);
    if (!opts || opts.length === 0) continue;

    // get computed answer candidates from question_text (arithmetic)
    const computed = computeArithmetic(q.question_text || '');
    // also candidates from explanation
    const fromExp = extractFromExplanation(q.explanation || '');
    const candidates = [...computed, ...fromExp];

    if (candidates.length === 0) continue;

    const correctIdx = findIndexInOptions(opts, candidates);
    if (correctIdx === 0) continue;

    const cur = parseInt(q.answer, 10);
    if (cur !== correctIdx) {
      if (samples.length < 10) {
        samples.push({
          id: q.id,
          text: q.question_text,
          options: opts,
          before: q.answer,
          after: String(correctIdx),
          explanation: q.explanation,
          candidates
        });
      }
      upd.run(String(correctIdx), q.id);
      fixed++;
    }
  }
});
fixTx();
log('수정 건수:', fixed);
log('샘플 10건 before/after:');
samples.forEach(s => log(JSON.stringify(s)));

// ========================================
// ISSUE 2: node_contents 학년 불일치
// ========================================
log('\n=== ISSUE 2: node_contents 학년 불일치 수정 ===');
function normalizeGrade(g) {
  if (g == null) return null;
  if (typeof g === 'number') return g;
  const m = String(g).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const allNC = db.prepare(`
  SELECT nc.id as nc_id, nc.node_id, nc.content_id,
         n.grade as n_grade, n.grade_level as n_gl, n.unit_name as n_unit,
         c.grade as c_grade, c.subject as c_subject, c.title as c_title
  FROM node_contents nc
  JOIN learning_map_nodes n ON n.node_id = nc.node_id
  JOIN contents c ON c.id = nc.content_id
`).all();

let nc_deleted = 0;
const delNC = db.prepare('DELETE FROM node_contents WHERE id = ?');
// also normalize contents.grade to INT value in place
const updContentGrade = db.prepare('UPDATE contents SET grade = ? WHERE id = ?');
const normalizeTx = db.transaction(() => {
  // normalize contents.grade text "3학년" -> 3 (keep school_level if set, but leaving as-is is safe since col type is mixed)
  const ctrows = db.prepare("SELECT id, grade FROM contents WHERE typeof(grade) = 'text'").all();
  for (const r of ctrows) {
    const n = normalizeGrade(r.grade);
    if (n != null) updContentGrade.run(n, r.id);
  }
});
normalizeTx();

const mismatches = [];
for (const r of allNC) {
  const cg = normalizeGrade(r.c_grade);
  const ng = r.n_grade;
  if (cg != null && cg !== ng) mismatches.push({ ...r, c_grade_norm: cg });
}
log('초기 학년 불일치:', mismatches.length);

const delTx = db.transaction(() => {
  for (const m of mismatches) {
    delNC.run(m.nc_id);
    nc_deleted++;
  }
});
delTx();
log('삭제된 매핑:', nc_deleted);
log('샘플 삭제 5건:', JSON.stringify(mismatches.slice(0, 5)));

// ========================================
// ISSUE 3: 중·고등 학습맵 노드 시드
// ========================================
log('\n=== ISSUE 3: 중·고등 학습맵 노드 추가 ===');

const secondarySeed = [
  // 중1
  { node_id: 'M-M1-1-01', grade_level: '중', grade: 1, semester: 1, area: '수와 연산', unit_name: '소인수분해', lesson_name: '소인수분해의 뜻', achievement_code: '9수01-01', achievement_text: '소인수분해의 뜻을 알고, 자연수를 소인수분해할 수 있다.' },
  { node_id: 'M-M1-1-02', grade_level: '중', grade: 1, semester: 1, area: '수와 연산', unit_name: '정수와 유리수', lesson_name: '정수와 유리수의 뜻', achievement_code: '9수01-02', achievement_text: '양수와 음수, 정수와 유리수의 개념을 이해한다.' },
  { node_id: 'M-M1-1-03', grade_level: '중', grade: 1, semester: 1, area: '문자와 식', unit_name: '문자의 사용과 식', lesson_name: '일차방정식', achievement_code: '9수02-01', achievement_text: '일차방정식을 풀고 활용한다.' },
  { node_id: 'M-M1-2-01', grade_level: '중', grade: 1, semester: 2, area: '기하', unit_name: '기본도형', lesson_name: '점, 선, 면', achievement_code: '9수04-01', achievement_text: '점, 선, 면의 위치 관계를 이해한다.' },
  { node_id: 'M-M1-2-02', grade_level: '중', grade: 1, semester: 2, area: '기하', unit_name: '평면도형', lesson_name: '삼각형의 성질', achievement_code: '9수04-02', achievement_text: '삼각형의 결정조건과 합동조건을 이해한다.' },
  // 중2
  { node_id: 'M-M2-1-01', grade_level: '중', grade: 2, semester: 1, area: '수와 연산', unit_name: '유리수와 순환소수', lesson_name: '순환소수', achievement_code: '9수01-05', achievement_text: '유리수와 순환소수의 관계를 이해한다.' },
  { node_id: 'M-M2-1-02', grade_level: '중', grade: 2, semester: 1, area: '문자와 식', unit_name: '식의 계산', lesson_name: '단항식과 다항식', achievement_code: '9수02-04', achievement_text: '단항식과 다항식의 계산을 할 수 있다.' },
  { node_id: 'M-M2-1-03', grade_level: '중', grade: 2, semester: 1, area: '함수', unit_name: '일차함수', lesson_name: '일차함수의 그래프', achievement_code: '9수03-01', achievement_text: '일차함수의 그래프를 이해하고 활용한다.' },
  { node_id: 'M-M2-2-01', grade_level: '중', grade: 2, semester: 2, area: '기하', unit_name: '도형의 닮음', lesson_name: '닮음의 뜻', achievement_code: '9수04-05', achievement_text: '닮은 도형의 성질을 이해한다.' },
  { node_id: 'M-M2-2-02', grade_level: '중', grade: 2, semester: 2, area: '확률', unit_name: '확률', lesson_name: '경우의 수와 확률', achievement_code: '9수05-01', achievement_text: '확률의 뜻을 알고 계산할 수 있다.' },
  // 중3
  { node_id: 'M-M3-1-01', grade_level: '중', grade: 3, semester: 1, area: '수와 연산', unit_name: '제곱근과 실수', lesson_name: '제곱근의 뜻', achievement_code: '9수01-08', achievement_text: '제곱근과 무리수의 뜻을 이해한다.' },
  { node_id: 'M-M3-1-02', grade_level: '중', grade: 3, semester: 1, area: '문자와 식', unit_name: '다항식의 곱셈과 인수분해', lesson_name: '인수분해', achievement_code: '9수02-07', achievement_text: '다항식을 인수분해할 수 있다.' },
  { node_id: 'M-M3-1-03', grade_level: '중', grade: 3, semester: 1, area: '문자와 식', unit_name: '이차방정식', lesson_name: '이차방정식의 풀이', achievement_code: '9수02-09', achievement_text: '이차방정식을 풀고 활용한다.' },
  { node_id: 'M-M3-2-01', grade_level: '중', grade: 3, semester: 2, area: '함수', unit_name: '이차함수', lesson_name: '이차함수의 그래프', achievement_code: '9수03-04', achievement_text: '이차함수의 그래프의 성질을 이해한다.' },
  { node_id: 'M-M3-2-02', grade_level: '중', grade: 3, semester: 2, area: '기하', unit_name: '삼각비', lesson_name: '삼각비의 뜻', achievement_code: '9수04-08', achievement_text: '삼각비를 이해하고 활용한다.' },
  // 고1 (공통수학1)
  { node_id: 'M-H1-1-01', grade_level: '고', grade: 1, semester: 1, area: '다항식', unit_name: '다항식의 연산', lesson_name: '다항식의 덧셈과 곱셈', achievement_code: '10공수01-01', achievement_text: '다항식의 사칙연산을 할 수 있다.' },
  { node_id: 'M-H1-1-02', grade_level: '고', grade: 1, semester: 1, area: '다항식', unit_name: '나머지정리와 인수분해', lesson_name: '나머지정리', achievement_code: '10공수01-03', achievement_text: '나머지정리를 이해하고 활용한다.' },
  { node_id: 'M-H1-1-03', grade_level: '고', grade: 1, semester: 1, area: '방정식과 부등식', unit_name: '복소수와 이차방정식', lesson_name: '복소수', achievement_code: '10공수02-01', achievement_text: '복소수의 뜻과 연산을 이해한다.' },
  { node_id: 'M-H1-2-01', grade_level: '고', grade: 1, semester: 2, area: '도형의 방정식', unit_name: '평면좌표와 직선', lesson_name: '두 점 사이의 거리', achievement_code: '10공수03-01', achievement_text: '두 점 사이의 거리를 구할 수 있다.' },
  { node_id: 'M-H1-2-02', grade_level: '고', grade: 1, semester: 2, area: '도형의 방정식', unit_name: '원의 방정식', lesson_name: '원의 방정식', achievement_code: '10공수03-03', achievement_text: '원의 방정식을 이해하고 활용한다.' },
];

const insNode = db.prepare(`
  INSERT OR IGNORE INTO learning_map_nodes
    (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name, achievement_code, achievement_text, node_level, parent_node_id, sort_order)
  VALUES (@node_id, '수학', @grade_level, @grade, @semester, @area, @unit_name, @lesson_name, @achievement_code, @achievement_text, 2, NULL, 1)
`);

const insContent = db.prepare(`
  INSERT INTO contents (creator_id, title, description, content_type, subject, grade, unit_name, achievement_code, school_level, status, is_public, created_at)
  VALUES (1, @title, @desc, 'quiz', '수학', @grade, @unit_name, @achievement_code, @school_level, 'approved', 1, datetime('now'))
`);

const insNodeContent = db.prepare(`
  INSERT INTO node_contents (node_id, content_id, content_role, sort_order)
  VALUES (?, ?, 'quiz', 1)
`);

const insQuestion = db.prepare(`
  INSERT INTO content_questions (content_id, question_number, question_type, question_text, options, answer, explanation, points, difficulty, created_at)
  VALUES (?, ?, 'multiple_choice', ?, ?, ?, ?, 10, 2, datetime('now'))
`);

// Questions per node
const nodeQuestions = {
  'M-M1-1-01': [
    { t: '24를 소인수분해하면?', o: ['2³×3', '2²×3', '2×3²', '2×3×4'], ans: 1, exp: '24 = 2×2×2×3 = 2³×3' },
    { t: '36의 소인수분해는?', o: ['2²×9', '2²×3²', '2³×3', '6²'], ans: 2, exp: '36 = 2²×3²' },
  ],
  'M-M1-1-02': [
    { t: '-3보다 2만큼 큰 수는?', o: ['-5', '-1', '1', '5'], ans: 2, exp: '-3+2=-1' },
    { t: '다음 중 유리수가 아닌 것은?', o: ['0', '-5', '3/4', '√2'], ans: 4, exp: '√2는 무리수' },
  ],
  'M-M1-1-03': [
    { t: '2x+3=11을 풀면 x=?', o: ['2', '3', '4', '5'], ans: 3, exp: '2x=8, x=4' },
    { t: 'x-5=10을 풀면 x=?', o: ['5', '10', '15', '20'], ans: 3, exp: 'x=15' },
  ],
  'M-M1-2-01': [
    { t: '두 직선이 한 점에서 만날 때의 각의 개수는?', o: ['2', '4', '6', '8'], ans: 2, exp: '맞꼭지각 포함 4개' },
  ],
  'M-M1-2-02': [
    { t: '정삼각형 한 내각의 크기는?', o: ['45°', '60°', '90°', '120°'], ans: 2, exp: '180°/3=60°' },
  ],
  'M-M2-1-01': [
    { t: '1/3을 소수로 나타내면?', o: ['0.3', '0.33', '0.333...', '0.3333'], ans: 3, exp: '순환소수 0.333...' },
  ],
  'M-M2-1-02': [
    { t: '(3x)²=?', o: ['3x²', '6x²', '9x', '9x²'], ans: 4, exp: '3²x²=9x²' },
    { t: '2a × 3a²=?', o: ['5a²', '5a³', '6a²', '6a³'], ans: 4, exp: '2×3=6, a×a²=a³' },
  ],
  'M-M2-1-03': [
    { t: 'y=2x+1에서 x=3일 때 y=?', o: ['5', '6', '7', '8'], ans: 3, exp: '2×3+1=7' },
  ],
  'M-M2-2-01': [
    { t: '닮음비가 2:3인 두 도형의 넓이비는?', o: ['2:3', '4:6', '4:9', '8:27'], ans: 3, exp: '넓이비는 닮음비의 제곱' },
  ],
  'M-M2-2-02': [
    { t: '동전 한 개를 던질 때 앞면이 나올 확률은?', o: ['1/4', '1/3', '1/2', '1'], ans: 3, exp: '2가지 중 1가지' },
  ],
  'M-M3-1-01': [
    { t: '√9의 값은?', o: ['1', '2', '3', '9'], ans: 3, exp: '3²=9' },
    { t: '√16의 값은?', o: ['2', '4', '8', '16'], ans: 2, exp: '4²=16' },
  ],
  'M-M3-1-02': [
    { t: 'x²-4를 인수분해하면?', o: ['(x-2)²', '(x+2)²', '(x-2)(x+2)', 'x(x-4)'], ans: 3, exp: '합·차 공식' },
  ],
  'M-M3-1-03': [
    { t: 'x²-5x+6=0의 해는?', o: ['x=1,2', 'x=2,3', 'x=3,4', 'x=1,6'], ans: 2, exp: '(x-2)(x-3)=0' },
  ],
  'M-M3-2-01': [
    { t: 'y=x²의 꼭짓점 좌표는?', o: ['(0,0)', '(1,1)', '(0,1)', '(1,0)'], ans: 1, exp: '원점이 꼭짓점' },
  ],
  'M-M3-2-02': [
    { t: 'sin 30°의 값은?', o: ['1/2', '√2/2', '√3/2', '1'], ans: 1, exp: '삼각비 표준값' },
  ],
  'M-H1-1-01': [
    { t: '(x+1)+(x+2)=?', o: ['2x+3', '2x+1', 'x+3', '2x'], ans: 1, exp: '2x+3' },
  ],
  'M-H1-1-02': [
    { t: 'P(x)=x²+1을 x-1로 나눈 나머지는?', o: ['0', '1', '2', '3'], ans: 3, exp: 'P(1)=1+1=2' },
  ],
  'M-H1-1-03': [
    { t: 'i²의 값은?', o: ['-1', '0', '1', 'i'], ans: 1, exp: '허수 단위 정의' },
  ],
  'M-H1-2-01': [
    { t: '점(0,0)과 (3,4) 사이의 거리는?', o: ['3', '4', '5', '7'], ans: 3, exp: '√(9+16)=5' },
  ],
  'M-H1-2-02': [
    { t: '중심(0,0), 반지름 2인 원의 방정식은?', o: ['x²+y²=2', 'x²+y²=4', 'x+y=2', 'x²+y²=1'], ans: 2, exp: 'r²=4' },
  ],
};

let addedNodes = 0, addedContents = 0, addedQuestions = 0;
const findExistingMapping = db.prepare(`SELECT content_id FROM node_contents WHERE node_id = ? LIMIT 1`);
const countQuestions = db.prepare(`SELECT COUNT(*) c FROM content_questions WHERE content_id = ?`);
const seedTx = db.transaction(() => {
  for (const n of secondarySeed) {
    const r = insNode.run(n);
    if (r.changes > 0) addedNodes++;
    // Idempotent: skip content/questions if mapping already exists
    const existing = findExistingMapping.get(n.node_id);
    if (existing) continue;
    const schoolLevel = n.grade_level === '중' ? '중학교' : '고등학교';
    const cr = insContent.run({
      title: `${n.unit_name} 기본 문항`,
      desc: `${n.lesson_name} 학습 문항`,
      grade: n.grade,
      unit_name: n.unit_name,
      achievement_code: n.achievement_code,
      school_level: schoolLevel,
    });
    const contentId = cr.lastInsertRowid;
    addedContents++;
    insNodeContent.run(n.node_id, contentId);
    const qs = nodeQuestions[n.node_id] || [
      { t: `${n.lesson_name} 확인 문제`, o: ['보기1', '보기2', '보기3', '보기4'], ans: 1, exp: '기본 개념 확인' },
    ];
    qs.forEach((q, i) => {
      const opts = JSON.stringify(q.o.map((x, j) => `${'①②③④⑤'[j]}${x}`));
      insQuestion.run(contentId, i + 1, q.t, opts, String(q.ans), q.exp);
      addedQuestions++;
    });
  }
});
seedTx();
log('추가된 노드:', addedNodes);
log('추가된 컨텐츠:', addedContents);
log('추가된 문항:', addedQuestions);
log('학습맵 노드 현황:');
db.prepare('SELECT grade_level, grade, COUNT(*) c FROM learning_map_nodes GROUP BY grade_level, grade ORDER BY grade_level, grade').all().forEach(r => log(' ', JSON.stringify(r)));

// ========================================
// ISSUE 4: wrong_answers subject/unit_name 백필
// ========================================
log('\n=== ISSUE 4: wrong_answers 메타정보 백필 ===');
const beforeNull = db.prepare(`SELECT COUNT(*) c FROM wrong_answers WHERE unit_name IS NULL OR achievement_code IS NULL OR subject IS NULL`).get().c;
log('백필 대상:', beforeNull);

// Strategy: match by question_text against content_questions → contents → node_contents → learning_map_nodes
const waRows = db.prepare(`SELECT id, question_text, subject FROM wrong_answers WHERE unit_name IS NULL OR achievement_code IS NULL OR subject IS NULL`).all();
const updWA = db.prepare('UPDATE wrong_answers SET subject = COALESCE(?, subject), unit_name = ?, achievement_code = ? WHERE id = ?');

let waFixed = 0;
const waTx = db.transaction(() => {
  for (const w of waRows) {
    if (!w.question_text) continue;
    // Find matching content question
    const cq = db.prepare(`
      SELECT cq.content_id, c.subject, c.unit_name as c_unit, c.achievement_code as c_ach
      FROM content_questions cq
      JOIN contents c ON c.id = cq.content_id
      WHERE cq.question_text = ?
      LIMIT 1
    `).get(w.question_text);
    if (!cq) continue;
    let unit = cq.c_unit, ach = cq.c_ach, subj = cq.subject;
    if (!unit || !ach) {
      const node = db.prepare(`
        SELECT n.unit_name, n.achievement_code, n.subject
        FROM node_contents nc
        JOIN learning_map_nodes n ON n.node_id = nc.node_id
        WHERE nc.content_id = ?
        LIMIT 1
      `).get(cq.content_id);
      if (node) {
        unit = unit || node.unit_name;
        ach = ach || node.achievement_code;
        subj = subj || node.subject;
      }
    }
    if (unit || ach) {
      updWA.run(subj || w.subject, unit || null, ach || null, w.id);
      waFixed++;
    }
  }
});
waTx();
log('백필 건수:', waFixed);
const afterNull = db.prepare(`SELECT COUNT(*) c FROM wrong_answers WHERE unit_name IS NULL AND achievement_code IS NULL`).get().c;
log('수정 후 양쪽 null 남음:', afterNull);

// Fallback: for any remaining null, infer from question_text heuristics to math units
const stillNull = db.prepare(`SELECT id, question_text FROM wrong_answers WHERE unit_name IS NULL`).all();
const heur = [
  { re: /분수|\/\d/, subj: '수학', unit: '분수의 덧셈과 뺄셈', ach: '4수01-10' },
  { re: /소수|\d+\.\d+/, subj: '수학', unit: '소수의 덧셈과 뺄셈', ach: '4수01-14' },
  { re: /×|곱/, subj: '수학', unit: '곱셈과 나눗셈', ach: '4수01-05' },
  { re: /÷|나눗/, subj: '수학', unit: '곱셈과 나눗셈', ach: '4수01-06' },
  { re: /각도|°/, subj: '수학', unit: '각도', ach: '4수02-05' },
  { re: /광합성|잎|기공/, subj: '과학', unit: '식물의 구조와 기능', ach: '6과05-01' },
  { re: /뿌리|줄기/, subj: '과학', unit: '식물의 구조와 기능', ach: '6과05-02' },
  { re: /높임말|윗사람/, subj: '국어', unit: '높임 표현', ach: '4국04-04' },
  { re: /빈칸|알맞은 말/, subj: '국어', unit: '문장 완성', ach: '4국04-03' },
];
const heurTx = db.transaction(() => {
  for (const w of stillNull) {
    if (!w.question_text) continue;
    for (const h of heur) {
      if (h.re.test(w.question_text)) {
        updWA.run(h.subj, h.unit, h.ach, w.id);
        waFixed++;
        break;
      }
    }
  }
});
heurTx();
log('휴리스틱 포함 최종 백필:', waFixed);
const finalNull = db.prepare(`SELECT COUNT(*) c FROM wrong_answers WHERE unit_name IS NULL`).get().c;
log('최종 unit_name null:', finalNull);

// ========================================
// ISSUE 5: diagnosis_sessions 찌꺼기 정리
// ========================================
log('\n=== ISSUE 5: diagnosis_sessions 정리 ===');
const stale = db.prepare(`SELECT id, user_id, started_at FROM diagnosis_sessions WHERE status='in_progress' AND total_questions=0`).all();
log('찌꺼기 건수:', stale.length);
const delStale = db.prepare(`DELETE FROM diagnosis_sessions WHERE id = ?`);
const delStaleAns = db.prepare(`DELETE FROM diagnosis_answers WHERE session_id = ?`);
const stTx = db.transaction(() => {
  for (const s of stale) {
    delStaleAns.run(s.id);
    delStale.run(s.id);
  }
});
stTx();
log('삭제 완료:', stale.length);

// ========================================
// FINAL
// ========================================
log('\n=== 최종 요약 ===');
log('ISSUE 1 수정:', fixed, '/ 검사:', qrows.length);
log('ISSUE 2 삭제 매핑:', nc_deleted);
log('ISSUE 3 추가 노드/컨텐츠/문항:', addedNodes, '/', addedContents, '/', addedQuestions);
log('ISSUE 4 오답노트 백필:', waFixed, '/ 남은 null:', finalNull);
log('ISSUE 5 찌꺼기 삭제:', stale.length);

db.close();
