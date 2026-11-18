#!/bin/bash
# GetVideo v4.0 服务器一键部署/更新脚本（Ubuntu + Node.js 20 + systemd）
set -euo pipefail

APP_USER="${APP_USER:-$(whoami)}"
APP_DIR="${APP_DIR:-$HOME/getvideo}"
SERVICE_NAME="${SERVICE_NAME:-getvideo}"
PORT="${PORT:-3000}"

echo "=========================================="
echo "  GetVideo v4.0 部署 ($APP_USER @ $APP_DIR)"
echo "=========================================="

# 1. 如未安装 Node.js 20 LTS 则安装
if ! command -v node >/dev/null 2>&1; then
  echo "[1/4] 安装 Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "[1/4] Node.js $(node -v) / npm $(npm -v)"

# 2. 安装生产依赖
echo "[2/4] 安装生产依赖..."
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# 3. 配置 systemd 服务（低内存占用 + 开机自启 + 自动重启）
echo "[3/4] 配置 systemd 服务 ($SERVICE_NAME.service)..."
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=GetVideo Aggregator & Zero-Traffic M3U8 Proxy
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=3
MemoryMax=256M

[Install]
WantedBy=multi-user.target
EOF

# 4. 启动/重启服务
echo "[4/4] 启动服务..."
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"
sleep 1
sudo systemctl status "${SERVICE_NAME}" --no-pager -l | head -n 20

echo ""
echo "部署完成！常用命令："
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
