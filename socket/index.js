const examDb = require('../db/exam');
const classDb = require('../db/class');
const lessonDb = require('../db/lesson');
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

// ─────────────────────────────────────────────────────────────────────────────
// 수업꾸러미 동기화(교사 주도 lockstep) — 런타임 전용 상태맵 (기획서 §2.1)
// Key: lessonId(String), Value:
//   { on, controllerId, controllerName, classId, currentIndex, members(Map), updatedAt }
//   members: Map<userId, {socketId, role, displayName}>  (현재 룸 접속자)
// DB 영속 불요 — 세션성 기능. join push 로 복원, fail-open 으로 안전 수렴(§2.2).
// ─────────────────────────────────────────────────────────────────────────────
const lessonSync = new Map();

function getLessonSync(lessonId) {
  const lid = String(lessonId);
  if (!lessonSync.has(lid)) {
    lessonSync.set(lid, {
      on: false,
      controllerId: null,
      controllerName: '',
      classId: null,
      currentIndex: 0,
      members: new Map(),
      updatedAt: 0
    });
  }
  return lessonSync.get(lid);
}

// 수업 동기화 제어 권한 서버측 재검증 (기획서 §5).
// 클라가 보낸 isTeacher/role 신뢰 금지 — 매 이벤트마다 DB 로 재검증한다.
//   1) class_members(active) role ∈ {owner, co_teacher}  + lesson.class_id === classId 교차검증
//   2) users.role === 'admin' (운영 허용)
function canControlLesson(userId, classId, lessonId) {
  try {
    const m = db.prepare(
      "SELECT role FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
    ).get(classId, userId);
    const role = m ? m.role : null;
    if (role === 'owner' || role === 'co_teacher') {
      const lesson = lessonDb.getLessonById(lessonId);
      if (lesson && String(lesson.class_id) === String(classId)) return true;
    }
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (u && u.role === 'admin') {
      // admin 도 lesson↔class 교차검증은 유지 (타 클래스 lessonId 끼워넣기 차단)
      const lesson = lessonDb.getLessonById(lessonId);
      if (lesson && String(lesson.class_id) === String(classId)) return true;
    }
  } catch (e) { /* silent → 권한 없음으로 수렴(fail-closed for control) */ }
  return false;
}

// 룸 내 학생(=member) 수 산출 — 교사 헤더 "N명 동기화 중" 표기용(§3.2 peers).
function countLessonStudents(sync) {
  let n = 0;
  sync.members.forEach((info) => {
    if (info.role === 'member') n += 1;
  });
  return n;
}

// 컨트롤러 소켓에만 현재 학생 수를 통지(join/leave/disconnect/제어변경 시).
function emitLessonPeers(io, sync) {
  if (!sync || !sync.controllerId) return;
  io.to(`user:${sync.controllerId}`).emit('lesson:sync:peers', {
    count: countLessonStudents(sync)
  });
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

    // ─── 클래스 룸 입장 (마일리지 실시간 갱신·향후 클래스 단위 이벤트 공용) ─────
    // 클라이언트가 자신이 속한 class id를 알려주면 그 룸으로 join.
    // 권한 검증: class_members(status='active') 인지 확인 → 외부 클래스 잠입 방지.
    socket.on('join:class', ({ classId }) => {
      try {
        const cid = parseInt(classId);
        if (!cid) return;
        const member = db.prepare(
          "SELECT id FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
        ).get(cid, userId);
        if (!member) return;
        socket.join(`class:${cid}`);
      } catch (e) { /* silent */ }
    });

    socket.on('leave:class', ({ classId }) => {
      try {
        const cid = parseInt(classId);
        if (!cid) return;
        socket.leave(`class:${cid}`);
      } catch (e) { /* silent */ }
    });

    // 자동 join — 사용자가 속한 모든 active 클래스에 자동 입장
    // (학생/교사 양쪽 모두 잔액 위젯·랭킹 실시간 갱신을 위함)
    try {
      const rows = db.prepare(
        "SELECT class_id FROM class_members WHERE user_id = ? AND status = 'active'"
      ).all(userId);
      for (const r of rows) {
        socket.join(`class:${r.class_id}`);
      }
    } catch (e) { /* silent */ }

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
    // 정책: 감독 권한은 평가지를 **출제한 사용자(exam.owner_id)** 또는 **admin** 에게만 허용.
    // 클래스 owner 라도 출제자가 아니면 감독 모드 진입 불가.
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
        // 출제자만 허용
        if (exam.owner_id === userId) authorized = true;
        // admin 역할은 운영 목적상 허용
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
        if (user && user.role === 'admin') authorized = true;
      } catch (e) {}

      if (!authorized) {
        socket.emit('supervisor:error', { message: '감독 권한은 평가지 출제자만 가질 수 있습니다.' });
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

    // ═════════════════════════════════════════════════════════════════════
    // 수업꾸러미 동기화(교사 주도 lockstep) — 룸 lesson:{lessonId} (기획서 §3)
    //   상태 채널 단일화: 학생은 lesson:sync:state 하나만 구독하면 모든 시나리오 커버.
    //   교사뷰 판별은 서버 push(canControl)로 신뢰 — 클라 자가판단 금지.
    // ═════════════════════════════════════════════════════════════════════

    // 위반 소켓에 lesson:error 1회 통지 (연타 방지 throttle, key=`err_${userId}_${lessonId}`)
    function emitLessonError(lessonId, message) {
      const key = `lerr_${userId}_${lessonId}`;
      const now = Date.now();
      if (throttle[key] && now - throttle[key] < 1000) return;
      throttle[key] = now;
      socket.emit('lesson:error', { message });
    }

    // ─── 학생·교사 공통: 수업 동기화 룸 입장 (늦은 입장/새로고침 복원) ───
    socket.on('lesson:join', ({ classId, lessonId }) => {
      try {
        const cid = parseInt(classId);
        const lid = lessonId != null ? String(lessonId) : null;
        if (!cid || !lid) return;

        // ① 멤버십(active) 또는 admin 검증 — 잠입 차단 (join:class 원칙)
        const member = db.prepare(
          "SELECT role FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'"
        ).get(cid, userId);
        let role = member ? member.role : null;
        let isAdmin = false;
        if (!member) {
          const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
          isAdmin = !!(u && u.role === 'admin');
        }
        if (!member && !isAdmin) {
          emitLessonError(lid, '이 수업에 참여할 권한이 없습니다.');
          return;
        }

        // ② lesson↔class 교차검증 (타 클래스 lessonId 끼워넣기 차단)
        const lesson = lessonDb.getLessonById(lid);
        if (!lesson || String(lesson.class_id) !== String(cid)) {
          emitLessonError(lid, '해당 클래스의 수업이 아닙니다.');
          return;
        }

        // ③ 룸 입장
        socket.join(`lesson:${lid}`);

        // displayName 조회
        let displayName = '학생';
        try {
          const u = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
          if (u) displayName = u.display_name || u.username || '학생';
        } catch (e) {}

        const sync = getLessonSync(lid);
        sync.classId = cid;
        // ④ members 등록 (admin 은 역할 표기를 'admin' 으로 — 학생 카운트에서 제외)
        sync.members.set(userId, {
          socketId: socket.id,
          role: isAdmin ? 'admin' : (role || 'member'),
          displayName
        });

        // 이 소켓에 동기화 룸 정보를 기록(disconnect 정리·다중 룸 대비)
        if (!socket.lessonRooms) socket.lessonRooms = new Set();
        socket.lessonRooms.add(lid);
        socket.userId = userId;

        // ⑤ 그 소켓에만 현재 상태 + canControl push (FE 교사뷰 판별용 §4.4)
        //   canControl(이 사용자가 교사인가)은 per-socket(join)에서만 전달.
        //   controllerId(현재 누가 제어 중인가)는 모든 push/broadcast에 일관되게 실어 FE가 youAreController를 파생.
        const canControl = canControlLesson(userId, cid, lid);
        socket.emit('lesson:sync:state', {
          on: sync.on,
          index: sync.currentIndex,
          controllerName: sync.controllerName,
          controllerId: sync.on ? sync.controllerId : null,
          canControl,
          youAreController: sync.on && sync.controllerId === userId
        });

        // 컨트롤러에게 학생 수 갱신
        emitLessonPeers(io, sync);
      } catch (e) { /* silent */ }
    });

    // ─── 교사: 동기화 시작 (제어권 획득/이양) ───
    socket.on('lesson:sync:start', ({ classId, lessonId, index }) => {
      const lid = lessonId != null ? String(lessonId) : null;
      if (!lid) return;
      if (!canControlLesson(userId, classId, lid)) {
        emitLessonError(lid, '동기화를 제어할 권한이 없습니다.');
        return;
      }
      const sync = getLessonSync(lid);

      // controllerName = display_name || username
      let controllerName = '선생님';
      try {
        const u = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(userId);
        if (u) controllerName = u.display_name || u.username || '선생님';
      } catch (e) {}

      const idx = Number.isFinite(parseInt(index)) ? parseInt(index) : (sync.currentIndex || 0);
      sync.on = true;
      sync.controllerId = userId;          // 다른 교사가 ON이어도 제어 이양 (§4.3 last-writer-wins)
      sync.controllerName = controllerName;
      sync.classId = parseInt(classId) || sync.classId;
      sync.currentIndex = idx;
      sync.updatedAt = Date.now();

      io.to(`lesson:${lid}`).emit('lesson:sync:state', {
        on: true,
        index: idx,
        controllerName,
        controllerId: sync.controllerId   // FE youAreController 파생용(=현재 제어 교사 userId)
      });
      emitLessonPeers(io, sync);
    });

    // ─── 교사(컨트롤러 본인): 동기화 이동 (throttle 1초 leading+trailing) ───
    socket.on('lesson:sync:move', ({ classId, lessonId, index }) => {
      const lid = lessonId != null ? String(lessonId) : null;
      if (!lid) return;
      if (!canControlLesson(userId, classId, lid)) {
        emitLessonError(lid, '동기화를 제어할 권한이 없습니다.');
        return;
      }
      const sync = getLessonSync(lid);
      // controllerId 본인만 허용 (다른 교사 move 무시 §4.3)
      if (!sync.on || sync.controllerId !== userId) {
        emitLessonError(lid, '먼저 동기화를 시작(또는 이어받기)하세요.');
        return;
      }
      const idx = parseInt(index);
      if (!Number.isFinite(idx)) return;

      // throttle 1초 (leading + trailing flush) — 마지막 위치 반드시 반영(§3.4)
      const key = `lmove_${userId}_${lid}`;
      const now = Date.now();
      const broadcast = (i) => {
        sync.currentIndex = i;
        sync.updatedAt = Date.now();
        io.to(`lesson:${lid}`).emit('lesson:sync:state', {
          on: true,
          index: i,
          controllerName: sync.controllerName,
          controllerId: sync.controllerId   // FE youAreController 파생용(=현재 제어 교사 userId)
        });
      };

      if (!throttle[key] || now - throttle[key] >= 1000) {
        // leading: 즉시 반영
        throttle[key] = now;
        // 대기 중이던 trailing 예약 취소(있으면) — 방금 즉시 반영했으므로
        if (throttle[`${key}_t`]) { clearTimeout(throttle[`${key}_t`]); delete throttle[`${key}_t`]; }
        broadcast(idx);
      } else {
        // throttle 윈도우 내 → trailing 으로 최신값 1회 예약(기존 예약 갱신)
        throttle[`${key}_idx`] = idx;
        if (!throttle[`${key}_t`]) {
          const wait = 1000 - (now - throttle[key]);
          throttle[`${key}_t`] = setTimeout(() => {
            delete throttle[`${key}_t`];
            const s = lessonSync.get(lid);
            // 여전히 동일 컨트롤러·ON 일 때만 trailing flush
            if (s && s.on && s.controllerId === userId) {
              throttle[key] = Date.now();
              broadcast(throttle[`${key}_idx`]);
            }
            delete throttle[`${key}_idx`];
          }, Math.max(0, wait));
        }
      }
    });

    // ─── 교사: 동기화 종료 (throttle 제외 — 즉시) ───
    socket.on('lesson:sync:end', ({ classId, lessonId }) => {
      const lid = lessonId != null ? String(lessonId) : null;
      if (!lid) return;
      if (!canControlLesson(userId, classId, lid)) {
        emitLessonError(lid, '동기화를 제어할 권한이 없습니다.');
        return;
      }
      const sync = getLessonSync(lid);
      sync.on = false;
      sync.updatedAt = Date.now();
      // 대기 중 trailing move 취소
      const key = `lmove_${userId}_${lid}`;
      if (throttle[`${key}_t`]) { clearTimeout(throttle[`${key}_t`]); delete throttle[`${key}_t`]; }
      // off 상태이므로 controllerId=null (FE는 controllerId로 youAreController 파생 → null이면 모두 false)
      io.to(`lesson:${lid}`).emit('lesson:sync:state', { on: false, controllerId: null });
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

      // ─── 수업꾸러미 동기화 정리 (기획서 §4.2 fail-open, grace 0초) ───
      if (socket.lessonRooms && socket.lessonRooms.size > 0) {
        socket.lessonRooms.forEach((lid) => {
          const sync = lessonSync.get(lid);
          if (!sync) return;

          // 이 소켓의 멤버 엔트리 제거 — 단, 같은 userId의 다른 탭이 살아있으면 유지.
          const existing = sync.members.get(userId);
          if (existing && existing.socketId === socket.id) {
            sync.members.delete(userId);
          }

          // 컨트롤러(=이 userId)가 이탈하면 즉시 동기화 종료 → 학생 자동 잠금해제(fail-open)
          if (sync.on && sync.controllerId === userId) {
            // 같은 교사의 다른 탭이 여전히 컨트롤러로 룸에 남아있는지 확인
            const stillHere = sync.members.has(userId);
            if (!stillHere) {
              sync.on = false;
              sync.updatedAt = Date.now();
              // 대기 중 trailing move 취소
              const mkey = `lmove_${userId}_${lid}`;
              if (throttle[`${mkey}_t`]) { clearTimeout(throttle[`${mkey}_t`]); delete throttle[`${mkey}_t`]; }
              io.to(`lesson:${lid}`).emit('lesson:sync:state', { on: false, controllerId: null });
              io.to(`lesson:${lid}`).emit('lesson:sync:teacher-left', {
                message: '선생님이 나가 자유 이동으로 전환됐어요'
              });
            }
          }

          // 남은 컨트롤러에게 학생 수 갱신
          emitLessonPeers(io, sync);

          // 룸이 비면 엔트리 제거(GC)
          if (sync.members.size === 0) {
            lessonSync.delete(lid);
          }

          // L-1: 이 lesson의 throttle 키 정리 (접두 lmove_/lerr_ 는 위쪽 `${userId}_` sweep이 못 잡음).
          // 같은 userId의 다른 탭이 룸에 남아있어도, 이 lid 키는 userId 단위라 안전하게 정리 가능
          // (다른 탭이 곧 move 하면 leading 으로 다시 셋업됨). 대기 중 trailing 타이머는 반드시 clear.
          const mk = `lmove_${userId}_${lid}`;
          if (throttle[`${mk}_t`]) { clearTimeout(throttle[`${mk}_t`]); delete throttle[`${mk}_t`]; }
          delete throttle[mk];
          delete throttle[`${mk}_idx`];
          delete throttle[`lerr_${userId}_${lid}`];
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
      // 수업꾸러미 동기화: 접속자 없는 빈 엔트리 정리 (§2.3)
      lessonSync.forEach((sync, lessonId) => {
        try {
          if (sync.members.size === 0) {
            lessonSync.delete(lessonId);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }, 60 * 60 * 1000).unref(); // 1시간마다 — unref: 백그라운드 GC 타이머가 프로세스/테스트 종료를 막지 않게
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

// 단위 테스트용 노출 — 수업 동기화 권한 재검증 함수 (test/lesson-sync-permission.test.js)
initSocket.canControlLesson = canControlLesson;
// 런타임 상태맵 노출(디버깅·테스트용 — 실서비스 직접 변경 금지)
initSocket._lessonSync = lessonSync;

module.exports = initSocket;
