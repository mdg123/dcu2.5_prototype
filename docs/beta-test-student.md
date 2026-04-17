# 베타 테스트 보고서 - 학생 관점

**작성일:** 2026-04-16
**테스터:** 학생 베타테스터 (초등학생 시나리오 기준)
**검토 대상:** 다채움 CBT 시스템 (채움CBT)
**검토 파일:**
- `public/cbt/player.html` — 텍스트형 시험 플레이어
- `public/cbt/pdf-player.html` — PDF형 시험 플레이어
- `public/cbt/index.html` — 시험 목록
- `socket/index.js` — 소켓 이벤트 처리
- `routes/exam.js` — API 엔드포인트

---

## 1. 치명적 버그 (Critical)

### [C-01] 대기실에서 탭 이탈 시 경고 팝업이 뜨지 않지만 이탈 횟수가 카운트될 수 있음
- **파일:** `public/cbt/player.html` (line 498-518), `public/cbt/pdf-player.html` (line 663-679)
- **문제 설명:**
  - `player.html`의 `setupTabDetection()`은 `isWaiting` 플래그로 이탈 감지를 차단하지만, `window.blur` 이벤트는 `isWaiting`과 무관하게 `focus:lost` 소켓 이벤트를 발송한다. 소켓 서버(`socket/index.js` line 309-312)에서는 `focus:lost` 시 `examDb.updateLeaveTime()`이 호출되는데, 이 DB 업데이트가 `exam_students` 레코드가 없어도 오류 없이 실행될 경우, 대기실에서 잠깐 딴 창을 본 것이 나중에 기록으로 남을 수 있다.
  - `pdf-player.html`에서는 `window.focus` 이벤트 핸들러가 있어 대기 중에도 `focus:gained` 소켓 이벤트를 보낸다(`isWaiting` 체크 없음).
- **학생 입장에서의 영향:** 대기실에서 화장실을 가거나 실수로 다른 창을 클릭했을 때, 시험도 시작하지 않았는데 이탈 기록이 남을 수 있다. 선생님께 억울하게 의심받을 수 있다.
- **제안 해결 방법:**
  - `window.blur` 및 `window.focus` 이벤트 핸들러에도 `isWaiting || isSubmitted` 가드를 추가한다.
  ```js
  window.addEventListener('blur', () => {
    if (!isWaiting && !isSubmitted && socket) { ... }
  });
  window.addEventListener('focus', () => {
    if (!isWaiting && !isSubmitted && socket) { ... }
  });
  ```

---

### [C-02] PDF 시험에서 시험 시작 전에 PDF 파일이 로드됨 (시험지 사전 열람 가능)
- **파일:** `public/cbt/pdf-player.html` (line 463-465), `routes/exam.js` (line 153-194)
- **문제 설명:**
  - `loadExamInfo()` 함수에서 `examData.status === 'active'`를 확인하지 않고 즉시 `loadPDF(pdf)` 를 호출한다 (line 463-465). 즉, 시험 상태가 `waiting`이어도 PDF가 로드된다.
  - 반면 서버의 PDF 스트리밍 API (`routes/exam.js` line 166-168)는 `status !== 'active'`이면 403을 반환한다. 하지만 만약 `examData.pdf_url`이 직접 경로(`/uploads/exams/xxx.pdf`)로 노출될 경우, 서버 권한 체크를 우회하여 직접 접근이 가능하다.
  - `examData.pdf_url`은 API에서 내려오는데 (`routes/exam.js` line 211), `waiting` 상태의 시험에도 PDF URL이 응답에 포함될 수 있다.
- **학생 입장에서의 영향:** 시험 시작 전에 문제를 미리 볼 수 있어 시험의 공정성이 깨진다. 반대로 일부 학생은 미리 못 보고 일부는 보는 불평등이 생길 수도 있다.
- **제안 해결 방법:**
  - 클라이언트에서 `loadPDF()`를 `startExam()` 내부에서만 호출하도록 이동한다.
  - 서버 API(`GET /:classId/:examId`)의 응답에서도 `waiting` 상태일 때는 `pdf_url` 필드를 제거하거나 포함하지 않는다.

---

### [C-03] 강제 제출(`force:submit`) 시 학생에게 충분한 안내 없이 즉시 제출됨
- **파일:** `public/cbt/player.html` (line 268-273), `public/cbt/pdf-player.html` (line 614-619), `socket/index.js` (line 171-173)
- **문제 설명:**
  - 서버에서 `force:submit` 이벤트와 함께 `deadline: 3000` (3초)을 보내지만, 클라이언트는 이 `deadline` 값을 전혀 사용하지 않는다. 토스트 메시지를 표시한 직후 즉시 `submitExam(true)`를 호출한다.
  - 토스트 메시지는 2.5초 후 사라지는데, 제출이 이미 완료된 후이다.
  - 현재 답안을 작성 중이던 학생(예: 마지막 문항 선택 직전)은 반영할 기회가 없다.
- **학생 입장에서의 영향:** 긴장된 상태에서 갑자기 화면이 "제출 완료"로 바뀌면 매우 당황스럽다. 마지막 순간에 답안을 선택하려던 학생은 그 답이 반영되지 않는다.
- **제안 해결 방법:**
  - `deadline` 값을 활용해 카운트다운 모달을 표시하고, 카운트다운 종료 후 제출되도록 한다.
  ```js
  socket.on('force:submit', (data) => {
    const seconds = Math.floor((data.deadline || 3000) / 1000);
    // 카운트다운 모달 표시: "3초 후 자동 제출됩니다"
    showForceSubmitCountdown(seconds, data.reason);
  });
  ```

---

### [C-04] 브라우저 종료 후 재접속 시 시험 상태 복원 불완전
- **파일:** `public/cbt/player.html` (line 290-332), `public/cbt/pdf-player.html` (line 432-486)
- **문제 설명:**
  - 저장된 답안 복원(`restoreSavedAnswers()`)은 구현되어 있으나, 타이머는 시험 시작 시 항상 `exam.time_limit * 60`초로 초기화된다. 남은 시간을 서버에서 계산하여 내려주는 로직이 없다.
  - `exam.started_at` 필드가 API 응답에 포함된다면 경과 시간을 계산할 수 있지만, 클라이언트에서 이를 활용하지 않는다.
  - `player.html`에서 시험 상태가 `active`이면 즉시 `beginExam()`을 호출하는데, 이때 타이머가 다시 100%로 재시작된다.
- **학생 입장에서의 영향:** 인터넷이 잠깐 끊겼다가 다시 연결하거나, 실수로 탭을 닫았다가 다시 열면 타이머가 초기화되어 원래보다 시간이 더 많아진다. 공정하지 않다.
- **제안 해결 방법:**
  - 서버 API `GET /:classId/:examId` 응답에 `started_at` 타임스탬프를 포함시킨다.
  - 클라이언트에서 `const elapsed = (Date.now() - new Date(exam.started_at).getTime()) / 1000` 으로 경과 시간을 빼고 타이머를 시작한다.

---

### [C-05] `submit` API가 멱등하지 않아 이중 제출 위험 존재
- **파일:** `routes/exam.js` (line 279-352)
- **문제 설명:**
  - `/submit` 엔드포인트는 이미 제출된 상태인지 확인하지 않는다. `examDb.getStudentExam()`의 반환값이 있어도 `status === 'submitted'` 여부를 체크하지 않고 `examDb.submitExam()`을 재호출한다 (line 300-302).
  - 네트워크 오류로 클라이언트가 재시도하거나, 빠르게 두 번 클릭하면 (클라이언트 `isSubmitted` 플래그 우회 시) 중복 채점이 일어날 수 있다.
  - 클라이언트의 `isSubmitted` 플래그는 `submitExam()` 실패 시 `false`로 되돌아가므로, 네트워크 오류 후 재시도는 자연스럽게 발생한다.
- **학생 입장에서의 영향:** 점수가 덮어쓰여 낮은 점수(또는 높은 점수)로 바뀔 수 있다. 오답노트에 잘못된 데이터가 쌓일 수 있다.
- **제안 해결 방법:**
  ```js
  // routes/exam.js
  const existing = examDb.getStudentExam(exam.id, req.user.id);
  if (existing && existing.status === 'submitted') {
    return res.json({ success: true, message: '이미 제출되었습니다.', score: existing.score, alreadySubmitted: true });
  }
  ```

---

## 2. 주요 이슈 (Major)

### [M-01] 대기실 화면에서 시험 내용(문제, 사이드바)이 뒤에서 렌더링됨
- **파일:** `public/cbt/player.html` (line 311-318)
- **문제 설명:**
  - 대기실 상태일 때 `renderNav()`와 `showQuestion(0)`을 호출하여 사이드바와 문항을 미리 렌더링한다. 대기실 오버레이(`position:fixed`)가 위에 덮여 보이지는 않지만, 문항 번호 사이드바와 첫 번째 문제가 이미 DOM에 존재한다.
  - 개발자 도구를 열면 문항 내용을 확인할 수 있다.
- **학생 입장에서의 영향:** 기술에 능숙한 학생이 개발자 도구로 시험 시작 전에 문제를 미리 볼 수 있다.
- **제안 해결 방법:**
  - 대기 중에는 `renderNav()`와 `showQuestion()`을 호출하지 않는다. `beginExam()` 내에서만 렌더링하도록 이동한다.

---

### [M-02] 텍스트 시험 플레이어에서 자동저장 성공/실패 피드백 없음
- **파일:** `public/cbt/player.html` (line 444-451)
- **문제 설명:**
  - `doAutosave()`는 조용히 실행되며 성공해도 아무런 시각적 피드백이 없다. 실패해도 아무 메시지가 없다.
  - 반면 `pdf-player.html`의 `doAutosave()`는 성공 시 "임시저장 완료" 토스트를 표시한다 (line 707).
  - 대기실 안내 문구에는 "30초마다 자동 저장됩니다"라고 명시되어 있어 학생이 기대를 가지지만, 텍스트 시험에서는 이를 확인할 방법이 없다.
- **학생 입장에서의 영향:** "내 답안이 정말 저장되고 있는 걸까?" 하는 불안감이 생긴다. 인터넷이 불안정한 환경(학교 Wi-Fi)에서 특히 더 불안하다.
- **제안 해결 방법:**
  - `player.html`의 `doAutosave()`에도 성공 시 조용한 토스트 또는 헤더의 저장 버튼 아이콘 변경으로 피드백을 준다.
  - 실패 시에는 눈에 띄는 경고 메시지("저장 실패 - 네트워크를 확인하세요")를 표시한다.

---

### [M-03] 소켓 연결 해제 시 학생에게 아무런 안내 없음
- **파일:** `public/cbt/player.html` (line 284), `public/cbt/pdf-player.html` (line 631-634)
- **문제 설명:**
  - `socket.on('disconnect', ...)` 핸들러가 콘솔에만 경고를 출력하고 사용자에게는 아무 메시지를 표시하지 않는다.
  - Socket.IO는 자동 재연결을 시도하지만, 그 사이 시험 시작(`exam:started`) 이벤트를 놓치면 학생은 영원히 대기실에 머물 수 있다.
  - 재연결 성공 후 `exam:status`를 다시 요청하는 로직이 없다.
- **학생 입장에서의 영향:** 인터넷이 끊겼다가 재연결되었을 때, 선생님이 이미 시험을 시작했더라도 학생은 대기실 화면 그대로 멈춰 있게 된다. "왜 시작이 안 되지?"하며 손을 들어야 한다.
- **제안 해결 방법:**
  ```js
  socket.on('disconnect', () => {
    showToast('연결이 끊겼습니다. 재연결 중...');
  });
  socket.on('reconnect', () => {
    showToast('다시 연결되었습니다.');
    // 현재 시험 상태 재확인
    socket.emit('exam:join', { examId, classId: parseInt(classId) });
  });
  ```

---

### [M-04] 학생이 `monitor=true` URL 파라미터로 감독관 패널 접근 가능
- **파일:** `public/cbt/player.html` (line 206, 236-237)
- **문제 설명:**
  - URL에 `?monitor=true`를 추가하면 학생도 감독관 패널(`monitorPanel`)이 표시된다.
  - 현재 감독관 패널은 소켓 이벤트(`student:tab-leave`, `student:tab-return`, `student:joined`)를 수신할 때 업데이트되므로, 학생이 패널을 열어두면 다른 학생들의 이탈 현황을 실시간으로 볼 수 있다.
  - 실질적인 피해는 제한적이나, UI 기능에 권한 체크가 없다는 것 자체가 문제이다.
- **학생 입장에서의 영향 (악용 시나리오):** 기술에 능숙한 학생이 다른 학생의 이탈 횟수를 보고 "(얼마나 많이 나갔는데 나만 안 나갔네)" 같은 불필요한 비교를 할 수 있다.
- **제안 해결 방법:**
  - `isTeacher` 판단 로직에서 URL 파라미터는 제거하고 서버에서 내려오는 `currentUser.role`만 사용한다.
  ```js
  // 수정 전
  const isTeacher = params.get('monitor') === 'true';
  if (isTeacher || currentUser.role === 'teacher' || currentUser.role === 'admin') { ... }
  // 수정 후
  if (currentUser.role === 'teacher' || currentUser.role === 'admin') { ... }
  ```

---

### [M-05] PDF 플레이어에서 시험 상태가 `waiting`이지만 대기실이 항상 표시됨 (상태 불일치)
- **파일:** `public/cbt/pdf-player.html` (line 418, 470-474)
- **문제 설명:**
  - `isWaiting = true`로 초기화되어 대기실이 무조건 표시된다.
  - `loadExamInfo()` 내에서 `examData.status === 'active'`이면 `startExam()`을 호출하지만, `status === 'waiting'`이 아닌 다른 상태(예: `completed`, `draft`)에서 접속하면 영원히 대기실 화면만 보인다.
  - 이미 제출한 학생(`studentExam.status === 'submitted'`)에 대한 처리가 PDF 플레이어에는 없다. (텍스트 플레이어 `player.html`의 line 304-308에는 있음)
- **학생 입장에서의 영향:** 이미 제출한 시험에 다시 들어가면 대기실 화면만 보이고 "제출 완료" 화면으로 이동하지 않는다. 자신의 점수를 확인하지 못한다.
- **제안 해결 방법:**
  ```js
  // loadExamInfo() 내부
  if (data.studentExam && data.studentExam.status === 'submitted') {
    showSubmitScreen(data.studentExam.score);
    return;
  }
  if (examData.status === 'waiting') {
    // 대기실 유지
  } else if (examData.status === 'active') {
    startExam();
  } else {
    // completed, draft 등 — 적절한 안내 메시지
    showToast('현재 응시할 수 없는 평가입니다.');
  }
  ```

---

### [M-06] 자동저장 API 응답 데이터 구조 불일치
- **파일:** `public/cbt/pdf-player.html` (line 454-461), `routes/exam.js` (line 446-451)
- **문제 설명:**
  - 서버 `GET /autosave` 응답 구조: `{ success: true, data: { answers: [...] } }`
  - `pdf-player.html`이 기대하는 구조: `savedData.answers` (line 456) — `data` 래퍼를 건너뛰고 있다.
  - `player.html`은 올바르게 `savedData.data.answers`를 사용한다 (line 339).
  - 따라서 PDF 플레이어에서는 자동저장 복원이 **항상 실패**한다.
- **학생 입장에서의 영향:** PDF 시험 도중 브라우저가 닫히거나 새로고침하면 저장해 둔 모든 답안이 사라진다.
- **제안 해결 방법:**
  ```js
  // pdf-player.html 수정
  const savedData = await savedRes.json();
  if (savedData.success && savedData.data) {        // data 래퍼 추가
    const saved = typeof savedData.data.answers === 'string'
      ? JSON.parse(savedData.data.answers)
      : (savedData.data.answers || []);
    saved.forEach((a, i) => { if (i < answers.length) answers[i] = a; });
    renderOMR();
  }
  ```

---

### [M-07] 시험 목록에서 `waiting` 상태인 시험에 "응시" 버튼이 없음
- **파일:** `public/cbt/index.html` (line 265)
- **문제 설명:**
  - `canTake` 조건: `exam.status === 'active' && !isOwner` — `waiting` 상태는 포함되지 않는다.
  - 대기실 기능이 있는 시스템임에도 불구하고, 학생이 대기실에 입장하려면 URL을 직접 입력하거나 링크를 받아야 한다.
- **학생 입장에서의 영향:** 선생님이 시험 대기실을 열었는데 학생들이 입장 버튼을 찾지 못한다. "응시 버튼이 어디 있어요?" 질문이 쏟아질 것이다.
- **제안 해결 방법:**
  ```js
  const canTake = (exam.status === 'active' || exam.status === 'waiting') && !isOwner;
  ```
  대기실 입장은 버튼 라벨을 "대기실 입장"으로 바꿔주면 더 명확하다.

---

## 3. 개선 제안 (Enhancement)

### [E-01] 대기실에서 현재 접속 학생 수 표시
- **파일:** `public/cbt/player.html`, `public/cbt/pdf-player.html` (대기실 섹션)
- **현재 상황:** 대기실에는 스피너와 "시험 시작 대기 중..." 메시지만 있다.
- **제안:** 소켓 서버에서 `student:joined` 이벤트를 받을 때 학생 수를 카운트하여 "현재 n명 입장 완료"처럼 표시하면 학생들의 불안감을 줄일 수 있다. 혼자서 대기 중인 건지, 다 모인 건지 알 수 없는 상황이 불안하다.

---

### [E-02] 남은 시간 경고 사운드 또는 더 강한 시각 효과 추가
- **파일:** `public/cbt/player.html` (line 439-441), `public/cbt/pdf-player.html` (line 653-658)
- **현재 상황:** 5분(300초) 이하에서는 주황색, 1분(60초) 이하에서는 빨간색으로 타이머 색이 바뀐다.
- **제안:**
  - 5분, 1분 남았을 때 별도의 토스트 알림("⏰ 5분 남았습니다!", "⚠️ 1분 남았습니다!")을 표시한다.
  - 1분 이하에서는 타이머가 깜빡이는 애니메이션을 추가한다 (`animation: blink 1s step-end infinite`).
  - 시험에 집중하다 보면 화면 상단 타이머를 자주 보지 못하는 학생들이 많다.

---

### [E-03] 제출 확인 다이얼로그를 커스텀 모달로 교체
- **파일:** `public/cbt/player.html` (line 458-461), `public/cbt/pdf-player.html` (line 711-716)
- **현재 상황:** 브라우저 기본 `confirm()` 다이얼로그를 사용한다. 디자인이 전혀 없으며 플랫폼마다 모양이 다르다.
- **제안:**
  - 커스텀 모달을 만들어 미응답 문항 번호를 명확히 표시한다. 예시:
    ```
    ┌─────────────────────────────────┐
    │  제출하기 전에 확인하세요        │
    │                                 │
    │  미응답 문항: 3번, 7번, 10번     │
    │  응답 완료: 7 / 10 문항          │
    │                                 │
    │  [취소]          [최종 제출하기] │
    └─────────────────────────────────┘
    ```
  - 학생이 어떤 문항을 안 풀었는지 한눈에 확인하고 다시 돌아갈 수 있게 한다.

---

### [E-04] "나가기" 버튼에 확인 다이얼로그 추가
- **파일:** `public/cbt/player.html` (line 126, 570-573), `public/cbt/pdf-player.html` (line 266, 746)
- **현재 상황:** 헤더의 "나가기" 버튼을 클릭하면 즉시 시험 목록 페이지로 이동한다. 확인 없이 바로 나가진다.
- **제안:**
  - 시험이 진행 중(`!isSubmitted && !isWaiting`)일 때는 "정말 나가시겠습니까? 제출하지 않으면 점수가 저장되지 않습니다."라는 확인 다이얼로그를 표시한다.
  - 브라우저의 `beforeunload` 이벤트도 설정하여 탭 닫기/URL 변경 시에도 경고를 준다.
  ```js
  window.addEventListener('beforeunload', (e) => {
    if (!isSubmitted && !isWaiting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  ```

---

### [E-05] PDF 플레이어에서 OMR과 현재 PDF 페이지 연동
- **파일:** `public/cbt/pdf-player.html`
- **현재 상황:** PDF 페이지 전환과 OMR 문항이 독립적으로 동작한다. 3번 문항을 클릭해도 PDF가 해당 페이지로 이동하지 않는다.
- **제안:**
  - 시험지에 문항별 페이지 정보가 있다면 OMR 문항 클릭 시 해당 PDF 페이지로 자동 이동하거나, PDF 페이지 변경 시 해당 범위의 OMR 행이 스크롤되어 보이도록 연동한다.

---

### [E-06] OMR 버튼 크기 태블릿 최적화
- **파일:** `public/cbt/pdf-player.html` (line 162-174)
- **현재 상황:** OMR 버튼 크기가 `36px × 36px`이다.
- **제안:**
  - 초등학생의 경우 손가락으로 터치하기 어려울 수 있다. Apple Human Interface Guidelines의 최소 터치 타겟은 44×44pt이다.
  - 미디어 쿼리로 태블릿/모바일 환경에서 버튼 크기를 44px 이상으로 조정한다.

---

### [E-07] 텍스트 시험에서 문항 이미지/수식 지원 없음
- **파일:** `public/cbt/player.html` (line 371)
- **현재 상황:** 문항 텍스트를 `escHtml(q.text)`로 이스케이프하여 표시하므로, HTML 태그나 이미지가 모두 문자 그대로 표시된다.
- **제안:**
  - 수학 문제나 그림이 포함된 문항을 위해 마크다운 또는 제한된 HTML 렌더링을 지원한다 (sanitize 적용 필수).

---

## 4. UX 피드백

### [U-01] 대기실 안내 문구와 실제 동작이 다름
- **파일:** `public/cbt/player.html` (line 178), `public/cbt/pdf-player.html` (line 358)
- **문제:** 대기실에 "답안은 30초마다 자동 저장됩니다"라고 나와 있지만, 자동저장 타이머(`autosaveTimer`)는 `beginExam()` / `startExam()`에서만 시작된다. 즉, 대기 중에는 자동저장이 실행되지 않는다. 안내 문구 자체가 허위 정보다.
- **영향:** 학생이 대기 중 답안을 미리 봐두고 싶어 어딘가에 적어두는 행동을 유발하거나, 자동저장을 믿고 있다가 나중에 데이터가 날아가는 상황이 발생할 수 있다.
- **수정 방법:** 안내 문구를 "시험 시작 후 30초마다 자동 저장됩니다"로 수정한다.

---

### [U-02] 타이머 초기 표시 `--:--`가 혼란스러움
- **파일:** `public/cbt/player.html` (line 130), `public/cbt/pdf-player.html` (line 271)
- **문제:** 대기실에서도 헤더의 타이머가 보이는데, `--:--`로 표시된다. 학생 입장에서 "타이머가 고장났나?"라고 오해할 수 있다.
- **수정 방법:** 대기 중에는 타이머 영역을 숨기거나 "대기 중"이라는 텍스트로 대체한다.

---

### [U-03] 제출 완료 화면에서 정답 확인 기능 없음
- **파일:** `public/cbt/player.html` (line 484-494), `public/cbt/pdf-player.html` (line 730-736)
- **문제:** 제출 후 점수만 표시되고 어떤 문제를 맞았고 틀렸는지 알 수 없다.
- **영향:** 학생들이 자신의 실수를 바로 확인하고 싶어 한다. 특히 교사가 "정답 공개" 설정을 한 경우에도 결과 확인 방법이 없다.
- **수정 방법:** 제출 후 화면에 "내 답안 확인" 버튼을 추가하여 `GET /api/exam/:classId/:examId` API(제출 완료 시 정답 공개됨)를 활용한 결과 리뷰 화면으로 연결한다.

---

### [U-04] 탭 이탈 경고 메시지가 너무 무섭게 표현됨
- **파일:** `public/cbt/player.html` (line 121), `public/cbt/pdf-player.html` (line 258)
- **문제:** 경고 메시지가 "화면 이탈이 감지되었습니다! 시험 중 다른 탭 또는 창으로 이동하면 기록됩니다."
- **영향:** 초등학생에게 이 빨간 경고 바가 매우 위협적으로 느껴질 수 있다. 실수로 한 번 이탈했을 뿐인데 마치 큰 잘못을 한 것 같은 죄책감과 불안을 유발한다.
- **수정 방법:** "화면을 벗어났습니다. (1회) 시험 집중을 위해 다른 창으로 이동하지 마세요." 처럼 횟수와 함께 부드러운 어조로 변경한다. 심각한 위반이 아니라 알림의 성격으로 표현하는 것이 좋다.

---

### [U-05] 시험 목록에서 `waiting` 상태 배지가 없음
- **파일:** `public/cbt/index.html` (line 258-260)
- **문제:** 시험 상태 배지가 `active`(진행 중), `completed`(완료), `draft`(임시저장)만 있고 `waiting`(대기 중)이 없다. `waiting` 상태인 시험은 "임시저장" 배지로 표시된다.
- **영향:** 학생들이 지금 대기실에 들어가야 할 시험을 "임시저장(아직 준비 안 됨)" 상태로 오해한다.
- **수정 방법:**
  ```js
  const statusTag = exam.status === 'active' ? '<span class="meta-tag tag-active">진행 중</span>' :
                    exam.status === 'waiting' ? '<span class="meta-tag tag-waiting">대기 중</span>' :
                    exam.status === 'completed' ? '<span class="meta-tag tag-completed">완료</span>' :
                    '<span class="meta-tag tag-draft">준비 중</span>';
  ```

---

### [U-06] PDF 시험 모바일 화면에서 OMR과 PDF가 각각 50vh로 너무 좁음
- **파일:** `public/cbt/pdf-player.html` (line 247-251)
- **문제:** 모바일/태블릿에서 `flex-direction: column`으로 전환되며 PDF와 OMR이 각각 `height: 50vh`를 차지한다. A4 PDF는 세로 길이가 길어 50vh 안에서 극도로 축소되고, OMR도 스크롤이 잘 안 된다.
- **수정 방법:**
  - PDF 영역에 최소 높이를 보장하거나, 모바일에서는 "PDF 전체 보기" / "OMR 입력" 탭 전환 방식을 고려한다.

---

## 5. 접근성/사용성 평가

### [A-01] 키보드 접근성 - OMR 버튼 키보드 탐색 어려움
- **파일:** `public/cbt/pdf-player.html` (line 551-557)
- **문제:** OMR 버튼들이 `<button>` 태그로 구현되어 Tab 키 탐색은 가능하나, 문항이 많을 경우(20문항 × 5보기 = 100번 Tab) 실질적으로 불가능하다.
- **제안:** 방향키로 OMR 내 이동이 가능하도록 `keydown` 이벤트를 추가한다 (`ArrowRight`/`ArrowLeft`로 보기 선택, `ArrowDown`/`ArrowUp`으로 문항 이동).

### [A-02] 선택형 문항의 선택 상태가 색상만으로 구분됨
- **파일:** `public/cbt/player.html` (line 63-68), `public/cbt/pdf-player.html` (line 162-174)
- **문제:** 선택된 답안이 파란색 배경으로 표시되는데, 색맹/색약 학생에게는 구분이 어려울 수 있다.
- **제안:** 선택 상태에 체크 아이콘(`✓`)을 추가하여 색상 외의 시각적 구분자를 제공한다.

### [A-03] 글자 크기 조절 기능 없음
- **파일:** `public/cbt/player.html` (line 61, 68)
- **문제:** 문항 텍스트 크기가 `17px`로 고정되어 있다. 시력이 약한 학생이나 작은 화면에서는 텍스트가 불편할 수 있다.
- **제안:** 글자 크기 조절 버튼(A- / A+)을 헤더에 추가한다.

### [A-04] 화면 낭독기(Screen Reader) 지원 미흡
- **문제:** `role`, `aria-label`, `aria-selected` 등 ARIA 속성이 전혀 사용되지 않는다. 시험 문항 영역, OMR 버튼, 타이머에 ARIA 레이블이 없다.
- **제안:**
  - 타이머: `aria-live="polite"` `aria-label="남은 시간"`
  - OMR 버튼: `aria-pressed="true/false"` `aria-label="1번 선택"`
  - 문항 영역: `role="main"` `aria-label="문항 내용"`

### [A-05] 에러 상태에서 구체적인 행동 지침 없음
- **파일:** `public/cbt/player.html` (line 295, 331), `public/cbt/pdf-player.html` (line 504-507)
- **문제:** 평가를 불러올 수 없을 때 "오류가 발생했습니다." 토스트만 표시된다. 학생이 어떻게 해야 하는지 알 수 없다.
- **제안:** "오류가 발생했습니다. 페이지를 새로고침하거나 선생님께 알려주세요." 처럼 구체적인 다음 행동을 안내한다.

---

## 6. 종합 평가

### 전체 점수: 6.5 / 10

| 항목 | 점수 | 비고 |
|------|------|------|
| 기능 완성도 | 6 / 10 | 핵심 흐름은 동작하나 중요 버그 다수 |
| UX 설계 | 7 / 10 | 전반적으로 깔끔하나 불안감 유발 요소 있음 |
| 안정성 | 5 / 10 | 네트워크 단절, 재접속 처리 미흡 |
| 보안 | 6 / 10 | PDF 사전 열람, 감독패널 접근 등 |
| 접근성 | 4 / 10 | ARIA 미지원, 키보드 접근성 부족 |

### 학생으로서 가장 걱정되는 점

1. **타이머 초기화 문제 (C-04)**: 시험 도중 인터넷이 끊겼다 재연결되면 시간이 리셋된다. 이건 공정성 문제라 친구들이 모르면 억울하다.

2. **자동저장 복원 불가 (M-06)**: PDF 시험에서 저장했다고 믿었는데 재접속하면 다 날아간다. 이건 시험을 다시 처음부터 해야 한다는 뜻이라 너무 억울하다.

3. **강제 제출 시 준비 시간 없음 (C-03)**: 선생님이 갑자기 시험을 끝내면 지금 쓰던 답이 날아간다. 마지막 문제 선택하려는 순간에 당하면 너무 슬프다.

4. **대기실 입장 버튼 없음 (M-07)**: 선생님이 "대기실 열었어요"라고 해도 버튼이 없어서 어떻게 들어가는지 모르겠다.

### 긍정적인 부분

- 문항 번호 사이드바로 어느 문제까지 풀었는지 한눈에 보기 좋다.
- 답안 선택 시 즉시 강조 표시가 되어 내가 뭘 골랐는지 명확하다.
- 대기실 안내 카드에 시험 규칙이 잘 정리되어 있다.
- PDF + OMR 분리 화면 구성은 실제 시험지와 비슷해서 익숙하고 좋다.
- 미응답 문항이 있을 때 제출 전 경고를 주는 것은 매우 유용하다.

### 우선 수정 권고 순서

1. **즉시 (출시 전 필수):** C-05 (이중 제출), M-06 (자동저장 복원), M-07 (대기실 입장 버튼)
2. **1차 패치:** C-01 (대기실 이탈 기록), C-03 (강제 제출 카운트다운), C-04 (타이머 복원), M-03 (소켓 재연결)
3. **2차 패치:** C-02 (PDF 사전 열람), M-04 (감독패널 접근), M-05 (PDF 상태 처리), E-04 (나가기 확인)
4. **개선 사항:** 나머지 E, U, A 항목들

---

*이 보고서는 초등학생 학습자의 시험 응시 경험을 기준으로 코드 정적 분석을 통해 작성되었습니다.*
*실제 사용자 테스트 및 다양한 기기(태블릿, 모바일)에서의 검증이 추가로 필요합니다.*
