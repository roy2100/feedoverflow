#!/usr/bin/env bash
# 用法：sudo ./deploy-linux.sh
# 首次运行会安装服务；之后每次执行只做构建 + 同步 + 重启。
set -euo pipefail

DEV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="/opt/rss-reader"
SERVICE="rss-reader"
NODE="$(command -v node)"

# ── 首次安装 ─────────────────────────────────────────────────────────────────
if [ ! -d "$DEPLOY_ROOT" ]; then
  echo "==> 初始化部署目录 $DEPLOY_ROOT"
  mkdir -p "$DEPLOY_ROOT/server" "$DEPLOY_ROOT/client/dist" "$DEPLOY_ROOT/data"
  # 数据库放在独立目录，不会被 rsync 覆盖
  ln -sf "$DEPLOY_ROOT/data/rss.db" "$DEPLOY_ROOT/server/rss.db"
fi

# ── 构建前端 ──────────────────────────────────────────────────────────────────
echo "==> 构建前端"
npm --prefix "$DEV_ROOT/client" install
npm --prefix "$DEV_ROOT/client" run build

# ── 同步文件（不覆盖数据库）────────────────────────────────────────────────────
echo "==> 同步服务端代码"
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='rss.db' \
  --exclude='rss.db-*' \
  "$DEV_ROOT/server/" "$DEPLOY_ROOT/server/"

echo "==> 同步前端构建产物"
rsync -a --delete "$DEV_ROOT/client/dist/" "$DEPLOY_ROOT/client/dist/"

# ── 安装生产依赖 ──────────────────────────────────────────────────────────────
echo "==> 安装服务端依赖"
npm --prefix "$DEPLOY_ROOT/server" install --omit=dev

# ── 权限 ─────────────────────────────────────────────────────────────────────
chown -R www-data:www-data "$DEPLOY_ROOT"

# ── 注册并启动 systemd 服务（仅首次）─────────────────────────────────────────
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
if [ ! -f "$UNIT_DST" ]; then
  echo "==> 注册 systemd 服务"
  cp "$DEV_ROOT/rss-reader.service" "$UNIT_DST"
  systemctl daemon-reload
  systemctl enable "$SERVICE"
fi

# ── 重启服务 ──────────────────────────────────────────────────────────────────
echo "==> 重启服务"
systemctl restart "$SERVICE"
systemctl is-active --quiet "$SERVICE" && echo "==> 服务运行中" || { echo "错误：服务启动失败"; journalctl -u "$SERVICE" -n 20; exit 1; }

echo "==> 部署完成"
echo "    查看日志：journalctl -u $SERVICE -f"
