/**
 * 추천 키워드 카테고리 마스터 — Backend 검증 스크립트
 *
 * 사용법:
 *   1) 서버를 port 3000 에서 기동 (nodemon dacheum 등)
 *   2) node scripts/verify_suggested_kw_categories.js
 *
 * 시나리오:
 *   1. 마이그레이션 후 시드 5개 카테고리 row 확인 (GET /api/admin/kw-categories)
 *   2. POST 카테고리 추가 → GET 으로 노출 확인
 *   3. PUT 카테고리 이름 변경 → suggested_keywords.category 일괄 update 확인
 *   4. DELETE 키워드 1건 이상 카테고리 → 409 응답 확인
 *   5. POST migrate-keywords 호출 → 키워드 이동 확인 → DELETE 성공
 *   6. POST reorder → display_order 재부여 확인
 *   7. 키워드 등록 시 마스터에 없는 카테고리 → 자동 생성 확인
 *   8. 공개 GET /api/contents/suggested-keywords 응답에 color/icon/display_order 포함 확인
 *   9. 카테고리 비활성화 → 공개 GET 에서 제외 확인
 *
 * 한글 인코딩 안전: Node fetch 의 JSON body 사용 (curl 사용 X)
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_USER = 'admin';
const ADMIN_PWD = '1234';

let cookieJar = '';

async function call(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (cookieJar) opts.headers['Cookie'] = cookieJar;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookieJar = setCookie.split(',').map(s => s.split(';')[0]).join('; ');
  let j;
  try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}

function header(s) { console.log('\n' + '='.repeat(70) + '\n' + s + '\n' + '='.repeat(70)); }
function step(s) { console.log('\n→ ' + s); }
function check(label, ok, info) {
  const tag = ok ? '  [OK]  ' : '  [FAIL]';
  console.log(tag + label + (info ? ' — ' + info : ''));
  if (!ok) process.exitCode = 1;
}

(async () => {
  header('1. admin 로그인');
  const login = await call('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PWD });
  check('로그인 성공', login.status === 200 && login.body?.success, `status=${login.status}`);
  if (login.status !== 200) { console.error('로그인 실패. ADMIN_PWD를 환경에 맞게 수정하세요.'); return; }

  header('2. 시드 5개 카테고리 확인');
  const list1 = await call('GET', '/api/admin/kw-categories');
  check('GET 200', list1.status === 200);
  check('총 5개 (시드)', list1.body?.total >= 5, `total=${list1.body?.total}`);
  for (const seed of ['교과 학습','시리즈·기획','도구·자료','시기·테마','기타']) {
    const has = list1.body?.categories?.some(c => c.name === seed);
    check(`시드 "${seed}" 존재`, has);
  }

  header('3. POST 카테고리 추가');
  const create = await call('POST', '/api/admin/kw-categories', {
    name: '예술·창작', slug: 'arts-test', color: '#ec4899', icon: 'fa-palette', description: '검증용'
  });
  check('POST 201', create.status === 201, `status=${create.status}`);
  check('응답에 id 포함', !!create.body?.category?.id);
  const newId = create.body?.category?.id;

  header('4. PUT 이름 변경 + cascade — 먼저 키워드 1건 추가');
  const addKw = await call('POST', '/api/admin/suggested-keywords', {
    keyword: '__VERIFY_CALLIGRAPHY__', category: '예술·창작', search_query: '캘리그래피'
  });
  check('키워드 추가 201', addKw.status === 201);
  const newKwId = addKw.body?.keyword?.id;

  step('PUT — 이름 띄어쓰기 변경');
  const put = await call('PUT', `/api/admin/kw-categories/${newId}`, { name: '예술 · 창작' });
  check('PUT 200', put.status === 200);
  check('cascade 1건', put.body?.cascaded_keywords === 1, `cascaded=${put.body?.cascaded_keywords}`);

  step('키워드 테이블에서 cascade 결과 확인');
  const allKw = await call('GET', '/api/admin/suggested-keywords');
  const moved = allKw.body?.keywords?.find(k => k.id === newKwId);
  check('키워드 category가 새 이름으로 갱신됨', moved?.category === '예술 · 창작', `category="${moved?.category}"`);

  header('5. DELETE 시 키워드 1건 이상 → 409');
  const del409 = await call('DELETE', `/api/admin/kw-categories/${newId}`);
  check('409 응답', del409.status === 409);
  check('code=CATEGORY_HAS_KEYWORDS', del409.body?.code === 'CATEGORY_HAS_KEYWORDS');
  check('keyword_count=1', del409.body?.keyword_count === 1);

  header('6. migrate-keywords — 6번 → 5번(기타)으로 이동');
  const migrate = await call('POST', `/api/admin/kw-categories/${newId}/migrate-keywords`, { target_id: 5 });
  check('migrate 200', migrate.status === 200);
  check('moved=1', migrate.body?.moved === 1, `moved=${migrate.body?.moved}`);

  step('이동 후 DELETE 시도 → 200');
  const delOK = await call('DELETE', `/api/admin/kw-categories/${newId}`);
  check('DELETE 200', delOK.status === 200);

  step('잔여 캘리그래피 키워드 정리');
  await call('DELETE', `/api/admin/suggested-keywords/${newKwId}`);

  header('7. reorder');
  const reord = await call('POST', '/api/admin/kw-categories/reorder', {
    ids: [4, 3, 2, 1, 5], base: 100, step: 100
  });
  check('reorder 200', reord.status === 200);
  check('updated=5', reord.body?.updated === 5);
  // 복구
  await call('POST', '/api/admin/kw-categories/reorder', { ids: [1, 2, 3, 4, 5], base: 100, step: 100 });

  header('8. 키워드 등록 시 마스터 부재 카테고리 → 자동 생성');
  const autoKw = await call('POST', '/api/admin/suggested-keywords', {
    keyword: '__VERIFY_AI__', category: '디지털·AI'
  });
  check('키워드 추가 201', autoKw.status === 201);
  const list2 = await call('GET', '/api/admin/kw-categories');
  const autoCat = list2.body?.categories?.find(c => c.name === '디지털·AI');
  check('카테고리 자동 생성됨', !!autoCat);
  check('자동 생성 slug 부여', !!autoCat?.slug, `slug=${autoCat?.slug}`);
  check('디폴트 색·아이콘', autoCat?.color === '#2563eb' && autoCat?.icon === 'fa-bookmark');
  // 정리
  if (autoKw.body?.keyword?.id) await call('DELETE', `/api/admin/suggested-keywords/${autoKw.body.keyword.id}`);
  if (autoCat?.id) await call('DELETE', `/api/admin/kw-categories/${autoCat.id}`);

  header('9. 공개 GET /api/contents/suggested-keywords — 카테고리 메타 포함');
  cookieJar = ''; // 비로그인으로 호출
  const pub = await call('GET', '/api/contents/suggested-keywords');
  check('GET 200', pub.status === 200);
  check('categories 배열 존재', Array.isArray(pub.body?.categories));
  const sample = pub.body?.categories?.[0];
  check('첫 카테고리에 color 포함', typeof sample?.color === 'string' && sample.color.startsWith('#'), `color=${sample?.color}`);
  check('첫 카테고리에 icon 포함', typeof sample?.icon === 'string' && sample.icon.startsWith('fa-'), `icon=${sample?.icon}`);
  check('첫 카테고리에 display_order 포함', Number.isInteger(sample?.display_order), `order=${sample?.display_order}`);
  check('첫 카테고리에 slug 포함', typeof sample?.slug === 'string', `slug=${sample?.slug}`);

  header('10. 카테고리 비활성화 → 공개 GET 에서 제외');
  // 다시 admin 로그인
  await call('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PWD });
  await call('PUT', `/api/admin/kw-categories/2`, { is_active: 0 });
  cookieJar = '';
  const pub2 = await call('GET', '/api/contents/suggested-keywords');
  const seriesGone = !pub2.body?.categories?.some(c => c.name === '시리즈·기획');
  check('비활성 카테고리 응답에서 제외', seriesGone);
  // 복구
  await call('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PWD });
  await call('PUT', `/api/admin/kw-categories/2`, { is_active: 1 });

  console.log('\n=== 검증 완료 ===');
})();
