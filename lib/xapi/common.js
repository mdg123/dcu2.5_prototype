// lib/xapi/common.js
// ─────────────────────────────────────────────────────────────
// AIDT 기술규격 v2.2 정합 xAPI 공통 유틸.
//   - actor/context 빌더
//   - AIDT 콘텐츠타입 / 평가타입 매퍼
//   - 성취수준 환산 (초 A~C, 중·고 A~E)
//   - UUIDv5 (AIDT 학습자 식별)
// ─────────────────────────────────────────────────────────────
const { v5: uuidv5 } = require('uuid');
const { resolveStandardContext } = require('./std-resolver');

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────
const PLATFORM_NAME = '다채움';
const PARTNER_ID = process.env.AIDT_PARTNER_ID || 'dacheum';
const HOME_PAGE = process.env.AIDT_HOMEPAGE || 'https://dacheum.kr';
const UUID_NAMESPACE = process.env.AIDT_UUID_NAMESPACE
  || 'b5f6c7d8-9e0a-4b1c-8d2e-3f4a5b6c7d8e'; // 프로젝트 고정 namespace

const EXT = {
  partnerId:         'http://aidtbook.kr/xapi/extensions/partner-id',
  stdIds:            'http://aidtbook.kr/xapi/extensions/curriculum-standard-id',
  achCodes:          'http://aidtbook.kr/xapi/extensions/achievement-code',
  achStandards:      'http://aidtbook.kr/xapi/extensions/achievement-standard',
  achievementLevel:  'http://aidtbook.kr/xapi/extensions/achievement-level',
  // 영역별 확장 (B2 에서 주로 사용)
  contentType:       'http://aidtbook.kr/xapi/extensions/content-type',
  assessmentType:    'http://aidtbook.kr/xapi/extensions/assessment-type',
  itemType:          'http://aidtbook.kr/xapi/extensions/item-type',
  questionType:      'http://aidtbook.kr/xapi/extensions/question-type',
  subjectCode:       'http://aidtbook.kr/xapi/extensions/subject-code',
  gradeGroup:        'http://aidtbook.kr/xapi/extensions/grade-group',
  schoolLevel:       'http://aidtbook.kr/xapi/extensions/school-level',
  classId:           'http://aidtbook.kr/xapi/extensions/class-id',
  sessionId:         'http://aidtbook.kr/xapi/extensions/session-id',
  durationSec:       'http://aidtbook.kr/xapi/extensions/duration-seconds',
  targetObjectId:    'http://aidtbook.kr/xapi/extensions/target-object-id',
  sourceUrl:         'http://aidtbook.kr/xapi/extensions/source-url',
};

// 공통 verb (adlnet)
const VERB = {
  viewed:     { id: 'http://id.tincanapi.com/verb/viewed',           display: { 'ko-KR': '조회함',   'en-US': 'viewed'   }},
  read:       { id: 'http://id.tincanapi.com/verb/read',             display: { 'ko-KR': '읽음',     'en-US': 'read'     }},
  did:        { id: 'http://adlnet.gov/expapi/verbs/experienced',    display: { 'ko-KR': '경험함',   'en-US': 'did'      }},
  learned:    { id: 'http://adlnet.gov/expapi/verbs/completed',      display: { 'ko-KR': '학습함',   'en-US': 'learned'  }},
  played:     { id: 'http://adlnet.gov/expapi/verbs/played',         display: { 'ko-KR': '재생함',   'en-US': 'played'   }},
  submitted:  { id: 'http://activitystrea.ms/submit',                display: { 'ko-KR': '제출함',   'en-US': 'submitted'}},
  scored:     { id: 'http://adlnet.gov/expapi/verbs/scored',         display: { 'ko-KR': '채점됨',   'en-US': 'scored'   }},
  passed:     { id: 'http://adlnet.gov/expapi/verbs/passed',         display: { 'ko-KR': '통과함',   'en-US': 'passed'   }},
  failed:     { id: 'http://adlnet.gov/expapi/verbs/failed',         display: { 'ko-KR': '미통과',   'en-US': 'failed'   }},
  gave:       { id: 'http://id.tincanapi.com/verb/gave',             display: { 'ko-KR': '부여함',   'en-US': 'gave'     }},
  finished:   { id: 'http://adlnet.gov/expapi/verbs/completed',      display: { 'ko-KR': '완료함',   'en-US': 'finished' }},
  searched:   { id: 'http://activitystrea.ms/search',                display: { 'ko-KR': '검색함',   'en-US': 'searched' }},
  asked:      { id: 'http://adlnet.gov/expapi/verbs/asked',          display: { 'ko-KR': '질문함',   'en-US': 'asked'    }},
  shared:     { id: 'http://adlnet.gov/expapi/verbs/shared',         display: { 'ko-KR': '공유함',   'en-US': 'shared'   }},
  commented:  { id: 'http://adlnet.gov/expapi/verbs/commented',      display: { 'ko-KR': '댓글씀',   'en-US': 'commented'}},
  liked:      { id: 'http://activitystrea.ms/like',                  display: { 'ko-KR': '좋아요',   'en-US': 'liked'    }},
  annotated:  { id: 'http://risc-inc.com/annotator/verbs/annotated', display: { 'ko-KR': '주석함',   'en-US': 'annotated'}},
  planned:    { id: 'http://id.tincanapi.com/verb/planned',          display: { 'ko-KR': '계획함',   'en-US': 'planned'  }},
  achieved:   { id: 'http://adlnet.gov/expapi/verbs/achieved',       display: { 'ko-KR': '달성함',   'en-US': 'achieved' }},
  responded:  { id: 'http://adlnet.gov/expapi/verbs/responded',      display: { 'ko-KR': '응답함',   'en-US': 'responded'}},
  reorganized:{ id: 'http://id.tincanapi.com/verb/reorganized',      display: { 'ko-KR': '재편성함', 'en-US': 'reorganized'}},
};

// 내부 content_type → AIDT 코드 (E/I/A/V/IM/T/P/Z)
const CONTENT_TYPE_MAP = {
  video:    'V',    // Video
  audio:    'A',    // Audio
  image:    'IM',   // Image
  document: 'T',    // Text/Document
  quiz:     'P',    // Problem set
  exam:     'E',    // Evaluation
  exercise: 'I',    // Interactive item
  lesson:   'Z',    // mixed
};

function mapContentType(t) {
  return CONTENT_TYPE_MAP[String(t || '').toLowerCase()] || 'Z';
}

// 평가 유형 매핑
const ASSESSMENT_TYPE_MAP = {
  diagnosis:   'diagnosis',      // 진단평가
  formative:   'formative',      // 형성평가
  summative:   'summative',      // 총괄평가
  self_check:  'self-check',     // 자기점검
  homework:    'homework',
  practice:    'practice',
};
function mapAssessmentType(t) {
  return ASSESSMENT_TYPE_MAP[String(t || '').toLowerCase()] || 'practice';
}

// 문항 유형
const QUESTION_TYPE_MAP = {
  multiple_choice: 'MCQ',
  short_answer:    'SAQ',
  essay:           'ESS',
  ox:              'TF',
  ordering:        'ORD',
  matching:        'MAT',
  fill_blank:      'FIB',
};
function mapQuestionType(t) {
  return QUESTION_TYPE_MAP[String(t || '').toLowerCase()] || 'MCQ';
}

// ─────────────────────────────────────────────────────────────
// 학습자 식별
// ─────────────────────────────────────────────────────────────
/** 숫자 user_id → 고정 UUIDv5 (namespace 기반, 안정적) */
function userUuid(userId) {
  return uuidv5(`dacheum:user:${userId}`, UUID_NAMESPACE);
}

/** xAPI actor (Agent) */
function makeActor(userId, displayName) {
  return {
    objectType: 'Agent',
    name: displayName || `user-${userId}`,
    account: {
      homePage: HOME_PAGE,
      name: userUuid(userId),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 성취수준 환산
// ─────────────────────────────────────────────────────────────
/**
 * 정답률·학교급별 성취수준 산출.
 *  초(initial school_level === '초' 또는 subject 가 *-e) → A~C
 *  중/고                                                    → A~E
 *  null/0 학습자에 대해서는 null 반환.
 */
function computeAchievementLevel({ subject_code, school_level, correct, total, percentile }) {
  const t = total > 0 ? total : (percentile != null ? 100 : 0);
  const c = correct != null ? correct : (percentile != null ? percentile : 0);
  if (t <= 0) return null;
  const ratio = c / t;
  const isElementary = school_level === '초' || /-e$/.test(subject_code || '');
  if (isElementary) {
    if (ratio >= 0.80) return 'A';
    if (ratio >= 0.60) return 'B';
    return 'C';
  }
  if (ratio >= 0.90) return 'A';
  if (ratio >= 0.80) return 'B';
  if (ratio >= 0.70) return 'C';
  if (ratio >= 0.60) return 'D';
  return 'E';
}

// ─────────────────────────────────────────────────────────────
// 표준체계 extension 블록 생성 (모든 빌더가 공용)
// ─────────────────────────────────────────────────────────────
function buildStandardExtensions(ctxResolve, opts = {}) {
  const out = {};
  if (ctxResolve.std_ids.length) out[EXT.stdIds] = ctxResolve.std_ids;
  if (ctxResolve.codes.length)   out[EXT.achCodes] = ctxResolve.codes;
  if (ctxResolve.items.length) {
    out[EXT.achStandards] = ctxResolve.items.map(i => ({
      std_id: i.std_id,
      code: i.code,
      content: i.content,
      area: i.area,
      subject_code: i.subject_code,
      grade_group: i.grade_group,
    }));
  }
  if (ctxResolve.subject_code) out[EXT.subjectCode] = ctxResolve.subject_code;
  if (ctxResolve.grade_group != null) out[EXT.gradeGroup] = ctxResolve.grade_group;
  if (opts.achievement_level) out[EXT.achievementLevel] = opts.achievement_level;
  return out;
}

// ─────────────────────────────────────────────────────────────
// context 빌더 (공통 부분)
// ─────────────────────────────────────────────────────────────
function makeContext({ sessionId, classId, extraExtensions = {} } = {}) {
  const extensions = {
    [EXT.partnerId]: PARTNER_ID,
    ...extraExtensions,
  };
  if (sessionId) extensions[EXT.sessionId] = sessionId;
  if (classId != null) extensions[EXT.classId] = classId;
  return {
    platform: PLATFORM_NAME,
    language: 'ko-KR',
    extensions,
  };
}

// ─────────────────────────────────────────────────────────────
// base statement 껍데기
// ─────────────────────────────────────────────────────────────
function makeStatement({ actor, verb, object, result, context, timestamp }) {
  const s = {
    actor,
    verb,
    object,
    timestamp: timestamp || new Date().toISOString(),
  };
  if (result)  s.result  = result;
  if (context) s.context = context;
  return s;
}

// ─────────────────────────────────────────────────────────────
// object 빌더 (공통 오브젝트 타입)
// ─────────────────────────────────────────────────────────────
function makeActivity({ type, id, name, description, extraExtensions = {} }) {
  return {
    objectType: 'Activity',
    id: `http://aidtbook.kr/xapi/objects/${type}/${id}`,
    definition: {
      type: `http://aidtbook.kr/xapi/activities/${type}`,
      name: name ? { 'ko-KR': name } : undefined,
      description: description ? { 'ko-KR': description } : undefined,
      extensions: Object.keys(extraExtensions).length ? extraExtensions : undefined,
    },
  };
}

module.exports = {
  // 상수
  PLATFORM_NAME, PARTNER_ID, HOME_PAGE, EXT, VERB,
  // 매핑
  mapContentType, mapAssessmentType, mapQuestionType,
  CONTENT_TYPE_MAP, ASSESSMENT_TYPE_MAP, QUESTION_TYPE_MAP,
  // 식별·빌더
  userUuid, makeActor, makeContext, makeStatement, makeActivity,
  buildStandardExtensions,
  // 성취수준
  computeAchievementLevel,
  // 표준체계 리졸버 re-export
  resolveStandardContext,
};
