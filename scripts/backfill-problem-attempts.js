require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * scripts/backfill-problem-attempts.js  —  성장기록 정합성 #5 백필 (의도된 데이터 정합 수정)
 *
 * 목적
 *   레거시/시드 단계에서 학생의 콘텐츠 문항 풀이가 learning_logs(activity_type='problem_attempt')
 *   에는 기록되었으나 정본 테이블 problem_attempts 에는 적재되지 않은 행이 있다.
 *   성취수준 축 'content' 출처는 problem_attempts 를 정본으로 단일 집계하므로, 이 누락분을
 *   problem_attempts 로 INSERT 하여 카드/축의 정답률(예: id3 content#412 정답3/오답6 → 33%)을 정합화한다.
 *
 * 대상 / 매핑
 *   - learning_logs.activity_type = 'problem_attempt' 행 중 object_id 로 content_id 를 해석할 수 있는 행만 적재.
 *     · object_id 가 'urn:...:content:NN' 또는 끝이 'content:NN' → content_id = NN, source_type = 'content'
 *   - node_id: node_contents 매핑이 있으면 보강(없으면 NULL).
 *   - is_correct: learning_logs.result_success (1=정답, 그 외 0).
 *   - submitted_at: learning_logs.created_at.
 *   ※ self-learn(node 기준) 행은 현 시드 데이터상 content_id/node 해석 불가(urn:...:problem:NN, 바닐라 숫자)라
 *     problem_attempts(content_id NOT NULL) 에 적재 불가 → 제외. node 해석 가능 행이 생기면 자동 포함된다.
 *   ※ today_learning 은 daily_learning_progress 가 정본이므로 절대 섞지 않는다(이 스크립트는 problem_attempt 만 대상).
 *
 * 멱등 (중복 방지)
 *   중복방지키 (user_id, content_id, submitted_at). 같은 키에 여러 시도(동일 타임스탬프 다건)가 정상 존재하므로
 *   "키별 learning_logs 건수 − 키별 기존 problem_attempts 건수 = 부족분" 만큼만 추가 INSERT 한다.
 *     · 최초 실행: 부족분 전량 적재 (예: id3/412/3타임스탬프 = 9건)
 *     · 재실행: 부족분 0 → 0건 적재 (완전 멱등)
 *
 * 실행
 *   미리보기:  node scripts/backfill-problem-attempts.js --dry
 *   적용:      node scripts/backfill-problem-attempts.js --apply
 *   (플래그 없으면 안전상 --dry 로 동작)
 *
 * GCP 적용
 *   DB 경로는 환경변수 DB_PATH 로 오버라이드 가능(미지정 시 ../data/dacheum.db).
 *   예) DB_PATH=/app/data/dacheum.db node scripts/backfill-problem-attempts.js --apply
 *
 * 안전
 *   - 단일 트랜잭션. DB가 서버에 의해 잠겨 있으면 실패 → 서버 정지 후 실행 권고.
 *   - 읽기 검증만 하는 --dry 가 기본.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY; // 기본은 dry

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('=== #5 problem_attempts 백필 ===');
console.log('DB:', DB_PATH);
console.log('모드:', APPLY ? 'APPLY (쓰기)' : 'DRY-RUN (읽기 전용 미리보기)');

// object_id → content_id 추출: 'content:' 뒤의 숫자만.
function contentIdOf(objectId) {
  if (!objectId) return null;
  const m = String(objectId).match(/content:(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// 1) 후보 learning_logs 수집 (content_id 해석 가능 행만)
const logs = db.prepare(`
  SELECT id, user_id, object_id, result_success, created_at
  FROM learning_logs
  WHERE activity_type = 'problem_attempt'
    AND object_id LIKE '%content:%'
`).all();

// 키별(=user_id|content_id|submitted_at) 후보 그룹화
const candByKey = new Map(); // key -> [{user_id, content_id, is_correct, submitted_at}]
let skippedNoContent = 0;
for (const r of logs) {
  const cid = contentIdOf(r.object_id);
  if (cid == null) { skippedNoContent++; continue; }
  const submittedAt = r.created_at;
  const key = `${r.user_id}|${cid}|${submittedAt}`;
  const rec = {
    user_id: r.user_id,
    content_id: cid,
    is_correct: r.result_success === 1 ? 1 : 0,
    submitted_at: submittedAt
  };
  if (!candByKey.has(key)) candByKey.set(key, []);
  candByKey.get(key).push(rec);
}

// 2) 키별 기존 problem_attempts 건수 조회 → 부족분 산출 (멱등)
const countExisting = db.prepare(`
  SELECT COUNT(*) c FROM problem_attempts
  WHERE user_id = ? AND content_id = ? AND submitted_at = ?
`);
// node_id 보강용 매핑
const nodeForContent = db.prepare(`
  SELECT node_id FROM node_contents WHERE content_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1
`);

const toInsert = []; // 실제 INSERT 할 레코드
let alreadyCovered = 0;
for (const [key, recs] of candByKey) {
  const [uid, cid, sat] = key.split('|');
  const existing = countExisting.get(parseInt(uid, 10), parseInt(cid, 10), sat).c;
  const deficit = recs.length - existing;
  if (deficit <= 0) { alreadyCovered += recs.length; continue; }
  // 부족분만큼, 정렬된 후보 앞에서부터 적재(정답/오답 분포는 그대로 보존)
  for (let i = 0; i < deficit; i++) {
    const rec = recs[i];
    const nodeRow = nodeForContent.get(rec.content_id);
    toInsert.push({ ...rec, node_id: nodeRow ? nodeRow.node_id : null, source_type: 'content' });
  }
}

// 3) 미리보기 요약 (사용자별·콘텐츠별)
const byUserContent = {};
for (const r of toInsert) {
  const k = `user${r.user_id}/content${r.content_id}`;
  if (!byUserContent[k]) byUserContent[k] = { total: 0, correct: 0 };
  byUserContent[k].total++;
  if (r.is_correct) byUserContent[k].correct++;
}
console.log('\n--- 적재 대상 요약 ---');
console.log(`후보 learning_logs(content 해석가능): ${logs.length - skippedNoContent}건 (content_id 해석 불가 제외: ${skippedNoContent}건)`);
console.log(`이미 적재되어 skip: ${alreadyCovered}건`);
console.log(`신규 적재 예정: ${toInsert.length}건`);
Object.entries(byUserContent).sort().forEach(([k, v]) => {
  console.log(`  ${k}: +${v.total}건 (정답 ${v.correct} / 오답 ${v.total - v.correct}, 정답률 ${v.total ? Math.round(v.correct / v.total * 100) : 0}%)`);
});

// 4) 적용
if (DRY) {
  console.log('\n[DRY-RUN] 실제 적재하지 않았습니다. 적용하려면 --apply 로 재실행하세요.');
  db.close();
  process.exit(0);
}

const insert = db.prepare(`
  INSERT INTO problem_attempts (user_id, content_id, node_id, is_correct, submitted_at, source_type)
  VALUES (@user_id, @content_id, @node_id, @is_correct, @submitted_at, @source_type)
`);
const tx = db.transaction((rows) => {
  for (const r of rows) insert.run(r);
});
tx(toInsert);

console.log(`\n[APPLY] problem_attempts 신규 적재: ${toInsert.length}건 완료.`);

// 5) 검증: source_type='content' 총건수
const contentNow = db.prepare(`SELECT COUNT(*) c, SUM(is_correct) cc FROM problem_attempts WHERE source_type='content'`).get();
console.log(`검증) problem_attempts source_type='content' 총 ${contentNow.c}건 (정답 ${contentNow.cc}).`);
console.log('=== 백필 완료 ===');
db.close();
