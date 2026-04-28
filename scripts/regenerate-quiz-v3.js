/**
 * regenerate-quiz-v3.js
 *
 * v2의 후속: 폴백(genConceptFallback)으로 들어간 690건이 영역별 단일 템플릿에
 * 의존하여 distinct question_text 가 1,187 → 1,049 로 오히려 감소(단일 문항 최대
 * 182회 재사용)한 문제를 해결한다.
 *
 * 핵심 변경 (vs v2):
 *  - 폴백 핸들러를 6종 템플릿 라우터(`fallbackTemplateRouter`)로 교체
 *      T1: 정의형 — "다음 중 OO 영역에서 본 차시의 학습 주제로 가장 알맞은 것은?"
 *      T2: 구별형 — 같은 단원 다른 lesson 들과 본 차시 lesson 구별 MCQ
 *      T3: 빈칸형 — 영역 핵심어 단답형 (Cloze) "OO 영역의 핵심 개념은 ___이다."
 *      T4: 예시형 — lesson_name 과 매칭되는 예시/사례 고르기
 *      T5: 메타형 — lesson_name 이 가장 어울리는 학년·단원 짝짓기
 *      T6: 풀이형 — 영역 핵심 용어 풀이 ("함수란 무엇인가?")
 *  - 노드별 결정성 시드(seedKey + lname)로 6종 중 1종 선택 → 재실행 시 동일
 *  - 영역×학교급별 핵심어 사전(KEYWORDS_BY_AREA_LEVEL) 도입
 *
 * 검증 목표:
 *  - distinct question_text ≥ 700 (vs 현재 1,049)
 *  - 단일 문항 최대 재사용 ≤ 30 (vs 현재 182)
 *
 * 실행:
 *   node scripts/regenerate-quiz-v3.js          # 본 실행
 *   node scripts/regenerate-quiz-v3.js --dry    # 핸들러 분포만
 *   node scripts/regenerate-quiz-v3.js --sample # 30개 샘플 출력
 *   node scripts/regenerate-quiz-v3.js --check  # 갱신 후 distinct 통계
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const DRY = process.argv.includes('--dry');
const SAMPLE = process.argv.includes('--sample');
const CHECK = process.argv.includes('--check');
const db = new Database(DB_PATH);

// v2 generator를 그대로 가져온다 (require 시 자동 실행되지 않도록 가드는 없으므로,
// v2 스크립트는 실행하지 않고, 본 v3에 필수 함수만 인라인으로 재구현)
// → 본 파일은 자급자족. 하단의 generateProblemV2 호출은 v2 코드 일부를 인라인.

// ============== 공용 RNG / 유틸 ==============================================
function seededRand(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 0x100000000; };
}
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ============== 영역×학교급 핵심어 사전 =====================================
// 각 영역×학교급마다 ≥ 6개 핵심 용어/사례. 빈칸형/풀이형/예시형 폴백에서 사용.
const KEYWORDS_BY_AREA_LEVEL = {
  '수와 연산_초': {
    keywords: ['덧셈', '뺄셈', '곱셈', '나눗셈', '분수', '소수', '자릿값', '약분', '통분', '몫', '나머지', '배수'],
    definition: '수의 의미와 사칙연산을 이해하고 자유자재로 다루는 것',
    examples: { '덧셈': ['사과 3개와 2개를 합치기', '7+5 계산'], '뺄셈': ['남은 양 구하기', '10-4 계산'],
                '분수': ['피자를 4등분하여 1조각 먹기', '1/2 + 1/4 계산'], '곱셈': ['2개씩 묶음 5개', '3×4 구하기'],
                '나눗셈': ['12개 사탕을 4명에게 똑같이 나누기', '15÷3'] },
  },
  '수와 연산_중': {
    keywords: ['정수', '유리수', '음수', '절댓값', '소인수분해', '거듭제곱', '최대공약수', '최소공배수', '제곱근', '무리수'],
    definition: '수 체계의 확장(정수·유리수·실수)과 그 연산 규칙을 이해하는 것',
    examples: { '정수': ['영하 5도', '해발 -100m'], '소인수분해': ['12 = 2² × 3', '30 = 2 × 3 × 5'],
                '절댓값': ['|−3| = 3', '원점으로부터의 거리'] },
  },
  '변화와 관계_초': {
    keywords: ['규칙', '대응', '비례', '비율', '백분율', '수 배열', '도형 배열', '같은 양만큼', '두 배', '점점 커지는'],
    definition: '두 양 사이의 변화 규칙과 대응 관계를 발견하고 표현하는 것',
    examples: { '규칙': ['2, 4, 6, 8 같이 2씩 커짐', '원·삼각형 반복'], '대응': ['1단 4개, 2단 8개', '시간과 거리 관계'] },
  },
  '변화와 관계_중': {
    keywords: ['일차함수', '이차함수', '기울기', '절편', '문자와 식', '방정식', '부등식', '다항식', '인수분해', '변수'],
    definition: '문자와 식을 사용하여 수량 사이의 관계를 표현하고 함수로 나타내는 것',
    examples: { '일차함수': ['y = 2x + 3', '시간당 같은 속도로 가는 거리'], '인수분해': ['x²−1 = (x+1)(x−1)'] },
  },
  '도형과 측정_초': {
    keywords: ['삼각형', '사각형', '원', '직육면체', '정육면체', '각도', '넓이', '둘레', '부피', '시각', '들이', '무게'],
    definition: '평면도형·입체도형의 성질과 측정의 의미를 이해하는 것',
    examples: { '삼각형': ['세 변으로 이루어진 도형', '직각삼각형'], '넓이': ['가로×세로', '직사각형의 넓이 12cm²'],
                '시각': ['시계가 가리키는 시간', '오전 9시 30분'], '정육면체': ['주사위 모양', '면 6개'] },
  },
  '도형과 측정_중': {
    keywords: ['선분', '직선', '반직선', '각', '합동', '닮음', '피타고라스 정리', '원주각', '삼각비', '입체도형의 부피'],
    definition: '도형 사이의 합동·닮음 관계와 길이·각·넓이의 관계를 논증하는 것',
    examples: { '피타고라스 정리': ['직각삼각형 a² + b² = c²', '3-4-5 직각삼각형'],
                '닮음': ['크기가 다른 두 정삼각형', '비례식으로 변의 길이 구하기'] },
  },
  '자료와 가능성_초': {
    keywords: ['그래프', '막대그래프', '꺾은선그래프', '평균', '분류', '표', '가능성', '확실하다', '반반이다'],
    definition: '자료를 수집·분류·정리하여 표현하고 가능성을 말로 표현하는 것',
    examples: { '평균': ['(80+90+70)÷3 = 80', '반 평균 점수'], '가능성': ['동전 앞면이 나올 가능성: 반반'] },
  },
  '자료와 가능성_중': {
    keywords: ['도수분포표', '히스토그램', '상대도수', '경우의 수', '확률', '평균', '중앙값', '최빈값', '산포도'],
    definition: '자료의 분포를 정리하여 분석하고 사건이 일어날 확률을 구하는 것',
    examples: { '확률': ['주사위 짝수가 나올 확률 1/2', '사건의 가능성 수치화'] },
  },
  '집합과 명제_고': {
    keywords: ['집합', '원소', '부분집합', '교집합', '합집합', '여집합', '명제', '부정', '충분조건', '필요조건', '대우'],
    definition: '대상의 모임을 집합으로 다루고 명제의 참·거짓과 논리 관계를 분석하는 것',
    examples: { '여집합': ['전체집합 U − A', 'A에 속하지 않는 원소'],
                '충분조건': ['x=1 이면 x²=1', 'p이면 q'] },
  },
  '다항식_고': {
    keywords: ['다항식', '항등식', '나머지정리', '인수정리', '인수분해', '분수식', '실수', '복소수'],
    definition: '다항식의 사칙연산과 인수분해, 나머지·인수정리를 이해하는 것',
    examples: { '인수분해': ['x²−4 = (x−2)(x+2)', '공통인수 묶기'],
                '나머지정리': ['P(x)를 (x−a)로 나눈 나머지는 P(a)'] },
  },
  '방정식과 부등식_고': {
    keywords: ['이차방정식', '판별식', '근과 계수의 관계', '연립방정식', '이차부등식', '절댓값을 포함한 부등식'],
    definition: '방정식과 부등식의 풀이 원리와 해의 성질을 이해하는 것',
    examples: { '판별식': ['b²−4ac', '실근의 개수 판정'] },
  },
  '도형의 방정식_고': {
    keywords: ['두 점 사이의 거리', '내분점', '외분점', '직선의 방정식', '원의 방정식', '도형의 평행이동', '도형의 대칭이동'],
    definition: '좌표평면 위의 점·직선·원을 식으로 나타내고 그 관계를 분석하는 것',
    examples: { '원의 방정식': ['(x−a)² + (y−b)² = r²', '중심 (1,2) 반지름 3인 원'] },
  },
  '함수와 그래프_고': {
    keywords: ['함수', '정의역', '치역', '합성함수', '역함수', '유리함수', '무리함수', '점근선'],
    definition: '대응 관계로서의 함수 개념과 다양한 함수의 그래프를 다루는 것',
    examples: { '합성함수': ['(f∘g)(x) = f(g(x))', '두 함수의 연속 적용'],
                '역함수': ['y = x를 축으로 대칭', 'f(a)=b 이면 f⁻¹(b)=a'] },
  },
  '경우의 수_고': {
    keywords: ['합의 법칙', '곱의 법칙', '순열', '조합', '계승', '같은 것이 있는 순열', '원순열'],
    definition: '경우를 빠짐없이 셀 수 있는 원리(순열·조합)를 이해하는 것',
    examples: { '순열': ['nPr = n!/(n−r)!', '5명을 3명씩 일렬로'],
                '조합': ['nCr = n!/(r!(n−r)!)', '10개 중 3개 뽑기'] },
  },
  '행렬_고': {
    keywords: ['행렬', '성분', '단위행렬', '역행렬', '행렬의 곱셈', '연립일차방정식'],
    definition: '수를 직사각형 모양으로 배열하여 일괄 연산할 수 있게 하는 도구',
    examples: { '역행렬': ['AA⁻¹ = E', '연립방정식의 해 구하기'] },
  },
};

function getAreaLevelKey(area, level) {
  const k = `${area}_${level}`;
  if (KEYWORDS_BY_AREA_LEVEL[k]) return k;
  // fallback: try just area_초 or area_고
  for (const lv of ['초','중','고']) {
    if (KEYWORDS_BY_AREA_LEVEL[`${area}_${lv}`]) return `${area}_${lv}`;
  }
  return null;
}

// ============== siblings (영역 단위) =========================================
let SIBLINGS_BY_AREA = {};
let LESSONS_BY_UNIT = {};
let UNIT_GRADE_BY_LESSON = {};
function buildIndices(allNodes) {
  const byArea = {};
  const byUnit = {};
  for (const n of allNodes) {
    if (!n.lesson_name || !n.area) continue;
    if (!byArea[n.area]) byArea[n.area] = new Set();
    byArea[n.area].add(n.lesson_name);
    const unitKey = `${n.grade_level}${n.grade}_${n.unit_name || '_'}`;
    if (!byUnit[unitKey]) byUnit[unitKey] = new Set();
    byUnit[unitKey].add(n.lesson_name);
    if (!UNIT_GRADE_BY_LESSON[n.lesson_name]) {
      UNIT_GRADE_BY_LESSON[n.lesson_name] = { grade_level: n.grade_level, grade: n.grade, unit: n.unit_name || '', area: n.area };
    }
  }
  Object.keys(byArea).forEach(k => SIBLINGS_BY_AREA[k] = Array.from(byArea[k]));
  Object.keys(byUnit).forEach(k => LESSONS_BY_UNIT[k] = Array.from(byUnit[k]));
}

// ============== 폴백 6종 템플릿 ==============================================

// T1: 정의형 (기존 v2 유지 — 본 차시 주제 식별)
function fbT1Definition(lname, area, level, rng) {
  const sibs = SIBLINGS_BY_AREA[area] || [];
  const others = sibs.filter(s => s !== lname);
  const distractors = shuffle(others, rng).slice(0, 4);
  while (distractors.length < 4) distractors.push(`보기 ${distractors.length+1}`);
  const options = shuffle([lname, ...distractors], rng);
  return {
    text: `[${area}] 다음 중 본 차시의 학습 주제로 가장 알맞은 것은 무엇입니까?`,
    options, answer: String(options.indexOf(lname)),
    explanation: `본 차시는 "${lname}" 학습을 목표로 합니다.`
  };
}

// T2: 구별형 — 같은 단원의 다른 lesson 들과 구별
function fbT2DistinguishUnit(lname, area, level, rng, node) {
  const ctx = UNIT_GRADE_BY_LESSON[lname] || { grade_level: level, grade: node.grade, unit: node.unit_name || '' };
  const unitKey = `${ctx.grade_level}${ctx.grade}_${ctx.unit}`;
  let pool = (LESSONS_BY_UNIT[unitKey] || []).filter(s => s !== lname);
  if (pool.length < 3) {
    // 단원이 충분치 않으면 area 시블링으로 보강
    const extra = (SIBLINGS_BY_AREA[area] || []).filter(s => s !== lname && !pool.includes(s));
    pool = pool.concat(shuffle(extra, rng).slice(0, 5 - pool.length));
  }
  const distractors = shuffle(pool, rng).slice(0, 3);
  while (distractors.length < 3) distractors.push(`기타 학습 주제 ${distractors.length+1}`);
  const options = shuffle([lname, ...distractors], rng);
  const unitLabel = ctx.unit || `${ctx.grade_level}${ctx.grade} ${area}`;
  return {
    text: `「${unitLabel}」 단원의 학습 주제 중 본 차시(${area})에 해당하는 것은 무엇입니까?`,
    options, answer: String(options.indexOf(lname)),
    explanation: `같은 단원의 다른 차시와 비교했을 때, 본 차시는 "${lname}"을(를) 다룹니다.`
  };
}

// T3: 빈칸형 — 영역 핵심어 빈칸 채우기
function fbT3Cloze(lname, area, level, rng) {
  const key = getAreaLevelKey(area, level);
  if (!key) return null;
  const dict = KEYWORDS_BY_AREA_LEVEL[key];
  // 정답: lname 자체에 포함된 핵심어 우선, 없으면 area 핵심어 중 하나
  let answer = null;
  for (const kw of dict.keywords) { if (lname.includes(kw)) { answer = kw; break; } }
  if (!answer) answer = pick(dict.keywords, rng);
  const distractors = shuffle(dict.keywords.filter(k => k !== answer), rng).slice(0, 3);
  while (distractors.length < 3) distractors.push(`보기 ${distractors.length+1}`);
  const options = shuffle([answer, ...distractors], rng);
  // 빈칸 문장: 정답을 ___로 마스킹
  let stem;
  if (lname.includes(answer)) {
    stem = `다음 빈칸에 들어갈 알맞은 말은 무엇입니까?\n\n  본 차시는 "${lname.replace(answer, '___')}"을(를) 학습합니다.`;
  } else {
    stem = `다음 빈칸에 들어갈, "${area}" 영역의 핵심 개념으로 가장 알맞은 것은 무엇입니까?\n\n  ${dict.definition.replace(/이해하는 것|것$/, '핵심 개념은 ___이다')}.`;
  }
  return {
    text: stem, options, answer: String(options.indexOf(answer)),
    explanation: `빈칸에 들어갈 말은 "${answer}"입니다. (영역: ${area})`
  };
}

// T4: 예시형 — lesson_name 과 어울리는 예시·사례 고르기
function fbT4Example(lname, area, level, rng) {
  const key = getAreaLevelKey(area, level);
  if (!key) return null;
  const dict = KEYWORDS_BY_AREA_LEVEL[key];
  // lname 과 매칭되는 keyword 의 예시
  let kw = null, examples = null;
  for (const k of Object.keys(dict.examples || {})) {
    if (lname.includes(k)) { kw = k; examples = dict.examples[k]; break; }
  }
  if (!examples) {
    // 임의 keyword 의 예시 사용
    const ks = Object.keys(dict.examples || {});
    if (ks.length === 0) return null;
    kw = pick(ks, rng); examples = dict.examples[kw];
  }
  const correct = pick(examples, rng);
  // distractor: 다른 keyword 의 예시
  const otherKws = Object.keys(dict.examples).filter(k => k !== kw);
  const distractors = [];
  for (const ok of shuffle(otherKws, rng)) {
    const exs = dict.examples[ok] || [];
    if (exs.length) distractors.push(exs[0]);
    if (distractors.length >= 3) break;
  }
  while (distractors.length < 3) distractors.push(`상황 ${distractors.length+1}`);
  const options = shuffle([correct, ...distractors], rng);
  return {
    text: `다음 중 "${lname}"(${area}) 학습과 가장 관련 있는 사례·상황으로 알맞은 것은 무엇입니까?`,
    options, answer: String(options.indexOf(correct)),
    explanation: `"${kw}" 개념의 대표적인 예시는 "${correct}"입니다.`
  };
}

// T5: 메타형 — 학년·단원 짝짓기
function fbT5MetaCog(lname, area, level, rng, node) {
  const ctx = UNIT_GRADE_BY_LESSON[lname] || { grade_level: level, grade: node.grade, unit: node.unit_name || area };
  const correct = `${ctx.grade_level}등 ${ctx.grade}학년 — ${area}`.replace('초등','초').replace('중등','중').replace('고등','고');
  const correctLabel = `${ctx.grade_level}${ctx.grade} ${area}`;
  // distractor: 다른 학년·영역 조합
  const allCombos = [];
  for (const lv of ['초','중','고']) {
    for (let g = 1; g <= 6; g++) {
      if (lv === '중' && g > 3) continue;
      if (lv === '고' && g > 1) continue;
      for (const ar of ['수와 연산','변화와 관계','도형과 측정','자료와 가능성','집합과 명제','다항식']) {
        const lab = `${lv}${g} ${ar}`;
        if (lab !== correctLabel) allCombos.push(lab);
      }
    }
  }
  const distractors = shuffle(allCombos, rng).slice(0, 3);
  const options = shuffle([correctLabel, ...distractors], rng);
  return {
    text: `"${lname}"은(는) 어느 학년 / 어느 영역에서 다루는 학습 주제입니까?`,
    options, answer: String(options.indexOf(correctLabel)),
    explanation: `"${lname}"은(는) ${correctLabel} 영역의 학습 주제입니다.`
  };
}

// T6: 풀이형 — 영역 핵심 용어 풀이
function fbT6Definition(lname, area, level, rng) {
  const key = getAreaLevelKey(area, level);
  if (!key) return null;
  const dict = KEYWORDS_BY_AREA_LEVEL[key];
  // lname 에 포함된 keyword 우선, 없으면 area keyword 중 하나
  let term = null;
  for (const kw of dict.keywords) { if (lname.includes(kw)) { term = kw; break; } }
  if (!term) term = pick(dict.keywords, rng);
  // 정답 풀이: dict.definition 또는 examples 의 첫 항목
  const correctExpl = (dict.examples && dict.examples[term] && dict.examples[term][0])
    ? dict.examples[term][0]
    : dict.definition;
  // distractor: 다른 영역의 definition들
  const otherKeys = Object.keys(KEYWORDS_BY_AREA_LEVEL).filter(k => k !== key);
  const distractors = [];
  for (const ok of shuffle(otherKeys, rng)) {
    distractors.push(KEYWORDS_BY_AREA_LEVEL[ok].definition);
    if (distractors.length >= 3) break;
  }
  const options = shuffle([correctExpl, ...distractors], rng);
  return {
    text: `"${term}"을(를) 가장 잘 설명한 것은 무엇입니까?\n\n(${area} 영역, 본 차시: ${lname})`,
    options, answer: String(options.indexOf(correctExpl)),
    explanation: `"${term}"은(는) "${correctExpl}"(으)로 설명할 수 있습니다.`
  };
}

// ============== 폴백 라우터 ===================================================
function fallbackTemplateRouter(node, seedKey) {
  const lname = node.lesson_name || '';
  const area = node.area || '';
  const level = node.grade_level || '초';
  const rng = seededRand(seedKey + '_fb_' + lname);

  // 결정성 선택: 시드 기반 0~5 인덱스
  const pickRng = seededRand('tpl_' + node.node_id + '_' + (node.content_id || ''));
  const order = shuffle([0, 1, 2, 3, 4, 5], pickRng);

  for (const idx of order) {
    let res = null;
    try {
      switch (idx) {
        case 0: res = fbT1Definition(lname, area, level, rng); break;
        case 1: res = fbT2DistinguishUnit(lname, area, level, rng, node); break;
        case 2: res = fbT3Cloze(lname, area, level, rng); break;
        case 3: res = fbT4Example(lname, area, level, rng); break;
        case 4: res = fbT5MetaCog(lname, area, level, rng, node); break;
        case 5: res = fbT6Definition(lname, area, level, rng); break;
      }
    } catch (e) { res = null; }
    if (res && res.text && Array.isArray(res.options) && res.options.length >= 4) {
      res._tpl = `T${idx+1}`;
      return res;
    }
  }
  return fbT1Definition(lname, area, level, rng);
}

// ============== v2 generator 인라인 (concept-fallback 분기만 v3 라우터로 교체) ====
// (v2의 제너레이터 함수들은 require 시 부작용을 일으키므로, v2 파일을 동적 평가해서
//  그 함수들을 가져온다.)
const fs = require('fs');
const v2Source = fs.readFileSync(path.join(__dirname, 'regenerate-quiz-content.js'), 'utf8');

// v2 파일에서 헤더(require·DB 오픈) 와 메인 실행부 제거 — generator 함수 영역만 추출
const startMarker = '// -------- RNG ';
const startIdx = v2Source.indexOf(startMarker);
const cutIdx = v2Source.indexOf('// -------- 메인 디스패처');
const v2Lib = v2Source.slice(startIdx, v2Source.indexOf('// 메인 실행'));

// v2 라이브러리를 함수 안에서 평가 (require 사용 안 함 — 순수 JS만 포함)
const v2Eval = new Function(`
  ${v2Lib}
  return { generateProblemV2, buildSiblings, getSiblings: () => SIBLINGS_BY_AREA, setSiblings: (m) => { SIBLINGS_BY_AREA = m; } };
`);
const v2 = v2Eval();

// 본 v3에서는 v2 generator를 그대로 호출하되, 결과의 question_text 가 폴백 패턴
// "학습 주제로 가장 알맞은" 인 경우 v3 다양화 라우터로 교체
function generateProblemV3(node, seedKey) {
  const v2Result = v2.generateProblemV2(node, seedKey);
  const isFallback = /학습 주제로 가장 알맞은/.test(v2Result.text || '');
  if (!isFallback) return { ...v2Result, _tpl: 'v2-handler' };
  const v3Result = fallbackTemplateRouter(node, seedKey);
  return v3Result;
}

// ============== 메인 실행 ====================================================
const allNodes = db.prepare(`SELECT node_id, lesson_name, area, grade, grade_level, unit_name FROM learning_map_nodes WHERE node_level = 3`).all();
buildIndices(allNodes);
// v2 의 SIBLINGS_BY_AREA 도 동기화
const v2sibsMap = {};
for (const k of Object.keys(SIBLINGS_BY_AREA)) v2sibsMap[k] = SIBLINGS_BY_AREA[k];
v2.setSiblings(v2sibsMap);

const targets = db.prepare(`
  SELECT c.id AS content_id, c.title AS old_title,
         lmn.node_id, lmn.lesson_name, lmn.grade_level, lmn.grade, lmn.area, lmn.subject, lmn.achievement_code, lmn.unit_name,
         q.id AS qid, q.question_text AS old_q
  FROM contents c
  JOIN content_content_nodes ccn ON ccn.content_id = c.id
  JOIN learning_map_nodes lmn ON lmn.node_id = ccn.std_id
  LEFT JOIN content_questions q ON q.content_id = c.id
  WHERE c.tags LIKE '%자동생성%'
  ORDER BY c.id
`).all();

console.log(`[regen-v3] 대상 콘텐츠: ${targets.length}개`);

if (CHECK) {
  const stats = db.prepare(`
    SELECT COUNT(*) total, COUNT(DISTINCT q.question_text) distinct_q
    FROM content_questions q
    JOIN contents c ON c.id = q.content_id
    WHERE c.tags LIKE '%자동생성%'
  `).get();
  console.log('총 quiz_question:', stats);
  const top = db.prepare(`
    SELECT q.question_text, COUNT(*) c
    FROM content_questions q
    JOIN contents c ON c.id = q.content_id
    WHERE c.tags LIKE '%자동생성%'
    GROUP BY q.question_text
    ORDER BY c DESC
    LIMIT 10
  `).all();
  console.log('Top 10 중복:');
  for (const r of top) console.log(`  ${r.c}× ${r.question_text.replace(/\n/g,' ').slice(0,80)}`);
  db.close();
  process.exit(0);
}

if (SAMPLE) {
  const sample = shuffle(targets, seededRand('v3-sample-2026'));
  const N = 30;
  console.log(`\n=== 무작위 ${N}개 샘플 (v3 재생성) ===\n`);
  for (let i = 0; i < N && i < sample.length; i++) {
    const t = sample[i];
    const seedKey = `${t.node_id}_v${(t.content_id % 2) + 1}`;
    const gen = generateProblemV3(t, seedKey);
    console.log(`#${i+1} [${t.grade_level}${t.grade}/${gen._tpl||'?'}] ${t.area} > ${t.lesson_name}`);
    console.log(`  Q: ${gen.text.replace(/\n/g,' ').slice(0,140)}`);
    console.log(`  옵션: ${(gen.options||[]).join(' | ').slice(0,160)}`);
    console.log(`  정답idx: ${gen.answer}`);
    console.log('');
  }
  db.close();
  process.exit(0);
}

if (DRY) {
  const byTpl = {};
  for (const t of targets) {
    const seedKey = `${t.node_id}_v${(t.content_id % 2) + 1}`;
    const gen = generateProblemV3(t, seedKey);
    const k = gen._tpl || 'unknown';
    byTpl[k] = (byTpl[k] || 0) + 1;
  }
  console.log('\n=== 템플릿별 분포 ===');
  Object.entries(byTpl).sort((a,b)=>b[1]-a[1]).forEach(([h,c]) => console.log(`  ${h}: ${c}`));
  // 예상 distinct count (텍스트 기준)
  const seenTexts = new Set();
  for (const t of targets) {
    const seedKey = `${t.node_id}_v${(t.content_id % 2) + 1}`;
    const gen = generateProblemV3(t, seedKey);
    seenTexts.add(gen.text);
  }
  console.log(`\n예상 distinct question_text: ${seenTexts.size} / ${targets.length}`);
  db.close();
  process.exit(0);
}

const upContent = db.prepare(`UPDATE contents SET title = ?, description = ? WHERE id = ?`);
const upQ = db.prepare(`UPDATE content_questions SET question_text = ?, options = ?, answer = ?, explanation = ? WHERE id = ?`);

const tx = db.transaction(() => {
  let n = 0, fbCount = 0;
  for (const t of targets) {
    const seedKey = `${t.node_id}_v${(t.content_id % 2) + 1}`;
    const gen = generateProblemV3(t, seedKey);
    const newTitle = `${t.lesson_name} - 문제 ${(t.content_id % 2) + 1}`;
    const newDesc = `자동 생성 문항(v3). ${t.area} > ${t.lesson_name}. ${t.grade_level}${t.grade}.`;
    upContent.run(newTitle, newDesc, t.content_id);
    if (t.qid) {
      upQ.run(gen.text, JSON.stringify(gen.options), gen.answer, gen.explanation, t.qid);
    }
    if (gen._tpl && gen._tpl.startsWith('T')) fbCount++;
    n++;
    if (n % 200 === 0) console.log(`  진행: ${n}개 갱신...`);
  }
  return { n, fbCount };
});

const { n, fbCount } = tx();
console.log(`완료 — 갱신된 quiz 콘텐츠: ${n}개 (이 중 다양화 폴백 적용: ${fbCount}개)`);

const stats = db.prepare(`
  SELECT COUNT(*) total, COUNT(DISTINCT q.question_text) distinct_q
  FROM content_questions q
  JOIN contents c ON c.id = q.content_id
  WHERE c.tags LIKE '%자동생성%'
`).get();
console.log('\n[검증] 자동생성 quiz_question 통계:');
console.log(`  total: ${stats.total}, distinct: ${stats.distinct_q}`);
const top = db.prepare(`
  SELECT q.question_text, COUNT(*) c
  FROM content_questions q
  JOIN contents c ON c.id = q.content_id
  WHERE c.tags LIKE '%자동생성%'
  GROUP BY q.question_text
  ORDER BY c DESC
  LIMIT 5
`).all();
console.log('  Top 5 중복:');
for (const r of top) console.log(`    ${r.c}× ${r.question_text.replace(/\n/g,' ').slice(0,80)}`);

db.close();
