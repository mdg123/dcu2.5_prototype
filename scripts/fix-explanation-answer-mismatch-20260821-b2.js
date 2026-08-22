#!/usr/bin/env node
require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * 「해설이 지목하는 정답 ≠ 저장된 정답키」 부류 수리 — **배치 2** (2026-08-21)
 * 배치 1(scripts/fix-explanation-answer-mismatch-20260821.js, 186건)의 규약·가드를 그대로
 * 승계한다. 배치 1 은 이미 정본에 적용돼 계획·롤백·증적이 동결됐으므로 새 배치는 별도 파일로
 * 둔다(적용 완료된 배치의 rollback.sql 을 재생성으로 축소시키지 않기 위해서다 — 2026-08-07 사고).
 * ─────────────────────────────────────────────────────────────────────────────
 * ■ 왜 배치 2 가 생겼나 — **조사기를 넓혔더니 더 나왔다**
 *   배치 1 의 조사는 해설의 **결론부**(따라서·정답은·마지막 = 뒤·마지막 문장)만 봤다.
 *   그 뒤 복합 보기용 **원자 판정**을 해설 전체에 적용하자 후보가 340 → 456 으로 늘었고,
 *   새로 뜬 116건을 전건 판독해 **68건이 진짜 결함**이었다.
 *   대부분 해설이 정답을 **평문으로 한 번만** 적는 개념·용어 문항이라 결론부 마커가 없었다:
 *     q10913 "나눗셈에서 나누고 남은 수" 해설 "…나머지라고 한다" ↔ answer=0 "몫"
 *     q11205 "직사각형을 한 변을 축으로 회전" 해설 "…원기둥이 만들어진다" ↔ answer=0 "원뿔"
 *     q11586 "5x-3 ≤ 2x+9" 해설 "…x ≤ 4" ↔ answer=3 "x ≥ -4"
 *   👉 교훈: 매처를 넓히면 후보가 는다. **넓힌 만큼 반드시 다시 전건 판독**해야 한다.
 *     좁은 매처로 "0건" 을 확인하는 것은 안전의 근거가 되지 못한다.
 *
 * ■ 판독 결과 — 신규 후보 116건 중 **확정 68건 · 오탐 43건 · 보류 5건**
 *   오탐 부류는 배치 1 과 같다(중간값 인용·오답 보기 반박·지문 숫자 재기술).
 *   해설이 옳다고 단정하지 않았다 — 다중정답이 되는 건(q10134·q10201·q11514·q11627)과
 *   지문·해설이 갈리는 건(q11268)은 보류로 뺐다.
 *
 * ■ 원칙 (배치 1 승계)
 *   A. 🔴 **정답 이동은 제출 기록이 0 건일 때만.** 정답 index 를 옮기면 과거 제출의 정오답이
 *      **소급해서 뒤집힌다**. countSubmissions 가 매 실행마다 6 경로를 세어 강제한다(REG-AK9).
 *      (2026-08-21 실측: 대상 68건의 콘텐츠 전부 6경로 모두 0건)
 *   B. `options` 는 **한 글자도 바꾸지 않는다.** 이 배치는 `answer` 만 옮긴다.
 *      (배치 2 에는 해설 번호 정정 건이 없다 — toExplanation 은 전건 null 이다)
 *   C. 판단이 안 서면 건드리지 않는다(HOLD).
 *
 * ■ 가드 — 배치 1 과 동일
 *   expect(options 전문·현재 answer·해설 전문) · 해설의 새 정답 지목 재확인 ·
 *   이동 후 INV-AI5/AI6 신규 위반 0 · 제출 기록 0 · 사후 재조회 검증
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용법
 *   node scripts/fix-explanation-answer-mismatch-20260821-b2.js              # DRY-RUN
 *   node scripts/fix-explanation-answer-mismatch-20260821-b2.js --apply
 *   node scripts/fix-explanation-answer-mismatch-20260821-b2.js --db <사본> --apply
 *   node scripts/fix-explanation-answer-mismatch-20260821-b2.js --selftest   # 계획 검증(DB 무접촉)
 *
 *   --apply 직후 반드시: npm test
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DQUOTE = String.fromCharCode(34);
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
  ? path.join('보고서', '증적', '해설정답불일치_배치2_20260821')
  : path.join(path.dirname(DB_PATH), '증적_해설정답불일치b2_' + path.basename(DB_PATH, path.extname(DB_PATH)))));

// ── 계획 ────────────────────────────────────────────────────────────────────
// A(id, from, to, options, fromExplanation, toExplanation|null, why)
const PLAN = [];
const A = (id, from, to, options, fromExplanation, toExplanation, why) =>
  PLAN.push({ id, from, to, options, fromExplanation, toExplanation, why });

  A(9842, "0", "1",
    ["변 AB","변 EF","변 FD","변 DE"],
    "B→E, C→F이므로 변 BC에 대응하는 변은 변 EF입니다.",
    null,
    "해설이 결론으로 보기[1]\"변 EF\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"변 AB\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(9844, "1", "2",
    ["점대칭도형","합동도형","선대칭도형","비대칭도형"],
    "한 직선을 따라 접었을 때 완전히 겹쳐지는 도형을 선대칭도형이라고 합니다.",
    null,
    "해설이 결론으로 보기[2]\"선대칭도형\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"합동도형\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10025, "0", "1",
    ["충분조건","필요조건","필요충분조건","어떤 조건도 아님"],
    "p→q가 참일 때 q는 p의 필요조건이다. P={2}⊂Q={-2,2}이므로 p→q(참), q→p(거짓). 따라서 q는 p의 필요조건이다.",
    null,
    "해설이 결론으로 보기[1]\"필요조건\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"충분조건\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10032, "0", "2",
    ["p는 q의 충분조건이지만 필요조건은 아님","p는 q의 필요조건이지만 충분조건은 아님","p는 q의 필요충분조건","p와 q는 아무 관계 없음"],
    "x²-5x+6=0 ↔ (x-2)(x-3)=0 ↔ x=2 또는 x=3이다. 따라서 P=Q이고 p↔q가 성립하므로 p는 q의 필요충분조건이다.",
    null,
    "해설이 결론으로 보기[2]\"p는 q의 필요충분조건\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"p는 q의 충분조건이지만 필요조건은 아님\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10169, "3", "1",
    ["1:1","1:2","2:1","1:4"],
    "원주각의 크기가 2배이면 호의 길이도 2배이므로 비는 1:2.",
    null,
    "해설이 결론으로 보기[1]\"1:2\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"1:4\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 같은 원에서 호의 길이는 중심각(=원주각의 2배)에 비례하므로 30°:60° = 1:2 다. 해설도 '비는 1:2' 로 맺는다.");
  A(10679, "0", "1",
    ["무한소수","유한소수","순환소수","자연수"],
    "소수점 아래가 유한 개인 소수를 유한소수라 한다.",
    null,
    "해설이 결론으로 보기[1]\"유한소수\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"무한소수\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10687, "2", "3",
    ["0.27","0.32","0.45","0.36"],
    "9÷25=0.36. 분모 25=5²이므로 유한소수.",
    null,
    "해설이 결론으로 보기[3]\"0.36\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"0.45\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10689, "3", "1",
    ["0.25","0.275","0.3","0.375"],
    "11÷40=0.275. 분모 40=2³×5이므로 유한소수.",
    null,
    "해설이 결론으로 보기[1]\"0.275\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"0.375\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10712, "2", "3",
    ["63개","81개","54개","72개"],
    "9×8=72이므로 72개이다.",
    null,
    "해설이 결론으로 보기[3]\"72개\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"54개\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10780, "3", "0",
    ["꼬인 위치","수직","나란한","교차"],
    "공간에서는 두 직선이 같은 평면에 없어서 만나지도 않고 평행하지도 않은 꼬인 위치 관계가 추가된다.",
    null,
    "해설이 결론으로 보기[0]\"꼬인 위치\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"교차\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10783, "2", "0",
    ["서로 같다","합이 180°이다","차이가 90°이다","서로 다르다"],
    "두 평행선에서 한 직선이 교차할 때 동위각의 크기는 서로 같다.",
    null,
    "해설이 결론으로 보기[0]\"서로 같다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"차이가 90°이다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10787, "3", "0",
    ["합과 같다","차와 같다","합의 절반이다","두 배이다"],
    "삼각형의 한 외각의 크기는 그 외각과 이웃하지 않는 두 내각의 합과 같다.",
    null,
    "해설이 결론으로 보기[0]\"합과 같다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"두 배이다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10818, "1", "3",
    ["SSS 닮음","SAS 닮음","ASA 닮음","AA 닮음"],
    "두 각이 각각 같으면 AA 닮음 조건에 의해 두 삼각형은 닮음입니다.",
    null,
    "해설이 결론으로 보기[3]\"AA 닮음\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"SAS 닮음\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 두 각이 각각 같으면 AA 닮음이다. 현재 정답 SAS 는 두 변의 비와 끼인각 조건이다.");
  A(10819, "2", "0",
    ["SAS 닮음","SSS 닮음","AA 닮음","AAS 닮음"],
    "두 변의 비가 같고 끼인각이 같으면 SAS 닮음 조건이 성립합니다.",
    null,
    "해설이 결론으로 보기[0]\"SAS 닮음\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"AA 닮음\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 두 쌍의 대응변의 비가 같고 끼인각이 같으면 SAS 닮음이다.");
  A(10823, "1", "3",
    ["AA 닮음","SAS 닮음","닮음이 아니다","SSS 닮음"],
    "세 쌍의 대응변의 비가 모두 같으므로 SSS 닮음입니다.",
    null,
    "해설이 결론으로 보기[3]\"SSS 닮음\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"SAS 닮음\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 세 쌍의 대응변의 비가 모두 같으므로 SSS 닮음이다.");
  A(10904, "0", "2",
    ["구","원뿔","원기둥","삼각기둥"],
    "직사각형을 한 변을 축으로 회전시키면 원기둥이 만들어진다.",
    null,
    "해설이 결론으로 보기[2]\"원기둥\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"구\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(10913, "0", "1",
    ["몫","나머지","피제수","제수"],
    "나눗셈에서 나누고 남은 수를 나머지라고 한다.",
    null,
    "해설이 결론으로 보기[1]\"나머지\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"몫\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11093, "0", "2",
    ["자료의 변화 방향","자료의 색깔","종류별 수","자료를 그린 그림"],
    "표를 이용하면 종류별 수를 쉽게 알 수 있습니다.",
    null,
    "해설이 결론으로 보기[2]\"종류별 수\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"자료의 변화 방향\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11184, "1", "2",
    ["삼각기둥","원뿔","원기둥","구"],
    "두 원 밑면과 굽은 옆면으로 이루어진 기둥 모양은 원기둥이다.",
    null,
    "해설이 결론으로 보기[2]\"원기둥\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"원뿔\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11193, "3", "1",
    ["지름","반지름","높이","모선"],
    "구의 중심에서 표면까지의 거리를 반지름이라고 한다.",
    null,
    "해설이 결론으로 보기[1]\"반지름\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"모선\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11200, "2", "3",
    ["원","삼각형","사다리꼴","직사각형"],
    "원기둥의 옆면을 펼치면 직사각형 모양이 된다.",
    null,
    "해설이 결론으로 보기[3]\"직사각형\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"사다리꼴\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11205, "0", "2",
    ["원뿔이 만들어진다","구가 만들어진다","원기둥이 만들어진다","각기둥이 만들어진다"],
    "직사각형을 한 변을 축으로 돌리면 원기둥이 만들어진다.",
    null,
    "해설이 결론으로 보기[2]\"원기둥이 만들어진다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"원뿔이 만들어진다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11211, "0", "1",
    ["가, 나","나, 가","가=나 (같다)","알 수 없다"],
    "나(5cm) < 가(8cm)이므로 높이가 낮은 것부터 나, 가 순이다.",
    null,
    "해설이 결론으로 보기[1]\"나, 가\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"가, 나\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11214, "0", "1",
    ["나, 다, 가","가, 다, 나","다, 나, 가","나, 가, 다"],
    "12>9>7이므로 가, 다, 나 순이다.",
    null,
    "해설이 결론으로 보기[1]\"가, 다, 나\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"나, 다, 가\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11216, "3", "1",
    ["가, 나","나, 가","가=나","알 수 없다"],
    "가: 2×28.26+75.36=131.88, 나: 2×12.56+75.36=100.48. 나<가 이므로 나, 가 순이다.",
    null,
    "해설이 결론으로 보기[1]\"나, 가\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"알 수 없다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 가(r=3,h=4) 겉넓이 = 2×3.14×9 + 2×3.14×3×4 = 56.52+75.36 = 131.88, 나(r=2,h=6) = 25.12+75.36 = 100.48. 나<가 이므로 '나, 가' 다. 현재 정답 '알 수 없다' 는 수치가 모두 주어져 있으므로 성립하지 않는다.");
  A(11219, "1", "2",
    ["삼각형 모양이다","두 개의 원이다","원 모양 하나이다","직사각형 모양이다"],
    "원뿔의 밑면은 원 모양 하나이다.",
    null,
    "해설이 결론으로 보기[2]\"원 모양 하나이다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"두 개의 원이다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11224, "2", "3",
    ["직사각형","원","삼각형","부채꼴"],
    "원뿔의 옆면을 펼치면 부채꼴 모양이 된다.",
    null,
    "해설이 결론으로 보기[3]\"부채꼴\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"삼각형\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11226, "0", "2",
    ["모두 다르다","어떤 것은 같고 어떤 것은 다르다","모두 같다","알 수 없다"],
    "원뿔에서 모선의 길이는 모두 같다.",
    null,
    "해설이 결론으로 보기[2]\"모두 같다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"모두 다르다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11251, "1", "2",
    ["밑면 원의 지름","원기둥의 높이","밑면 원의 둘레","밑면 원의 반지름"],
    "전개도에서 옆면 직사각형의 가로 길이는 밑면 원의 둘레와 같습니다.",
    null,
    "해설이 결론으로 보기[2]\"밑면 원의 둘레\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"원기둥의 높이\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11260, "0", "2",
    ["직각삼각형","이등변삼각형","정삼각형","예각삼각형"],
    "세 변의 길이와 세 각의 크기가 모두 같은 삼각형은 정삼각형입니다.",
    null,
    "해설이 결론으로 보기[2]\"정삼각형\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"직각삼각형\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11267, "1", "2",
    ["둔각삼각형","예각삼각형","직각삼각형","이등변삼각형"],
    "90°인 각이 있으므로 직각삼각형입니다.",
    null,
    "해설이 결론으로 보기[2]\"직각삼각형\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"예각삼각형\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11312, "0", "1",
    ["가-나-다-라","다-가-라-나","나-라-가-다","라-다-가-나"],
    "5L>3L>2L>1L이므로 다-가-라-나 순서입니다.",
    null,
    "해설이 결론으로 보기[1]\"다-가-라-나\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"가-나-다-라\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11402, "2", "0",
    ["5a - 4b + 8","9a - 2b + 2","5a - 2b + 8","5a - 4b + 2"],
    "뺄셈 부호 분배: 7a-3b+5-2a-b+3. a항: 5a, b항: -4b, 상수: 8. 결과: 5a-4b+8.",
    null,
    "해설이 결론으로 보기[0]\"5a - 4b + 8\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"5a - 2b + 8\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11403, "1", "0",
    ["3x² + 3x + 2","3x² + 5x + 2","3x² + 3x - 2","2x² + 3x + 2"],
    "x²항: 3x², x항: -x+4x=3x, 상수: 3-1=2. 결과: 3x²+3x+2.",
    null,
    "해설이 결론으로 보기[0]\"3x² + 3x + 2\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"3x² + 5x + 2\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11404, "3", "1",
    ["9m - 11n - 3","3m + 3n - 3","3m - 11n + 7","3m + 3n + 7"],
    "6m-4n+2-3m+7n-5. m항: 3m, n항: 3n, 상수: -3. 결과: 3m+3n-3.",
    null,
    "해설이 결론으로 보기[1]\"3m + 3n - 3\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"3m + 3n + 7\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11405, "2", "1",
    ["5x - y + 5","5x + y - 3","5x + y + 5","3x + y - 3"],
    "x항: 5x, y항: -2y+3y=y, 상수: 1-4=-3. 결과: 5x+y-3.",
    null,
    "해설이 결론으로 보기[1]\"5x + y - 3\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"5x + y + 5\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11406, "1", "0",
    ["3p² - 4p + 8","13p² - 2p - 4","3p² - 4p - 4","3p² + 4p + 8"],
    "8p²-3p+2-5p²-p+6. p²항: 3p², p항: -4p, 상수: 8. 결과: 3p²-4p+8.",
    null,
    "해설이 결론으로 보기[0]\"3p² - 4p + 8\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"13p² - 2p - 4\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11409, "3", "0",
    ["7x² - 2x - 1","7x² - 2x + 1","3x² - 2x - 1","7x² + 2x - 1"],
    "A = (5x²+x-2)+(2x²-3x+1) = 7x²-2x-1.",
    null,
    "해설이 결론으로 보기[0]\"7x² - 2x - 1\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"7x² + 2x - 1\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. A = (5x²+x-2) + (2x²-3x+1) = 7x²-2x-1.");
  A(11411, "0", "1",
    ["4x² + 6x - 6","2x² + 6x - 6","2x² - 2x + 4","2x² + 6x + 4"],
    "A-B=(3x²+2x-1)-(x²-4x+5)=2x²+6x-6.",
    null,
    "해설이 결론으로 보기[1]\"2x² + 6x - 6\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"4x² + 6x - 6\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11415, "1", "0",
    ["5m + n + 4","5m - n + 4","3m + n + 6","5m + n + 6"],
    "(4m-2n+5)+(m+3n-1)=5m+n+4.",
    null,
    "해설이 결론으로 보기[0]\"5m + n + 4\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"5m - n + 4\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11416, "1", "2",
    ["2x² + x + 700","4x² + x + 300","2x² + 3x + 300","2x² + x + 300"],
    "(3x²+2x+500)-(x²-x+200)=2x²+3x+300.",
    null,
    "해설이 결론으로 보기[2]\"2x² + 3x + 300\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"4x² + x + 300\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11418, "3", "0",
    ["3a² + 2a + 5","a² + 4a + 5","3a² + 4a + 5","3a² + 2a - 5"],
    "(2a²+3a-10)+(a²-a+15)=3a²+2a+5.",
    null,
    "해설이 결론으로 보기[0]\"3a² + 2a + 5\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"3a² + 2a - 5\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11422, "1", "0",
    ["3x² - 2x + 1","3x² - 4x + 1","3x² - 2x + 3","7x² - 4x + 3"],
    "5x²-2x²=3x², -3x-(-x)=-2x, 2-1=1. 결과: 3x²-2x+1.",
    null,
    "해설이 결론으로 보기[0]\"3x² - 2x + 1\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"3x² - 4x + 1\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. -3x-(-x) = -2x 이므로 3x²-2x+1.");
  A(11437, "2", "0",
    ["2x + 3","3x + 3","2x - 3","3x - 3"],
    "6x²÷3x=2x, 9x÷3x=3. 결과: 2x+3.",
    null,
    "해설이 결론으로 보기[0]\"2x + 3\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"2x - 3\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11442, "2", "1",
    ["4x² + 3x - 2","4x² - 3x + 2","4x - 3x + 2","4x² - 3x - 2"],
    "16x⁴÷4x²=4x², 12x³÷4x²=3x, 8x²÷4x²=2. 결과: 4x²-3x+2.",
    null,
    "해설이 결론으로 보기[1]\"4x² - 3x + 2\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"4x - 3x + 2\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 16x⁴÷4x²=4x², 12x³÷4x²=3x, 8x²÷4x²=2 이므로 4x²-3x+2. 현재 정답 '4x - 3x + 2' 는 첫 항의 차수가 빠진 오답 보기다.");
  A(11520, "3", "0",
    ["2√5","√5","4","2"],
    "2/√5 × (√5/√5) = 2√5/5. □=2√5.",
    null,
    "해설이 결론으로 보기[0]\"2√5\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"2\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11536, "3", "1",
    ["각도기의 왼쪽 끝","각도기의 중심(중앙 표시)","각도기의 눈금 90 위치","각도기의 오른쪽 끝"],
    "각도기로 각을 잴 때 꼭짓점을 각도기의 중심(중앙 표시)에 맞춘다.",
    null,
    "해설이 결론으로 보기[1]\"각도기의 중심(중앙 표시)\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"각도기의 오른쪽 끝\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11551, "1", "2",
    ["x + 3 = 10","x + 3 < 10","x + 3 ≤ 10","x + 3 > 10"],
    "\"이하\"는 ≤ 기호를 사용. x + 3 ≤ 10.",
    null,
    "해설이 결론으로 보기[2]\"x + 3 ≤ 10\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"x + 3 < 10\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11561, "1", "2",
    ["x > 8","x < 12","x > 12","x < 8"],
    "x/3 > 4에서 양변에 3을 곱하면 x > 12.",
    null,
    "해설이 결론으로 보기[2]\"x > 12\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"x < 12\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11562, "2", "0",
    ["7봉지","6봉지","5봉지","8봉지"],
    "1200n ≤ 8400이므로 n ≤ 7. 따라서 최대 7봉지 살 수 있다.",
    null,
    "해설이 결론으로 보기[0]\"7봉지\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"5봉지\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 1200n ≤ 8400 → n ≤ 7. 최대 7봉지.");
  A(11565, "2", "0",
    ["x > 5","x < -5","x < 5","x > -5"],
    "-2x < -10에서 양변을 -2로 나누면 부등호 방향이 바뀌어 x > 5.",
    null,
    "해설이 결론으로 보기[0]\"x > 5\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"x < 5\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11581, "3", "0",
    ["x > 5","x < 5","x > -5","x < -5"],
    "양변에 10을 곱하면 3x - 5 > 10, 3x > 15, x > 5.",
    null,
    "해설이 결론으로 보기[0]\"x > 5\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"x < -5\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11584, "2", "0",
    ["x > 5","x < 5","x > 7","x < 7"],
    "3x - 4 > 11, 3x > 15, x > 5.",
    null,
    "해설이 결론으로 보기[0]\"x > 5\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"x > 7\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11586, "3", "0",
    ["x ≤ 4","x ≥ 4","x ≤ -4","x ≥ -4"],
    "5x - 2x ≤ 9 + 3, 3x ≤ 12, x ≤ 4.",
    null,
    "해설이 결론으로 보기[0]\"x ≤ 4\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"x ≥ -4\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11598, "3", "0",
    ["x ≥ 3","x > 3","x ≤ 3","x < 3"],
    "√ 안의 값이 0 이상이어야 하므로 2x - 6 ≥ 0, x ≥ 3.",
    null,
    "해설이 결론으로 보기[0]\"x ≥ 3\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"x < 3\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11610, "3", "0",
    ["각 층의 개수는 층 번호의 제곱이다","각 층의 개수는 층 번호의 2배이다","각 층의 개수는 항상 같다","각 층마다 1개씩 늘어난다"],
    "1=1², 4=2², 9=3²이므로 각 층의 개수는 층 번호의 제곱이다.",
    null,
    "해설이 결론으로 보기[0]\"각 층의 개수는 층 번호의 제곱이다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"각 층마다 1개씩 늘어난다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11621, "0", "2",
    ["직사각형","정사각형","마름모","등변사다리꼴"],
    "마름모는 네 변의 길이가 모두 같고 두 쌍의 대변이 평행한 사각형이다.",
    null,
    "해설이 결론으로 보기[2]\"마름모\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"직사각형\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11920, "3", "1",
    ["n(n+1)/2","n(n-3)/2","(n-1)(n-2)/2","n(n-1)/2"],
    "n각형의 대각선 개수 = n(n-3)/2. 각 꼭짓점에서 이웃하지 않는 (n-3)개의 꼭짓점에 대각선을 그을 수 있고, 중복을 방지해 2로 나눈다.",
    null,
    "해설이 결론으로 보기[1]\"n(n-3)/2\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"n(n-1)/2\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(11924, "1", "2",
    ["다각형의 변의 수가 많아질수록 외각의 합도 커진다","삼각형의 외각의 합은 540°이다","모든 다각형의 외각의 크기의 합은 360°이다","정다각형에서만 외각의 합이 360°이다"],
    "다각형의 종류나 변의 수에 관계없이 모든 다각형의 외각의 크기의 합은 360°이다.",
    null,
    "해설이 결론으로 보기[2]\"모든 다각형의 외각의 크기의 합은 360°이다\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"삼각형의 외각의 합은 540°이다\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 외각의 합은 변의 수와 무관하게 항상 360° 다. 현재 정답 '삼각형의 외각의 합은 540°' 는 거짓 명제다.");
  A(12070, "0", "1",
    ["삼각형","직사각형","원","마름모"],
    "원기둥을 펼치면 옆면은 직사각형이 됩니다.",
    null,
    "해설이 결론으로 보기[1]\"직사각형\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"삼각형\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(12145, "1", "3",
    ["8개","6개","10개","12개"],
    "직육면체의 모서리는 12개이므로 색 테이프는 12개 필요합니다.",
    null,
    "해설이 결론으로 보기[3]\"12개\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"6개\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(12152, "2", "1",
    ["가 < 나","가 > 나","가 = 나","비교할 수 없다"],
    "가=32÷4=8 cm, 나=20÷4=5 cm이므로 가>나입니다.",
    null,
    "해설이 결론으로 보기[1]\"가 > 나\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"가 = 나\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(12188, "3", "1",
    ["칠삼공오","칠천삼백오","칠백삼십오","칠천삼십오"],
    "7305는 칠천삼백오(7000+300+5)로 읽습니다.",
    null,
    "해설이 결론으로 보기[1]\"칠천삼백오\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"칠천삼십오\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 7305 = 7000+300+5 = 칠천삼백오.");
  A(12314, "0", "2",
    ["4송이","6송이","5송이","3송이"],
    "2+3=5이므로 5송이이다.",
    null,
    "해설이 결론으로 보기[2]\"5송이\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"4송이\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(12321, "0", "3",
    ["네 변의 길이가 모두 같은 사각형이다.","네 각이 모두 직각인 사각형이다.","두 쌍의 대변이 각각 평행한 사각형이다.","적어도 한 쌍의 대변이 평행한 사각형이다."],
    "사다리꼴은 적어도 한 쌍의 대변이 평행한 사각형이다.",
    null,
    "해설이 결론으로 보기[3]\"적어도 한 쌍의 대변이 평행한 사각형이다.\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[0]\"네 변의 길이가 모두 같은 사각형이다.\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(12325, "1", "2",
    ["기준 수를 포함하여 그보다 큰 수","기준 수를 포함하여 그보다 작은 수","기준 수를 포함하지 않고 그보다 작은 수","기준 수를 포함하지 않고 그보다 큰 수"],
    "\"미만\"은 기준 수를 포함하지 않고 그보다 작은 수를 나타낸다.",
    null,
    "해설이 결론으로 보기[2]\"기준 수를 포함하지 않고 그보다 작은 수\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[1]\"기준 수를 포함하여 그보다 작은 수\" 는 지문·해설 어느 쪽으로도 성립하지 않는다.");
  A(12345, "2", "0",
    ["4봉지","5봉지","3봉지","6봉지"],
    "6n≥24, 양변을 양수 6으로 나누면 n≥4이다. 4봉지 이상.",
    null,
    "해설이 결론으로 보기[0]\"4봉지\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[2]\"3봉지\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. 6n ≥ 24 → n ≥ 4. 최소 4봉지.");
  A(12392, "3", "1",
    ["x+y=0","x+y=±3","x+y=±√3","-3 < x+y < 3"],
    "(x+y)²=x²+2xy+y²=5+4=9. 따라서 x+y=±3. 작은 것부터: -3, 3.",
    null,
    "해설이 결론으로 보기[1]\"x+y=±3\" 를 지목하고 지문의 계산도 같은 값이다. 현재 정답 보기[3]\"-3 < x+y < 3\" 는 지문·해설 어느 쪽으로도 성립하지 않는다. (x+y)² = x²+2xy+y² = 5+4 = 9 이므로 x+y = ±3. 현재 정답 '-3 < x+y < 3' 는 등호를 부등호로 잘못 옮긴 것이다.");

// ── 판정 불가로 **일부러 제외** ─────────────────────────────────────────────
// 이 목록은 "고칠 수 없다" 가 아니라 "**무엇이 먼저 정해져야 고칠 수 있다**" 는 기록이다.
const HOLD = [
  { id: 10134, content_id: 8310, why: '택시 요금 5km. 보기[1]"5500원" 과 보기[3]"5500원 → 실제 5500원" 이 **같은 값**이라 '
    + '단일 정답이 성립하지 않는다(현재 정답은 보기[3]). 보기[3] 텍스트 자체가 편집 흔적이다. '
    + '🔑 선행 조건: 보기[3] 삭제 또는 다른 값으로 교체.' },
  { id: 10201, content_id: 8377, why: '"계산 결과가 나머지와 다른 하나는?" 인데 보기 네 개가 **모두 1/12** 로 같다. '
    + '해설도 "모두 같으므로 이 문제는 예외적으로…" 라며 스스로 파탄을 인정한다. 옮길 칸이 없다. '
    + '🔑 선행 조건: 보기 하나를 다른 값으로 교체(문항 재설계).' },
  { id: 11268, content_id: 9444, why: '"한 각이 90°가 되도록 □을 이용한다" — 해설은 보기[0]"삼각자" 를 지목하지만 '
    + '현재 정답 보기[2]"각도기" 로도 90°를 그릴 수 있어 **해설이 옳다고 단정할 수 없다**. '
    + '🔑 선행 조건: 차시 성취기준에서 어느 도구를 가르치는지 확정(지문에 "직각이 표시된 도구" 등 한정어 추가).' },
  { id: 11514, content_id: 9690, why: '√3×√12 = 6. 보기[0]"√36 = 6" 과 보기[1]"3√4 = 6 (동치 확인)" 이 **둘 다 6** 이라 '
    + '현재 정답 보기[3]"√15" 가 틀린 것은 분명하나 옮길 칸이 둘이다. 보기[1] 은 편집 흔적("동치 확인")도 남아 있다. '
    + '🔑 선행 조건: 보기[1] 삭제 또는 교체.' },
  { id: 11627, content_id: 9803, why: '하트 13 + 킹 4 - 하트킹 1 = 16장 → 16/52 = 4/13. 보기[1]"4/13" 과 보기[3]"16/52" 가 '
    + '**값이 같아** 어느 쪽으로 옮겨도 INV-AI6(의미적 중복) 신규 위반이 생긴다(현재 정답은 보기[0]"13/52"). '
    + '🔑 선행 조건: 두 쌍둥이 중 하나를 교체(의미적 중복 배치의 방식) 후 정답 이동 — 두 작업을 한 배치에서 함께.' },
];

// 🟡 정답키는 맞지만 **보기 품질**에 문제가 있어 별도 정리가 필요한 건 (이 배치의 대상 아님)
//   · q11517 "√48÷√3" — 보기[0]"4"(정답)와 보기[1]"√16 = 4" 가 같은 값
//   · q11527 "√2(√2+√8)" — 보기[0]"2 + 4 = 6" 과 보기[3]"2 + √16 = 6"(정답)이 같은 값
//   · q11097 "2km 500m" — 보기[0]·[3] 이 둘 다 "2050m"(정답 칸과는 무관)
//   INV-AI6 의 수치 파서가 `=` 를 포함한 문자열을 값으로 읽지 않아 탐지되지 않는다(그것이 옳다).

// ── 판정기 (테스트와 같은 규칙, 독립 구현) ──────────────────────────────────
const strip = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => /[A-Za-z]/.test(c);
/**
 * 경계 인식 포함 판정. 단순 includes 를 쓰면 `bigg` 가 `bigger` 안에서 걸리고
 * `300` 이 `3000` 안에서 걸린다(2026-08-21 실측 오탐).
 *
 * 🔴 한글에는 경계 규칙을 걸지 않는다. 조사·어미가 붙어 이어지는 언어라 "앞뒤가 한글이면 불일치"
 *   로 두면 **참인 지목까지 떨어뜨린다** — 실측: 해설 "…이므로몫은3,나머지는2이다" 안의
 *   보기 "몫은 3"(앞 글자가 '로')이 탈락했다(q10915·q11248·q12069·q12320).
 *   한글 쪽 오탐은 경계가 아니라 **최소 길이 + 결론부 한정 + 유일 일치**로 막는다.
 */
function containsToken(hay, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const p = hay.indexOf(needle, from);
    if (p < 0) return false;
    const before = p > 0 ? hay[p - 1] : '';
    const after = p + needle.length < hay.length ? hay[p + needle.length] : '';
    const s0 = needle[0], s1 = needle[needle.length - 1];
    let ok = true;
    // '.' 은 **소수점일 때만** 경계로 본다. 문장 끝 마침표 뒤의 수치까지 막으면
    //   참인 지목이 떨어진다(해설 "…n≥4이다.4봉지이상" 의 보기 "4봉지" — q12345 실측).
    const prev2 = p > 1 ? hay[p - 2] : '';
    if (isDigit(s0) && (isDigit(before) || (before === '.' && isDigit(prev2)) || before === '/')) ok = false;
    if (isAlpha(s0) && isAlpha(before)) ok = false;
    if (isDigit(s1) && (isDigit(after) || after === '/')) ok = false;
    if (isAlpha(s1) && (isAlpha(after) || isDigit(after))) ok = false;
    if (ok) return true;
    from = p + 1;
  }
}
const rhsOf = (atom) => { const i = atom.lastIndexOf('='); return i >= 0 ? atom.slice(i + 1) : atom; };
/** 해설이 이 보기를 지목하는가. 'whole'(통째로) | 'atoms'(복합 보기 원자 전부) | null. */
function namedByExplanation(optText, explanation) {
  const e = strip(explanation), t = strip(optText);
  if (containsToken(e, t)) return 'whole';
  const atoms = t.split(',').filter((a) => a.length >= 2);
  if (atoms.length >= 2 && atoms.every((a) => containsToken(e, a) || containsToken(e, rhsOf(a)))) return 'atoms';
  return null;
}
// INV-AI5/AI6 과 같은 규칙(테스트와 독립 구현 — 같은 버그를 공유하지 않기 위해서다)
const UNIT_TAIL_REJECT = /[\d/.,:=~×÷+\-*^()[\]{}<>]/;
const NUM_TOKEN = /^([-+]?\d+(?:[과와]\d+\/\d+|\/\d+|\.\d+)?)(.*)$/;
function splitUnit(s) {
  const m = strip(s).match(NUM_TOKEN);
  if (!m) return null;
  if (UNIT_TAIL_REJECT.test(m[2])) return null;
  return { body: m[1], unit: m[2] };
}
const unitOf = (s) => { const p = splitUnit(s); return p ? p.unit : null; };
function semanticValue(s) {
  const p = splitUnit(s);
  if (!p) return null;
  let m = p.body.match(/^([-+]?\d+)[과와](\d+)\/(\d+)$/); if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = p.body.match(/^([-+]?\d+)\/(\d+)$/); if (m) return Number(m[1]) / Number(m[2]);
  m = p.body.match(/^([-+]?\d+(?:\.\d+)?)$/); if (m) return Number(m[1]);
  return null;
}
const asMixed = (s) => { const p = splitUnit(s); if (!p) return null; const m = p.body.match(/^([-+]?\d+)[과와](\d+)\/(\d+)$/); return m ? { n: Number(m[2]), d: Number(m[3]) } : null; };
/** 정답 칸과 값이 같은 다른 보기 index 목록(단위가 다르면 다른 양). */
function valueTwins(opts, ansIdx) {
  const ansText = opts[ansIdx];
  const av = semanticValue(ansText);
  if (av === null) return [];
  const unit = unitOf(ansText);
  return opts.map((o, i) => {
    if (i === ansIdx) return -1;
    if (unitOf(o) !== unit) return -1;
    const v = semanticValue(o);
    if (v === null || Math.abs(v - av) >= 1e-9) return -1;
    const a = asMixed(ansText), b = asMixed(o);
    if (a && b && a.n < a.d && b.n >= b.d) return -1;
    return i;
  }).filter((i) => i >= 0);
}

// ── 계획 자체 검증 (DB 무접촉) ──────────────────────────────────────────────
function selftestPlan() {
  const problems = [];
  const seen = new Set();
  for (const p of PLAN) {
    const tag = `q${p.id}`;
    if (seen.has(p.id)) problems.push(`${tag}: 중복 항목`);
    seen.add(p.id);
    if (!p.why) problems.push(`${tag}: 근거(why)가 없다`);

    const from = Number(p.from), to = Number(p.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) { problems.push(`${tag}: from/to 가 정수가 아니다`); continue; }
    if (from === to) { problems.push(`${tag}: 정답이 이동하지 않는다`); continue; }
    if (!(to >= 0 && to < p.options.length)) { problems.push(`${tag}: 새 정답 index ${to} 범위 밖`); continue; }
    if (!(from >= 0 && from < p.options.length)) { problems.push(`${tag}: 옛 정답 index ${from} 범위 밖`); continue; }

    // 해설이 새 정답을 지목한다 — 이동 방향의 독립 근거
    if (!namedByExplanation(p.options[to], p.fromExplanation)) {
      problems.push(`${tag}: 해설이 새 정답 "${p.options[to]}" 를 지목하지 않는다 — 이동 근거가 없다`);
    }
    // 이동 후 글자 중복(INV-AI5) 0 — INV-AI5 와 같은 범위로 **정답 칸과** 비교한다.
    //   (정답이 아닌 칸끼리의 중복은 INV-AI5 의 대상이 아니다. q11097 이 "2050m" 을 두 번 갖고
    //    있으나 정답 칸과는 무관하다 — 별도 백로그로 보고한다.)
    const dupOfAnswer = p.options
      .map((o, i) => (i !== to && String(o).trim() === String(p.options[to]).trim() ? i : -1))
      .filter((i) => i >= 0);
    if (dupOfAnswer.length) problems.push(`${tag}: 새 정답과 글자가 같은 보기 [${dupOfAnswer}] 가 있다 → ${JSON.stringify(p.options)}`);
    // 이동 후 값 중복(INV-AI6) 0
    const tw = valueTwins(p.options, to);
    if (tw.length) problems.push(`${tag}: 이동하면 새 정답 "${p.options[to]}" 와 값이 같은 보기 ${JSON.stringify(tw.map((i) => p.options[i]))} 가 생긴다`);

    // 해설 수정은 **보기 번호만** 허용한다. 숫자·기호를 지운 나머지가 같아야 한다.
    if (p.toExplanation !== null) {
      const numless = (s) => strip(s).replace(/[①②③④⑤]/g, '#').replace(/정답은\d+번/g, '정답은#번');
      if (numless(p.fromExplanation) !== numless(p.toExplanation)) {
        problems.push(`${tag}: 해설이 보기 번호 외의 부분까지 바뀐다 — 번호만 바로잡는다`);
      }
      if (p.fromExplanation === p.toExplanation) problems.push(`${tag}: 해설이 바뀌지 않는다`);
    }
  }
  for (const h of HOLD) {
    if (seen.has(h.id)) problems.push(`q${h.id}: 보류 목록의 문항이 변경 계획에 들어 있다`);
    if (!h.why) problems.push(`q${h.id}: 보류 사유가 없다`);
    if (!/🔑 선행 조건|같은 사유로 보류/.test(h.why)) problems.push(`q${h.id}: 보류에 **선행 조건**이 적혀 있지 않다 — 다음 사람이 무엇부터 해야 할지 모른다`);
  }
  if (!PLAN.length) problems.push('계획이 비어 있다');
  return problems;
}

if (process.argv.includes('--selftest')) {
  const problems = selftestPlan();
  console.log(problems.length
    ? `[selftest] FAIL (${problems.length})\n - ${problems.join('\n - ')}`
    : `[selftest] PASS — 정답이동 ${PLAN.length}건(해설 번호 정정 ${PLAN.filter((p) => p.toExplanation !== null).length}건 포함) · 보류 ${HOLD.length}건`);
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

/**
 * 🔴 정답 이동의 전제 — 이 문항/콘텐츠에 걸린 **제출 기록 수**.
 *
 * 정답 index 를 옮기면 과거 제출의 정오답이 **소급해서 뒤집힌다**. 기록이 하나도 없을 때만
 * 그 위험이 성립하지 않는다. 그래서 "이번엔 괜찮겠지" 가 아니라 매 실행마다 기계가 센다.
 * 테이블이 늘어나면 여기에 추가할 것 — 빠뜨리면 가드가 조용히 약해진다. (REG-AK9 가 소스를 잠근다)
 */
function countSubmissions(handle, contentId, questionId) {
  const rows = [];
  const one = (label, sql, ...args) => {
    try { rows.push({ label, n: handle.prepare(sql).get(...args).n }); }
    catch (e) { rows.push({ label, n: -1, err: e.message }); }     // 테이블이 없으면 -1 → 가드가 막는다
  };
  one('content_attempts', 'SELECT COUNT(*) n FROM content_attempts WHERE content_id = ?', contentId);
  one('problem_attempts', 'SELECT COUNT(*) n FROM problem_attempts WHERE content_id = ?', contentId);
  one('diagnosis_answers', 'SELECT COUNT(*) n FROM diagnosis_answers WHERE content_id = ?', contentId);
  one('wrong_answers', 'SELECT COUNT(*) n FROM wrong_answers WHERE content_id = ?', contentId);
  // answers 는 JSON 이라 questionId 가 본문에 박혀 있다 — 콘텐츠 경로를 우회한 기록까지 센다.
  one('content_attempts.answers', "SELECT COUNT(*) n FROM content_attempts WHERE answers LIKE '%' || ? || '%'", String(questionId));
  one('problem_set_attempts.answers', "SELECT COUNT(*) n FROM problem_set_attempts WHERE answers LIKE '%' || ? || '%'", String(questionId));
  return rows;
}

const todo = [];
const already = [];
const blockers = [];
for (const p of PLAN) {
  const r = db.prepare(
    'SELECT id, content_id, question_text, options, answer, explanation FROM content_questions WHERE id = ?'
  ).get(p.id);
  if (!r) { blockers.push(`q${p.id}: DB 에 없다`); continue; }
  // 🔴 보기 비교는 **파싱한 배열끼리** 한다. 저장된 JSON 의 공백 표기가 행마다 달라
  //   (`["a","b"]` vs `["a", "b"]` — q9614 실측) 문자열 비교는 내용이 같아도 어긋난다.
  //   대신 UPDATE 의 WHERE 에는 **DB 에서 읽은 원문 바이트**를 그대로 넣어 원자성을 지킨다.
  const expectOptions = String(r.options);            // WHERE 절용 원문
  const wantExplanation = p.toExplanation === null ? p.fromExplanation : p.toExplanation;
  let curOptions;
  try { curOptions = JSON.parse(r.options); }
  catch (e) { blockers.push(`q${p.id}: options JSON 파싱 실패 — ${e.message}`); continue; }
  const optionsSame = Array.isArray(curOptions)
    && curOptions.length === p.options.length
    && curOptions.every((o, i) => String(o) === String(p.options[i]));

  if (String(r.answer) === p.to && String(r.explanation) === wantExplanation && optionsSame) {
    already.push(p.id); continue;
  }
  if (String(r.answer) !== p.from) {
    blockers.push(`q${p.id}: answer 가 계획과 다르다 (기대 '${p.from}' / 현재 '${r.answer}')`); continue;
  }
  if (!optionsSame) {
    blockers.push(`q${p.id}: 보기가 계획과 다르다 — 이 배치는 보기를 바꾸지 않는데도 어긋났다\n      기대: ${JSON.stringify(p.options)}\n      현재: ${r.options}`); continue;
  }
  if (String(r.explanation) !== p.fromExplanation) {
    blockers.push(`q${p.id}: 해설이 계획과 다르다\n      기대: ${JSON.stringify(p.fromExplanation)}\n      현재: ${JSON.stringify(r.explanation)}`); continue;
  }
  if (!namedByExplanation(p.options[Number(p.to)], r.explanation)) {
    blockers.push(`q${p.id}: 해설이 새 정답 "${p.options[Number(p.to)]}" 를 언급하지 않는다 — 이동 근거가 없다`); continue;
  }
  // 🔴 제출 기록 0 건 — 하나라도 있으면 멈춘다
  const subs = countSubmissions(db, r.content_id, p.id);
  const nonZero = subs.filter((s) => s.n !== 0);
  if (nonZero.length) {
    blockers.push(
      `q${p.id}: 🔴 제출 기록이 있습니다 — 정답을 옮기면 과거 제출의 정오답이 뒤집힙니다. 보류하십시오.\n` +
      nonZero.map((s) => `        ${s.label} = ${s.n}${s.err ? ` (${s.err})` : ''}`).join('\n')
    );
    continue;
  }
  todo.push({ ...p, content_id: r.content_id, question_text: r.question_text, expectOptions, wantExplanation, subs });
}

const nExpl = todo.filter((t) => t.toExplanation !== null).length;
console.log(`대상 DB   : ${DB_PATH}${IS_CANON ? '  (정본)' : '  (사본)'}`);
console.log(`모드      : ${APPLY ? '🔴 APPLY (쓰기)' : 'DRY-RUN (읽기 전용)'}`);
console.log(`계획 ${PLAN.length}건 → 변경 ${todo.length}(해설 번호 정정 동반 ${nExpl}) · 이미 반영 ${already.length} · 차단 ${blockers.length}`);
console.log(`보류(손대지 않음): ${HOLD.map((h) => 'q' + h.id).join(', ') || '없음'}`);
{
  const allZero = todo.every((t) => t.subs.every((s) => s.n === 0));
  console.log(`제출 기록 확인: 대상 ${todo.length}건 × 6경로 = ${todo.length * 6}회 조회 → ${allZero ? '전부 0, 뒤집힐 기록 없음' : '🔴 0 이 아닌 항목 있음'}`);
}

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
  '-- 해설↔정답키 불일치 수리(2026-08-21 배치2) 롤백',
  '--   answer 를 되돌린다. 해설 번호를 정정한 2건은 explanation 도 함께 되돌린다.',
  `-- 생성: ${stampIso}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${todo.length}건`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...todo.map((t) => (t.toExplanation !== null
    ? `UPDATE content_questions SET answer='${sq(t.from)}', explanation='${sq(t.fromExplanation)}' WHERE id=${t.id};`
    : `UPDATE content_questions SET answer='${sq(t.from)}' WHERE id=${t.id};`)),
  'COMMIT;',
  '',
].join('\n'), (s) => (s.match(/WHERE id=/g) || []).length);

const changesPath = path.join(OUT_DIR, 'changes.csv');
writePreserving(changesPath, [
  ['qid', 'content_id', 'question_text', 'options', 'answer_before', 'answer_after',
   'answer_text_before', 'answer_text_after', 'explanation_before', 'explanation_after', 'why'].map(csvCell).join(','),
  ...todo.map((t) => [
    t.id, t.content_id, t.question_text, JSON.stringify(t.options), t.from, t.to,
    t.options[Number(t.from)], t.options[Number(t.to)],
    t.fromExplanation, t.toExplanation === null ? '(무변동)' : t.toExplanation, t.why,
  ].map(csvCell).join(',')),
  '',
].join('\n'), (s) => Math.max(0, s.split('\n').filter(Boolean).length - 1));

const md = ['# 해설↔정답키 불일치 수리 — 배치 2 (2026-08-21)', '',
  `- 생성: ${stampIso}`, `- 대상 DB: \`${DB_PATH}\``, `- 모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기 전용)'}`,
  `- 변경 ${todo.length}건 · 이미 반영 ${already.length}건 · 차단 ${blockers.length}건 · 보류 ${HOLD.length}건`,
  '',
  '지문과 해설이 한목소리로 어느 칸을 정답이라고 말하는데 `answer` 는 다른 칸을 가리키던 문항들입니다.',
  '`options` 는 **한 글자도 바꾸지 않았습니다.** 해설은 보기 번호 참조가 실제 보기와 어긋난 2건만',
  '**번호만** 바로잡았습니다(q12417 선례).',
  '',
  '정답 index 를 옮기면 과거 제출의 정오답이 소급해서 뒤집히므로, 모든 대상에 대해 6개 경로의',
  '제출 기록이 0 건임을 스크립트 가드(`countSubmissions`)로 확인한 뒤에만 적용했습니다.', '',
  '## 1. 정답키 이동', '',
  '| qid | content | answer | 정답 보기 | 지문 |', '|---|---|---|---|---|'];
for (const t of todo) {
  const qt = String(t.question_text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  md.push(`| ${t.id} | ${t.content_id} | \`${t.from}\` → \`${t.to}\` | \`${t.options[Number(t.from)]}\` → \`${t.options[Number(t.to)]}\` | ${qt.length > 70 ? qt.slice(0, 70) + '…' : qt} |`);
}
md.push('', '## 2. 해설 보기 번호 정정 (번호만)', '', '| qid | before | after |', '|---|---|---|');
for (const t of todo.filter((x) => x.toExplanation !== null)) {
  md.push(`| ${t.id} | \`${t.fromExplanation}\` | \`${t.toExplanation}\` |`);
}
md.push('', '## 3. 근거(문항별)', '', '| qid | 판독 근거 |', '|---|---|');
for (const t of todo) md.push(`| ${t.id} | ${String(t.why).replace(/\|/g, '\\|')} |`);
md.push('', '## 4. 보류 — 손대지 않음', '', '| qid | content | 사유와 선행 조건 |', '|---|---|---|');
for (const h of HOLD) md.push(`| ${h.id} | ${h.content_id} | ${String(h.why).replace(/\|/g, '\\|')} |`);
md.push('', `- 롤백: \`${path.relative(ROOT, rollbackPath)}\``, `- 변경 목록: \`${path.relative(ROOT, changesPath)}\``, '');
writePreservingAnnotations(path.join(OUT_DIR, 'report.md'), md.join('\n'));
console.log(`증적: ${OUT_DIR}`);

if (!APPLY) {
  console.log('\nDRY-RUN 입니다. 반영하려면 --apply 를 붙이세요.');
  for (const t of todo) {
    console.log(`  q${t.id}(c${t.content_id}) answer ${t.from}("${t.options[Number(t.from)]}") → ${t.to}("${t.options[Number(t.to)]}")`);
    if (t.toExplanation !== null) {
      console.log(`      해설 before: ${t.fromExplanation}`);
      console.log(`      해설 after : ${t.toExplanation}`);
    }
  }
  db.close();
  process.exit(0);
}

// ── 적용 ────────────────────────────────────────────────────────────────────
const applyAll = db.transaction((items) => {
  const onlyAns = db.prepare(
    'UPDATE content_questions SET answer = ? WHERE id = ? AND answer = ? AND explanation = ? AND options = ?'
  );
  const ansExpl = db.prepare(
    'UPDATE content_questions SET answer = ?, explanation = ? WHERE id = ? AND answer = ? AND explanation = ? AND options = ?'
  );
  for (const t of items) {
    const info = t.toExplanation !== null
      ? ansExpl.run(t.to, t.toExplanation, t.id, t.from, t.fromExplanation, t.expectOptions)
      : onlyAns.run(t.to, t.id, t.from, t.fromExplanation, t.expectOptions);
    if (info.changes !== 1) throw new Error(`q${t.id}: UPDATE 가 ${info.changes}행에 적용됨(1이어야 함) — expect 불일치. 전체 롤백합니다.`);
  }
});
try { applyAll(todo); }
catch (e) { console.error(`\n🔴 적용 중단 — 전체 롤백됨: ${e.message}`); db.close(); process.exit(3); }

// ── 사후 검증 ───────────────────────────────────────────────────────────────
const bad = [];
for (const t of todo) {
  const r = db.prepare('SELECT question_text, options, answer, explanation FROM content_questions WHERE id = ?').get(t.id);
  const O = JSON.parse(r.options);
  if (!(O.length === t.options.length && O.every((o, i) => String(o) === String(t.options[i])))) {
    bad.push(`q${t.id}: 보기가 바뀌었다 — 이 배치는 보기를 건드리지 않는다 → ${r.options}`);
  }
  if (String(r.answer) !== t.to) bad.push(`q${t.id}: answer 가 '${r.answer}' — 기대 '${t.to}'`);
  if (String(r.explanation) !== t.wantExplanation) bad.push(`q${t.id}: 해설이 기대와 다르다 → ${r.explanation}`);
  if (!namedByExplanation(O[Number(t.to)], r.explanation)) bad.push(`q${t.id}: 적용 후 해설이 새 정답 "${O[Number(t.to)]}" 를 지목하지 않는다`);
  const dupOfAnswer = O.map((o, i) => (i !== Number(t.to) && String(o).trim() === String(O[Number(t.to)]).trim() ? i : -1)).filter((i) => i >= 0);
  if (dupOfAnswer.length) bad.push(`q${t.id}: 새 정답과 글자가 같은 보기 [${dupOfAnswer}] 가 있다 → ${r.options}`);
  const tw = valueTwins(O, Number(t.to));
  if (tw.length) bad.push(`q${t.id}: 새 정답과 값이 같은 보기 ${JSON.stringify(tw.map((i) => O[i]))} 가 있다`);
}
db.close();
if (bad.length) {
  console.error(`\n🔴 사후 검증 실패:\n - ${bad.join('\n - ')}\n   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
  process.exit(4);
}
console.log(`\n✅ 적용 완료 — ${todo.length}건(해설 번호 정정 동반 ${nExpl}건).`);
console.log(`   롤백: sqlite3 "${DB_PATH}" < "${rollbackPath}"`);
console.log('   👉 지금 바로 `npm test` 를 전건 실행하십시오(하네스 표식 해소).');
