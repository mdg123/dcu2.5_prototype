/**
 * <std-picker>
 * 교육과정 표준체계 계층 탐색형 선택 Web Component
 *
 * 계층: 학교급 → 교과 → 학년군 → 영역 → 내용 노드 / 성취기준
 *
 * 사용:
 *   <std-picker data-value="E4KORA01B01C01"></std-picker>
 *   el.addEventListener('change', e => console.log(e.detail));
 *   // e.detail = { std_ids: [...], codes: [...], items: [{std_id, code, label, depth}] }
 *
 * 속성:
 *   data-value       : 초기 선택 (쉼표구분 std_id 또는 code 혼합)
 *   data-multiple    : "false" 면 단일선택 (기본: 다중)
 *   data-mode        : "node" (기본: 내용노드 선택) | "standard" (성취기준 선택)
 */
(function () {
  if (window.customElements && customElements.get('std-picker')) return;

  const SCHOOL_LEVELS = [
    { code: '초', label: '초등학교' },
    { code: '중', label: '중학교' },
    { code: '고', label: '고등학교' },
  ];

  const TPL = document.createElement('template');
  TPL.innerHTML = `
    <style>
      :host { display:block; font-family:inherit; }
      .panel {
        border:1.5px solid #e5e7eb; border-radius:12px;
        background:#fff; padding:12px; display:flex; flex-direction:column; gap:10px;
      }
      .row { display:flex; gap:8px; flex-wrap:wrap; }
      .row label {
        display:flex; flex-direction:column; gap:4px;
        font-size:11px; color:#6B7280; font-weight:700;
        flex:1; min-width:110px;
      }
      select {
        padding:7px 10px; border:1.5px solid #e5e7eb; border-radius:8px;
        font-size:13px; background:#fff; font-family:inherit;
        cursor:pointer; outline:none;
      }
      select:focus { border-color:#3b82f6; }
      select:disabled { background:#f9fafb; color:#9ca3af; cursor:not-allowed; }
      .nodes {
        border:1px solid #e5e7eb; border-radius:10px;
        max-height:240px; overflow-y:auto;
        padding:4px; background:#fafafa;
      }
      .node-item {
        display:flex; align-items:center; gap:8px;
        padding:8px 12px; border-radius:8px;
        cursor:pointer; font-size:13px;
        transition:background .1s;
      }
      .node-item:hover { background:#eff6ff; }
      .node-item.selected { background:#dbeafe; font-weight:600; }
      .node-item .dot {
        width:6px; height:6px; border-radius:50%;
        background:#3b82f6; flex-shrink:0;
      }
      .node-item .label { flex:1; color:#374151; }
      .node-item .code {
        font-size:10px; color:#7c3aed; background:#f3e8ff;
        padding:1px 6px; border-radius:4px; font-weight:700;
        flex-shrink:0;
      }
      .empty { padding:20px; text-align:center; color:#9ca3af; font-size:12px; }
      .loading { padding:12px; text-align:center; color:#9ca3af; font-size:12px; }
      .tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
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
    </style>
    <div class="panel">
      <div class="row">
        <label>학교급
          <select data-role="school-level">
            <option value="">선택...</option>
          </select>
        </label>
        <label>교과
          <select data-role="subject" disabled>
            <option value="">선택...</option>
          </select>
        </label>
        <label>학년군
          <select data-role="grade-group" disabled>
            <option value="">선택...</option>
          </select>
        </label>
        <label>영역
          <select data-role="area" disabled>
            <option value="">전체</option>
          </select>
        </label>
      </div>
      <div class="nodes" data-role="nodes">
        <div class="empty">학교급 → 교과 → 학년군을 선택하세요</div>
      </div>
      <div class="tags" data-role="tags"></div>
    </div>
  `;

  class StdPicker extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.appendChild(TPL.content.cloneNode(true));
      this._selected = []; // [{std_id, code, label, depth}]
      this._subjects = [];
    }

    connectedCallback() {
      const root = this.shadowRoot;
      const slSel = root.querySelector('[data-role="school-level"]');
      SCHOOL_LEVELS.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.code; opt.textContent = s.label;
        slSel.appendChild(opt);
      });
      slSel.addEventListener('change', () => this._onSchoolLevelChange(slSel.value));
      root.querySelector('[data-role="subject"]').addEventListener('change', (e) => this._onSubjectChange(e.target.value));
      root.querySelector('[data-role="grade-group"]').addEventListener('change', () => this._loadNodes());
      root.querySelector('[data-role="area"]').addEventListener('change', () => this._loadNodes());

      if (this.dataset.value) {
        this._loadInitial(this.dataset.value.split(',').map(s => s.trim()).filter(Boolean));
      }
    }

    // ===== public API =====
    get value() {
      return {
        std_ids: this._selected.filter(s => s.std_id).map(s => s.std_id),
        codes: this._selected.filter(s => s.code).map(s => s.code),
        items: this._selected.slice(),
      };
    }
    clear() {
      this._selected = [];
      this._renderTags();
      this._renderNodeSelection();
      this._emit();
    }

    // ===== internal =====
    async _onSchoolLevelChange(schoolLevel) {
      const subjSel = this.shadowRoot.querySelector('[data-role="subject"]');
      const ggSel = this.shadowRoot.querySelector('[data-role="grade-group"]');
      const areaSel = this.shadowRoot.querySelector('[data-role="area"]');
      subjSel.innerHTML = '<option value="">선택...</option>';
      ggSel.innerHTML = '<option value="">선택...</option>'; ggSel.disabled = true;
      areaSel.innerHTML = '<option value="">전체</option>'; areaSel.disabled = true;
      if (!schoolLevel) { subjSel.disabled = true; this._clearNodes(); return; }
      subjSel.disabled = false;
      try {
        const res = await fetch('/api/curriculum/subjects?school_level=' + encodeURIComponent(schoolLevel)).then(r => r.json());
        const subjects = (res && res.data) || [];
        this._subjects = subjects;
        subjects.forEach(s => {
          const opt = document.createElement('option');
          const code = s.subject_code || s.code;
          opt.value = code; opt.textContent = s.subject_name || s.name || code;
          subjSel.appendChild(opt);
        });
      } catch (_) {}
      this._clearNodes();
    }

    async _onSubjectChange(subjectCode) {
      const ggSel = this.shadowRoot.querySelector('[data-role="grade-group"]');
      const areaSel = this.shadowRoot.querySelector('[data-role="area"]');
      ggSel.innerHTML = '<option value="">선택...</option>';
      areaSel.innerHTML = '<option value="">전체</option>'; areaSel.disabled = true;
      if (!subjectCode) { ggSel.disabled = true; this._clearNodes(); return; }
      ggSel.disabled = false;
      try {
        const res = await fetch('/api/curriculum/grade-groups?subject_code=' + encodeURIComponent(subjectCode)).then(r => r.json());
        const groups = (res && res.data) || [];
        groups.forEach(g => {
          const opt = document.createElement('option');
          opt.value = g.grade_group; opt.textContent = g.grade_label || (g.grade_group + '학년군');
          ggSel.appendChild(opt);
        });
      } catch (_) {}
      this._clearNodes();
    }

    async _loadAreas() {
      const subjectCode = this.shadowRoot.querySelector('[data-role="subject"]').value;
      const gradeGroup = this.shadowRoot.querySelector('[data-role="grade-group"]').value;
      const areaSel = this.shadowRoot.querySelector('[data-role="area"]');
      areaSel.innerHTML = '<option value="">전체</option>';
      if (!subjectCode) { areaSel.disabled = true; return; }
      try {
        const qs = new URLSearchParams({ subject_code: subjectCode });
        if (gradeGroup) qs.set('grade_group', gradeGroup);
        const res = await fetch('/api/curriculum/areas?' + qs.toString()).then(r => r.json());
        const areas = (res && res.data) || [];
        areas.forEach(a => {
          const opt = document.createElement('option');
          const val = (typeof a === 'string') ? a : (a.area || a.area_name || a.label);
          opt.value = val; opt.textContent = val;
          areaSel.appendChild(opt);
        });
        areaSel.disabled = areas.length === 0;
      } catch (_) {}
    }

    async _loadNodes() {
      const root = this.shadowRoot;
      const subjectCode = root.querySelector('[data-role="subject"]').value;
      const gradeGroup = root.querySelector('[data-role="grade-group"]').value;
      const schoolLevel = root.querySelector('[data-role="school-level"]').value;
      const area = root.querySelector('[data-role="area"]').value;
      const nodesEl = root.querySelector('[data-role="nodes"]');

      if (!subjectCode || !gradeGroup) {
        nodesEl.innerHTML = '<div class="empty">학교급 → 교과 → 학년군을 선택하세요</div>';
        return;
      }
      // areas 로드 (학년군 바뀌면)
      this._loadAreas();

      nodesEl.innerHTML = '<div class="loading">노드 로드 중...</div>';
      const mode = this.dataset.mode || 'node';
      try {
        if (mode === 'standard') {
          // 성취기준 모드
          const qs = new URLSearchParams({ subject_code: subjectCode, grade_group: gradeGroup });
          if (schoolLevel) qs.set('school_level', schoolLevel);
          if (area) qs.set('area', area);
          const res = await fetch('/api/curriculum/standards?' + qs.toString()).then(r => r.json());
          const stds = (res && res.data) || [];
          if (!stds.length) { nodesEl.innerHTML = '<div class="empty">성취기준이 없습니다</div>'; return; }
          nodesEl.innerHTML = stds.map(s => `
            <div class="node-item" data-code="${this._esc(s.code)}" data-label="${this._esc(s.content || '')}">
              <span class="dot"></span>
              <span class="code">${this._esc(s.code)}</span>
              <span class="label">${this._esc((s.content || '').substring(0, 100))}</span>
            </div>
          `).join('');
        } else {
          // 내용 노드 모드
          const qs = new URLSearchParams({ subject_code: subjectCode, grade_group: gradeGroup });
          if (schoolLevel) qs.set('school_level', schoolLevel);
          const res = await fetch('/api/curriculum/content-nodes?' + qs.toString()).then(r => r.json());
          const nodes = (res && res.data) || [];
          if (!nodes.length) { nodesEl.innerHTML = '<div class="empty">내용 노드가 없습니다</div>'; return; }
          // 깊이 오름차순 정렬 + 간단한 트리 들여쓰기
          nodesEl.innerHTML = nodes.map(n => `
            <div class="node-item" data-std-id="${this._esc(n.id)}" data-label="${this._esc(n.label || '')}" data-depth="${n.depth}" style="padding-left:${12 + n.depth * 14}px;">
              <span class="dot" style="background:${this._depthColor(n.depth)};"></span>
              <span class="code">${this._esc(n.id)}</span>
              <span class="label">${this._esc(n.label || '')}</span>
            </div>
          `).join('');
        }
        nodesEl.querySelectorAll('.node-item').forEach(el => {
          el.addEventListener('click', () => this._toggleNode(el));
        });
        this._renderNodeSelection();
      } catch (err) {
        nodesEl.innerHTML = '<div class="empty">로드 오류</div>';
      }
    }

    _toggleNode(el) {
      const std_id = el.dataset.stdId || '';
      const code = el.dataset.code || '';
      const label = el.dataset.label || '';
      const depth = el.dataset.depth ? parseInt(el.dataset.depth) : null;
      const key = std_id || code;
      const idx = this._selected.findIndex(s => (s.std_id || s.code) === key);
      if (idx >= 0) {
        this._selected.splice(idx, 1);
      } else {
        if (this.dataset.multiple === 'false') this._selected = [];
        this._selected.push({ std_id, code, label, depth });
      }
      this._renderNodeSelection();
      this._renderTags();
      this._emit();
    }

    _renderNodeSelection() {
      const selectedKeys = new Set(this._selected.map(s => s.std_id || s.code));
      this.shadowRoot.querySelectorAll('.node-item').forEach(el => {
        const key = el.dataset.stdId || el.dataset.code;
        el.classList.toggle('selected', selectedKeys.has(key));
      });
    }

    _renderTags() {
      const tagsEl = this.shadowRoot.querySelector('[data-role="tags"]');
      if (!this._selected.length) { tagsEl.innerHTML = ''; return; }
      tagsEl.innerHTML = this._selected.map((s, i) => `
        <span class="tag" title="${this._esc(s.label || '')}">
          ${this._esc(s.std_id || s.code)}
          <button data-i="${i}" aria-label="제거">&times;</button>
        </span>
      `).join('');
      tagsEl.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          this._selected.splice(parseInt(btn.dataset.i), 1);
          this._renderTags();
          this._renderNodeSelection();
          this._emit();
        });
      });
    }

    async _loadInitial(values) {
      // values 는 std_id 또는 code 혼합
      const items = [];
      for (const v of values) {
        const isCode = /^\[/.test(v); // [4국01-01] 형태
        try {
          if (isCode) {
            const [stdRes, mapRes] = await Promise.all([
              fetch('/api/curriculum/standards/' + encodeURIComponent(v)).then(r => r.json()).catch(() => ({})),
              fetch('/api/curriculum/std-id-map?code=' + encodeURIComponent(v)).then(r => r.json()).catch(() => ({})),
            ]);
            const s = stdRes && stdRes.data;
            const m = mapRes && (mapRes.data || [])[0];
            items.push({
              std_id: m ? m.std_id : '',
              code: v,
              label: s ? (s.content || '').substring(0, 40) : v,
            });
          } else {
            // std_id → 내용 노드 조회는 /content-nodes?search= 활용
            const res = await fetch('/api/curriculum/content-nodes?search=' + encodeURIComponent(v)).then(r => r.json()).catch(() => ({}));
            const node = (res.data || []).find(n => n.id === v);
            items.push({ std_id: v, code: '', label: node ? node.label : v, depth: node ? node.depth : null });
          }
        } catch (_) {
          items.push({ std_id: isCode ? '' : v, code: isCode ? v : '', label: v });
        }
      }
      this._selected = items;
      this._renderTags();
      this._emit();
    }

    _clearNodes() {
      const nodesEl = this.shadowRoot.querySelector('[data-role="nodes"]');
      nodesEl.innerHTML = '<div class="empty">학교급 → 교과 → 학년군을 선택하세요</div>';
    }

    _depthColor(d) {
      const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#6b7280'];
      return colors[Math.min(d || 0, colors.length - 1)];
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

  customElements.define('std-picker', StdPicker);
})();
