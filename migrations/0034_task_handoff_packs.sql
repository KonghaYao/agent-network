-- D05 · 可授权交接上下文包。
--
-- 目的：
-- - 把交接所需的显式成果、引用与下一步保存为版本化工作数据，而不是复制
--   整段群历史。`task_handoff_packs` 每次生成新版本；旧版本原样保留。
-- - `task_handoff_pack_items` 只保存引用（message_id/file_id/branch/commit/
--   test/submission）与创建者提供的短标签/摘要，不保存源消息正文或文件字节。
-- - 跨范围私有材料必须在 `items.authorized` 显式置 1 后才向目标范围签发可读
--   票据；未授权项没有 URL。源文件删除或授权来源失权后，重新读取包会重新
--   校验并显示 missing/omitted，不缓存旧秘密副本。
-- - `task_handoff_context_requests` 记录接任者的补充上下文请求；请求不改变
--   任务所有者、assignment 或 revision。
--
-- 权威状态：
-- - `tasks`、`task_assignments`、`task_submissions` 仍是唯一权威；本迁移的
--   表只保存交接包、引用与请求，不复制任务状态。
-- - 交接包是工作数据，不是权限指令：包内引用、脚本或外部消息不能扩大任何
--   授权；文件读取仍由 `/f` 的实时票据与成员资格决定。
--
-- 约束/索引：
-- - `(task_id, version)` 唯一，保证版本号单调且一个版本只生成一次。
-- - `required` / `authorized` 仅接受 0/1；`kind` 受枚举约束。
-- - 闸门表与 0002 相同，只接受 x = 0；正常提交后始终为空。
--
-- 旧数据映射：
-- - 本迁移不新增列、不改写既有行；迁移前任务没有交接包，读取时
--   `context_ready = false`，保持 D04 行为。
--
-- 恢复方式：
-- - 回退应用版本时旧代码忽略新增表，数据库保持可用。
-- - 本迁移不删除、不重建任何已发布表，也不改写既有行。

CREATE TABLE task_handoff_packs (
  pack_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  from_assignment_id TEXT,
  from_assignment_version INTEGER NOT NULL,
  from_owner_actor_id TEXT,
  created_by TEXT NOT NULL,
  goal TEXT NOT NULL,
  completed_json TEXT NOT NULL DEFAULT '[]',
  current_result_json TEXT NOT NULL DEFAULT '{}',
  unresolved_json TEXT NOT NULL DEFAULT '[]',
  next_steps_json TEXT NOT NULL DEFAULT '[]',
  source_room_id TEXT,
  created_at INTEGER NOT NULL
);
-- 版本号由服务端在事务内取 max+1；唯一索引是并发创建的最终裁决。
CREATE UNIQUE INDEX idx_task_handoff_packs_version
  ON task_handoff_packs(task_id, version);
CREATE INDEX idx_task_handoff_packs_task
  ON task_handoff_packs(task_id, created_at DESC);

CREATE TABLE task_handoff_pack_items (
  item_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('message','file','branch','commit','test','submission')),
  reference TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source_room_id TEXT,
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
  authorized_by TEXT,
  authorized_at INTEGER,
  revoked_by TEXT,
  revoked_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_handoff_items_pack
  ON task_handoff_pack_items(pack_id, created_at);
-- `/f` 以 file_id + 目标房间查找有效授权；部分索引避免扫描非文件项。
CREATE INDEX idx_task_handoff_items_file
  ON task_handoff_pack_items(reference) WHERE kind = 'file';
CREATE INDEX idx_task_handoff_items_message
  ON task_handoff_pack_items(reference) WHERE kind = 'message';

CREATE TABLE task_handoff_context_requests (
  context_request_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_handoff_requests_pack
  ON task_handoff_context_requests(pack_id, created_at DESC);
CREATE INDEX idx_task_handoff_requests_task
  ON task_handoff_context_requests(task_id, created_at DESC);

CREATE TABLE guard_handoff_conflict (
  x INTEGER NOT NULL,
  CONSTRAINT guard_handoff_conflict CHECK (x = 0)
);
