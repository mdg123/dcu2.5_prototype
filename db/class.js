const db = require('./index');

// 6자리 랜덤 클래스 코드 생성
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (db.prepare('SELECT id FROM classes WHERE code = ?').get(code));
  return code;
}

// 클래스 생성
function createClass(ownerId, data) {
  const code = generateCode();
  const info = db.prepare(`
    INSERT INTO classes (code, name, description, owner_id, class_type, subject, school_name, grade, class_number, semester, academic_year, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, data.name, data.description || null, ownerId,
    data.class_type || '기타',
    data.subject || null, data.school_name || null, data.grade || null,
    data.class_number || null, data.semester || null, data.academic_year || null,
    data.is_public !== undefined ? (data.is_public ? 1 : 0) : 1
  );
  const classId = info.lastInsertRowid;

  // 개설자를 owner로 추가
  db.prepare('INSERT INTO class_members (class_id, user_id, role) VALUES (?, ?, ?)').run(classId, ownerId, 'owner');
  db.prepare('UPDATE classes SET member_count = 1 WHERE id = ?').run(classId);

  return getClassById(classId);
}

// 클래스 조회
function getClassById(classId) {
  return db.prepare(`
    SELECT c.*, u.display_name AS owner_name
    FROM classes c JOIN users u ON c.owner_id = u.id
    WHERE c.id = ? AND c.status != 'deleted'
  `).get(classId) || null;
}

function getClassByCode(code) {
  return db.prepare(`
    SELECT c.*, u.display_name AS owner_name
    FROM classes c JOIN users u ON c.owner_id = u.id
    WHERE c.code = ? AND c.status = 'active'
  `).get(code) || null;
}

// 사용자의 클래스 목록
function getUserClasses(userId) {
  return db.prepare(`
    SELECT c.*, u.display_name AS owner_name, cm.role AS my_role,
      (SELECT COUNT(*) FROM class_members WHERE class_id = c.id AND status='active' AND role='member') AS student_count
    FROM class_members cm
    JOIN classes c ON cm.class_id = c.id
    JOIN users u ON c.owner_id = u.id
    WHERE cm.user_id = ? AND cm.status = 'active' AND c.status = 'active'
    ORDER BY c.created_at DESC
  `).all(userId);
}

// 공개 클래스 검색
// opts.excludeOwnerId 지정 시 해당 사용자가 개설자(owner)인 클래스는 결과에서 제외
function searchPublicClasses({ keyword, subject, grade, page = 1, limit = 20, excludeOwnerId } = {}) {
  let where = ' WHERE c.is_public = 1 AND c.status = \'active\'';
  const params = [];
  if (keyword) { where += ' AND (c.name LIKE ? OR c.description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (subject) { where += ' AND c.subject = ?'; params.push(subject); }
  if (grade) { where += ' AND c.grade = ?'; params.push(grade); }
  if (excludeOwnerId) { where += ' AND c.owner_id != ?'; params.push(parseInt(excludeOwnerId)); }

  const countSql = 'SELECT COUNT(*) as cnt FROM classes c' + where;
  const total = db.prepare(countSql).get(...params).cnt;
  const totalPages = Math.ceil(total / limit) || 1;

  const sql = 'SELECT c.*, u.display_name AS owner_name FROM classes c JOIN users u ON c.owner_id = u.id' + where +
    ' ORDER BY c.member_count DESC, c.created_at DESC LIMIT ? OFFSET ?';
  const classes = db.prepare(sql).all(...params, limit, (page - 1) * limit);
  return { classes, total, totalPages };
}

// 클래스 수정
function updateClass(classId, data) {
  const fields = [];
  const params = [];
  for (const [key, val] of Object.entries(data)) {
    if (['name', 'description', 'class_type', 'subject', 'school_name', 'grade', 'class_number', 'is_public', 'cover_image_url', 'status', 'enabled_tabs'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return getClassById(classId);
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(classId);
  db.prepare(`UPDATE classes SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getClassById(classId);
}

// 클래스 삭제 (소프트)
function deleteClass(classId) {
  db.prepare("UPDATE classes SET status = 'deleted' WHERE id = ?").run(classId);
}

// 멤버 추가 (신규 가입 + 강퇴·탈퇴자 재가입 복구)
//
// ── [W2-T6-7] 재가입이 영구 불가였던 버그 (2026-08-05 수정) ──────────────────
//   removeMember 는 행을 지우지 않고 status='removed' 로 남긴다(기록 보존 목적).
//   그런데 여기서는 INSERT 의 UNIQUE(class_id,user_id) 충돌을 **"이미 멤버"로 삼켜**
//   409 를 돌려주고 있었다. 결과:
//     · 강퇴된 학생이 코드로 재가입 → 409 "이미 가입된 클래스입니다."
//     · 교사가 아이디로 다시 추가   → 409 "이미 멤버입니다."
//   복구 경로가 코드 어디에도 없어서, 교사가 실수로 내보낸 학생은 DB 를 직접
//   손대야만 돌아올 수 있었다.
//   → status 가 active 가 아닌 행(removed/left/invited)이 있으면 **active 로 되살린다**.
//
//   과거 기록 처리: 출석·제출물·학습로그는 전부 (class_id, user_id) 로 매달려 있고
//   class_members 행은 재사용(같은 id)되므로, 되살리면 과거 기록이 그대로 다시 보인다.
//   같은 학생이 같은 반으로 돌아오는 것이니 이력 연속이 맞다(새 행을 만들어 기록을
//   끊으면 성장기록·LRS 집계가 한 사람을 두 명으로 세게 된다).
//   joined_at 만 "이번에 다시 들어온 날"로 갱신한다(멤버 관리 표의 가입일 열 = 현 소속 시작일).
//
//   ※ 이미 active 인 멤버의 중복 가입은 종전대로 false(409) — 재가입 복구를 넓히지 않는다.
//   ※ 알려진 트레이드오프: 강퇴된 학생이 초대코드를 기억하면 스스로 다시 들어올 수 있다.
//     지금은 코드 재발급 기능이 없어 방어 수단이 코드뿐이다(별건 후속 과제).
// @returns {boolean} true = 가입/복구됨, false = 이미 active 멤버
function addMember(classId, userId, role = 'member') {
  const existing = db.prepare(
    'SELECT id, status FROM class_members WHERE class_id = ? AND user_id = ?'
  ).get(classId, userId);

  if (existing) {
    if (existing.status === 'active') return false; // 이미 멤버
    db.prepare(
      "UPDATE class_members SET status = 'active', role = ?, joined_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(role, existing.id);
    db.prepare('UPDATE classes SET member_count = member_count + 1 WHERE id = ?').run(classId);
    return true;
  }

  try {
    db.prepare('INSERT INTO class_members (class_id, user_id, role) VALUES (?, ?, ?)').run(classId, userId, role);
    db.prepare('UPDATE classes SET member_count = member_count + 1 WHERE id = ?').run(classId);
    return true;
  } catch (e) {
    // 위 SELECT 와 INSERT 사이의 경합(동시 가입 클릭)만 여기로 온다.
    if (e.message.includes('UNIQUE')) return false;
    throw e;
  }
}

// 멤버 제거
function removeMember(classId, userId) {
  const result = db.prepare("UPDATE class_members SET status = 'removed' WHERE class_id = ? AND user_id = ? AND role != 'owner'").run(classId, userId);
  if (result.changes > 0) {
    db.prepare('UPDATE classes SET member_count = member_count - 1 WHERE id = ?').run(classId);
  }
  return result.changes > 0;
}

// 멤버 목록
function getClassMembers(classId) {
  return db.prepare(`
    SELECT cm.*, u.username, u.display_name, u.role AS user_role, u.profile_image_url
    FROM class_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.class_id = ? AND cm.status = 'active'
    ORDER BY cm.role DESC, u.display_name
  `).all(classId);
}

// 멤버 역할 변경 (개설자 권한 부여/회수)
function updateMemberRole(classId, userId, newRole) {
  if (!['owner', 'member'].includes(newRole)) return false;
  const result = db.prepare("UPDATE class_members SET role = ? WHERE class_id = ? AND user_id = ? AND status = 'active'").run(newRole, classId, userId);
  return result.changes > 0;
}

// 멤버 여부 확인
function isMember(classId, userId) {
  return !!db.prepare("SELECT id FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'").get(classId, userId);
}

// 멤버 역할 확인
function getMemberRole(classId, userId) {
  const m = db.prepare("SELECT role FROM class_members WHERE class_id = ? AND user_id = ? AND status = 'active'").get(classId, userId);
  return m ? m.role : null;
}

module.exports = {
  createClass, getClassById, getClassByCode, getUserClasses,
  searchPublicClasses, updateClass, deleteClass,
  addMember, removeMember, updateMemberRole, getClassMembers, isMember, getMemberRole
};
