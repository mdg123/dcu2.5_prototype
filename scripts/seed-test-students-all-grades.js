require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// 학년별 테스트 학생 계정 시드 (오늘의 학습 검증용)
// 8학년 각각 1명씩: 초3·초4·초5·초6·중1·중2·중3·고1
// 비밀번호 동일: 1234 (bcryptjs 해시)
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('./data/dacheum.db');
const hash = bcrypt.hashSync('1234', 10);

const students = [
  { username: 'stu_e3', name: '초3김민준', grade: 3, school_level: 'elementary' },
  { username: 'stu_e4', name: '초4이서연', grade: 4, school_level: 'elementary' },
  { username: 'stu_e5', name: '초5박지호', grade: 5, school_level: 'elementary' },
  { username: 'stu_e6', name: '초6최예린', grade: 6, school_level: 'elementary' },
  { username: 'stu_m1', name: '중1강민서', grade: 1, school_level: 'middle' },
  { username: 'stu_m2', name: '중2윤도윤', grade: 2, school_level: 'middle' },
  { username: 'stu_m3', name: '중3한서아', grade: 3, school_level: 'middle' },
  { username: 'stu_h1', name: '고1정유준', grade: 1, school_level: '고등학교' },
];

const ins = db.prepare(`INSERT OR IGNORE INTO users (username, password, display_name, role, school_name, grade, school_level, status, created_at)
  VALUES (?, ?, ?, 'student', '다채움테스트학교', ?, ?, 'active', datetime('now'))`);
const check = db.prepare("SELECT id FROM users WHERE username=?");
let created = 0, existed = 0;
students.forEach(s => {
  if (check.get(s.username)) { existed++; return; }
  ins.run(s.username, hash, s.name, s.grade, s.school_level);
  created++;
});
console.log('생성:', created, '/ 기존:', existed);
console.log('계정 목록 (모두 비밀번호 1234):');
students.forEach(s => console.log(' -', s.username, '|', s.name, '| grade=' + s.grade, '| level=' + s.school_level));
