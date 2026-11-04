-- 聊天绑定文件：把 MCPP Files v1 的 file_id 授权给一个房间。
-- 墓碑（deleted_at）保留到 expires_at 之后，防止删除后公开 URL 复活。
CREATE TABLE room_files (
  room_file_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  deleted_at INTEGER,
  deleted_by TEXT
);
-- 一个 file_id 只能绑定一次；跨房间复用显式返回 CONFLICT。
CREATE UNIQUE INDEX idx_room_files_file ON room_files(file_id);
CREATE INDEX idx_room_files_room_created ON room_files(room_id, created_at DESC, room_file_id DESC);
CREATE INDEX idx_room_files_uploader ON room_files(uploader_id, created_at DESC);
CREATE INDEX idx_room_files_expiry ON room_files(expires_at);

-- 条件闸门：只接受 x=0，命中时整批回滚，约束名用于错误分类。
CREATE TABLE guard_room_file_limit (x INTEGER NOT NULL, CONSTRAINT guard_room_file_limit CHECK (x = 0));
CREATE TABLE guard_not_file_owner (x INTEGER NOT NULL, CONSTRAINT guard_not_file_owner CHECK (x = 0));
