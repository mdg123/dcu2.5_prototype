/**
 * shuffle-answer-positions.js
 *
 * questions_g3math.json — 460문항 모두 정답이 0번(첫 선택지)에 쏠려 있음.
 * 정답 위치를 결정성 시드로 셔플하여 분포를 균등화한다.
 *
 * 동작:
 *   - 각 문항의 options 배열을 셔플하고, answer 인덱스도 함께 업데이트
 *   - 문항 내용(question_text/explanation/선택지 텍스트)은 변경 없음
 *   - 결정성: node_id+question_number 로 시드 (재실행 가능)
 *
 * 입력/출력:
 *   - 입력: 작업지시서/콘텐츠빌드/questions_g3math.json
 *   - 출력: 같은 경로 덮어쓰기 (원본 백업: questions_g3math.json.bak)
 */

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '작업지시서', '콘텐츠빌드', 'questions_g3math.json');
const BAK = FILE + '.bak';

function seededRand(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000; };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function main() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  fs.writeFileSync(BAK, JSON.stringify(data, null, 2));
  console.log(`[backup] ${BAK}`);

  let totalShuffled = 0;
  let unchanged = 0;
  for (const item of data) {
    for (const q of item.questions) {
      const seed = `${item.node_id}#${q.question_number}`;
      const rng = seededRand(seed);
      const oldAnswerIdx = Number(q.answer);
      const correctText = q.options[oldAnswerIdx];
      const shuffled = shuffle(q.options, rng);
      const newAnswerIdx = shuffled.indexOf(correctText);
      if (newAnswerIdx === -1) {
        console.error(`[ERR] ${seed} — 셔플 후 정답 텍스트를 찾지 못함`);
        process.exit(1);
      }
      q.options = shuffled;
      q.answer = String(newAnswerIdx);
      if (newAnswerIdx !== oldAnswerIdx) totalShuffled++;
      else unchanged++;
    }
  }

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

  // 분포 확인
  const dist = { '0': 0, '1': 0, '2': 0, '3': 0 };
  for (const item of data) for (const q of item.questions) dist[String(q.answer)]++;
  const total = Object.values(dist).reduce((a, b) => a + b, 0);

  console.log(`[shuffled] 위치 변경: ${totalShuffled} / 유지: ${unchanged} (총 ${total}문항)`);
  console.log(`[new distribution]`);
  for (const k of ['0', '1', '2', '3']) {
    const pct = (dist[k] / total * 100).toFixed(1);
    console.log(`  ${k}번: ${dist[k]} (${pct}%)`);
  }
}

main();
