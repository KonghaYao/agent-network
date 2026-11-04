-- MCP Events：webhook 订阅、事件投递 outbox 与 callback 验证缓存。
-- secret 只保存 AES-256-GCM 密文与 12 字节 nonce；payload_json 是精确发送字节。

CREATE TABLE mcp_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  event_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  callback_url_key TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(credential_id),
  secret_ciphertext TEXT NOT NULL,
  secret_nonce TEXT NOT NULL,
  previous_secret_ciphertext TEXT,
  previous_secret_nonce TEXT,
  previous_secret_expires_at INTEGER,
  refresh_before INTEGER NOT NULL,
  scanned_seq INTEGER NOT NULL DEFAULT 0,
  last_scan_at INTEGER NOT NULL DEFAULT 0,
  last_delivery_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (actor_id, callback_url_key, event_name, arguments_json)
);
CREATE INDEX idx_mcp_event_subs_scan
  ON mcp_event_subscriptions(active, refresh_before, last_scan_at, subscription_id);
CREATE INDEX idx_mcp_event_subs_actor
  ON mcp_event_subscriptions(actor_id, active);

CREATE TABLE mcp_event_deliveries (
  delivery_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL
    REFERENCES mcp_event_subscriptions(subscription_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_http_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE (subscription_id, event_seq)
);
CREATE INDEX idx_mcp_event_deliveries_due
  ON mcp_event_deliveries(status, next_attempt_at);
CREATE INDEX idx_mcp_event_deliveries_sub
  ON mcp_event_deliveries(subscription_id, event_seq);
CREATE INDEX idx_mcp_event_deliveries_cleanup
  ON mcp_event_deliveries(status, created_at);

CREATE TABLE webhook_verifications (
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  callback_url_key TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, callback_url_key)
);
CREATE INDEX idx_webhook_verifications_expires ON webhook_verifications(expires_at);

-- 条件闸门：只接受 x=0，命中时整批回滚，命名约束用于错误分类。
CREATE TABLE guard_event_subscription_limit (
  x INTEGER NOT NULL,
  CONSTRAINT guard_event_subscription_limit CHECK (x = 0)
);
CREATE TABLE guard_event_subscription_global (
  x INTEGER NOT NULL,
  CONSTRAINT guard_event_subscription_global CHECK (x = 0)
);
