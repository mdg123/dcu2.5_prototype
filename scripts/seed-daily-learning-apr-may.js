/**
 * scripts/seed-daily-learning-apr-may.js
 *
 * "오늘의 학습" 4~5월(2026-04-01 ~ 2026-05-31) 배포 시드 스크립트
 *
 * - 학년: 초3·초4·초5·초6 (중1~고1은 contents 풀에 데이터 없음 → 스킵, 보고서 한계 명시)
 * - 매일 학년당 1세트 (수학 주제) — 영상 1~3개 + 퀴즈 1~2개 = 총 2~5 items
 * - 기존 (target_date, target_grade, target_subject, title) 조합이 있으면 스킵
 * - 결정적 시드(grade × dateOffset)로 재현 가능
 *
 * 실행: node scripts/seed-daily-learning-apr-may.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─────────────────────────────────────────────────────────
// 1. 설정
// ─────────────────────────────────────────────────────────
// ※ 이 스크립트는 **의도적으로 과거 특정 학기 구간**(4~5월)을 채우는 일회성 백필이다.
//   파일명·rebuild-daily-learning-alive-only.js 가 이 구간을 전제하므로 기본값은 유지한다.
//   다른 구간이 필요하면 --from YYYY-MM-DD --to YYYY-MM-DD 로 덮어쓴다(상대 날짜 생성용).
const _arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const START_DATE = _arg('--from', '2026-04-01');
const END_DATE = _arg('--to', '2026-05-31');

// 콘텐츠 풀이 있는 학년만 (3~6). 7~10(중·고)은 contents 0건 → 스킵.
const TARGET_GRADES = [3, 4, 5, 6];

// 시드 세트의 teacher_id (관리자가 시스템 배포)
const ADMIN_TEACHER_ID = 1; // admin

// 학년별 주제 (현재 콘텐츠 99% 수학이므로 수학 위주)
const SUBJECT = '수학';

// 학년별 한국어 표기
const gradeLabel = (g) => {
  if (g >= 1 && g <= 6) return `초${g}`;
  if (g >= 7 && g <= 9) return `중${g - 6}`;
  if (g === 10) return `고1`;
  return `${g}학년`;
};

// 결정적 PRNG (Mulberry32) — grade*1000 + dayOffset 으로 시드
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function eachDate(start, end) {
  const dates = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ─────────────────────────────────────────────────────────
// 2. 콘텐츠 풀 로드 (학년별)
// ─────────────────────────────────────────────────────────
function loadPool(grade) {
  const videos = db.prepare(`
    SELECT id, title, estimated_minutes, content_type
    FROM contents
    WHERE grade = ?
      AND content_type = 'video'
      AND status = 'approved'
      AND subject IN ('수학','수학과')
  `).all(grade);
  const quizzes = db.prepare(`
    SELECT id, title, estimated_minutes, content_type
    FROM contents
    WHERE grade = ?
      AND content_type = 'quiz'
      AND status = 'approved'
      AND subject IN ('수학','수학과')
  `).all(grade);
  return { videos, quizzes };
}

// ─────────────────────────────────────────────────────────
// 3. 중복 체크 + 삽입
// ─────────────────────────────────────────────────────────
const stmtCheckSet = db.prepare(`
  SELECT id FROM daily_learning_sets
  WHERE target_date = ? AND target_grade = ? AND title = ?
`);

const stmtInsertSet = db.prepare(`
  INSERT INTO daily_learning_sets
    (class_id, teacher_id, title, description, target_date, target_grade, target_subject, is_active, difficulty)
  VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, ?)
`);

const stmtInsertItem = db.prepare(`
  INSERT INTO daily_learning_items
    (set_id, source_type, content_id, item_title, sort_order, estimated_minutes, point_value)
  VALUES (?, 'content', ?, ?, ?, ?, 10)
`);

// 트랜잭션으로 묶어 빠르게 + 일관성
const seedAll = db.transaction(() => {
  let createdSets = 0;
  let skippedSets = 0;
  let totalItems = 0;
  const byGrade = {};
  const dates = eachDate(START_DATE, END_DATE);

  for (const grade of TARGET_GRADES) {
    const pool = loadPool(grade);
    if (pool.videos.length === 0 && pool.quizzes.length === 0) {
      console.warn(`[SKIP] grade=${grade} 수학 콘텐츠 풀 0건`);
      continue;
    }
    byGrade[grade] = { created: 0, skipped: 0, items: 0, videoPool: pool.videos.length, quizPool: pool.quizzes.length };

    dates.forEach((dateStr, dayIdx) => {
      const title = `${dateStr} ${gradeLabel(grade)} 오늘의 학습 (수학)`;
      // 중복 체크
      const existed = stmtCheckSet.get(dateStr, grade, title);
      if (existed) {
        byGrade[grade].skipped++;
        skippedSets++;
        return;
      }

      const rng = mulberry32(grade * 1000 + dayIdx);
      const videoN = pool.videos.length === 0 ? 0 : pickInt(rng, 1, Math.min(3, pool.videos.length));
      const quizN = pool.quizzes.length === 0 ? 0 : pickInt(rng, 1, Math.min(2, pool.quizzes.length));
      if (videoN + quizN === 0) return;

      const pickedVideos = shuffle(pool.videos, rng).slice(0, videoN);
      const pickedQuizzes = shuffle(pool.quizzes, rng).slice(0, quizN);

      // 추정 시간: 영상은 10분, 퀴즈는 4분 가정 (avg) → 10~30분
      const estDescMin = pickedVideos.reduce((s, v) => s + (v.estimated_minutes || 10), 0) +
                         pickedQuizzes.reduce((s, q) => s + Math.max(q.estimated_minutes || 1, 4), 0);
      const difficulty = grade <= 4 ? '쉬움' : (grade <= 5 ? '보통' : '보통');
      const description = `${gradeLabel(grade)} 학생을 위한 ${dateStr} 오늘의 학습입니다. 영상 ${videoN}개 + 퀴즈 ${quizN}개 (약 ${estDescMin}분)`;

      const insRes = stmtInsertSet.run(ADMIN_TEACHER_ID, title, description, dateStr, grade, SUBJECT, difficulty);
      const setId = insRes.lastInsertRowid;

      let sort = 1;
      // 영상 먼저, 퀴즈 뒤
      pickedVideos.forEach(v => {
        stmtInsertItem.run(setId, v.id, v.title, sort++, v.estimated_minutes || 10);
        totalItems++;
        byGrade[grade].items++;
      });
      pickedQuizzes.forEach(q => {
        stmtInsertItem.run(setId, q.id, q.title, sort++, Math.max(q.estimated_minutes || 1, 4));
        totalItems++;
        byGrade[grade].items++;
      });

      byGrade[grade].created++;
      createdSets++;
    });
  }

  return { createdSets, skippedSets, totalItems, byGrade };
});

// ─────────────────────────────────────────────────────────
// 4. 실행 + 보고
// ─────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════');
console.log('  오늘의 학습 4~5월 시드 적재 시작');
console.log(`  기간: ${START_DATE} ~ ${END_DATE}`);
console.log(`  대상 학년: ${TARGET_GRADES.map(gradeLabel).join(', ')}`);
console.log('═══════════════════════════════════════════════════════');

const t0 = Date.now();
const result = seedAll();
const elapsed = Date.now() - t0;

console.log('\n─── 결과 ───');
console.log(`총 생성 세트: ${result.createdSets}개`);
console.log(`중복 스킵 세트: ${result.skippedSets}개`);
console.log(`총 item: ${result.totalItems}개 (평균 ${(result.totalItems / Math.max(result.createdSets, 1)).toFixed(1)}개/세트)`);
console.log(`소요 시간: ${elapsed}ms`);

console.log('\n─── 학년별 상세 ───');
console.table(result.byGrade);

// 검증 쿼리
console.log('\n─── 검증: 적재 후 학년별 4~5월 세트 수 ───');
const verify = db.prepare(`
  SELECT target_grade, COUNT(*) c
  FROM daily_learning_sets
  WHERE target_date BETWEEN ? AND ?
  GROUP BY target_grade
  ORDER BY target_grade
`).all(START_DATE, END_DATE);
console.table(verify);

console.log('\n─── 검증: 평균 item 수 ───');
const itemAvg = db.prepare(`
  SELECT s.target_grade, COUNT(i.id) total_items, COUNT(DISTINCT s.id) total_sets,
         ROUND(CAST(COUNT(i.id) AS REAL) / COUNT(DISTINCT s.id), 2) avg_items
  FROM daily_learning_sets s
  LEFT JOIN daily_learning_items i ON i.set_id = s.id
  WHERE s.target_date BETWEEN ? AND ?
    AND s.teacher_id = ?
  GROUP BY s.target_grade
  ORDER BY s.target_grade
`).all(START_DATE, END_DATE, ADMIN_TEACHER_ID);
console.table(itemAvg);

console.log('\n─── 한계 사항 ───');
console.log('- 중1~중3(grade 7~9), 고1(grade 10): contents 풀에 0건 → 시드 생략');
console.log('- 향후 중·고 콘텐츠 import 후 동일 스크립트의 TARGET_GRADES만 확장하면 됨');

db.close();
console.log('\n완료.');
