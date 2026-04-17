const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const classDb = require('../db/class');

// POST /api/class - 클래스 생성 (누구나 가능)
router.post('/', requireAuth, (req, res) => {
  try {
    const { name, description, class_type, is_public } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '클래스 이름을 입력하세요.' });
    }
    const cls = classDb.createClass(req.user.id, {
      name: name.trim(), description, class_type, is_public
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
    const classes = classDb.getUserClasses(req.user.id);
    res.json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/my - 내 클래스 (alias)
router.get('/my', requireAuth, (req, res) => {
  try {
    const classes = classDb.getUserClasses(req.user.id);
    res.json({ success: true, classes });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/class/search - 공개 클래스 검색
router.get('/search', requireAuth, (req, res) => {
  try {
    const { keyword, subject, grade, page, limit } = req.query;
    const result = classDb.searchPublicClasses({
      keyword, subject, grade: grade ? parseInt(grade) : null,
      page: parseInt(page) || 1, limit: parseInt(limit) || 12
    });
    res.json({ success: true, ...result });
  } catch (err) {
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

    res.json({ success: true, message: '클래스에 가입했습니다.', class: cls });
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
    res.json({ success: true, class: cls, members, myRole });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/class/:classId - 클래스 수정
router.put('/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const myRole = classDb.getMemberRole(classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '클래스 개설자만 수정 가능합니다.' });
    }
    const updated = classDb.updateClass(classId, req.body);
    res.json({ success: true, message: '클래스 정보가 수정되었습니다.', class: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/class/:classId - 클래스 삭제
router.delete('/:classId', requireAuth, (req, res) => {
  try {
    const classId = parseInt(req.params.classId);
    const myRole = classDb.getMemberRole(classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
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
    const myRole = classDb.getMemberRole(classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
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
    const myRole = classDb.getMemberRole(classId, req.user.id);

    if (myRole !== 'owner' && req.user.role !== 'admin') {
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
    const myRole = classDb.getMemberRole(classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
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

module.exports = router;
