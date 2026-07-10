// test/lrs-reliability-p0.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 관리자 신뢰도 정상화 P0 — BE 계약 불변식 박제
//   기획서: 보고서/LRS_관리자_효용제고_격차모니터링_신뢰도_기획서_v1.md §2-A, §2-C
//
//   [2-A] /dataset-coverage 계약 확장 (FE a-quality 가 읽는 필드)
//     INV-R1  total_logs === totalStatements (즉시 정상화 별칭 회귀)
//     INV-R2  "정당 분모" — 성취기준 결측률 분모가 채점형 화이트리스트로 한정.
//             조회 로그(content_view)만 있는 서비스는 성취/교과 분모=0 → 결측 0 (오탐 방지).
//     INV-R3  per_service 서비스별 결측 건수 = 동일 "정당 분모" 규칙 (합성 서비스 격리 대조)
//     INV-R4  denominators·last_synced·필드 존재 계약
//
//   [2-C] /stats/service-ops 시드 과경보 게이트
//     INV-R5  각 서비스에 dataSufficient·seedInfluenced 프로퍼티 존재(FE _deltaChip 연동)
//     INV-R6  dataSufficient === (count>=30 && prevCount>=30) — prevCount<30 → false 회귀
//     INV-R7  dataSufficient===false 인 '사용 급감'은 severity='info'(표본부족)로 강등 →
//             underused(경보) 목록에서 제외, insufficient 목록에 포함(빨강 남발 제거)
//     INV-R8  seedInfluenced === (realOnly===false) — realOnly=1 이면 false
//
// DB 격리: 실 DB → 임시 복사본(_setup). admin id=1. HTTP 하네스는 lrs-keris-* 와 동일 패턴.
//   합성 데이터는 고유 source_service('t_rel_p0_svc')로 삽입 → per_service 서비스 격리 대조로
//   거대·가변 실데이터에 무의존하게 결정적 검증한다.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const ADMIN = 1;
const SVC = 't_rel_p0_svc';       // 합성 전용 서비스(격리 대조용)
const SVC_LOW = 't_rel_p0_low';   // 절대량 게이트용 소표본 서비스
const SVC_DROP = 't_rel_p0_drop'; // '사용 급감'(share≥5·trendΔ<-20·dataSufficient) 유발 — 톤다운/hard 대조
// SVC_DROP 물량: 현재기간(최근 30일) cur건·직전 동기간 prev건. share≥5%(급감 경로 진입 전제)를
//   보장해야 한다. 그런데 share = cur / (현재창 전체 로그) 이므로 DB 총량이 커지면(예: 벤치마크
//   집중 재시드 +70k) 고정 cur(구 1100)의 share 가 5% 밑으로 희석된다(실측 1.7%).
//   [재기준 2026-07-10] cur 를 하드코딩하지 않고 before() 에서 현재창 총 로그 대비 동적 산정(≥12%
//   목표 = 5% 게이트 대비 넉넉한 마진) → 재시드 유무·DB 규모와 무관하게 불변. 둘 다 ≥30,
//   prev = cur×1.4 로 trendΔ=(cur-prev)/prev≈-28.6%<-20(급감) 유지.
let DROP_CUR = 1100, DROP_PREV = 1500; // before() 에서 현재창 총합 기준으로 재산정

let server, baseUrl, tdb, synthUid;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/lrs', require('../routes/lrs'));
  return app;
}
function req(path, userId) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/lrs' + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: userId ? { 'x-test-user': String(userId) } : {} },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j, raw: body }); });
      });
    r.on('error', reject); r.end();
  });
}

before(async () => {
  tdb = openTestDb();

  // [재기준 2026-07-10] SVC_DROP cur/prev 를 현재 30일창 총 로그 대비 동적 산정(share≥5% 게이트 보장).
  //   벤치마크 재시드로 총량이 커져도 share 가 희석되지 않도록 목표 share≈12%(마진)로 cur 설정.
  //   현재창 정의는 SVC_DROP prev(-45일) 대비 '최근 30일' = created_at >= now-29일(all 로그, seed 포함).
  {
    const winTotal = Number(tdb.prepare(
      "SELECT COUNT(*) c FROM learning_logs WHERE created_at >= datetime('now','localtime','-29 days')"
    ).get().c) || 0;
    DROP_CUR = Math.max(1100, Math.ceil(winTotal * 0.12)); // share≈12% (5% 게이트 대비 넉넉), 최소 1100 유지
    DROP_PREV = Math.ceil(DROP_CUR * 1.4);                  // trendΔ=(cur-prev)/prev≈-28.6%<-20(급감)·둘다 ≥30
  }

  // 합성 학생 1명(실계정 — is_seed=0).
  synthUid = Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', 'student')"
  ).run(`t_rel_p0_${Date.now()}`, '신뢰도P0테스트').lastInsertRowid);

  // ── 합성 서비스 SVC 로그(실=is_seed=0) — "정당 분모" 대조용 ─────────────────
  //   설계(오늘 날짜 기준, dataset-coverage 기본 30일창 안에 들도록 created_at='now'):
  //     · exam_complete(채점형) 4건 — 그중 2건 achievement_code NULL(성취결측), 1건 subject NULL, 1건 duration 없음
  //     · content_view(조회) 6건 — achievement/subject NULL 이 섞여도 "정당 분모"에서 제외되어야 함
  //   → SVC 의 성취기준 분모 = 4(채점형만), 결측 = 2. content_view 6건은 분모에 안 섞임(오탐 방지).
  //   → SVC 의 교과 분모 = 4(exam) + 0(content_complete 없음) = 4, 결측 = 1.
  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, activity_type, verb, source_service, achievement_code, subject_code,
       duration_sec, result_duration, result_score, is_seed, created_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `);
  // exam_complete 4건 (채점형)
  insLog.run(synthUid, 'exam_complete', SVC, '[4수01-01]', 'math', 120, null, 90); // 완전
  insLog.run(synthUid, 'exam_complete', SVC, '[4수01-01]', 'math', 100, null, 80); // 완전
  insLog.run(synthUid, 'exam_complete', SVC, null,         'math', 100, null, 70); // 성취 결측
  insLog.run(synthUid, 'exam_complete', SVC, null,         null,   null, null, 60); // 성취+교과+시간 결측
  // content_view 6건 (조회 — 성취/교과 분모에서 제외되어야 함). 일부 성취/교과 NULL 이어도 무시.
  for (let i = 0; i < 6; i++) {
    insLog.run(synthUid, 'content_view', SVC, null, null, (i % 2 ? 30 : 0), null, null);
  }

  // ── 절대량 게이트용 소표본 서비스 SVC_LOW ──────────────────────────────────
  //   현재기간(최근 30일) 5건, 직전기간 0건 → prevCount=0 < 30 → dataSufficient=false.
  //   trendDelta 는 신규(+100)라 '사용 급감'은 아니지만, 게이트 회귀(prev<30→false)는 성립.
  const insSvc = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, source_service, is_seed, created_at)
    VALUES (?, 'content_view', 'experienced', ?, 0, datetime('now'))
  `);
  for (let i = 0; i < 5; i++) insSvc.run(synthUid, SVC_LOW);

  // ── SVC_DROP: '사용 급감' 유발(share≥5·trendΔ<-20·dataSufficient=true) ──────────
  //   현재기간(now) DROP_CUR건 + 직전 동기간(-40일 근처, 30일창 밖·직전30일 안) DROP_PREV건.
  //   둘 다 is_seed=0(실데이터) → realOnly=1 에서도 그대로 집계됨(hard warn 대조 가능).
  const insCur = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, source_service, is_seed, created_at)
    VALUES (?, 'content_view', 'experienced', ?, 0, datetime('now','localtime'))
  `);
  // 직전 동기간: 현재창(-29~0일) 직전인 -30~-59일. -45일로 삽입(직전 30일창 정중앙).
  const insPrev = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, source_service, is_seed, created_at)
    VALUES (?, 'content_view', 'experienced', ?, 0, datetime('now','localtime','-45 days'))
  `);
  const seedDrop = tdb.transaction(() => {
    for (let i = 0; i < DROP_CUR; i++) insCur.run(synthUid, SVC_DROP);
    for (let i = 0; i < DROP_PREV; i++) insPrev.run(synthUid, SVC_DROP);
  });
  seedDrop();

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// [2-A] INV-R1: total_logs === totalStatements (즉시 정상화 별칭 회귀)
// ──────────────────────────────────────────────────────────────────────────
test('INV-R1: /dataset-coverage total_logs === totalStatements (별칭 회귀)', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.success, true);
  assert.equal(typeof d.totalStatements, 'number', 'totalStatements 존재(하위호환)');
  assert.equal(d.total_logs, d.totalStatements, 'total_logs !== totalStatements(별칭 계약 위반)');
});

// ──────────────────────────────────────────────────────────────────────────
// [2-A] INV-R2: "정당 분모" — 성취기준 결측률 분모가 채점형 화이트리스트로 한정.
//   조회(content_view) 로그가 분모에 안 섞임을 per_service 격리 대조로 박제.
// ──────────────────────────────────────────────────────────────────────────
test('INV-R2: per_service[SVC] 성취/교과 분모=채점형만(조회 로그 제외) — count=내역 격리 대조', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  assert.equal(r.status, 200);
  const per = (r.json.per_service || []).find(s => s.service === SVC);
  assert.ok(per, 'per_service 에 합성 서비스 SVC 존재');
  // total = exam 4 + content_view 6 = 10 (서비스 총 로그)
  assert.equal(per.total, 10, `SVC total 10 (exam4+view6), got ${per.total}`);
  // 성취 결측 = 채점형(exam 4건) 중 achievement NULL 2건. content_view 는 성취 분모 아님 → 안 섞임.
  assert.equal(per.missing_achievement, 2, `SVC 성취결측=2(채점형만), got ${per.missing_achievement}`);
  // 교과 결측 = 채점형+content_complete 분모 중 subject NULL. exam 중 1건(4번째) NULL. content_view 제외.
  assert.equal(per.missing_subject, 1, `SVC 교과결측=1(채점형만), got ${per.missing_subject}`);
});

// ──────────────────────────────────────────────────────────────────────────
// [2-A] INV-R2b: 조회 로그만 있는 서비스 → 성취/교과 결측 0 (오탐 방지 핵심).
//   SVC_LOW 는 content_view 5건뿐 → 채점형 분모 0 → 성취/교과 결측 반드시 0.
// ──────────────────────────────────────────────────────────────────────────
test('INV-R2b: 조회-only 서비스(SVC_LOW) 성취/교과 결측=0 (분모 0 → NaN 가드 → 0)', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  const per = (r.json.per_service || []).find(s => s.service === SVC_LOW);
  assert.ok(per, 'per_service 에 SVC_LOW 존재');
  assert.equal(per.total, 5, `SVC_LOW total 5(content_view), got ${per.total}`);
  assert.equal(per.missing_achievement, 0, '조회-only → 성취결측 0(오탐 방지)');
  assert.equal(per.missing_subject, 0, '조회-only → 교과결측 0(오탐 방지)');
});

// ──────────────────────────────────────────────────────────────────────────
// [2-A] INV-R3: 결측률(%)·denominators·last_synced 계약 필드 존재/타입.
//   전역 성취 결측률 = ach_missing / ach_denom 이 채점형 분모 기준(전체 로그 아님)임을 교차 확인.
// ──────────────────────────────────────────────────────────────────────────
test('INV-R3: missing_*_rate/denominators/last_synced 계약 + 결측률=채점형 분모 기준', async () => {
  const r = await req('/dataset-coverage', ADMIN);
  const d = r.json;
  for (const k of ['missing_achievement_rate', 'missing_subject_rate', 'missing_duration_rate']) {
    assert.equal(typeof d[k], 'number', `${k} 숫자 존재`);
    assert.ok(d[k] >= 0 && d[k] <= 100, `${k} 0~100 범위: ${d[k]}`);
  }
  // 세션 결측률은 v1 비노출(억지 계산 금지) — 필드 부재 또는 undefined 여야 함.
  assert.ok(d.missing_session_rate === undefined, 'missing_session_rate 미제공(계약)');
  assert.ok(d.denominators && typeof d.denominators.achievement === 'number', 'denominators.achievement 존재');
  assert.ok(typeof d.denominators.subject === 'number' && typeof d.denominators.duration === 'number', 'denominators 3필드');
  // last_synced 'YYYY-MM-DD HH:MM' (합성 로그가 방금 들어가 non-null)
  assert.ok(typeof d.last_synced === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.last_synced),
    `last_synced 포맷 'YYYY-MM-DD HH:MM': ${d.last_synced}`);

  // 결측률 = miss/denom 재계산 대조(채점형 분모 — SQL 미러). 전 로그 분모가 아님을 박제.
  const denom = d.denominators.achievement;
  assert.ok(denom > 0, '전제: 채점형 분모 > 0');
  const missSql = tdb.prepare(`
    SELECT SUM(CASE WHEN activity_type IN ('exam_complete','homework_submit','content_solve','self_learn','daily_complete','wrong_note_retry','node_complete')
                     AND (achievement_code IS NULL OR TRIM(achievement_code)='') THEN 1 ELSE 0 END) miss,
           SUM(CASE WHEN activity_type IN ('exam_complete','homework_submit','content_solve','self_learn','daily_complete','wrong_note_retry','node_complete') THEN 1 ELSE 0 END) denom
    FROM learning_logs
    WHERE source_service IS NOT NULL AND source_service NOT LIKE 'demo%'
      AND DATE(created_at) >= DATE('now','-30 days') AND DATE(created_at) <= DATE('now')
  `).get();
  assert.equal(d.denominators.achievement, missSql.denom, 'API 성취분모 == SQL 채점형 분모');
  const expectRate = Math.round((missSql.miss / missSql.denom) * 1000) / 10;
  assert.equal(d.missing_achievement_rate, expectRate, `성취결측률=miss/denom(채점형 분모): API ${d.missing_achievement_rate} vs SQL ${expectRate}`);
});

// ──────────────────────────────────────────────────────────────────────────
// [2-A] 권한 회귀 — student 403(전체 데이터셋 집계 노출 방지).
// ──────────────────────────────────────────────────────────────────────────
test('INV-R4: /dataset-coverage student 403', async () => {
  const r = await req('/dataset-coverage', synthUid); // student 역할
  assert.equal(r.status, 403, 'student → 403');
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C] INV-R5: 각 서비스에 dataSufficient·seedInfluenced 프로퍼티 존재(FE _deltaChip 연동).
// ──────────────────────────────────────────────────────────────────────────
test('INV-R5: /stats/service-ops 각 서비스에 dataSufficient·seedInfluenced 존재', async () => {
  const r = await req('/stats/service-ops', ADMIN);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.ok(Array.isArray(j.services) && j.services.length > 0, 'services 배열');
  for (const s of j.services) {
    assert.equal(typeof s.dataSufficient, 'boolean', `${s.service}: dataSufficient boolean`);
    assert.equal(typeof s.seedInfluenced, 'boolean', `${s.service}: seedInfluenced boolean`);
  }
  // 최상위 계약 필드도 확인(FE disclaimer/투명성)
  assert.equal(typeof j.seedInfluenced, 'boolean', 'top-level seedInfluenced');
  assert.equal(j.minAbs, 30, 'minAbs=30 노출');
  assert.ok(Array.isArray(j.insufficient), 'insufficient 목록 존재');
  assert.equal(typeof j.insufficientCount, 'number', 'insufficientCount 존재');
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C] INV-R6: dataSufficient === (count>=30 && prevCount>=30) — 게이트 정의 회귀.
//   SVC_LOW: 현재 5건·직전 0건 → prevCount<30 → dataSufficient=false 반드시.
// ──────────────────────────────────────────────────────────────────────────
test('INV-R6: dataSufficient 게이트 — prevCount<30 → false (SVC_LOW 회귀) + 정의 전수', async () => {
  const r = await req('/stats/service-ops', ADMIN);
  const j = r.json;
  const low = j.services.find(s => s.service === SVC_LOW);
  assert.ok(low, 'SVC_LOW 가 서비스 목록에 존재(현재기간 5건)');
  assert.equal(low.count, 5, `SVC_LOW count 5, got ${low.count}`);
  assert.ok(low.prevCount < 30, `SVC_LOW prevCount<30, got ${low.prevCount}`);
  assert.equal(low.dataSufficient, false, 'prevCount<30 → dataSufficient=false(게이트 회귀)');
  // 정의 전수 대조: 모든 서비스에서 dataSufficient === (count>=30 && prevCount>=30)
  for (const s of j.services) {
    assert.equal(s.dataSufficient, (s.count >= 30 && s.prevCount >= 30),
      `${s.service}: dataSufficient 정의 불일치 (count=${s.count}, prev=${s.prevCount})`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C] INV-R7: dataSufficient===false 인 '사용 급감'은 info(표본부족) 강등 →
//   underused(경보) 제외 + insufficient 포함. 표본 부족 서비스는 경보 목록에 없어야.
// ──────────────────────────────────────────────────────────────────────────
test('INV-R7: 표본부족 서비스는 underused(경보)에서 제외·insufficient 에 포함(빨강 남발 제거)', async () => {
  const r = await req('/stats/service-ops', ADMIN);
  const j = r.json;
  // insufficient 목록 = dataSufficient===false 인 서비스 전부.
  const insufSvcs = new Set(j.insufficient.map(s => s.service));
  const expectedInsuf = new Set(j.services.filter(s => !s.dataSufficient).map(s => s.service));
  assert.deepEqual([...insufSvcs].sort(), [...expectedInsuf].sort(), 'insufficient == dataSufficient=false 집합');
  // severity==='info' 서비스는 underused(경보) 목록에 없어야(경보 승격 금지).
  const underusedSvcs = new Set(j.underused.map(s => s.service));
  for (const s of j.services) {
    if (s.severity === 'info') {
      assert.ok(!underusedSvcs.has(s.service), `${s.service}: info(표본부족)가 경보 목록에 잔존`);
    }
  }
  // 강등 규칙 회귀: dataSufficient===false 이면서 '사용 급감' 이었던 서비스는 status='표본 부족'·severity='info'.
  for (const s of j.services) {
    if (!s.dataSufficient && s.status === '표본 부족') {
      assert.equal(s.severity, 'info', `${s.service}: 표본부족 강등 severity=info`);
    }
    // trendDelta<-20(급감)인데 dataSufficient=false → '사용 급감' 으로 남으면 안 됨(강등돼야).
    if (!s.dataSufficient && s.trendDelta < -20) {
      assert.notEqual(s.status, '사용 급감', `${s.service}: 표본부족 급감이 경보로 승격됨(게이트 실패)`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C REWORK] INV-R7b: seedInfluenced=true 시 '사용 급감'(hard warn)은 caution 톤다운.
//   SVC_DROP(share≥5·trendΔ<-20·dataSufficient=true)이 기본 화면에서 severity='caution'·
//   status 에 '예시 영향' 포함 → 과경보(빨강 warn) 제거 회귀.
// ──────────────────────────────────────────────────────────────────────────
test("INV-R7b: 기본(시드 포함) '사용 급감'→caution 톤다운 (SVC_DROP 회귀 + 전수 불변식)", async () => {
  const r = await req('/stats/service-ops', ADMIN);
  const j = r.json;
  const drop = j.services.find(s => s.service === SVC_DROP);
  assert.ok(drop, 'SVC_DROP 서비스 존재');
  assert.ok(drop.share >= 5, `SVC_DROP share≥5(급감 경로 진입 전제): ${drop.share}`);
  assert.ok(drop.trendDelta < -20, `SVC_DROP trendΔ<-20(급감): ${drop.trendDelta}`);
  assert.equal(drop.dataSufficient, true, 'SVC_DROP dataSufficient=true(cur/prev 둘다 ≥30)');
  assert.equal(drop.severity, 'caution', "SVC_DROP severity=caution(예시영향 톤다운 — warn 아님)");
  assert.ok(/예시 영향/.test(drop.status), `SVC_DROP status 에 '예시 영향' 포함: ${drop.status}`);
  // 전수 불변식: seedInfluenced=true 화면엔 status='사용 급감'+severity='warn' 조합이 존재하면 안 됨(전부 강등).
  for (const s of j.services) {
    assert.ok(!(s.status === '사용 급감'), `${s.service}: 시드 포함 화면에 '사용 급감'(hard) 잔존 — 톤다운 누락`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C REWORK] INV-R7c: 진단 목록 hard/soft/insufficient 3분리 계약.
//   underusedList = warn·critical(hard)만, watchList = caution(soft), insufficient = dataSufficient=false.
//   underusedCount 가 caution 을 포함하지 않음(과경보 제거).
// ──────────────────────────────────────────────────────────────────────────
test('INV-R7c: underused=hard(warn/critical)만·watchList=caution·insufficient=dataSuf false + count 정합', async () => {
  const r = await req('/stats/service-ops', ADMIN);
  const j = r.json;
  assert.ok(Array.isArray(j.watchList), 'watchList 배열 존재');
  assert.equal(typeof j.watchCount, 'number', 'watchCount 숫자');
  // 목록 정의 대조
  const hard = j.services.filter(s => s.severity === 'warn' || s.severity === 'critical').map(s => s.service).sort();
  const soft = j.services.filter(s => s.severity === 'caution').map(s => s.service).sort();
  const insuf = j.services.filter(s => !s.dataSufficient).map(s => s.service).sort();
  assert.deepEqual(j.underused.map(s => s.service).sort(), hard, 'underused == warn/critical(hard)');
  assert.deepEqual(j.watchList.map(s => s.service).sort(), soft, 'watchList == caution(soft)');
  assert.deepEqual(j.insufficient.map(s => s.service).sort(), insuf, 'insufficient == dataSufficient=false');
  assert.equal(j.underusedCount, hard.length, 'underusedCount == hard 수');
  assert.equal(j.watchCount, soft.length, 'watchCount == caution 수');
  // underused 목록에 caution/info 가 섞이지 않음(과경보 제거 핵심)
  for (const s of j.underused) {
    assert.ok(s.severity === 'warn' || s.severity === 'critical', `underused 에 비-hard 잔존: ${s.service}(${s.severity})`);
  }
  // SVC_DROP(caution)은 underused 아님·watchList 포함
  assert.ok(!j.underused.some(s => s.service === SVC_DROP), 'SVC_DROP(caution)이 underused 에 없음');
  assert.ok(j.watchList.some(s => s.service === SVC_DROP), 'SVC_DROP 이 watchList 에 포함');
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C] INV-R8: seedInfluenced === (realOnly===false). realOnly=1 이면 false.
// ──────────────────────────────────────────────────────────────────────────
test('INV-R8: seedInfluenced — 기본(시드 포함) true, realOnly=1 → false', async () => {
  const base = await req('/stats/service-ops', ADMIN);
  assert.equal(base.json.seedInfluenced, true, '기본(realOnly 미설정) → seedInfluenced=true');
  for (const s of base.json.services) assert.equal(s.seedInfluenced, true, `${s.service}: 서비스별 seedInfluenced=true`);
  const real = await req('/stats/service-ops?realOnly=1', ADMIN);
  assert.equal(real.status, 200);
  assert.equal(real.json.seedInfluenced, false, 'realOnly=1 → seedInfluenced=false');
  for (const s of real.json.services) assert.equal(s.seedInfluenced, false, `${s.service}: realOnly=1 서비스별 seedInfluenced=false`);
});

// ──────────────────────────────────────────────────────────────────────────
// [2-C REWORK] INV-R8b: realOnly=1(seedInfluenced=false)이면 급감은 hard warn 유지(강등 안 됨).
//   SVC_DROP 은 is_seed=0 → realOnly=1 에서도 그대로 집계 → 실데이터 급감은 '사용 급감'/warn.
// ──────────────────────────────────────────────────────────────────────────
test("INV-R8b: realOnly=1 급감은 hard warn 유지 (SVC_DROP '사용 급감'/warn — 실데이터 경보 보존)", async () => {
  const r = await req('/stats/service-ops?realOnly=1', ADMIN);
  const j = r.json;
  const drop = j.services.find(s => s.service === SVC_DROP);
  assert.ok(drop, 'realOnly=1 에서도 SVC_DROP 존재(is_seed=0)');
  assert.ok(drop.share >= 5, `realOnly SVC_DROP share≥5: ${drop.share}`);
  assert.ok(drop.trendDelta < -20, `realOnly SVC_DROP trendΔ<-20: ${drop.trendDelta}`);
  assert.equal(drop.dataSufficient, true, 'realOnly SVC_DROP dataSufficient=true');
  assert.equal(drop.seedInfluenced, false, 'realOnly SVC_DROP seedInfluenced=false');
  assert.equal(drop.status, '사용 급감', "realOnly 급감은 '사용 급감' hard 유지(톤다운 안 함)");
  assert.equal(drop.severity, 'warn', 'realOnly 급감 severity=warn(hard 경보 보존)');
  // hard 유지 → underused(경보) 목록에 포함
  assert.ok(j.underused.some(s => s.service === SVC_DROP), 'realOnly SVC_DROP 이 underused(hard 경보)에 포함');
});
