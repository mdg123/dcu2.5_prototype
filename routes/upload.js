const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

// ★ 저장 위치·파일명·허용 목록·용량 상한은 lib/upload-rules.js 한 벌만 쓴다(SSOT).
//   본문 붙여넣기(data: URL) 변환기도 같은 규칙을 쓰므로, 그 경로가
//   "검사를 건너뛰는 뒷문"이 되지 않는다. 여기서 규칙을 다시 적지 말 것.
const rules = require('../lib/upload-rules');
const { UPLOAD_ROOT: uploadDir, getSubDir, makeFilename, isAllowedFileName,
        MAX_FILE_SIZE, MSG_BAD_TYPE, MSG_TOO_LARGE } = rules;

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// multer 스토리지 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subDir = getSubDir(file.mimetype, req.query.type);
    req._uploadSubDir = subDir; // POST 핸들러에서 참조
    cb(null, rules.ensureSubDir(subDir));
  },
  filename: (req, file, cb) => {
    cb(null, makeFilename(file.originalname));
  }
});

// 파일 필터
const fileFilter = (req, file, cb) => {
  if (isAllowedFileName(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error(MSG_BAD_TYPE), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE } // 50MB
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
      return res.status(400).json({ success: false, message: MSG_TOO_LARGE });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.message === MSG_BAD_TYPE) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

module.exports = router;
