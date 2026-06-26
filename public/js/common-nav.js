/**
 * 다채움 공통 GNB - 네이버 스타일 2단 네비게이션
 * 1단: 로고 + 1차 메뉴(서비스 전환) + 사용자
 * 2단: 선택된 서비스의 2차 서브메뉴
 */
(function() {
  'use strict';

  // === 교육과정 표준체계 Web Components 자동 로드 ===
  // 어느 페이지든 common-nav.js를 포함하면 <std-smart-search>, <std-picker>를 사용할 수 있다.
  (function loadStdComponents() {
    const files = [
      '/js/components/std-smart-search.js',
      '/js/components/std-picker.js',
      // 검색 인터페이스 공통 컴포넌트 (window.DacheumSearch) — Phase 1
      '/js/components/dacheum-search.js'
    ];
    files.forEach(src => {
      if (document.querySelector('script[src="' + src + '"]')) return;
      const s = document.createElement('script');
      s.src = src; s.defer = true;
      document.head.appendChild(s);
    });
  })();

  // === 공통 타이포그래피 — 11px 이하 글자를 12-13px로 끌어올려 가독성 향상 ===
  (function injectCommonTypography() {
    if (document.getElementById('dacheim-common-typography')) return;
    const style = document.createElement('style');
    style.id = 'dacheim-common-typography';
    style.textContent = `
      /* CLAUDE.md 공통 UI 스케일 정렬 — 메타 보조/시간 13px, 뱃지 13px */
      .text-xs { font-size: 13px; }
      .badge:not(.badge-fixed) { font-size: 13px; }
      .type-badge:not(.type-badge-fixed) { font-size: 13px; }
      .card-meta, .card-meta .card-date, .list-row-meta { font-size: 13px; }
      .sidebar-title, .filter-label, .section-label { font-size: 14px; }
      .folder-count, .stat-card-label, .stat-card-change { font-size: 13px; }
      .status-btn, .period-btn, .metric-btn, .bundle-type-btn { font-size: 14px; }
      .link-sm, .keyword-tag, .dismiss-btn { font-size: 13px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  })();

  const MENU = [
    {
      id: 'chaeumClass', label: '채움클래스',
      defaultUrl: '/class/index.html',
      sub: [
        { label: '나의 클래스', url: '/class/index.html' },
        { label: '클래스 관리', url: '/class/manage.html' },
        { label: '클래스 찾기', url: '/class/find.html' },
        { label: '클래스별 학습분석', url: '/class/analytics.html' },
        { label: '명예의 전당', url: '/class/hall-of-fame.html' }
      ]
    },
    {
      id: 'chaeumContents', label: '채움콘텐츠',
      defaultUrl: '/content/index.html#public',
      sub: [
        { label: '공개콘텐츠', url: '/content/index.html#public' },
        { label: '추천콘텐츠', url: '/content/index.html#recommend' },
        { label: '대시보드', url: '/content/index.html#dashboard' },
        { label: '내자료', url: '/content/index.html#mydata' },
        { label: '내 채널 관리', url: '/content/index.html#mychannel' },
        { label: '구독 채널', url: '/content/index.html#subscriptions' },
        { label: '승인관리', url: '/content/index.html#approval', roles: ['admin'] }
      ]
    },
    {
      id: 'selfChaeum', label: '스스로채움',
      defaultUrl: '/self-learn/today.html',
      sub: [
        { label: '오늘의 학습', url: '/self-learn/today.html' },
        { label: 'AI 맞춤학습', url: '/self-learn/learning-map.html' },
        { label: '오답노트', url: '/self-learn/wrong-note.html' },
        { label: '내 문제집', url: '/self-learn/problem-sets.html' },
        { label: '학습 배포 관리', url: '/admin/daily-learning.html', roles: ['admin'] },
        { label: '마음채움', url: '/self-learn/emotion-checkin.html', roles: ['student'] }
      ]
    },
    {
      id: 'growthRecord', label: '성장기록',
      defaultUrl: '/growth/class-dashboard.html',
      // 학생은 학급 대시보드 접근 불가 → 성장 리포트로 진입
      defaultUrlByRole: { student: '/growth/student-report.html' },
      sub: [
        { label: '마음채움', url: '/growth/emotion-monitor.html', roles: ['teacher', 'admin'] },
        { label: '학습분석', url: '/growth/class-dashboard.html', roles: ['teacher', 'admin'] },
        { label: '성장 리포트', url: '/growth/student-report.html' },
        { label: '포트폴리오', url: '/growth/portfolio.html' }
      ]
    },
    {
      id: 'chaeumCBT', label: '채움CBT',
      defaultUrl: '/cbt/index.html',
      sub: [
        { label: '전체 평가', url: '/cbt/index.html' },
        { label: '내 평가 결과', url: '/cbt/index.html#my-results' },
        { label: '내 평가 관리', url: '/cbt/index.html#my-exams', roles: ['teacher', 'admin'] }
      ]
    },
    {
      id: 'chaeumPlus', label: '채움성장',
      defaultUrl: '/plus/gallery.html',
      sub: [
        { label: '나도예술가', url: '/plus/gallery.html' },
        { label: '🏆 콘테스트', url: '/plus/contests.html' }
      ]
    },
    {
      id: 'lrsAnalytics', label: 'LRS 학습분석',
      defaultUrl: '/lrs/index.html?menu=home',
      // 교장·교감(principal)은 LRS 학생/교사용 하위가 의미 없어 학교 관리자 대시보드로 진입
      defaultUrlByRole: { principal: '/school/' },
      sub: [
        { label: '🏫 학교 관리자 대시보드', url: '/school/', roles: ['principal'] },
        { label: '🏠 홈',        url: '/lrs/index.html?menu=home',       roles: ['student','teacher','admin'] },
        { label: '현황 분석',    url: '/lrs/index.html?menu=analytics',  roles: ['student','teacher','admin'] },
        { label: '학습 활동',    url: '/lrs/index.html?menu=activities', roles: ['student','teacher'] },
        { label: '운영',         url: '/lrs/index.html?menu=operations', roles: ['teacher','admin'] },
        { label: '리포트',       url: '/lrs/index.html?menu=reports',    roles: ['admin'] }
      ]
    }
  ];

  let currentUser = null;

  // 비로그인 진입이 허용된 페이지(포털 메인 등) — 로그인 페이지로 강제 리다이렉트하지 않는다
  function isPublicPage() {
    const p = location.pathname;
    return p === '/' || p === '/index.html';
  }

  async function loadUser() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data.success && data.user) { currentUser = data.user; return data.user; }
    } catch (e) {}
    // 공개 페이지는 비로그인 상태로 통과 — null 반환 시 게스트 GNB 렌더
    if (isPublicPage()) return null;
    // 보호 페이지는 기존 동작 유지 — 로그인 페이지로 이동
    window.location.href = '/login.html?redirect=' + encodeURIComponent(location.pathname + location.search);
    return null;
  }

  function detectActiveMenu() {
    const path = location.pathname;
    for (const item of MENU) {
      if (!item.sub) continue;
      for (const sub of item.sub) {
        if (sub.divider) continue;
        const subPath = sub.url.split('#')[0].split('?')[0];
        if (path === subPath || path.startsWith(subPath.replace('/index.html', '/').replace('.html', ''))) {
          return item.id;
        }
      }
    }
    return null;
  }

  function detectActiveSub(menu) {
    if (!menu || !menu.sub) return null;
    const full = location.pathname + location.search + (location.hash.split('?')[0] || '');
    // menu= 파라미터 기반 매칭 (LRS 등 ?menu=xxx 패턴 우선)
    try {
      const curMenu = new URL(location.href).searchParams.get('menu');
      if (curMenu){
        for (const sub of menu.sub){
          if (sub.divider) continue;
          const subMenu = new URL(sub.url, location.origin).searchParams.get('menu');
          if (subMenu && subMenu === curMenu) return sub.url;
        }
      }
    } catch(_){}
    for (const sub of menu.sub) {
      if (sub.divider) continue;
      if (full === sub.url) return sub.url;
    }
    // fallback: pathname+search로 매칭
    const pathSearch = location.pathname + location.search;
    for (const sub of menu.sub) {
      if (sub.divider) continue;
      if (pathSearch === sub.url) return sub.url;
    }
    // fallback: pathname만으로 매칭
    for (const sub of menu.sub) {
      if (sub.divider) continue;
      const subPath = sub.url.split('#')[0].split('?')[0];
      if (location.pathname === subPath) return sub.url;
    }
    return null;
  }

  function buildGNB(user) {
    const isGuest = !user;
    const activeMenuId = isGuest ? null : detectActiveMenu();
    const activeMenu = MENU.find(m => m.id === activeMenuId);
    const activeSubUrl = detectActiveSub(activeMenu);

    const wrapper = document.createElement('div');
    wrapper.id = 'dacheum-gnb-wrapper';

    // ══════ 1단 바: 로고 + 1차 메뉴 + 사용자 ══════
    const bar1 = document.createElement('div');
    bar1.className = 'gnb-bar1';

    // 로고
    const logo = document.createElement('a');
    logo.href = '/index.html';
    logo.className = 'gnb-logo';
    logo.innerHTML = '<span class="gnb-logo-icon">📚</span><span class="gnb-logo-text">다채움</span>';
    bar1.appendChild(logo);

    // 1차 메뉴 — 비로그인은 클릭 시 login redirect (서버 측 requireAuth가 자체 처리)
    const nav1 = document.createElement('nav');
    nav1.className = 'gnb-nav1';
    MENU.forEach(m => {
      if (!m.sub) return;
      const a = document.createElement('a');
      const roleUrl = (!isGuest && m.defaultUrlByRole && m.defaultUrlByRole[user.role]);
      a.href = roleUrl || m.defaultUrl || '#';
      a.className = 'gnb-nav1-item';
      if (m.id === activeMenuId) a.classList.add('active');
      a.textContent = m.label;
      nav1.appendChild(a);
    });
    bar1.appendChild(nav1);

    // 사용자 영역
    const userArea = document.createElement('div');
    userArea.className = 'gnb-user';
    const roleBadge = { student: '학생', teacher: '교사', parent: '학부모', staff: '교직원', admin: '관리자', principal: '교장·교감' };
    if (isGuest) {
      // 비로그인: 로그인 / 회원가입 버튼만 노출
      const redirectQs = '?redirect=' + encodeURIComponent(location.pathname + location.search);
      userArea.innerHTML = `
        <a href="/login.html${redirectQs}" class="gnb-login-btn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 18px;background:#4A7CFF;color:#fff;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;"><i class="fas fa-sign-in-alt"></i> 로그인</a>
        <a href="/login.html#signup" class="gnb-register-btn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 18px;background:#fff;color:#4A7CFF;border:1px solid #4A7CFF;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;"><i class="fas fa-user-plus"></i> 회원가입</a>
      `;
    } else {
      userArea.innerHTML = `
        <button onclick="window.dacheumSearch && window.dacheumSearch.open()" class="gnb-icon-btn" title="통합 검색"><i class="fas fa-search"></i></button>
        <a href="/message/index.html" class="gnb-icon-btn" title="소통쪽지" style="position:relative;text-decoration:none;">
          <i class="fas fa-envelope"></i>
          <span id="gnbUnreadBadge" style="display:none;position:absolute;top:-4px;right:-6px;background:#EF4444;color:#fff;border-radius:10px;min-width:18px;height:18px;font-size:13px;font-weight:700;line-height:18px;text-align:center;padding:0 5px;"></span>
        </a>
        ${user.role === 'admin' ? `<a href="/admin/index.html" class="gnb-admin-btn" title="관리자 페이지" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#4F46E5;color:#fff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;margin-right:4px;"><i class="fas fa-cog"></i> 관리자 페이지</a>` : ''}
        ${user.role === 'principal' ? `<a href="/school/" class="gnb-admin-btn gnb-school-btn" title="학교 관리자 대시보드" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#0EA5E9;color:#fff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;margin-right:4px;"><i class="fas fa-school"></i> 학교 관리자</a>` : ''}
        <span class="gnb-user-role">${roleBadge[user.role] || user.role}</span>
        <span class="gnb-user-name">${user.display_name}</span>
        <button class="gnb-logout-btn" id="gnbLogoutBtn">로그아웃</button>
      `;
    }
    bar1.appendChild(userArea);
    wrapper.appendChild(bar1);

    // ══════ 2단 바: 2차 서브메뉴 ══════
    if (activeMenu && activeMenu.sub) {
      const bar2 = document.createElement('div');
      bar2.className = 'gnb-bar2';

      const nav2 = document.createElement('nav');
      nav2.className = 'gnb-nav2';

      activeMenu.sub.forEach(sub => {
        if (sub.roles && !sub.roles.includes(user.role)) return;
        const a = document.createElement('a');
        a.href = sub.url;
        a.className = 'gnb-nav2-item';
        if (sub.url === activeSubUrl) a.classList.add('active');
        a.textContent = sub.label;
        nav2.appendChild(a);
      });

      bar2.appendChild(nav2);
      wrapper.appendChild(bar2);
    }

    document.body.prepend(wrapper);

    // hash 변경 또는 ?menu= 변경 시 2차 메뉴 active 상태 갱신
    function refreshNav2Active(){
      const newActiveSub = detectActiveSub(activeMenu);
      document.querySelectorAll('.gnb-nav2-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('href') === newActiveSub);
      });
    }
    window.addEventListener('hashchange', refreshNav2Active);
    window.addEventListener('popstate', refreshNav2Active);
    // LRS 내부 setView가 history.replaceState로 URL을 갱신할 때 호출
    window.addEventListener('dacheum:menu-changed', refreshNav2Active);

    // 2차 바 왼쪽 정렬: 1차 메뉴 첫 항목 위치에 맞춤
    requestAnimationFrame(() => {
      const firstNav1 = document.querySelector('.gnb-nav1-item');
      const bar2El = document.querySelector('.gnb-bar2');
      if (firstNav1 && bar2El) {
        const left = firstNav1.getBoundingClientRect().left;
        bar2El.style.paddingLeft = left + 'px';
      }
    });

    // body padding — dacheum-common.css의 글로벌 `body { padding-top: var(--gnb-h) !important }` 규칙과 정합화.
    //   GNB 1단만(52) vs 2단까지(96) 페이지마다 다르므로 --gnb-h 토큰 자체를 동적 설정한다.
    const hasBar2 = activeMenu && activeMenu.sub;
    document.documentElement.style.setProperty('--gnb-h', hasBar2 ? '96px' : '52px');
    // 폴백: dacheum-common.css 미로드 환경에서도 동작하도록 inline padding도 함께 설정
    document.body.style.paddingTop = hasBar2 ? '96px' : '52px';

    // 로그아웃 (로그인 상태일 때만)
    const logoutBtn = document.getElementById('gnbLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login.html';
      });
    }

    // 통합 검색
    const s = document.createElement('script');
    s.src = '/js/search-overlay.js';
    document.body.appendChild(s);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  async function loadUnreadCount() {
    try {
      const res = await fetch('/api/message/unread-count');
      const data = await res.json();
      const badge = document.getElementById('gnbUnreadBadge');
      if (badge && data.success && data.count > 0) {
        badge.textContent = data.count > 99 ? '99+' : data.count;
        badge.style.display = 'block';
      } else if (badge) badge.style.display = 'none';
    } catch (e) {}
  }

  async function init() {
    const user = await loadUser();
    if (user) {
      buildGNB(user);
      loadUnreadCount();
      setInterval(loadUnreadCount, 60000);
      window.dacheumUser = user;
      // 학생 전용 메뉴 숨김 (교사/관리자)
      if (user.role === 'teacher' || user.role === 'admin') {
        document.querySelectorAll('.student-only-menu').forEach(el => el.style.display = 'none');
      }
      window.dispatchEvent(new CustomEvent('dacheim:user-loaded', { detail: user }));
    } else if (isPublicPage()) {
      // 비로그인 + 공개 페이지: 게스트 GNB 렌더 + 게스트 이벤트 디스패치
      buildGNB(null);
      window.dacheumUser = null;
      window.dispatchEvent(new CustomEvent('dacheim:user-loaded', { detail: null }));
    }
  }
})();
