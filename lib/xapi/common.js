// lib/xapi/common.js
// ─────────────────────────────────────────────────────────────
// AIDT 기술규격 v2.2 정합 xAPI 공통 유틸 (Phase 1 — URL/코드 표준화).
//   - actor/context 빌더
//   - AIDT 표준 verb/activity-type URL (aidtbook.kr 도메인)
//   - AIDT 표준 object/result extension URL
//   - 코드 매핑 (콘텐츠/평가/문항/게시판/목표/난이도)
//   - 성취수준 환산 (초 A~C, 중·고 A~E)
//   - UUIDv5 (AIDT 학습자 식별)
//   - UUIDv4 (xAPI Statement id, idempotency)
//   - timestamp +00:00 변환 헬퍼
// ─────────────────────────────────────────────────────────────
const { v5: uuidv5, v4: uuidv4 } = require('uuid');
const { resolveStandardContext } = require('./std-resolver');

// ─────────────────────────────────────────────────────────────
// 상수 — 운영 환경변수 (KERIS 등록 후 갱신)
// ─────────────────────────────────────────────────────────────
const PLATFORM_NAME = '다채움';
const PARTNER_ID = process.env.AIDT_PARTNER_ID || 'dacheum';
const HOME_PAGE = process.env.AIDT_HOMEPAGE || 'https://dacheum.kr';
const UUID_NAMESPACE = process.env.AIDT_UUID_NAMESPACE
  || 'b5f6c7d8-9e0a-4b1c-8d2e-3f4a5b6c7d8e'; // 프로젝트 고정 namespace

// timestamp 출력 포맷: 'Z' (xAPI 표준 기본) 또는 'offset' (+00:00 변환)
// KERIS validator 호환 우선 시 AIDT_TIMESTAMP_FORMAT=offset 권장
const TIMESTAMP_FORMAT = process.env.AIDT_TIMESTAMP_FORMAT || 'Z';

// AIDT 프로필 도메인 (KERIS 가이드 v2.2)
const AIDT_DOMAIN = 'http://aidtbook.kr';

// 다채움 고유 extension namespace (AIDT 표준 외 데이터 보존용)
const DACHEUM_EXT_NS = 'https://dacheum.kr/xapi/extension';

// 난이도 "없음" 상수 (AIDT 규약 §1.4)
const DIFFICULTY_NONE = -1;

// ─────────────────────────────────────────────────────────────
// AIDT 표준 EXT URL (부록 A.3 ~ A.5)
// ─────────────────────────────────────────────────────────────
const EXT = {
  // 공통 context extension (부록 A.5)
  partnerId:         `${AIDT_DOMAIN}/xapi/profiles/cmn/1.0/contexts/extensions/partner-id`,

  // 다채움 내부 메타 (AIDT 표준 외이지만 LRS 대시보드에서 사용 — 별도 namespace로 유지)
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

  // ─── AIDT 표준 object extension (부록 A.3) ───
  audioInfo:                 `${AIDT_DOMAIN}/xapi/profiles/media/1.0/objects/extensions/audio-info`,
  videoInfo:                 `${AIDT_DOMAIN}/xapi/profiles/media/1.0/objects/extensions/video-info`,
  assessmentInfo:            `${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/objects/extensions/assessment-info`,
  assignmentInfo:            `${AIDT_DOMAIN}/xapi/profiles/assignment/1.0/objects/extensions/assignment-info`,
  imageInfo:                 `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/objects/extensions/image-info`,
  documentInfo:              `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/objects/extensions/document-info`,
  practiceInfo:              `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/objects/extensions/practice-info`,
  etcContentInfo:            `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/objects/extensions/etc-content-info`,
  keywordInfo:               `${AIDT_DOMAIN}/xapi/profiles/query/1.0/objects/extensions/keyword-info`,
  boardInfo:                 `${AIDT_DOMAIN}/xapi/profiles/social-learning/1.0/objects/extensions/board-info`,
  comprehensionSurveyInfo:   `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/objects/extensions/comprehension-survey-info`,
  emotionSurveyInfo:         `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/objects/extensions/emotion-survey-info`,
  emotionTodaySurveyInfo:    `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/objects/extensions/emotion-today-survey-info`,
  feedbackInfo:              `${AIDT_DOMAIN}/xapi/profiles/teaching/1.0/objects/extensions/feedback-info`,
  classInfo:                 `${AIDT_DOMAIN}/xapi/profiles/teaching/1.0/objects/extensions/class-info`,

  // ─── AIDT 표준 result extension (부록 A.4) ───
  audioDetail:               `${AIDT_DOMAIN}/xapi/profiles/media/1.0/results/extensions/audio-detail`,
  videoDetail:               `${AIDT_DOMAIN}/xapi/profiles/media/1.0/results/extensions/video-detail`,
  assessmentDetail:          `${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/results/extensions/assessment-detail`,
  gavAssignment:             `${AIDT_DOMAIN}/xapi/profiles/assignment/1.0/results/extensions/gav-assignment`,
  finAssignment:             `${AIDT_DOMAIN}/xapi/profiles/assignment/1.0/results/extensions/fin-assignment`,
  objectiveDetail:           `${AIDT_DOMAIN}/xapi/profiles/objective/1.0/results/extensions/objective-detail`,
  searchDetail:              `${AIDT_DOMAIN}/xapi/profiles/query/1.0/results/extensions/search-detail`,
  askDetail:                 `${AIDT_DOMAIN}/xapi/profiles/query/1.0/results/extensions/ask-detail`,
  socialLearningDetail:      `${AIDT_DOMAIN}/xapi/profiles/social-learning/1.0/results/extensions/social-learning-detail`,
  comprehensionSurveyDetail: `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/results/extensions/comprehension-survey-detail`,
  emotionSurveyDetail:       `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/results/extensions/emotion-survey-detail`,
  emotionTodaySurveyDetail:  `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/results/extensions/emotion-today-survey-detail`,
  annotationDetail:          `${AIDT_DOMAIN}/xapi/profiles/annotation/1.0/results/extensions/annotation-detail`,
};

// ─────────────────────────────────────────────────────────────
// AIDT 표준 verb URL (부록 A.1)
// 영역별 1.0 profile URL을 사용 — `${AIDT_DOMAIN}/xapi/profiles/{area}/1.0/verbs/{verb}`
// ─────────────────────────────────────────────────────────────
const VERB = {
  // ① Media
  played:     { id: `${AIDT_DOMAIN}/xapi/profiles/media/1.0/verbs/played`,                display: { 'ko-KR': '재생함',   'en-US': 'played'      }},

  // ② Assessment (AIDT는 submitted 단일. scored/passed/failed 는 호환을 위해 유지하되 같은 표준 URL로 위임)
  submitted:  { id: `${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/verbs/submitted`,        display: { 'ko-KR': '제출함',   'en-US': 'submitted'   }},
  scored:     { id: `${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/verbs/submitted`,        display: { 'ko-KR': '제출함(채점)', 'en-US': 'submitted'}},
  passed:     { id: `${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/verbs/submitted`,        display: { 'ko-KR': '제출함(통과)', 'en-US': 'submitted'}},
  failed:     { id: `${AIDT_DOMAIN}/xapi/profiles/assessment/1.0/verbs/submitted`,        display: { 'ko-KR': '제출함(미통과)', 'en-US': 'submitted'}},

  // ③ Assignment
  gave:       { id: `${AIDT_DOMAIN}/xapi/profiles/assignment/1.0/verbs/gave`,             display: { 'ko-KR': '부여함',   'en-US': 'gave'        }},
  finished:   { id: `${AIDT_DOMAIN}/xapi/profiles/assignment/1.0/verbs/finished`,         display: { 'ko-KR': '완료함',   'en-US': 'finished'    }},

  // ④ Navigation (verb 4종)
  viewed:     { id: `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/verbs/viewed`,           display: { 'ko-KR': '조회함',   'en-US': 'viewed'      }},
  read:       { id: `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/verbs/read`,             display: { 'ko-KR': '읽음',     'en-US': 'read'        }},
  did:        { id: `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/verbs/did`,              display: { 'ko-KR': '수행함',   'en-US': 'did'         }},
  learned:    { id: `${AIDT_DOMAIN}/xapi/profiles/navigation/1.0/verbs/learned`,          display: { 'ko-KR': '학습함',   'en-US': 'learned'     }},

  // ⑤ Objective (AIDT는 set 단일. planned/achieved 는 호환 alias)
  set:        { id: `${AIDT_DOMAIN}/xapi/profiles/objective/1.0/verbs/set`,               display: { 'ko-KR': '설정함',   'en-US': 'set'         }},
  planned:    { id: `${AIDT_DOMAIN}/xapi/profiles/objective/1.0/verbs/set`,               display: { 'ko-KR': '설정함(계획)', 'en-US': 'set'     }},
  achieved:   { id: `${AIDT_DOMAIN}/xapi/profiles/objective/1.0/verbs/set`,               display: { 'ko-KR': '설정함(달성)', 'en-US': 'set'     }},

  // ⑥ Query
  searched:   { id: `${AIDT_DOMAIN}/xapi/profiles/query/1.0/verbs/searched`,              display: { 'ko-KR': '검색함',   'en-US': 'searched'    }},
  asked:      { id: `${AIDT_DOMAIN}/xapi/profiles/query/1.0/verbs/asked`,                 display: { 'ko-KR': '질문함',   'en-US': 'asked'       }},

  // ⑦ Social-Learning (AIDT는 participated 단일. shared/commented/liked 는 호환 alias)
  participated:{ id: `${AIDT_DOMAIN}/xapi/profiles/social-learning/1.0/verbs/participated`, display: { 'ko-KR': '참여함', 'en-US': 'participated'}},
  shared:     { id: `${AIDT_DOMAIN}/xapi/profiles/social-learning/1.0/verbs/participated`, display: { 'ko-KR': '참여함(공유)', 'en-US': 'participated'}},
  commented:  { id: `${AIDT_DOMAIN}/xapi/profiles/social-learning/1.0/verbs/participated`, display: { 'ko-KR': '참여함(댓글)', 'en-US': 'participated'}},
  liked:      { id: `${AIDT_DOMAIN}/xapi/profiles/social-learning/1.0/verbs/participated`, display: { 'ko-KR': '참여함(좋아요)', 'en-US': 'participated'}},

  // ⑧ Survey (AIDT는 submitted 단일. responded 는 호환 alias)
  responded:  { id: `${AIDT_DOMAIN}/xapi/profiles/survey/1.0/verbs/submitted`,            display: { 'ko-KR': '응답함',   'en-US': 'submitted'   }},

  // ⑨ Annotation (AIDT는 made. annotated 는 호환 alias)
  made:       { id: `${AIDT_DOMAIN}/xapi/profiles/annotation/1.0/verbs/made`,             display: { 'ko-KR': '주석함',   'en-US': 'made'        }},
  annotated:  { id: `${AIDT_DOMAIN}/xapi/profiles/annotation/1.0/verbs/made`,             display: { 'ko-KR': '주석함',   'en-US': 'made'        }},

  // ⑩ Teaching
  reorganized:{ id: `${AIDT_DOMAIN}/xapi/profiles/teaching/1.0/verbs/reorganized`,        display: { 'ko-KR': '재편성함', 'en-US': 'reorganized' }},
  // teaching의 gave 도 별도로 사용 가능하나 assignment의 gave와 URL이 다름. 라우터에서 area 별로 override 권장(Phase 2).
};

// ─────────────────────────────────────────────────────────────
// 코드 매핑 — PDF §1.4 표준 코드 체계
// ─────────────────────────────────────────────────────────────

// 콘텐츠 유형 코드 (E/I/A/V/IM/T/P/Z) — PDF query.search-detail.content-type 등
const CONTENT_TYPE_MAP = {
  exam:     'E',    // Evaluation (평가)
  exercise: 'I',    // Interactive item (문항)
  audio:    'A',    // Audio (음원)
  video:    'V',    // Video (영상)
  image:    'IM',   // Image (이미지)
  document: 'T',    // Text (텍스트)
  text:     'T',
  quiz:     'P',    // Practice (실습)
  practice: 'P',
  lesson:   'Z',    // 기타 (혼합)
  other:    'Z',
};

function mapContentType(t) {
  return CONTENT_TYPE_MAP[String(t || '').toLowerCase()] || 'Z';
}

// 평가 유형 코드 (D/F/S/E) — PDF assessment-info.type
const ASSESSMENT_TYPE_MAP = {
  diagnostic:  'D',   // 진단평가
  diagnosis:   'D',   // 진단평가 (별칭)
  formative:   'F',   // 형성평가
  summative:   'S',   // 총괄평가
  self_check:  'E',   // 자기점검 → 기타
  homework:    'E',   // 과제 → 기타
  practice:    'E',   // 연습 → 기타
  other:       'E',
};

function mapAssessmentType(t) {
  return ASSESSMENT_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

// 문항 유형 코드 (M/S/L/E) — PDF items-info.type
const QUESTION_TYPE_MAP = {
  multiple_choice: 'M',   // 객관식
  mcq:             'M',
  short_answer:    'S',   // 단답주관식
  saq:             'S',
  long_answer:     'L',   // 서술주관식
  essay:           'L',
  ess:             'L',
  ox:              'M',   // O/X도 객관식의 한 형태
  tf:              'M',
  ordering:        'E',   // 기타
  ord:             'E',
  matching:        'E',
  mat:             'E',
  fill_blank:      'S',   // 빈칸 채우기는 단답형으로 분류
  fib:             'S',
  other:           'E',
};

function mapQuestionType(t) {
  return QUESTION_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

// 게시판 유형 코드 (C/G/E) — PDF social-learning board-info.type
const BOARD_TYPE_MAP = {
  class:       'C',   // 학급
  class_board: 'C',
  group:       'G',   // 모둠
  group_board: 'G',
  team:        'G',
  free:        'E',   // 자유게시판 → 기타
  free_board:  'E',
  notice:      'E',
  artist:      'E',
  other:       'E',
};

function mapBoardType(t) {
  return BOARD_TYPE_MAP[String(t || '').toLowerCase()] || 'E';
}

// 목표 유형 코드 (S/D/E) — PDF objective-detail.type
const OBJECTIVE_TYPE_MAP = {
  selection:   'S',   // 선택형
  select:      'S',
  description: 'D',   // 서답형
  describe:    'D',
  essay:       'D',
  other:       'E',
  etc:         'E',
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
// timestamp 헬퍼 (AIDT 호환 +00:00 변환 옵션)
// ─────────────────────────────────────────────────────────────
/**
 * ISO 8601 timestamp 출력.
 *   기본: '...Z' (xAPI 표준)
 *   AIDT_TIMESTAMP_FORMAT=offset 일 때: '...+00:00' (KERIS validator 호환)
 */
function aidtTimestamp(date) {
  const d = date instanceof Date ? date : (date ? new Date(date) : new Date());
  const iso = d.toISOString(); // 항상 ms 포함 + 'Z'
  if (TIMESTAMP_FORMAT === 'offset') {
    return iso.replace(/Z$/, '+00:00');
  }
  return iso;
}

// ─────────────────────────────────────────────────────────────
// 성취수준 환산
// ─────────────────────────────────────────────────────────────
/**
 * 정답률·학교급별 성취수준 산출.
 *  초(school_level === '초' 또는 subject 가 *-e) → A~C
 *  중/고                                          → A~E
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
// 다채움 내부 표준체계 메타는 DACHEUM_EXT_NS 로 분리 보관.
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
//   xAPI Statement는 id 필드(UUID v4)를 가져 idempotency 보장.
//   spool.js의 enqueue 진입 시 비어 있으면 자동 부여하지만, 여기서도 부여 가능.
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
// object 빌더 (공통 오브젝트 타입)
//   PDF §1.2 의 `definition.type` URL 경로는 `activity-type/{area}` 임에 주의.
//   (기존 `activities/{type}` 는 잘못된 경로였음 — Phase 1에서 정정)
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
  PLATFORM_NAME, PARTNER_ID, HOME_PAGE, EXT, VERB,
  AIDT_DOMAIN, DACHEUM_EXT_NS, DIFFICULTY_NONE,
  // 매핑
  mapContentType, mapAssessmentType, mapQuestionType,
  mapBoardType, mapObjectiveType,
  CONTENT_TYPE_MAP, ASSESSMENT_TYPE_MAP, QUESTION_TYPE_MAP,
  BOARD_TYPE_MAP, OBJECTIVE_TYPE_MAP,
  // 식별·빌더
  userUuid, newStatementId, makeActor, makeContext, makeStatement, makeActivity,
  buildStandardExtensions, aidtTimestamp,
  // 성취수준
  computeAchievementLevel,
  // 표준체계 리졸버 re-export
  resolveStandardContext,
};
