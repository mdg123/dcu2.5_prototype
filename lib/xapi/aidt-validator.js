// lib/xapi/aidt-validator.js
// ─────────────────────────────────────────────────────────────
// AIDT 기술규격 v2.2 간이 validator (Phase 1).
// KERIS JSON Schema 별첨 파일 미수신 상태에서, PDF §1.2 + §1.5 구조에 따른
// 최소 필수 필드만 검사한다. 정밀 schema 검증은 Phase 2 에서 보강.
//
//   validateStatement(statement) → { ok:boolean, errors:string[] }
//   validateRecent(limit=10)     → spool 최근 N건 dry-validate
// ─────────────────────────────────────────────────────────────
const db = require('../../db');
const { AIDT_DOMAIN } = require('./common');

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PDF §1.3 — 10개 학습활동 영역에 대응하는 activity-type slug
const VALID_ACTIVITY_TYPES = new Set([
  'media', 'assessment', 'assignment',
  'image', 'document', 'practice', 'etc-content', // navigation 4분기
  'objective',
  'keyword', 'question', // query 2분기
  'social-learning',
  'comprehension-survey', 'emotion-survey', 'emotion-today-survey', // survey 3분기
  'annotation',
  'feedback', 'class', // teaching 2분기
]);

/**
 * 단일 statement 가 AIDT 호환 골격을 만족하는지 검사.
 */
function validateStatement(statement) {
  const errors = [];
  const s = statement;
  if (!s || typeof s !== 'object') {
    return { ok: false, errors: ['statement is not an object'] };
  }

  // id (xAPI 1.0.3 표준 — UUID)
  if (!s.id) {
    errors.push('id: missing (xAPI Statement id (UUID v4) required for idempotency)');
  } else if (!UUID_RE.test(s.id)) {
    errors.push(`id: not UUID format: ${s.id}`);
  }

  // timestamp
  if (!s.timestamp) {
    errors.push('timestamp: missing');
  } else if (!TIMESTAMP_RE.test(s.timestamp)) {
    errors.push(`timestamp: not ISO 8601 with ms+offset/Z: ${s.timestamp}`);
  }

  // actor
  if (!s.actor) {
    errors.push('actor: missing');
  } else {
    if (s.actor.objectType !== 'Agent') errors.push(`actor.objectType !== 'Agent'`);
    if (!s.actor.account) {
      errors.push('actor.account: missing');
    } else {
      if (!s.actor.account.homePage) errors.push('actor.account.homePage: missing');
      if (!s.actor.account.name) {
        errors.push('actor.account.name (학습자 UUID): missing');
      } else if (!UUID_RE.test(s.actor.account.name)) {
        errors.push(`actor.account.name: not UUID format: ${s.actor.account.name}`);
      }
    }
  }

  // verb
  if (!s.verb || !s.verb.id) {
    errors.push('verb.id: missing');
  } else if (!s.verb.id.startsWith(`${AIDT_DOMAIN}/xapi/profiles/`)) {
    errors.push(`verb.id: not AIDT standard URL (expected aidtbook.kr/xapi/profiles/): ${s.verb.id}`);
  }
  if (!s.verb || !s.verb.display) {
    errors.push('verb.display: missing');
  }

  // object
  if (!s.object) {
    errors.push('object: missing');
  } else {
    if (s.object.objectType !== 'Activity') errors.push(`object.objectType !== 'Activity'`);
    if (!s.object.id) errors.push('object.id: missing');
    const defType = s.object.definition && s.object.definition.type;
    if (!defType) {
      errors.push('object.definition.type: missing');
    } else if (!defType.startsWith(`${AIDT_DOMAIN}/xapi/activity-type/`)) {
      errors.push(`object.definition.type: not AIDT path (expected /xapi/activity-type/): ${defType}`);
    } else {
      const slug = defType.split('/').pop();
      if (!VALID_ACTIVITY_TYPES.has(slug)) {
        // Phase 1 에서는 경고만 (builder 별 type 키가 표준 slug 와 다를 수 있음)
        errors.push(`object.definition.type: unknown activity-type slug '${slug}' (Phase 2 에서 정합 예정)`);
      }
    }
  }

  // context
  if (!s.context) {
    errors.push('context: missing');
  } else {
    if (!s.context.platform) errors.push('context.platform: missing');
    const ext = s.context.extensions || {};
    const partnerKey = `${AIDT_DOMAIN}/xapi/profiles/cmn/1.0/contexts/extensions/partner-id`;
    if (!ext[partnerKey]) {
      errors.push(`context.extensions[partner-id]: missing (expected key: ${partnerKey})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * spool 최근 N건 dry-validate (운영 검증 / 회귀 확인용)
 */
function validateRecent(limit = 10) {
  const rows = db.prepare(
    'SELECT id, statement_id, area, verb, statement_json FROM xapi_statement_spool ORDER BY id DESC LIMIT ?'
  ).all(limit);
  return rows.map(r => {
    let stmt = null;
    let parseError = null;
    try { stmt = JSON.parse(r.statement_json); } catch (e) { parseError = String(e.message); }
    const result = stmt ? validateStatement(stmt) : { ok: false, errors: [`JSON parse: ${parseError}`] };
    return {
      id: r.id,
      statement_id: r.statement_id,
      area: r.area,
      verb: r.verb,
      ok: result.ok,
      errors: result.errors,
    };
  });
}

module.exports = { validateStatement, validateRecent };
