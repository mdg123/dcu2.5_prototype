// test/lrs-benchmark-enrich.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 도 벤치마크 집중 재시드(Phase 0) — 결과 불변식 박제.
//   재시드 스크립트: scripts/seed-benchmark-enrich.js (--apply)
//   기획서: 보고서/LRS_확장_통합기획서_v1.md §4-4
//
//   목적: "성취기준 단위 벤치마크가 통계적으로 성립"함을 데이터 레벨에서 상시 검증.
//   재시드가 되돌려지면(--clean 또는 미적용) 이 불변식들이 FAIL → 벤치마크가 통계 기반을
//   잃었음을 즉시 경보(박제). 코어 셀 = 벤치 로그(context_registration='bench_enrich_v1')가
//   심어진 (학생학년 × 성취기준코드) 조합.
//
//   INV-BE1  핵심 셀 표본 밀도: 코어 셀 전부 평가학생(att>=3) n>=30 (§4-4 목표 n>=30~50).
//   INV-BE2  벤치마크 분포 스프레드: 고(>=80%)·중(50~79%)·취약(<50%) 셀이 모두 유의미 존재
//            (우수/취약 Top10 이 양쪽 다 대표본으로 채워질 통계 전제).
//   INV-BE3  strong-trend 우수 Top10 = 대표본 고도달: 상위 5행 전부 도달률>=80 & 평가학생>=30
//            (재시드 前 "우수 44%" 소표본 문제 해소 회귀 — db/lrs-analytics getWeakTrend order=strong).
//
// DB 격리: 실 DB → 임시 복사본(_setup). 재시드가 실 DB에 적용돼 있어야 GREEN.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb } = require('./_setup');

setupTestDb();
const db = require('../db/index');
const analytics = require('../db/lrs-analytics');

const BENCH_TAG = 'bench_enrich_v1';

function benchLogCount() {
  return db.prepare('SELECT COUNT(*) c FROM learning_logs WHERE context_registration=?').get(BENCH_TAG).c;
}

// 코어 셀 = 벤치 로그가 있는 (초등 학생학년 × 코드). 각 셀의 평가학생(att>=3)·도달학생 집계.
function coreCells() {
  const codes = db.prepare('SELECT DISTINCT achievement_code c FROM learning_logs WHERE context_registration=?')
    .all(BENCH_TAG).map(r => r.c);
  if (!codes.length) return [];
  const intended = new Set(
    db.prepare(`SELECT DISTINCT u.grade || '|' || ll.achievement_code k
                FROM learning_logs ll JOIN users u ON u.id = ll.user_id
                WHERE ll.context_registration = ? AND u.school_level='elementary'`).all(BENCH_TAG).map(r => r.k)
  );
  const ph = codes.map(() => '?').join(',');
  return db.prepare(`
    SELECT u.grade AS grade, s.achievement_code AS code,
      SUM(CASE WHEN s.attempt_count>=3 THEN 1 ELSE 0 END) AS n_eval,
      SUM(CASE WHEN s.attempt_count>=3 AND (CAST(s.success_count AS REAL)/s.attempt_count) >= 0.8 THEN 1 ELSE 0 END) AS n_reach
    FROM lrs_achievement_stats s JOIN users u ON u.id = s.user_id
    WHERE u.school_level='elementary' AND s.achievement_code IN (${ph})
    GROUP BY u.grade, s.achievement_code
  `).all(...codes).filter(r => intended.has(r.grade + '|' + r.code));
}

// ──────────────────────────────────────────────────────────────────────────
test('BENCH-0: 재시드 선행 가드 — 벤치 로그(bench_enrich_v1)가 존재해야 함', () => {
  const n = benchLogCount();
  assert.ok(n > 0,
    `벤치 재시드 로그 0건. 이 불변식들은 재시드 적용을 전제로 한다 — ` +
    `node scripts/seed-benchmark-enrich.js --apply 를 먼저 실행하세요.`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BE1: 핵심 셀 표본 밀도 — 코어 셀 전부 평가학생 n>=30
// ──────────────────────────────────────────────────────────────────────────
test('INV-BE1: 핵심 셀 표본 밀도 — 벤치 대상 (학년×코드) 셀 전부 평가학생 n>=30', () => {
  const cells = coreCells();
  assert.ok(cells.length >= 200, `코어 셀 수 기대 >=200(초등 6학년×교과×10코드 규모), got ${cells.length}`);
  const under = cells.filter(c => c.n_eval < 30);
  assert.equal(under.length, 0,
    `평가학생 n<30 코어 셀 ${under.length}개 (표본 붕괴): ` +
    under.slice(0, 6).map(c => `g${c.grade}/${c.code}=${c.n_eval}`).join(', '));
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BE2: 벤치마크 분포 스프레드 — 고/중/취약 셀 모두 유의미 존재
// ──────────────────────────────────────────────────────────────────────────
test('INV-BE2: 도달률 스프레드 — 고(>=80%)·중(50~79%)·취약(<50%) 코어 셀이 모두 존재', () => {
  const cells = coreCells().filter(c => c.n_eval > 0);
  let high = 0, mid = 0, weak = 0;
  for (const c of cells) {
    const rate = c.n_reach / c.n_eval;
    if (rate >= 0.80) high++; else if (rate >= 0.50) mid++; else weak++;
  }
  // 재시드 설계 목표: 코드 25/40/35(高/中/弱). 셀 실현치는 학생 개인변동으로 근사. 하한만 박제.
  assert.ok(high >= 20, `고도달(>=80%) 코어 셀 >=20 기대(우수 Top10 대표본 채움 전제), got ${high}`);
  assert.ok(mid >= 20, `중간(50~79%) 코어 셀 >=20 기대, got ${mid}`);
  assert.ok(weak >= 20, `취약(<50%) 코어 셀 >=20 기대(취약 진단 대표본 전제), got ${weak}`);
  // 셋 다 존재(스프레드 성립) — 어느 한 밴드도 0이면 벤치마크가 한쪽으로 붕괴한 것.
  assert.ok(high > 0 && mid > 0 && weak > 0, `세 밴드 모두 존재해야 (high=${high}, mid=${mid}, weak=${weak})`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-BE3: strong-trend 우수 Top10 = 대표본 고도달 (재시드 前 "우수 44%" 해소 회귀)
// ──────────────────────────────────────────────────────────────────────────
test('INV-BE3: 우수 Top10 상위 = 대표본 고도달(도달률>=80 & 평가학생>=30) — 초등 전체 scope', () => {
  const elemIds = db.prepare("SELECT id FROM users WHERE role='student' AND school_level='elementary'")
    .all().map(r => r.id);
  const strong = analytics.getWeakTrend({ userIds: elemIds, limit: 10, order: 'strong' });
  assert.ok(strong.length >= 5, `우수 Top 최소 5행 기대, got ${strong.length}`);
  for (const r of strong.slice(0, 5)) {
    assert.ok(r.reachedRate >= 80,
      `우수 상위 도달률 >=80 기대(재시드 前 44% 문제 해소): ${r.code}=${r.reachedRate}%`);
    assert.ok(r.evaluatedStudents >= 30,
      `우수 상위 평가학생 >=30 기대(대표본): ${r.code} n=${r.evaluatedStudents}`);
  }
});
