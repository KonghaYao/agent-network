-- 群主消息管理 v1：任意历史消息软撤回与最多 3 条房间级置顶。
--
-- 权威模型：
-- - 撤回仍只清空 messages 正文并写 tombstone，不新增消息列、不硬删行。
-- - 置顶是房间与消息的多对多集合，最多 3 条；slot 只是结构上限，不代表
--   时间线位置，也不暴露到 API。第 4 条由命名闸门返回 CONFLICT/pin_limit，
--   不隐式替换已有置顶。
-- - 消息被撤回时由同批事务删除置顶行；pin 不复制正文，也不引用文件。
-- - 管理审计只记录操作类型与目标 message_id，不保存正文、预览或摘要。
-- - 迁移只新增表和闸门，并重建既有审计 CHECK；不修改 messages/rooms 列，
--   不改角色、策略、群主转让或解散流程。

DROP TABLE IF EXISTS guard_room_message_pin_limit;
CREATE TABLE guard_room_message_pin_limit (
  x INTEGER NOT NULL,
  CONSTRAINT guard_room_message_pin_limit CHECK (x = 0)
);

DROP TABLE IF EXISTS guard_message_recalled;
CREATE TABLE guard_message_recalled (
  x INTEGER NOT NULL,
  CONSTRAINT guard_message_recalled CHECK (x = 0)
);

DROP TABLE IF EXISTS guard_room_message_unavailable;
CREATE TABLE guard_room_message_unavailable (
  x INTEGER NOT NULL,
  CONSTRAINT guard_room_message_unavailable CHECK (x = 0)
);

CREATE TABLE room_pinned_messages (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  slot INTEGER NOT NULL,
  pinned_by TEXT NOT NULL REFERENCES actors(actor_id),
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id),
  UNIQUE (room_id, slot),
  CONSTRAINT room_pinned_messages_slot CHECK (slot >= 1 AND slot <= 3)
);

-- SQLite 不能修改 CHECK；与 0024/0027/0037 一样做一次正式表重建并保留全部旧行。
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
    'room_dissolved',
    'message_recalled',
    'message_pinned',
    'message_unpinned'
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

-- 表重建会随旧表一起删除索引；重新建立与 0024/0027/0037 相同的审计索引。
CREATE INDEX idx_room_management_audit_room
  ON room_management_audit(room_id, created_at DESC, audit_id DESC);
CREATE INDEX idx_room_management_audit_actor
  ON room_management_audit(target_actor_id, created_at DESC);
