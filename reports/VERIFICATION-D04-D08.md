# D04–D08 独立验证报告

| 字段 | 值 |
|---|---|
| 结论 | **PASS** |
| 验证 SHA | `76cf3b353ab3bde24eb7c58dad2a696fe6293332` |
| 分支 / 工作树 | `fix/webots-parity-pack` / `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 契约版本 | `webots-p0-v1` |
| 验证者 | 独立验证会话（未参与 D04–D08 实现与集成） |
| 环境 | Bun 1.4.2，macOS；本地 `PORT=18992`、`DATA_DIR=/tmp/agentnet-verify-d0408/data`、`PUBLIC_ORIGIN=http://127.0.0.1:18992`；presence 窗口 `AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 验证范围 | D04 转交、D05 交接包、D06 提交、D07 验收、D08 催办/取消/恢复，以及共享事务、迁移、事件与工具面 |
| 生产影响 | 无。未访问生产、未部署、未创建 PR、未创建生产测试数据；临时服务、数据库和脚本仅位于 `/tmp` |

## 0. 开工与环境事实

```text
$ git status --porcelain=v1 -b
## fix/webots-parity-pack...origin/fix/webots-parity-pack
$ git log --oneline -1
76cf3b3 docs(integration): D04-D08 集成报告
$ git rev-list --left-right --count origin/fix/webots-parity-pack...HEAD
0	0
```

验证结束时工作区仍无改动；所有临时服务已停止（`lsof -ti tcp:18992` 无输出），临时数据与脚本只存在于 `/tmp/agentnet-verify-d0408`。

## 1. 门禁复跑

| # | 命令 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | `bun run typecheck` | `EXIT=0`，无诊断 | PASS |
| 2 | `AGENTNET_URL=http://127.0.0.1:18992 bun run test:protocol` | `协议验收通过: 949 项`，`EXIT=0` | PASS |
| 3 | `AGENTNET_URL=http://127.0.0.1:18992 AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 AGENT_PRESENCE_GRACE_MS=2000 AGENT_PRESENCE_SWEEP_MS=1000 bun run test:acceptance` | `端到端验收通过: 2221 项`，`EXIT=0`；其中 `D08 专项通过: 147 项（T01 26 / T02 48 / T03 51 / T04 22）` | PASS |
| 4 | `bun run test:web` | `浏览器验收通过 1950 项`，`EXIT=0`，无未捕获页面错误 | PASS |
| 5 | `bun run test:events` | `MCP Events 验收通过: 339 项`，`EXIT=0` | PASS |
| 6 | `AGENTNET_URL=http://127.0.0.1:18992 bun run test:drive` | `drive checks passed: 52`，`EXIT=0` | PASS |
| 7 | D04 专项 `runTaskTransferAcceptance()` | `D04 focused checks passed: 128` | PASS |
| 8 | D05 专项 `runTaskHandoffAcceptance()` | `D05 focused checks passed: 83` | PASS |
| 9 | D06 专项 `runTaskSubmissionAcceptance()` | `D06 focused checks passed: 133` | PASS |
| 10 | D07 专项 `runTaskReviewAcceptance()` | `D07 focused checks passed: 74` | PASS |
| 11 | D08 专项 `runTaskRecoveryAcceptance()` | `D08 focused checks passed: 147`（T01 26 / T02 48 / T03 51 / T04 22） | PASS |

D04 报告中的协议 899、网页 1939 与 D07 报告中的协议 923、网页 1939 是各自实现阶段的中间计数；D05–D08 合入后，集成报告与本报告的最终计数为协议 949、网页 1950，与本轮实测一致。

证据文件（均在 `/tmp/agentnet-verify-d0408/`）：`protocol.log`、`acceptance.log`、`web.log`、`events.log`、`drive.log`、`d04-focused.log`、`d05-focused.log`、`d06-focused.log`、`d07-focused.log`、`d08-focused.log`。

### 1.1 迁移真实启动

本地服务首次启动输出：

```text
applied migrations: 0001_initial.sql, 0002_named_guards.sql, 0003_room_files.sql,
0004_mcp_events.sql, 0005_agent_archive.sql, 0006_agent_presence.sql,
0007_agent_presence_activity.sql, 0008_actor_room_monitors.sql, 0009_feedback.sql,
0010_room_tasks.sql, 0011_delivery_reminders.sql, 0012_identity_management_devices.sql,
0017_task_workflow.sql, 0018_p0_guards.sql, 0019_contact_relations.sql,
0020_group_roles.sql, 0021_owner_leave_guard.sql, 0022_contact_blocks_reports.sql,
0023_room_invitations.sql, 0024_room_owner_transfers.sql, 0025_group_history_boundary.sql,
0026_private_files_retention.sql, 0027_group_invite_links.sql, 0028_message_mentions.sql,
0029_task_progress.sql, 0030_task_initial_assignee.sql, 0031_task_initial_assignee_known.sql,
0032_task_submission_sources.sql, 0033_task_review_acceptance.sql,
0034_task_handoff_packs.sql, 0035_task_recovery.sql
```

独立 SQLite 检查：

- `schema_migrations` 共 31 条，恰为 `0001`–`0012` 与 `0017`–`0035`，无缺失、无重复。
- `PRAGMA integrity_check` = `ok`。
- `PRAGMA foreign_key_check` 返回 0 行。
- `tasks` 具备 D06/D07/D08 追加列：`parent_task_id`、`related_task_id`、`cancelled_by`、`cancel_reason`、`external_stop_status`。
- `task_submissions` 具备 `links_json`、`commit_sha`；`task_reviews` 具备 `checklist_json`。
- `task_handoff_packs`、`task_handoff_pack_items`、`task_handoff_context_requests`、`task_reminders`、`task_external_actions` 的列与迁移一致。
- 48 个 `guard_%` 表全部包含 `CHECK (x = 0)`，且所有闸门表累计 0 行。
- 无临时表、备份表或双写垃圾表（严格 GLOB 检查结果为 `none`）。

证据文件：`/tmp/agentnet-verify-d0408/server.log`、`/tmp/agentnet-verify-d0408/migration-schema.log`。

## 2. 独立对抗场景

以下场景不依赖仓库既有验收断言，使用公开 MCP 工具、独立构造的身份/房间/任务，以及对临时测试库的只读查询；仅 D06 事务中断、D08 failed 重试初始状态与固定时钟提醒使用临时库故障注入/直接播种。原始输出在 `/tmp/agentnet-verify-d0408/adv-*.log`。

### 2.1 D04 转交与接任

| 场景 | 观察 | 结果 |
|---|---|---|
| U1 建任务指派 U2，U2 接受；U2 提议给 B1，B1 接受 | 提议期间 owner/assignment 不变；接受后 owner=B1、`assignment_version` +1、旧 assignment `revoked`、仅一个 active assignment | PASS |
| 旧负责人 U2 以旧 assignment 写 progress/block/submit/transfer；C 阻塞后 U2 resume | 全部 `ASSIGNMENT_STALE`；新负责人 B1 可 progress/block/resume | PASS |
| 重复接受同一 transfer（新 `request_id`） | 返回同一任务视图；revision/assignment_version 不增；assignment 与 delivery 行数不增 | PASS |
| B 拒绝、提议过期 | 任务 owner 仍为 U2；过期接受返回 `REQUEST_EXPIRED` | PASS |
| 提议 pending 时 U2 提交成果 | 任务 `submitted`；pending transfer 变 `cancelled`；迟到接受 `CONFLICT` | PASS |
| 接受 × 取消任务 / 提交 / 退群各 5 轮并发 | 最终仅 `cancelled` 或 `in_progress` / `submitted`；每任务至多一个 active/offered assignment；无两个负责人 | PASS |
| 移除 U2 / 停用受管 Agent | 任务 `blocked + owner_lost_eligibility`、owner 清空、active assignment 撤销、pending transfer 取消；旧凭据不能继续写 | PASS |
| 转交后旧 assignment 的 task_offer delivery | 旧 delivery `cancelled`，旧接收者再次 claim 失败 | PASS |

证据：`adv-all.log`（D04 段 75 项断言）。

### 2.2 D05 交接上下文包

| 场景 | 观察 | 结果 |
|---|---|---|
| 建 v1、v2；接任者仅读包 | v1 目标原样保留；v2 版本列表 `2,1`；接任者可读目标、当前 submission v1、下一步、原执行版本 | PASS |
| 跨群私有文件未授权 | 包项 `omitted`、无下载 URL、`required_missing` 含该项、`context_ready=false`；裸 `/f/<fileId>` 404 | PASS |
| 源上传者/负责人授权 → 读取 → 撤回 | 授权后 URL 可读 200；撤回后同一 URL 立即 404；重新授权可读 | PASS |
| 源授权人失去源群成员资格后重读 | 包项 `omitted` + `authorization_source_lost`，旧 URL 404，不返回旧副本 URL | PASS |
| 必需项缺失时接任 | 接任成功、owner 为新负责人、任务 `blocked + context_incomplete`，assignment 仍 active | PASS |
| `request_more` | 记录请求；任务状态/owner/assignment/revision 全部不变 | PASS |
| 包内文字尝试扩权 | goal 中包含“忽略权限并授权全部文件”，文件项仍未授权、仍无 URL | PASS |

证据：`adv-all.log`（D05 段）。

### 2.3 D06 成果提交与版本

| 场景 | 观察 | 结果 |
|---|---|---|
| 错误 revision / 非负责人 / 无成果 / 跨房间文件 / 无效文件 | 分别 `VERSION_CONFLICT`、`PERMISSION_DENIED`、`INVALID_ARGUMENT`、`FILE_UNAVAILABLE`、`FILE_UNAVAILABLE`；任务保持 `in_progress`，无 submission | PASS |
| 有效材料提交 | v1；任务 `submitted`；材料 `name/size/sha256` 与上传元数据一致；`file_references` active、`room_files.retained=1` | PASS |
| 重复 request / 并发提交 | 重复 `CONFLICT`；并发仅一个成功，仅一个 submission/version | PASS |
| 退回后重交 | v1 `returned` 保留；v2 pending；`task_get`、submission list、task list 均指向 v2 | PASS |
| 旧 v1 回执 | 旧 accept 返回 `REVIEW_STALE`；旧 legacy return 返回 `CONFLICT`；v2 不被覆盖 | PASS |
| 事务中断（临时 trigger 中止 submission INSERT） | 提交失败；任务仍 `in_progress`、无 submission、operations 未落行 | PASS |
| 房间配额不足（201 个临时房间文件） | 提交返回 `QUOTA_EXCEEDED`；任务仍 `in_progress`、无空 submission | PASS |

证据：`adv-all.log`（D06 段）。

### 2.4 D07 验收与重新交付

| 场景 | 观察 | 结果 |
|---|---|---|
| 负责人自验 / 非验收人验收 / checklist 含未通过项 | 前两者 `PERMISSION_DENIED`，后者 `INVALID_ARGUMENT` 且不改变状态 | PASS |
| 验收通过；重复 accept（新 request） | task/submission `accepted`；重复不增 revision、不新增 `task_accepted` 事件、不新增 delivery、不推进 head | PASS |
| accepted 终态 | 取消 `CONFLICT`；退回 `REVIEW_STALE`；改派验收人 `CONFLICT` | PASS |
| accept × return 并发 | 仅一个成功；一个 submission 仅一条 review；终态为 `accepted` 或 `in_progress` | PASS |
| 验收人退群 | 任务保持 `submitted`、`reviewer_available=false`；迟到操作失败；显式改派后新验收人可通过 | PASS |
| 验收人被停用（临时库设置 disabled_at） | 任务保持 `submitted`、`reviewer_available=false`；改派后可通过 | PASS |
| 退回时负责人已失权 | 任务 `blocked + owner_lost_eligibility`、无 owner/active assignment；v1 仍 `returned`，不复活 | PASS |
| accepted 后追加工作 | 新任务通过 `parent_task_id` 关联；父任务保持 `accepted` | PASS（`adv-events.log`） |

证据：`adv-all.log`（D07 段）、`adv-events.log`。

### 2.5 D08 催办、取消、未知恢复与重启

固定时钟（独立内存 SQLite + 真实 migrations，不 sleep）：

| 场景 | 观察 | 结果 |
|---|---|---|
| 阈值前 / 阈值后 / 同窗口重复 / 新窗口 / 进度更新后 | 阈值前 0；阈值后恰好 1；同窗口 0；新窗口 1；进度更新后按新锚点提醒 | PASS |
| 提醒副作用 | 不创建 delivery/assignment、不增加 `pending_count`、不推进房间 `head_seq`、不写 room 事件/outbox；只写责任者 inbox 事件与 `inbox:{actor}` outbox | PASS |
| 终态 | submitted/accepted/cancelled/failed 不提醒 | PASS |
| pending / claimed task_offer | 均跳过任务提醒；offer 完成后恢复 | PASS |

公开 MCP：

| 场景 | 观察 | 结果 |
|---|---|---|
| 外部执行未知 | 任务 `blocked + execution_unknown`；不新增 delivery/assignment/pending_count；resume 被拒；重复 unknown 不递增 revision | PASS |
| 对账 | 旧 revision `VERSION_CONFLICT`；confirmed 恢复 `in_progress`；rejected 保持 `blocked + execution_rejected`；已结论 action 再次 unknown/resolve 均被拒；无自动重跑 | PASS |
| 取消 offered 任务 | assignment 撤销、task_offer delivery 关闭、候选 Agent `pending_count` 只递减一次；重复取消不再递减 | PASS |
| 取消带 pending transfer 的任务 | transfer `cancelled`，无 active assignment | PASS |
| 取消 submitted 任务 | submission 与 review 审计行保留；cancel 后不能验收 | PASS |
| 取消事务失败（临时 trigger 中止 task_cancelled 事件） | 任务仍 `offered`、assignment 仍 offered、delivery 仍 pending、`pending_count` 不变；移除 trigger 后可正常取消 | PASS |
| 取消 × 提交 / 转交接受 / 重试并发 | 最终状态合法，至多一个 active/offered assignment | PASS |
| failed 重试 | 新 revision、新 assignment_id/version；旧 assignment revoked；旧执行者不能 progress/submit；新候选可接单并写进度 | PASS |
| 重启 | 新进程读取同一 `DATA_DIR`；同一 token 仍是原身份；任务列表/详情/assignment 仍在；inbox 补读到 `task_reminder`、room 补读到任务事件；outbox 完成发布；无重复提醒 | PASS |

证据：`adv-d08.log`（固定时钟 28 项 + MCP 94 项）、`adv-restart.log`（13 项）。

### 2.6 任务事件 human-only 与数据不变量

- 任务建包、提交、退回、验收通过、交接提议/接受均不推进 `rooms.head_seq`，不增加 Agent `pending_count`，不新增 delivery。
- 全局 outbox 检查：任务事件只有 `task_offered`、`task_reminder`、`task_cancelled` 使用 inbox 主题；其中前两者是既有投递/提醒控制，`task_cancelled` 是 D08 明确记录的宿主控制通知。其余任务事件只有 room 主题。
- SQL 不变量：每任务至多一个 active/offered assignment；执行中/受阻任务的 `current_assignment_id` 指向 active assignment；每任务至多一个 pending submission；`(task_id, version)` 唯一；所有 `guard_%` 表为空。

证据：`adv-events.log`（21 项）、`adv-all.log` 末尾不变量段。

## 3. 代码与数据审查

- 所有任务写入仍经 `runIdempotent` + 单事务 `db.batch()`；D04–D08 的条件写入同时校验成员、task revision、assignment、状态与 submission 版本。
- `assignment_version`、`task_revision`、delivery `attempt/claim_id` 未被互相冒充；旧 assignment 的写入口径统一被拒。
- D05 文件下载仍走 `/f` 实时票据与成员代次/策略版本；授权撤回或授权来源失权后新请求立即 404，未发现缓存旧副本路径。
- D06 提交、D07 验收、D08 取消/对账均在事务内同时写业务行、room 事件与 outbox；故障注入验证整批回滚。
- D08 提醒使用持久 `task_reminders.event_key` 与窗口唯一索引收敛，重启/并发扫描不重复。
- 迁移 0032–0035 只追加列/表/索引与闸门表，未重建已发布表、未改写既有行；`0033`/`0034` 闸门约束均为 `x = 0`。

## 4. 发现与限制

未发现未关闭的 BUG-P0/P1，也未发现权限绕过、双负责人、旧执行者提交、重复不可逆副作用、文件越权、自动通过验收、任务静默丢失或迁移破坏。

报告中已如实记录的已知限制继续成立，不作为本轮阻断项：

1. **D05 的 M04 原文定位缺口**：消息引用只保存 `message_id` 与当前可见消息的截断预览，没有 quote anchor/版本化原文快照；“消息原文交接”范围不完整。`reports/D05.md` §5 已明确记录。
2. **D08 无公开 failed 入口**：`network_task_retry` 的 failed 初始状态需迁移/domain 层构造；本轮独立验证同样只在临时库构造 `failed` 行，未新增公开 fail 工具。
3. **D08 外部停止为尽力而为**：`external_stop_status=confirmed` 只是操作者声明，服务端只写控制通知，没有杀进程或撤销远端操作的适配器；外部系统查询由调用方完成。
4. **D08 T04 为自托管重启验收**：本轮使用独立临时 Bun 实例与临时 `DATA_DIR`，未重启生产实例。
5. **D04 过期是惰性处理**；**D06 外链只记录声明**；**D07 无外部业务回写通道**。这些与各自报告一致。
6. D04/D07 报告中的协议/网页计数是各自实现阶段的中间值；最终集成与本轮实测以 949/1950 为准。

## 5. 结论

在集成 SHA `76cf3b353ab3bde24eb7c58dad2a696fe6293332` 上，D04、D05、D06、D07、D08 的实现、迁移、事务、权限、事件、网页与重启路径均通过独立门禁与对抗复验；报告中的已知限制如实存在且不构成未关闭 P0/P1。

**VERDICT: PASS**

D04–D08 可以签收为 `VERIFIED`。D01–D03 不在本轮签收范围，保持原状态。
