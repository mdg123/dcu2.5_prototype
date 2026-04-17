const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat
} = require('docx');

const PAGE_WIDTH = 12240;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const hdrBorder = { style: BorderStyle.SINGLE, size: 1, color: "1d4ed8" };
const hdrBorders = { top: hdrBorder, bottom: hdrBorder, left: hdrBorder, right: hdrBorder };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function hCell(text, width) {
  return new TableCell({
    borders: hdrBorders, width: { size: width, type: WidthType.DXA },
    shading: { fill: "1d4ed8", type: ShadingType.CLEAR }, margins: cellMargins,
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, font: "Pretendard", size: 20, color: "FFFFFF" })] })]
  });
}

function c(text, width, opts = {}) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: opts.shading || undefined, margins: cellMargins,
    children: [new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      children: [new TextRun({ text, bold: opts.bold || false, font: "Pretendard", size: 19, color: opts.color || "333333" })]
    })]
  });
}

function mc(lines, width, opts = {}) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: opts.shading || undefined, margins: cellMargins,
    children: lines.map(l => new Paragraph({
      spacing: { after: 30 },
      children: [new TextRun({ text: typeof l === 'string' ? l : l.text, font: "Pretendard", size: 19, color: typeof l === 'string' ? (opts.color || "333333") : (l.color || "333333"), bold: typeof l === 'object' ? (l.bold || false) : false })]
    }))
  });
}

function makeTable(headers, rows, colWidths) {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalW, type: WidthType.DXA }, columnWidths: colWidths,
    rows: [
      new TableRow({ children: headers.map((h, i) => hCell(h, colWidths[i])) }),
      ...rows.map(row => new TableRow({
        children: row.map((cell, i) => {
          if (Array.isArray(cell)) return mc(cell, colWidths[i]);
          if (typeof cell === 'object' && cell.lines) return mc(cell.lines, colWidths[i], cell);
          if (typeof cell === 'object') return c(cell.text, colWidths[i], cell);
          return c(cell, colWidths[i]);
        })
      }))
    ]
  });
}

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, font: "Pretendard", size: 28, color: "1d4ed8" })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, font: "Pretendard", size: 24, color: "2563eb" })] });
}
function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 180, after: 100 },
    children: [new TextRun({ text, bold: true, font: "Pretendard", size: 22, color: "3b82f6" })] });
}
function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 },
    children: [new TextRun({ text, font: "Pretendard", size: 21, color: opts.color || "333333", bold: opts.bold || false })] });
}
function bullet(text) {
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 },
    children: [new TextRun({ text, font: "Pretendard", size: 20 })] });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Pretendard", size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Pretendard", color: "1d4ed8" },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Pretendard", color: "2563eb" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Pretendard", color: "3b82f6" },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 2 } },
    ]
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [
    // ═══ 표지 ═══
    {
      properties: { page: { size: { width: PAGE_WIDTH, height: 15840 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
      children: [
        new Paragraph({ spacing: { before: 3000 } }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
          children: [new TextRun({ text: "다채움 프로토타입", font: "Pretendard", size: 48, bold: true, color: "1d4ed8" })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 },
          children: [new TextRun({ text: "수정계획서", font: "Pretendard", size: 40, bold: true, color: "1A1A2E" })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: "1d4ed8", space: 1 } }, children: [] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
          children: [new TextRun({ text: "기존 다채움 플랫폼 분석 기반", font: "Pretendard", size: 24, color: "6B7280" })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 2000 },
          children: [new TextRun({ text: "2026. 03. 16.", font: "Pretendard", size: 22, color: "6B7280" })] }),
      ]
    },
    // ═══ 본문 ═══
    {
      properties: { page: { size: { width: PAGE_WIDTH, height: 15840 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
      headers: {
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "1d4ed8", space: 4 } },
          children: [new TextRun({ text: "다채움 프로토타입 수정계획서", font: "Pretendard", size: 16, color: "999999" })] })] })
      },
      footers: {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "- ", size: 16, color: "999999" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "999999" }), new TextRun({ text: " -", size: 16, color: "999999" })] })] })
      },
      children: [
        // ═══ 1. 수정 개요 ═══
        h1("1. 수정 개요"),
        p("본 수정계획서는 운영 중인 다채움 플랫폼(dcu.cbe.go.kr)의 실제 기능 분석 결과를 바탕으로, 프로토타입의 수정 및 보완 사항을 정리한 것이다."),
        p("품질제고 사업의 핵심은 기존 기능의 개선이므로, 운영 플랫폼의 프로세스 흐름을 정확히 재현한 후 개선 기능을 추가하는 방향으로 진행한다.", { bold: true }),

        h2("1.1 수정 원칙"),
        bullet("운영 플랫폼의 기본 프로세스 흐름을 우선 재현"),
        bullet("프로토타입의 개선 기능(CBT 이탈 감지, 게이미피케이션 등)은 유지"),
        bullet("하드코딩된 데이터를 모두 실제 DB 연동으로 전환"),
        bullet("GNB, 탭 구조 등 UI 골격을 운영 플랫폼과 정합"),

        h2("1.2 수정 단계 총괄"),
        makeTable(
          ["단계", "내용", "우선순위", "예상 범위"],
          [
            [{ text: "1단계", bold: true }, "긴급 버그 수정 (GNB, 하드코딩)", { text: "P0", bold: true, color: "DC2626" }, "CSS 1개 + JS 2개"],
            [{ text: "2단계", bold: true }, "수업 플레이어 이수율 연결", { text: "P0", bold: true, color: "DC2626" }, "BE 1개 + FE 2개"],
            [{ text: "3단계", bold: true }, "클래스 탭 토글 시스템 구현", { text: "P1", bold: true, color: "F59E0B" }, "DB + BE + FE"],
            [{ text: "4단계", bold: true }, "누락 기능 추가 (댓글없는 게시판 등)", { text: "P1", bold: true, color: "F59E0B" }, "DB + BE + FE"],
            [{ text: "5단계", bold: true }, "콘텐츠 유형 확장", { text: "P1", bold: true, color: "F59E0B" }, "DB + BE + FE"],
            [{ text: "6단계", bold: true }, "GNB 메뉴 정합 및 채움성장 기초", { text: "P2", bold: true, color: "3B82F6" }, "FE 위주"],
          ],
          [1000, 4000, 1400, 2960]
        ),

        // ═══ 2. 1단계 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("2. 1단계: 긴급 버그 수정"),

        h2("2.1 GNB 드롭다운 hover 버그"),
        p("증상: 1차 메뉴에서 2차 드롭다운으로 마우스 이동 시 4px gap 때문에 드롭다운이 사라짐"),
        makeTable(
          ["파일", "수정 내용", "방법"],
          [
            ["public/css/common-nav.css", ".gnb-dropdown의 margin-top: 4px 제거", "margin-top: 0으로 변경"],
            ["public/css/common-nav.css", "hover 영역 연결", ".gnb-menu-group에 padding-bottom: 4px 추가 또는 ::before 투명 브릿지"],
          ],
          [3000, 3600, 2760]
        ),

        h2("2.2 하드코딩 데이터 제거"),
        p("홈 탭의 학습 활동 통계 (수업 이수율 89%, 과제 제출률 76%, 평가 참여율 92%)가 하드코딩되어 있음", { bold: true, color: "DC2626" }),
        makeTable(
          ["파일", "하드코딩 항목", "수정 방향"],
          [
            ["public/class/class-home.html", "수업 이수율 89%", "GET /api/lesson/:classId → 완료된 수업 / 전체 수업 비율 계산"],
            ["public/class/class-home.html", "과제 제출률 76%", "GET /api/homework/:classId → 제출 수 / 전체 과제 비율 계산"],
            ["public/class/class-home.html", "평가 참여율 92%", "GET /api/exam/:classId → 응시 수 / 전체 평가 비율 계산"],
            ["public/class/class-home.html", "숙제 미제출 3건 등 알림 그리드", "API 기반 동적 카운트로 전환"],
          ],
          [3000, 2600, 3760]
        ),

        // ═══ 3. 2단계 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("3. 2단계: 수업 플레이어 이수율 연결"),
        p("이것이 가장 핵심적인 수정 사항이다. 운영 플랫폼에서는 수업 플레이어에서 학습 단계를 완료할 때마다 서버에 기록하고, 모든 단계 완료 시 이수 처리한다.", { bold: true }),

        h2("3.1 프로세스 흐름 (구현 목표)"),
        p("수업 생성 (교사) -> 콘텐츠 연결 (이미지/문항/영상) -> 수업 게시 -> 학생 수업 플레이어 진입 -> 각 단계 학습 -> 단계 완료 시 서버 기록 -> 모든 단계 완료 = 이수 완료 -> 홈 탭 이수율 자동 계산"),

        h2("3.2 수정 파일 및 내용"),
        makeTable(
          ["파일", "수정 내용"],
          [
            [{ text: "db/schema.js", bold: true }, { lines: [
              "lesson_progress 테이블 추가 또는 기존 lesson_views 활용:",
              "- lesson_id, user_id, content_id, completed (boolean), completed_at",
              "- 고유 제약: (lesson_id, user_id, content_id)"
            ] }],
            [{ text: "db/lesson.js (또는 routes/lesson.js)", bold: true }, { lines: [
              "- updateContentProgress(lessonId, userId, contentId): 단계별 진행 기록",
              "- getLessonProgress(lessonId, userId): 사용자의 단계별 진행률 반환",
              "- checkLessonCompletion(lessonId, userId): 모든 단계 완료 여부 판단",
              "- getClassCompletionRate(classId, userId): 클래스 전체 이수율 계산"
            ] }],
            [{ text: "routes/lesson.js", bold: true }, { lines: [
              "- POST /api/lesson/:classId/:lessonId/progress: 단계 완료 기록 API",
              "- GET /api/lesson/:classId/completion-rate: 이수율 반환 API",
              "- GET /api/lesson/:classId/:lessonId/my-progress: 개인 진행률 반환"
            ] }],
            [{ text: "public/class/lesson-player.html", bold: true }, { lines: [
              "- 각 콘텐츠 블록 학습 완료 시 fetch로 서버에 기록",
              "- 좌측 사이드바에 완료 체크마크 표시",
              "- 모든 단계 완료 시 이수 완료 모달 표시",
              "- 이미지: 로드 후 일정 시간 경과, 문항: 정답 제출, 영상: 재생 완료"
            ] }],
            [{ text: "public/class/class-home.html", bold: true }, { lines: [
              "- 홈 탭 로드 시 GET /api/lesson/:classId/completion-rate 호출",
              "- conic-gradient 차트를 실제 데이터로 업데이트",
              "- 과제 제출률, 평가 참여율도 동일하게 API 연동"
            ] }],
          ],
          [3200, 6160]
        ),

        // ═══ 4. 3단계 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("4. 3단계: 클래스 탭 토글 시스템"),
        p("운영 플랫폼에서는 클래스 관리 페이지에서 각 탭(수업/과제/평가/알림장/설문/감정출석부/커뮤니티/댓글없는게시판)을 개별적으로 켜고 끌 수 있다."),

        h2("4.1 DB 스키마 수정"),
        makeTable(
          ["테이블", "컬럼", "설명"],
          [
            ["classes", "enabled_tabs", "JSON 배열: 활성화된 탭 목록. 기본값: 모든 탭 활성화"],
          ],
          [2400, 2400, 4560]
        ),
        p("예시: [\"home\",\"lesson\",\"homework\",\"exam\",\"notice\",\"attendance\",\"board\",\"survey\"]"),

        h2("4.2 수정 파일"),
        makeTable(
          ["파일", "수정 내용"],
          [
            ["db/schema.js", "classes 테이블에 enabled_tabs TEXT DEFAULT NULL 추가"],
            ["routes/class.js", "PUT /api/class/:id에서 enabled_tabs 업데이트 처리"],
            ["routes/class.js", "GET /api/class/:id 응답에 enabled_tabs 포함"],
            [{ text: "public/class/manage.html", bold: true }, { lines: [
              "- 탭 관리 섹션 추가: 각 탭별 토글 스위치 UI",
              "- 토글 변경 시 PUT /api/class/:id로 저장",
              "- 홈 탭은 항상 활성 (비활성화 불가)"
            ] }],
            [{ text: "public/class/class-home.html", bold: true }, { lines: [
              "- 클래스 데이터 로드 시 enabled_tabs 확인",
              "- 비활성화된 탭은 탭바에서 숨김 처리",
              "- 비활성 탭 직접 URL 접근 시 안내 메시지"
            ] }],
          ],
          [3200, 6160]
        ),

        // ═══ 5. 4단계 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("5. 4단계: 누락 기능 추가"),

        h2("5.1 댓글없는 게시판"),
        p("운영 플랫폼에 있는 클래스 내 게시판으로, 댓글 기능이 없는 익명 게시판이다."),
        makeTable(
          ["파일", "수정 내용"],
          [
            ["db/schema.js", "anonymous_posts 테이블 추가 (id, class_id, content, created_at). 작성자 정보 미저장"],
            ["routes/board.js", "댓글없는 게시판 전용 API 추가: GET/POST /api/board/:classId/anonymous"],
            ["public/class/class-home.html", "댓글없는 게시판 탭 추가 (탭 토글 시스템과 연동)"],
          ],
          [3200, 6160]
        ),

        h2("5.2 클래스별 학습분석 메뉴"),
        p("GNB 채움클래스 하위에 학습 현황, 우리반 학습분석 메뉴가 누락되어 있다."),
        makeTable(
          ["파일", "수정 내용"],
          [
            ["public/class/analytics.html", "기존 파일 활용. GNB에서 접근 가능하도록 링크 추가"],
            ["public/js/common-nav.js", "채움클래스 드롭다운에 학습 현황, 우리반 학습분석 메뉴 추가"],
            ["routes/class.js", "학습 분석 데이터 API: 클래스별 수업/과제/평가 통계 집계"],
          ],
          [3200, 6160]
        ),

        // ═══ 6. 5단계 ═══
        h1("6. 5단계: 콘텐츠 유형 확장"),
        p("운영 플랫폼에 있는 수업꾸러미와 수업레시피 유형을 추가한다."),

        makeTable(
          ["유형", "설명", "구현 방향"],
          [
            [{ text: "수업꾸러미", bold: true }, "여러 콘텐츠를 묶은 패키지", "contents 테이블에 type = bundle 추가. content_bundle_items 연결 테이블"],
            [{ text: "수업레시피", bold: true }, "수업 진행 가이드 문서", "contents 테이블에 type = recipe 추가. 에디터로 작성"],
          ],
          [2000, 3000, 4360]
        ),

        makeTable(
          ["파일", "수정 내용"],
          [
            ["db/schema.js", "contents.type CHECK에 bundle, recipe 추가"],
            ["db/schema.js", "content_bundle_items 테이블 추가 (bundle_id, content_id, order)"],
            ["routes/content.js", "수업꾸러미 CRUD API 추가 (하위 콘텐츠 연결/해제)"],
            ["public/content/", "콘텐츠 유형 필터에 수업꾸러미, 수업레시피 추가"],
          ],
          [3200, 6160]
        ),

        // ═══ 7. 6단계 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("7. 6단계: GNB 메뉴 정합 및 채움성장"),

        h2("7.1 GNB 메뉴 추가/수정"),
        makeTable(
          ["대메뉴", "추가할 하위메뉴", "동작"],
          [
            ["채움클래스", { lines: ["학습 현황", "우리반 학습분석"] }, "analytics.html 연결"],
            [{ text: "채움성장 (신규)", bold: true }, { lines: ["마이페이지", "나의 학습경로", "활동 포인트", "나의 배지"] }, { lines: ["마이페이지: 기본 프로필 + 설정", "학습경로: 이수 이력 타임라인", "활동 포인트: 활동 기반 포인트", "나의 배지: 출석+학습 배지 모음"] }],
          ],
          [2000, 2800, 4560]
        ),

        h2("7.2 채움성장 최소 구현"),
        p("채움성장은 전체 구현이 아닌 최소 기능만 구현한다:"),
        bullet("마이페이지: 기존 사용자 정보 표시 + 비밀번호 변경"),
        bullet("나의 배지: 출석부 배지 + 학습 완료 배지를 통합 표시"),
        bullet("나의 학습경로 / 활동 포인트: 추후 구현 표시"),

        // ═══ 8. 기타 수정 사항 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("8. 기타 수정 사항"),

        h2("8.1 소통쪽지 구조 조정"),
        p("현재 프로토타입은 소통쪽지를 클래스 내 탭으로 구현했으나, 운영 플랫폼에서는 별도 기능이다."),
        bullet("클래스 내 탭에서 제거 (탭 토글 시스템 도입 시 함께 처리)"),
        bullet("상단 GNB 또는 사용자 아이콘 영역에 쪽지 아이콘으로 이동"),
        bullet("클래스와 무관하게 전체 사용자 간 쪽지 가능하도록 확장"),

        h2("8.2 알림장 레이아웃 개선"),
        p("운영 플랫폼의 날짜별 타임라인 레이아웃을 참고하여 프로토타입 알림장에 반영"),
        bullet("날짜 구분선 추가 (오늘, 어제, 이번 주 등)"),
        bullet("기존 테마 기능은 유지"),

        h2("8.3 평가(Exam) 구조 정비"),
        p("운영 플랫폼의 클래스 내 평가와 프로토타입의 CBT 통합 구조 간 정합:"),
        bullet("클래스 내 평가: 간이 퀴즈 형태 (교사가 문항 직접 작성)"),
        bullet("채움CBT: PDF 기반 본격 시험 (이탈 감지 포함)"),
        bullet("두 유형 모두 같은 exams 테이블 사용, type 필드로 구분"),

        // ═══ 9. 수정 일정 ═══
        new Paragraph({ children: [new PageBreak()] }),
        h1("9. 수정 일정 (권고)"),

        makeTable(
          ["단계", "작업", "소요 시간 (추정)", "선행 조건"],
          [
            [{ text: "1단계", bold: true, color: "DC2626" }, "GNB 버그 + 하드코딩 제거", "2-3시간", "없음"],
            [{ text: "2단계", bold: true, color: "DC2626" }, "수업 플레이어 이수율 연결", "4-6시간", "1단계 완료"],
            [{ text: "3단계", bold: true, color: "F59E0B" }, "클래스 탭 토글 시스템", "3-4시간", "없음 (병행 가능)"],
            [{ text: "4단계", bold: true, color: "F59E0B" }, "댓글없는 게시판 + 학습분석 메뉴", "3-4시간", "3단계 완료"],
            [{ text: "5단계", bold: true, color: "F59E0B" }, "콘텐츠 유형 확장", "2-3시간", "없음 (병행 가능)"],
            [{ text: "6단계", bold: true, color: "3B82F6" }, "GNB 정합 + 채움성장 기초", "3-4시간", "전체 구조 확정 후"],
          ],
          [1000, 3500, 2000, 2860]
        ),

        p(""),
        p("총 예상 소요 시간: 17-24시간 (순차 진행 기준)", { bold: true }),
        p("1단계와 2단계는 순차적으로, 3-5단계는 병행 진행이 가능하다."),

        // ═══ 10. 검증 체크리스트 ═══
        h1("10. 검증 체크리스트"),

        makeTable(
          ["번호", "검증 항목", "기대 결과"],
          [
            ["1", "GNB 1차 메뉴에서 2차 드롭다운으로 hover 이동", "드롭다운이 사라지지 않고 유지됨"],
            ["2", "수업 플레이어에서 모든 단계 학습 완료", "서버에 이수 완료 기록, 홈 이수율 업데이트"],
            ["3", "홈 탭 수업 이수율", "실제 이수 데이터 기반 동적 표시 (하드코딩 아님)"],
            ["4", "클래스 관리에서 탭 토글", "비활성화된 탭이 클래스 홈에서 숨겨짐"],
            ["5", "댓글없는 게시판 글 작성", "댓글 없이 글만 표시, 작성자 비노출"],
            ["6", "콘텐츠 유형에 수업꾸러미 생성", "여러 콘텐츠를 묶어 패키지로 관리"],
            ["7", "채움성장 메뉴 접근", "마이페이지, 나의 배지 기본 화면 표시"],
            ["8", "과제 제출률/평가 참여율", "실제 제출 데이터 기반 동적 계산"],
          ],
          [600, 4500, 4260]
        ),
      ]
    }
  ]
});

const outputPath = process.argv[2] || 'modification-plan.docx';
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outputPath, buffer);
  console.log(`Plan saved to: ${outputPath}`);
  console.log(`File size: ${(buffer.length / 1024).toFixed(1)} KB`);
});
