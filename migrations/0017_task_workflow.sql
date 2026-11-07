-- D01 · 任务工作流。
--
-- `room_tasks` 的短文本板在本次迁移后只读保留；新写入统一进入 `tasks`。
-- 状态、assignment、提交/验收、交付绑定与旧数据映射按共享契约 0017/8.5。
-- 旧 `task_*` ID 原样迁入；新任务使用 `tsk_`，不冲突。
--
-- 实现补充（不改契约对象语义）：
-- - `task_cards` 保存任务卡片对应的真实 message_id；冻结的 `tasks` 表没有
--   card_message_id 列，而 `deliveries.message_id NOT NULL` 要求 offer 必须
--   引用真实消息，因此用一对一映射表表达该关系。
-- - `task_attachments` 只保存受控附件引用（file_id + 展示标签），不复制文件
--   内容、不授予文件读取权限；文件读取仍走房间文件/成果自己的授权入口。

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  source_message_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN
    ('unassigned','offered','in_progress','blocked','submitted','accepted','failed','cancelled','legacy_completed')),
  revision INTEGER NOT NULL DEFAULT 1,
  owner_actor_id TEXT,
  current_assignment_id TEXT,
  reviewer_actor_id TEXT NOT NULL,
  due_at INTEGER,
  blocked_reason TEXT,
  blocked_at INTEGER,
  last_progress_at INTEGER,
  business_authority TEXT NOT NULL DEFAULT 'native' CHECK (business_authority IN ('native','external')),
  external_binding_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX idx_tasks_room_status_updated ON tasks(room_id, status, updated_at);
CREATE INDEX idx_tasks_owner_status ON tasks(owner_actor_id, status);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_actor_id, status);
-- 一条来源消息至多生成一个任务；重放/并发创建在事务内收敛，不复制任务或授权。
CREATE UNIQUE INDEX idx_tasks_source_message ON tasks(source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE TABLE task_assignments (
  assignment_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL,
  owner_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('offered','active','submitted','declined','revoked','expired')),
  offered_by TEXT NOT NULL,
  offer_expires_at INTEGER,
  accepted_at INTEGER,
  ended_at INTEGER,
  last_progress_at INTEGER,
  delivery_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_task_assignments_version ON task_assignments(task_id, assignment_version);
CREATE UNIQUE INDEX idx_task_assignments_current ON task_assignments(task_id)
  WHERE status IN ('offered','active');
CREATE INDEX idx_task_assignments_owner ON task_assignments(owner_actor_id, status);

CREATE TABLE task_transfers (
  transfer_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_assignment_id TEXT,
  from_assignment_version INTEGER,
  to_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  context_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT
);
CREATE UNIQUE INDEX idx_task_transfers_pending ON task_transfers(task_id) WHERE status = 'pending';

CREATE TABLE task_submissions (
  submission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  summary TEXT NOT NULL,
  materials_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  known_limits TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','returned','superseded')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE UNIQUE INDEX idx_task_submissions_version ON task_submissions(task_id, version);
CREATE UNIQUE INDEX idx_task_submissions_pending ON task_submissions(task_id) WHERE status = 'pending';

CREATE TABLE task_reviews (
  review_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  reviewer_actor_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accept','return')),
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_reviews_task ON task_reviews(task_id, created_at);

CREATE TABLE task_deliveries (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL,
  task_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task_offer','task_reminder')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_task_deliveries_assignment_kind ON task_deliveries(assignment_id, kind);
CREATE INDEX idx_task_deliveries_task ON task_deliveries(task_id, kind);

CREATE TABLE task_cards (
  task_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_cards_message ON task_cards(message_id);

CREATE TABLE task_attachments (
  task_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, file_id)
);
CREATE INDEX idx_task_attachments_file ON task_attachments(file_id);

-- 旧数据映射（契约 8.5）。旧表保留只读，不再接受新写入。
INSERT INTO tasks (
  task_id, room_id, created_by, source_message_id, title, description,
  acceptance_criteria, status, revision, owner_actor_id, current_assignment_id,
  reviewer_actor_id, due_at, blocked_reason, blocked_at, last_progress_at,
  business_authority, external_binding_id, created_at, updated_at,
  accepted_at, cancelled_at
)
SELECT
  task_id,
  room_id,
  created_by,
  NULL,
  substr(description, 1, 120),
  description,
  '',
  CASE status
    WHEN 'pending' THEN 'unassigned'
    WHEN 'claimed' THEN 'in_progress'
    WHEN 'done' THEN 'legacy_completed'
    WHEN 'failed' THEN 'failed'
  END,
  1,
  assignee_actor_id,
  NULL,
  created_by,
  NULL,
  NULL,
  NULL,
  NULL,
  'native',
  NULL,
  created_at,
  updated_at,
  NULL,
  NULL
FROM room_tasks;

INSERT INTO task_assignments (
  assignment_id, task_id, assignment_version, owner_actor_id, status,
  offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
  delivery_id, created_at, updated_at
)
SELECT
  'asg_legacy_' || task_id,
  task_id,
  1,
  assignee_actor_id,
  'active',
  created_by,
  NULL,
  updated_at,
  NULL,
  NULL,
  NULL,
  created_at,
  updated_at
FROM room_tasks
WHERE status = 'claimed' AND assignee_actor_id IS NOT NULL;

UPDATE tasks
   SET current_assignment_id = 'asg_legacy_' || task_id
 WHERE status = 'in_progress'
   AND EXISTS (
     SELECT 1 FROM task_assignments a
      WHERE a.task_id = tasks.task_id AND a.assignment_version = 1
   );
