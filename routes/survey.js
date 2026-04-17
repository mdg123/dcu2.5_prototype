const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const surveyDb = require('../db/survey');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');

function requireMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  req.myRole = classDb.getMemberRole(classId, req.user.id);
  next();
}

router.get('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    const result = surveyDb.getSurveysByClass(req.classId, {
      status: req.myRole === 'owner' ? req.query.status : 'active',
      page: parseInt(req.query.page) || 1
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/:classId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 설문을 생성할 수 있습니다.' });
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    const survey = surveyDb.createSurvey(req.classId, req.user.id, req.body);
    res.status(201).json({ success: true, survey });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.get('/:classId/:surveyId', requireAuth, requireMember, (req, res) => {
  try {
    const survey = surveyDb.getSurveyById(parseInt(req.params.surveyId));
    if (!survey || survey.class_id !== req.classId) return res.status(404).json({ success: false, message: '설문을 찾을 수 없습니다.' });

    let response = null;
    let responses = null;
    if (req.myRole === 'owner') {
      responses = surveyDb.getResponses(survey.id);
    }
    response = surveyDb.getResponse(survey.id, req.user.id);
    res.json({ success: true, survey, response, responses });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.put('/:classId/:surveyId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    const survey = surveyDb.updateSurvey(parseInt(req.params.surveyId), req.body);
    res.json({ success: true, survey });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.delete('/:classId/:surveyId', requireAuth, requireMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    surveyDb.deleteSurvey(parseInt(req.params.surveyId));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

router.post('/:classId/:surveyId/submit', requireAuth, requireMember, (req, res) => {
  try {
    if (!req.body.answers) return res.status(400).json({ success: false, message: '응답을 입력하세요.' });
    const result = surveyDb.submitResponse(parseInt(req.params.surveyId), req.user.id, req.body.answers);
    if (!result.success) return res.status(409).json({ success: false, message: '이미 응답한 설문입니다.' });
    logLearningActivity({
      userId: req.user.id,
      activityType: 'survey_respond',
      targetType: 'survey',
      targetId: req.params.surveyId,
      classId: parseInt(req.params.classId),
      verb: 'responded',
      sourceService: 'class'
    });
    res.json({ success: true, message: '설문이 제출되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

module.exports = router;
