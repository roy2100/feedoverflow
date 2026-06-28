#!/usr/bin/env bash
set -euo pipefail

# 原地更新部署：构建前端，安装/更新服务端依赖，重启 systemd 服务。
# 部署根目录即当前仓库目录（不复制到别处）。
# 以仓库属主身份运行（勿用 sudo），仅重启服务一步会调用 sudo。
# 用法：./scripts/update-linux.sh        （默认端口 3002，由已安装的 unit 决定）

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="rss-reader"
UNIT="/etc/systemd/system/$LABEL.service"

if [ "$(id -u)" -eq 0 ]; then
  echo "错误：请勿用 sudo 运行（否则 node_modules 会变为 root 属主）；脚本会在重启时自行提权" >&2
  exit 1
fi

# 1. 构建前端
echo "==> 构建前端"
npm install --prefix "$ROOT/client"
npm run --prefix "$ROOT/client" build

# 2. 安装服务端依赖（仅生产）
echo "==> 安装服务端依赖"
npm install --prefix "$ROOT/server" --omit=dev

# 3. 重启服务
if [ -f "$UNIT" ]; then
  echo "==> 重启服务"
  sudo systemctl restart "$LABEL"
  echo "==> 更新完成"
  sudo systemctl status "$LABEL" --no-pager -l | head -n 5 || true
else
  echo "==> 警告：systemd 服务未安装，请先执行 sudo ./scripts/install-service-linux.sh" >&2
fi
