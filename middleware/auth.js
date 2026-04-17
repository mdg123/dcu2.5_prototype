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

module.exports = { requireAuth, requireRole };
