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
      .tags { display:flex; flex-direction:column; gap:10px; margin-top:6px; }
      .std-card {
        border:1.5px solid #dbeafe; border-radius:12px;
        padding:10px 12px; background:#f8fafc;
        display:flex; flex-direction:column; gap:8px;
      }
      .std-card .hdr {
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
      }
      .std-card .code-main {
        background:#2563eb; color:#fff;
        padding:3px 8px; border-radius:8px;
        font-size:11px; font-weight:700; letter-spacing:.3px;
      }
      .std-card .content-text {
        flex:1; color:#374151; font-size:12px;
        line-height:1.4; min-width:0;
      }
      .std-card .remove-btn {
        background:none; border:none; cursor:pointer;
        color:#9ca3af; font-size:15px; padding:0 4px; line-height:1;
      }
      .std-card .remove-btn:hover { color:#ef4444; }
      .std-card .chain {
        display:flex; align-items:center; gap:6px; flex-wrap:wrap;
        padding:4px 0 2px; font-size:11px;
      }
      .std-card .chain-label {
        color:#6b7280; font-weight:700; font-size:10px;
        margin-right:2px;
      }
      .std-card .chain-seg {
        background:#e0e7ff; color:#4338ca;
        padding:2px 8px; border-radius:6px;
        font-size:10px; font-weight:600;
      }
      .std-card .chain-sep { color:#9ca3af; font-size:10px; }
      .std-card .leaf-list {
        display:flex; flex-direction:column; gap:4px;
        padding:6px 0 0;
        border-top:1px dashed #e5e7eb;
      }
      .std-card .leaf-hdr {
        font-size:10px; font-weight:700; color:#6b7280;
        padding-bottom:2px;
      }
      .std-card .leaf-row {
        display:flex; align-items:flex-start; gap:8px;
        padding:4px 6px; border-radius:6px;
        cursor:pointer; transition:background .1s;
      }
      .std-card .leaf-row:hover { background:#eff6ff; }
      .std-card .leaf-row input[type="checkbox"] {
        margin-top:3px; flex-shrink:0;
        width:14px; height:14px; cursor:pointer;
        accent-color:#3b82f6;
      }
      .std-card .leaf-row .leaf-id {
        background:#f3e8ff; color:#7c3aed;
        padding:1px 5px; border-radius:4px;
        font-size:9px; font-weight:700; flex-shrink:0;
      }
      .std-card .leaf-row .leaf-text {
        flex:1; color:#374151; font-size:11px; line-height:1.35;
      }
      .std-card .leaf-row.checked { background:#eff6ff; }
      .std-card .loading-chain { color:#9ca3af; font-size:11px; padding:4px 0; }
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
    //   _selected items: { code, label, chain[{id,depth,label}], leaves[{id,label,checked}] }
    get value() {
      const std_ids = [];
      this._selected.forEach(s => (s.leaves || []).forEach(l => { if (l.checked) std_ids.push(l.id); }));
      return {
        codes: this._selected.map(s => s.code),
        std_ids,
        items: this._selected.map(s => ({
          code: s.code,
          label: s.label,
          chain: (s.chain || []).slice(),
          leaves: (s.leaves || []).map(l => ({ ...l })),
        })),
      };
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

    async _select(code, std_id, label) {
      if (this.dataset.multiple === 'false') this._selected = [];
      else if (this._selected.some(s => s.code === code)) return;

      const item = { code, label, chain: [], leaves: [], _loading: true };
      this._selected.push(item);

      const input = this.shadowRoot.querySelector('.search-input');
      input.value = '';
      this.shadowRoot.querySelector('.dropdown').style.display = 'none';
      this._renderTags();

      // 비동기로 성취기준↔내용요소 트리 로드
      try {
        // 1) 성취기준에 매핑된 내용요소 노드들 (depth 2 leaf)
        const nodesRes = await fetch('/api/curriculum/standards/' + encodeURIComponent(code) + '/nodes').then(r => r.json()).catch(() => ({}));
        const leafNodes = (nodesRes && nodesRes.data) || [];

        // 2) 각 leaf의 조상 체인 병렬 조회
        const chains = await Promise.all(leafNodes.map(n =>
          fetch('/api/curriculum/content-nodes/' + encodeURIComponent(n.id) + '/ancestors')
            .then(r => r.json()).catch(() => ({ data: [] }))
        ));

        // 3) 공통 ancestors(depth 0,1) 추출 — 모든 leaf가 공유하는 조상
        const ancestorMap = new Map();
        chains.forEach(c => {
          (c.data || []).filter(a => a.depth < (leafNodes[0]?.depth ?? 2)).forEach(a => {
            if (!ancestorMap.has(a.id)) ancestorMap.set(a.id, a);
          });
        });
        item.chain = Array.from(ancestorMap.values()).sort((a, b) => a.depth - b.depth);
        item.leaves = leafNodes.map(n => ({ id: n.id, label: n.label, depth: n.depth, checked: true }));
      } catch (_) {
        // fallback: 최소한 std_id 하나라도
        if (std_id) item.leaves = [{ id: std_id, label: label, depth: 2, checked: true }];
      }
      item._loading = false;
      this._renderTags();
      this._emit();
    }

    _renderTags() {
      const tagsEl = this.shadowRoot.querySelector('.tags');
      if (!this._selected.length) { tagsEl.innerHTML = ''; return; }
      tagsEl.innerHTML = this._selected.map((s, i) => this._renderCard(s, i)).join('');

      tagsEl.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.i);
          this._selected.splice(i, 1);
          this._renderTags();
          this._emit();
        });
      });
      tagsEl.querySelectorAll('.leaf-row').forEach(row => {
        const i = parseInt(row.dataset.i);
        const j = parseInt(row.dataset.j);
        const cb = row.querySelector('input[type="checkbox"]');
        const toggle = () => {
          this._selected[i].leaves[j].checked = !this._selected[i].leaves[j].checked;
          cb.checked = this._selected[i].leaves[j].checked;
          row.classList.toggle('checked', cb.checked);
          this._emit();
        };
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return; // checkbox own click
          toggle();
        });
        cb.addEventListener('change', () => {
          this._selected[i].leaves[j].checked = cb.checked;
          row.classList.toggle('checked', cb.checked);
          this._emit();
        });
        row.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
        });
      });
    }

    _renderCard(s, i) {
      const chainHtml = s.chain && s.chain.length
        ? `<div class="chain"><span class="chain-label">내용요소</span>${
            s.chain.map((c, k) =>
              (k > 0 ? '<span class="chain-sep">›</span>' : '') +
              `<span class="chain-seg" title="depth ${c.depth} · ${this._esc(c.id)}">${k === 0 ? '1단계 ' : '2단계 '}${this._esc(c.label || c.id)}</span>`
            ).join('')
          }</div>`
        : (s._loading ? '<div class="loading-chain">내용요소 체인 로드 중...</div>' : '');

      const leavesHtml = s.leaves && s.leaves.length
        ? `<div class="leaf-list">
            <div class="leaf-hdr">3단계 내용요소 (세부 선택 · 클릭 또는 Space)</div>
            ${s.leaves.map((l, j) => `
              <div class="leaf-row ${l.checked ? 'checked' : ''}" data-i="${i}" data-j="${j}" tabindex="0" role="checkbox" aria-checked="${l.checked}">
                <input type="checkbox" ${l.checked ? 'checked' : ''} tabindex="-1">
                <span class="leaf-id">${this._esc(l.id)}</span>
                <span class="leaf-text">${this._esc(l.label || '')}</span>
              </div>
            `).join('')}
          </div>`
        : '';

      return `<div class="std-card">
        <div class="hdr">
          <span class="code-main">${this._esc(s.code)}</span>
          <span class="content-text">${this._esc((s.label || '').substring(0, 80))}</span>
          <button class="remove-btn" data-i="${i}" aria-label="제거">&times;</button>
        </div>
        ${chainHtml}
        ${leavesHtml}
      </div>`;
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
