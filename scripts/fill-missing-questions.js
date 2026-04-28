/**
 * fill-missing-questions.js
 *
 * 차시 노드(level=3) 중 quiz 콘텐츠가 매핑되지 않은 노드에
 * lesson_name·grade·area 기반의 진단/연습 문항을 자동 생성하여 채워 넣는다.
 *
 * - 노드당 quiz 콘텐츠 2개 생성 (서로 다른 시드의 문항)
 * - admin(creator_id=1)이 생성, status='approved', is_public=1
 * - content_content_nodes + node_contents 양쪽 매핑
 *
 * 실행:
 *   node scripts/fill-missing-questions.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
const ADMIN_ID = 1;

// ---------------------------------------------------------------------------
// 시드 기반 결정성 RNG (fix-quiz-content.js와 동일)
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

const KOR_NUM = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];

function genCounting(lessonName, max, rng) {
  const ans = Math.floor(rng() * (max - 1)) + 1;
  const distractors = new Set();
  while (distractors.size < 4) { const d = Math.floor(rng() * max) + 1; if (d !== ans) distractors.add(d); }
  const options = shuffle([ans, ...distractors], rng);
  const answerIdx = options.indexOf(ans);
  const items = pick(['🍎', '⭐', '🌸', '🎈', '🐱', '🦋'], rng);
  return { text: `다음 그림이 나타내는 수는 얼마입니까?\n\n${items.repeat(ans)}`, options: options.map(String), answer: String(answerIdx), explanation: `그림에 ${items}가 ${ans}개 있으므로 정답은 ${ans}입니다.` };
}

function genReadWrite(lessonName, max, rng) {
  const ans = Math.floor(rng() * Math.min(max, 9)) + 1;
  const correctText = KOR_NUM[ans];
  const distractors = new Set();
  while (distractors.size < 4) { const d = Math.floor(rng() * 10) + 1; if (d !== ans && d <= 10) distractors.add(KOR_NUM[d]); }
  const options = shuffle([correctText, ...distractors], rng);
  const answerIdx = options.indexOf(correctText);
  return { text: `숫자 ${ans}을(를) 우리말로 읽으면 무엇입니까?`, options, answer: String(answerIdx), explanation: `${ans}은(는) "${correctText}"이라고 읽습니다.` };
}

function genCompare(lessonName, max, rng) {
  const a = Math.floor(rng() * max) + 1; let b; do { b = Math.floor(rng() * max) + 1; } while (b === a);
  const ans = Math.max(a, b);
  const distractors = new Set([Math.min(a, b)]);
  while (distractors.size < 4) { const d = Math.floor(rng() * max) + 1; if (d !== ans) distractors.add(d); }
  const options = shuffle([ans, ...distractors], rng);
  const answerIdx = options.indexOf(ans);
  return { text: `${a}과(와) ${b} 중 더 큰 수는 무엇입니까?`, options: options.map(String), answer: String(answerIdx), explanation: `${a}과(와) ${b}을(를) 비교하면 ${ans}이(가) 더 큽니다.` };
}

function genPlaceValue(lessonName, digits, rng) {
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
  const answerIdx = options.indexOf(ans);
  return { text: `${num.toLocaleString('ko-KR')}에서 ${placeName ? placeName + '의 자리' : '일의 자리'} 숫자가 나타내는 값은 얼마입니까?`, options: options.map(o => o.toLocaleString('ko-KR')), answer: String(answerIdx), explanation: `${placeName || '일'}의 자리 숫자는 ${digit}이고, ${digit} × ${place.toLocaleString('ko-KR')} = ${ans.toLocaleString('ko-KR')}입니다.` };
}

function genAddition(lessonName, range, rng) {
  const a = Math.floor(rng() * range) + 1; const b = Math.floor(rng() * range) + 1; const ans = a + b;
  const distractors = new Set([ans - 1, ans + 1, ans - 2, ans + 2, a * b]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return { text: `${a} + ${b} = ?`, options: options.map(String), answer: String(answerIdx), explanation: `${a}에 ${b}을(를) 더하면 ${ans}입니다.` };
}

function genSubtraction(lessonName, range, rng) {
  const a = Math.floor(rng() * range) + 5; const b = Math.floor(rng() * (a - 1)) + 1; const ans = a - b;
  const distractors = new Set([ans + 1, ans - 1, a + b, ans + 2]); distractors.delete(ans);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * range) + 1);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return { text: `${a} - ${b} = ?`, options: options.map(String), answer: String(answerIdx), explanation: `${a}에서 ${b}을(를) 빼면 ${ans}입니다.` };
}

function genMultiplication(rng) {
  const a = Math.floor(rng() * 9) + 1; const b = Math.floor(rng() * 9) + 1; const ans = a * b;
  const distractors = new Set([ans + a, ans - a, ans + b, ans - b, a + b]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return { text: `${a} × ${b} = ?`, options: options.map(String), answer: String(answerIdx), explanation: `${a}에 ${b}을(를) 곱하면 ${ans}입니다.` };
}

function genDivision(rng) {
  const b = Math.floor(rng() * 8) + 2; const q = Math.floor(rng() * 9) + 1; const a = b * q;
  const distractors = new Set([q + 1, q - 1, q + 2, q * 2]); distractors.delete(q);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * 12) + 1);
  distractors.delete(q);
  const options = shuffle([q, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(q);
  return { text: `${a} ÷ ${b} = ?`, options: options.map(String), answer: String(answerIdx), explanation: `${a}을(를) ${b}로 나누면 ${q}입니다.` };
}

function genFraction(lessonName, rng) {
  const denom = Math.floor(rng() * 8) + 2; const num = Math.floor(rng() * (denom - 1)) + 1;
  const correct = `${num}/${denom}`;
  const distractors = [`${denom}/${num}`, `${num + 1}/${denom}`, `${num}/${denom + 1}`, `${num - 1}/${denom}`].filter(d => d !== correct);
  const options = shuffle([correct, ...distractors.slice(0, 4)], rng);
  const answerIdx = options.indexOf(correct);
  return { text: `전체를 ${denom}등분한 것 중 ${num}만큼을 분수로 나타내면 무엇입니까?`, options, answer: String(answerIdx), explanation: `전체를 ${denom}등분한 것 중 ${num}만큼은 ${correct}입니다.` };
}

function genShape(rng) {
  const shapes = [{ name: '삼각형', sides: 3 }, { name: '사각형', sides: 4 }, { name: '오각형', sides: 5 }, { name: '육각형', sides: 6 }];
  const target = pick(shapes, rng);
  const options = shuffle(shapes.map(s => s.name), rng).slice(0, 4);
  if (!options.includes(target.name)) options[0] = target.name;
  const answerIdx = options.indexOf(target.name);
  return { text: `변이 ${target.sides}개인 도형의 이름은 무엇입니까?`, options, answer: String(answerIdx), explanation: `변이 ${target.sides}개인 도형은 ${target.name}입니다.` };
}

function genMeasurement(rng) {
  const a = Math.floor(rng() * 90) + 10; const b = Math.floor(rng() * 90) + 10;
  const ans = Math.max(a, b);
  const distractors = new Set([Math.min(a, b), a + b, Math.abs(a - b)]);
  while (distractors.size < 4) distractors.add(Math.floor(rng() * 100) + 10);
  distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return { text: `${a}cm와 ${b}cm 중 더 긴 길이는 얼마입니까?`, options: options.map(o => o + 'cm'), answer: String(answerIdx), explanation: `${a}cm와 ${b}cm를 비교하면 ${ans}cm가 더 깁니다.` };
}

function genPattern(rng) {
  const start = Math.floor(rng() * 5) + 1; const step = Math.floor(rng() * 4) + 2;
  const seq = [start, start + step, start + step * 2, start + step * 3]; const ans = start + step * 4;
  const distractors = new Set([ans + step, ans - step, ans + 1, ans - 1]); distractors.delete(ans);
  const options = shuffle([ans, ...Array.from(distractors).slice(0, 4)], rng);
  const answerIdx = options.indexOf(ans);
  return { text: `다음 수 배열의 규칙을 찾아 빈칸에 알맞은 수를 구하시오.\n\n${seq.join(', ')}, ?`, options: options.map(String), answer: String(answerIdx), explanation: `${step}씩 커지는 규칙이므로 다음 수는 ${ans}입니다.` };
}

function genGraph(rng) {
  const counts = [Math.floor(rng() * 8) + 2, Math.floor(rng() * 8) + 2, Math.floor(rng() * 8) + 2, Math.floor(rng() * 8) + 2];
  const items = ['사과', '바나나', '포도', '딸기'];
  const maxIdx = counts.indexOf(Math.max(...counts));
  const ans = items[maxIdx];
  const options = shuffle(items, rng);
  const answerIdx = options.indexOf(ans);
  const lines = items.map((it, i) => `${it}: ${'■'.repeat(counts[i])} (${counts[i]}명)`).join('\n');
  return { text: `반 친구들이 좋아하는 과일을 조사한 결과입니다.\n\n${lines}\n\n가장 많이 좋아하는 과일은 무엇입니까?`, options, answer: String(answerIdx), explanation: `${ans}을(를) 좋아하는 친구가 ${counts[maxIdx]}명으로 가장 많습니다.` };
}

function generateProblem(lesson, grade, area, seedKey) {
  const lname = lesson || '';
  const rng = seededRand(seedKey + '_' + lname);
  if (/분수|기약|약분|통분|분모|분자/.test(lname)) return genFraction(lname, rng);
  if (/자릿값|위치적 기수법|다섯 자리|여섯 자리|큰 수|십만|백만|천만|억|조/.test(lname)) {
    const digits = /다섯/.test(lname) ? 5 : /여섯/.test(lname) ? 6 : /큰 수|십만|백만|천만|억|조/.test(lname) ? 6 : 3;
    return genPlaceValue(lname, digits, rng);
  }
  if (/곱셈|곱하|구구단/.test(lname)) return genMultiplication(rng);
  if (/나눗셈|나누/.test(lname)) return genDivision(rng);
  if (/덧셈|더하|합/.test(lname)) { const range = grade <= 1 ? 9 : grade <= 2 ? 99 : grade <= 3 ? 999 : 9999; return genAddition(lname, range, rng); }
  if (/뺄셈|빼/.test(lname)) { const range = grade <= 1 ? 9 : grade <= 2 ? 99 : grade <= 3 ? 999 : 9999; return genSubtraction(lname, range, rng); }
  if (/세기|개수/.test(lname)) { const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : /100까지/.test(lname) ? 100 : 9; return genCounting(lname, max, rng); }
  if (/읽고 쓰기|읽고|쓰기/.test(lname)) { const max = /9까지/.test(lname) ? 9 : 10; return genReadWrite(lname, max, rng); }
  if (/크기 비교|크기|비교/.test(lname)) { const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : /100까지/.test(lname) ? 100 : 1000; return genCompare(lname, max, rng); }
  if (/9까지|50까지|100까지|배열/.test(lname)) { const max = /9까지/.test(lname) ? 9 : /50까지/.test(lname) ? 50 : 100; return genCounting(lname, max, rng); }
  if (/삼각형|사각형|오각형|육각형|다각형|평면도형|입체도형|도형/.test(lname)) return genShape(rng);
  if (/길이|cm|m|넓이|들이|무게|시간/.test(lname)) return genMeasurement(rng);
  if (/규칙|배열|대응/.test(lname)) return genPattern(rng);
  if (/그래프|자료|분류|통계|평균|가능성/.test(lname)) return genGraph(rng);
  if (area === '도형과 측정') return genShape(rng);
  if (area === '변화와 관계') return genPattern(rng);
  if (area === '자료와 가능성') return genGraph(rng);
  if (grade <= 1) return genCounting(lname, 9, rng);
  if (grade <= 2) return genAddition(lname, 50, rng);
  if (grade <= 3) return genMultiplication(rng);
  return genFraction(lname, rng);
}

// ---------------------------------------------------------------------------
// quiz가 매핑 안 된 차시 노드 가져오기
const targets = db.prepare(`
  SELECT lmn.node_id, lmn.lesson_name, lmn.grade, lmn.area, lmn.subject, lmn.achievement_code
  FROM learning_map_nodes lmn
  WHERE lmn.node_level = 3
    AND NOT EXISTS (
      SELECT 1 FROM node_contents nc JOIN contents c ON c.id = nc.content_id
      WHERE nc.node_id = lmn.node_id AND c.content_type = 'quiz'
    )
  ORDER BY lmn.grade, lmn.node_id
`).all();
console.log(`[fill] 문항 없는 차시 노드: ${targets.length}개`);

const insContent = db.prepare(`
  INSERT INTO contents (
    creator_id, title, description, content_type, content_url, file_path,
    subject, grade, achievement_code, tags, is_public, status,
    difficulty, copyright, allow_comments, created_at
  ) VALUES (?, ?, ?, 'quiz', NULL, NULL, ?, ?, ?, ?, 1, 'approved', ?, 'CC-BY', 1, datetime('now'))
`);
const insQ = db.prepare(`
  INSERT INTO content_questions (
    content_id, question_number, question_text, question_type,
    options, answer, explanation, points, difficulty
  ) VALUES (?, 1, ?, 'multiple_choice', ?, ?, ?, 10, ?)
`);
const insStd = db.prepare('INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)');
const insNode = db.prepare(`INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, 'practice', ?)`);

const tx = db.transaction(() => {
  let inserted = 0;
  for (const n of targets) {
    const lesson = n.lesson_name || '';
    const grade = n.grade || 1;
    const area = n.area || '';
    const subject = n.subject || '수학';
    const code = n.achievement_code || '';

    for (let i = 1; i <= 2; i++) {
      const seedKey = `${n.node_id}_v${i}`;
      const gen = generateProblem(lesson, grade, area, seedKey);
      const title = `${lesson} - 문제 ${i}`;
      const desc = `자동 생성 문항. ${area} > ${lesson}. ${grade}학년.`;
      const tags = JSON.stringify([subject, area, lesson, code, '자동생성']);
      const diff = i === 1 ? 2 : 3;

      const ci = insContent.run(ADMIN_ID, title, desc, subject, grade, code, tags, diff);
      const cid = ci.lastInsertRowid;

      insQ.run(cid, gen.text, JSON.stringify(gen.options), gen.answer, gen.explanation, diff);
      insStd.run(cid, n.node_id);
      insNode.run(n.node_id, cid, i - 1);
      inserted++;
    }
    if (inserted % 200 === 0) console.log(`  진행: ${inserted}개 콘텐츠 삽입...`);
  }
  return inserted;
});

const total = tx();
console.log(`✅ 완료 — 신규 quiz 콘텐츠: ${total}개 (${targets.length}개 노드 × 2문항)`);

// 검증
const left = db.prepare(`
  SELECT COUNT(*) as c FROM learning_map_nodes lmn
  WHERE lmn.node_level = 3 AND NOT EXISTS (
    SELECT 1 FROM node_contents nc JOIN contents c ON c.id = nc.content_id
    WHERE nc.node_id = lmn.node_id AND c.content_type = 'quiz'
  )
`).get();
console.log(`📊 아직 문항 없는 차시 노드: ${left.c}개`);

db.close();
