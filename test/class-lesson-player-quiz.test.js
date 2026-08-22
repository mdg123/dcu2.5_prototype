// test/class-lesson-player-quiz.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 수업꾸러미(lesson-player) 문항 렌더 = 채움콘텐츠 공용 플레이어 재사용 계약 박제
//
// [무엇을 막는가]
//   2026-08-06 사용자 지적: "채움클래스에서 수업꾸러미를 만들 때 문항을 삽입하면 왜
//   1페이지에 여러 개의 문항이 한꺼번에 있어? 평가지 플레이어를 그대로 활용해서
//   1페이지당 1문항씩 나오게 하는 게 맞지."
//   당시 lesson-player.html 은 renderQuestions() 안에서 questions.forEach 로 전 문항을
//   한 화면에 쏟아냈고, 덤으로 (a) 정답 보기를 초록으로 칠해 학생에게 답을 노출했으며
//   (b) 그 정답 판정이 1-based(oi+1===answer) 라 0-based 로 저장된 실제 정답과 어긋나
//   "틀린 정답"을 정답이라고 보여줬다.
//
// [왜 소스 계약 테스트인가]
//   화면 렌더는 순수 함수가 아니라 DOM·iframe·Socket.IO 에 얽혀 있어 node:test 로
//   실행 검증이 불가하다. 대신 "다시는 그 형태로 돌아갈 수 없게" 소스 형태를 잠근다.
//   실제 동작(1문항 1페이지·답안 저장·동기화 추종·판서)은 프리뷰 실측으로 확인했고
//   그 증적은 보고서/증적/수업꾸러미_문항플레이어_20260806/ 에 있다.
//
//   INV-LP1  학생 풀이 경로가 전 문항을 나열하지 않는다
//   INV-LP2  학생 풀이 경로가 content-player.html 을 규약대로 재사용한다
//   INV-LP3  답안 저장·이수 처리 경로가 유지된다(중복 저장 없음)
//   INV-LP4  교사용 "콘텐츠 추가" 미리보기는 전 문항 나열을 유지하되 정답은 0-based
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LP_PATH = path.join(ROOT, 'public', 'class', 'lesson-player.html');
const CP_PATH = path.join(ROOT, 'public', 'content', 'content-player.html');

const LP = fs.readFileSync(LP_PATH, 'utf8');
const CP = fs.readFileSync(CP_PATH, 'utf8');

// "없어야 한다" 계열 검사는 주석을 제외하고 본다.
// (왜 그 형태를 버렸는지 설명하는 주석 자체가 지문에 걸려 오탐이 나기 때문)
const LP_CODE = LP.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// selectContent() 안의 "학생 풀이 경로"(quiz/exam 분기)만 잘라낸다.
function quizBranch() {
  const m = LP.match(/\(cType === 'quiz' \|\| cType === 'exam'\) && c\.questions[\s\S]{0,400}?\n\s*} else if/);
  assert.ok(m, 'selectContent 의 quiz/exam 분기를 찾지 못했습니다 — 구조가 바뀌었으면 이 테스트를 먼저 갱신하세요.');
  return m[0];
}

// previewAddContent() 안의 미리보기 문항 렌더 블록만 잘라낸다.
function previewBlock() {
  const i = LP.indexOf('async function previewAddContent');
  assert.ok(i > 0, 'previewAddContent 를 찾지 못했습니다.');
  const j = LP.indexOf('} else if (cType === \'video\')', i);
  assert.ok(j > i, 'previewAddContent 의 문항 미리보기 블록을 찾지 못했습니다.');
  return LP.slice(i, j);
}

// ─── INV-LP1 ────────────────────────────────────────────────────────────────
test('INV-LP1: 수업꾸러미 학생 풀이 경로가 전 문항을 한 화면에 나열하지 않는다', () => {
  // 전 문항 나열의 지문 — questions.forEach / renderQuestions 정의는 완전히 사라져야 한다.
  assert.ok(
    !/questions\.forEach/.test(LP_CODE),
    'lesson-player.html 에 questions.forEach 가 있습니다 — 전 문항 나열이 되살아났습니다. '
    + '문항 풀이는 content-player.html(1문항 1페이지) 재사용이 정답입니다.'
  );
  assert.ok(
    !/function\s+renderQuestions\s*\(/.test(LP_CODE),
    'renderQuestions() 가 되살아났습니다 — 이 함수는 전 문항 나열 + 정답 노출 + 1-based 오판정의 원인이었습니다.'
  );
  assert.ok(
    !/renderQuestions\s*\(/.test(LP_CODE),
    'renderQuestions() 호출부가 남아 있습니다.'
  );
});

// ─── INV-LP2 ────────────────────────────────────────────────────────────────
test('INV-LP2: 학생 풀이 경로가 content-player.html 을 규약대로 재사용한다', () => {
  const branch = quizBranch();
  assert.match(
    branch, /renderQuestionPlayer\(c, viewport\)/,
    'quiz/exam 분기가 renderQuestionPlayer 를 호출하지 않습니다.'
  );

  assert.match(
    LP, /function\s+renderQuestionPlayer\s*\(/,
    'renderQuestionPlayer 정의가 없습니다.'
  );

  // 공용 플레이어 iframe — 경로와 쿼리 파라미터 규약(today.html / learning-map.html 과 동일)
  //   2026-08-21: 뒤에 lessonId·classId 가 붙는다(응답 현황 모니터 BE-1 — 수업 맥락 기록).
  //   앞부분 `id=${content.id}&embed=1&solve=1` 계약은 그대로다.
  assert.match(
    LP, /src="\/content\/content-player\.html\?id=\$\{content\.id\}&embed=1&solve=1/,
    'content-player.html 을 embed=1&solve=1 규약으로 임베드해야 합니다 '
    + '(today.html:1619 / learning-map.html 과 동일한 계약).'
  );

  // 새 파라미터 발명 금지 — 허용 어휘: id / embed / solve / auto / silent / popup
  //   + lessonId / classId (BE-1: content-player 가 /attempts POST body 로 실어 보내
  //     "수업 중 풀이"와 "혼자 푼 풀이"를 서버가 구분한다. content-player.html 이 실제로 읽는다)
  const ALLOWED_CP_PARAMS = ['id', 'embed', 'solve', 'auto', 'silent', 'popup', 'lessonId', 'classId'];
  const qs = LP.match(/content-player\.html\?([^"'`\s]+)/g) || [];
  assert.ok(qs.length > 0, 'content-player 임베드 URL 을 찾지 못했습니다.');
  for (const u of qs) {
    for (const kv of u.split('?')[1].split('&')) {
      const key = kv.split('=')[0];
      assert.ok(
        ALLOWED_CP_PARAMS.includes(key),
        `content-player 에 없는 쿼리 파라미터를 발명했습니다: ${key} (${u})`
      );
    }
  }
  // 발명이 아님을 증명 — content-player.html 이 이 두 파라미터를 실제로 읽어 쓴다
  const CP = fs.readFileSync(path.join(ROOT, 'public/content/content-player.html'), 'utf8');
  assert.match(CP, /params\.get\('lessonId'\)/, "content-player 가 lessonId 를 읽지 않습니다(죽은 파라미터).");
  assert.match(CP, /params\.get\('classId'\)/, "content-player 가 classId 를 읽지 않습니다(죽은 파라미터).");

  // embed 모드는 플레이어 body 를 transparent 로 만든다 → 어두운 뷰포트에 글자가 묻히지
  // 않도록 iframe 요소 자체에 흰 배경이 반드시 있어야 한다.
  const fn = LP.slice(LP.indexOf('function renderQuestionPlayer'), LP.indexOf('function renderQuestionPlayer') + 900);
  assert.match(
    fn, /background:#fff/,
    'renderQuestionPlayer 의 iframe 에 background:#fff 가 없습니다 — '
    + 'embed 모드는 플레이어 body 를 transparent 로 만들어 검은 뷰포트가 비쳐 글자가 안 보입니다.'
  );

  // 영상·PDF 와 같은 자리(뷰포트 인라인)여야 한다. 별도 모달이면 동기화 lockstep 과 충돌.
  assert.match(
    fn, /viewport\.innerHTML/,
    '문항 플레이어는 영상·PDF 와 동일하게 viewport.innerHTML 인라인이어야 합니다(별도 모달 금지).'
  );

  // 재사용 대상(content-player)이 1문항 1페이지 계약을 유지하는지 — 반대편 계약도 잠근다.
  assert.match(CP, /문항 \$\{idx \+ 1\} \/ \$\{questions\.length\}/, 'content-player 의 1문항 1페이지 헤더가 사라졌습니다.');
  assert.match(CP, /params\.get\('embed'\) === '1'/, 'content-player 의 embed 파라미터 처리가 사라졌습니다.');
});

// ─── INV-LP3 ────────────────────────────────────────────────────────────────
test('INV-LP3: 답안 저장·이수 처리 경로가 유지되고 중복 저장이 없다', () => {
  // (1) 답안/채점 저장은 content-player 가 단독으로 수행한다.
  assert.match(
    CP, /fetch\('\/api\/contents\/' \+ contentId \+ '\/attempts'/,
    'content-player 의 답안 저장(/api/contents/:id/attempts) 이 사라졌습니다 — 학습 기록이 남지 않습니다.'
  );
  // (2) 수업꾸러미는 답안을 중복 저장하면 안 된다(이중 시도·이중 채점 방지).
  assert.ok(
    !/\/attempts/.test(LP_CODE),
    'lesson-player 가 /attempts 로 답안을 직접 저장하고 있습니다 — content-player 와 중복 기록됩니다.'
  );

  // (3) 채점 결과는 postMessage 로 부모에게 전달된다.
  assert.match(CP, /type: 'dacheum:quiz-graded'/, 'content-player 의 채점 결과 postMessage 가 사라졌습니다.');
  assert.match(CP, /type: 'dacheum:player-close'/, 'content-player 의 닫기 postMessage 가 사라졌습니다.');

  // (4) 수업꾸러미는 그 메시지를 받아 "이수(진도)"만 기록한다.
  const li = LP.indexOf("if (d.type !== 'dacheum:quiz-graded'");
  assert.ok(li > 0, 'lesson-player 에 임베드 플레이어 메시지 수신부가 없습니다 — 제출해도 이수 처리가 안 됩니다.');
  const handler = LP.slice(LP.indexOf("window.addEventListener('message'", li - 2000), li + 3000);

  assert.match(handler, /e\.origin !== location\.origin/, '메시지 수신부에 origin 검증이 없습니다.');
  assert.match(handler, /e\.source !== frame\.contentWindow/, '메시지 수신부에 발신 iframe 검증이 없습니다.');
  assert.match(
    handler, /saveProgress\(c\.id, \{ progress_percent: 100, completed: true \}\)/,
    '채점 결과 수신 시 이수(진도 100/완료) 기록이 없습니다.'
  );
  assert.match(handler, /dacheum:player-error/, 'player-error 처리가 없습니다.');
  // 동기화 잠금 중인 학생이 임의로 다음 콘텐츠로 튀지 않아야 한다.
  assert.match(
    handler, /syncState\.on && !isTeacherViewer/,
    'player-close 처리에 동기화 잠금 가드가 없습니다 — 잠긴 학생이 교사보다 앞서 나갑니다.'
  );

  // (5) 진도 저장 엔드포인트 계약
  assert.match(
    LP, /fetch\(`\/api\/lesson\/\$\{classId\}\/\$\{lessonId\}\/progress`/,
    '수업 진도 저장 엔드포인트가 바뀌었습니다.'
  );
  // (6) selectContent 의 동기화 lockstep 가드는 그대로여야 한다.
  assert.match(
    LP, /if \(syncState\.on && !isTeacherViewer && index !== syncState\.index\)/,
    '수업꾸러미 동기화(lockstep) 가드가 사라졌습니다.'
  );
});

// ─── INV-LP4 ────────────────────────────────────────────────────────────────
test('INV-LP4: 교사 "콘텐츠 추가" 미리보기는 전 문항 나열 유지 + 정답은 0-based', () => {
  const blk = previewBlock();
  // 이 미리보기는 "수업에 넣을지" 판단하려 문항 구성을 훑는 용도라 나열이 맞다.
  assert.match(
    blk, /c\.questions\.map\(/,
    '콘텐츠 추가 미리보기의 전 문항 나열이 사라졌습니다 — 교사가 문항 구성을 훑을 수 없습니다.'
  );
  // 정답 인덱스는 0-based 저장(예: answer '2' = 세 번째 보기). oi+1 비교는 엉뚱한 보기를 정답으로 칠한다.
  assert.ok(
    !/String\(oi\s*\+\s*1\)\s*===\s*String\(q\.answer\)/.test(blk),
    '미리보기 정답 판정이 1-based(oi+1) 로 되돌아갔습니다 — 실제 정답은 0-based 저장이라 틀린 보기가 정답으로 표시됩니다.'
  );
  assert.match(
    blk, /String\(oi\)\s*===\s*String\(q\.answer\)/,
    '미리보기 정답 판정이 0-based 비교가 아닙니다.'
  );
  // 보기 번호가 전부 ① 로 찍히던 버그
  assert.ok(
    !/>① \$\{escHtml\(o\)\}/.test(blk),
    '미리보기 보기 번호가 전부 ① 로 고정돼 있습니다 — optionLabels[oi] 를 쓰세요.'
  );

  // 학생에게 정답이 노출되던 자리(뷰포트)에는 정답 하이라이트가 남아 있으면 안 된다.
  const branch = quizBranch();
  assert.ok(
    !/isAnswer/.test(branch),
    '학생 풀이 뷰포트 경로에 정답 하이라이트 로직이 남아 있습니다 — 학생에게 답이 노출됩니다.'
  );
});
