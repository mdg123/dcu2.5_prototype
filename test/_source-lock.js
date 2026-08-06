// test/_source-lock.js
// ─────────────────────────────────────────────────────────────────────────────
// 소스 락 스캐너(창 기반 티어)의 **단일 구현**.
//
// 왜 별도 모듈인가 (2026-08-06 N-1):
//   INV-L3(test/class-student-population.test.js)와 INV-W2(test/lrs-warnings-population.test.js)
//   가 **같은 스캐너**를 검증해야 한다. 테스트 파일끼리 require 하면 남의 테스트가
//   중복 등록되므로, 구현을 여기로 빼고 양쪽이 이것을 쓴다.
//   구현이 두 벌이 되면 "락은 통과하는데 실제로는 안 잡히는" 상태가 다시 생긴다 —
//   그게 정확히 u2 를 놓친 사고의 구조였다.
//
// ⚠ 이 파일은 `test/*.test.js` 글롭에 걸리지 않는다(언더스코어 접두). 테스트가 아니다.
// ─────────────────────────────────────────────────────────────────────────────

/** LRS 계열 창 기반 티어 스캔 대상. */
const POPULATION_SCAN_CLASSJOIN_TARGETS = [
  'routes/lrs.js',
  'db/lrs.js',
  'db/lrs-analytics.js',
  'db/lrs-school.js',
];

const CLASS_JOIN_WINDOW = 12;

/**
 * `<임의별칭>.role = '<값>'` 또는 별칭 없는 `role = '<값>'` 를 잡는 술어.
 *
 * 별칭을 열거하지 않는다 — u·cu·u2·x·stu 무엇이든 동일하게 걸린다.
 *   · lookbehind 로 `user_role='student'`·`my_role='member'` 같은 **다른 컬럼**은 배제
 *   · SQL 의 `=` 만 본다. JS 의 `m.role === 'student'` 는 매칭되지 않는다(FE 는 별도 담당)
 * @param {'member'|'student'} value
 */
function roleLiteralRe(value) {
  return new RegExp(`(?<![\\w.])(?:[A-Za-z_]\\w*\\s*\\.\\s*)?role\\s*=\\s*'${value}'`);
}
const ROLE_MEMBER_RE = roleLiteralRe('member');
const ROLE_STUDENT_RE = roleLiteralRe('student');

/**
 * "반을 세는 손 SQL" 스캐너(창 기반 티어).
 *   · `role='member'` 리터럴  → 창과 무관하게 무조건 위반(멤버십 손 판정)
 *   · `role='student'` 리터럴 → 창(±12줄)에 class_members 가 있을 때만 위반
 *                               (전체·지역·학교급 거시 집계는 정당하므로 오탐 방지)
 *   · `pop-ok` 토큰이 있는 줄  → 면제(사유 병기 의무는 INV-P6b 가 감시)
 *
 * INV-P6 의 scanHandWrittenPopulation 과 별도 함수인 이유: 판정 규칙이 다르고,
 * 같은 시기에 팀M 이 그 함수를 수정 중이라 편집 충돌을 피한다.
 * 면제 토큰(pop-ok)은 양쪽이 공유한다.
 *
 * @param {string} absPath 스캔할 파일 절대경로
 * @param {string} rel     보고용 상대경로 라벨
 * @returns {string[]} 위반 줄 설명 목록(없으면 빈 배열)
 */
function scanClassScopedPopulation(absPath, rel) {
  const fs = require('fs');
  return scanClassScopedPopulationSource(fs.readFileSync(absPath, 'utf8'), rel);
}

/** 파일 대신 소스 문자열을 직접 스캔한다(테스트의 역주입용). */
function scanClassScopedPopulationSource(source, rel) {
  const lines = source.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) return;
    if (/pop-ok/i.test(line)) return;                       // 명시적 면제(사유 병기 의무)
    if (ROLE_MEMBER_RE.test(line)) {                        // 멤버십 손 판정 — 무조건 위반
      hits.push(`${rel}:${i + 1}  [member리터럴]  ${t}`);
      return;
    }
    if (!ROLE_STUDENT_RE.test(line)) return;                // ← 별칭 무관(N-1). u2·x·stu 도 잡힌다
    const win = lines.slice(Math.max(0, i - CLASS_JOIN_WINDOW), i + CLASS_JOIN_WINDOW + 1).join('\n');
    if (/class_members/.test(win)) hits.push(`${rel}:${i + 1}  [반스코프]  ${t}`);
  });
  return hits;
}

module.exports = {
  POPULATION_SCAN_CLASSJOIN_TARGETS,
  CLASS_JOIN_WINDOW,
  roleLiteralRe,
  scanClassScopedPopulation,
  scanClassScopedPopulationSource,
};
