#!/usr/bin/env node
'use strict';
/**
 * scripts/run-harness.js — `npm test` 의 공식 실행기 (하네스 러너)
 * ─────────────────────────────────────────────────────────────────────────────
 * 하는 일은 세 가지뿐이다.
 *   ① 실행 전 : 정본 DB 의 하네스 스탬프를 읽어 "미검증" 이면 배너로 알린다.
 *   ② 실행    : 기존과 100% 동일한 명령을 그대로 돌린다.
 *                 node --test --test-concurrency=1 test/*.test.js
 *   ③ 실행 후 : **전건 통과했을 때만** verified 스탬프를 갱신한다.
 *                실패하면 갱신하지 않는다 → 미검증 상태가 그대로 남는다.
 *
 * ■ 왜 러너를 따로 두나 (2026-07-31 사고)
 *   "하네스 통과" 라는 사실은 **어느 데이터 위에서 통과했는가**와 한 몸이다.
 *   러너 없이 node --test 만 돌리면 그 사실이 어디에도 남지 않아, 재집계로
 *   근거 데이터가 바뀐 뒤에도 "아까 576 pass 였다"는 낡은 기억이 근거로 쓰인다.
 *   실제로 07-31 에 그 낡은 기억을 근거로 배포·완료 보고가 나갔고, 나흘 뒤
 *   사용자 앞에서 6건 실패로 드러났다.
 *
 * ■ 부분 실행은 검증으로 인정하지 않는다
 *   인자를 주면(예: `npm test test/lrs-keris-p2.test.js`) 그 파일만 돌리고
 *   verified 스탬프를 **갱신하지 않는다**. 개별 테스트 몇 개 통과를
 *   "하네스 통과" 로 승격시키지 않기 위해서다.
 *
 * ■ 하위 프로세스에 넘기는 환경변수
 *   HARNESS_FULL_RUN      = '1'            전건 실행임
 *   HARNESS_ACK_MUTATION  = <mutation_at>  이 런이 소화 중인 변형 시각
 *   → test/harness-freshness.test.js 가 이 둘을 보고 "지금 검증 중" 을 판별한다.
 *     (없으면 미검증 상태에서 개별 테스트를 돌린 것 → 붉게 실패시킨다)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const stampLib = require('./harness-stamp');

const ROOT = path.join(__dirname, '..');

/**
 * 검증 스탬프를 갱신해도 되는가 — 러너의 유일한 판단 규칙.
 * 전건(full) 실행이 **exit 0** 로 끝났을 때만 참. 그 외(실패·부분 실행)는 전부 거짓이다.
 * (별도 함수로 뺀 이유: 하네스가 이 규칙 자체를 진리표로 검사할 수 있게 하기 위함)
 */
function shouldRecordVerified({ exitCode, isFullRun }) {
  return exitCode === 0 && isFullRun === true;
}

module.exports = { shouldRecordVerified };

if (require.main !== module) return;

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : stampLib.CANONICAL_DB;

const passthrough = process.argv.slice(2);
const isFullRun = passthrough.length === 0;

// ── ① 실행 전 상태 고지 ──────────────────────────────────────────────────────
let stampBefore = null;
try { stampBefore = stampLib.readPath(DB_PATH); } catch (_) {}

if (stampBefore && stampLib.isStale(stampBefore)) {
  console.log('');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log('⚠ 미검증 상태에서 시작합니다 — 데이터가 바뀐 뒤 첫 하네스입니다.');
  console.log(`   마지막 변형 : ${stampBefore.mutation_at} (${stampBefore.mutation_script || '?'})`);
  console.log(`   마지막 검증 : ${stampBefore.verified_at || '(없음)'}`);
  console.log(isFullRun
    ? '   이 런이 전건 통과하면 미검증 표식이 해소됩니다.'
    : '   ⚠ 부분 실행이므로 통과해도 표식은 해소되지 않습니다.');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log('');
}

// ── ② 실행 ───────────────────────────────────────────────────────────────────
const args = ['--test', '--test-concurrency=1', ...(isFullRun ? ['test/*.test.js'] : passthrough)];
const res = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    HARNESS_FULL_RUN: isFullRun ? '1' : '0',
    HARNESS_ACK_MUTATION: (stampBefore && stampBefore.mutation_at) || '',
  },
});

const code = res.status == null ? 1 : res.status;

// ── ③ 통과했을 때만 verified 갱신 ────────────────────────────────────────────
if (shouldRecordVerified({ exitCode: code, isFullRun })) {
  // 런 도중에 다른 프로세스가 정본 DB 를 또 바꿨다면, 이 런은 "그 이전 데이터"를 검증한 것이다.
  // 그대로 verified 를 찍으면 검증하지 않은 상태에 도장을 찍는 셈 → 기록하지 않는다.
  let stampAfter = null;
  try { stampAfter = stampLib.readPath(DB_PATH); } catch (_) {}
  const beforeAt = (stampBefore && stampBefore.mutation_at) || null;
  const afterAt = (stampAfter && stampAfter.mutation_at) || null;
  if (afterAt !== beforeAt) {
    console.error('\n🔴 테스트 도중 정본 DB 가 또 변경됐습니다 — 검증 스탬프를 갱신하지 않습니다.');
    console.error(`   실행 시작 시 변형: ${beforeAt || '(없음)'}`);
    console.error(`   실행 종료 시 변형: ${afterAt || '(없음)'}`);
    console.error('   ▶ 변경이 끝난 뒤 npm test 를 다시 전건 실행하세요.');
    process.exit(1);
  }

  let sha = null;
  try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch (_) {}
  try {
    const at = stampLib.recordVerifiedPath(DB_PATH, { sha });
    console.log(`\n✅ 하네스 전건 통과 — 검증 스탬프 갱신 ${at}${sha ? ` (HEAD ${sha})` : ''}`);
  } catch (e) {
    console.error(`\n⚠ 검증 스탬프 기록 실패: ${e.message}`);
    console.error('   (테스트는 통과했으나 표식이 남지 않았습니다 — DB 경로/권한을 확인하세요)');
  }
} else if (code !== 0) {
  console.error('\n🔴 하네스 실패 — 검증 스탬프를 갱신하지 않습니다(미검증 상태 유지).');
} else {
  console.log('\nℹ 부분 실행이므로 검증 스탬프를 갱신하지 않습니다. 전건: npm test');
}

process.exit(code);
