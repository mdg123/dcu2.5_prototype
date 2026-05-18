/**
 * scripts/seed-daily-learning-middle-high.js
 *
 * "오늘의 학습" 4~5월(2026-04-01 ~ 2026-05-31) 중·고 배포 시드 스크립트
 *
 * - 학년: 중1·중2·중3·고1 (target_grade 정수 매핑 7·8·9·10)
 * - contents 식별: (school_level, grade) 조합 사용
 *     · 중1: school_level IN ('middle','중학교') AND grade = 1
 *     · 중2: school_level IN ('middle','중학교') AND grade = 2
 *     · 중3: school_level IN ('middle','중학교') AND grade = 3
 *     · 고1: school_level IN ('high','고등학교','고')   AND grade = 1
 *   subject: '수학' 또는 '수학과' (둘 다 포함)
 * - 매일 학년당 1세트 — 영상 1~3 + 퀴즈 1~2 (각 풀 가용 한도 내)
 *   · quiz 풀 0건 → 영상 위주 세트 (video N=2~3)
 *   · video 풀 0건 → 같은 학교급 인접 학년 video로 fallback (없으면 quiz 위주 N=2~3)
 *   · 고1처럼 video 풀이 0건이면 중3 video 풀로 fallback
 * - 중복 정책: (target_date, target_grade, title) 동일 세트 존재 시 스킵 (멱등)
 * - title prefix에 "중1·중2·중3·고1" 라벨 포함 (target_grade가 정수 한 컬럼만 있어
 *   학교급 식별이 모호한 경우 title 으로도 식별 가능하도록)
 *
 * 실행: node scripts/seed-daily-learning-middle-high.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─────────────────────────────────────────────────────────
// 1. 설정
// ─────────────────────────────────────────────────────────
const START_DATE = '2026-04-01';
const END_DATE = '2026-05-31';

// (라벨, target_grade 정수, school_level 후보 배열, content grade 정수)
const TARGETS = [
  { label: '중1', targetGrade: 7,  levels: ['middle', '중학교'], gradeInContent: 1 },
  { label: '중2', targetGrade: 8,  levels: ['middle', '중학교'], gradeInContent: 2 },
  { label: '중3', targetGrade: 9,  levels: ['middle', '중학교'], gradeInContent: 3 },
  { label: '고1', targetGrade: 10, levels: ['high', '고등학교', '고'], gradeInContent: 1 },
];

// 고1 video 풀이 비었을 때 fallback 으로 빌릴 학교급/학년
const VIDEO_FALLBACK = {
  10: { levels: ['middle', '중학교'], gradeInContent: 3 }, // 고1 → 중3 video
};

const ADMIN_TEACHER_ID = 1; // admin (시스템 배포)
const SUBJECT = '수학';

// 결정적 PRNG
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
// 2. 콘텐츠 풀 로드
// ─────────────────────────────────────────────────────────
function loadByLevels(levels, contentGrade, contentType) {
  // levels 배열 → IN 절
  const placeholders = levels.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, title, estimated_minutes, content_type
    FROM contents
    WHERE school_level IN (${placeholders})
      AND grade = ?
      AND content_type = ?
      AND status = 'approved'
      AND subject IN ('수학','수학과')
  `).all(...levels, contentGrade, contentType);
}

function loadPool(target) {
  let videos = loadByLevels(target.levels, target.gradeInContent, 'video');
  let quizzes = loadByLevels(target.levels, target.gradeInContent, 'quiz');

  // video fallback
  if (videos.length === 0 && VIDEO_FALLBACK[target.targetGrade]) {
    const fb = VIDEO_FALLBACK[target.targetGrade];
    videos = loadByLevels(fb.levels, fb.gradeInContent, 'video');
  }
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

const seedAll = db.transaction(() => {
  let createdSets = 0;
  let skippedSets = 0;
  let totalItems = 0;
  const byGrade = {};
  const dates = eachDate(START_DATE, END_DATE);

  for (const target of TARGETS) {
    const pool = loadPool(target);
    const stats = {
      label: target.label,
      videoPool: pool.videos.length,
      quizPool: pool.quizzes.length,
      created: 0,
      skipped: 0,
      items: 0,
    };
    byGrade[target.targetGrade] = stats;

    if (pool.videos.length === 0 && pool.quizzes.length === 0) {
      console.warn(`[SKIP] ${target.label}(target_grade=${target.targetGrade}) — 풀 0건`);
      continue;
    }

    dates.forEach((dateStr, dayIdx) => {
      const title = `${dateStr} ${target.label} 오늘의 학습 (수학)`;
      const existed = stmtCheckSet.get(dateStr, target.targetGrade, title);
      if (existed) {
        stats.skipped++;
        skippedSets++;
        return;
      }

      const rng = mulberry32(target.targetGrade * 1000 + dayIdx);

      // 기본: video 1~3, quiz 1~2
      let videoN = pool.videos.length === 0 ? 0 : pickInt(rng, 1, Math.min(3, pool.videos.length));
      let quizN = pool.quizzes.length === 0 ? 0 : pickInt(rng, 1, Math.min(2, pool.quizzes.length));

      // 한쪽이 0일 때 다른 쪽으로 N을 늘려 최소 2 items 확보
      if (videoN === 0 && quizN > 0) {
        quizN = Math.min(pool.quizzes.length, pickInt(rng, 2, 3));
      }
      if (quizN === 0 && videoN > 0) {
        videoN = Math.min(pool.videos.length, pickInt(rng, 2, 3));
      }
      if (videoN + quizN === 0) return;

      const pickedVideos = shuffle(pool.videos, rng).slice(0, videoN);
      const pickedQuizzes = shuffle(pool.quizzes, rng).slice(0, quizN);

      const estDescMin =
        pickedVideos.reduce((s, v) => s + (v.estimated_minutes || 10), 0) +
        pickedQuizzes.reduce((s, q) => s + Math.max(q.estimated_minutes || 1, 4), 0);

      const difficulty = target.targetGrade <= 8 ? '보통' : '어려움'; // 중1·중2 보통, 중3·고1 어려움
      const description = `${target.label} 학생을 위한 ${dateStr} 오늘의 학습입니다. 영상 ${videoN}개 + 퀴즈 ${quizN}개 (약 ${estDescMin}분)`;

      const insRes = stmtInsertSet.run(
        ADMIN_TEACHER_ID, title, description, dateStr,
        target.targetGrade, SUBJECT, difficulty
      );
      const setId = insRes.lastInsertRowid;

      let sort = 1;
      pickedVideos.forEach(v => {
        stmtInsertItem.run(setId, v.id, v.title, sort++, v.estimated_minutes || 10);
        totalItems++;
        stats.items++;
      });
      pickedQuizzes.forEach(q => {
        stmtInsertItem.run(setId, q.id, q.title, sort++, Math.max(q.estimated_minutes || 1, 4));
        totalItems++;
        stats.items++;
      });

      stats.created++;
      createdSets++;
    });
  }

  return { createdSets, skippedSets, totalItems, byGrade };
});

// ─────────────────────────────────────────────────────────
// 4. 실행 + 보고
// ─────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════');
console.log('  오늘의 학습 4~5월 시드 (중1~고1) 적재 시작');
console.log(`  기간: ${START_DATE} ~ ${END_DATE}`);
console.log(`  대상 학년: ${TARGETS.map(t => `${t.label}(target_grade=${t.targetGrade})`).join(', ')}`);
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
console.log('\n─── 검증: 적재 후 학년별(target_grade) 4~5월 세트 수 ───');
const verify = db.prepare(`
  SELECT target_grade, COUNT(*) c
  FROM daily_learning_sets
  WHERE target_date BETWEEN ? AND ?
  GROUP BY target_grade
  ORDER BY target_grade
`).all(START_DATE, END_DATE);
console.table(verify);

console.log('\n─── 검증: 중·고 평균 item 수 ───');
const itemAvg = db.prepare(`
  SELECT s.target_grade, COUNT(i.id) total_items, COUNT(DISTINCT s.id) total_sets,
         ROUND(CAST(COUNT(i.id) AS REAL) / COUNT(DISTINCT s.id), 2) avg_items
  FROM daily_learning_sets s
  LEFT JOIN daily_learning_items i ON i.set_id = s.id
  WHERE s.target_date BETWEEN ? AND ?
    AND s.target_grade IN (7,8,9,10)
  GROUP BY s.target_grade
  ORDER BY s.target_grade
`).all(START_DATE, END_DATE);
console.table(itemAvg);

db.close();
console.log('\n완료.');
