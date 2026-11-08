-- G06 群生命周期：退群、移除与解散。
--
-- 权威模型：
-- - `rooms.dissolved_at` 非空表示群已解散；`archive_head_seq` 固定解散时
--   room scope 的事件高水位，所有历史/文件/任务读取以它为只读上界。
-- - `archive_member_seq` 固定解散时的成员版本，供审计与未来媒体层判断成员
--   快照；是否可读仍由当前 active 成员资格和成员代次决定。
-- - 解散不删除任何消息、任务、成果、文件、邀请或审计；只关闭新的写入与
--   未结束工作。
-- - `guard_room_dissolved` 让所有写路径在事务内复核“群未解散”，避免只靠
--   UI 或预检查。
-- - 管理审计动作增加 `room_dissolved`；保留全部旧行。

ALTER TABLE rooms ADD COLUMN dissolved_at INTEGER;
ALTER TABLE rooms ADD COLUMN dissolved_by TEXT REFERENCES actors(actor_id);
ALTER TABLE rooms ADD COLUMN dissolve_reason TEXT;
ALTER TABLE rooms ADD COLUMN archive_head_seq INTEGER;
ALTER TABLE rooms ADD COLUMN archive_member_seq INTEGER;

DROP TABLE IF EXISTS guard_room_dissolved;
CREATE TABLE guard_room_dissolved (
  x INTEGER NOT NULL,
  CONSTRAINT guard_room_dissolved CHECK (x = 0)
);

-- SQLite 不能修改 CHECK；与 0024/0027 一样做一次正式表重建并保留全部旧行。
ALTER TABLE room_management_audit RENAME TO room_management_audit_old;

CREATE TABLE room_management_audit (
  audit_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  action TEXT NOT NULL CHECK (action IN (
    'member_added',
    'member_removed',
    'member_left',
    'admin_appointed',
    'admin_revoked',
    'owner_transferred',
    'owner_transfer_proposed',
    'owner_transfer_accepted',
    'owner_transfer_rejected',
    'owner_transfer_cancelled',
    'owner_transfer_expired',
    'policy_updated',
    'announcement_updated',
    'invite_created',
    'invite_revoked',
    'join_requested',
    'join_approved',
    'join_rejected',
    'room_dissolved'
  )),
  target_actor_id TEXT REFERENCES actors(actor_id),
  previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN ('owner', 'admin', 'member')),
  new_role TEXT CHECK (new_role IS NULL OR new_role IN ('owner', 'admin', 'member')),
  previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('active', 'left', 'removed')),
  new_status TEXT CHECK (new_status IS NULL OR new_status IN ('active', 'left', 'removed')),
  expected_revision INTEGER,
  resulting_revision INTEGER NOT NULL,
  changed_by TEXT NOT NULL REFERENCES actors(actor_id),
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

INSERT INTO room_management_audit
  (audit_id, room_id, action, target_actor_id, previous_role, new_role,
   previous_status, new_status, expected_revision, resulting_revision,
   changed_by, request_id, detail_json, created_at)
SELECT audit_id, room_id, action, target_actor_id, previous_role, new_role,
       previous_status, new_status, expected_revision, resulting_revision,
       changed_by, request_id, detail_json, created_at
  FROM room_management_audit_old;

DROP TABLE room_management_audit_old;

-- 表重建会随旧表一起删除索引；重新建立与 0024/0027 相同的审计索引。
CREATE INDEX idx_room_management_audit_room
  ON room_management_audit(room_id, created_at DESC, audit_id DESC);
CREATE INDEX idx_room_management_audit_actor
  ON room_management_audit(target_actor_id, created_at DESC);
