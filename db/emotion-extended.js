// db/emotion-extended.js
const db = require('./index');

function saveEmotion(attendanceId, { emotion, emotionReason, emotionReasonType }) {
  db.prepare(`
    UPDATE attendance SET emotion = ?, emotion_reason = ?, emotion_reason_type = ?
    WHERE id = ?
  `).run(emotion, emotionReason || null, emotionReasonType || 'text', attendanceId);
  return { success: true };
}

function getEmotionStats(classId, { startDate, endDate } = {}) {
  let dateFilter = '';
  const params = [classId];
  if (startDate && endDate) {
    dateFilter = ' AND attendance_date BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }

  const stats = db.prepare(`
    SELECT emotion, COUNT(*) as cnt
    FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${dateFilter}
    GROUP BY emotion ORDER BY cnt DESC
  `).all(...params);

  const total = stats.reduce((s, r) => s + r.cnt, 0);
  stats.forEach(s => s.percentage = total > 0 ? Math.round(s.cnt / total * 100) : 0);

  // 학생별 최근 감정
  const studentEmotions = db.prepare(`
    SELECT a.user_id, u.display_name, a.emotion, a.emotion_reason, a.attendance_date
    FROM attendance a JOIN users u ON a.user_id = u.id
    WHERE a.class_id = ? AND a.emotion IS NOT NULL ${dateFilter}
    ORDER BY a.attendance_date DESC
  `).all(...params);

  const latestByStudent = {};
  studentEmotions.forEach(e => {
    if (!latestByStudent[e.user_id]) latestByStudent[e.user_id] = e;
  });

  // 요일별 긍정 감정 비율 (0=일, 1=월 ... 6=토)
  const positiveEmotions = ['happy', 'excited', 'good', 'great', 'calm'];
  const weekdayStats = db.prepare(`
    SELECT CAST(strftime('%w', attendance_date) AS INTEGER) as weekday,
      COUNT(*) as total,
      SUM(CASE WHEN emotion IN ('happy','excited','good','great','calm') THEN 1 ELSE 0 END) as positive_count
    FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${dateFilter}
    GROUP BY weekday ORDER BY weekday
  `).all(...params);

  // 월~금 (1~5) 긍정비율 배열
  const weekdayPositiveRates = [0, 0, 0, 0, 0]; // 월,화,수,목,금
  weekdayStats.forEach(w => {
    const idx = w.weekday - 1; // 1(월)→0, 2(화)→1, ...
    if (idx >= 0 && idx < 5 && w.total > 0) {
      weekdayPositiveRates[idx] = Math.round(w.positive_count / w.total * 100);
    }
  });

  return { stats, total, studentEmotions: Object.values(latestByStudent), weekdayPositiveRates };
}

// 특정 감정에 응답한 학생 + 날짜 목록 (교사 학습분석 드릴다운용)
function getEmotionRespondents(classId, emotion, { startDate, endDate } = {}) {
  let dateFilter = '';
  const params = [classId, emotion];
  if (startDate && endDate) {
    dateFilter = ' AND a.attendance_date BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }
  return db.prepare(`
    SELECT a.user_id, u.display_name, u.username, a.attendance_date,
           a.emotion, a.emotion_reason, a.emotion_reason_type
    FROM attendance a JOIN users u ON a.user_id = u.id
    WHERE a.class_id = ? AND a.emotion = ? ${dateFilter}
    ORDER BY a.attendance_date DESC, u.display_name
  `).all(...params);
}

function getEmotionTimeline(classId, userId, { startDate, endDate } = {}) {
  let dateFilter = '';
  const params = [classId, userId];
  if (startDate && endDate) {
    dateFilter = ' AND attendance_date BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }

  return db.prepare(`
    SELECT attendance_date, emotion, emotion_reason, emotion_reason_type
    FROM attendance
    WHERE class_id = ? AND user_id = ? AND emotion IS NOT NULL ${dateFilter}
    ORDER BY attendance_date DESC
  `).all(...params);
}

function createReflection(userId, classId, data) {
  const info = db.prepare(`
    INSERT INTO emotion_reflections (user_id, class_id, reflection_type, period_start, period_end, question, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, classId, data.reflectionType || 'weekly',
    data.periodStart, data.periodEnd, data.question || null, data.answer || null);
  return { id: info.lastInsertRowid };
}

function getReflections(userId, classId, { type } = {}) {
  let where = 'WHERE user_id = ? AND class_id = ?';
  const params = [userId, classId];
  if (type) { where += ' AND reflection_type = ?'; params.push(type); }
  return db.prepare(`SELECT * FROM emotion_reflections ${where} ORDER BY created_at DESC`).all(...params);
}

function createEmotionFeedback(teacherId, { studentId, classId, attendanceId, text }) {
  const info = db.prepare(`
    INSERT INTO emotion_feedbacks (teacher_id, student_id, class_id, attendance_id, feedback_text)
    VALUES (?, ?, ?, ?, ?)
  `).run(teacherId, studentId, classId, attendanceId || null, text);
  return { id: info.lastInsertRowid };
}

module.exports = {
  saveEmotion, getEmotionStats, getEmotionTimeline, getEmotionRespondents,
  createReflection, getReflections, createEmotionFeedback
};
