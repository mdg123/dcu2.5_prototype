/**
 * db/featured.js — 추천콘텐츠 큐레이션(관리자 직접 기획) 헬퍼
 * 기준 스펙: docs/spec_admin_featured_curation.md
 *
 * 테이블: featured_sections, featured_section_items
 * 시드: planning / recommend / channels / new (4행 고정)
 */
const db = require('./index');
const contentDb = require('./content');

// =====================================================================
//  In-memory 캐시 (뷰어 응답)
//  타깃팅·게시기간 도입 후 응답이 (login, role, school_level) 별로 달라지므로
//  캐시 비활성화 (단순화 — 향후 사용자 세그먼트 단위 캐시로 확장 가능).
// =====================================================================
function invalidateFeaturedCache() { /* no-op (캐시 비활성화) */ }

// =====================================================================
//  타깃팅 헬퍼
// =====================================================================
const ALLOWED_SCHOOL_LEVELS = ['elementary', 'middle', 'high'];
const ALLOWED_ROLES = ['student', 'teacher', 'parent', 'staff', 'admin'];
// 다채움 표준 교과 11종 (contents.subject 와 동일 화이트리스트)
const ALLOWED_SUBJECTS = ['국어', '수학', '사회', '과학', '영어', '음악', '미술', '체육', '실과', '도덕', '통합'];
// 학년 1~12 정수 (초1~6 / 중1~3 / 고1~3 통합 표기)
const ALLOWED_GRADES_RANGE = { min: 1, max: 12 };
// 시드된 4종 key — POST 신규 발행 시 허용 화이트리스트
const ALLOWED_SECTION_KEYS = ['planning', 'recommend', 'channels', 'new'];

/**
 * DB에 저장된 타깃팅 컬럼(JSON 배열 문자열 / 'all' / NULL / 빈값)을
 * 자바스크립트 배열 또는 'all'로 정규화.
 * 반환값:
 *   - 'all'  → 전체 노출
 *   - []     → 빈 배열(전체 노출로 간주)
 *   - ['x',] → 매칭 필요
 */
function parseJsonArray(raw) {
  if (raw === null || raw === undefined) return 'all';
  if (raw === 'all') return 'all';
  if (typeof raw !== 'string') return 'all';
  const s = raw.trim();
  if (!s || s.toLowerCase() === 'all') return 'all';
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      if (arr.length === 0) return 'all';
      return arr.map(String);
    }
    return 'all';
  } catch (_) {
    return 'all';
  }
}

/**
 * 입력값을 DB 저장 형식으로 직렬화.
 * 입력:
 *   - 'all' / null / undefined / 빈 배열 → null (= 전체)
 *   - 배열 → 화이트리스트 통과한 값만 JSON.stringify
 * @param {Array<string>} allowed — 화이트리스트
 */
function stringifyJsonArray(value, allowed) {
  if (value === null || value === undefined) return null;
  if (value === 'all') return 'all';
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const filtered = value
      .map(v => String(v).trim())
      .filter(v => v.length > 0 && (!allowed || allowed.includes(v)));
    if (filtered.length === 0) return null;
    return JSON.stringify(filtered);
  }
  return null;
}

/**
 * 학년 정수 배열 직렬화 (1~12 정수만 허용).
 * 'all' / null / undefined / 빈 배열 → null
 * 잘못된 값 포함 시 false 반환 (호출부에서 INVALID_PAYLOAD 처리)
 */
function stringifyGradesArray(value) {
  if (value === null || value === undefined) return null;
  if (value === 'all') return 'all';
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const ints = [];
    for (const v of value) {
      const n = Number(v);
      if (!Number.isInteger(n)) return false;
      if (n < ALLOWED_GRADES_RANGE.min || n > ALLOWED_GRADES_RANGE.max) return false;
      ints.push(n);
    }
    // 중복 제거 + 정렬
    const uniq = Array.from(new Set(ints)).sort((a, b) => a - b);
    if (uniq.length === 0) return null;
    return JSON.stringify(uniq);
  }
  return false;
}

/**
 * 학년 컬럼 파싱 (정수 배열 / 'all' / NULL → 'all' or 정수 배열)
 */
function parseGradesArray(raw) {
  const v = parseJsonArray(raw);
  if (v === 'all') return 'all';
  // parseJsonArray는 String() 으로 매핑하므로 정수로 다시 캐스팅
  if (Array.isArray(v)) {
    const ints = v.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x));
    return ints.length === 0 ? 'all' : ints;
  }
  return 'all';
}

/**
 * ISO datetime 가벼운 검증.
 * 허용:
 *   - null / undefined / '' → null
 *   - 'YYYY-MM-DDTHH:MM[:SS][.sss][Z|±HH:MM]' 형식
 * 반환: 유효하면 ISO 문자열, 무효하면 false
 */
function _normalizeIsoDatetime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return false;
  // 형식 가벼운 검증: 'YYYY-MM-DDT' 시작
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return false;
  return s;
}

/**
 * 섹션의 status_derived 산출.
 * - 'inactive'  : is_active = 0
 * - 'scheduled' : publish_start > now
 * - 'expired'   : publish_end < now
 * - 'published' : 그 외(현재 게시 중)
 */
function _deriveStatus(section, nowMs = Date.now()) {
  if (!section || section.is_active === 0) return 'inactive';
  const startMs = section.publish_start ? Date.parse(section.publish_start) : NaN;
  const endMs = section.publish_end ? Date.parse(section.publish_end) : NaN;
  if (!isNaN(startMs) && startMs > nowMs) return 'scheduled';
  if (!isNaN(endMs) && endMs < nowMs) return 'expired';
  return 'published';
}

/**
 * 게시 기간 [publish_start, publish_end] 범위에 현재 시각이 들어있는지.
 * NULL → 무한대로 간주.
 */
function _isWithinPublishWindow(section, nowMs = Date.now()) {
  if (section.publish_start) {
    const ms = Date.parse(section.publish_start);
    if (!isNaN(ms) && ms > nowMs) return false; // 아직 시작 안 됨
  }
  if (section.publish_end) {
    const ms = Date.parse(section.publish_end);
    if (!isNaN(ms) && ms < nowMs) return false; // 종료
  }
  return true;
}

/**
 * 섹션의 target_school_levels 가 사용자 학교급에 매칭되는지.
 * - 'all' → 통과
 * - 배열 → user.school_level 가 포함되면 통과
 *   - user 없거나 school_level 미상이면 'all' 만 통과 (배열은 미통과)
 */
function _matchSchoolLevel(targetParsed, user) {
  if (targetParsed === 'all') return true;
  if (!user || !user.school_level) return false;
  return targetParsed.includes(user.school_level);
}

/**
 * 섹션의 target_roles 가 사용자 역할에 매칭되는지.
 * - 'all' → 통과
 * - 배열 → user.role 이 포함되면 통과
 *   - 비로그인(user==null): 'all' 또는 배열에 'guest' 가 있으면 통과
 *   - (현재 ALLOWED_ROLES에 'guest' 미포함이므로 사실상 비로그인은 'all' 만 통과)
 */
function _matchRole(targetParsed, user) {
  if (targetParsed === 'all') return true;
  if (!user) return targetParsed.includes('guest');
  return targetParsed.includes(user.role);
}

/**
 * 섹션의 target_grades 가 사용자 학년에 매칭되는지.
 * - 'all' → 통과
 * - 배열 → user.grade(정수) 가 포함되면 통과
 *   - user 없거나 grade 미상(NULL): 'all' 만 통과 (grade 필터 적용된 섹션은 미노출)
 *
 * 정책 설명: grade 정보는 학생만 정확. 교사/학부모/교직원/관리자는 grade 미상이거나 직무용 grade라 매칭에서 의미 약함.
 *           단순화: grade 필터가 켜진(배열) 섹션은 grade가 명확한 학생에게만 노출.
 */
function _matchGrade(targetParsed, user) {
  if (targetParsed === 'all') return true;
  if (!user || user.grade === null || user.grade === undefined) return false;
  const g = parseInt(user.grade, 10);
  if (!Number.isInteger(g)) return false;
  return targetParsed.includes(g);
}

/**
 * 섹션의 target_subjects 매칭.
 * 정책: 사용자 매칭은 적용하지 않음 (라벨링 목적).
 * 사용자 스키마에 subject 필드가 없고, 교사 담당교과 데이터가 존재하지 않으므로
 * "이 섹션이 다루는 교과"의 표시 라벨로만 사용한다. → 항상 통과.
 *
 * 향후 users.subject 또는 teacher_subjects 테이블이 추가되면 여기에 매칭 로직 적용 예정.
 */
function _matchSubject(_targetParsed, _user) {
  return true;
}

/**
 * DB row → 응답용 섹션 객체 (직렬화 + derived)
 */
function _serializeSection(row, nowMs = Date.now()) {
  if (!row) return row;
  const target_school_levels = parseJsonArray(row.target_school_levels);
  const target_roles = parseJsonArray(row.target_roles);
  const target_grades = parseGradesArray(row.target_grades);
  const target_subjects = parseJsonArray(row.target_subjects);
  const status_derived = _deriveStatus(row, nowMs);
  return {
    ...row,
    target_school_levels,
    target_roles,
    target_grades,
    target_subjects,
    status_derived,
    isPublishedNow: status_derived === 'published'
  };
}

// =====================================================================
//  섹션 조회/수정
// =====================================================================

/**
 * 모든 섹션 + 슬롯 갯수 (관리자 화면용)
 * @param {{activeOnly?: boolean}} options
 */
function listSections({ activeOnly = false, includeWarnings = false } = {}) {
  const where = activeOnly ? 'WHERE s.is_active = 1' : '';
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM featured_section_items i WHERE i.section_id = s.id) AS item_count
    FROM featured_sections s
    ${where}
    ORDER BY s.sort_order ASC, s.id ASC
  `).all();
  const now = Date.now();
  const serialized = rows.map(r => _serializeSection(r, now));

  if (includeWarnings) {
    // 정책 변경(2026-05-07): 같은 key의 여러 발행은 "스택처럼" sort_order 순으로
    // 모두 노출되는 게 정책. 중복(PERIOD_OVERLAP)을 경고하지 않음.
    return serialized.map(s => ({ ...s, warnings: [] }));
  }
  return serialized;
}

function getSection(id) {
  const row = db.prepare(`SELECT * FROM featured_sections WHERE id = ?`).get(id);
  return row ? _serializeSection(row) : row;
}

function getSectionByKey(key) {
  const row = db.prepare(`SELECT * FROM featured_sections WHERE key = ?`).get(key);
  return row ? _serializeSection(row) : row;
}

/**
 * 섹션 메타 부분 갱신 (화이트리스트 기반)
 * @param {number} id
 * @param {object} payload
 * @param {number} userId
 * @returns {object} { ok, code?, section? }
 */
function updateSection(id, payload = {}, userId = null) {
  const allowed = [
    'title', 'subtitle', 'layout', 'sort_order', 'is_active',
    'fallback_enabled', 'max_items',
    // 타깃팅·게시기간·예약발행
    'target_school_levels', 'target_roles', 'publish_start', 'publish_end',
    // 신규: 학년·교과 타깃팅
    'target_grades', 'target_subjects'
  ];
  const fields = [];
  const params = [];
  for (const key of allowed) {
    if (payload[key] === undefined) continue;
    let v = payload[key];
    if (key === 'is_active' || key === 'fallback_enabled') {
      v = v ? 1 : 0;
    } else if (key === 'sort_order' || key === 'max_items') {
      v = parseInt(v, 10) || 0;
    } else if (key === 'target_school_levels') {
      v = stringifyJsonArray(v, ALLOWED_SCHOOL_LEVELS);
    } else if (key === 'target_roles') {
      v = stringifyJsonArray(v, ALLOWED_ROLES);
    } else if (key === 'target_grades') {
      const norm = stringifyGradesArray(v);
      if (norm === false) {
        return { ok: false, code: 'INVALID_PAYLOAD', message: 'target_grades 값이 올바르지 않습니다 (1~12 정수 배열).' };
      }
      v = norm;
    } else if (key === 'target_subjects') {
      // 'all' / null / [] 는 stringifyJsonArray가 그대로 처리
      // 잘못된 교과명 포함 시 화이트리스트로 자동 제거 → 결과가 빈 배열이면 null로 떨어짐
      // 사용자가 명시적으로 잘못된 값만 보낸 경우(예: ['수학팝송']) 어떤 처리도 안 됐는지 확인 필요
      if (Array.isArray(v) && v.length > 0) {
        const cleaned = v.map(x => String(x).trim()).filter(x => x);
        const invalid = cleaned.filter(x => !ALLOWED_SUBJECTS.includes(x));
        if (invalid.length > 0) {
          return { ok: false, code: 'INVALID_PAYLOAD', message: `target_subjects 값이 올바르지 않습니다 (허용: ${ALLOWED_SUBJECTS.join(', ')}).` };
        }
      }
      v = stringifyJsonArray(v, ALLOWED_SUBJECTS);
    } else if (key === 'publish_start' || key === 'publish_end') {
      const norm = _normalizeIsoDatetime(v);
      if (norm === false) {
        return { ok: false, code: 'INVALID_PAYLOAD', message: `${key} 형식이 올바르지 않습니다 (ISO 8601 datetime 필요).` };
      }
      v = norm;
    }
    fields.push(`${key} = ?`);
    params.push(v);
  }
  if (fields.length === 0) {
    const section = getSection(id);
    return section ? { ok: true, section, warnings: [] } : { ok: false, code: 'NOT_FOUND' };
  }

  // 낙관적 동시성 검사 (선택)
  if (payload.expected_updated_at) {
    const cur = db.prepare('SELECT updated_at FROM featured_sections WHERE id = ?').get(id);
    if (!cur) return { ok: false, code: 'NOT_FOUND' };
    if (cur.updated_at !== payload.expected_updated_at) {
      return { ok: false, code: 'STALE_UPDATE' };
    }
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  if (userId) { fields.push('updated_by = ?'); params.push(userId); }
  params.push(id);

  const info = db.prepare(`UPDATE featured_sections SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return { ok: false, code: 'NOT_FOUND' };
  invalidateFeaturedCache();

  // 정책(2026-05-07): PERIOD_OVERLAP 경고 폐기. 같은 key 여러 발행은 sort_order 순으로 모두 노출.
  return { ok: true, section: getSection(id), warnings: [] };
}

/**
 * 같은 key를 가진 다른 활성(is_active=1) 행 중 publish 기간이 [start, end]와 겹치는 row 목록.
 * - NULL은 ±∞로 간주
 * - 두 구간 [a1,a2] [b1,b2] 가 겹치는 조건: a1 ≤ b2 && b1 ≤ a2
 * - 자기자신(sectionId) 제외
 *
 * @param {number} sectionId — 자기자신 제외용
 * @param {string} key       — 동일 섹션 키만 비교
 * @param {string|null} start — ISO datetime or NULL
 * @param {string|null} end   — ISO datetime or NULL
 * @param {object} [targeting] — { school_levels, roles, grades, subjects } 각 'all' 또는 배열.
 *   비우면 모든 차원을 'all'로 간주 (= 종전 호환).
 *   타깃팅이 한 차원이라도 교집합이 없으면 두 발행은 서로 다른 사용자에게 노출되므로 충돌 X.
 * @returns {Array<{id:number, publish_start:string|null, publish_end:string|null}>}
 */
function findPeriodOverlaps(sectionId, key, start, end, targeting) {
  if (!key) return [];
  const others = db.prepare(`
    SELECT id, key, publish_start, publish_end,
           target_school_levels, target_roles, target_grades, target_subjects
    FROM featured_sections
    WHERE key = ? AND id != ? AND is_active = 1
  `).all(key, sectionId);

  const aStartMs = start ? Date.parse(start) : -Infinity;
  const aEndMs = end ? Date.parse(end) : Infinity;
  // 무효 일자는 ±∞로 폴백
  const a1 = isNaN(aStartMs) ? -Infinity : aStartMs;
  const a2 = isNaN(aEndMs) ? Infinity : aEndMs;

  // 자기자신 타깃팅 (비어있으면 모두 'all'로 간주 — 종전 호환)
  const aTarget = {
    school_levels: targeting?.school_levels ?? 'all',
    roles:         targeting?.roles         ?? 'all',
    grades:        targeting?.grades        ?? 'all',
    subjects:      targeting?.subjects      ?? 'all',
  };

  return others.filter(o => {
    // 1) 기간 겹침
    const bStartMs = o.publish_start ? Date.parse(o.publish_start) : -Infinity;
    const bEndMs = o.publish_end ? Date.parse(o.publish_end) : Infinity;
    const b1 = isNaN(bStartMs) ? -Infinity : bStartMs;
    const b2 = isNaN(bEndMs) ? Infinity : bEndMs;
    const periodOverlaps = a1 <= b2 && b1 <= a2;
    if (!periodOverlaps) return false;
    // 2) 타깃팅 교집합 — 한 차원이라도 disjoint면 대상이 다르므로 충돌 X
    const bTarget = {
      school_levels: parseJsonArray(o.target_school_levels),
      roles:         parseJsonArray(o.target_roles),
      grades:        parseJsonArray(o.target_grades),
      subjects:      parseJsonArray(o.target_subjects),
    };
    return targetingsIntersect(aTarget, bTarget);
  });
}

/**
 * 한 차원에서 두 타깃팅 값이 교집합을 가지는지.
 * 'all' 또는 빈 배열은 모든 값과 교집합 있음.
 */
function dimIntersects(a, b) {
  if (a === 'all' || b === 'all') return true;
  if (!Array.isArray(a) || a.length === 0) return true;
  if (!Array.isArray(b) || b.length === 0) return true;
  const setB = new Set(b.map(String));
  return a.some(x => setB.has(String(x)));
}

/**
 * 두 타깃팅 객체(school_levels/roles/grades/subjects)가 교집합을 가지는지.
 * 모든 차원에서 교집합이 있어야 true (한 차원이라도 disjoint면 false).
 */
function targetingsIntersect(a, b) {
  return dimIntersects(a.school_levels, b.school_levels)
      && dimIntersects(a.roles,         b.roles)
      && dimIntersects(a.grades,        b.grades)
      && dimIntersects(a.subjects,      b.subjects);
}

/**
 * 새 발행 행 생성 — 같은 key에 여러 row 허용.
 * 시드된 4개 key만 허용 (UNIQUE 제거됐어도 CHECK(key IN ...) 제약은 유지).
 *
 * @param {object} payload
 * @param {number} userId
 * @returns {{ok:boolean, code?:string, message?:string, section?:object, warnings?:Array}}
 */
function createSection(payload = {}, userId = null) {
  const key = (payload.key || '').toString().trim();
  if (!key) return { ok: false, code: 'INVALID_PAYLOAD', message: 'key 가 필요합니다.' };
  if (!ALLOWED_SECTION_KEYS.includes(key)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: `key는 [${ALLOWED_SECTION_KEYS.join(', ')}] 중 하나여야 합니다.` };
  }
  const title = (payload.title || '').toString().trim();
  if (!title) return { ok: false, code: 'INVALID_PAYLOAD', message: 'title 이 필요합니다.' };

  // 같은 key의 기본 행에서 layout/item_type 상속 (안 보낸 경우)
  const seed = db.prepare('SELECT layout, item_type FROM featured_sections WHERE key = ? ORDER BY id ASC LIMIT 1').get(key);
  const layout = payload.layout || seed?.layout || 'card-grid';
  const item_type = payload.item_type || seed?.item_type || 'content';

  // 검증
  if (!['card-grid', 'channel-row', 'list'].includes(layout)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'layout 값이 올바르지 않습니다.' };
  }
  if (!['content', 'channel'].includes(item_type)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'item_type 값이 올바르지 않습니다.' };
  }

  // 타깃팅·기간 정규화
  const target_school_levels = stringifyJsonArray(payload.target_school_levels, ALLOWED_SCHOOL_LEVELS);
  const target_roles = stringifyJsonArray(payload.target_roles, ALLOWED_ROLES);
  const target_grades = stringifyGradesArray(payload.target_grades);
  if (target_grades === false) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'target_grades 값이 올바르지 않습니다 (1~12 정수 배열).' };
  }
  if (Array.isArray(payload.target_subjects) && payload.target_subjects.length > 0) {
    const invalid = payload.target_subjects.map(x => String(x).trim())
      .filter(x => x && !ALLOWED_SUBJECTS.includes(x));
    if (invalid.length > 0) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: `target_subjects 값이 올바르지 않습니다 (허용: ${ALLOWED_SUBJECTS.join(', ')}).` };
    }
  }
  const target_subjects = stringifyJsonArray(payload.target_subjects, ALLOWED_SUBJECTS);

  const ps = _normalizeIsoDatetime(payload.publish_start);
  if (ps === false) return { ok: false, code: 'INVALID_PAYLOAD', message: 'publish_start 형식이 올바르지 않습니다 (ISO 8601 datetime 필요).' };
  const pe = _normalizeIsoDatetime(payload.publish_end);
  if (pe === false) return { ok: false, code: 'INVALID_PAYLOAD', message: 'publish_end 형식이 올바르지 않습니다 (ISO 8601 datetime 필요).' };

  const subtitle = payload.subtitle ? String(payload.subtitle) : null;
  const sort_order = parseInt(payload.sort_order, 10) || 0;
  const is_active = (payload.is_active === undefined || payload.is_active === null) ? 1 : (payload.is_active ? 1 : 0);
  // 정책(2026-05-07): 새로 추가하는 발행은 자동추천(폴백) 기본 OFF.
  // 시드 4행만 폴백 ON으로 운영 (관리자가 슬롯을 채우지 않을 때 시스템 추천으로 보충).
  const fallback_enabled = (payload.fallback_enabled === undefined || payload.fallback_enabled === null) ? 0 : (payload.fallback_enabled ? 1 : 0);
  const max_items = parseInt(payload.max_items, 10) || 8;

  const info = db.prepare(`
    INSERT INTO featured_sections
      (key, title, subtitle, layout, item_type, sort_order, is_active, fallback_enabled, max_items,
       target_school_levels, target_roles, target_grades, target_subjects,
       publish_start, publish_end, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key, title, subtitle, layout, item_type, sort_order, is_active, fallback_enabled, max_items,
    target_school_levels, target_roles, target_grades, target_subjects,
    ps, pe, userId
  );
  invalidateFeaturedCache();

  const newId = info.lastInsertRowid;
  const section = getSection(newId);

  // 정책(2026-05-07): PERIOD_OVERLAP 경고 폐기. 같은 key 여러 발행은 sort_order 순으로 모두 노출.
  return { ok: true, section, warnings: [] };
}

/**
 * 섹션 순서 일괄 갱신
 * @param {Array<{id:number, sort_order:number}>} order
 * @param {number} userId
 */
function reorderSections(order = [], userId = null) {
  if (!Array.isArray(order) || order.length === 0) return { ok: false, code: 'INVALID_PAYLOAD' };
  const stmt = db.prepare(`
    UPDATE featured_sections
       SET sort_order = ?, updated_at = CURRENT_TIMESTAMP, updated_by = COALESCE(?, updated_by)
     WHERE id = ?
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const sid = parseInt(row.id, 10);
      const so = parseInt(row.sort_order, 10);
      if (!sid || Number.isNaN(so)) continue;
      stmt.run(so, userId || null, sid);
    }
  });
  tx(order);
  invalidateFeaturedCache();
  return { ok: true };
}

/**
 * 섹션 삭제 — 시드 4행(planning/recommend/channels/new)은 보호.
 * 활성/비활성은 시드도 자유롭게 토글 가능. 삭제만 새 발행에 한함.
 */
const PROTECTED_SECTION_IDS = [1, 2, 3, 4];
function deleteSection(id) {
  const sid = parseInt(id, 10);
  if (!sid) return { ok: false, code: 'INVALID_PAYLOAD', message: 'id가 올바르지 않습니다.' };
  if (PROTECTED_SECTION_IDS.includes(sid)) {
    return { ok: false, code: 'PROTECTED_SEED', message: '기본 시드 섹션은 삭제할 수 없습니다 (비활성화로 노출 제어 가능).' };
  }
  const exists = db.prepare('SELECT id FROM featured_sections WHERE id = ?').get(sid);
  if (!exists) return { ok: false, code: 'NOT_FOUND', message: '섹션을 찾을 수 없습니다.' };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM featured_section_items WHERE section_id = ?').run(sid);
    db.prepare('DELETE FROM featured_sections WHERE id = ?').run(sid);
  });
  tx();
  invalidateFeaturedCache();
  return { ok: true };
}

// =====================================================================
//  슬롯 (items) 조회/수정
// =====================================================================

/**
 * 관리자용: 섹션 내 모든 슬롯 + 콘텐츠/채널 상세 (비공개·삭제도 포함하되 is_visible 플래그)
 */
function listSectionItems(sectionId) {
  const items = db.prepare(`
    SELECT * FROM featured_section_items
    WHERE section_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(sectionId);

  return items.map(it => {
    const snapshot = _hydrateItemSnapshot(it.item_type, it.item_id, /*forAdmin*/true);
    return { ...it, snapshot };
  });
}

/**
 * 뷰어용: 비공개/삭제/미승인은 자동 필터, 응답에서 빠짐
 */
function _listVisibleSectionItems(sectionId, maxItems = 8) {
  const items = db.prepare(`
    SELECT * FROM featured_section_items
    WHERE section_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(sectionId);

  const out = [];
  for (const it of items) {
    const snap = _hydrateItemSnapshot(it.item_type, it.item_id, /*forAdmin*/false);
    if (!snap) continue;
    out.push({
      type: it.item_type,
      id: it.item_id,
      slot_id: it.id,
      badge_label: it.badge_label || null,
      ...snap
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 콘텐츠/채널 상세 조회 + 가시성 판정
 */
function _hydrateItemSnapshot(item_type, item_id, forAdmin = false) {
  if (item_type === 'content') {
    const row = db.prepare(`
      SELECT c.id, c.title, c.thumbnail_url, c.content_type, c.subject, c.grade,
             c.view_count, c.like_count, c.is_public, c.status,
             u.display_name AS creator_name
        FROM contents c
        JOIN users u ON c.creator_id = u.id
       WHERE c.id = ?
    `).get(item_id);
    if (!row) return forAdmin ? { is_visible: false, deleted: true } : null;
    const visible = row.is_public === 1 && row.status === 'approved';
    if (!forAdmin && !visible) return null;
    return {
      title: row.title,
      thumbnail_url: row.thumbnail_url,
      content_type: row.content_type,
      subject: row.subject,
      grade: row.grade,
      view_count: row.view_count,
      like_count: row.like_count,
      creator_name: row.creator_name,
      is_visible: visible
    };
  }
  if (item_type === 'channel') {
    const row = db.prepare(`
      SELECT ch.id, ch.name, ch.description, ch.subscriber_count, ch.content_count, ch.status,
             u.display_name AS owner_name
        FROM channels ch
        JOIN users u ON ch.user_id = u.id
       WHERE ch.id = ?
    `).get(item_id);
    if (!row) return forAdmin ? { is_visible: false, deleted: true } : null;
    const visible = row.status === 'active';
    if (!forAdmin && !visible) return null;
    return {
      name: row.name,
      description: row.description,
      subscriber_count: row.subscriber_count,
      content_count: row.content_count,
      owner_name: row.owner_name,
      is_visible: visible
    };
  }
  return null;
}

/**
 * 슬롯 추가 — 끝(MAX+10)에 붙임
 */
function addSectionItem(sectionId, item_type, item_id, payload = {}, userId = null) {
  const section = getSection(sectionId);
  if (!section) return { ok: false, code: 'NOT_FOUND', message: '섹션이 존재하지 않습니다.' };

  // section.item_type 일치 검증
  if (section.item_type !== item_type) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: `이 섹션은 ${section.item_type} 타입만 추가할 수 있습니다.` };
  }

  // 대상 존재 검증
  if (item_type === 'content') {
    const c = db.prepare(`SELECT id, is_public, status FROM contents WHERE id = ?`).get(item_id);
    if (!c) return { ok: false, code: 'NOT_FOUND', message: '콘텐츠가 존재하지 않습니다.' };
  } else if (item_type === 'channel') {
    const ch = db.prepare(`SELECT id FROM channels WHERE id = ?`).get(item_id);
    if (!ch) return { ok: false, code: 'NOT_FOUND', message: '채널이 존재하지 않습니다.' };
  } else {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'item_type이 올바르지 않습니다.' };
  }

  // 중복 검사 (UNIQUE 인덱스 의존 + 사전 명시 검사)
  const dup = db.prepare(`
    SELECT id FROM featured_section_items
    WHERE section_id = ? AND item_type = ? AND item_id = ?
  `).get(sectionId, item_type, item_id);
  if (dup) return { ok: false, code: 'DUPLICATE', message: '이미 이 섹션에 추가된 항목입니다.' };

  // 정렬값: MAX(sort_order)+10
  const cur = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM featured_section_items WHERE section_id = ?`).get(sectionId);
  const newOrder = (cur?.m || 0) + 10;

  try {
    const info = db.prepare(`
      INSERT INTO featured_section_items
        (section_id, item_type, item_id, sort_order, badge_label, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sectionId, item_type, parseInt(item_id, 10), newOrder,
      (payload.badge_label || null),
      (payload.note || null),
      userId
    );
    invalidateFeaturedCache();
    const item = db.prepare(`SELECT * FROM featured_section_items WHERE id = ?`).get(info.lastInsertRowid);
    return { ok: true, item };
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return { ok: false, code: 'DUPLICATE', message: '이미 이 섹션에 추가된 항목입니다.' };
    }
    throw e;
  }
}

function removeSectionItem(itemId) {
  const info = db.prepare(`DELETE FROM featured_section_items WHERE id = ?`).run(itemId);
  if (info.changes === 0) return { ok: false, code: 'NOT_FOUND' };
  invalidateFeaturedCache();
  return { ok: true };
}

/**
 * 슬롯 순서 일괄 갱신 (같은 섹션 내에서만)
 */
function reorderItems(sectionId, order = []) {
  if (!Array.isArray(order) || order.length === 0) return { ok: false, code: 'INVALID_PAYLOAD' };

  // 같은 섹션 소속인지 검증
  const ids = order.map(o => parseInt(o.id, 10)).filter(Boolean);
  if (ids.length === 0) return { ok: false, code: 'INVALID_PAYLOAD' };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, section_id FROM featured_section_items WHERE id IN (${placeholders})`).all(...ids);
  for (const r of rows) {
    if (r.section_id !== parseInt(sectionId, 10)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: '다른 섹션의 슬롯이 포함되어 있습니다.' };
    }
  }

  const stmt = db.prepare(`UPDATE featured_section_items SET sort_order = ? WHERE id = ?`);
  const tx = db.transaction((rows2) => {
    for (const row of rows2) {
      const iid = parseInt(row.id, 10);
      const so = parseInt(row.sort_order, 10);
      if (!iid || Number.isNaN(so)) continue;
      stmt.run(so, iid);
    }
  });
  tx(order);
  invalidateFeaturedCache();
  return { ok: true };
}

// =====================================================================
//  뷰어 통합 — 폴백 적용 (스펙 F-1)
// =====================================================================

/**
 * 모든 활성 섹션 + items + 폴백 적용
 * @param {{user?: object}} ctx — 로그인 사용자(선택)
 */
function getFeaturedForViewer({ user = null } = {}) {
  // 캐시: 타깃팅·게시기간 도입으로 응답이 사용자 컨텍스트에 따라 달라지므로 비활성화.
  const nowMs = Date.now();
  const allActive = listSections({ activeOnly: true });

  // user.school_level / grade 보강 — 인증 미들웨어가 SELECT에 포함하지 않을 수 있음
  let viewer = user;
  if (user && user.id && (user.school_level === undefined || user.grade === undefined)) {
    try {
      const row = db.prepare('SELECT school_level, grade FROM users WHERE id = ?').get(user.id);
      viewer = {
        ...user,
        school_level: row ? row.school_level : null,
        grade: row ? row.grade : null
      };
    } catch (_) { viewer = { ...user, school_level: null, grade: null }; }
  }

  // 타깃팅·게시기간 필터링 (4차원: 학교급 / 역할 / 학년 / 교과)
  const sections = allActive.filter(s => {
    if (!_isWithinPublishWindow(s, nowMs)) return false;
    if (!_matchSchoolLevel(s.target_school_levels, viewer)) return false;
    if (!_matchRole(s.target_roles, viewer)) return false;
    if (!_matchGrade(s.target_grades, viewer)) return false;
    if (!_matchSubject(s.target_subjects, viewer)) return false; // 항상 true (라벨링 정책)
    return true;
  });

  const result = sections.map(s => {
    const max = s.max_items || 8;
    let items = _listVisibleSectionItems(s.id, max);
    let isFallback = false;

    // 폴백 결정: planning/recommend는 1건 이상이면 폴백 X. channels/new는 부족분 보충.
    const needsFallback = s.fallback_enabled === 1 && items.length < max;
    const allowFallback =
      (s.key === 'planning' || s.key === 'recommend')
        ? items.length === 0          // 슬롯이 비었을 때만 폴백
        : true;                        // channels / new 는 항상 부족분 보충

    if (needsFallback && allowFallback) {
      const fallbackItems = _buildFallback(s, max - items.length, viewer, items);
      if (fallbackItems.length > 0) {
        items = items.concat(fallbackItems);
        isFallback = items.every(it => it._fallback) || items.length === fallbackItems.length;
        // 메타에서 _fallback 마커 제거
        items = items.map(it => { const { _fallback, ...rest } = it; return rest; });
      }
    }

    return {
      key: s.key,
      title: s.title,
      subtitle: s.subtitle,
      layout: s.layout,
      item_type: s.item_type,
      max_items: max,
      is_fallback: isFallback,
      items: items.slice(0, max)
    };
  });

  const payload = { success: true, sections: result };
  return payload;
}

/**
 * 폴백 아이템 생성 — 기존 콘텐츠 추천/채널 인기를 그대로 사용
 */
function _buildFallback(section, count, user, currentItems) {
  if (count <= 0) return [];

  if (section.item_type === 'channel') {
    // 인기 채널 — 이미 슬롯에 있는 채널 제외
    const existing = new Set(currentItems.map(it => it.id));
    const channels = contentDb.getPopularChannels(count + existing.size);
    return channels
      .filter(ch => !existing.has(ch.id))
      .slice(0, count)
      .map(ch => ({
        type: 'channel',
        id: ch.id,
        name: ch.name,
        description: ch.description,
        subscriber_count: ch.subscriber_count,
        content_count: ch.content_count,
        owner_name: ch.owner_name,
        is_visible: true,
        _fallback: true
      }));
  }

  // content 폴백 — getRecommendations 사용
  const userId = user?.id || 0;
  const opts = {};
  if (user) {
    if (user.role) opts.role = user.role;
    if ((user.role === 'student' || user.role === 'teacher') && user.grade) opts.grade = user.grade;
  }
  const existing = new Set(currentItems.map(it => it.id));
  const recos = contentDb.getRecommendations(userId, count + existing.size, [], opts);
  return recos
    .filter(c => !existing.has(c.id))
    .slice(0, count)
    .map(c => ({
      type: 'content',
      id: c.id,
      title: c.title,
      thumbnail_url: c.thumbnail_url,
      content_type: c.content_type,
      subject: c.subject,
      grade: c.grade,
      view_count: c.view_count,
      like_count: c.like_count,
      creator_name: c.creator_name,
      is_visible: true,
      _fallback: true
    }));
}

// =====================================================================
//  검색 (관리자 큐레이션 모달용)
// =====================================================================

/**
 * @param {{type: 'content'|'channel', q?, subject?, grade?, content_type?, page?, pageSize?, section_id?}} params
 */
function searchForCuration(params = {}) {
  const type = (params.type === 'channel') ? 'channel' : 'content';
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const pageSize = Math.min(60, Math.max(4, parseInt(params.pageSize, 10) || 12));
  const offset = (page - 1) * pageSize;
  const q = (params.q || '').trim();
  const sectionId = params.section_id ? parseInt(params.section_id, 10) : null;

  if (type === 'content') {
    const where = [`c.is_public = 1`, `c.status = 'approved'`];
    const args = [];
    if (q) {
      where.push(`(c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ? OR u.display_name LIKE ?)`);
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    if (params.subject) { where.push(`c.subject = ?`); args.push(params.subject); }
    if (params.grade) { where.push(`c.grade = ?`); args.push(parseInt(params.grade, 10)); }
    if (params.content_type) { where.push(`c.content_type = ?`); args.push(params.content_type); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`
      SELECT COUNT(*) AS cnt
        FROM contents c JOIN users u ON c.creator_id = u.id
        ${whereSql}
    `).get(...args).cnt;
    const rows = db.prepare(`
      SELECT c.id, c.title, c.thumbnail_url, c.content_type, c.subject, c.grade,
             c.view_count, c.like_count, c.created_at,
             u.display_name AS creator_name
        FROM contents c JOIN users u ON c.creator_id = u.id
        ${whereSql}
       ORDER BY c.view_count DESC, c.created_at DESC
       LIMIT ? OFFSET ?
    `).all(...args, pageSize, offset);

    let alreadySet = new Set();
    if (sectionId) {
      const ex = db.prepare(`
        SELECT item_id FROM featured_section_items
        WHERE section_id = ? AND item_type = 'content'
      `).all(sectionId);
      alreadySet = new Set(ex.map(e => e.item_id));
    }
    const items = rows.map(r => ({
      type: 'content',
      ...r,
      already_in_section: sectionId ? alreadySet.has(r.id) : false
    }));
    return {
      success: true,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items
    };
  }

  // channel
  const where = [`ch.status = 'active'`];
  const args = [];
  if (q) {
    where.push(`(ch.name LIKE ? OR ch.description LIKE ? OR u.display_name LIKE ?)`);
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`
    SELECT COUNT(*) AS cnt
      FROM channels ch JOIN users u ON ch.user_id = u.id
      ${whereSql}
  `).get(...args).cnt;
  const rows = db.prepare(`
    SELECT ch.id, ch.name, ch.description, ch.subscriber_count, ch.content_count, ch.created_at,
           u.display_name AS owner_name
      FROM channels ch JOIN users u ON ch.user_id = u.id
      ${whereSql}
     ORDER BY ch.subscriber_count DESC, ch.content_count DESC
     LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset);

  let alreadySet = new Set();
  if (sectionId) {
    const ex = db.prepare(`
      SELECT item_id FROM featured_section_items
      WHERE section_id = ? AND item_type = 'channel'
    `).all(sectionId);
    alreadySet = new Set(ex.map(e => e.item_id));
  }
  const items = rows.map(r => ({
    type: 'channel',
    ...r,
    already_in_section: sectionId ? alreadySet.has(r.id) : false
  }));
  return {
    success: true,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items
  };
}

module.exports = {
  // sections
  listSections,
  getSection,
  getSectionByKey,
  updateSection,
  createSection,
  reorderSections,
  deleteSection,
  findPeriodOverlaps,
  // items
  listSectionItems,
  addSectionItem,
  removeSectionItem,
  reorderItems,
  // viewer
  getFeaturedForViewer,
  // search
  searchForCuration,
  // cache
  invalidateFeaturedCache,
  // 화이트리스트 (외부 노출 — 프론트엔드 옵션 표시용)
  ALLOWED_SCHOOL_LEVELS,
  ALLOWED_ROLES,
  ALLOWED_SUBJECTS,
  ALLOWED_SECTION_KEYS
};
