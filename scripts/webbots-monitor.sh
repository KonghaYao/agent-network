#!/bin/sh
# 由 Claude 原生 Monitor 承载；凭据只从该 Agent 自己的 env 文件读取。
# 宿主设置 alert 参数时用 '"alert":true|^ERROR '：CLI 每个 JSON 事件都带布尔 alert，
# 只有需要行动的事件（delivery/delivery_deferred/session.login/error 等）为 true。
#
# 用法：
#   AGENTNET_ENV_FILE=~/.agentnet/agents/<actor_id>.env \
#   AGENTNET_ACTOR=<actor_id> sh scripts/webbots-monitor.sh
# 或：
#   sh scripts/webbots-monitor.sh --env-file <path> --actor <actor_id>
set -eu

env_file="${AGENTNET_ENV_FILE:-}"
actor="${AGENTNET_ACTOR:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || { echo "ERROR credentials_required message=missing_env_file_value" >&2; exit 1; }
      env_file="$2"
      shift 2
      ;;
    --env-file=*)
      env_file="${1#--env-file=}"
      shift
      ;;
    --actor)
      [ "$#" -ge 2 ] || { echo "ERROR actor_required message=missing_actor_value" >&2; exit 1; }
      actor="$2"
      shift 2
      ;;
    --actor=*)
      actor="${1#--actor=}"
      shift
      ;;
    *)
      echo "ERROR invalid_argument message=unknown_argument value=$1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$env_file" ]; then
  echo "ERROR credentials_required message=set_AGENTNET_ENV_FILE_or_--env-file" >&2
  exit 1
fi
if [ -z "$actor" ]; then
  echo "ERROR actor_required message=set_AGENTNET_ACTOR_or_--actor" >&2
  exit 1
fi

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec bun client/cli.ts --env-file "$env_file" --expect-actor "$actor" \
  monitor --harness claude --json
