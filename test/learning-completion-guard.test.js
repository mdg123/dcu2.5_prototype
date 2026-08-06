// test/learning-completion-guard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/learning/assign/:classId/completion — 권한 가드.
//
// 왜 박제하는가 (2026-08-06):
//   이 API 는 `requireAuth` 만 있어 **로그인한 아무나** 임의 classId 를 넣으면
//   그 반 학생 **실명 명단 + 개인별 이수율**을 통째로 받아갈 수 있었다.
//
//   그동안 아무도 못 알아챈 이유가 고약하다 — 모집단 산출이 죽어 있었다.
//     getClassMembers(classId).filter(m => m.role === 'student')
//   `m.role` 은 cm.role 이라 값이 'owner' | 'member' 뿐이고 'student' 와 절대
//   같아지지 않는다 → **항상 빈 배열** → `total 0 · completion [] · rate 0`.
//   실패가 아니라 "0명이 0% 이수" 라는 **그럴듯한 거짓말**로 나왔다.
//
//   2026-08-06 그 죽은 분모를 정본(SSOT)으로 고치자 API 가 실제로 실명을
//   반환하기 시작했고, **권한 구멍이 그 순간 실체화**했다.
//   → 죽은 코드를 되살릴 때는 그 코드가 원래 가졌어야 할 가드도 함께 봐야 한다.
//
// 불변식:
//   INV-LC1  비멤버 교사·타반 학생은 403 (실명 0건)
//   INV-LC2  개설자·admin 은 200 이고 명단을 받는다 (과잉 차단 금지)
//   INV-LC3  (소스 락) 이 라우트가 canManageClass 판정을 경유한다
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'routes', 'learning.js');

test('INV-LC3 (소스 락): /completion 이 canManageClass 를 경유한다', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  const i = src.indexOf("'/assign/:classId/completion'");
  assert.ok(i > 0, '라우트가 존재해야 한다');

  // 라우트 핸들러 본문(다음 라우트 정의 전까지)만 본다.
  const rest = src.slice(i);
  const nextRoute = rest.indexOf('router.', 10);
  const body = nextRoute > 0 ? rest.slice(0, nextRoute) : rest;

  assert.match(body, /canManageClass\s*\(\s*req\s*,\s*classId\s*\)/,
    '로그인만 확인하면 아무나 남의 반 학생 실명·이수율을 받아간다. ' +
    '판정은 lib/auth/can-view-user.js 의 canManageClass 를 쓸 것(사본 금지).');
  assert.match(body, /res\.status\(403\)/,
    '권한 없으면 403 이어야 한다');

  // 판정을 손으로 다시 적지 않았는지 — 사본이 생기면 두 판정이 갈린다.
  assert.equal(/getMemberRole\s*\([^)]*\)\s*===\s*['"]owner['"]/.test(body), false,
    'canManageClass 의 판정을 이 라우트에 손으로 복제하지 말 것');

  // import 누락 방지 (require 없이 호출하면 런타임에서만 터진다)
  assert.match(src, /require\(['"]\.\.\/lib\/auth\/can-view-user['"]\)/,
    'canManageClass 를 import 해야 한다');
});

test('INV-LC1/LC2: 라우트가 requireAuth 만으로 열려 있지 않다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const line = src.split('\n').find(l => l.includes("'/assign/:classId/completion'"));
  assert.ok(line, '라우트 줄을 찾아야 한다');

  // 미들웨어 체인이든 본문 가드든 좋으나, "requireAuth 하나뿐 + 본문에 가드 없음" 은 금지.
  const i = src.indexOf("'/assign/:classId/completion'");
  const rest = src.slice(i);
  const nextRoute = rest.indexOf('router.', 10);
  const body = nextRoute > 0 ? rest.slice(0, nextRoute) : rest;

  const hasGuard = /canManageClass|canViewClass|requireClass/.test(body) ||
                   /requireAuth\s*,\s*\w*Class\w*/.test(line);
  assert.ok(hasGuard,
    '이 API 는 학생 실명(display_name)과 개인별 이수율을 반환한다. ' +
    'requireAuth 만으로는 남의 반 데이터가 그대로 나간다.');
});
