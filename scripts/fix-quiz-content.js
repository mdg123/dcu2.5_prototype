/**
 * 연습문제 본문/보기 자동 생성 — placeholder 문항 → 실제 풀 수 있는 문항으로 변환
 *
 * 차시 노드의 lesson_name + grade + area 패턴에 맞는 문제 템플릿을 적용한다.
 * 적용 후에는 사용자가 실제로 답을 선택하고 풀 수 있게 된다.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);

// 임의 정수 생성 (시드 기반 deterministic)
function seededRand(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000; };
}

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────
// 패턴별 문제 생성기 — lesson_name 기반 매칭
// ─────────────────────────────────────────────────────────────────────────

const KOR_NUM = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
const KOR_NUM2 = ['','일','이','삼','사','오','육','칠','팔','구','십'];

function genCounting(lessonName, max, ebsNo, rng) {
  // "X까지의 수 세기/알기"
  const ans = Math.floor(rng() * (max - 1)) + 1;
  const distractors = new Set();
  while (distractors.size < 4) {
    const d = Math.floor(rng() * max) + 1;
    if (d !== ans) distractors.add(d);
  }
  const options = shuffle([ans, ...distractors], rng);
  const answerIdx = options.indexOf(ans);
  const items = pick(['🍎', '⭐', '🌸', '🎈', '🐱', '🦋'], rng);
  return {
    text: `다음 그림이 나타내는 수는 얼마입니까?\n\n${items.repeat(ans)}`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `그림에는 ${items}가 ${ans}개 있습니다. 따라서 정답은 ${ans}입니다.`,
  };
}

function genReadWrite(lessonName, max, ebsNo, rng) {
  // "수 읽고 쓰기"
  const ans = Math.floor(rng() * Math.min(max, 9)) + 1;
  const correctText = KOR_NUM[ans];
  const distractors = new Set();
  while (distractors.size < 4) {
    const d = Math.floor(rng() * 10) + 1;
    if (d !== ans && d <= 10) distractors.add(KOR_NUM[d]);
  }
  const options = shuffle([correctText, ...distractors], rng);
  const answerIdx = options.indexOf(correctText);
  return {
    text: `숫자 ${ans}을(를) 우리말로 읽으면 무엇입니까?`,
    options,
    answer: String(answerIdx),
    explanation: `${ans}은(는) "${correctText}"이라고 읽습니다.`,
  };
}

function genCompare(lessonName, max, rng) {
  // 수의 크기 비교
  const a = Math.floor(rng() * max) + 1;
  let b;
  do { b = Math.floor(rng() * max) + 1; } while (b === a);
  const ans = Math.max(a, b);
  const distractors = new Set([Math.min(a, b)]);
  while (distractors.size < 4) {
    const d = Math.floor(rng() * max) + 1;
    if (d !== ans) distractors.add(d);
  }
  const options = shuffle([ans, ...distractors], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `${a}과(와) ${b} 중 더 큰 수는 무엇입니까?`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `${a}과(와) ${b}을(를) 비교하면 ${ans}이(가) 더 큽니다.`,
  };
}

function genPlaceValue(lessonName, digits, rng) {
  // 자릿값 (세 자리, 다섯 자리 등)
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  const num = Math.floor(rng() * (max - min)) + min;
  const numStr = String(num);
  const pos = Math.floor(rng() * digits);
  const digit = parseInt(numStr[pos], 10);
  const place = Math.pow(10, digits - 1 - pos);
  const ans = digit * place;
  const placeName = ['', '십', '백', '천', '만', '십만', '백만', '천만'][digits - 1 - pos];
  const distractors = new Set();
  for (let p = 0; p < digits; p++) {
    if (p !== pos) {
      const d = parseInt(numStr[p], 10);
      const v = d * Math.pow(10, digits - 1 - p);
      if (v !== ans && v > 0) distractors.add(v);
    }
  }
  // 부족하면 채우기
  while (distractors.size < 4) {
    const d = Math.floor(rng() * 9) + 1;
    const v = d * Math.pow(10, Math.floor(rng() * digits));
    if (v !== ans) distractors.add(v);
  }
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `${num.toLocaleString('ko-KR')}에서 ${placeName ? placeName + '의 자리' : '일의 자리'} 숫자가 나타내는 값은 얼마입니까?`,
    options: options.map(o => o.toLocaleString('ko-KR')),
    answer: String(answerIdx),
    explanation: `${num.toLocaleString('ko-KR')}의 ${placeName ? placeName + '의 자리' : '일의 자리'} 숫자는 ${digit}이고, ${digit} × ${place.toLocaleString('ko-KR')} = ${ans.toLocaleString('ko-KR')}을 나타냅니다.`,
  };
}

function genAddition(lessonName, range, rng) {
  const a = Math.floor(rng() * range) + 1;
  const b = Math.floor(rng() * range) + 1;
  const ans = a + b;
  const distractors = new Set([ans - 1, ans + 1, ans - 2, ans + 2, a * b]);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `${a} + ${b} = ?`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `${a}에 ${b}을(를) 더하면 ${ans}입니다.`,
  };
}

function genSubtraction(lessonName, range, rng) {
  const a = Math.floor(rng() * range) + 5;
  const b = Math.floor(rng() * (a - 1)) + 1;
  const ans = a - b;
  const distractors = new Set([ans + 1, ans - 1, a + b, ans + 2]);
  distractors.delete(ans);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * range) + 1);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `${a} - ${b} = ?`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `${a}에서 ${b}을(를) 빼면 ${ans}입니다.`,
  };
}

function genMultiplication(rng) {
  const a = Math.floor(rng() * 9) + 1;
  const b = Math.floor(rng() * 9) + 1;
  const ans = a * b;
  const distractors = new Set([ans + a, ans - a, ans + b, ans - b, a + b]);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `${a} × ${b} = ?`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `${a}에 ${b}을(를) 곱하면 ${ans}입니다.`,
  };
}

function genDivision(rng) {
  const b = Math.floor(rng() * 8) + 2;
  const q = Math.floor(rng() * 9) + 1;
  const a = b * q;
  const distractors = new Set([q + 1, q - 1, q + 2, q * 2]);
  distractors.delete(q);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * 12) + 1);
  distractors.delete(q);
  const options = shuffle([q, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(q);
  return {
    text: `${a} ÷ ${b} = ?`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `${a}을(를) ${b}로 나누면 ${q}입니다.`,
  };
}

function genFraction(lessonName, rng) {
  const denom = Math.floor(rng() * 8) + 2;
  const num = Math.floor(rng() * (denom - 1)) + 1;
  const distractors = [
    `${denom}/${num}`,
    `${num + 1}/${denom}`,
    `${num}/${denom + 1}`,
    `${num - 1}/${denom}`,
  ].filter(d => d !== `${num}/${denom}`);
  const correct = `${num}/${denom}`;
  const options = shuffle([correct, ...distractors.slice(0, 4)], rng);
  const answerIdx = options.indexOf(correct);
  return {
    text: `전체를 ${denom}등분한 것 중 ${num}만큼을 분수로 나타내면 무엇입니까?`,
    options,
    answer: String(answerIdx),
    explanation: `전체를 ${denom}등분한 것 중 ${num}만큼은 ${correct}입니다. 분모는 등분한 수, 분자는 그중 일부입니다.`,
  };
}

function genShape(lessonName, rng) {
  const shapes = [
    { name: '삼각형', sides: 3 },
    { name: '사각형', sides: 4 },
    { name: '오각형', sides: 5 },
    { name: '육각형', sides: 6 },
  ];
  const target = pick(shapes, rng);
  const options = shuffle(shapes.map(s => s.name), rng).slice(0, 4);
  if (!options.includes(target.name)) options[0] = target.name;
  const answerIdx = options.indexOf(target.name);
  return {
    text: `변이 ${target.sides}개인 도형의 이름은 무엇입니까?`,
    options,
    answer: String(answerIdx),
    explanation: `변이 ${target.sides}개인 도형은 ${target.name}입니다.`,
  };
}

function genMeasurement(lessonName, rng) {
  const a = Math.floor(rng() * 90) + 10;
  const b = Math.floor(rng() * 90) + 10;
  const ans = Math.max(a, b);
  const distractors = new Set([Math.min(a, b), a + b, Math.abs(a - b)]);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * 100) + 10);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `${a}cm와 ${b}cm 중 더 긴 길이는 얼마입니까?`,
    options: options.map(o => o + 'cm'),
    answer: String(answerIdx),
    explanation: `${a}cm와 ${b}cm를 비교하면 ${ans}cm가 더 깁니다.`,
  };
}

function genPattern(lessonName, rng) {
  const start = Math.floor(rng() * 5) + 1;
  const step = Math.floor(rng() * 4) + 2;
  const seq = [start, start + step, start + step*2, start + step*3];
  const ans = start + step*4;
  const distractors = new Set([ans + step, ans - step, ans + 1, ans - 1]);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return {
    text: `다음 수 배열의 규칙을 찾아 빈칸에 알맞은 수를 구하시오.\n\n${seq.join(', ')}, ?`,
    options: options.map(String),
    answer: String(answerIdx),
    explanation: `이 수열은 ${step}씩 커지는 규칙입니다. 따라서 다음 수는 ${seq[3]} + ${step} = ${ans}입니다.`,
  };
}

function genGraph(lessonName, rng) {
  const counts = [Math.floor(rng()*8)+2, Math.floor(rng()*8)+2, Math.floor(rng()*8)+2, Math.floor(rng()*8)+2];
  const items = ['사과', '바나나', '포도', '딸기'];
  const maxIdx = counts.indexOf(Math.max(...counts));
  const ans = items[maxIdx];
  const options = shuffle(items, rng);
  const answerIdx = options.indexOf(ans);
  const lines = items.map((it, i) => `${it}: ${'■'.repeat(counts[i])} (${counts[i]}명)`).join('\n');
  return {
    text: `반 친구들이 좋아하는 과일을 조사한 결과입니다.\n\n${lines}\n\n가장 많이 좋아하는 과일은 무엇입니까?`,
    options,
    answer: String(answerIdx),
    explanation: `${ans}을(를) 좋아하는 친구가 ${counts[maxIdx]}명으로 가장 많습니다.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// lesson_name 기반 패턴 매칭으로 적절한 문제 생성기 선택
// ─────────────────────────────────────────────────────────────────────────
function generateProblem(lesson, grade, area, ebsNo, sortOrder) {
  const lname = lesson || '';
  const seed = `${ebsNo}_${sortOrder}_${lname}`;
  const rng = seededRand(seed);

  // 분수
  if (/분수|기약|약분|통분|분모|분자/.test(lname)) return genFraction(lname, rng);

  // 자릿값
  if (/자릿값|위치적 기수법|다섯 자리|여섯 자리|큰 수|십만|백만|천만|억|조/.test(lname)) {
    const digits = /다섯/.test(lname) ? 5 : /여섯/.test(lname) ? 6 : /큰 수|십만|백만|천만|억|조/.test(lname) ? 6 : 3;
    return genPlaceValue(lname, digits, rng);
  }

  // 사칙연산
  if (/곱셈|곱하|구구단/.test(lname)) return genMultiplication(rng);
  if (/나눗셈|나누/.test(lname)) return genDivision(rng);
  if (/덧셈|더하|합/.test(lname)) {
    const range = grade <= 1 ? 9 : grade <= 2 ? 99 : grade <= 3 ? 999 : 9999;
    return genAddition(lname, range, rng);
  }
  if (/뺄셈|빼/.test(lname)) {
    const range = grade <= 1 ? 9 : grade <= 2 ? 99 : grade <= 3 ? 999 : 9999;
    return genSubtraction(lname, range, rng);
  }

  // 수 세기/알기/읽고 쓰기
  if (/세기|개수/.test(lname)) {
    const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : /100까지/.test(lname) ? 100 : 9;
    return genCounting(lname, max, ebsNo, rng);
  }
  if (/읽고 쓰기|읽고|쓰기/.test(lname)) {
    const max = /9까지/.test(lname) ? 9 : 10;
    return genReadWrite(lname, max, ebsNo, rng);
  }
  if (/크기 비교|크기|비교/.test(lname)) {
    const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : /100까지/.test(lname) ? 100 : 1000;
    return genCompare(lname, max, rng);
  }
  if (/9까지|50까지|100까지|배열/.test(lname)) {
    const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : 100;
    return genCounting(lname, max, ebsNo, rng);
  }

  // 도형
  if (/삼각형|사각형|오각형|육각형|다각형|평면도형|입체도형|도형/.test(lname)) return genShape(lname, rng);

  // 측정
  if (/길이|cm|m|넓이|들이|무게|시간/.test(lname)) return genMeasurement(lname, rng);

  // 규칙성
  if (/규칙|배열|대응/.test(lname)) return genPattern(lname, rng);

  // 통계/그래프
  if (/그래프|자료|분류|통계|평균|가능성/.test(lname)) return genGraph(lname, rng);

  // 영역 기본 폴백
  if (area === '도형과 측정') return genShape(lname, rng);
  if (area === '변화와 관계') return genPattern(lname, rng);
  if (area === '자료와 가능성') return genGraph(lname, rng);
  // 수와 연산 폴백 - 학년별 기본 문제
  if (grade <= 1) return genCounting(lname, 9, ebsNo, rng);
  if (grade <= 2) return genAddition(lname, 50, rng);
  if (grade <= 3) return genMultiplication(rng);
  return genFraction(lname, rng);
}

// ─────────────────────────────────────────────────────────────────────────
// 실행: placeholder 문항 모두 업데이트
// ─────────────────────────────────────────────────────────────────────────
const problems = db.prepare(`
  SELECT cq.id as q_id, cq.content_id, cq.options, c.title, c.grade, c.achievement_code,
         ccn.std_id, lmn.lesson_name, lmn.area
  FROM content_questions cq
  JOIN contents c ON c.id = cq.content_id
  LEFT JOIN content_content_nodes ccn ON ccn.content_id = c.id
  LEFT JOIN learning_map_nodes lmn ON lmn.node_id = ccn.std_id
  WHERE c.creator_id = 1 AND c.content_type = 'quiz' AND c.id >= 393
`).all();

const updateQ = db.prepare('UPDATE content_questions SET question_text=?, options=?, answer=?, explanation=? WHERE id=?');

let updated = 0, skipped = 0;
const tx = db.transaction(() => {
  for (const p of problems) {
    // 이미 정상 보기인 문항은 건드리지 않음
    try {
      const opts = JSON.parse(p.options);
      if (!opts.every(o => /^[①②③④⑤]$/.test(o))) { skipped++; continue; }
    } catch { skipped++; continue; }

    const ebsMatch = (p.title || '').match(/EBS (\d+)/);
    const ebsNo = ebsMatch ? ebsMatch[1] : String(p.q_id);
    const sortOrder = (p.title || '').includes('연습문제 2') ? 2 : 1;

    const gen = generateProblem(p.lesson_name || '', p.grade || 1, p.area || '수와 연산', ebsNo, sortOrder);

    updateQ.run(gen.text, JSON.stringify(gen.options), gen.answer, gen.explanation, p.q_id);
    updated++;
  }
});
tx();

console.log(`✅ 연습문제 본문/보기 업데이트: ${updated}개`);
console.log(`   기존 정상 문항 유지: ${skipped}개`);

// 검증
const stillBad = db.prepare(`
  SELECT COUNT(*) as c FROM content_questions cq
  JOIN contents c ON c.id = cq.content_id
  WHERE c.creator_id = 1 AND c.content_type = 'quiz' AND c.id >= 393
    AND cq.options LIKE '%["①","②","③","④","⑤"]%'
`).get();
console.log(`📊 남아있는 placeholder 문항: ${stillBad.c}개`);

db.close();
