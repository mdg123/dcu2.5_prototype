// lib/auth/can-view-content.js
// ─────────────────────────────────────────────────────────────────────────────
// 콘텐츠 "단건 열람" 권한 판정 SSOT.
//
// ■ 유래 — P0-2 (2026-08-05 실서버 실측)
//   routes/content.js 의 `GET /api/contents/:id` 가 getContentById 결과를
//   is_public / status / creator_id 검사 없이 그대로 반환했다.
//     GET /api/contents/3797 → 200 | status=draft    is_public=0 creator=2 (teacher1)
//     GET /api/contents/3801 → 200 | status=approved is_public=0 creator=2
//     GET /api/contents/3129 → 200 | status=rejected is_public=1 creator=1
//   목록 API(searchPublicContents)에만 `is_public=1 AND status='approved'` 가 있어
//   **"목록에서 가리기"만 되고 "직접 접근 막기"가 없었다.**
//   문항/평가지 콘텐츠는 getContentById 가 questions 를 붙여 주므로 승인 전(pending)
//   문항의 `answer`·`explanation` 까지 학생에게 그대로 내려갔다(검수 전 정답 노출).
//
// ■ 왜 lib/ 인가
//   판정을 routes/content.js 안에 적으면 파일 서빙 가드(lib/uploads-access.js)가
//   같은 판정을 "또" 복사해야 한다. W1/W3 이 이미 같은 실수(판정 사본 드리프트)를
//   박제했다(lib/auth/can-view-user.js 주석 참조). 실체는 이 파일 하나.
//   ★ 콘텐츠 열람 정책을 이 파일 밖에서 재정의하지 말 것.
//
// ■ 정책
//   1) 공개 승인본(is_public=1 AND status='approved')  → 비로그인 포함 전원 허용
//      (비로그인 포털의 인기 콘텐츠·추천 카드가 이 부류다 — 과차단 절대 금지)
//   2) admin                                          → 허용(거버넌스·승인 심사)
//   3) 작성자 본인                                     → 허용
//   4) "이용 근거(usage grant)" 가 있는 사용자          → 허용
//        비공개 콘텐츠라도 실제 수업 동선에 편입돼 있으면 학생이 열어야 한다.
//        실측(정본 DB): lesson_contents 1건 · problem_set_items 3건 · package_items 4건 ·
//        content_collections 4건 이 "비공개인데 이미 연결된" 콘텐츠였다.
//        이 경로를 안 열면 수업/문제세트가 그 자리에서 깨진다(= 과차단).
//   5) 그 외                                           → 거부
//
//   ※ node_contents(AI 학습맵 매핑, 비공개 108건)는 **근거로 치지 않는다.**
//     학생용 학습맵 API(routes/self-learn.js)가 이미 `is_public=1 AND status='approved'`
//     로 걸러 노출하므로, 매핑 존재만으로 열어 주면 목록에 없는 것을 상세로 뚫게 된다.
//
// ■ 성능: 요청마다 도는 가드. 근거 검사는 EXISTS 5종을 **단일 쿼리 1회**로 묶고
//   prepared statement 를 모듈 레벨에 캐시한다(N+1 금지).
// ─────────────────────────────────────────────────────────────────────────────
const db = require('../../db/index');

let _grantStmt = null;
let _packageParentStmt = null;
let _shadowClassStmt = null;
let _contentStmt = null;

/** id → contents 행(권한 판정에 필요한 최소 컬럼만). */
function loadContentForAuth(contentId) {
  if (!Number.isFinite(contentId)) return null;
  if (!_contentStmt) {
    _contentStmt = db.prepare(
      'SELECT id, creator_id, is_public, status, content_type, source FROM contents WHERE id = ?'
    );
  }
  try { return _contentStmt.get(contentId) || null; } catch (_) { return null; }
}

/** 공개 승인본인가 — 비로그인에게도 열리는 유일한 부류. */
function isPubliclyApproved(content) {
  return !!content && Number(content.is_public) === 1 && content.status === 'approved';
}

/**
 * 이용 근거(usage grant) — 비공개 콘텐츠라도 이 사용자의 정상 학습 동선에 편입돼 있는가.
 *   · 수업에 연결됨      → 그 클래스의 active 멤버
 *   · 오늘의 학습에 편성 → 그 클래스의 active 멤버
 *   · 평가지 원본        → 그 평가가 열린 클래스의 active 멤버
 *   · 내 문제세트 항목   → 문제세트 소유자
 *   · 내 보관함          → 보관 당사자
 */
function hasDirectUsageGrant(userId, contentId) {
  if (!Number.isFinite(userId) || !Number.isFinite(contentId)) return false;
  if (!_grantStmt) {
    _grantStmt = db.prepare(`
      SELECT
        EXISTS(
          SELECT 1 FROM lesson_contents lc
          JOIN lessons l ON l.id = lc.lesson_id
          JOIN class_members m ON m.class_id = l.class_id AND m.user_id = @uid AND m.status = 'active'
          WHERE lc.content_id = @cid
        ) AS via_lesson,
        EXISTS(
          SELECT 1 FROM daily_learning_items di
          JOIN daily_learning_sets ds ON ds.id = di.set_id
          JOIN class_members m ON m.class_id = ds.class_id AND m.user_id = @uid AND m.status = 'active'
          WHERE di.content_id = @cid
        ) AS via_daily,
        EXISTS(
          SELECT 1 FROM exams e
          JOIN class_members m ON m.class_id = e.class_id AND m.user_id = @uid AND m.status = 'active'
          WHERE e.source_content_id = @cid
        ) AS via_exam,
        EXISTS(
          SELECT 1 FROM problem_set_items pi
          JOIN problem_sets ps ON ps.id = pi.problem_set_id
          WHERE pi.content_id = @cid AND ps.user_id = @uid
        ) AS via_pset,
        EXISTS(
          SELECT 1 FROM content_collections cc
          WHERE cc.content_id = @cid AND cc.user_id = @uid
        ) AS via_collection
    `);
  }
  try {
    const r = _grantStmt.get({ uid: userId, cid: contentId });
    return !!(r && (r.via_lesson || r.via_daily || r.via_exam || r.via_pset || r.via_collection));
  } catch (_) { return false; }
}

/**
 * 수업/평가 "그림자 콘텐츠" 근거.
 *   db/lesson.js·db/exam.js 가 수업·평가를 만들 때 contents 에 is_public=0, status='approved'
 *   미러 행을 만든다(source='lesson_<id>' / 'exam_<id>'). 정본 DB 의 `approved & is_public=0`
 *   13행이 그 흔적이다. 원본 수업·평가를 볼 수 있는 클래스 멤버에게는 미러도 열어 준다.
 */
function hasShadowGrant(userId, content) {
  const src = content && content.source ? String(content.source) : '';
  const m = /^(lesson|exam)_(\d+)$/.exec(src);
  if (!m) return false;
  if (!_shadowClassStmt) {
    _shadowClassStmt = {
      lesson: db.prepare(`
        SELECT 1 FROM lessons l
        JOIN class_members m ON m.class_id = l.class_id AND m.user_id = ? AND m.status = 'active'
        WHERE l.id = ? LIMIT 1
      `),
      exam: db.prepare(`
        SELECT 1 FROM exams e
        JOIN class_members m ON m.class_id = e.class_id AND m.user_id = ? AND m.status = 'active'
        WHERE e.id = ? LIMIT 1
      `),
    };
  }
  try { return !!_shadowClassStmt[m[1]].get(userId, parseInt(m[2], 10)); } catch (_) { return false; }
}

/**
 * 수업꾸러미(package/bundle) 근거 — 부모 꾸러미를 볼 수 있으면 그 안의 항목도 볼 수 있다.
 *   재귀 깊이는 2로 제한(꾸러미 안의 꾸러미까지). 순환 참조 시드가 있어도 무한루프 없음.
 */
function hasPackageGrant(user, contentId, depth) {
  if (depth <= 0) return false;
  if (!_packageParentStmt) {
    _packageParentStmt = db.prepare('SELECT package_id FROM package_items WHERE content_id = ? LIMIT 20');
  }
  let parents;
  try { parents = _packageParentStmt.all(contentId); } catch (_) { return false; }
  for (const p of parents || []) {
    const parent = loadContentForAuth(p.package_id);
    if (parent && canViewContent(user, parent, depth - 1)) return true;
  }
  return false;
}

/**
 * 콘텐츠 단건 열람 가능 여부.
 * @param {object|null} user  req.user (비로그인이면 null)
 * @param {object|number} content  contents 행 또는 id
 * @param {number} [depth=2]  꾸러미 재귀 깊이(내부용)
 * @returns {boolean}
 */
function canViewContent(user, content, depth = 2) {
  const c = (content && typeof content === 'object') ? content : loadContentForAuth(Number(content));
  if (!c) return false;
  if (isPubliclyApproved(c)) return true;         // 1) 공개 승인본 — 비로그인 포함
  if (!user) return false;                        //    그 외는 로그인 필수
  if (user.role === 'admin') return true;         // 2) 거버넌스
  const uid = Number(user.id);
  if (Number(c.creator_id) === uid) return true;  // 3) 작성자 본인
  if (hasDirectUsageGrant(uid, Number(c.id))) return true;   // 4) 이용 근거
  if (hasShadowGrant(uid, c)) return true;
  if (hasPackageGrant(user, Number(c.id), depth)) return true;
  return false;                                   // 5) 거부
}

module.exports = {
  canViewContent,
  isPubliclyApproved,
  loadContentForAuth,
};
