#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// scripts/backfill-daily-learning-logs.js
// ─────────────────────────────────────────────────────────────────────────────
// 오늘의 학습 이수(daily_learning_progress.status='completed') 중 대응 learning_logs 가
// 없는 건을 소급 발행한다. (LRS "활동 유형별 요약/추이" 에 자기주도 학습으로 잡히게)
//
// 배경:
//   - completeDailyItem()(db/self-learn-extended.js)는 현재 오늘의 학습 이수 시
//     logLearningActivity({ activity_type:'daily_complete', source_service:'self-learn' }) 를 발행한다.
//   - 하지만 이 발행이 코드에 추가되기 "이전"에 이수된 기록(구버전)은 learning_logs 가 없다.
//   - 그 결과 오늘의 학습 이수가 LRS 표/추이에서 누락된다.
//   - LRS /stats/perform 은 daily_complete 를 self_learn 버킷(자기주도 학습)으로 합산한다(routes/lrs.js 수정 완료).
//     따라서 백필도 runtime 과 동일하게 activity_type='daily_complete' 로 발행하면 LRS 에 자동 반영된다.
//
// 멱등성(재실행 안전):
//   - "대응 learning_log 없음" 조건 = 같은 (user_id, target_type='daily_learning', target_id=item_id)
//     의 activity_type IN ('daily_complete','self_learn') 로그가 하나도 없을 때만 발행.
//   - 재실행 시 이미 발행된 건은 EXISTS 검사에서 걸러져 중복 생성 0.
//
// 날짜 귀속:
//   - created_at = 원래 이수 시각(daily_learning_progress.completed_at) — 배정일/활동일 정합 유지.
//
// 추적/식별:
//   - 백필분은 metadata.backfill='daily-learning-logs' + metadata.backfilled_at 마커로 식별 가능.
//   - is_seed 는 0 유지(실 사용자 활동이므로 시드가 아님). 되돌리려면 아래 --revert 사용.
//
// 사용법:
//   node scripts/backfill-daily-learning-logs.js              # 실행(발행)
//   node scripts/backfill-daily-learning-logs.js --dry-run    # 미리보기(발행 안 함)
//   node scripts/backfill-daily-learning-logs.js --revert     # 백필분만 삭제(마커 기준)
//
// GCP 실행(PM):
//   base64 로 전송 후 서버에서 디코드하여 위 명령 실행. (본 파일 하단 "GCP 실행법" 주석 참조)
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const db = require(path.join(__dirname, '..', 'db')); // 싱글톤 (DB_PATH 존중)
const { logLearningActivity } = require(path.join(__dirname, '..', 'db', 'learning-log-helper'));

const DRY_RUN = process.argv.includes('--dry-run');
const REVERT = process.argv.includes('--revert');
const BACKFILL_MARKER = 'daily-learning-logs';

// ── revert 모드: 마커 기준 백필분만 삭제 ──
if (REVERT) {
  const marked = db.prepare(`
    SELECT id FROM learning_logs
    WHERE activity_type = 'daily_complete'
      AND source_service = 'self-learn'
      AND (metadata LIKE '%"backfill":"${BACKFILL_MARKER}"%'
        OR metadata_json LIKE '%"backfill":"${BACKFILL_MARKER}"%')
  `).all();
  if (!marked.length) { console.log('[revert] 삭제할 백필분 없음.'); process.exit(0); }
  const delTx = db.transaction((ids) => {
    const del = db.prepare('DELETE FROM learning_logs WHERE id = ?');
    for (const { id } of ids) del.run(id);
  });
  delTx(marked);
  console.log(`[revert] 백필분 ${marked.length} 건 삭제 완료.`);
  process.exit(0);
}

// ── 성취기준 해석 (completeDailyItem 과 동일 규칙: node → content → node_contents) ──
function resolveAchievement(nodeId, contentId) {
  if (nodeId) {
    try {
      const r = db.prepare('SELECT achievement_code FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
      if (r && r.achievement_code && String(r.achievement_code).trim() !== '') return String(r.achievement_code).trim();
    } catch (_) {}
  }
  if (contentId) {
    try {
      const r = db.prepare('SELECT achievement_code FROM contents WHERE id = ?').get(contentId);
      if (r && r.achievement_code && String(r.achievement_code).trim() !== '') return String(r.achievement_code).trim();
    } catch (_) {}
    try {
      const r = db.prepare(`
        SELECT lmn.achievement_code
        FROM node_contents nc
        JOIN learning_map_nodes lmn ON nc.node_id = lmn.node_id
        WHERE nc.content_id = ? AND lmn.achievement_code IS NOT NULL AND lmn.achievement_code <> ''
        LIMIT 1
      `).get(contentId);
      if (r && r.achievement_code && String(r.achievement_code).trim() !== '') return String(r.achievement_code).trim();
    } catch (_) {}
  }
  return null;
}

function resolveSubjectCode(achievementCode) {
  if (!achievementCode) return null;
  try {
    const ctx = require(path.join(__dirname, '..', 'db', 'lrs-mastery')).resolveCode(achievementCode);
    return ctx && ctx.subject_code ? ctx.subject_code : null;
  } catch (_) { return null; }
}

// contents 시청형(영상/자료)은 점수 없음 → result_score NULL (매트릭스/표에서 '-' 로 정상 표시).
const NON_SCORED = new Set(['video', 'document', 'image', 'external', 'audio']);

// ── 백필 대상: 대응 learning_log(daily_complete/self_learn) 없는 완료 이수 ──
const orphans = db.prepare(`
  SELECT p.user_id, p.item_id, p.set_id, p.score, p.completed_at,
         i.content_id, i.node_id,
         c.content_type,
         s.class_id AS set_class_id
  FROM daily_learning_progress p
  JOIN daily_learning_items i ON i.id = p.item_id
  LEFT JOIN daily_learning_sets s ON s.id = i.set_id
  LEFT JOIN contents c ON c.id = i.content_id
  WHERE p.status = 'completed'
    AND p.completed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM learning_logs ll
      WHERE ll.user_id = p.user_id
        AND ll.target_type = 'daily_learning'
        AND ll.target_id = CAST(p.item_id AS TEXT)
        AND ll.activity_type IN ('daily_complete', 'self_learn')
    )
  ORDER BY p.completed_at ASC
`).all();

console.log(`[backfill] 대상(대응 로그 없는 완료 이수): ${orphans.length} 건${DRY_RUN ? ' (DRY-RUN)' : ''}`);

let issued = 0, skippedNoLog = 0;
for (const o of orphans) {
  const isNonScored = o.content_type && NON_SCORED.has(String(o.content_type).toLowerCase());
  // completeDailyItem 과 동일: 시청형은 점수 NULL. 그 외는 score(0-100) → 0-1 스케일.
  const resultScore = (isNonScored || o.score == null) ? null : (Number(o.score) / 100);
  const achievementCode = resolveAchievement(o.node_id || null, o.content_id || null);
  const subjectCode = resolveSubjectCode(achievementCode);
  // class_id: 세트가 클래스 전용이면 그 class_id, 글로벌 세트(class_id NULL)면 NULL 유지
  //   (self-learn 로그는 원래 class_id 대부분 NULL — 런타임 completeDailyItem 도 classId 미전달로 NULL).
  const classId = o.set_class_id || null;

  if (DRY_RUN) {
    console.log(`  - user=${o.user_id} item=${o.item_id} at=${o.completed_at} score=${resultScore == null ? '-' : resultScore} ach=${achievementCode || '-'} class=${classId || '-'}`);
    issued++;
    continue;
  }

  const res = logLearningActivity({
    userId: o.user_id,
    activityType: 'daily_complete',
    targetType: 'daily_learning',
    targetId: o.item_id,
    classId,
    verb: 'completed',
    sourceService: 'self-learn',
    resultScore,
    achievementCode: achievementCode || null,
    subjectCode: subjectCode || null,
    // 원래 이수 시각으로 귀속
    createdAt: o.completed_at,
    // 백필 식별 마커
    metadata: { backfill: BACKFILL_MARKER, backfilled_at: new Date().toISOString(), item_id: o.item_id, set_id: o.set_id }
  });
  if (res && res.id) issued++;
  else skippedNoLog++;
}

if (DRY_RUN) {
  console.log(`[backfill] DRY-RUN 종료 — 발행 예정 ${issued} 건 (실제 발행 안 함).`);
} else {
  console.log(`[backfill] 완료 — 발행 ${issued} 건, 실패 ${skippedNoLog} 건.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GCP 실행법 (PM 참고):
//   1) 로컬에서 base64 인코딩:
//        base64 -w0 scripts/backfill-daily-learning-logs.js   (Windows: certutil 또는 PowerShell 사용)
//   2) 서버에서 디코드 후 앱 유저(ubuntu)로 실행:
//        sudo -iu ubuntu bash -lc 'cd /home/ubuntu/dacheum && echo "<BASE64>" | base64 -d > scripts/backfill-daily-learning-logs.js && node scripts/backfill-daily-learning-logs.js'
//   3) 앱 재시작 불필요(데이터만 소급). 대시보드는 쿼리 시점 재계산이라 즉시 반영.
// ─────────────────────────────────────────────────────────────────────────────
