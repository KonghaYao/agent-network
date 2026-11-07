-- A05 删除拉黑与骚扰控制。
--
-- `contact_blocks` 与好友关系分开记录：拉黑结束后关系仍保持 ended，
-- 解封不会自动恢复好友，必须重新申请。`mute_mentions` 控制共同群里来自
-- 被拉黑者的定向 @ 通知是否静默；不改变群成员身份与普通群消息可见性。
--
-- `contact_reports` 只保存最小定位证据（房间/消息/发送者/类别/短备注），
-- 不复制正文、不对外发送，也不产生任何 delivery。

CREATE TABLE contact_blocks (
  block_id TEXT PRIMARY KEY,
  blocker_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  blocked_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  reason TEXT NOT NULL DEFAULT '',
  mute_mentions INTEGER NOT NULL DEFAULT 1 CHECK (mute_mentions IN (0, 1)),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT REFERENCES actors(actor_id),
  CHECK (blocker_actor_id <> blocked_actor_id)
);
CREATE UNIQUE INDEX idx_contact_blocks_active
  ON contact_blocks(blocker_actor_id, blocked_actor_id) WHERE released_at IS NULL;
CREATE INDEX idx_contact_blocks_blocker
  ON contact_blocks(blocker_actor_id, released_at, created_at DESC);
CREATE INDEX idx_contact_blocks_blocked
  ON contact_blocks(blocked_actor_id, released_at, created_at DESC);

CREATE TABLE contact_reports (
  report_id TEXT PRIMARY KEY,
  reporter_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  target_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  category TEXT NOT NULL CHECK (category IN ('harassment', 'spam', 'fraud', 'other')),
  note TEXT NOT NULL DEFAULT '',
  room_id TEXT,
  message_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (reporter_actor_id <> target_actor_id)
);
CREATE INDEX idx_contact_reports_reporter
  ON contact_reports(reporter_actor_id, created_at DESC, report_id DESC);
CREATE INDEX idx_contact_reports_target
  ON contact_reports(target_actor_id, created_at DESC);

-- 申请与 @ 的窗口限额在同一事务内裁决，避免预检查后的并发绕过。
-- 申请冷却需要按 actor 对读取最近一条已结束申请。
CREATE INDEX idx_contact_requests_actor_created
  ON contact_requests(from_actor_id, created_at DESC);
CREATE INDEX idx_contact_requests_pair_created
  ON contact_requests(pair_key, created_at DESC);

DROP TABLE IF EXISTS guard_rate_limited;
CREATE TABLE guard_rate_limited (
  x INTEGER NOT NULL,
  CONSTRAINT guard_rate_limited CHECK (x = 0)
);
