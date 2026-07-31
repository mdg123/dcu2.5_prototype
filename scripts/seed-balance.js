#!/usr/bin/env node
/**
 * seed-balance.js
 *
 * 시드 분포 균등화 스크립트.
 *
 * 배경:
 *  - 검수 결과 두 가지 데이터 편향 발견.
 *    (1) 성장리포트 정서발달 막대그래프가 일부 요일(월·화·목)만 표시 — `attendance` 시드 편향.
 *    (2) LRS 활용 빈도 추이가 4/18~21에 비정상 스파이크 후 4/22 이후 급락 — `learning_logs` 시드 편향.
 *
 * 작업:
 *  - `attendance`: 클래스 2의 학생들에 대해 최근 4주간 7요일 균등 분포로 보강.
 *    감정(emotion)도 다양하게 분산(긍정/중립/부정 골고루).
 *  - `learning_logs`: 4/22 ~ 오늘(2026-05-07) 사이 일자별 5~15건씩 균등 분배,
 *    학생별·activity_type별·시간대별 분산.
 *
 * 원칙:
 *  - 멱등성: 이미 같은 (user_id, class_id, attendance_date) 또는
 *    (user_id, activity_type, created_at-분단위) 행이 있으면 스킵.
 *  - 테이블 스키마 변경 금지(마이그레이션 X).
 *  - 트랜잭션 사용. 실패 시 롤백.
 *
 * 실행:
 *   node scripts/seed-balance.js
 *   node scripts/seed-balance.js --dry-run     # 변경 없이 계획만 출력
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// ─────────────────────────── 유틸 ───────────────────────────
function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickWeighted(pairs) {
  const sum = pairs.reduce((s, p) => s + p[1], 0);
  let r = Math.random() * sum;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function fmtDateTime(d) {
  const date = fmtDate(d);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${date} ${hh}:${mm}:${ss}`;
}

// ─────────────────────────── 1) attendance 보강 ───────────────────────────
//   클래스 2의 학생 6명에 대해 오늘 기준 최근 4주(28일)를 일별로 순회하면서
//   주말 제외(토/일) → 평일(월~금)에만 출석. 7요일 균등 분포가 핵심이므로
//   주말도 일부 포함시켜 토·일 데이터도 0보다 크게 보장.
// ★ 과거에는 new Date('2026-05-07') 로 **고정**돼 있었다. 스크립트를 언제 돌리든
//   2026-05-07 기준으로만 데이터가 생겨, 시간이 지나면 최근 창(7일·30일)에서 전부 빠졌다.
//   → 실행 시점(오늘) 기준 상대 날짜로 생성한다. 재현이 필요하면 --today YYYY-MM-DD.
const _todayArg = (() => { const i = process.argv.indexOf('--today'); return i >= 0 ? process.argv[i + 1] : null; })();
const TODAY = _todayArg ? new Date(_todayArg + 'T00:00:00') : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');

const CLASS_ID = 2;
const studentRows = db
  .prepare(`SELECT cm.user_id FROM class_members cm
            JOIN users u ON u.id = cm.user_id
            WHERE cm.class_id = ? AND u.role = 'student' ORDER BY cm.user_id`)
  .all(CLASS_ID);
const STUDENT_IDS = studentRows.map(r => r.user_id);
console.log('[attendance] class 2 students:', STUDENT_IDS);

// 감정 분포: 긍정 60%, 중립 25%, 부정 15% — 다양성 확보
// 정본 감정 어휘 10키만 사용 (작업지시서/정서발달_감정어휘_정본화_스펙.md §1)
const POSITIVE_EMOTIONS = ['happy', 'excited', 'good', 'great', 'calm'];
const NEUTRAL_EMOTIONS = ['calm', 'good']; // 정본에 중립 버킷 없음 → 긍정 하단(calm/good)으로 대체
const NEGATIVE_EMOTIONS = ['tired', 'anxious', 'sad', 'frustrated'];

function pickEmotion() {
  const bucket = pickWeighted([['pos', 60], ['neu', 25], ['neg', 15]]);
  if (bucket === 'pos') return pick(POSITIVE_EMOTIONS);
  if (bucket === 'neu') return pick(NEUTRAL_EMOTIONS);
  return pick(NEGATIVE_EMOTIONS);
}
function emotionScoreOf(emotion) {
  if (POSITIVE_EMOTIONS.includes(emotion)) return Number(rand(0.6, 0.95).toFixed(2));
  if (NEUTRAL_EMOTIONS.includes(emotion)) return Number(rand(0.4, 0.6).toFixed(2));
  return Number(rand(0.1, 0.4).toFixed(2));
}
function emotionReason(emotion) {
  const map = {
    happy: '오늘 기분이 정말 좋아요',
    excited: '재미있는 수업이 기대돼요',
    good: '컨디션이 괜찮아요',
    great: '아침부터 활기차요',
    calm: '평온한 하루를 보내고 있어요',
    tired: '잠을 잘 못 잤어요',
    anxious: '시험이 걱정돼요',
    sad: '조금 우울해요',
    frustrated: '생각대로 잘 안 풀려요',
  };
  return map[emotion] || '특별한 이유는 없어요';
}

// 멱등 체크용 SELECT/INSERT
const checkAtt = db.prepare(
  `SELECT id FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?`
);
const insAtt = db.prepare(
  `INSERT INTO attendance
    (class_id, user_id, attendance_date, status, comment, checked_at,
     emotion, emotion_reason, emotion_reason_type, emotion_score, checkin_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, 'seed-balance')`
);

let attInserted = 0, attSkipped = 0;
const weekdayDist = [0, 0, 0, 0, 0, 0, 0]; // 월~일 누적

const attTx = db.transaction(() => {
  for (let dayBack = 0; dayBack < 28; dayBack++) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() - dayBack);
    const dateStr = fmtDate(d);
    const wday = d.getDay(); // 0=일,1=월,..,6=토

    for (const uid of STUDENT_IDS) {
      // 평일은 90% 출석, 주말은 50%만 (그래도 7요일 모두 0보다 크게 만듦)
      const isWeekend = wday === 0 || wday === 6;
      const presenceProb = isWeekend ? 0.5 : 0.9;
      if (Math.random() > presenceProb) continue;

      // 멱등 체크
      const existing = checkAtt.get(CLASS_ID, uid, dateStr);
      if (existing) { attSkipped++; continue; }

      const status = Math.random() < 0.97 ? 'present' : pick(['late', 'excused']);
      const emotion = pickEmotion();
      const reason = emotionReason(emotion);
      const score = emotionScoreOf(emotion);
      // checked_at: 출석 시간 08:30~09:10 사이로 자연스럽게
      const checkedAt = new Date(d);
      checkedAt.setHours(8, 30 + randInt(0, 40), randInt(0, 59), 0);
      const checkedAtStr = fmtDateTime(checkedAt);
      const comment = Math.random() < 0.3 ? pick([
        '오늘도 즐거운 하루!', '열심히 공부할게요', '컨디션 좋음', '친구들 보고 싶어요'
      ]) : null;

      if (!dryRun) {
        insAtt.run(CLASS_ID, uid, dateStr, status, comment, checkedAtStr,
          emotion, reason, score);
      }
      attInserted++;
      // 인덱스 변환: 월=0, 화=1, …, 일=6
      const idx = (wday + 6) % 7;
      weekdayDist[idx]++;
    }
  }
});
attTx();

console.log(`[attendance] 추가: ${attInserted}건, 스킵(중복): ${attSkipped}건`);
console.log('[attendance] 신규 시드 요일별 분포 (월~일):', weekdayDist);

// ─────────────────────────── 2) learning_logs 보강 ───────────────────────────
//   대상 기간: 2026-04-22 ~ 2026-05-07 (16일).
//   각 일자마다 학생별로 1~3건 활동, activity_type/verb/source_service 다양하게.
//   시간대도 09~17시 사이로 분산.

// TODAY 기준 역산(고정 '2026-04-22' 이었음 — 위 TODAY 주석 참조). 창 길이 16일 유지.
const LL_START = (() => { const d = new Date(TODAY); d.setDate(d.getDate() - 15); return d; })();
const LL_END = new Date(TODAY);
const ALL_STUDENTS = db
  .prepare(`SELECT id FROM users WHERE role = 'student' ORDER BY id`)
  .all().map(r => r.id);

// 학생이 속한 클래스 매핑
const studentClassMap = {};
for (const sid of ALL_STUDENTS) {
  const rows = db.prepare(
    `SELECT class_id FROM class_members WHERE user_id = ? ORDER BY class_id`
  ).all(sid);
  studentClassMap[sid] = rows.map(r => r.class_id);
}

// activity_type / verb / source_service 다양성
const ACTIVITY_PROFILES = [
  { type: 'content_view',     verb: 'accessed',  service: 'content',    weight: 35, dur: [60, 600] },
  { type: 'lesson_view',      verb: 'accessed',  service: 'class',      weight: 18, dur: [120, 900] },
  { type: 'self_learn',       verb: 'completed', service: 'self-learn', weight: 15, dur: [180, 1200] },
  { type: 'homework_submit',  verb: 'submitted', service: 'class',      weight: 8,  dur: [300, 1800] },
  { type: 'exam_complete',    verb: 'completed', service: 'cbt',        weight: 7,  dur: [600, 2400] },
  { type: 'problem_attempt',  verb: 'attempted', service: 'self-learn', weight: 8,  dur: [60, 300] },
  { type: 'attendance_checkin', verb: 'attended', service: 'growth',    weight: 5,  dur: [10, 30] },
  { type: 'post_create',      verb: 'created',   service: 'class',      weight: 4,  dur: [120, 600] },
];
const SUBJECT_CODES = ['KOR', 'MAT', 'ENG', 'SCI', 'SOC', null];
const PLATFORMS = ['web', 'web', 'web', 'mobile']; // web 위주
const DEVICE_TYPES = ['desktop', 'desktop', 'tablet', 'mobile'];

// 멱등성 전략:
//   learning_logs 는 동일 (user, type, 분) 키로 중복 차단 + 동시에
//   "이미 해당 일자에 seed-balance 마커 행이 N건 이상이면 더 추가하지 않음" 으로 상한 통제.
//   재실행 시 random 시각이 매번 다르므로 분 단위 키만으로는 idempotent 하지 않음.
//   → 일자별 marker 카운트로 캡 적용.
const TARGET_PER_DAY_MIN = 12; // 하루 최소 보장 시드 건수
const TARGET_PER_DAY_MAX = 18; // 하루 최대 시드 건수 (이미 도달했으면 스킵)
const checkLL = db.prepare(
  `SELECT id FROM learning_logs
   WHERE user_id = ? AND activity_type = ?
     AND substr(created_at, 1, 16) = ?`
);
const countDayMarker = db.prepare(
  `SELECT COUNT(*) AS c FROM learning_logs
   WHERE date(created_at) = ?
     AND metadata_json LIKE '%"seed":"seed-balance"%'`
);
const insLL = db.prepare(
  `INSERT INTO learning_logs
    (user_id, class_id, activity_type, verb, object_type, object_id,
     duration, metadata, created_at,
     source_service, subject_code, duration_sec, platform, device_type,
     session_id, metadata_json, result_score, result_success)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

let llInserted = 0, llSkipped = 0;
const dailyDist = {}; // 일자별 카운트

const llTx = db.transaction(() => {
  for (let d = new Date(LL_START); d <= LL_END; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    dailyDist[dateStr] = 0;

    // 일자별 상한(cap) 멱등 체크: 이미 같은 날 seed-balance 마커가
    // TARGET_PER_DAY_MAX 이상이면 이 날 추가 안 함.
    const existingMarker = countDayMarker.get(dateStr).c;
    if (existingMarker >= TARGET_PER_DAY_MIN) {
      // 이미 충분히 시드되어 있음 — 멱등성 보장 위해 스킵
      llSkipped += TARGET_PER_DAY_MIN;
      continue;
    }
    // 추가 가능한 수: TARGET_PER_DAY_MAX 까지
    const remainingBudget = TARGET_PER_DAY_MAX - existingMarker;
    let dayInsertedSoFar = 0;

    // 일자별 목표 카운트: 학생 풀 × 1~3건. 학생을 셔플.
    const shuffled = [...ALL_STUDENTS].sort(() => Math.random() - 0.5);
    for (const uid of shuffled) {
      if (dayInsertedSoFar >= remainingBudget) break;
      const sessions = randInt(1, 3);
      const cls = studentClassMap[uid] && studentClassMap[uid].length
        ? pick(studentClassMap[uid]) : null;
      const sessId = `seed-bal-${uid}-${dateStr.replace(/-/g, '')}-${randInt(1000, 9999)}`;

      for (let s = 0; s < sessions; s++) {
        if (dayInsertedSoFar >= remainingBudget) break;
        const profile = pickWeighted(
          ACTIVITY_PROFILES.map(p => [p, p.weight])
        );
        // 시간대: 09~17시 분산
        const hh = randInt(9, 17);
        const mm = randInt(0, 59);
        const ts = new Date(d);
        ts.setHours(hh, mm, randInt(0, 59), 0);
        const createdAt = fmtDateTime(ts);
        const minuteKey = createdAt.slice(0, 16);

        // 멱등 체크: 같은 (uid, type, 분) 행이 있으면 스킵
        const existing = checkLL.get(uid, profile.type, minuteKey);
        if (existing) { llSkipped++; continue; }

        const durSec = randInt(profile.dur[0], profile.dur[1]);
        const objectType = profile.type === 'content_view' ? 'content'
          : profile.type === 'lesson_view' ? 'lesson'
          : profile.type === 'homework_submit' ? 'homework'
          : profile.type === 'exam_complete' ? 'exam'
          : profile.type === 'problem_attempt' ? 'problem'
          : profile.type === 'self_learn' ? 'daily-learning'
          : profile.type === 'post_create' ? 'post'
          : 'activity';
        const objectId = String(randInt(1, 200));
        const subject = pick(SUBJECT_CODES);
        const platform = pick(PLATFORMS);
        const device = pick(DEVICE_TYPES);
        const score = profile.verb === 'completed' ? Number(rand(0.6, 1.0).toFixed(2))
          : profile.verb === 'attempted' ? Number(rand(0.4, 0.9).toFixed(2))
          : null;
        const success = score === null ? null : (score >= 0.6 ? 1 : 0);
        const meta = JSON.stringify({ seed: 'seed-balance', date: dateStr });

        if (!dryRun) {
          insLL.run(
            uid, cls, profile.type, profile.verb,
            objectType, objectId,
            durSec, meta, createdAt,
            profile.service, subject, durSec, platform, device,
            sessId, meta, score, success
          );
        }
        llInserted++;
        dayInsertedSoFar++;
        dailyDist[dateStr]++;
      }
    }
  }
});
llTx();

console.log(`[learning_logs] 추가: ${llInserted}건, 스킵(중복): ${llSkipped}건`);
console.log('[learning_logs] 일자별 신규 시드 분포:');
Object.keys(dailyDist).sort().forEach(d => console.log('  ', d, '→', dailyDist[d]));

if (dryRun) {
  console.log('\n[DRY-RUN] 실제 변경 없음. 다시 실행 시 --dry-run 제거.');
} else {
  console.log('\n[OK] 시드 보강 완료. 멱등성 검증을 위해 같은 명령을 한 번 더 실행해 보세요.');
}

db.close();
