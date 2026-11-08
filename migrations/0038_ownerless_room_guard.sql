-- G06 遗留无主群防御闸门。
--
-- 历史缺陷允许群 owner 在独自一人时退群并清空 `rooms.owner_id`，留下
-- `owner_id IS NULL AND dissolved_at IS NULL` 的活跃群。该状态不再由任何
-- 合法路径产生，但旧库可能已经存在。这里只增加事务闸门，不自动解散、
-- 不回填 owner，也不删除任何业务行。
--
-- 所有“再加人”的写入（定向邀请、邀请链接、入群申请批准、管理员添加）
-- 在事务内复核该条件；命中时整批回滚，映射为 CONFLICT（owner_missing）。

DROP TABLE IF EXISTS guard_owner_missing;
CREATE TABLE guard_owner_missing (
  x INTEGER NOT NULL,
  CONSTRAINT guard_owner_missing CHECK (x = 0)
);
