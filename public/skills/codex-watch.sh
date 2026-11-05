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

def log(message):
    print(message, flush=True)


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
    if result.get("error") or result.get("result", {}).get("isError"):
        raise RuntimeError(name + " failed")
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


def claim_and_read(item):
    delivery_id = item["delivery_id"]
    claim = mcp_tool("network_delivery_claim", {
        "request_id": os.urandom(16).hex(), "delivery_id": delivery_id,
    })
    claim_info = {"delivery_id": delivery_id, "attempt": claim["attempt"], "claim_id": claim["claim_id"]}
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
                "--connect-timeout", "10", "--max-time", "900",
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
                while line := await asyncio.wait_for(process.stdout.readline(), timeout=70):
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
                            attempts = 0
                            await asyncio.to_thread(mcp_tool, "network_login")
                            log(f"READY actor={actor_id} subscription={subscription_id}")
                            await snapshot(events, actor_id)
                        if message.get("method") != "notifications/resources/updated":
                            continue
                        envelope = (message.get("params", {}).get("_meta") or {}).get("io.agent-network/event") or {}
                        for item in envelope.get("items", []):
                            if (item.get("attention") == "action_required" and item.get("delivery_id")
                                    and item.get("sender_id") != actor_id):
                                await events.put({"method": "codex-watch/alert", "params": item})
                        if envelope.get("more") or envelope.get("dropped"):
                            await snapshot(events, actor_id)
                code = await process.wait()
                if not acknowledged and code == 22:
                    raise RuntimeError("subscription rejected; verify credential and protocol")
            except asyncio.TimeoutError:
                log("DEGRADED stream_idle; reconnecting")
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
    delivered = set()
    notified = {}
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
                log("ERROR app_server_disconnected; restart watcher to reconcile pending inbox")
                break
            if method == "codex-watch/alert":
                delivery_id = params["delivery_id"]
                attempt = params.get("attempt")
                if (delivery_id, attempt) not in delivered and (
                    delivery_id not in outstanding or
                    attempt is None or
                    (outstanding[delivery_id].get("attempt") or -1) <= attempt
                ):
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
                log("ERROR inbox_unavailable; restart watcher to reconcile")
                break
            match = next((item for item in items if item.get("delivery_id") == delivery_id), None)
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
                try:
                    body = await asyncio.to_thread(read_message, match["message_id"])
                    await connection.call("turn/steer", {
                        "threadId": thread_id,
                        "expectedTurnId": current_turn["id"],
                        "input": [{"type": "text", "text": (
                            "Agent Network 有一条新的用户消息在你工作期间到达。请立即阅读并酌情调整当前工作；"
                            "它仍在待办队列中，当前回合结束后会单独处理并答复，不要在此重复结束投递。\n\n"
                            f"新消息：\n{body}"
                        )}],
                    })
                except RuntimeError:
                    log(f"STEER_DEFERRED delivery={delivery_id}")
                    latest = (await connection.call("thread/read", {"threadId": thread_id}))["thread"]["status"]["type"]
                    if latest == "idle":
                        await events.put({"method": "codex-watch/retry"})
                    continue
                except Exception:
                    log(f"ERROR steer_read_failed delivery={delivery_id}")
                    continue
                notified[delivery_id] = match["attempt"]
                outstanding[delivery_id] = match
                log(f"STEERED delivery={delivery_id} turn={current_turn['id']}")
                if next_alert(outstanding, notified, True):
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            if active_turn:
                continue
            try:
                claim, body = await asyncio.to_thread(claim_and_read, match)
            except Exception:
                log(f"ERROR claim_or_read_failed delivery={delivery_id}")
                outstanding.pop(delivery_id)
                if outstanding:
                    events.put_nowait({"method": "codex-watch/retry"})
                continue
            prompt = (
                "这是一条来自 Agent Network 的用户任务。桥接器已领取投递并读取正文；"
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
            delivered.add((delivery_id, claim["attempt"]))
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
