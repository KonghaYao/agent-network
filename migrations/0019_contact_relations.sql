-- A03 好友申请与双向联系人关系。
--
-- `contacts` 保持原有语义：单侧“我存过这个人”的个人收藏/历史记录，
-- 迁移不回填、不据此推断对方同意。双向好友关系唯一来源是
-- `contact_relations`（规范化 actor 对 + active/ended）。
-- `contact_requests` 保留申请附言与完整状态机；同一 actor 对只允许一条
-- pending，双向同时申请由部分唯一索引收敛。
-- `contact_receive_policies` 只对显式设置过的 actor 建行；未设置时按
-- human=self_approval、有管理者的 agent=manager_approval、无管理者
-- agent=self_approval 解析。自动接受不是 kind=agent 的默认行为。

CREATE TABLE contact_relations (
  pair_key TEXT PRIMARY KEY,
  actor_a TEXT NOT NULL REFERENCES actors(actor_id),
  actor_b TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  source TEXT NOT NULL CHECK (source IN ('request', 'auto_manager')),
  request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by TEXT,
  CHECK (actor_a < actor_b)
);
CREATE INDEX idx_contact_relations_actor_a
  ON contact_relations(actor_a, status, updated_at DESC);
CREATE INDEX idx_contact_relations_actor_b
  ON contact_relations(actor_b, status, updated_at DESC);

CREATE TABLE contact_requests (
  contact_request_id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL,
  from_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  to_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')
  ),
  auto_accepted INTEGER NOT NULL DEFAULT 0 CHECK (auto_accepted IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT,
  CHECK (from_actor_id <> to_actor_id)
);
CREATE UNIQUE INDEX idx_contact_requests_pending_pair
  ON contact_requests(pair_key) WHERE status = 'pending';
CREATE INDEX idx_contact_requests_target
  ON contact_requests(to_actor_id, status, created_at DESC);
CREATE INDEX idx_contact_requests_source
  ON contact_requests(from_actor_id, status, created_at DESC);
CREATE INDEX idx_contact_requests_expiry
  ON contact_requests(status, expires_at);

CREATE TABLE contact_receive_policies (
  actor_id TEXT PRIMARY KEY REFERENCES actors(actor_id),
  policy TEXT NOT NULL CHECK (
    policy IN ('self_approval', 'manager_approval', 'auto_accept')
  ),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 好友申请状态在并发接受/拒绝时由事务条件闸门裁决。
DROP TABLE IF EXISTS guard_contact_request_stale;
CREATE TABLE guard_contact_request_stale (
  x INTEGER NOT NULL,
  CONSTRAINT guard_contact_request_stale CHECK (x = 0)
);
