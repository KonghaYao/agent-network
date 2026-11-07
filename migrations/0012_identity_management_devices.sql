-- A01 身份管理权威存储。
--
-- agent_managements 是 Agent 管理权的唯一来源；agent_claims 记录一次性
-- 双端认领；agent_delegations 记录可撤销的有限委托。devices/device_pairings
-- 与 transfer 表由 Q02/A06 使用，本期先建立最终结构，避免后续重建表。
-- actors.disabled_at 与 archived_at 正交：归档只影响管理视图，停用影响授权。

CREATE TABLE agent_managements (
  binding_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES actors(actor_id),
  manager_id TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  grant_source TEXT NOT NULL CHECK (grant_source IN ('created', 'claim', 'transfer', 'legacy')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  permission_version INTEGER NOT NULL DEFAULT 1 CHECK (permission_version >= 1),
  initiated_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_managements_active
  ON agent_managements(agent_id) WHERE status = 'active';
CREATE INDEX idx_agent_managements_manager
  ON agent_managements(manager_id, status, updated_at DESC);
CREATE INDEX idx_agent_managements_agent
  ON agent_managements(agent_id, status);

CREATE TABLE agent_claims (
  claim_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES actors(actor_id),
  claim_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_claims_pending
  ON agent_claims(agent_id) WHERE status = 'pending';
CREATE INDEX idx_agent_claims_status ON agent_claims(status, expires_at);

CREATE TABLE agent_delegations (
  delegation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES actors(actor_id),
  delegate_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  permission_version INTEGER NOT NULL DEFAULT 1 CHECK (permission_version >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_delegations_active
  ON agent_delegations(agent_id, delegate_actor_id) WHERE status = 'active';
CREATE INDEX idx_agent_delegations_delegate
  ON agent_delegations(delegate_actor_id, status);

CREATE TABLE agent_management_transfers (
  transfer_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES actors(actor_id),
  from_manager_id TEXT NOT NULL REFERENCES actors(actor_id),
  to_manager_id TEXT NOT NULL REFERENCES actors(actor_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  from_permission_version INTEGER NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_transfers_pending
  ON agent_management_transfers(agent_id) WHERE status = 'pending';

CREATE TABLE devices (
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  device_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  PRIMARY KEY (actor_id, device_id)
);
CREATE INDEX idx_devices_actor_status ON devices(actor_id, status, last_seen_at);

CREATE TABLE device_pairings (
  pairing_id TEXT PRIMARY KEY,
  challenge_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'redeemed', 'expired', 'cancelled')),
  actor_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by_actor_id TEXT,
  approved_by_credential_id TEXT,
  approved_at INTEGER,
  redeemed_credential_id TEXT,
  redeemed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_device_pairings_status ON device_pairings(status, expires_at);

ALTER TABLE actors ADD COLUMN disabled_at INTEGER;
ALTER TABLE actors ADD COLUMN disabled_by TEXT;
ALTER TABLE actors ADD COLUMN disabled_reason TEXT;

ALTER TABLE credentials ADD COLUMN last_used_at INTEGER;
ALTER TABLE credentials ADD COLUMN revoked_by TEXT;
ALTER TABLE credentials ADD COLUMN label TEXT;
CREATE INDEX idx_credentials_device ON credentials(actor_id, device_id, revoked_at);
