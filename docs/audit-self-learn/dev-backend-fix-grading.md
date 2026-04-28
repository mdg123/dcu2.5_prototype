# Dev Backend Fix — 정답 판정 형식 정합화 (C-2 / H-1)

- 일시: 2026-04-28
- 담당: Backend (opus)
- 브랜치: `feat/curriculum-std-aidt`
- 근거: `docs/audit-self-learn/student-tester2.md` (C-2 Critical, H-1 High)

## 1. 근본 원인

`content_questions.answer` 컬럼은 **0-based index** 문자열로 저장되어 있다(예: `answer="3"` → `options[3]`이 정답).

전체 2,603 문항 중:

| 분류 | 건수 | 비고 |
|------|-----:|------|
| 0-based index만 유효 | 43 | `answer="0"`이 길이 5 옵션의 0번 가리키는 케이스 |
| 1-based index만 유효 | 37 | 답이 옵션의 1~N에만 들어맞는 케이스 |
| 둘 다 유효 (모호) | 417 | `answer="1"~"4"` |
| 옵션 텍스트와 직접 일치 | 100 | `"서울"`, `"27"` 등 |
| `noOpts` / 깨짐 | 9 | options 누락 |

콘텐츠 플레이어(`public/content/content-player.html`)는 `opts[Number(corA)]` 방식으로 텍스트를 도출 — **사실상 0-based index 규약**이 정설.

그러나 서버 측 정답 판정(`db/self-learn-extended.js`)은 다음과 같이 **단순 문자열 일치**만 수행했다:

```js
// 직전 (버그)
if (String(q.answer).trim() === String(answer || '').trim()) isCorrect = 1;
```

클라이언트가 보내는 `selectedAnswer`는:
- 자기주도학습 직접풀이(line 3378): `idx + 1` 형태의 **1-based 정수**
- 콘텐츠 플레이어 채점(line 3148): `null` (이 경로는 isCorrect 신뢰)
- 진단 페이로드: 옵션 텍스트 또는 1-based 문자열

따라서 `q.answer="3"`(0-based, 정답 = `opts[3]`)인 문항을 학생이 4번째 옵션을 골라 `selectedAnswer="4"` 보내면 — 서버는 `"3" === "4"` → **false 처리**. 이것이 C-2의 본질.

또한 응답의 `correctAnswer` 필드는 인덱스 `"3"`을 그대로 반환해 학생이 `"3"이 정답인데 설명에는 29개 사과"`로 모순 인지 — 단지 0-based index가 텍스트로 노출된 것.

## 2. 수정 내용

### `db/self-learn-extended.js`

**신규 헬퍼 (line 704~785)**

- `_normalizeAnswerText(s)` — `①`/`1)` 등 prefix 제거 + 공백/대소문자 정규화
- `judgeQuestionAnswer(question, submitted)` — 다음 4가지 규약을 모두 정답으로 인정:
  1. q.answer 문자열 직접 일치 (`"서울"==="서울"`)
  2. q.answer가 0-based index일 때, 사용자 1-based 정수도 인정 (`q.answer=3` ↔ user=`"4"`)
  3. q.answer가 가리키는 옵션 텍스트와 사용자 입력 일치 (`opts[3]==="④29"` ↔ user="④29")
  4. options 배열에서 사용자 텍스트 위치를 찾아 q.answer(인덱스)와 비교
- `resolveCorrectAnswerText(question)` — 0-based index를 옵션 텍스트로 변환해 반환 (사용자 노출용)

**적용 사이트 3곳**

| 함수 | 라인 (수정 후) | 변경 |
|------|---------------|------|
| `submitDiagnosisAnswer` | 822 | `String===String` → `judgeQuestionAnswer(q, answer)` |
| `submitDiagnosisAnswerCAT` | 1868 | `String===String` → `judgeQuestionAnswer(q, answer)` |
| `recordProblemAttempt` | 1554, 1561 | `judgeQuestionAnswer` 도입 + `correctAnswer` 응답을 `resolveCorrectAnswerText(q)` 로 텍스트화 |

세 사이트 모두 `SELECT answer` → `SELECT answer, options` 로 컬럼 추가.

**exports (line 2122)**: `judgeQuestionAnswer`, `resolveCorrectAnswerText` 추가 (테스트/외부 사용).

## 3. 단위 테스트 (`scripts/test-grading.js`)

```
[1] judgeQuestionAnswer covers 0-based / 1-based / text   5/5 PASS
[2] answer="3" question (opts=[①24,②25,③27,④29])           4/4 PASS
[3] Text-form answer ("서울")                              2/2 PASS
[4] resolveCorrectAnswerText                              2/2 PASS
[5] recordProblemAttempt E2E
    - 1-based 사용자 입력으로 정답 판정 통과         PASS
    - correctAnswer 응답이 인덱스 아닌 텍스트로 변환  PASS
    - 옵션 텍스트 입력도 정답 인정                  PASS
    - 가짜 isCorrect=true + 잘못된 selectedAnswer
      → 서버가 false로 정정                         PASS
======================================
Result: 17 passed, 0 failed
```

## 4. 영향 / 호환성

- **클라이언트 무변경**. 자기주도학습 직접풀이의 `selectedAnswer: idx + 1` 호출, 진단의 옵션 텍스트 호출, 콘텐츠 플레이어 채점 모두 그대로 동작.
- 서버는 여전히 questionId 우선 재판정(보안). 클라이언트 isCorrect는 questionId 미전송시에만 fallback.
- `correctAnswer` 응답 형식이 인덱스 → **옵션 텍스트**로 변경됨. UI에서 `correctAnswer`를 직접 표시하던 케이스가 있으면 의미가 명확해짐 (회귀 영향은 사실상 양성).
- 콘텐츠 DB 측 데이터 정정은 본 PR 범위 외 (감리 보고서 D-3 / 콘텐츠팀 트랙). 단, 본 수정으로 **0-based 기록을 그대로 유지하면서 1-based / 옵션 텍스트 양쪽 입력**을 모두 받아낼 수 있음.

## 5. 미수행 / 후속 권고

- **D-3 콘텐츠 품질 정합화** — `regenerate-quiz-content.js`가 생성한 1,348개 quiz 문항에서 `explanation`이 옵션 인덱스가 아닌 다른 수(예: 6개 사과 그림인데 explanation에 29개 표기)를 가리키는 케이스가 잔존. 이는 explanation 생성 로직 자체의 정정이 필요 (콘텐츠팀).
- 옵션이 깨진 9건(`noOpts` 5 + 파싱 실패 3 + 일반 텍스트 정답 ≥ 5의 1건)은 본 헬퍼로 일부 흡수되나 콘텐츠 정합 점검 권고.
- `content_questions.answer` 컬럼 자체를 `correct_index INTEGER` + `correct_text TEXT` 두 컬럼으로 분리하는 마이그레이션이 장기적 해결책 (별도 작업).

## 6. Sync

- 워크트리 → 메인 폴더 직접 cp 완료:
  - `db/self-learn-extended.js`

---
*본 보고서는 C-2/H-1 정답 판정 무시 버그의 근본원인 분석·수정·검증 근거를 기록합니다.*
