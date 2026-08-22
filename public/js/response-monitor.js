/* ─────────────────────────────────────────────────────────────────────────────
 * response-monitor.js — 수업꾸러미 "응답 현황" 모니터 (레이어 팝업)
 * 기획서: 보고서/기획_수업꾸러미_응답모니터링_v1.md
 * 호스트: public/class/lesson-player.html (주) · public/class/lesson-view.html (보조)
 *
 * 🔴 설계 원칙 — 렌더와 취득을 분리한다 (하네스 기반)
 *   renderResponseMonitor(snapshot)  ← 순수 렌더. 인자로 받은 스냅샷만 그린다. fetch 없음
 *   fetchResponseMonitor(lessonId)   ← 취득 전담. 실패 시 오류 상태 객체를 반환
 *   openResponseMonitor(lessonId)    ← 열기 = fetch → render
 * 이 분리 덕분에 BE API 없이도 픽스처 스냅샷으로 전 화면을 시각 검증할 수 있고,
 * 스모크 테스트도 픽스처를 주입해 결정적으로 돌릴 수 있다.
 *
 * 스냅샷 형태는 기획서 §8-1 응답 JSON 계약을 **글자 그대로** 따른다.
 *
 * 이번 차수 범위: §13-3(팝업 셸+격자) · §13-5(드릴다운 2종) · §13-6(모바일 2탭)
 *   범위 밖(다음 차수): 소켓 실시간(§8-3) · CSV(§8-5) · BE API(§8-1)
 * ───────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  if (global.ResponseMonitor) return;

  var CSS_HREF = '/css/response-monitor.css';

  // §5-5 셀 상태 ↔ 기호/라벨 (색은 보조, 기호가 정본)
  var CELL_ICON  = { correct: '✓', wrong: '×', pending: '△', unanswered: '−', none: '', norec: '·' };
  var CELL_LABEL = { correct: '정답', wrong: '오답', pending: '채점 대기', unanswered: '미응답',
                     none: '아직 안 풂', norec: '기록 없음' };
  var TYPE_LABEL = { video: '영상', document: '문서', image: '이미지', link: '링크',
                     quiz: '퀴즈', exam: '평가' };

  var AUTO_FILTER_THRESHOLD = 20;   // §9-4 ② 총 문항 > 20 → 첫 아이템만
  var COMPACT_THRESHOLD     = 40;   // (보존) 과거 자동 압축 임계 — 지금은 자동 압축을 쓰지 않는다
  var COMPACT_TOGGLE_FROM   = 12;   // 이 개수를 넘으면 "압축 보기" 토글을 노출(기본은 가로 스크롤)
  var JUMP_THRESHOLD        = 20;   // §9-4 ⑤ 표시 문항 > 20 → 열 점프 select

  // ── 모듈 상태 (팝업을 닫아도 유지 → §4-3 "스크롤 위치·선택 필터 메모리 보존") ──
  var S = {
    snapshot: null,
    error: null,
    loading: false,
    isOpen: false,
    ctx: { classId: null, lessonId: null },
    viewerId: null,
    moveHandler: null,
    onSnapshot: null,          // 스냅샷 도착 콜백(헤더 배지 갱신 등 호스트 훅)
    onClose: null,             // 닫힘 콜백(소켓 leave·폴링 정리 등 호스트 훅)
    // 사용자 선택 상태(세션 내 보존)
    selectedItem: null,        // null = 전체
    sort: 'name',
    lowOnly: false,
    includeOutside: false,
    compact: null,             // null = 자동, true/false = 사용자 토글
    mobileTab: 'student',
    realtime: null,            // null=칩 숨김 / 'live' / 'polling'  (소켓 차수에서 사용)
    scroll: { left: 0, top: 0 },
    autoFilterAppliedFor: null,
    notices: [],
    noticeTimer: null,
    sheet: null,               // {type:'student', userId} | {type:'question', col}
    opener: null,              // 포커스 반환 대상
    lastFocusedCell: null,
    built: false,
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * 유틸
   * ═══════════════════════════════════════════════════════════════════════════ */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : (dflt || 0); }
  function el(id) { return document.getElementById(id); }
  function toast(msg, type) {
    if (typeof global.classToast === 'function') global.classToast(msg, type || 'info');
    else if (typeof global.showToast === 'function') global.showToast(msg, type || 'info');
  }
  function hhmmss(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function agoText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return '방금 전';
    if (sec < 3600) return Math.floor(sec / 60) + '분 전';
    if (sec < 86400) return Math.floor(sec / 3600) + '시간 전';
    return Math.floor(sec / 86400) + '일 전';
  }
  function circled(i) {
    var m = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    return (i >= 0 && i < m.length) ? m[i] : String(i + 1);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 셸 (DOM · CSS) — 1회만 생성
   * ═══════════════════════════════════════════════════════════════════════════ */
  function ensureCss() {
    // 호스트 페이지가 이미 <link> 로 걸어두었으면 중복 주입하지 않는다(중복 로드 = 규칙 2배)
    if (document.querySelector('link[data-rm-css]')) return;
    if (document.querySelector('link[href*="response-monitor.css"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-rm-css', '1');
    document.head.appendChild(link);
  }

  function ensureShell() {
    if (S.built && el('respMonitorOverlay')) return el('respMonitorPanel');
    ensureCss();
    var ov = document.createElement('div');
    ov.id = 'respMonitorOverlay';
    ov.setAttribute('role', 'presentation');
    ov.innerHTML =
      '<div id="respMonitorPanel" role="dialog" aria-modal="true" aria-labelledby="rmTitle">' +
        '<div class="rm-header">' +
          '<div class="rm-head-left">' +
            '<span class="rm-title" id="rmTitle">응답 현황</span>' +
            '<span class="rm-subtitle" id="rmSubtitle"></span>' +
            '<span class="rm-chip" id="rmModeChip" hidden></span>' +
            '<span class="rm-chip" id="rmLiveChip" hidden></span>' +
          '</div>' +
          '<div class="rm-actions">' +
            '<button type="button" class="rm-icon-btn" id="rmRefreshBtn" title="새로고침" aria-label="새로고침">' +
              '<i class="fas fa-rotate-right" aria-hidden="true"></i></button>' +
            '<button type="button" class="rm-icon-btn rm-close" id="rmCloseBtn" title="닫기" aria-label="닫기">' +
              '<i class="fas fa-xmark" aria-hidden="true"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="rm-toolbar" id="rmToolbar"></div>' +
        '<div class="rm-notices" id="rmNotices"></div>' +
        '<div class="rm-body" id="rmBody"></div>' +
        '<div class="rm-footer" id="rmFooter"></div>' +
        '<div class="rm-sheet" id="rmSheet" role="dialog" aria-label="상세" aria-hidden="true">' +
          '<div class="rm-sheet-header">' +
            '<button type="button" class="back" id="rmSheetBack" aria-label="격자로 돌아가기" title="돌아가기">' +
              '<i class="fas fa-arrow-left" aria-hidden="true"></i></button>' +
            '<span class="rm-sheet-title" id="rmSheetTitle"></span>' +
            '<span class="rm-sheet-badge" id="rmSheetBadge" hidden></span>' +
          '</div>' +
          '<div class="rm-sheet-body" id="rmSheetBody"></div>' +
          '<div class="rm-sheet-footer" id="rmSheetFooter" hidden></div>' +
        '</div>' +
        '<div class="rm-tooltip" id="rmTooltip" role="tooltip"></div>' +
      '</div>';
    document.body.appendChild(ov);

    // ── 복귀 동선 (§4-3) ──
    ov.addEventListener('click', function (e) { if (e.target === ov) closeResponseMonitor(); });
    el('rmCloseBtn').addEventListener('click', function () { closeResponseMonitor(); });
    el('rmSheetBack').addEventListener('click', function () { closeSheet(); });
    el('rmRefreshBtn').addEventListener('click', function () { refresh(); });
    document.addEventListener('keydown', onKeydown, true);

    // 스크롤 위치 보존
    el('rmBody').addEventListener('scroll', function () {
      S.scroll.left = this.scrollLeft; S.scroll.top = this.scrollTop;
    });

    S.built = true;
    return el('respMonitorPanel');
  }

  function onKeydown(e) {
    if (!S.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (S.sheet) closeSheet();          // 1단계: 시트만
      else closeResponseMonitor();        // 2단계: 팝업
      return;
    }
    if (e.key === 'Tab') trapFocus(e);
  }

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (n) {
        if (n.disabled || n.hasAttribute('hidden')) return false;
        return !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
      });
  }
  function trapFocus(e) {
    var panel = el('respMonitorPanel');
    if (!panel) return;
    var list = focusables(panel);
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 파생 계산 (스냅샷 → 화면에 그릴 목록)
   * ═══════════════════════════════════════════════════════════════════════════ */
  function gradableItems(snap) {
    return (snap.items || []).filter(function (it) {
      return it && it.gradable && num(it.question_count) > 0;
    });
  }

  function visibleQuestions(snap) {
    var qs = (snap.questions || []).slice();
    if (S.selectedItem !== null && S.selectedItem !== undefined) {
      qs = qs.filter(function (q) { return q.item_index === S.selectedItem; });
    }
    if (S.lowOnly) qs = qs.filter(function (q) { return !!q.low_flag; });
    return qs;
  }

  function sortedStudents(snap) {
    var list = (snap.students || []).slice();
    var mode = S.sort;
    if (mode === 'name') return list;                       // 서버가 표시 이름순으로 내려준다
    function score(s) {
      return (num(s.submitted_items) === 0) ? null : num(s.score_percent);
    }
    if (mode === 'score-desc' || mode === 'score-asc') {
      list.sort(function (a, b) {
        var sa = score(a), sb = score(b);
        if (sa === null && sb === null) return 0;
        if (sa === null) return 1;                          // 미제출은 항상 뒤
        if (sb === null) return -1;
        return mode === 'score-desc' ? (sb - sa) : (sa - sb);
      });
    } else if (mode === 'unsubmitted') {
      list.sort(function (a, b) {
        var ua = num(a.submitted_items) === 0 ? 0 : 1;
        var ub = num(b.submitted_items) === 0 ? 0 : 1;
        return ua - ub;
      });
    } else if (mode === 'progress') {
      list.sort(function (a, b) {
        var pa = (a.position && a.position.online) ? num(a.position.item_index, 0) : 9999;
        var pb = (b.position && b.position.online) ? num(b.position.item_index, 0) : 9999;
        return pa - pb;                                     // 뒤처진 학생이 위로, 미접속은 맨 뒤
      });
    }
    return list;
  }

  function cellByCol(student, col) {
    var cells = student.cells || [];
    for (var i = 0; i < cells.length; i++) if (cells[i] && cells[i].col === col) return cells[i];
    return null;
  }
  function questionByCol(snap, col) {
    var qs = snap.questions || [];
    for (var i = 0; i < qs.length; i++) if (qs[i].col === col) return qs[i];
    return null;
  }
  function itemByIndex(snap, idx) {
    var its = snap.items || [];
    for (var i = 0; i < its.length; i++) if (its[i].index === idx) return its[i];
    return null;
  }
  function isCompact(qs) {
    // 사용자 지시(2026-08-21): 문항이 많으면 칸을 줄이지 말고 **가로 스크롤**로 본다.
    //   자동 압축은 문항이 늘수록 셀·번호가 작아져 스캔성이 도리어 떨어졌다.
    //   압축은 밀도를 원하는 교사를 위한 **수동 토글**로만 남긴다(기본 꺼짐).
    //   가로 스크롤은 `.rm-body` 안에서만 발생한다 — 페이지 본문은 절대 밀리지 않는다.
    return S.compact === true;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 🔴 renderResponseMonitor(snapshot) — 순수 렌더. fetch 없음.
   * ═══════════════════════════════════════════════════════════════════════════ */
  function renderResponseMonitor(snapshot, opts) {
    ensureShell();
    opts = opts || {};
    if (opts.realtime !== undefined) S.realtime = opts.realtime;
    S.snapshot = snapshot || null;
    S.error = null;
    S.loading = false;

    if (!snapshot || typeof snapshot !== 'object') {
      renderHeader(null);
      renderToolbar(null, []);
      renderNotices([]);
      renderEmpty('fa-triangle-exclamation warn', '응답 현황을 불러오지 못했어요',
        '잠시 후 다시 시도해 주세요. 계속 안 되면 새로고침 해 보세요.',
        [{ label: '다시 시도', cls: 'rm-btn-primary', act: 'retry' }]);
      renderFooter(null, []);
      return el('respMonitorPanel');
    }

    // §9-4 ② 총 문항 > 20 → 첫 문항 아이템만 자동 선택 (수업당 1회)
    var key = String(snapshot.lesson && snapshot.lesson.id);
    var allQ = snapshot.questions || [];
    var autoNotice = null;
    if (allQ.length > AUTO_FILTER_THRESHOLD && S.autoFilterAppliedFor !== key) {
      S.autoFilterAppliedFor = key;
      var gi = gradableItems(snapshot);
      if (gi.length > 1) {
        S.selectedItem = gi[0].index;
        autoNotice = '문항이 ' + allQ.length + '개라 첫 번째 묶음만 보여드려요. 위 칩으로 바꿔 보세요.';
      }
    }

    var qs = visibleQuestions(snapshot);
    renderHeader(snapshot);
    renderToolbar(snapshot, qs);

    var notices = [];
    if (autoNotice) notices.push({ text: autoNotice, auto: true });
    // 아무도 아직 안 풂 — 표는 숨기지 않고 안내 띠만 얹는다 (§7)
    if ((snapshot.students || []).length > 0 && num(snapshot.summary && snapshot.summary.submitted_any) === 0) {
      notices.push({ text: '아직 제출한 학생이 없어요. 학생이 문항을 풀면 여기에 바로 표시돼요.' });
    }
    // 기록 미지원(레거시) 아이템 — 열을 만들지 않으므로 "왜 없는지"를 밝힌다 (§1-2-e)
    var norec = (snapshot.summary && snapshot.summary.no_record_items) || [];
    if (norec.length > 0) {
      var titles = norec.map(function (i) {
        var it = itemByIndex(snapshot, i);
        return it ? ((it.index + 1) + '. ' + (it.title || '콘텐츠')) : ('아이템 ' + (i + 1));
      }).join(', ');
      notices.push({ warn: true, text: titles + ' 은(는) 정·오답이 기록되지 않는 콘텐츠라 표에 나오지 않아요.' });
    }
    renderNotices(notices);

    // ── 빈 상태 분기 (§7) ──
    if (allQ.length === 0) {
      renderEmpty('fa-clipboard-question', '이 수업꾸러미에는 문항이 없어요',
        '퀴즈나 평가 콘텐츠를 넣으면 학생들의 정·오답을 여기서 바로 볼 수 있어요.',
        canAddContent() ? [{ label: '콘텐츠 추가하기', cls: 'rm-btn-primary', act: 'add-content' }] : []);
      renderFooter(snapshot, qs);
      return el('respMonitorPanel');
    }
    if ((snapshot.students || []).length === 0) {
      renderEmpty('fa-user-group', '아직 이 클래스에 학생이 없어요',
        '학생이 클래스에 가입하면 명렬표가 여기에 만들어져요.',
        [{ label: '클래스 관리로 가기', cls: 'rm-btn-outline', act: 'go-class' }]);
      renderFooter(snapshot, qs);
      return el('respMonitorPanel');
    }
    if (qs.length === 0 && S.lowOnly) {
      renderEmpty('fa-circle-check ok', '정답률이 낮은 문항이 없어요',
        '모든 문항의 정답률이 50% 이상이에요.',
        [{ label: '전체 문항 보기', cls: 'rm-btn-outline', act: 'clear-low' }]);
      renderFooter(snapshot, qs);
      return el('respMonitorPanel');
    }

    renderGrid(snapshot, qs);
    renderFooter(snapshot, qs);

    // 시트가 열려 있었으면 같은 대상으로 다시 그린다(실시간 갱신 대비)
    if (S.sheet) {
      if (S.sheet.type === 'student') paintStudentSheet(S.sheet.userId);
      else if (S.sheet.type === 'question') paintQuestionSheet(S.sheet.col);
    }
    return el('respMonitorPanel');
  }

  function canAddContent() {
    return typeof global.openAddContentModal === 'function';
  }

  /* ── 헤더 ─────────────────────────────────────────────────────────────────── */
  function renderHeader(snap) {
    var sub = el('rmSubtitle'), mode = el('rmModeChip'), live = el('rmLiveChip');
    sub.textContent = (snap && snap.lesson && snap.lesson.title) ? snap.lesson.title : '';

    // 모드 칩 (§5-2) — 동기화 ON/OFF 차이를 흡수하는 지점 ①
    var sync = snap && snap.sync;
    if (!snap) { mode.hidden = true; }
    else if (!sync || !sync.on) {
      mode.hidden = false; mode.className = 'rm-chip rm-chip-gray'; mode.textContent = '자유 진행';
    } else {
      var at = (sync.current_col !== null && sync.current_col !== undefined)
        ? ' · ' + sync.current_col + '번 문항' : '';
      var mine = (S.viewerId !== null && sync.controller_id !== null && sync.controller_id !== undefined)
        ? (sync.controller_id === S.viewerId) : true;
      mode.hidden = false;
      if (mine) { mode.className = 'rm-chip rm-chip-green'; mode.textContent = '동기화 중' + at; }
      else {
        mode.className = 'rm-chip rm-chip-amber';
        mode.textContent = (sync.controller_name || '다른 선생') + '님이 진행 중' + at;
      }
    }

    // 실시간 칩 — 소켓 차수에서 켠다. 그 전에는 거짓 표시를 하지 않는다(숨김).
    if (S.realtime === 'live') {
      live.hidden = false; live.className = 'rm-chip rm-chip-live';
      live.innerHTML = '<span class="dot" aria-hidden="true"></span>실시간';
    } else if (S.realtime === 'polling') {
      live.hidden = false; live.className = 'rm-chip rm-chip-poll';
      live.textContent = '실시간 연결 끊김 · 10초마다 새로고침 중';
    } else {
      live.hidden = true; live.textContent = '';
    }
  }

  /* ── 툴바 ─────────────────────────────────────────────────────────────────── */
  function renderToolbar(snap, qs) {
    var bar = el('rmToolbar');
    if (!snap) { bar.innerHTML = ''; return; }
    var items = gradableItems(snap);
    var total = (snap.questions || []).length;
    var h = [];

    // 1) 아이템 필터 칩
    h.push('<button type="button" class="rm-filter-chip" data-item="all" aria-pressed="' +
      (S.selectedItem === null ? 'true' : 'false') + '">전체<span class="cnt">' + total + '</span></button>');
    items.forEach(function (it) {
      h.push('<button type="button" class="rm-filter-chip" data-item="' + it.index + '" aria-pressed="' +
        (S.selectedItem === it.index ? 'true' : 'false') + '">' +
        esc((it.index + 1) + '. ' + (it.title || '콘텐츠')) +
        '<span class="cnt">' + num(it.question_count) + '</span></button>');
    });

    // 2) 정렬
    var sorts = [['name', '이름순'], ['score-desc', '점수 높은순'], ['score-asc', '점수 낮은순'],
                 ['unsubmitted', '미제출 먼저'], ['progress', '진행 순서']];
    h.push('<select class="rm-select" id="rmSort" aria-label="정렬">' + sorts.map(function (o) {
      return '<option value="' + o[0] + '"' + (S.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select>');

    // 3) 보기 옵션
    h.push('<label class="rm-check"><input type="checkbox" id="rmLowOnly"' + (S.lowOnly ? ' checked' : '') +
           '>낮은 정답률 문항만</label>');
    h.push('<label class="rm-check"><input type="checkbox" id="rmOutside"' + (S.includeOutside ? ' checked' : '') +
           '>수업 밖 풀이 포함</label>');

    // 4) 열 점프 (§9-4 ⑤) — 표시 문항 > 20
    if (qs.length > JUMP_THRESHOLD) {
      var cur = (snap.sync && snap.sync.on && snap.sync.current_col) ? snap.sync.current_col : qs[0].col;
      h.push('<select class="rm-select rm-select-sm" id="rmJump" aria-label="문항으로 이동">' +
        qs.map(function (q) {
          return '<option value="' + q.col + '"' + (q.col === cur ? ' selected' : '') + '>' + q.col + '번 문항</option>';
        }).join('') + '</select>');
    }

    // 5) 압축 모드 토글 — 기본은 가로 스크롤이고, 압축은 원하는 교사만 켠다.
    //    기본이 스크롤로 바뀌었으므로 토글은 40개가 아니라 **한 화면을 넘기 시작하는 시점**부터 노출한다.
    if (qs.length > COMPACT_TOGGLE_FROM || S.compact === true) {
      h.push('<button type="button" class="rm-toggle-btn" id="rmCompact">' +
        (isCompact(qs) ? '압축 보기 해제' : '압축 보기') + '</button>');
    }

    // 6) 범례
    h.push('<div class="rm-legend">' +
      lg('correct', '정답') + lg('wrong', '오답') + lg('pending', '채점 대기') +
      lg('unanswered', '미응답') + lg('none', '아직 안 풂') + '</div>');

    bar.innerHTML = h.join('');

    Array.prototype.forEach.call(bar.querySelectorAll('.rm-filter-chip'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-item');
        S.selectedItem = (v === 'all') ? null : parseInt(v, 10);
        S.compact = null;
        renderResponseMonitor(S.snapshot);
      });
    });
    el('rmSort').addEventListener('change', function () { S.sort = this.value; renderResponseMonitor(S.snapshot); });
    el('rmLowOnly').addEventListener('change', function () { S.lowOnly = this.checked; renderResponseMonitor(S.snapshot); });
    el('rmOutside').addEventListener('change', function () { S.includeOutside = this.checked; refresh(); });
    var jump = el('rmJump');
    if (jump) jump.addEventListener('change', function () {
      var t = el('rmBody').querySelector('.rm-th-q[data-col="' + this.value + '"]');
      if (t && t.scrollIntoView) t.scrollIntoView({ inline: 'center', block: 'nearest' });
    });
    var cbtn = el('rmCompact');
    if (cbtn) cbtn.addEventListener('click', function () {
      S.compact = !isCompact(visibleQuestions(S.snapshot));
      renderResponseMonitor(S.snapshot);
    });
  }
  function lg(state, label) {
    return '<span class="lg"><span class="sw rm-cell ' + state + '" aria-hidden="true">' +
           CELL_ICON[state] + '</span>' + label + '</span>';
  }

  /* ── 안내 띠 ──────────────────────────────────────────────────────────────── */
  function renderNotices(list) {
    var box = el('rmNotices');
    box.innerHTML = (list || []).map(function (n) {
      return '<div class="rm-notice' + (n.warn ? ' warn' : '') + (n.auto ? ' auto' : '') + '">' +
             esc(n.text) + '</div>';
    }).join('');
    if (S.noticeTimer) { clearTimeout(S.noticeTimer); S.noticeTimer = null; }
    var hasAuto = (list || []).some(function (n) { return n.auto; });
    if (hasAuto) {
      S.noticeTimer = setTimeout(function () {
        var keep = (list || []).filter(function (n) { return !n.auto; });
        renderNotices(keep);
      }, 5000);
    }
  }

  /* ── 빈 상태 · 오류 상태 ──────────────────────────────────────────────────── */
  function renderEmpty(icon, title, desc, actions) {
    var parts = String(icon).split(' ');
    var body = el('rmBody');
    body.innerHTML =
      '<div class="rm-empty">' +
        '<i class="fas ' + esc(parts[0]) + ' ico' + (parts[1] ? ' ' + esc(parts[1]) : '') + '" aria-hidden="true"></i>' +
        '<div class="ttl">' + esc(title) + '</div>' +
        '<div class="desc">' + esc(desc) + '</div>' +
        (actions && actions.length
          ? '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
            actions.map(function (a) {
              return '<button type="button" class="rm-btn ' + a.cls + '" data-act="' + a.act + '">' + esc(a.label) + '</button>';
            }).join('') + '</div>'
          : '') +
      '</div>';
    Array.prototype.forEach.call(body.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () { onEmptyAction(b.getAttribute('data-act')); });
    });
  }

  function onEmptyAction(act) {
    if (act === 'retry') { refresh(); return; }
    if (act === 'close') { closeResponseMonitor(); return; }
    if (act === 'clear-low') { S.lowOnly = false; renderResponseMonitor(S.snapshot); return; }
    if (act === 'go-class') {
      closeResponseMonitor();
      location.href = '/class/manage.html' + (S.ctx.classId ? '?id=' + encodeURIComponent(S.ctx.classId) : '');
      return;
    }
    if (act === 'add-content') {
      closeResponseMonitor();
      if (typeof global.openAddContentModal === 'function') global.openAddContentModal();
      return;
    }
  }

  /* ── 격자 (데스크탑) + 모바일 2탭 ─────────────────────────────────────────── */
  function renderGrid(snap, qs) {
    var students = sortedStudents(snap);
    var body = el('rmBody');
    // 🔴 모바일(<768px)에는 툴바(아이템 필터)가 없다 → 필터에 갇히지 않도록 **전 문항**을 그린다.
    //    배지가 flex-wrap 으로 감기므로 문항이 45개여도 가로 스크롤 0 (D10).
    body.innerHTML =
      '<div class="rm-table-view">' + tableHtml(snap, qs, students) + '</div>' +
      '<div class="rm-mobile">' + mobileHtml(snap, snap.questions || [], students) + '</div>';
    bindGrid(snap, qs);
    // 스크롤 위치 복원
    body.scrollLeft = S.scroll.left; body.scrollTop = S.scroll.top;
  }

  function tableHtml(snap, qs, students) {
    var compact = isCompact(qs);
    var sync = snap.sync || {};
    var h = ['<table class="rm-table' + (compact ? ' compact' : '') + '" role="grid">'];

    // ── thead: 아이템 밴드 + 문항 번호 ──
    h.push('<thead><tr class="rm-band-row">');
    h.push('<th class="rm-th-name" rowspan="2" scope="col">학생</th>');
    // 연속된 같은 item_index 를 밴드로 묶는다
    var g = 0;
    while (g < qs.length) {
      var idx = qs[g].item_index, span = 0;
      while (g + span < qs.length && qs[g + span].item_index === idx) span++;
      var it = itemByIndex(snap, idx);
      var groupCols = qs.slice(g, g + span);
      var allLow = groupCols.length > 0 && groupCols.every(function (q) { return !!q.low_flag; });
      var title = it ? ((it.index + 1) + '. ' + (it.title || '콘텐츠')) : '문항';
      // 압축 모드에서는 밴드를 좌측 정렬한다 — 가운데 정렬이면 넓은 밴드의 글자가
      // 스크롤 밖(가운데)으로 밀려 "빈 띠"로 보인다(45문항 실측).
      h.push('<th class="rm-band' + (allLow ? ' low' : '') + '" colspan="' + span + '" scope="colgroup" title="' +
             esc(title) + '">' + esc(title) + '</th>');
      g += span;
    }
    h.push('<th class="rm-th-score" rowspan="2" scope="col">점수</th>');
    h.push('</tr><tr class="rm-qno-row">');
    qs.forEach(function (q) {
      var lowCls = q.low_flag ? ' low' : '';
      var cursorCls = (sync.on && sync.current_col === q.col) ? ' cursor' : '';
      var label;
      // 압축 모드: 5의 배수 + 첫 열 + **저조 문항**은 번호를 그대로 보여준다.
      // (저조 문항 번호를 tick 으로 감추면 "어디를 다시 설명하나"를 못 찾는다)
      if (compact && (q.col % 5 !== 0) && q.col !== qs[0].col && !q.low_flag) {
        label = '<span class="tick" aria-hidden="true">·</span>';
      }
      else label = String(q.col);
      var viewers = (!sync.on && num(q.viewing_count) > 0)
        ? '<span class="qno-viewers">' + num(q.viewing_count) + '명</span>' : '';
      h.push('<th class="rm-th-q' + lowCls + cursorCls + '" data-col="' + q.col + '" scope="col" tabindex="0" ' +
             'title="' + esc(q.col + '번 문항' + (q.question_text ? ' — ' + q.question_text : '')) + '">' +
             (q.low_flag ? '<span class="warn" aria-hidden="true">⚠</span>' : '') + label + viewers + '</th>');
    });
    h.push('</tr></thead>');

    // ── tbody: 학생 행 ──
    h.push('<tbody>');
    students.forEach(function (st) {
      h.push('<tr data-user-id="' + st.user_id + '">');
      var p = positionInfo(snap, st);
      h.push('<td class="rm-td-name">' +
        '<button type="button" class="rm-name-btn" data-student="' + st.user_id + '">' +
          '<span class="nm">' + esc(st.display_name || st.username || '학생') + '</span>' +
          '<span class="pos ' + p.cls + '" title="' + esc(p.text) + '">' +
            (p.dot ? '<span class="dot" aria-hidden="true"></span>' : '') + esc(p.text) + '</span>' +
        '</button></td>');
      qs.forEach(function (q) {
        var c = cellByCol(st, q.col);
        var stt = (c && c.state) ? c.state : 'none';
        var here = !!(c && p.online && p.col === q.col);
        var interactive = (stt !== 'none' && stt !== 'norec');
        h.push('<td class="rm-td-q" data-col="' + q.col + '">' +
          '<span class="rm-cell ' + stt + (here ? ' here' : '') + '" role="gridcell" tabindex="-1" ' +
          'data-col="' + q.col + '" data-student="' + st.user_id + '" ' +
          'aria-label="' + esc((st.display_name || '') + ' ' + q.col + '번 문항 ' + (CELL_LABEL[stt] || '')) + '"' +
          (interactive ? '' : ' aria-disabled="true"') + '>' + CELL_ICON[stt] + '</span></td>');
      });
      h.push(scoreCellHtml(st));
      h.push('</tr>');
    });
    h.push('</tbody>');

    // ── tfoot: 문항 정답률 ──
    h.push('<tfoot><tr class="rm-foot">');
    h.push('<td class="rm-td-name">문항 정답률</td>');
    qs.forEach(function (q) {
      var base = num(q.accuracy_base);
      var acc = base > 0 ? num(q.accuracy) + '%' : '—';
      h.push('<td data-col="' + q.col + '"' + (q.low_flag ? ' class="low"' : '') + '>' +
        '<div class="acc">' + acc + '</div>' +
        '<div class="base">' + num(q.correct) + '/' + base + '</div></td>');
    });
    var sm = snap.summary || {};
    var cls = num(sm.class_accuracy_base) > 0 ? ('반 ' + num(sm.class_accuracy) + '%') : '—';
    h.push('<td class="rm-td-score"><div class="acc">' + cls + '</div></td>');
    h.push('</tr></tfoot></table>');
    return h.join('');
  }

  function scoreCellHtml(st) {
    var base = num(st.correct_count) + num(st.wrong_count);
    if (num(st.submitted_items) === 0 || base === 0) {
      return '<td class="rm-td-score none"><div class="sc">—</div><div class="scd">' +
             (num(st.submitted_items) === 0 ? '미제출' : '0 / 0') + '</div></td>';
    }
    return '<td class="rm-td-score"><div class="sc">' + num(st.score_percent) + '%</div>' +
           '<div class="scd">' + num(st.correct_count) + ' / ' + base + '</div></td>';
  }

  // §5-7 위치 줄 표기 규칙 (ON/OFF 공통)
  function positionInfo(snap, st) {
    var p = st.position || {};
    var items = snap.items || [];
    var total = items.length;
    if (!p.online) return { text: '미접속', cls: 'rm-pos-off', dot: false, online: false, col: null };
    // 접속했지만 위치를 아직 모르는 경우 — "1/N" 으로 단정하지 않는다(거짓 표기 방지)
    if (p.item_index === null || p.item_index === undefined) {
      return { text: '접속 중', cls: 'rm-pos-media', dot: false, online: true, col: null };
    }
    if (p.kind === 'done' || (total > 0 && num(p.item_index, -1) >= total)) {
      return { text: '완료 ' + total + '/' + total + ' ✓', cls: 'rm-pos-done', dot: false, online: true, col: null };
    }
    var n = num(p.item_index, 0) + 1;
    var head = n + '/' + (total || n);
    var sync = snap.sync || {};
    if (sync.on && p.following === false) {
      return { text: head + ' · 따라오는 중…', cls: 'rm-pos-behind', dot: false, online: true, col: p.col || null };
    }
    if (p.kind === 'quiz' || p.kind === 'exam') {
      if (p.col !== null && p.col !== undefined) {
        return { text: head + ' · ' + p.col + '번 문항', cls: 'rm-pos-here', dot: true, online: true, col: p.col };
      }
      return { text: head + ' · ' + (p.item_title || '문항'), cls: 'rm-pos-here', dot: true, online: true, col: null };
    }
    var it = itemByIndex(snap, num(p.item_index, 0));
    var label = TYPE_LABEL[(it && it.content_type) || p.kind] || '콘텐츠';
    return { text: head + ' · ' + label + ' 보는 중', cls: 'rm-pos-media', dot: false, online: true, col: null };
  }

  function mobileHtml(snap, qs, students) {
    var h = ['<div class="rm-tabs" role="tablist">'];
    h.push('<button type="button" class="rm-tab" role="tab" data-tab="student" aria-selected="' +
      (S.mobileTab === 'student' ? 'true' : 'false') + '">학생별</button>');
    h.push('<button type="button" class="rm-tab" role="tab" data-tab="question" aria-selected="' +
      (S.mobileTab === 'question' ? 'true' : 'false') + '">문항별</button>');
    h.push('</div>');

    if (S.mobileTab === 'student') {
      students.forEach(function (st) {
        var p = positionInfo(snap, st);
        var base = num(st.correct_count) + num(st.wrong_count);
        var noScore = (num(st.submitted_items) === 0 || base === 0);
        h.push('<button type="button" class="rm-mcard" data-student="' + st.user_id + '">' +
          '<span class="top"><span class="nm">' + esc(st.display_name || st.username || '학생') + '</span>' +
          '<span class="sc' + (noScore ? ' none' : '') + '">' +
            (noScore ? '—' : num(st.score_percent) + '%') + '</span></span>' +
          '<span class="pos ' + p.cls + '" title="' + esc(p.text) + '">' +
            (p.dot ? '<span class="dot" aria-hidden="true"></span>' : '') + esc(p.text) + '</span>' +
          '<span class="badges">' + qs.map(function (q) {
            var c = cellByCol(st, q.col);
            var stt = (c && c.state) ? c.state : 'none';
            var here = !!(c && p.online && p.col === q.col);
            return '<span class="rm-cell ' + stt + (here ? ' here' : '') + '" aria-label="' +
              esc(q.col + '번 ' + (CELL_LABEL[stt] || '')) + '">' + CELL_ICON[stt] + '</span>';
          }).join('') + '</span></button>');
      });
    } else {
      // 모바일 문항별 기본 정렬 = 정답률 낮은 순
      var sorted = qs.slice().sort(function (a, b) {
        var aa = num(a.accuracy_base) > 0 ? num(a.accuracy) : 1000;
        var bb = num(b.accuracy_base) > 0 ? num(b.accuracy) : 1000;
        return aa - bb;
      });
      sorted.forEach(function (q) {
        var base = num(q.accuracy_base);
        var pct = base > 0 ? num(q.accuracy) : 0;
        h.push('<button type="button" class="rm-mq" data-question="' + q.col + '">' +
          '<span class="top"><span class="no' + (q.low_flag ? ' low' : '') + '">' +
            (q.low_flag ? '⚠ ' : '') + q.col + '번</span>' +
          '<span class="qt">' + esc(q.question_text || '') + '</span></span>' +
          '<span class="row"><span class="bar"><span class="' + (q.low_flag ? 'low' : '') +
            '" style="width:' + pct + '%"></span></span>' +
          '<span class="pct">' + (base > 0 ? pct + '%' : '—') + '</span>' +
          '<span class="base">(' + num(q.correct) + '/' + base + ')</span></span></button>');
      });
    }
    return h.join('');
  }

  /* ── 격자 이벤트 (드릴다운 · 키보드 · 툴팁) ───────────────────────────────── */
  function bindGrid(snap, qs) {
    var body = el('rmBody');

    Array.prototype.forEach.call(body.querySelectorAll('.rm-name-btn, .rm-mcard'), function (b) {
      b.addEventListener('click', function () { openStudentSheet(parseInt(b.getAttribute('data-student'), 10), b); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('.rm-th-q, .rm-mq'), function (b) {
      var col = parseInt(b.getAttribute('data-col') || b.getAttribute('data-question'), 10);
      b.addEventListener('click', function () { openQuestionSheet(col, b); });
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuestionSheet(col, b); }
      });
    });

    var cells = Array.prototype.slice.call(body.querySelectorAll('.rm-table .rm-cell'));
    if (cells.length) cells[0].setAttribute('tabindex', '0');
    cells.forEach(function (c) {
      var stt = c.className.replace('rm-cell', '').replace('here', '').trim();
      c.addEventListener('click', function () {
        if (stt === 'none' || stt === 'norec') return;
        openQuestionSheet(parseInt(c.getAttribute('data-col'), 10), c);
      });
      c.addEventListener('keydown', function (e) { onCellKey(e, c, cells, qs); });
      c.addEventListener('mouseenter', function () { showTooltip(c, snap); });
      c.addEventListener('mouseleave', hideTooltip);
      c.addEventListener('focus', function () { S.lastFocusedCell = c; });
    });

    Array.prototype.forEach.call(body.querySelectorAll('.rm-tab'), function (t) {
      t.addEventListener('click', function () {
        S.mobileTab = t.getAttribute('data-tab');
        renderResponseMonitor(S.snapshot);
      });
    });
  }

  function onCellKey(e, cell, cells, qs) {
    var keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '];
    if (keys.indexOf(e.key) < 0) return;
    e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') {
      var stt = cell.className.replace('rm-cell', '').replace('here', '').trim();
      if (stt !== 'none' && stt !== 'norec') openQuestionSheet(parseInt(cell.getAttribute('data-col'), 10), cell);
      return;
    }
    var per = qs.length || 1;
    var i = cells.indexOf(cell);
    var next = i;
    if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowUp') next = i - per;
    else if (e.key === 'ArrowDown') next = i + per;
    if (next < 0 || next >= cells.length) return;
    cells.forEach(function (c) { c.setAttribute('tabindex', '-1'); });
    cells[next].setAttribute('tabindex', '0');
    cells[next].focus();
    if (cells[next].scrollIntoView) cells[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function showTooltip(cell, snap) {
    var tip = el('rmTooltip');
    if (!tip) return;
    var col = parseInt(cell.getAttribute('data-col'), 10);
    var uid = parseInt(cell.getAttribute('data-student'), 10);
    var q = questionByCol(snap, col);
    var st = (snap.students || []).filter(function (s) { return s.user_id === uid; })[0];
    if (!q || !st) return;
    var c = cellByCol(st, col);
    var stt = (c && c.state) ? c.state : 'none';
    var parts = [(st.display_name || '학생'), col + '번 문항', CELL_LABEL[stt] || ''];
    if (c && c.selected_label) parts.push('내 답 ' + c.selected_label);
    // 서술형은 "정답" 이라는 단일 정답이 없다 — 표시하지 않는다(채점 대기 상태)
    if (q.answer_label && q.question_type !== 'essay') parts.push('정답 ' + q.answer_label);
    if (c && c.time_taken_sec) parts.push(c.time_taken_sec + '초');
    tip.textContent = parts.join(' · ');
    tip.classList.add('show');

    var panel = el('respMonitorPanel');
    var pr = panel.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    var top = cr.bottom - pr.top + 8;
    var left = cr.left - pr.left + cr.width / 2 - tip.offsetWidth / 2;
    // 좌·우 가장자리 반전(잘림 방지)
    if (left < 8) left = 8;
    if (left + tip.offsetWidth > pr.width - 8) left = pr.width - tip.offsetWidth - 8;
    if (top + tip.offsetHeight > pr.height - 8) top = cr.top - pr.top - tip.offsetHeight - 8;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }
  function hideTooltip() {
    var tip = el('rmTooltip');
    if (tip) { tip.classList.remove('show'); }
  }

  /* ── 푸터 ─────────────────────────────────────────────────────────────────── */
  function renderFooter(snap, qs) {
    var f = el('rmFooter');
    if (!snap) { f.innerHTML = ''; return; }
    var sm = snap.summary || {};
    var accTxt = num(sm.class_accuracy_base) > 0 ? (num(sm.class_accuracy) + '%') : '—';
    var h = '<span class="rm-foot-summary">학생 ' + num(sm.student_total) + '명 · 제출 ' +
            num(sm.submitted_any) + '명 · 반 평균 정답률 <span title="반 평균 = 전체 정답 수 ÷ (전체 정답 수 + 전체 오답 수)">' +
            accTxt + '</span></span>';

    var low = (qs || []).filter(function (q) { return q.low_flag; });
    if (low.length > 0) {
      h += '<span class="rm-foot-low">⚠ ' + low.map(function (q) {
        return '<button type="button" class="qlink" data-col="' + q.col + '">' + q.col + '</button>';
      }).join('·') + '번 문항의 정답률이 낮아요. 다시 설명이 필요할 수 있어요.</span>';
    }
    h += '<span class="rm-foot-time">' + esc(hhmmss(snap.generated_at)) + ' 갱신</span>';
    f.innerHTML = h;
    Array.prototype.forEach.call(f.querySelectorAll('.qlink'), function (b) {
      b.addEventListener('click', function () { openQuestionSheet(parseInt(b.getAttribute('data-col'), 10), b); });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 드릴다운 시트 (§6) — 패널 내부 우측. 중첩 모달 아님.
   * ═══════════════════════════════════════════════════════════════════════════ */
  function openSheet() {
    var sh = el('rmSheet');
    sh.classList.add('open');
    sh.setAttribute('aria-hidden', 'false');
    var back = el('rmSheetBack');
    if (back) back.focus();
  }
  function closeSheet() {
    var sh = el('rmSheet');
    sh.classList.remove('open');
    sh.setAttribute('aria-hidden', 'true');
    var back = S.sheet && S.sheet.returnTo;
    S.sheet = null;
    if (back && document.contains(back)) back.focus();
    else if (S.lastFocusedCell && document.contains(S.lastFocusedCell)) S.lastFocusedCell.focus();
  }

  function openStudentSheet(userId, returnTo) {
    var prev = S.sheet && S.sheet.returnTo;
    S.sheet = { type: 'student', userId: userId, returnTo: returnTo || prev || null };
    paintStudentSheet(userId);
    openSheet();
  }
  function openQuestionSheet(col, returnTo) {
    var prev = S.sheet && S.sheet.returnTo;
    S.sheet = { type: 'question', col: col, returnTo: returnTo || prev || null };
    paintQuestionSheet(col);
    openSheet();
  }

  function paintStudentSheet(userId) {
    var snap = S.snapshot; if (!snap) return;
    var st = (snap.students || []).filter(function (s) { return s.user_id === userId; })[0];
    if (!st) return;
    el('rmSheetTitle').textContent = st.display_name || st.username || '학생';
    el('rmSheetBadge').hidden = true;
    el('rmSheetFooter').hidden = true;

    var base = num(st.correct_count) + num(st.wrong_count);
    var p = positionInfo(snap, st);
    var h = '';
    if (num(st.submitted_items) === 0) {
      h += '<div class="rm-sheet-meta">현재 위치: ' + esc(p.text) + '</div>';
      h += '<div class="rm-sheet-hr"></div>';
      h += '<div class="rm-empty" style="padding:32px 8px;"><div class="desc" style="margin-bottom:0;">아직 문항을 제출하지 않았어요.</div></div>';
      el('rmSheetBody').innerHTML = h;
      return;
    }
    h += '<div class="rm-sheet-score">' + (base > 0 ? num(st.score_percent) + '%' : '—') +
         '<span class="sub">' + num(st.correct_count) + ' / ' + base + ' 문항 정답</span></div>';
    h += '<div class="rm-sheet-meta">현재 위치: ' + esc(p.text) + '</div>';
    if (st.last_activity_at) h += '<div class="rm-sheet-meta dim">마지막 활동: ' + esc(agoText(st.last_activity_at)) + '</div>';
    h += '<div class="rm-sheet-hr"></div>';

    (snap.questions || []).forEach(function (q) {
      var c = cellByCol(st, q.col);
      var stt = (c && c.state) ? c.state : 'none';
      var ans = '';
      if (c && c.selected_label) ans = '내 답 ' + c.selected_label;
      else if (stt === 'unanswered') ans = '내 답 없음';
      if (q.answer_label && q.question_type !== 'essay') ans += (ans ? '  ·  ' : '') + '정답 ' + q.answer_label;
      h += '<button type="button" class="rm-qrow" data-question="' + q.col + '">' +
        '<span class="no">' + q.col + '</span>' +
        '<span class="mid"><span class="qt">' + esc(q.question_text || '') + '</span>' +
        (ans ? '<span class="ans">' + esc(ans) + '</span>' : '') +
        (c && c.time_taken_sec ? '<span class="sec">' + num(c.time_taken_sec) + '초</span>' : '') +
        '</span>' +
        '<span class="rm-cell ' + stt + '" aria-label="' + esc(CELL_LABEL[stt] || '') + '">' + CELL_ICON[stt] + '</span>' +
        '</button>';
    });
    el('rmSheetBody').innerHTML = h;
    Array.prototype.forEach.call(el('rmSheetBody').querySelectorAll('.rm-qrow'), function (b) {
      b.addEventListener('click', function () { openQuestionSheet(parseInt(b.getAttribute('data-question'), 10)); });
    });
  }

  function paintQuestionSheet(col) {
    var snap = S.snapshot; if (!snap) return;
    var q = questionByCol(snap, col); if (!q) return;
    var base = num(q.accuracy_base);
    el('rmSheetTitle').textContent = col + '번 문항';
    var badge = el('rmSheetBadge');
    badge.hidden = false;
    badge.className = 'rm-sheet-badge' + (q.low_flag ? ' low' : '');
    badge.textContent = (q.low_flag ? '⚠ ' : '') + '정답률 ' + (base > 0 ? num(q.accuracy) + '%' : '—') +
                        ' (' + num(q.correct) + '/' + base + ')';

    var it = itemByIndex(snap, q.item_index);
    var typeLabel = (q.question_type === 'choice' || q.question_type === 'multiple') ? '객관식'
                  : (q.question_type === 'short') ? '단답형'
                  : (q.question_type === 'essay') ? '서술형' : '문항';
    var h = '<div class="rm-qtext">' + esc(q.question_text || '') + '</div>';
    h += '<div class="rm-qmeta">' + esc(((it ? (it.index + 1) + '. ' + (it.title || '콘텐츠') + ' · ' : '')) +
         typeLabel + (q.points ? ' · ' + num(q.points) + '점' : '')) + '</div>';
    h += '<div class="rm-sheet-hr"></div>';

    var dist = q.distribution || [];
    var isChoice = dist.length > 0;
    if (isChoice) {
      var maxCt = Math.max(1, num(q.unanswered), Math.max.apply(null, dist.map(function (d) { return num(d.count); }).concat([1])));
      // 가장 많이 고른 오답(50% 이상 쏠림) 식별
      var wrongTotal = dist.reduce(function (a, d) { return a + (d.is_answer ? 0 : num(d.count)); }, 0);
      var topWrong = null;
      dist.forEach(function (d) {
        if (d.is_answer) return;
        if (wrongTotal > 0 && num(d.count) / wrongTotal >= 0.5 && num(d.count) > 0) {
          if (!topWrong || num(d.count) > num(topWrong.count)) topWrong = d;
        }
      });
      h += '<div class="rm-sec-title">보기별 응답</div>';
      dist.forEach(function (d, i) {
        var w = Math.round(num(d.count) / maxCt * 100);
        h += '<div class="rm-dist-row' + (d.is_answer ? ' is-answer' : '') + '">' +
          '<span class="lb">' + esc((d.label || circled(i)) + (d.is_answer ? ' ✓' : '')) + '</span>' +
          '<span class="bar"><span style="width:' + w + '%"></span></span>' +
          '<span class="ct">' + num(d.count) + '명</span>' +
          (topWrong === d ? '<span class="tag">가장 많이 고른 오답</span>' : '') +
          '</div>';
      });
      var uw = Math.round(num(q.unanswered) / maxCt * 100);
      h += '<div class="rm-dist-row is-blank"><span class="lb">미응답</span>' +
           '<span class="bar"><span style="width:' + uw + '%"></span></span>' +
           '<span class="ct">' + num(q.unanswered) + '명</span></div>';
    } else {
      // 단답형/서술형 — 보기 막대 대신 응답 텍스트 목록
      h += '<div class="rm-sec-title">학생 응답</div>';
      var any = false;
      (snap.students || []).forEach(function (st) {
        var c = cellByCol(st, col);
        if (!c || !c.selected_label) return;
        any = true;
        h += '<div class="rm-txt-ans"><span class="who">' + esc(st.display_name || '학생') + '</span>' +
             esc(c.selected_label) + '</div>';
      });
      if (!any) h += '<div class="rm-sheet-meta dim">아직 제출된 응답이 없어요.</div>';
    }

    h += '<div class="rm-sheet-hr"></div>';
    h += nameChips(snap, col);
    el('rmSheetBody').innerHTML = h;
    Array.prototype.forEach.call(el('rmSheetBody').querySelectorAll('.rm-chip-name'), function (b) {
      b.addEventListener('click', function () { openStudentSheet(parseInt(b.getAttribute('data-student'), 10)); });
    });

    // 하단 액션 — 이 문항으로 전원 이동 (§5-7 ④)
    var foot = el('rmSheetFooter');
    var syncOn = !!(snap.sync && snap.sync.on);
    foot.hidden = false;
    foot.innerHTML = '<button type="button" class="rm-btn rm-btn-primary" id="rmMoveAll"' +
      (syncOn ? '' : ' disabled') + '>이 문항으로 전원 이동</button>' +
      (syncOn ? '' : '<div class="rm-sheet-note">동기화를 시작하면 전원을 이 문항으로 이동시킬 수 있어요.</div>');
    var mb = el('rmMoveAll');
    if (mb && syncOn) mb.addEventListener('click', function () {
      if (typeof S.moveHandler === 'function') {
        S.moveHandler({ col: col, item_index: q.item_index, question: q });
        closeResponseMonitor();
      } else {
        toast('지금은 이동시킬 수 없어요. 수업 플레이어에서 시도해 주세요.', 'warning');
      }
    });
  }

  function nameChips(snap, col) {
    var ok = [], no = [], yet = [];
    (snap.students || []).forEach(function (st) {
      var c = cellByCol(st, col);
      var stt = (c && c.state) ? c.state : 'none';
      if (stt === 'correct') ok.push(st);
      else if (stt === 'wrong') no.push(st);
      else if (stt === 'none') yet.push(st);
    });
    function grp(title, list, cls) {
      if (!list.length) return '';
      return '<div class="rm-name-chips"><span class="grp">' + title + ' (' + list.length + ')</span>' +
        list.map(function (s) {
          return '<button type="button" class="rm-chip-name ' + cls + '" data-student="' + s.user_id + '">' +
                 esc(s.display_name || s.username || '학생') + '</button>';
        }).join('') + '</div>';
    }
    return grp('맞힌 학생', ok, 'correct') + grp('틀린 학생', no, 'wrong') + grp('아직 안 푼 학생', yet, '');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 🔴 fetchResponseMonitor(lessonId) — 취득 전담. 실패 시 오류 상태 반환.
   * ═══════════════════════════════════════════════════════════════════════════ */
  function fetchResponseMonitor(lessonId, opts) {
    opts = opts || {};
    var ctx = resolveCtx(lessonId);
    if (!ctx.classId || !ctx.lessonId) {
      return Promise.resolve({ ok: false, kind: 'error', status: 0,
        message: '수업 정보를 찾을 수 없습니다.' });
    }
    var inc = (opts.includeOutside !== undefined) ? opts.includeOutside : S.includeOutside;
    var url = '/api/lesson/' + encodeURIComponent(ctx.classId) + '/' + encodeURIComponent(ctx.lessonId) +
              '/response-monitor?include_outside=' + (inc ? 1 : 0);
    return fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (r.status === 403) return { ok: false, kind: 'forbidden', status: 403 };
        if (r.status === 401) return { ok: false, kind: 'forbidden', status: 401 };
        if (!/json/i.test(ct)) {
          // 404(미구현)·501 등에서 HTML 이 오는 경우 포함
          return { ok: false, kind: 'error', status: r.status, message: '응답 형식이 올바르지 않습니다.' };
        }
        return r.json().then(function (d) {
          if (r.status === 403) return { ok: false, kind: 'forbidden', status: 403 };
          if (!r.ok || !d || d.success === false) {
            return { ok: false, kind: 'error', status: r.status, message: (d && d.message) || '' };
          }
          return { ok: true, data: d };
        });
      })
      .catch(function (e) {
        return { ok: false, kind: 'error', status: 0, message: (e && e.message) || '네트워크 오류' };
      });
  }

  function resolveCtx(lessonId) {
    var p = new URLSearchParams(location.search);
    return {
      classId: S.ctx.classId || p.get('classId'),
      lessonId: lessonId || S.ctx.lessonId || p.get('lessonId') || p.get('id'),
    };
  }

  function renderFetchError(result) {
    S.error = result || {};
    renderHeader(S.snapshot);
    if (result && result.kind === 'forbidden') {
      renderEmpty('fa-lock', '수업 개설자만 볼 수 있어요',
        '이 수업을 만든 선생님만 학생 응답 현황을 볼 수 있습니다.',
        [{ label: '닫기', cls: 'rm-btn-outline', act: 'close' }]);
    } else {
      renderEmpty('fa-triangle-exclamation warn', '응답 현황을 불러오지 못했어요',
        '잠시 후 다시 시도해 주세요. 계속 안 되면 새로고침 해 보세요.',
        [{ label: '다시 시도', cls: 'rm-btn-primary', act: 'retry' }]);
    }
  }

  /* ── 로딩 스켈레톤 (§7 — 스피너 단독 화면 금지) ───────────────────────────── */
  function renderSkeleton() {
    var rows = 5, cols = 8, h = ['<table class="rm-table" aria-busy="true">'];
    h.push('<thead><tr class="rm-band-row"><th class="rm-th-name" rowspan="2">학생</th>');
    h.push('<th class="rm-band" colspan="' + cols + '"></th>');
    h.push('<th class="rm-th-score" rowspan="2">점수</th></tr><tr class="rm-qno-row">');
    for (var c = 1; c <= cols; c++) h.push('<th class="rm-th-q"></th>');
    h.push('</tr></thead><tbody>');
    for (var r = 0; r < rows; r++) {
      h.push('<tr><td class="rm-td-name"><span class="rm-skel-line" style="width:70%"></span></td>');
      for (var k = 0; k < cols; k++) h.push('<td class="rm-td-q"><span class="rm-skel"></span></td>');
      h.push('<td class="rm-td-score"><span class="rm-skel-line" style="width:60%"></span></td></tr>');
    }
    h.push('</tbody></table>');
    el('rmBody').innerHTML = '<div class="rm-table-view">' + h.join('') + '</div>';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 🔴 openResponseMonitor(lessonId) — 열기 = fetch → render
   * ═══════════════════════════════════════════════════════════════════════════ */
  function openResponseMonitor(lessonId) {
    ensureShell();
    S.opener = document.activeElement;
    var ov = el('respMonitorOverlay');
    ov.classList.add('active');
    S.isOpen = true;
    document.body.style.overflow = 'hidden';
    if (S.sheet) closeSheet();

    renderHeader(S.snapshot);
    renderNotices([]);
    if (S.snapshot) renderResponseMonitor(S.snapshot);   // 이전 스냅샷 즉시 표시(레이아웃 튐 방지)
    else { el('rmToolbar').innerHTML = ''; el('rmFooter').innerHTML = ''; renderSkeleton(); }

    var closeBtn = el('rmCloseBtn');
    if (closeBtn) closeBtn.focus();

    S.loading = true;
    return fetchResponseMonitor(lessonId).then(function (res) {
      S.loading = false;
      if (!S.isOpen) return res;
      if (res.ok) {
        renderResponseMonitor(res.data);
        if (typeof S.onSnapshot === 'function') { try { S.onSnapshot(res.data); } catch (e) {} }
      } else {
        renderFetchError(res);
      }
      return res;
    });
  }

  function refresh() {
    if (!S.isOpen) return Promise.resolve(null);
    return openResponseMonitor(S.ctx.lessonId);
  }

  function closeResponseMonitor() {
    var ov = el('respMonitorOverlay');
    if (!ov) return;
    ov.classList.remove('active');
    S.isOpen = false;
    hideTooltip();
    if (S.sheet) {
      el('rmSheet').classList.remove('open');
      el('rmSheet').setAttribute('aria-hidden', 'true');
      S.sheet = null;
    }
    document.body.style.overflow = '';
    if (S.noticeTimer) { clearTimeout(S.noticeTimer); S.noticeTimer = null; }
    // 포커스 반환 (§4-3 접근성)
    if (S.opener && document.contains(S.opener) && typeof S.opener.focus === 'function') S.opener.focus();
    S.opener = null;
    // 호스트 정리 훅 (§4-3 "소켓 leave emit + 폴링 타이머 clear").
    //   닫는 경로가 5가지(×·Esc·오버레이·빈상태 버튼·전원이동)라 전역 함수를 감싸는 방식으로는
    //   전부 잡히지 않는다 → 여기 한 곳에서만 알린다.
    if (typeof S.onClose === 'function') { try { S.onClose(); } catch (e) {} }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 공개 API
   * ═══════════════════════════════════════════════════════════════════════════ */
  var API = {
    open: openResponseMonitor,
    close: closeResponseMonitor,
    render: renderResponseMonitor,
    fetch: fetchResponseMonitor,
    refresh: refresh,
    /** 픽스처/소켓 스냅샷을 바로 띄운다 (fetch 없음) — 시각 검증·스모크용 */
    openWith: function (snapshot, opts) {
      ensureShell();
      S.opener = document.activeElement;
      el('respMonitorOverlay').classList.add('active');
      S.isOpen = true;
      document.body.style.overflow = 'hidden';
      if (S.sheet) closeSheet();
      renderResponseMonitor(snapshot, opts);
      var b = el('rmCloseBtn'); if (b) b.focus();
      return el('respMonitorPanel');
    },
    setContext: function (ctx) {
      if (!ctx) return;
      if (ctx.classId !== undefined) S.ctx.classId = ctx.classId;
      if (ctx.lessonId !== undefined) S.ctx.lessonId = ctx.lessonId;
    },
    setViewer: function (userId) { S.viewerId = (userId === undefined) ? null : userId; },
    /** 동기화 ON 상태에서 "이 문항으로 전원 이동" 을 처리할 훅 (소켓 차수에서 등록) */
    setMoveHandler: function (fn) { S.moveHandler = (typeof fn === 'function') ? fn : null; },
    /** 스냅샷 도착 시 호스트에 알린다(헤더 배지 갱신 등) */
    setOnSnapshot: function (fn) { S.onSnapshot = (typeof fn === 'function') ? fn : null; },
    /** 팝업이 닫힐 때(어떤 경로로 닫히든) 호스트에 알린다 — 소켓 leave·폴링 정리용 */
    setOnClose: function (fn) { S.onClose = (typeof fn === 'function') ? fn : null; },
    /** 실시간 칩 상태 — null(숨김) | 'live' | 'polling'. 소켓 차수에서 사용 */
    setRealtime: function (mode) { S.realtime = mode || null; if (S.isOpen) renderHeader(S.snapshot); },
    isOpen: function () { return S.isOpen; },
    getSnapshot: function () { return S.snapshot; },
    _state: S,
  };

  global.ResponseMonitor = API;
  // 기획서 §4-1 · §4-2 의 onclick 이 전역 이름을 그대로 부른다
  global.openResponseMonitor = openResponseMonitor;
  global.closeResponseMonitor = closeResponseMonitor;
  global.renderResponseMonitor = renderResponseMonitor;
  global.fetchResponseMonitor = fetchResponseMonitor;
})(window);
