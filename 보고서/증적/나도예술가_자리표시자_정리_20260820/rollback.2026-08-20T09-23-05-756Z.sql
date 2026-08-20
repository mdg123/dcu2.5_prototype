-- 롤백 SQL — scripts/cleanup-gallery-placeholder-images.js --apply 되돌리기
-- 생성 2026-08-20T09:23:05.755Z  DB=C:\Users\user\OneDrive - 금성초등학교\바탕 화면\다채움 품질 제고사업 프로토타입 - 실동작\data\dacheum.db
BEGIN;
UPDATE student_gallery SET image_url = '/images/placeholder-art.png' WHERE id = 7;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 10;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 14;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 15;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 16;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 17;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 18;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 19;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 20;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 21;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 22;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 23;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 24;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 25;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 27;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 28;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 29;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 32;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 34;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 35;
UPDATE student_gallery SET image_url = '/uploads/placeholder.jpg' WHERE id = 36;
UPDATE student_gallery SET image_url = '/uploads/placeholder.jpg' WHERE id = 37;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 40;
UPDATE student_gallery SET image_url = '/images/placeholder.png' WHERE id = 41;
INSERT INTO gallery_attachments (id, gallery_id, type, url) VALUES (7, 7, 'image', '/images/placeholder-art.png');
COMMIT;
