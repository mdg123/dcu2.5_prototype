const express = require('express');
const router = express.Router();
const { requireAuth, optionalAuth } = require('../middleware/auth');
const contentDb = require('../db/content');
// ── 콘텐츠 열람 권한 판정 SSOT (lib/auth/can-view-content.js) ──────────────────
//   [P0-2 보안 fix — 2026-08-05] `GET /api/contents/:id` 가 is_public/status/creator_id 를
//   전혀 보지 않아, 학생이 남의 draft·pending·rejected 콘텐츠를 200 으로 읽었다.
//   문항 콘텐츠면 questions[].answer·explanation 까지 나갔다(검수 전 정답 노출).
//   판정을 이 파일에 인라인으로 적으면 업로드 파일 가드(lib/uploads-access.js)가
//   같은 판정을 또 복사해야 한다 → 실체는 lib 하나로 두고 여기선 호출만 한다.
const { canViewContent, loadContentForAuth } = require('../lib/auth/can-view-content');
// ── 정답·해설 비노출 판정 SSOT (lib/strip-answers.js) ─────────────────────────
//   getContentById 는 quiz/exam 콘텐츠에 content_questions 를 SELECT * 로 붙인다
//   (= answer·explanation 포함). 화면에서 안 그려도 네트워크 응답에는 그대로 실렸다.
//   판정을 여기 인라인으로 적으면 routes/lesson.js·routes/exam.js 가 같은 판정을
//   또 복사한다 → 실체는 lib 하나. (INV-AE4 소스 락이 사본을 금지)
const { stripContentAnswers, stripAnswers } = require('../lib/strip-answers');
const { removeOrphanUploads } = require('../lib/uploads-access');
const featuredDb = require('../db/featured');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const buildAssessment = require('../lib/xapi/builders/assessment');
const buildQuery = require('../lib/xapi/builders/query');
const buildNavigation = require('../lib/xapi/builders/navigation');
const buildMedia = require('../lib/xapi/builders/media');
const xapiSpool = require('../lib/xapi/spool');

// 콘텐츠 메타 → AIDT 표준 컨텍스트 변환 헬퍼
// 주의: contents 스키마 컬럼명: subject / grade / school_level / achievement_code / curriculum_standard_ids
function _contentXapiCtx(content) {
  if (!content) return {};
  return {
    subject_code: content.subject || null,
    school_level: content.school_level || null,
    achievement_codes: content.achievement_code || null,
    curriculum_standard_ids: content.curriculum_standard_ids || null,
  };
}

// ===== 내자료 폴더 =====
router.get('/folders', requireAuth, (req, res) => {
  try { res.json({ success: true, folders: contentDb.getMyFolders(req.user.id) }); }
  catch { res.status(500).json({ success: false, message: '서버 오류' }); }
});

router.post('/folders', requireAuth, (req, res) => {
  try {
    if (!req.body.name?.trim()) return res.status(400).json({ success: false, message: '폴더 이름을 입력하세요.' });
    const folder = contentDb.createMyFolder(req.user.id, req.body.name.trim());
    res.status(201).json({ success: true, folder });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ success: false, message: '이미 같은 이름의 폴더가 있습니다.' });
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

router.delete('/folders/:id', requireAuth, (req, res) => {
  try {
    const ok = contentDb.deleteMyFolder(req.user.id, parseInt(req.params.id));
    res.json({ success: true, deleted: ok });
  } catch { res.status(500).json({ success: false, message: '서버 오류' }); }
});

router.post('/move-to-folder', requireAuth, (req, res) => {
  try {
    const ok = contentDb.moveContentToFolder(parseInt(req.body.contentId), req.body.folderId ? parseInt(req.body.folderId) : null, req.user.id);
    res.json({ success: true, moved: ok });
  } catch { res.status(500).json({ success: false, message: '서버 오류' }); }
});

// GET /api/contents - 공개 콘텐츠 검색
// 상세 검색 6항목(adv_*): adv_title, adv_keywords(공백/쉼표로 분리), adv_author, adv_source, adv_from, adv_to
router.get('/', requireAuth, (req, res) => {
  try {
    const { keyword, subject, grade, content_type, page, limit, sort, achievement_codes, curriculum_standard_ids, std_ids,
            adv_title, adv_keywords, adv_author, adv_source, adv_from, adv_to } = req.query;

    const adv = (adv_title || adv_keywords || adv_author || adv_source || adv_from || adv_to) ? {
      title: adv_title || null,
      keywords: adv_keywords ? String(adv_keywords).split(/[\s,]+/).map(s => s.trim()).filter(Boolean) : [],
      author: adv_author || null,
      source: adv_source || null,
      dateFrom: adv_from || null,
      dateTo: adv_to || null
    } : null;

    const result = contentDb.searchPublicContents({
      keyword, subject,
      grade: grade ? parseInt(grade) : null,
      content_type,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 12,
      sort,
      achievement_codes: achievement_codes ? achievement_codes.split(',').filter(Boolean) : null,
      curriculum_standard_ids: curriculum_standard_ids ? curriculum_standard_ids.split(',').filter(Boolean) : null,
      std_ids: std_ids ? String(std_ids).split(',').map(s => s.trim()).filter(Boolean) : null,
      adv
    });
    // xAPI: 공개콘텐츠 검색 query.searched
    try {
      xapiSpool.record('query', buildQuery, { userId: req.user.id }, {
        verb: 'searched',
        query_id: 'public-content-search',
        query_text: keyword || '',
        subject_code: subject || null,
        grade_group: grade ? parseInt(grade) : null,
        curriculum_standard_ids,
        achievement_codes,
        filters: { content_type: content_type || null, sort: sort || 'latest' },
        result_count: (result && (result.total || (result.contents && result.contents.length))) || 0,
      });
    } catch (_) {}
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CONTENT] search error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/search-for-lesson - 수업용 콘텐츠 검색 (자기 콘텐츠 + 공개 콘텐츠)
router.get('/search-for-lesson', requireAuth, (req, res) => {
  try {
    const { keyword, content_type, subject, grade } = req.query;
    const contents = contentDb.searchContentsForLesson(req.user.id, {
      keyword: keyword || '',
      content_type: content_type || null,
      subject: subject || null,
      grade: grade || null,
      limit: parseInt(req.query.limit) || 20
    });
    res.json({ success: true, contents });
  } catch (err) {
    console.error('[CONTENT] search-for-lesson error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/activity-trend - 내 콘텐츠 활동 추이 (실제 데이터)
router.get('/activity-trend', requireAuth, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const metric = req.query.metric || 'views'; // views, shares, saves
    const trend = contentDb.getActivityTrend(req.user.id, days, metric);
    res.json({ success: true, trend });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/popular-tags - 인기 태그 (공개 콘텐츠 기준 집계)
router.get('/popular-tags', requireAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    const tags = contentDb.getPopularTags(limit);
    res.json({ success: true, tags });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/suggested-keywords - 관리자 등록 추천 키워드 (카테고리별 그룹화)
// 공개: 비로그인 포털에서도 안내 칩으로 노출 가능 → optionalAuth
// 응답:
//   {
//     success,
//     categories: [
//       { id, name, slug, color, icon, display_order,
//         keywords: [{ id, keyword, search_query, description, ... }] }
//     ],
//     total
//   }
//
// 카테고리 마스터(suggested_kw_categories)가 있으면 그 메타로 그룹화·정렬,
// 없으면(미마이그레이션) 기존 자유 텍스트 카테고리만으로 그룹화 + 폴백 메타 부여.
//
// 대상별 노출 필터(2026-05-08):
//   카테고리 단위 target_* 와 키워드 단위 target_* 를 AND 로 적용 (기획서 A.1).
router.get('/suggested-keywords', optionalAuth, (req, res) => {
  try {
    const db = require('../db/index');

    // ----- 카테고리 마스터 존재 여부 -----
    const masterTableExists = !!db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='suggested_kw_categories'`
    ).get();

    // ----- 키워드 행 (활성만) -----
    const kwRows = db.prepare(`
      SELECT id, keyword, COALESCE(category, '기타') AS category,
             COALESCE(search_query, keyword) AS search_query,
             description, display_order,
             target_school_levels, target_roles, target_grades, target_subjects
      FROM suggested_keywords
      WHERE is_active = 1
      ORDER BY display_order ASC, id ASC
    `).all();

    // ----- 카테고리 마스터 (활성만) — 미존재 시 빈 배열 -----
    const catRows = masterTableExists ? db.prepare(`
      SELECT id, name, slug, color, icon, display_order,
             target_school_levels, target_roles, target_grades, target_subjects
      FROM suggested_kw_categories
      WHERE is_active = 1
      ORDER BY display_order ASC, id ASC
    `).all() : [];

    // ----- 대상별 노출 필터 헬퍼 -----
    function parseArr(text) {
      if (text === null || text === undefined || text === '') return null;
      try {
        const v = JSON.parse(text);
        if (!Array.isArray(v) || v.length === 0) return null;
        return v;
      } catch { return null; }
    }
    const user = req.user || null;
    function matchesTarget(row) {
      const levels = parseArr(row.target_school_levels);
      const roles  = parseArr(row.target_roles);
      const grades = parseArr(row.target_grades);
      // 비로그인 — 어떤 차원이라도 비어있지 않으면 미노출 (안전)
      if (!user) {
        return levels === null && roles === null && grades === null;
      }
      if (levels !== null) {
        if (!user.school_level || !levels.includes(user.school_level)) return false;
      }
      if (roles !== null) {
        if (!user.role || !roles.includes(user.role)) return false;
      }
      if (grades !== null) {
        const g = parseInt(user.grade, 10);
        if (!Number.isInteger(g) || !grades.includes(g)) return false;
      }
      return true;
    }

    // ----- 카테고리 단위 1차 필터 -----
    const allowedCatNames = new Set();
    const catMetaByName = new Map(); // name -> { id, slug, color, icon, display_order }
    for (const c of catRows) {
      if (!matchesTarget(c)) continue;
      allowedCatNames.add(c.name);
      catMetaByName.set(c.name, {
        id: c.id,
        name: c.name,
        slug: c.slug,
        color: c.color,
        icon: c.icon,
        display_order: c.display_order,
      });
    }

    // ----- 키워드 단위 2차 필터 + 카테고리 1차 필터 적용 -----
    const filtered = kwRows.filter(row => {
      // 키워드 노출 대상 필터
      if (!matchesTarget(row)) return false;
      // 마스터가 존재하는데 해당 카테고리가 마스터에 없거나 비활성/노출대상 미부합이면 제외
      if (masterTableExists) {
        if (!allowedCatNames.has(row.category)) return false;
      }
      return true;
    });

    // ----- 그룹화 -----
    const grouped = new Map(); // name -> { meta, keywords[] }
    for (const r of filtered) {
      let meta = catMetaByName.get(r.category);
      if (!meta) {
        // 마스터 미존재 또는 마스터에 없는 카테고리 (마스터 미마이그레이션 폴백 경로)
        meta = {
          id: null,
          name: r.category,
          slug: null,
          color: '#2563eb',
          icon: 'fa-bookmark',
          display_order: 9999,
        };
      }
      if (!grouped.has(r.category)) {
        grouped.set(r.category, { meta, keywords: [] });
      }
      grouped.get(r.category).keywords.push({
        id: r.id,
        keyword: r.keyword,
        search_query: r.search_query,
        description: r.description || null,
        display_order: r.display_order,
      });
    }

    // ----- 카테고리 정렬: 마스터 display_order ASC, 폴백은 뒤로 -----
    const categories = Array.from(grouped.values())
      .sort((a, b) => {
        const oa = (a.meta.display_order ?? 9999);
        const ob = (b.meta.display_order ?? 9999);
        if (oa !== ob) return oa - ob;
        return String(a.meta.name).localeCompare(String(b.meta.name), 'ko');
      })
      .map(({ meta, keywords }) => ({
        id: meta.id,
        name: meta.name,
        slug: meta.slug,
        color: meta.color,
        icon: meta.icon,
        display_order: meta.display_order,
        keywords,
      }));

    res.json({ success: true, categories, total: filtered.length });
  } catch (err) {
    console.error('[CONTENT] suggested-keywords error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/recommendations - 추천 콘텐츠
// 비로그인 포털에서도 인기 콘텐츠 노출이 가능하도록 optionalAuth 적용.
//   - 로그인 시: 역할/학년/교과 기반 개인화 추천
//   - 비로그인: 인기/조회수 상위 공개 콘텐츠 (3순위 fallback이 자동 처리)
// query: keywords (CSV), limit, role (student|teacher|parent|staff|admin), grade, subject
router.get('/recommendations', optionalAuth, (req, res) => {
  try {
    const keywords = req.query.keywords ? req.query.keywords.split(',').filter(Boolean) : [];
    const limit = parseInt(req.query.limit) || 12;

    // 우선 query 파라미터 적용, 없으면 user 프로필에서 자동 보강 (로그인 시에만)
    let { role, grade, subject } = req.query;
    if (req.user) {
      if (!role) role = req.user.role;
      if (role === 'student' && !grade && req.user.grade) grade = req.user.grade;
      if (role === 'teacher' && !grade && req.user.grade) grade = req.user.grade;
    }

    const opts = {
      role: role || null,
      grade: grade ? parseInt(grade) : null,
      subject: subject || null
    };
    // 비로그인 시 userId=0 — creator_id != 0 필터는 모든 콘텐츠 통과시킴
    const userId = req.user ? req.user.id : 0;
    const contents = contentDb.getRecommendations(userId, limit, keywords, opts);
    res.json({ success: true, contents, applied: opts });
  } catch (err) {
    console.error('[CONTENT] recommendations error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/featured - 추천콘텐츠 페이지(뷰어) 통합 응답
// spec_admin_featured_curation.md D-1
// 활성 섹션 + 슬롯 + 폴백 적용 → 단일 호출로 4섹션 모두 반환
router.get('/featured', optionalAuth, (req, res) => {
  try {
    const data = featuredDb.getFeaturedForViewer({ user: req.user || null });
    res.json(data);
  } catch (err) {
    console.error('[CONTENT] featured error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/pending - 승인 대기 콘텐츠 (교사/관리자)
router.get('/pending', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const result = contentDb.getPendingContents({ page: parseInt(req.query.page) || 1 });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/approve - 콘텐츠 승인
router.post('/:id/approve', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.approveContent(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '콘텐츠가 승인되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/reject - 콘텐츠 반려
router.post('/:id/reject', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.rejectContent(parseInt(req.params.id), req.body.reason);
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '콘텐츠가 반려되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/hold - 콘텐츠 보류
router.post('/:id/hold', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.holdContent(parseInt(req.params.id), req.body.reason);
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '콘텐츠가 보류되었습니다.' });
  } catch (err) {
    console.error('[CONTENT] hold error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/review - 콘텐츠 검토중으로 변경
router.post('/:id/review', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const content = contentDb.reviewContent(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, content, message: '검토 상태로 변경되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/review-all - 전체 검토 대상 콘텐츠 (승인관리용)
router.get('/review-all', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '관리자만 접근 가능합니다.' });
    }
    const result = contentDb.getAllReviewContents({
      page: parseInt(req.query.page) || 1,
      status: req.query.status || 'all'
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/my - 내 콘텐츠
router.get('/my', requireAuth, (req, res) => {
  try {
    const result = contentDb.getMyContents(req.user.id, {
      page: parseInt(req.query.page) || 1,
      limit: req.query.limit ? parseInt(req.query.limit) : undefined
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents - 콘텐츠 생성
router.post('/', requireAuth, (req, res) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: '제목을 입력하세요.' });
    if (typeof req.body.tags === 'string') {
      req.body.tags = req.body.tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    // 서버에서 status 결정 (클라이언트 값 무시)
    if (req.body.is_public) {
      req.body.status = req.user.role === 'admin' ? 'approved' : 'pending';
    } else {
      req.body.status = 'draft';
    }
    const content = contentDb.createContent(req.user.id, req.body);

    // 수업꾸러미: package_items 저장
    if (req.body.bundle_items && Array.isArray(req.body.bundle_items) && content.id) {
      contentDb.saveBundleItems(content.id, req.body.bundle_items);
    }

    // 평가지: quiz_content_ids에서 문항 복사
    if (req.body.quiz_content_ids && Array.isArray(req.body.quiz_content_ids) && content.id) {
      const db = require('../db/index');
      let qNum = 1;
      for (const srcContentId of req.body.quiz_content_ids) {
        try {
          const questions = db.prepare('SELECT * FROM content_questions WHERE content_id = ? ORDER BY question_number').all(srcContentId);
          for (const q of questions) {
            db.prepare('INSERT INTO content_questions (content_id, question_number, question_text, question_type, options, answer, explanation, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
              content.id, qNum++, q.question_text, q.question_type || 'multiple_choice', q.options, q.answer, q.explanation, q.points || 10
            );
          }
        } catch (e) { console.error('[CONTENT] quiz copy error:', e.message); }
      }
    }

    // questions 직접 전달된 경우 (문항 직접 만들기)
    if (req.body.questions && Array.isArray(req.body.questions) && content.id) {
      const db = require('../db/index');
      req.body.questions.forEach((q, i) => {
        db.prepare(`INSERT INTO content_questions
          (content_id, question_number, question_text, question_type, options, answer, explanation, points, difficulty, instruction, passage, media_url, media_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          content.id, i + 1,
          q.question_text || q.text || '',
          q.question_type || q.type || 'multiple_choice',
          typeof q.options === 'string' ? q.options : JSON.stringify(q.options || []),
          // 🔴 answer 는 **반드시 문자열로** 바인딩한다.
          //   better-sqlite3 는 JS number 를 REAL 로 바인딩하고, answer 컬럼은 TEXT affinity 라
          //   REAL 0 이 `'0.0'` 으로 저장된다(실측: 0→'0.0', 1→'1.0').
          //   채점기는 `String(given) === String(q.answer)` 문자열 비교라 학생이 보낸 0-based
          //   인덱스 `'0'` 과 `'0.0'` 이 영영 안 맞아 **첫 보기가 정답인 문항이 전부 오답**이 된다.
          //   (2026-04-09 시드가 JS number 를 그대로 넘겨 11건이 이렇게 굳었다 —
          //    보고서/증적/정답키정합_20260821/)
          //   숫자 외 타입(단답형 문자열 등)은 손대지 않는다.
          ((v) => (typeof v === 'number' ? String(v) : v))(
            q.answer ?? q.correct_index ?? q.correctIndex ?? q.answer_index ?? 0
          ),
          q.explanation || '',
          q.points || 10,
          q.difficulty || 3,
          q.instruction || null,
          q.passage || null,
          q.media_url || null,
          q.media_type || null
        );
      });
    }

    res.status(201).json({ success: true, content });
  } catch (err) {
    console.error('[CONTENT] create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/:id - 콘텐츠 상세
//   ★ 열람 게이트(P0-2). 공개 승인본 / 작성자 / admin / 이용 근거(수업·오늘의학습·평가·
//     문제세트·보관함·꾸러미) 보유자만. 그 외 403 — 본문(file_path·description·questions)은
//     한 조각도 내보내지 않는다.
router.get('/:id', requireAuth, (req, res) => {
  try {
    const content = contentDb.getContentById(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    if (!canViewContent(req.user, content)) {
      return res.status(403).json({ success: false, message: '이 콘텐츠를 볼 권한이 없습니다.' });
    }
    contentDb.incrementViewCount(content.id);
    logLearningActivity({
      userId: req.user.id,
      activityType: 'content_view',
      targetType: 'content',
      targetId: req.params.id,
      verb: 'accessed',
      sourceService: 'content',
      achievementCode: content.achievement_code || null,
      subjectCode: content.subject_code || null,
      gradeGroup: content.grade_group || null,
      ...extractLogContext(req)
    });
    // xAPI: 콘텐츠 상세 조회 → navigation(viewed) — content_type 에 따라 image/document/practice/etc-content 자동 분기
    try {
      const stdCtx = _contentXapiCtx(content);
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id }, {
        verb: 'viewed',
        content_id: content.id,
        title: content.title,
        content_type: content.content_type || null,
        ...stdCtx,
      });
    } catch (e) { console.error('[xapi:content_view]', e.message); }
    const isCollected = contentDb.isInCollection(req.user.id, content.id);
    // ★ 정답 비노출: 학생(=풀기 전)에게는 questions[].answer·explanation 을 벗긴다.
    //   교사·관리자·작성자 본인은 그대로(문항 편집·미리보기·정답 확인은 정당한 직무).
    //   학생의 "제출 후 해설"은 이 GET 이 아니라 채점 응답(POST /:id/grade)이 담당한다.
    res.json({ success: true, content: stripContentAnswers(content, req.user), isCollected });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ── 콘텐츠 하위 리소스 공통 게이트 ──────────────────────────────────────────
//   상세 조회가 403 인 콘텐츠에는 댓글 읽기·쓰기·좋아요도 열려선 안 된다.
//   (읽기 게이트와 쓰기 게이트가 같은 판정을 쓰게 한다 — 판정 사본 금지)
//
//   @param {number|string} [contentId]  경로 파라미터 이름이 `:id` 가 아닌 라우트
//     (예: `/collection/:contentId`)에서 대상 id 를 명시적으로 넘기기 위한 인자.
//     넘기지 않으면 기존과 동일하게 `req.params.id` 를 읽는다.
function guardContent(req, res, contentId) {
  const id = parseInt(contentId != null ? contentId : req.params.id);
  const content = loadContentForAuth(id);
  if (!content) {
    res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    return null;
  }
  if (!canViewContent(req.user, content)) {
    res.status(403).json({ success: false, message: '이 콘텐츠를 볼 권한이 없습니다.' });
    return null;
  }
  return content;
}

// GET /api/contents/:id/comments - 댓글 목록
router.get('/:id/comments', requireAuth, (req, res) => {
  try {
    if (!guardContent(req, res)) return;
    const comments = contentDb.getContentComments(parseInt(req.params.id));
    res.json({ success: true, comments });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/comments - 댓글 작성
router.post('/:id/comments', requireAuth, (req, res) => {
  try {
    if (!req.body.text || !req.body.text.trim()) return res.status(400).json({ success: false, message: '댓글 내용을 입력하세요.' });
    if (!guardContent(req, res)) return;
    const comment = contentDb.addContentComment(parseInt(req.params.id), req.user.id, req.body.text.trim(), req.body.parentId);
    res.status(201).json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/contents/:id/comments/:commentId - 댓글 삭제
router.delete('/:id/comments/:commentId', requireAuth, (req, res) => {
  try {
    const ok = contentDb.deleteContentComment(parseInt(req.params.commentId), req.user.id);
    if (!ok) return res.status(403).json({ success: false, message: '삭제 권한이 없습니다.' });
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/contents/:id - 콘텐츠 수정
router.put('/:id', requireAuth, (req, res) => {
  try {
    const content = contentDb.getContentById(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    if (content.creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }

    // 공개/비공개 전환 시 status 자동 조정 (관리자 외에는 status 필드 직접 수정 불가)
    let statusChanged = false;
    let newStatus = null;
    if (req.user.role !== 'admin') {
      // 일반 사용자는 status 필드를 직접 지정할 수 없음
      if ('status' in req.body) delete req.body.status;
    }
    if ('is_public' in req.body) {
      const nextPublic = req.body.is_public ? 1 : 0;
      const prevPublic = content.is_public ? 1 : 0;
      if (nextPublic === 1 && prevPublic === 0) {
        // 비공개 → 공개 전환: 관리자는 즉시 승인, 그 외는 승인 대기로 전환
        newStatus = req.user.role === 'admin' ? 'approved' : 'pending';
        req.body.status = newStatus;
        statusChanged = true;
      } else if (nextPublic === 0 && prevPublic === 1) {
        // 공개 → 비공개 전환: draft로 되돌림
        newStatus = 'draft';
        req.body.status = newStatus;
        statusChanged = true;
      }
    }

    const updated = contentDb.updateContent(content.id, req.body);
    let message = '수정되었습니다.';
    if (statusChanged) {
      if (newStatus === 'pending') message = '수정되었습니다. 공개 승인 대기 상태로 전환되었습니다.';
      else if (newStatus === 'approved') message = '수정되었습니다. 공개 상태로 전환되었습니다.';
      else if (newStatus === 'draft') message = '수정되었습니다. 비공개로 전환되었습니다.';
    }
    res.json({ success: true, content: updated, statusChanged, newStatus, message });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/contents/:id - 콘텐츠 삭제
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const content = contentDb.getContentById(parseInt(req.params.id));
    if (!content) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    if (content.creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    contentDb.deleteContent(content.id);
    // [W1-T3-11] 콘텐츠 행만 지우고 업로드 파일을 남기면 "삭제된 자료가 영구 다운로드" 된다.
    //   (참조가 사라진 파일은 lib/uploads-access.js 판정에서 '미참조' 로 떨어져
    //    로그인 사용자에게는 계속 열린다 → 디스크에서도 지워야 실제로 회수된다.)
    //   ⚠ 같은 파일을 다른 행이 아직 참조하면 지우지 않는다(공유 썸네일 파괴 방지).
    removeOrphanUploads([content.file_path, content.thumbnail_url, content.content_url]);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/like - 좋아요
router.post('/:id/like', requireAuth, (req, res) => {
  try {
    if (!guardContent(req, res)) return;
    const content = contentDb.toggleLike(parseInt(req.params.id));
    res.json({ success: true, like_count: content.like_count });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 보관함 ==========

// GET /api/contents/collection/list - 보관함 목록
router.get('/collection/list', requireAuth, (req, res) => {
  try {
    const result = contentDb.getCollection(req.user.id, {
      folderName: req.query.folder,
      page: parseInt(req.query.page) || 1
    });
    const folders = contentDb.getCollectionFolders(req.user.id);
    res.json({ success: true, ...result, folders });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/collection/:contentId - 보관함 추가
//
// 🔴 자기부여(self-grant) 차단 — 2026-08-21 실측
//   보관함 행(content_collections)은 lib/auth/can-view-content.js 의 **이용 근거(usage grant)**
//   중 하나다(via_collection). 그런데 이 라우트에는 열람 판정이 없어서, 학생이 열람 403 인
//   비공개 콘텐츠를 **스스로 보관함에 담아 근거를 만들고** 그 다음 문을 여는 순환이 성립했다:
//     POST /api/contents/collection/193   → 200 (근거 생성)
//     GET  /api/contents/193              → 403 이던 것이 200
//     POST /api/self-learn/problem-attempt {contentId:193} → correctAnswer:"56" · explanation
//   즉 앞 라운드가 세운 guardContent 를 **쓰기 라우트가 우회해 무력화**했다.
//   판정 사본을 새로 적지 않고 같은 guardContent 를 부른다(대상 id 만 명시).
//
// ⚠ 과잉 차단 없음 — 담기 버튼은 항상 "지금 보고 있는(=열람 가능한)" 콘텐츠에만 붙는다
//   (public/content/index.html · content-player.html · public/index.html 실측).
//   공개 승인본·내 콘텐츠·수업/평가/오늘의학습에 연결된 비공개본은 그대로 통과한다.
router.post('/collection/:contentId', requireAuth, (req, res) => {
  try {
    if (!guardContent(req, res, req.params.contentId)) return;
    const result = contentDb.addToCollection(req.user.id, parseInt(req.params.contentId), req.body && req.body.folder);
    if (!result.success) return res.status(409).json({ success: false, message: '이미 보관함에 있습니다.' });
    res.json({ success: true, message: '보관함에 추가했습니다.' });
  } catch (err) {
    console.error('[CONTENT] collection add error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.', error: err.message });
  }
});

// DELETE /api/contents/collection/:contentId - 보관함에서 제거
router.delete('/collection/:contentId', requireAuth, (req, res) => {
  try {
    contentDb.removeFromCollection(req.user.id, parseInt(req.params.contentId));
    res.json({ success: true, message: '보관함에서 제거했습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ========== 채널 ==========

// GET /api/contents/channels/list - 인기 채널
router.get('/channels/list', requireAuth, (req, res) => {
  try {
    const channels = contentDb.getPopularChannels(parseInt(req.query.limit) || 8);
    res.json({ success: true, channels });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/my - 내 채널
router.get('/channels/my', requireAuth, (req, res) => {
  try {
    let channel = contentDb.getUserChannel(req.user.id);
    res.json({ success: true, channel });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/channels - 채널 생성
router.post('/channels', requireAuth, (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ success: false, message: '채널 이름을 입력하세요.' });
    const existing = contentDb.getUserChannel(req.user.id);
    if (existing) return res.status(409).json({ success: false, message: '이미 채널이 있습니다.', channel: existing });
    const channel = contentDb.createChannel(req.user.id, req.body);
    res.status(201).json({ success: true, channel });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/contents/channels/:channelId - 채널 수정
router.put('/channels/:channelId', requireAuth, (req, res) => {
  try {
    const channel = contentDb.getChannelById(parseInt(req.params.channelId));
    if (!channel) return res.status(404).json({ success: false, message: '채널을 찾을 수 없습니다.' });
    if (channel.user_id !== req.user.id) return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    const updated = contentDb.updateChannel(channel.id, req.body);
    res.json({ success: true, channel: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/:channelId - 채널 상세 + 콘텐츠
router.get('/channels/:channelId', requireAuth, (req, res) => {
  try {
    const channel = contentDb.getChannelById(parseInt(req.params.channelId));
    if (!channel) return res.status(404).json({ success: false, message: '채널을 찾을 수 없습니다.' });
    const isSubscribed = contentDb.isSubscribed(channel.id, req.user.id);
    const result = contentDb.getChannelContents(channel.id, { page: parseInt(req.query.page) || 1 });
    res.json({ success: true, channel, isSubscribed, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/channels/:channelId/subscribe - 구독/구독취소 토글
router.post('/channels/:channelId/subscribe', requireAuth, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    if (contentDb.isSubscribed(channelId, req.user.id)) {
      contentDb.unsubscribe(channelId, req.user.id);
      res.json({ success: true, subscribed: false, message: '구독을 취소했습니다.' });
    } else {
      contentDb.subscribe(channelId, req.user.id);
      res.json({ success: true, subscribed: true, message: '채널을 구독했습니다.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/contents/channels/:channelId/posts - 채널 커뮤니티 게시
router.post('/channels/:channelId/posts', requireAuth, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, message: '내용을 입력하세요.' });
    const db = require('../db');
    const info = db.prepare('INSERT INTO channel_posts (channel_id, user_id, content) VALUES (?, ?, ?)').run(channelId, req.user.id, content.trim());
    const post = db.prepare('SELECT cp.*, u.display_name FROM channel_posts cp JOIN users u ON cp.user_id = u.id WHERE cp.id = ?').get(info.lastInsertRowid);
    res.status(201).json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/:channelId/posts - 채널 커뮤니티 목록
router.get('/channels/:channelId/posts', requireAuth, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const db = require('../db');
    const posts = db.prepare('SELECT cp.*, u.display_name FROM channel_posts cp JOIN users u ON cp.user_id = u.id WHERE cp.channel_id = ? ORDER BY cp.created_at DESC LIMIT 50').all(channelId);
    res.json({ success: true, posts });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/contents/channels/subscriptions/list - 내 구독 채널
router.get('/channels/subscriptions/list', requireAuth, (req, res) => {
  try {
    const channels = contentDb.getUserSubscriptions(req.user.id);
    res.json({ success: true, channels });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== 콘텐츠 풀이 시도 기록 (문항/평가지) =====
// [W1-T3-6 fix] 예전엔 `new Database('data/dacheum.db')` 로 **정본 경로를 하드코딩**해
//   DB_PATH(테스트·스모크 격리 사본)를 무시했다. 그래서 격리 환경에서 돌린 풀이 트래픽이
//   정본 DB 에 그대로 쌓였고(2026-08 테스트 트래픽 오염 포렌식), 정본을 잠가 SQLITE_BUSY 도 냈다.
//   → 다른 모든 라우트와 같이 공용 싱글톤(db/index.js, DB_PATH 준수)을 쓴다.
//   ⚠ 싱글톤이므로 close() 하면 앱 전체가 죽는다. 아래 핸들러들은 close 하지 않는다.
const attemptsDb = require('../db/index');
function _attemptsDb() { return attemptsDb; }

// ============================================================================
// POST /api/contents/:id/grade — 문항 콘텐츠 **서버 채점**
// ----------------------------------------------------------------------------
// 왜 필요한가 (2026-08-07):
//   content-player.html 은 `GET /api/contents/:id` 가 실어 준 `q.answer` 로
//   **클라이언트에서 채점**했다. 그래서 정답을 응답에서 빼는 순간 채점·해설이 통째로
//   깨진다. "제출 전엔 가리고, 제출 후엔 해설을 보여준다"는 정책을 지키려면 판정의
//   주체가 서버여야 한다 → 이 엔드포인트가 그 자리다.
//
//   요청:  { answers: [{ questionId, value }, ...] }
//   응답:  { results: [{ questionId, correct, score, maxScore, answer?, explanation? }] }
//          ↑ answer·explanation 은 **채점을 마친 문항에만** 붙는다.
//
// 🔴 2026-08-07 감리 4차 — 이 엔드포인트가 정답지 전체를 내주던 구멍:
//   `const base = { ..., answer: q.answer, explanation: ... }` 를 만들어 두고
//   미응답(`given == null`)·서술형(자동채점 보류)에도 그 base 를 그대로 반환했다.
//   → `POST /api/contents/:id/grade  {"answers":[]}` 한 번이면 **전 문항이 미응답**이 되어
//     정답·해설이 통째로 돌아왔다. `attempt_count` 도 안 오르므로 흔적조차 남지 않는다.
//     (9,918 콘텐츠 / 11,813 문항 — 학생 계정 하나 + for 루프면 전량 수집 가능했다)
//   즉 GET 에서 벗긴 정답을 같은 파일의 POST 가 복원해 준 형태였다.
//   → **채점이 실제로 끝난 문항만** "제출 완료(submitted)" 로 보고 공개한다.
//     부분 제출(4문항 중 2개만 답)이면 **답한 2개만** 공개된다.
//     "하나라도 답했으면 전부 공개" 는 같은 구멍이므로 판정은 **문항 단위**다.
//   판정은 lib/strip-answers.js 한 벌만 쓴다(사본 금지 — INV-AE4 소스 락).
//   교사·관리자·작성자는 canRevealAnswers 의 역할/소유자 분기로 지금처럼 전부 본다.
//
//   채점 규칙은 기존 content-player 의 클라이언트 로직과 **동일**하게 맞췄다(회귀 방지):
//     · choice : String 비교
//     · short  : 공백 제거 + 소문자화 후 비교(관대한 비교)
//     · essay  : 자동채점 보류(correct=null)
//     · 미응답 : correct=null, score=0
// ============================================================================
// 🔴 판정 SSOT — lib/grade-answer.js 한 벌만 쓴다 (사본 금지, 기획서 BE-2).
//    2026-08-21 이전에는 여기에 _normalizeShort/_normalizeQType 와 비교식이 인라인으로 있었고,
//    응답 현황 모니터가 같은 로직을 다시 적으면 두 벌이 되어 어긋난다. 그래서 추출했다.
//    · 채점 계약(0-based · 보정 없음)은 lib/grade-answer.js 주석 참조. 여기서 바꾸지 말 것.
const { judge, buildAnswerLookup, isBlank } = require('../lib/grade-answer');

router.post('/:id/grade', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.id);
    // 열람 권한이 없는 콘텐츠는 채점도 해 주지 않는다(정답 조회 우회 금지).
    const content = guardContent(req, res);
    if (!content) return;

    const db = require('../db/index');
    const rows = db.prepare(
      'SELECT id, question_number, question_type, options, answer, explanation, points FROM content_questions WHERE content_id = ? ORDER BY question_number'
    ).all(contentId);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '등록된 문항이 없습니다.' });
    }

    const submitted = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
    // questionId 우선 매칭, 없으면 순서(index) 매칭 — 두 경우 모두 서버 문항이 기준이다.
    // 🔴 매칭 규칙도 SSOT(lib/grade-answer.js buildAnswerLookup). 모니터 API 가 같은 함수를 쓴다.
    const pick = buildAnswerLookup(submitted);

    let totalScore = 0, maxTotal = 0, autoScored = 0;
    const results = rows.map((q, i) => {
      const maxScore = Number(q.points) || 1;
      maxTotal += maxScore;
      const given = pick(q, i);

      /**
       * 결과 1건을 만든다.
       * @param {boolean} graded  이 문항을 **실제로 채점했는가**(= 이 열람자에게 정답 공개 가능)
       *   미응답·서술형 보류는 false → strip-answers 가 answer·explanation 을 벗긴다.
       *   교사·관리자·작성자는 graded 와 무관하게 canRevealAnswers 가 통과시킨다.
       */
      const emit = (graded, verdict) => stripAnswers(
        [{
          questionId: q.id, questionNumber: q.question_number, maxScore,
          answer: q.answer, explanation: q.explanation || null,
          ...verdict,
        }],
        req.user,
        { ownerId: content.creator_id, submitted: graded }
      )[0];

      // 판정 SSOT — 미응답·서술형은 null(채점 보류), 그 외 true/false.
      const ok = judge(q, given);
      if (isBlank(given)) return emit(false, { correct: null, score: 0 });
      if (ok === null) return emit(false, { correct: null, score: 0 });   // essay 보류

      autoScored += maxScore;
      if (ok) totalScore += maxScore;
      return emit(true, { correct: ok, score: ok ? maxScore : 0 });
    });

    const pctBase = autoScored > 0 ? autoScored : maxTotal;
    const scorePercent = pctBase > 0 ? Math.round((totalScore / pctBase) * 100) : 0;
    res.json({
      success: true,
      results,
      totalScore, maxTotal, autoScored, scorePercent,
      correctCount: results.filter(r => r.correct === true).length,
      wrongCount: results.filter(r => r.correct === false).length,
    });
  } catch (err) {
    console.error('[CONTENT] grade error:', err);
    res.status(500).json({ success: false, message: '채점 중 오류가 발생했습니다.' });
  }
});

// POST /api/contents/:id/attempts - 풀이 결과 기록
//   열람 권한이 없는 콘텐츠에는 풀이 기록도 남기지 않는다(채점 게이트와 같은 판정).
//   실측(2026-08-07): 학생이 비공개 193 으로 200 을 받아 기록을 남길 수 있었다.
//   과잉 차단 위험 0 — content-player 는 GET /api/contents/:id(같은 게이트) 로 연 콘텐츠만 기록한다.
// ── BE-1: 수업 맥락(lesson_id·class_id) 검증 ────────────────────────────────
//   클라이언트가 보낸 lessonId 를 그대로 믿으면 학생이 남의 수업에 기록을 심을 수 있다.
//   ① 수업이 실재하고 ② 그 수업에 이 콘텐츠가 실제로 들어 있고 ③ 호출자가 그 클래스의
//   active 멤버(또는 admin)일 때만 채운다. 하나라도 어긋나면 **NULL**(수업 밖)로 저장한다 —
//   거부(4xx)하지 않는 이유: 풀이 기록 자체는 남겨야 하고, 맥락만 못 믿을 뿐이다.
function _resolveLessonContext(db, user, contentId, lessonIdRaw, classIdRaw) {
  const NONE = { lesson_id: null, class_id: null };
  const lid = parseInt(lessonIdRaw);
  if (!Number.isInteger(lid) || lid <= 0) return NONE;
  try {
    const lesson = db.prepare('SELECT id, class_id FROM lessons WHERE id = ?').get(lid);
    if (!lesson || !lesson.class_id) return NONE;
    const cid = parseInt(classIdRaw);
    // classId 를 함께 보냈다면 교차검증(불일치 = 조작 시도) — 안 보냈으면 수업의 class_id 를 쓴다.
    if (Number.isInteger(cid) && cid > 0 && Number(lesson.class_id) !== cid) return NONE;
    const inLesson = db.prepare('SELECT 1 FROM lesson_contents WHERE lesson_id = ? AND content_id = ?').get(lid, contentId);
    if (!inLesson) return NONE;
    const member = db.prepare(
      "SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
    ).get(lesson.class_id, user.id);
    if (!member && user.role !== 'admin') return NONE;
    return { lesson_id: lid, class_id: Number(lesson.class_id) };
  } catch (e) { return NONE; }
}

router.post('/:id/attempts', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.id);
    if (!guardContent(req, res)) return;
    const {
      total_questions = 0, correct_count = 0, score_percent = 0, answers = null,
      // BE-3: [{questionId,value}] — 순서 의존 제거용. 없으면 NULL(레거시 경로 그대로 동작).
      answers_detail = null,
      // BE-1: 수업꾸러미에서 푼 것인지. 없으면 NULL(= 수업 밖 풀이).
      lesson_id = null, class_id = null,
    } = req.body || {};
    const db = _attemptsDb();
    try {
      const ctx = _resolveLessonContext(db, req.user, contentId, lesson_id, class_id);
      const stmt = db.prepare(`INSERT INTO content_attempts (content_id, user_id, total_questions, correct_count, score_percent, answers, answers_detail, lesson_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const info = stmt.run(
        contentId, req.user.id, total_questions, correct_count, score_percent,
        answers ? JSON.stringify(answers) : null,
        Array.isArray(answers_detail) && answers_detail.length ? JSON.stringify(answers_detail) : null,
        ctx.lesson_id, ctx.class_id
      );
      // 수업 중 제출이면 교사 응답 현황 모니터를 즉시 갱신 (기획서 §8-3).
      //   저장이 끝난 뒤 서버가 부른다 — 학생이 보내는 lesson:answered 는 INSERT 보다
      //   먼저 도착할 수 있어(레이스) 직전 스냅샷을 그린다.
      //   🔴 emit 대상은 교사 전용 룸 lesson:{id}:monitor 하나뿐이다.
      if (ctx.lesson_id && ctx.class_id) {
        try {
          const sock = require('../socket');
          if (typeof sock.notifyLessonAnswered === 'function') {
            sock.notifyLessonAnswered({ classId: ctx.class_id, lessonId: ctx.lesson_id });
          }
        } catch (_) { /* 소켓 미기동(테스트 등) — 기록 저장에는 영향 없음 */ }
      }
      // xAPI: 바로 풀기 assessment.submitted (콘텐츠 표준체계 해소)
      try {
        const mainDb = require('../db');
        const c = mainDb.prepare('SELECT id, title, content_type, subject, grade, curriculum_standard_ids, achievement_code FROM contents WHERE id = ?').get(contentId);
        if (c) {
          const schoolLevel = (c.subject || '').endsWith('-e') ? '초' : (c.subject || '').endsWith('-m') ? '중' : (c.subject || '').endsWith('-h') ? '고' : null;
          xapiSpool.record('assessment', buildAssessment, { userId: req.user.id }, {
            verb: 'submitted',
            assessment_id: contentId,
            title: c.title,
            assessment_type: c.content_type === 'exam' ? 'practice' : 'self_check',
            target_kind: c.content_type === 'exam' ? 'exam' : 'quiz',
            subject_code: c.subject || null,
            grade_group: c.grade || null,
            school_level: schoolLevel,
            curriculum_standard_ids: c.curriculum_standard_ids || null,
            achievement_codes: c.achievement_code || null,
            score: { raw: correct_count, max: total_questions },
            success: total_questions > 0 && (correct_count / total_questions) >= 0.6,
            source: 'public_content_try',
          });
        }
      } catch (_) {}
      res.json({ success: true, id: info.lastInsertRowid });
    } finally { /* 싱글톤 — close 금지 */ }
  } catch (err) {
    console.error('content attempts insert error:', err);
    res.status(500).json({ success: false, message: '기록 저장 실패' });
  }
});

// GET /api/contents/:id/my-stats - 내 풀이 통계
router.get('/:id/my-stats', requireAuth, (req, res) => {
  try {
    const contentId = parseInt(req.params.id);
    const db = _attemptsDb();
    try {
      const row = db.prepare(`SELECT COUNT(*) AS attempt_count, MAX(score_percent) AS best_score_percent, MAX(attempted_at) AS last_attempted_at FROM content_attempts WHERE content_id = ? AND user_id = ?`).get(contentId, req.user.id);
      const last = db.prepare(`SELECT score_percent AS last_score_percent, correct_count AS last_correct, total_questions AS last_total FROM content_attempts WHERE content_id = ? AND user_id = ? ORDER BY attempted_at DESC LIMIT 1`).get(contentId, req.user.id);
      res.json({ success: true, stats: { ...(row || {}), ...(last || {}) } });
    } finally { /* 싱글톤 — close 금지 */ }
  } catch (err) {
    res.status(500).json({ success: false, message: '통계 조회 실패' });
  }
});

// POST /api/contents/my-stats-bulk - 여러 콘텐츠의 내 풀이 통계 일괄 조회
router.post('/my-stats-bulk', requireAuth, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => parseInt(x)).filter(Boolean) : [];
    if (!ids.length) return res.json({ success: true, stats: {} });
    const db = _attemptsDb();
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT content_id, COUNT(*) AS attempt_count, MAX(score_percent) AS best_score_percent, MAX(attempted_at) AS last_attempted_at FROM content_attempts WHERE user_id = ? AND content_id IN (${placeholders}) GROUP BY content_id`).all(req.user.id, ...ids);
      const stats = {};
      rows.forEach(r => { stats[r.content_id] = r; });
      res.json({ success: true, stats });
    } finally { /* 싱글톤 — close 금지 */ }
  } catch (err) {
    res.status(500).json({ success: false, message: '통계 조회 실패' });
  }
});

// POST /api/contents/aggregate-stats-bulk - 여러 콘텐츠의 전체 사용자 풀이 통계 일괄 조회
//   [W1-T3] requireAuth 누락이었다. 호출처(public/content/index.html)는 로그인 페이지이므로
//   인증을 붙여도 동선 변화 없음(비로그인 포털은 이 API 를 쓰지 않는다 — 실측).
router.post('/aggregate-stats-bulk', requireAuth, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => parseInt(x)).filter(Boolean) : [];
    if (!ids.length) return res.json({ success: true, stats: {} });
    const db = _attemptsDb();
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT
        content_id,
        COUNT(*) AS total_attempts,
        COUNT(DISTINCT user_id) AS unique_solvers,
        AVG(score_percent) AS avg_score_percent,
        SUM(correct_count) AS total_correct,
        SUM(total_questions) AS total_questions
      FROM content_attempts
      WHERE content_id IN (${placeholders})
      GROUP BY content_id`).all(...ids);
      const stats = {};
      rows.forEach(r => {
        stats[r.content_id] = {
          total_attempts: r.total_attempts || 0,
          unique_solvers: r.unique_solvers || 0,
          avg_score_percent: r.avg_score_percent != null ? Math.round(r.avg_score_percent) : null,
          correct_rate: (r.total_questions > 0) ? Math.round((r.total_correct / r.total_questions) * 100) : null
        };
      });
      res.json({ success: true, stats });
    } finally { /* 싱글톤 — close 금지 */ }
  } catch (err) {
    res.status(500).json({ success: false, message: '집계 통계 조회 실패' });
  }
});

// GET /api/contents/:id/aggregate-stats - 단일 콘텐츠 전체 통계
router.get('/:id/aggregate-stats', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false });
    const db = _attemptsDb();
    try {
      const r = db.prepare(`SELECT
        COUNT(*) AS total_attempts,
        COUNT(DISTINCT user_id) AS unique_solvers,
        AVG(score_percent) AS avg_score_percent,
        SUM(correct_count) AS total_correct,
        SUM(total_questions) AS total_questions
      FROM content_attempts WHERE content_id = ?`).get(id);
      res.json({
        success: true,
        aggregate: {
          total_attempts: r?.total_attempts || 0,
          unique_solvers: r?.unique_solvers || 0,
          avg_score_percent: (r && r.avg_score_percent != null) ? Math.round(r.avg_score_percent) : null,
          correct_rate: (r && r.total_questions > 0) ? Math.round((r.total_correct / r.total_questions) * 100) : null
        }
      });
    } finally { /* 싱글톤 — close 금지 */ }
  } catch (err) {
    res.status(500).json({ success: false, message: '집계 통계 조회 실패' });
  }
});

module.exports = router;
