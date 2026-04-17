function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? '서버 오류가 발생했습니다.' : err.message
  });
}

module.exports = { errorHandler };
