-- 好友邀请链接：一次性、24 小时有效、可撤销，只保存 token 的 SHA-256 摘要。
--
-- 兑换直接建立双向 active `contact_relations`（source = invite_link），
-- 不创建 pending 好友申请、不要求对方审批。链接状态是独立状态机：
-- pending → used / revoked / expired；兑换和撤销都在同一事务内用条件
-- 闸门裁决，避免并发重复兑换或“撤销后仍被使用”。
--
-- `contact_relations.source` 原有 CHECK 只允许 request / auto_manager，
-- SQLite 不能直接修改 CHECK，因此按标准步骤重建该表并复制全部行；
-- 不新增列、不改已有行的语义。`contact_relations` 没有被其他表引用。

CREATE TABLE contact_relations_invite_link (
  pair_key TEXT PRIMARY KEY,
  actor_a TEXT NOT NULL REFERENCES actors(actor_id),
  actor_b TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  source TEXT NOT NULL CHECK (source IN ('request', 'auto_manager', 'invite_link')),
  request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT,
  CHECK (actor_a < actor_b)
);

INSERT INTO contact_relations_invite_link
  (pair_key, actor_a, actor_b, status, source, request_id,
   created_at, updated_at, ended_at, ended_by)
SELECT
  pair_key, actor_a, actor_b, status, source, request_id,
  created_at, updated_at, ended_at, ended_by
FROM contact_relations;

DROP TABLE contact_relations;
ALTER TABLE contact_relations_invite_link RENAME TO contact_relations;

CREATE INDEX idx_contact_relations_actor_a
  ON contact_relations(actor_a, status, updated_at DESC);
CREATE INDEX idx_contact_relations_actor_b
  ON contact_relations(actor_b, status, updated_at DESC);

CREATE TABLE contact_invite_links (
  link_id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'used', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL,
  used_by TEXT REFERENCES actors(actor_id),
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES actors(actor_id),
  CHECK (owner_actor_id <> used_by)
);

CREATE INDEX idx_contact_invite_links_owner
  ON contact_invite_links(owner_actor_id, status, created_at DESC);
CREATE INDEX idx_contact_invite_links_status
  ON contact_invite_links(status, expires_at);

-- 兑换条件闸门：链接必须仍 pending 且未过期。命中即整批回滚。
DROP TABLE IF EXISTS guard_contact_link_invalid;
CREATE TABLE guard_contact_link_invalid (
  x INTEGER NOT NULL,
  CONSTRAINT guard_contact_link_invalid CHECK (x = 0)
);

-- 同一 actor 的 pending 链接上限；过期行先由调用方标记为 expired。
DROP TABLE IF EXISTS guard_contact_link_limit;
CREATE TABLE guard_contact_link_limit (
  x INTEGER NOT NULL,
  CONSTRAINT guard_contact_link_limit CHECK (x = 0)
);
