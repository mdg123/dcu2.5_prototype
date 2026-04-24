// scripts/curriculum-std/adapters/kice-standard.mjs
// KICE/KOFAC 교육과정 표준체계 엑셀 어댑터 — A형(표준 스키마) 전용
//  - 초등 12열 / 중·고 14열 고정 스키마 파일을 순수 파싱하여
//    curriculum_content_nodes / curriculum_standards / curriculum_standard_nodes /
//    curriculum_standard_levels / curriculum_std_id_map 에 주입 가능한
//    중간 모델을 반환한다.
//  - DB 접근 없음. 드라이버가 반환값을 받아 INSERT 한다.
//
// 담당 파일:
//   (KICE) 교육과정 표준체계_국어과_2412_최종.xlsx
//   (KICE) 교육과정 표준체계_사회과_2412_최종.xlsx
//   (KICE)) 교육과정 표준체계_실과및기술가정_2412_최종.xlsx  (파일명 `))` 주의)
//   (KOFAC) 교육과정 표준체계_과학과_2412_최종.xlsx

import * as XLSX from 'xlsx';
import path from 'node:path';
import fs from 'node:fs';

// ──────────────────────────────────────────────────────────
// 1. subjects 테이블에 등록된 코드 (미등록은 skip 대상)
//    db/curriculum.js 의 subjectData 와 동기화. tech-home-* 는 미등록.
// ──────────────────────────────────────────────────────────
const REGISTERED_SUBJECTS = new Set([
  'korean-e', 'math-e', 'social-e', 'science-e', 'english-e', 'info-e',
  'moral-e', 'music-e', 'art-e', 'pe-e', 'practical-e',
  'korean-m', 'math-m', 'social-m', 'history-m', 'science-m', 'english-m', 'info-m',
  'korean-h', 'math-h', 'social-h', 'history-h', 'science-h', 'english-h', 'info-h',
  'tech-home-m', 'tech-home-h',
]);

// 파일명 → 기본 교과 루트 (초/중/고 분기는 시트명에서 결정)
function detectSubjectFamily(xlsxPath) {
  const base = path.basename(xlsxPath);
  if (base.includes('국어')) return 'korean';
  if (base.includes('사회')) return 'social';
  if (base.includes('실과') || base.includes('기술가정')) return 'practical';
  if (base.includes('과학')) return 'science';
  if (base.includes('영어')) return 'english';
  if (base.includes('정보')) return 'info';
  return 'unknown';
}

// 파일명 → source
function detectSource(xlsxPath) {
  const base = path.basename(xlsxPath);
  if (base.includes('KOFAC')) return 'KOFAC';
  return 'KICE';
}

// 시트명에서 학교급/학년군 추출
//  예: '초등학교_3-4학년군_국어'    → { school_level:'초', grade_group:4 }
//      '초등학교_5-6학년군_사회'    → { school_level:'초', grade_group:6 }
//      '초등학교_실과'              → { school_level:'초', grade_group:6 } (3~6 통합)
//      '중학교_국어' / '중학교_사회' / '중학교_기술가정' / '중학교_과학' → { '중', 9 }
//      '고등학교_공통국어1' / '고등학교_통합사회1' 등 → { '고', 10 }
function parseSheetScope(sheetName) {
  const s = sheetName.trim();
  if (s.startsWith('초등학교') || s.startsWith('초등')) {
    // 학년군 숫자 추출
    const m = s.match(/(\d)\s*[-~]\s*(\d)/);
    if (m) {
      const g = parseInt(m[2], 10); // 4 또는 6
      return { school_level: '초', grade_group: g };
    }
    // 실과처럼 학년군 표기가 없는 경우 — 초등 실과는 5~6학년군
    return { school_level: '초', grade_group: 6 };
  }
  if (s.startsWith('중학교') || s.startsWith('중등')) {
    return { school_level: '중', grade_group: 9 };
  }
  if (s.startsWith('고등학교') || s.startsWith('고등')) {
    return { school_level: '고', grade_group: 10 };
  }
  return null;
}

// ID 접미 파싱: E4KORA01B01C01 → { areaId:'E4KORA01', l1Id:'E4KORA01B01', leafId:'E4KORA01B01C01' }
function splitIdHierarchy(id) {
  if (typeof id !== 'string') return null;
  const m = id.match(/^([EMH][1-9][A-Z]{3})(A\d{2})(B\d{2})(C\d{2})(D\d{2})?$/);
  if (!m) return null;
  const [, prefix, a, b, c] = m;
  return {
    areaId: prefix + a,
    l1Id: prefix + a + b,
    leafId: prefix + a + b + c,
  };
}

// subject_code 결정 (과목 컬럼·학교급 기반)
function resolveSubjectCode(family, schoolLevel, subjectColValue, warnings) {
  const subj = String(subjectColValue || '').trim();
  let code;
  if (family === 'social') {
    // 중·고에서 '역사'로 시작하면 history 계열
    if ((schoolLevel === '중' || schoolLevel === '고') && subj.startsWith('역사')) {
      code = schoolLevel === '중' ? 'history-m' : 'history-h';
    } else {
      code = schoolLevel === '초' ? 'social-e' : (schoolLevel === '중' ? 'social-m' : 'social-h');
    }
  } else if (family === 'practical') {
    if (schoolLevel === '초') code = 'practical-e';
    else if (schoolLevel === '중') code = 'tech-home-m';
    else code = 'tech-home-h';
  } else if (family === 'korean') {
    code = schoolLevel === '초' ? 'korean-e' : (schoolLevel === '중' ? 'korean-m' : 'korean-h');
  } else if (family === 'science') {
    code = schoolLevel === '초' ? 'science-e' : (schoolLevel === '중' ? 'science-m' : 'science-h');
  } else if (family === 'english') {
    code = schoolLevel === '초' ? 'english-e' : (schoolLevel === '중' ? 'english-m' : 'english-h');
  } else if (family === 'info') {
    code = schoolLevel === '중' ? 'info-m' : 'info-h';
  } else {
    code = null;
  }
  return code;
}

// 헤더명 정규화 (공백·특수문자 제거)
function normHeader(h) {
  return String(h || '').replace(/\s+/g, '').replace(/[()]/g, '').trim();
}

// 하나의 시트 → rows (헤더 제거)
function readSheetRows(ws) {
  // defval: '' 로 빈 셀도 유지
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
}

// 한 행이 비었는지
function isEmptyRow(cells) {
  if (!cells) return true;
  return cells.every(c => c == null || String(c).trim() === '');
}

// ──────────────────────────────────────────────────────────
// 본 파서
// ──────────────────────────────────────────────────────────
export async function parseFile(xlsxPath, options = {}) {
  const warnings = [];
  const nodes = []; // dedup via Map
  const nodeMap = new Map(); // id → node
  const standards = [];
  const standardsSeen = new Set();
  const standardNodes = [];
  const standardNodesSeen = new Set();
  const standardLevels = [];
  const standardLevelsSeen = new Set();
  const stdIdMap = [];
  const stdIdMapSeen = new Set();

  const family = detectSubjectFamily(xlsxPath);
  const source = detectSource(xlsxPath);
  const version = '2412';

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`xlsx 파일 없음: ${xlsxPath}`);
  }
  const buf = fs.readFileSync(xlsxPath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });

  for (const sheetName of wb.SheetNames) {
    const scope = parseSheetScope(sheetName);
    if (!scope) {
      warnings.push(`시트 스코프 판정 실패, 스킵: ${sheetName}`);
      continue;
    }
    const ws = wb.Sheets[sheetName];
    const rows = readSheetRows(ws);
    if (!rows.length) continue;

    const header = rows[0].map(normHeader);
    // 표준 컬럼 인덱스 매핑 (국어·사회·실과·과학 공통)
    //   0 ID | 1 교과 | 2 과목 | 3 학년 | 4 내용체계영역 | 5 1단계 | 6 2단계 |
    //   7 성취기준코드 | 8 성취기준 | 9 성취수준A | 10 B | 11 C | (중·고) 12 D | 13 E
    // 인덱스는 헤더명으로 찾아 견고하게.
    const idx = {};
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      if (h === 'ID') idx.id = i;
      else if (h === '교과') idx.subject = i;
      else if (h === '과목') idx.course = i;
      else if (h === '학년') idx.grade = i;
      else if (h === '내용체계영역') idx.area = i;
      else if (h === '1단계내용요소') idx.l1 = i;
      else if (h === '2단계내용요소') idx.l2 = i;
      else if (h === '성취기준코드') idx.stdCode = i;
      else if (h === '성취기준') idx.stdText = i;
      else if (h === '성취수준A') idx.lvA = i;
      else if (h === '성취수준B') idx.lvB = i;
      else if (h === '성취수준C') idx.lvC = i;
      else if (h === '성취수준D') idx.lvD = i;
      else if (h === '성취수준E') idx.lvE = i;
    }
    if (idx.id == null || idx.stdCode == null || idx.area == null) {
      warnings.push(`헤더 판정 실패, 스킵: ${sheetName}`);
      continue;
    }

    // subject_code 결정 — 첫 데이터 행의 '과목' 컬럼으로 추정 (행별로도 재검증)
    let prevSubjectCode = null;
    let sortCounterLeaf = 0;
    let sortCounterL1 = 0;
    let sortCounterArea = 0;
    // dedup 방식은 노드 id 기준, sort_order 는 등장 순
    const seenAreaInSheet = new Set();
    const seenL1InSheet = new Set();

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (isEmptyRow(cells)) continue;
      const rawId = cells[idx.id];
      if (!rawId || !String(rawId).trim()) continue;
      const id = String(rawId).trim();
      const hier = splitIdHierarchy(id);
      if (!hier) {
        warnings.push(`ID 포맷 비표준, 행 스킵: ${sheetName} row=${r + 1} id=${id}`);
        continue;
      }

      // subject_code: options.subjectOverride 가 우선
      let subjectCode = null;
      const courseVal = cells[idx.course];
      if (options.subjectOverride && typeof options.subjectOverride === 'function') {
        subjectCode = options.subjectOverride({
          family, schoolLevel: scope.school_level, courseVal, sheetName,
        });
      }
      if (!subjectCode) {
        subjectCode = resolveSubjectCode(family, scope.school_level, courseVal, warnings);
      }
      if (!subjectCode) {
        warnings.push(`교과코드 판정 실패, 행 스킵: ${sheetName} row=${r + 1}`);
        continue;
      }
      if (!REGISTERED_SUBJECTS.has(subjectCode)) {
        if (prevSubjectCode !== subjectCode) {
          warnings.push(`sheet ${sheetName} skipped: subject code ${subjectCode} not found`);
          prevSubjectCode = subjectCode;
        }
        continue;
      }
      prevSubjectCode = subjectCode;

      const areaLabel = String(cells[idx.area] || '').trim();
      const l1Label = String(cells[idx.l1] || '').trim();
      const l2Label = String(cells[idx.l2] || '').trim();
      const stdCode = String(cells[idx.stdCode] || '').trim();
      const stdText = String(cells[idx.stdText] || '').trim();

      if (!areaLabel || !l1Label || !l2Label) {
        warnings.push(`라벨 누락, 행 스킵: ${sheetName} row=${r + 1} id=${id}`);
        continue;
      }
      if (!stdCode) {
        warnings.push(`성취기준코드 누락, 행 스킵: ${sheetName} row=${r + 1} id=${id}`);
        continue;
      }

      // depth 0 영역 노드
      if (!nodeMap.has(hier.areaId)) {
        if (!seenAreaInSheet.has(hier.areaId)) {
          seenAreaInSheet.add(hier.areaId);
          sortCounterArea++;
        }
        const n = {
          id: hier.areaId,
          subject_code: subjectCode,
          school_level: scope.school_level,
          grade_group: scope.grade_group,
          depth: 0,
          parent_id: null,
          label: areaLabel,
          sort_order: sortCounterArea,
          source, version,
        };
        nodes.push(n); nodeMap.set(n.id, n);
      }
      // depth 1
      if (!nodeMap.has(hier.l1Id)) {
        if (!seenL1InSheet.has(hier.l1Id)) {
          seenL1InSheet.add(hier.l1Id);
          sortCounterL1++;
        }
        const n = {
          id: hier.l1Id,
          subject_code: subjectCode,
          school_level: scope.school_level,
          grade_group: scope.grade_group,
          depth: 1,
          parent_id: hier.areaId,
          label: l1Label,
          sort_order: sortCounterL1,
          source, version,
        };
        nodes.push(n); nodeMap.set(n.id, n);
      }
      // depth 2 (리프)
      if (!nodeMap.has(hier.leafId)) {
        sortCounterLeaf++;
        const n = {
          id: hier.leafId,
          subject_code: subjectCode,
          school_level: scope.school_level,
          grade_group: scope.grade_group,
          depth: 2,
          parent_id: hier.l1Id,
          label: l2Label,
          sort_order: sortCounterLeaf,
          source, version,
        };
        nodes.push(n); nodeMap.set(n.id, n);
      }

      // standards (upsert by code — 첫 등장 레코드 보존)
      if (!standardsSeen.has(stdCode)) {
        standardsSeen.add(stdCode);
        // grade_label: 엑셀 '학년' 컬럼 원값
        const gradeLabel = String(cells[idx.grade] || '').trim();
        standards.push({
          code: stdCode,
          subject_code: subjectCode,
          school_level: scope.school_level,
          grade_group: scope.grade_group,
          grade_label: gradeLabel,
          area: areaLabel,
          content: stdText,
          sort_order: standards.length + 1,
          std_source: source,
          primary_node_id: hier.leafId,
        });
      }

      // standard ↔ node (N:N)
      const sKey = `${stdCode}\u0000${hier.leafId}`;
      if (!standardNodesSeen.has(sKey)) {
        standardNodesSeen.add(sKey);
        standardNodes.push({ standard_code: stdCode, node_id: hier.leafId });
      }

      // standard levels (A~E, 비어있으면 skip)
      const levelMap = [
        ['A', idx.lvA], ['B', idx.lvB], ['C', idx.lvC],
        ['D', idx.lvD], ['E', idx.lvE],
      ];
      for (const [lc, colIdx] of levelMap) {
        if (colIdx == null) continue;
        const desc = String(cells[colIdx] || '').trim();
        if (!desc) continue;
        const lKey = `${stdCode}\u0000${lc}`;
        if (standardLevelsSeen.has(lKey)) continue;
        standardLevelsSeen.add(lKey);
        standardLevels.push({ standard_code: stdCode, level_code: lc, description: desc });
      }

      // stdIdMap
      const mKey = `${stdCode}\u0000${hier.leafId}`;
      if (!stdIdMapSeen.has(mKey)) {
        stdIdMapSeen.add(mKey);
        stdIdMap.push({
          standard_code: stdCode,
          std_id: hier.leafId,
          subject_code: subjectCode,
          grade_group: scope.grade_group,
        });
      }
    }
  }

  return { nodes, standards, standardNodes, standardLevels, stdIdMap, warnings };
}

// ──────────────────────────────────────────────────────────
// 자체 smoke test
// ──────────────────────────────────────────────────────────
const STD_CODE_RE = /^\[\d+[가-힣A-Za-z]+(?:\([^)]+\))?\d+(?:-\d+)?-\d+\]$/;
const STD_ID_RE_ELEM = /^E[246][A-Z]{3}A\d{2}B\d{2}C\d{2}$/;
const STD_ID_RE_MH = /^[MH][1-9][A-Z]{3}A\d{2}B\d{2}C\d{2}$/;

const A_FILES = [
  '(KICE) 교육과정 표준체계_국어과_2412_최종.xlsx',
  '(KICE) 교육과정 표준체계_사회과_2412_최종.xlsx',
  '(KICE)) 교육과정 표준체계_실과및기술가정_2412_최종.xlsx',
  '(KOFAC) 교육과정 표준체계_과학과_2412_최종.xlsx',
];

export async function _selftest(xlsxFolder) {
  if (!xlsxFolder || !fs.existsSync(xlsxFolder)) {
    throw new Error(`_selftest: xlsxFolder 경로 없음: ${xlsxFolder}`);
  }
  const report = [];
  let hadError = false;

  for (const fname of A_FILES) {
    const full = path.join(xlsxFolder, fname);
    if (!fs.existsSync(full)) {
      console.error(`[selftest] 파일 없음: ${full}`);
      hadError = true;
      continue;
    }
    const result = await parseFile(full);
    const { nodes, standards, standardNodes, standardLevels, stdIdMap, warnings } = result;

    const errs = [];
    if (!(nodes.length > 0)) errs.push('nodes 0');
    if (!(standards.length > 0)) errs.push('standards 0');

    // parent_id 무결성
    const idSet = new Set(nodes.map(n => n.id));
    for (const n of nodes) {
      if (n.depth === 0) {
        if (n.parent_id != null) errs.push(`depth0 parent not null: ${n.id}`);
      } else {
        if (!n.parent_id || !idSet.has(n.parent_id)) {
          errs.push(`parent 부재: ${n.id} -> ${n.parent_id}`);
          break;
        }
      }
    }
    // standardNodes.node_id ∈ nodes.id
    for (const sn of standardNodes) {
      if (!idSet.has(sn.node_id)) {
        errs.push(`standardNodes orphan: ${sn.standard_code}->${sn.node_id}`);
        break;
      }
    }
    // standard code 정규식
    for (const s of standards) {
      if (!STD_CODE_RE.test(s.code)) {
        errs.push(`비표준 성취기준코드: ${s.code}`);
        break;
      }
    }
    // std_id 정규식
    for (const m of stdIdMap) {
      const ok = STD_ID_RE_ELEM.test(m.std_id) || STD_ID_RE_MH.test(m.std_id);
      if (!ok) {
        errs.push(`비표준 std_id: ${m.std_id}`);
        break;
      }
    }

    if (errs.length) {
      hadError = true;
      console.error(`[selftest] ${fname}\n  - ${errs.join('\n  - ')}`);
    }
    report.push({
      file: fname,
      nodes: nodes.length,
      standards: standards.length,
      standardNodes: standardNodes.length,
      standardLevels: standardLevels.length,
      stdIdMap: stdIdMap.length,
      warnings: warnings.length,
      warningSample: warnings.slice(0, 5),
    });
  }

  // 요약 출력
  console.log('\n=== KICE-Standard Adapter Selftest Report ===');
  for (const r of report) {
    console.log(
      `- ${r.file}\n` +
      `    nodes=${r.nodes}  standards=${r.standards}  ` +
      `stdNodes=${r.standardNodes}  levels=${r.standardLevels}  ` +
      `stdIdMap=${r.stdIdMap}  warnings=${r.warnings}`
    );
    if (r.warningSample.length) {
      for (const w of r.warningSample) console.log(`      ! ${w}`);
    }
  }
  if (hadError) {
    throw new Error('selftest 실패 — 위 에러 로그 참조');
  }
  return report;
}

// CLI 엔트리: `node kice-standard.mjs <xlsxFolder>` 로도 실행 가능
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const folder = process.argv[2] || process.env.EXCEL_DIR;
  _selftest(folder).then(
    () => process.exit(0),
    (e) => { console.error(e); process.exit(1); }
  );
}
