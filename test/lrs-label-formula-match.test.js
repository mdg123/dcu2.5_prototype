// test/lrs-label-formula-match.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [W2-b] "라벨과 산식이 일치하는가" 부류 불변식 박제.
//   정본: 보고서/LRS_지표_정본사전_v1.md §6 라벨 정정 매핑표 · §8-3 회귀 불변식
//
// 이 파일이 지키는 것은 값의 크기가 아니라 **이름과 계산의 대응**이다.
//   화면이 "제출률"이라 부르면 분모는 부과 대상이어야 하고,
//   "도달률"이라 부르면 정의는 전 화면에서 단 하나여야 하며,
//   "오늘"이라 부르면 값은 오늘이어야 한다.
//
//   각 불변식은 되돌리면(역주입) 반드시 빨간불이 되도록 설계했다.
//
// DB 격리: 실 DB → 임시 복사본(_setup). 합성 반/학생/과제로 결정적 값을 박제(실데이터 무의존).
// ─────────────────────────────────────────────────────────────────────────────
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
require('../db/schema').initSchema();

const express = require('express');
const session = require('express-session');

let server, baseUrl, tdb;
const ID = { teacher: 0, students: [], classId: 0, hwA: 0, hwB: 0 };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret-w2b', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (uid) req.session.userId = parseInt(uid, 10);
    next();
  });
  app.use('/api/lrs', require('../routes/lrs'));
  return app;
}
function req(p, userId) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/lrs' + p);
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
const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

before(async () => {
  tdb = openTestDb();
  const mkUser = (role, s) => Number(tdb.prepare(
    "INSERT INTO users (username, display_name, password, role) VALUES (?, ?, 'x', ?)"
  ).run(`w2b_${role}_${s}_${uniq()}`, `W2B_${s}`, role).lastInsertRowid);

  ID.teacher = mkUser('teacher', 'T');
  ID.classId = Number(tdb.prepare(
    "INSERT INTO classes (code, name, owner_id, status) VALUES (?, 'W2B_반', ?, 'active')"
  ).run(`W2B_${uniq()}`, ID.teacher).lastInsertRowid);

  const insMember = tdb.prepare(
    "INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'member', 'active')");
  for (let i = 0; i < 3; i++) {
    const uid = mkUser('student', 'S' + i);
    insMember.run(ID.classId, uid);
    ID.students.push(uid);
  }
  // ★ 비활성 멤버 1명 — 부과 대상이 아니므로 제출률 분모에 들어가면 안 된다(§3-1 cm.status='active').
  const left = mkUser('student', 'LEFT');
  tdb.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'member', 'left')")
    .run(ID.classId, left);

  // 과제 2건(published) → 부과 쌍 = 2 × 3명 = 6
  const insHw = tdb.prepare(
    "INSERT INTO homework (class_id, teacher_id, title, status, created_at) VALUES (?, ?, ?, 'published', datetime('now','localtime'))");
  ID.hwA = Number(insHw.run(ID.classId, ID.teacher, 'W2B_과제A').lastInsertRowid);
  ID.hwB = Number(insHw.run(ID.classId, ID.teacher, 'W2B_과제B').lastInsertRowid);
  // 초안(draft) 과제 1건 — 부과된 적 없으므로 분모에서 빠져야 한다.
  insHw.run(ID.classId, ID.teacher, 'W2B_초안');
  tdb.prepare("UPDATE homework SET status='draft' WHERE title='W2B_초안'").run();

  // 실제 제출은 2건뿐(학생0→과제A, 학생1→과제A) → 정본 제출률 = 2/6 = 33.3%
  const insSub = tdb.prepare(
    "INSERT INTO homework_submissions (homework_id, student_id, content, is_draft) VALUES (?, ?, 'ok', 0)");
  insSub.run(ID.hwA, ID.students[0]);
  insSub.run(ID.hwA, ID.students[1]);
  // 임시저장(draft) 제출 1건 — 제출로 세면 안 된다.
  tdb.prepare("INSERT INTO homework_submissions (homework_id, student_id, content, is_draft) VALUES (?, ?, 'tmp', 1)")
    .run(ID.hwB, ID.students[2]);

  // 로그: 제출 로그 2건(구 산식이 보던 것) + 조회 로그 5건 + 채점형 로그
  const insLog = tdb.prepare(`
    INSERT INTO learning_logs
      (user_id, class_id, activity_type, verb, source_service, result_score, result_success, is_seed, created_at)
    VALUES (?, ?, ?, 'completed', 'class', ?, ?, 0, datetime('now','localtime'))`);
  insLog.run(ID.students[0], ID.classId, 'homework_submit', null, null);
  insLog.run(ID.students[1], ID.classId, 'homework_submit', null, null);
  // content_view 5건 — 학습 활동 수(C1)에 절대 들어가면 안 되고, 조회 지표로는 보여야 한다.
  for (let i = 0; i < 5; i++) insLog.run(ID.students[0], ID.classId, 'content_view', null, null);
  // 채점형 1건
  insLog.run(ID.students[0], ID.classId, 'content_solve', 80, 1);

  await new Promise((resolve) => {
    server = http.createServer(buildApp()).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-1  "제출률"의 분모는 **부과 대상 쌍**이지 제출 로그가 아니다. (정본사전 §1-B B1 · §6-5)
//   구 산식은 제출 로그의 성공비율이라 미제출자가 분모에서 사라져 항상 부풀려졌다.
//   역주입: 분모를 hw_cnt(로그 수)로 되돌리면 100 이 나와 이 테스트가 빨간불이 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-1: 과제 제출률 분모 = 부과 쌍(과제×재적 학생) — 로그 수 아님', async () => {
  const r = await req(`/stats/perform?scope=class&from=2020-01-01&to=2030-01-01`, ID.teacher);
  assert.equal(r.status, 200);
  const s = r.json.summary;
  assert.equal(s.homeworkAssignedPairs, 6, '부과 쌍 = published 과제 2건 × active 학생 3명 (draft 과제·left 멤버 제외)');
  assert.equal(s.homeworkSubmittedPairs, 2, '제출 쌍 = 2 (is_draft=1 임시저장은 제출 아님)');
  assert.equal(s.homeworkSubmitRate, 33.3, '제출률 = 2/6 = 33.3%');
  // 구 산식(제출 로그 성공비율)은 100 이었다 — 그 값이 다시 나오면 회귀.
  assert.notEqual(s.homeworkSubmitRate, 100, '제출 로그 성공비율(항상 100)로 회귀하면 안 된다');
  // 분모를 화면에서 알 수 있어야 한다(§8-2 자동 REWORK 사유).
  assert.equal(typeof s.homeworkAssignedPairs, 'number', '분모가 응답에 노출돼야 한다');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-2  조회(content_view)는 "학습 활동"이 아니다. 합산 금지·은폐 금지. (§1-C C1/C2 · §6-9)
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-2: content_view 는 학습 활동 수에 불포함 · 조회 지표로 분리 노출', async () => {
  const r = await req(`/stats/perform?scope=class&from=2020-01-01&to=2030-01-01`, ID.teacher);
  const s = r.json.summary;
  assert.equal(s.contentViewCount, 5, '조회 5건은 별도 지표로 보여야 한다(은폐 금지)');
  // 학습 활동 = homework_submit 2 + content_solve 1 = 3. 조회 5건이 섞이면 8 이 된다.
  assert.equal(s.totalActs, 3, '학습 활동 수 = 정본 7종만(조회 5건 미포함)');
  assert.ok(s.totalActs < s.totalActs + s.contentViewCount, '두 지표는 별개 — 합산 금지');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-3  "완료율" 폐기 — 응시율(B3)과 합격률(B4)로 분리. 각 분모 노출. (§6-6)
//   "완료한 평가 중 절반만 완료"라는 자기모순 라벨을 구조적으로 불가능하게 만든다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-3: examCompletionRate 폐기 · examTakeRate/examPassRate 분리 + 분모 노출', async () => {
  const r = await req(`/stats/perform?scope=class&from=2020-01-01&to=2030-01-01`, ID.teacher);
  const s = r.json.summary;
  assert.equal(s.examCompletionRate, undefined, "'완료율'(응시·합격 중 무엇인지 알 수 없음)은 폐기돼야 한다");
  assert.ok('examTakeRate' in s, 'B3 평가 응시율 필드 존재');
  assert.ok('examPassRate' in s, 'B4 평가 합격률 필드 존재');
  assert.ok('examAssignedCount' in s, '응시율 분모(응시 대상 학생 수) 노출');
  assert.ok('examCount' in s, '합격률 분모(응시 건수) 노출');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-4  분모가 없으면 비율을 만들지 않는다 — 0 으로 채우지 않는다. (§4-2 · §6-7)
//   추천 원장이 없으므로 '이행률'은 계산 불가. 0% 로 채우면 "아무도 안 했다"는 거짓이 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-4: 추천 이행률 — 분모(추천 원장) 부재 시 null + 사유 고지(0 채움 금지)', async () => {
  const r = await req(`/stats/custom?scope=class&from=2020-01-01&to=2030-01-01`, ID.teacher);
  assert.equal(r.status, 200);
  const s = r.json.summary;
  assert.equal(s.completionRate, null, "구 '이행률'(result_success 비율)은 폐기 — null");
  assert.equal(s.recoFollowRate, null, 'B5 이행률은 분모 부재 → null(0 금지)');
  assert.equal(s.recoFollowUnavailable, true, '계산 불가 사실을 플래그로 노출');
  assert.ok(s.recoFollowNote && s.recoFollowNote.length > 0, '사용자에게 보여줄 사유 문구 동봉');
  assert.ok('selfDirectedActivityCount' in s, "'추천수'가 아니라 '자기주도 학습 활동 수'임을 키로도 명시");
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-5  "도달률"은 전 화면에서 단 하나의 뜻이어야 한다. (§6-1 · §6-11 · §6-12)
//   폐기된 reachRate(평균 60점 이상 학생 비율)가 '도달률' 이름으로 남아 있으면 안 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-5: 도달률 단일 정의 — equity·class-compare 응답에 폐기 키 reachRate 부재', async () => {
  const cc = await req('/stats/class-compare?period=30d', ID.teacher);
  assert.equal(cc.status, 200);
  assert.ok(!/"reachRate"/.test(cc.raw), 'class-compare 응답에 폐기 키 reachRate 잔존 금지');
  assert.ok(/"groupReachedRate"/.test(cc.raw), 'A3 집단 도달률(groupReachedRate)로 통일');
  // ★ units 뿐 아니라 metrics(격차 지표)까지 응답 전문을 훑는다.
  //   (역주입 검증에서 발견: units 만 보면 metrics.reachRate 부활을 놓친다.)
  const eq = await req('/stats/equity?dim=region', 1); // admin
  assert.equal(eq.status, 200);
  assert.ok(!/"reachRate"/.test(eq.raw), 'equity 응답 전문(units·metrics·priorityUnits)에 reachRate 잔존 금지');
  assert.ok(/"groupReachedRate"/.test(eq.raw), 'equity 도 A3 로 통일');
  // 분모(평가충분 표본)를 반드시 함께 노출 — 비율만 있고 분모를 모르면 §8-2 자동 REWORK.
  for (const u of cc.json.units) {
    assert.ok('evaluatedStudents' in u, `${u.label}: 도달률 분모(evaluatedStudents) 노출 필요`);
    if (u.groupReachedRate == null) {
      assert.equal(u.evaluatedStudents, 0, '표본 0이면 값은 null 이어야 한다(0 채움 금지)');
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-6  "오늘"이라 부르면 값은 오늘이어야 한다 — 기간 누계 금지. (§6-3 · §8-3-2)
//   물리 상한: 학습 시간 ≤ 활동 학생 수 × 1440분. 기간 누계가 '오늘'로 새면 즉시 초과한다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-6: 오늘 학습 시간 ≤ 활동 학생 수 × 1440분(하루) — 기간 누계 오염 검출', async () => {
  const r = await req('/stats/daily-snapshot', ID.teacher);
  assert.equal(r.status, 200);
  assert.equal(r.json.periodAware, false, '기간 파라미터 없으면 오늘/어제 모드여야 한다');
  for (const key of ['today', 'yesterday']) {
    const d = r.json[key];
    assert.ok('learnActs' in d, `${key}: 정본 7종 기준 learnActs 노출(전 유형 totalActs 와 분리)`);
    const cap = Math.max(1, d.learnUsers || 0) * 1440;
    assert.ok((d.learnDurationMin || 0) <= cap,
      `${key}: 학습시간 ${d.learnDurationMin}분 > 물리 상한 ${cap}분 — 기간 누계가 '오늘'로 샜다`);
    assert.ok((d.learnActs || 0) <= (d.totalActs || 0), `${key}: 학습활동(7종) ≤ 전체 활동`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-6b  [감리 R2] period 가 **붙는 경로**까지 검사한다.
//
//   왜 6 만으로는 부족했나: 6 은 period 없이 호출해 "오늘/어제 모드"만 검증했다.
//   그런데 실제 결함은 FE(t-daily·a-daily)가 apiGet 으로 호출해 state.period 를 자동 부착하는 것이었다.
//   BE 는 그때 hasPeriodParam 분기로 **기간 누계**를 today 키에 담아 돌려주고,
//   FE 는 그 값을 '오늘 활동'·'학습시간'·'어제 활동'으로 렌더했다(어제 617,547분).
//   BE 응답만 보던 6 은 이 결함을 통과시켰다 — 그래서 검사 대상을 둘로 늘린다:
//     ① BE 계약: period 를 주면 periodAware=true 이고 today 는 '하루'가 아님을 스스로 밝힌다.
//     ② FE 호출부: '오늘/어제' 라벨 화면은 period 를 붙이는 apiGet 을 쓰지 않는다.
//   ②가 이 결함을 실제로 잡는 검사다(역주입: _fetchNoPeriod → apiGet 으로 되돌리면 빨간불).
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-6b: period 부착 시 periodAware 로 자기고지 + 오늘/어제 라벨 화면은 apiGet 금지', async () => {
  // ① BE 계약 — period 를 주면 '하루'가 아니라는 사실이 응답에 드러나야 한다.
  const r = await req('/stats/daily-snapshot?period=30d', ID.teacher);
  assert.equal(r.status, 200);
  assert.equal(r.json.periodAware, true, 'period 파라미터가 있으면 periodAware=true 로 자기고지해야 한다');
  const t = r.json.today || {};
  assert.ok(t.from && t.to, 'periodAware 응답은 from~to 범위를 밝혀야 한다(하루가 아님을 검산 가능하게)');
  assert.notEqual(t.from, t.to,
    "period 응답의 today 는 '하루'가 아니라 기간 범위다 — 이 값을 '오늘'이라 부르면 안 된다");

  // ② FE 호출부 — '오늘/어제' 고정 화면이 period 를 자동 부착하는 apiGet 을 쓰면 안 된다.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'lrs', 'index.html'), 'utf8');
  for (const view of ['t-daily', 'a-daily']) {
    const start = src.indexOf(`VIEWS['${view}']`);
    assert.ok(start > 0, `${view} 뷰를 찾을 수 있어야 한다`);
    const body = src.slice(start, start + 1600);
    const call = body.match(/(?:await\s+)?(apiGet|_fetchNoPeriod)\s*\(\s*['"`][^'"`]*daily-snapshot/);
    assert.ok(call, `${view}: daily-snapshot 호출부를 찾을 수 있어야 한다`);
    assert.equal(call[1], '_fetchNoPeriod',
      `${view}: '오늘/어제' 라벨 화면인데 ${call[1]} 로 호출한다 — state.period 가 붙어 기간 누계가 '오늘'로 샌다`);
    // 라벨이 '오늘'인데 전 유형(totalActs)을 쓰면 조회·게시글이 학습으로 둔갑한다(정본 7종 위반).
    assert.ok(/learnActs/.test(body), `${view}: 정본 7종 learnActs 를 써야 한다(구 totalActs 단독 사용 금지)`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-7  "보완이 필요한 성취기준"에 **도달한** 기준이 섞이면 안 된다. (§6-10)
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-7: 약점 목록에 도달(reached) 상태 항목 없음 · 미채점은 점수 0 채움 금지', async () => {
  const r = await req('/stats/custom?scope=all&from=2020-01-01&to=2030-01-01', 1); // admin
  assert.equal(r.status, 200);
  const weak = r.json.weakTargets || [];
  for (const w of weak) {
    assert.notEqual(w.status, 'reached', `${w.achievement_code}: 도달한 기준이 약점 목록에 있으면 안 된다`);
    assert.ok('hasScore' in w, '채점 여부를 플래그로 구분해야 한다');
    if (w.hasScore === false) {
      assert.equal(w.avg_score, null, '미채점 항목은 점수를 0 으로 채우지 않고 null');
    } else {
      assert.ok(w.avg_score == null || (w.avg_score >= 0 && w.avg_score <= 100),
        `평균 점수는 0~100 정규화 값이어야 한다 (got ${w.avg_score})`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-8  제출은 성공/실패 판정이 아니다 — 하드코딩 result_success 금지. (§6-5 주의2)
//   routes/homework.js 가 제출 로그에 resultSuccess:1 을 박아 넣으면
//   '제출 로그 성공비율'을 쓰는 어떤 지표든 실데이터에서 항상 100% 가 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-8: homework.js 제출 경로에 resultSuccess 하드코딩 1 이 없다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'homework.js'), 'utf8');
  const submitIdx = src.indexOf("activityType: 'homework_submit'");
  assert.ok(submitIdx > 0, 'homework_submit 로깅 지점을 찾을 수 있어야 한다');
  const block = src.slice(submitIdx, submitIdx + 900);
  assert.ok(!/resultSuccess:\s*1\b/.test(block),
    '제출 로그에 resultSuccess: 1 하드코딩 금지 — 채점 전이므로 결과는 미정(null)');
  assert.ok(/resultSuccess:\s*null/.test(block), '제출 로그의 결과는 null(미정)이어야 한다');
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-9  FE 는 점수 스케일을 되돌리지 않는다. (§2-A-3 금지 패턴 · §6-10-④)
//   `if (n > 0 && n <= 1) n = n * 100` 은 BE 가 이미 정규화한 값에 두 번 곱해
//   정확히 1점이 100점으로 튀는 경계 버그를 만든다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-9: FE 에 점수 스케일 되돌림 폴백(n<=1 → ×100)이 남아 있지 않다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'lrs', 'index.html'), 'utf8');
  const hits = src.match(/n\s*>\s*0\s*&&\s*n\s*<=\s*1[^\n]*\n?[^\n]*n\s*=\s*n\s*\*\s*100/g) || [];
  assert.equal(hits.length, 0,
    `FE 스케일 되돌림 폴백 ${hits.length}곳 잔존 — BE 정규화 계약을 신뢰하고 제거해야 한다`);
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-10  같은 값을 스코프에 따라 다른 이름으로 부르지 않는다. (§8-2 · 부수 항목)
//   avgScore(A5)는 어디서나 '평균 점수'(단위 점)다. '성취수준(정답률)'로 부르면 안 된다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-10: avgScore 라벨이 스코프별로 갈리지 않는다(성취수준(정답률) 표기 폐기)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'lrs', 'index.html'), 'utf8');
  // 라벨 정의부에 남아 있으면 안 되는 문자열(주석 설명은 허용하므로 실제 라벨 리터럴만 검사)
  assert.ok(!/scoreLabel = subjLabel \? `\$\{subjLabel\} 정답률`/.test(src),
    "avgScore 라벨을 '정답률'로 부르는 정의가 남아 있다 — A5 는 '평균 점수'(점)");
  assert.ok(/scoreLabel = subjLabel \? `\$\{subjLabel\} 평균 점수`/.test(src),
    "avgScore 라벨은 '평균 점수'로 통일돼야 한다");
});

// ──────────────────────────────────────────────────────────────────────────
// INV-W2B-12  [감리 R1 · §6-12] "도달률"은 A3(도달 학생 ÷ 평가된 학생) 하나만 뜻한다.
//
//   §6-12 는 "한 페이지에 뜻이 다른 도달률이 2개 이상이면 자동 REWORK" 를 규정한다.
//   실제로 세 종류의 다른 값이 같은 단어를 달고 있었다:
//     · RAW-AVG  학교 ⑥ 전월 대비  = AVG(result_score) (평균 점수)
//     · ACCURACY LRS ④ 영상 행동·학생 추이·학교 성취 추세 = success/attempts (정답률)
//     · A1       도넛 분모에 '평가부족' 포함 (미도달과 동일 취급)
//   아래는 각 발원지가 A3 아닌 값을 '도달률'로 되돌리지 못하게 못 박는다.
// ──────────────────────────────────────────────────────────────────────────
test('INV-W2B-12: 비-A3 값을 도달률이라 부르는 라벨이 되살아나지 않는다', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  // ① 학교 ⑥ 전월 대비 = 평균 점수(RAW-AVG). '도달률' 금지.
  const school = read('public', 'school', 'index.html');
  assert.ok(!/deltaCard\('[^']*도달률'/.test(school),
    "학교 ⑥ 전월 대비(monthCompare)는 평균 점수다 — '도달률' 라벨 금지(§6-12)");
  assert.ok(!/이번 달 도달률/.test(school), "'이번 달 도달률' 은 평균 점수의 오라벨");
  assert.ok(!/주별 도달률/.test(school), "성취 추세 series[].rate 는 정답률 — '주별 도달률' 금지");

  // ② LRS ④ 영상 학습 행동의 성취 축 = 정답률(classifyStatus 미경유).
  const lrsRoute = read('routes', 'lrs.js');
  assert.ok(!/metricLabel:\s*'평균 도달률'/.test(lrsRoute),
    "영상 행동 metricLabel 은 정답률이다 — mastery.reachRate 를 쓰지만 classifyStatus 를 안 탄다");
  const lrsFe = read('public', 'lrs', 'index.html');
  assert.equal((lrsFe.match(/평균 도달률/g) || []).length, 0,
    "FE 에 '평균 도달률'(=정답률) 표기가 남아 있으면 성취 탭의 A3 도달률과 충돌한다");

  // ③ trend.currentRate(주별 정답률)를 '도달률'로 부르지 않는다.
  const analytics = read('db', 'lrs-analytics.js');
  assert.ok(!/지금 도달률은/.test(analytics), 'currentRate 는 정답률 — 학생 문구에서 도달률 금지');
  assert.ok(!/'반 평균 도달률'/.test(analytics), '스코프에 따라 정답률/도달률로 이름이 갈리면 안 된다');

  // ④ 도넛 분모에서 '평가부족' 제외(A3). 포함(A1)하면 미도달과 같은 취급이 된다.
  const classAnalytics = read('public', 'class', 'analytics.html');
  assert.ok(!/reachRate\s*=\s*total\s*>\s*0\s*\?\s*Math\.round\(\(reached\s*\/\s*total\)/.test(classAnalytics),
    '학급 분석 도넛 도달률 분모는 judged(평가된 것) — total(평가부족 포함) 금지');
  assert.ok(/reachRate\s*=\s*judged\s*>\s*0/.test(classAnalytics),
    '학급 분석 도달률은 reached/judged(A3) 여야 한다');
});
