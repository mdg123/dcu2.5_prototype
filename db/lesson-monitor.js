// db/lesson-monitor.js
// ─────────────────────────────────────────────────────────────────────────────
// 수업꾸러미 "응답 현황" 스냅샷 산출 (기획서 보고서/기획_수업꾸러미_응답모니터링_v1.md §8-1/§8-2)
//
// ■ 이 파일이 지키는 것 (불변식 — test/lesson-response-monitor.test.js)
//   INV-M1  students 는 **classDb.getClassStudents(classId) 한 곳**에서만 나온다(분모 SSOT).
//           손 SQL 로 명단을 다시 적지 않는다 — 화면마다 분모가 갈리는 게 이 프로젝트 반복 결함 1위.
//   INV-M2  모든 accuracy 는 0~100, accuracy_base >= 0
//   INV-M3  accuracy_base === correct + wrong   (라벨↔집계 일치)
//   INV-M4  모든 students[].cells.length === questions.length  (희소 배열 금지 — FE 가 인덱스를 계산하지 않게)
//   INV-M5  summary.class_accuracy = 전체 correct / (전체 correct + 전체 wrong)
//           ← 학생별 %의 평균이 **아니다**(제출자 수가 다르면 왜곡된다)
//   INV-M7  lesson_id IS NULL(수업 밖) 기록은 includeOutside=false 응답에 섞이지 않는다
//
// ■ 정답 판정은 lib/grade-answer.js 한 벌 (BE-2). 여기에 판정식을 다시 적지 않는다.
// ■ 정답률·점수·반 평균은 **전부 서버가 계산**해 내려보낸다. FE 에 산식을 두지 않는다.
//
// ⚠ 이 스냅샷에는 학생 실명 + 정오답이 들어 있다. 교사 전용이다.
//    REST 는 routes/lesson.js requireLessonMonitorViewer, 소켓은 lesson:${lid}:monitor 룸이
//    유일한 출구다. `lesson:${lid}` 룸(학생 포함)으로는 절대 내보내지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const db = require('./index');
const classDb = require('./class');
const lessonDb = require('./lesson');
const { classify, normalizeQType, buildAnswerLookup, parseAnswers } = require('../lib/grade-answer');

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
function circled(i) { return (i >= 0 && i < CIRCLED.length) ? CIRCLED[i] : String(i + 1); }

/** 저조 문항 기준 (기획서 D8) — 프로젝트 기존 정책(시도 3건 미만 = 평가 부족)과 정합. */
const LOW_ACCURACY = 50;
const LOW_MIN_BASE = 3;

/** 열(문항)을 만드는 콘텐츠 유형. 그 외(영상·문서·링크)는 열을 만들지 않는다(기획서 D3). */
function isGradableType(t) {
  return t === 'quiz' || t === 'exam';
}

function parseOptions(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  return [];
}

/** 객관식 보기 라벨 `③ 4개`. 인덱스가 보기 범위 밖이면 숫자만. */
function optionLabel(options, idx) {
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0) return null;
  const text = options[i];
  return text === undefined ? circled(i) : (circled(i) + ' ' + String(text));
}

/**
 * 응답 현황 스냅샷을 만든다.
 * @param {object} o
 * @param {number} o.classId
 * @param {number} o.lessonId
 * @param {boolean} [o.includeOutside]  true 면 lesson_id IS NULL(수업 밖) 기록도 포함
 * @param {object} [o.runtime]  소켓 런타임 { on, controllerId, controllerName, currentIndex,
 *                                            members:Map<uid,*>, positions:Map<uid,{index,kind,at}> }
 * @param {number} [o.onlyUserId]  이 학생 1명분만 재계산(소켓 lesson:monitor:row 용). 집계는 전원 기준.
 * @returns {object|null}  lesson 이 없거나 class 불일치면 null
 */
function buildResponseMonitor({ classId, lessonId, includeOutside = false, runtime = null } = {}) {
  const cid = parseInt(classId);
  const lid = parseInt(lessonId);
  const lesson = lessonDb.getLessonById(lid);
  if (!lesson || Number(lesson.class_id) !== cid) return null;

  // ── ① 명단 — 🔴 SSOT. 이 한 줄 외의 명단 SQL 금지 (INV-M1) ──────────────────
  const students = classDb.getClassStudents(cid);

  // ── ② 열 — lesson_contents 순서대로, 문항 콘텐츠만 열이 된다 ────────────────
  const items = [];
  const questions = [];
  const noRecordItems = [];
  const rawItems = lessonDb.getLessonContents(lid);
  const qStmt = db.prepare(
    'SELECT id, question_number, question_type, options, answer, question_text, points ' +
    'FROM content_questions WHERE content_id = ? ORDER BY question_number, id'
  );
  let col = 0;
  rawItems.forEach((it, i) => {
    const item = {
      index: i,
      content_id: it.id,
      title: it.title || '콘텐츠',
      content_type: it.content_type || null,
      question_count: 0,
      gradable: false,
      cols: [],
    };
    items.push(item);
    if (!isGradableType(it.content_type)) return;
    const qs = qStmt.all(it.id);
    if (qs.length === 0) {
      // §1-2-e 레거시 경로 — content_type 은 quiz 인데 문항 행이 없다.
      //   이 아이템은 content_attempts 를 전혀 남기지 않으므로 열을 만들지 않고 사유를 밝힌다.
      noRecordItems.push(i);
      return;
    }
    item.gradable = true;
    item.question_count = qs.length;
    qs.forEach((q, qi) => {
      col += 1;
      item.cols.push(col);
      const opts = parseOptions(q.options);
      const qType = normalizeQType(q.question_type);
      questions.push({
        col,
        item_index: i,
        content_id: it.id,
        content_index_in_item: qi,          // 순서 매칭(하위호환)용 내부 인덱스
        question_id: q.id,
        question_number: q.question_number,
        question_type: qType,
        points: Number(q.points) || 1,
        question_text: q.question_text || '',
        options: opts,
        answer_value: q.answer === null || q.answer === undefined ? null : String(q.answer),
        // 🔴 서술형은 정답 라벨이 없다(자동채점 대상이 아님) → null (FE 계약)
        answer_label: qType === 'essay' ? null
          : (qType === 'choice' ? optionLabel(opts, q.answer) : (q.answer == null ? null : String(q.answer))),
        _raw: q,                            // 판정용 원본(응답 직전에 제거)
        distribution: qType === 'choice'
          ? opts.map((t, oi) => ({ value: oi, label: circled(oi) + ' ' + String(t), count: 0,
                                   is_answer: String(oi) === String(q.answer) }))
          : [],
        correct: 0, wrong: 0, unanswered: 0, pending: 0, not_submitted: 0,
        accuracy: 0, accuracy_base: 0, low_flag: false, viewing_count: 0,
      });
    });
  });

  // ── ③ 응답 — 학생×콘텐츠별 "가장 최근 1건" ──────────────────────────────────
  //   🔴 INV-M7: includeOutside=false 면 lesson_id = ? 로만 건진다.
  //      기존 행(마이그레이션 이전)은 전부 lesson_id IS NULL 이라 기본 응답에 섞이지 않는다.
  const gradableContentIds = [...new Set(questions.map(q => q.content_id))];
  const studentIds = students.map(s => s.user_id);
  const latest = new Map();     // `${userId}:${contentId}` -> attempt row
  if (gradableContentIds.length > 0 && studentIds.length > 0) {
    const cPh = gradableContentIds.map(() => '?').join(',');
    const uPh = studentIds.map(() => '?').join(',');
    const scope = includeOutside ? '(lesson_id = ? OR lesson_id IS NULL)' : 'lesson_id = ?';
    const rows = db.prepare(`
      SELECT id, content_id, user_id, answers, answers_detail, lesson_id, attempted_at
        FROM content_attempts
       WHERE content_id IN (${cPh}) AND user_id IN (${uPh}) AND ${scope}
       ORDER BY attempted_at ASC, id ASC
    `).all(...gradableContentIds, ...studentIds, lid);
    // ORDER BY 오름차순 → 나중 행이 앞 행을 덮어써 "가장 최근 1건"이 남는다.
    for (const r of rows) latest.set(`${r.user_id}:${r.content_id}`, r);
  }

  // ── ④ 위치 — 소켓 런타임 (없으면 전원 미접속) ───────────────────────────────
  const rt = runtime || {};
  const members = rt.members instanceof Map ? rt.members : new Map();
  const positions = rt.positions instanceof Map ? rt.positions : new Map();
  const syncOn = !!rt.on;
  const syncIndex = Number.isInteger(rt.currentIndex) ? rt.currentIndex : 0;

  // 아이템 index → 그 아이템의 첫 문항 col (없으면 null)
  const firstColOf = new Map();
  items.forEach(it => { if (it.cols.length > 0) firstColOf.set(it.index, it.cols[0]); });

  // 학생별 이수 완료 아이템 수 (전체 완료 판정용 — kind:'done')
  const completedCount = new Map();
  if (studentIds.length > 0 && items.length > 0) {
    const uPh = studentIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT user_id, COUNT(*) AS c FROM content_progress
       WHERE lesson_id = ? AND user_id IN (${uPh}) AND completed = 1
       GROUP BY user_id
    `).all(lid, ...studentIds);
    for (const r of rows) completedCount.set(r.user_id, r.c);
  }

  // ── ⑤ 학생 행 + 셀 ─────────────────────────────────────────────────────────
  const totalGradableItems = items.filter(it => it.gradable).length;
  let classCorrect = 0, classWrong = 0;

  const outStudents = students.map((s) => {
    const uid = s.user_id;
    // 콘텐츠별 응답 매칭기 (BE-3: answers_detail 이 있으면 questionId 매칭, 없으면 순서 매칭)
    const lookupByContent = new Map();
    const submittedContents = new Set();
    let lastActivity = null;
    for (const contentId of gradableContentIds) {
      const att = latest.get(`${uid}:${contentId}`);
      if (!att) continue;
      submittedContents.add(contentId);
      if (att.attempted_at && (!lastActivity || att.attempted_at > lastActivity)) lastActivity = att.attempted_at;
      const detail = parseAnswers(att.answers_detail);
      const ordered = parseAnswers(att.answers);
      lookupByContent.set(contentId, buildAnswerLookup(detail || ordered || []));
    }

    let correct = 0, wrong = 0, pending = 0, unanswered = 0;
    // 🔴 INV-M4 — questions 전부를 돌아 cells 를 빠짐없이 채운다(state:'none' 포함).
    const cells = questions.map((q) => {
      if (!submittedContents.has(q.content_id)) {
        q.not_submitted += 1;
        return { col: q.col, state: 'none', selected: null, selected_label: null,
                 time_taken_sec: null, attempted_at: null };
      }
      const pick = lookupByContent.get(q.content_id);
      const given = pick(q._raw, q.content_index_in_item);
      const state = classify(q._raw, given);
      if (state === 'correct') { correct += 1; q.correct += 1; }
      else if (state === 'wrong') { wrong += 1; q.wrong += 1; }
      else if (state === 'pending') { pending += 1; q.pending += 1; }
      else { unanswered += 1; q.unanswered += 1; }

      let selected = null, selectedLabel = null;
      if (given !== null && given !== undefined && given !== '') {
        if (q.question_type === 'choice') {
          const oi = Number(given);
          selected = Number.isInteger(oi) ? oi : given;
          selectedLabel = Number.isInteger(oi) ? optionLabel(q.options, oi) : String(given);
          const bucket = q.distribution[oi];
          if (bucket) bucket.count += 1;
        } else {
          selected = String(given);
          selectedLabel = String(given);
        }
      }
      const att = latest.get(`${uid}:${q.content_id}`);
      return {
        col: q.col, state, selected, selected_label: selectedLabel,
        // 문항 단위 소요 시간은 어떤 테이블에도 남지 않는다(§14 범위 밖) → null.
        time_taken_sec: null,
        attempted_at: att ? att.attempted_at : null,
      };
    });

    classCorrect += correct;
    classWrong += wrong;
    const base = correct + wrong;

    // 위치 (§5-7)
    const online = members.has(uid);
    const pos = positions.get(uid) || null;
    let itemIndex = null, kind = null, posCol = null;
    if (online) {
      const done = items.length > 0 && (completedCount.get(uid) || 0) >= items.length;
      if (done) { kind = 'done'; itemIndex = items.length; }
      else if (pos && Number.isInteger(pos.index)) {
        itemIndex = pos.index;
        const it = items[pos.index];
        kind = (it && isGradableType(it.content_type)) ? it.content_type : (pos.kind || 'media');
        // ⚠ 문항 단위 위치는 content-player 가 부모에 알리지 않는다(아이템 단위가 한계).
        //    동기화(lesson:sync:move)도 아이템 index 단위이므로 시스템 전체와 정합한다.
        posCol = firstColOf.has(pos.index) ? firstColOf.get(pos.index) : null;
      }
    }
    return {
      user_id: uid,
      display_name: s.display_name || s.username || '학생',
      username: s.username,
      cells,
      correct_count: correct,
      wrong_count: wrong,
      pending_count: pending,
      unanswered_count: unanswered,
      graded_count: base,
      score_percent: base > 0 ? Math.round((correct / base) * 100) : 0,
      submitted_items: submittedContents.size,
      total_gradable_items: totalGradableItems,
      position: {
        online,
        item_index: itemIndex,
        item_title: (itemIndex !== null && items[itemIndex]) ? items[itemIndex].title : null,
        kind,
        col: posCol,
        following: syncOn ? (itemIndex === syncIndex) : true,
      },
      last_activity_at: lastActivity,
    };
  });

  // ── ⑥ 문항 집계 마감 (INV-M2 · INV-M3) ─────────────────────────────────────
  const lowCols = [];
  for (const q of questions) {
    q.accuracy_base = q.correct + q.wrong;                       // 🔴 INV-M3 정의 그 자체
    q.accuracy = q.accuracy_base > 0 ? Math.round((q.correct / q.accuracy_base) * 100) : 0;
    q.low_flag = q.accuracy < LOW_ACCURACY && q.accuracy_base >= LOW_MIN_BASE;
    if (q.low_flag) lowCols.push(q.col);
    q.viewing_count = outStudents.filter(s => s.position.online && s.position.col === q.col).length;
    delete q._raw;
    delete q.content_index_in_item;
  }

  const classBase = classCorrect + classWrong;
  const summary = {
    student_total: outStudents.length,
    submitted_any: outStudents.filter(s => s.submitted_items > 0).length,
    submitted_all: totalGradableItems > 0
      ? outStudents.filter(s => s.submitted_items >= totalGradableItems).length : 0,
    online: outStudents.filter(s => s.position.online).length,
    // 🔴 INV-M5 — 전체 정답 / (전체 정답 + 전체 오답). 학생별 %의 평균이 아니다.
    class_accuracy: classBase > 0 ? Math.round((classCorrect / classBase) * 100) : 0,
    class_accuracy_base: classBase,
    class_correct: classCorrect,
    class_wrong: classWrong,
    low_cols: lowCols,
    no_record_items: noRecordItems,
  };

  return {
    lesson: { id: lesson.id, class_id: Number(lesson.class_id), title: lesson.title },
    sync: {
      on: syncOn,
      // 🔴 FE 가 setViewer(myId) 와 비교해 "동기화 중"(초록) / "○○님이 진행 중"(주황)을 가른다.
      //    ON 인데 null 이면 다른 교사가 제어 중인 상황이 초록으로 보인다 → 반드시 채운다.
      controller_id: syncOn ? (rt.controllerId != null ? rt.controllerId : null) : null,
      controller_name: syncOn ? (rt.controllerName || null) : null,
      current_index: syncOn ? syncIndex : null,
      current_col: syncOn && firstColOf.has(syncIndex) ? firstColOf.get(syncIndex) : null,
    },
    items,
    questions,
    students: outStudents,
    summary,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { buildResponseMonitor, LOW_ACCURACY, LOW_MIN_BASE };
