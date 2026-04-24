const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const lessonDb = require('../db/lesson');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const { ensureTodayAttendance } = require('../db/attendance');
const buildNavigation = require('../lib/xapi/builders/navigation');
const buildMedia = require('../lib/xapi/builders/media');
const xapiSpool = require('../lib/xapi/spool');

function requireClassMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  next();
}

// GET /api/lesson/:classId/board-stats - 수업 게시판 통계
router.get('/:classId/board-stats', requireAuth, requireClassMember, (req, res) => {
  try {
    const stats = lessonDb.getLessonBoardStats(req.classId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lesson/:classId/board - 수업 게시판 목록 (풍부한 정보)
router.get('/:classId/board', requireAuth, requireClassMember, (req, res) => {
  try {
    const { status, search, sort, page } = req.query;
    const showAll = req.myRole === 'owner' || req.user.role === 'admin';
    const result = lessonDb.getLessonBoardList(req.classId, {
      status: showAll ? status : 'active',
      search,
      sort,
      page: parseInt(page) || 1,
      userId: req.user.id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[LESSON] board error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lesson/:classId - 수업 목록 (이수율 포함)
router.get('/:classId', requireAuth, requireClassMember, (req, res) => {
  try {
    const { status, page } = req.query;
    const result = lessonDb.getLessonsByClassWithProgress(req.classId, req.user.id, {
      status: req.myRole === 'owner' ? status : 'published',
      page: parseInt(page) || 1
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[LESSON] list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lesson/:classId/completion-rate - 클래스 전체 이수율
router.get('/:classId/completion-rate', requireAuth, requireClassMember, (req, res) => {
  try {
    // 교사/개설자일 경우: 전체 학생 평균 이수율
    if (req.myRole === 'owner' || req.user.role === 'teacher') {
      const classDb = require('../db/class');
      const members = classDb.getClassMembers(req.classId).filter(m => m.role === 'member');
      if (members.length === 0) return res.json({ success: true, rate: 0 });
      let totalRate = 0;
      members.forEach(m => {
        totalRate += lessonDb.getClassCompletionStats(req.classId, m.user_id);
      });
      return res.json({ success: true, rate: Math.round(totalRate / members.length) });
    }
    // 학생: 본인 이수율
    const rate = lessonDb.getClassCompletionStats(req.classId, req.user.id);
    res.json({ success: true, rate });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lesson/:classId - 수업 생성 (콘텐츠 연결 포함)
router.post('/:classId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 수업을 생성할 수 있습니다.' });
    }
    const { title, content, description, lesson_date, start_date, end_date, estimated_minutes, lesson_order, status, content_ids, subject_code, grade_group, achievement_code, school_level, tags, theme, classify_mode } = req.body;
    if (!title) return res.status(400).json({ success: false, message: '수업 제목을 입력하세요.' });
    const lesson = lessonDb.createLesson(req.classId, req.user.id, { title, content, description, lesson_date, start_date, end_date, estimated_minutes, lesson_order, status, subject_code, grade_group, achievement_code, school_level, tags, theme, classify_mode });
    // 콘텐츠 연결
    if (content_ids && Array.isArray(content_ids)) {
      content_ids.forEach((cid, i) => lessonDb.addContentToLesson(lesson.id, cid, i));
    }
    res.status(201).json({ success: true, lesson });
  } catch (err) {
    console.error('[LESSON] create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lesson/:classId/:lessonId - 수업 상세 (연결 콘텐츠 + 진도)
router.get('/:classId/:lessonId', requireAuth, requireClassMember, (req, res) => {
  try {
    const lessonId = parseInt(req.params.lessonId);
    const lesson = lessonDb.getLessonById(lessonId);
    if (!lesson || lesson.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '수업을 찾을 수 없습니다.' });
    }
    const attachments = lessonDb.getAttachments(lesson.id);
    const contents = lessonDb.getLessonContents(lesson.id);
    const progress = lessonDb.getLessonProgress(req.user.id, lesson.id);
    try { ensureTodayAttendance(req.classId, req.user.id, 'lesson_view'); } catch (e) {}
    res.json({ success: true, lesson, attachments, contents, progress });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lesson/:classId/:lessonId/contents - 수업에 콘텐츠 추가
router.post('/:classId/:lessonId/contents', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const { content_id, sort_order } = req.body;
    if (!content_id) return res.status(400).json({ success: false, message: '콘텐츠를 선택하세요.' });
    const added = lessonDb.addContentToLesson(parseInt(req.params.lessonId), content_id, sort_order || 0);
    if (!added) return res.status(409).json({ success: false, message: '이미 추가된 콘텐츠입니다.' });
    res.json({ success: true, message: '콘텐츠가 추가되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/lesson/:classId/:lessonId/contents/:contentId - 수업에서 콘텐츠 제거
router.delete('/:classId/:lessonId/contents/:contentId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    lessonDb.removeContentFromLesson(parseInt(req.params.lessonId), parseInt(req.params.contentId));
    res.json({ success: true, message: '콘텐츠가 제거되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/lesson/:classId/:lessonId/students - 학생별 이수 현황 (교사용)
router.get('/:classId/:lessonId/students', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: '교사만 조회할 수 있습니다.' });
    }
    const students = lessonDb.getLessonStudentProgress(parseInt(req.params.lessonId), req.classId);
    res.json({ success: true, students });
  } catch (err) {
    console.error('[LESSON] students progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/lesson/:classId/:lessonId/progress - 학습 진도 업데이트
router.post('/:classId/:lessonId/progress', requireAuth, requireClassMember, (req, res) => {
  try {
    const { content_id, progress_percent, completed, last_position, duration_sec } = req.body;
    if (content_id) {
      lessonDb.updateContentProgress(req.user.id, content_id, parseInt(req.params.lessonId), { progress_percent, completed, last_position });
    }
    // 수업 메타 조회하여 교과/성취기준 연동
    let lessonMeta = null;
    try { lessonMeta = lessonDb.getLessonById(parseInt(req.params.lessonId)); } catch (_) {}
    logLearningActivity({
      userId: req.user.id,
      activityType: 'lesson_progress',
      targetType: 'lesson',
      targetId: req.params.lessonId,
      classId: parseInt(req.params.classId),
      verb: progress_percent >= 100 ? 'completed' : 'progressed',
      sourceService: 'class',
      resultScore: progress_percent ? progress_percent / 100 : null,
      achievementCode: lessonMeta ? lessonMeta.achievement_code : null,
      subjectCode: lessonMeta ? lessonMeta.subject_code : null,
      gradeGroup: lessonMeta ? lessonMeta.grade_group : null,
      durationSec: duration_sec ? parseInt(duration_sec) : null,
      ...extractLogContext(req),
      metadata: { contentId: content_id, progress: progress_percent }
    });
    // xAPI: 수업 진도 (navigation + media)
    try {
      const sl = (lessonMeta && lessonMeta.subject_code || '').endsWith('-e') ? '초'
        : (lessonMeta && lessonMeta.subject_code || '').endsWith('-m') ? '중'
        : (lessonMeta && lessonMeta.subject_code || '').endsWith('-h') ? '고' : null;
      const commonStd = {
        subject_code: lessonMeta ? lessonMeta.subject_code : null,
        grade_group: lessonMeta ? lessonMeta.grade_group : null,
        school_level: sl,
        achievement_codes: lessonMeta ? lessonMeta.achievement_code : null,
        curriculum_standard_ids: lessonMeta ? lessonMeta.curriculum_standard_ids : null,
      };
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id, classId: parseInt(req.params.classId) }, {
        verb: completed || progress_percent >= 100 ? 'finished' : 'did',
        lesson_id: parseInt(req.params.lessonId),
        title: lessonMeta ? lessonMeta.title : '수업',
        progress_percent: progress_percent || null,
        duration_sec: duration_sec ? parseInt(duration_sec) : null,
        ...commonStd,
      });
      if (content_id) {
        xapiSpool.record('media', buildMedia, { userId: req.user.id, classId: parseInt(req.params.classId) }, {
          verb: completed ? 'finished' : 'played',
          content_id: content_id,
          title: lessonMeta ? lessonMeta.title : null,
          progress_percent: progress_percent || null,
          duration_sec: duration_sec ? parseInt(duration_sec) : null,
          last_position: last_position || null,
          ...commonStd,
        });
      }
    } catch (_) {}
    res.json({ success: true });
  } catch (err) {
    console.error('[lesson progress]', err.message);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/lesson/:classId/:lessonId - 수업 수정 (콘텐츠 재구성 포함)
router.put('/:classId/:lessonId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const lessonId = parseInt(req.params.lessonId);
    const { content_ids, ...lessonData } = req.body;
    const lesson = lessonDb.updateLesson(lessonId, lessonData);

    // content_ids가 전달되면 기존 콘텐츠를 모두 제거 후 새로 연결
    if (content_ids && Array.isArray(content_ids)) {
      // 기존 연결 콘텐츠 가져와서 모두 제거
      const existing = lessonDb.getLessonContents(lessonId);
      existing.forEach(c => lessonDb.removeContentFromLesson(lessonId, c.id));
      // 새 콘텐츠 연결
      content_ids.forEach((cid, i) => lessonDb.addContentToLesson(lessonId, cid, i));
    }

    res.json({ success: true, lesson });
  } catch (err) {
    console.error('[LESSON] update error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/lesson/:classId/:lessonId - 수업 삭제
router.delete('/:classId/:lessonId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    lessonDb.deleteLesson(parseInt(req.params.lessonId));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
