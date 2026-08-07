-- content_attempts 재채점 롤백 스크립트
-- 생성: 2026-08-07T03:08:55.273Z
-- 대상 DB: C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\data\dacheum.db
-- 대상 행: 0건
-- 사용법: sqlite3 data/dacheum.db < rollback.sql
--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test
BEGIN TRANSACTION;
COMMIT;
