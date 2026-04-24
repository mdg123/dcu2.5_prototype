// scripts/curriculum-std/adapters/kice-ext.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 교육과정 표준체계 엑셀 파서 어댑터 B형 (3단계 확장 스키마)
//   대상: (KICE) 영어과, (KOFAC) 정보과
//
// 표준 A형(kice-standard)와 호환되는 공통 출력 구조를 반환한다.
// {
//   nodes[], standards[], standardNodes[], standardLevels[], stdIdMap[], warnings[]
// }
//
// 호출:
//   import { parseFile, _selftest } from './adapters/kice-ext.mjs';
//   const out = await parseFile(xlsxPath);
//   await _selftest(folder);
// ─────────────────────────────────────────────────────────────────────────────

import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

// ─── 교과/학교급 판별 ────────────────────────────────────────────────────────

/** 파일명에서 교과 판별 */
function detectSubjectFamily(xlsxPath) {
  const name = path.basename(xlsxPath);
  if (name.includes('영어')) return 'english';
  if (name.includes('정보')) return 'info';
  return null;
}

/** 시트명에서 학교급 / 학년군 판별. null 반환 시 skip. */
function detectScope(sheetName, family) {
  // 공백/특수공백 허용 normalize (영어 초3~4는 `초등학교_ 3~4학년군`처럼 언더스코어 뒤 공백)
  const s = String(sheetName).replace(/\s+/g, ' ').trim();

  if (family === 'english') {
    if (/초등학교_\s*3\s*[~〜～]\s*4학년군/.test(s)) {
      return { subject_code: 'english-e', school_level: '초', grade_group: 4, grade_label: '3~4', sheet_kind: 'eng-e' };
    }
    if (/초등학교_\s*5\s*[~〜～]\s*6학년군/.test(s)) {
      return { subject_code: 'english-e', school_level: '초', grade_group: 6, grade_label: '5~6', sheet_kind: 'eng-e' };
    }
    if (/중학교_영어/.test(s)) {
      return { subject_code: 'english-m', school_level: '중', grade_group: 9, grade_label: '7~9', sheet_kind: 'eng-m' };
    }
    if (/고등학교_공통영어1/.test(s)) {
      return { subject_code: 'english-h', school_level: '고', grade_group: 10, grade_label: '10', sheet_kind: 'eng-h' };
    }
    if (/고등학교_공통영어2/.test(s)) {
      return { subject_code: 'english-h', school_level: '고', grade_group: 10, grade_label: '10', sheet_kind: 'eng-h' };
    }
    return null;
  }

  if (family === 'info') {
    if (/초등학교/.test(s)) {
      // 정보과 초등은 존재하지 않음 — skip
      return null;
    }
    if (/중학교_정보/.test(s)) {
      return { subject_code: 'info-m', school_level: '중', grade_group: 9, grade_label: '7~9', sheet_kind: 'info-m' };
    }
    if (/고등학교_정보/.test(s)) {
      return { subject_code: 'info-h', school_level: '고', grade_group: 12, grade_label: '10~12', sheet_kind: 'info-h' };
    }
    return null;
  }

  return null;
}

// ─── 컬럼 매핑 (시트 유형별) ─────────────────────────────────────────────────

/**
 * 각 sheet_kind 별로 고정 컬럼 인덱스를 반환.
 * 조사 보고서 docs/plans/excel-schema-survey.md + probe 실측 기반.
 *
 * levels 는 [{code, col}] 형태. col이 null이면 스킵.
 */
function getColumnMap(sheet_kind) {
  switch (sheet_kind) {
    case 'eng-e': // 초등 영어 18~19열
      return {
        id: 0,
        area: 4,
        lv1: 5,
        lv2: 6,
        lv3: 7,              // 대부분 공란
        precede: 8,          // (미사용, 향후)
        related: 9,          // (미사용, 향후)
        stdCode: 10,
        stdContent: 11,
        // 평가기준 A/B/C (대체로 공란)
        pBlockA: [
          { code: 'A', col: 12 },
          { code: 'B', col: 13 },
          { code: 'C', col: 14 },
        ],
        // 성취수준 A/B/C (채워짐) — 실제 사용 레벨
        levels: [
          { code: 'A', col: 15 },
          { code: 'B', col: 16 },
          { code: 'C', col: 17 },
        ],
      };
    case 'eng-m': // 중 영어 14열: 평가기준 A~E만 존재 (성취수준 레이블 없음)
      return {
        id: 0,
        area: 4,
        lv1: 5,
        lv2: 6,
        lv3: null,
        stdCode: 7,
        stdContent: 8,
        levels: [
          { code: 'A', col: 9 },
          { code: 'B', col: 10 },
          { code: 'C', col: 11 },
          { code: 'D', col: 12 },
          { code: 'E', col: 13 },
        ],
      };
    case 'eng-h': // 고 영어 41열. 평가기준 A~E 두 블록 반복. 뒤 블록만 채워짐.
      return {
        id: 0,
        area: 4,
        lv1: 5,
        lv2: 6,
        lv3: 7,
        precede: 8,
        related: 9,
        stdCode: 10,
        stdContent: 11,
        // 앞 블록 cols 12~16 (거의 전부 공란)
        pBlockA: [
          { code: 'A', col: 12 }, { code: 'B', col: 13 }, { code: 'C', col: 14 },
          { code: 'D', col: 15 }, { code: 'E', col: 16 },
        ],
        // 뒤 블록 cols 17~21 (실제 값)
        levels: [
          { code: 'A', col: 17 },
          { code: 'B', col: 18 },
          { code: 'C', col: 19 },
          { code: 'D', col: 20 },
          { code: 'E', col: 21 },
        ],
      };
    case 'info-m': // 중 정보 15열
      return {
        id: 0,
        area: 4,
        lv1: 5,
        lv2: 6,
        lv3: 7,
        stdCode: 8,
        stdContent: 9,
        levels: [
          { code: 'A', col: 10 },
          { code: 'B', col: 11 },
          { code: 'C', col: 12 },
          { code: 'D', col: 13 },
          { code: 'E', col: 14 },
        ],
      };
    case 'info-h': // 고 정보 16열 (마지막 공란)
      return {
        id: 0,
        area: 4,
        lv1: 5,
        lv2: 6,
        lv3: 7,
        stdCode: 8,
        stdContent: 9,
        levels: [
          { code: 'A', col: 10 },
          { code: 'B', col: 11 },
          { code: 'C', col: 12 },
          { code: 'D', col: 13 },
          { code: 'E', col: 14 },
        ],
      };
    default:
      return null;
  }
}

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function cell(row, idx) {
  if (idx == null || idx < 0) return '';
  const v = row[idx];
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function normCode(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, '').trim(); // `[9영01-01]` 내 공백 제거
}

// 2단계ID(리프) E4ENGA01B01C01 에서 prefix 추출
// prefix_level = 0 → depth 0 영역: E4ENGA01         (A01 까지)
// prefix_level = 1 → depth 1:       E4ENGA01B01     (B01 까지)
// prefix_level = 2 → depth 2 leaf:  E4ENGA01B01C01  (C01 까지; 전체)
const ID_REGEX = /^([EMH]\d+)([A-Z]{3})(A\d{2})(B\d{2})(C\d{2})(D\d{2})?$/;

function splitId(id) {
  const m = ID_REGEX.exec(id);
  if (!m) return null;
  const [, gPrefix, subjCode, a, b, c, d] = m;
  return {
    head: gPrefix + subjCode, // E4ENG
    a, b, c, d: d || null,
    depth0_id: gPrefix + subjCode + a,
    depth1_id: gPrefix + subjCode + a + b,
    depth2_id: gPrefix + subjCode + a + b + c,
    depth3_id: d ? (gPrefix + subjCode + a + b + c + d) : null,
  };
}

// 영어 3단계 ID는 파일에 없으므로 합성: leaf2_id + 'D01', 'D02' …
function synthesizeD(leaf2, ordinalWithin2) {
  const n = String(ordinalWithin2).padStart(2, '0');
  return `${leaf2}D${n}`;
}

// ─── 메인 파서 ───────────────────────────────────────────────────────────────

export async function parseFile(xlsxPath, options = {}) {
  const warnings = [];
  const nodes = [];
  const standards = [];
  const standardNodes = [];
  const standardLevels = [];
  const stdIdMap = [];

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`File not found: ${xlsxPath}`);
  }

  const family = detectSubjectFamily(xlsxPath);
  if (!family) {
    throw new Error(`Unsupported file (expected 영어과/정보과): ${path.basename(xlsxPath)}`);
  }
  const source = family === 'english' ? 'KICE' : 'KOFAC';
  const version = '2412';

  const wb = XLSX.readFile(xlsxPath);

  // 노드 dedup set: subject_code + id
  const seenNode = new Set();
  const seenStdNode = new Set();
  const seenStdLevel = new Set();
  const seenStdIdMap = new Set();
  const standardsByCode = new Map(); // code+subj+grade → idx

  // 3단계 ID는 leaf2 노드별로 순번 부여
  const d3CounterByLeaf2 = new Map();

  for (const sheetName of wb.SheetNames) {
    const scope = detectScope(sheetName, family);
    if (!scope) {
      if (family === 'info' && /초등학교/.test(sheetName)) {
        warnings.push(`[skip] 정보과 초등 시트는 존재하지 않음: "${sheetName}"`);
      } else {
        warnings.push(`[skip] unrecognized sheet: "${sheetName}"`);
      }
      continue;
    }

    const colMap = getColumnMap(scope.sheet_kind);
    if (!colMap) {
      warnings.push(`[skip] no column map for sheet_kind=${scope.sheet_kind}`);
      continue;
    }

    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    if (rows.length < 2) continue;

    // sort_order 카운터 (영역/1단계/2단계 각각)
    const sortByDepth = { 0: new Map(), 1: new Map(), 2: new Map(), 3: new Map() };
    function nextSort(depth, keyId) {
      const m = sortByDepth[depth];
      if (!m.has(keyId)) m.set(keyId, m.size + 1);
      return m.get(keyId);
    }

    let standardOrd = 0;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const id = cell(row, colMap.id);
      if (!id) continue;
      const parsed = splitId(id);
      if (!parsed) {
        warnings.push(`[${sheetName}] row ${r + 1}: ID 형식 불일치 "${id}" — skip`);
        continue;
      }

      const area = cell(row, colMap.area);
      const lv1 = cell(row, colMap.lv1);
      const lv2 = cell(row, colMap.lv2);
      const lv3 = colMap.lv3 != null ? cell(row, colMap.lv3) : '';
      const stdCodeRaw = cell(row, colMap.stdCode);
      const stdContent = cell(row, colMap.stdContent);
      const stdCode = normCode(stdCodeRaw);

      const baseNode = {
        subject_code: scope.subject_code,
        school_level: scope.school_level,
        grade_group: scope.grade_group,
        source,
        version,
      };

      // depth 0 — 영역
      if (area) {
        const d0 = parsed.depth0_id;
        const key0 = `${scope.subject_code}|${d0}`;
        if (!seenNode.has(key0)) {
          seenNode.add(key0);
          nodes.push({
            ...baseNode,
            id: d0,
            depth: 0,
            parent_id: null,
            label: area,
            sort_order: nextSort(0, d0),
          });
        }
      }

      // depth 1 — 1단계
      if (lv1) {
        const d1 = parsed.depth1_id;
        const key1 = `${scope.subject_code}|${d1}`;
        if (!seenNode.has(key1)) {
          seenNode.add(key1);
          nodes.push({
            ...baseNode,
            id: d1,
            depth: 1,
            parent_id: parsed.depth0_id,
            label: lv1,
            sort_order: nextSort(1, d1),
          });
        }
      }

      // depth 2 — 2단계 (리프 또는 depth3의 부모)
      if (lv2) {
        const d2 = parsed.depth2_id;
        const key2 = `${scope.subject_code}|${d2}`;
        if (!seenNode.has(key2)) {
          seenNode.add(key2);
          nodes.push({
            ...baseNode,
            id: d2,
            depth: 2,
            parent_id: parsed.depth1_id,
            label: lv2,
            sort_order: nextSort(2, d2),
          });
        }
      }

      // depth 3 — 3단계 (값 있을 때만)
      let leafId = parsed.depth2_id;
      if (lv3) {
        // 파일 ID 에 D 접미사 없는 경우(영어) 합성
        let d3 = parsed.depth3_id;
        if (!d3) {
          const count = (d3CounterByLeaf2.get(parsed.depth2_id) || 0) + 1;
          d3CounterByLeaf2.set(parsed.depth2_id, count);
          d3 = synthesizeD(parsed.depth2_id, count);
        }
        const key3 = `${scope.subject_code}|${d3}`;
        if (!seenNode.has(key3)) {
          seenNode.add(key3);
          nodes.push({
            ...baseNode,
            id: d3,
            depth: 3,
            parent_id: parsed.depth2_id,
            label: lv3,
            sort_order: nextSort(3, d3),
          });
        }
        leafId = d3;
      }

      // standard (성취기준)
      if (stdCode) {
        const stdKey = `${stdCode}|${scope.subject_code}|${scope.grade_group}`;
        if (!standardsByCode.has(stdKey)) {
          standardOrd += 1;
          standardsByCode.set(stdKey, standards.length);
          standards.push({
            code: stdCode,
            subject_code: scope.subject_code,
            school_level: scope.school_level,
            grade_group: scope.grade_group,
            grade_label: scope.grade_label,
            area: area || null,
            content: stdContent || null,
            sort_order: standardOrd,
            std_source: source,
            primary_node_id: leafId,
          });
        }

        // standard ↔ node
        const snKey = `${stdCode}|${leafId}`;
        if (!seenStdNode.has(snKey)) {
          seenStdNode.add(snKey);
          standardNodes.push({ standard_code: stdCode, node_id: leafId });
        }

        // std_id_map: 성취기준코드 ↔ 엑셀 표준체계 ID (원본 ID 그대로 사용)
        const mapKey = `${stdCode}|${id}`;
        if (!seenStdIdMap.has(mapKey)) {
          seenStdIdMap.add(mapKey);
          stdIdMap.push({
            standard_code: stdCode,
            std_id: id,
            subject_code: scope.subject_code,
            grade_group: scope.grade_group,
          });
        }

        // standardLevels (성취수준 / 평가기준-as-achievement)
        for (const lv of colMap.levels) {
          const desc = cell(row, lv.col);
          if (!desc) continue;
          const lvKey = `${stdCode}|${lv.code}`;
          if (seenStdLevel.has(lvKey)) continue;
          seenStdLevel.add(lvKey);
          standardLevels.push({
            standard_code: stdCode,
            level_code: lv.code,
            description: desc,
          });
        }
      } else {
        warnings.push(`[${sheetName}] row ${r + 1}: 성취기준코드 공란 (ID=${id})`);
      }
    }
  }

  return { nodes, standards, standardNodes, standardLevels, stdIdMap, warnings };
}

// ─── 셀프테스트 ──────────────────────────────────────────────────────────────

export async function _selftest(xlsxFolder) {
  const files = [
    '(KICE) 교육과정 표준체계_영어과_2412_최종.xlsx',
    '(KOFAC) 교육과정 표준체계_정보과_2412_최종.xlsx',
  ];

  const summary = [];

  for (const f of files) {
    const p = path.join(xlsxFolder, f);
    if (!fs.existsSync(p)) {
      console.error(`[selftest] NOT FOUND: ${p}`);
      continue;
    }
    console.log('\n===', f, '===');
    const out = await parseFile(p);
    const depth3Nodes = out.nodes.filter(n => n.depth === 3);

    console.log(`  nodes         : ${out.nodes.length}`);
    console.log(`    depth 0     : ${out.nodes.filter(n => n.depth === 0).length}`);
    console.log(`    depth 1     : ${out.nodes.filter(n => n.depth === 1).length}`);
    console.log(`    depth 2     : ${out.nodes.filter(n => n.depth === 2).length}`);
    console.log(`    depth 3     : ${depth3Nodes.length}`);
    console.log(`  standards     : ${out.standards.length}`);
    console.log(`  standardNodes : ${out.standardNodes.length}`);
    console.log(`  standardLevels: ${out.standardLevels.length}`);
    console.log(`  stdIdMap      : ${out.stdIdMap.length}`);
    console.log(`  warnings      : ${out.warnings.length}`);
    if (out.warnings.length) {
      const top = out.warnings.slice(0, 5);
      top.forEach(w => console.log('    - ' + w));
      if (out.warnings.length > 5) console.log(`    ... +${out.warnings.length - 5} more`);
    }

    summary.push({ file: f, ...{
      nodes: out.nodes.length,
      standards: out.standards.length,
      standardLevels: out.standardLevels.length,
      depth3: depth3Nodes.length,
    }});

    // 검증 1: depth 3 부모가 모두 depth 2 노드 내에 존재
    if (depth3Nodes.length > 0) {
      const d2ids = new Set(out.nodes.filter(n => n.depth === 2).map(n => n.id));
      const orphan = depth3Nodes.filter(n => !d2ids.has(n.parent_id));
      if (orphan.length > 0) {
        console.error(`  [FAIL] depth3 고아 노드 ${orphan.length}건: e.g. ${orphan[0].id} parent=${orphan[0].parent_id}`);
      } else {
        console.log(`  [OK]   depth3 부모가 모두 depth2 안에 존재`);
      }
    }

    // 검증 2: 영어 고등학교 시트에서 평가기준(성취수준) 값이 실제 채워져 있는지
    if (/영어/.test(f)) {
      const hLevels = out.standardLevels.filter(lv =>
        out.standards.some(s => s.code === lv.standard_code && s.school_level === '고')
      );
      if (hLevels.length === 0) {
        console.error(`  [FAIL] 영어 고등학교 성취수준(평가기준 뒤 블록) 값 0건 — 컬럼 인덱스 오류 의심`);
      } else {
        console.log(`  [OK]   영어 고등학교 성취수준 값 ${hLevels.length}건 (뒤 블록 col 17~21 에서 추출)`);
      }
    }

    // 검증 3: 정보과 초등 시트는 skip 되어 info-e 스코프 0건
    if (/정보/.test(f)) {
      const eCount = out.nodes.filter(n => n.subject_code === 'info-e').length;
      if (eCount === 0) {
        console.log(`  [OK]   info-e (정보과 초등) 0건 — 파일에 초등 시트 없음, 올바르게 skip`);
      } else {
        console.error(`  [FAIL] info-e 노드 ${eCount}건 — 초등 시트가 있으면 안 됨`);
      }
    }
  }

  console.log('\n=== Summary ===');
  for (const s of summary) {
    console.log(`  ${s.file}`);
    console.log(`    nodes=${s.nodes} standards=${s.standards} standardLevels=${s.standardLevels} depth3=${s.depth3}`);
  }

  return summary;
}

// CLI: node kice-ext.mjs <folder>
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('kice-ext.mjs')) {
  const folder = process.argv[2] || 'C:\\Users\\user\\OneDrive - 금성초등학교\\바탕 화면\\다채움 품질 제고사업 프로토타입 - 실동작\\교육과정표준체계_최종산출물_202412';
  _selftest(folder).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
