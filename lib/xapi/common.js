// lib/xapi/common.js
// ─────────────────────────────────────────────────────────────
// 「학습데이터 대외연계 기술규격 v1.0」 정합 xAPI 공통 유틸 (대외연계 트랙 B).
//   - actor(Agent, account.name=UUID v5, homePage=기관 URL) / context(platform=기관코드 + school-info)
//   - 확장 IRI: 플랫 형식
//       object  → ${AIDT_DOMAIN}/xapi/objects/extensions/{name}
//       result  → ${AIDT_DOMAIN}/xapi/results/extensions/{name}
//       context → ${AIDT_DOMAIN}/xapi/contexts/extensions/{name}
//   - verb IRI: ${AIDT_DOMAIN}/xapi/profiles/{area}/1.0/verbs/{verb}
//   - curriculum-standard-id 는 표준 object 확장(아래 stdIdExtension 헬퍼)으로.
//   - 다채움 내부 메타(DACHEUM_EXT_NS)는 대시보드용으로 유지.
//
//   ※ 실제 전송/JWT/엔드포인트(배치·Transfer-Id·chunked·OAuth2)는 본 트랙의 범위 밖.
//      본 파일은 Statement JSON 구조 정합만 담당한다.
// ─────────────────────────────────────────────────────────────
const { v5: uuidv5, v4: uuidv4 } = require('uuid');
const { resolveStandardContext } = require('./std-resolver');
const codebook = require('./codebook');

// ─────────────────────────────────────────────────────────────
// 상수 — 운영 환경변수
// ─────────────────────────────────────────────────────────────
const UUID_NAMESPACE = process.env.AIDT_UUID_NAMESPACE
  || 'b5f6c7d8-9e0a-4b1c-8d2e-3f4a5b6c7d8e'; // 프로젝트 고정 namespace

// AIDT 프로필 도메인 (v1.0)
const AIDT_DOMAIN = process.env.AIDT_DOMAIN || 'http://aidtbook.kr';

// 다채움 고유 extension namespace (AIDT 표준 외 데이터 보존용 — 대시보드)
const DACHEUM_EXT_NS = 'https://dacheum.kr/xapi/extension';

// 난이도 "없음" 상수
const DIFFICULTY_NONE = -1;

// ─────────────────────────────────────────────────────────────
// v1.0 플랫 확장 IRI
//   object  : /xapi/objects/extensions/{name}
//   result  : /xapi/results/extensions/{name}
//   context : /xapi/contexts/extensions/{name}
// ─────────────────────────────────────────────────────────────
const objExt = (name) => `${AIDT_DOMAIN}/xapi/objects/extensions/${name}`;
const resExt = (name) => `${AIDT_DOMAIN}/xapi/results/extensions/${name}`;
const ctxExt = (name) => `${AIDT_DOMAIN}/xapi/contexts/extensions/${name}`;

const EXT = {
  // ─── 표준 object 확장 (v1.0 — 모두 플랫) ───
  curriculumStandardId: objExt('curriculum-standard-id'),
  aitutorRecommended:   objExt('aitutor-recommended'),

  // media (audio/video 통합 → media-*)
  mediaInfo:            objExt('media-info'),
  mediaDetail:          resExt('media-detail'),

  // assessment
  assessmentInfo:       objExt('assessment-info'),
  assessmentDetail:     resExt('assessment-detail'),

  // assignment
  assignmentInfo:       objExt('assignment-info'),
  gavAssignment:        resExt('gav-assignment'),
  finAssignment:        resExt('fin-assignment'),

  // navigation (content-viewing 4분기)
  imageInfo:            objExt('image-info'),
  documentInfo:         objExt('document-info'),
  practiceInfo:         objExt('practice-info'),
  etcContentInfo:       objExt('etc-content-info'),

  // query
  keywordInfo:          objExt('keyword-info'),
  searchDetail:         resExt('search-detail'),
  askDetail:            resExt('ask-detail'),

  // objective
  objectiveDetail:      resExt('objective-detail'),

  // social-learning
  boardInfo:            objExt('board-info'),
  socialLearningDetail: resExt('social-learning-detail'),

  // survey (3분기)
  comprehensionSurveyInfo:   objExt('comprehension-survey-info'),
  comprehensionSurveyDetail: resExt('comprehension-survey-detail'),
  emotionSurveyInfo:         objExt('emotion-survey-info'),
  emotionSurveyDetail:       resExt('emotion-survey-detail'),
  emotionTodaySurveyInfo:    objExt('emotion-today-survey-info'),
  emotionTodaySurveyDetail:  resExt('emotion-today-survey-detail'),

  // annotation
  annotationDetail:     resExt('annotation-detail'),

  // teaching
  feedbackInfo:         objExt('feedback-info'),
  classInfo:            objExt('class-info'),

  // ─── 표준 context 확장 (v1.0) ───
  schoolInfo:           ctxExt('school-info'),

  // ─── 다채움 내부 메타 (대시보드용, 표준 외 — namespace 분리) ───
  stdIds:            `${DACHEUM_EXT_NS}/curriculum-standard-id`,
  achCodes:          `${DACHEUM_EXT_NS}/achievement-code`,
  achStandards:      `${DACHEUM_EXT_NS}/achievement-standard`,
  achievementLevel:  `${DACHEUM_EXT_NS}/achievement-level`,
  contentType:       `${DACHEUM_EXT_NS}/content-type`,
  assessmentType:    `${DACHEUM_EXT_NS}/assessment-type`,
  itemType:          `${DACHEUM_EXT_NS}/item-type`,
  questionType:      `${DACHEUM_EXT_NS}/question-type`,
  subjectCode:       `${DACHEUM_EXT_NS}/subject-code`,
  gradeGroup:        `${DACHEUM_EXT_NS}/grade-group`,
  schoolLevel:       `${DACHEUM_EXT_NS}/school-level`,
  classId:           `${DACHEUM_EXT_NS}/class-id`,
  sessionId:         `${DACHEUM_EXT_NS}/session-id`,
  durationSec:       `${DACHEUM_EXT_NS}/duration-seconds`,
  targetObjectId:    `${DACHEUM_EXT_NS}/target-object-id`,
  sourceUrl:         `${DACHEUM_EXT_NS}/source-url`,
};

// ─────────────────────────────────────────────────────────────
// v1.0 표준 verb URL
//   IRI = ${AIDT_DOMAIN}/xapi/profiles/{area}/1.0/verbs/{verb}
//   social-learning 과 content-viewing 둘 다 'viewed' 가 있어 키 충돌 →
//   socialViewed / contentViewed 로 키 구분 (IRI 는 각자 정확).
// ─────────────────────────────────────────────────────────────
const verbIri = (area, v) => `${AIDT_DOMAIN}/xapi/profiles/${area}/1.0/verbs/${v}`;

const VERB = {
  // ① media
  played:        { id: verbIri('media', 'played'),               display: { 'ko-KR': '재생함',  'en-US': 'played'      }},

  // ② assessment / assessment-item
  submitted:     { id: verbIri('assessment', 'submitted'),       display: { 'ko-KR': '제출함',  'en-US': 'submitted'   }},
  answered:      { id: verbIri('assessment-item', 'answered'),   display: { 'ko-KR': '응답함',  'en-US': 'answered'    }},

  // ③ content-viewing (콘텐츠 열람)
  contentViewed: { id: verbIri('content-viewing', 'viewed'),     display: { 'ko-KR': '열람함',  'en-US': 'viewed'      }},

  // ④ assignment / assignment-t (교사 출제)
  finished:      { id: verbIri('assignment', 'finished'),        display: { 'ko-KR': '완료함',  'en-US': 'finished'    }},
  assigned:      { id: verbIri('assignment-t', 'assigned'),      display: { 'ko-KR': '출제함',  'en-US': 'assigned'    }},

  // ⑤ social-learning (이벤트형)
  posted:        { id: verbIri('social-learning', 'posted'),     display: { 'ko-KR': '게시함',  'en-US': 'posted'      }},
  socialViewed:  { id: verbIri('social-learning', 'viewed'),     display: { 'ko-KR': '열람함',  'en-US': 'viewed'      }},
  replied:       { id: verbIri('social-learning', 'replied'),    display: { 'ko-KR': '답글함',  'en-US': 'replied'     }},
  commented:     { id: verbIri('social-learning', 'commented'),  display: { 'ko-KR': '댓글함',  'en-US': 'commented'   }},
  liked:         { id: verbIri('social-learning', 'liked'),      display: { 'ko-KR': '좋아요함', 'en-US': 'liked'      }},

  // ⑥ survey
  surveySubmitted: { id: verbIri('survey', 'submitted'),         display: { 'ko-KR': '응답함',  'en-US': 'submitted'   }},

  // ⑦ objective
  set:           { id: verbIri('objective', 'set'),              display: { 'ko-KR': '설정함',  'en-US': 'set'         }},

  // ⑧ annotation
  annotated:     { id: verbIri('annotation', 'annotated'),       display: { 'ko-KR': '주석함',  'en-US': 'annotated'   }},

  // ⑨ query
  searched:      { id: verbIri('query', 'searched'),            display: { 'ko-KR': '검색함',  'en-US': 'searched'    }},
  asked:         { id: verbIri('query', 'asked'),               display: { 'ko-KR': '질문함',  'en-US': 'asked'       }},
  closed:        { id: verbIri('query', 'closed'),              display: { 'ko-KR': '종료함',  'en-US': 'closed'      }},

  // ⑩ learning
  learningStarted: { id: verbIri('learning', 'started'),         display: { 'ko-KR': '시작함',  'en-US': 'started'     }},
  learningEnded:   { id: verbIri('learning', 'ended'),           display: { 'ko-KR': '종료함',  'en-US': 'ended'       }},

  // ⑪ 교사: feedback-t / teaching-t
  feedbackGave:    { id: verbIri('feedback-t', 'gave'),          display: { 'ko-KR': '피드백함', 'en-US': 'gave'       }},
  reorganized:     { id: verbIri('teaching-t', 'reorganized'),   display: { 'ko-KR': '재편성함', 'en-US': 'reorganized'}},
  teachingStarted: { id: verbIri('teaching-t', 'started'),       display: { 'ko-KR': '수업시작', 'en-US': 'started'    }},
  teachingEnded:   { id: verbIri('teaching-t', 'ended'),         display: { 'ko-KR': '수업종료', 'en-US': 'ended'      }},
};

// v1.0 표준 verb IRI 집합 (validator / 테스트 공용)
const STANDARD_VERB_IDS = new Set(Object.values(VERB).map(v => v.id));

// ─────────────────────────────────────────────────────────────
// AIDT 표준 activity-type slug 매핑 헬퍼
// 다채움 콘텐츠 유형 → navigation(content-viewing) 4분기 slug
//   image / document / practice / etc-content
// ─────────────────────────────────────────────────────────────
function mapNavigationSlug(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t === 'image' || t === 'im') return 'image';
  if (t === 'document' || t === 'text' || t === 'doc' || t === 't' || t === 'z' || t === 'lesson') return 'document';
  if (t === 'practice' || t === 'quiz' || t === 'exercise' || t === 'p' || t === 'e' || t === 'i') return 'practice';
  if (t === 'video' || t === 'audio' || t === 'v' || t === 'a') return 'etc-content';
  return 'etc-content';
}

// ─────────────────────────────────────────────────────────────
// 감정 이모티콘 → 리커트 정수(1~5) 변환 테이블 (Survey 영역)
// ─────────────────────────────────────────────────────────────
const EMOTION_LIKERT_MAP = {
  'best': 5, 'great': 5, 'excellent': 5, 'happy': 5, 'love': 5, 'smile_xl': 5,
  'good': 4, 'smile': 4, 'okay': 4,
  'normal': 3, 'neutral': 3, 'soso': 3, 'meh': 3,
  'bad': 2, 'sad': 2, 'tired': 2, 'angry': 2,
  'worst': 1, 'cry': 1, 'sick': 1, 'depressed': 1,
};

function emotionToLikert(emotion, score) {
  if (typeof score === 'number' && score >= 1 && score <= 10) {
    return Math.max(1, Math.min(5, Math.round(score / 2)));
  }
  const key = String(emotion || '').toLowerCase().trim();
  return EMOTION_LIKERT_MAP[key] || 3;
}

// ─────────────────────────────────────────────────────────────
// 코드 매핑 — 표준 코드 체계
// ─────────────────────────────────────────────────────────────
const CONTENT_TYPE_MAP = {
  exam:     'E', exercise: 'I', audio:    'A', video:    'V',
  image:    'IM', document: 'T', text:     'T',
  quiz:     'P', practice: 'P', lesson:   'Z', other:    'Z',
};
function mapContentType(t) {
  return CONTENT_TYPE_MAP[String(t || '').toLowerCase()] || 'Z';
}

const ASSESSMENT_TYPE_MAP = {
  diagnostic: 'D', diagnosis: 'D', formative: 'F', summative: 'S',
  self_check: 'E', homework: 'E', practice: 'E', other: 'E',
};
function mapAssessmentType(t) {
  return ASSESSMENT_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

const QUESTION_TYPE_MAP = {
  multiple_choice: 'M', mcq: 'M', short_answer: 'S', saq: 'S',
  long_answer: 'L', essay: 'L', ess: 'L', ox: 'M', tf: 'M',
  ordering: 'E', ord: 'E', matching: 'E', mat: 'E',
  fill_blank: 'S', fib: 'S', other: 'E',
};
function mapQuestionType(t) {
  return QUESTION_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

const BOARD_TYPE_MAP = {
  class: 'C', class_board: 'C', group: 'G', group_board: 'G', team: 'G',
  free: 'E', free_board: 'E', notice: 'E', artist: 'E', other: 'E',
};
function mapBoardType(t) {
  return BOARD_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

const OBJECTIVE_TYPE_MAP = {
  selection: 'S', select: 'S', description: 'D', describe: 'D',
  essay: 'D', other: 'E', etc: 'E',
};
function mapObjectiveType(t) {
  return OBJECTIVE_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

// ─────────────────────────────────────────────────────────────
// 학습자 식별
// ─────────────────────────────────────────────────────────────
/** 숫자 user_id → 고정 UUIDv5 (namespace 기반, 안정적) */
function userUuid(userId) {
  return uuidv5(`dacheum:user:${userId}`, UUID_NAMESPACE);
}

/** xAPI Statement id 용 UUIDv4 (idempotency dedup) */
function newStatementId() {
  return uuidv4();
}

/**
 * xAPI actor (Agent).
 *   v1.0: PII 최소화 — actor.name(한글 실명) 미포함, account.name=UUID 만.
 *   호환을 위해 (userId, displayName) 시그니처는 받되 displayName 은 무시한다.
 */
function makeActor(userId, _displayName) {
  return {
    objectType: 'Agent',
    account: {
      homePage: codebook.HOMEPAGE,
      name: userUuid(userId),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// timestamp 헬퍼 — v1.0: 항상 '...SSSZ' (UTC Z)
// ─────────────────────────────────────────────────────────────
function aidtTimestamp(date) {
  const d = date instanceof Date ? date : (date ? new Date(date) : new Date());
  return d.toISOString(); // 항상 ms 포함 + 'Z'
}

// ─────────────────────────────────────────────────────────────
// 성취수준 환산 (초 A~C, 중·고 A~E)
// ─────────────────────────────────────────────────────────────
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
// 표준 위치 curriculum-standard-id 확장 (object.definition.extensions)
//   resolved.std_ids → 14자 보정 배열. 없으면 키 값 null (키 자체는 존재).
// ─────────────────────────────────────────────────────────────
function stdIdExtension(resolved) {
  const ids = codebook.normalizeStdIds(resolved && resolved.std_ids);
  return { [EXT.curriculumStandardId]: ids.length ? ids : null };
}

// ─────────────────────────────────────────────────────────────
// 다채움 내부 표준체계 메타 (대시보드용 — DACHEUM_EXT_NS)
//   표준 위치 curriculum-standard-id 는 stdIdExtension() 으로 별도 생성.
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
// context 빌더 (v1.0)
//   platform = 기관코드(PLATFORM_CODE), extensions[school-info] (절대 null 금지)
//   makeContext({ userId, schoolInfo, sessionId, classId, extraExtensions })
//     - userId 주면 codebook.resolveSchoolInfo(userId)
//     - schoolInfo 직접 주면 그대로
//     - 둘 다 없으면 고정 더미
// ─────────────────────────────────────────────────────────────
function makeContext({ userId, schoolInfo, sessionId, classId, extraExtensions = {} } = {}) {
  let school = schoolInfo;
  if (!school) {
    school = (userId != null)
      ? codebook.resolveSchoolInfo(userId)
      : { ...codebook.DUMMY_SCHOOL_INFO };
  }
  const extensions = {
    [EXT.schoolInfo]: school,
    ...extraExtensions,
  };
  if (sessionId) extensions[EXT.sessionId] = sessionId;
  if (classId != null) extensions[EXT.classId] = classId;
  return {
    platform: codebook.PLATFORM_CODE,
    language: 'ko-KR',
    extensions,
  };
}

// ─────────────────────────────────────────────────────────────
// base statement 껍데기
// ─────────────────────────────────────────────────────────────
function makeStatement({ id, actor, verb, object, result, context, timestamp }) {
  const s = {
    id: id || newStatementId(),
    actor,
    verb,
    object,
    timestamp: aidtTimestamp(timestamp),
  };
  if (result)  s.result  = result;
  if (context) s.context = context;
  return s;
}

// ─────────────────────────────────────────────────────────────
// object 빌더 (공통 Activity)
// ─────────────────────────────────────────────────────────────
function makeActivity({ type, id, name, description, extraExtensions = {} }) {
  return {
    objectType: 'Activity',
    id: `${AIDT_DOMAIN}/xapi/objects/${type}/${id}`,
    definition: {
      type: `${AIDT_DOMAIN}/xapi/activity-type/${type}`,
      name: name ? { 'ko-KR': name } : undefined,
      description: description ? { 'ko-KR': description } : undefined,
      extensions: Object.keys(extraExtensions).length ? extraExtensions : undefined,
    },
  };
}

module.exports = {
  // 상수
  EXT, VERB, STANDARD_VERB_IDS,
  AIDT_DOMAIN, DACHEUM_EXT_NS, DIFFICULTY_NONE,
  // IRI 헬퍼
  objExt, resExt, ctxExt,
  // 매핑
  mapContentType, mapAssessmentType, mapQuestionType,
  mapBoardType, mapObjectiveType, mapNavigationSlug,
  emotionToLikert, EMOTION_LIKERT_MAP,
  CONTENT_TYPE_MAP, ASSESSMENT_TYPE_MAP, QUESTION_TYPE_MAP,
  BOARD_TYPE_MAP, OBJECTIVE_TYPE_MAP,
  // 식별·빌더
  userUuid, newStatementId, makeActor, makeContext, makeStatement, makeActivity,
  buildStandardExtensions, stdIdExtension, aidtTimestamp,
  // 성취수준
  computeAchievementLevel,
  // codebook re-export
  codebook,
  // 표준체계 리졸버 re-export
  resolveStandardContext,
};
