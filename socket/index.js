const examDb = require('../db/exam');
const classDb = require('../db/class');
const db = require('../db/index');

// 런타임 전용: 활성 소켓 연결 추적
// Key: examId, Value: { students: Map<userId, {socketId, displayName, joinedAt}> }
const activeExams = new Map();

function getRuntime(examId) {
  if (!activeExams.has(examId)) {
    activeExams.set(examId, { students: new Map() });
  }
  return activeExams.get(examId);
}

function initSocket(io) {
  // 학생별 이탈 감지 쓰로틀 (1초 1회)
  const throttle = {};

  // io 인스턴스를 모듈 레벨에서 접근 가능하게 저장
  initSocket._io = io;

  io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;

    const userId = session.userId;
    socket.join(`user:${userId}`);

    // ─── 학생 시험방 입장 ──────────────────────────────────────────────
    socket.on('exam:join', ({ examId, classId }) => {
      if (!examId) return;
      socket.join(`exam:${examId}`);
      socket.examId = String(examId);
      socket.classId = classId;
      socket.userId = userId;

      const runtime = getRuntime(String(examId));

      // 사용자 displayName 조회
      let displayName = '학생';
      try {
        const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
        if (user) displayName = user.display_name || user.username || '학생';
      } catch (e) {}

      // 런타임에 학생 등록
      runtime.students.set(userId, {
        socketId: socket.id,
        displayName,
        joinedAt: new Date().toISOString()
      });

      // 감독관에게 학생 입장 알림
      io.to(`exam:${examId}:supervisor`).emit('student:joined', {
        userId,
        displayName,
        joinedAt: new Date().toISOString()
      });

      // 현재 시험 상태를 학생에게 전송
      try {
        const exam = examDb.getExamById(String(examId));
        if (exam) {
          socket.emit('exam:status', { status: exam.status });
          if (exam.status === 'active') {
            socket.emit('exam:started', { startedAt: exam.started_at });
          }
        }
      } catch (e) {}
    });

    // ─── 감독관(교사) 입장 ──────────────────────────────────────────────
    socket.on('supervisor:join', ({ examId, classId }) => {
      if (!examId) return;
      const eid = String(examId);

      // 교사 권한 확인
      let authorized = false;
      try {
        const exam = examDb.getExamById(eid);
        if (!exam) {
          socket.emit('supervisor:error', { message: '시험을 찾을 수 없습니다.' });
          return;
        }
        // 시험이 해당 클래스에 속하는지 확인
        if (classId && String(exam.class_id) !== String(classId)) {
          socket.emit('supervisor:error', { message: '해당 클래스의 시험이 아닙니다.' });
          return;
        }
        if (exam.owner_id === userId) authorized = true;
        // admin 역할도 허용
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
        if (user && user.role === 'admin') authorized = true;
        // 클래스 owner도 허용
        if (classId) {
          const role = classDb.getMemberRole(parseInt(classId), userId);
          if (role === 'owner') authorized = true;
        }
      } catch (e) {}

      if (!authorized) {
        socket.emit('supervisor:error', { message: '감독 권한이 없습니다.' });
        return;
      }

      socket.join(`exam:${examId}:supervisor`);
      socket.join(`exam:${examId}`);
      socket.examId = eid;
      socket.classId = classId;
      socket.userId = userId;
      socket.isSupervisor = true;

      // 현재 접속 학생 목록 전송
      const runtime = getRuntime(eid);
      const studentsList = [];
      runtime.students.forEach((info, uid) => {
        // DB에서 최신 상태 조회
        let studentData = {};
        try {
          const es = db.prepare(
            'SELECT tab_switch_count, current_focus, score, status, submitted_at FROM exam_students WHERE exam_id = ? AND user_id = ?'
          ).get(eid, uid);
          if (es) studentData = es;
        } catch (e) {}

        studentsList.push({
          userId: uid,
          displayName: info.displayName,
          joinedAt: info.joinedAt,
          tabSwitchCount: studentData.tab_switch_count || 0,
          focused: studentData.current_focus !== 0,
          status: studentData.status || 'active',
          score: studentData.score,
          submittedAt: studentData.submitted_at
        });
      });

      socket.emit('students:list', { students: studentsList });
    });

    // ─── 시험 시작 (교사) ──────────────────────────────────────────────
    socket.on('exam:start', ({ examId }) => {
      if (!examId) return;
      const eid = String(examId);

      // 교사 권한 확인
      try {
        const exam = examDb.getExamById(eid);
        if (!exam) return;
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
        const isAdmin = user && user.role === 'admin';
        if (exam.owner_id !== userId && !isAdmin) return;

        // 시험 상태 업데이트 (이미 active이면 스킵)
        let startedAt = exam.started_at;
        if (exam.status !== 'active') {
          startedAt = new Date().toISOString();
          examDb.updateExam(eid, { status: 'active', started_at: startedAt });
        }

        // 모든 학생에게 시험 시작 알림
        io.to(`exam:${examId}`).emit('exam:started', {
          startedAt: startedAt || new Date().toISOString()
        });
      } catch (e) { console.error('[Socket] exam:start error:', e); }
    });

    // ─── 시험 종료 (교사) ──────────────────────────────────────────────
    socket.on('exam:end', ({ examId }) => {
      if (!examId) return;
      const eid = String(examId);

      try {
        const exam = examDb.getExamById(eid);
        if (!exam) return;
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
        const isAdmin = user && user.role === 'admin';
        if (exam.owner_id !== userId && !isAdmin) return;

        // 미제출 학생에게 강제 제출 알림
        io.to(`exam:${examId}`).emit('force:submit', {
          reason: '감독관이 시험을 종료했습니다.',
          deadline: 3000 // 3초 내 제출
        });

        // 3초 후 시험 종료 처리
        setTimeout(() => {
          try {
            // 미제출 학생 강제 채점
            const students = examDb.getExamStudents(eid);
            const questions = exam.questions || [];
            students.forEach(s => {
              if (s.status !== 'submitted') {
                // 현재 답안으로 강제 채점
                let score = 0;
                const studentAnswers = s.answers || [];
                if (questions.length > 0) {
                  for (let i = 0; i < questions.length; i++) {
                    const q = questions[i];
                    const a = studentAnswers[i];
                    if (q.answer !== undefined && (String(a) === String(q.answer) || Number(a) === Number(q.answer))) {
                      score += (q.points || (100 / questions.length));
                    }
                  }
                }
                score = Math.round(score);
                examDb.submitExam(eid, s.user_id, studentAnswers, score);
              }
            });

            // 시험 상태 완료로 변경
            examDb.updateExam(eid, { status: 'completed' });

            // 모든 연결에 시험 종료 알림
            io.to(`exam:${examId}`).emit('exam:ended', {
              endedAt: new Date().toISOString()
            });

            // activeExams 정리
            activeExams.delete(eid);
          } catch (e) { console.error('[Socket] exam:end finalize error:', e); }
        }, 3000);
      } catch (e) { console.error('[Socket] exam:end error:', e); }
    });

    // ─── 탭 이탈 감지 (강화) ──────────────────────────────────────────
    socket.on('tab:leave', ({ examId }) => {
      const key = `${userId}_${examId}`;
      const now = Date.now();
      if (throttle[key] && now - throttle[key] < 1000) return;
      throttle[key] = now;

      try {
        examDb.recordTabLeave(examId, userId);

        // displayName 조회
        let displayName = '학생';
        try {
          const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
          if (user) displayName = user.display_name || user.username;
        } catch (e) {}

        // tab_switch_count 조회
        let tabSwitchCount = 0;
        try {
          const es = db.prepare('SELECT tab_switch_count FROM exam_students WHERE exam_id = ? AND user_id = ?').get(String(examId), userId);
          if (es) tabSwitchCount = es.tab_switch_count;
        } catch (e) {}

        // tab_events에 이벤트 기록
        try {
          const es = db.prepare('SELECT tab_events FROM exam_students WHERE exam_id = ? AND user_id = ?').get(String(examId), userId);
          let events = [];
          try { events = JSON.parse(es?.tab_events || '[]'); } catch (e) {}
          events.push({ type: 'leave', timestamp: new Date().toISOString() });
          db.prepare('UPDATE exam_students SET tab_events = ? WHERE exam_id = ? AND user_id = ?')
            .run(JSON.stringify(events), String(examId), userId);
        } catch (e) {}

        // 감독관에게 구조화된 데이터 전송
        io.to(`exam:${examId}:supervisor`).emit('student:tab-leave', {
          userId,
          studentId: userId,
          displayName,
          tabSwitchCount,
          isFocused: false,
          timestamp: new Date().toISOString(),
          examId
        });

        // 기존 호환성: 전체 방에도 알림
        io.to(`exam:${examId}`).emit('student:tabswitch', {
          userId,
          displayName,
          tabSwitchCount,
          isFocused: false,
          timestamp: new Date().toISOString()
        });
      } catch (e) {}
    });

    socket.on('tab:return', ({ examId }) => {
      let displayName = '학생';
      let tabSwitchCount = 0;
      try {
        const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
        if (user) displayName = user.display_name || user.username;
        const es = db.prepare('SELECT tab_switch_count FROM exam_students WHERE exam_id = ? AND user_id = ?').get(String(examId), userId);
        if (es) tabSwitchCount = es.tab_switch_count;
      } catch (e) {}

      // tab_events에 복귀 이벤트 기록
      try {
        const es = db.prepare('SELECT tab_events FROM exam_students WHERE exam_id = ? AND user_id = ?').get(String(examId), userId);
        let events = [];
        try { events = JSON.parse(es?.tab_events || '[]'); } catch (e) {}
        events.push({ type: 'return', timestamp: new Date().toISOString() });
        db.prepare('UPDATE exam_students SET tab_events = ? WHERE exam_id = ? AND user_id = ?')
          .run(JSON.stringify(events), String(examId), userId);
      } catch (e) {}

      io.to(`exam:${examId}:supervisor`).emit('student:tab-return', {
        userId,
        studentId: userId,
        displayName,
        tabSwitchCount,
        isFocused: true,
        timestamp: new Date().toISOString(),
        examId
      });

      // 기존 호환
      io.to(`exam:${examId}`).emit('student:tabswitch', {
        userId,
        displayName,
        tabSwitchCount,
        isFocused: true,
        timestamp: new Date().toISOString()
      });
    });

    socket.on('focus:lost', ({ examId, duration }) => {
      if (duration && duration > 0) {
        try { examDb.updateLeaveTime(examId, userId, Math.round(duration)); } catch (e) {}
      }
    });

    socket.on('focus:gained', ({ examId }) => {
      try {
        db.prepare('UPDATE exam_students SET current_focus = 1 WHERE exam_id = ? AND user_id = ?')
          .run(String(examId), userId);
      } catch (e) {}

      io.to(`exam:${examId}:supervisor`).emit('student:tab-return', {
        userId,
        studentId: userId,
        examId,
        timestamp: new Date().toISOString()
      });
    });

    // ─── 답안 진행 업데이트 ──────────────────────────────────────────────
    socket.on('answer:update', ({ examId, questionIndex, answer }) => {
      if (!examId) return;

      // 답안 수 계산을 위해 autosave 데이터 확인
      let answeredCount = 0;
      let totalQuestions = 0;
      try {
        const exam = examDb.getExamById(String(examId));
        if (exam) {
          totalQuestions = exam.question_count || (exam.questions ? exam.questions.length : 0);
        }
        // autosave에서 현재 답안 상태 조회
        const saved = db.prepare('SELECT answers FROM exam_autosaves WHERE exam_id = ? AND user_id = ?').get(String(examId), userId);
        if (saved) {
          const answers = JSON.parse(saved.answers || '[]');
          answeredCount = answers.filter(a => a !== null && a !== undefined).length;
        }
      } catch (e) {}

      // 감독관에게 진행 상황 전송
      io.to(`exam:${examId}:supervisor`).emit('student:progress', {
        userId,
        answered: answeredCount,
        total: totalQuestions,
        questionIndex,
        answer
      });
    });

    // ─── 연결 해제 ──────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      // throttle 엔트리 정리
      Object.keys(throttle).forEach(key => {
        if (key.startsWith(`${userId}_`)) {
          delete throttle[key];
        }
      });

      if (socket.examId) {
        const runtime = getRuntime(socket.examId);
        runtime.students.delete(userId);

        let displayName = '학생';
        try {
          const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
          if (user) displayName = user.display_name || user.username;
        } catch (e) {}

        io.to(`exam:${socket.examId}:supervisor`).emit('student:disconnected', {
          userId,
          studentId: userId,
          displayName,
          examId: socket.examId
        });

        // 기존 호환
        io.to(`exam:${socket.examId}`).emit('student:disconnected', {
          studentId: userId,
          examId: socket.examId
        });
      }
    });
  });

  // ─── 주기적 정리: 완료된 시험의 activeExams 엔트리 제거 (1시간마다) ───
  setInterval(() => {
    try {
      activeExams.forEach((runtime, examId) => {
        try {
          const exam = examDb.getExamById(examId);
          if (exam && exam.status === 'completed') {
            // 완료된 시험이고 접속 학생이 없으면 정리
            if (runtime.students.size === 0) {
              activeExams.delete(examId);
            }
          }
        } catch (e) {}
      });
    } catch (e) {}
  }, 60 * 60 * 1000); // 1시간마다
}

// 외부에서 호출 가능: 제출 시 감독관에게 알림 (routes/exam.js에서 사용)
initSocket.notifySubmission = function({ examId, userId, score, submittedAt }) {
  const io = initSocket._io;
  if (!io) return;

  let displayName = '학생';
  try {
    const user = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
    if (user) displayName = user.display_name || user.username;
  } catch (e) {}

  io.to(`exam:${examId}:supervisor`).emit('student:submitted', {
    userId,
    displayName,
    score,
    submittedAt: submittedAt || new Date().toISOString()
  });
};

module.exports = initSocket;
