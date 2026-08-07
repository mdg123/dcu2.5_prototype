-- 2회 차감 수리 (2026-08-07)
--
-- 사고: --apply 를 두 번 실행했다. 자동 판정 159행은 변환 후 해설 신호가 '0based' 로
--       뒤집혀 재선정되지 않았으나(멱등), MANUAL_INCLUDE 3행은 증거 검사를 우회해
--       가드가 없었던 탓에 -1 이 두 번 누적됐다.
--
-- 아래는 "원본 -1"(= 의도한 최종값)로 되돌린다. 원본값은 rollback.sql 참조.
--   q69  : 원본 4 → 잘못된 현재 2 → 정정 3  ("1/2")
--   q227 : 원본 2 → 잘못된 현재 0 → 정정 1  ("②-1")
--   q228 : 원본 4 → 잘못된 현재 2 → 정정 3  ("④√2")
--
-- 적용 직후: node scripts/harness-stamp.js mark --script repair-double-decrement.sql && npm test
BEGIN TRANSACTION;
UPDATE content_questions SET answer='3' WHERE id=69  AND answer='2';
UPDATE content_questions SET answer='1' WHERE id=227 AND answer='0';
UPDATE content_questions SET answer='3' WHERE id=228 AND answer='2';
COMMIT;
