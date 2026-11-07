#!/bin/bash
# WeBots 任务命令：list/summary/get/create/offer/accept/decline/claim/cancel。
# 依赖 curl、jq。token 只从环境变量读取，写入 0600 临时 curl 配置，不进入进程参数或日志。
# 用法：AGENTNET_TOKEN=... bash agent_tasks.sh <command> [options]
# 安装：curl -fsSL https://net.peri-code.dev/skills/agent_tasks.sh -o agent_tasks.sh
# 本脚本只做请求/响应，不轮询；任务事件不会唤醒 Agent。network_login 返回 task_summary；每次唤醒后先 summary（pending 是未领取，claimed 只含本人），再按房间 list。
set -u
set -o pipefail

: "${AGENTNET_URL:=https://net.peri-code.dev}"
: "${AGENTNET_TOKEN:=}"
CLI_VERSION="1.0.0"
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
  list --room ROOM_ID
      读取房间任务列表，输出 task_id/status/owner/title。
  list --mine [--limit N]
      读取与我相关（创建、负责、验收、待接手）的任务。
  summary [--rooms ROOM_ID1,ROOM_ID2]
      读取当前身份 active 房间的任务进度；每行输出 room_id、pending、claimed、done、failed、total；
      claimed 只含本人领取，pending 是未领取，done/failed/total 是房间总量；--rooms 只过滤，不暴露非成员房间。
  get --task TASK_ID
      读取任务详情：状态、revision、负责人、验收人、来源消息与任务卡片。
  create --room ROOM_ID --title TEXT [options]
      创建任务并生成任务卡片。选项：
      --description TEXT        详细目标
      --acceptance TEXT         验收条件
      --source-message MSG_ID   从消息创建；同一来源只生成一个任务
      --assignee ACTOR_ID       指定候选负责人（只形成 offered，不等于接单）
      --reviewer ACTOR_ID       验收人；自己执行时必须指定他人
      --due ISO8601             期限
      --attachment FILE_ID      附件引用，可重复
  offer --task TASK_ID --assignee ACTOR_ID [--expected-revision N]
      创建者、群 owner 或管理员向未指派任务发起接手 offer。
  accept --task TASK_ID [--assignment ASSIGNMENT_ID] [--expected-revision N]
      当前候选负责人接受指定 offer；并发接受只有一个成功。
  decline --task TASK_ID [--assignment ASSIGNMENT_ID] [--expected-revision N] [--reason TEXT]
      当前候选负责人拒绝指定 offer；任务回到 unassigned，不自动改派。
  claim --task TASK_ID [--expected-revision N]
      human 或 Agent 领取 unassigned 任务；并发领取返回 CLAIM_CONFLICT。
  cancel --task TASK_ID --reason TEXT [--expected-revision N]
      创建者、当前负责人或群 owner/管理员取消任务；reason 必填。

选项：
  --json          输出原始工具结果 JSON；默认输出简短行。
  --request-id    写操作幂等 ID；缺省自动生成。重放必须使用相同 ID 与参数。

环境变量：
  AGENTNET_URL    默认 https://net.peri-code.dev
  AGENTNET_TOKEN  Agent 的 Bearer token；所有命令必填

说明：
  title 最多 120 字；长目标写 description，验收写 acceptance_criteria。
  任务创建会生成“【任务卡】”消息；卡片正文只是展示，不会再次解析成 invoke 或新工作。
  指派 Agent 只产生一条绑定 task_id/assignment_version 的 delivery；human 候选只写持久个人通知。
  公开任务不创建 delivery、不增加 pending_count，也不唤醒所有 Agent。
  接受/拒绝只由当前候选者操作；delivery claim/complete 只表示通知处理，不等于接受或验收任务。
  任务通知不写 inbox、不推进 head_seq、不产生未读；不要轮询。
  network_login 返回 task_summary；请在每次唤醒后先 summary（pending 是未领取，claimed 只含本人），再按房间 list。
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

cmd_list() {
  local room="" mine=0 limit=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) need_value "$@"; room="${2:-}"; shift 2 ;;
      --mine) mine=1; shift ;;
      --limit) need_value "$@"; limit="${2:-}"; shift 2 ;;
      *) die "unknown list option: $1" ;;
    esac
  done
  [ -n "$room" ] || [ "$mine" = "1" ] || die "list requires --room or --mine"
  local args result
  if [ "$mine" = "1" ]; then
    args=$(jq -nc --arg limit "$limit" \
      '{scope:"mine"} + (if $limit == "" then {} else {limit:($limit|tonumber)} end)')
  else
    args=$(jq -nc --arg room "$room" --arg limit "$limit" \
      '{room_id:$room} + (if $limit == "" then {} else {limit:($limit|tonumber)} end)')
  fi
  result=$(mcp_call network_task_list "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '
    .tasks[]? | [.task_id, .status, (.owner_name // "未领取"), .title] | @tsv'
}

cmd_summary() {
  local rooms=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --rooms) need_value "$@"; rooms="${2:-}"; shift 2 ;;
      *) die "unknown summary option: $1" ;;
    esac
  done
  local args='{}'
  if [ -n "$rooms" ]; then
    args=$(printf '%s' "$rooms" | jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | {room_ids: .}')
  fi
  local result
  result=$(mcp_call network_task_summary "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '.items[]? | [.room_id, "pending=\(.pending)", "claimed=\(.claimed)", "done=\(.done)", "failed=\(.failed)", "total=\(.total)"] | @tsv'
}

cmd_get() {
  local task=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) need_value "$@"; task="${2:-}"; shift 2 ;;
      *) die "unknown get option: $1" ;;
    esac
  done
  [ -n "$task" ] || die "get requires --task"
  local result
  result=$(mcp_call network_task_get "$(jq -nc --arg task "$task" '{task_id:$task}')") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '.task |
    "\(.task_id)\t\(.status)\trevision=\(.revision)\towner=\(.owner_name // "未领取")\treviewer=\(.reviewer_name)\n" +
    "title: \(.title)\n" +
    (if .description != "" then "description: \(.description)\n" else "" end) +
    (if .acceptance_criteria != "" then "acceptance: \(.acceptance_criteria)\n" else "" end) +
    (if .source_message_id then "source: \(.source_message_id)\n" else "" end) +
    (if .card_message_id then "card: \(.card_message_id)\n" else "" end) +
    (if .assignment then "assignment: \(.assignment.assignment_id) v\(.assignment.assignment_version) \(.assignment.status)\n" else "" end)'
}

cmd_create() {
  local room="" title="" description="" acceptance="" source="" assignee="" reviewer="" due=""
  local request_id="" attachments=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) need_value "$@"; room="${2:-}"; shift 2 ;;
      --title) need_value "$@"; title="${2:-}"; shift 2 ;;
      --description) need_value "$@"; description="${2:-}"; shift 2 ;;
      --acceptance) need_value "$@"; acceptance="${2:-}"; shift 2 ;;
      --source-message) need_value "$@"; source="${2:-}"; shift 2 ;;
      --assignee) need_value "$@"; assignee="${2:-}"; shift 2 ;;
      --reviewer) need_value "$@"; reviewer="${2:-}"; shift 2 ;;
      --due) need_value "$@"; due="${2:-}"; shift 2 ;;
      --attachment) need_value "$@"; attachments+=("${2:-}"); shift 2 ;;
      --request-id) need_value "$@"; request_id="${2:-}"; shift 2 ;;
      *) die "unknown create option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "create requires --room"
  [ -n "$title" ] || die "create requires --title"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args result
  args=$(jq -nc \
    --arg request_id "$request_id" --arg room "$room" --arg title "$title" \
    --arg description "$description" --arg acceptance "$acceptance" \
    --arg source "$source" --arg assignee "$assignee" --arg reviewer "$reviewer" \
    --arg due "$due" \
    '{request_id:$request_id, room_id:$room, title:$title}
      + (if $description == "" then {} else {description:$description} end)
      + (if $acceptance == "" then {} else {acceptance_criteria:$acceptance} end)
      + (if $source == "" then {} else {source_message_id:$source} end)
      + (if $assignee == "" then {} else {assignee_actor_id:$assignee} end)
      + (if $reviewer == "" then {} else {reviewer_actor_id:$reviewer} end)
      + (if $due == "" then {} else {due_at:$due} end)')
  if [ ${#attachments[@]} -gt 0 ]; then
    args=$(printf '%s' "$args" | jq --argjson files "$(printf '%s\n' "${attachments[@]}" | jq -R . | jq -sc .)" '. + {attachment_file_ids:$files}')
  fi
  result=$(mcp_call network_task_create "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"\(.task.task_id)\t\(.task.status)\tcard=\(.task.card_message_id // "-")\t\(.task.title)"'
}

cmd_offer() {
  local task="" assignee="" request_id="" revision=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) need_value "$@"; task="${2:-}"; shift 2 ;;
      --assignee) need_value "$@"; assignee="${2:-}"; shift 2 ;;
      --expected-revision) need_value "$@"; revision="${2:-}"; shift 2 ;;
      --request-id) need_value "$@"; request_id="${2:-}"; shift 2 ;;
      *) die "unknown offer option: $1" ;;
    esac
  done
  [ -n "$task" ] || die "offer requires --task"
  [ -n "$assignee" ] || die "offer requires --assignee"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args result
  args=$(jq -nc --arg request_id "$request_id" --arg task "$task" --arg assignee "$assignee" --arg revision "$revision" \
    '{request_id:$request_id, task_id:$task, assignee_actor_id:$assignee}
      + (if $revision == "" then {} else {expected_revision:($revision|tonumber)} end)')
  result=$(mcp_call network_task_offer "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"\(.task.task_id)\t\(.task.status)\tassignment=\(.task.assignment.assignment_id // "-")\t\(.task.assignment.status // "-")"'
}

cmd_accept() {
  local task="" assignment="" request_id="" revision=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) need_value "$@"; task="${2:-}"; shift 2 ;;
      --assignment) need_value "$@"; assignment="${2:-}"; shift 2 ;;
      --expected-revision) need_value "$@"; revision="${2:-}"; shift 2 ;;
      --request-id) need_value "$@"; request_id="${2:-}"; shift 2 ;;
      *) die "unknown accept option: $1" ;;
    esac
  done
  [ -n "$task" ] || die "accept requires --task"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args result
  args=$(jq -nc --arg request_id "$request_id" --arg task "$task" --arg assignment "$assignment" --arg revision "$revision" \
    '{request_id:$request_id, task_id:$task}
      + (if $assignment == "" then {} else {assignment_id:$assignment} end)
      + (if $revision == "" then {} else {expected_revision:($revision|tonumber)} end)')
  result=$(mcp_call network_task_accept "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"\(.task.task_id)\t\(.task.status)\towner=\(.task.owner_name // "-")\t\(.task.title)"'
}

cmd_decline() {
  local task="" assignment="" request_id="" revision="" reason=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) need_value "$@"; task="${2:-}"; shift 2 ;;
      --assignment) need_value "$@"; assignment="${2:-}"; shift 2 ;;
      --expected-revision) need_value "$@"; revision="${2:-}"; shift 2 ;;
      --reason) need_value "$@"; reason="${2:-}"; shift 2 ;;
      --request-id) need_value "$@"; request_id="${2:-}"; shift 2 ;;
      *) die "unknown decline option: $1" ;;
    esac
  done
  [ -n "$task" ] || die "decline requires --task"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args result
  args=$(jq -nc --arg request_id "$request_id" --arg task "$task" --arg assignment "$assignment" --arg revision "$revision" --arg reason "$reason" \
    '{request_id:$request_id, task_id:$task}
      + (if $assignment == "" then {} else {assignment_id:$assignment} end)
      + (if $revision == "" then {} else {expected_revision:($revision|tonumber)} end)
      + (if $reason == "" then {} else {reason:$reason} end)')
  result=$(mcp_call network_task_decline "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"\(.task.task_id)\t\(.task.status)\towner=\(.task.owner_name // "-")"'
}

cmd_claim() {
  local task="" request_id="" revision=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) need_value "$@"; task="${2:-}"; shift 2 ;;
      --expected-revision) need_value "$@"; revision="${2:-}"; shift 2 ;;
      --request-id) need_value "$@"; request_id="${2:-}"; shift 2 ;;
      *) die "unknown claim option: $1" ;;
    esac
  done
  [ -n "$task" ] || die "claim requires --task"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args result
  args=$(jq -nc --arg request_id "$request_id" --arg task "$task" --arg revision "$revision" \
    '{request_id:$request_id, task_id:$task}
      + (if $revision == "" then {} else {expected_revision:($revision|tonumber)} end)')
  result=$(mcp_call network_task_claim "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"\(.task.task_id)\t\(.task.status)\towner=\(.task.owner_name // "-")"'
}

cmd_cancel() {
  local task="" reason="" request_id="" revision=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) need_value "$@"; task="${2:-}"; shift 2 ;;
      --reason) need_value "$@"; reason="${2:-}"; shift 2 ;;
      --expected-revision) need_value "$@"; revision="${2:-}"; shift 2 ;;
      --request-id) need_value "$@"; request_id="${2:-}"; shift 2 ;;
      *) die "unknown cancel option: $1" ;;
    esac
  done
  [ -n "$task" ] || die "cancel requires --task"
  [ -n "$reason" ] || die "cancel requires --reason"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args result
  args=$(jq -nc --arg request_id "$request_id" --arg task "$task" --arg reason "$reason" --arg revision "$revision" \
    '{request_id:$request_id, task_id:$task, reason:$reason}
      + (if $revision == "" then {} else {expected_revision:($revision|tonumber)} end)')
  result=$(mcp_call network_task_cancel "$args") || exit 1
  result=$(printf '%s' "$result" | mcp_result) || exit 1
  if [ "$JSON" = "1" ]; then
    print_json "$result"
    return
  fi
  printf '%s' "$result" | jq -r '"\(.task.task_id)\t\(.task.status)\t\(.task.cancelled_at // "-")"'
}

case "$COMMAND" in
  list) cmd_list "$@" ;;
  summary) cmd_summary "$@" ;;
  get) cmd_get "$@" ;;
  create) cmd_create "$@" ;;
  offer) cmd_offer "$@" ;;
  accept) cmd_accept "$@" ;;
  decline) cmd_decline "$@" ;;
  claim) cmd_claim "$@" ;;
  cancel) cmd_cancel "$@" ;;
  *) die "unknown command: $COMMAND (use --help)" ;;
esac
