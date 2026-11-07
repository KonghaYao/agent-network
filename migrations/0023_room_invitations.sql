-- G01 建群邀请（最小 direct 邀请对象）。
--
-- 邀请不是成员：`room_invitations` 独立于 `room_members`，pending 不计入
-- active 成员数，也不占 100 人容量。接受时在同一事务内重新检查群状态、
-- 目标资格与容量，成功才写入 active 成员行。
--
-- 本迁移只落地 G01 所需的定向邀请；G02 在同一对象上扩展开放链接、
-- 二维码、审批与撤销，不另建同义表。`token_hash` 与 `max_uses` 预留给
-- link 邀请，G01 的 direct 邀请不使用 token。
--
-- 管理审计不复制邀请明细；邀请状态变化写 events/outbox 提示。

CREATE TABLE room_invitations (
  invitation_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  inviter_id TEXT NOT NULL REFERENCES actors(actor_id),
  target_actor_id TEXT REFERENCES actors(actor_id),
  token_hash TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'link')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'accepted', 'rejected', 'revoked', 'expired', 'exhausted')
  ),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'direct' AND target_actor_id IS NOT NULL)
    OR (kind = 'link' AND target_actor_id IS NULL)
  )
);

-- 同一群对同一目标至多一条 pending 定向邀请；重复建群/重试不再叠加。
CREATE UNIQUE INDEX idx_room_invitations_pending_direct
  ON room_invitations(room_id, target_actor_id)
  WHERE status = 'pending' AND kind = 'direct';
CREATE INDEX idx_room_invitations_target
  ON room_invitations(target_actor_id, status, expires_at);
CREATE INDEX idx_room_invitations_room
  ON room_invitations(room_id, status, expires_at);
CREATE INDEX idx_room_invitations_token
  ON room_invitations(token_hash) WHERE token_hash IS NOT NULL;

-- 并发接受同一邀请时按事务提交序裁决；后到者整批回滚并映射为 CONFLICT。
DROP TABLE IF EXISTS guard_invitation_stale;
CREATE TABLE guard_invitation_stale (
  x INTEGER NOT NULL,
  CONSTRAINT guard_invitation_stale CHECK (x = 0)
);

-- 建群时所有预检合格的候选都可能因竞态失效；没有成员也没有邀请时
-- 整批回滚，避免留下只有创建者的群。
DROP TABLE IF EXISTS guard_invite_targets_missing;
CREATE TABLE guard_invite_targets_missing (
  x INTEGER NOT NULL,
  CONSTRAINT guard_invite_targets_missing CHECK (x = 0)
);
