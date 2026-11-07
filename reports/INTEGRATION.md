# 集成报告 · G05 / G07 / M02 / M07

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 上一波次基线 | `500d661`（`chore: merge origin/main and re-run gates`；A05/G01 集成报告） |
| G05 实现 / 报告提交 | `a0963ff` / `0364bd5` |
| G07 实现 / 报告提交 | `92983f3` / `28d3b9b` |
| M02 实现 / 报告提交 | `894cf04` / `7b4b300` |
| M07 实现 / 报告提交 | `98aa2b1` / `10cbae1` |
| 本轮审查起点 HEAD | `10cbae1c69cfceeaab9ce44326c61f62c26c830c` |
| 集成报告提交 | 本文件所在提交（`git log -1 -- reports/INTEGRATION.md`） |
| 运行环境 | Bun 1.4.2，macOS；主实例 `DATA_DIR=/tmp/an-integration-webots-parity-pack`、端口 `8792`；M07 专项实例 `DATA_DIR=/tmp/an-integration-m07-port18890`、端口 `18890` |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | 六套门禁全部通过，未发现需要改产品代码的集成回归；修正 3 处文档回归。G05/G07/M02/M07 保持 `READY_FOR_REVIEW`，M07 不再列为未实现 P0；A05-T01 仍 BLOCKED |

## 0. 审查范围与结论

本轮在 `500d661` 之上审查四个功能的合并结果：G05 群主转让确认、G07 群策略历史边界与管理记录、M02 消息发送状态与可靠补读、M07 私有文件授权与成果保留。重点检查跨功能接缝，而不是重新设计：

- 迁移顺序 `0024_room_owner_transfers.sql` → `0025_group_history_boundary.sql` → `0026_private_files_retention.sql` 在全新库按序应用；`GUARD_TABLES` 与 `runner.ts` 同时包含 `guard_owner_transfer_stale`、`guard_file_unavailable`、`guard_artifact_conflict`、`guard_file_referenced`。
- G05 扩展的 `room_management_audit` 动作同时被 G07 的 `room-notices.ts`、`outputs.ts` 与 `stream.ts` 消费；G07 重建审计表时保留 G05 新动作，未出现只在一处支持的枚举。
- G07 的 `historyBoundary`/`visibleCreated` 被 M07 的文件授权直接复用；M07 的 v2 文件票据、`drive_files` 私有草稿与显式发布没有绕过 G07 的成员代次、`policy_revision` 与历史边界。
- M02 的 `network_message_send_status` 是只读工具，不写 events/outbox、不推进 `head_seq`；网页 outbox 与 G07/M07 的文件卡片、上传 chip 互不覆盖，切换房间时只更新对应房间。
- 工具面为 **86 个**（关闭 Drive 为 **81 个**）；`scripts/verify-protocol.ts` 的清单、README 与技能正文一致。`scripts/lib/feedback-unit.ts` 的旧库升级清单已包含 `0024`–`0026`。
- 未发现需要改产品代码的集成回归。发现并修正的均是文档回归：
  1. README 的 M07 状态行引用不存在的 `test:room-files` npm script；改为实际执行的 `bun scripts/verify-room-files.ts`。
  2. README 与 `docs/code-index.md` 仍写房间文件验收 `187 项`；实测为 `193 项`，已同步。
  3. `docs/code-index.md` 的“房间文件”段仍称未绑定上传保持公开；M07 起上传默认是私有草稿，只有 `network_file_publish` 显式发布后才允许裸链，已改正。

## 1. 四个功能的集成核对

### G05 群主转让确认

- `0024` 新建 `room_owner_transfers` 与 `guard_owner_transfer_stale`，重建 `room_management_audit` 并保留旧行；G05 的 `owner_transfer_*` 动作可被 G07 的通知列表读取。
- 提议/接受/拒绝/取消工具均返回完整 `roomDetail`，`network_room_owner_transfer` 仅作为 propose 兼容别名；`room_get` 的 `owner_transfer` 与 G07 新增的 `authorization`/策略字段并存。
- 接受只改 `rooms.owner_id`、双方角色与 `role_revision`，不写 delivery、不推进 `head_seq`、不增加 `pending_count`；`test:acceptance` 的 G05 专项 67 项与 `test:web` 的 23 项通过。
- 已知边界：没有后台过期扫描，过期在读取时隐藏、下次发起时收敛；G06 解散尚未实现；24 小时真实过期未做时间旅行验收。

### G07 群策略历史边界与管理记录

- `0025` 新增成员代次、4 项策略列与 `room_files.created_seq`/`room_tasks.created_seq`；历史、时间线、sync、任务、文件、房间摘要与 `/f` 共用 `historyBoundary`。
- 重新加入递增 `member_generation` 并重置未读水位；旧代次游标返回 `CURSOR_EXPIRED`，跨视图仍是 `INVALID_ARGUMENT`。
- `network_room_notice_list` 只返回影响调用者的脱敏摘要；owner/admin 的详细审计仍走 `network_room_role_history`。
- M07 接管文件票据后，G07 的票据/边界验收仍全部通过；`test:acceptance` 的 G07 专项与 `test:web` 文件卡片用例未回归。
- 已知边界：入群审批强制执行依赖 G02、资料编辑强制执行依赖 G04；搜索/收藏/转发/引用预览入口依赖 M04/M05/M08；策略编辑与通知列表暂无网页入口。

### M02 消息发送状态与可靠补读

- `network_message_send_status` 按发送者自己的 `client_message_id` 返回定位信息，不返回正文/preview；撤权后仍可确认是否已提交，但新的发送与正文读取仍按成员资格拒绝。
- 无新增迁移；复用 `messages(sender_id, client_message_id)` 唯一约束。100 个并发同意图收敛为一条消息、一组 delivery，冲突返回既有 `message_id` 且不推进 head。
- 网页 outbox 按 actor 隔离保存在 `localStorage`，响应丢失、刷新、重连与重试前先对账；切群与迟到响应只更新对应房间。M02 专项 50 项与网页 28 项通过。
- 已知边界：对账指纹是 `body_bytes` 而非正文摘要；本地意图不跨设备；失败意图只显式重试，不自动重发。

### M07 私有文件授权与成果保留

- `0026` 新增 `drive_files`、`artifacts`、`file_references`、`room_files.retained` 与 3 个闸门；上传即私有草稿，绑定后为普通附件，成果/任务引用后 `retained = 1`。
- `authorizeFileDownload` 是 `/f` 唯一授权入口：绑定文件校验房间票据、active 成员、成员代次、`policy_revision` 与历史边界；未绑定文件要求文件票据；只有显式 `network_file_publish` 公开后才允许裸链。
- `network_file_publish`、`network_artifact_submit/list/release` 只在启用 MCPP Files 时注册；成果提交与释放同事务，GC 先释放失效 task 引用、再软删、宽限期后清理载荷。
- `test:m07` 94 项、`scripts/verify-room-files.ts` 193 项、`test:drive` 52 项通过；`reports/BASELINE.md` 的 SEC-01（公开 `/f`）与 BLOCK-01（M07 未实现）在本轮解除。
- 已知边界：转发/收藏引用已支持但写入方属于 M05/M08；没有独立公开缩略图端点；`FILE_TICKET_SECRET` 未配置时重启后旧票据失效，多实例必须共享。

## 2. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun install` | 通过 | 同步依赖，安装 1 个包；`bun.lock` 无变化 |
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0 |
| `bun run test:protocol` | 通过 | `协议验收通过: 751 项` |
| `bun run test:acceptance` | 通过 | `端到端验收通过: 1261 项` |
| `bun run test:web` | 通过 | `浏览器验收通过 1871 项` |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项` |
| `bun run test:drive` | 通过 | `drive checks passed: 52` |
| `AGENTNET_URL=http://127.0.0.1:18890 bun run test:m07` | 通过 | `M07 checks passed: 94`（额外复跑） |
| `AGENTNET_URL=http://127.0.0.1:18890 DATA_DIR=/tmp/an-integration-m07-port18890 bun scripts/verify-room-files.ts` | 通过 | `room file checks passed: 193`（额外复跑） |
| `git diff --check` | 通过 | 无 whitespace 错误 |

主实例启动方式：

```bash
DATA_DIR=/tmp/an-integration-webots-parity-pack \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8792 \
FILE_TICKET_SECRET=integration-local-secret \
PORT=8792 bun run start
```

`test:protocol`、`test:acceptance` 与 `test:drive` 默认指向 `http://127.0.0.1:8792`；`test:web` 与 `test:events` 各自启动临时实例。`test:acceptance` 的既有 presence 用例要求服务端与测试进程同时使用短窗口，否则会在“关闭最后一个连接后成员显示离线”等待超时；这是运行配置，不是代码回归。

## 3. 本轮改动

只改文档，不改产品代码：

- `README.md`：M07 状态行改用真实命令 `bun scripts/verify-room-files.ts`；房间文件验收计数 `187 → 193`。
- `docs/code-index.md`：房间文件验收计数 `187 → 193`；未绑定上传的公开语义改为“默认私有草稿，显式发布后才可裸链读取”。
- `reports/INTEGRATION.md`：本报告。

## 4. 已知限制与未完成 P0

四个任务均保持 `READY_FOR_REVIEW`，需独立验证者在集成 SHA 上签收。M07 的实现范围已完成，因此不再列入“未实现 P0”；其转发/收藏引用写入、独立缩略图与密钥运维限制已在上文记录。

仍未实现的 P0：

- **A 组**：A06。
- **G 组**：G02、G06。
- **M 组**：M03。
- **D 组**：D01–D08。
- **Q 组**：Q01、Q02、Q04、Q05。

依赖与阻塞：

- **A05-T01 BLOCKED**：“拒绝定向任务提议”依赖 D01/D02 的提议/交接 API，当前仓库未实现，无法验证；A05 保持 `PARTIAL/BLOCKED`。
- G05 的 G06 解散失效路径、G07 的 G02/G04 强制执行、M07 的 M05/M08 引用写入都依赖后续任务，不能提前签收。
- Q01 仍负责 README/CLAUDE/技能正文与全部文档的全量对齐；本轮只修正 M07/G07 直接影响到的 3 处。

## 5. 最终状态

- 审查起点：`10cbae1c69cfceeaab9ce44326c61f62c26c830c`（`docs(media): M07 任务报告`）。
- 集成提交：本文件所在提交（`git log -1 -- reports/INTEGRATION.md`），在 `fix/webots-parity-pack` 上普通 push，无 force。
- 测试计数：typecheck 通过、protocol 751、acceptance 1261、web 1871、events 339、drive 52；额外 M07 94、room-files 193。
- 未部署、未创建 PR、未触发生产验收。
- A05-T01 仍 BLOCKED（依赖 D01/D02）；A05 仍为 `PARTIAL/BLOCKED`。
