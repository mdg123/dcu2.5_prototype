#!/bin/bash
# =============================================================================
# 다채움 VM Startup Script (Ubuntu 22.04 LTS)
# - GCP VM 첫 부팅 시 자동 실행 (root)
# - Node.js LTS, nginx, pm2, certbot 설치
# - 다채움 repo clone → npm ci → pm2 start
# - nginx 리버스 프록시 (Socket.IO 헤더 포함)
# - Let's Encrypt SSL 발급 시도 (sslip.io 도메인)
# - 모든 단계 idempotent (재실행 안전)
# =============================================================================
set -e
exec > >(tee -a /var/log/dacheum-startup.log) 2>&1
echo "==[ $(date) ] startup-script 시작"

# bootstrap이 치환한 변수들
REPO_URL="__REPO_URL__"
REPO_DIR="__REPO_DIR__"
LE_EMAIL="__LE_EMAIL__"
DOMAIN="__DOMAIN__"
APP_USER="ubuntu"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/${REPO_DIR}"
APP_PORT="3000"

# ---------- 시간대 ----------
echo "==[ tz ] Asia/Seoul"
timedatectl set-timezone Asia/Seoul || true

# ---------- 패키지 ----------
echo "==[ apt ] 업데이트 + 기본 패키지"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential nginx certbot python3-certbot-nginx ufw sqlite3

# ---------- Node.js LTS (NodeSource) ----------
if ! command -v node >/dev/null 2>&1; then
  echo "==[ node ] NodeSource LTS 설치"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

# ---------- pm2 ----------
if ! command -v pm2 >/dev/null 2>&1; then
  echo "==[ pm2 ] 글로벌 설치"
  npm install -g pm2
fi

# ---------- repo clone (없으면) ----------
if [ ! -d "${APP_DIR}/.git" ]; then
  echo "==[ git ] clone ${REPO_URL}"
  sudo -u ${APP_USER} git clone "${REPO_URL}" "${APP_DIR}"
else
  echo "==[ git ] 기존 repo 재사용 — pull"
  sudo -u ${APP_USER} bash -lc "cd '${APP_DIR}' && git pull --ff-only || true"
fi

# ---------- npm ci ----------
echo "==[ npm ] production 의존성 설치"
sudo -u ${APP_USER} bash -lc "cd '${APP_DIR}' && npm ci --omit=dev || npm install --omit=dev"

# ---------- 기본 .env (실제 비밀값은 사용자가 후속 업로드/수정) ----------
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "==[ env ] .env placeholder 생성"
  cat > "${APP_DIR}/.env" <<EOF
NODE_ENV=production
PORT=${APP_PORT}
SESSION_SECRET=$(openssl rand -hex 32)
EOF
  chown ${APP_USER}:${APP_USER} "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
fi

# ---------- data/ uploads/ 디렉토리 보장 ----------
sudo -u ${APP_USER} mkdir -p "${APP_DIR}/data" "${APP_DIR}/uploads"

# ---------- pm2 시작 ----------
echo "==[ pm2 ] start"
sudo -u ${APP_USER} bash -lc "cd '${APP_DIR}' && pm2 start server.js --name dacheum --update-env || pm2 restart dacheum"
sudo -u ${APP_USER} bash -lc "pm2 save"

# pm2 startup 등록 (재부팅 시 자동 복구)
PM2_STARTUP=$(sudo -u ${APP_USER} bash -lc "pm2 startup systemd -u ${APP_USER} --hp ${APP_HOME}" | grep "sudo env" | tail -n1)
if [ -n "${PM2_STARTUP}" ]; then
  eval "${PM2_STARTUP}"
fi

# ---------- nginx 설정 ----------
echo "==[ nginx ] 설정 작성"
NGINX_CONF="/etc/nginx/sites-available/dacheum"
cat > "${NGINX_CONF}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Socket.IO WebSocket 업그레이드
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
EOF
ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/dacheum
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
systemctl enable nginx

# ---------- Let's Encrypt SSL (sslip.io는 DNS 즉시 조회 가능) ----------
echo "==[ certbot ] SSL 발급 시도 (${DOMAIN})"
if certbot --nginx --non-interactive --agree-tos --redirect \
    --email "${LE_EMAIL}" -d "${DOMAIN}"; then
  echo "==[ certbot ] 발급 성공"
else
  echo "!![ certbot ] 발급 실패 — 수동으로 재시도 가능: sudo certbot --nginx -d ${DOMAIN}"
fi

# ---------- 마무리 ----------
echo "==[ done ] $(date) — https://${DOMAIN}"
echo "==[ pm2 ] 상태:"
sudo -u ${APP_USER} pm2 status
