#!/usr/bin/env bash
set -euo pipefail

# 日常部署：构建前端，同步到 ~/Deploy/rss-reader/，重启服务。
# 用法：./deploy.sh        （默认端口 3002）
#       PORT=8080 ./deploy.sh

DEV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$HOME/Deploy/rss-reader"
LABEL="com.rss-reader.app"
PORT="${PORT:-3002}"

if [ ! -d "$DEPLOY_ROOT" ]; then
  echo "错误：请先执行 ./migrate-to-deploy.sh"
  exit 1
fi

# 1. 构建前端
echo "==> 构建前端"
npm install --prefix "$DEV_ROOT/client"
npm run --prefix "$DEV_ROOT/client" build

# 2. 同步代码 + 构建产物
echo "==> 同步代码"
rsync -a --delete --exclude='node_modules/' --exclude='rss.db' --exclude='rss.db-*' \
  "$DEV_ROOT/server/" "$DEPLOY_ROOT/server/"
rsync -a --delete \
  "$DEV_ROOT/client/dist/" "$DEPLOY_ROOT/client/dist/"

# 3. 安装生产依赖
echo "==> 安装服务端依赖"
npm install --prefix "$DEPLOY_ROOT/server" --omit=dev

# 4. 重启服务
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ]; then
  echo "==> 重启服务"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  echo "==> 警告：launchd 未注册，请先执行 ./migrate-to-deploy.sh"
fi

echo "==> 部署完成 → http://localhost:$PORT"
echo "    日志：$DEPLOY_ROOT/logs/app.log（结构化 NDJSON），$DEPLOY_ROOT/logs/server.log（原始 stderr）"
