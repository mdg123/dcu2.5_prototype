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
const { initSchema } = require('./db/schema');
initSchema();
const { initCurriculum } = require('./db/curriculum');
initCurriculum();

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
app.use('/api/self-learn', require('./routes/self-learn'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/curriculum', require('./routes/curriculum'));
app.use('/api/search', require('./routes/search'));
app.use('/api/upload', require('./routes/upload'));

// 루트 경로: 로그인 여부에 따라 분기
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login.html');
  }
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
server.listen(PORT, () => {
  console.log(`[다채움] 서버 시작: http://localhost:${PORT}`);
});
