// lib/uploads-access.js
// ─────────────────────────────────────────────────────────────────────────────
// 업로드 파일(/uploads/**) 서빙 가드.
//
// ■ 유래 — P0-2 후반부 (2026-08-05 실측)
//   server.js 가 `app.use(express.static(path.join(__dirname,'public')))` 하나로
//   public/uploads/** 전체를 **무인증 공개**하고 있었다. 상세 API 로 얻은 file_path 를
//   비로그인 상태로 그대로 다운로드할 수 있었고, 삭제된 콘텐츠의 첨부도 디스크에 남아
//   계속 받아졌다.
//
// ■ 여기서 신중해야 하는 이유 — 일괄 차단은 기능 파괴
//   /uploads 를 통째로 인증 뒤로 옮기면 **비로그인 포털이 깨진다.**
//   실측(정본 DB)한 "비로그인에게 보여야 하는" 자원:
//     · 명예의 전당(portal /highlights, optionalAuth) → 승인된 학생 작품 이미지
//       (student_gallery.image_url 14행 · gallery_attachments.url 13행)
//     · 인기/추천 콘텐츠(content /recommendations·/featured, optionalAuth) → 공개 승인본 썸네일
//   그래서 **경로(prefix)로 막지 않고 자원의 공개 여부에서 파일 권한을 유도**한다.
//
// ■ 3단 판정 (파일 경로 → 그 파일을 참조하는 "자원" → 자원의 공개 여부)
//   ① 공개 자원이 참조   → 비로그인 포함 전원 200   (과차단 방지의 핵심)
//   ② 비공개 자원이 참조 → 로그인 필수(401) + 그 자원의 열람 권한자만(403)
//                          · 콘텐츠  → lib/auth/can-view-content.js (읽기 API 와 동일 판정)
//                          · 갤러리  → lib/auth/can-view-gallery.js (읽기 API 와 동일 판정)
//                          · 과제 제출물 → 제출 학생 본인 / 그 클래스 교사-티어 / admin
//   ③ 아무 자원도 참조 안 함 → **로그인 사용자에게는 허용**
//      (게시글 본문(posts.content)에 인라인 삽입된 이미지·시드 정적 파일·
//       오늘의학습 썸네일처럼 경로만으로 소유자를 알 수 없는 부류가 여기 걸린다.
//       이들까지 막으면 정상 화면이 깨지므로 "무인증 차단"까지만 하고 멈춘다.
//       ⚠ 한계로 보고서에 명시할 것 — 완전한 파일 ACL 은 자원 경유 다운로드 라우트가 필요하다.)
//
// ■ 판정 사본 금지: 콘텐츠·갤러리 판정은 읽기 API 가 쓰는 바로 그 함수를 호출한다.
// ─────────────────────────────────────────────────────────────────────────────
const db = require('../db/index');
const { canViewContent } = require('./auth/can-view-content');
const { canViewGalleryItem } = require('./auth/can-view-gallery');
const { CLASS_TEACHER_ROLES } = require('./auth/can-view-user');

// prepared statement 는 lazy 캐시 (모듈 로드 시점에 테이블이 없을 수 있다).
const _stmt = {};
function prep(key, sql) {
  if (!_stmt[key]) _stmt[key] = db.prepare(sql);
  return _stmt[key];
}

/**
 * 요청 URL → DB 에 저장된 형태('/uploads/...')의 정규 경로.
 * 퍼센트 인코딩(한글 파일명) 해제 + 쿼리/해시 제거 + 상위 이동(..) 거부.
 * @returns {string|null} 정규 경로. 안전하지 않으면 null.
 */
function normalizeUploadPath(rawUrlPath) {
  if (!rawUrlPath) return null;
  let p = String(rawUrlPath).split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch (_) { /* 잘못된 인코딩은 원문 유지 */ }
  p = p.replace(/\\/g, '/');
  if (p.includes('\0')) return null;
  if (!p.startsWith('/')) p = '/' + p;
  if (p.split('/').includes('..')) return null;   // 상위 이동 차단
  p = p.replace(/\/{2,}/g, '/');
  return p;
}

/** ① 공개 자원이 이 파일을 참조하는가 (비로그인에게도 열리는 유일한 부류). */
function isReferencedByPublicResource(p) {
  try {
    const c = prep('pubContent', `
      SELECT 1 FROM contents
      WHERE is_public = 1 AND status = 'approved'
        AND (file_path = @p COLLATE NOCASE
          OR thumbnail_url = @p COLLATE NOCASE
          OR content_url = @p COLLATE NOCASE)
      LIMIT 1
    `).get({ p });
    if (c) return true;
  } catch (_) {}
  try {
    const g = prep('pubGallery', `
      SELECT 1 FROM student_gallery
      WHERE deleted_at IS NULL
        AND (approval_status IS NULL OR approval_status = '' OR approval_status = 'approved')
        AND (image_url = @p COLLATE NOCASE OR media_url = @p COLLATE NOCASE)
      LIMIT 1
    `).get({ p });
    if (g) return true;
  } catch (_) {}
  try {
    const a = prep('pubGalleryAtt', `
      SELECT 1 FROM gallery_attachments ga
      JOIN student_gallery g ON g.id = ga.gallery_id
      WHERE g.deleted_at IS NULL
        AND (g.approval_status IS NULL OR g.approval_status = '' OR g.approval_status = 'approved')
        AND ga.url = @p COLLATE NOCASE
      LIMIT 1
    `).get({ p });
    if (a) return true;
  } catch (_) {}
  return false;
}

/** ② 이 파일을 참조하는 비공개 콘텐츠 행들. */
function privateContentsRefs(p) {
  try {
    return prep('privContent', `
      SELECT id, creator_id, is_public, status, content_type, source FROM contents
      WHERE NOT (is_public = 1 AND status = 'approved')
        AND (file_path = @p COLLATE NOCASE
          OR thumbnail_url = @p COLLATE NOCASE
          OR content_url = @p COLLATE NOCASE)
      LIMIT 20
    `).all({ p });
  } catch (_) { return []; }
}

/** ② 이 파일을 참조하는 미승인 갤러리 작품들(본체 image_url/media_url + 첨부). */
function privateGalleryRefs(p) {
  const rows = [];
  try {
    rows.push(...prep('privGallery', `
      SELECT id, student_id, approval_status FROM student_gallery
      WHERE deleted_at IS NULL
        AND approval_status IS NOT NULL AND approval_status <> '' AND approval_status <> 'approved'
        AND (image_url = @p COLLATE NOCASE OR media_url = @p COLLATE NOCASE)
      LIMIT 20
    `).all({ p }));
  } catch (_) {}
  try {
    rows.push(...prep('privGalleryAtt', `
      SELECT g.id, g.student_id, g.approval_status FROM gallery_attachments ga
      JOIN student_gallery g ON g.id = ga.gallery_id
      WHERE g.deleted_at IS NULL
        AND g.approval_status IS NOT NULL AND g.approval_status <> '' AND g.approval_status <> 'approved'
        AND ga.url = @p COLLATE NOCASE
      LIMIT 20
    `).all({ p }));
  } catch (_) {}
  return rows;
}

/** ② 이 파일을 참조하는 과제 제출물(항상 비공개 — 제출 학생·담당 교사·admin 만). */
function homeworkSubmissionRefs(p) {
  try {
    return prep('hwSub', `
      SELECT s.id, s.student_id, h.class_id, h.public_submissions
      FROM homework_submissions s
      LEFT JOIN homework h ON h.id = s.homework_id
      WHERE s.file_path = @p COLLATE NOCASE
         OR (s.attachments IS NOT NULL AND s.attachments LIKE @like)
      LIMIT 20
    `).all({ p, like: `%${p}%` });
  } catch (_) { return []; }
}

/** 사용자가 그 클래스의 active 멤버인가(역할 무관). */
function isClassMember(userId, classId) {
  if (!Number.isFinite(classId)) return false;
  try {
    return !!prep('clsMember', `
      SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active' LIMIT 1
    `).get(classId, userId);
  } catch (_) { return false; }
}

/** 사용자가 그 클래스의 교사-티어(또는 소유자)인가. */
function isClassTeacher(userId, classId) {
  if (!Number.isFinite(classId)) return false;
  try {
    const ph = [...CLASS_TEACHER_ROLES].map(() => '?').join(',');
    return !!db.prepare(`
      SELECT 1 FROM classes c
      WHERE c.id = ?
        AND (c.owner_id = ?
          OR EXISTS (SELECT 1 FROM class_members m
                     WHERE m.class_id = c.id AND m.user_id = ? AND m.status='active'
                       AND m.role IN (${ph})))
      LIMIT 1
    `).get(classId, userId, userId, ...CLASS_TEACHER_ROLES);
  } catch (_) { return false; }
}

/**
 * 업로드 파일 접근 판정.
 * @param {object|null} user  req.user (비로그인 null)
 * @param {string} rawUrlPath  '/uploads/...' (인코딩 상태 무관)
 * @returns {{allow:boolean, status?:number, reason:string}}
 */
function decideUploadAccess(user, rawUrlPath) {
  const p = normalizeUploadPath(rawUrlPath);
  if (!p) return { allow: false, status: 400, reason: 'invalid-path' };

  // ① 공개 자원 참조 → 무조건 허용 (비로그인 포털 유지)
  if (isReferencedByPublicResource(p)) return { allow: true, reason: 'public-resource' };

  // ② 그 외는 최소한 로그인 필요
  if (!user) return { allow: false, status: 401, reason: 'auth-required' };
  if (user.role === 'admin') return { allow: true, reason: 'admin' };

  // ② 비공개 자원이 참조 → 그 자원의 열람 권한자만
  let referenced = false;

  const contents = privateContentsRefs(p);
  if (contents.length) {
    referenced = true;
    if (contents.some(c => canViewContent(user, c))) return { allow: true, reason: 'content-grant' };
  }

  const galleries = privateGalleryRefs(p);
  if (galleries.length) {
    referenced = true;
    if (galleries.some(g => canViewGalleryItem(user, g))) return { allow: true, reason: 'gallery-grant' };
  }

  const subs = homeworkSubmissionRefs(p);
  if (subs.length) {
    referenced = true;
    //   제출 학생 본인 · 그 클래스 교사-티어 · (공개 제출물 과제면) 같은 클래스 멤버.
    //   ⚠ public_submissions=1 은 "제출물 상호 공개" 과제(정본 4건) — 이걸 빼면
    //     동료 제출물 첨부가 깨진다(과차단).
    if (subs.some(s =>
      Number(s.student_id) === Number(user.id) ||
      isClassTeacher(Number(user.id), Number(s.class_id)) ||
      (Number(s.public_submissions) === 1 && isClassMember(Number(user.id), Number(s.class_id)))
    )) {
      return { allow: true, reason: 'homework-grant' };
    }
  }

  if (referenced) return { allow: false, status: 403, reason: 'no-grant' };

  // ③ 어떤 자원도 참조하지 않는 파일 → 로그인 사용자에게는 허용 (과차단 방지)
  return { allow: true, reason: 'unreferenced-authenticated' };
}

/**
 * express 미들웨어. **반드시 express.static 보다 먼저** 마운트해야 한다.
 *   app.use('/uploads', uploadsGuard);
 *   app.use(express.static(path.join(__dirname, 'public')));   // ← public/uploads 포함
 */
function uploadsGuard(req, res, next) {
  // 마운트 경로가 잘려 나오므로 원래 경로로 복원한다.
  const full = req.baseUrl && req.baseUrl.startsWith('/uploads')
    ? req.baseUrl + (req.path === '/' ? '' : req.path)
    : (req.path.startsWith('/uploads') ? req.path : '/uploads' + req.path);

  let decision;
  try {
    decision = decideUploadAccess(req.user || null, full);
  } catch (err) {
    console.error('[UPLOADS-GUARD] 판정 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
  if (decision.allow) return next();

  if (decision.status === 401) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  if (decision.status === 400) {
    return res.status(400).json({ success: false, message: '잘못된 경로입니다.' });
  }
  return res.status(403).json({ success: false, message: '이 파일에 접근할 권한이 없습니다.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 고아 업로드 파일 회수 (W1-T3-11)
//   콘텐츠 행만 지우고 파일을 남기면 "삭제된 자료가 영구 다운로드" 된다.
//   ⚠ 같은 파일을 아직 다른 행이 참조하면 지우지 않는다 — 정본 DB 실측상
//     /uploads/mindmap.png 처럼 여러 자원이 공유하는 파일이 실제로 있다.
//   ⚠ public/uploads 밖으로는 절대 나가지 않는다(경로 탈출 방어).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const nodePath = require('path');

/** 업로드 루트. 테스트는 UPLOADS_ROOT 로 임시 디렉터리를 주입해 정본을 건드리지 않는다. */
function uploadsRoot() {
  return process.env.UPLOADS_ROOT || nodePath.join(__dirname, '..', 'public', 'uploads');
}

/** 이 경로를 아직 참조하는 행이 있는가(콘텐츠·갤러리·갤러리첨부·과제 제출물). */
function isStillReferenced(p) {
  const q = (key, sql, params) => {
    try { return !!prep(key, sql).get(params); } catch (_) { return false; }
  };
  return (
    q('refContent', `SELECT 1 FROM contents WHERE file_path = @p COLLATE NOCASE OR thumbnail_url = @p COLLATE NOCASE OR content_url = @p COLLATE NOCASE LIMIT 1`, { p }) ||
    q('refGallery', `SELECT 1 FROM student_gallery WHERE image_url = @p COLLATE NOCASE OR media_url = @p COLLATE NOCASE LIMIT 1`, { p }) ||
    q('refGalleryAtt', `SELECT 1 FROM gallery_attachments WHERE url = @p COLLATE NOCASE LIMIT 1`, { p }) ||
    q('refHw', `SELECT 1 FROM homework_submissions WHERE file_path = @p COLLATE NOCASE OR (attachments IS NOT NULL AND attachments LIKE @like) LIMIT 1`, { p, like: `%${p}%` }) ||
    q('refPost', `SELECT 1 FROM posts WHERE image_url = @p COLLATE NOCASE OR (content IS NOT NULL AND content LIKE @like) LIMIT 1`, { p, like: `%${p}%` })
  );
}

/**
 * 참조가 사라진 업로드 파일을 디스크에서 지운다.
 * @param {Array<string|null>} paths  '/uploads/...' 목록(중복·null 허용)
 * @returns {string[]} 실제로 지운 경로
 */
function removeOrphanUploads(paths) {
  const removed = [];
  const root = nodePath.resolve(uploadsRoot());
  for (const raw of new Set((paths || []).filter(Boolean))) {
    const p = normalizeUploadPath(raw);
    if (!p || !p.startsWith('/uploads/')) continue;
    if (isStillReferenced(p)) continue;
    const abs = nodePath.resolve(root, p.replace(/^\/uploads\//, ''));
    if (abs !== root && !abs.startsWith(root + nodePath.sep)) continue;  // 경로 탈출 방어
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        fs.unlinkSync(abs);
        removed.push(p);
      }
    } catch (err) {
      console.warn('[UPLOADS] 고아 파일 삭제 실패:', p, err.message);
    }
  }
  return removed;
}

module.exports = {
  uploadsGuard,
  decideUploadAccess,
  normalizeUploadPath,
  isReferencedByPublicResource,
  removeOrphanUploads,
};
