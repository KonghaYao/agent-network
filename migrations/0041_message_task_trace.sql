-- 消息式 Task / Trace：归属字段、标记审计与查询索引。
--
-- 不新建任务表、不生成任务 ID：起点消息自身 `task_root_id = message_id`；
-- 处理消息显式归属或从父消息继承同一值。`task_marked_by` / `task_marked_at`
-- 只记录起点标记，用于审计与展示，不参与集合判定。取消标记只清空起点三列，
-- 保留处理消息的归属与引用关系，重新标记后原集合恢复。
--
-- 旧 messages 行保持 `task_root_id IS NULL`，无需回填；普通线程消息仍由
-- `root_id` 表达，任务集合查询只在根已标记时使用该列。

ALTER TABLE messages ADD COLUMN task_root_id TEXT;
ALTER TABLE messages ADD COLUMN task_marked_by TEXT;
ALTER TABLE messages ADD COLUMN task_marked_at INTEGER;

-- 归属/成员查询：按房间与根顺序读取，只为已归属消息付索引成本。
CREATE INDEX idx_messages_task_root
  ON messages(room_id, task_root_id, created_seq)
  WHERE task_root_id IS NOT NULL;

-- 引用来源反向查找：处理消息 -> 被引用的来源消息。
CREATE INDEX idx_messages_room_reply_to
  ON messages(room_id, reply_to, created_seq)
  WHERE reply_to IS NOT NULL;

-- 标记起点：目标必须存在、同房间、当前可见且未撤回。
DROP TABLE IF EXISTS guard_task_mark_unavailable;
CREATE TABLE guard_task_mark_unavailable (
  x INTEGER NOT NULL,
  CONSTRAINT guard_task_mark_unavailable CHECK (x = 0)
);

-- 标记起点：目标已归属另一个仍标记中的 Task 时冲突，不静默移动。
DROP TABLE IF EXISTS guard_task_mark_conflict;
CREATE TABLE guard_task_mark_conflict (
  x INTEGER NOT NULL,
  CONSTRAINT guard_task_mark_conflict CHECK (x = 0)
);
