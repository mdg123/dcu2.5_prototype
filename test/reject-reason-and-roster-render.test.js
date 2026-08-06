// test/reject-reason-and-roster-render.test.js
// ─────────────────────────────────────────────────────────────────────────────
// [P1-B] FE 렌더 누락 3종 소스 락 — W1-T1-5 · W1-T1-6 · W1-T3-4 · W1-T2-04.
//
// 세 결함 모두 **API 는 정상인데 화면이 안 그린 것**이라 DB 단언으로는 못 잡는다.
// 그래서 "그 값을 실제로 읽는 코드가 파일에 존재하는가"를 소스에 박아 잠근다
// (같은 방식: test/survey-denominator-pure-students.test.js INV-DENOM-3).
//
//   R1. 과제 상단 "평균 제출률" 분모가 전체 멤버(classMembers.length)가 아니라
//       순수 학생 수(getClassStudentCount)여야 한다.  [W1-T1-5]
//         결함: `const totalMembers = (classMembers?.length || 1) * total;`
//         실측 class 1 → 13% (정답 18%), 카드별 제출률과 상시 불일치.
//
//   R2. 교사 제출 현황표가 제출자만이 아니라 **클래스 학생 명단 ⟕ 제출** 을
//       렌더해야 한다.  [W1-T1-6]
//         결함: hw36 = 8명 중 1명 제출인데 표에 제출자 1행만. 나머지 7명은
//               화면 어디에도 없어 "누가 안 냈는지" 알 방법이 없었다.
//
//   R3. 콘텐츠 반려 사유(reject_reason)를 작성자 화면이 그려야 한다. [W1-T3-4]
//         결함: reject_reason 을 그리는 코드가 관리자 승인관리 카드 1곳뿐.
//
//   R4. 갤러리 반려 사유를 ① 내 작품 카드 ② 상세 모달 ③ ?open= 딥링크에서
//       모두 볼 수 있어야 한다.  [W1-T2-04]
//         결함: 카드가 존재하지 않는 필드 `rejection_reason` 을 읽고 있었다
//               (DB·API 는 `reject_reason` — posts 테이블 컬럼명과 혼동한 오타).
//               상세 모달·딥링크는 렌더 코드 자체가 없었다.
//
// 역주입 증명: 각 파일에서 해당 호출/필드를 되돌리면 그 테스트가 즉시 붉어진다.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
test('R1 과제 평균 제출률 분모가 전체 멤버가 아니라 순수 학생 수다', () => {
  const src = read('public/class/class-home.html');
  const loadHw = src.slice(src.indexOf('async function loadHomeworks()'));
  const body = loadHw.slice(0, loadHw.indexOf('function setHwFilter'));

  assert.ok(
    !/classMembers\?\.length\s*\|\|\s*1/.test(body),
    'loadHomeworks 가 분모로 classMembers.length(개설자·학부모·교직원 포함)를 다시 쓰고 있다'
  );
  assert.ok(
    /getClassStudentCount\(/.test(body),
    'loadHomeworks 는 카드와 동일한 getClassStudentCount() 로 분모를 잡아야 한다'
  );
  // 분자도 카드와 같은 값(submitted_count 우선)이어야 상단↔카드가 일치한다.
  assert.ok(
    /submitted_count/.test(body),
    '평균 제출률 분자도 카드와 같은 submitted_count 를 우선 써야 한다'
  );

  // 홈 탭 활동 도넛도 같은 모집단이어야 한다.
  //   결함: `.filter(m => m.role === 'member')` → 학부모·교직원 포함 → 같은 페이지에서
  //         홈 도넛 20% vs 과제 탭 25% (실측 2026-08-06).
  const codeLines = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l.trim()));
  const bad = codeLines.filter(l => /filter\(\s*m\s*=>\s*m\.role\s*===\s*'member'\s*\)/.test(l));
  assert.deepEqual(bad, [],
    '학생 모집단을 role==="member" 만으로 거르는 곳이 남아 있다(학부모·교직원 혼입):\n' + bad.join('\n'));
  assert.ok(
    /getClassStudentCount\(null, membersRes\.members/.test(src),
    '홈 탭 활동 도넛 분모도 getClassStudentCount() 를 경유해야 한다'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
test('R2 교사 제출 현황표가 학생 명단 ⟕ 제출을 렌더한다 (미제출자 표시)', () => {
  const src = read('public/class/homework-view.html');

  assert.ok(/_classStudents\s*=\s*\(classData\.members/.test(src),
    '클래스 학생 명단을 GET /api/class/:id 의 members 에서 확보해야 한다');
  assert.ok(/_classStudents[\s\S]{0,200}user_role\s*===\s*'student'/.test(src),
    '명단은 순수 학생(user_role==="student")만 걸러야 한다');
  assert.ok(/_missing:\s*true/.test(src),
    '제출이 없는 학생을 미제출 행으로 만들어 표에 세워야 한다');
  assert.ok(/window\._allSubmissions\s*=\s*merged/.test(src),
    '상세 드로어 캐시(_allSubmissions)도 미제출자를 포함한 병합 결과여야 한다');
  assert.ok(/badge-missing/.test(src) && /미제출<\/span>/.test(src),
    '미제출 행에 "미제출" 배지가 있어야 한다');
  assert.ok(/<div class="lbl">미제출<\/div>/.test(src),
    '상단 요약에 미제출 인원이 있어야 한다');
  // 과잉 필터 금지 — 명단 밖 제출(전학 등)도 숨기지 않는다.
  assert.ok(/_orphanSubs/.test(src),
    '학생 명단에 없는 제출도 표에서 사라지면 안 된다(과잉 필터 금지)');
  // 미제출 행은 제출 id 가 없다 → 피드백/채점 API 를 호출하면 404 가 난다.
  assert.ok(/if \(!sub\.id\)/.test(src),
    '미제출자에 대해 피드백·채점 API 를 호출하지 않도록 가드해야 한다');

  // ── [감리 B-3] 상단 요약의 모집단 == 히어로 칩 분모(학생 명단) ─────────────
  //   결함: 요약을 merged(= 명단 + 명단 밖 제출) 기준으로 세는 바람에
  //         칩 `제출 1/7` vs 표 `제출 2 / 미제출 6`(합 8) 로 같은 화면이 어긋났다.
  const codeLines = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l.trim()));
  const mergedAgg = codeLines.filter(l => /const (submittedRows|missingRows|graded) = merged\.filter/.test(l));
  assert.deepEqual(mergedAgg, [],
    '제출 현황 요약을 merged(명단 밖 제출 포함) 기준으로 세고 있다 — 칩 분모와 어긋난다:\n' + mergedAgg.join('\n'));
  assert.ok(/const submittedRows = _rosterRows\.filter/.test(src)
         && /const missingRows = _rosterRows\.filter/.test(src),
    '요약은 학생 명단(_rosterRows) 기준이어야 칩 분모와 일치한다');
  // 명단 밖 제출은 숨기지 않되(과잉 필터 금지) 세지 않는다는 사실을 화면이 밝혀야 한다.
  assert.ok(/_orphan: true/.test(src) && /badge-orphan/.test(src) && /orphanSubNote/.test(src),
    '명단 밖 제출은 라벨·안내와 함께 보여주되 통계에서 제외한다는 것을 화면에 밝혀야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
test('R5 제출 현황표의 열 수가 헤더와 본문에서 같다 [감리 B-5]', () => {
  const src = read('public/class/homework-view.html');
  const thead = (src.match(/<thead><tr>(<th>.*?<\/th>)+<\/tr><\/thead>/) || [''])[0];
  const thCount = (thead.match(/<th>/g) || []).length;
  assert.equal(thCount, 6,
    `제출 현황표 헤더가 ${thCount}열이다. 행은 6열(채점·피드백이 같은 td)이므로 6이어야 한다`);
  assert.ok(/<th>채점 · 피드백<\/th>/.test(src), '마지막 열 라벨은 "채점 · 피드백" 이어야 한다');
  assert.ok(!/<th>피드백<\/th>/.test(src), '늘 비어 있던 별도 "피드백" 열이 남아 있다');
  // 빈 상태 colspan 도 열 수와 같아야 한다
  const colspans = [...src.matchAll(/id="submissionTable"[\s\S]{0,400}?colspan="(\d+)"/g)].map(m => m[1]);
  const emptyColspan = (src.match(/colspan="(\d+)"[^>]*>이 클래스에 학생이 없어요/) || [])[1];
  assert.equal(emptyColspan, '6', `빈 상태 colspan(${emptyColspan})이 열 수 6과 다르다`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('R3 콘텐츠 반려 사유가 작성자 카드·리스트에 렌더된다', () => {
  const src = read('public/content/index.html');
  assert.ok(/function rejectReasonBox\(/.test(src),
    '반려/보류 사유 렌더 헬퍼가 있어야 한다');
  assert.ok(/rejectReasonBox\(item,\s*'card'\)/.test(src), '카드 뷰에 사유가 그려져야 한다');
  assert.ok(/rejectReasonBox\(item,\s*'row'\)/.test(src), '리스트 뷰에 사유가 그려져야 한다');
  assert.ok(/rejectReasonBox\(item,\s*'compact'\)/.test(src), '대시보드 요약 카드에도 사유가 그려져야 한다');
  // 사유가 비어 있어도 "왜 반려됐는지 모름"으로 끝나지 않게 안내가 있어야 한다.
  assert.ok(/사유가 적혀 있지 않아요/.test(src), '사유 미기재 시 안내 문구가 있어야 한다');
  // 남의 콘텐츠에 사유가 새면 안 된다 — showStatus(내가 만든 것) 게이트를 통과할 것.
  assert.ok(/\$\{showStatus \? rejectReasonBox\(item, 'card'\) : ''\}/.test(src),
    '반려 사유는 showStatus(본인 콘텐츠) 일 때만 그려야 한다');
});

// ─────────────────────────────────────────────────────────────────────────────
test('R4 갤러리 반려 사유가 내 작품 카드·상세 모달·딥링크에서 보인다', () => {
  const src = read('public/plus/gallery.html');

  // ① 오타 필드가 남아 있으면 안 된다 (DB/API 는 reject_reason). 주석 줄은 결함 설명이므로 제외.
  const codeLines = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.deepEqual(
    codeLines.filter(l => /rejection_reason/.test(l)), [],
    '존재하지 않는 필드 rejection_reason 을 읽는 코드가 남아 있다 — 정본은 reject_reason'
  );
  assert.ok(/item\.reject_reason/.test(src), 'reject_reason 을 실제로 읽어야 한다');

  // ② 카드 · 상세 모달 양쪽에서 같은 헬퍼를 쓴다(동일 기능 = 동일 표현)
  assert.ok(/function approvalNoteHtml\(/.test(src), '승인 상태 안내 헬퍼가 있어야 한다');
  assert.ok(/approvalNoteHtml\(item, 'card'\)/.test(src), '내 작품 카드에 안내가 그려져야 한다');
  assert.ok(/approvalNoteHtml\(item, 'detail'\)/.test(src), '상세 모달에 안내가 그려져야 한다');
  assert.ok(/id="detailApprovalNote"/.test(src), '상세 모달에 안내 슬롯이 있어야 한다');

  // ③ 사유는 작성자 본인·교사·관리자에게만 (남의 반려 사유 노출 금지)
  assert.ok(/const mine = isOwner\(item\);/.test(src) && /if \(!mine && !staff\) return '';/.test(src),
    '반려 사유는 작성자 본인과 교사·관리자에게만 보여야 한다');

  // ④ ?open= 딥링크 — 캐시에 없어도 서버 단건 조회로 연다
  assert.ok(/\/api\/growth\/gallery\/\$\{id\}`\)/.test(src),
    'showDetail 은 캐시에 없는 작품도 서버에서 단건 조회해 열어야 한다');
  assert.ok(!/tries < 10/.test(src),
    '딥링크가 캐시 대기 루프(10회 재시도 후 조용히 실패)로 돌아가면 안 된다');

  // ⑤ 교사 승인관리 "반려됨" 목록에서도 사유가 보여야 한다
  assert.ok(/반려 사유<\/strong>/.test(src), '교사 승인관리 반려 목록에도 사유가 있어야 한다');
});
