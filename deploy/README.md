# 다채움 GCP 배포 가이드 (e2-small + sslip.io + Let's Encrypt)

로컬 PC PowerShell + GCP `newdcu30-prototype` 프로젝트 기준.

---

## 0. 전제 (이미 완료된 것)
- [x] GCP 프로젝트 `newdcu30-prototype` 생성 + 결제 연결
- [x] `gcloud auth login` 인증
- [x] `gcloud config set project / region / zone` 설정
- [x] `compute.googleapis.com` API 활성화

확인:
```powershell
gcloud config list
gcloud beta billing projects describe newdcu30-prototype
```

---

## 1. VM 생성 (자동)

작업 폴더 루트에서:

```powershell
cd deploy
.\gcp-bootstrap.ps1
```

수행 내용:
- 고정 외부 IP 예약 (`dacheum-ip`)
- HTTP/HTTPS 방화벽 규칙
- e2-small VM 생성 + startup-script 주입
- VM 부팅 후 자동으로 Node·Nginx·pm2·certbot 설치 + Git clone + 의존성 + pm2 start

종료 시 다음 같은 메시지 출력:
```
외부 IP: 34.64.123.45
접속 도메인: 34-64-123-45.sslip.io
```

---

## 2. VM startup-script 완료 대기 (5~10분)

VM이 부팅 후 startup-script가 끝나야 서비스가 실제 동작합니다. 진행 로그 실시간 보기:

```powershell
gcloud compute ssh dacheum-vm --zone=asia-northeast3-a --command="sudo tail -f /var/log/dacheum-startup.log"
```

마지막 줄에 `==[ done ]` 또는 `==[ certbot ] 발급 성공`이 보이면 끝. `Ctrl+C`로 빠져나오기.

이 시점에 https://34-64-123-45.sslip.io 접속하면 **빈 DB로 새 다채움**이 떠 있습니다.

---

## 3. 로컬 데이터 백업 (현재 운영 중인 다채움 데이터)

> ⚠ **로컬 서버를 잠시 정지**한 뒤 진행. 그래야 WAL이 안전하게 체크포인트됨.

작업 폴더 루트에서:

```powershell
# 3-1. 로컬 다채움 서버 정지 (실행 중이면)
#      포트 3000 잡고 있는 node 프로세스 종료
#      (preview MCP 사용 중이면 preview_stop으로 정지)

# 3-2. WAL 체크포인트
node -e "const D=require('better-sqlite3');const d=new D('data/dacheum.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close();console.log('checkpoint done')"

# 3-3. 압축
mkdir -Force backups
tar -czf backups/dacheum-data.tar.gz data/dacheum.db data/dacheum.db-wal data/dacheum.db-shm data/sessions.sqlite 2>$null
tar -czf backups/dacheum-uploads.tar.gz uploads/
```

`tar`가 없으면 Windows 11 기본 내장이라 PowerShell에서 그대로 동작.

---

## 4. VM에 데이터 업로드

```powershell
gcloud compute scp backups/dacheum-data.tar.gz dacheum-vm:~/ --zone=asia-northeast3-a
gcloud compute scp backups/dacheum-uploads.tar.gz dacheum-vm:~/ --zone=asia-northeast3-a
```

uploads/가 2GB 초과면 GCS 버킷 경유가 빠름:

```powershell
gcloud storage buckets create gs://newdcu30-transfer --location=asia-northeast3
gcloud storage cp backups/dacheum-uploads.tar.gz gs://newdcu30-transfer/
# VM 안에서: gcloud storage cp gs://newdcu30-transfer/dacheum-uploads.tar.gz ~/
```

---

## 5. VM 안에서 복원 + 재기동

```powershell
gcloud compute ssh dacheum-vm --zone=asia-northeast3-a
```

VM 셸 (`ubuntu@dacheum-vm:~$`) 안에서:

```bash
cd ~/dacheum

# DB 복원 (빈 data/ 덮어쓰기)
tar -xzf ~/dacheum-data.tar.gz -C ./
ls -la data/                # 3개 파일 확인

# uploads 복원
tar -xzf ~/dacheum-uploads.tar.gz -C ./
du -sh uploads              # 사이즈 로컬과 비교

# 권한 보정
sudo chown -R ubuntu:ubuntu data uploads
chmod 700 data

# 압축본 정리
rm ~/dacheum-data.tar.gz ~/dacheum-uploads.tar.gz

# 무결성 점검
sqlite3 data/dacheum.db "PRAGMA integrity_check;"     # ok
sqlite3 data/dacheum.db "SELECT COUNT(*) FROM users;" # 로컬 값과 일치 확인

# 재기동
pm2 restart dacheum
pm2 logs dacheum --lines 50 --nostream     # 정상 부팅 로그 확인
```

브라우저: **https://34-64-123-45.sslip.io** 접속 → 기존 사용자 계정으로 로그인 가능하면 성공.

---

## 6. 운영 체크리스트

| 확인 | 방법 |
|---|---|
| pm2 데몬 살아있나 | VM 안 `pm2 status` |
| 서비스 외부 접속 | 브라우저 `https://<DOMAIN>` |
| SSL 유효 | 자물쇠 클릭 → 발급자 Let's Encrypt |
| Socket.IO 동작 | 클래스 게시판 댓글·실시간 알림 |
| 디스크 사용량 | VM `df -h /` |
| 백업 | `pm2 stop dacheum && sqlite3 .. wal_checkpoint && cp data/* ~/backups/` |

### 정기 백업 (cron)
```bash
sudo crontab -e
# 매일 03:00 KST 백업 (예시)
0 3 * * * /usr/bin/tar -czf /home/ubuntu/backups/dacheum-$(date +\%Y\%m\%d).tar.gz -C /home/ubuntu/dacheum data uploads
```

### Cloud Storage로 자동 송출 (선택)
```bash
gcloud storage cp /home/ubuntu/backups/dacheum-*.tar.gz gs://newdcu30-backup/
```

---

## 7. 자주 막히는 부분

### A. startup-script 도중 에러
```powershell
gcloud compute ssh dacheum-vm --zone=asia-northeast3-a --command="sudo cat /var/log/dacheum-startup.log"
```
로그 마지막 부분 보고 어떤 단계에서 죽었는지 확인.

### B. Let's Encrypt 발급 실패
포트 80이 막혀 있거나 sslip.io DNS 응답 지연이 원인. VM 안에서 수동 재시도:
```bash
sudo certbot --nginx -d 34-64-123-45.sslip.io --email claudedcu@gmail.com --agree-tos --redirect
```

### C. pm2 logs에서 SQLite 잠금 에러
다른 곳(로컬?)에서 같은 DB 파일을 동시에 잡고 있을 때. data/dacheum.db-wal/shm 같이 옮겨졌는지 확인.

### D. private GitHub repo면 clone 실패
startup-script의 `git clone`이 실패. 옵션:
- repo를 public으로 임시 전환
- 또는 VM에 SSH 후 직접 PAT로 clone: `git clone https://USER:TOKEN@github.com/mdg123/dcu2.5_prototype.git dacheum`

---

## 8. VM 삭제 / 재생성

```powershell
# 완전 삭제 (데이터까지)
gcloud compute instances delete dacheum-vm --zone=asia-northeast3-a --quiet
gcloud compute addresses delete dacheum-ip --region=asia-northeast3 --quiet

# 재생성
.\gcp-bootstrap.ps1
```

VM만 재생성하고 IP는 유지하려면 `addresses delete`만 빼고 실행.

---

## 9. 비용 예상 (e2-small + 서울 리전)

| 항목 | 월 |
|---|---|
| e2-small VM (24/7) | $13.6 |
| 고정 외부 IP | $2.9 |
| PD-SSD 30GB | $5.1 |
| 송신 트래픽 (1GB/일 가정) | $3.6 |
| **합계** | **~$25/월** |

신규 가입 시 $300 크레딧으로 약 1년 무료.
