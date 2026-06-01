# =============================================================================
# 다채움 GCP VM Bootstrap (로컬 PC PowerShell에서 실행)
# =============================================================================
# 전제: gcloud auth login + 프로젝트/리전/존 설정 + 결제 연결 완료
# 결과:
#   - 고정 외부 IP 예약
#   - HTTP/HTTPS 방화벽 규칙
#   - e2-small VM 생성, startup-script로 Node·Nginx·pm2·certbot 자동 설치
#   - VM 부팅 후 https://<IP-기반>.sslip.io 로 접속 가능 (SSL 발급은 startup 끝 단계)
#
# 사용법:
#   PS> cd deploy
#   PS> .\gcp-bootstrap.ps1
# =============================================================================

# ===== 변수 (필요 시 변경) =====
$VM_NAME       = "dacheum-vm"
$ZONE          = "asia-northeast3-a"
$MACHINE_TYPE  = "e2-small"
$IMAGE_FAMILY  = "ubuntu-2204-lts"
$IMAGE_PROJECT = "ubuntu-os-cloud"
$DISK_SIZE     = "30GB"
$STATIC_IP_NAME = "dacheum-ip"

# Git repo (public이면 https 그대로, private이면 별도 PAT 주입 후 사용)
$REPO_URL  = "https://github.com/mdg123/dcu2.5_prototype.git"
$REPO_DIR  = "dacheum"   # VM 안 디렉토리명: /home/ubuntu/dacheum

# Let's Encrypt 발급 이메일 (만료 알림 받을 곳)
$LE_EMAIL  = "claudedcu@gmail.com"

# ===== 사전 점검 =====
Write-Host "==[ 1/5 ] 사전 점검" -ForegroundColor Cyan
$proj = gcloud config get-value project 2>$null
if ([string]::IsNullOrWhiteSpace($proj)) {
  Write-Error "현재 gcloud project가 설정되지 않았습니다. 'gcloud config set project <ID>' 먼저 실행."
  exit 1
}
Write-Host "  project: $proj"
Write-Host "  zone:    $ZONE"
Write-Host "  vm:      $VM_NAME ($MACHINE_TYPE)"
Write-Host ""

# ===== 고정 IP 예약 =====
Write-Host "==[ 2/5 ] 고정 IP 예약" -ForegroundColor Cyan
$region = ($ZONE -replace '-[a-z]$', '')
$ipExists = gcloud compute addresses describe $STATIC_IP_NAME --region $region 2>$null
if ($LASTEXITCODE -ne 0) {
  gcloud compute addresses create $STATIC_IP_NAME --region $region
} else {
  Write-Host "  기존 IP $STATIC_IP_NAME 재사용"
}
$STATIC_IP = gcloud compute addresses describe $STATIC_IP_NAME --region $region --format="value(address)"
Write-Host "  외부 IP: $STATIC_IP"
$SSLIP_DOMAIN = ($STATIC_IP -replace '\.', '-') + ".sslip.io"
Write-Host "  접속 도메인: $SSLIP_DOMAIN"
Write-Host ""

# ===== 방화벽 규칙 =====
Write-Host "==[ 3/5 ] 방화벽 규칙 (HTTP/HTTPS)" -ForegroundColor Cyan
$fwExists = gcloud compute firewall-rules describe allow-http-https 2>$null
if ($LASTEXITCODE -ne 0) {
  gcloud compute firewall-rules create allow-http-https `
    --direction=INGRESS --action=ALLOW `
    --rules="tcp:80,tcp:443" `
    --source-ranges=0.0.0.0/0 `
    --target-tags="http-server,https-server"
} else {
  Write-Host "  기존 방화벽 규칙 재사용"
}
Write-Host ""

# ===== startup-script 준비 =====
Write-Host "==[ 4/5 ] startup-script 메타데이터 주입 + VM 생성" -ForegroundColor Cyan
$startupScript = Join-Path $PSScriptRoot "vm-startup.sh"
if (-not (Test-Path $startupScript)) {
  Write-Error "vm-startup.sh 파일이 같은 폴더에 없습니다."
  exit 1
}

# startup-script에 변수 치환 (REPO_URL, REPO_DIR, LE_EMAIL, DOMAIN)
$startupContent = Get-Content $startupScript -Raw -Encoding UTF8
$startupContent = $startupContent `
  -replace '__REPO_URL__', $REPO_URL `
  -replace '__REPO_DIR__', $REPO_DIR `
  -replace '__LE_EMAIL__', $LE_EMAIL `
  -replace '__DOMAIN__', $SSLIP_DOMAIN

$tempScript = New-TemporaryFile
Rename-Item $tempScript "$($tempScript).sh"
$tempScript = "$($tempScript).sh"
[System.IO.File]::WriteAllText($tempScript, $startupContent, [System.Text.UTF8Encoding]::new($false))

# ===== VM 생성 =====
$vmExists = gcloud compute instances describe $VM_NAME --zone $ZONE 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Warning "VM $VM_NAME 이미 존재. 삭제 후 재생성하려면 다음 명령 실행:"
  Write-Host "  gcloud compute instances delete $VM_NAME --zone=$ZONE --quiet"
  exit 0
}

gcloud compute instances create $VM_NAME `
  --zone=$ZONE `
  --machine-type=$MACHINE_TYPE `
  --image-family=$IMAGE_FAMILY `
  --image-project=$IMAGE_PROJECT `
  --boot-disk-size=$DISK_SIZE `
  --boot-disk-type=pd-ssd `
  --address=$STATIC_IP `
  --tags="http-server,https-server" `
  --metadata-from-file startup-script=$tempScript

Remove-Item $tempScript -Force

Write-Host ""
Write-Host "==[ 5/5 ] VM 생성 완료" -ForegroundColor Green
Write-Host ""
Write-Host "===== 다음 단계 =====" -ForegroundColor Yellow
Write-Host "1. VM 부팅 + startup-script 실행 (5~10분 대기)"
Write-Host "   상태 확인:"
Write-Host "     gcloud compute ssh $VM_NAME --zone=$ZONE --command='sudo tail -f /var/log/dacheum-startup.log'"
Write-Host ""
Write-Host "2. startup-script가 끝나면 https://$SSLIP_DOMAIN 접속 (빈 DB 상태)"
Write-Host ""
Write-Host "3. 로컬 데이터 업로드 (서버 정지 후 WAL checkpoint 권장):"
Write-Host "     gcloud compute scp ../backups/dacheum-data.tar.gz $($VM_NAME):~/ --zone=$ZONE"
Write-Host "     gcloud compute scp ../backups/dacheum-uploads.tar.gz $($VM_NAME):~/ --zone=$ZONE"
Write-Host ""
Write-Host "4. VM SSH 후 데이터 복원 + 재기동:"
Write-Host "     gcloud compute ssh $VM_NAME --zone=$ZONE"
Write-Host "     # VM 안에서"
Write-Host "     cd ~/$REPO_DIR"
Write-Host "     tar -xzf ~/dacheum-data.tar.gz -C ./"
Write-Host "     tar -xzf ~/dacheum-uploads.tar.gz -C ./"
Write-Host "     pm2 restart dacheum"
Write-Host ""
Write-Host "5. 접속: https://$SSLIP_DOMAIN"
