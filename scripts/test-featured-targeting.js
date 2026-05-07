// 추천콘텐츠 타깃팅·게시기간·예약발행 검증 스크립트
const BASE = 'http://localhost:3000';

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const cookie = r.headers.get('set-cookie') || '';
  const text = await r.text();
  return { cookie: cookie.split(';')[0] || '', body: text };
}

async function api(method, path, cookie, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let json;
  try { json = JSON.parse(t); } catch (_) { json = { _raw: t }; }
  return { status: r.status, json };
}

(async () => {
  console.log('=== 1. admin login ===');
  const adm = await login('admin', '1234');
  console.log('admin cookie:', adm.cookie ? 'OK' : 'FAIL');

  console.log('\n=== 2. List sections (admin) ===');
  const list = await api('GET', '/api/admin/featured/sections', adm.cookie);
  console.log('status:', list.status);
  console.log('first section sample:', JSON.stringify(list.json.sections?.[0], null, 2).slice(0, 500));

  console.log('\n=== 3. PATCH section 1 — set targeting (future scheduled) ===');
  const patchRes1 = await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    target_roles: ['student', 'parent'],
    target_school_levels: ['elementary'],
    publish_start: '2026-05-08T09:00:00.000Z',
    publish_end: '2026-05-31T23:59:59.000Z'
  });
  console.log('status:', patchRes1.status);
  console.log('updated section:', JSON.stringify(patchRes1.json.section, null, 2));
  console.log('Expected: status_derived=scheduled, isPublishedNow=false');

  console.log('\n=== 4. PATCH section 1 — backdate publish_start to make published ===');
  const patchRes2 = await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    publish_start: '2026-05-01T00:00:00.000Z'
  });
  console.log('status:', patchRes2.status);
  console.log('status_derived:', patchRes2.json.section?.status_derived);
  console.log('isPublishedNow:', patchRes2.json.section?.isPublishedNow);
  console.log('Expected: status_derived=published, isPublishedNow=true');

  console.log('\n=== 5. Audience preview ===');
  const audience = await api('GET', '/api/admin/featured/sections/1/preview-audience', adm.cookie);
  console.log('status:', audience.status);
  console.log('audience:', JSON.stringify(audience.json));

  console.log('\n=== 6. Student1 (elementary, student) — should see section 1 ===');
  const stu = await login('student1', '1234');
  const stuFeat = await api('GET', '/api/contents/featured', stu.cookie);
  const allKeys_stu = (stuFeat.json.sections || []).map(s => s.key);
  const sec1Visible_stu = allKeys_stu.includes('planning');
  console.log('student1 sees keys:', allKeys_stu.join(','));
  console.log('student1 sees planning?', sec1Visible_stu, '(expected: TRUE)');

  console.log('\n=== 7. Teacher1 — should NOT see section 1 (target_roles excludes teacher) ===');
  const tch = await login('teacher1', '1234');
  const tchFeat = await api('GET', '/api/contents/featured', tch.cookie);
  const allKeys_tch = (tchFeat.json.sections || []).map(s => s.key);
  const sec1Visible_tch = allKeys_tch.includes('planning');
  console.log('teacher1 sees keys:', allKeys_tch.join(','));
  console.log('teacher1 sees planning?', sec1Visible_tch, '(expected: FALSE)');

  console.log('\n=== 8. Anonymous — should NOT see section 1 (target_roles is array, not all) ===');
  const anonFeat = await api('GET', '/api/contents/featured', '');
  const allKeys_anon = (anonFeat.json.sections || []).map(s => s.key);
  const sec1Visible_anon = allKeys_anon.includes('planning');
  console.log('anon sees keys:', allKeys_anon.join(','));
  console.log('anon sees planning?', sec1Visible_anon, '(expected: FALSE)');

  console.log('\n=== 9. Parent1 — role=parent matches but school_level NULL → array["elementary"] mismatch → should NOT see ===');
  const pa = await login('parent1', '1234');
  const paFeat = await api('GET', '/api/contents/featured', pa.cookie);
  const allKeys_p = (paFeat.json.sections || []).map(s => s.key);
  const sec1Visible_p = allKeys_p.includes('planning');
  console.log('parent1 sees keys:', allKeys_p.join(','));
  console.log('parent1 sees planning?', sec1Visible_p, '(expected: FALSE — school_level NULL fails ["elementary"] match)');

  console.log('\n=== 10. Set publish_end to past → status_derived=expired, no users see ===');
  const patchRes3 = await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    publish_end: '2026-05-06T23:59:59.000Z'
  });
  console.log('status_derived:', patchRes3.json.section?.status_derived, '(expected: expired)');
  const stuFeat2 = await api('GET', '/api/contents/featured', stu.cookie);
  const sec1Visible_stu2 = (stuFeat2.json.sections || []).some(s => s.key === 'planning');
  console.log('student1 sees planning (after expired)?', sec1Visible_stu2, '(expected: FALSE)');

  console.log('\n=== 11. Reset section 1 — back to original state ===');
  const reset = await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    target_roles: 'all',
    target_school_levels: 'all',
    publish_start: null,
    publish_end: null
  });
  console.log('reset section:', JSON.stringify(reset.json.section, null, 2));
  console.log('Expected: target_roles=all, target_school_levels=all, status_derived=published');

  console.log('\n=== 12. After reset — student1, teacher1, anon should all see planning ===');
  const stuFeat3 = await api('GET', '/api/contents/featured', stu.cookie);
  const tchFeat3 = await api('GET', '/api/contents/featured', tch.cookie);
  const anonFeat3 = await api('GET', '/api/contents/featured', '');
  console.log('student1 keys:', (stuFeat3.json.sections || []).map(s => s.key).join(','));
  console.log('teacher1 keys:', (tchFeat3.json.sections || []).map(s => s.key).join(','));
  console.log('anon     keys:', (anonFeat3.json.sections || []).map(s => s.key).join(','));
  console.log('Expected for all 3: planning,recommend,channels,new');

  console.log('\n=== 13. Validation: invalid datetime ===');
  const bad = await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    publish_start: 'not-a-date'
  });
  console.log('status:', bad.status, 'code:', bad.json.code, '(expected: 400 INVALID_PAYLOAD)');

  console.log('\n=== 14. Validation: invalid role filtered out ===');
  const bad2 = await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    target_roles: ['not_a_role', 'student']
  });
  console.log('status:', bad2.status, 'target_roles after filter:', bad2.json.section?.target_roles, '(expected: ["student"])');

  // cleanup
  await api('PATCH', '/api/admin/featured/sections/1', adm.cookie, {
    target_roles: 'all', target_school_levels: 'all', publish_start: null, publish_end: null
  });
  console.log('\n=== DONE ===');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
