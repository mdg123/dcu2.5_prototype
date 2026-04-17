/**
 * 다채움 공통 GNB - 네이버 스타일 2단 네비게이션
 * 1단: 로고 + 1차 메뉴(서비스 전환) + 사용자
 * 2단: 선택된 서비스의 2차 서브메뉴
 */
(function() {
  'use strict';

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
        { label: '나의 문제집', url: '/self-learn/problem-sets.html' },
        { label: '학습 배포 관리', url: '/admin/daily-learning.html', roles: ['admin'] },
        { label: '마음채움', url: '/self-learn/emotion-checkin.html', roles: ['student'] }
      ]
    },
    {
      id: 'growthRecord', label: '성장기록',
      defaultUrl: '/growth/class-dashboard.html',
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
        { label: '나도예술가', url: '/plus/gallery.html' }
      ]
    },
    {
      id: 'lrsAnalytics', label: 'LRS 학습분석',
      defaultUrl: '/lrs/index.html?menu=home',
      sub: [
        { label: '홈', url: '/lrs/index.html?menu=home', roles: ['teacher', 'admin'] },
        { label: '학습현황', url: '/lrs/index.html?menu=usage', roles: ['teacher', 'admin'] },
        { label: '학업성취', url: '/lrs/index.html?menu=achieve', roles: ['teacher', 'admin'] },
        { label: '학습수행', url: '/lrs/index.html?menu=perform', roles: ['teacher', 'admin'] },
        { label: '맞춤학습', url: '/lrs/index.html?menu=custom', roles: ['teacher', 'admin'] },
        { label: '교사활용지수', url: '/lrs/index.html?menu=teacher', roles: ['teacher', 'admin'] },
        { label: '일일현황', url: '/lrs/index.html?menu=daily', roles: ['teacher', 'admin'] }
      ]
    }
  ];

  let currentUser = null;

  async function loadUser() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data.success && data.user) { currentUser = data.user; return data.user; }
    } catch (e) {}
    window.location.href = '/login.html';
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
    const activeMenuId = detectActiveMenu();
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

    // 1차 메뉴
    const nav1 = document.createElement('nav');
    nav1.className = 'gnb-nav1';
    MENU.forEach(m => {
      if (!m.sub) return;
      const a = document.createElement('a');
      a.href = m.defaultUrl || '#';
      a.className = 'gnb-nav1-item';
      if (m.id === activeMenuId) a.classList.add('active');
      a.textContent = m.label;
      nav1.appendChild(a);
    });
    bar1.appendChild(nav1);

    // 사용자 영역
    const userArea = document.createElement('div');
    userArea.className = 'gnb-user';
    const roleBadge = { student: '학생', teacher: '교사', parent: '학부모', staff: '교직원', admin: '관리자' };
    userArea.innerHTML = `
      <button onclick="window.dacheumSearch && window.dacheumSearch.open()" class="gnb-icon-btn" title="통합 검색"><i class="fas fa-search"></i></button>
      <a href="/message/index.html" class="gnb-icon-btn" title="소통쪽지" style="position:relative;text-decoration:none;">
        <i class="fas fa-envelope"></i>
        <span id="gnbUnreadBadge" style="display:none;position:absolute;top:-4px;right:-6px;background:#EF4444;color:#fff;border-radius:50%;min-width:16px;height:16px;font-size:0.65rem;font-weight:700;line-height:16px;text-align:center;padding:0 3px;"></span>
      </a>
      <span class="gnb-user-role">${roleBadge[user.role] || user.role}</span>
      <span class="gnb-user-name">${user.display_name}</span>
      <button class="gnb-logout-btn" id="gnbLogoutBtn">로그아웃</button>
    `;
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

    // hash 변경 시 2차 메뉴 active 상태 갱신
    window.addEventListener('hashchange', () => {
      const newActiveSub = detectActiveSub(activeMenu);
      document.querySelectorAll('.gnb-nav2-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('href') === newActiveSub);
      });
    });

    // 2차 바 왼쪽 정렬: 1차 메뉴 첫 항목 위치에 맞춤
    requestAnimationFrame(() => {
      const firstNav1 = document.querySelector('.gnb-nav1-item');
      const bar2El = document.querySelector('.gnb-bar2');
      if (firstNav1 && bar2El) {
        const left = firstNav1.getBoundingClientRect().left;
        bar2El.style.paddingLeft = left + 'px';
      }
    });

    // body padding
    const hasBar2 = activeMenu && activeMenu.sub;
    document.body.style.paddingTop = hasBar2 ? '96px' : '52px';

    // 로그아웃
    document.getElementById('gnbLogoutBtn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });

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
    }
  }
})();
