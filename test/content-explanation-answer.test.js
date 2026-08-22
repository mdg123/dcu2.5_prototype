// test/content-explanation-answer.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 「해설이 지목하는 정답 ≠ 저장된 정답키」 부류의 **조사기**를 박제한다 (2026-08-21).
//
// 형제 파일들과의 분담:
//   · content-answer-index.test.js       — 0-based 규약(INV-AI2) · 보기 중복(INV-AI5/AI6)
//   · content-answer-key-integrity.test.js — 정답키 표기·손상 회귀(REG-AK*) · 채점 실증
//   · 이 파일                             — **지문·해설이 말하는 정답과 answer 가 어긋난** 부류
//
// 왜 별도 조사기가 필요한가:
//   INV-AI6 의 수치 파서는 `99x=27, x=3/11` 같은 서술형 보기를 **의도적으로** null 로 읽는다
//   (PARSER_CONTRACT 가 그렇게 못 박고 있고, 그것이 옳다 — 수식·목록을 값으로 읽으면 오탐이
//   쏟아진다). 그래서 이 부류는 수치 파서로는 **영원히 안 잡힌다**. 신호는 파서가 아니라
//   **해설**이다: 해설이 결론으로 어느 칸을 지목하는지 대조한다.
//
// 🔴 이 조사기의 정밀도는 100% 가 아니다 — 2026-08-21 전수 실측 **후보 450건 중 178건이 오탐**
//   (해설이 중간값을 적었거나, 오답 보기를 반박하려고 인용했거나, 지문의 숫자를 옮겼거나,
//    문자열 포함이 우연히 겹쳤거나). 확정 254건 · 보류 18건.
//   그래서 이 파일은 "후보 = 결함" 이라고 주장하지 않는다. **알려진 후보 목록을 고정**해 두고
//   **새 후보가 생기면 붉어지게** 한다. 새 후보가 뜨면 사람이 개별 판독해야 한다.
//
// ⚠ 매처를 **넓히면 후보가 는다**. 2026-08-21 에 결론부 한정 매처(후보 340)에 복합 보기 원자
//   판정을 더하자 456 으로 늘었고, 새로 뜬 116건 중 **68건이 진짜 결함**이었다(배치 2).
//   좁은 매처로 "0건" 을 확인한 것은 안전의 근거가 되지 못한다 — 넓힌 만큼 다시 전건 판독할 것.
//
// ⚠ 지난 차수의 교훈: 매처를 나중에 좁히면 단언이 **조용히 통과**한다(잠든 단언).
//   그래서 MATCHER_CONTRACT 로 매처의 입출력을 표로 못 박는다 — PARSER_CONTRACT 와 같은 장치다.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, openTestDb } = require('./_setup');

setupTestDb();
const db = openTestDb();

// ── 매처 ────────────────────────────────────────────────────────────────────
const strip = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => /[A-Za-z]/.test(c);
/**
 * 경계 인식 포함 판정.
 * 🔴 단순 includes 를 쓰면 `bigg` 가 `bigger` 안에서, `300` 이 `3000` 안에서 걸린다
 *   (2026-08-21 실측 오탐 — q149·q169). 숫자/영문 각각의 토큰 경계를 본다.
 * 🔴 한글에는 경계를 걸지 않는다. 조사·어미가 붙어 이어지는 언어라 "앞뒤가 한글이면 불일치"
 *   로 두면 **참인 지목까지 떨어진다**(해설 "…이므로몫은3,나머지는2이다" 안의 보기 "몫은 3"
 *   — q10915·q11248·q12069·q12320 이 실제로 그렇게 탈락했다).
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
    // '.' 은 **소수점일 때만** 경계로 본다. 문장 끝 마침표까지 경계로 두면 참인 지목이 떨어진다
    //   (해설 "…n≥4이다.4봉지이상" 의 보기 "4봉지" — q12345 실측).
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

/** 해설의 **결론 후보 구간**들. 중간 계산이 아니라 "무엇이 답인가" 를 말하는 자리만 본다. */
const CONCL_MARKERS = ['따라서', '그러므로', '정답은', '답은', '∴', '최종답', '최종적으로', '결국', '그래서', '즉'];
function conclusionParts(explanation) {
  const e = strip(explanation);
  if (!e) return [];
  const out = [];
  for (const m of CONCL_MARKERS) {
    const p = e.lastIndexOf(m);
    if (p >= 0) out.push(e.slice(p + m.length));
  }
  const q = e.lastIndexOf('=');                       // 수식 결론형 — 마지막 `=` 뒤
  if (q >= 0) out.push(e.slice(q + 1));
  const sents = e.split(/(?<=다\.)|(?<=요\.)|(?<=[!?])|\n/).filter(Boolean);
  if (sents.length) out.push(sents[sents.length - 1]);  // 마지막 문장
  return out.filter((s) => s.length > 0);
}

/**
 * 해설이 이 보기를 지목하는가. 'whole' | 'atoms' | null.
 * `atoms` 는 쉼표가 섞인 **복합 보기**용이다 — `99x=27, x=3/11` 처럼 원자마다 확인한다.
 * 🔴 이 경로가 없으면 q10698 부류(인계 대표 사례)가 통째로 숨는다.
 */
function namedBy(optText, text) {
  const e = strip(text), t = strip(optText);
  if (containsToken(e, t)) return 'whole';
  const atoms = t.split(',').filter((a) => a.length >= 2);
  if (atoms.length >= 2 && atoms.every((a) => containsToken(e, a) || containsToken(e, rhsOf(a)))) return 'atoms';
  return null;
}

// 지문이 부정형이면 해설이 **정답 아닌 보기들**을 나열하는 것이 정상이다 — 대상에서 뺀다.
const NEGATIVE_STEM = /아닌\s*것|않은\s*것|않는\s*것|틀린\s*것|거리가\s*먼|잘못된\s*것|옳지\s*않|맞지\s*않|아닌\s*하나|없는\s*것/;
const MIN_OPT_LEN = 3;    // 너무 짧은 보기는 결론부 일치만으로 신뢰할 수 없다

/**
 * 판정 — 해설의 결론부가 **정확히 하나의 보기**를 지목하는데 그것이 answer 가 아닌 문항.
 * (테스트와 역주입이 같은 구현을 쓴다)
 */
function findExplanationMismatch(rows) {
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r.opts) || r.opts.length < 2) continue;
    const n = Number(r.answer);
    if (!Number.isInteger(n) || n < 0 || n >= r.opts.length) continue;    // 범위 밖은 INV-AI2 담당
    if (!strip(r.explanation)) continue;
    if (NEGATIVE_STEM.test(String(r.question_text))) continue;

    const norm = r.opts.map(strip);
    const hit = new Set();
    // ① 결론부에 통째로 들어 있는 보기
    for (const seg of conclusionParts(r.explanation)) {
      norm.forEach((t, i) => { if (t.length >= MIN_OPT_LEN && containsToken(seg, t)) hit.add(i); });
    }
    // ② 복합 보기는 해설 전체를 상대로 원자 판정 (결론부만으로는 쪼개진다)
    r.opts.forEach((o, i) => { if (namedBy(o, r.explanation) === 'atoms') hit.add(i); });

    if (hit.size !== 1) continue;                     // 둘 이상이면 판단 불가 — 사람 몫
    const [i] = [...hit];
    if (i === n) continue;
    out.push({ id: r.id, content_id: r.content_id, ansIdx: n, hitIdx: i, ansText: r.opts[n], hitText: r.opts[i] });
  }
  return out;
}

function choiceRows() {
  return db.prepare(
    `SELECT id, content_id, question_text, options, answer, explanation
       FROM content_questions
      WHERE question_type IN ('choice','multiple_choice')`
  ).all().map((r) => {
    let opts = null;
    try { const j = JSON.parse(r.options); if (Array.isArray(j)) opts = j; } catch (_) {}
    return { ...r, opts };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// INV-EA1 파서/매처 계약 — 좁히면(또는 넓히면) 여기가 **먼저** 붉어진다
//   PARSER_CONTRACT 와 같은 장치다. 지난 차수에 "매처를 나중에 좁혀 단언이 조용히 통과한"
//   구멍이 실제로 있었다(INV-AI6 의 고정 단위 목록). 같은 일을 되풀이하지 않는다.
// [보기, 해설, 기대 판정]
// ══════════════════════════════════════════════════════════════════════════════
const MATCHER_CONTRACT = [
  // ── 지목으로 읽어야 하는 것 ──
  ['3000', '1 km = 1000 m이므로 3 km = 3000 m입니다.', 'whole'],
  ['10 m/s', '속력 = 거리 ÷ 시간 = 100m ÷ 10초 = 10 m/s', 'whole'],
  ['여집합', '여집합 A^c는 전체집합 U에서 A에 속하는 원소를 제거한 집합이다.', 'whole'],
  ['5km 100m', '3km+1km=4km, 600m+500m=1100m=1km100m. 합계 5km 100m', 'whole'],
  // 한글 경계를 걸면 떨어지는 것들 — 조사·어미가 붙어 이어진다
  ['몫은 3, 나머지는 2이다', '17÷5=3...2이므로 몫은 3, 나머지는 2이다.', 'whole'],
  ['원 2개, 직사각형 1개', '원기둥의 전개도는 원 2개(위·아래 밑면)와 직사각형 1개(옆면)로 이루어집니다.', 'atoms'],
  // 복합 보기 — 원자 단위로 읽어야 한다(q10698 부류. 이 경로가 죽으면 인계 사례가 숨는다)
  ['99x=27, x=3/11', '100x=27.2727…, x=0.2727…이므로 99x=27, x=27/99=3/11.', 'atoms'],
  ['면 6개, 모서리 12개, 꼭짓점 8개', '정육면체는 면 6개, 모서리 12개, 꼭짓점 8개를 가진다.', 'whole'],
  // ── 지목으로 읽으면 **안 되는** 것 (여기가 오탐 방지선) ──
  ['bigg', 'bigger의 원급은 "big"이고, 자음을 하나 더 쓰고 er을 붙입니다.', null],
  ['300', '1 km = 1000 m이므로 3 km = 3000 m입니다.', null],
  ['30000', '1 km = 1000 m이므로 3 km = 3000 m입니다.', null],
  ['99x=270, x=30/11', '100x=27.2727…, x=0.2727…이므로 99x=27, x=27/99=3/11.', null],
  ['1 m/s', '속력 = 거리 ÷ 시간 = 100m ÷ 10초 = 10 m/s', null],
  // '.' 경계 — 소수점은 막고 문장 끝 마침표는 막지 않는다
  ['4봉지', '6n ≥ 24, 양변을 양수 6으로 나누면 n ≥ 4이다. 4봉지 이상.', 'whole'],
  ['45', '반올림하면 3.45가 된다', null],
];

test('INV-EA1 매처 계약: 결론 지목은 읽고, 부분 문자열 우연 일치는 읽지 않는다', () => {
  assert.ok(MATCHER_CONTRACT.length >= 15, '계약 표가 줄었다 — 매처의 사각이 다시 열린다');
  const bad = [];
  for (const [opt, exp, want] of MATCHER_CONTRACT) {
    const got = namedBy(opt, exp);
    if (got !== want) bad.push(`${JSON.stringify(opt)} / ${JSON.stringify(exp.slice(0, 40))}… → ${got} (기대 ${want})`);
  }
  assert.deepStrictEqual(
    bad, [],
    '해설 지목 매처가 계약에서 벗어났습니다.\n' +
    '좁아지면 결함이 다시 숨고(한글 경계 4건·복합 보기 q10698), 넓어지면 오탐이 쏟아집니다:\n' + bad.join('\n')
  );
});

test('INV-EA1 결론부 추출 계약: 마지막 = 뒤는 최종값만 담는다', () => {
  // q3021 "4 × 32 = ?" — 보기에 최종값 128 과 중간값 120 이 **둘 다** 있다.
  const E = '4 × 32 = 4 × 30 + 4 × 2 = 120 + 8 = 128.';
  const parts = conclusionParts(E);
  assert.ok(parts.length > 0, '결론부를 하나도 못 뽑으면 판정 전체가 잠든다');

  // ① 마지막 `=` 뒤 구간은 최종값만 담아야 한다. 여기에 중간값이 새면 결론 신호가 무의미해진다.
  const eqTail = strip(E).slice(strip(E).lastIndexOf('=') + 1);
  assert.ok(containsToken(eqTail, '128'), '마지막 = 뒤(최종값)를 결론부로 잡아야 한다');
  assert.ok(!containsToken(eqTail, '120'), '마지막 = 뒤에 중간값이 새어 들어오면 안 된다');

  // ② 다만 "마지막 문장" 구간은 한 문장짜리 해설에서 전체와 같아 중간값도 포함한다.
  //    그래서 정밀도의 실제 장치는 결론부 한정이 아니라 **유일 일치**다 —
  //    최종값과 중간값이 둘 다 보기에 있으면 hit 이 2개가 되어 후보에서 빠진다(사람 몫).
  const rows = [{
    id: -1, content_id: -1, question_text: '4 × 32 = ?', explanation: E,
    opts: ['128', '132', '124', '120'], answer: '0',
  }];
  assert.deepStrictEqual(
    findExplanationMismatch(rows), [],
    '최종값·중간값이 둘 다 보기에 있으면 유일 일치가 깨져 후보에서 빠져야 한다(q3021 오탐 방지선)'
  );
  // 같은 해설에서 answer 만 중간값 칸으로 옮겨도 마찬가지다 — 이 판정기는 "둘 중 하나" 를 고르지 않는다.
  assert.deepStrictEqual(findExplanationMismatch([{ ...rows[0], answer: '3' }]), [], '동일');
});

// 🟡 매처 오탐 — 판독 결과 **정답키가 맞다**. 해설이 중간값을 적었거나, 오답 보기를 반박하려고
//   인용했거나, 지문의 숫자를 옮겨 적었을 뿐이다. (2026-08-21 전건 손으로 확인)
//   ⚠ 여기에 항목을 **추가**하려면 반드시 지문·보기·해설을 손으로 대조한 뒤 근거를 남길 것.
//     근거 없이 추가하면 이 목록이 결함을 덮는 뚜껑이 된다.
const KNOWN_FALSE_POSITIVES = new Set([
  84, 2847, 2860, 2944, 3434, 3436, 3576, 3610, 3649, 3782, 3783, 3854,
  3860, 4125, 4138, 4151, 4188, 4407, 4488, 4946, 4948, 5088, 5122, 5161,
  5262, 5263, 5310, 5316, 5517, 5530, 5543, 5576, 5645, 5699, 5709, 5710,
  5712, 5716, 5718, 5890, 5907, 5912, 5972, 5988, 6155, 6178, 6226, 6253,
  6335, 6339, 6346, 6361, 6371, 6372, 6391, 6392, 6399, 6404, 6410, 6482,
  6503, 6533, 6572, 6629, 6680, 6681, 6781, 6787, 6898, 6910, 6978, 6988,
  6989, 7001, 7016, 7021, 7024, 7080, 7130, 7133, 7134, 7166, 7229, 7258,
  7294, 7430, 7534, 7620, 7680, 7711, 7773, 8194, 8204, 8225, 8229, 8237,
  8279, 8287, 8457, 8474, 8507, 8518, 8519, 8526, 8534, 8564, 8599, 8771,
  8846, 8848, 8895, 8911, 8925, 8929, 8943, 8944, 8945, 8946, 8956, 8959,
  8960, 9303, 9365, 9371, 9608, 9619, 9654, 9839, 10265, 10339, 10572, 10619,
  10745, 11517, 11527, 11738, 12301, 12360, 12401,
]);

// ══════════════════════════════════════════════════════════════════════════════
// INV-EA2 — 해설이 지목하는 칸 ≠ answer 인 문항: **알려진 목록 외 신규 0건**
//   2026-08-21 전수 판독 결과 남은 것은 (a) 매처 오탐 (b) 판정 불가로 보류한 것 뿐이다.
//   목록에 없는 문항이 뜨면 **새로 생긴 것**이므로 사람이 개별 판독해야 한다.
//   🔑 이 목록은 **줄어들기만** 해야 한다. 늘리려면 판독 근거를 함께 남길 것.
// ══════════════════════════════════════════════════════════════════════════════
// 🟠 보류 13건 — 실재하는 결함이지만 **선행 조건**이 있어 손대지 않았다.
//   상세 사유·선행 조건: scripts/fix-explanation-answer-mismatch-20260821.js 의 HOLD,
//   보고서/증적/해설정답불일치_20260821/report.md §4
const HOLD_BACKLOG = new Set([
  // 배치 1 (13건)
  3645, 5157,      // "0.6을 분수로" — 보기[1]"3/5" 와 보기[3] 둘 다 정답이 된다(보기 재작성 선행)
  10015,           // "모두 고르면" 인데 참인 쌍이 둘(보기 재구성 선행)
  10072,           // y=2x-1 위의 점이 보기 셋(오답 보기 교체 선행)
  10139,           // 보기[0] 텍스트 자기모순(괄호 설명 삭제 선행)
  10207, 10210,    // 정답을 옮기면 INV-AI6 신규 위반(쌍둥이 보기 교체 선행)
  10355, 10358,    // **해설이 지문과 어긋난다**(반올림 자리) — 어느 쪽이 의도인지 확정 선행
  10809,           // **해설의 산수가 틀렸다**(1e10cm² = 1km²) — 정답으로 옮길 칸이 보기에 없다
  11394,           // 해설 자기모순 + 정의역(x≠0) 미명시
  11511,           // 해설이 38/39 사이에서 흔들림 + 지문 조건 불명
  12154,           // 해설이 "선택지에 단독 없음" 으로 문항 파탄을 자인
  // 배치 2 (5건)
  10134,           // 보기[1]·[3] 이 둘 다 "5500원"(보기[3] 은 편집 흔적)
  10201,           // 보기 넷이 모두 1/12 — 해설도 파탄을 자인
  11268,           // 해설은 "삼각자" 지목이나 "각도기"로도 90°를 그릴 수 있다 — 해설이 옳다고 단정 불가
  11514,           // 보기[0]·[1] 이 둘 다 6
  11627,           // 보기[1]"4/13" 과 보기[3]"16/52" 가 값이 같다(옮기면 INV-AI6 위반)
]);

test('INV-EA2: 해설 지목 ≠ answer 인 문항이 알려진 목록 외에 새로 없다', () => {
  const rows = choiceRows();
  assert.ok(rows.length > 5000, `객관식 로딩이 ${rows.length}건뿐이다 — 판정 전체가 잠든다`);
  const hits = findExplanationMismatch(rows);
  assert.ok(hits.length > 0, '후보가 0건이면 매처가 죽은 것이다(오탐 부류는 그대로 남아 있어야 한다)');

  const known = new Set([...KNOWN_FALSE_POSITIVES, ...HOLD_BACKLOG]);
  const fresh = hits.filter((h) => !known.has(h.id));
  assert.deepStrictEqual(
    fresh.map((h) => `q${h.id}(content ${h.content_id}) answer=${h.ansIdx}"${h.ansText}" ↔ 해설 지목=${h.hitIdx}"${h.hitText}"`), [],
    '해설이 지목하는 칸과 정답키가 어긋난 문항이 **새로** 생겼습니다.\n' +
    '🔴 그대로 고치지 마십시오 — 이 매처는 2026-08-21 실측에서 오탐 42%(340건 중 142건)였습니다.\n' +
    '   지문·보기·해설 셋을 손으로 대조해 개별 판독한 뒤, 확정된 것만 옮기십시오.\n' +
    '   정답 이동 전 제출 기록 0건 확인(REG-AK9)은 필수입니다.'
  );

  // 🔑 오탐 목록이 실재하는지 — 사라진 항목이 남아 있으면 목록이 화석이 되어 다음 결함을 가린다.
  //   (HOLD_BACKLOG 는 제외한다. 보류 4건 q10139·q10207·q10210·q11627 은 해설이 **두 칸 이상**을
  //    지목해 후보 판정을 빠져나가지만 결함으로는 실재한다 — 그 기록은 수리 스크립트의 HOLD 가 진다.)
  const seen = new Set(hits.map((h) => h.id));
  const stale = [...KNOWN_FALSE_POSITIVES].filter((id) => !seen.has(id));
  assert.deepStrictEqual(
    stale, [],
    '아래 문항은 더 이상 후보로 잡히지 않습니다(고쳐졌거나 문구가 바뀌었습니다).\n' +
    '오탐 목록에서 빼십시오 — 남겨 두면 다음 결함을 가려 줍니다: ' + stale.join(', ')
  );
});

test('INV-EA2 역주입: 정답키를 옛 칸으로 되돌리면 반드시 후보로 잡힌다', () => {
  const rows = choiceRows();
  const known = new Set([...KNOWN_FALSE_POSITIVES, ...HOLD_BACKLOG]);
  assert.deepStrictEqual(
    findExplanationMismatch(rows).filter((h) => !known.has(h.id)), [], '정본 데이터는 통과해야 한다'
  );

  // 2026-08-21 수리분 중 대표 3건을 옛 칸으로 되돌려 본다 — 판정기가 살아 있으면 전부 잡혀야 한다.
  const REVERT = [[10698, 3], [11113, 3], [10609, 0]];    // [qid, 옛 정답 index]
  const survivors = [];
  for (const [qid, staleIdx] of REVERT) {
    const victim = rows.find((r) => r.id === qid);
    assert.ok(victim, `역주입 대상 q${qid} 가 DB 에 있어야 한다`);
    assert.notStrictEqual(String(victim.answer), String(staleIdx), `q${qid}: 이미 옛 칸이다 — 수리가 되돌아갔다`);
    const injected = rows.map((r) => (r.id === qid ? { ...r, answer: String(staleIdx) } : r));
    if (!findExplanationMismatch(injected).some((h) => h.id === qid)) survivors.push(qid);
  }
  assert.deepStrictEqual(survivors, [], '정답키를 되돌렸는데 판정기가 통과시킨 문항: ' + survivors.join(', '));
});

