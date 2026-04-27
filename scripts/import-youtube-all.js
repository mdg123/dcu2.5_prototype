/**
 * 유튜브 영상 전체 import — 학년(1-6) × 영역(4개) = 24개 대표 영상
 * 각 영상을 해당 학년×영역의 모든 차시 노드에 매핑
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'dacheum.db');
const db = new Database(DB_PATH);
const ADMIN_ID = 1;

// ── 24개 대표 YouTube 영상 ──────────────────────────────────────────────────
const YOUTUBE_VIDEOS = [
  { grade: 1, area: '수와 연산',    url: 'https://www.youtube.com/watch?v=3T7ECkZT728', title: '[1학년 처음 수학] 9까지의 수 / 수와 연산 공부하기', channel: '수학대왕' },
  { grade: 1, area: '도형과 측정',  url: 'https://www.youtube.com/watch?v=UmSn21D72Ns', title: '[초등 1학년 수학] 여러 가지 모양을 찾아볼까요 | 네모·세모·동그라미 | 도형', channel: '재미수학' },
  { grade: 1, area: '변화와 관계',  url: 'https://www.youtube.com/watch?v=2-bPbdJ-cRU', title: '초등학교 1학년 수학_규칙 찾기', channel: '배우고 이루는 스스로 캠프' },
  { grade: 1, area: '자료와 가능성',url: 'https://www.youtube.com/watch?v=hxWcsLl9XaI', title: '[2학년 1학기 수학] 5단원_분류하기', channel: '스마트올' },

  { grade: 2, area: '수와 연산',    url: 'https://www.youtube.com/watch?v=2Qr2lwGBG7E', title: '[초등 2학년 수학] 덧셈을 해 볼까요(1) | 더하기 | 받아올림', channel: '재미수학' },
  { grade: 2, area: '도형과 측정',  url: 'https://www.youtube.com/watch?v=CYSIMVZEYEc', title: '(초등 수학 2학년 1학기) 2단원 여러 가지 도형 — 사각형을 알아 볼까요', channel: '초등수학교실' },
  { grade: 2, area: '변화와 관계',  url: 'https://www.youtube.com/watch?v=zcLOhsbC7TU', title: '2학년 2학기 6단원 규칙 찾기 수학 놀이 [수다학]', channel: 'YTN 사이언스' },
  { grade: 2, area: '자료와 가능성',url: 'https://www.youtube.com/watch?v=RUm5PJueY7M', title: '[수다학] 수학 학습 도움닫기 : 초등 2학년 1학기 분류하기', channel: 'YTN 사이언스' },

  { grade: 3, area: '수와 연산',    url: 'https://www.youtube.com/watch?v=7cgP85RrBgE', title: '[초등 3학년 수학] 분수를 알아볼까요? | 분수 | 분수만큼 | 수와 연산', channel: '재미수학' },
  { grade: 3, area: '도형과 측정',  url: 'https://www.youtube.com/watch?v=owgl8sah-04', title: '[초등 3학년 수학] 우리 주변에는 어떤 평면도형이 있을까요? | 정사각형 | 직각', channel: '재미수학' },
  { grade: 3, area: '변화와 관계',  url: 'https://www.youtube.com/watch?v=at-Q-Hi00K8', title: '[백점맞는수학] 초등3학년_곱셈과 나눗셈의 관계', channel: '백점맞는수학' },
  { grade: 3, area: '자료와 가능성',url: 'https://www.youtube.com/watch?v=fb4V3FtDaBU', title: '초등수학 3학년 2학기 6단원_자료의 정리_그림그래프로 나타내어 보기', channel: '수학공장' },

  { grade: 4, area: '수와 연산',    url: 'https://www.youtube.com/watch?v=kQuo5ZQQi1o', title: '[초등 4학년 수학] 소수 사이의 관계를 알아볼까요 | 소수의 덧셈과 뺄셈', channel: '재미수학' },
  { grade: 4, area: '도형과 측정',  url: 'https://www.youtube.com/watch?v=gs9AVi1I2lc', title: '[초등 4학년 수학] 각의 크기는 얼마일까요 | 각의 크기 | 각도', channel: '재미수학' },
  { grade: 4, area: '변화와 관계',  url: 'https://www.youtube.com/watch?v=_W2pMHzeps0', title: '초등학교 4학년 수학_수의 배열에서 규칙성 찾기', channel: '배우고 이루는 스스로 캠프' },
  { grade: 4, area: '자료와 가능성',url: 'https://www.youtube.com/watch?v=2N5b32etm40', title: '초등수학 4학년 1학기 5단원_막대그래프_막대그래프를 알아보기', channel: '수학공장' },

  { grade: 5, area: '수와 연산',    url: 'https://www.youtube.com/watch?v=Rlonb0PLvGA', title: '[수다학] 초등 5학년 1학기 약분과 통분', channel: 'YTN 사이언스' },
  { grade: 5, area: '도형과 측정',  url: 'https://www.youtube.com/watch?v=_gNf824RdvA', title: '[밀크T초등] 5학년 2학기 2단원 합동과 대칭 1. 도형의 합동', channel: '밀크T초등' },
  { grade: 5, area: '변화와 관계',  url: 'https://www.youtube.com/watch?v=5p7X9dt1qgY', title: '초등 5학년 1학기 수학 3단원 규칙과 대응_대응 관계를 식으로 나타내기', channel: '초등수학교실' },
  { grade: 5, area: '자료와 가능성',url: 'https://www.youtube.com/watch?v=bApbv-Sp17E', title: '[5분정리] 5학년 2학기 수학 6단원. 평균과 가능성', channel: '진격의홍쌤' },

  { grade: 6, area: '수와 연산',    url: 'https://www.youtube.com/watch?v=2S_8MCj6VXI', title: '[초등 5분 수학] 분수의 나눗셈 총정리 | 6학년 1학기 수학 1단원', channel: '초등 5분 수학' },
  { grade: 6, area: '도형과 측정',  url: 'https://www.youtube.com/watch?v=eNQ5ax04y_c', title: '초등수학 6학년 2학기 6단원_원기둥, 원뿔, 구_원기둥을 알아보기', channel: '수학공장' },
  { grade: 6, area: '변화와 관계',  url: 'https://www.youtube.com/watch?v=5jMFcG5s50I', title: '6학년 1학기 수학 4단원 비와 비율', channel: '수학대왕TV' },
  { grade: 6, area: '자료와 가능성',url: 'https://www.youtube.com/watch?v=UfPy9u0X0n0', title: '띠그래프, 원그래프 그리기 (6-1, 5단원) | 6학년 수학', channel: '수학대왕' },
];

// ── Prepared Statements ───────────────────────────────────────────────────────
const insertContent = db.prepare(`
  INSERT INTO contents (
    creator_id, title, description, content_type, content_url, file_path,
    subject, grade, achievement_code, tags, is_public, status,
    difficulty, copyright, allow_comments, created_at
  ) VALUES (?, ?, ?, 'video', ?, NULL, '수학', ?, NULL, ?, 1, 'approved', 2, 'CC-BY', 1, datetime('now'))
`);

const insertStd = db.prepare('INSERT OR IGNORE INTO content_content_nodes (content_id, std_id) VALUES (?, ?)');
const insertNode = db.prepare('INSERT OR IGNORE INTO node_contents (node_id, content_id, content_role, sort_order) VALUES (?, ?, ?, ?)');

// 해당 학년×영역의 모든 차시 노드 조회
const getNodes = db.prepare(
  'SELECT node_id FROM learning_map_nodes WHERE node_level=3 AND grade=? AND area=?'
);

const checkDup = db.prepare(
  "SELECT id FROM contents WHERE creator_id=? AND content_type='video' AND content_url=? LIMIT 1"
);

// ── Transaction ───────────────────────────────────────────────────────────────
const tx = db.transaction(() => {
  let videoInserted = 0, nodeMapped = 0, skipped = 0;

  for (const v of YOUTUBE_VIDEOS) {
    const dup = checkDup.get(ADMIN_ID, v.url);
    if (dup) {
      // 이미 있는 영상 — 노드 매핑만 확인
      const nodes = getNodes.all(v.grade, v.area);
      for (const n of nodes) {
        insertNode.run(n.node_id, dup.id, 'lecture', 0);
        insertStd.run(dup.id, n.node_id);
        nodeMapped++;
      }
      skipped++;
      continue;
    }

    const areaTag = v.area;
    const tags = JSON.stringify(['수학', areaTag, `${v.grade}학년`, '유튜브', v.channel]);
    const desc = `${v.grade}학년 수학 ${v.area} 영역 강의 영상. 채널: ${v.channel}.`;

    const ci = insertContent.run(ADMIN_ID, v.title, desc, v.url, v.grade, tags);
    const contentId = ci.lastInsertRowid;
    videoInserted++;

    // 해당 학년×영역의 모든 차시 노드에 매핑
    const nodes = getNodes.all(v.grade, v.area);
    for (const n of nodes) {
      insertNode.run(n.node_id, contentId, 'lecture', 0);
      insertStd.run(contentId, n.node_id);
      nodeMapped++;
    }
  }

  return { videoInserted, nodeMapped, skipped };
});

const result = tx();
console.log(`✅ 유튜브 영상 삽입: ${result.videoInserted}개`);
console.log(`✅ 차시 노드 매핑: ${result.nodeMapped}건`);
console.log(`ℹ️  중복(기존 영상 노드 매핑): ${result.skipped}개`);

// 최종 매핑 현황
const stats = db.prepare(`
  SELECT
    (SELECT COUNT(DISTINCT node_id) FROM node_contents) as mapped_nodes,
    (SELECT COUNT(*) FROM learning_map_nodes WHERE node_level=3) as total_nodes,
    (SELECT COUNT(*) FROM contents WHERE content_type='video' AND is_public=1 AND status='approved') as total_videos,
    (SELECT COUNT(*) FROM contents WHERE content_type='quiz' AND is_public=1 AND status='approved') as total_quiz
`).get();

console.log(`\n📊 최종 현황:`);
console.log(`  AI 맞춤학습 매핑 노드: ${stats.mapped_nodes} / ${stats.total_nodes}`);
console.log(`  공개 영상 콘텐츠: ${stats.total_videos}개`);
console.log(`  공개 문항 콘텐츠: ${stats.total_quiz}개`);

db.close();
