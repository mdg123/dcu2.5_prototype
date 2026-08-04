// lib/auth/can-view-user.js
// ─────────────────────────────────────────────────────────────────────────────
// 학생 "단위" / 클래스 "단위" 열람 권한 판정 SSOT.
//
// ■ 유래 — W1(commit 3c08d2a, 2026-07-31)
//   routes/lrs.js 의 canViewUser 가 `본인 || role==='teacher' || role==='admin'` 이라
//   담임·소속 검증이 전무했다. 시스템의 아무 교사나(전혀 다른 학교 중학교 교사까지)
//   아무 학생의 학습·정서 데이터를 200 OK 로 열람할 수 있었다. W1 이 소속 검증을 도입해
//   학생 단위 15개 LRS 엔드포인트를 막았다.
//
// ■ 왜 이 파일로 옮겼나 — W3(2026-08-04)
//   전수 감사에서 **routes/growth.js 에 완전히 동일한 구멍 15곳**이 남아 있었다.
//   (`report/parent/:id` 는 검사 자체가 없어 아무 로그인 사용자나 남의 자녀 성장 리포트를
//    실명·정서 점수까지 200 으로 읽을 수 있었다. `emotion-monitor/:classId` 도 무검사라
//    학생이 학급 전체의 감정·자유서술 사유·"주의 필요 학생" 실명 목록을 읽었다.)
//   판정 로직을 routes/growth.js 에 복사하면 사이트별 사본이 되어 드리프트한다
//   (W1 이 lib/lrs/emotion-scale.js 에서 이미 같은 교훈을 박제했다).
//   그래서 **정책 실체를 이 파일 하나로 두고 lrs.js·growth.js 가 공유**한다.
//   ★ 새 권한 정책을 이 파일 밖에서 재정의하지 말 것.
//
// ■ 정책 (학생 단위 = canViewUser)
//     - 본인            → 허용
//     - admin           → 허용(전체 거버넌스, canViewClass 와 동일)
//     - teacher         → 그 학생이 "내가 교사-티어인 클래스"의 active 멤버일 때만 허용
//                         (교사-티어 = CLASS_TEACHER_ROLES — canViewClass 와 동일 집합)
//     - principal       → 자기 school_name 학교 소속일 때만 (middleware/auth 의
//                         requireSchoolScope "users.school_name 정확 일치" 스코프와 정합)
//     - 그 외(학생·학부모·staff) → 거부.
//       학부모는 관계 기반 전용 경로(LRS /parent/:childId/digest, growth /report/parent/:id)가
//       isParentOf() 로 parent_id 관계를 따로 검증하므로 여기서 거부해도 정상 동선은 유지된다.
//
// ■ 정책 (클래스 단위 = canViewClass) : admin || 그 클래스의 교사-티어 멤버.
//
// ■ 성능: 요청마다 도는 가드다. N+1 금지 — 클래스 목록을 뽑아 반복 검사하지 않고
//   **단일 EXISTS 쿼리 1회**로 판정하고, prepared statement 는 모듈 레벨에 캐시한다.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('../../db/index');
const classDb = require('../../db/class');

/** 클래스에서 "교사 티어"로 인정하는 멤버 role 집합. canViewUser·canViewClass 공용. */
const CLASS_TEACHER_ROLES = new Set(['owner', 'teacher', 'co_teacher']);

// prepared statement 캐시 (lazy — 모듈 로드 시점에 DB 가 준비 안 됐을 수 있다).
let _sharedClassStmt = null;
let _sameSchoolStmt = null;
let _parentStmt = null;

/**
 * 교사 ↔ 학생 소속 공유 판정 — "내가 교사-티어인 클래스에 그 학생이 active 멤버인가".
 *   owner_id 폴백 포함: 클래스 소유자인데 class_members 소유자 행이 유실된 경우에도
 *   자기 반 학생은 봐야 한다(과차단 방지). 어느 쪽이든 "내 클래스"라는 사실은 동일.
 *   ※ 클래스 status 는 필터하지 않는다 — canViewClass 와 동일 기준 유지(정책 발명 금지).
 * @returns {boolean}
 */
function teacherSharesClassWith(teacherId, studentId) {
  if (!_sharedClassStmt) {
    const ph = [...CLASS_TEACHER_ROLES].map(() => '?').join(',');
    _sharedClassStmt = db.prepare(`
      SELECT 1
      FROM class_members s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.user_id = ? AND s.status = 'active'
        AND (
          c.owner_id = ?
          OR EXISTS (
            SELECT 1 FROM class_members t
            WHERE t.class_id = s.class_id AND t.user_id = ?
              AND t.status = 'active' AND t.role IN (${ph})
          )
        )
      LIMIT 1
    `);
  }
  try {
    return !!_sharedClassStmt.get(studentId, teacherId, teacherId, ...CLASS_TEACHER_ROLES);
  } catch (_) { return false; }
}

/** principal 스코프 판정 — 대상이 자기 school_name 학교 소속인가(정확 일치). */
function principalSameSchool(user, targetUserId) {
  const school = user && user.school_name ? String(user.school_name).trim() : '';
  if (!school) return false;
  if (!_sameSchoolStmt) {
    _sameSchoolStmt = db.prepare(
      "SELECT 1 FROM users WHERE id = ? AND TRIM(COALESCE(school_name,'')) = ? LIMIT 1"
    );
  }
  try {
    return !!_sameSchoolStmt.get(targetUserId, school);
  } catch (_) { return false; }
}

/**
 * 학부모 ↔ 자녀 관계 판정 (users.parent_id). 학부모 전용 경로에서만 쓴다.
 *   canViewUser 는 학부모를 거부하므로, 학부모 동선은 이 관계 검증을 명시적으로 통과해야 한다.
 *   (LRS /parent/:childId/digest 와 동일한 기준 — 정책 재발명 아님.)
 */
function isParentOf(parentUserId, studentId) {
  if (!Number.isFinite(parentUserId) || !Number.isFinite(studentId)) return false;
  if (!_parentStmt) {
    _parentStmt = db.prepare("SELECT 1 FROM users WHERE id = ? AND parent_id = ? LIMIT 1");
  }
  try {
    return !!_parentStmt.get(studentId, parentUserId);
  } catch (_) { return false; }
}

/** 역할 가드(학생 단위): 본인 / admin / 담당 교사(소속 검증) / principal(자기 학교)만 허용 */
function canViewUser(req, targetUserId) {
  if (!req || !req.user) return false;
  if (!Number.isFinite(targetUserId)) return false;   // NaN/undefined id → 거부(무조건 열림 방지)
  if (req.user.id === targetUserId) return true;
  const role = req.user.role;
  if (role === 'admin') return true;
  if (role === 'teacher') return teacherSharesClassWith(req.user.id, targetUserId);
  if (role === 'principal') return principalSameSchool(req.user, targetUserId);
  return false;
}

/** 역할 가드(클래스 단위): admin / 그 클래스의 교사-티어 멤버만 허용 */
function canViewClass(req, classId) {
  if (!req || !req.user) return false;
  if (!Number.isFinite(classId)) return false;
  if (req.user.role === 'admin') return true;
  try {
    const role = classDb.getMemberRole(classId, req.user.id);
    if (CLASS_TEACHER_ROLES.has(role)) return true;
  } catch (_) {}
  return false;
}

module.exports = {
  CLASS_TEACHER_ROLES,
  canViewUser,
  canViewClass,
  teacherSharesClassWith,
  principalSameSchool,
  isParentOf,
};
