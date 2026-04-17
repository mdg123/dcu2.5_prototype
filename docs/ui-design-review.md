# 채움CBT UI/UX 디자인 평가 보고서

> 평가일: 2026-04-16  
> 평가자: K-12 교육 플랫폼 전문 시니어 UI/UX 디자이너  
> 대상: 다채움 플랫폼 "채움CBT" 시스템 (public/cbt/)  
> 평가 방법: 학생(student1) 및 교사(teacher1) 계정으로 실제 로그인 후 각 페이지를 프리뷰 서버에서 직접 방문, 데스크탑/태블릿/모바일 뷰포트에서 스크린샷 및 DOM 인스펙션, 소스코드 정밀 분석

---

## 1. 총평

### 전체 완성도: B+ (양호)

채움CBT는 K-12 교육 환경에 적합한 컴퓨터 기반 평가 시스템으로, 전반적인 UI 품질이 양호한 수준이다. CSS custom properties 기반의 디자인 토큰 체계가 일관되게 적용되어 있고, 카드형 레이아웃과 색상 코딩이 교육 맥락에 적합하다.

**강점:**
- 일관된 디자인 토큰(CSS custom properties) 활용으로 색상/간격/라운딩이 통일됨
- 카드형 UI와 리스트 뷰 전환 기능 제공
- 응시 완료 카드에 시각적 구분(녹색 그라디언트 배경 + 테두리)이 명확함
- 리뷰 모드에서 정답/오답/무응답을 색상 코딩(초록/빨강/노랑)으로 직관적으로 표현
- 감독관 대시보드의 실시간 포커스 표시등(pulse 애니메이션)이 효과적
- KaTeX 수식 렌더링 지원으로 수학 평가에 적합
- 대기실(waiting room) UI가 학생 친화적이고 안내 정보가 충분

**약점:**
- 모바일 반응형이 player.html에서 완전히 깨짐 (sidebar + question area 겹침)
- index.html 모바일 뷰에서 stat-card 4개가 세로로 과도한 공간을 차지
- 인라인 스타일 남용 (유지보수 어려움, 일관성 저해)
- 교사 카드에서 액션 버튼이 5개까지 밀집되어 클릭 영역이 좁음
- meta-tag의 font-size가 11px로 초등학생 가독성에 부적합

---

## 2. 페이지별 상세 평가

### 2.1 CBT 목록 (index.html)

**현재 상태:** 교사/학생 역할에 따라 동적으로 UI가 변환되며, 카드/리스트 뷰 전환, 필터, 검색, 응시완료 구분이 모두 동작함. 교사 뷰에서 "평가 만들기", "PDF 평가 만들기" 버튼이 표시되고, 학생 뷰에서는 숨겨짐.

**강점:**
- 카드/리스트 뷰 토글이 자연스러움 (segmented control 패턴)
- 응시완료 카드에 `background: linear-gradient(135deg, #ecfdf5, #d1fae5)` + `border: 1.5px solid #6ee7b7` 적용으로 시각적 구분 명확
- 필터 버튼(전체/임시저장/진행 중/완료)의 pill 형태 디자인이 깔끔
- 검색 입력필드에 돋보기 아이콘이 적절히 배치됨
- stat-card 4종의 색상 구분(blue/green/orange/red)이 의미론적으로 적절

**개선 필요사항:**

1. **[Critical] 모바일 반응형 stat-card 레이아웃 붕괴**
   - 현상: 375px 뷰포트에서 stat-card 4개가 `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`로 인해 세로 1열로 펼쳐져 화면의 절반 이상을 차지함
   - 개선안: 모바일에서 `grid-template-columns: repeat(2, 1fr)` 또는 `repeat(4, 1fr)` 소형 카드로 변경. 카드 padding을 `12px`로 줄이고, stat-value를 `18px`, stat-icon을 `36px`로 축소
   ```css
   @media (max-width: 640px) {
     .stats-row { grid-template-columns: repeat(2, 1fr); gap: 8px; }
     .stat-card { padding: 12px; gap: 10px; }
     .stat-icon { width: 36px; height: 36px; font-size: 16px; }
     .stat-value { font-size: 18px; }
   }
   ```

2. **[Major] 교사 카드 액션 버튼 밀집 문제**
   - 현상: 교사 뷰에서 한 카드에 "감독", "결과(차트)", "편집", "삭제" 총 4개 버튼이 exam-footer에 나열됨. 데스크탑에서도 `gap: 6px`로 밀집되어 있고, 모바일에서는 overflow 가능성 있음
   - 개선안: "결과", "편집", "삭제"를 더보기 드롭다운 메뉴(`...` 아이콘)로 통합하고, "감독" 버튼만 카드에 직접 노출
   ```css
   .exam-actions .btn-sm { padding: 6px 10px; } /* 최소 터치 영역 확보 */
   ```

3. **[Major] meta-tag 폰트 크기 (11px) - 초등학생 가독성 부족**
   - 현상: `.meta-tag { font-size: 11px; }` 는 초등 3~6학년 학생에게 너무 작음. 실제 렌더링 시 17.6px line-height로 태그 높이가 불과 17.6px
   - 개선안: `font-size: 12px`, `padding: 5px 10px`, `border-radius: 8px`로 변경하여 가독성 및 터치 타겟 확대

4. **[Major] 한 카드에 태그가 과다하게 중복 표시**
   - 현상: 하나의 카드에 "진행 중"(상태) + "평가"(유형) + "20분"(시간) + "1명 응시"(참여) + "응시완료"(내 상태) + "응시완료" 태그까지 최대 5~6개 태그가 나열되어 정보 과부하
   - 개선안: 카드 상단에는 상태 배지만 표시하고, 유형/시간/참여수는 하단 footer에 텍스트로 배치. "응시완료"는 카드 좌상단 리본 또는 오버레이 배지로 처리

5. **[Minor] exam-card의 hover 효과가 비응시자에게도 동일**
   - 현상: 모든 카드에 `cursor: pointer` + `transform: translateY(-2px)` hover 효과가 적용되지만, 교사가 출제한 카드 클릭 시 감독 대시보드로 이동하는 것이 직관적이지 않음
   - 개선안: 교사 출제 카드의 hover 효과를 별도 스타일로 분리하고, "감독 대시보드로 이동" 툴팁 추가

6. **[Minor] 검색 입력필드의 border-radius 불일치**
   - 현상: 검색 input은 `border-radius: 10px`, filter-btn은 `border-radius: 20px`, view-toggle은 `border-radius: 8px`로 세 곳이 각각 다름
   - 개선안: `border-radius: 8px` 또는 `10px`로 통일

7. **[Enhancement] 빈 상태(empty state) 개선**
   - 현상: "등록된 평가가 없습니다" 텍스트만 표시
   - 개선안: 학생에게는 "아직 선생님이 평가를 등록하지 않았어요" + 일러스트 추가, 교사에게는 "첫 번째 평가를 만들어보세요" CTA 버튼 포함

---

### 2.2 시험 플레이어 (player.html)

**현재 상태:** 좌측 사이드바(문항 번호 네비게이션) + 중앙 문항 영역 + 상단 헤더(타이머/진행률/제출) 3분할 레이아웃. 리뷰 모드에서 정답/오답 시각적 표시와 해설 영역이 제공됨. 대기실(waiting room)과 강제 제출 카운트다운 오버레이도 구현됨.

**강점:**
- 타이머 색상 단계화 (`safe: green > warn: amber > danger: red`)가 직관적
- 리뷰 모드에서 사이드바 상단에 점수 요약이 표시되어 한눈에 파악 가능
- 문항 네비게이션(q-nav-item) 40x40px 크기에 답변/미답변 상태가 색상으로 구분됨
- 대기실 UI에 시험 규칙이 아이콘과 함께 안내되어 학생 친화적
- 탭 이탈 경고 알림바(alert-bar)의 `transform: translateY` 슬라이드 애니메이션이 자연스러움
- KaTeX 수식 렌더링이 자동 적용되어 수학 문항에 적합

**개선 필요사항:**

1. **[Critical] 모바일 반응형 완전 붕괴**
   - 현상: 375px 뷰포트에서 sidebar(width: 240px)와 question-area가 `display: flex`로 수평 배치되어 콘텐츠가 겹치고 잘림. `body { overflow: hidden }` 설정으로 스크롤도 불가
   - 개선안:
   ```css
   @media (max-width: 768px) {
     .exam-container { flex-direction: column; overflow-y: auto; }
     .sidebar { 
       width: 100%; height: auto; flex-shrink: 0;
       border-right: none; border-bottom: 1px solid var(--gray-200);
     }
     .q-nav { display: flex; flex-wrap: wrap; justify-content: center; padding: 8px; }
     .q-nav-item { width: 32px; height: 32px; font-size: 11px; margin: 2px; }
     .sidebar-header, .sidebar-footer { padding: 8px 12px; }
     .question-area { padding: 20px 16px; }
     body { overflow: auto; }
   }
   ```

2. **[Critical] 리뷰 모드에서 "저장"/"제출" 버튼이 그대로 노출**
   - 현상: header-right에 "저장"과 "제출" 버튼이 리뷰 모드 진입 시 JS로 제거되지만, 초기 렌더링 시 약 0.5초간 노출됨. 학생이 클릭할 수 있는 시간 존재
   - 개선안: HTML에서 리뷰 모드일 때 `style="display:none"` 초기 설정, 또는 CSS class로 `.review-mode .header-right .btn-primary { display: none; }` 처리

3. **[Major] option-item 클릭 영역과 접근성**
   - 현상: `option-item`에 `cursor: pointer`와 onclick이 있지만 `role="button"` 또는 `role="radio"` 없음. 스크린리더에서 선택지가 일반 div로 인식됨
   - 개선안: `<div role="radio" aria-checked="true/false" tabindex="0">`으로 변경하고, 키보드 Enter/Space로 선택 가능하게 이벤트 추가

4. **[Major] 리뷰 모드 선택지에서 "선택되지 않은 보기"의 opacity가 0.5**
   - 현상: `.option-item.review-neutral { opacity: 0.5; }` 적용으로 정답/내 답이 아닌 보기가 50% 투명. 정보 가시성이 저하되어 학생이 다른 선택지 내용을 확인하기 어려움
   - 개선안: `opacity: 0.7` 이상으로 변경하거나, 정답/오답 보기만 강조하고 나머지는 `opacity: 1`에 `color: var(--gray-400)` 처리

5. **[Major] 문항 텍스트(q-text) 크기가 17px로 초등학생에게 적절하나, line-height가 1.6으로 부족할 수 있음**
   - 현상: 복잡한 수학 문제에서 줄 간격이 좁아 가독성 저하
   - 개선안: `line-height: 1.8` 또는 `line-height: 1.75`, `letter-spacing: -0.01em` 추가

6. **[Minor] 문항 네비게이션(q-nav-item) 간 간격이 4px로 밀집**
   - 현상: `margin: 4px`로 20문항 이상 시 좁게 보일 수 있음
   - 개선안: `margin: 4px` 유지하되 `gap: 6px`의 grid 레이아웃 적용

7. **[Minor] 제출 완료 화면(submit-result)에서 돌아가기 버튼이 하나뿐**
   - 현상: 점수 표시 후 "돌아가기" 버튼만 있고, "결과 상세 보기" 옵션이 없음
   - 개선안: "결과 보기" 버튼 추가하여 리뷰 모드로 바로 이동 가능하게 처리

8. **[Enhancement] 타이머에 "남은 시간" 텍스트 라벨 없음**
   - 현상: "29:45" 숫자만 표시되어 저학년 학생이 의미를 즉시 파악하기 어려울 수 있음
   - 개선안: "남은 시간 29:45" 또는 타이머 아래 "분 : 초" 라벨 추가

---

### 2.3 PDF 플레이어 (pdf-player.html)

**현재 상태:** 좌측 65% PDF 뷰어 + 우측 35% OMR 답안지 2분할 레이아웃. PDF.js 기반 렌더링, 페이지 이동/확대축소/화면맞춤 도구바, 원형 OMR 버튼(1~5) 제공. 리뷰 모드에서 정답/오답 색상 표시.

**강점:**
- PDF + OMR 분할 레이아웃이 지면 시험의 디지털 전환에 적합
- OMR 버튼이 원형(36x36px)으로 실제 OMR 카드를 연상
- 줌 컨트롤(확대/축소/화면맞춤)이 도구바에 직관적으로 배치
- 리뷰 모드의 정답/오답 색상 코딩이 OMR 전체 행에 적용되어 한눈에 파악 가능
- OMR 하단 진행바(progress-bar)와 "미응답 있음" 경고 표시가 효과적

**개선 필요사항:**

1. **[Critical] 모바일에서 PDF 영역과 OMR 영역이 50vh:50vh로 분할**
   - 현상: `@media (max-width: 768px)`에서 `height: 50vh`로 고정 분할되지만, PDF를 읽기에 50vh는 극히 부족하며 OMR도 스크롤이 과도
   - 개선안: 모바일에서는 탭 전환 방식으로 변경 (PDF 탭 / OMR 탭)하거나, PDF를 70vh + OMR을 하단 시트(bottom sheet)로 올리는 방식 적용
   ```css
   @media (max-width: 768px) {
     .exam-body { flex-direction: column; overflow-y: auto; height: auto; }
     .pdf-area { flex: none; height: 65vh; min-height: 400px; }
     .omr-area { flex: none; min-height: 300px; }
   }
   ```

2. **[Major] PDF 플레이스홀더가 A4 크기(595x842px) 고정**
   - 현상: `.pdf-placeholder { width: 595px; height: 842px; }` 고정값으로 모바일에서 overflow 발생
   - 개선안: `width: 100%; max-width: 595px; aspect-ratio: 595/842;` 또는 `width: min(595px, 100%)` 적용

3. **[Major] OMR 버튼 토글 방식이 비직관적**
   - 현상: 같은 번호를 다시 누르면 선택 취소됨 (토글). 초등학생이 실수로 선택 해제할 가능성이 높음
   - 개선안: 취소 시 확인 토스트("정말 선택을 취소할까요?") 표시하거나, 별도 "지우기" 버튼을 행 끝에 배치

4. **[Minor] PDF 도구바의 "맞춤" 버튼이 한글 텍스트**
   - 현상: 다른 버튼은 아이콘만 사용하는데 "맞춤" 버튼만 `font-size: 11px; width: 44px;`로 텍스트 사용 -> 시각적 불일치
   - 개선안: `<i class="fas fa-expand"></i>` 아이콘으로 통일하고, title 속성으로 "화면 맞춤" 툴팁

5. **[Minor] OMR 영역에 문항 번호와 보기 사이 구분선 없음**
   - 현상: 10문항 이상에서 행 간 구분이 `.omr-question { margin-bottom: 4px; }` 만으로 이루어져 시각적으로 밀집
   - 개선안: 5문항 단위로 구분선(divider) 추가, 또는 `margin-bottom: 8px` + 홀짝 행 배경색 차별화

6. **[Enhancement] PDF 로드 실패 시 사용자 친화적 안내 부족**
   - 현상: `document.getElementById('pdfFilename').textContent = 'PDF를 불러올 수 없습니다.'` 텍스트만 표시
   - 개선안: 재시도 버튼 + "인터넷 연결을 확인해주세요" 안내 추가

---

### 2.4 감독관 대시보드 (supervisor.html)

**현재 상태:** 교사가 실시간으로 학생 응시 상태를 모니터링하는 대시보드. 타이머 진행바, 통계 카드 4종, 학생 테이블(이름/상태/포커스/이탈횟수/답안진행/점수/제출시간), 알림 패널(사이드바), 실시간 이탈 토스트 알림 제공.

**강점:**
- 실시간 포커스 표시등(pulse 애니메이션: focused=green, away=red, idle=gray)이 매우 직관적
- 이탈 3회 이상 학생 행에 `row-alert { background: #fff5f5 }` 강조가 효과적
- 타이머 진행바가 남은 시간에 따라 색상 변화 (파랑->노랑->빨강)
- LIVE 배지의 빨간 깜빡임 애니메이션이 실시간 감독 분위기 연출
- CSV 내보내기 기능 구현
- Socket.IO 미연결 시 mock 데이터 폴백으로 UI가 항상 동작

**개선 필요사항:**

1. **[Major] 학생 테이블 반응형 처리 미흡**
   - 현상: `@media (max-width: 768px)`에서 6번째 컬럼(답안 진행)만 숨김 처리. 8열 테이블이 태블릿에서도 좁아짐
   - 개선안: 태블릿 이하에서 카드형 레이아웃으로 전환하거나, "포커스"와 "이탈 횟수"를 하나의 열로 합치기
   ```css
   @media (max-width: 768px) {
     .student-table th:nth-child(4), .student-table td:nth-child(4),
     .student-table th:nth-child(6), .student-table td:nth-child(6),
     .student-table th:nth-child(8), .student-table td:nth-child(8) { display: none; }
   }
   ```

2. **[Major] 시험 시작/종료 버튼의 위치가 헤더 우측에 밀집**
   - 현상: "알림", "결과 보기", "시험 시작"/"시험 종료" 버튼이 한 줄에 나열되어 "시험 종료"(빨간색 위험 버튼)를 실수로 클릭할 위험
   - 개선안: "시험 종료" 버튼을 다른 버튼들과 8px 이상 간격 두기 + 구분선 추가, 또는 "시험 종료"만 페이지 하단에 별도 배치

3. **[Major] 알림 패널(alert-panel) 닫기 버튼이 `&times;` 텍스트만 사용**
   - 현상: `.alert-close { font-size: 18px; }` 텍스트 x 문자. 클릭 영역이 좁고, 접근성 부족
   - 개선안: `<button aria-label="닫기">` + `<i class="fas fa-times"></i>` 아이콘 사용 + `padding: 8px; min-width: 32px; min-height: 32px;` 터치 영역 확보

4. **[Minor] "접속 인원" 통계 카드의 서브텍스트가 "전체 N명"으로 중복감**
   - 현상: stat-value에 "1", stat-label에 "접속 인원", stat-change에 "전체 1명" 표시 -> 같은 정보 반복
   - 개선안: stat-change를 "전체 학급 25명" 등 전체 학급 인원 대비 비율로 변경

5. **[Minor] 학생 이름 컬럼에 프로필 아바타/이니셜 없음**
   - 현상: 텍스트만 표시되어 20명 이상 학급에서 시각적 구분이 어려움
   - 개선안: 이름 앞에 이니셜 원형 아바타(첫 글자) 추가

6. **[Enhancement] 학생별 답안 진행 시각화 개선**
   - 현상: "4/10" 텍스트만 표시
   - 개선안: 소형 프로그레스 바 추가 (높이 4px, 너비 60px)

---

### 2.5 결과 분석 (result.html)

**현재 상태:** 요약 통계 5종 + 성취수준 분포(S/A/B/C 4단계) + 문항별 정답률 수평 막대차트 + 학생별 결과 테이블로 구성. CSV 내보내기, 인쇄, 정렬, 필터 기능 포함.

**강점:**
- 성취수준 분포(S/A/B/C)가 색상 카드 + 비율 프로그레스바로 직관적 표현
- 문항별 정답률 차트의 색상 단계화(80%+: green, 60-80%: blue, 40-60%: amber, 40%-: red)가 한눈에 파악 가능
- 순위 배지(1/2/3위)가 원형 아이콘으로 시각적 강조
- 인쇄 스타일(@media print)이 별도 정의되어 출력 대응
- 정렬(점수/이탈횟수) 기능이 테이블 헤더 클릭으로 작동
- 상세 결과 API + 기본 API 이중 폴백 구현

**개선 필요사항:**

1. **[Major] 요약 통계 5열이 모바일에서 2열로 변환 시 마지막 카드가 단독 행**
   - 현상: `grid-template-columns: repeat(5, 1fr)` -> `@media (max-width: 768px) { repeat(2, 1fr) }` 변환 시 5번째 카드가 한 줄 독립 차지
   - 개선안: 모바일에서 `grid-template-columns: repeat(3, 1fr)` + 작은 카드 스타일 적용, 또는 스크롤 가능한 수평 행으로 변경
   ```css
   @media (max-width: 640px) {
     .summary-row { 
       display: flex; overflow-x: auto; gap: 10px; padding-bottom: 8px;
       scroll-snap-type: x mandatory;
     }
     .stat-card { min-width: 120px; flex-shrink: 0; scroll-snap-align: start; }
   }
   ```

2. **[Major] 문항별 정답률 차트에 문항 내용(q.text) 미표시**
   - 현상: "1번", "2번" 번호만 표시되고 문항 내용은 `title` 속성(hover 시)에만 있음. 교사가 어떤 문항인지 파악하려면 hover 필요
   - 개선안: 막대 아래에 문항 텍스트 요약(말줄임 20자)을 추가하거나, 클릭 시 문항 내용 팝오버 표시

3. **[Major] "최고점" 카드에 highlight 스타일(파란 배경)이 적용되어 "가장 좋은 것"으로 오해 유발**
   - 현상: `.stat-card.highlight { background: var(--primary); color: #fff; }` 가 "최고점" 카드에 적용. 최고점이 45점이어도 파란 강조 표시
   - 개선안: highlight를 "평균 점수" 카드에 적용하거나, 최고점 값에 따라 조건부 강조 적용

4. **[Minor] 성취수준 분포 카드의 "0명" 표시가 시각적으로 무의미**
   - 현상: 응시자가 1명인데 S(0명)/A(0명)/B(0명)/C(1명) 4칸 모두 표시
   - 개선안: 0명인 카드는 `opacity: 0.5` 처리하거나, 0명 카드의 프로그레스 바를 최소 2% 너비로 표시

5. **[Minor] 학생 결과 테이블의 이탈 횟수 배지 색상이 2단계만 구분**
   - 현상: 0회=gray, 1-2회=yellow, 3회+=red
   - 개선안: 현재 구분이 적절하나, 이탈 시간(total_leave_time) 정보도 함께 표시하면 더 유의미

6. **[Enhancement] 차트 영역에 도넛/파이 차트 추가 검토**
   - 현상: 수평 막대 차트만 사용
   - 개선안: 성취수준 분포에 도넛 차트를 추가하여 비율을 시각적으로 표현 (Chart.js 등 활용)

---

## 3. 공통 개선사항

### 3.1 인라인 스타일 과다 사용
- **현상:** 모든 페이지에서 `style="..."` 인라인 스타일이 대량으로 사용됨. 예: `style="display:flex;gap:12px;"`, `style="font-size:13px;font-weight:700;color:var(--gray-700);margin-bottom:12px;"`
- **영향:** 유지보수 난이도 증가, 일관성 저하, 스타일 오버라이드 어려움
- **개선안:** 반복 패턴을 유틸리티 CSS 클래스로 추출 (예: `.flex-center`, `.text-sm-bold`, `.section-title-block`)

### 3.2 CSS 변수 중복 선언
- **현상:** 각 HTML 파일마다 `:root` CSS 변수를 독립적으로 선언. 변수값은 동일하나 파일별 중복
- **개선안:** `cbt-common.css` 공통 스타일시트를 분리하여 변수, 버튼, 카드 등 공통 컴포넌트 통합

### 3.3 접근성(A11y) 전반적 부족
- **현상:**
  - `role`, `aria-label`, `aria-pressed` 등 ARIA 속성이 거의 없음
  - 모달 오버레이에 `aria-modal="true"`, `role="dialog"` 미적용
  - 포커스 트랩(focus trap)이 모달에 미구현 -> Tab키로 모달 밖 요소 접근 가능
  - 색상만으로 상태 구분 (색맹 사용자 고려 부족)
- **개선안:**
  - 필터 버튼에 `role="radio"` + `aria-checked` 추가
  - 모달에 `role="dialog"` + `aria-modal="true"` + 포커스 트랩 추가
  - 상태 배지에 아이콘(체크/x/시계) 병행 표시

### 3.4 Toast 알림의 접근성 및 위치
- **현상:** `.toast`가 `position: fixed; bottom: 24px; left: 50%`로 화면 하단 중앙에 표시. `role="alert"` 또는 `aria-live="polite"` 미적용
- **개선안:** `role="status"` + `aria-live="polite"` 추가, 토스트 표시 시간을 3.5초로 연장 (현재 2.5초)

### 3.5 폰트 로드 실패 대응
- **현상:** `font-family: 'Pretendard', 'Noto Sans KR', system-ui, sans-serif`로 선언하지만, 실제 font-face 정의나 CDN 링크 없음. 시스템 폰트로 폴백될 가능성
- **개선안:** Pretendard CDN 링크를 `<head>`에 추가하거나, 사용하지 않는 폰트명 제거

### 3.6 교육 맥락 - K-12 초등 3~6학년 적합성
- **현상:**
  - 전반적 폰트 크기가 성인 대상(13~15px)으로 설정되어 초등학생에게 다소 작을 수 있음
  - "임시저장", "OMR", "이탈 감지" 등 전문 용어 사용
  - 확인(confirm) 다이얼로그가 브라우저 기본 `window.confirm()` 사용 -> 디자인 불일치
- **개선안:**
  - 학생 뷰 폰트 크기를 기본 15px, 문항 텍스트 18px으로 상향
  - 학생 대상 UI에서 용어를 쉬운 말로 변경: "임시저장" -> "나중에 하기", "제출" -> "답 보내기"
  - 커스텀 확인 모달 구현

---

## 4. 우선순위별 개선 목록

### Critical (즉시 수정)

| # | 페이지 | 항목 | 설명 |
|---|--------|------|------|
| C1 | player.html | 모바일 반응형 붕괴 | sidebar + question-area 겹침. `@media (max-width: 768px)` 추가 필요 |
| C2 | index.html | 모바일 stat-card 과점유 | `grid-template-columns` 모바일 분기 추가 |
| C3 | player.html | 리뷰 모드 초기 렌더링 시 제출 버튼 노출 | CSS 기반 초기 숨김 처리 |
| C4 | pdf-player.html | 모바일 PDF 영역 50vh 고정 | 탭 전환 또는 가변 높이 적용 |

### Major (높은 우선순위)

| # | 페이지 | 항목 | 설명 |
|---|--------|------|------|
| M1 | index.html | 교사 카드 액션 버튼 5개 밀집 | 더보기 메뉴 패턴 적용 |
| M2 | index.html | meta-tag 11px 폰트 크기 | 12px + padding 확대 |
| M3 | index.html | 카드당 태그 과다(5~6개) | 정보 계층 재구성 |
| M4 | player.html | option-item ARIA 속성 부재 | `role="radio"` 추가 |
| M5 | player.html | 리뷰 모드 review-neutral opacity 0.5 | 0.7 이상으로 상향 |
| M6 | pdf-player.html | PDF placeholder 595px 고정 | responsive width 적용 |
| M7 | pdf-player.html | OMR 토글 취소 비직관적 | 취소 확인 또는 별도 지우기 버튼 |
| M8 | supervisor.html | 학생 테이블 반응형 미흡 | 추가 컬럼 숨김 처리 |
| M9 | supervisor.html | 시험 종료 버튼 실수 클릭 위험 | 간격 + 구분선 추가 |
| M10 | result.html | 요약 통계 5열 모바일 레이아웃 | 수평 스크롤 또는 3열 적용 |
| M11 | result.html | 정답률 차트에 문항 내용 미표시 | 문항 텍스트 요약 추가 |
| M12 | 공통 | 접근성 ARIA 속성 전반 부족 | role, aria-label 체계적 적용 |

### Minor (낮은 우선순위)

| # | 페이지 | 항목 | 설명 |
|---|--------|------|------|
| m1 | index.html | border-radius 불일치 (10px/20px/8px) | 8px 또는 10px로 통일 |
| m2 | index.html | hover 효과 역할별 미분화 | 교사/학생 hover 분리 |
| m3 | player.html | q-nav-item 간격 4px 밀집 | grid + gap: 6px 적용 |
| m4 | player.html | 제출 완료 후 "결과 보기" 버튼 없음 | 리뷰 모드 이동 버튼 추가 |
| m5 | pdf-player.html | "맞춤" 버튼 텍스트/아이콘 불일치 | expand 아이콘으로 통일 |
| m6 | pdf-player.html | OMR 행 간 구분 약함 | 5문항 단위 구분선 추가 |
| m7 | supervisor.html | 접속 인원 서브텍스트 중복 | 전체 학급 인원 대비 비율 표시 |
| m8 | supervisor.html | 알림 패널 닫기 버튼 클릭 영역 | min-width/min-height 32px 확보 |
| m9 | result.html | 0명 성취수준 카드 무의미 표시 | opacity 0.5 처리 |
| m10 | result.html | 최고점 카드 highlight 오해 소지 | 조건부 강조 또는 대상 변경 |

### Enhancement (추후 고려)

| # | 페이지 | 항목 | 설명 |
|---|--------|------|------|
| E1 | index.html | 빈 상태 일러스트 + CTA | 역할별 안내 텍스트 차별화 |
| E2 | player.html | 타이머 "남은 시간" 라벨 추가 | 저학년 이해도 향상 |
| E3 | pdf-player.html | PDF 로드 실패 시 재시도 버튼 | 사용자 친화적 에러 처리 |
| E4 | supervisor.html | 답안 진행 미니 프로그레스 바 | 시각적 진행도 표현 |
| E5 | supervisor.html | 학생 이니셜 아바타 추가 | 시각적 구분 향상 |
| E6 | result.html | 성취수준 도넛 차트 추가 | 데이터 시각화 강화 |
| E7 | 공통 | CSS 공통 파일 분리(cbt-common.css) | 유지보수성 향상 |
| E8 | 공통 | 커스텀 confirm 모달 구현 | 브라우저 기본 대화상자 대체 |
| E9 | 공통 | 학생용 쉬운 용어 전환 | "제출" -> "답 보내기" 등 |
| E10 | 공통 | Pretendard 폰트 CDN 링크 추가 | 일관된 타이포그래피 보장 |

---

## 부록: 페이지별 파일 경로 및 의존성

| 페이지 | 경로 | 외부 의존성 |
|--------|------|-------------|
| CBT 목록 | `public/cbt/index.html` | Font Awesome 6.4, common-nav.css, auth.js |
| 시험 플레이어 | `public/cbt/player.html` | Font Awesome 6.4, KaTeX 0.16.9, Socket.IO, auth.js |
| PDF 플레이어 | `public/cbt/pdf-player.html` | Font Awesome 6.4, PDF.js 3.11.174, Socket.IO, auth.js |
| 감독관 대시보드 | `public/cbt/supervisor.html` | Font Awesome 6.4, common-nav.css, Socket.IO, auth.js |
| 결과 분석 | `public/cbt/result.html` | Font Awesome 6.4, common-nav.css, auth.js |
| JS 디렉토리 | `public/cbt/js/` | (추가 JS 파일 확인 필요) |
