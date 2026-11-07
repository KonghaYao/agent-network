-- D03 · 任务业务状态与进度。
--
-- `tasks.status` 仍是唯一业务状态权威；本表只追加进度/阻塞/恢复的审计记录，
-- 不保存第二份“当前状态”。展示读取最新一条记录，历史用于核对 revision。
--
-- 约束：
-- - 每次进度或状态变化都递增 `tasks.revision`，本表以 (task_id, task_revision)
--   唯一，保证一个 revision 只有一条审计记录。
-- - 普通进度不创建消息、delivery 或 inbox 事件；只写 room scope 事件与
--   `room:<id>` outbox 提示。
-- - 旧 `room_tasks.done` 已在 0017 映射为 `legacy_completed`，不会被本表改写，
--   也不能借此伪造 `accepted`。

CREATE TABLE task_progress (
  progress_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  assignment_id TEXT,
  assignment_version INTEGER,
  actor_id TEXT NOT NULL,
  prior_status TEXT NOT NULL CHECK (prior_status IN
    ('unassigned','offered','in_progress','blocked','submitted','accepted','failed','cancelled','legacy_completed')),
  status TEXT NOT NULL CHECK (status IN
    ('unassigned','offered','in_progress','blocked','submitted','accepted','failed','cancelled','legacy_completed')),
  percent INTEGER CHECK (percent IS NULL OR (percent BETWEEN 0 AND 100)),
  note TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_task_progress_task_revision
  ON task_progress(task_id, task_revision);
