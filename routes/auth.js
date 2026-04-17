const express = require('express');
const router = express.Router();
const authDb = require('../db/auth');

// POST /api/auth/signup - 회원가입
router.post('/signup', (req, res) => {
  try {
    const { username, password, displayName, role } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ success: false, message: '아이디를 입력하세요.' });
    }
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ success: false, message: '이름을 입력하세요.' });
    }
    if (!/^[0-9]{4}$/.test(password)) {
      return res.status(400).json({ success: false, message: '비밀번호는 숫자 4자리입니다.' });
    }
    if (role && !['student', 'teacher', 'parent', 'staff'].includes(role)) {
      return res.status(400).json({ success: false, message: '올바른 역할을 선택하세요.' });
    }

    const existing = authDb.findUserByUsername(username.trim());
    if (existing) {
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다.' });
    }

    const user = authDb.createUser(username.trim(), password, displayName.trim(), role || 'student', {
      school_name: req.body.school_name || null,
      grade: req.body.grade || null,
      class_number: req.body.class_number || null
    });
    req.session.userId = user.id;
    res.status(201).json({
      success: true,
      message: '회원가입이 완료되었습니다.',
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
    });
  } catch (err) {
    console.error('[AUTH] signup error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/auth/login - 로그인
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요.' });
    }

    const user = authDb.findUserByUsername(username.trim());
    if (!user) {
      return res.status(401).json({ success: false, message: '존재하지 않는 아이디입니다.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: '비활성화된 계정입니다.' });
    }
    if (!authDb.verifyPassword(password, user.password)) {
      return res.status(401).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }

    authDb.updateLastLogin(user.id);
    req.session.userId = user.id;
    res.json({
      success: true,
      message: '로그인 성공',
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
    });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/auth/logout - 로그아웃
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, message: '로그아웃 되었습니다.' });
  });
});

// GET /api/auth/me - 현재 사용자 정보
router.get('/me', (req, res) => {
  // 캐시 무효화 (프록시/브라우저가 다른 유저 응답을 재사용하지 못하게)
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');

  const sid = req.session && req.session.userId;
  if (sid) {
    const user = authDb.findUserById(sid);
    if (user) {
      // session.userId와 실제 user.id 교차 검증 (sticky 방지)
      if (user.id !== sid) {
        console.warn('[AUTH /me] session-user id mismatch:', sid, user.id);
        req.session.destroy(() => {});
        return res.status(401).json({ success: false, user: null, message: '세션 불일치' });
      }
      return res.json({ success: true, user });
    }
    // 세션의 user_id가 DB에 없으면 세션 정리
    req.session.destroy(() => {});
  }
  res.json({ success: false, user: null });
});

module.exports = router;
