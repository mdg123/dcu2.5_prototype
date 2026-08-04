try { require('dotenv').config(); } catch(e) { /* dotenv optional */ }

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

// 세션 DB 경로 준비
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// 서버 시작 전 기존 세션 DB를 안전하게 초기화
const sessDbPath = path.join(dataDir, 'sessions.db');
try {
  if (fs.existsSync(sessDbPath)) fs.unlinkSync(sessDbPath);
  [sessDbPath + '-journal', sessDbPath + '-shm', sessDbPath + '-wal'].forEach(f => {
    try { fs.unlinkSync(f); } catch(e) {}
  });
} catch(e) {}

// DB 초기화
// ⚠️ 순서 중요: initCurriculum()가 curriculum_standards 테이블을 생성한 뒤,
//   initSchema()의 마이그레이션 블록(primary_node_id / std_source ALTER 등)이
//   해당 테이블에 안전하게 컬럼을 추가하도록 한다.
//   (반대 순서일 경우 신규 DB에서 ALTER가 무성공으로 흡수되고,
//    이후 db/curriculum.js의 CREATE TABLE IF NOT EXISTS 가
//    primary_node_id 없는 테이블을 만들어 라우트 prepare 단계에서 종료됨.)
const { initCurriculum } = require('./db/curriculum');
initCurriculum();
const { initSchema } = require('./db/schema');
initSchema();

// ── 하네스 검증 스탬프 고지 (2026-07-31 사고 재발 방지) ──────────────────────
// 정본 DB 가 재집계·시드 스크립트로 바뀐 뒤 전체 하네스를 돌리지 않았다면 기동 시 알린다.
// GCP 실서버에서 원격으로 재집계한 경우, 배포 절차의 pm2 restart 가 곧 이 배너를 띄운다
// (표식은 DB 안에 있으므로 로컬/원격 구분 없이 따라다닌다).
try {
  const _hs = require('./scripts/harness-stamp');
  const _stamp = _hs.read(require('./db/index'));
  if (_hs.isStale(_stamp)) console.warn(_hs.staleMessage(_stamp, require('./db/index').name));
} catch (e) { /* 스탬프 조회 실패는 서버 기동을 막지 않는다 */ }

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 세션 저장소 설정 (connect-sqlite3 실패 시 메모리 폴백)
let store;
try {
  const SQLiteStore = require('connect-sqlite3')(session);
  store = new SQLiteStore({
    db: 'sessions.db',
    dir: dataDir,
    concurrentDB: true
  });
} catch(e) {
  console.warn('[다채움] SQLite 세션 저장 실패, 메모리 세션 사용:', e.message);
  store = undefined;
}

const sessionMiddleware = session({
  store: store,
  secret: process.env.SESSION_SECRET || 'dacheum-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7일
    httpOnly: true,
    sameSite: 'lax'
  }
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============ 관리자 HTML 접근 가드 (BUG-A-03) ============
// /admin/*.html 정적 파일은 express.static 이전에 세션·역할을 검증한다.
// - 미로그인 → /login.html?from=... 로 302 리다이렉트
// - 비-admin 역할 → 403 한국어 안내 페이지
const authDbForGuard = require('./db/auth');
app.use((req, res, next) => {
  // /admin/ 이하의 HTML 또는 디렉터리(/admin, /admin/) 요청만 가드.
  // /api/admin/* 는 라우트 단의 adminOnly 미들웨어가 처리하므로 건드리지 않는다.
  if (!req.path.startsWith('/admin')) return next();
  if (req.path.startsWith('/admin/') === false && req.path !== '/admin') return next();
  // HTML 또는 확장자 없는 디렉터리 진입만 검사 (정적 자원 .js/.css/.png 등은 통과)
  const looksLikeHtml = req.path === '/admin' || req.path === '/admin/' ||
                        req.path.endsWith('.html') ||
                        !/\.[a-zA-Z0-9]{1,5}$/.test(req.path);
  if (!looksLikeHtml) return next();

  const sessionUserId = req.session && req.session.userId;
  if (!sessionUserId) {
    const from = encodeURIComponent(req.originalUrl || req.path);
    return res.redirect(`/login.html?from=${from}`);
  }
  const user = authDbForGuard.findUserById(sessionUserId);
  if (!user) {
    const from = encodeURIComponent(req.originalUrl || req.path);
    return res.redirect(`/login.html?from=${from}`);
  }
  if (user.role !== 'admin') {
    res.status(403).type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>접근 권한 없음 — 다채움</title><style>body{font-family:Pretendard,system-ui,sans-serif;background:#F5F7FA;color:#1A1A2E;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;padding:40px 48px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.06);max-width:480px;text-align:center}.icon{font-size:48px;margin-bottom:12px}h1{font-size:22px;margin:8px 0 6px}p{color:#6B7280;font-size:16px;line-height:1.7;margin:6px 0 20px}.btn{display:inline-block;padding:12px 22px;background:#2563eb;color:#fff;border-radius:10px;text-decoration:none;font-size:16px}.btn.secondary{background:#fff;color:#2563eb;border:1px solid #2563eb;margin-left:8px}</style></head><body><div class="card"><div class="icon">🔒</div><h1>접근 권한이 없습니다</h1><p>이 페이지는 관리자만 접근할 수 있습니다.<br>관리자 계정으로 로그인하거나 포털로 돌아가세요.</p><a class="btn" href="/">포털로 가기</a><a class="btn secondary" href="/login.html">로그인</a></div></body></html>`);
    return;
  }
  next();
});

// 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));
// 워크트리에서 실행될 때 부모 저장소의 uploads 폴더도 서빙 (fallback)
{
  const parentUploads = path.resolve(__dirname, '..', '..', '..', 'public', 'uploads');
  if (require('fs').existsSync(parentUploads)) {
    app.use('/uploads', express.static(parentUploads));
  }
}

// Socket.IO에 세션 공유
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// 라우트
app.use('/api/auth', require('./routes/auth'));
app.use('/api/class', require('./routes/class'));
// 클래스 마일리지 시스템 (자동 지급 + 교사 수동 운영)
// — /api/class/:classId/mileage/* 로 마운트 (mergeParams로 :classId 전달)
{
  const { requireAuth } = require('./middleware/auth');
  const classMileageRoutes = require('./routes/class-mileage');
  app.use('/api/class/:classId/mileage', requireAuth, classMileageRoutes);
  // Socket.IO 인스턴스를 마일리지 DB 모듈에 주입 (실시간 잔액 갱신 emit용)
  try { require('./db/class-mileage').setIo(io); } catch (_) {}
}
app.use('/api/admin', require('./routes/admin'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/lesson', require('./routes/lesson'));
app.use('/api/homework', require('./routes/homework'));
app.use('/api/exam', require('./routes/exam'));
app.use('/api/notice', require('./routes/notice'));
app.use('/api/board', require('./routes/board'));
app.use('/api/message', require('./routes/message'));
app.use('/api/survey', require('./routes/survey'));
app.use('/api/contents', require('./routes/content'));
app.use('/api/learning', require('./routes/learning'));
app.use('/api/growth', require('./routes/growth'));
app.use('/api/ingest', require('./routes/ingest'));
app.use('/api/lrs', require('./routes/lrs'));
app.use('/api/school', require('./routes/school'));
app.use('/api/self-learn', require('./routes/self-learn'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/curriculum', require('./routes/curriculum'));
app.use('/api/search', require('./routes/search'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/notifications', require('./routes/notifications'));

// 루트 경로: 비로그인 사용자도 포털 진입 가능 (공개 영역만 표출)
// — 로그인 시: 개인화된 대시보드 (오늘 할 일·4슬롯·활동 요약)
// — 비로그인: 환영 헤더 + 공개 콘텐츠/클래스/명예의 전당 + 로그인/회원가입 CTA
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO 초기화
require('./socket')(io);

// 404 핸들러 (API 경로)
app.all('/api/{*path}', (req, res) => {
  res.status(404).json({ success: false, message: '요청하신 API를 찾을 수 없습니다.' });
});

// 에러 핸들러
const { errorHandler } = require('./middleware/errors');
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// listen 가드 + 테스트용 export.
//   - `node server.js` (직접 실행) 일 때만 포트를 listen 한다.
//   - `require('./server')` (테스트 등) 일 때는 app/server/io 만 노출하고 listen 하지 않는다.
//     → 테스트가 supertest 없이 http.createServer(app) 로 임시 포트 기동할 수 있게 함.
//       (회귀: 직접 실행 시 동작 동일, npm start 정상 기동 확인.)
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[다채움] 서버 시작: http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io };
