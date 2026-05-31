#!/bin/bash
# GetVideo 服务器一键初始化脚本
# 在 Ubuntu EC2 上执行

set -e

echo "=========================================="
echo "  GetVideo 服务器初始化"
echo "=========================================="

# 1. 更新系统
echo ""
echo "[1/5] 更新系统包..."
sudo apt update -y && sudo apt upgrade -y

# 2. 安装 Node.js 20 LTS
echo ""
echo "[2/5] 安装 Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
echo "  Node.js: $(node --version)"
echo "  npm: $(npm --version)"

# 3. 安装 unzip 并解压项目
echo ""
echo "[3/5] 解压项目..."
sudo apt install -y unzip
cd /home/ubuntu
rm -rf getvideo
mkdir -p getvideo
unzip -o project.zip -d getvideo/
echo "  项目文件："
ls -la getvideo/

# 4. 安装依赖
echo ""
echo "[4/5] 安装 npm 依赖..."
cd /home/ubuntu/getvideo
npm install --production
echo "  依赖安装完成"

# 5. 安装 PM2 并启动
echo ""
echo "[5/5] 安装 PM2 并启动服务..."
sudo npm install -g pm2
pm2 delete getvideo 2>/dev/null || true
pm2 start server.js --name getvideo
pm2 save
pm2 startup | grep -oP 'sudo .*' | bash 2>/dev/null || true

echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
echo "  服务状态："
pm2 status
echo ""
echo "  访问地址：http://$(curl -s http://checkip.amazonaws.com):3000"
echo ""
echo "  常用命令："
echo "    pm2 status          查看状态"
echo "    pm2 logs getvideo   查看日志"
echo "    pm2 restart getvideo 重启服务"
echo "    pm2 stop getvideo   停止服务"
echo ""
