// @ts-check
// test/e2e/response-monitor-smoke.spec.js
// ─────────────────────────────────────────────────────────────────────────────
// 수업꾸러미 "응답 현황" 모니터 — 화면 회귀 박제.
// 기획서: 보고서/기획_수업꾸러미_응답모니터링_v1.md  §12-C(시각) · §12-F(불변식)
//
// 🔴 이 스펙이 성립하는 이유: 렌더(renderResponseMonitor)와 취득(fetchResponseMonitor)이
//    분리돼 있어 **BE API 없이도** 픽스처 스냅샷을 주입해 전 화면을 결정적으로 검사할 수 있다.
//    (ResponseMonitor.openWith(snapshot) = 오버레이 열기 + 순수 렌더)
//
// 박제하는 불변식
//   INV-M4-DOM   렌더된 행의 셀 개수 === 렌더된 문항 열 개수 (희소 배열 금지 / 렌더 회귀)
//   INV-M4-DATA  snapshot.students[].cells.length === snapshot.questions.length
//   INV-M3       화면에 표시된 정답률의 분자·분모가 correct·correct+wrong 과 일치
//   가로스크롤0  데스크탑(1440)·모바일(375) 양쪽, 문항 25·45개 픽스처 포함
//   z-index      팝업이 공통 GNB(9999) 위 — lesson-view 진입점에서 헤더 타이틀 가시
//   빈/오류 상태 안내 문구가 실제로 뜬다
//
// ⚠ 단언을 조건문 안에 가두지 않는다. 루프 앞에 "대상이 0건이 아님"을 먼저 단언한다.
// ⚠ 역주입(감지력 증명) 테스트가 같은 파일 하단에 있다 — 검출기가 진짜로 붉어지는지 확인.
//
//   실행: npx playwright test --config=test/e2e/smoke.config.js
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const STATE_DIR = path.join(__dirname, '.smoke-state');
const teacherState = path.join(STATE_DIR, 'teacher.json');
const FIX_DIR = path.join(__dirname, '..', 'fixtures');
// 증적 스크린샷은 저장소를 더럽히지 않도록 기본값이 OS 임시 폴더다.
const SHOT_DIR = process.env.RM_SHOT_DIR || path.join(os.tmpdir(), 'rm-shots');

const FIXTURES = [
  { key: 'normal',   file: 'response-monitor.normal.json',   label: '①정상(학생5·문항8)' },
  { key: 'empty',    file: 'response-monitor.empty.json',    label: '②빈 상태(아무도 안 풂)' },
  { key: 'sync-off', file: 'response-monitor.sync-off.json', label: '③동기화 OFF(위치 제각각)' },
  { key: 'many',     file: 'response-monitor.many.json',     label: '④문항 25개(필터 칩 발동)' },
  { key: 'pending',  file: 'response-monitor.pending.json',  label: '⑤서술형 채점 대기(△)' },
  { key: 'compact',  file: 'response-monitor.compact.json',  label: '⑥문항 45개(압축 모드)' },
];

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(FIX_DIR, file), 'utf8'));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 순수 검출기 — DOM 에서 뽑은 값만 받아 위반 목록을 돌려준다.
 * (역주입 테스트가 이 함수들에 고의로 깨진 입력을 먹여 "진짜 붉어지는지" 증명한다)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** INV-M4-DOM: 모든 행의 셀 개수가 헤더 문항 열 개수와 같아야 한다. */
function violationsCellCount(grid) {
  const out = [];
  if (!grid || !Array.isArray(grid.rows)) return ['grid 없음'];
  if (grid.headerCols <= 0) out.push(`헤더 문항 열이 0개`);
  if (grid.rows.length === 0) out.push(`학생 행이 0개`);
  grid.rows.forEach((r) => {
    if (r.cells !== grid.headerCols) {
      out.push(`${r.name}: 셀 ${r.cells} !== 문항 열 ${grid.headerCols}`);
    }
  });
  return out;
}

/** INV-M4-DATA: 스냅샷의 cells 가 문항 수만큼 꽉 차 있어야 한다(희소 배열 금지). */
function violationsSparseCells(snapshot) {
  const out = [];
  const nQ = (snapshot.questions || []).length;
  if (nQ <= 0) out.push('questions 가 0건');
  const students = snapshot.students || [];
  if (students.length === 0) out.push('students 가 0건');
  students.forEach((s) => {
    if ((s.cells || []).length !== nQ) {
      out.push(`${s.display_name}: cells ${(s.cells || []).length} !== questions ${nQ}`);
    }
  });
  return out;
}

/** INV-M3: 화면 정답률 셀의 "P%" 와 "correct/base" 가 스냅샷 수치와 일치해야 한다. */
function violationsAccuracy(footCells, questions) {
  const out = [];
  if (!footCells || footCells.length === 0) return ['정답률 셀 0건'];
  const byCol = new Map(questions.map((q) => [q.col, q]));
  footCells.forEach((fc) => {
    const q = byCol.get(fc.col);
    if (!q) { out.push(`col ${fc.col}: 스냅샷에 없는 열`); return; }
    const base = q.correct + q.wrong;
    if (q.accuracy_base !== base) {
      out.push(`col ${fc.col}: accuracy_base ${q.accuracy_base} !== correct+wrong ${base}`);
    }
    if (fc.num !== q.correct || fc.den !== base) {
      out.push(`col ${fc.col}: 화면 분자·분모 ${fc.num}/${fc.den} !== ${q.correct}/${base}`);
    }
    const expectedPct = base > 0 ? String(q.accuracy) + '%' : '—';
    if (fc.pct !== expectedPct) {
      out.push(`col ${fc.col}: 화면 정답률 "${fc.pct}" !== 기대 "${expectedPct}"`);
    }
  });
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 페이지 헬퍼
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 격자에서 검사용 값을 추출한다. */
const EXTRACT = () => {
  const q = (s, r) => (r || document).querySelectorAll(s);
  const headerCols = q('#rmBody .rm-table thead .rm-th-q').length;
  const rows = Array.from(q('#rmBody .rm-table tbody tr')).map((tr) => ({
    name: (tr.querySelector('.rm-td-name .nm') || {}).textContent || '?',
    cells: tr.querySelectorAll('.rm-td-q').length,
  }));
  const footCells = Array.from(q('#rmBody .rm-table tfoot td[data-col]')).map((td) => {
    const pct = ((td.querySelector('.acc') || {}).textContent || '').trim();
    const baseTxt = ((td.querySelector('.base') || {}).textContent || '').trim();
    const m = baseTxt.match(/^(\d+)\s*\/\s*(\d+)$/);
    return {
      col: parseInt(td.getAttribute('data-col'), 10),
      pct,
      num: m ? parseInt(m[1], 10) : null,
      den: m ? parseInt(m[2], 10) : null,
    };
  });
  const de = document.documentElement;
  const body = document.getElementById('rmBody');
  const panel = document.getElementById('respMonitorPanel');
  const ov = document.getElementById('respMonitorOverlay');
  const text = panel ? (panel.innerText || '') : '';
  return {
    headerCols, rows, footCells,
    mobileCards: q('#rmBody .rm-mobile .rm-mcard').length,
    mobileBadgesFirst: q('#rmBody .rm-mobile .rm-mcard')[0]
      ? q('#rmBody .rm-mobile .rm-mcard')[0].querySelectorAll('.rm-cell').length : 0,
    tableViewShown: (() => {
      const tv = document.querySelector('#rmBody .rm-table-view');
      return !!tv && getComputedStyle(tv).display !== 'none';
    })(),
    docScrollWidth: de.scrollWidth, docClientWidth: de.clientWidth,
    bodyScrollWidth: body ? body.scrollWidth : 0, bodyClientWidth: body ? body.clientWidth : 0,
    overlayZ: ov ? parseInt(getComputedStyle(ov).zIndex, 10) : 0,
    objObj: (text.match(/\[object Object\]/g) || []).length,
    nan: (text.match(/NaN/g) || []).length,
    brokenPct: text.match(/\b[1-9]\d{3,}\s*%/g) || [],
    footerText: (document.getElementById('rmFooter') || {}).innerText || '',
    noticeText: (document.getElementById('rmNotices') || {}).innerText || '',
    emptyText: document.querySelector('#rmBody .rm-empty')
      ? document.querySelector('#rmBody .rm-empty').innerText : '',
  };
};

/**
 * 화면이 "그려질 준비" 될 때까지 기다린다.
 * 고정 타임아웃(600ms)은 첫 실행에서 실제로 플레이키했다 — 조건 대기로 바꾼다.
 */
async function waitReady(page) {
  await page.waitForFunction(() => !!window.ResponseMonitor, null, { timeout: 15000 });
  // lesson-view 는 loadLesson() 이 끝나야 #mainContent 가 보인다
  await page.waitForFunction(() => {
    const m = document.getElementById('mainContent');
    return !m || m.style.display !== 'none';
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function openWithFixture(page, snapshot) {
  await page.evaluate((snap) => {
    // 모듈 상태를 매 케이스마다 초기화(자동 필터·압축 토글이 이전 케이스에 오염되지 않게)
    const S = window.ResponseMonitor._state;
    S.selectedItem = null; S.lowOnly = false; S.compact = null;
    S.autoFilterAppliedFor = null; S.mobileTab = 'student'; S.sort = 'name';
    window.ResponseMonitor.setViewer(2);
    window.ResponseMonitor.openWith(snap);
  }, snapshot);
  await page.waitForSelector('#respMonitorOverlay.active', { timeout: 5000 });
  await page.waitForTimeout(250);
}

/** teacher1 의 (classId, lessonId) 해석 — 두 진입점 URL 을 만들기 위해 필요 */
async function resolveLesson(browser) {
  const ctx = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
  try {
    const page = await ctx.newPage();
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    const found = await page.evaluate(async () => {
      const today = new Date().toISOString().slice(0, 10);
      const me = await (await fetch('/api/auth/me')).json();
      const myId = me && me.user && me.user.id;
      const my = await (await fetch('/api/class/my')).json();
      const classes = (my && (my.classes || my)) || [];
      for (const c of classes) {
        const r = await fetch(`/api/lesson/${c.id}`);
        if (!r.ok) continue;
        const d = await r.json();
        const lessons = (d && d.lessons) || [];
        // 개설자 본인 + 이미 시작된 수업만 (예정 수업은 두 화면 모두 리다이렉트한다)
        const ok = lessons.find((l) => {
          if (myId && l.teacher_id !== myId) return false;
          const sd = l.start_date || l.lesson_date;
          return !sd || sd <= today;
        });
        if (ok) return { classId: c.id, lessonId: ok.id };
      }
      return null;
    });
    await page.close();
    return found;
  } finally {
    await ctx.close();
  }
}

function shot(page, name) {
  try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch (_) {}
  return page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1) 픽스처 6종 × 데스크탑/모바일 — 격자·불변식·가로스크롤
 * ═══════════════════════════════════════════════════════════════════════════ */
test.describe('응답 현황 모니터: 픽스처 렌더', () => {
  let ctxIds = null;

  test.beforeAll(async ({ browser }) => {
    ctxIds = await resolveLesson(browser);
  });

  for (const fx of FIXTURES) {
    for (const vp of [{ name: 'desktop', width: 1440, height: 900 },
                      { name: 'mobile', width: 375, height: 812 }]) {
      test(`${fx.label} [${vp.name}]`, async ({ browser }) => {
        expect(ctxIds, 'teacher1 소속 클래스의 수업을 찾지 못했습니다(테스트 전제 붕괴)').toBeTruthy();
        const snapshot = loadFixture(fx.file);

        // ── INV-M4-DATA: 픽스처(=BE 계약) 자체가 희소 배열이 아님 ──
        expect(violationsSparseCells(snapshot), `${fx.label} INV-M4-DATA 위반`).toEqual([]);

        const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
        const errors = [];
        try {
          const page = await context.newPage();
          await page.setViewportSize({ width: vp.width, height: vp.height });
          page.on('pageerror', (e) => errors.push(String(e.message)));
          page.on('console', (m) => {
            if (m.type() !== 'error') return;
            const t = m.text();
            if (/favicon|net::ERR_|status of 40[34]|chrome-extension:/i.test(t)) return;
            errors.push(t);
          });

          await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
            { waitUntil: 'domcontentloaded' });
          await waitReady(page);

          await openWithFixture(page, snapshot);
          const g = await page.evaluate(EXTRACT);
          await shot(page, `${fx.key}-${vp.name}`);

          // ── 가로 스크롤 0 (문서 전체). 표의 가로 스크롤은 .rm-body 안에서만 허용 ──
          expect(g.docScrollWidth,
            `${fx.label}[${vp.name}] 가로 스크롤: ${g.docScrollWidth} > ${g.docClientWidth}`)
            .toBeLessThanOrEqual(g.docClientWidth + 1);

          // ── 팝업 z-index — 공통 GNB(9999) 위 ──
          expect(g.overlayZ, `${fx.label}[${vp.name}] 오버레이 z-index`).toBeGreaterThanOrEqual(10000);

          // ── 깨짐 0 ──
          expect(g.objObj, `${fx.label}[${vp.name}] [object Object]`).toBe(0);
          expect(g.nan, `${fx.label}[${vp.name}] NaN 표기`).toBe(0);
          expect(g.brokenPct, `${fx.label}[${vp.name}] 깨진 백분율`).toEqual([]);

          if (vp.name === 'desktop') {
            // ── INV-M4-DOM (데스크탑 격자) ──
            expect(g.headerCols, `${fx.label} 문항 열 0개`).toBeGreaterThan(0);
            expect(g.rows.length, `${fx.label} 학생 행 0개`).toBeGreaterThan(0);
            expect(violationsCellCount(g), `${fx.label} INV-M4-DOM 위반`).toEqual([]);

            // ── INV-M3 (표시 분자·분모 ↔ 집계) ──
            expect(g.footCells.length, `${fx.label} 정답률 셀 0건`).toBeGreaterThan(0);
            expect(violationsAccuracy(g.footCells, snapshot.questions),
              `${fx.label} INV-M3 위반`).toEqual([]);
          } else {
            // ── 모바일: 표를 버리고 2탭 카드. 배지는 전 문항이 wrap 으로 감긴다 ──
            expect(g.tableViewShown, `${fx.label} 모바일에서 표가 남아 있음`).toBeFalsy();
            expect(g.mobileCards, `${fx.label} 모바일 카드 0건`).toBe(snapshot.students.length);
            expect(g.mobileBadgesFirst, `${fx.label} 모바일 배지 수 !== 문항 수`)
              .toBe(snapshot.questions.length);
          }
          await page.close();
        } finally {
          await context.close();
        }
        // teardown 세그폴트로 리포터 요약이 유실되는 환경이라, 원인 추적이 필요할 때는
        // RM_DEBUG_LOG=<파일> 로 수집한 콘솔 에러를 그대로 남긴다.
        if (process.env.RM_DEBUG_LOG) {
          fs.appendFileSync(process.env.RM_DEBUG_LOG,
            JSON.stringify({ fx: fx.key, vp: vp.name, errors }) + '\n', 'utf8');
        }
        expect(errors, `${fx.label}[${vp.name}] 콘솔/JS 에러`).toEqual([]);
      });
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2) 진입점 · z-index · 상태 문구
 * ═══════════════════════════════════════════════════════════════════════════ */
test.describe('응답 현황 모니터: 진입점 · 상태', () => {
  let ctxIds = null;
  test.beforeAll(async ({ browser }) => { ctxIds = await resolveLesson(browser); });

  test('lesson-view(GNB 있음): 팝업 헤더가 GNB 에 가리지 않는다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      await openWithFixture(page, loadFixture('response-monitor.normal.json'));

      const z = await page.evaluate(() => {
        const gnb = document.getElementById('dacheum-gnb-wrapper');
        const ov = document.getElementById('respMonitorOverlay');
        const panel = document.getElementById('respMonitorPanel');
        const t = document.getElementById('rmTitle').getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(t.left + t.width / 2), Math.round(t.top + t.height / 2));
        const close = document.getElementById('rmCloseBtn').getBoundingClientRect();
        // 닫기 버튼 중심 반경 40px 8방위에 배지/칩/라벨이 없어야 한다 (C-1)
        const cx = close.left + close.width / 2, cy = close.top + close.height / 2;
        const probes = [];
        for (let a = 0; a < 360; a += 45) {
          const e = document.elementFromPoint(
            Math.round(cx + 40 * Math.cos(a * Math.PI / 180)),
            Math.round(cy + 40 * Math.sin(a * Math.PI / 180)));
          probes.push(e ? String(e.className || e.tagName) : '');
        }
        return {
          gnbExists: !!gnb,
          gnbZ: gnb ? parseInt(getComputedStyle(gnb).zIndex, 10) : 0,
          overlayZ: parseInt(getComputedStyle(ov).zIndex, 10),
          titleTop: Math.round(t.top),
          titleVisible: panel.contains(hit),
          hitCls: hit ? String(hit.className) : '',
          probes,
        };
      });
      await shot(page, 'entry-lesson-view-gnb');

      expect(z.gnbExists, 'lesson-view 에 공통 GNB 가 있어야 한다(전제)').toBeTruthy();
      expect(z.overlayZ, `팝업 z-index(${z.overlayZ})가 GNB(${z.gnbZ}) 아래`).toBeGreaterThan(z.gnbZ);
      expect(z.titleVisible, `팝업 제목이 다른 요소(${z.hitCls})에 가려짐`).toBeTruthy();
      // 닫기 안전영역: 반경 40px 에 칩/배지/라벨 류가 없어야 한다
      const bad = z.probes.filter((c) => /rm-chip|rm-title|rm-subtitle|monitor-badge/.test(c));
      expect(bad, `닫기 버튼 40px 안전영역 침범: ${JSON.stringify(bad)}`).toEqual([]);
      await page.close();
    } finally { await context.close(); }
  });

  test('lesson-player(GNB 없음): 교사에게 헤더 버튼이 보이고 팝업이 사이드바를 덮는다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-player.html?classId=${ctxIds.classId}&lessonId=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      // 플레이어는 lessonData 로드 후 updateMonitorBtn() 이 버튼을 켠다
      await page.waitForFunction(() => {
        const b = document.getElementById('monitorBtn');
        return !!b && b.style.display !== 'none';
      }, null, { timeout: 15000 }).catch(() => {});

      const btn = await page.evaluate(() => {
        const b = document.getElementById('monitorBtn');
        return b ? {
          visible: !!(b.offsetWidth || b.offsetHeight),
          label: b.innerText.trim(),
          fontSize: parseFloat(getComputedStyle(b).fontSize),
          height: Math.round(b.getBoundingClientRect().height),
        } : null;
      });
      expect(btn, '#monitorBtn 이 없다').toBeTruthy();
      expect(btn.visible, '교사에게 응답 현황 버튼이 보이지 않는다').toBeTruthy();
      expect(btn.label).toContain('응답 현황');
      // 버튼 라벨 줄바꿈 0 — 한 줄 높이(≤ 40px)
      expect(btn.height, `헤더 버튼이 2줄로 접힘(h=${btn.height})`).toBeLessThanOrEqual(40);

      await openWithFixture(page, loadFixture('response-monitor.normal.json'));
      const cov = await page.evaluate(() => {
        const panel = document.getElementById('respMonitorPanel');
        const sb = document.querySelector('.sidebar');
        const r = sb ? sb.getBoundingClientRect() : null;
        const hit = r ? document.elementFromPoint(Math.round(r.left + r.width / 2),
                                                  Math.round(r.top + r.height / 2)) : null;
        const de = document.documentElement;
        return {
          hasSidebar: !!sb,
          covered: hit ? (panel.contains(hit) || hit.id === 'respMonitorOverlay') : false,
          doc: [de.scrollWidth, de.clientWidth],
          overlayZ: parseInt(getComputedStyle(document.getElementById('respMonitorOverlay')).zIndex, 10),
        };
      });
      await shot(page, 'entry-lesson-player');
      expect(cov.hasSidebar, 'lesson-player 사이드바가 없다(전제)').toBeTruthy();
      expect(cov.covered, '팝업이 사이드바를 덮지 못했다').toBeTruthy();
      expect(cov.doc[0]).toBeLessThanOrEqual(cov.doc[1] + 1);
      expect(cov.overlayZ).toBeGreaterThanOrEqual(10000);
      await page.close();
    } finally { await context.close(); }
  });

  test('오류 상태: API 미구현(404)이면 안내 문구가 뜬다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);

      // 실제 취득 경로를 탄다. BE 가 붙으면 200 이 되어 이 테스트는 아래 분기로 갈린다.
      const r = await page.evaluate(async () => {
        const res = await window.ResponseMonitor.open();
        await new Promise((x) => setTimeout(x, 300));
        return {
          ok: !!(res && res.ok),
          status: res ? res.status : null,
          bodyText: document.getElementById('rmBody').innerText,
          active: document.getElementById('respMonitorOverlay').classList.contains('active'),
        };
      });
      await shot(page, 'state-fetch-error');
      expect(r.active, '팝업이 열리지 않았다').toBeTruthy();
      // BE 구현 전: 오류 안내 / BE 구현 후: 격자. 둘 중 하나는 반드시 그려져야 한다.
      const drewError = /응답 현황을 불러오지 못했어요|수업 개설자만 볼 수 있어요/.test(r.bodyText);
      const drewGrid = /문항 정답률|문항이 없어요|학생이 없어요/.test(r.bodyText);
      expect(drewError || drewGrid,
        `취득 실패/성공 어느 쪽도 그리지 못했다(빈 화면). 본문="${r.bodyText.slice(0, 120)}"`).toBeTruthy();
      await page.close();
    } finally { await context.close(); }
  });

  test('빈 상태: 아무도 안 풀었으면 안내 띠가 뜨고 표는 유지된다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      const snap = loadFixture('response-monitor.empty.json');
      await openWithFixture(page, snap);
      const g = await page.evaluate(EXTRACT);
      await shot(page, 'state-empty-notice');
      expect(g.noticeText).toContain('아직 제출한 학생이 없어요');
      expect(g.rows.length, '빈 상태에서도 표는 그려져야 한다').toBe(snap.students.length);
      expect(violationsCellCount(g), 'INV-M4-DOM 위반').toEqual([]);

      // 문항 0개 / 학생 0명 빈 상태
      const texts = await page.evaluate((s) => {
        const noQ = JSON.parse(JSON.stringify(s));
        noQ.questions = []; noQ.students.forEach((st) => { st.cells = []; });
        window.ResponseMonitor.openWith(noQ);
        const a = document.querySelector('#rmBody .rm-empty').innerText;
        const noS = JSON.parse(JSON.stringify(s));
        noS.students = [];
        window.ResponseMonitor.openWith(noS);
        const b = document.querySelector('#rmBody .rm-empty').innerText;
        return { noQ: a, noS: b };
      }, snap);
      expect(texts.noQ).toContain('이 수업꾸러미에는 문항이 없어요');
      expect(texts.noS).toContain('아직 이 클래스에 학생이 없어요');
      await page.close();
    } finally { await context.close(); }
  });

  test('드릴다운 2종: 패널 내부 시트로 열리고 중첩되지 않는다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      await openWithFixture(page, loadFixture('response-monitor.normal.json'));

      await page.click('#rmBody .rm-table tbody .rm-name-btn');
      await page.waitForTimeout(350);
      const s1 = await page.evaluate(() => {
        const sh = document.getElementById('rmSheet');
        const p = document.getElementById('respMonitorPanel').getBoundingClientRect();
        const r = sh.getBoundingClientRect();
        return {
          open: sh.classList.contains('open'),
          z: parseInt(getComputedStyle(sh).zIndex, 10),
          insidePanel: Math.round(r.right) <= Math.round(p.right) + 1 && Math.round(r.top) >= Math.round(p.top) - 1,
          sheets: document.querySelectorAll('.rm-sheet').length,
          title: document.getElementById('rmSheetTitle').textContent,
        };
      });
      await shot(page, 'drilldown-student');
      expect(s1.open).toBeTruthy();
      expect(s1.z).toBe(10001);
      expect(s1.insidePanel, '시트가 패널 밖으로 나갔다(중첩 모달 금지)').toBeTruthy();
      expect(s1.sheets, '시트가 중첩 생성됐다').toBe(1);
      expect(s1.title.length).toBeGreaterThan(0);

      // 문항 시트로 교체
      await page.click('#rmSheetBody .rm-qrow');
      await page.waitForTimeout(350);
      const s2 = await page.evaluate(() => ({
        sheets: document.querySelectorAll('.rm-sheet').length,
        title: document.getElementById('rmSheetTitle').textContent,
        badge: document.getElementById('rmSheetBadge').textContent,
        footer: document.getElementById('rmSheetFooter').innerText,
        moveDisabled: document.getElementById('rmMoveAll').disabled,
        dist: document.querySelectorAll('#rmSheetBody .rm-dist-row').length,
      }));
      await shot(page, 'drilldown-question');
      expect(s2.sheets, '문항 시트가 중첩 생성됐다').toBe(1);
      expect(s2.title).toContain('번 문항');
      expect(s2.badge).toContain('정답률');
      expect(s2.dist, '보기별 응답 분포가 비었다').toBeGreaterThan(0);
      // normal 픽스처는 동기화 ON → 전원 이동 활성
      expect(s2.moveDisabled, '동기화 ON 인데 [전원 이동]이 비활성').toBeFalsy();

      // Esc 2단계: 시트만 → 팝업
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const afterEsc1 = await page.evaluate(() => ({
        sheet: document.getElementById('rmSheet').classList.contains('open'),
        popup: window.ResponseMonitor.isOpen(),
      }));
      expect(afterEsc1.sheet).toBeFalsy();
      expect(afterEsc1.popup).toBeTruthy();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => window.ResponseMonitor.isOpen())).toBeFalsy();
      await page.close();
    } finally { await context.close(); }
  });

  // 회귀 박제: `.rm-td-name .pos{color}` 처럼 컨테이너 규칙(0,2,0)이 `.rm-pos-*`(0,1,0)를
  // 눌러 위치 색 코딩이 통째로 회색이 된 실측 결함. 색은 전경값으로만 검증 가능하다.
  test('위치 색 코딩: 문항 파랑 / 따라오는 중 주황 / 미접속 회색 (표·모바일 공통)', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      await openWithFixture(page, loadFixture('response-monitor.normal.json'));

      const colors = await page.evaluate(() => {
        const grab = (scope) => {
          const out = {};
          ['rm-pos-here', 'rm-pos-behind', 'rm-pos-off', 'rm-pos-media', 'rm-pos-done'].forEach((c) => {
            const e = document.querySelector(`${scope} .pos.${c}`);
            out[c] = e ? getComputedStyle(e).color : null;
          });
          return out;
        };
        return { table: grab('#rmBody .rm-table tbody .rm-td-name'), mobile: grab('#rmBody .rm-mcard') };
      });

      // normal 픽스처는 here / behind / off 세 상태를 모두 갖는다(전제)
      for (const view of ['table', 'mobile']) {
        const c = colors[view];
        expect(c['rm-pos-here'], `${view}: 문항 위치 줄이 없다(전제 붕괴)`).toBeTruthy();
        expect(c['rm-pos-behind'], `${view}: 따라오는 중 줄이 없다(전제 붕괴)`).toBeTruthy();
        expect(c['rm-pos-off'], `${view}: 미접속 줄이 없다(전제 붕괴)`).toBeTruthy();
        expect(c['rm-pos-here'], `${view}: 문항 위치가 파랑(#1d4ed8)이 아님`).toBe('rgb(29, 78, 216)');
        expect(c['rm-pos-behind'], `${view}: 따라오는 중이 주황(#c2410c)이 아님`).toBe('rgb(194, 65, 12)');
        expect(c['rm-pos-off'], `${view}: 미접속이 회색(#9ca3af)이 아님`).toBe('rgb(156, 163, 175)');
        expect(new Set([c['rm-pos-here'], c['rm-pos-behind'], c['rm-pos-off']]).size,
          `${view}: 위치 색이 한 색으로 뭉개짐(컨테이너 규칙이 .rm-pos-* 를 눌렀다)`).toBe(3);
      }
      await shot(page, 'position-colors');
      await page.close();
    } finally { await context.close(); }
  });

  test('동기화 OFF: 학생 위치가 제각각이고 [전원 이동]이 비활성 + 안내가 뜬다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      await openWithFixture(page, loadFixture('response-monitor.sync-off.json'));

      const v = await page.evaluate(() => {
        const posTexts = Array.from(document.querySelectorAll('#rmBody .rm-table tbody .rm-td-name .pos'))
          .map((e) => e.textContent.trim());
        document.querySelector('#rmBody .rm-table thead .rm-th-q').click();
        return {
          mode: document.getElementById('rmModeChip').textContent,
          posTexts,
          distinct: new Set(posTexts).size,
        };
      });
      await page.waitForTimeout(300);
      const f = await page.evaluate(() => ({
        disabled: document.getElementById('rmMoveAll').disabled,
        note: document.getElementById('rmSheetFooter').innerText,
      }));
      await shot(page, 'sync-off');
      expect(v.mode).toBe('자유 진행');
      expect(v.posTexts.length).toBeGreaterThan(0);
      expect(v.distinct, `동기화 OFF 인데 위치가 전부 같다: ${JSON.stringify(v.posTexts)}`).toBeGreaterThan(1);
      expect(f.disabled, '동기화 OFF 인데 [전원 이동]이 활성').toBeTruthy();
      expect(f.note).toContain('동기화를 시작하면');
      await page.close();
    } finally { await context.close(); }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3) 🔴 역주입 — 검출기가 실제로 붉어지는지 (감지력 0 방지)
 *    "안 붉어졌다" 를 안전 근거로 쓰지 않기 위해, 고의로 깨뜨린 입력에 대해
 *    검출기가 반드시 위반을 뱉어야 함을 단언한다.
 * ═══════════════════════════════════════════════════════════════════════════ */
test.describe('응답 현황 모니터: 역주입(검출기 감지력)', () => {
  let ctxIds = null;
  test.beforeAll(async ({ browser }) => { ctxIds = await resolveLesson(browser); });

  test('INV-M4-DATA 검출기는 희소 cells 를 잡는다', () => {
    const snap = loadFixture('response-monitor.normal.json');
    expect(violationsSparseCells(snap)).toEqual([]);               // 정상은 통과
    const broken = JSON.parse(JSON.stringify(snap));
    broken.students[1].cells.pop();                                // 셀 1개 제거
    const v = violationsSparseCells(broken);
    expect(v.length, '희소 배열을 못 잡았다 = 감지력 0').toBeGreaterThan(0);
    expect(v.join(' ')).toContain('cells 7 !== questions 8');
  });

  test('INV-M3 검출기는 어긋난 분자·분모/정답률을 잡는다', () => {
    const snap = loadFixture('response-monitor.normal.json');
    const good = snap.questions.map((q) => ({
      col: q.col, pct: q.accuracy_base > 0 ? q.accuracy + '%' : '—',
      num: q.correct, den: q.accuracy_base,
    }));
    expect(violationsAccuracy(good, snap.questions)).toEqual([]);   // 정상은 통과

    // (a) 화면 분모만 어긋남
    const badDen = JSON.parse(JSON.stringify(good));
    badDen[0].den = badDen[0].den + 1;
    expect(violationsAccuracy(badDen, snap.questions).length,
      '분모 불일치를 못 잡았다 = 감지력 0').toBeGreaterThan(0);

    // (b) 화면 % 만 어긋남
    const badPct = JSON.parse(JSON.stringify(good));
    badPct[1].pct = '99%';
    expect(violationsAccuracy(badPct, snap.questions).length,
      '정답률 불일치를 못 잡았다 = 감지력 0').toBeGreaterThan(0);

    // (c) 스냅샷의 accuracy_base 가 correct+wrong 과 다름 (BE 계약 위반)
    const badSnap = JSON.parse(JSON.stringify(snap));
    badSnap.questions[2].accuracy_base = badSnap.questions[2].accuracy_base + 3;
    expect(violationsAccuracy(good, badSnap.questions).length,
      'accuracy_base 계약 위반을 못 잡았다 = 감지력 0').toBeGreaterThan(0);
  });

  test('INV-M4-DOM 검출기는 셀이 빠진 행을 잡는다 (실제 DOM 훼손)', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      await openWithFixture(page, loadFixture('response-monitor.normal.json'));

      const before = await page.evaluate(EXTRACT);
      expect(violationsCellCount(before), '정상 렌더인데 위반이 나왔다').toEqual([]);

      // 두 번째 행에서 셀 하나를 물리적으로 제거한다
      await page.evaluate(() => {
        const tr = document.querySelectorAll('#rmBody .rm-table tbody tr')[1];
        tr.querySelector('.rm-td-q').remove();
      });
      const after = await page.evaluate(EXTRACT);
      const v = violationsCellCount(after);
      expect(v.length, 'DOM 에서 셀을 뺐는데 검출기가 조용하다 = 감지력 0').toBeGreaterThan(0);
      expect(v.join(' ')).toMatch(/셀 7 !== 문항 열 8/);
      await page.close();
    } finally { await context.close(); }
  });

  test('가로 스크롤 검출기는 실제 오버플로를 잡는다', async ({ browser }) => {
    expect(ctxIds).toBeTruthy();
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/class/lesson-view.html?classId=${ctxIds.classId}&id=${ctxIds.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await waitReady(page);
      await openWithFixture(page, loadFixture('response-monitor.compact.json'));

      const ok = await page.evaluate(EXTRACT);
      expect(ok.docScrollWidth, '정상 상태인데 가로 스크롤이 있다')
        .toBeLessThanOrEqual(ok.docClientWidth + 1);

      // 팝업 안에 강제로 넓은 요소를 심어 오버플로를 만든다
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = '__rmOverflowProbe';
        d.style.cssText = 'position:absolute;left:0;top:0;width:4000px;height:4px;';
        document.body.appendChild(d);
      });
      await page.waitForTimeout(120);
      const bad = await page.evaluate(EXTRACT);
      expect(bad.docScrollWidth,
        '4000px 요소를 심었는데 scrollWidth 가 안 늘었다 = 감지력 0')
        .toBeGreaterThan(bad.docClientWidth + 1);
      await page.evaluate(() => { const e = document.getElementById('__rmOverflowProbe'); if (e) e.remove(); });
      await page.close();
    } finally { await context.close(); }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 사용자 지시(2026-08-21) 회귀 박제 — 열 비례 · 가로 스크롤 · 별도 창
 *
 *   "학생 이름 너비가 너무 크고 문항 번호는 너무 작고"
 *   "문항이 많으면 가로 스크롤도 생기게 해"
 *   "응답현황은 레이어 팝업 말고 그냥 팝업으로 띄우는게 나을듯"
 *
 * 🔴 INV-M8 이 지키는 것: auto 테이블 레이아웃에서 여유 폭은 **점수 열**(width:100%)이
 *    흡수해야 한다. 그 선언이 사라지면 여유가 내용이 가장 넓은 학생 열로 몰려
 *    435px 까지 부푼다(실측으로 잡은 결함). 폭이 밀리면 이 테스트가 붉어진다.
 * ═══════════════════════════════════════════════════════════════════════════ */
const RM_NAME_W = 160;   // .rm-th-name/.rm-td-name 고정 폭
const RM_Q_W    = 68;    // .rm-th-q/.rm-td-q 고정 폭
const RM_QNO_PX = 18;    // 문항 번호 글자 크기(본문 16px 보다 커야 스캔된다)

test.describe('응답 현황 모니터: 열 비례 · 가로 스크롤 · 별도 창', () => {
  test('INV-M8: 학생 열·문항 열이 고정 폭을 지키고 여유 폭은 점수 열이 흡수한다', async ({ browser }) => {
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoMonitorHost(page, browser);
      // 문항 4개 = 여유가 가장 많이 남는 조건(= 학생 열이 부풀던 조건)
      await openWithFixture(page, shrinkQuestions(loadFixture('response-monitor.normal.json'), 4));

      const m = await page.evaluate(() => {
        const g = (s) => document.querySelector(s);
        const w = (s) => { const e = g(s); return e ? Math.round(e.getBoundingClientRect().width) : -1; };
        return {
          name: w('.rm-td-name'), q: w('.rm-th-q'), score: w('.rm-td-score'),
          qno: g('.rm-th-q') ? getComputedStyle(g('.rm-th-q')).fontSize : null,
          rows: document.querySelectorAll('.rm-table tbody tr').length,
        };
      });

      // ⚠ 조건문 밖 단언 — 표가 안 그려졌으면 여기서 붉어져야 한다(잠든 테스트 금지)
      expect(m.rows, '학생 행이 0개면 폭 계약을 검사할 수 없다').toBeGreaterThan(0);
      expect(m.name, '학생 열이 고정 폭을 벗어났다 — 점수 열의 width:100% 가 사라졌는지 확인').toBe(RM_NAME_W);
      expect(m.q, '문항 열이 고정 폭을 벗어났다').toBe(RM_Q_W);
      expect(m.qno, '문항 번호가 작아졌다 — 교사 스캔성이 떨어진다').toBe(`${RM_QNO_PX}px`);
      // 여유가 실제로 점수 열로 갔는지 (문항 4개면 점수 열이 최소폭보다 훨씬 넓어야 한다)
      expect(m.score, '여유 폭이 점수 열로 흐르지 않았다').toBeGreaterThan(200);
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-M9: 문항이 많으면 표 안에서 가로 스크롤 — 칸을 줄이지 않고, 페이지는 밀리지 않는다', async ({ browser }) => {
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoMonitorHost(page, browser);
      await openWithFixture(page, loadFixture('response-monitor.compact.json')); // 문항 45개

      const m = await page.evaluate(() => {
        const body = document.querySelector('.rm-body');
        const th = document.querySelector('.rm-th-q');
        return {
          cols: document.querySelectorAll('.rm-qno-row .rm-th-q').length,
          bodyClient: body ? body.clientWidth : -1,
          bodyScroll: body ? body.scrollWidth : -1,
          qw: th ? Math.round(th.getBoundingClientRect().width) : -1,
          pageClient: document.documentElement.clientWidth,
          pageScroll: document.documentElement.scrollWidth,
        };
      });

      expect(m.cols, '문항 열이 0개면 스크롤 계약을 검사할 수 없다').toBeGreaterThan(20);
      expect(m.bodyScroll, '표가 컨테이너보다 넓지 않다 — 칸이 줄어든 것(자동 압축 부활?)').toBeGreaterThan(m.bodyClient);
      expect(m.qw, '문항이 많다고 칸을 줄이면 안 된다 — 가로 스크롤로 본다').toBe(RM_Q_W);
      // 🔴 프로젝트 불변식: 페이지 본문은 절대 가로로 밀리지 않는다
      expect(m.pageScroll, '페이지 가로 스크롤이 생겼다').toBe(m.pageClient);
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-M10: 진입 버튼은 레이어가 아니라 별도 창을 연다', async ({ browser }) => {
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      const target = await resolveLesson(browser);
      expect(target, '교사 수업을 못 찾으면 진입점을 검사할 수 없다').toBeTruthy();

      await page.goto(`/class/lesson-view.html?classId=${target.classId}&id=${target.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      // window.open 을 가로채 호출 여부·URL 을 기록한다(실제 창은 띄우지 않는다)
      await page.evaluate(() => {
        window.__rmOpened = null;
        window.open = function (url) { window.__rmOpened = url; return { focus() {}, closed: false }; };
      });
      await page.click('#openMonitorBtn');
      await page.waitForTimeout(400);

      const opened = await page.evaluate(() => window.__rmOpened);
      const overlay = await page.evaluate(() =>
        !!document.querySelector('#respMonitorOverlay.active'));

      expect(opened, '별도 창이 열리지 않았다 — window.open 미호출').toBeTruthy();
      expect(opened).toContain('/class/response-monitor.html');
      expect(opened).toContain(`classId=${target.classId}`);
      expect(opened).toContain(`lessonId=${target.lessonId}`);
      expect(overlay, '레이어 오버레이가 함께 열렸다 — 별도 창으로 바꾼 취지에 어긋난다').toBe(false);
      await page.close();
    } finally { await context.close(); }
  });

  test('INV-M11: 별도 창 페이지가 단독으로 표를 그린다', async ({ browser }) => {
    const context = await browser.newContext({ storageState: teacherState, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      const target = await resolveLesson(browser);
      expect(target, '교사 수업을 못 찾으면 별도 창을 검사할 수 없다').toBeTruthy();

      await page.goto(`/class/response-monitor.html?classId=${target.classId}&lessonId=${target.lessonId}`,
        { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#respMonitorOverlay.active', { timeout: 15000 });
      await page.waitForTimeout(600);

      const m = await page.evaluate(() => ({
        rows: document.querySelectorAll('.rm-table tbody tr').length,
        title: document.title,
        pageClient: document.documentElement.clientWidth,
        pageScroll: document.documentElement.scrollWidth,
      }));
      expect(m.rows, '별도 창에서 학생 행이 그려지지 않았다').toBeGreaterThan(0);
      expect(m.title).toContain('응답 현황');
      expect(m.pageScroll, '별도 창에서 페이지 가로 스크롤이 생겼다').toBe(m.pageClient);
      await page.close();
    } finally { await context.close(); }
  });
});


/** 픽스처 주입용 호스트 페이지로 이동 — ResponseMonitor 모듈이 로드된 화면이면 된다. */
let _rmHostIds = null;
async function gotoMonitorHost(page, browser) {
  if (!_rmHostIds) _rmHostIds = await resolveLesson(browser);
  // 조건문 밖 단언 — 수업을 못 찾으면 여기서 붉어져야 한다(픽스처 주입이 조용히 건너뛰지 않게)
  expect(_rmHostIds, '교사 수업을 찾지 못해 모니터 호스트 화면을 열 수 없다').toBeTruthy();
  await page.goto(`/class/lesson-view.html?classId=${_rmHostIds.classId}&id=${_rmHostIds.lessonId}`,
    { waitUntil: 'domcontentloaded' });
  await waitReady(page);
}

/** 픽스처의 문항 수를 n 개로 줄인다(셀도 함께 잘라 INV-M4 를 유지한다). */
function shrinkQuestions(snap, n) {
  const s = JSON.parse(JSON.stringify(snap));
  s.questions = (s.questions || []).slice(0, n);
  s.students = (s.students || []).map((st) => ({ ...st, cells: (st.cells || []).slice(0, n) }));
  return s;
}
