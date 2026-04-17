# 베타 테스트 보고서 - 교사 관점

**작성일:** 2026-04-16  
**버전:** 실시간 CBT 감독 시스템 (prototype)  
**테스터 역할:** 초등학교 담임교사 (클래스 owner)  
**검토 범위:** `public/cbt/index.html`, `public/cbt/supervisor.html`, `socket/index.js`, `routes/exam.js`, `public/cbt/result.html`, `public/cbt/player.html`, `db/exam.js`

---

## 1. 치명적 버그 (Critical)

### [C-01] 시험 종료 시 DB 상태 불일치 — `completed` vs `ended`

- **파일:** `socket/index.js:202` / `db/exam.js:63`
- **문제:** `exam:end` 소켓 핸들러는 3초 후 `examDb.updateExam(eid, { status: 'completed' })` 를 호출한다. 그런데 `db/exam.js updateExam()` 함수(63번째 줄)에서 `status === 'ended'` 일 때만 `ended_at = CURRENT_TIMESTAMP`를 기록한다. `'completed'`는 이 조건에 해당하지 않으므로 **`ended_at` 컬럼이 영구적으로 NULL로 남는다.**
- **재현:** 교사가 "시험 종료" 버튼 클릭 → 3초 후 DB에서 `SELECT ended_at FROM exams` 확인 → NULL
- **제안 해결:**
  ```js
  // db/exam.js, updateExam() 내부
  if (key === 'status' && (val === 'ended' || val === 'completed')) {
    fields.push('ended_at = CURRENT_TIMESTAMP');
  }
  ```

---

### [C-02] 시험 강제 종료 시 학생이 이미 disconnect된 경우 채점 누락

- **파일:** `socket/index.js:180–198`
- **문제:** `exam:end` 핸들러의 3초 후 콜백에서 `examDb.getExamStudents(eid)`로 DB에 등록된 학생만 처리한다. 그러나 학생이 네트워크 단절 등으로 `exam_students` 레코드가 생성되지 않은 상태라면 (`startExam()`을 한 번도 호출 못 한 경우), 해당 학생은 강제 채점에서 **완전히 누락**된다.
- **재현:** 학생 접속 직후(DB 미등록 상태) 교사가 즉시 시험 종료 → 해당 학생 결과 페이지에 미표시
- **제안 해결:** `activeExams` 런타임 맵의 학생 목록과 DB 학생 목록을 교차 비교하고, 런타임에만 있는 학생도 미제출 처리.

---

### [C-03] PDF 평가 생성 UI — 정답 입력 경로 없음

- **파일:** `public/cbt/index.html:396–412` (showCreatePdfModal), `routes/exam.js:91–149` (create-pdf)
- **문제:** "PDF 평가 만들기" 버튼을 누르면 `showCreatePdfModal()`이 호출되는데, 이 함수는 단순히 기존 텍스트 평가 생성 모달(`createModal`)을 `exam_type = 'pdf'`로 설정하여 그대로 보여준다. 모달에는 **PDF 파일 업로드 필드가 없고**, **OMR 정답 입력 UI도 없다.** `routes/exam.js`의 `create-pdf` 엔드포인트(`POST /:classId/create-pdf`)는 `multipart/form-data`와 `answers` 배열을 요구하는데, 현재 UI에서는 이 엔드포인트를 전혀 호출하지 않는다. `submitExam()` 함수는 `POST /:classId`로 JSON을 보낼 뿐이다.
- **결과:** PDF 평가를 만들려 해도 PDF 파일도 첨부되지 않고, 정답도 입력되지 않으며, `exam_mode`도 'pdf'로 설정되지 않는다. **PDF 평가 생성 기능이 사실상 전혀 동작하지 않는다.**
- **제안 해결:** PDF 전용 모달을 별도로 구현하거나, `showCreatePdfModal()`에서 `<input type="file" accept="application/pdf">`와 정답 번호 입력 UI를 동적으로 삽입하고, 제출 시 `FormData`로 `create-pdf` 엔드포인트를 호출하도록 수정.

---

### [C-04] 교사가 `viewExam()` 클릭 시 — PDF 평가는 감독 대시보드 대신 text player로 이동

- **파일:** `public/cbt/index.html:314–322`
- **문제:** `viewExam(examId)` 함수는 교사라면 `openSupervisor(examId)`를 호출하도록 되어 있어 정상이다. 그러나 **학생이 PDF 평가 카드를 클릭하면** `startExam(examId)`를 호출하여 `player.html`로 이동한다. PDF 평가는 `pdf-player.html`로 가야 하는데, `viewExam()`에서는 `isPdfExam` 여부를 전혀 확인하지 않는다. 카드 본문 클릭은 학생도 같은 `viewExam()`을 거치므로, 학생이 직접 카드 본문을 클릭하면 잘못된 플레이어로 이동한다.
- **재현:** 학생 계정 → PDF 평가 카드 본문 클릭 → `player.html`로 이동, PDF가 표시되지 않음
- **제안 해결:**
  ```js
  async function viewExam(examId) {
    const exam = (examGrid내 렌더링된 카드에서 exam 객체 조회);
    if (isOwner) { openSupervisor(examId); }
    else if (exam?.exam_type === 'pdf') { startPdfExam(examId); }
    else { startExam(examId); }
  }
  ```

---

### [C-05] 감독 대시보드 — 교사가 페이지 새로고침 시 타이머가 0부터 재시작

- **파일:** `public/cbt/supervisor.html:459–484` (loadExamInfo), `supervisor.html:675–696` (startTimer)
- **문제:** `loadExamInfo()`에서 `examData.status === 'active'`이면 `setExamStatus('active')`를 호출하고 `startTimer()`를 시작한다. 그런데 타이머는 항상 `remainingSeconds = totalSeconds` (전체 시간)으로 초기화된다. DB에 `started_at` 컬럼이 존재하지만 이를 읽어서 **이미 경과한 시간을 차감하는 로직이 없다.** 교사가 시험 중간에 새로고침하면 타이머가 처음부터 다시 카운트다운된다.
- **결과:** 교사는 실제 남은 시간과 다른 타이머를 보게 되며, "시간이 거의 다 됐다"는 판단 오류 가능.
- **제안 해결:**
  ```js
  if (examData.status === 'active' && examData.started_at) {
    const elapsed = Math.floor((Date.now() - new Date(examData.started_at).getTime()) / 1000);
    remainingSeconds = Math.max(0, totalSeconds - elapsed);
  }
  ```

---

## 2. 주요 이슈 (Major)

### [M-01] 시험 시작 버튼 — 소켓 실패 시 DB 업데이트 없이 `exam:start` 소켓 이벤트만 전송

- **파일:** `public/cbt/supervisor.html:610–628` (startExam 함수 catch 블록)
- **문제:** `startExam()` 함수의 `catch` 블록(625–627줄)에서 REST API 요청이 실패하면 오류를 무시하고 `socket.emit('exam:start', { examId })`를 그냥 보낸다. 이렇게 되면 DB에는 `status = 'waiting'`으로 남아있는데 소켓으로만 `exam:started`가 학생들에게 전달된다. 나중에 페이지를 새로고침하면 시험이 아직 시작 안 된 상태로 표시된다.
- **제안 해결:** catch 블록에서 소켓 emit도 중단하고 교사에게 실패 토스트를 표시. REST API 성공 후에만 소켓 emit.

---

### [M-02] 소켓 권한 확인 — `classId` 없이 `supervisor:join` 요청 시 class owner 확인 불가

- **파일:** `socket/index.js:74–131` (supervisor:join 핸들러)
- **문제:** 87번째 줄 `if (classId)` 조건으로 classId가 없을 경우 class owner 확인을 건너뛴다. `exam.owner_id === userId` 또는 `admin`이면 통과하는데, 실제로 `exam.owner_id`가 없는 상황(잘못된 examId 등)이면 `authorized = false`로 거부된다. 그런데 클래스에 멤버로 추가된 보조 교사(owner가 아닌 member)는 `classId`를 전달하더라도 `getMemberRole()`이 'member'를 반환하므로 **정당한 보조 교사가 감독 패널에 접근할 수 없다.** 반면 `exam.owner_id`가 맞는 교사는 다른 클래스에서도 같은 exam에 접근 가능하다는 잠재적 위험이 있다.
- **제안 해결:** 클래스 멤버 역할 확인 시 'owner' 외에도 'co-teacher' 등 별도 역할 허용 여부를 정책으로 결정하고 일관성 있게 처리.

---

### [M-03] 시험 상태 통계 — 필터 적용 시 전체 통계가 현재 페이지 기준으로만 계산됨

- **파일:** `public/cbt/index.html:245–250`
- **문제:** 필터 버튼(임시저장/진행 중/완료)을 클릭하면 `loadExams()`가 해당 `?status=` 파라미터로 API를 호출한다. 그런데 통계 카드(`statActive`, `statDraft`, `statCompleted`)는 `exams.filter(e => e.status === ...)` 로 **현재 필터링된 결과만** 집계한다. 예: "진행 중" 필터 클릭 시 `statDraft`와 `statCompleted`는 0이 된다.
- **제안 해결:** 통계는 별도 API 호출(`?status=` 없이 전체 조회) 또는 백엔드에서 집계해서 함께 반환.

---

### [M-04] 감독 대시보드 — 소켓 연결 실패 시 목업 데이터가 실제 데이터인 것처럼 표시됨

- **파일:** `public/cbt/supervisor.html:560–564`, `874–888`
- **문제:** `connectSocket()`의 catch 블록에서 Socket.IO 연결 실패 시 `loadMockStudents()`를 호출하여 가상의 학생 7명(김민준, 이서연 등)을 표시한다. 교사가 네트워크 오류 상황에서 이를 실제 학생 데이터로 오인할 가능성이 있다. LIVE 배지도 계속 깜빡여 실시간처럼 보인다.
- **제안 해결:** 목업 데이터 표시 전 "소켓 연결 실패 — 오프라인 미리보기" 배너를 명확히 표시하거나, 프로덕션 빌드에서는 목업 로딩 자체를 제거하고 오류 안내만 표시.

---

### [M-05] `exam:end` 소켓 — `force:submit` 수신 후 학생 응답 없어도 3초 후 강제 채점

- **파일:** `socket/index.js:171–209`
- **문제:** 교사가 종료하면 학생 클라이언트에 `force:submit` (deadline: 3000ms)을 보내고, 3초 후 서버에서 미제출 학생의 현재 DB 답안으로 강제 채점한다. 그런데 `force:submit`을 받은 학생 클라이언트는 `submitExam(true)` → `POST /submit`을 호출하는데, 이 HTTP 요청이 3초 안에 완료되는 것을 보장하지 않는다. 네트워크 지연이 있을 경우 서버의 3초 setTimeout이 먼저 실행되어 학생의 마지막 답안이 반영되지 않은 채로 채점될 수 있다.
- **제안 해결:** 3초를 5~10초로 늘리거나, 학생 제출 완료 카운트를 추적하여 모든 응답을 기다린 후(또는 타임아웃 후) 강제 채점 실행.

---

### [M-06] `recordTabLeave` — 학생이 exam_students 레코드 없이 탭 이탈 이벤트 보낼 경우 오류 없이 무시됨

- **파일:** `socket/index.js:214–266`, `db/exam.js:118–122`
- **문제:** `tab:leave` 소켓 이벤트를 받으면 `examDb.recordTabLeave(examId, userId)`를 호출하는데, 이는 `UPDATE exam_students SET tab_switch_count = tab_switch_count + 1 WHERE exam_id = ? AND user_id = ?`를 실행한다. 만약 해당 학생이 아직 `exam:join` → startExam API를 호출하지 않아 `exam_students` 레코드가 없으면 UPDATE가 실행되어도 0 rows affected로 조용히 실패하고, 탭 이탈이 기록되지 않는다.
- **제안 해결:** `startExam` 또는 `exam:join` 시 `exam_students` 레코드를 먼저 생성(UPSERT)하도록 수정.

---

### [M-07] `results-detail` API — admin 계정 아닌 일반 교사도 교차 클래스 접근 가능

- **파일:** `routes/exam.js:356–424`
- **문제:** `results-detail` 엔드포인트는 `requireClassMember` 미들웨어만 통과하면 된다. 즉, 클래스 멤버라면 `role === 'member'`인 학생도 이 엔드포인트에 접근하여 **모든 학생의 점수, 이탈 횟수, 제출 시간, 답안**을 볼 수 있다. 교사 전용 API임에도 역할 확인이 없다.
- **재현:** 학생 계정으로 `GET /api/exam/:classId/:examId/results-detail` 직접 호출 → 200 OK와 전체 학생 데이터 반환
- **제안 해결:**
  ```js
  if (req.myRole !== 'owner' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '교사만 접근할 수 있습니다.' });
  }
  ```

---

### [M-08] `deleteExam` — 진행 중인 시험 삭제 가능

- **파일:** `routes/exam.js:246–256`
- **문제:** `DELETE /:classId/:examId`는 시험 상태를 확인하지 않는다. `status === 'active'` 즉 학생들이 응시 중인 시험도 즉시 삭제된다. 응시 중인 학생들의 `exam_students` 레코드와 autosave 데이터가 orphan 상태로 남거나 외래키 제약에 따라 같이 삭제되어 응시 중 오류가 발생한다.
- **제안 해결:** 삭제 전 `exam.status` 확인, `active` 상태에서는 삭제 거부.

---

## 3. 개선 제안 (Enhancement)

### [E-01] 시험 통계 카드 — "진행 중" 아이콘이 `fa-edit`(연필)로 잘못 설정됨

- **파일:** `public/cbt/index.html:113`
- **문제:** "진행 중" 통계 카드의 아이콘이 `fa-play-circle`로 되어 있는 HTML 주석과 달리 실제 코드를 보면 `fa-play-circle`이 맞지만, 감독 대시보드(`supervisor.html:334`)의 "응시 중" 카드 아이콘은 `fa-edit`(연필)이다. 응시 중을 연필 아이콘으로 나타내는 것은 직관적이지 않다.
- **제안:** `fa-pencil-alt` → `fa-play-circle` 또는 `fa-user-check` 등으로 변경.

### [E-02] 감독 대시보드 — 답안 진행 열이 `waiting` 상태 학생에게도 표시됨

- **파일:** `public/cbt/supervisor.html:719`
- **문제:** `status === 'submitted'`이면 `s.total/s.total`로 표시하지만, `status === 'waiting'`인 학생은 `s.answered/s.total`(보통 0/0)이 그대로 표시된다. 0/0이 표시되는 것은 혼란스럽다.
- **제안:** `status === 'waiting'`이면 `–`로 표시.

### [E-03] 감독 대시보드 — "결과 보기" 버튼이 시험 종료 전에도 항상 표시됨

- **파일:** `public/cbt/supervisor.html:296`
- **문제:** "결과 보기" 버튼은 시험 시작 전(대기 중) 상태에서도 표시된다. 클릭하면 `result.html`로 이동하지만 아직 아무도 응시하지 않았으므로 빈 결과가 보인다. 시험 종료 후 또는 최소 1명 이상 제출 후에만 활성화하는 것이 자연스럽다.
- **제안:** `examStatus === 'ended'` 또는 `statSubmitted > 0` 일 때만 버튼 활성화.

### [E-04] 결과 페이지 — 오류 시 목업 데이터 자동 로드 (프로덕션 위험)

- **파일:** `public/cbt/result.html:466–468`
- **문제:** `loadData()`의 catch 블록에서 오류 발생 시 `loadMockData()`를 호출한다. 프로덕션에서 API 오류 상황에 가짜 학생 데이터(김민준 95점 등)가 그대로 표시될 수 있다.
- **제안:** catch 블록에서 `renderError()` 호출로 변경, 목업 데이터는 개발 환경에서만 사용.

### [E-05] PDF 업로드 — MIME 타입만으로 검증, 확장자 검증 없음

- **파일:** `routes/exam.js:25–29`
- **문제:** `fileFilter`에서 `file.mimetype === 'application/pdf'`만 확인한다. 클라이언트가 임의로 MIME 타입을 조작할 수 있으며, 실제 파일 확장자(`.pdf`)는 확인하지 않는다. 저장 시 파일명은 `uuid + '.pdf'`로 고정되므로 확장자 위협은 제한적이지만, 서버에서 `path.extname(file.originalname)`을 추가로 검증하는 것이 권장된다.
- **제안:**
  ```js
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype === 'application/pdf' && ext === '.pdf') cb(null, true);
  else cb(new Error('PDF 파일만 업로드 가능합니다.'));
  ```

### [E-06] `exam:start` 소켓 — 클래스 owner 역할 확인 없음 (exam owner만 확인)

- **파일:** `socket/index.js:134–156`
- **문제:** `supervisor:join`은 exam owner, admin, class owner 세 가지를 모두 확인하는데, `exam:start`와 `exam:end` 핸들러는 `exam.owner_id === userId` 또는 `admin`만 확인한다. 클래스 owner지만 시험을 다른 교사가 만든 경우, 클래스 owner가 `supervisor:join`에는 입장 가능하지만 `exam:start`/`exam:end`는 보낼 수 없는 불일치가 발생한다.

### [E-07] 감독 대시보드 — 내보내기 CSV 이름에 쉼표 포함 시 파싱 오류

- **파일:** `public/cbt/supervisor.html:860–868`
- **문제:** `exportResults()`에서 CSV를 생성할 때 학생 이름, 상태값 등에 쉼표가 포함될 경우 별도 quote 처리 없이 그대로 조인한다. 반면 `result.html`의 `exportCSV()`는 각 값을 `"${v}"`로 감싸고 있어 일관성이 없다.
- **제안:** `supervisor.html`의 CSV도 `result.html`과 같이 값을 따옴표로 감싸도록 수정.

### [E-08] `player.html` — 교사가 monitor 패널 내에서 학생 소켓 이벤트를 수신함

- **파일:** `public/cbt/player.html:236–238`, `539–552`
- **문제:** `player.html`은 교사 계정(`currentUser.role === 'teacher'`)으로도 접근 가능하며, 이 경우 `exam:join` 소켓 이벤트를 전송한다. 서버에서는 교사도 학생 방(`exam:${examId}`)에 조인되므로, 교사가 학생으로 카운트될 수 있다(`statConnected`에 포함). 감독 대시보드의 "접속 인원"이 실제 학생 수보다 1 이상 많아진다.

---

## 4. UX 피드백

### [U-01] PDF 평가 생성 플로우 — 교사에게 완전히 불명확

"PDF 평가 만들기" 버튼을 누르면 일반 텍스트 평가 모달과 거의 동일한 화면이 열린다. PDF 파일을 어디서 올리는지, 정답을 어떻게 입력하는지 안내가 전혀 없다. 실제 교사라면 이 화면을 보고 PDF 기능이 작동하지 않는다고 혼란스러워할 것이다. **별도의 단계별 PDF 평가 생성 마법사(Wizard)** 형태의 UI가 필요하다: ①제목/시간 → ②PDF 파일 업로드 → ③정답 입력 → ④저장.

### [U-02] 감독 대시보드 — "시험 시작" 확인 다이얼로그가 충분하지 않음

`confirm('시험을 시작하시겠습니까?')` 다이얼로그는 브라우저 기본 모달이며, 한 번 클릭하면 되돌릴 수 없다는 안내가 없다. 교사가 실수로 클릭해서 대기 중인 학생이 없는 상태에서 시험이 시작될 수 있다. 사용자 정의 확인 모달에 "현재 접속 학생: N명", "시작 후에는 취소할 수 없습니다" 등의 정보를 포함하는 것을 권장한다.

### [U-03] 감독 대시보드 — 이탈 횟수 경계값 기준이 불명확

`leaveCount >= 3`이면 행이 빨간 배경(`row-alert`)으로 표시되고, 이탈 횟수가 1~2이면 주황, 3 이상이면 빨간색으로 구분된다. 그러나 교사에게 이 기준이 어디에도 설명되어 있지 않다. "3회 이상이면 부정행위 의심" 등의 툴팁이나 범례가 테이블 상단에 있으면 좋겠다.

### [U-04] 결과 페이지 — 순위 배지 색상이 역직관적

- 1위: 노란 배경 (rank-1)
- 2위: 회색 배경 (rank-2)  
- 3위: **빨간 배경** (rank-3)

3위를 빨간색으로 표시하는 것은 한국 교육 문화에서 "위험/낮은 성취"로 오해될 수 있다. 동메달을 의미하는 bronze 색(#CD7F32 계열)으로 변경 권장.

### [U-05] index.html — 편집 모달에서 PDF 평가 편집 불가

교사가 PDF 평가의 편집 버튼을 누르면 `editExam()`이 호출된다. 이 함수는 일반 텍스트 평가 모달을 열고 `exam.questions`(JSON 배열)를 불러온다. PDF 평가는 질문 텍스트가 "문항 1", "문항 2" 형식의 placeholder여서 편집할 실질적인 내용이 없다. 교사는 PDF를 교체하거나 정답을 수정해야 하는데 이 UI가 없다.

### [U-06] 감독 대시보드 — 시험 종료 후 타이머가 000:00으로 표시되지 않고 멈춤

`setExamStatus('ended')`에서 `clearInterval(timerInterval)`만 하기 때문에 마지막 값이 표시된 채로 멈춘다. "시간 종료" 또는 "시험 완료" 텍스트로 명시적으로 변경하는 것이 좋다.

### [U-07] 클래스 선택 없이 감독 대시보드 직접 접근 가능

`supervisor.html`은 URL에 `classId`와 `examId`만 있으면 접근 가능하다. index.html을 거치지 않고 URL 직접 입력 시 `classId`와 `examId`가 URL에 있으면 소켓 권한 확인만 통과하면 된다. UI 진입점은 문제없으나, URL을 알고 있는 다른 교사가 직접 접근할 수 있다는 점은 인지하고 있어야 한다.

---

## 5. 종합 평가

### 긍정적인 부분

- 실시간 이탈 감지 및 감독 알림 시스템의 **아키텍처는 탄탄**하다. `tab:leave` → 쓰로틀 → DB 기록 → 감독 알림 흐름이 잘 설계되어 있다.
- 강제 제출 메커니즘(`force:submit` → 3초 딜레이 → 서버 채점)은 교사 입장에서 **편리하고 합리적인 흐름**이다.
- 학생 응시 화면(`player.html`)의 대기실(Waiting Room) 경험은 **UI가 친절**하고 학생 지침이 명확하다.
- 오답노트 자동 연동, 자동저장, LRS 로그 기록 등 **부가 기능 연동이 충실**하다.
- CSV 내보내기, 인쇄 기능이 결과 페이지에 포함되어 있어 **실무 활용성이 있다.**
- `escHtml()` 함수를 사용하여 XSS 기본 방어가 되어 있다.

### 개선이 시급한 부분

| 우선순위 | 항목 |
|---------|------|
| 즉시 수정 | PDF 평가 생성 UI가 동작하지 않음 (C-03) |
| 즉시 수정 | results-detail 학생 접근 차단 누락 (M-07) |
| 즉시 수정 | 시험 종료 시 ended_at NULL 버그 (C-01) |
| 배포 전 | 교사 새로고침 시 타이머 리셋 (C-05) |
| 배포 전 | 오류 시 목업 데이터 자동 표시 (E-04) |
| 배포 전 | 진행 중 시험 삭제 차단 (M-08) |

### 전체 평가

현재 코드 상태는 **개발 프로토타입 수준**으로, 핵심 소켓 감독 기능은 기본 흐름이 구현되어 있으나 PDF 평가 생성의 UI-API 연결 누락, 보안(results-detail 권한), 데이터 정합성(ended_at, 타이머 재시작) 문제가 프로덕션 배포 전에 반드시 수정되어야 한다. 특히 **[C-03] PDF 평가 생성 불가**는 주요 기능 자체가 동작하지 않는 치명적 결함이므로 즉시 수정이 필요하다.

---

*보고서 작성: Claude AI 기반 자동 코드 리뷰 (교사 관점 베타 테스트)*
