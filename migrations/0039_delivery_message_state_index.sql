-- 历史页 delivery 状态聚合的覆盖索引。
--
-- 历史与时间线每页都会按 message_id IN (...) GROUP BY message_id, state
-- 聚合 deliveries，并读取 claimed 的 claimed_at/updated_at。原有
-- idx_deliveries_message(message_id) 只能定位行，分组与时间列仍要回表。
--
-- 该索引让 WHERE message_id IN (...) 的范围扫描按 (message_id, state) 有序，
-- 并且 claimed_at/updated_at 可直接从索引取得，避免临时分组表与回表。
-- 不改变任何写入路径、状态机或唯一约束。

CREATE INDEX idx_deliveries_message_state
  ON deliveries(message_id, state, claimed_at, updated_at);
