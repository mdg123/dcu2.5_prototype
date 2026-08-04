/**
 * 권한 없음(403) 안내 패널 — 공통 컴포넌트
 *
 * 서버가 403 을 주면 "실패"가 아니라 "권한 없음"이다.
 * 에러 문구 한 줄만 남기고 교사용 화면(툴바·필터·빈 표)을 그대로 렌더하면
 * 사용자는 "고장난 화면"으로 오해하고, 볼 수 없는 정보의 존재만 노출된다.
 * 이 컴포넌트는 (1) 해당 화면의 UI 를 모두 감추고 (2) 무엇을 볼 수 없는지와
 * (3) 어디로 돌아가면 되는지를 함께 안내한다.
 *
 * 사용법:
 *   const res = await fetch(url);
 *   if (DacheumAccess.denied(res, { what: '학급 감정 현황', ... })) return;
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 받침 유무로 은/는, 이/가 같은 조사를 골라 준다 */
  function josa(word, withJong, withoutJong) {
    var s = String(word || '');
    var last = s.charCodeAt(s.length - 1);
    if (!(last >= 0xAC00 && last <= 0xD7A3)) return withoutJong;
    return ((last - 0xAC00) % 28) > 0 ? withJong : withoutJong;
  }

  function injectStyle() {
    if (document.getElementById('dcDeniedStyle')) return;
    var st = document.createElement('style');
    st.id = 'dcDeniedStyle';
    st.textContent = [
      '#dcDeniedPanel{display:flex;justify-content:center;padding:64px 20px 80px;font-family:Pretendard,"Noto Sans KR",system-ui,-apple-system,sans-serif;}',
      '#dcDeniedPanel .dc-denied-card{width:100%;max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:16px;box-shadow:0 4px 20px rgba(15,23,42,.06);padding:40px 36px;text-align:center;box-sizing:border-box;}',
      '#dcDeniedPanel .dc-denied-icon{width:72px;height:72px;margin:0 auto 20px;border-radius:50%;background:#EFF6FF;color:#2563eb;display:flex;align-items:center;justify-content:center;font-size:30px;}',
      '#dcDeniedPanel h1{font-size:28px;line-height:1.35;font-weight:800;color:#1A1A2E;margin:0 0 12px;}',
      '#dcDeniedPanel .dc-denied-desc{font-size:17px;line-height:1.75;color:#4B5563;margin:0 0 8px;word-break:keep-all;}',
      '#dcDeniedPanel .dc-denied-reason{display:inline-block;margin-top:12px;padding:10px 16px;border-radius:10px;background:#F8FAFC;border:1px solid #E5E7EB;font-size:15px;line-height:1.6;color:#6B7280;word-break:keep-all;}',
      '#dcDeniedPanel .dc-denied-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:28px;}',
      '#dcDeniedPanel .dc-denied-btn{display:inline-flex;align-items:center;gap:8px;font-size:16px;font-weight:700;padding:12px 22px;border-radius:10px;border:1px solid transparent;cursor:pointer;text-decoration:none;box-sizing:border-box;font-family:inherit;}',
      '#dcDeniedPanel .dc-denied-btn.primary{background:#2563eb;color:#fff;}',
      '#dcDeniedPanel .dc-denied-btn.primary:hover{background:#1d4ed8;}',
      '#dcDeniedPanel .dc-denied-btn.ghost{background:#fff;color:#374151;border-color:#D1D5DB;}',
      '#dcDeniedPanel .dc-denied-btn.ghost:hover{background:#F3F4F6;}',
      '#dcDeniedPanel .dc-denied-btn:focus-visible{outline:3px solid #93C5FD;outline-offset:2px;}',
      '@media (max-width:767px){#dcDeniedPanel{padding:36px 16px 56px;}#dcDeniedPanel .dc-denied-card{padding:32px 20px;}#dcDeniedPanel h1{font-size:24px;}#dcDeniedPanel .dc-denied-actions{flex-direction:column;}#dcDeniedPanel .dc-denied-btn{width:100%;justify-content:center;}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /** 현재 화면의 UI 를 모두 감춘다 (공통 GNB 는 남겨 복귀 동선 유지) */
  function hidePageChrome() {
    var gnb = document.getElementById('dacheum-gnb-wrapper');
    Array.prototype.slice.call(document.body.children).forEach(function (el) {
      if (el === gnb) return;
      if (el.id === 'dcDeniedPanel') return;
      if (/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/.test(el.tagName)) return;
      el.style.display = 'none';
    });
    // 모달·오버레이가 열려 있었다면 함께 닫는다
    document.body.style.overflow = '';
  }

  /**
   * 권한 없음 화면을 그린다.
   * @param {Object} opts
   *   what      {string} 볼 수 없는 대상 (예: '학급 감정 현황')
   *   who       {string} 누가 볼 수 있는지 (예: '이 학급을 맡은 선생님')
   *   reason    {string} 서버가 알려준 사유
   *   backHref  {string} 복귀 링크 URL
   *   backLabel {string} 복귀 링크 라벨
   */
  function show(opts) {
    opts = opts || {};
    if (document.getElementById('dcDeniedPanel')) return;
    injectStyle();
    hidePageChrome();

    var what = opts.what || '이 화면';
    var who = opts.who || '권한이 있는 사용자';
    var backHref = opts.backHref || '/';
    var backLabel = opts.backLabel || '홈으로 가기';

    var wrap = document.createElement('div');
    wrap.id = 'dcDeniedPanel';
    wrap.innerHTML =
      '<div class="dc-denied-card" role="alert">' +
        '<div class="dc-denied-icon"><i class="fas fa-lock"></i></div>' +
        '<h1>열람 권한이 없는 화면입니다</h1>' +
        '<p class="dc-denied-desc"><strong>' + esc(what) + '</strong>' + josa(what, '은', '는') + ' ' + esc(who) + '만 볼 수 있어요.</p>' +
        '<p class="dc-denied-desc">잘못 들어온 주소일 수 있어요. 아래 버튼으로 돌아가 주세요.</p>' +
        (opts.reason ? '<div class="dc-denied-reason">안내: ' + esc(opts.reason) + '</div>' : '') +
        '<div class="dc-denied-actions">' +
          '<a class="dc-denied-btn primary" href="' + esc(backHref) + '"><i class="fas fa-arrow-left"></i> ' + esc(backLabel) + '</a>' +
          '<button type="button" class="dc-denied-btn ghost" id="dcDeniedBack"><i class="fas fa-rotate-left"></i> 이전 화면으로</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var backBtn = document.getElementById('dcDeniedBack');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        if (history.length > 1) history.back();
        else location.href = backHref;
      });
    }
    // 아이콘 폰트가 없는 페이지 대비
    if (!document.querySelector('link[href*="font-awesome"],link[href*="fontawesome"]')) {
      var ic = wrap.querySelector('.dc-denied-icon');
      if (ic) ic.textContent = '🔒';
    }
  }

  /**
   * 403 이면 안내 화면을 그리고 true 를 돌려준다. 호출부는 true 면 즉시 return.
   * @param {Response|Object} res  fetch Response 또는 {status} 를 가진 객체
   */
  function denied(res, opts) {
    if (!res || res.status !== 403) return false;
    opts = opts || {};
    if (opts.reason === undefined && res.clone) {
      // 서버 메시지를 비동기로 덧붙인다 (패널은 즉시 그린다)
      res.clone().json().then(function (d) {
        var box = document.querySelector('#dcDeniedPanel .dc-denied-card');
        if (!box || !d || !d.message) return;
        if (box.querySelector('.dc-denied-reason')) return;
        var el = document.createElement('div');
        el.className = 'dc-denied-reason';
        el.textContent = '안내: ' + d.message;
        box.insertBefore(el, box.querySelector('.dc-denied-actions'));
      }).catch(function () {});
    }
    show(opts);
    return true;
  }

  global.DacheumAccess = { show: show, denied: denied };
})(window);
