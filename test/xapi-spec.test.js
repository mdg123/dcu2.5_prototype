// test/xapi-spec.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 「학습데이터 대외연계 기술규격 v1.0」 — xAPI Statement JSON 정합 불변식 박제.
//   대상: lib/xapi/builders/*.js (대외연계 트랙 B). 트랙 A(learning_logs)·LRS 통계는 무관.
//
//   불변식:
//     INV-XAPI1  모든 확장 IRI 플랫 (프로필 세그먼트 없음; dacheum.kr ns 예외)
//     INV-XAPI2  object.definition.extensions 에 curriculum-standard-id 키 존재
//     INV-XAPI3  context.extensions[school-info](3종) 존재 + platform === 'M10'
//     INV-XAPI4  partner-id 키 부재 (모든 확장 키)
//     INV-XAPI5  verb.id 가 v1.0 표준 verb set 포함
//     INV-XAPI6  actor: Agent + account.name UUID + homePage + actor.name 부재
//     INV-XAPI7  timestamp …SSSZ 형식
//     + aidt-validator: 정합 statement ok=true / 위반 변형 ok=false
//
//   ※ 실제 전송/JWT/엔드포인트는 본 트랙의 범위 밖(미구현) — JSON 구조만 검증.
// ─────────────────────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { setupTestDb, openTestDb } = require('./_setup');

// ★ db 모듈 require 전에 DB_PATH 주입
setupTestDb();

const common = require('../lib/xapi/common');
const validator = require('../lib/xapi/aidt-validator');
const codebook = require('../lib/xapi/codebook');

const buildMedia      = require('../lib/xapi/builders/media');
const buildAssessment = require('../lib/xapi/builders/assessment');
const buildAssignment = require('../lib/xapi/builders/assignment');
const buildNavigation = require('../lib/xapi/builders/navigation');
const buildSocial     = require('../lib/xapi/builders/social');
const buildSurvey     = require('../lib/xapi/builders/survey');
const buildQuery      = require('../lib/xapi/builders/query');
const buildObjective  = require('../lib/xapi/builders/objective');
const buildAnnotation = require('../lib/xapi/builders/annotation');
const buildTeaching   = require('../lib/xapi/builders/teaching');

const { AIDT_DOMAIN, STANDARD_VERB_IDS } = common;
const CURRICULUM_STD_KEY = `${AIDT_DOMAIN}/xapi/objects/extensions/curriculum-standard-id`;
const SCHOOL_INFO_KEY = `${AIDT_DOMAIN}/xapi/contexts/extensions/school-info`;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DACHEUM_NS = 'https://dacheum.kr/';

// 실제 존재 학생 id 확보 (없으면 fallback 9999)
let STUDENT_ID = 9999;
try {
  const db = openTestDb();
  const row = db.prepare("SELECT id FROM users WHERE role='student' LIMIT 1").get();
  if (row && row.id) STUDENT_ID = row.id;
} catch (_) { /* fallback */ }

const CTX = { userId: STUDENT_ID, classId: 1 };
const STD = { curriculum_standard_ids: 'E4MATA01B10C01,E4KORA01B02C03', subject_code: 'math-e', grade_group: 4 };

// 영역별 대표 payload (curriculum_standard_ids 일부 포함 — 표준 ID 경로도 태움)
function buildSamples() {
  return {
    media:      buildMedia(CTX,      { content_id: 11, title: '영상1', content_type: 'video', duration_seconds: 120, completion_percent: 80, mute_count: 1, ...STD }),
    assessment: buildAssessment(CTX, { assessment_id: 21, title: '형성평가', assessment_type: 'formative', verb: 'submitted', score: { raw: 8, max: 10 }, duration_seconds: 300, item_results: [{ question_id: 1, correct: true, question_type: 'mcq' }], ...STD }),
    assignment: buildAssignment(CTX, { assignment_id: 31, title: '과제1', verb: 'finished', submission: { status: 'submitted', score: 9, max_score: 10 }, ...STD }),
    assignmentGave: buildAssignment({ userId: STUDENT_ID, classId: 1 }, { assignment_id: 32, title: '출제', verb: 'gave', target_user_ids: [1, 2], ...STD }),
    navigation: buildNavigation(CTX, { content_id: 41, title: '문서1', content_type: 'document', verb: 'viewed', ...STD }),
    social:     buildSocial(CTX,      { board_id: 51, board_kind: 'class', verb: 'shared', post_title: '글', ...STD }),
    survey:     buildSurvey(CTX,      { survey_id: 61, survey_kind: 'emotion_attendance', verb: 'responded', emotion: 'happy', ...STD }),
    query:      buildQuery(CTX,       { query_text: '분수', verb: 'searched', filters: { content_type: 'video' }, ...STD }),
    objective:  buildObjective(CTX,   { objective_id: 71, title: '목표', verb: 'set', target_curriculum_standard_ids: STD.curriculum_standard_ids, subject_code: STD.subject_code }),
    annotation: buildAnnotation(CTX,  { annotation_id: 81, target_id: 9, body: '메모', verb: 'annotated', ...STD }),
    teaching:   buildTeaching(CTX,    { feedback_id: 91, verb: 'gave', kind: 'feedback', message: '잘했어요', target_user_ids: [1], ...STD }),
  };
}

// 확장 키 순회 (object.definition.extensions + result.extensions + context.extensions)
function allExtKeys(s) {
  const keys = [];
  const push = (obj) => { if (obj && typeof obj === 'object') keys.push(...Object.keys(obj)); };
  push(s.object && s.object.definition && s.object.definition.extensions);
  push(s.result && s.result.extensions);
  push(s.context && s.context.extensions);
  return keys;
}

const PROFILE_EXT_RE = /\/xapi\/profiles\/.+\/extensions\//;

for (const [area, makeFn] of Object.entries({
  media: 1, assessment: 1, assignment: 1, assignmentGave: 1, navigation: 1,
  social: 1, survey: 1, query: 1, objective: 1, annotation: 1, teaching: 1,
})) {
  test(`xAPI v1.0 불변식 — ${area}`, () => {
    const res = buildSamples()[area];
    assert.ok(res && res.statement && !res.error, `${area} builder 실패: ${res && res.error}`);
    const s = res.statement;

    // INV-XAPI1: 모든 확장 IRI 플랫 (프로필 세그먼트 없음; dacheum.kr ns 예외)
    for (const k of allExtKeys(s)) {
      if (k.startsWith(DACHEUM_NS)) continue;
      if (k.startsWith(`${AIDT_DOMAIN}/`)) {
        assert.ok(!PROFILE_EXT_RE.test(k), `${area}: 프로필형 확장 IRI 발견: ${k}`);
      }
    }

    // INV-XAPI2: object.definition.extensions 에 curriculum-standard-id 키 존재
    const objExt = (s.object && s.object.definition && s.object.definition.extensions) || {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(objExt, CURRICULUM_STD_KEY),
      `${area}: object 에 curriculum-standard-id 키 없음`
    );

    // INV-XAPI3: school-info(3종) + platform M10
    assert.equal(s.context.platform, 'M10', `${area}: platform !== M10`);
    const school = s.context.extensions[SCHOOL_INFO_KEY];
    assert.ok(school, `${area}: school-info 없음`);
    for (const f of ['schoolCode', 'schoolLevelCode', 'schoolGradeCode']) {
      assert.ok(school[f] != null, `${area}: school-info.${f} 없음`);
    }

    // INV-XAPI4: partner-id 키 부재
    for (const k of allExtKeys(s)) {
      assert.ok(!k.includes('partner-id'), `${area}: partner-id 키 발견: ${k}`);
    }

    // INV-XAPI5: verb.id 가 v1.0 표준 set 포함
    assert.ok(STANDARD_VERB_IDS.has(s.verb.id), `${area}: 비표준 verb IRI: ${s.verb.id}`);

    // INV-XAPI6: actor
    assert.equal(s.actor.objectType, 'Agent', `${area}: actor.objectType`);
    assert.ok(s.actor.account && s.actor.account.homePage, `${area}: homePage 없음`);
    assert.ok(/^[0-9a-f-]{36}$/i.test(s.actor.account.name), `${area}: account.name UUID 아님`);
    assert.equal(s.actor.name, undefined, `${area}: actor.name(한글 실명) 존재함 (PII)`);

    // INV-XAPI7: timestamp …SSSZ
    assert.ok(TS_RE.test(s.timestamp), `${area}: timestamp 형식 위반: ${s.timestamp}`);

    // validator: 정합 statement 는 ok=true
    const v = validator.validateStatement(s);
    assert.ok(v.ok, `${area}: validator 실패 — ${v.errors.join(' | ')}`);
  });
}

// ── 표준 ID 14자 보정 확인 (media 샘플은 14자 std id 2개 → 보정 후 14자 유지) ──
test('xAPI v1.0 — curriculum-standard-id 14자 보정 배열', () => {
  const s = buildSamples().media.statement;
  const ids = s.object.definition.extensions[CURRICULUM_STD_KEY];
  assert.ok(Array.isArray(ids) && ids.length > 0, 'std id 배열이어야 함');
  for (const id of ids) assert.equal(String(id).length, 14, `14자 아님: ${id}`);
});

// ── codebook 규칙 단위 검증 ──
test('codebook — SGC/SLC/schoolCode/normalizeStdId 규칙', () => {
  assert.equal(codebook.gradeToSchoolGradeCode(1), 'SGC001');
  assert.equal(codebook.gradeToSchoolGradeCode(12), 'SGC012');
  assert.equal(codebook.gradeToSchoolGradeCode(0), 'SGC000');
  assert.equal(codebook.gradeToSchoolGradeCode(null), 'SGC000');
  assert.equal(codebook.gradeToSchoolLevelCode(4), 'SLC001');
  assert.equal(codebook.gradeToSchoolLevelCode(8), 'SLC002');
  assert.equal(codebook.gradeToSchoolLevelCode(11), 'SLC003');
  assert.equal(codebook.gradeToSchoolLevelCode(null, 'middle'), 'SLC002');
  // schoolCode: 결정적 + 10자리 K1 prefix
  const a = codebook.schoolCodeFromName('금성초등학교');
  const b = codebook.schoolCodeFromName('금성초등학교');
  assert.equal(a, b, '같은 이름 → 같은 코드');
  assert.match(a, /^K1\d{8}$/, 'K1+8자리');
  assert.equal(codebook.schoolCodeFromName(''), 'K100000000');
  // normalizeStdId 14자 보정
  assert.equal(codebook.normalizeStdId('E4MATA01B10C01'), 'E4MATA01B10C01'); // 14자 유지
  assert.equal(codebook.normalizeStdId('ABC').length, 14);                    // 패딩
  assert.equal(codebook.normalizeStdId('A'.repeat(20)).length, 14);           // 절단
  assert.equal(codebook.normalizeStdId(''), null);
  assert.deepEqual(codebook.normalizeStdIds(null), []);
});

// ── resolveSchoolInfo 절대 null 금지 ──
test('codebook — resolveSchoolInfo 절대 null 금지', () => {
  const ok = codebook.resolveSchoolInfo(STUDENT_ID);
  assert.ok(ok && ok.schoolCode && ok.schoolLevelCode && ok.schoolGradeCode);
  const missing = codebook.resolveSchoolInfo(987654321); // 없는 유저
  assert.deepEqual(missing, codebook.DUMMY_SCHOOL_INFO);
  const nullUser = codebook.resolveSchoolInfo(null);
  assert.deepEqual(nullUser, codebook.DUMMY_SCHOOL_INFO);
});

// ── validator: 위반 변형은 ok=false ──
test('aidt-validator — partner-id 주입 시 ok=false', () => {
  const s = buildSamples().media.statement;
  // 정상 → ok
  assert.ok(validator.validateStatement(s).ok);
  // partner-id 주입 → 위반
  const bad = JSON.parse(JSON.stringify(s));
  bad.context.extensions[`${AIDT_DOMAIN}/xapi/profiles/cmn/1.0/contexts/extensions/partner-id`] = 'dacheum';
  assert.equal(validator.validateStatement(bad).ok, false, 'partner-id 위반 탐지 실패');
});

test('aidt-validator — 프로필형 확장 IRI 주입 시 ok=false', () => {
  const s = buildSamples().assessment.statement;
  assert.ok(validator.validateStatement(s).ok);
  const bad = JSON.parse(JSON.stringify(s));
  bad.result.extensions[`${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/results/extensions/assessment-detail`] = [{}];
  assert.equal(validator.validateStatement(bad).ok, false, '프로필형 확장 IRI 위반 탐지 실패');
});

test('aidt-validator — school-info 누락 시 ok=false', () => {
  const s = buildSamples().survey.statement;
  assert.ok(validator.validateStatement(s).ok);
  const bad = JSON.parse(JSON.stringify(s));
  delete bad.context.extensions[SCHOOL_INFO_KEY];
  assert.equal(validator.validateStatement(bad).ok, false, 'school-info 누락 탐지 실패');
});

test('aidt-validator — curriculum-standard-id 키 누락 시 ok=false', () => {
  const s = buildSamples().annotation.statement;
  assert.ok(validator.validateStatement(s).ok);
  const bad = JSON.parse(JSON.stringify(s));
  delete bad.object.definition.extensions[CURRICULUM_STD_KEY];
  assert.equal(validator.validateStatement(bad).ok, false, 'curriculum-standard-id 누락 탐지 실패');
});

test('aidt-validator — actor.name(PII) 존재 시 ok=false', () => {
  const s = buildSamples().query.statement;
  assert.ok(validator.validateStatement(s).ok);
  const bad = JSON.parse(JSON.stringify(s));
  bad.actor.name = '홍길동';
  assert.equal(validator.validateStatement(bad).ok, false, 'actor.name PII 탐지 실패');
});
