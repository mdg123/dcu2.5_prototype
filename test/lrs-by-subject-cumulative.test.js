// test/lrs-by-subject-cumulative.test.js
// ─────────────────────────────────────────────────────────────────────────────
// LRS "교과별 활동 현황" (GET /api/lrs/stats/by-subject) 누적화 회귀 하네스.
//   기획서: 보고서/LRS_교사_현황분석_친절성개선_기획서_v1.md 이슈3 ①안(145~197줄).
//
// ★ 재발 방지 대상 버그 (2026-07-04):
//   by-subject 가 lessons/homework/exams 를 created_at 이 기간 창(기본 최근 30일) 내인
//   것만 COUNT 했다. teacher1 자료는 전부 2026-03~06 생성 → 30일 창(06-04~07-04) 밖
//   → lessons/homework 집계 0. 형제 탭 "성취 도달 현황"은 누적이라, 같은 페이지에서
//   이 탭만 텅 빈 것처럼 보였다(신뢰 훼손).
//
// ★ 불변식(어긋나면 자동 REWORK):
//   ⓐ  누적화 — period 파라미터(30d/90d/무param)와 무관하게 결과 동일.
//   ⓑ  날짜 무관 존재 — teacher1(id2) lessonStats.length ≥ 1 (30일 창 밖 자료도 잡힘).
//   ⓒ  시드 실측 절대값 박제 — examStats 수학(math-e) count == 15,
//        lessonStats 수학 == 20, homeworkStats 수학 == 5 (누적 GT, 30일 창 밖 은폐 차단).
//   ⓓ  LEFT JOIN — subject_code NULL 자료가 "(교과 미지정)" 한 행으로 집계됨.
//   ⓔ  응답 형태·키 유지 — { success, scope, lessonStats, homeworkStats, examStats },
//        각 행 { subject_code, subject_name, count, subject_label } (FE 무변경 재사용).
//
// DB 격리: 실 DB → 임시 복사본(_setup). GET(읽기)만 — 실 DB 무오염.
//   계정(실 DB 확정): admin=1, teacher1=2, student1=3, student2=4.
//
// ── 시드 실측 GT (teacher1=id2, scope=class=mine 동일, 누적) — 2026-07-04 dump ──
//   lessons  : math-e=20, (미지정)=5, english-e=2, 국어=1, music-e=1, korean-e=1 (6행)
//   homework : (미지정)=11, math-e=5, music-e=1, korean-e=1 (4행)
//   exams    : math-e=15, (미지정)=8 (2행)
//   created_at 범위: lessons/homework 2026-03-23~06-22 (30일 창 밖 다수) → 누적화 검증 유효.
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

const TEACHER = 2, STUDENT1 = 3;

// 시드 실측 절대값(teacher1 누적). 재시드 시에만 갱신.
const GT = {
  // 국어: 오입력 literal subject_code '국어'(1건)를 korean-e 로 정정 → korean-e 2건 단일 행(중복 국어 행 제거).
  lessons: { 'math-e': 20, 'english-e': 2, 'music-e': 1, 'korean-e': 2, __none__: 5, rows: 5 },
  homework: { __none__: 11, 'math-e': 5, 'music-e': 1, 'korean-e': 1, rows: 4 },
  exams: { 'math-e': 15, __none__: 8, rows: 2 },
};

// ── HTTP 하네스 ─────────────────────────────────────────────────────────────
let server, baseUrl;
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
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
    r.on('error', reject); r.end();
  });
}
const bySubject = (qs = '', userId = TEACHER) => req(`/stats/by-subject${qs}`, userId);

// 행 배열에서 subject_code → count 맵. NULL/미지정 자료는 '__none__' 키로 접는다.
//   (라벨 "(교과 미지정)" 인 행은 subject_code 가 NULL 이거나 미매칭 코드일 수 있으므로
//    subject_code == null 을 __none__ 으로 매핑.)
function toMap(rows) {
  const m = {};
  for (const r of rows) {
    const k = (r.subject_code == null) ? '__none__' : r.subject_code;
    m[k] = (m[k] || 0) + r.count;
  }
  return m;
}

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// ⓐ 누적화 — period(30d/90d/무param) 무관하게 결과 동일 (★핵심 회귀)
// ──────────────────────────────────────────────────────────────────────────
test('REG-SUBJ-a: by-subject 는 period 무관 동일(누적) — 30일 창 버그 재발 방지', async () => {
  const noParam = await bySubject('');
  const d30 = await bySubject('?period=30d');
  const d90 = await bySubject('?period=90d');
  for (const [label, r] of [['무param', noParam], ['30d', d30], ['90d', d90]]) {
    assert.equal(r.status, 200, `${label} 200`);
    assert.equal(r.json.success, true, `${label} success`);
  }
  // 세 케이스 lessonStats/homeworkStats/examStats 가 완전히 동일해야 함(period 무시).
  const norm = (j) => JSON.stringify({
    lessons: toMap(j.lessonStats), homework: toMap(j.homeworkStats), exams: toMap(j.examStats),
  });
  assert.equal(norm(d30.json), norm(noParam.json), '30d 결과가 무param(누적)과 달라짐 — 날짜 필터 잔존 의심');
  assert.equal(norm(d90.json), norm(noParam.json), '90d 결과가 무param(누적)과 달라짐 — 날짜 필터 잔존 의심');
});

// ──────────────────────────────────────────────────────────────────────────
// ⓑ 날짜 무관 존재 — lessonStats.length ≥ 1 (30일 창 밖 자료도 잡힘)
// ──────────────────────────────────────────────────────────────────────────
test('REG-SUBJ-b: teacher1 by-subject lessonStats.length ≥ 1 (텅 비지 않음)', async () => {
  const r = await bySubject('?period=30d'); // 버그 시절엔 30d 창 밖이라 [] 였음
  assert.equal(r.status, 200);
  assert.ok(r.json.lessonStats.length >= 1, `lessonStats 가 비었음(${r.json.lessonStats.length}) — 누적화 실패`);
  assert.ok(r.json.homeworkStats.length >= 1, `homeworkStats 가 비었음 — 누적화 실패`);
  assert.ok(r.json.examStats.length >= 1, `examStats 가 비었음 — 누적화 실패`);
});

// ──────────────────────────────────────────────────────────────────────────
// ⓒ 시드 실측 절대값 박제 — 수학 count 정확 일치(30일 창 밖 은폐/이중카운트 차단)
// ──────────────────────────────────────────────────────────────────────────
test('REG-SUBJ-c: 시드 실측 절대값(수학 lessons=20/homework=5/exams=15) 정확 일치', async () => {
  const r = await bySubject('');
  assert.equal(r.status, 200);
  const L = toMap(r.json.lessonStats), H = toMap(r.json.homeworkStats), E = toMap(r.json.examStats);
  assert.equal(L['math-e'], GT.lessons['math-e'], `lessons 수학 count`);
  assert.equal(H['math-e'], GT.homework['math-e'], `homework 수학 count`);
  assert.equal(E['math-e'], GT.exams['math-e'], `exams 수학 count (기획서 명시 15)`);
  // 행 수도 박제 — LEFT JOIN 으로 NULL/미매칭 코드까지 한 행씩 포함.
  assert.equal(r.json.lessonStats.length, GT.lessons.rows, `lessonStats 행 수`);
  assert.equal(r.json.homeworkStats.length, GT.homework.rows, `homeworkStats 행 수`);
  assert.equal(r.json.examStats.length, GT.exams.rows, `examStats 행 수`);
});

// ──────────────────────────────────────────────────────────────────────────
// ⓓ LEFT JOIN — subject_code NULL 자료가 "(교과 미지정)" 한 행으로 집계됨
// ──────────────────────────────────────────────────────────────────────────
test('REG-SUBJ-d: subject_code NULL 자료가 "(교과 미지정)" 행으로 집계(LEFT JOIN)', async () => {
  const r = await bySubject('');
  assert.equal(r.status, 200);
  // NULL subject_code 행(=교과 미지정)이 존재하고 라벨이 정확해야 함.
  const noneRow = r.json.homeworkStats.find(x => x.subject_code == null);
  assert.ok(noneRow, 'homework 에 subject_code NULL 행이 없음 — LEFT JOIN/NULL 포함 실패');
  assert.equal(noneRow.subject_label, '(교과 미지정)', `NULL 자료 라벨은 "(교과 미지정)"`);
  assert.equal(noneRow.count, GT.homework.__none__, `미지정 homework count`);
  // exams 도 동일
  const eNone = r.json.examStats.find(x => x.subject_code == null);
  assert.ok(eNone, 'exams 에 subject_code NULL 행이 없음');
  assert.equal(eNone.subject_label, '(교과 미지정)');
  assert.equal(eNone.count, GT.exams.__none__, `미지정 exams count`);
});

// ──────────────────────────────────────────────────────────────────────────
// ⓔ 응답 형태·키 유지 — FE 무변경 재사용 계약
// ──────────────────────────────────────────────────────────────────────────
test('REG-SUBJ-e: 응답 형태·키 계약 유지 (subject_code/subject_name/count/subject_label)', async () => {
  const r = await bySubject('');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.scope, 'string', 'scope 키 존재');
  for (const key of ['lessonStats', 'homeworkStats', 'examStats']) {
    assert.ok(Array.isArray(r.json[key]), `${key} 는 배열`);
    for (const row of r.json[key]) {
      assert.ok('subject_code' in row, `${key} 행에 subject_code`);
      assert.ok('subject_name' in row, `${key} 행에 subject_name`);
      assert.ok('count' in row, `${key} 행에 count`);
      assert.ok('subject_label' in row, `${key} 행에 subject_label`);
      assert.ok(row.subject_label && String(row.subject_label).trim() !== '', `${key} subject_label 빈값 금지`);
    }
    // 정렬(count desc) 유지 검증.
    const counts = r.json[key].map(x => x.count);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i - 1] >= counts[i], `${key} count desc 정렬 위반`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ⓕ 학생은 mine 폴백 시 빈 결과(권한) — 교사 소유 자료 노출 금지
// ──────────────────────────────────────────────────────────────────────────
test('REG-SUBJ-f: 학생 scope=mine 은 빈 결과(교사 자료 미노출)', async () => {
  const r = await bySubject('?scope=mine', STUDENT1);
  assert.equal(r.status, 200);
  assert.equal(r.json.lessonStats.length, 0, '학생 mine lessonStats 는 비어야 함');
  assert.equal(r.json.homeworkStats.length, 0, '학생 mine homeworkStats 는 비어야 함');
  assert.equal(r.json.examStats.length, 0, '학생 mine examStats 는 비어야 함');
});
