#!/usr/bin/env bash
# 部署脚本回归：用假 git/bun/systemctl/curl 在 /tmp 驱动真实脚本。
#
# 不触碰真实 systemd、生产目录或网络。覆盖：
# - 四种 locale 下脚本不崩溃；
# - restart 失败 / /health 超时 / 冒烟失败 → 回滚、重启、复测、非零退出；
# - 未迁移的旧 dist（manifest 存在、legacy.json 缺失）→ 切 current 前拒绝；
# - 正常路径 → 切 current、重启、冒烟、退出 0。

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/scripts/deploy-web-release.sh"
OLD_BUILD=$(printf 'a%.0s' {1..64})
NEW_BUILD=$(printf 'b%.0s' {1..64})
FAILURES=0

pass() {
  printf '  ✓ %s\n' "$*"
}

fail() {
  printf '  ✗ %s\n' "$*" >&2
  FAILURES=$((FAILURES + 1))
}

assert_status() {
  local expected=$1
  local actual=$2
  local label=$3
  if [ "$actual" -eq "$expected" ]; then
    pass "${label}（退出码 ${actual}）"
  else
    fail "${label}：期望退出码 ${expected}，实际 $actual"
  fi
}

assert_contains() {
  local file=$1
  local needle=$2
  local label=$3
  if grep -Fq -- "$needle" "$file"; then
    pass "$label"
  else
    fail "${label}：未找到「${needle}」"
  fi
}

assert_not_contains() {
  local file=$1
  local needle=$2
  local label=$3
  if grep -Fq -- "$needle" "$file"; then
    fail "${label}：不应出现「${needle}」"
  else
    pass "$label"
  fi
}

assert_file_exists() {
  local path=$1
  local label=$2
  if [ -e "$path" ]; then
    pass "$label"
  else
    fail "${label}：$path 不存在"
  fi
}

assert_file_missing() {
  local path=$1
  local label=$2
  if [ -e "$path" ]; then
    fail "${label}：$path 仍存在"
  else
    pass "$label"
  fi
}

current_target() {
  if [ -L "$RELEASES_ROOT/current" ]; then
    readlink "$RELEASES_ROOT/current"
  elif [ -f "$RELEASES_ROOT/current" ]; then
    tr -d '[:space:]' <"$RELEASES_ROOT/current"
  else
    printf ''
  fi
}

write_fakes() {
  mkdir -p "$FAKE_BIN" "$FAKE_STATE"
  cat >"$FAKE_BIN/git" <<'FAKE'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"$FAKE_STATE/git.log"
exit 0
FAKE
  cat >"$FAKE_BIN/bun" <<'FAKE'
#!/usr/bin/env bash
set -u
printf 'bun %s\n' "$*" >>"$FAKE_STATE/bun.log"
if [ "${1:-}" = "install" ]; then
  exit "${FAKE_INSTALL_EXIT:-0}"
fi
if [ "${1:-}" != "run" ]; then
  exit 0
fi
case "${2:-}" in
  build:web:release)
    if [ "${FAKE_BUILD_EXIT:-0}" != "0" ]; then
      exit "${FAKE_BUILD_EXIT}"
    fi
    mkdir -p "$WEB_RELEASES_ROOT/releases/$FAKE_NEW_BUILD" "$WEB_RELEASES_ROOT/releases/$FAKE_OLD_BUILD"
    ln -sfn "releases/$FAKE_NEW_BUILD" "$WEB_RELEASES_ROOT/current"
    printf 'switched to %s\n' "$FAKE_NEW_BUILD" >>"$FAKE_STATE/bun.log"
    ;;
  web:release:rollback)
    ln -sfn "releases/$FAKE_OLD_BUILD" "$WEB_RELEASES_ROOT/current"
    : >"$FAKE_STATE/health_ok"
    printf 'rollback to %s\n' "$FAKE_OLD_BUILD" >>"$FAKE_STATE/bun.log"
    ;;
  web:release:smoke)
    if [ "${FAKE_SMOKE_MODE:-ok}" = "fail-once" ] && [ ! -f "$FAKE_STATE/smoke_failed" ]; then
      : >"$FAKE_STATE/smoke_failed"
      exit 1
    fi
    if [ "${FAKE_SMOKE_MODE:-ok}" = "fail" ]; then
      exit 1
    fi
    printf 'smoke ok\n' >>"$FAKE_STATE/bun.log"
    ;;
esac
exit 0
FAKE
  cat >"$FAKE_BIN/systemctl" <<'FAKE'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$FAKE_STATE/systemctl.log"
if [ "${1:-}" = "restart" ]; then
  count=0
  if [ -f "$FAKE_STATE/restart_count" ]; then
    count=$(cat "$FAKE_STATE/restart_count")
  fi
  count=$((count + 1))
  printf '%s\n' "$count" >"$FAKE_STATE/restart_count"
  if [ "${FAKE_FIRST_RESTART_EXIT:-0}" != "0" ] && [ "$count" -eq 1 ]; then
    exit "$FAKE_FIRST_RESTART_EXIT"
  fi
fi
exit 0
FAKE
  cat >"$FAKE_BIN/curl" <<'FAKE'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$FAKE_STATE/curl.log"
case "$*" in
  *"/health")
    if [ "${FAKE_HEALTH_MODE:-ok}" = "fail" ]; then
      exit 7
    fi
    if [ "${FAKE_HEALTH_MODE:-ok}" = "fail-before-rollback" ] && [ ! -f "$FAKE_STATE/health_ok" ]; then
      exit 7
    fi
    exit 0
    ;;
  *"/assets/"*)
    exit "${FAKE_ALIAS_EXIT:-0}"
    ;;
esac
exit 0
FAKE
  chmod +x "$FAKE_BIN/git" "$FAKE_BIN/bun" "$FAKE_BIN/systemctl" "$FAKE_BIN/curl"
}

setup_case() {
  CASE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentnet-deploy-test-XXXXXX")
  APP_DIR="$CASE_DIR/app"
  RELEASES_ROOT="$CASE_DIR/releases"
  FAKE_STATE="$CASE_DIR/state"
  FAKE_BIN="$CASE_DIR/bin"
  mkdir -p "$APP_DIR" "$RELEASES_ROOT/releases/$OLD_BUILD" "$RELEASES_ROOT/releases/$NEW_BUILD"
  printf '{"schemaVersion":1}\n' >"$RELEASES_ROOT/legacy.json"
  ln -sfn "releases/$OLD_BUILD" "$RELEASES_ROOT/current"
  write_fakes
}

cleanup_case() {
  rm -rf "$CASE_DIR"
}

run_deploy() {
  local locale=${1:-}
  if [ -n "$locale" ]; then
    ( cd "$REPO_ROOT" && env \
      PATH="$FAKE_BIN:$PATH" \
      LANG="$locale" LC_ALL="$locale" \
      APP_DIR="$APP_DIR" \
      RELEASES_ROOT="$RELEASES_ROOT" \
      SERVICE=agent-network \
      BASE_URL=http://127.0.0.1:18792 \
      SUDO= \
      SMOKE_TIMEOUT_SECONDS=1 \
      FAKE_STATE="$FAKE_STATE" \
      FAKE_OLD_BUILD="$OLD_BUILD" \
      FAKE_NEW_BUILD="$NEW_BUILD" \
      FAKE_FIRST_RESTART_EXIT="${FAKE_FIRST_RESTART_EXIT:-0}" \
      FAKE_HEALTH_MODE="${FAKE_HEALTH_MODE:-ok}" \
      FAKE_SMOKE_MODE="${FAKE_SMOKE_MODE:-ok}" \
      bash "$SCRIPT" )
  else
    ( cd "$REPO_ROOT" && env \
      PATH="$FAKE_BIN:$PATH" \
      APP_DIR="$APP_DIR" \
      RELEASES_ROOT="$RELEASES_ROOT" \
      SERVICE=agent-network \
      BASE_URL=http://127.0.0.1:18792 \
      SUDO= \
      SMOKE_TIMEOUT_SECONDS=1 \
      FAKE_STATE="$FAKE_STATE" \
      FAKE_OLD_BUILD="$OLD_BUILD" \
      FAKE_NEW_BUILD="$NEW_BUILD" \
      FAKE_FIRST_RESTART_EXIT="${FAKE_FIRST_RESTART_EXIT:-0}" \
      FAKE_HEALTH_MODE="${FAKE_HEALTH_MODE:-ok}" \
      FAKE_SMOKE_MODE="${FAKE_SMOKE_MODE:-ok}" \
      bash "$SCRIPT" )
  fi
}

# 1. 四种 locale：正常路径不崩溃（原缺陷是全角括号被并入变量名）。
for locale in C en_US.UTF-8 zh_CN.UTF-8 C.UTF-8; do
  echo "locale: $locale"
  setup_case
  set +e
  output=$(run_deploy "$locale" 2>&1)
  status=$?
  set -e
  assert_status 0 "$status" "脚本不崩溃"
  if printf '%s' "$output" | grep -Fq "重启 agent-network（"; then
    pass "含全角括号的重启日志完整"
  else
    fail "重启日志缺失或变量名被污染"
    printf '%s\n' "$output" >&2
  fi
  assert_contains "$FAKE_STATE/systemctl.log" "restart agent-network" "执行 restart"
  assert_contains "$FAKE_STATE/curl.log" "--connect-timeout 2 --max-time 5" "health curl 有连接/总超时"
  assert_contains "$FAKE_STATE/bun.log" "smoke ok" "正常路径冒烟通过"
  assert_contains "$FAKE_STATE/bun.log" "switched to $NEW_BUILD" "current 已切换"
  if [ "$(current_target)" = "releases/$NEW_BUILD" ]; then
    pass "current 指向新 build"
  else
    fail "current 指向 $(current_target)，期望 releases/$NEW_BUILD"
  fi
  cleanup_case
done

# 2. systemctl restart 非零 → 回滚 + 再次重启 + 非零退出。
echo "case: restart 失败"
setup_case
FAKE_FIRST_RESTART_EXIT=1
set +e
output=$(run_deploy 2>&1)
status=$?
set -e
unset FAKE_FIRST_RESTART_EXIT
assert_status 1 "$status" "restart 失败后退出非零"
assert_contains "$FAKE_STATE/bun.log" "rollback to $OLD_BUILD" "调用回滚"
assert_contains "$FAKE_STATE/systemctl.log" "restart agent-network" "回滚后再次重启"
if [ "$(grep -c 'restart agent-network' "$FAKE_STATE/systemctl.log")" -ge 2 ]; then
  pass "共执行两次 restart"
else
  fail "restart 次数不足"
fi
assert_contains "$FAKE_STATE/bun.log" "smoke ok" "回滚复测冒烟通过"
if [ "$(current_target)" = "releases/$OLD_BUILD" ]; then
  pass "current 恢复旧 build"
else
  fail "current 未恢复：$(current_target)"
fi
cleanup_case

# 3. /health 超时 → 回滚 + 重启 + 复测（回滚后健康检查放行）+ 非零退出。
echo "case: /health 超时"
setup_case
FAKE_HEALTH_MODE=fail-before-rollback
set +e
output=$(run_deploy 2>&1)
status=$?
set -e
unset FAKE_HEALTH_MODE
assert_status 1 "$status" "health 超时后退出非零"
assert_contains "$FAKE_STATE/bun.log" "rollback to $OLD_BUILD" "health 超时触发回滚"
assert_contains "$FAKE_STATE/bun.log" "smoke ok" "回滚后复测通过"
if printf '%s' "$output" | grep -Fq "服务未在 1s 内通过 /health"; then
  pass "报告 health 超时"
else
  fail "未报告 health 超时"
  printf '%s\n' "$output" >&2
fi
cleanup_case

# 4. 冒烟失败 → 回滚 + 再次冒烟通过 + 非零退出。
echo "case: 冒烟失败"
setup_case
FAKE_SMOKE_MODE=fail-once
set +e
output=$(run_deploy 2>&1)
status=$?
set -e
unset FAKE_SMOKE_MODE
assert_status 1 "$status" "冒烟失败后退出非零"
assert_contains "$FAKE_STATE/bun.log" "rollback to $OLD_BUILD" "冒烟失败触发回滚"
assert_contains "$FAKE_STATE/bun.log" "smoke ok" "回滚后冒烟通过"
cleanup_case

# 5. 未迁移：旧 dist manifest 存在、legacy.json 缺失 → 切换前拒绝。
echo "case: 首次迁移前置"
setup_case
rm -f "$RELEASES_ROOT/legacy.json"
mkdir -p "$APP_DIR/dist/web/.vite"
printf '{}\n' >"$APP_DIR/dist/web/.vite/manifest.json"
set +e
output=$(run_deploy 2>&1)
status=$?
set -e
assert_status 1 "$status" "未迁移时拒绝发布"
if printf '%s' "$output" | grep -Fq "web:release:migrate"; then
  pass "提示先运行迁移"
else
  fail "未提示迁移命令"
  printf '%s\n' "$output" >&2
fi
assert_not_contains "$FAKE_STATE/bun.log" "build:web:release" "未执行候选构建"
assert_file_missing "$FAKE_STATE/systemctl.log" "未重启服务"
if [ "$(current_target)" = "releases/$OLD_BUILD" ]; then
  pass "current 未被切换"
else
  fail "current 被改动：$(current_target)"
fi
cleanup_case

if [ "$FAILURES" -ne 0 ]; then
  printf '\n部署脚本回归失败：%s 项\n' "$FAILURES" >&2
  exit 1
fi
printf '\n部署脚本回归通过。\n'
