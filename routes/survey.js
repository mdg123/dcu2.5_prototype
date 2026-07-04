const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const surveyDb = require('../db/survey');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const { ensureTodayAttendance } = require('../db/attendance');
const buildSurvey = require('../lib/xapi/builders/survey');
const xapiSpool = require('../lib/xapi/spool');

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
      page: parseInt(req.query.page) || 1,
      userId: req.user.id
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
      // 익명 설문이면 응답자 신원(user_id/display_name/username)을 제거해 전달(집계는 유지)
      responses = surveyDb.getResponses(survey.id, !!survey.is_anonymous);
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
    // ── 응답 게이트: 대상 설문이 응답 가능한 상태·기간인지 서버에서 재검증(FE 버튼 숨김 우회 차단) ──
    const surveyId = parseInt(req.params.surveyId);
    const target = surveyDb.getSurveyById(surveyId);
    if (!target || target.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '설문을 찾을 수 없습니다.' });
    }
    // 진행 중(active)만 응답 허용 — 초안(draft)·마감(closed)·보관(archived) 거부
    if (target.status !== 'active') {
      return res.status(403).json({ success: false, message: '지금은 응답할 수 없는 설문입니다.' });
    }
    // 응답 기간 종료(end_date 경과) 거부
    if (target.end_date && new Date(target.end_date).getTime() < Date.now()) {
      return res.status(403).json({ success: false, message: '응답 기간이 종료된 설문입니다.' });
    }
    const result = surveyDb.submitResponse(surveyId, req.user.id, req.body.answers);
    if (!result.success) return res.status(409).json({ success: false, message: '이미 응답한 설문입니다.' });
    logLearningActivity({
      userId: req.user.id,
      activityType: 'survey_respond',
      targetType: 'survey',
      targetId: req.params.surveyId,
      classId: parseInt(req.params.classId),
      verb: 'responded',
      sourceService: 'class',
      ...extractLogContext(req)
    });
    try { ensureTodayAttendance(parseInt(req.params.classId), req.user.id, 'survey_respond'); } catch (e) {}
    // 클래스 마일리지 자동 지급 — 설문 참여 (1회만, UNIQUE로 중복 차단)
    try {
      const { awardClassMileage } = require('../db/class-mileage');
      awardClassMileage(parseInt(req.params.classId), req.user.id, 'survey_submit', parseInt(req.params.surveyId));
    } catch (e) { console.error('[mileage:survey_submit]', e.message); }
    // xAPI: 설문 응답 → survey(responded) — comprehension-survey (기본 일반 설문)
    try {
      // 상단 게이트에서 조회한 target 재사용(중복 쿼리 방지)
      const survey = target;
      // 응답 정규화: { questionId, answer } 또는 { score } 형태 모두 수용
      const answers = req.body.answers;
      let responses = [];
      if (Array.isArray(answers)) {
        responses = answers.map((a, idx) => ({
          question_id: a.question_id != null ? a.question_id : (a.questionId != null ? a.questionId : (idx + 1)),
          question_type: a.question_type || 'likert',
          answer: typeof a.answer === 'number' ? a.answer : (typeof a.value === 'number' ? a.value : null),
          score: typeof a.score === 'number' ? a.score : (typeof a.answer === 'number' ? a.answer : null),
        }));
      } else if (answers && typeof answers === 'object') {
        responses = Object.entries(answers).map(([k, v]) => ({
          question_id: k,
          question_type: 'likert',
          answer: typeof v === 'number' ? v : null,
          score: typeof v === 'number' ? v : null,
        }));
      }
      xapiSpool.record('survey', buildSurvey, { userId: req.user.id, classId: parseInt(req.params.classId) }, {
        verb: 'responded',
        survey_id: surveyId,
        survey_kind: 'comprehension',
        title: survey && survey.title || null,
        responses,
      });
    } catch (e) { console.error('[xapi:survey_submit]', e.message); }
    res.json({ success: true, message: '설문이 제출되었습니다.' });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

module.exports = router;
