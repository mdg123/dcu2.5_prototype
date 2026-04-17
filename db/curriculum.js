// db/curriculum.js
// 2022 개정 교육과정 메타데이터 (엑셀 기반 실제 성취기준 920개)
const db = require('./index');
const path = require('path');
const fs = require('fs');

function initCurriculum() {
  // ── 교과 참조 테이블 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      school_level TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      CHECK(school_level IN ('초', '중', '고', '공통'))
    );
  `);

  // ── 성취기준 테이블 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS curriculum_standards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      subject_code TEXT NOT NULL,
      school_level TEXT NOT NULL,
      grade_group INTEGER NOT NULL,
      grade_label TEXT,
      area TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (subject_code) REFERENCES subjects(code)
    );
    CREATE INDEX IF NOT EXISTS idx_curriculum_subject ON curriculum_standards(subject_code, grade_group);
    CREATE INDEX IF NOT EXISTS idx_curriculum_grade ON curriculum_standards(school_level, grade_group);
  `);

  // ── 교과 시드 데이터 ──
  const insertSubject = db.prepare(`
    INSERT OR IGNORE INTO subjects (code, name, school_level, sort_order)
    VALUES (?, ?, ?, ?)
  `);

  const subjectData = [
    ['korean-e', '국어', '초', 1], ['math-e', '수학', '초', 2],
    ['social-e', '사회', '초', 3], ['science-e', '과학', '초', 4],
    ['english-e', '영어', '초', 5], ['info-e', '정보', '초', 6],
    ['moral-e', '도덕', '초', 7], ['music-e', '음악', '초', 8],
    ['art-e', '미술', '초', 9], ['pe-e', '체육', '초', 10],
    ['practical-e', '실과', '초', 11],
    ['korean-m', '국어', '중', 1], ['math-m', '수학', '중', 2],
    ['social-m', '사회', '중', 3], ['history-m', '역사', '중', 4],
    ['science-m', '과학', '중', 5], ['english-m', '영어', '중', 6],
    ['info-m', '정보', '중', 7],
    ['korean-h', '국어', '고', 1], ['math-h', '수학', '고', 2],
    ['social-h', '사회', '고', 3], ['history-h', '역사', '고', 4],
    ['science-h', '과학', '고', 5], ['english-h', '영어', '고', 6],
    ['info-h', '정보', '고', 7],
  ];

  for (const s of subjectData) {
    insertSubject.run(...s);
  }

  // ── 성취기준 시드 데이터 (JSON 파일에서 로드) ──
  const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM curriculum_standards').get().cnt;
  if (existingCount === 0) {
    const dataPath = path.join(__dirname, 'curriculum-data.json');
    if (fs.existsSync(dataPath)) {
      const standards = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      const insertStandard = db.prepare(`
        INSERT OR IGNORE INTO curriculum_standards (code, subject_code, school_level, grade_group, grade_label, area, content, sort_order)
        VALUES (@code, @subject_code, @school_level, @grade_group, @grade_label, @area, @content, @sort_order)
      `);
      const insertMany = db.transaction((rows) => {
        for (const row of rows) {
          insertStandard.run(row);
        }
      });
      insertMany(standards);
      console.log(`[다채움] 교육과정 성취기준 ${standards.length}개 로드 완료`);
    } else {
      console.warn('[다채움] curriculum-data.json 파일이 없습니다.');
    }
  }

  console.log(`[다채움] 교육과정 메타데이터 초기화 완료: 교과 ${subjectData.length}개`);
}

// ── 조회 함수들 ──

function getSubjects(schoolLevel = null) {
  if (schoolLevel) {
    return db.prepare('SELECT * FROM subjects WHERE school_level = ? AND is_active = 1 ORDER BY sort_order').all(schoolLevel);
  }
  return db.prepare('SELECT * FROM subjects WHERE is_active = 1 ORDER BY school_level, sort_order').all();
}

function getStandards({ subjectCode, gradeGroup, schoolLevel, area, search } = {}) {
  let sql = `SELECT cs.*, s.name as subject_name
    FROM curriculum_standards cs
    JOIN subjects s ON cs.subject_code = s.code
    WHERE 1=1`;
  const params = [];
  if (subjectCode) { sql += ' AND cs.subject_code = ?'; params.push(subjectCode); }
  if (gradeGroup) { sql += ' AND cs.grade_group = ?'; params.push(gradeGroup); }
  if (schoolLevel) { sql += ' AND cs.school_level = ?'; params.push(schoolLevel); }
  if (area) { sql += ' AND cs.area = ?'; params.push(area); }
  if (search) {
    // 공백으로 분할하여 각 단어가 모두 매칭 (AND 조합)
    // 검색 대상: 성취기준 내용, 코드, 영역, 교과명, 학교급, 학년군라벨
    // 검색어 전처리: 학교급 별칭 → school_level 값으로 변환
    const schoolAliases = {
      '초등학교': '초', '초등': '초', '초교': '초', '초': '초',
      '중학교': '중', '중등': '중', '중교': '중', '중': '중',
      '고등학교': '고', '고등': '고', '고교': '고', '고': '고'
    };

    const words = search.trim().split(/\s+/).filter(Boolean);
    for (let wi = 0; wi < words.length; wi++) {
      let word = words[wi];

      // 학교급 별칭 치환
      const schoolAlias = schoolAliases[word];
      if (schoolAlias) {
        sql += ` AND cs.school_level = ?`;
        params.push(schoolAlias);
        continue;
      }

      const term = `%${word}%`;
      // 학년 숫자 추출: "3학년" → grade_group 4(초3-4), 9(중1-3) 등
      const gradeMatch = word.match(/^(\d)학년$/);
      if (gradeMatch) {
        const g = parseInt(gradeMatch[1]);
        // 학년이 속하는 학년군: 초(1-2→2, 3-4→4, 5-6→6), 중(1-3→9), 고(1→10)
        const possibleGroups = [];
        if (g <= 2) possibleGroups.push(2);
        if (g >= 3 && g <= 4) possibleGroups.push(4);
        if (g >= 5 && g <= 6) possibleGroups.push(6);
        if (g >= 1 && g <= 3) possibleGroups.push(9);
        if (g === 1) possibleGroups.push(10);
        const groupPlaceholders = possibleGroups.map(() => '?').join(',');
        sql += ` AND (cs.content LIKE ? OR cs.code LIKE ? OR cs.area LIKE ? OR s.name LIKE ? OR cs.school_level LIKE ? OR cs.grade_label LIKE ? OR cs.grade_group IN (${groupPlaceholders}))`;
        params.push(term, term, term, term, term, term, ...possibleGroups);
      } else {
        sql += ` AND (cs.content LIKE ? OR cs.code LIKE ? OR cs.area LIKE ? OR s.name LIKE ? OR cs.school_level LIKE ? OR cs.grade_label LIKE ?)`;
        params.push(term, term, term, term, term, term);
      }
    }
  }
  sql += ' ORDER BY cs.grade_group, cs.sort_order';
  return db.prepare(sql).all(...params);
}

function getStandardByCode(code) {
  return db.prepare('SELECT * FROM curriculum_standards WHERE code = ?').get(code);
}

function getAreas(subjectCode, gradeGroup = null) {
  let sql = 'SELECT area FROM curriculum_standards WHERE subject_code = ?';
  const params = [subjectCode];
  if (gradeGroup) { sql += ' AND grade_group = ?'; params.push(gradeGroup); }
  sql += ' GROUP BY area ORDER BY MIN(sort_order)';
  return db.prepare(sql).all(...params).map(r => r.area);
}

function getSubjectsBySchoolLevel(schoolLevel) {
  // 해당 학교급에 성취기준이 실제로 있는 교과만 반환
  return db.prepare(`
    SELECT DISTINCT s.code, s.name, s.school_level, s.sort_order
    FROM subjects s
    INNER JOIN curriculum_standards cs ON cs.subject_code = s.code
    WHERE s.school_level = ? AND s.is_active = 1
    GROUP BY s.code
    ORDER BY s.sort_order
  `).all(schoolLevel);
}

function getGradeGroups(subjectCode) {
  return db.prepare(`
    SELECT DISTINCT grade_group, grade_label
    FROM curriculum_standards
    WHERE subject_code = ?
    ORDER BY grade_group
  `).all(subjectCode);
}

module.exports = {
  initCurriculum,
  getSubjects,
  getStandards,
  getStandardByCode,
  getAreas,
  getSubjectsBySchoolLevel,
  getGradeGroups
};
