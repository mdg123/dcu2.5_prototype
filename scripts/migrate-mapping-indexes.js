#!/usr/bin/env node
/**
 * 관리자 매핑 UI 성능 인덱스 마이그레이션 (B-P0-1)
 * 실행: node scripts/migrate-mapping-indexes.js
 * - node_contents / learning_map_nodes / content_content_nodes 핵심 인덱스 추가
 * - 마지막에 EXPLAIN QUERY PLAN 으로 핵심 쿼리 검증
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'dacheum.db');

console.log('[migrate] DB:', dbPath);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const indexes = [
  ['idx_node_contents_node_id',     'CREATE INDEX IF NOT EXISTS idx_node_contents_node_id ON node_contents(node_id)'],
  ['idx_node_contents_content_id',  'CREATE INDEX IF NOT EXISTS idx_node_contents_content_id ON node_contents(content_id)'],
  ['idx_node_contents_node_role',   'CREATE INDEX IF NOT EXISTS idx_node_contents_node_role ON node_contents(node_id, content_role)'],
  ['idx_node_contents_node_sort',   'CREATE INDEX IF NOT EXISTS idx_node_contents_node_sort ON node_contents(node_id, sort_order)'],
  ['idx_lmn_node_level',            'CREATE INDEX IF NOT EXISTS idx_lmn_node_level ON learning_map_nodes(node_level)'],
  ['idx_lmn_subject_grade',         'CREATE INDEX IF NOT EXISTS idx_lmn_subject_grade ON learning_map_nodes(subject, grade, semester)'],
  ['idx_lmn_parent',                'CREATE INDEX IF NOT EXISTS idx_lmn_parent ON learning_map_nodes(parent_node_id)'],
  ['idx_ccn_content',               'CREATE INDEX IF NOT EXISTS idx_ccn_content ON content_content_nodes(content_id)']
];

const t0 = Date.now();
const created = [];
for (const [name, sql] of indexes) {
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
  db.exec(sql);
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
  if (!before && after) created.push(name);
}
db.exec('ANALYZE');
const dt = Date.now() - t0;

console.log('[migrate] 신규 인덱스:', created.length === 0 ? '(이미 모두 존재)' : created.join(', '));
console.log('[migrate] 소요:', dt, 'ms');

console.log('\n=== EXPLAIN QUERY PLAN ===');
const plans = [
  ['node_contents WHERE node_id=?',
   `EXPLAIN QUERY PLAN SELECT * FROM node_contents WHERE node_id = 'X'`],
  ['node_contents WHERE content_id=?',
   `EXPLAIN QUERY PLAN SELECT * FROM node_contents WHERE content_id = 1`],
  ['videos_count 서브쿼리',
   `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM node_contents nc JOIN contents c ON nc.content_id=c.id WHERE nc.node_id='X' AND c.content_type='video'`],
  ['learning_map_nodes WHERE node_level=?',
   `EXPLAIN QUERY PLAN SELECT * FROM learning_map_nodes WHERE node_level = 3`],
  ['learning_map_nodes WHERE subject=? AND grade=?',
   `EXPLAIN QUERY PLAN SELECT * FROM learning_map_nodes WHERE subject='수학' AND grade=1`]
];
for (const [label, sql] of plans) {
  const rows = db.prepare(sql).all();
  console.log('-', label);
  rows.forEach(r => console.log('  ', r.detail || JSON.stringify(r)));
}

db.close();
console.log('\n[migrate] 완료');
