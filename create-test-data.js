/**
 * 테스트 데이터 생성 스크립트
 * UTF-8 인코딩으로 한글 데이터를 정상 저장합니다.
 * 실행: node create-test-data.js
 */
const http = require('http');
const PORT = process.env.PORT || 55976;
const BASE = `http://localhost:${PORT}`;
let teacherCookie = '';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: PORT,
      path, method,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    };
    if (teacherCookie) opts.headers.Cookie = teacherCookie;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data, 'utf8');
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        if (cookies.length) teacherCookie = cookies.map(c => c.split(';')[0]).join('; ');
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data, 'utf8');
    r.end();
  });
}

async function main() {
  console.log('=== 1. 교사 로그인 ===');
  const login = await req('POST', '/api/auth/login', { username: 'teacher1', password: '1234' });
  console.log('로그인:', login.user?.display_name);

  console.log('\n=== 2. 콘텐츠 생성 (영상+퀴즈+이미지) ===');

  const video = await req('POST', '/api/contents', {
    title: '분수의 덧셈과 뺄셈 개념 영상',
    description: '4학년 1학기 분수 단원 핵심 개념 설명 영상입니다.',
    content_type: 'video',
    content_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    subject: '수학', grade: 4, is_public: false
  });
  console.log('영상 콘텐츠:', video.content?.id, video.content?.title);

  const quiz = await req('POST', '/api/contents', {
    title: '분수의 덧셈 연습 문항',
    description: '분수의 덧셈 기초 문항 5개입니다.',
    content_type: 'quiz',
    subject: '수학', grade: 4, is_public: false,
    questions: [
      { question_number: 1, question_text: '$\\frac{1}{4} + \\frac{2}{4}$ = ?', question_type: 'choice', options: ['$\\frac{1}{4}$','$\\frac{2}{4}$','$\\frac{3}{4}$','$\\frac{4}{4}$'], answer: 2, points: 20 },
      { question_number: 2, question_text: '$\\frac{3}{8} + \\frac{2}{8}$ = ?', question_type: 'choice', options: ['$\\frac{3}{8}$','$\\frac{4}{8}$','$\\frac{5}{8}$','$\\frac{6}{8}$'], answer: 2, points: 20 },
      { question_number: 3, question_text: '$\\frac{2}{5} + \\frac{1}{5}$ = ?', question_type: 'choice', options: ['$\\frac{2}{5}$','$\\frac{3}{5}$','$\\frac{4}{5}$','$\\frac{1}{5}$'], answer: 1, points: 20 },
      { question_number: 4, question_text: '$\\frac{1}{6} + \\frac{4}{6}$ = ?', question_type: 'choice', options: ['$\\frac{4}{6}$','$\\frac{5}{6}$','$\\frac{6}{6}$','$\\frac{3}{6}$'], answer: 1, points: 20 },
      { question_number: 5, question_text: '분모가 같은 분수의 덧셈에서 분모는 어떻게 하나요?', question_type: 'choice', options: ['더한다','그대로 둔다','뺀다','곱한다'], answer: 1, points: 20 }
    ]
  });
  console.log('퀴즈 콘텐츠:', quiz.content?.id, quiz.content?.title);

  const image = await req('POST', '/api/contents', {
    title: '분수 개념 정리 인포그래픽',
    description: '분수의 덧셈과 뺄셈 핵심 개념을 정리한 이미지입니다.',
    content_type: 'image',
    content_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Cake_fractions.svg/640px-Cake_fractions.svg.png',
    subject: '수학', grade: 4, is_public: false
  });
  console.log('이미지 콘텐츠:', image.content?.id, image.content?.title);

  console.log('\n=== 3. 수업 꾸러미 생성 ===');
  const lesson = await req('POST', '/api/lesson/2', {
    title: '분수의 덧셈과 뺄셈 (1차시)',
    description: '4학년 1학기 수학 - 분수의 덧셈과 뺄셈 개념을 이해하고 연습합니다.',
    content: '학습 목표: 분모가 같은 분수의 덧셈과 뺄셈을 할 수 있다.\n\n1. 영상으로 개념 학습\n2. 이미지로 핵심 정리\n3. 문항 풀이로 확인',
    lesson_date: '2026-03-31',
    estimated_minutes: 40,
    status: 'published',
    content_ids: [video.content?.id, image.content?.id, quiz.content?.id].filter(Boolean)
  });
  console.log('수업:', lesson.lesson?.id, lesson.lesson?.title);

  console.log('\n=== 4. 과제 출제 ===');
  const hw = await req('POST', '/api/homework/2', {
    title: '분수의 덧셈 연습 과제',
    description: '교과서 42-43쪽의 분수 덧셈 문제를 풀고, 풀이 과정을 사진으로 찍어 제출하세요.\n\n제출 기한: 2026년 4월 2일까지',
    due_date: '2026-04-02',
    max_score: 100
  });
  console.log('과제:', hw.homework?.id, hw.homework?.title);

  console.log('\n=== 5. 성취기준 기반 평가지 생성 ===');
  const exam = await req('POST', '/api/exam/2', {
    title: '분수의 덧셈과 뺄셈 단원평가',
    description: '4학년 1학기 수학 분수 단원 성취도 평가입니다.\n성취기준: [4수01-11] 분모가 같은 분수의 덧셈과 뺄셈의 원리를 이해하고 계산할 수 있다.',
    time_limit: 20,
    status: 'active',
    questions: [
      { id: 1, question_number: 1, question_text: '$\\frac{1}{5} + \\frac{3}{5}$ 의 값은?', question_type: 'choice', options: ['$\\frac{2}{5}$','$\\frac{3}{5}$','$\\frac{4}{5}$','$\\frac{5}{5}$'], answer: 2, points: 20, explanation: '분모가 같으므로 분자끼리 더합니다. 1+3=4' },
      { id: 2, question_number: 2, question_text: '$\\frac{7}{9} - \\frac{4}{9}$ 의 값은?', question_type: 'choice', options: ['$\\frac{2}{9}$','$\\frac{3}{9}$','$\\frac{4}{9}$','$\\frac{11}{9}$'], answer: 1, points: 20, explanation: '분모가 같으므로 분자끼리 뺍니다. 7-4=3' },
      { id: 3, question_number: 3, question_text: '$\\frac{2}{7} + \\frac{4}{7}$ 의 값은?', question_type: 'choice', options: ['$\\frac{4}{7}$','$\\frac{5}{7}$','$\\frac{6}{7}$','$\\frac{8}{7}$'], answer: 2, points: 20, explanation: '2+4=6, 분모는 그대로 7' },
      { id: 4, question_number: 4, question_text: '$\\frac{8}{10} - \\frac{3}{10}$ 의 값은?', question_type: 'choice', options: ['$\\frac{3}{10}$','$\\frac{4}{10}$','$\\frac{5}{10}$','$\\frac{11}{10}$'], answer: 2, points: 20, explanation: '8-3=5, 분모는 그대로 10' },
      { id: 5, question_number: 5, question_text: '분모가 같은 분수의 덧셈에서 올바른 설명은?', question_type: 'choice', options: ['분모와 분자를 모두 더한다','분모는 그대로 두고 분자만 더한다','분자는 그대로 두고 분모만 더한다','분모와 분자를 모두 곱한다'], answer: 1, points: 20, explanation: '분모가 같은 분수의 덧셈은 분모는 그대로 두고 분자끼리만 더합니다.' }
    ]
  });
  console.log('평가:', exam.exam?.id, exam.exam?.title);

  console.log('\n=== 6. 알림장 작성 ===');
  const notice = await req('POST', '/api/notice/2', {
    title: '3월 31일 알림장',
    content: '안녕하세요, 즐거운 수학교실 학생 여러분!\n\n오늘의 안내사항\n1. 오늘 분수의 덧셈과 뺄셈 수업이 등록되었습니다. 꼭 시청하고 문항을 풀어주세요.\n2. 분수 연습 과제가 출제되었습니다. 4월 2일까지 제출해주세요.\n3. 분수 단원평가가 게시되었습니다. 제한시간 20분입니다.\n\n열심히 공부합시다!'
  });
  console.log('알림장:', notice.notice?.id, notice.notice?.title);

  // === 학생 활동 ===
  console.log('\n=== 7. 학생 로그인 (student1) ===');
  const sLogin = await req('POST', '/api/auth/login', { username: 'student1', password: '1234' });
  console.log('학생 로그인:', sLogin.user?.display_name);

  console.log('\n=== 8. 학생: 수업 이수 (진도 100%) ===');
  const lessonId = lesson.lesson?.id;
  if (lessonId) {
    // 각 콘텐츠별 진도 완료
    const contentIds = [video.content?.id, image.content?.id, quiz.content?.id].filter(Boolean);
    for (const cid of contentIds) {
      const prog = await req('POST', `/api/lesson/2/${lessonId}/progress`, {
        content_id: cid, progress_percent: 100, completed: true
      });
      console.log('  진도 완료:', cid, prog.success);
    }
  }

  console.log('\n=== 9. 학생: 과제 제출 ===');
  const hwId = hw.homework?.id;
  if (hwId) {
    const submit = await req('POST', `/api/homework/2/${hwId}/submit`, {
      content: '분수의 덧셈 풀이입니다.\n\n1. 1/4 + 2/4 = 3/4\n2. 3/8 + 2/8 = 5/8\n3. 2/5 + 1/5 = 3/5\n\n분모가 같은 분수는 분자만 더하면 됩니다.'
    });
    console.log('과제 제출:', submit.success, submit.submission?.id);
  }

  console.log('\n=== 10. 학생: 평가 응시 ===');
  const examId = exam.exam?.id;
  if (examId) {
    const start = await req('POST', `/api/exam/2/${examId}/start`, {});
    console.log('시험 시작:', start.success, '문항수:', start.questions?.length);

    const submitExam = await req('POST', `/api/exam/2/${examId}/submit`, {
      answers: [2, 1, 2, 2, 1]  // 전부 정답
    });
    console.log('시험 제출:', submitExam.success, '점수:', submitExam.score);
  }

  console.log('\n=== 11. 학생: 게시판 댓글 작성 ===');
  // 기존 게시글에 댓글
  const posts = await req('GET', '/api/board/2');
  if (posts.posts?.length) {
    const postId = posts.posts[0].id;
    const comment = await req('POST', `/api/board/2/${postId}/comments`, {
      content: '오늘 수업 정말 재미있었어요! 분수가 이제 이해돼요.'
    });
    console.log('댓글 작성:', comment.success);
  } else {
    // 게시글이 없으면 새로 작성
    const post = await req('POST', '/api/board/2', {
      title: '분수 수업 후기',
      content: '오늘 분수의 덧셈과 뺄셈 수업을 듣고 문제도 풀었어요.\n분모가 같으면 분자만 더하면 된다는 걸 알게 되었습니다!',
      category: 'general'
    });
    console.log('게시글 작성:', post.success, post.post?.id);
    if (post.post?.id) {
      const comment = await req('POST', `/api/board/2/${post.post.id}/comments`, {
        content: '저도 오늘 수업 좋았어요!'
      });
      console.log('댓글 작성:', comment.success);
    }
  }

  console.log('\n=== 완료! 생성된 ID 요약 ===');
  console.log('수업:', lessonId);
  console.log('과제:', hwId);
  console.log('평가:', examId);
  console.log('알림장:', notice.notice?.id);
  console.log('영상 콘텐츠:', video.content?.id);
  console.log('퀴즈 콘텐츠:', quiz.content?.id);
  console.log('이미지 콘텐츠:', image.content?.id);
}

main().catch(console.error);
