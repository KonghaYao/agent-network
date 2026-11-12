# P1：维护员监听器会漏消息（inbox 查询失败 / claim 冲突后不再重试）

- 状态：修复中（分支 `fix/monitor-missed-messages`）
- 日期：2026-11-12
- 严重级别：P1
- 影响组件：`client/monitor/engine.ts`（`--harness claude|peri` 共用引擎）
- 相关场景：`agentnet monitor`、宿主的 monitor / alert 唤醒
- 服务端数据：未丢失；问题在监听器的失败恢复流程

## P1 判定

- **核心功能错误**：消息到达（delivery 唤醒）是 Agent 的核心链路；监听器已知有 pending 却不 claim，用户会认为消息“没发出去”。
- **可稳定复现**：inbox 查询失败或已有 claim 未释放时，后续消息会稳定停在 pending，直到人工 claim 或重启监听器。
- **有临时规避**：人工 `network_inbox_list` + `network_delivery_claim`，或重启 monitor 触发重连快照。因此不是 P0 的“完全不可用”，但会造成实际漏处理和响应延迟。

## 现象

1. `2026-11-12` 群消息 seq `15132`（用户询问 task 机制）已经写入 webots，消息和历史接口都能读到；监听器日志出现：

   ```text
   ERROR type=inbox message=pending_lookup_failed
   ```

   该投递长期保持 `pending`，没有自动 claim；最终由人工 claim 后才回复。

2. 随后 seq `15178`（v3 任务 + 附件）到达。因为上一条 `15132` 的 claim 没有被 `complete`，监听器对新投递返回：

   ```text
   CLAIM_CONFLICT
   delivery_deferred
   ```

   新消息停在 `pending`。服务端没有丢消息，但用户侧表现为“消息没发送 / Agent 没收到”。

## 复现与证据

### 证据 A：inbox 查询失败后没有恢复

- 日志字段：`ERROR type=inbox message=pending_lookup_failed`。
- 触发点：`pendingDeliveryMap()` 或 `emitPendingSnapshot()` 单次调用 `network_inbox_list` 失败。
- 旧行为：
  - `pendingDeliveryMap()` 输出一次 ERROR 后返回 `null`，当前通知继续用事件自身的 attempt 兜底；
  - `emitPendingSnapshot()` 输出一次 `ERROR` 后直接 `return`；
  - 没有任何定时器或后续查询，登录/重连快照失败后 pending 不会再次被读取。
- 结果：`15132` 没有被 claim；服务端 pending 状态一直保留。

### 证据 B：deferred 后没有后续重领

- 日志/事件：`CLAIM_CONFLICT`、`delivery_deferred`，`claimed_delivery_id` 指向 `15132` 的 claim。
- 服务端约束：每个 Agent 至多一条 claimed；新投递只能等当前 claim 被 `complete` / `fail` / `retry`。
- 旧行为：`emitFound()` 输出一次 deferred 提示后返回；本地不保存待领队列，也不安排重试。
- 关键缺口：当前 claim 结束时，服务端不会给 recipient 自己推送可唤醒的 `delivery.updated`（recipient 被排除在房间回执外），监听器没有事件可依赖。
- 结果：即使 `15132` 后来被 complete/fail，`15178` 仍停在 pending，直到宿主重连或人工 claim。

### 证据 C：同一事件重复到达时可能重复 claim/重复输出

- 旧 `seen` key 在“pending 查询失败”与“快照”两条路径上不一致：
  - 通知路径失败时用 `event:<event_id>`；
  - 快照路径用 `pending:<delivery_id>:<attempt>`。
- 同一条投递已 claim 成功后，如果再次收到通知且 pending 查询失败，`claimDelivery()` 会从 claimed inbox 复用同一个 claim，可能再次输出 `delivery`，导致宿主重复回复。
- 旧行为缺少跨路径的 claim 去重。

## 根因链

```text
network_inbox_list 暂时失败
  -> pendingDeliveryMap / emitPendingSnapshot 只记录一次 ERROR 后返回
  -> 没有退避重试，也没有恢复后补领 pending
  -> 15132 保持 pending
  -> 人工 claim 15132 后，服务端单 claim 槽位被占用
  -> 15178 claim 返回 CLAIM_CONFLICT / delivery_deferred
  -> 监听器只输出一次 deferred，不保存待领队列
  -> 15132 claim 结束时 recipient 收不到可唤醒回执
  -> 15178 永久 pending，表现为漏消息
```

补充：监听器并不缺少“收到通知后 claim”的能力，缺的是**失败后的恢复机制**和**deferred 的本地队列**。

## 影响面

- `agentnet monitor --harness claude`：共享引擎，直接受影响；`delivery` 事件是宿主唯一唤醒源。
- `agentnet monitor --harness peri`：共享引擎，直接受影响；`ALERT` 漏发同样导致宿主不处理。
- `agentnet monitor --harness codex`：使用同一 `claimDelivery()` 分类，但有自己的 `outstanding` 队列与 turn 完成后的 retry；本次不改变其语义。其 `snapshot()` 查询失败仍直接退出，属于后续独立加固项。
- `agentnet monitor --harness dsh`：不自动 claim，只写 `wake.queue`；不在本次修复范围。
- 所有依赖监听器“自动 claim 后再唤醒宿主”的宿主：inbox 短暂失败、单 claim 槽位被占用时都会出现同类漏消息。
- 服务端：不受影响，不需要迁移；消息、delivery、pending 状态都以 SQLite 为准。

## 修复范围

### 1. inbox 查询失败：指数退避 + 恢复补领

- 新增统一的 `fetchPending()`，`pendingDeliveryMap()` 与 `emitPendingSnapshot()` 共用。
- 失败时：
  - 输出可见 `ERROR type=inbox message=pending_lookup_failed attempt=<n> retry_in_ms=<ms>`；
  - 按 `1/2/4/8/16/30` 秒退避（`30s` 封顶），持续到成功或进程退出；
  - 恢复时输出 `RECOVERED type=inbox attempts=<n>`，读取 pending 并补领。
- 失败提示不刷屏：首次失败必输出，之后每 10 轮输出一次；恢复事件只输出一次。

### 2. deferred / CLAIM_CONFLICT：本地待领队列

- `delivery_deferred` 不再丢弃：
  - 以 `delivery_id` 为 key 进入本地队列，保存最新 item / fields / source；
  - 按 `2/4/8/16/30` 秒退避重试 `network_delivery_claim`；
  - 收到 `delivery.retried`、`delivery.updated` 等回执，或 pending 快照再次看到该投递时，立即唤醒队列。
- 成功后从队列移除，并输出唯一一条 `delivery`。
- 仍保持服务端“每 Agent 至多一条 claimed”的约束；不修改 claim 语义，不并行 claim。
- 终态 `conflict` / `STALE_ATTEMPT` 不无限重试：输出一次提示并标记 seen。

### 3. 去重与不刷屏

- `deferred` 提示去重：同一 `delivery_id` 的同一 `kind/code/holder/attempt` 只输出一次；holder 或 attempt 变化才输出新事件。
- 新增 `emittedClaims`（`delivery_id:attempt:claim_id`）：
  - 即使通知路径与快照/重试路径都拿到同一 claim，也只输出一次 `delivery`；
  - 避免重复回复、重复读正文、重复写 event_file。
- 新增 `claiming` set：通知路径与退避定时器不会同时 claim 同一条投递。

### 4. 可观测字段

- `delivery_deferred` 增加：
  - `retry_attempt`：当前自动重试轮次；
  - `retry_in_ms`：下一次重试等待毫秒。
- `--json` 模式下的 inbox 错误仍走统一 `type=error` / `kind=error`，包含 `code`、`error_type=inbox`、`attempt`、`retry_in_ms`。

### 5. 文档

- `client/monitor/events.ts` 的 deferred hint 改为“watcher 会自动退避重试”。
- `README.md`、`src/mcp/skill.ts`、`client/harness-guides.ts` 同步说明自动重试，不要求宿主轮询。

## 验收标准

1. **inbox 查询失败恢复**
   - `network_inbox_list` 连续失败 2 次后恢复；
   - 日志出现 `ERROR type=inbox ... attempt=1 retry_in_ms=...`；
   - 出现 `RECOVERED type=inbox attempts=2`；
   - pending 投递被 claim，`delivery` 只输出一次。

2. **deferred 槽位释放后重领**
   - 已有 claim 时新投递输出一次 `delivery_deferred`，带 `retry_attempt` / `retry_in_ms`；
   - 同一通知重复到达时不再输出 deferred；
   - 槽位释放后自动 claim 并输出唯一 `delivery`；
   - 全程 `maxConcurrentClaims == 1`。

3. **去重**
   - 成功领取后重复事件/快照不重复 claim；
   - 不重复输出 `delivery`，不重复读正文。

4. **退避上限**
   - `retryDelayMs(1, 1000, 30000) == 1000`；
   - 指数增长，`retryDelayMs(20, 1000, 30000) == 30000`；
   - claim 退避同样 30s 封顶。

5. **回归**
   - `bun run typecheck` 通过；
   - `bun scripts/verify-ts-monitor.ts` 通过（当前 315 项）；
   - `bun run test:client` 通过。

## 回滚

- 本次只改客户端监听器、文档与验收脚本；**不改服务端、不改数据库、不加迁移、不改 claim 语义**。
- 回滚方式：revert 修复提交（或切回上一版 monitor 二进制）。
- 回滚后行为回到“inbox 失败只报一次、deferred 不重试”；服务端 pending 数据不受影响，可继续人工 claim 或重启监听器补领。
- 无需回滚数据；升级后的监听器也不会修改历史 delivery 状态。

## 未覆盖 / 后续

- **服务端 sender 提示**：当前 recipient 自己的 claim 状态变化不会推送可唤醒回执；本次靠客户端定时重试兜底。是否给 recipient 增加“claim 槽位释放”提示，需单独评估 outbox 与唤醒风暴。
- **codex snapshot 失败**：`client/monitor/codex.ts` 的 `snapshot()` 查询失败仍直接 `WatchStop`；它有独立 turn 重试，本次未改，建议后续统一退避。
- **dsh**：不自动 claim，宿主负责 claim；本次不改变其语义。
- **进程退出**：本地待领队列只在内存中；monitor 被宿主回收后，仍依赖下次启动/重连快照补领 pending。
- **卡住的自身 claim**：deferred 重试不会自动 complete/fail 当前 claim；仍需宿主按技能要求 complete/fail，或由接收者 `network_delivery_retry` 放回 pending。
