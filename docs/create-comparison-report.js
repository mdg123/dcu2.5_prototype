const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat, ExternalHyperlink
} = require('docx');

// ─── 공통 설정 ───
const PAGE_WIDTH = 12240;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // 9360

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const headerBorder = { style: BorderStyle.SINGLE, size: 1, color: "2563EB" };
const headerBorders = { top: headerBorder, bottom: headerBorder, left: headerBorder, right: headerBorder };

const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };
const headerShading = { fill: "2563EB", type: ShadingType.CLEAR };
const subHeaderShading = { fill: "EBF5FF", type: ShadingType.CLEAR };
const highlightShading = { fill: "FFF3CD", type: ShadingType.CLEAR };
const issueShading = { fill: "FFE0E0", type: ShadingType.CLEAR };

// ─── 유틸 ───
function headerCell(text, width) {
  return new TableCell({
    borders: headerBorders, width: { size: width, type: WidthType.DXA },
    shading: headerShading, margins: cellMargins,
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, font: "Pretendard", size: 20, color: "FFFFFF" })] })]
  });
}

function cell(text, width, opts = {}) {
  const runs = [];
  if (opts.bold) runs.push(new TextRun({ text, bold: true, font: "Pretendard", size: 19, color: opts.color || "333333" }));
  else runs.push(new TextRun({ text, font: "Pretendard", size: 19, color: opts.color || "333333" }));
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: opts.shading || undefined, margins: cellMargins,
    verticalAlign: opts.vAlign || undefined,
    children: [new Paragraph({ alignment: opts.align || AlignmentType.LEFT, children: runs })]
  });
}

function multiLineCell(lines, width, opts = {}) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: opts.shading || undefined, margins: cellMargins,
    children: lines.map(l => new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: l, font: "Pretendard", size: 19, color: opts.color || "333333" })]
    }))
  });
}

function sectionTitle(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, font: "Pretendard", size: 28, color: "1d4ed8" })]
  });
}

function subTitle(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, font: "Pretendard", size: 24, color: "2563eb" })]
  });
}

function bodyText(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, font: "Pretendard", size: 21, color: opts.color || "333333", bold: opts.bold || false })]
  });
}

// ─── 비교 테이블 생성 ───
function comparisonTable(headers, rows, colWidths) {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalW, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ children: headers.map((h, i) => headerCell(h, colWidths[i])) }),
      ...rows.map(row => new TableRow({
        children: row.map((c, i) => {
          if (typeof c === 'object' && c.lines) return multiLineCell(c.lines, colWidths[i], c);
          if (typeof c === 'object') return cell(c.text, colWidths[i], c);
          return cell(c, colWidths[i]);
        })
      }))
    ]
  });
}

// ════════════════════════════════════════
//  문서 생성
// ════════════════════════════════════════
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
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [
    // ═══ 표지 섹션 ═══
    {
      properties: {
        page: { size: { width: PAGE_WIDTH, height: 15840 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } }
      },
      children: [
        new Paragraph({ spacing: { before: 3000 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: "다채움 플랫폼", font: "Pretendard", size: 48, bold: true, color: "2563EB" })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
          children: [new TextRun({ text: "기존 기능 vs 프로토타입 비교 분석 보고서", font: "Pretendard", size: 36, bold: true, color: "1A1A2E" })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 100 },
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: "2563EB", space: 1 } },
          children: []
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 100 },
          children: [new TextRun({ text: "충청북도교육청 통합 교육 플랫폼 품질제고 구축 사업", font: "Pretendard", size: 24, color: "6B7280" })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 2000 },
          children: [new TextRun({ text: "2026. 03. 16.", font: "Pretendard", size: 22, color: "6B7280" })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 100 },
          children: [new TextRun({ text: "분석 대상", font: "Pretendard", size: 22, bold: true, color: "333333" })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 60 },
          children: [new TextRun({ text: "운영 플랫폼: dcu.cbe.go.kr / class.cbe.go.kr", font: "Pretendard", size: 20, color: "6B7280" })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 60 },
          children: [new TextRun({ text: "프로토타입: Node.js + SQLite 실동작 버전", font: "Pretendard", size: 20, color: "6B7280" })]
        }),
      ]
    },

    // ═══ 목차 + 본문 ═══
    {
      properties: {
        page: { size: { width: PAGE_WIDTH, height: 15840 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } }
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "2563EB", space: 4 } },
            children: [new TextRun({ text: "다채움 기존 기능 vs 프로토타입 비교 분석", font: "Pretendard", size: 16, color: "999999" })]
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "- ", font: "Pretendard", size: 16, color: "999999" }),
              new TextRun({ children: [PageNumber.CURRENT], font: "Pretendard", size: 16, color: "999999" }),
              new TextRun({ text: " -", font: "Pretendard", size: 16, color: "999999" })]
          })]
        })
      },
      children: [
        // ═══ 1. 분석 개요 ═══
        sectionTitle("1. 분석 개요"),
        bodyText("본 보고서는 현재 운영 중인 다채움 플랫폼(dcu.cbe.go.kr)의 주요 기능을 실제 사용 테스트하고, 품질제고 사업을 위해 개발 중인 프로토타입과 기능별로 비교 분석한 결과이다."),
        bodyText("품질제고 사업의 핵심 목적은 기존 기능의 개선이므로, 실제 운영 시스템의 프로세스 흐름을 정확히 파악하여 프로토타입에 반영하는 것이 핵심이다.", { bold: true }),

        subTitle("1.1 분석 범위"),
        comparisonTable(
          ["영역", "운영 플랫폼 URL", "프로토타입 대응"],
          [
            ["채움클래스", "class.cbe.go.kr", "public/class/"],
            ["채움콘텐츠", "dcu.cbe.go.kr > 채움콘텐츠", "public/content/"],
            ["스스로채움", "dcu.cbe.go.kr > 스스로채움", "public/learning/"],
            ["우리반 성장기록", "dcu.cbe.go.kr > 우리반성장기록", "public/growth/"],
            ["채움CBT", "dcu.cbe.go.kr > 채움더하기 > 채움CBT", "public/cbt/"],
          ],
          [2000, 3500, 3860]
        ),

        subTitle("1.2 역할별 접근 차이"),
        bodyText("운영 플랫폼은 역할에 따라 접근 가능한 메뉴가 다르다:"),
        comparisonTable(
          ["역할", "접근 가능 메뉴", "비고"],
          [
            ["교사", { lines: ["채움클래스 (전체)", "채움콘텐츠 (전체)", "채움더하기 (전체)"], color: "333333" }, "수업/과제/평가 생성 가능"],
            ["학생", { lines: ["채움클래스 (참여)", "스스로채움", "채움콘텐츠 (일부)"], color: "333333" }, "스스로채움은 학생 전용"],
            [{ text: "담임교사", bold: true }, { lines: ["우리반 성장기록", "우리반 학습분석"], color: "333333" }, { text: "담임 지정 교사만 접근", color: "DC2626" }],
          ],
          [2000, 4500, 2860]
        ),

        // ═══ 2. GNB 메뉴 구조 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("2. GNB(글로벌 내비게이션) 메뉴 구조 비교"),

        comparisonTable(
          ["대메뉴", "운영 플랫폼 하위메뉴", "프로토타입 하위메뉴", "차이점"],
          [
            [{ text: "채움클래스", bold: true },
              { lines: ["나의 클래스", "클래스 관리", "클래스 찾기", "클래스별 학습분석", "학습 현황", "우리반 학습분석"] },
              { lines: ["나의 클래스", "클래스 찾기", "클래스 관리", "학습분석"] },
              { text: "학습 현황, 우리반 학습분석 메뉴 누락", color: "DC2626" }],
            [{ text: "채움콘텐츠", bold: true },
              { lines: ["나의 보관함", "추천콘텐츠", "공개콘텐츠", "나도예술가"] },
              { lines: ["나의 보관함", "추천콘텐츠", "공개콘텐츠", "나도예술가"] },
              { text: "구조 일치", color: "10B981" }],
            [{ text: "스스로채움", bold: true },
              { lines: ["오늘의 학습", "AI 맞춤학습", "오답노트"] },
              { lines: ["오늘의 학습", "AI 맞춤학습", "오답노트"] },
              { text: "구조 일치 (학생 전용)", color: "10B981" }],
            [{ text: "우리반성장기록", bold: true },
              { lines: ["대시보드", "성장리포트", "포트폴리오"] },
              { lines: ["대시보드", "성장리포트", "포트폴리오"] },
              { text: "구조 일치 (담임 전용)", color: "10B981" }],
            [{ text: "채움성장", bold: true },
              { lines: ["마이페이지", "나의 학습경로", "활동 포인트", "나의 배지"] },
              "미구현",
              { text: "전체 미구현", color: "DC2626" }],
            [{ text: "채움더하기", bold: true },
              { lines: ["채움CBT", "채움모니터", "한글웹에디터", "채움캔버스", "진로진학", "나우늘봄", "채움코딩", "채움타자", "채움수학", "채움영어"] },
              { lines: ["채움CBT (실동작)", "기타: 링크만 유지"] },
              "민간서비스는 링크만"],
          ],
          [1600, 2800, 2600, 2360]
        ),

        bodyText(""),
        bodyText("핵심 차이: GNB hover 시 1차 메뉴에서 2차 드롭다운으로 이동할 때 4px gap으로 인해 드롭다운이 사라지는 버그가 프로토타입에 존재한다.", { bold: true, color: "DC2626" }),

        // ═══ 3. 채움클래스 탭 구조 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("3. 채움클래스 내부 탭 구조 비교"),

        bodyText("운영 플랫폼의 클래스 내부는 탭 기반으로 구성되며, 클래스 관리 페이지에서 탭을 선택적으로 활성화/비활성화할 수 있다."),

        comparisonTable(
          ["탭 이름", "운영 플랫폼", "프로토타입", "일치 여부"],
          [
            ["홈", "클래스 대시보드 + 공지", "알림 그리드 + 활동 통계", "부분 일치"],
            ["수업", "수업 목록 + 수업 플레이어", "수업 목록 + 수업 플레이어", { text: "일치", color: "10B981" }],
            ["과제", "과제 목록 + 제출 현황(%)", "과제 목록 + 제출", { text: "일치", color: "10B981" }],
            ["평가", "평가 목록 + 문제풀이 결과", "CBT 통합 평가", "부분 일치"],
            ["알림장", "날짜별 카드 레이아웃", "테마 선택 + 카드", "부분 일치"],
            [{ text: "감정출석부", bold: true }, "주간 테이블 (멤버x일)", "1클릭 출석 + 게이미피케이션", { text: "컨셉 변경", color: "F59E0B" }],
            ["커뮤니티", "일반 게시판", "게시판", { text: "일치", color: "10B981" }],
            ["댓글없는 게시판", "익명 게시판 (댓글 불가)", "미구현", { text: "미구현", color: "DC2626" }],
            ["설문", "설문 생성/응답/결과", "설문 CRUD + 응답", { text: "일치", color: "10B981" }],
            ["소통쪽지", "없음 (별도 메뉴)", "클래스 내 탭으로 구현", { text: "구조 차이", color: "F59E0B" }],
          ],
          [1800, 2600, 2600, 2360]
        ),

        bodyText(""),
        bodyText("중요: 운영 플랫폼에서는 클래스 관리 페이지에서 탭을 토글로 켜고 끌 수 있다. 프로토타입에도 이 기능이 필요하다.", { bold: true }),

        // ═══ 4. 수업(Lesson) 상세 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("4. 수업(Lesson) 기능 상세 비교"),

        subTitle("4.1 수업 목록"),
        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["목록 형태", "카드 리스트 (제목 + 날짜 + 상태)", "카드 리스트 (순서번호 + 제목 + 메타)"],
            ["상태 표시", "진행 중 / 완료", "draft / published / archived"],
            ["이수율 표시", "없음 (수업 플레이어에서 추적)", { text: "홈 탭에 89% 하드코딩됨 (문제)", color: "DC2626", bold: true }],
            ["콘텐츠 연결", "수업에 콘텐츠(이미지/문항) 연결", "lesson_contents 테이블로 연결"],
          ],
          [2000, 3680, 3680]
        ),

        subTitle("4.2 수업 플레이어 (핵심 프로세스)"),
        bodyText("운영 플랫폼의 수업 플레이어는 학습 이수율 추적의 핵심이다. 프로토타입에서 이수율이 하드코딩된 것은 이 프로세스가 미연결된 것이 원인이다.", { bold: true, color: "DC2626" }),

        comparisonTable(
          ["항목", "운영 플랫폼 (classLessonViewer.do)", "프로토타입 (lesson-player.html)"],
          [
            ["구조", "좌측 사이드바(단계 목록) + 우측 콘텐츠 영역", "좌측 사이드바 + 우측 콘텐츠 영역"],
            ["단계 유형", { lines: ["이미지 슬라이드", "문항 (선택/서술형)", "영상 (스트리밍)"] }, { lines: ["콘텐츠 블록 기반", "유형별 렌더링"] }],
            ["진행률 추적", { text: "각 단계 완료 시 서버에 기록 (실시간)", bold: true }, { text: "lesson_views 테이블 존재하나 연결 미확인", color: "F59E0B" }],
            ["도구 모음", { lines: ["필기 도구", "타이머", "북마크", "전체화면"] }, "기본 뷰어만"],
            ["이수 판정", { text: "모든 단계 완료 = 이수 완료", bold: true }, { text: "이수 판정 로직 없음", color: "DC2626" }],
          ],
          [2000, 3680, 3680]
        ),

        bodyText(""),
        bodyText("필수 수정사항: 수업 플레이어에서 단계별 진행률을 서버에 저장하고, 모든 단계 완료 시 이수로 처리하는 로직을 구현해야 한다. 홈 탭의 이수율은 이 데이터를 기반으로 동적 계산되어야 한다.", { bold: true, color: "DC2626" }),

        // ═══ 5. 과제(Homework) 상세 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("5. 과제(Homework) 기능 상세 비교"),

        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["과제 목록", "제목 + 기한 + 제출현황(%)", "제목 + 기한 + 진행바"],
            ["제출 현황", { text: "실시간 제출률 퍼센트 표시 (예: 87%)", bold: true }, "homework_submissions 기반 계산"],
            ["제출 형태", "텍스트 + 파일 첨부", "텍스트 + 파일 업로드 (multer)"],
            ["채점/피드백", "점수 + 코멘트", "homework_feedbacks 테이블 + 루브릭"],
            ["늦은 제출", "허용 여부 설정 가능", "allow_late 플래그 존재"],
            ["차이점", { text: "운영 플랫폼과 거의 일치하는 구조", color: "10B981" }, { text: "루브릭 기반 채점은 프로토타입이 더 상세", color: "2563EB" }],
          ],
          [2000, 3680, 3680]
        ),

        bodyText("과제 기능은 운영 플랫폼과 프로토타입이 가장 유사한 영역이다. 제출률 계산 로직이 정확히 동작하는지 확인 필요."),

        // ═══ 6. 평가(Exam) 상세 비교 ═══
        sectionTitle("6. 평가(Exam/CBT) 기능 상세 비교"),

        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["평가 유형", "클래스 내 평가 (간이 퀴즈)", "CBT 통합 (PDF 기반 시험)"],
            ["문제 형식", "문항 선택 (콘텐츠 라이브러리)", { text: "PDF 업로드 + JSON 정답", bold: true }],
            ["결과 확인", { lines: ["문제풀이 결과 버튼", "평가지보기 버튼"] }, "자동 채점 + 결과 화면"],
            [{ text: "이탈 감지", bold: true }, "없음", { text: "탭 이탈/포커스 감지 (Socket.IO)", color: "2563EB", bold: true }],
            ["실시간 감독", "없음", { text: "교사 감독 화면 + 실시간 알림", color: "2563EB", bold: true }],
            ["시간 제한", "기본 제공", "time_limit 필드 + 타이머 UI"],
          ],
          [2000, 3680, 3680]
        ),

        bodyText(""),
        bodyText("프로토타입의 평가 기능은 운영 플랫폼보다 고도화되어 있다 (CBT 이탈 감지, 실시간 감독). 이는 채움CBT 모듈의 기능을 클래스 내 평가와 통합한 결과이다."),

        // ═══ 7. 알림장(Notice) 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("7. 알림장(Notice) 기능 비교"),

        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["레이아웃", "날짜별 카드 (타임라인 형태)", "카드 리스트 + 테마 선택"],
            ["테마", "없음 (단일 디자인)", { text: "5가지 테마: chalkboard, cork, whiteboard, pastel, classic", color: "2563EB" }],
            ["고정 공지", "미확인", "is_pinned 플래그"],
            ["읽음 확인", "미확인", "notice_reads 테이블로 추적"],
            ["반응(리액션)", "없음", { text: "notice_reactions 테이블 (좋아요 등)", color: "2563EB" }],
          ],
          [2000, 3680, 3680]
        ),

        bodyText("프로토타입의 알림장이 운영 플랫폼보다 기능이 풍부하다 (테마, 읽음 확인, 리액션). 단, 운영 플랫폼의 날짜별 타임라인 레이아웃은 참고할 필요가 있다."),

        // ═══ 8. 출석부 비교 ═══
        sectionTitle("8. 출석부 기능 비교"),

        comparisonTable(
          ["항목", "운영 플랫폼 (감정출석부)", "프로토타입 (1클릭 출석부)"],
          [
            ["방식", { text: "감정 이모지 선택 후 출석", bold: true }, { text: "1클릭 출석 + 선택적 한마디(30자)", bold: true }],
            ["데이터", "감정 상태 + 출석 여부", "출석 여부 + 코멘트"],
            ["교사 뷰", "주간 테이블 (멤버 x 요일)", "기간별 테이블 + 통계 + 엑셀 다운"],
            ["게이미피케이션", "없음", { text: "연속 출석, 뱃지, 랭킹, 공동 목표", color: "2563EB" }],
            ["개인정보", { text: "감정 데이터 수집 (개인정보 이슈)", color: "DC2626" }, { text: "감정 데이터 제거 (RFP SFR-017)", color: "10B981" }],
          ],
          [2000, 3680, 3680]
        ),

        bodyText("출석부는 RFP SFR-017 요구사항에 따라 의도적으로 컨셉을 변경한 영역이다. 감정 데이터 수집을 제거하고 게이미피케이션으로 전환."),

        // ═══ 9. 채움콘텐츠 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("9. 채움콘텐츠 기능 비교"),

        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            [{ text: "콘텐츠 유형", bold: true },
              { lines: ["영상", "이미지", "문서", "문항", "평가지", "활동지", "수업꾸러미", "수업레시피"] },
              { lines: ["영상", "이미지", "문서", "문항", "평가지", "활동지"] }],
            ["차이", "", { text: "수업꾸러미, 수업레시피 누락", color: "DC2626" }],
            ["나의 보관함", "유형별 탭 필터링", "콘텐츠 카드 리스트"],
            ["추천콘텐츠", "유형 탭 + 인기 콘텐츠 리스트", "추천 알고리즘 (더미)"],
            ["공개콘텐츠", "검색 + 필터", "검색 + 필터"],
            ["나도예술가", "학생 작품 갤러리", "갤러리 뷰"],
          ],
          [2000, 3680, 3680]
        ),

        bodyText("채움콘텐츠에서 수업꾸러미와 수업레시피 유형이 프로토타입에 누락되어 있다. 이는 교사가 여러 콘텐츠를 묶어 수업 패키지로 만드는 기능으로, 추가 구현이 필요하다.", { bold: true }),

        // ═══ 10. 채움CBT 비교 ═══
        sectionTitle("10. 채움CBT 기능 비교"),

        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["위치", "채움더하기 > 채움CBT", "별도 CBT 모듈 + 클래스 평가 통합"],
            ["시험지 관리", { lines: ["채움CBT시험지 (검색/필터)", "나의 보관함 (임시저장/비공개/진행중)", "나의 평가결과"] }, { lines: ["시험 생성 (PDF + 정답)", "시험 목록 관리"] }],
            ["검색 필터", "학교급/교과/검색영역", "기본 검색"],
            [{ text: "이탈 감지", bold: true }, { text: "없음", color: "DC2626" }, { text: "Socket.IO 기반 실시간 이탈 감지", color: "10B981", bold: true }],
            ["감독 기능", "없음", { text: "교사 감독 화면 (학생별 이탈 현황)", color: "10B981", bold: true }],
          ],
          [2000, 3680, 3680]
        ),

        bodyText("채움CBT는 프로토타입이 운영 플랫폼보다 크게 고도화된 영역이다. 이탈 감지와 실시간 감독은 품질제고의 핵심 개선 기능이다."),

        // ═══ 11. 클래스 관리/찾기 비교 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("11. 클래스 관리 및 찾기 기능 비교"),

        subTitle("11.1 클래스 관리"),
        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["기본 정보 수정", "클래스명, 설명, 학년/학기", "클래스명, 설명, 과목"],
            [{ text: "탭 설정", bold: true }, { text: "탭별 토글 ON/OFF (핵심 기능)", bold: true, color: "DC2626" }, { text: "미구현", color: "DC2626" }],
            ["멤버 관리", "멤버 목록 + 역할 (교사/학생)", "멤버 목록 + 역할 (owner/member)"],
            ["초대 코드", "클래스 코드 발급", "6자리 코드 생성"],
            ["공개/비공개", "설정 가능", "is_public 필드 존재"],
          ],
          [2000, 3680, 3680]
        ),

        bodyText(""),
        bodyText("클래스 관리에서 탭 토글 기능은 운영 플랫폼의 핵심 기능이나 프로토타입에 미구현되어 있다. 반드시 추가해야 한다.", { bold: true, color: "DC2626" }),

        subTitle("11.2 클래스 찾기"),
        comparisonTable(
          ["항목", "운영 플랫폼", "프로토타입"],
          [
            ["검색", "클래스명 / 코드 검색", "클래스명 / 코드 검색"],
            ["필터", { text: "가입가능한 / 우리학교", bold: true }, "공개 클래스 필터"],
            ["가입 방식", "코드 입력 또는 가입 요청", "코드 입력 또는 직접 가입"],
          ],
          [2000, 3680, 3680]
        ),

        // ═══ 12. 핵심 이슈 요약 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("12. 핵심 이슈 요약"),

        bodyText("아래는 프로토타입에서 반드시 수정/보완해야 할 핵심 이슈를 우선순위별로 정리한 것이다.", { bold: true }),

        comparisonTable(
          ["우선순위", "이슈", "설명", "영향도"],
          [
            [{ text: "P0", bold: true, color: "FFFFFF", shading: { fill: "DC2626", type: ShadingType.CLEAR } },
              { text: "수업 이수율 하드코딩", bold: true },
              "홈 탭의 이수율 89%가 하드코딩됨. 수업 플레이어 진행률과 연결 필수",
              { text: "매우 높음", color: "DC2626", bold: true }],
            [{ text: "P0", bold: true, color: "FFFFFF", shading: { fill: "DC2626", type: ShadingType.CLEAR } },
              { text: "GNB 드롭다운 버그", bold: true },
              "1차 메뉴에서 2차 메뉴로 hover 이동 시 4px gap으로 드롭다운 사라짐",
              { text: "매우 높음", color: "DC2626", bold: true }],
            [{ text: "P1", bold: true, color: "FFFFFF", shading: { fill: "F59E0B", type: ShadingType.CLEAR } },
              { text: "클래스 탭 토글 미구현", bold: true },
              "클래스 관리에서 탭 ON/OFF 기능. 운영 플랫폼 핵심 기능",
              { text: "높음", color: "F59E0B" }],
            [{ text: "P1", bold: true, color: "FFFFFF", shading: { fill: "F59E0B", type: ShadingType.CLEAR } },
              { text: "댓글없는 게시판 미구현", bold: true },
              "운영 플랫폼에 있는 클래스 내 익명 게시판 (댓글 불가)",
              { text: "높음", color: "F59E0B" }],
            [{ text: "P1", bold: true, color: "FFFFFF", shading: { fill: "F59E0B", type: ShadingType.CLEAR } },
              { text: "콘텐츠 유형 누락", bold: true },
              "수업꾸러미, 수업레시피 유형 추가 필요",
              { text: "높음", color: "F59E0B" }],
            [{ text: "P2", bold: true, color: "FFFFFF", shading: { fill: "3B82F6", type: ShadingType.CLEAR } },
              { text: "채움성장 메뉴 미구현", bold: true },
              "마이페이지, 나의 학습경로, 활동 포인트, 나의 배지",
              "중간"],
            [{ text: "P2", bold: true, color: "FFFFFF", shading: { fill: "3B82F6", type: ShadingType.CLEAR } },
              { text: "소통쪽지 구조 차이", bold: true },
              "운영 플랫폼은 별도 메뉴, 프로토타입은 클래스 내 탭",
              "중간"],
            [{ text: "P3", bold: true, color: "333333", shading: { fill: "E5E7EB", type: ShadingType.CLEAR } },
              "학습 현황/우리반 학습분석 메뉴",
              "GNB에 해당 메뉴 추가 필요",
              "낮음"],
          ],
          [900, 2200, 4260, 2000]
        ),

        // ═══ 13. 프로토타입 우수 기능 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("13. 프로토타입 우수 기능 (운영 플랫폼 대비 개선)"),

        bodyText("프로토타입에서 운영 플랫폼보다 개선된 기능들이다. 품질제고의 목적에 부합하는 기능으로, 유지 및 강화해야 한다."),

        comparisonTable(
          ["기능", "운영 플랫폼", "프로토타입 개선 내용"],
          [
            [{ text: "CBT 이탈 감지", bold: true }, "없음", "Socket.IO 기반 실시간 탭 이탈/포커스 감지 + 교사 감독 화면"],
            [{ text: "1클릭 출석 + 게이미피케이션", bold: true }, "감정 이모지 출석", "개인정보 보호 + 연속 출석/뱃지/랭킹/공동 목표"],
            [{ text: "알림장 테마", bold: true }, "단일 디자인", "5가지 비주얼 테마 + 읽음 확인 + 리액션"],
            [{ text: "루브릭 기반 채점", bold: true }, "기본 점수 채점", "과제 제출에 루브릭 평가 기준 적용"],
            [{ text: "실시간 소통", bold: true }, "기본 게시판", "Socket.IO 기반 실시간 쪽지 + 그룹 메시징"],
          ],
          [2400, 2600, 4360]
        ),

        // ═══ 14. 결론 ═══
        new Paragraph({ children: [new PageBreak()] }),
        sectionTitle("14. 결론 및 권고사항"),

        bodyText("1. 수업 플레이어 → 이수율 연결은 최우선 과제이다. 이것이 해결되지 않으면 홈 화면의 학습 활동 통계가 무의미해진다.", { bold: true }),
        bodyText(""),
        bodyText("2. GNB 드롭다운 버그는 모든 페이지에 영향을 미치는 UX 문제로 즉시 수정해야 한다.", { bold: true }),
        bodyText(""),
        bodyText("3. 클래스 탭 토글 기능은 운영 플랫폼의 핵심 유연성 기능이므로 반드시 구현해야 한다."),
        bodyText(""),
        bodyText("4. 프로토타입이 운영 플랫폼보다 우수한 기능(CBT 이탈 감지, 게이미피케이션 출석, 알림장 테마 등)은 품질제고의 핵심 성과로 유지한다."),
        bodyText(""),
        bodyText("5. 누락된 콘텐츠 유형(수업꾸러미, 수업레시피)과 미구현 메뉴(채움성장, 댓글없는 게시판)는 단계적으로 추가한다."),
        bodyText(""),
        bodyText("6. 운영 플랫폼의 프로세스 흐름(수업 생성 → 콘텐츠 연결 → 수업 시작 → 플레이어 학습 → 이수 판정)을 프로토타입에 정확히 재현해야 한다.", { bold: true }),
      ]
    }
  ]
});

// 파일 저장
const outputPath = process.argv[2] || 'comparison-report.docx';
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outputPath, buffer);
  console.log(`Report saved to: ${outputPath}`);
  console.log(`File size: ${(buffer.length / 1024).toFixed(1)} KB`);
});
