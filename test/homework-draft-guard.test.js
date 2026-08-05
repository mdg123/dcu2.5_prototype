// test/homework-draft-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// P0-1 회귀 박제 — "채점까지 끝난 제출물이 자동 임시저장에 삼켜져 사라진다"
//
// 사고 재현(2026-08-05, 팀1):
//   teacher1 과제 등록 → student1 제출 → teacher1 채점(90) →
//   student1 이 과제 화면을 **열어두기만** 해도(입력 0) 30초 뒤 자동 saveDraft 발화 →
//   db/homework.js saveDraft 가 기존 행에 is_draft=1 을 무조건 덮어씀 →
//   교사 측 전 쿼리가 COALESCE(is_draft,0)=0 으로 거르므로 제출·채점이 **통째로 소실**.
//   (행은 살아 있지만 score/status='graded' 가 화면·통계 어디에도 안 나옴)
//
// 두 겹으로 막는다:
//   ① FE  public/class/homework-view.html — Quill text-change 를 source==='user' 로 제한
//   ② BE  db/homework.js  saveDraft      — 이미 제출된 행의 is_draft 를 1로 되돌리지 않음
//   이 파일은 ②(서버 방어)를 박제한다. ① 만으로는 다른 경로에서 재발하기 때문.
//
// 덤: W1-T1-11(P2) — 자동 임시저장이 행을 먼저 만들어서 **정식 첫 제출**이
//   UNIQUE 충돌 경로를 타고 status='resubmitted' 로 기록되던 것도 함께 박제.
//
// DB 격리: 실 DB → 임시 복사본 (db 모듈 require "전에" DB_PATH 주입). 실 DB 무오염.
// 계정: teacher1=id2, student1=id3, student2=id4, class 1(teacher1 소유, S1·S2 member)
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();
const hw = require('../db/homework');
const db = openTestDb();

const TEACHER = 2;
const S1 = 3;
const S2 = 4;
const CLASS = 1;

// 마감이 한참 남은(=임시저장이 살아 있는) 과제를 매번 새로 만든다.
function makeHomework(title) {
  return hw.createHomework(CLASS, TEACHER, {
    title,
    description: 'P0-1 회귀 박제용',
    due_date: '2099-12-31 23:59',
    max_score: 100,
    status: 'published'
  });
}

function rawRow(homeworkId, studentId) {
  return db.prepare(
    'SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ?'
  ).get(homeworkId, studentId);
}

function listRow(homeworkId) {
  const { homework } = hw.getHomeworkByClass(CLASS, { limit: 200 });
  return homework.find(h => h.id === homeworkId);
}

// ──────────────────────────────────────────────────────────────────────────
// INV-HD1 (핵심): 채점 완료 후 자동 임시저장이 발화해도 제출물은 사라지지 않는다.
//   ─ 팀1 제안 시나리오 그대로: 제출 → 채점 → saveDraft() → 여전히 보여야 한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-HD1: 채점된 제출물은 자동 임시저장(saveDraft)이 발화해도 사라지지 않는다', () => {
  const h = makeHomework('P0-1 채점후 자동임시저장 회귀');

  hw.submitHomework(h.id, S1, { content: '<p>제 답안입니다</p>', attachments: [] });
  const sub = hw.getSubmission(h.id, S1);
  hw.gradeSubmission(sub.id, 90, '잘했어요');

  // 채점 직후 스냅샷 — 여기까지는 원래도 정상이었다
  assert.equal(hw.getSubmissions(h.id).length, 1, '채점 직후 교사 화면에 제출 1건');

  // ★ 사고 트리거: 학생이 아무것도 입력하지 않았는데 자동 임시저장이 도는 상황
  hw.saveDraft(h.id, S1, { content: '<p>제 답안입니다</p>', attachments: [] });

  // ① 교사 화면(제출물 목록) — 사라지면 안 된다
  const subs = hw.getSubmissions(h.id);
  assert.equal(subs.length, 1, '자동 임시저장 후에도 교사 제출물 목록에 남아야 한다');
  assert.equal(subs[0].status, 'graded', '채점 상태가 유지되어야 한다');
  assert.equal(subs[0].score, 90, '점수가 유지되어야 한다');
  assert.equal(subs[0].is_draft, 0, '제출된 행이 임시저장(is_draft=1)으로 강등되면 안 된다');

  // ② 목록 API 집계 — submitted_count / graded_count
  const row = listRow(h.id);
  assert.ok(row, '과제 목록에 과제가 있어야 한다');
  assert.equal(row.submitted_count, 1, 'submitted_count 가 1 이어야 한다');
  assert.equal(row.graded_count, 1, 'graded_count 가 1 이어야 한다');
  assert.equal(row.submission_count, 1, 'submission_count 가 1 이어야 한다');

  // ③ 제출률 통계 헤더 ("제출 0/8 · 0%" 로 무너졌던 지점)
  const stats = hw.getSubmissionStats(h.id, CLASS);
  assert.equal(stats.submitted_count, 1, '제출률 통계의 제출 수가 1 이어야 한다');

  // ④ 학생 본인 화면 — my_submission 계열이 살아 있어야 "채점 완료 90/100" 이 뜬다
  const mine = hw.getHomeworkByClass(CLASS, { limit: 200, userId: S1 })
    .homework.find(x => x.id === h.id);
  assert.ok(mine.my_submission, '학생 화면에서 내 제출이 조회되어야 한다');
  assert.equal(mine.my_submission_status, 'graded', '학생 화면 상태가 채점완료여야 한다');
  assert.equal(mine.my_score, 90, '학생 화면 점수가 유지되어야 한다');

  // ⑤ 원본 행 — 채점 메타 무손실
  const raw = rawRow(h.id, S1);
  assert.equal(raw.is_draft, 0);
  assert.ok(raw.submitted_at, 'submitted_at 이 유지되어야 한다');
  assert.equal(raw.status, 'graded');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-HD2: 채점 전 '제출됨' 상태에서도 동일 — 제출은 임시저장으로 강등되지 않는다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-HD2: 미채점 제출물도 자동 임시저장에 강등되지 않는다', () => {
  const h = makeHomework('P0-1 미채점 제출 강등 방지');
  hw.submitHomework(h.id, S2, { content: '<p>제출본</p>', attachments: [] });

  hw.saveDraft(h.id, S2, { content: '<p>제출본 + 오탈자 수정중</p>', attachments: [] });

  const raw = rawRow(h.id, S2);
  assert.equal(raw.is_draft, 0, '제출 행의 is_draft 는 0 을 유지해야 한다');
  assert.equal(raw.status, 'submitted', '제출 상태가 유지되어야 한다');
  assert.equal(raw.content, '<p>제출본</p>', '정식 제출 본문은 임시저장에 덮이면 안 된다');
  assert.equal(hw.getSubmissions(h.id).length, 1, '교사 목록에 남아야 한다');
  // 이어쓰기 목적의 draft 컬럼 자체는 계속 보관된다(기능 유지)
  assert.equal(raw.draft_content, '<p>제출본 + 오탈자 수정중</p>', '임시저장 본문은 draft 컬럼에 보관');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-HD3: 미제출 상태의 임시저장은 지금까지처럼 정상 동작해야 한다 (과잉방어 금지)
// ──────────────────────────────────────────────────────────────────────────
test('INV-HD3: 미제출 상태의 임시저장은 정상 동작(is_draft=1, 교사에게 비노출)', () => {
  const h = makeHomework('P0-1 순수 임시저장 정상동작');

  // 신규 행
  hw.saveDraft(h.id, S1, { content: '<p>작성중1</p>', attachments: [] });
  let raw = rawRow(h.id, S1);
  assert.equal(raw.is_draft, 1, '미제출 임시저장은 is_draft=1');
  assert.equal(raw.submitted_at, null, '임시저장은 submitted_at 이 없어야 한다');

  // 기존 임시저장 행 갱신
  hw.saveDraft(h.id, S1, { content: '<p>작성중2</p>', attachments: [] });
  raw = rawRow(h.id, S1);
  assert.equal(raw.is_draft, 1, '임시저장 갱신 후에도 is_draft=1');
  assert.equal(raw.draft_content, '<p>작성중2</p>');

  assert.equal(hw.getSubmissions(h.id).length, 0, '임시저장은 교사에게 보이지 않는다');
  assert.equal(listRow(h.id).submitted_count, 0, '임시저장은 제출 수에 포함되지 않는다');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-HD4 (W1-T1-11, P2): 임시저장을 거친 **첫 정식 제출**은 '제출'이지 '재제출'이 아니다.
// ──────────────────────────────────────────────────────────────────────────
test("INV-HD4: 임시저장 후 첫 정식 제출의 status 는 'submitted' (재제출 아님)", () => {
  const h = makeHomework('P0-1 첫제출이 재제출로 기록되던 버그');

  hw.saveDraft(h.id, S1, { content: '<p>작성중</p>', attachments: [] });
  hw.submitHomework(h.id, S1, { content: '<p>최종 답안</p>', attachments: [] });

  const raw = rawRow(h.id, S1);
  assert.equal(raw.status, 'submitted', '첫 제출은 submitted 여야 한다');
  assert.equal(raw.is_draft, 0);
  assert.ok(raw.submitted_at, 'submitted_at 이 채워져야 한다');
  assert.equal(raw.draft_content, null, '정식 제출 시 draft 컬럼은 정리된다');
  assert.equal(listRow(h.id).submitted_count, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-HD5: 진짜 재제출은 계속 'resubmitted' 로 남아야 한다 (HD4 가 과잉교정 아님 증명)
// ──────────────────────────────────────────────────────────────────────────
test("INV-HD5: 채점 후 다시 제출하면 status 는 'resubmitted'", () => {
  const h = makeHomework('P0-1 진짜 재제출 판별');

  hw.submitHomework(h.id, S1, { content: '<p>1차</p>', attachments: [] });
  const sub = hw.getSubmission(h.id, S1);
  hw.gradeSubmission(sub.id, 70, '보완 필요');

  hw.submitHomework(h.id, S1, { content: '<p>2차</p>', attachments: [] });
  const raw = rawRow(h.id, S1);
  assert.equal(raw.status, 'resubmitted', '채점 후 재제출은 resubmitted');
  assert.equal(raw.is_draft, 0);

  // 재제출을 한 번 더 해도 'submitted' 로 되돌아가면 안 된다
  hw.submitHomework(h.id, S1, { content: '<p>3차</p>', attachments: [] });
  assert.equal(rawRow(h.id, S1).status, 'resubmitted', '2회차 재제출도 resubmitted 유지');
});
