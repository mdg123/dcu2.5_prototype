// lib/log-context.js
// 학습 로그 공통 컨텍스트 추출 헬퍼 (Phase 2)
// req 에서 session_id / device_type / platform 파싱
// 개별 서비스 라우트에서 logLearningActivity({...extractLogContext(req)}) 형태로 호출

/**
 * User-Agent 문자열을 간단히 파싱해 device_type / platform 반환.
 * web / android / ios 세 분기로 축소.
 */
function parseUserAgent(ua) {
  if (!ua || typeof ua !== 'string') {
    return { deviceType: 'web', platform: 'web' };
  }
  const s = ua.toLowerCase();
  // iOS (iPhone/iPad/iPod)
  if (/iphone|ipad|ipod/.test(s)) {
    return { deviceType: 'mobile', platform: 'ios' };
  }
  // Android
  if (/android/.test(s)) {
    const isTablet = /tablet|sm-t|gt-p/.test(s);
    return { deviceType: isTablet ? 'tablet' : 'mobile', platform: 'android' };
  }
  // 그 외는 웹(데스크톱/기타)
  return { deviceType: 'web', platform: 'web' };
}

/**
 * 요청에서 세션 ID 추출.
 * 1) req.session.lrsSessionId
 * 2) headers['x-lrs-session']
 * 3) express-session sid fallback
 */
function extractSessionId(req) {
  if (!req) return null;
  try {
    if (req.session && req.session.lrsSessionId) return String(req.session.lrsSessionId);
  } catch (_) {}
  const hdr = req.headers && (req.headers['x-lrs-session'] || req.headers['X-LRS-Session']);
  if (hdr) return String(hdr);
  try {
    if (req.sessionID) return String(req.sessionID).slice(0, 40);
  } catch (_) {}
  return null;
}

/**
 * logLearningActivity() 에 바로 스프레드할 공통 컨텍스트.
 * @returns {{sessionId: string|null, deviceType: string, platform: string}}
 */
function extractLogContext(req) {
  const ua = req && req.headers ? req.headers['user-agent'] : '';
  const { deviceType, platform } = parseUserAgent(ua);
  return {
    sessionId: extractSessionId(req),
    deviceType,
    platform
  };
}

module.exports = { extractLogContext, parseUserAgent, extractSessionId };
