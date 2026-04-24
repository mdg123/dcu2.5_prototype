/**
 * <std-smart-search>
 * 교육과정 성취기준 스마트검색 Web Component
 *
 * 사용:
 *   <std-smart-search data-value="[4국01-01],[4국01-02]"></std-smart-search>
 *   el.addEventListener('change', e => console.log(e.detail));
 *   // e.detail = { codes: ['[4국01-01]', ...], std_ids: ['E4KORA01B01C01', ...], items: [{code, std_id, label}] }
 *
 * 속성:
 *   data-placeholder : 검색 입력 placeholder
 *   data-value       : 초기 선택 값 (쉼표구분 코드 목록)
 *   data-multiple    : "false" 면 단일선택 (기본: 다중)
 *   data-subject     : subject_code로 검색 범위 제한 (옵션)
 */
(function () {
  if (window.customElements && customElements.get('std-smart-search')) return;

  const TPL = document.createElement('template');
  TPL.innerHTML = `
    <style>
      :host { display:block; font-family:inherit; position:relative; }
      .wrap { position:relative; }
      .search-input {
        width:100%; box-sizing:border-box;
        padding:10px 14px 10px 36px;
        border:2px solid #dbeafe; border-radius:10px;
        font-size:13px; outline:none;
        background:#eff6ff;
        font-family:inherit;
      }
      .search-input:focus { border-color:#3b82f6; }
      .icon {
        position:absolute; left:12px; top:12px;
        color:#3b82f6; font-size:13px; pointer-events:none;
        line-height:1;
      }
      .dropdown {
        display:none;
        position:absolute; top:100%; left:0; right:0;
        max-height:260px; overflow-y:auto;
        background:#fff; border:1px solid #e5e7eb; border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,.12);
        z-index:100; margin-top:4px;
      }
      .dd-item {
        padding:10px 14px; cursor:pointer;
        border-bottom:1px solid #f3f4f6;
        font-size:13px; display:flex; gap:8px; align-items:flex-start;
      }
      .dd-item:hover, .dd-item.active { background:#f0f4ff; }
      .code-chip {
        background:#eff6ff; color:#2563eb;
        padding:1px 6px; border-radius:4px;
        font-size:11px; font-weight:700; flex-shrink:0;
      }
      .std-id-chip {
        background:#f3e8ff; color:#7c3aed;
        padding:1px 6px; border-radius:4px;
        font-size:10px; font-weight:600; flex-shrink:0;
      }
      .content-text { color:#374151; line-height:1.35; flex:1; }
      .tags {
        display:flex; flex-wrap:wrap; gap:4px;
        margin-top:6px;
      }
      .tag {
        display:inline-flex; align-items:center; gap:4px;
        background:#eff6ff; color:#2563eb;
        padding:3px 10px; border-radius:12px;
        font-size:11px; font-weight:600;
      }
      .tag button {
        background:none; border:none; cursor:pointer;
        color:#93c5fd; font-size:13px; padding:0; line-height:1;
      }
      .tag button:hover { color:#ef4444; }
      .empty {
        padding:16px; text-align:center;
        color:#9ca3af; font-size:12px;
      }
      .loading { padding:12px; text-align:center; color:#9ca3af; font-size:12px; }
    </style>
    <div class="wrap">
      <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
      <input class="search-input" type="text" autocomplete="off" />
      <div class="dropdown" role="listbox"></div>
    </div>
    <div class="tags"></div>
  `;

  class StdSmartSearch extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.appendChild(TPL.content.cloneNode(true));
      this._selected = []; // [{code, std_id, label}]
      this._activeIdx = -1;
      this._debounce = null;
    }

    connectedCallback() {
      const input = this.shadowRoot.querySelector('.search-input');
      const dd = this.shadowRoot.querySelector('.dropdown');
      input.placeholder = this.dataset.placeholder || '성취기준 검색 (학년, 교과, 영역, 코드 등)';

      input.addEventListener('input', () => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this._search(input.value.trim()), 180);
      });
      input.addEventListener('focus', () => {
        if (input.value.trim()) this._search(input.value.trim());
      });
      input.addEventListener('blur', () => {
        setTimeout(() => { dd.style.display = 'none'; }, 200);
      });
      input.addEventListener('keydown', (e) => this._onKey(e));

      // 초기값
      if (this.dataset.value) {
        this._loadInitial(this.dataset.value.split(',').map(s => s.trim()).filter(Boolean));
      }
    }

    // ===== public API =====
    get value() {
      return {
        codes: this._selected.map(s => s.code),
        std_ids: this._selected.filter(s => s.std_id).map(s => s.std_id),
        items: this._selected.slice(),
      };
    }
    set value(arr) {
      if (!Array.isArray(arr)) return;
      this._selected = arr.slice();
      this._renderTags();
      this._emit();
    }
    clear() {
      this._selected = [];
      this._renderTags();
      this._emit();
    }

    // ===== internal =====
    async _search(query) {
      const dd = this.shadowRoot.querySelector('.dropdown');
      if (!query || query.length < 1) { dd.style.display = 'none'; return; }
      this._activeIdx = -1;
      dd.style.display = 'block';
      dd.innerHTML = '<div class="loading">검색 중...</div>';
      try {
        const params = new URLSearchParams({ search: query, limit: '12' });
        if (this.dataset.subject) params.set('subject_code', this.dataset.subject);
        const res = await fetch('/api/curriculum/standards?' + params.toString()).then(r => r.json());
        const stds = (res && res.data) || [];
        if (!stds.length) {
          dd.innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
          return;
        }
        // std_id 동시 조회 (batch)
        const codeParams = stds.map(s => `code=${encodeURIComponent(s.code)}`).join('&');
        let stdIdByCode = {};
        try {
          // std-id-map는 code/std_id 단일만 지원 → 병렬 호출
          const idRes = await Promise.all(stds.map(s =>
            fetch('/api/curriculum/std-id-map?code=' + encodeURIComponent(s.code))
              .then(r => r.json()).catch(() => ({ data: [] }))
          ));
          idRes.forEach((r, i) => {
            const m = (r.data || [])[0];
            if (m) stdIdByCode[stds[i].code] = m.std_id;
          });
        } catch (_) {}

        dd.innerHTML = stds.map((s, i) => {
          const stdId = stdIdByCode[s.code] || '';
          const label = (s.subject_name || '') + ' ' + (s.content || '').substring(0, 60);
          return `<div class="dd-item" data-i="${i}" data-code="${this._esc(s.code)}" data-std-id="${this._esc(stdId)}" data-label="${this._esc(label)}">
            <span class="code-chip">${this._esc(s.code)}</span>
            ${stdId ? `<span class="std-id-chip">${this._esc(stdId)}</span>` : ''}
            <span class="content-text">${this._esc((s.content || '').substring(0, 80))}</span>
          </div>`;
        }).join('');
        dd.querySelectorAll('.dd-item').forEach(el => {
          el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this._select(el.dataset.code, el.dataset.stdId, el.dataset.label);
          });
          el.addEventListener('mouseover', () => {
            this._activeIdx = parseInt(el.dataset.i);
            this._highlight();
          });
        });
      } catch (err) {
        dd.innerHTML = '<div class="empty">검색 오류</div>';
      }
    }

    async _loadInitial(codes) {
      const items = [];
      for (const code of codes) {
        try {
          const [stdRes, mapRes] = await Promise.all([
            fetch('/api/curriculum/standards/' + encodeURIComponent(code)).then(r => r.json()).catch(() => ({})),
            fetch('/api/curriculum/std-id-map?code=' + encodeURIComponent(code)).then(r => r.json()).catch(() => ({})),
          ]);
          const s = stdRes && stdRes.data;
          const m = mapRes && (mapRes.data || [])[0];
          items.push({
            code,
            std_id: m ? m.std_id : '',
            label: s ? ((s.subject_name || '') + ' ' + (s.content || '').substring(0, 40)) : code,
          });
        } catch (_) {
          items.push({ code, std_id: '', label: code });
        }
      }
      this._selected = items;
      this._renderTags();
      this._emit();
    }

    _onKey(e) {
      const dd = this.shadowRoot.querySelector('.dropdown');
      if (dd.style.display === 'none') return;
      const items = dd.querySelectorAll('.dd-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._activeIdx = Math.min(this._activeIdx + 1, items.length - 1);
        this._highlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._activeIdx = Math.max(this._activeIdx - 1, 0);
        this._highlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this._activeIdx >= 0 && items[this._activeIdx]) {
          const el = items[this._activeIdx];
          this._select(el.dataset.code, el.dataset.stdId, el.dataset.label);
        }
      } else if (e.key === 'Escape') {
        dd.style.display = 'none';
      }
    }

    _highlight() {
      const items = this.shadowRoot.querySelectorAll('.dd-item');
      items.forEach((el, i) => el.classList.toggle('active', i === this._activeIdx));
      if (this._activeIdx >= 0 && items[this._activeIdx]) {
        items[this._activeIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    _select(code, std_id, label) {
      if (this.dataset.multiple === 'false') {
        this._selected = [{ code, std_id, label }];
      } else {
        if (this._selected.some(s => s.code === code)) return;
        this._selected.push({ code, std_id, label });
      }
      const input = this.shadowRoot.querySelector('.search-input');
      input.value = '';
      this.shadowRoot.querySelector('.dropdown').style.display = 'none';
      this._renderTags();
      this._emit();
    }

    _renderTags() {
      const tagsEl = this.shadowRoot.querySelector('.tags');
      if (!this._selected.length) { tagsEl.innerHTML = ''; return; }
      tagsEl.innerHTML = this._selected.map((s, i) => `
        <span class="tag" title="${this._esc(s.label || '')}">
          ${this._esc(s.code)}${s.std_id ? ` · ${this._esc(s.std_id)}` : ''}
          <button data-i="${i}" aria-label="제거">&times;</button>
        </span>
      `).join('');
      tagsEl.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.i);
          this._selected.splice(i, 1);
          this._renderTags();
          this._emit();
        });
      });
    }

    _emit() {
      this.dispatchEvent(new CustomEvent('change', {
        bubbles: true,
        composed: true,
        detail: this.value,
      }));
    }

    _esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
  }

  customElements.define('std-smart-search', StdSmartSearch);
})();
