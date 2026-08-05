// test/notification-link-integrity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [부류 L] 알림 링크 정합 — "알림을 눌렀는데 404" 를 영구 박제한다.
//
// 사고(2026-08-05 P0-4 실측): notifications.link 에 **존재하지 않는 파일 경로**가
// 저장되고 있었다. 코드가 만든 링크와 실제 public/ 파일명이 달랐고, 쿼리 파라미터
// 이름도 화면이 읽는 것과 달랐다.
//   저장된 link                       실제 화면
//   /class/class-notice.html      →  /class/notice-board.html   (noticeId ✓)
//   /class/class-evaluation.html  →  /class/exam-view.html      (examId ✗ → id)
//   /class/class-homework.html    →  /class/homework-view.html  (homeworkId ✗ → id)
// 191 건이 이미 쌓여 있었고 student1 미읽음 24 건이 전부 죽은 링크였다.
//
// 이 테스트는 **새 알림 타입이 추가돼도 자동으로 검출**되도록 3 층으로 짠다.
//   L-1  코드 스캔  : routes/*.js 의 모든 `link:` 리터럴 → public/ 실파일 존재 단언
//   L-2  파라미터   : 그 링크가 실어보내는 쿼리 파라미터를 **대상 화면이 실제로 읽는지**
//                     (URLSearchParams .get('name')) 단언 — 이름만 맞고 값이 안 먹는 사고 차단
//   L-3  DB 스캔    : notifications.link 의 distinct 경로를 정규화기에 통과시킨 뒤
//                     실파일 존재 단언 — 과거 누적분(191건)까지 살아있는지 보증
//   L-4  공통 GNB   : 알림 벨이 common-nav.js(전 페이지 공통)에 있고, 갤러리에서
//                     중복 렌더되지 않는지 — "갤러리에서만 알림이 보이던" 사고 차단
//
// 하드코딩된 화이트리스트를 쓰지 않는다. 링크를 새로 만들면 스캔이 자동으로 잡는다.
// DB 격리: 실 DB → 임시 복사본(_setup). 실 DB 무오염.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const notifRouter = require('../routes/notifications');
const db = openTestDb();

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'routes');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

/** '/class/exam-view.html?classId=${a}&id=${b}' → { file, params:['classId','id'] } */
function parseLink(link) {
  const [rawPath, rawQs = ''] = String(link).split('?');
  const params = rawQs
    .split('&')
    .map(kv => kv.split('=')[0].trim())
    .filter(Boolean);
  return { file: rawPath, params };
}

/** public/ 아래에 실제 파일이 있는가 (디렉터리 링크는 index.html 로 해석) */
function resolvePublicFile(urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  const p = path.join(PUBLIC_DIR, rel);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  const idx = path.join(p, 'index.html');
  if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
  return null;
}

/** 화면이 그 쿼리 파라미터를 실제로 읽는가 — URLSearchParams(...).get('name') */
function pageReadsParam(filePath, name) {
  const html = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`\\.get\\(\\s*['"\`]${name}['"\`]\\s*\\)`);
  return re.test(html);
}

/** routes/*.js 에서 link: 리터럴을 전부 긁는다 (템플릿/따옴표 3형태) */
function collectCodeLinks() {
  const out = [];
  for (const f of fs.readdirSync(ROUTES_DIR).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
    const re = /link:\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")/g;
    let m;
    while ((m = re.exec(src))) {
      const raw = m[1] || m[2] || m[3];
      if (!raw.startsWith('/')) continue;      // 상대·외부 링크는 대상 외
      out.push({ file: f, link: raw });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// L-1 / L-2: 코드가 만드는 모든 알림 링크는 실존 파일 + 화면이 읽는 파라미터
// ──────────────────────────────────────────────────────────────────────────
test('INV-L1: routes/*.js 의 모든 알림 link 는 public/ 실존 파일을 가리킨다', () => {
  const links = collectCodeLinks();
  assert.ok(links.length >= 4, `link: 리터럴이 ${links.length}건 — 스캐너가 망가졌습니다`);

  const dead = [];
  for (const { file, link } of links) {
    const { file: urlPath } = parseLink(link);
    if (!resolvePublicFile(urlPath)) dead.push(`${file} → ${urlPath}  (public${urlPath} 없음)`);
  }
  assert.deepEqual(dead, [], `죽은 알림 링크 ${dead.length}건 — 누르면 404:\n  ${dead.join('\n  ')}`);
});

test('INV-L2: 알림 link 의 쿼리 파라미터를 대상 화면이 실제로 읽는다', () => {
  const bad = [];
  for (const { file, link } of collectCodeLinks()) {
    const { file: urlPath, params } = parseLink(link);
    const target = resolvePublicFile(urlPath);
    if (!target) continue;                     // L-1 이 이미 잡음
    for (const p of params) {
      if (!pageReadsParam(target, p)) {
        bad.push(`${file} → ${urlPath}?${p}=…  (화면이 '${p}' 를 읽지 않음)`);
      }
    }
  }
  assert.deepEqual(bad, [], `무시되는 알림 파라미터 ${bad.length}건 — 이동해도 대상이 안 열림:\n  ${bad.join('\n  ')}`);
});

// ──────────────────────────────────────────────────────────────────────────
// L-3: DB 누적분(과거 191건 포함)도 정규화 후 실존 파일로 귀결한다
// ──────────────────────────────────────────────────────────────────────────
test('INV-L3: notifications.link 의 distinct 경로가 정규화 후 전부 실존한다', () => {
  const normalize = notifRouter.normalizeNotifLink;
  assert.equal(typeof normalize, 'function',
    'routes/notifications.js 가 normalizeNotifLink 를 export 해야 합니다(레거시 링크 구제기)');

  const rows = db.prepare(
    `SELECT link, COUNT(*) AS n FROM notifications
     WHERE link IS NOT NULL AND link <> '' GROUP BY link`
  ).all();
  assert.ok(rows.length > 0, 'notifications 에 link 가 있는 행이 0건 — 테스트 전제 붕괴');

  const dead = [];
  for (const r of rows) {
    const fixed = normalize(r.link);
    const { file: urlPath, params } = parseLink(fixed);
    const target = resolvePublicFile(urlPath);
    if (!target) { dead.push(`${r.link} → ${fixed}  (${r.n}건, 파일 없음)`); continue; }
    for (const p of params) {
      if (!pageReadsParam(target, p)) dead.push(`${r.link} → ${fixed}  (${r.n}건, '${p}' 미사용)`);
    }
  }
  assert.deepEqual(dead, [], `누적 알림 중 죽은 링크:\n  ${dead.join('\n  ')}`);
});

test('INV-L3b: 정규화기는 이미 올바른 링크를 건드리지 않는다(멱등)', () => {
  const n = notifRouter.normalizeNotifLink;
  const ok = [
    '/plus/gallery.html?open=32',
    '/class/notice-board.html?classId=2&noticeId=5',
    '/class/exam-view.html?classId=2&id=abc-123',
    '/class/homework-view.html?classId=2&id=32',
  ];
  for (const l of ok) {
    assert.equal(n(l), l, `멱등 위반: ${l}`);
    assert.equal(n(n(l)), l, `2회 적용 불안정: ${l}`);
  }
  assert.equal(n(null), null);
  assert.equal(n(''), '');
});

// ──────────────────────────────────────────────────────────────────────────
// L-4: 알림 벨은 공통 GNB 에 있다 (= 모든 페이지). 갤러리 중복 렌더 금지.
// ──────────────────────────────────────────────────────────────────────────
test('INV-L4: 알림 벨이 공통 GNB(common-nav.js)에 있어 전 페이지에서 보인다', () => {
  const nav = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'common-nav.js'), 'utf8');
  assert.ok(/gnbNotifBellBtn/.test(nav), '공통 GNB 에 알림 벨 버튼(#gnbNotifBellBtn)이 없습니다');
  assert.ok(/gnbNotifPanel/.test(nav), '공통 GNB 에 알림 패널(#gnbNotifPanel)이 없습니다');
  assert.ok(/\/api\/notifications/.test(nav), '공통 GNB 가 /api/notifications 를 호출하지 않습니다');
  assert.ok(/\/api\/notifications\/read-all/.test(nav), '공통 GNB 에 전체 읽음 처리가 없습니다');

  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'common-nav.css'), 'utf8');
  assert.ok(/\.gnb-notif-panel/.test(css), 'common-nav.css 에 알림 패널 스타일이 없습니다');
});

test('INV-L4b: 갤러리 페이지가 알림 벨을 중복 렌더하지 않는다', () => {
  const g = fs.readFileSync(path.join(PUBLIC_DIR, 'plus', 'gallery.html'), 'utf8');
  assert.ok(!/id="notifBellBtn"/.test(g), '갤러리에 옛 알림 벨이 남아 공통 GNB 와 중복됩니다');
  assert.ok(!/id="notifPanel"/.test(g), '갤러리에 옛 알림 패널이 남아 공통 GNB 와 중복됩니다');
});

// ──────────────────────────────────────────────────────────────────────────
// L-5: 12px 이하 금지 (CLAUDE.md 공통 스케일) — 알림 UI 한정
// ──────────────────────────────────────────────────────────────────────────
test('INV-L5: 알림 벨 CSS 에 12px 이하 폰트가 없다', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'common-nav.css'), 'utf8');
  const block = css.split('/* ══════ 알림 벨').slice(1).join('');
  assert.ok(block.length > 0, 'common-nav.css 에 알림 벨 블록 주석이 없습니다');
  const tooSmall = (block.match(/font-size:\s*(\d+)px/g) || [])
    .filter(s => parseInt(s.match(/(\d+)px/)[1], 10) <= 12);
  assert.deepEqual(tooSmall, [], `알림 UI 에 12px 이하 폰트: ${tooSmall.join(', ')}`);
});
