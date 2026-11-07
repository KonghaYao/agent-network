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

tool_error_code() {
  jq -r '
    if .result.isError then
      ((.result.content[]? | select(.type=="text") | .text | fromjson? | .code) // "UNKNOWN")
    elif .error then ((.error.code // "UNKNOWN") | tostring)
    else "UNKNOWN" end'
}

tool_error_message() {
  jq -r '
    if .result.isError then
      ((.result.content[]? | select(.type=="text") | .text | fromjson? | .message) // "")
    elif .error then (.error.message // "")
    else "" end'
}

# 领取投递。成功输出 {ok:true,...}；业务失败输出 {ok:false,kind:...}。
# 只有传输/凭据错误返回非零，由调用方决定是否终止监听。
claim_delivery() {
  local delivery_id="$1" raw status parsed code message page page_status own held
  raw=$(mcp_call network_delivery_claim \
    "$(jq -nc --arg request_id "watch-claim-$(date +%s)-$$-$RANDOM" --arg delivery "$delivery_id" \
      '{request_id:$request_id,delivery_id:$delivery}')")
  status=$?
  case "$status" in
    0) ;;
    41|42) return "$status" ;;
    *) return 1 ;;
  esac

  parsed=$(printf '%s' "$raw" | mcp_result 2>/dev/null)
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s' "$parsed" | jq -c '{ok:true,delivery_id,state,attempt,claim_id,claimed_at}'
    return 0
  fi
  if printf '%s' "$raw" | jq -e '
    .result.isError == true
    and any(.result.content[]?;
      .type == "text" and ((.text | fromjson? | .code) == "CREDENTIAL_INVALID"))
  ' >/dev/null 2>&1; then
    return 41
  fi

  code=$(printf '%s' "$raw" | tool_error_code)
  message=$(printf '%s' "$raw" | tool_error_message)
  if [ "$code" != "CLAIM_CONFLICT" ]; then
    jq -nc --arg code "$code" --arg message "$message" --arg delivery "$delivery_id" \
      '{ok:false,kind:"failed",code:$code,message:$message,delivery_id:$delivery}'
    return 0
  fi

  # 冲突时只读一次 claimed inbox，区分“自己已有 claim”和“别人已领取”。
  page=$(mcp_call_result network_inbox_list '{"state":"claimed","limit":50}')
  page_status=$?
  case "$page_status" in
    41|42) return "$page_status" ;;
    0) ;;
    *)
      case "$message" in
        *"当前已有领取中的工作"*)
          jq -nc --arg delivery "$delivery_id" --arg message "$message" \
            '{ok:false,kind:"deferred",code:"CLAIM_CONFLICT",message:$message,delivery_id:$delivery}'
          ;;
        *)
          jq -nc --arg delivery "$delivery_id" --arg message "$message" \
            '{ok:false,kind:"conflict",code:"CLAIM_CONFLICT",message:$message,delivery_id:$delivery}'
          ;;
      esac
      return 0
      ;;
  esac

  own=$(printf '%s' "$page" | jq -c --arg delivery "$delivery_id" \
    '[.items[]? | select(.delivery_id == $delivery)][0] // empty')
  if [ -n "$own" ]; then
    printf '%s' "$own" | jq -c '{ok:true,delivery_id,state,attempt,claim_id,claimed_at}'
    return 0
  fi
  held=$(printf '%s' "$page" | jq -r '.claimed_delivery_id // empty')
  case "$message" in
    *"当前已有领取中的工作"*)
      jq -nc --arg delivery "$delivery_id" --arg held "$held" --arg message "$message" \
        '{ok:false,kind:"deferred",code:"CLAIM_CONFLICT",message:$message,delivery_id:$delivery}
         + (if $held == "" then {} else {claimed_delivery_id:$held} end)'
      ;;
    *)
      jq -nc --arg delivery "$delivery_id" --arg message "$message" \
        '{ok:false,kind:"conflict",code:"CLAIM_CONFLICT",message:$message,delivery_id:$delivery}'
      ;;
  esac
  return 0
}

claim_notice() {
  local item="$1" result="$2" source="$3"
  local kind type claim_state hint code reason held
  kind=$(printf '%s' "$result" | jq -r '.kind // "failed"')
  code=$(printf '%s' "$result" | jq -r '.code // "UNKNOWN"')
  reason=$(printf '%s' "$result" | jq -r '.message // ""')
  held=$(printf '%s' "$result" | jq -r '.claimed_delivery_id // empty')
  case "$kind" in
    deferred)
      type="delivery_deferred"
      claim_state="deferred"
      hint="先 complete/fail 当前 claim，再 network_inbox_list 核对并 claim 这条；watcher 不轮询，需手动 claim 或重连快照重试"
      ;;
    conflict)
      type="delivery_conflict"
      claim_state="conflict"
      hint="跳过，不要处理；如需重新处理，由接收者用 network_delivery_retry 放回 pending"
      ;;
    *)
      type="delivery_claim_failed"
      claim_state="failed"
      hint="不要处理；按 code 修复或等待人工核对后重试"
      ;;
  esac
  printf '%s' "$item" | jq -c \
    --arg source "$source" --arg type "$type" --arg claim_state "$claim_state" \
    --arg hint "$hint" --arg code "$code" --arg reason "$reason" --arg held "$held" '{
      type:$type,
      source:$source,
      delivery_id,
      room_id:(.room_id // .message.room_id // ""),
      message_id:(.message_id // .message.message_id // ""),
      sender_id:(.sender_id // .message.sender_id // ""),
      event_id:(.event_id // ""),
      seq:(.seq // .created_seq // ""),
      attempt:(.attempt // 0),
      code:$code,
      reason:$reason,
      claim_state:$claim_state,
      claimed_delivery_id:(if $held == "" then null else $held end),
      hint:$hint
    }'
}

seen() { grep -Fqx -- "$1" "$SEEN_FILE" 2>/dev/null; }
mark_seen() { printf '%s\n' "$1" >>"$SEEN_FILE"; }

pending_delivery_map() {
  local inbox
  inbox=$(mcp_call_result network_inbox_list '{"state":"pending","limit":50}') || return 2
  printf '%s' "$inbox" | jq -r --arg me "$MY_ID" '.items[]? | select((.message.sender_id // "") != $me) | "\(.delivery_id):\(.attempt)"'
}

emit_pending_snapshot() {
  local inbox status item delivery_id delivery_attempt key claim alert
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
    claim=$(claim_delivery "$delivery_id")
    status=$?
    case "$status" in
      0) ;;
      41) FATAL=1; return 41 ;;
      42) return 42 ;;
      *) return 1 ;;
    esac
    if [ "$(printf '%s' "$claim" | jq -r '.ok // false')" = true ]; then
      alert=$(printf '%s' "$item" | jq -c --arg source "inbox.snapshot" --argjson claim "$claim" '{
        type:"delivery",source:$source,delivery_id,room_id,message_id,
        sender_id:(.message.sender_id // ""),
        seq:(.seq // .created_seq // ""),
        created_seq,
        attempt:$claim.attempt,claim_id:$claim.claim_id,claimed_at:$claim.claimed_at,
        auto_claimed:true,claim_state:"claimed",
        claim:{delivery_id,attempt:$claim.attempt,claim_id:$claim.claim_id}
      }')
    else
      alert=$(claim_notice "$item" "$claim" "inbox.snapshot") || return 1
    fi
    printf 'ALERT %s\n' "$alert"
    # deferred 不写永久 seen：当前 claim 结束后由重连快照重新 claim；watcher 不轮询。
    [ "$(printf '%s' "$claim" | jq -r '.kind // empty')" = "deferred" ] || mark_seen "$key"
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
  local json="$1" envelope item event_id fallback key claim status alert more dropped delivery_id pending_map pending_status pending_attempt
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
    if [ -n "$delivery_id" ] && [ "$(printf '%s' "$item" | jq -r '.source // empty')" = "delivery.reminder" ]; then
      # 提醒不是新待办；直接唤醒 recipient 去 report 或 complete/fail/retry。
      key="reminder:$delivery_id:${event_id:-$fallback}"
      seen "$key" && continue
      alert=$(printf '%s' "$item" | jq -c '{
        type:"reminder",source:"stream",delivery_id,room_id,message_id,attempt,progress_at,
        event_id,seq,created_at,
        hint:"先调用 network_delivery_report 报告当前阶段进度；完成则 complete，阻塞则 fail 或由接收者 retry"
      }')
      printf 'ALERT %s\n' "$alert"
      mark_seen "$key"
      continue
    fi
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

    # 先 claim，再发可处理 ALERT；冲突只发明确的不可处理通知。
    claim=$(claim_delivery "$delivery_id")
    status=$?
    case "$status" in
      0) ;;
      41) FATAL=1; kill "$CURL_PID" 2>/dev/null || true; return 41 ;;
      42) return 42 ;;
      *) return 1 ;;
    esac
    if [ "$(printf '%s' "$claim" | jq -r '.ok // false')" = true ]; then
      alert=$(printf '%s' "$item" | jq -c --argjson claim "$claim" '{
        type:"delivery",source,event_id,delivery_id,room_id,message_id,
        sender_id,seq,created_at,
        attempt:$claim.attempt,claim_id:$claim.claim_id,claimed_at:$claim.claimed_at,
        auto_claimed:true,claim_state:"claimed",
        claim:{delivery_id,attempt:$claim.attempt,claim_id:$claim.claim_id}
      }')
    else
      alert=$(claim_notice "$item" "$claim" "$(printf '%s' "$item" | jq -r '.source // "stream"')") || return 1
    fi
    printf 'ALERT %s\n' "$alert"
    # deferred 不写永久 seen：后续事件或重连快照可重新 claim。
    [ "$(printf '%s' "$claim" | jq -r '.kind // empty')" = "deferred" ] || mark_seen "$key"
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
