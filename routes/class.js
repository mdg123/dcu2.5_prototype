const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const classDb = require('../db/class');
// 클래스 관리 권한 판정 SSOT — 사본 금지 (lib/auth/can-view-user.js 주석 참조)
const { canManageClass } = require('../lib/auth/can-view-user');

// ─────────────────────────────────────────────────────────────────────────────
// [P0-7] 초대코드 마스킹
//   classes.code 는 비공개 클래스의 **유일한 접근 통제 수단**이다
//   (POST /api/class/join 은 is_public 을 보지 않는다 — "비공개 = 코드로만 가입"이 설계).
//   그런데 상세·목록·검색·인기 응답이 전부 `SELECT c.*` 라 코드가 모든 멤버에게,
//   심지어 인기 클래스는 비로그인에게까지 나갔다(2026-08-05 실측: student1 → code=UE9LT9).
//   → 클래스를 "관리할 수 있는 사람"(canManageClass)에게만 코드를 붙인다.
//   ★ 삭제가 아니라 필드 제거다. FE 는 "code 가 있으면 렌더"로 게이트하므로
//     빈 문자열이나 '******' 같은 가짜 값을 넣지 않는다(빈 칩·가짜 코드 복사 방지).
// ─────────────────────────────────────────────────────────────────────────────
function withCodeIfManager(req, cls) {
  if (!cls) return cls;
  if (canManageClass(req, cls.id)) return cls;
  const { code, ...rest } = cls;
  return rest;
}
const withCodeIfManagerAll = (req, list) => (list || []).map((c) => withCodeIfManager(req, c));

// POST /api/class - 클래스 생성 (누구나 가능)
router.post('/', requireAuth, (req, res) => {
  try {
    const {
      name, description, class_type, is_public,
      subject, grade, school_name, class_number, semester, academic_year
    } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '클래스 이름을 입력하세요.' });
    }
    const gradeNum = grade !== undefined && grade !== null && grade !== ''
      ? parseInt(grade, 10) : null;
    const classNumNum = class_number !== undefined && class_number !== null && class_number !== ''
      ? parseInt(class_number, 10) : null;
    const cls = classDb.createClass(req.user.id, {
      name: name.trim(), description, class_type, is_public,
      subject: subject || null,
      grade: Number.isFinite(gradeNum) ? gradeNum : null,
      school_name: school_name || null,
      class_number: Number.isFinite(classNumNum) ? classNumNum : null,
      semester: semester || null,
      academic_year: academic_year || null
    });
    res.status(201).json({ success: true, message: '클래스가 생성되었습니다.', class: cls });
  } catch (err) {
    console.error('[CLASS] create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class - 나의 클래스 목록
router.get('/', requireAuth, (req, res) => {
  try {
    const classes = withCodeIfManagerAll(req, classDb.getUserClasses(req.user.id));
    res.json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/my - 내 클래스 (alias)
router.get('/my', requireAuth, (req, res) => {
  try {
    const classes = withCodeIfManagerAll(req, classDb.getUserClasses(req.user.id));
    res.json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/search - 공개 클래스 검색
// query.excludeOwnerId 지정 시 해당 사용자가 개설자인 클래스 제외 (포털 메인 인기 클래스용)
router.get('/search', requireAuth, (req, res) => {
  try {
    const { keyword, subject, grade, page, limit, excludeOwnerId } = req.query;
    const result = classDb.searchPublicClasses({
      keyword, subject, grade: grade ? parseInt(grade) : null,
      page: parseInt(page) || 1, limit: parseInt(limit) || 12,
      excludeOwnerId: excludeOwnerId ? parseInt(excludeOwnerId) : null
    });
    result.classes = withCodeIfManagerAll(req, result.classes);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/popular - 인기 클래스 (member_count DESC, 본인 소유 자동 제외)
// 비로그인 사용자도 포털 메인에서 공개 인기 클래스를 볼 수 있도록 optionalAuth 적용
// query.excludeSelf=1 (default) — 본인 소유 클래스 제외, 0이면 포함 (로그인 시에만 의미)
// query.limit (default 5)
router.get('/popular', optionalAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const excludeSelf = req.query.excludeSelf !== '0';
    const result = classDb.searchPublicClasses({
      page: 1, limit,
      excludeOwnerId: (excludeSelf && req.user) ? req.user.id : null
    });
    // optionalAuth — 비로그인이면 canManageClass 가 false 라 코드가 전부 제거된다.
    result.classes = withCodeIfManagerAll(req, result.classes);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CLASS] popular error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/class/join - 클래스 코드로 가입
router.post('/join', requireAuth, (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: '클래스 코드를 입력하세요.' });

    const cls = classDb.getClassByCode(code.trim().toUpperCase());
    if (!cls) return res.status(404).json({ success: false, message: '존재하지 않는 클래스 코드입니다.' });

    const added = classDb.addMember(cls.id, req.user.id, 'member');
    if (!added) return res.status(409).json({ success: false, message: '이미 가입된 클래스입니다.' });

    // 가입 직후 응답에도 코드를 되돌려주지 않는다(가입자는 일반 멤버 → 마스킹).
    res.json({ success: true, message: '클래스에 가입했습니다.', class: withCodeIfManager(req, cls) });
  } catch (err) {
    console.error('[CLASS] join error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/new-counts - 각 클래스별 새 글 수
router.get('/new-counts', requireAuth, (req, res) => {
  try {
    const db = require('../db/index');
    const memberships = db.prepare('SELECT class_id, last_visited_at FROM class_members WHERE user_id = ?').all(req.user.id);
    const counts = {};
    for (const m of memberships) {
      const lastVisit = m.last_visited_at || '2000-01-01';
      const classId = m.class_id;
      const newLessons = db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE class_id = ? AND created_at > ?").get(classId, lastVisit).cnt;
      const newHw = db.prepare("SELECT COUNT(*) as cnt FROM homework WHERE class_id = ? AND created_at > ?").get(classId, lastVisit).cnt;
      const newExams = db.prepare("SELECT COUNT(*) as cnt FROM exams WHERE class_id = ? AND created_at > ?").get(classId, lastVisit).cnt;
      const newNotices = db.prepare("SELECT COUNT(*) as cnt FROM notices WHERE class_id = ? AND created_at > ?").get(classId, lastVisit).cnt;
      const newPosts = db.prepare("SELECT COUNT(*) as cnt FROM posts WHERE class_id = ? AND created_at > ?").get(classId, lastVisit).cnt;
      const total = newLessons + newHw + newExams + newNotices + newPosts;
      if (total > 0) {
        counts[classId] = { total, lessons: newLessons, homework: newHw, exams: newExams, notices: newNotices, posts: newPosts };
      }
    }
    res.json({ success: true, counts });
  } catch (err) {
    console.error('[CLASS] new-counts error:', err);
    res.json({ success: true, counts: {} });
  }
});

// GET /api/class/:classId - 클래스 상세
router.get('/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const cls = classDb.getClassById(classId);
    if (!cls) return res.status(404).json({ success: false, message: '클래스를 찾을 수 없습니다.' });
    if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
    }

    const members = classDb.getClassMembers(classId);
    const myRole = classDb.getMemberRole(classId, req.user.id);
    // canManage — FE(클래스 설정 화면)가 관리 UI 노출을 게이트할 때 쓰는 서버 판정.
    //   FE 가 myRole 로 다시 판정하면 그 순간 판정 사본이 하나 더 생긴다. 서버 답을 그대로 쓴다.
    res.json({
      success: true,
      class: withCodeIfManager(req, cls),
      members, myRole,
      canManage: canManageClass(req, classId)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/class/:classId - 클래스 수정
router.put('/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    // 관리 권한 판정 SSOT — lib/auth/can-view-user.js canManageClass (사본 금지)
    if (!canManageClass(req, classId)) {
      return res.status(403).json({ success: false, message: '클래스 개설자만 수정 가능합니다.' });
    }
    const updated = classDb.updateClass(classId, req.body);
    res.json({ success: true, message: '클래스 정보가 수정되었습니다.', class: withCodeIfManager(req, updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/class/:classId - 클래스 삭제
router.delete('/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    // 관리 권한 판정 SSOT — lib/auth/can-view-user.js canManageClass (사본 금지)
    if (!canManageClass(req, classId)) {
      return res.status(403).json({ success: false, message: '클래스 개설자만 삭제 가능합니다.' });
    }
    classDb.deleteClass(classId);
    res.json({ success: true, message: '클래스가 삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/:classId/members - 멤버 목록
router.get('/:classId/members', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const members = classDb.getClassMembers(classId);
    res.json({ success: true, members });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/class/:classId/members - 멤버 추가 (초대 또는 셀프 가입)
router.post('/:classId/members', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const { username, role, selfJoin } = req.body;

    // 셀프 가입 (클래스 찾기 페이지에서)
    if (selfJoin) {
      const cls = classDb.getClassById(classId);
      if (!cls || !cls.is_public) return res.status(404).json({ success: false, message: '공개 클래스가 아닙니다.' });
      const added = classDb.addMember(classId, req.user.id, 'member');
      if (!added) return res.status(409).json({ success: false, message: '이미 가입된 클래스입니다.' });
      return res.json({ success: true, message: '클래스에 참가했습니다!', classId });
    }

    // 개설자에 의한 초대
    // 관리 권한 판정 SSOT — lib/auth/can-view-user.js canManageClass (사본 금지)
    if (!canManageClass(req, classId)) {
      return res.status(403).json({ success: false, message: '개설자만 멤버를 초대할 수 있습니다.' });
    }
    if (!username) return res.status(400).json({ success: false, message: '사용자 아이디를 입력하세요.' });

    const authDb = require('../db/auth');
    const user = authDb.findUserByUsername(username.trim());
    if (!user) return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });

    const added = classDb.addMember(classId, user.id, 'member');
    if (!added) return res.status(409).json({ success: false, message: '이미 멤버입니다.' });

    res.json({ success: true, message: `${user.display_name}님이 추가되었습니다.` });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/class/:classId/members/:userId/role - 멤버 역할 변경 (개설자 권한 부여/회수)
router.put('/:classId/members/:userId/role', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const userId = parseInt(req.params.userId);
    const { role: newRole } = req.body;
    // 관리 권한 판정 SSOT — lib/auth/can-view-user.js canManageClass (사본 금지)
    if (!canManageClass(req, classId)) {
      return res.status(403).json({ success: false, message: '개설자만 권한을 변경할 수 있습니다.' });
    }
    if (!['owner', 'member'].includes(newRole)) {
      return res.status(400).json({ success: false, message: '올바른 역할을 지정하세요.' });
    }
    // 원래 클래스 생성자의 owner 권한은 회수 불가
    const cls = classDb.getClassById(classId);
    if (cls && cls.owner_id === userId && newRole === 'member') {
      return res.status(400).json({ success: false, message: '클래스 생성자의 개설자 권한은 회수할 수 없습니다.' });
    }

    const updated = classDb.updateMemberRole(classId, userId, newRole);
    if (!updated) return res.status(400).json({ success: false, message: '역할 변경에 실패했습니다.' });
    res.json({ success: true, message: newRole === 'owner' ? '개설자 권한이 부여되었습니다.' : '멤버로 변경되었습니다.' });
  } catch (err) {
    console.error('[CLASS] role update error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/class/:classId/members/:userId - 멤버 제거
router.delete('/:classId/members/:userId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const userId = parseInt(req.params.userId);
    // 관리 권한 판정 SSOT — lib/auth/can-view-user.js canManageClass (사본 금지)
    if (!canManageClass(req, classId)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const removed = classDb.removeMember(classId, userId);
    if (!removed) return res.status(400).json({ success: false, message: '제거할 수 없습니다.' });
    res.json({ success: true, message: '멤버가 제거되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/class/:classId/visit - 클래스 방문 기록 갱신
router.post('/:classId/visit', requireAuth, (req, res) => {
  try {
    const db = require('../db/index');
    db.prepare('UPDATE class_members SET last_visited_at = CURRENT_TIMESTAMP WHERE class_id = ? AND user_id = ?')
      .run(parseInt(req.params.classId), req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// GET /api/class/:classId/owner-summary?type=ungraded|missing|counts
// [개설자 전용] 클래스 카드 칩 클릭 시 표시할 미채점/미제출 상세 목록
// 응답에는 미채점/미제출뿐 아니라 제출자·채점 완료자 명단도 함께 포함되어
// 모달에서 해당 과제의 종합 현황(미제출/제출/채점완료)을 한눈에 볼 수 있음.
router.get('/:classId/owner-summary', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const type = String(req.query.type || 'ungraded'); // ungraded | missing
    // 관리 권한 판정 SSOT — lib/auth/can-view-user.js canManageClass (사본 금지)
    if (!canManageClass(req, classId)) {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }

    const db = require('../db/index');

    // 클래스 학생 목록 (역할: student 또는 일반 멤버)
    const members = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role
      FROM class_members cm JOIN users u ON cm.user_id = u.id
      WHERE cm.class_id = ? AND cm.status = 'active' AND cm.role = 'member'
      ORDER BY u.display_name
    `).all(classId);
    const memberIds = members.map(m => m.id);

    if (type === 'counts') {
      // 카드 칩용 정확한 카운트만 (목록 없이)
      const ungradedCnt = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM homework_submissions hs
        JOIN homework h ON h.id = hs.homework_id
        WHERE h.class_id = ? AND (h.status IS NULL OR h.status = 'published')
          AND hs.score IS NULL
      `).get(classId).cnt;

      // 미제출 (과제 + 평가)
      const homeworks = db.prepare(`
        SELECT id FROM homework
        WHERE class_id = ? AND (status IS NULL OR status = 'published')
      `).all(classId);
      let missingCnt = 0;
      const memberSet = new Set(memberIds);
      for (const hw of homeworks) {
        const submitted = db.prepare(
          'SELECT student_id FROM homework_submissions WHERE homework_id = ?'
        ).all(hw.id).map(s => s.student_id);
        const submittedSet = new Set(submitted);
        for (const mid of memberIds) if (!submittedSet.has(mid)) missingCnt++;
      }
      const exams = db.prepare(`
        SELECT id FROM exams
        WHERE class_id = ? AND status IN ('waiting','active')
      `).all(classId);
      // [FIX] 평가 응시자를 해당 클래스 멤버로만 한정 (비클래스 응시자 제외)
      const memberIdSetForCounts = new Set(memberIds);
      for (const ex of exams) {
        const submitted = db.prepare(
          "SELECT user_id FROM exam_students WHERE exam_id = ? AND status = 'submitted'"
        ).all(ex.id).map(s => s.user_id).filter(uid => memberIdSetForCounts.has(uid));
        const submittedSet = new Set(submitted);
        for (const mid of memberIds) if (!submittedSet.has(mid)) missingCnt++;
      }
      return res.json({ success: true, type, ungraded: ungradedCnt, missing: missingCnt });
    }

    if (type === 'ungraded') {
      // 미채점: 제출은 했으나 score IS NULL 인 항목
      // ★ 확장: 채점 완료 제출자, 미제출 학생도 함께 반환하여 모달에서 종합 현황 제공
      // 미채점 제출이 1건 이상 있는 과제만 대상으로 한다.

      // 1) 미채점 제출이 1건 이상 있는 homework 목록
      const targetHomeworks = db.prepare(`
        SELECT DISTINCT h.id, h.title, h.due_date, h.max_score
        FROM homework h
        JOIN homework_submissions hs ON hs.homework_id = h.id
        WHERE h.class_id = ?
          AND (h.status IS NULL OR h.status = 'published')
          AND hs.score IS NULL
        ORDER BY h.due_date ASC, h.id ASC
      `).all(classId);

      const memberMap = new Map(members.map(m => [m.id, m]));
      const groups = [];
      let totalUngradedCount = 0;

      for (const hw of targetHomeworks) {
        const subs = db.prepare(`
          SELECT hs.id as submission_id, hs.student_id, hs.submitted_at, hs.status, hs.score,
                 u.display_name as student_name, u.username as student_username
          FROM homework_submissions hs
          JOIN users u ON u.id = hs.student_id
          WHERE hs.homework_id = ?
          ORDER BY hs.submitted_at ASC
        `).all(hw.id);

        const ungraded_submissions = [];
        const graded_submissions = [];
        const submittedIds = new Set();
        for (const s of subs) {
          submittedIds.add(s.student_id);
          const row = {
            submission_id: s.submission_id,
            student_id: s.student_id,
            student_name: s.student_name,
            student_username: s.student_username,
            submitted_at: s.submitted_at,
            status: s.status,
            score: s.score
          };
          if (s.score === null || s.score === undefined) ungraded_submissions.push(row);
          else graded_submissions.push(row);
        }

        // 미제출 멤버
        const missing_members = members
          .filter(m => !submittedIds.has(m.id))
          .map(m => ({
            student_id: m.id,
            student_name: m.display_name,
            student_username: m.username
          }));

        totalUngradedCount += ungraded_submissions.length;

        groups.push({
          homework_id: hw.id,
          title: hw.title,
          due_date: hw.due_date,
          max_score: hw.max_score,
          total_members: members.length,
          ungraded_submissions,
          graded_submissions,
          missing_members,
          // 하위 호환: 기존 클라이언트가 submissions(미채점)만 참조했음
          submissions: ungraded_submissions
        });
      }

      return res.json({ success: true, type, groups, totalCount: totalUngradedCount, totalMembers: members.length });
    }

    if (type === 'missing') {
      // 미제출: 과제(published) 와 평가(active|waiting) 에서 멤버 중 미제출/미응시
      // ★ 확장: 미제출자뿐 아니라 제출자(채점 상태 포함)도 함께 반환해 종합 현황 표시
      // -- 과제 미제출
      const homeworks = db.prepare(`
        SELECT id, title, due_date, max_score, status
        FROM homework
        WHERE class_id = ? AND (status IS NULL OR status = 'published')
        ORDER BY due_date ASC
      `).all(classId);

      const homeworkGroups = [];
      let homeworkMissingCount = 0;
      for (const hw of homeworks) {
        const subs = db.prepare(`
          SELECT hs.student_id, hs.submitted_at, hs.status, hs.score,
                 u.display_name as student_name, u.username as student_username
          FROM homework_submissions hs
          JOIN users u ON u.id = hs.student_id
          WHERE hs.homework_id = ?
          ORDER BY hs.submitted_at ASC
        `).all(hw.id);
        const submittedSet = new Set(subs.map(s => s.student_id));
        const missing = members.filter(m => !submittedSet.has(m.id));
        if (missing.length === 0) continue; // 미제출 0인 과제는 모달에 노출하지 않음
        homeworkMissingCount += missing.length;

        const submitted_members = subs.map(s => ({
          student_id: s.student_id,
          student_name: s.student_name,
          student_username: s.student_username,
          submitted_at: s.submitted_at,
          status: s.status,
          score: s.score,
          graded: !(s.score === null || s.score === undefined)
        }));
        const graded_count = submitted_members.filter(s => s.graded).length;
        const ungraded_count = submitted_members.length - graded_count;

        homeworkGroups.push({
          item_id: hw.id,
          item_type: 'homework',
          title: hw.title,
          due_date: hw.due_date,
          total_members: members.length,
          missing_members: missing.map(m => ({
            student_id: m.id,
            student_name: m.display_name,
            student_username: m.username
          })),
          submitted_members,
          graded_count,
          ungraded_count
        });
      }

      // -- 평가 미응시 (active|waiting 상태)
      const exams = db.prepare(`
        SELECT id, title, status, start_date, end_date, created_at
        FROM exams
        WHERE class_id = ? AND status IN ('waiting','active')
        ORDER BY end_date ASC, created_at DESC
      `).all(classId);

      const examGroups = [];
      let examMissingCount = 0;
      // [FIX] 평가 응시 명단을 해당 클래스 멤버로만 한정 (다른 클래스 학생/교사 응시 제외)
      const memberIdSet = new Set(members.map(m => m.id));
      for (const ex of exams) {
        // 응시 학생 전체(상태 포함) — 모달에 응시 명단 표시용
        // exam_students.exam_id 가 TEXT 인 점에 주의 (필요시 String 변환)
        const examStudents = db.prepare(`
          SELECT es.user_id, es.status, es.submitted_at, es.score,
                 u.display_name as student_name, u.username as student_username
          FROM exam_students es
          JOIN users u ON u.id = es.user_id
          WHERE es.exam_id = ?
        `).all(String(ex.id))
          .filter(s => memberIdSet.has(s.user_id));  // 클래스 멤버만 통계 대상
        const submittedSet = new Set(
          examStudents.filter(s => s.status === 'submitted').map(s => s.user_id)
        );
        const missing = members.filter(m => !submittedSet.has(m.id));
        if (missing.length === 0) continue;
        examMissingCount += missing.length;

        const submitted_members = examStudents
          .filter(s => s.status === 'submitted')
          .map(s => ({
            student_id: s.user_id,
            student_name: s.student_name,
            student_username: s.student_username,
            submitted_at: s.submitted_at,
            status: s.status,
            score: s.score,
            graded: !(s.score === null || s.score === undefined)
          }));

        examGroups.push({
          item_id: ex.id,
          item_type: 'exam',
          title: ex.title,
          due_date: ex.end_date,
          total_members: members.length,
          missing_members: missing.map(m => ({
            student_id: m.id,
            student_name: m.display_name,
            student_username: m.username
          })),
          submitted_members,
          graded_count: submitted_members.filter(s => s.graded).length,
          ungraded_count: submitted_members.filter(s => !s.graded).length
        });
      }

      const totalCount = homeworkMissingCount + examMissingCount;
      return res.json({
        success: true,
        type,
        groups: { homework: homeworkGroups, exam: examGroups },
        totalCount,
        homeworkMissingCount,
        examMissingCount,
        totalMembers: members.length
      });
    }

    return res.status(400).json({ success: false, message: '잘못된 type 값입니다.' });
  } catch (err) {
    console.error('[CLASS] owner-summary error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// GET /api/class/:classId/students/self-learn-summary
// [교사·관리자] 클래스 학생들의 AI 맞춤학습 진도 요약
router.get('/:classId/students/self-learn-summary', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const myRole = classDb.getMemberRole(classId, req.user.id);
    const isOwner = myRole === 'owner';
    const isAdmin = req.user.role === 'admin';
    const isTeacher = req.user.role === 'teacher' || req.user.role === 'admin';

    // 권한: 클래스 owner(교사) 또는 관리자만
    if (!(isOwner || isAdmin) || (!isTeacher && !isAdmin)) {
      return res.status(403).json({ success: false, message: '교사·관리자만 접근 가능합니다.' });
    }

    const db = require('../db/index');

    // 기간 필터 (옵션) — ISO YYYY-MM-DD만 허용, 잘못되면 무시(전체 범위)
    const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const startDate = isIso(req.query.startDate) ? req.query.startDate : null;
    const endDate = isIso(req.query.endDate) ? req.query.endDate : null;
    const startTs = startDate ? startDate + ' 00:00:00' : null;
    const endTs = endDate ? endDate + ' 23:59:59' : null;

    // 컬럼별 기간 절 빌더 (테이블별 시간 컬럼이 다름)
    function rangeClause(col) {
      const parts = [];
      const params = [];
      if (startTs) { parts.push(`${col} >= ?`); params.push(startTs); }
      if (endTs)   { parts.push(`${col} <= ?`); params.push(endTs); }
      return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
    }

    // 클래스 학생 목록 (role=student)
    const students = db.prepare(`
      SELECT u.id, u.username, u.display_name
      FROM class_members cm
      JOIN users u ON cm.user_id = u.id
      WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'
      ORDER BY u.display_name
    `).all(classId);

    // user_node_status: status IN(completed,mastered) → completed_at 기준
    const cnRange = rangeClause('completed_at');
    const completedNodesStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_node_status WHERE user_id = ? AND status IN ('completed','mastered')${cnRange.sql}`
    );
    // user_node_status: in_progress → last_accessed_at 기준
    const ipRange = rangeClause('last_accessed_at');
    const inProgressStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_node_status WHERE user_id = ? AND status = 'in_progress'${ipRange.sql}`
    );
    // problem_attempts: submitted_at 기준
    const paRange = rangeClause('submitted_at');
    const attemptsStmt = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
      FROM problem_attempts WHERE user_id = ?${paRange.sql}
    `);
    // user_content_progress: updated_at 기준
    const ucpRange = rangeClause('updated_at');
    const videoTimeStmt = db.prepare(
      `SELECT COALESCE(SUM(position_sec), 0) AS sec FROM user_content_progress WHERE user_id = ?${ucpRange.sql}`
    );
    // daily_learning_progress: started_at 기준 (시작 시점 기준 누적)
    const dlpRange = rangeClause('started_at');
    const dailyTimeStmt = db.prepare(
      `SELECT COALESCE(SUM(time_spent_seconds), 0) AS sec FROM daily_learning_progress WHERE user_id = ?${dlpRange.sql}`
    );
    // user_last_activity: 단일 user별 1행이라 기간 무시 (마지막 활동시각 자체)
    const lastActivityStmt = db.prepare(`
      SELECT MAX(accessed_at) AS at FROM user_last_activity WHERE user_id = ?
    `);
    // 스트릭 계산용 — 기간 미지정 시 종전대로 최근 30일, 지정 시 해당 구간
    let distinctDaysStmt;
    if (startTs || endTs) {
      const ulaRange = rangeClause('accessed_at');
      distinctDaysStmt = db.prepare(
        `SELECT DISTINCT DATE(accessed_at) AS d FROM user_last_activity WHERE user_id = ?${ulaRange.sql} ORDER BY d DESC`
      );
    } else {
      distinctDaysStmt = db.prepare(`
        SELECT DISTINCT DATE(accessed_at) AS d FROM user_last_activity
        WHERE user_id = ? AND accessed_at >= DATE('now', '-30 days')
        ORDER BY d DESC
      `);
    }
    // 영역별 정답률 — problem_attempts.submitted_at 기준
    const acRange = rangeClause('pa.submitted_at');
    const areaCorrectStmt = db.prepare(`
      SELECT n.subject AS area,
             COUNT(*) AS total,
             SUM(CASE WHEN pa.is_correct = 1 THEN 1 ELSE 0 END) AS correct
      FROM problem_attempts pa
      LEFT JOIN learning_map_nodes n ON n.node_id = pa.node_id
      WHERE pa.user_id = ?${acRange.sql}
      GROUP BY n.subject
    `);

    function calcStreak(days) {
      if (!days || !days.length) return 0;
      // 오늘부터 연속된 일자
      const set = new Set(days.map(r => r.d));
      let streak = 0;
      const cur = new Date();
      for (let i = 0; i < 30; i++) {
        const ymd = cur.toISOString().slice(0, 10);
        if (set.has(ymd)) { streak++; cur.setDate(cur.getDate() - 1); }
        else if (i === 0) { cur.setDate(cur.getDate() - 1); } // 오늘 미활동 허용 (어제부터)
        else break;
      }
      return streak;
    }

    const rows = students.map(s => {
      const completed = completedNodesStmt.get(s.id, ...cnRange.params).cnt || 0;
      const inProgress = inProgressStmt.get(s.id, ...ipRange.params).cnt || 0;
      const att = attemptsStmt.get(s.id, ...paRange.params) || { total: 0, correct: 0 };
      const totalSolved = att.total || 0;
      const avgAccuracy = totalSolved ? Math.round((att.correct / totalSolved) * 100) : 0;
      const videoSec = videoTimeStmt.get(s.id, ...ucpRange.params).sec || 0;
      const dailySec = dailyTimeStmt.get(s.id, ...dlpRange.params).sec || 0;
      const totalMinutes = Math.round((videoSec + dailySec) / 60);
      const lastAt = (lastActivityStmt.get(s.id) || {}).at || null;
      // distinctDaysStmt는 기간 지정 여부에 따라 추가 파라미터 유무가 달라짐
      const days = (startTs || endTs)
        ? distinctDaysStmt.all(s.id, ...(startTs ? [startTs] : []), ...(endTs ? [endTs] : []))
        : distinctDaysStmt.all(s.id);
      const streak = calcStreak(days);
      const areas = areaCorrectStmt.all(s.id, ...acRange.params).filter(a => a.area).map(a => ({
        area: a.area,
        total: a.total,
        correct: a.correct,
        accuracy: a.total ? Math.round((a.correct / a.total) * 100) : 0
      }));
      return {
        user_id: s.id,
        username: s.username,
        name: s.display_name,
        completed_nodes: completed,
        in_progress_nodes: inProgress,
        total_solved: totalSolved,
        correct_count: att.correct || 0,
        avg_accuracy: avgAccuracy,
        total_time_minutes: totalMinutes,
        streak,
        last_activity_at: lastAt,
        areas
      };
    });

    // 클래스 평균
    const n = rows.length || 1;
    const summary = {
      student_count: rows.length,
      avg_completed_nodes: Math.round(rows.reduce((s, r) => s + r.completed_nodes, 0) / n * 10) / 10,
      avg_accuracy: Math.round(rows.reduce((s, r) => s + r.avg_accuracy, 0) / n),
      avg_time_minutes: Math.round(rows.reduce((s, r) => s + r.total_time_minutes, 0) / n),
      total_solved: rows.reduce((s, r) => s + r.total_solved, 0),
      active_students: rows.filter(r => r.total_solved > 0 || r.completed_nodes > 0).length
    };

    res.json({ success: true, classId, students: rows, summary });
  } catch (err) {
    console.error('[CLASS] self-learn-summary error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// GET /api/class/:classId/lessons/self-check/aggregate - 수업 셀프체크 집계 (대시보드용) — RFP SFR-019
// 권한: owner(개설자/공동개설자) 또는 admin. 학생 차단.
// 쿼리: startDate=YYYY-MM-DD, endDate=YYYY-MM-DD, lessonId=숫자(선택)
router.get('/:classId/lessons/self-check/aggregate', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ success: false, message: '잘못된 클래스 ID입니다.' });
    }
    const myRole = classDb.getMemberRole(classId, req.user.id);
    const isOwner = myRole === 'owner';
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: '클래스 개설자/관리자만 접근할 수 있습니다.' });
    }

    const { startDate, endDate, lessonId } = req.query;
    // 날짜 형식 가벼운 검증 (YYYY-MM-DD)
    const datePat = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !datePat.test(String(startDate))) {
      return res.status(400).json({ success: false, message: 'startDate 형식은 YYYY-MM-DD 입니다.' });
    }
    if (endDate && !datePat.test(String(endDate))) {
      return res.status(400).json({ success: false, message: 'endDate 형식은 YYYY-MM-DD 입니다.' });
    }

    const lessonDb = require('../db/lesson');
    const result = lessonDb.getClassSelfCheckAggregate(classId, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      lessonId: lessonId ? parseInt(lessonId) : undefined
    });
    res.json({ success: true, lessons: result.lessons, class_summary: result.class_summary });
  } catch (err) {
    console.error('[CLASS] self-check aggregate error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ============================================================================
// 클래스별 학습분석 (RFP P0) — 수업/과제/평가 항목별 + 멤버 종합
// 모든 엔드포인트: 권한 = 클래스 owner 또는 admin (학생 차단)
// 공통 쿼리: startDate=YYYY-MM-DD, endDate=YYYY-MM-DD (옵션, 미지정 시 전체)
// ============================================================================

// 권한 체크 + 클래스 ID 검증 공통 헬퍼
function _checkAnalyticsAuth(req, res) {
  const classId = parseInt(req.params.classId);
  if (!Number.isInteger(classId)) {
    res.status(400).json({ success: false, message: '잘못된 클래스 ID입니다.' });
    return null;
  }
  const myRole = classDb.getMemberRole(classId, req.user.id);
  // RFP: 클래스 개설자(owner) + 매니저(manager) + 시스템 관리자(admin)만 접근.
  // owner는 학생/교사 누구나 될 수 있음 (사용자 누구나 클래스 개설 가능).
  const isOwnerOrManager = (myRole === 'owner' || myRole === 'manager');
  const isAdmin = req.user.role === 'admin';
  if (!isOwnerOrManager && !isAdmin) {
    res.status(403).json({ success: false, message: '클래스 개설자/관리자만 접근할 수 있습니다.' });
    return null;
  }
  return classId;
}

// ISO 날짜 + 기간 절 빌더
function _parseRange(req) {
  const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const startDate = isIso(req.query.startDate) ? req.query.startDate : null;
  const endDate = isIso(req.query.endDate) ? req.query.endDate : null;
  return {
    startDate,
    endDate,
    startTs: startDate ? startDate + ' 00:00:00' : null,
    endTs: endDate ? endDate + ' 23:59:59' : null,
    clause(col) {
      const parts = [];
      const params = [];
      if (this.startTs) { parts.push(`${col} >= ?`); params.push(this.startTs); }
      if (this.endTs)   { parts.push(`${col} <= ?`); params.push(this.endTs); }
      return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
    }
  };
}

// 클래스의 활동 학생 멤버 목록 (id, name, class_number)
function _getClassStudents(db, classId) {
  return db.prepare(`
    SELECT u.id AS user_id, u.display_name AS name, u.class_number
    FROM class_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'
    ORDER BY u.class_number, u.display_name
  `).all(classId);
}

// ----------------------------------------------------------------------------
// B-1. GET /:classId/analytics/lessons — 수업별 이수율 목록
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/lessons', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const range = _parseRange(req);
    const db = require('../db/index');

    const totalMembers = db.prepare(
      `SELECT COUNT(*) AS c FROM class_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'`
    ).get(classId).c || 0;

    const lr = range.clause('l.created_at');
    const lessons = db.prepare(`
      SELECT l.id AS lesson_id, l.title, l.created_at AS registered_at, l.status
      FROM lessons l
      WHERE l.class_id = ? AND l.status = 'published'${lr.sql}
      ORDER BY l.created_at DESC
    `).all(classId, ...lr.params);

    const completedStmt = db.prepare(
      `SELECT COUNT(DISTINCT user_id) AS c FROM lesson_self_check WHERE lesson_id = ? AND class_id = ?`
    );
    // 수업에 포함된 quiz contents (수업꾸러미 문항)
    const quizContentsStmt = db.prepare(
      `SELECT c.id FROM lesson_contents lc JOIN contents c ON c.id = lc.content_id
       WHERE lc.lesson_id = ? AND c.content_type IN ('quiz', 'exam')`
    );
    // 해당 quiz contents의 학생별 평균 정답수
    const avgCorrectStmt = db.prepare(
      `SELECT AVG(correct_count) AS avg_correct, COUNT(*) AS attempt_count
       FROM content_attempts WHERE content_id IN (SELECT value FROM json_each(?))`
    );

    const items = lessons.map(l => {
      const completed = completedStmt.get(l.lesson_id, classId).c || 0;
      const completionRate = totalMembers > 0
        ? Math.round((completed / totalMembers) * 1000) / 10 : 0;
      // 수업꾸러미 문항 평균 정답수
      let avgCorrect = null;
      const quizIds = quizContentsStmt.all(l.lesson_id).map(r => r.id);
      if (quizIds.length > 0) {
        try {
          const r = avgCorrectStmt.get(JSON.stringify(quizIds));
          if (r && r.attempt_count > 0) avgCorrect = Math.round((r.avg_correct || 0) * 10) / 10;
        } catch(_) { /* json_each 미지원 환경 fallback */ }
      }
      return {
        lesson_id: l.lesson_id,
        title: l.title,
        registered_at: l.registered_at,
        total_members: totalMembers,
        completed_count: completed,
        completion_rate: completionRate,
        avg_correct: avgCorrect,
        quiz_count: quizIds.length
      };
    });

    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/lessons error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// B-2. GET /:classId/analytics/lessons/:lessonId/roster — 수업별 참여/미참여 명단
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/lessons/:lessonId/roster', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const lessonId = parseInt(req.params.lessonId);
    if (!Number.isInteger(lessonId)) {
      return res.status(400).json({ success: false, message: '잘못된 수업 ID입니다.' });
    }
    const db = require('../db/index');

    // 수업이 해당 클래스에 속하는지 검증
    const lesson = db.prepare(`SELECT id FROM lessons WHERE id = ? AND class_id = ?`).get(lessonId, classId);
    if (!lesson) {
      return res.status(404).json({ success: false, message: '수업을 찾을 수 없습니다.' });
    }

    const students = _getClassStudents(db, classId);
    // self_check: 한 학생당 한 row만 있다고 가정. correct_count는 P1 — 현재 셀프체크 점수로 대체 X (null)
    const checkStmt = db.prepare(`
      SELECT created_at, updated_at, understanding, focus
      FROM lesson_self_check WHERE lesson_id = ? AND user_id = ? AND class_id = ?
    `);

    const participants = [];
    const absentees = [];
    students.forEach(s => {
      const sc = checkStmt.get(lessonId, s.user_id, classId);
      if (sc) {
        participants.push({
          user_id: s.user_id,
          name: s.name,
          correct_count: null,    // P1
          time_minutes: null,     // P1 — 수업 체류 시간 트래킹 미구현
          completed_at: sc.updated_at || sc.created_at
        });
      } else {
        absentees.push({ user_id: s.user_id, name: s.name });
      }
    });

    res.json({ success: true, participants, absentees });
  } catch (err) {
    console.error('[CLASS] analytics/lessons/:id/roster error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// B-3. GET /:classId/analytics/homework — 과제별 제출/채점 현황
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/homework', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const range = _parseRange(req);
    const db = require('../db/index');

    const totalMembers = db.prepare(
      `SELECT COUNT(*) AS c FROM class_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'`
    ).get(classId).c || 0;

    const hr = range.clause('h.created_at');
    const homeworks = db.prepare(`
      SELECT h.id AS homework_id, h.title, h.created_at AS registered_at,
             h.due_date, h.status
      FROM homework h
      WHERE h.class_id = ? AND h.status = 'published'${hr.sql}
      ORDER BY h.created_at DESC
    `).all(classId, ...hr.params);

    // 과제별 집계 statement
    const aggStmt = db.prepare(`
      SELECT
        SUM(CASE WHEN submitted_at IS NOT NULL AND COALESCE(is_draft,0)=0 THEN 1 ELSE 0 END) AS submitted_count,
        SUM(CASE WHEN status = 'graded' THEN 1 ELSE 0 END) AS graded_count,
        AVG(CASE WHEN status = 'graded' AND score IS NOT NULL THEN score END) AS avg_score,
        SUM(CASE WHEN submitted_at IS NOT NULL AND ? IS NOT NULL AND DATE(submitted_at) > DATE(?) THEN 1 ELSE 0 END) AS late_count
      FROM homework_submissions
      WHERE homework_id = ?
    `);

    const today = new Date().toISOString().slice(0, 10);

    const items = homeworks.map(h => {
      const due = h.due_date ? String(h.due_date).slice(0, 10) : null;
      const agg = aggStmt.get(due, due, h.homework_id) || {};
      const submitted = agg.submitted_count || 0;
      const graded = agg.graded_count || 0;
      const submitRate = totalMembers > 0
        ? Math.round((submitted / totalMembers) * 1000) / 10 : 0;
      const avg = agg.avg_score != null ? Math.round(agg.avg_score * 10) / 10 : null;
      // 상태: submit_rate==100 → completed, 마감 지났으면 deadline, 아니면 in_progress
      let status = 'in_progress';
      if (submitRate >= 100) status = 'completed';
      else if (due && due < today) status = 'deadline';
      return {
        homework_id: h.homework_id,
        title: h.title,
        registered_at: h.registered_at,
        due_date: h.due_date,
        total_members: totalMembers,
        submitted_count: submitted,
        submit_rate: submitRate,
        avg_score: avg,
        graded_count: graded,
        late_count: agg.late_count || 0,
        status
      };
    });

    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/homework error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// B-4. GET /:classId/analytics/homework/:homeworkId/roster — 과제별 멤버 명단
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/homework/:homeworkId/roster', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const homeworkId = parseInt(req.params.homeworkId);
    if (!Number.isInteger(homeworkId)) {
      return res.status(400).json({ success: false, message: '잘못된 과제 ID입니다.' });
    }
    const db = require('../db/index');

    const hw = db.prepare(`SELECT id, due_date FROM homework WHERE id = ? AND class_id = ?`).get(homeworkId, classId);
    if (!hw) {
      return res.status(404).json({ success: false, message: '과제를 찾을 수 없습니다.' });
    }
    const due = hw.due_date ? String(hw.due_date).slice(0, 10) : null;

    const students = _getClassStudents(db, classId);
    const subStmt = db.prepare(`
      SELECT score, status, submitted_at, is_draft
      FROM homework_submissions
      WHERE homework_id = ? AND student_id = ?
    `);

    const participants = [];
    const absentees = [];
    students.forEach(s => {
      const sub = subStmt.get(homeworkId, s.user_id);
      const submitted = sub && sub.submitted_at && !sub.is_draft;
      if (submitted) {
        const submittedDate = String(sub.submitted_at).slice(0, 10);
        const late = !!(due && submittedDate > due);
        participants.push({
          user_id: s.user_id,
          name: s.name,
          graded: sub.status === 'graded',
          score: sub.score != null ? sub.score : null,
          submitted_at: sub.submitted_at,
          late
        });
      } else {
        absentees.push({ user_id: s.user_id, name: s.name });
      }
    });

    res.json({ success: true, participants, absentees });
  } catch (err) {
    console.error('[CLASS] analytics/homework/:id/roster error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// B-5. GET /:classId/analytics/exams — 평가별 응시 현황
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/exams', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const range = _parseRange(req);
    const db = require('../db/index');

    const totalMembers = db.prepare(
      `SELECT COUNT(*) AS c FROM class_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'`
    ).get(classId).c || 0;

    const er = range.clause('e.created_at');
    const exams = db.prepare(`
      SELECT e.id AS exam_id, e.title, e.created_at AS registered_at, e.question_count
      FROM exams e
      WHERE e.class_id = ?${er.sql}
      ORDER BY e.created_at DESC
    `).all(classId, ...er.params);

    const aggStmt = db.prepare(`
      SELECT COUNT(*) AS submitted_count, AVG(score) AS avg_score
      FROM exam_students
      WHERE exam_id = ? AND submitted_at IS NOT NULL AND score IS NOT NULL
    `);

    const items = exams.map(e => {
      const agg = aggStmt.get(e.exam_id) || {};
      const submitted = agg.submitted_count || 0;
      const participateRate = totalMembers > 0
        ? Math.round((submitted / totalMembers) * 1000) / 10 : 0;
      const avgScore = agg.avg_score != null ? Math.round(agg.avg_score * 10) / 10 : 0;
      return {
        exam_id: e.exam_id,
        title: e.title,
        registered_at: e.registered_at,
        total_members: totalMembers,
        submitted_count: submitted,
        participate_rate: participateRate,
        avg_score: avgScore,
        avg_correct_rate: avgScore   // 점수가 100점 만점 % → 동일치 사용
      };
    });

    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/exams error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// B-6. GET /:classId/analytics/exams/:examId/roster — 평가별 응시자 명단
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/exams/:examId/roster', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const examId = String(req.params.examId);
    const db = require('../db/index');

    const exam = db.prepare(`SELECT id, question_count FROM exams WHERE id = ? AND class_id = ?`).get(examId, classId);
    if (!exam) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }
    const totalQ = exam.question_count || 0;

    const students = _getClassStudents(db, classId);
    const subStmt = db.prepare(`
      SELECT score, joined_at, submitted_at
      FROM exam_students WHERE exam_id = ? AND user_id = ? AND submitted_at IS NOT NULL
    `);

    // 점수 순위 계산용 — 제출자 점수 내림차순
    const rankRows = db.prepare(`
      SELECT user_id, score FROM exam_students
      WHERE exam_id = ? AND submitted_at IS NOT NULL AND score IS NOT NULL
      ORDER BY score DESC, submitted_at ASC
    `).all(examId);
    const rankMap = new Map();
    rankRows.forEach((r, i) => rankMap.set(r.user_id, i + 1));

    const participants = [];
    const absentees = [];
    students.forEach(s => {
      const sub = subStmt.get(examId, s.user_id);
      if (sub) {
        // time_minutes: joined_at → submitted_at 차이 (초 → 분)
        let timeMin = null;
        if (sub.joined_at && sub.submitted_at) {
          const a = new Date(sub.joined_at).getTime();
          const b = new Date(sub.submitted_at).getTime();
          if (!isNaN(a) && !isNaN(b) && b > a) timeMin = Math.round((b - a) / 60000);
        }
        // correct_count = score % × question_count / 100
        const correctCount = (sub.score != null && totalQ > 0)
          ? Math.round((sub.score / 100) * totalQ) : null;
        participants.push({
          user_id: s.user_id,
          name: s.name,
          score: sub.score != null ? sub.score : null,
          time_minutes: timeMin,
          rank: rankMap.get(s.user_id) || null,
          correct_count: correctCount,
          total_count: totalQ
        });
      } else {
        absentees.push({ user_id: s.user_id, name: s.name });
      }
    });

    res.json({ success: true, participants, absentees });
  } catch (err) {
    console.error('[CLASS] analytics/exams/:id/roster error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// B-7. GET /:classId/analytics/members — 멤버별 종합 활동/성취 집계
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/members', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const range = _parseRange(req);
    const db = require('../db/index');

    const students = _getClassStudents(db, classId);

    // 분모: 클래스 published 수업/과제, 전체 평가 수 (기간 적용)
    const lr = range.clause('created_at');
    const lessonCount = db.prepare(
      `SELECT COUNT(*) AS c FROM lessons WHERE class_id = ? AND status = 'published'${lr.sql}`
    ).get(classId, ...lr.params).c || 0;

    const hr = range.clause('created_at');
    const homeworkCount = db.prepare(
      `SELECT COUNT(*) AS c FROM homework WHERE class_id = ? AND status = 'published'${hr.sql}`
    ).get(classId, ...hr.params).c || 0;

    const er = range.clause('created_at');
    const examCount = db.prepare(
      `SELECT COUNT(*) AS c FROM exams WHERE class_id = ?${er.sql}`
    ).get(classId, ...er.params).c || 0;

    // 학생별 statement
    // 활동 수 / 학습 시간 (learning_logs)
    const llRange = range.clause('ll.created_at');
    const activityStmt = db.prepare(`
      SELECT COUNT(*) AS cnt,
             COALESCE(SUM(COALESCE(ll.duration_sec, ll.duration, 0)), 0) AS dur_sec
      FROM learning_logs ll
      WHERE ll.user_id = ? AND ll.class_id = ?${llRange.sql}
    `);

    // 수업 이수 (lesson_self_check 작성 수)
    const lscRange = range.clause('lsc.created_at');
    const lessonDoneStmt = db.prepare(`
      SELECT COUNT(DISTINCT lsc.lesson_id) AS c
      FROM lesson_self_check lsc
      JOIN lessons l ON l.id = lsc.lesson_id AND l.status = 'published'
      WHERE lsc.user_id = ? AND lsc.class_id = ?${lscRange.sql}
    `);

    // 과제 제출/평균
    const hwsRange = range.clause('hs.submitted_at');
    const hwSubStmt = db.prepare(`
      SELECT COUNT(*) AS submitted_cnt,
             AVG(CASE WHEN hs.status='graded' AND hs.score IS NOT NULL THEN hs.score END) AS avg_score
      FROM homework_submissions hs
      JOIN homework h ON h.id = hs.homework_id
      WHERE hs.student_id = ? AND h.class_id = ? AND h.status = 'published'
        AND hs.submitted_at IS NOT NULL AND COALESCE(hs.is_draft,0)=0${hwsRange.sql}
    `);

    // 평가 응시/평균
    const esRange = range.clause('es.submitted_at');
    const exSubStmt = db.prepare(`
      SELECT COUNT(*) AS submitted_cnt,
             AVG(CASE WHEN es.score IS NOT NULL THEN es.score END) AS avg_score
      FROM exam_students es
      JOIN exams e ON e.id = es.exam_id
      WHERE es.user_id = ? AND e.class_id = ? AND es.submitted_at IS NOT NULL${esRange.sql}
    `);

    // 이해도/집중도 (lesson_self_check)
    const fbRange = range.clause('lsc.created_at');
    const checkAvgStmt = db.prepare(`
      SELECT AVG(lsc.understanding) AS u, AVG(lsc.focus) AS f
      FROM lesson_self_check lsc
      WHERE lsc.user_id = ? AND lsc.class_id = ?${fbRange.sql}
    `);

    const members = students.map(s => {
      const act = activityStmt.get(s.user_id, classId, ...llRange.params) || { cnt: 0, dur_sec: 0 };
      const lessonDone = (lessonDoneStmt.get(s.user_id, classId, ...lscRange.params) || {}).c || 0;
      const hw = hwSubStmt.get(s.user_id, classId, ...hwsRange.params) || { submitted_cnt: 0, avg_score: null };
      const ex = exSubStmt.get(s.user_id, classId, ...esRange.params) || { submitted_cnt: 0, avg_score: null };
      const chk = checkAvgStmt.get(s.user_id, classId, ...fbRange.params) || { u: null, f: null };

      const lessonRate = lessonCount > 0 ? Math.round((lessonDone / lessonCount) * 1000) / 10 : 0;
      const hwRate = homeworkCount > 0 ? Math.round((hw.submitted_cnt / homeworkCount) * 1000) / 10 : 0;
      const exRate = examCount > 0 ? Math.round((ex.submitted_cnt / examCount) * 1000) / 10 : 0;
      const hwAvg = hw.avg_score != null ? Math.round(hw.avg_score * 10) / 10 : null;
      const exAvg = ex.avg_score != null ? Math.round(ex.avg_score * 10) / 10 : null;
      const understandingAvg = chk.u != null ? Math.round(chk.u * 10) / 10 : null;
      const focusAvg = chk.f != null ? Math.round(chk.f * 10) / 10 : null;

      // 상태 분류
      let status = 'normal';
      const exAvgNum = exAvg != null ? exAvg : 0;
      if (lessonRate >= 80 && hwRate >= 80 && exAvgNum >= 80) {
        status = 'good';
      } else if (lessonRate < 50 || hwRate < 50 || act.cnt === 0) {
        status = 'warn';
      }

      return {
        user_id: s.user_id,
        name: s.name,
        student_no: s.class_number != null ? s.class_number : null,
        activity_count: act.cnt || 0,
        study_minutes: Math.round((act.dur_sec || 0) / 60),
        lesson_completion_rate: lessonRate,
        homework_submit_rate: hwRate,
        homework_avg_score: hwAvg,
        exam_submit_rate: exRate,
        exam_avg_score: exAvg,
        understanding_avg: understandingAvg,
        focus_avg: focusAvg,
        status
      };
    });

    res.json({ success: true, members });
  } catch (err) {
    console.error('[CLASS] analytics/members error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ============================================================================
// 클래스별 학습분석 (RFP P1) — 평가 상세 분석 / 과제 제출 시간 분포 / 게시판 분석
// 권한: P0과 동일하게 owner + admin (class_members.role은 owner/member 2단계)
// ============================================================================

// --- 공통 헬퍼: 0~100 클램프 + 1자리 반올림 ---
function _pct(num, den) {
  if (!den || den <= 0) return 0;
  const v = (num / den) * 100;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

// --- exams.answers JSON 파싱 → 문항 메타 배열 ---
// 두 가지 포맷 지원:
//  A) [{question, options, answer:idx}]
//  B) [{number, text, type, options, answer:'문자열', points}]
function _parseExamAnswers(rawJson) {
  if (!rawJson) return [];
  let arr;
  try { arr = JSON.parse(rawJson); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((q, idx) => {
    const stem = q.question || q.text || q.title || `문항 ${idx + 1}`;
    return {
      question_no: q.number || (idx + 1),
      stem: String(stem).slice(0, 200),
      type: q.type || (Array.isArray(q.options) ? 'choice' : 'short'),
      options: Array.isArray(q.options) ? q.options : null,
      correct_answer: q.answer  // 인덱스(숫자) 또는 문자열
    };
  });
}

// --- 학생 응답을 (questionIndex → 답) Map으로 정규화 ---
// 지원 포맷:
//  A) [{questionId:1, answer:'3/4'}] — 1-based id
//  B) [2, 1, 2] — 선택지 인덱스 배열
//  C) {"0":"답"} — 0-based 객체
function _parseStudentAnswers(rawJson) {
  if (!rawJson) return new Map();
  let v;
  try { v = JSON.parse(rawJson); } catch { return new Map(); }
  const map = new Map();
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      if (item && typeof item === 'object' && 'questionId' in item) {
        const qid = parseInt(item.questionId);
        if (Number.isInteger(qid)) map.set(qid - 1, item.answer);
      } else {
        // 단일 값(인덱스 또는 문자열)
        map.set(i, item);
      }
    });
  } else if (v && typeof v === 'object') {
    Object.keys(v).forEach(k => {
      const ki = parseInt(k);
      if (Number.isInteger(ki)) map.set(ki, v[k]);
    });
  }
  return map;
}

// --- 한 문항에 대해 학생 답이 정답인지 판정 ---
// DB 포맷 다양성 대응:
//  - correct: 숫자(0-based 인덱스) 또는 문자열(텍스트)
//  - studentAnswer: 숫자(0-based 또는 1-based 가능), 문자열(텍스트/숫자)
function _isCorrectAnswer(question, studentAnswer) {
  if (studentAnswer == null || studentAnswer === '') return false;
  const correct = question.correct_answer;
  if (correct == null) return false;
  const opts = Array.isArray(question.options) ? question.options : null;

  // 학생 답을 숫자로 변환 시도
  let sNum = null;
  if (typeof studentAnswer === 'number') sNum = studentAnswer;
  else if (typeof studentAnswer === 'string') {
    const t = studentAnswer.trim();
    if (/^\d+$/.test(t)) sNum = parseInt(t);
  }

  if (typeof correct === 'number') {
    // correct는 0-based 인덱스
    if (sNum != null) {
      // 0-based 동일 또는 1-based 입력(sNum-1) 둘 다 허용
      if (correct === sNum || correct === sNum - 1) return true;
    }
    if (typeof studentAnswer === 'string' && opts) {
      const idx = opts.findIndex(o => String(o).trim() === studentAnswer.trim());
      if (idx >= 0 && idx === correct) return true;
    }
    return false;
  }

  // correct가 문자열
  const cs = String(correct).trim();
  if (sNum != null && opts) {
    // 인덱스로 옵션 텍스트 조회 (0-based 우선, 안 되면 1-based 시도)
    const o0 = opts[sNum];
    if (o0 != null && String(o0).trim() === cs) return true;
    const o1 = opts[sNum - 1];
    if (o1 != null && String(o1).trim() === cs) return true;
  }
  return String(studentAnswer).trim() === cs;
}

// --- 정답률 → 난이도 5단계 자동 분류 ---
function _classifyDifficulty(correctRatePct) {
  if (correctRatePct >= 90) return 'veryeasy';
  if (correctRatePct >= 70) return 'easy';
  if (correctRatePct >= 50) return 'medium';
  if (correctRatePct >= 30) return 'hard';
  return 'veryhard';
}

// ----------------------------------------------------------------------------
// P1-B1. GET /:classId/analytics/exams/:examId/distribution
//        점수별 응시자 분포 + 5단계 점수 구간 + 명단
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/exams/:examId/distribution', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const examId = String(req.params.examId);
    const db = require('../db/index');

    const exam = db.prepare(`SELECT id FROM exams WHERE id = ? AND class_id = ?`).get(examId, classId);
    if (!exam) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }

    // 제출자 + 점수 + 풀이시간 + 이름
    const rows = db.prepare(`
      SELECT es.user_id, u.display_name AS name, es.score, es.joined_at, es.submitted_at
      FROM exam_students es
      JOIN users u ON u.id = es.user_id
      WHERE es.exam_id = ? AND es.submitted_at IS NOT NULL AND es.score IS NOT NULL
      ORDER BY es.score DESC, es.submitted_at ASC
    `).all(examId);

    const scores = rows.map((r, i) => {
      let timeMin = null;
      if (r.joined_at && r.submitted_at) {
        const a = new Date(r.joined_at).getTime();
        const b = new Date(r.submitted_at).getTime();
        if (!isNaN(a) && !isNaN(b) && b > a) timeMin = Math.round((b - a) / 60000);
      }
      return {
        user_id: r.user_id,
        name: r.name,
        score: r.score,
        time_minutes: timeMin,
        rank: i + 1
      };
    });

    // 5단계 점수 구간
    const bucketDefs = [
      { label: '0-20점',   min: 0,  max: 20 },
      { label: '21-40점',  min: 21, max: 40 },
      { label: '41-60점',  min: 41, max: 60 },
      { label: '61-80점',  min: 61, max: 80 },
      { label: '81-100점', min: 81, max: 100 }
    ];
    const buckets = bucketDefs.map(b => ({ label: b.label, count: 0, members: [] }));
    scores.forEach(s => {
      const i = bucketDefs.findIndex(b => s.score >= b.min && s.score <= b.max);
      if (i >= 0) {
        buckets[i].count++;
        buckets[i].members.push({ user_id: s.user_id, name: s.name, score: s.score });
      }
    });

    res.json({ success: true, scores, buckets });
  } catch (err) {
    console.error('[CLASS] analytics/exams/:id/distribution error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B2. GET /:classId/analytics/exams/:examId/questions
//        평가지 문항별 정답률 + 난이도 + 평균 풀이시간 + 정·오답 명단
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/exams/:examId/questions', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const examId = String(req.params.examId);
    const db = require('../db/index');

    const exam = db.prepare(
      `SELECT id, answers, question_count FROM exams WHERE id = ? AND class_id = ?`
    ).get(examId, classId);
    if (!exam) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }

    const questions = _parseExamAnswers(exam.answers);
    if (questions.length === 0) {
      return res.json({ success: true, questions: [], difficultyGroups: {} });
    }

    // 제출자 + 답안 + 풀이시간
    const subs = db.prepare(`
      SELECT es.user_id, u.display_name AS name, es.answers, es.joined_at, es.submitted_at
      FROM exam_students es
      JOIN users u ON u.id = es.user_id
      WHERE es.exam_id = ? AND es.submitted_at IS NOT NULL
    `).all(examId);

    // 평균 풀이시간(전체) — 문항별 개별 시간 트래킹 없으므로 전체시간/문항수로 분배
    let avgPerQuestionSec = null;
    if (subs.length > 0) {
      const durs = subs.map(s => {
        if (!s.joined_at || !s.submitted_at) return null;
        const a = new Date(s.joined_at).getTime();
        const b = new Date(s.submitted_at).getTime();
        if (isNaN(a) || isNaN(b) || b <= a) return null;
        return (b - a) / 1000;
      }).filter(v => v != null);
      if (durs.length > 0) {
        const avgTotal = durs.reduce((a, b) => a + b, 0) / durs.length;
        avgPerQuestionSec = Math.round(avgTotal / questions.length);
      }
    }

    // 학생별 답안 파싱
    const parsedSubs = subs.map(s => ({
      user_id: s.user_id,
      name: s.name,
      answers: _parseStudentAnswers(s.answers)
    }));

    // 문항별 집계
    const result = questions.map((q, qi) => {
      const correctUsers = [];
      const wrongUsers = [];
      parsedSubs.forEach(p => {
        if (!p.answers.has(qi)) return;
        const ans = p.answers.get(qi);
        if (_isCorrectAnswer(q, ans)) {
          correctUsers.push({ user_id: p.user_id, name: p.name });
        } else {
          wrongUsers.push({ user_id: p.user_id, name: p.name });
        }
      });
      const total = correctUsers.length + wrongUsers.length;
      const correctRate = _pct(correctUsers.length, total);
      return {
        question_id: qi + 1,
        question_no: q.question_no,
        stem: q.stem,
        difficulty: _classifyDifficulty(correctRate),
        correct_rate: correctRate,
        avg_time_seconds: avgPerQuestionSec,
        correct_count: correctUsers.length,
        wrong_count: wrongUsers.length,
        correct_users: correctUsers,
        wrong_users: wrongUsers
      };
    });

    // 난이도 그룹 집계
    const groupOrder = ['veryeasy', 'easy', 'medium', 'hard', 'veryhard'];
    const difficultyGroups = {};
    groupOrder.forEach(g => {
      const items = result.filter(r => r.difficulty === g);
      if (items.length > 0) {
        const avg = items.reduce((s, r) => s + r.correct_rate, 0) / items.length;
        difficultyGroups[g] = {
          count: items.length,
          avg_correct_rate: Math.round(avg * 10) / 10
        };
      } else {
        difficultyGroups[g] = { count: 0, avg_correct_rate: 0 };
      }
    });

    res.json({ success: true, questions: result, difficultyGroups });
  } catch (err) {
    console.error('[CLASS] analytics/exams/:id/questions error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B3. GET /:classId/analytics/exams/:examId/wrong-questions?limit=10
//        제일 많이 틀린 문항 TOP N
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/exams/:examId/wrong-questions', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const examId = String(req.params.examId);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 10, 50));
    const db = require('../db/index');

    const exam = db.prepare(`SELECT id, answers FROM exams WHERE id = ? AND class_id = ?`).get(examId, classId);
    if (!exam) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }

    const questions = _parseExamAnswers(exam.answers);
    if (questions.length === 0) return res.json({ success: true, items: [] });

    const subs = db.prepare(`
      SELECT es.user_id, es.answers
      FROM exam_students es
      WHERE es.exam_id = ? AND es.submitted_at IS NOT NULL
    `).all(examId);

    const parsedSubs = subs.map(s => _parseStudentAnswers(s.answers));

    const stats = questions.map((q, qi) => {
      let correct = 0, wrong = 0;
      parsedSubs.forEach(p => {
        if (!p.has(qi)) return;
        if (_isCorrectAnswer(q, p.get(qi))) correct++;
        else wrong++;
      });
      const total = correct + wrong;
      return {
        question_id: qi + 1,
        question_no: q.question_no,
        stem: q.stem,
        wrong_count: wrong,
        correct_rate: _pct(correct, total)
      };
    });

    // 오답 수 내림차순, 정답률 오름차순
    stats.sort((a, b) => (b.wrong_count - a.wrong_count) || (a.correct_rate - b.correct_rate));
    const items = stats.filter(s => s.wrong_count > 0).slice(0, limit);
    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/exams/:id/wrong-questions error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B4. GET /:classId/analytics/homework/:homeworkId/submit-time-distribution
//        과제 마감 시점 기준 제출 시간대 분포
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/homework/:homeworkId/submit-time-distribution', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const homeworkId = parseInt(req.params.homeworkId);
    if (!Number.isInteger(homeworkId)) {
      return res.status(400).json({ success: false, message: '잘못된 과제 ID입니다.' });
    }
    const db = require('../db/index');

    const hw = db.prepare(`SELECT id, due_date FROM homework WHERE id = ? AND class_id = ?`).get(homeworkId, classId);
    if (!hw) {
      return res.status(404).json({ success: false, message: '과제를 찾을 수 없습니다.' });
    }

    const subs = db.prepare(`
      SELECT submitted_at
      FROM homework_submissions
      WHERE homework_id = ? AND submitted_at IS NOT NULL AND COALESCE(is_draft,0)=0
    `).all(homeworkId);

    const bucketDefs = [
      { label: '마감 1일 전 이상' },
      { label: '마감 당일' },
      { label: '마감 직전(1시간 이내)' },
      { label: '지각 제출' }
    ];
    const buckets = bucketDefs.map(b => ({ label: b.label, count: 0, ratio: 0 }));

    // due_date 없으면 전부 0
    if (hw.due_date) {
      const dueMs = new Date(hw.due_date).getTime();
      if (!isNaN(dueMs)) {
        const ONE_HOUR = 60 * 60 * 1000;
        const ONE_DAY = 24 * ONE_HOUR;
        subs.forEach(s => {
          const sm = new Date(s.submitted_at).getTime();
          if (isNaN(sm)) return;
          if (sm <= dueMs - ONE_DAY) buckets[0].count++;
          else if (sm <= dueMs - ONE_HOUR) buckets[1].count++;
          else if (sm <= dueMs) buckets[2].count++;
          else buckets[3].count++;
        });
      }
    }

    const total = subs.length;
    buckets.forEach(b => { b.ratio = _pct(b.count, total); });

    res.json({ success: true, buckets, totalSubmitted: total });
  } catch (err) {
    console.error('[CLASS] analytics/homework/:id/submit-time-distribution error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B5. GET /:classId/analytics/board?startDate&endDate
//        게시판 통합 분석 대시보드 (게시글/알림장/설문)
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/board', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const range = _parseRange(req);
    const db = require('../db/index');

    // 학생 멤버 수 (알림장 읽음율/설문 응답률 분모)
    const totalMembers = db.prepare(
      `SELECT COUNT(*) AS c FROM class_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'`
    ).get(classId).c || 0;

    // posts (일반 게시글) — view_count는 컬럼, 좋아요 테이블 없음 → 0
    const pr = range.clause('created_at');
    const postStats = db.prepare(`
      SELECT COUNT(*) AS post_count, COALESCE(SUM(view_count),0) AS view_count
      FROM posts WHERE class_id = ?${pr.sql}
    `).get(classId, ...pr.params) || {};
    const postCommentRange = range.clause('c.created_at');
    const postComments = db.prepare(`
      SELECT COUNT(*) AS c FROM comments c
      JOIN posts p ON p.id = c.post_id
      WHERE p.class_id = ? AND c.post_id IS NOT NULL${postCommentRange.sql}
    `).get(classId, ...postCommentRange.params).c || 0;

    // notices (알림장) — view_count 컬럼 없음, notice_reads로 추정
    const nr = range.clause('created_at');
    const noticeStats = db.prepare(`
      SELECT COUNT(*) AS post_count
      FROM notices WHERE class_id = ?${nr.sql}
    `).get(classId, ...nr.params) || {};
    const noticeIds = db.prepare(
      `SELECT id FROM notices WHERE class_id = ?${nr.sql}`
    ).all(classId, ...nr.params).map(r => r.id);

    let noticeReadCount = 0, noticeCommentCount = 0, noticeReactionCount = 0;
    if (noticeIds.length > 0) {
      const ph = noticeIds.map(() => '?').join(',');
      noticeReadCount = db.prepare(
        `SELECT COUNT(*) AS c FROM notice_reads WHERE notice_id IN (${ph})`
      ).get(...noticeIds).c || 0;
      noticeCommentCount = db.prepare(
        `SELECT COUNT(*) AS c FROM notice_comments WHERE notice_id IN (${ph}) AND deleted_at IS NULL`
      ).get(...noticeIds).c || 0;
      noticeReactionCount = db.prepare(
        `SELECT COUNT(*) AS c FROM notice_reactions WHERE notice_id IN (${ph})`
      ).get(...noticeIds).c || 0;
    }
    // 알림장 읽음률 = 전체 (알림장 수 × 학생 수) 분의 실제 읽은 row
    const noticeReadDen = (noticeStats.post_count || 0) * totalMembers;
    const noticeReadRate = _pct(noticeReadCount, noticeReadDen);

    // surveys + 응답률
    const sr = range.clause('created_at');
    const surveyStats = db.prepare(`
      SELECT COUNT(*) AS post_count
      FROM surveys WHERE class_id = ?${sr.sql}
    `).get(classId, ...sr.params) || {};
    const surveyIds = db.prepare(
      `SELECT id FROM surveys WHERE class_id = ?${sr.sql}`
    ).all(classId, ...sr.params).map(r => r.id);

    let surveyResponseCount = 0;
    if (surveyIds.length > 0) {
      const ph = surveyIds.map(() => '?').join(',');
      surveyResponseCount = db.prepare(
        `SELECT COUNT(*) AS c FROM survey_responses WHERE survey_id IN (${ph})`
      ).get(...surveyIds).c || 0;
    }
    const surveyRespDen = (surveyStats.post_count || 0) * totalMembers;
    const surveyResponseRate = _pct(surveyResponseCount, surveyRespDen);

    const totalPosts = (postStats.post_count || 0) + (noticeStats.post_count || 0) + (surveyStats.post_count || 0);
    const totalComments = postComments + noticeCommentCount + surveyResponseCount;
    // 좋아요: 일반게시글 좋아요 테이블 없음 — 알림장 reactions만 합산
    const totalLikes = noticeReactionCount;

    res.json({
      success: true,
      summary: {
        totalPosts,
        totalComments,
        totalLikes,
        noticeReadRate,
        surveyResponseRate
      },
      byBoard: [
        {
          type: 'notice',
          label: '알림장',
          post_count: noticeStats.post_count || 0,
          comment_count: noticeCommentCount,
          view_count: noticeReadCount   // 읽음 수를 조회로 매핑
        },
        {
          type: 'post',
          label: '일반게시판',
          post_count: postStats.post_count || 0,
          comment_count: postComments,
          view_count: postStats.view_count || 0
        },
        {
          type: 'survey',
          label: '설문',
          post_count: surveyStats.post_count || 0,
          comment_count: surveyResponseCount,
          view_count: surveyResponseCount
        }
      ]
    });
  } catch (err) {
    console.error('[CLASS] analytics/board error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B6. GET /:classId/analytics/board/top-posts?limit=5
//        인기 게시글 TOP N (조회수+댓글+좋아요 가중치)
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/board/top-posts', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 5, 50));
    const range = _parseRange(req);
    const db = require('../db/index');

    // 일반 게시글: view*1 + comment*3 + like(0)*5 → comment+view 기반 가중치
    const pr = range.clause('p.created_at');
    const posts = db.prepare(`
      SELECT p.id AS post_id, p.title, p.author_id, u.display_name AS author_name,
             COALESCE(p.view_count,0) AS view_count,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
             0 AS like_count, p.created_at, 'post' AS board_type
      FROM posts p
      JOIN users u ON u.id = p.author_id
      WHERE p.class_id = ?${pr.sql}
    `).all(classId, ...pr.params);

    // 알림장: 읽음=조회수, 댓글=notice_comments, 좋아요=reactions
    const nr = range.clause('n.created_at');
    const notices = db.prepare(`
      SELECT n.id AS post_id, n.title, n.author_id, u.display_name AS author_name,
             (SELECT COUNT(*) FROM notice_reads WHERE notice_id = n.id) AS view_count,
             (SELECT COUNT(*) FROM notice_comments WHERE notice_id = n.id AND deleted_at IS NULL) AS comment_count,
             (SELECT COUNT(*) FROM notice_reactions WHERE notice_id = n.id) AS like_count,
             n.created_at, 'notice' AS board_type
      FROM notices n
      JOIN users u ON u.id = n.author_id
      WHERE n.class_id = ?${nr.sql}
    `).all(classId, ...nr.params);

    const all = [...posts, ...notices].map(r => ({
      ...r,
      _weight: (r.view_count || 0) + (r.comment_count || 0) * 3 + (r.like_count || 0) * 5
    }));

    all.sort((a, b) =>
      (b._weight - a._weight) ||
      (b.view_count - a.view_count) ||
      (new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    );
    const items = all.slice(0, limit).map(({ _weight, ...rest }) => rest);
    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/board/top-posts error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B7. GET /:classId/analytics/board/top-members?limit=5
//        활발한 멤버 TOP N (게시글+댓글 합산)
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/board/top-members', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 5, 50));
    const range = _parseRange(req);
    const db = require('../db/index');

    // posts 작성 + comments 작성(클래스 소속 글에 한해) + notice_comments 작성 — 모두 기간 필터 적용
    const pp = range.clause('p.created_at');
    const cc = range.clause('c.created_at');
    const ncc = range.clause('nc.created_at');
    const rows = db.prepare(`
      SELECT u.id AS user_id, u.display_name AS name,
             (SELECT COUNT(*) FROM posts p WHERE p.class_id = ? AND p.author_id = u.id${pp.sql}) AS post_count,
             (
               (SELECT COUNT(*) FROM comments c JOIN posts p ON p.id = c.post_id
                  WHERE p.class_id = ? AND c.author_id = u.id${cc.sql})
             + (SELECT COUNT(*) FROM notice_comments nc JOIN notices n ON n.id = nc.notice_id
                  WHERE n.class_id = ? AND nc.user_id = u.id AND nc.deleted_at IS NULL${ncc.sql})
             ) AS comment_count
      FROM users u
      JOIN class_members cm ON cm.user_id = u.id
      WHERE cm.class_id = ? AND cm.status = 'active'
    `).all(classId, ...pp.params, classId, ...cc.params, classId, ...ncc.params, classId);

    const items = rows
      .map(r => ({
        user_id: r.user_id,
        name: r.name,
        post_count: r.post_count || 0,
        comment_count: r.comment_count || 0,
        total_activity: (r.post_count || 0) + (r.comment_count || 0)
      }))
      .filter(r => r.total_activity > 0)
      .sort((a, b) => (b.total_activity - a.total_activity) || (b.post_count - a.post_count))
      .slice(0, limit);

    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/board/top-members error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ----------------------------------------------------------------------------
// P1-B8. GET /:classId/analytics/surveys
//        설문 응답 현황 목록
// ----------------------------------------------------------------------------
router.get('/:classId/analytics/surveys', requireAuth, (req, res) => {
  try {
    const classId = _checkAnalyticsAuth(req, res);
    if (classId === null) return;
    const range = _parseRange(req);
    const db = require('../db/index');

    const totalMembers = db.prepare(
      `SELECT COUNT(*) AS c FROM class_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.class_id = ? AND cm.status = 'active' AND u.role = 'student'`
    ).get(classId).c || 0;

    const sr = range.clause('s.created_at');
    const surveys = db.prepare(`
      SELECT s.id AS survey_id, s.title, s.status, s.end_date AS deadline,
             (SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id) AS response_count
      FROM surveys s
      WHERE s.class_id = ?${sr.sql}
      ORDER BY s.created_at DESC
    `).all(classId, ...sr.params);

    const items = surveys.map(s => ({
      survey_id: s.survey_id,
      title: s.title,
      status: s.status || 'active',
      response_count: s.response_count || 0,
      total_members: totalMembers,
      response_rate: _pct(s.response_count || 0, totalMembers),
      deadline: s.deadline ? String(s.deadline).slice(0, 10) : null
    }));

    res.json({ success: true, items });
  } catch (err) {
    console.error('[CLASS] analytics/surveys error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
