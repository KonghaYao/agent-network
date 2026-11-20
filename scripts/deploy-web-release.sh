#!/usr/bin/env bash
# 单实例发布：候选构建 → 校验/落盘 → 切指针 → 重启 → 冒烟；失败回滚。
#
# 前置条件：
# - systemd unit 设置 WorkingDirectory=/opt/agent-network 与
#   Environment=WEB_RELEASES_ROOT=/opt/agent-network-releases；
# - 数据目录、PUBLIC_ORIGIN 等原有配置不变；
# - 首次从旧 dist/web 切换到发布模型前，必须先运行 web:release:migrate；
# - 本脚本不执行 db:migrate，也不跑生产测试。
#
# 用法（在服务器上）：
#   sudo bash scripts/deploy-web-release.sh
# 可用环境变量覆盖：
#   APP_DIR RELEASES_ROOT SERVICE BASE_URL SUDO SMOKE_TIMEOUT_SECONDS
#   HEALTH_CONNECT_TIMEOUT_SECONDS HEALTH_MAX_TIME_SECONDS
#
# 失败处理：current 指针切换成功后的任何失败（restart、/health、冒烟、
# 固定别名）都会回滚到上一个不同 build，再次重启并复测，最后以非零退出。
# 脚本不依赖 `set -e` 直接退出；EXIT trap 只作为遗漏分支的兜底。

set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/agent-network}
RELEASES_ROOT=${RELEASES_ROOT:-/opt/agent-network-releases}
SERVICE=${SERVICE:-agent-network}
BASE_URL=${BASE_URL:-http://127.0.0.1:8792}
SUDO=${SUDO-sudo}
SMOKE_TIMEOUT_SECONDS=${SMOKE_TIMEOUT_SECONDS:-30}
HEALTH_CONNECT_TIMEOUT_SECONDS=${HEALTH_CONNECT_TIMEOUT_SECONDS:-2}
HEALTH_MAX_TIME_SECONDS=${HEALTH_MAX_TIME_SECONDS:-5}

CURRENT_SWITCHED=0
ROLLBACK_DONE=0

log() {
  printf '%s\n' "$*"
}

# 读取 current 指针目标；symlink 与纯文本回退都支持。用于确认本次发布是否
# 真的切换了指针，避免把“构建失败但未切流”误判成需要回滚。
current_target() {
  local current="$RELEASES_ROOT/current"
  if [ -L "$current" ]; then
    readlink "$current"
  elif [ -f "$current" ]; then
    tr -d '[:space:]' <"$current"
  else
    printf ''
  fi
}

wait_health() {
  local deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    if curl -fsS \
      --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$HEALTH_MAX_TIME_SECONDS" \
      "${BASE_URL%/}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

run_smoke() {
  local -a arguments=(--root "$RELEASES_ROOT" --base "$BASE_URL")
  if [ ! -f "$RELEASES_ROOT/legacy.json" ]; then
    # 全新安装没有旧 dist，也没有需要冻结的别名；其余情况 smoke 默认要求
    # 固定别名可读，避免“旧页面模块 404 仍判定成功”。
    arguments+=(--allow-missing-legacy)
  fi
  bun run web:release:smoke -- "${arguments[@]}"
}

# 一键部署额外显式检查固定别名可读；smoke 内部也会按 legacy.json 校验摘要。
check_legacy_aliases() {
  if [ ! -f "$RELEASES_ROOT/legacy.json" ]; then
    log "未冻结固定别名（全新安装），跳过别名可读性检查。"
    return 0
  fi
  local name
  for name in chat-markdown.js chat-drawboard.js; do
    if ! curl -fsS \
      --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$HEALTH_MAX_TIME_SECONDS" \
      -o /dev/null "${BASE_URL%/}/assets/$name"; then
      log "!! 固定别名不可读: ${BASE_URL%/}/assets/$name"
      return 1
    fi
  done
  log "固定别名可读。"
  return 0
}

# 回滚 → 重启 → /health → 冒烟 → 别名。函数内部不再依赖 set -e。
rollback_and_verify() {
  ROLLBACK_DONE=1
  log "!! 回滚到上一个不同 build（资源不删除）"
  if ! bun run web:release:rollback -- --root "$RELEASES_ROOT" --to previous; then
    log "!! 回滚指针切换失败，需要人工介入: $RELEASES_ROOT"
    return 1
  fi
  if ! $SUDO systemctl restart "$SERVICE"; then
    log "!! 回滚后重启 ${SERVICE} 失败，需要人工介入"
    return 1
  fi
  if ! wait_health; then
    log "!! 回滚后服务未在 ${SMOKE_TIMEOUT_SECONDS}s 内通过 /health，需要人工介入"
    return 1
  fi
  if ! run_smoke; then
    log "!! 回滚后冒烟失败，需要人工介入: $RELEASES_ROOT"
    return 1
  fi
  if ! check_legacy_aliases; then
    log "!! 回滚后固定别名不可读，需要人工介入"
    return 1
  fi
  log "已回滚并复测通过；失败发布资源仍保留。"
  return 0
}

fail_after_switch() {
  local reason=$1
  log "!! ${reason}"
  if [ "$CURRENT_SWITCHED" -eq 1 ] && [ "$ROLLBACK_DONE" -eq 0 ]; then
    rollback_and_verify || true
  fi
  exit 1
}

on_exit() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$CURRENT_SWITCHED" -eq 1 ] && [ "$ROLLBACK_DONE" -eq 0 ]; then
    rollback_and_verify || true
  fi
  exit "$status"
}
trap on_exit EXIT

cd "$APP_DIR"
export WEB_RELEASES_ROOT="$RELEASES_ROOT"

log "== 1/5 更新工作区（不触碰当前发布目录）"
if ! git pull --ff-only; then
  log "!! git pull --ff-only 失败，未切换 current。"
  exit 1
fi
if ! bun install --frozen-lockfile; then
  log "!! bun install 失败，未切换 current。"
  exit 1
fi

# 首次迁移前置：旧 dist/web 还在服务、发布根却缺少冻结别名时，绝不能切
# current，否则旧页面请求的 /assets/chat-*.js 会直接 404。
if [ -f "$APP_DIR/dist/web/.vite/manifest.json" ] && [ ! -f "$RELEASES_ROOT/legacy.json" ]; then
  log "!! 检测到旧 dist/web 但发布根尚未迁移（缺少 $RELEASES_ROOT/legacy.json）。"
  log "   请先运行首次迁移，再重新执行本脚本："
  log "   bun run web:release:migrate -- --root \"$RELEASES_ROOT\" --dist \"$APP_DIR/dist/web\" --base-url \"$BASE_URL\""
  exit 1
fi

previous_target=$(current_target)

log "== 2/5 候选构建 + 全资产校验 + 追加资源 + 切指针"
if ! bun run build:web:release -- --root "$RELEASES_ROOT"; then
  new_target=$(current_target)
  if [ -n "$new_target" ] && [ "$new_target" != "$previous_target" ]; then
    CURRENT_SWITCHED=1
  fi
  fail_after_switch "候选构建或发布失败；current 仍指向 ${previous_target:-（无）}"
fi
new_target=$(current_target)
# 构建命令成功即表示 publishCandidate 已完成指针激活（即使内容相同、路径未变，
# 也产生新的 deployment 记录）。之后任何失败都必须回滚。
CURRENT_SWITCHED=1
log "current -> ${new_target:-（空）}"

log "== 3/5 重启 ${SERVICE}（允许 1–2 秒中断；SSE 会断开重连）"
if ! $SUDO systemctl restart "$SERVICE"; then
  fail_after_switch "systemctl restart ${SERVICE} 失败"
fi

log "== 4/5 /health 就绪探测（最多 ${SMOKE_TIMEOUT_SECONDS}s）"
if ! wait_health; then
  fail_after_switch "服务未在 ${SMOKE_TIMEOUT_SECONDS}s 内通过 /health"
fi

log "== 5/5 版本接口、HTML、全部资源、固定别名与 /mcp 冒烟"
if ! run_smoke; then
  fail_after_switch "发布冒烟失败"
fi
if ! check_legacy_aliases; then
  fail_after_switch "固定别名检查失败"
fi

log "发布成功。"
exit 0
