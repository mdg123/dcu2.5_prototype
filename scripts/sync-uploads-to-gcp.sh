#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 업로드 파일 GCP 동기화 — 배포 절차의 필수 단계
#
# 왜 필요한가:
#   public/uploads/ 는 .gitignore 대상이라 git 배포(pull)로 전달되지 않는다.
#   로컬에서 업로드한 파일(콘텐츠 첨부·갤러리 작품·과제 제출물)은 실서버에
#   갈 경로가 아예 없어서, DB 는 참조하는데 파일이 없는 상태가 쌓인다.
#
#   2026-08-06 실측: GCP 디스크 5개 / DB 참조 27종 → 23종이 404.
#   학생 갤러리에서 이미지 34개 중 23개가 깨져 보였다.
#   이 스크립트로 17종을 복구(깨짐 23 → 10)했고, 남은 10종은 시드가 지어낸
#   존재하지 않는 파일명(placeholder.jpg·mindmap.png 등)이라 별건이다.
#
# 안전장치:
#   --skip-old-files 로 추출하므로 **실서버에만 있는 파일은 절대 덮어쓰지 않는다.**
#   (실서버에서 직접 업로드된 파일이 있다 — 위 실측 시점 5개)
#
# 사용:
#   bash scripts/sync-uploads-to-gcp.sh              # 실행
#   DRY=1 bash scripts/sync-uploads-to-gcp.sh        # 무엇이 올라갈지만 확인
#
# 배포 순서(권장):
#   1) git push
#   2) GCP: git pull --rebase && pm2 restart all
#   3) **이 스크립트** (업로드 파일 동기화)
#   4) 데이터 변형 스크립트를 돌렸다면 재집계 + npm test (CLAUDE.md 하네스 규칙 5)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VM="${VM:-dacheum-vm}"
ZONE="${ZONE:-asia-northeast3-a}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/dacheum/public}"
LOCAL_UPLOADS="public/uploads"
TARBALL="${TMPDIR:-/tmp}/uploads_sync_$$.tgz"

if [ ! -d "$LOCAL_UPLOADS" ]; then
  echo "❌ $LOCAL_UPLOADS 가 없습니다. 프로젝트 루트에서 실행하십시오." >&2
  exit 1
fi

COUNT=$(find "$LOCAL_UPLOADS" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$LOCAL_UPLOADS" | cut -f1)
echo "로컬 업로드: ${COUNT}개 (${SIZE})"

if [ "${DRY:-0}" = "1" ]; then
  echo "— DRY RUN — 아래 파일이 대상입니다(실서버에 이미 있으면 건너뜁니다):"
  find "$LOCAL_UPLOADS" -type f | sed 's|^public||'
  exit 0
fi

echo "① 아카이브 생성…"
tar -czf "$TARBALL" -C public uploads
echo "   $(ls -lh "$TARBALL" | awk '{print $5}')"

echo "② 전송…"
gcloud compute scp "$TARBALL" "${VM}:/tmp/uploads_sync.tgz" --zone="$ZONE"

echo "③ 추출(기존 파일 보존)…"
gcloud compute ssh "$VM" --zone="$ZONE" --command="\
sudo cp /tmp/uploads_sync.tgz /home/ubuntu/ && \
sudo chown ubuntu:ubuntu /home/ubuntu/uploads_sync.tgz && \
sudo -iu ubuntu bash -lc 'cd ${REMOTE_DIR} && \
  echo \"   전: \$(find uploads -type f | wc -l)개\" && \
  tar -xzf /home/ubuntu/uploads_sync.tgz --skip-old-files && \
  echo \"   후: \$(find uploads -type f | wc -l)개\" && du -sh uploads' && \
sudo rm -f /tmp/uploads_sync.tgz /home/ubuntu/uploads_sync.tgz"

rm -f "$TARBALL"
echo "✅ 완료 — 실서버에만 있던 파일은 보존됐습니다."
