const authDb = require('../db/auth');
const db = require('../db/index');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = authDb.findUserById(req.session.userId);
    if (user) {
      req.user = user;
      return next();
    }
  }
  // req.originalUrl은 전체 URL을 포함 (라우터 마운트 기준 상대경로 문제 방지)
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  res.redirect('/login.html');
}

// optionalAuth — 비로그인 진입 허용. 세션이 있으면 req.user 채워주고,
// 없으면 req.user = null 로 두고 다음 핸들러로 통과시킨다.
// 비로그인 포털 메인이 공개 영역(인기 콘텐츠/클래스/명예의 전당)을 호출할 때 사용.
function optionalAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = authDb.findUserById(req.session.userId);
    if (user) req.user = user;
  }
  if (!req.user) req.user = null;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// requireSchoolScope — 학교 경영 대시보드(교장·교감) 스코프 미들웨어 (P0-1)
//
//   "우리 학교" 집계 단위 = users.school_name 정확 일치(기획서 §3-1).
//   - principal: 자기 school_name 학교만. req.schoolScope 에 그 학교 멤버 ID 배열을 해석해 주입.
//   - admin   : 전체 거시 권한. 기본은 ?school= 미지정 시 "전체"(school=null). ?school=NAME 지정 시
//               그 학교로 좁혀 principal 과 동일한 화면을 점검할 수 있게 한다(거버넌스 점검).
//   - 그 외   : 403 (학생·교사·학부모·staff 는 학교 경영 집계 비열람).
//
//   주입 객체 req.schoolScope = {
//     schoolName,                       // 스코프 학교명(admin 전체면 null)
//     isAdmin,                          // admin 전체 거시 여부
//     studentIds:[],  staffIds:[],      // 학생 / 교직원(teacher·principal·staff) user_id
//     allIds:[],                        // 학생+교직원 합집합
//     students:[{id,name,grade}],       // 학생 식별 최소(실명 정책은 라우트에서 결정)
//     studentCount, staffCount
//   }
//   admin 전체(school 미지정) 일 때는 ID 배열을 미리 다 적재하지 않는다(전국 수백~수만 → 비효율).
//   대신 isAdmin=true 플래그로 라우트가 학교 필터 없이(또는 macro 재사용) 분기하도록 한다.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_ROLES = ['teacher', 'principal', 'staff'];

/** school_name 으로 학생/교직원 ID·식별을 해석한다(정확 일치). */
function resolveSchoolMembers(schoolName) {
  const out = {
    schoolName,
    isAdmin: false,
    studentIds: [], staffIds: [], allIds: [],
    students: [], staffCount: 0, studentCount: 0,
  };
  if (!schoolName) return out;
  try {
    const students = db.prepare(`
      SELECT id, COALESCE(display_name, username) AS name, grade
      FROM users
      WHERE school_name = ? AND role = 'student'
        AND (status IS NULL OR status = 'active')
      ORDER BY grade, id
    `).all(schoolName);
    out.students = students.map(s => ({ id: s.id, name: s.name || `학생${s.id}`, grade: s.grade }));
    out.studentIds = out.students.map(s => s.id);
    out.studentCount = out.studentIds.length;

    const ph = STAFF_ROLES.map(() => '?').join(',');
    const staff = db.prepare(`
      SELECT id FROM users
      WHERE school_name = ? AND role IN (${ph})
        AND (status IS NULL OR status = 'active')
    `).all(schoolName, ...STAFF_ROLES);
    out.staffIds = staff.map(s => s.id);
    out.staffCount = out.staffIds.length;

    out.allIds = [...out.studentIds, ...out.staffIds];
  } catch (_) { /* 테이블 부재 등 → 빈 스코프 */ }
  return out;
}

function requireSchoolScope(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  const role = req.user.role;

  if (role === 'admin') {
    // admin: ?school= 지정 시 그 학교로 좁혀 점검, 아니면 전체 거시.
    const requested = (req.query && req.query.school) ? String(req.query.school).trim() : null;
    if (requested) {
      req.schoolScope = resolveSchoolMembers(requested);
      req.schoolScope.isAdmin = true; // 실명 권한은 admin 거버넌스로 허용(라우트에서 결정)
    } else {
      req.schoolScope = {
        schoolName: null, isAdmin: true,
        studentIds: [], staffIds: [], allIds: [],
        students: [], studentCount: 0, staffCount: 0,
      };
    }
    return next();
  }

  if (role === 'principal') {
    const schoolName = req.user.school_name ? String(req.user.school_name).trim() : null;
    if (!schoolName) {
      return res.status(403).json({ success: false, message: '학교 정보가 없는 계정입니다.' });
    }
    // 타 학교를 요청해도 무시 — principal 은 자기 학교만(스코프 고정·교차 차단).
    req.schoolScope = resolveSchoolMembers(schoolName);
    return next();
  }

  // 학생·교사·학부모·staff 등 → 학교 경영 집계 비열람
  return res.status(403).json({ success: false, message: '학교 경영 대시보드 접근 권한이 없습니다.' });
}

module.exports = { requireAuth, requireRole, optionalAuth, requireSchoolScope, resolveSchoolMembers };
