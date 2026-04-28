/**
 * regenerate-quiz-content.js
 *
 * 자동생성 quiz 콘텐츠(tags LIKE '%자동생성%') 1,348개를 노드의 lesson_name에
 * 정확히 맞도록 재생성한다.
 *
 * 핵심 차이점 (vs fill-missing-questions.js):
 *  - learning_map_nodes.grade_level('초/중/고') 를 함께 사용해 grade=1 충돌 해소
 *  - 중·고등 핵심 용어(여집합/일차함수/이차함수/반직선/정육면체/직육면체 등) 별도 분기
 *  - 폴백 시 임의 산술 문제 대신, lesson_name 자체를 묻는 개념형 MCQ 사용
 *  - 동일 콘텐츠 ID/매핑 유지: UPDATE 만 수행 (DELETE 없음)
 *
 * 실행:
 *   node scripts/regenerate-quiz-content.js          # 본 실행
 *   node scripts/regenerate-quiz-content.js --dry    # 통계만
 *   node scripts/regenerate-quiz-content.js --sample # 30개 샘플 출력
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const DRY = process.argv.includes('--dry');
const SAMPLE = process.argv.includes('--sample');
const db = new Database(DB_PATH);

// -------- RNG ---------------------------------------------------------------
function seededRand(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000; };
}
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function mc(correct, distractors, rng, qText, expl) {
  const distSet = []; const seen = new Set([String(correct)]);
  for (const d of distractors) { const s = String(d); if (!seen.has(s)) { seen.add(s); distSet.push(d); if (distSet.length >= 4) break; } }
  while (distSet.length < 4) { const s = `선택지${distSet.length + 1}`; if (!seen.has(s)) { seen.add(s); distSet.push(s); } }
  const options = shuffle([correct, ...distSet], rng);
  const answerIdx = options.indexOf(correct);
  return { text: qText, options: options.map(String), answer: String(answerIdx), explanation: expl };
}

// -------- 초등 생성기 (기존 유지·확장) ---------------------------------------
const KOR_NUM = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];

function genCounting(_l, max, rng) {
  const ans = Math.floor(rng() * (max - 1)) + 1;
  const distractors = new Set();
  while (distractors.size < 4) { const d = Math.floor(rng() * max) + 1; if (d !== ans) distractors.add(d); }
  const options = shuffle([ans, ...distractors], rng);
  const items = pick(['🍎', '⭐', '🌸', '🎈', '🐱', '🦋'], rng);
  return { text: `다음 그림이 나타내는 수는 얼마입니까?\n\n${items.repeat(ans)}`, options: options.map(String), answer: String(options.indexOf(ans)), explanation: `그림에 ${items}가 ${ans}개 있으므로 정답은 ${ans}입니다.` };
}
function genReadWrite(_l, max, rng) {
  const ans = Math.floor(rng() * Math.min(max, 9)) + 1;
  const correctText = KOR_NUM[ans];
  const distractors = new Set();
  while (distractors.size < 4) { const d = Math.floor(rng() * 10) + 1; if (d !== ans && d <= 10) distractors.add(KOR_NUM[d]); }
  const options = shuffle([correctText, ...distractors], rng);
  return { text: `숫자 ${ans}을(를) 우리말로 읽으면 무엇입니까?`, options, answer: String(options.indexOf(correctText)), explanation: `${ans}은(는) "${correctText}"이라고 읽습니다.` };
}
function genCompare(_l, max, rng) {
  const a = Math.floor(rng() * max) + 1; let b; do { b = Math.floor(rng() * max) + 1; } while (b === a);
  const ans = Math.max(a, b);
  const distractors = new Set([Math.min(a, b)]);
  while (distractors.size < 4) { const d = Math.floor(rng() * max) + 1; if (d !== ans) distractors.add(d); }
  const options = shuffle([ans, ...distractors], rng);
  return { text: `${a}과(와) ${b} 중 더 큰 수는 무엇입니까?`, options: options.map(String), answer: String(options.indexOf(ans)), explanation: `${a}과(와) ${b}을(를) 비교하면 ${ans}이(가) 더 큽니다.` };
}
function genPlaceValue(_l, digits, rng) {
  const min = Math.pow(10, digits - 1); const max = Math.pow(10, digits) - 1;
  const num = Math.floor(rng() * (max - min)) + min;
  const numStr = String(num);
  const pos = Math.floor(rng() * digits);
  const digit = parseInt(numStr[pos], 10);
  const place = Math.pow(10, digits - 1 - pos);
  const ans = digit * place;
  const placeName = ['', '십', '백', '천', '만', '십만', '백만', '천만'][digits - 1 - pos];
  const distractors = new Set();
  for (let p = 0; p < digits; p++) { if (p !== pos) { const d = parseInt(numStr[p], 10); const v = d * Math.pow(10, digits - 1 - p); if (v !== ans && v > 0) distractors.add(v); } }
  while (distractors.size < 4) { const d = Math.floor(rng() * 9) + 1; const v = d * Math.pow(10, Math.floor(rng() * digits)); if (v !== ans) distractors.add(v); }
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `${num.toLocaleString('ko-KR')}에서 ${placeName ? placeName + '의 자리' : '일의 자리'} 숫자가 나타내는 값은 얼마입니까?`, options: options.map(o => o.toLocaleString('ko-KR')), answer: String(options.indexOf(ans)), explanation: `${placeName || '일'}의 자리 숫자는 ${digit}이고, ${digit} × ${place.toLocaleString('ko-KR')} = ${ans.toLocaleString('ko-KR')}입니다.` };
}
function genAddition(_l, range, rng) {
  const a = Math.floor(rng() * range) + 1; const b = Math.floor(rng() * range) + 1; const ans = a + b;
  const distractors = new Set([ans - 1, ans + 1, ans - 2, ans + 2]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `${a} + ${b} = ?`, options: options.map(String), answer: String(options.indexOf(ans)), explanation: `${a}에 ${b}을(를) 더하면 ${ans}입니다.` };
}
function genSubtraction(_l, range, rng) {
  const a = Math.floor(rng() * range) + 5; const b = Math.floor(rng() * (a - 1)) + 1; const ans = a - b;
  const distractors = new Set([ans + 1, ans - 1, a + b, ans + 2]); distractors.delete(ans);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * range) + 1);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `${a} - ${b} = ?`, options: options.map(String), answer: String(options.indexOf(ans)), explanation: `${a}에서 ${b}을(를) 빼면 ${ans}입니다.` };
}
function genMultiplication(rng) {
  const a = Math.floor(rng() * 9) + 1; const b = Math.floor(rng() * 9) + 1; const ans = a * b;
  const distractors = new Set([ans + a, ans - a, ans + b, ans - b, a + b]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `${a} × ${b} = ?`, options: options.map(String), answer: String(options.indexOf(ans)), explanation: `${a}에 ${b}을(를) 곱하면 ${ans}입니다.` };
}
function genDivision(rng) {
  const b = Math.floor(rng() * 8) + 2; const q = Math.floor(rng() * 9) + 1; const a = b * q;
  const distractors = new Set([q + 1, q - 1, q + 2, q * 2]); distractors.delete(q);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * 12) + 1);
  distractors.delete(q);
  const options = shuffle([q, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `${a} ÷ ${b} = ?`, options: options.map(String), answer: String(options.indexOf(q)), explanation: `${a}을(를) ${b}로 나누면 ${q}입니다.` };
}
function genFraction(_l, rng) {
  const denom = Math.floor(rng() * 8) + 2; const num = Math.floor(rng() * (denom - 1)) + 1;
  const correct = `${num}/${denom}`;
  const distractors = [`${denom}/${num}`, `${num + 1}/${denom}`, `${num}/${denom + 1}`, `${num - 1}/${denom}`].filter(d => d !== correct);
  const options = shuffle([correct, ...distractors.slice(0, 4)], rng);
  return { text: `전체를 ${denom}등분한 것 중 ${num}만큼을 분수로 나타내면 무엇입니까?`, options, answer: String(options.indexOf(correct)), explanation: `전체를 ${denom}등분한 것 중 ${num}만큼은 ${correct}입니다.` };
}
function genShapeBySides(rng) {
  const shapes = [{ name: '삼각형', sides: 3 }, { name: '사각형', sides: 4 }, { name: '오각형', sides: 5 }, { name: '육각형', sides: 6 }];
  const target = pick(shapes, rng);
  const options = shuffle(shapes.map(s => s.name), rng);
  return { text: `변이 ${target.sides}개인 평면도형의 이름은 무엇입니까?`, options, answer: String(options.indexOf(target.name)), explanation: `변이 ${target.sides}개인 평면도형은 ${target.name}입니다.` };
}
function genMeasurement(rng) {
  const a = Math.floor(rng() * 90) + 10; const b = Math.floor(rng() * 90) + 10;
  const ans = Math.max(a, b);
  const distractors = new Set([Math.min(a, b), a + b, Math.abs(a - b)]);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * 100) + 10);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `${a}cm와 ${b}cm 중 더 긴 길이는 얼마입니까?`, options: options.map(o => o + 'cm'), answer: String(options.indexOf(ans)), explanation: `${a}cm와 ${b}cm를 비교하면 ${ans}cm가 더 깁니다.` };
}
function genPattern(rng) {
  const start = Math.floor(rng() * 5) + 1; const step = Math.floor(rng() * 4) + 2;
  const seq = [start, start + step, start + step * 2, start + step * 3]; const ans = start + step * 4;
  const distractors = new Set([ans + step, ans - step, ans + 1, ans - 1]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: `다음 수 배열의 규칙을 찾아 빈칸에 알맞은 수를 구하시오.\n\n${seq.join(', ')}, ?`, options: options.map(String), answer: String(options.indexOf(ans)), explanation: `${step}씩 커지는 규칙이므로 다음 수는 ${ans}입니다.` };
}
function genGraph(rng) {
  const counts = [Math.floor(rng() * 8) + 2, Math.floor(rng() * 8) + 2, Math.floor(rng() * 8) + 2, Math.floor(rng() * 8) + 2];
  const items = ['사과', '바나나', '포도', '딸기'];
  const maxIdx = counts.indexOf(Math.max(...counts));
  const ans = items[maxIdx];
  const options = shuffle(items, rng);
  const lines = items.map((it, i) => `${it}: ${'■'.repeat(counts[i])} (${counts[i]}명)`).join('\n');
  return { text: `반 친구들이 좋아하는 과일을 조사한 결과입니다.\n\n${lines}\n\n가장 많이 좋아하는 과일은 무엇입니까?`, options, answer: String(options.indexOf(ans)), explanation: `${ans}을(를) 좋아하는 친구가 ${counts[maxIdx]}명으로 가장 많습니다.` };
}

// -------- 신규: 입체도형 (정육면체/직육면체) ----------------------------------
function genCube(lname, rng) {
  // 정육면체: 면 6, 모서리 12, 꼭짓점 8 / 직육면체도 동일
  const props = [
    { key: '면', value: 6 },
    { key: '모서리', value: 12 },
    { key: '꼭짓점', value: 8 },
  ];
  const isJik = /직육면체/.test(lname);
  const name = isJik ? '직육면체' : '정육면체';
  const target = pick(props, rng);
  const distractors = new Set([target.value + 2, target.value - 2, target.value + 4, target.value - 4]);
  distractors.delete(target.value);
  const options = shuffle([target.value, ...Array.from(distractors).slice(0, 4)], rng);
  return {
    text: `${name}의 ${target.key}의 개수는 몇 개입니까?`,
    options: options.map(o => `${o}개`),
    answer: String(options.indexOf(target.value)),
    explanation: `${name}은(는) 면 6개, 모서리 12개, 꼭짓점 8개로 이루어져 있습니다. 따라서 ${target.key}는 ${target.value}개입니다.`
  };
}

// -------- 신규: 선분/직선/반직선 (중1 도형의 기초) ---------------------------
function genLineKind(lname, rng) {
  const items = [
    { name: '선분', def: '두 점을 곧게 이은 선' },
    { name: '직선', def: '양쪽으로 끝없이 늘인 곧은 선' },
    { name: '반직선', def: '한 점에서 시작하여 한쪽으로만 끝없이 늘인 곧은 선' },
  ];
  const target = pick(items, rng);
  const options = shuffle(items.map(i => i.name), rng);
  return {
    text: `다음 설명에 해당하는 것은 무엇입니까?\n\n"${target.def}"`,
    options,
    answer: String(options.indexOf(target.name)),
    explanation: `${target.def}을(를) ${target.name}이라고 합니다.`
  };
}

// -------- 신규: 집합 연산 (여집합/합집합/교집합/차집합) -----------------------
function genSetOp(lname, rng) {
  // U={1..10}, A={1,2,3,4,5}, B={4,5,6,7}
  const U = [1,2,3,4,5,6,7,8,9,10];
  const A = [1,2,3,4,5];
  const B = [4,5,6,7];
  let opName, ansSet, expl;
  if (/여집합/.test(lname)) {
    opName = 'A의 여집합 (Aᶜ)';
    ansSet = U.filter(x => !A.includes(x));
    expl = `전체집합 U에서 A에 속하지 않는 원소를 모은 집합입니다.`;
  } else if (/차집합/.test(lname)) {
    opName = 'A - B';
    ansSet = A.filter(x => !B.includes(x));
    expl = `A에는 속하지만 B에는 속하지 않는 원소의 집합입니다.`;
  } else if (/교집합/.test(lname) || /∩/.test(lname)) {
    opName = 'A ∩ B';
    ansSet = A.filter(x => B.includes(x));
    expl = `A와 B 모두에 속하는 원소의 집합입니다.`;
  } else {
    opName = 'A ∪ B';
    ansSet = Array.from(new Set([...A, ...B])).sort((a,b)=>a-b);
    expl = `A 또는 B에 속하는 원소를 모은 집합입니다.`;
  }
  const fmt = s => '{' + s.join(', ') + '}';
  const correct = fmt(ansSet);
  const distractors = [
    fmt(A), fmt(B), fmt(U), fmt(A.filter(x=>B.includes(x))),
    fmt(U.filter(x=>!A.includes(x) && !B.includes(x)))
  ].filter(d => d !== correct);
  const options = shuffle([correct, ...distractors.slice(0,4)], rng);
  return {
    text: `전체집합 U={1,2,3,4,5,6,7,8,9,10}, A={1,2,3,4,5}, B={4,5,6,7}일 때, ${opName}는 무엇입니까?`,
    options,
    answer: String(options.indexOf(correct)),
    explanation: expl + ` 정답: ${correct}.`
  };
}

// -------- 신규: 일차/이차함수 ------------------------------------------------
function genLinearFn(lname, rng) {
  // y = ax + b 의 기울기/y절편/특정 x 값에서의 함숫값
  const a = pick([2, 3, -2, -3, 4, -4], rng);
  const b = pick([1, -1, 2, -2, 3, -3, 5], rng);
  const kind = pick(['slope', 'intercept', 'value'], rng);
  let q, ans, expl, distSrc;
  if (kind === 'slope') {
    q = `일차함수 y = ${a}x ${b >= 0 ? '+ ' + b : '- ' + Math.abs(b)} 의 기울기는 얼마입니까?`;
    ans = a; distSrc = [b, -a, a + 1, a - 1, a * 2];
    expl = `일차함수 y = ax + b 에서 기울기는 a이므로 ${a}입니다.`;
  } else if (kind === 'intercept') {
    q = `일차함수 y = ${a}x ${b >= 0 ? '+ ' + b : '- ' + Math.abs(b)} 의 y절편은 얼마입니까?`;
    ans = b; distSrc = [a, -b, b + 1, b - 1, a + b];
    expl = `일차함수 y = ax + b 에서 y절편은 b이므로 ${b}입니다.`;
  } else {
    const x = pick([1, 2, -1, -2, 3], rng);
    ans = a * x + b;
    q = `일차함수 y = ${a}x ${b >= 0 ? '+ ' + b : '- ' + Math.abs(b)} 에서 x = ${x}일 때 y의 값은 얼마입니까?`;
    distSrc = [ans + 1, ans - 1, ans + a, ans - a, a * x - b];
    expl = `x = ${x}을(를) 대입하면 y = ${a}×${x} ${b >= 0 ? '+ ' + b : '- ' + Math.abs(b)} = ${ans}입니다.`;
  }
  const distractors = new Set(distSrc); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return { text: q, options: options.map(String), answer: String(options.indexOf(ans)), explanation: expl };
}
function genQuadraticFn(lname, rng) {
  const a = pick([1, 2, -1, -2, 3], rng);
  const x = pick([1, 2, -1, -2, 3, 0], rng);
  const ans = a * x * x;
  const distractors = new Set([ans + 1, ans - 1, a * x, -ans, ans + a]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  return {
    text: `이차함수 y = ${a}x² 에서 x = ${x}일 때 y의 값은 얼마입니까?`,
    options: options.map(String), answer: String(options.indexOf(ans)),
    explanation: `x = ${x}을(를) 대입하면 y = ${a}×(${x})² = ${a}×${x*x} = ${ans}입니다.`
  };
}

// -------- 신규: 정수와 유리수 사칙연산 (중1) ---------------------------------
function genIntegerOp(lname, rng) {
  // 보장: 적어도 한쪽은 음수
  let a = Math.floor(rng() * 19) - 9;
  let b = Math.floor(rng() * 19) - 9;
  if (a >= 0 && b >= 0) { if (rng() < 0.5) a = -Math.abs(a) || -1; else b = -Math.abs(b) || -1; }
  let op = '+', ans;
  if (/덧셈|더하/.test(lname)) { op = '+'; ans = a + b; }
  else if (/뺄셈|빼/.test(lname)) { op = '-'; ans = a - b; }
  else if (/곱셈|곱하/.test(lname)) { op = '×'; ans = a * b; }
  else if (/나눗셈|나누/.test(lname)) {
    // 정수 나누어떨어지게
    const q = Math.floor(rng()*7)-3 || 1;
    b = Math.floor(rng()*5)+2; if (rng()<0.5) b = -b;
    a = q*b; op = '÷'; ans = q;
  } else { op = '+'; ans = a + b; }
  const distractors = new Set([ans+1, ans-1, -ans, ans+2, ans-2]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0,4)], rng);
  const fmt = n => n < 0 ? `(${n})` : `${n}`;
  return {
    text: `다음을 계산하시오.\n\n${fmt(a)} ${op} ${fmt(b)} = ?`,
    options: options.map(String), answer: String(options.indexOf(ans)),
    explanation: `${fmt(a)} ${op} ${fmt(b)} = ${ans}입니다.`
  };
}

// -------- 신규: 소인수분해/약수/배수 (중1) ----------------------------------
function genFactorization(lname, rng) {
  const primes = [2, 3, 5, 7];
  const n = pick([12, 18, 20, 24, 30, 36, 45, 50, 60, 72], rng);
  const factor = (x) => { const r = {}; let v = x; for (const p of primes) { while (v % p === 0) { r[p] = (r[p]||0)+1; v/=p; } } if (v > 1) r[v]=1; return r; };
  const f = factor(n);
  const fmtFactor = (obj) => Object.entries(obj).map(([p,e]) => e>1 ? `${p}^${e}` : `${p}`).join(' × ');
  const correct = fmtFactor(f);
  // distractors: 비슷한 다른 수의 인수분해
  const dnums = [n+2, n-2, n*2, Math.floor(n/2)].filter(x=>x>1);
  const distractors = dnums.map(x => fmtFactor(factor(x))).filter(s => s !== correct);
  while (distractors.length < 4) distractors.push(`${primes[distractors.length%4]} × ${primes[(distractors.length+1)%4]}`);
  const options = shuffle([correct, ...distractors.slice(0,4)], rng);
  return {
    text: `${n}을(를) 소인수분해 한 결과로 옳은 것은 무엇입니까?`,
    options, answer: String(options.indexOf(correct)),
    explanation: `${n} = ${correct} 입니다.`
  };
}

// -------- 신규: 좌표평면 두 점 사이의 거리 ----------------------------------
function genDistance(lname, rng) {
  // pythagoras 정수해
  const triples = [[3,4,5],[5,12,13],[6,8,10],[8,15,17],[7,24,25],[9,12,15]];
  const [dx, dy, d] = pick(triples, rng);
  const x1 = pick([0,1,-1,2,-2], rng); const y1 = pick([0,1,-1,2,-2], rng);
  const x2 = x1 + dx; const y2 = y1 + dy;
  const ans = d;
  const distractors = new Set([d+1, d-1, dx+dy, Math.abs(dx-dy), d*2]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0,4)], rng);
  return {
    text: `좌표평면 위의 두 점 A(${x1}, ${y1})와 B(${x2}, ${y2}) 사이의 거리는 얼마입니까?`,
    options: options.map(String), answer: String(options.indexOf(ans)),
    explanation: `√((${x2}-${x1})² + (${y2}-${y1})²) = √(${dx*dx} + ${dy*dy}) = √${dx*dx+dy*dy} = ${d} 입니다.`
  };
}

// -------- 신규: 순열/조합 (고1 경우의 수) -----------------------------------
function genPermComb(lname, rng) {
  const fact = (n) => { let r=1; for (let i=2;i<=n;i++) r*=i; return r; };
  const nPr = (n, r) => fact(n) / fact(n-r);
  const nCr = (n, r) => fact(n) / (fact(r) * fact(n-r));
  const n = pick([5,6,7,8], rng); const r = pick([2,3], rng);
  let label, ans;
  if (/조합|nCr|C\(/.test(lname)) { label = `₍${n}₎C₍${r}₎`; ans = nCr(n,r); }
  else if (/순열|nPr|P\(/.test(lname)) { label = `₍${n}₎P₍${r}₎`; ans = nPr(n,r); }
  else if (/계승|팩토리얼/.test(lname)) { label = `${n}!`; ans = fact(n); }
  else if (/합의 법칙/.test(lname)) {
    const a = pick([3,4,5],rng), b = pick([2,3,4],rng);
    return {
      text: `사건 A가 일어나는 경우가 ${a}가지, 사건 B가 일어나는 경우가 ${b}가지이며 두 사건은 동시에 일어날 수 없을 때, A 또는 B가 일어나는 경우의 수는?`,
      options: shuffle([a+b, a*b, Math.abs(a-b), a+b+1, a+b-1], rng).map(String),
      answer: '0', explanation: `합의 법칙에 의해 ${a}+${b} = ${a+b}가지`
    };
  } else if (/곱의 법칙/.test(lname)) {
    const a = pick([3,4,5],rng), b = pick([2,3,4],rng);
    const ans2 = a*b;
    const opts = shuffle([ans2, a+b, a*b+1, a*b-1, Math.abs(a-b)], rng);
    return {
      text: `사건 A가 일어나는 경우가 ${a}가지이고, 그 각각에 대해 사건 B가 일어나는 경우가 ${b}가지일 때, A와 B가 잇따라 일어나는 경우의 수는?`,
      options: opts.map(String), answer: String(opts.indexOf(ans2)),
      explanation: `곱의 법칙에 의해 ${a}×${b} = ${ans2}가지`
    };
  } else {
    label = `₍${n}₎C₍${r}₎`; ans = nCr(n,r);
  }
  const distractors = new Set([ans+1, ans-1, ans*2, Math.floor(ans/2), nPr(n,r), fact(n)]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0,4)], rng);
  // Reorder options for correct answer index after shuffle
  const correctIdx = options.indexOf(ans);
  return {
    text: `${label}의 값은 얼마입니까?`,
    options: options.map(String), answer: String(correctIdx),
    explanation: `${label} = ${ans} 입니다.`
  };
}

// -------- 신규: 함수의 뜻/역함수 (고1) --------------------------------------
function genFunctionConcept(lname, rng) {
  // 합성함수 f(g(x)): f(x)=2x+1, g(x)=x+3, x값
  if (/합성/.test(lname)) {
    const a = pick([1,2,3], rng), b = pick([1,2,3], rng), c = pick([1,2,3], rng);
    const x = pick([1,2,0,-1,3], rng);
    const ans = a*(x+c) + b; // f(x)=ax+b, g(x)=x+c, f(g(x))=a(x+c)+b
    const distractors = new Set([ans+1, ans-1, x+c, a*x+b+c, -ans]); distractors.delete(ans);
    const options = shuffle([ans, ...Array.from(distractors).slice(0,4)], rng);
    return {
      text: `f(x) = ${a}x ${b>=0?'+ '+b:'- '+Math.abs(b)}, g(x) = x ${c>=0?'+ '+c:'- '+Math.abs(c)}일 때 (f∘g)(${x})의 값은?`,
      options: options.map(String), answer: String(options.indexOf(ans)),
      explanation: `g(${x}) = ${x+c}, f(${x+c}) = ${a}×${x+c} ${b>=0?'+ '+b:'- '+Math.abs(b)} = ${ans}`
    };
  }
  // 역함수: f(x)=ax+b의 역함수에서 특정 값
  if (/역함수/.test(lname)) {
    const a = pick([2,3,4], rng), b = pick([1,2,3,-1,-2], rng);
    // f(x)=ax+b, f^-1(y)=(y-b)/a; pick y so result is integer
    const k = pick([1,2,3,-1], rng);
    const y = a*k + b;
    const ans = k;
    const distractors = new Set([ans+1, ans-1, y, a, b]); distractors.delete(ans);
    const options = shuffle([ans, ...Array.from(distractors).slice(0,4)], rng);
    return {
      text: `f(x) = ${a}x ${b>=0?'+ '+b:'- '+Math.abs(b)}일 때 f⁻¹(${y})의 값은?`,
      options: options.map(String), answer: String(options.indexOf(ans)),
      explanation: `f(x) = ${y} 인 x를 구하면 ${a}x ${b>=0?'+ '+b:'- '+Math.abs(b)} = ${y}, x = ${ans}`
    };
  }
  return null;
}

// -------- 신규: 명제 / 충분·필요조건 (고1) ----------------------------------
function genProposition(lname, rng) {
  if (/충분조건|필요조건|필요충분/.test(lname)) {
    // p: x=1, q: x²=1 ⇒ p는 q의 충분조건이지만 필요조건은 아니다
    const samples = [
      { p: 'x = 2', q: 'x² = 4', rel: '충분조건' },
      { p: 'x² = 1', q: 'x = 1 또는 x = -1', rel: '필요충분조건' },
      { p: '자연수 x가 4의 배수이다', q: '자연수 x가 2의 배수이다', rel: '충분조건' },
      { p: 'x > 5', q: 'x > 3', rel: '충분조건' },
    ];
    const t = pick(samples, rng);
    const options = ['충분조건', '필요조건', '필요충분조건', '관계 없음'];
    return {
      text: `다음에서 p가 q이기 위한 조건으로 가장 알맞은 것은?\n\np: ${t.p}\nq: ${t.q}`,
      options, answer: String(options.indexOf(t.rel)),
      explanation: `p이면 q이지만 그 역은 일반적으로 성립하지 않으므로 p는 q의 ${t.rel}입니다.`
    };
  }
  if (/명제의 부정/.test(lname)) {
    const samples = [
      { p: 'x > 3', neg: 'x ≤ 3' },
      { p: '모든 자연수는 짝수이다', neg: '어떤 자연수는 짝수가 아니다' },
      { p: 'x ≠ 0', neg: 'x = 0' },
    ];
    const t = pick(samples, rng);
    const allNegs = samples.map(s => s.neg);
    const options = shuffle([t.neg, ...allNegs.filter(n => n !== t.neg).slice(0,3), '항상 참'], rng).slice(0,5);
    if (!options.includes(t.neg)) options[0] = t.neg;
    return {
      text: `명제 "${t.p}"의 부정으로 알맞은 것은?`,
      options, answer: String(options.indexOf(t.neg)),
      explanation: `명제의 부정은 "${t.neg}"입니다.`
    };
  }
  return null;
}

// -------- 폴백: 개념 식별 MCQ (lesson_name 자체를 묻는다) -------------------
function genConceptFallback(lname, area, gradeLevel, rng) {
  // 같은 area의 다른 lesson_name을 distractor로
  const sibs = SIBLINGS_BY_AREA[area] || [];
  const others = sibs.filter(s => s !== lname);
  const distractors = shuffle(others, rng).slice(0, 4);
  while (distractors.length < 4) distractors.push(`보기 ${distractors.length+1}`);
  const options = shuffle([lname, ...distractors], rng);
  return {
    text: `다음 중 "${area}" 영역에서 본 차시의 학습 주제로 가장 알맞은 것은 무엇입니까?\n\n(힌트: 본 차시의 학습 목표를 떠올려 보세요.)`,
    options,
    answer: String(options.indexOf(lname)),
    explanation: `본 차시의 학습 주제는 "${lname}"입니다. 자세한 내용은 차시 학습 자료를 참고하세요.`
  };
}

// -------- 메인 디스패처 ----------------------------------------------------
let SIBLINGS_BY_AREA = {};
function buildSiblings(allNodes) {
  const map = {};
  for (const n of allNodes) {
    if (!n.lesson_name || !n.area) continue;
    const k = n.area;
    if (!map[k]) map[k] = new Set();
    map[k].add(n.lesson_name);
  }
  Object.keys(map).forEach(k => map[k] = Array.from(map[k]));
  SIBLINGS_BY_AREA = map;
}

function generateProblemV2(node, seedKey) {
  const lname = node.lesson_name || '';
  const grade = node.grade || 1;
  const area = node.area || '';
  const level = node.grade_level || '초';
  const rng = seededRand(seedKey + '_' + lname);

  // === 중·고등 우선 분기 ===
  if (level === '중' || level === '고') {
    // 집합
    if (/여집합|차집합|교집합|합집합|드 모르간|벤 다이어그램/.test(lname)) return genSetOp(lname, rng);
    // 명제
    const prop = genProposition(lname, rng); if (prop) return prop;
    // 일차/이차함수 (먼저 매칭 — '함수' 폭이 넓어서 우선)
    if (/일차함수/.test(lname)) return genLinearFn(lname, rng);
    if (/이차함수/.test(lname)) return genQuadraticFn(lname, rng);
    // 합성함수/역함수 (단어 경계 명확화: 합성수 X)
    if (/합성함수|역함수/.test(lname)) {
      const fn = genFunctionConcept(lname, rng); if (fn) return fn;
    }
    // 선분/직선/반직선
    if (/선분|반직선/.test(lname) && /기호|뜻|정의|이해|구분/.test(lname)) return genLineKind(lname, rng);
    if (lname === '직선' || lname === '반직선' || lname === '선분' || /직선, 반직선/.test(lname)) return genLineKind(lname, rng);
    // 정수/유리수 사칙연산
    if (/정수와 유리수의 (덧셈|뺄셈|곱셈|나눗셈)/.test(lname)) return genIntegerOp(lname, rng);
    // 소인수분해 (소수와 합성수의 뜻은 개념형으로 — 산술 아님)
    if (/소인수분해|거듭제곱으로 표현/.test(lname)) return genFactorization(lname, rng);
    // 좌표평면 거리
    if (/두 점 사이의 거리/.test(lname)) return genDistance(lname, rng);
    // 순열·조합
    if (/순열|조합|nPr|nCr|계승|합의 법칙|곱의 법칙/.test(lname)) return genPermComb(lname, rng);
    // 폴백: 개념 식별
    return genConceptFallback(lname, area, level, rng);
  }

  // === 초등 분기 (정밀화) ===
  // 측정·시각·무게 (먼저 — 도형보다 우선)
  if (/시각|시간|시계|분 이해|시 이해|몇 시|몇 분|초 이해|오전|오후/.test(lname)) {
    const h = Math.floor(rng()*11)+1; const m = pick([0,15,30,45], rng);
    const ans = `${h}시 ${m}분`;
    const opts = shuffle([ans, `${h+1}시 ${m}분`, `${h}시 ${m+15}분`, `${h-1>=0?h-1:11}시 ${m}분`, `${h}시 ${m===0?30:0}분`], rng);
    return { text: `시계가 ${h}시 ${m}분을 나타낼 때, 시각을 바르게 읽은 것은 무엇입니까?`, options: opts, answer: String(opts.indexOf(ans)), explanation: `시계가 가리키는 시각은 ${ans}입니다.` };
  }
  if (/kg|g|무게/.test(lname)) {
    const a = Math.floor(rng()*5000)+500; const b = Math.floor(rng()*5000)+500;
    const ans = Math.max(a,b);
    const opts = shuffle([ans, Math.min(a,b), a+b, Math.abs(a-b), ans+100], rng);
    return { text: `${a}g과 ${b}g 중 더 무거운 것은 얼마입니까?`, options: opts.map(o=>o+'g'), answer: String(opts.indexOf(ans)), explanation: `${a}g과 ${b}g을 비교하면 ${ans}g이 더 무겁습니다.` };
  }
  if (/들이|L|mL|리터|밀리리터/.test(lname)) {
    const a = Math.floor(rng()*9)+1; const b = Math.floor(rng()*9)+1;
    const ans = a+b;
    const opts = shuffle([ans, ans-1, ans+1, a*b, Math.abs(a-b)], rng);
    return { text: `${a}L 들이 통과 ${b}L 들이 통에 물이 가득 차 있습니다. 두 통의 물을 합하면 모두 몇 L입니까?`, options: opts.map(o=>o+'L'), answer: String(opts.indexOf(ans)), explanation: `${a}L + ${b}L = ${ans}L 입니다.` };
  }
  if (/넓이|cm²|m²/.test(lname)) {
    const a = Math.floor(rng()*9)+2; const b = Math.floor(rng()*9)+2;
    const ans = a*b;
    const opts = shuffle([ans, a+b, ans+1, ans-1, 2*(a+b)], rng);
    return { text: `가로 ${a}cm, 세로 ${b}cm인 직사각형의 넓이는 얼마입니까?`, options: opts.map(o=>o+'cm²'), answer: String(opts.indexOf(ans)), explanation: `직사각형의 넓이 = 가로 × 세로 = ${a} × ${b} = ${ans}cm² 입니다.` };
  }
  if (/길이|cm|mm|km|m\b/.test(lname)) return genMeasurement(rng);
  if (/각도|예각|둔각|직각|각의 크기/.test(lname)) {
    const a = pick([30, 45, 60, 90, 120, 135, 150], rng);
    const kind = a < 90 ? '예각' : a === 90 ? '직각' : a < 180 ? '둔각' : '평각';
    const opts = shuffle(['예각','직각','둔각','평각'], rng);
    return { text: `${a}°인 각은 어떤 종류의 각입니까?`, options: opts, answer: String(opts.indexOf(kind)), explanation: `${a}°는 ${kind}입니다 (예각<90°, 직각=90°, 둔각>90°).` };
  }
  // 입체도형 우선 (정육면체/직육면체)
  if (/정육면체|직육면체/.test(lname) && /(면|모서리|꼭짓점|개수)/.test(lname)) return genCube(lname, rng);
  if (/정육면체|직육면체/.test(lname)) return genCube(lname, rng);
  // 각기둥/각뿔 — 밑면 모양과 면·모서리·꼭짓점 관계
  if (/각기둥|각뿔/.test(lname) && /(면|모서리|꼭짓점|개수)/.test(lname)) {
    const isPrism = /각기둥/.test(lname);
    const n = pick([3,4,5,6], rng); // 밑면 변 수
    const faces = isPrism ? n+2 : n+1;
    const edges = isPrism ? 3*n : 2*n;
    const vertices = isPrism ? 2*n : n+1;
    const props = [{key:'면', value:faces},{key:'모서리', value:edges},{key:'꼭짓점', value:vertices}];
    const t = pick(props, rng);
    const distractors = new Set([t.value+1, t.value-1, t.value+2, t.value-2, n]); distractors.delete(t.value);
    const opts = shuffle([t.value, ...Array.from(distractors).slice(0,4)], rng);
    const name = isPrism ? `밑면이 ${['','','','삼각형','사각형','오각형','육각형'][n]}인 각기둥` : `밑면이 ${['','','','삼각형','사각형','오각형','육각형'][n]}인 각뿔`;
    return {
      text: `${name}의 ${t.key}의 개수는 몇 개입니까?`,
      options: opts.map(o=>o+'개'), answer: String(opts.indexOf(t.value)),
      explanation: `${name}은(는) 면 ${faces}개, 모서리 ${edges}개, 꼭짓점 ${vertices}개입니다.`
    };
  }
  // 분수 — 덧셈/뺄셈/곱셈/나눗셈
  if (/분수.*덧셈|진분수.*덧셈|대분수.*덧셈|분수.*\+|받아올림.*분수/.test(lname) || (/분수/.test(lname) && /덧셈|더하/.test(lname))) {
    const denom = Math.floor(rng()*7)+2; const a = Math.floor(rng()*(denom-1))+1; const b = Math.floor(rng()*(denom-1))+1;
    const sumNum = a+b;
    const correct = sumNum >= denom ? `${Math.floor(sumNum/denom)}과(와) ${sumNum%denom}/${denom}` : `${sumNum}/${denom}`;
    const correctSimple = sumNum >= denom ? (sumNum%denom===0 ? `${Math.floor(sumNum/denom)}` : `${Math.floor(sumNum/denom)} ${sumNum%denom}/${denom}`) : `${sumNum}/${denom}`;
    const distractors = [`${sumNum}/${denom*2}`, `${a*b}/${denom}`, `${a+b+1}/${denom}`, `${denom}/${sumNum}`].filter(d => d !== correctSimple);
    const opts = shuffle([correctSimple, ...distractors.slice(0,4)], rng);
    return { text: `${a}/${denom} + ${b}/${denom} = ?`, options: opts, answer: String(opts.indexOf(correctSimple)), explanation: `분모가 같으므로 분자끼리 더하면 ${a+b}/${denom} = ${correctSimple}입니다.` };
  }
  if (/분수.*뺄셈|진분수.*뺄셈|대분수.*뺄셈|분수.*\-|받아내림.*분수/.test(lname) || (/분수/.test(lname) && /뺄셈|빼/.test(lname))) {
    const denom = Math.floor(rng()*7)+3; const a = Math.floor(rng()*(denom-2))+2; const b = Math.floor(rng()*(a-1))+1;
    const correct = `${a-b}/${denom}`;
    const distractors = [`${a+b}/${denom}`, `${a-b}/${denom*2}`, `${a-b+1}/${denom}`, `${denom}/${a-b}`].filter(d => d !== correct);
    const opts = shuffle([correct, ...distractors.slice(0,4)], rng);
    return { text: `${a}/${denom} - ${b}/${denom} = ?`, options: opts, answer: String(opts.indexOf(correct)), explanation: `분모가 같으므로 분자끼리 빼면 ${a-b}/${denom}입니다.` };
  }
  if (/분수/.test(lname) && /곱셈|곱하/.test(lname)) {
    const denom = Math.floor(rng()*5)+2; const num = Math.floor(rng()*(denom-1))+1; const k = Math.floor(rng()*5)+2;
    const correct = `${num*k}/${denom}`;
    const opts = shuffle([correct, `${num}/${denom*k}`, `${num+k}/${denom}`, `${num}/${denom+k}`, `${num*k}/${denom*k}`], rng);
    return { text: `${num}/${denom} × ${k} = ?`, options: opts, answer: String(opts.indexOf(correct)), explanation: `(분수)×(자연수)는 분자에 자연수를 곱하면 ${num*k}/${denom}입니다.` };
  }
  if (/분수|기약|약분|통분|분모|분자|진분수|가분수|대분수/.test(lname)) return genFraction(lname, rng);
  // 자릿값/큰 수
  if (/자릿값|위치적 기수법|다섯 자리|여섯 자리|큰 수|십만|백만|천만|억|조/.test(lname)) {
    const digits = /다섯/.test(lname) ? 5 : /여섯/.test(lname) ? 6 : /큰 수|십만|백만|천만|억|조/.test(lname) ? 6 : 3;
    return genPlaceValue(lname, digits, rng);
  }
  // 사칙연산 (× ÷ 기호도 매칭)
  if (/곱셈|곱하|구구단|×/.test(lname)) return genMultiplication(rng);
  if (/나눗셈|나누|÷|몫|나머지/.test(lname)) return genDivision(rng);
  if (/덧셈|더하|합병|첨가/.test(lname)) {
    const range = grade <= 1 ? 9 : grade <= 2 ? 99 : grade <= 3 ? 999 : 9999;
    if (/0이 있는/.test(lname)) {
      const x = Math.floor(rng()*range)+1;
      const opts = shuffle([x, x+1, x-1, 0, x*2], rng);
      return { text: `${x} + 0 = ?`, options: opts.map(String), answer: String(opts.indexOf(x)), explanation: `어떤 수에 0을 더하면 그 수 자신이므로 ${x}입니다.` };
    }
    return genAddition(lname, range, rng);
  }
  if (/뺄셈|빼|제거/.test(lname)) {
    const range = grade <= 1 ? 9 : grade <= 2 ? 99 : grade <= 3 ? 999 : 9999;
    if (/0이 있는/.test(lname)) {
      const x = Math.floor(rng()*range)+1;
      const opts = shuffle([x, x+1, x-1, 0, x*2], rng);
      return { text: `${x} - 0 = ?`, options: opts.map(String), answer: String(opts.indexOf(x)), explanation: `어떤 수에서 0을 빼면 그 수 자신이므로 ${x}입니다.` };
    }
    return genSubtraction(lname, range, rng);
  }
  // 수 세기/읽기
  if (/세기|묶어 세기/.test(lname)) { const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : /100까지/.test(lname) ? 100 : 9; return genCounting(lname, max, rng); }
  if (/읽고 쓰기|읽고|쓰기/.test(lname)) { const max = /9까지/.test(lname) ? 9 : 10; return genReadWrite(lname, max, rng); }
  if (/크기 비교|크기|비교/.test(lname)) { const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : /100까지/.test(lname) ? 100 : 1000; return genCompare(lname, max, rng); }
  if (/9까지|50까지|100까지/.test(lname)) { const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : 100; return genCounting(lname, max, rng); }
  // 쌓기나무 — 개념형 (입체도형 매칭보다 먼저)
  if (/쌓기나무/.test(lname)) {
    return genConceptFallback(lname, area, level, rng);
  }
  // 원 — 평면도형 매칭보다 먼저 (원인 것/원이 아닌 것 분류 등)
  if (/원인 것|원이 아닌|^원\b|^원의 |원 그리기|반지름|지름|원의 중심|원주/.test(lname)) {
    const opts = shuffle(['원','삼각형','사각형','오각형','직사각형'], rng);
    return { text: `다음 도형 중 한 점(중심)에서 같은 거리에 있는 점들로 이루어진 도형은 무엇입니까?`, options: opts, answer: String(opts.indexOf('원')), explanation: `한 점(중심)에서 같은 거리에 있는 점들의 집합은 "원"입니다.` };
  }
  // 평면도형
  if (/삼각형|사각형|오각형|육각형|다각형|평면도형/.test(lname)) return genShapeBySides(rng);
  // 입체도형 (구/원기둥/원뿔 등은 모양 식별로)
  if (/원기둥|원뿔$|입체도형/.test(lname) || /^구의|^구$|^구 모양/.test(lname)) {
    const shapes = ['구', '원기둥', '원뿔', '직육면체', '정육면체'];
    const target = /원기둥/.test(lname) ? '원기둥' : /원뿔/.test(lname) ? '원뿔' : /구/.test(lname) ? '구' : pick(shapes, rng);
    const options = shuffle(shapes, rng).slice(0, 5);
    if (!options.includes(target)) options[0] = target;
    return {
      text: `다음 입체도형 중 "${target}"에 해당하는 것은 무엇입니까?`,
      options, answer: String(options.indexOf(target)),
      explanation: `본 차시의 학습 대상 입체도형은 ${target}입니다.`
    };
  }
  // 도형 일반
  if (/도형/.test(lname)) return genShapeBySides(rng);
  // 규칙·대응
  if (/규칙|배열|대응|수 배열/.test(lname)) return genPattern(rng);
  // 가능성/확률 — 말로 표현
  if (/가능성/.test(lname) && /(말|표현|확실|불가능)/.test(lname)) {
    const items = [
      { sit: '동전을 던졌을 때 앞면이 나올 가능성', ans: '반반이다' },
      { sit: '주사위를 던졌을 때 7이 나올 가능성', ans: '불가능하다' },
      { sit: '내일 해가 동쪽에서 뜰 가능성', ans: '확실하다' },
      { sit: '오늘 비가 올 가능성', ans: '~일 것 같다' },
    ];
    const t = pick(items, rng);
    const opts = ['확실하다', '~일 것 같다', '반반이다', '~아닐 것 같다', '불가능하다'];
    return { text: `다음 상황에서 일이 일어날 가능성을 말로 표현한 것으로 가장 알맞은 것은?\n\n"${t.sit}"`, options: opts, answer: String(opts.indexOf(t.ans)), explanation: `해당 상황의 일이 일어날 가능성은 "${t.ans}"로 표현합니다.` };
  }
  // 평균
  if (/평균/.test(lname)) {
    const nums = Array.from({length:4}, () => Math.floor(rng()*20)+1);
    const sum = nums.reduce((a,b)=>a+b,0);
    const ans = sum/4;
    const opts = shuffle([ans, ans+1, ans-1, sum, Math.max(...nums)], rng);
    return { text: `다음 4개 수의 평균은 얼마입니까?\n\n${nums.join(', ')}`, options: opts.map(String), answer: String(opts.indexOf(ans)), explanation: `(${nums.join('+')}) ÷ 4 = ${ans}` };
  }
  // 자료·통계
  if (/그래프|자료|분류|통계|확률/.test(lname)) return genGraph(rng);
  // area 기반 폴백
  if (area === '도형과 측정') return genShapeBySides(rng);
  if (area === '변화와 관계') return genPattern(rng);
  if (area === '자료와 가능성') return genGraph(rng);
  // 학년 폴백 (이전 임의 폴백 대신 개념형 폴백 우선)
  return genConceptFallback(lname, area, level, rng);
}

// ---------------------------------------------------------------------------
// 메인 실행
const allNodes = db.prepare(`SELECT lesson_name, area FROM learning_map_nodes WHERE node_level = 3`).all();
buildSiblings(allNodes);

const targets = db.prepare(`
  SELECT c.id AS content_id, c.title AS old_title,
         lmn.node_id, lmn.lesson_name, lmn.grade_level, lmn.grade, lmn.area, lmn.subject, lmn.achievement_code,
         q.id AS qid, q.question_text AS old_q
  FROM contents c
  JOIN content_content_nodes ccn ON ccn.content_id = c.id
  JOIN learning_map_nodes lmn ON lmn.node_id = ccn.std_id
  LEFT JOIN content_questions q ON q.content_id = c.id
  WHERE c.tags LIKE '%자동생성%'
  ORDER BY c.id
`).all();

console.log(`[regen] 대상 콘텐츠: ${targets.length}개`);

if (SAMPLE) {
  // 무작위 30개 샘플 (기존 vs 신규)
  const sample = shuffle(targets, seededRand('sample-2026'));
  const N = 30;
  console.log(`\n=== 무작위 ${N}개 샘플 (재생성 결과) ===\n`);
  for (let i = 0; i < N && i < sample.length; i++) {
    const t = sample[i];
    const newGen = generateProblemV2(t, `${t.node_id}_v${(t.content_id % 2) + 1}`);
    console.log(`#${i+1} [${t.grade_level}${t.grade}] ${t.area} > ${t.lesson_name}`);
    console.log(`  OLD: ${(t.old_q||'').replace(/\n/g,' ').slice(0,80)}`);
    console.log(`  NEW: ${newGen.text.replace(/\n/g,' ').slice(0,120)}`);
    console.log('');
  }
  db.close();
  process.exit(0);
}

if (DRY) {
  // 통계: lesson_name 매칭 분류
  const byHandler = {};
  for (const t of targets) {
    const gen = generateProblemV2(t, `${t.node_id}_v1`);
    // 구분: text starts pattern
    let h = 'other';
    if (/= \?$/.test(gen.text)) h = 'arithmetic';
    else if (/그림이 나타내는/.test(gen.text)) h = 'counting';
    else if (/우리말로 읽으면/.test(gen.text)) h = 'readwrite';
    else if (/더 큰 수/.test(gen.text)) h = 'compare';
    else if (/숫자가 나타내는 값/.test(gen.text)) h = 'placevalue';
    else if (/등분한 것 중/.test(gen.text)) h = 'fraction';
    else if (/변이 \d+개/.test(gen.text)) h = 'shape-sides';
    else if (/입체도형/.test(gen.text)) h = 'shape-3d';
    else if (/면|모서리|꼭짓점/.test(gen.text)) h = 'cube';
    else if (/cm와/.test(gen.text)) h = 'measure';
    else if (/수 배열의 규칙/.test(gen.text)) h = 'pattern';
    else if (/조사한 결과/.test(gen.text)) h = 'graph';
    else if (/전체집합/.test(gen.text)) h = 'set-op';
    else if (/일차함수|이차함수/.test(gen.text)) h = 'function';
    else if (/명제|충분조건|필요조건/.test(gen.text)) h = 'proposition';
    else if (/소인수분해/.test(gen.text)) h = 'factorization';
    else if (/좌표평면 위의 두 점/.test(gen.text)) h = 'distance';
    else if (/P|C|!|경우의 수/.test(gen.text)) h = 'perm-comb';
    else if (/(f∘g)|f⁻¹/.test(gen.text)) h = 'function-comp';
    else if (/선분|직선|반직선/.test(gen.text)) h = 'line-kind';
    else if (/학습 주제로 가장 알맞은/.test(gen.text)) h = 'concept-fallback';
    byHandler[h] = (byHandler[h] || 0) + 1;
  }
  console.log('\n=== 핸들러별 분포 ===');
  Object.entries(byHandler).sort((a,b)=>b[1]-a[1]).forEach(([h,c]) => console.log(`  ${h}: ${c}`));
  db.close();
  process.exit(0);
}

const upContent = db.prepare(`UPDATE contents SET title = ?, description = ? WHERE id = ?`);
const upQ = db.prepare(`UPDATE content_questions SET question_text = ?, options = ?, answer = ?, explanation = ? WHERE id = ?`);

const tx = db.transaction(() => {
  let n = 0;
  for (const t of targets) {
    const seedKey = `${t.node_id}_v${(t.content_id % 2) + 1}`;
    const gen = generateProblemV2(t, seedKey);
    const newTitle = `${t.lesson_name} - 문제 ${(t.content_id % 2) + 1}`;
    const newDesc = `자동 생성 문항(v2). ${t.area} > ${t.lesson_name}. ${t.grade_level}${t.grade}.`;
    upContent.run(newTitle, newDesc, t.content_id);
    if (t.qid) {
      upQ.run(gen.text, JSON.stringify(gen.options), gen.answer, gen.explanation, t.qid);
    }
    n++;
    if (n % 200 === 0) console.log(`  진행: ${n}개 갱신...`);
  }
  return n;
});

const total = tx();
console.log(`✅ 완료 — 갱신된 quiz 콘텐츠: ${total}개`);
db.close();
