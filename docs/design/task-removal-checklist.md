# 旧 Task 摘除执行清单（TF-08）

依据：2026-11-27 只读勘察（基线 1b8ccc65）。按阶段执行；每阶段结束跑对应检查，最后统一重录快照。

## 0. 不可误删

1. `kind: 'task'` 同时用于 delivery 回执：`src/realtime/stream.ts` 的 `delivery.retried` / `delivery.created`，`scripts/lib/stream-acceptance.ts` 有断言。只删消息式 Task 的 `task.updated` 映射。
2. `migrations/0041_message_task_trace.sql` 里的 `idx_messages_room_reply_to` 是普通回复链索引，保留；0041/0048 不回改。
3. `src/web/features/tasks/MessageSearchDialog.tsx` 是普通消息搜索，迁到 `src/web/features/search/`，不要随目录删除。
4. `delivery` 事件、`delivery` 状态机、`pending_count`、未读、历史边界、房间权限全部保留。
5. `rooms.events_min_seq` / `actors.inbox_min_seq` 不动。

## 1. 迁移 0053_drop_message_tasks.sql（顺序固定）

1. `DROP INDEX IF EXISTS idx_messages_task_root;`
2. 先清 outbox，再清 events：
   - `DELETE FROM outbox WHERE event_seq IN (SELECT event_seq FROM events WHERE event_type IN ('message_task_marked','message_task_unmarked','message_task_completed') OR event_type LIKE 'task\_%' ESCAPE '\' OR event_type LIKE 'room\_task\_%' ESCAPE '\');`
   - `DELETE FROM events WHERE event_type IN (...) OR event_type LIKE ...;`
3. 清 `operations` 中旧 Task 写结果（按 result_json 特征）：
   - 含 `"task_root_id"` 的行；
   - 含 `"root_message_id"` 且含 `"status":"completed"` 的行。
   保留其它 operations。
4. 清 `message_created` 事件 metadata 的任务字段：
   - `UPDATE events SET metadata = json_remove(metadata, '$.task_root_id') WHERE event_type='message_created' AND json_valid(metadata) AND json_extract(metadata,'$.task_root_id') IS NOT NULL;`
5. 清 Memory `task_offer`：
   - `DELETE FROM memory_sources WHERE source_kind='task_offer' OR source_key LIKE 'task_offer:%';`
   - `DELETE FROM memory_recall_requests WHERE request_key LIKE 'auto:task_offer:%';`
   - `DELETE FROM memory_tombstones WHERE source_key LIKE 'task_offer:%';`
   - `UPDATE memory_recall_requests SET target_json = json_remove(target_json,'$.task_root_id') WHERE json_valid(target_json) AND json_extract(target_json,'$.task_root_id') IS NOT NULL;`
   - 先只读检查 `memory_representations` / `memory_experiences` 是否引用 task_offer 来源；若为 0 才删来源，否则只停写并把来源置 retracted（按实际 schema）。
6. `ALTER TABLE messages DROP COLUMN task_root_id;` 再依次删除 `task_marked_by`、`task_marked_at`、`task_completed_at`、`task_completed_by`。
7. `DROP TABLE IF EXISTS guard_task_mark_unavailable; DROP TABLE IF EXISTS guard_task_mark_conflict;`
8. 早期 `room_tasks` / `tasks` 等旧表若仍存在，`DROP TABLE IF EXISTS`；按实际 `sqlite_master` 清单执行，不按猜测。

## 2. 后端删除

1. 整文件：`src/domain/message-task*.ts`（5 个）、`src/mcp/task-tools.ts`、`client/commands/task.ts`。
2. `src/domain/messages/view.ts`：删除 `MessageView.task_root_id`、`MessageCore.taskRootId`、事件 metadata 写入、INSERT 列、`RootLink.taskRootId`、`visibleMarkedTaskRoot/inheritedTaskRoot` 与 `resolveRootLink` 的任务分支；收敛为普通 `reply_to/root_id/hop`。
3. `src/domain/messages/send.ts`：删除 `task_root_id` 输入、继承、幂等冲突分支；普通 reply 逻辑保留。
4. `src/domain/messages/history.ts`、`timeline.ts`、`rooms/views.ts`、`sync.ts`、`deliveries.ts`、`storage/rows.ts`、`storage/queries/messages.ts`：删除任务字段与派生参数。`sync.ts` 删除 `task_%`/`room_task_%` 过滤（清理后无意义）。
5. `src/contracts/schemas.ts`：删除 7 个 task schema；`messageSendSchema` 删除 `task_root_id`，并加 `task_root_id: z.never().optional()`，让显式旧参数在执行前报契约错误。
6. `src/contracts/events.ts`：删除 3 个 `message_task_*` 常量；保留 delivery 常量。
7. `src/contracts/limits.ts`：删除 task 专用阈值；不要动共享阈值。
8. `src/realtime/stream.ts`：删除 3 个 task event case 与 `task.updated` 映射；保留 delivery 的 `kind:'task'`。
9. `src/storage/schema/core.ts`：删除 messages 5 列与 `idx_messages_task_root`；保留 `idx_messages_room_reply_to`。`src/storage/guards.ts` 删除两个 task guard。
10. MCP 解注册：`src/mcp/message-tools.ts` 删除 `registerTaskTools`；`src/mcp/tools.ts` 清理描述；`src/mcp/outputs.ts`/`outputs/messages.ts` 删除 task 输出与字段；`src/mcp/skill.ts` 删除 task 段落；`src/mcp/client-contract.ts` 指引删除 task 步骤。
11. CLI：`client/cli.ts` 删除 task 命令注册；`client/commands/rooms.ts` 删除 `--task-root`；`client/monitor/*` 的 delivery `task` 提示保留。
12. Memory：`src/memory/intake.ts` 删除 `taskOffer*` 函数与 `taskRootId` 参数；`src/memory/contracts-core.ts` 枚举保留但停写（记录在验收报告）；`deliveries.ts` 删除 `taskRootId` 传给 warmup。`scripts/verify-memory-injection.ts` 用 `file` 来源替换 task_offer 样本。
13. 搜索：`src/domain/message-task-search.ts` 删除；普通 `message-search*` 不动。

## 3. Web 删除

1. 整文件删除：`features/tasks/{RoomTaskDock,TaskListItem,TaskPreviewPopover,TaskSummaryBar,TaskCompleteDialog,TaskTraceDialog,useRoomTaskController,useTaskAskProgress,task-ask,task-format,types}.tsx/ts`、`hooks/{useRoomTasks,useTaskTrace}.ts`、`lib/task-cache.ts`、`chat-task-dock-styles.ts`、`chat-task-trace-styles.ts`。
2. `MessageSearchDialog.tsx` 移到 `features/search/`；删除 `taskOnly` 与 task 搜索结果分支；`features/search/message-search-types.ts` 删除 `TaskSummary`；`useMessageSearchQuery.ts` 删除 `network_task_search` 分支。
3. `ChatPage.tsx` 删除 dock/controller/ask/progress 与 Task 撤回收敛；保留 composer 与 timeline。
4. `ChatMessage.tsx` 删除 `onToggleTask/onOpenTask`、标记菜单、`data-task-message`、TaskSummaryBar；`Timeline*` 删除透传。
5. `ChatDialogs*`、`useRoomChat`、`useRoomModerationEvents`、`useRoomMessageModeration`、`RecoveryHost`：删除 task 字段/重置调用。
6. `query-keys.ts` 删除 task keys；`room-stream-refresh.ts` 删除 `task.updated` 映射，但 delivery 的 `kind:'task'` 仍按原行为刷新。
7. 样式：`chat-message-actions-styles.ts` 删除 `[data-task-message]`；`chat-styles.ts` 删除 `.task-message-flash`；`spa-shell.ts` 停止注入两份 task 样式。
8. 删除 e2e：`tests/e2e/task-dock.spec.ts`、`tests/e2e/fixtures/task-*.ts`；按勘察报告删除各 spec 中的 task 段落，保留普通 IM 断言。

## 4. 文档与快照

1. `docs/feature-matrix.md`、`docs/code-index.md`、`README.md`、`README.zh.md`、`README.full.md`、`docs/agent-collaboration-workflow.md`、`public/skills/*.md` 删除 Task 入口/说明；`reports/MESSAGE-TASK-TRACE.md` 加“已退役”头注。
2. `scripts/verify-drizzle-schema.ts` 迁移数与 `schema_migrations` 数 +1；`tests/fixtures/schema-surface.json` 用 `--update` 重录。
3. `scripts/capture-mcp-baseline.ts` 重录 `tests/fixtures/mcp-baseline.json`；`CLIENT_CONTRACT_VERSION` 递增。
4. `scripts/q01-upgrade-check.ts`：`NEW_MIGRATIONS` 追加 0053；旧 Task 断言改为“列/索引/guard/表均不存在”；追加空库与升级库对照。
5. `scripts/lib/feedback-unit.ts` 迁移名列表追加。

## 5. 验收

1. 空库启动：`sqlite_master` 中无 `task_*` 列、无 `idx_messages_task_root`、无 `guard_task_mark_*`、无旧任务表。
2. 升级库：从 0051 结构 + 两条带 task 字段的消息升级后，普通消息正文/线程/ID/附件/delivery/未读/边界不变；零任务字段。
3. `MCP tools/list` 无 `network_task_*`；旧工具调用返回未知工具；`network_message_send` 带 `task_root_id` 返回契约错误且无新消息/事件。
4. `bun run typecheck`、`bun scripts/verify-drizzle-schema.ts`、`bun scripts/verify-mcp-parity.ts`、`bun run test:protocol`、`bun run test:client-contract`、`bun run test:web`（或相应子集）、`bun run q01-upgrade-check`。
5. `git diff --check`。
