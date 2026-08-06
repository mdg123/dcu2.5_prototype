const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const examDb = require('../db/exam');
const classDb = require('../db/class');
const notifDb = require('../db/notifications');
const { logLearningActivity, computeAchievementLevel } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const cbtExtDb = require('../db/cbt-extended');
const buildAssessment = require('../lib/xapi/builders/assessment');
const buildAssignment = require('../lib/xapi/builders/assignment');
const xapiSpool = require('../lib/xapi/spool');

// subject_code 끝자리로 학교급 추정 (-e/-m/-h)
function _examSchoolLevel(sc) {
  const s = String(sc || '');
  if (s.endsWith('-e')) return '초';
  if (s.endsWith('-m')) return '중';
  if (s.endsWith('-h')) return '고';
  return null;
}
const { ensureTodayAttendance } = require('../db/attendance');
const initSocket = require('../socket');

// ─── [H] 평가 기간 게이트 헬퍼 ────────────────────────────────────────────────
// exams.start_date / end_date 는 DATE 컬럼(schema.js). FE 는 보통 'YYYY-MM-DD',
// 콘텐츠 임포트/일부 경로는 'YYYY-MM-DD HH:MM' 로도 저장될 수 있어 앞 10자(날짜부)만
// 비교한다. 타임존은 코드베이스 공통 규칙(homework.js·growth.js 의 date('now','+9 hours'))
// 과 일관되게 KST(UTC+9) 로컬 날짜를 기준일로 삼는다.
// 이 함수의 계산이 lib/kst.js 로 승격됐다(시각 규약 SSOT). 사본을 남기지 않고 위임한다.
const kstLib = require('../lib/kst');
function kstTodayStr() {
  return kstLib.kstToday();
}
function dateOnly(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, 10); // 'YYYY-MM-DD' 또는 'YYYY-MM-DD HH:MM' 모두 날짜부만
}
/**
 * 학생 응시 기간 게이트. 통과 시 null, 위반 시 { code, message } 반환.
 * - start_date 있고 today < start_date → 아직 시작 전(거부)
 * - end_date   있고 today > end_date   → 마감(거부)
 * - 상시운영(둘 다 null)·기한없음 컬럼은 통과(회귀 금지). 오늘 == start/end 는 통과(경계 포함).
 */
function examPeriodGate(exam) {
  const today = kstTodayStr();
  const start = dateOnly(exam.start_date);
  const end = dateOnly(exam.end_date);
  if (start && today < start) {
    return { code: 403, message: '아직 시작 전인 평가입니다. 시작일 이후에 응시할 수 있습니다.' };
  }
  if (end && today > end) {
    return { code: 403, message: '마감된 평가입니다. 응시 기간이 종료되었습니다.' };
  }
  return null;
}

// ─── PDF 업로드 설정 ────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', 'uploads', 'exams');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + '.pdf')
});

const pdfUpload = multer({
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('PDF 파일만 업로드 가능합니다.'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

function requireClassMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  req.classId = classId;
  // CBT는 클래스 독립 서비스 — 클래스 멤버가 아니어도 접근 허용
  if (classDb.isMember(classId, req.user.id)) {
    req.myRole = classDb.getMemberRole(classId, req.user.id);
  } else if (req.user.role === 'admin') {
    req.myRole = 'admin';
  } else {
    // 비멤버: 출제자인지 확인
    const db = require('../db/index');
    const exam = req.params.examId ? db.prepare('SELECT owner_id FROM exams WHERE id = ?').get(req.params.examId) : null;
    if (exam && exam.owner_id === req.user.id) {
      req.myRole = 'owner';
    } else {
      req.myRole = 'participant'; // 응시자로 접근
    }
  }
  next();
}

// GET /api/exam/my — 내 모든 시험 목록 (클래스 무관, 독립 서비스)
router.get('/my', requireAuth, (req, res) => {
  try {
    const db = require('../db/index');
    const userId = req.user.id;
    const { status } = req.query;
    const isTeacher = req.user.role === 'teacher' || req.user.role === 'admin';

    let sql, params;
    if (isTeacher) {
      // 교사: 모든 평가 (본인 것 + 다른 교사의 공개 평가)
      // draft/임시저장은 본인 것만, 나머지는 모두 표시
      sql = `SELECT e.*, u.display_name as author_name,
             c.name as class_name,
             e.start_mode, e.tab_detection, e.allow_retry,
             (SELECT COUNT(*) FROM exam_students es WHERE es.exam_id = e.id AND es.submitted_at IS NOT NULL) as participant_count
             FROM exams e
             LEFT JOIN users u ON e.owner_id = u.id
             LEFT JOIN classes c ON e.class_id = c.id
             WHERE (e.owner_id = ? OR e.status != 'draft')`;
      params = [userId];
    } else {
      // 학생: 자신이 소속된 클래스의 모든 시험
      sql = `SELECT e.*, u.display_name as author_name,
             c.name as class_name,
             e.start_mode, e.tab_detection, e.allow_retry,
             (SELECT COUNT(*) FROM exam_students es WHERE es.exam_id = e.id AND es.submitted_at IS NOT NULL) as participant_count
             FROM exams e
             LEFT JOIN users u ON e.owner_id = u.id
             LEFT JOIN classes c ON e.class_id = c.id
             INNER JOIN class_members cm ON e.class_id = cm.class_id AND cm.user_id = ?
             WHERE e.status != 'draft'`;
      params = [userId];
    }
    if (status && status !== 'all') {
      sql += ` AND e.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY e.created_at DESC`;

    const exams = db.prepare(sql).all(...params);

    // 학생: 내 응시 정보 추가
    const enriched = exams.map(exam => {
      const submission = db.prepare('SELECT score, submitted_at FROM exam_students WHERE exam_id = ? AND user_id = ?').get(exam.id, userId);
      return {
        ...exam,
        my_score: submission ? submission.score : null,
        my_submitted: !!submission?.submitted_at
      };
    });

    res.json({ success: true, exams: enriched, total: enriched.length });
  } catch (err) {
    console.error('내 시험 목록 조회 오류:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /import-from-content — 콘텐츠에서 시험 가져오기 (must be before /:classId routes)
router.post('/import-from-content', requireAuth, (req, res) => {
  try {
    const { contentId, classId: cId, title, description, time_limit, start_date, end_date, std_ids } = req.body;
    const result = cbtExtDb.importFromContent(contentId, cId, req.user.id, { title, description, time_limit, start_date, end_date, std_ids: Array.isArray(std_ids) ? std_ids : null });
    if (!result) return res.status(404).json({ success: false, message: '콘텐츠를 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// GET /api/exam/:classId - 평가 목록
router.get('/:classId', requireAuth, requireClassMember, (req, res) => {
  try {
    const { status, page, std_ids } = req.query;
    const stdIdsArr = std_ids ? String(std_ids).split(',').map(s => s.trim()).filter(Boolean) : null;
    const result = examDb.getExamsByClass(req.classId, { status, page: parseInt(page) || 1, std_ids: stdIdsArr });
    // 현재 사용자의 응시 점수 추가
    const db = require('../db/index');
    result.exams = result.exams.map(exam => {
      const submission = db.prepare('SELECT score, submitted_at FROM exam_students WHERE exam_id = ? AND user_id = ?').get(exam.id, req.user.id);
      // 응시자 수 (제출 완료 기준)
      const pc = db.prepare('SELECT COUNT(*) as c FROM exam_students WHERE exam_id = ? AND submitted_at IS NOT NULL').get(exam.id);
      return { ...exam, my_score: submission ? submission.score : null, my_submitted: !!submission?.submitted_at, participant_count: pc?.c || 0 };
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/exam/:classId - 평가 생성
router.post('/:classId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 평가를 생성할 수 있습니다.' });
    }
    const { title, description, exam_type, questions, time_limit, start_time, end_time, status, settings, start_date, end_date, start_mode, tab_detection, allow_retry, std_ids } = req.body;
    if (!title) return res.status(400).json({ success: false, message: '평가 제목을 입력하세요.' });
    // ─── B04: 외부 임포트/자동 출제 입력 정규화 ─────────────────────────────
    // 일부 외부 API가 정답 필드를 correct_index / correctIndex / answer_index 로
    // 보내는 경우가 있어 silent 0점 채점을 막기 위해 alias 를 answer 로 통일한다.
    const normalizedQuestions = (Array.isArray(questions) ? questions : []).map((q, idx) => {
      const safeQ = (q && typeof q === 'object') ? q : {};
      const ans = safeQ.answer ?? safeQ.correct_index ?? safeQ.correctIndex ?? safeQ.answer_index;
      return { ...safeQ, answer: ans, _qIdx: idx };
    });
    // 객관식인데 정답이 없으면 명시적 400 (silent 0점 채점 방지)
    const invalid = normalizedQuestions.filter(q =>
      (q.type === 'multiple' || q.type === 'choice') && (q.answer == null || q.answer === '')
    );
    if (invalid.length) {
      return res.status(400).json({
        success: false,
        message: `정답이 누락된 객관식 문항이 ${invalid.length}개 있습니다 (문항 ${invalid.map(q => q._qIdx + 1).join(', ')})`
      });
    }
    // 내부용 _qIdx 제거 후 저장
    const cleanQuestions = normalizedQuestions.map(({ _qIdx, ...rest }) => rest);
    // start_mode에 따른 status 결정
    let finalStatus = status;
    if (start_mode === 'direct' && (!status || status === 'draft')) {
      finalStatus = 'active';
    } else if (start_mode === 'waiting') {
      finalStatus = 'waiting';
    }
    // 콘텐츠 공개정책 2단계: 직접 만들기(start_mode='direct') 또는 미지정(기본 direct)인 경우
    // 그림자 contents 등록 — 공개콘텐츠/보관함 가져오기 모드는 제외 (원본 contents 이미 존재)
    const effectiveStartMode = start_mode || 'direct';
    const shouldShadow = (effectiveStartMode === 'direct');
    const exam = examDb.createExam(req.classId, req.user.id, {
      title, description, exam_type, questions: cleanQuestions, time_limit, start_time, end_time, status: finalStatus, settings, start_date, end_date,
      subject_code: req.body.subject_code || null,
      grade_group: req.body.grade_group || null,
      achievement_code: req.body.achievement_code || null,
      std_ids: Array.isArray(std_ids) ? std_ids : null,
      _shadow: shouldShadow
    });
    // 추가 설정 저장
    try {
      const db = require('../db/index');
      db.prepare('UPDATE exams SET start_mode = ?, tab_detection = ?, allow_retry = ? WHERE id = ?')
        .run(start_mode || 'direct', tab_detection != null ? tab_detection : 1, allow_retry || 0, exam.id);
    } catch (e) { console.error('[EXAM] settings save error:', e); }
    // xAPI: 평가지 생성 → assignment(gave) — 출제 시점
    try {
      xapiSpool.record('assignment', buildAssignment, { userId: req.user.id, classId: req.classId }, {
        verb: 'gave',
        assignment_id: exam.id,
        title: exam.title,
        due_at: end_date || end_time || null,
        gave_at: new Date().toISOString(),
        target_user_ids: [],  // 평가지는 클래스 단위 — 개별 대상 없음
        subject_code: exam.subject_code || null,
        grade_group: exam.grade_group || null,
        school_level: _examSchoolLevel(exam.subject_code),
        achievement_codes: exam.achievement_code || null,
        curriculum_standard_ids: Array.isArray(exam.std_ids) && exam.std_ids.length ? exam.std_ids : null,
      });
    } catch (e) { console.error('[xapi:exam_gave]', e.message); }
    // 알림: 활성/대기 상태 평가만 학생에게 즉시 알림 (draft 제외)
    try {
      if (exam && exam.id && finalStatus && finalStatus !== 'draft') {
        notifDb.notifyClassMembers(req.classId, {
          type: 'exam_new',
          title: '새 평가가 등록되었습니다',
          message: exam.title,
          // 실제 화면 파일명 = exam-view.html, 파라미터명은 examId 가 아니라 id (실측)
          link: `/class/exam-view.html?classId=${req.classId}&id=${exam.id}`,
          excludeUserId: req.user.id
        });
      }
    } catch (e) { console.error('[EXAM] notify error:', e.message); }
    res.status(201).json({ success: true, exam });
  } catch (err) {
    console.error('[EXAM] create error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── PDF 평가 생성 ────────────────────────────────────────────────────────────
// POST /api/exam/:classId/create-pdf
router.post('/:classId/create-pdf', requireAuth, requireClassMember, pdfUpload.single('pdf'), (req, res) => {
  try {
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 평가를 생성할 수 있습니다.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF 파일을 업로드하세요.' });
    }

    const { title, answers, question_count, time_limit, description, start_mode, tab_detection, allow_retry } = req.body;
    if (!title) return res.status(400).json({ success: false, message: '평가 제목을 입력하세요.' });

    // OMR 정답 파싱
    let parsedAnswers = [];
    try {
      parsedAnswers = JSON.parse(answers || '[]');
    } catch (e) {
      return res.status(400).json({ success: false, message: '정답 데이터 형식이 올바르지 않습니다.' });
    }

    const qCount = parseInt(question_count) || parsedAnswers.length || 10;

    // 정답 배열을 questions 형태로 변환 (기존 채점 로직과 호환)
    const questions = parsedAnswers.map((ans, i) => ({
      text: `문항 ${i + 1}`,
      options: ['①', '②', '③', '④', '⑤'],
      answer: ans,
      points: 100 / qCount
    }));

    // PDF 파일 경로 (상대 경로로 저장)
    const pdfRelPath = `/uploads/exams/${path.basename(req.file.path)}`;

    const db = require('../db/index');
    // start_mode에 따른 status 결정
    const pdfStartMode = start_mode || 'waiting';
    const pdfStatus = pdfStartMode === 'direct' ? 'active' : 'waiting';

    // PDF 업로드 평가도 직접 만들기 흐름 → 그림자 contents 등록
    const exam = examDb.createExam(req.classId, req.user.id, {
      title,
      description: description || '',
      pdf_file: pdfRelPath,
      questions,
      question_count: qCount,
      time_limit: parseInt(time_limit) || 30,
      status: pdfStatus,
      subject_code: req.body.subject_code || null,
      grade_group: req.body.grade_group || null,
      _shadow: true
    });

    // exam_mode 및 추가 설정 저장
    try {
      db.prepare('UPDATE exams SET exam_mode = ?, start_mode = ?, tab_detection = ?, allow_retry = ? WHERE id = ?')
        .run('pdf', pdfStartMode, tab_detection != null ? parseInt(tab_detection) : 1, allow_retry ? parseInt(allow_retry) : 0, exam.id);
    } catch (e) {}

    res.status(201).json({ success: true, exam: { ...exam, exam_mode: 'pdf', pdf_url: pdfRelPath } });
  } catch (err) {
    console.error('[EXAM] create-pdf error:', err);
    // 업로드된 파일 정리
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── PDF 스트리밍 ──────────────────────────────────────────────────────────────
// GET /api/exam/:classId/:examId/pdf
router.get('/:classId/:examId/pdf', requireAuth, requireClassMember, (req, res) => {
  try {
    const exam = examDb.getExamById(req.params.examId);
    if (!exam || exam.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }

    if (!exam.pdf_file) {
      return res.status(404).json({ success: false, message: 'PDF 파일이 없습니다.' });
    }

    // 교사는 항상 접근 가능, 학생은 active 상태에서만
    const isTeacher = req.myRole === 'owner' || req.user.role === 'admin';
    if (!isTeacher && exam.status !== 'active') {
      return res.status(403).json({ success: false, message: '시험이 시작된 후에 열람할 수 있습니다.' });
    }

    // PDF 파일 경로 해석
    let pdfPath = exam.pdf_file;
    if (pdfPath.startsWith('/uploads/')) {
      pdfPath = path.join(__dirname, '..', 'public', pdfPath);
      // public/uploads에 없으면 프로젝트 루트 uploads에서 찾기
      if (!fs.existsSync(pdfPath)) {
        pdfPath = path.join(__dirname, '..', pdfPath);
      }
    }
    if (!path.isAbsolute(pdfPath)) {
      pdfPath = path.join(__dirname, '..', pdfPath);
    }

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ success: false, message: 'PDF 파일을 찾을 수 없습니다.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error('[EXAM] pdf stream error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/exam/:classId/:examId - 평가 상세
router.get('/:classId/:examId', requireAuth, requireClassMember, (req, res) => {
  try {
    const exam = examDb.getExamById(req.params.examId);
    if (!exam || exam.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }

    // exam_mode, start_mode, tab_detection, allow_retry 추가
    const db = require('../db/index');
    try {
      const extra = db.prepare('SELECT exam_mode, start_mode, tab_detection, allow_retry FROM exams WHERE id = ?').get(exam.id);
      if (extra) {
        exam.exam_mode = extra.exam_mode || 'text';
        exam.start_mode = extra.start_mode || 'direct';
        exam.tab_detection = extra.tab_detection != null ? extra.tab_detection : 1;
        exam.allow_retry = extra.allow_retry || 0;
      }
    } catch (e) { exam.exam_mode = 'text'; }
    if (exam.pdf_file) {
      exam.pdf_url = `/api/exam/${req.classId}/${exam.id}/pdf`;
    }

    let studentExam = null;
    let students = null;
    if (req.myRole === 'owner') {
      students = examDb.getExamStudents(exam.id);
      // 출제자도 응시한 경우 studentExam 반환 (리뷰 모드 지원)
      studentExam = examDb.getStudentExam(exam.id, req.user.id);
    } else {
      studentExam = examDb.getStudentExam(exam.id, req.user.id);
      // 학생에게는 정답 숨기기 (단, 이미 제출한 경우 정답 공개)
      const hasSubmitted = studentExam && (studentExam.status === 'submitted' || studentExam.status === 'completed');
      if (!hasSubmitted) {
        exam.questions = exam.questions.map(q => ({ ...q, answer: undefined, explanation: undefined }));
      }
    }
    res.json({ success: true, exam, studentExam, students });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/exam/:classId/:examId - 평가 수정
router.put('/:classId/:examId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    const exam = examDb.updateExam(req.params.examId, req.body);
    res.json({ success: true, exam });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// DELETE /api/exam/:classId/:examId - 평가 삭제
router.delete('/:classId/:examId', requireAuth, requireClassMember, (req, res) => {
  try {
    if (req.myRole !== 'owner') {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    examDb.deleteExam(req.params.examId);
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/exam/:classId/:examId/start - 시험 시작
router.post('/:classId/:examId/start', requireAuth, requireClassMember, (req, res) => {
  try {
    const exam = examDb.getExamById(req.params.examId);
    if (!exam) return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    if (exam.status !== 'active' && exam.status !== 'waiting') {
      return res.status(400).json({ success: false, message: '진행 중이거나 대기 중인 평가가 아닙니다.' });
    }

    // ─── [H] 응시 기간 게이트 ─────────────────────────────────────────────────
    // 학생(member/participant) 경로만 게이트. 교사(owner)·admin 은 검수·미리보기
    // 목적의 응시를 허용(시작 전 검수 응시 허용). 상시운영·기한없음은 통과(회귀 금지).
    const isSupervisor = req.myRole === 'owner' || req.user.role === 'admin';
    if (!isSupervisor) {
      const gate = examPeriodGate(exam);
      if (gate) return res.status(gate.code).json({ success: false, message: gate.message });
    }

    const result = examDb.startExam(exam.id, req.user.id);
    if (!result.success) return res.status(409).json({ success: false, message: '이미 참여한 평가입니다.' });

    // 학생에게 문제 전송 (정답 제외)
    const questions = exam.questions.map(q => ({ ...q, answer: undefined }));
    try { ensureTodayAttendance(parseInt(req.params.classId), req.user.id, 'exam_take'); } catch (e) {}
    res.json({ success: true, exam: { ...exam, questions }, message: '시험이 시작되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/exam/:classId/:examId/submit - 시험 제출
router.post('/:classId/:examId/submit', requireAuth, requireClassMember, (req, res) => {
  try {
    const exam = examDb.getExamById(req.params.examId);
    if (!exam) return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });

    // 이중 제출 방지: 이미 제출한 경우 (재응시 허용 시 기존 기록 삭제 후 진행)
    const existingSubmission = examDb.getStudentExam(exam.id, req.user.id);
    if (existingSubmission && existingSubmission.score != null && existingSubmission.status === 'submitted') {
      // 재응시 허용 확인
      const db2 = require('../db/index');
      let allowRetry = 0;
      try {
        const setting = db2.prepare('SELECT allow_retry FROM exams WHERE id = ?').get(exam.id);
        allowRetry = setting?.allow_retry || 0;
      } catch (e) {}
      if (allowRetry) {
        // 재응시: 기존 기록 삭제하여 다시 제출 가능하도록
        try { db2.prepare('DELETE FROM exam_students WHERE exam_id = ? AND user_id = ?').run(exam.id, req.user.id); } catch (e) {}
      } else {
        return res.json({ success: true, message: '이미 제출되었습니다.', score: existingSubmission.score });
      }
    }

    const { answers } = req.body;
    // 자동 채점
    let score = 0;
    let correctCount = 0;
    const questions = exam.questions;
    const totalItems = Array.isArray(questions) ? questions.length : 0;
    if (answers && questions) {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const a = answers[i];
        if (q.answer !== undefined && (String(a) === String(q.answer) || Number(a) === Number(q.answer))) {
          score += (q.points || (100 / questions.length));
          correctCount += 1;
        }
      }
    }
    score = Math.round(score);

    // start하지 않았으면 자동 생성
    const existing = examDb.getStudentExam(exam.id, req.user.id);
    if (!existing) examDb.startExam(exam.id, req.user.id);
    examDb.submitExam(exam.id, req.user.id, answers || [], score);
    // 재응시 횟수 집계 (기존 submission 이 있었다면 +1)
    const retryCount = existingSubmission ? 1 : 0;
    const scaledScore = score / 100;
    const achievementLevel = computeAchievementLevel(
      // 단일 시도라도 점수 기반 레벨 산출을 위해 attempts=3 이상으로 전달하되
      // retry 가 있으면 그대로 반영
      3 + retryCount,
      scaledScore
    );
    logLearningActivity({
      userId: req.user.id,
      activityType: 'exam_complete',
      targetType: 'exam',
      targetId: req.params.examId,
      classId: parseInt(req.params.classId),
      verb: 'completed',
      sourceService: 'cbt',
      resultScore: scaledScore,
      resultSuccess: score >= 60 ? 1 : 0,
      achievementCode: exam.achievement_code || null,
      subjectCode: exam.subject_code || exam.subject || null,
      gradeGroup: exam.grade_group || null,
      correctCount,
      totalItems,
      retryCount,
      achievementLevel,
      ...extractLogContext(req)
    });

    // 오답 자동 저장 (스스로채움 오답노트 연동)
    try {
      const learningDb = require('../db/learning');
      if (answers && questions) {
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const a = answers[i];
          if (q.answer !== undefined && String(a) !== String(q.answer)) {
            const optionTexts = q.options || [];
            learningDb.addWrongAnswer(req.user.id, {
              exam_id: String(exam.id),
              question_number: i + 1,
              question_text: q.text || `문제 ${i + 1}`,
              student_answer: a !== undefined ? (optionTexts[a] || String(a)) : '무응답',
              correct_answer: optionTexts[q.answer] || String(q.answer),
              explanation: q.explanation || null,
              subject: exam.subject || null
            });
          }
        }
      }
    } catch (e) { console.error('[EXAM] wrong answer save error:', e); }

    // Socket.IO: 감독관에게 제출 알림
    try {
      initSocket.notifySubmission({
        examId: exam.id,
        userId: req.user.id,
        score,
        submittedAt: new Date().toISOString()
      });
    } catch (e) { console.error('[EXAM] socket notify error:', e); }

    // xAPI: 평가 제출 assessment.submitted
    try {
      const schoolLevel = (exam.subject_code || exam.subject || '').endsWith('-e') ? '초'
        : (exam.subject_code || exam.subject || '').endsWith('-m') ? '중'
        : (exam.subject_code || exam.subject || '').endsWith('-h') ? '고' : null;
      xapiSpool.record('assessment', buildAssessment, { userId: req.user.id, classId: parseInt(req.params.classId) }, {
        verb: 'submitted',
        assessment_id: exam.id,
        title: exam.title,
        assessment_type: exam.assessment_type || 'formative',
        target_kind: 'exam',
        subject_code: exam.subject_code || exam.subject || null,
        grade_group: exam.grade_group || null,
        school_level: schoolLevel,
        curriculum_standard_ids: exam.curriculum_standard_ids || null,
        achievement_codes: exam.achievement_code || null,
        score: { raw: correctCount, max: totalItems },
        success: score >= 60,
      });
    } catch (_) {}

    // 클래스 마일리지 자동 지급 — 평가 응시 완료 시
    // UNIQUE(class_id, user_id, source_type='exam_complete', source_id=examId, reason)으로
    // 재응시·중복 호출 자동 차단되므로 항상 호출해도 안전.
    // exam.id 는 UUID 문자열이지만 awardClassMileage 내부에서 parseInt → NaN → null 저장이
    // 부작용 없이 동작(같은 평가 ID에 대해 source_type+sourceId 가 일관되게 NULL이 되므로
    // UNIQUE 제약은 동일 (classId, userId, 'exam_complete', NULL, 'exam_complete') 1행 보장).
    try {
      const { awardClassMileage } = require('../db/class-mileage');
      awardClassMileage(parseInt(req.params.classId), req.user.id, 'exam_complete', exam.id);
    } catch (_) {}

    res.json({ success: true, message: '제출되었습니다.', score });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── 상세 결과 API ────────────────────────────────────────────────────────────
// GET /api/exam/:classId/:examId/results-detail
router.get('/:classId/:examId/results-detail', requireAuth, requireClassMember, (req, res) => {
  try {
    // 교사(클래스 owner) 또는 admin만 접근 가능
    if (req.myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '결과 상세는 교사만 열람할 수 있습니다.' });
    }

    const exam = examDb.getExamById(req.params.examId);
    if (!exam || exam.class_id !== req.classId) {
      return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    }

    const students = examDb.getExamStudents(exam.id);
    const questions = exam.questions || [];
    const submitted = students.filter(s => s.status === 'submitted' && s.score != null);

    // 문항별 정답률
    const questionAccuracy = questions.map((q, i) => {
      if (!submitted.length) return { question: i + 1, correctRate: 0, text: q.text };
      const correct = submitted.filter(s => {
        const ans = Array.isArray(s.answers) ? s.answers[i] : null;
        return q.answer !== undefined && (String(ans) === String(q.answer) || Number(ans) === Number(q.answer));
      }).length;
      return {
        question: i + 1,
        correctRate: Math.round((correct / submitted.length) * 100),
        text: q.text || `문항 ${i + 1}`
      };
    });

    // 학생 점수 + 이탈 정보
    const studentResults = students.map(s => ({
      userId: s.user_id,
      displayName: s.display_name || s.username || '학생',
      username: s.username,
      score: s.score,
      status: s.status,
      tabSwitchCount: s.tab_switch_count || 0,
      totalLeaveTime: s.total_leave_time || 0,
      submittedAt: s.submitted_at,
      joinedAt: s.joined_at,
      answers: s.answers
    }));

    // 요약 통계
    const scores = submitted.map(s => s.score);
    const summary = {
      totalStudents: students.length,
      submittedCount: submitted.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      maxScore: scores.length ? Math.max(...scores) : null,
      minScore: scores.length ? Math.min(...scores) : null,
      totalQuestions: questions.length
    };

    res.json({
      success: true,
      exam: {
        id: exam.id,
        title: exam.title,
        questionCount: questions.length,
        timeLimit: exam.time_limit,
        status: exam.status,
        exam_mode: exam.exam_mode || 'text'
      },
      questionAccuracy,
      students: studentResults,
      summary
    });
  } catch (err) {
    console.error('[EXAM] results-detail error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ===== CBT 확장 (SFR-032) =====

// POST /:classId/:examId/export-to-content — 시험을 콘텐츠로 내보내기
router.post('/:classId/:examId/export-to-content', requireAuth, requireClassMember, (req, res) => {
  try {
    const result = cbtExtDb.exportToContent(req.params.examId, req.user.id);
    if (!result) return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// POST /:classId/:examId/autosave — 답안 임시저장
router.post('/:classId/:examId/autosave', requireAuth, requireClassMember, (req, res) => {
  try {
    cbtExtDb.autoSaveAnswers(req.params.examId, req.user.id, req.body.answers);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// GET /:classId/:examId/autosave — 임시저장 답안 조회
router.get('/:classId/:examId/autosave', requireAuth, requireClassMember, (req, res) => {
  try {
    const data = cbtExtDb.getAutoSavedAnswers(req.params.examId, req.user.id);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// POST /:classId/:examId/delegate — 결과 열람 권한 위임
router.post('/:classId/:examId/delegate', requireAuth, requireClassMember, (req, res) => {
  try {
    cbtExtDb.delegateAccess(req.params.examId, req.user.id, req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// GET /:classId/:examId/export-results — 결과 내보내기
router.get('/:classId/:examId/export-results', requireAuth, requireClassMember, (req, res) => {
  try {
    const data = cbtExtDb.getExamResultsForExport(req.params.examId);
    if (!data) return res.status(404).json({ success: false, message: '평가를 찾을 수 없습니다.' });
    res.json({ success: true, ...data });
  } catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
});

// multer 에러 핸들링
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'PDF 파일 크기가 10MB를 초과합니다.' });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.message === 'PDF 파일만 업로드 가능합니다.') {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

module.exports = router;
