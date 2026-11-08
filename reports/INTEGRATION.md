# 集成报告 · D01 / D02 / D03

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 上一波次交付基线 | `620f22e0a540860a4862f4fe2531fc1b083385e5`（`fix(groups,chat): 修复邀请明文重放与提及边界`） |
| D01 实现 / 报告提交 | `cdbfb23cbdc9eb3b1bdf791f620cea1c87da1268` / `e3407a51e020471b4fde931c3f1072ae7edba85a` |
| D02 实现 / 报告提交 | `60edc7bf4ca70d0af1af871a7f69f2ccf167dd3a` / `8078570f237bf648f2f1621b87c0aec29b3cea0f` |
| D03 实现 / 报告提交 | `7e15dcc3d7bf07f96493c94e0367a11496b9c788` + `cd106af71efc7ad8c6dd779cb402f3b5e1a0c7a9` / `c4146a297f822d8e2f63179e7db22b528df01644` |
| 本轮审查起点 HEAD | `c4146a297f822d8e2f63179e7db22b528df01644`（`docs(delivery): D03 任务报告`） |
| 上一轮修复提交 | `590e67312043559ed5911fae47e7a8b5d46d2661`（`docs(integration): 校正 D01-D03 验收计数`） |
| 本轮修复提交 | `9d26922`（`fix(delivery): 修复任务重派、拉黑派发与附件保留`）；同毫秒 self-claim 回归随本文件同提交（`fix(delivery): 修复同毫秒自我领取的创建重放`） |
| 集成报告提交 | 本文件所在提交（`git log -1 -- reports/INTEGRATION.md`） |
| 运行环境 | Bun 1.4.2，macOS；`DATA_DIR=/tmp/an-d01d02-fix`、`PORT=8792`、`PUBLIC_ORIGIN=http://127.0.0.1:8792`、`FILE_TICKET_SECRET=integration-local-secret` |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | 六套门禁与 D01/D02/D03/A05 专项全部通过；独立验收发现的 D01/D02 缺陷已修复：同候选重派、创建者拉黑闸门、同来源参数冲突、任务附件 GC，以及公开任务 claim/同毫秒 self-claim 后的创建重放回归。A05-T01 任务提议用例补齐，A05 状态更新为 PASS |

## 0. 审查范围与结论

本轮在 `c4146a2` 之上审查 D01（消息转任务与任务卡片）、D02（接单拒单与原子领取）、D03（业务状态与进度统一展示）的合并结果，重点检查三个任务共享的事务、迁移、事件、工具面与网页接缝：

- 迁移顺序 `0017_task_workflow.sql` → `0029_task_progress.sql` → `0030_task_initial_assignee.sql` → `0031_task_initial_assignee_known.sql` 在新库按序应用；`0017` 位于 `0018..0028` 之前，`0031` 最后。旧库升级清单同时包含 `0017`、`0029`、`0030` 与 `0031`，并断言 `tasks`、`task_assignments`、`task_cards` 可用。
- D01/D02/D03 共用 `src/domain/tasks.ts`、`src/contracts/schemas.ts`、`src/mcp/{tools,outputs,skill}.ts`、`src/realtime/stream.ts`、`src/web/chat-tasks-script.ts` 与任务验收脚本；合并后 12 个任务工具、任务事件映射与网页写后刷新没有互相覆盖。
- 任务写入继续满足现有不变量：`runIdempotent` + `db.batch()` 全有或全无；复用 `guard_task_state`、`guard_claim_conflict`、`guard_version_conflict`、`guard_assignment_stale`、`guard_request_expired`、`guard_not_member`、`guard_permission_denied` 等既有闸门，本轮没有新增 guard 表；`GUARD_TABLES` 与 `runner.ts` 的错误映射一致。
- 任务事件只写 room scope 事件与 `room:<id>` outbox，由 `stream.ts` 映射为 `task.updated` informational 且只扇出 active human；不写 inbox、不推进 `rooms.head_seq`、不改变未读。人类接手/取消仍走 inbox `task_offered` / `task_cancelled`；Agent 工作唤醒仍只来自明确指派生成的 delivery。
- 全量 `test:acceptance` 在短 presence 窗口下跑通并执行到 D03 段，D01/D02/D03 报告里记录的“基线 presence 阻塞”是运行配置问题，不是本轮代码回归。
- 独立验收发现的 4 项缺陷已在本轮修复：同候选拒绝后重派、管理员代派被创建者拉黑的候选、同来源任务参数静默收敛、任务附件引用回收。对应新增回归见 D01-T02/T05、D02-T02/T05 与 A05-T01。
- 复验又发现“比较负责人”修复的回归：公开任务 claim 后，创建者用完全相同参数重放被误判为 `CONFLICT`；进一步复验确认创建者同毫秒 self-claim 仍会触发：`initial_assignee_actor_id IS NULL` 无法区分“新公开任务”与“旧行未知”，回退查询把满足 v1 + 同 `created_at` + `offered_by = created_by` 的领取 assignment 当成创建时负责人。现新增 `initial_assignee_known`（`0031`）：新任务写入 `1`，公开任务的 `NULL` 成为权威答案；旧行只在创建事件明确记录 `offered`/`unassigned` 或仍是 pristine offer 时回填 `known = 1`，其余保持 `known = 0 + NULL` 并在收敛时跳过负责人比较。新增 D01-T06 的 56 项本地重放/旧库检查与 D01-T07 的 60 轮真实 HTTP 重放，D01 专项由 83 增至 101 项。

本轮的文档修正：

1. `README.md` 与 `docs/code-index.md` 的协议/端到端计数更新为 `883` / `1652`。
2. `docs/code-index.md` 的 `test:drive` 由 `47` 更新为 `52`。
3. D01/D02/D03/A05 报告的分项计数、修复提交与门禁结果同步更新。

## 1. D01 消息转任务与任务卡片

- `0017_task_workflow.sql` 只新增表与索引，不改已合入迁移：冻结的 `tasks` / `task_assignments` / `task_transfers` / `task_submissions` / `task_reviews` / `task_deliveries`，加实现补充表 `task_cards`（真实卡片 `message_id`）与 `task_attachments`（受控文件引用）。
- 旧 `room_tasks` 只读保留并一次性回填：`pending → unassigned`、`claimed → in_progress` 且生成 `asg_legacy_<task_id>` active assignment、`done → legacy_completed`、`failed → failed`；`current_assignment_id` 在同一迁移内回填。新库与旧库升级均通过。
- `idx_tasks_source_message` 保证一条来源消息至多一个任务；`idx_task_assignments_current` 保证每任务至多一个 offered/active assignment；`idx_task_deliveries_assignment_kind` 保证同一 assignment 同类 delivery 唯一。
- `0030_task_initial_assignee.sql` 给 `tasks` 增加可空 `initial_assignee_actor_id`，创建事务写入参数中的负责人（公开任务为 `NULL`），后续 claim/accept/reoffer/decline 都不修改。
- `0031_task_initial_assignee_known.sql` 增加 `initial_assignee_known`：新任务写入 `1`，公开任务的 `NULL` 是权威答案；旧行先清除 0030 的推断值，只有创建事件记录 `offered`/`unassigned` 或仍是未被动过的 pristine offer 时才回填 `known = 1`，其余保持 `known = 0 + NULL`。读取侧不再用后续 assignment 推断；`known = 0` 的旧行在收敛时跳过负责人比较，安全返回同一任务。
- 创建任务在同一事务内写 `tasks`、可选 assignment/delivery、一张“【任务卡】”真实消息与 `task_cards` 映射。卡片消息显式 `invoke: []`，不解析正文、转发或代码块为新的派活；`source_message_id` 的并发/重放通过 `convergeSourceTask` 收敛。收敛比较 `title`、`description`、`acceptance_criteria`、`due_at`、附件集合、创建时的初始负责人与验收人，任一不同返回 `CONFLICT`；只有 `initial_assignee_known = 1` 时才比较负责人。公开任务被创建者或其他 Agent claim 后、指定任务 accept/reoffer 后，相同参数重放仍返回同一任务；无法证明创建语义的旧行安全收敛。
- 任务附件在同一事务内写 `task_attachments`、`file_references(kind='task')`，并把 `room_files` / `drive_files` 置为 retained；`maintainFiles` 的引用回收同时检查旧 `room_tasks` 与新 `tasks`，任务删除后释放引用并恢复普通 TTL。
- 指派 Agent 只生成一条绑定 `task_id` / `assignment_version` 的 delivery，`pending_count + 1` 并写 `delivery_created` 唤醒；指派人类只写 `task_offered` 持久 inbox，不创建 delivery；公开任务不建 delivery、不增加 `pending_count`、不通知所有 Agent。
- 领取使用 `attempt` 之外的 assignment 语义：`unassigned → in_progress` 并生成 v1 active assignment；并发领取恰好一个成功，失败方返回 `CLAIM_CONFLICT` 并带权威 owner。取消撤销 current assignment、关闭 pending delivery 并同步 `pending_count`。读取受 active 成员、成员代次与历史边界约束，非成员/边界外/不存在统一 `NOT_FOUND`（房间列表为 `NOT_MEMBER`）。

## 2. D02 接单拒单与原子领取

- 新增 `network_task_accept` / `network_task_decline`，工具面从 7 个增至 9 个。只允许当前 `offered` assignment 的候选负责人调用；验收人、非候选人、非成员均被拒绝。
- 接受原子完成 `tasks.status → in_progress`、`owner_actor_id = caller`、`revision + 1`、assignment `offered → active`，写 `task_offer_accepted` room 事件与 `room:<id>` outbox；同一人两设备并发接受只有一个成功。接受不改变关联 delivery 的 pending/claimed、`attempt` 或 `claim_id`，也不把任务标成 `accepted`。
- 拒绝原子回到 `unassigned`、清空 owner 与 current assignment、`revision + 1`、assignment `offered → declined`；同一事务取消仍为 pending/claimed 的 offer delivery，按 pending 行数原子递减 `pending_count`，写 `delivery_cancelled` inbox 事件与 head，但不向拒绝者本人写 `inbox:{actor}` outbox。默认不自动改派。
- 同一候选拒绝后可再次 `network_task_offer`：`task_cards` 指向新卡片，新 assignment 使用递增 `assignment_version`，新 delivery 不再与旧 `(recipient_id, message_id)` 唯一键冲突；旧 assignment 仍返回 `ASSIGNMENT_STALE`。并发派给同一候选只有一个事务成功。
- `network_task_offer` 在同一事务内检查调用者、任务创建者、验收人与候选之间的任一方向拉黑；管理员代派被创建者拉黑的候选返回 `BLOCKED`，不生成 assignment/delivery/pending。
- accept / decline / claim / cancel 均支持可选 `expected_revision`；`ASSIGNMENT_STALE`、`CLAIM_CONFLICT`、`VERSION_CONFLICT`、`REQUEST_EXPIRED`、`CONFLICT` 的错误 details 附带权威 `task_id`、`status`、`revision`、owner 与 assignment 快照。公开领取已被人接手的任务优先归类为 `CLAIM_CONFLICT`。
- `network_task_get` / `network_task_list` 的 `can_accept` / `can_decline` 只对当前未过期候选为真，`can_claim` 只对 `unassigned` 且非验收人的有效成员为真；服务端在每次写入时重新校验资格、版本与有效期。
- 网页任务详情增加接受/拒绝入口（含可选原因），请求携带 `assignment_id` 与当前 revision；冲突后重新读取 `network_task_get` 并显示真实负责人，不轮询。

## 3. D03 业务状态与进度统一展示

- `0029_task_progress.sql` 新增只追加的 `task_progress` 与唯一 `(task_id, task_revision)` 索引；`tasks.status` / `tasks.revision` 仍是唯一当前状态权威，不保存第二份状态。
- `src/contracts/task-status.ts` 统一 9 个状态值、`status_label` / `status_hint`、阶段与 C07 迁移表；`legacy_completed` 只读显示“历史完成”，明确不等于 `accepted`，`can_report_progress` / `can_block` / `can_resume` / `can_cancel` 均为假。
- 新增 `network_task_progress`、`network_task_block`、`network_task_resume`，任务工具从 9 个增至 12 个。三者只允许当前 owner 且持有当前 active assignment：progress 要求 `in_progress` 且 note/percent 至少一项（note ≤ 8 KiB、percent 0–100），block 要求 reason（≤ 4 KiB）并转 `blocked`，resume 只从 `blocked` 回 `in_progress` 并清空阻塞字段。
- 每次写入递增 revision、更新 `last_progress_at`、追加 `task_progress`，并写 `task_progress_reported` / `task_blocked` / `task_resumed` room 事件与 `room:<id>` outbox；不创建消息、delivery 或 inbox 事件，不改变 `pending_count`、未读与房间 head。
- 幂等经 `runIdempotent` + 请求载荷 hash：同 `request_id` 同载荷返回同一 `progress_id` / revision；同 `request_id` 改参数返回 `IDEMPOTENCY_CONFLICT`；旧 revision / 旧 assignment_version 分别返回 `VERSION_CONFLICT` / `ASSIGNMENT_STALE`，同 revision 并发只成功一次。
- `task_get` / `task_list` 返回 `status_label`、`status_hint`、`phase`、`phase_label`、`progress`；详情额外返回最多 20 条 `progress_history`。列表只返回最新进度，写操作结果不含历史。任务流事件新增 `revision`，客户端可据此丢弃乱序提示并补读权威状态。
- 网页任务卡片显示最新进度摘要，详情显示状态说明、阻塞原因、进度条与历史，并提供“更新进度”“报告阻塞”“恢复执行”控件；写后重新调用 `network_task_get` 获取含历史的权威视图，再刷新概览、当前房间与卡片。

## 4. 跨功能接缝核对

- **迁移与旧库升级**：新库启动按序应用 27 个迁移文件（`0001`–`0012`、`0017`–`0031`，`0013`–`0016` 从未使用）；`0017` 未修改已合入迁移，`0031` 为最后一个；旧库升级断言包含 `0017`、`0029`、`0030` 与 `0031`，原业务数据与表结构保留。
- **错误映射**：`guard_task_state → CONFLICT`、`guard_version_conflict → VERSION_CONFLICT`、`guard_assignment_stale → ASSIGNMENT_STALE`、`guard_request_expired → REQUEST_EXPIRED`、`guard_claim_conflict → CLAIM_CONFLICT`，与 D01/D02/D03 的错误快照一致；无同名 guard 冲突。
- **通知与流**：`task_created` / `task_offered` / `task_offer_accepted` / `task_offer_declined` / `task_claimed` / `task_cancelled` / `task_progress_reported` / `task_blocked` / `task_resumed` 统一映射为 human-only `task.updated` informational，带 `change`、`task_id`、`assignment_id`、`status`、`revision`、`changed_by`；不推进 head、不产生未读、不唤醒 Agent。inbox 侧 `task_offered` 为 `action_required`，`task_cancelled` 为 informational。
- **delivery 与任务分离**：delivery 的 claim/report/complete/fail 仍只表示通知处理，不改变任务 owner 或业务状态；D02/D03 专项均断言 delivery complete 后任务仍为真实状态。
- **工具面**：协议验收断言 94 个工具的清单与顺序、关闭 Drive 时为 85；任务工具为 12 个，旧 `network_task_add/list_get/complete/fail/update/delete` 已退休。
- **网页**：`chat-tasks-script.ts` 986 行、`chat-task-progress-script.ts` 213 行，均低于 1000 行；任务面板、卡片、详情、接受/拒绝、进度/阻塞/恢复与既有聊天、文件、监控、移动端共用同一脚本作用域，`test:web` 1931 项覆盖。
- **文档**：D01/D02/D03 的功能正文与工具清单已同步；本轮同步由新增验收直接影响的协议/端到端/专项计数，未做 Q01 的全量对齐。

## 5. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun install` | 通过 | 安装 1 个包（canvas postinstall），`bun.lock` 无变化 |
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0 |
| `bun run test:protocol` | 通过 | `协议验收通过: 883 项`（含 D01 重放/旧库回归 56 项） |
| `bun run test:acceptance` | 通过 | `端到端验收通过: 1652 项`（服务端与测试进程均使用短 presence 窗口） |
| `bun run test:web` | 通过 | `浏览器验收通过 1931 项`（脚本自托管临时实例） |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项` |
| `bun run test:drive` | 通过 | `drive checks passed: 52` |
| D01 专项 | 通过 | `D01 focused checks passed: 99` |
| D02 专项 | 通过 | `D02 focused checks passed: 69` |
| D03 专项 | 通过 | `D03 focused checks passed: 175` |
| A05 专项 | 通过 | `A05 focused checks passed: 103` |
| `git diff --check` | 通过 | 无 whitespace 错误 |

主实例启动方式：

```bash
DATA_DIR=/tmp/an-d01d02-fix \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8792 \
FILE_TICKET_SECRET=integration-local-secret \
PORT=8792 bun run start
```

D01/D02/D03 专项命令：

```bash
AGENTNET_URL=http://127.0.0.1:8792 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runRoomTaskAcceptance } from './scripts/lib/room-task-acceptance'; await runRoomTaskAcceptance(); console.log('D01 focused checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8792 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runTaskAssignmentAcceptance } from './scripts/lib/task-assignment-acceptance'; await runTaskAssignmentAcceptance(); console.log('D02 focused checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8792 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runTaskStatusAcceptance } from './scripts/lib/task-status-acceptance'; await runTaskStatusAcceptance(); console.log('D03 focused checks passed: ' + checksPassed());"
```

`test:protocol`、`test:acceptance` 与 `test:drive` 使用本地 `http://127.0.0.1:8792`；`test:web` 与 `test:events` 各自启动临时实例。全量 `test:acceptance` 已包含 D01 101 项、D02 69 项、D03 175 项与 A05 103 项任务/拉黑验收。

## 6. 本轮改动

- `src/domain/tasks.ts`：同候选重派生成新卡片/assignment/delivery；创建者-候选拉黑闸门；`convergeSourceTask` 比较全部语义参数，初始负责人只读 `initial_assignee_known = 1` 的权威列，`known = 0` 的旧行跳过负责人比较；任务附件建立引用并 retained。
- `migrations/0030_task_initial_assignee.sql`：新增可空 `initial_assignee_actor_id`。
- `migrations/0031_task_initial_assignee_known.sql`：新增 `initial_assignee_known`，清除 0030 的推断值，只按创建事件或 pristine offer 证明回填旧行。
- `src/maintenance.ts`：任务引用回收同时扫描新 `tasks`。
- `scripts/lib/{room-task-acceptance,task-assignment-acceptance,contact-block-acceptance}.ts`：D01-T02 参数冲突、accept/reoffer 后重放，D01-T03 公开任务 claim 后重放与单任务/单卡片，D01-T05 附件，D01-T07 创建者同毫秒 self-claim 的 60 轮真实 HTTP 重放，D02-T02 重派/并发，D02-T05 创建者拉黑，A05-T01 任务提议拒绝。
- `scripts/lib/task-attachment-gc-unit.ts`、`scripts/lib/task-create-replay-unit.ts`、`scripts/verify-protocol.ts`：新增 18 项附件保留 GC 与 56 项创建重放/旧库升级检查（含固定时钟）。
- `scripts/lib/feedback-unit.ts`：旧库升级断言加入 `0031_task_initial_assignee_known.sql`。
- `README.md`、`docs/code-index.md`、`src/mcp/{tools,skill}.ts`、`public/skills/agent-network-skills.md`：同步重派、拉黑闸门、附件保留与协议/端到端计数 `883` / `1652`。
- `reports/{D01,D02,D03,A05,INTEGRATION}.md`：更新修复结论、分项计数与证据。

本轮新增 `0031` 一个前向迁移，未修改 `0001`–`0030`；`0031` 只增加带默认值的 `initial_assignee_known` 并按可证明条件回填；网页脚本与 presence 语义未变。

## 7. 已知限制与未完成 P0

D01/D02/D03 的实现范围均已完成，保持 `READY_FOR_REVIEW`，需独立验证者在集成 SHA 上签收。任务自身记录的限制继续有效：

- **D01**：成果（artifact）入口仍通过 `src/domain/artifacts.ts` 的旧 `room_tasks` 校验，`tsk_` 任务暂不能提交成果，属于 D07/D08 与 M07 的集成范围。任务附件引用已在同一事务内建立并保留，`maintainFiles` 同时扫描新 `tasks`。
- **D01/D02**：`network_task_list` 尚未分页（`next_cursor: null`）；`task_transfers` / `task_submissions` / `task_reviews` 已建表但未使用。
- **D02/D03**：offer 过期没有清扫器，过期 offer 不会自动回 `unassigned`，需要取消后重建或后续幂等清扫。
- **D03**：`submitted` / `accepted` / `failed` 仍由 D06/D07 及失败/重试任务产生；进度历史最多展示 20 条（数据库保留全部审计）；未构造两个浏览器以不同顺序接收同一批 `task.updated` 的 Playwright 回放，客户端应始终以 `task_get` / `task_list` 的权威 revision 收敛。
- **文档**：Q01 仍负责 README / CLAUDE / 技能正文与全部文档的全量对齐；本轮已同步 D01/D02 修复、A05-T01 与 `test:drive` 计数。

仍未实现的 P0：

- **A 组**：A06。
- **G 组**：G06。
- **D 组**：D04、D05、D06、D07、D08。
- **Q 组**：Q01、Q02、Q04、Q05。

依赖与阻塞：

- **A05-T01 已解除阻塞**：A05 报告更新为 `PASS`。`contact-block-acceptance.ts` 新增“拒绝任务提议”用例：创建者拉黑候选后管理员 offer 返回 `BLOCKED`，不生成 assignment/delivery/pending；解除拉黑后正常派发。任务交接仍属后续能力。
- D04/D05 的转交提议仍由独立对象负责，本波次未创建 transfer，也未复用 `task_progress` 冒充交接；D06/D07 接入提交与验收时必须复用当前 active assignment 与 revision 校验。
- Q02/Q04/Q05 依赖 D03、Q01 以及各自的设备/并发/故障验收范围，本轮未扩大。

## 8. 最终状态

- 审查起点：`c4146a297f822d8e2f63179e7db22b528df01644`（`docs(delivery): D03 任务报告`）。
- 上一轮修复提交：`590e67312043559ed5911fae47e7a8b5d46d2661`。
- 本轮修复提交：`9d26922`（`fix(delivery): 修复任务重派、拉黑派发与附件保留`）；复验修复提交为本文件所在提交（`fix(delivery): 修复公开任务创建重放幂等`）。
- 集成报告提交：本文件所在提交（`git log -1 -- reports/INTEGRATION.md`），在 `fix/webots-parity-pack` 上普通 push，无 force。
- 测试计数：typecheck 通过、protocol 883、acceptance 1652、web 1931、events 339、drive 52；专项 D01 101、D02 69、D03 175、A05 103（合计 448）。
- 未部署、未创建 PR、未触发生产验收。
- D01/D02/D03 保持 `READY_FOR_REVIEW`，待独立验证；A05 更新为 `PASS`。
