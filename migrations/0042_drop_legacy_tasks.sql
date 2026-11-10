-- 阶段 4b-2：删除旧任务模型（破坏性，不备份、不做只读保留）。
--
-- 旧任务工具、domain 与 Web 入口已在阶段 4a/4b-1 硬切；本迁移只清理数据库。
-- 新模型不新增任务实体表：Task 是 `messages.task_root_id` 标记的集合，
-- `messages.task_root_id` / `task_marked_by` / `task_marked_at` 与
-- `idx_messages_task_root` 必须保留。
--
-- 普通消息、房间、成员、普通文件与成果数据不删除、不重建、不回填。
-- 旧任务专属的表与列在本次迁移后不再存在：
-- - 看板：`room_tasks`（0010，含 0025 追加的 `created_seq`）；
-- - 工作流：`tasks`、`task_assignments`、`task_transfers`、`task_submissions`、
--   `task_reviews`、`task_deliveries`、`task_cards`、`task_attachments`（0017）；
-- - 进度/恢复：`task_progress`（0029）、`task_reminders`、`task_external_actions`
--   （0035）；
-- - 交接包：`task_handoff_packs`、`task_handoff_pack_items`、
--   `task_handoff_context_requests`（0034）；其中 items 是旧交接文件授权来源；
-- - 闸门：`guard_room_task_limit`、`guard_task_conflict`、`guard_task_editor`
--   （0010）、`guard_task_state`（0018）、`guard_assignment_stale`（0018）、
--   `guard_review_stale`（0033）、`guard_handoff_conflict`（0034）。
--   新消息式 Task 的 `guard_task_mark_unavailable` / `guard_task_mark_conflict`
--   不属于旧模型，继续保留。
-- - 列：`artifacts.task_id`（0026）与依赖它的索引；`rooms.member_task_policy`
--   （0020）。旧 `rooms.member_task_policy` 只影响旧任务创建权限，删除后不再有
--   第二份任务授权配置。
-- - 引用：`file_references.kind = 'task'` 的旧任务文件授权行。删除后维护任务会
--   在下一轮把仅靠旧任务保留的房间文件/Drive 文件恢复普通 TTL；文件字节本身
--   不在此迁移中清理，避免迁移事务里做 I/O。
--
-- 幂等/重放：
-- - 表使用 `DROP TABLE IF EXISTS`，可重复执行；`DROP INDEX IF EXISTS` 同理。
-- - SQLite（3.35+）支持 `ALTER TABLE ... DROP COLUMN`，但不支持
--   `DROP COLUMN IF EXISTS`。`schema_migrations` 保证本文件只应用一次；对已迁移
--   库手工重放时，列删除会因列不存在而失败，这是 SQLite 的语法限制，不用
--   `writable_schema` 之类的非事务手段绕过。
-- - 不使用 `PRAGMA foreign_keys=OFF`：迁移在事务内执行，该 PRAGMA 在事务中
--   无效；先删子表、再删父表，保持外键检查开启。

DELETE FROM file_references WHERE kind = 'task';

DROP TABLE IF EXISTS task_handoff_pack_items;
DROP TABLE IF EXISTS task_handoff_context_requests;
DROP TABLE IF EXISTS task_handoff_packs;

DROP TABLE IF EXISTS task_reminders;
DROP TABLE IF EXISTS task_external_actions;
DROP TABLE IF EXISTS task_progress;

DROP TABLE IF EXISTS task_deliveries;
DROP TABLE IF EXISTS task_cards;
DROP TABLE IF EXISTS task_attachments;
DROP TABLE IF EXISTS task_reviews;
DROP TABLE IF EXISTS task_submissions;
DROP TABLE IF EXISTS task_transfers;
DROP TABLE IF EXISTS task_assignments;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS room_tasks;

DROP TABLE IF EXISTS guard_room_task_limit;
DROP TABLE IF EXISTS guard_task_conflict;
DROP TABLE IF EXISTS guard_task_editor;
DROP TABLE IF EXISTS guard_task_state;
DROP TABLE IF EXISTS guard_assignment_stale;
DROP TABLE IF EXISTS guard_review_stale;
DROP TABLE IF EXISTS guard_handoff_conflict;

DROP INDEX IF EXISTS idx_artifacts_task_version;
DROP INDEX IF EXISTS idx_artifacts_task;
ALTER TABLE artifacts DROP COLUMN task_id;

ALTER TABLE rooms DROP COLUMN member_task_policy;
