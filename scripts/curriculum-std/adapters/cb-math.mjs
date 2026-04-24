// 충북형 수학과 학습맵 v2 어댑터 (C형)
// - 파일: 3. 충북형_수학과_학습맵_계통도_KOFAC기준매핑_v2.xlsx
// - 공통 출력 (nodes/standards/standardNodes/standardLevels/stdIdMap) + 학습맵 엣지(mapEdges)
//
// 주의:
//  - 2단계ID 포맷: [E2|E4|E6|M3|H1]MATAnnBnnCnn
//  - 3단계ID 포맷: 위 + Dnn
//  - 학년 컬럼은 초등에서 "1, 2" 같은 문자열이 오고, 중/고는 1/2/3 raw 숫자이므로
//    school_level/grade_group 판정은 **ID prefix** 로 결정한다 (spec 의도 보존).
//    · E2 → 초, grade_group 2
//    · E4 → 초, grade_group 4
//    · E6 → 초, grade_group 6
//    · M3 → 중, grade_group 9
//    · H1 → 고, grade_group 10
//  - subject_code: 초=math-e, 중=math-m, 고=math-h
//  - 성취수준 레벨은 수학 파일에 없음 → standardLevels = []
//  - source='CB_MATH', version='v2'

import XLSX from 'xlsx';
import path from 'path';

const SHEET_NAME = '학습맵_리니어연결';
const SOURCE = 'CB_MATH';
const VERSION = 'v2';

// 성취기준 코드 포맷 (초 [2수..], 중 [9수..], 고 [10공수1-..-..] 등)
// 엑셀 실태 기준: 초/중 `[\d수\d{2}-\d{2}]`, 고 `[10공수[12]-\d{2}-\d{2}]`
const AC_CODE_STRICT = /^\[\d+[가-힣0-9]+\d{2}-\d{2}(-\d{2})?\]$/;
// plan.md 의 레퍼런스 패턴 (문서 목표). 고교용은 추가 segment 가 있어 통과하지 못함.
const AC_CODE_PLAN = /^\[\d+[가-힣]+\d{2}-\d{2}\]$/;

function prefixInfo(stdId) {
  const pfx = String(stdId || '').substring(0, 2);
  switch (pfx) {
    case 'E2': return { school_level: '초', grade_group: 2, subject_code: 'math-e' };
    case 'E4': return { school_level: '초', grade_group: 4, subject_code: 'math-e' };
    case 'E6': return { school_level: '초', grade_group: 6, subject_code: 'math-e' };
    case 'M3': return { school_level: '중', grade_group: 9, subject_code: 'math-m' };
    case 'H1': return { school_level: '고', grade_group: 10, subject_code: 'math-h' };
    default:   return null;
  }
}

// 2단계ID E2MATA01B01C01 → {area:'E2MATA01', d1:'E2MATA01B01', d2:'E2MATA01B01C01'}
function splitIds(id2) {
  const s = String(id2 || '');
  const mA = s.match(/^([EMH]\d[A-Z]{3}A\d{2})/);
  const mB = s.match(/^([EMH]\d[A-Z]{3}A\d{2}B\d{2})/);
  const mC = s.match(/^([EMH]\d[A-Z]{3}A\d{2}B\d{2}C\d{2})/);
  return {
    area: mA ? mA[1] : null,
    d1:   mB ? mB[1] : null,
    d2:   mC ? mC[1] : null,
  };
}

function splitMulti(s) {
  if (s === null || s === undefined) return [];
  return String(s)
    .split(/[,\n;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseSemester(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function parseFile(xlsxPath, options = {}) {
  const wb = XLSX.readFile(xlsxPath);
  if (!wb.Sheets[SHEET_NAME]) {
    throw new Error(`[cb-math] 시트 '${SHEET_NAME}' 를 찾을 수 없음: ${xlsxPath}`);
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: '' });

  const warnings = [];
  const nodesMap = new Map();          // id -> node
  const standardsMap = new Map();      // code -> {code, text, subject_code, grade_group}
  const standardNodes = [];            // {standard_code, node_id}
  const stdIdMapSet = new Set();       // dedup key: code|std_id
  const stdIdMap = [];                 // {standard_code, std_id, subject_code, grade_group}
  const mapEdgesSet = new Set();       // dedup key: from|to|type
  const mapEdges = [];                 // {from_node_id, to_node_id, edge_type}

  const upsertNode = (id, fields) => {
    if (!id) return;
    const existing = nodesMap.get(id);
    if (!existing) {
      nodesMap.set(id, { id, ...fields });
    } else {
      // 상위 노드는 여러 행에서 등장 → label 덮어쓰지 않음, 정보만 보존
      for (const k of Object.keys(fields)) {
        if (existing[k] === undefined || existing[k] === null || existing[k] === '') {
          existing[k] = fields[k];
        }
      }
    }
  };

  let sortCounter = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id2 = String(r['2단계ID'] || '').trim();
    const id3 = String(r['3단계ID'] || '').trim();
    if (!id2) {
      warnings.push(`row ${i + 2}: 2단계ID 누락`);
      continue;
    }

    const info = prefixInfo(id2);
    if (!info) {
      warnings.push(`row ${i + 2}: 알 수 없는 ID prefix (${id2})`);
      continue;
    }

    const { area, d1, d2 } = splitIds(id2);
    if (!area || !d1 || !d2) {
      warnings.push(`row ${i + 2}: ID 파싱 실패 (${id2})`);
      continue;
    }

    const base = {
      subject_code: info.subject_code,
      school_level: info.school_level,
      grade_group: info.grade_group,
      source: SOURCE,
      version: VERSION,
    };

    // depth=0 영역
    upsertNode(area, {
      ...base,
      depth: 0,
      parent_id: null,
      label: String(r['내용체계영역'] || '').trim(),
      sort_order: 0,
    });
    // depth=1 1단계
    upsertNode(d1, {
      ...base,
      depth: 1,
      parent_id: area,
      label: String(r['1단계내용요소'] || '').trim(),
      sort_order: 0,
    });
    // depth=2 2단계
    upsertNode(d2, {
      ...base,
      depth: 2,
      parent_id: d1,
      label: String(r['2단계내용요소'] || '').trim(),
      sort_order: 0,
    });

    // 리프: 3단계 있으면 depth=3, 없으면 depth=2 (=d2) 자신이 리프
    let leafId;
    if (id3) {
      leafId = id3;
      upsertNode(id3, {
        ...base,
        depth: 3,
        parent_id: d2,
        label: String(r['3단계내용요소'] || '').trim(),
        unit_name: String(r['단원명'] || '').trim() || null,
        apply_grade: r['적용학년'] === '' ? null : Number(r['적용학년']) || null,
        apply_semester: parseSemester(r['적용학기']),
        sort_order: ++sortCounter,
      });
    } else {
      leafId = d2;
      // d2 노드에 리프 특유 정보 보강
      const n = nodesMap.get(d2);
      if (n) {
        n.unit_name = n.unit_name || (String(r['단원명'] || '').trim() || null);
        n.apply_grade = n.apply_grade ?? (r['적용학년'] === '' ? null : Number(r['적용학년']) || null);
        n.apply_semester = n.apply_semester ?? parseSemester(r['적용학기']);
      }
    }

    // 성취기준
    const code = String(r['성취기준코드'] || '').trim();
    const text = String(r['성취기준'] || '').trim();
    if (code) {
      if (!standardsMap.has(code)) {
        standardsMap.set(code, {
          code,
          text,
          subject_code: info.subject_code,
          grade_group: info.grade_group,
        });
      }
      // N:N (중복 dedup)
      const key = `${code}|${leafId}`;
      if (!standardNodes.some((sn) => `${sn.standard_code}|${sn.node_id}` === key)) {
        standardNodes.push({ standard_code: code, node_id: leafId });
      }
      // std_id_map: code ↔ 2단계ID 로 매핑 (plan 기준 std_id는 D 이하 미포함)
      const mapKey = `${code}|${d2}`;
      if (!stdIdMapSet.has(mapKey)) {
        stdIdMapSet.add(mapKey);
        stdIdMap.push({
          standard_code: code,
          std_id: d2,
          subject_code: info.subject_code,
          grade_group: info.grade_group,
        });
      }
    }

    // 학습맵 엣지 - 선수
    for (const from of splitMulti(r['선수학습ID'])) {
      const k = `${from}|${leafId}|prerequisite`;
      if (!mapEdgesSet.has(k)) {
        mapEdgesSet.add(k);
        mapEdges.push({ from_node_id: from, to_node_id: leafId, edge_type: 'prerequisite' });
      }
    }
    // 학습맵 엣지 - 후속
    for (const to of splitMulti(r['후속학습ID'])) {
      const k = `${leafId}|${to}|next`;
      if (!mapEdgesSet.has(k)) {
        mapEdgesSet.add(k);
        mapEdges.push({ from_node_id: leafId, to_node_id: to, edge_type: 'next' });
      }
    }
  }

  const nodes = Array.from(nodesMap.values());
  const standards = Array.from(standardsMap.values());
  const standardLevels = []; // 수학 학습맵 파일에는 성취수준 없음

  return {
    nodes,
    standards,
    standardNodes,
    standardLevels,
    stdIdMap,
    mapEdges,
    warnings,
  };
}

// ---- selftest ----
export async function _selftest(xlsxFolder) {
  const fileName = '3. 충북형_수학과_학습맵_계통도_KOFAC기준매핑_v2.xlsx';
  const xlsxPath = path.join(xlsxFolder, fileName);
  const res = await parseFile(xlsxPath);

  const nodeIds = new Set(res.nodes.map((n) => n.id));
  const depthCount = {};
  for (const n of res.nodes) depthCount[n.depth] = (depthCount[n.depth] || 0) + 1;

  // 고아 엣지 검증
  const orphans = [];
  const prereqEdges = res.mapEdges.filter((e) => e.edge_type === 'prerequisite');
  const nextEdges = res.mapEdges.filter((e) => e.edge_type === 'next');
  for (const e of res.mapEdges) {
    if (!nodeIds.has(e.from_node_id) || !nodeIds.has(e.to_node_id)) {
      orphans.push(e);
      res.warnings.push(
        `orphan edge (${e.edge_type}): ${e.from_node_id} -> ${e.to_node_id}`
      );
    }
  }

  // 성취기준 코드 포맷 통과 비율
  let planPass = 0, strictPass = 0;
  for (const s of res.standards) {
    if (AC_CODE_PLAN.test(s.code)) planPass++;
    if (AC_CODE_STRICT.test(s.code)) strictPass++;
  }
  const planRate = res.standards.length
    ? ((planPass / res.standards.length) * 100).toFixed(1)
    : 'n/a';
  const strictRate = res.standards.length
    ? ((strictPass / res.standards.length) * 100).toFixed(1)
    : 'n/a';

  const report = {
    file: fileName,
    totals: {
      nodes: res.nodes.length,
      standards: res.standards.length,
      standardNodes: res.standardNodes.length,
      stdIdMap: res.stdIdMap.length,
      mapEdges: res.mapEdges.length,
      mapEdges_prerequisite: prereqEdges.length,
      mapEdges_next: nextEdges.length,
      warnings: res.warnings.length,
    },
    depthDistribution: depthCount,
    orphanEdges: orphans.length,
    standardCodeFormat: {
      planPatternPass: `${planPass}/${res.standards.length} (${planRate}%)`,
      strictPatternPass: `${strictPass}/${res.standards.length} (${strictRate}%)`,
      sampleFails: res.standards
        .filter((s) => !AC_CODE_PLAN.test(s.code))
        .slice(0, 5)
        .map((s) => s.code),
    },
  };

  console.log('[cb-math selftest]', JSON.stringify(report, null, 2));
  return report;
}

// CLI 실행: node scripts/curriculum-std/adapters/cb-math.mjs <xlsx폴더>
import { fileURLToPath } from 'url';
const __isMain = (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || ''); }
  catch { return false; }
})();
if (__isMain) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: node cb-math.mjs <xlsxFolder>');
    process.exit(1);
  }
  _selftest(folder).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
