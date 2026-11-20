#!/usr/bin/env bash
# 单实例发布：候选构建 → 校验/落盘 → 切指针 → 重启 → 冒烟；失败回滚。
#
# 前置条件：
# - systemd unit 设置 WorkingDirectory=/opt/agent-network 与
#   Environment=WEB_RELEASES_ROOT=/opt/agent-network-releases；
# - 数据目录、PUBLIC_ORIGIN 等原有配置不变；
# - 本脚本不执行 db:migrate，也不跑生产测试。
#
# 用法（在服务器上）：
#   sudo bash scripts/deploy-web-release.sh
# 可用环境变量覆盖：
#   APP_DIR RELEASES_ROOT SERVICE BASE_URL SUDO SMOKE_TIMEOUT_SECONDS

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/agent-network}
RELEASES_ROOT=${RELEASES_ROOT:-/opt/agent-network-releases}
SERVICE=${SERVICE:-agent-network}
BASE_URL=${BASE_URL:-http://127.0.0.1:8792}
SUDO=${SUDO-sudo}
SMOKE_TIMEOUT_SECONDS=${SMOKE_TIMEOUT_SECONDS:-30}

cd "$APP_DIR"
export WEB_RELEASES_ROOT="$RELEASES_ROOT"

echo "== 1/5 更新工作区（不触碰当前发布目录）"
git pull --ff-only
bun install --frozen-lockfile

echo "== 2/5 候选构建 + 全资产校验 + 追加资源 + 切指针"
bun run build:web:release -- --root "$RELEASES_ROOT"

echo "== 3/5 重启 $SERVICE（允许 1–2 秒中断；SSE 会断开重连）"
$SUDO systemctl restart "$SERVICE"

wait_health() {
  local deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "== 4/5 /health 就绪探测"
if wait_health; then
  echo "== 5/5 版本接口、HTML、全部资源与 /mcp 冒烟"
  if bun run web:release:smoke -- --root "$RELEASES_ROOT" --base "$BASE_URL"; then
    echo "发布成功。"
    exit 0
  fi
else
  echo "服务未在 ${SMOKE_TIMEOUT_SECONDS}s 内通过 /health。"
fi

echo "!! 冒烟失败：回滚到上一个不同 build（资源不删除）"
bun run web:release:rollback -- --root "$RELEASES_ROOT" --to previous
$SUDO systemctl restart "$SERVICE"
if wait_health && bun run web:release:smoke -- --root "$RELEASES_ROOT" --base "$BASE_URL"; then
  echo "已回滚并复测通过；失败发布资源仍保留。"
else
  echo "回滚后复测仍失败，需要人工介入：$RELEASES_ROOT"
fi
exit 1
