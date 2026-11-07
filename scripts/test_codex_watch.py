import ast
import asyncio
import os
import pathlib
import tempfile
import unittest
from unittest import mock


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "public/skills/codex-watch.sh"
EMBEDDED = SOURCE.read_text().split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
BODY = EMBEDDED.rsplit("\ntry:\n    asyncio.run(main())", 1)[0]
MODULE = ast.parse(EMBEDDED)
CLAIMED_AT = "2026-11-04T12:00:00.000Z"


def namespace_for(*names):
    nodes = [
        node for node in MODULE.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and node.name in names
    ]
    namespace = {"os": os}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


class DeliveryClassificationTests(unittest.TestCase):
    def setUp(self):
        self.ns = namespace_for(
            "McpToolError", "DeliveryDeferred", "DeliveryConflict",
            "DeliveryClaimFailed", "claim_delivery",
        )
        self.claim_delivery = self.ns["claim_delivery"]

    def classify(self, error, items=None, held=None):
        def mcp_tool(name, arguments=None):
            if name == "network_delivery_claim":
                raise error
            raise AssertionError("unexpected tool " + name)

        self.ns["mcp_tool"] = mcp_tool
        self.ns["claimed_page"] = lambda: {
            "items": items or [],
            "claimed_delivery_id": held,
        }
        return self.claim_delivery("dlv_test")

    def test_deferred_when_this_agent_holds_another_claim(self):
        error = self.ns["McpToolError"](
            "network_delivery_claim", "CLAIM_CONFLICT",
            "当前已有领取中的工作，不能并行领取",
        )
        with self.assertRaises(self.ns["DeliveryDeferred"]) as caught:
            self.classify(error, items=[], held="dlv_held")
        self.assertEqual(caught.exception.claimed_delivery_id, "dlv_held")

    def test_conflict_when_another_owner_holds_the_delivery(self):
        error = self.ns["McpToolError"](
            "network_delivery_claim", "CLAIM_CONFLICT",
            "该工作已被领取或状态已变化",
        )
        with self.assertRaises(self.ns["DeliveryConflict"]):
            self.classify(error, items=[], held="dlv_held")

    def test_other_claim_errors_are_reported_as_claim_failed(self):
        error = self.ns["McpToolError"](
            "network_delivery_claim", "STALE_ATTEMPT", "attempt 或 claim_id 已过期",
        )
        with self.assertRaises(self.ns["DeliveryClaimFailed"]) as caught:
            self.classify(error)
        self.assertEqual(caught.exception.code, "STALE_ATTEMPT")

    def test_reuses_own_claim_from_claimed_inbox(self):
        error = self.ns["McpToolError"](
            "network_delivery_claim", "CLAIM_CONFLICT",
            "该工作已被领取或状态已变化",
        )
        own = {
            "delivery_id": "dlv_test",
            "attempt": 1,
            "claim_id": "clm_own",
            "claimed_at": "2026-11-04T00:00:00.000Z",
        }
        result = self.classify(error, items=[own], held="dlv_test")
        self.assertEqual(result["claim_id"], "clm_own")
        self.assertEqual(result["attempt"], 1)
        self.assertEqual(result["claimed_at"], "2026-11-04T00:00:00.000Z")


class StaticWatcherTests(unittest.TestCase):
    def active_block(self):
        main_at = EMBEDDED.index("async def main")
        start = EMBEDDED.index('if status == "active":', main_at)
        end = EMBEDDED.index("if active_turn:", start)
        return EMBEDDED[start:end]

    def test_active_turn_claims_before_read_and_steer(self):
        block = self.active_block()
        claim_markers = [
            marker for marker in ("claim_delivery, delivery_id", "claim_delivery(delivery_id)")
            if marker in block
        ]
        self.assertTrue(claim_markers, "active turn must call claim_delivery")
        claim_at = min(block.index(marker) for marker in claim_markers)
        read_at = block.index("read_message,")
        steer_at = block.index("turn/steer")
        self.assertLess(claim_at, read_at, "active turn must claim before reading the message")
        self.assertLess(read_at, steer_at, "active turn must read only after a successful claim")
        self.assertIn("DELIVERY_CLAIMED", block)
        self.assertIn("claimed_at={claim['claimed_at']}", block)

    def test_claim_logs_include_claimed_at(self):
        self.assertEqual(EMBEDDED.count("DELIVERY_CLAIMED"), 2)
        self.assertEqual(EMBEDDED.count("claimed_at={claim['claimed_at']}"), 2)

    def test_deferred_does_not_write_claim_skipped(self):
        search = 0
        blocks = 0
        while True:
            try:
                start = EMBEDDED.index("except DeliveryDeferred as error:", search)
            except ValueError:
                break
            blocks += 1
            end = EMBEDDED.index("continue", start)
            self.assertNotIn("claim_skipped", EMBEDDED[start:end])
            search = end
        self.assertEqual(blocks, 2, "both idle and active paths must handle deferred")

    def test_retried_clears_skip_markers(self):
        start = EMBEDDED.index('if params.get("source") == "delivery.retried":')
        block = EMBEDDED[start:start + 300]
        self.assertIn("claim_skipped.pop(delivery_id, None)", block)
        self.assertIn("delivered.pop(delivery_id, None)", block)

    def test_steered_claim_is_kept_for_after_turn_processing(self):
        block = self.active_block()
        self.assertIn("steered[delivery_id] = steered_item", block)
        self.assertIn("outstanding[delivery_id] = steered_item", block)
        self.assertIn("claimed_items", EMBEDDED)
        self.assertIn("steered.pop(delivery_id, None)", EMBEDDED)

    def test_sse_uses_idle_timeout_instead_of_max_time(self):
        start = EMBEDDED.index("async def stream_events")
        block = EMBEDDED[start:EMBEDDED.index("async def connect", start)]
        self.assertIn('"--speed-time", "15"', block)
        self.assertIn('"--speed-limit", "1"', block)
        self.assertNotIn('"--max-time"', block)
        self.assertIn("RECONNECTING reason={last_reason} status={code}", block)
        self.assertIn("RECONNECTING reason=idle_timeout", block)
        self.assertIn("last_reason = disconnect_reason(code)", block)
        self.assertIn("timeout=20", block)
        self.assertIn("reconnect=1 reason={last_reason}", block)


def watcher_namespace():
    namespace = {"__name__": "codex_watch_test"}
    exec(compile(BODY, str(SOURCE), "exec"), namespace)
    return namespace


def alert(delivery_id, attempt=1):
    return {
        "method": "codex-watch/alert",
        "params": {
            "delivery_id": delivery_id,
            "message_id": "msg_" + delivery_id,
            "room_id": "rm_test",
            "attempt": attempt,
            "source": "message.new",
        },
    }


def delivery_item(delivery_id, attempt=1):
    return {
        "delivery_id": delivery_id,
        "recipient_id": "agt_me",
        "message_id": "msg_" + delivery_id,
        "room_id": "rm_test",
        "state": "pending",
        "attempt": attempt,
        "claim_id": None,
        "claimed_at": None,
        "progress_at": None,
        "result_message_id": None,
        "error": None,
        "created_seq": "1",
        "created_at": CLAIMED_AT,
        "updated_at": CLAIMED_AT,
        "message": {
            "sender_id": "agt_user",
            "preview": "任务",
            "created_at": CLAIMED_AT,
        },
    }


class FakeSocket:
    async def close(self):
        pass


class FakeConnection:
    def __init__(self):
        self.status = "idle"
        self.current_turn = None
        self.turn_serial = 0
        self.socket = FakeSocket()
        self.calls = []

    async def call(self, method, params):
        self.calls.append((method, params))
        if method == "thread/read":
            return {"thread": {"status": {"type": self.status}}}
        if method == "thread/turns/list":
            if self.status == "active" and self.current_turn:
                return {"data": [{"id": self.current_turn, "status": "inProgress"}]}
            return {"data": []}
        if method == "turn/start":
            self.turn_serial += 1
            self.current_turn = f"turn_{self.turn_serial}"
            self.status = "active"
            return {"turn": {"id": self.current_turn}}
        if method == "turn/steer":
            return {}
        raise AssertionError("unexpected codex method " + method)


class FakeMcp:
    def __init__(self, error_type):
        self.error_type = error_type
        self.deliveries = {}
        self.calls = []

    def add(self, delivery_id, attempt=1):
        self.deliveries[delivery_id] = delivery_item(delivery_id, attempt)

    def __call__(self, name, arguments=None):
        arguments = arguments or {}
        self.calls.append((name, arguments))
        if name == "network_me":
            return {"actor_id": "agt_me"}
        if name == "network_inbox_list":
            state = arguments.get("state", "pending")
            items = [
                dict(item) for item in self.deliveries.values()
                if item["state"] == state
            ]
            claimed = next(
                (item["delivery_id"] for item in self.deliveries.values()
                 if item["state"] == "claimed"),
                None,
            )
            return {
                "items": items,
                "next_cursor": None,
                "has_more": False,
                "pending_count": 0,
                "claimed_delivery_id": claimed,
            }
        if name == "network_message_read":
            return {"chunk": "请处理这条任务", "next_cursor": None}
        if name == "network_delivery_claim":
            item = self.deliveries[arguments["delivery_id"]]
            if item["state"] != "pending":
                raise self.error_type(
                    "network_delivery_claim", "CLAIM_CONFLICT",
                    "该工作已被领取或状态已变化",
                )
            item["state"] = "claimed"
            item["claim_id"] = "clm_" + item["delivery_id"]
            item["claimed_at"] = CLAIMED_AT
            return dict(item)
        if name in {
            "network_delivery_complete", "network_delivery_fail", "network_message_send",
        }:
            return {}
        raise AssertionError("unexpected mcp tool " + name)


class WatcherHarness:
    def __init__(self):
        self.ns = watcher_namespace()
        self.mcp = FakeMcp(self.ns["McpToolError"])
        self.connection = FakeConnection()
        self.logs = []
        self.events = None
        self.ready = None
        self.task = None
        self.failure_reported = False
        self.ns["log"] = self.logs.append
        self.ns["mcp_tool"] = self.mcp
        self.ns["connect"] = self.connect
        self.ns["stream_events"] = self.stream

    async def connect(self, events):
        return self.connection, "thr_test"

    async def stream(self, events, actor_id):
        self.events = events
        self.ready.set()
        await asyncio.Event().wait()

    async def start(self):
        self.ready = asyncio.Event()
        self.task = asyncio.create_task(self.ns["main"]())
        await asyncio.wait_for(self.ready.wait(), 5)

    async def stop(self):
        if not self.task:
            return
        self.task.cancel()
        try:
            await self.task
        except asyncio.CancelledError:
            pass
        except Exception:
            if not self.failure_reported:
                raise
        if self.events is not None:
            self.events.put_nowait({"method": "codex-watch/retry"})
        await asyncio.sleep(0)

    def matches(self, prefix):
        return [line for line in self.logs if line.startswith(prefix)]

    async def wait_for_log(self, prefix, timeout=5):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if self.matches(prefix):
                return
            if self.task.done():
                self.failure_reported = True
                await self.task
                raise AssertionError(f"watcher exited before {prefix}: {self.logs}")
            await asyncio.sleep(0.01)
        raise AssertionError(f"timed out waiting for {prefix}: {self.logs}")

    def print_trace(self):
        for line in self.logs:
            if line.startswith(("DELIVERY_CLAIMED", "TURN_STARTED", "STEERED", "ERROR")):
                print(line)


class ExecutableWatcherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.env = mock.patch.dict(os.environ, {
            "HOME": self.home.name,
            "AGENTNET_TOKEN": "test-token-for-codex-watch",
            "AGENTNET_URL": "http://127.0.0.1:9",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    async def start_harness(self):
        harness = WatcherHarness()
        await harness.start()
        self.addAsyncCleanup(harness.stop)
        return harness

    async def test_idle_claim_logs_claimed_at_and_starts_turn(self):
        harness = await self.start_harness()
        harness.mcp.add("dlv_idle")
        harness.events.put_nowait(alert("dlv_idle"))
        await harness.wait_for_log("TURN_STARTED delivery=dlv_idle")
        harness.print_trace()

        claimed = harness.matches("DELIVERY_CLAIMED delivery=dlv_idle")
        self.assertEqual(len(claimed), 1)
        self.assertIn(f"claimed_at={CLAIMED_AT}", claimed[0])
        self.assertIn("auto_claimed=true", claimed[0])
        self.assertEqual(
            harness.matches("TURN_STARTED delivery=dlv_idle"),
            ["TURN_STARTED delivery=dlv_idle turn=turn_1"],
        )
        self.assertEqual(harness.matches("ERROR"), [])

    async def test_steer_then_idle_self_reuse_keeps_claimed_at(self):
        harness = await self.start_harness()
        harness.mcp.add("dlv_first")
        harness.mcp.add("dlv_steered")
        harness.events.put_nowait(alert("dlv_first"))
        await harness.wait_for_log("TURN_STARTED delivery=dlv_first")

        harness.events.put_nowait(alert("dlv_steered"))
        await harness.wait_for_log("STEERED delivery=dlv_steered")
        harness.connection.status = "idle"
        harness.events.put_nowait({
            "method": "item/completed",
            "params": {
                "threadId": "thr_test",
                "turnId": "turn_1",
                "item": {"type": "agentMessage", "phase": "final_answer", "text": "第一条完成"},
            },
        })
        harness.events.put_nowait({
            "method": "turn/completed",
            "params": {
                "threadId": "thr_test",
                "turn": {"id": "turn_1", "status": "completed"},
            },
        })
        await harness.wait_for_log("TURN_STARTED delivery=dlv_steered")
        harness.print_trace()

        self.assertEqual(harness.matches("ERROR"), [])
        self.assertEqual(
            harness.matches("DELIVERY_COMPLETED delivery=dlv_first"),
            ["DELIVERY_COMPLETED delivery=dlv_first"],
        )
        claimed = harness.matches("DELIVERY_CLAIMED delivery=dlv_steered")
        self.assertEqual(len(claimed), 2, "active steer and idle self-reuse both claim")
        self.assertIn(f"claimed_at={CLAIMED_AT}", claimed[-1])
        self.assertIn("auto_claimed=true", claimed[-1])
        self.assertEqual(
            harness.matches("TURN_STARTED delivery=dlv_steered"),
            ["TURN_STARTED delivery=dlv_steered turn=turn_2"],
        )


if __name__ == "__main__":
    unittest.main()
