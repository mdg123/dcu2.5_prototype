const authDb = require('../db/auth');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = authDb.findUserById(req.session.userId);
    if (user) {
      req.user = user;
      return next();
    }
  }
  // req.originalUrl은 전체 URL을 포함 (라우터 마운트 기준 상대경로 문제 방지)
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  res.redirect('/login.html');
}

// optionalAuth — 비로그인 진입 허용. 세션이 있으면 req.user 채워주고,
// 없으면 req.user = null 로 두고 다음 핸들러로 통과시킨다.
// 비로그인 포털 메인이 공개 영역(인기 콘텐츠/클래스/명예의 전당)을 호출할 때 사용.
function optionalAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = authDb.findUserById(req.session.userId);
    if (user) req.user = user;
  }
  if (!req.user) req.user = null;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '권한이 없습니다.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, optionalAuth };
