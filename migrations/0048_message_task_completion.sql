-- 消息式 Task 完成元数据。
--
-- 完成只记录在起点消息上：`task_completed_at` / `task_completed_by` 同时为空
-- 表示 open，同时有值表示 completed。旧数据无需回填，统一推导为 open。
-- 完成不清除 `task_root_id`，不取消 delivery，也不改变 `head_seq`、
-- `pending_count` 或已读位置。
--
-- 不新增任务表、状态列或索引；两列只跟随 messages 行读取。

ALTER TABLE messages ADD COLUMN task_completed_at INTEGER;
ALTER TABLE messages ADD COLUMN task_completed_by TEXT;
