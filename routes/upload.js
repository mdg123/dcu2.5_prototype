const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

// 업로드 디렉토리 설정
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// MIME 타입 기반 하위 폴더 결정
function getSubDir(mimeType, queryType) {
  if (mimeType) {
    if (mimeType.startsWith('video/')) return 'videos';
    if (mimeType.startsWith('image/')) return 'images';
    if (mimeType.startsWith('audio/')) return 'audios';
    if (mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.includes('hwp') ||
        mimeType.includes('presentation') || mimeType.includes('spreadsheet') || mimeType.includes('text/')) return 'documents';
  }
  return queryType || 'general';
}

// multer 스토리지 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subDir = getSubDir(file.mimetype, req.query.type);
    req._uploadSubDir = subDir; // POST 핸들러에서 참조
    const dir = path.join(uploadDir, subDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
    cb(null, `${basename}-${uniqueSuffix}${ext}`);
  }
});

// 파일 필터
const fileFilter = (req, file, cb) => {
  const allowed = /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|ppt|pptx|hwp|hwpx|txt|zip|mp4|mp3|wav)$/i;
  if (allowed.test(path.extname(file.originalname))) {
    cb(null, true);
  } else {
    cb(new Error('허용되지 않는 파일 형식입니다.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// POST /api/upload - 단일 파일 업로드
router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '파일이 선택되지 않았습니다.' });
  }
  const subDir = req._uploadSubDir || req.query.type || 'general';
  const fileUrl = `/uploads/${subDir}/${req.file.filename}`;
  res.json({
    success: true,
    file: {
      url: fileUrl,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    }
  });
});

// POST /api/upload/multi - 다중 파일 업로드 (최대 5개)
router.post('/multi', requireAuth, upload.array('files', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: '파일이 선택되지 않았습니다.' });
  }
  const files = req.files.map(f => ({
    url: `/uploads/${getSubDir(f.mimetype, req.query.type)}/${f.filename}`,
    originalName: f.originalname,
    size: f.size,
    mimetype: f.mimetype
  }));
  res.json({ success: true, files });
});

// multer 에러 핸들링
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: '파일 크기가 50MB를 초과합니다.' });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.message === '허용되지 않는 파일 형식입니다.') {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

module.exports = router;
