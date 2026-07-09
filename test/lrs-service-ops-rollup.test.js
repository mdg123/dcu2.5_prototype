// test/lrs-service-ops-rollup.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS 관리자 '서비스 활용 진단(service-ops)' — 설문(survey) → 채움클래스(class) 롤업 불변식
//   배경: learning_logs.source_service='survey'(설문)은 채움클래스 내부 기능(별도 surveys/
//        survey_responses 테이블·survey_respond 로그)인데, service-ops 서비스 나열에
//        채움클래스·채움CBT 같은 서비스급으로 노출돼 "나열 수준"이 어긋났다.
//        사용자 확정: survey → class 로 롤업(채움클래스 count/share 에 합산, '설문' 미출현).
//
//   불변식:
//     INV-SO-R1  service-ops 서비스 목록(services/underused/watchList/insufficient)에
//                'survey'/'설문' 미출현. topService/bottomService 도 survey 아님.
//     INV-SO-R2  채움클래스(class) count = 순수 class + survey 로그 합 (SQL 미러 정확 대조).
//                survey 순수건 > 0 (롤업이 실제로 병합했음을 박제).
//     INV-SO-R3  원시 보존 — /export(csv·json) 는 survey 로그를 그대로 노출(롤업 안 됨).
//                자매 서비스뷰(/stats/by-service·/dataset-coverage per_service)도 survey 유지.
//
// DB 격리: 실 DB → 임시 복사본(_setup). admin id=1. HTTP 하네스는 lrs-reliability-p0 패턴.
//   합성 class/survey 로그(is_seed=0·created_at=now)를 넣어 현재창 포함을 보장하고,
//   기대값은 SQL 미러(API 필터와 동일)로 재계산해 거대·가변 실데이터에 무의존하게 대조한다.
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
const N_CLASS = 40;   // 합성 순수 class 로그 수(현재창)
const N_SURVEY = 25;  // 합성 survey 로그 수(현재창) — 롤업 대상

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

  // 합성 학생 1명(실계정 — is_seed=0).
  synthUid = Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', 'student')"
  ).run(`t_so_rollup_${Date.now()}`, '롤업테스트학생').lastInsertRowid);

  // 현재창(now) 안에 드는 합성 class·survey 로그(is_seed=0). 활동유형은 집계에 무관하나 현실적으로.
  const ins = tdb.prepare(`
    INSERT INTO learning_logs (user_id, activity_type, verb, source_service, is_seed, created_at)
    VALUES (?, ?, ?, ?, 0, datetime('now','localtime'))
  `);
  const seed = tdb.transaction(() => {
    for (let i = 0; i < N_CLASS; i++)  ins.run(synthUid, 'lesson_complete', 'completed', 'class');
    for (let i = 0; i < N_SURVEY; i++) ins.run(synthUid, 'survey_respond', 'answered', 'survey');
  });
  seed();

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-SO-R1: service-ops 서비스 나열에 '설문'(survey) 미출현(모든 버킷 전수).
// ──────────────────────────────────────────────────────────────────────────
test("INV-SO-R1: service-ops 목록/버킷에 'survey'/'설문' 미출현", async () => {
  const r = await req('/stats/service-ops', ADMIN);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.ok(Array.isArray(j.services) && j.services.length > 0, 'services 배열 존재');

  const isSurvey = (s) => s.service === 'survey' || s.service_label === '설문';
  for (const bucket of ['services', 'underused', 'watchList', 'insufficient']) {
    const list = j[bucket] || [];
    assert.ok(Array.isArray(list), `${bucket} 배열`);
    assert.ok(!list.some(isSurvey), `${bucket} 에 survey/설문 잔존(롤업 누락)`);
  }
  // 랭킹 극단값(top/bottom)도 survey 아님.
  assert.notEqual(j.topService, 'survey', 'topService 가 survey 아님');
  assert.notEqual(j.bottomService, 'survey', 'bottomService 가 survey 아님');
  // 채움클래스는 서비스 목록에 존재해야(합성 class+survey 로 count>0).
  assert.ok(j.services.some(s => s.service === 'class'), '채움클래스(class) 서비스 존재');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-SO-R2: class count === 순수 class + survey (SQL 미러 정확 대조).
//   API cur 쿼리 필터(demo 제외·NOT NULL·현재창 -29일·기본 seed 포함)와 동일한 미러로 재계산.
// ──────────────────────────────────────────────────────────────────────────
test('INV-SO-R2: 채움클래스 count = 순수 class + survey 로그 합(롤업 정확)', async () => {
  const r = await req('/stats/service-ops', ADMIN); // 기본 period=30d → 현재창 -29일
  const j = r.json;
  const cls = j.services.find(s => s.service === 'class');
  assert.ok(cls, '채움클래스(class) 서비스 존재');

  // API cur 쿼리와 동일 필터의 SQL 미러(기본: is_seed 필터 없음).
  const mirror = tdb.prepare(`
    SELECT
      SUM(CASE WHEN source_service='class'  THEN 1 ELSE 0 END) AS pure_class,
      SUM(CASE WHEN source_service='survey' THEN 1 ELSE 0 END) AS pure_survey
    FROM learning_logs
    WHERE source_service IS NOT NULL AND source_service NOT LIKE 'demo%'
      AND DATE(created_at) >= DATE('now','localtime','-29 days')
  `).get();
  const pureClass = mirror.pure_class || 0;
  const pureSurvey = mirror.pure_survey || 0;

  assert.ok(pureSurvey > 0, `전제: survey 순수건>0(롤업 병합 확인) — 실측 ${pureSurvey}`);
  assert.ok(pureSurvey >= N_SURVEY, `합성 survey ${N_SURVEY}건 이상 반영, got ${pureSurvey}`);
  assert.equal(cls.count, pureClass + pureSurvey,
    `채움클래스 count(${cls.count}) === 순수 class(${pureClass}) + survey(${pureSurvey}) = ${pureClass + pureSurvey}`);
  // share 도 롤업된 count 기반(음수·NaN 아님). 총합 대비 비율 재확인.
  assert.ok(cls.share > 0 && cls.share <= 100, `class share 0~100: ${cls.share}`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-SO-R3: 원시 보존 — export·자매 서비스뷰는 survey 를 롤업하지 않는다.
//   (오직 service-ops 서비스급 랭킹만 롤업. 원시 로그·드릴다운·품질뷰는 survey 그대로.)
// ──────────────────────────────────────────────────────────────────────────
test('INV-SO-R3: /export(csv·json)·by-service·dataset-coverage 는 survey 원시 유지', async () => {
  // (a) /export?service=survey (json) — 원시 source_service='survey' 행 그대로.
  const ej = await req('/export?format=json&service=survey', ADMIN);
  assert.equal(ej.status, 200);
  assert.ok(Array.isArray(ej.json.data) && ej.json.data.length > 0, 'export json survey 행 존재');
  assert.ok(ej.json.data.every(row => row.source_service === 'survey'),
    'export json 모든 행 source_service=survey(롤업 안 됨)');

  // (b) /export?service=survey (csv) — 원시 CSV 텍스트에 survey 컬럼값 그대로.
  const ec = await req('/export?format=csv&service=survey', ADMIN);
  assert.equal(ec.status, 200);
  assert.ok(ec.raw.includes(',survey,'), 'export csv 에 source_service=survey 원시 보존');

  // (c) 자매 서비스 랭킹 /stats/by-service — survey 를 독립 서비스로 유지(service-ops 만 롤업).
  const bs = await req('/stats/by-service', ADMIN);
  assert.equal(bs.status, 200);
  assert.ok((bs.json.stats || []).some(s => s.service === 'survey' || s.source_service === 'survey'),
    'by-service 에 survey 독립 서비스 유지(롤업 미적용)');

  // (d) 데이터 품질 서비스뷰 /dataset-coverage per_service — survey 유지.
  const dc = await req('/dataset-coverage', ADMIN);
  assert.equal(dc.status, 200);
  assert.ok((dc.json.per_service || []).some(s => s.service === 'survey'),
    'dataset-coverage per_service 에 survey 유지(롤업 미적용)');
});
