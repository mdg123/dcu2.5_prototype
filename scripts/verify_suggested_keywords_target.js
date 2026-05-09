/**
 * 추천 키워드 대상별 노출 — 자체 검증 스크립트
 *
 * 목적: 서버 재시작 없이 라우트 코드의 정합성과 필터 로직을 점검
 *
 * 검증 항목:
 *   1. routes/admin.js / routes/content.js syntax 정상 require
 *   2. DB 컬럼 존재 + 기존 23건 NULL 유지
 *   3. 신규 INSERT — target_roles=['teacher'] 직접 DB에 넣고 공개 GET 핸들러를 모의 호출
 *      - 학생(student1) 시점 → 노출 안 됨
 *      - 교사(teacher1) 시점 → 노출 됨
 *      - 비로그인 → 노출 안 됨
 *   4. 신규 INSERT — target_grades=[4] 직접 DB
 *      - student1(grade=4) 시점 → 노출 됨
 *      - student3 가상(grade=6) 시점 → 노출 안 됨
 *   5. 신규 INSERT — target_school_levels=['elementary']
 *      - student1(elementary) → 노출
 *      - 비로그인 → 노출 안 됨
 *   6. 정리: 검증용 키워드 삭제
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');

// 1. 라우트 파일 syntax 검증
let adminRoute, contentRoute;
try {
  adminRoute = require('../routes/admin');
  contentRoute = require('../routes/content');
  console.log('[1] routes/admin.js + routes/content.js require OK');
} catch (e) {
  console.error('[1] FAIL:', e.message);
  process.exit(1);
}

// 2. DB 검증
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const cols = db.prepare(`PRAGMA table_info(suggested_keywords)`).all().map(c => c.name);
const required = ['target_school_levels', 'target_roles', 'target_grades', 'target_subjects'];
const missing = required.filter(c => !cols.includes(c));
if (missing.length > 0) {
  console.error('[2] FAIL: 누락 컬럼', missing.join(', '));
  process.exit(1);
}
console.log('[2] DB 컬럼 OK:', required.join(', '));

const totalAll = db.prepare('SELECT COUNT(*) AS c FROM suggested_keywords').get().c;
const allNull = db.prepare(`
  SELECT COUNT(*) AS c FROM suggested_keywords
  WHERE target_school_levels IS NULL AND target_roles IS NULL
    AND target_grades IS NULL AND target_subjects IS NULL
`).get().c;
console.log(`    · 전체 ${totalAll}건 / 모두 NULL ${allNull}건`);

// 3~5. 공개 GET 핸들러를 모의 호출 — 라우트 핸들러를 추출
//     express.Router 의 stack 에서 GET /suggested-keywords 핸들러를 찾는다
function findHandler(router, method, pathStr) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== pathStr) continue;
    if (!layer.route.methods[method]) continue;
    return layer.route.stack.map(s => s.handle); // middleware chain
  }
  return null;
}

const publicHandlers = findHandler(contentRoute, 'get', '/suggested-keywords');
if (!publicHandlers) {
  console.error('[3] FAIL: GET /suggested-keywords 핸들러를 찾을 수 없음');
  process.exit(1);
}
console.log(`[3] 공개 GET 핸들러 추출 OK (middleware ${publicHandlers.length}개)`);

/** Mock req/res 로 핸들러 체인 호출 → res.json() 결과 반환 */
async function callPublicGet(user) {
  return new Promise((resolve, reject) => {
    const req = { user: user, query: {}, body: {}, headers: {}, get: () => null };
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(payload) { resolve({ status: this._status, body: payload }); },
    };
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      const h = publicHandlers[i++];
      if (!h) return reject(new Error('체인 끝까지 갔는데 res.json 없음'));
      try {
        h(req, res, next);
      } catch (e) {
        reject(e);
      }
    };
    next();
  });
}

// 검증용 키워드 INSERT (3종)
function clearTestKeywords() {
  db.prepare(`DELETE FROM suggested_keywords WHERE keyword LIKE '__verify_%'`).run();
}
clearTestKeywords();

const insertStmt = db.prepare(`
  INSERT INTO suggested_keywords
    (keyword, category, search_query, description, display_order, is_active,
     target_school_levels, target_roles, target_grades, target_subjects)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
`);

const VK_TEACHER  = '__verify_교사전용__';
const VK_GRADE4   = '__verify_4학년전용__';
const VK_ELEM     = '__verify_초등전용__';

insertStmt.run(VK_TEACHER, '검증', VK_TEACHER, '교사만',     900, null, JSON.stringify(['teacher']), null, null);
insertStmt.run(VK_GRADE4,  '검증', VK_GRADE4,  '4학년만',    901, null, null, JSON.stringify([4]), null);
insertStmt.run(VK_ELEM,    '검증', VK_ELEM,    '초등만',     902, JSON.stringify(['elementary']), null, null, null);

console.log('[3] 검증용 키워드 3종 INSERT 완료');

// 사용자 mock
const mockStudent1  = { id: 3, role: 'student', school_level: 'elementary', grade: 4 };
const mockStudent6  = { id: 99, role: 'student', school_level: 'elementary', grade: 6 };
const mockTeacher1  = { id: 2, role: 'teacher', school_level: null, grade: 4 };
const mockGuest     = null;

/** 응답 categories에서 keyword 이름 추출 — 평탄화 */
function flattenKeywords(body) {
  const out = [];
  for (const cat of body.categories || []) {
    for (const k of cat.keywords) out.push(k.keyword);
  }
  return out;
}

(async () => {
  const cases = [
    { label: 'student1 (학생, 초등, 4학년)', user: mockStudent1 },
    { label: 'student-grade6 (학생, 초등, 6학년)', user: mockStudent6 },
    { label: 'teacher1 (교사)',             user: mockTeacher1 },
    { label: 'guest (비로그인)',            user: mockGuest },
  ];

  console.log('\n[검증 결과]');
  console.log('대상별 노출 — 검증 키워드 3종 (✓=노출, ✗=미노출):');
  console.log(`  ${'시점'.padEnd(36)}| 교사전용 | 4학년전용 | 초등전용 | 총 노출`);
  console.log('  ' + '-'.repeat(82));

  for (const c of cases) {
    const r = await callPublicGet(c.user);
    if (r.status !== 200) {
      console.error(`  ${c.label}: HTTP ${r.status}`);
      continue;
    }
    const all = flattenKeywords(r.body);
    const showT = all.includes(VK_TEACHER) ? '   ✓    ' : '   ✗    ';
    const showG = all.includes(VK_GRADE4)  ? '    ✓    ' : '    ✗    ';
    const showE = all.includes(VK_ELEM)    ? '   ✓    ' : '   ✗    ';
    console.log(`  ${c.label.padEnd(36)}| ${showT}|${showG}| ${showE}|  ${r.body.total}`);
  }

  // 기대값 표
  console.log(`\n[기대]`);
  console.log(`  ${'시점'.padEnd(36)}| 교사전용 | 4학년전용 | 초등전용`);
  console.log(`  ${'student1 (학생,초등,4학년)'.padEnd(36)}|    ✗    |    ✓     |    ✓   `);
  console.log(`  ${'student-grade6 (학생,초등,6학년)'.padEnd(36)}|    ✗    |    ✗     |    ✓   `);
  console.log(`  ${'teacher1 (교사)'.padEnd(36)}|    ✓    |    ✓*    |    ✗** `);
  console.log(`  ${'guest (비로그인)'.padEnd(36)}|    ✗    |    ✗     |    ✗   `);
  console.log(`    * teacher1.grade=4 임 → grade 매칭됨`);
  console.log(`    ** teacher1.school_level=null → elementary 배열에 매칭 안 됨`);

  // 정리
  clearTestKeywords();
  console.log('\n[정리] 검증용 키워드 삭제 완료');

  // 최종 행 수 확인
  const finalCount = db.prepare('SELECT COUNT(*) AS c FROM suggested_keywords').get().c;
  console.log(`[최종] suggested_keywords 행 수: ${finalCount}`);

  db.close();
})();
