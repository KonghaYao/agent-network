# 集成报告 · D01–D08

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 上一波次交付基线 | `620f22e0a540860a4862f4fe2531fc1b083385e5`（`fix(groups,chat): 修复邀请明文重放与提及边界`） |
| D01 实现 / 报告提交 | `cdbfb23cbdc9eb3b1bdf791f620cea1c87da1268` / `e3407a51e020471b4fde931c3f1072ae7edba85a` |
| D02 实现 / 报告提交 | `60edc7bf4ca70d0af1af871a7f69f2ccf167dd3a` / `8078570f237bf648f2f1621b87c0aec29b3cea0f` |
| D03 实现 / 报告提交 | `7e15dcc3d7bf07f96493c94e0367a11496b9c788` + `cd106af71efc7ad8c6dd779cb402f3b5e1a0c7a9` / `c4146a297f822d8e2f63179e7db22b528df01644` |
| D04 实现 / 报告提交 | `56d9c9f51ba4c805223745b6bb4d7f3dc594cf5f` / `b6d27f4d5b6e19ba129451dd05ade7e532a89957`（`docs(delivery): D04 任务报告`） |
| D05 实现 / 报告 | 实现完整存在于未提交工作区，随本文件所在提交一并提交；无 `reports/D05.md`，交付语义见本报告第 5 节 |
| D06 实现 / 报告提交 | `4eb8de8db803b5b7ad349c189345b6f784d1fd8f` / `b696df53b3779460c2448bb7030f5608d4ea9cd8`（`docs(delivery): D06 任务报告`） |
| D07 实现 / 报告提交 | `049ce2034d8abec06062f8506d9d260d8c1354b1` / `f8d520b7852802fa649435f593b78fb53926f309`（`docs(delivery): D07 任务报告`） |
| D08 | **未实现**：无报告、无实现提交、无专项验收；见第 8 节 |
| 本轮审查起点 HEAD | `f8d520b7852802fa649435f593b78fb53926f309`（`docs(delivery): D07 任务报告`） |
| 上一轮修复提交（D01–D03） | `590e67312043559ed5911fae47e7a8b5d46d2661`（`docs(integration): 校正 D01-D03 验收计数`）；`9d26922`（`fix(delivery): 修复任务重派、拉黑派发与附件保留`）；`48df0ab`（`fix(delivery): 修复公开任务创建重放幂等`）；`64ca79c`（`fix(delivery): 修复同毫秒自我领取的创建重放`） |
| 本轮集成修复提交 | 本文件所在提交（两个集成回归修复：A01-T04、D03-T04） |
| 运行环境 | Bun 1.4.2，macOS；`DATA_DIR=/tmp/agentnet-d0408-int3/data`、`PORT=8913`、`PUBLIC_ORIGIN=http://127.0.0.1:8913`；票据密钥使用本地临时测试值，未写入报告 |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | 六套门禁与 D04/D05/D06/D07 专项全部通过；D01–D07 保持 `READY_FOR_REVIEW`。D08 完全未实现，仍是未关闭 P0。D05 的“相关消息原文定位”仍依赖未实现的 M04，只能按 message_id 引用，详见第 5、12 节 |

## 0. 审查范围与结论

本轮在 `f8d520b` 之上审查 D04（任务交接与接任确认）、D05（可授权交接上下文包）、D06（成果提交与不可混淆的版本）、D07（验收退回与重新交付）的合并结果；D08（催办、取消与异常恢复）没有任何实现，无法集成或验收。重点检查四个任务共享的事务、迁移、事件、工具面、技能正文、网页脚本与验收注册：

- 迁移文件共 30 个：`0001`–`0012`、`0017`–`0034`，`0013`–`0016` 历史上从未使用。D06 的 `0032_task_submission_sources.sql`、D07 的 `0033_task_review_acceptance.sql` 已提交；D05 的 `0034_task_handoff_packs.sql` 位于本次提交。三者序号唯一、连续，未修改已发布迁移；`0034` 只新增三张表与 `guard_handoff_conflict`，不改写既有行。
- D04/D05/D06/D07 共用 `src/domain/tasks.ts`、`task-transfers.ts`、`task-handoff-packs.ts`、`task-submissions.ts`、`src/storage/{rows,queries,guards}.ts`、`transactions/runner.ts`、`src/mcp/{tools,outputs,skill}.ts`、`src/contracts/{schemas,limits}.ts`、`src/realtime/stream.ts` 与 `src/web/chat-*.ts`。合并后任务工具 29 个、整体工具面 111 个（Drive 与房间文件开启）/ 102 个（关闭），没有重复注册或丢失前置能力。
- 任务写入继续满足既有不变量：`runIdempotent` + `db.batch()` 全有或全无；写操作校验当前 active assignment、`assignment_version` 与 task revision；新增闸门只有 D05 `guard_handoff_conflict → CONFLICT` 与 D07 `guard_review_stale → REVIEW_STALE`，`GUARD_TABLES` 与 `runner.ts` 的映射一致。
- 任务、交接、提交、验收事件都只写 room scope 事件与 `room:<id>` outbox，由 `stream.ts` 映射为 human-only `task.updated` informational；不写 `inbox:{actor}`、不创建 delivery、不增加 `pending_count`、不推进 `rooms.head_seq`、不产生未读。人类任务提议/取消仍沿用 inbox `task_offered` / `task_cancelled`。
- 全量 `test:acceptance` 在短 presence 窗口下通过 2074 项，D04–D07 专项分别 128/83/133/74 项；`test:protocol` 937 项、`test:web` 1950 项、`test:events` 339 项、`test:drive` 52 项。
- 集成回归修复 2 项：A01-T04（停用 Agent 会按 D04 撤销执行资格，任务转 `blocked` 并清空负责人，旧断言仍要求 `claimed`）与 D03-T04（旧负责人写入新执行期，D04 起统一返回 `ASSIGNMENT_STALE`，旧断言期望 `PERMISSION_DENIED`）。修复只更新断言与 `TaskView` 测试类型，未降低任何服务端语义。
- 过程偏差：开工时工作区已包含完整但未提交的 D05 实现（21 个修改 + 6 个未跟踪文件），与“工作区不干净立即停止”的指令不符。为避免丢弃已有实现，本轮就地审查并集成该工作区，未执行 `reset`/`stash`/`clean`，也未触碰主 checkout；D05 因此没有独立实现报告，其语义与证据由本报告第 5 节承担。

本轮对既有集成报告的修正：

1. 修正“同毫秒 self-claim 回归随本文件同提交”的陈旧提交名：实际修复提交是 `64ca79c`，公开任务创建重放幂等修复是 `48df0ab`。
2. 修正 `0031` 的“纯增量”措辞：该迁移先执行 `UPDATE tasks SET initial_assignee_actor_id = NULL` 全表清空 0030 的推断值，再按创建事件或 pristine offer 的可证明条件回填 `initial_assignee_known = 1` 与负责人，其余旧行保持 `known = 0`；不是只追加列。
3. D04–D07 的实现 SHA、门禁计数、限制与 D08 缺口写入本报告。`README.md` / `docs/code-index.md` 的协议与工具计数仍是 D03 基线（883 项 / 94 个工具），D05 也尚无文档条目；按任务边界留给 Q01 全量对齐，本报告是当前权威计数。

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

## 4. D04 任务交接与接任确认

- 新增 6 个 MCP 工具 `network_task_transfer_propose/accept/reject/cancel/get/list`；D04 时任务工具 18 个，整体工具面 100/91（Drive 与房间文件开关）。无新增迁移，复用 `task_transfers`、`task_assignments`、guard 与 room 事件。
- 提议限当前负责人、创建者或群 owner/管理员；目标必须是 active 成员且不能是自己、负责人或验收人；任一方向拉黑返回 `BLOCKED` 且不落提议行。同一任务同时只允许一条 pending，默认 24 小时有效期。提议不改变 owner、assignment、status、revision，不创建 delivery、不增加 `pending_count`、不推进 `head_seq`。
- 接受只允许目标，校验 pending/未过期/revision/`from_assignment_version` 与当前 active assignment；同一事务撤销旧 assignment、生成 `assignment_version = max(现存最大版本 + 1, 旧版本 + 1)` 的新 active assignment、更新任务 owner/current assignment/revision、关闭旧 assignment 的 `task_offer`/`task_reminder` delivery，并写 `task_transfer_accepted`。并发接受只有一个成功；重复接受返回同一视图，不递增 revision 或版本。
- 拒绝/取消只关闭 pending 提议，不改变任务责任；过期是惰性语义，读取显示 `expired`，下次写操作持久化，过期后接受返回 `REQUEST_EXPIRED`。
- 成员移除、退群与 `disableAgent` 在同一事务调用 `revokeTaskEligibilityStatements`：作用域内 `in_progress`/`blocked` 任务转 `blocked`、`blocked_reason = 'owner_lost_eligibility'`、清空 owner/current assignment、撤销 active assignment、关闭 pending/claimed 任务 delivery 并取消 pending 交接。旧负责人读任务仍可见，但写进度/阻塞/再次交接返回 `ASSIGNMENT_STALE` 并携带真实负责人。
- 交接事件 `task_transfer_proposed/accepted/rejected/cancelled/expired` 统一投影为 human-only `task.updated` informational；网页 `chat-task-transfer-script.ts` 提供发起、接受、拒绝、撤回入口，只按服务端 `can_*` 显示。D04 专项 128 项（T01 42 + T02 39 + T03 17 + T04 9 + UNIT 19 + 技能 1）。

## 5. D05 可授权交接上下文包（未提交实现，随本报告提交）

- 新增 4 个 MCP 工具 `network_task_handoff_pack_create/get/authorize/request_more`；任务工具 25 → 29，整体工具面 111/102。新增 `0034_task_handoff_packs.sql`：`task_handoff_packs`（每次生成新版本）、`task_handoff_pack_items`（只存引用与短标签/摘要）、`task_handoff_context_requests` 与只接受 `x = 0` 的 `guard_handoff_conflict`；不改写既有行。
- 交接包记录目标、已完成、当前结果（可绑定 `submission_id` + version）、未解决、下一步与引用清单；引用 kind 限于 `message`、`file`、`branch`、`commit`、`test`、`submission`，不复制群历史正文或文件字节。`create` 只允许当前负责人且持有当前 active assignment、任务处于 `in_progress`/`blocked`；`version = max + 1`，旧版本原样保留。
- `get` 按 `pack_id` 或 `version` 读取，省略时返回最新版与版本列表；对每个引用按当前读取者重新判定 `available` / `missing` / `omitted`，必需缺失汇总到 `required_missing`，`context_ready=false` 表示不完整。同一任务房间的材料直接可用；`source_room_id` 跨范围的消息与文件默认 `omitted` 且无 URL，必须由源范围有权限的身份（文件上传者或源房间 owner/管理员、消息可见者）显式 `authorize grant`。`revoke` 只关闭授权，不删除版本或引用记录。
- 文件读取仍由 `/f` 实时票据与成员资格决定：`handoff-ticket` 同时校验目标房间票据、包项授权、授权人仍 active 且仍可见源范围；撤回或授权来源失权后旧 URL 立即 404，重读包显示 `omitted` 与 `authorization_source_lost`。
- 接任时若存在包且 `context_ready=false`，换人仍成功，但任务转 `blocked` + `blocked_reason = 'context_incomplete'`；没有包时保持 D04 的 `context_ready=false` 兼容行为。`request_more` 由待接受提议目标或当前负责人追加补充请求，不改变责任、assignment、任务状态或 revision。
- `task_handoff_pack_created` / `_item_authorized` / `_item_revoked` / `_context_requested` 只写 room scope 与 `room:<id>` outbox，映射为 human-only `task.updated` informational；不创建 delivery、不增加 `pending_count`、不推进 `head_seq`。网页 `chat-task-handoff-script.ts` 在任务详情展示版本、缺项/可授权项、就绪状态与“授权给接任者”入口；`chat-tasks-script.ts` 抽出 `chat-task-detail-script.ts` 后为 969 行。
- **依赖缺口（未关闭）**：D05 的“相关消息”只保存 `message_id`，没有原文定位或引用预览，因为前置 M04 未实现（`reports/BASELINE.md` 的 BLOCK-05）。因此 D05 的版本化包、文件授权与缺项判定可验收，但“消息原文交接”范围不完整，不能按 M04 已就绪签收。`reports/D05.md` 不存在，本报告不伪造实现者报告。
- D05 专项 83 项（T01 41 + T02 31 + T03 10 + 环境 1），覆盖版本化、跨群默认不可读/授权后可读/撤回即失效、必需缺失导致 `blocked + context_incomplete`、源范围失权后 `omitted` 与旧 URL 失效。协议验收新增 29 个任务工具、四个交接工具 schema/描述、`handoff_pack_get` 只读与技能正文断言；网页验收包含建包、缺项、授权与 `context_ready=true` 的浏览器路径。

## 6. D06 成果提交与不可混淆的版本

- 新增 `0032_task_submission_sources.sql`，只给冻结表 `task_submissions` 追加 `links_json` 与 `commit_sha`；不重建表、不改状态 CHECK、无需回填。
- 新增 4 个工具 `network_task_submit`、`network_task_submission_get`、`network_task_submission_list`、`network_task_submission_return`；D06 时任务工具 22 个。
- 提交只允许当前负责人 + active assignment + `in_progress`，校验 revision/assignment/状态；摘要必填，材料/外链/证据/提交 SHA 至少一项。每次提交生成 `submission_id` 与 `version = max + 1`，同一任务只允许一个 pending 版本；材料从同房间文件元数据冻结 `name/mime/size/sha256`，复用 `file_references(kind='task', ref_id=task_id)` 建立保留引用。配额不足、跨房间材料或事务中断整批回滚。
- 提交在同一事务把任务转 `submitted`、revision +1、当前 assignment 结束、关闭该 assignment 的 pending/claimed task delivery、取消 pending 交接并写 `task_submitted`；不创建消息或 delivery、不增加 `pending_count`、不推进 `head_seq`。退回写 `task_reviews(decision='return')`、版本 `returned`，原负责人仍可用时以新 `assignment_version` 重建 active assignment，否则任务转 `blocked`。
- D06 专项 133 项（T01 29 + T02 36 + T03 64 + 环境 4）；外链只记录声明、提交列表无游标、验收人缺失时无法退回等限制保留。

## 7. D07 验收退回与重新交付

- 新增 `0033_task_review_acceptance.sql`：给 `tasks` 追加可空 `parent_task_id` / `related_task_id` 与读取索引，给 `task_reviews` 追加 `checklist_json`（默认 `[]`），新建 `guard_review_stale`；不重建已发布表、不改写既有行。旧数据映射为关系 `NULL`、清单 `[]`。
- 新增 3 个工具 `network_task_review_accept`、`network_task_review_return`、`network_task_reviewer_set`；D07 时任务工具 25 个（D05 接入后为 29）。D06 的 `network_task_submission_return` 保留为兼容入口。
- 通过只允许当前验收人（不能是负责人/提交人），绑定 `submission_id` + `version`，逐项 `checklist` 必须全部通过；同一事务写 review、submission `accepted`、任务 `accepted` + `accepted_at` + revision +1 与 `task_accepted`。重复通过返回同一快照，不重复通知、不增加待办、不推进 head。旧版本/旧验收人返回 `REVIEW_STALE`。
- 退回同样绑定版本；原负责人失权时任务转 `blocked`、`owner_lost_eligibility`，旧 submission/assignment 不复活。验收人退群或停用不会自动通过，读取显示 `reviewer_available=false`，由创建者、当前负责人或管理员显式改派；改派写 `task_reviewer_changed` 并 revision +1。
- `parent_task_id` 只允许同房间已结束任务，`related_task_id` 只允许同房间可见任务；追加工作必须新建任务，不能重开 `accepted`。验收事件 human-only；网页 `chat-task-review-script.ts` 提供逐项清单、退回、改派与父/关联任务入口。
- D07 专项 74 项（T01 34 + T02 8 + T03 31 + 身份注册 1），覆盖自验拒绝、并发唯一终态、验收人退群/改派、负责人失权与重交后旧版本审核被拒。

## 8. D08 催办/取消/异常恢复（未实现）

- `reports/D08.md` 不存在；`git log --all` 没有 D08 实现提交；`scripts/lib` 没有 D08 专项；代码、迁移、工具面与技能正文没有 D08 的催办/取消/异常恢复能力。当前只有 D04 的过期提议惰性处理与 D06/D07 的退回/失权路径，不能替代 D08。
- D08 不能标记 `READY_FOR_REVIEW` 或 `VERIFIED`，也没有可重跑的门禁计数；它仍是未关闭 P0，需单独立项实现与验收。

## 9. 跨功能接缝核对

- **迁移与旧库升级**：新库启动按序应用 30 个迁移文件（`0001`–`0012`、`0017`–`0034`，`0013`–`0016` 从未使用）；`0031` 未修改已发布内容，`0032`/`0033` 已提交，`0034` 随本报告提交并为最后一个。旧库升级断言包含 `0017`、`0029`、`0030`、`0031`、`0032`、`0033` 与 `0034`，原业务数据与表结构保留。
- **错误映射**：`guard_task_state → CONFLICT`、`guard_version_conflict → VERSION_CONFLICT`、`guard_assignment_stale → ASSIGNMENT_STALE`、`guard_request_expired → REQUEST_EXPIRED`、`guard_claim_conflict → CLAIM_CONFLICT`、`guard_handoff_conflict → CONFLICT`、`guard_review_stale → REVIEW_STALE`，与各任务错误快照一致；无同名 guard 冲突。
- **通知与流**：任务基础事件、`task_transfer_proposed/accepted/rejected/cancelled/expired`、`task_handoff_pack_created/_item_authorized/_item_revoked/_context_requested`、`task_submitted`、`task_returned`、`task_accepted`、`task_reviewer_changed` 统一映射为 human-only `task.updated` informational，带 `change`、`task_id`、`assignment_id`、`status`、`revision`、`changed_by`（适用时带 `submission_id` / `submission_version`）；不推进 head、不产生未读、不唤醒 Agent。inbox 侧 `task_offered` 为 `action_required`，`task_cancelled` 为 informational。
- **delivery 与任务分离**：delivery 的 claim/report/complete/fail 仍只表示通知处理，不改变任务 owner 或业务状态；D02/D03/D06 专项均断言 delivery complete 后任务仍为真实状态。
- **工具面**：协议验收断言 29 个任务工具的清单与顺序，整体工具面 111 个（Drive 与房间文件开启）/ 102 个（关闭）；旧 `network_task_add/list_get/complete/fail/update/delete` 已退休。
- **网页**：`chat-tasks-script.ts` 969 行、`chat-task-handoff-script.ts` 452 行、`chat-task-submission-script.ts` 436 行、`chat-task-transfer-script.ts` 347 行、`chat-task-review-script.ts` 249 行、`chat-task-progress-script.ts` 213 行、`chat-task-detail-script.ts` 43 行，均低于 1000 行；任务面板、交接包、提交/退回、验收、改派与既有聊天、文件、监控、移动端共用同一脚本作用域，`test:web` 1950 项覆盖（含 D05 建包/缺项/授权浏览器路径）。
- **文档**：D04/D06/D07 的功能正文与工具清单已随各自提交同步；`README.md` / `docs/code-index.md` 的协议、工具总数与 D05 条目仍是 D03 基线，按任务边界留给 Q01 全量对齐；本报告是当前权威计数。

## 10. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0，无诊断 |
| `bun run test:protocol` | 通过 | `协议验收通过: 937 项`（`AGENTNET_URL=http://127.0.0.1:8913`） |
| `AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 AGENT_PRESENCE_GRACE_MS=2000 AGENT_PRESENCE_SWEEP_MS=1000 bun run test:acceptance` | 通过 | `端到端验收通过: 2074 项`（服务端与测试进程均使用短 presence 窗口） |
| `bun run test:web` | 通过 | `浏览器验收通过 1950 项`（脚本自托管临时实例） |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项` |
| `AGENTNET_URL=http://127.0.0.1:8913 bun run test:drive` | 通过 | `drive checks passed: 52` |
| D04 专项 | 通过 | `D04 focused checks passed: 128` |
| D05 专项 | 通过 | `D05 focused checks passed: 83`（T01 41 + T02 31 + T03 10 + 环境 1） |
| D06 专项 | 通过 | `D06 focused checks passed: 133` |
| D07 专项 | 通过 | `D07 focused checks passed: 74` |
| D08 专项 | 未执行 | 无实现、无验收脚本 |
| 工具计数 | 通过 | `tools/list` 返回 111 个（Drive 与房间文件开启）；关闭时为 102 个 |
| `git diff --check` | 通过 | 无 whitespace 错误 |

主实例启动方式：

```bash
DATA_DIR=/tmp/agentnet-d0408-int3/data \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8913 \
FILE_TICKET_SECRET=<本地临时测试值> \
PORT=8913 bun run start
```

D04–D07 专项命令：

```bash
AGENTNET_URL=http://127.0.0.1:8913 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runTaskTransferAcceptance } from './scripts/lib/task-transfer-acceptance'; await runTaskTransferAcceptance(); console.log('D04 focused checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8913 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runTaskHandoffAcceptance } from './scripts/lib/task-handoff-acceptance'; await runTaskHandoffAcceptance(); console.log('D05 focused checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8913 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runTaskSubmissionAcceptance } from './scripts/lib/task-submission-acceptance'; await runTaskSubmissionAcceptance(); console.log('D06 focused checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8913 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runTaskReviewAcceptance } from './scripts/lib/task-review-acceptance'; await runTaskReviewAcceptance(); console.log('D07 focused checks passed: ' + checksPassed());"
```

`test:protocol`、`test:acceptance` 与 `test:drive` 使用本地 `http://127.0.0.1:8913`；`test:web` 与 `test:events` 各自启动临时实例。全量 `test:acceptance` 已包含 D01–D07 与 A05 的注册用例；D01/D02/D03/A05 本轮未单独重跑专项，沿用其报告中的历史计数。

## 11. 本轮改动

本轮新增/修改的主体是未提交的 D05 实现与两个集成回归修复；D04/D06/D07 的实现已在各自提交中，本轮未改其业务语义：

- `migrations/0034_task_handoff_packs.sql`：交接包/引用/补充请求三张表与 `guard_handoff_conflict`；只新增对象，不改写既有行。
- `src/domain/task-handoff-packs.ts`、`src/domain/handoff-file-grant.ts`：版本化建包、逐项可用性判定、跨范围授权/撤回、补充请求与 `handoff-ticket` 文件授权。
- `src/domain/task-transfers.ts`：接任时读取交接包就绪度；包不完整时换人成功但任务 `blocked + context_incomplete`，无包保持 D04 兼容。
- `src/domain/file-access.ts`：`handoff-ticket` 路径校验目标房间票据、包项授权与授权人有效性；撤回/失权后拒绝读取。
- `src/contracts/{limits,schemas}.ts`、`src/mcp/{tools,outputs,skill}.ts`、`public/skills/agent-network-skills.md`：D05 四个工具、输入/输出 schema、描述、技能正文与限制值；任务工具 25 → 29。
- `src/realtime/stream.ts`、`src/storage/{rows,queries,guards}.ts`、`src/storage/transactions/runner.ts`：交接事件 human-only 投影与 `guard_handoff_conflict → CONFLICT`。
- `src/web/chat-task-handoff-script.ts`、`src/web/chat-task-detail-script.ts`、`src/web/chat-tasks-script.ts`、`src/web/chat-script.ts`、`src/web/chat-styles.ts`：任务详情交接包面板、授权入口、就绪状态；抽出详情片段后 `chat-tasks-script.ts` 为 969 行。
- `scripts/lib/task-handoff-acceptance.ts`、`scripts/acceptance.ts`、`scripts/verify-protocol.ts`、`scripts/verify-web.ts`、`scripts/lib/{feedback-unit,task-create-replay-unit}.ts`：D05 专项 83 项、协议/网页断言与 `0034` 旧库升级清单。
- `scripts/lib/agent-identity-acceptance.ts`：A01-T04 按 D04 的撤销执行资格语义更新为 `blocked` / owner 为 null / `owner_lost_eligibility`，并断言启用后不自动恢复。
- `scripts/lib/task-status-acceptance.ts`：D03-T04 旧负责人写入新执行期期望改为 `ASSIGNMENT_STALE`，与 D04 专项一致。
- `reports/INTEGRATION.md`：新增 D04–D08 章节与门禁计数；修正陈旧提交名与 `0031` 全表回填措辞。

### 历史（D01–D03）改动

- `src/domain/tasks.ts`：同候选重派生成新卡片/assignment/delivery；创建者-候选拉黑闸门；`convergeSourceTask` 比较全部语义参数，初始负责人只读 `initial_assignee_known = 1` 的权威列，`known = 0` 的旧行跳过负责人比较；任务附件建立引用并 retained。
- `migrations/0030_task_initial_assignee.sql`：新增可空 `initial_assignee_actor_id`。
- `migrations/0031_task_initial_assignee_known.sql`：新增 `initial_assignee_known`；先全表执行 `UPDATE tasks SET initial_assignee_actor_id = NULL` 清除 0030 的推断值，再按创建事件或 pristine offer 证明回填负责人与 `known = 1`，其余保持 `known = 0`。
- `src/maintenance.ts`：任务引用回收同时扫描新 `tasks`。
- `scripts/lib/{room-task-acceptance,task-assignment-acceptance,contact-block-acceptance}.ts`：D01-T02 参数冲突、accept/reoffer 后重放，D01-T03 公开任务 claim 后重放与单任务/单卡片，D01-T05 附件，D01-T07 创建者同毫秒 self-claim 的 60 轮真实 HTTP 重放，D02-T02 重派/并发，D02-T05 创建者拉黑，A05-T01 任务提议拒绝。
- `scripts/lib/task-attachment-gc-unit.ts`、`scripts/lib/task-create-replay-unit.ts`、`scripts/verify-protocol.ts`：新增 18 项附件保留 GC 与 56 项创建重放/旧库升级检查（含固定时钟）。
- `scripts/lib/feedback-unit.ts`：旧库升级断言加入 `0031_task_initial_assignee_known.sql`。
- `README.md`、`docs/code-index.md`、`src/mcp/{tools,skill}.ts`、`public/skills/agent-network-skills.md`：同步重派、拉黑闸门、附件保留与当时的协议/端到端计数 `883` / `1652`（本轮门禁已增至 `937` / `2074`，文档对齐留给 Q01）。
- `reports/{D01,D02,D03,A05,INTEGRATION}.md`：更新修复结论、分项计数与证据。

`0031` 不是纯增量迁移：它先全表清空 0030 回填的推断负责人，再按可证明条件重建；`0034` 才是只新增对象的迁移。网页脚本与 presence 语义除 D05 面板外未变。

## 12. 已知限制与未完成 P0

D01–D07 的实现范围已完成并通过本轮门禁，全部保持 `READY_FOR_REVIEW`，需独立验证者在集成 SHA 上签收；D08 未实现，不能签收。各任务记录的限制继续有效：

- **D01**：成果（artifact）入口仍通过 `src/domain/artifacts.ts` 的旧 `room_tasks` 校验，`tsk_` 任务暂不能提交成果（属于 M07 范围）。任务附件引用已在同一事务内建立并保留，`maintainFiles` 同时扫描新 `tasks`。
- **D01/D02**：`network_task_list` 尚未分页（`next_cursor: null`）。
- **D02/D03**：offer 过期没有清扫器，过期 offer 不会自动回 `unassigned`，需要取消后重建或后续幂等清扫。
- **D03**：进度历史最多展示 20 条（数据库保留全部审计）；未构造两个浏览器以不同顺序接收同一批 `task.updated` 的 Playwright 回放，客户端应始终以 `task_get` / `task_list` 的权威 revision 收敛。
- **D04**：交接过期是惰性处理，没有后台扫描器；撤销执行资格只处理站内任务、assignment、delivery 与 pending 交接，不声称能停止外部命令；CLI 未新增 transfer 子命令。
- **D05**：**M04（P1）未实现**，相关消息只能按 `message_id` 引用，没有原文定位/引用预览 API，因此 D05 的“消息原文交接”范围不完整（`reports/BASELINE.md` BLOCK-05）。D05 没有独立 `reports/D05.md`，本轮以第 5 节作为集成记录；实现位于未提交工作区，需独立验证者在本次提交上复跑。
- **D06**：外链只记录声明，服务端不抓取或验证；提交列表没有游标；未指定验收人的任务无法退回；没有 D06 专用浏览器断言（`test:web` 只覆盖页面不回归）。
- **D07**：验收人退群/停用不会自动通过或自动改派；`related_task_id` 已在 MCP 支持但未在网页表单暴露；没有外部业务回写通道。
- **D08**：完全未实现（无报告、无实现提交、无专项验收），仍是未关闭 P0。
- **过程**：开工时工作区已含未提交的 D05 实现，与“工作区不干净立即停止”的指令不符；本轮就地集成，未清理或回退任何已有改动。两个集成回归修复只调整测试断言，未降低服务端语义。
- **文档**：Q01 仍负责 README / CLAUDE / 技能正文与全部文档的全量对齐；`README.md` / `docs/code-index.md` 的协议计数（883）、工具总数（94）与 D05 条目尚未更新，本报告是当前权威计数。

仍未实现的 P0：

- **A 组**：A06。
- **G 组**：G06。
- **D 组**：D08（D04–D07 已实现，保持 `READY_FOR_REVIEW`）。
- **Q 组**：Q01、Q02、Q04、Q05。

依赖与阻塞：

- **D05 的 M04 缺口未关闭**：M04 只提供 `reply_to` 字段，没有原文定位/引用预览；D05 已如实把消息引用限制为 `message_id`，不能宣称“相关消息上下文完整”。纳入 M04 或缩小 D05 消息范围需要主控决定。
- **D08 未启动**：催办、取消与异常恢复没有实现；D04 的惰性过期与 D06/D07 的退回/失权不能替代。
- **A05-T01 已解除阻塞**：A05 报告为 `PASS`；任务拒绝提议、拉黑闸门与解除拉黑后的派发已有验收。
- Q02/Q04/Q05 依赖 Q01 以及各自的设备/并发/故障验收范围，本轮未扩大。

## 13. 最终状态

- 审查起点：`f8d520b7852802fa649435f593b78fb53926f309`（`docs(delivery): D07 任务报告`）。
- D04 实现/报告：`56d9c9f51ba4c805223745b6bb4d7f3dc594cf5f` / `b6d27f4d5b6e19ba129451dd05ade7e532a89957`。
- D06 实现/报告：`4eb8de8db803b5b7ad349c189345b6f784d1fd8f` / `b696df53b3779460c2448bb7030f5608d4ea9cd8`。
- D07 实现/报告：`049ce2034d8abec06062f8506d9d260d8c1354b1` / `f8d520b7852802fa649435f593b78fb53926f309`。
- D05：实现随本文件所在提交提交；无独立实现报告。
- D08：无实现、无报告、无提交。
- 集成修复与报告提交：本文件所在提交（`git log -1 -- reports/INTEGRATION.md`），在 `fix/webots-parity-pack` 上普通 push，无 force。
- 测试计数：typecheck 通过、protocol 937、acceptance 2074、web 1950、events 339、drive 52；专项 D04 128、D05 83、D06 133、D07 74（合计 418）；D08 无计数。
- 未部署、未创建 PR、未触发生产验收、未创建生产测试数据。
- D01–D07 保持 `READY_FOR_REVIEW`，待独立验证；D08 未实现，仍是未关闭 P0；A05 为 `PASS`。
