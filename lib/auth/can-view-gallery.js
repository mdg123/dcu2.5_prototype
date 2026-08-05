// lib/auth/can-view-gallery.js
// ─────────────────────────────────────────────────────────────────────────────
// 갤러리(나도예술가) 작품 "단건 열람" 권한 판정 SSOT.
//
// ■ 유래 — P0-3 (2026-08-05 실측)
//   읽기 경로는 전부 정상 차단됐다(본인 갤러리 탭 미노출·타 학생 상세 404·인기 목록 제외).
//   그런데 **쓰기 경로에만 상태 검사가 없었다.**
//     student2 → POST /api/growth/gallery/{pending작품}/comments → 201 (gallery_comments 행 생성)
//     student2 → POST /api/growth/gallery/{pending작품}/like     → 200 (gallery_likes 행 + like_count 증가)
//   teacher1 이 나중에 승인하면 그 댓글·좋아요가 그대로 공개된다.
//   원인: routes/growth.js 가 getGalleryItemById 로 **존재 여부만** 확인하고
//   approval_status 를 안 봤다. 읽기 게이트(GET /gallery/:id)에는 판정이 있었지만
//   그 판정이 라우트 안에 인라인으로 적혀 있어 다른 라우트가 재사용할 수 없었다.
//
// ■ 원칙: **상세 조회가 404 인 대상에는 쓰기도 404.**
//   읽기 게이트와 쓰기 게이트가 같은 함수를 호출한다. 판정 사본을 만들지 않는다.
//
// ■ 정책 (기존 GET /gallery/:id 의 판정을 그대로 승격 — 정책 발명 아님)
//     - approved              → 전원 허용
//     - approval_status 없음  → 전원 허용 (레거시 행 하위호환. 기존 판정과 동일)
//     - 그 외(pending/rejected) → 작성자 본인 · teacher · admin 만
//   ※ 삭제된 작품(deleted_at)은 db/growth.js 의 조회 함수가 이미 제외한다.
// ─────────────────────────────────────────────────────────────────────────────

/** 승인 심사·운영 권한을 가진 역할 (기존 라우트의 isStaff 판정과 동일 집합). */
const GALLERY_STAFF_ROLES = new Set(['teacher', 'admin']);

/**
 * 작품 단건을 이 사용자가 볼 수 있는가(= 댓글·좋아요·조회 기록도 가능한가).
 * @param {object|null} user  req.user (비로그인이면 null)
 * @param {object|null} item  student_gallery 행
 * @returns {boolean}
 */
function canViewGalleryItem(user, item) {
  if (!item) return false;
  const status = item.approval_status;
  // 레거시 행(approval_status NULL/'')은 기존 판정과 동일하게 공개로 취급한다.
  if (!status || status === 'approved') return true;
  if (!user) return false;
  if (GALLERY_STAFF_ROLES.has(user.role)) return true;
  return Number(item.student_id) === Number(user.id);
}

module.exports = { canViewGalleryItem, GALLERY_STAFF_ROLES };
