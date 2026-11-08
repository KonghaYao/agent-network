-- D08 · 催办、取消与异常恢复。
--
-- 目的：
-- - `task_reminders` 持久化任务催办窗口，事件键由 task_id + assignment_version
--   + 窗口锚点决定；重启后同一窗口不会重复提醒，也不需要恢复旧进程栈。
-- - `task_external_actions` 记录可能产生外部副作用的 action_id、意图与人工/
--   查询结论。响应丢失时先保持 unknown，不由租约过期自动重跑。
-- - `tasks` 追加取消审计列：操作者、原因与外部执行停止状态。外部执行是否
--   真正停止只能由操作者声明或后续对账确认，取消本身不承诺强一致停止。
--
-- 权威状态：
-- - `tasks.status` / `tasks.revision`、`task_assignments`、`deliveries` 仍是
--   唯一业务权威；本迁移只追加提醒窗口、外部动作审计与取消元数据。
-- - `task_reminders` 不复制任务状态，也不创建 delivery；提醒只是 inbox 事件
--   与 `inbox:{actor}` outbox 提示。
--
-- 约束/索引：
-- - `task_reminders.event_key` 唯一，(task_id, assignment_id, anchor_at) 唯一；
--   并发/重入扫描收敛到同一窗口。
-- - `task_external_actions` 主键为 (task_id, action_id)，同一任务内 action_id
--   稳定去重；不同任务允许相同 action_id，由调用方按 task_id 定位。
-- - 取消列只接受 confirmed/unknown/not_required 或 NULL；历史任务保持 NULL。
--
-- 旧数据映射：
-- - 本迁移不改写既有行。旧任务 `external_stop_status` 为 NULL，读取时表示
--   “未记录”；历史取消原因仍可从事件补读。
-- - 旧任务没有提醒窗口与外部动作记录，首次扫描/调用时自然建立。
--
-- 恢复方式：
-- - 回退应用版本时旧代码忽略新增表与列，数据库保持可用。
-- - 本迁移不删除、不重建任何已发布表，也不改写既有行。

ALTER TABLE tasks ADD COLUMN cancelled_by TEXT;
ALTER TABLE tasks ADD COLUMN cancel_reason TEXT;
ALTER TABLE tasks ADD COLUMN external_stop_status TEXT
  CHECK (external_stop_status IS NULL OR external_stop_status IN
    ('confirmed', 'unknown', 'not_required'));

CREATE TABLE task_reminders (
  reminder_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL,
  owner_actor_id TEXT NOT NULL,
  anchor_at INTEGER NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
-- 同一 assignment 的同一窗口只允许一条提醒；并发扫描由唯一索引裁决。
CREATE UNIQUE INDEX idx_task_reminders_window
  ON task_reminders(task_id, assignment_id, anchor_at);
CREATE INDEX idx_task_reminders_assignment
  ON task_reminders(task_id, assignment_id, created_at DESC);

CREATE TABLE task_external_actions (
  action_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN
    ('unknown', 'confirmed', 'not_executed', 'rejected')),
  evidence TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, action_id)
);
CREATE INDEX idx_task_external_actions_task
  ON task_external_actions(task_id, state, updated_at DESC);
CREATE INDEX idx_task_external_actions_action
  ON task_external_actions(action_id);
