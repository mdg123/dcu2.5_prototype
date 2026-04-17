const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, 'dacheum.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 한국시간(KST) 함수 등록: SQL에서 KST_NOW() 사용 가능
db.function('KST_NOW', () => {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  return now.toISOString().replace('T', ' ').substring(0, 19);
});

module.exports = db;
