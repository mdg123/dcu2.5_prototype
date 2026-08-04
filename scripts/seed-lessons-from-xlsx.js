require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * ⚠⚠⚠ [DEPRECATED — 2026-05-27] ⚠⚠⚠
 *
 * 이 스크립트는 더 이상 사용되지 않습니다. 실행 시 즉시 종료(no-op)됩니다.
 *
 * [폐기 사유]
 *  - 본 스크립트는 임시 엑셀 `통합_학습맵_계통도_연결_완성.xlsx` 를 기준으로 작성됨.
 *  - 해당 엑셀은 KOFAC 기준 미반영으로 인해 2026-05-26 부로 폐기됨.
 *  - 공식 단일 정본(SSOT)은 `통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx` 로 통일됨.
 *
 * [대체 스크립트]
 *   node scripts/seed-lessons-from-kofac-v2.js          # dry-run
 *   node scripts/seed-lessons-from-kofac-v2.js --apply  # 실제 DB 변경
 *
 *   (엣지 재시드)
 *   node scripts/import-learning-map-edges.mjs --truncate
 *
 * [원본 주석 — 히스토리 보존용]
 * 통합_학습맵_계통도_연결_완성.xlsx 의 차시(3단계) 데이터를
 * learning_map_nodes(level=3)에 시드/UPSERT 한다.
 *
 * 배경:
 *  - 기존 시드는 1162개 차시를 넣었지만 ID/매핑이 어긋나 엑셀의 차시 854개가 누락.
 *  - 예) "두 자리 수의 곱셈(2)" 단원은 차시 1개(나눗셈)만 등록되어 있음 (사용자 지적).
 *
 * 정책:
 *  1) 단원(level=2) 매칭은 (과목, 적용학년, 적용학기, 단원명) 으로 함.
 *  2) 차시 node_id는 엑셀의 '3단계ID' 그대로 사용.
 *  3) 이미 존재하는 차시 노드는 lesson_name/achievement_code/parent_node_id/area/sort_order 를 갱신(UPSERT).
 *     단, node_contents/edges 등 외래키 매핑은 보존 (node_id 자체는 변경하지 않음).
 *  4) 엑셀 단원명 모순 케이스 (예: lesson_name이 나눗셈인데 단원명은 곱셈으로 잘못 기재된 행)는
 *     lesson_name 키워드와 단원명 키워드의 부정합을 감지해 후보 단원을 재선택. 단순한 모순(예: '÷' vs '곱셈')에 한정.
 *  5) sort_order는 엑셀 행 순서 인덱스(전역 번호)를 사용. 기존 차시는 행 순서 따라 일관 정렬.
 */
'use strict';

// === 안전 차단 ===
// 본 스크립트는 잘못된 엑셀을 참조하므로 실행 시 경고 후 즉시 종료한다.
console.warn('==============================================================');
console.warn('[DEPRECATED] scripts/seed-lessons-from-xlsx.js 는 더 이상 사용되지 않습니다.');
console.warn('이 스크립트는 폐기된 엑셀(통합_학습맵_계통도_연결_완성.xlsx)을 참조합니다.');
console.warn('');
console.warn('대신 다음을 실행하세요:');
console.warn('  node scripts/seed-lessons-from-kofac-v2.js --apply');
console.warn('  node scripts/import-learning-map-edges.mjs --truncate');
console.warn('==============================================================');
process.exit(0);

// eslint-disable-next-line no-unreachable
/* ── 아래는 히스토리 보존용 코드 (실행되지 않음) ─────────────────── */

const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data', 'dacheum.db');
const XLSX_PATH = path.join(__dirname, '..', '통합_학습맵_계통도_연결_완성.xlsx');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const wb = XLSX.readFile(XLSX_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
console.log(`[seed] 엑셀 행 수: ${rows.length}`);

// level=2 단원 인덱스
const units = db.prepare(`SELECT node_id, subject, grade_level, grade, semester, area, unit_name FROM learning_map_nodes WHERE node_level = 2`).all();
const unitIdx = new Map(); // key=subj|g|s|unit → unit row
for (const u of units) {
  const key = `${u.subject}|${u.grade}|${u.semester}|${(u.unit_name || '').trim()}`;
  unitIdx.set(key, u);
}
// 보조 매핑: (g,s,단원명) → unit (과목 prefix 무시)
const unitIdxLoose = new Map();
for (const u of units) {
  const key = `${u.grade}|${u.semester}|${(u.unit_name || '').trim()}`;
  if (!unitIdxLoose.has(key)) unitIdxLoose.set(key, u);
}

function resolveUnit(row) {
  const uname = (row['단원명'] || '').trim();
  const subj = row['과목'] || row['교과'] || '';
  const g = parseInt(row['적용학년']);
  const s = parseInt(row['적용학기']);
  if (!uname || !g || !s) return null;
  const keys = [
    `${subj}|${g}|${s}|${uname}`,
    `수학|${g}|${s}|${uname}`,
    `수학과|${g}|${s}|${uname}`,
  ];
  for (const k of keys) if (unitIdx.has(k)) return unitIdx.get(k);
  return unitIdxLoose.get(`${g}|${s}|${uname}`) || null;
}

// 잘못된 단원명 행 (lesson_name과 단원명이 명백히 모순) 재매핑
// 휴리스틱: lesson_name에 '÷' 또는 '나눗셈/나누어/나머지/몫' 단어가 들어있는데 단원명에 '곱셈'만 있고 '나눗' 없음 → 미스매치
function isLessonUnitMismatch(lessonName, unitName) {
  if (!lessonName || !unitName) return false;
  const isDivLesson = /÷|나눗|나누어|나머지|몫/.test(lessonName);
  const isMulUnit = /곱셈/.test(unitName) && !/나눗|÷/.test(unitName);
  if (isDivLesson && isMulUnit) return true;
  const isMulLesson = /×/.test(lessonName);
  const isDivUnit = /나눗|÷/.test(unitName) && !/곱셈|×/.test(unitName);
  if (isMulLesson && isDivUnit) return true;
  return false;
}

// 학년/학기 안에서 lesson_name과 호환되는 단원 후보 찾기
function findAlternateUnit(row, lessonName) {
  const g = parseInt(row['적용학년']);
  const s = parseInt(row['적용학기']);
  const isDiv = /÷|나눗|나누어|나머지|몫/.test(lessonName);
  const isMul = /×/.test(lessonName);
  // 같은 학년/학기/수와연산 단원 중에서 단원명에 곱셈/나눗셈 키워드가 lesson_name과 일치하는 것
  const candidates = units.filter(u => u.grade === g && u.semester === s && /수와/.test(u.area || ''));
  if (isDiv) {
    return candidates.find(u => /나눗|÷/.test(u.unit_name || '')) || null;
  }
  if (isMul) {
    return candidates.find(u => /곱셈|×/.test(u.unit_name || '')) || null;
  }
  return null;
}

// 기존 차시 노드
const existingNodes = new Map();
for (const r of db.prepare(`SELECT id, node_id, parent_node_id, lesson_name, area, subject, grade, semester, achievement_code, sort_order FROM learning_map_nodes WHERE node_level = 3`).all()) {
  existingNodes.set(r.node_id, r);
}

// 통계
const stats = {
  totalRows: 0,
  skippedNoUnit: 0,
  insert: 0,
  updateOnlyMeta: 0,
  reparent: 0,
  alreadyMatched: 0,
  mismatchCorrected: 0,
  perGradeSemester: {},
};

const insertStmt = db.prepare(`
  INSERT INTO learning_map_nodes
    (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name,
     achievement_code, achievement_text, node_level, parent_node_id, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)
`);

const updateStmt = db.prepare(`
  UPDATE learning_map_nodes
     SET subject = ?, grade_level = ?, grade = ?, semester = ?, area = ?,
         unit_name = ?, lesson_name = ?, achievement_code = ?, achievement_text = ?,
         parent_node_id = ?, sort_order = ?
   WHERE node_id = ? AND node_level = 3
`);

const tx = db.transaction((data) => {
  for (const r of data) {
    if (r.action === 'insert') insertStmt.run(...r.args);
    else updateStmt.run(...r.args);
  }
});

const operations = [];
const examples = { inserted: [], reparented: [], mismatchCorrected: [] };

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  stats.totalRows++;
  const lessonId = row['3단계ID'];
  const lessonName = (row['3단계내용요소'] || '').trim();
  if (!lessonId || !lessonName) { stats.skippedNoUnit++; continue; }
  let unit = resolveUnit(row);
  if (!unit) { stats.skippedNoUnit++; continue; }

  // 모순 감지 → 후보 단원 재선택
  if (isLessonUnitMismatch(lessonName, unit.unit_name)) {
    const alt = findAlternateUnit(row, lessonName);
    if (alt) {
      stats.mismatchCorrected++;
      if (examples.mismatchCorrected.length < 10) {
        examples.mismatchCorrected.push({ lessonId, lessonName, fromUnit: unit.unit_name, toUnit: alt.unit_name });
      }
      unit = alt;
    }
  }

  const subj = unit.subject || row['과목'] || '수학';
  const gradeLevel = unit.grade_level || '초';
  const g = unit.grade;
  const s = unit.semester;
  const area = unit.area || row['내용체계영역'] || '';
  const unitName = unit.unit_name;
  const achCode = row['성취기준코드'] || null;
  const achText = row['성취기준'] || null;
  const sortOrder = i + 1; // 엑셀 행 순서

  const exist = existingNodes.get(lessonId);
  if (!exist) {
    operations.push({
      action: 'insert',
      args: [lessonId, subj, gradeLevel, g, s, area, unitName, lessonName, achCode, achText, unit.node_id, sortOrder],
    });
    stats.insert++;
    if (examples.inserted.length < 8) examples.inserted.push({ lessonId, lessonName, unit: unitName });
    const k = g + '-' + s;
    stats.perGradeSemester[k] = (stats.perGradeSemester[k] || 0) + 1;
  } else {
    const isReparent = exist.parent_node_id !== unit.node_id;
    if (isReparent) {
      stats.reparent++;
      if (examples.reparented.length < 8) examples.reparented.push({
        lessonId, lessonName,
        fromParent: exist.parent_node_id, toParent: unit.node_id, toUnit: unitName,
      });
    } else if (
      exist.lesson_name === lessonName && exist.achievement_code === achCode &&
      exist.sort_order === sortOrder && exist.area === area
    ) {
      stats.alreadyMatched++;
      continue; // 변경 없음
    } else {
      stats.updateOnlyMeta++;
    }
    operations.push({
      action: 'update',
      args: [subj, gradeLevel, g, s, area, unitName, lessonName, achCode, achText, unit.node_id, sortOrder, lessonId],
    });
  }
}

console.log('\n[seed] 결과 요약');
console.log('  엑셀 총 행:', stats.totalRows);
console.log('  단원 매칭 실패(스킵):', stats.skippedNoUnit);
console.log('  단원-차시 모순 자동 교정:', stats.mismatchCorrected);
console.log('  INSERT(신규 차시):', stats.insert);
console.log('  UPDATE (parent 재매핑):', stats.reparent);
console.log('  UPDATE (메타만 갱신):', stats.updateOnlyMeta);
console.log('  변경 없음(이미 일치):', stats.alreadyMatched);
console.log('  학년/학기별 INSERT 수:', stats.perGradeSemester);

if (examples.mismatchCorrected.length) {
  console.log('\n[seed] 단원-차시 모순 자동 교정 샘플:');
  examples.mismatchCorrected.forEach(e => console.log(' ', e));
}
if (examples.reparented.length) {
  console.log('\n[seed] parent 재매핑 샘플:');
  examples.reparented.forEach(e => console.log(' ', e));
}
if (examples.inserted.length) {
  console.log('\n[seed] INSERT 샘플:');
  examples.inserted.forEach(e => console.log(' ', e));
}

if (!APPLY) {
  console.log('\n[seed] --apply 옵션 없음 → 변경하지 않음 (dry-run).');
  db.close();
  process.exit(0);
}

console.log('\n[seed] --apply: 트랜잭션 실행 중...');
tx(operations);
console.log('[seed] 완료. 적용 변경:', operations.length);
db.close();
