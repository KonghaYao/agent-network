#!/bin/bash
# Claude Code 会话级监听器：持续等待需要处理的投递，每条投递输出一行紧凑 JSON。
# 由 Claude Code 的 Monitor 工具承载；脚本自动 claim 后每行 stdout 事件唤醒当前会话，主会话读取/回复/complete。
# stdout 只输出事件信封，READY、重连与诊断全部写 stderr；token、preview 不进入任何输出。
# 成功 claim 的 delivery 事件直接携带正文前 BODY_PREVIEW_CHARS 个字符（body/body_bytes/body_truncated），
# 完整正文在 0600 的 event_file；截断按 Unicode 码点处理，不会产生非法 UTF-8。正文不写入日志或 status。
# 依赖 bash、curl、jq、mkfifo。
# 用法：curl -fsSL https://net.peri-code.dev/skills/claude-watch.sh | AGENTNET_TOKEN='<token>' bash
set -u
set -o pipefail

: "${AGENTNET_URL:=https://net.peri-code.dev}"
: "${AGENTNET_TOKEN:?set AGENTNET_TOKEN}"

PROTOCOL_VERSION="2026-07-28"
STREAM_URI="agentnet://stream"
# stdout 的 delivery 事件最多携带的正文码点数；完整正文始终保存在 event_file。
BODY_PREVIEW_CHARS=4000
ACK_TIMEOUT_SECONDS=60
SSE_IDLE_TIMEOUT_SECONDS=15
SSE_IDLE_SPEED_LIMIT=1
LAST_DISCONNECT_REASON="connection_closed"
RECONNECT_ATTEMPT=0
FAIL_STARTED_AT=0
DEGRADED=0
READY_EMITTED=0
CURL_PID=""
WATCHDOG_PID=""
ACKED=0
ACKED_AT=0
GENERATION=0
SUB_ID=""

log() { printf '%s\n' "$*" >&2; }

for command_name in curl jq mkfifo grep awk; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    log "ERROR type=dependency command=$command_name"
    exit 1
  fi
done

case "$AGENTNET_TOKEN" in
  *$'\n'*|*$'\r'*)
    log 'ERROR type=credential message=invalid_token_format'
    exit 1
    ;;
esac

case "$AGENTNET_URL" in
  http://*|https://*) ;;
  *)
    log 'ERROR type=configuration message=invalid_agentnet_url'
    exit 1
    ;;
esac
MCP_ENDPOINT="${AGENTNET_URL%/}/mcp"

umask 077
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/claude-watch.XXXXXX") || {
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
EVENT_DIR="$WORK_DIR/events"
mkdir -m 700 "$EVENT_DIR" || {
  log 'ERROR type=environment message=event_dir_failed'
  exit 1
}
: >"$SEEN_FILE"

escape_curl_config() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

{
  printf 'header = "Authorization: Bearer %s"\n' "$(escape_curl_config "$AGENTNET_TOKEN")"
} >"$CURL_CONFIG"
chmod 600 "$CURL_CONFIG" "$SEEN_FILE"

cleanup() {
  [ -z "$WATCHDOG_PID" ] || kill "$WATCHDOG_PID" 2>/dev/null || true
  [ -z "$CURL_PID" ] || kill "$CURL_PID" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

fatal_credential() {
  log 'ERROR type=credential message=credential_invalid'
  exit 1
}

fatal_protocol() {
  log 'ERROR type=protocol message=request_rejected'
  exit 1
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
         "io.modelcontextprotocol/clientInfo":{name:"claude-watch",version:"1.1.0"},
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

mcp_call_result() {
  local raw status parsed
  raw=$(mcp_call "$@")
  status=$?
  [ "$status" -eq 0 ] || return "$status"
  parsed=$(printf '%s' "$raw" | mcp_result 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    if printf '%s' "$raw" | jq -e '
      .result.isError == true
      and any(.result.content[]?;
        .type == "text" and ((.text | fromjson? | .code) == "CREDENTIAL_INVALID"))
    ' >/dev/null 2>&1; then
      return 41
    fi
    return 1
  fi
  printf '%s' "$parsed"
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

  # CLAIM_CONFLICT 可能来自“自己已有另一条 claimed”，也可能来自“别人已领取”。
  # 只在冲突时读一次 claimed inbox，不轮询；据此区分并复用自己已有的 claim。
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
mark_seen() { printf '%s\n' "$1" >>"$SEEN_FILE" 2>/dev/null || true; }

write_event_file() {
  local item="$1" claim="$2" source="$3"
  local delivery_id message_id cursor="" result status eof next_cursor args
  local body_tmp event_tmp event_file
  delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // empty')
  message_id=$(printf '%s' "$item" | jq -r '.message_id // .message.message_id // empty')
  case "$delivery_id" in
    ''|*[!A-Za-z0-9_-]*)
      log 'ERROR type=format message=invalid_delivery_reference'
      return 1
      ;;
  esac
  case "$message_id" in
    ''|*[!A-Za-z0-9_-]*)
      log 'ERROR type=format message=invalid_message_reference'
      return 1
      ;;
  esac

  body_tmp="$EVENT_DIR/.body-$delivery_id-$$-$RANDOM"
  event_tmp="$EVENT_DIR/.event-$delivery_id-$$-$RANDOM"
  event_file="$EVENT_DIR/$delivery_id.json"
  : >"$body_tmp" || return 1
  chmod 600 "$body_tmp"

  while :; do
    args=$(jq -nc --arg message_id "$message_id" --arg cursor "$cursor" '
      {message_id:$message_id}
      + (if $cursor == "" then {} else {chunk_cursor:$cursor} end)') || {
      rm -f "$body_tmp" "$event_tmp"
      return 1
    }
    result=$(mcp_call_result network_message_read "$args")
    status=$?
    case "$status" in
      0) ;;
      41) rm -f "$body_tmp" "$event_tmp"; fatal_credential ;;
      42) rm -f "$body_tmp" "$event_tmp"; fatal_protocol ;;
      *)
        rm -f "$body_tmp" "$event_tmp"
        log "ERROR type=message message=read_failed delivery_id=$delivery_id"
        return 1
        ;;
    esac

    printf '%s' "$result" | jq -rj '.chunk // ""' >>"$body_tmp" || {
      rm -f "$body_tmp" "$event_tmp"
      log "ERROR type=message message=chunk_decode_failed delivery_id=$delivery_id"
      return 1
    }
    eof=$(printf '%s' "$result" | jq -r '.eof // false')
    [ "$eof" != true ] || break
    next_cursor=$(printf '%s' "$result" | jq -r '.next_cursor // empty')
    if [ -z "$next_cursor" ] || [ "$next_cursor" = "$cursor" ]; then
      rm -f "$body_tmp" "$event_tmp"
      log "ERROR type=message message=invalid_chunk_cursor delivery_id=$delivery_id"
      return 1
    fi
    cursor="$next_cursor"
  done

  jq -nc \
    --argjson item "$item" \
    --argjson claim "$claim" \
    --arg source "$source" \
    --rawfile body "$body_tmp" '{
      type:"delivery",
      delivery_id:$item.delivery_id,
      room_id:($item.room_id // $item.message.room_id // ""),
      message_id:($item.message_id // $item.message.message_id // ""),
      sender_id:($item.sender_id // $item.message.sender_id // ""),
      event_id:($item.event_id // ""),
      seq:($item.seq // $item.created_seq // ""),
      attempt:$claim.attempt,
      claim_id:$claim.claim_id,
      claimed_at:$claim.claimed_at,
      auto_claimed:true,
      claim_state:"claimed",
      claim:{delivery_id:$item.delivery_id,attempt:$claim.attempt,claim_id:$claim.claim_id},
      source:$source,
      body:$body
    }' >"$event_tmp" || {
      rm -f "$body_tmp" "$event_tmp"
      return 1
    }
  chmod 600 "$event_tmp"
  mv -f "$event_tmp" "$event_file" || {
    rm -f "$body_tmp" "$event_tmp"
    return 1
  }
  rm -f "$body_tmp"
  printf '%s' "$event_file"
}

# 从 event_file 提取 stdout 需要的正文摘要。jq 字符串切片按 Unicode 码点，
# 不会截断多字节字符；body_bytes 始终是完整正文的 UTF-8 字节数。
event_body_json() {
  local event_file="$1"
  jq -c --argjson limit "$BODY_PREVIEW_CHARS" '
    (.body // "") as $body
    | {
        body:($body[0:$limit]),
        body_bytes:($body | utf8bytelength),
        body_truncated:(($body | length) > $limit)
      }' "$event_file"
}

emit_found() {
  local item="$1" attempt="$2" source="$3"
  local delivery_id claim status ok event_file body_info alert
  delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // empty')
  case "$delivery_id" in
    ''|*[!A-Za-z0-9_-]*)
      log 'ERROR type=format message=invalid_delivery_reference'
      return 1
      ;;
  esac

  case "$attempt" in
    ''|*[!0-9]*) attempt=0 ;;
  esac

  # 先 claim，再读正文并生成可处理事件；冲突只发不可处理的通知事件。
  claim=$(claim_delivery "$delivery_id")
  status=$?
  case "$status" in
    0) ;;
    41) fatal_credential ;;
    42) fatal_protocol ;;
    *) return 1 ;;
  esac

  ok=$(printf '%s' "$claim" | jq -r '.ok // false')
  if [ "$ok" != true ]; then
    alert=$(claim_notice "$item" "$claim" "$source") || return 1
    printf '%s\n' "$alert"
    # deferred 不写永久 seen：当前 claim 结束后由重连快照重新 claim；watcher 不轮询。
    [ "$(printf '%s' "$claim" | jq -r '.kind // empty')" = "deferred" ] && return 3
    return 0
  fi

  event_file=$(write_event_file "$item" "$claim" "$source")
  status=$?
  if [ "$status" -eq 0 ]; then
    body_info=$(event_body_json "$event_file")
    status=$?
    [ -n "$body_info" ] || status=1
  fi
  if [ "$status" -ne 0 ]; then
    [ -z "$event_file" ] || rm -f "$event_file"
    # claim 已占用但不能生成可处理事件：明确告知宿主，避免投递卡在 claimed 且无人知晓。
    alert=$(printf '%s' "$item" | jq -c --arg source "$source" --argjson claim "$claim" '{
      type:"delivery_claim_failed",
      source:$source,
      delivery_id,
      room_id:(.room_id // .message.room_id // ""),
      message_id:(.message_id // .message.message_id // ""),
      event_id:(.event_id // ""),
      seq:(.seq // .created_seq // ""),
      attempt:$claim.attempt,
      claim_id:$claim.claim_id,
      claimed_at:$claim.claimed_at,
      auto_claimed:true,
      claim_state:"failed",
      code:"READ_FAILED",
      reason:"投递已 claim，但读取正文或写事件文件失败",
      claim:{delivery_id,attempt:$claim.attempt,claim_id:$claim.claim_id},
      hint:"claim 已占用；先重试读取，或 complete/fail 释放；不要当成可处理投递"
    }') || return 1
    printf '%s\n' "$alert"
    return 0
  fi
  alert=$(printf '%s' "$item" | jq -c \
    --arg source "$source" \
    --arg event_file "$event_file" \
    --argjson body_info "$body_info" \
    --argjson claim "$claim" '{
      type:"delivery",
      delivery_id,
      room_id:(.room_id // .message.room_id // ""),
      message_id:(.message_id // .message.message_id // ""),
      sender_id:(.sender_id // .message.sender_id // ""),
      event_id:(.event_id // ""),
      seq:(.seq // .created_seq // ""),
      attempt:$claim.attempt,
      claim_id:$claim.claim_id,
      claimed_at:$claim.claimed_at,
      auto_claimed:true,
      claim_state:"claimed",
      claim:{delivery_id,attempt:$claim.attempt,claim_id:$claim.claim_id},
      source:$source,
      body:$body_info.body,
      body_bytes:$body_info.body_bytes,
      body_truncated:$body_info.body_truncated,
      event_file:$event_file
    }')
  if [ -z "$alert" ]; then
    rm -f "$event_file"
    log 'ERROR type=format message=alert_encode_failed'
    return 1
  fi
  printf '%s\n' "$alert"
}

pending_delivery_map() {
  local inbox status
  inbox=$(mcp_call_result network_inbox_list '{"state":"pending","limit":50}')
  status=$?
  [ "$status" -eq 0 ] || return "$status"
  printf '%s' "$inbox" | jq -r --arg me "$MY_ID" '
    .items[]?
    | select((.message.sender_id // "") != $me)
    | "\(.delivery_id // ""):\(.attempt // 0)"' |
    awk -F: 'NF >= 2 && $1 != ""'
}

emit_pending_snapshot() {
  local inbox status item delivery_id delivery_attempt key
  inbox=$(mcp_call_result network_inbox_list '{"state":"pending","limit":50}')
  status=$?
  case "$status" in
    0) ;;
    41) fatal_credential ;;
    42) fatal_protocol ;;
    *)
      log 'ERROR type=inbox message=snapshot_failed'
      return 1
      ;;
  esac

  while IFS= read -r item; do
    [ -n "$item" ] || continue
    delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // empty')
    [ -n "$delivery_id" ] || continue
    delivery_attempt=$(printf '%s' "$item" | jq -r '.attempt // 0')
    key="pending:$delivery_id:$delivery_attempt"
    seen "$key" && continue
    emit_found "$item" "$delivery_attempt" "inbox.snapshot"
    status=$?
    case "$status" in
      0) mark_seen "$key" ;;
      3) ;; # deferred：保留 pending，下一次快照（重连）可重新 claim
      *) return 1 ;;
    esac
  done < <(printf '%s' "$inbox" | jq -c --arg me "$MY_ID" '
    .items[]? | select((.message.sender_id // "") != $me)')
  return 0
}

handle_ack() {
  local login status pending_count
  ACKED=1
  ACKED_AT=$(date +%s)
  : >"$ACK_FILE"

  login=$(mcp_call_result network_login '{}')
  status=$?
  case "$status" in
    41) fatal_credential ;;
    42) fatal_protocol ;;
    0) ;;
    *)
      log 'ERROR type=login message=network_login_failed'
      kill "$CURL_PID" 2>/dev/null || true
      return
      ;;
  esac

  pending_count=$(printf '%s' "$login" | jq -r '.pending_count // 0' 2>/dev/null || printf '0')
  if [ "$READY_EMITTED" -eq 0 ]; then
    log "READY actor=$MY_ID pending=$pending_count subscription=$SUB_ID"
    READY_EMITTED=1
  else
    log "READY actor=$MY_ID pending=$pending_count subscription=$SUB_ID reconnect=1 reason=$LAST_DISCONNECT_REASON"
  fi
  DEGRADED=0

  emit_pending_snapshot || true
}

handle_notification() {
  local json="$1" envelope pending_map pending_status more dropped
  local item delivery_id event_id fallback key attempt status
  envelope=$(printf '%s' "$json" | jq -c '
    select(.method=="notifications/resources/updated")
    | .params._meta["io.agent-network/event"] // empty') || return
  [ -n "$envelope" ] || return

  pending_map=$(pending_delivery_map)
  pending_status=$?
  case "$pending_status" in
    0) ;;
    41) fatal_credential ;;
    42) fatal_protocol ;;
    *)
      log 'ERROR type=inbox message=pending_lookup_failed'
      pending_map=""
      ;;
  esac

  while IFS= read -r item; do
    [ -n "$item" ] || continue
    delivery_id=$(printf '%s' "$item" | jq -r '.delivery_id // empty')
    [ -n "$delivery_id" ] || continue
    event_id=$(printf '%s' "$item" | jq -r '.event_id // empty')
    fallback=$(printf '%s' "$item" | jq -r '[(.source//""),(.seq//""),(.delivery_id//"")] | join(":")')

    if [ -n "$delivery_id" ] && [ "$(printf '%s' "$item" | jq -r '.source // empty')" = "delivery.reminder" ]; then
      # 提醒不附带新正文，也不生成 event_file；直接唤醒宿主去核对 claimed 投递。
      key="reminder:$delivery_id:${event_id:-$fallback}"
      seen "$key" && continue
      alert=$(printf '%s' "$item" | jq -c '{
        type:"reminder",source:"stream",delivery_id,room_id,message_id,attempt,progress_at,
        event_id,seq,created_at,
        hint:"先调用 network_delivery_report 报告当前阶段进度；完成则 complete，阻塞则 fail 或由接收者 retry"
      }')
      printf '%s\n' "$alert"
      mark_seen "$key"
      continue
    fi

    if [ "$pending_status" -eq 0 ]; then
      attempt=$(printf '%s\n' "$pending_map" |
        awk -F: -v id="$delivery_id" '$1 == id { print $2; exit }')
      if [ -z "$attempt" ]; then
        mark_seen "event:${event_id:-$fallback}"
        continue
      fi
      key="pending:$delivery_id:$attempt"
    else
      attempt=$(printf '%s' "$item" | jq -r '.attempt // 0')
      key="event:${event_id:-$fallback}"
    fi

    seen "$key" && continue
    emit_found "$item" "$attempt" "stream"
    status=$?
    case "$status" in
      0) mark_seen "$key" ;;
      3) ;; # deferred：不写永久 seen，后续事件或重连快照可重新 claim
      *) return 1 ;;
    esac
  done < <(printf '%s' "$envelope" | jq -c --arg me "$MY_ID" '
    .items[]?
    | select(.attention == "action_required")
    | select(.delivery_id != null)
    | select((.sender_id // "") != $me)')

  more=$(printf '%s' "$envelope" | jq -r '.more // false')
  dropped=$(printf '%s' "$envelope" | jq -r '.dropped // 0')
  if [ "$more" = true ] || { [ "$dropped" -gt 0 ] 2>/dev/null; }; then
    emit_pending_snapshot || true
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
    1) base=1 ;;
    2) base=2 ;;
    3) base=4 ;;
    4) base=8 ;;
    5) base=16 ;;
    *) base=30 ;;
  esac
  awk -v b="$base" 'BEGIN{srand(); printf "%.1f", b*(0.8+rand()*0.4)}'
}

disconnect_reason() {
  local status="$1"
  if [ "$ACKED" -eq 0 ]; then
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

# 能力发现：只接受 MCP 2026-07-28，不降级。
discover_raw=$(mcp_rpc server/discover '{}' '')
discover_status=$?
case "$discover_status" in
  41) fatal_credential ;;
  42) fatal_protocol ;;
esac
if [ "$discover_status" -ne 0 ] || ! printf '%s' "$discover_raw" | jq -e \
  --arg version "$PROTOCOL_VERSION" \
  '.result.supportedVersions | index($version) != null' >/dev/null 2>&1; then
  log 'ERROR type=protocol message=discover_failed'
  exit 1
fi

me=$(mcp_call_result network_me '{}')
me_status=$?
case "$me_status" in
  41) fatal_credential ;;
  42) fatal_protocol ;;
esac
MY_ID=$(printf '%s' "$me" | jq -r '.actor_id // empty' 2>/dev/null)
MY_KIND=$(printf '%s' "$me" | jq -r '.kind // empty' 2>/dev/null)
if [ "$me_status" -ne 0 ] || [ -z "$MY_ID" ]; then
  log 'ERROR type=identity message=network_me_failed'
  exit 1
fi
if [ "$MY_KIND" != "agent" ]; then
  log 'ERROR type=identity message=agent_token_required'
  exit 1
fi

while :; do
  GENERATION=$((GENERATION + 1))
  SUB_ID="sub-$(date +%s)-$$-$GENERATION-$RANDOM"
  jq -nc --arg id "$SUB_ID" --arg uri "$STREAM_URI" '{
    jsonrpc:"2.0",id:$id,method:"subscriptions/listen",
    params:{notifications:{resourceSubscriptions:[$uri]},_meta:{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{name:"claude-watch",version:"1.1.0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }}
  }' >"$SUB_BODY" || {
    log 'ERROR type=protocol message=subscription_encode_failed'
    exit 1
  }

  rm -f "$FIFO" "$ACK_FILE"
  mkfifo "$FIFO" || {
    log 'ERROR type=environment message=fifo_failed'
    exit 1
  }
  : >"$STREAM_ERROR"
  ACKED=0
  ACKED_AT=0

  curl --config "$CURL_CONFIG" -sS -N --http1.1 --fail-with-body --connect-timeout 10 \
    --speed-time "$SSE_IDLE_TIMEOUT_SECONDS" --speed-limit "$SSE_IDLE_SPEED_LIMIT" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -H "MCP-Protocol-Version: $PROTOCOL_VERSION" \
    -H "MCP-Method: subscriptions/listen" \
    --data-binary "@$SUB_BODY" \
    "$MCP_ENDPOINT" >"$FIFO" 2>"$STREAM_ERROR" &
  CURL_PID=$!

  (
    sleeper=""
    trap 'if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null || true; fi; exit 0' TERM INT HUP
    sleep "$ACK_TIMEOUT_SECONDS" &
    sleeper=$!
    wait "$sleeper"
    sleeper=""
    [ -f "$ACK_FILE" ] || kill "$CURL_PID" 2>/dev/null || true
  ) </dev/null >/dev/null 2>&1 &
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

  if grep -Eq '(^|[^0-9])(401|403)([^0-9]|$)' "$STREAM_ERROR"; then
    fatal_credential
  fi
  if grep -Eq '(^|[^0-9])400([^0-9]|$)' "$STREAM_ERROR"; then
    fatal_protocol
  fi

  now=$(date +%s)
  reason=$(disconnect_reason "$curl_status")
  LAST_DISCONNECT_REASON="$reason"
  if [ "$ACKED" -eq 1 ] && [ $((now - ACKED_AT)) -ge 30 ]; then
    RECONNECT_ATTEMPT=0
    FAIL_STARTED_AT=0
    DEGRADED=0
  fi
  RECONNECT_ATTEMPT=$((RECONNECT_ATTEMPT + 1))
  [ "$FAIL_STARTED_AT" -ne 0 ] || FAIL_STARTED_AT="$now"
  delay=$(reconnect_delay "$RECONNECT_ATTEMPT")
  log "RECONNECTING reason=$reason status=$curl_status attempt=$RECONNECT_ATTEMPT delay=$delay"
  if [ "$DEGRADED" -eq 0 ] && {
    [ "$RECONNECT_ATTEMPT" -ge 5 ] || [ $((now - FAIL_STARTED_AT)) -ge 60 ];
  }; then
    log "DEGRADED attempts=$RECONNECT_ATTEMPT last_reason=$reason"
    DEGRADED=1
  fi

  sleep "$delay"
done
