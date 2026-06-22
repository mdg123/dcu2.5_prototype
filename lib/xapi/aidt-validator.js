// lib/xapi/aidt-validator.js
// ─────────────────────────────────────────────────────────────
// 「학습데이터 대외연계 기술규격 v1.0」 자체 사전검증기 (규격 §8.3).
//   transfer 전 spool statement 가 v1.0 Statement JSON 구조를 만족하는지 dry-validate.
//
//   validateStatement(statement) → { ok:boolean, errors:string[] }
//   validateRecent(limit=10)     → spool 최근 N건 dry-validate
//   dryValidateUnsent()          → 미전송분(sent_at IS NULL) 전수 검증 리포트
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖. 본 검증기는 JSON 구조 정합만 검사.
// ─────────────────────────────────────────────────────────────
const db = require('../../db');
const { AIDT_DOMAIN, STANDARD_VERB_IDS, EXT } = require('./common');

// v1.0 timestamp: ms 포함 + UTC 'Z' (...SSSZ)
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHOOL_INFO_KEY = `${AIDT_DOMAIN}/xapi/contexts/extensions/school-info`;
const CURRICULUM_STD_KEY = `${AIDT_DOMAIN}/xapi/objects/extensions/curriculum-standard-id`;

// 플랫 확장 IRI 접두사 (object/result/context). 이 외의 aidtbook.kr 확장은 위반.
const FLAT_EXT_PREFIXES = [
  `${AIDT_DOMAIN}/xapi/objects/extensions/`,
  `${AIDT_DOMAIN}/xapi/results/extensions/`,
  `${AIDT_DOMAIN}/xapi/contexts/extensions/`,
];
// 프로필형 확장 IRI = v1.0 위반 (verb/activity-type 의 profiles 경로는 별개라 예외)
const PROFILE_EXT_RE = /\/xapi\/profiles\/.+\/extensions\//;
const DACHEUM_NS = 'https://dacheum.kr/';

function isAidtExtKey(key) {
  return typeof key === 'string' && key.startsWith(`${AIDT_DOMAIN}/`);
}
function isDacheumNs(key) {
  return typeof key === 'string' && key.startsWith(DACHEUM_NS);
}

/**
 * 확장 IRI 키들이 v1.0 플랫 형식인지 검사.
 *   - aidtbook.kr 확장 키는 반드시 플랫(/objects|results|contexts/extensions/) 이어야 함
 *   - 프로필형 확장(/xapi/profiles/.../extensions/) 은 위반
 *   - partner-id 키는 위반
 *   - dacheum.kr ns 는 예외(허용)
 */
function checkExtensionKeys(extensions, where, errors) {
  if (!extensions || typeof extensions !== 'object') return;
  for (const key of Object.keys(extensions)) {
    if (key.includes('partner-id')) {
      errors.push(`${where}: partner-id 확장은 v1.0 에 없음 (제거 필요): ${key}`);
      continue;
    }
    if (isDacheumNs(key)) continue; // 다채움 내부 ns 예외
    if (!isAidtExtKey(key)) continue; // 기타 외부 ns 는 본 검사 대상 외
    if (PROFILE_EXT_RE.test(key)) {
      errors.push(`${where}: 프로필형 확장 IRI 는 v1.0 위반 (플랫 형식 필요): ${key}`);
      continue;
    }
    const isFlat = FLAT_EXT_PREFIXES.some(pre => key.startsWith(pre));
    if (!isFlat) {
      errors.push(`${where}: 비표준 확장 IRI 형식: ${key}`);
    }
  }
}

/**
 * 단일 statement 가 v1.0 호환 골격을 만족하는지 검사.
 */
function validateStatement(statement) {
  const errors = [];
  const s = statement;
  if (!s || typeof s !== 'object') {
    return { ok: false, errors: ['statement is not an object'] };
  }

  // id (xAPI 표준 — UUID)
  if (!s.id) {
    errors.push('id: missing (xAPI Statement id (UUID) required)');
  } else if (!UUID_RE.test(s.id)) {
    errors.push(`id: not UUID format: ${s.id}`);
  }

  // timestamp — v1.0: ...SSSZ
  if (!s.timestamp) {
    errors.push('timestamp: missing');
  } else if (!TIMESTAMP_RE.test(s.timestamp)) {
    errors.push(`timestamp: not v1.0 format (yyyy-MM-ddTHH:mm:ss.SSSZ): ${s.timestamp}`);
  }

  // actor — Agent + account.name UUID + homePage, actor.name 부재(PII)
  if (!s.actor) {
    errors.push('actor: missing');
  } else {
    if (s.actor.objectType !== 'Agent') errors.push(`actor.objectType !== 'Agent'`);
    if (s.actor.name != null) {
      errors.push('actor.name: 한글 실명 부재 권고 (PII 최소화) — 키 존재함');
    }
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

  // verb — v1.0 표준 verb IRI set 포함
  if (!s.verb || !s.verb.id) {
    errors.push('verb.id: missing');
  } else if (!STANDARD_VERB_IDS.has(s.verb.id)) {
    errors.push(`verb.id: not a v1.0 standard verb IRI: ${s.verb.id}`);
  }
  if (!s.verb || !s.verb.display) {
    errors.push('verb.display: missing');
  }

  // object — Activity, definition.type = activity-type 경로, curriculum-standard-id 키 존재
  if (!s.object) {
    errors.push('object: missing');
  } else {
    if (s.object.objectType !== 'Activity') errors.push(`object.objectType !== 'Activity'`);
    if (!s.object.id) errors.push('object.id: missing');
    const def = s.object.definition || {};
    const defType = def.type;
    if (!defType) {
      errors.push('object.definition.type: missing');
    } else if (!defType.startsWith(`${AIDT_DOMAIN}/xapi/activity-type/`)) {
      errors.push(`object.definition.type: not /xapi/activity-type/ path: ${defType}`);
    }
    const objExt = def.extensions || {};
    if (!Object.prototype.hasOwnProperty.call(objExt, CURRICULUM_STD_KEY)) {
      errors.push(`object.definition.extensions[curriculum-standard-id]: missing (key required, value may be null)`);
    }
    checkExtensionKeys(objExt, 'object.definition.extensions', errors);
  }

  // result 확장 IRI 플랫 검사
  if (s.result && s.result.extensions) {
    checkExtensionKeys(s.result.extensions, 'result.extensions', errors);
  }

  // context — platform + school-info(3종) + 확장 IRI 플랫
  if (!s.context) {
    errors.push('context: missing');
  } else {
    if (!s.context.platform) errors.push('context.platform: missing');
    const ext = s.context.extensions || {};
    const school = ext[SCHOOL_INFO_KEY];
    if (!school || typeof school !== 'object') {
      errors.push(`context.extensions[school-info]: missing (expected key: ${SCHOOL_INFO_KEY})`);
    } else {
      for (const f of ['schoolCode', 'schoolLevelCode', 'schoolGradeCode']) {
        if (school[f] == null) errors.push(`context.extensions[school-info].${f}: missing`);
      }
    }
    checkExtensionKeys(ext, 'context.extensions', errors);
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

/**
 * 미전송분(sent_at IS NULL) 전수 dry-validate.
 *   규격 §8.3 "오류율 0% 달성 후 운영 전환" 게이트용.
 * @returns {{ total, ok, fail, errorRate, samples }}
 */
function dryValidateUnsent() {
  const rows = db.prepare(
    'SELECT id, statement_id, area, verb, statement_json FROM xapi_statement_spool WHERE sent_at IS NULL'
  ).all();
  let okCount = 0;
  let failCount = 0;
  const samples = [];
  for (const r of rows) {
    let stmt = null;
    let parseError = null;
    try { stmt = JSON.parse(r.statement_json); } catch (e) { parseError = String(e.message); }
    const result = stmt ? validateStatement(stmt) : { ok: false, errors: [`JSON parse: ${parseError}`] };
    if (result.ok) {
      okCount++;
    } else {
      failCount++;
      if (samples.length < 20) {
        samples.push({ id: r.id, statement_id: r.statement_id, area: r.area, verb: r.verb, errors: result.errors });
      }
    }
  }
  const total = rows.length;
  return {
    total,
    ok: okCount,
    fail: failCount,
    errorRate: total > 0 ? failCount / total : 0,
    samples,
  };
}

module.exports = { validateStatement, validateRecent, dryValidateUnsent };
