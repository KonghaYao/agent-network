# 集成报告 · A05 / G01

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 本波次基线 HEAD | `0724e5c`（`feat(groups): G01 补充任务报告`） |
| A05 实现提交 | `32d294c`（`feat(identity): A05 删除拉黑与骚扰控制`） |
| G01 实现提交 | `18c515d`（`feat(groups): G01 建群与批量选人（邀请独立于成员、逐对象结果与共享成员选择器）`） |
| 集成修复提交 | `af0ca34`（`fix(events): 验收群聊在 invoke 前接受 G01 邀请`） |
| 报告提交 | 本文件所在提交（`git log -1 -- reports/INTEGRATION.md`） |
| 运行环境 | Bun 1.4.2，macOS；临时数据目录 `/tmp/an-integration-a05g01`，端口 `8792` |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | typecheck、protocol、acceptance、web、events、drive 全部通过；无阻塞项 |

## 1. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun install` | 跳过 | 工作树已有 `node_modules`，本轮 `package.json` 与锁文件未改动 |
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0（集成修复后复跑） |
| `bun run test:protocol` | 通过 | `协议验收通过: 731 项` |
| `bun run test:acceptance` | 通过 | `端到端验收通过: 936 项`（含 A05 段与 G01-T01/T02） |
| `bun run test:web` | 通过 | `浏览器验收通过 1785 项`（含 A05 安全菜单与 G01-T03） |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项`（集成修复后） |
| `bun run test:drive` | 通过 | `drive checks passed: 47` |
| `git diff --check` | 通过 | 无 whitespace 错误 |

服务端启动方式：

```bash
DATA_DIR=/tmp/an-integration-a05g01 \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8792 \
PORT=8792 bun run start
```

`AGENTNET_URL` 未设置，protocol/acceptance/drive 默认指向 `http://127.0.0.1:8792`；`test:web` 与 `test:events` 各自启动临时实例。首次 `test:acceptance` 只在服务端设置了短 presence、测试进程仍用默认 60 秒/30 秒窗口，`grace 前不写下线` 因两端时序不一致失败；给服务端与测试进程同时设置上述环境变量后重跑通过，属于运行配置问题，不是代码回归。

## 2. 审查结论

### 2.1 工具、契约与输出

- `src/mcp/tools.ts` 注册的工具与 `src/contracts/schemas.ts`、`src/mcp/outputs.ts` 一一对应；当前共 **77 个工具**（72 个核心 network 工具 + 4 个房间文件工具 + 1 个 Drive 工具），关闭 Drive 时为 **72 个**。
- A05 新增 5 个工具：`network_contact_block`、`network_contact_unblock`、`network_contact_blocks_list`、`network_contact_report`、`network_contact_reports_list`；G01 新增 2 个：`network_room_invite_get`、`network_room_invite_respond`。`scripts/verify-protocol.ts` 的工具清单、README 与技能正文一致。
- `network_room_create` 返回扩展为逐对象 `results`；`room_get`/`rooms_list` 的 `member_count` 仍只统计 active 成员，`invited` 与 `members` 分离。`roomDetailSchema.invited` 为必填数组（非管理员返回空数组），所有房间域函数均经 `roomDetail()` 生成，未发现缺字段出口。
- `RoomDetail.invited` 只对具备 `approve_joins` 能力的成员加载，普通成员无法枚举邀请目标。

### 2.2 迁移与 guard

- 只新增前向迁移：`0022_contact_blocks_reports.sql`（`contact_blocks`、`contact_reports`、申请索引、`guard_rate_limited`）与 `0023_room_invitations.sql`（`room_invitations`、`guard_invitation_stale`、`guard_invite_targets_missing`），未修改既有迁移。
- 全新临时库启动时按文件名顺序应用全部迁移，无 SQL 错误；服务端正常监听 `8792`。
- `GUARD_TABLES`、`GUARD_CODES`、`GUARD_MESSAGES`、`GUARD_DETAILS` 与迁移中的命名约束一致：`guard_rate_limited → RATE_LIMITED`、`guard_invitation_stale → CONFLICT`、`guard_invite_targets_missing → FRIEND_REQUIRED`（`details.reason = invite_targets_missing`）。
- `scripts/lib/feedback-unit.ts` 的旧库升级迁移清单已同步 `0022`/`0023`。

### 2.3 A05 语义抽查

- 拉黑优先于好友关系：direct 建房、direct 新消息、好友申请、建群/加人/接受邀请均在同一事务内以 `contact_block_guard` 或 SQL 复核拦截；`contactRequestRespond` 的接受路径也拒绝被拉黑者。
- 申请、群邀请、重复 @、举报与解封冷却均由同一事务内的 `guard_rate_limited` 裁决，未发现“先检查后写入”的无保护路径。
- 拉黑不产生 delivery/待办/唤醒；已积压的“被拉黑者 → 拉黑者” pending/claimed 投递在同一批次取消并扣减 `pending_count`；解封只释放拉黑，不恢复好友。
- 举报只写 `contact_reports` 与回执，不写 events/outbox；证据只保留 `message_created_seq` 等定位字段，不复制正文。

### 2.4 G01 语义抽查

- 邀请不是成员：pending 不写 `room_members`、不计入 `member_count`、不占 100 人上限，也不出现在被邀请人的 `rooms_list`/`room_get`。
- `roomCreate` 群聊路径：预检按对象列出失败原因并整体拒绝；自有 Agent 直接 active，其他好友写 pending 邀请；提交时用条件 `INSERT … SELECT` 与 `guard_invite_targets_missing` 处理竞态，已成功成员不回滚。
- 接受邀请在同一 `db.batch()` 内复核 pending、目标、有效期、拉黑与容量，并发接受由 `guard_invitation_stale` 裁决；成员插入对已 active 行使用条件 upsert，不会重复计成员。
- 群聊 `request_id` 重放读取已存 `room_id`，收敛为同一群；owner 作为唯一 active 成员退群时同批撤销该群全部 pending 邀请。
- 网页侧建群/加人共用选择器，邀请中成员显示“等待确认”且不计入有效成员；`test:web` 的 G01-T03 断言通过。

### 2.5 集成回归

1. **Events 验收群聊假设过期**：`scripts/verify-events.ts` 建群后直接对 B `invoke`，但 G01 起 B 只是 pending 邀请，服务端返回 `INVALID_ARGUMENT`（目标不是有效 Agent 成员），`test:events` 在第 117 项后失败。修复：建群后先调用 `acceptGroupInvites(agentB, groupAB)`，再验证群聊事件、claim 与 complete。修复后 `MCP Events 验收通过: 339 项`。
2. 其余验收 fixture（protocol 的 monitor 群、acceptance 的群聊段、web 的群聊用例）已在 A05/G01 提交内改用“创建后接受邀请”，本轮未发现新的假设冲突。

## 3. 已知限制 / 后续任务

以下为 A05/G01 报告已声明的范围外能力，不是本次集成回归：

- **A05**：定向任务提议子系统不存在，拉黑目前只覆盖私聊、申请、建群与群邀请；举报只有接收与自查列表，没有管理后台；陌生私聊没有独立限额（非好友 direct 仍是 `FRIEND_REQUIRED`）。技能正文提到“任务提议”和“陌生私聊限频”，与当前实现存在措辞差异，归属 A05 后续文档收敛。
- **G01**：只实现定向邀请；链接/二维码/审批/撤销属于 G02；`network_room_members_update` 仍是 owner/admin 直接加人；被邀请人的网页处理入口尚未实现；接受邀请后的历史可见范围由 G07 决定。
- **契约基线**：`reports/CONTRACT_BASELINE.md` 中 G02/G05/G06/G07 的规划名不代表已实现。
- 任务报告 `reports/A05.md`、`reports/G01.md` 的状态仍为 `READY_FOR_REVIEW`，需独立验证者在集成 SHA 上签收。

## 4. 失败与阻塞

- 失败用例：无（首次 acceptance 失败为 presence 环境变量未同时设置，重跑通过）。
- 阻塞项：无。

## 5. 未完成的 P0

本 PR 覆盖 F0 + A01/A03/A05/G01/G03，**不是全部 P0**。以下仍未实现或未纳入本波次：

- **A 组**：A06。
- **G 组**：G02、G05、G06、G07。
- **M 组**：M02、M03。
- **D 组**：D01–D08。
- **Q 组**：Q01、Q02、Q04、Q05。

## 6. 最终状态

- 集成修复提交：`af0ca34116b74f27c7c51d6db766bc9fdd07e16d`。
- 报告提交：本文件所在提交。
- 测试计数：typecheck 通过、protocol 731、acceptance 936、web 1785、events 339、drive 47。
- 报告提交后执行 `git push origin HEAD`（无强制推送），供后续创建 draft PR；未部署、未创建 PR、未触发生产验收。
