// lib/xapi/codebook.js
// ─────────────────────────────────────────────────────────────
// 「학습데이터 대외연계 기술규격 v1.0」 가상 코드 체계.
//
//   ⚠ 본 파일의 코드값(기관코드·학교코드·SLC/SGC·홈페이지)은 모두 *가상값* 이다.
//      실제 연계 시 KERIS/통합지원센터가 발급한 허브 코드표(교육디지털 원패스
//      학교코드, 기관 구분코드, 학교과정/학년 구분코드)로 *반드시 교체* 해야 한다.
//
//   - PLATFORM_CODE : context.platform (대외기관 구분코드, 충북=M10 가정)
//   - HOMEPAGE      : actor.account.homePage (대외기관 웹사이트)
//   - resolveSchoolInfo(userId) → context.extensions[school-info]
//       { schoolCode, schoolLevelCode(SLC), schoolGradeCode(SGC) }
//   - normalizeStdId / normalizeStdIds : 14자리 표준체계 ID 보정
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙(대외연계)의 범위 밖이며 미구현이다.
// ─────────────────────────────────────────────────────────────

// db 는 lazy require (test/_setup 의 DB_PATH 주입 타이밍을 보장하기 위해
//   require 시점이 아닌 함수 호출 시점에 가져온다).
function getDb() {
  return require('../../db');
}

// ─────────────────────────────────────────────────────────────
// 기관/홈페이지 (가상값)
// ─────────────────────────────────────────────────────────────
const PLATFORM_CODE = process.env.AIDT_PLATFORM_CODE || 'M10';        // 충북교육청(가정)
const HOMEPAGE = process.env.AIDT_HOMEPAGE || 'https://www.cbe.go.kr'; // 충북교육청 공식(가정)

// school-info 고정 더미 (조회 실패/누락 시 — 절대 null 금지)
const DUMMY_SCHOOL_INFO = Object.freeze({
  schoolCode: 'K100000000',
  schoolLevelCode: 'SLC001',
  schoolGradeCode: 'SGC000',
});

// ─────────────────────────────────────────────────────────────
// 학년 → 학년 구분코드 (SGC) : 'SGC' + 3자리 zero-pad
//   1학년→SGC001 … 12학년→SGC012. 범위 밖/누락 → SGC000.
// ─────────────────────────────────────────────────────────────
function gradeToSchoolGradeCode(grade) {
  const g = Number(grade);
  if (!Number.isInteger(g) || g < 1 || g > 12) return 'SGC000';
  return 'SGC' + String(g).padStart(3, '0');
}

// ─────────────────────────────────────────────────────────────
// 학교과정 구분코드 (SLC) : 초 SLC001 / 중 SLC002 / 고 SLC003
//   grade(1~12) 우선, 없으면 schoolLevel('elementary'/'middle'/'high') 보조.
//   못 정하면 SLC001.
// ─────────────────────────────────────────────────────────────
function gradeToSchoolLevelCode(grade, schoolLevel) {
  const g = Number(grade);
  if (Number.isInteger(g) && g >= 1 && g <= 12) {
    if (g <= 6) return 'SLC001';   // 초 1~6
    if (g <= 9) return 'SLC002';   // 중 7~9
    return 'SLC003';               // 고 10~12
  }
  const lv = String(schoolLevel || '').toLowerCase().trim();
  if (lv === 'elementary' || lv === '초' || lv === 'elem') return 'SLC001';
  if (lv === 'middle' || lv === '중') return 'SLC002';
  if (lv === 'high' || lv === '고') return 'SLC003';
  return 'SLC001';
}

// ─────────────────────────────────────────────────────────────
// 학교명 → 학교코드 (가상)
//   'K1' + (학교명 djb2 해시 8자리 zero-pad) = 10자리 (예: K100000383).
//   학교명 없으면 K100000000. 결정적(같은 이름 → 같은 코드).
// ─────────────────────────────────────────────────────────────
function djb2(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i); // h * 33 + c
    h = h & 0xffffffff;                    // 32bit 유지
  }
  return Math.abs(h);
}

function schoolCodeFromName(schoolName) {
  const name = String(schoolName || '').trim();
  if (!name) return 'K100000000';
  const num = djb2(name) % 100000000;          // 0 ~ 99,999,999
  return 'K1' + String(num).padStart(8, '0');  // K1 + 8자리 = 10자리
}

// ─────────────────────────────────────────────────────────────
// userId → school-info 산출 (절대 null 금지)
//   조회 실패/누락/userId 없음 → 고정 더미.
// ─────────────────────────────────────────────────────────────
function resolveSchoolInfo(userId) {
  if (userId == null) return { ...DUMMY_SCHOOL_INFO };
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT grade, school_name, school_level FROM users WHERE id = ?')
      .get(userId);
    if (!row) return { ...DUMMY_SCHOOL_INFO };
    return {
      schoolCode: schoolCodeFromName(row.school_name),
      schoolLevelCode: gradeToSchoolLevelCode(row.grade, row.school_level),
      schoolGradeCode: gradeToSchoolGradeCode(row.grade),
    };
  } catch (_) {
    return { ...DUMMY_SCHOOL_INFO };
  }
}

// ─────────────────────────────────────────────────────────────
// 표준체계 ID (14자리) 보정
//   std-resolver 산출 형식(예 'E4MATA01B10C01' = 14자) 그대로 사용하되,
//   길이가 14가 아니면 보정 — 초과 시 앞 14자 절단, 미만 시 끝에 '0' 패딩.
//   빈값/null → null.
// ─────────────────────────────────────────────────────────────
function normalizeStdId(id) {
  if (id == null) return null;
  let s = String(id).trim();
  if (!s) return null;
  if (s.length > 14) return s.slice(0, 14);
  if (s.length < 14) return s.padEnd(14, '0');
  return s;
}

function normalizeStdIds(arr) {
  let list;
  if (Array.isArray(arr)) list = arr;
  else if (arr == null || arr === '') list = [];
  else list = [arr];
  const out = [];
  for (const v of list) {
    const n = normalizeStdId(v);
    if (n) out.push(n);
  }
  return out;
}

module.exports = {
  PLATFORM_CODE,
  HOMEPAGE,
  DUMMY_SCHOOL_INFO,
  gradeToSchoolGradeCode,
  gradeToSchoolLevelCode,
  schoolCodeFromName,
  resolveSchoolInfo,
  normalizeStdId,
  normalizeStdIds,
};
