require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// scripts/fix-wrong-answers-integrity.js
//
// 오답노트(wrong_answers) 데이터 위생 정리 — 멱등(idempotent) 스크립트.
// 오답노트 "다시 풀기" 플레이어 백엔드(원본 복구 + 서버 채점)의 전제 데이터를 교정한다.
//
// 처리 항목 (기획서 §0.3 데이터 실측 기반):
//   1) 백업    — 정리 전 wrong_answers 전 행을 backups/wrong-answers-pre-fix-<ts>.json 으로 저장.
//   2) source  — 실출처 미구분('auto') 교정:
//                  · exam_id NOT NULL          → 'exam'
//                  · is_manual = 1             → 'manual'
//                  · exam_id NULL & 판별불가   → 'manual'(폴백, correct_answer 보유분) / 보존+로그
//   3) question_text — 플레이스홀더("문제 N")/빈 값을 exams.answers 원본 text로 백필(멀쩡한 값 보존).
//   4) student_answer — '[object Object]' 등 손상값을 NULL 로 정규화(원본 의미 없음).
//
// 안전장치:
//   - 멱등: 이미 교정된 행은 다시 바꾸지 않음(플레이스홀더/손상 패턴에만 매칭).
//   - 타 정상 데이터 훼손 0: 멀쩡한 question_text/source/student_answer 는 손대지 않음.
//   - --dry 플래그: 실제 UPDATE 없이 예상 변경만 집계·로그.
//
// 사용법:
//   node scripts/fix-wrong-answers-integrity.js          # 백업 + 실제 정리
//   node scripts/fix-wrong-answers-integrity.js --dry     # 미리보기(변경 없음)

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry');
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dacheum.db');
const BACKUP_DIR = path.join(ROOT, 'backups');

const db = new Database(DB_PATH);

// ── 손상/플레이스홀더 판별 ─────────────────────────────────────────────
function isPlaceholderText(t) {
  if (t == null) return true;
  const s = String(t).trim();
  if (s === '') return true;
  // "문제 1", "문제 12" 등 — 실제 지문이 아닌 순번 플레이스홀더
  if (/^문제\s*\d+$/.test(s)) return true;
  return false;
}
function isCorruptAnswer(a) {
  if (a == null) return false;
  const s = String(a).trim();
  if (s === '') return true;
  if (/\[object\s+object\]/i.test(s)) return true;
  return false;
}

// ── exams.answers 에서 (exam_id, question_number) 원본 문항 객체 조회 ──
//   두 가지 스키마 흡수:
//     A) { number, text, type, options, answer, points }   (number == question_number)
//     B) { question, options, answer, explanation }         (number 없음 → 배열 index+1 == question_number)
const examCache = new Map();
function getExamAnswers(examId) {
  if (examCache.has(examId)) return examCache.get(examId);
  let arr = null;
  const row = db.prepare('SELECT answers FROM exams WHERE id = ?').get(examId);
  if (row && row.answers) {
    try {
      const parsed = JSON.parse(row.answers);
      if (Array.isArray(parsed)) arr = parsed;
    } catch (_) { arr = null; }
  }
  examCache.set(examId, arr);
  return arr;
}
function findOriginalQuestion(examId, questionNumber) {
  const arr = getExamAnswers(examId);
  if (!arr || !arr.length) return null;
  const qn = Number(questionNumber);
  // A) number 필드 일치
  let q = arr.find(x => x && Number(x.number) === qn);
  // B) number 없는 스키마 → 배열 index(0-based)로 매핑 (question_number 1-based 가정)
  if (!q && Number.isInteger(qn) && qn >= 1 && qn <= arr.length) {
    const cand = arr[qn - 1];
    if (cand && cand.number == null) q = cand;
  }
  return q || null;
}
function originalText(q) {
  if (!q) return null;
  const t = q.text != null ? q.text : (q.question != null ? q.question : null);
  if (t == null) return null;
  const s = String(t).trim();
  return s === '' ? null : s;
}

function main() {
  const all = db.prepare('SELECT * FROM wrong_answers').all();
  const before = all.length;
  console.log(`[fix-wrong-answers] 대상 행수: ${before} (DB: ${DB_PATH})`);
  if (DRY) console.log('[fix-wrong-answers] ⚠ DRY-RUN: 실제 UPDATE 없음');

  // 1) 백업 (DRY 에서도 남긴다 — 안전)
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `wrong-answers-pre-fix-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(all, null, 2), 'utf8');
  console.log(`[fix-wrong-answers] 백업 저장: ${backupPath} (${all.length}행)`);

  // 정리 전 source 분포
  const srcBefore = db.prepare('SELECT source, COUNT(*) c FROM wrong_answers GROUP BY source').all();
  console.log('[fix-wrong-answers] 정리 전 source 분포:', JSON.stringify(srcBefore));

  let cntSource = 0, cntText = 0, cntAnswer = 0, cntUnresolvable = 0;
  const unresolvableIds = [];

  const updSource = db.prepare('UPDATE wrong_answers SET source = ? WHERE id = ?');
  const updText = db.prepare('UPDATE wrong_answers SET question_text = ? WHERE id = ?');
  const updAnswer = db.prepare('UPDATE wrong_answers SET student_answer = ? WHERE id = ?');

  const run = db.transaction(() => {
    for (const r of all) {
      // ── 2) source 교정 ──
      let newSource = null;
      if (r.exam_id != null) newSource = 'exam';
      else if (r.is_manual === 1) newSource = 'manual';
      else if (r.correct_answer != null && String(r.correct_answer).trim() !== '') newSource = 'manual'; // 폴백(원본 링크 없음, 단답 폴백으로 풀이)
      // 멱등: 이미 동일하면 skip. 'auto' 등 미구분 값일 때만 실제 교정.
      if (newSource && r.source !== newSource) {
        if (!DRY) updSource.run(newSource, r.id);
        cntSource++;
      } else if (!newSource) {
        // 판별 불가 — 보존 + 로그
        cntUnresolvable++;
        unresolvableIds.push(r.id);
      }

      // ── 3) question_text 플레이스홀더 백필 (exam 출처만 원본 복구 가능) ──
      if (r.exam_id != null && isPlaceholderText(r.question_text)) {
        const q = findOriginalQuestion(r.exam_id, r.question_number);
        const ot = originalText(q);
        if (ot && ot !== r.question_text) {
          if (!DRY) updText.run(ot, r.id);
          cntText++;
        }
      }

      // ── 4) student_answer 손상 정리 ──
      if (isCorruptAnswer(r.student_answer)) {
        if (!DRY) updAnswer.run(null, r.id);
        cntAnswer++;
      }
    }
  });
  run();

  // 정리 후 분포
  const srcAfter = db.prepare('SELECT source, COUNT(*) c FROM wrong_answers GROUP BY source').all();
  const remainPlaceholder = db.prepare("SELECT COUNT(*) c FROM wrong_answers WHERE question_text GLOB '문제 [0-9]*'").get().c;
  const remainCorrupt = db.prepare("SELECT COUNT(*) c FROM wrong_answers WHERE student_answer LIKE '%object Object%'").get().c;
  const after = db.prepare('SELECT COUNT(*) c FROM wrong_answers').get().c;

  console.log('───────────────────────────────────────────────');
  console.log(`[fix-wrong-answers] source 교정:            ${cntSource}건`);
  console.log(`[fix-wrong-answers] question_text 백필:     ${cntText}건`);
  console.log(`[fix-wrong-answers] student_answer 손상정리: ${cntAnswer}건`);
  console.log(`[fix-wrong-answers] source 판별불가(보존):    ${cntUnresolvable}건 ids=${JSON.stringify(unresolvableIds)}`);
  console.log('[fix-wrong-answers] 정리 후 source 분포:', JSON.stringify(srcAfter));
  console.log(`[fix-wrong-answers] 잔여 플레이스홀더 question_text: ${remainPlaceholder}건`);
  console.log(`[fix-wrong-answers] 잔여 손상 student_answer:        ${remainCorrupt}건`);
  console.log(`[fix-wrong-answers] 행수 before=${before} after=${after} (무손실 확인: ${before === after ? 'OK' : 'MISMATCH'})`);
  console.log('───────────────────────────────────────────────');
  console.log(DRY ? '[fix-wrong-answers] DRY-RUN 완료 (변경 없음)' : '[fix-wrong-answers] 정리 완료');

  db.close();
}

main();
