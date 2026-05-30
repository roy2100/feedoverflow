#!/usr/bin/env bash
set -euo pipefail

# 一次性迁移脚本：初始化部署目录并注册 launchd 服务。
# 执行后，日常部署改用 ./deploy.sh
# 用法：./migrate-to-deploy.sh

DEV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$HOME/Deploy/rss-reader"
LABEL="com.rss-reader.app"
OLD_LABEL="rss-reader.backend"
OLD_PLIST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-3002}"
NODE_BIN="$(command -v node)"

echo "开发目录：$DEV_ROOT"
echo "部署目录：$DEPLOY_ROOT"

# 1. 停止现有服务
echo "==> 停止现有服务"
if launchctl list "$OLD_LABEL" &>/dev/null; then
  launchctl unload "$OLD_PLIST" 2>/dev/null || true
  echo "    旧服务 $OLD_LABEL 已停止"
fi
if launchctl list "$LABEL" &>/dev/null; then
  launchctl unload "$PLIST" 2>/dev/null || true
  echo "    服务 $LABEL 已停止"
fi

# 2. 创建目录
echo "==> 创建部署目录"
mkdir -p "$DEPLOY_ROOT/logs" "$DEPLOY_ROOT/server" "$DEPLOY_ROOT/client"

# 3. 迁移数据（仅首次，不覆盖已有 db）
echo "==> 迁移数据"
if [ ! -f "$DEPLOY_ROOT/server/rss.db" ] && [ -f "$DEV_ROOT/server/rss.db" ]; then
  cp "$DEV_ROOT/server/rss.db" "$DEPLOY_ROOT/server/rss.db"
  echo "    rss.db 已迁移"
elif [ -f "$DEPLOY_ROOT/server/rss.db" ]; then
  echo "    已有 rss.db，跳过"
else
  echo "    原数据库不存在，将在首次启动时自动创建"
fi

# 4. 构建前端
echo "==> 构建前端"
npm --prefix "$DEV_ROOT/client" install
npm --prefix "$DEV_ROOT/client" run build

# 5. 同步代码 + 构建产物
echo "==> 同步代码"
rsync -a --delete --exclude='node_modules/' --exclude='rss.db' --exclude='rss.db-*' \
  "$DEV_ROOT/server/" "$DEPLOY_ROOT/server/"
rsync -a --delete \
  "$DEV_ROOT/client/dist/" "$DEPLOY_ROOT/client/dist/"

# 6. 安装生产依赖
echo "==> 安装服务端依赖"
npm --prefix "$DEPLOY_ROOT/server" install --omit=dev

# 7. 注册 launchd 服务
echo "==> 注册 launchd 服务"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEPLOY_ROOT/server/index.js</string>
  </array>
  <key>WorkingDirectory</key>  <string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>      <string>$PORT</string>
    <key>NODE_ENV</key>  <string>production</string>
    <key>PATH</key>      <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>$DEPLOY_ROOT/logs/server.log</string>
  <key>StandardErrorPath</key> <string>$DEPLOY_ROOT/logs/server.log</string>
</dict>
</plist>
EOF

launchctl load -w "$PLIST"
echo "    launchd 服务已注册并启动"

# 8. 清理旧 plist
if [ -f "$OLD_PLIST" ]; then
  rm -f "$OLD_PLIST"
  echo "    已删除旧 plist：$OLD_PLIST"
fi

echo ""
echo "==> 迁移完成 → http://localhost:$PORT"
echo "    日志：$DEPLOY_ROOT/logs/server.log"
echo "    后续部署：./deploy.sh"
