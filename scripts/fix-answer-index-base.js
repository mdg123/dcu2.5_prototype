require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * scripts/fix-answer-index-base.js
 *
 * content_questions.answer 인덱스 기준(0-based) 정합 스크립트.
 *
 * ── 배경 ────────────────────────────────────────────────────────────────
 * 정본 규약은 **0-based(보기 배열 인덱스)** 이다.
 *   - 학생 채점기 public/content/content-player.html : `String(선택idx) === String(q.answer)`
 *     · 정답 표시도 `q.options[q.answer]` → 0-based 전제.
 *   - db/self-learn-extended.js `_resolveCorrectIndex()` : 0-based 범위 안이면 그대로 0-based로 해석
 *     (규칙2가 규칙3보다 먼저) → 결국 0-based 전제.
 * 그런데 일부 콘텐츠가 1-based 로 저장돼 있어 학생이 맞게 골라도 오답 처리된다.
 *
 * ── 판정 규칙 (우선순위) ─────────────────────────────────────────────────
 *  (1) 구조 반증 : 콘텐츠 안에 answer === 0 인 문항이 하나라도 있으면 → 0-based 확정. 변환 금지.
 *  (2) 구조 증거 : answer === options.length 인 문항 (0-based 로는 불가능).
 *  (3) 해설 증거 : explanation 안에 보기 텍스트가 "정확히 하나만" 등장할 때 그 보기를 정답으로 보고
 *                  0-based / 1-based 중 어느 쪽과 맞는지 판정. (보조 신호)
 *  (4) 양쪽 증거가 섞인 콘텐츠(CONFLICT)는 손대지 않고 목록으로 남긴다.
 *
 * ── ⚠ 실측으로 밝혀진 중대 사실 (2026-08-07) ────────────────────────────
 * 구조 증거(answer === options.length) 37건을 사람이 전수 확인한 결과,
 * **35건은 1-based 저장이 아니라 그냥 "정답키 손상"** 이었다.
 *   예) content 102 : opts ["12cm³","20cm³","60cm³","35cm³"], answer=4, 해설 "…= 60cm³"
 *       → 1-based 로 읽으면 "35cm³" 로 **여전히 오답**. 올바른 0-based 정답은 2.
 *   예) content 238~383 (30건, 동일 템플릿) : opts[3]="올바른 적용", answer=5, 해설 "4번이 정답"
 *       → answer-1=4 는 "해당 없음". 올바른 0-based 정답은 3.
 * 즉 이들에 `answer -= 1` 을 적용하면 **"그럴듯하지만 틀린 정답키"** 가 되어
 * 지금(아무도 못 맞힘)보다 **더 나빠진다**(엉뚱한 보기가 정답으로 인정됨).
 * → 그래서 이 스크립트는 **구조 증거만 있는 콘텐츠를 변환하지 않는다.**
 *    변환 대상은 "해설 증거로 1-based 가 확인된 콘텐츠"로 한정한다(STRUCT_ONLY 는 별도 보고).
 *
 * ── 사용법 ──────────────────────────────────────────────────────────────
 *   node scripts/fix-answer-index-base.js                 # 분석만(읽기전용) + 리포트 산출
 *   node scripts/fix-answer-index-base.js --db <경로>      # 대상 DB 지정(사본 검증용)
 *                                                         # ↑ 증적도 사본 옆에 쓰인다(정본 증적 무오염)
 *   node scripts/fix-answer-index-base.js --db <사본> --apply
 *                                                         # 실제 UPDATE (rollback.sql 선기록 필수)
 *   옵션:
 *     --tier=explain|struct|both  변환 대상 등급 (기본 explain)
 *     --out <디렉터리>            리포트 출력 위치
 *     --quiet                     콘솔 요약 축약
 *
 * ⚠ --apply 는 PM 승인 후에만. 기본값은 읽기전용 분석이다.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');

// ── 인자 파싱 ──────────────────────────────────────────────────────────
function argVal(name, def) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const pre = process.argv.find(a => a.startsWith(name + '='));
  if (pre) return pre.slice(name.length + 1);
  return def;
}
const APPLY = process.argv.includes('--apply');
const QUIET = process.argv.includes('--quiet');
const TIER = String(argVal('--tier', 'explain')).toLowerCase(); // explain | struct | both
const DB_PATH = path.resolve(ROOT, argVal('--db', path.join('data', 'dacheum.db')));

/**
 * 증적 출력 폴더는 **--db 를 따라간다**.
 *
 * 🔴 2026-08-07 사고의 근본 원인: OUT_DIR 기본값이 `--db` 와 무관하게 늘 정본 증적 폴더였다.
 *   그래서 **사본을 대상으로 한 검증 실행**이 정본 증적(report.md)을 덮어썼고,
 *   "대상 0건 / 과거 제출 영향 0건" 이라는 **사실과 다른 리포트**가 남았다
 *   (같은 폴더의 changes.csv 는 162행이고 실제 재채점 대상도 1건 있었다).
 *   → 정본(data/dacheum.db) 대상 실행만 정본 증적 폴더에 쓰고,
 *     사본 대상 실행은 **사본 옆**(<사본 폴더>/증적_<사본이름>)에 쓴다.
 *     `--out` 을 주면 언제나 그 값이 우선한다.
 */
const CANON_DB = path.resolve(ROOT, 'data', 'dacheum.db');
const IS_CANON_DB = path.resolve(DB_PATH) === CANON_DB;
const OUT_DIR = path.resolve(
  ROOT,
  argVal('--out', IS_CANON_DB
    ? path.join('보고서', '증적', '정답인덱스_정합_20260807')
    : path.join(path.dirname(DB_PATH), '증적_' + path.basename(DB_PATH, path.extname(DB_PATH))))
);

if (!['explain', 'struct', 'both'].includes(TIER)) {
  console.error(`[중단] --tier 값이 올바르지 않습니다: ${TIER} (explain|struct|both)`);
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`[중단] DB 를 찾을 수 없습니다: ${DB_PATH}`);
  process.exit(1);
}

// ── 헬퍼 ───────────────────────────────────────────────────────────────
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
const CIRCLED_POS = {};
CIRCLED.split('').forEach((c, i) => { CIRCLED_POS[c] = i + 1; });

// ⚠ 아래 두 정규식은 **정규식 리터럴로 쓰지 않는다**.
//   문자 클래스 안의 닫는 괄호(`[.)]`)를 test/harness-freshness.test.js 의 REG-HF8 스캐너가
//   진짜 괄호로 세어 중괄호 깊이가 어긋난다 → 함수 안의 write 를 "최상위 write" 로 오판한다.
//   문자열로 만들면 스캐너가 따옴표 구간을 통째로 건너뛰므로 오판이 사라진다.
const RE_NUM_LABEL_CAPTURE = new RegExp('^(\\d+)[.)]\\s+');  // "1. " / "1) " — 뒤 공백 필수(소수 "4.3" 보호)
const RE_NUM_LABEL_STRIP = new RegExp('^\\d+[.)]\\s+');

/**
 * 보기 배열 전체의 "머리 번호 체계"를 감지한다.
 *
 * ⚠ 개별 보기마다 정규식으로 숫자 prefix 를 떼면 **소수를 망가뜨린다**
 *   (실측: "4.3" → "3", "4.13" → "13" 으로 잘려 해설 대조가 통째로 틀어짐).
 *   그래서 "모든 보기가 1..N 순서로 번호를 달고 있을 때"만 체계로 인정하고 제거한다.
 *
 * @returns {'circled'|'numeric'|'none'}
 */
function detectLabelScheme(opts) {
  const s = opts.map(o => String(o == null ? '' : o).trim());
  if (s.every((t, i) => CIRCLED_POS[t[0]] === i + 1)) return 'circled';
  // "1. ", "1) " — 구분자 뒤 공백을 요구해 소수("4.3")와 구분한다.
  if (s.every((t, i) => {
    const m = t.match(RE_NUM_LABEL_CAPTURE);
    return m && Number(m[1]) === i + 1;
  })) return 'numeric';
  return 'none';
}

/** 감지된 체계에 한해 머리 번호 제거 */
function stripLabel(t, scheme) {
  const s = String(t == null ? '' : t).trim();
  if (scheme === 'circled') return s.slice(1).trim();
  if (scheme === 'numeric') return s.replace(RE_NUM_LABEL_STRIP, '').trim();
  return s;
}

/** options(JSON 문자열) → 배열. 실패 시 null */
function parseOptions(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

/**
 * answer 를 정수로. "0.0" 같은 실수 문자열도 흡수하되, 원형이 정수 문자열이 아니면 flag.
 * @returns {{n:number|null, exactInt:boolean}}
 */
function parseAnswerInt(raw) {
  if (raw == null) return { n: null, exactInt: false };
  const s = String(raw).trim();
  if (s === '') return { n: null, exactInt: false };
  const exactInt = /^-?\d+$/.test(s);
  const num = Number(s);
  if (!Number.isFinite(num) || !Number.isInteger(num)) return { n: null, exactInt: false };
  return { n: num, exactInt };
}

/**
 * 해설이 **정답 위치를 명시**하면 그 값을 뽑는다 — "정답은 ③", "정답은 3번", "4번이 정답입니다".
 * 반환값은 1-based 위치(P). 정답의 0-based index 는 P-1.
 * 서로 다른 위치를 여러 번 주장하면 신뢰 불가로 null.
 * @returns {number|null}
 */
function statedPosition(ex) {
  const found = new Set();
  const push = p => { if (p >= 1 && p <= 10) found.add(p); };
  for (const m of ex.matchAll(/정답[은는이가]?\s*[:：]?\s*([①②③④⑤⑥⑦⑧⑨⑩])/g)) push(CIRCLED_POS[m[1]]);
  for (const m of ex.matchAll(/정답[은는이가]?\s*[:：]?\s*(\d+)\s*번/g)) push(Number(m[1]));
  for (const m of ex.matchAll(/([①②③④⑤⑥⑦⑧⑨⑩])\s*(?:번)?\s*이?\s*정답/g)) push(CIRCLED_POS[m[1]]);
  for (const m of ex.matchAll(/(\d+)\s*번\s*이?\s*정답/g)) push(Number(m[1]));
  return found.size === 1 ? [...found][0] : null;
}

/** 해설에 보기 위치를 가리키는 표지(①~⑩ 또는 "N번")가 있는가 */
function hasPositionMarker(ex) {
  return /[①②③④⑤⑥⑦⑧⑨⑩]/.test(ex) || /\d+\s*번/.test(ex);
}

/** 보기 텍스트가 수치형인가 ("12", "-2.5", "3/4", "1,000") */
function isNumericLike(t) {
  return /^[-+]?[\d.,/]+$/.test(t);
}

const RE_ESC = /[.*+?^${}()|[\]\\]/g;

/**
 * 해설 안에 보기 텍스트가 **독립된 토큰**으로 등장하는가.
 *
 * ⚠ 단순 substring 은 수치에서 치명적 오탐을 만든다(실측):
 *   · "49" 가 "1249" 안에 들어 있어 매칭 → 오답 보기를 정답으로 오판 (c8518)
 *   · "3"  이 "30" 안에 들어 있어 매칭 → 1-based 로 오판 (c9188)
 *   · "16" 이 피연산자로 등장 (c205 "√16의 값은?" 해설 "4²=16")
 * 그래서 수치형 보기는 앞뒤가 숫자(또는 소수점)로 이어지지 않을 때만 매칭으로 인정한다.
 * 한글이 섞인 보기("2개","90도")는 조사가 붙으므로 그대로 부분문자열 매칭한다.
 */
function occursAsToken(hay, needle) {
  if (!needle) return false;
  if (!isNumericLike(needle)) return hay.includes(needle);
  const re = new RegExp(`(?<![\\d.])${needle.replace(RE_ESC, '\\$&')}(?!\\d)`);
  return re.test(hay);
}

/**
 * 해설 증거 산출.
 * explanation 안에 보기 텍스트가 "정확히 하나만" 등장하면 그 보기를 정답으로 간주.
 *
 * 오탐 방지 (실측으로 필요성이 확인된 것만):
 *   ① 다른 보기의 부분문자열인 보기는 제외 — 예: "5" ⊂ "15", "않" ⊂ "않은"
 *   ② **문두(question_text/instruction/passage)에 이미 등장하는 보기는 제외**
 *      실측 반례: Q240 "√16의 값은?" opts ["①2","②4","③8","④16"] 해설 "4²=16"
 *      → "16" 은 정답이 아니라 **피연산자**인데 유일 매칭이 되어 1-based 로 오판했다.
 *        문두에 있는 값을 제외하면 "4"만 남아 올바르게 판정된다.
 *   ③ 길이 필터는 두지 않는다 — 1자 보기(예: "D","P","B","G")가 결정적 반증인
 *      경우가 있다(실측: c177 q172 "b의 대문자는 B" → 0-based 반증).
 *
 * @returns {'0based'|'1based'|'ambiguous'|'none'|'mismatch'}
 */
/**
 * 부정형·예외형 발문인가 — "잘못된 것은?", "옳지 않은 것은?", "나머지와 다른 하나는?"
 *
 * ⚠ 이 유형은 해설이 **정답 보기가 아니라 "올바른 사실"** 을 서술하므로
 *   텍스트 대조가 구조적으로 반대 방향을 가리킨다(실측):
 *     c7438 "지름을 구하는 식으로 잘못된 것은?" 해설 "지름 = 원주 ÷ 원주율이 맞는 식이다"
 *     → 해설이 가리키는 건 **오답 보기**다. 판정 불가로 보류한다.
 */
function isNegationStem(stem) {
  return /(잘못된|옳지\s*않은|알맞지\s*않은|적절하지\s*않은|틀린|아닌\s*것|아닌\s*하나|다른\s*하나|해당하지\s*않|관계\s*없는|될\s*수\s*없)/.test(stem);
}

function explanationSignal(opts, n, explanation, stemText) {
  const ex = String(explanation == null ? '' : explanation);
  if (!ex.trim()) return 'none';
  if (isNegationStem(String(stemText == null ? '' : stemText))) return 'ambiguous';

  // ── 신호 ⓐ 위치 명시 ("정답은 ③", "3번이 정답") ────────────────────────
  let posSig = 'none';
  const P = statedPosition(ex);
  if (P != null) posSig = (n === P - 1) ? '0based' : (n === P) ? '1based' : 'mismatch';

  // ── 신호 ⓑ 보기 텍스트 대조 ──────────────────────────────────────────
  let textSig = 'none';
  {
    const scheme = detectLabelScheme(opts);
    const texts = opts.map(o => stripLabel(o, scheme));
    const hits = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t) continue;
      // 문자형 보기가 **다른 보기의 부분문자열이고 그 긴 보기도 해설에 나오면** 제외.
      //   ("않" ⊂ "않은" 이고 해설에 "않은" 이 있으면 "않" 의 매칭은 그 일부일 뿐)
      // ⚠ 긴 보기가 해설에 없으면 짧은 보기의 매칭은 진짜다 — 무조건 제외하면 오탐이 난다(실측):
      //   c7243 opts ["1시간 50분","1시간 60분","2시간","2시간 15분"] 해설 "…=1시간 60분=2시간입니다"
      //   → "2시간" 을 "2시간 15분" 의 부분문자열이라고 버리면 오답 "1시간 60분" 만 남아 오판했다.
      if (!isNumericLike(t) && texts.some((o, j) => j !== i && o.includes(t) && ex.includes(o))) continue;
      if (occursAsToken(ex, t)) hits.push(i);
    }
    if (hits.length === 1) {
      const h = hits[0];
      textSig = (h === n) ? '0based' : (h === n - 1) ? '1based' : 'mismatch';
    } else if (hits.length > 1) textSig = 'ambiguous';
  }

  // ── 두 신호를 **교차 검증**한다 ───────────────────────────────────────
  // 각각 단독으로는 실측 반례가 있다:
  //   · 위치 신호 단독 오판 — c4226 "정답은 ① -2 < x < 3이다" 인데 보기 배열이 섞여 있어
  //     실제 "-2 < x < 3" 은 index 1. 라벨(①)이 **낡은 값**이었다(현재 0-based 저장이 정답).
  //   · 텍스트 신호 단독 오판 — c4575 "정답은 6이다. … ①180은 최소공배수이다"
  //     에서 정답 "6" 이 다른 보기 "36" 의 부분문자열이라 제외되고, **오답** "180" 만 매칭됐다.
  // 그래서 두 신호가 **일치할 때만** 증거로 채택하고, 어긋나면 판정을 보류한다.
  if (posSig !== 'none' && textSig !== 'none') {
    if (posSig === textSig) return posSig;
    return 'ambiguous';                 // 두 신호 불일치 → 신뢰 불가, 손대지 않음
  }
  if (posSig !== 'none') {
    // 위치 신호만 있음. 해설이 보기 번호를 논하는 유형이므로 1-based 주장은 채택하지 않는다
    // (오답 해설의 라벨이 섞여 들어올 수 있다). 0-based/손상 판정은 반증으로만 쓴다.
    return posSig === '1based' ? 'ambiguous' : posSig;
  }
  if (textSig !== 'none') {
    // 텍스트 신호만 있음. 해설에 보기 번호 표지가 섞여 있으면 오답 해설 가능성이 커서 보류.
    if (hasPositionMarker(ex) && textSig === '1based') return 'ambiguous';
    return textSig;
  }
  return 'none';
}

// ── 데이터 적재 ────────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma('busy_timeout = 5000');

const rows = db
  .prepare(
    `SELECT id, content_id, question_number, question_type, question_text,
            instruction, passage, options, answer, explanation
       FROM content_questions
      WHERE question_type IN ('choice','multiple_choice')
      ORDER BY content_id, question_number, id`
  )
  .all();

/** @type {Map<number, Array>} */
const byContent = new Map();
const stats = {
  totalTyped: rows.length,
  parsable: 0,
  excluded: [],          // 파싱 불가 / 보기<2 / answer 비정수
  floatAnswer: [],       // answer 가 "0.0" 같은 실수 문자열 → 채점기 문자열 비교에서 영구 오답
  ansZero: 0,
  ansEqLen: 0,
  outOfRange: [],
  exp0: 0, exp1: 0, expAmb: 0, expNone: 0, expMismatch: 0,
};

for (const r of rows) {
  const opts = parseOptions(r.options);
  const { n, exactInt } = parseAnswerInt(r.answer);
  const item = { ...r, opts, n, exactInt, sig: 'none', usable: false };

  if (!opts || opts.length < 2) {
    stats.excluded.push({ id: r.id, content_id: r.content_id, why: !opts ? 'options 파싱불가' : `보기 ${opts.length}개`, answer: r.answer });
  } else if (n == null) {
    stats.excluded.push({ id: r.id, content_id: r.content_id, why: `answer 비정수(${JSON.stringify(r.answer)})`, answer: r.answer });
  } else {
    item.usable = true;
    stats.parsable++;
    if (!exactInt) stats.floatAnswer.push({ id: r.id, content_id: r.content_id, answer: r.answer, len: opts.length });
    if (n === 0) stats.ansZero++;
    if (n === opts.length) stats.ansEqLen++;
    if (n < 0 || n > opts.length) stats.outOfRange.push({ id: r.id, content_id: r.content_id, answer: r.answer, len: opts.length });
    const stem = [r.question_text, r.instruction, r.passage].filter(Boolean).join(' ');
    item.sig = explanationSignal(opts, n, r.explanation, stem);
    if (item.sig === '0based') stats.exp0++;
    else if (item.sig === '1based') stats.exp1++;
    else if (item.sig === 'ambiguous') stats.expAmb++;
    else if (item.sig === 'mismatch') stats.expMismatch++;
    else stats.expNone++;
  }

  if (!byContent.has(r.content_id)) byContent.set(r.content_id, []);
  byContent.get(r.content_id).push(item);
}

// ── 콘텐츠 단위 판정 ───────────────────────────────────────────────────
/**
 * verdict:
 *   ZERO_VETO          answer===0 존재 → 0-based 확정. 절대 변환 금지.
 *   CONFLICT           1-based 증거 + 반증(0-based/정답키손상)이 섞임 → 손대지 않음.
 *   ONE_EXPLAIN        해설로 1-based 확인, 반증 0 → **변환 대상**
 *   ONE_STRUCT_ONLY    구조 증거만(answer===len), 해설 증거 없음 → 변환 안 함(정답키 손상 의심)
 *   NO_EVIDENCE        증거 없음 → 손대지 않음
 *
 * ⚠ 반증(counter-evidence)에는 `mismatch`(해설이 어느 해석과도 안 맞음)도 포함한다.
 *   mismatch 가 있는 콘텐츠는 "인덱스 기준 문제"가 아니라 "정답키 자체가 깨진" 콘텐츠일
 *   가능성이 높아, 일괄 -1 이 오히려 그럴듯한 오답키를 만든다.
 */
const verdicts = new Map();
for (const [cid, qs] of byContent) {
  const u = qs.filter(q => q.usable);
  const zero = u.filter(q => q.n === 0);
  const struct1 = u.filter(q => q.n === q.opts.length);
  const e1 = u.filter(q => q.sig === '1based');
  const e0 = u.filter(q => q.sig === '0based');
  const mism = u.filter(q => q.sig === 'mismatch');

  const counterEvidence = zero.length > 0 || e0.length > 0 || mism.length > 0;
  const evidence1 = e1.length > 0 || struct1.length > 0;

  let verdict;
  if (counterEvidence && evidence1) verdict = 'CONFLICT';
  else if (zero.length > 0) verdict = 'ZERO_VETO';
  else if (e1.length > 0) verdict = 'ONE_EXPLAIN';
  else if (struct1.length > 0) verdict = 'ONE_STRUCT_ONLY';
  else verdict = 'NO_EVIDENCE';

  verdicts.set(cid, {
    cid, verdict,
    total: u.length,
    zero: zero.length, struct1: struct1.length,
    e1: e1.length, e0: e0.length, mismatch: mism.length,
    counterEvidence, evidence1,
    coverage: u.length ? +(e1.length / u.length).toFixed(3) : 0,
    qs: u,
  });
}

// ── 변환 대상 산출 ─────────────────────────────────────────────────────
const wantVerdicts =
  TIER === 'explain' ? ['ONE_EXPLAIN']
  : TIER === 'struct' ? ['ONE_STRUCT_ONLY']
  : ['ONE_EXPLAIN', 'ONE_STRUCT_ONLY'];

const targetContents = [...verdicts.values()]
  .filter(v => wantVerdicts.includes(v.verdict))
  .sort((a, b) => a.cid - b.cid);

/**
 * 사람이 전수 확인해 **자동 판정이 틀렸다고 확인된** 문항 — 휴리스틱보다 우선한다.
 * (2026-08-07 Backend 개발자가 변환 대상 162건 전수 육안 검증한 결과)
 */
const MANUAL_EXCLUDE = new Map([
  [10103, '보기 ["같거나 작은","같거나 큰","같은","작은"] / 정답은 "같거나 큰"(idx1). ' +
          '해설의 "크거나 같은" 중 "같은" 조각만 매칭돼 1-based 로 오판. 변환해도 오답 → 정답키 재작성 필요'],
  [10339, '보기 ["4, 5, 3, 4","5, 4, 4, 4","4, 4, 4, 5","5, 4, 4, 3"] / 현재 answer=2 → "4, 4, 4, 5" 로 **이미 정답**. ' +
          '해설 말미 "큰 순서: 5, 4, 4, 4"(재정렬 서술)에 매칭돼 오판. 변환하면 멀쩡한 문항이 오답 처리됨'],
  [229,   '보기 ["①2","②3","③4","④5"] / 2x+3=11 → x=4 이므로 정답은 "③4"(idx2). ' +
          '0-based·1-based 어느 쪽도 아닌 정답키 손상. 같은 콘텐츠(c197)의 q230 은 정상 변환 대상이라 이 행만 제외'],
]);

/**
 * 자동 판정은 보류했지만 **사람이 1-based 임을 확정한** 문항 — 명시적으로 편입한다.
 *
 * 이 셋은 해설에 보기 값이 여러 개 등장하거나(모호) 해설이 너무 짧아 자동 신호가 서지 않았을 뿐,
 * 육안으로는 반박의 여지가 없다. 휴리스틱을 느슨하게 풀면 오탐이 같이 들어오므로
 * **개별 id 로만** 편입한다(감사 가능).
 *
 * ⚠ 콘텐츠 단위 일관성 확인 완료 — c85 는 객관식이 q69 하나뿐이고,
 *   c196 은 q227·q228 둘 다 여기에 있어 **콘텐츠 전체가 함께 변환**된다(부분 변환 아님).
 *
 * 🔴 **멱등성 필수** — `expect`(변환 전 answer)를 반드시 함께 적는다.
 *   자동 판정분은 변환 후 해설 신호가 '0based' 로 뒤집혀 재실행해도 다시 잡히지 않지만,
 *   수동 편입분은 증거 검사를 우회하므로 **아무 가드가 없으면 재실행마다 -1 이 누적된다.**
 *   (2026-08-07 실측 사고: --apply 를 두 번 돌려 q69·q227·q228 이 2회 차감됐다.
 *    q227 은 answer=0 까지 내려가 "①-5" 를 정답으로 만들 뻔했다.)
 *   현재 값이 `expect` 와 다르면 **건너뛰고 보고**한다.
 */
const MANUAL_INCLUDE = new Map([
  [69,  { expect: 4, reason: 'c85 보기 ["1/3","2/5","3/8","1/2"] answer=4 → idx3 "1/2". 해설 "1/2가 가장 큽니다" 와 일치. ' +
                             '0-based 로는 범위 밖이라 현재 아무도 정답 처리 불가' }],
  [227, { expect: 2, reason: 'c196 보기 ["①-5","②-1","③1","④5"] answer=2 → idx1 "②-1". 해설 "-3+2=-1" 과 일치' }],
  [228, { expect: 4, reason: 'c196 보기 ["①0","②-5","③3/4","④√2"] answer=4 → idx3 "④√2". 해설 "√2는 무리수" 와 일치. ' +
                             '같은 콘텐츠 q227 과 기준이 일관(둘 다 1-based)' }],
]);

/** 실제로 변경되는 행이 속한 **서로 다른 콘텐츠 수** (수동 편입분 포함). */
function changedContentCount() {
  return new Set(changes.map(c => c.content_id)).size;
}

const changes = [];   // 실제 변환할 행
const skipped = [];   // 안전 가드에 걸려 건너뛴 행

/** 변환 대상 후보를 모은다 — 자동 판정 콘텐츠 전 문항 + 수동 편입 문항. */
const candidates = [];
for (const v of targetContents) for (const q of v.qs) candidates.push({ q, verdict: v.verdict });
const manualSkipped = [];
for (const v of verdicts.values()) {
  for (const q of v.qs) {
    const mi = MANUAL_INCLUDE.get(q.id);
    if (!mi) continue;
    if (candidates.some(c => c.q.id === q.id)) continue;   // 이미 자동으로 잡혔으면 중복 편입 안 함
    // 🔴 멱등 가드 — 현재 answer 가 편입 당시 기록한 값과 같을 때만 변환한다.
    //    이미 변환됐거나(재실행) 다른 작업이 값을 바꿨으면 절대 손대지 않는다.
    if (q.n !== mi.expect) {
      manualSkipped.push(
        `q${q.id}(content ${q.content_id}) 기대 answer=${mi.expect} 인데 현재 ${q.n} → 편입 건너뜀` +
        (q.n === mi.expect - 1 ? ' (이미 변환 완료된 것으로 보임 — 정상)' : ' ⚠ 예상 밖 값 — 확인 필요')
      );
      continue;
    }
    candidates.push({ q, verdict: 'MANUAL_INCLUDE' });
  }
}
candidates.sort((a, b) => (a.q.content_id - b.q.content_id) || (a.q.id - b.q.id));

for (const { q, verdict } of candidates) {
  const len = q.opts.length;
  if (MANUAL_EXCLUDE.has(q.id)) {
    skipped.push({ id: q.id, content_id: q.content_id, reason: '수동 제외 — ' + MANUAL_EXCLUDE.get(q.id), answer: q.answer, len });
    continue;
  }
  // 안전 가드 ①: 변환 전 1 <= answer <= len 이어야 한다
  if (!(q.n >= 1 && q.n <= len)) {
    skipped.push({ id: q.id, content_id: q.content_id, reason: `변환전 범위밖 answer=${q.answer} len=${len}`, answer: q.answer, len });
    continue;
  }
  const next = q.n - 1;
  // 안전 가드 ②: 변환 후 0 <= answer <= len-1
  if (!(next >= 0 && next <= len - 1)) {
    skipped.push({ id: q.id, content_id: q.content_id, reason: `변환후 범위밖 ${next} (len=${len})`, answer: q.answer, len });
    continue;
  }
  changes.push({
    id: q.id,
    content_id: q.content_id,
    question_number: q.question_number,
    question_text: q.question_text,
    options: q.opts,
    before: String(q.answer),
    after: String(next),
    beforeText: q.opts[q.n] === undefined ? '(범위밖)' : String(q.opts[q.n]),
    afterText: String(q.opts[next]),
    signal: q.sig,
    verdict,
  });
}

// ── 리포트 출력 ────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// CSV 셀 이스케이프.
// ⚠ 정규식 리터럴 안에 **맨 큰따옴표를 쓰지 않는다**(`/"/g` 금지).
//   test/harness-freshness.test.js REG-HF8 의 소스 스캐너는 정규식 리터럴을 모르므로
//   그 따옴표를 "문자열 시작"으로 보고 이후 수백 줄을 통째로 건너뛴다 → 괄호 깊이가 어긋나
//   함수 안의 write 를 "가드 앞 최상위 write" 로 오판한다(실측).
//   split/join 은 따옴표가 문자열 리터럴 안에만 있어 스캐너가 정상 처리한다.
const DQUOTE = String.fromCharCode(34);
function csvCell(s) {
  const t = String(s == null ? '' : s).split(DQUOTE).join(DQUOTE + DQUOTE);
  return DQUOTE + t + DQUOTE;
}

// (1) rollback.sql — 되돌리기용. 변환 대상 전 행의 **현재값**을 그대로 기록.
const rollbackLines = [
  '-- 정답 인덱스 기준(0-based) 정합 롤백 스크립트',
  `-- 생성: ${new Date().toISOString()}`,
  `-- 대상 DB: ${DB_PATH}`,
  `-- 대상 행: ${changes.length}건 (content ${changedContentCount()}개, tier=${TIER})`,
  '-- 사용법: sqlite3 data/dacheum.db < rollback.sql',
  '--         적용 직후 반드시: node scripts/harness-stamp.js mark --script rollback.sql && npm test',
  'BEGIN TRANSACTION;',
  ...changes.map(c => `UPDATE content_questions SET answer='${String(c.before).replace(/'/g, "''")}' WHERE id=${c.id};`),
  'COMMIT;',
  '',
];
const rollbackPath = path.join(OUT_DIR, 'rollback.sql');

/**
 * 롤백 파일을 덮어쓰기 전에 **기존 파일을 반드시 보존**한다.
 *
 * 🔴 2026-08-07 실측 사고: --apply 로 162행을 반영한 뒤 **분석 모드로 재실행**했더니
 *   변환 대상이 0건이 되어 rollback.sql 이 "0건짜리 빈 파일" 로 덮여, 되돌릴 수단이 사라졌다.
 *   (드라이런 사본의 산출물이 남아 있어 복구했지만, 없었으면 영구 손실이었다)
 *   분석 모드는 언제든 재실행되므로 "쓰기 전 보존" 이 유일하게 안전한 규칙이다.
 */
function writePreservingRollback(target, content) {
  if (fs.existsSync(target)) {
    const prev = fs.readFileSync(target, 'utf8');
    if (prev === content) return;                              // 동일하면 그대로 둔다
    const prevRows = (prev.match(/WHERE id=/g) || []).length;
    const nextRows = (content.match(/WHERE id=/g) || []).length;
    const bak = path.join(
      path.dirname(target),
      `rollback.${new Date(fs.statSync(target).mtime).toISOString().replace(/[:.]/g, '-')}.bak.sql`
    );
    fs.copyFileSync(target, bak);
    if (nextRows < prevRows) {
      // 되돌릴 대상이 줄었다 = 이미 적용된 뒤의 재실행일 가능성이 높다. 원본을 지키고 새 것은 옆에 쓴다.
      const preview = path.join(path.dirname(target), 'rollback.preview.sql');
      fs.writeFileSync(preview, content, 'utf8');
      console.warn(
        `[보존] 기존 rollback.sql(${prevRows}행)이 새 산출물(${nextRows}행)보다 많아 덮어쓰지 않았습니다.\n` +
        `        기존 파일 유지: ${target}\n        새 산출물: ${preview}`
      );
      return;
    }
    console.warn(`[보존] 기존 rollback.sql 을 ${path.basename(bak)} 로 백업하고 갱신합니다.`);
  }
  fs.writeFileSync(target, content, 'utf8');
}
writePreservingRollback(rollbackPath, rollbackLines.join('\n'));

// (2) changes.csv — 변경 목록
const csvHead = ['question_id', 'content_id', 'question_number', 'answer_before', 'answer_after', 'before_option', 'after_option', 'options', 'evidence', 'verdict', 'question_text'];
const csvBody = changes.map(c => [
  c.id, c.content_id, c.question_number, c.before, c.after,
  c.beforeText, c.afterText, JSON.stringify(c.options), c.signal, c.verdict,
  String(c.question_text || '').slice(0, 120),
].map(csvCell).join(','));
const changesPath = path.join(OUT_DIR, 'changes.csv');
// rollback.sql 과 짝이 맞아야 하므로 같은 보존 규칙을 적용한다(적용 후 재실행이 목록을 비우지 않게).
{
  const next = '﻿' + [csvHead.map(csvCell).join(','), ...csvBody].join('\n');
  if (fs.existsSync(changesPath) && csvBody.length < (fs.readFileSync(changesPath, 'utf8').split('\n').length - 1)) {
    fs.writeFileSync(path.join(OUT_DIR, 'changes.preview.csv'), next, 'utf8');
    console.warn('[보존] 기존 changes.csv 가 더 많은 행을 담고 있어 덮어쓰지 않았습니다 → changes.preview.csv 로 기록');
  } else {
    fs.writeFileSync(changesPath, next, 'utf8');
  }
}

// (3) 충돌·구조단독 목록 (사람 판단용)
const conflicts = [...verdicts.values()].filter(v => v.verdict === 'CONFLICT').sort((a, b) => a.cid - b.cid);
const structOnly = [...verdicts.values()].filter(v => v.verdict === 'ONE_STRUCT_ONLY').sort((a, b) => a.cid - b.cid);

const conflictLines = ['# 신호 충돌 콘텐츠 — 문항별 증거표 (자동 변환 제외, 사람 판단 필요)', ''];
for (const v of conflicts) {
  conflictLines.push(`## content ${v.cid} (문항 ${v.total}건 / 0증거 zero=${v.zero} exp0=${v.e0} / 1증거 struct=${v.struct1} exp1=${v.e1})`, '');
  conflictLines.push('| qid | #  | answer | 보기수 | 0-based 해석 | 1-based 해석 | 증거 | 해설 |');
  conflictLines.push('|---|---|---|---|---|---|---|---|');
  for (const q of v.qs) {
    const zeroTxt = q.opts[q.n] === undefined ? '(범위밖)' : q.opts[q.n];
    const oneTxt = q.n - 1 >= 0 && q.opts[q.n - 1] !== undefined ? q.opts[q.n - 1] : '(범위밖)';
    const ev = q.n === 0 ? '구조:0-based' : (q.n === q.opts.length ? '구조:1-based' : (q.sig === 'none' ? '-' : `해설:${q.sig}`));
    conflictLines.push(`| ${q.id} | ${q.question_number} | ${q.answer} | ${q.opts.length} | ${String(zeroTxt).replace(/\|/g, '\\|')} | ${String(oneTxt).replace(/\|/g, '\\|')} | ${ev} | ${String(q.explanation || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80)} |`);
  }
  conflictLines.push('');
}
fs.writeFileSync(path.join(OUT_DIR, 'conflicts.md'), conflictLines.join('\n'), 'utf8');

/** 사람이 직접 확인한 struct-only 문항 소견 (2026-08-07 전수 육안 검증). */
const STRUCT_ONLY_NOTES = new Map([
  [239, '❌ 정답키 손상 — √9=3 이므로 정답은 "③3"(idx2). -1 하면 "④9" 로 **오히려 악화**'],
  [240, '❌ 정답키 손상 — √16=4 이므로 정답은 "②4"(idx1). -1 하면 "④16" 으로 **오히려 악화**'],
]);
// MANUAL_INCLUDE 로 이번 적용에 편입된 문항은 이 목록에서 뺀다(두 문서가 서로 모순되지 않도록).
const structOnlyIncluded = [...MANUAL_INCLUDE.keys()];

const structLines = [
  '# 구조 증거만 있는 콘텐츠 (answer === options.length, 해설 증거 없음)',
  '',
  '⚠ 이 부류는 **1-based 저장**과 **정답키 손상**이 섞여 있어 일괄 처리하면 안 된다.',
  '   손상 문항에 `answer -= 1` 을 적용하면 엉뚱한 보기가 정답으로 인정되어 **지금보다 나빠진다**',
  '   (지금은 아무도 못 맞히지만, 변환 후에는 오답을 고른 학생이 정답 처리된다).',
  '   → 자동 변환 대상에서 전부 제외했다. 아래 소견을 보고 **문항별로** 판단할 것.',
  '',
  `※ 이 중 육안으로 1-based 가 확정된 ${structOnlyIncluded.length}건(q${structOnlyIncluded.join(', q')})은 ` +
  'MANUAL_INCLUDE 로 **이번 적용에 편입**했으므로 아래 표에서 제외했다(changes.csv 참조).',
  '',
  '| content | qid | answer | 보기 | 1-based 해석 | 해설 | 육안 검증 소견 |',
  '|---|---|---|---|---|---|---|',
];
for (const v of structOnly) {
  for (const q of v.qs) {
    if (q.n !== q.opts.length) continue;
    if (MANUAL_INCLUDE.has(q.id)) continue;   // 이번 적용에 편입됨
    structLines.push(
      `| ${v.cid} | ${q.id} | ${q.answer} | ${JSON.stringify(q.opts).replace(/\|/g, '\\|')} ` +
      `| ${String(q.opts[q.n - 1]).replace(/\|/g, '\\|')} ` +
      `| ${String(q.explanation || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 70)} ` +
      `| ${STRUCT_ONLY_NOTES.get(q.id) || '(미검증)'} |`
    );
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'struct-only.md'), structLines.join('\n'), 'utf8');

// (4) 영향 범위 — 참조 테이블 건수 + 과거 제출 오채점
function tableExists(t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
const targetCids = new Set(changes.map(c => c.content_id));
const impact = { refs: {}, contentAttempts: [], problemAttempts: [] };
if (targetCids.size) {
  const inList = [...targetCids].join(',');
  for (const [t, col] of [['node_contents', 'content_id'], ['daily_learning_items', 'content_id'], ['lesson_contents', 'content_id'], ['contents', 'id']]) {
    if (!tableExists(t)) { impact.refs[t] = '(테이블 없음)'; continue; }
    impact.refs[t] = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${inList})`).get().c;
  }

  // 변경된 문항의 정답 맵 (question_number 순)
  const changeByQid = new Map(changes.map(c => [c.id, c]));

  // content_attempts: answers = 선택 index 배열 (question_number 순)
  if (tableExists('content_attempts')) {
    const cas = db.prepare(`SELECT * FROM content_attempts WHERE content_id IN (${inList})`).all();
    for (const ca of cas) {
      let picks; try { picks = JSON.parse(ca.answers); } catch (_) { picks = null; }
      if (!Array.isArray(picks)) continue;
      const qs = (byContent.get(ca.content_id) || []).filter(q => q.usable);
      let wasWrongNowRight = 0, wasRightNowWrong = 0;
      qs.forEach((q, i) => {
        const pick = picks[i];
        if (pick == null) return;
        const ch = changeByQid.get(q.id);
        const oldKey = String(q.answer);
        const newKey = ch ? String(ch.after) : oldKey;
        const oldOk = String(pick) === oldKey;
        const newOk = String(pick) === newKey;
        if (!oldOk && newOk) wasWrongNowRight++;
        if (oldOk && !newOk) wasRightNowWrong++;
      });
      if (wasWrongNowRight || wasRightNowWrong) {
        impact.contentAttempts.push({ id: ca.id, content_id: ca.content_id, user_id: ca.user_id, attempted_at: ca.attempted_at, stored_correct: ca.correct_count, wasWrongNowRight, wasRightNowWrong });
      }
    }
  }

  // problem_attempts: 문항 특정 불가(question id 없음) → 콘텐츠 단위로 "재검토 필요" 목록만
  if (tableExists('problem_attempts')) {
    impact.problemAttempts = db.prepare(
      `SELECT id, user_id, content_id, node_id, is_correct, selected_answer, submitted_at, source_type
         FROM problem_attempts WHERE content_id IN (${inList}) ORDER BY id`
    ).all();
  }
}

// (5) report.md
const md = [];
md.push('# content_questions.answer 인덱스 기준(0-based) 정합 — 분석 리포트');
md.push('');
md.push(`- 생성: ${new Date().toISOString()}`);
md.push(`- 대상 DB: \`${DB_PATH}\``);
md.push(`- tier: \`${TIER}\` / 모드: ${APPLY ? '**APPLY(실제 반영)**' : 'ANALYZE(읽기전용)'}`);
md.push('');
md.push('## 1. 문항 모집단');
md.push('');
md.push('| 항목 | 값 |');
md.push('|---|---|');
md.push(`| question_type in (choice, multiple_choice) | ${stats.totalTyped} |`);
md.push(`| 분석 가능(options 배열 ≥2 & answer 정수) | ${stats.parsable} |`);
md.push(`| 제외 | ${stats.excluded.length} |`);
md.push(`| answer === 0 (1-based 불가 → 0-based 확정) | ${stats.ansZero} |`);
md.push(`| answer === options.length (0-based 불가 → 1-based 후보) | ${stats.ansEqLen} |`);
md.push(`| 어느 해석으로도 범위 밖 | ${stats.outOfRange.length} |`);
md.push(`| ⚠ answer 가 실수 문자열("0.0" 등) | ${stats.floatAnswer.length} |`);
md.push('');
md.push('## 2. 해설 신호 (보조)');
md.push('');
md.push('| 신호 | 문항 |');
md.push('|---|---|');
md.push(`| 0-based 일치 | ${stats.exp0} |`);
md.push(`| 1-based 일치 | ${stats.exp1} |`);
md.push(`| 모호(보기 2개 이상 등장) | ${stats.expAmb} |`);
md.push(`| 불일치(어느 해석과도 안 맞음 = 정답키 손상 의심) | ${stats.expMismatch} |`);
md.push(`| 근거 없음 | ${stats.expNone} |`);
md.push('');
md.push('## 3. 콘텐츠 단위 판정');
md.push('');
const vcount = {};
for (const v of verdicts.values()) {
  vcount[v.verdict] = vcount[v.verdict] || { c: 0, q: 0 };
  vcount[v.verdict].c++; vcount[v.verdict].q += v.total;
}
md.push('| 판정 | 콘텐츠 | 문항 | 처리 |');
md.push('|---|---|---|---|');
const verdictDesc = {
  ZERO_VETO: '0-based 확정 — 변환 금지',
  CONFLICT: '신호 충돌 — 손대지 않음(사람 판단)',
  ONE_EXPLAIN: '해설로 1-based 확인 — **변환 대상**',
  ONE_STRUCT_ONLY: '구조 증거만 — 정답키 손상 의심, 변환 제외',
  NO_EVIDENCE: '증거 없음 — 손대지 않음',
};
for (const k of ['ZERO_VETO', 'ONE_EXPLAIN', 'ONE_STRUCT_ONLY', 'CONFLICT', 'NO_EVIDENCE']) {
  const v = vcount[k]; if (!v) continue;
  md.push(`| ${k} | ${v.c} | ${v.q} | ${verdictDesc[k]} |`);
}
md.push('');
md.push('## 4. 변환 계획');
md.push('');
md.push(`- 대상 콘텐츠: **${changedContentCount()}개** (자동 판정 ${targetContents.length} + 수동 편입 ${MANUAL_INCLUDE.size}건이 속한 콘텐츠)`);
md.push(`- 대상 문항(실제 UPDATE): **${changes.length}건** (\`answer -= 1\`)`);
md.push(`- 안전 가드로 건너뛴 행: ${skipped.length}건`);
if (manualSkipped.length) {
  md.push('');
  md.push('### 수동 편입 멱등 가드 — 건너뛴 행');
  md.push('');
  for (const m of manualSkipped) md.push(`- ${m}`);
}
md.push(`- 롤백: \`${path.relative(ROOT, rollbackPath)}\``);
md.push(`- 변경 목록: \`${path.relative(ROOT, changesPath)}\``);
if (skipped.length) {
  md.push('');
  md.push('### 건너뛴 행');
  md.push('| qid | content | 사유 |');
  md.push('|---|---|---|');
  for (const s of skipped) md.push(`| ${s.id} | ${s.content_id} | ${s.reason} |`);
}
md.push('');
md.push('## 5. 영향 범위');
md.push('');
md.push('| 참조 테이블 | 대상 콘텐츠 참조 건수 |');
md.push('|---|---|');
for (const [t, c] of Object.entries(impact.refs)) md.push(`| ${t} | ${c} |`);
md.push('');
md.push(`### 과거 제출 재채점 대상 (자동 재채점 안 함 — 목록만)`);
md.push('');
md.push(`- content_attempts 중 판정이 바뀌는 건: **${impact.contentAttempts.length}건**`);
md.push('');
if (impact.contentAttempts.length) {
  md.push('| attempt_id | content | user | 제출시각 | 저장된 정답수 | 오답→정답 | 정답→오답 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const a of impact.contentAttempts) md.push(`| ${a.id} | ${a.content_id} | ${a.user_id} | ${a.attempted_at} | ${a.stored_correct} | ${a.wasWrongNowRight} | ${a.wasRightNowWrong} |`);
  md.push('');
}
md.push(`- problem_attempts 중 대상 콘텐츠 관련 행: **${impact.problemAttempts.length}건** (문항 id 컬럼이 없어 문항 단위 판정 불가 → 전량 재검토 후보)`);
if (impact.problemAttempts.length) {
  md.push('');
  md.push('| id | user | content | node | is_correct | selected | 제출시각 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const a of impact.problemAttempts) md.push(`| ${a.id} | ${a.user_id} | ${a.content_id} | ${a.node_id || '-'} | ${a.is_correct} | ${a.selected_answer} | ${a.submitted_at} |`);
}
md.push('');
md.push('## 6. 별도 판단 필요');
md.push('');
md.push(`- 신호 충돌 콘텐츠: ${conflicts.length}개 → \`conflicts.md\``);
md.push(`- 구조 증거만(정답키 손상 의심): ${structOnly.length}개 → \`struct-only.md\``);
md.push(`- answer 실수 문자열("0.0"): ${stats.floatAnswer.length}건 — 채점기는 문자열 비교(\`String(pick)===String(answer)\`)라 **영구 오답**. 별도 정규화 필요.`);
if (stats.floatAnswer.length) {
  md.push('');
  md.push('| qid | content | answer | 보기수 |');
  md.push('|---|---|---|---|');
  for (const f of stats.floatAnswer) md.push(`| ${f.id} | ${f.content_id} | ${JSON.stringify(f.answer)} | ${f.len} |`);
}
md.push('');
const reportPath = path.join(OUT_DIR, 'report.md');
fs.writeFileSync(reportPath, md.join('\n'), 'utf8');

// ── 적용 ───────────────────────────────────────────────────────────────
/**
 * 실제 UPDATE 를 수행한다. **--apply 가드를 통과한 뒤에만** 호출된다.
 *
 * ⚠ write 문을 모듈 최상위에 두지 않는다(REG-HF8 / test/harness-freshness.test.js).
 *   최상위 write 는 모듈 로드만으로 실행돼 dry-run 에서도 DB 를 바꾸고
 *   변형 표식을 거짓으로 남긴다(2026-07-31 사고와 동형).
 *
 * @returns {number} 적용된 행 수
 */
function applyChanges(handle, list) {
  if (!list.length) {
    console.log('[안내] 변환 대상이 0건입니다. 적용할 것이 없습니다.');
    return 0;
  }
  let n = 0;
  const upd = handle.prepare('UPDATE content_questions SET answer = ? WHERE id = ?');
  const tx = handle.transaction(rows => {
    for (const c of rows) { upd.run(c.after, c.id); n++; }
  });
  tx(list);

  // 사후 검증 — 변환 결과가 모두 0-based 범위 안인지
  const bad = [];
  for (const c of list) {
    const row = handle.prepare('SELECT answer, options FROM content_questions WHERE id = ?').get(c.id);
    const o = parseOptions(row.options);
    const nn = Number(row.answer);
    if (!o || !(nn >= 0 && nn <= o.length - 1)) bad.push(c.id);
  }
  if (bad.length) {
    console.error(`[치명] 적용 후 범위 검증 실패 ${bad.length}건: ${bad.join(',')} → rollback.sql 로 즉시 되돌리십시오.`);
    process.exitCode = 1;
  }
  return n;
}

let applied = 0;
if (APPLY) {
  if (!fs.existsSync(rollbackPath)) {
    console.error('[중단] rollback.sql 이 없습니다. 적용 금지.');
    process.exit(1);
  }
  applied = applyChanges(db, changes);
}

// ── 콘솔 요약 ──────────────────────────────────────────────────────────
if (!QUIET) {
  console.log('=== content_questions answer 인덱스 정합 ===');
  console.log(`DB: ${DB_PATH}`);
  console.log(`모드: ${APPLY ? 'APPLY' : 'ANALYZE(읽기전용)'} / tier=${TIER}`);
  console.log(`객관식 분석대상 ${stats.parsable} / 타입기준 ${stats.totalTyped} (제외 ${stats.excluded.length})`);
  console.log(`구조: answer===0 ${stats.ansZero} · answer===len ${stats.ansEqLen} · 범위밖 ${stats.outOfRange.length} · 실수문자열 ${stats.floatAnswer.length}`);
  console.log(`해설: 0-based ${stats.exp0} · 1-based ${stats.exp1} · 모호 ${stats.expAmb} · 불일치 ${stats.expMismatch} · 없음 ${stats.expNone}`);
  for (const k of ['ZERO_VETO', 'ONE_EXPLAIN', 'ONE_STRUCT_ONLY', 'CONFLICT', 'NO_EVIDENCE']) {
    const v = vcount[k]; if (v) console.log(`  ${k.padEnd(16)} 콘텐츠 ${String(v.c).padStart(5)} · 문항 ${String(v.q).padStart(5)}`);
  }
  console.log(`변환 대상: 콘텐츠 ${changedContentCount()} · 문항 ${changes.length} (건너뜀 ${skipped.length}, 수동편입 ${MANUAL_INCLUDE.size})`);
  for (const m of manualSkipped) console.log(`  [수동편입 멱등가드] ${m}`);
  console.log(`과거 제출 판정변경: content_attempts ${impact.contentAttempts.length}건 / problem_attempts 관련 ${impact.problemAttempts.length}건`);
  if (APPLY) console.log(`적용 완료: ${applied}건`);
  console.log(`리포트: ${OUT_DIR}`);
}

db.close();
