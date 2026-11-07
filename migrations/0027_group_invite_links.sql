-- G02 群邀请链接、二维码与入群审批。
--
-- 权威模型：
-- - `room_invitations` 仍是邀请的唯一权威来源。G01 只写 `kind = 'direct'`；
--   G02 增加 `kind = 'link'`：`target_actor_id` 为空、`token_hash` 保存
--   URL 中一次性出示的邀请 key 的 SHA-256 摘要、`max_uses` 默认 20。
-- - 链接邀请的 `used_count` 只统计“成功成为 active 成员”的次数；打开预览、
--   提交待审批申请都不消耗次数。达到 `max_uses` 后在同一事务置 exhausted。
-- - `room_join_requests` 是审批队列。申请 pending 不是成员；owner/admin
--   批准时在同一事务内重新检查邀请状态、有效期、次数、拉黑与 100 人容量，
--   消费一次邀请并写入 active 成员、审计与通知。
-- - 被移除者不能复用旧链接：链接加入路径对 `room_members.status = 'removed'`
--   返回 CONFLICT；重新加入必须由 owner/admin 新建定向邀请。
-- - 撤销、过期、用尽都是持久/派生状态；旧二维码只是同一个 URL，失效后
--   任何设备都会得到相同结果。

CREATE TABLE room_join_requests (
  join_request_id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES room_invitations(invitation_id),
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  applicant_id TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')
  ),
  -- 申请附言；只进入审批入口，不复制消息正文或凭据。当前 G02 不开放自定义。
  message TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT REFERENCES actors(actor_id)
);

-- 同一邀请对同一申请人至多一条 pending；重复打开链接收敛到同一条申请。
CREATE UNIQUE INDEX idx_room_join_requests_pending
  ON room_join_requests(invitation_id, applicant_id) WHERE status = 'pending';
CREATE INDEX idx_room_join_requests_room
  ON room_join_requests(room_id, status, created_at DESC, join_request_id DESC);
CREATE INDEX idx_room_join_requests_applicant
  ON room_join_requests(applicant_id, status, created_at DESC);

-- 并发批准/拒绝同一申请时按事务提交序裁决；后到者整批回滚并映射为 CONFLICT。
DROP TABLE IF EXISTS guard_join_request_stale;
CREATE TABLE guard_join_request_stale (
  x INTEGER NOT NULL,
  CONSTRAINT guard_join_request_stale CHECK (x = 0)
);

-- 同一群同时有效的链接邀请上限；命中映射 QUOTA_EXCEEDED。
DROP TABLE IF EXISTS guard_room_invite_limit;
CREATE TABLE guard_room_invite_limit (
  x INTEGER NOT NULL,
  CONSTRAINT guard_room_invite_limit CHECK (x = 0)
);

-- 扩展管理审计动作。SQLite 不能修改 CHECK，因此做一次正式表重建并保留全部旧行。
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
    'join_rejected'
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

-- 表重建会随旧表一起删除索引；重新建立与 0024 相同的审计索引。
CREATE INDEX idx_room_management_audit_room
  ON room_management_audit(room_id, created_at DESC, audit_id DESC);
CREATE INDEX idx_room_management_audit_actor
  ON room_management_audit(target_actor_id, created_at DESC);
