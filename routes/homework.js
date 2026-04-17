const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const homeworkDb = require('../db/homework');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');

function requireClassMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  next();
}

// GET /api/homework/:classId - 과제 목록
router.get('/:classId', requireAuth, requireClassMember, (req, res) => {
  try {
    const { status, page } = req.query;
    const result = homeworkDb.getHomeworkByClass(req.classId, { status, page: parseInt(page) || 1, userId: req.user.id });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/homework/:classId - 과제 생성
router.post('/:classId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 과제를 생성할 수 있습니다.' });
    }
    const { title, description, content, due_date, max_score, status, subject_code, grade_group, achievement_code, public_submissions } = req.body;
    if (!title) return res.status(400).json({ success: false, message: '과제 제목을 입력하세요.' });
    const hw = homeworkDb.createHomework(req.classId, req.user.id, {
      title, description, content, due_date, max_score, status,
      subject_code, grade_group, achievement_code,
      public_submissions: public_submissions ? 1 : 0
    });
    res.status(201).json({ success: true, homework: hw });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/homework/:classId/:homeworkId - 과제 상세
router.get('/:classId/:homeworkId', requireAuth, requireClassMember, (req, res) => {
  try {
    const hw = homeworkDb.getHomeworkById(parseInt(req.params.homeworkId));
    if (!hw || hw.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '과제를 찾을 수 없습니다.' });
    }

    let submission = null;
    let submissions = null;
    if (req.myRole === 'owner') {
      submissions = homeworkDb.getSubmissions(hw.id);
    } else {
      submission = homeworkDb.getSubmission(hw.id, req.user.id);
      // 공개 설정이 ON인 과제는 다른 학생 제출물도 함께 제공 (본인 제출물 제외)
      if (hw.public_submissions) {
        const all = homeworkDb.getSubmissions(hw.id);
        submissions = all.map(s => ({
          id: s.id,
          student_id: s.student_id,
          display_name: s.display_name,
          username: s.username,
          content: s.content,
          file_path: s.file_path,
          file_name: s.file_name,
          submitted_at: s.submitted_at,
          status: s.status,
          isMe: s.student_id === req.user.id
        }));
      }
    }
    res.json({ success: true, homework: hw, submission, submissions, myRole: req.myRole });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/homework/:classId/:homeworkId - 과제 수정
router.put('/:classId/:homeworkId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const hw = homeworkDb.updateHomework(parseInt(req.params.homeworkId), req.body);
    res.json({ success: true, homework: hw });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/homework/:classId/:homeworkId - 과제 삭제
router.delete('/:classId/:homeworkId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    homeworkDb.deleteHomework(parseInt(req.params.homeworkId));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/homework/:classId/:homeworkId/submit - 과제 제출
router.post('/:classId/:homeworkId/submit', requireAuth, requireClassMember, (req, res) => {
  try {
    const { content, file_url, file_path, file_name } = req.body;
    const result = homeworkDb.submitHomework(parseInt(req.params.homeworkId), req.user.id, {
      content,
      file_path: file_path || file_url || null,
      file_name: file_name || (file_url ? file_url.split('/').pop() : null)
    });
    // 과제 정보 조회하여 메타데이터 보강
    const hw = homeworkDb.getHomeworkById(parseInt(req.params.homeworkId));
    logLearningActivity({
      userId: req.user.id,
      activityType: 'homework_submit',
      targetType: 'homework',
      targetId: req.params.homeworkId,
      classId: parseInt(req.params.classId),
      verb: 'submitted',
      sourceService: 'class',
      resultSuccess: 1,
      objectType: hw ? hw.title : '과제',
      metadata: {
        subject: hw ? hw.subject_code : null,
        className: hw ? hw.class_name : null
      }
    });
    res.json({ success: true, message: result.updated ? '과제가 수정되었습니다.' : '과제가 제출되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/homework/:classId/:homeworkId/grade/:submissionId - 채점
router.post('/:classId/:homeworkId/grade/:submissionId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const { score, feedback } = req.body;
    const submissionId = parseInt(req.params.submissionId);
    homeworkDb.gradeSubmission(submissionId, score, feedback);

    // 채점 결과를 learning_log에 기록 + 포트폴리오 점수 업데이트
    const submission = homeworkDb.getSubmissionById(submissionId);
    const hw = homeworkDb.getHomeworkById(parseInt(req.params.homeworkId));
    if (submission) {
      const maxScore = hw ? (hw.max_score || 100) : 100;
      const normalizedScore = score / maxScore;
      logLearningActivity({
        userId: submission.student_id,
        activityType: 'homework_graded',
        targetType: 'homework',
        targetId: req.params.homeworkId,
        classId: parseInt(req.params.classId),
        verb: 'completed',
        sourceService: 'class',
        resultScore: normalizedScore,
        resultSuccess: normalizedScore >= 0.6 ? 1 : 0,
        objectType: hw ? hw.title : '과제',
        metadata: { subject: hw ? hw.subject_code : null, feedback }
      });
    }
    res.json({ success: true, message: '채점이 완료되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 과제 피드백 (교사-학생 1:1 채팅) =====
function canAccessFeedback(req, submission, hw) {
  // 교사(owner) 또는 제출 학생 본인만 접근 가능
  if (req.myRole === 'owner') return true;
  if (req.user.role === 'admin') return true;
  if (submission && submission.student_id === req.user.id) return true;
  return false;
}

// GET /api/homework/:classId/:homeworkId/submissions/:submissionId/feedback
router.get('/:classId/:homeworkId/submissions/:submissionId/feedback', requireAuth, requireClassMember, (req, res) => {
  try {
    const submissionId = parseInt(req.params.submissionId);
    const submission = homeworkDb.getSubmissionById(submissionId);
    const hw = homeworkDb.getHomeworkById(parseInt(req.params.homeworkId));
    if (!submission || !hw || hw.class_id !== req.classId || submission.homework_id !== hw.id) {
      return res.status(404).json({ success: false, message: '제출물을 찾을 수 없습니다.' });
    }
    if (!canAccessFeedback(req, submission, hw)) {
      return res.status(403).json({ success: false, message: '피드백을 볼 권한이 없습니다.' });
    }
    const feedback = homeworkDb.getFeedback(submissionId);
    res.json({ success: true, feedback, currentUserId: req.user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/homework/:classId/:homeworkId/submissions/:submissionId/feedback
router.post('/:classId/:homeworkId/submissions/:submissionId/feedback', requireAuth, requireClassMember, (req, res) => {
  try {
    const submissionId = parseInt(req.params.submissionId);
    const submission = homeworkDb.getSubmissionById(submissionId);
    const hw = homeworkDb.getHomeworkById(parseInt(req.params.homeworkId));
    if (!submission || !hw || hw.class_id !== req.classId || submission.homework_id !== hw.id) {
      return res.status(404).json({ success: false, message: '제출물을 찾을 수 없습니다.' });
    }
    if (!canAccessFeedback(req, submission, hw)) {
      return res.status(403).json({ success: false, message: '피드백을 작성할 권한이 없습니다.' });
    }
    const content = (req.body.content || '').trim();
    if (!content) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    const item = homeworkDb.addFeedback(submissionId, req.user.id, content);
    res.status(201).json({ success: true, feedback: item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
