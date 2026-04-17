/**
 * STEP02 채움콘텐츠 전체 검증 스크립트
 */
const http = require('http');

function req(m, p, b, c) {
  return new Promise(r => {
    const o = { hostname: 'localhost', port: 3000, path: p, method: m, headers: { Cookie: c || '' } };
    let data;
    if (b) { data = JSON.stringify(b); o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = Buffer.byteLength(data); }
    const q = http.request(o, s => { let x = ''; s.on('data', k => x += k); s.on('end', () => { let j; try { j = JSON.parse(x); } catch { j = x; } r({ status: s.statusCode, data: j, cookies: s.headers['set-cookie'] || [] }); }); });
    if (data) q.write(data); q.end();
  });
}

let total = 0, pass = 0, fail = 0; const fails = [];
function chk(n, ok, d) { total++; if (ok) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, d || ''); } }

async function main() {
  console.log('=== STEP02 채움콘텐츠 전체 검증 ===');

  const lt = await req('POST', '/api/auth/login', { username: 'teacher1', password: '1234' });
  const ct = lt.cookies.map(x => x.split(';')[0]).join('; ');
  const ls = await req('POST', '/api/auth/login', { username: 'student1', password: '1234' });
  const cs = ls.cookies.map(x => x.split(';')[0]).join('; ');
  const la = await req('POST', '/api/auth/login', { username: 'admin', password: '0000' });
  const ca = la.cookies.map(x => x.split(';')[0]).join('; ');

  // === 1단계: 콘텐츠 업로드 ===
  console.log('\n--- 1단계: 콘텐츠 업로드 ---');
  const up = await req('POST', '/api/upload?type=contents', null, ct);
  chk('업로드 API 존재', up.status !== 404, 'status=' + up.status);

  const c1 = await req('POST', '/api/contents', { title: '검증: 영상', content_type: 'video', content_url: 'https://example.com/v.mp4', subject: '수학', grade: 4, tags: '분수,영상', is_public: true }, ct);
  chk('콘텐츠 생성(영상)', c1.status === 201, 'status=' + c1.status);
  chk('교사 공개→pending', c1.data.content?.status === 'pending', 'got=' + c1.data.content?.status);

  const c2 = await req('POST', '/api/contents', { title: '검증: 문서', content_type: 'document', file_path: '/uploads/test.pdf', is_public: false }, ct);
  chk('비공개→draft', c2.data.content?.status === 'draft', 'got=' + c2.data.content?.status);

  const c3 = await req('POST', '/api/contents', { content_type: 'video' }, ct);
  chk('title없으면 400', c3.status === 400, 'status=' + c3.status);

  // === 2단계: 상세 조회 ===
  console.log('\n--- 2단계: 상세 조회 ---');
  const d1 = await req('GET', '/api/contents/1', null, ct);
  chk('상세 조회', d1.status === 200);
  chk('view_count>=1', d1.data.content?.view_count >= 1);
  chk('content_url 존재', d1.data.content?.content_url !== undefined);

  // === 3단계: 공개콘텐츠 검색 ===
  console.log('\n--- 3단계: 공개콘텐츠 검색 ---');
  const pub = await req('GET', '/api/contents?page=1&limit=10', null, ct);
  chk('공개 목록', pub.status === 200);
  const pl = pub.data.contents || [];
  chk('approved만', pl.every(x => x.status === 'approved'), 'non-ap=' + pl.filter(x => x.status !== 'approved').length);

  const sk = await req('GET', '/api/contents?keyword=' + encodeURIComponent('분수'), null, ct);
  chk('키워드 검색', sk.status === 200 && (sk.data.contents || []).length >= 1);

  const sf = await req('GET', '/api/contents?content_type=video', null, ct);
  chk('유형 필터', sf.status === 200);

  const ss = await req('GET', '/api/contents?subject=' + encodeURIComponent('수학'), null, ct);
  chk('과목 필터', ss.status === 200);

  const so = await req('GET', '/api/contents?sort=popular', null, ct);
  chk('인기순 정렬', so.status === 200);

  const sp = await req('GET', '/api/contents?page=1&limit=3', null, ct);
  chk('페이지네이션', sp.status === 200 && sp.data.totalPages >= 1);

  // === 4단계: 보관함 ===
  console.log('\n--- 4단계: 보관함 ---');
  const sv = await req('POST', '/api/contents/collection/2', { folder: '수학자료' }, cs);
  chk('보관함 담기', sv.status === 200 || sv.status === 201 || sv.status === 409, 'status=' + sv.status);

  const sl = await req('GET', '/api/contents/collection/list', null, cs);
  chk('보관함 목록', sl.status === 200);
  const cl = sl.data.contents || sl.data.data || [];
  chk('담은 콘텐츠 존재', cl.length >= 1, 'count=' + cl.length);

  const sd = await req('POST', '/api/contents/collection/2', { folder: '수학자료' }, cs);
  chk('중복 담기 409', sd.status === 409, 'status=' + sd.status);

  const sff = await req('GET', '/api/contents/collection/list?folder=' + encodeURIComponent('수학자료'), null, cs);
  chk('폴더 필터', sff.status === 200);

  // === 5단계: 채널 ===
  console.log('\n--- 5단계: 채널 ---');
  const ch = await req('POST', '/api/contents/channels', { name: '검증채널', description: '테스트' }, ct);
  chk('채널 생성/기존', ch.status === 201 || ch.status === 409, 'status=' + ch.status);

  const chl = await req('GET', '/api/contents/channels/list', null, ct);
  chk('채널 목록', chl.status === 200);

  if (chl.data.channels && chl.data.channels.length > 0) {
    const chid = chl.data.channels[0].id;
    const sub = await req('POST', '/api/contents/channels/' + chid + '/subscribe', {}, cs);
    chk('채널 구독', sub.status === 200, 'status=' + sub.status);
    const subList = await req('GET', '/api/contents/channels/subscriptions/list', null, cs);
    chk('구독 목록', subList.status === 200);
  }

  // === 6단계: 승인 ===
  console.log('\n--- 6단계: 승인 워크플로우 ---');
  const sc = await req('POST', '/api/contents', { title: '학생공개', content_type: 'image', is_public: true }, cs);
  chk('학생 공개→pending', sc.data.content?.status === 'pending');

  const apid = sc.data.content?.id;
  const ap = await req('POST', '/api/contents/' + apid + '/approve', {}, ca);
  chk('승인', ap.status === 200 && ap.data.content?.status === 'approved');

  const sc2 = await req('POST', '/api/contents', { title: '반려대상', content_type: 'quiz', is_public: true }, cs);
  const rj = await req('POST', '/api/contents/' + sc2.data.content?.id + '/reject', { reason: '부적절' }, ca);
  chk('반려+사유', rj.status === 200 && rj.data.content?.reject_reason === '부적절');

  const sc3 = await req('POST', '/api/contents', { title: '보류대상', content_type: 'document', is_public: true }, cs);
  const ho = await req('POST', '/api/contents/' + sc3.data.content?.id + '/hold', { reason: '확인필요' }, ca);
  chk('보류', ho.status === 200 && ho.data.content?.status === 'hold');

  const sc4 = await req('POST', '/api/contents', { title: '검토대상', content_type: 'video', is_public: true }, cs);
  const rv = await req('POST', '/api/contents/' + sc4.data.content?.id + '/review', {}, ca);
  chk('검토중', rv.status === 200 && rv.data.content?.status === 'review');

  const rall = await req('GET', '/api/contents/review-all?status=all', null, ca);
  chk('승인관리 목록', rall.status === 200 && rall.data.contents?.length >= 1);

  // === 7단계: 좋아요 ===
  console.log('\n--- 7단계: 좋아요 ---');
  const lk = await req('POST', '/api/contents/1/like', {}, cs);
  chk('좋아요', lk.status === 200);

  // === 보너스 ===
  console.log('\n--- 보너스 ---');
  chk('내 콘텐츠', (await req('GET', '/api/contents/my', null, ct)).status === 200);
  chk('추천 콘텐츠', (await req('GET', '/api/contents/recommendations', null, ct)).status === 200);

  // 결과
  console.log('\n=== 결과 ===');
  console.log(`총 ${total}건 | ✅ ${pass}건 | ❌ ${fail}건`);
  console.log(`성공률: ${((pass / total) * 100).toFixed(1)}%`);
  if (fails.length) console.log('실패:', fails.join(', '));
}

main().catch(e => console.error('ERROR:', e));
