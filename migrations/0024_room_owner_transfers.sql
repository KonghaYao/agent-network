-- G05 群主转让确认。
--
-- 权威模型：
-- - `room_owner_transfers` 是提议的唯一权威来源；同一群至多一条 pending。
-- - 提议只表示“原群主愿意把群主交给目标”，接受前 `rooms.owner_id` 与双方
--   `room_members.role` 都不改变，原群主继续负责。
-- - 目标明确接受时才在同一事务内更新 `rooms.owner_id`、双方角色与
--   `role_revision`，并把提议置为 accepted。
-- - 提议默认 24 小时有效（LIMITS.roomOwnerTransferTtlMs）；过期、目标离群/
--   被移除或原群主不再是 owner 时由后续读取/发起/接受按条件判定失效。
-- - 通知只写 events/outbox 与 inbox，不创建 delivery，也不增加 pending_count。

CREATE TABLE room_owner_transfers (
  transfer_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  from_owner_id TEXT NOT NULL REFERENCES actors(actor_id),
  to_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 提议发起时目标的 role_revision；接受时复核，防止角色在提议期间漂移。
  target_role_revision INTEGER NOT NULL CHECK (target_role_revision >= 1),
  -- 由过期、目标离群/被移除等非主动动作失效时记录原因；主动响应保持 NULL。
  invalid_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT REFERENCES actors(actor_id),
  CHECK (from_owner_id <> to_actor_id)
);

-- 同一群只允许一条有效（pending）转让提议；接受/取消/拒绝后可以再次发起。
CREATE UNIQUE INDEX idx_room_owner_transfers_pending
  ON room_owner_transfers(room_id) WHERE status = 'pending';
CREATE INDEX idx_room_owner_transfers_target
  ON room_owner_transfers(to_actor_id, status, expires_at);
CREATE INDEX idx_room_owner_transfers_room
  ON room_owner_transfers(room_id, created_at DESC, transfer_id DESC);

-- 并发接受/取消/拒绝同一提议时按事务提交序裁决；后到者整批回滚并映射为 CONFLICT。
DROP TABLE IF EXISTS guard_owner_transfer_stale;
CREATE TABLE guard_owner_transfer_stale (
  x INTEGER NOT NULL,
  CONSTRAINT guard_owner_transfer_stale CHECK (x = 0)
);

-- 扩展管理审计动作。SQLite 不能修改 CHECK，因此做一次正式表重建并保留全部旧行；
-- 旧 `owner_transferred` 仍保留，用于读取 G03 已写入的历史审计。
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
    'announcement_updated'
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

CREATE INDEX idx_room_management_audit_room
  ON room_management_audit(room_id, created_at DESC, audit_id DESC);
CREATE INDEX idx_room_management_audit_actor
  ON room_management_audit(target_actor_id, created_at DESC);
