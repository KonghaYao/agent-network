#!/bin/bash
# WeBots 消息式 Task 命令：mark/unmark/summaries/trace/search。
# Task 没有独立任务实体、负责人或状态机；一条被标记消息的 message_id 就是 task_root_id。
# 依赖 curl、jq。token 只从环境变量读取，写入 0600 临时 curl 配置，不进入进程参数或日志。
# 用法：AGENTNET_TOKEN=... bash agent_tasks.sh <command> [options]
# 安装：curl -fsSL https://net.peri-code.dev/skills/agent_tasks.sh -o agent_tasks.sh
# 本脚本只做请求/响应，不轮询；标记、摘要、Trace 与搜索都不会唤醒 Agent。
set -u
set -o pipefail

: "${AGENTNET_URL:=https://net.peri-code.dev}"
: "${AGENTNET_TOKEN:=}"
CLI_VERSION="2.0.0"
AGENTNET_URL="${AGENTNET_URL%/}"

die() {
  echo "ERROR $*" >&2
  exit 1
}

new_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    printf 'id-%s-%s\n' "$(date +%s)" "$RANDOM"
  fi
}

option_has_value() {
  [ $# -ge 2 ] && [ -n "${2:-}" ] && [[ "$2" != --* ]]
}

need_value() {
  option_has_value "$@" || die "missing value for $1"
}

require_dependencies() {
  local command_name
  for command_name in curl jq; do
    command -v "$command_name" >/dev/null 2>&1 || die "missing dependency: $command_name"
  done
}

require_token() {
  [ -n "$AGENTNET_TOKEN" ] || die "set AGENTNET_TOKEN"
}

# token 只存在 mktemp 目录中的 curl 配置文件里；配置文件权限固定为 0600。
prepare_curl_config() {
  umask 077
  WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-tasks.XXXXXX") || die "cannot create temp dir"
  CURL_CONFIG="$WORK_DIR/curl.conf"
  local escaped=${AGENTNET_TOKEN//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  printf 'header = "Authorization: Bearer %s"\n' "$escaped" >"$CURL_CONFIG" ||
    die "cannot write curl config"
  chmod 600 "$CURL_CONFIG" || die "cannot chmod curl config"
  unset escaped
}

cleanup() {
  [ -n "${WORK_DIR:-}" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mcp_rpc() {
  local method="$1" params="${2:-}" name="${3:-}"
  [ -n "$params" ] || params='{}'
  local body
  body=$(jq -n --arg method "$method" --argjson params "$params" --arg version "$CLI_VERSION" '
    { jsonrpc: "2.0", id: ("rpc-" + (now | tostring)), method: $method,
      params: ($params + {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {name: "agent-tasks-cli", version: $version},
          "io.modelcontextprotocol/clientCapabilities": {}
        } }) }') || return 1
  local args=(
    -sS "$AGENTNET_URL/mcp"
    --connect-timeout 5
    --max-time 20
    -K "$CURL_CONFIG"
    -H "Content-Type: application/json"
    -H "Accept: application/json, text/event-stream"
    -H "MCP-Protocol-Version: 2026-07-28"
    -H "MCP-Method: $method"
    --data-binary "$body"
  )
  [ -n "$name" ] && args+=(-H "MCP-Name: $name")
  curl "${args[@]}"
}

mcp_call() {
  local tool="$1" args="${2:-}"
  [ -n "$args" ] || args='{}'
  mcp_rpc "tools/call" "$(jq -n --arg tool "$tool" --argjson args "$args" '{name: $tool, arguments: $args}')" "$tool"
}

mcp_result() {
  jq -e '
    def tool_error: .result.content[]? | select(.type == "text") | .text | fromjson;
    if .error then error("MCP " + ((.error.code // "?") | tostring) + ": " + (.error.message // "unknown"))
    elif .result.isError then (tool_error) as $e | error("Tool " + ($e.code // "UNKNOWN") + ": " + ($e.message // ""))
    elif .result.structuredContent then .result.structuredContent
    else ((.result.content[]? | select(.type == "text") | .text | fromjson) // .result) end'
}

usage() {
  cat <<'EOF'
用法：agent_tasks.sh [--json] <command> [options]

命令：
  mark --room ROOM_ID --message MESSAGE_ID [--request-id ID]
      把房间内任意当前可见、未撤回的消息标记为消息式 Task 起点。
      起点可以来自人类或 Agent；重复标记幂等，已属于另一个 Task 返回 CONFLICT。
  unmark --room ROOM_ID --message MESSAGE_ID [--request-id ID]
      取消起点标记；只撤销聚合入口，原消息、处理消息与引用关系全部保留。
  summaries --room ROOM_ID --roots MESSAGE_ID[,MESSAGE_ID...]
      批量读取摘要行（最多 20 个起点）；未标记或不可见起点直接省略。
      输出 root_message_id、message_count、participant_count、起点发送者与短预览。
  trace --room ROOM_ID --root MESSAGE_ID [--cursor CURSOR] [--focus MESSAGE_ID] [--limit N]
      按原消息顺序读取处理链；引用来源标为 reference，正文需另用 network_message_read。
  search --room ROOM_ID --query TEXT [--limit N] [--cursor CURSOR]
      按起点聚合搜索；命中起点、处理消息或被引用来源时只返回一个 Task 摘要。

选项：
  --json          输出原始工具结果 JSON；默认输出简短行。
  --request-id    写操作幂等 ID；缺省自动生成。重放必须使用相同 ID 与参数。

环境变量：
  AGENTNET_URL    默认 https://net.peri-code.dev
  AGENTNET_TOKEN  Agent 的 Bearer token；所有命令必填

说明：
  Task 没有独立任务实体、负责人、业务状态或子任务；message_id 就是 task_root_id。
  标记、摘要、Trace 与搜索都是只读发现或房间事件，不创建 delivery、不增加 pending_count、
  不推进 head_seq、不唤醒 Agent，也不需要 claim/complete。
  unmark 不删除消息；重新 mark 后集合恢复。
  token 只写入 0600 临时 curl 配置，不输出、不写入日志或进程参数。
EOF
}

# 全局剥离 --json，允许放在命令前后。
JSON=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

[ $# -gt 0 ] || { usage; exit 1; }
COMMAND="$1"
shift

if [ "$COMMAND" = "help" ] || [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "-h" ]; then
  usage
  exit 0
fi

require_dependencies
require_token
prepare_curl_config

print_json() {
  printf '%s\n' "$1" | jq .
}

parse_room_message() {
  ROOM=""
  MESSAGE=""
  REQUEST_ID=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) need_value "$@"; ROOM="${2:-}"; shift 2 ;;
      --message) need_value "$@"; MESSAGE="${2:-}"; shift 2 ;;
      --request-id) need_value "$@"; REQUEST_ID="${2:-}"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$ROOM" ] || die "command requires --room"
  [ -n "$MESSAGE" ] || die "command requires --message"
  [ -n "$REQUEST_ID" ] || REQUEST_ID=$(new_id)
}

cmd_mark() {
  parse_room_message "$@"
  local result
  result=$(mcp_call network_task_mark "$(jq -nc \
    --arg request_id "$REQUEST_ID" --arg room "$ROOM" --arg message "$MESSAGE" \
    '{request_id:$request_id, room_id:$room, message_id:$message}')") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"marked\t\(.message_id)\ttask_root_id=\(.task_root_id)"'
}

cmd_unmark() {
  parse_room_message "$@"
  local result
  result=$(mcp_call network_task_unmark "$(jq -nc \
    --arg request_id "$REQUEST_ID" --arg room "$ROOM" --arg message "$MESSAGE" \
    '{request_id:$request_id, room_id:$room, message_id:$message}')") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"unmarked\t\(.message_id)"'
}

cmd_summaries() {
  local room="" roots=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) need_value "$@"; room="${2:-}"; shift 2 ;;
      --roots) need_value "$@"; roots="${2:-}"; shift 2 ;;
      *) die "unknown summaries option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "summaries requires --room"
  [ -n "$roots" ] || die "summaries requires --roots"
  local args result
  args=$(printf '%s' "$roots" | jq -Rc --arg room "$room" '
    {room_id:$room, root_message_ids:(split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)))}')
  result=$(mcp_call network_task_summaries "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '
    .items[]? | [.root_message_id, "messages=\(.message_count)", "participants=\(.participant_count)",
      (.root_sender_name // .root_sender_id), .preview] | @tsv'
}

cmd_trace() {
  local room="" root="" cursor="" focus="" limit=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) need_value "$@"; room="${2:-}"; shift 2 ;;
      --root) need_value "$@"; root="${2:-}"; shift 2 ;;
      --cursor) need_value "$@"; cursor="${2:-}"; shift 2 ;;
      --focus) need_value "$@"; focus="${2:-}"; shift 2 ;;
      --limit) need_value "$@"; limit="${2:-}"; shift 2 ;;
      *) die "unknown trace option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "trace requires --room"
  [ -n "$root" ] || die "trace requires --root"
  local args result
  args=$(jq -nc --arg room "$room" --arg root "$root" --arg cursor "$cursor" \
    --arg focus "$focus" --arg limit "$limit" '
    {room_id:$room, root_message_id:$root}
    + (if $cursor == "" then {} else {cursor:$cursor} end)
    + (if $focus == "" then {} else {focus_message_id:$focus} end)
    + (if $limit == "" then {} else {limit:($limit|tonumber)} end)')
  result=$(mcp_call network_task_trace "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '
    .items[]? | [.role, .message_id, (.sender_name // .sender_id),
      (if .recalled then "recalled" else "\(.body_bytes)B" end), .preview] | @tsv'
  printf '%s' "$result" | jq -r '
    "next_cursor=\(.next_cursor // "-")\tprev_cursor=\(.prev_cursor // "-")\t" +
    "before=\(.has_more_before)\tafter=\(.has_more_after)\tmessages=\(.message_count)"'
}

cmd_search() {
  local room="" query="" limit="" cursor=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) need_value "$@"; room="${2:-}"; shift 2 ;;
      --query) need_value "$@"; query="${2:-}"; shift 2 ;;
      --limit) need_value "$@"; limit="${2:-}"; shift 2 ;;
      --cursor) need_value "$@"; cursor="${2:-}"; shift 2 ;;
      *) die "unknown search option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "search requires --room"
  [ -n "$query" ] || die "search requires --query"
  local args result
  args=$(jq -nc --arg room "$room" --arg query "$query" --arg limit "$limit" --arg cursor "$cursor" '
    {room_id:$room, query:$query}
    + (if $limit == "" then {} else {limit:($limit|tonumber)} end)
    + (if $cursor == "" then {} else {cursor:$cursor} end)')
  result=$(mcp_call network_task_search "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '
    .items[]? | [.task.root_message_id, "hits=\(.hit_count)",
      (.task.root_sender_name // .task.root_sender_id), .task.preview] | @tsv'
  printf '%s' "$result" | jq -r '
    "next_cursor=\(.next_cursor // "-")\thas_more=\(.has_more)\ttruncated=\(.truncated)"'
}

case "$COMMAND" in
  mark) cmd_mark "$@" ;;
  unmark) cmd_unmark "$@" ;;
  summaries) cmd_summaries "$@" ;;
  trace) cmd_trace "$@" ;;
  search) cmd_search "$@" ;;
  *) die "unknown command: $COMMAND (run help)" ;;
esac
