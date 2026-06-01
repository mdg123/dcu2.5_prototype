#!/bin/bash
# =============================================================================
# ?ㅼ콈? VM Startup Script (Ubuntu 22.04 LTS)
# - GCP VM 泥?遺?????먮룞 ?ㅽ뻾 (root)
# - Node.js LTS, nginx, pm2, certbot ?ㅼ튂
# - ?ㅼ콈? repo clone ??npm ci ??pm2 start
# - nginx 由щ쾭???꾨줉??(Socket.IO ?ㅻ뜑 ?ы븿)
# - Let's Encrypt SSL 諛쒓툒 ?쒕룄 (sslip.io ?꾨찓??
# - 紐⑤뱺 ?④퀎 idempotent (?ъ떎???덉쟾)
# =============================================================================
set -e
exec > >(tee -a /var/log/dacheum-startup.log) 2>&1
echo "==[ $(date) ] startup-script ?쒖옉"

# bootstrap??移섑솚??蹂?섎뱾
REPO_URL="https://github.com/mdg123/dcu2.5_prototype.git"
REPO_DIR="dacheum"
LE_EMAIL="claudedcu@gmail.com"
DOMAIN="34-22-69-18.sslip.io"
APP_USER="ubuntu"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/${REPO_DIR}"
APP_PORT="3000"

# ---------- ?쒓컙? ----------
echo "==[ tz ] Asia/Seoul"
timedatectl set-timezone Asia/Seoul || true

# ---------- ?⑦궎吏 ----------
echo "==[ apt ] ?낅뜲?댄듃 + 湲곕낯 ?⑦궎吏"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential nginx certbot python3-certbot-nginx ufw sqlite3

# ---------- Node.js LTS (NodeSource) ----------
if ! command -v node >/dev/null 2>&1; then
  echo "==[ node ] NodeSource LTS ?ㅼ튂"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

# ---------- pm2 ----------
if ! command -v pm2 >/dev/null 2>&1; then
  echo "==[ pm2 ] 湲濡쒕쾶 ?ㅼ튂"
  npm install -g pm2
fi

# ---------- repo clone (?놁쑝硫? ----------
if [ ! -d "${APP_DIR}/.git" ]; then
  echo "==[ git ] clone ${REPO_URL}"
  sudo -u ${APP_USER} git clone "${REPO_URL}" "${APP_DIR}"
else
  echo "==[ git ] 湲곗〈 repo ?ъ궗????pull"
  sudo -u ${APP_USER} bash -lc "cd '${APP_DIR}' && git pull --ff-only || true"
fi

# ---------- npm ci ----------
echo "==[ npm ] production ?섏〈???ㅼ튂"
sudo -u ${APP_USER} bash -lc "cd '${APP_DIR}' && npm ci --omit=dev || npm install --omit=dev"

# ---------- 湲곕낯 .env (?ㅼ젣 鍮꾨?媛믪? ?ъ슜?먭? ?꾩냽 ?낅줈???섏젙) ----------
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "==[ env ] .env placeholder ?앹꽦"
  cat > "${APP_DIR}/.env" <<EOF
NODE_ENV=production
PORT=${APP_PORT}
SESSION_SECRET=$(openssl rand -hex 32)
EOF
  chown ${APP_USER}:${APP_USER} "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
fi

# ---------- data/ uploads/ ?붾젆?좊━ 蹂댁옣 ----------
sudo -u ${APP_USER} mkdir -p "${APP_DIR}/data" "${APP_DIR}/uploads"

# ---------- pm2 ?쒖옉 ----------
echo "==[ pm2 ] start"
sudo -u ${APP_USER} bash -lc "cd '${APP_DIR}' && pm2 start server.js --name dacheum --update-env || pm2 restart dacheum"
sudo -u ${APP_USER} bash -lc "pm2 save"

# pm2 startup ?깅줉 (?щ??????먮룞 蹂듦뎄)
PM2_STARTUP=$(sudo -u ${APP_USER} bash -lc "pm2 startup systemd -u ${APP_USER} --hp ${APP_HOME}" | grep "sudo env" | tail -n1)
if [ -n "${PM2_STARTUP}" ]; then
  eval "${PM2_STARTUP}"
fi

# ---------- nginx ?ㅼ젙 ----------
echo "==[ nginx ] ?ㅼ젙 ?묒꽦"
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

        # Socket.IO WebSocket ?낃렇?덉씠??        proxy_set_header Upgrade \$http_upgrade;
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

# ---------- Let's Encrypt SSL (sslip.io??DNS 利됱떆 議고쉶 媛?? ----------
echo "==[ certbot ] SSL 諛쒓툒 ?쒕룄 (${DOMAIN})"
if certbot --nginx --non-interactive --agree-tos --redirect \
    --email "${LE_EMAIL}" -d "${DOMAIN}"; then
  echo "==[ certbot ] 諛쒓툒 ?깃났"
else
  echo "!![ certbot ] 諛쒓툒 ?ㅽ뙣 ???섎룞?쇰줈 ?ъ떆??媛?? sudo certbot --nginx -d ${DOMAIN}"
fi

# ---------- 留덈Т由?----------
echo "==[ done ] $(date) ??https://${DOMAIN}"
echo "==[ pm2 ] ?곹깭:"
sudo -u ${APP_USER} pm2 status
