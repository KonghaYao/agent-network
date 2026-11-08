# Agent 群消息自动 @ 前一个有效成员

状态：**VERIFIED**

- 基线：`1501873`（Q05 完成，全部 P0 已实现）
- 结果代码 SHA：`d7bf63a`（实现与专项）、`c2d0e70`（Web Markdown 用例固定派口语义）
- 工作区：`/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack`
- 分支：`fix/webots-parity-pack`
- 迁移：无

## A. 人类附件自动 @（恢复 main `2fcd75b` 语义）

`src/web/chat-upload-script.ts` 恢复 `COMPOSER_MENTION_NAME`、`COMPOSER_MENTION`、`composerAutoMention` 与 `composerOutgoingBody` 的自动追加逻辑：

- 仅当当前发送房间是 `group`、当前用户不是目标、群内恰好有一个 active Agent 名称精确等于 `WeBots 维护员` 时，在附件正文末尾追加 `@WeBots 维护员`。
- direct、没有该成员、同名多个、正文已包含该字符串时不追加。
- 只影响发送正文；不写入 `mentionSelections`，不改变显式 `invoke`/`mentions` 选择。服务端随后仍按既有规则解析正文，与 main 的 `2fcd75b` 行为一致。
- 附件与自动 @ 按 `room_id` 读取/构建，切房不串。

`scripts/verify-web.ts` 的 12e 段恢复/新增断言：

| 用例 | 结果 |
| --- | --- |
| 只有前缀 `WeBots`、无精确维护员：不追加、不误投 | PASS |
| 唯一精确维护员：附件追加一次并投递给它 | PASS |
| 同群 `WeBots` 不被精确 @ 误投 | PASS |
| 正文已有 `@WeBots 维护员`：不重复追加，仍投递一次 | PASS |
| 同名两个维护员：不追加、不投递 | PASS |
| direct 附件：不追加 | PASS |
| 切房：不带上另一房间的附件或自动 @ | PASS |
| 发送期间快照包含当前群附件与自动 @ | PASS |

## B. Agent 群消息自动 @ 前一个有效成员

领域层实现位于 `src/domain/messages.ts` 的 `agentAutoMentionPlan`，`messageSend` 统一调用，因此 Web/Agent/MCP 三个入口同语义。

触发条件：

- 发送者 `kind = 'agent'`；
- 房间 `kind = 'group'`；
- 正文非空；
- 未提供 `invoke`（显式 `invoke: []` 同样视为已提供，不触发）；
- `mentions` 为空（未提供或 `[]`）。

目标选择：

- 从当前消息之前向前最多扫描 20 条消息；
- 跳过发送者自己；
- 只考虑按发送者 `historyBoundary` 可见、来源 actor 仍为当前群 active 成员的消息；
- 取最近一条不同 actor 的消息发送者；
- 目标名字在当前 active 成员中必须唯一；同名歧义直接跳过，不猜；
- 前一条发送者已被移除时继续向前回退；没有更早有效成员则不追加。

正文与幂等：

- 追加 `\n@<name>`；正文已包含独立 `@<name>` 时不重复；
- 追加后超过 `LIMITS.messageBodyBytes` 时跳过自动 @，消息仍按原正文发送；
- 自动 @ 只写 `message_mentions` 的 `source = text`（沿用现有枚举，不新增迁移），人类目标额外写既有 `mention_reminder` inbox 事件；
- 自动 @ 目标不进入 `invoke`，不会创建 Agent delivery、不增加 `pending_count`、不额外推进 `rooms.head_seq`；
- 正文解析仍只读取原始正文，追加部分不会改变原派活对象；
- 幂等重放返回原消息与原文；`client_message_id` 冲突时按原消息之前的历史重算自动 @，不重复追加；不同正文仍返回 `IDEMPOTENCY_CONFLICT`。

专项 `scripts/lib/auto-mention-acceptance.ts`（已注册到 `scripts/acceptance.ts`），73 项检查：

| 用例 | 结果 |
| --- | --- |
| 人类前一条 → Agent 回复自动 @ 人类，text 提及 + reminder，无 delivery，pending/head 不变 | PASS |
| Agent 前一条 → 自动 @ Agent，无 delivery、pending 不变 | PASS |
| 两个 Agent 互相回复不产生隐式 delivery | PASS |
| direct 不追加 | PASS |
| 正文已有 @ 不重复 | PASS |
| 显式 `invoke` 不自动 @，仅投显式目标 | PASS |
| 显式 `invoke: []` 不自动 @ | PASS |
| 非空 `mentions` 不自动 @ | PASS |
| 前一条发送者被移除 → 回退到更早 active 成员 | PASS |
| 无更早 active 成员 → 不追加 | PASS |
| 同名歧义 → 跳过 | PASS |
| 接近正文上限 → 跳过自动 @，原文发送 | PASS |
| 同 `request_id` 重放不重复追加 | PASS |
| 同 `client_message_id` 重放不重复追加 | PASS |

## 门禁结果

服务端使用本地 Bun + SQLite，`DATA_DIR=/tmp/agent-network-auto-mention`、端口 `8792`。全量 acceptance 使用服务端与测试进程一致的短 presence 窗口：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000`。

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | PASS |
| `bun -e "... runAutoMentionAcceptance()"` | PASS，73 项 |
| `AGENTNET_URL=http://127.0.0.1:8792 bun run test:protocol` | PASS，991 项 |
| `AGENTNET_URL=http://127.0.0.1:8792 ... bun run test:acceptance` | PASS，2688 项 |
| `bun run test:web` | PASS，2015 项 |
| `AGENTNET_URL=http://127.0.0.1:8792 bun run test:events` | PASS，339 项 |
| `AGENTNET_URL=http://127.0.0.1:8792 bun run test:drive` | PASS，52 项 |

`test:web` 的 Markdown 用例显式传 `invoke: []`，避免自动 @ 改变“单换行/段落/br”断言；Markdown 渲染行为本身未改动。

## 文档

- `src/mcp/skill.ts` 与 `public/skills/agent-network-skills.md`：说明 Agent 群消息自动 @ 只作显示/提醒、只有显式 `invoke` 唤醒 Agent、`invoke: []`/非空 `mentions` 不追加，以及网页附件自动 @ 恢复。
- `network_message_send` 工具描述补充同一语义。
- `README.md` / `CLAUDE.md` 更新当前行为与测试计数。

## 限制与未完成项

- 自动 @ 只覆盖 `network_message_send`；`network_delivery_complete` 的 `final_body` 仍不自动追加（其既有语义是不产生新 invoke）。
- 扫描窗口固定为最近 20 条；窗口内没有不同 actor 的有效 active 成员时不追加。
- 名字唯一性按当前 active 成员计算；发送后 target 改名/移除不会回溯修改已存消息。
- `client_message_id` 幂等冲突重算依赖原消息之前的历史；若 target 在两次调用之间被改名或移除，重放可能返回 `IDEMPOTENCY_CONFLICT` 而不是旧消息。
- `message_mentions.source` 仍只有 `explicit | text | all`；自动 @ 复用 `text`，没有新增迁移。
- 全量 acceptance 需要短 presence 窗口；默认窗口下既有 30 秒在线断言会超时，这是既有测试配置限制。
