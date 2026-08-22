// routes/self-learn.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const selfLearnDb = require('../db/self-learn-extended');
const { logLearningActivity } = require('../db/learning-log-helper');
const { awardPoints } = require('../db/point-helper');
const buildNavigation = require('../lib/xapi/builders/navigation');
const buildAssessment = require('../lib/xapi/builders/assessment');
const buildAnnotation = require('../lib/xapi/builders/annotation');
const xapiSpool = require('../lib/xapi/spool');
// ── 정답·해설 비노출 판정 SSOT (lib/strip-answers.js) ─────────────────────────
//   학습맵 노드 상세(problems[])·오늘의 학습 결과(questions[])가 content_questions 의
//   answer·explanation 을 그대로 실어 보냈다(2026-08-07 실측).
//   채점은 서버가 questionId 로 재조회해 수행하므로(recordProblemAttempt) 회귀 없음.
const { stripAnswers } = require('../lib/strip-answers');
// ── 콘텐츠 열람 권한 판정 SSOT (lib/auth/can-view-content.js) ─────────────────
//   routes/content.js 의 guardContent 와 **같은 판정**을 쓴다. 새로 적지 않는다.
const { canViewContent } = require('../lib/auth/can-view-content');
// ── 정수 식별자 정규화 SSOT (lib/ids.js) ──────────────────────────────────────
//   게이트가 읽는 값과 쿼리가 읽는 값이 **같아야** 한다. parseInt 는 "2.17e2"→2,
//   SQLite 코어션은 같은 문자열을 217 로 읽어 두 판정이 갈렸다(2026-08-07 P0).
const { normalizeId, classifyId } = require('../lib/ids');

/**
 * 문제 풀이 시도 기록의 콘텐츠 게이트.
 *
 * 🔴 유래 (2026-08-07 감리 5차 실측, 격리 서버 3480 · student1 세션):
 *     POST /api/self-learn/problem-attempt  {"contentId":193,"questionId":217}
 *       → 200 { "correctAnswer":"56", "explanation":"7 × 8 = 56 입니다." }
 *     같은 학생이 POST /api/contents/193/grade 에서는 403 이었다(193 = 비공개, teacher1 소유).
 *   즉 콘텐츠 경로를 닫아도 **자기주도학습 경로가 권한 검사를 통째로 건너뛰어**
 *   정답·해설이 그대로 나갔다. 비공개(193·194)·초안(34) 전부 재현됐다.
 *
 * ⚠ 과잉 차단 금지 — 판정은 canViewContent 한 벌뿐이고 정상 학습 동선은 전부 통과한다.
 *   실측(정본 스냅샷): 학습맵 노출대상 표본 500/500 통과 · 오늘의학습 항목×멤버 30/30 통과.
 *   차단되는 것은 비공개·초안·반려 콘텐츠뿐이다(= 애초에 열람이 403 인 것들).
 *
 * 🔴🔴 세 번째 유래 — **자기부여(self-grant)**: 학생이 스스로 근거를 만들어 문을 열었다
 *   (2026-08-21 실측, 격리 서버 3487 · student1 세션):
 *     POST /api/self-learn/problem-sets/default/add {"contentId":193}  → 200 (근거 생성)
 *     POST /api/self-learn/problem-attempt {"contentId":193,"questionId":217}
 *       → 200 { correctAnswer:"56", explanation:"7 × 8 = 56 입니다." }   ← 직전엔 403 이던 것
 *   canViewContent 의 이용 근거 5종 중 **problem_set_items·content_collections 두 개는
 *   학생이 직접 쓸 수 있는 테이블**이다. 그 쓰기 라우트에 열람 판정이 없으면
 *   "근거를 만들고 → 근거를 내세워 통과" 하는 순환이 성립한다.
 *   → 근거를 만드는 쓰기(문제집 담기·보관함 담기)도 **같은 문**을 통과해야 한다.
 *     (보관함 쪽은 routes/content.js 의 guardContent 를 같은 이유로 호출한다)
 *
 * @returns {boolean} true 면 통과, false 면 이미 응답을 보냈으므로 호출부는 즉시 return
 */
function guardAttemptContent(req, res, contentId) {
  if (canViewContent(req.user, contentId)) return true;
  res.status(403).json({ success: false, message: '이 콘텐츠를 볼 권한이 없습니다.' });
  return false;
}

/**
 * questionId 가 **정말 그 콘텐츠의 문항인지** 확인한다 (교차 주입 차단).
 *
 * 🔴 유래 — 게이트만으로는 안 닫히는 두 번째 구멍 (2026-08-07 실측):
 *     POST /problem-attempt {"contentId":5(열람가능), "questionId":217(비공개 193의 문항)}
 *       → 200 { correctAnswer:"56", explanation:"7 × 8 = 56 입니다." }
 *   guardAttemptContent 가 보는 키(contentId)와 채점기가 정답을 꺼내는 키(questionId)가
 *   갈라져 있어서, **열람 가능한 콘텐츠를 방패로 삼아** 남의 문항 정답을 뽑을 수 있었다.
 *   오답노트 자동 수집까지 그 문항을 그대로 담으므로 흔적을 남기며 새는 형태였다.
 *
 * ⚠ 과잉 차단 금지 — 정상 호출은 전부 통과한다.
 *   FE(learning-map.html submitSolve · content 별칭 경로)는 항상 **같은 콘텐츠의**
 *   question_id 를 실어 보낸다(`contentId: p.id, questionId: p.question_id`).
 *   · questionId 미전송        → 검사 안 함(콘텐츠 단위 제출 — 기존 호환 경로 그대로)
 *   · 존재하지 않는 questionId → 검사 안 함(기존과 동일하게 db 쪽 폴백 분기로 흡수)
 *   · **다른 콘텐츠의 문항**   → 400. 정상 클라이언트가 만들 수 없는 요청이다.
 *
 * 🔴🔴 두 번째 유래 — **게이트와 채점기가 같은 문자열을 다르게 읽었다** (2026-08-07 감리 6차):
 *     POST /problem-attempt {"contentId":5, "questionId":"2.17e2"}
 *       → 200 { correctAnswer:"56", explanation:"7 × 8 = 56 입니다." }
 *   여기(게이트)는 `parseInt("2.17e2",10)` → **2** 로 읽어 "콘텐츠 5의 2번 문항"이라 통과시켰고,
 *   채점기(db/self-learn-extended.js recordProblemAttempt)는 **원본 문자열**을 SQLite 에 넘겨
 *   `WHERE id = '2.17e2'` 가 **217**(비공개 193의 문항)로 코어션됐다.
 *   지수·부호·공백 표기 6종(`2.17e2`·`2.17E2`·`+2.17e2`·`2.17e+2`·`.217e3`·`" 2.17e2 "`)이 전부 뚫렸다.
 *
 *   → 해법은 "한쪽을 고치는 것"이 아니라 **양쪽이 같은 값을 보게 하는 것**이다.
 *     이 함수는 이제 **정규화된 Number 를 돌려주고**, 호출부는 그 값을 그대로 채점기에 넘긴다.
 *     즉 게이트가 승인한 문항 = 채점기가 조회하는 문항이 구조적으로 동일해진다.
 *     정규화 판정은 lib/ids.js 한 벌뿐이다(사본 금지).
 *
 * ※ 채점 로직 자체(db/self-learn-extended.js)는 진단 v3 재설계와 같은 파일이라 최소 침습으로만
 *   건드린다 — 같은 SSOT 로 한 번 더 정규화하고 문항 조회를 content_id 로 스코프한다(이중 방어).
 *
 * @returns {number|null|false}
 *   number — 정규화된 questionId. 호출부는 **이 값을** 채점기에 넘겨야 한다
 *   null   — questionId 미전송(콘텐츠 단위 제출). 기존 호환 경로 그대로
 *   false  — 차단됨(이미 응답을 보냈다). 호출부는 즉시 return
 */
function guardQuestionBelongsToContent(req, res, contentId, questionId) {
  const kind = classifyId(questionId);
  if (kind === 'absent') return null;                       // questionId 미전송 — 콘텐츠 단위 제출
  if (kind === 'invalid') {
    // "2.17e2" 같은 지수·소수·부호 표기. 정상 클라이언트가 만들 수 없고,
    // 통과시키면 게이트와 SQLite 가 다른 문항을 가리킨다 → 규격 밖은 즉시 거부한다.
    res.status(400).json({ success: false, message: '잘못된 문항 ID입니다.' });
    return false;
  }
  const qid = normalizeId(questionId);
  try {
    const mainDb = require('../db');
    const row = mainDb.prepare('SELECT content_id FROM content_questions WHERE id = ?').get(qid);
    if (!row) return qid;                                   // 존재하지 않는 문항 — 기존 폴백 유지
    if (Number(row.content_id) === Number(contentId)) return qid;
  } catch (_) { return qid; }                               // 조회 실패는 막지 않는다(가용성 우선)
  res.status(400).json({ success: false, message: '문항이 이 콘텐츠에 속하지 않습니다.' });
  return false;
}

// 학습맵 노드 → 표준체계 컨텍스트 조회 헬퍼
function _nodeStdContext(nodeId) {
  try {
    const mainDb = require('../db');
    const n = mainDb.prepare('SELECT id, subject_code, grade_group, school_level, label FROM curriculum_content_nodes WHERE id = ?').get(nodeId);
    if (!n) return {};
    return {
      curriculum_standard_ids: n.id,
      subject_code: n.subject_code || null,
      grade_group: n.grade_group || null,
      school_level: n.school_level || null,
      label: n.label,
    };
  } catch { return {}; }
}

// ========== 학습 설정 ==========

router.get('/settings', requireAuth, (req, res) => {
  try {
    const db = require('../db');
    let settings = db.prepare('SELECT * FROM user_learn_settings WHERE user_id = ?').get(req.user.id);
    if (!settings) {
      db.prepare("INSERT INTO user_learn_settings (user_id) VALUES (?)").run(req.user.id);
      settings = db.prepare('SELECT * FROM user_learn_settings WHERE user_id = ?').get(req.user.id);
    }
    try { settings.subjects = JSON.parse(settings.subjects); } catch { settings.subjects = ['국어','수학','사회','과학','영어']; }
    try { settings.difficulty = JSON.parse(settings.difficulty); } catch { settings.difficulty = {}; }
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

router.put('/settings', requireAuth, (req, res) => {
  try {
    const db = require('../db');
    const { school_level, grade, subjects, difficulty } = req.body;
    db.prepare(`
      INSERT INTO user_learn_settings (user_id, school_level, grade, subjects, difficulty, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        school_level = excluded.school_level, grade = excluded.grade,
        subjects = excluded.subjects, difficulty = excluded.difficulty,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, school_level || '초', grade || 4,
      JSON.stringify(subjects || ['국어','수학','사회','과학','영어']),
      JSON.stringify(difficulty || {}));
    res.json({ success: true, message: '설정이 저장되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ========== 오늘의 학습 ==========

// ─────────────────────────────────────────────────────────────────────────────
// 오늘의 학습 세트 권한 게이트 (P0-6, 2026-08-05)
//
//   결함(실측): 세트 생성·수정·항목추가·항목삭제 4개 라우트가 requireAuth 뿐이라
//   student1 세션으로 전부 200 + DB 반영됐다.
//     · POST   /daily/sets                   → 학생 본인이 teacher_id 인 세트 생성
//     · PUT    /daily/sets/{교사세트}         → 남의 세트 제목 임의 변경
//     · DELETE /daily/sets/{교사세트}/items/… → 남의 세트 항목 삭제
//     · POST   /daily/{타학년 item}/complete  → 배포 대상이 아닌 항목 이수 + 포인트 적립
//
//   정책(신규 발명 금지 — routes/class-mileage.js 의 requireClassMember/requireOwner 계층을 그대로 따름):
//     ① 역할 게이트  requireSetManager : 세트 관리(쓰기)는 **관리자만**
//     ② 소유 게이트  requireSetOwner   : 세트 존재 확인 + req.dailySet 주입 (관리자 방어 확인)
//     ③ 대상 자격    requireDailyItemTarget : 학생은 "나에게 배포된" 항목만 시작/이수/진행저장
//        (배포 중지 세트 X · 타학년 X · 남의 클래스 전용 세트 X)
//
//   [2026-08-06 관리자 전용화 — 사용자 지시] 쓰기 권한을 teacher·admin → **admin 단독**으로 좁혔다.
//     근거(실측): 교사에게는 애초에 **진입 UI 가 없었다**.
//       · public/js/common-nav.js "학습 배포 관리" 는 roles:['admin']
//       · 세트 구성·배포 화면은 public/admin/daily-learning.html 하나뿐(관리자 전용 경로)
//     즉 교사의 쓰기 권한은 화면 없는 API 전용 능력이었고, 정책("오늘의 학습은 관리자가 구성·배포")과
//     어긋나 있었다. 되돌리려는 다음 사람에게: **UI 를 먼저 만들지 않는 한 되돌릴 이유가 없다.**
//
//   ⚠ 기존 데이터는 건드리지 않는다. 교사(teacher1) 소유 세트 8건은 그대로 배포 상태로 남아 있고,
//     학생 노출(GET /daily·상세)·시작·이수는 **teacher_id 와 무관**하게 동작한다
//     (db/self-learn-extended.js isDailySetTargetedTo 는 is_active·target_grade·class_id 만 본다).
//     즉 이 변경은 "앞으로의 쓰기"만 막고, 이미 배포된 학습의 학생 경험은 그대로다.
// ─────────────────────────────────────────────────────────────────────────────
const SET_MANAGER_ROLES = ['admin'];

//  읽기 전용 관리 시야는 **좁히지 않는다**(과차단 방지).
//  교사는 배포 중지(is_active=0) 세트까지 포함해 점검 목적으로 볼 수 있어야 한다 — 쓰기만 admin.
const SET_INSPECT_ROLES = ['teacher', 'admin'];

function requireSetManager(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  if (!SET_MANAGER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: '오늘의 학습은 관리자만 구성·배포할 수 있습니다.' });
  }
  next();
}

/**
 * 세트 존재 확인 + req.dailySet / req.setId 주입.
 *
 * 이전에는 `role !== 'admin' && set.teacher_id !== req.user.id → 403` 로 교사 소유권을 봤다.
 * requireSetManager 가 admin 만 통과시키는 지금, 그 분기의 "교사 가지"는 **도달 불가능한 죽은 코드**라
 * 제거했다. teacher_id 로 admin 을 막으면 오히려 과차단이다 — 정본 DB 의 교사 소유 세트 8건을
 * 관리자가 손대지 못하게 되기 때문. 따라서 남는 조건은 "관리자인가" 하나뿐이다.
 * (게이트 순서가 바뀌어도 안전하도록 방어적으로 한 번 더 확인한다. 조건은 role !== 'admin' 뿐이므로
 *  admin 은 어떤 경우에도 여기서 막히지 않는다.)
 */
function requireSetOwner(req, res, next) {
  const setId = parseInt(req.params.setId);
  if (!setId || isNaN(setId)) {
    return res.status(400).json({ success: false, message: '잘못된 학습 세트 ID입니다.' });
  }
  const set = require('../db')
    .prepare('SELECT id, teacher_id, class_id FROM daily_learning_sets WHERE id = ?').get(setId);
  if (!set) {
    return res.status(404).json({ success: false, message: '학습 세트를 찾을 수 없습니다.' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '오늘의 학습은 관리자만 구성·배포할 수 있습니다.' });
  }
  req.dailySet = set;
  req.setId = setId;
  next();
}

// 배포 대상 자격 술어는 db/self-learn-extended.js 의 **단일 정본**을 쓴다.
//   목록(getDailySets)과 열람·이수가 같은 함수를 공유해야 "목록엔 뜨는데 열면 403" 이 생기지 않는다.
const isDailySetTargetedTo = selfLearnDb.isDailySetTargetedTo;

/** 학생은 "나에게 배포된" 항목만 시작/이수/진행저장 할 수 있다. */
function requireDailyItemTarget(req, res, next) {
  const itemId = parseInt(req.params.itemId);
  if (!itemId || isNaN(itemId)) {
    return res.status(400).json({ success: false, message: '잘못된 학습 항목 ID입니다.' });
  }
  const row = require('../db').prepare(`
    SELECT i.id AS item_id, s.id AS set_id, s.is_active, s.target_grade, s.class_id
    FROM daily_learning_items i
    JOIN daily_learning_sets s ON s.id = i.set_id
    WHERE i.id = ?
  `).get(itemId);
  if (!row) {
    return res.status(404).json({ success: false, message: '학습 항목을 찾을 수 없습니다.' });
  }
  req.dailyItemId = itemId;
  if (!isDailySetTargetedTo(req.user, row)) {
    return res.status(403).json({ success: false, message: '나에게 배포된 학습 항목이 아닙니다.' });
  }
  next();
}

// GET /daily — 오늘의 학습 세트 목록
//   학생이면 기본적으로 본인 학년 세트만 반환 (다른 학년 세트 노출 방지).
//   교사/관리자는 필터 없이 전체 조회 허용. 명시적으로 grade를 넘기면 그 값을 우선.
//   [W2-T4-3] 배포 중지(is_active=0) 세트는 학생 화면에 노출 금지. 관리 화면(teacher/admin)만 포함.
//   [감리 B2] 목록도 열람과 **같은 술어**(isDailySetTargetedTo)로 거른다.
//     이전에는 목록이 is_active 만 보고 학년·클래스 대상을 안 봐서, student8(grade IS NULL)에게
//     764건이 뜨고 열면 전부 403 이었다. 목록에 뜬 세트는 반드시 상세가 열려야 한다.
router.get('/daily', requireAuth, (req, res) => {
  try {
    const q = { ...req.query };
    //   학년 필터는 viewer 술어(isDailySetTargetedTo)가 담당한다.
    //   여기서 q.grade = 내 학년 을 따로 걸면 **전 학년 대상(target_grade IS NULL) 세트가 목록에서만
    //   사라지고 상세는 열리는** 반대 방향의 불일치가 생긴다. ?grade= 를 명시한 관리 화면 조회만 그대로 둔다.
    //  [과차단 방지] 여기는 **읽기**다. 쓰기 권한(SET_MANAGER_ROLES=admin)과 분리해 교사 점검 시야를 유지한다.
    q.includeInactive = SET_INSPECT_ROLES.includes(req.user.role);
    q.viewer = { id: req.user.id, role: req.user.role, grade: req.user.grade };
    const sets = selfLearnDb.getDailySets(req.user.id, q);
    // 학년 미설정 학생은 학년 지정 세트의 배정 대상이 아니다 → 목록이 빈다. 화면이 이유를 말할 수 있게 고지한다.
    const notice = (req.user.role === 'student' && req.user.grade == null && sets.length === 0)
      ? '학년 정보가 등록되어 있지 않아 배정된 학습이 없습니다. 학년을 설정하면 오늘의 학습을 받을 수 있어요.'
      : null;
    res.json({ success: true, sets, ...(notice ? { notice } : {}) });
  } catch (err) {
    console.error('[SELF-LEARN] daily list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /daily/stats — 학습 통계
router.get('/daily/stats', requireAuth, (req, res) => {
  try {
    const stats = selfLearnDb.getDailyStats(req.user.id);
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /daily/:setId — 세트 상세
//   [P0-6 같은 부류] 읽기도 배포 대상만. 이전에는 학생이 타학년·배포중지 세트의 제목·항목 구성을 그대로 읽었다.
router.get('/daily/:setId', requireAuth, (req, res) => {
  try {
    const detail = selfLearnDb.getDailySetDetail(parseInt(req.params.setId), req.user.id);
    if (!detail) return res.status(404).json({ success: false, message: '학습 세트를 찾을 수 없습니다.' });
    if (!isDailySetTargetedTo(req.user, detail.set)) {
      return res.status(403).json({ success: false, message: '나에게 배포된 학습 세트가 아닙니다.' });
    }
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 오늘의 학습 항목 + 콘텐츠 메타 조회 헬퍼 (xAPI 컨텍스트용)
// 주의: contents 스키마는 subject_code/grade_group 가 아니라 subject/grade/school_level 사용
function _loadDailyItemMeta(itemId) {
  try {
    const mainDb = require('../db');
    return mainDb.prepare(`
      SELECT i.id AS item_id, i.set_id, i.content_id,
             c.title, c.content_type, c.subject, c.grade, c.school_level,
             c.achievement_code, c.curriculum_standard_ids
      FROM daily_learning_items i
      LEFT JOIN contents c ON c.id = i.content_id
      WHERE i.id = ?
    `).get(itemId);
  } catch { return null; }
}

// POST /daily/:itemId/start — 학습 시작
router.post('/daily/:itemId/start', requireAuth, requireDailyItemTarget, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    selfLearnDb.startDailyItem(itemId, req.user.id);
    // xAPI: 오늘의 학습 시작 → navigation(did)
    try {
      const meta = _loadDailyItemMeta(itemId);
      if (meta) {
        xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
          verb: 'did',
          target_id: meta.item_id,
          target_title: meta.title || `학습 항목 ${meta.item_id}`,
          content_type: meta.content_type || null,
          subject_code: meta.subject || null,
          school_level: meta.school_level || null,
          achievement_codes: meta.achievement_code || null,
          curriculum_standard_ids: meta.curriculum_standard_ids || null,
        });
      }
    } catch (e) { console.error('[xapi:daily_start]', e.message); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /daily/:itemId/complete — 학습 완료
router.post('/daily/:itemId/complete', requireAuth, requireDailyItemTarget, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    selfLearnDb.completeDailyItem(itemId, req.user.id, req.body);
    // LRS 정본 이벤트: completeDailyItem 이 learning_logs 에 'daily_complete' 1건만 적재한다.
    //   아래 xapiSpool.record 는 KERIS/AIDT 허브 송신용 xapi_statement_spool(별도 트랙)에만 기록되며
    //   학생 LRS 대시보드(/insights·/mastery·/trend·/stats/*·/emotion-mirror)는 learning_logs 만 조회한다.
    //   따라서 1 이수는 학생 뷰에서 '오늘의 학습(자기주도)' 단일 건으로만 집계된다(이중카운트 없음).
    // xAPI(허브 송신용): 오늘의 학습 완료 → navigation(learned). 항목이 평가형(quiz/practice)이면 assessment(submitted) 도 함께 적재
    try {
      const meta = _loadDailyItemMeta(itemId);
      if (meta) {
        const ct = String(meta.content_type || '').toLowerCase();
        const isAssessmentLike = ['quiz', 'exercise', 'practice', 'i', 'p', 'e'].includes(ct);
        const stdCtx = {
          subject_code: meta.subject || null,
          school_level: meta.school_level || null,
          achievement_codes: meta.achievement_code || null,
          curriculum_standard_ids: meta.curriculum_standard_ids || null,
        };
        xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
          verb: 'learned',
          target_id: meta.item_id,
          target_title: meta.title || `학습 항목 ${meta.item_id}`,
          content_type: meta.content_type || null,
          completed: true,
          progress_percent: 100,
          duration_sec: Number(req.body && req.body.duration_seconds) || 0,
          ...stdCtx,
        });
        if (isAssessmentLike) {
          const correct = Number(req.body && (req.body.correct_count != null ? req.body.correct_count : req.body.score)) || 0;
          const total = Number(req.body && (req.body.total_questions != null ? req.body.total_questions : req.body.max_score)) || 0;
          xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
            verb: 'submitted',
            assessment_id: meta.item_id,
            assessment_type: 'practice',  // → 'E' (기타)
            title: meta.title || `학습 항목 ${meta.item_id}`,
            total_score: correct,
            max_score: total,
            duration_seconds: Number(req.body && req.body.duration_seconds) || 0,
            ...stdCtx,
          });
        }
      }
    } catch (e) { console.error('[xapi:daily_complete]', e.message); }
    res.json({ success: true, message: '학습이 완료되었습니다!' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /daily/:itemId/result — 정오답 상세 조회 (학생 본인)
router.get('/daily/:itemId/result', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getDailyItemResult(parseInt(req.params.itemId), req.user.id);
    if (!result) return res.status(404).json({ success: false, message: '항목을 찾을 수 없습니다.' });
    // ★ 정답 비노출 — 시점 분기. getDailyItemResult 는 "풀이 안 함" 인 경우에도
    //   content_questions 정답지를 통째로 폴백으로 돌려줬다(주석에도 그렇게 적혀 있었다).
    //   결과 화면은 **이수 후** 보는 화면이므로, 이수 전에는 정답을 벗긴다.
    const done = !!(result.progress && (result.progress.completed_at || result.progress.status === 'completed'));
    result.questions = stripAnswers(result.questions, req.user, { submitted: done });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] daily result error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /daily/:itemId/save-progress — 영상 시청 위치 저장
router.post('/daily/:itemId/save-progress', requireAuth, requireDailyItemTarget, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { videoPosition, videoDuration, watchRatio } = req.body;
    const db = require('../db');
    db.prepare(`UPDATE daily_learning_progress
      SET video_position = ?, video_duration = ?, watch_ratio = MAX(COALESCE(watch_ratio,0), ?)
      WHERE item_id = ? AND user_id = ?`
    ).run(videoPosition || 0, videoDuration || 0, watchRatio || 0, itemId, req.user.id);
    // xAPI: 영상 진행 → media(played) — duration 초, completion %
    try {
      const mainDb = require('../db');
      // contents 테이블 컬럼: subject (subject_code 아님), grade, school_level, achievement_code, curriculum_standard_ids
      const meta = mainDb.prepare(`
        SELECT i.set_id, i.content_id,
               c.title, c.content_type, c.subject, c.grade, c.school_level,
               c.achievement_code, c.curriculum_standard_ids
        FROM daily_learning_items i
        LEFT JOIN contents c ON c.id = i.content_id
        WHERE i.id = ?
      `).get(itemId);
      if (meta && meta.content_id) {
        const completionPct = Math.max(0, Math.min(100, Math.round(Number(watchRatio) * 100) || 0));
        xapiSpool.record('media', require('../lib/xapi/builders/media'), { userId: req.user.id }, {
          verb: 'played',
          content_id: meta.content_id,
          title: meta.title || null,
          content_type: meta.content_type || 'video',
          duration_seconds: Number(videoDuration) || 0,
          completion_percent: completionPct,
          completed: completionPct >= 100,
          subject_code: meta.subject || null,
          school_level: meta.school_level || null,
          achievement_codes: meta.achievement_code || null,
          curriculum_standard_ids: meta.curriculum_standard_ids || null,
        });
      }
    } catch (e) { console.error('[xapi:daily_save_progress]', e.message); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /daily/:itemId/get-progress — 영상 시청 위치 조회
router.get('/daily/:itemId/get-progress', requireAuth, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const db = require('../db');
    const row = db.prepare('SELECT video_position, video_duration, watch_ratio FROM daily_learning_progress WHERE item_id = ? AND user_id = ?').get(itemId, req.user.id);
    res.json({ success: true, progress: row || { video_position: 0, video_duration: 0, watch_ratio: 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// POST /daily/sets — [관리자 전용] 학습 세트 생성
router.post('/daily/sets', requireAuth, requireSetManager, (req, res) => {
  try {
    const result = selfLearnDb.createDailySet(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] daily/sets create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /daily/sets/:setId — [관리자 전용] 학습 세트 수정
router.put('/daily/sets/:setId', requireAuth, requireSetManager, requireSetOwner, (req, res) => {
  try {
    selfLearnDb.updateDailySet(req.setId, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('[SELF-LEARN] daily/sets update error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /daily/sets/:setId — [관리자 전용] 학습 세트 삭제
//   [W2-T4-5] 관리자 화면(daily-learning.html deleteSet)이 이 경로를 호출했으나 라우트 자체가 없어 404였다.
//   항목·진행행까지 함께 정리해야 FK(daily_learning_progress → daily_learning_items) 위반이 나지 않는다.
router.delete('/daily/sets/:setId', requireAuth, requireSetManager, requireSetOwner, (req, res) => {
  try {
    const result = selfLearnDb.deleteDailySet(req.setId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] daily/sets delete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /daily/sets/:setId/items — [관리자 전용] 학습 항목 추가
router.post('/daily/sets/:setId/items', requireAuth, requireSetManager, requireSetOwner, (req, res) => {
  try {
    const result = selfLearnDb.addDailyItem(req.setId, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] daily/sets item add error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /daily/sets/:setId/items — [관리자 전용] 학습 항목 **동기화**(차집합)
//   [감리 B1] 관리자 저장이 "전량 DELETE 후 재삽입" 이라 제목만 고쳐도 학생 이수 기록이 사라졌다.
//   이 라우트는 같은 콘텐츠의 **항목 id 를 유지**하고 메타만 갱신한다 → 진행행·learning_logs 보존.
//   ?preview=1 이면 아무것도 바꾸지 않고 "제거될 항목과 그 진행 기록 수"만 돌려준다(저장 전 확인용).
router.put('/daily/sets/:setId/items', requireAuth, requireSetManager, requireSetOwner, (req, res) => {
  try {
    const items = (req.body && (req.body.items || req.body)) || [];
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });
    }
    if (String(req.query.preview || '') === '1') {
      return res.json({ success: true, removing: selfLearnDb.previewDailyItemRemoval(req.setId, items) });
    }
    const result = selfLearnDb.syncDailyItems(req.setId, items);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] daily/sets items sync error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /daily/sets/:setId/items/:itemId — [관리자 전용] 학습 항목 삭제
//   항목이 실제로 그 세트 소속인지까지 확인한다(기존에는 setId 를 무시하고 itemId 만으로 삭제).
router.delete('/daily/sets/:setId/items/:itemId', requireAuth, requireSetManager, requireSetOwner, (req, res) => {
  try {
    const removed = selfLearnDb.removeDailyItem(parseInt(req.params.itemId), req.setId);
    if (!removed) return res.status(404).json({ success: false, message: '해당 세트의 학습 항목을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[SELF-LEARN] daily/sets item remove error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== AI 맞춤학습 ==========

// GET /map/nodes — 학습맵 노드 목록 (확장: schoolLevel, semester, area, status, keyword)
// 기본: node_level=3만 반환. includeGroups=true이면 2단계까지 포함
router.get('/map/nodes', requireAuth, (req, res) => {
  try {
    let nodes = selfLearnDb.getMapNodes({ ...req.query, userId: req.user.id });
    const includeGroups = String(req.query.includeGroups || '').toLowerCase() === 'true';
    const parentNodeId = req.query.parentNodeId ? String(req.query.parentNodeId).trim() : '';
    const nodeLevelQ = req.query.nodeLevel ? parseInt(req.query.nodeLevel) : null;
    if (parentNodeId) {
      nodes = nodes.filter(n => n.parent_node_id === parentNodeId);
    } else if (nodeLevelQ === 2) {
      nodes = nodes.filter(n => n.node_level === 2);
    } else if (nodeLevelQ === 3) {
      nodes = nodes.filter(n => n.node_level === 3 || n.node_level == null);
    } else if (!includeGroups) {
      nodes = nodes.filter(n => n.node_level === 3 || n.node_level == null);
    } else {
      nodes = nodes.filter(n => n.node_level == null || n.node_level === 2 || n.node_level === 3);
    }
    res.json({ success: true, nodes });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /map/nodes/:unitId/lessons — 단원(level=2) 노드의 자식 차시(level=3) 목록
// 각 차시의 videos_count, problems_count, user_status 를 포함 (공개 승인된 콘텐츠만 카운트)
router.get('/map/nodes/:unitId/lessons', requireAuth, (req, res) => {
  try {
    const db = require('../db');
    const unitId = req.params.unitId;
    const unit = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id = ?').get(unitId);
    if (!unit) {
      return res.status(404).json({ success: false, message: '단원을 찾을 수 없습니다.' });
    }
    const lessons = db.prepare(`
      SELECT n.node_id, n.subject, n.grade, n.semester, n.unit_name, n.lesson_name,
             n.achievement_code, n.node_level, n.parent_node_id, n.sort_order,
             (SELECT COUNT(*) FROM node_contents nc
                JOIN contents c ON nc.content_id = c.id
                WHERE nc.node_id = n.node_id
                  AND c.content_type = 'video'
                  AND c.is_public = 1 AND c.status = 'approved') AS videos_count,  -- access-ok: 학습맵 '목록 노출' 필터. can-view-content.js 가 전제로 삼는 그 필터이며 단건 열람 판정이 아니다
             (SELECT COUNT(*) FROM node_contents nc
                JOIN contents c ON nc.content_id = c.id
                WHERE nc.node_id = n.node_id
                  AND c.content_type IN ('quiz','exam','problem','question','assessment')
                  AND c.is_public = 1 AND c.status = 'approved') AS problems_count,  -- access-ok: 위와 동일(목록 카운트 필터)
             COALESCE(uns.status, 'not_started') AS user_status,
             uns.correct_rate AS correct_rate
      FROM learning_map_nodes n
      LEFT JOIN user_node_status uns ON uns.node_id = n.node_id AND uns.user_id = ?
      WHERE n.parent_node_id = ? AND n.node_level = 3
      ORDER BY n.sort_order, n.node_id
    `).all(req.user.id, unitId);

    // progress_percent 계산 — [2026-08-06 사용자 확정 정책] **문항 기준만** 사용.
    //   영상은 "봐도 안 봐도 그만"이므로 진행률에서 완전히 제외한다.
    //   (videos_watched / videos_total 필드는 화면의 "영상 n/m" 칩용으로 그대로 유지)
    const videoIdsStmt = db.prepare(`
      SELECT c.id FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ? AND c.content_type = 'video'
        AND c.is_public = 1 AND c.status = 'approved'  -- access-ok: 진행률 분모용 목록 필터(단건 열람 판정 아님)
    `);
    const problemIdsStmt = db.prepare(`
      SELECT c.id FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ?
        AND c.content_type IN ('quiz','exam','problem','question','assessment')
        AND c.is_public = 1 AND c.status = 'approved'  -- access-ok: 진행률 분모용 목록 필터(단건 열람 판정 아님)
    `);
    const videoRatioStmt = db.prepare(`
      SELECT watch_ratio FROM user_content_progress WHERE user_id = ? AND content_id = ?
    `);
    const problemCorrectStmt = db.prepare(`
      SELECT MAX(is_correct) AS ok FROM problem_attempts WHERE user_id = ? AND content_id = ?
    `);
    for (const lesson of lessons) {
      const videoIds = videoIdsStmt.all(lesson.node_id).map(r => r.id);
      const problemIds = problemIdsStmt.all(lesson.node_id).map(r => r.id);
      const totalV = videoIds.length;
      const totalP = problemIds.length;
      let watchedV = 0, solvedP = 0;
      for (const vid of videoIds) {
        const p = videoRatioStmt.get(req.user.id, vid);
        if (p && (p.watch_ratio || 0) >= 0.8) watchedV++;
      }
      for (const pid of problemIds) {
        const p = problemCorrectStmt.get(req.user.id, pid);
        if (p && p.ok === 1) solvedP++;
      }
      // 문항이 0개면 0% — 상태 기반 추정(진행중=30% 등)은 지어낸 값이므로 금지.
      const progress = totalP > 0 ? Math.round((solvedP / totalP) * 100) : 0;
      lesson.videos_watched = watchedV;
      lesson.videos_total = totalV;
      lesson.problems_solved = solvedP;
      lesson.problems_total = totalP;
      lesson.progress_percent = Math.max(0, Math.min(100, progress));
    }
    // 단원 진행률 = 자식 차시 문항 **총합** 기준 (차시 진행률의 평균이 아님).
    //   여기서는 위에서 이미 센 차시별 값을 더하므로 추가 쿼리가 없다.
    const unitTotalP = lessons.reduce((a, l) => a + (l.problems_total || 0), 0);
    const unitSolvedP = lessons.reduce((a, l) => a + (l.problems_solved || 0), 0);
    unit.problems_total = unitTotalP;
    unit.problems_solved = unitSolvedP;
    unit.progress_percent = unitTotalP > 0 ? Math.round((unitSolvedP / unitTotalP) * 100) : 0;

    res.json({ success: true, unit, lessons });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/:unitId/lessons error:', err && (err.stack || err.message || err));
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', debug: String(err && (err.message || err)) });
  }
});

// GET /map/nodes/:nodeId — 노드 상세 (확장 응답: videos, problems, userStatus)
router.get('/map/nodes/:nodeId', requireAuth, (req, res) => {
  try {
    const detail = selfLearnDb.getMapNodeDetail(req.params.nodeId, req.user.id);
    if (!detail) return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });

    // 진단 흐름용 폴백: problems가 비어 있고 ?withFallbackProblems=1이면 자식/closure로 보충
    const wantFallback = String(req.query.withFallbackProblems || '') === '1';
    if (wantFallback && (!detail.problems || detail.problems.length === 0)) {
      try {
        const fallback = selfLearnDb.collectFallbackProblems
          ? selfLearnDb.collectFallbackProblems(req.params.nodeId, req.user.id, 10)
          : null;
        if (Array.isArray(fallback) && fallback.length) {
          // ★ 폴백 후보는 **열람 권한을 통과한 것만** 남긴다.
          //   collectFallbackProblems 는 교과·학교급·학년으로만 좁힐 뿐 is_public·status 를 보지 않는다.
          //   그래서 비공개·초안·반려 콘텐츠의 문항이 학생 응답에 섞여 들어갔다.
          //   판정은 여기서도 canViewContent 한 벌 — 새 규칙을 적지 않는다.
          //   과잉 차단 위험 0: node_contents 매핑 문항형 8,898건 중 비공개·미승인은 0건이고
          //   공개 승인본은 canViewContent 의 1번 규칙(공개 승인본 전원 허용)으로 그대로 통과한다.
          detail.problems = fallback.filter(p => canViewContent(req.user, Number(p.content_id ?? p.id)));
          detail.problems_source = 'fallback';
        }
      } catch (_) { /* 폴백 실패 시 그대로 진행 */ }
    }
    // ★ 정답 비노출: problems[].answer·explanation 은 풀기 전 문항 제공이다.
    //   FE(learning-map submitSolve)는 서버 채점 응답의 correctAnswer·explanation 을
    //   최종값으로 쓰고 p.answer 는 폴백일 뿐이라 회귀가 없다.
    if (Array.isArray(detail.problems)) detail.problems = stripAnswers(detail.problems, req.user);
    res.json({ success: true, ...detail });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/:id error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /map/edges — 노드 간 관계
router.get('/map/edges', requireAuth, (req, res) => {
  try {
    let edges = selfLearnDb.getMapEdges(req.query);
    const edgeType = String(req.query.edgeType || '').toLowerCase();
    if (edgeType === 'unit') {
      edges = edges.filter(e => e.edge_type === 'unit_prerequisite');
    } else if (edgeType === 'all') {
      // 전부
    } else {
      // 기본: 차시(prerequisite)만
      edges = edges.filter(e => e.edge_type === 'prerequisite' || e.edge_type == null);
    }
    res.json({ success: true, edges });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /map/user-status — 사용자 노드 상태
router.get('/map/user-status', requireAuth, (req, res) => {
  try {
    const statuses = selfLearnDb.getUserNodeStatuses(req.user.id);
    res.json({ success: true, statuses });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /map/nodes/:nodeId/start — 차시 학습 시작 (status 승격)
router.post('/map/nodes/:nodeId/start', requireAuth, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const db = require('../db');

    const node = db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) {
      return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });
    }

    // 전 역할 허용: 모든 인증 사용자가 자기 user.id로 차시 진행을 기록한다.
    // (비학생 기록은 학생 통계 집계 쿼리의 role='student' 필터로 격리됨)
    const existing = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?').get(req.user.id, nodeId);
    const prevStatus = existing ? existing.status : 'not_started';
    const terminal = new Set(['in_progress', 'completed', 'mastered']);

    let nextStatus = prevStatus;
    let changed = false;
    if (!existing || prevStatus === 'not_started' || prevStatus === 'available') {
      nextStatus = 'in_progress';
      db.prepare(`
        INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at)
        VALUES (?, ?, 'in_progress', CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, node_id) DO UPDATE SET
          status = 'in_progress',
          last_accessed_at = CURRENT_TIMESTAMP
      `).run(req.user.id, nodeId);
      changed = true;
    } else if (terminal.has(prevStatus)) {
      // no-op
      console.log(`[self-learn] /map/nodes/${nodeId}/start no-op (prevStatus=${prevStatus}, user=${req.user.id})`);
    }

    // xAPI: AI 맞춤학습 차시 노드 진입 navigation.did
    try {
      const ctxN = _nodeStdContext(nodeId);
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
        verb: changed ? 'did' : 'viewed',
        lesson_id: nodeId,
        title: ctxN.label || `차시 ${nodeId}`,
        source: 'ai_custom_learning',
        ...ctxN,
      });
    } catch (_) {}
    res.json({ success: true, status: nextStatus, prevStatus, changed });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/start error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /map/nodes/:nodeId/diagnose-complete — 노드 클릭 시 간이 진단 완료 처리
router.post('/map/nodes/:nodeId/diagnose-complete', requireAuth, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const db = require('../db');

    const node = db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) {
      return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });
    }

    // [2026-06-05 진단↔학습 분리] 노드 클릭(간이 진단)은 user_node_status.status 를 절대 바꾸지 않는다.
    //   노드 학습 status는 오직 실제 학습(영상 시청·문제 풀이·차시 시작/완료)으로만 산출된다.
    //   여기서는 진단 기록(quick 세션)만 남기고, 마지막 접근 시각만 갱신(없으면 not_started로 생성).
    const existing = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?').get(req.user.id, nodeId);
    const finalStatus = existing ? existing.status : 'not_started';

    // last_accessed_at만 갱신 — status 컬럼은 건드리지 않음 (신규 행은 not_started로 생성)
    db.prepare(`
      INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at)
      VALUES (?, ?, 'not_started', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, node_id) DO UPDATE SET
        last_accessed_at = CURRENT_TIMESTAMP
    `).run(req.user.id, nodeId);

    // 간단한 진단 세션 기록 (mode='quick') — 진단 이력 보존
    try {
      db.prepare(`
        INSERT INTO diagnosis_sessions
          (user_id, target_node_id, diagnosis_type, status, total_questions, correct_count, completed_at)
        VALUES (?, ?, 'quick', 'completed', 0, 0, CURRENT_TIMESTAMP)
      `).run(req.user.id, nodeId);
    } catch (e) {
      // 세션 기록 실패는 무시
    }

    const videosCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ? AND c.content_type = 'video'
    `).get(nodeId).cnt;
    const problemsCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ? AND c.content_type IN ('quiz','exam','problem','assessment','question')
    `).get(nodeId).cnt;

    res.json({
      success: true,
      status: finalStatus,
      videos_count: videosCount,
      problems_count: problemsCount
    });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/diagnose-complete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/start — 진단 시작 (CAT: targetNodeId 있으면 BFS+난이도 조절 모드)
// GET /diagnosis/history
//   ?nodeId=...              → 본인의 해당 노드 진단 이력 (최근 5건 + 가장 최근 완료 결과) — 기존 호환
//   ?all=1[&subject=&grade=] → 본인의 최근 진단 10건 (학생 친화 결과 화면용, B4)
router.get('/diagnosis/history', requireAuth, (req, res) => {
  try {
    const nodeId = req.query.nodeId;
    const allMode = String(req.query.all || '') === '1'
      || !!req.query.subject || !!req.query.grade;

    // B4: ?all=1 (또는 subject/grade) — 사용자의 최근 진단 10건 + 한글 라벨 + 상대시간
    if (allMode) {
      const list = selfLearnDb.listDiagnosisHistory(req.user.id, {
        subject: req.query.subject || null,
        grade: req.query.grade ? Number(req.query.grade) : null,
        limit: req.query.limit ? Number(req.query.limit) : 10
      });
      return res.json({ success: true, history: list });
    }

    // 기존 호환: nodeId 단일 노드 이력
    if (!nodeId) return res.status(400).json({ success: false, message: 'nodeId 또는 all=1 필요' });
    const db = require('../db');
    const recent = db.prepare(`
      SELECT id, target_node_id, status, total_questions, correct_count,
             started_at, completed_at, result, diagnosis_type
      FROM diagnosis_sessions
      WHERE user_id = ? AND target_node_id = ?
      ORDER BY id DESC LIMIT 5
    `).all(req.user.id, nodeId);
    const lastCompleted = recent.find(r => r.status === 'completed');
    const lastInProgress = recent.find(r => r.status === 'in_progress');
    res.json({
      success: true,
      sessions: recent,
      lastCompleted: lastCompleted || null,
      lastInProgress: lastInProgress || null,
      hasAnyHistory: recent.length > 0,
      hasCompleted: !!lastCompleted
    });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/history error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/diagnosis/start', requireAuth, (req, res) => {
  try {
    // 전 역할 허용: 모든 인증 사용자가 자기 user.id로 진단을 수행한다.
    // (비학생 진단 기록은 학생 통계 집계 쿼리의 role='student' 필터로 격리됨)
    const { targetNodeId, nodeId, mode } = req.body || {};
    // targetNodeId 또는 mode='cat'일 경우 CAT 시작
    if (targetNodeId || mode === 'cat') {
      const result = selfLearnDb.startDiagnosisCAT(req.user.id, { ...req.body, targetNodeId: targetNodeId || nodeId });
      return res.json({ success: true, ...result });
    }
    const result = selfLearnDb.startDiagnosis(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/start error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/:sessionId/answer — 진단 문항 응답 (CAT 지원)
router.post('/diagnosis/:sessionId/answer', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const session = require('../db/index').prepare('SELECT diagnosis_type FROM diagnosis_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    }
    if (session.diagnosis_type === 'cat') {
      const result = selfLearnDb.submitDiagnosisAnswerCAT(sessionId, req.body || {});
      return res.json({ success: true, ...result });
    }
    const result = selfLearnDb.submitDiagnosisAnswer(sessionId, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/answer error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '진단 응답 처리 중 오류가 발생했습니다.',
      detail: String(err && err.message || err)
    });
  }
});

// GET /diagnosis/:sessionId/next — 다음 문항 1개 반환
router.get('/diagnosis/:sessionId/next', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const result = selfLearnDb.getNextDiagnosisQuestion(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '세션 없음' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/next error:', err);
    res.status(500).json({ success: false, message: '서버 오류', detail: String(err && err.message || err) });
  }
});

// POST /diagnosis/:sessionId/drill-down — 실패 노드의 선수노드를 큐에 추가 (CAT)
router.post('/diagnosis/:sessionId/drill-down', requireAuth, (req, res) => {
  try {
    const { failedNodeId } = req.body || {};
    const result = selfLearnDb.drillDownDiagnosis(parseInt(req.params.sessionId), failedNodeId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/drill-down error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({ success: false, message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// POST /diagnosis/:sessionId/submit-sheet — 진단지(시트) 단위 일괄 응답 (v2 신규)
//   body: { answers: [{ questionId, lessonId, userAnswer, contentId? }, ...] }
//   응답: { nodePassed, correctRate, results, nextAction, sheet(자동 다음 단원), recommendActions, queueRemainingHydrated, ... }
router.post('/diagnosis/:sessionId/submit-sheet', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const session = require('../db/index').prepare(
      'SELECT user_id FROM diagnosis_sessions WHERE id = ?'
    ).get(sessionId);
    if (!session) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '본인 세션이 아닙니다.' });
    }
    const result = selfLearnDb.submitDiagnosisSheet(sessionId, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/submit-sheet error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '진단지 제출 처리 중 오류가 발생했습니다.',
      detail: String(err && err.message || err)
    });
  }
});

// POST /diagnosis/:sessionId/retry-node — 현재 노드를 새 진단지로 다시 진단 (v2 신규)
//   응답: { currentNodeId, sheet, sheetSize, queueRemainingHydrated, queueOrderHydrated }
router.post('/diagnosis/:sessionId/retry-node', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const session = require('../db/index').prepare(
      'SELECT user_id FROM diagnosis_sessions WHERE id = ?'
    ).get(sessionId);
    if (!session) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '본인 세션이 아닙니다.' });
    }
    const result = selfLearnDb.retryDiagnosisNode(sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/retry-node error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '재진단 처리 중 오류가 발생했습니다.',
      detail: String(err && err.message || err)
    });
  }
});

// GET /diagnosis/:sessionId/state — 현재 세션 상태 조회
router.get('/diagnosis/:sessionId/state', requireAuth, (req, res) => {
  try {
    const state = selfLearnDb.getDiagnosisState(parseInt(req.params.sessionId));
    if (!state) return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/state error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/:sessionId/finish — 진단 완료
//   v2: body로 endReason ('user_decided_to_learn' 등) 받아 difficulty_path 마지막 항목에 보존
router.post('/diagnosis/:sessionId/finish', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const endReason = (req.body && req.body.endReason) || null;
    if (endReason) {
      // difficulty_path JSON 끝에 종료 사유 메타 추가 (마이그레이션 없이 보존)
      try {
        const mainDb = require('../db/index');
        const row = mainDb.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sessionId);
        if (row) {
          let path = [];
          try { path = JSON.parse(row.difficulty_path || '[]'); } catch {}
          path.push({ _endReason: endReason, _at: new Date().toISOString() });
          mainDb.prepare('UPDATE diagnosis_sessions SET difficulty_path = ? WHERE id = ?')
            .run(JSON.stringify(path), sessionId);
        }
      } catch (e) { console.error('[diagnosis/finish] endReason 저장 실패', e.message); }
    }
    const result = selfLearnDb.finishDiagnosis(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    if (endReason) result.endReason = endReason;
    // xAPI: 진단평가 완료 → assessment(submitted) + assessment-type='D'
    try {
      const mainDb = require('../db');
      const sess = mainDb.prepare(`
        SELECT ds.id, ds.user_id, ds.target_node_id, ds.total_questions, ds.correct_count, ds.started_at, ds.completed_at,
               lmn.lesson_name, lmn.unit_name, lmn.subject, lmn.grade
        FROM diagnosis_sessions ds
        LEFT JOIN learning_map_nodes lmn ON lmn.node_id = ds.target_node_id
        WHERE ds.id = ?
      `).get(sessionId);
      if (sess) {
        const stdCtx = _nodeStdContext(sess.target_node_id);
        const total = sess.total_questions || result.totalQuestions || 0;
        const correct = sess.correct_count || result.correctCount || 0;
        // 시작/종료 시간 차이로 duration 산정 (없으면 0)
        let durationSec = 0;
        try {
          if (sess.started_at) {
            const start = new Date(sess.started_at).getTime();
            const end = sess.completed_at ? new Date(sess.completed_at).getTime() : Date.now();
            durationSec = Math.max(0, Math.round((end - start) / 1000));
          }
        } catch {}
        xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
          verb: 'submitted',
          assessment_id: sessionId,
          assessment_type: 'diagnostic',  // → 'D'
          title: '진단평가' + (sess.lesson_name ? ` — ${sess.lesson_name}` : ''),
          total_score: correct,
          max_score: total,
          duration_seconds: durationSec,
          curriculum_standard_ids: sess.target_node_id || stdCtx.curriculum_standard_ids || null,
          subject_code: stdCtx.subject_code || null,
          grade_group: stdCtx.grade_group || null,
          school_level: stdCtx.school_level || null,
        });
      }
    } catch (e) { console.error('[xapi:diagnosis_finish]', e.message); }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /diagnosis/:sessionId/result — 진단 결과
router.get('/diagnosis/:sessionId/result', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getDiagnosisResult(parseInt(req.params.sessionId));
    if (!result) return res.status(404).json({ success: false, message: '진단 결과를 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ============================================================
// 진단검사 v3 — 개념(차시) 단위 순차 진단 (기획서 진단검사_v3_기획서.md §7 API 계약)
// ============================================================
// 드릴다운 라우트(/diagnosis/units 등)는 단일 세그먼트라 /diagnosis/:sessionId/* 와 충돌 없음.
// v3 세션 라우트는 별도 prefix(/diagnosis/v3/:sessionId/*)로 분리하여 v2 경로와 명확히 구분.

// GET /diagnosis/grades?schoolLevel=초 — 학교급의 학년 목록 (수학, 단원 ≥1)
router.get('/diagnosis/grades', requireAuth, (req, res) => {
  try {
    const grades = selfLearnDb.getV3Grades(req.query.schoolLevel);
    res.json({ success: true, grades });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/grades error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /diagnosis/areas?schoolLevel=초&grade=4 — 학년의 영역 목록 (단원 ≥1)
router.get('/diagnosis/areas', requireAuth, (req, res) => {
  try {
    const areas = selfLearnDb.getV3Areas(req.query.schoolLevel, req.query.grade);
    res.json({ success: true, areas });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/areas error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /diagnosis/units?schoolLevel=초&grade=4&subject=수학&area=수와 연산 — 진단할 단원 목록 + 상태
router.get('/diagnosis/units', requireAuth, (req, res) => {
  try {
    const units = selfLearnDb.getV3Units(req.user.id, {
      schoolLevel: req.query.schoolLevel,
      grade: req.query.grade,
      area: req.query.area
    });
    res.json({ success: true, units });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/units error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /diagnosis/v3/active — 진행중(in_progress) v3 세션 1건 (FE "이어서 풀기" 배너 복원용)
//   주의: /diagnosis/v3/:sessionId/* 파라미터 라우트보다 먼저 선언해야 'active'가 sessionId로 잡히지 않음.
router.get('/diagnosis/v3/active', requireAuth, (req, res) => {
  try {
    // 전 역할 허용: 자기 user.id의 진행중 v3 세션을 반환 (이어풀기 배너 복원)
    const active = selfLearnDb.getActiveDiagnosisV3(req.user.id);
    res.json({ success: true, active: active || null });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/active error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/v3/start — v3 진단 세션 시작 (단원 첫 개념 첫 문항)
router.post('/diagnosis/v3/start', requireAuth, (req, res) => {
  try {
    // 전 역할 허용: 모든 인증 사용자가 자기 user.id로 v3 진단을 시작한다.
    // (단원 노드 기반이라 학년 정보가 없어도 동작; 비학생 기록은 학생 통계에서 격리)
    const result = selfLearnDb.startDiagnosisV3(req.user.id, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/start error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({ success: false, message: err && err.message || '서버 오류가 발생했습니다.' });
  }
});

// v3 세션 본인 소유 확인 헬퍼
function _v3OwnSession(req, res) {
  const sessionId = parseInt(req.params.sessionId);
  if (!Number.isFinite(sessionId)) { res.status(400).json({ success: false, message: 'sessionId 형식 오류' }); return null; }
  const sess = require('../db/index').prepare('SELECT user_id FROM diagnosis_sessions WHERE id = ?').get(sessionId);
  if (!sess) { res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' }); return null; }
  if (sess.user_id !== req.user.id && req.user.role !== 'admin') { res.status(403).json({ success: false, message: '본인 세션이 아닙니다.' }); return null; }
  return sessionId;
}

// GET /diagnosis/v3/:sessionId/next — 다음 문항 1개 (정답 비노출)
router.get('/diagnosis/v3/:sessionId/next', requireAuth, (req, res) => {
  try {
    const sessionId = _v3OwnSession(req, res); if (sessionId == null) return;
    const result = selfLearnDb.getNextDiagnosisV3(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '세션 없음' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/next error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({ success: false, message: err && err.message || '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/v3/:sessionId/answer — 채점(서버) + 2-strike + 이동 결정 (정답 비노출)
router.post('/diagnosis/v3/:sessionId/answer', requireAuth, (req, res) => {
  try {
    const sessionId = _v3OwnSession(req, res); if (sessionId == null) return;
    const result = selfLearnDb.submitDiagnosisV3(sessionId, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/answer error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({ success: false, message: status === 400 ? '필수 파라미터가 누락되었습니다.' : (err && err.message || '진단 응답 처리 중 오류가 발생했습니다.'), detail: String(err && err.message || err) });
  }
});

// POST /diagnosis/v3/:sessionId/advance — 분기 모달 선택 확정 (후속 단원/하향 선수/종료)
router.post('/diagnosis/v3/:sessionId/advance', requireAuth, (req, res) => {
  try {
    const sessionId = _v3OwnSession(req, res); if (sessionId == null) return;
    const result = selfLearnDb.advanceDiagnosisV3(sessionId, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/advance error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({ success: false, message: err && err.message || '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/v3/:sessionId/finish — v3 완료
router.post('/diagnosis/v3/:sessionId/finish', requireAuth, (req, res) => {
  try {
    const sessionId = _v3OwnSession(req, res); if (sessionId == null) return;
    const result = selfLearnDb.finishDiagnosisV3(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/finish error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /diagnosis/v3/:sessionId/result — v3 결과 (수준·시작점·단원 현황)
router.get('/diagnosis/v3/:sessionId/result', requireAuth, (req, res) => {
  try {
    const sessionId = _v3OwnSession(req, res); if (sessionId == null) return;
    const result = selfLearnDb.getDiagnosisResultV3(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '진단 결과를 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/v3/result error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ============================================================
// 추천학습 경로 시스템 (2026-05-27 설계서 §4)
// ============================================================

// GET /recommended-paths — 사용자별 추천 경로 목록 (날짜 desc)
router.get('/recommended-paths', requireAuth, (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 10;
    const status = req.query.status || 'active';
    const paths = selfLearnDb.listRecommendedPaths(req.user.id, { limit, status });
    res.json({ success: true, paths });
  } catch (err) {
    console.error('[SELF-LEARN] recommended-paths list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /recommended-paths/current — 최신 완료 진단 세션의 학습 경로 (학습경로 탭 정본)
//   ⚠ 라우트 순서: 반드시 '/:sessionId'보다 위에 두어 'current'가 sessionId로 매칭되지 않게 한다.
router.get('/recommended-paths/current', requireAuth, (req, res) => {
  try {
    const data = selfLearnDb.getRecommendedPathCurrent(req.user.id);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[SELF-LEARN] recommended-paths current error:', err);
    // 빈 상태로 안전 반환 (탭이 오류 화면 대신 빈 상태를 그릴 수 있게)
    res.json({ success: true, hasDiagnosis: false, groups: [] });
  }
});

// GET /recommended-paths/:sessionId — 특정 진단 세션의 학습 경로 상세
router.get('/recommended-paths/:sessionId', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ success: false, message: '잘못된 세션 ID입니다.' });
    const data = selfLearnDb.getRecommendedPathBySession(sessionId, req.user.id);
    if (!data) return res.status(404).json({ success: false, message: '추천 경로를 찾을 수 없습니다.' });
    res.json({ success: true, ...data });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 403) return res.status(403).json({ success: false, message: '다른 사용자의 추천 경로는 볼 수 없어요.' });
    console.error('[SELF-LEARN] recommended-paths detail error:', err);
    res.status(code).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /recommended-paths/:sessionId/progress — 특정 노드 진행 상태 갱신
router.post('/recommended-paths/:sessionId/progress', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const nodeId = req.body && req.body.nodeId;
    if (!sessionId || !nodeId) {
      return res.status(400).json({ success: false, message: 'sessionId와 nodeId가 필요합니다.' });
    }
    const result = selfLearnDb.updateRecommendedPathProgress(sessionId, req.user.id, nodeId);
    res.json({ success: true, ...result });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 403) return res.status(403).json({ success: false, message: '권한이 없어요.' });
    if (code === 404) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없어요.' });
    if (code === 400) return res.status(400).json({ success: false, message: err.message || '잘못된 요청입니다.' });
    console.error('[SELF-LEARN] recommended-paths progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /recommended-paths/:sessionId/add-to-learning-list — 경로 전체 학습목록 일괄 추가
router.post('/recommended-paths/:sessionId/add-to-learning-list', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ success: false, message: '잘못된 세션 ID입니다.' });
    const result = selfLearnDb.addRecommendedPathToLearningList(sessionId, req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 403) return res.status(403).json({ success: false, message: '권한이 없어요.' });
    if (code === 404) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없어요.' });
    console.error('[SELF-LEARN] recommended-paths add-list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /path/generate — 학습 경로 생성
router.post('/path/generate', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.generateLearningPath(req.user.id, req.body || {});
    // path 배열을 최상위 필드로도 노출 (프론트 호환: data.path)
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] path/generate error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// GET /path/current — 현재 학습 경로
router.get('/path/current', requireAuth, (req, res) => {
  try {
    const path = selfLearnDb.getCurrentPath(req.user.id);
    // 프론트 호환: data.path 를 steps 배열로도 제공
    res.json({ success: true, path: path ? path.steps : null, raw: path });
  } catch (err) {
    console.error('[SELF-LEARN] path/current error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /node/:nodeId/complete — 노드 학습 완료
router.post('/node/:nodeId/complete', requireAuth, (req, res) => {
  try {
    selfLearnDb.completeNode(req.user.id, req.params.nodeId);
    res.json({ success: true, message: '학습 노드를 완료했습니다!' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /dashboard — 학습 대시보드
// 빈 상태/null KPI 정규화: 프론트가 "—" 대신 "0개/0%/0분/-위" 친화 표기로 분기 가능
router.get('/dashboard', requireAuth, (req, res) => {
  try {
    const d = selfLearnDb.getLearningDashboard(req.user.id) || {};
    const totalSolved = d.total_solved || 0;
    const totalUsers = d.total_users || 0;
    const safe = {
      ...d,
      // 숫자 필드 null → 0 정규화
      totalNodes: d.totalNodes || 0,
      completedNodes: d.completedNodes || 0,
      inProgressNodes: d.inProgressNodes || 0,
      total_solved: totalSolved,
      total_attempts: d.total_attempts || totalSolved,
      avg_accuracy: d.avg_accuracy || 0,
      progress_percent: d.progress_percent || 0,
      progressPercent: d.progressPercent || 0,
      streak: d.streak || 0,
      total_time_minutes: d.total_time_minutes || 0,
      // rank는 의미상 null 유지 (미정의), 표시용 텍스트 별도 제공
      rank: d.rank ?? null,
      rank_display: d.rank ? `${d.rank}위` : '아직 순위 없음',
      total_users: totalUsers,
      area_stats: d.area_stats || [],
      recent_problems: d.recent_problems || [],
      // 빈 상태 분기 메타 (프론트에서 "—" 대신 안내 메시지 분기)
      has_attempts: totalSolved > 0,
      has_video_watched: (d.total_time_minutes || 0) > 0,
      has_completed_nodes: (d.completedNodes || 0) > 0,
      has_ranking_data: totalUsers >= 2,
      empty_message: totalSolved === 0
        ? '아직 학습 활동이 없어요. 첫 문제를 풀어보세요!'
        : null
    };
    res.json({ success: true, ...safe });
  } catch (err) {
    console.error('[SELF-LEARN] dashboard error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /ranking — 랭킹
// 빈 결과 시 명확한 안내 메시지 + 본인 순위(myRank) 함께 반환
router.get('/ranking', requireAuth, (req, res) => {
  try {
    const rankings = selfLearnDb.getRanking(req.query) || [];
    const myIndex = rankings.findIndex(r => r.id === req.user.id);
    const myRank = myIndex >= 0 ? myIndex + 1 : null;
    const total = rankings.length;
    let message = null;
    if (total === 0) message = '아직 랭킹 데이터가 없어요. 첫 학습을 시작해보세요!';
    else if (total === 1) message = '함께 학습하는 친구가 더 생기면 랭킹이 풍부해져요!';
    res.json({
      success: true,
      rankings,
      total,
      myRank,
      myRank_display: myRank ? `${myRank}위` : '아직 순위 없음',
      period: req.query.period || 'all',
      empty: total === 0,
      message
    });
  } catch (err) {
    console.error('[SELF-LEARN] ranking error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 오답노트 확장 ==========

// GET /wrong-notes — 오답 목록
router.get('/wrong-notes', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getWrongNotesExtended(req.user.id, req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /wrong-notes/dashboard — 오답 대시보드
router.get('/wrong-notes/dashboard', requireAuth, (req, res) => {
  try {
    const dashboard = selfLearnDb.getWrongNoteDashboard(req.user.id);
    res.json({ success: true, ...dashboard });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /wrong-notes/teacher-dashboard — [교사] 교사용 오답 대시보드
router.get('/wrong-notes/teacher-dashboard', requireAuth, (req, res) => {
  try {
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    const dashboard = selfLearnDb.getTeacherWrongNoteDashboard(classId, req.user.id);
    res.json({ success: true, ...dashboard });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /wrong-notes/manual — 수동 오답 등록
router.post('/wrong-notes/manual', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.addManualWrongNote(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /wrong-notes/:id/tags — 오답 태그 수정
router.put('/wrong-notes/:id/tags', requireAuth, (req, res) => {
  try {
    selfLearnDb.updateWrongNoteTags(parseInt(req.params.id), req.user.id, req.body.tags);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /wrong-notes/by-exam/:examId/questions — [묶음] 같은 평가지 미해결 오답 일괄 복구 (정답 미포함)
//   ⚠ '/:id/...' 보다 먼저 선언해야 'by-exam' 이 :id 로 캡처되지 않는다.
router.get('/wrong-notes/by-exam/:examId/questions', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getWrongNotesByExam(req.params.examId, req.user.id);
    if (!result) return res.status(404).json({ success: false, message: '해당 평가지의 미해결 오답이 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] wrong-notes by-exam error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /wrong-notes/retry-batch — [묶음] 평가지 오답 일괄 채점 (서버 채점)
router.post('/wrong-notes/retry-batch', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.retryWrongNoteBatch(req.user.id, req.body && req.body.items);
    // xAPI: 묶음 채점 1건 요약 기록
    try {
      xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
        verb: 'submitted',
        assessment_id: 0,
        title: '오답 평가지 묶음 재도전',
        assessment_type: 'self_check',
        target_kind: 'quiz',
        score: { raw: result.score, max: result.total },
        success: result.total > 0 && result.score === result.total,
        source: 'wrong_note_retry_batch',
      });
    } catch (_) {}
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] wrong-notes retry-batch error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /wrong-notes/:id/question — 단일 오답 원본 문항 복구 (풀이용, 정답·해설 미포함)
router.get('/wrong-notes/:id/question', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getWrongNoteQuestion(parseInt(req.params.id), req.user.id);
    if (!result) return res.status(404).json({ success: false, message: '오답을 찾을 수 없습니다.' });
    if (result.forbidden) return res.status(403).json({ success: false, message: '본인의 오답만 풀 수 있습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] wrong-note question error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /wrong-notes/:id/retry — 오답 재도전 (서버 채점, 정규화)
router.post('/wrong-notes/:id/retry', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.retryWrongNote(parseInt(req.params.id), req.user.id, req.body);
    if (!result) return res.status(404).json({ success: false, message: '오답을 찾을 수 없습니다.' });
    if (result.forbidden) return res.status(403).json({ success: false, message: '본인의 오답만 풀 수 있습니다.' });
    // xAPI: 오답 재도전 annotation.annotated + assessment.submitted (서버 채점 결과 사용)
    try {
      const correct = result.is_correct ? 1 : 0;
      xapiSpool.record('annotation', buildAnnotation, { userId: req.user.id }, {
        verb: 'annotated',
        annotation_id: parseInt(req.params.id),
        target_type: 'wrong_note',
        target_id: parseInt(req.params.id),
        annotation_kind: 'retry',
        response: req.body && (req.body.note || req.body.answer) || null,
      });
      xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
        verb: 'submitted',
        assessment_id: parseInt(req.params.id),
        title: '오답 재도전',
        assessment_type: 'self_check',
        target_kind: 'quiz',
        score: { raw: correct, max: 1 },
        success: !!correct,
        source: 'wrong_note_retry',
      });
    } catch (_) {}
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] wrong-note retry error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 나만의 문제집 ==========

// GET /problem-sets — 문제집 목록
router.get('/problem-sets', requireAuth, (req, res) => {
  try {
    const sets = selfLearnDb.getProblemSets(req.user.id);
    res.json({ success: true, sets });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets — 문제집 생성
router.post('/problem-sets', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.createProblemSet(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /problem-sets/:id — 문제집 상세
router.get('/problem-sets/:id', requireAuth, (req, res) => {
  try {
    const detail = selfLearnDb.getProblemSetDetail(parseInt(req.params.id), req.user.id);
    if (!detail) return res.status(404).json({ success: false, message: '문제집을 찾을 수 없습니다.' });
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/default/add — "기타(미지정)" 문제집에 자동 추가 (없으면 생성)
router.post('/problem-sets/default/add', requireAuth, (req, res) => {
  try {
    const DEFAULT_TITLE = '기타(미지정)';
    const contentId = parseInt(req.body.contentId);
    if (!contentId) return res.status(400).json({ success: false, message: 'contentId가 필요합니다.' });
    // 🔴 자기부여(self-grant) 차단 — 아래 guardAttemptContent 주석 참조.
    if (!guardAttemptContent(req, res, contentId)) return;
    const sets = selfLearnDb.getProblemSets(req.user.id);
    let target = sets.find(s => s.title === DEFAULT_TITLE);
    if (!target) {
      const created = selfLearnDb.createProblemSet(req.user.id, { title: DEFAULT_TITLE, description: '바로 풀기로 자동 추가된 문항 모음' });
      target = { id: created.id, title: DEFAULT_TITLE };
    }
    const addResult = selfLearnDb.addProblemSetItem(target.id, contentId);
    // 이미 있었으면 addResult.success === false 지만 오류는 아님
    res.json({ success: true, problemSetId: target.id, added: addResult.success === true, alreadyExists: addResult.success === false });
  } catch (err) {
    console.error('default add error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// POST /problem-sets/:id/items — 문제집에 문항 추가
router.post('/problem-sets/:id/items', requireAuth, (req, res) => {
  try {
    // 🔴 자기부여(self-grant) 차단 — 아래 guardAttemptContent 주석 참조.
    if (!guardAttemptContent(req, res, req.body && req.body.contentId)) return;
    const result = selfLearnDb.addProblemSetItem(parseInt(req.params.id), req.body.contentId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /problem-sets/:id/items/:itemId — 문제집에서 문항 제거
router.delete('/problem-sets/:id/items/:itemId', requireAuth, (req, res) => {
  try {
    selfLearnDb.removeProblemSetItem(parseInt(req.params.id), parseInt(req.params.itemId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/:id/start — 문제집 풀기 시작
router.post('/problem-sets/:id/start', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.startProblemSet(parseInt(req.params.id), req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/:id/submit — 문제집 제출
router.post('/problem-sets/:id/submit', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.submitProblemSet(parseInt(req.params.id), req.user.id, req.body);
    // xAPI: 나의 문제집 제출 assessment.submitted
    try {
      const raw = (result && (result.correct_count || 0)) || 0;
      const max = (result && (result.total_questions || 0)) || 0;
      xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
        verb: 'submitted',
        assessment_id: parseInt(req.params.id),
        title: (result && result.title) || '나의 문제집',
        assessment_type: 'self_check',
        target_kind: 'quiz',
        score: { raw, max },
        success: max > 0 && (raw / max) >= 0.6,
        source: 'my_problem_set',
      });
    } catch (_) {}
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/:id/reorder — 문제집 아이템 순서 변경
router.post('/problem-sets/:id/reorder', requireAuth, (req, res) => {
  try {
    const db = require('../db');
    const { order } = req.body; // [{id, sort_order}]
    if (Array.isArray(order)) {
      const stmt = db.prepare('UPDATE problem_set_items SET sort_order = ? WHERE id = ? AND problem_set_id = ?');
      order.forEach(o => stmt.run(o.sort_order, o.id, parseInt(req.params.id)));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ========== P0: 문제 시도 / 영상 진행도 / 학습목록 / 이어하기 / 오류신고 ==========

// POST /problem-attempt — 문제 풀이 시도 기록 (별칭, body에 contentId 포함)
router.post('/problem-attempt', requireAuth, (req, res) => {
  try {
    // 전 역할 허용: 모든 인증 사용자가 자기 user.id로 문제 풀이를 기록한다.
    // (비학생 기록은 학생 통계 집계 쿼리의 role='student' 필터로 격리됨)
    const { contentId, content_id, isCorrect, is_correct, selectedAnswer, userAnswer, user_answer, answer, answerIndex, answer_index, questionId, question_id, timeTaken, time_taken, nodeId, node_id } = req.body || {};
    // ★ 식별자 정규화 SSOT — parseInt 는 "5.9e1"→5 처럼 관대해 게이트와 쿼리가 갈린다.
    const cid = normalizeId(contentId ?? content_id);
    if (!cid) return res.status(400).json({ success: false, message: 'contentId 필요' });
    // ★ 콘텐츠 열람 권한 게이트 — 정답·해설 조회 우회 금지(POST /api/contents/:id/grade 와 동일 판정)
    if (!guardAttemptContent(req, res, cid)) return;
    // ★ 게이트를 통과한 콘텐츠를 방패 삼아 남의 문항 정답을 뽑는 교차 주입도 함께 막는다.
    //   반환된 **정규화 값(qid)** 을 그대로 채점기에 넘긴다 — 원본 문자열을 다시 넘기면
    //   SQLite 코어션이 재개입해 게이트가 승인한 문항과 다른 행이 조회된다(2026-08-07 P0).
    const qid = guardQuestionBelongsToContent(req, res, cid, questionId ?? question_id);
    if (qid === false) return;
    const result = selfLearnDb.recordProblemAttempt(req.user.id, cid, {
      isCorrect: !!(isCorrect ?? is_correct),
      selectedAnswer: selectedAnswer ?? user_answer ?? userAnswer,
      userAnswer: userAnswer ?? user_answer,
      answer,
      answerIndex: answerIndex != null ? answerIndex : answer_index,
      questionId: qid,
      timeTaken: timeTaken || time_taken,
      nodeId: nodeId || node_id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] problem-attempt error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /video-progress — 영상 진행도 저장 (별칭, body에 contentId 포함)
router.post('/video-progress', requireAuth, (req, res) => {
  try {
    const { contentId, content_id, positionSec, position_sec, durationSec, duration_sec, nodeId, node_id } = req.body || {};
    const cid = parseInt(contentId || content_id);
    if (!cid) return res.status(400).json({ success: false, message: 'contentId 필요' });
    const result = selfLearnDb.recordVideoProgress(req.user.id, cid, {
      positionSec: parseInt(positionSec ?? position_sec) || 0,
      durationSec: parseInt(durationSec ?? duration_sec) || 0,
      nodeId: nodeId || node_id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] video-progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /contents/:contentId/attempt — 문제 풀이 시도 기록
router.post('/contents/:contentId/attempt', requireAuth, (req, res) => {
  try {
    const contentId = normalizeId(req.params.contentId);   // ★ 정규화 SSOT (lib/ids.js)
    const { isCorrect, selectedAnswer, userAnswer, answer, questionId, timeTaken, nodeId } = req.body || {};
    if (!contentId) return res.status(400).json({ success: false, message: 'contentId 필요' });
    // ★ /problem-attempt 와 같은 게이트 — 이 별칭 경로만 열려 있으면 우회로가 남는다.
    if (!guardAttemptContent(req, res, contentId)) return;
    const qid = guardQuestionBelongsToContent(req, res, contentId, questionId);
    if (qid === false) return;
    // 서버에서 서버 정답 판정 (questionId 있을 때) — 게이트가 승인한 **정규화 값**만 넘긴다.
    const result = selfLearnDb.recordProblemAttempt(req.user.id, contentId, {
      isCorrect: !!isCorrect,   // questionId 없을 때 호환성 fallback
      selectedAnswer, userAnswer, answer, questionId: qid, timeTaken, nodeId
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] contents/attempt error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// POST /contents/:contentId/video-progress — 비디오 시청 진행도 저장
router.post('/contents/:contentId/video-progress', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.contentId);
    const { positionSec, durationSec, nodeId } = req.body || {};
    const result = selfLearnDb.recordVideoProgress(req.user.id, contentId, {
      positionSec: parseInt(positionSec) || 0,
      durationSec: parseInt(durationSec) || 0,
      nodeId
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] contents/video-progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /contents/:contentId/report — 콘텐츠 오류 신고
router.post('/contents/:contentId/report', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.contentId);
    const { reason, details, contentType } = req.body || {};
    const result = selfLearnDb.reportContent(req.user.id, contentId, { reason, details, contentType });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] contents/report error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /learning-list — 내 학습목록(watch list)
router.get('/learning-list', requireAuth, (req, res) => {
  try {
    const items = selfLearnDb.getLearningList(req.user.id);
    res.json({ success: true, items });
  } catch (err) {
    console.error('[SELF-LEARN] learning-list get error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /learning-list — 학습목록에 노드 추가
router.post('/learning-list', requireAuth, (req, res) => {
  try {
    const { nodeId } = req.body || {};
    if (!nodeId) return res.status(400).json({ success: false, message: 'nodeId 필요' });
    const result = selfLearnDb.addLearningList(req.user.id, nodeId);
    res.json(result);
  } catch (err) {
    console.error('[SELF-LEARN] learning-list add error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /learning-list/:nodeId — 학습목록에서 제거
router.delete('/learning-list/:nodeId', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.removeLearningList(req.user.id, req.params.nodeId);
    res.json(result);
  } catch (err) {
    console.error('[SELF-LEARN] learning-list remove error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /last-activity — 마지막 학습 활동(이어하기)
router.get('/last-activity', requireAuth, (req, res) => {
  try {
    const activity = selfLearnDb.getLastActivity(req.user.id);
    res.json({ success: true, activity });
  } catch (err) {
    console.error('[SELF-LEARN] last-activity error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
