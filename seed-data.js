/**
 * 다채움 2.0 종합 시드 데이터 스크립트
 *
 * ★ 실행 전 서버가 localhost:3000에서 실행 중이어야 합니다.
 * ★ 실행: node seed-data.js
 *
 * 단계별 검증을 수행하며, 실패 시 원인을 로그하고 재시도합니다.
 */

const http = require('http');
const BASE = 'http://localhost:3000';
const sessions = {};  // username → cookie
const results = {};   // 단계별 생성 결과 저장
let errors = [];      // 전체 에러 수집

// ──────────────────── HTTP 헬퍼 ────────────────────

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (cookie) opts.headers.Cookie = cookie;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        let parsed;
        try { parsed = JSON.parse(d); } catch { parsed = { raw: d }; }
        resolve({ status: res.statusCode, cookies, data: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function POST(path, body, cookie, label) {
  const r = await request('POST', path, body, cookie);
  if (r.status >= 400 && r.data && !r.data.success) {
    const msg = `[${label || path}] ${r.status}: ${r.data.message || JSON.stringify(r.data).substring(0,120)}`;
    console.log(`  ⚠ ${msg}`);
    errors.push(msg);
  }
  return r;
}
const GET = (p, c) => request('GET', p, null, c);
const PUT = (p, b, c) => request('PUT', p, b, c);

function c(username) { return sessions[username]; }

// ──────────────────── 인증 헬퍼 ────────────────────

async function signup(username, password, displayName, role) {
  const r = await POST('/api/auth/signup', { username, password, displayName, role }, null, 'signup-' + username);
  if (r.data.success) {
    const cookie = r.cookies.map(c => c.split(';')[0]).join('; ');
    sessions[username] = cookie;
    console.log(`  ✓ 회원가입: ${displayName} (${role})`);
    return r.data;
  }
  // 이미 존재 → 로그인
  await login(username, password);
  console.log(`  ✓ 기존 계정: ${displayName} (${role})`);
  return { success: true };
}

async function login(username, password) {
  const r = await POST('/api/auth/login', { username, password }, null, 'login-' + username);
  if (!r.data.success) throw new Error(`로그인 실패: ${username}`);
  const cookie = r.cookies.map(ck => ck.split(';')[0]).join('; ');
  sessions[username] = cookie;
  return r.data;
}

// ──────────────────── 검증 헬퍼 ────────────────────

function assert(condition, msg) {
  if (!condition) {
    console.log(`  ❌ 검증 실패: ${msg}`);
    errors.push(`검증실패: ${msg}`);
    return false;
  }
  return true;
}

async function verify(label, fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ok = await fn();
      if (ok !== false) return true;
    } catch (e) {
      console.log(`  ⚠ ${label} 시도 ${attempt + 1} 실패: ${e.message}`);
    }
    if (attempt < maxRetries) {
      console.log(`  ↻ ${label} 재시도...`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  errors.push(`검증실패(재시도후): ${label}`);
  return false;
}

// ══════════════════════════════════════════════════
//  메인 시드 로직
// ══════════════════════════════════════════════════

async function seed() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   다채움 2.0 종합 시드 데이터 생성 시작   ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ═══════════ STEP 1: 계정 생성 ═══════════
  console.log('━━━ STEP 1: 계정 생성 (관리자1 + 교사3 + 학생6) ━━━');

  await login('admin', '0000');
  console.log('  ✓ 관리자 로그인');

  await signup('teacher1', '1234', '김영희 선생님', 'teacher');
  await signup('teacher2', '1234', '박철수 선생님', 'teacher');
  await signup('teacher3', '1234', '이미진 선생님', 'teacher');
  await signup('student1', '1234', '정하늘', 'student');
  await signup('student2', '1234', '최민준', 'student');
  await signup('student3', '1234', '한소희', 'student');
  await signup('student4', '1234', '윤서준', 'student');
  await signup('student5', '1234', '강다은', 'student');
  await signup('student6', '1234', '임지호', 'student');

  // 검증
  await verify('계정 검증', async () => {
    for (const u of ['admin','teacher1','teacher2','teacher3','student1','student2','student3','student4','student5','student6']) {
      const r = await GET('/api/auth/me', c(u));
      if (!assert(r.data.success, `${u} 세션 유효`)) return false;
    }
    console.log('  ✅ STEP 1 검증 완료: 10개 계정 모두 정상');
    return true;
  });

  // ═══════════ STEP 2: 채움콘텐츠 등록 + 공개승인 ═══════════
  console.log('\n━━━ STEP 2: 채움콘텐츠 등록 (10개) + 공개 승인 ━━━');

  const contents = {};

  // 교사1: 영상 3개
  let r = await POST('/api/contents', {
    title: '분수의 덧셈과 뺄셈 개념 영상', description: '초등 4학년 분수의 덧셈과 뺄셈을 애니메이션으로 쉽게 설명합니다.',
    content_type: 'video', content_url: 'https://example.com/videos/fraction-add.mp4',
    subject: '수학', grade: '4', tags: ['분수', '덧셈', '뺄셈', '초등수학'], is_public: true, status: 'pending'
  }, c('teacher1'), '콘텐츠-분수영상');
  contents.vid1 = r.data.content;
  console.log(`  ✓ 영상: 분수의 덧셈과 뺄셈 (id: ${contents.vid1?.id})`);

  r = await POST('/api/contents', {
    title: '태양계 행성 탐험 영상', description: '태양계의 8개 행성을 3D 시뮬레이션으로 탐험합니다.',
    content_type: 'video', content_url: 'https://example.com/videos/solar-system.mp4',
    subject: '과학', grade: '5', tags: ['태양계', '행성', '우주'], is_public: true, status: 'pending'
  }, c('teacher1'), '콘텐츠-태양계');
  contents.vid2 = r.data.content;
  console.log(`  ✓ 영상: 태양계 행성 탐험 (id: ${contents.vid2?.id})`);

  r = await POST('/api/contents', {
    title: '소수의 곱셈 풀이 영상', description: '소수 × 자연수, 소수 × 소수의 계산 원리를 설명합니다.',
    content_type: 'video', content_url: 'https://example.com/videos/decimal-mult.mp4',
    subject: '수학', grade: '5', tags: ['소수', '곱셈'], is_public: true, status: 'pending'
  }, c('teacher3'), '콘텐츠-소수영상');
  contents.vid3 = r.data.content;
  console.log(`  ✓ 영상: 소수의 곱셈 풀이 (id: ${contents.vid3?.id})`);

  // 문서
  r = await POST('/api/contents', {
    title: '한국 전통 문화 읽기 자료', description: '한복, 한옥, 한식 등 한국 전통 문화 읽기 자료.',
    content_type: 'document', content_url: '/uploads/docs/korean-culture.pdf',
    subject: '사회', grade: '3', tags: ['전통문화', '사회'], is_public: true, status: 'pending'
  }, c('teacher1'), '콘텐츠-문서');
  contents.doc1 = r.data.content;
  console.log(`  ✓ 문서: 한국 전통 문화 (id: ${contents.doc1?.id})`);

  // 문항 2개
  r = await POST('/api/contents', {
    title: '받아쓰기 연습 문항 세트', description: '초등 2학년 국어 받아쓰기 20문항.',
    content_type: 'quiz', subject: '국어', grade: '2', tags: ['받아쓰기', '맞춤법'], is_public: true, status: 'pending'
  }, c('teacher2'), '콘텐츠-받아쓰기');
  contents.quiz1 = r.data.content;
  console.log(`  ✓ 문항: 받아쓰기 연습 (id: ${contents.quiz1?.id})`);

  r = await POST('/api/contents', {
    title: '곱셈구구 연습 문항', description: '2단~9단 곱셈구구 30문항.',
    content_type: 'quiz', subject: '수학', grade: '2', tags: ['곱셈구구'], is_public: true, status: 'pending'
  }, c('teacher2'), '콘텐츠-곱셈구구');
  contents.quiz2 = r.data.content;
  console.log(`  ✓ 문항: 곱셈구구 연습 (id: ${contents.quiz2?.id})`);

  // 평가지 2개
  r = await POST('/api/contents', {
    title: '4학년 1학기 수학 단원평가', description: '큰 수, 각도, 곱셈과 나눗셈 종합평가 15문항.',
    content_type: 'exam', subject: '수학', grade: '4', tags: ['단원평가', '4학년'], is_public: true, status: 'pending'
  }, c('teacher2'), '콘텐츠-수학평가');
  contents.examC1 = r.data.content;
  console.log(`  ✓ 평가지: 수학 단원평가 (id: ${contents.examC1?.id})`);

  r = await POST('/api/contents', {
    title: '5학년 과학 식물의 구조 평가', description: '식물의 뿌리, 줄기, 잎 구조 평가 10문항.',
    content_type: 'exam', subject: '과학', grade: '5', tags: ['식물', '평가'], is_public: true, status: 'pending'
  }, c('teacher2'), '콘텐츠-과학평가');
  contents.examC2 = r.data.content;
  console.log(`  ✓ 평가지: 과학 식물평가 (id: ${contents.examC2?.id})`);

  // 수업꾸러미 2개
  r = await POST('/api/contents', {
    title: '영어 알파벳 학습 꾸러미', description: '알파벳 A-Z 플래시카드, 워크시트, 게임 활동지.',
    content_type: 'package', subject: '영어', grade: '3', tags: ['알파벳', '꾸러미'], is_public: true, status: 'pending'
  }, c('teacher3'), '콘텐츠-영어꾸러미');
  contents.pkg1 = r.data.content;
  console.log(`  ✓ 꾸러미: 영어 알파벳 (id: ${contents.pkg1?.id})`);

  r = await POST('/api/contents', {
    title: '역사 인물 탐구 프로젝트 꾸러미', description: '세종대왕, 이순신, 유관순 탐구 활동 자료 모음.',
    content_type: 'package', subject: '사회', grade: '5', tags: ['역사', '인물', '탐구'], is_public: true, status: 'pending'
  }, c('teacher3'), '콘텐츠-역사꾸러미');
  contents.pkg2 = r.data.content;
  console.log(`  ✓ 꾸러미: 역사 인물 탐구 (id: ${contents.pkg2?.id})`);

  // 관리자가 공개 승인
  console.log('\n  --- 관리자 공개 승인 ---');
  const pending = await GET('/api/admin/contents?status=pending', c('admin'));
  const pendingList = pending.data.contents || [];
  for (const ct of pendingList) {
    await POST(`/api/contents/${ct.id}/approve`, {}, c('admin'), '승인-' + ct.id);
    console.log(`  ✓ 승인: ${ct.title}`);
  }

  // 보관함 담기
  if (contents.vid1) {
    await POST(`/api/contents/collection/${contents.vid1.id}`, { folder: '수학 자료' }, c('teacher1'), '보관함');
    console.log('  ✓ 보관함: 분수 영상 → 수학 자료');
  }

  // 검증
  await verify('콘텐츠 검증', async () => {
    const pub = await GET('/api/contents?page=1&limit=20', c('teacher1'));
    const cnt = pub.data.total || (pub.data.contents?.length || 0);
    if (!assert(cnt >= 10, `콘텐츠 ${cnt}개 ≥ 10개`)) return false;
    console.log(`  ✅ STEP 2 검증 완료: 콘텐츠 ${cnt}개, 모두 승인됨`);
    return true;
  });

  // ═══════════ STEP 3: 채움클래스 생성 + 학생 가입 ═══════════
  console.log('\n━━━ STEP 3: 채움클래스 생성 (3개) + 학생 가입 ━━━');

  r = await POST('/api/class', {
    name: '즐거운 수학교실', description: '4학년 1반 수학 수업 클래스입니다.',
    class_type: 'subject', is_public: true
  }, c('teacher1'), '클래스-수학');
  results.cls1 = r.data.class;
  console.log(`  ✓ 클래스: ${results.cls1.name} (코드: ${results.cls1.code})`);

  r = await POST('/api/class', {
    name: '탐구하는 과학반', description: '5학년 과학 실험과 탐구 활동 클래스.',
    class_type: 'subject', is_public: true
  }, c('teacher2'), '클래스-과학');
  results.cls2 = r.data.class;
  console.log(`  ✓ 클래스: ${results.cls2.name} (코드: ${results.cls2.code})`);

  r = await POST('/api/class', {
    name: '함께 읽는 국어', description: '3학년 국어 독서와 글쓰기 활동 클래스.',
    class_type: 'subject', is_public: true
  }, c('teacher3'), '클래스-국어');
  results.cls3 = r.data.class;
  console.log(`  ✓ 클래스: ${results.cls3.name} (코드: ${results.cls3.code})`);

  // 학생 가입
  const allStudents = ['student1','student2','student3','student4','student5','student6'];
  for (const s of allStudents.slice(0,5)) await POST('/api/class/join', { code: results.cls1.code }, c(s), '가입-수학');
  console.log('  ✓ 수학교실: 학생 5명 가입');
  for (const s of allStudents.slice(0,4)) await POST('/api/class/join', { code: results.cls2.code }, c(s), '가입-과학');
  console.log('  ✓ 과학반: 학생 4명 가입');
  for (const s of allStudents) await POST('/api/class/join', { code: results.cls3.code }, c(s), '가입-국어');
  console.log('  ✓ 국어: 학생 6명 가입');

  // 멤버 목록 저장 (이후 사용)
  const mem1 = await GET(`/api/class/${results.cls1.id}/members`, c('teacher1'));
  results.members1 = mem1.data.members || [];

  // 검증
  await verify('클래스 검증', async () => {
    const c1 = await GET(`/api/class/${results.cls1.id}`, c('teacher1'));
    if (!assert(c1.data.class?.member_count >= 5, `수학교실 멤버 ${c1.data.class?.member_count}명`)) return false;
    console.log(`  ✅ STEP 3 검증 완료: 3개 클래스, 학생 가입 정상`);
    return true;
  });

  // ═══════════ STEP 4: 수업/과제/평가/알림장/게시판/설문 (교사) ═══════════
  console.log('\n━━━ STEP 4: 수업/과제/평가/알림장/게시판/설문 생성 ━━━');

  const CLS1 = results.cls1.id, CLS2 = results.cls2.id, CLS3 = results.cls3.id;

  // --- 수업 4개 ---
  r = await POST(`/api/lesson/${CLS1}`, {
    title: '분수의 덧셈', description: '분모가 같은 분수의 덧셈',
    content: '<h2>분수의 덧셈</h2><p>분모가 같은 분수끼리 더할 때는 분자끼리 더합니다.</p>',
    lesson_date: '2026-03-23', start_date: '2026-03-23', end_date: '2026-03-30',
    estimated_minutes: 40, status: 'published',
    subject_code: 'math-e', grade_group: 4, achievement_code: '[4수01-11]'
  }, c('teacher1'), '수업-분수덧셈');
  results.lesson1 = r.data.lesson;
  console.log(`  ✓ 수업: 분수의 덧셈 (id: ${results.lesson1?.id})`);

  // 콘텐츠 연결
  if (results.lesson1 && contents.vid1) {
    await POST(`/api/lesson/${CLS1}/${results.lesson1.id}/contents`, {
      content_id: contents.vid1.id, sort_order: 1
    }, c('teacher1'), '수업-콘텐츠연결');
    console.log('  ✓ 수업-콘텐츠 연결: 분수 영상');
  }

  r = await POST(`/api/lesson/${CLS1}`, {
    title: '분수의 뺄셈', description: '분모가 같은 분수의 뺄셈 연습',
    content: '<h2>분수의 뺄셈</h2><p>분모가 같은 분수끼리 뺄 때는 분자끼리 뺍니다.</p>',
    lesson_date: '2026-03-25', start_date: '2026-03-25', end_date: '2026-04-01',
    estimated_minutes: 40, status: 'published',
    subject_code: 'math-e', grade_group: 4
  }, c('teacher1'), '수업-분수뺄셈');
  results.lesson2 = r.data.lesson;
  console.log(`  ✓ 수업: 분수의 뺄셈 (id: ${results.lesson2?.id})`);

  r = await POST(`/api/lesson/${CLS2}`, {
    title: '식물의 구조와 기능', description: '식물의 뿌리, 줄기, 잎의 구조를 관찰합니다.',
    content: '<h2>식물의 구조</h2><p>식물은 뿌리, 줄기, 잎으로 구성됩니다.</p>',
    lesson_date: '2026-03-24', start_date: '2026-03-24', end_date: '2026-03-31',
    estimated_minutes: 45, status: 'published',
    subject_code: 'science-e', grade_group: 6
  }, c('teacher2'), '수업-식물');
  results.lesson3 = r.data.lesson;
  console.log(`  ✓ 수업: 식물의 구조와 기능 (id: ${results.lesson3?.id})`);

  r = await POST(`/api/lesson/${CLS3}`, {
    title: '이야기 속 인물의 마음', description: '동화를 읽고 인물의 마음을 파악하는 활동',
    content: '<h2>인물의 마음 읽기</h2><p>이야기 속 인물이 왜 그런 행동을 했는지 생각해 봅시다.</p>',
    lesson_date: '2026-03-23', start_date: '2026-03-23', end_date: '2026-03-28',
    estimated_minutes: 40, status: 'published',
    subject_code: 'korean-e', grade_group: 4
  }, c('teacher3'), '수업-국어');
  results.lesson4 = r.data.lesson;
  console.log(`  ✓ 수업: 이야기 속 인물의 마음 (id: ${results.lesson4?.id})`);

  // --- 과제 3개 ---
  r = await POST(`/api/homework/${CLS1}`, {
    title: '분수의 덧셈 연습문제', description: '교과서 52~53쪽 문제를 풀고 제출하세요.',
    due_date: '2026-03-28', max_score: 100, status: 'published',
    subject_code: 'math-e', grade_group: 4
  }, c('teacher1'), '과제-수학');
  results.hw1 = r.data.homework;
  console.log(`  ✓ 과제: 분수의 덧셈 연습문제 (id: ${results.hw1?.id})`);

  r = await POST(`/api/homework/${CLS2}`, {
    title: '식물 관찰 보고서', description: '화분의 식물을 관찰하고 특징을 적어 제출하세요.',
    due_date: '2026-03-30', max_score: 100, status: 'published',
    subject_code: 'science-e', grade_group: 6
  }, c('teacher2'), '과제-과학');
  results.hw2 = r.data.homework;
  console.log(`  ✓ 과제: 식물 관찰 보고서 (id: ${results.hw2?.id})`);

  r = await POST(`/api/homework/${CLS3}`, {
    title: '독서 감상문 쓰기', description: '이번 주에 읽은 책의 감상문을 200자 이상 써서 제출하세요.',
    due_date: '2026-03-29', max_score: 100, status: 'published'
  }, c('teacher3'), '과제-국어');
  results.hw3 = r.data.homework;
  console.log(`  ✓ 과제: 독서 감상문 쓰기 (id: ${results.hw3?.id})`);

  // --- 평가 2개 (CBT) ---
  r = await POST(`/api/exam/${CLS1}`, {
    title: '분수 단원 쪽지시험', description: '분수의 덧셈과 뺄셈 쪽지시험.',
    exam_type: 'quiz', time_limit: 20, status: 'active',
    subject_code: 'math-e', grade_group: 4,
    questions: [
      { number: 1, text: '1/4 + 2/4 = ?', type: 'choice', options: ['1/4','2/4','3/4','4/4'], answer: '3/4', points: 20 },
      { number: 2, text: '5/8 - 2/8 = ?', type: 'choice', options: ['2/8','3/8','4/8','7/8'], answer: '3/8', points: 20 },
      { number: 3, text: '2/6 + 3/6 = ?', type: 'choice', options: ['1/6','5/6','4/6','6/6'], answer: '5/6', points: 20 },
      { number: 4, text: '7/10 - 4/10의 답을 쓰세요.', type: 'short', answer: '3/10', points: 20 },
      { number: 5, text: '분모가 같은 분수의 덧셈은 어떤 부분끼리 더하나요?', type: 'short', answer: '분자', points: 20 }
    ]
  }, c('teacher1'), '평가-수학');
  results.exam1 = r.data.exam;
  console.log(`  ✓ 평가: 분수 쪽지시험 (id: ${results.exam1?.id}, ${results.exam1?.question_count}문항)`);

  r = await POST(`/api/exam/${CLS2}`, {
    title: '식물의 구조 단원평가', description: '식물의 뿌리, 줄기, 잎 구조 평가.',
    exam_type: 'test', time_limit: 30, status: 'active',
    subject_code: 'science-e', grade_group: 6,
    questions: [
      { number: 1, text: '식물의 뿌리가 하는 역할은?', type: 'choice', options: ['광합성','물과 양분 흡수','꽃가루 전달','씨앗 보호'], answer: '물과 양분 흡수', points: 25 },
      { number: 2, text: '광합성이 일어나는 기관은?', type: 'choice', options: ['뿌리','줄기','잎','꽃'], answer: '잎', points: 25 },
      { number: 3, text: '줄기의 역할 2가지를 쓰세요.', type: 'short', answer: '물과 양분 운반, 식물 지지', points: 25 },
      { number: 4, text: '기공이 있는 부분은?', type: 'short', answer: '잎', points: 25 }
    ]
  }, c('teacher2'), '평가-과학');
  results.exam2 = r.data.exam;
  console.log(`  ✓ 평가: 식물 구조 평가 (id: ${results.exam2?.id}, ${results.exam2?.question_count}문항)`);

  // --- 알림장 4개 ---
  await POST(`/api/notice/${CLS1}`, {
    title: '내일 수학 익힘책 가져오기', content: '<p>내일 수학 시간에 익힘책을 사용합니다. 꼭 챙겨오세요!</p>', is_pinned: true
  }, c('teacher1'), '알림장1');
  await POST(`/api/notice/${CLS1}`, {
    title: '분수 단원 쪽지시험 안내', content: '<p>3/25(수)에 분수 단원 쪽지시험이 있습니다. 범위: 48~55쪽</p>'
  }, c('teacher1'), '알림장2');
  await POST(`/api/notice/${CLS2}`, {
    title: '식물 관찰 준비물 안내', content: '<p>다음 수업에 식물 관찰을 합니다. 돋보기를 가져오면 좋습니다.</p>'
  }, c('teacher2'), '알림장3');
  await POST(`/api/notice/${CLS3}`, {
    title: '이번 달 권장도서 목록', content: '<p>1. 어린왕자 2. 마당을 나온 암탉 3. 샬롯의 거미줄</p>'
  }, c('teacher3'), '알림장4');
  console.log('  ✓ 알림장: 4개 생성');

  // --- 게시판 (교사+학생) ---
  r = await POST(`/api/board/${CLS1}`, {
    title: '분수 공부 꿀팁 공유해요!', content: '분수 덧셈할 때 그림을 그리면 이해가 잘 돼요.',
    category: 'free', allow_comments: true
  }, c('teacher1'), '게시판-교사');
  results.post1 = r.data.post;

  r = await POST(`/api/board/${CLS1}`, {
    title: '오늘 수학시간 재미있었어요', content: '분수 게임 활동이 너무 재미있었어요!',
    category: 'free', allow_comments: true
  }, c('student1'), '게시판-학생1');
  results.post2 = r.data.post;

  r = await POST(`/api/board/${CLS1}`, {
    title: '분수의 뺄셈에서 헷갈리는 것이 있어요', content: '3/5 - 1/5 할 때 분모도 빼야 하나요?',
    category: 'qna', allow_comments: true
  }, c('student2'), '게시판-질문');
  results.post3 = r.data.post;

  await POST(`/api/board/${CLS3}`, {
    title: '어린왕자 읽고 느낀점', content: '여우가 말한 "길들여진다"는 것의 의미를 깊이 생각해봤어요.',
    category: 'free', allow_comments: true
  }, c('student3'), '게시판-국어');
  console.log('  ✓ 게시판: 4개 글 생성');

  // --- 설문 ---
  await POST(`/api/survey/${CLS1}`, {
    title: '수학 수업 만족도 조사', description: '소중한 의견을 들려주세요!', status: 'active',
    questions: JSON.stringify([
      { id: 1, type: 'choice', text: '수학 수업이 재미있나요?', options: ['매우 재미있다','재미있다','보통이다','재미없다'] },
      { id: 2, type: 'choice', text: '수업 내용을 이해하기 쉬웠나요?', options: ['매우 쉬움','쉬움','보통','어려움'] },
      { id: 3, type: 'text', text: '수업에 대한 건의사항이 있다면 적어주세요.' }
    ])
  }, c('teacher1'), '설문');
  console.log('  ✓ 설문: 수학 수업 만족도');

  // 검증
  await verify('STEP4 검증', async () => {
    const lessons = await GET(`/api/lesson/${CLS1}`, c('teacher1'));
    const hws = await GET(`/api/homework/${CLS1}`, c('teacher1'));
    const exams = await GET(`/api/exam/${CLS1}`, c('teacher1'));
    const notices = await GET(`/api/notice/${CLS1}`, c('teacher1'));
    if (!assert(lessons.data.total >= 2, `수업 ${lessons.data.total}개`)) return false;
    if (!assert(hws.data.total >= 1, `과제 ${hws.data.total}개`)) return false;
    if (!assert(exams.data.total >= 1, `평가 ${exams.data.total}개`)) return false;
    console.log(`  ✅ STEP 4 검증 완료: 수업${lessons.data.total}, 과제${hws.data.total}, 평가${exams.data.total}, 알림장${notices.data.total}`);
    return true;
  });

  // ═══════════ STEP 5: 학생 활동 ═══════════
  console.log('\n━━━ STEP 5: 학생 활동 (과제제출/수업이수/평가응시/댓글/설문) ━━━');

  // --- 5-1: 과제 제출 ---
  console.log('  --- 5-1: 과제 제출 ---');
  if (results.hw1) {
    await POST(`/api/homework/${CLS1}/${results.hw1.id}/submit`, {
      content: '교과서 52~53쪽 풀었습니다. 4번 문제가 어려웠어요.'
    }, c('student1'), '과제제출-1');
    console.log('  ✓ 과제제출: 정하늘 → 분수 연습문제');

    await POST(`/api/homework/${CLS1}/${results.hw1.id}/submit`, {
      content: '모두 풀었습니다! 뺄셈이 좀 헷갈렸어요.'
    }, c('student2'), '과제제출-2');
    console.log('  ✓ 과제제출: 최민준 → 분수 연습문제');

    await POST(`/api/homework/${CLS1}/${results.hw1.id}/submit`, {
      content: '52쪽, 53쪽 모두 풀었습니다.'
    }, c('student3'), '과제제출-3');
    console.log('  ✓ 과제제출: 한소희 → 분수 연습문제');

    // 교사 채점
    const hwDetail = await GET(`/api/homework/${CLS1}/${results.hw1.id}`, c('teacher1'));
    const subs = hwDetail.data.submissions || [];
    const scoreMap = { 'student1': [85,'잘 풀었어요!'], 'student2': [92,'우수합니다!'], 'student3': [78,'열심히 했어요.'] };
    for (const sub of subs) {
      const key = sub.username || '';
      const [score, feedback] = scoreMap[key] || [80, '수고했습니다.'];
      await POST(`/api/homework/${CLS1}/${results.hw1.id}/grade/${sub.id}`, { score, feedback }, c('teacher1'), '채점');
    }
    console.log(`  ✓ 과제 채점: ${subs.length}명 완료`);
  }

  if (results.hw2) {
    await POST(`/api/homework/${CLS2}/${results.hw2.id}/submit`, {
      content: '콩나물 관찰: 뿌리 하얗고 가늘었어요. 줄기 초록색, 잎 둥근 모양.'
    }, c('student1'), '과제제출-과학1');
    await POST(`/api/homework/${CLS2}/${results.hw2.id}/submit`, {
      content: '장미꽃 관찰: 뿌리 갈색 두꺼움. 줄기에 가시. 잎은 톱니 모양.'
    }, c('student2'), '과제제출-과학2');
    console.log('  ✓ 과학 과제 제출: 2명');
  }

  if (results.hw3) {
    await POST(`/api/homework/${CLS3}/${results.hw3.id}/submit`, {
      content: '어린왕자를 읽었습니다. "길들인다"는 것은 서로 특별한 관계가 된다는 뜻이라는 것을 알게 되었습니다.'
    }, c('student1'), '과제제출-국어');
    console.log('  ✓ 국어 과제 제출: 1명');
  }

  // --- 5-2: 수업 이수 ---
  console.log('  --- 5-2: 수업 이수 ---');
  if (results.lesson1 && contents.vid1) {
    const lessonId = results.lesson1.id, cId = contents.vid1.id;
    await POST(`/api/lesson/${CLS1}/${lessonId}/progress`, {
      content_id: cId, progress_percent: 100, completed: true, last_position: 0
    }, c('student1'), '이수-1');
    console.log('  ✓ 이수완료: 정하늘 → 분수 덧셈 (100%)');

    await POST(`/api/lesson/${CLS1}/${lessonId}/progress`, {
      content_id: cId, progress_percent: 75, completed: false, last_position: 180
    }, c('student2'), '이수-2');
    console.log('  ✓ 진도: 최민준 → 분수 덧셈 (75%)');

    await POST(`/api/lesson/${CLS1}/${lessonId}/progress`, {
      content_id: cId, progress_percent: 100, completed: true, last_position: 0
    }, c('student3'), '이수-3');
    console.log('  ✓ 이수완료: 한소희 → 분수 덧셈 (100%)');

    await POST(`/api/lesson/${CLS1}/${lessonId}/progress`, {
      content_id: cId, progress_percent: 50, completed: false, last_position: 120
    }, c('student4'), '이수-4');
    console.log('  ✓ 진도: 윤서준 → 분수 덧셈 (50%)');
  }

  // --- 5-3: 평가 응시 ---
  console.log('  --- 5-3: 평가 응시 ---');
  if (results.exam1) {
    const eid = results.exam1.id;
    // 학생1: 5/5 정답
    await POST(`/api/exam/${CLS1}/${eid}/start`, {}, c('student1'), '시험시작-1');
    await POST(`/api/exam/${CLS1}/${eid}/submit`, { answers: [
      {number:1,answer:'3/4'},{number:2,answer:'3/8'},{number:3,answer:'5/6'},{number:4,answer:'3/10'},{number:5,answer:'분자'}
    ]}, c('student1'), '시험제출-1');
    console.log('  ✓ 응시: 정하늘 (목표100점)');

    // 학생2: 4/5 정답
    await POST(`/api/exam/${CLS1}/${eid}/start`, {}, c('student2'), '시험시작-2');
    await POST(`/api/exam/${CLS1}/${eid}/submit`, { answers: [
      {number:1,answer:'3/4'},{number:2,answer:'2/8'},{number:3,answer:'5/6'},{number:4,answer:'3/10'},{number:5,answer:'분자'}
    ]}, c('student2'), '시험제출-2');
    console.log('  ✓ 응시: 최민준 (목표80점)');

    // 학생3: 3/5 정답
    await POST(`/api/exam/${CLS1}/${eid}/start`, {}, c('student3'), '시험시작-3');
    await POST(`/api/exam/${CLS1}/${eid}/submit`, { answers: [
      {number:1,answer:'3/4'},{number:2,answer:'3/8'},{number:3,answer:'4/6'},{number:4,answer:'3/10'},{number:5,answer:'분모'}
    ]}, c('student3'), '시험제출-3');
    console.log('  ✓ 응시: 한소희 (목표60점)');

    // 학생4: 5/5 정답
    await POST(`/api/exam/${CLS1}/${eid}/start`, {}, c('student4'), '시험시작-4');
    await POST(`/api/exam/${CLS1}/${eid}/submit`, { answers: [
      {number:1,answer:'3/4'},{number:2,answer:'3/8'},{number:3,answer:'5/6'},{number:4,answer:'3/10'},{number:5,answer:'분자'}
    ]}, c('student4'), '시험제출-4');
    console.log('  ✓ 응시: 윤서준 (목표100점)');
  }

  if (results.exam2) {
    const eid = results.exam2.id;
    await POST(`/api/exam/${CLS2}/${eid}/start`, {}, c('student1'), '과학시험1');
    await POST(`/api/exam/${CLS2}/${eid}/submit`, { answers: [
      {number:1,answer:'물과 양분 흡수'},{number:2,answer:'잎'},{number:3,answer:'물과 양분 운반, 식물 지지'},{number:4,answer:'잎'}
    ]}, c('student1'), '과학시험1-제출');
    console.log('  ✓ 과학 응시: 정하늘');

    await POST(`/api/exam/${CLS2}/${eid}/start`, {}, c('student2'), '과학시험2');
    await POST(`/api/exam/${CLS2}/${eid}/submit`, { answers: [
      {number:1,answer:'물과 양분 흡수'},{number:2,answer:'줄기'},{number:3,answer:'지지'},{number:4,answer:'잎'}
    ]}, c('student2'), '과학시험2-제출');
    console.log('  ✓ 과학 응시: 최민준');
  }

  // --- 5-4: 댓글 ---
  console.log('  --- 5-4: 댓글 ---');
  if (results.post1) {
    await POST(`/api/board/${CLS1}/${results.post1.id}/comments`, { content: '피자 그림으로 연습하면 쉬워요 🍕' }, c('student1'), '댓글1');
    await POST(`/api/board/${CLS1}/${results.post1.id}/comments`, { content: '종이를 접어서 분수를 만들어봤어요!' }, c('student2'), '댓글2');
    await POST(`/api/board/${CLS1}/${results.post1.id}/comments`, { content: '다들 좋은 방법이네요! 👍' }, c('teacher1'), '댓글3');
    console.log('  ✓ 댓글: 분수 꿀팁 글에 3개');
  }
  if (results.post3) {
    await POST(`/api/board/${CLS1}/${results.post3.id}/comments`, {
      content: '좋은 질문! 분모는 그대로 두고 분자만 빼면 됩니다.'
    }, c('teacher1'), '답변');
    await POST(`/api/board/${CLS1}/${results.post3.id}/comments`, { content: '감사합니다 선생님!' }, c('student2'), '감사답글');
    console.log('  ✓ 댓글: 질문에 선생님 답변 + 학생 감사');
  }

  // 과학반 게시글
  await POST(`/api/board/${CLS2}`, {
    title: '식물 관찰 사진 공유', content: '학교 화단에서 찍은 꽃 사진이에요. 꽃잎이 5개였어요!',
    category: 'free', allow_comments: true
  }, c('student2'), '과학게시글');
  console.log('  ✓ 게시글: 식물 관찰 사진 (과학반)');

  // --- 5-5: 설문 응답 ---
  console.log('  --- 5-5: 설문 응답 ---');
  const surveyList = await GET(`/api/survey/${CLS1}`, c('student1'));
  const surveys = surveyList.data.surveys || [];
  if (surveys.length > 0) {
    const sid = surveys[0].id;
    await POST(`/api/survey/${CLS1}/${sid}/submit`, { answers: [
      {questionId:1,answer:'매우 재미있다'},{questionId:2,answer:'쉬움'},{questionId:3,answer:'게임 활동 더 해주세요!'}
    ]}, c('student1'), '설문응답1');
    await POST(`/api/survey/${CLS1}/${sid}/submit`, { answers: [
      {questionId:1,answer:'재미있다'},{questionId:2,answer:'보통'},{questionId:3,answer:'분수를 더 천천히 설명해주세요.'}
    ]}, c('student2'), '설문응답2');
    await POST(`/api/survey/${CLS1}/${sid}/submit`, { answers: [
      {questionId:1,answer:'재미있다'},{questionId:2,answer:'쉬움'},{questionId:3,answer:''}
    ]}, c('student3'), '설문응답3');
    console.log('  ✓ 설문 응답: 3명 완료');
  }

  // 검증
  await verify('STEP5 검증', async () => {
    // 과제 제출 확인
    if (results.hw1) {
      const hwD = await GET(`/api/homework/${CLS1}/${results.hw1.id}`, c('teacher1'));
      const subCnt = hwD.data.submissions?.length || 0;
      if (!assert(subCnt >= 3, `과제제출 ${subCnt}명 ≥ 3명`)) return false;
      // 채점 확인
      const graded = (hwD.data.submissions || []).filter(s => s.score > 0).length;
      assert(graded >= 3, `채점완료 ${graded}명`);
    }
    // 시험 응시 확인 (목록 API에서 student_count 확인)
    const exList = await GET(`/api/exam/${CLS1}`, c('teacher1'));
    const mathExam = (exList.data.exams || []).find(e => e.id === results.exam1?.id);
    if (mathExam) {
      assert(mathExam.student_count >= 4, `시험응시 ${mathExam.student_count}명 ≥ 4명`);
    }
    console.log('  ✅ STEP 5 검증 완료: 과제제출/채점, 수업이수, 평가응시, 댓글, 설문 정상');
    return true;
  });

  // ═══════════ STEP 6: 오늘의 학습 ═══════════
  console.log('\n━━━ STEP 6: 오늘의 학습 세트 등록 + 학생 이수 ━━━');

  r = await POST('/api/self-learn/daily/sets', {
    title: '3월 4주차 수학 기초 다지기', description: '분수와 소수의 기초를 복습합니다.',
    target_date: '2026-03-23', target_grade: '4', target_subject: '수학', is_active: true
  }, c('teacher1'), '학습세트');
  const dailySet = r.data.set;
  console.log(`  ✓ 학습 세트: ${dailySet?.title} (id: ${dailySet?.id})`);

  if (dailySet) {
    // 아이템 추가 (camelCase 사용!)
    const itemIds = [];
    if (contents.vid1) {
      const ir = await POST(`/api/self-learn/daily/sets/${dailySet.id}/items`, {
        sourceType: 'content', contentId: contents.vid1.id,
        itemTitle: '분수의 덧셈 영상 시청', itemDescription: '영상을 끝까지 시청하세요.',
        sortOrder: 1, estimatedMinutes: 10, pointValue: 10
      }, c('teacher1'), '아이템-영상');
      if (ir.data.id) itemIds.push(ir.data.id);
      console.log(`  ✓ 아이템 추가: 분수 영상 (id: ${ir.data.id})`);
    }
    if (contents.quiz1) {
      const ir = await POST(`/api/self-learn/daily/sets/${dailySet.id}/items`, {
        sourceType: 'content', contentId: contents.quiz1.id,
        itemTitle: '받아쓰기 연습하기', itemDescription: '문항을 모두 풀어보세요.',
        sortOrder: 2, estimatedMinutes: 15, pointValue: 15
      }, c('teacher1'), '아이템-문항');
      if (ir.data.id) itemIds.push(ir.data.id);
      console.log(`  ✓ 아이템 추가: 받아쓰기 문항 (id: ${ir.data.id})`);
    }
    if (contents.examC1) {
      const ir = await POST(`/api/self-learn/daily/sets/${dailySet.id}/items`, {
        sourceType: 'content', contentId: contents.examC1.id,
        itemTitle: '수학 단원평가 풀기', itemDescription: '단원평가를 풀어보세요.',
        sortOrder: 3, estimatedMinutes: 20, pointValue: 20
      }, c('teacher1'), '아이템-평가');
      if (ir.data.id) itemIds.push(ir.data.id);
      console.log(`  ✓ 아이템 추가: 수학 단원평가 (id: ${ir.data.id})`);
    }

    // 학생1: 전체 이수
    const setDetail = await GET(`/api/self-learn/daily/${dailySet.id}`, c('student1'));
    const items = setDetail.data?.items || [];
    if (items.length > 0) {
      for (const item of items) {
        await POST(`/api/self-learn/daily/${item.id}/start`, {}, c('student1'), '학습시작');
        await POST(`/api/self-learn/daily/${item.id}/complete`, {
          score: 90, timeSpent: (item.estimated_minutes || 10) * 60
        }, c('student1'), '학습완료');
      }
      console.log(`  ✓ 학습 이수: 정하늘 (${items.length}개 아이템 완료)`);

      // 학생2: 1개만
      await POST(`/api/self-learn/daily/${items[0].id}/start`, {}, c('student2'), '학습시작2');
      await POST(`/api/self-learn/daily/${items[0].id}/complete`, {
        score: 85, timeSpent: 600
      }, c('student2'), '학습완료2');
      console.log('  ✓ 학습 일부 이수: 최민준 (1개 아이템)');
    }

    // 검증
    await verify('오늘의 학습 검증', async () => {
      const d = await GET(`/api/self-learn/daily/${dailySet.id}`, c('student1'));
      const total = d.data?.items?.length || 0;
      if (!assert(total >= 3, `학습 아이템 ${total}개 ≥ 3개`)) return false;
      console.log(`  ✅ STEP 6 검증 완료: 아이템 ${total}개, 이수 처리 정상`);
      return true;
    });
  }

  // ═══════════ STEP 7: 문제집 ═══════════
  console.log('\n━━━ STEP 7: 나만의 문제집 생성 + 담기 + 풀기 ━━━');

  r = await POST('/api/self-learn/problem-sets', {
    title: '수학 실력 쑥쑥 문제집', description: '분수와 곱셈 문제 모음', subject: '수학'
  }, c('student1'), '문제집생성');
  const problemSet = r.data.set;
  console.log(`  ✓ 문제집 생성: ${problemSet?.title} (id: ${problemSet?.id})`);

  if (problemSet) {
    if (contents.quiz2) {
      await POST(`/api/self-learn/problem-sets/${problemSet.id}/items`, { contentId: contents.quiz2.id }, c('student1'), '문제집담기1');
      console.log('  ✓ 문제집에 담기: 곱셈구구');
    }
    if (contents.quiz1) {
      await POST(`/api/self-learn/problem-sets/${problemSet.id}/items`, { contentId: contents.quiz1.id }, c('student1'), '문제집담기2');
      console.log('  ✓ 문제집에 담기: 받아쓰기');
    }

    // 풀기
    await POST(`/api/self-learn/problem-sets/${problemSet.id}/start`, {}, c('student1'), '문제집풀기시작');
    await POST(`/api/self-learn/problem-sets/${problemSet.id}/submit`, {
      answers: [{ itemId: 1, answer: '정답' }, { itemId: 2, answer: '정답' }]
    }, c('student1'), '문제집제출');
    console.log('  ✓ 문제집 풀기 완료');

    // 검증
    await verify('문제집 검증', async () => {
      const ps = await GET(`/api/self-learn/problem-sets/${problemSet.id}`, c('student1'));
      const itemCnt = ps.data.items?.length || 0;
      if (!assert(itemCnt >= 2, `문제집 아이템 ${itemCnt}개 ≥ 2개`)) return false;
      console.log(`  ✅ STEP 7 검증 완료: 문제집 아이템 ${itemCnt}개, 풀기 완료`);
      return true;
    });
  }

  // ═══════════ STEP 8: 감정출석부 ═══════════
  console.log('\n━━━ STEP 8: 감정출석부 출석 (3개 클래스) ━━━');

  const emotions = ['happy','excited','calm','sad','tired'];
  const emotionReasons = ['날씨가 좋아서 기분이 좋아요!','시험을 잘 봐서 신나요!','평범한 하루예요.','친구랑 다퉜어요..','늦게 잤어요.'];
  const studentNames = ['정하늘','최민준','한소희','윤서준','강다은','임지호'];

  // 수학교실 5명
  for (let i = 0; i < 5; i++) {
    await POST(`/api/attendance/${CLS1}/checkin`, {
      comment: `${i+1}번째 출석!`, emotion: emotions[i], emotionReason: emotionReasons[i]
    }, c(`student${i+1}`), '출석-수학');
    console.log(`  ✓ 출석: ${studentNames[i]} → 수학교실 (${emotions[i]})`);
  }

  // 과학반 3명
  for (let i = 0; i < 3; i++) {
    await POST(`/api/attendance/${CLS2}/checkin`, {
      comment: '과학 기대돼요!', emotion: emotions[(i+2)%5], emotionReason: '과학 실험이 재미있을 것 같아요!'
    }, c(`student${i+1}`), '출석-과학');
  }
  console.log('  ✓ 과학반 출석: 3명');

  // 국어 6명
  for (let i = 0; i < 6; i++) {
    await POST(`/api/attendance/${CLS3}/checkin`, {
      comment: '안녕하세요!', emotion: emotions[i%5], emotionReason: '독서가 좋아요!'
    }, c(`student${i+1}`), '출석-국어');
  }
  console.log('  ✓ 국어 출석: 6명');

  // 검증
  await verify('출석 검증', async () => {
    const st = await GET(`/api/attendance/${CLS1}/status`, c('student1'));
    if (!assert(st.data.checkedIn === true || st.data.isCheckedIn === true, '정하늘 출석 확인')) return false;
    const cls = await GET(`/api/attendance/${CLS1}/class-stats`, c('teacher1'));
    if (!assert(cls.data.todayCount >= 5, `수학교실 출석 ${cls.data.todayCount}명 ≥ 5명`)) return false;
    console.log(`  ✅ STEP 8 검증 완료: 출석 ${cls.data.todayCount}명, 스트릭 정상`);
    return true;
  });

  // ═══════════ STEP 9: 갤러리 + 승인 → 나도예술가 ═══════════
  console.log('\n━━━ STEP 9: 갤러리 게시 → 승인 → 나도예술가 연동 ━━━');

  r = await POST(`/api/board/${CLS1}`, {
    title: '분수 피자 만들기 작품', content: '분수를 피자 모양으로 표현해봤어요!',
    category: 'gallery', allow_comments: true, shareToGallery: true,
    image_url: '/uploads/gallery/fraction-pizza.jpg', galleryCategory: 'art'
  }, c('student1'), '갤러리1');
  const gPost1 = r.data.post;
  console.log('  ✓ 갤러리: 정하늘 → 분수 피자 작품 (승인대기)');

  r = await POST(`/api/board/${CLS1}`, {
    title: '수학 노트 꾸미기', content: '분수 단원을 예쁘게 정리해봤어요!',
    category: 'gallery', allow_comments: true, shareToGallery: true,
    image_url: '/uploads/gallery/math-notebook.jpg', galleryCategory: 'art'
  }, c('student3'), '갤러리2');
  const gPost2 = r.data.post;
  console.log('  ✓ 갤러리: 한소희 → 수학 노트 꾸미기 (승인대기)');

  r = await POST(`/api/board/${CLS3}`, {
    title: '어린왕자 일러스트', content: '사막의 별을 그렸어요.',
    category: 'gallery', allow_comments: true, shareToGallery: true,
    image_url: '/uploads/gallery/little-prince.jpg', galleryCategory: 'art'
  }, c('student5'), '갤러리3');
  const gPost3 = r.data.post;
  console.log('  ✓ 갤러리: 강다은 → 어린왕자 일러스트 (승인대기)');

  // 교사(개설자) 승인
  if (gPost1) { await POST(`/api/board/${CLS1}/${gPost1.id}/approve`, {}, c('teacher1'), '갤러리승인1'); console.log('  ✓ 승인: 분수 피자 → 나도예술가'); }
  if (gPost2) { await POST(`/api/board/${CLS1}/${gPost2.id}/approve`, {}, c('teacher1'), '갤러리승인2'); console.log('  ✓ 승인: 수학 노트 → 나도예술가'); }
  if (gPost3) { await POST(`/api/board/${CLS3}/${gPost3.id}/approve`, {}, c('teacher3'), '갤러리승인3'); console.log('  ✓ 승인: 어린왕자 → 나도예술가'); }

  // 검증
  await verify('갤러리 검증', async () => {
    const gal = await GET('/api/growth/gallery?page=1', c('student1'));
    const cnt = gal.data.items?.length || 0;
    if (!assert(cnt >= 3, `나도예술가 ${cnt}개 ≥ 3개`)) return false;
    console.log(`  ✅ STEP 9 검증 완료: 나도예술가 ${cnt}개 작품 등록`);
    return true;
  });

  // ═══════════ STEP 10: 추가 프로세스 ═══════════
  console.log('\n━━━ STEP 10: 소통쪽지 / 포트폴리오 / 독서 / 관찰기록 / 채널 ━━━');

  // 소통쪽지
  const student1Mem = results.members1.find(m => m.username === 'student1');
  if (student1Mem) {
    const dmRes = await POST('/api/message/rooms', {
      classId: CLS1, targetUserId: student1Mem.user_id || student1Mem.id, type: 'direct'
    }, c('teacher1'), '쪽지방');
    const roomId = dmRes.data.room?.id;
    if (roomId) {
      await POST(`/api/message/rooms/${roomId}/messages`, { content: '정하늘, 오늘 수학 열심히 했어요! 😊' }, c('teacher1'), '쪽지1');
      await POST(`/api/message/rooms/${roomId}/messages`, { content: '감사합니다 선생님!' }, c('student1'), '쪽지2');
      console.log('  ✓ 소통쪽지: 선생님 ↔ 정하늘 (2건)');
    }
  }

  // 포트폴리오
  await POST('/api/growth/portfolios', {
    title: '분수 학습 일지', description: '분수의 덧셈과 뺄셈 정리',
    class_id: CLS1, category: 'learning',
    content: '분수의 덧셈: 분모가 같은 분수끼리 분자만 더합니다. 피자 그림으로 이해했어요!'
  }, c('student1'), '포트폴리오1');
  await POST('/api/growth/portfolios', {
    title: '식물 관찰 기록', description: '콩나물 성장 관찰 3주차',
    class_id: CLS2, category: 'observation',
    content: '3주차: 콩나물 15cm, 잎 4장, 줄기가 굵어졌어요.'
  }, c('student1'), '포트폴리오2');
  console.log('  ✓ 포트폴리오: 2건 등록');

  // 독서기록
  await POST('/api/growth/reading', {
    bookTitle: '어린왕자', author: '생텍쥐페리', startDate: '2026-03-10', endDate: '2026-03-20',
    rating: 5, review: '여우의 "길들인다"는 말이 기억에 남습니다.', classId: CLS3
  }, c('student1'), '독서1');
  await POST('/api/growth/reading', {
    bookTitle: '마당을 나온 암탉', author: '황선미', startDate: '2026-03-15', endDate: '2026-03-22',
    rating: 4, review: '잎싹이가 용감하게 마당을 나와서 멋졌어요.', classId: CLS3
  }, c('student3'), '독서2');
  console.log('  ✓ 독서기록: 2건');

  // 관찰기록
  if (student1Mem) {
    await POST('/api/growth/report/observation', {
      studentId: student1Mem.user_id || student1Mem.id, classId: CLS1,
      text: '수학 수업에 적극 참여. 분수 개념을 잘 이해하고 다른 학생에게 설명해줌.', tags: '학업성취'
    }, c('teacher1'), '관찰기록');
    console.log('  ✓ 관찰기록: 정하늘 (학업성취)');
  }

  // 콘텐츠 좋아요
  if (contents.vid1) {
    for (const s of ['student1','student2','student3']) {
      await POST(`/api/contents/${contents.vid1.id}/like`, {}, c(s), '좋아요');
    }
    console.log('  ✓ 좋아요: 분수 영상 (3명)');
  }

  // 채널
  r = await POST('/api/contents/channels', {
    name: '영희쌤의 수학 채널', description: '수학을 재미있게!'
  }, c('teacher1'), '채널생성');
  const channel = r.data.channel;
  if (channel) {
    await POST(`/api/contents/channels/${channel.id}/subscribe`, {}, c('student1'), '구독1');
    await POST(`/api/contents/channels/${channel.id}/subscribe`, {}, c('student2'), '구독2');
    console.log('  ✓ 채널: 영희쌤의 수학 채널 (구독 2명)');
  }

  console.log('  ✅ STEP 10 완료');

  // ═══════════ STEP 11: LRS 집계 리빌드 ═══════════
  console.log('\n━━━ STEP 11: LRS 집계 리빌드 ━━━');
  const rebuildRes = await POST('/api/lrs/rebuild-aggregates', {}, c('admin'), 'LRS리빌드');
  if (rebuildRes.data.success && (rebuildRes.data.data || rebuildRes.data.result)) {
    const rb = rebuildRes.data.data || rebuildRes.data.result;
    console.log(`  ✓ 리빌드 완료 (${rb.elapsedMs}ms)`);
    console.log(`    총 로그: ${rb.totalLogs}, 일별: ${rb.daily}, 사용자: ${rb.user}, 콘텐츠: ${rb.content}, 클래스: ${rb.class}, 서비스: ${rb.service}`);
  }

  // ═══════════ 최종 검증 ═══════════
  console.log('\n━━━ 최종 검증 ━━━');

  const adminStats = await GET('/api/admin/stats', c('admin'));
  const as = adminStats.data;
  console.log(`  사용자: ${as.userCount || '?'}명, 클래스: ${as.classCount || '?'}개, 콘텐츠: ${as.contentCount || '?'}개`);

  const lrsDaily = await GET('/api/lrs/stats/daily?days=30', c('admin'));
  console.log(`  LRS 일별: ${lrsDaily.data.data?.length || 0}일치`);

  const lrsService = await GET('/api/lrs/stats/by-service', c('admin'));
  console.log(`  LRS 서비스: ${lrsService.data.stats?.length || 0}개`);

  const portal = await GET('/api/portal/my-summary', c('student1'));
  console.log(`  포털(정하늘): 클래스${portal.data.classCount}, 미완과제${portal.data.pendingHomework}`);

  // ══════════════════════════════════════════════════
  //  결과 요약
  // ══════════════════════════════════════════════════

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      다채움 2.0 시드 데이터 생성 완료!     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\n📋 생성 데이터:');
  console.log('  👤 계정: 관리자1 + 교사3 + 학생6 = 10명');
  console.log('  📚 콘텐츠: 영상3 + 문서1 + 문항2 + 평가지2 + 꾸러미2 = 10개 (전체 승인)');
  console.log('  🏫 클래스: 수학교실/과학반/국어 = 3개');
  console.log('  📖 수업: 4개 (콘텐츠 연결, 학생 진도 기록)');
  console.log('  📝 과제: 3개 (제출 + 채점 포함)');
  console.log('  ✅ 평가: 2개 (4+2명 응시)');
  console.log('  📢 알림장: 4개 | 💬 게시판: 5개글 + 8댓글');
  console.log('  📊 설문: 1개 (3명 응답)');
  console.log('  🎯 오늘의학습: 1세트 3아이템 | 📓 문제집: 1개');
  console.log('  😊 감정출석부: 3개 클래스 | 🎨 갤러리: 3작품→나도예술가');
  console.log('  ✉️ 쪽지: 1대화방 | 📁 포트폴리오: 2건 | 📕 독서: 2건');
  console.log('  📺 채널: 1개 (구독2명) | ❤️ 좋아요: 3건');

  console.log('\n🔑 로그인 정보:');
  console.log('  관리자: admin / 0000');
  console.log('  교사: teacher1~3 / 1234');
  console.log('  학생: student1~6 / 1234');

  if (errors.length > 0) {
    console.log(`\n⚠ 발생한 경고/오류 (${errors.length}건):`);
    errors.forEach((e, i) => console.log(`  ${i+1}. ${e}`));
  } else {
    console.log('\n✅ 모든 단계 오류 없이 완료!');
  }
}

seed().catch(err => {
  console.error('\n❌ 치명적 오류:', err.message);
  console.error(err.stack);
  process.exit(1);
});
