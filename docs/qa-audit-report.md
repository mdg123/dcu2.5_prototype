# 전문 검수 감리 보고서

**프로젝트**: 다채움 K-12 교육 플랫폼 — 채움CBT 실시간 감독 통합  
**감리일**: 2026-04-16  
**감리원**: QA Inspector Agent (Claude Sonnet 4.6)  
**감리 대상 버전**: Phase 1 구현 완료 시점 (git 브랜치: claude/distracted-blackwell)  
**감리 범위**: 보안, 코드 품질, 성능, 아키텍처, PM 계획 준수, 크로스파일 통합

---

## 감리 개요

### 감리 대상 파일 목록

| 파일 | 역할 |
|---|---|
| `server.js` | Express + Socket.IO 메인 서버 |
| `socket/index.js` | Socket.IO 이벤트 핸들러 (408줄) |
| `routes/exam.js` | CBT REST API 라우트 (484줄) |
| `db/schema.js` | SQLite 스키마 + 마이그레이션 (~1,300줄) |
| `db/exam.js` | 시험 DB 연산 모듈 (137줄) |
| `db/cbt-extended.js` | CBT 확장 DB 연산 (111줄) |
| `middleware/auth.js` | 인증 미들웨어 |
| `middleware/errors.js` | 전역 에러 핸들러 |
| `public/cbt/index.html` | CBT 목록 페이지 |
| `public/cbt/player.html` | 텍스트 CBT 응시 플레이어 (579줄) |
| `public/cbt/pdf-player.html` | PDF CBT 응시 뷰어 (750줄) |
| `public/cbt/supervisor.html` | 감독관 실시간 대시보드 (700줄) |
| `public/cbt/result.html` | 상세 결과 분석 페이지 |
| `docs/pm-development-plan.md` | PM 개발 계획서 |

### 총평 요약

| 영역 | 등급 | 비고 |
|---|---|---|
| 보안 | 🟡 Major | 주요 취약점 3건 (Critical 1, Major 2) |
| 코드 품질 | 🟡 Major | 중복 CSS 과다, 에러 처리 미흡, 메모리 누수 가능성 |
| 성능 | 🟡 Major | N+1 쿼리, 소켓 throttle 일부 미적용 |
| 아키텍처 | 🟢 Minor | 설계 의도와 구현 일치. 일부 상태 동기화 리스크 |
| PM 계획 준수 | 🟢 Pass | Phase 1 P0 항목 모두 구현. 일부 세부 사양 미비 |
| 크로스파일 통합 | 🟢 Pass | 연동 정상. 일부 경로 해석 버그 존재 |

---

## 1. 보안 감리 결과

### 1.1 Socket.IO 인증 및 권한 제어

#### 🔴 Critical — `socket/index.js` L74: `supervisor:join` 권한 검증 로직에 단일 실패점

**파일**: `socket/index.js`, 라인 74–131

**문제**:
```javascript
socket.on('supervisor:join', ({ examId, classId }) => {
  if (!examId) return;
  // 교사 권한 확인
  let authorized = false;
  try {
    const exam = examDb.getExamById(eid);
    if (exam && exam.owner_id === userId) authorized = true;
    // admin 역할도 허용
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (user && user.role === 'admin') authorized = true;
    // 클래스 owner도 허용
    if (classId) {
      const role = classDb.getMemberRole(parseInt(classId), userId);
      if (role === 'owner') authorized = true;
    }
  } catch (e) {}  // ← 예외 발생 시 authorized = false이므로 안전하긴 하나

  if (!authorized) { ... return; }
  socket.join(`exam:${examId}:supervisor`);
  ...
```

**심각도**: `exam.owner_id`와 `classId`의 클래스 owner가 **서로 다른 시험**에도 감독관 방에 입장할 수 있다. `classId`로 전달된 클래스의 owner이기만 하면 해당 클래스에 속하지 않은 시험의 감독관 방에도 참여 가능하다. 즉, 교사 A가 자신의 클래스에서 owner인 상태로 다른 교사 B의 시험 `examId`를 알면 감독관 방에 접근할 수 있다.

**재현 시나리오**:
1. 교사 A가 클래스 1의 owner
2. 교사 B가 클래스 2에서 시험(examId=XYZ) 생성
3. 교사 A가 `supervisor:join({ examId: 'XYZ', classId: 1 })`을 소켓으로 전송
4. `classId=1`에서 teacher A가 owner → `authorized = true` → 교사 B의 시험 감독관 방 입장 성공

**수정 제안**:
```javascript
// 수정안: classId를 시험의 class_id와 교차 검증
if (classId) {
  const role = classDb.getMemberRole(parseInt(classId), userId);
  if (role === 'owner' && exam && exam.class_id === parseInt(classId)) {
    authorized = true;  // 반드시 해당 시험의 클래스 owner여야 함
  }
}
```

---

#### 🟡 Major — `socket/index.js` L134: `exam:start`, `exam:end` 이벤트에 `isSupervisor` 플래그 미검증

**파일**: `socket/index.js`, 라인 134–211

**문제**:
```javascript
socket.on('exam:start', ({ examId }) => {
  // 교사 권한 확인 — DB 조회로 재검증
  try {
    const exam = examDb.getExamById(eid);
    if (!exam) return;
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    const isAdmin = user && user.role === 'admin';
    if (exam.owner_id !== userId && !isAdmin) return;  // ← 이 경우 클래스 owner 조회 없음
```

`exam:start/exam:end`는 `exam.owner_id === userId || isAdmin`만 체크하여 클래스 owner는 시험 시작/종료가 불가능하다. 그러나 `supervisor:join`에서는 클래스 owner도 허용한다. 두 이벤트 간 권한 정책이 일치하지 않는다. 감독관 대시보드에서 클래스 owner로 접속하면 `시험 시작` 버튼이 보이지만 실제로는 동작하지 않는다.

**수정 제안**: `exam:start/exam:end`의 권한 체크를 `supervisor:join`과 일치시키거나, 별도 함수로 추출하여 단일 책임 원칙 준수.

---

#### 🟡 Major — `routes/exam.js` L153: PDF 스트리밍 시 경로 탐색(Path Traversal) 부분 방어

**파일**: `routes/exam.js`, 라인 171–189

**문제**:
```javascript
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

if (!fs.existsSync(pdfPath)) { ... }
fs.createReadStream(pdfPath).pipe(res);
```

`exam.pdf_file`은 DB에 저장된 값이며, 일반 사용자가 직접 조작하기 어렵다. 그러나 만약 DB에 `../../etc/passwd` 같은 경로가 저장된다면 Path Traversal이 가능하다. `pdfUpload`에서 저장 시 UUID 기반 파일명을 사용하므로 업로드 시점은 안전하지만, `PUT /api/exam/:classId/:examId`를 통한 `pdf_file` 필드 업데이트 경로가 차단되어 있는지 확인이 필요하다.

**확인 사항** (`db/exam.js` L52–53):
```javascript
if (['title', 'description', 'pdf_file', 'question_count', ...].includes(key)) {
  fields.push(`${key} = ?`);
```

`updateExam`에서 `pdf_file`이 화이트리스트에 포함되어 있고, `PUT` 엔드포인트는 owner만 접근 가능하므로 실질 위험은 낮다. 그러나 **방어적 프로그래밍** 관점에서 경로 정규화 및 `uploadDir` 내부인지 검증을 추가해야 한다.

**수정 제안**:
```javascript
// PDF 경로 최종 검증: 지정된 업로드 디렉토리 내부여야 함
const resolvedPath = path.resolve(pdfPath);
const allowedBase = path.resolve(path.join(__dirname, '..', 'uploads'));
if (!resolvedPath.startsWith(allowedBase)) {
  return res.status(403).json({ success: false, message: '허용되지 않는 경로입니다.' });
}
```

---

#### 🟢 Minor — `server.js` L49: 하드코딩된 세션 시크릿

**파일**: `server.js`, 라인 49

```javascript
secret: process.env.SESSION_SECRET || 'dacheum-secret-2026',
```

프로덕션 환경에서 환경변수 미설정 시 약한 기본값 사용. `.env` 파일 또는 배포 환경에서 반드시 강한 랜덤 값으로 설정 필요.

---

#### 🟢 Minor — `routes/exam.js`: 답안 제출 시 이미 제출된 시험 재제출 가능

**파일**: `routes/exam.js`, 라인 279–352

`submitExam` 엔드포인트는 이미 `status='submitted'`인 경우에도 답안을 덮어씌울 수 있다. `examDb.submitExam`은 단순 UPDATE 쿼리로 submitted 상태와 무관하게 답안을 갱신한다. 시험 종료 후 API 직접 호출로 점수 조작 가능성 존재.

**수정 제안**: 제출 전 `existing.status === 'submitted'` 여부 검사 후 이미 제출된 경우 409 반환.

---

### 1.2 SQL 인젝션 위험성

`better-sqlite3`의 Prepared Statement를 일관되게 사용하고 있어 SQL 인젝션 위험 없음. 단, `db/exam.js` L52–67의 `updateExam` 화이트리스트 방식도 안전하게 구현됨. ✅

---

### 1.3 파일 업로드 보안

**`routes/exam.js` L22–29:**
```javascript
const pdfUpload = multer({
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('PDF 파일만 업로드 가능합니다.'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});
```

- MIME 타입 검증 ✅
- 파일 크기 10MB 제한 ✅
- UUID 기반 파일명으로 경로 예측 불가 ✅
- 파일 확장자 검증 없음 🟢 Minor — MIME 스푸핑 가능하나 서버측에서 PDF 스트리밍으로만 사용하므로 실질 위험 낮음

---

## 2. 코드 품질 감리 결과

### 2.1 코드 중복 (CSS/UI)

#### 🟡 Major — CSS 변수 및 공통 스타일 4개 파일에 중복 정의

**해당 파일**: `player.html`, `pdf-player.html`, `supervisor.html`, `result.html`

4개 파일 모두 동일한 CSS 변수 블록을 인라인으로 반복 정의한다:

```css
/* player.html, pdf-player.html, supervisor.html, result.html — 동일한 블록 */
:root {
  --primary: #2563eb; --primary-dark: #1d4ed8; --primary-light: #eff6ff;
  --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
  --gray-50 ~ gray-800 스케일 전체
}
```

또한 `.toast`, `.btn`, `.alert-bar`, 대기실 UI 스타일이 `player.html`과 `pdf-player.html` 사이에서 중복된다.

**영향**: 디자인 변경 시 4개 파일 모두 수정 필요. 일관성 유지 어려움.

**수정 제안**: `public/css/cbt-common.css` 파일로 공통 스타일 추출. `supervisor.html`과 `result.html`은 이미 `/css/common-nav.css`를 로드하므로 연장선에서 처리 가능.

---

#### 🟡 Major — 대기실 UI HTML 구조 `player.html`과 `pdf-player.html`에 중복

**player.html** 라인 159–184와 **pdf-player.html** 라인 344–373이 거의 동일한 대기실 HTML 구조를 포함한다. 내용 차이는 PDF 관련 안내 문구 1개뿐.

**수정 제안**: `waiting-room` 컴포넌트를 공통 템플릿 또는 JS 함수로 추출.

---

### 2.2 에러 처리 미흡

#### 🟡 Major — `socket/index.js` 전반: 예외를 빈 catch로 무음 처리

**파일**: `socket/index.js`

`exam:join` (L44), `tab:leave` (L266), `tab:return` (L287) 등 여러 곳에서 `catch (e) {}` — 빈 catch 블록으로 모든 예외가 삼켜진다. 운영 중 DB 오류나 예외가 발생해도 아무 로그가 남지 않아 디버깅이 불가능하다.

```javascript
// L44–45: 빈 catch
try {
  const user = db.prepare('...').get(userId);
  if (user) displayName = user.display_name || ...;
} catch (e) {}  // ← 로그 없음

// L238–244, L280–287, L344–346: 동일 패턴 반복
```

**수정 제안**: 최소한 `catch (e) { console.error('[Socket] 작업명 오류:', e.message); }` 수준의 로깅 추가.

---

#### 🟡 Major — `socket/index.js` L177–209: `exam:end` setTimeout 내부 에러가 외부에서 catch 불가

**파일**: `socket/index.js`, 라인 177–209

```javascript
setTimeout(() => {
  try {
    // 강제 채점 로직
    students.forEach(s => {
      if (s.status !== 'submitted') {
        examDb.submitExam(eid, s.user_id, studentAnswers, score);  // ← 다수 학생 동시 처리
      }
    });
    examDb.updateExam(eid, { status: 'completed' });
    io.to(...).emit('exam:ended', ...);
  } catch (e) { console.error('[Socket] exam:end finalize error:', e); }
}, 3000);
```

`students.forEach` 내부에서 한 학생의 `submitExam` 실패 시 전체 루프가 중단된다. 일부 학생만 채점되고 나머지는 누락될 수 있다.

**수정 제안**: 각 학생 처리를 개별 try-catch로 감싸거나 DB 트랜잭션으로 묶어 원자성 보장.

```javascript
const forceSubmitAll = db.transaction((studentsToSubmit) => {
  for (const s of studentsToSubmit) {
    try {
      examDb.submitExam(eid, s.user_id, studentAnswers, score);
    } catch (e) {
      console.error(`[Socket] 강제 채점 실패 userId=${s.user_id}:`, e.message);
    }
  }
});
```

---

#### 🟢 Minor — `routes/exam.js` L49: `importFromContent` 에러 로그 없음

```javascript
} catch (err) { res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' }); }
```

에러 객체를 콘솔에 출력하지 않아 서버 측 디버깅이 불가능하다. 여러 라우트 핸들러에서 동일 패턴 반복.

---

### 2.3 메모리 누수 가능성

#### 🟡 Major — `socket/index.js` L17–18: `throttle` 객체가 무한 증가

**파일**: `socket/index.js`, 라인 17–18

```javascript
const throttle = {};  // 전역 객체, 절대 정리되지 않음
...
// tab:leave 핸들러
const key = `${userId}_${examId}`;
throttle[key] = now;
```

소켓 연결이 disconnect되어도 `throttle` 객체의 키가 제거되지 않는다. 장기 운영 시 (다수의 학생 × 다수의 시험) key 개수가 누적되어 메모리를 소모한다.

**수정 제안**: `disconnect` 이벤트 핸들러에서 해당 userId 관련 throttle 키 정리:
```javascript
socket.on('disconnect', () => {
  // 해당 유저의 throttle 키 정리
  Object.keys(throttle).forEach(key => {
    if (key.startsWith(`${userId}_`)) delete throttle[key];
  });
  ...
});
```

또는 Map + 30초 TTL 방식으로 교체.

---

#### 🟡 Major — `socket/index.js` L6–14: `activeExams` Map이 정리되지 않음

**파일**: `socket/index.js`, 라인 6–14

```javascript
const activeExams = new Map();

function getRuntime(examId) {
  if (!activeExams.has(examId)) {
    activeExams.set(examId, { students: new Map() });
  }
  return activeExams.get(examId);
}
```

`exam:end`에서 시험이 완료되어도 `activeExams`에서 해당 examId 항목을 삭제하지 않는다. 시험이 많이 생성될수록 서버 메모리에 모든 시험 런타임 데이터가 잔류한다.

**수정 제안**: `exam:end` 처리 완료 후 `activeExams.delete(eid)` 호출.

---

### 2.4 데드 코드 및 미사용 요소

#### 🟢 Minor — `supervisor.html` `loadMockStudents()` 함수 — 테스트 목업 코드

**파일**: `public/cbt/supervisor.html`, 소켓 연결 실패 분기

```javascript
} catch (e) {
  console.warn('Socket.IO not available:', e);
  loadMockStudents();  // 프로덕션에서도 소켓 실패 시 목업 데이터 노출
}
```

프로덕션 배포 시 Socket.IO 연결 실패(예: 네트워크 오류)가 발생하면 가짜 학생 데이터가 감독관 화면에 표시될 수 있다.

**수정 제안**: `loadMockStudents` 함수 제거하거나 `if (process.env.NODE_ENV === 'development')` 조건 추가.

---

#### 🟢 Minor — `pdf-player.html` L400: 미사용 URL 파라미터 `pdfUrl`

```javascript
const pdfUrl = params.get('pdf'); // TODO: 서버에서 PDF URL 전달
```

실제로 URL 파라미터로 `pdf`를 전달하는 코드가 없음. 내부에서도 `examData.pdf_url`을 우선 사용하므로 `pdfUrl`은 dead code에 가깝다. TODO 주석이 남아있어 혼란을 줄 수 있다.

---

#### 🟢 Minor — `db/cbt-extended.js` L45–47: `exportToContent` 함수 구문 오류

**파일**: `db/cbt-extended.js`, 라인 45–47

```javascript
const info = db.prepare(`
  INSERT INTO contents (creator_id, title, description, content_type, is_public, status)
  VALUES (?, ?, ?, 'assessment', 0, 'approved')
`).run(userId, exam.title, `평가 문항 ${exam.question_count}개`, );
                                                                      // ↑ 인수 3개인데 ? 플레이스홀더 4개
```

SQL에 `?` 플레이스홀더가 4개이지만 `.run()`에 3개의 값만 전달된다. better-sqlite3는 인수 불일치 시 런타임 에러(`SQLITE_ERROR: expected N parameters`)를 발생시킨다. 이 기능 호출 시 서버가 크래시된다.

**수정 제안**: `.run(userId, exam.title, `평가 문항 ${exam.question_count}개`)` → 쉼표 제거 및 VALUES 개수 일치 확인.

---

## 3. 성능 감리 결과

### 3.1 N+1 쿼리

#### 🟡 Major — `routes/exam.js` L52–68: 시험 목록 API에서 N+1 쿼리

**파일**: `routes/exam.js`, 라인 52–68

```javascript
router.get('/:classId', requireAuth, requireClassMember, (req, res) => {
  const result = examDb.getExamsByClass(req.classId, ...);
  result.exams = result.exams.map(exam => {
    // 시험마다 2개의 추가 쿼리 실행 (N × 2 쿼리)
    const submission = db.prepare('SELECT score, submitted_at FROM exam_students WHERE exam_id = ? AND user_id = ?').get(exam.id, req.user.id);
    const pc = db.prepare('SELECT COUNT(*) as c FROM exam_students WHERE exam_id = ? AND submitted_at IS NOT NULL').get(exam.id);
    return { ...exam, my_score: ..., participant_count: ... };
  });
```

시험이 20개면 40번의 추가 쿼리가 발생한다. 학급에 시험이 많을수록 응답 시간이 선형으로 증가한다.

**수정 제안**: `getExamsByClass` 쿼리에 서브쿼리 또는 LEFT JOIN으로 통합:
```sql
SELECT e.*,
  (SELECT score FROM exam_students WHERE exam_id = e.id AND user_id = :userId) as my_score,
  (SELECT submitted_at FROM exam_students WHERE exam_id = e.id AND user_id = :userId) as my_submitted_at,
  (SELECT COUNT(*) FROM exam_students WHERE exam_id = e.id AND submitted_at IS NOT NULL) as participant_count
FROM exams e ...
```

---

#### 🟡 Major — `supervisor.html` L464–465: 감독관 초기화 시 동일 API 중복 호출

**파일**: `public/cbt/supervisor.html`, 라인 449–484

```javascript
const res = await fetch(`/api/exam/${classId}/${examId}`);
const data = await res.json();
// ...
// 기존 응시 학생 불러오기 — 동일 URL 재호출
const studRes = await fetch(`/api/exam/${classId}/${examId}`);
const studData = await studRes.json();
```

완전히 동일한 엔드포인트를 연속으로 두 번 호출한다. 첫 번째 응답의 `data.students`를 그대로 사용하면 되므로 두 번째 호출은 불필요하다.

**수정 제안**: `studData`를 `data`로 교체하고 두 번째 fetch 제거.

---

### 3.2 DB 인덱스

**`db/schema.js` 검토 결과**:

- `idx_exams_class (exams.class_id)` ✅
- `idx_exams_owner (exams.owner_id)` ✅
- `idx_es_exam_status (exam_students.exam_id, status)` ✅

#### 🟢 Minor — `exam_students(user_id)` 인덱스 없음

`getStudentExam`, `submitExam`, `recordTabLeave`, `updateLeaveTime` 함수 모두 `WHERE exam_id = ? AND user_id = ?` 쿼리를 사용하나 `user_id` 단독 인덱스가 없다. `exam_id` 인덱스(`idx_es_exam_status`)가 있어 다수 응시자 시 `exam_id` 스캔 후 `user_id` 필터링으로 처리되므로 응시자가 많아질수록 쿼리 비용이 증가한다. `UNIQUE(exam_id, user_id)` 복합 유니크 제약이 있어 암시적 인덱스는 있지만 명시적 단독 인덱스가 없다.

**수정 제안**: `CREATE INDEX IF NOT EXISTS idx_es_user ON exam_students(user_id)` 추가.

---

### 3.3 소켓 스로틀링

**`socket/index.js` L17–18:**

`tab:leave` 이벤트에만 1초 스로틀 적용 ✅

그러나 `answer:update` (L330–357)에는 스로틀이 없다. 학생이 빠르게 답안을 변경하면 매 클릭마다 소켓 이벤트가 발생하고, 감독관에게 학생 수 × 클릭 수 만큼의 이벤트가 전달된다.

#### 🟢 Minor — `answer:update` 이벤트 스로틀 없음

**수정 제안**: 클라이언트(player.html)에서 `answer:update` 디바운스(500ms) 적용.

---

### 3.4 PDF 스트리밍

**`routes/exam.js` L188:**

```javascript
fs.createReadStream(pdfPath).pipe(res);
```

`Content-Length` 헤더를 설정하지 않아 클라이언트가 전체 파일 크기를 미리 알 수 없다. 진행바 표시 불가. PDF.js는 Range Request를 지원하는데 현재 구현은 Range 헤더를 처리하지 않아 항상 전체 파일을 전송한다.

#### 🟢 Minor — PDF 스트리밍에 Range Request 미지원

대용량 PDF(>5MB)에서 학생이 첫 페이지를 보기 위해 전체 파일을 내려받아야 하므로 초기 로딩이 느리다.

**수정 제안**: `express.static` 미들웨어 또는 `serve-static` 라이브러리로 Range Request 지원 추가.

---

## 4. 아키텍처 감리 결과

### 4.1 관심사 분리 (Separation of Concerns)

**전반적으로 양호**. REST API (routes/exam.js)와 Socket.IO (socket/index.js)의 역할이 명확히 분리되어 있다.

- REST API: CRUD, 채점, LRS 기록 → DB 영속화
- Socket.IO: 실시간 알림, 상태 브로드캐스트 → 실시간 통신

PM 계획서에 명시된 "모든 상태 변경은 DB 기준, Socket은 알림 채널로만 사용" 원칙이 전반적으로 준수됨. ✅

---

### 4.2 상태 동기화 리스크

#### 🟡 Major — `supervisor.html`의 `startExam()`: REST API와 Socket 이벤트의 이중 호출

**파일**: `public/cbt/supervisor.html`, 라인 610–628

```javascript
async function startExam() {
  // 1. REST API로 DB 상태 변경
  const res = await fetch(`/api/exam/${classId}/${examId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'active' })
  });
  if (data.success) {
    setExamStatus('active');
    // 2. 동시에 Socket 이벤트로 학생에게 알림
    if (socket) socket.emit('exam:start', { examId });
  } else {
    setExamStatus('active');              // ← REST 실패해도 상태 변경
    if (socket) socket.emit('exam:start', ...);  // ← Socket 이벤트는 여전히 발송
  }
}
```

`catch` 분기에서 REST API 실패 시에도 강제로 `setExamStatus('active')`를 호출하고 `exam:start` 소켓 이벤트를 발송한다. 이때 DB에는 `waiting` 상태가 남아있고 Socket으로는 시험 시작 신호가 나간다. 학생 화면은 시험 시작 상태로 전환되지만 DB는 대기 상태. 이후 학생이 답안을 제출하면 서버에서 `status !== 'active'`로 인해 거부될 수도 있다.

또한, `socket/index.js`의 `exam:start` 핸들러도 내부적으로 `examDb.updateExam`을 호출하므로 REST + Socket 이중으로 DB를 업데이트한다. Race condition 가능성 있음.

**수정 제안**: DB 업데이트는 Socket 이벤트 핸들러(`socket/index.js`의 `exam:start`)에서만 하거나, 또는 REST API에서만 하고 Socket은 순수 알림으로 사용. 두 경로에서 동시 업데이트 방지.

---

### 4.3 하위 호환성

**기존 텍스트 기반 CBT 기능 영향 분석**:

- `player.html`: 신규 기능(대기실, 강제 제출) 추가 시 기존 `active` 상태 시험에도 대기실 로직이 적용되지 않도록 `status === 'waiting'` 조건으로 분기 처리됨 ✅
- `exam.js`의 기존 API: 신규 엔드포인트(`create-pdf`, `results-detail`)가 기존 라우트 패턴(`/:classId/:examId`) 뒤에 추가됨 — 라우트 파라미터 충돌 위험 있음

#### 🔴 Critical — `routes/exam.js` L196: 라우트 충돌 — `:examId` 파라미터가 `results-detail` 등 문자열과 혼동

**파일**: `routes/exam.js`, 라인 153, 196, 356

```
GET  /:classId/:examId/pdf          (라인 153)
GET  /:classId/:examId              (라인 196)
GET  /:classId/:examId/results-detail (라인 356)
```

현재 Express 라우트 등록 순서는:
1. L91: `POST /:classId/create-pdf` — `create-pdf`가 `:classId`에 매핑될 가능성
2. L153: `GET /:classId/:examId/pdf`
3. L196: `GET /:classId/:examId`
4. L356: `GET /:classId/:examId/results-detail`

L43의 `router.post('/import-from-content', ...)` — `import-from-content`이 `:classId`로 먼저 매핑되는 경우가 없는지 확인 필요. 이 라우트는 `router.post('/import-from-content', requireAuth, ...)` 형태로 `/:classId` 라우트보다 **먼저 등록**되어 있으므로 (`// must be before /:classId routes` 주석 있음) 안전하다 ✅.

그러나 `GET /:classId/create-pdf` 같은 잘못된 요청 시 `create-pdf`가 classId로 파싱되어 NaN 오류가 날 수 있다. `requireClassMember`에서 `parseInt(req.params.classId)`가 NaN이 되어 `isMember(NaN, userId)` 호출 → 결과에 따라 403 또는 의도치 않은 동작.

**재평가**: 즉각적인 취약점이라기보다는 관리성 문제. 라우트 정의 순서와 주석이 명확하게 관리되는지 지속 감시 필요. 등급을 🟡 Major로 하향 조정.

---

### 4.4 SQLite WAL 모드

**`db/index.js` 또는 초기화 코드 확인 필요** — PM 계획서에서 "WAL 모드 사용" 권고가 있으나 감리 대상 코드에서 명시적인 WAL 설정 확인 불가.

#### 🟡 Major — SQLite WAL 모드 설정 여부 미확인

다수 학생 동시 제출 시 SQLite 기본 Journal 모드에서 쓰기 잠금 경합이 발생할 수 있다.

**수정 제안**: `db/index.js`에서 `db.pragma('journal_mode = WAL')` 설정 확인 및 추가.

---

## 5. PM 계획 준수 여부

### 5.1 Phase 1 P0 태스크 이행 현황

| 태스크 | 내용 | 구현 여부 | 비고 |
|---|---|---|---|
| **P0-01** | CBT 감독관 대시보드 (supervisor.html) | ✅ 완료 | 실시간 응시자 목록, 포커스 지시등, 통계 카드, 시작/종료 버튼 모두 구현 |
| **P0-02** | CBT 대기실 기능 | ✅ 완료 | player.html, pdf-player.html 모두 대기실 UI 및 exam:started 수신 로직 구현 |
| **P0-03** | Socket.IO 이벤트 확장 | ✅ 완료 | exam:start, exam:end, force:submit, students:list, student:joined, student:tab-leave, student:tab-return, student:submitted, student:progress, student:disconnected 모두 구현 |
| **P0-04** | 강제 제출 기능 | ✅ 완료 | force:submit 이벤트 → 3초 후 미제출 학생 자동 채점 |
| **P0-05** | CBT 페이지 UI 디자인 | ✅ 완료 | supervisor.html, pdf-player.html, result.html 모두 PM 계획의 UI 요구사항(8.1절) 준수 |
| **P0-06** | 기존 CBT 플레이어 안정화 | ✅ 완료 | player.html에 대기실, 강제 제출, 이탈 경고바 추가. 교사 모니터 패널 소켓 이벤트 연동 |

### 5.2 Phase 1 완료 기준 달성도

| 완료 기준 | 달성 여부 | 비고 |
|---|---|---|
| 교사가 감독관 대시보드에서 시험을 시작/종료할 수 있다 | ✅ | supervisor.html 구현 |
| 학생이 대기실에서 시험 시작 신호를 받으면 자동으로 시험 화면으로 전환된다 | ✅ | exam:started 이벤트 수신 처리 |
| 교사가 학생의 실시간 포커스 상태를 확인할 수 있다 | ✅ | student:tab-leave/return 이벤트 + 포커스 지시등 |
| 교사가 시험 종료 시 미제출 학생의 답안이 자동 채점된다 | ✅ | exam:end + 3초 지연 강제 채점 |
| 모든 이벤트가 인증된 세션 기반으로 동작한다 | ✅ | io.use 미들웨어로 세션 공유 |

### 5.3 PM 계획 대비 미반영/변형 사항

#### 🟡 Major — `PM 계획 3.4절`: `answer:submit` 이벤트 미구현

계획서에 명시된 `answer:submit` 소켓 이벤트가 실제 구현에서는 보이지 않는다. 대신 REST API (`POST /submit`)를 사용하는 방식으로 구현됐다. PM 계획의 의도(Socket → REST 파이프라인)보다 더 단순하고 안정적인 방식으로 구현된 것으로, **이 방향이 오히려 더 바람직하다**. 계획서 업데이트 권장.

#### 🟢 Minor — `PM 계획 3.3절`: `DB 스키마 변경` 중 `source_content_id` 미반영 사항 있음

PM 계획서에는 `exams` 테이블에 `source_content_id` 컬럼 추가가 명시되어 있다. `db/schema.js` 마이그레이션에서 `source_content_id`가 추가됨 ✅. 단, `CREATE TABLE IF NOT EXISTS exams` 정의(라인 167–183)에는 `source_content_id` 컬럼이 없고, 마이그레이션(라인 1139–1140)으로만 추가된다. 신규 설치 시 마이그레이션이 정상 실행되므로 실질 문제는 없으나, schema.js의 초기 테이블 정의와 마이그레이션이 불일치하여 가독성이 저하된다.

---

## 6. 크로스파일 통합 검증

### 6.1 `server.js` ↔ `socket/index.js`

```javascript
// server.js 라인 67–69: 세션 공유
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// server.js 라인 104: socket 초기화
require('./socket')(io);
```

Socket.IO에 세션 미들웨어가 올바르게 공유됨 ✅. `socket/index.js`에서 `socket.request.session.userId`로 인증 사용자 식별 정상 ✅.

---

### 6.2 `socket/index.js` ↔ `routes/exam.js`: `notifySubmission` 연동

```javascript
// routes/exam.js 라인 339–346
try {
  initSocket.notifySubmission({
    examId: exam.id, userId: req.user.id, score, submittedAt: ...
  });
} catch (e) { console.error('[EXAM] socket notify error:', e); }

// socket/index.js 라인 388–405
initSocket.notifySubmission = function({ examId, userId, score, submittedAt }) {
  const io = initSocket._io;
  if (!io) return;  // ← io 미초기화 시 안전하게 종료
  ...
};
```

**연동 정상** ✅. `initSocket._io`가 `null`인 경우(서버 시작 직후 등) 안전하게 처리됨.

---

### 6.3 `db/exam.js` 함수 ↔ 사용처 검증

| 함수 | 사용처 | 검증 |
|---|---|---|
| `createExam` | routes/exam.js | ✅ |
| `getExamById` | routes/exam.js, socket/index.js | ✅ |
| `updateExam` | routes/exam.js, socket/index.js | ✅ |
| `submitExam` | routes/exam.js, socket/index.js | ✅ |
| `recordTabLeave` | socket/index.js | ✅ |
| `getExamStudents` | routes/exam.js, socket/index.js | ✅ |

---

### 6.4 프론트엔드 ↔ API URL 일치 검증

| 프론트엔드 호출 | 실제 API 경로 | 일치 여부 |
|---|---|---|
| `GET /api/exam/${classId}/${examId}` | `router.get('/:classId/:examId')` | ✅ |
| `POST /api/exam/${classId}/${examId}/submit` | `router.post('/:classId/:examId/submit')` | ✅ |
| `POST /api/exam/${classId}/${examId}/autosave` | `router.post('/:classId/:examId/autosave')` | ✅ |
| `GET /api/exam/${classId}/${examId}/autosave` | `router.get('/:classId/:examId/autosave')` | ✅ |
| `GET /api/exam/${classId}/${examId}/pdf` | `router.get('/:classId/:examId/pdf')` | ✅ |
| `PUT /api/exam/${classId}/${examId}` | `router.put('/:classId/:examId')` | ✅ |
| `GET /api/exam/${classId}/${examId}/results-detail` | `router.get('/:classId/:examId/results-detail')` | ✅ |

모든 API URL 매핑 정상 ✅.

---

### 6.5 `pdf-player.html`의 자동저장 응답 처리 버그

**파일**: `public/cbt/pdf-player.html`, 라인 453–460

```javascript
const savedRes = await fetch(`/api/exam/${classId}/${examId}/autosave`);
const savedData = await savedRes.json();
if (savedData.success && savedData.answers) {  // ← savedData.answers
```

그러나 실제 API 응답 구조는:
```javascript
// routes/exam.js → cbtExtDb.getAutoSavedAnswers 반환
res.json({ success: true, data });  // ← data.answers, not savedData.answers
```

`savedData.data.answers`를 참조해야 하는데 `savedData.answers`를 참조하여 저장된 답안이 절대 복원되지 않는다.

#### 🟡 Major — `pdf-player.html`: 자동저장 답안 복원 참조 경로 버그

**수정 제안**:
```javascript
if (savedData.success && savedData.data) {
  const saved = typeof savedData.data.answers === 'string'
    ? JSON.parse(savedData.data.answers) : (savedData.data.answers || []);
  saved.forEach((a, i) => { if (i < answers.length) answers[i] = a; });
  renderOMR();
}
```

참고로, `player.html`(라인 338–343)에서는 `savedData.data.answers`로 올바르게 참조하고 있어 두 파일 간 일관성이 없다.

---

### 6.6 `supervisor.html`의 시험 시작/종료 후 Socket 이벤트 경합

**파일**: `public/cbt/supervisor.html` L610–640

`startExam()`: PUT API → DB 업데이트 → `socket.emit('exam:start')` → `socket/index.js`에서 또 `examDb.updateExam` 호출.

`endExam()`: Socket만 사용 (`socket.emit('exam:end')`) — PUT API 미호출. DB 상태는 Socket 핸들러에서만 업데이트.

시작은 REST+Socket 이중, 종료는 Socket만 — 비일관적.

---

## 7. 종합 판정

### **Conditional Pass (조건부 통과)**

Phase 1의 핵심 기능(대기실, 실시간 감독, 강제 제출, PDF 뷰어)은 모두 구현되었으며 PM 계획의 완료 기준을 달성한다. 전반적인 코드 품질은 교육 플랫폼 프로토타입 수준으로 양호하다.

그러나 아래 **필수 수정 사항**을 프로덕션 배포 전에 반드시 수정해야 한다:

1. `supervisor:join` 권한 검증 로직 취약점 (다른 교사 시험 감독관 방 무단 접근)
2. `db/cbt-extended.js`의 `exportToContent` 구문 오류 (서버 크래시 유발)
3. `pdf-player.html` 자동저장 답안 복원 버그 (참조 경로 오류)
4. `exam:end` 강제 채점 시 개별 실패가 전체 루프 중단 가능

---

## 8. 필수 수정 사항 (Must Fix)

| No. | 위치 | 문제 | 등급 |
|---|---|---|---|
| M-01 | `socket/index.js` L87–90 | `supervisor:join` 권한 검증: 교차 시험/클래스 검증 누락 | 🔴 Critical |
| M-02 | `db/cbt-extended.js` L45–47 | `exportToContent` SQL 파라미터 불일치 — 런타임 크래시 | 🔴 Critical |
| M-03 | `public/cbt/pdf-player.html` L453–460 | 자동저장 답안 복원 참조 오류 (`savedData.answers` → `savedData.data.answers`) | 🟡 Major |
| M-04 | `socket/index.js` L183–198 | `exam:end` forEach 내 개별 submitExam 실패 시 전체 루프 중단 | 🟡 Major |
| M-05 | `routes/exam.js` L280–302 | 이미 제출된 시험 재제출 가능 — 점수 조작 경로 | 🟡 Major |
| M-06 | `routes/exam.js` L171–189 | PDF 경로 검증 미흡 — uploadDir 외부 접근 방어 필요 | 🟡 Major |

---

## 9. 권장 수정 사항 (Should Fix)

| No. | 위치 | 문제 | 등급 |
|---|---|---|---|
| S-01 | `socket/index.js` L17 | `throttle` 객체 무한 누적 — disconnect 시 정리 로직 추가 | 🟡 Major |
| S-02 | `socket/index.js` L6–14 | `activeExams` Map 미정리 — 시험 완료 시 삭제 | 🟡 Major |
| S-03 | `socket/index.js` 전반 | 빈 catch 블록 → 최소 `console.error` 로깅 추가 | 🟡 Major |
| S-04 | `socket/index.js` L134–155 | `exam:start/end` 권한 체크와 `supervisor:join` 권한 정책 일치시키기 | 🟡 Major |
| S-05 | `routes/exam.js` L52–68 | 시험 목록 N+1 쿼리 → 서브쿼리로 통합 | 🟡 Major |
| S-06 | `public/cbt/supervisor.html` L464–465 | 동일 API 중복 호출 제거 | 🟡 Major |
| S-07 | `public/cbt/supervisor.html` L610–640 | `startExam` REST 실패 시 Socket 이벤트 발송 방지 | 🟡 Major |
| S-08 | `db/index.js` | SQLite WAL 모드 설정 확인 및 추가 | 🟡 Major |
| S-09 | `public/cbt/supervisor.html` | `loadMockStudents()` 목업 코드 제거 | 🟡 Major |
| S-10 | `db/schema.js` L167–183 | `exams` 테이블 초기 정의에 마이그레이션 컬럼 반영 (schema-migration 불일치 해소) | 🟢 Minor |

---

## 10. 개선 권장 사항 (Nice to Have)

| No. | 위치 | 내용 | 등급 |
|---|---|---|---|
| N-01 | `public/css/cbt-common.css` (신규) | player.html, pdf-player.html, supervisor.html, result.html의 CSS 변수 및 공통 스타일 추출 | 🟢 Minor |
| N-02 | `public/cbt/pdf-player.html` L400 | 미사용 `pdfUrl` 파라미터 및 TODO 주석 정리 | 🟢 Minor |
| N-03 | `routes/exam.js` L188 | PDF 스트리밍에 `Content-Length` 헤더 및 Range Request 지원 추가 | 🟢 Minor |
| N-04 | `socket/index.js` L330–357 | `answer:update` 이벤트 서버측 또는 클라이언트측 디바운스 적용 (500ms) | 🟢 Minor |
| N-05 | `db/schema.js` L205 | `exam_students(user_id)` 단독 인덱스 추가 | 🟢 Minor |
| N-06 | `server.js` L49 | 프로덕션 배포 가이드에 `SESSION_SECRET` 환경변수 강제화 명시 | 🟢 Minor |
| N-07 | `public/cbt/` 전반 | 대기실 UI를 공통 JS 컴포넌트로 추출 (player.html, pdf-player.html 중복 제거) | 🟢 Minor |
| N-08 | `routes/exam.js` 전반 | catch 블록에 에러 로깅 추가 (`console.error(err)`) | 🟢 Minor |
| N-09 | `socket/index.js` L134 | `exam:start/exam:end`의 DB 업데이트와 supervisor.html의 REST PUT 역할 분리 명확화 (단일 책임) | 🟢 Minor |
| N-10 | `docs/pm-development-plan.md` | `answer:submit` 소켓 이벤트 → REST 방식으로 계획서 업데이트 | 🟢 Minor |

---

## 부록: 감리 기준 및 방법론

- **코드 정적 분석**: 직접 코드 리뷰 (라인별 검토)
- **보안 감리 기준**: OWASP Top 10 (A01 Broken Access Control, A03 Injection, A05 Security Misconfiguration)
- **성능 감리 기준**: N+1 쿼리 패턴, 메모리 누수, 이벤트 플러딩
- **아키텍처 감리 기준**: 관심사 분리, 단일 책임 원칙, 상태 일관성
- **PM 준수 감리**: `docs/pm-development-plan.md` Phase 1 완료 기준 대조

---

*감리 종료일: 2026-04-16*  
*다음 감리 예정: Phase 2 구현 완료 후 (PDF CBT 뷰어, 상세 결과 분석)*
