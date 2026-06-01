/**
 * 통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx 를 기준으로 learning_map_nodes 차시(level=3)를 재시드한다.
 *
 * 정책:
 *  1) KOFAC v2 1162행을 정본으로 한다.
 *  2) level=2 단원 매핑은 (학년, 학기, 단원명) 우선, 없으면 (과목, 학년, 학기, 단원명).
 *  3) KOFAC v2에 있는 차시 노드는 INSERT 또는 UPDATE (parent_node_id, lesson_name, achievement_code,
 *     achievement_text, area, sort_order, unit_name 갱신).
 *  4) KOFAC v2에 없는 OLD-only level=3 노드(약 854개)는 DELETE.
 *     - 단, user_node_status / node_contents / learning_map_edges 에 참조된 노드는
 *       lesson_name이 일치하는 KOFAC v2 노드로 user_node_status.node_id 마이그레이션 후 DELETE.
 *  5) 단원명이 KOFAC v2에서 변경된 경우 (예: "일차함수와 그 그래프" → "일차함수와 그래프")
 *     기존 단원 노드(level=2)의 unit_name을 KOFAC v2 값으로 UPDATE. 신규 단원(예: "삼각형, 사각형, 원과 구성 요소")
 *     은 신규 level=2 노드 생성.
 *  6) DB 자동 백업: data/dacheum.db.backup-20260527-pre-kofac-v2
 *
 * 사용:
 *   node scripts/seed-lessons-from-kofac-v2.js          # dry-run
 *   node scripts/seed-lessons-from-kofac-v2.js --apply  # 실제 변경
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'dacheum.db');
const XLSX_PATH = path.join(ROOT, '통합_학습맵_계통도_KOFAC기준매핑_v2.xlsx');
const BACKUP_PATH = path.join(ROOT, 'data', 'dacheum.db.backup-20260527-pre-kofac-v2');

if (APPLY) {
  if (!fs.existsSync(BACKUP_PATH)) {
    console.log('[backup] 백업 생성:', BACKUP_PATH);
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    // WAL/SHM도 함께 복사 (정합성)
    for (const ext of ['-wal', '-shm']) {
      const src = DB_PATH + ext;
      if (fs.existsSync(src)) fs.copyFileSync(src, BACKUP_PATH + ext);
    }
  } else {
    console.log('[backup] 백업 이미 존재 (스킵):', BACKUP_PATH);
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const wb = XLSX.readFile(XLSX_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
console.log(`[seed] KOFAC v2 행 수: ${rows.length}`);

// 1) 단원(level=2) 인덱스
let units = db.prepare(`SELECT node_id, subject, grade_level, grade, semester, area, unit_name FROM learning_map_nodes WHERE node_level=2`).all();
function rebuildUnitIdx() {
  const byKey = new Map();
  const byLoose = new Map();
  for (const u of units) {
    byKey.set(`${u.subject}|${u.grade}|${u.semester}|${(u.unit_name || '').trim()}`, u);
    const lk = `${u.grade}|${u.semester}|${(u.unit_name || '').trim()}`;
    if (!byLoose.has(lk)) byLoose.set(lk, u);
  }
  return { byKey, byLoose };
}
let { byKey: unitIdx, byLoose: unitIdxLoose } = rebuildUnitIdx();

// 2) KOFAC v2에서 등장하는 모든 (학년, 학기, 단원명) 추출
const xlsxUnits = new Map(); // key=g-s-name → {subject, area, ...}
for (const r of rows) {
  const uname = (r['단원명'] || '').toString().trim();
  const g = parseInt(r['적용학년']);
  const s = parseInt(r['적용학기']);
  const subj = r['과목'] || '수학';
  const area = r['내용체계영역'] || '';
  if (!uname || !g || !s) continue;
  const key = `${g}|${s}|${uname}`;
  if (!xlsxUnits.has(key)) xlsxUnits.set(key, { subject: subj, area, grade: g, semester: s, unit_name: uname });
}

// 3) 단원명 변경 매핑 (OLD → NEW) 자동 추정: 같은 (학년/학기)에서 비슷한 단원명 매칭
//    KOFAC v2 단원명이 DB에 없을 때, 같은 학년/학기에서 lesson 키워드 유사도가 높은 단원을 매칭
const newUnitsOnly = [];
const renamedUnits = []; // {dbUnit, newName}
for (const [key, xu] of xlsxUnits) {
  const dbUnit = unitIdxLoose.get(key);
  if (dbUnit) continue;
  // 비슷한 단원 탐색: 같은 g/s, unit_name이 KOFAC 이름의 일부 또는 거꾸로
  const candidates = units.filter((u) => u.grade === xu.grade && u.semester === xu.semester);
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cn = c.unit_name || '';
    // 단순 점수: 공통 글자 비율
    const setA = new Set(cn.replace(/\s/g, ''));
    const setB = new Set(xu.unit_name.replace(/\s/g, ''));
    let common = 0;
    setA.forEach((ch) => { if (setB.has(ch)) common++; });
    const score = common / Math.max(setA.size, setB.size);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= 0.7) {
    renamedUnits.push({ dbUnit: best, newName: xu.unit_name, score: bestScore });
  } else {
    newUnitsOnly.push(xu);
  }
}

console.log('\n[seed] 단원명 변경 감지 (rename):');
renamedUnits.forEach((r) => console.log(`  "${r.dbUnit.unit_name}" → "${r.newName}" (${r.dbUnit.node_id}, sim=${r.score.toFixed(2)})`));
console.log('[seed] 신규 단원 (DB에 없음):');
newUnitsOnly.forEach((u) => console.log(`  + ${u.grade}-${u.semester} | ${u.unit_name}`));

// 4) DB의 기존 level=3 노드들
const existingLessons = new Map();
for (const r of db.prepare(`SELECT node_id, parent_node_id, lesson_name, achievement_code, unit_name, grade, semester, sort_order, area FROM learning_map_nodes WHERE node_level=3`).all()) {
  existingLessons.set(r.node_id, r);
}

// 5) KOFAC v2 차시 ID 집합
const xlsxLessonIds = new Set(rows.filter((r) => r['3단계ID']).map((r) => r['3단계ID']));

// 6) OLD-only level=3 노드 (삭제 또는 마이그레이션 대상)
const orphanIds = [...existingLessons.keys()].filter((id) => !xlsxLessonIds.has(id));

// 외래키 참조 노드
const ncRefSet = new Set(db.prepare(`SELECT DISTINCT node_id FROM node_contents`).all().map((r) => r.node_id));
const unsRefSet = new Set(db.prepare(`SELECT DISTINCT node_id FROM user_node_status`).all().map((r) => r.node_id));
const edgeFromSet = new Set(db.prepare(`SELECT DISTINCT from_node_id AS id FROM learning_map_edges`).all().map((r) => r.id));
const edgeToSet = new Set(db.prepare(`SELECT DISTINCT to_node_id AS id FROM learning_map_edges`).all().map((r) => r.id));

const orphanToMigrate = []; // { oldId, newId, refs: {nc, uns, edges} }
const orphanToDelete = [];
for (const oid of orphanIds) {
  const refs = {
    nc: ncRefSet.has(oid),
    uns: unsRefSet.has(oid),
    edges: edgeFromSet.has(oid) || edgeToSet.has(oid),
  };
  if (refs.nc || refs.uns || refs.edges) {
    // KOFAC v2 동일 lesson_name 차시로 마이그레이션
    const old = existingLessons.get(oid);
    const match = rows.find((r) => (r['3단계내용요소'] || '').trim() === (old.lesson_name || '').trim()
      && parseInt(r['적용학년']) === old.grade && parseInt(r['적용학기']) === old.semester);
    if (match) {
      orphanToMigrate.push({ oldId: oid, newId: match['3단계ID'], refs, lesson: old.lesson_name });
    } else {
      // 매칭 실패 — 안전상 보존 (parent_node_id만 null로 두고 삭제하지 않음)
      console.warn('[migrate] 매칭 실패 (보존):', oid, old.lesson_name);
    }
  } else {
    orphanToDelete.push(oid);
  }
}

console.log(`\n[seed] orphan 노드: ${orphanIds.length}개`);
console.log(`  - 마이그레이션 대상 (외래키 있음): ${orphanToMigrate.length}`);
orphanToMigrate.forEach((m) => console.log(`     ${m.oldId} → ${m.newId} | ${m.lesson} | refs=${JSON.stringify(m.refs)}`));
console.log(`  - 단순 삭제 대상 (참조 없음): ${orphanToDelete.length}`);

// 7) INSERT/UPDATE 계획 수립
const stats = {
  unitsRename: renamedUnits.length,
  unitsInsert: newUnitsOnly.length,
  lessonInsert: 0,
  lessonUpdate: 0,
  lessonNoop: 0,
  skipNoUnit: 0,
  orphanMigrate: orphanToMigrate.length,
  orphanDelete: orphanToDelete.length,
};

const insertUnitStmt = db.prepare(`
  INSERT INTO learning_map_nodes (node_id, subject, grade_level, grade, semester, area, unit_name, node_level, sort_order)
  VALUES (?, ?, '초', ?, ?, ?, ?, 2, ?)
`);
const updateUnitNameStmt = db.prepare(`UPDATE learning_map_nodes SET unit_name = ? WHERE node_id = ?`);
const insertLessonStmt = db.prepare(`
  INSERT INTO learning_map_nodes
    (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name,
     achievement_code, achievement_text, node_level, parent_node_id, sort_order)
  VALUES (?, ?, '초', ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)
`);
const updateLessonStmt = db.prepare(`
  UPDATE learning_map_nodes
     SET subject=?, grade=?, semester=?, area=?, unit_name=?, lesson_name=?,
         achievement_code=?, achievement_text=?, parent_node_id=?, sort_order=?
   WHERE node_id=? AND node_level=3
`);

function genUnitId() {
  return 'U' + crypto.randomBytes(8).toString('hex');
}

const tx = db.transaction(() => {
  // 7-1) 단원명 rename
  for (const r of renamedUnits) {
    updateUnitNameStmt.run(r.newName, r.dbUnit.node_id);
  }
  // 7-2) 신규 단원 INSERT (next sort_order from max + offset)
  const maxSortStmt = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM learning_map_nodes WHERE node_level=2`);
  let nextSort = maxSortStmt.get().m + 1;
  for (const u of newUnitsOnly) {
    const id = genUnitId();
    insertUnitStmt.run(id, u.subject, u.grade, u.semester, u.area, u.unit_name, nextSort++);
  }
  // 단원 인덱스 재구축
  units = db.prepare(`SELECT node_id, subject, grade_level, grade, semester, area, unit_name FROM learning_map_nodes WHERE node_level=2`).all();
  ({ byKey: unitIdx, byLoose: unitIdxLoose } = rebuildUnitIdx());

  // 7-3) orphan 마이그레이션: user_node_status / node_contents / edges 의 node_id 교체
  //      단, 신규 ID로 이미 같은 (user_id, content_id 등) 행이 있으면 충돌 회피
  for (const m of orphanToMigrate) {
    // user_node_status 충돌 확인
    if (m.refs.uns) {
      const conflict = db.prepare('SELECT id FROM user_node_status WHERE node_id=? AND user_id IN (SELECT user_id FROM user_node_status WHERE node_id=?)').all(m.newId, m.oldId);
      if (conflict.length === 0) {
        db.prepare(`UPDATE user_node_status SET node_id=? WHERE node_id=?`).run(m.newId, m.oldId);
      } else {
        // 동일 user_id가 신규 ID 행이 이미 있다면 oldId 행 삭제
        db.prepare(`DELETE FROM user_node_status WHERE node_id=? AND user_id IN (SELECT user_id FROM user_node_status WHERE node_id=?)`).run(m.oldId, m.newId);
        db.prepare(`UPDATE user_node_status SET node_id=? WHERE node_id=?`).run(m.newId, m.oldId);
      }
    }
    if (m.refs.nc) {
      db.prepare(`UPDATE OR IGNORE node_contents SET node_id=? WHERE node_id=?`).run(m.newId, m.oldId);
      db.prepare(`DELETE FROM node_contents WHERE node_id=?`).run(m.oldId);
    }
    if (m.refs.edges) {
      db.prepare(`UPDATE OR IGNORE learning_map_edges SET from_node_id=? WHERE from_node_id=?`).run(m.newId, m.oldId);
      db.prepare(`UPDATE OR IGNORE learning_map_edges SET to_node_id=? WHERE to_node_id=?`).run(m.newId, m.oldId);
    }
  }

  // 7-4) orphan 삭제
  const delLessonStmt = db.prepare(`DELETE FROM learning_map_nodes WHERE node_id=? AND node_level=3`);
  const allOrphans = [...orphanToDelete, ...orphanToMigrate.map((m) => m.oldId)];
  for (const id of allOrphans) {
    delLessonStmt.run(id);
  }

  // 7-5) KOFAC v2 차시 INSERT/UPDATE
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lessonId = r['3단계ID'];
    const lessonName = (r['3단계내용요소'] || '').toString().trim();
    if (!lessonId || !lessonName) { stats.skipNoUnit++; continue; }
    const uname = (r['단원명'] || '').toString().trim();
    const g = parseInt(r['적용학년']);
    const s = parseInt(r['적용학기']);
    if (!uname || !g || !s) { stats.skipNoUnit++; continue; }
    const unit = unitIdxLoose.get(`${g}|${s}|${uname}`)
      || unitIdx.get(`${r['과목'] || '수학'}|${g}|${s}|${uname}`);
    if (!unit) { stats.skipNoUnit++; continue; }

    const subj = unit.subject || r['과목'] || '수학';
    const area = unit.area || r['내용체계영역'] || '';
    const achCode = r['성취기준코드'] || null;
    const achText = r['성취기준'] || null;
    const sortOrder = i + 1;

    const exist = existingLessons.get(lessonId);
    if (!exist) {
      insertLessonStmt.run(lessonId, subj, g, s, area, unit.unit_name, lessonName, achCode, achText, unit.node_id, sortOrder);
      stats.lessonInsert++;
    } else {
      const same = exist.parent_node_id === unit.node_id
        && exist.lesson_name === lessonName
        && exist.achievement_code === achCode
        && exist.sort_order === sortOrder
        && exist.unit_name === unit.unit_name
        && exist.area === area;
      if (same) {
        stats.lessonNoop++;
      } else {
        updateLessonStmt.run(subj, g, s, area, unit.unit_name, lessonName, achCode, achText, unit.node_id, sortOrder, lessonId);
        stats.lessonUpdate++;
      }
    }
  }
});

console.log('\n[seed] 변경 계획 요약 (dry):');
console.log('  단원명 rename:', stats.unitsRename);
console.log('  신규 단원 INSERT:', stats.unitsInsert);
console.log('  orphan 마이그레이션:', stats.orphanMigrate);
console.log('  orphan 삭제:', stats.orphanDelete);

if (!APPLY) {
  console.log('\n[seed] --apply 옵션 없음 → 변경하지 않음 (dry-run).');
  // 시뮬레이션을 위해 트랜잭션을 실행하고 ROLLBACK 효과 — better-sqlite3 transaction은 명시적 throw 시 롤백
  // 여기선 그냥 종료
  db.close();
  process.exit(0);
}

console.log('\n[seed] --apply: 트랜잭션 실행 중...');
tx();
console.log('[seed] 완료. 차시 변경 요약:');
console.log('  INSERT:', stats.lessonInsert);
console.log('  UPDATE:', stats.lessonUpdate);
console.log('  변경 없음:', stats.lessonNoop);
console.log('  스킵(단원 매칭 실패):', stats.skipNoUnit);
db.close();
