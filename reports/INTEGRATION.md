# 集成报告 · G02 / M03

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 上一波次基线 | `a5e2cc995e601a9222e85e74420d19cd234db69f`（`docs(integration): G05/G07/M02/M07 集成报告与文档校正`） |
| G02 实现 / 报告提交 | `466a8b734603184fad99a6b37f77cf14893020ea` / `f8d25d6f8b947035d752bf3513d1cc2dc7a0cb38` |
| M03 实现 / 报告提交 | `b93a0004bdf29048fe620e1939108c62a5854535` / `74ed15e1aed540bb961be6b7c87e3ca0c132cb82` |
| 本轮审查起点 HEAD | `74ed15e1aed540bb961be6b7c87e3ca0c132cb82` |
| 本轮修复提交 | `4c38c0998c4a50725d76340e0335526224036ace` |
| 集成报告提交 | 本文件所在提交（`git log -1 -- reports/INTEGRATION.md`） |
| 运行环境 | Bun 1.4.2，macOS；`DATA_DIR=/tmp/an-integration-g02m03-final`、`PORT=8792`、`PUBLIC_ORIGIN=http://127.0.0.1:8792` |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | 六套门禁与 G02/M03 专项全部通过；未发现服务端/领域集成回归。修复 1 个网页文件行数约束回归与 1 组仍描述旧行为的文档回归。G02/M03 保持 `READY_FOR_REVIEW`，A05-T01 仍 BLOCKED |

## 0. 审查范围与结论

本轮在 `74ed15e` 之上审查 G02（邀请链接/二维码与入群审批）与 M03（结构化提及与确定性唤醒）的合并结果，重点是两个任务的公共接缝，而不是重新设计：

- 迁移顺序 `0027_group_invite_links.sql` → `0028_message_mentions.sql` 在全新库按序应用；`scripts/lib/feedback-unit.ts` 的旧库升级清单同时包含 `0027` 与 `0028`。
- 两个任务都改到 `src/contracts/schemas.ts`、`src/mcp/{tools,outputs,skill}.ts`、`src/realtime/stream.ts`、`src/storage/{guards,transactions/runner}.ts`、`src/web/chat-script.ts` 与验收脚本；合并后工具面、事件映射和网页脚本没有互相覆盖。
- `GUARD_TABLES` 同时包含 G02 的 `guard_join_request_stale`、`guard_room_invite_limit` 与 M03 的 `guard_invalid_mention`；`runner.ts` 分别映射为 `CONFLICT`、`QUOTA_EXCEEDED` 与 `INVALID_ARGUMENT`。
- G02 的 `room_join_*`/`room_invitation_revoked` 与 M03 的 `mention_reminder` 在 `stream.ts` 中各自有独立分支；`mention_reminder` 以 inbox scope delta=0 推进 head，不创建 delivery、不增加 `pending_count`。
- 网页端 G02 邀请/审批面板与 M03 @ 选择器共存于同一内联脚本，无重复 DOM id；`test:web` 的 G02 与 M03 段落均通过。

未发现需要改服务端或领域代码的集成回归。发现并修复：

1. **行数约束回归（代码）**：M03 把 `src/web/chat-script.ts` 从 878 行增至 `wc -l` 1000 行（末行无换行，编辑器计 1001 行），触及仓库“各文件须低于 `STD-SIZE-001` 1000 行”的约束。已将 @ 选择器与提及解析的 5 个函数原样拆到新文件 `src/web/chat-mention-script.ts`，仍拼进同一个 `<script>` 共享作用域；`chat-script.ts` 回到 854 行，工具契约、DOM id/class 与页面行为不变。
2. **文档回归（仅文档）**：`README.md`、`CLAUDE.md`、`docs/code-index.md` 仍有段落描述 M03 已删除的“相邻 Agent 自动投递”和“上传自动 @WeBots 维护员”，并保留 `751`/`504`/`723`/`49 个工具` 等旧计数。已按当前实现校正为显式 `invoke`/`mentions`、无隐式投递与 `762`/`1380`/`90 个工具`，并把 `chat-mention-script.ts` 加入页面拆分索引。

## 1. G02 邀请链接与入群审批

- `0027` 新增 `room_join_requests`、`guard_join_request_stale`、`guard_room_invite_limit`，重建 `room_management_audit` 的 action CHECK 并恢复审计索引；不另建同义邀请表，继续以 `room_invitations` 为唯一权威来源。
- 新增 4 个工具（`network_room_invite_create`、`network_room_invite_revoke`、`network_room_join_request_list`、`network_room_join_request_respond`），`network_room_invite_get` 扩展为按 `invite_key` 预览、按 `room_id` 列链接、缺省列个人定向邀请；工具总数 90，关闭 Drive 为 85。
- 链接默认 7 天 / 20 次，单群同时有效链接 20；服务端只保存 key 摘要，明文 `invite_key` 与 `${PUBLIC_ORIGIN}/j/<key>` 只在创建响应出现一次。打开者先预览最小群介绍，确认前不写成员、不消费次数；审批策略下只创建 pending 申请。
- 批准在同一 `db.batch()` 内复核邀请状态、有效期、剩余次数、邀请版本、拉黑、申请人 `removed` 状态与 100 人容量，再消费一次邀请并写 active 成员、审计与通知；失败申请保留行但按邀请状态派生为 `expired`。
- 移除后的旧链接与旧定向邀请都不能重入；重新加入递增 `member_generation`，历史下界从本次加入事件开始。
- G02 专项 `runGroupInviteLinkAcceptance()` 实测 `85` 项通过（G02-T01–T04）。

## 2. M03 结构化提及与确定性唤醒

- `0028` 新增 `message_mentions(message_id, actor_id, actor_kind, source = explicit|text|all)`、`idx_message_mentions_actor` 与 `guard_invalid_mention`；同一消息对同一成员至多一行，来源按 `all < text < explicit` 归并。
- `network_message_send` 的 `invoke` 只接受 Agent，是唯一派活来源；`mentions` 只接受人类，是个人提醒，不创建 delivery、不改变 `pending_count`、不推进 `rooms.head_seq`。显式 `invoke: []` 始终关闭派活。
- 省略 `invoke` 时只对 group、非 claim 回复解析正文顶层；代码块、行内代码、引用行与 `http(s)://` URL 不参与。按当前 active 成员名精确、大小写敏感、最长优先匹配；同名成员返回 `INVALID_ARGUMENT`，正文目标超过 `LIMITS.invokeMax` 同样拒绝，不截断。
- `@所有人` 受 `mention_all` 权限约束，只为人类成员写 `source = all` 提及与个人提醒，不批量创建 Agent 工作或 delivery；发送者自己除外。
- 已删除“上一条 Agent 自动投递”的 `resolveAdjacentAgentSender` 路径与上传自动 `@WeBots 维护员`；仓库内无旧路径引用。direct 的房间接收者只由网页显式 `invoke` 或 MCP/CLI 调用方显式指定，服务端不再猜测。
- 网页选择器按房间保存 `{ actor_id, name, kind }`，Agent 进 `invoke`、人类进 `mentions`；提交前按当前 `members` 复核，成员移除或改名时报错并保留输入；outbox 持久化 `mentions` 与 `invoke_explicit`，旧意图可继续对账/重试。
- `mention_reminder` 写入 recipient 的 inbox 事件与统一流 `mention.reminder` informational 项，不写 `inbox:{actor}` 的待办提示、不增加 `pending_count`；`src/realtime/stream.ts` 与 `src/contracts/events.ts` 命名一致。
- M03 专项实测 `123` 项通过（结构化提及 `92` + 无隐式投递 `31`）。

## 3. 跨功能接缝核对

- **迁移与旧库升级**：全新库按 `0027` → `0028` 顺序应用；`feedback-unit` 的旧库升级断言包含两份迁移，迁移后 `feedback`/`room_tasks` 与既有业务数据保留。
- **错误映射**：G02 的 `inviteExhausted` → `INVITE_EXHAUSTED`、`requestExpired` → `REQUEST_EXPIRED`、`roomFull` → `ROOM_FULL`、`roomInviteLimit` → `QUOTA_EXCEEDED`、`joinRequestStale` → `CONFLICT` 与 M03 的 `invalidMention` → `INVALID_ARGUMENT` 并存，无同名 guard 冲突。
- **通知与流**：G02 的入群申请/批准/拒绝/撤销分别映射到房间与申请人 inbox；M03 的 `mention_reminder` 映射为 `reminder` informational。两者都不改写 `rooms.head_seq`，也不把提醒计成待办。
- **工具面**：协议验收断言 90 个工具的清单与顺序、关闭 Drive 时为 85；G02 的 4 个新工具与 M03 的 `mentions` 输入/输出 schema 同时存在。
- **网页**：G02 的 `#members-invites`、`#members-requests`、`/j/<key>` 与 M03 的 `#mention-picker`、同名成员选择、outbox 重试共用同一脚本作用域；`test:web` 的 1911 项覆盖两段。
- **文件大小**：`src/web/chat-script.ts` 854 行、`chat-mention-script.ts` 156 行，其余 `src/web/*.ts` 均低于 1000 行。

## 4. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun install` | 通过 | 安装 1 个包，`bun.lock` 无变化 |
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0 |
| `bun run test:protocol` | 通过 | `协议验收通过: 762 项` |
| `bun run test:acceptance` | 通过 | `端到端验收通过: 1380 项`（服务端与测试进程使用短 presence 窗口） |
| `bun run test:web` | 通过 | `浏览器验收通过 1911 项`（脚本自托管临时实例） |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项` |
| `bun run test:drive` | 通过 | `drive checks passed: 52` |
| G02 + M03 专项 | 通过 | `g02=85 mention=92 no-implicit=31 total=208` |
| `git diff --check` | 通过 | 无 whitespace 错误 |

主实例启动方式：

```bash
DATA_DIR=/tmp/an-integration-g02m03-final \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8792 \
FILE_TICKET_SECRET=integration-local-secret \
PORT=8792 bun run start
```

`test:protocol`、`test:acceptance` 与 `test:drive` 默认指向 `http://127.0.0.1:8792`；`test:web` 与 `test:events` 各自启动临时实例。`test:acceptance` 的既有 presence 用例要求服务端与测试进程同时使用短窗口，否则会在“关闭最后一个连接后成员显示离线”等待超时；这是运行配置，不是代码回归。

## 5. 本轮改动

- `src/web/chat-mention-script.ts`（新增）：承接 `hideMentionPicker`、`updateMentionPicker`、`insertMention`、`mentionSelectionsFor`、`resolvedMentionSelection`，正文与错误文案原样保留。
- `src/web/chat-script.ts`：删除上述函数并改为引用 `${CHAT_MENTION_SCRIPT}`，文件从 1000 行回到 854 行；页面行为不变。
- `README.md`：协议验收默认计数 `751 → 762`；端到端验收计数 `504 → 1380`。
- `CLAUDE.md`：网页发送、附件上传与 MCP Events 段落改为显式 `actor_id` 派活/提醒，删除相邻 Agent 自动投递与上传自动 @ 维护员描述。
- `docs/code-index.md`：同步网页发送与附件规则、页面拆分索引（新增 `chat-mention-script.ts`）、附件表格行、协议/端到端计数与无隐式投递说明。
- `reports/INTEGRATION.md`：本报告。

## 6. 已知限制与未完成 P0

G02 与 M03 的实现范围均已完成，保持 `READY_FOR_REVIEW`，需独立验证者在集成 SHA 上签收。任务自身记录的限制继续有效：

- G02：链接是持有者能力，不能指定“仅某人可加入”；审批附言未开放；`expired`/`exhausted` 在读取时派生；邀请列表与链接查询各有一份视图 `SELECT`；主动邀请沿用每身份 10 分钟 60 次的既有窗口限制。
- M03：正文 `@名字` 只是输入便利，不是稳定身份来源；`@所有人` 提醒扇出按人类成员数增长；网页选择按房间保存，删除正文 `@名字` 会丢弃对应选择；direct 的 MCP/CLI 发送必须显式传 `invoke`；本轮未做远端部署验收。

仍未实现的 P0：

- **A 组**：A06。
- **G 组**：G06。
- **D 组**：D01–D08。
- **Q 组**：Q01、Q02、Q04、Q05。

依赖与阻塞：

- **A05-T01 BLOCKED**：“拒绝定向任务提议”依赖 D01/D02 的提议/交接 API，当前仓库未实现，无法验证；A05 保持 `PARTIAL/BLOCKED`。
- G02 的邀请入口依赖 G01 好友关系与群策略；M03 的网页提及依赖 G07 的 `mention_all` 策略与 M02 的 outbox 对账，均已在集成验收中覆盖。
- Q01 仍负责 README/CLAUDE/技能正文与全部文档的全量对齐；本轮只修正 G02/M03 直接影响的过期段落与计数。

## 7. 最终状态

- 审查起点：`74ed15e1aed540bb961be6b7c87e3ca0c132cb82`（`docs(reports): M03 任务报告`）。
- 修复提交：`4c38c0998c4a50725d76340e0335526224036ace`。
- 集成报告提交：本文件所在提交（`git log -1 -- reports/INTEGRATION.md`），在 `fix/webots-parity-pack` 上普通 push，无 force。
- 测试计数：typecheck 通过、protocol 762、acceptance 1380、web 1911、events 339、drive 52；专项 G02 85、M03 123。
- 未部署、未创建 PR、未触发生产验收。
- A05-T01 仍 BLOCKED（依赖 D01/D02）；A05 仍为 `PARTIAL/BLOCKED`。
