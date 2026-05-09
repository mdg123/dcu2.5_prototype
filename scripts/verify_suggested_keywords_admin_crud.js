/**
 * 관리자 CRUD 검증 — POST/PUT/GET 핸들러 직접 호출
 *
 * 인증 미들웨어(adminOnly)를 우회하기 위해 핸들러 체인의 마지막 함수만 추출 호출.
 * 검증 항목:
 *   - POST: target_* 4개 컬럼 모두 받아서 저장 + 응답에 배열로 직렬화
 *   - GET (admin): 모든 행에 target_* 4개 필드(배열) 포함
 *   - PUT: target_roles 비우기(null) → DB NULL 저장 + 응답 빈 배열
 *   - 잘못된 값 검증: invalid role, grade 13 등 400 응답
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const adminRoute = require('../routes/admin');
const db = new Database(DB_PATH);

// 핸들러 추출 — 체인의 마지막 함수(실제 비즈니스 로직)만 호출
function findLastHandler(router, method, pathStr) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== pathStr) continue;
    if (!layer.route.methods[method]) continue;
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  }
  return null;
}

const adminGet    = findLastHandler(adminRoute, 'get',    '/suggested-keywords');
const adminPost   = findLastHandler(adminRoute, 'post',   '/suggested-keywords');
const adminPut    = findLastHandler(adminRoute, 'put',    '/suggested-keywords/:id');
const adminDelete = findLastHandler(adminRoute, 'delete', '/suggested-keywords/:id');

if (!adminGet || !adminPost || !adminPut || !adminDelete) {
  console.error('FAIL: 핸들러 추출 실패', { adminGet:!!adminGet, adminPost:!!adminPost, adminPut:!!adminPut, adminDelete:!!adminDelete });
  process.exit(1);
}
console.log('[추출] admin GET/POST/PUT/DELETE 핸들러 OK');

const adminUser = { id: 1, username: 'admin', role: 'admin' };

function call(handler, body = {}, params = {}, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { user: adminUser, body, params, query, headers: {}, get: () => null };
    const res = {
      _status: 200,
      status(c) { this._status = c; return this; },
      json(p) { resolve({ status: this._status, body: p }); },
    };
    try { handler(req, res); } catch (e) { reject(e); }
  });
}

// 정리: 이전 검증 잔여물 제거
db.prepare(`DELETE FROM suggested_keywords WHERE keyword LIKE '__crud_%'`).run();

(async () => {
  console.log('\n--- A. POST 신규 키워드 (target_roles=[teacher], target_grades=[4,5]) ---');
  const r1 = await call(adminPost, {
    keyword: '__crud_TEST_A__',
    category: '검증',
    search_query: '__crud_TEST_A__',
    description: '교사+학년45',
    target_roles: ['teacher'],
    target_grades: [4, 5],
  });
  console.log(`  status=${r1.status}`);
  console.log(`  응답 keyword:`, JSON.stringify({
    id: r1.body.keyword.id,
    target_roles: r1.body.keyword.target_roles,
    target_grades: r1.body.keyword.target_grades,
    target_school_levels: r1.body.keyword.target_school_levels,
    target_subjects: r1.body.keyword.target_subjects,
  }));
  // DB 직접 확인
  const dbRow = db.prepare(`SELECT target_roles, target_grades FROM suggested_keywords WHERE id = ?`).get(r1.body.keyword.id);
  console.log(`  DB 저장값: target_roles=${dbRow.target_roles} / target_grades=${dbRow.target_grades}`);
  const idA = r1.body.keyword.id;

  console.log('\n--- B. POST 잘못된 role (["wizard"]) ---');
  const r2 = await call(adminPost, {
    keyword: '__crud_TEST_B__',
    target_roles: ['wizard'],
  });
  console.log(`  status=${r2.status} message="${r2.body.message}"`);

  console.log('\n--- C. POST 잘못된 grade (13) ---');
  const r3 = await call(adminPost, {
    keyword: '__crud_TEST_C__',
    target_grades: [13],
  });
  console.log(`  status=${r3.status} message="${r3.body.message}"`);

  console.log('\n--- D. POST 잘못된 subject ("코딩") ---');
  const r4 = await call(adminPost, {
    keyword: '__crud_TEST_D__',
    target_subjects: ['코딩'],
  });
  console.log(`  status=${r4.status} message="${r4.body.message}"`);

  console.log('\n--- E. PUT target_roles=[] (비우기) → null 저장 ---');
  const r5 = await call(adminPut, { target_roles: [] }, { id: String(idA) });
  console.log(`  status=${r5.status}`);
  console.log(`  응답 target_roles:`, JSON.stringify(r5.body.keyword.target_roles));
  const dbRow5 = db.prepare(`SELECT target_roles, target_grades FROM suggested_keywords WHERE id = ?`).get(idA);
  console.log(`  DB 저장값: target_roles=${dbRow5.target_roles} / target_grades=${dbRow5.target_grades}`);

  console.log('\n--- F. PUT target_school_levels=["elementary","middle"], target_subjects=["수학"] ---');
  const r6 = await call(adminPut, {
    target_school_levels: ['elementary', 'middle'],
    target_subjects: ['수학'],
  }, { id: String(idA) });
  console.log(`  status=${r6.status}`);
  console.log(`  응답:`, JSON.stringify({
    target_school_levels: r6.body.keyword.target_school_levels,
    target_subjects: r6.body.keyword.target_subjects,
  }));

  console.log('\n--- G. GET 전체 목록 — 모든 행에 target_* 4개 필드(배열) 포함? ---');
  const r7 = await call(adminGet);
  console.log(`  status=${r7.status} total=${r7.body.total}`);
  const sample = r7.body.keywords[0];
  const needed = ['target_school_levels', 'target_roles', 'target_grades', 'target_subjects'];
  const ok = needed.every(k => Array.isArray(sample[k]));
  console.log(`  첫 행에 4개 필드 모두 배열 형태? ${ok ? 'OK' : 'FAIL'}`);
  console.log(`  sample row[0] target_*:`, needed.reduce((acc,k) => { acc[k] = sample[k]; return acc; }, {}));

  // crud 검증 키워드 정리
  console.log('\n--- 정리 ---');
  db.prepare(`DELETE FROM suggested_keywords WHERE keyword LIKE '__crud_%'`).run();
  const final = db.prepare(`SELECT COUNT(*) AS c FROM suggested_keywords`).get().c;
  console.log(`  suggested_keywords 행 수: ${final}`);
  db.close();
})();
