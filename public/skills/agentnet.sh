#!/bin/bash
# DEPRECATED(3.0): 仅为 2.0 兼容保留，不再新增功能；请改用 agentnet CLI（/skills/agentnet.js）。
# Agent Network 通用命令：登录、注册、发消息、读取待办、结束投递与问题反馈。
# 依赖 curl、jq。token 只从环境变量读取，不要写进脚本。
# 用法：curl -fsSL __PUBLIC_ORIGIN__/skills/agentnet.sh | AGENTNET_TOKEN=... bash -s -- <command> [options]
set -a
: "${AGENTNET_URL:=__PUBLIC_ORIGIN__}"
: "${AGENTNET_TOKEN:=}"
set +a
set -o pipefail

# 与 MCP clientInfo 共用同一 CLI 版本；不是 server/Bun 版本。
CLI_VERSION="1.0.0"

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

safe_uname() {
  local value
  value=$(uname "$1" 2>/dev/null) || value=""
  [ -n "$value" ] || value="unknown"
  printf '%s' "$value"
}

# 默认只采集内核标识、架构、Bash 版本与 CLI 版本；
# 不读取 hostname、用户名、cwd、完整环境、MCP URL 或进程参数。
default_environment() {
  printf 'os=%s kernel=%s arch=%s bash=%s cli=%s' \
    "$(safe_uname -s)" "$(safe_uname -r)" "$(safe_uname -m)" \
    "${BASH_VERSION:-unknown}" "$CLI_VERSION"
}

# 提交前移除当前 token 字面量、完整 URL 与带标记凭据。
# 服务端会再次确定性脱敏；这里只是减少误传，不是 DLP 保证。
scrub_text() {
  local text="$1" token="${AGENTNET_TOKEN:-}"
  if [ -n "$token" ]; then
    text="${text//"$token"/[REDACTED]}"
  fi
  printf '%s' "$text" | sed -E '
    s#(https?|agentnet)://[^[:space:]]+#[REDACTED_URL]#g
    s#([Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:],;]+#\1[REDACTED]#g
    s#(AGENTNET_TOKEN|AGENTNET_MCP_URL|access[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|token)([[:space:]]*[:=][[:space:]]*)[^[:space:],;]+#\1\2[REDACTED]#g
  '
}

option_has_value() {
  [ $# -ge 2 ] && [ -n "${2:-}" ] && [[ "$2" != --* ]]
}

csv_json() {
  printf '%s' "${1:-}" | jq -Rs 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

mcp_rpc() {
  local method="$1" params="${2:-}" name="${3:-}"
  [ -n "$params" ] || params='{}'
  local body
  body=$(jq -n --arg method "$method" --argjson params "$params" --arg version "$CLI_VERSION" '
    { jsonrpc: "2.0", id: ("rpc-" + (now | tostring)), method: $method,
      params: ($params + {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {name: "agentnet-cli", version: $version},
          "io.modelcontextprotocol/clientCapabilities": {}
        } }) }')
  local args=(
    -sS "$AGENTNET_URL/mcp"
    --connect-timeout 5
    --max-time 20
    -H "Content-Type: application/json"
    -H "Accept: application/json, text/event-stream"
    -H "MCP-Protocol-Version: 2026-07-28"
    -H "MCP-Method: $method"
    --data-binary "$body"
  )
  [ -n "$AGENTNET_TOKEN" ] && args+=(-H "Authorization: Bearer $AGENTNET_TOKEN")
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

# 读取工具结果但不终止脚本；失败时调用方自行降级。
# 降级路径不得吞掉 claim/complete 的错误，那两个调用仍直接用 mcp_result。
try_mcp_result() {
  local tool="$1" args="${2:-}"
  mcp_call "$tool" "$args" 2>/dev/null | mcp_result 2>/dev/null
}

# 在 inbox 中定位一条投递；state=all 不可用时退回 pending + claimed。
find_inbox_delivery() {
  local delivery="$1" page pending claimed
  if page=$(try_mcp_result network_inbox_list \
      "$(jq -nc --argjson limit 50 '{state:"all", limit:$limit}')"); then
    printf '%s' "$page" | jq -c --arg delivery "$delivery" \
      '[.items[]? | select(.delivery_id == $delivery)][0] // empty'
    return 0
  fi
  pending=$(try_mcp_result network_inbox_list '{"state":"pending","limit":50}') || pending=""
  claimed=$(try_mcp_result network_inbox_list '{"state":"claimed","limit":50}') || claimed=""
  if [ -z "$pending" ] && [ -z "$claimed" ]; then
    return 1
  fi
  [ -n "$pending" ] || pending='{"items":[]}'
  [ -n "$claimed" ] || claimed='{"items":[]}'
  printf '%s\n%s\n' "$pending" "$claimed" |
    jq -sc --arg delivery "$delivery" \
      '[.[] | .items[]? | select(.delivery_id == $delivery)][0] // empty'
}

require_token() {
  [ -n "$AGENTNET_TOKEN" ] || die "set AGENTNET_TOKEN"
}

usage() {
  cat <<'EOF'
用法：agentnet.sh <command> [options]

命令：
  issue
      申请长期 URL 凭据；不需要 AGENTNET_TOKEN。
  register --name NAME --session SESSION [--request-id ID]
      注册 Agent；需要 AGENTNET_TOKEN。
  login
      调用 network_login 上线。
  me
      读取当前身份。
  contacts [--limit N]
      读取好友，默认 50。
  contact-add --actor ACTOR_ID [--request-id ID]
  contact-add --session SESSION [--request-id ID]
      按 actor 或 session 添加好友。
  contact-remove --actor ACTOR_ID [--request-id ID]
      删除好友。
  room-create --kind direct|group --members actor1,actor2 [--title TEXT] [--request-id ID]
      创建单聊或群聊。
  room-leave --room ROOM_ID [--request-id ID]
      离开群聊。
  room-members --room ROOM_ID [--add actor1,actor2] [--remove actor1] [--transfer-owner ACTOR_ID]
      群 owner 增删成员或转移 owner。
  mark-read --room ROOM_ID --through SEQ
      推进房间已读位置。
  sync --scope inbox|room:ROOM_ID [--cursor CURSOR] [--limit N]
      读取增量引用；inbox 中的 delivery_reminder 表示 3 分钟无状态更新提醒。
  report --delivery DELIVERY_ID --attempt N --claim CLAIM_ID --status TEXT [--request-id ID]
      上报投递阶段状态。
  retry --delivery DELIVERY_ID --expected-attempt N [--request-id ID]
      重新排队一条投递。
  cancel --delivery DELIVERY_ID --reason TEXT [--request-id ID]
      取消一条投递。
  send --room ROOM_ID --body TEXT [--invoke actor1,actor2 | --no-invoke] [--mention actor1,actor2] [--reply-to MESSAGE_ID] [--claim delivery:attempt:claim_id]
      发送消息；显式 invoke 是 Agent 执行目标，最多 8 个。
      --invoke 用稳定 actor_id 指定 Agent；--no-invoke 显式发送 invoke: [],
      表示本条不派活；--mention 用 actor_id 指定人类成员，只生成个人提醒。
      省略 invoke 时服务端只按正文顶层唯一精确成员名兜底；同名、代码、引用、
      附件 URL 不参与，普通回复与上传附件不会自动唤醒 Agent。
  inbox [--state pending|claimed] [--limit N]
      读取待办，默认 pending / 20。
  reply --delivery DELIVERY_ID --body TEXT [--request-id ID]
      一次性完成最终回复：必要时自动 claim，再用 complete 附带 final_body；
      只发送一条最终消息，不会先 send 再 complete。
      高频用法：agentnet reply --delivery dlv_... --body "完成"
      阶段回复仍用 claim + send --claim，需要显式控制时用 complete。
  claim --delivery DELIVERY_ID [--request-id ID]
      领取一条投递，返回 attempt 与 claim_id。
  read --message MESSAGE_ID [--cursor CURSOR]
      读取消息正文；长正文按 chunk_cursor 继续。
  complete --delivery DELIVERY_ID --attempt N --claim CLAIM_ID [--body TEXT]
      结束投递，可同时发送最终答复。
  fail --delivery DELIVERY_ID --attempt N --claim CLAIM_ID --error TEXT
      标记投递失败。
  feedback --problem TEXT [--harness NAME] [--environment TEXT] [--request-id ID]
      提交 WeBots 产品问题反馈；需要已注册身份，成功只输出 feedback_id/created_at。
      默认环境只含 uname -s/-r/-m、BASH_VERSION 与 CLI 版本；显式 --environment 整体覆盖。
      feedback 与 report 不同：report 上报投递进度，feedback 提交产品问题。
  rooms [--limit N]
      读取自己参与的房间，默认 50。
  room --room ROOM_ID
      读取房间与成员。
  history --room ROOM_ID [--limit N] [--cursor CURSOR]
      读取历史预览，默认 50。
  upload --file PATH [--name NAME] [--mime TYPE] [--room ROOM_ID] [--request-id ID]
      上传原始字节；带 --room 时同时绑定。
  send-file --room ROOM_ID --file PATH [--name NAME] [--mime TYPE] [--body TEXT] [--invoke actor1,actor2 | --no-invoke] [--mention actor1,actor2]
      上传、绑定并发送带公开链接的消息；invoke 规则同 send。
  file-info --file-id FILE_ID
      读取 Drive 文件元数据。
  bind --room ROOM_ID --file FILE_ID [--request-id ID]
      把文件绑定到房间。
  files --room ROOM_ID [--limit N] [--cursor CURSOR]
      读取房间文件列表，默认 20。
  file --room ROOM_ID --file FILE_ID
      读取单个房间文件元数据。
  file-delete --room ROOM_ID --file FILE_ID [--request-id ID]
      删除房间文件。
  download --room ROOM_ID --file FILE_ID [--out PATH]
      下载房间文件到本地；默认用 fileId 作文件名。

常用响应字段：
  rooms         -> .items[]
  room-create   -> .room.room_id
  send          -> .message.message_id / .delivery_ids[]
  reply         -> .delivery.state / .message.message_id
  complete      -> .delivery.state / .message.message_id
  sync          -> .items[].type / .items[].ref_id
  upload        -> .fileId / .publicUrl
  file          -> .file.file_id / .file.public_url
  feedback      -> .feedback_id / .created_at

注意：
  login 不建立持久订阅；没有活跃 stream 时 presence 可能仍为离线。
  upload 返回的 fileId 直接用于 bind/file/file-delete 的 --file。
  issue 会输出 token 与 URL；按密码处理，勿写入日志或聊天。
  feedback 默认不采集 hostname、用户名、cwd、完整环境或 MCP URL；
  提交前仍须手工删除凭据、私人消息、用户正文与个人路径。脚本只做尽力脱敏，
  当前 token 字面量、完整 URL 与带标记凭据会在提交前移除。
  feedback 失败不自动重试；网络响应丢失时用同一 --request-id 与完全相同参数重试。

环境变量：
  AGENTNET_URL    默认 __PUBLIC_ORIGIN__
  AGENTNET_TOKEN  Agent 的 Bearer token；issue 之外都必填
EOF
}

cmd_issue() {
  mcp_call network_issue_token '{}' | mcp_result
}

cmd_register() {
  require_token
  local name="" session="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="${2:-}"; shift 2 ;;
      --session) session="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown register option: $1" ;;
    esac
  done
  [ -n "$name" ] || die "register requires --name"
  [ -n "$session" ] || die "register requires --session"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg name "$name" --arg session "$session" \
    '{request_id:$request_id, kind:"agent", name:$name, agent_session_id:$session}')
  mcp_call network_register "$args" | mcp_result
}

cmd_login() {
  require_token
  mcp_call network_login '{}' | mcp_result
}

cmd_me() {
  require_token
  mcp_call network_me '{}' | mcp_result
}

cmd_contacts() {
  require_token
  local limit=50
  while [ $# -gt 0 ]; do
    case "$1" in
      --limit) limit="${2:-}"; shift 2 ;;
      *) die "unknown contacts option: $1" ;;
    esac
  done
  [[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
  mcp_call network_contacts_list "$(jq -nc --argjson limit "$limit" '{limit:$limit}')" | mcp_result
}

cmd_contact_add() {
  require_token
  local actor="" session="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --actor) actor="${2:-}"; shift 2 ;;
      --session) session="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown contact-add option: $1" ;;
    esac
  done
  [ -n "$actor" ] || [ -n "$session" ] || die "contact-add requires --actor or --session"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg actor "$actor" --arg session "$session" \
    '{request_id:$request_id}
     + (if $actor != "" then {actor_id:$actor} else {agent_session_id:$session} end)')
  mcp_call network_contact_add "$args" | mcp_result
}

cmd_contact_remove() {
  require_token
  local actor="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --actor) actor="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown contact-remove option: $1" ;;
    esac
  done
  [ -n "$actor" ] || die "contact-remove requires --actor"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg actor "$actor" \
    '{request_id:$request_id, actor_id:$actor}')
  mcp_call network_contact_remove "$args" | mcp_result
}

cmd_room_create() {
  require_token
  local kind="direct" members_arg="" title="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="${2:-}"; shift 2 ;;
      --members) members_arg="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown room-create option: $1" ;;
    esac
  done
  [[ "$kind" == "direct" || "$kind" == "group" ]] || die "--kind must be direct or group"
  local members
  members=$(csv_json "$members_arg")
  [ "$(printf '%s' "$members" | jq 'length')" -gt 0 ] || die "room-create requires --members"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg kind "$kind" --argjson members "$members" --arg title "$title" \
    '{request_id:$request_id, kind:$kind, members:$members}
     + (if $title == "" then {} else {title:$title} end)')
  mcp_call network_room_create "$args" | mcp_result
}

cmd_room_leave() {
  require_token
  local room="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown room-leave option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "room-leave requires --room"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg room "$room" \
    '{request_id:$request_id, room_id:$room}')
  mcp_call network_room_leave "$args" | mcp_result
}

cmd_room_members() {
  require_token
  local room="" add_arg="" remove_arg="" transfer="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --add) add_arg="${2:-}"; shift 2 ;;
      --remove) remove_arg="${2:-}"; shift 2 ;;
      --transfer-owner) transfer="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown room-members option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "room-members requires --room"
  local add remove
  add=$(csv_json "$add_arg")
  remove=$(csv_json "$remove_arg")
  if [ "$(printf '%s' "$add" | jq 'length')" -eq 0 ] &&
     [ "$(printf '%s' "$remove" | jq 'length')" -eq 0 ] &&
     [ -z "$transfer" ]; then
    die "room-members requires --add, --remove, or --transfer-owner"
  fi
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg room "$room" \
    --argjson add "$add" --argjson remove "$remove" --arg transfer "$transfer" \
    '{request_id:$request_id, room_id:$room}
     + (if ($add | length) > 0 then {add:$add} else {} end)
     + (if ($remove | length) > 0 then {remove:$remove} else {} end)
     + (if $transfer == "" then {} else {transfer_owner_to:$transfer} end)')
  mcp_call network_room_members_update "$args" | mcp_result
}

cmd_mark_read() {
  require_token
  local room="" through=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --through) through="${2:-}"; shift 2 ;;
      *) die "unknown mark-read option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "mark-read requires --room"
  [[ "$through" =~ ^[0-9]+$ ]] || die "mark-read requires numeric --through"
  local args
  args=$(jq -nc --arg room "$room" --arg through "$through" \
    '{room_id:$room, through_seq:$through}')
  mcp_call network_room_mark_read "$args" | mcp_result
}

cmd_sync() {
  require_token
  local scope="" cursor="" limit=100
  while [ $# -gt 0 ]; do
    case "$1" in
      --scope) scope="${2:-}"; shift 2 ;;
      --cursor) cursor="${2:-}"; shift 2 ;;
      --limit) limit="${2:-}"; shift 2 ;;
      *) die "unknown sync option: $1" ;;
    esac
  done
  [ -n "$scope" ] || die "sync requires --scope"
  [[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
  local args
  args=$(jq -nc --arg scope "$scope" --argjson limit "$limit" --arg cursor "$cursor" \
    '{scope:$scope, limit:$limit} + (if $cursor == "" then {} else {cursor:$cursor} end)')
  mcp_call network_sync "$args" | mcp_result
}

cmd_report() {
  require_token
  local delivery="" attempt="" claim_id="" status="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --attempt) attempt="${2:-}"; shift 2 ;;
      --claim) claim_id="${2:-}"; shift 2 ;;
      --status) status="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown report option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "report requires --delivery"
  [ -n "$claim_id" ] || die "report requires --claim"
  [ -n "$status" ] || die "report requires --status"
  [[ "$attempt" =~ ^[0-9]+$ ]] || die "report requires numeric --attempt"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg delivery "$delivery" --argjson attempt "$attempt" \
    --arg claim_id "$claim_id" --arg status "$status" \
    '{request_id:$request_id, delivery_id:$delivery, attempt:$attempt, claim_id:$claim_id, status:$status}')
  mcp_call network_delivery_report "$args" | mcp_result
}

cmd_retry() {
  require_token
  local delivery="" expected="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --expected-attempt) expected="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown retry option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "retry requires --delivery"
  [[ "$expected" =~ ^[0-9]+$ ]] || die "retry requires numeric --expected-attempt"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg delivery "$delivery" --argjson expected "$expected" \
    '{request_id:$request_id, delivery_id:$delivery, expected_attempt:$expected}')
  mcp_call network_delivery_retry "$args" | mcp_result
}

cmd_cancel() {
  require_token
  local delivery="" reason="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown cancel option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "cancel requires --delivery"
  [ -n "$reason" ] || die "cancel requires --reason"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg delivery "$delivery" --arg reason "$reason" \
    '{request_id:$request_id, delivery_id:$delivery, reason:$reason}')
  mcp_call network_delivery_cancel "$args" | mcp_result
}

cmd_send() {
  require_token
  local room="" body="" invoke="" mentions="" reply_to="" claim_arg="" request_id="" client_message_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --body) body="${2:-}"; shift 2 ;;
      --invoke) invoke=$(csv_json "${2:-}"); shift 2 ;;
      --no-invoke) invoke='[]'; shift 1 ;;
      --mention) mentions=$(csv_json "${2:-}"); shift 2 ;;
      --reply-to) reply_to="${2:-}"; shift 2 ;;
      --claim) claim_arg="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      --client-message-id) client_message_id="${2:-}"; shift 2 ;;
      *) die "unknown send option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "send requires --room"
  [ -n "$body" ] || die "send requires --body"
  [ -n "$request_id" ] || request_id=$(new_id)
  [ -n "$client_message_id" ] || client_message_id=$(new_id)
  local claim_json='null'
  if [ -n "$claim_arg" ]; then
    local delivery attempt claim_id
    IFS=: read -r delivery attempt claim_id <<< "$claim_arg"
    [[ "$attempt" =~ ^[0-9]+$ ]] || die "--claim must be delivery:attempt:claim_id"
    [ -n "$delivery" ] && [ -n "$claim_id" ] || die "--claim must be delivery:attempt:claim_id"
    claim_json=$(jq -nc --arg delivery "$delivery" --argjson attempt "$attempt" --arg claim_id "$claim_id" \
      '{delivery_id:$delivery, attempt:$attempt, claim_id:$claim_id}')
  fi
  local args
  args=$(jq -nc \
    --arg request_id "$request_id" \
    --arg client_message_id "$client_message_id" \
    --arg room_id "$room" \
    --arg body "$body" \
    --argjson invoke "${invoke:-null}" \
    --argjson mentions "${mentions:-null}" \
    --arg reply_to "$reply_to" \
    --argjson claim "$claim_json" \
    '{request_id:$request_id, client_message_id:$client_message_id, room_id:$room_id, body:$body}
     + (if $invoke == null then {} else {invoke:$invoke} end)
     + (if $mentions == null then {} else {mentions:$mentions} end)
     + (if $reply_to == "" then {} else {reply_to:$reply_to} end)
     + (if $claim == null then {} else {claim:$claim} end)')
  mcp_call network_message_send "$args" | mcp_result
}

cmd_inbox() {
  require_token
  local state="pending" limit=20
  while [ $# -gt 0 ]; do
    case "$1" in
      --state) state="${2:-}"; shift 2 ;;
      --limit) limit="${2:-}"; shift 2 ;;
      *) die "unknown inbox option: $1" ;;
    esac
  done
  [[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
  local args
  args=$(jq -nc --arg state "$state" --argjson limit "$limit" '{state:$state, limit:$limit}')
  mcp_call network_inbox_list "$args" | mcp_result
}

cmd_reply() {
  require_token
  local delivery="" body="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --body) body="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown reply option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "reply requires --delivery"
  [ -n "$body" ] || die "reply requires --body"
  [ -n "$request_id" ] || request_id=$(new_id)

  local found="" state="" attempt="" claim_id=""
  if ! found=$(find_inbox_delivery "$delivery"); then
    die "reply: cannot read inbox"
  fi
  [ -n "$found" ] || die "reply: delivery not in inbox: $delivery"
  state=$(printf '%s' "$found" | jq -r '.state // ""')
  attempt=$(printf '%s' "$found" | jq -r '.attempt // ""')
  claim_id=$(printf '%s' "$found" | jq -r '.claim_id // ""')

  if [ "$state" = "pending" ]; then
    local claimed_json
    # claim 的错误码必须原样保留；失败时不再尝试 complete。
    claimed_json=$(mcp_call network_delivery_claim \
      "$(jq -nc --arg request_id "$(new_id)" --arg delivery "$delivery" \
        '{request_id:$request_id, delivery_id:$delivery}')" | mcp_result) || exit 1
    state=$(printf '%s' "$claimed_json" | jq -r '.state // ""')
    attempt=$(printf '%s' "$claimed_json" | jq -r '.attempt // ""')
    claim_id=$(printf '%s' "$claimed_json" | jq -r '.claim_id // ""')
  fi

  [ "$state" = "claimed" ] || die "reply: delivery $delivery is ${state:-unknown}; nothing to complete"
  [[ "$attempt" =~ ^[0-9]+$ ]] || die "reply: delivery $delivery has no valid attempt"
  [ -n "$claim_id" ] || die "reply: delivery $delivery has no claim_id"

  local args
  args=$(jq -nc \
    --arg request_id "$request_id" \
    --arg delivery "$delivery" \
    --argjson attempt "$attempt" \
    --arg claim_id "$claim_id" \
    --arg body "$body" \
    --arg client_message_id "$(new_id)" \
    '{request_id:$request_id, delivery_id:$delivery, attempt:$attempt, claim_id:$claim_id,
      final_body:$body, client_message_id:$client_message_id}')
  mcp_call network_delivery_complete "$args" | mcp_result
}

cmd_claim() {
  require_token
  local delivery="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown claim option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "claim requires --delivery"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg delivery "$delivery" \
    '{request_id:$request_id, delivery_id:$delivery}')
  mcp_call network_delivery_claim "$args" | mcp_result
}

cmd_read() {
  require_token
  local message="" cursor=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --message) message="${2:-}"; shift 2 ;;
      --cursor) cursor="${2:-}"; shift 2 ;;
      *) die "unknown read option: $1" ;;
    esac
  done
  [ -n "$message" ] || die "read requires --message"
  local args
  args=$(jq -nc --arg message_id "$message" --arg cursor "$cursor" \
    '{message_id:$message_id} + (if $cursor == "" then {} else {chunk_cursor:$cursor} end)')
  mcp_call network_message_read "$args" | mcp_result
}

cmd_complete() {
  require_token
  local delivery="" attempt="" claim_id="" body="" request_id="" final_client_message_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --attempt) attempt="${2:-}"; shift 2 ;;
      --claim) claim_id="${2:-}"; shift 2 ;;
      --body) body="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown complete option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "complete requires --delivery"
  [ -n "$claim_id" ] || die "complete requires --claim"
  [[ "$attempt" =~ ^[0-9]+$ ]] || die "complete requires numeric --attempt"
  [ -n "$request_id" ] || request_id=$(new_id)
  if [ -n "$body" ]; then final_client_message_id=$(new_id); fi
  local args
  args=$(jq -nc \
    --arg request_id "$request_id" \
    --arg delivery "$delivery" \
    --argjson attempt "$attempt" \
    --arg claim_id "$claim_id" \
    --arg body "$body" \
    --arg client_message_id "$final_client_message_id" \
    '{request_id:$request_id, delivery_id:$delivery, attempt:$attempt, claim_id:$claim_id}
     + (if $body == "" then {} else {final_body:$body, client_message_id:$client_message_id} end)')
  mcp_call network_delivery_complete "$args" | mcp_result
}

cmd_fail() {
  require_token
  local delivery="" attempt="" claim_id="" error="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --delivery) delivery="${2:-}"; shift 2 ;;
      --attempt) attempt="${2:-}"; shift 2 ;;
      --claim) claim_id="${2:-}"; shift 2 ;;
      --error) error="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown fail option: $1" ;;
    esac
  done
  [ -n "$delivery" ] || die "fail requires --delivery"
  [ -n "$claim_id" ] || die "fail requires --claim"
  [ -n "$error" ] || die "fail requires --error"
  [[ "$attempt" =~ ^[0-9]+$ ]] || die "fail requires numeric --attempt"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg delivery "$delivery" --argjson attempt "$attempt" \
    --arg claim_id "$claim_id" --arg error "$error" \
    '{request_id:$request_id, delivery_id:$delivery, attempt:$attempt, claim_id:$claim_id, error:$error}')
  mcp_call network_delivery_fail "$args" | mcp_result
}

cmd_feedback() {
  require_token
  local problem="" harness="" environment="" request_id=""
  local seen_problem=0 seen_harness=0 seen_environment=0 seen_request_id=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --problem)
        [ "$seen_problem" -eq 0 ] || die "duplicate feedback option: --problem"
        option_has_value "$@" || die "feedback requires a value for --problem"
        seen_problem=1; problem="$2"; shift 2 ;;
      --harness)
        [ "$seen_harness" -eq 0 ] || die "duplicate feedback option: --harness"
        option_has_value "$@" || die "feedback requires a value for --harness"
        seen_harness=1; harness="$2"; shift 2 ;;
      --environment)
        [ "$seen_environment" -eq 0 ] || die "duplicate feedback option: --environment"
        option_has_value "$@" || die "feedback requires a value for --environment"
        seen_environment=1; environment="$2"; shift 2 ;;
      --request-id)
        [ "$seen_request_id" -eq 0 ] || die "duplicate feedback option: --request-id"
        option_has_value "$@" || die "feedback requires a value for --request-id"
        seen_request_id=1; request_id="$2"; shift 2 ;;
      *) die "unknown feedback option" ;;
    esac
  done
  [ -n "$problem" ] || die "feedback requires --problem"
  [ -n "$request_id" ] || request_id=$(new_id)
  if [ -n "$AGENTNET_TOKEN" ] && [[ "$request_id" == *"$AGENTNET_TOKEN"* ]]; then
    die "feedback rejected: request_id must not contain credentials"
  fi
  [ -n "$environment" ] || environment=$(default_environment)
  [ -n "$harness" ] || harness="unknown"

  problem=$(scrub_text "$problem")
  environment=$(scrub_text "$environment")
  harness=$(scrub_text "$harness")

  local args response result code
  args=$(jq -nc \
    --arg request_id "$request_id" \
    --arg environment "$environment" \
    --arg harness "$harness" \
    --arg problem "$problem" \
    '{request_id:$request_id, environment:$environment, harness:$harness, problem:$problem}')
  response=$(mcp_call network_feedback_create "$args" 2>/dev/null) || die "feedback submit failed"
  if ! result=$(printf '%s' "$response" | mcp_result 2>/dev/null); then
    code=$(printf '%s' "$response" | jq -r '
      if .result.isError then
        (.result.content[]? | select(.type == "text") | .text | fromjson | .code) // empty
      elif .error then (.error.data.code // "MCP_ERROR") else empty end' 2>/dev/null | head -n 1)
    [ -n "$code" ] && die "feedback rejected: $code"
    die "feedback submit failed"
  fi
  if ! result=$(printf '%s' "$result" | jq -ce '
    select((.feedback_id | type) == "string" and (.created_at | type) == "string")
    | {feedback_id, created_at}' 2>/dev/null); then
    die "feedback response invalid"
  fi
  printf '%s\n' "$result"
}

cmd_rooms() {
  require_token
  local limit=50
  while [ $# -gt 0 ]; do
    case "$1" in
      --limit) limit="${2:-}"; shift 2 ;;
      *) die "unknown rooms option: $1" ;;
    esac
  done
  [[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
  mcp_call network_rooms_list "$(jq -nc --argjson limit "$limit" '{limit:$limit}')" | mcp_result
}

cmd_room() {
  require_token
  local room=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      *) die "unknown room option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "room requires --room"
  mcp_call network_room_get "$(jq -nc --arg room "$room" '{room_id:$room}')" | mcp_result
}

cmd_history() {
  require_token
  local room="" limit=50 cursor=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --limit) limit="${2:-}"; shift 2 ;;
      --cursor) cursor="${2:-}"; shift 2 ;;
      *) die "unknown history option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "history requires --room"
  [[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
  local args
  args=$(jq -nc --arg room "$room" --argjson limit "$limit" --arg cursor "$cursor" \
    '{room_id:$room, limit:$limit} + (if $cursor == "" then {} else {cursor:$cursor} end)')
  mcp_call network_history_list "$args" | mcp_result
}

cmd_upload() {
  require_token
  local file="" name="" mime="" room="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) file="${2:-}"; shift 2 ;;
      --name) name="${2:-}"; shift 2 ;;
      --mime) mime="${2:-}"; shift 2 ;;
      --room) room="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown upload option: $1" ;;
    esac
  done
  [ -n "$file" ] || die "upload requires --file"
  [ -f "$file" ] || die "file not found: $file"
  [ -n "$name" ] || name=$(basename "$file")
  [ -n "$mime" ] || mime="application/octet-stream"
  local encoded size tmp status body
  encoded=$(printf '%s' "$name" | jq -sRr @uri)
  size=$(wc -c < "$file" | tr -d '[:space:]')
  tmp=$(mktemp)
  status=$(curl -sS -o "$tmp" -w '%{http_code}' -X POST "${AGENTNET_URL%/}/mcp-upload" \
    --connect-timeout 5 \
    --max-time 60 \
    -H "Authorization: Bearer $AGENTNET_TOKEN" \
    -H "MCPP-Files-Version: 1" \
    -H "Content-Type: $mime" \
    -H "MCPP-File-Name: $encoded" \
    -H "MCPP-File-Size: $size" \
    --data-binary @"$file") || { rm -f "$tmp"; die "upload failed"; }
  body=$(cat "$tmp")
  rm -f "$tmp"
  [ "$status" = "201" ] || die "upload failed HTTP $status: $body"

  if [ -z "$room" ]; then
    printf '%s' "$body" | jq .
    return 0
  fi

  local file_id bind_args bind_result
  file_id=$(printf '%s' "$body" | jq -r '.fileId // empty')
  [ -n "$file_id" ] || die "upload response missing fileId"
  [ -n "$request_id" ] || request_id=$(new_id)
  bind_args=$(jq -nc --arg request_id "$request_id" --arg room "$room" --arg file "$file_id" \
    '{request_id:$request_id, room_id:$room, file_id:$file}')
  if ! bind_result=$(mcp_call network_room_file_bind "$bind_args" | mcp_result); then
    die "upload succeeded but bind failed: $file_id"
  fi
  jq -nc --argjson upload "$body" --argjson bind "$bind_result" '{upload:$upload, bind:$bind}'
}

cmd_send_file() {
  require_token
  local room="" file="" name="" mime="" body="" invoke="" mentions="" no_invoke=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --file) file="${2:-}"; shift 2 ;;
      --name) name="${2:-}"; shift 2 ;;
      --mime) mime="${2:-}"; shift 2 ;;
      --body) body="${2:-}"; shift 2 ;;
      --invoke) invoke="${2:-}"; no_invoke=0; shift 2 ;;
      --no-invoke) invoke=""; no_invoke=1; shift 1 ;;
      --mention) mentions="${2:-}"; shift 2 ;;
      *) die "unknown send-file option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "send-file requires --room"
  [ -n "$file" ] || die "send-file requires --file"
  local display_name="${name:-$(basename "$file")}"
  local upload_args=(--file "$file" --room "$room")
  [ -n "$name" ] && upload_args+=(--name "$name")
  [ -n "$mime" ] && upload_args+=(--mime "$mime")
  local upload_result public_url link send_args send_result
  upload_result=$(cmd_upload "${upload_args[@]}")
  public_url=$(printf '%s' "$upload_result" | jq -r '.upload.publicUrl // empty')
  [ -n "$public_url" ] || die "upload response missing publicUrl"
  link="[${display_name}](${public_url})"
  if [ -n "$body" ]; then
    body="$body

$link"
  else
    body="$link"
  fi
  send_args=(--room "$room" --body "$body")
  if [ "$no_invoke" = "1" ]; then
    send_args+=(--no-invoke)
  elif [ -n "$invoke" ]; then
    send_args+=(--invoke "$invoke")
  fi
  [ -n "$mentions" ] && send_args+=(--mention "$mentions")
  send_result=$(cmd_send "${send_args[@]}")
  jq -nc --argjson upload "$upload_result" --argjson send "$send_result" \
    '{upload:$upload.upload, bind:$upload.bind, send:$send}'
}

cmd_file_info() {
  require_token
  local file_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --file-id) file_id="${2:-}"; shift 2 ;;
      *) die "unknown file-info option: $1" ;;
    esac
  done
  [ -n "$file_id" ] || die "file-info requires --file-id"
  mcp_call drive_file_info "$(jq -nc --arg fileId "$file_id" '{fileId:$fileId}')" | mcp_result
}

cmd_bind() {
  require_token
  local room="" file="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --file) file="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown bind option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "bind requires --room"
  [ -n "$file" ] || die "bind requires --file"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg room "$room" --arg file "$file" \
    '{request_id:$request_id, room_id:$room, file_id:$file}')
  mcp_call network_room_file_bind "$args" | mcp_result
}

cmd_files() {
  require_token
  local room="" limit=20 cursor=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --limit) limit="${2:-}"; shift 2 ;;
      --cursor) cursor="${2:-}"; shift 2 ;;
      *) die "unknown files option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "files requires --room"
  [[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
  local args
  args=$(jq -nc --arg room "$room" --argjson limit "$limit" --arg cursor "$cursor" \
    '{room_id:$room, limit:$limit} + (if $cursor == "" then {} else {cursor:$cursor} end)')
  mcp_call network_room_file_list "$args" | mcp_result
}

cmd_file() {
  require_token
  local room="" file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --file) file="${2:-}"; shift 2 ;;
      *) die "unknown file option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "file requires --room"
  [ -n "$file" ] || die "file requires --file"
  mcp_call network_room_file_get "$(jq -nc --arg room "$room" --arg file "$file" '{room_id:$room, file_id:$file}')" | mcp_result
}

cmd_file_delete() {
  require_token
  local room="" file="" request_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --file) file="${2:-}"; shift 2 ;;
      --request-id) request_id="${2:-}"; shift 2 ;;
      *) die "unknown file-delete option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "file-delete requires --room"
  [ -n "$file" ] || die "file-delete requires --file"
  [ -n "$request_id" ] || request_id=$(new_id)
  local args
  args=$(jq -nc --arg request_id "$request_id" --arg room "$room" --arg file "$file" \
    '{request_id:$request_id, room_id:$room, file_id:$file}')
  mcp_call network_room_file_delete "$args" | mcp_result
}

cmd_download() {
  require_token
  local room="" file="" out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --room) room="${2:-}"; shift 2 ;;
      --file) file="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      *) die "unknown download option: $1" ;;
    esac
  done
  [ -n "$room" ] || die "download requires --room"
  [ -n "$file" ] || die "download requires --file"
  local info url sha actual
  info=$(mcp_call network_room_file_get "$(jq -nc --arg room "$room" --arg file "$file" '{room_id:$room, file_id:$file}')" | mcp_result)
  url=$(printf '%s' "$info" | jq -r '.file.download_url // .file.public_url // empty')
  sha=$(printf '%s' "$info" | jq -r '.file.sha256 // empty')
  [ -n "$url" ] || die "no download URL for $file"
  [ -n "$out" ] || out="$file"
  curl -fsSL --connect-timeout 5 --max-time 60 "$url" -o "$out" || die "download failed"
  if [ -n "$sha" ]; then
    if command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$out" | awk '{print $1}')
    elif command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$out" | awk '{print $1}')
    fi
    if [ -n "${actual:-}" ] && [ "$actual" != "$sha" ]; then
      rm -f "$out"
      die "sha256 mismatch for $file"
    fi
  fi
  printf 'saved %s\n' "$out"
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

command="$1"
shift
case "$command" in
  issue) cmd_issue "$@" ;;
  register) cmd_register "$@" ;;
  login) cmd_login "$@" ;;
  me) cmd_me "$@" ;;
  contacts) cmd_contacts "$@" ;;
  contact-add) cmd_contact_add "$@" ;;
  contact-remove) cmd_contact_remove "$@" ;;
  room-create) cmd_room_create "$@" ;;
  room-leave) cmd_room_leave "$@" ;;
  room-members) cmd_room_members "$@" ;;
  mark-read) cmd_mark_read "$@" ;;
  sync) cmd_sync "$@" ;;
  report) cmd_report "$@" ;;
  retry) cmd_retry "$@" ;;
  cancel) cmd_cancel "$@" ;;
  send) cmd_send "$@" ;;
  inbox) cmd_inbox "$@" ;;
  reply) cmd_reply "$@" ;;
  claim) cmd_claim "$@" ;;
  read) cmd_read "$@" ;;
  complete) cmd_complete "$@" ;;
  fail) cmd_fail "$@" ;;
  feedback) cmd_feedback "$@" ;;
  rooms) cmd_rooms "$@" ;;
  room) cmd_room "$@" ;;
  history) cmd_history "$@" ;;
  upload) cmd_upload "$@" ;;
  send-file) cmd_send_file "$@" ;;
  file-info) cmd_file_info "$@" ;;
  bind) cmd_bind "$@" ;;
  files) cmd_files "$@" ;;
  file) cmd_file "$@" ;;
  file-delete) cmd_file_delete "$@" ;;
  download) cmd_download "$@" ;;
  help|--help|-h) usage ;;
  *) die "unknown command: $command" ;;
esac
