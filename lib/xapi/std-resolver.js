// lib/xapi/std-resolver.js
// ─────────────────────────────────────────────────────────────
// 이벤트 페이로드의 표준체계 ID/성취기준 코드를 DB 와 맞물려
// xAPI statement 에 박을 "완전한 성취기준 컨텍스트"로 변환.
//
// 입력 예:
//   { curriculum_standard_ids: 'E4KORA01B01C01,E4KORA01B02C03',
//     achievement_codes: '[4국01-01]',
//     subject_code: 'korean-e', grade_group: 4 }
//
// 출력:
//   {
//     items: [{
//       std_id, code, content, area, subject_code, grade_group,
//       ancestors: [...]         // closure 체인 (리프 포함)
//     }, ...],
//     std_ids:  [...],           // xAPI extension 'curriculum-standard-id' 배열
//     codes:    [...],           // 'achievement-code' 배열
//     primary_std_id, subject_code, grade_group,
//     ancestor_union: Set<string>  // stats 업서트용 (중복 제거)
//     warnings: [...]
//   }
// ─────────────────────────────────────────────────────────────
const db = require('../../db');

/** 쉼표/공백 허용 CSV 또는 배열을 Set 으로 정규화 */
function toSet(v) {
  if (!v) return new Set();
  if (Array.isArray(v)) return new Set(v.map(x => String(x).trim()).filter(Boolean));
  return new Set(String(v).split(/[,\s]+/).map(s => s.trim()).filter(Boolean));
}

/** 성취기준 코드 괄호 없는 형태도 허용 → 정규화 */
function normalizeAchievementCode(code) {
  const t = String(code || '').trim();
  if (!t) return null;
  if (t.startsWith('[') && t.endsWith(']')) return t;
  return `[${t}]`;
}

// 준비된 statement
const selMapByStdId = db.prepare(
  'SELECT standard_code, std_id, subject_code, grade_group FROM curriculum_std_id_map WHERE std_id = ?'
);
const selMapByCode = db.prepare(
  'SELECT standard_code, std_id, subject_code, grade_group FROM curriculum_std_id_map WHERE standard_code = ?'
);
const selStdMeta = db.prepare(
  'SELECT code, content, area, subject_code, grade_group, primary_node_id FROM curriculum_standards WHERE code = ?'
);
const selNodeMeta = db.prepare(
  'SELECT id, subject_code, grade_group, school_level, depth, label FROM curriculum_content_nodes WHERE id = ?'
);
const selAncestors = db.prepare(
  'SELECT ancestor_id FROM curriculum_node_descendants WHERE descendant_id = ? AND depth_diff >= 0 ORDER BY depth_diff'
);

/**
 * 이벤트 페이로드 → 표준체계 컨텍스트
 * @param {object} input
 * @returns {object}
 */
function resolveStandardContext(input = {}) {
  const warnings = [];
  const stdIdSet  = toSet(input.curriculum_standard_ids);
  const codeSet   = new Set(
    Array.from(toSet(input.achievement_codes)).map(normalizeAchievementCode).filter(Boolean)
  );
  const subject_code = input.subject_code || null;
  const grade_group  = input.grade_group != null ? Number(input.grade_group) : null;

  // 양방향 보강
  // std_id → code
  for (const sid of stdIdSet) {
    const rows = selMapByStdId.all(sid);
    for (const r of rows) codeSet.add(r.standard_code);
  }
  // code → std_id
  for (const c of codeSet) {
    const rows = selMapByCode.all(c);
    for (const r of rows) stdIdSet.add(r.std_id);
  }
  // code 이 아예 매핑 없는 legacy 인 경우: primary_node_id 로 보강
  for (const c of codeSet) {
    if (![...stdIdSet].some(sid => selMapByCode.all(c).some(r => r.std_id === sid))) {
      const meta = selStdMeta.get(c);
      if (meta && meta.primary_node_id) stdIdSet.add(meta.primary_node_id);
    }
  }

  // item 배열 조립
  const items = [];
  const ancestor_union = new Set();
  let primary_subject = subject_code;
  let primary_grade = grade_group;

  // code 기준으로 item 을 만들되, code 가 전혀 없으면 std_id 자체를 item 으로
  if (codeSet.size > 0) {
    for (const c of codeSet) {
      const meta = selStdMeta.get(c);
      const mapRows = selMapByCode.all(c);
      const linkedStdIds = mapRows.map(r => r.std_id);
      // ancestors 수집
      for (const sid of linkedStdIds) {
        const ancs = selAncestors.all(sid).map(r => r.ancestor_id);
        ancs.forEach(a => ancestor_union.add(a));
      }
      items.push({
        code: c,
        std_id: linkedStdIds[0] || (meta && meta.primary_node_id) || null,
        std_ids: linkedStdIds,
        content: meta ? meta.content : null,
        area: meta ? meta.area : null,
        subject_code: (meta && meta.subject_code) || subject_code || null,
        grade_group:  (meta && meta.grade_group)  != null ? meta.grade_group  : grade_group,
        ancestors: linkedStdIds.flatMap(sid => selAncestors.all(sid).map(r => r.ancestor_id)),
      });
      if (!primary_subject) primary_subject = meta && meta.subject_code;
      if (primary_grade == null) primary_grade = meta && meta.grade_group;
    }
  } else if (stdIdSet.size > 0) {
    for (const sid of stdIdSet) {
      const node = selNodeMeta.get(sid);
      const ancs = selAncestors.all(sid).map(r => r.ancestor_id);
      ancs.forEach(a => ancestor_union.add(a));
      items.push({
        code: null,
        std_id: sid,
        std_ids: [sid],
        content: node ? node.label : null,
        area: null,
        subject_code: (node && node.subject_code) || subject_code || null,
        grade_group:  (node && node.grade_group)  != null ? node.grade_group  : grade_group,
        ancestors: ancs,
      });
      if (!primary_subject) primary_subject = node && node.subject_code;
      if (primary_grade == null) primary_grade = node && node.grade_group;
    }
  } else {
    warnings.push('표준체계 ID / 성취기준 코드 가 모두 비어있음');
  }

  const std_ids = Array.from(stdIdSet);
  const codes   = Array.from(codeSet);

  return {
    items,
    std_ids,
    codes,
    primary_std_id: std_ids[0] || null,
    subject_code: primary_subject || null,
    grade_group:  primary_grade != null ? primary_grade : null,
    ancestor_union, // Set — 집계 업서트에 사용
    warnings,
  };
}

module.exports = { resolveStandardContext, normalizeAchievementCode };
