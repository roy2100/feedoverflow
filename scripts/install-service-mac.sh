#!/usr/bin/env bash
set -euo pipefail

# 安装 launchd 开机自启（LaunchAgent）。
# 登录后自动启动，崩溃自动拉起（KeepAlive）。
# 用法：./scripts/install-service-mac.sh           （默认端口 3002）
#       PORT=8080 ./scripts/install-service-mac.sh
# 卸载：./scripts/uninstall-service-mac.sh

ROOT="$HOME/Deploy/rss-reader"
LABEL="com.rss-reader.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
PORT="${PORT:-3002}"

if [ ! -d "$ROOT" ]; then
  echo "错误：$ROOT 不存在，请先执行 ./migrate-to-deploy.sh"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

echo "==> 生成 $PLIST"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key>  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>      <string>$PORT</string>
    <key>NODE_ENV</key>  <string>production</string>
    <key>PATH</key>      <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>$ROOT/logs/server.log</string>
  <key>StandardErrorPath</key> <string>$ROOT/logs/server.log</string>
</dict>
</plist>
EOF

echo "==> 加载服务"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "==> 完成：$LABEL 已设为开机自启"
echo "    访问 http://localhost:$PORT"
echo "    日志 $ROOT/logs/server.log"
