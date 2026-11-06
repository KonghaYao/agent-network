-- 已领取投递的 3 分钟无状态更新提醒。
-- 只增加内部计时列与扫描索引；不改变 delivery 状态机，也不新建表。
ALTER TABLE deliveries ADD COLUMN last_reminded_at INTEGER;

-- 提醒扫描只读取 claimed 且 progress_at 已到期的行。
CREATE INDEX idx_deliveries_claimed_progress
  ON deliveries(progress_at, last_reminded_at)
  WHERE state = 'claimed';
