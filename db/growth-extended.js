// db/growth-extended.js
const db = require('./index');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 서비스 미제공 영역 — 실제 데이터가 없을 때만 점수 0 처리 (데이터가 있으면 정상 표시)
const NO_SERVICE_AREAS = [];

// ========== 감정 어휘 정본화 — 읽기 시점 방어적 정규화 (정본화 스펙 §2-1·§7-4) ==========
// 출석부 라이브 UI(attendance.html)가 5단계 척도(very_bad/bad/soso/good/great)로 입력하므로
// 1~3단계(very_bad/bad/soso) 또는 과거 시드 잔재(okay/focused/bored)가 attendance.emotion에 유입될 수 있다.
// DB는 이미 1회 remap으로 정합 상태이나, 향후 라이브 유입·외부 import 재오염을 막기 위해
// 집계 결과를 읽는 시점에 항상 정본 10키(happy/excited/great/good/calm/tired/sad/angry/anxious/frustrated)로 환원한다.
const EMOTION_NORMALIZE = {
  very_bad: 'sad',  bad: 'sad',   soso: 'calm',          // 출석부 5단계 라이브 입력
  okay: 'calm',     focused: 'good', bored: 'tired'      // 과거 시드 잔재(방어선)
};
function normEmotion(e) { return e ? (EMOTION_NORMALIZE[e] || e) : e; }

// [{emotion, cnt}] 행 배열을 정본키로 정규화 + 동일 정본키 합산 + cnt desc 재정렬
function normalizeEmotionCounts(rows) {
  const merged = new Map();
  for (const r of rows) {
    const key = normEmotion(r.emotion);
    merged.set(key, (merged.get(key) || 0) + r.cnt);
  }
  return Array.from(merged, ([emotion, cnt]) => ({ emotion, cnt }))
    .sort((a, b) => b.cnt - a.cnt);
}

// 학교급 매핑 (학년 → 학교급)
function gradeToSchoolLevel(grade) {
  const g = parseInt(grade, 10);
  if (!g || isNaN(g)) return null;
  if (g >= 1 && g <= 6) return 'elementary';
  if (g >= 7 && g <= 9) return 'middle';
  if (g >= 10 && g <= 12) return 'high';
  return null;
}

function schoolLevelToGradeRange(level) {
  if (level === 'elementary') return [1, 6];
  if (level === 'middle') return [7, 9];
  if (level === 'high') return [10, 12];
  return null;
}

function schoolLevelLabel(level) {
  const map = { elementary: '초등', middle: '중등', high: '고등' };
  return map[level] || '';
}

// ========== 포트폴리오 아카이브 ==========

function getPortfolioItems(userId, opts = {}) {
  const {
    grade, subject, type, keyword, lifeTaskOnly,
    semester, from, to, schoolLevel, source, dateRange, category, team, lifeTask,
    page = 1, limit = 20
  } = opts;

  let where = 'WHERE pi.user_id = ?';
  const params = [userId];
  if (grade) { where += ' AND pi.grade_year = ?'; params.push(String(grade)); }
  if (semester) { where += ' AND pi.semester = ?'; params.push(String(semester)); }
  if (subject) { where += ' AND pi.subject = ?'; params.push(subject); }
  if (type) { where += ' AND pi.source_type = ?'; params.push(type); }
  if (source) { where += ' AND pi.source_type = ?'; params.push(source); }
  if (category && category !== 'all') {
    where += ' AND (pi.subject = ? OR pi.activity_type = ?)';
    params.push(category, category);
  }
  if (keyword) { where += ' AND (pi.activity_name LIKE ? OR pi.subject LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  const lt = lifeTaskOnly || lifeTask;
  if (lt && lt !== '0' && lt !== 'false') { where += ' AND pi.is_life_task = 1'; }
  if (team && team !== '0' && team !== 'false') { where += " AND (pi.activity_type = 'team' OR pi.source_type = 'team')"; }

  // 기간 필터 (활동일 기준; 활동일 없으면 created_at 사용)
  if (from) { where += ' AND COALESCE(pi.activity_date, DATE(pi.created_at)) >= ?'; params.push(from); }
  if (to) { where += ' AND COALESCE(pi.activity_date, DATE(pi.created_at)) <= ?'; params.push(to); }

  // dateRange 단순 별칭 (week/month/year)
  if (dateRange && !from && !to) {
    const today = new Date();
    let start = null;
    if (dateRange === 'week') { start = new Date(today); start.setDate(today.getDate() - 7); }
    else if (dateRange === 'month') { start = new Date(today); start.setMonth(today.getMonth() - 1); }
    else if (dateRange === 'year') { start = new Date(today); start.setFullYear(today.getFullYear() - 1); }
    if (start) {
      where += ' AND COALESCE(pi.activity_date, DATE(pi.created_at)) >= ?';
      params.push(start.toISOString().slice(0, 10));
    }
  }

  // 학교급 필터
  if (schoolLevel) {
    const range = schoolLevelToGradeRange(schoolLevel);
    if (range) {
      // school_level 직접 매칭 또는 grade_year(예: '5') 가 학년 범위 안에 들어가는 경우.
      // 자동 수집 항목(과제 제출·문항풀이 등)은 메타(school_level/grade_year)가 둘 다 NULL일 수 있다.
      // 메타가 없는 항목은 학교급을 판정할 수 없으므로 학교급 필터에서 제외하지 않고 항상 포함한다.
      // (학생 포트폴리오 화면은 기본 학교급 필터가 활성이라, 이 절이 없으면 자동 항목이 전부 가려진다)
      where += ` AND (pi.school_level = ? OR (pi.grade_year IS NOT NULL AND CAST(pi.grade_year AS INTEGER) BETWEEN ? AND ?) OR (pi.school_level IS NULL AND pi.grade_year IS NULL))`;
      params.push(schoolLevel, range[0], range[1]);
    }
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM portfolio_items pi ${where}`).get(...params).cnt;
  const offset = (page - 1) * limit;
  const items = db.prepare(`
    SELECT pi.* FROM portfolio_items pi ${where}
    ORDER BY COALESCE(pi.activity_date, DATE(pi.created_at)) DESC, pi.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  items.forEach(item => {
    if (item.competency_tags) { try { item.competency_tags = JSON.parse(item.competency_tags); } catch { item.competency_tags = []; } }
    // BUG-1 fix: title alias 추가 (프론트가 item.title 을 참조)
    item.title = item.activity_name || item.title || '';
    item.isLifeTask = !!item.is_life_task;
    item.isPublic = !!item.is_public;
  });

  const hasMore = offset + items.length < total;
  return { items, total, totalPages: Math.ceil(total / limit) || 1, page, hasMore };
}

// 직접 활동 추가 (BUG-2 fix) — camelCase, snake_case 모두 허용
function createPortfolioItem(userId, data) {
  const d = data || {};
  // camelCase / snake_case 양쪽에서 끌어온다
  const title = d.title;
  const activityName = d.activityName || d.activity_name;
  const subject = d.subject;
  const category = d.category;
  const activityType = d.activityType || d.activity_type;
  const source = d.source || d.source_type;
  const activityDate = d.activityDate || d.activity_date;
  const dateStart = d.dateStart || d.date_start || d.period_start;
  const content = d.content || d.evidence_url || null;
  const description = d.description;
  const reflection = d.reflection;
  const classId = d.classId || d.class_id;
  const gradeYear = d.gradeYear || d.grade_year || d.grade;
  const semester = d.semester;
  const schoolLevel = d.schoolLevel || d.school_level;
  const score = d.score;
  const isLifeTask = d.isLifeTask !== undefined ? d.isLifeTask : d.is_life_task;
  const isPublic = d.isPublic !== undefined ? d.isPublic : d.is_public;
  const competencyTags = d.competencyTags || d.competency_tags;
  const teacherComment = d.teacherComment || d.teacher_comment;
  const contentImageUrl = d.contentImageUrl || d.content_image_url || d.evidence_url;

  const name = (activityName || title || '').trim();
  if (!name) throw new Error('활동명을 입력하세요.');

  const u = db.prepare('SELECT grade FROM users WHERE id = ?').get(userId);
  const inferredLevel = schoolLevel || (u ? gradeToSchoolLevel(u.grade) : null);

  const info = db.prepare(`
    INSERT INTO portfolio_items
      (user_id, source_type, source_id, class_id,
       activity_name, subject, activity_date, score, result_type, activity_type,
       is_life_task, is_public, competency_tags, reflection,
       grade_year, semester, school_level, teacher_comment, content_image_url, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    userId,
    source || 'custom',
    classId || null,
    name,
    subject || category || null,
    activityDate || dateStart || new Date().toISOString().slice(0, 10),
    score != null ? String(score) : null,
    activityType || category || 'custom',
    isLifeTask ? 1 : 0,
    isPublic === false ? 0 : 1,
    competencyTags ? (typeof competencyTags === 'string' ? competencyTags : JSON.stringify(competencyTags)) : null,
    reflection || description || content || null,
    gradeYear ? String(gradeYear) : (u && u.grade ? String(u.grade) : null),
    semester ? String(semester) : null,
    inferredLevel,
    teacherComment || null,
    contentImageUrl || null
  );
  return { id: info.lastInsertRowid, activityName: name };
}

function getPortfolioItemDetail(id) {
  const item = db.prepare('SELECT * FROM portfolio_items WHERE id = ?').get(id);
  if (!item) return null;
  if (item.competency_tags) { try { item.competency_tags = JSON.parse(item.competency_tags); } catch { item.competency_tags = []; } }
  // BUG-1 fix: title alias 추가
  item.title = item.activity_name || '';
  item.isLifeTask = !!item.is_life_task;
  item.isPublic = !!item.is_public;
  const attachments = db.prepare('SELECT * FROM portfolio_attachments WHERE portfolio_item_id = ?').all(id);
  return { item, attachments };
}

function toggleLifeTask(id, userId) {
  const item = db.prepare('SELECT is_life_task FROM portfolio_items WHERE id = ? AND user_id = ?').get(id, userId);
  if (!item) return null;
  const newVal = item.is_life_task ? 0 : 1;
  db.prepare('UPDATE portfolio_items SET is_life_task = ? WHERE id = ?').run(newVal, id);
  return { isLifeTask: !!newVal };
}

function saveReflection(id, userId, { reflection, competencyTags }) {
  db.prepare('UPDATE portfolio_items SET reflection = ?, competency_tags = ? WHERE id = ? AND user_id = ?')
    .run(reflection || null, competencyTags ? JSON.stringify(competencyTags) : null, id, userId);
}

function updatePrivacy(id, userId, isPublic) {
  db.prepare('UPDATE portfolio_items SET is_public = ? WHERE id = ? AND user_id = ?').run(isPublic ? 1 : 0, id, userId);
}

function getPortfolioStats(userId) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ?').get(userId).cnt;
  const lifeTaskCount = db.prepare('SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? AND is_life_task = 1').get(userId).cnt;
  const reflectionCount = db.prepare("SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? AND reflection IS NOT NULL AND reflection != ''").get(userId).cnt;
  const goalCount = db.prepare('SELECT COUNT(*) as cnt FROM growth_goals WHERE user_id = ?').get(userId).cnt;
  const bySubject = db.prepare('SELECT subject, COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? AND subject IS NOT NULL GROUP BY subject').all(userId);
  const byType = db.prepare('SELECT source_type, COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? GROUP BY source_type').all(userId);
  return { total, totalItems: total, lifeTaskCount, reflectionCount, goalCount, bySubject, byType };
}

// ========== 6대 핵심역량 통계 (BUG-4) ==========
// portfolio_items.competency_tags 누적 + 활동량/회고/인생과제 가산점으로 100점 만점 환산
function getCompetencyStats(userId, { startDate, endDate, gradeLevel } = {}) {
  let where = 'WHERE user_id = ?';
  const params = [userId];
  if (startDate) { where += ' AND activity_date >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND activity_date <= ?'; params.push(endDate); }
  const items = db.prepare(`SELECT competency_tags, reflection, is_life_task, score FROM portfolio_items ${where}`).all(...params);

  const KEYS = [
    { key: 'self',          label: '자기관리',     keywords: ['자기관리', '자기 관리', '자기주도'] },
    { key: 'knowledge',     label: '지식정보처리', keywords: ['지식정보처리', '지식 정보 처리', '정보처리'] },
    { key: 'creative',      label: '창의적 사고',  keywords: ['창의적사고', '창의적 사고', '창의'] },
    { key: 'aesthetic',     label: '심미적 감성',  keywords: ['심미적감성', '심미적 감성', '심미'] },
    { key: 'communication', label: '협력적 소통',  keywords: ['협력적소통', '협력적 소통', '소통', '협력'] },
    { key: 'community',     label: '공동체',       keywords: ['공동체'] }
  ];

  const tagCount = Object.fromEntries(KEYS.map(k => [k.key, 0]));
  let totalTags = 0;
  let reflectionCount = 0;
  let lifeTaskCount = 0;

  items.forEach(it => {
    let tags = [];
    if (it.competency_tags) {
      try { tags = typeof it.competency_tags === 'string' ? JSON.parse(it.competency_tags) : it.competency_tags; } catch { tags = []; }
    }
    if (Array.isArray(tags)) {
      tags.forEach(t => {
        const tagStr = String(t || '').trim();
        if (!tagStr) return;
        KEYS.forEach(k => {
          if (k.keywords.some(kw => tagStr.includes(kw))) { tagCount[k.key]++; totalTags++; }
        });
      });
    }
    if (it.reflection && it.reflection.trim()) reflectionCount++;
    if (it.is_life_task) lifeTaskCount++;
  });

  // 활동량 기반 베이스 점수 (활동이 5건 이상이면 베이스 70점)
  const activityCount = items.length;
  const baseScore = Math.min(70, 40 + activityCount * 4);
  const reflectionBonus = Math.min(15, reflectionCount * 2);
  const lifeTaskBonus = Math.min(10, lifeTaskCount * 3);

  return KEYS.map(k => {
    // 태그 비중 (0~15점) — 같은 역량 태그가 자주 나오면 더 높게
    const tagBonus = totalTags > 0 ? Math.min(15, Math.round((tagCount[k.key] / Math.max(1, totalTags)) * 60)) : Math.floor(Math.random() * 6);
    const score = Math.max(0, Math.min(100, baseScore + reflectionBonus + lifeTaskBonus + tagBonus));
    return { key: k.key, label: k.label, score, tagCount: tagCount[k.key] };
  });
}

// ========== PDF 보고서 메타데이터 + 파일 저장 ==========
// 신규 ID 생성: rpt_YYYYMMDD_xxxxxx
function generateReportId() {
  const ts = new Date();
  const ymd = ts.getFullYear() +
    String(ts.getMonth() + 1).padStart(2, '0') +
    String(ts.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `rpt_${ymd}_${rand}`;
}

function reportsDirFor(userId) {
  // 미션 명세: uploads/portfolio-reports/<studentId>-<timestamp>.pdf
  //   ★ [W4] PORTFOLIO_REPORT_DIR 로 덮어쓸 수 있게 한다(기본값·평시 동작 완전 불변).
  //     테스트는 DB 를 임시 사본으로 격리하면서 **PDF 만 정본 디스크에 썼다** — 실행마다 3 개씩
  //     쌓여 1000+ 개의 고아 파일이 남았다(test/pdf-report-permission.test.js PDF-PERM-f 근거).
  //     test/_setup.js 의 setupTestDb() 와 스모크 webServer 가 이 env 를 임시 경로로 주입한다.
  //   ※ env 를 모듈 로드 시점이 아니라 **호출 시점**에 읽는다(주입 순서에 의존하지 않도록).
  const baseDir = process.env.PORTFOLIO_REPORT_DIR
    || path.join(process.cwd(), 'uploads', 'portfolio-reports');
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

// 메타데이터만 저장 (파일은 추후 PUT 또는 saveGeneratedReport 로 채움)
function createPortfolioReport(userId, body) {
  const id = generateReportId();
  const title = body.title || '포트폴리오 보고서';
  const opts = body.options || {};
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  const periodFrom = body.periodFrom || (body.period && body.period.from) || opts.periodStart || opts.from || null;
  const periodTo = body.periodTo || (body.period && body.period.to) || opts.periodEnd || opts.to || null;
  const schoolLevel = body.schoolLevel || opts.schoolLevel || null;
  const status = body.status || 'pending';
  const expires = body.expiresAt || null;
  const coverNote = body.coverNote || opts.coverNote || opts.studentNote || null;

  db.prepare(`
    INSERT INTO portfolio_reports
      (id, user_id, title, period_from, period_to, school_level,
       options_json, item_ids_json, file_path, file_size_kb, page_count,
       item_count, cover_note,
       status, share_token, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?)
  `).run(
    id, userId, title, periodFrom, periodTo, schoolLevel,
    JSON.stringify(opts), JSON.stringify(itemIds),
    null, body.fileSizeKb || null, body.pageCount || null,
    itemIds.length || null, coverNote,
    status, body.shareToken || null, expires
  );
  return getPortfolioReportById(id);
}

// 서버 사이드 PDF 파일을 직접 저장 (filePath 명시 가능)
function saveGeneratedReport(userId, reportId, { buffer, pageCount, filePath, itemCount, coverNote }) {
  const row = db.prepare('SELECT * FROM portfolio_reports WHERE id = ? AND user_id = ?').get(reportId, userId);
  if (!row) {
    const e = new Error('보고서를 찾을 수 없습니다.'); e.status = 404; throw e;
  }
  let outPath = filePath;
  if (!outPath) {
    const baseDir = reportsDirFor(userId);
    outPath = path.join(baseDir, `${reportId}.pdf`);
  }
  fs.writeFileSync(outPath, buffer);
  const sizeKb = Math.max(1, Math.round(buffer.length / 1024));
  db.prepare(`
    UPDATE portfolio_reports SET
      file_path = ?, file_size_kb = ?,
      page_count = COALESCE(?, page_count),
      item_count = COALESCE(?, item_count),
      cover_note = COALESCE(?, cover_note),
      status = 'ready'
    WHERE id = ? AND user_id = ?
  `).run(outPath, sizeKb, pageCount || null, itemCount || null, coverNote || null, reportId, userId);
  return getPortfolioReportById(reportId);
}

// PDF 파일 attach + 메타 갱신 (page_count/fileSize)
function attachPortfolioReportFile(userId, reportId, { buffer, pageCount, options, itemIds, title, periodFrom, periodTo, schoolLevel }) {
  const row = db.prepare('SELECT * FROM portfolio_reports WHERE id = ? AND user_id = ?').get(reportId, userId);
  if (!row) {
    const e = new Error('보고서를 찾을 수 없습니다.'); e.status = 404; throw e;
  }
  const baseDir = reportsDirFor(userId);
  const filePath = path.join(baseDir, `${reportId}.pdf`);
  fs.writeFileSync(filePath, buffer);
  const sizeKb = Math.max(1, Math.round(buffer.length / 1024));
  db.prepare(`
    UPDATE portfolio_reports SET
      file_path = ?, file_size_kb = ?, page_count = COALESCE(?, page_count),
      title = COALESCE(?, title),
      period_from = COALESCE(?, period_from),
      period_to = COALESCE(?, period_to),
      school_level = COALESCE(?, school_level),
      options_json = COALESCE(?, options_json),
      item_ids_json = COALESCE(?, item_ids_json),
      status = 'ready'
    WHERE id = ? AND user_id = ?
  `).run(
    filePath, sizeKb, pageCount || null,
    title || null, periodFrom || null, periodTo || null, schoolLevel || null,
    options ? JSON.stringify(options) : null,
    itemIds ? JSON.stringify(itemIds) : null,
    reportId, userId
  );
  return getPortfolioReportById(reportId);
}

function getPortfolioReportById(reportId) {
  const row = db.prepare('SELECT * FROM portfolio_reports WHERE id = ?').get(reportId);
  if (!row) return null;
  try { row.options = row.options_json ? JSON.parse(row.options_json) : null; } catch { row.options = null; }
  try { row.itemIds = row.item_ids_json ? JSON.parse(row.item_ids_json) : []; } catch { row.itemIds = []; }
  return row;
}

function getPortfolioReports(userId) {
  return db.prepare(`
    SELECT id, user_id, title, period_from, period_to, school_level,
           file_size_kb, page_count, status, created_at, expires_at
    FROM portfolio_reports
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(userId);
}

function deletePortfolioReport(userId, reportId) {
  const row = db.prepare('SELECT file_path FROM portfolio_reports WHERE id = ? AND user_id = ?').get(reportId, userId);
  if (!row) return null;
  if (row.file_path && fs.existsSync(row.file_path)) {
    try { fs.unlinkSync(row.file_path); } catch (_) {}
  }
  db.prepare('DELETE FROM portfolio_reports WHERE id = ? AND user_id = ?').run(reportId, userId);
  return { deleted: true };
}

// ========== 보고서 데이터 조립 (기획서 §7-1) ==========
function getPortfolioReportData(studentId, { from, to, schoolLevel, itemIds } = {}) {
  // 1) 학생 정보
  const student = db.prepare(`
    SELECT id, username, display_name, grade, class_number, school_name, profile_image_url
    FROM users WHERE id = ?
  `).get(studentId);
  if (!student) return null;

  // 학생의 학교급 (DB grade 기반)
  const studentLevel = gradeToSchoolLevel(student.grade);
  const effectiveLevel = schoolLevel || studentLevel || null;

  // 2) 통계 / 활동
  const itemsRes = getPortfolioItems(studentId, {
    from: from || null,
    to: to || null,
    schoolLevel: schoolLevel || null,
    page: 1,
    limit: 500
  });
  let items = itemsRes.items || [];
  if (Array.isArray(itemIds) && itemIds.length > 0) {
    const idSet = new Set(itemIds.map(x => parseInt(x, 10)));
    items = items.filter(it => idSet.has(it.id));
  }

  // 3) 통계 카드
  const totalActivities = items.length;
  const lifeTaskCount = items.filter(i => i.is_life_task).length;
  const reflectionCount = items.filter(i => i.reflection && String(i.reflection).trim()).length;
  const dateSet = new Set();
  items.forEach(i => { const d = i.activity_date || (i.created_at ? String(i.created_at).slice(0, 10) : null); if (d) dateSet.add(d); });
  const activeDays = dateSet.size;

  // 4) 6대 핵심역량 (실데이터 집계)
  const competencies = getCompetencyStats(studentId, { startDate: from, endDate: to });

  // 5) 6대 성장영역 (기존 student-report 활용 — 6축 재편본)
  const reportObj = getStudentReport(studentId, { startDate: from, endDate: to });
  const growthAreas = ['정서발달', '참여도', '성취수준', '진로탐색', '독서활동', '콘텐츠활용'].map(name => ({
    name,
    score: reportObj.areas?.[name]?.score ?? 0,
    hasData: !!reportObj.areas?.[name]?.hasData
  }));

  // 6) 타임라인 (월별 점)
  const timeline = items.map(i => ({
    id: i.id,
    date: i.activity_date || (i.created_at ? String(i.created_at).slice(0, 10) : null),
    subject: i.subject || '',
    title: i.activity_name || '',
    isLifeTask: !!i.is_life_task
  })).filter(t => t.date).sort((a, b) => a.date.localeCompare(b.date));

  // 7) 메시지 (마무리 페이지)
  const observations = db.prepare('SELECT observation_text FROM teacher_observations WHERE student_id = ? ORDER BY observation_date DESC LIMIT 1').get(studentId);
  const teacherNote = observations ? observations.observation_text : null;

  // 8) competencyTop3 라벨
  const sortedComps = [...competencies].sort((a, b) => b.score - a.score);
  const competencyTop3 = sortedComps.slice(0, 3).map(c => c.label);

  // 기간 라벨
  const periodLabel = (from && to)
    ? `${from} ~ ${to}`
    : (from ? `${from} ~ ` : (to ? ` ~ ${to}` : '전체 기간'));

  return {
    success: true,
    student: {
      id: student.id,
      username: student.username,
      displayName: student.display_name,
      school: student.school_name || '',
      grade: student.grade || null,
      classroom: student.class_number ? `${student.class_number}반` : '',
      avatarUrl: student.profile_image_url || null,
      avatarInitial: (student.display_name || '학').slice(0, 1),
      schoolLevel: studentLevel
    },
    period: {
      label: periodLabel,
      from: from || null,
      to: to || null,
      schoolLevel: effectiveLevel,
      schoolLevelLabel: schoolLevelLabel(effectiveLevel)
    },
    summary: {
      totalActivities,
      lifeTaskCount,
      reflectionCount,
      activeDays,
      competencyTop3
    },
    competencies,
    growthAreas,
    items,
    timeline,
    messages: {
      studentNote: null,
      teacherNote,
      parentNote: null
    }
  };
}

// 영역별 학기 목표(제목+영역+기한+진행률) — GROWTH_GOAL_SPEC
const GOAL_AREAS = ['정서발달', '참여도', '성취수준', '진로탐색', '독서활동', '콘텐츠활용'];

// 행 → 정본 계약 형태로 정규화 (과거 'N회 달성' 행도 폴백으로 구제)
function _normalizeGoal(r) {
  return {
    id: r.id,
    title: r.title || r.period_label || '',                 // 과거 행 폴백
    area: r.area || r.goal_type || null,
    deadline: r.deadline || null,
    progress: r.progress != null ? r.progress
              : (r.target_count > 0
                  ? Math.min(100, Math.round((r.current_count / r.target_count) * 100))
                  : 0),                                       // 구세대 환산 폴백
    status: r.status || ((r.progress >= 100) ? 'completed' : 'active'),
    description: r.description || null,
    created_at: r.created_at,
    updated_at: r.updated_at || r.created_at
  };
}

function getGrowthGoals(userId) {
  const rows = db.prepare(
    'SELECT * FROM growth_goals WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
  return rows.map(_normalizeGoal);
}

function createGrowthGoal(userId, data) {
  const title = (data.title || '').trim().slice(0, 60);
  if (!title) { const e = new Error('목표 제목을 입력하세요.'); e.status = 400; throw e; }
  const area = GOAL_AREAS.includes(data.area) ? data.area : '정서발달';
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(data.deadline || '') ? data.deadline : null;
  const description = ((data.description || '').trim().slice(0, 200)) || null;
  const info = db.prepare(`
    INSERT INTO growth_goals
      (user_id, title, area, deadline, progress, status, description,
       goal_type, target_count, current_count, period, period_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'active', ?,  ?, 100, 0, 'semester', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(userId, title, area, deadline, description, area /*goal_type 호환*/, title /*period_label 호환*/);
  return { id: info.lastInsertRowid };
}

// 부분 수정(진행률·제목·영역·기한·설명). 본인 소유만. progress>=100 → status=completed 자동 전환.
// 반환: 갱신된 정본 계약 goal | null(타인·없는 id)
function updateGrowthGoal(id, userId, patch) {
  const row = db.prepare('SELECT * FROM growth_goals WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;

  const sets = [];
  const args = [];

  if (patch.progress != null && patch.progress !== '') {
    let p = parseInt(patch.progress, 10);
    if (isNaN(p)) p = 0;
    p = Math.max(0, Math.min(100, p));
    sets.push('progress = ?'); args.push(p);
    sets.push('status = ?');   args.push(p >= 100 ? 'completed' : 'active');
  }
  if (typeof patch.title === 'string') {
    const t = patch.title.trim().slice(0, 60);
    if (t) { sets.push('title = ?'); args.push(t); sets.push('period_label = ?'); args.push(t); }
  }
  if (typeof patch.area === 'string' && GOAL_AREAS.includes(patch.area)) {
    sets.push('area = ?'); args.push(patch.area);
    sets.push('goal_type = ?'); args.push(patch.area);
  }
  if (patch.deadline !== undefined) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(patch.deadline || '') ? patch.deadline : null;
    sets.push('deadline = ?'); args.push(d);
  }
  if (patch.description !== undefined) {
    const desc = ((patch.description || '').trim().slice(0, 200)) || null;
    sets.push('description = ?'); args.push(desc);
  }

  if (sets.length) {
    sets.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE growth_goals SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...args, id, userId);
  }
  const updated = db.prepare('SELECT * FROM growth_goals WHERE id = ? AND user_id = ?').get(id, userId);
  return _normalizeGoal(updated);
}

// 삭제 — 본인 소유만. 반환: true(삭제됨) | false(타인·없는 id)
function deleteGrowthGoal(id, userId) {
  const info = db.prepare('DELETE FROM growth_goals WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

// ========== 포트폴리오 자동 추가 ==========

function autoAddPortfolioItem(userId, logData) {
  // 이미 같은 source_id로 등록된 항목이 있으면 중복 방지
  const existing = db.prepare(
    'SELECT id FROM portfolio_items WHERE user_id = ? AND source_type = ? AND source_id = ?'
  ).get(userId, logData.source_service || 'learning', logData.id);
  if (existing) return;

  db.prepare(`
    INSERT INTO portfolio_items
    (user_id, source_type, source_id, class_id, activity_name, subject,
     activity_date, score, result_type, activity_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    userId,
    logData.source_service || 'learning',
    logData.id,
    logData.class_id || null,
    logData.activity_name || logData.object_type || '학습 활동',
    logData.subject || null,
    new Date().toISOString().split('T')[0],
    logData.result_score != null ? String(logData.result_score) : null,
    logData.result_success ? 'completed' : 'attempted',
    logData.activity_type || 'activity'
  );
}

// ========== 성장보고서 6대 영역 ==========

function getClassDashboard(classId, teacherId, { period, startDate, endDate } = {}) {
  // 클래스 정보
  const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(classId);
  const className = cls ? cls.name : '';

  const members = db.prepare(`
    SELECT u.id, u.display_name, u.grade, u.class_number,
      (SELECT COUNT(*) FROM attendance WHERE class_id = ? AND user_id = u.id AND status = 'present') as attendance_count,
      (SELECT COUNT(*) FROM learning_logs WHERE class_id = ? AND user_id = u.id) as activity_count,
      (SELECT emotion FROM attendance WHERE class_id = ? AND user_id = u.id ORDER BY attendance_date DESC LIMIT 1) as latest_emotion
    FROM class_members cm JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.role = 'member' AND u.role = 'student'
    ORDER BY u.display_name
  `).all(classId, classId, classId, classId);

  // 각 학생의 6대 영역 점수 계산
  // (오늘의학습 요약은 하단 '오늘의 학습 현황'(getClassDailyLearning)을 그대로 사용하므로 별도 집계 불필요)
  const students = members.map(m => {
    const report = getStudentReport(m.id, { classId, startDate, endDate });
    return {
      id: m.id,
      studentId: m.id,
      display_name: m.display_name,
      studentName: m.display_name,
      grade: m.grade,
      class_number: m.class_number,
      attendance_count: m.attendance_count,
      activity_count: m.activity_count,
      // 최신 감정을 정본키로 정규화 (스펙 §7-4). alert 판정(L628·635)·FE 감정뱃지 분류가 정규화된 값을 보게 함.
      // very_bad/bad → sad 이므로 이상징후 alert이 자동 발동, soso → calm 으로 긍정 분류됨.
      latest_emotion: normEmotion(m.latest_emotion),
      averageScore: report.overallScore,
      areas: report.areas
    };
  });

  // 클래스 전체 평균 계산
  const studentCount = students.length;
  const avgScore = studentCount > 0 ? students.reduce((s, st) => s + (st.averageScore || 0), 0) / studentCount : 0;

  // 영역별 평균 (6축 — 설계서 §1·§3)
  // hasData=false 학생(성취수준 등)은 평균 산정에서 제외하여 레이더가 부당히 낮아지지 않게 함.
  const areaNames = ['정서발달', '참여도', '성취수준', '진로탐색', '독서활동', '콘텐츠활용'];
  const areas = {};
  areaNames.forEach(name => {
    const withData = students.filter(s => s.areas?.[name]?.hasData === true);
    const scores = withData.map(s => s.areas?.[name]?.score ?? 0);
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    areas[name] = {
      averageScore: scores.length > 0 ? Math.round(avg) : 0,
      completionRate: studentCount > 0 ? Math.round(withData.length / studentCount * 100) : 0,
      hasData: withData.length > 0,
      dataCount: withData.length
    };
  });

  // 서비스 미제공 영역 강제 0점 처리
  NO_SERVICE_AREAS.forEach(name => {
    if (areas[name]) {
      areas[name].averageScore = 0;
      areas[name].completionRate = 0;
      areas[name].hasData = false;
    }
  });

  // 완료율 (활동이 1건 이상인 학생 비율)
  const activeStudents = students.filter(s => s.activity_count > 0).length;
  const completionRate = studentCount > 0 ? Math.round(activeStudents / studentCount * 100) : 0;

  // 관찰 기록 수
  const obsCount = db.prepare('SELECT COUNT(*) as cnt FROM teacher_observations WHERE class_id = ?').get(classId)?.cnt || 0;

  // 관심 필요 학생 (클래스 평균 대비 상대 기준)
  const avgActivity = studentCount > 0
    ? students.reduce((s, st) => s + st.activity_count, 0) / studentCount
    : 0;

  const attentionStudents = students.filter(s => {
    // 조건 1: 클래스 평균의 30% 이하 활동 (또는 3건 미만 중 작은 값)
    if (s.activity_count < Math.min(avgActivity * 0.3, 3)) return true;
    // 조건 2: 최근 부정 감정
    if (s.latest_emotion === 'sad' || s.latest_emotion === 'angry') return true;
    // 조건 3: 클래스 평균의 50% 미만 점수
    if (s.averageScore != null && s.averageScore < avgScore * 0.5) return true;
    return false;
  }).map(s => {
    let reason = '';
    let severity = 'medium';
    if (s.latest_emotion === 'sad' || s.latest_emotion === 'angry') {
      reason = '최근 감정 상태 주의';
      severity = 'high';
    } else if (s.averageScore != null && s.averageScore < avgScore * 0.5) {
      reason = '성장 점수 저조';
      severity = 'high';
    } else {
      reason = '학습 활동 부족';
    }
    return { studentId: s.id, studentName: s.display_name, level: severity === 'high' ? 'danger' : 'warning', message: reason, severity };
  });

  // 클래스 전체 콘텐츠 활용 통계 — 스펙 #2: class_id 스코프 + 기간(startDate/endDate) 필터 추가.
  //  기존엔 멤버 IN 만 걸려 멤버의 "타 클래스·전 기간" 활동까지 합산되어 현황이 부풀려졌다.
  //  → 이 클래스(class_id = classId)의 활동만, 기간 지정 시 그 기간만 집계한다.
  //  (멤버가 다른 클래스에서 한 활동·기간 밖 활동은 제외 → 매트릭스/상단 메트릭과 정합.)
  const memberIds = members.map(m => m.id);
  let contentUsage = { byType: [], byService: [], totalActivities: 0, uniqueContents: 0 };
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => '?').join(',');
    const cuClassFilter = ' AND class_id = ?';
    const cuDateFilter = (startDate && endDate) ? ' AND DATE(created_at) BETWEEN ? AND ?' : '';
    const cuDateParams = (startDate && endDate) ? [startDate, endDate] : [];
    // 공통 스코프 파라미터: memberIds..., classId, [startDate, endDate]
    contentUsage.byType = db.prepare(`
      SELECT activity_type, COUNT(*) as cnt, AVG(CAST(result_score AS REAL)) as avg_score
      FROM learning_logs WHERE user_id IN (${placeholders})${cuClassFilter}${cuDateFilter}
      GROUP BY activity_type ORDER BY cnt DESC
    `).all(...memberIds, classId, ...cuDateParams);
    contentUsage.byService = db.prepare(`
      SELECT source_service, COUNT(*) as cnt
      FROM learning_logs WHERE user_id IN (${placeholders})${cuClassFilter} AND source_service IS NOT NULL AND source_service != ''${cuDateFilter}
      GROUP BY source_service ORDER BY cnt DESC
    `).all(...memberIds, classId, ...cuDateParams);
    const totals = db.prepare(`
      SELECT COUNT(*) as total, COUNT(DISTINCT object_id) as unique_contents
      FROM learning_logs WHERE user_id IN (${placeholders})${cuClassFilter}${cuDateFilter}
    `).get(...memberIds, classId, ...cuDateParams);
    contentUsage.totalActivities = totals?.total || 0;
    contentUsage.uniqueContents = totals?.unique_contents || 0;
  }

  // 요일별 감정 통계 (실제 attendance 데이터 기반)
  let emotionDateFilter = '';
  const emotionDateParams = [classId];
  if (startDate && endDate) {
    emotionDateFilter = ' AND attendance_date BETWEEN ? AND ?';
    emotionDateParams.push(startDate, endDate);
  }
  // 요일×감정별 원시 카운트를 가져와 JS에서 정본키로 정규화 후 긍정비율 산출 (스펙 §7-4).
  // SQL의 emotion IN (...)로는 very_bad/bad(→sad 부정)·soso(→calm 긍정)를 못 가리므로 JS 집계로 전환.
  const weekdayEmotionRows = db.prepare(`
    SELECT CAST(strftime('%w', attendance_date) AS INTEGER) as weekday,
      emotion, COUNT(*) as cnt
    FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${emotionDateFilter}
    GROUP BY weekday, emotion
  `).all(...emotionDateParams);
  const POSITIVE_EMOTIONS = new Set(['happy', 'excited', 'good', 'great', 'calm']);
  // 요일별 [positive, total] 누적 (sqlite %w 인덱스 0=일~6=토 기준)
  const weekdayAgg = Array.from({ length: 7 }, () => ({ positive: 0, total: 0 }));
  weekdayEmotionRows.forEach(w => {
    const norm = normEmotion(w.emotion);
    const bucket = weekdayAgg[w.weekday];
    bucket.total += w.cnt;
    if (POSITIVE_EMOTIONS.has(norm)) bucket.positive += w.cnt;
  });
  const weekdayPositiveRates = [0, 0, 0, 0, 0, 0, 0]; // 월~일
  weekdayAgg.forEach((b, w) => {
    // sqlite %w: 0=일, 1=월, ..., 6=토 → 배열 인덱스: 0=월, ..., 5=토, 6=일
    const idx = (w + 6) % 7;
    if (b.total > 0) {
      weekdayPositiveRates[idx] = Math.round(b.positive / b.total * 100);
    }
  });

  // 감정별 전체 통계 — 정본키로 정규화 + 동일키 합산 + cnt desc 재정렬 (스펙 §7-4)
  // 예: soso 2건 + calm 33건 → calm 35건. 태그클라우드 "❓ 기타" 유입 차단.
  const emotionCounts = normalizeEmotionCounts(db.prepare(`
    SELECT emotion, COUNT(*) as cnt FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${emotionDateFilter}
    GROUP BY emotion ORDER BY cnt DESC
  `).all(...emotionDateParams));

  // 일별 평균 감정 체크인 인원 — 기간 내 각 날짜의 distinct user 수 평균 (1자리 반올림)
  const dailyEmotionRows = db.prepare(`
    SELECT attendance_date, COUNT(DISTINCT user_id) as members
    FROM attendance
    WHERE class_id = ? AND emotion IS NOT NULL ${emotionDateFilter}
    GROUP BY attendance_date
  `).all(...emotionDateParams);
  const dailyAvgCheckinMembers = dailyEmotionRows.length > 0
    ? Math.round(dailyEmotionRows.reduce((a, r) => a + r.members, 0) / dailyEmotionRows.length * 10) / 10
    : 0;
  const checkinDays = dailyEmotionRows.length;

  // 오늘의학습 클래스 요약 — 하단 '오늘의 학습 현황' 요약(getClassDailyLearning.summary)과
  // 동일 의미·방식으로 산출하여 상단 메트릭 카드 ↔ 하단 요약의 정합성 보장.
  // (학년 매칭된 세트 분모로 학생별 참여율을 산출 후 평균. 참여 안 한 학생도 모집단에 포함.)
  // 스펙 #3: startDate/endDate 를 받으면 그 기간으로 산출(FE 가 매트릭스와 동일 기간 전달).
  //  날짜 없을 때 폴백은 매트릭스 기본(상단 월선택 기준)과 합치 → getClassDailyLearning 에 period='monthly'
  //  로 위임하여 "현재 월" 동일 범위를 쓰게 한다(과거: 전기간 min~max → 매트릭스(현재월)와 불일치).
  let dailyRange;
  if (startDate && endDate) {
    dailyRange = { startDate, endDate };
  } else {
    // 폴백: getClassDailyLearning 내부 monthly 기본(현재 월 1일~말일)에 위임 → 매트릭스와 동일 기간.
    dailyRange = { period: 'monthly' };
  }
  let dailyLearning;
  try {
    const cd = getClassDailyLearning(classId, dailyRange);
    const s = cd.summary || {};
    // 일별 평균 참여 인원 — 세트가 있는 날짜에서 그 날 participated된 학생 수의 평균
    const setDateSet = new Set((cd.sets || []).map(st => st.targetDate));
    const dailyLearnRows = (cd.dates || [])
      .filter(d => setDateSet.has(d))
      .map(d => ({
        d,
        cnt: (cd.students || []).filter(st => st.daily && st.daily[d] && st.daily[d].participated).length
      }));
    const dailyAvgParticipants = dailyLearnRows.length > 0
      ? Math.round(dailyLearnRows.reduce((a, r) => a + r.cnt, 0) / dailyLearnRows.length * 10) / 10
      : 0;
    const learnDays = dailyLearnRows.length;
    dailyLearning = {
      avgCompletionRate: s.avgCompletionRate != null ? s.avgCompletionRate : 0,
      avgAccuracy: s.avgAccuracy, // null 허용 (점수 있는 학생 없으면 null)
      maxStreak: s.maxStreak || 0,
      maxStreakHolders: s.maxStreakHolders || [],
      participantCount: (cd.students || []).filter(st => st.participationRate > 0).length,
      studentCount: (cd.students || []).length,
      dailyAvgParticipants,
      learnDays,
      hasData: !!s.hasData
    };
  } catch (err) {
    console.error('dailyLearning summary failed:', err);
    dailyLearning = { avgCompletionRate: 0, avgAccuracy: null, maxStreak: 0, maxStreakHolders: [], participantCount: 0, studentCount: members.length, dailyAvgParticipants: 0, learnDays: 0, hasData: false };
  }

  return {
    className,
    studentCount,
    averageScore: Math.round(avgScore),
    completionRate,
    observationCount: obsCount,
    areas,
    students,
    attentionStudents,
    alerts: attentionStudents,
    contentUsage,
    dailyLearning,
    emotionStats: { weekdayPositiveRates, emotionCounts, dailyAvgCheckinMembers, checkinDays }
  };
}

// ========== 6축 성장 분포 공통 헬퍼 (설계서 §1·§8) ==========
// 정서발달·참여도·성취수준·진로탐색·독서활동·콘텐츠활용 6축을 한 곳에서 산출.
// getStudentReport·getClassDashboard 양쪽이 이 헬퍼를 호출해 두 화면 자동 일관.
// 각 축은 { score, hasData, ...meta } 형태. 비율은 분모>0 ? Math.min(100,...) : null, 평균은 가용 항목만.
function computeAreas6(studentId, { classId, startDate, endDate } = {}) {
  const hasRange = !!(startDate && endDate);
  // 기간 BETWEEN off-by-one 방지 헬퍼: DATE(col) 로 정규화하여 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS'
  // 양쪽 저장 포맷 모두 종료일 당일 datetime 데이터를 포함시킨다(스펙 #6).
  // 사용 예) `AND ${rangeClause('completed_at')}` + params.push(...rangeParams())
  const rangeClause = (col) => `DATE(${col}) BETWEEN ? AND ?`;
  const rangeParams = () => [startDate, endDate];

  // ── 축 1: 정서발달 (긍정 감정 비율) ──
  // 두 감정 소스 통합(도메인 §3·§10): attendance(채움클래스 감정출석부) ∪ emotion_checkins(스스로채움 마음채움).
  //  · attendance: 다중클래스 학생은 같은 날 N행 → DISTINCT(user_id,d,emotion,reason,score,src)로 1일 1표 정규화(비율 왜곡 방지).
  //                classId 지정 시 그 클래스만(AND class_id=?). 미지정(학생 본인 전체)이면 모든 클래스.
  //  · emotion_checkins: 학생 단위(class_id 없음) → classId가 있어도 항상 전체 포함(클래스 독립).
  //  · 기간(hasRange)은 양쪽 동일 DATE(...) BETWEEN ? AND ?.
  //  · attendance↔self 같은 날 같은 감정이 양쪽 다 있으면 둘 다 카운트 = 독립 신호로 인정(도메인 §4 권장(B)).
  const buildEmotionUnion = () => {
    const params = [];
    let attWhere = 'WHERE user_id = ? AND emotion IS NOT NULL';
    params.push(studentId);
    if (classId) { attWhere += ' AND class_id = ?'; params.push(classId); }
    if (hasRange) { attWhere += ` AND ${rangeClause('attendance_date')}`; params.push(...rangeParams()); }
    let chkWhere = 'WHERE user_id = ? AND emotion IS NOT NULL';
    params.push(studentId);
    if (hasRange) { chkWhere += ` AND ${rangeClause('checkin_date')}`; params.push(...rangeParams()); }
    const sql = `
      SELECT DISTINCT user_id, DATE(attendance_date) d, emotion, emotion_reason, emotion_score, 'class' src
        FROM attendance ${attWhere}
      UNION ALL
      SELECT user_id, DATE(checkin_date) d, emotion, emotion_reason, emotion_score, 'self' src
        FROM emotion_checkins ${chkWhere}
    `;
    return { sql, params };
  };
  // 정본키로 정규화 후 합산 (스펙 §7-4). soso→calm(긍정)·very_bad/bad→sad(부정) 정확 분류.
  const emoUnion = buildEmotionUnion();
  const emoUnionRows = db.prepare(emoUnion.sql).all(...emoUnion.params);
  const emoRows = normalizeEmotionCounts(emoUnionRows.map(r => ({ emotion: r.emotion, cnt: 1 })));
  const emotionTotal = emoRows.reduce((s, e) => s + e.cnt, 0);
  const positiveCnt = emoRows
    .filter(e => ['happy', 'excited', 'good', 'great', 'calm'].includes(e.emotion))
    .reduce((s, e) => s + e.cnt, 0);
  const emotionScore = emotionTotal > 0 ? Math.round(positiveCnt / emotionTotal * 100) : 0;

  // ── 축 2: 참여도 (과제·평가·오늘학습·수업 4지표 가용 평균) ──
  // 클래스 범위 분기:
  //  - classId 있음(교사가 특정 클래스에서 학생 조회): 그 클래스만(class_id = ?).
  //  - classId 없음(학생 본인 전체 리포트): "성장 리포트는 학생이 속한 모든 클래스의 기록을 모아서 보여주는 곳"(사용자 정책).
  //    학생이 'member'(학생)로 가입한 모든 클래스를 합산. 본인이 owner로 개설한 클래스는 과제를 받는 입장이 아니므로 제외.
  // 스펙 #6: clamp 는 {rate,denom,numer} 를 반환한다.
  //  - denom==0(미배정) → rate=null  (분모 없음 = 평가 불가)
  //  - denom>0 & numer==0(미참여) → rate=0 (FE 배지로 "미참여" 표시. 단 평균 산정에서는 제외)
  //  - denom>0 & numer>0 → rate=round(numer/denom*100) clamp 100
  const clamp = (n, d) => ({
    rate: d > 0 ? Math.min(100, Math.round((n / d) * 100)) : null,
    denom: d,
    numer: n
  });
  let participation = {
    homework: { rate: null, denom: 0, numer: 0 },
    exam: { rate: null, denom: 0, numer: 0 },
    daily: { rate: null, denom: 0, numer: 0 },
    lesson: { rate: null, denom: 0, numer: 0 }
  };
  let participationScore = 0;
  let participationHasData = false;
  {
    // 클래스 IN 절 + 그에 대응하는 파라미터를 만든다.
    //  - classId 지정: `class_id = ?` (단일, 기존과 동일 → 교사 시점 회귀 방지)
    //  - 미지정: `class_id IN (학생으로 속한 클래스들)` — class_members.role='member'(owner 제외) AND status='active',
    //           추가 안전장치로 본인 owner 클래스(classes.owner_id) 명시 제외.
    const buildClassFilter = (col) => {
      if (classId) return { clause: `${col} = ?`, params: [classId] };
      return {
        clause: `${col} IN (
          SELECT cm.class_id FROM class_members cm
          WHERE cm.user_id = ? AND cm.role = 'member' AND cm.status = 'active'
            AND cm.class_id NOT IN (SELECT id FROM classes WHERE owner_id = ?)
        )`,
        params: [studentId, studentId]
      };
    };
    // 분모·분자 모두 동일 기간 + 동일 클래스 범위로 필터(스펙 #1·#4): 기간 내 생성/배정된 과제·평가·세트·수업 대비
    // 그 기간 내 제출·응시·완료. hasRange 아니면 전체. 종료일 off-by-one 은 DATE() 정규화로 해소(#6).
    // 분모: 배정/생성 시점 컬럼(created_at / target_date) 기준.
    const dD = hasRange ? rangeParams() : [];
    const hwF = buildClassFilter('class_id');
    const hwD = db.prepare(`SELECT COUNT(*) as c FROM homework WHERE ${hwF.clause}${hasRange ? ` AND ${rangeClause('created_at')}` : ''}`).get(...hwF.params, ...dD).c;
    const hwNF = buildClassFilter('h.class_id');
    const hwN = db.prepare(`
      SELECT COUNT(DISTINCT h.id) as c FROM homework h
      JOIN homework_submissions s ON s.homework_id = h.id AND s.student_id = ?
      WHERE ${hwNF.clause} AND s.status IN ('submitted','graded')${hasRange ? ` AND ${rangeClause('s.submitted_at')}` : ''}
    `).get(studentId, ...hwNF.params, ...dD).c;
    const exF = buildClassFilter('class_id');
    const exD = db.prepare(`SELECT COUNT(*) as c FROM exams WHERE ${exF.clause}${hasRange ? ` AND ${rangeClause('created_at')}` : ''}`).get(...exF.params, ...dD).c;
    const exNF = buildClassFilter('e.class_id');
    const exN = db.prepare(`
      SELECT COUNT(DISTINCT e.id) as c FROM exams e
      JOIN exam_students es ON es.exam_id = e.id AND es.user_id = ?
      WHERE ${exNF.clause} AND es.status = 'submitted'${hasRange ? ` AND ${rangeClause('es.submitted_at')}` : ''}
    `).get(studentId, ...exNF.params, ...dD).c;
    const dlF = buildClassFilter('class_id');
    const dlD = db.prepare(`SELECT COUNT(*) as c FROM daily_learning_sets WHERE ${dlF.clause}${hasRange ? ` AND ${rangeClause('target_date')}` : ''}`).get(...dlF.params, ...dD).c;
    const dlNF = buildClassFilter('class_id');
    const dlN = db.prepare(`
      SELECT COUNT(DISTINCT set_id) as c FROM daily_learning_progress
      WHERE user_id = ? AND status = 'completed'${hasRange ? ` AND ${rangeClause('completed_at')}` : ''}
        AND set_id IN (SELECT id FROM daily_learning_sets WHERE ${dlNF.clause})
    `).get(studentId, ...dD, ...dlNF.params).c;
    const lsF = buildClassFilter('class_id');
    const lsD = db.prepare(`SELECT COUNT(*) as c FROM lessons WHERE ${lsF.clause}${hasRange ? ` AND ${rangeClause('created_at')}` : ''}`).get(...lsF.params, ...dD).c;
    // 수업 이수: lesson_self_check(수업 후 학생 셀프 체크) DISTINCT lesson_id 기반.
    // 단순 조회(lesson_view)가 아니라 "수업을 듣고 셀프 점검까지 한 수업"을 이수로 간주.
    const lsNF = buildClassFilter('class_id');
    const lsN = db.prepare(`
      SELECT COUNT(DISTINCT lesson_id) as c FROM lesson_self_check
      WHERE user_id = ? AND ${lsNF.clause}${hasRange ? ` AND ${rangeClause('created_at')}` : ''}
    `).get(studentId, ...lsNF.params, ...dD).c;
    participation = {
      homework: clamp(hwN, hwD),
      exam: clamp(exN, exD),
      daily: clamp(dlN, dlD),
      lesson: clamp(lsN, lsD)
    };
    // 스펙 #6: 미참여(denom>0 & numer=0) 지표는 평균에서 제외(null 처럼 취급).
    //  avail = 분모>0 & 분자>0 인 지표만 → 그 rate 들의 평균.
    //  예) id3: homework 67(12/18) · exam 53(9/17) · daily 0(0/7) · lesson 0(0/31)
    //      → 기존: (67+53+0+0)/4 = 30, 개정: daily/lesson 제외 → (67+53)/2 = 60.
    //  모두 미참여여도 분모(denom)가 있으면 hasData=true (참여 기회는 있었으나 미참여 = 측정 대상).
    const avail = Object.values(participation).filter(p => p.denom > 0 && p.numer > 0);
    participationHasData = (hwD > 0 || exD > 0 || dlD > 0 || lsD > 0);
    participationScore = avail.length > 0
      ? Math.round(avail.reduce((a, p) => a + p.rate, 0) / avail.length)
      : 0;
  }

  // ── 축 3: 성취수준 (정답률) — 정답률 출처별 6종 구분 (스펙: 성취수준_출처별6종_재구성) ──
  // 6출처: today_learning / ai_learning / wrong_note / content / class_exam / cbt_exam
  // 각 출처 {correct,total} → rate = total>0 ? round(correct/total*100) : null (응시·전부오답=0, 미응시=null)
  // 기간 필터(#2): 각 테이블 날짜 컬럼 기준, DATE() 정규화로 종료일 off-by-one 해소(#6).
  const accD = hasRange ? rangeParams() : [];

  // 1) today_learning — daily_learning_progress 가 정본(중복 집계 방지: problem_attempts 에는 today_learning 미기록)
  const dlAcc = db.prepare(`
    SELECT SUM(correct_count) as cc, SUM(total_questions) as tq
    FROM daily_learning_progress WHERE user_id = ? AND status = 'completed'${hasRange ? ` AND ${rangeClause('completed_at')}` : ''}
  `).get(studentId, ...accD);

  // 진단평가(diagnosis_sessions) — ai_learning 합산 및 진단 타일에 사용
  const diAcc = db.prepare(`
    SELECT SUM(correct_count) as cc, SUM(total_questions) as tq
    FROM diagnosis_sessions WHERE user_id = ? AND status = 'completed'${hasRange ? ` AND ${rangeClause('completed_at')}` : ''}
  `).get(studentId, ...accD);

  // problem_attempts 를 source_type 별로 집계 (submitted_at 기준)
  const paBy = db.prepare(`
    SELECT source_type as st, SUM(is_correct) as cc, COUNT(*) as tq
    FROM problem_attempts
    WHERE user_id = ?${hasRange ? ` AND ${rangeClause('submitted_at')}` : ''}
    GROUP BY source_type
  `).all(studentId, ...accD);
  const paMap = {};
  for (const r of paBy) paMap[r.st || 'content'] = { cc: r.cc || 0, tq: r.tq || 0 };
  const paAi  = paMap['ai_learning'] || { cc: 0, tq: 0 };
  const paCon = paMap['content']     || { cc: 0, tq: 0 };
  const paWn  = paMap['wrong_note']  || { cc: 0, tq: 0 };

  // 평가: exam_students.score(0~100) → 문항수 가중 환산. 감독(CBT)/일반 분리.
  // 클래스 스코프: classId 있으면 그 클래스만, 없으면(학생 본인 전체 리포트) 전체 클래스 합산(#3, 참여도 정책과 동일).
  // 감독/일반 분리 기준: exams.start_mode = 'waiting' → 감독(CBT) 대기실 시작 흐름 = cbt_exam,
  //   그 외('direct' 등) → 일반 클래스 평가 = class_exam. (tab_detection 은 전 평가 기본 1 이라 변별 불가)
  const exClassClause = classId ? ' AND e.class_id = ?' : '';
  const examAccBy = (cbt) => db.prepare(`
    SELECT
      COALESCE(SUM(es.score * COALESCE(e.question_count, 0) / 100.0), 0) as cc,
      COALESCE(SUM(COALESCE(e.question_count, 0)), 0) as tq
    FROM exam_students es JOIN exams e ON es.exam_id = e.id
    WHERE es.user_id = ? AND es.status = 'submitted' AND es.score IS NOT NULL
      AND ${cbt ? "e.start_mode = 'waiting'" : "COALESCE(e.start_mode,'direct') != 'waiting'"}${exClassClause}${hasRange ? ` AND ${rangeClause('es.submitted_at')}` : ''}
  `).get(studentId, ...(classId ? [classId] : []), ...accD);
  const exClass = examAccBy(false);
  const exCbt   = examAccBy(true);

  // 6출처 {correct,total} 구성. exam 의 correct 는 가중 환산값(소수 → 반올림 1자리 후 정수 표기는 rate 계산에 원본 사용)
  const mkSrc = (cc, tq) => {
    const total = Math.round(tq || 0);
    const correct = Math.round(cc || 0);
    const rate = (tq && tq > 0) ? Math.round((cc / tq) * 100) : null;
    return { correct, total, rate };
  };
  const bySource = {
    today_learning: mkSrc(dlAcc?.cc, dlAcc?.tq),
    ai_learning:    mkSrc((diAcc?.cc || 0) + paAi.cc, (diAcc?.tq || 0) + paAi.tq),
    wrong_note:     mkSrc(paWn.cc, paWn.tq),
    content:        mkSrc(paCon.cc, paCon.tq),
    class_exam:     mkSrc(exClass?.cc, exClass?.tq),
    cbt_exam:       mkSrc(exCbt?.cc, exCbt?.tq)
  };

  // donutScore: 평가류 중심 문항수 가중평균(오답노트 제외) — §5.1
  const donutCC = (dlAcc?.cc || 0) + (diAcc?.cc || 0) + paAi.cc + paCon.cc + (exClass?.cc || 0) + (exCbt?.cc || 0);
  const donutTQ = (dlAcc?.tq || 0) + (diAcc?.tq || 0) + paAi.tq + paCon.tq + (exClass?.tq || 0) + (exCbt?.tq || 0);
  const donutScore = donutTQ > 0 ? Math.round((donutCC / donutTQ) * 100) : 0;

  // 도넛 하단 3타일(§5.3): 자기주도 / 클래스평가 / 진단
  const sdCC = (dlAcc?.cc || 0) + (diAcc?.cc || 0) + paAi.cc + paCon.cc + paWn.cc;
  const sdTQ = (dlAcc?.tq || 0) + (diAcc?.tq || 0) + paAi.tq + paCon.tq + paWn.tq;
  const ceCC = (exClass?.cc || 0) + (exCbt?.cc || 0);
  const ceTQ = (exClass?.tq || 0) + (exCbt?.tq || 0);
  const tiles = {
    self_directed: mkSrc(sdCC, sdTQ),
    class_eval:    mkSrc(ceCC, ceTQ),
    diagnosis:     mkSrc(diAcc?.cc, diAcc?.tq)
  };

  // hasData: 6출처 total 합계 > 0 (스펙 §7-1). donutScore 분모와 별개로 wrong_note 포함 전체 응시 여부 기준.
  const totalAllTQ = Object.values(bySource).reduce((s, o) => s + (o.total || 0), 0);
  const achievementHasData = totalAllTQ > 0;
  const achievementScore = donutScore;  // score = donutScore (하위호환 동일값, 스펙 §7)

  // 하위호환 키(daily/diagnosis/problem/problemBreakdown) 병행 유지 — FE 미수정 구간 안전.
  // problem = (content + ai_learning problem_attempts + 평가) 합산 정답률 — 기존 의미 근사 유지.
  const legacyPaCC = paAi.cc + paCon.cc;
  const legacyPaTQ = paAi.tq + paCon.tq;
  const legacyCombCC = legacyPaCC + ceCC;
  const legacyCombTQ = legacyPaTQ + ceTQ;
  const achievement = {
    bySource,
    tiles,
    donutScore,
    // ↓ 하위호환
    daily: bySource.today_learning.rate,
    diagnosis: tiles.diagnosis.rate,
    problem: legacyCombTQ > 0 ? Math.round((legacyCombCC / legacyCombTQ) * 100) : null,
    problemBreakdown: {
      contentItems: legacyPaTQ,
      contentCorrect: legacyPaCC,
      examQuestions: ceTQ,
      examCorrect: Math.round(ceCC * 10) / 10
    }
  };

  // ── 축 4: 진로탐색 (기존 유지) ──
  const careerDateFilter = hasRange ? ` AND ${rangeClause('activity_date')}` : '';
  const careerParams = hasRange ? [studentId, startDate, endDate] : [studentId];
  const careerLogCount = db.prepare(`
    SELECT COUNT(*) as c FROM career_logs WHERE user_id = ? ${careerDateFilter}
  `).get(...careerParams).c;
  const interestAreaCount = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT interest_area FROM career_logs
      WHERE user_id = ? AND interest_area IS NOT NULL AND interest_area != '' ${careerDateFilter}
      GROUP BY interest_area
    )
  `).get(...careerParams).c;
  const careerScore = Math.min(interestAreaCount * 20 + careerLogCount * 15, 100);

  // ── 축 5: 독서활동 (기존 유지) ──
  const readDateFilter = hasRange ? ` AND ${rangeClause('created_at')}` : '';
  const readParams = hasRange ? [studentId, startDate, endDate] : [studentId];
  const bookCount = db.prepare(`
    SELECT COUNT(*) as c FROM reading_logs WHERE user_id = ? ${readDateFilter}
  `).get(...readParams).c;
  const readingScore = bookCount === 0 ? 0 :
    bookCount <= 2 ? bookCount * 20 :
    bookCount <= 5 ? 40 + (bookCount - 2) * 15 :
    Math.min(85 + (bookCount - 5) * 5, 100);

  // ── 축 6: 콘텐츠 활용 (4신호 통합 가중 합산) — 스펙 #4 ──
  // 기존 단일소스(learning_logs content_view/lesson_view)는 소비 신호 하나뿐이라 콘텐츠를 "생산만" 한
  // 학생(업로드 N·보관 N)이 0점/hasData=false 로 떨어져 카드(업로드10 표시)와 축이 모순됐다.
  // → 소비·완료·평가·생산/큐레이션 4신호를 distinct content 기준으로 모아 가중 합산한 weightedCount 를
  //   기존 임계(9/29/59/99)로 구간화한다. hasData = 4신호 중 하나라도 > 0.
  //   기간(hasRange)·classId 스코프는 기존 패턴(learning_logs class_id 필터) 적용.
  const contentDateFilter = hasRange ? ` AND ${rangeClause('created_at')}` : '';
  const contentClassFilter = classId ? ' AND class_id = ?' : '';
  const contentClassParam = classId ? [classId] : [];

  // (1) 소비: learning_logs content_view/lesson_view 의 distinct object_id
  //          ∪ content_progress 의 distinct content_id (조회·진행 모두 "소비"로 인정)
  const llViewedRows = db.prepare(`
    SELECT DISTINCT object_id AS cid FROM learning_logs
    WHERE user_id = ? AND activity_type IN ('content_view','lesson_view')
      AND object_id IS NOT NULL AND object_id != ''${contentClassFilter}${contentDateFilter}
  `).all(studentId, ...contentClassParam, ...(hasRange ? rangeParams() : [])).map(r => String(r.cid));
  // content_progress 는 class_id 컬럼이 없어 학생 단위(클래스 독립). distinct content_id.
  const cpDateFilter = hasRange ? ` AND ${rangeClause('updated_at')}` : '';
  const cpViewedRows = db.prepare(`
    SELECT DISTINCT content_id AS cid FROM content_progress
    WHERE user_id = ? AND content_id IS NOT NULL${cpDateFilter}
  `).all(studentId, ...(hasRange ? rangeParams() : [])).map(r => 'cp:' + r.cid);
  const viewed = new Set([...llViewedRows, ...cpViewedRows]).size;

  // (2) 완료: content_progress completed=1 의 distinct content_id (가중 ×1.5)
  const completed = db.prepare(`
    SELECT COUNT(DISTINCT content_id) as c FROM content_progress
    WHERE user_id = ? AND completed = 1${cpDateFilter}
  `).get(studentId, ...(hasRange ? rangeParams() : [])).c;

  // (3) 평가: content_attempts 의 distinct content_id (가중 ×1.5)
  const caDateFilter = hasRange ? ` AND ${rangeClause('attempted_at')}` : '';
  const attempted = db.prepare(`
    SELECT COUNT(DISTINCT content_id) as c FROM content_attempts
    WHERE user_id = ?${caDateFilter}
  `).get(studentId, ...(hasRange ? rangeParams() : [])).c;

  // (4) 생산: contents(creator) — 내가 올린 콘텐츠 수 (created_at)
  const produced = db.prepare(`
    SELECT COUNT(*) as c FROM contents WHERE creator_id = ?${hasRange ? ` AND ${rangeClause('created_at')}` : ''}
  `).get(studentId, ...(hasRange ? rangeParams() : [])).c;
  // (4) 큐레이션: content_collections(보관) + channel_subscriptions(구독) 합 (가중 ×0.5 with produced)
  const collected = db.prepare(`
    SELECT COUNT(*) as c FROM content_collections WHERE user_id = ?${hasRange ? ` AND ${rangeClause('created_at')}` : ''}
  `).get(studentId, ...(hasRange ? rangeParams() : [])).c;
  const subscribed = db.prepare(`
    SELECT COUNT(*) as c FROM channel_subscriptions WHERE subscriber_id = ?${hasRange ? ` AND ${rangeClause('subscribed_at')}` : ''}
  `).get(studentId, ...(hasRange ? rangeParams() : [])).c;
  const curated = collected + subscribed; // 큐레이션 합산

  // 가중 합산: 소비 ×1.0, 완료 ×1.5, 평가 ×1.5, 생산·큐레이션 ×0.5
  const weightedCount = Math.round(
    viewed * 1.0 + completed * 1.5 + attempted * 1.5 + (produced + curated) * 0.5
  );
  // 구간화 — 기존 임계(9/29/59/99) 유지
  const contentScore = weightedCount === 0 ? 0 :
    weightedCount <= 9 ? 30 :
    weightedCount <= 29 ? 50 :
    weightedCount <= 59 ? 70 :
    weightedCount <= 99 ? 85 : 100;
  // hasData: 4신호 중 하나라도 > 0
  const contentHasData = (viewed > 0 || completed > 0 || attempted > 0 || (produced + curated) > 0);

  return {
    '정서발달':   { score: emotionScore, hasData: emotionTotal > 0, emotionTotal, trend: '' },
    '참여도':     { score: participationScore, hasData: participationHasData, participation, trend: '' },
    '성취수준':   { score: achievementScore, donutScore: achievement.donutScore, hasData: achievementHasData, achievement, trend: '' },
    '진로탐색':   { score: careerScore, hasData: careerLogCount > 0, interestAreaCount, careerLogCount, trend: '' },
    '독서활동':   { score: readingScore, hasData: bookCount > 0, bookCount, trend: '' },
    '콘텐츠활용': {
      score: contentScore,
      hasData: contentHasData,
      contentScore,
      weightedCount,
      // 데이터계약(스펙 #4): signals = 4신호 distinct/카운트. FE 카드가 완료N·퀴즈N 등 노출에 사용.
      signals: { viewed, completed, attempted, produced, curated },
      trend: ''
    }
  };
}

// ========== 참여도 활동유형 실제 원천 카운트 (스펙: learning_logs 신뢰불가 → 실제 원천 통일) ==========
// 카드 "활동 유형 Top" 막대 카운트(N회) 와 내역 API(/detail?type=X) count·items.length 를 완전 일치시키기 위해
// learning_logs(누락·중복) 대신 각 실제 원천 테이블에서 산출한다.
// 각 쿼리는 getReportDetail 의 동일 type case WHERE 절과 1:1 동일(클래스·기간 필터 포함) → count == items.length 보장.
//   post        → posts(author_id)               · 클래스필터 없음(detail 'post' 와 동일)
//   attendance  → attendance(user_id, status NN) · classId 있을 때만 class_id
//   survey      → survey_responses(+surveys)      · classId 있을 때만 s.class_id
//   homework    → homework_submissions(+homework) · classFilter(h.class_id) (미지정 시 member 클래스 합산·owner 제외)
//   exam        → exam_students(+exams)           · classFilter(e.class_id)
//   lesson      → lesson_self_check               · classFilter(lc.class_id)
// 반환: { post, attendance, survey, homework, exam, lesson } 정수 카운트.
function participationSourceCounts(studentId, { classId, startDate, endDate } = {}) {
  const hasRange = !!(startDate && endDate);
  const rc = (col) => `DATE(${col}) BETWEEN ? AND ?`;
  const rp = () => [startDate, endDate];
  // 참여도 클래스 범위 — computeAreas6 §축2 / getReportDetail.classFilter 와 동일.
  const classFilter = (col) => {
    if (classId) return { clause: `${col} = ?`, params: [classId] };
    return {
      clause: `${col} IN (
        SELECT cm.class_id FROM class_members cm
        WHERE cm.user_id = ? AND cm.role = 'member' AND cm.status = 'active'
          AND cm.class_id NOT IN (SELECT id FROM classes WHERE owner_id = ?)
      )`,
      params: [studentId, studentId]
    };
  };

  // post — posts.author_id (클래스/유저 무관, detail 'post' 와 동일)
  const post = db.prepare(`
    SELECT COUNT(*) c FROM posts
    WHERE author_id = ?${hasRange ? ` AND ${rc('created_at')}` : ''}
  `).get(studentId, ...(hasRange ? rp() : [])).c;

  // attendance — status NOT NULL, classId 있을 때만 class_id 한정 (detail 'attendance' 와 동일)
  const attendance = db.prepare(`
    SELECT COUNT(*) c FROM attendance
    WHERE user_id = ?${classId ? ' AND class_id = ?' : ''} AND status IS NOT NULL${hasRange ? ` AND ${rc('attendance_date')}` : ''}
  `).get(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).c;

  // survey — survey_responses ⨝ surveys, classId 있을 때만 s.class_id (detail 'survey' 와 동일)
  const survey = db.prepare(`
    SELECT COUNT(*) c FROM survey_responses sr
    JOIN surveys s ON s.id = sr.survey_id
    WHERE sr.user_id = ?${classId ? ' AND s.class_id = ?' : ''}${hasRange ? ` AND ${rc('sr.submitted_at')}` : ''}
  `).get(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).c;

  // homework — submitted/graded 만, classFilter(h.class_id) (detail 'homework' 와 동일)
  const hwF = classFilter('h.class_id');
  const homework = db.prepare(`
    SELECT COUNT(*) c FROM homework_submissions hs
    JOIN homework h ON h.id = hs.homework_id
    WHERE hs.student_id = ? AND hs.status IN ('submitted','graded') AND ${hwF.clause}${hasRange ? ` AND ${rc('hs.submitted_at')}` : ''}
  `).get(studentId, ...hwF.params, ...(hasRange ? rp() : [])).c;

  // exam — submitted 만, classFilter(e.class_id) (detail 'exam' 와 동일)
  const exF = classFilter('e.class_id');
  const exam = db.prepare(`
    SELECT COUNT(*) c FROM exam_students es
    JOIN exams e ON e.id = es.exam_id
    WHERE es.user_id = ? AND es.status = 'submitted' AND ${exF.clause}${hasRange ? ` AND ${rc('es.submitted_at')}` : ''}
  `).get(studentId, ...exF.params, ...(hasRange ? rp() : [])).c;

  // lesson — lesson_self_check, classFilter(lc.class_id) (detail 'lesson' 와 동일)
  const lsF = classFilter('lc.class_id');
  const lesson = db.prepare(`
    SELECT COUNT(*) c FROM lesson_self_check lc
    WHERE lc.user_id = ? AND ${lsF.clause}${hasRange ? ` AND ${rc('lc.created_at')}` : ''}
  `).get(studentId, ...lsF.params, ...(hasRange ? rp() : [])).c;

  return { post, attendance, survey, homework, exam, lesson };
}

function getStudentReport(studentId, { classId, startDate, endDate } = {}) {
  // 파라미터화된 쿼리로 SQL Injection 방지
  // 기간 BETWEEN off-by-one 방지(#6): DATE(col) 정규화로 종료일 당일 datetime 데이터 포함.
  const hasRange = !!(startDate && endDate);
  const dateParams = [];
  let dateFilter = '';
  let attDateFilter = '';
  if (hasRange) {
    dateFilter = ' AND DATE(created_at) BETWEEN ? AND ?';
    attDateFilter = ' AND DATE(attendance_date) BETWEEN ? AND ?';
    dateParams.push(startDate, endDate);
  }

  // 학생 정보 조회 (grade 포함 — 오늘학습 세트 학년매칭에 사용, 스펙 #4)
  const student = db.prepare('SELECT id, display_name, username, role, grade FROM users WHERE id = ?').get(studentId);
  const studentName = student ? student.display_name : '학생';

  // 클래스 정보
  let className = '';
  if (classId) {
    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(classId);
    if (cls) className = cls.name;
  }

  // 1. 정서발달: 감정 비율 — 두 소스 통합(도메인 §3·§10): attendance ∪ emotion_checkins.
  //  · attendance: 다중클래스 같은날 N행 → DISTINCT로 1일 1표(비율 왜곡 방지). classId 있을 때만 AND class_id=?.
  //  · emotion_checkins(마음채움): 학생 단위 → classId 있어도 항상 전체 포함(클래스 독립).
  //  · 기간(hasRange)은 양쪽 동일 DATE(...) BETWEEN ? AND ?. (같은날 같은감정 양쪽 존재 시 둘 다 카운트 = 독립신호, §4-B)
  const buildEmotionUnion = ({ order = false } = {}) => {
    const params = [];
    let attWhere = 'WHERE user_id = ? AND emotion IS NOT NULL';
    params.push(studentId);
    if (classId) { attWhere += ' AND class_id = ?'; params.push(classId); }
    if (hasRange) { attWhere += ' AND DATE(attendance_date) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    let chkWhere = 'WHERE user_id = ? AND emotion IS NOT NULL';
    params.push(studentId);
    if (hasRange) { chkWhere += ' AND DATE(checkin_date) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    let sql = `
      SELECT DISTINCT user_id, DATE(attendance_date) d, emotion, emotion_reason, emotion_score, 'class' src
        FROM attendance ${attWhere}
      UNION ALL
      SELECT user_id, DATE(checkin_date) d, emotion, emotion_reason, emotion_score, 'self' src
        FROM emotion_checkins ${chkWhere}
    `;
    if (order) sql += ' ORDER BY d DESC LIMIT 200';
    return { sql, params };
  };
  // 비율: 통합 결과를 emotion별 COUNT → 정본키 정규화 + 합산 (스펙 §7-4).
  // positiveRatio 계산(L1421)·emotionDevelopment FE 출력 양쪽이 정규화된 값을 사용.
  const emoU = buildEmotionUnion();
  const emoURows = db.prepare(emoU.sql).all(...emoU.params);
  const emotions = normalizeEmotionCounts(emoURows.map(r => ({ emotion: r.emotion, cnt: 1 })));

  // 최근 감정 흐름 (최신순) — 학생 성장 리포트 정서 발달 카드에서
  // "최근 감정 상태 주의" 알림의 근거가 된 실제 감정(날짜·이모지·라벨·이유)을 보여주기 위함.
  // 두 소스 통합. d AS attendance_date(★FE 필드명 유지) + src AS source 보존. 정본키 정규화로 대시보드 알림과 분류 일치.
  const recentU = buildEmotionUnion({ order: true });
  const recentEmotions = db.prepare(recentU.sql).all(...recentU.params)
    .map(row => ({
      attendance_date: row.d,
      emotion: normEmotion(row.emotion),
      emotion_reason: row.emotion_reason,
      emotion_score: row.emotion_score,
      source: row.src
    }));

  // 2. 기초학력: 진단 결과
  const diagDateFilter = hasRange ? ' AND DATE(completed_at) BETWEEN ? AND ?' : '';
  const diagParams = [studentId, ...dateParams];
  const diagnoses = db.prepare(`
    SELECT target_node_id, result, correct_count, total_questions
    FROM diagnosis_sessions WHERE user_id = ? AND status = 'completed' ${diagDateFilter}
    ORDER BY completed_at DESC LIMIT 10
  `).all(...diagParams);

  // 3. 학습역량: 학습 로그 통계
  const learnParams = [studentId, ...dateParams];
  const learningStats = db.prepare(`
    SELECT activity_type, COUNT(*) as cnt,
      AVG(CAST(result_score AS REAL)) as avg_score
    FROM learning_logs WHERE user_id = ? ${dateFilter}
    GROUP BY activity_type
  `).all(...learnParams);

  // 참여도 "활동 유형 Top" 막대 카운트 = 모달(getReportDetail) 카운트 단일 소스화 (감리 H-1·H-2)
  // FE(student-report.html 블록E)는 learningCapacity[].cnt 를 막대 카운트(N회)로 쓰고,
  // ACT_TO_DETAIL_TYPE 으로 /detail?type=X 모달을 연다. learning_logs COUNT(*) 는 누락·중복이 심해
  // 카드 카운트(learning_logs) ≠ 모달 카운트(실원천)로 항상 어긋난다(H-1: content_view 45 vs 43,
  // H-2: portfolio_add 1 vs 19 등). → "드릴 가능한 전 활동유형"의 cnt 를 detailCountFor(=모달 count)로 교체.
  //   · 막대 activity_type → 대표 activity_type → detail type 1:1 매핑(아래 BAR_TO_DETAIL).
  //   · 한 detail type 으로 합쳐지는 별칭 막대(lesson_view/progress, problem_set_complete)는 제거하고
  //     대표 행 1개로 일원화(중복 표시 방지). 대표 cnt = detailCountFor(detail).
  //   · detailCountFor 가 null(통일 불가) 인 type 은 드릴 비대상이므로 손대지 않음(learning_logs 유지).
  //   · learning_logs 는 막대 카운트에서만 제거 — LRS·콘텐츠활용 카드(viewedContents 등) 무영향.
  {
    // 막대 activity_type → { detail, rep(대표 activity_type) }. rep 가 자기 자신이 아니면 별칭(흡수·제거).
    const BAR_TO_DETAIL = {
      post_create:        { detail: 'post',              rep: 'post_create' },
      attendance_checkin: { detail: 'attendance',        rep: 'attendance_checkin' },
      survey_respond:     { detail: 'survey',            rep: 'survey_respond' },
      homework_submit:    { detail: 'homework',          rep: 'homework_submit' },
      exam_complete:      { detail: 'exam',              rep: 'exam_complete' },
      lesson_complete:    { detail: 'lesson',            rep: 'lesson_complete' },
      lesson_view:        { detail: 'lesson',            rep: 'lesson_complete' }, // 흡수
      lesson_progress:    { detail: 'lesson',            rep: 'lesson_complete' }, // 흡수
      content_view:       { detail: 'content_viewed',    rep: 'content_view' },
      diagnosis_complete: { detail: 'ai_learning',       rep: 'diagnosis_complete' },
      daily_complete:     { detail: 'today_learning',    rep: 'daily_complete' },
      problem_set_complete: { detail: 'today_learning',  rep: 'daily_complete' }, // 흡수
      portfolio_add:      { detail: 'content_portfolio', rep: 'portfolio_add' }
    };
    // 대표 activity_type 별 detail type (중복 산정 방지로 detail count 1회만 계산)
    const repDetail = {};
    Object.values(BAR_TO_DETAIL).forEach(m => { repDetail[m.rep] = m.detail; });
    // 대표 activity_type 별 통일 카운트 = 모달 count
    const repCnt = {};
    Object.entries(repDetail).forEach(([rep, detail]) => {
      repCnt[rep] = detailCountFor(studentId, detail, { classId, startDate, endDate });
    });
    // 별칭 막대 행 제거(대표로 일원화) — 자기 자신이 대표가 아닌 activity_type 행 삭제
    const aliasDrop = new Set(
      Object.entries(BAR_TO_DETAIL).filter(([at, m]) => m.rep !== at).map(([at]) => at)
    );
    for (let i = learningStats.length - 1; i >= 0; i--) {
      if (aliasDrop.has(learningStats[i].activity_type)) learningStats.splice(i, 1);
    }
    // 대표 행 cnt 덮어쓰기 (avg_score 등 기타 필드 보존)
    learningStats.forEach(row => {
      if (Object.prototype.hasOwnProperty.call(repCnt, row.activity_type) && repCnt[row.activity_type] != null) {
        row.cnt = repCnt[row.activity_type];
      }
    });
    // 원천엔 있으나 learning_logs 에 대표 행이 없던 활동유형 주입 (cnt>0 인 것만)
    const present = new Set(learningStats.map(r => r.activity_type));
    Object.entries(repCnt).forEach(([at, c]) => {
      if (c != null && c > 0 && !present.has(at)) learningStats.push({ activity_type: at, cnt: c, avg_score: null });
    });
  }

  // 4. 오늘의학습: 완료율 + 연속일 + 최근 현황 + 평균 정답률
  // 클래스 스코프(#4): 개인·타클래스 세트 혼입 제거. getClassDailyLearning 의 학년매칭과 일관되게
  // "현재 classId 전용 세트 ∪ 학생 학년에 맞는 글로벌 세트"의 진행 기록만 집계.
  // classId 없으면(개인 호출) 학생 학년 글로벌 세트만으로 제한(타클래스 전용 세트 배제).
  const studentGrade = student ? student.grade : null;
  const dailyDateFilter = hasRange ? ' AND DATE(completed_at) BETWEEN ? AND ?' : '';
  let dailySetClause = '';
  const dailySetParams = [];
  if (classId && studentGrade != null) {
    dailySetClause = ' AND set_id IN (SELECT id FROM daily_learning_sets WHERE class_id = ? OR (class_id IS NULL AND target_grade = ?))';
    dailySetParams.push(classId, studentGrade);
  } else if (classId) {
    dailySetClause = ' AND set_id IN (SELECT id FROM daily_learning_sets WHERE class_id = ?)';
    dailySetParams.push(classId);
  } else if (studentGrade != null) {
    dailySetClause = ' AND set_id IN (SELECT id FROM daily_learning_sets WHERE class_id IS NULL AND target_grade = ?)';
    dailySetParams.push(studentGrade);
  }
  // 파라미터 순서: user_id, [기간 startDate,endDate], [세트스코프 classId,grade]
  const dailyParams = [studentId, ...dateParams, ...dailySetParams];
  const dailyStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'completed' THEN COALESCE(correct_count, 0) ELSE 0 END) as totalCorrect,
      SUM(CASE WHEN status = 'completed' THEN COALESCE(total_questions, 0) ELSE 0 END) as totalQuestions
    FROM daily_learning_progress WHERE user_id = ? ${dailyDateFilter}${dailySetClause}
  `).get(...dailyParams);
  // 평균 정답률 계산: 누적 정답 수 / 누적 문항 수 (score가 0~1 또는 0~100인 경우 모두 안전)
  if (dailyStats) {
    if (dailyStats.totalQuestions > 0) {
      dailyStats.avgAccuracy = Math.round((dailyStats.totalCorrect / dailyStats.totalQuestions) * 100);
    } else {
      // fallback: score 컬럼 평균 (score가 0~1 범위라 가정). 동일 기간·세트 스코프 적용.
      const scoreRow = db.prepare(`
        SELECT AVG(CAST(score AS REAL)) as avgScore, COUNT(*) as cnt
        FROM daily_learning_progress WHERE user_id = ? AND status = 'completed' AND score IS NOT NULL ${dailyDateFilter}${dailySetClause}
      `).get(...dailyParams);
      if (scoreRow && scoreRow.cnt > 0 && scoreRow.avgScore != null) {
        const avg = scoreRow.avgScore;
        dailyStats.avgAccuracy = Math.round(avg <= 1 ? avg * 100 : avg);
      } else {
        dailyStats.avgAccuracy = null;
      }
    }
  }

  // 완료 날짜 조회 (연속일 및 캘린더 계산용)
  // 기간·클래스(학년매칭) 필터 일괄 적용(#5): dailyStats 완료율과 캘린더/연속일 정합.
  //  - 7일 기간 선택 시 "완료율 0%인데 캘린더에 전기간 날짜가 뜨던" 모순 해소.
  //  - slice(0,7) 상한 제거 → 8일+ 완료 학생도 잘리지 않음(기간 내 전 일자 반환, 안전 상한 366).
  // 파라미터 순서: user_id, [기간], [세트스코프] — dailyStats 와 동일.
  const recentDayParams = [studentId, ...dateParams, ...dailySetParams];
  const recentDailyDays = db.prepare(`
    SELECT DISTINCT DATE(completed_at) as day
    FROM daily_learning_progress
    WHERE user_id = ? AND status = 'completed'${dailyDateFilter}${dailySetClause}
    ORDER BY day DESC LIMIT 366
  `).all(...recentDayParams).map(r => r.day);

  // 연속일 계산 (기간 내 기준)
  let maxStreak = 0, currentStreak = 0;
  if (recentDailyDays.length > 0) {
    currentStreak = 1;
    for (let i = 1; i < recentDailyDays.length; i++) {
      const prev = new Date(recentDailyDays[i - 1]);
      const curr = new Date(recentDailyDays[i]);
      const diff = (prev - curr) / (1000 * 60 * 60 * 24);
      if (diff === 1) { currentStreak++; }
      else { maxStreak = Math.max(maxStreak, currentStreak); currentStreak = 1; }
    }
    maxStreak = Math.max(maxStreak, currentStreak);
  }
  if (dailyStats) {
    dailyStats.maxStreak = maxStreak;
    dailyStats.recentDays = recentDailyDays; // 기간 내 전체(상한 제거)
  }

  // 5. 독서활동
  const readParams = [studentId, ...dateParams];
  const readingLogs = db.prepare(`
    SELECT * FROM reading_logs WHERE user_id = ? ${dateFilter} ORDER BY read_date DESC
  `).all(...readParams);

  // 6. 진로탐색: career_logs 전용 데이터만 사용
  const careerLogParams = [studentId, ...dateParams];
  let careerLogDateFilter = dateFilter.replace('created_at', 'activity_date');
  const careerLogs = db.prepare(`
    SELECT * FROM career_logs WHERE user_id = ? ${careerLogDateFilter} ORDER BY activity_date DESC
  `).all(...careerLogParams);

  // 진로 관심 분야 (career_logs의 interest_area 기반)
  const careerInterests = db.prepare(`
    SELECT interest_area, COUNT(*) as cnt FROM career_logs
    WHERE user_id = ? AND interest_area IS NOT NULL AND interest_area != '' ${careerLogDateFilter}
    GROUP BY interest_area ORDER BY cnt DESC
  `).all(...careerLogParams);

  // 7. 콘텐츠 활용 현황
  // 콘텐츠 활용 카드 전 지표에 기간 필터 일괄 적용(#7) — viewedContents 만 필터되어 같은 카드 안에서
  // 일부만 변하던 불일치 해소. 각 테이블 날짜 컬럼 기준, DATE() 정규화로 종료일 off-by-one 해소(#6).
  // (dateFilter 가 created_at 기준이므로 컬럼명이 다른 지표는 별도 절을 구성)
  const collDateFilter = hasRange ? ' AND DATE(created_at) BETWEEN ? AND ?' : '';
  const subDateFilter = hasRange ? ' AND DATE(subscribed_at) BETWEEN ? AND ?' : '';

  // 내가 담은 콘텐츠 (보관함) — created_at 기준
  const savedContents = db.prepare(`
    SELECT COUNT(*) as cnt FROM content_collections WHERE user_id = ? ${collDateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 조회 콘텐츠 (content_view 활동)
  const viewedContents = db.prepare(`
    SELECT COUNT(DISTINCT object_id) as cnt FROM learning_logs WHERE user_id = ? AND activity_type = 'content_view' ${dateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 좋아요 (기간 내 올린 콘텐츠의 총 좋아요 수) — contents.created_at 기준
  const totalLikes = db.prepare(`
    SELECT COALESCE(SUM(like_count), 0) as cnt FROM contents WHERE creator_id = ? ${dateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 내가 올린 콘텐츠 — contents.created_at 기준
  const uploadedContents = db.prepare(`
    SELECT COUNT(*) as cnt FROM contents WHERE creator_id = ? ${dateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 채널 구독자 수 — 기간 내 개설한 채널의 구독자 합 (channels.created_at 기준)
  const subscriberCount = db.prepare(`
    SELECT COALESCE(SUM(subscriber_count), 0) as cnt FROM channels WHERE user_id = ? ${collDateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 내가 구독한 수 — channel_subscriptions.subscribed_at 기준
  const mySubscriptions = db.prepare(`
    SELECT COUNT(*) as cnt FROM channel_subscriptions WHERE subscriber_id = ? ${subDateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 자주 조회한 콘텐츠 (learning_logs의 object_type에서 추출)
  const searchKeywords = db.prepare(`
    SELECT COALESCE(object_type, '기타') as keyword, COUNT(*) as cnt
    FROM learning_logs WHERE user_id = ? AND activity_type = 'content_view' AND object_type IS NOT NULL AND object_type != '' ${dateFilter}
    GROUP BY object_type ORDER BY cnt DESC LIMIT 10
  `).all(studentId, ...dateParams);

  // 성취기준 (학습한 성취기준) — 스펙 #7: 학습 성격 활동만 집계.
  // 출석체크인·게시물·설문응답·게시물조회·포트폴리오추가 등 비(非)학습 활동의 achievement_code 는
  // "이 성취기준을 학습했다"는 의미가 아니므로 제외한다(예: id3 의 [4사09-01]@attendance_checkin,
  // [4국05-02]@post_create 2건 → 화이트리스트 적용 시 빈 목록).
  const ACH_LEARNING_TYPES = [
    'content_view', 'content_complete', 'lesson_view', 'lesson_progress',
    'problem_attempt', 'self_learn', 'wrong_note_retry', 'exam_complete',
    'homework_submit', 'diagnosis', 'today_learning'
  ];
  const achTypePlaceholders = ACH_LEARNING_TYPES.map(() => '?').join(',');
  const achievementStandards = db.prepare(`
    SELECT achievement_code as code, COUNT(*) as cnt
    FROM learning_logs
    WHERE user_id = ? AND achievement_code IS NOT NULL AND achievement_code != ''
      AND activity_type IN (${achTypePlaceholders}) ${dateFilter}
    GROUP BY achievement_code ORDER BY cnt DESC LIMIT 10
  `).all(studentId, ...ACH_LEARNING_TYPES, ...dateParams);

  // 포트폴리오 항목 수 — portfolio_items.created_at 기준 (#7)
  const portfolioCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM portfolio_items WHERE user_id = ? ${collDateFilter}
  `).get(studentId, ...dateParams)?.cnt || 0;

  // 선생님 관찰 기록
  const observations = classId
    ? db.prepare('SELECT * FROM teacher_observations WHERE student_id = ? AND class_id = ? ORDER BY observation_date DESC').all(studentId, classId)
    : db.prepare('SELECT * FROM teacher_observations WHERE student_id = ? ORDER BY observation_date DESC').all(studentId);

  // 영역별 점수 계산
  const emotionTotal = emotions.reduce((s, e) => s + e.cnt, 0);
  const positiveEmotions = emotions.filter(e => ['happy', 'excited', 'good', 'great', 'calm'].includes(e.emotion));
  const positiveRatio = emotionTotal > 0 ? positiveEmotions.reduce((s, e) => s + e.cnt, 0) / emotionTotal * 100 : 0;

  const diagAvg = diagnoses.length > 0
    ? diagnoses.reduce((s, d) => s + (d.correct_count && d.total_questions ? d.correct_count / d.total_questions * 100 : 0), 0) / diagnoses.length
    : 0;

  // result_score는 저장 방식이 혼재(0~1 또는 0~100). 1 이하는 비율로 보고 ×100, 1 초과는 이미 백분위로 간주. 최종 0~100 클램프.
  const learnAvg = learningStats.length > 0
    ? Math.min(100, learningStats.reduce((s, l) => {
        const v = l.avg_score;
        if (v == null) return s;
        return s + (v <= 1 ? v * 100 : v);
      }, 0) / learningStats.length)
    : 0;

  const dailyRate = dailyStats && dailyStats.total > 0
    ? (dailyStats.completed / dailyStats.total) * 100
    : 0;

  // 독서활동: 구간별 점수화
  const bookCount = readingLogs.length;
  const readingScore = bookCount === 0 ? 0 :
    bookCount <= 2 ? bookCount * 20 :       // 0-2권: 0, 20, 40
    bookCount <= 5 ? 40 + (bookCount - 2) * 15 : // 3-5권: 55, 70, 85
    Math.min(85 + (bookCount - 5) * 5, 100);     // 6권+: 90, 95, 100

  // 진로탐색: career_logs 기반 점수 (관심분야 다양성 + 활동 수)
  const careerLogCount = careerLogs.length;
  const interestAreaCount = careerInterests.length;
  const careerScore = Math.min(
    interestAreaCount * 20 + careerLogCount * 15,
    100
  );

  const dailyTotal = dailyStats ? dailyStats.total : 0;

  // 6축 성장 분포 — 공통 헬퍼로 산출 (설계서 §1·§8)
  // 정서발달·참여도·성취수준·진로탐색·독서활동·콘텐츠활용
  const areas = computeAreas6(studentId, { classId, startDate, endDate });

  // 서비스 미제공 영역 강제 0점 처리
  NO_SERVICE_AREAS.forEach(name => {
    if (areas[name]) {
      areas[name].score = 0;
      areas[name].hasData = false;
    }
  });

  // 가중치 기반 종합 점수 계산 (hasData인 영역만, 정규화) — 설계서 §2
  const weights = {
    '성취수준': 0.25,
    '참여도': 0.25,
    '정서발달': 0.20,
    '콘텐츠활용': 0.10,
    '독서활동': 0.10,
    '진로탐색': 0.10
  };
  const validAreas = Object.entries(areas).filter(([_, a]) => a.hasData);
  let overallScore = 0;
  if (validAreas.length > 0) {
    const totalWeight = validAreas.reduce((s, [name, _]) => s + weights[name], 0);
    overallScore = Math.round(
      validAreas.reduce((s, [name, a]) => s + a.score * weights[name], 0) / totalWeight
    );
  }

  return {
    studentName,
    className,
    role: student ? student.role : 'student',
    overallScore,
    areas,
    emotionDevelopment: emotions,
    recentEmotions,
    academicFoundation: diagnoses,
    learningCapacity: learningStats,
    dailyLearning: dailyStats,
    readingActivity: { books: readingLogs, count: readingLogs.length },
    careerExploration: { interests: careerInterests, logs: careerLogs },
    contentUsage: {
      savedContents,
      viewedContents,
      totalLikes,
      uploadedContents,
      subscriberCount,
      mySubscriptions,
      searchKeywords,
      achievementStandards,
      portfolioCount
    },
    observations
  };
}

function getStudentReportArea(studentId, areaName, { classId, startDate, endDate } = {}) {
  // classId 전달 시 참여도 등 클래스 맥락 축도 정상 산출되도록 전달
  const report = getStudentReport(studentId, { classId, startDate, endDate });
  // 상세 데이터 필드 매핑 (탭 상세). 신규 6축 키도 areas 에서 직접 노출.
  const areaMap = {
    emotion: 'emotionDevelopment',
    academic: 'academicFoundation',
    achievement: 'academicFoundation', // 성취수준 상세 = 진단/문항 데이터
    learning: 'learningCapacity',
    daily: 'dailyLearning',
    participation: 'dailyLearning',
    reading: 'readingActivity',
    career: 'careerExploration',
    content: 'contentUsage'
  };
  // areas 6축 키(정서발달/참여도/성취수준/진로탐색/독서활동/콘텐츠활용) 직접 조회 지원
  if (report.areas && report.areas[areaName]) return report.areas[areaName];
  return report[areaMap[areaName]] || null;
}

// ========== 선생님 관찰 기록 ==========

function createObservation(teacherId, { studentId, classId, text, content, area, tags }) {
  const obsText = text || content || '';
  const tagData = tags ? (typeof tags === 'string' ? tags : JSON.stringify(tags)) : (area ? JSON.stringify({ area }) : null);
  const areaValue = area || '';
  const info = db.prepare(`
    INSERT INTO teacher_observations (teacher_id, student_id, class_id, observation_text, tags, area)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(teacherId, studentId, classId, obsText, tagData, areaValue);
  return { id: info.lastInsertRowid };
}

function getObservations(studentId, classId) {
  let rows;
  if (classId) {
    rows = db.prepare(`
      SELECT o.*, u.display_name as teacher_name
      FROM teacher_observations o JOIN users u ON o.teacher_id = u.id
      WHERE o.student_id = ? AND o.class_id = ? ORDER BY o.observation_date DESC
    `).all(studentId, classId);
  } else {
    rows = db.prepare(`
      SELECT o.*, u.display_name as teacher_name
      FROM teacher_observations o JOIN users u ON o.teacher_id = u.id
      WHERE o.student_id = ? ORDER BY o.observation_date DESC
    `).all(studentId);
  }
  // area 컬럼 직접 사용 (기존 데이터 호환: area 컬럼이 비어있으면 tags에서 추출)
  return rows.map(o => {
    let area = o.area || '';
    if (!area && o.tags) { try { const t = JSON.parse(o.tags); area = t.area || ''; } catch { area = ''; } }
    return { ...o, area, content: o.observation_text };
  });
}

// ========== 오늘의학습 클래스 상세 ==========

function getClassDailyLearning(classId, { period = 'weekly', startDate, endDate } = {}) {
  // 1. 클래스 학생 목록 (학생 grade 포함 — 학년별 글로벌 세트 매칭에 사용)
  const members = db.prepare(`
    SELECT u.id, u.display_name, u.grade FROM class_members cm
    JOIN users u ON cm.user_id = u.id WHERE cm.class_id = ? AND u.role = 'student'
    ORDER BY u.display_name
  `).all(classId);
  if (members.length === 0) return { students: [], dates: [], sets: [] };

  // 2. 날짜 범위 계산 — 로컬(KST) 기준. UTC(toISOString)는 KST 자정이 전날 15:00이 되어 -1일 시프트되므로 금지.
  const fmtLocalDate = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = new Date();
  if (!startDate || !endDate) {
    if (period === 'monthly') {
      startDate = fmtLocalDate(new Date(today.getFullYear(), today.getMonth(), 1));
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      endDate = fmtLocalDate(new Date(today.getFullYear(), today.getMonth(), lastDay));
    } else {
      // weekly: 이번 주 월~일
      const day = today.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(today);
      monday.setDate(today.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      startDate = fmtLocalDate(monday);
      endDate = fmtLocalDate(sunday);
    }
  }

  // 3. 해당 기간의 후보 학습 세트 조회 (학생 학년별 매칭)
  //    후보 세트 = 클래스 전용 세트(class_id=classId) ∪ 멤버들의 학년(users.grade) union에 해당하는 글로벌 세트.
  //    혼합 클래스(classes.grade=null)에서도 학생 학년에 맞지 않는 타 학년 글로벌 세트가 혼입되지 않도록,
  //    클래스 grade가 아니라 실제 학생들의 grade 목록으로 제한한다.
  //    날짜 귀속 정책(DAILY_LEARNING_DATE_ATTRIBUTION_SPEC §2·§7): 매트릭스는 "날짜별 커리큘럼 진도표"이므로
  //    후보 세트 = target_date 가 기간 내인 세트만(배정일 기준). 완료일(completed_at) OR 조항은 폐기한다.
  //    → 5월 화면 = target_date ∈ 5월 세트만. 6/16에 푼 5/31 세트도 5/31(5월) 칸으로 귀속된다.
  //    target_date IS NULL 세트는 "진도 미배정"이라 어느 날짜 칸에도 배치 불가 → 매트릭스에서 제외(§8).
  const memberGrades = [...new Set(members.map(m => m.grade).filter(g => g != null))];

  let sets;
  if (memberGrades.length > 0) {
    const gradePlaceholders = memberGrades.map(() => '?').join(',');
    sets = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM daily_learning_items WHERE set_id = s.id) as item_count
      FROM daily_learning_sets s
      WHERE (s.class_id = ? OR (s.class_id IS NULL AND s.target_grade IN (${gradePlaceholders})))
        AND s.target_date IS NOT NULL
        AND s.target_date BETWEEN ? AND ?
        AND s.is_active = 1
      ORDER BY s.target_date ASC
    `).all(classId, ...memberGrades, startDate, endDate);
  } else {
    // 학생 grade가 모두 null이면 글로벌 세트는 매칭 불가 → 클래스 전용 세트만.
    sets = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM daily_learning_items WHERE set_id = s.id) as item_count
      FROM daily_learning_sets s
      WHERE s.class_id = ?
        AND s.target_date IS NOT NULL
        AND s.target_date BETWEEN ? AND ?
        AND s.is_active = 1
      ORDER BY s.target_date ASC
    `).all(classId, startDate, endDate);
  }

  // 4. 날짜 목록 생성
  const dates = [];
  const d = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (d <= end) {
    dates.push(fmtLocalDate(d));
    d.setDate(d.getDate() + 1);
  }

  // 5. 학생별 날짜별 진행 상황 조회 — 각 학생의 분모는 "그 학생 학년에 맞는 글로벌 세트 + 클래스 전용 세트"로만 한정.
  const studentData = members.map(member => {
    const dailyMap = {};
    dates.forEach(date => {
      dailyMap[date] = { participated: false, totalItems: 0, completedItems: 0, score: null, accuracy: null, hasSet: false, setId: null };
    });

    // 이 학생에게 해당하는 후보 세트만 필터링 (클래스 전용 ∪ 학생 학년 글로벌)
    const memberSets = sets.filter(s =>
      s.class_id === classId || (s.class_id == null && s.target_grade === member.grade)
    );
    const memberSetIds = memberSets.map(s => s.id);

    // 날짜별 대표 세트(클릭 모달용): 같은 날 여러 세트면 문항수 많은 것 우선, 동률이면 첫번째.
    const repSetByDate = {};
    memberSets.forEach(s => {
      const cur = repSetByDate[s.target_date];
      if (!cur || (s.item_count || 0) > (cur.item_count || 0)) repSetByDate[s.target_date] = s;
    });
    Object.keys(repSetByDate).forEach(dt => {
      if (dailyMap[dt]) { dailyMap[dt].hasSet = true; dailyMap[dt].setId = repSetByDate[dt].id; }
    });

    // 날짜 귀속 정책(SPEC §2 #1·§7): 완료 기록을 "어느 날짜 칸에 넣을지"는 세트 배정일(s.target_date)로 귀속한다.
    //  매트릭스는 진도표("그 날짜의 커리큘럼을 누가 이수했나")이므로, 6/16에 푼 5/31 세트도 5/31 칸에 participated 가 된다.
    //  "완료됐는가" 판정은 여전히 status='completed'(completed_at 존재). 단지 셀 배치 축이 completed_at → target_date.
    //  완료 조회는 completed_at 기간 제한 없이 "해당 세트(target_date∈기간)의 완료"를 잡고, GROUP BY s.target_date 로 배치.
    if (memberSetIds.length > 0) {
      const setPlaceholders = memberSetIds.map(() => '?').join(',');
      // 5-a) 날짜별 총 문항수(분모용) — 세트 배정일(target_date) 기준. 매트릭스 "그 날의 세트 문항수". (변경 없음)
      const itemsByDate = db.prepare(`
        SELECT s.target_date AS day, COUNT(DISTINCT i.id) AS total_items
        FROM daily_learning_sets s
        JOIN daily_learning_items i ON i.set_id = s.id
        WHERE s.id IN (${setPlaceholders})
        GROUP BY s.target_date
      `).all(...memberSetIds);
      itemsByDate.forEach(row => {
        if (dailyMap[row.day]) dailyMap[row.day].totalItems = row.total_items;
      });
      // 5-b) 완료 항목을 세트 배정일(s.target_date) 별로 집계. 이 학생의 매칭 세트 항목만.
      //  같은 세트를 여러 번 완료해도 COUNT(DISTINCT p.item_id) 로 항목 단위 1회 집계(SPEC §8 중복완료 규칙).
      const compByDate = db.prepare(`
        SELECT s.target_date AS day,
          COUNT(DISTINCT p.item_id) AS completed_items,
          AVG(p.score) AS avg_score
        FROM daily_learning_progress p
        JOIN daily_learning_items i ON i.id = p.item_id
        JOIN daily_learning_sets s ON s.id = i.set_id
        WHERE p.user_id = ? AND p.status = 'completed'
          AND i.set_id IN (${setPlaceholders})
          AND s.target_date IS NOT NULL
        GROUP BY s.target_date
      `).all(member.id, ...memberSetIds);
      compByDate.forEach(row => {
        if (dailyMap[row.day]) {
          dailyMap[row.day].participated = row.completed_items > 0;
          dailyMap[row.day].completedItems = row.completed_items;
          dailyMap[row.day].score = row.avg_score != null ? Math.round(row.avg_score) : null;
          // 정답률(셀 표시용): 그 날 완료수 / 그 날 배정 세트 문항수. 후보 세트가 target_date∈기간으로
          // 한정되어 배정 없는 셀엔 완료도 없으므로 분모 0 폴백(100%)은 거의 발생 안 함 — 안전망으로 유지.
          const tot = dailyMap[row.day].totalItems;
          dailyMap[row.day].accuracy = tot > 0
            ? Math.round(row.completed_items / tot * 100)
            : (row.completed_items > 0 ? 100 : 0);
        }
      });
    }

    // 총 참여율 & 평균 정답률 — 분모는 "이 학생이 매칭 세트를 가진 날 수"(배정일 기준 유지).
    const participated = Object.values(dailyMap).filter(v => v.participated).length;
    const datesWithSets = dates.filter(dt => memberSets.some(s => s.target_date === dt)).length;
    const scores = Object.values(dailyMap).filter(v => v.score != null).map(v => v.score);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    return {
      id: member.id,
      name: member.display_name,
      grade: member.grade, // 스트릭 재계산(활동일 기준)에서 학생 학년 글로벌 세트 매칭에 사용
      daily: dailyMap,
      participationRate: datesWithSets > 0 ? Math.round(participated / datesWithSets * 100) : 0,
      avgScore
    };
  });

  // 요약 통계 — 매트릭스와 동일 기간/데이터 기준 (요약 카드 ↔ 매트릭스 일관성 보장)
  const compRates = studentData.map(s => s.participationRate);
  const accScores = studentData.filter(s => s.avgScore != null).map(s => s.avgScore);
  // 스트릭(연속 학습일)은 "습관" 지표 — SPEC §4: 매트릭스 셀(이제 target_date=진도)에서 파생하면
  //  "배정일 연속"으로 오집계된다(5/30·5/31 세트를 6/16 하루에 풀면 스트릭 2일로 둔갑).
  //  → 반드시 각 학생의 실제 활동일 DISTINCT DATE(completed_at) 집합(기간 내)에서 연속을 센다.
  //  세트 스코프는 매트릭스와 동일(클래스 전용 ∪ 학생 학년 글로벌)하되, 귀속 축만 completed_at.
  //  알고리즘은 getStudentReport 의 연속일 계산(정렬 → 인접 diff==1 카운트)과 동일.
  let summaryMaxStreak = 0;
  const studentStreaks = studentData.map(s => {
    const memberSets = sets.filter(st =>
      st.class_id === classId || (st.class_id == null && st.target_grade === s.grade)
    );
    const memberSetIds = memberSets.map(st => st.id);
    let best = 0;
    if (memberSetIds.length > 0) {
      const ph = memberSetIds.map(() => '?').join(',');
      // 기간 내(completed_at) 실제 학습일 — 오름차순 distinct.
      const days = db.prepare(`
        SELECT DISTINCT DATE(p.completed_at) AS day
        FROM daily_learning_progress p
        JOIN daily_learning_items i ON i.id = p.item_id
        WHERE p.user_id = ? AND p.status = 'completed'
          AND i.set_id IN (${ph})
          AND p.completed_at IS NOT NULL
          AND DATE(p.completed_at) BETWEEN ? AND ?
        ORDER BY day ASC
      `).all(s.id, ...memberSetIds, startDate, endDate).map(r => r.day);
      let cur = 0;
      for (let i = 0; i < days.length; i++) {
        if (i === 0) { cur = 1; }
        else {
          const prev = new Date(days[i - 1] + 'T00:00:00');
          const curr = new Date(days[i] + 'T00:00:00');
          const diff = (curr - prev) / (1000 * 60 * 60 * 24);
          cur = diff === 1 ? cur + 1 : 1;
        }
        if (cur > best) best = cur;
      }
    }
    if (best > summaryMaxStreak) summaryMaxStreak = best;
    return { name: s.name, best };
  });
  // 최다 연속일 달성자 명단 (동률이면 전원, FE에서 "ㅇㅇㅇ 외 N명"으로 축약)
  const maxStreakHolders = summaryMaxStreak > 0
    ? studentStreaks.filter(s => s.best === summaryMaxStreak).map(s => s.name)
    : [];
  const summary = {
    avgCompletionRate: compRates.length ? Math.round(compRates.reduce((a, b) => a + b, 0) / compRates.length) : 0,
    avgAccuracy: accScores.length ? Math.round(accScores.reduce((a, b) => a + b, 0) / accScores.length) : null,
    maxStreak: summaryMaxStreak,
    maxStreakHolders,
    hasData: studentData.some(s => s.participationRate > 0)
  };

  return {
    students: studentData,
    dates,
    startDate,
    endDate,
    period,
    summary,
    sets: sets.map(s => ({ id: s.id, title: s.title, targetDate: s.target_date, itemCount: s.item_count, subject: s.target_subject }))
  };
}

// ========== 독서 기록 ==========

function getReadingLogs(userId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM reading_logs WHERE user_id = ?').get(userId).cnt;
  const items = db.prepare('SELECT * FROM reading_logs WHERE user_id = ? ORDER BY read_date DESC LIMIT ? OFFSET ?')
    .all(userId, limit, (page - 1) * limit);
  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

function addReadingLog(userId, data) {
  const info = db.prepare(`
    INSERT INTO reading_logs (user_id, book_title, author, read_date, rating, review)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, data.bookTitle, data.author || null, data.readDate || null, data.rating || null, data.review || null);
  return { id: info.lastInsertRowid };
}

function updateReadingLog(userId, logId, data) {
  const existing = db.prepare('SELECT * FROM reading_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare(`
    UPDATE reading_logs SET book_title = ?, author = ?, read_date = ?, rating = ?, review = ? WHERE id = ? AND user_id = ?
  `).run(data.bookTitle, data.author || null, data.readDate || null, data.rating || null, data.review || null, logId, userId);
  return { id: logId };
}

function deleteReadingLog(userId, logId) {
  const existing = db.prepare('SELECT * FROM reading_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM reading_logs WHERE id = ? AND user_id = ?').run(logId, userId);
  return { id: logId };
}

// ========== 진로탐색 기록 ==========

function getCareerLogs(userId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM career_logs WHERE user_id = ?').get(userId).cnt;
  const items = db.prepare('SELECT * FROM career_logs WHERE user_id = ? ORDER BY activity_date DESC LIMIT ? OFFSET ?')
    .all(userId, limit, (page - 1) * limit);
  return { items, total, totalPages: Math.ceil(total / limit) || 1 };
}

function addCareerLog(userId, data) {
  const info = db.prepare(`
    INSERT INTO career_logs (user_id, activity_type, title, description, interest_area, reflection, activity_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, data.activityType || '기타', data.title, data.description || null, data.interestArea || null, data.reflection || null, data.activityDate || null);
  return { id: info.lastInsertRowid };
}

function updateCareerLog(userId, logId, data) {
  const existing = db.prepare('SELECT * FROM career_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare(`
    UPDATE career_logs SET activity_type = ?, title = ?, description = ?, interest_area = ?, reflection = ?, activity_date = ? WHERE id = ? AND user_id = ?
  `).run(data.activityType || '기타', data.title, data.description || null, data.interestArea || null, data.reflection || null, data.activityDate || null, logId, userId);
  return { id: logId };
}

function deleteCareerLog(userId, logId) {
  const existing = db.prepare('SELECT * FROM career_logs WHERE id = ? AND user_id = ?').get(logId, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM career_logs WHERE id = ? AND user_id = ?').run(logId, userId);
  return { id: logId };
}

// ========== 학부모 공개 설정 ==========

function setReportVisibility(teacherId, studentId, classId, settings) {
  db.prepare(`
    INSERT OR REPLACE INTO report_visibility (teacher_id, student_id, class_id, show_summary, show_emotion, show_academics, show_teacher_comment, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(teacherId, studentId, classId,
    settings.showSummary !== undefined ? (settings.showSummary ? 1 : 0) : 1,
    settings.showEmotion !== undefined ? (settings.showEmotion ? 1 : 0) : 1,
    settings.showAcademics !== undefined ? (settings.showAcademics ? 1 : 0) : 1,
    settings.showTeacherComment !== undefined ? (settings.showTeacherComment ? 1 : 0) : 1);
}

function getParentReport(studentId) {
  // 공개 설정된 영역만 반환
  const visibility = db.prepare('SELECT * FROM report_visibility WHERE student_id = ? LIMIT 1').get(studentId);
  const report = getStudentReport(studentId, {});

  if (visibility) {
    if (!visibility.show_emotion) delete report.emotionDevelopment;
    if (!visibility.show_academics) delete report.academicFoundation;
    if (!visibility.show_teacher_comment) delete report.observations;
  }

  return report;
}

// ========== 외부 데이터 수신(Ingest) 게이트웨이 ==========

/**
 * 기초학력 진단 결과 수신
 * 외부 학력진단 시스템(학력진단-보정 시스템, AI 진단 등)에서 결과를 전송
 * @param {Object} data - { userId, sourceSystem, targetNodeId, result, correctCount, totalQuestions, completedAt }
 */
function ingestDiagnosis(data) {
  const { userId, sourceSystem, targetNodeId, result, correctCount, totalQuestions, completedAt } = data;
  // diagnosis_sessions 테이블에 삽입
  const info = db.prepare(`
    INSERT INTO diagnosis_sessions (user_id, target_node_id, status, result, correct_count, total_questions, started_at, completed_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(
    userId,
    targetNodeId || sourceSystem || 'external',
    result || (correctCount >= totalQuestions * 0.6 ? 'pass' : 'fail'),
    correctCount || 0,
    totalQuestions || 0,
    completedAt || new Date().toISOString(),
    completedAt || new Date().toISOString()
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 기초학력 진단 결과 일괄 수신 (배치)
 * @param {Array} items - 진단 결과 배열
 */
function ingestDiagnosisBatch(items) {
  const insert = db.prepare(`
    INSERT INTO diagnosis_sessions (user_id, target_node_id, status, result, correct_count, total_questions, started_at, completed_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
  `);
  const results = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const info = insert.run(
        item.userId,
        item.targetNodeId || item.sourceSystem || 'external',
        item.result || (item.correctCount >= item.totalQuestions * 0.6 ? 'pass' : 'fail'),
        item.correctCount || 0,
        item.totalQuestions || 0,
        item.completedAt || new Date().toISOString(),
        item.completedAt || new Date().toISOString()
      );
      results.push({ id: info.lastInsertRowid });
    }
  });
  tx();
  return { inserted: results.length, results };
}

/**
 * 독서활동 데이터 수신
 * 외부 독서교육종합지원시스템, 학교 도서관 시스템 등에서 전송
 * @param {Object} data - { userId, bookTitle, author, readDate, rating, review, isbn, sourceSystem }
 */
function ingestReading(data) {
  const info = db.prepare(`
    INSERT INTO reading_logs (user_id, book_title, author, read_date, rating, review)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.bookTitle,
    data.author || null,
    data.readDate || new Date().toISOString().slice(0, 10),
    data.rating || null,
    data.review || null
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 독서활동 일괄 수신 (배치)
 */
function ingestReadingBatch(items) {
  const insert = db.prepare(`
    INSERT INTO reading_logs (user_id, book_title, author, read_date, rating, review)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const info = insert.run(
        item.userId,
        item.bookTitle,
        item.author || null,
        item.readDate || new Date().toISOString().slice(0, 10),
        item.rating || null,
        item.review || null
      );
      results.push({ id: info.lastInsertRowid });
    }
  });
  tx();
  return { inserted: results.length, results };
}

/**
 * 진로탐색 데이터 수신
 * 외부 진로적성검사 시스템, 진로체험 플랫폼 등에서 전송
 * @param {Object} data - { userId, activityType, title, description, interestArea, reflection, activityDate, sourceSystem }
 */
function ingestCareer(data) {
  const info = db.prepare(`
    INSERT INTO career_logs (user_id, activity_type, title, description, interest_area, reflection, activity_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.activityType || '외부연동',
    data.title,
    data.description || null,
    data.interestArea || null,
    data.reflection || null,
    data.activityDate || new Date().toISOString().slice(0, 10)
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 진로탐색 일괄 수신 (배치)
 */
function ingestCareerBatch(items) {
  const insert = db.prepare(`
    INSERT INTO career_logs (user_id, activity_type, title, description, interest_area, reflection, activity_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const info = insert.run(
        item.userId,
        item.activityType || '외부연동',
        item.title,
        item.description || null,
        item.interestArea || null,
        item.reflection || null,
        item.activityDate || new Date().toISOString().slice(0, 10)
      );
      results.push({ id: info.lastInsertRowid });
    }
  });
  tx();
  return { inserted: results.length, results };
}

/**
 * 학습활동 데이터 수신 (학습역량/오늘의학습 등 범용)
 * 외부 LMS, 에듀테크 플랫폼 등에서 학습 활동 로그 전송
 */
function ingestLearningLog(data) {
  const info = db.prepare(`
    INSERT INTO learning_logs (user_id, class_id, activity_type, object_id, object_type, verb, result_score, duration, source_service)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.classId || null,
    data.activityType || 'external',
    data.contentId || null,
    data.contentTitle || 'content',
    'completed',
    data.resultScore || null,
    data.timeSpent || null,
    data.sourceService || data.sourceSystem || 'external'
  );
  return { id: info.lastInsertRowid, source: 'ingest' };
}

/**
 * 정서(감정) 데이터 수신
 * 외부 감정체크 앱, 설문 시스템 등에서 전송
 *
 * 감정은 학생 단위 상태이므로, classId 미지정 시 학생이 속한 모든 활성 클래스에
 * UPSERT 한다 (각 클래스 담임이 자기 반 학생의 감정을 볼 수 있도록).
 */
function ingestEmotion(data) {
  const date = data.date || new Date().toISOString().slice(0, 10);
  // 마음채움 감정 체크인은 학생 단위 상태 — 클래스 출석부와 독립.
  // emotion_checkins 테이블에 (user_id, date) UNIQUE 로 1행만 UPSERT 한다.
  const upsertStmt = db.prepare(`
    INSERT INTO emotion_checkins (user_id, checkin_date, emotion, emotion_reason, emotion_reason_type, emotion_score, checkin_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, checkin_date) DO UPDATE SET
      emotion = excluded.emotion,
      emotion_reason = excluded.emotion_reason,
      emotion_reason_type = excluded.emotion_reason_type,
      emotion_score = excluded.emotion_score,
      checkin_source = excluded.checkin_source,
      updated_at = CURRENT_TIMESTAMP
  `);
  const findRowStmt = db.prepare(
    'SELECT id FROM emotion_checkins WHERE user_id = ? AND checkin_date = ?'
  );

  const info = upsertStmt.run(
    data.userId,
    date,
    data.emotion,
    data.emotionReason || null,
    data.emotionReasonType || 'text',
    data.emotionScore != null ? data.emotionScore : null,
    data.source || 'ingest'
  );
  let id = info.lastInsertRowid;
  if (!id) {
    const row = findRowStmt.get(data.userId, date);
    id = row ? row.id : null;
  }
  return { id, source: 'ingest', classCount: 0 };
}

/**
 * Ingest 처리 현황 조회 (관리자용)
 */
function getIngestStats() {
  const diagCount = db.prepare("SELECT COUNT(*) as cnt FROM diagnosis_sessions WHERE target_node_id LIKE 'external%' OR target_node_id NOT LIKE 'M-%'").get().cnt;
  const readingCount = db.prepare("SELECT COUNT(*) as cnt FROM reading_logs").get().cnt;
  const careerCount = db.prepare("SELECT COUNT(*) as cnt FROM career_logs").get().cnt;
  const learningCount = db.prepare("SELECT COUNT(*) as cnt FROM learning_logs WHERE source_service = 'external'").get().cnt;
  return {
    diagnosis: diagCount,
    reading: readingCount,
    career: careerCount,
    externalLearning: learningCount,
    total: diagCount + readingCount + careerCount + learningCount
  };
}

// ========== 성장 리포트 — 카드 세부 내역 Drill-down (기획서: 성장리포트_내역_drilldown_스펙.md) ==========
// 카드의 개별 항목 클릭 시 그 실제 내역(제목·날짜·목록)을 반환한다.
// 통일 응답: { type, title, count, items:[{primary, meta, date, badge?, result?}] }
// 카운트 일치(스펙 §2-3 / 체크리스트 ⓗ)가 최우선: 카드 배지 숫자를 만든 동일 필터(user+class+기간)를 그대로 사용.

// 감정 코드 → 한글 라벨 + 이모지 (attendance/emotion 타입 표시용)
const EMOTION_LABEL = {
  happy: '행복해요', excited: '신나요', great: '최고예요', good: '좋아요', calm: '평온해요',
  tired: '피곤해요', sad: '슬퍼요', angry: '화나요', anxious: '불안해요', frustrated: '답답해요'
};
const EMOTION_EMOJI = {
  happy: '😊', excited: '🤩', great: '😆', good: '🙂', calm: '😌',
  tired: '😪', sad: '😢', angry: '😠', anxious: '😰', frustrated: '😣'
};
const POSITIVE_EMO_SET = new Set(['happy', 'excited', 'good', 'great', 'calm']);

// 게시판 카테고리 한글 + tone (게시판 kind 전수 — 영문 원시값 노출 0)
const POST_CATEGORY = {
  notice: { text: '공지', tone: 'warning' }, general: { text: '일반', tone: 'neutral' },
  question: { text: '질문', tone: 'info' }, qna: { text: '질문', tone: 'info' },
  free: { text: '자유', tone: 'neutral' }, share: { text: '공유', tone: 'success' },
  study: { text: '학습', tone: 'info' }, gallery: { text: '갤러리', tone: 'info' },
  class: { text: '클래스', tone: 'neutral' }, artist: { text: '나도예술가', tone: 'info' }
};

// 포트폴리오 활동유형(activity_type) 한글 — content_portfolio 모달 meta 의 영문 원시값 번역(M-1)
const PORTFOLIO_ACTIVITY_KO = {
  homework_submit: '과제 제출', homework_graded: '과제 채점', homework: '과제',
  exam_complete: '평가 응시', wrong_note_retry: '오답 복습', problem_attempt: '문항 풀이',
  diagnosis_complete: 'AI 진단', self_learn: '스스로채움', extracurricular: '교과 외 활동'
};
// 포트폴리오 출처(source_type) 한글 + tone — content_portfolio 모달 badge 의 영문 원시값 번역(M-1)
const PORTFOLIO_SOURCE_KO = {
  class: { text: '채움클래스', tone: 'info' }, 'self-learn': { text: '스스로채움', tone: 'success' },
  self_learn: { text: '스스로채움', tone: 'success' }, cbt: { text: '채움CBT', tone: 'danger' },
  homework: { text: '과제', tone: 'neutral' }, custom: { text: '직접 추가', tone: 'neutral' }
};
function koPortfolioActivity(v) {
  if (!v) return v;
  if (PORTFOLIO_ACTIVITY_KO[v]) return PORTFOLIO_ACTIVITY_KO[v];
  if (/[가-힣]/.test(v)) return v; // 이미 한글이면 그대로(예: '동아리')
  return v;
}
// 과목 코드(korean-e, math-e …) 한글화 — portfolio_items.subject 가 코드값인 경우(M-1 추가).
// db/curriculum.js subjectData 와 동일 명칭. 레벨접미사(-e/-m/-h) 무관하게 베이스명으로 매핑.
const SUBJECT_BASE_KO = {
  korean: '국어', math: '수학', social: '사회', science: '과학', english: '영어',
  info: '정보', moral: '도덕', music: '음악', art: '미술', pe: '체육',
  practical: '실과', history: '역사'
};
function koSubject(v) {
  if (!v) return v;
  if (/[가-힣]/.test(v)) return v; // 이미 한글 과목명
  const base = String(v).toLowerCase().replace(/-(e|m|h)$/, '');
  return SUBJECT_BASE_KO[base] || v;
}

// 콘텐츠 유형 한글 (contents.content_type 전수 — 모달 badge 영문 원시값 0)
const CONTENT_TYPE_KO = {
  video: '영상', document: '문서', image: '이미지', audio: '음원', link: '링크',
  quiz: '퀴즈', interactive: '인터랙티브', pdf: 'PDF', html: 'HTML',
  package: '꾸러미', lesson_bundle: '수업 묶음', exam: '평가', assessment: '평가',
  recipe: '레시피', activity: '학습활동'
};

// 출처(성취 6종) 한글 라벨 + tone (도넛 3타일 합산 모달의 badge)
const ACH_SOURCE_LABEL = {
  today_learning: { text: '오늘의 학습', tone: 'success' },
  ai_learning:    { text: 'AI 맞춤학습', tone: 'info' },
  wrong_note:     { text: '오답노트', tone: 'warning' },
  content:        { text: '콘텐츠 문항', tone: 'neutral' },
  class_exam:     { text: '클래스 평가', tone: 'info' },
  cbt_exam:       { text: 'CBT 감독평가', tone: 'danger' }
};

// ───────────────────────────────────────────────────────────────────────────
// 드릴 가능 활동유형 막대 ↔ 모달 단일 카운트 소스 (감리 H-1·H-2 해소)
//
// 참여도 "활동 유형 Top" 막대 중 FE(ACT_TO_DETAIL_TYPE)가 드릴 가능으로 표시하는
// 모든 detail type 의 카드 카운트를 getReportDetail(type).count 와 "동일한 원천·동일한 필터"로
// 산출한다. learning_logs COUNT(*) 는 막대 카운트에서 완전히 제거(LRS 등 타 소비처 무영향).
//
// 막대 activity_type → detail type 매핑(1:1)·대표 activity_type:
//   post_create          → post              (posts)
//   attendance_checkin   → attendance        (attendance)
//   survey_respond       → survey            (survey_responses⨝surveys)
//   homework_submit      → homework          (homework_submissions)
//   exam_complete        → exam              (exam_students⨝exams)
//   lesson_complete      → lesson            (lesson_self_check) ※ lesson_view/progress 는 흡수·제거
//   content_view         → content_viewed    (COUNT(DISTINCT object_id) — 모달과 동일)
//   diagnosis_complete   → ai_learning       (diagnosis_sessions + problem_attempts[ai_learning])
//   daily_complete       → today_learning    (daily_learning_progress[completed], 세트 스코프) ※ problem_set_complete 흡수
//   portfolio_add        → content_portfolio (portfolio_items)
//
// 각 분기는 getReportDetail 의 동일 case 가 사용하는 count 쿼리와 글자 그대로 같은 WHERE 를 쓴다.
// detail count 가 변하면 이 함수도 함께 고쳐 단일 소스를 유지할 것.
function detailCountFor(studentId, detailType, opts = {}) {
  const { classId, startDate, endDate } = opts;
  const hasRange = !!(startDate && endDate);
  const rc = (col) => `DATE(${col}) BETWEEN ? AND ?`;
  const rp = () => [startDate, endDate];
  const classFilter = (col) => {
    if (classId) return { clause: `${col} = ?`, params: [classId] };
    return {
      clause: `${col} IN (
        SELECT cm.class_id FROM class_members cm
        WHERE cm.user_id = ? AND cm.role = 'member' AND cm.status = 'active'
          AND cm.class_id NOT IN (SELECT id FROM classes WHERE owner_id = ?)
      )`,
      params: [studentId, studentId]
    };
  };
  switch (detailType) {
    case 'post':
      return db.prepare(`SELECT COUNT(*) c FROM posts WHERE author_id = ?${hasRange ? ` AND ${rc('created_at')}` : ''}`)
        .get(studentId, ...(hasRange ? rp() : [])).c;
    case 'attendance':
      return db.prepare(`SELECT COUNT(*) c FROM attendance WHERE user_id = ?${classId ? ' AND class_id = ?' : ''} AND status IS NOT NULL${hasRange ? ` AND ${rc('attendance_date')}` : ''}`)
        .get(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).c;
    case 'survey':
      return db.prepare(`SELECT COUNT(*) c FROM survey_responses sr JOIN surveys s ON s.id = sr.survey_id WHERE sr.user_id = ?${classId ? ' AND s.class_id = ?' : ''}${hasRange ? ` AND ${rc('sr.submitted_at')}` : ''}`)
        .get(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).c;
    case 'homework': {
      const f = classFilter('h.class_id');
      return db.prepare(`SELECT COUNT(*) c FROM homework_submissions hs JOIN homework h ON h.id = hs.homework_id WHERE hs.student_id = ? AND hs.status IN ('submitted','graded') AND ${f.clause}${hasRange ? ` AND ${rc('hs.submitted_at')}` : ''}`)
        .get(studentId, ...f.params, ...(hasRange ? rp() : [])).c;
    }
    case 'exam': {
      const f = classFilter('e.class_id');
      return db.prepare(`SELECT COUNT(*) c FROM exam_students es JOIN exams e ON e.id = es.exam_id WHERE es.user_id = ? AND es.status = 'submitted' AND ${f.clause}${hasRange ? ` AND ${rc('es.submitted_at')}` : ''}`)
        .get(studentId, ...f.params, ...(hasRange ? rp() : [])).c;
    }
    case 'lesson': {
      const f = classFilter('lc.class_id');
      return db.prepare(`SELECT COUNT(*) c FROM lesson_self_check lc WHERE lc.user_id = ? AND ${f.clause}${hasRange ? ` AND ${rc('lc.created_at')}` : ''}`)
        .get(studentId, ...f.params, ...(hasRange ? rp() : [])).c;
    }
    case 'content_viewed':
      // 모달 = GROUP BY object_id 행 수 = COUNT(DISTINCT object_id) (H-1: learning_logs COUNT(*) 아님)
      return db.prepare(`SELECT COUNT(DISTINCT object_id) c FROM learning_logs WHERE user_id = ? AND activity_type = 'content_view'${hasRange ? ` AND ${rc('created_at')}` : ''}`)
        .get(studentId, ...(hasRange ? rp() : [])).c;
    case 'ai_learning': {
      // 모달 merged.length(=diag + problem_attempts[ai_learning], LIMIT 200 미만 시 합) 과 동일.
      const diagN = db.prepare(`SELECT COUNT(*) c FROM diagnosis_sessions WHERE user_id = ? AND status = 'completed'${hasRange ? ` AND ${rc('completed_at')}` : ''}`)
        .get(studentId, ...(hasRange ? rp() : [])).c;
      const paN = db.prepare(`SELECT COUNT(*) c FROM problem_attempts WHERE user_id = ? AND source_type = 'ai_learning'${hasRange ? ` AND ${rc('submitted_at')}` : ''}`)
        .get(studentId, ...(hasRange ? rp() : [])).c;
      return diagN + paN;
    }
    case 'today_learning': {
      // 모달 = daily_learning_progress[completed] 세트스코프 행 수(getStudentReport.dailyStats 와 동일 스코프)
      const stu = db.prepare('SELECT grade FROM users WHERE id = ?').get(studentId);
      const grade = stu ? stu.grade : null;
      let setClause = '', setParams = [];
      if (classId && grade != null) { setClause = ' AND p.set_id IN (SELECT id FROM daily_learning_sets WHERE class_id = ? OR (class_id IS NULL AND target_grade = ?))'; setParams = [classId, grade]; }
      else if (classId) { setClause = ' AND p.set_id IN (SELECT id FROM daily_learning_sets WHERE class_id = ?)'; setParams = [classId]; }
      else if (grade != null) { setClause = ' AND p.set_id IN (SELECT id FROM daily_learning_sets WHERE class_id IS NULL AND target_grade = ?)'; setParams = [grade]; }
      return db.prepare(`SELECT COUNT(*) c FROM daily_learning_progress p WHERE p.user_id = ? AND p.status = 'completed'${hasRange ? ` AND ${rc('p.completed_at')}` : ''}${setClause}`)
        .get(studentId, ...(hasRange ? rp() : []), ...setParams).c;
    }
    case 'content_portfolio':
      return db.prepare(`SELECT COUNT(*) c FROM portfolio_items WHERE user_id = ?${hasRange ? ` AND DATE(created_at) BETWEEN ? AND ?` : ''}`)
        .get(studentId, ...(hasRange ? rp() : [])).c;
    default:
      return null; // 통일 불가 type — 호출부에서 비드릴 처리
  }
}

// 성장 리포트 카드 세부 내역 조회.
// @param studentId  대상 학생 user_id
// @param type       내역 종류 (스펙 §5-2, 총 21종 + 호환 별칭)
// @param opts       { classId, startDate, endDate, source }
// @returns { type, title, count, items } | { _badType: true } (알 수 없는 type)
function getReportDetail(studentId, type, opts = {}) {
  const { classId, startDate, endDate, source } = opts;
  const hasRange = !!(startDate && endDate);
  const LIMIT = 200; // 안전 상한 (스펙 §5-3). count 는 실제 총건수, items 는 최대 200건.

  // computeAreas6 와 동일한 기간 정규화 — DATE(col) BETWEEN 으로 종료일 off-by-one 해소(#6)
  const rc = (col) => `DATE(${col}) BETWEEN ? AND ?`;
  const rp = () => [startDate, endDate];

  // 참여도 클래스 범위(스펙·computeAreas6 §축2 와 동일):
  //  - classId 지정: 그 클래스만 (col = ?)
  //  - 미지정: 학생으로(member) 속한 모든 클래스 합산, 본인 owner 클래스 제외
  const classFilter = (col) => {
    if (classId) return { clause: `${col} = ?`, params: [classId] };
    return {
      clause: `${col} IN (
        SELECT cm.class_id FROM class_members cm
        WHERE cm.user_id = ? AND cm.role = 'member' AND cm.status = 'active'
          AND cm.class_id NOT IN (SELECT id FROM classes WHERE owner_id = ?)
      )`,
      params: [studentId, studentId]
    };
  };

  // 참여도 6유형(post/attendance/survey/homework/exam/lesson) count 는 각 case 에서 실제 원천 테이블로
  // 직접 산출(아래)하여 count == items.length 보장. learning_logs(누락·중복) 의존 제거(스펙).
  const fmtPct = (cc, tq) => (tq > 0 ? Math.round((cc / tq) * 100) : 0);

  switch (type) {

    // ───────── 참여도 ─────────
    case 'post': {
      const items = db.prepare(`
        SELECT title, category, created_at FROM posts
        WHERE author_id = ?${hasRange ? ` AND ${rc('created_at')}` : ''}
        ORDER BY created_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : [])).map(r => {
        const cat = POST_CATEGORY[r.category] || (r.category ? { text: r.category, tone: 'neutral' } : null);
        return { primary: r.title || '제목 없음', meta: '', date: r.created_at, badge: cat };
      });
      // count = 실제 원천(posts) — items 와 동일 WHERE → count == items.length (스펙: learning_logs 신뢰불가)
      const count = db.prepare(`
        SELECT COUNT(*) c FROM posts
        WHERE author_id = ?${hasRange ? ` AND ${rc('created_at')}` : ''}
      `).get(studentId, ...(hasRange ? rp() : [])).c;
      return { type, title: '게시물 작성 내역', count, items };
    }

    case 'attendance': {
      const items = db.prepare(`
        SELECT attendance_date, comment, emotion, checked_at FROM attendance
        WHERE user_id = ?${classId ? ' AND class_id = ?' : ''} AND status IS NOT NULL
          ${hasRange ? ` AND ${rc('attendance_date')}` : ''}
        ORDER BY attendance_date DESC, checked_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).map(r => {
        const e = normEmotion(r.emotion);
        return {
          primary: r.attendance_date || '',
          meta: r.comment ? String(r.comment) : '',
          date: r.checked_at || r.attendance_date,
          badge: e ? { text: EMOTION_EMOJI[e] || '', tone: 'neutral' } : null
        };
      });
      // count = 실제 원천(attendance) — items 와 동일 WHERE → count == items.length
      const count = db.prepare(`
        SELECT COUNT(*) c FROM attendance
        WHERE user_id = ?${classId ? ' AND class_id = ?' : ''} AND status IS NOT NULL${hasRange ? ` AND ${rc('attendance_date')}` : ''}
      `).get(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).c;
      return { type, title: '출석 체크인 내역', count, items };
    }

    case 'survey': {
      const items = db.prepare(`
        SELECT s.title, sr.answers, sr.submitted_at FROM survey_responses sr
        JOIN surveys s ON s.id = sr.survey_id
        WHERE sr.user_id = ?${classId ? ' AND s.class_id = ?' : ''}
          ${hasRange ? ` AND ${rc('sr.submitted_at')}` : ''}
        ORDER BY sr.submitted_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).map(r => {
        let n = 0;
        try { const a = JSON.parse(r.answers || '[]'); n = Array.isArray(a) ? a.length : Object.keys(a || {}).length; } catch { n = 0; }
        return { primary: r.title || '설문', meta: n > 0 ? `응답 ${n}문항` : '', date: r.submitted_at };
      });
      // count = 실제 원천(survey_responses⨝surveys) — items 와 동일 WHERE → count == items.length
      const count = db.prepare(`
        SELECT COUNT(*) c FROM survey_responses sr
        JOIN surveys s ON s.id = sr.survey_id
        WHERE sr.user_id = ?${classId ? ' AND s.class_id = ?' : ''}${hasRange ? ` AND ${rc('sr.submitted_at')}` : ''}
      `).get(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : [])).c;
      return { type, title: '설문 응답 내역', count, items };
    }

    case 'homework': {
      const hwF = classFilter('h.class_id');
      const items = db.prepare(`
        SELECT h.title, hs.status, hs.score, hs.submitted_at FROM homework_submissions hs
        JOIN homework h ON h.id = hs.homework_id
        WHERE hs.student_id = ? AND hs.status IN ('submitted','graded') AND ${hwF.clause}
          ${hasRange ? ` AND ${rc('hs.submitted_at')}` : ''}
        ORDER BY hs.submitted_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...hwF.params, ...(hasRange ? rp() : [])).map(r => {
        const graded = r.status === 'graded';
        return {
          primary: r.title || '과제',
          meta: graded ? (r.score != null ? `채점완료 · ${r.score}점` : '채점완료') : '제출',
          date: r.submitted_at,
          badge: graded ? { text: '채점완료', tone: 'success' } : { text: '제출', tone: 'info' }
        };
      });
      // count = 실제 원천(homework_submissions) — items 와 동일 WHERE → count == items.length
      const count = db.prepare(`
        SELECT COUNT(*) c FROM homework_submissions hs
        JOIN homework h ON h.id = hs.homework_id
        WHERE hs.student_id = ? AND hs.status IN ('submitted','graded') AND ${hwF.clause}${hasRange ? ` AND ${rc('hs.submitted_at')}` : ''}
      `).get(studentId, ...hwF.params, ...(hasRange ? rp() : [])).c;
      return { type, title: '과제 제출 내역', count, items };
    }

    case 'exam': {
      const exF = classFilter('e.class_id');
      const items = db.prepare(`
        SELECT e.title, es.score, es.submitted_at FROM exam_students es
        JOIN exams e ON e.id = es.exam_id
        WHERE es.user_id = ? AND es.status = 'submitted' AND ${exF.clause}
          ${hasRange ? ` AND ${rc('es.submitted_at')}` : ''}
        ORDER BY es.submitted_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...exF.params, ...(hasRange ? rp() : [])).map(r => ({
        primary: r.title || '평가',
        meta: r.score != null ? `${r.score}점` : '응시 완료',
        date: r.submitted_at
      }));
      // count = 실제 원천(exam_students) — items 와 동일 WHERE → count == items.length
      const count = db.prepare(`
        SELECT COUNT(*) c FROM exam_students es
        JOIN exams e ON e.id = es.exam_id
        WHERE es.user_id = ? AND es.status = 'submitted' AND ${exF.clause}${hasRange ? ` AND ${rc('es.submitted_at')}` : ''}
      `).get(studentId, ...exF.params, ...(hasRange ? rp() : [])).c;
      return { type, title: '평가 응시 내역', count, items };
    }

    case 'lesson': {
      const lsF = classFilter('lc.class_id');
      const items = db.prepare(`
        SELECT l.title, lc.created_at, lc.understanding FROM lesson_self_check lc
        JOIN lessons l ON l.id = lc.lesson_id
        WHERE lc.user_id = ? AND ${lsF.clause}${hasRange ? ` AND ${rc('lc.created_at')}` : ''}
        ORDER BY lc.created_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...lsF.params, ...(hasRange ? rp() : [])).map(r => ({
        primary: r.title || '수업', meta: '수업 이수', date: r.created_at
      }));
      // count = 실제 원천(lesson_self_check) — items 와 동일 WHERE → count == items.length
      // (카드도 lesson_self_check 기반 단일 대표행으로 통일 — getStudentReport.learningCapacity 참조)
      const count = db.prepare(`
        SELECT COUNT(*) c FROM lesson_self_check lc
        WHERE lc.user_id = ? AND ${lsF.clause}${hasRange ? ` AND ${rc('lc.created_at')}` : ''}
      `).get(studentId, ...lsF.params, ...(hasRange ? rp() : [])).c;
      return { type, title: '수업 이수 내역', count, items };
    }

    // ───────── 성취수준 6출처 ─────────
    case 'today_learning': {
      // daily_learning_progress(완료) 세트 스코프는 getStudentReport 와 동일하게 학년/클래스 매칭.
      const student = db.prepare('SELECT grade FROM users WHERE id = ?').get(studentId);
      const grade = student ? student.grade : null;
      let setClause = '', setParams = [];
      if (classId && grade != null) { setClause = ' AND p.set_id IN (SELECT id FROM daily_learning_sets WHERE class_id = ? OR (class_id IS NULL AND target_grade = ?))'; setParams = [classId, grade]; }
      else if (classId) { setClause = ' AND p.set_id IN (SELECT id FROM daily_learning_sets WHERE class_id = ?)'; setParams = [classId]; }
      else if (grade != null) { setClause = ' AND p.set_id IN (SELECT id FROM daily_learning_sets WHERE class_id IS NULL AND target_grade = ?)'; setParams = [grade]; }
      const rows = db.prepare(`
        SELECT p.set_id, s.title, p.correct_count, p.total_questions, p.score, p.completed_at
        FROM daily_learning_progress p LEFT JOIN daily_learning_sets s ON s.id = p.set_id
        WHERE p.user_id = ? AND p.status = 'completed'${hasRange ? ` AND ${rc('p.completed_at')}` : ''}${setClause}
        ORDER BY p.completed_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []), ...setParams);
      const items = rows.map(r => {
        const c = r.correct_count || 0, t = r.total_questions || 0;
        return {
          primary: r.title || (r.completed_at ? String(r.completed_at).slice(0, 10) : '오늘의 학습'),
          meta: t > 0 ? `정답 ${c} / ${t}문항 · ${fmtPct(c, t)}%` : '완료',
          date: r.completed_at,
          badge: { text: '완료', tone: 'success' }
        };
      });
      return { type, title: '오늘의 학습 내역', count: rows.length, items };
    }

    case 'ai_learning': {
      // 진단(diagnosis_sessions) + problem_attempts(source_type='ai_learning'). 카드 ai_learning.total 과 일치.
      const diag = db.prepare(`
        SELECT d.target_node_id, n.unit_name, n.subject, d.correct_count, d.total_questions, d.completed_at
        FROM diagnosis_sessions d LEFT JOIN learning_map_nodes n ON n.node_id = d.target_node_id
        WHERE d.user_id = ? AND d.status = 'completed'${hasRange ? ` AND ${rc('d.completed_at')}` : ''}
      `).all(studentId, ...(hasRange ? rp() : [])).map(r => ({
        kind: 'diag',
        primary: `진단평가 · ${r.subject || ''}${r.unit_name ? ' ' + r.unit_name : ''}`.trim() || '진단평가',
        meta: r.total_questions ? `정답 ${r.correct_count || 0} / ${r.total_questions}문항` : '',
        date: r.completed_at,
        badge: { text: `정답률 ${fmtPct(r.correct_count || 0, r.total_questions || 0)}%`, tone: 'info' }
      }));
      const pa = paAttemptItems(studentId, 'ai_learning', hasRange, rc, rp, LIMIT);
      const merged = [...diag, ...pa].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, LIMIT);
      const count = merged.length === LIMIT
        ? (diag.length + paAttemptCount(studentId, 'ai_learning', hasRange, rc, rp))
        : merged.length;
      return { type, title: 'AI 맞춤학습 내역', count, items: merged.map(stripKind) };
    }

    case 'wrong_note': {
      const items = paAttemptItems(studentId, 'wrong_note', hasRange, rc, rp, LIMIT).map(stripKind);
      return { type, title: '오답노트 다시 풀기 내역', count: paAttemptCount(studentId, 'wrong_note', hasRange, rc, rp), items };
    }

    case 'content_problem':
    case 'content': {
      const items = paAttemptItems(studentId, 'content', hasRange, rc, rp, LIMIT).map(stripKind);
      return { type: 'content_problem', title: '콘텐츠 문항 풀이 내역', count: paAttemptCount(studentId, 'content', hasRange, rc, rp), items };
    }

    case 'class_exam':
    case 'cbt_exam': {
      const cbt = type === 'cbt_exam';
      const exClause = classId ? ' AND e.class_id = ?' : '';
      const modeClause = cbt ? "e.start_mode = 'waiting'" : "COALESCE(e.start_mode,'direct') != 'waiting'";
      const rows = db.prepare(`
        SELECT e.title, e.question_count, es.score, es.submitted_at FROM exam_students es
        JOIN exams e ON e.id = es.exam_id
        WHERE es.user_id = ? AND es.status = 'submitted' AND es.score IS NOT NULL AND ${modeClause}${exClause}
          ${hasRange ? ` AND ${rc('es.submitted_at')}` : ''}
        ORDER BY es.submitted_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : []));
      const items = rows.map(r => {
        const qc = r.question_count || 0;
        const correct = qc > 0 ? Math.round((r.score / 100) * qc) : null;
        return {
          primary: r.title || '평가',
          meta: `${r.score}점${correct != null ? ` · 정답 ${correct}/${qc}` : ''}`,
          date: r.submitted_at,
          badge: cbt ? { text: '감독', tone: 'danger' } : null
        };
      });
      return { type, title: cbt ? '채움CBT 감독 평가 내역' : '채움클래스 평가 내역', count: rows.length, items };
    }

    // ───────── 성취 도넛 3타일 (합산) ─────────
    case 'ach_self_directed': {
      // today_learning ∪ ai_learning ∪ content ∪ wrong_note — 각 행에 출처 badge
      const all = [];
      // today_learning
      const tl = getReportDetail(studentId, 'today_learning', opts).items.map(it => ({ ...it, badge: ACH_SOURCE_LABEL.today_learning }));
      // ai_learning (진단+pa)
      const ai = getReportDetail(studentId, 'ai_learning', opts).items.map(it => ({ ...it, badge: ACH_SOURCE_LABEL.ai_learning }));
      const cp = paAttemptItems(studentId, 'content', hasRange, rc, rp, LIMIT).map(stripKind).map(it => ({ ...it, badge: ACH_SOURCE_LABEL.content }));
      const wn = paAttemptItems(studentId, 'wrong_note', hasRange, rc, rp, LIMIT).map(stripKind).map(it => ({ ...it, badge: ACH_SOURCE_LABEL.wrong_note }));
      all.push(...tl, ...ai, ...cp, ...wn);
      all.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return { type, title: '자기주도 학습 풀이 내역', count: all.length, items: all.slice(0, LIMIT) };
    }
    case 'ach_class_eval': {
      const ce = getReportDetail(studentId, 'class_exam', opts).items.map(it => ({ ...it, badge: ACH_SOURCE_LABEL.class_exam }));
      const cb = getReportDetail(studentId, 'cbt_exam', opts).items.map(it => ({ ...it, badge: ACH_SOURCE_LABEL.cbt_exam }));
      const all = [...ce, ...cb].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return { type, title: '클래스평가 응시 내역', count: all.length, items: all.slice(0, LIMIT) };
    }
    case 'ach_diagnosis': {
      const rows = db.prepare(`
        SELECT d.target_node_id, n.unit_name, n.subject, d.correct_count, d.total_questions, d.completed_at
        FROM diagnosis_sessions d LEFT JOIN learning_map_nodes n ON n.node_id = d.target_node_id
        WHERE d.user_id = ? AND d.status = 'completed'${hasRange ? ` AND ${rc('d.completed_at')}` : ''}
        ORDER BY d.completed_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const items = rows.map(r => ({
        primary: `${r.subject || '진단'}${r.unit_name ? ' ' + r.unit_name : ''} 진단평가`.trim(),
        meta: r.total_questions ? `정답 ${r.correct_count || 0} / ${r.total_questions}문항 · ${fmtPct(r.correct_count || 0, r.total_questions || 0)}%` : '',
        date: r.completed_at
      }));
      return { type, title: '진단(기초학력) 내역', count: rows.length, items };
    }

    // ───────── 정서 ─────────
    case 'emotion': {
      const src = source || 'all';
      const rows = db.prepare(`
        SELECT attendance_date, emotion, emotion_reason, checked_at FROM attendance
        WHERE user_id = ?${classId ? ' AND class_id = ?' : ''} AND emotion IS NOT NULL
          ${hasRange ? ` AND ${rc('attendance_date')}` : ''}
        ORDER BY attendance_date DESC, checked_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(classId ? [classId] : []), ...(hasRange ? rp() : []))
        .map(r => ({ ...r, e: normEmotion(r.emotion) }))
        .filter(r => src === 'all' ? true : (src === 'positive' ? POSITIVE_EMO_SET.has(r.e) : !POSITIVE_EMO_SET.has(r.e)));
      const items = rows.map(r => ({
        primary: EMOTION_LABEL[r.e] || r.e || '감정',
        meta: r.emotion_reason ? String(r.emotion_reason) : '',
        date: r.checked_at || r.attendance_date,
        badge: { text: EMOTION_EMOJI[r.e] || '', tone: POSITIVE_EMO_SET.has(r.e) ? 'success' : 'neutral' }
      }));
      const titleMap = { positive: '긍정 감정 체크인 내역', negative: '부정 감정 체크인 내역', all: '감정 체크인 내역' };
      return { type, title: titleMap[src] || titleMap.all, count: items.length, items };
    }

    // ───────── 진로 ─────────
    case 'career': {
      const items = db.prepare(`
        SELECT title, activity_type, activity_date FROM career_logs
        WHERE user_id = ?${hasRange ? ` AND ${rc('activity_date')}` : ''}
        ORDER BY activity_date DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : [])).map(r => ({
        primary: r.title || '진로 활동', meta: r.activity_type || '', date: r.activity_date
      }));
      const count = db.prepare(`SELECT COUNT(*) c FROM career_logs WHERE user_id = ?${hasRange ? ` AND ${rc('activity_date')}` : ''}`).get(studentId, ...(hasRange ? rp() : [])).c;
      return { type, title: '진로 탐색 활동 내역', count, items };
    }
    case 'career_interest': {
      const rows = db.prepare(`
        SELECT interest_area, COUNT(*) cnt, MAX(activity_date) last_date FROM career_logs
        WHERE user_id = ? AND interest_area IS NOT NULL AND interest_area != ''${hasRange ? ` AND ${rc('activity_date')}` : ''}
        GROUP BY interest_area ORDER BY cnt DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const items = rows.map(r => ({ primary: r.interest_area, meta: `입력 ${r.cnt}회`, date: r.last_date }));
      return { type, title: '관심 분야 내역', count: rows.length, items };
    }

    // ───────── 독서 ─────────
    case 'reading': {
      const rows = db.prepare(`
        SELECT book_title, author, rating, read_date FROM reading_logs
        WHERE user_id = ?${hasRange ? ` AND ${rc('read_date')}` : ''}
        ORDER BY read_date DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const count = db.prepare(`SELECT COUNT(*) c FROM reading_logs WHERE user_id = ?${hasRange ? ` AND ${rc('read_date')}` : ''}`).get(studentId, ...(hasRange ? rp() : [])).c;
      const items = rows.map(r => {
        const stars = r.rating ? '★'.repeat(Math.min(5, Math.max(0, Math.round(r.rating)))) : '';
        return { primary: r.book_title || '책', meta: [r.author, stars].filter(Boolean).join(' · '), date: r.read_date };
      });
      return { type, title: '독서 기록 내역', count, items };
    }

    // ───────── 콘텐츠 활용 ─────────
    case 'content_saved': {
      const rows = db.prepare(`
        SELECT cc.folder_name, cc.created_at, c.title, c.content_type FROM content_collections cc
        LEFT JOIN contents c ON c.id = cc.content_id
        WHERE cc.user_id = ?${hasRange ? ` AND ${rc('cc.created_at')}` : ''}
        ORDER BY cc.created_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const count = db.prepare(`SELECT COUNT(*) c FROM content_collections WHERE user_id = ?${hasRange ? ` AND ${rc('created_at')}` : ''}`).get(studentId, ...(hasRange ? rp() : [])).c;
      const items = rows.map(r => ({
        primary: r.title || '콘텐츠', meta: r.folder_name || '', date: r.created_at,
        badge: r.content_type ? { text: CONTENT_TYPE_KO[r.content_type] || r.content_type, tone: 'info' } : null
      }));
      return { type, title: '보관함 저장 내역', count, items };
    }
    case 'content_viewed': {
      // object_id 가 'urn:...:content:NN' 또는 'NN' 혼재 → 끝의 숫자만 추출해 contents 조인.
      const rows = db.prepare(`
        SELECT object_id, COUNT(*) cnt, MAX(created_at) last_date
        FROM learning_logs WHERE user_id = ? AND activity_type = 'content_view'${hasRange ? ` AND ${rc('created_at')}` : ''}
        GROUP BY object_id ORDER BY last_date DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const items = rows.map(r => {
        const m = String(r.object_id || '').match(/(\d+)\s*$/);
        let title = null, ctype = null;
        if (m) { const c = db.prepare('SELECT title, content_type FROM contents WHERE id = ?').get(parseInt(m[1], 10)); if (c) { title = c.title; ctype = c.content_type; } }
        return {
          primary: title || '콘텐츠', meta: r.cnt > 1 ? `조회 ${r.cnt}회` : '', date: r.last_date,
          badge: ctype ? { text: CONTENT_TYPE_KO[ctype] || ctype, tone: 'info' } : null
        };
      });
      // [카드=내역 fix, INV4] count 는 실제 총건수(본 함수 상단 계약 L2504) — 과거 rows.length(LIMIT 200
      //   후 값)를 반환해 DISTINCT object_id 가 200을 넘는 순간 막대(detailCountFor: 비상한 207)와
      //   모달 count(200)가 어긋났다. 막대와 글자 그대로 같은 비상한 COUNT(DISTINCT) 로 단일 소스화.
      //   items 는 최대 200건 유지(형제 분기 content_collections·channel_subscriptions 와 동일 패턴).
      const count = db.prepare(`
        SELECT COUNT(DISTINCT object_id) c FROM learning_logs
        WHERE user_id = ? AND activity_type = 'content_view'${hasRange ? ` AND ${rc('created_at')}` : ''}
      `).get(studentId, ...(hasRange ? rp() : [])).c;
      return { type, title: '콘텐츠 조회 내역', count, items };
    }
    case 'content_subscribed': {
      const rows = db.prepare(`
        SELECT ch.name, u.display_name AS oper, cs.subscribed_at FROM channel_subscriptions cs
        JOIN channels ch ON ch.id = cs.channel_id LEFT JOIN users u ON u.id = ch.user_id
        WHERE cs.subscriber_id = ?${hasRange ? ` AND ${rc('cs.subscribed_at')}` : ''}
        ORDER BY cs.subscribed_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const count = db.prepare(`SELECT COUNT(*) c FROM channel_subscriptions WHERE subscriber_id = ?${hasRange ? ` AND ${rc('subscribed_at')}` : ''}`).get(studentId, ...(hasRange ? rp() : [])).c;
      const items = rows.map(r => ({ primary: r.name || '채널', meta: r.oper ? `${r.oper} 운영` : '', date: r.subscribed_at }));
      return { type, title: '구독 채널 내역', count, items };
    }
    case 'content_portfolio': {
      const rows = db.prepare(`
        SELECT activity_name, subject, activity_type, source_type, COALESCE(activity_date, DATE(created_at)) AS d FROM portfolio_items
        WHERE user_id = ?${hasRange ? ` AND DATE(created_at) BETWEEN ? AND ?` : ''}
        ORDER BY d DESC, created_at DESC LIMIT ${LIMIT}
      `).all(studentId, ...(hasRange ? rp() : []));
      const count = db.prepare(`SELECT COUNT(*) c FROM portfolio_items WHERE user_id = ?${hasRange ? ` AND DATE(created_at) BETWEEN ? AND ?` : ''}`).get(studentId, ...(hasRange ? rp() : [])).c;
      const items = rows.map(r => ({
        primary: r.activity_name || '활동',
        // subject(과목 코드)·activity_type 영문 원시값 → 한글(M-1).
        meta: [koSubject(r.subject), koPortfolioActivity(r.activity_type)].filter(Boolean).join(' · '),
        date: r.d,
        // source_type 영문 원시값 → 한글 badge(M-1)
        badge: r.source_type
          ? (PORTFOLIO_SOURCE_KO[r.source_type] || { text: r.source_type, tone: 'neutral' })
          : null
      }));
      return { type, title: '포트폴리오 내역', count, items };
    }

    default:
      return { _badType: true };
  }
}

// problem_attempts(source_type) 행 → items. node_id 로 단원/과목 표기, is_correct 로 O/X result.
function paAttemptItems(studentId, sourceType, hasRange, rc, rp, LIMIT) {
  return db.prepare(`
    SELECT pa.node_id, pa.content_id, pa.is_correct, pa.submitted_at,
           n.subject, n.unit_name, n.lesson_name, c.title AS content_title
    FROM problem_attempts pa
    LEFT JOIN learning_map_nodes n ON n.node_id = pa.node_id
    LEFT JOIN contents c ON c.id = pa.content_id
    WHERE pa.user_id = ? AND pa.source_type = ?${hasRange ? ` AND ${rc('pa.submitted_at')}` : ''}
    ORDER BY pa.submitted_at DESC LIMIT ${LIMIT}
  `).all(studentId, sourceType, ...(hasRange ? rp() : [])).map(r => {
    const unit = [r.subject, r.unit_name || r.lesson_name].filter(Boolean).join(' ');
    return {
      kind: 'pa',
      primary: unit || r.content_title || (r.node_id ? `문항 ${r.node_id}` : '문항'),
      meta: r.is_correct ? '정답' : '오답',
      date: r.submitted_at,
      result: r.is_correct ? 'correct' : 'incorrect'
    };
  });
}
function paAttemptCount(studentId, sourceType, hasRange, rc, rp) {
  return db.prepare(`
    SELECT COUNT(*) c FROM problem_attempts WHERE user_id = ? AND source_type = ?${hasRange ? ` AND ${rc('submitted_at')}` : ''}
  `).get(studentId, sourceType, ...(hasRange ? rp() : [])).c;
}
function stripKind(it) { const { kind, ...rest } = it; return rest; }

module.exports = {
  autoAddPortfolioItem,
  getReportDetail,
  getPortfolioItems, getPortfolioItemDetail, toggleLifeTask, saveReflection, updatePrivacy,
  getPortfolioStats, getGrowthGoals, createGrowthGoal, updateGrowthGoal, deleteGrowthGoal,
  createPortfolioItem, getCompetencyStats,
  // PDF 보고서
  createPortfolioReport, attachPortfolioReportFile, saveGeneratedReport,
  getPortfolioReportById, getPortfolioReports, deletePortfolioReport,
  reportsDirFor,   // [W4] 저장 경로 SSOT — routes/growth.js 가 경로를 손으로 다시 조립하지 않도록 공개
  getPortfolioReportData,
  // 학교급 helper
  gradeToSchoolLevel, schoolLevelLabel, schoolLevelToGradeRange,
  getClassDashboard, getStudentReport, getStudentReportArea, getClassDailyLearning, computeAreas6,
  createObservation, getObservations,
  getReadingLogs, addReadingLog, updateReadingLog, deleteReadingLog,
  getCareerLogs, addCareerLog, updateCareerLog, deleteCareerLog,
  setReportVisibility, getParentReport,
  // Ingest 게이트웨이
  ingestDiagnosis, ingestDiagnosisBatch,
  ingestReading, ingestReadingBatch,
  ingestCareer, ingestCareerBatch,
  ingestLearningLog, ingestEmotion,
  getIngestStats
};
