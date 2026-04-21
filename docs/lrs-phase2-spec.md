# LRS 학습분석 Phase 2 통합 사양서

**PM**: Claude | **Date**: 2026-04-21
**근거 문서**: `docs/lrs-expert-audit.md`, `docs/lrs-ui-design.md`, `docs/lrs-policy-requirements.md`

---

## 0. 최우선 해결 이슈 (Day 1)

| # | 이슈 | 파일 | 조치 |
|---|------|------|------|
| B1 | `routes/lrs.js` L49에서 `db` 변수가 require 전에 사용 | `routes/lrs.js` | require 순서 조정 |
| B2 | `/api/lrs/stats/daily`가 `duration` 컬럼 사용(실제는 `result_duration`) → 시간 0 | `routes/lrs.js` | `result_duration` 혹은 신규 `duration_sec` 사용 |
| B3 | 집계 테이블 `unique_users` 실시간 UPSERT 부정확 | `db/learning-log-helper.js` | 일일 재빌드 + 디스팅트 서브쿼리 |
| B4 | 기간 필터 `days` vs `from/to` 충돌 | `public/lrs/index.html` | `dc-period-picker` 단일 컴포넌트로 통합 |
| B5 | achievement_code 대부분 null | 각 서비스 로거 | 아래 §3 참조 |

---

## 1. 스키마 확정 (DB 팀)

### 1.1 `learning_logs` ALTER (기존 마이그레이션 뒤)
```sql
ALTER TABLE learning_logs ADD COLUMN session_id VARCHAR(40);
ALTER TABLE learning_logs ADD COLUMN duration_sec INTEGER;
ALTER TABLE learning_logs ADD COLUMN device_type VARCHAR(20);
ALTER TABLE learning_logs ADD COLUMN platform VARCHAR(30);
ALTER TABLE learning_logs ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE learning_logs ADD COLUMN correct_count INTEGER;
ALTER TABLE learning_logs ADD COLUMN total_items INTEGER;
ALTER TABLE learning_logs ADD COLUMN achievement_level VARCHAR(10);
ALTER TABLE learning_logs ADD COLUMN parent_statement_id INTEGER;
ALTER TABLE learning_logs ADD COLUMN subject_code VARCHAR(20);
ALTER TABLE learning_logs ADD COLUMN grade_group INTEGER;
```

### 1.2 신규 집계 3종
- `lrs_achievement_stats` (user_id×achievement_code, 성취수준 진전도)
- `lrs_session_stats` (세션 몰입도)
- `lrs_user_daily` (user_id×date, streak 계산 고속화)

### 1.3 인덱스 6개
`idx_ll_user_date, idx_ll_achv, idx_ll_subject_date, idx_ll_session, idx_ll_class_date, idx_ll_service_verb`

### 1.4 Dual-writer 정리
`logLearningActivity` 단일 경로로 통합. `lrs.logActivity`는 내부에서 `logLearningActivity` 래퍼 호출.

---

## 2. API 사양 (Backend)

### 기존 18개 개선
- 모든 stats 엔드포인트가 `duration_sec` 기본 사용(없으면 `result_duration` fallback).
- 기간 파라미터: `period=7d|30d|90d|custom&from=&to=` 통일.
- role별 권한 가드(`owner|teacher|admin`) — 정책 문서 TC-031~038 반영.

### 신규 엔드포인트 8개
| Method | Path | 용도 |
|---|---|---|
| GET | `/api/lrs/insights/:userId` | 개인 인사이트 카드 (약점 성취기준, 추천) |
| GET | `/api/lrs/live-feed` | 최근 활동 스트림 (socket.io room 연계) |
| GET | `/api/lrs/achievement-progress` | 성취기준별 상/중/하 분포 |
| GET | `/api/lrs/parent/:childId/digest` | 학부모 주간 다이제스트 |
| POST | `/api/lrs/session/start` | 세션 시작 |
| POST | `/api/lrs/session/end` | 세션 종료 |
| GET | `/api/lrs/warnings/:classId` | 경고 학생 리스트(부진/미학습) |
| GET | `/api/lrs/export` (기존, 확장) | CSV/Excel + 필터 |

---

## 3. 서비스 로거 풍부화 (각 서비스 팀)

모든 `logLearningActivity` 호출에 아래 필수 추가:
- `achievement_code` (성취기준, curriculum 연동)
- `subject_code`, `grade_group`
- `duration_sec`
- `session_id` (localStorage/req.session에서 발급)
- `device_type`, `platform`
- 평가: `correct_count`, `total_items`, `retry_count`, `achievement_level`

### 수집 지점
1. **채움클래스**: `routes/class.js`, `routes/assignment.js`, `routes/exam.js`
2. **콘텐츠**: `routes/content.js` (조회/완료/북마크)
3. **스스로채움**: `routes/self-learn.js` (진단/오답노트/학습맵)
4. **성장기록**: `routes/growth.js`, `routes/portfolio.js`, `routes/emotion.js`
5. **채움성장 CBT**: `routes/cbt.js` 응시/채점

---

## 4. UI 리빌드 (Frontend)

### 4.1 디자인 토큰 파일 신설
`public/css/lrs-tokens.css` — UI 디자이너 §1.1~1.2 (chart-1~10, 히트맵 램프, radius/shadow).

### 4.2 IA (역할 기반, 서브메뉴 재편)
- **학생**: 내 학습 요약 / 내 성취 / 내 추이 / 비교
- **교사**: 우리반 현황(랜딩) / 학생 드릴다운 / 경고 / 수업 활용도 / 교과별 진단
- **관리자**: 전체 통계 / 기간 비교 / 데이터 품질 / 내보내기

상단에 role switcher(권한에 따라 가시 옵션 축소).

### 4.3 공통 컴포넌트 12개
- `dc-filter-bar`, `dc-period-picker`, `dc-kpi-card`, `dc-chart-wrapper`,
  `dc-state-panel`(loading/empty/error), `dc-data-table`, `dc-heatmap`,
  `dc-gauge`, `dc-sparkline`, `dc-badge`, `dc-drawer`, `dc-role-switcher`.

### 4.4 필수 액션(딥링크) — 대시보드는 종점 X
- 학생 약점 카드 → 스스로채움 추천 콘텐츠
- 교사 경고 카드 → 메시지 / 과제 부과 / 맞춤학습 추천

### 4.5 반응형
- 1280px+ 데스크톱 / 768px 태블릿 / 360px 모바일.
- 차트 Chart.js 단일 사용(기존 의존성 유지).

### 4.6 접근성
- WCAG AA 대비, 키보드 내비, `aria-live` 폴라이트(차트 업데이트).

---

## 5. 시드 데이터 (Seed 팀)

- 학생 30명 × 30일 학습 시뮬레이션.
- 실제 curriculum `achievement_code` 매핑.
- activity_type별 현실 분포: 수업 40%, 콘텐츠 25%, 스스로채움 20%, 평가/과제 10%, 기타 5%.
- 약점 학생 3명(하위 분위), 우수 1명, 경고 2명(연속 미학습).
- 시간대 분포: 08-09시 피크, 13-15시 수업, 19-21시 자율.

스크립트: `scripts/seed-lrs-realistic.js` (기존 seed 스크립트 참고, `--reset` 옵션).

---

## 6. DoD 재확인
Phase 1 계획서 §4의 11개 항목 그대로 유지.

## 7. Phase 3 작업 분할
- T-A: DB 스키마 + 신규 API + dual-writer 통합 (Backend 에이전트)
- T-B: lrs/index.html 전면 리빌드 + 토큰/컴포넌트 (UI 에이전트)
- T-C: 5개 서비스 로거 풍부화 (Service 에이전트)
- T-D: 시드 스크립트 (Seed 에이전트)

T-A, T-D 선행 → T-B, T-C 병렬.
