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
function searchPublicClasses({ keyword, subject, grade, page = 1, limit = 20 } = {}) {
  let where = ' WHERE c.is_public = 1 AND c.status = \'active\'';
  const params = [];
  if (keyword) { where += ' AND (c.name LIKE ? OR c.description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (subject) { where += ' AND c.subject = ?'; params.push(subject); }
  if (grade) { where += ' AND c.grade = ?'; params.push(grade); }

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

// 멤버 추가
function addMember(classId, userId, role = 'member') {
  try {
    db.prepare('INSERT INTO class_members (class_id, user_id, role) VALUES (?, ?, ?)').run(classId, userId, role);
    db.prepare('UPDATE classes SET member_count = member_count + 1 WHERE id = ?').run(classId);
    return true;
  } catch (e) {
    if (e.message.includes('UNIQUE')) return false; // 이미 멤버
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
