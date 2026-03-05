# SFR-010: 공통 UI/UX 표준화 및 미디어 처리 통일

## 기본정보

| 항목 | 내용 |
|------|------|
| **대상파일** | 전체 프로토타입 (02~06 모든 폴더) |
| **현재상태** | 개별 에디터(Quill), 분산된 미디어 표시 |
| **수정유형** | 전체 표준화 (에디터, 미디어, 폰트 통일) |
| **우선순위** | 높음 |
| **예상작업시간** | 12-16시간 |

---

## 기존 구현 현황

### 현재 보유 기능
- **Quill Editor**: 과제(homework-prototype) 에디터
- **기본 텍스트 입력**: `<textarea>`, `<input>` 등 분산
- **이미지 표시**: `<img>` 태그 (고정폭 또는 반응형 미지정)
- **동영상**: 없음 또는 `<iframe>` 직접 임베딩
- **문서/PDF**: 없음 또는 외부 링크만

### 디자인 톤
- 폰트: Pretendard (주), Noto Sans KR (보조)
- 최소 폰트: 12px (모바일)
- 색상: 기존 색상체계 유지

---

## 추가/보완 항목

### 1. 반응형 미디어 디스플레이 통일 (필수)
**기존**: 이미지 크기 미지정, 동영상 비율 고정, 문서 미지원
**추가 필요**:

#### 이미지 자동스케일링
```css
/* 전체 프로토타입 공통 스타일 추가 */
.media-image {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

/* 이미지 크기별 표시 */
.image-small {
  max-width: 300px; /* 썸네일 */
}
.image-medium {
  max-width: 600px; /* 본문 이미지 */
}
.image-large {
  max-width: 100%; /* 전체폭 이미지 */
}
```
- 모든 이미지: `max-width: 100%` + `height: auto` 적용
- 모바일 모드에서 자동 스케일다운 (최대 가로 100%)
- 이미지 로딩: 지연로딩 (lazy-loading) 적용
- 이미지 팝업: 클릭 시 모달 확대보기 (Lightbox 라이브러리)

#### 동영상 임베딩
```html
<!-- YouTube/Vimeo 반응형 임베딩 (16:9 비율) -->
<div class="media-video-container">
  <iframe src="..." title="..." allow="..." width="560" height="315"></iframe>
</div>

<style>
.media-video-container {
  position: relative;
  width: 100%;
  max-width: 600px;
  padding-bottom: 56.25%; /* 16:9 비율 */
  height: 0;
  overflow: hidden;
  border-radius: 8px;
}
.media-video-container iframe {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: none;
}
</style>
```
- YouTube/Vimeo: 16:9 반응형 임베딩
- 로컬 동영상: `<video>` 태그 + controls + 반응형 스타일
- 동영상 썸네일: 재생 아이콘(▶) 오버레이

#### 문서/PDF 표시
- PDF 뷰어: PDF.js 라이브러리 활용 (CDN)
- 인라인 표시: 문서 첫 페이지 미리보기 + "전체보기" 버튼
- 문서 아이콘: 파일 타입별 아이콘 (📄 DOC, 📊 XLS, 📑 PDF 등)

### 2. WYSIWYG 에디터 통일 (필수)
**기존**: Quill만 사용, 다른 곳에는 `<textarea>`
**추가 필요**:
- **모든 콘텐츠 작성 영역에 Quill Editor 적용**:
  - 과제: 기존 (유지)
  - 알림장: 텍스트 입력 → Quill로 변경
  - 관찰기록: 자유텍스트 → Quill로 변경
  - 댓글/피드백: 텍스트 입력 → Quill로 변경
  - 공지사항/게시글: Quill로 변경
- **Quill 공통 설정**:
  ```javascript
  const quillOptions = {
    theme: 'snow',
    modules: {
      toolbar: [
        ['bold', 'italic', 'underline'],
        [{ 'color': [] }, { 'background': [] }],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        ['link', 'image'],
        ['clean']
      ]
    },
    placeholder: '내용을 입력하세요...'
  };
  ```
- **이미지 업로드**: Quill 내 이미지 추가 → Base64 또는 서버 업로드
- **에디터 높이**: 기본 200px, 필요시 조정 가능 (min-height: 150px)
- **에디터 스타일**: 배경 흰색, 테두리 #e5e7eb, 포커스 시 #2563eb

### 3. 인라인 뷰어 (필수)
**기존**: 팝업 모달로 콘텐츠 열기 또는 새탭 이동
**추가 필요**:
- **팝업 없이 인라인 콘텐츠 확인** (대부분의 경우):
  - 학습 콘텐츠: 같은 페이지에서 우측 패널 또는 하단 확장
  - 첨부파일: 클릭 시 페이지 내 뷰어로 표시
  - 이미지: Lightbox 팝업 (모달 아님, 반투명 배경)
- **필요한 경우만 팝업**:
  - 큰 파일 (100MB 이상): "새탭에서 열기" 유도
  - 외부 링크: "새탭에서 열기" 자동 처리

#### 자주 사용되는 인라인 컴포넌트
```html
<!-- 이미지 Lightbox -->
<img src="..." class="lightbox-trigger" alt="...">

<!-- 동영상 인라인 임베딩 -->
<div class="media-video-container">...</div>

<!-- PDF 인라인 뷰어 (첫 페이지 + "전체보기" 버튼) -->
<div class="pdf-preview">
  <img src="pdf-thumbnail.png" alt="PDF 미리보기">
  <a href="..." target="_blank" class="btn btn-primary">전체보기</a>
</div>

<!-- 문서 미리보기 (Word/Excel) -->
<div class="document-preview">
  <iframe src="https://view.officeapps.live.com/op/embed.aspx?src=..."></iframe>
</div>
```

### 4. 모바일/태블릿 최적화 (필수)
**기존**: 콘텐츠 일부 모바일 미대응
**추가 필요**:
- **최소 폰트 크기**: 모바일 12px 이상 (터치 가독성)
- **에디터 높이 모바일**: 최소 150px (쉽게 터치 가능)
- **미디어 반응형**: 모바일에서 max-width: 100% 적용
- **테이블**: 모바일 가로스크롤 또는 카드 뷰 전환
  ```css
  @media (max-width: 768px) {
    .table-responsive {
      overflow-x: auto;
      min-width: 100%;
    }
  }
  ```
- **이미지 로딩**: 모바일 네트워크 고려 (큰 이미지 자동 압축)

---

## 디자인 참고

### 미디어 컨테이너 스타일
```css
/* 공통 미디어 스타일 (전체 파일 <style>에 추가) */
.media-container {
  margin: 16px 0;
  padding: 0;
}

.media-image {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  display: block;
  margin: 12px 0;
}

.media-video-container {
  position: relative;
  width: 100%;
  max-width: 600px;
  padding-bottom: 56.25%;
  height: 0;
  overflow: hidden;
  border-radius: 8px;
  margin: 12px 0;
}

.media-video-container iframe {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: none;
}
```

### 에디터 스타일
```css
.ql-editor {
  min-height: 200px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  font-family: Pretendard, system-ui;
  font-size: 14px;
  line-height: 1.6;
  background: #ffffff;
}

.ql-editor:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.ql-toolbar {
  border: 1px solid #e5e7eb;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: #f9fafb;
}
```

### Lightbox 스타일
```css
.lightbox-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.8);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-image {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
```

---

## 구현 체크리스트

### 필수 작업
- [ ] 모든 HTML 파일 검토: 이미지 표시 방식 점검
- [ ] 모든 `<img>` 태그에 `max-width: 100%` + `height: auto` CSS 추가
- [ ] Lightbox 라이브러리 추가 (CDN):
  ```html
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lightbox2@2.11.3/dist/css/lightbox.min.css">
  <script src="https://cdn.jsdelivr.net/npm/lightbox2@2.11.3/dist/js/lightbox-plus-jquery.min.js"></script>
  ```
- [ ] Quill Editor 적용 대상 파일 목록화 (알림장, 과제, 댓글 등)
- [ ] 알림장, 관찰기록, 댓글 영역: Quill 에디터 추가
- [ ] Quill 공통 CSS 스타일 정의 (모든 파일 `<style>`에 추가)

### 권장 작업
- [ ] 동영상 임베딩 테스트 (YouTube/Vimeo 반응형 확인)
- [ ] PDF 뷰어 구현 (PDF.js 라이브러리 CDN):
  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  ```
- [ ] 이미지 지연로딩(lazy loading) 적용
  ```html
  <img src="..." loading="lazy" alt="...">
  ```
- [ ] 테이블 반응형 처리 (모바일 가로스크롤 또는 카드 뷰)
- [ ] Lightbox 설정 커스터마이징 (이전/다음 버튼, 캡션 등)

### 선택 작업
- [ ] 이미지 최적화 (자동 압축, WebP 포맷)
- [ ] 문서 미리보기 (Office 365 임베더 또는 Google Docs Viewer)

### 테스트 사항
- [ ] 모든 이미지 반응형 표시 확인 (360px~1920px)
- [ ] Lightbox 팝업 기능 및 이전/다음 네비게이션 검증
- [ ] Quill 에디터 텍스트 입력, 서식 적용, 이미지 업로드 테스트
- [ ] 동영상 임베딩 재생 및 반응형 비율 확인
- [ ] 모바일에서 터치 가능한 버튼 크기 (44x44px) 검증
- [ ] 최소 폰트 크기 12px 확인

---

## 적용 대상 파일 (우선순위 순)

### 1순위 (주요 콘텐츠 영역)
- `02_채움클래스/나의 클래스/02_수업/dacheum-lesson-player (4).html` (콘텐츠 뷰어)
- `02_채움클래스/나의 클래스/03_과제/homework-prototype (1).html` (Quill 기존, 확대)
- `03_채움콘텐츠/채움콘텐츠_프로토타입_v2 (1).html` (콘텐츠 임베딩)

### 2순위 (소통 영역)
- `02_채움클래스/나의 클래스/05_알림장/다채움_알림장_프로토타입 (2).html` (Quill 추가)
- `05_우리반 성장기록/student-growth-report (1).html` (관찰기록 Quill)
- `06_채움CBT/채움CBT_평가지플레이어_프로토타입.html` (콘텐츠 인라인)

### 3순위 (기타)
- `04_스스로채움/오답노트/index.html` (콘텐츠 표시)
- 나머지 모든 파일 (이미지 반응형 처리)

---

## 참고자료
- Quill 공식 문서: https://quilljs.com/docs/quickstart/
- Lightbox 2: https://lokeshdhakar.com/projects/lightbox2/
- PDF.js: https://mozilla.github.io/pdf.js/
- CSS 반응형 미디어: MDN Web Docs (Responsive Images)
- 색상체계: `dacheum-common.css` 참고
