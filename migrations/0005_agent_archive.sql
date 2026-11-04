-- Agent 软归档：只影响 Agent 管理列表，不参与认证、房间、消息、投递或在线状态。
-- archived_at 为毫秒时间戳，NULL 表示未归档；archived_by 记录首次归档者。
-- 归档可逆：取消归档把两列置回 NULL，不删除任何数据。
ALTER TABLE actors ADD COLUMN archived_at INTEGER;
ALTER TABLE actors ADD COLUMN archived_by TEXT;
