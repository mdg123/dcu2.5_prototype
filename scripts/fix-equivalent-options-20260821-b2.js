#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 의미적 중복 정답 수리 — 배치 2 (2026-08-21)
 * scripts/fix-equivalent-options-20260821.js(배치 1)의 **규약과 가드를 그대로 승계**한다.
 * 배치 1 은 이미 정본에 적용돼 계획이 동결됐으므로, 인계분 36건은 이 파일에서 처리한다.
 * ─────────────────────────────────────────────────────────────────────────────
 * ■ 배치 1 이 남긴 것
 *   "정답과 값은 같은데 글자만 다른 보기" 중, **해설이 그 칸을 오답으로 열거**하거나
 *   **정답이 대분수인데 쌍둥이가 가분수**인 36건. 배치 1 은 보기 교체만 허용했기 때문에
 *   손댈 수 없었다(교체하면 해설의 번호 참조가 어긋나거나, 어느 표기가 정답인지 알 수 없다).
 *
 * ■ 이번 배치의 판단 (PM 승인)
 *   배치 1 의 원칙 B("지문은 손대지 않는다")를 **이 부류에 한해** 완화한다.
 *   근거: 아래 문항들은 **해설이 이미 약분(또는 대분수 변환)을 요구**하고 있다.
 *     q6340 해설 "…=-6/12=-1/2이다. ①-6/12는 약분하지 않았을 뿐 … 정답은 기약분수 -1/2이다."
 *   즉 학습 목표에 그 형식이 **이미 포함**돼 있고, 지문에만 빠져 있다. 지문에 형식 요구를
 *   적는 것은 학습 목표 변경이 아니라 **지문↔해설 불일치를 바로잡는 것**이다.
 *   학생은 답하기 전에 해설을 볼 수 없으므로 지금 상태가 부당하다.
 *
 * ■ 세 갈래 처리
 *   FORMAT  지문 말미에 형식 요구 한 구절만 덧붙인다. **보기는 한 글자도 바꾸지 않는다**
 *           — 해설의 번호 참조(①②)가 어긋나면 안 되기 때문이다.
 *           · kind='irreducible' → " (기약분수로 나타내시오.)"
 *           · kind='mixed'       → " (대분수로 나타내시오.)"
 *   SWAP    지문으로는 풀 수 없는 것(정답 자체가 약분 전 형태) — 배치 1 방식대로 쌍둥이 칸 교체.
 *   HOLD    근거가 약해 **손대지 않는다**. 아래 HOLD 참조. 백로그에 사유와 함께 남는다.
 *
 * ■ 원칙 (배치 1 과 동일한 안전선)
 *   A. **정답 칸은 절대 건드리지 않는다.** answer 값도, 정답 보기 텍스트도 그대로.
 *      정답이 이동하면 기존 제출 기록의 정오답이 뒤집힌다.
 *      → FORMAT 은 `question_text` 한 컬럼만, SWAP 은 `options` 한 컬럼만 쓴다.
 *        answer 는 WHERE 절 확인용으로만 쓰고 갱신하지 않는다.
 *   B. 판단이 안 서면 **건드리지 않는다**. 36건을 다 처리하는 것보다 틀린 값을 넣지 않는 것이
 *      압도적으로 중요하다.
 *
 * ■ 가드
 *   [공통] 정답 index 범위 · 정답 보기 텍스트 불변 · 보기 개수 불변 · 상대 연산 없음(멱등)
 *   [FORMAT] · 정답 보기가 요구 형식을 **만족**한다(기약분수 / 분수부가 진분수인 대분수)
 *            · 정답과 값이 같은 보기가 실제로 존재하고, 그 **전부**가 요구 형식을 **위반**한다
 *              → 형식 요구를 붙여도 "정답이 둘" 이 남으면 이 가드가 잡는다
 *            · 지문에 이미 그 형식 키워드가 없다(중복 문구 방지 · 멱등)
 *            · 보기 배열은 변경 대상이 아니다(전문 대조로 불변 확인)
 *            · 해설에 **형식 요구의 근거 문구**(evidence)가 실제로 있다 — 해설이 바뀌면 붉어진다
 *   [SWAP]   · 교체 칸 index ≠ 정답 index · 교체 대상이 실제로 정답과 값이 같은 칸
 *            · 교체 후 보기 **글자 전부 상이** + **수치 전부 상이**
 *              (수치 가드는 배치 1 에서 "2과 9/6 = 3.5 = 정답" 을 실제로 잡아낸 그 가드다)
 *            · 새 값이 **해설에 등장하지 않는다**(DB 단계)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 정본 DB 쓰기 규약 — 앞선 스크립트들과 동일
 *   DRY-RUN 기본 · 롤백 SQL 선기록(쓰기보존형) · expect 가드(**전문** 대조) ·
 *   UPDATE 에도 expect 재확인 · 멱등(상대 연산 없음)
 *
 * 사용법
 *   node scripts/fix-equivalent-options-20260821-b2.js              # DRY-RUN
 *   node scripts/fix-equivalent-options-20260821-b2.js --apply
 *   node scripts/fix-equivalent-options-20260821-b2.js --db <사본> --apply
 *   node scripts/fix-equivalent-options-20260821-b2.js --selftest   # 계획 검증(DB 무접촉)
 *
 *   --apply 직후 반드시: npm test
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DQUOTE = String.fromCharCode(34);
// SQL 이스케이프는 split/join 으로 한다. 정규식 리터럴 안의 따옴표는 REG-HF8 의
// 괄호 깊이 스캐너를 어긋나게 한다(2026-08-21 실측).
const SQUOTE = String.fromCharCode(39);
const sq = (s) => String(s).split(SQUOTE).join(SQUOTE + SQUOTE);

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const APPLY = process.argv.includes('--apply');
const DB_PATH = path.resolve(ROOT, argVal('--db', path.join('data', 'dacheum.db')));
const IS_CANON = path.resolve(DB_PATH) === path.resolve(ROOT, 'data', 'dacheum.db');
const OUT_DIR = path.resolve(ROOT, argVal('--out', IS_CANON
  ? path.join('보고서', '증적', '의미적중복_배치2_20260821')
  : path.join(path.dirname(DB_PATH), '증적_의미적중복b2_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 형식 요구 문구 ──────────────────────────────────────────────────────────
// 콘텐츠에 이미 쓰이는 어휘를 따른다(q215 "…을 기약분수로 쓰시오." · q8901 "…을 대분수로 나타내면?"
// · q8700 "…을 기약분수로 나타낸 것은?"). 지문의 다른 부분은 건드리지 않고 **말미에만** 덧붙인다.
const SUFFIX = {
  irreducible: ' (기약분수로 나타내시오.)',
  mixed: ' (대분수로 나타내시오.)',
};
const KEYWORD = { irreducible: '기약분수', mixed: '대분수' };

// ── 계획: FORMAT ────────────────────────────────────────────────────────────
// F(ids, kind, answer, options, questionText, evidence, why)
//   ids       같은 문항의 복제본이면 여럿(보기·정답·지문 동일)
//   evidence  해설에 **반드시 있어야 하는** 문구(공백 무시 비교). 해설이 바뀌면 가드가 붉어진다.
const FORMATS = [];
const F = (ids, kind, answer, options, questionText, evidence, why) =>
  FORMATS.push({ ids, kind, answer, options, questionText, evidence, why });

// ── ① 해설이 "약분 전 값" 을 오답으로 열거하는 문항 → 기약분수 요구 ──────────
F([6340], 'irreducible', '1', ['-6/12', '-1/2', '1/2', '6/12', '-5/12'],
  '(-2/3) × (3/4)의 계산 결과는 무엇입니까?',
  '약분하지않았을뿐같은값이므로정답은기약분수',
  '해설이 보기[0]"-6/12"를 번호(①)와 텍스트로 함께 지목하며 "약분하지 않았을 뿐" 이라 명시하고 '
  + '"정답은 기약분수 -1/2" 이라고 못 박는다. 학습 목표에 약분이 이미 들어 있으므로 지문에만 옮겨 적는다.');

F([6355], 'irreducible', '2', ['8/15', '6/20', '3/10', '10/12', '4/15'],
  '다음 계산의 결과로 알맞은 것은? (2/5 ÷ 4/3)',
  '약분하지않은중간값',
  '해설 "②는 약분하지 않은 중간 값" — ②(1-based)=보기[1]"6/20" 으로 번호가 정확히 맞는다. '
  + '작성자가 6/20 을 의도한 오답 보기로 명시했다.');

F([6375], 'irreducible', '3', ['+6/7', '+3/2', '+18/12', '-3/2', '-18/12'],
  '다음 계산의 결과로 알맞은 것은? (-2/3) × (+9/4)',
  '약분하지않은중간값',
  '해설 "③④는 약분하지 않은 중간 값" — 보기 중 약분 전 형태는 "+18/12"·"-18/12" 둘뿐이고 '
  + '해설 본문도 "18/12 = 3/2" 로 약분을 거친다. (해설의 ④ 번호는 정답 칸을 가리켜 어긋나 있으나 '
  + '이는 이 수리 이전부터 있던 별건 결함이며, 지문에 형식을 적는다고 악화되지 않는다.)');

F([8683], 'irreducible', '2', ['6/4', '18/7', '2/7', '6/21', '3/7'],
  '6/7÷3을 계산할 때 분자를 3으로 나누어 계산한 결과로 알맞은 것은?',
  '분모를3배로잘못곱한',
  '해설이 "분모를 3배로 잘못 곱한 경우" 를 오답으로 열거한다 — 보기[3]"6/21"(7×3=21)이 바로 그것이다. '
  + '지문도 "분자를 3으로 나누어 계산한 결과" 로 방법을 지정하고 있어 형식 요구와 어긋나지 않는다.');

F([8685], 'irreducible', '4', ['27/11', '6/11', '9/33', '9/8', '3/11'],
  '9/11÷3의 계산 결과로 알맞은 것은?',
  '분모에3을곱한경우',
  '해설이 "분모에 3을 곱한 경우" 를 오답으로 열거한다 — 보기[2]"9/33"(11×3=33)이 그것이다.');

F([8708], 'irreducible', '1', ['6/5', '1/6', '5/30', '25/6', '5/1'],
  '5/6÷5를 계산한 결과로 알맞은 것은?',
  '5/30은분모에5를곱한오답',
  '해설이 텍스트 "5/30" 을 직접 들어 "분모에 5를 곱한 오답" 이라 명시한다.');

F([8710], 'irreducible', '0', ['1/4', '3/12', '9/4', '1/3', '3/7'],
  '피자 3/4판을 3명이 똑같이 나눈다면 한 명의 몫은 몇 판인가?',
  '3/12는약분전값으로기약분수는1/4',
  '해설이 텍스트 "3/12" 를 직접 들어 "약분 전 값으로 기약분수는 1/4" 이라 명시한다.');

F([8719], 'irreducible', '3', ['15/2', '15/35', '7/3', '3/7', '75/7'],
  '15/7÷5를 계산한 결과로 알맞은 것은?',
  '15/35는약분전오답',
  '해설이 텍스트 "15/35" 를 직접 들어 "약분 전 오답" 이라 명시한다.');

F([8725], 'irreducible', '0', ['1/3 kg', '7/21 kg', '16/21 kg', '2와1/21 kg', '7/3 kg'],
  '밀가루 2와1/3 kg을 7명이 똑같이 나눈다면 한 명의 몫은 몇 kg인가?',
  '7/21=1/3이므로약분전표현',
  '해설이 "7/21 = 1/3 이므로 약분 전 표현" 이라고 텍스트로 명시한다.');

F([8916], 'irreducible', '1', ['32/27', '1/6', '2/3', '12/72', '27/32'],
  '4/9 ÷ 8/3의 계산 결과로 알맞은 것은?',
  '④는약분전값',
  '해설 "④는 약분 전 값" — ④(1-based)=보기[3]"12/72" 로 번호가 정확히 맞는다.');

F([8940], 'irreducible', '3', ['25/54', '45/30', '2/3', '3/2', '1'],
  '5/6 ÷ 5/9의 계산 결과로 알맞은 것은?',
  '④는약분전값',
  '해설이 "약분 전 값" 을 오답으로 열거하고 본문도 "45/30 = 3/2" 로 약분을 거쳐 끝난다. '
  + '보기 중 약분 전 형태는 "45/30" 뿐이다. (해설의 ②·④ 번호가 서로 뒤바뀌어 있으나 '
  + '①③⑤ 는 정확하고, 본문 결론이 3/2 이므로 형식 요구는 DB 정답과 일치한다.)');

F([8941], 'irreducible', '4', ['6/7', '24/35', '42/20', '20/42', '10/21'],
  '4/7 ÷ 6/5의 계산 결과로 알맞은 것은?',
  '④는약분전값',
  '해설 "④는 약분 전 값" — ④(1-based)=보기[3]"20/42" 로 번호가 정확히 맞는다.');

F([8949], 'irreducible', '4', ['4/8', '2', '49/32', '7/2', '1/2'],
  '7/8 ÷ 7/4의 계산 결과로 알맞은 것은?',
  '28/56=1/2이다',
  '해설 본문이 "7/8 × 4/7 = 28/56 = 1/2" 로 약분을 거쳐 끝나고, 남은 보기 넷을 모두 오류로 열거한다. '
  + '보기[0]"4/8" 은 7 을 약분한 뒤의 중간 형태다.');

F([8950], 'irreducible', '0', ['1/6', '6', '50/27', '3/18', '2/3'],
  '5/9 ÷ 10/3의 계산 결과로 알맞은 것은?',
  '④⑤는계산오류',
  '해설의 ①②③ 번호가 모두 정확히 맞고(①=1/6 정답 · ②=6 · ③=50/27), 남은 "④⑤는 계산 오류" 가 '
  + '보기[3]"3/18"(=15/90 의 약분 중간형)을 오답으로 지목한다.');

F([8951], 'irreducible', '1', ['16/75', '3/4', '4/3', '30/40', '2/3'],
  '2/5 ÷ 8/15의 계산 결과로 알맞은 것은?',
  '④는약분전값',
  '해설의 번호가 전부 정확하다(①=16/75 · ②=3/4 정답 · ③=4/3 · ④=30/40 "약분 전 값" · ⑤=2/3).');

// ── ② 정답 대분수 ↔ 쌍둥이 가분수 → 대분수 요구 ─────────────────────────────
// 판정: 콘텐츠의 형제 문항을 확인해 "계산 결과를 대분수로 나타내기" 가 차시 설계에
//       포함돼 있는지 봤다. 아래는 전부 형제 문항의 정답이 자연수·대분수로만 되어 있고
//       가분수는 오답 보기로만 쓰이는 콘텐츠다(근거는 why 에 문항 번호로 기록).
F([3390, 4902], 'mixed', '0', ['1과 2/10', '12/20', '12/10', '1과 1/10'],
  '4/10 + 8/10 = ?',
  '12/10=1과2/10입니다',
  '차시 "(진분수)+(진분수)의 덧셈 계산하기". 형제 q3391(3/8+5/8)이 정답 "1 L" · 오답 "8/8 L" 로 '
  + '**가분수 형태를 오답 보기로** 쓴다 — 가분수를 대분수·자연수로 고치는 것이 이 차시 설계에 포함돼 있다. '
  + '해설도 "12/10 = 1과 2/10입니다" 로 변환을 거쳐 끝난다.');

F([3708, 5220], 'mixed', '1', ['27/20', '1과 7/20', '6/9', '7/20'],
  '3/5 + 3/4 = ?',
  '27/20=1과7/20입니다',
  '차시 "받아올림이 있는 분모가 다른 진분수의 덧셈하기". 형제 q3708~q3711 의 정답이 모두 대분수이고 '
  + '가분수는 오답 보기로만 나온다. "받아올림" 자체가 결과를 대분수로 고치는 활동이다.');

F([3709, 5221], 'mixed', '3', ['1과 7/10', '11/15', '15/10', '1과 1/2'],
  '4/5 + 7/10 = ?',
  '15/10=1과1/2입니다',
  '위와 같은 차시(c3317·c3695). 해설도 "15/10 = 1과 1/2입니다" 로 변환을 거쳐 끝난다.');

F([3710, 5222], 'mixed', '0', ['1과 1/2', '7/9', '9/6', '7/6'],
  '2/3 + 5/6 = ?',
  '9/6=1과1/2입니다',
  '위와 같은 차시(c3317·c3695). 해설도 "9/6 = 1과 1/2입니다" 로 변환을 거쳐 끝난다.');

F([3862, 5318], 'mixed', '1', ['15/4', '3과 3/4', '4와 3/4', '15'],
  '5 × 3/4 = ?',
  '15/4=3과3/4입니다',
  '차시 "(자연수)×(진분수)의 계산 원리 이해하기". 형제 q3860·q3861·q3863 의 정답이 모두 '
  + '자연수(2·4·9명)로 정리돼 있고 가분수는 오답 보기로만 쓰인다.');

F([3909, 5365], 'mixed', '1', ['7/2', '3과 1/2', '3과 2/10', '3와 3/10'],
  '1과 2/5 × 2과 1/2 = ?',
  '35/10=7/2=3과1/2입니다',
  '차시 "(대분수)×(대분수) 계산하기". 형제 q3908·q3910·q3911 의 정답이 모두 자연수·대분수다. '
  + '해설도 "35/10 = 7/2 = 3과 1/2입니다" 로 대분수까지 가서 끝난다.');

F([7965], 'mixed', '4', ['10/7', '11/7', '1과 3/7', '11/14', '1과 4/7'],
  '2 - 3/7의 계산 결과로 알맞은 것은?',
  '11/7을대분수로고치지않고두면최종답이아니다',
  '해설이 "11/7을 대분수로 고치지 않고 두면 최종 답이 아니다" 라고 **명시적으로** 쌍둥이 칸을 배제한다.');

F([7966], 'mixed', '4', ['37/8', '40/8', '2와 5/8', '4와 3/8', '4와 5/8'],
  '케이크 5개 중 3/8조각을 먹었다면 남은 양을 분수로 나타내면 얼마인가?',
  '37/8을대분수로고치면4와5/8이다',
  '해설이 "37/8을 대분수로 고치면 4와5/8이다" 로 변환을 요구한다. 같은 차시(c6141·c6170)의 '
  + 'q7965·q7994 해설은 "대분수로 고치지 않고 두면 최종 답이 아니다" 라고 못 박는다.');

F([7994], 'mixed', '3', ['1과 1/5', '1과 3/5', '2와 3/5', '1과 2/5', '7/5'],
  '2 - 3/5의 계산 결과로 알맞은 것은?',
  '가분수를대분수로고치지않고7/5로두면완전한답이아니다',
  '해설이 "가분수를 대분수로 고치지 않고 7/5로 두면 완전한 답이 아니다" 라고 **명시적으로** 배제한다.');

F([7995], 'mixed', '2', ['3과 2/6', '3과 3/6', '3과 1/6', '4와 5/6', '19/6'],
  '4 - 5/6을 계산하면 얼마인가?',
  '19/6=3과1/6이다',
  '해설이 "24/6 - 5/6 = 19/6 = 3과1/6이다. 19÷6=3나머지1이므로 3과1/6이다" 로 대분수 변환을 '
  + '두 번 반복해 요구한다. 같은 차시 묶음(c6170·c6171)의 q7994 는 이를 명문으로 못 박는다.');

F([8920], 'mixed', '2', ['14/27', '63/6', '10과 1/2', '21/2', '7/6'],
  '7/3 ÷ 2/9의 계산 결과로 알맞은 것은?',
  '④는대분수로고치지않은가분수',
  '해설의 번호가 전부 정확하다(①=14/27 · ②=63/6 "약분하지 않은 중간 값" · ③=10과 1/2 정답 · '
  + '④=21/2 "대분수로 고치지 않은 가분수" · ⑤=7/6). 쌍둥이 두 칸을 모두 오답으로 명시한 문항이다.');

F([10500], 'mixed', '0', ['1과 5/12', '5/7', '5/12', '17/12'],
  '3/4 + 2/3 의 계산 중 옳은 것은?',
  '17/12=1과5/12입니다',
  '차시 "받아올림이 있는 분모가 다른 진분수의 덧셈 원리 이해하기" — c3317 과 같은 차시명이며 '
  + '그 콘텐츠의 정답은 모두 대분수다. 해설도 "17/12 = 1과 5/12입니다" 로 변환을 거쳐 끝난다.');

// ── 계획: SWAP ──────────────────────────────────────────────────────────────
// S(ids, answer, options, [[교체칸, 새값], ...], why) — 배치 1 과 동일한 형태
const SWAPS = [];
const S = (ids, answer, options, swaps, why) => SWAPS.push({ ids, answer, options, swaps, why });

S([7406], '2', ['1/2', '3/10', '5/10', '2/10', '3/5'],
  [[0, '2/5']],
  '정답 칸이 "5/10"(약분 전)이고 쌍둥이가 "1/2"(기약)이라 **지문으로는 풀 수 없다** — '
  + '"기약분수로" 를 붙이면 DB 정답이 오답이 되어 버린다. 해설도 "확률은 5/10이다(=1/2)" 로 '
  + '1/2 을 오답이라 하지 않고 오히려 동치로 승인한다. 그래서 보기 교체로 푼다. '
  + '새 값 2/5 는 초록 2개를 분자, 파랑 5개를 분모로 쓴 오류 — 기존 보기 3/5(빨강/파랑)와 같은 계열이다.');

// ── 판정 불가로 **일부러 제외** — INV-AI6 백로그에 사유와 함께 남는다 ─────────
const HOLD = [
  {
    id: 8954, content_id: 7130,
    why: '보기 ["22/3"(정답), "33/32", "11/12", "7와 1/3", "5와 1/2"] answer=0. '
       + '쌍둥이 "7와 1/3" 은 정답 22/3 의 **대분수 표기**다(둘 다 기약이라 기약분수 요구로는 구별 불가). '
       + '해설 본문이 "88/12 = 22/3 = 7과 1/3이다" 로 **두 표기를 동치로 승인**하면서, 동시에 '
       + '"④는 약분 오류" 로 같은 칸을 오답 취급한다 — 해설이 자기모순이다. '
       + '"가분수로 나타내시오" 를 붙이는 것은 초등 6학년 나눗셈 차시의 통상 요구와 반대라 '
       + '학습 목표를 바꾸는 일이고, 보기를 바꾸면 현재 정확히 맞는 ③④⑤ 번호 참조가 어긋난다. '
       + '→ 해설을 함께 재작성해야 하는 별건. 손대지 않음.',
  },
  {
    id: 12417, content_id: 10593,
    why: '보기 ["27/100", "3/11", "27/99", "27/90"] answer=2("27/99"). '
       + '🔴 이것은 중복 보기 문제가 아니라 **정답키 오류**다. 지문이 이미 "기약분수로 나타내면?" 이라 '
       + '형식을 지정하고 있고, 해설도 "x=27/99=3/11. 기약분수는 3/11이다" 로 3/11 을 정답이라 한다. '
       + '그런데 DB answer 는 27/99(약분 전) 를 가리킨다 — 지문·해설이 요구하는 3/11(index 1)을 고른 '
       + '학생이 오답 처리된다. 해소하려면 answer 를 1 로 옮겨야 하는데, 그것은 이 작업의 '
       + '"정답 칸 절대 불변" 원칙을 넘고 **기존 제출 기록의 정오답을 뒤집는다**. '
       + '→ 정답키 정정 작업(scripts/fix-answer-key-integrity-*)의 대상으로 별도 판단 필요. 손대지 않음.',
  },
];

// FORMATS·SWAPS → 문항 단위 계획
const PLAN = [];
for (const f of FORMATS) {
  for (const id of f.ids) {
    PLAN.push({
      kind: 'FORMAT', id, format: f.kind, answer: f.answer, options: f.options,
      questionText: f.questionText, evidence: f.evidence, why: f.why,
    });
  }
}
for (const s of SWAPS) {
  for (const id of s.ids) {
    PLAN.push({ kind: 'SWAP', id, answer: s.answer, options: s.options, swaps: s.swaps, why: s.why });
  }
}

// ── 값 파서 ─────────────────────────────────────────────────────────────────
// 단위가 다르면 다른 양이다(`700kg ≠ 700g`). 값 비교 전에 단위를 분리한다.
const UNITS = ['cm²', 'cm2', 'cm', 'mm', 'm²', 'm', 'kg', 'g', 'L', '판', '초', '분', '개', '원', '°', '점', '%'];
function splitUnit(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  for (const u of UNITS) if (t.endsWith(u)) return { body: t.slice(0, -u.length), unit: u };
  return { body: t, unit: '' };
}
/** 문자열 **전체**가 수치 토큰일 때만 값으로 읽는다(INV-AI6 과 같은 규칙). */
function semanticValue(s) {
  const { body } = splitUnit(s);
  let m = body.match(/^(-?\d+)[과와](\d+)\/(\d+)$/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = body.match(/^(-?\d+)\/(\d+)$/); if (m) return Number(m[1]) / Number(m[2]);
  m = body.match(/^(-?\d+(?:\.\d+)?)$/); if (m) return Number(m[1]);
  return null;
}
/**
 * 배치 1 이 쓰던 **느슨한** 파서(접두 일치). SWAP 의 수치 가드에 그대로 승계한다.
 * 🔴 글자만 비교하면 q214 부류를 또 만든다 — 배치 1 실측: 교체 후보 "2과 9/6"(=3.5)이
 *   정답 "3과 3/6"(=3.5)과 값이 같았다. 글자는 달라 중복 검사를 통과했을 것이다.
 */
function parseNumericish(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  if (t.includes(',')) return null;
  let m = t.match(/^(-?\d+)[과와](\d+)\/(\d+)/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(-?\d+)\/(\d+)/); if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(-?\d+(?:\.\d+)?)/); if (m) return Number(m[1]);
  return null;
}
const numEq = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
const gcdOf = (a, b) => (b ? gcdOf(b, a % b) : a);
function asFrac(s) { const m = splitUnit(s).body.match(/^(-?\d+)\/(\d+)$/); return m ? [Number(m[1]), Number(m[2])] : null; }
function asMixed(s) {
  const m = splitUnit(s).body.match(/^(-?\d+)[과와](\d+)\/(\d+)$/);
  return m ? { w: Number(m[1]), n: Number(m[2]), d: Number(m[3]) } : null;
}

/** 정답 보기가 요구 형식을 **만족**하는가 (형식 요구를 붙여도 정답이 정답으로 남는가). */
function satisfiesFormat(kind, text) {
  if (kind === 'irreducible') { const f = asFrac(text); return !!f && gcdOf(Math.abs(f[0]), f[1]) === 1; }
  const m = asMixed(text); return !!m && m.n < m.d;      // 대분수의 분수부는 진분수여야 한다
}
/** 쌍둥이 보기가 요구 형식을 **위반**하는가 (형식 요구를 붙이면 오답이 되는가). */
function violatesFormat(kind, text) {
  if (kind === 'irreducible') { const f = asFrac(text); return !!f && gcdOf(Math.abs(f[0]), f[1]) !== 1; }
  const f = asFrac(text); return !!f && Math.abs(f[0]) >= f[1];   // 가분수 = 대분수가 아니다
}
/** 정답과 값이 같은 다른 보기의 index 목록(단위가 다르면 다른 양이므로 제외). */
function twinsOf(options, answerIdx) {
  const ansText = options[answerIdx];
  const av = semanticValue(ansText);
  if (av === null) return [];
  const unit = splitUnit(ansText).unit;
  return options.map((o, i) => {
    if (i === answerIdx) return -1;
    if (splitUnit(o).unit !== unit) return -1;
    const v = semanticValue(o);
    return (v !== null && Math.abs(v - av) < 1e-9) ? i : -1;
  }).filter((i) => i >= 0);
}
const afterSwap = (p) => { const a = p.options.slice(); for (const [i, v] of p.swaps) a[i] = v; return a; };
const newQuestionText = (p) => p.questionText + SUFFIX[p.format];
const strip = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

// ── 계획 자체 검증 (DB 무접촉) ──────────────────────────────────────────────
function selftestPlan() {
  const problems = [];
  const seen = new Set();
  for (const p of PLAN) {
    const tag = `q${p.id}`;
    if (seen.has(p.id)) problems.push(`${tag}: 중복 항목`);
    seen.add(p.id);
    if (!p.why) problems.push(`${tag}: 근거(why)가 없다`);

    const n = Number(p.answer);
    if (!Number.isInteger(n) || n < 0 || n >= p.options.length) {
      problems.push(`${tag}: answer=${p.answer} 가 범위 밖 (보기수 ${p.options.length})`); continue;
    }

    if (p.kind === 'FORMAT') {
      if (!SUFFIX[p.format]) { problems.push(`${tag}: 알 수 없는 형식 종류 "${p.format}"`); continue; }
      if (!p.evidence) problems.push(`${tag}: 해설 근거 문구(evidence)가 없다`);
      // ① 정답 보기가 요구 형식을 만족해야 한다 — 아니면 형식 요구가 **정답을 오답으로 만든다**
      if (!satisfiesFormat(p.format, p.options[n])) {
        problems.push(`${tag}: 정답 보기 "${p.options[n]}" 가 요구 형식(${KEYWORD[p.format]})을 만족하지 않는다 — 형식 요구가 정답을 죽인다`);
      }
      // ② 정답과 값이 같은 보기가 실제로 있어야 하고(수리 대상), 그 전부가 형식을 위반해야 한다
      const tw = twinsOf(p.options, n);
      if (!tw.length) problems.push(`${tag}: 정답과 값이 같은 보기가 없다 — 수리 대상이 아니다`);
      for (const i of tw) {
        if (!violatesFormat(p.format, p.options[i])) {
          problems.push(`${tag}: 쌍둥이 보기[${i}]"${p.options[i]}" 가 요구 형식을 위반하지 않는다 — 형식 요구를 붙여도 **정답이 둘로 남는다**`);
        }
      }
      // ③ 지문에 이미 그 키워드가 있으면 붙이지 않는다(중복 문구 방지 · 멱등)
      if (p.questionText.includes(KEYWORD[p.format])) {
        problems.push(`${tag}: 지문에 이미 "${KEYWORD[p.format]}" 가 있다 — 덧붙이면 중복된다`);
      }
      if (newQuestionText(p) === p.questionText) problems.push(`${tag}: 지문이 바뀌지 않는다`);
      continue;
    }

    // SWAP — 배치 1 과 동일한 가드
    if (!p.swaps.length) problems.push(`${tag}: 교체 항목이 없다`);
    const av = parseNumericish(p.options[n]);
    for (const [i, v] of p.swaps) {
      if (i === n) problems.push(`${tag}: 교체 대상이 **정답 칸**(index ${n})이다 — 정답은 건드리지 않는다`);
      if (!(i >= 0 && i < p.options.length)) problems.push(`${tag}: 교체 index ${i} 범위 밖`);
      if (!numEq(av, parseNumericish(p.options[i]))) {
        problems.push(`${tag}: 보기[${i}]"${p.options[i]}" 는 정답 "${p.options[n]}" 와 값이 다르다 — 교체 대상이 아니다`);
      }
      if (p.options.some((o) => String(o).trim() === String(v).trim())) {
        problems.push(`${tag}: 새 값 "${v}" 가 기존 보기에 이미 있다`);
      }
    }
    const A = afterSwap(p);
    if (A.length !== p.options.length) problems.push(`${tag}: 보기 개수가 달라진다`);
    if (String(A[n]).trim() !== String(p.options[n]).trim()) problems.push(`${tag}: 정답 보기 텍스트가 바뀐다 — 금지`);
    const norm = A.map((s) => String(s).trim());
    if (new Set(norm).size !== norm.length) problems.push(`${tag}: 교체 후 글자가 같은 보기가 남는다 → ${JSON.stringify(A)}`);
    A.forEach((o, i) => {
      if (i === n) return;
      if (numEq(parseNumericish(o), av)) problems.push(`${tag}: 교체 후에도 보기[${i}]"${o}" 가 정답과 **값이 같다**(${av})`);
    });
  }
  for (const h of HOLD) if (seen.has(h.id)) problems.push(`q${h.id}: 보류 목록의 문항이 변경 계획에 들어 있다`);
  for (const h of HOLD) if (!h.why) problems.push(`q${h.id}: 보류 사유가 없다`);
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  const nF = PLAN.filter((p) => p.kind === 'FORMAT').length;
  const nS = PLAN.filter((p) => p.kind === 'SWAP').length;
  console.log(problems.length
    ? `[selftest] FAIL (${problems.length})\n - ${problems.join('\n - ')}`
    : `[selftest] PASS — FORMAT ${nF}건 · SWAP ${nS}건 · 보류 ${HOLD.length}건 (합계 ${nF + nS + HOLD.length})`);
  process.exit(problems.length ? 1 : 0);
}
const planProblems = selftestPlan();
if (planProblems.length) {
  console.error(`[중단] 계획 자체가 잘못됐습니다:\n - ${planProblems.join('\n - ')}`);
  process.exit(1);
}

// ── DB 조회 & expect 가드 ───────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(DB_PATH, { readonly: !APPLY });

/** 새 보기 값이 해설에 등장하는가(공백 제거·소문자, 2글자 이상만). */
function namedByExplanation(text, explanation) {
  const e = strip(explanation).toLowerCase();
  const t = strip(text).toLowerCase();
  return t.length >= 2 && e.includes(t);
}

const todo = [];
const already = [];
const blockers = [];
for (const p of PLAN) {
  const r = db.prepare(
    'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
  ).get(p.id);
  if (!r) { blockers.push(`q${p.id}: DB 에 없다`); continue; }

  const expectOptions = JSON.stringify(p.options);

  if (p.kind === 'FORMAT') {
    const toText = newQuestionText(p);
    if (String(r.question_text) === toText && String(r.options) === expectOptions && String(r.answer) === p.answer) {
      already.push(p.id); continue;
    }
    if (String(r.answer) !== p.answer) {
      blockers.push(`q${p.id}: answer 가 계획과 다르다 (기대 '${p.answer}' / 현재 '${r.answer}')`); continue;
    }
    if (String(r.options) !== expectOptions) {
      blockers.push(`q${p.id}: 보기가 계획과 다르다 — 이 문항은 보기를 바꾸지 않는데도 어긋났다\n      기대: ${expectOptions}\n      현재: ${r.options}`); continue;
    }
    if (String(r.question_text) !== p.questionText) {
      blockers.push(`q${p.id}: 지문이 계획과 다르다\n      기대: ${JSON.stringify(p.questionText)}\n      현재: ${JSON.stringify(r.question_text)}`); continue;
    }
    // 해설 근거 — 형식 요구의 정당성이 해설에 실제로 있어야 한다
    if (!strip(r.explanation).includes(strip(p.evidence))) {
      blockers.push(`q${p.id}: 해설에 근거 문구 "${p.evidence}" 가 없다 — 형식 요구의 근거가 사라졌다\n      해설: ${r.explanation}`); continue;
    }
    todo.push({ ...p, content_id: r.content_id, expectOptions, expectText: p.questionText, toText, explanation: r.explanation });
    continue;
  }

  // SWAP
  const toOptions = JSON.stringify(afterSwap(p));
  if (String(r.options) === toOptions && String(r.answer) === p.answer) { already.push(p.id); continue; }
  if (String(r.answer) !== p.answer) {
    blockers.push(`q${p.id}: answer 가 계획과 다르다 (기대 '${p.answer}' / 현재 '${r.answer}')`); continue;
  }
  if (String(r.options) !== expectOptions) {
    blockers.push(`q${p.id}: 보기가 계획과 다르다\n      기대: ${expectOptions}\n      현재: ${r.options}`); continue;
  }
  const bad = p.swaps.filter(([, v]) => namedByExplanation(v, r.explanation));
  if (bad.length) {
    blockers.push(`q${p.id}: 새 값 ${bad.map(([, v]) => `"${v}"`).join(', ')} 가 해설에 등장한다 — 학생이 정답으로 읽는다\n      해설: ${r.explanation}`);
    continue;
  }
  todo.push({ ...p, content_id: r.content_id, question_text: r.question_text, expectOptions, toOptions, explanation: r.explanation });
}

const nFormat = todo.filter((t) => t.kind === 'FORMAT').length;
const nSwap = todo.filter((t) => t.kind === 'SWAP').length;
console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건 → 변경 ${todo.length}(지문 ${nFormat} · 보기 ${nSwap}) · 이미 반영 ${already.length} · 차단 ${blockers.length}`);
console.log(`보류(손대지 않음): ${HOLD.map((h) => 'q' + h.id).join(', ') || '없음'}`);

if (blockers.length) {
  console.error(`\n🔴 expect 가드 위반 — **한 행도 쓰지 않고 중단합니다**:\n - ${blockers.join('\n - ')}`);
  db.close();
  process.exit(2);
}

// ── 증적: 쓰기 **전에** ─────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
function csvCell(s) {
  return DQUOTE + String(s == null ? '' : s).split(DQUOTE).join(DQUOTE + DQUOTE) + DQUOTE;
}
/** 기존 산출물을 축소된 내용으로 덮지 않는다(2026-08-07 rollback 소실 사고). */
function writePreserving(target, content, countRows) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return;
    const bak = path.join(path.dirname(target), path.basename(target).replace(
      /(\.[^.]+)$/, `.${new Date(fs.statSync(target).mtime).toISOString().replace(/[:.]/g, '-')}.bak$1`));
    fs.copyFileSync(target, bak);
    if (countRows(content) < countRows(prev)) {
      const preview = target.replace(/(\.[^.]+)$/, '.preview$1');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(`[보존] 기존 ${path.basename(target)}(${countRows(prev)}행)이 새 산출물(${countRows(content)}행)보다 많아 덮어쓰지 않았습니다.`);
      console.warn(`        기존 유지: ${target}\n        새 산출물: ${preview}`);
      return;
    }
    console.warn(`[보존] 기존 ${path.basename(target)} 을 ${path.basename(bak)} 로 백업하고 갱신합니다.`);
  }
  fs.writeFileSync(target, content, 'utf8');
}
/** 사람이 덧붙인 blockquote(>) 주석이 있으면 원본을 지킨다. 이 생성기는 `>` 줄을 만들지 않는다. */
function writePreservingAnnotations(target, content) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return;
    if (prev.split(/\r?\n/).some((l) => /^\s*>/.test(l))) {
      const preview = target.replace(/(\.[^.]+)$/, '.preview$1');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(`[보존] ${path.basename(target)} 에 손글씨 주석(> …)이 있어 덮어쓰지 않았습니다. 새 산출물: ${preview}`);
      return;
    }
  }
  fs.writeFileSync(target, content, 'utf8');
}

const stampIso = new Date().toISOString();
const rollbackPath = path.join(OUT_DIR, 'rollback.sql');
writePreserving(rollbackPath, [
  '-- 의미적 중복 정답 수리(2026-08-21 배치2) 롤백',
  '--   FORMAT 건은 question_text 만, SWAP 건은 options 만 되돌린다(answer 는 애초에 안 바꿨다)',
  `-- 생성: ${stampIso}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${todo.length}건 (지문 ${nFormat} · 보기 ${nSwap})`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...todo.map((t) => (t.kind === 'FORMAT'
    ? `UPDATE content_questions SET question_text='${sq(t.expectText)}' WHERE id=${t.id};`
    : `UPDATE content_questions SET options='${sq(t.expectOptions)}' WHERE id=${t.id};`)),
  'COMMIT;',
  '',
].join('\n'), (s) => (s.match(/WHERE id=/g) || []).length);

const changesPath = path.join(OUT_DIR, 'changes.csv');
writePreserving(changesPath, [
  ['qid', 'content_id', 'kind', 'answer_index', 'answer_text', 'before', 'after', 'why'].map(csvCell).join(','),
  ...todo.map((t) => (t.kind === 'FORMAT'
    ? [t.id, t.content_id, `FORMAT:${t.format}`, t.answer, t.options[Number(t.answer)], t.expectText, t.toText, t.why]
    : [t.id, t.content_id, 'SWAP', t.answer, t.options[Number(t.answer)], t.expectOptions, t.toOptions, t.why]
  ).map(csvCell).join(',')),
  '',
].join('\n'), (s) => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = ['# 의미적 중복 정답 수리 — 배치 2 (2026-08-21)', '',
  `- 생성: ${stampIso}`, `- 대상 DB: \`${DB_PATH}\``, `- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`,
  `- 변경 ${todo.length}건(지문 ${nFormat} · 보기 ${nSwap}) · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건 · 보류 ${HOLD.length}건`,
  '', '**정답 칸(answer 값·정답 보기 텍스트)은 한 건도 바뀌지 않았습니다.**',
  'FORMAT 건은 `question_text` 말미에 형식 요구 한 구절만 덧붙였고 **보기는 한 글자도 바꾸지 않았습니다**',
  '(해설의 번호 참조 ①②… 가 어긋나지 않도록). SWAP 건은 `options` 의 쌍둥이 칸 하나만 교체했습니다.', '',
  '## 1. 지문 형식 요구 추가 (FORMAT)', '',
  '| qid | content | 정답 idx | 정답 보기 | before | after |', '|---|---|---|---|---|---|'];
for (const t of todo.filter((x) => x.kind === 'FORMAT')) {
  md.push(`| ${t.id} | ${t.content_id} | ${t.answer} | \`${t.options[Number(t.answer)]}\` | ${String(t.expectText).replace(/\|/g, '\\|')} | ${String(t.toText).replace(/\|/g, '\\|')} |`);
}
md.push('', '## 2. 보기 교체 (SWAP)', '', '| qid | content | 정답 idx | 정답 보기 | 교체 idx | before | after |', '|---|---|---|---|---|---|---|');
for (const t of todo.filter((x) => x.kind === 'SWAP')) {
  for (const [i, v] of t.swaps) {
    md.push(`| ${t.id} | ${t.content_id} | ${t.answer} | \`${t.options[Number(t.answer)]}\` | ${i} | \`${t.options[i]}\` | \`${v}\` |`);
  }
}
md.push('', '## 3. 근거(문항군별)', '', '| qid | 형식 | 해설 근거 문구 | 근거 |', '|---|---|---|---|');
for (const f of FORMATS) md.push(`| ${f.ids.join(', ')} | ${KEYWORD[f.kind]} | \`${f.evidence}\` | ${f.why} |`);
for (const s of SWAPS) md.push(`| ${s.ids.join(', ')} | (보기 교체) | - | ${s.why} |`);
md.push('', '## 4. 보류 — 손대지 않음', '', '| qid | content | 사유 |', '|---|---|---|');
for (const h of HOLD) md.push(`| ${h.id} | ${h.content_id} | ${h.why} |`);
md.push('', `- 롤백: \`${path.relative(ROOT, rollbackPath)}\``, `- 변경 목록: \`${path.relative(ROOT, changesPath)}\``, '');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));
console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) {
    if (t.kind === 'FORMAT') {
      console.log(`  q${t.id}(c${t.content_id}) [지문/${KEYWORD[t.format]}] 정답idx=${t.answer}("${t.options[Number(t.answer)]}")`);
      console.log(`      before: ${t.expectText}`);
      console.log(`      after : ${t.toText}`);
    } else {
      for (const [i, v] of t.swaps) {
        console.log(`  q${t.id}(c${t.content_id}) [보기] 정답idx=${t.answer}("${t.options[Number(t.answer)]}") · 교체idx=${i}: "${t.options[i]}" → "${v}"`);
      }
    }
  }
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
// FORMAT 은 question_text 한 컬럼만, SWAP 은 options 한 컬럼만 쓴다.
// answer 는 두 경우 모두 WHERE 절 확인용으로만 쓰고 갱신하지 않는다.
const applyAll = db.transaction((items) => {
  const fmt = db.prepare(
    'UPDATE content_questions SET question_text = ? WHERE id = ? AND question_text = ? AND options = ? AND answer = ?'
  );
  const swp = db.prepare('UPDATE content_questions SET options = ? WHERE id = ? AND options = ? AND answer = ?');
  for (const t of items) {
    const info = t.kind === 'FORMAT'
      ? fmt.run(t.toText, t.id, t.expectText, t.expectOptions, t.answer)
      : swp.run(t.toOptions, t.id, t.expectOptions, t.answer);
    if (info.changes !== 1) throw new Error(`q${t.id}: UPDATE 가 ${info.changes}행에 적용됨(1이어야 함) — expect 불일치. 전체 롤백합니다.`);
  }
});
try { applyAll(todo); }
catch (e) { console.error(`\n🔴 적용 중단 — 전체 롤백됨: ${e.message}`); db.close(); process.exit(3); }

// ── 사후 검증 ───────────────────────────────────────────────────────────────
const bad = [];
for (const t of todo) {
  const r = db.prepare('SELECT question_text, options, answer, explanation FROM content_questions WHERE id = ?').get(t.id);
  const n = Number(t.answer);
  if (String(r.answer) !== t.answer) bad.push(`q${t.id}: answer 가 바뀌었다 (${r.answer}) — 절대 일어나선 안 되는 일`);
  const O = JSON.parse(r.options);
  if (O.length !== t.options.length) bad.push(`q${t.id}: 보기 개수가 달라졌다 (${O.length})`);
  if (String(O[n]).trim() !== String(t.options[n]).trim()) bad.push(`q${t.id}: 정답 보기 텍스트가 바뀌었다 (${O[n]})`);
  const trimmed = O.map((s) => String(s).trim());
  if (new Set(trimmed).size !== trimmed.length) bad.push(`q${t.id}: 글자가 같은 보기가 있다 → ${r.options}`);

  if (t.kind === 'FORMAT') {
    if (String(r.options) !== t.expectOptions) bad.push(`q${t.id}: 보기가 바뀌었다 — FORMAT 은 보기를 건드리지 않는다 → ${r.options}`);
    if (!String(r.question_text).includes(KEYWORD[t.format])) bad.push(`q${t.id}: 지문에 "${KEYWORD[t.format]}" 요구가 들어가지 않았다 → ${r.question_text}`);
    if (String(r.question_text) !== t.toText) bad.push(`q${t.id}: 지문이 기대와 다르다 → ${r.question_text}`);
    if (!satisfiesFormat(t.format, O[n])) bad.push(`q${t.id}: 정답 보기 "${O[n]}" 가 새 형식 요구를 만족하지 않는다 — 정답이 오답이 됐다`);
    for (const i of twinsOf(O, n)) {
      if (!violatesFormat(t.format, O[i])) bad.push(`q${t.id}: 보기[${i}]"${O[i]}" 가 정답과 값이 같은데 형식도 만족한다 — 정답이 둘이다`);
    }
    if (!strip(r.explanation).includes(strip(t.evidence))) bad.push(`q${t.id}: 해설 근거 문구가 사라졌다`);
  } else {
    const av = parseNumericish(O[n]);
    O.forEach((o, i) => {
      if (i !== n && numEq(parseNumericish(o), av)) bad.push(`q${t.id}: 적용 후에도 보기[${i}]"${o}" 가 정답과 값이 같다`);
    });
    for (const [, v] of t.swaps) {
      if (namedByExplanation(v, r.explanation)) bad.push(`q${t.id}: 새 값 "${v}" 가 해설에 등장한다`);
    }
  }
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건(지문 ${nFormat} · 보기 ${nSwap}, 정답 칸 무변동).`);
console.log(`   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
