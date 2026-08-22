// test/fixtures/response-monitor.build.js
// ─────────────────────────────────────────────────────────────────────────────
// 응답 현황 모니터 픽스처 생성기.
//
// BE API(§8-1)가 아직 없으므로 FE 는 "픽스처 스냅샷"으로 전 화면을 시각 검증한다.
// 손으로 JSON 을 적으면 correct/wrong/accuracy_base 가 어긋나기 쉬우므로(이 프로젝트의
// 반복 결함 1위 = 라벨↔분모 불일치) **셀 상태 배열 하나만 손으로 적고 나머지 집계는
// 여기서 전부 계산**한다. 그 결과 픽스처는 정의상 아래 불변식을 만족한다:
//
//   INV-M3  accuracy_base === correct + wrong
//   INV-M4  students[].cells.length === questions.length   (희소 배열 금지)
//   INV-M5  summary.class_accuracy = 전체 correct / (전체 correct + 전체 wrong)
//
// 실행: node test/fixtures/response-monitor.build.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
const CIRCLED = ['①', '②', '③', '④', '⑤'];

/**
 * @param {object} spec
 *   spec.lesson    {id, class_id, title}
 *   spec.sync      {on, controller_id, controller_name, current_index, current_col}
 *   spec.items     [{index, content_id, title, content_type, question_count, gradable, cols}]
 *   spec.questions [{col, item_index, content_id, question_id, question_number,
 *                    question_type, points, question_text, options, answer}]   answer = 0-based index (choice) | 문자열
 *   spec.students  [{user_id, display_name, username, states:[...], texts:{col:답}, position, last_activity_at}]
 */
function build(spec) {
  const questions = spec.questions;
  const nQ = questions.length;

  // ── 학생 셀 ──
  const students = spec.students.map((s) => {
    if (s.states.length !== nQ) {
      throw new Error(`${s.display_name}: states ${s.states.length} !== questions ${nQ} (INV-M4 위반)`);
    }
    let correct = 0, wrong = 0, graded = 0;
    const cells = questions.map((q, i) => {
      const state = s.states[i];
      const cell = { col: q.col, state };
      if (state === 'correct') { correct++; graded++; }
      if (state === 'wrong') { wrong++; graded++; }
      if (state === 'pending') graded++;

      if (q.question_type === 'choice') {
        if (state === 'correct') cell.selected = q.answer;
        else if (state === 'wrong') cell.selected = (s.wrongPick && s.wrongPick[q.col] !== undefined)
          ? s.wrongPick[q.col] : (q.answer + 1) % q.options.length;
        if (cell.selected !== undefined) {
          cell.selected_label = CIRCLED[cell.selected] + ' ' + q.options[cell.selected];
        }
      } else if (state !== 'none') {
        const t = (s.texts && s.texts[q.col]) || null;
        if (t) { cell.selected = t; cell.selected_label = t; }
      }
      if (state !== 'none') {
        cell.time_taken_sec = 12 + ((s.user_id * 7 + q.col * 5) % 40);
        cell.attempted_at = s.attempted_at || spec.generated_at;
      } else {
        cell.time_taken_sec = null;
        cell.attempted_at = null;
      }
      return cell;
    });

    // 제출한 채점 대상 아이템 수 = 그 아이템의 셀 중 하나라도 state !== 'none'
    const gradableItems = spec.items.filter((it) => it.gradable && it.question_count > 0);
    const submittedItems = gradableItems.filter((it) =>
      questions.some((q, i) => q.item_index === it.index && s.states[i] !== 'none')).length;

    const base = correct + wrong;
    return {
      user_id: s.user_id,
      display_name: s.display_name,
      username: s.username,
      cells,
      correct_count: correct,
      wrong_count: wrong,
      graded_count: graded,
      score_percent: base > 0 ? Math.round((correct / base) * 100) : 0,
      submitted_items: submittedItems,
      total_gradable_items: gradableItems.length,
      position: s.position,
      last_activity_at: s.last_activity_at || null,
    };
  });

  // ── 문항 집계 ──
  const outQ = questions.map((q, i) => {
    let correct = 0, wrong = 0, unanswered = 0, pending = 0, notSubmitted = 0;
    const counts = (q.options || []).map(() => 0);
    students.forEach((st) => {
      const c = st.cells[i];
      if (c.state === 'correct') correct++;
      else if (c.state === 'wrong') wrong++;
      else if (c.state === 'unanswered') unanswered++;
      else if (c.state === 'pending') pending++;
      else if (c.state === 'none') notSubmitted++;
      if (q.question_type === 'choice' && typeof c.selected === 'number') counts[c.selected]++;
    });
    const base = correct + wrong;                       // 🔴 INV-M3
    const accuracy = base > 0 ? Math.round((correct / base) * 100) : 0;
    const lowFlag = base >= 3 && accuracy < 50;         // D8: 정답률<50 AND 응답자>=3
    return {
      col: q.col, item_index: q.item_index, content_id: q.content_id,
      question_id: q.question_id, question_number: q.question_number,
      question_type: q.question_type, points: q.points,
      question_text: q.question_text,
      options: q.options || [],
      answer_value: q.question_type === 'choice' ? String(q.answer) : String(q.answer),
      answer_label: q.question_type === 'choice'
        ? (CIRCLED[q.answer] + ' ' + q.options[q.answer]) : String(q.answer),
      distribution: (q.options || []).map((label, vi) => ({
        value: vi, label: CIRCLED[vi] + ' ' + label, count: counts[vi], is_answer: vi === q.answer,
      })),
      correct, wrong, unanswered, pending, not_submitted: notSubmitted,
      accuracy, accuracy_base: base, low_flag: lowFlag,
      viewing_count: q.viewing_count || 0,
    };
  });

  // ── 요약 ──
  const totalCorrect = outQ.reduce((a, q) => a + q.correct, 0);
  const totalWrong = outQ.reduce((a, q) => a + q.wrong, 0);
  const clsBase = totalCorrect + totalWrong;
  const summary = {
    student_total: students.length,
    submitted_any: students.filter((s) => s.submitted_items > 0).length,
    submitted_all: students.filter((s) => s.total_gradable_items > 0 && s.submitted_items === s.total_gradable_items).length,
    online: students.filter((s) => s.position && s.position.online).length,
    class_accuracy: clsBase > 0 ? Math.round((totalCorrect / clsBase) * 100) : 0,   // 🔴 INV-M5
    class_accuracy_base: clsBase,
    low_cols: outQ.filter((q) => q.low_flag).map((q) => q.col),
    no_record_items: spec.no_record_items || [],
  };

  return {
    success: true,
    lesson: spec.lesson,
    sync: spec.sync,
    items: spec.items,
    questions: outQ,
    students,
    summary,
    generated_at: spec.generated_at,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 픽스처 정의
 * ═══════════════════════════════════════════════════════════════════════════ */
const AT = '2026-08-21T00:43:22Z';

function choiceQ(col, itemIndex, contentId, n, text, options, answer) {
  return {
    col, item_index: itemIndex, content_id: contentId, question_id: 4000 + col,
    question_number: n, question_type: 'choice', points: 1,
    question_text: text, options, answer,
  };
}
function essayQ(col, itemIndex, contentId, n, text, answer) {
  return {
    col, item_index: itemIndex, content_id: contentId, question_id: 4000 + col,
    question_number: n, question_type: 'essay', points: 2,
    question_text: text, options: [], answer: answer || '(서술형)',
  };
}

// ── ① 정상: 학생 5 · 문항 8 · 동기화 ON · 저조 문항 2개 · 셀 5종 전부 + here 링 ──
const normal = build({
  lesson: { id: 79, class_id: 2, title: '3학년 2학기 · 각도와 직각 알아보기' },
  sync: { on: true, controller_id: 2, controller_name: '김선생', current_index: 0, current_col: 3 },
  items: [
    { index: 0, content_id: 3451, title: '직각 찾기 연습 문제', content_type: 'quiz', question_count: 4, gradable: true, cols: [1, 2, 3, 4] },
    { index: 1, content_id: 3130, title: '각도 알아보기 영상', content_type: 'video', question_count: 0, gradable: false, cols: [] },
    { index: 2, content_id: 3452, title: '받아쓰기 세트', content_type: 'quiz', question_count: 4, gradable: true, cols: [5, 6, 7, 8] },
  ],
  questions: [
    choiceQ(1, 0, 3451, 1, '직사각형에서 직각은 모두 몇 개인가요?', ['3개', '1개', '4개', '2개'], 2),
    choiceQ(2, 0, 3451, 2, '시계의 긴바늘과 짧은바늘이 직각을 이루는 시각은?', ['3시', '5시', '7시', '11시'], 0),
    choiceQ(3, 0, 3451, 3, '다음 중 예각은 어느 것인가요?', ['95도', '120도', '45도', '180도'], 2),
    choiceQ(4, 0, 3451, 4, '직각보다 큰 각을 무엇이라고 하나요?', ['예각', '둔각', '평각', '직각'], 1),
    choiceQ(5, 2, 3452, 1, '"각도" 의 바른 표기는?', ['각또', '각도', '깍도', '각돠'], 1),
    choiceQ(6, 2, 3452, 2, '"직각" 의 바른 표기는?', ['직깍', '직각', '진각', '짓각'], 1),
    choiceQ(7, 2, 3452, 3, '"둔각" 의 바른 표기는?', ['둔각', '둥각', '둔깍', '둔갓'], 0),
    essayQ(8, 2, 3452, 4, '우리 교실에서 직각을 찾아 두 가지 써 봅시다.'),
  ],
  students: [
    { user_id: 3, display_name: '이학생', username: 'student1',
      states: ['wrong', 'correct', 'wrong', 'correct', 'correct', 'correct', 'wrong', 'unanswered'],
      position: { online: true, item_index: 0, item_title: '직각 찾기 연습 문제', kind: 'quiz', col: 3, following: true },
      last_activity_at: AT },
    { user_id: 4, display_name: '박학생', username: 'student2',
      states: ['correct', 'correct', 'wrong', 'wrong', 'correct', 'wrong', 'wrong', 'pending'],
      texts: { 8: '창문 모서리와 책상 모서리가 직각입니다.' },
      position: { online: true, item_index: 0, item_title: '직각 찾기 연습 문제', kind: 'quiz', col: 3, following: true },
      last_activity_at: AT },
    { user_id: 5, display_name: '최학생', username: 'student3',
      states: ['wrong', 'wrong', 'wrong', 'correct', 'none', 'none', 'none', 'none'],
      position: { online: true, item_index: 1, item_title: '각도 알아보기 영상', kind: 'media', col: null, following: false },
      last_activity_at: AT },
    { user_id: 6, display_name: '윤서준', username: 'student4',
      states: ['correct', 'correct', 'correct', 'unanswered', 'correct', 'correct', 'wrong', 'pending'],
      texts: { 8: '칠판 네 귀퉁이가 직각이에요.' },
      position: { online: true, item_index: 2, item_title: '받아쓰기 세트', kind: 'quiz', col: 7, following: false },
      last_activity_at: AT },
    { user_id: 7, display_name: '임지호', username: 'student5',
      states: ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none'],
      position: { online: false, item_index: null, item_title: null, kind: null, col: null, following: false },
      last_activity_at: null },
  ],
  generated_at: AT,
});

// ── ② 빈 상태: 학생은 있는데 아무도 안 풂 ──
const empty = build({
  lesson: { id: 80, class_id: 2, title: '4학년 1학기 · 분수의 덧셈' },
  sync: { on: false, controller_id: null, controller_name: null, current_index: null, current_col: null },
  items: [
    { index: 0, content_id: 3460, title: '분수 덧셈 연습', content_type: 'quiz', question_count: 4, gradable: true, cols: [1, 2, 3, 4] },
  ],
  questions: [
    choiceQ(1, 0, 3460, 1, '1/4 + 2/4 는 얼마인가요?', ['1/4', '2/4', '3/4', '4/4'], 2),
    choiceQ(2, 0, 3460, 2, '2/5 + 1/5 는 얼마인가요?', ['1/5', '2/5', '3/5', '4/5'], 2),
    choiceQ(3, 0, 3460, 3, '3/8 + 4/8 는 얼마인가요?', ['5/8', '6/8', '7/8', '8/8'], 2),
    choiceQ(4, 0, 3460, 4, '1/3 + 1/3 는 얼마인가요?', ['1/3', '2/3', '3/3', '4/3'], 1),
  ],
  students: [3, 4, 5, 6, 7].map((id, i) => ({
    user_id: id, display_name: ['이학생', '박학생', '최학생', '윤서준', '임지호'][i],
    username: 'student' + (i + 1),
    states: ['none', 'none', 'none', 'none'],
    position: { online: i < 3, item_index: i < 3 ? 0 : null, item_title: '분수 덧셈 연습',
                kind: i < 3 ? 'quiz' : null, col: i < 3 ? 1 : null, following: true },
    last_activity_at: null,
  })),
  generated_at: AT,
});

// ── ③ 동기화 OFF: 학생마다 서로 다른 위치 (위치 줄이 제각각) ──
const syncOff = build({
  lesson: { id: 81, class_id: 2, title: '5학년 2학기 · 소수의 곱셈' },
  sync: { on: false, controller_id: null, controller_name: null, current_index: null, current_col: null },
  items: [
    { index: 0, content_id: 3470, title: '소수 곱셈 기초', content_type: 'quiz', question_count: 3, gradable: true, cols: [1, 2, 3] },
    { index: 1, content_id: 3471, title: '소수 곱셈 설명 영상', content_type: 'video', question_count: 0, gradable: false, cols: [] },
    { index: 2, content_id: 3472, title: '소수 곱셈 도전', content_type: 'quiz', question_count: 3, gradable: true, cols: [4, 5, 6] },
  ],
  questions: [
    choiceQ(1, 0, 3470, 1, '0.3 × 2 는 얼마인가요?', ['0.5', '0.6', '0.9', '6'], 1, 2),
    choiceQ(2, 0, 3470, 2, '1.2 × 3 은 얼마인가요?', ['3.2', '3.6', '4.2', '36'], 1),
    choiceQ(3, 0, 3470, 3, '0.25 × 4 는 얼마인가요?', ['0.1', '1', '10', '100'], 1),
    choiceQ(4, 2, 3472, 1, '2.5 × 1.2 는 얼마인가요?', ['2.7', '3', '3.7', '30'], 1),
    choiceQ(5, 2, 3472, 2, '0.4 × 0.5 는 얼마인가요?', ['0.02', '0.2', '2', '20'], 1),
    choiceQ(6, 2, 3472, 3, '1.5 × 1.5 는 얼마인가요?', ['2.25', '2.5', '3', '22.5'], 0),
  ],
  students: [
    { user_id: 3, display_name: '이학생', username: 'student1',
      states: ['correct', 'correct', 'wrong', 'none', 'none', 'none'],
      position: { online: true, item_index: 0, item_title: '소수 곱셈 기초', kind: 'quiz', col: 3, following: true },
      last_activity_at: AT },
    { user_id: 4, display_name: '박학생', username: 'student2',
      states: ['correct', 'wrong', 'wrong', 'wrong', 'unanswered', 'none'],
      position: { online: true, item_index: 1, item_title: '소수 곱셈 설명 영상', kind: 'media', col: null, following: true },
      last_activity_at: AT },
    { user_id: 5, display_name: '최학생', username: 'student3',
      states: ['wrong', 'correct', 'correct', 'correct', 'correct', 'wrong'],
      position: { online: true, item_index: 3, item_title: null, kind: 'done', col: null, following: true },
      last_activity_at: AT },
    { user_id: 6, display_name: '윤서준', username: 'student4',
      states: ['wrong', 'wrong', 'correct', 'none', 'none', 'none'],
      position: { online: true, item_index: 2, item_title: '소수 곱셈 도전', kind: 'quiz', col: 4, following: true },
      last_activity_at: AT },
    { user_id: 7, display_name: '임지호', username: 'student5',
      states: ['none', 'none', 'none', 'none', 'none', 'none'],
      position: { online: false, item_index: null, item_title: null, kind: null, col: null, following: false },
      last_activity_at: null },
  ],
  generated_at: AT,
});

// ── ④ 문항 25개: §9-4 ② 아이템 필터 자동 적용 + ⑤ 열 점프 ──
function manyQuestions(count, perItem, lessonId, title) {
  const items = [];
  const questions = [];
  let col = 0;
  const nItems = Math.ceil(count / perItem);
  for (let i = 0; i < nItems; i++) {
    const cols = [];
    const n = Math.min(perItem, count - i * perItem);
    for (let k = 0; k < n; k++) {
      col++;
      cols.push(col);
      questions.push(choiceQ(col, i, 3500 + i, k + 1,
        col + '번 문항 — 다음 중 알맞은 것을 고르세요.',
        ['첫 번째', '두 번째', '세 번째', '네 번째'], col % 4));
    }
    items.push({ index: i, content_id: 3500 + i, title: (i + 1) + '차시 연습 문제',
                 content_type: 'quiz', question_count: n, gradable: true, cols });
  }
  const names = ['이학생', '박학생', '최학생', '윤서준', '임지호', '한지우'];
  const students = names.map((nm, si) => ({
    user_id: 3 + si, display_name: nm, username: 'student' + (si + 1),
    states: questions.map((q, qi) => {
      if (si === names.length - 1) return 'none';                     // 마지막 학생은 미제출
      const seed = (si * 7 + qi * 3) % 10;
      if (seed === 0) return 'unanswered';
      if (seed === 1 && qi % 5 === 1) return 'pending';
      return seed < 5 ? 'wrong' : 'correct';
    }),
    position: { online: si < 4, item_index: si < 4 ? si % items.length : null,
                item_title: items[si % items.length].title, kind: si < 4 ? 'quiz' : null,
                col: si < 4 ? (si * 3 + 1) : null, following: true },
    last_activity_at: si < 4 ? AT : null,
  }));
  return build({
    lesson: { id: lessonId, class_id: 2, title },
    sync: { on: false, controller_id: null, controller_name: null, current_index: null, current_col: null },
    items, questions, students, generated_at: AT,
  });
}
const many = manyQuestions(25, 5, 82, '6학년 1학기 · 비와 비율 종합 문제');

// ── ⑤ 서술형 채점 대기(△) 다수 ──
const pending = build({
  lesson: { id: 83, class_id: 2, title: '4학년 2학기 · 독서 감상문 쓰기' },
  sync: { on: true, controller_id: 9, controller_name: '박선생', current_index: 0, current_col: 2 },
  items: [
    { index: 0, content_id: 3480, title: '독서 감상문 문항', content_type: 'quiz', question_count: 4, gradable: true, cols: [1, 2, 3, 4] },
  ],
  questions: [
    choiceQ(1, 0, 3480, 1, '이 글의 갈래는 무엇인가요?', ['동시', '이야기', '설명문', '주장하는 글'], 1),
    essayQ(2, 0, 3480, 2, '주인공의 마음이 어떻게 바뀌었는지 써 봅시다.'),
    essayQ(3, 0, 3480, 3, '가장 인상 깊은 장면과 그 까닭을 써 봅시다.'),
    choiceQ(4, 0, 3480, 4, '이 글에서 배울 점으로 알맞은 것은?', ['용기', '거짓말', '욕심', '다툼'], 0),
  ],
  students: [
    { user_id: 3, display_name: '이학생', username: 'student1',
      states: ['correct', 'pending', 'pending', 'correct'],
      texts: { 2: '처음에는 무서웠지만 나중에는 용기를 냈어요.', 3: '친구를 도와주는 장면이 좋았어요.' },
      position: { online: true, item_index: 0, item_title: '독서 감상문 문항', kind: 'quiz', col: 2, following: true },
      last_activity_at: AT },
    { user_id: 4, display_name: '박학생', username: 'student2',
      states: ['wrong', 'pending', 'unanswered', 'correct'],
      texts: { 2: '슬펐다가 기뻐졌어요.' },
      position: { online: true, item_index: 0, item_title: '독서 감상문 문항', kind: 'quiz', col: 3, following: false },
      last_activity_at: AT },
    { user_id: 5, display_name: '최학생', username: 'student3',
      states: ['wrong', 'pending', 'pending', 'wrong'],
      texts: { 2: '몰라요.', 3: '재미있었어요.' },
      position: { online: true, item_index: 0, item_title: '독서 감상문 문항', kind: 'quiz', col: 2, following: true },
      last_activity_at: AT },
    { user_id: 6, display_name: '윤서준', username: 'student4',
      states: ['wrong', 'none', 'none', 'none'],
      position: { online: false, item_index: null, item_title: null, kind: null, col: null, following: false },
      last_activity_at: AT },
    { user_id: 7, display_name: '임지호', username: 'student5',
      states: ['none', 'none', 'none', 'none'],
      position: { online: false, item_index: null, item_title: null, kind: null, col: null, following: false },
      last_activity_at: null },
  ],
  generated_at: AT,
});

// ── ⑥ 문항 45개: §9-4 ④ 압축 모드 자동 전환 ──
const compact = manyQuestions(45, 45, 84, '중1 수학 · 정수와 유리수 단원평가');

const FILES = {
  'response-monitor.normal.json': normal,
  'response-monitor.empty.json': empty,
  'response-monitor.sync-off.json': syncOff,
  'response-monitor.many.json': many,
  'response-monitor.pending.json': pending,
  'response-monitor.compact.json': compact,
};

for (const [name, data] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('written:', name,
    `students=${data.students.length}`,
    `questions=${data.questions.length}`,
    `low=${JSON.stringify(data.summary.low_cols)}`,
    `class=${data.summary.class_accuracy}%(${data.summary.class_accuracy_base})`);
}
