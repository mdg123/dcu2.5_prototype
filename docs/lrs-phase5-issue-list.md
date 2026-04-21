# Phase 5 이슈 트래커 (1회전)

출처: `docs/lrs-audit-review.md`, `docs/lrs-expert-review.md`, `docs/lrs-ui-review.md`, `docs/lrs-qa-report.md`

## P0 (차단 — 즉시 수정)

### Backend
- **[D1/P0-F-01]** `routes/lrs.js` `computeAchievementLevel` 임계값 0.80/0.50 → result_score는 0~100 스케일. 107/117건이 "상"으로 오분류. 임계값을 raw max_score 기준 비율로 바꾸거나 0~100 스케일로 상향 (상 ≥80, 중 ≥50, 하 <50). `db/learning-log-helper.js` 내부 동일 함수도 함께 수정.
- **[P0-F-02]** `/warnings/:classId` 로그 0건 학생이 `daysInactive=999`로 혼입. `last_activity_date IS NULL` 학생은 제외하거나 별도 라벨(`no_data`).
- **[C-2]** `/api/lrs/statements/:id` — `canViewUser` 가드 추가.
- **[C-3]** `/content/:id`, `/statements`, `/dataset-coverage` — student role 차단 또는 본인 데이터만.
- **[C-4]** `db/lrs.js`의 `SUM(duration)` 잔존 쿼리 → `COALESCE(duration_sec, ...)` 통합. `schema.js` CREATE 블록에 Phase 2 컬럼을 함께 정의해 신규 DB 부트스트랩 정합성 확보.
- **[C-5]** `logLearningActivity` 전체를 단일 `db.transaction(...)`으로 감싸기.

### Frontend
- **[C-1]** `public/lrs/index.html` 서버 응답을 `innerHTML`/인라인 `onclick`에 보간하는 5지점 — escape helper(`escapeHtml`) 적용 + 인라인 onclick 제거, addEventListener + data-* 속성 사용.
- **[UI-P0-1]** 교사 경고 카드 액션 버튼 `alert()` 목업 → 실제 딥링크:
  - 메시지: `/class/class-home.html?classId=...&tab=message&to=...`
  - 과제 부과: `/class/class-home.html?classId=...&tab=homework&new=1&to=...`
  - 맞춤학습: `/self-learn/?user_id=...&achievement_code=...`
- **[UI-P0-2]** `--sync-time` `gray-400` → `gray-600` (대비 상향).
- **[UI-P0-3]** `--heat-2` 중간셀 텍스트 색상 어두운 톤으로 변경 (흰색→#1e3a8a 등).

## P1 (Major)

- **[M-1]** `routes/lrs.js:706` `users.parent_id` 컬럼 참조 → 컬럼 추가 마이그레이션 or 관계 테이블 조인으로 대체.
- **[M-3]** `/warnings/:classId` N+1 → JOIN 단일 쿼리로 리라이트.
- **[M-4]** `parseIso8601Duration`을 PT[n]H[n]M[n]S 전체 지원 (현재 S만).
- **[M-5]** `/rebuild-aggregates`, `/log` 등 POST에 CSRF 또는 admin-only 가드.
- **[M-6]** `/api/lrs/log` body에서 `result_score`, `achievement_code` 등 민감 필드는 whitelist로만 통과.
- **[M-11]** `/xapi/statements` — `logLearningActivity` 호출로 교체.
- **[P1-S-01]** `/parent/:childId/digest` 점수 원값 → 성취수준 레이블(상/중/하)로 마스킹.
- **[P1-F-03]** `/stats/daily` `subject` 쿼리 파라미터 처리 (subject_code WHERE).
- **[P1-F-04]** `/session/end` durationSec=0 케이스 — created_at 기반 계산.
- **[P1-D-01]** `lrs_achievement_stats.avg_score` NULL → rebuild 시 채우도록 aggregate 수정.
- **[P1-U-01]** `dc-data-table` 컴포넌트 실구현 (학생 드릴다운/경고 리스트에 사용).

## P2 (Minor)
- dc-heatmap/dc-gauge/dc-sparkline 실렌더
- CSV injection 방어 (= , + , @ 프리픽스 escape)
- weeklyTarget 매직넘버 → 설정화
- 시드 스크립트를 `logLearningActivity` 경유로 변환 (statement_json 정합성)
- from>to 시 400 반환

---
총계: P0 9건, P1 11건, P2 5건
