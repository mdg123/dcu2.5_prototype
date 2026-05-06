// lib/portfolio-pdf.js
// 다채움 포트폴리오 PDF 보고서 생성기 (서버 사이드, pdfkit 기반)
// 기획서: docs/spec_portfolio_pdf_report.md
//
// 사용 예:
//   const buffer = await generatePortfolioReport(reportData, options);
//   fs.writeFileSync('out.pdf', buffer);
//
// 한글 폰트: public/fonts/NanumGothic.ttf, HancomGothicBold.ttf
// 모든 텍스트는 NanumGothic 기본, 강조는 HancomGothicBold (또는 NanumGothic 글자 두께만 차이)

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NanumGothic.ttf');
// Bold 별도 파일 (있으면 사용, 없으면 Regular fallback)
const FONT_BOLD_CANDIDATES = [
  path.join(FONT_DIR, 'NanumGothicBold.ttf'),
  path.join(FONT_DIR, 'HancomGothicBold.ttf'),
  path.join(FONT_DIR, 'NanumGothic.ttf')   // 최종 폴백
];
const FONT_BOLD = FONT_BOLD_CANDIDATES.find(p => fs.existsSync(p)) || FONT_REGULAR;

// 다채움 색상
const COLOR = {
  primary: '#2563eb',
  primaryDark: '#1d4ed8',
  primaryLight: '#dbeafe',
  success: '#10b981',
  warning: '#f59e0b',
  text: '#1a1a2e',
  textSub: '#334155',
  textMeta: '#64748b',
  textMute: '#94a3b8',
  border: '#e2e8f0',
  bgSoft: '#f8fafc',
  white: '#ffffff'
};

const SUBJECT_COLOR = {
  '수학': '#2563eb', '국어': '#3b82f6', '과학': '#10b981', '사회': '#0284c7',
  '영어': '#4f46e5', '미술': '#10b981', '음악': '#a855f7', '체육': '#ea580c'
};

const SCHOOL_LEVEL_LABEL = { elementary: '초등', middle: '중등', high: '고등' };

function fmtDate(d) {
  if (!d) return '';
  return String(d).slice(0, 10);
}

function safe(text, fallback = '') {
  if (text === null || text === undefined) return fallback;
  return String(text);
}

/**
 * @param {Object} data - report-data API 결과 (student, period, summary, competencies, growthAreas, items, timeline, messages)
 * @param {Object} options - { coverNote, includeReflection, title }
 * @returns {Promise<Buffer>}
 */
function generatePortfolioReport(data, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        bufferPages: true,
        autoFirstPage: true,
        info: {
          Title: options.title || '다채움 포트폴리오 보고서',
          Author: '다채움',
          Subject: '학생 포트폴리오',
          Creator: '다채움 플랫폼'
        }
      });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // 한글 폰트 등록
      try { doc.registerFont('Regular', FONT_REGULAR); } catch (e) { /* 시스템 폴백 */ }
      try { doc.registerFont('Bold', FONT_BOLD); } catch (e) { /* 시스템 폴백 */ }
      doc.font('Regular');

      let pageCount = 1;
      const trackPage = () => { pageCount = doc.bufferedPageRange().count; };
      doc.on('pageAdded', () => {
        // 페이지 추가 시 하단 푸터 자동 그리기 (마지막에 일괄)
      });

      // ───── 1. 표지 ─────
      drawCover(doc, data, options);

      // ───── 2. 통계 요약 ─────
      doc.addPage();
      drawSummary(doc, data, options);

      // ───── 3. 6대 핵심역량 ─────
      doc.addPage();
      drawCompetencies(doc, data);

      // ───── 4. 6대 성장영역 ─────
      doc.addPage();
      drawGrowthAreas(doc, data);

      // ───── 5. 활동별 상세 ─────
      const items = (data.items || []).slice(0, 20);
      items.forEach((item, idx) => {
        doc.addPage();
        drawActivity(doc, item, idx + 1, items.length, options);
      });

      // ───── 6. 마무리 ─────
      doc.addPage();
      drawClosing(doc, data, options);

      // 푸터 일괄 적용 — pdfkit이 새 페이지 자동추가하지 않도록 margin.bottom 임시 0 처리
      const range = doc.bufferedPageRange();
      const totalPages = range.count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(range.start + i);
        // 자동 페이지 분기 차단
        const origMargins = doc.page.margins;
        doc.page.margins = { top: origMargins.top, bottom: 0, left: origMargins.left, right: origMargins.right };
        const footerY = doc.page.height - 35;
        doc.font('Regular').fontSize(9).fillColor(COLOR.textMute);
        doc.text(
          `다채움 포트폴리오 · ${safe(data.student && data.student.displayName, '학생')}`,
          50, footerY,
          { lineBreak: false, width: 300 }
        );
        doc.text(
          `${i + 1} / ${totalPages}`,
          doc.page.width - 100, footerY,
          { width: 50, align: 'right', lineBreak: false }
        );
        doc.page.margins = origMargins;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ───── 표지 ─────
function drawCover(doc, data, options) {
  const { width, height } = doc.page;
  const student = data.student || {};
  const period = data.period || {};

  // 상단 다채움 헤더 라벨
  doc.font('Bold').fontSize(11).fillColor(COLOR.primary);
  doc.text('다채움 · 충북교육청 통합 교육 플랫폼', 50, 60, { lineBreak: false });

  // 중앙 큰 박스 (그라디언트 대용 단색 헤더 띠)
  const titleY = height * 0.18;
  doc.save();
  doc.roundedRect(50, titleY, width - 100, 90, 14).fill(COLOR.primary);
  doc.fillColor(COLOR.white).font('Bold').fontSize(28);
  doc.text('성장 포트폴리오 보고서', 50, titleY + 30, { width: width - 100, align: 'center' });
  doc.restore();

  // 학생 이름 (크게)
  const nameY = titleY + 130;
  doc.fillColor(COLOR.text).font('Bold').fontSize(32);
  doc.text(`${safe(student.displayName, '학생')} 학생`, 50, nameY, { width: width - 100, align: 'center' });

  // 학교 / 학년 / 반
  const meta = [];
  if (student.school) meta.push(student.school);
  if (student.grade) meta.push(`${student.grade}학년`);
  if (student.classroom) meta.push(student.classroom);
  doc.font('Regular').fontSize(15).fillColor(COLOR.textSub);
  doc.text(meta.join(' · ') || '학교/학년/반 정보 없음', 50, nameY + 50, { width: width - 100, align: 'center' });

  // 기간 큰 텍스트
  doc.font('Regular').fontSize(14).fillColor(COLOR.textMeta);
  const periodText = (period.from && period.to) ? `${period.from} ~ ${period.to}` : (period.label || '전체 기간');
  doc.text(periodText, 50, nameY + 90, { width: width - 100, align: 'center' });

  // 메타 헤더 박스 (기간 / 학교급)
  const boxY = nameY + 140;
  const levelLabel = SCHOOL_LEVEL_LABEL[period.schoolLevel] || period.schoolLevelLabel || '';
  doc.roundedRect(80, boxY, width - 160, 36, 8).fillAndStroke(COLOR.bgSoft, COLOR.border);
  doc.font('Bold').fontSize(13).fillColor('#475569');
  const filterLine = `기간: ${period.from || '-'} ~ ${period.to || '-'}${levelLabel ? `   /   학교급: ${levelLabel}` : ''}`;
  doc.text(filterLine, 80, boxY + 11, { width: width - 160, align: 'center' });

  // 표제 (cover note)
  if (options.coverNote) {
    const noteY = boxY + 70;
    doc.font('Regular').fontSize(13).fillColor(COLOR.textSub);
    doc.text(`"${options.coverNote}"`, 80, noteY, { width: width - 160, align: 'center' });
  }

  // 발행일
  const today = new Date();
  const ymd = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  doc.font('Regular').fontSize(11).fillColor(COLOR.textMute);
  doc.text(`${ymd} 발행`, 50, height - 80, { width: width - 100, align: 'center' });
}

// ───── 통계 요약 ─────
function drawSummary(doc, data, options) {
  const { width } = doc.page;
  drawPageHeader(doc, '활동 요약', '');

  const summary = data.summary || {};
  const cards = [
    { label: '전체 활동', value: summary.totalActivities || 0, suffix: '건', color: COLOR.primary },
    { label: '인생 과제', value: summary.lifeTaskCount || 0, suffix: '건', color: COLOR.success },
    { label: '회고 작성', value: summary.reflectionCount || 0, suffix: '건', color: COLOR.warning },
    { label: '활동 일수', value: summary.activeDays || 0, suffix: '일', color: '#8b5cf6' }
  ];

  // 4개 카드 (2x2 또는 1x4)
  const startY = 130;
  const cardW = (width - 100 - 30) / 4; // 4 카드 + 3 gap
  cards.forEach((c, i) => {
    const x = 50 + i * (cardW + 10);
    doc.save();
    doc.roundedRect(x, startY, cardW, 100, 10).fillAndStroke(COLOR.bgSoft, COLOR.border);
    doc.fillColor(COLOR.textMeta).font('Regular').fontSize(11);
    doc.text(c.label, x + 12, startY + 14, { width: cardW - 24 });
    doc.fillColor(c.color).font('Bold').fontSize(28);
    doc.text(String(c.value), x + 12, startY + 36, { width: cardW - 24 });
    doc.fillColor(COLOR.textMeta).font('Regular').fontSize(11);
    doc.text(c.suffix, x + 12, startY + 72, { width: cardW - 24 });
    doc.restore();
  });

  // 상위 역량 Top 3
  const top3 = (summary.competencyTop3 || []).slice(0, 3);
  if (top3.length > 0) {
    const top3Y = startY + 140;
    doc.font('Bold').fontSize(15).fillColor(COLOR.text);
    doc.text('나의 강점 역량 Top 3', 50, top3Y);
    top3.forEach((label, i) => {
      const itemY = top3Y + 30 + i * 38;
      doc.save();
      doc.roundedRect(50, itemY, width - 100, 30, 8).fillAndStroke(COLOR.primaryLight, COLOR.primary);
      doc.fillColor(COLOR.primary).font('Bold').fontSize(13);
      doc.text(`#${i + 1}  ${label}`, 64, itemY + 9, { width: width - 128 });
      doc.restore();
    });
  }

  // 학생 한 마디
  if (options.coverNote || (data.messages && data.messages.studentNote)) {
    const noteY = 480;
    const text = options.coverNote || data.messages.studentNote;
    doc.font('Bold').fontSize(13).fillColor(COLOR.text);
    doc.text('나의 한 마디', 50, noteY);
    doc.save();
    doc.roundedRect(50, noteY + 22, width - 100, 80, 10).fillAndStroke(COLOR.bgSoft, COLOR.border);
    doc.font('Regular').fontSize(12).fillColor(COLOR.textSub);
    doc.text(text, 64, noteY + 36, { width: width - 128, height: 60, ellipsis: true });
    doc.restore();
  }
}

// ───── 6대 핵심역량 ─────
function drawCompetencies(doc, data) {
  const { width } = doc.page;
  drawPageHeader(doc, '6대 핵심역량', '활동 데이터 기반 산출');

  const comps = data.competencies || [];
  const startY = 140;

  comps.forEach((c, i) => {
    const y = startY + i * 60;
    // 라벨
    doc.font('Bold').fontSize(13).fillColor(COLOR.text);
    doc.text(c.label, 50, y, { width: 130 });
    // 점수
    doc.font('Bold').fontSize(15).fillColor(COLOR.primary);
    doc.text(`${c.score}점`, 180, y, { width: 60, align: 'right' });
    // 막대 배경
    const barX = 260, barY = y + 4, barW = width - barX - 60, barH = 18;
    doc.save();
    doc.roundedRect(barX, barY, barW, barH, 9).fill(COLOR.border);
    // 막대 채움
    const fillW = Math.max(0, Math.min(1, c.score / 100)) * barW;
    if (fillW > 0) {
      doc.roundedRect(barX, barY, fillW, barH, 9).fill(COLOR.primary);
    }
    doc.restore();
    // 보조: 태그 빈도
    if (c.tagCount !== undefined) {
      doc.font('Regular').fontSize(10).fillColor(COLOR.textMute);
      doc.text(`태그 ${c.tagCount}회`, barX, barY + barH + 4);
    }
  });
}

// ───── 6대 성장영역 ─────
function drawGrowthAreas(doc, data) {
  const { width } = doc.page;
  drawPageHeader(doc, '6대 성장영역', '학습 활동 + 정서 + 진로');

  const areas = data.growthAreas || [];
  const startY = 140;

  areas.forEach((a, i) => {
    const y = startY + i * 60;
    doc.font('Bold').fontSize(13).fillColor(COLOR.text);
    doc.text(a.name, 50, y, { width: 130 });
    doc.font('Bold').fontSize(15).fillColor(a.hasData ? COLOR.success : COLOR.textMute);
    doc.text(a.hasData ? `${a.score}점` : '데이터 없음', 180, y, { width: 80, align: 'right' });
    // 막대
    const barX = 270, barY = y + 4, barW = width - barX - 60, barH = 18;
    doc.save();
    doc.roundedRect(barX, barY, barW, barH, 9).fill(COLOR.border);
    if (a.hasData) {
      const fillW = Math.max(0, Math.min(1, (a.score || 0) / 100)) * barW;
      doc.roundedRect(barX, barY, fillW, barH, 9).fill(COLOR.success);
    }
    doc.restore();
  });
}

// ───── 활동 상세 ─────
function drawActivity(doc, item, num, total, options) {
  const { width } = doc.page;
  const subjectColor = SUBJECT_COLOR[item.subject] || COLOR.primary;

  // 헤더 — 좌측 4px 컬러 라인
  const headY = 60;
  doc.save();
  doc.rect(50, headY, 4, 22).fill(subjectColor);
  doc.restore();
  doc.font('Bold').fontSize(11).fillColor(subjectColor);
  doc.text(`${item.subject || '활동'} · ${item.grade_year ? item.grade_year + '학년' : ''}`, 64, headY + 4, { width: width - 200 });
  doc.font('Regular').fontSize(10).fillColor(COLOR.textMute);
  doc.text(`활동 ${num} / ${total}`, width - 100, headY + 6, { width: 50, align: 'right' });

  // 제목
  doc.font('Bold').fontSize(20).fillColor(COLOR.text);
  doc.text(safe(item.title || item.activity_name, '제목 없음'), 50, headY + 36, { width: width - 100 });

  // 메타
  const metaParts = [];
  if (item.activity_date) metaParts.push(fmtDate(item.activity_date));
  if (item.score) metaParts.push(`${item.score}점`);
  if (item.is_life_task) metaParts.push('★ 인생 과제');
  if (item.activity_type) metaParts.push(item.activity_type);
  doc.font('Regular').fontSize(11).fillColor(COLOR.textMeta);
  doc.text(metaParts.join(' · '), 50, headY + 78);

  // 본문 (content / description)
  let cursorY = headY + 110;
  if (item.content || item.description) {
    doc.font('Bold').fontSize(12).fillColor(COLOR.text);
    doc.text('활동 내용', 50, cursorY);
    cursorY += 20;
    doc.font('Regular').fontSize(12).fillColor(COLOR.textSub);
    const text = safe(item.content || item.description);
    doc.text(text, 50, cursorY, { width: width - 100, align: 'left' });
    cursorY = doc.y + 14;
  }

  // 교사 코멘트
  if (item.teacher_comment) {
    doc.font('Bold').fontSize(12).fillColor(COLOR.text);
    doc.text('선생님 한 마디', 50, cursorY);
    cursorY += 20;
    doc.save();
    doc.rect(50, cursorY, 4, 50).fill(COLOR.primary);
    doc.restore();
    doc.font('Regular').fontSize(12).fillColor('#475569');
    doc.text(safe(item.teacher_comment), 64, cursorY + 4, { width: width - 128 });
    cursorY = Math.max(cursorY + 60, doc.y + 14);
  }

  // 학생 회고
  if (item.reflection && options.includeReflection !== false) {
    doc.font('Bold').fontSize(12).fillColor(COLOR.text);
    doc.text('나의 회고', 50, cursorY);
    cursorY += 20;
    doc.save();
    doc.roundedRect(50, cursorY, width - 100, 80, 8).fillAndStroke(COLOR.bgSoft, COLOR.border);
    doc.font('Regular').fontSize(12).fillColor(COLOR.textSub);
    doc.text(safe(item.reflection), 64, cursorY + 12, { width: width - 128, height: 60, ellipsis: true });
    doc.restore();
    cursorY += 96;
  }

  // 역량 태그
  let tags = item.competency_tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { tags = []; }
  }
  if (Array.isArray(tags) && tags.length > 0) {
    doc.font('Bold').fontSize(12).fillColor(COLOR.text);
    doc.text('관련 역량', 50, cursorY);
    cursorY += 20;
    let chipX = 50;
    const chipY = cursorY;
    tags.forEach(tag => {
      const txt = `#${safe(tag)}`;
      doc.font('Bold').fontSize(10).fillColor(COLOR.primary);
      const w = doc.widthOfString(txt) + 16;
      if (chipX + w > width - 50) { return; } // 한 줄 초과 방지
      doc.save();
      doc.roundedRect(chipX, chipY, w, 22, 11).fill(COLOR.primaryLight);
      doc.fillColor(COLOR.primary).font('Bold').fontSize(10);
      doc.text(txt, chipX + 8, chipY + 6, { width: w - 16, lineBreak: false });
      doc.restore();
      chipX += w + 6;
    });
  }
}

// ───── 마무리 ─────
function drawClosing(doc, data, options) {
  const { width } = doc.page;
  drawPageHeader(doc, '마무리 한 마디', '');

  const messages = data.messages || {};
  let cursorY = 140;

  // 학생 한 마디
  if (options.coverNote || messages.studentNote) {
    const text = options.coverNote || messages.studentNote;
    doc.font('Bold').fontSize(13).fillColor(COLOR.text);
    doc.text('학생의 한 마디', 50, cursorY);
    cursorY += 22;
    doc.save();
    doc.roundedRect(50, cursorY, width - 100, 90, 10).fillAndStroke(COLOR.bgSoft, COLOR.border);
    doc.font('Regular').fontSize(12).fillColor(COLOR.textSub);
    doc.text(safe(text), 64, cursorY + 14, { width: width - 128, height: 70, ellipsis: true });
    doc.restore();
    cursorY += 110;
  }

  // 교사 한 마디
  if (messages.teacherNote) {
    doc.font('Bold').fontSize(13).fillColor(COLOR.text);
    doc.text('선생님의 한 마디', 50, cursorY);
    cursorY += 22;
    doc.save();
    doc.roundedRect(50, cursorY, width - 100, 90, 10).fillAndStroke(COLOR.primaryLight, COLOR.primary);
    doc.font('Regular').fontSize(12).fillColor('#475569');
    doc.text(safe(messages.teacherNote), 64, cursorY + 14, { width: width - 128, height: 70, ellipsis: true });
    doc.restore();
    cursorY += 110;
  }

  // 다음 목표
  doc.font('Bold').fontSize(13).fillColor(COLOR.text);
  doc.text('다음 목표', 50, cursorY);
  cursorY += 22;
  doc.save();
  doc.roundedRect(50, cursorY, width - 100, 60, 10).fillAndStroke(COLOR.bgSoft, COLOR.border);
  doc.font('Regular').fontSize(12).fillColor(COLOR.textMute);
  doc.text('다음 학기에는 더 많은 활동에 참여하고, 나만의 인생 과제를 완성해 봅시다.', 64, cursorY + 18, { width: width - 128 });
  doc.restore();
  cursorY += 80;

  // 서명란
  doc.font('Regular').fontSize(11).fillColor(COLOR.textMeta);
  const today = new Date();
  const ymd = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  doc.text(`발행일: ${ymd}`, 50, cursorY + 30);
  doc.text(`학생 서명: ____________________     교사 서명: ____________________`, 50, cursorY + 50, { width: width - 100 });
}

// 공통 페이지 헤더
function drawPageHeader(doc, title, subtitle) {
  const { width } = doc.page;
  doc.save();
  doc.rect(50, 60, 4, 30).fill(COLOR.primary);
  doc.restore();
  doc.font('Bold').fontSize(20).fillColor(COLOR.text);
  doc.text(title, 64, 64, { width: width - 130 });
  if (subtitle) {
    doc.font('Regular').fontSize(11).fillColor(COLOR.textMeta);
    doc.text(subtitle, 64, 92, { width: width - 130 });
  }
  // 구분선
  doc.save();
  doc.moveTo(50, 110).lineTo(width - 50, 110).strokeColor(COLOR.border).lineWidth(1).stroke();
  doc.restore();
}

module.exports = {
  generatePortfolioReport
};
