// Audit and fix off-by-one/wrong answer keys in content_questions
// Usage: node fix-answer-keys.js [--apply]
const DB_PATH = 'data/dacheum.db';
const APPLY = process.argv.includes('--apply');

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// ---------- helpers ----------
const CIRC_NUM = { '①':1, '②':2, '③':3, '④':4, '⑤':5, '⑥':6, '⑦':7, '⑧':8, '⑨':9 };
const SUP_DIGIT = { '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9' };

function stripCirc(s) {
  return String(s).replace(/^\s*[①②③④⑤⑥⑦⑧⑨]\s*/, '').trim();
}

function parseOptions(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.map(x => String(x));
  } catch { return null; }
}

function numEq(a, b, eps = 1e-6) {
  if (a == null || b == null) return false;
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) < eps;
}

// Convert superscripts to ** expression
function expandSuperscripts(s) {
  // Replace <base><sup...> with base**exp
  return s.replace(/([0-9])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_, b, sup) => {
    const exp = sup.split('').map(c => SUP_DIGIT[c]).join('');
    return `(${b}**${exp})`;
  });
}

// Try to evaluate simple arithmetic: digits, + - * / × ÷ . ( )
function tryArithmetic(text) {
  // Extract the LHS before '=' if present, otherwise the whole line
  let expr = text;
  const eqIdx = expr.indexOf('=');
  if (eqIdx !== -1) expr = expr.slice(0, eqIdx);
  // Normalize ops
  expr = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/·/g, '*');
  expr = expandSuperscripts(expr);
  // Strip Korean text and keep math chars only
  // Allow digits, ops, parens, dot, space
  if (!/[0-9]/.test(expr)) return null;
  // Get the longest contiguous math substring
  const m = expr.match(/[-+*/().\d\s]+/g);
  if (!m) return null;
  // Try the full expr first (if it only contains math), then pick substrings
  const candidates = [expr.replace(/[^-+*/().\d\s]/g, ' ')].concat(m);
  for (const cand of candidates) {
    const t = cand.trim();
    if (!t) continue;
    if (!/[+\-*/]/.test(t)) continue; // must have an operator
    if (!/\d/.test(t)) continue;
    // safeguard
    if (!/^[-+*/().\d\s]+$/.test(t)) continue;
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict";return (${t});`)();
      if (typeof v === 'number' && isFinite(v)) return v;
    } catch {}
  }
  return null;
}

// Fraction addition/subtraction (simple same-denominator or mixed): "3/4+2/4" => numeric
// We'll treat a/b as a/b numerically.
function tryFraction(text) {
  // find fraction expression like "3/4 + 2/4" or "3/4 - 1/8"
  const fracRe = /\d+\s*\/\s*\d+(\s*[+\-]\s*\d+\s*\/\s*\d+)+/g;
  const m = text.match(fracRe);
  if (!m) return null;
  for (const expr of m) {
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict";return (${expr});`)();
      if (typeof v === 'number' && isFinite(v)) return v;
    } catch {}
  }
  return null;
}

// Prime factorization: parse "36=?" style asking for factorization
function tryPrimeFactorization(text, options) {
  // Must look like "N = ?" or "N의 소인수분해" etc., mentioning 소인수분해
  if (!/소인수분해/.test(text)) return null;
  const numMatch = text.match(/(\d{2,4})/);
  if (!numMatch) return null;
  let n = parseInt(numMatch[1], 10);
  const factors = {};
  for (let p = 2; p * p <= n; p++) {
    while (n % p === 0) { factors[p] = (factors[p]||0)+1; n = n/p; }
  }
  if (n > 1) factors[n] = (factors[n]||0)+1;
  // Expected canonical: primes ascending, exponents as ² ³ etc
  const sup = ['','','²','³','⁴','⁵','⁶','⁷','⁸','⁹'];
  const primes = Object.keys(factors).map(Number).sort((a,b)=>a-b);
  const canonical = primes.map(p => factors[p]===1 ? String(p) : `${p}${sup[factors[p]]}`).join('×');
  // Also compute numeric product (not useful since equals original N)
  // Try match against options by string similarity (ignore leading circle digit)
  return { canonical, factors };
}

// Unit conversions
function tryUnitConversion(text) {
  // Supports simple km->m, m->cm, cm->mm, kg->g, g->mg, L->mL
  const units = {
    'km':1000, 'm':1, 'cm':0.01, 'mm':0.001,
    'kg':1000, 'g':1, 'mg':0.001,
    'L':1000, 'mL':1, 'l':1000, 'ml':1,
  };
  // Match "N <unit1> = ? <unit2>" or "N <unit1>는 몇 <unit2>"
  const re = /(\d+(?:\.\d+)?)\s*(km|cm|mm|m|kg|mg|g|mL|ml|L|l)\b[^\d]*?(km|cm|mm|m|kg|mg|g|mL|ml|L|l)\b/;
  const m = text.match(re);
  if (!m) return null;
  const val = parseFloat(m[1]); const u1 = m[2]; const u2 = m[3];
  if (!(u1 in units) || !(u2 in units)) return null;
  // Only convert within same dimension: length/mass/volume
  const dim = u => (['km','m','cm','mm'].includes(u)?'L':['kg','g','mg'].includes(u)?'M':['L','l','mL','ml'].includes(u)?'V':null);
  if (dim(u1) !== dim(u2) || !dim(u1)) return null;
  return val * units[u1] / units[u2];
}

// General knowledge patterns
function tryKnowledge(text) {
  if (/삼각형.*내각.*합/.test(text)) return 180;
  if (/사각형.*내각.*합/.test(text)) return 360;
  if (/직각\s*[은는이]?\s*몇\s*도/.test(text) || /직각의\s*크기/.test(text)) return 90;
  if (/평각\s*[은는이]?\s*몇\s*도/.test(text)) return 180;
  return null;
}

// Extract numeric value from an option string (strip circled digit prefix, units, etc.)
function optionNumeric(opt) {
  const s = stripCirc(opt);
  // try pure number
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  // only if the option is essentially that number (avoid matching "3월" etc.)
  const num = parseFloat(m[0]);
  return isFinite(num) ? num : null;
}

// Try to read answer index from explanation text
function answerFromExplanation(exp, options) {
  if (!exp) return null;
  // circled digit mentioned
  const circ = exp.match(/[①②③④⑤⑥⑦⑧⑨]/);
  if (circ) return CIRC_NUM[circ[0]];
  // "정답은 2번" / "답: 3"
  const m = exp.match(/정답[은는이]?\s*[:：]?\s*(\d)\s*번?/);
  if (m) { const v = parseInt(m[1],10); if (v>=1 && v<=options.length) return v; }
  const m2 = exp.match(/답[은는이]?\s*[:：]\s*(\d)\s*번?/);
  if (m2) { const v = parseInt(m2[1],10); if (v>=1 && v<=options.length) return v; }
  return null;
}

// Match a numeric computed value to an option index
function matchNumericToIndex(value, options) {
  const hits = [];
  for (let i = 0; i < options.length; i++) {
    const ov = optionNumeric(options[i]);
    if (ov != null && numEq(ov, value)) hits.push(i+1);
  }
  return hits;
}

function matchStringToIndex(target, options) {
  const norm = s => stripCirc(s).replace(/\s+/g,'').toLowerCase();
  const t = norm(target);
  const hits = [];
  for (let i = 0; i < options.length; i++) {
    if (norm(options[i]) === t) hits.push(i+1);
  }
  return hits;
}

// ---------- main scan ----------
const rows = db.prepare(`
  SELECT id, content_id, question_number, question_type, question_text, options, answer, explanation
  FROM content_questions
  WHERE options IS NOT NULL AND options != ''
`).all();

let scanned = 0, parsed = 0, confirmed = 0, toFix = 0, skipped = 0, suspicious = 0;
const fixes = [];
const suspectList = [];
const skippedLog = [];

for (const r of rows) {
  const opts = parseOptions(r.options);
  if (!opts || opts.length === 0) { skipped++; continue; }
  scanned++;

  const qt = r.question_text || '';
  const exp = r.explanation || '';
  let computed = null;
  let parseKind = null;

  // 1) knowledge
  const kv = tryKnowledge(qt);
  if (kv != null) { computed = kv; parseKind = 'knowledge'; }

  // 2) unit conversion
  if (computed == null) {
    const uv = tryUnitConversion(qt);
    if (uv != null) { computed = uv; parseKind = 'unit'; }
  }

  // 3) prime factorization (string match)
  let pfResult = null;
  if (computed == null) {
    pfResult = tryPrimeFactorization(qt, opts);
  }

  // 4) fractions
  if (computed == null) {
    const fv = tryFraction(qt);
    if (fv != null) { computed = fv; parseKind = 'fraction'; }
  }

  // 5) general arithmetic / powers — only when the question is pure numeric
  // (avoid algebra with variables like x, y, a, b, n — string arithmetic on RHS/LHS
  // would be misleading).
  if (computed == null) {
    const hasVariable = /[a-zA-Z]/.test(qt.replace(/km|cm|mm|kg|mg|mL|ml/g,''));
    if (!hasVariable) {
      const av = tryArithmetic(qt);
      if (av != null) { computed = av; parseKind = 'arithmetic'; }
    }
  }

  let expectedIdxs = [];
  if (computed != null) {
    expectedIdxs = matchNumericToIndex(computed, opts);
    parsed++;
  } else if (pfResult) {
    // canonical string like "2²×3²" — strip circled digits and whitespace
    expectedIdxs = matchStringToIndex(pfResult.canonical, opts);
    if (expectedIdxs.length === 0) {
      // Try with '*' variants
      const alt = pfResult.canonical.replace(/×/g,'*');
      expectedIdxs = matchStringToIndex(alt, opts);
    }
    if (expectedIdxs.length) { parsed++; parseKind = 'prime-fact'; }
  }

  // Secondary signal: explanation
  const expIdx = answerFromExplanation(exp, opts);

  // Decide
  const currentAnswer = (r.answer || '').trim();
  const currentIdx = /^\d+$/.test(currentAnswer) ? parseInt(currentAnswer,10) : null;

  if (expectedIdxs.length === 1) {
    const want = expectedIdxs[0];
    // Secondary check: does explanation numerically mention the computed value?
    let expNumericAgree = false;
    if (computed != null && exp) {
      const numsInExp = (exp.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      expNumericAgree = numsInExp.some(v => numEq(v, computed));
    }
    const expAgree = expIdx == null ? true : expIdx === want;
    if (!expAgree) {
      suspicious++;
      suspectList.push({ id: r.id, reason: `compute=${want} but explanation-index=${expIdx}`, qt, opts, answer: currentAnswer, kind: parseKind });
      continue;
    }
    // If we can't corroborate with explanation at all, and current answer is different, flag as suspect instead of fixing
    if (currentIdx !== want && expIdx == null && !expNumericAgree && parseKind !== 'knowledge' && parseKind !== 'prime-fact') {
      suspicious++;
      suspectList.push({ id: r.id, reason: `compute=${want} but explanation does not corroborate; current=${currentIdx}`, qt, opts, answer: currentAnswer, kind: parseKind });
      continue;
    }
    if (currentIdx === want) { confirmed++; continue; }
    toFix++;
    fixes.push({ id: r.id, from: currentAnswer, to: String(want), qt, opts, explanation: exp, kind: parseKind, computed });
  } else if (expectedIdxs.length > 1) {
    // ambiguous — multiple options equal the computed value
    suspicious++;
    suspectList.push({ id: r.id, reason: `ambiguous matches=${expectedIdxs.join(',')}`, qt, opts, answer: currentAnswer, kind: parseKind });
  } else if (computed != null || pfResult) {
    // parsed but no option matches — do not touch
    skipped++;
    skippedLog.push({ id: r.id, reason: `parsed(${parseKind}) computed=${computed ?? pfResult.canonical} but no option match`, qt, opts });
  } else {
    // Couldn't parse; try explanation-only if it clearly says an index and mismatches
    if (expIdx != null && currentIdx != null && expIdx !== currentIdx) {
      suspicious++;
      suspectList.push({ id: r.id, reason: `explanation=${expIdx} disagrees with answer=${currentIdx} (unparsed)`, qt, opts, answer: currentAnswer });
    } else {
      skipped++;
    }
  }
}

// Apply
let applied = 0;
if (APPLY && fixes.length) {
  const upd = db.prepare('UPDATE content_questions SET answer=? WHERE id=?');
  const tx = db.transaction((list) => {
    for (const f of list) { upd.run(f.to, f.id); applied++; }
  });
  tx(fixes);
}

// ---------- report ----------
console.log('='.repeat(60));
console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
console.log(`scanned (JSON-array options): ${scanned}`);
console.log(`parsed:                        ${parsed}`);
console.log(`confirmed (answer correct):    ${confirmed}`);
console.log(`to-fix:                        ${toFix}`);
console.log(`suspicious (manual review):    ${suspicious}`);
console.log(`skipped (unparseable):         ${skipped}`);
if (APPLY) console.log(`APPLIED UPDATES:              ${applied}`);
console.log('='.repeat(60));

console.log('\n--- SAMPLE FIXES (first 10) ---');
for (const f of fixes.slice(0,10)) {
  console.log(`[id=${f.id}] ${f.qt}`);
  console.log(`  options=${JSON.stringify(f.opts)}`);
  console.log(`  before answer=${f.from}  -> after=${f.to}   (kind=${f.kind}, computed=${f.computed})`);
  console.log(`  explanation: ${String(f.explanation).slice(0,80)}`);
}

console.log('\n--- ALL FIXES (id, from->to) ---');
for (const f of fixes) console.log(`  ${f.id}: ${f.from} -> ${f.to}`);

console.log('\n--- SUSPECTS (need human review) ---');
for (const s of suspectList.slice(0, 30)) {
  console.log(`  [id=${s.id}] ${s.reason}`);
  console.log(`     qt=${s.qt}`);
  console.log(`     opts=${JSON.stringify(s.opts)} answer=${s.answer}`);
}
if (suspectList.length > 30) console.log(`  ... and ${suspectList.length-30} more`);

db.close();
