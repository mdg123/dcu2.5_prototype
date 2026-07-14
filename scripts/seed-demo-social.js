#!/usr/bin/env node
/**
 * seed-demo-social.js — LRS Phase 4b "학급 관계·정서(실명 소시오그램)" 시연 데모 시드
 *
 * 기획 정본
 *   보고서/LRS_Phase4b_교우관계_PIA_기획서_v2.md §8 (데모 시드 스펙, 사용자 결정 3 승인).
 *
 * 문제
 *   실학급(class1=8명·class2=6명)은 노드 6~8개·엣지 소수라 "학급이 충분히 클 때 그래프가
 *   어떻게 읽히는가"를 평가자에게 보여주기 어렵다(소표본 배지 대상).
 *
 * 해결 (이 스크립트 · 시연용 합성 학급)
 *   teacher1 소유 합성 데모 학급 "[시연] 관계분석 데모반" 1개 생성/재사용 +
 *   합성 학생 ≥20명(is_seed=1) + 현실적 게시글·댓글·대댓글(허브 2~3명·중간·고립 1~2명 자연 분포,
 *   억지 아님) + 감정 데이터(attendance, 긍정/중립/부정 현실 분포, n≥5 마스킹 회피).
 *   방향 엣지가 다채롭게 형성되도록 결정론 PRNG 로 상호작용을 생성한다.
 *
 * 정직성 / 되돌리기 (GT 안전)
 *   - 합성 학급/학생에만 posts·comments·attendance 삽입. 실학급·하네스 고정계정(uid3·uid13 등)
 *     ·실학생 데이터 일절 무변경. learning_logs·achievement_stats·users(실계정) 불변.
 *   - is_seed=1 태그(posts·comments·attendance 컬럼 멱등 마이그레이션 + users.is_seed) → teardown 키.
 *   - 멱등: 재실행 시 데모 학급 is_seed=1 콘텐츠 purge 후 결정론 재삽입(중복 무증가). 학생은 username
 *     으로 upsert(id 안정).
 *   - --apply 전 DB 파일 백업(.bak-<ts>). --clean 으로 데모 학급·학생·콘텐츠 완전 제거(실데이터 불변).
 *
 * GCP 이식
 *   - teacher1 은 username 으로 해석(로컬↔GCP uid 상이 대비, 하드코딩 금지).
 *
 * 사용법
 *   node scripts/seed-demo-social.js --plan     # 무쓰기 미리보기(대상·규모·분포 계획)
 *   node scripts/seed-demo-social.js --apply    # 마이그레이션 + 백업 후 데모 학급 재시드
 *   node scripts/seed-demo-social.js --clean    # 데모 학급·학생·콘텐츠 전부 제거(실데이터 불변)
 *   node scripts/seed-demo-social.js --stats    # 노드수·엣지수·허브/고립 분포·감정분포 출력
 *   옵션: --no-backup(백업 생략, 위험)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require(path.join(__dirname, '..', 'db', 'index'));

// ─────────────────────────── CLI ───────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--clean') ? 'clean' : has('--stats') ? 'stats' : has('--plan') ? 'plan' : has('--apply') ? 'apply' : null;
const NO_BACKUP = has('--no-backup');

// ─────────────────────────── 상수 ───────────────────────────
const _t1 = db.prepare("SELECT id FROM users WHERE username='teacher1' AND role='teacher' LIMIT 1").get();
if (!_t1) { console.error('[demo-social] ✗ teacher1 교사 계정 없음 — 중단'); process.exit(1); }
const TEACHER1 = _t1.id;
const DEMO_CLASS_NAME = '[시연] 관계분석 데모반';       // ★ 라우트 _isDemoRelationshipClass('[시연' 접두) 판별 키
const DEMO_CLASS_CODE = 'DEMOSOC1';                    // 안정 코드(멱등 재사용 키)
const STU_PREFIX = 'seed_soc_stu_';                    // 합성 학생 username 접두(teardown 키)
const NUM_STUDENTS = parseInt(process.env.NSTU, 10) || 24;   // 노드 ≥20 확보
const SEED = 20260714;
const PW_HASH = bcrypt.hashSync('1234', 10);           // 데모 계정 비번(로그인 불필요하나 password NOT NULL)

// 합성 학생 한국어 이름(현실적) — 부족하면 "학생NN" 폴백.
const NAMES = [
  '김서준', '이하은', '박도윤', '최지우', '정시우', '강서윤', '조하준', '윤지호',
  '장예은', '임주원', '한서아', '오지안', '서건우', '신유진', '권민준', '황수아',
  '안예준', '송하윤', '전지훈', '홍채원', '문시아', '양준서', '배가온', '유리안',
  '남도현', '고은우', '심아린', '노시온', '하윤슬', '곽태오',
];

// ─────────────────────────── 재현 가능 PRNG ───────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const pickW = (r, pairs) => {
  const sum = pairs.reduce((s, p) => s + p[1], 0);
  let x = r() * sum;
  for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; }
  return pairs[0][0];
};
const daysAgoIso = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const tsAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 19).replace('T', ' '); };

// ─────────────────────────── 마이그레이션(멱등) ───────────────────────────
// posts·comments·attendance 에 is_seed 컬럼 추가(DEFAULT 0, 가산·비파괴). 없을 때만.
function migrate() {
  const added = [];
  for (const tbl of ['posts', 'comments', 'attendance']) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name));
    if (!cols.has('is_seed')) { db.exec(`ALTER TABLE ${tbl} ADD COLUMN is_seed INTEGER DEFAULT 0`); added.push(`${tbl}.is_seed`); }
  }
  if (added.length) console.log(`[demo-social] 마이그레이션: 컬럼 추가 → ${added.join(', ')}`);
  else console.log('[demo-social] 마이그레이션: is_seed 컬럼 이미 존재(멱등, 변경 없음)');
}

// ─────────────────────────── 데모 학급/학생 보장 ───────────────────────────
function ensureClass() {
  let c = db.prepare('SELECT id, name FROM classes WHERE owner_id=? AND name=? LIMIT 1').get(TEACHER1, DEMO_CLASS_NAME);
  if (c) return c.id;
  // 코드 충돌 회피
  let code = DEMO_CLASS_CODE;
  if (db.prepare('SELECT 1 FROM classes WHERE code=?').get(code)) code = DEMO_CLASS_CODE + '_' + Date.now().toString(36).slice(-4);
  const info = db.prepare(`
    INSERT INTO classes (code, name, description, owner_id, class_type, subject, grade, status, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0)
  `).run(code, DEMO_CLASS_NAME, '시연용 합성 학급(실제 학생 아님) — 관계·정서 분석 데모', TEACHER1, '기타', null, 4);
  const classId = info.lastInsertRowid;
  db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')").run(classId, TEACHER1);
  db.prepare('UPDATE classes SET member_count = 1 WHERE id = ?').run(classId);
  console.log(`[demo-social] 데모 학급 생성: id=${classId} code=${code} "${DEMO_CLASS_NAME}"`);
  return classId;
}

function ensureStudents(classId) {
  const ids = [];
  const findU = db.prepare('SELECT id FROM users WHERE username=? LIMIT 1');
  const insU = db.prepare(`
    INSERT INTO users (username, password, display_name, role, school_level, grade, is_seed, status)
    VALUES (?, ?, ?, 'student', 'elementary', 4, 1, 'active')
  `);
  const hasMember = db.prepare("SELECT 1 FROM class_members WHERE class_id=? AND user_id=?");
  const insMember = db.prepare("INSERT INTO class_members (class_id, user_id, role, status) VALUES (?, ?, 'member', 'active')");
  const tx = db.transaction(() => {
    for (let i = 0; i < NUM_STUDENTS; i++) {
      const uname = STU_PREFIX + String(i + 1).padStart(2, '0');
      const name = NAMES[i] || `학생${String(i + 1).padStart(2, '0')}`;
      let u = findU.get(uname);
      if (!u) { const info = insU.run(uname, PW_HASH, name); u = { id: info.lastInsertRowid }; }
      ids.push(u.id);
      if (!hasMember.get(classId, u.id)) insMember.run(classId, u.id);
    }
    db.prepare('UPDATE classes SET member_count = (SELECT COUNT(*) FROM class_members WHERE class_id=? AND status=\'active\') WHERE id=?').run(classId, classId);
  });
  tx();
  return ids;
}

// ─────────────────────────── purge (데모 콘텐츠만) ───────────────────────────
function purgeContent(classId, studentIds) {
  if (!studentIds.length) return;
  const ph = studentIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM comments WHERE is_seed=1 AND author_id IN (${ph})`).run(...studentIds);
  db.prepare(`DELETE FROM posts WHERE is_seed=1 AND class_id=?`).run(classId);
  db.prepare(`DELETE FROM attendance WHERE is_seed=1 AND class_id=?`).run(classId);
}

// ─────────────────────────── 상호작용 역할 배정 (허브/중간/고립) ───────────────────────────
// 결정론: 앞 3명=허브(활발), 그다음=중간, 끝 2명=고립(엣지 0). 억지 커플링 없이 확률 밴드로.
function roleOf(idx, n) {
  if (idx < 3) return 'hub';
  if (idx >= n - 2) return 'isolate';
  return 'mid';
}

// ─────────────────────────── 콘텐츠 생성 ───────────────────────────
// 게시글: 허브 다수·중간 소수·고립 0~1(익명 소량 섞음 — 익명은 귀속 제외 검증용).
// 댓글: 작성자(비고립) → 타 학생 글. 대댓글 일부. 방향 엣지가 다채롭게.
function generate(classId, studentIds) {
  const n = studentIds.length;
  const posts = [];   // { author_id, is_anonymous, created_at, idx }
  const rP = mulberry32(hashStr('posts') ^ SEED);
  // 1) 게시글 — 학생별 역할 기반 개수
  studentIds.forEach((uid, idx) => {
    const role = roleOf(idx, n);
    let cnt = role === 'hub' ? 3 + Math.floor(rP() * 3)          // 허브 3~5글
      : role === 'mid' ? Math.floor(rP() * 3)                    // 중간 0~2글
        : (rP() < 0.4 ? 1 : 0);                                  // 고립 0~1글
    for (let k = 0; k < cnt; k++) {
      // 익명은 허브가 아닌 학생에서 소량(≈12%) — 익명 글은 엣지/participation.posts 에서 제외됨.
      const anon = role !== 'hub' && rP() < 0.12 ? 1 : 0;
      posts.push({ author_id: uid, is_anonymous: anon, day: 5 + Math.floor(rP() * 40), idx });
    }
  });
  // 최소 게시글 보장(허브에게 글 없으면 엣지가 안 생김)
  if (posts.filter(p => !p.is_anonymous).length < 6) {
    for (let i = 0; i < 3; i++) posts.push({ author_id: studentIds[i], is_anonymous: 0, day: 10 + i, idx: i });
  }
  return { posts };
}

function apply() {
  const t0 = Date.now();
  console.log('[demo-social] ===== 학급 관계·정서(실명 소시오그램) 시연 데모 시드 =====');
  migrate();
  backupDb();
  const classId = ensureClass();
  const studentIds = ensureStudents(classId);
  purgeContent(classId, studentIds);
  const { postCount, commentCount, replyCount } = seedContent(classId, studentIds);
  seedEmotions(classId, studentIds);
  console.log(`[demo-social] 데모 학급 ${classId} · 학생 ${studentIds.length}명 · 게시글 ${postCount}(익명 포함) · 댓글 ${commentCount} · 답글 ${replyCount}`);
  console.log(`[demo-social] (실학급·하네스 고정계정·실학생 무변경 — GT 무오염) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  printStats(classId, studentIds);
}

// 게시글·댓글·대댓글 삽입(순수 — 백업/로그 없음). apply()·테스트 하네스 공용.
function seedContent(classId, studentIds) {
  const { posts } = generate(classId, studentIds);
  const n = studentIds.length;

  const insPost = db.prepare(`
    INSERT INTO posts (class_id, author_id, title, content, category, is_anonymous, allow_comments, approval_status, created_at, is_seed)
    VALUES (?, ?, ?, ?, '자유', ?, 1, 'approved', ?, 1)
  `);
  const insComment = db.prepare(`
    INSERT INTO comments (post_id, author_id, content, parent_id, created_at, is_seed)
    VALUES (?, ?, ?, ?, ?, 1)
  `);

  let postCount = 0, commentCount = 0, replyCount = 0;
  const tx = db.transaction(() => {
    // 1) 게시글 삽입 → id 확보
    const postRecs = [];
    posts.forEach((p, i) => {
      const info = insPost.run(p.class_id ?? classId, p.author_id, `데모 게시글 ${i + 1}`, `시연용 합성 게시글 본문 ${i + 1}`, p.is_anonymous, tsAgo(p.day));
      postRecs.push({ id: info.lastInsertRowid, author_id: p.author_id, is_anonymous: p.is_anonymous, day: p.day });
      postCount++;
    });
    // 2) 댓글 — 비고립 학생이 "타인의 비익명 글"에 댓글. 역할별 활동량 차등.
    const rC = mulberry32(hashStr('comments') ^ SEED);
    const commentableByOther = (uid) => postRecs.filter(pr => pr.author_id !== uid && pr.is_anonymous === 0);
    const commentRecs = [];   // { id, author_id, post_id }
    studentIds.forEach((uid, idx) => {
      const role = roleOf(idx, n);
      if (role === 'isolate') return;                            // 고립 = 상호작용 없음(담담히 엣지 0)
      const targets = commentableByOther(uid);
      if (!targets.length) return;
      const num = role === 'hub' ? 5 + Math.floor(rC() * 6)      // 허브 5~10 댓글
        : 1 + Math.floor(rC() * 3);                              // 중간 1~3 댓글
      for (let k = 0; k < num; k++) {
        const pr = targets[Math.floor(rC() * targets.length)];
        const info = insComment.run(pr.id, uid, `데모 댓글 ${k + 1}`, null, tsAgo(Math.max(1, pr.day - 1 - Math.floor(rC() * 3))));
        commentRecs.push({ id: info.lastInsertRowid, author_id: uid, post_id: pr.id });
        commentCount++;
      }
    });
    // 3) 대댓글(reply) — 일부 학생이 "타인의 댓글"에 답글(부모댓글 작성자 → 엣지 type=reply).
    const rR = mulberry32(hashStr('replies') ^ SEED);
    studentIds.forEach((uid, idx) => {
      const role = roleOf(idx, n);
      if (role === 'isolate') return;
      const parents = commentRecs.filter(c => c.author_id !== uid);
      if (!parents.length) return;
      const num = role === 'hub' ? 2 + Math.floor(rR() * 3) : (rR() < 0.5 ? 1 : 0);
      for (let k = 0; k < num; k++) {
        const par = parents[Math.floor(rR() * parents.length)];
        insComment.run(par.post_id, uid, `데모 답글 ${k + 1}`, par.id, tsAgo(1 + Math.floor(rR() * 5)));
        replyCount++;
      }
    });
  });
  tx();
  return { postCount, commentCount, replyCount };
}

// 감정 — 각 학생 여러 날 emotion_score(1~3) 부여. 긍정 다수·중립·부정 소수 결정론 분포.
function seedEmotions(classId, studentIds) {
  const insAtt = db.prepare(`
    INSERT INTO attendance (class_id, user_id, attendance_date, status, emotion, emotion_score, checkin_source, is_seed)
    VALUES (?, ?, ?, 'present', ?, ?, 'demo', 1)
    ON CONFLICT(class_id, user_id, attendance_date) DO UPDATE SET emotion=excluded.emotion, emotion_score=excluded.emotion_score, is_seed=1
  `);
  const EMO = { positive: ['happy', 'good', 'excited'], neutral: ['neutral', 'soso'], negative: ['sad', 'tired', 'anxious'] };
  const scoreOf = { positive: 3, neutral: 2, negative: 1 };
  const hasConflictIdx = _attendanceHasUnique();
  const tx = db.transaction(() => {
    studentIds.forEach((uid) => {
      const r = mulberry32(hashStr('emo|' + uid) ^ SEED);
      const days = 8 + Math.floor(r() * 8);                      // 학생당 8~15일 감정 기록
      for (let k = 0; k < days; k++) {
        const grp = pickW(r, [['positive', 58], ['neutral', 30], ['negative', 12]]);   // 현실적 분포
        const emo = EMO[grp][Math.floor(r() * EMO[grp].length)];
        const dateIso = daysAgoIso(1 + Math.floor(r() * 45));
        if (hasConflictIdx) {
          insAtt.run(classId, uid, dateIso, emo, scoreOf[grp]);
        } else {
          // UNIQUE 제약 없으면 중복 방어: 같은 (uid,date) 기존 is_seed 삭제 후 삽입
          db.prepare('DELETE FROM attendance WHERE is_seed=1 AND class_id=? AND user_id=? AND attendance_date=?').run(classId, uid, dateIso);
          db.prepare(`INSERT INTO attendance (class_id, user_id, attendance_date, status, emotion, emotion_score, checkin_source, is_seed) VALUES (?,?,?,?,?,?, 'demo', 1)`)
            .run(classId, uid, dateIso, 'present', emo, scoreOf[grp]);
        }
      }
    });
  });
  tx();
}

// attendance 에 (class_id,user_id,attendance_date) UNIQUE 인덱스가 있는지 — ON CONFLICT 안전 판별.
function _attendanceHasUnique() {
  try {
    const idx = db.prepare('PRAGMA index_list(attendance)').all();
    for (const ix of idx) {
      if (!ix.unique) continue;
      const cols = db.prepare(`PRAGMA index_info(${ix.name})`).all().map(c => c.name);
      const set = new Set(cols);
      if (set.has('class_id') && set.has('user_id') && set.has('attendance_date')) return true;
    }
  } catch (_) {}
  return false;
}

// ─────────────────────────── 백업 ───────────────────────────
function backupDb() {
  if (NO_BACKUP) { console.log('[demo-social] ⚠ --no-backup: 백업 생략'); return null; }
  const dbPath = db.name || path.join(__dirname, '..', 'data', 'dacheum.db');
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
  const dest = dbPath + `.bak-${ts}`;
  fs.copyFileSync(dbPath, dest);
  console.log(`[demo-social] 백업 생성: ${path.basename(dest)} (${(fs.statSync(dest).size / 1048576).toFixed(1)}MB)`);
  return dest;
}

// ─────────────────────────── clean ───────────────────────────
function clean() {
  migrate();
  backupDb();
  const c = db.prepare('SELECT id FROM classes WHERE owner_id=? AND name=? LIMIT 1').get(TEACHER1, DEMO_CLASS_NAME);
  const students = db.prepare(`SELECT id FROM users WHERE username LIKE ? AND is_seed=1`).all(STU_PREFIX + '%').map(r => r.id);
  let delPosts = 0, delComments = 0, delAtt = 0, delMembers = 0, delStudents = 0, delClass = 0;
  const tx = db.transaction(() => {
    if (students.length) {
      const ph = students.map(() => '?').join(',');
      delComments = db.prepare(`DELETE FROM comments WHERE author_id IN (${ph})`).run(...students).changes;
    }
    if (c) {
      delPosts = db.prepare('DELETE FROM posts WHERE class_id=?').run(c.id).changes;
      delAtt = db.prepare('DELETE FROM attendance WHERE class_id=?').run(c.id).changes;
      delMembers = db.prepare('DELETE FROM class_members WHERE class_id=?').run(c.id).changes;
    }
    if (students.length) {
      const ph = students.map(() => '?').join(',');
      delStudents = db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...students).changes;
    }
    if (c) delClass = db.prepare('DELETE FROM classes WHERE id=?').run(c.id).changes;
  });
  tx();
  console.log(`[demo-social] --clean: posts ${delPosts} · comments ${delComments} · attendance ${delAtt} · members ${delMembers} · students ${delStudents} · class ${delClass} 삭제(실데이터 불변)`);
}

// ─────────────────────────── stats / plan ───────────────────────────
// API 산식과 동일하게 노드·엣지·허브/고립·감정을 재현(증적).
function printStats(classId, studentIds) {
  classId = classId || _demoClassId();
  if (!classId) { console.log('[demo-social] 데모 학급 없음(먼저 --apply)'); return; }
  studentIds = studentIds || db.prepare("SELECT cm.user_id id FROM class_members cm JOIN users u ON u.id=cm.user_id WHERE cm.class_id=? AND u.role='student'").all(classId).map(r => r.id);
  const memberSet = new Set(studentIds);
  const from = daysAgoIso(400), to = daysAgoIso(0);
  // 노드 participation
  const postRows = db.prepare(`SELECT author_id uid, COUNT(*) c FROM posts WHERE class_id=? AND COALESCE(is_anonymous,0)=0 GROUP BY author_id`).all(classId);
  const anonPosts = db.prepare(`SELECT COUNT(*) c FROM posts WHERE class_id=? AND is_anonymous=1`).get(classId).c;
  const cRows = db.prepare(`
    SELECT c.author_id fromId, c.parent_id parentId, pc.author_id parentAuthor, p.author_id postAuthor, COALESCE(p.is_anonymous,0) postAnon
    FROM comments c JOIN posts p ON p.id=c.post_id LEFT JOIN comments pc ON pc.id=c.parent_id
    WHERE p.class_id=?
  `).all(classId);
  const edgeMap = new Map(); let commentE = 0, replyE = 0;
  for (const r of cRows) {
    const from2 = r.fromId; if (!memberSet.has(from2)) continue;
    let to2, type;
    if (r.parentId != null) { to2 = r.parentAuthor; type = 'reply'; }
    else { if (Number(r.postAnon) === 1) continue; to2 = r.postAuthor; type = 'comment'; }
    if (to2 == null || !memberSet.has(to2) || from2 === to2) continue;
    edgeMap.set(`${from2}|${to2}|${type}`, (edgeMap.get(`${from2}|${to2}|${type}`) || 0) + 1);
    if (type === 'comment') commentE++; else replyE++;
  }
  const deg = new Map();
  for (const [k, w] of edgeMap) { const [f, t] = k.split('|'); deg.set(+f, (deg.get(+f) || 0) + w); deg.set(+t, (deg.get(+t) || 0) + w); }
  const isolates = studentIds.filter(id => !deg.has(id)).length;
  const hubs = [...deg.entries()].filter(([, d]) => d >= 6).length;
  // 감정 분포
  const emo = db.prepare(`SELECT emotion_score s, emotion e FROM attendance WHERE class_id=? AND (emotion IS NOT NULL OR emotion_score IS NOT NULL)`).all(classId);
  let pos = 0, neu = 0, neg = 0;
  for (const r of emo) { const s = Number(r.s); if (s >= 2.5) pos++; else if (s >= 1.5) neu++; else neg++; }
  const en = pos + neu + neg;

  console.log(`\n[demo-social] ===== STATS (데모 학급 ${classId}) =====`);
  console.log(`노드(학생): ${studentIds.length}  ·  smallSample(<20): ${studentIds.length < 20}`);
  console.log(`엣지: 총 ${edgeMap.size}쌍 (comment ${commentE} · reply ${replyE})  ·  비익명 게시글 작성자 ${postRows.length}명 · 익명 게시글 ${anonPosts}(귀속 제외)`);
  console.log(`허브(degree≥6): ${hubs}명  ·  고립(degree 0): ${isolates}명`);
  console.log(`감정 집계: n=${en} → 긍정 ${en ? Math.round(pos / en * 100) : 0}% · 중립 ${en ? Math.round(neu / en * 100) : 0}% · 부정 ${en ? Math.round(neg / en * 100) : 0}% (마스킹 n<5: ${en < 5})`);
  console.log('');
}

function _demoClassId() {
  const c = db.prepare('SELECT id FROM classes WHERE owner_id=? AND name=? LIMIT 1').get(TEACHER1, DEMO_CLASS_NAME);
  return c ? c.id : null;
}

function plan() {
  console.log('\n[demo-social] ===== PLAN (무쓰기) =====');
  console.log(`teacher1 uid=${TEACHER1}  ·  데모 학급 "${DEMO_CLASS_NAME}" (code ${DEMO_CLASS_CODE})`);
  const existing = _demoClassId();
  console.log(existing ? `기존 데모 학급 id=${existing} 재사용(콘텐츠 purge 후 재삽입)` : '데모 학급 신규 생성 예정');
  console.log(`합성 학생 ${NUM_STUDENTS}명 (username ${STU_PREFIX}01..${STU_PREFIX}${String(NUM_STUDENTS).padStart(2, '0')}, is_seed=1)`);
  console.log('분포 계획: 허브 3명(글 3~5·댓글 5~10·답글 2~4) · 중간(글 0~2·댓글 1~3) · 고립 2명(상호작용 0)');
  console.log('감정: 학생당 8~15일 attendance emotion_score(긍정58%·중립30%·부정12%), n≥5 마스킹 회피');
  const cols = { posts: new Set(db.prepare('PRAGMA table_info(posts)').all().map(c => c.name)).has('is_seed'), comments: new Set(db.prepare('PRAGMA table_info(comments)').all().map(c => c.name)).has('is_seed'), attendance: new Set(db.prepare('PRAGMA table_info(attendance)').all().map(c => c.name)).has('is_seed') };
  console.log('is_seed 컬럼 현황:', JSON.stringify(cols), '(없으면 --apply 시 가산)');
  console.log('(실 쓰기 없음. --apply 로 실행 — 마이그레이션·백업 포함)');
}

// ─────────────────────────── main ───────────────────────────
function main() {
  if (!MODE) {
    console.log('Usage: node scripts/seed-demo-social.js [--apply | --clean | --stats | --plan] [--no-backup]');
    process.exit(1);
  }
  if (MODE === 'plan') plan();
  else if (MODE === 'stats') printStats();
  else if (MODE === 'clean') clean();
  else if (MODE === 'apply') apply();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { DEMO_CLASS_NAME, STU_PREFIX, NUM_STUDENTS, ensureClass, ensureStudents, seedContent, seedEmotions, generate, migrate, purgeContent };
