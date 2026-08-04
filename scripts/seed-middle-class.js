require('./_stamp-on-write'); // 데이터 변형 자동 표식 — 하네스 재검증 강제(2026-07-31 사고)
// scripts/seed-middle-class.js
// ─────────────────────────────────────────────────────────────────────────────
// KERIS P2 마감4 — middle 시드 계정·반 신설 마이그레이션 (1회 실행·멱등, 로컬+GCP 공용)
//   기획서: 작업지시서/LRS_P2_교사히트맵_타임라인메타_스펙.md §4-4
//
//   배경(실사 §1-5): middle 시드 학생은 학습데이터가 풍부(로그 220~252건·mastery 74~120행·
//   공유 평가 응시 10~12명)하나 전원 class_members 소속 0 → 반 전제 기능(peer-compare 표본,
//   P1-3 classTrend, P2-2 반평균 델타, mastery/class 교사 히트맵) 실검증 불가.
//   기존 시드 자산 재사용 마이그레이션이 최저비용 — 신규 학습데이터 생성 0건.
//
//   수행 내용(스펙 §4-4 시드 스펙 그대로):
//     1. users id=2040(seed_s023 최준혁, middle·1학년) → username='middle1',
//        password=bcrypt('1234') 갱신(id 참조라 무손실·is_seed 유지). 충돌 검사 선행.
//     2. 교사 계정 신규 'mteacher1'/1234 (role teacher, school_level 'middle',
//        school_name 은 2040 과 동일 — 실행 시 조회, display_name '한교사').
//     3. 클래스 신규 1개 — name '{school_name} 1학년 수학', owner=mteacher1, grade=1, active.
//     4. 멤버: 2040 + 같은 school_name·grade=1 middle 시드 학생 중 로그 많은 순 7명
//        (부족 시 school_name 무관 middle·grade=1 보충) — 총 학생 8명(≥MIN_PEERS 5 + 여유).
//        ※ class_members role 은 코드베이스 정본 'member' 사용(스펙 문언은 'student'이나
//          실데이터·출석 스트릭(db/attendance.js)·평가 배정(db/exam.js)·student_count 산출
//          (db/class.js) 전부 role='member' 를 학생 멤버 정본으로 필터 — 'student' 로 넣으면
//          반 전제 기능 일부가 이 반만 누락해 §4-4 의 목적(반 기능 실검증) 자체가 깨진다).
//     5. 검증(말미 자동): middle1 비번 검증·peer 집합 ≥5·mastery/class 표본·델타 검증 가능 평가 수.
//
//   ⚠ "반 평균" 라벨 한계(스펙 §4-4 명기): 시드 평가의 응시자는 시드 코호트(10~12명)라
//     이 반에서의 "반 평균"은 근사치다(응시자 ⊄ 이 반). 실사용 경로에서는 평가가 반 단위로
//     배정되므로 정합 — 시드 검증 용도로만 이 한계를 인지하고 사용할 것.
//
//   사용법:
//     node scripts/seed-middle-class.js            # 실행(멱등 — 재실행해도 중복 0)
//     node scripts/seed-middle-class.js --dry-run  # 변경 없이 계획만 출력
//   테스트 하네스(test/lrs-keris-p2.test.js)가 임시 DB 에 대해 run() 을 직접 호출한다
//   (DB_PATH env 경유 — db/index.js 싱글톤이 해석).
// ─────────────────────────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');

const DEFAULT_TARGET_STUDENT_ID = 2040; // 로컬 DB 의 seed_s023 최준혁 (middle·1학년) — 스펙 §4-4
const SEED_USERNAME = 'seed_s023';      // DB 마다 id 가 달라(예: GCP=46) username 으로 우선 해석
const STUDENT_USERNAME = 'middle1';
const TEACHER_USERNAME = 'mteacher1';
const PASSWORD_PLAIN = '1234';
const CLASS_STUDENT_TOTAL = 8;         // 2040 포함 학생 8명 (≥ MIN_PEERS 5 + 여유)
const MIN_PEERS = 5;                   // routes/lrs.js MIN_PEERS 와 동일 정책값(검증용)

/**
 * 시드 실행(멱등). dryRun=true 면 쓰기 없이 계획만 요약 반환.
 * @returns {object} 요약 { dryRun, studentId, teacherId, classId, memberIds, actions[], verify{} }
 */
function run({ dryRun = false, log = console.log } = {}) {
  const db = require('../db/index');
  const classDb = require('../db/class');
  const actions = [];
  const act = (msg) => { actions.push(msg); log(`${dryRun ? '[dry-run] ' : ''}${msg}`); };

  // ── 0. 대상 학생 해석: env 강제 → 기존 middle1(멱등 재진입) → seed_s023 → 기본 id ──
  const TARGET_STUDENT_ID = (() => {
    if (process.env.SEED_MIDDLE_TARGET_ID) return Number(process.env.SEED_MIDDLE_TARGET_ID);
    const done = db.prepare(`SELECT id FROM users WHERE username = ? AND role = 'student'`).get(STUDENT_USERNAME);
    if (done) return done.id;
    const seed = db.prepare(`SELECT id FROM users WHERE username = ? AND role = 'student'`).get(SEED_USERNAME);
    if (seed) return seed.id;
    return DEFAULT_TARGET_STUDENT_ID;
  })();

  // ── 1. 학생 대표 계정: 대상 학생 → middle1 ─────────────────────────────────
  const stu = db.prepare('SELECT id, username, password, display_name, role, school_level, school_name, grade FROM users WHERE id = ?').get(TARGET_STUDENT_ID);
  if (!stu) throw new Error(`대상 학생 id=${TARGET_STUDENT_ID} 이 없습니다(시드 DB 아님?). username '${SEED_USERNAME}'/'${STUDENT_USERNAME}' 도 없음.`);
  if (stu.role !== 'student' || stu.school_level !== 'middle') {
    throw new Error(`id=${TARGET_STUDENT_ID} 전제 불일치: role=${stu.role}, school_level=${stu.school_level}`);
  }
  // 충돌 검사(스펙: 기존 username 충돌 검사 후 실행)
  const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(STUDENT_USERNAME, TARGET_STUDENT_ID);
  if (clash) throw new Error(`username '${STUDENT_USERNAME}' 이 이미 다른 사용자(id=${clash.id})에 있습니다 — 수동 확인 필요.`);

  if (stu.username !== STUDENT_USERNAME) {
    act(`학생 계정화: users#${TARGET_STUDENT_ID} username '${stu.username}' → '${STUDENT_USERNAME}'`);
    if (!dryRun) db.prepare('UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(STUDENT_USERNAME, TARGET_STUDENT_ID);
  } else {
    act(`학생 계정화: 이미 '${STUDENT_USERNAME}' — 건너뜀`);
  }
  let pwOk = false;
  try { pwOk = bcrypt.compareSync(PASSWORD_PLAIN, stu.password || ''); } catch (_) { pwOk = false; }
  if (!pwOk) {
    act(`학생 비밀번호: bcrypt('${PASSWORD_PLAIN}') 로 갱신`);
    if (!dryRun) db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(bcrypt.hashSync(PASSWORD_PLAIN, 10), TARGET_STUDENT_ID);
  } else {
    act('학생 비밀번호: 이미 1234 — 건너뜀');
  }
  const schoolName = stu.school_name; // 실행 시 조회해 사용(스펙 §4-4 2항)
  if (!schoolName) throw new Error(`id=${TARGET_STUDENT_ID} 의 school_name 이 비어 있습니다.`);

  // ── 2. 교사 계정: mteacher1 ─────────────────────────────────────────────
  let teacher = db.prepare('SELECT id, role, password FROM users WHERE username = ?').get(TEACHER_USERNAME);
  if (teacher && teacher.role !== 'teacher') {
    throw new Error(`username '${TEACHER_USERNAME}' 이 role=${teacher.role} 로 이미 존재 — 수동 확인 필요.`);
  }
  if (!teacher) {
    act(`교사 계정 생성: ${TEACHER_USERNAME}/1234 (한교사, middle, ${schoolName})`);
    if (!dryRun) {
      const info = db.prepare(`
        INSERT INTO users (username, password, display_name, role, school_level, school_name, is_seed)
        VALUES (?, ?, '한교사', 'teacher', 'middle', ?, 1)
      `).run(TEACHER_USERNAME, bcrypt.hashSync(PASSWORD_PLAIN, 10), schoolName);
      teacher = { id: Number(info.lastInsertRowid), role: 'teacher' };
    }
  } else {
    act(`교사 계정: 이미 존재(id=${teacher.id}) — 건너뜀`);
  }
  const teacherId = teacher ? teacher.id : null; // dry-run 신규면 null

  // ── 3. 클래스: {school_name} 1학년 수학 ──────────────────────────────────
  const className = `${schoolName} 1학년 수학`;
  let cls = teacherId != null
    ? db.prepare("SELECT id, member_count FROM classes WHERE owner_id = ? AND name = ? AND status = 'active'").get(teacherId, className)
    : null;
  if (!cls) {
    act(`클래스 생성: '${className}' (owner=${TEACHER_USERNAME}, grade=1, active)`);
    if (!dryRun) {
      const created = classDb.createClass(teacherId, {
        name: className,
        description: 'KERIS P2 middle 시드 검증용 반(스펙 §4-4) — 시드 학생 8명',
        class_type: '교과',
        subject: '수학',
        school_name: schoolName,
        grade: 1,
      });
      cls = { id: created.id, member_count: created.member_count };
    }
  } else {
    act(`클래스: 이미 존재(id=${cls.id}) — 건너뜀`);
  }
  const classId = cls ? cls.id : null;

  // ── 4. 멤버 배정: 2040 + 같은 학교 grade=1 로그 많은 순 7명(부족 시 보충) ──
  const currentStudentIds = classId != null
    ? classDb.getClassMembers(classId).filter(m => m.user_role === 'student').map(m => m.user_id)
    : [];
  const have = new Set(currentStudentIds);
  const picked = []; // 신규 배정 대상
  const need = () => CLASS_STUDENT_TOTAL - have.size - picked.length;

  if (!have.has(TARGET_STUDENT_ID) && need() > 0) picked.push(TARGET_STUDENT_ID);
  if (need() > 0) {
    // 같은 school_name·grade=1 middle 시드 학생, 로그 많은 순(스펙 §4-4 4항)
    const sameSchool = db.prepare(`
      SELECT u.id, (SELECT COUNT(*) FROM learning_logs ll WHERE ll.user_id = u.id) AS logs
      FROM users u
      WHERE u.school_level = 'middle' AND u.role = 'student' AND u.grade = 1
        AND u.school_name = ? AND u.is_seed = 1 AND u.id != ?
      ORDER BY logs DESC
    `).all(schoolName, TARGET_STUDENT_ID);
    for (const c of sameSchool) { if (need() <= 0) break; if (!have.has(c.id)) picked.push(c.id); }
  }
  if (need() > 0) {
    // 보충: school_name 무관 middle·grade=1 (로그 많은 순)
    const fallback = db.prepare(`
      SELECT u.id, (SELECT COUNT(*) FROM learning_logs ll WHERE ll.user_id = u.id) AS logs
      FROM users u
      WHERE u.school_level = 'middle' AND u.role = 'student' AND u.grade = 1
        AND u.is_seed = 1 AND u.school_name != ? AND u.id != ?
      ORDER BY logs DESC
    `).all(schoolName, TARGET_STUDENT_ID);
    for (const c of fallback) { if (need() <= 0) break; if (!have.has(c.id) && !picked.includes(c.id)) picked.push(c.id); }
  }
  if (picked.length) {
    act(`멤버 배정: ${picked.length}명 추가(${picked.join(', ')}) — 총 학생 ${have.size + picked.length}명 목표`);
    if (!dryRun) {
      for (const uid of picked) {
        if (!classDb.isMember(classId, uid)) classDb.addMember(classId, uid, 'member');
      }
    }
  } else {
    act(`멤버 배정: 이미 학생 ${have.size}명 — 추가 없음`);
  }
  // member_count 재계산(멱등 안전망 — 증분 카운터 드리프트 방지)
  if (!dryRun && classId != null) {
    db.prepare(`UPDATE classes SET member_count =
      (SELECT COUNT(*) FROM class_members WHERE class_id = ? AND status = 'active') WHERE id = ?`).run(classId, classId);
  }

  // ── 5. 검증(스크립트 말미 자동 — 스펙 §4-4 5항) ──────────────────────────
  const verify = {};
  if (!dryRun) {
    // (a) middle1 로그인 가능(비번 검증)
    const fresh = db.prepare('SELECT username, password FROM users WHERE id = ?').get(TARGET_STUDENT_ID);
    verify.loginOk = fresh.username === STUDENT_USERNAME && bcrypt.compareSync(PASSWORD_PLAIN, fresh.password);
    // (b) peer 집합(=routes/lrs.js _peerIdsOf 와 동일 정의: 소속 반들의 student 멤버 합집합)
    const peers = db.prepare(`
      SELECT COUNT(DISTINCT cm2.user_id) AS c
      FROM class_members cm
      JOIN class_members cm2 ON cm2.class_id = cm.class_id
      JOIN users u2 ON u2.id = cm2.user_id AND u2.role = 'student'
      WHERE cm.user_id = ?
    `).get(TARGET_STUDENT_ID);
    verify.peerCount = peers.c || 0;
    // (c) mastery/class 표본 — 교사 히트맵 데이터
    const mastery = require('../db/lrs-mastery');
    const students = classDb.getClassMembers(classId)
      .filter(m => m.user_role === 'student')
      .map(m => ({ id: m.user_id, name: m.display_name || m.username }));
    const cm = mastery.getClassMastery(classId, students);
    verify.classStudents = cm.students.length;
    verify.classStandards = cm.standards.length;
    // (d) P2-2 델타 검증 가능성 — 2040 의 평가 중 응시자 ≥ MIN_PEERS 인 것 수
    const deltaReady = db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT ll.target_id
        FROM learning_logs ll
        WHERE ll.activity_type = 'exam_complete'
          AND ll.target_id IN (SELECT DISTINCT target_id FROM learning_logs
                               WHERE user_id = ? AND activity_type = 'exam_complete')
        GROUP BY ll.target_id
        HAVING COUNT(DISTINCT ll.user_id) >= ?
      )
    `).get(TARGET_STUDENT_ID, MIN_PEERS);
    verify.deltaReadyExams = deltaReady.c || 0;

    log('── 검증 결과 ──────────────────────────────');
    log(`  middle1 로그인(비번 1234): ${verify.loginOk ? 'OK' : 'FAIL'}`);
    log(`  peer 집합: ${verify.peerCount}명 (기준 ≥ ${MIN_PEERS}) ${verify.peerCount >= MIN_PEERS ? 'OK' : 'FAIL'}`);
    log(`  mastery/class: 학생 ${verify.classStudents}명 · 성취기준 ${verify.classStandards}개 ${verify.classStudents === CLASS_STUDENT_TOTAL && verify.classStandards > 0 ? 'OK' : 'FAIL'}`);
    log(`  반평균 델타 검증 가능 평가(응시자≥${MIN_PEERS}): ${verify.deltaReadyExams}개 ${verify.deltaReadyExams > 0 ? 'OK' : 'FAIL'}`);
    if (!verify.loginOk || verify.peerCount < MIN_PEERS || verify.classStudents !== CLASS_STUDENT_TOTAL || verify.classStandards <= 0) {
      throw new Error('시드 말미 검증 실패 — 위 FAIL 항목 확인');
    }
  }

  return {
    dryRun,
    studentId: TARGET_STUDENT_ID,
    teacherId,
    classId,
    plannedMembers: picked,
    actions,
    verify,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const out = run({ dryRun });
    console.log(`\n완료${dryRun ? ' (dry-run — 변경 없음)' : ''}: classId=${out.classId}, teacherId=${out.teacherId}`);
  } catch (e) {
    console.error('시드 실패:', e.message);
    process.exit(1);
  }
}

module.exports = { run, TARGET_STUDENT_ID: DEFAULT_TARGET_STUDENT_ID, STUDENT_USERNAME, TEACHER_USERNAME, CLASS_STUDENT_TOTAL };
