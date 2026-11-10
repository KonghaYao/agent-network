# 消息式 Task / Trace（阶段 4b-2 收口）

- 分支：`feat/message-task-trace`
- 范围：阶段 1–3 的消息式 Task / Trace、阶段 4a/4b-1 的旧任务硬切，以及本阶段的破坏性迁移与残余引用清理。
- 结论：新模型只依赖 `messages` 上的标记列；旧任务表、旧任务列与旧任务文件授权已删除；全量门禁与迁移演练结果见下文。

## 设计要点

Task 不是独立实体。被标记消息自身就是起点：`task_root_id = message_id`。处理消息在发送时显式传 `task_root_id`，省略时从父消息继承；普通线程仍只由 `root_id` 表达。

集合由三部分组成，按 `message_id` 去重：

1. 起点消息（`task_root_id = root_message_id`）；
2. 显式归属该起点的处理消息；
3. 处理消息通过 `reply_to` 指向的一层来源消息。

标记/取消只写 room scope 的 `message_task_marked` / `message_task_unmarked` 事件与 `room:<id>` outbox，映射为 `source = "task.updated"`、`kind = "task"`、informational；只扇出给 active human，不写 inbox、不增加 `pending_count`、不推进 `head_seq`、不唤醒 Agent。三个读取工具不写 events/outbox/operations。

所有读写都重新应用当前 `historyBoundary` 与成员代次；非成员、晚到成员、边界外或不存在的目标统一失败，不泄露正文或数量。

## 5 个工具

| 工具 | 语义 | 幂等/只读 |
| --- | --- | --- |
| `network_task_mark` | 把当前可见、未撤回的任意发送者消息标记为起点；已归属另一个仍标记中的 Task 返回 `CONFLICT` | `runIdempotent`，重复标记幂等 |
| `network_task_unmark` | 只清空起点三列，保留原消息、处理消息与引用关系；重新标记后集合恢复；任何可发言成员都可取消 | `runIdempotent`，重复取消幂等 |
| `network_task_summaries` | 一次最多 20 个根，返回预览、起点发送者、参与 Agent 去重顺序、消息数与 `can_unmark` | 只读 |
| `network_task_trace` | 按原消息顺序双向分页，返回起点、处理消息与一层引用来源；`focus_message_id` 从搜索命中处定位；正文用 `network_message_read` | 只读 |
| `network_task_search` | 按起点聚合搜索；`matches` 最多 3 条，可直接作为 Trace 的 focus；同一来源被多个 Task 引用时分别返回；扫描上限返回 `truncated` | 只读 |

## 迁移

### `0041_message_task_trace.sql`

- `messages` 增加 `task_root_id`、`task_marked_by`、`task_marked_at`；旧行保持 `NULL`，无需回填。
- 新增部分索引 `idx_messages_task_root` 与 `idx_messages_room_reply_to`。
- 新增标记闸门 `guard_task_mark_unavailable`、`guard_task_mark_conflict`。

### `0042_drop_legacy_tasks.sql`

删除的旧任务表（15 张，全部 `DROP TABLE IF EXISTS`）：

- 看板：`room_tasks`
- 工作流：`tasks`、`task_assignments`、`task_transfers`、`task_submissions`、`task_reviews`、`task_deliveries`、`task_cards`、`task_attachments`
- 进度/恢复：`task_progress`、`task_reminders`、`task_external_actions`
- 交接：`task_handoff_packs`、`task_handoff_pack_items`、`task_handoff_context_requests`

删除的旧任务闸门（7 张）：`guard_room_task_limit`、`guard_task_conflict`、`guard_task_editor`、`guard_task_state`、`guard_assignment_stale`、`guard_review_stale`、`guard_handoff_conflict`。新模型的 `guard_task_mark_unavailable` / `guard_task_mark_conflict` 保留。

删除的列与引用：

- `artifacts.task_id` 及索引 `idx_artifacts_task`、`idx_artifacts_task_version`
- `rooms.member_task_policy`
- `file_references` 中 `kind = 'task'` 的行（旧任务/交接文件授权）

保留：`messages` 的标记三列与两个索引、普通消息/房间/成员/文件/成果/事件/outbox/deliveries。

SQLite 说明：`DROP TABLE IF EXISTS` / `DROP INDEX IF EXISTS` 可重放；SQLite 3.35+ 支持 `DROP COLUMN`，但不支持 `DROP COLUMN IF EXISTS`。迁移由 `schema_migrations` 保证只应用一次，手工重放列删除会因列不存在而失败；没有使用 `writable_schema` 等非事务手段绕过。迁移不删除历史 `events` / `outbox` 行，也不在事务内清理文件载荷。

## 迁移演练

使用真实 `migrations/` 与临时 SQLite，不连接生产。

### 全新库

- 依次应用 38 个迁移（0001–0012、0017–0042）。
- `PRAGMA integrity_check` = `ok`；`PRAGMA foreign_key_check` 为空。
- 15 张旧任务表与 7 张旧闸门均不存在；`guard_task_mark_*` 存在。
- `artifacts` 无 `task_id`，`rooms` 无 `member_task_policy`；`messages` 三个标记列与 `idx_messages_task_root` / `idx_messages_room_reply_to` 保留。

### 0041 基线升级

在停在 `0041` 的临时库写入普通数据和旧任务数据（15 张旧表各 1 行），再应用 `0042`：

| 数据 | 升级前 | 升级后 |
| --- | ---: | ---: |
| `actors` | 3 | 3 |
| `rooms` | 1 | 1 |
| `room_members` | 2 | 2 |
| `messages` | 2 | 2 |
| `drive_files` | 1 | 1 |
| `room_files` | 1 | 1 |
| `artifacts` | 1 | 1 |
| `events` / `outbox` / `deliveries` | 1 / 1 / 1 | 1 / 1 / 1 |
| `file_references` | 2（1 条 task、1 条 artifact） | 1（artifact 保留，task 删除） |

- 15 张旧任务表与 7 张旧闸门全部消失；旧任务行随表删除。
- 标记消息（`task_root_id = msg_root`）与两个索引保留。
- `PRAGMA integrity_check` = `ok`；`PRAGMA foreign_key_check` 为空。
- 重复执行 `DROP TABLE IF EXISTS` / `DROP INDEX IF EXISTS` 安全，完整性仍为 `ok`。
- 演练共 88 项断言通过。

## 14 个设计场景与自动化证据

服务端证据来自 `test:acceptance` 的“消息式 Task / Trace（阶段 2）”段；浏览器证据来自 `test:web` 的“消息式 Task 摘要与 Trace”段；单元不变量来自 `scripts/verify-message-tasks.ts`。

| # | 场景 | 证据 |
| --- | --- | --- |
| 1 | 人类请求，Agent 确认并标记；摘要、Trace、未读不推进 | `S1` 12 项；web“起点摘要显示预览与消息数”“标记后摘要行立即出现”；`verify-message-tasks` 标记/取消不变量 |
| 2 | Agent 消息本身可作起点，起点 Agent 计入参与者 | `S2` 5 项；web“Agent 消息也能成为 Task 起点” |
| 3 | 浏览/搜索/普通消息不会自动创建 Task | `S3` 3 项；web“普通消息初始没有摘要行”“普通搜索不渲染 Task 摘要” |
| 4 | 两个 Agent 同时接取，收敛到同一 Task | `S4` 3 项 |
| 5 | 参与者去重、头像顺序、消息逐条计数 | `S5` 2 项 + `S4` 参与者顺序；web 参与者顺序与 `+N` 折叠 |
| 6 | 只 @ 或被引用的旧消息不增加参与者、不唤醒对方 | `S6` 5 项 |
| 7 | 起点 1 + 处理 2 + 来源 2 = 5，重复引用不重复计数 | `S7` 3 项 |
| 8 | 群内交错两项工作各自归组，闲聊不收录 | `S8` 3 项 |
| 9 | Task A 引用 Task B 结果不移动/不合并；共享来源分别展示 | `S9` 12 项 |
| 10 | 搜索只命中处理消息时返回对应摘要并可定位 | `S10` 3 项；web“Task 搜索命中处理消息可直接定位” |
| 11 | 同一 Task 多命中按起点去重，`matches` 最多 3 条，来源可命中 | `S11` 7 项；web“同一 Task 多条命中只显示一个摘要” |
| 12 | 长 Trace 双向分页、焦点定位、滚动与草稿保留 | 服务端 Trace 分页/focus 12 项；web 53 条长 Trace、首页 50 条、focus 第 40 条、收起后草稿与聊天位置保留 |
| 13 | 权限边界、晚到成员、撤回来源 tombstone | `S13` 4 项 + 非成员/晚到成员 5 项；web 非成员无法打开、撤回消息保留定位但无正文 |
| 14 | 取消标记、重复标记、重试幂等、撤回处理消息 | `S14` 8 项；web 取消/冲突/其他成员取消；`verify-message-tasks` 129 项覆盖事件与游标不变量 |

## 门禁结果

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun scripts/verify-isolated.ts protocol` | 通过，805 项 |
| `AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 AGENT_PRESENCE_GRACE_MS=2000 AGENT_PRESENCE_SWEEP_MS=1000 bun run test:acceptance`（临时自托管实例） | 通过，1836 项 |
| `bun run test:web` | 通过，2274 项 |
| `bun run test:ux` | 通过，8 个套件全部通过（mobile-fixes 9/9 PASS，0 BUG / 0 UX_GAP / 0 BLOCKED） |
| `bun run test:client-contract` | 通过，69 项 |
| `bun scripts/verify-message-tasks.ts` | 通过，129 项 |
| `bun scripts/q01-doc-check.ts`（临时自托管实例） | 通过，34 项 |
| `bun scripts/q01-upgrade-check.ts` | 通过，40 项 |
| `git diff --check` | 无输出 |

## 已知限制

- **单 `reply_to`**：一条处理消息只能直接引用一个来源；需要多个来源时发送多条消息。Trace 只展开一层引用，不做传递闭包。
- **Trace 回退**：点击 Trace 消息时若目标不在已加载聊天历史中，网页打开 `network_message_context` 上下文弹窗，而不是静默跳转。
- **历史旧事件**：`0042` 不删除历史 `events` / `outbox`。若升级时仍有未 drain 的旧 `task_*` / `room_task_*` outbox，移除 stream 兼容分支后会按默认分支显示为 `unknown/raw` informational，不再唤醒 Agent，也不是 `action_required`。事件/outbox 由现有维护任务按 TTL 清理。
- **不可回滚**：按产品决定，旧任务表与旧任务历史不备份、不保留只读副本；`0042` 执行后无法通过迁移恢复。
- **SQLite 列删除**：`0042` 的列删除不可重放（SQLite 无 `DROP COLUMN IF EXISTS`）；表/索引删除可重放。生产由 `schema_migrations` 保证单次应用。
- **文件 TTL 延迟**：删除 `file_references.kind = 'task'` 行后，仅靠旧任务保留的文件在下一轮维护任务中恢复普通 TTL；迁移本身不做文件 I/O。
- **保留的枚举值**：`file_references.kind` 的 CHECK 仍允许历史 `'task'` 值，但运行时代码不再写入；本次只删除行，不重建表。

## 部署注意事项

1. 本分支代码不再读取旧任务表；建议先发布代码，再执行 `bun run db:migrate:remote`。
2. `0042` 是破坏性迁移，必须先确认旧任务数据不再需要；按本次决定不做备份。
3. 迁移按文件名顺序执行，`0041` 在 `0042` 之前；不要单独跳过 `0041`。
4. 运行环境需为 Bun 自带的 SQLite 3.35+（当前 Bun 1.4.2 为 3.51），否则 `DROP COLUMN` 不可用。
5. 迁移后检查 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`；文件保留释放等待下一轮维护任务。
