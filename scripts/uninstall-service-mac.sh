#!/usr/bin/env bash
set -euo pipefail

# 卸载 launchd 开机自启服务（停止运行 + 取消自启 + 删除 plist）。
# 用法：./scripts/uninstall-service-mac.sh

LABEL="com.rss-reader.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  echo "==> 停止并取消自启 $LABEL"
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "==> 已删除 $PLIST"
else
  echo "==> 未发现已安装的服务（$PLIST 不存在）"
  launchctl unload "$PLIST" 2>/dev/null || true
fi

echo "==> 卸载完成"
