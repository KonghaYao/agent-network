-- 群历史默认 full：新建群由 roomCreate 显式写入 full，本迁移把存量群回填为 full。
--
-- - 只处理 group；direct 不设加入边界，策略列与 policy_revision 保持原值。
-- - 不修改 updated_at，避免维护性迁移打乱 roomsList 的“最后活跃”排序。
-- - 不写 events/outbox/audit：这是默认读取范围变更，不产生用户可见的群内事件。
-- - policy_revision 递增，让客户端缓存的旧授权快照与旧票据立即失效。

UPDATE rooms
   SET member_history_policy = 'full',
       policy_revision = policy_revision + 1
 WHERE kind = 'group'
   AND member_history_policy <> 'full';
