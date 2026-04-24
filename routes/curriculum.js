// routes/curriculum.js
// 교육과정 메타데이터 API
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const curriculumDb = require('../db/curriculum');
const db = require('../db');

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

// ─────────────────────────────────────────────────────────────
// 교육과정 표준체계(curriculum_content_nodes) 기반 신규 조회 API
// ─────────────────────────────────────────────────────────────

// GET /api/curriculum/content-nodes
//   쿼리: subject_code, grade_group, school_level, depth, parent_id, root(=1 이면 depth=0만)
//   반환: [{ id, subject_code, school_level, grade_group, depth, parent_id, label, sort_order, source }]
router.get('/content-nodes', requireAuth, (req, res) => {
  try {
    const { subject_code, grade_group, school_level, depth, parent_id, root, search } = req.query;
    const where = [];
    const params = [];
    if (subject_code) { where.push('subject_code = ?'); params.push(subject_code); }
    if (grade_group) { where.push('grade_group = ?'); params.push(parseInt(grade_group)); }
    if (school_level) { where.push('school_level = ?'); params.push(school_level); }
    if (depth != null && depth !== '') { where.push('depth = ?'); params.push(parseInt(depth)); }
    if (parent_id) { where.push('parent_id = ?'); params.push(parent_id); }
    if (root === '1' || root === 'true') { where.push('depth = 0'); }
    if (search) { where.push('(label LIKE ? OR id LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const sql = `SELECT id, subject_code, school_level, grade_group, depth, parent_id, label, sort_order, source
                 FROM curriculum_content_nodes
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY subject_code, grade_group, depth, sort_order, id
                 LIMIT 5000`;
    const nodes = db.prepare(sql).all(...params);
    res.json({ success: true, data: nodes, total: nodes.length });
  } catch (err) {
    console.error('[교육과정] content-nodes error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/content-nodes/:id/ancestors
//   특정 노드의 조상 체인(자신 포함) — depth 오름차순
router.get('/content-nodes/:id/ancestors', requireAuth, (req, res) => {
  try {
    const id = req.params.id;
    const rows = db.prepare(`
      SELECT n.id, n.subject_code, n.school_level, n.grade_group, n.depth,
             n.parent_id, n.label, n.sort_order, n.source, d.depth_diff
      FROM curriculum_node_descendants d
      JOIN curriculum_content_nodes n ON n.id = d.ancestor_id
      WHERE d.descendant_id = ?
      ORDER BY n.depth
    `).all(id);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[교육과정] ancestors error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/content-nodes/:id/descendants
//   특정 노드의 자손 전체 (closure 테이블 활용)
router.get('/content-nodes/:id/descendants', requireAuth, (req, res) => {
  try {
    const id = req.params.id;
    const rows = db.prepare(`
      SELECT n.id, n.subject_code, n.school_level, n.grade_group, n.depth,
             n.parent_id, n.label, n.sort_order, n.source, d.depth_diff
      FROM curriculum_node_descendants d
      JOIN curriculum_content_nodes n ON n.id = d.descendant_id
      WHERE d.ancestor_id = ? AND d.depth_diff > 0
      ORDER BY d.depth_diff, n.sort_order, n.id
    `).all(id);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[교육과정] descendants error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/standards/:code/levels
//   성취수준 (A~E) 조회
router.get('/standards/:code/levels', requireAuth, (req, res) => {
  try {
    const code = decodeURIComponent(req.params.code);
    const rows = db.prepare(
      'SELECT level_code, description FROM curriculum_standard_levels WHERE standard_code = ? ORDER BY level_code'
    ).all(code);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[교육과정] standard levels error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/standards/:code/nodes
//   성취기준이 매핑된 내용요소 노드들 (N:N)
router.get('/standards/:code/nodes', requireAuth, (req, res) => {
  try {
    const code = decodeURIComponent(req.params.code);
    const rows = db.prepare(`
      SELECT n.id, n.subject_code, n.school_level, n.grade_group, n.depth,
             n.parent_id, n.label, n.source
      FROM curriculum_standard_nodes sn
      JOIN curriculum_content_nodes n ON n.id = sn.node_id
      WHERE sn.standard_code = ?
      ORDER BY n.depth, n.sort_order
    `).all(code);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[교육과정] standard nodes error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/curriculum/std-id-map?code=[4국01-01]  또는  ?std_id=E4KORA01B01C01
//   성취기준코드 ↔ 표준체계ID 양방향 매핑
router.get('/std-id-map', requireAuth, (req, res) => {
  try {
    const { code, std_id, subject_code, grade_group } = req.query;
    const where = [];
    const params = [];
    if (code) { where.push('standard_code = ?'); params.push(code); }
    if (std_id) { where.push('std_id = ?'); params.push(std_id); }
    if (subject_code) { where.push('subject_code = ?'); params.push(subject_code); }
    if (grade_group) { where.push('grade_group = ?'); params.push(parseInt(grade_group)); }
    if (!where.length) {
      return res.status(400).json({ success: false, message: 'code 또는 std_id 가 필요합니다.' });
    }
    const rows = db.prepare(
      `SELECT standard_code, std_id, subject_code, grade_group
       FROM curriculum_std_id_map WHERE ${where.join(' AND ')} LIMIT 500`
    ).all(...params);
    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('[교육과정] std-id-map error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
