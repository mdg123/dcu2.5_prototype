#!/usr/bin/env node
'use strict';
/**
 * scripts/fix-notification-links.js — 누적된 죽은 알림 링크 정정 (2026-08-05 P0-4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 배경: notifications.link 에 **존재하지 않는 파일 경로**가 저장돼 있었다.
 *   /class/class-notice.html      → /class/notice-board.html
 *   /class/notice.html            → /class/notice-board.html
 *   /class/class-evaluation.html  → /class/exam-view.html      (examId → id)
 *   /class/class-homework.html    → /class/homework-view.html  (homeworkId → id)
 *
 * ★ 런타임은 이미 안전하다: routes/notifications.js 가 **읽기 시점에 정규화**하므로
 *   이 스크립트를 돌리지 않아도 사용자는 정상 이동한다. 이 스크립트는 "데이터도
 *   정본으로 맞춰 두는" 선택적 정리이며, 언젠가 정규화기를 제거할 수 있게 한다.
 *
 * 규칙은 routes/notifications.js 의 LEGACY_LINK_RULES 를 그대로 재사용한다
 * (두 곳에 규칙이 흩어져 어긋나는 것을 원천 차단).
 *
 * 사용법:
 *   node scripts/fix-notification-links.js                 # DRY-RUN (기본, 무변형)
 *   node scripts/fix-notification-links.js --apply         # 실제 UPDATE
 *   DB_PATH=data/_copy.db node scripts/fix-notification-links.js --apply   # 격리 검증
 *
 * ⚠ --apply 로 정본(data/dacheum.db)에 반영했다면 **직후 `npm test` 전건 재실행** 필수.
 *   (이 스크립트는 _stamp-on-write 로 자동 표식을 남긴다 → 미검증 상태가 붉게 뜬다)
 * 멱등: 몇 번 돌려도 결과 동일. 이미 올바른 링크는 건드리지 않는다.
 * ─────────────────────────────────────────────────────────────────────────────
 */
require('./_stamp-on-write');

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { normalizeNotifLink } = require('../routes/notifications');

const APPLY = process.argv.includes('--apply');
const DB_FILE = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dacheum.db'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function publicFileExists(urlPath) {
  const p = path.join(PUBLIC_DIR, urlPath.replace(/^\/+/, ''));
  try {
    if (fs.statSync(p).isFile()) return true;
  } catch (_) {}
  try {
    return fs.statSync(path.join(p, 'index.html')).isFile();
  } catch (_) { return false; }
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`DB 가 없습니다: ${DB_FILE}`);
  process.exit(1);
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

console.log(`DB      : ${DB_FILE}`);
console.log(`모드    : ${APPLY ? '★ APPLY (실제 UPDATE)' : 'DRY-RUN (무변형)'}`);
console.log('─'.repeat(78));

const rows = db.prepare(
  `SELECT link, COUNT(*) AS n FROM notifications
   WHERE link IS NOT NULL AND link <> '' GROUP BY link ORDER BY n DESC`
).all();

let changedGroups = 0, changedRows = 0, stillDead = 0;
const plan = [];
for (const r of rows) {
  const fixed = normalizeNotifLink(r.link);
  const ok = publicFileExists(fixed.split('?')[0]);
  if (!ok) { stillDead += r.n; console.log(`  [경고] 정규화 후에도 파일 없음: ${fixed}  (${r.n}건)`); }
  if (fixed === r.link) continue;
  plan.push({ from: r.link, to: fixed, n: r.n });
  changedGroups++; changedRows += r.n;
}

for (const p of plan) console.log(`  ${String(p.n).padStart(4)}건  ${p.from}\n           → ${p.to}`);

console.log('─'.repeat(78));
console.log(`distinct 링크 ${rows.length}종 / 정정 대상 ${changedGroups}종 · ${changedRows}건`);
if (stillDead) console.log(`⚠ 정규화 후에도 실파일 없음: ${stillDead}건 — 규칙 보강 필요`);

if (!APPLY) {
  console.log('\nDRY-RUN 이므로 DB 를 변경하지 않았습니다. 반영하려면 --apply 를 붙이세요.');
  db.close();
  process.exit(stillDead ? 2 : 0);
}

const upd = db.prepare('UPDATE notifications SET link = ? WHERE link = ?');
const tx = db.transaction(() => { for (const p of plan) upd.run(p.to, p.from); });
tx();

// 검증: 재스캔 시 정정 대상이 0 이어야 한다(멱등)
const after = db.prepare(
  `SELECT link, COUNT(*) AS n FROM notifications
   WHERE link IS NOT NULL AND link <> '' GROUP BY link`
).all();
const residual = after.filter(r => normalizeNotifLink(r.link) !== r.link);
const dead = after.filter(r => !publicFileExists(normalizeNotifLink(r.link).split('?')[0]));

console.log(`\n✔ 반영 완료 — ${changedRows}건 UPDATE`);
console.log(`  재스캔 잔여 정정대상: ${residual.length}종 (0 이어야 정상)`);
console.log(`  재스캔 죽은 링크    : ${dead.length}종 (0 이어야 정상)`);
db.close();
process.exit(residual.length || dead.length ? 1 : 0);
