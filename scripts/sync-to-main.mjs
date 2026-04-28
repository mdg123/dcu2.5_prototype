/**
 * sync-to-main.mjs
 *
 * 워크트리에서 변경한 파일을 메인 폴더로 복사한다.
 * - 마지막 커밋(또는 지정한 커밋 범위)에서 변경된 파일 목록을 가져와
 *   메인 폴더의 동일 경로에 단순 복사한다.
 * - Git 머지를 쓰지 않으므로 메인 폴더의 미커밋 변경/다른 브랜치 상태를
 *   건드리지 않는다.
 *
 * 사용법:
 *   node scripts/sync-to-main.mjs            # 마지막 커밋 1건 sync
 *   node scripts/sync-to-main.mjs HEAD~3..   # 최근 3건 sync
 *   node scripts/sync-to-main.mjs --staged   # 아직 커밋 안한 staged 변경 sync
 *   node scripts/sync-to-main.mjs --all      # 전체 working tree 변경 sync (위험)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAIN_DIR = 'C:/Users/user/OneDrive - 금성초등학교/바탕 화면/다채움 품질 제고사업 프로토타입 - 실동작';
const WORKTREE_DIR = process.cwd(); // 이 스크립트는 워크트리에서 실행됨

// 메인 폴더 존재 확인
if (!fs.existsSync(MAIN_DIR)) {
  console.error(`❌ 메인 폴더를 찾을 수 없습니다: ${MAIN_DIR}`);
  process.exit(1);
}

const arg = process.argv[2] || 'HEAD';
let files = [];

try {
  if (arg === '--staged') {
    files = execSync('git diff --cached --name-only', { encoding: 'utf8' }).split('\n').filter(Boolean);
  } else if (arg === '--all') {
    const tracked = execSync('git diff --name-only HEAD', { encoding: 'utf8' }).split('\n').filter(Boolean);
    const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
    files = [...new Set([...tracked, ...untracked])];
  } else if (arg.includes('..')) {
    files = execSync(`git diff --name-only ${arg}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  } else {
    // 단일 커밋: HEAD 등 → 그 커밋에서 변경된 파일
    files = execSync(`git show --name-only --pretty=format: ${arg}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  }
} catch (e) {
  console.error('❌ git 명령 실행 실패:', e.message);
  process.exit(1);
}

if (!files.length) {
  console.log('변경된 파일이 없습니다.');
  process.exit(0);
}

console.log(`[sync] 워크트리 → 메인 폴더 복사 시작 (${files.length}개)\n`);

let copied = 0, deleted = 0, skipped = 0;
for (const rel of files) {
  const src = path.join(WORKTREE_DIR, rel);
  const dst = path.join(MAIN_DIR, rel);

  // 워크트리에서 삭제된 파일이면 메인에서도 삭제
  if (!fs.existsSync(src)) {
    if (fs.existsSync(dst)) {
      try { fs.unlinkSync(dst); deleted++; console.log(`  🗑  삭제 ${rel}`); }
      catch (e) { console.warn(`  ⚠  삭제 실패: ${rel}`, e.message); skipped++; }
    } else { skipped++; }
    continue;
  }

  // 디렉터리 확보 후 복사
  const dstDir = path.dirname(dst);
  fs.mkdirSync(dstDir, { recursive: true });

  try {
    fs.copyFileSync(src, dst);
    copied++;
    console.log(`  ✓  ${rel}`);
  } catch (e) {
    console.warn(`  ✗  복사 실패: ${rel}`, e.message);
    skipped++;
  }
}

console.log(`\n[sync] 완료 — 복사 ${copied} · 삭제 ${deleted} · 건너뜀 ${skipped}`);
console.log(`메인 폴더: ${MAIN_DIR}`);
