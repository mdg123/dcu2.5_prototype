const db = require('./index');
const bcrypt = require('bcryptjs');

const stmtFindByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtFindById = db.prepare('SELECT id, username, display_name, role, school_name, grade, class_number, email, profile_image_url, created_at, last_login_at FROM users WHERE id = ?');
const stmtCreateUser = db.prepare('INSERT INTO users (username, password, display_name, role, school_name, grade, class_number) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtUpdateLastLogin = db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?');

function createUser(username, password, displayName, role = 'student', { school_name, grade, class_number } = {}) {
  const hash = bcrypt.hashSync(password, 10);
  const info = stmtCreateUser.run(username, hash, displayName, role, school_name || null, grade || null, class_number || null);
  return { id: info.lastInsertRowid, username, display_name: displayName, role, school_name, grade, class_number };
}

function findUserByUsername(username) {
  return stmtFindByUsername.get(username) || null;
}

function findUserById(id) {
  return stmtFindById.get(id) || null;
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function updateLastLogin(userId) {
  stmtUpdateLastLogin.run(userId);
}

// 관리자용: 전체 사용자 목록
function getAllUsers({ role, status, page = 1, limit = 20 } = {}) {
  let sql = 'SELECT id, username, display_name, role, school_name, grade, class_number, status, created_at, last_login_at FROM users WHERE 1=1';
  const params = [];
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, (page - 1) * limit);
  return db.prepare(sql).all(...params);
}

function getUserCount({ role, status } = {}) {
  let sql = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
  const params = [];
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  return db.prepare(sql).get(...params).count;
}

module.exports = {
  createUser,
  findUserByUsername,
  findUserById,
  verifyPassword,
  updateLastLogin,
  getAllUsers,
  getUserCount
};
