/**
 * dacheum-search.js — 검색 인터페이스 공통 컴포넌트
 *
 * 위치: public/js/components/dacheum-search.js
 * CSS:  public/js/components/dacheum-search.css (자동 주입)
 * 문서: 작업지시서/검색_인터페이스_공통_컴포넌트_기획서.md
 *
 * Phase 1 — 채움콘텐츠 공개콘텐츠 페이지 전환 (회귀 0)
 *  - 마크업/스타일/동작 토큰은 기존 `renderPubSearchBar` + `renderPubAdvForm` 1:1 추출
 *  - 호스트 페이지의 글로벌 함수(searchPublic, togglePubAdvSearch, toggleTypeFilter ...) 와 호환되도록
 *    기존 DOM ID (`pubKeyword`, `pubSort`, `pubAdvForm`, `pafTitle` ...) 를 **그대로 유지**
 *  - 새로운 `.dcs-*` 클래스를 부착하면서, 기존 `.pub-*` 클래스도 함께 부여(별칭) — 호스트 CSS 동작 유지
 *
 * 사용:
 *   <div id="searchHost"></div>
 *   const search = DacheumSearch.mount(document.getElementById('searchHost'), {
 *     mode: 'content',
 *     sources: ['public'],
 *     typeFilters: ['video','document','image','quiz','exam','activity','package','recipe'],
 *     enableStdSearch: true,
 *     enableViewToggle: true,
 *     placeholder: '제목, 키워드, 저작자명으로 검색',
 *     // Phase 1: 호스트 글로벌 함수 위임 — 기존 동작 100% 재사용
 *     hooks: {
 *       onSearch: (p) => searchPublic(p),
 *       onToggleType: (t) => { toggleTypeFilter(t); },
 *       onAdvToggle: () => togglePubAdvSearch(),
 *       onAdvReset: () => resetPubAdvSearch(),
 *       onKeywordInput: () => updateSearchCheckboxes(),
 *       onMonthQuick: (v) => applyPafMonthQuick(v),
 *       onYearQuick: (v) => applyPafYearQuick(v),
 *       onViewModeChange: (m) => { viewMode = m; searchPublic(1); }
 *     },
 *     renderItem: (it) => renderContentCard(it),
 *     renderListRow: (it) => renderListRow(it),
 *   });
 *
 * 반환: { refresh, setQuery, getState, destroy }
 */
(function () {
  if (window.DacheumSearch) return; // 중복 로드 방지

  // ===== 외부 CSS 자동 주입 (common-nav.js 와 동일 패턴) =====
  (function ensureStyle() {
    const HREF = '/js/components/dacheum-search.css';
    if (document.querySelector(`link[href="${HREF}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = HREF;
    (document.head || document.documentElement).appendChild(link);
  })();

  // ===== 상수 — 8종 콘텐츠 타입 + 한국어 라벨 =====
  const CONTENT_TYPES_ALL = ['video', 'document', 'image', 'quiz', 'exam', 'activity', 'package', 'recipe'];
  const TYPE_NAMES_DEFAULT = {
    video: '영상', document: '문서', image: '이미지', link: '링크',
    quiz: '문항', exam: '평가지', assessment: '평가지',
    activity: '활동지', package: '수업꾸러미', bundle: '수업꾸러미', recipe: '수업레시피'
  };

  // 모드별 placeholder 기본값
  const DEFAULT_PLACEHOLDERS = {
    content:  '제목, 키워드, 저작자명으로 검색',
    question: '문항 제목·키워드·코드로 검색',
    exam:     '평가지명·키워드로 검색'
  };

  // 안전한 HTML 이스케이프
  function escHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ===== 컴포넌트 본체 =====
  function mount(rootEl, options) {
    if (!rootEl) throw new Error('[DacheumSearch] mount: rootEl is required');
    options = options || {};

    const opts = {
      mode: options.mode || 'content',
      sources: Array.isArray(options.sources) ? options.sources : ['public'],
      defaultSource: options.defaultSource || (options.sources && options.sources[0]) || 'public',
      placeholder: options.placeholder || DEFAULT_PLACEHOLDERS[options.mode] || DEFAULT_PLACEHOLDERS.content,
      showAdvanced: options.showAdvanced !== false,
      typeFilters: options.typeFilters || CONTENT_TYPES_ALL,
      typeFilterLabel: options.typeFilterLabel || '유형',
      typeNames: Object.assign({}, TYPE_NAMES_DEFAULT, options.typeNames || {}),
      sortOptions: options.sortOptions || [
        { value: 'latest',  label: '최신순' },
        { value: 'popular', label: '인기순' },
        { value: 'likes',   label: '좋아요순' }
      ],
      enableViewToggle: options.enableViewToggle !== false,
      enableStdSearch: options.enableStdSearch !== false,
      enableInfiniteScroll: options.enableInfiniteScroll !== false,
      stdMultiple: options.stdMultiple !== false,
      advancedFields: options.advancedFields || ['title', 'keyword', 'author', 'source', 'standard', 'dateRange'],
      enableDateRange: options.enableDateRange !== false,
      // Phase 1: 호스트 글로벌 함수 위임 훅 (없으면 컴포넌트가 자체 처리)
      hooks: options.hooks || {},
      // DOM ID 호환 모드 — true 이면 기존 ID(pubKeyword, pafTitle 등) 그대로 사용
      legacyIds: options.legacyIds !== false,
      // 렌더 위임
      renderItem: options.renderItem,
      renderListRow: options.renderListRow,
      // 콜백
      onSelect: options.onSelect,
      onResults: options.onResults,
      onError: options.onError,
      // 초기 상태
      initialTypeFilters: options.initialTypeFilters || null,
      initialViewMode: options.initialViewMode || 'card',
      initialKeyword: options.initialKeyword || ''
    };

    // 내부 상태
    const state = {
      source: opts.defaultSource,
      keyword: opts.initialKeyword,
      typeFilters: new Set(opts.initialTypeFilters || []),
      viewMode: opts.initialViewMode,
      advOpen: false
    };

    // ID 생성기 — legacy 호환을 위한 매핑
    const ID = opts.legacyIds ? {
      keyword: 'pubKeyword',
      sort: 'pubSort',
      adv: 'pubAdvForm',
      advBtn: 'pubAdvToggleBtn',
      advChevron: 'pubAdvToggleChevron',
      info: 'pubInfo',
      grid: 'pubGrid',
      loading: 'pubLoading',
      stdSmart: 'pubStdSmart',
      pafStdSmart: 'pafStdSmart',
      modeInfo: 'pubSearchModeInfo',
      pafTitle: 'pafTitle', pafKeyword: 'pafKeyword',
      pafAuthor: 'pafAuthor', pafSource: 'pafSource',
      pafFrom: 'pafFrom', pafTo: 'pafTo',
      pafMonthQuick: 'pafMonthQuick', pafYearQuick: 'pafYearQuick'
    } : (() => {
      // 비-legacy 모드: rootEl.id 또는 랜덤 접두사로 고유 ID
      const px = (rootEl.id || 'dcs') + '_' + Math.random().toString(36).slice(2, 8);
      return Object.fromEntries(
        ['keyword','sort','adv','advBtn','advChevron','info','grid','loading','stdSmart','pafStdSmart','modeInfo',
         'pafTitle','pafKeyword','pafAuthor','pafSource','pafFrom','pafTo','pafMonthQuick','pafYearQuick']
        .map(k => [k, `${px}_${k}`])
      );
    })();

    // ===== 템플릿 렌더 =====
    function buildTabsHtml() {
      if (!opts.sources || opts.sources.length <= 1) return '';
      const labels = { public: '공개콘텐츠', my: '나의 보관함', saved: '담은 자료' };
      return `
        <div class="dcs-tabs" role="tablist">
          ${opts.sources.map(s => `
            <button type="button" class="dcs-tab${s === state.source ? ' dcs-tab-active' : ''}" data-source="${escHtml(s)}" role="tab" aria-selected="${s === state.source}">${escHtml(labels[s] || s)}</button>
          `).join('')}
        </div>
      `;
    }

    function buildSearchRowHtml() {
      return `
        <div class="dcs-search-row pub-search-row">
          <div class="dcs-search-main pub-search-main">
            <div class="dcs-input-wrap pub-input-wrap">
              <i class="fas fa-search"></i>
              <input type="text" id="${ID.keyword}" placeholder="${escHtml(opts.placeholder)}" value="${escHtml(state.keyword)}">
            </div>
          </div>
          <button type="button" class="dcs-btn-search btn-pub-search"><i class="fas fa-search"></i> 검색</button>
          ${opts.showAdvanced ? `
            <button type="button" class="dcs-adv-toggle pub-adv-toggle" id="${ID.advBtn}">
              <i class="fas fa-sliders-h"></i> <span class="pub-adv-toggle-label dcs-adv-toggle-label">상세 검색</span>
              <i class="fas fa-chevron-down" id="${ID.advChevron}"></i>
            </button>
          ` : ''}
        </div>
      `;
    }

    function buildFilterRowHtml() {
      const hasChips = Array.isArray(opts.typeFilters) && opts.typeFilters.length > 0;
      const sortOptionsHtml = opts.sortOptions.map(o => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join('');
      const viewToggleHtml = opts.enableViewToggle ? `
        <div class="view-toggle pub-view-toggle dcs-view-toggle">
          <button type="button" class="view-btn dcs-view-btn${state.viewMode === 'card' ? ' active' : ''}" data-view="card" aria-label="카드 보기"><i class="fas fa-th-large"></i></button>
          <button type="button" class="view-btn dcs-view-btn${state.viewMode === 'list' ? ' active' : ''}" data-view="list" aria-label="리스트 보기"><i class="fas fa-list"></i></button>
        </div>
      ` : '';

      return `
        <div class="dcs-filter-row pub-filter-row">
          ${hasChips ? `<span class="dcs-filter-label pub-filter-label">${escHtml(opts.typeFilterLabel)}</span>` : ''}
          ${hasChips ? opts.typeFilters.map(t => `
            <label class="filter-check dcs-chip${state.typeFilters.has(t) ? ' active dcs-chip-active' : ''}" data-type="${escHtml(t)}">
              <input type="checkbox" ${state.typeFilters.has(t) ? 'checked' : ''}>
              ${escHtml(opts.typeNames[t] || t)}
            </label>
          `).join('') : ''}
          <div class="dcs-filter-spacer pub-filter-spacer"></div>
          <select id="${ID.sort}" class="dcs-sort-select pub-sort-select" aria-label="정렬 기준">${sortOptionsHtml}</select>
          ${viewToggleHtml}
        </div>
      `;
    }

    function buildAdvFormHtml() {
      if (!opts.showAdvanced) return '';
      const has = (f) => opts.advancedFields.includes(f);
      return `
        <div class="dcs-adv-form pub-adv-form" id="${ID.adv}" style="display:none;">
          <div class="paf-grid">
            ${has('title') ? `
              <div class="paf-row">
                <label for="${ID.pafTitle}">제목</label>
                <div class="paf-input-wrap"><input type="text" id="${ID.pafTitle}" placeholder="제목에 포함될 단어"></div>
              </div>` : ''}
            ${has('keyword') ? `
              <div class="paf-row">
                <label for="${ID.pafKeyword}">키워드</label>
                <div class="paf-input-wrap"><input type="text" id="${ID.pafKeyword}" placeholder="여러 키워드는 공백 또는 쉼표로 구분"></div>
              </div>` : ''}
            ${has('author') ? `
              <div class="paf-row">
                <label for="${ID.pafAuthor}">저작자</label>
                <div class="paf-input-wrap"><input type="text" id="${ID.pafAuthor}" placeholder="이름 또는 아이디"></div>
              </div>` : ''}
            ${has('source') ? `
              <div class="paf-row">
                <label for="${ID.pafSource}">출처</label>
                <div class="paf-input-wrap">
                  <select id="${ID.pafSource}" style="width:100%;padding:9px 12px;border:1px solid #E5E7EB;border-radius:8px;font-size:13px;background:#fff;outline:none;font-family:inherit;box-sizing:border-box;">
                    <option value="">전체</option>
                    <option value="미래교육추진단">미래교육추진단</option>
                    <option value="유초등교육과">유초등교육과</option>
                    <option value="중등교육과">중등교육과</option>
                    <option value="인성시민과">인성시민과</option>
                    <option value="체육건강안전과">체육건강안전과</option>
                    <option value="창의특수교육과">창의특수교육과</option>
                    <option value="출처없음">출처없음</option>
                    <option value="기타">기타</option>
                  </select>
                </div>
              </div>` : ''}
            ${has('standard') && opts.enableStdSearch ? `
              <div class="paf-row paf-row-full">
                <label>성취기준</label>
                <div class="paf-input-wrap">
                  <std-smart-search id="${ID.pafStdSmart}" data-multiple="${opts.stdMultiple ? 'true' : 'false'}" data-placeholder="성취기준 검색 (학년, 교과, 영역, 코드 등)"></std-smart-search>
                </div>
              </div>` : ''}
            ${has('dateRange') && opts.enableDateRange ? `
              <div class="paf-row paf-row-date paf-row-full">
                <label>등록 기간</label>
                <div class="paf-input-wrap">
                  <input type="date" id="${ID.pafFrom}">
                  <span class="paf-tilde">~</span>
                  <input type="date" id="${ID.pafTo}">
                  <select id="${ID.pafMonthQuick}" class="paf-quick-select" title="개월 빠른 선택" aria-label="개월 빠른 선택">
                    <option value="">개월</option>
                    <option value="1">1개월</option>
                    <option value="3">3개월</option>
                    <option value="6">6개월</option>
                    <option value="12">12개월</option>
                  </select>
                  <select id="${ID.pafYearQuick}" class="paf-quick-select" title="연도 빠른 선택" aria-label="연도 빠른 선택">
                    <option value="">연도</option>
                  </select>
                </div>
              </div>` : ''}
          </div>
          <div class="paf-actions">
            <button type="button" class="btn-paf-reset dcs-btn-reset"><i class="fas fa-rotate-left"></i> 초기화</button>
            <button type="button" class="btn-paf-search dcs-btn-adv-search"><i class="fas fa-search"></i> 조회</button>
          </div>
        </div>
      `;
    }

    function buildShellHtml() {
      // 호환을 위해 외곽은 호스트가 감싼다고 가정 (background:#fff 카드는 호스트에서 처리)
      // 컴포넌트는 검색 UI만 책임진다 (기획서 7번 참조: 검색 영역만, 결과 카드 영역은 호스트 자체 렌더)
      return `
        <div class="dacheum-search-root" data-mode="${escHtml(opts.mode)}">
          ${buildTabsHtml()}
          ${buildSearchRowHtml()}
          ${buildFilterRowHtml()}
          ${buildAdvFormHtml()}
        </div>
      `;
    }

    // ===== 이벤트 바인딩 =====
    function bindEvents() {
      const root = rootEl;

      // 키워드 입력
      const kwInput = root.querySelector('#' + ID.keyword);
      if (kwInput) {
        kwInput.addEventListener('input', () => {
          state.keyword = kwInput.value;
          if (opts.hooks.onKeywordInput) opts.hooks.onKeywordInput(state.keyword);
        });
        kwInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            triggerSearch(1);
          }
        });
      }

      // 메인 검색 버튼
      const btnSearch = root.querySelector('.dcs-btn-search');
      if (btnSearch) btnSearch.addEventListener('click', () => triggerSearch(1));

      // 상세 검색 토글
      const advBtn = root.querySelector('#' + ID.advBtn);
      if (advBtn) advBtn.addEventListener('click', () => {
        if (opts.hooks.onAdvToggle) {
          opts.hooks.onAdvToggle();
          // 호스트가 직접 DOM 상태(.style.display 등)를 토글하므로 우리는 추적만 한다.
          const form = root.querySelector('#' + ID.adv);
          state.advOpen = !!(form && form.style.display !== 'none');
        } else {
          internalAdvToggle();
        }
      });

      // 정렬 select
      const sortSel = root.querySelector('#' + ID.sort);
      if (sortSel) sortSel.addEventListener('change', () => triggerSearch(1));

      // 유형 칩 (체크박스 + 라벨)
      root.querySelectorAll('.dcs-chip').forEach(chip => {
        const t = chip.getAttribute('data-type');
        const cb = chip.querySelector('input[type="checkbox"]');
        const handler = (e) => {
          // 라벨 클릭이 체크박스 토글을 자동 발생시키므로 중복 호출 방지
          // change 이벤트 한 번만 신호로 사용
          if (e.type !== 'change') return;
          if (cb.checked) state.typeFilters.add(t);
          else state.typeFilters.delete(t);
          chip.classList.toggle('active', cb.checked);
          chip.classList.toggle('dcs-chip-active', cb.checked);
          if (opts.hooks.onToggleType) {
            opts.hooks.onToggleType(t, cb.checked, state.typeFilters);
          } else {
            triggerSearch(1);
          }
        };
        cb && cb.addEventListener('change', handler);
      });

      // 뷰 토글
      root.querySelectorAll('.dcs-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const v = btn.getAttribute('data-view');
          state.viewMode = v;
          root.querySelectorAll('.dcs-view-btn').forEach(b => {
            b.classList.toggle('active', b === btn);
          });
          if (opts.hooks.onViewModeChange) opts.hooks.onViewModeChange(v);
          else triggerSearch(1);
        });
      });

      // 탭
      root.querySelectorAll('.dcs-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const src = tab.getAttribute('data-source');
          state.source = src;
          root.querySelectorAll('.dcs-tab').forEach(t => {
            const active = t === tab;
            t.classList.toggle('dcs-tab-active', active);
            t.setAttribute('aria-selected', active ? 'true' : 'false');
          });
          if (opts.hooks.onSourceChange) opts.hooks.onSourceChange(src);
          else triggerSearch(1);
        });
      });

      // 상세 폼: 초기화 / 조회 / 빠른 선택 + Enter 키
      const advReset = root.querySelector('.dcs-btn-reset');
      if (advReset) advReset.addEventListener('click', () => {
        if (opts.hooks.onAdvReset) opts.hooks.onAdvReset();
        else internalAdvReset();
      });

      const advSearch = root.querySelector('.dcs-btn-adv-search');
      if (advSearch) advSearch.addEventListener('click', () => triggerSearch(1));

      // 상세 폼 텍스트 입력: Enter → 검색
      ['pafTitle','pafKeyword','pafAuthor','pafSource'].forEach(k => {
        const el = root.querySelector('#' + ID[k]);
        if (el) el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); triggerSearch(1); }
        });
      });

      // 날짜 picker change → 검색
      ['pafFrom','pafTo'].forEach(k => {
        const el = root.querySelector('#' + ID[k]);
        if (el) el.addEventListener('change', () => triggerSearch(1));
      });

      // 개월/연도 빠른 선택
      const monthSel = root.querySelector('#' + ID.pafMonthQuick);
      if (monthSel) monthSel.addEventListener('change', () => {
        if (opts.hooks.onMonthQuick) opts.hooks.onMonthQuick(monthSel.value);
      });
      const yearSel = root.querySelector('#' + ID.pafYearQuick);
      if (yearSel) yearSel.addEventListener('change', () => {
        if (opts.hooks.onYearQuick) opts.hooks.onYearQuick(yearSel.value);
      });
    }

    function triggerSearch(page) {
      if (opts.hooks.onSearch) {
        // 호스트 위임 모드: 호스트의 검색 함수를 호출. state 는 호스트 함수가 DOM 에서 직접 읽음.
        opts.hooks.onSearch(page || 1, getState());
      } else {
        // (Phase 2~ 자체 fetcher 사용 시 채워질 영역)
        if (typeof opts.fetcher === 'function') {
          opts.fetcher(getState()).then(res => {
            if (typeof opts.onResults === 'function') opts.onResults(res.items || [], res.total || 0);
          }).catch(err => {
            if (typeof opts.onError === 'function') opts.onError(err);
          });
        }
      }
    }

    function internalAdvToggle() {
      const form = rootEl.querySelector('#' + ID.adv);
      if (!form) return;
      const willOpen = form.style.display === 'none';
      form.style.display = willOpen ? 'block' : 'none';
      state.advOpen = willOpen;
      const btn = rootEl.querySelector('#' + ID.advBtn);
      const chev = rootEl.querySelector('#' + ID.advChevron);
      if (btn) btn.classList.toggle('active', willOpen);
      if (chev) {
        chev.classList.remove('fa-chevron-down', 'fa-chevron-up');
        chev.classList.add(willOpen ? 'fa-chevron-up' : 'fa-chevron-down');
      }
    }
    function internalAdvReset() {
      ['pafTitle','pafKeyword','pafAuthor','pafSource'].forEach(k => {
        const el = rootEl.querySelector('#' + ID[k]); if (el) el.value = '';
      });
      ['pafFrom','pafTo','pafMonthQuick','pafYearQuick'].forEach(k => {
        const el = rootEl.querySelector('#' + ID[k]); if (el) el.value = '';
      });
      triggerSearch(1);
    }

    function getState() {
      const kwInput = rootEl.querySelector('#' + ID.keyword);
      const sortSel = rootEl.querySelector('#' + ID.sort);
      return {
        source: state.source,
        keyword: kwInput ? kwInput.value : state.keyword,
        sort: sortSel ? sortSel.value : 'latest',
        typeFilters: Array.from(state.typeFilters),
        viewMode: state.viewMode,
        advOpen: state.advOpen
      };
    }

    // ===== 마운트 =====
    rootEl.innerHTML = buildShellHtml();
    bindEvents();

    // 컨트롤러 반환
    return {
      refresh: (page) => triggerSearch(page || 1),
      setQuery: (q) => {
        const el = rootEl.querySelector('#' + ID.keyword);
        if (el) { el.value = q; state.keyword = q; }
      },
      setSource: (s) => {
        state.source = s;
        rootEl.querySelectorAll('.dcs-tab').forEach(t => {
          const active = t.getAttribute('data-source') === s;
          t.classList.toggle('dcs-tab-active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      },
      getState,
      getSelectedFilters: () => ({
        types: Array.from(state.typeFilters),
        viewMode: state.viewMode,
        source: state.source,
        advOpen: state.advOpen
      }),
      destroy: () => { rootEl.innerHTML = ''; }
    };
  }

  // 공개 API
  window.DacheumSearch = {
    mount,
    version: '0.1.0',
    CONTENT_TYPES: CONTENT_TYPES_ALL,
    TYPE_NAMES: TYPE_NAMES_DEFAULT
  };
})();
