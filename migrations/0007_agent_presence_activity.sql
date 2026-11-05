-- 在线判定从“仅 SSE 连接”扩展为“SSE 连接或最近活动”。
-- last_seen_at 记录已认证 Agent 最近一次 MCP 请求的毫秒时间；它只是观测元数据，
-- 不参与消息、未读、inbox 或房间 head。
--
-- 回填策略：只给仍处于 online 的行写入 online_at。该时间来自最近一次已确认
-- 上线（login/连接），是真实观测值，不是伪造心跳；pending/offline 行保持 NULL，
-- 它们没有可信的活动时间，下一次请求或重连时再写入。

ALTER TABLE agent_presence_state ADD COLUMN last_seen_at INTEGER;

UPDATE agent_presence_state
   SET last_seen_at = online_at
 WHERE phase = 'online' AND online_at IS NOT NULL;

-- sweep 兜底扫描：online 且活动窗口已过期的行。
CREATE INDEX idx_agent_presence_activity
  ON agent_presence_state(phase, last_seen_at);
