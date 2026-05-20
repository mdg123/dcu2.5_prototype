const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const attendanceDb = require('../db/attendance');
const emotionDb = require('../db/emotion-extended');
const classDb = require('../db/class');
const { logLearningActivity } = require('../db/learning-log-helper');
const { extractLogContext } = require('../lib/log-context');
const buildNavigation = require('../lib/xapi/builders/navigation');
const xapiSpool = require('../lib/xapi/spool');
const XLSX = require('xlsx');

// 감정 숫자(1~5) ↔ 감정 키워드 매핑 (DB는 VARCHAR(30) 문자열 저장)
// 1: 매우 나쁨, 2: 나쁨, 3: 보통, 4: 좋음, 5: 매우 좋음
const EMOTION_BY_NUMBER = { 1: 'very_bad', 2: 'bad', 3: 'soso', 4: 'good', 5: 'great' };
const NUMBER_BY_EMOTION = { very_bad: 1, bad: 2, soso: 3, good: 4, great: 5 };

function normalizeEmotion(input) {
  if (input == null || input === '') return null;
  // 숫자 1~5 → 키워드
  const n = parseInt(input);
  if (!isNaN(n) && EMOTION_BY_NUMBER[n]) return EMOTION_BY_NUMBER[n];
  // 이미 키워드면 그대로
  if (typeof input === 'string') return input;
  return null;
}

function emotionToNumber(keyword) {
  if (!keyword) return null;
  return NUMBER_BY_EMOTION[keyword] || null;
}

// 클래스 멤버 확인 미들웨어
function requireMember(req, res, next) {
  const classId = parseInt(req.params.classId);
  if (!classDb.isMember(classId, req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '클래스 멤버만 접근 가능합니다.' });
  }
  req.classId = classId;
  next();
}

// 클래스 개설자(또는 admin) 미들웨어
function requireOwner(req, res, next) {
  const role = classDb.getMemberRole(req.classId, req.user.id);
  if (role !== 'owner' && role !== 'teacher' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
  }
  next();
}

// POST /api/attendance/:classId/checkin - 출석 체크 (감정·이유·한마디 동시 저장)
router.post('/:classId/checkin', requireAuth, requireMember, (req, res) => {
  try {
    const { comment, emotion, emotion_reason, emotionReason } = req.body || {};
    const emotionKey = normalizeEmotion(emotion);
    const reason = emotion_reason || emotionReason || null;
    // checkIn(classId, userId, comment, emotion, emotionReason) — db/attendance.js 시그니처
    const result = attendanceDb.checkIn(
      req.classId,
      req.user.id,
      comment || null,
      emotionKey,
      reason
    );
    if (!result.success) {
      return res.status(409).json({ success: false, message: '오늘 이미 출석했습니다.' });
    }
    // 포인트 적립
    try {
      const { awardPoints } = require('../db/point-helper');
      awardPoints(req.user.id, { source: 'attendance', sourceId: result.id || null, points: 10, description: '출석 포인트' });
    } catch (e) {}
    // 클래스 마일리지 자동 지급 (출석 체크인 — daily_limit=1)
    try {
      const { awardClassMileage } = require('../db/class-mileage');
      awardClassMileage(req.classId, req.user.id, 'attendance', result.id || null);
    } catch (e) {}
    const stats = attendanceDb.getUserStats(req.classId, req.user.id);
    logLearningActivity({
      userId: req.user.id,
      activityType: 'attendance_checkin',
      targetType: 'attendance',
      targetId: result.id || 0,
      classId: req.classId,
      verb: 'attended',
      sourceService: 'class',
      ...extractLogContext(req)
    });
    // xAPI: 출석 체크인 → navigation(did) activity-type='etc-content'
    //   AIDT 표준상 출석은 별도 영역이 없어 navigation 의 기타 콘텐츠로 표현
    try {
      xapiSpool.record('navigation', buildNavigation, { userId: req.user.id, classId: req.classId }, {
        verb: 'did',
        target_id: result.id || `attend-${req.classId}-${req.user.id}-${Date.now()}`,
        target_title: '출석 체크인',
        nav_slug: 'etc-content',
        content_type: 'other',
      });
    } catch (e) { console.error('[xapi:attendance_checkin]', e.message); }
    res.json({ success: true, message: '출석 완료!', ...stats });
  } catch (err) {
    console.error('[ATTENDANCE] checkin error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/status - 오늘 출석 상태 + 통계 (next_badge, 주/월 출석률 포함)
router.get('/:classId/status', requireAuth, requireMember, (req, res) => {
  try {
    const checked = attendanceDb.isCheckedIn(req.classId, req.user.id);
    const stats = attendanceDb.getUserStats(req.classId, req.user.id);
    res.json({ success: true, checkedIn: checked, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/ranking - 출석 랭킹
router.get('/:classId/ranking', requireAuth, requireMember, (req, res) => {
  try {
    const ranking = attendanceDb.getRanking(req.classId);
    const enriched = ranking.map((r, idx) => ({
      ...r,
      rank: idx + 1,
      streak: attendanceDb.getStreak(req.classId, r.user_id)
    }));
    res.json({ success: true, ranking: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/class-stats - 클래스 통계 (교사용)
router.get('/:classId/class-stats', requireAuth, requireMember, (req, res) => {
  try {
    const myRole = classDb.getMemberRole(req.classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }
    const stats = attendanceDb.getClassStats(req.classId);
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/table - 기간별 출석 테이블 (교사용, source 포함)
router.get('/:classId/table', requireAuth, requireMember, (req, res) => {
  try {
    const myRole = classDb.getMemberRole(req.classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 접근 가능합니다.' });
    }
    const { startDate, endDate, includeWeekends } = req.query;
    const start = startDate || getMonthStart();
    const end = endDate || new Date().toISOString().slice(0, 10);
    const table = attendanceDb.getAttendanceTable(req.classId, start, end, includeWeekends === 'true');
    res.json({ success: true, ...table });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/today - 오늘 출석 목록 (교사용)
router.get('/:classId/today', requireAuth, requireMember, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const records = attendanceDb.getAttendanceByDate(req.classId, today);
    res.json({ success: true, records, date: today });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/settings - 출석부 설정
router.get('/:classId/settings', requireAuth, requireMember, (req, res) => {
  try {
    const settings = attendanceDb.getSettings(req.classId);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// PUT /api/attendance/:classId/settings - 출석부 설정 변경
router.put('/:classId/settings', requireAuth, requireMember, (req, res) => {
  try {
    const myRole = classDb.getMemberRole(req.classId, req.user.id);
    if (myRole !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '개설자만 변경 가능합니다.' });
    }
    const settings = attendanceDb.updateSettings(req.classId, req.body);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

function getMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// =============================================================
// 감정출석부 확장 API (SFR-031)
// =============================================================

// GET /api/attendance/:classId/emotion/today - 오늘 본인 감정 체크 상태
router.get('/:classId/emotion/today', requireAuth, requireMember, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const row = db.prepare(`
      SELECT id, emotion, emotion_reason, comment, attendance_date, checked_at
      FROM attendance
      WHERE class_id = ? AND user_id = ? AND attendance_date = ?
    `).get(req.classId, req.user.id, today);
    if (!row) return res.json({ success: true, checked: false, today });
    res.json({
      success: true,
      checked: true,
      today,
      emotion: row.emotion || null,
      emotion_number: emotionToNumber(row.emotion),
      emotion_reason: row.emotion_reason || null,
      comment: row.comment || null,
      attendance_id: row.id
    });
  } catch (err) {
    console.error('[ATTENDANCE] emotion/today error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/attendance/:classId/emotion - 감정 체크/수정 (출석 행이 없으면 자동 출석 처리)
router.post('/:classId/emotion', requireAuth, requireMember, (req, res) => {
  try {
    const { emotion, reason, date } = req.body || {};
    const emotionKey = normalizeEmotion(emotion);
    if (!emotionKey) {
      return res.status(400).json({ success: false, message: '유효한 감정 값(1~5)을 입력해 주세요.' });
    }
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    // 미래 날짜 차단
    if (targetDate > today) {
      return res.status(400).json({ success: false, message: '미래 날짜는 감정을 기록할 수 없습니다.' });
    }

    let row = db.prepare(
      'SELECT id FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?'
    ).get(req.classId, req.user.id, targetDate);

    if (!row) {
      // 출석 행이 없으면 감정 체크와 함께 자동 출석 생성 (오늘 날짜에 한해)
      if (targetDate === today) {
        const result = attendanceDb.checkIn(req.classId, req.user.id, null, emotionKey, reason || null);
        if (!result.success) {
          // 동시 요청으로 직전에 생성된 경우 → 업데이트 경로로 폴백
          row = db.prepare(
            'SELECT id FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?'
          ).get(req.classId, req.user.id, targetDate);
        } else {
          return res.json({
            success: true,
            attendance_id: result.id || null,
            emotion: emotionKey,
            emotion_number: emotionToNumber(emotionKey),
            created: true
          });
        }
      } else {
        return res.status(404).json({ success: false, message: '해당 날짜에 출석 기록이 없습니다.' });
      }
    }

    // 기존 출석 행 emotion만 업데이트 (emotion-extended.saveEmotion 활용)
    emotionDb.saveEmotion(row.id, { emotion: emotionKey, emotionReason: reason || null, emotionReasonType: 'text' });
    res.json({
      success: true,
      attendance_id: row.id,
      emotion: emotionKey,
      emotion_number: emotionToNumber(emotionKey),
      updated: true
    });
  } catch (err) {
    console.error('[ATTENDANCE] emotion POST error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/emotion/calendar?from&to - 본인 월간 감정 캘린더
router.get('/:classId/emotion/calendar', requireAuth, requireMember, (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultTo = today.toISOString().slice(0, 10);
    const from = req.query.from || defaultFrom;
    const to = req.query.to || defaultTo;
    const timeline = emotionDb.getEmotionTimeline(req.classId, req.user.id, {
      startDate: from,
      endDate: to
    });
    // 숫자 매핑 부여
    const entries = timeline.map(t => ({
      ...t,
      emotion_number: emotionToNumber(t.emotion)
    }));
    res.json({ success: true, from, to, entries });
  } catch (err) {
    console.error('[ATTENDANCE] emotion/calendar error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/emotion/reflections - 본인 회고 목록
router.get('/:classId/emotion/reflections', requireAuth, requireMember, (req, res) => {
  try {
    const type = req.query.type || null;
    const list = emotionDb.getReflections(req.user.id, req.classId, type ? { type } : {});
    res.json({ success: true, reflections: list });
  } catch (err) {
    console.error('[ATTENDANCE] reflections GET error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/attendance/:classId/emotion/reflections - 회고 작성
//
// B07: start_date 친화 자동 보정
//  - 클라이언트가 { period, content } 만 보내도 KST 기준 이번 주(월~일) 또는
//    이번 달(1일~말일) 로 자동 계산하여 저장한다.
//  - 명시적으로 start_date 가 들어오면 그대로 사용한다.
router.post('/:classId/emotion/reflections', requireAuth, requireMember, (req, res) => {
  try {
    let { period, start_date, end_date, question, content, answer } = req.body || {};
    const reflectionType = period === 'monthly' ? 'monthly' : 'weekly';

    // KST(UTC+9) 기준 자동 보정 함수
    function autoStartEndKST(p) {
      const now = new Date(Date.now() + 9 * 3600 * 1000); // UTC → KST 로 9시간 시프트
      const today = now.toISOString().slice(0, 10);
      if (p === 'weekly') {
        const dow = now.getUTCDay(); // 시프트된 시간 기준 요일 (0=일, 1=월, ...)
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - (dow === 0 ? 6 : dow - 1));
        const sunday = new Date(monday);
        sunday.setUTCDate(monday.getUTCDate() + 6);
        return {
          start_date: monday.toISOString().slice(0, 10),
          end_date: sunday.toISOString().slice(0, 10)
        };
      }
      if (p === 'monthly') {
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const first = new Date(Date.UTC(y, m, 1));
        const last = new Date(Date.UTC(y, m + 1, 0)); // 다음달 0일 = 이번 달 마지막 날
        return {
          start_date: first.toISOString().slice(0, 10),
          end_date: last.toISOString().slice(0, 10)
        };
      }
      return { start_date: today, end_date: today };
    }

    // start_date/end_date 어느 하나라도 빠지면 자동 보정 적용
    if (!start_date || !end_date) {
      const auto = autoStartEndKST(reflectionType);
      start_date = start_date || auto.start_date;
      end_date = end_date || auto.end_date;
    }

    // 자동 보정 이후에도 비어 있으면 명시적 400 (이론상 발생 어려움)
    if (!start_date) {
      return res.status(400).json({ success: false, message: 'start_date는 필수입니다.' });
    }

    // end_date 미지정 시 자동 계산 (weekly=+6, monthly=+29) — 레거시 호환
    const computeEnd = (s) => {
      const d = new Date(s);
      d.setDate(d.getDate() + (reflectionType === 'monthly' ? 29 : 6));
      return d.toISOString().slice(0, 10);
    };
    const periodEnd = end_date || computeEnd(start_date);
    const answerText = content || answer || '';
    if (!answerText || !answerText.trim()) {
      return res.status(400).json({ success: false, message: '회고 내용을 입력해 주세요.' });
    }
    const result = emotionDb.createReflection(req.user.id, req.classId, {
      reflectionType,
      periodStart: start_date,
      periodEnd,
      question: question || null,
      answer: answerText.trim()
    });
    res.json({
      success: true,
      id: result.id,
      period: reflectionType,
      start_date,
      end_date: periodEnd
    });
  } catch (err) {
    console.error('[ATTENDANCE] reflections POST error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/emotion/report - 클래스 감정 통계 (개설자/교사)
router.get('/:classId/emotion/report', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const range = (startDate && endDate) ? { startDate, endDate } : {};
    const report = emotionDb.getEmotionStats(req.classId, range);

    // 시간대별(시각별) 감정 분포 추가 — 등교 시간/오전/오후 패턴 파악용
    let dateFilter = '';
    const params = [req.classId];
    if (startDate && endDate) {
      dateFilter = ' AND attendance_date BETWEEN ? AND ?';
      params.push(startDate, endDate);
    }
    const hourlyDistribution = db.prepare(`
      SELECT CAST(strftime('%H', checked_at) AS INTEGER) AS hour,
             emotion, COUNT(*) AS cnt
      FROM attendance
      WHERE class_id = ? AND emotion IS NOT NULL ${dateFilter}
      GROUP BY hour, emotion
      ORDER BY hour
    `).all(...params);

    res.json({
      success: true,
      ...report,
      hourlyDistribution,
      range: { startDate: startDate || null, endDate: endDate || null }
    });
  } catch (err) {
    console.error('[ATTENDANCE] emotion/report error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/attendance/:classId/emotion/feedback - 교사→학생 감정 피드백 (개설자)
router.post('/:classId/emotion/feedback', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    const { user_id, student_id, content, text, attendance_id } = req.body || {};
    const studentId = parseInt(user_id || student_id);
    const feedbackText = (content || text || '').trim();
    if (!studentId || !feedbackText) {
      return res.status(400).json({ success: false, message: '학생 ID와 피드백 내용이 필요합니다.' });
    }
    // 학생이 해당 클래스 멤버인지 검증
    if (!classDb.isMember(req.classId, studentId)) {
      return res.status(400).json({ success: false, message: '해당 학생은 클래스 멤버가 아닙니다.' });
    }
    const result = emotionDb.createEmotionFeedback(req.user.id, {
      studentId,
      classId: req.classId,
      attendanceId: attendance_id || null,
      text: feedbackText
    });
    // Socket.IO 알림 (있으면)
    try {
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${studentId}`).emit('emotion:feedback', {
          classId: req.classId,
          teacherId: req.user.id,
          content: feedbackText,
          createdAt: new Date().toISOString()
        });
      }
    } catch (e) { /* 무시 */ }
    res.json({ success: true, id: result.id });
  } catch (err) {
    console.error('[ATTENDANCE] emotion/feedback error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/emotion/feedback - 본인이 받은 감정 피드백 목록 (학생용)
router.get('/:classId/emotion/feedback', requireAuth, requireMember, (req, res) => {
  try {
    const list = db.prepare(`
      SELECT ef.id, ef.teacher_id, ef.feedback_text, ef.attendance_id, ef.created_at,
             u.display_name AS teacher_name
      FROM emotion_feedbacks ef
      LEFT JOIN users u ON ef.teacher_id = u.id
      WHERE ef.class_id = ? AND ef.student_id = ?
      ORDER BY ef.created_at DESC
      LIMIT 100
    `).all(req.classId, req.user.id);
    res.json({ success: true, feedbacks: list });
  } catch (err) {
    console.error('[ATTENDANCE] emotion/feedback GET error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// =============================================================
// Phase 4: 셀 PATCH (교사 편집) + 엑셀 다운로드
// =============================================================

const VALID_STATUSES = ['present', 'late', 'absent', 'leave'];

// PATCH /api/attendance/:classId/cell - 교사 셀 편집 (없으면 INSERT, 있으면 UPDATE)
router.patch('/:classId/cell', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    const { user_id, date, status, comment, emotion, emotion_reason } = req.body || {};
    const studentId = parseInt(user_id);
    if (!studentId || !date) {
      return res.status(400).json({ success: false, message: 'user_id와 date(YYYY-MM-DD)가 필요합니다.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: '날짜 형식은 YYYY-MM-DD 입니다.' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: '유효하지 않은 출석 상태입니다.' });
    }
    if (!classDb.isMember(req.classId, studentId)) {
      return res.status(400).json({ success: false, message: '해당 학생은 클래스 멤버가 아닙니다.' });
    }

    const emotionKey = emotion !== undefined ? normalizeEmotion(emotion) : undefined;

    const existing = db.prepare(
      'SELECT id, status, comment, emotion, emotion_reason FROM attendance WHERE class_id = ? AND user_id = ? AND attendance_date = ?'
    ).get(req.classId, studentId, date);

    let attendanceId;
    if (!existing) {
      // INSERT (교사 직접 입력 → checkin_source: teacher_edit)
      const info = db.prepare(`
        INSERT INTO attendance (class_id, user_id, attendance_date, status, comment, emotion, emotion_reason, checkin_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'teacher_edit')
      `).run(
        req.classId, studentId, date,
        status || 'present',
        comment != null ? comment : null,
        emotionKey || null,
        emotion_reason != null ? emotion_reason : null
      );
      attendanceId = info.lastInsertRowid;
    } else {
      // UPDATE — 전달된 필드만 갱신
      const fields = [];
      const params = [];
      if (status !== undefined) { fields.push('status = ?'); params.push(status); }
      if (comment !== undefined) { fields.push('comment = ?'); params.push(comment); }
      if (emotion !== undefined) { fields.push('emotion = ?'); params.push(emotionKey); }
      if (emotion_reason !== undefined) { fields.push('emotion_reason = ?'); params.push(emotion_reason); }
      if (fields.length > 0) {
        params.push(existing.id);
        db.prepare(`UPDATE attendance SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      }
      attendanceId = existing.id;
    }

    const row = db.prepare(
      'SELECT id, class_id, user_id, attendance_date, status, comment, emotion, emotion_reason, checkin_source, checked_at FROM attendance WHERE id = ?'
    ).get(attendanceId);

    res.json({ success: true, attendance: row });
  } catch (err) {
    console.error('[ATTENDANCE] PATCH cell error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// GET /api/attendance/:classId/export?from&to&format=xlsx|csv - 출석부 엑셀/CSV 다운로드 (교사)
router.get('/:classId/export', requireAuth, requireMember, requireOwner, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || getMonthStart();
    const to = req.query.to || today;
    const format = (req.query.format || 'xlsx').toLowerCase();
    const includeWeekends = req.query.includeWeekends === 'true';

    const table = attendanceDb.getAttendanceTable(req.classId, from, to, includeWeekends);
    const classInfo = db.prepare('SELECT name FROM classes WHERE id = ?').get(req.classId);
    const className = (classInfo && classInfo.name) ? classInfo.name : `class_${req.classId}`;

    // 학생만 (owner/teacher 제외)
    const memberRoles = db.prepare(
      "SELECT user_id, role FROM class_members WHERE class_id = ? AND status = 'active'"
    ).all(req.classId);
    const roleMap = {};
    memberRoles.forEach(m => { roleMap[m.user_id] = m.role; });
    const students = (table.members || []).filter(m => {
      const r = roleMap[m.user_id];
      return r !== 'owner' && r !== 'teacher';
    });

    const dates = table.dates || [];
    const records = table.records || {};

    // 상태/감정 약어
    const STATUS_ABBR = { present: '○', late: '△', absent: '×', leave: '↩' };
    const EMO_EMOJI = { very_bad: '😢', bad: '😟', soso: '😐', good: '😊', great: '😄' };

    // 헤더: 번호 / 이름 / [날짜...] / 출석률 / 연속 / 평균감정
    const header = ['번호', '이름', ...dates, '출석률(%)', '연속(일)', '평균감정'];
    const rows = [header];

    const EMO_SCORE = { very_bad: 1, bad: 2, soso: 3, good: 4, great: 5 };
    const EMO_LABEL_BY_SCORE = { 1: '매우 안 좋음', 2: '안 좋음', 3: '보통', 4: '좋음', 5: '매우 좋음' };

    students.forEach((m, idx) => {
      let presentLate = 0;
      let totalEmo = 0, emoCount = 0;
      const cells = dates.map(ds => {
        const rec = records[`${m.user_id}_${ds}`];
        if (!rec) return '-';
        const sym = STATUS_ABBR[rec.status] || '-';
        if (rec.status === 'present' || rec.status === 'late') presentLate++;
        const emo = rec.emotion ? EMO_EMOJI[rec.emotion] || '' : '';
        const comm = rec.comment ? ` ${String(rec.comment).slice(0, 15)}` : '';
        if (rec.emotion && EMO_SCORE[rec.emotion]) {
          totalEmo += EMO_SCORE[rec.emotion]; emoCount++;
        }
        return `${sym}${emo ? ' ' + emo : ''}${comm}`;
      });
      const rate = dates.length > 0 ? Math.round((presentLate / dates.length) * 100) : 0;
      const streak = attendanceDb.getStreak(req.classId, m.user_id);
      const avgEmoScore = emoCount > 0 ? Math.round(totalEmo / emoCount) : 0;
      const avgEmoLabel = avgEmoScore ? `${EMO_LABEL_BY_SCORE[avgEmoScore]} (${(totalEmo / emoCount).toFixed(1)})` : '-';
      rows.push([idx + 1, m.display_name || m.username || '', ...cells, rate, streak, avgEmoLabel]);
    });

    const safeName = String(className).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
    const fileBase = `attendance_${safeName}_${from}_${to}`;

    if (format === 'csv') {
      const csvLines = rows.map(r =>
        r.map(c => {
          const s = (c == null) ? '' : String(c);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')
      );
      const csv = '﻿' + csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileBase)}.csv"`);
      return res.send(csv);
    }

    // xlsx
    const ws = XLSX.utils.aoa_to_sheet(rows);
    // 열 너비
    const colWidths = [{ wch: 5 }, { wch: 14 }];
    dates.forEach(() => colWidths.push({ wch: 18 }));
    colWidths.push({ wch: 12 }, { wch: 10 }, { wch: 18 });
    ws['!cols'] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '출석부');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileBase)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('[ATTENDANCE] export error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
