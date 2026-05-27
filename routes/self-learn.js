// routes/self-learn.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const selfLearnDb = require('../db/self-learn-extended');
const { logLearningActivity } = require('../db/learning-log-helper');
const { awardPoints } = require('../db/point-helper');
const buildNavigation = require('../lib/xapi/builders/navigation');
const buildAssessment = require('../lib/xapi/builders/assessment');
const buildAnnotation = require('../lib/xapi/builders/annotation');
const xapiSpool = require('../lib/xapi/spool');

// 학습맵 노드 → 표준체계 컨텍스트 조회 헬퍼
function _nodeStdContext(nodeId) {
  try {
    const mainDb = require('../db');
    const n = mainDb.prepare('SELECT id, subject_code, grade_group, school_level, label FROM curriculum_content_nodes WHERE id = ?').get(nodeId);
    if (!n) return {};
    return {
      curriculum_standard_ids: n.id,
      subject_code: n.subject_code || null,
      grade_group: n.grade_group || null,
      school_level: n.school_level || null,
      label: n.label,
    };
  } catch { return {}; }
}

// ========== 학습 설정 ==========

router.get('/settings', requireAuth, (req, res) => {
  try {
    const db = require('better-sqlite3')('data/dacheum.db');
    let settings = db.prepare('SELECT * FROM user_learn_settings WHERE user_id = ?').get(req.user.id);
    if (!settings) {
      db.prepare("INSERT INTO user_learn_settings (user_id) VALUES (?)").run(req.user.id);
      settings = db.prepare('SELECT * FROM user_learn_settings WHERE user_id = ?').get(req.user.id);
    }
    try { settings.subjects = JSON.parse(settings.subjects); } catch { settings.subjects = ['국어','수학','사회','과학','영어']; }
    try { settings.difficulty = JSON.parse(settings.difficulty); } catch { settings.difficulty = {}; }
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

router.put('/settings', requireAuth, (req, res) => {
  try {
    const db = require('better-sqlite3')('data/dacheum.db');
    const { school_level, grade, subjects, difficulty } = req.body;
    db.prepare(`
      INSERT INTO user_learn_settings (user_id, school_level, grade, subjects, difficulty, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        school_level = excluded.school_level, grade = excluded.grade,
        subjects = excluded.subjects, difficulty = excluded.difficulty,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, school_level || '초', grade || 4,
      JSON.stringify(subjects || ['국어','수학','사회','과학','영어']),
      JSON.stringify(difficulty || {}));
    res.json({ success: true, message: '설정이 저장되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ========== 오늘의 학습 ==========

// GET /daily — 오늘의 학습 세트 목록
//   학생이면 기본적으로 본인 학년 세트만 반환 (다른 학년 세트 노출 방지).
//   교사/관리자는 필터 없이 전체 조회 허용. 명시적으로 grade를 넘기면 그 값을 우선.
router.get('/daily', requireAuth, (req, res) => {
  try {
    const q = { ...req.query };
    if (!q.grade && req.user.role === 'student' && req.user.grade != null) {
      q.grade = req.user.grade;
    }
    const sets = selfLearnDb.getDailySets(req.user.id, q);
    res.json({ success: true, sets });
  } catch (err) {
    console.error('[SELF-LEARN] daily list error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /daily/stats — 학습 통계
router.get('/daily/stats', requireAuth, (req, res) => {
  try {
    const stats = selfLearnDb.getDailyStats(req.user.id);
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /daily/:setId — 세트 상세
router.get('/daily/:setId', requireAuth, (req, res) => {
  try {
    const detail = selfLearnDb.getDailySetDetail(parseInt(req.params.setId), req.user.id);
    if (!detail) return res.status(404).json({ success: false, message: '학습 세트를 찾을 수 없습니다.' });
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 오늘의 학습 항목 + 콘텐츠 메타 조회 헬퍼 (xAPI 컨텍스트용)
// 주의: contents 스키마는 subject_code/grade_group 가 아니라 subject/grade/school_level 사용
function _loadDailyItemMeta(itemId) {
  try {
    const mainDb = require('../db');
    return mainDb.prepare(`
      SELECT i.id AS item_id, i.set_id, i.content_id,
             c.title, c.content_type, c.subject, c.grade, c.school_level,
             c.achievement_code, c.curriculum_standard_ids
      FROM daily_learning_items i
      LEFT JOIN contents c ON c.id = i.content_id
      WHERE i.id = ?
    `).get(itemId);
  } catch { return null; }
}

// POST /daily/:itemId/start — 학습 시작
router.post('/daily/:itemId/start', requireAuth, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    selfLearnDb.startDailyItem(itemId, req.user.id);
    // xAPI: 오늘의 학습 시작 → navigation(did)
    try {
      const meta = _loadDailyItemMeta(itemId);
      if (meta) {
        xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
          verb: 'did',
          target_id: meta.item_id,
          target_title: meta.title || `학습 항목 ${meta.item_id}`,
          content_type: meta.content_type || null,
          subject_code: meta.subject || null,
          school_level: meta.school_level || null,
          achievement_codes: meta.achievement_code || null,
          curriculum_standard_ids: meta.curriculum_standard_ids || null,
        });
      }
    } catch (e) { console.error('[xapi:daily_start]', e.message); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /daily/:itemId/complete — 학습 완료
router.post('/daily/:itemId/complete', requireAuth, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    selfLearnDb.completeDailyItem(itemId, req.user.id, req.body);
    // xAPI: 오늘의 학습 완료 → navigation(learned). 항목이 평가형(quiz/practice)이면 assessment(submitted) 도 함께 적재
    try {
      const meta = _loadDailyItemMeta(itemId);
      if (meta) {
        const ct = String(meta.content_type || '').toLowerCase();
        const isAssessmentLike = ['quiz', 'exercise', 'practice', 'i', 'p', 'e'].includes(ct);
        const stdCtx = {
          subject_code: meta.subject || null,
          school_level: meta.school_level || null,
          achievement_codes: meta.achievement_code || null,
          curriculum_standard_ids: meta.curriculum_standard_ids || null,
        };
        xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
          verb: 'learned',
          target_id: meta.item_id,
          target_title: meta.title || `학습 항목 ${meta.item_id}`,
          content_type: meta.content_type || null,
          completed: true,
          progress_percent: 100,
          duration_sec: Number(req.body && req.body.duration_seconds) || 0,
          ...stdCtx,
        });
        if (isAssessmentLike) {
          const correct = Number(req.body && (req.body.correct_count != null ? req.body.correct_count : req.body.score)) || 0;
          const total = Number(req.body && (req.body.total_questions != null ? req.body.total_questions : req.body.max_score)) || 0;
          xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
            verb: 'submitted',
            assessment_id: meta.item_id,
            assessment_type: 'practice',  // → 'E' (기타)
            title: meta.title || `학습 항목 ${meta.item_id}`,
            total_score: correct,
            max_score: total,
            duration_seconds: Number(req.body && req.body.duration_seconds) || 0,
            ...stdCtx,
          });
        }
      }
    } catch (e) { console.error('[xapi:daily_complete]', e.message); }
    res.json({ success: true, message: '학습이 완료되었습니다!' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /daily/:itemId/result — 정오답 상세 조회 (학생 본인)
router.get('/daily/:itemId/result', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getDailyItemResult(parseInt(req.params.itemId), req.user.id);
    if (!result) return res.status(404).json({ success: false, message: '항목을 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] daily result error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /daily/:itemId/save-progress — 영상 시청 위치 저장
router.post('/daily/:itemId/save-progress', requireAuth, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const { videoPosition, videoDuration, watchRatio } = req.body;
    const db = require('better-sqlite3')('data/dacheum.db');
    db.prepare(`UPDATE daily_learning_progress
      SET video_position = ?, video_duration = ?, watch_ratio = MAX(COALESCE(watch_ratio,0), ?)
      WHERE item_id = ? AND user_id = ?`
    ).run(videoPosition || 0, videoDuration || 0, watchRatio || 0, itemId, req.user.id);
    db.close();
    // xAPI: 영상 진행 → media(played) — duration 초, completion %
    try {
      const mainDb = require('../db');
      // contents 테이블 컬럼: subject (subject_code 아님), grade, school_level, achievement_code, curriculum_standard_ids
      const meta = mainDb.prepare(`
        SELECT i.set_id, i.content_id,
               c.title, c.content_type, c.subject, c.grade, c.school_level,
               c.achievement_code, c.curriculum_standard_ids
        FROM daily_learning_items i
        LEFT JOIN contents c ON c.id = i.content_id
        WHERE i.id = ?
      `).get(itemId);
      if (meta && meta.content_id) {
        const completionPct = Math.max(0, Math.min(100, Math.round(Number(watchRatio) * 100) || 0));
        xapiSpool.record('media', require('../lib/xapi/builders/media'), { userId: req.user.id }, {
          verb: 'played',
          content_id: meta.content_id,
          title: meta.title || null,
          content_type: meta.content_type || 'video',
          duration_seconds: Number(videoDuration) || 0,
          completion_percent: completionPct,
          completed: completionPct >= 100,
          subject_code: meta.subject || null,
          school_level: meta.school_level || null,
          achievement_codes: meta.achievement_code || null,
          curriculum_standard_ids: meta.curriculum_standard_ids || null,
        });
      }
    } catch (e) { console.error('[xapi:daily_save_progress]', e.message); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// GET /daily/:itemId/get-progress — 영상 시청 위치 조회
router.get('/daily/:itemId/get-progress', requireAuth, (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const db = require('better-sqlite3')('data/dacheum.db');
    const row = db.prepare('SELECT video_position, video_duration, watch_ratio FROM daily_learning_progress WHERE item_id = ? AND user_id = ?').get(itemId, req.user.id);
    db.close();
    res.json({ success: true, progress: row || { video_position: 0, video_duration: 0, watch_ratio: 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// POST /daily/sets — [교사] 학습 세트 생성
router.post('/daily/sets', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.createDailySet(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /daily/sets/:setId — [교사] 학습 세트 수정
router.put('/daily/sets/:setId', requireAuth, (req, res) => {
  try {
    selfLearnDb.updateDailySet(parseInt(req.params.setId), req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /daily/sets/:setId/items — [교사] 학습 항목 추가
router.post('/daily/sets/:setId/items', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.addDailyItem(parseInt(req.params.setId), req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /daily/sets/:setId/items/:itemId — [교사] 학습 항목 삭제
router.delete('/daily/sets/:setId/items/:itemId', requireAuth, (req, res) => {
  try {
    selfLearnDb.removeDailyItem(parseInt(req.params.itemId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== AI 맞춤학습 ==========

// GET /map/nodes — 학습맵 노드 목록 (확장: schoolLevel, semester, area, status, keyword)
// 기본: node_level=3만 반환. includeGroups=true이면 2단계까지 포함
router.get('/map/nodes', requireAuth, (req, res) => {
  try {
    let nodes = selfLearnDb.getMapNodes({ ...req.query, userId: req.user.id });
    const includeGroups = String(req.query.includeGroups || '').toLowerCase() === 'true';
    const parentNodeId = req.query.parentNodeId ? String(req.query.parentNodeId).trim() : '';
    const nodeLevelQ = req.query.nodeLevel ? parseInt(req.query.nodeLevel) : null;
    if (parentNodeId) {
      nodes = nodes.filter(n => n.parent_node_id === parentNodeId);
    } else if (nodeLevelQ === 2) {
      nodes = nodes.filter(n => n.node_level === 2);
    } else if (nodeLevelQ === 3) {
      nodes = nodes.filter(n => n.node_level === 3 || n.node_level == null);
    } else if (!includeGroups) {
      nodes = nodes.filter(n => n.node_level === 3 || n.node_level == null);
    } else {
      nodes = nodes.filter(n => n.node_level == null || n.node_level === 2 || n.node_level === 3);
    }
    res.json({ success: true, nodes });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /map/nodes/:unitId/lessons — 단원(level=2) 노드의 자식 차시(level=3) 목록
// 각 차시의 videos_count, problems_count, user_status 를 포함 (공개 승인된 콘텐츠만 카운트)
router.get('/map/nodes/:unitId/lessons', requireAuth, (req, res) => {
  try {
    const path = require('path');
    const db = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'dacheum.db'));
    const unitId = req.params.unitId;
    const unit = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id = ?').get(unitId);
    if (!unit) {
      return res.status(404).json({ success: false, message: '단원을 찾을 수 없습니다.' });
    }
    const lessons = db.prepare(`
      SELECT n.node_id, n.subject, n.grade, n.semester, n.unit_name, n.lesson_name,
             n.achievement_code, n.node_level, n.parent_node_id, n.sort_order,
             (SELECT COUNT(*) FROM node_contents nc
                JOIN contents c ON nc.content_id = c.id
                WHERE nc.node_id = n.node_id
                  AND c.content_type = 'video'
                  AND c.is_public = 1 AND c.status = 'approved') AS videos_count,
             (SELECT COUNT(*) FROM node_contents nc
                JOIN contents c ON nc.content_id = c.id
                WHERE nc.node_id = n.node_id
                  AND c.content_type IN ('quiz','exam','problem','question','assessment')
                  AND c.is_public = 1 AND c.status = 'approved') AS problems_count,
             COALESCE(uns.status, 'not_started') AS user_status,
             uns.correct_rate AS correct_rate
      FROM learning_map_nodes n
      LEFT JOIN user_node_status uns ON uns.node_id = n.node_id AND uns.user_id = ?
      WHERE n.parent_node_id = ? AND n.node_level = 3
      ORDER BY n.sort_order, n.node_id
    `).all(req.user.id, unitId);

    // progress_percent 계산 (영상 0.5 + 문제 0.5 가중)
    const videoIdsStmt = db.prepare(`
      SELECT c.id FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ? AND c.content_type = 'video'
        AND c.is_public = 1 AND c.status = 'approved'
    `);
    const problemIdsStmt = db.prepare(`
      SELECT c.id FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ?
        AND c.content_type IN ('quiz','exam','problem','question','assessment')
        AND c.is_public = 1 AND c.status = 'approved'
    `);
    const videoRatioStmt = db.prepare(`
      SELECT watch_ratio FROM user_content_progress WHERE user_id = ? AND content_id = ?
    `);
    const problemCorrectStmt = db.prepare(`
      SELECT MAX(is_correct) AS ok FROM problem_attempts WHERE user_id = ? AND content_id = ?
    `);
    for (const lesson of lessons) {
      const videoIds = videoIdsStmt.all(lesson.node_id).map(r => r.id);
      const problemIds = problemIdsStmt.all(lesson.node_id).map(r => r.id);
      const totalV = videoIds.length;
      const totalP = problemIds.length;
      let watchedV = 0, solvedP = 0;
      for (const vid of videoIds) {
        const p = videoRatioStmt.get(req.user.id, vid);
        if (p && (p.watch_ratio || 0) >= 0.8) watchedV++;
      }
      for (const pid of problemIds) {
        const p = problemCorrectStmt.get(req.user.id, pid);
        if (p && p.ok === 1) solvedP++;
      }
      let progress;
      if (totalV === 0 && totalP === 0) {
        if (lesson.user_status === 'completed' || lesson.user_status === 'mastered') progress = 100;
        else if (lesson.user_status === 'in_progress') progress = 30;
        else progress = 0;
      } else if (totalV === 0) {
        progress = Math.round((solvedP / totalP) * 100);
      } else if (totalP === 0) {
        progress = Math.round((watchedV / totalV) * 100);
      } else {
        progress = Math.round((watchedV / totalV) * 50 + (solvedP / totalP) * 50);
      }
      lesson.videos_watched = watchedV;
      lesson.videos_total = totalV;
      lesson.problems_solved = solvedP;
      lesson.problems_total = totalP;
      lesson.progress_percent = Math.max(0, Math.min(100, progress));
    }
    res.json({ success: true, unit, lessons });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/:unitId/lessons error:', err && (err.stack || err.message || err));
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', debug: String(err && (err.message || err)) });
  }
});

// GET /map/nodes/:nodeId — 노드 상세 (확장 응답: videos, problems, userStatus)
router.get('/map/nodes/:nodeId', requireAuth, (req, res) => {
  try {
    const detail = selfLearnDb.getMapNodeDetail(req.params.nodeId, req.user.id);
    if (!detail) return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });

    // 진단 흐름용 폴백: problems가 비어 있고 ?withFallbackProblems=1이면 자식/closure로 보충
    const wantFallback = String(req.query.withFallbackProblems || '') === '1';
    if (wantFallback && (!detail.problems || detail.problems.length === 0)) {
      try {
        const fallback = selfLearnDb.collectFallbackProblems
          ? selfLearnDb.collectFallbackProblems(req.params.nodeId, req.user.id, 10)
          : null;
        if (Array.isArray(fallback) && fallback.length) {
          detail.problems = fallback;
          detail.problems_source = 'fallback';
        }
      } catch (_) { /* 폴백 실패 시 그대로 진행 */ }
    }
    res.json({ success: true, ...detail });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/:id error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /map/edges — 노드 간 관계
router.get('/map/edges', requireAuth, (req, res) => {
  try {
    let edges = selfLearnDb.getMapEdges(req.query);
    const edgeType = String(req.query.edgeType || '').toLowerCase();
    if (edgeType === 'unit') {
      edges = edges.filter(e => e.edge_type === 'unit_prerequisite');
    } else if (edgeType === 'all') {
      // 전부
    } else {
      // 기본: 차시(prerequisite)만
      edges = edges.filter(e => e.edge_type === 'prerequisite' || e.edge_type == null);
    }
    res.json({ success: true, edges });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /map/user-status — 사용자 노드 상태
router.get('/map/user-status', requireAuth, (req, res) => {
  try {
    const statuses = selfLearnDb.getUserNodeStatuses(req.user.id);
    res.json({ success: true, statuses });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /map/nodes/:nodeId/start — 차시 학습 시작 (status 승격)
router.post('/map/nodes/:nodeId/start', requireAuth, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const path = require('path');
    const db = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'dacheum.db'));

    const node = db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) {
      db.close();
      return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });
    }

    // 교사 세션은 no-op
    if (req.user.role === 'teacher') {
      const existing = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?').get(req.user.id, nodeId);
      const prevStatus = existing ? existing.status : 'not_started';
      db.close();
      return res.json({ success: true, status: prevStatus, prevStatus, changed: false });
    }

    const existing = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?').get(req.user.id, nodeId);
    const prevStatus = existing ? existing.status : 'not_started';
    const terminal = new Set(['in_progress', 'completed', 'mastered']);

    let nextStatus = prevStatus;
    let changed = false;
    if (!existing || prevStatus === 'not_started' || prevStatus === 'available') {
      nextStatus = 'in_progress';
      db.prepare(`
        INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at)
        VALUES (?, ?, 'in_progress', CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, node_id) DO UPDATE SET
          status = 'in_progress',
          last_accessed_at = CURRENT_TIMESTAMP
      `).run(req.user.id, nodeId);
      changed = true;
    } else if (terminal.has(prevStatus)) {
      // no-op
      console.log(`[self-learn] /map/nodes/${nodeId}/start no-op (prevStatus=${prevStatus}, user=${req.user.id})`);
    }

    db.close();
    // xAPI: AI 맞춤학습 차시 노드 진입 navigation.did
    try {
      const ctxN = _nodeStdContext(nodeId);
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
        verb: changed ? 'did' : 'viewed',
        lesson_id: nodeId,
        title: ctxN.label || `차시 ${nodeId}`,
        source: 'ai_custom_learning',
        ...ctxN,
      });
    } catch (_) {}
    res.json({ success: true, status: nextStatus, prevStatus, changed });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/start error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /map/nodes/:nodeId/diagnose-complete — 노드 클릭 시 간이 진단 완료 처리
router.post('/map/nodes/:nodeId/diagnose-complete', requireAuth, (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    const db = require('better-sqlite3')('data/dacheum.db');

    const node = db.prepare('SELECT node_id FROM learning_map_nodes WHERE node_id = ?').get(nodeId);
    if (!node) {
      db.close();
      return res.status(404).json({ success: false, message: '노드를 찾을 수 없습니다.' });
    }

    const existing = db.prepare('SELECT status FROM user_node_status WHERE user_id = ? AND node_id = ?').get(req.user.id, nodeId);
    const terminalStates = new Set(['completed', 'diagnosed', 'mastered']);

    let finalStatus;
    if (existing && terminalStates.has(existing.status)) {
      // 이미 완료된 노드면 덮어쓰지 않음
      finalStatus = existing.status;
    } else {
      finalStatus = 'diagnosed';
      db.prepare(`
        INSERT INTO user_node_status (user_id, node_id, status, last_accessed_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, node_id) DO UPDATE SET
          status = excluded.status,
          last_accessed_at = CURRENT_TIMESTAMP
      `).run(req.user.id, nodeId, finalStatus);

      // 간단한 진단 세션 기록 (mode='quick')
      try {
        db.prepare(`
          INSERT INTO diagnosis_sessions
            (user_id, target_node_id, diagnosis_type, status, total_questions, correct_count, completed_at)
          VALUES (?, ?, 'quick', 'completed', 0, 0, CURRENT_TIMESTAMP)
        `).run(req.user.id, nodeId);
      } catch (e) {
        // 세션 기록 실패는 무시 (상태 갱신이 주 목적)
      }
    }

    const videosCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ? AND c.content_type = 'video'
    `).get(nodeId).cnt;
    const problemsCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM node_contents nc JOIN contents c ON nc.content_id = c.id
      WHERE nc.node_id = ? AND c.content_type IN ('quiz','exam','problem','assessment','question')
    `).get(nodeId).cnt;

    db.close();
    res.json({
      success: true,
      status: finalStatus,
      videos_count: videosCount,
      problems_count: problemsCount
    });
  } catch (err) {
    console.error('[SELF-LEARN] map/nodes/diagnose-complete error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/start — 진단 시작 (CAT: targetNodeId 있으면 BFS+난이도 조절 모드)
// GET /diagnosis/history
//   ?nodeId=...              → 본인의 해당 노드 진단 이력 (최근 5건 + 가장 최근 완료 결과) — 기존 호환
//   ?all=1[&subject=&grade=] → 본인의 최근 진단 10건 (학생 친화 결과 화면용, B4)
router.get('/diagnosis/history', requireAuth, (req, res) => {
  try {
    const nodeId = req.query.nodeId;
    const allMode = String(req.query.all || '') === '1'
      || !!req.query.subject || !!req.query.grade;

    // B4: ?all=1 (또는 subject/grade) — 사용자의 최근 진단 10건 + 한글 라벨 + 상대시간
    if (allMode) {
      const list = selfLearnDb.listDiagnosisHistory(req.user.id, {
        subject: req.query.subject || null,
        grade: req.query.grade ? Number(req.query.grade) : null,
        limit: req.query.limit ? Number(req.query.limit) : 10
      });
      return res.json({ success: true, history: list });
    }

    // 기존 호환: nodeId 단일 노드 이력
    if (!nodeId) return res.status(400).json({ success: false, message: 'nodeId 또는 all=1 필요' });
    const path = require('path');
    const sqlite = require('better-sqlite3');
    const dbPath = path.join(__dirname, '..', 'data', 'dacheum.db');
    const db = sqlite(dbPath);
    const recent = db.prepare(`
      SELECT id, target_node_id, status, total_questions, correct_count,
             started_at, completed_at, result, diagnosis_type
      FROM diagnosis_sessions
      WHERE user_id = ? AND target_node_id = ?
      ORDER BY id DESC LIMIT 5
    `).all(req.user.id, nodeId);
    const lastCompleted = recent.find(r => r.status === 'completed');
    const lastInProgress = recent.find(r => r.status === 'in_progress');
    db.close();
    res.json({
      success: true,
      sessions: recent,
      lastCompleted: lastCompleted || null,
      lastInProgress: lastInProgress || null,
      hasAnyHistory: recent.length > 0,
      hasCompleted: !!lastCompleted
    });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/history error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/diagnosis/start', requireAuth, (req, res) => {
  try {
    // 교사·관리자는 학생 기록을 만들지 않음 — 데모/시연용 응답만 반환
    if (req.user.role === 'teacher' || req.user.role === 'admin') {
      return res.json({ success: true, skipped: true, reason: 'teacher_no_record', sessionId: null, queue: [], targetNode: null, question: null });
    }
    const { targetNodeId, nodeId, mode } = req.body || {};
    // targetNodeId 또는 mode='cat'일 경우 CAT 시작
    if (targetNodeId || mode === 'cat') {
      const result = selfLearnDb.startDiagnosisCAT(req.user.id, { ...req.body, targetNodeId: targetNodeId || nodeId });
      return res.json({ success: true, ...result });
    }
    const result = selfLearnDb.startDiagnosis(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/start error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/:sessionId/answer — 진단 문항 응답 (CAT 지원)
router.post('/diagnosis/:sessionId/answer', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const session = require('../db/index').prepare('SELECT diagnosis_type FROM diagnosis_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    }
    if (session.diagnosis_type === 'cat') {
      const result = selfLearnDb.submitDiagnosisAnswerCAT(sessionId, req.body || {});
      return res.json({ success: true, ...result });
    }
    const result = selfLearnDb.submitDiagnosisAnswer(sessionId, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/answer error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '진단 응답 처리 중 오류가 발생했습니다.',
      detail: String(err && err.message || err)
    });
  }
});

// GET /diagnosis/:sessionId/next — 다음 문항 1개 반환
router.get('/diagnosis/:sessionId/next', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const result = selfLearnDb.getNextDiagnosisQuestion(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '세션 없음' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/next error:', err);
    res.status(500).json({ success: false, message: '서버 오류', detail: String(err && err.message || err) });
  }
});

// POST /diagnosis/:sessionId/drill-down — 실패 노드의 선수노드를 큐에 추가 (CAT)
router.post('/diagnosis/:sessionId/drill-down', requireAuth, (req, res) => {
  try {
    const { failedNodeId } = req.body || {};
    const result = selfLearnDb.drillDownDiagnosis(parseInt(req.params.sessionId), failedNodeId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/drill-down error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({ success: false, message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// POST /diagnosis/:sessionId/submit-sheet — 진단지(시트) 단위 일괄 응답 (v2 신규)
//   body: { answers: [{ questionId, lessonId, userAnswer, contentId? }, ...] }
//   응답: { nodePassed, correctRate, results, nextAction, sheet(자동 다음 단원), recommendActions, queueRemainingHydrated, ... }
router.post('/diagnosis/:sessionId/submit-sheet', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const session = require('../db/index').prepare(
      'SELECT user_id FROM diagnosis_sessions WHERE id = ?'
    ).get(sessionId);
    if (!session) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '본인 세션이 아닙니다.' });
    }
    const result = selfLearnDb.submitDiagnosisSheet(sessionId, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/submit-sheet error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '진단지 제출 처리 중 오류가 발생했습니다.',
      detail: String(err && err.message || err)
    });
  }
});

// POST /diagnosis/:sessionId/retry-node — 현재 노드를 새 진단지로 다시 진단 (v2 신규)
//   응답: { currentNodeId, sheet, sheetSize, queueRemainingHydrated, queueOrderHydrated }
router.post('/diagnosis/:sessionId/retry-node', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ success: false, message: 'sessionId 형식 오류' });
    }
    const session = require('../db/index').prepare(
      'SELECT user_id FROM diagnosis_sessions WHERE id = ?'
    ).get(sessionId);
    if (!session) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '본인 세션이 아닙니다.' });
    }
    const result = selfLearnDb.retryDiagnosisNode(sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/retry-node error:', err);
    const status = err && err.statusCode ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? '필수 파라미터가 누락되었습니다.' : '재진단 처리 중 오류가 발생했습니다.',
      detail: String(err && err.message || err)
    });
  }
});

// GET /diagnosis/:sessionId/state — 현재 세션 상태 조회
router.get('/diagnosis/:sessionId/state', requireAuth, (req, res) => {
  try {
    const state = selfLearnDb.getDiagnosisState(parseInt(req.params.sessionId));
    if (!state) return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('[SELF-LEARN] diagnosis/state error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /diagnosis/:sessionId/finish — 진단 완료
//   v2: body로 endReason ('user_decided_to_learn' 등) 받아 difficulty_path 마지막 항목에 보존
router.post('/diagnosis/:sessionId/finish', requireAuth, (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const endReason = (req.body && req.body.endReason) || null;
    if (endReason) {
      // difficulty_path JSON 끝에 종료 사유 메타 추가 (마이그레이션 없이 보존)
      try {
        const mainDb = require('../db/index');
        const row = mainDb.prepare('SELECT difficulty_path FROM diagnosis_sessions WHERE id = ?').get(sessionId);
        if (row) {
          let path = [];
          try { path = JSON.parse(row.difficulty_path || '[]'); } catch {}
          path.push({ _endReason: endReason, _at: new Date().toISOString() });
          mainDb.prepare('UPDATE diagnosis_sessions SET difficulty_path = ? WHERE id = ?')
            .run(JSON.stringify(path), sessionId);
        }
      } catch (e) { console.error('[diagnosis/finish] endReason 저장 실패', e.message); }
    }
    const result = selfLearnDb.finishDiagnosis(sessionId);
    if (!result) return res.status(404).json({ success: false, message: '진단 세션을 찾을 수 없습니다.' });
    if (endReason) result.endReason = endReason;
    // xAPI: 진단평가 완료 → assessment(submitted) + assessment-type='D'
    try {
      const mainDb = require('../db');
      const sess = mainDb.prepare(`
        SELECT ds.id, ds.user_id, ds.target_node_id, ds.total_questions, ds.correct_count, ds.started_at, ds.completed_at,
               lmn.lesson_name, lmn.unit_name, lmn.subject, lmn.grade
        FROM diagnosis_sessions ds
        LEFT JOIN learning_map_nodes lmn ON lmn.node_id = ds.target_node_id
        WHERE ds.id = ?
      `).get(sessionId);
      if (sess) {
        const stdCtx = _nodeStdContext(sess.target_node_id);
        const total = sess.total_questions || result.totalQuestions || 0;
        const correct = sess.correct_count || result.correctCount || 0;
        // 시작/종료 시간 차이로 duration 산정 (없으면 0)
        let durationSec = 0;
        try {
          if (sess.started_at) {
            const start = new Date(sess.started_at).getTime();
            const end = sess.completed_at ? new Date(sess.completed_at).getTime() : Date.now();
            durationSec = Math.max(0, Math.round((end - start) / 1000));
          }
        } catch {}
        xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
          verb: 'submitted',
          assessment_id: sessionId,
          assessment_type: 'diagnostic',  // → 'D'
          title: '진단평가' + (sess.lesson_name ? ` — ${sess.lesson_name}` : ''),
          total_score: correct,
          max_score: total,
          duration_seconds: durationSec,
          curriculum_standard_ids: sess.target_node_id || stdCtx.curriculum_standard_ids || null,
          subject_code: stdCtx.subject_code || null,
          grade_group: stdCtx.grade_group || null,
          school_level: stdCtx.school_level || null,
        });
      }
    } catch (e) { console.error('[xapi:diagnosis_finish]', e.message); }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /diagnosis/:sessionId/result — 진단 결과
router.get('/diagnosis/:sessionId/result', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getDiagnosisResult(parseInt(req.params.sessionId));
    if (!result) return res.status(404).json({ success: false, message: '진단 결과를 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /path/generate — 학습 경로 생성
router.post('/path/generate', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.generateLearningPath(req.user.id, req.body || {});
    // path 배열을 최상위 필드로도 노출 (프론트 호환: data.path)
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] path/generate error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// GET /path/current — 현재 학습 경로
router.get('/path/current', requireAuth, (req, res) => {
  try {
    const path = selfLearnDb.getCurrentPath(req.user.id);
    // 프론트 호환: data.path 를 steps 배열로도 제공
    res.json({ success: true, path: path ? path.steps : null, raw: path });
  } catch (err) {
    console.error('[SELF-LEARN] path/current error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /node/:nodeId/complete — 노드 학습 완료
router.post('/node/:nodeId/complete', requireAuth, (req, res) => {
  try {
    selfLearnDb.completeNode(req.user.id, req.params.nodeId);
    res.json({ success: true, message: '학습 노드를 완료했습니다!' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /dashboard — 학습 대시보드
// 빈 상태/null KPI 정규화: 프론트가 "—" 대신 "0개/0%/0분/-위" 친화 표기로 분기 가능
router.get('/dashboard', requireAuth, (req, res) => {
  try {
    const d = selfLearnDb.getLearningDashboard(req.user.id) || {};
    const totalSolved = d.total_solved || 0;
    const totalUsers = d.total_users || 0;
    const safe = {
      ...d,
      // 숫자 필드 null → 0 정규화
      totalNodes: d.totalNodes || 0,
      completedNodes: d.completedNodes || 0,
      inProgressNodes: d.inProgressNodes || 0,
      total_solved: totalSolved,
      total_attempts: d.total_attempts || totalSolved,
      avg_accuracy: d.avg_accuracy || 0,
      progress_percent: d.progress_percent || 0,
      progressPercent: d.progressPercent || 0,
      streak: d.streak || 0,
      total_time_minutes: d.total_time_minutes || 0,
      // rank는 의미상 null 유지 (미정의), 표시용 텍스트 별도 제공
      rank: d.rank ?? null,
      rank_display: d.rank ? `${d.rank}위` : '아직 순위 없음',
      total_users: totalUsers,
      area_stats: d.area_stats || [],
      recent_problems: d.recent_problems || [],
      // 빈 상태 분기 메타 (프론트에서 "—" 대신 안내 메시지 분기)
      has_attempts: totalSolved > 0,
      has_video_watched: (d.total_time_minutes || 0) > 0,
      has_completed_nodes: (d.completedNodes || 0) > 0,
      has_ranking_data: totalUsers >= 2,
      empty_message: totalSolved === 0
        ? '아직 학습 활동이 없어요. 첫 문제를 풀어보세요!'
        : null
    };
    res.json({ success: true, ...safe });
  } catch (err) {
    console.error('[SELF-LEARN] dashboard error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /ranking — 랭킹
// 빈 결과 시 명확한 안내 메시지 + 본인 순위(myRank) 함께 반환
router.get('/ranking', requireAuth, (req, res) => {
  try {
    const rankings = selfLearnDb.getRanking(req.query) || [];
    const myIndex = rankings.findIndex(r => r.id === req.user.id);
    const myRank = myIndex >= 0 ? myIndex + 1 : null;
    const total = rankings.length;
    let message = null;
    if (total === 0) message = '아직 랭킹 데이터가 없어요. 첫 학습을 시작해보세요!';
    else if (total === 1) message = '함께 학습하는 친구가 더 생기면 랭킹이 풍부해져요!';
    res.json({
      success: true,
      rankings,
      total,
      myRank,
      myRank_display: myRank ? `${myRank}위` : '아직 순위 없음',
      period: req.query.period || 'all',
      empty: total === 0,
      message
    });
  } catch (err) {
    console.error('[SELF-LEARN] ranking error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 오답노트 확장 ==========

// GET /wrong-notes — 오답 목록
router.get('/wrong-notes', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.getWrongNotesExtended(req.user.id, req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /wrong-notes/dashboard — 오답 대시보드
router.get('/wrong-notes/dashboard', requireAuth, (req, res) => {
  try {
    const dashboard = selfLearnDb.getWrongNoteDashboard(req.user.id);
    res.json({ success: true, ...dashboard });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /wrong-notes/teacher-dashboard — [교사] 교사용 오답 대시보드
router.get('/wrong-notes/teacher-dashboard', requireAuth, (req, res) => {
  try {
    const classId = req.query.classId ? parseInt(req.query.classId) : null;
    const dashboard = selfLearnDb.getTeacherWrongNoteDashboard(classId, req.user.id);
    res.json({ success: true, ...dashboard });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /wrong-notes/manual — 수동 오답 등록
router.post('/wrong-notes/manual', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.addManualWrongNote(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /wrong-notes/:id/tags — 오답 태그 수정
router.put('/wrong-notes/:id/tags', requireAuth, (req, res) => {
  try {
    selfLearnDb.updateWrongNoteTags(parseInt(req.params.id), req.user.id, req.body.tags);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /wrong-notes/:id/retry — 오답 재도전
router.post('/wrong-notes/:id/retry', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.retryWrongNote(parseInt(req.params.id), req.user.id, req.body);
    if (!result) return res.status(404).json({ success: false, message: '오답을 찾을 수 없습니다.' });
    // xAPI: 오답 재도전 annotation.annotated + assessment.submitted
    try {
      const correct = req.body && req.body.is_correct ? 1 : 0;
      xapiSpool.record('annotation', buildAnnotation, { userId: req.user.id }, {
        verb: 'annotated',
        annotation_id: parseInt(req.params.id),
        target_type: 'wrong_note',
        target_id: parseInt(req.params.id),
        annotation_kind: 'retry',
        response: req.body && (req.body.note || req.body.answer) || null,
      });
      xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
        verb: 'submitted',
        assessment_id: parseInt(req.params.id),
        title: '오답 재도전',
        assessment_type: 'self_check',
        target_kind: 'quiz',
        score: { raw: correct, max: 1 },
        success: !!correct,
        source: 'wrong_note_retry',
      });
    } catch (_) {}
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 나만의 문제집 ==========

// GET /problem-sets — 문제집 목록
router.get('/problem-sets', requireAuth, (req, res) => {
  try {
    const sets = selfLearnDb.getProblemSets(req.user.id);
    res.json({ success: true, sets });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets — 문제집 생성
router.post('/problem-sets', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.createProblemSet(req.user.id, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /problem-sets/:id — 문제집 상세
router.get('/problem-sets/:id', requireAuth, (req, res) => {
  try {
    const detail = selfLearnDb.getProblemSetDetail(parseInt(req.params.id), req.user.id);
    if (!detail) return res.status(404).json({ success: false, message: '문제집을 찾을 수 없습니다.' });
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/default/add — "기타(미지정)" 문제집에 자동 추가 (없으면 생성)
router.post('/problem-sets/default/add', requireAuth, (req, res) => {
  try {
    const DEFAULT_TITLE = '기타(미지정)';
    const contentId = parseInt(req.body.contentId);
    if (!contentId) return res.status(400).json({ success: false, message: 'contentId가 필요합니다.' });
    const sets = selfLearnDb.getProblemSets(req.user.id);
    let target = sets.find(s => s.title === DEFAULT_TITLE);
    if (!target) {
      const created = selfLearnDb.createProblemSet(req.user.id, { title: DEFAULT_TITLE, description: '바로 풀기로 자동 추가된 문항 모음' });
      target = { id: created.id, title: DEFAULT_TITLE };
    }
    const addResult = selfLearnDb.addProblemSetItem(target.id, contentId);
    // 이미 있었으면 addResult.success === false 지만 오류는 아님
    res.json({ success: true, problemSetId: target.id, added: addResult.success === true, alreadyExists: addResult.success === false });
  } catch (err) {
    console.error('default add error:', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// POST /problem-sets/:id/items — 문제집에 문항 추가
router.post('/problem-sets/:id/items', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.addProblemSetItem(parseInt(req.params.id), req.body.contentId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /problem-sets/:id/items/:itemId — 문제집에서 문항 제거
router.delete('/problem-sets/:id/items/:itemId', requireAuth, (req, res) => {
  try {
    selfLearnDb.removeProblemSetItem(parseInt(req.params.id), parseInt(req.params.itemId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/:id/start — 문제집 풀기 시작
router.post('/problem-sets/:id/start', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.startProblemSet(parseInt(req.params.id), req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/:id/submit — 문제집 제출
router.post('/problem-sets/:id/submit', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.submitProblemSet(parseInt(req.params.id), req.user.id, req.body);
    // xAPI: 나의 문제집 제출 assessment.submitted
    try {
      const raw = (result && (result.correct_count || 0)) || 0;
      const max = (result && (result.total_questions || 0)) || 0;
      xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
        verb: 'submitted',
        assessment_id: parseInt(req.params.id),
        title: (result && result.title) || '나의 문제집',
        assessment_type: 'self_check',
        target_kind: 'quiz',
        score: { raw, max },
        success: max > 0 && (raw / max) >= 0.6,
        source: 'my_problem_set',
      });
    } catch (_) {}
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /problem-sets/:id/reorder — 문제집 아이템 순서 변경
router.post('/problem-sets/:id/reorder', requireAuth, (req, res) => {
  try {
    const db = require('better-sqlite3')('data/dacheum.db');
    const { order } = req.body; // [{id, sort_order}]
    if (Array.isArray(order)) {
      const stmt = db.prepare('UPDATE problem_set_items SET sort_order = ? WHERE id = ? AND problem_set_id = ?');
      order.forEach(o => stmt.run(o.sort_order, o.id, parseInt(req.params.id)));
    }
    db.close();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ========== P0: 문제 시도 / 영상 진행도 / 학습목록 / 이어하기 / 오류신고 ==========

// POST /problem-attempt — 문제 풀이 시도 기록 (별칭, body에 contentId 포함)
router.post('/problem-attempt', requireAuth, (req, res) => {
  try {
    // 교사·관리자는 학생 기록(content_question_attempts/problem_attempts)에 누적하지 않음
    if (req.user.role === 'teacher' || req.user.role === 'admin') {
      return res.json({ success: true, skipped: true, reason: 'teacher_no_record' });
    }
    const { contentId, content_id, isCorrect, is_correct, selectedAnswer, userAnswer, user_answer, answer, questionId, question_id, timeTaken, time_taken, nodeId, node_id } = req.body || {};
    const cid = parseInt(contentId || content_id);
    if (!cid) return res.status(400).json({ success: false, message: 'contentId 필요' });
    const result = selfLearnDb.recordProblemAttempt(req.user.id, cid, {
      isCorrect: !!(isCorrect ?? is_correct),
      selectedAnswer: selectedAnswer ?? user_answer ?? userAnswer,
      userAnswer: userAnswer ?? user_answer,
      answer,
      questionId: questionId || question_id,
      timeTaken: timeTaken || time_taken,
      nodeId: nodeId || node_id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] problem-attempt error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /video-progress — 영상 진행도 저장 (별칭, body에 contentId 포함)
router.post('/video-progress', requireAuth, (req, res) => {
  try {
    const { contentId, content_id, positionSec, position_sec, durationSec, duration_sec, nodeId, node_id } = req.body || {};
    const cid = parseInt(contentId || content_id);
    if (!cid) return res.status(400).json({ success: false, message: 'contentId 필요' });
    const result = selfLearnDb.recordVideoProgress(req.user.id, cid, {
      positionSec: parseInt(positionSec ?? position_sec) || 0,
      durationSec: parseInt(durationSec ?? duration_sec) || 0,
      nodeId: nodeId || node_id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] video-progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /contents/:contentId/attempt — 문제 풀이 시도 기록
router.post('/contents/:contentId/attempt', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.contentId);
    const { isCorrect, selectedAnswer, userAnswer, answer, questionId, timeTaken, nodeId } = req.body || {};
    // 서버에서 서버 정답 판정 (questionId 있을 때)
    const result = selfLearnDb.recordProblemAttempt(req.user.id, contentId, {
      isCorrect: !!isCorrect,   // questionId 없을 때 호환성 fallback
      selectedAnswer, userAnswer, answer, questionId, timeTaken, nodeId
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] contents/attempt error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', detail: String(err && err.message || err) });
  }
});

// POST /contents/:contentId/video-progress — 비디오 시청 진행도 저장
router.post('/contents/:contentId/video-progress', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.contentId);
    const { positionSec, durationSec, nodeId } = req.body || {};
    const result = selfLearnDb.recordVideoProgress(req.user.id, contentId, {
      positionSec: parseInt(positionSec) || 0,
      durationSec: parseInt(durationSec) || 0,
      nodeId
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] contents/video-progress error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /contents/:contentId/report — 콘텐츠 오류 신고
router.post('/contents/:contentId/report', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.contentId);
    const { reason, details, contentType } = req.body || {};
    const result = selfLearnDb.reportContent(req.user.id, contentId, { reason, details, contentType });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[SELF-LEARN] contents/report error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /learning-list — 내 학습목록(watch list)
router.get('/learning-list', requireAuth, (req, res) => {
  try {
    const items = selfLearnDb.getLearningList(req.user.id);
    res.json({ success: true, items });
  } catch (err) {
    console.error('[SELF-LEARN] learning-list get error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /learning-list — 학습목록에 노드 추가
router.post('/learning-list', requireAuth, (req, res) => {
  try {
    const { nodeId } = req.body || {};
    if (!nodeId) return res.status(400).json({ success: false, message: 'nodeId 필요' });
    const result = selfLearnDb.addLearningList(req.user.id, nodeId);
    res.json(result);
  } catch (err) {
    console.error('[SELF-LEARN] learning-list add error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /learning-list/:nodeId — 학습목록에서 제거
router.delete('/learning-list/:nodeId', requireAuth, (req, res) => {
  try {
    const result = selfLearnDb.removeLearningList(req.user.id, req.params.nodeId);
    res.json(result);
  } catch (err) {
    console.error('[SELF-LEARN] learning-list remove error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /last-activity — 마지막 학습 활동(이어하기)
router.get('/last-activity', requireAuth, (req, res) => {
  try {
    const activity = selfLearnDb.getLastActivity(req.user.id);
    res.json({ success: true, activity });
  } catch (err) {
    console.error('[SELF-LEARN] last-activity error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
