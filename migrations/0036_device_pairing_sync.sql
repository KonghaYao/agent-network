-- Q02 安全设备配对与设备活动。
--
-- 目的：把二维码/短码限制为 5 分钟一次性配对挑战；新设备用自己生成的
-- token 证明，已登录设备显式批准后才创建同 actor 的独立 credential。
-- 权威状态仍是 SQLite：`device_pairings` 是挑战状态机，`devices` 是设备
-- 状态与最近活动，`credentials` 是实际认证凭据。挑战与 token 都只保存
-- SHA-256 摘要；挑战明文只在 create 首次响应出现一次。
--
-- 旧数据映射：已有 credentials 没有 devices 行时按 (actor_id, device_id)
-- 回填一条设备；只要该设备仍有未撤销凭据就保持 active，否则保持 revoked。
-- 不回填挑战，不把旧长期 token 二维码解释成已批准的配对。

ALTER TABLE device_pairings ADD COLUMN created_by_credential_id TEXT;
ALTER TABLE device_pairings ADD COLUMN device_id TEXT;
ALTER TABLE device_pairings ADD COLUMN device_label TEXT NOT NULL DEFAULT '';
ALTER TABLE device_pairings ADD COLUMN platform TEXT NOT NULL DEFAULT '';
ALTER TABLE device_pairings ADD COLUMN device_token_hash TEXT;
ALTER TABLE device_pairings ADD COLUMN cancelled_at INTEGER;
ALTER TABLE device_pairings ADD COLUMN cancelled_by TEXT;
ALTER TABLE device_pairings ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_device_pairings_actor_status
  ON device_pairings(actor_id, status, created_at DESC);
CREATE INDEX idx_device_pairings_device_token
  ON device_pairings(device_token_hash) WHERE device_token_hash IS NOT NULL;

-- 并发撤销/批准与设备行状态变化时由条件闸门裁决；命中即整批回滚。
DROP TABLE IF EXISTS guard_device_stale;
CREATE TABLE guard_device_stale (
  x INTEGER NOT NULL,
  CONSTRAINT guard_device_stale CHECK (x = 0)
);

INSERT INTO devices (actor_id, device_id, label, platform, status, created_at, last_seen_at)
SELECT
  c.actor_id,
  c.device_id,
  COALESCE(MAX(c.label), ''),
  'legacy',
  CASE WHEN MAX(CASE WHEN c.revoked_at IS NULL THEN 1 ELSE 0 END) = 1 THEN 'active' ELSE 'revoked' END,
  MIN(c.created_at),
  MAX(c.last_used_at)
FROM credentials c
WHERE NOT EXISTS (
  SELECT 1 FROM devices d
   WHERE d.actor_id = c.actor_id AND d.device_id = c.device_id
)
GROUP BY c.actor_id, c.device_id;
