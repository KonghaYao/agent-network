#!/bin/bash
# Agent Network SSE -> 当前 Codex app-server 会话。依赖 curl、python3、websockets、codex。
set -euo pipefail

: "${AGENTNET_URL:=https://net.peri-code.dev}"
: "${AGENTNET_TOKEN:?set AGENTNET_TOKEN}"
export AGENTNET_URL AGENTNET_TOKEN

for tool in curl python3 codex; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'ERROR missing=%s\n' "$tool" >&2; exit 1; }
done
python3 -c 'import websockets' 2>/dev/null || {
  printf 'ERROR missing=websockets (python3 -m pip install websockets)\n' >&2
  exit 1
}

python3 - <<'PY'
import asyncio
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile

import websockets

CURL_CONFIG = None


class McpToolError(RuntimeError):
    def __init__(self, tool, code, message):
        super().__init__(f"{tool} failed: {code}: {message}")
        self.tool = tool
        self.code = code
        self.message = message


class DeliveryDeferred(RuntimeError):
    def __init__(self, delivery_id, claimed_delivery_id):
        super().__init__(f"deferred by claimed delivery {claimed_delivery_id}")
        self.delivery_id = delivery_id
        self.claimed_delivery_id = claimed_delivery_id


class DeliveryConflict(RuntimeError):
    def __init__(self, delivery_id, message):
        super().__init__(message)
        self.delivery_id = delivery_id


class DeliveryClaimFailed(RuntimeError):
    def __init__(self, delivery_id, code, message):
        super().__init__(f"{code}: {message}")
        self.delivery_id = delivery_id
        self.code = code


def tool_error(result, name):
    if result.get("error"):
        error = result["error"]
        return McpToolError(name, str(error.get("code", "UNKNOWN")), error.get("message", "unknown"))
    content = result.get("result") or {}
    if not content.get("isError"):
        return None
    parsed = {}
    for item in content.get("content") or []:
        if item.get("type") != "text":
            continue
        try:
            parsed = json.loads(item.get("text") or "")
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict) and parsed.get("code"):
            break
    return McpToolError(
        name,
        str(parsed.get("code", "UNKNOWN")),
        str(parsed.get("message", "unknown")),
    )

def log(message):
    print(message, flush=True)


def disconnect_reason(code):
    return {
        18: "short_read",
        22: "http_error",
        28: "idle_timeout",
        52: "empty_reply",
        55: "connection_reset",
        56: "connection_reset",
    }.get(code, "stream_closed" if code == 0 else f"curl_{code}")


def mcp_tool(name, arguments=None):
    body = {
        "jsonrpc": "2.0", "id": "codex-watch-" + name, "method": "tools/call",
        "params": {
            "name": name, "arguments": arguments or {},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {"name": "codex-watch", "version": "1.0.0"},
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    }
    response = subprocess.run(
        ["curl", "--config", CURL_CONFIG, "-sS", "--connect-timeout", "10", "--max-time", "30",
         "-w", "\n%{http_code}", os.environ["AGENTNET_URL"].rstrip("/") + "/mcp",
         "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream",
         "-H", "MCP-Protocol-Version: 2026-07-28", "-H", "MCP-Method: tools/call",
         "-H", "MCP-Name: " + name, "--data-binary", "@-"],
        input=json.dumps(body).encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=35,
    )
    payload, status = response.stdout.rsplit(b"\n", 1)
    if status in (b"401", b"403"):
        raise RuntimeError("credential rejected")
    if response.returncode or not status.startswith(b"2"):
        raise RuntimeError(name + " request failed")
    result = json.loads(payload)
    error = tool_error(result, name)
    if error:
        raise error
    content = result["result"]
    if "structuredContent" in content:
        return content["structuredContent"]
    return json.loads(next(item["text"] for item in content["content"] if item["type"] == "text"))


def inbox():
    return mcp_tool("network_inbox_list", {"state": "pending", "limit": 50})["items"]


def read_message(message_id):
    chunks = []
    cursor = None
    while True:
        arguments = {"message_id": message_id}
        if cursor:
            arguments["chunk_cursor"] = cursor
        chunk = mcp_tool("network_message_read", arguments)
        chunks.append(chunk["chunk"])
        cursor = chunk["next_cursor"]
        if not cursor:
            return "".join(chunks)


def claimed_page():
    return mcp_tool("network_inbox_list", {"state": "claimed", "limit": 50})


def claim_delivery(delivery_id):
    try:
        return mcp_tool("network_delivery_claim", {
            "request_id": os.urandom(16).hex(), "delivery_id": delivery_id,
        })
    except McpToolError as error:
        if error.code != "CLAIM_CONFLICT":
            raise DeliveryClaimFailed(delivery_id, error.code, error.message) from error
        page = claimed_page()
        own = next(
            (item for item in page.get("items") or [] if item.get("delivery_id") == delivery_id),
            None,
        )
        if own:
            return own
        held = page.get("claimed_delivery_id")
        if held and "当前已有领取中的工作" in error.message:
            raise DeliveryDeferred(delivery_id, held) from error
        raise DeliveryConflict(delivery_id, error.message) from error


def claim_and_read(item):
    delivery_id = item["delivery_id"]
    claim = claim_delivery(delivery_id)
    claim_info = {
        "delivery_id": delivery_id,
        "attempt": claim["attempt"],
        "claim_id": claim["claim_id"],
        "claimed_at": claim.get("claimed_at"),
    }
    if "state" in claim:
        claim_info["state"] = claim["state"]
    try:
        return claim_info, read_message(item["message_id"])
    except Exception:
        fail_delivery(claim_info, "读取消息失败")
        raise


def send_ack(claim, room_id):
    mcp_tool("network_message_send", {
        "request_id": os.urandom(16).hex(), "client_message_id": os.urandom(16).hex(),
        "room_id": room_id, "body": "收到，我正在处理，稍后回复结果。",
        "invoke": [], "claim": claim,
    })


async def ack_if_slow(claim, room_id):
    try:
        await asyncio.sleep(10)
        await asyncio.to_thread(send_ack, claim, room_id)
        log(f"ACK_SENT delivery={claim['delivery_id']}")
    except asyncio.CancelledError:
        raise
    except Exception:
        log(f"ERROR ack_failed delivery={claim['delivery_id']}")


def fail_delivery(claim, reason):
    mcp_tool("network_delivery_fail", {
        "request_id": os.urandom(16).hex(), **claim, "error": reason,
    })


def complete_delivery(claim, text):
    mcp_tool("network_delivery_complete", {
        "request_id": os.urandom(16).hex(), "client_message_id": os.urandom(16).hex(),
        **claim, "final_body": text,
    })


def reminder_prompt(params):
    return (
        "Agent Network 提醒：以下投递已领取但 3 分钟没有状态更新。"
        "请先调用 network_inbox_list 核对状态，再用 network_delivery_report 报告当前阶段进度；"
        "如果已完成则 network_delivery_complete，失败/阻塞则 network_delivery_fail，"
        "确实无法继续时由接收者调用 network_delivery_retry。"
        "不要重复 claim，不要泄露凭据或把正文发到无关房间。\n\n"
        f"delivery_id={params.get('delivery_id', '')} "
        f"room_id={params.get('room_id', '')} "
        f"message_id={params.get('message_id', '')} "
        f"attempt={params.get('attempt', '')}"
    )


async def wake_reminder(connection, thread_id, params):
    prompt = reminder_prompt(params)
    status = (await connection.call("thread/read", {"threadId": thread_id}))["thread"]["status"]["type"]
    if status == "active":
        turns = (await connection.call("thread/turns/list", {"threadId": thread_id, "limit": 1}))["data"]
        current_turn = turns[0] if turns else {}
        if current_turn.get("status") == "inProgress":
            await connection.call("turn/steer", {
                "threadId": thread_id,
                "expectedTurnId": current_turn["id"],
                "input": [{"type": "text", "text": prompt}],
            })
            log(f"REMINDER_STEERED delivery={params.get('delivery_id', '')}")
        return
    if status == "idle":
        await connection.call("turn/start", {
            "threadId": thread_id, "input": [{"type": "text", "text": prompt}],
        })
        log(f"REMINDER_STARTED delivery={params.get('delivery_id', '')}")


class CodexConnection:
    def __init__(self, socket, events):
        self.socket = socket
        self.events = events
        self.pending = {}
        self.serial = 0
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                if "id" in message and message["id"] in self.pending:
                    self.pending.pop(message["id"]).set_result(message)
                elif "method" in message:
                    await self.events.put(message)
        except Exception:
            pass
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("app-server disconnected"))
            self.pending.clear()
            await self.events.put({"method": "codex-watch/disconnected"})

    async def call(self, method, params=None):
        self.serial += 1
        request_id = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        try:
            response = await asyncio.wait_for(future, 30)
        finally:
            self.pending.pop(request_id, None)
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error'].get('message', 'failed')}")
        return response["result"]


async def snapshot(events, actor_id):
    for item in await asyncio.to_thread(inbox):
        if item.get("delivery_id") and (item.get("message") or {}).get("sender_id") != actor_id:
            await events.put({"method": "codex-watch/alert", "params": item})


def next_alert(outstanding, notified, active):
    for delivery_id, alert in outstanding.items():
        attempt = alert.get("attempt")
        if not active or delivery_id not in notified or (attempt is not None and notified[delivery_id] != attempt):
            return delivery_id, alert
    return None


async def stream_events(events, actor_id):
    attempts = 0
    last_reason = "connection_closed"
    if True:
        while True:
            subscription_id = "codex-watch-" + os.urandom(12).hex()
            body = {
                "jsonrpc": "2.0", "id": subscription_id, "method": "subscriptions/listen",
                "params": {"notifications": {"resourceSubscriptions": ["agentnet://stream"]},
                           "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28",
                                     "io.modelcontextprotocol/clientInfo": {"name": "codex-watch", "version": "1.0.0"},
                                     "io.modelcontextprotocol/clientCapabilities": {}}},
            }
            process = await asyncio.create_subprocess_exec(
                "curl", "--config", CURL_CONFIG, "-sS", "-N", "--http1.1", "--fail",
                "--connect-timeout", "10", "--speed-time", "15", "--speed-limit", "1",
                os.environ["AGENTNET_URL"].rstrip("/") + "/mcp",
                "-H", "Content-Type: application/json", "-H", "Accept: text/event-stream",
                "-H", "MCP-Protocol-Version: 2026-07-28",
                "-H", "MCP-Method: subscriptions/listen",
                "--data-binary", "@-", stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                process.stdin.write(json.dumps(body).encode())
                await process.stdin.drain()
                process.stdin.close()
                fragments = []
                acknowledged = False
                while line := await asyncio.wait_for(process.stdout.readline(), timeout=20):
                    line = line.decode(errors="replace").rstrip("\r\n")
                    if line.startswith("data:"):
                        fragments.append(line[5:].lstrip(" "))
                    elif not line and fragments:
                        try:
                            message = json.loads("\n".join(fragments))
                        except json.JSONDecodeError:
                            fragments.clear()
                            continue
                        fragments.clear()
                        if message.get("method") == "notifications/subscriptions/acknowledged" and not acknowledged:
                            acknowledged = True
                            reconnected = attempts > 0
                            attempts = 0
                            await asyncio.to_thread(mcp_tool, "network_login")
                            suffix = f" reconnect=1 reason={last_reason}" if reconnected else ""
                            log(f"READY actor={actor_id} subscription={subscription_id}{suffix}")
                            await snapshot(events, actor_id)
                        if message.get("method") != "notifications/resources/updated":
                            continue
                        envelope = (message.get("params", {}).get("_meta") or {}).get("io.agent-network/event") or {}
                        for item in envelope.get("items", []):
                            reminder = item.get("source") == "delivery.reminder"
                            if ((item.get("attention") == "action_required" and item.get("delivery_id")
                                    and item.get("sender_id") != actor_id)
                                    or (reminder and item.get("delivery_id"))):
                                await events.put({"method": "codex-watch/alert", "params": item})
                        if envelope.get("more") or envelope.get("dropped"):
                            await snapshot(events, actor_id)
                code = await process.wait()
                if not acknowledged and code == 22:
                    raise RuntimeError("subscription rejected; verify credential and protocol")
                last_reason = disconnect_reason(code)
                log(f"RECONNECTING reason={last_reason} status={code} acknowledged={int(acknowledged)}")
            except asyncio.TimeoutError:
                last_reason = "idle_timeout"
                log("RECONNECTING reason=idle_timeout")
            finally:
                if process.returncode is None:
                    process.terminate()
                    await process.wait()
            attempts += 1
            if attempts == 5:
                log("DEGRADED stream_reconnect")
            await asyncio.sleep(min(30, 2 ** min(attempts - 1, 5)))


async def connect(events):
    version = await asyncio.to_thread(subprocess.check_output, ["codex", "app-server", "daemon", "version"])
    socket_path = json.loads(version)["socketPath"]
    socket = await websockets.unix_connect(socket_path, uri="ws://localhost/")
    connection = CodexConnection(socket, events)
    try:
        await connection.call("initialize", {"clientInfo": {"name": "codex-watch", "version": "1.0.0"}})
        await socket.send(json.dumps({"method": "initialized", "params": {}}))
        loaded = (await connection.call("thread/loaded/list"))["data"]
        thread_id = os.environ.get("CODEX_THREAD_ID")
        if not thread_id:
            if len(loaded) != 1:
                raise RuntimeError("set CODEX_THREAD_ID: expected one loaded thread; found " + ", ".join(loaded))
            thread_id = loaded[0]
        if thread_id not in loaded:
            raise RuntimeError("CODEX_THREAD_ID is not a loaded thread")
        await connection.call("thread/resume", {"threadId": thread_id})
        log(f"CODEX_READY thread={thread_id}")
        return connection, thread_id
    except Exception:
        await socket.close()
        raise


async def main():
    global CURL_CONFIG
    directory = tempfile.TemporaryDirectory(prefix="codex-watch-")
    CURL_CONFIG = os.path.join(directory.name, "curl.conf")
    escaped = os.environ["AGENTNET_TOKEN"].replace("\\", "\\\\").replace('"', '\\"')
    if "\n" in escaped or "\r" in escaped:
        raise RuntimeError("invalid token format")
    with open(CURL_CONFIG, "w") as file:
        file.write('header = "Authorization: Bearer ' + escaped + '"\n')
    os.chmod(CURL_CONFIG, 0o600)
    lock_dir = os.path.join(os.path.expanduser("~"), ".codex", "agentnet-watch")
    os.makedirs(lock_dir, mode=0o700, exist_ok=True)
    lock_path = os.path.join(lock_dir, hashlib.sha256(os.environ["AGENTNET_TOKEN"].encode()).hexdigest() + ".lock")
    lock = open(lock_path, "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("watcher already running for this Agent token") from None
    events = asyncio.Queue()
    connection, thread_id = await connect(events)
    actor_id = (await asyncio.to_thread(mcp_tool, "network_me"))["actor_id"]
    watcher = asyncio.create_task(stream_events(events, actor_id))
    outstanding = {}
    delivered = {}
    notified = {}
    reminders_seen = {}
    claim_skipped = {}
    steered = {}
    active_turn = None
    final_message = None
    ack_task = None
    try:
        while True:
            next_event = asyncio.create_task(events.get())
            done, _ = await asyncio.wait((next_event, watcher), return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                next_event.cancel()
                await watcher
                raise RuntimeError("stream watcher stopped")
            event = next_event.result()
            method = event.get("method")
            params = event.get("params") or {}
            if method == "codex-watch/disconnected":
                raise ConnectionError("app_server_disconnected; restart watcher to reconcile pending inbox and claimed deliveries")
            if method == "codex-watch/alert":
                if params.get("source") == "delivery.reminder" or params.get("kind") == "reminder":
                    delivery_id = params.get("delivery_id")
                    key = (params.get("event_id"), params.get("attempt"), params.get("progress_at"))
                    if delivery_id and reminders_seen.get(delivery_id) != key:
                        reminders_seen[delivery_id] = key
                        try:
                            await wake_reminder(connection, thread_id, params)
                        except Exception:
                            log(f"ERROR reminder_wake_failed delivery={delivery_id}")
                    continue
                delivery_id = params["delivery_id"]
                attempt = params.get("attempt")
                if params.get("source") == "delivery.retried":
                    claim_skipped.pop(delivery_id, None)
                    delivered.pop(delivery_id, None)
                attempt_key = 0 if attempt is None else attempt
                if claim_skipped.get(delivery_id) == attempt_key:
                    continue
                previous_attempt = delivered.get(delivery_id)
                if previous_attempt is not None and (
                    attempt is None or attempt <= previous_attempt
                ):
                    continue
                if (delivery_id not in outstanding or
                        attempt is None or
                        (outstanding[delivery_id].get("attempt") or -1) <= attempt):
                    outstanding[delivery_id] = params
            if method == "item/completed" and active_turn and params.get("turnId") == active_turn[1]:
                item = params.get("item") or {}
                if item.get("type") == "agentMessage" and item.get("phase") in (None, "final_answer"):
                    final_message = item.get("text")
            if method == "turn/completed" and active_turn:
                turn = params.get("turn", {})
                if turn.get("id") == active_turn[1] and params.get("threadId") == thread_id:
                    if ack_task:
                        ack_task.cancel()
                        await asyncio.gather(ack_task, return_exceptions=True)
                        ack_task = None
                    try:
                        if turn.get("status") == "completed" and final_message:
                            await asyncio.to_thread(complete_delivery, active_turn[2], final_message)
                            log(f"DELIVERY_COMPLETED delivery={active_turn[0]}")
                        else:
                            await asyncio.to_thread(fail_delivery, active_turn[2], "Codex 未能产出完整最终答复")
                            log(f"DELIVERY_FAILED delivery={active_turn[0]}")
                    except Exception:
                        log(f"ERROR delivery_finalize_failed delivery={active_turn[0]}; manual reconciliation required")
                    active_turn = None
                    final_message = None
            if method == "turn/completed" and params.get("threadId") == thread_id and outstanding:
                asyncio.get_running_loop().call_later(
                    0.5, events.put_nowait, {"method": "codex-watch/retry"},
                )
            if not outstanding:
                continue
            status = (await connection.call("thread/read", {"threadId": thread_id}))["thread"]["status"]["type"]
            if status not in ("idle", "active"):
                continue
            candidate = next_alert(outstanding, notified, status == "active")
            if candidate is None:
                continue
            delivery_id, alert = candidate
            try:
                items = await asyncio.to_thread(inbox)
            except Exception:
                raise RuntimeError("inbox_unavailable; restart watcher to reconcile")
            match = next((item for item in items if item.get("delivery_id") == delivery_id), None)
            if not match and delivery_id in steered:
                # 已插话的投递在 claim 后不再出现在 pending；当前回合结束后从自己的 claimed 列表接手。
                try:
                    claimed_items = (await asyncio.to_thread(claimed_page)).get("items") or []
                except Exception:
                    raise RuntimeError("claimed_inbox_unavailable; restart watcher to reconcile")
                match = next(
                    (item for item in claimed_items if item.get("delivery_id") == delivery_id), None,
                )
            if (not match or (match.get("message") or {}).get("sender_id") == actor_id or
                    (alert.get("attempt") is not None and match.get("attempt") != alert["attempt"])):
                outstanding.pop(delivery_id)
                if outstanding:
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            if status == "active":
                turns = (await connection.call("thread/turns/list", {"threadId": thread_id, "limit": 1}))["data"]
                current_turn = turns[0] if turns else {}
                if current_turn.get("status") != "inProgress":
                    continue
                # 插话前先 claim；失败只记录分类，不读取、不 steer。
                try:
                    claim = await asyncio.to_thread(claim_delivery, delivery_id)
                except DeliveryDeferred as error:
                    log(
                        f"DELIVERY_DEFERRED delivery={delivery_id} "
                        f"claimed_delivery={error.claimed_delivery_id} "
                        "hint=complete_or_fail_current_claim_first_then_claim_or_reconnect"
                    )
                    outstanding.pop(delivery_id)
                    if outstanding:
                        events.put_nowait({"method": "codex-watch/retry"})
                    continue
                except DeliveryConflict as error:
                    claim_skipped[delivery_id] = 0 if match.get("attempt") is None else match["attempt"]
                    log(f"DELIVERY_CONFLICT delivery={delivery_id} hint=skip_do_not_process")
                    outstanding.pop(delivery_id)
                    if outstanding:
                        events.put_nowait({"method": "codex-watch/retry"})
                    continue
                except DeliveryClaimFailed as error:
                    claim_skipped[delivery_id] = 0 if match.get("attempt") is None else match["attempt"]
                    log(f"DELIVERY_CLAIM_FAILED delivery={delivery_id} code={error.code}")
                    outstanding.pop(delivery_id)
                    if outstanding:
                        events.put_nowait({"method": "codex-watch/retry"})
                    continue
                except Exception:
                    log(f"ERROR claim_failed delivery={delivery_id}")
                    outstanding.pop(delivery_id)
                    if outstanding:
                        events.put_nowait({"method": "codex-watch/retry"})
                    continue
                claim_skipped.pop(delivery_id, None)
                log(
                    f"DELIVERY_CLAIMED delivery={delivery_id} attempt={claim['attempt']} "
                    f"claim_id={claim['claim_id']} claimed_at={claim['claimed_at']} auto_claimed=true"
                )
                try:
                    body = await asyncio.to_thread(read_message, match["message_id"])
                except Exception:
                    try:
                        await asyncio.to_thread(fail_delivery, claim, "读取消息失败")
                    except Exception:
                        log(f"ERROR steer_read_failed delivery={delivery_id}; manual reconciliation required")
                    outstanding.pop(delivery_id)
                    if outstanding:
                        events.put_nowait({"method": "codex-watch/retry"})
                    continue
                steered_item = {
                    **match, "attempt": claim["attempt"],
                    "state": "claimed", "claim_id": claim["claim_id"], "claimed_at": claim["claimed_at"],
                }
                try:
                    await connection.call("turn/steer", {
                        "threadId": thread_id,
                        "expectedTurnId": current_turn["id"],
                        "input": [{"type": "text", "text": (
                            "Agent Network 有一条新的用户消息在你工作期间到达。桥接器已自动领取该投递，"
                            "本条只供你调整当前工作；当前回合结束后会单独处理并答复，不要在此重复结束投递。\n\n"
                            f"新消息：\n{body}"
                        )}],
                    })
                except RuntimeError:
                    notified[delivery_id] = claim["attempt"]
                    outstanding[delivery_id] = steered_item
                    steered[delivery_id] = steered_item
                    log(
                        f"STEER_DEFERRED delivery={delivery_id} claim_state=claimed "
                        "hint=process_after_current_turn"
                    )
                    latest = (await connection.call("thread/read", {"threadId": thread_id}))["thread"]["status"]["type"]
                    if latest == "idle":
                        await events.put({"method": "codex-watch/retry"})
                    continue
                except Exception:
                    notified[delivery_id] = claim["attempt"]
                    outstanding[delivery_id] = steered_item
                    steered[delivery_id] = steered_item
                    log(
                        f"ERROR steer_failed delivery={delivery_id} claim_state=claimed "
                        "hint=process_after_current_turn"
                    )
                    continue
                notified[delivery_id] = claim["attempt"]
                outstanding[delivery_id] = steered_item
                steered[delivery_id] = steered_item
                log(
                    f"STEERED delivery={delivery_id} turn={current_turn['id']} "
                    f"claim_id={claim['claim_id']}"
                )
                if next_alert(outstanding, notified, True):
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            if active_turn:
                continue
            try:
                claim, body = await asyncio.to_thread(claim_and_read, match)
            except DeliveryDeferred as error:
                # 不写永久跳过标记：完成后重连快照必须能重新 claim 这条。
                log(
                    f"DELIVERY_DEFERRED delivery={delivery_id} "
                    f"claimed_delivery={error.claimed_delivery_id} "
                    "hint=complete_or_fail_current_claim_first_then_claim_or_reconnect"
                )
                outstanding.pop(delivery_id)
                if outstanding:
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            except DeliveryConflict as error:
                claim_skipped[delivery_id] = 0 if match.get("attempt") is None else match["attempt"]
                log(f"DELIVERY_CONFLICT delivery={delivery_id} hint=skip_do_not_process")
                outstanding.pop(delivery_id)
                if outstanding:
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            except DeliveryClaimFailed as error:
                claim_skipped[delivery_id] = 0 if match.get("attempt") is None else match["attempt"]
                log(f"DELIVERY_CLAIM_FAILED delivery={delivery_id} code={error.code}")
                outstanding.pop(delivery_id)
                if outstanding:
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            except Exception:
                log(f"ERROR claim_or_read_failed delivery={delivery_id}")
                outstanding.pop(delivery_id)
                if outstanding:
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            claim_skipped.pop(delivery_id, None)
            log(
                f"DELIVERY_CLAIMED delivery={delivery_id} "
                f"attempt={claim['attempt']} claim_id={claim['claim_id']} "
                f"claimed_at={claim['claimed_at']} auto_claimed=true"
            )
            prompt = (
                "这是一条来自 Agent Network 的用户任务。桥接器已自动领取投递并读取正文；"
                f"claim 已就绪（delivery_id={delivery_id}, attempt={claim['attempt']}, "
                f"claim_id={claim['claim_id']}）。"
                "你只需要处理下面的任务，给出最终答复，桥接器会用该答复结束投递。"
                "不要泄露凭据，不要调用其他 Agent 身份的 network_* 工具回复本任务。\n\n"
                f"任务正文：\n{body}"
            )
            try:
                result = await connection.call("turn/start", {
                    "threadId": thread_id, "input": [{"type": "text", "text": prompt}],
                })
            except RuntimeError as error:
                await asyncio.to_thread(fail_delivery, claim, "Codex 无法启动任务")
                log(f"ERROR turn_start_failed delivery={delivery_id} ({error})")
                outstanding.pop(delivery_id)
                continue
            active_turn = (delivery_id, result["turn"]["id"], claim)
            ack_task = asyncio.create_task(ack_if_slow(claim, match["room_id"]))
            outstanding.pop(delivery_id)
            steered.pop(delivery_id, None)
            delivered[delivery_id] = claim["attempt"]
            log(f"TURN_STARTED delivery={delivery_id} turn={active_turn[1]}")
    finally:
        if ack_task:
            ack_task.cancel()
            await asyncio.gather(ack_task, return_exceptions=True)
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        await connection.socket.close()
        lock.close()
        directory.cleanup()


try:
    asyncio.run(main())
except (KeyboardInterrupt, asyncio.CancelledError):
    pass
except Exception as error:
    log(f"ERROR codex_watch={error}")
    sys.exit(1)
PY
