// routes/curriculum.js
// 교육과정 메타데이터 API
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const curriculumDb = require('../db/curriculum');

// GET /api/curriculum/subjects — 교과 목록
router.get('/subjects', requireAuth, (req, res) => {
  try {
    const { school_level } = req.query;
    if (school_level) {
      const subjects = curriculumDb.getSubjectsBySchoolLevel(school_level);
      return res.json({ success: true, data: subjects });
    }
    const subjects = curriculumDb.getSubjects();
    res.json({ success: true, data: subjects });
  } catch (err) {
    console.error('[교육과정] subjects error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/grade-groups?subject_code=math-e — 해당 교과의 학년군 목록
router.get('/grade-groups', requireAuth, (req, res) => {
  try {
    const { subject_code } = req.query;
    if (!subject_code) {
      return res.status(400).json({ success: false, message: 'subject_code가 필요합니다.' });
    }
    const gradeGroups = curriculumDb.getGradeGroups(subject_code);
    res.json({ success: true, data: gradeGroups });
  } catch (err) {
    console.error('[교육과정] grade-groups error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/areas?subject_code=math-e&grade_group=4 — 영역 목록
router.get('/areas', requireAuth, (req, res) => {
  try {
    const { subject_code, grade_group } = req.query;
    if (!subject_code) {
      return res.status(400).json({ success: false, message: 'subject_code가 필요합니다.' });
    }
    const areas = curriculumDb.getAreas(subject_code, grade_group ? parseInt(grade_group) : null);
    res.json({ success: true, data: areas });
  } catch (err) {
    console.error('[교육과정] areas error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/standards — 성취기준 목록 (필터링)
router.get('/standards', requireAuth, (req, res) => {
  try {
    const { subject_code, grade_group, school_level, area, search } = req.query;
    const standards = curriculumDb.getStandards({
      subjectCode: subject_code,
      gradeGroup: grade_group ? parseInt(grade_group) : null,
      schoolLevel: school_level,
      area,
      search: search || null
    });
    res.json({ success: true, data: standards, total: standards.length });
  } catch (err) {
    console.error('[교육과정] standards error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/standards/:code — 단일 성취기준 조회
router.get('/standards/:code', requireAuth, (req, res) => {
  try {
    const standard = curriculumDb.getStandardByCode(decodeURIComponent(req.params.code));
    if (!standard) {
      return res.status(404).json({ success: false, message: '성취기준을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: standard });
  } catch (err) {
    console.error('[교육과정] standard detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
