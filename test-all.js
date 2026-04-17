/**
 * 다채움 2.0 종합 테스트 스크립트 v2
 * TEST_PLAN.md Phase 0~18 전체 재귀 검증
 * - API 응답 구조를 정확히 반영
 */
const http = require('http');
const BASE = 'http://localhost:3000';

// ─── HTTP helpers ───
function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: {}
    };
    if (cookie) options.headers.Cookie = cookie;
    let data;
    if (body) {
      data = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(d); } catch { parsed = d; }
        resolve({ status: r.statusCode, cookies: r.headers['set-cookie'] || [], data: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = (p, c) => request('GET', p, null, c);
const post = (p, b, c) => request('POST', p, b, c);
const put = (p, b, c) => request('PUT', p, b, c);
const del = (p, c) => request('DELETE', p, null, c);

// ─── Session store ───
const sessions = {};
async function login(username, password) {
  const r = await post('/api/auth/login', { username, password: password || '1234' });
  if (r.status === 200 && r.cookies.length) {
    sessions[username] = r.cookies.map(c => c.split(';')[0]).join('; ');
  }
  return r;
}
function s(user) { return sessions[user]; }

// ─── Test tracking ───
let total = 0, pass = 0, fail = 0;
const failures = [];
function check(name, condition, detail) {
  total++;
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// ─── Shared IDs ───
const ids = {
  contents: [], classes: [], lessons: [], homework: [],
  exams: [], notices: [], posts: [], surveys: [],
  submissions: [], dailySets: [], problemSets: [],
  galleries: [], messageRooms: [], userIds: {}
};

// ═══ Phase 0 ═══
async function phase0() {
  console.log('\n═══ Phase 0: 서버 기동 확인 ═══');
  const r = await get('/api/auth/me');
  check('서버 응답', r.status === 200 || r.status === 401);
  const lr = await login('admin', '0000');
  check('Admin 로그인', lr.status === 200);
  const st = await get('/api/admin/stats', s('admin'));
  check('Admin 통계', st.status === 200 && st.data.success);
  const cu = await get('/api/curriculum/subjects?school_level=' + encodeURIComponent('초'), s('admin'));
  check('교육과정 초기화', cu.status === 200 && cu.data.data?.length > 0, `교과 수: ${cu.data.data?.length}`);
}

// ═══ Phase 1 ═══
async function phase1() {
  console.log('\n═══ Phase 1: 계정 인증 ═══');
  for (const u of ['teacher1','teacher2','teacher3','student1','student2','student3','student4','student5','student6']) {
    const r = await login(u, '1234');
    check(`${u} 로그인`, r.status === 200, `status=${r.status}`);
  }
  // Get user IDs
  for (const u of ['teacher1','teacher2','teacher3','student1','student2','student3','student4','student5','student6','admin']) {
    if (s(u)) {
      const me = await get('/api/auth/me', s(u));
      if (me.data.user) ids.userIds[u] = me.data.user.id;
    }
  }
  check('teacher1=teacher', (await get('/api/auth/me', s('teacher1'))).data.user?.role === 'teacher');
  check('student1=student', (await get('/api/auth/me', s('student1'))).data.user?.role === 'student');
  console.log(`  📋 User IDs: ${JSON.stringify(ids.userIds)}`);
}

// ═══ Phase 2: 채움콘텐츠 ═══
async function phase2() {
  console.log('\n═══ Phase 2: 채움콘텐츠 ═══');
  // 내 콘텐츠
  const my = await get('/api/contents/my', s('teacher1'));
  check('내 콘텐츠 조회', my.status === 200);
  // 공개 콘텐츠
  const pub = await get('/api/contents?page=1&limit=20', s('teacher1'));
  check('공개 콘텐츠 목록', pub.status === 200);
  const list = pub.data.data || pub.data.contents || [];
  check('콘텐츠 존재', list.length >= 1, `count=${list.length}`);
  list.forEach(c => ids.contents.push({ id: c.id, type: c.content_type }));
  console.log(`  📋 콘텐츠: ${ids.contents.length}개 (${ids.contents.map(c=>c.type).join(',')})`);

  // 검색
  check('키워드 검색', (await get('/api/contents?keyword=' + encodeURIComponent('분수'), s('teacher1'))).status === 200);
  check('유형 필터', (await get('/api/contents?content_type=video', s('teacher1'))).status === 200);
  // 보관함
  if (ids.contents.length) {
    const cid = ids.contents[0].id;
    const add = await post(`/api/contents/collection/${cid}`, { folder: '수학자료' }, s('student1'));
    check('보관함 담기', add.status === 200 || add.status === 201 || add.status === 409, `status=${add.status}`);
    check('보관함 목록', (await get('/api/contents/collection/list', s('student1'))).status === 200);
    // 좋아요
    const like = await post(`/api/contents/${cid}/like`, {}, s('student2'));
    check('좋아요', like.status === 200 || like.status === 201, `status=${like.status}`);
  }
  // 채널
  check('채널 목록', (await get('/api/contents/channels/list', s('teacher1'))).status === 200);
}

// ═══ Phase 3: 채움클래스 ═══
async function phase3() {
  console.log('\n═══ Phase 3: 채움클래스 ═══');
  // teacher1 classes
  const c1 = await get('/api/class/my', s('teacher1'));
  check('teacher1 클래스 목록', c1.status === 200);
  (c1.data.classes || []).forEach(c => {
    if (c.my_role === 'owner') ids.classes.push({ id: c.id, name: c.name, code: c.code, teacher: 'teacher1' });
  });
  // teacher2 classes
  const c2 = await get('/api/class/my', s('teacher2'));
  (c2.data.classes || []).forEach(c => {
    if (c.my_role === 'owner' && !ids.classes.find(x => x.id === c.id))
      ids.classes.push({ id: c.id, name: c.name, code: c.code, teacher: 'teacher2' });
  });
  // teacher3 classes
  const c3 = await get('/api/class/my', s('teacher3'));
  (c3.data.classes || []).forEach(c => {
    if (c.my_role === 'owner' && !ids.classes.find(x => x.id === c.id))
      ids.classes.push({ id: c.id, name: c.name, code: c.code, teacher: 'teacher3' });
  });
  check('클래스 >= 3개', ids.classes.length >= 3, `count=${ids.classes.length}`);
  console.log(`  📋 클래스: ${ids.classes.map(c=>`[${c.id}]${c.name}(${c.teacher})`).join(', ')}`);

  // 학생 클래스
  const sc = await get('/api/class/my', s('student1'));
  const stClasses = sc.data.classes || [];
  check('student1 클래스 가입', stClasses.length >= 1, `count=${stClasses.length}`);

  // 상세/멤버
  if (ids.classes.length) {
    const cl = ids.classes[0];
    check('클래스 상세', (await get(`/api/class/${cl.id}`, s(cl.teacher))).status === 200);
    const mem = await get(`/api/class/${cl.id}/members`, s(cl.teacher));
    check('멤버 목록', mem.status === 200);
    const members = mem.data.data || mem.data.members || [];
    check('멤버 >= 2', members.length >= 2, `count=${members.length}`);
  }
  check('클래스 검색', (await get('/api/class/search?keyword=' + encodeURIComponent('수학'), s('student1'))).status === 200);
}

// ═══ Phase 4: 수업 ═══
async function phase4() {
  console.log('\n═══ Phase 4: 수업 ═══');
  for (const cls of ids.classes) {
    const r = await get(`/api/lesson/${cls.id}`, s(cls.teacher));
    check(`[${cls.name}] 수업 목록`, r.status === 200);
    (r.data.lessons || []).forEach(l => {
      if (!ids.lessons.find(x => x.id === l.id))
        ids.lessons.push({ id: l.id, classId: cls.id, teacher: cls.teacher, title: l.title });
    });
  }
  check('수업 존재', ids.lessons.length >= 1, `count=${ids.lessons.length}`);
  console.log(`  📋 수업: ${ids.lessons.map(l=>`[${l.id}]${l.title}`).join(', ')}`);

  if (ids.lessons.length) {
    const ls = ids.lessons[0];
    // 상세
    const detail = await get(`/api/lesson/${ls.classId}/${ls.id}`, s(ls.teacher));
    check('수업 상세', detail.status === 200);
    // 학생 이수
    const p1 = await post(`/api/lesson/${ls.classId}/${ls.id}/progress`, { progress: 100 }, s('student1'));
    check('student1 이수 (100%)', p1.status === 200 || p1.status === 201, `status=${p1.status} ${JSON.stringify(p1.data).substring(0,80)}`);
    const p2 = await post(`/api/lesson/${ls.classId}/${ls.id}/progress`, { progress: 75 }, s('student2'));
    check('student2 진도 (75%)', p2.status === 200 || p2.status === 201, `status=${p2.status}`);
    const p3 = await post(`/api/lesson/${ls.classId}/${ls.id}/progress`, { progress: 100 }, s('student3'));
    check('student3 이수 (100%)', p3.status === 200 || p3.status === 201, `status=${p3.status}`);
    // 이수율
    const cr = await get(`/api/lesson/${ls.classId}/completion-rate`, s(ls.teacher));
    check('이수율 조회', cr.status === 200, `status=${cr.status} ${JSON.stringify(cr.data).substring(0,80)}`);
    // 보드 뷰
    check('수업 보드', (await get(`/api/lesson/${ls.classId}/board`, s(ls.teacher))).status === 200);
  }
}

// ═══ Phase 5: 과제 ═══
async function phase5() {
  console.log('\n═══ Phase 5: 과제 ═══');
  for (const cls of ids.classes) {
    const r = await get(`/api/homework/${cls.id}`, s(cls.teacher));
    check(`[${cls.name}] 과제 목록`, r.status === 200);
    (r.data.homework || []).forEach(h => {
      if (!ids.homework.find(x => x.id === h.id))
        ids.homework.push({ id: h.id, classId: cls.id, teacher: cls.teacher, title: h.title });
    });
  }
  check('과제 존재', ids.homework.length >= 1, `count=${ids.homework.length}`);
  console.log(`  📋 과제: ${ids.homework.map(h=>`[${h.id}]${h.title}`).join(', ')}`);

  if (ids.homework.length) {
    const hw = ids.homework[0];
    // 상세 (교사)
    const detail = await get(`/api/homework/${hw.classId}/${hw.id}`, s(hw.teacher));
    check('과제 상세', detail.status === 200);
    const hwData = detail.data.data || detail.data.homework || detail.data;
    const existingSubs = hwData.submissions || [];
    console.log(`  📋 기존 제출물: ${existingSubs.length}건`);

    // 학생 제출
    const sub1 = await post(`/api/homework/${hw.classId}/${hw.id}/submit`, {
      content: '분수의 덧셈: 1/2 + 1/3 = 5/6 입니다.'
    }, s('student1'));
    check('student1 과제 제출', sub1.status === 200 || sub1.status === 201 || sub1.status === 409,
      `status=${sub1.status} ${JSON.stringify(sub1.data).substring(0,100)}`);

    const sub2 = await post(`/api/homework/${hw.classId}/${hw.id}/submit`, {
      content: '분수 문제를 풀었습니다. 결과를 제출합니다.'
    }, s('student2'));
    check('student2 과제 제출', sub2.status === 200 || sub2.status === 201 || sub2.status === 409,
      `status=${sub2.status}`);

    // 교사가 제출물 확인
    const afterDetail = await get(`/api/homework/${hw.classId}/${hw.id}`, s(hw.teacher));
    const subs = afterDetail.data.submissions || [];
    check('교사 제출물 확인', subs.length >= 1, `제출물=${subs.length}, keys=${Object.keys(afterDetail.data).join(',')}`);

    // 채점
    if (subs.length > 0) {
      const subId = subs[0].id;
      const grade = await post(`/api/homework/${hw.classId}/${hw.id}/grade/${subId}`, {
        score: 95, feedback: '잘 풀었습니다! 분수의 통분 과정이 정확합니다.'
      }, s(hw.teacher));
      check('교사 채점', grade.status === 200, `status=${grade.status} ${JSON.stringify(grade.data).substring(0,100)}`);
    }

    // 학생 결과 확인
    const myHw = await get(`/api/homework/${hw.classId}/${hw.id}`, s('student1'));
    check('학생 채점 결과 확인', myHw.status === 200);
  }
}

// ═══ Phase 6: 평가/CBT ═══
async function phase6() {
  console.log('\n═══ Phase 6: 평가/CBT ═══');
  for (const cls of ids.classes) {
    const r = await get(`/api/exam/${cls.id}`, s(cls.teacher));
    check(`[${cls.name}] 평가 목록`, r.status === 200);
    (r.data.exams || []).forEach(e => {
      if (!ids.exams.find(x => x.id === e.id))
        ids.exams.push({ id: e.id, classId: cls.id, teacher: cls.teacher, title: e.title });
    });
  }
  check('평가 존재', ids.exams.length >= 1, `count=${ids.exams.length}`);
  console.log(`  📋 평가: ${ids.exams.map(e=>`[${e.id}]${e.title}`).join(', ')}`);

  if (ids.exams.length) {
    const exam = ids.exams[0];
    // 상세 (교사 - 문항 포함)
    const detail = await get(`/api/exam/${exam.classId}/${exam.id}`, s(exam.teacher));
    check('평가 상세 (교사)', detail.status === 200);
    const examData = detail.data.data || detail.data.exam || detail.data;
    const questions = examData.questions || [];
    check('문항 존재', questions.length >= 1, `문항=${questions.length}, keys=${Object.keys(examData).join(',')}`);
    console.log(`  📋 문항: ${questions.length}개`);

    // 문항 정보 출력
    if (questions.length > 0) {
      questions.forEach((q, i) => {
        console.log(`    Q${i+1}: [${q.type}] ${(q.text||q.question||'').substring(0,40)} → 정답: ${q.answer||q.correct_answer||'?'}`);
      });
    }

    // student5 시험 시작 (student3,4는 시드에서 이미 참여)
    const start = await post(`/api/exam/${exam.classId}/${exam.id}/start`, {}, s('student5'));
    check('student5 시험 시작', start.status === 200 || start.status === 201 || start.status === 409, `status=${start.status}`);

    // student5 답안 제출
    const answers = questions.map((q, i) => ({
      questionId: q.id || (i + 1),
      answer: q.answer || q.correct_answer || '1'
    }));
    const submit = await post(`/api/exam/${exam.classId}/${exam.id}/submit`, { answers }, s('student5'));
    check('student5 답안 제출', submit.status === 200 || submit.status === 201, `status=${submit.status} ${JSON.stringify(submit.data).substring(0,150)}`);

    // student4 응시 (시드에서 이미 했을 수 있음)
    await post(`/api/exam/${exam.classId}/${exam.id}/start`, {}, s('student4'));
    const wrongAnswers = questions.map((q, i) => ({
      questionId: q.id || (i + 1),
      answer: i === 0 ? '99' : (q.answer || q.correct_answer || '1') // 1문항 오답
    }));
    const sub4 = await post(`/api/exam/${exam.classId}/${exam.id}/submit`, { answers: wrongAnswers }, s('student4'));
    check('student4 답안 제출 (1오답)', sub4.status === 200 || sub4.status === 201, `status=${sub4.status}`);

    // 교사 결과
    const result = await get(`/api/exam/${exam.classId}/${exam.id}`, s(exam.teacher));
    check('교사 결과 확인', result.status === 200);

    // 학생 자기결과
    check('student5 결과', (await get(`/api/exam/${exam.classId}/${exam.id}`, s('student5'))).status === 200);

    // 자동저장
    const as = await post(`/api/exam/${exam.classId}/${exam.id}/autosave`, { answers: [{questionId:1,answer:'1'}] }, s('student5'));
    check('자동저장', as.status === 200 || as.status === 201, `status=${as.status}`);
  }
}

// ═══ Phase 7: 알림장 ═══
async function phase7() {
  console.log('\n═══ Phase 7: 알림장 ═══');
  for (const cls of ids.classes) {
    const r = await get(`/api/notice/${cls.id}`, s(cls.teacher));
    check(`[${cls.name}] 알림장 목록`, r.status === 200);
    (r.data.notices || r.data.data || []).forEach(n => {
      if (!ids.notices.find(x => x.id === n.id))
        ids.notices.push({ id: n.id, classId: cls.id, title: n.title });
    });
  }
  check('알림장 존재', ids.notices.length >= 1, `count=${ids.notices.length}`);
  console.log(`  📋 알림장: ${ids.notices.map(n=>`[${n.id}]${n.title}`).join(', ')}`);

  if (ids.notices.length) {
    // 학생 읽기
    const n = ids.notices[0];
    const read = await get(`/api/notice/${n.classId}/${n.id}`, s('student1'));
    check('학생 알림장 읽기', read.status === 200);
    const read2 = await get(`/api/notice/${n.classId}/${n.id}`, s('student2'));
    check('student2 읽기', read2.status === 200);
  }
}

// ═══ Phase 8: 게시판 ═══
async function phase8() {
  console.log('\n═══ Phase 8: 게시판 ═══');
  const cls = ids.classes[0];
  if (!cls) return;

  // 기존 게시글
  const list = await get(`/api/board/${cls.id}`, s(cls.teacher));
  check('게시판 목록', list.status === 200);
  (list.data.posts || list.data.data || []).forEach(p => {
    if (!ids.posts.find(x => x.id === p.id)) ids.posts.push({ id: p.id, classId: cls.id });
  });
  console.log(`  📋 기존 게시글: ${ids.posts.length}개`);

  // 학생 게시글
  const np = await post(`/api/board/${cls.id}`, {
    title: '수학 문제 질문!', content: '분수의 나눗셈이 왜 뒤집어서 곱하나요?',
    category: 'qna', allow_comments: true
  }, s('student1'));
  check('학생 게시글', np.status === 200 || np.status === 201, `status=${np.status}`);
  const postId = np.data.data?.id || np.data.post?.id || np.data.id;
  if (postId) {
    ids.posts.push({ id: postId, classId: cls.id });
    // 교사 댓글
    const cm1 = await post(`/api/board/${cls.id}/${postId}/comments`, {
      content: '역수를 곱하는 이유는 나눗셈의 정의 때문입니다.'
    }, s(cls.teacher));
    check('교사 댓글', cm1.status === 200 || cm1.status === 201, `status=${cm1.status}`);
    // 학생 댓글
    const cm2 = await post(`/api/board/${cls.id}/${postId}/comments`, {
      content: '이해했어요! 감사합니다!'
    }, s('student1'));
    check('학생 댓글', cm2.status === 200 || cm2.status === 201, `status=${cm2.status}`);
    // 상세
    const det = await get(`/api/board/${cls.id}/${postId}`, s('student2'));
    check('게시글 상세', det.status === 200);
    const comments = det.data.data?.comments || det.data.post?.comments || det.data.comments || [];
    check('댓글 >= 1', comments.length >= 1, `count=${comments.length}`);
  }

  // 익명 게시글
  const anon = await post(`/api/board/${cls.id}`, {
    title: '익명 고민', content: '수학이 어려워요...', category: 'free', is_anonymous: true
  }, s('student3'));
  check('익명 게시글', anon.status === 200 || anon.status === 201, `status=${anon.status}`);

  // 카테고리 필터
  check('QnA 필터', (await get(`/api/board/${cls.id}?category=qna`, s('student1'))).status === 200);
}

// ═══ Phase 9: 설문 ═══
async function phase9() {
  console.log('\n═══ Phase 9: 설문 ═══');
  const cls = ids.classes[0];
  if (!cls) return;

  const list = await get(`/api/survey/${cls.id}`, s(cls.teacher));
  check('설문 목록', list.status === 200);
  (list.data.surveys || list.data.data || []).forEach(sv => {
    if (!ids.surveys.find(x => x.id === sv.id)) ids.surveys.push({ id: sv.id, classId: cls.id });
  });
  check('설문 존재', ids.surveys.length >= 1, `count=${ids.surveys.length}`);

  if (ids.surveys.length) {
    const sv = ids.surveys[0];
    // 상세 (문항 확인)
    const det = await get(`/api/survey/${sv.classId}/${sv.id}`, s(cls.teacher));
    check('설문 상세', det.status === 200);
    const svData = det.data.data || det.data.survey || det.data;
    let qs = svData.questions || [];
    // questions가 JSON 문자열일 수 있음
    if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch { qs = []; } }
    console.log(`  📋 설문 문항: ${qs.length}개`);

    // 학생 응답 (seed에서 이미 했을 수 있으므로 409 허용)
    const resp = await post(`/api/survey/${sv.classId}/${sv.id}/submit`, {
      answers: qs.map((q, i) => ({ questionId: q.id || (i+1), answer: i === 0 ? '매우 만족' : i === 1 ? '보통' : '재미있었어요' }))
    }, s('student4'));
    check('student4 설문 응답', resp.status === 200 || resp.status === 201 || resp.status === 409,
      `status=${resp.status} ${JSON.stringify(resp.data).substring(0,80)}`);
  }
}

// ═══ Phase 10: 감정출석부 ═══
async function phase10() {
  console.log('\n═══ Phase 10: 감정출석부 ═══');
  const cls = ids.classes[0];
  if (!cls) return;

  // 출석 (이미 했으면 409)
  const emotions = ['happy','excited','calm','sad','tired'];
  for (let i = 0; i < 5; i++) {
    const ci = await post(`/api/attendance/${cls.id}/checkin`, {
      emotion: emotions[i], emotionReason: `${emotions[i]} 느낌`, comment: '출석!'
    }, s(`student${i+1}`));
    check(`student${i+1} 출석(${emotions[i]})`, ci.status === 200 || ci.status === 201 || ci.status === 409,
      `status=${ci.status}`);
  }

  // 상태 확인
  const st = await get(`/api/attendance/${cls.id}/status`, s('student1'));
  check('출석 상태', st.status === 200, `${JSON.stringify(st.data).substring(0,100)}`);
  // 오늘 현황
  check('오늘 현황', (await get(`/api/attendance/${cls.id}/today`, s(cls.teacher))).status === 200);
  // 교사 통계
  const cs = await get(`/api/attendance/${cls.id}/class-stats`, s(cls.teacher));
  check('교사 통계', cs.status === 200, `${JSON.stringify(cs.data).substring(0,100)}`);
  // 테이블
  check('출석 테이블', (await get(`/api/attendance/${cls.id}/table?startDate=2026-03-01&endDate=2026-03-31`, s(cls.teacher))).status === 200);
  // 감정 통계
  const es = await get(`/api/attendance/${cls.id}/emotion-stats`, s(cls.teacher));
  check('감정 통계', es.status === 200, `${JSON.stringify(es.data).substring(0,100)}`);
  // 랭킹
  check('출석 랭킹', (await get(`/api/attendance/${cls.id}/ranking`, s('student1'))).status === 200);
  // 감정 회고
  const ref = await post(`/api/attendance/${cls.id}/emotion-reflection`, {
    reflectionType: 'weekly', periodStart: '2026-03-17', periodEnd: '2026-03-23',
    question: '이번 주를 돌아보며', answer: '이번주는 수학이 재미있었어요'
  }, s('student1'));
  check('감정 회고', ref.status === 200 || ref.status === 201, `status=${ref.status}`);
  // 교사 피드백
  if (ids.userIds.student1) {
    const fb = await post(`/api/attendance/${cls.id}/emotion-feedback`, {
      studentId: ids.userIds.student1, text: '잘하고 있어요!'
    }, s(cls.teacher));
    check('교사 피드백', fb.status === 200 || fb.status === 201, `status=${fb.status}`);
  }
}

// ═══ Phase 11: 오늘의 학습 ═══
async function phase11() {
  console.log('\n═══ Phase 11: 오늘의 학습 ═══');
  const list = await get('/api/self-learn/daily', s('admin'));
  check('학습 세트 목록', list.status === 200);
  const sets = list.data.data || list.data.sets || [];
  console.log(`  📋 학습 세트: ${sets.length}개`);

  if (sets.length > 0) {
    const set = sets[0];
    ids.dailySets.push({ id: set.id });
    const det = await get(`/api/self-learn/daily/${set.id}`, s('student1'));
    check('세트 상세', det.status === 200);
    const items = det.data.data?.items || det.data.items || det.data.set?.items || [];
    console.log(`  📋 아이템: ${items.length}개`);
    if (items.length) {
      const item = items[0];
      const st = await post(`/api/self-learn/daily/${item.id}/start`, {}, s('student1'));
      check('아이템 시작', st.status === 200 || st.status === 201, `status=${st.status}`);
      const co = await post(`/api/self-learn/daily/${item.id}/complete`, { score: 90, timeSpent: 300 }, s('student1'));
      check('아이템 완료', co.status === 200 || co.status === 201, `status=${co.status}`);
    }
    check('학습 통계', (await get('/api/self-learn/daily/stats', s('student1'))).status === 200);
  } else {
    // 세트 생성
    const ns = await post('/api/self-learn/daily/sets', {
      title: '오늘의 학습 세트', description: '분수 복습', target_date: '2026-03-23',
      target_grade: 4, target_subject: '수학', is_active: true
    }, s('admin'));
    check('세트 생성', ns.status === 200 || ns.status === 201, `status=${ns.status}`);
  }
}

// ═══ Phase 12: 문제집 ═══
async function phase12() {
  console.log('\n═══ Phase 12: 나만의 문제집 ═══');
  const cr = await post('/api/self-learn/problem-sets', { title: '분수 문제집', subject: '수학' }, s('student1'));
  check('문제집 생성', cr.status === 200 || cr.status === 201, `status=${cr.status}`);
  const psId = cr.data.data?.id || cr.data.set?.id || cr.data.id;
  if (psId) {
    ids.problemSets.push({ id: psId });
    // 문항 담기
    const quizContents = ids.contents.filter(c => c.type === 'quiz');
    if (quizContents.length) {
      const ai = await post(`/api/self-learn/problem-sets/${psId}/items`, { contentId: quizContents[0].id }, s('student1'));
      check('문항 담기', ai.status === 200 || ai.status === 201, `status=${ai.status}`);
    }
    check('문제집 상세', (await get(`/api/self-learn/problem-sets/${psId}`, s('student1'))).status === 200);
    const sp = await post(`/api/self-learn/problem-sets/${psId}/start`, {}, s('student1'));
    check('문제집 풀기', sp.status === 200 || sp.status === 201, `status=${sp.status}`);
    const sb = await post(`/api/self-learn/problem-sets/${psId}/submit`, { answers: [{itemId:1,answer:'3'}] }, s('student1'));
    check('답안 제출', sb.status === 200 || sb.status === 201, `status=${sb.status}`);
  }
}

// ═══ Phase 13: 갤러리 + 나도예술가 ═══
async function phase13() {
  console.log('\n═══ Phase 13: 갤러리 + 나도예술가 ═══');
  const cls = ids.classes[0];
  if (!cls) return;

  // 갤러리 게시글
  const gp = await post(`/api/board/${cls.id}`, {
    title: '나의 분수 마인드맵', content: '분수를 정리해봤어요!',
    category: 'gallery', image_url: '/uploads/mindmap.png', shareToGallery: true
  }, s('student1'));
  check('갤러리 게시글', gp.status === 200 || gp.status === 201, `status=${gp.status}`);
  const gpId = gp.data.data?.id || gp.data.post?.id || gp.data.id;

  if (gpId) {
    ids.galleries.push({ id: gpId, classId: cls.id });
    // 승인 대기 목록
    const pending = await get(`/api/board/${cls.id}/pending/list`, s(cls.teacher));
    check('승인 대기 목록', pending.status === 200, `status=${pending.status}`);
    // 승인
    const approve = await post(`/api/board/${cls.id}/${gpId}/approve`, {}, s(cls.teacher));
    check('갤러리 승인', approve.status === 200, `status=${approve.status} ${JSON.stringify(approve.data).substring(0,100)}`);
    // 나도예술가
    const gallery = await get('/api/growth/gallery', s('student1'));
    check('나도예술가 조회', gallery.status === 200, `status=${gallery.status}`);
  }

  // 반려 테스트
  const rp = await post(`/api/board/${cls.id}`, {
    title: '반려 테스트', content: '테스트', category: 'gallery', shareToGallery: true
  }, s('student3'));
  const rpId = rp.data.data?.id || rp.data.post?.id || rp.data.id;
  if (rpId) {
    const rej = await post(`/api/board/${cls.id}/${rpId}/reject`, { reason: '내용 보완 필요' }, s(cls.teacher));
    check('갤러리 반려', rej.status === 200, `status=${rej.status}`);
  }
}

// ═══ Phase 14: 소통쪽지 ═══
async function phase14() {
  console.log('\n═══ Phase 14: 소통쪽지 ═══');

  // 기존 쪽지방 사용 (student1 & teacher1 = room 1)
  const rooms = await get('/api/message/rooms', s('student1'));
  check('쪽지방 목록', rooms.status === 200);
  const roomList = rooms.data.rooms || rooms.data.data || [];
  console.log(`  📋 student1 쪽지방: ${roomList.length}개`);

  if (roomList.length) {
    const roomId = roomList[0].id;
    // 교사 메시지
    const m1 = await post(`/api/message/rooms/${roomId}/messages`, { content: '하늘이, 수고했어요!' }, s('teacher1'));
    check('교사 메시지', m1.status === 200 || m1.status === 201, `status=${m1.status}`);
    // 학생 답장
    const m2 = await post(`/api/message/rooms/${roomId}/messages`, { content: '감사합니다 선생님!' }, s('student1'));
    check('학생 답장', m2.status === 200 || m2.status === 201, `status=${m2.status}`);
    // 메시지 목록
    const msgs = await get(`/api/message/rooms/${roomId}/messages`, s('teacher1'));
    check('메시지 목록', msgs.status === 200);
    const msgList = msgs.data.messages || msgs.data.data || [];
    check('메시지 >= 2', msgList.length >= 2, `count=${msgList.length}`);
  } else {
    // 쪽지방 생성 (targetUserId 사용)
    const room = await post('/api/message/rooms', { targetUserId: ids.userIds.student1 }, s('teacher1'));
    check('쪽지방 생성', room.status === 200 || room.status === 201, `status=${room.status}`);
  }
  // 안 읽은 수
  check('안읽은 수', (await get('/api/message/unread-count', s('student1'))).status === 200);
}

// ═══ Phase 15: 성장기록 ═══
async function phase15() {
  console.log('\n═══ Phase 15: 성장기록/포트폴리오 ═══');
  const cls = ids.classes[0];
  // 포트폴리오
  const pf = await post('/api/growth/portfolios', {
    classId: cls?.id, type: 'journal', title: '분수 학습 일지',
    content: '분수의 덧셈을 배웠다. 통분이 이해됐다.', tags: '수학,분수'
  }, s('student1'));
  check('포트폴리오 등록', pf.status === 200 || pf.status === 201, `status=${pf.status}`);
  check('포트폴리오 목록', (await get(`/api/growth/portfolios?classId=${cls?.id || ''}`, s('student1'))).status === 200);

  // 독서기록
  const rd = await post('/api/growth/reading', {
    bookTitle: '수학대탐험', author: '김수학', rating: 5, review: '재미있는 수학 역사!'
  }, s('student1'));
  check('독서기록', rd.status === 200 || rd.status === 201, `status=${rd.status}`);
  check('독서 목록', (await get('/api/growth/reading', s('student1'))).status === 200);

  // 성장 요약
  check('성장 요약', (await get('/api/growth/summary', s('student1'))).status === 200);

  // 교사 관찰기록
  if (ids.userIds.student1 && cls) {
    const obs = await post('/api/growth/report/observation', {
      studentId: ids.userIds.student1, classId: cls.id,
      text: '꾸준한 성장을 보이고 있음', tags: ['학업', '수학']
    }, s(cls.teacher));
    check('관찰기록', obs.status === 200 || obs.status === 201, `status=${obs.status} ${JSON.stringify(obs.data).substring(0,100)}`);
    check('관찰기록 조회', (await get(`/api/growth/report/observations/${ids.userIds.student1}`, s(cls.teacher))).status === 200);
  }

  // 성장 리포트
  if (cls) check('클래스 리포트', (await get(`/api/growth/report/class/${cls.id}`, s(cls.teacher))).status === 200);
}

// ═══ Phase 16: LRS ═══
async function phase16() {
  console.log('\n═══ Phase 16: LRS 대시보드 ═══');
  const rb = await post('/api/lrs/rebuild-aggregates', {}, s('admin'));
  check('LRS 리빌드', rb.status === 200, `status=${rb.status} ${JSON.stringify(rb.data).substring(0,100)}`);
  check('일별 추이', (await get('/api/lrs/stats/daily?days=30', s('admin'))).status === 200);
  check('서비스별', (await get('/api/lrs/stats/by-service', s('admin'))).status === 200);
  check('교과별', (await get('/api/lrs/stats/by-subject', s('admin'))).status === 200);
  check('클래스별', (await get('/api/lrs/stats/by-class', s('admin'))).status === 200);
  check('사용자요약', (await get('/api/lrs/stats/user-summary', s('student1'))).status === 200);
  const logs = await get('/api/lrs/logs', s('student1'));
  check('로그 조회 (student1)', logs.status === 200);
  const logList = logs.data.data || logs.data.logs || [];
  check('학생 로그 존재', logList.length >= 1, `count=${logList.length}`);
}

// ═══ Phase 17: 포털/관리자 ═══
async function phase17() {
  console.log('\n═══ Phase 17: 포털/관리자 ═══');
  check('포털 요약', (await get('/api/portal/my-summary', s('student1'))).status === 200);
  check('최근 활동', (await get('/api/portal/recent-activities', s('student1'))).status === 200);
  check('캘린더', (await get('/api/portal/calendar', s('student1'))).status === 200);
  const st = await get('/api/admin/stats', s('admin'));
  check('관리자 통계', st.status === 200 && st.data.success);
  if (st.data.stats) {
    check('사용자 10+', st.data.stats.totalUsers >= 10, `total=${st.data.stats.totalUsers}`);
    check('클래스 3+', st.data.stats.classCount >= 3, `count=${st.data.stats.classCount}`);
    check('콘텐츠 10+', st.data.stats.contentCount >= 10, `count=${st.data.stats.contentCount}`);
    check('로그 존재', st.data.stats.logCount >= 1, `count=${st.data.stats.logCount}`);
  }
  check('교과 목록', (await get('/api/curriculum/subjects?school_level='+encodeURIComponent('초'), s('admin'))).status === 200);
  check('학년군', (await get('/api/curriculum/grade-groups?subject_code=math-e', s('admin'))).status === 200);
  check('영역', (await get('/api/curriculum/areas?subject_code=math-e&grade_group=4', s('admin'))).status === 200);
  check('성취기준 검색', (await get('/api/curriculum/standards?search='+encodeURIComponent('분수'), s('admin'))).status === 200);
}

// ═══ MAIN ═══
async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  다채움 2.0 종합 테스트 v2 실행       ║');
  console.log('╚════════════════════════════════════════╝');
  try {
    await phase0();
    await phase1();
    await phase2();
    await phase3();
    await phase4();
    await phase5();
    await phase6();
    await phase7();
    await phase8();
    await phase9();
    await phase10();
    await phase11();
    await phase12();
    await phase13();
    await phase14();
    await phase15();
    await phase16();
    await phase17();
  } catch (err) {
    console.error('\n💥 치명적 오류:', err.message, err.stack);
  }
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  테스트 결과 요약                      ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`  총 ${total}건 | ✅ ${pass}건 | ❌ ${fail}건`);
  console.log(`  성공률: ${((pass/total)*100).toFixed(1)}%`);
  if (failures.length) {
    console.log('\n─── 실패 목록 ───');
    failures.forEach((f, i) => console.log(`  ${i+1}. ${f.name}${f.detail ? '\n     → ' + f.detail : ''}`));
  }
  console.log('\n테스트 완료.');
}
main();
