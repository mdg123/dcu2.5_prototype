const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const homeworkDb = require('../db/homework');
const classDb = require('../db/class');
const notifDb = require('../db/notifications');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const { ensureTodayAttendance } = require('../db/attendance');
const buildAssignment = require('../lib/xapi/builders/assignment');
const xapiSpool = require('../lib/xapi/spool');

function _hwSchoolLevel(sc) {
  const s = String(sc || '');
  return s.endsWith('-e') ? '초' : s.endsWith('-m') ? '중' : s.endsWith('-h') ? '고' : null;
}

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
    const { status, page, std_ids } = req.query;
    const stdIdsArr = std_ids ? String(std_ids).split(',').map(s => s.trim()).filter(Boolean) : null;
    // G5: 학생/일반 사용자 → 시작일 도달한 과제만 노출. 교사(owner)·관리자 → 전체 + is_scheduled 표기
    const isOwner = req.myRole === 'owner' || req.user.role === 'admin';
    const result = homeworkDb.getHomeworkByClass(req.classId, {
      status, page: parseInt(page) || 1, userId: req.user.id, std_ids: stdIdsArr,
      hideScheduled: !isOwner
    });
    // 일반 과제 항목엔 type='homework' 명시(FE 가 보충과 구분 가능)
    result.homework = (result.homework || []).map(h => ({ type: 'homework', ...h }));

    // P1-3 보충 미러: 학생(비개설자) 본인에게 배정된 보충(supplement_assignment)을
    //   "보충" 출처로 합쳐 노출. 위조 homework 행 생성 안 함 — 별도 type='supplement' 배열.
    //   교사(owner)·관리자 과제 목록엔 미포함(교사는 /supplement/class 현황으로 봄).
    let supplements = [];
    if (!isOwner) {
      try {
        const supDb = require('../db/lrs-supplement');
        supplements = supDb.getStudentSupplementsForList(req.user.id, req.classId);
      } catch (e) { supplements = []; }
    }
    res.json({ success: true, ...result, supplements });
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
    const { title, description, content, due_date, max_score, status, subject_code, grade_group, achievement_code, public_submissions, std_ids, start_date, attachments, display_mode } = req.body;
    if (!title) return res.status(400).json({ success: false, message: '과제 제목을 입력하세요.' });
    // 표시 모드 검증: 'list' | 'comment' 외 값은 'list'로 폴백
    const safeDisplayMode = (display_mode === 'comment') ? 'comment' : 'list';
    const hw = homeworkDb.createHomework(req.classId, req.user.id, {
      title, description, content, due_date, max_score, status,
      subject_code, grade_group, achievement_code,
      public_submissions: public_submissions ? 1 : 0,
      std_ids: Array.isArray(std_ids) ? std_ids : null,
      start_date: start_date || null,                                  // G5
      attachments: Array.isArray(attachments) ? attachments : null,    // G3
      display_mode: safeDisplayMode                                     // 표시 모드: 리스트형/댓글형
    });
    // xAPI: 과제 출제 assignment.gave (교사)
    try {
      xapiSpool.record('assignment', buildAssignment, { userId: req.user.id, classId: req.classId }, {
        verb: 'gave',
        assignment_id: hw.id,
        title: hw.title,
        due_at: due_date || null,
        subject_code: subject_code || null,
        grade_group: grade_group || null,
        school_level: _hwSchoolLevel(subject_code),
        achievement_codes: achievement_code || null,
      });
    } catch (_) {}
    // 알림: 클래스 학생 전원에게 새 과제 알림 (예약 출제가 아닐 때만)
    try {
      const isScheduled = start_date && new Date(start_date) > new Date();
      if (!isScheduled && hw && hw.id) {
        notifDb.notifyClassMembers(req.classId, {
          type: 'homework_new',
          title: '새 과제가 등록되었습니다',
          message: hw.title,
          link: `/class/class-homework.html?classId=${req.classId}&homeworkId=${hw.id}`,
          excludeUserId: req.user.id
        });
      }
    } catch (e) { console.error('[HOMEWORK] notify error:', e.message); }
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

    const isOwner = req.myRole === 'owner' || req.user.role === 'admin';

    // G5: 예약 과제 — 학생/일반 사용자가 시작일 전 진입 시 차단
    if (!isOwner && hw.start_date) {
      const todayKst = (() => {
        const d = new Date();
        d.setHours(d.getHours() + 9);
        return d.toISOString().slice(0, 10);
      })();
      if (hw.start_date > todayKst) {
        return res.json({
          success: false,
          scheduled: true,
          start_date: hw.start_date,
          message: `이 과제는 ${hw.start_date}에 공개됩니다.`
        });
      }
    }

    // G5: 교사 응답에는 is_scheduled 표기
    if (isOwner) {
      const todayKst = (() => {
        const d = new Date();
        d.setHours(d.getHours() + 9);
        return d.toISOString().slice(0, 10);
      })();
      hw.is_scheduled = !!(hw.start_date && hw.start_date > todayKst);
    }

    let submission = null;
    let submissions = null;
    if (isOwner) {
      submissions = homeworkDb.getSubmissions(hw.id);
    } else {
      submission = homeworkDb.getSubmission(hw.id, req.user.id);
      // 공개 설정이 ON인 과제는 다른 학생 제출물도 함께 제공
      // 정책: 본인 항목은 점수·피드백 포함, 다른 학생 항목은 점수·피드백·채점일·채점상태 마스킹
      if (hw.public_submissions) {
        const all = homeworkDb.getSubmissions(hw.id);
        submissions = all.map(s => {
          const isMe = s.student_id === req.user.id;
          const base = {
            id: s.id,
            student_id: s.student_id,
            display_name: s.display_name,
            username: s.username,
            content: s.content,
            file_path: s.file_path,
            file_name: s.file_name,
            attachments: s.attachments,                  // G2: 멀티미디어 통합
            submitted_at: s.submitted_at,
            isMe
          };
          if (isMe) {
            // 본인 항목 — 채점 결과 그대로 노출
            base.score = s.score;
            base.feedback = s.feedback;
            base.graded_at = s.graded_at;
            base.status = s.status;
          } else {
            // 다른 학생 항목 — 채점 결과 마스킹
            base.score = null;
            base.feedback = null;
            base.graded_at = null;
            // status 표준화: 'graded'/'returned'/'resubmitted' 등 채점 결과 노출 단어 가리기
            base.status = 'submitted';
          }
          return base;
        });
      }
    }

    // G6: 제출률 통계 — 학생/교사 모두에 부여
    try {
      hw.submission_stats = homeworkDb.getSubmissionStats(hw.id, req.classId);
    } catch (e) {
      hw.submission_stats = { total_students: 0, submitted_count: 0, percent: 0 };
    }

    try { ensureTodayAttendance(req.classId, req.user.id, 'homework_view'); } catch (e) {}
    res.json({ success: true, homework: hw, submission, submissions, myRole: req.myRole });
  } catch (err) {
    console.error('homework detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/homework/:classId/:homeworkId - 과제 수정
router.put('/:classId/:homeworkId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    // 표시 모드 검증: 명시 전달된 경우 'list' | 'comment' 외 값은 'list'로 폴백
    const body = { ...req.body };
    if ('display_mode' in body) {
      body.display_mode = (body.display_mode === 'comment') ? 'comment' : 'list';
    }
    const hw = homeworkDb.updateHomework(parseInt(req.params.homeworkId), body);
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

// POST /api/homework/:classId/:homeworkId/draft - 임시저장 (학생 전용, G1)
router.post('/:classId/:homeworkId/draft', requireAuth, requireClassMember, (req, res) => {
  try {
    // 교사(개설자)·관리자는 임시저장 대상이 아님
    if (req.myRole === 'owner') {
      return res.status(403).json({ success: false, message: '임시저장은 학생 전용입니다.' });
    }
    const homeworkId = parseInt(req.params.homeworkId);
    const hw = homeworkDb.getHomeworkById(homeworkId);
    if (!hw || hw.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '과제를 찾을 수 없습니다.' });
    }
    // G5: 시작일 전 임시저장 차단
    if (hw.start_date) {
      const todayKst = (() => {
        const d = new Date();
        d.setHours(d.getHours() + 9);
        return d.toISOString().slice(0, 10);
      })();
      if (hw.start_date > todayKst) {
        return res.status(403).json({ success: false, message: `이 과제는 ${hw.start_date}에 공개됩니다.` });
      }
    }
    const { content, attachments } = req.body;
    if (Array.isArray(attachments) && attachments.length > 20) {
      return res.status(400).json({ success: false, message: '첨부 항목은 최대 20개까지 가능합니다.' });
    }
    const draft = homeworkDb.saveDraft(homeworkId, req.user.id, {
      content: typeof content === 'string' ? content : null,
      attachments: Array.isArray(attachments) ? attachments : null
    });
    res.json({ success: true, draft });
  } catch (err) {
    console.error('homework draft error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/homework/:classId/:homeworkId/submit - 과제 제출
router.post('/:classId/:homeworkId/submit', requireAuth, requireClassMember, (req, res) => {
  try {
    const { content, file_url, file_path, file_name, attachments } = req.body;
    // G2: attachments 배열 길이 제한 (사진10·영상1·링크N·파일N 합산 ≤ 20)
    if (Array.isArray(attachments) && attachments.length > 20) {
      return res.status(400).json({ success: false, message: '첨부 항목은 최대 20개까지 가능합니다.' });
    }
    const result = homeworkDb.submitHomework(parseInt(req.params.homeworkId), req.user.id, {
      content,
      file_path: file_path || file_url || null,
      file_name: file_name || (file_url ? file_url.split('/').pop() : null),
      attachments: Array.isArray(attachments) ? attachments : null    // G2
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
      achievementCode: hw ? hw.achievement_code : null,
      subjectCode: hw ? hw.subject_code : null,
      gradeGroup: hw ? hw.grade_group : null,
      ...extractLogContext(req),
      metadata: {
        subject: hw ? hw.subject_code : null,
        className: hw ? hw.class_name : null
      }
    });
    try { ensureTodayAttendance(parseInt(req.params.classId), req.user.id, 'homework_submit'); } catch (e) {}
    // xAPI: 과제 제출 assignment.finished (학생)
    try {
      xapiSpool.record('assignment', buildAssignment, { userId: req.user.id, classId: parseInt(req.params.classId) }, {
        verb: 'finished',
        assignment_id: parseInt(req.params.homeworkId),
        title: hw ? hw.title : '과제',
        subject_code: hw ? hw.subject_code : null,
        grade_group: hw ? hw.grade_group : null,
        school_level: _hwSchoolLevel(hw && hw.subject_code),
        achievement_codes: hw ? hw.achievement_code : null,
        submission: { content, file_path: file_path || file_url || null },
      });
    } catch (_) {}
    // 클래스 마일리지 자동 지급 — 과제 "최초" 제출에만 (재제출 제외, UNIQUE 제약으로도 보장)
    try {
      if (!result.updated) {
        const { awardClassMileage } = require('../db/class-mileage');
        awardClassMileage(parseInt(req.params.classId), req.user.id, 'homework_submit', parseInt(req.params.homeworkId));
      }
    } catch (_) {}
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
        achievementCode: hw ? hw.achievement_code : null,
        subjectCode: hw ? hw.subject_code : null,
        gradeGroup: hw ? hw.grade_group : null,
        // 채점자(교사) 요청이므로 학생 세션/디바이스는 알 수 없어 기본값만 전달
        ...extractLogContext(req),
        metadata: { subject: hw ? hw.subject_code : null, feedback }
      });
      // xAPI: 과제 채점 assignment.finished (채점 결과 포함, 학생 명의로)
      try {
        xapiSpool.record('assignment', buildAssignment, { userId: submission.student_id, classId: parseInt(req.params.classId) }, {
          verb: 'finished',
          assignment_id: parseInt(req.params.homeworkId),
          title: hw ? hw.title : '과제',
          subject_code: hw ? hw.subject_code : null,
          grade_group: hw ? hw.grade_group : null,
          school_level: _hwSchoolLevel(hw && hw.subject_code),
          achievement_codes: hw ? hw.achievement_code : null,
          submission: { score: normalizedScore, max_score: maxScore, feedback, graded: true },
          success: normalizedScore >= 0.6,
        });
      } catch (_) {}
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
