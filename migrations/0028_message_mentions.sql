-- M03 结构化提及与确定性唤醒。
--
-- 权威模型：
-- - `messages` 仍是消息本体的唯一权威；`message_mentions` 只记录“谁被提及”
--   与来源（explicit 显式选择 / text 正文唯一精确匹配 / all @所有人）。
-- - `invoke` 才是 Agent 执行目标；human 提及只写个人提醒事件，不创建 delivery。
-- - 每个 (message_id, actor_id) 至多一行；显式选择优先于正文解析，正文解析
--   优先于 @所有人，保证同一输入在 Web / MCP / CLI 得到同一份提及集合。
-- - 提醒事件使用 inbox scope 的 `mention_reminder`，`pending_count` 不增加，
--   因此 @所有人 与 human 提醒都不会被误当成新的 Agent 工作。

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  source TEXT NOT NULL CHECK (source IN ('explicit', 'text', 'all')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, actor_id)
);

-- 按 actor 补读个人提醒时使用；消息读取本身按 message_id 走主键。
CREATE INDEX idx_message_mentions_actor
  ON message_mentions(actor_id, created_at DESC, message_id);

-- 显式 mentions 必须指向当前房间的有效人类成员；在发送事务内复核，
-- 避免选择器持有成员列表后成员被移除或改名造成悬空提醒。
DROP TABLE IF EXISTS guard_invalid_mention;
CREATE TABLE guard_invalid_mention (
  x INTEGER NOT NULL,
  CONSTRAINT guard_invalid_mention CHECK (x = 0)
);
