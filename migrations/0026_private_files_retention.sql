-- M07 私有文件授权与成果保留。
--
-- 权威模型：
-- - `drive_files` 是每个上传载荷的应用层授权登记：上传即私有草稿（默认 24h），
--   绑定房间后为普通附件（默认 30d），被有效任务/成果引用后无限期保留
--   （`expires_at IS NULL`）；公开发布是独立字段 `visibility`，默认 private。
-- - `room_files` 继续保存房间绑定与墓碑；新增 `retained` 表达“不随 TTL 清理”。
-- - `artifacts` 保存成果版本；`file_references` 保存任务、成果、转发与收藏引用，
--   GC 只按 active 引用判断可达性。
-- - 所有公开下载仍走 `/f/<file_id>`；无票据、非成员或已撤权一律 404。
-- - 软删只改状态并保留业务元数据；载荷在宽限期后由维护任务清理。

CREATE TABLE drive_files (
  file_id TEXT PRIMARY KEY,
  -- MCPP Files 的 ownerScope（actor:<id> / credential:<hash>）。
  owner_scope TEXT NOT NULL,
  -- 上传时已注册的 actor；未注册凭据上传为 NULL。
  uploader_id TEXT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('draft', 'bound', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  room_id TEXT,
  created_at INTEGER NOT NULL,
  -- NULL 表示被有效任务/成果引用，禁止 TTL 清理。
  expires_at INTEGER,
  retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1)),
  deleted_at INTEGER,
  deleted_by TEXT,
  purged_at INTEGER
);

CREATE INDEX idx_drive_files_owner
  ON drive_files(owner_scope, state, created_at DESC, file_id DESC);
CREATE INDEX idx_drive_files_expiry
  ON drive_files(expires_at) WHERE state IN ('draft', 'bound');
CREATE INDEX idx_drive_files_room
  ON drive_files(room_id, state, created_at DESC);

-- 房间附件默认随 30 天 TTL 清理；有效任务/成果引用后置 1，直到显式释放。
ALTER TABLE room_files ADD COLUMN retained INTEGER NOT NULL DEFAULT 0
  CHECK (retained IN (0, 1));

-- 旧库已绑定的房间附件补齐授权登记：绑定只接受上传者 actor scope，因此
-- owner_scope 可由 uploader 推导。升级后旧裸 URL 一律收紧为私有，载荷
-- 交由统一 GC 回收；未绑定的旧上传没有 room_files，首次授权读取时登记。
INSERT INTO drive_files
  (file_id, owner_scope, uploader_id, name, mime_type, size, sha256,
   state, visibility, room_id, created_at, expires_at, retained,
   deleted_at, deleted_by, purged_at)
SELECT rf.file_id,
       'actor:' || rf.uploader_id,
       rf.uploader_id,
       rf.name,
       rf.mime_type,
       rf.size,
       rf.sha256,
       CASE WHEN rf.deleted_at IS NOT NULL THEN 'deleted' ELSE 'bound' END,
       'private',
       rf.room_id,
       rf.created_at,
       CASE WHEN rf.retained = 1 THEN NULL ELSE rf.expires_at END,
       rf.retained,
       rf.deleted_at,
       rf.deleted_by,
       NULL
  FROM room_files rf
 WHERE NOT EXISTS (SELECT 1 FROM drive_files df WHERE df.file_id = rf.file_id);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  task_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  file_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('delivered', 'released')),
  created_at INTEGER NOT NULL,
  -- 成果创建的 room event 序号；历史边界与 room_files 使用同一规则。
  created_seq INTEGER,
  released_at INTEGER,
  released_by TEXT
);

-- 同一 file_id 只能对应一个成果版本；同一任务版本不可重复。
CREATE UNIQUE INDEX idx_artifacts_file ON artifacts(file_id);
CREATE UNIQUE INDEX idx_artifacts_task_version
  ON artifacts(room_id, task_id, version) WHERE task_id IS NOT NULL;
CREATE INDEX idx_artifacts_room_created
  ON artifacts(room_id, created_at DESC, artifact_id DESC);
CREATE INDEX idx_artifacts_task ON artifacts(room_id, task_id, version);

CREATE TABLE file_references (
  reference_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'artifact', 'forward', 'favorite')),
  ref_id TEXT NOT NULL,
  room_id TEXT,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released')),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT
);

CREATE UNIQUE INDEX idx_file_references_identity
  ON file_references(kind, ref_id, file_id);
CREATE INDEX idx_file_references_file ON file_references(file_id, state);
CREATE INDEX idx_file_references_ref ON file_references(kind, ref_id, state);

-- 文件不可用（不存在/已删除/已过期/正在被清理）时整批回滚。
DROP TABLE IF EXISTS guard_file_unavailable;
CREATE TABLE guard_file_unavailable (
  x INTEGER NOT NULL,
  CONSTRAINT guard_file_unavailable CHECK (x = 0)
);

-- 成果重复绑定、释放竞态或引用冲突。
DROP TABLE IF EXISTS guard_artifact_conflict;
CREATE TABLE guard_artifact_conflict (
  x INTEGER NOT NULL,
  CONSTRAINT guard_artifact_conflict CHECK (x = 0)
);

-- 仍有有效成果/任务引用的文件不能被删除或释放保留。
DROP TABLE IF EXISTS guard_file_referenced;
CREATE TABLE guard_file_referenced (
  x INTEGER NOT NULL,
  CONSTRAINT guard_file_referenced CHECK (x = 0)
);
