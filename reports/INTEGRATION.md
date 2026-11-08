# 集成报告 · D01–D08 + Q02/G06/A06

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 上一波次交付基线 | `620f22e0a540860a4862f4fe2531fc1b083385e5`（`fix(groups,chat): 修复邀请明文重放与提及边界`） |
| D01 实现 / 报告提交 | `cdbfb23cbdc9eb3b1bdf791f620cea1c87da1268` / `e3407a51e020471b4fde931c3f1072ae7edba85a` |
| D02 实现 / 报告提交 | `60edc7bf4ca70d0af1af871a7f69f2ccf167dd3a` / `8078570f237bf648f2f1621b87c0aec29b3cea0f` |
| D03 实现 / 报告提交 | `7e15dcc3d7bf07f96493c94e0367a11496b9c788` + `cd106af71efc7ad8c6dd779cb402f3b5e1a0c7a9` / `c4146a297f822d8e2f63179e7db22b528df01644` |
| D04 实现 / 报告提交 | `56d9c9f51ba4c805223745b6bb4d7f3dc594cf5f` / `b6d27f4d5b6e19ba129451dd05ade7e532a89957`（`docs(delivery): D04 任务报告`） |
| D05 实现 / 报告 | 实现首次入库于集成提交 `3b6afadd9d53125084b1615b0972f792e25321a0`（接手 D05 中断会话的未提交工作区，无独立实现提交）；报告 `reports/D05.md`，报告提交 `11d0adb`（`docs(delivery): D05 任务报告`） |
| D06 实现 / 报告提交 | `4eb8de8db803b5b7ad349c189345b6f784d1fd8f` / `b696df53b3779460c2448bb7030f5608d4ea9cd8`（`docs(delivery): D06 任务报告`） |
| D07 实现 / 报告提交 | `049ce2034d8abec06062f8506d9d260d8c1354b1` / `f8d520b7852802fa649435f593b78fb53926f309`（`docs(delivery): D07 任务报告`） |
| D08 实现 / 报告提交 | `40b001fc571678595e7f1a039837dbbe49cdf41b` / `3710904`（`docs(delivery): D08 任务报告`） |
| Q02 实现 / 报告提交 | `93263f607b83ca8ffe99bf32dd4ef4bfc8464fc1` / `328f0a8700229b06d9839f1d699ff9ddb27b8ace`（`docs(identity): Q02 任务报告`） |
| G06 实现 / 报告提交 | `22b23bbaeed0d7b57c52ec24dc0c9bdc1c80abc5` / `ea971d0a6de90c4688cc3abf990d97f1e24766c9`（`docs(groups): G06 任务报告`） |
| A06 实现 / 报告提交 | `03240797da343ad832bcd48afaad66e52a7dbbcd` / `0d3d712d0fc167a2b32a736060b50ea183b4967f`，另有 `a613c96e2a3204de4bb270fad8c0154e75594129`（`docs(identity): 校正 A06 报告行数`） |
| 历史修复提交（D01–D03） | `590e67312043559ed5911fae47e7a8b5d46d2661`（`docs(integration): 校正 D01-D03 验收计数`）、`9d26922`（`fix(delivery): 修复任务重派、拉黑派发与附件保留`）、`48df0ab`（`fix(delivery): 修复公开任务创建重放幂等`）、`64ca79c`（`fix(delivery): 修复同毫秒自我领取的创建重放`） |
| 历史集成提交（D04–D08） | `3b6afadd9d53125084b1615b0972f792e25321a0`（D05 实现、A01-T04/D03-T04 回归修复与集成报告初版）、`76cf3b353ab3bde24eb7c58dad2a696fe6293332`（最终集成报告） |
| 上一轮最终集成 / 独立验证 SHA | `76cf3b353ab3bde24eb7c58dad2a696fe6293332` / `fbeb86871f4519523b5509341cc98449608ed70d` |
| 本轮审查起点 HEAD | `a613c96e2a3204de4bb270fad8c0154e75594129`（`docs(identity): 校正 A06 报告行数`） |
| 本轮最终集成起点 HEAD | 同上；开工时 `git status --porcelain=v1 -b` 为空，仅 `ahead 7` |
| 本轮集成修复提交 | 首轮集成仅更新本报告；D1 修复实现 `0cf6a411b353b26385ab66bd55f7eec142a8972f`（`fix(groups): 禁止 owner 无主退群`），修复报告 `933992fe6f628b13899c4b48bf987d525042f75a` |
| 本轮最终验证 SHA / 状态 | `933992fe6f628b13899c4b48bf987d525042f75a` / **PASS**；Q02、G06、A06 已签收为 `VERIFIED`，D04–D08 保持 `VERIFIED`；详见 `reports/VERIFICATION-Q02-G06-A06.md` |
| Q01/Q04/Q05 最终验证 SHA / 状态 | `0030c7974bd04e6f85f16976b86100f344d26531` / **PASS**；Q01、Q04、Q05、AUTO-MENTION 已签收为 `VERIFIED`；详见 `reports/VERIFICATION-Q01-Q04-Q05.md` |
| Q01/Q04/Q05 最终门禁计数 | typecheck 通过；q01-doc-check 48、q01-upgrade-check 24、Q04 176、Q05 906 轮 / 24,538 断言 / 0 失败、自动 @ 73、protocol 991、acceptance 2688、web 2015、events 339、drive 52；迁移 34、`integrity_check=ok`、`foreign_key_check` 0 行 |
| 运行环境 | Bun 1.4.2，macOS；本轮最终集成 `DATA_DIR=/tmp/agentnet-qga-final/data`、`PORT=8973`、`PUBLIC_ORIGIN=http://127.0.0.1:8973`、`AGENTNET_URL=http://127.0.0.1:8973`；未使用远端服务 |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | D04–D08 保持在 `76cf3b3` 上的独立验证 `VERIFIED`；Q02/G06/A06 已在 `933992f` 上独立验证签收为 `VERIFIED`（D1 owner 无主退群修复复验 PASS）。本轮门禁：typecheck、G06 119、G03 104、G01 65、G05 67、protocol 991、acceptance 2615、web 2012、Q02 77/45、A06 139、events 339、drive 52；迁移 34 个、`integrity_check=ok`、`foreign_key_check` 无违规。Q02/G06/A06 的残余限制已如实记录。Q01/Q04/Q05 与自动 @ 已在 `0030c79` 上独立验证签收为 `VERIFIED`；最终门禁 acceptance 2688、web 2015、Q04 176、Q05 906 轮/0 失败、自动 @ 73；剩余 P0 无 |

## 0. 审查范围与结论

本轮在 `a613c96` 上审查 Q02（安全设备配对与离线同步）、G06（退群移除解散与在途工作）、A06（Agent 管理权交接）的合并结果，并复核三者与 D01–D08 共享的事务、迁移、事件、工具面、技能正文、网页脚本与验收注册。后续独立验证发现 G06 D1（owner 无主退群），修复提交为 `0cf6a41`，本报告的最终验证与签收 SHA 为 `933992f`；详见 `reports/VERIFICATION-Q02-G06-A06.md`。

- 迁移文件共 34 个：`0001`–`0012`、`0017`–`0038`，`0013`–`0016` 历史上从未使用。Q02 的 `0036_device_pairing_sync.sql`、G06 的 `0037_room_lifecycle.sql` 与 D1 修复的 `0038_ownerless_room_guard.sql` 分别是各自提交中的新文件；`git diff 5b706aa..HEAD -- migrations/` 只有 `0038` 新增 15 行，已发布迁移未被修改，序号唯一。`0038` 只创建 `guard_owner_missing` 空闸门表，不回填或硬删旧数据。新库启动按序应用全部 34 个迁移，`PRAGMA integrity_check` = `ok`，`foreign_key_check` 返回 0 行。
- 新增闸门只有 `guard_device_stale → CONFLICT`（Q02）、`guard_room_dissolved → CONFLICT`（G06）与 `guard_owner_missing → CONFLICT`（D1 修复），`GUARD_TABLES` 与 `runner.ts` 的错误码/文案/`details` 映射一致；A06 没有新增迁移或闸门。`guard_owner_missing` 只接受 `x = 0`，插入 `x = 1` 触发 CHECK 失败。
- 共享文件（`src/mcp/{tools,outputs,skill}.ts`、`public/skills/agent-network-skills.md`、`src/domain/tasks.ts`、`src/realtime/hub.ts`、`src/web/chat-*.ts`、`scripts/{acceptance,verify-protocol,verify-web}.ts`）在三个实现提交与 D1 修复中顺序叠加，没有互相覆盖：D01–D08 的 32 个任务工具仍在，整体工具面 129 个（Drive 与房间文件开启）/ 120 个（关闭）；Q02 新增 8 个设备工具、G06 新增 2 个房间生命周期工具、A06 新增 5 个交接工具。`skills/list`、`skills/get` 与 SKILL.md 资源读取共用同一正文，协议断言 `sha256` digest 与正文一致。
- 通知边界保持：设备事件只用 `inboxHeadStatement(pendingDelta = 0)`，不创建 delivery、不增加 `pending_count`；房间生命周期事件只写 room scope 与 `room:<id>` outbox，不推进 `rooms.head_seq`；A06 的交接事件写 human-only inbox/outbox，不创建 delivery、不增加 Agent `pending_count`。三者都未修改 D04–D08 的 assignment/task/delivery 语义。
- 本轮全量门禁：`test:protocol` 991 项（129 个工具）、`test:acceptance` 2615 项、`test:web` 2012 项、`test:events` 339 项、`test:drive` 52 项；专项 Q02 pairing 77、Q02 sync 45、G06 119（含 G06-T05）、G03 104、G01 65、G05 67、A06 139。D04–D08 的专项计数与 `reports/D04.md`–`D08.md` 一致，状态保持 `VERIFIED`。
- 首轮集成未发现需要修改业务代码的集成回归；独立验证随后发现 D1（owner 无主退群），修复提交 `0cf6a41` 收窄退群并在 `933992f` 复验通过。工作区在开工与结束时均为干净，未触碰主 checkout。
- 上一轮（D04–D08）结论保持：任务写入满足 `runIdempotent` + `db.batch()` 全有或全无，写操作校验 active assignment、`assignment_version` 与 task revision；D05 `guard_handoff_conflict → CONFLICT` 与 D07 `guard_review_stale → REVIEW_STALE` 仍在；任务/交接/提交/验收事件为 human-only `task.updated` informational，D08 `task_reminder` 是唯一新增的 inbox 提醒。上一轮的两个集成回归修复（A01-T04、D03-T04）只更新断言与 `TaskView` 测试类型，未降低服务端语义。
- 过程偏差：D04–D07 集成开工时工作区已包含完整但未提交的 D05 实现（21 个修改 + 6 个未跟踪文件），与“工作区不干净立即停止”的指令不符。为避免丢弃已有实现，该轮就地审查并集成该工作区，未执行 `reset`/`stash`/`clean`，也未触碰主 checkout；D05 因此没有独立实现提交，本轮已补写 `reports/D05.md` 承担语义与证据，本报告第 5 节只保留集成摘要。

上一轮（D04–D08）对既有集成报告的修正（保持）：

1. 修正“同毫秒 self-claim 回归随本文件同提交”的陈旧提交名：实际修复提交是 `64ca79c`，公开任务创建重放幂等修复是 `48df0ab`。
2. 修正 `0031` 的“纯增量”措辞：该迁移先执行 `UPDATE tasks SET initial_assignee_actor_id = NULL` 全表清空 0030 的推断值，再按创建事件或 pristine offer 的可证明条件回填 `initial_assignee_known = 1` 与负责人，其余旧行保持 `known = 0`；不是只追加列。
3. D04–D08 的实现 SHA、门禁计数、限制与 D05/D08 专项写入本报告。`README.md` / `docs/code-index.md` 的协议与工具计数仍是 D03 基线（883 项 / 94 个工具），D05/D08 也尚无文档条目；按任务边界留给 Q01 全量对齐，本报告是当前权威计数。

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

## 5. D05 可授权交接上下文包（实现随集成提交补入）

- 新增 4 个 MCP 工具 `network_task_handoff_pack_create/get/authorize/request_more`；任务工具 25 → 29，整体工具面 111/102。新增 `0034_task_handoff_packs.sql`：`task_handoff_packs`（每次生成新版本）、`task_handoff_pack_items`（只存引用与短标签/摘要）、`task_handoff_context_requests` 与只接受 `x = 0` 的 `guard_handoff_conflict`；不改写既有行。
- 交接包记录目标、已完成、当前结果（可绑定 `submission_id` + version）、未解决、下一步与引用清单；引用 kind 限于 `message`、`file`、`branch`、`commit`、`test`、`submission`，不复制群历史正文或文件字节。`create` 只允许当前负责人且持有当前 active assignment、任务处于 `in_progress`/`blocked`；`version = max + 1`，旧版本原样保留。
- `get` 按 `pack_id` 或 `version` 读取，省略时返回最新版与版本列表；对每个引用按当前读取者重新判定 `available` / `missing` / `omitted`，必需缺失汇总到 `required_missing`，`context_ready=false` 表示不完整。同一任务房间的材料直接可用；`source_room_id` 跨范围的消息与文件默认 `omitted` 且无 URL，必须由源范围有权限的身份（文件上传者或源房间 owner/管理员、消息可见者）显式 `authorize grant`。`revoke` 只关闭授权，不删除版本或引用记录。
- 文件读取仍由 `/f` 实时票据与成员资格决定：`handoff-ticket` 同时校验目标房间票据、包项授权、授权人仍 active 且仍可见源范围；撤回或授权来源失权后旧 URL 立即 404，重读包显示 `omitted` 与 `authorization_source_lost`。
- 接任时若存在包且 `context_ready=false`，换人仍成功，但任务转 `blocked` + `blocked_reason = 'context_incomplete'`；没有包时保持 D04 的 `context_ready=false` 兼容行为。`request_more` 由待接受提议目标或当前负责人追加补充请求，不改变责任、assignment、任务状态或 revision。
- `task_handoff_pack_created` / `_item_authorized` / `_item_revoked` / `_context_requested` 只写 room scope 与 `room:<id>` outbox，映射为 human-only `task.updated` informational；不创建 delivery、不增加 `pending_count`、不推进 `head_seq`。网页 `chat-task-handoff-script.ts` 在任务详情展示版本、缺项/可授权项、就绪状态与“授权给接任者”入口；`chat-tasks-script.ts` 抽出 `chat-task-detail-script.ts` 后为 969 行。
- **来源与报告**：D05 没有独立实现提交。基线 `f8d520b` 上，工作区已存在来自中断 D05 会话的完整未提交实现；集成提交 `3b6afad` 首次将其入库，并同时包含 D04–D07 集成与两个回归修复。原实现者、原始开工 SHA 与原始提交信息无法还原，本报告与 `reports/D05.md` 均不伪造。`reports/D05.md` 已补写，并已在 `76cf3b3` 上独立验证签收。
- **依赖缺口（未关闭）**：D05 的“相关消息”只保存 `message_id`；读取时最多附带当前仍可见消息的截断 `preview`，没有 M04 的引用摘要、quote anchor、跨页原文定位或撤回占位 API，也没有版本化原文快照。因此 D05 的版本化包、文件授权与缺项判定可验收，但“消息原文交接”范围不完整，不能按 M04 已就绪签收（`reports/BASELINE.md` 的 BLOCK-05；`scripts/lib/task-handoff-acceptance.ts` 也明确不伪造 quote anchor）。
- D05 专项 83 项（T01 41 + T02 31 + T03 10 + 环境 1），覆盖版本化、跨群默认不可读/授权后可读/撤回即失效、必需缺失导致 `blocked + context_incomplete`、源范围失权后 `omitted` 与旧 URL 失效。协议验收新增 29 个任务工具、四个交接工具 schema/描述、`handoff_pack_get` 只读与技能正文断言；网页验收包含建包、缺项、授权与 `context_ready=true` 的浏览器路径。真实命令与逐项证据见 `reports/D05.md` 第 2 节。

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

## 8. D08 催办/取消/异常恢复

- 实现提交 `40b001fc571678595e7f1a039837dbbe49cdf41b`，基线 `d0c6230483f63e255fca8f5ad3330f7f5aaaed51`；报告 `3710904`（`docs(delivery): D08 任务报告`）。新增迁移 `0035_task_recovery.sql`：`task_reminders`、`task_external_actions` 与 `tasks.cancelled_by` / `cancel_reason` / `external_stop_status`，不改写既有行。
- 催办：`remindStaleTasks` 扫描 `in_progress` 或仍有负责人的 `blocked` 任务，当前 assignment 必须仍 `active`，且 `COALESCE(tasks.last_progress_at, assignment.last_progress_at, assignment.accepted_at, assignment.created_at)` 超过 `LIMITS.taskReminderMs = 3 * 60_000` 未更新。同一 assignment 仍有 pending/claimed `task_offer` delivery 时跳过，避免与 delivery 提醒重复；`task_reminders` 以 `(task_id, assignment_id, anchor_at)` 和 `event_key` 双重唯一收敛窗口，每轮最多 50 条。提醒只写当前责任者 inbox `task_reminder` 事件与 `inbox:{actor}` outbox，并推进该 actor 的 `inbox_head_seq`；不创建 task/assignment/delivery、不增加 `pending_count`、不写 room scope、不推进 `rooms.head_seq`。扫描接入 `src/maintenance.ts` 兜底周期与 `src/bun/main.ts` 与 delivery reminder 共用的 30s 快路径。
- 取消加固：`taskCancel` 保持创建者/当前负责人/群 owner 或管理员的权限与 `expected_revision` CAS；同一事务把任务转 `cancelled`、清空 owner/current assignment、撤销当前 assignment（含 `submitted`）、关闭该任务所有 pending/claimed 的 `task_offer` / `task_reminder` delivery、取消 pending 交接、写 `task_cancelled` room 事件与 outbox。`external_stop_status` 只接受 `confirmed` / `unknown` / `not_required`，省略时进行中或受阻记为 `unknown`，其余记为 `not_required`；`confirmed` 只是操作者声明，不是服务端验证结果。取消 `submitted` 保留 `task_submissions` 与 `task_reviews` 审计行，任务不能继续验收。
- 外部执行未知与对账：`network_task_execution_unknown` 只允许当前负责人、`in_progress` 且持有当前 active assignment，把任务转 `blocked + execution_unknown`，写 `task_progress` 审计，并在 `task_external_actions` 以 `(task_id, action_id)` 稳定去重；重复上报返回同一快照，不递增 revision。`network_task_execution_resolve` 只允许当前负责人、action 仍为 `unknown` 且任务仍为 `blocked + execution_unknown`；`confirmed` / `not_executed` 恢复 `in_progress` 并清空阻塞字段，`rejected` 保持 `blocked` 并标记 `execution_rejected`。证据只存 `task_external_actions.evidence`，事件只记录 `outcome` 与 `evidence_bytes`。`network_task_resume` 拒绝 `blocked_reason = execution_unknown`，不能绕过对账。
- 重试/重派：`network_task_retry` 只接受 `failed` 任务，由创建者、群 owner 或管理员调用；同一事务撤销旧 `offered` / `active` assignment、关闭所有 pending/claimed 任务投递、取消 pending 交接、递增 `task_revision`。指定 `assignee_actor_id` 时生成 `assignment_version = max + 1` 并回到 `offered`（Agent 候选生成新投递与必要的新卡片，human 候选收到持久个人通知）；省略时回到 `unassigned`。旧负责人的进度、成果与继续派活资格随 assignment 失效。
- 重启与补读：任务可见性来自持久 `tasks` / `task_assignments` / `events` / `outbox`，服务重启不恢复旧进程栈。`stream.ts` 把 `task_reminder` 映射为 `source: "task.reminder"`、`kind: "reminder"`、`attention: "action_required"`；`task_retried` / `task_execution_unknown` / `task_execution_resolved` 继续映射为 human-only `task.updated` informational。断线重连后可用 `network_task_summary` / `network_task_list` 读取权威任务，`network_sync` inbox 补读 `task_reminder`，room scope 补读任务事件。
- 工具面从 29 增至 32，整体 114/105；`taskSchema` 增加取消审计字段与 `can_retry` / `can_report_execution_unknown` / `can_resolve_execution`；网页新增 `chat-task-recovery-script.ts`（124 行）提供重试、标记执行未知与对账入口，`chat-tasks-script.ts` 保持 999 行；`src/mcp/skill.ts` 与 `public/skills/agent-network-skills.md` 同源更新。
- 本轮复核结论：`reports/D08.md` 的行为描述与 `40b001f` 的迁移、domain、工具、事件与网页片段一致，未发现需要修改语义或代码的明显不一致；D08 报告中的集成 SHA 仍写“待集成”，以本报告第 16 节与最终提交为准。D08 专项 147 项（T01 26 / T02 48 / T03 51 / T04 22），详见第 13 节与 `reports/D08.md`。

## 9. Q02 安全设备配对与离线同步

- 迁移 `0036_device_pairing_sync.sql`：扩展 `device_pairings`（创建设备凭据、目标设备标识、平台、token 摘要、撤销时间/原因），新增 `idx_device_pairings_actor_status` 与部分索引 `idx_device_pairings_device_token`，新增 `guard_device_stale`（只接受 `x=0`）；已有 credentials 没有 devices 行时按 `(actor_id, device_id)` 回填，设备状态由是否仍有未撤销凭据推导；不修改已发布迁移。
- 新增 8 个设备工具：`network_device_pairing_{create,join,list,approve,cancel,redeem}`、`network_device_list`、`network_device_revoke`。挑战为 12 位 Crockford 短码，默认 5 分钟；明文只在首次响应出现，服务端只保存带域前缀的 SHA-256。同一 `request_id` 重放返回 `TOKEN_NOT_REPLAYABLE`，`operations.result_json` 不含 challenge、token 或配对 URL。
- 新设备用自己本地生成、尚未注册的 token 调用 `join`；服务端把挑战绑定到该 token 摘要并返回设备名称、平台与确认码。已绑定其他 token 的挑战不能被第三台设备抢绑（`device_mismatch`），错误尝试累计，达到 `max_attempts` 后转为 `cancelled`。批准只写配对状态与安全事件，不创建 credential；新设备随后 `redeem` 得到同 actor 的独立 credential，响应从不返回 token。
- `network_device_list` 返回设备、平台、状态、`current`、`last_seen_at`（`devices.last_seen_at` 与 credentials 最近活动的较大值）与有效/总凭据数；认证路径按 `LIMITS.deviceActivityThrottleMs` 节流写活动，不写事件、不产生未读。`network_device_revoke` 在同一事务撤销该设备全部有效凭据、取消其待确认挑战、写 `device_revoked` inbox 事件与 outbox；hub 通过 `revokeCredential` 立即关闭该设备的活跃 stream，并阻止撤销与建立订阅并发时旧凭据迟到注册。其他设备继续可用，A01 的管理关系不受影响。
- 浏览器新增 `src/web/chat-identity-script.ts`：已确认身份、Agent 注册表、发送队列、草稿与 sync 游标按 `actor` 分区；已有 token 失效时不再自动注册替代身份，只显示“凭据失效”与重新配对入口。旧 `/#t=` 不再自动写入 token，只作为折叠的“旧方式（长期凭据）”在显式确认后切换。新增 `/pair` 页面，用一次性挑战 + 本地 token 完成配对。
- `network_sync` 的每条事件新增 `event_id`，页面新增 `head_cursor`；`syncCatchUp` 首次用 `head_cursor` 初始化游标，重连按游标补读并按 `event_id`/seq 去重，`reset_required` 时清空游标并完整刷新，不重跑历史任务或重复外部副作用。
- 事件：`device_pairing_requested/approved/cancelled`、`device_paired`、`device_revoked` 均为 `pendingDelta = 0` 的 inbox 提示，不创建 delivery、不增加 `pending_count`、不推进 `rooms.head_seq`。
- Q02 专项 77 + 45 项通过；覆盖两设备同 actor 不同 credential、单设备撤销与 stream 关闭、列表/last_seen/current、过期/重放/第三设备抢绑/尝试超限、断线补读去重、未读恢复、身份切换与失效 token 隔离。

## 10. G06 退群移除解散与在途工作

- 迁移 `0037_room_lifecycle.sql`：`rooms` 追加 `dissolved_at`、`dissolved_by`、`dissolve_reason`、`archive_head_seq`、`archive_member_seq`；新增 `guard_room_dissolved`；重建 `room_management_audit` 加入 `room_dissolved`，保留全部旧行；未重建 `rooms`/`room_members`/任务/文件表。
- 新增只读 `network_room_leave_preview` 与 owner-only `network_room_dissolve`；`network_room_leave` 增加 `confirm_in_flight`。退群/移除在同一事务撤销任务执行资格：`in_progress/blocked → blocked + owner_lost_eligibility`，未接受的 `offered → unassigned`，撤销 offered/active assignment、关闭任务投递、取消 pending 交接；复用 D04 `revokeTaskEligibilityStatements`，没有第二套状态机。
- 被移除者的旧 claim、旧任务提交、按 ID 读取任务/历史与旧文件票据立即失败，其其他群与身份不受影响。`member_left`、`member_removed`、`room_dissolved` 只写 room scope 事件与 `room:<id>` outbox，不创建 delivery、不增加 `pending_count`、不推进 `rooms.head_seq`；成员变化只推进 `member_seq`。
- 解散在同一事务取消所有未结束任务（`reason = room_dissolved`，不自动 accepted/completed）、撤销全部 offered/active/submitted assignment 与 pending 交接、取消 pending/claimed delivery 并按当前 pending 行数递减 `pending_count`、撤销 pending 邀请/入群申请/owner 转让、写管理审计；设置归档水位，不删除业务行。群主不能带着其他 active 成员直接退群。
- 归档只读：消息、时间线、sync、文件、任务、按 ID 直读与文件票据授权都以 `archived_head_seq` 为上界；`room_get`/`rooms_list` 返回解散字段与 `read_only`，`capabilities` 关闭写能力；网页显示归档横幅、隐藏输入/上传/新建任务，会话列表标注“已解散 · 只读归档”。
- 失权与解散事件 metadata 含 `media_revoke: true`，作为 M09 媒体层的稳定撤权钩子；当前没有媒体平面可终止。
- G06 专项 104 项通过；覆盖旧 claim/提交/文件票据失败、在途预览与确认退群、10 轮移除 × D04 接任并发、解散写入拒绝、归档边界与审计保留。T04 媒体部分为 `PARTIAL`，理由见限制。

## 11. A06 Agent 管理权交接

- 无新增迁移；复用 `0012_identity_management_devices.sql` 的 `agent_management_transfers` 与 `idx_agent_transfers_pending`。
- 新增 5 个工具：`network_agent_transfer_{propose,respond,cancel,get,list}`。只有该 Agent 的 active manager 可发起，接任者必须是已注册、有有效凭据、未停用/归档的 human；同一 Agent 只允许一条 pending，默认 `LIMITS.agentTransferTtlMs = 24h`。拒绝、取消、过期只关闭提议，不修改管理关系、不撤销委托、不轮换凭据、不改任务。
- 接受在单个 `db.batch()` 内完成：校验提议仍 pending/未过期/接任者身份与当前管理关系版本；切换 `manager_id`、`grant_source = 'transfer'`、`permission_version + 1`；撤销全部 active 委托与未撤销凭据并插入一条新 SHA-256 凭据；复用 D04 `revokeTaskEligibilityStatements` 处理所有房间的未结束任务（`blocked_reason = management_transferred`，未接受的 `offered` 回 `unassigned`）；写双方 human inbox 与审计。提交后由工具层关闭旧 stream，旧 token 立即 `CREDENTIAL_INVALID`。
- `operations.result_json` 只保存非秘密结果（`token`/`mcp_url` 为 `null`）；首次接受返回一次性 token，同一 `request_id` 重放返回同一非秘密结果，不再轮换、不再关闭新连接。旧管理者在交接后改名、重发、停用、归档、读取管理均 `PERMISSION_DENIED`。
- `network_agent_management_get` 追加 `rooms`、`delegations`、`pending_transfer`、`in_flight_deliveries`、`audit_summary`、`can_transfer`，`my_role` 增加 `successor`；接任者确认前 `can_manage = false`。交接不复制私聊、联系人、群成员身份或外部平台授权，不把新管理者加入任何房间。
- 交接后的 blocked 任务没有 owner/assignment；`network_task_offer` 允许有权派发者显式重派并清空 `blocked_reason`，已有 owner 的 blocked 任务仍不能绕过原负责人。任务不会因交接自动 accepted/completed。
- 网页在 direct Agent 会话右键菜单新增“交接管理权”（群聊与人类会话隐藏），面板展示 pending、在途群关系/任务/投递摘要，接任者可接受/拒绝；接受后一次性显示新 MCP URL 并写入本机注册表，关闭面板即从 DOM 清除 token。
- A06 专项 139 项通过；覆盖拒绝/取消/过期不改权限、接受轮换、重放不重复轮换、6 轮接受 × 旧管理者重发并发、任务失权与重派、私聊/联系人/外部授权隔离。

## 12. 跨功能接缝核对

- **迁移与旧库升级**：新库启动按序应用 34 个迁移文件（`0001`–`0012`、`0017`–`0038`，`0013`–`0016` 从未使用）；`0031` 未修改已发布内容，`0032`/`0033` 已提交，`0034` 随 `3b6afad` 提交，`0035` 随 `40b001f` 提交，`0036` 随 `93263f6`（Q02）、`0037` 随 `22b23bb`（G06）、`0038` 随 `0cf6a41`（D1）提交并为最后一个。旧库升级断言包含 `0017`、`0029`–`0038`，原业务数据与表结构保留；`git diff 5b706aa..HEAD -- migrations/` 只有 `0038` 一个新增文件。
- **错误映射**：`guard_task_state → CONFLICT`、`guard_version_conflict → VERSION_CONFLICT`、`guard_assignment_stale → ASSIGNMENT_STALE`、`guard_request_expired → REQUEST_EXPIRED`、`guard_claim_conflict → CLAIM_CONFLICT`、`guard_handoff_conflict → CONFLICT`、`guard_review_stale → REVIEW_STALE`、`guard_device_stale → CONFLICT`、`guard_room_dissolved → CONFLICT`，与各任务错误快照一致；D08 `0035` 没有新增闸门，无同名 guard 冲突。
- **通知与流**：任务基础事件、`task_transfer_proposed/accepted/rejected/cancelled/expired`、`task_handoff_pack_created/_item_authorized/_item_revoked/_context_requested`、`task_submitted`、`task_returned`、`task_accepted`、`task_retried`、`task_execution_unknown`、`task_execution_resolved`、`task_reviewer_changed` 统一映射为 human-only `task.updated` informational，带 `change`、`task_id`、`assignment_id`、`status`、`revision`、`changed_by`（适用时带 `submission_id` / `submission_version`）；不推进 head、不产生未读、不唤醒 Agent。D08 `task_reminder` 是当前责任者 inbox 提醒，映射为 `source: "task.reminder"`、`kind: "reminder"`、`attention: "action_required"`，不是新 delivery。inbox 侧 `task_offered` 为 `action_required`，`task_cancelled` 为 informational。Q02 的设备事件映射为 `source: 'device'`、`kind: 'device'`、`attention: 'informational'`，`pendingDelta = 0`；G06 `member_left/member_removed/room_dissolved` 只走 room scope 与 `room:<id>` outbox，不推进 `head_seq`；A06 `management_transfer_*`/`management_transferred`/`credential_rotated` 写 human-only inbox/outbox，不创建 delivery、不增加 Agent `pending_count`。
- **delivery 与任务分离**：delivery 的 claim/report/complete/fail 仍只表示通知处理，不改变任务 owner 或业务状态；D02/D03/D06 专项均断言 delivery complete 后任务仍为真实状态。G06/A06 复用 D04 的失权入口，未新增第二套 owner/assignment 状态机。
- **工具面**：协议验收断言 32 个任务工具的清单与顺序，整体工具面 129 个（Drive 与房间文件开启）/ 120 个（关闭）；旧 `network_task_add/list_get/complete/fail/update/delete` 已退休。
- **网页**：`chat-tasks-script.ts` 999 行、`chat-identity-script.ts` 869 行、`chat-room-menu-script.ts` 774 行、`chat-script.ts` 910 行、`chat-task-handoff-script.ts` 452 行、`chat-transfer-script.ts` 404 行、`chat-task-submission-script.ts` 436 行、`pair.ts` 391 行、`chat-task-transfer-script.ts` 347 行、`chat-task-review-script.ts` 249 行、`chat-task-progress-script.ts` 213 行、`chat-task-recovery-script.ts` 124 行、`chat-task-detail-script.ts` 43 行，均低于 1000 行；设备配对、交接、任务面板、交接包、提交/退回、验收、改派、恢复与既有聊天、文件、监控、移动端共用同一脚本作用域，`test:web` 2012 项覆盖（含 Q02 配对页、G06 解散/归档与 A06 交接入口）。
- **文档**：D04/D06/D07/D08 与 Q02/G06/A06 的功能正文、工具清单与技能正文已随各自提交同步，`reports/D05.md` 已补写；`README.md` / `docs/code-index.md` 的协议、工具总数与 D05/D08/Q02/G06/A06 条目仍是 D03 基线，按任务边界留给 Q01 全量对齐；本报告是当前权威计数。

## 13. 命令与结果

本轮最终集成实测（`AGENTNET_URL=http://127.0.0.1:8973`，`PORT=8973`、`DATA_DIR=/tmp/agentnet-qga-final/data`、`PUBLIC_ORIGIN=http://127.0.0.1:8973`，presence 窗口 5000/2000/1000）：

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0，无诊断 |
| `AGENTNET_URL=http://127.0.0.1:18994 bun run test:protocol` | 通过 | `协议验收通过: 991 项`；`tools/list` 返回 129 个工具，任务工具 32 个；技能正文 digest 与条目一致 |
| `AGENTNET_URL=http://127.0.0.1:18994 AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 AGENT_PRESENCE_GRACE_MS=2000 AGENT_PRESENCE_SWEEP_MS=1000 bun run test:acceptance` | 通过 | `端到端验收通过: 2615 项`；其中 `D08 专项通过: 147 项（T01 26 / T02 48 / T03 51 / T04 22）` |
| `bun run test:web` | 通过 | `浏览器验收通过 2012 项`（脚本自托管临时实例；滚动断言通过） |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项`（自托管临时实例） |
| `AGENTNET_URL=http://127.0.0.1:8973 bun run test:drive` | 通过 | `drive checks passed: 52` |
| Q02 pairing 专项 | 通过 | `Q02 pairing checks passed: 77` |
| Q02 sync 专项 | 通过 | `Q02 sync checks passed: 45` |
| G06 专项 | 通过 | `G06 checks passed: 104` |
| A06 专项 | 通过 | `A06 checks passed: 139` |
| 工具计数 | 通过 | 开启 Drive/房间文件时 129 个；关闭时为 120 个（129 − 9） |
| 迁移启动与数据库 | 通过 | 新库按序应用 34 个迁移；`PRAGMA integrity_check` = `ok`；`foreign_key_check` 0 行 |
| `git diff --check 76cf3b3..HEAD` | 1 条非阻塞告警 | `src/domain/device-pairings.ts:930` 文件末尾多余空行（Q02 提交遗留）；不影响门禁，本轮未改源码 |

主实例启动方式：

```bash
DATA_DIR=/tmp/agentnet-qga-final/data \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8973 \
PORT=8973 bun run start
```

Q02/G06/A06 专项命令：

```bash
AGENTNET_URL=http://127.0.0.1:8973 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runDevicePairingAcceptance } from './scripts/lib/device-pairing-acceptance'; await runDevicePairingAcceptance(); console.log('Q02 pairing checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8973 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runDeviceSyncAcceptance } from './scripts/lib/device-sync-acceptance'; await runDeviceSyncAcceptance(); console.log('Q02 sync checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8973 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runRoomLifecycleAcceptance } from './scripts/lib/room-lifecycle-acceptance'; await runRoomLifecycleAcceptance(); console.log('G06 checks passed: ' + checksPassed());"
AGENTNET_URL=http://127.0.0.1:8973 bun -e "import { checksPassed } from './scripts/lib/harness'; import { runAgentTransferAcceptance } from './scripts/lib/agent-transfer-acceptance'; await runAgentTransferAcceptance(); console.log('A06 checks passed: ' + checksPassed());"
```

D04–D08 专项命令仍使用同一模式（`runTaskTransferAcceptance`、`runTaskHandoffAcceptance`、`runTaskSubmissionAcceptance`、`runTaskReviewAcceptance`、`runTaskRecoveryAcceptance`），本轮未单独重跑，沿用 `reports/D04.md`–`D08.md` 的计数；全量 `test:acceptance` 已包含这些注册用例。`test:protocol`、`test:acceptance` 与 `test:drive` 使用本地 `http://127.0.0.1:8973`；`test:web` 与 `test:events` 各自启动临时实例。全量 `test:acceptance` 同时覆盖 D01–D08、A05 与 Q02/G06/A06 的注册用例。

## 14. 集成改动

本轮 Q02/G06/A06 的实现分别在 `93263f6`、`22b23bb`、`0324079` 中，报告在 `328f0a8`、`ea971d0`、`0d3d712`（A06 另有 `a613c96` 行数校正）。本轮最终集成在 `a613c96` 的干净工作区上只更新 `reports/INTEGRATION.md`，没有改业务代码、迁移或测试断言，也没有集成回归需要修复。

上一轮 D04/D06/D07 的实现已在各自提交中；D05 的未提交实现与两个集成回归修复在 `3b6afad` 中；D08 在 `40b001f` 中；`3710904` 是 D08 报告。上一轮最终集成在 `3710904` 的干净工作区上补写 `reports/D05.md` 并更新本报告，没有改业务代码、迁移或测试断言。D05 在 `3b6afad` 中的改动：

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
- `reports/INTEGRATION.md`：D04–D08 章节与门禁计数；修正陈旧提交名与 `0031` 全表回填措辞。

D08 在 `40b001f` 中的改动（本轮复核未改其语义）：

- `migrations/0035_task_recovery.sql`：`task_reminders`、`task_external_actions`、任务取消审计列与索引/CHECK；只追加对象与列，不改写既有行。
- `src/domain/task-reminders.ts`、`src/domain/task-recovery.ts`：3 分钟窗口催办、窗口去重、执行未知/对账与证据持久化。
- `src/domain/tasks.ts`：`taskCancel` 原子失效当前 assignment、全部 pending/claimed 任务投递与 pending 交接，保留成果/验收审计；`taskRetry` 仅重派 `failed` 任务并生成新版本；`network_task_resume` 拒绝 `execution_unknown`。
- `src/contracts/{limits,schemas}.ts`、`src/mcp/{tools,outputs,skill}.ts`、`public/skills/agent-network-skills.md`、`public/skills/agent_tasks.sh`：3 个新工具、取消审计字段、`can_*`、技能正文与 CLI 封装。
- `src/realtime/stream.ts`：`task_reminder` 提醒映射，以及 `task_retried` / `task_execution_unknown` / `task_execution_resolved` 的 human-only informational 投影。
- `src/bun/main.ts`、`src/maintenance.ts`：30s 快路径与维护周期接入任务催办。
- `src/web/chat-task-recovery-script.ts`、`src/web/chat-script.ts`、`src/web/chat-tasks-script.ts`、`src/web/chat-styles.ts`：失败重试、标记执行未知、对账结论与取消外部停止状态入口。
- `scripts/lib/task-recovery-acceptance.ts`、`scripts/acceptance.ts`、`scripts/verify-protocol.ts`、`scripts/verify-web.ts`、`scripts/lib/feedback-unit.ts`、`scripts/lib/task-create-replay-unit.ts`：D08 专项 147 项、协议/网页断言与 `0035` 旧库升级清单。
- `reports/D08.md`：D08 实现报告，已在 `76cf3b3` 上独立验证签收。

### 历史（D01–D03）改动

- `src/domain/tasks.ts`：同候选重派生成新卡片/assignment/delivery；创建者-候选拉黑闸门；`convergeSourceTask` 比较全部语义参数，初始负责人只读 `initial_assignee_known = 1` 的权威列，`known = 0` 的旧行跳过负责人比较；任务附件建立引用并 retained。
- `migrations/0030_task_initial_assignee.sql`：新增可空 `initial_assignee_actor_id`。
- `migrations/0031_task_initial_assignee_known.sql`：新增 `initial_assignee_known`；先全表执行 `UPDATE tasks SET initial_assignee_actor_id = NULL` 清除 0030 的推断值，再按创建事件或 pristine offer 证明回填负责人与 `known = 1`，其余保持 `known = 0`。
- `src/maintenance.ts`：任务引用回收同时扫描新 `tasks`。
- `scripts/lib/{room-task-acceptance,task-assignment-acceptance,contact-block-acceptance}.ts`：D01-T02 参数冲突、accept/reoffer 后重放，D01-T03 公开任务 claim 后重放与单任务/单卡片，D01-T05 附件，D01-T07 创建者同毫秒 self-claim 的 60 轮真实 HTTP 重放，D02-T02 重派/并发，D02-T05 创建者拉黑，A05-T01 任务提议拒绝。
- `scripts/lib/task-attachment-gc-unit.ts`、`scripts/lib/task-create-replay-unit.ts`、`scripts/verify-protocol.ts`：新增 18 项附件保留 GC 与 56 项创建重放/旧库升级检查（含固定时钟）。
- `scripts/lib/feedback-unit.ts`：旧库升级断言加入 `0031_task_initial_assignee_known.sql`。
- `README.md`、`docs/code-index.md`、`src/mcp/{tools,skill}.ts`、`public/skills/agent-network-skills.md`：同步重派、拉黑闸门、附件保留与当时的协议/端到端计数 `883` / `1652`（D04–D07 集成时为 `937` / `2074`，最终 D04–D08 集成为 `949` / `2221`；文档对齐留给 Q01）。
- `reports/{D01,D02,D03,A05,INTEGRATION}.md`：更新修复结论、分项计数与证据。

`0031` 不是纯增量迁移：它先全表清空 0030 回填的推断负责人，再按可证明条件重建；`0034` 与 `0035` 只新增表/索引/列，不改写既有行。网页脚本与 presence 语义除 D05/D08 面板外未变。

## 15. 已知限制与未完成 P0

D04–D08 的实现范围已完成并通过本轮门禁，且已在 `76cf3b3` 上由独立验证签收为 `VERIFIED`（见 `reports/VERIFICATION-D04-D08.md`）；Q02、G06、A06 已在 `933992f` 上由独立验证签收为 `VERIFIED`（见 `reports/VERIFICATION-Q02-G06-A06.md`），D01–D03 仍为 `READY_FOR_REVIEW`。没有任务因本轮复核改语义。各任务记录的限制继续有效：

- **D01**：成果（artifact）入口仍通过 `src/domain/artifacts.ts` 的旧 `room_tasks` 校验，`tsk_` 任务暂不能提交成果（属于 M07 范围）。任务附件引用已在同一事务内建立并保留，`maintainFiles` 同时扫描新 `tasks`。
- **D01/D02**：`network_task_list` 尚未分页（`next_cursor: null`）。
- **D02/D03**：offer 过期没有清扫器，过期 offer 不会自动回 `unassigned`，需要取消后重建或后续幂等清扫。
- **D03**：进度历史最多展示 20 条（数据库保留全部审计）；未构造两个浏览器以不同顺序接收同一批 `task.updated` 的 Playwright 回放，客户端应始终以 `task_get` / `task_list` 的权威 revision 收敛。
- **D04**：交接过期是惰性处理，没有后台扫描器；撤销执行资格只处理站内任务、assignment、delivery 与 pending 交接，不声称能停止外部命令；CLI 未新增 transfer 子命令。
- **D05**：**M04（P1）未实现**，消息引用只保存 `message_id`；读取时最多附带当前仍可见消息的截断 `preview`，没有 M04 的引用摘要、quote anchor、跨页原文定位或撤回占位，也没有版本化原文快照，因此“消息原文交接”范围不完整（`reports/BASELINE.md` BLOCK-05）。`reports/D05.md` 已补写并如实记录 D05 没有独立实现提交、实现首次入库于 `3b6afad`、原实现者无法还原；独立验证已在 `76cf3b3` 上复跑并复核该缺口。仓库没有消息撤回，T03 用授权人失去源范围成员资格表达源撤回。
- **D06**：外链只记录声明，服务端不抓取或验证；提交列表没有游标；未指定验收人的任务无法退回；没有 D06 专用浏览器断言（`test:web` 只覆盖页面不回归）。
- **D07**：验收人退群/停用不会自动通过或自动改派；`related_task_id` 已在 MCP 支持但未在网页表单暴露；没有外部业务回写通道。
- **D08**：没有公开的 `failed` 入口，`network_task_retry` 的 T02 用例在真实迁移/domain 层构造 `failed` 持久行后验证；外部停止只是尽力通知宿主并记录操作者声明的 `external_stop_status`，没有实际杀进程或撤销远端操作的适配器；外部系统查询由调用方完成，`execution_resolve` 只持久化查询或人工证据，不自动访问目标系统；有负责人的 `blocked` 任务也会收到催办，`execution_unknown` 只提示对账、不自动改状态；T04 在验收进程内自托管临时 Bun/`DATA_DIR` 重启，不重启生产实例；D08 网页入口只由协议静态断言与既有网页回归（本轮 `test:web` 2012 项）覆盖，没有新增独立 Playwright 交互脚本。
- **Q02**：真实相机扫码未自动化，`test:web` 在 `/pair` 直接带入 `#c=`，未调用摄像头或扫码 API，二维码仍由 `src/web/qr.ts` 现场生成，真实手机链路需人工验证。挑战先到先绑：第三台设备若先 `join`，批准界面会显示其设备信息，必须由已登录设备核对确认码后人工拒绝；服务端没有额外设备公钥/近场证明，不会自动信任先到者。旧 `/#t=` 与 `network_recovery_*` 长期 token 未删除、不会自动过期，只保留为明确标注的“旧方式（长期凭据）”，泄露后需由已登录设备撤销对应设备。`network_device_rename` 未实现，设备 label 来自创建/配对时的客户端输入。单设备撤销只关闭本进程内的 stream；多实例部署需要部署层广播或重连收敛，数据库撤销保证新请求立即失败。
- **G06**：T04 媒体终止是依赖缺口，M09 通话模块未实现，只提供 `media_revoke` 事件钩子，不能声称已验证媒体发布/订阅终止。并发只跑 10 轮 `Promise.allSettled`（本轮实际只观察到 remove_won），另用两种确定性提交顺序补测，未跑 100 次固定种子调度。`POST /mcp-upload` 仍可创建上传者私有草稿；解散后房间绑定/发布/删除被拒绝，网页隐藏上传入口。已下载到本地或被外部系统读取的文件副本无法技术回收；旧文件票据对仍 active 的合法成员继续有效，成员退出/被移除后立即 404。归档读取以 `archived_head_seq` 截断消息/事件/文件/任务，部分只读元数据仍可能可查，但接受/批准等写操作被拒绝。
- **A06**：交接不自动把新管理者加入原管理者的私聊或 Agent 所在群，也不继承仓库/Issue/API key 等外部平台授权；新管理者要重派群内任务，需先由群 owner/admin 加入房间并获得派发权限。未接受的 `offered` 任务回 `unassigned` 而非 `blocked`，以兼容 D04“未接受 offer 不冒充执行中”；若要求全部未结束任务一律 blocked，需要与 D04 一起调整。交接撤销凭据与 assignment，但不声称旧执行进程已停止；外部副作用仍按 D08 的 unknown/对账处理。并发只跑 6 轮接受 × 旧管理者重发，未跑 100 次固定种子竞争。没有外部发布系统可联调（Q03 依赖），未复制任何外部绑定。审计中的撤销委托/凭据计数是事务前快照；`agent_transfer_*` 审计别名双写；Web 新 token 只写接受方本机注册表，清除站点数据后需重新配置。
- **过程**：D04–D07 集成开工时工作区已含未提交的 D05 实现，与“工作区不干净立即停止”的指令不符；该轮就地集成，未清理或回退任何已有改动。两个集成回归修复只调整测试断言，未降低服务端语义。D04–D08 集成在 `3710904` 上开工，`git status --porcelain=v1 -b` 为空（仅 `ahead 2`）。Q02/G06/A06 集成在 `a613c96` 上开工，工作区干净、`ahead 7`，结束时仍干净；本轮无集成回归、无业务代码或断言改动。
- **文档**：Q01 仍负责 README / CLAUDE / 技能正文与全部文档的全量对齐；`README.md` / `docs/code-index.md` 尚未对齐本轮协议 991 项与 129 个工具，D05/D08/Q02/G06/A06 的条目也可能不完整；本报告是当前权威计数，Q02/G06/A06 的技能正文与静态 `/skills/agent-network-skills.md` 已随各自实现同步。

仍未实现的 P0：

- **Q 组**：Q01、Q04、Q05。
- A06、G06、Q02 已实现并纳入集成，已在 `933992f` 独立验证签收为 `VERIFIED`，不再计入未实现 P0。

依赖与阻塞：

- **Q01/Q04/Q05 只能按 P0 范围验收**：A02、A04、G04、M01、M04、M05、M06、M08、M09、Q03、Q06 仍未实现（P1），依赖这些能力的 P1 验收范围不能作为 P0 门禁的一部分。Q01 的文档全量对齐、Q04 的并发/故障范围与 Q05 的设备/部署范围都以此为边界。
- **D05 的 M04 缺口未关闭**：M04 只提供 `reply_to` 字段，没有原文定位/引用预览/quote anchor；D05 已如实把消息引用限制为 `message_id` + 当前可见消息的截断预览，不能宣称“相关消息上下文完整”。纳入 M04 或缩小 D05 消息范围需要主控决定。
- **D08 已实现并纳入集成**：催办、取消与异常恢复有迁移 `0035`、3 个工具、事件与专项 147 项；外部执行停止与目标系统查询仍是调用方责任，不是服务端保证。
- **A05-T01 已解除阻塞**：A05 报告为 `PASS`；任务拒绝提议、拉黑闸门与解除拉黑后的派发已有验收。
- **Q02/G06/A06 的缺口属于 P1/部署边界**：真实相机扫码、M09 媒体终止、第三方先 join 的人工拒绝、多实例撤销广播、外部发布联调、遗留无主群人工修复与更高轮次并发补测均未在本轮完成；这些已写入 `reports/VERIFICATION-Q02-G06-A06.md` 的残余限制，不改变 `VERIFIED` 签收，但不得把未验证能力当作已验证。
- **文档计数**：`README.md` / `docs/code-index.md` 尚未对齐本轮权威计数（protocol 991、工具 129），由 Q01 负责全量对齐；本报告是当前权威计数。

## 16. 最终状态

- 上一轮审查起点：`f8d520b7852802fa649435f593b78fb53926f309`（`docs(delivery): D07 任务报告`）；上一轮最终集成：`76cf3b3`（D08 报告为 `3710904`）。
- 本轮审查起点 / 最终集成起点：`a613c96e2a3204de4bb270fad8c0154e75594129`（`docs(identity): 校正 A06 报告行数`），开工时工作区干净、`ahead 7`。
- D1 修复实现/报告：`0cf6a411b353b26385ab66bd55f7eec142a8972f`（`fix(groups): 禁止 owner 无主退群`）/ `933992fe6f628b13899c4b48bf987d525042f75a`（`docs(groups): 记录 G06 owner 无主退群修复与复验`）。
- 最终独立验证 SHA：`933992fe6f628b13899c4b48bf987d525042f75a`；报告 `reports/VERIFICATION-Q02-G06-A06.md`，结论 PASS。
- Q01/Q04/Q05 最终独立验证 SHA：`0030c7974bd04e6f85f16976b86100f344d26531`；报告 `reports/VERIFICATION-Q01-Q04-Q05.md`，结论 PASS。
- Q02 实现/报告：`93263f607b83ca8ffe99bf32dd4ef4bfc8464fc1` / `328f0a8700229b06d9839f1d699ff9ddb27b8ace`。
- G06 实现/报告：`22b23bbaeed0d7b57c52ec24dc0c9bdc1c80abc5` / `ea971d0a6de90c4688cc3abf990d97f1e24766c9`。
- A06 实现/报告：`03240797da343ad832bcd48afaad66e52a7dbbcd` / `0d3d712d0fc167a2b32a736060b50ea183b4967f`（另有 `a613c96` 行数校正）。
- D04 实现/报告：`56d9c9f51ba4c805223745b6bb4d7f3dc594cf5f` / `b6d27f4d5b6e19ba129451dd05ade7e532a89957`。
- D05：实现首次入库于集成提交 `3b6afadd9d53125084b1615b0972f792e25321a0`（无独立实现提交）；报告 `reports/D05.md`，提交 `11d0adb`（`docs(delivery): D05 任务报告`）。
- D06 实现/报告：`4eb8de8db803b5b7ad349c189345b6f784d1fd8f` / `b696df53b3779460c2448bb7030f5608d4ea9cd8`。
- D07 实现/报告：`049ce2034d8abec06062f8506d9d260d8c1354b1` / `f8d520b7852802fa649435f593b78fb53926f309`。
- D08 实现/报告：`40b001fc571678595e7f1a039837dbbe49cdf41b` / `3710904`。
- 历史集成提交：`3b6afadd9d53125084b1615b0972f792e25321a0`（D05 实现、D04–D08 两个集成回归修复与本报告初版）、`76cf3b353ab3bde24eb7c58dad2a696fe6293332`（D04–D08 最终集成报告）。
- 本轮集成报告提交：本文件所在提交（见 `git log -1 -- reports/INTEGRATION.md`）；无业务代码、迁移或测试断言改动。
- 工具总数：129 个（Drive 与房间文件开启）/ 120 个（关闭）；任务工具 32 个。
- 测试计数：typecheck 通过、protocol 991、acceptance 2615、web 2012、events 339、drive 52；专项 Q02 pairing 77、Q02 sync 45、G06 119（含 G06-T05）、G03 104、G01 65、G05 67、A06 139。D04–D08 专项计数沿用独立验证的 565（128/83/133/74/147），本轮未重复跑五项专项，全量验收已覆盖回归。
- Q01/Q04/Q05 最终签收计数（`0030c79`）：typecheck 通过、q01-doc-check 48、q01-upgrade-check 24、Q04 176、Q05 906 轮 / 24,538 断言 / 0 失败、自动 @ 73、protocol 991、acceptance 2688、web 2015、events 339、drive 52；迁移 34、`integrity_check=ok`、`foreign_key_check` 0 行。
- 迁移：34 个文件（`0001`–`0012`、`0017`–`0038`）；新库启动全部应用，`PRAGMA integrity_check` = `ok`，`foreign_key_check` 0 行；`guard_owner_missing` 只接受 `x = 0`。
- 独立验证报告：`reports/VERIFICATION-D04-D08.md`（验证 SHA `76cf3b353ab3bde24eb7c58dad2a696fe6293332`）、`reports/VERIFICATION-Q02-G06-A06.md`（验证 SHA `933992fe6f628b13899c4b48bf987d525042f75a`）与 `reports/VERIFICATION-Q01-Q04-Q05.md`（验证 SHA `0030c7974bd04e6f85f16976b86100f344d26531`）。
- 集成报告在 `fix/webots-parity-pack` 上普通 push，无 force；推送后远端分支与本地 HEAD 一致。
- 未部署、未创建 PR、未触发生产验收、未创建生产测试数据；D1 复验使用端口 `18994`，测试服务已全部停止，端口已释放。
- 状态：Q01、Q04、Q05、AUTO-MENTION、Q02、G06、A06、D04–D08 为 `VERIFIED`；D01–D03 为 `READY_FOR_REVIEW`；A05 为 `PASS`；剩余未实现 P0 无。
