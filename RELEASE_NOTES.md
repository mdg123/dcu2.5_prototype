# 다채움 LRS 프로토타입 Release Notes

## Known Limitations (Prototype v0.x)

본 프로토타입 범위에서 다음 기능은 차기 스프린트(P1)로 이관됨을 명시합니다:

- **SRL(Self-Regulated Learning) 학생 뷰**: Zimmerman 3-phase 모델(Forethought/Performance/Self-Reflection) 분리 미적용. 현재는 Performance 모니터링 중심.
- **데이터 거버넌스 지표**: verb coverage, actor dedup rate, ingestion latency (p50/p95) 미계측. 현 a-quality 뷰는 결측률 중심.
- **xAPI voided statement 처리**: ADL xAPI §21 `voidedStatementId` 파라미터 미구현. 해당 기능 구현 전까지 **"xAPI conformant" 라벨 사용 불가**. 국내 파일럿 범위 한정 배포.
- **EWS**: threshold-only 단일 차원. Purdue Signals 식 다차원 가중 예측자 미도입. 교사 검토 SOP 전제 운영.
- **UX 후속**: a-usage/a-custom 표의 학생명·학급 검색 필터, a-teacher-idx의 하위 정렬/CSV 내보내기 미구현.
