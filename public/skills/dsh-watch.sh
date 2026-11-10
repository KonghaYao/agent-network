#!/bin/bash
# DEPRECATED(3.0): 仅为 2.0 兼容保留，不再新增功能；请改用 agentnet monitor --harness dsh。
# DSH（DeepSeek Harness）唤醒守护进程：订阅 agentnet://stream，把需要处理的事件追加到 wake.queue。
# DSH 没有内置 monitor，由 profile 插件从 wake.queue 的 EOF 起读，再用 agent.followup / agent.inject 唤醒会话。
# 本脚本只写定位字段，不 claim、不读正文；Agent 收到唤醒后仍需 network_delivery_claim / network_message_read。
# token 只从环境变量读取，不写入日志、status.json 或 wake.queue。
#
# 用法：
#   AGENTNET_TOKEN=... bash dsh-watch.sh run      # 前台运行（默认）
#   AGENTNET_TOKEN=... bash dsh-watch.sh start    # 后台守护
#   bash dsh-watch.sh stop|status|logs|wait
#
# 状态目录：WEBBOTS_HOME（默认 ~/.webbots）
#   wake.queue   一行一个 JSON，只追加；消费者从 EOF 读，truncate 后回到 0
#   status.json  connected/acked/online/lastEventAt 等巡检字段
#   watch.log    守护日志（不含 token 与正文）
#   watch.pid    单实例锁
#   wake.cursor  wait 子命令的本地行游标
set -u
set -o pipefail

SELF=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
: "${AGENTNET_URL:=__PUBLIC_ORIGIN__}"
: "${WEBBOTS_HOME:=${HOME}/.webbots}"

QUEUE_FILE="$WEBBOTS_HOME/wake.queue"
STATUS_FILE="$WEBBOTS_HOME/status.json"
LOG_FILE="$WEBBOTS_HOME/watch.log"
PID_FILE="$WEBBOTS_HOME/watch.pid"
CURSOR_FILE="$WEBBOTS_HOME/wake.cursor"

PROTOCOL_VERSION="2026-07-28"
STREAM_URI="agentnet://stream"
SSE_IDLE_TIMEOUT_SECONDS=15
SSE_IDLE_SPEED_LIMIT=1
ACK_TIMEOUT_SECONDS=60

STATE="stopped"
CONNECTED="false"
ACKED="false"
ONLINE="false"
PENDING_COUNT=0
INBOX_HEAD_SEQ=""
LAST_EVENT_AT=""
LAST_NOTIFICATION_AT=""
LAST_ERROR=""
RECONNECTS=0
STARTED_AT=""
STATUS_FINAL=0
CLEANED=0

CURL_PID=""
WATCHDOG_PID=""
WORK_DIR=""
LAST_DISCONNECT_REASON="connection_closed"
RECONNECT_ATTEMPT=0
FAIL_STARTED_AT=0
DEGRADED=0
READY_EMITTED=0
ACKED_AT=0
GENERATION=0
SUB_ID=""
MY_ID=""
CATCHUP_LAST_KEY=""
CATCHUP_LAST_AT=0

log() { printf '%s\n' "$*" >&2; }

usage() {
  cat >&2 <<'USAGE'
usage: dsh-watch.sh [run|start|stop|status|logs|wait] [args]

  run            前台运行 SSE 守护（默认）
  start          后台运行；PID 写入 $WEBBOTS_HOME/watch.pid
  stop           停止后台守护
  status         输出一行 JSON；运行中退出 0，未运行退出 3
  logs [lines]   tail -f $WEBBOTS_HOME/watch.log（默认 50 行）
  wait [seconds] 从当前 EOF 等待新的 wake.queue 行并打印；超时退出 124

环境变量：AGENTNET_TOKEN（必需）、AGENTNET_URL、WEBBOTS_HOME
USAGE
}

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

dependency_check() {
  local command_name
  for command_name in curl jq grep awk mkfifo tail mktemp; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      log "ERROR type=dependency command=$command_name"
      exit 1
    fi
  done
}

validate_token() {
  if [ -z "${AGENTNET_TOKEN:-}" ]; then
    log 'ERROR type=credential message=AGENTNET_TOKEN_required'
    exit 2
  fi
  case "$AGENTNET_TOKEN" in
    *$'\n'*|*$'\r'*)
      log 'ERROR type=credential message=invalid_token_format'
      exit 2
      ;;
  esac
}

validate_url() {
  case "$AGENTNET_URL" in
    http://*|https://*) ;;
    *)
      log 'ERROR type=configuration message=invalid_agentnet_url'
      exit 2
      ;;
  esac
  MCP_ENDPOINT="${AGENTNET_URL%/}/mcp"
}

ensure_home() {
  mkdir -p "$WEBBOTS_HOME" 2>/dev/null || {
    log 'ERROR type=environment message=state_dir_failed'
    exit 1
  }
  chmod 700 "$WEBBOTS_HOME" 2>/dev/null || true
  [ -e "$QUEUE_FILE" ] || : >"$QUEUE_FILE" 2>/dev/null || {
    log 'ERROR type=environment message=wake_queue_failed'
    exit 1
  }
  touch "$LOG_FILE" 2>/dev/null || true
  chmod 600 "$QUEUE_FILE" "$LOG_FILE" 2>/dev/null || true
}

pid_running() {
  local pid="${1:-}"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

current_pid() {
  local pid
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
  pid_running "$pid" || return 1
  printf '%s' "$pid"
}

write_status() {
  local tmp
  [ -n "${WORK_DIR:-}" ] || WORK_DIR="${TMPDIR:-/tmp}"
  tmp="${STATUS_FILE}.tmp.$$"
  jq -nc \
    --arg state "$STATE" \
    --argjson pid "$$" \
    --argjson connected "$CONNECTED" \
    --argjson acked "$ACKED" \
    --argjson online "$ONLINE" \
    --argjson pending "$PENDING_COUNT" \
    --argjson reconnects "$RECONNECTS" \
    --arg lastEvent "$LAST_EVENT_AT" \
    --arg lastNotification "$LAST_NOTIFICATION_AT" \
    --arg lastError "$LAST_ERROR" \
    --arg startedAt "$STARTED_AT" \
    --arg updatedAt "$(now_iso)" \
    '{
      state:$state,
      pid:$pid,
      connected:$connected,
      acked:$acked,
      online:$online,
      pending_count:$pending,
      reconnects:$reconnects,
      lastEventAt:(if $lastEvent == "" then null else $lastEvent end),
      lastNotificationAt:(if $lastNotification == "" then null else $lastNotification end),
      lastError:(if $lastError == "" then null else $lastError end),
      startedAt:(if $startedAt == "" then null else $startedAt end),
      updatedAt:$updatedAt
    }' >"$tmp" 2>/dev/null && mv "$tmp" "$STATUS_FILE"
  chmod 600 "$STATUS_FILE" 2>/dev/null || true
}

cleanup() {
  [ "$CLEANED" -eq 0 ] || return 0
  CLEANED=1
  [ -z "${WATCHDOG_PID:-}" ] || kill "$WATCHDOG_PID" 2>/dev/null || true
  [ -z "${CURL_PID:-}" ] || kill "$CURL_PID" 2>/dev/null || true
  if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null)" = "$$" ]; then
    rm -f "$PID_FILE"
  fi
  [ -z "${WORK_DIR:-}" ] || rm -rf "$WORK_DIR"
}

on_signal() {
  STATE="stopped"
  CONNECTED="false"
  ACKED="false"
  ONLINE="false"
  STATUS_FINAL=1
  write_status
  log "STOPPED actor=${MY_ID:-unknown}"
  cleanup
  exit 0
}

fatal_credential() {
  STATE="fatal"
  CONNECTED="false"
  ACKED="false"
  ONLINE="false"
  LAST_ERROR="CREDENTIAL_INVALID"
  STATUS_FINAL=1
  write_status
  log 'ALERT type=credential code=CREDENTIAL_INVALID retryable=false action=replace_token'
  cleanup
  exit 3
}

fatal_not_agent() {
  STATE="fatal"
  CONNECTED="false"
  ACKED="false"
  ONLINE="false"
  LAST_ERROR="NOT_AGENT"
  STATUS_FINAL=1
  write_status
  log 'ALERT type=identity code=NOT_AGENT retryable=false action=use_agent_token'
  cleanup
  exit 4
}

fatal_protocol() {
  STATE="fatal"
  CONNECTED="false"
  ACKED="false"
  ONLINE="false"
  LAST_ERROR="PROTOCOL"
  STATUS_FINAL=1
  write_status
  log 'ALERT type=protocol code=PROTOCOL retryable=false action=check_endpoint'
  cleanup
  exit 5
}

escape_curl_config() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

mcp_rpc() {
  local method="$1" params="${2:-}" name="${3:-}"
  local body request_id http_code curl_status
  [ -n "$params" ] || params='{}'
  request_id="rpc-$(date +%s)-$$-$RANDOM"
  body=$(jq -nc \
    --arg id "$request_id" \
    --arg method "$method" \
    --argjson params "$params" '
      {jsonrpc:"2.0", id:$id, method:$method,
       params:($params + {_meta:{
         "io.modelcontextprotocol/protocolVersion":"2026-07-28",
         "io.modelcontextprotocol/clientInfo":{name:"dsh-watch",version:"1.0.0"},
         "io.modelcontextprotocol/clientCapabilities":{}
       }})}') || return 1

  local curl_args=(
    --config "$CURL_CONFIG"
    -sS --connect-timeout 10 --max-time 30
    -o "$RPC_RESPONSE" -w '%{http_code}'
    -H "Content-Type: application/json"
    -H "Accept: application/json, text/event-stream"
    -H "MCP-Protocol-Version: $PROTOCOL_VERSION"
    -H "MCP-Method: $method"
    --data-binary "$body"
    "$MCP_ENDPOINT"
  )
  [ -z "$name" ] || curl_args+=(-H "MCP-Name: $name")

  http_code=$(curl "${curl_args[@]}")
  curl_status=$?
  if [ "$http_code" = 400 ]; then
    return 42
  fi
  if [ "$http_code" = 401 ] || [ "$http_code" = 403 ]; then
    return 41
  fi
  if [ "$curl_status" -ne 0 ] || ! [[ "$http_code" =~ ^2 ]]; then
    return 1
  fi
  cat "$RPC_RESPONSE"
}

mcp_call() {
  local tool="$1" args="${2:-}"
  [ -n "$args" ] || args='{}'
  mcp_rpc tools/call \
    "$(jq -nc --arg tool "$tool" --argjson args "$args" '{name:$tool,arguments:$args}')" \
    "$tool"
}

mcp_result() {
  jq -e '
    def tool_error: .result.content[]? | select(.type=="text") | .text | fromjson;
    if .error then error("MCP " + ((.error.code // "?")|tostring) + ": " + (.error.message // "unknown"))
    elif .result.isError then (tool_error) as $e | error("Tool " + ($e.code // "UNKNOWN") + ": " + ($e.message // ""))
    elif .result.structuredContent then .result.structuredContent
    else ((.result.content[]? | select(.type=="text") | .text | fromjson) // .result) end'
}

is_credential_error() {
  printf '%s' "${1:-}" | jq -e '
    .result.isError == true
    and any(.result.content[]?;
      .type == "text" and ((.text | fromjson? | .code) == "CREDENTIAL_INVALID"))
  ' >/dev/null 2>&1
}

tool_error_code() {
  printf '%s' "${1:-}" | jq -r '
    if .result.isError then
      ((.result.content[]? | select(.type=="text") | .text | fromjson? | .code) // "UNKNOWN")
    elif .error then ((.error.code // "UNKNOWN") | tostring)
    else "UNKNOWN" end' 2>/dev/null
}

seen() { grep -Fqx -- "$1" "$SEEN_FILE" 2>/dev/null; }
mark_seen() { printf '%s\n' "$1" >>"$SEEN_FILE" 2>/dev/null || true; }

append_event() {
  local line="$1"
  case "$line" in
    *"$AGENTNET_TOKEN"*)
      log 'ERROR type=queue message=refused_token_leak'
      return 1
      ;;
  esac
  printf '%s\n' "$line" >>"$QUEUE_FILE" || {
    log 'ERROR type=queue message=append_failed'
    return 1
  }
  chmod 600 "$QUEUE_FILE" 2>/dev/null || true
  LAST_EVENT_AT=$(now_iso)
  write_status
}

# wake.queue 固定字段；缺失的定位字段写 null，seq/event_id 保持字符串。
emit_wake() {
  local item="$1"
  local source attention room_id message_id delivery_id sender_id seq event_id key line
  source=$(printf '%s' "$item" | jq -r '.source // ""')
  attention=$(printf '%s' "$item" | jq -r '.attention // "informational"')
  room_id=$(printf '%s' "$item" | jq -r '.room_id // ""')
  message_id=$(printf '%s' "$item" | jq -r '.message_id // ""')
  delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // ""')
  sender_id=$(printf '%s' "$item" | jq -r '.sender_id // ""')
  seq=$(printf '%s' "$item" | jq -r '.seq // "" | tostring')
  event_id=$(printf '%s' "$item" | jq -r '.event_id // "" | tostring')
  [ -n "$event_id" ] || event_id="${source}:${seq}:${delivery_id}:${message_id}"

  key="${source}:${event_id}:${delivery_id}"
  seen "$key" && return 0

  line=$(jq -nc \
    --arg source "$source" \
    --arg attention "$attention" \
    --arg room "$room_id" \
    --arg message "$message_id" \
    --arg delivery "$delivery_id" \
    --arg sender "$sender_id" \
    --arg seq "$seq" \
    --arg event "$event_id" \
    --arg at "$(now_iso)" '{
      source:$source,
      attention:$attention,
      room_id:(if $room == "" then null else $room end),
      message_id:(if $message == "" then null else $message end),
      delivery_id:(if $delivery == "" then null else $delivery end),
      sender_id:(if $sender == "" then null else $sender end),
      seq:$seq,
      event_id:$event,
      at:$at
    }') || return 1

  append_event "$line" || return 1
  mark_seen "$key"
}

# pending_count > 0 时补一条 catchup，逼 Agent 用 network_inbox_list 对账。
# 同一 pending/head 快照 30 秒内只写一次，与触发原因无关，避免 login 与
# frame_truncated 在同一快照上重复写；reason 只用于事件内容与日志。
emit_catchup() {
  local reason="$1" pending="${PENDING_COUNT:-0}" head="${INBOX_HEAD_SEQ:-}"
  local now key line
  case "$pending" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$pending" -gt 0 ] || return 0
  key="${pending}:${head}"
  now=$(date +%s)
  if [ "$key" = "$CATCHUP_LAST_KEY" ] && [ $((now - CATCHUP_LAST_AT)) -lt 30 ]; then
    return 0
  fi
  line=$(jq -nc \
    --arg reason "$reason" \
    --arg pending "$pending" \
    --arg head "$head" \
    --arg at "$(now_iso)" '{
      source:"catchup",
      attention:"action_required",
      room_id:null,
      message_id:null,
      delivery_id:null,
      sender_id:null,
      seq:$head,
      event_id:("catchup:" + $reason + ":" + $pending + ":" + $head),
      at:$at
    }') || return 1
  append_event "$line" || return 1
  CATCHUP_LAST_KEY="$key"
  CATCHUP_LAST_AT="$now"
}

# 直聊/群聊只用于 room.message 过滤；每个房间只查一次 network_room_get。
# 凭据错误返回 41，由调用方在非子 shell 中终止。
room_kind() {
  local room_id="$1" kind raw parsed status
  [ -n "$room_id" ] || { printf 'unknown'; return 1; }
  kind=$(awk -v id="$room_id" '$1 == id { print $2; exit }' "$ROOM_CACHE" 2>/dev/null)
  if [ -n "$kind" ]; then
    printf '%s' "$kind"
    return 0
  fi

  raw=$(mcp_call network_room_get "$(jq -nc --arg room "$room_id" '{room_id:$room}')")
  status=$?
  if [ "$status" -eq 41 ] || is_credential_error "$raw"; then
    printf 'unknown'
    return 41
  fi
  if [ "$status" -eq 42 ]; then
    printf 'unknown'
    return 42
  fi
  if [ "$status" -ne 0 ]; then
    printf 'unknown'
    return 1
  fi
  parsed=$(printf '%s' "$raw" | mcp_result 2>/dev/null) || {
    printf 'unknown'
    return 1
  }
  kind=$(printf '%s' "$parsed" | jq -r '.room.kind // empty' 2>/dev/null)
  case "$kind" in
    direct|group)
      printf '%s %s\n' "$room_id" "$kind" >>"$ROOM_CACHE" 2>/dev/null || true
      ;;
    *)
      kind="unknown"
      ;;
  esac
  printf '%s' "$kind"
}

handle_notification() {
  local json="$1" envelope item source attention room_id kind status more dropped
  envelope=$(printf '%s' "$json" | jq -c '
    select(.method=="notifications/resources/updated")
    | .params._meta["io.agent-network/event"] // empty' 2>/dev/null) || return 0
  [ -n "$envelope" ] || return 0
  LAST_NOTIFICATION_AT=$(now_iso)

  while IFS= read -r item; do
    [ -n "$item" ] || continue
    source=$(printf '%s' "$item" | jq -r '.source // ""')
    attention=$(printf '%s' "$item" | jq -r '.attention // "informational"')

    if [ "$attention" != "action_required" ]; then
      # 只有直聊的普通消息入队；群聊普通消息不是任务。
      [ "$source" = "room.message" ] || continue
      room_id=$(printf '%s' "$item" | jq -r '.room_id // ""')
      [ -n "$room_id" ] || continue
      kind=$(room_kind "$room_id")
      status=$?
      if [ "$status" -eq 41 ]; then
        fatal_credential
      fi
      if [ "$status" -eq 42 ]; then
        fatal_protocol
      fi
      if [ "$kind" != "direct" ]; then
        log "DROP type=group_message room=${room_id}"
        continue
      fi
    fi

    emit_wake "$item" || return 1
  done < <(printf '%s' "$envelope" | jq -c --arg me "$MY_ID" '
    .items[]?
    | select((.source // "") != "session.login")
    | select((.source // "") != "delivery.updated")
    | select((.sender_id // "") != $me)
    | select((.attention == "action_required") or (.source == "room.message"))')

  more=$(printf '%s' "$envelope" | jq -r '.more // false' 2>/dev/null)
  dropped=$(printf '%s' "$envelope" | jq -r '.dropped // 0' 2>/dev/null)
  if [ "$more" = "true" ] || { case "$dropped" in ''|*[!0-9]*) false;; *) [ "$dropped" -gt 0 ];; esac; }; then
    emit_catchup "frame_truncated"
  fi
  write_status
}

handle_ack() {
  local login_raw login login_status code
  STATE="running"
  ACKED="true"
  ACKED_AT=$(date +%s)
  CONNECTED="true"
  write_status

  login_raw=$(mcp_call network_login '{}')
  login_status=$?
  if [ "$login_status" -eq 41 ] || is_credential_error "$login_raw"; then
    fatal_credential
  fi
  if [ "$login_status" -eq 42 ]; then
    fatal_protocol
  fi
  if [ "$login_status" -ne 0 ]; then
    code=$(tool_error_code "$login_raw")
    if [ "$code" = "INVALID_ARGUMENT" ]; then
      fatal_not_agent
    fi
    log 'ERROR type=login message=network_login_failed'
    ACKED="false"
    ONLINE="false"
    write_status
    kill "$CURL_PID" 2>/dev/null || true
    return
  fi

  login=$(printf '%s' "$login_raw" | mcp_result 2>/dev/null) || {
    code=$(tool_error_code "$login_raw")
    if [ "$code" = "CREDENTIAL_INVALID" ]; then
      fatal_credential
    fi
    if [ "$code" = "INVALID_ARGUMENT" ]; then
      fatal_not_agent
    fi
    log 'ERROR type=login message=network_login_rejected'
    ACKED="false"
    ONLINE="false"
    write_status
    kill "$CURL_PID" 2>/dev/null || true
    return
  }

  MY_ID=$(printf '%s' "$login" | jq -r '.actor_id // empty' 2>/dev/null)
  [ -n "$MY_ID" ] || MY_ID="${MY_ID_FROM_ME:-}"
  PENDING_COUNT=$(printf '%s' "$login" | jq -r '.pending_count // 0' 2>/dev/null)
  INBOX_HEAD_SEQ=$(printf '%s' "$login" | jq -r '.inbox_head_seq // "" | tostring' 2>/dev/null)
  ONLINE="true"
  write_status

  if [ "$READY_EMITTED" -eq 0 ]; then
    log "READY actor=$MY_ID pending=$PENDING_COUNT subscription=$SUB_ID"
    READY_EMITTED=1
  else
    log "READY actor=$MY_ID pending=$PENDING_COUNT subscription=$SUB_ID reconnect=1 reason=$LAST_DISCONNECT_REASON"
  fi
  DEGRADED=0
  emit_catchup "login"
}

handle_sse_json() {
  local json="$1" method
  method=$(printf '%s' "$json" | jq -r '.method // empty' 2>/dev/null) || return
  case "$method" in
    notifications/subscriptions/acknowledged)
      [ "$ACKED" = "true" ] || handle_ack
      ;;
    notifications/resources/updated)
      handle_notification "$json"
      ;;
  esac
}

reconnect_delay() {
  local base
  case "$1" in
    1) base=1;; 2) base=2;; 3) base=4;; 4) base=8;; 5) base=16;; *) base=30;;
  esac
  awk -v b="$base" 'BEGIN{srand(); printf "%.1f", b*(0.8+rand()*0.4)}'
}

disconnect_reason() {
  local status="$1"
  if [ "$ACKED" != "true" ]; then
    case "$status" in
      0|137|143) printf 'ack_timeout'; return ;;
    esac
  fi
  case "$status" in
    0) printf 'stream_closed' ;;
    18) printf 'short_read' ;;
    22) printf 'http_error' ;;
    28) printf 'idle_timeout' ;;
    52) printf 'empty_reply' ;;
    55|56) printf 'connection_reset' ;;
    137|143) printf 'terminated' ;;
    *) printf 'curl_%s' "$status" ;;
  esac
}

run_watch() {
  local discover_raw discover_status me_raw me_status me kind
  dependency_check
  validate_token
  validate_url
  ensure_home

  if pid=$(current_pid); then
    if [ "$pid" != "$$" ]; then
      log "ERROR type=daemon message=already_running pid=$pid"
      exit 1
    fi
  fi
  printf '%s\n' "$$" >"$PID_FILE" || {
    log 'ERROR type=environment message=pid_file_failed'
    exit 1
  }
  chmod 600 "$PID_FILE" 2>/dev/null || true

  STATE="starting"
  CONNECTED="false"
  ACKED="false"
  ONLINE="false"
  LAST_ERROR=""
  STARTED_AT=$(now_iso)
  write_status

  trap cleanup EXIT
  trap on_signal INT TERM HUP

  umask 077
  WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsh-watch.XXXXXX") || {
    log 'ERROR type=environment message=workdir_failed'
    exit 1
  }
  CURL_CONFIG="$WORK_DIR/curl.conf"
  RPC_RESPONSE="$WORK_DIR/rpc-response.json"
  SEEN_FILE="$WORK_DIR/seen"
  FIFO="$WORK_DIR/stream.fifo"
  STREAM_ERROR="$WORK_DIR/stream.stderr"
  SUB_BODY="$WORK_DIR/subscription.json"
  ACK_FILE="$WORK_DIR/ack"
  ROOM_CACHE="$WORK_DIR/rooms"
  : >"$SEEN_FILE"
  : >"$ROOM_CACHE"

  {
    printf 'header = "Authorization: Bearer %s"\n' "$(escape_curl_config "$AGENTNET_TOKEN")"
  } >"$CURL_CONFIG"
  chmod 600 "$CURL_CONFIG" "$SEEN_FILE" "$ROOM_CACHE"

  # 不降级：只接受 MCP 2026-07-28。
  discover_raw=$(mcp_rpc server/discover '{}')
  discover_status=$?
  if [ "$discover_status" -eq 41 ] || is_credential_error "$discover_raw"; then
    fatal_credential
  fi
  if [ "$discover_status" -ne 0 ] || ! printf '%s' "$discover_raw" | jq -e \
    --arg version "$PROTOCOL_VERSION" \
    '.result.supportedVersions | index($version) != null' >/dev/null 2>&1; then
    fatal_protocol
  fi

  me_raw=$(mcp_call network_me '{}')
  me_status=$?
  if [ "$me_status" -eq 41 ] || is_credential_error "$me_raw"; then
    fatal_credential
  fi
  if [ "$me_status" -eq 42 ]; then
    fatal_protocol
  fi
  me=$(printf '%s' "$me_raw" | mcp_result 2>/dev/null) || {
    log 'ERROR type=identity message=network_me_failed'
    cleanup
    exit 5
  }
  MY_ID=$(printf '%s' "$me" | jq -r '.actor_id // empty' 2>/dev/null)
  MY_ID_FROM_ME="$MY_ID"
  kind=$(printf '%s' "$me" | jq -r '.kind // empty' 2>/dev/null)
  if [ -z "$MY_ID" ]; then
    log 'ERROR type=identity message=actor_id_missing'
    cleanup
    exit 5
  fi
  if [ "$kind" != "agent" ]; then
    fatal_not_agent
  fi

  while :; do
    GENERATION=$((GENERATION + 1))
    SUB_ID="sub-$(date +%s)-$$-$GENERATION-$RANDOM"
    jq -nc --arg id "$SUB_ID" --arg uri "$STREAM_URI" '{
      jsonrpc:"2.0",id:$id,method:"subscriptions/listen",
      params:{notifications:{resourceSubscriptions:[$uri]},_meta:{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientInfo":{name:"dsh-watch",version:"1.0.0"},
        "io.modelcontextprotocol/clientCapabilities":{}
      }}
    }' >"$SUB_BODY" || exit 1

    rm -f "$FIFO" "$ACK_FILE"
    mkfifo "$FIFO" || exit 1
    : >"$STREAM_ERROR"
    ACKED="false"
    CONNECTED="false"
    ONLINE="false"
    write_status

    curl --config "$CURL_CONFIG" -sS -N --http1.1 --fail-with-body \
      --speed-time "$SSE_IDLE_TIMEOUT_SECONDS" --speed-limit "$SSE_IDLE_SPEED_LIMIT" \
      "$MCP_ENDPOINT" \
      -H "Content-Type: application/json" \
      -H "Accept: text/event-stream" \
      -H "MCP-Protocol-Version: $PROTOCOL_VERSION" \
      -H "MCP-Method: subscriptions/listen" \
      --data-binary "@$SUB_BODY" >"$FIFO" 2>"$STREAM_ERROR" &
    CURL_PID=$!
    CONNECTED="true"
    write_status

    :
    current_curl_pid="$CURL_PID"
    (
      sleep "$ACK_TIMEOUT_SECONDS"
      [ -f "$ACK_FILE" ] || kill "$current_curl_pid" 2>/dev/null || true
    ) >/dev/null 2>&1 &
    WATCHDOG_PID=$!

    sse_data=""
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      if [ -z "$line" ]; then
        if [ -n "$sse_data" ]; then
          handle_sse_json "$sse_data"
          sse_data=""
        fi
        continue
      fi
      case "$line" in
        data:*)
          fragment=${line#data:}
          fragment=${fragment# }
          if [ -n "$sse_data" ]; then
            sse_data="$sse_data
$fragment"
          else
            sse_data="$fragment"
          fi
          ;;
      esac
    done <"$FIFO"
    [ -z "$sse_data" ] || handle_sse_json "$sse_data"

    wait "$CURL_PID" 2>/dev/null
    curl_status=$?
    CURL_PID=""
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    WATCHDOG_PID=""
    CONNECTED="false"
    ACKED="false"
    ONLINE="false"
    write_status

    if grep -Eq '(^|[^0-9])(401|403)([^0-9]|$)' "$STREAM_ERROR"; then
      fatal_credential
    fi
    if grep -Eq '(^|[^0-9])400([^0-9]|$)' "$STREAM_ERROR"; then
      fatal_protocol
    fi

    now=$(date +%s)
    reason=$(disconnect_reason "$curl_status")
    LAST_DISCONNECT_REASON="$reason"
    if [ "$ACKED_AT" -ne 0 ] && [ $((now - ACKED_AT)) -ge 30 ]; then
      RECONNECT_ATTEMPT=0
      FAIL_STARTED_AT=0
      DEGRADED=0
    fi
    RECONNECT_ATTEMPT=$((RECONNECT_ATTEMPT + 1))
    RECONNECTS=$((RECONNECTS + 1))
    [ "$FAIL_STARTED_AT" -ne 0 ] || FAIL_STARTED_AT="$now"
    delay=$(reconnect_delay "$RECONNECT_ATTEMPT")
    log "RECONNECTING reason=$reason status=$curl_status attempt=$RECONNECT_ATTEMPT delay=$delay"
    if [ "$DEGRADED" -eq 0 ] && {
      [ "$RECONNECT_ATTEMPT" -ge 5 ] || [ $((now - FAIL_STARTED_AT)) -ge 60 ];
    }; then
      log "DEGRADED attempts=$RECONNECT_ATTEMPT last_reason=$reason"
      DEGRADED=1
    fi
    write_status
    sleep "$delay"
  done
}

show_status() {
  local pid state running_json stale_json status_json
  if pid=$(current_pid); then
    running_json="true"
  else
    running_json="false"
    pid=""
  fi

  status_json='{}'
  if [ -f "$STATUS_FILE" ] && jq -e . "$STATUS_FILE" >/dev/null 2>&1; then
    status_json=$(jq -c . "$STATUS_FILE" 2>/dev/null) || status_json='{}'
    state=$(jq -r '.state // "stopped"' "$STATUS_FILE" 2>/dev/null)
    stale_json="false"
    if [ "$running_json" = "false" ] && [ "$state" = "running" ]; then
      state="stopped"
      stale_json="true"
    fi
  else
    state="stopped"
    [ "$running_json" = "true" ] && state="starting"
    stale_json="false"
  fi

  jq -nc \
    --argjson running "$running_json" \
    --arg home "$WEBBOTS_HOME" \
    --arg pid "$pid" \
    --arg state "$state" \
    --argjson stale "$stale_json" \
    --argjson status "$status_json" \
    --arg checkedAt "$(now_iso)" '
    {running:$running, stale:$stale, pid:(if $pid == "" then null else ($pid | tonumber? // $pid) end),
     state:$state, home:$home, checkedAt:$checkedAt,
     connected:false, acked:false, online:false, pending_count:0,
     lastEventAt:null, lastNotificationAt:null, lastError:null, reconnects:0,
     startedAt:null, updatedAt:null}
    + ($status | {connected,acked,online,pending_count,lastEventAt,lastNotificationAt,lastError,reconnects,startedAt,updatedAt})'
  if [ "$running_json" = "true" ]; then
    return 0
  fi
  return 3
}

start_daemon() {
  local pid
  dependency_check
  validate_token
  validate_url
  ensure_home
  if pid=$(current_pid); then
    log "ERROR type=daemon message=already_running pid=$pid"
    exit 1
  fi
  rm -f "$PID_FILE"
  nohup bash "$SELF" run >>"$LOG_FILE" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE" 2>/dev/null || true
  chmod 600 "$PID_FILE" 2>/dev/null || true
  sleep 1
  if pid_running "$pid"; then
    printf 'STARTED pid=%s home=%s\n' "$pid" "$WEBBOTS_HOME"
    return 0
  fi
  log 'ERROR type=daemon message=start_failed'
  [ -f "$LOG_FILE" ] && tail -n 20 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  exit 1
}

stop_daemon() {
  local pid i
  if ! pid=$(current_pid); then
    rm -f "$PID_FILE"
    printf 'NOT_RUNNING home=%s\n' "$WEBBOTS_HOME"
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 100); do
    pid_running "$pid" || break
    sleep 0.1
  done
  if pid_running "$pid"; then
    log "WARN type=daemon message=force_kill pid=$pid"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.2
  fi
  rm -f "$PID_FILE"
  if pid_running "$pid"; then
    log "ERROR type=daemon message=stop_failed pid=$pid"
    exit 1
  fi
  printf 'STOPPED pid=%s home=%s\n' "$pid" "$WEBBOTS_HOME"
}

wait_command() {
  local timeout="${1:-0}" start_ts total cursor tmp begin
  case "$timeout" in
    ''|*[!0-9]*)
      log 'ERROR type=configuration message=invalid_timeout'
      return 2
      ;;
  esac
  ensure_home

  if [ -f "$CURSOR_FILE" ]; then
    cursor=$(cat "$CURSOR_FILE" 2>/dev/null)
    case "$cursor" in
      ''|*[!0-9]*) cursor=0 ;;
    esac
  else
    cursor=$(wc -l <"$QUEUE_FILE" 2>/dev/null | tr -d '[:space:]')
    case "$cursor" in
      ''|*[!0-9]*) cursor=0 ;;
    esac
  fi
  # 首次调用把当前 EOF 持久化；后续调用从该游标继续。
  tmp="${CURSOR_FILE}.tmp.$$"
  printf '%s\n' "$cursor" >"$tmp" 2>/dev/null && mv "$tmp" "$CURSOR_FILE" 2>/dev/null || true
  chmod 600 "$CURSOR_FILE" 2>/dev/null || true

  start_ts=$(date +%s)
  while :; do
    total=$(wc -l <"$QUEUE_FILE" 2>/dev/null | tr -d '[:space:]')
    case "$total" in
      ''|*[!0-9]*) total=0 ;;
    esac
    # 文件被 truncate 时游标可能大于当前行数，回到 0 重读。
    if [ "$total" -lt "$cursor" ]; then
      cursor=0
    fi
    if [ "$total" -gt "$cursor" ]; then
      begin=$((cursor + 1))
      tail -n "+$begin" "$QUEUE_FILE" | head -n "$((total - cursor))"
      cursor=$total
      tmp="${CURSOR_FILE}.tmp.$$"
      printf '%s\n' "$cursor" >"$tmp" 2>/dev/null && mv "$tmp" "$CURSOR_FILE" 2>/dev/null || true
      chmod 600 "$CURSOR_FILE" 2>/dev/null || true
      return 0
    fi
    if [ "$timeout" -gt 0 ] && [ $(( $(date +%s) - start_ts )) -ge "$timeout" ]; then
      return 124
    fi
    sleep 1
  done
}

main() {
  local command_name="${1:-run}"
  case "$command_name" in
    run) run_watch ;;
    start) start_daemon ;;
    stop) stop_daemon ;;
    status) show_status ;;
    logs)
      shift || true
      ensure_home
      tail -n "${1:-50}" -f "$LOG_FILE"
      ;;
    wait)
      shift || true
      wait_command "${1:-0}"
      ;;
    -h|--help|help) usage ;;
    *)
      log "ERROR type=configuration message=unknown_command command=$command_name"
      usage
      exit 2
      ;;
  esac
}

main "$@"
