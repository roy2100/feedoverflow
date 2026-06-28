#!/usr/bin/env bash
set -euo pipefail

# 安装 systemd 系统服务（开机自启，崩溃自动重启）。
# 部署根目录即当前仓库目录（原地运行，不复制到别处）。
# 用法：sudo ./scripts/install-service-linux.sh
# 端口在 server/.env 的 PORT 设置（默认 3002），unit 不再写死——改端口只需改 .env 再重启。
# 卸载：sudo ./scripts/uninstall-service-linux.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="rss-reader"
UNIT="/etc/systemd/system/$LABEL.service"
# 端口由 server/.env 的 PORT 决定（app 的 load-env.ts 在启动时读取）；unit 不写死 PORT，
# 这里仅解析展示用端口供最后的提示信息使用。
ENV_FILE="$ROOT/server/.env"
PORT="$([ -f "$ENV_FILE" ] && grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
PORT="${PORT:-3002}"

if [ "$(id -u)" -ne 0 ]; then
  echo "错误：请用 sudo 运行（需写入 $UNIT）" >&2
  exit 1
fi

# 以 sudo 调用者身份运行服务，避免 app 以 root 运行（node_modules/日志保持用户属主）。
RUN_USER="${SUDO_USER:-root}"
RUN_GROUP="$(id -gn "$RUN_USER")"

# node 路径需在嵌入 unit 前解析为绝对路径。sudo 下 PATH 常丢失，回退到调用者的登录 shell。
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ "$RUN_USER" != "root" ]; then
  NODE_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v node' || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误：找不到 node（需 ≥ 24，用于原生 TS 类型擦除）" >&2
  exit 1
fi

mkdir -p "$ROOT/logs"
chown "$RUN_USER:$RUN_GROUP" "$ROOT/logs"

echo "==> 生成 $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=RSS Reader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/server/index.ts
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> 重新加载 systemd 并启用服务"
systemctl daemon-reload
systemctl enable --now "$LABEL"

echo "==> 完成：$LABEL 已设为开机自启（运行用户 $RUN_USER）"
echo "    访问 http://localhost:$PORT"
echo "    状态 sudo systemctl status $LABEL"
echo "    日志 sudo journalctl -u $LABEL -f  （应用结构化日志见 $ROOT/logs/app.log）"
