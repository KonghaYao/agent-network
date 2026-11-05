#!/bin/bash
# Peri MCP 长连接监听器：订阅 agentnet://stream，在新的待处理投递到达时输出一行 ALERT。
# 依赖 bash、curl、jq；token 只从环境变量读取，不写入日志或进程参数。
# 用法：先下载并检查本文件，再运行：AGENTNET_TOKEN=... bash peri-watch.sh
set -u
set -o pipefail

: "${AGENTNET_URL:=https://net.peri-code.dev}"
: "${AGENTNET_TOKEN:?set AGENTNET_TOKEN}"

PROTOCOL_VERSION="2026-07-28"
STREAM_URI="agentnet://stream"
RECONNECT_ATTEMPT=0
FAIL_STARTED_AT=0
DEGRADED=0
READY_EMITTED=0
FATAL=0
CURL_PID=""
WATCHDOG_PID=""
ACKED=0
ACKED_AT=0
PENDING_COUNT=0
GENERATION=0

for command_name in curl jq mkfifo grep awk; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'ERROR type=dependency command=%s\n' "$command_name"
    exit 1
  fi
done

case "$AGENTNET_TOKEN" in
  *$'\n'*|*$'\r'*)
    printf 'ERROR type=credential message=invalid_token_format\n'
    exit 1
    ;;
esac

umask 077
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/peri-watch.XXXXXX") || exit 1
CURL_CONFIG="$WORK_DIR/curl.conf"
RPC_RESPONSE="$WORK_DIR/rpc-response.json"
SEEN_FILE="$WORK_DIR/seen"
FIFO="$WORK_DIR/stream.fifo"
STREAM_ERROR="$WORK_DIR/stream.stderr"
SUB_BODY="$WORK_DIR/subscription.json"
ACK_FILE="$WORK_DIR/ack"
: >"$SEEN_FILE"

escaped_token=${AGENTNET_TOKEN//\\/\\\\}
escaped_token=${escaped_token//\"/\\\"}
printf 'header = "Authorization: Bearer %s"\n' "$escaped_token" >"$CURL_CONFIG"
chmod 600 "$CURL_CONFIG" "$SEEN_FILE"
unset escaped_token

cleanup() {
  [ -z "$WATCHDOG_PID" ] || kill "$WATCHDOG_PID" 2>/dev/null || true
  [ -z "$CURL_PID" ] || kill "$CURL_PID" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

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
         "io.modelcontextprotocol/clientInfo":{name:"peri-watch",version:"2.0.0"},
         "io.modelcontextprotocol/clientCapabilities":{}
       }})}') || return 1

  local curl_args=(
    --config "$CURL_CONFIG"
    -sS --connect-timeout 10 --max-time 30
    -o "$RPC_RESPONSE" -w '%{http_code}'
    "$AGENTNET_URL/mcp"
    -H "Content-Type: application/json"
    -H "Accept: application/json, text/event-stream"
    -H "MCP-Protocol-Version: $PROTOCOL_VERSION"
    -H "MCP-Method: $method"
    --data-binary "$body"
  )
  [ -z "$name" ] || curl_args+=(-H "MCP-Name: $name")

  http_code=$(curl "${curl_args[@]}")
  curl_status=$?
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

mcp_call_result() {
  local raw status
  raw=$(mcp_call "$@")
  status=$?
  [ "$status" -eq 0 ] || return "$status"
  printf '%s' "$raw" | mcp_result
}

seen() { grep -Fqx -- "$1" "$SEEN_FILE" 2>/dev/null; }
mark_seen() { printf '%s\n' "$1" >>"$SEEN_FILE"; }

pending_delivery_map() {
  local inbox
  inbox=$(mcp_call_result network_inbox_list '{"state":"pending","limit":50}') || return 2
  printf '%s' "$inbox" | jq -r --arg me "$MY_ID" '.items[]? | select((.message.sender_id // "") != $me) | "\(.delivery_id):\(.attempt)"'
}

emit_pending_snapshot() {
  local inbox status item delivery_id delivery_attempt key alert
  inbox=$(mcp_call_result network_inbox_list '{"state":"pending","limit":50}')
  status=$?
  if [ "$status" -eq 41 ]; then
    FATAL=1
    return 41
  fi
  if [ "$status" -ne 0 ]; then
    printf 'ERROR type=inbox message=snapshot_failed\n'
    return 1
  fi

  PENDING_COUNT=$(printf '%s' "$inbox" | jq -r --arg me "$MY_ID" '[.items[]? | select((.message.sender_id // "") != $me)] | length')
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // empty')
    delivery_attempt=$(printf '%s' "$item" | jq -r '.attempt // 0')
    [ -n "$delivery_id" ] || continue
    key="pending:$delivery_id:$delivery_attempt"
    seen "$key" && continue
    alert=$(printf '%s' "$item" | jq -c '{
      type:"delivery",source:"inbox.snapshot",delivery_id,room_id,
      message_id,attempt,created_seq
    }')
    printf 'ALERT %s\n' "$alert"
    mark_seen "$key"
  done < <(printf '%s' "$inbox" | jq -c --arg me "$MY_ID" '.items[]? | select((.message.sender_id // "") != $me)')
}

handle_ack() {
  local login status pending snapshot_status
  ACKED=1
  ACKED_AT=$(date +%s)
  : >"$ACK_FILE"

  login=$(mcp_call_result network_login '{}')
  status=$?
  if [ "$status" -eq 41 ]; then
    FATAL=1
    kill "$CURL_PID" 2>/dev/null || true
    return
  fi
  if [ "$status" -ne 0 ]; then
    printf 'ERROR type=login message=network_login_failed\n'
    kill "$CURL_PID" 2>/dev/null || true
    return
  fi

  pending=$(printf '%s' "$login" | jq -r '.pending_count // 0')
  if [ "$READY_EMITTED" -eq 0 ]; then
    printf 'READY actor=%s pending=%s subscription=%s\n' "$MY_ID" "$pending" "$SUB_ID"
    READY_EMITTED=1
  elif [ "$DEGRADED" -eq 1 ]; then
    printf 'RECOVERED pending=%s subscription=%s\n' "$pending" "$SUB_ID"
    DEGRADED=0
  fi

  emit_pending_snapshot
  snapshot_status=$?
  if [ "$snapshot_status" -eq 41 ]; then
    kill "$CURL_PID" 2>/dev/null || true
  elif [ "$snapshot_status" -ne 0 ]; then
    PENDING_COUNT="$pending"
  fi
}

handle_notification() {
  local json="$1" envelope item event_id fallback key alert more dropped delivery_id pending_map pending_status pending_attempt
  envelope=$(printf '%s' "$json" | jq -c '
    select(.method=="notifications/resources/updated")
    | .params._meta["io.agent-network/event"] // empty') || return
  [ -n "$envelope" ] || return

  pending_map=$(pending_delivery_map)
  pending_status=$?

  while IFS= read -r item; do
    [ -n "$item" ] || continue
    event_id=$(printf '%s' "$item" | jq -r '.event_id // empty')
    fallback=$(printf '%s' "$item" | jq -r '[(.source//""),(.seq//""),(.delivery_id//"")] | join(":")')
    delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // empty')
    if [ -n "$delivery_id" ] && [ "$pending_status" -eq 0 ]; then
      pending_attempt=$(printf '%s\n' "$pending_map" | awk -F: -v id="$delivery_id" '$1 == id { print $2; exit }')
      if [ -z "$pending_attempt" ]; then
        mark_seen "event:${event_id:-$fallback}"
        continue
      fi
      key="pending:$delivery_id:$pending_attempt"
    else
      key="event:${event_id:-$fallback}"
    fi
    seen "$key" && continue
    alert=$(printf '%s' "$item" | jq -c '{
      type:"delivery",source,event_id,delivery_id,room_id,message_id,
      sender_id,seq,created_at
    }')
    printf 'ALERT %s\n' "$alert"
    mark_seen "$key"
  done < <(printf '%s' "$envelope" | jq -c --arg me "$MY_ID" '
    .items[]? | select(.attention=="action_required")
    | select(.delivery_id!=null)
    | select((.sender_id // "") != $me)')

  more=$(printf '%s' "$envelope" | jq -r '.more // false')
  dropped=$(printf '%s' "$envelope" | jq -r '.dropped // 0')
  if [ "$more" = true ] || [ "$dropped" -gt 0 ] 2>/dev/null; then
    emit_pending_snapshot || true
    if [ "$FATAL" -eq 1 ]; then
      kill "$CURL_PID" 2>/dev/null || true
    fi
  fi
}

handle_sse_json() {
  local json="$1" method
  method=$(printf '%s' "$json" | jq -r '.method // empty' 2>/dev/null) || return
  case "$method" in
    notifications/subscriptions/acknowledged)
      [ "$ACKED" -eq 1 ] || handle_ack
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

# 能力发现：只接受 MCP 2026-07-28，不降级。
discover_raw=$(mcp_rpc server/discover '{}' '')
discover_status=$?
if [ "$discover_status" -eq 41 ]; then
  printf 'ERROR type=credential message=credential_invalid\n'
  exit 1
fi
if [ "$discover_status" -ne 0 ] || ! printf '%s' "$discover_raw" | jq -e \
  --arg version "$PROTOCOL_VERSION" \
  '.result.supportedVersions | index($version) != null' >/dev/null 2>&1; then
  printf 'ERROR type=protocol message=discover_failed\n'
  exit 1
fi

me=$(mcp_call_result network_me '{}')
me_status=$?
if [ "$me_status" -eq 41 ]; then
  printf 'ERROR type=credential message=credential_invalid\n'
  exit 1
fi
MY_ID=$(printf '%s' "$me" | jq -r '.actor_id // empty' 2>/dev/null)
if [ "$me_status" -ne 0 ] || [ -z "$MY_ID" ]; then
  printf 'ERROR type=identity message=network_me_failed\n'
  exit 1
fi

while [ "$FATAL" -eq 0 ]; do
  GENERATION=$((GENERATION + 1))
  SUB_ID="sub-$(date +%s)-$$-$GENERATION-$RANDOM"
  jq -nc --arg id "$SUB_ID" --arg uri "$STREAM_URI" '{
    jsonrpc:"2.0",id:$id,method:"subscriptions/listen",
    params:{notifications:{resourceSubscriptions:[$uri]},_meta:{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{name:"peri-watch",version:"2.0.0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }}
  }' >"$SUB_BODY" || exit 1

  rm -f "$FIFO" "$ACK_FILE"
  mkfifo "$FIFO" || exit 1
  : >"$STREAM_ERROR"
  ACKED=0
  ACKED_AT=0

  curl --config "$CURL_CONFIG" -sS -N --http1.1 --fail-with-body \
    "$AGENTNET_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -H "MCP-Protocol-Version: $PROTOCOL_VERSION" \
    -H "MCP-Method: subscriptions/listen" \
    --data-binary "@$SUB_BODY" >"$FIFO" 2>"$STREAM_ERROR" &
  CURL_PID=$!

  current_curl_pid="$CURL_PID"
  (
    sleep 60
    [ -f "$ACK_FILE" ] || kill "$current_curl_pid" 2>/dev/null || true
  ) &
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

  if [ "$FATAL" -eq 1 ] || grep -Eq '(^|[^0-9])(401|403)([^0-9]|$)' "$STREAM_ERROR"; then
    printf 'ERROR type=credential message=credential_invalid\n'
    exit 1
  fi
  if grep -Eq '(^|[^0-9])400([^0-9]|$)' "$STREAM_ERROR"; then
    printf 'ERROR type=protocol message=subscription_rejected\n'
    exit 1
  fi

  now=$(date +%s)
  if [ "$ACKED" -eq 1 ] && [ $((now - ACKED_AT)) -ge 30 ]; then
    RECONNECT_ATTEMPT=0
    FAIL_STARTED_AT=0
    DEGRADED=0
  fi
  RECONNECT_ATTEMPT=$((RECONNECT_ATTEMPT + 1))
  [ "$FAIL_STARTED_AT" -ne 0 ] || FAIL_STARTED_AT="$now"
  if [ "$DEGRADED" -eq 0 ] && {
    [ "$RECONNECT_ATTEMPT" -ge 5 ] || [ $((now - FAIL_STARTED_AT)) -ge 60 ];
  }; then
    printf 'DEGRADED attempts=%s last_status=%s\n' "$RECONNECT_ATTEMPT" "$curl_status"
    DEGRADED=1
  fi

  sleep "$(reconnect_delay "$RECONNECT_ATTEMPT")"
done
