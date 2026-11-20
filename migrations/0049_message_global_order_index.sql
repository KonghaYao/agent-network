-- 全局消息搜索的排序索引（跨会话 exact/fuzzy）。
--
-- 全局搜索固定按 created_at DESC, message_id DESC 排序。没有该索引时
-- SQLite 只能借房间索引取数后 `USE TEMP B-TREE FOR ORDER BY`；40 万条消息下
-- fuzzy 每页 16 批都会重复全量排序。该索引只加速读路径，不改变排序语义、
-- 授权 CTE 或房间模式使用的 idx_messages_room_seq。
--
-- 快照上界仍由查询层限制 created_at/message_id；insertion watermark(rowid)
-- 不进入索引。

CREATE INDEX idx_messages_global_order
  ON messages(created_at DESC, message_id DESC);
