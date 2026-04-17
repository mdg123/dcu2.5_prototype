# 다채움 플랫폼 개발 로드맵 (PM 개발 계획서)

**작성일**: 2026-04-16  
**버전**: v1.0  
**작성자**: PM Agent  
**대상 시스템**: 다채움 K-12 교육 플랫폼  

---

## 1. 경영 요약 (Executive Summary)

다채움 플랫폼은 현재 38개 HTML 페이지와 21개 API 라우트 모듈, SQLite DB, Socket.IO 실시간 통신을 갖춘 풀스택 교육 플랫폼으로 운영 중이다. 채움포털, 채움클래스, 채움콘텐츠, 스스로채움(자기주도학습), 우리반 성장기록, 채움CBT, LRS 대시보드의 7대 서비스 모듈로 구성되어 있다.

**핵심 과제 3가지**:

1. **채움CBT 고도화**: 현재 프로덕션에는 기본 CBT(문항 목록형 플레이어)만 존재한다. 독립 구현된 채움CBT(PDF.js 뷰어 + Socket.IO 실시간 감독 + 대기실 + 이탈감지 + 강제종료)의 핵심 기능을 메인 플랫폼에 통합해야 한다.

2. **프로토타입 미반영 기능 구현**: 프로토타입에 설계되었으나 프로덕션에 미반영된 기능들(클래스 관리 고도화, AI 맞춤학습 학습맵 연동, 감정체크 고도화, 오늘의 학습 연동 등)을 순차적으로 반영한다.

3. **플랫폼 안정성 강화**: 인증/세션 관리, 에러 핸들링, 성능 최적화, 접근성(a11y) 개선을 통해 실제 학교 현장 배포에 적합한 품질 수준을 확보한다.

**예상 일정**: 8주 (3단계)  
**핵심 산출물**: 통합 CBT 시스템, 실시간 감독 대시보드, LRS 연동 데이터 파이프라인

---

## 2. 갭 분석 (Prototype vs Production)

### 2.1 서비스 모듈별 비교표

| 서비스 영역 | 프로토타입 기능 | 프로덕션 현황 | 갭 수준 | 비고 |
|---|---|---|---|---|
| **01 다채움 포털** | 포털 메인, 명예의 전당 | index.html, login.html 존재 | **낮음** | 포털 레이아웃 구현 완료 |
| **02 채움클래스 - 홈** | 클래스 홈, 수업, 과제, 평가, 알림장, 출석, 게시판, 쪽지, 설문 | class-home, attendance, lesson-*, homework-*, exam-view, find, manage, lesson-board/create/player/view, hall-of-fame 모두 존재 | **낮음** | 대부분 구현 완료 |
| **02 채움클래스 - 관리** | 클래스 관리 v2 (고급 UI) | manage.html 기본 존재 | **중간** | 관리 UI 고도화 필요 |
| **02 채움클래스 - 분석** | 클래스별 학습분석 | analytics.html 존재 | **낮음** | 구현 완료 |
| **03 채움콘텐츠** | 콘텐츠 허브 v2, 나도예술가 | content/index.html, plus/gallery.html, plus/external.html | **중간** | 예술가 모드 미반영 |
| **04 스스로채움 - 오늘의 학습** | today-learning 프로토타입 | self-learn/today.html 존재 | **낮음** | 기본 구현됨 |
| **04 스스로채움 - AI 맞춤학습** | learning_map (학습맵/계통도) | self-learn/learning-map.html 존재 | **중간** | 계통도 데이터 연동 보강 필요 |
| **04 스스로채움 - 감정체크** | emotion-check 프로토타입 | self-learn/emotion-checkin.html 존재 | **낮음** | 기본 구현됨 |
| **04 스스로채움 - 오답노트** | 오답노트 + 스크립트 | self-learn/wrong-note.html, problem-sets.html 존재 | **낮음** | 구현 완료, CBT 연동 추가 필요 |
| **05 성장기록** | 반 대시보드, 감정모니터링, 학생리포트, 포트폴리오 | growth/class-dashboard, emotion-monitor, index, my-activities, portfolio, student-report 존재 | **낮음** | 구현 완료 |
| **06 채움CBT** | PDF.js 뷰어 + Socket.IO 실시간 감독 + 대기실 + OMR + 이탈감지 + 강제종료 + 결과분석 | cbt/index.html(목록), cbt/player.html(기본 플레이어) | **높음** | 핵심 갭 - 아래 상세 분석 |
| **07 LRS 대시보드** | LRS 대시보드 v1 | lrs/index.html 존재 | **낮음** | 구현 완료 |
| **소통** | 쪽지, 설문 | message/index.html, survey/index.html | **낮음** | 구현 완료 |
| **관리자** | 관리자 대시보드 | admin/index.html, admin/daily-learning.html | **낮음** | 구현 완료 |

### 2.2 채움CBT 상세 갭 분석

| 기능 | 독립 CBT (06_채움cbt) | 프로덕션 CBT | 갭 |
|---|---|---|---|
| **평가지 목록** | 카드 UI, 상태 배지(대기/시험중/종료) | 클래스 기반 목록, 필터(전체/임시/진행/완료) | 프로덕션이 더 고도화 |
| **평가 생성** | PDF 업로드 + 10문항 OMR 정답 | 문항 직접 입력(텍스트+보기), 유형/시간/상태 설정 | 프로덕션이 더 유연 |
| **PDF 기반 시험** | PDF.js로 PDF 렌더링 + OMR 답안 2분할 | 미구현 (텍스트 문항만 지원) | **핵심 갭** |
| **대기실** | 줌 스타일 이름 입력 + 감독관 시작 대기 | 미구현 (즉시 시험 시작) | **핵심 갭** |
| **실시간 감독** | 전용 supervisor.html, 포커스 지시등, 이탈횟수, 통계 카드 | player.html 내 사이드패널(간이 모니터) | **핵심 갭** |
| **시험 제어** | 감독관이 시작/종료 버튼으로 제어 | 교사가 상태 변경(active/completed)으로 간접 제어 | **핵심 갭** |
| **이탈 감지** | visibilitychange + focus/blur 이중 감지, 경고바 UI | visibilitychange + focus/blur 기본 구현 | 부분 구현됨 |
| **강제 제출** | force:submit 이벤트 → 자동 채점 | 미구현 | **핵심 갭** |
| **결과 분석** | 전체 응시자 점수/이탈/문항별 정답률 | 기본 결과 모달(점수, 이탈횟수, 제출시간) | 중간 갭 |
| **자동 채점** | 서버 측 즉시 채점 | REST API 기반 채점 (routes/exam.js) | 프로덕션 구현됨 |
| **답안 자동저장** | 미구현 | 30초 주기 autosave API | 프로덕션이 더 우수 |
| **콘텐츠 연동** | 미구현 | import-from-content, export-to-content API | 프로덕션이 더 우수 |
| **인증 체계** | 이름 직접 입력 (인증 없음) | 세션 기반 인증 + 클래스 멤버 검증 | 프로덕션이 더 안전 |
| **데이터 저장** | 인메모리 Map (서버 재시작 시 초기화) | SQLite DB 영구 저장 | 프로덕션이 더 안정적 |

---

## 3. CBT 통합 계획 (Integration Plan)

### 3.1 통합 전략

독립 CBT의 UI/UX 기능과 프로덕션의 인프라(인증, DB, 클래스 시스템)를 결합하는 **하이브리드 통합** 방식을 채택한다.

```
[프로덕션 유지]                    [독립 CBT에서 가져올 것]
- 인증/세션 체계                   - PDF.js 기반 시험 뷰어
- SQLite DB 영구 저장              - 대기실(Waiting Room) UI
- 클래스 기반 시험 관리             - 감독관 전용 대시보드 (supervisor)
- REST API (exam.js)              - OMR 답안 입력 UI
- 자동저장 (autosave)             - 실시간 시험 시작/종료 제어
- 콘텐츠 연동 (import/export)     - 강제 제출 (force:submit)
- LRS 학습로그 기록               - 문항별 정답률 분석 결과 페이지
                                  - 포커스 지시등 + 경고바 UI
```

### 3.2 통합 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                      다채움 메인 서버 (server.js)              │
│                                                               │
│  Express + Socket.IO + SQLite                                 │
│                                                               │
│  [REST API]                        [Socket.IO]                │
│  routes/exam.js                    socket/index.js            │
│  ├ GET  /:classId                  ├ exam:join                │
│  ├ POST /:classId                  ├ exam:start (NEW)         │
│  ├ GET  /:classId/:examId          ├ exam:end (NEW)           │
│  ├ POST /:classId/:examId/start    ├ student:joined (NEW)     │
│  ├ POST /:classId/:examId/submit   ├ student:left (NEW)       │
│  ├ POST /:classId/:examId/autosave ├ tab:leave (기존)         │
│  ├ GET  /:classId/:examId/pdf (NEW)├ tab:return (기존)        │
│  └ GET  /:classId/:examId/results  ├ force:submit (NEW)       │
│    (Enhanced)                      └ answer:submit (NEW)      │
│                                                               │
│  [DB Tables]                                                  │
│  exams (기존) + pdf_file 컬럼 활용                              │
│  exam_students (기존) + tab_events TEXT 컬럼 추가               │
│  exam_autosaves (기존)                                        │
│  exam_delegates (기존)                                        │
│                                                               │
├─────────────────────────────────────────────────────────────┤
│  [Frontend Pages - public/cbt/]                               │
│                                                               │
│  index.html ─── 평가 목록 (기존, 유지)                         │
│  player.html ── 텍스트 문항 플레이어 (기존, 유지)              │
│  pdf-player.html ── PDF.js 기반 CBT 뷰어 (NEW)               │
│  supervisor.html ── 감독관 실시간 대시보드 (NEW)               │
│  result.html ── 상세 결과/분석 페이지 (NEW)                   │
│  waiting-room.html ── 응시 대기실 (NEW, 또는 pdf-player 내장) │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 DB 스키마 변경

```sql
-- 기존 exams 테이블에 컬럼 추가
ALTER TABLE exams ADD COLUMN exam_mode TEXT DEFAULT 'text';
  -- 'text': 기존 텍스트 문항, 'pdf': PDF 기반 OMR
ALTER TABLE exams ADD COLUMN subject_code TEXT;
ALTER TABLE exams ADD COLUMN grade_group TEXT;
ALTER TABLE exams ADD COLUMN achievement_code TEXT;
ALTER TABLE exams ADD COLUMN source_content_id INTEGER;

-- 기존 exam_students에 이벤트 로그 컬럼 추가
ALTER TABLE exam_students ADD COLUMN tab_events TEXT DEFAULT '[]';
  -- JSON: [{type:'leave'|'return', time: ISO string}]
```

> 참고: `subject_code`, `grade_group`, `achievement_code`, `source_content_id` 컬럼은 이미 db/exam.js의 createExam에서 사용 중이므로 schema.js에 반영만 하면 된다.

### 3.4 Socket.IO 이벤트 확장

현재 `socket/index.js`에는 기본 이벤트(exam:join, tab:leave, tab:return, focus:lost, focus:gained)만 구현되어 있다.

**추가 구현 필요 이벤트:**

| 이벤트 | 방향 | 용도 |
|---|---|---|
| `exam:start` | 교사 -> 서버 | 시험 시작 (대기 -> 시작 전환) |
| `exam:started` | 서버 -> 전체 응시자 | 시험 시작 알림 (대기실 -> 시험 화면 전환) |
| `exam:end` | 교사 -> 서버 | 시험 종료 (일괄 강제 제출) |
| `exam:ended` | 서버 -> 전체 응시자 | 시험 종료 알림 |
| `force:submit` | 서버 -> 미제출 응시자 | 강제 제출 신호 |
| `student:joined` | 서버 -> 교사 | 응시자 입장 알림 (이름, 시간) |
| `student:left` | 서버 -> 교사 | 응시자 퇴장 알림 |
| `students:list` | 서버 -> 교사 | 현재 응시자 전체 목록 (초기 동기화) |
| `student:submitted` | 서버 -> 교사 | 응시자 제출 완료 알림 (점수 포함) |
| `student:tabswitch` | 서버 -> 교사 | 포커스 상태 변경 (포커스 지시등 업데이트) |

---

## 4. 우선순위 매트릭스 (Priority Matrix)

### P0 - 필수 (Must Have) | 1-2주 내

| ID | 기능 | 설명 | 공수 (MD) | 담당 |
|---|---|---|---|---|
| P0-01 | CBT 감독관 대시보드 | supervisor.html 신규 생성. 실시간 응시자 목록, 포커스 지시등, 이탈횟수, 시험 시작/종료 버튼 | 5 | 개발자 |
| P0-02 | CBT 대기실 기능 | 시험 시작 전 대기 화면. Socket.IO exam:start/exam:started 이벤트 구현 | 3 | 개발자 |
| P0-03 | Socket.IO 이벤트 확장 | socket/index.js에 시험 제어 + 감독 이벤트 추가 | 3 | 개발자 |
| P0-04 | 강제 제출 기능 | 감독관 종료 시 미제출 학생 답안 자동 채점 | 2 | 개발자 |
| P0-05 | CBT 페이지 UI 디자인 | supervisor, pdf-player, result 페이지 UI/UX 설계 | 3 | UI 디자이너 |
| P0-06 | 기존 CBT 플레이어 안정화 | player.html 버그 수정, 교사 모니터 패널 Socket 이벤트 연동 확인 | 2 | 개발자 |

### P1 - 중요 (Should Have) | 3-4주 내

| ID | 기능 | 설명 | 공수 (MD) | 담당 |
|---|---|---|---|---|
| P1-01 | PDF 기반 CBT 뷰어 | pdf-player.html 신규 생성. PDF.js + OMR 2분할 레이아웃 | 5 | 개발자 |
| P1-02 | PDF 업로드 API | exam.js에 PDF 업로드 엔드포인트 추가 (multer) | 2 | 개발자 |
| P1-03 | 평가 생성 모달 고도화 | PDF 업로드 모드 추가, OMR 정답 입력 UI | 3 | 개발자 |
| P1-04 | 상세 결과 분석 페이지 | result.html - 문항별 정답률, 평균/최고/최저점, 이탈 통계 | 3 | 개발자 |
| P1-05 | 이탈 경고 UI | 응시자 화면 상단 경고바, 이탈 횟수 표시 | 1 | 개발자 |
| P1-06 | CBT-LRS 연동 강화 | 시험 결과를 LRS에 상세 기록 (문항별 정답여부, 소요시간 등) | 2 | 개발자 |
| P1-07 | CBT-오답노트 연동 | 기존 exam.js submit 로직의 오답 자동저장 기능 검증 및 보강 | 1 | 개발자 |
| P1-08 | 성장기록 연동 | CBT 결과를 성장기록 대시보드에 반영 | 2 | 개발자 |

### P2 - 개선 (Nice to Have) | 5-8주 내

| ID | 기능 | 설명 | 공수 (MD) | 담당 |
|---|---|---|---|---|
| P2-01 | 클래스 관리 UI 고도화 | 프로토타입 class-manage-v2 디자인 반영 | 3 | UI 디자이너 + 개발자 |
| P2-02 | 콘텐츠 허브 확장 | 나도예술가 모드, 외부 콘텐츠 연동 강화 | 3 | 개발자 |
| P2-03 | AI 맞춤학습 계통도 연동 | learning-map에 교육과정 성취기준 계통도 데이터 연결 | 3 | 개발자 |
| P2-04 | 시험 시간 표시 고도화 | 감독관 대시보드에 경과 시간, 남은 시간 타이머 표시 | 1 | 개발자 |
| P2-05 | 결과 내보내기 | 엑셀/CSV 다운로드, 인쇄용 레이아웃 | 2 | 개발자 |
| P2-06 | 접근성(a11y) 개선 | ARIA 레이블, 키보드 네비게이션, 고대비 모드 | 3 | UI 디자이너 + 개발자 |
| P2-07 | 모바일 반응형 CBT | 태블릿/모바일 환경 대응 레이아웃 | 3 | UI 디자이너 + 개발자 |
| P2-08 | 시험 복제 기능 | 기존 시험을 복사하여 새 시험 생성 | 1 | 개발자 |
| P2-09 | 시험 통계 대시보드 | 교사용 학급/학기별 시험 성적 추이 분석 | 3 | 개발자 |

---

## 5. 구현 단계 (Implementation Phases)

### Phase 1: CBT 실시간 감독 통합 (1-2주)

**목표**: 교사가 실시간으로 시험을 제어하고 학생 상태를 모니터링할 수 있는 핵심 기능 구현

**주차별 상세:**

#### Week 1: 백엔드 + 감독관 대시보드

| 일 | 작업 | 산출물 |
|---|---|---|
| Day 1-2 | Socket.IO 이벤트 확장 (socket/index.js) | exam:start, exam:end, force:submit, students:list 등 10개 이벤트 |
| Day 2-3 | 감독관 대시보드 UI (public/cbt/supervisor.html) | 실시간 응시자 목록, 포커스 지시등, 통계 카드 |
| Day 3-4 | 대기실 기능 (player.html 또는 별도 waiting 컴포넌트) | 시험 시작 대기 UI, exam:started 수신 시 시험 화면 전환 |
| Day 4-5 | 강제 제출 + 일괄 채점 | force:submit -> answer:submit 파이프라인 |

#### Week 2: 통합 테스트 + UI 보완

| 일 | 작업 | 산출물 |
|---|---|---|
| Day 1-2 | CBT index.html에 "감독" 버튼 추가 | 교사 역할일 때 감독 링크 노출 |
| Day 2-3 | 이탈 경고 UI 구현 (player.html) | 경고바 + 이탈 횟수 표시 |
| Day 3-4 | 기존 player.html 교사 모니터 패널 연동 확인 | Socket 이벤트 정합성 검증 |
| Day 4-5 | E2E 테스트: 교사 1 + 학생 3 시나리오 | 대기 -> 시작 -> 이탈감지 -> 제출 -> 종료 전체 플로우 |

**Phase 1 완료 기준:**
- [ ] 교사가 감독관 대시보드에서 시험을 시작/종료할 수 있다
- [ ] 학생이 대기실에서 시험 시작 신호를 받으면 자동으로 시험 화면으로 전환된다
- [ ] 교사가 학생의 실시간 포커스 상태(집중/이탈)를 확인할 수 있다
- [ ] 교사가 시험 종료 시 미제출 학생의 답안이 자동 채점된다
- [ ] 모든 이벤트가 인증된 세션 기반으로 동작한다 (이름 직접 입력 방식 아님)

---

### Phase 2: PDF CBT + 결과 분석 (3-4주)

**목표**: PDF 기반 시험 뷰어와 상세 결과 분석 페이지 구현

#### Week 3: PDF 업로드 + 뷰어

| 일 | 작업 | 산출물 |
|---|---|---|
| Day 1-2 | PDF 업로드 API (routes/exam.js + multer 설정) | POST /:classId/pdf-upload 엔드포인트 |
| Day 2-3 | PDF 스트리밍 API | GET /:classId/:examId/pdf (시험 시작 후에만 접근 허용) |
| Day 3-4 | pdf-player.html 기본 레이아웃 | PDF.js 좌측 + OMR 우측 2분할 |
| Day 4-5 | OMR 답안 입력 UI | 10/20문항 x 5지선다 버튼 그리드, 선택/해제 |

#### Week 4: 결과 분석 + LRS 연동

| 일 | 작업 | 산출물 |
|---|---|---|
| Day 1-2 | result.html 상세 결과 페이지 | 문항별 정답률 차트, 평균/최고/최저 통계 |
| Day 2-3 | CBT-LRS 연동 강화 | exam submit 시 상세 xAPI 문장 생성 |
| Day 3-4 | 평가 생성 모달 PDF 모드 추가 | cbt/index.html에 "PDF 평가 만들기" 옵션 |
| Day 4-5 | CBT-오답노트 연동 검증 | 오답 자동저장 -> wrong-note.html 표시 확인 |

**Phase 2 완료 기준:**
- [ ] PDF 파일을 업로드하여 시험을 생성할 수 있다
- [ ] 학생이 PDF 시험지를 보면서 OMR 답안을 입력할 수 있다
- [ ] 시험 시작 전에는 PDF에 접근할 수 없다
- [ ] 문항별 정답률 분석 결과를 확인할 수 있다
- [ ] 시험 결과가 LRS에 기록되어 대시보드에 반영된다

---

### Phase 3: 플랫폼 고도화 + 안정화 (5-8주)

**목표**: 나머지 프로토타입 미반영 기능 구현, 접근성/반응형 개선, 전체 QA

#### Week 5-6: 미반영 기능 구현

| 작업 | 설명 |
|---|---|
| 클래스 관리 UI 고도화 | class-manage-v2 프로토타입 디자인 반영 |
| 콘텐츠 허브 확장 | 나도예술가 모드 + 외부 콘텐츠 관리 |
| AI 맞춤학습 계통도 | 교육과정 성취기준 데이터 연결 |
| 시험 결과 내보내기 | 엑셀/CSV 다운로드 |
| 시험 복제/재사용 | 기존 시험 복사 기능 |

#### Week 7-8: QA + 접근성 + 배포

| 작업 | 설명 |
|---|---|
| 접근성(a11y) 개선 | ARIA, 키보드 네비게이션, 스크린리더 대응 |
| 모바일 반응형 | CBT 뷰어 태블릿/모바일 대응 |
| 성능 최적화 | DB 쿼리 최적화, 소켓 연결 관리, 메모리 누수 점검 |
| 전체 QA | 시나리오별 통합 테스트 (아래 베타 테스트 계획 참조) |
| 배포 가이드 | GCP/Vercel 배포 문서 업데이트 |

---

## 6. 기술 아키텍처 (Technical Architecture)

### 6.1 시스템 구성도

```
 [브라우저]
    │
    ├── HTTP ──→ Express 서버 (server.js, PORT 3000)
    │              ├── routes/auth.js    → 로그인/세션
    │              ├── routes/class.js   → 클래스 CRUD
    │              ├── routes/exam.js    → 시험 CRUD + 채점
    │              ├── routes/growth.js  → 성장기록
    │              ├── routes/lrs.js     → LRS 데이터
    │              ├── routes/learning.js→ 학습 기록
    │              └── routes/upload.js  → 파일 업로드
    │
    └── WebSocket ──→ Socket.IO (socket/index.js)
                        ├── exam:join     → 시험방 입장
                        ├── exam:start    → 시험 시작 (교사)
                        ├── exam:end      → 시험 종료 (교사)
                        ├── tab:leave/return → 이탈 감지
                        ├── force:submit  → 강제 제출
                        └── student:*     → 감독 이벤트

 [데이터 저장]
    SQLite (db/dachaeum.db)
    ├── users, classes, class_members
    ├── exams, exam_students, exam_autosaves, exam_delegates
    ├── learning_logs, learning_activities
    ├── contents, content_questions
    ├── homework, homework_submissions
    ├── lessons, lesson_activities
    ├── attendance, boards, messages, surveys
    └── user_points, user_badges
```

### 6.2 인증 흐름 (CBT 통합 시)

```
[학생 시험 응시 흐름]
1. 학생 로그인 → 세션 발급 (express-session)
2. CBT 목록 (cbt/index.html) → GET /api/exam/:classId
3. "응시" 클릭 → cbt/player.html?classId=X&examId=Y
4. Socket.IO 연결 → 세션 공유 (io.use 미들웨어)
5. socket.emit('exam:join') → 서버에서 세션 userId 추출
6. 대기실 표시 → exam:started 수신 시 시험 시작
7. 제출 → POST /api/exam/:classId/:examId/submit

[교사 감독 흐름]
1. 교사 로그인 → 세션 발급
2. CBT 목록에서 "감독" 클릭 → cbt/supervisor.html?classId=X&examId=Y
3. Socket.IO 연결 → join:supervisor 이벤트
4. 현재 응시자 목록 수신 (students:list)
5. "시험 시작" → exam:start 이벤트
6. 실시간 모니터링 (student:tabswitch, student:submitted)
7. "시험 종료" → exam:end → force:submit → 일괄 채점
```

### 6.3 CBT와 기존 시스템 연동 포인트

| 연동 대상 | 연동 방식 | 데이터 흐름 |
|---|---|---|
| **인증 (auth)** | express-session 공유 | Socket.IO handshake 시 세션 userId 추출 |
| **클래스 (class)** | exam.class_id FK | 시험은 클래스에 종속, 클래스 멤버만 접근 |
| **LRS (lrs)** | learning-log-helper.logLearningActivity | exam_complete 시 xAPI 문장 생성 |
| **오답노트 (learning)** | learning.addWrongAnswer | submit 시 오답 자동 저장 |
| **성장기록 (growth)** | growth-extended 조회 | 학생별 시험 점수 추이 표시 |
| **콘텐츠 (content)** | cbt-extended.importFromContent | 콘텐츠의 문항을 시험으로 변환 |
| **포인트 (gamification)** | point-helper | 시험 완료 시 포인트 부여 |

---

## 7. 리스크 평가 (Risk Assessment)

| 리스크 | 영향 | 발생확률 | 대응 |
|---|---|---|---|
| **Socket.IO 동시 접속 부하** | 30명 이상 동시 응시 시 지연 | 중간 | 소켓 이벤트 스로틀링(1초), room 기반 브로드캐스트, 클러스터링 대비 |
| **PDF 파일 크기** | 대용량 PDF 업로드 시 서버 메모리 | 중간 | multer 파일 크기 제한(10MB), 클라이언트 측 PDF.js 렌더링으로 서버 부하 없음 |
| **세션 만료 중 시험** | 시험 도중 세션 만료 시 답안 유실 | 높음 | autosave 30초 주기로 이미 구현됨. Socket 재연결 시 답안 복원 로직 추가 |
| **브라우저 호환성** | PDF.js, Socket.IO, Visibility API 미지원 | 낮음 | 대상 브라우저: Chrome 90+, Edge, Safari 15+ (학교 환경 기준) |
| **SQLite 동시 쓰기** | 다수 학생 동시 제출 시 DB Lock | 중간 | WAL 모드 사용, 트랜잭션 최소화, 필요시 쓰기 큐잉 |
| **이탈 감지 우회** | 학생이 F12/개발자도구로 이탈감지 무력화 | 낮음 | 서버 측 타임스탬프 검증, 이탈 패턴 분석 (과도한 이탈 0회는 의심) |
| **데이터 정합성** | Socket 이벤트와 REST API 간 상태 불일치 | 중간 | 모든 상태 변경은 DB 기준으로 하고, Socket은 알림 채널로만 사용 |

---

## 8. UI/UX 요구사항 (UI Designer Agent용)

### 8.1 신규 페이지 디자인

#### 8.1.1 감독관 대시보드 (supervisor.html)

**디자인 토큰**: 기존 프로덕션 디자인 시스템 준수
```css
--primary: #2563eb;  --primary-dark: #1d4ed8;
--success: #10b981;  --warning: #f59e0b;  --danger: #ef4444;
--gray-50 ~ gray-800 스케일
font-family: 'Pretendard', 'Noto Sans KR', system-ui
```

**레이아웃 요구사항**:
- 상단: 시험 제목 + 상태 배지 + [시험 시작]/[시험 종료] 버튼
- 통계 카드 행: 접속 인원, 응시 중, 제출 완료, 이탈 감지 (4개 카드, 아이콘 + 숫자)
- 메인: 응시자 테이블 (No, 이름, 상태 배지, 포커스 지시등, 이탈 횟수, 점수)
- 포커스 지시등: 초록(집중) / 빨강(이탈) 원형 점멸 애니메이션
- 모든 데이터 실시간 갱신 (DOM 직접 업데이트, 리렌더링 최소화)

**참고 디자인**: 독립 CBT의 `supervisor.html` 레이아웃 (구현명세서 6.4절 참조)

#### 8.1.2 PDF CBT 뷰어 (pdf-player.html)

**레이아웃 요구사항**:
- 상단 헤더: 시험 제목 + 타이머 + 진행률 + 제출 버튼 (기존 player.html 헤더 동일)
- 메인: flex 2분할
  - 좌측 65%: PDF.js canvas + 이전/다음 페이지 버튼 + 페이지 표시
  - 우측 35%: OMR 답안 입력 (문항 번호 + 5지선다 원형 버튼)
- 상단 경고바: 이탈 발생 시 빨간 배경으로 슬라이드 다운, 5초 후 자동 숨김
- 하단: 작성 진행률 (n/10 작성) + 제출 버튼

**OMR 버튼 스타일**:
- 36x36px 원형, 2px 보더
- 미선택: 흰 배경 + 회색 보더
- 선택: primary 파란색 배경 + 흰 글자
- hover: primary 보더

#### 8.1.3 결과 페이지 (result.html)

**레이아웃**:
- 상단: 시험 제목 + 요약 (전체 응시자, 평균, 최고, 최저)
- 차트: 문항별 정답률 가로 막대 그래프 (CSS bar 또는 Chart.js)
- 테이블: 학생별 이름, 점수(점수대별 색상 배지), 이탈횟수, 제출시간

#### 8.1.4 대기실 UI (player.html 내 또는 별도)

- 중앙 정렬 카드
- 스피너 애니메이션
- "평가 대기실" 타이틀
- 안내 문구: "감독관이 시험을 시작하면 자동으로 진행됩니다"
- 정보: 평가명, 문항 수, 응시자 이름

### 8.2 기존 페이지 수정

| 페이지 | 수정 사항 |
|---|---|
| cbt/index.html | 교사에게 "감독" 버튼 추가. "PDF 평가 만들기" 옵션 추가 |
| cbt/player.html | 대기실 모드 추가 (시험 시작 전 대기 화면). 이탈 경고바 추가 |

### 8.3 반응형 고려사항

- 감독관 대시보드: 태블릿 가로(1024px 이상) 최적화. 모바일은 테이블 가로 스크롤
- PDF 뷰어: 태블릿 가로 모드 대응. 모바일에서는 좌/우 탭 전환 방식 고려
- OMR 버튼: 터치 대상 최소 44x44px

---

## 9. 개발자 태스크 분해 (Developer Agent용)

### Phase 1 태스크

```
TASK-001: Socket.IO 이벤트 확장
  파일: socket/index.js
  작업:
    1. exam:start 이벤트 핸들러 추가
       - 교사 권한 검증 (세션에서 userId → DB에서 exam owner 확인)
       - examDb.updateExam(examId, { status: 'active' }) 호출
       - io.to(`exam:${examId}`).emit('exam:started', { examId, startTime })
    2. exam:end 이벤트 핸들러 추가
       - 미제출 학생에게 force:submit 전송
       - 3초 후 미응답 학생 강제 채점
       - examDb.updateExam(examId, { status: 'completed' })
    3. students:list 초기 동기화
       - 교사 join 시 현재 접속 학생 목록 전송
    4. student:tabswitch 이벤트 구조화
       - 기존 tab:leave/return을 감독관에게 구조화된 데이터로 전달
       - { socketId, userId, displayName, tabSwitchCount, currentFocus }
  테스트: 교사 1 + 학생 2 시나리오 수동 테스트

TASK-002: 감독관 대시보드 (supervisor.html)
  파일: public/cbt/supervisor.html (신규)
  작업:
    1. HTML/CSS 레이아웃 (common-nav 포함)
    2. Socket.IO 연결 + join:supervisor 이벤트
    3. students:list 수신 → 테이블 렌더링
    4. student:joined/left → 행 추가/제거
    5. student:tabswitch → 포커스 지시등 + 이탈 카운트 업데이트
    6. student:submitted → 점수 표시
    7. 시험 시작/종료 버튼 → exam:start/exam:end 이벤트 발송
    8. 통계 카드 실시간 갱신
  의존: TASK-001 완료 필요

TASK-003: 대기실 기능 (player.html 수정)
  파일: public/cbt/player.html
  작업:
    1. loadExam() 수정: exam status === 'waiting' 이면 대기실 표시
    2. 대기실 UI 추가 (questionArea 내부)
    3. Socket.IO exam:started 이벤트 리스너 추가
    4. 시작 시 대기실 숨김 → 문항 표시 + 타이머 시작
    5. 이탈 경고바 UI 추가
  의존: TASK-001

TASK-004: 강제 제출 처리 (player.html 수정)
  파일: public/cbt/player.html
  작업:
    1. force:submit 이벤트 리스너 추가
    2. 현재 답안 자동 제출 (submitExam(true) 호출)
    3. exam:ended 이벤트 → 시험 종료 화면 전환
  의존: TASK-001, TASK-003

TASK-005: CBT 목록 페이지 감독 버튼
  파일: public/cbt/index.html
  작업:
    1. 교사(owner) 역할일 때 exam-card에 "감독" 버튼 추가
    2. 클릭 시 supervisor.html?classId=X&examId=Y 이동
    3. 시험 상태가 'waiting'/'active' 일 때만 감독 버튼 표시
  의존: TASK-002 완료 필요
```

### Phase 2 태스크

```
TASK-101: PDF 업로드 API
  파일: routes/exam.js
  작업:
    1. multer 설정 (uploads/ 디렉토리, PDF만 허용, 10MB 제한)
    2. POST /:classId/create-pdf 엔드포인트
       - FormData: title, pdf, answers(JSON), time_limit
       - exam.pdf_file = 업로드 경로, exam.exam_mode = 'pdf'
    3. GET /:classId/:examId/pdf 엔드포인트
       - 시험 상태 'active'/'started' 일 때만 PDF 스트리밍
       - 교사(owner)는 상태 무관 접근 가능

TASK-102: PDF CBT 뷰어
  파일: public/cbt/pdf-player.html (신규)
  작업:
    1. PDF.js CDN 로드 (v3.11.174)
    2. 좌측 PDF canvas + 페이지 네비게이션
    3. 우측 OMR 답안 입력 UI
    4. Socket.IO 연결 (이탈 감지, 대기실, 강제 제출)
    5. 제출 → POST /api/exam/:classId/:examId/submit
    6. autosave 30초 주기

TASK-103: 평가 생성 모달 PDF 모드
  파일: public/cbt/index.html
  작업:
    1. "PDF 평가 만들기" 버튼 추가
    2. PDF 업로드 + OMR 정답 입력 UI (5지선다 x N문항)
    3. FormData로 TASK-101 API 호출

TASK-104: 상세 결과 페이지
  파일: public/cbt/result.html (신규)
  작업:
    1. GET /api/exam/:classId/:examId/export-results 활용
    2. 문항별 정답률 가로 막대 그래프
    3. 학생별 점수/이탈 테이블
    4. 평균, 최고, 최저 통계 카드

TASK-105: LRS 연동 강화
  파일: routes/exam.js, db/learning-log-helper.js
  작업:
    1. submit 시 문항별 정답 여부 상세 기록
    2. 소요 시간 기록 (start → submit 시간 차이)
    3. 이탈 횟수/시간 LRS 기록
```

---

## 10. 베타 테스트 계획 (Tester Agent용)

### 10.1 테스트 환경

- **서버**: localhost:3000 (node server.js)
- **브라우저**: Chrome 최신 (주), Edge (보조)
- **테스트 계정**: 교사 1명 + 학생 3~5명 (기존 DB의 데모 계정 활용)

### 10.2 Phase 1 테스트 시나리오

#### TC-001: 감독관 대시보드 접근

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 교사 로그인 | 성공 |
| 2 | CBT 목록 → 평가 카드에 "감독" 버튼 확인 | 교사에게만 표시됨 |
| 3 | "감독" 클릭 → supervisor.html 이동 | 대시보드 로드, 시험 제목 표시 |
| 4 | 통계 카드 확인 | 접속 0, 응시 0, 제출 0, 이탈 0 |

#### TC-002: 학생 대기실 → 시험 시작

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 학생 로그인 → CBT 목록 → "응시" 클릭 | player.html 이동 |
| 2 | 시험 상태 'waiting' 확인 | 대기실 화면 표시 (스피너, 안내 문구) |
| 3 | 교사가 감독관에서 "시험 시작" 클릭 | 확인 모달 표시 |
| 4 | 교사가 확인 | 학생 화면이 자동으로 시험 화면으로 전환됨 |
| 5 | 학생 화면에 문항 표시 확인 | 첫 번째 문항 + 타이머 시작 |

#### TC-003: 이탈 감지 + 감독관 실시간 확인

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 학생이 시험 중 다른 탭으로 전환 | 학생 화면에 경고바 표시 |
| 2 | 감독관 대시보드 확인 | 해당 학생 포커스 지시등 빨간색, 이탈 횟수 +1 |
| 3 | 학생이 시험 탭으로 복귀 | 감독관 대시보드 포커스 지시등 초록색 복귀 |

#### TC-004: 강제 종료 + 일괄 채점

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 학생 A가 5문항 응답 후 미제출 상태 | - |
| 2 | 학생 B가 자발적 제출 | 감독관에 점수 표시 |
| 3 | 교사가 "시험 종료" 클릭 | 확인 모달 ("미제출 N명 답안 일괄 제출") |
| 4 | 교사가 확인 | 학생 A 화면 "감독관에 의해 종료" 표시 |
| 5 | 감독관 대시보드 확인 | 학생 A 점수 표시 (5문항만 채점), 상태 "제출완료" |

#### TC-005: 동시 접속 테스트

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 학생 3명 동시 입장 | 감독관에 3명 실시간 표시 |
| 2 | 시험 시작 | 3명 동시 시험 화면 전환 |
| 3 | 1명 이탈 + 1명 제출 + 1명 응시 중 | 각각 상태 정확히 반영 |
| 4 | 시험 종료 | 미제출자 자동 채점 |

### 10.3 Phase 2 테스트 시나리오

#### TC-101: PDF 업로드 + 시험 생성

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | "PDF 평가 만들기" 클릭 | PDF 업로드 모달 표시 |
| 2 | PDF 파일 선택 + 제목 입력 + 10문항 OMR 정답 설정 | 유효성 검사 통과 |
| 3 | "등록" 클릭 | 평가 카드 추가 (PDF 모드 표시) |

#### TC-102: PDF 뷰어 응시

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | PDF 평가 응시 시작 | 좌측 PDF, 우측 OMR 레이아웃 표시 |
| 2 | PDF 페이지 넘김 (이전/다음) | 페이지 전환 정상 |
| 3 | OMR 답안 선택/해제 | 선택 상태 UI 반영, 진행률 업데이트 |
| 4 | 30초 경과 | 자동 저장 동작 (네트워크 탭 확인) |
| 5 | 제출 | 채점 결과 표시 |

#### TC-103: 결과 분석 페이지

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 교사가 완료된 시험의 "결과" 클릭 | result.html 표시 |
| 2 | 문항별 정답률 차트 확인 | 각 문항의 정답률 막대 그래프 |
| 3 | 학생별 결과 테이블 확인 | 점수, 이탈횟수, 제출시간 표시 |

#### TC-104: CBT → 오답노트 연동

| 단계 | 동작 | 기대 결과 |
|---|---|---|
| 1 | 학생이 시험 제출 (일부 오답) | - |
| 2 | 스스로채움 → 오답노트 이동 | 해당 시험의 오답 문항 자동 등록 확인 |

### 10.4 비기능 테스트

| 항목 | 테스트 방법 | 기준 |
|---|---|---|
| **성능** | 학생 10명 동시 접속 시 Socket 이벤트 지연 측정 | 이벤트 전달 < 500ms |
| **안정성** | 시험 중 네트워크 끊김 → 재접속 | 답안 복원(autosave), 세션 유지 |
| **보안** | 비로그인 상태에서 시험 API 접근 | 401 반환 |
| **보안** | 비멤버 학생이 다른 클래스 시험 접근 | 403 반환 |
| **보안** | 시험 시작 전 PDF URL 직접 접근 | 403 반환 |
| **데이터** | 시험 제출 후 DB 확인 | exam_students, learning_logs 정상 기록 |

### 10.5 회귀 테스트 체크리스트

- [ ] 기존 텍스트 문항 CBT (player.html) 정상 동작
- [ ] 클래스 홈에서 시험 목록 표시 정상
- [ ] 출석부, 과제, 게시판 등 기존 기능 영향 없음
- [ ] 로그인/로그아웃 정상
- [ ] LRS 대시보드에 시험 데이터 표시

---

## 부록 A: 파일 목록 (현재 프로덕션)

### 프론트엔드 (public/) - 38 HTML 파일

```
public/
├── index.html                          # 메인 대시보드
├── login.html                          # 로그인
├── admin/
│   ├── index.html                      # 관리자 대시보드
│   └── daily-learning.html             # 오늘의 학습 관리
├── cbt/
│   ├── index.html                      # CBT 평가 목록
│   └── player.html                     # CBT 응시 플레이어
├── class/
│   ├── index.html                      # 클래스 목록
│   ├── class-home.html                 # 클래스 홈
│   ├── manage.html                     # 클래스 관리
│   ├── find.html                       # 클래스 찾기
│   ├── analytics.html                  # 학습 분석
│   ├── attendance.html                 # 출석부
│   ├── emotion-monitor.html            # 감정 모니터링
│   ├── exam-view.html                  # 시험 보기
│   ├── homework-view.html              # 과제 보기
│   ├── hall-of-fame.html               # 명예의 전당
│   ├── lesson-board.html               # 수업 게시판
│   ├── lesson-create.html              # 수업 만들기
│   ├── lesson-player.html              # 수업 플레이어
│   └── lesson-view.html                # 수업 보기
├── content/
│   └── index.html                      # 콘텐츠 허브
├── growth/
│   ├── index.html                      # 성장기록 메인
│   ├── class-dashboard.html            # 반 대시보드
│   ├── emotion-monitor.html            # 감정 모니터링
│   ├── my-activities.html              # 나의 활동
│   ├── portfolio.html                  # 포트폴리오
│   └── student-report.html             # 학생 리포트
├── lrs/
│   └── index.html                      # LRS 대시보드
├── message/
│   └── index.html                      # 소통 쪽지
├── plus/
│   ├── external.html                   # 외부 콘텐츠
│   └── gallery.html                    # 갤러리
├── self-learn/
│   ├── index.html                      # 스스로채움 메인
│   ├── emotion-checkin.html            # 감정 체크인
│   ├── learning-map.html               # 학습 맵
│   ├── problem-sets.html               # 문제 모음
│   ├── today.html                      # 오늘의 학습
│   └── wrong-note.html                 # 오답 노트
└── survey/
    └── index.html                      # 설문
```

### 백엔드 (routes/) - 21 라우트 모듈

```
routes/
├── admin.js          # 관리자
├── attendance.js     # 출석
├── auth.js           # 인증
├── board.js          # 게시판
├── class.js          # 클래스
├── content.js        # 콘텐츠
├── curriculum.js     # 교육과정
├── exam.js           # 시험/CBT
├── growth.js         # 성장기록
├── homework.js       # 과제
├── ingest.js         # 데이터 수집
├── learning.js       # 학습
├── lesson.js         # 수업
├── lrs.js            # LRS
├── message.js        # 메시지
├── notice.js         # 알림
├── portal.js         # 포털
├── search.js         # 검색
├── self-learn.js     # 자기주도학습
├── survey.js         # 설문
└── upload.js         # 업로드
```

### DB 모듈 (db/) - 핵심 테이블

```
users, notifications, classes, class_members
exams, exam_students, exam_autosaves, exam_delegates
lessons, lesson_activities, homework, homework_submissions
attendance, boards, board_comments, messages
surveys, survey_responses, contents, content_questions
learning_logs, learning_activities
user_points, user_badges
```

---

## 부록 B: 독립 CBT 코드 참조

독립 CBT 소스 위치: `06_채움cbt 실동작/chaeum-cbt/`

```
chaeum-cbt/
├── server.js          # Express + Socket.IO (743줄)
├── package.json
├── uploads/           # PDF 파일 저장
└── public/
    ├── index.html     # 평가지 목록
    ├── upload.html    # 평가지 등록 (PDF + OMR)
    ├── exam.html      # CBT 뷰어 (대기실 + PDF + OMR)
    ├── supervisor.html # 감독관 대시보드
    ├── result.html    # 결과 분석
    ├── login.html     # (기본 로그인)
    └── css/style.css  # 공통 스타일
```

구현 명세서: `06_채움cbt 실동작/채움CBT_구현명세서.md`

---

## 부록 C: 용어 정의

| 용어 | 설명 |
|---|---|
| CBT | Computer Based Test - 컴퓨터 기반 평가 |
| LRS | Learning Record Store - 학습 기록 저장소 |
| OMR | Optical Mark Recognition - 광학 마크 인식 (답안 입력 UI) |
| xAPI | Experience API - 학습 경험 데이터 표준 |
| Socket.IO | WebSocket 기반 실시간 양방향 통신 라이브러리 |
| PDF.js | Mozilla의 클라이언트 측 PDF 렌더링 라이브러리 |
| 스스로채움 | 자기주도학습 모듈 |
| 채움클래스 | 학급 관리 모듈 |
| 다채움 포털 | 플랫폼 메인 포털 |

---

*끝*
