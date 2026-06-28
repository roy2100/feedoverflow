#!/usr/bin/env bash
set -euo pipefail

# 卸载 systemd 系统服务（停止 + 取消自启 + 删除 unit）。
# 用法：sudo ./scripts/uninstall-service-linux.sh

LABEL="rss-reader"
UNIT="/etc/systemd/system/$LABEL.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "错误：请用 sudo 运行（需删除 $UNIT）" >&2
  exit 1
fi

if [ -f "$UNIT" ]; then
  echo "==> 停止并取消自启 $LABEL"
  systemctl disable --now "$LABEL" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "==> 已删除 $UNIT"
else
  echo "==> 未发现已安装的服务（$UNIT 不存在）"
  systemctl disable --now "$LABEL" 2>/dev/null || true
fi

echo "==> 卸载完成"
