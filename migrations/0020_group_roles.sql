-- G03 群角色、群策略、公告与角色审计。
--
-- 权威模型：
-- - `room_members.role` 是群内唯一角色来源：owner/admin/member。
-- - 每个房间至多一个 active owner（部分唯一索引），`rooms.owner_id` 与
--   owner 成员行在同一事务内更新。
-- - `room_members.role_revision` 只随该成员的角色/状态变化递增；角色任免
--   必须携带读取时的 expected revision，过期写入返回 VERSION_CONFLICT。
-- - `rooms.policy_revision` / `announcement_revision` 独立乐观锁。
-- - `room_management_audit` 是追加写的管理审计；普通事件只作通知提示。
--
-- 群角色不写入 `agent_managements`，也不改变任何 Agent 管理归属。

-- 1) room_members 增加 admin 角色、role_revision 与 updated_at。
-- SQLite 不能修改 CHECK，因此做一次正式表重建并保留全部旧行。
ALTER TABLE room_members RENAME TO room_members_old;

CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'left', 'removed')),
  joined_seq INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  role_revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, actor_id)
);

INSERT INTO room_members
  (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
SELECT room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, 1, joined_at
  FROM room_members_old;

DROP TABLE room_members_old;

CREATE INDEX idx_room_members_actor ON room_members(actor_id, status, room_id);
CREATE INDEX idx_room_members_room_role ON room_members(room_id, role, status);
-- 唯一群主：只约束 active owner；direct 房间没有 owner 行。
CREATE UNIQUE INDEX idx_room_members_one_owner
  ON room_members(room_id) WHERE role = 'owner' AND status = 'active';

-- 2) 房间策略、公告与版本。
ALTER TABLE rooms ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD COLUMN member_message_policy TEXT NOT NULL DEFAULT 'members'
  CHECK (member_message_policy IN ('members', 'owner_admin'));
ALTER TABLE rooms ADD COLUMN member_invite_policy TEXT NOT NULL DEFAULT 'owner_admin'
  CHECK (member_invite_policy IN ('members', 'owner_admin'));
ALTER TABLE rooms ADD COLUMN member_task_policy TEXT NOT NULL DEFAULT 'members'
  CHECK (member_task_policy IN ('members', 'owner_admin'));
ALTER TABLE rooms ADD COLUMN announcement TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN announcement_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD COLUMN announcement_updated_at INTEGER;
ALTER TABLE rooms ADD COLUMN announcement_updated_by TEXT;

-- 3) 追加写审计。角色/状态变更、策略和公告修改都记录到同一张管理审计表。
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
CREATE INDEX idx_room_management_audit_room
  ON room_management_audit(room_id, created_at DESC, audit_id DESC);
CREATE INDEX idx_room_management_audit_actor
  ON room_management_audit(target_actor_id, created_at DESC);

-- 4) 角色/策略/公告版本条件闸门：expected revision 不匹配时整批回滚。
DROP TABLE IF EXISTS guard_role_revision;
CREATE TABLE guard_role_revision (x INTEGER NOT NULL, CONSTRAINT guard_role_revision CHECK (x = 0));

DROP TABLE IF EXISTS guard_policy_revision;
CREATE TABLE guard_policy_revision (x INTEGER NOT NULL, CONSTRAINT guard_policy_revision CHECK (x = 0));

DROP TABLE IF EXISTS guard_announcement_revision;
CREATE TABLE guard_announcement_revision (x INTEGER NOT NULL, CONSTRAINT guard_announcement_revision CHECK (x = 0));
