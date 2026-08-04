require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
/**
 * KOFAC v2의 "삼각형, 사각형, 원과 (그) 구성 요소" 표기 모호성 보정.
 * KOFAC v2는 7행이 "원과 그 구성 요소" 표기, 1행이 "원과 구성 요소" 표기로 혼재.
 * 다채움 DB의 단원명은 "삼각형, 사각형, 원과 그 구성 요소" 로 통일하고,
 * 양쪽 표기 모두 같은 단원 노드에 매핑되도록 보정한다.
 *
 * - 단원 노드(level=2) "삼각형, 사각형, 원과 구성 요소" → "삼각형, 사각형, 원과 그 구성 요소" 로 unit_name 통일
 * - 스킵된 7개 차시(E2MATA03B02C06D01 ~ C12D01)를 해당 단원에 INSERT/UPDATE
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dacheum.db');
const XLSX_PATH = path.join(ROOT, '통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const wb = XLSX.readFile(XLSX_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });

// 1) 단원 노드: 두 표기 후보 확인
const CANON = '삼각형, 사각형, 원과 그 구성 요소';
const VARIANT = '삼각형, 사각형, 원과 구성 요소';

const u1 = db.prepare('SELECT * FROM learning_map_nodes WHERE node_level=2 AND unit_name=? AND grade=2 AND semester=1').get(CANON);
const u2 = db.prepare('SELECT * FROM learning_map_nodes WHERE node_level=2 AND unit_name=? AND grade=2 AND semester=1').get(VARIANT);
console.log('Canon 단원:', u1 ? u1.node_id : 'null');
console.log('Variant 단원:', u2 ? u2.node_id : 'null');

let canonId = null;
if (u1 && !u2) {
  canonId = u1.node_id;
} else if (!u1 && u2) {
  // variant만 있음 → 이름 변경
  console.log('Variant 단원만 존재 → unit_name 변경');
  if (APPLY) db.prepare('UPDATE learning_map_nodes SET unit_name=? WHERE node_id=?').run(CANON, u2.node_id);
  canonId = u2.node_id;
} else if (u1 && u2) {
  // 둘 다 있으면 variant의 자식 노드들을 canon으로 옮기고 variant 삭제
  console.log('두 표기 모두 존재 → variant를 canon으로 통합');
  if (APPLY) {
    db.prepare('UPDATE learning_map_nodes SET parent_node_id=? WHERE parent_node_id=?').run(u1.node_id, u2.node_id);
    db.prepare('DELETE FROM learning_map_nodes WHERE node_id=?').run(u2.node_id);
  }
  canonId = u1.node_id;
}

console.log('Canon 단원 노드 ID:', canonId);
if (!canonId) {
  console.error('단원 노드를 찾을 수 없습니다. 종료.');
  process.exit(1);
}

// 2) 스킵된 7건 차시 INSERT/UPDATE
const targetRows = rows.filter((r) => {
  const u = (r['단원명'] || '').toString().trim();
  return u === CANON || u === VARIANT;
});
console.log('대상 차시 행:', targetRows.length);

const insertStmt = db.prepare(`
  INSERT INTO learning_map_nodes (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name, achievement_code, achievement_text, node_level, parent_node_id, sort_order)
  VALUES (?, ?, '초', ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)
`);
const updateStmt = db.prepare(`
  UPDATE learning_map_nodes SET subject=?, grade=?, semester=?, area=?, unit_name=?, lesson_name=?, achievement_code=?, achievement_text=?, parent_node_id=?, sort_order=?
  WHERE node_id=? AND node_level=3
`);

let inserted = 0, updated = 0;
const tx = db.transaction(() => {
  for (let i = 0; i < targetRows.length; i++) {
    const r = targetRows[i];
    const lessonId = r['3단계ID'];
    const lessonName = (r['3단계내용요소'] || '').toString().trim();
    if (!lessonId || !lessonName) continue;
    const subj = r['과목'] || '수학';
    const area = r['내용체계영역'] || '';
    const achCode = r['성취기준코드'] || null;
    const achText = r['성취기준'] || null;
    const g = parseInt(r['적용학년']);
    const s = parseInt(r['적용학기']);
    const idx = rows.findIndex((x) => x['3단계ID'] === lessonId);
    const sortOrder = idx + 1;
    const exist = db.prepare('SELECT * FROM learning_map_nodes WHERE node_id=? AND node_level=3').get(lessonId);
    if (!exist) {
      insertStmt.run(lessonId, subj, g, s, area, CANON, lessonName, achCode, achText, canonId, sortOrder);
      inserted++;
    } else {
      updateStmt.run(subj, g, s, area, CANON, lessonName, achCode, achText, canonId, sortOrder, lessonId);
      updated++;
    }
  }
});

if (!APPLY) {
  console.log('[dry] 시뮬레이션 종료. INSERT/UPDATE 미실행.');
  db.close();
  process.exit(0);
}
tx();
console.log('[apply] INSERT:', inserted, '/ UPDATE:', updated);
db.close();
