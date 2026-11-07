-- G03 owner 退群条件闸门。
--
-- owner 退群必须在同一事务内复核“是否仍有其他 active 成员”。预检查只能
-- 提供可读错误，不能裁决并发：并发的 add 可能在本事务提交前加入成员。
-- 命中时整批回滚，映射为 CONFLICT（群 owner 离开前必须转移 owner）。

DROP TABLE IF EXISTS guard_owner_transfer_required;
CREATE TABLE guard_owner_transfer_required (
  x INTEGER NOT NULL,
  CONSTRAINT guard_owner_transfer_required CHECK (x = 0)
);
