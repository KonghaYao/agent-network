-- 房间任务列表：每个房间默认一个 default 列表；list_id 预留给后续多列表。
-- 状态机 pending -> claimed -> done|failed；删除是物理删除，不做墓碑。
-- 任务变更只写 room scope events + outbox，不推进 rooms.head_seq、
-- 不写 inbox、不改变 pending_count，因此不会产生未读或唤醒 Agent。
CREATE TABLE room_tasks (
  task_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  list_id TEXT NOT NULL DEFAULT 'default',
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
  assignee_actor_id TEXT REFERENCES actors(actor_id),
  result TEXT,
  created_by TEXT NOT NULL REFERENCES actors(actor_id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  sort_order INTEGER NOT NULL
);
CREATE INDEX idx_room_tasks_list ON room_tasks(room_id, list_id, sort_order, task_id);
CREATE INDEX idx_room_tasks_assignee ON room_tasks(status, assignee_actor_id);

-- 条件闸门：只接受 x=0，命中时整批回滚，约束名用于错误分类。
CREATE TABLE guard_room_task_limit (x INTEGER NOT NULL, CONSTRAINT guard_room_task_limit CHECK (x = 0));
CREATE TABLE guard_task_conflict (x INTEGER NOT NULL, CONSTRAINT guard_task_conflict CHECK (x = 0));
CREATE TABLE guard_task_editor (x INTEGER NOT NULL, CONSTRAINT guard_task_editor CHECK (x = 0));
