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
        height:42px;
        padding:10px 14px 10px 36px;
        border:2px solid #dbeafe; border-radius:10px;
        font-size:15px; line-height:1.4; outline:none;
        background:#fff;
        font-family:inherit;
      }
      .search-input::placeholder { font-size:15px; color:#9ca3af; }
      .search-input:focus { border-color:#3b82f6; background:#fff; }
      .icon {
        position:absolute; left:12px; top:12px;
        color:#3b82f6; font-size:13px; pointer-events:none;
        line-height:1;
      }
      .dropdown {
        display:none;
        position:fixed;
        max-height:320px; overflow-y:auto;
        background:#fff; border:1px solid #e5e7eb; border-radius:10px;
        box-shadow:0 12px 32px rgba(0,0,0,.18);
        z-index:21000;
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
      /* 본문(leaf) + 오른쪽 사이드 팝업 레이아웃 */
      .std-card .body-row {
        display:flex; flex-direction:row; gap:10px; align-items:flex-start;
      }
      .std-card .body-row .leaf-wrap { flex:1; min-width:0; }
      /* 1,2단계 내용요소 오른쪽 사이드 팝업 */
      .std-card .chain-popup {
        flex:0 0 200px; width:200px; align-self:flex-start;
        position:sticky; top:6px;
        background:#fff; border:1.5px solid #c7d2fe; border-radius:10px;
        padding:10px 12px; box-shadow:0 4px 12px rgba(49,46,129,.08);
      }
      .std-card .chain-popup .cp-hdr {
        font-size:10px; font-weight:700; color:#4338ca;
        margin-bottom:6px; letter-spacing:.3px;
      }
      .std-card .chain-popup .cp-item {
        display:flex; flex-direction:column; gap:2px;
        padding:6px 8px; margin-bottom:4px;
        border-left:3px solid #818cf8; background:#eef2ff;
        border-radius:0 6px 6px 0;
      }
      .std-card .chain-popup .cp-item .cp-level {
        font-size:9px; font-weight:700; color:#6366f1; letter-spacing:.5px;
      }
      .std-card .chain-popup .cp-item .cp-label {
        font-size:13px; font-weight:600; color:#1e1b4b;
      }
      @media (max-width: 640px) {
        .std-card .body-row { flex-direction:column-reverse; }
        .std-card .chain-popup { width:auto; flex-basis:auto; }
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
        flex:1; color:#374151; font-size:13px;
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
        font-size:12px; font-weight:700; color:#6b7280;
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
        flex:1; color:#374151; font-size:13px; line-height:1.4;
      }
      .std-card .leaf-row.checked { background:#eff6ff; }
      .std-card .leaf-row.active { outline:2px solid #6366f1; outline-offset:-2px; background:#eef2ff; }
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
        else this._showRecent();
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
    async setCodes(codes, stdIds) {
      this._selected = [];
      this._renderTags();
      const list = (codes || []).map(c => String(c).trim()).filter(Boolean);
      if (list.length === 0) { this._emit(); return; }
      // 각 code를 _select로 추가 — leaves까지 자동 로드됨
      for (const code of list) {
        try { await this._select(code, '', code); } catch (_) {}
      }
      // stdIds가 주어지면 해당 leaf들을 체크 상태로 마킹
      const idSet = new Set((stdIds || []).map(String));
      if (idSet.size > 0) {
        this._selected.forEach(s => {
          (s.leaves || []).forEach(l => { if (idSet.has(String(l.id))) l.checked = true; });
        });
        this._renderTags();
        this._emit();
      }
    }

    // ===== internal =====
    async _search(query) {
      const dd = this.shadowRoot.querySelector('.dropdown');
      if (!query || query.length < 1) { dd.style.display = 'none'; return; }
      this._activeIdx = -1;
      const inp = this.shadowRoot.querySelector('.search-input');
      const rect = inp.getBoundingClientRect();
      dd.style.left = rect.left + 'px';
      dd.style.top = (rect.bottom + 4) + 'px';
      dd.style.width = rect.width + 'px';
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
          const label = (s.subject_name || '') + ' ' + (s.content || '');
          return `<div class="dd-item" data-i="${i}" data-code="${this._esc(s.code)}" data-std-id="${this._esc(stdId)}" data-label="${this._esc(label)}">
            <span class="code-chip">${this._esc(s.code)}</span>
            <span class="content-text">${this._esc(s.content || '')}</span>
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
            label: s ? ((s.subject_name || '') + ' ' + (s.content || '')) : code,
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
      // 드롭다운이 닫혀있고 ↓ 누르면 → 첫 leaf-row로 진입
      if (dd.style.display === 'none') {
        if (e.key === 'ArrowDown') {
          const firstLeaf = this.shadowRoot.querySelector('.leaf-row');
          if (firstLeaf) { e.preventDefault(); firstLeaf.focus(); }
        }
        return;
      }
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

    _saveRecent(code, label) {
      try {
        const k = 'stdSmartRecent';
        let arr = JSON.parse(localStorage.getItem(k) || '[]');
        arr = arr.filter(r => r.code !== code);
        arr.unshift({ code, label, ts: Date.now() });
        if (arr.length > 10) arr = arr.slice(0, 10);
        localStorage.setItem(k, JSON.stringify(arr));
      } catch (_) {}
    }

    _getRecent() {
      try { return JSON.parse(localStorage.getItem('stdSmartRecent') || '[]'); }
      catch { return []; }
    }

    _showRecent() {
      const recents = this._getRecent();
      if (!recents.length) return;
      const dd = this.shadowRoot.querySelector('.dropdown');
      const inp = this.shadowRoot.querySelector('.search-input');
      const rect = inp.getBoundingClientRect();
      dd.style.left = rect.left + 'px';
      dd.style.top = (rect.bottom + 4) + 'px';
      dd.style.width = rect.width + 'px';
      dd.style.display = 'block';
      dd.innerHTML = `
        <div style="padding:8px 12px;font-size:11px;font-weight:700;color:#6b7280;border-bottom:1px solid #f3f4f6;">
          <i class="fas fa-history" style="color:#60a5fa;"></i> 최근 선택한 성취기준
        </div>
        ${recents.map((r, i) => `
          <div class="dd-item" data-recent-i="${i}" data-code="${this._esc(r.code)}" data-label="${this._esc(r.label || '')}">
            <span class="code-chip">${this._esc(r.code)}</span>
            <span class="content-text">${this._esc(r.label || '')}</span>
          </div>`).join('')}`;
      dd.querySelectorAll('.dd-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this._select(el.dataset.code, '', el.dataset.label);
        });
      });
    }

    async _select(code, std_id, label) {
      if (this.dataset.multiple === 'false') this._selected = [];
      else if (this._selected.some(s => s.code === code)) return;
      this._saveRecent(code, label);

      const item = { code, label, chain: [], leaves: [], _loading: true };
      this._selected.push(item);

      const input = this.shadowRoot.querySelector('.search-input');
      input.value = '';
      this.shadowRoot.querySelector('.dropdown').style.display = 'none';
      this._renderTags();

      // 비동기로 성취기준↔내용요소 트리 로드
      try {
        // 1) 성취기준에 매핑된 내용요소 노드들 (가장 깊은 leaf — 수학:depth3=3단계, 그 외:depth2=2단계)
        const nodesRes = await fetch('/api/curriculum/standards/' + encodeURIComponent(code) + '/nodes').then(r => r.json()).catch(() => ({}));
        const rawNodes = (nodesRes && nodesRes.data) || [];

        // 2) 각 leaf의 조상 체인 병렬 조회 — leaf별로 따로 보관 (공유 X)
        const chains = await Promise.all(rawNodes.map(n =>
          fetch('/api/curriculum/content-nodes/' + encodeURIComponent(n.id) + '/ancestors')
            .then(r => r.json()).catch(() => ({ data: [] }))
        ));

        item.leaves = rawNodes.map((n, idx) => {
          const myChain = (chains[idx]?.data || [])
            .filter(a => a.depth < n.depth)
            .sort((a, b) => a.depth - b.depth);
          return { id: n.id, label: n.label, depth: n.depth, checked: false, chain: myChain };
        });
        // 활성 leaf(우측 chain-popup 대상) — 기본 첫 번째
        item.activeLeafIdx = item.leaves.length ? 0 : -1;
      } catch (_) {
        // 표준체계 매핑이 없으면 leaves/chain 없이 성취기준만 카드로 노출
        item.leaves = [];
        item.activeLeafIdx = -1;
      }
      item._loading = false;
      this._renderTags();
      this._emit();

      // 방금 추가한 카드의 첫 leaf-row로 포커스 이동 (키보드로 ↑↓ 탐색·Space 체크 가능)
      const newCardIdx = this._selected.indexOf(item);
      if (newCardIdx >= 0) {
        const firstLeaf = this.shadowRoot.querySelector(`.leaf-row[data-i="${newCardIdx}"][data-j="0"]`);
        if (firstLeaf) firstLeaf.focus();
      }
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
        const refocus = () => {
          const el = this.shadowRoot.querySelector(`.leaf-row[data-i="${i}"][data-j="${j}"]`);
          if (el) el.focus();
        };
        const setActive = () => {
          if (this._selected[i].activeLeafIdx !== j) {
            this._selected[i].activeLeafIdx = j;
            this._renderTags(); // 우측 chain-popup 갱신
            refocus();
          }
        };
        const toggle = () => {
          this._selected[i].leaves[j].checked = !this._selected[i].leaves[j].checked;
          this._selected[i].activeLeafIdx = j;
          this._renderTags();
          this._emit();
          refocus();
        };
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') { setActive(); return; }
          setActive();
        });
        cb.addEventListener('change', () => {
          this._selected[i].leaves[j].checked = cb.checked;
          this._selected[i].activeLeafIdx = j;
          this._renderTags();
          this._emit();
        });
        row.addEventListener('keydown', (e) => {
          if (e.key === ' ') { e.preventDefault(); toggle(); }
          else if (e.key === 'Enter') { e.preventDefault(); setActive(); }
          else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = this.shadowRoot.querySelector(`.leaf-row[data-i="${i}"][data-j="${j+1}"]`);
            if (next) next.focus();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = this.shadowRoot.querySelector(`.leaf-row[data-i="${i}"][data-j="${j-1}"]`);
            if (prev) prev.focus();
            else this.shadowRoot.querySelector('.search-input')?.focus();
          }
        });
        row.addEventListener('focus', setActive);
      });
    }

    _renderCard(s, i) {
      const activeLeaf = (s.leaves && s.activeLeafIdx >= 0) ? s.leaves[s.activeLeafIdx] : null;
      // 단계 = DB depth와 1:1. depth 0(영역)은 별도 라벨 "영역"으로 노출 (단계 X)
      const activeChainAll = activeLeaf && activeLeaf.chain ? activeLeaf.chain : [];
      const areaNode = activeChainAll.find(c => c.depth === 0);
      const stageNodes = activeChainAll.filter(c => c.depth >= 1);
      const chainHtml = (areaNode || stageNodes.length)
        ? `<div class="chain-popup">
             <div class="cp-hdr">📎 내용요소 상위 계층</div>
             ${areaNode ? `
               <div class="cp-item" style="border-left-color:#f59e0b;background:#fef3c7;">
                 <span class="cp-level" style="color:#b45309;">영역</span>
                 <span class="cp-label">${this._esc(areaNode.label || areaNode.id)}</span>
               </div>` : ''}
             ${stageNodes.map(c => `
               <div class="cp-item">
                 <span class="cp-level">${c.depth}단계</span>
                 <span class="cp-label">${this._esc(c.label || c.id)}</span>
               </div>
             `).join('')}
           </div>`
        : (s._loading ? '<div class="loading-chain">내용요소 체인 로드 중...</div>' : '');

      const leafDepth = (s.leaves && s.leaves[0] && s.leaves[0].depth != null) ? s.leaves[0].depth : null;
      const leavesHtml = s.leaves && s.leaves.length
        ? `<div class="leaf-list">
            <div class="leaf-hdr">${leafDepth}단계 내용요소 (클릭 시 우측 상위계층 갱신 · Space 체크)</div>
            ${s.leaves.map((l, j) => `
              <div class="leaf-row ${l.checked ? 'checked' : ''} ${j === s.activeLeafIdx ? 'active' : ''}" data-i="${i}" data-j="${j}" tabindex="0" role="checkbox" aria-checked="${l.checked}">
                <input type="checkbox" ${l.checked ? 'checked' : ''} tabindex="-1">
                <span class="leaf-text">${this._esc(l.label || '')}</span>
              </div>
            `).join('')}
          </div>`
        : (s._loading ? '' : '<div style="font-size:11px;color:#9ca3af;padding:6px 0;">표준체계 매핑 없음 — 성취기준만 선택됩니다</div>');

      return `<div class="std-card">
        <div class="hdr">
          <span class="code-main">${this._esc(s.code)}</span>
          <span class="content-text">${this._esc(s.label || '')}</span>
          <button class="remove-btn" data-i="${i}" aria-label="제거">&times;</button>
        </div>
        <div class="body-row">
          <div class="leaf-wrap">${leavesHtml}</div>
          ${chainHtml}
        </div>
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
