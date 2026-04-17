/**
 * 다채움 통합 검색 오버레이
 * GNB 검색 아이콘 클릭 시 열리는 전체 화면 검색
 */
(function() {
  'use strict';

  const TABS = [
    { key: 'all', label: '전체', icon: 'fas fa-globe' },
    { key: 'lesson', label: '수업', icon: 'fas fa-chalkboard-teacher' },
    { key: 'content', label: '콘텐츠', icon: 'fas fa-book-open' },
    { key: 'homework', label: '과제', icon: 'fas fa-tasks' },
    { key: 'exam', label: '평가', icon: 'fas fa-file-alt' },
    { key: 'post', label: '게시물', icon: 'fas fa-comment-dots' }
  ];

  let overlay = null;
  let currentTab = 'all';
  let searchTimer = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'searchOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:none;align-items:flex-start;justify-content:center;padding-top:8vh;backdrop-filter:blur(4px);';
    overlay.onclick = function(e) { if (e.target === overlay) close(); };

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;width:90%;max-width:680px;max-height:80vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:searchSlideIn .25s ease;">
        <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
          <div style="display:flex;align-items:center;gap:12px;">
            <i class="fas fa-search" style="color:#9ca3af;font-size:18px;"></i>
            <input type="text" id="searchInput" placeholder="수업, 콘텐츠, 과제, 평가, 게시물 검색..." autocomplete="off"
              style="flex:1;border:none;outline:none;font-size:16px;font-family:inherit;color:#1f2937;">
            <kbd style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;padding:2px 8px;font-size:11px;color:#6b7280;">ESC</kbd>
          </div>
          <div id="searchTabs" style="display:flex;gap:4px;margin-top:12px;overflow-x:auto;"></div>
        </div>
        <div id="searchBody" style="padding:16px 24px;max-height:55vh;overflow-y:auto;">
          <div id="searchPreview" style="color:#9ca3af;font-size:13px;">
            <div style="font-weight:600;color:#374151;margin-bottom:8px;">🔍 검색 팁</div>
            <div style="margin-bottom:4px;">• 성취기준 코드 (예: 4수01-09)</div>
            <div style="margin-bottom:4px;">• 과목명 (예: 수학, 과학)</div>
            <div style="margin-bottom:4px;">• 키워드 (예: 분수, 식물, 독서)</div>
          </div>
          <div id="searchResults" style="display:none;"></div>
        </div>
      </div>
    `;

    // Style animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes searchSlideIn { from { opacity:0; transform:translateY(-20px); } to { opacity:1; transform:translateY(0); } }
      .search-tab { padding:6px 14px; border-radius:20px; border:1px solid #e5e7eb; background:#fff; color:#6b7280; font-size:12px; font-weight:500; cursor:pointer; transition:all .15s; font-family:inherit; white-space:nowrap; display:flex; align-items:center; gap:5px; }
      .search-tab:hover { background:#f3f4f6; }
      .search-tab.active { background:#2563eb; color:#fff; border-color:#2563eb; }
      .search-tab .cnt { background:rgba(0,0,0,0.1); padding:1px 6px; border-radius:10px; font-size:10px; }
      .search-tab.active .cnt { background:rgba(255,255,255,0.3); }
      .search-result-item { display:flex; align-items:flex-start; gap:12px; padding:12px; border-radius:10px; cursor:pointer; transition:background .15s; margin-bottom:4px; }
      .search-result-item:hover { background:#f3f4f6; }
      .search-result-icon { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:14px; }
      .search-result-title { font-size:14px; font-weight:600; color:#1f2937; margin-bottom:2px; }
      .search-result-meta { font-size:12px; color:#9ca3af; }
      .search-highlight { background:#fef08a; padding:0 2px; border-radius:2px; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlay);

    // Tabs
    const tabsEl = overlay.querySelector('#searchTabs');
    TABS.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'search-tab' + (t.key === currentTab ? ' active' : '');
      btn.innerHTML = `<i class="${t.icon}"></i> ${t.label} <span class="cnt" id="cnt_${t.key}">0</span>`;
      btn.onclick = () => { currentTab = t.key; tabsEl.querySelectorAll('.search-tab').forEach(b => b.classList.remove('active')); btn.classList.add('active'); doSearch(); };
      tabsEl.appendChild(btn);
    });

    // Input handler
    const input = overlay.querySelector('#searchInput');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 300);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    // Global ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') close();
    });
  }

  async function doSearch() {
    const input = overlay.querySelector('#searchInput');
    const q = input.value.trim();
    const preview = overlay.querySelector('#searchPreview');
    const results = overlay.querySelector('#searchResults');

    if (!q) {
      preview.style.display = 'block';
      results.style.display = 'none';
      TABS.forEach(t => { const c = document.getElementById('cnt_' + t.key); if (c) c.textContent = '0'; });
      return;
    }

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=all&limit=15`);
      const data = await res.json();
      if (!data.success) return;

      const r = data.results;
      // Update tab counts
      const counts = {
        all: data.total,
        lesson: (r.lessons || []).length,
        content: (r.contents || []).length,
        homework: (r.homework || []).length,
        exam: (r.exams || []).length,
        post: (r.posts || []).length
      };
      TABS.forEach(t => { const c = document.getElementById('cnt_' + t.key); if (c) c.textContent = counts[t.key] || 0; });

      // Build results
      let items = [];
      const typeConfig = {
        lesson: { color: '#dbeafe', textColor: '#2563eb', icon: 'fas fa-chalkboard-teacher', label: '수업' },
        content: { color: '#d1fae5', textColor: '#059669', icon: 'fas fa-book-open', label: '콘텐츠' },
        homework: { color: '#fef3c7', textColor: '#d97706', icon: 'fas fa-tasks', label: '과제' },
        exam: { color: '#ede9fe', textColor: '#7c3aed', icon: 'fas fa-file-alt', label: '평가' },
        post: { color: '#fce7f3', textColor: '#db2777', icon: 'fas fa-comment-dots', label: '게시물' }
      };

      if (currentTab === 'all' || currentTab === 'lesson') {
        (r.lessons || []).forEach(l => items.push({ type: 'lesson', title: l.title, meta: `${l.class_name} · ${l.author_name || ''} · ${l.lesson_date || ''}`, url: `/class/lesson-view.html?classId=${l.class_id}&id=${l.id}` }));
      }
      if (currentTab === 'all' || currentTab === 'content') {
        (r.contents || []).forEach(c => items.push({ type: 'content', title: c.title, meta: `${c.content_type} · ${c.subject || ''} · ${c.author_name || ''}`, url: `/content/index.html?id=${c.id}` }));
      }
      if (currentTab === 'all' || currentTab === 'homework') {
        (r.homework || []).forEach(h => items.push({ type: 'homework', title: h.title, meta: `${h.class_name} · 마감: ${h.due_date || '-'}`, url: `/class/class-home.html?classId=${h.class_id}&tab=homework` }));
      }
      if (currentTab === 'all' || currentTab === 'exam') {
        (r.exams || []).forEach(e => items.push({ type: 'exam', title: e.title, meta: `${e.class_name} · ${e.question_count || 0}문항`, url: `/class/exam-view.html?classId=${e.class_id}&id=${e.id}` }));
      }
      if (currentTab === 'all' || currentTab === 'post') {
        (r.posts || []).forEach(p => items.push({ type: 'post', title: p.title, meta: `${p.class_name} · ${p.author_name || ''} · ${p.category || ''}`, url: `/class/class-home.html?classId=${p.class_id}&tab=board` }));
      }

      if (items.length === 0) {
        results.innerHTML = '<div style="text-align:center;padding:32px;color:#9ca3af;"><i class="fas fa-search" style="font-size:24px;margin-bottom:8px;display:block;"></i>검색 결과가 없습니다</div>';
      } else {
        results.innerHTML = items.map(item => {
          const cfg = typeConfig[item.type];
          const highlighted = item.title.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<span class="search-highlight">$1</span>');
          return `<a href="${item.url}" class="search-result-item" style="text-decoration:none;color:inherit;">
            <div class="search-result-icon" style="background:${cfg.color};color:${cfg.textColor};"><i class="${cfg.icon}"></i></div>
            <div style="flex:1;min-width:0;">
              <div class="search-result-title">${highlighted}</div>
              <div class="search-result-meta"><span style="color:${cfg.textColor};font-weight:600;">${cfg.label}</span> · ${item.meta}</div>
            </div>
          </a>`;
        }).join('');
      }

      preview.style.display = 'none';
      results.style.display = 'block';

      // 최근 검색어 저장
      saveRecentSearch(q);
    } catch (err) {
      console.error('Search error:', err);
    }
  }

  function saveRecentSearch(q) {
    try {
      let recent = JSON.parse(localStorage.getItem('dacheum_recent_searches') || '[]');
      recent = recent.filter(r => r !== q);
      recent.unshift(q);
      if (recent.length > 10) recent = recent.slice(0, 10);
      localStorage.setItem('dacheum_recent_searches', JSON.stringify(recent));
    } catch {}
  }

  function open() {
    if (!overlay) createOverlay();
    overlay.style.display = 'flex';
    setTimeout(() => overlay.querySelector('#searchInput').focus(), 100);
  }

  function close() {
    if (overlay) overlay.style.display = 'none';
  }

  // Expose globally
  window.dacheumSearch = { open, close };

  // Ctrl+K 단축키
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      open();
    }
  });
})();
